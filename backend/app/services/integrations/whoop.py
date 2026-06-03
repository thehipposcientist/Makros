"""WHOOP provider."""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from app.services.integrations.base import (
    SyncResult,
    TokenSet,
    WearableProvider,
)
from app.services.integrations.sync_helpers import (
    ensure_provider_access_token,
    float_or_none,
    int_or_none,
    ms_to_hours,
    ms_to_minutes,
    parse_datetime,
    token_expires_at,
    upsert_daily_health_snapshot,
    upsert_sleep_log,
    upsert_workout_completion,
    utcnow,
)


_WHOOP_AUTHORIZE_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
_WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
_WHOOP_API_BASE = "https://api.prod.whoop.com/developer"
_WHOOP_DEFAULT_SCOPE = (
    "offline read:recovery read:cycles read:workout "
    "read:sleep read:profile read:body_measurement"
)


def _env() -> tuple[str, str, str]:
    return (
        os.getenv("WHOOP_CLIENT_ID", ""),
        os.getenv("WHOOP_CLIENT_SECRET", ""),
        os.getenv("WHOOP_REDIRECT_URI", ""),
    )


def _score_rating(score: int | None) -> str | None:
    if score is None:
        return None
    if score >= 85:
        return "Excellent"
    if score >= 70:
        return "Good"
    if score >= 55:
        return "Fair"
    return "Poor"


def _request_token(data: dict[str, str]) -> dict[str, Any]:
    client_id, client_secret, _ = _env()
    data = {
        **data,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    resp = httpx.post(
        _WHOOP_TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=20.0,
    )
    resp.raise_for_status()
    return resp.json()


def _records(payload: Any) -> list[dict]:
    if isinstance(payload, dict) and isinstance(payload.get("records"), list):
        return [r for r in payload["records"] if isinstance(r, dict)]
    return []


def _next_token(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    token = payload.get("next_token") or payload.get("nextToken")
    return str(token) if token else None


def _zone_minutes(zone_durations: dict | None) -> list[float] | None:
    if not isinstance(zone_durations, dict):
        return None
    return [
        (ms_to_minutes(zone_durations.get("zone_one_milli")) or 0),
        (ms_to_minutes(zone_durations.get("zone_two_milli")) or 0),
        (ms_to_minutes(zone_durations.get("zone_three_milli")) or 0),
        (ms_to_minutes(zone_durations.get("zone_four_milli")) or 0),
        (ms_to_minutes(zone_durations.get("zone_five_milli")) or 0),
    ]


class WhoopProvider(WearableProvider):
    slug = "whoop"
    display_name = "WHOOP"
    capabilities = ("sleep", "readiness", "strain", "heart_rate", "activities")

    @property
    def is_configured(self) -> bool:
        client_id, client_secret, redirect_uri = _env()
        return bool(client_id and client_secret and redirect_uri)

    def authorize_url(self, state: str) -> str:
        client_id, _, redirect_uri = _env()
        scope = os.getenv("WHOOP_SCOPES", _WHOOP_DEFAULT_SCOPE)
        return f"{_WHOOP_AUTHORIZE_URL}?" + urlencode({
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope,
            "state": state,
        })

    def exchange_code(self, code: str) -> TokenSet:
        _, _, redirect_uri = _env()
        raw = _request_token({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        })
        return TokenSet(
            access_token=raw.get("access_token") or "",
            refresh_token=raw.get("refresh_token"),
            expires_at=token_expires_at(raw.get("expires_in")),
            extras={"scope": raw.get("scope"), "token_type": raw.get("token_type")},
        )

    def refresh(self, refresh_token: str) -> TokenSet:
        raw = _request_token({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": "offline",
        })
        return TokenSet(
            access_token=raw.get("access_token") or "",
            refresh_token=raw.get("refresh_token") or refresh_token,
            expires_at=token_expires_at(raw.get("expires_in")),
            extras={"scope": raw.get("scope"), "token_type": raw.get("token_type")},
        )

    def _get_collection(
        self,
        access_token: str,
        endpoint: str,
        *,
        start: str,
        end: str,
    ) -> list[dict]:
        params: dict[str, Any] = {"limit": 25, "start": start, "end": end}
        out: list[dict] = []
        for _ in range(100):
            resp = httpx.get(
                f"{_WHOOP_API_BASE}{endpoint}",
                headers={"Authorization": f"Bearer {access_token}"},
                params=params,
                timeout=25.0,
            )
            resp.raise_for_status()
            payload = resp.json()
            out.extend(_records(payload))
            token = _next_token(payload)
            if not token:
                break
            params["nextToken"] = token
        return out

    def _get_single(self, access_token: str, endpoint: str) -> dict | None:
        resp = httpx.get(
            f"{_WHOOP_API_BASE}{endpoint}",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=20.0,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        payload = resp.json()
        return payload if isinstance(payload, dict) else None

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        result = SyncResult()
        access_token = ensure_provider_access_token(db, credential, self)
        start = since.astimezone().isoformat()
        end = utcnow().isoformat()
        errors: list[str] = []

        def fetch(endpoint: str) -> list[dict]:
            try:
                return self._get_collection(access_token, endpoint, start=start, end=end)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else "unknown"
                if status in {403, 404}:
                    errors.append(f"WHOOP {endpoint}: unavailable ({status})")
                    return []
                raise

        profile = None
        try:
            profile = self._get_single(access_token, "/v2/user/profile/basic")
        except httpx.HTTPStatusError:
            profile = None
        if profile and profile.get("user_id"):
            credential.external_user_id = str(profile.get("user_id"))
            credential.extras = {**(credential.extras or {}), "profile_email": profile.get("email")}

        for row in fetch("/v2/recovery"):
            score = row.get("score") if isinstance(row.get("score"), dict) else {}
            cycle_id = row.get("cycle_id")
            sleep_id = row.get("sleep_id")
            day_source = parse_datetime(row.get("created_at") or row.get("updated_at"))
            if sleep_id:
                sleep = self._get_single(access_token, f"/v2/activity/sleep/{sleep_id}")
                if sleep:
                    day_source = parse_datetime(sleep.get("end")) or day_source
            day = day_source.date() if day_source else None
            if day is None:
                continue
            recovery_score = int_or_none(score.get("recovery_score"))
            if upsert_daily_health_snapshot(
                db,
                user_id,
                day,
                "whoop",
                {
                    "readiness_score": recovery_score,
                    "resting_hr": float_or_none(score.get("resting_heart_rate")),
                    "hrv_ms": float_or_none(score.get("hrv_rmssd_milli")),
                    "oxygen_saturation": float_or_none(score.get("spo2_percentage")),
                    "wrist_temperature_c": float_or_none(score.get("skin_temp_celsius")),
                },
                source_extra={
                    "whoop_recovery": {
                        "cycle_id": cycle_id,
                        "sleep_id": sleep_id,
                        "score_state": row.get("score_state"),
                        "recovery_score": recovery_score,
                    },
                },
            ):
                result.health_snapshots_imported += 1

        for row in fetch("/v2/activity/sleep"):
            if row.get("nap") is True:
                continue
            end_dt = parse_datetime(row.get("end"))
            day = end_dt.date() if end_dt else None
            if day is None:
                continue
            score = row.get("score") if isinstance(row.get("score"), dict) else {}
            stages = score.get("stage_summary") if isinstance(score.get("stage_summary"), dict) else {}
            sleep_score = int_or_none(score.get("sleep_performance_percentage"))
            total_in_bed_min = ms_to_minutes(stages.get("total_in_bed_time_milli"))
            awake_min = ms_to_minutes(stages.get("total_awake_time_milli"))
            deep_hours = ms_to_hours(stages.get("total_slow_wave_sleep_time_milli"))
            rem_hours = ms_to_hours(stages.get("total_rem_sleep_time_milli"))
            core_hours = ms_to_hours(stages.get("total_light_sleep_time_milli"))
            total_sleep_hours = None
            component_hours = [v for v in (deep_hours, rem_hours, core_hours) if v is not None]
            if component_hours:
                total_sleep_hours = sum(component_hours)
            elif total_in_bed_min is not None:
                total_sleep_hours = max(0, total_in_bed_min - (awake_min or 0)) / 60.0
            if upsert_sleep_log(
                db,
                user_id,
                day,
                "whoop",
                {
                    "total_hours": total_sleep_hours,
                    "in_bed_minutes": total_in_bed_min,
                    "deep_hours": deep_hours,
                    "rem_hours": rem_hours,
                    "core_hours": core_hours,
                    "awake_minutes": awake_min,
                    "respiratory_rate": float_or_none(score.get("respiratory_rate")),
                    "score": sleep_score,
                    "rating": _score_rating(sleep_score),
                    "mode": "provider",
                    "source": "whoop",
                },
            ):
                result.sleep_logs_imported += 1

        for row in fetch("/v2/cycle"):
            end_dt = parse_datetime(row.get("end"))
            day = end_dt.date() if end_dt else None
            score = row.get("score") if isinstance(row.get("score"), dict) else {}
            if day is None:
                continue
            if upsert_daily_health_snapshot(
                db,
                user_id,
                day,
                "whoop",
                {
                    "active_energy_kcal": (
                        float_or_none(score.get("kilojoule")) / 4.184
                        if float_or_none(score.get("kilojoule")) is not None
                        else None
                    ),
                },
                source_extra={
                    "whoop_cycle": {
                        "cycle_id": row.get("id"),
                        "strain": score.get("strain"),
                        "average_heart_rate": score.get("average_heart_rate"),
                        "max_heart_rate": score.get("max_heart_rate"),
                    },
                },
            ):
                result.health_snapshots_imported += 1

        for row in fetch("/v2/activity/workout"):
            external_id = str(row.get("id") or "").strip()
            if not external_id:
                continue
            started_at = parse_datetime(row.get("start"))
            ended_at = parse_datetime(row.get("end"))
            day = (started_at or ended_at).date() if (started_at or ended_at) else None
            if day is None:
                continue
            score = row.get("score") if isinstance(row.get("score"), dict) else {}
            zone_minutes = _zone_minutes(score.get("zone_durations"))
            hr_summary = None
            if score.get("average_heart_rate") or score.get("max_heart_rate") or zone_minutes:
                hr_summary = {
                    "avgBpm": score.get("average_heart_rate"),
                    "maxBpm": score.get("max_heart_rate"),
                    "zoneMinutes": zone_minutes,
                }
            distance_miles = None
            distance_meters = float_or_none(score.get("distance_meter"))
            if distance_meters is not None:
                distance_miles = distance_meters / 1609.344
            calories = None
            kilojoule = float_or_none(score.get("kilojoule"))
            if kilojoule is not None:
                calories = int(round(kilojoule / 4.184))
            duration_seconds = (
                int((ended_at - started_at).total_seconds())
                if started_at and ended_at
                else 0
            )
            created = upsert_workout_completion(
                db,
                user_id,
                "whoop",
                external_id,
                workout_date=day,
                focus_label=str(row.get("sport_name") or "WHOOP Workout").title(),
                started_at=started_at,
                ended_at=ended_at,
                duration_seconds=duration_seconds,
                activity_subtype=str(row.get("sport_name") or "").lower() or None,
                distance_miles=distance_miles,
                calories_burned=calories,
                hr_summary=hr_summary,
                activity_details={
                    "whoop": {
                        "strain": score.get("strain"),
                        "sport_id": row.get("sport_id"),
                        "percent_recorded": score.get("percent_recorded"),
                    },
                },
            )
            if created:
                result.activities_imported += 1

        if errors:
            result.error_messages = errors
        credential.last_synced_at = utcnow()
        db.add(credential)
        db.commit()
        return result
