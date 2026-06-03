"""Oura Ring provider."""
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
    parse_date,
    parse_datetime,
    seconds_to_hours,
    seconds_to_minutes,
    token_expires_at,
    upsert_daily_health_snapshot,
    upsert_sleep_log,
    upsert_workout_completion,
    utcnow,
)


_OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize"
_OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token"
_OURA_API_BASE = "https://api.ouraring.com/v2"
_OURA_DEFAULT_SCOPE = "daily heartrate workout spo2 personal"


def _env() -> tuple[str, str, str]:
    return (
        os.getenv("OURA_CLIENT_ID", ""),
        os.getenv("OURA_CLIENT_SECRET", ""),
        os.getenv("OURA_REDIRECT_URI", ""),
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


def _records(payload: Any) -> list[dict]:
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict)]
        if isinstance(payload.get("records"), list):
            return [r for r in payload["records"] if isinstance(r, dict)]
    return []


def _next_token(payload: Any) -> str | None:
    if not isinstance(payload, dict):
        return None
    token = payload.get("next_token") or payload.get("nextToken")
    return str(token) if token else None


def _request_token(data: dict[str, str]) -> dict[str, Any]:
    client_id, client_secret, _ = _env()
    data = {
        **data,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    resp = httpx.post(
        _OURA_TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=20.0,
    )
    resp.raise_for_status()
    return resp.json()


class OuraProvider(WearableProvider):
    slug = "oura"
    display_name = "Oura Ring"
    capabilities = ("sleep", "readiness", "heart_rate", "activities", "vo2_max")

    @property
    def is_configured(self) -> bool:
        client_id, client_secret, redirect_uri = _env()
        return bool(client_id and client_secret and redirect_uri)

    def authorize_url(self, state: str) -> str:
        client_id, _, redirect_uri = _env()
        scope = os.getenv("OURA_SCOPES", _OURA_DEFAULT_SCOPE)
        return f"{_OURA_AUTHORIZE_URL}?" + urlencode({
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
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
        start_date: str,
        end_date: str,
    ) -> list[dict]:
        params: dict[str, Any] = {"start_date": start_date, "end_date": end_date}
        out: list[dict] = []
        for _ in range(20):
            resp = httpx.get(
                f"{_OURA_API_BASE}/usercollection/{endpoint}",
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
            params["next_token"] = token
        return out

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        result = SyncResult()
        access_token = ensure_provider_access_token(db, credential, self)
        start_date = since.date().isoformat()
        end_date = utcnow().date().isoformat()
        errors: list[str] = []

        def fetch(name: str) -> list[dict]:
            try:
                return self._get_collection(access_token, name, start_date=start_date, end_date=end_date)
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code if exc.response is not None else "unknown"
                if status in {403, 404}:
                    errors.append(f"Oura {name}: unavailable ({status})")
                    return []
                raise

        for row in fetch("daily_readiness"):
            day = parse_date(row.get("day") or row.get("date"))
            if day is None:
                continue
            score = int_or_none(row.get("score"))
            if upsert_daily_health_snapshot(
                db,
                user_id,
                day,
                "oura",
                {"readiness_score": score},
                source_extra={
                    "oura_readiness": {
                        "score": score,
                        "contributors": row.get("contributors"),
                        "temperature_deviation": row.get("temperature_deviation"),
                    },
                },
            ):
                result.health_snapshots_imported += 1

        daily_sleep_scores: dict[str, int] = {}
        for row in fetch("daily_sleep"):
            day = parse_date(row.get("day") or row.get("date"))
            if day is None:
                continue
            score = int_or_none(row.get("score"))
            if score is not None:
                daily_sleep_scores[day.isoformat()] = score
            if upsert_sleep_log(
                db,
                user_id,
                day,
                "oura",
                {
                    "score": score,
                    "rating": _score_rating(score),
                    "mode": "provider",
                    "source": "oura",
                },
            ):
                result.sleep_logs_imported += 1

        for row in fetch("sleep"):
            end_dt = parse_datetime(row.get("bedtime_end") or row.get("end_datetime") or row.get("end"))
            day = parse_date(row.get("day")) or (end_dt.date() if end_dt else None)
            if day is None:
                continue
            total_hours = (
                seconds_to_hours(row.get("total_sleep_duration"))
                or seconds_to_hours(row.get("total_sleep_time"))
                or seconds_to_hours(row.get("duration"))
            )
            awake_minutes = seconds_to_minutes(row.get("awake_time") or row.get("awake_duration"))
            deep_hours = seconds_to_hours(row.get("deep_sleep_duration"))
            rem_hours = seconds_to_hours(row.get("rem_sleep_duration"))
            core_hours = seconds_to_hours(row.get("light_sleep_duration"))
            in_bed_minutes = None
            if total_hours is not None:
                in_bed_minutes = int(round(total_hours * 60 + (awake_minutes or 0)))
            hrv_ms = float_or_none(row.get("average_hrv") or row.get("hrv"))
            resting_hr = float_or_none(row.get("lowest_heart_rate") or row.get("average_heart_rate"))
            respiratory_rate = float_or_none(row.get("average_breath") or row.get("respiratory_rate"))
            score = daily_sleep_scores.get(day.isoformat())
            if upsert_sleep_log(
                db,
                user_id,
                day,
                "oura",
                {
                    "total_hours": total_hours,
                    "in_bed_minutes": in_bed_minutes,
                    "deep_hours": deep_hours,
                    "rem_hours": rem_hours,
                    "core_hours": core_hours,
                    "awake_minutes": awake_minutes,
                    "hrv_ms": hrv_ms,
                    "resting_hr": resting_hr,
                    "respiratory_rate": respiratory_rate,
                    "score": score,
                    "rating": _score_rating(score),
                    "mode": "provider",
                    "source": "oura",
                },
            ):
                result.sleep_logs_imported += 1
            if upsert_daily_health_snapshot(
                db,
                user_id,
                day,
                "oura",
                {
                    "hrv_ms": hrv_ms,
                    "resting_hr": resting_hr,
                    "respiratory_rate": respiratory_rate,
                },
                source_extra={"oura_sleep_document_id": row.get("id")},
            ):
                result.health_snapshots_imported += 1

        for row in fetch("daily_activity"):
            day = parse_date(row.get("day") or row.get("date"))
            if day is None:
                continue
            total_minutes = None
            medium = seconds_to_minutes(row.get("medium_activity_time"))
            high = seconds_to_minutes(row.get("high_activity_time"))
            if medium is not None or high is not None:
                total_minutes = (medium or 0) + (high or 0)
            if upsert_daily_health_snapshot(
                db,
                user_id,
                day,
                "oura",
                {
                    "steps": int_or_none(row.get("steps")),
                    "active_energy_kcal": float_or_none(row.get("active_calories")),
                    "workout_minutes": total_minutes,
                },
                source_extra={"oura_activity_score": row.get("score")},
            ):
                result.health_snapshots_imported += 1

        for row in fetch("daily_spo2"):
            day = parse_date(row.get("day") or row.get("date"))
            if day is None:
                continue
            spo2 = row.get("spo2_percentage")
            if isinstance(spo2, dict):
                spo2 = spo2.get("average")
            if upsert_daily_health_snapshot(
                db,
                user_id,
                day,
                "oura",
                {"oxygen_saturation": float_or_none(spo2)},
            ):
                result.health_snapshots_imported += 1

        for row in fetch("workout"):
            external_id = str(row.get("id") or row.get("document_id") or "").strip()
            if not external_id:
                continue
            started_at = parse_datetime(row.get("start_datetime") or row.get("start"))
            ended_at = parse_datetime(row.get("end_datetime") or row.get("end"))
            day = parse_date(row.get("day")) or (started_at.date() if started_at else None)
            if day is None:
                continue
            duration_seconds = int_or_none(row.get("duration")) or (
                int((ended_at - started_at).total_seconds()) if started_at and ended_at else 0
            )
            distance_miles = None
            distance_meters = float_or_none(row.get("distance"))
            if distance_meters is not None:
                distance_miles = distance_meters / 1609.344
            created = upsert_workout_completion(
                db,
                user_id,
                "oura",
                external_id,
                workout_date=day,
                focus_label=str(row.get("activity") or row.get("type") or "Oura Activity").title(),
                started_at=started_at,
                ended_at=ended_at,
                duration_seconds=duration_seconds or 0,
                activity_subtype=str(row.get("activity") or row.get("type") or "").lower() or None,
                distance_miles=distance_miles,
                calories_burned=int_or_none(row.get("calories")),
                activity_details={"oura": row},
            )
            if created:
                result.activities_imported += 1

        if errors:
            result.error_messages = errors
        credential.last_synced_at = utcnow()
        db.add(credential)
        db.commit()
        return result
