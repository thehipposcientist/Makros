from __future__ import annotations

import hashlib
from datetime import date, datetime, timezone
from typing import Any

from sqlmodel import Session, select

from app.field_encryption import decrypt_text, encrypt_text
from app.models import (
    DailyHealthSnapshot,
    HealthSourcePreference,
    IntegrationCredential,
    SleepLog,
    WorkoutCompletion,
)
from app.services.integrations.base import TokenSet, WearableProvider


HEALTH_PATCH_FIELDS = (
    "steps", "active_energy_kcal", "basal_energy_kcal", "workout_minutes",
    "cardio_minutes", "zone2_minutes", "resting_hr", "hrv_ms", "vo2_max",
    "respiratory_rate", "oxygen_saturation", "wrist_temperature_c",
    "sleep_breathing_disturbances", "sleep_breathing_disturbances_elevated",
    "weight_lbs", "readiness_score",
)

SLEEP_PATCH_FIELDS = (
    "total_hours", "in_bed_minutes", "deep_hours", "rem_hours",
    "core_hours", "awake_minutes", "hrv_ms", "resting_hr",
    "respiratory_rate", "spo2_percent", "bedtime_minutes_from_midnight",
    "score", "rating", "mode", "source",
)

SOURCE_PRIORITY = {
    "manual": 100,
    "oura": 92,
    "whoop": 90,
    "google_health": 82,
    "health_connect": 72,
    "apple_health": 70,
    "watch": 68,
    "strava": 55,
    "fitbit": 50,
    "unknown": 0,
}


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    raw = str(value).strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def parse_date(value: Any) -> date | None:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def ms_to_hours(value: Any) -> float | None:
    try:
        millis = float(value)
    except (TypeError, ValueError):
        return None
    if millis <= 0:
        return None
    return millis / 3_600_000.0


def ms_to_minutes(value: Any) -> int | None:
    try:
        millis = float(value)
    except (TypeError, ValueError):
        return None
    if millis <= 0:
        return None
    return int(round(millis / 60_000.0))


def seconds_to_hours(value: Any) -> float | None:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return seconds / 3600.0


def seconds_to_minutes(value: Any) -> int | None:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds <= 0:
        return None
    return int(round(seconds / 60.0))


def float_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def int_or_none(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def encrypted_token_set(tokens: TokenSet) -> TokenSet:
    return TokenSet(
        access_token=encrypt_text(tokens.access_token) or "",
        refresh_token=encrypt_text(tokens.refresh_token),
        expires_at=tokens.expires_at,
        external_user_id=tokens.external_user_id,
        extras=tokens.extras,
    )


def token_expires_at(expires_in: Any) -> datetime | None:
    seconds = int_or_none(expires_in)
    if seconds is None or seconds <= 0:
        return None
    return datetime.fromtimestamp(utcnow().timestamp() + seconds, tz=timezone.utc)


def credential_needs_refresh(credential: IntegrationCredential) -> bool:
    if not credential.access_token:
        return True
    expires_at = credential.expires_at
    if expires_at is None:
        return False
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return (expires_at - utcnow()).total_seconds() < 60


def ensure_provider_access_token(
    db: Session,
    credential: IntegrationCredential,
    provider: WearableProvider,
) -> str:
    access_token = decrypt_text(credential.access_token)
    if access_token and not credential_needs_refresh(credential):
        return access_token

    refresh_token = decrypt_text(credential.refresh_token)
    if not refresh_token:
        credential.status = "expired"
        credential.updated_at = utcnow()
        db.add(credential)
        db.commit()
        raise RuntimeError("no refresh token stored; user must reconnect")

    refreshed = encrypted_token_set(provider.refresh(refresh_token))
    credential.access_token = refreshed.access_token
    credential.refresh_token = refreshed.refresh_token or credential.refresh_token
    credential.expires_at = refreshed.expires_at or credential.expires_at
    credential.external_user_id = refreshed.external_user_id or credential.external_user_id
    if refreshed.extras:
        credential.extras = {**(credential.extras or {}), **refreshed.extras}
    credential.status = "active"
    credential.updated_at = utcnow()
    db.add(credential)
    db.commit()
    return decrypt_text(credential.access_token) or ""


def source_preference_for(db: Session, user_id: int) -> HealthSourcePreference:
    pref = db.exec(
        select(HealthSourcePreference).where(HealthSourcePreference.user_id == user_id)
    ).first()
    if pref is not None:
        return pref
    pref = HealthSourcePreference(user_id=user_id)
    db.add(pref)
    db.commit()
    db.refresh(pref)
    return pref


def _preferred_source(pref: HealthSourcePreference, field: str) -> str:
    if field in {"readiness_score"}:
        return pref.readiness_source
    if field == "hrv_ms":
        return pref.hrv_source
    if field == "resting_hr":
        return pref.resting_hr_source
    if field in {"steps", "active_energy_kcal", "basal_energy_kcal", "workout_minutes", "cardio_minutes", "zone2_minutes"}:
        return pref.activity_source
    if field == "weight_lbs":
        return pref.body_weight_source
    return "auto"


def _incoming_wins(
    current_source: str | None,
    incoming_source: str,
    preferred_source: str,
) -> bool:
    if preferred_source and preferred_source != "auto":
        return preferred_source == incoming_source or not current_source
    current_rank = SOURCE_PRIORITY.get(current_source or "unknown", 0)
    incoming_rank = SOURCE_PRIORITY.get(incoming_source or "unknown", 0)
    return incoming_rank >= current_rank


def _merge_source_details(
    current: dict | None,
    source: str,
    values: dict[str, Any],
    extra: dict | None = None,
    winning_fields: set[str] | None = None,
) -> dict:
    merged: dict = dict(current) if isinstance(current, dict) else {}
    providers = set(merged.get("providers") or [])
    providers.add(source)
    merged["providers"] = sorted(providers)
    merged["last_source"] = source

    fields = dict(merged.get("fields") or {})
    provider_values = dict(merged.get("provider_values") or {})
    for field, value in values.items():
        if value is None:
            continue
        if winning_fields is None or field in winning_fields:
            fields[field] = source
        by_provider = dict(provider_values.get(field) or {})
        by_provider[source] = value
        provider_values[field] = by_provider
    if fields:
        merged["fields"] = fields
    if provider_values:
        merged["provider_values"] = provider_values
    if extra:
        reserved = {"providers", "fields", "provider_values", "last_source"}
        merged.update({k: v for k, v in extra.items() if k not in reserved and v is not None})
    return merged


def upsert_daily_health_snapshot(
    db: Session,
    user_id: int,
    snapshot_date: date,
    source: str,
    values: dict[str, Any],
    *,
    source_extra: dict | None = None,
) -> bool:
    cleaned = {field: values.get(field) for field in HEALTH_PATCH_FIELDS if values.get(field) is not None}
    if not cleaned:
        return False
    pref = source_preference_for(db, user_id)
    row = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date == snapshot_date)
    ).first()
    now = utcnow()
    if row is None:
        row = DailyHealthSnapshot(
            user_id=user_id,
            snapshot_date=snapshot_date,
            source=source,
            created_at=now,
            updated_at=now,
        )
        db.add(row)

    existing_fields = (row.source_details or {}).get("fields") if isinstance(row.source_details, dict) else {}
    existing_fields = existing_fields if isinstance(existing_fields, dict) else {}
    winning_fields: set[str] = set()
    for field, value in cleaned.items():
        current_source = existing_fields.get(field) or row.source
        preferred = _preferred_source(pref, field)
        if getattr(row, field) is None or _incoming_wins(current_source, source, preferred):
            setattr(row, field, value)
            winning_fields.add(field)
    row.source = source if source not in {"apple_health", "health_connect"} else row.source
    row.source_details = _merge_source_details(
        row.source_details,
        source,
        cleaned,
        source_extra,
        winning_fields,
    )
    row.updated_at = now
    db.add(row)
    return True


def _sleep_preferred_source(pref: HealthSourcePreference) -> str:
    return pref.sleep_source


def upsert_sleep_log(
    db: Session,
    user_id: int,
    night_date: date,
    source: str,
    values: dict[str, Any],
) -> bool:
    cleaned = {field: values.get(field) for field in SLEEP_PATCH_FIELDS if values.get(field) is not None}
    if not cleaned:
        return False
    pref = source_preference_for(db, user_id)
    row = db.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(SleepLog.night_date == night_date)
    ).first()
    now = utcnow()
    if row is None:
        row = SleepLog(user_id=user_id, night_date=night_date, created_at=now, updated_at=now)
        db.add(row)
    preferred = _sleep_preferred_source(pref)
    current_source = row.source or "unknown"
    if row.source is None or _incoming_wins(current_source, source, preferred):
        for field, value in cleaned.items():
            if field == "source":
                continue
            setattr(row, field, value)
        row.source = source
    else:
        for field in ("hrv_ms", "resting_hr", "respiratory_rate", "spo2_percent"):
            if getattr(row, field) is None and cleaned.get(field) is not None:
                setattr(row, field, cleaned[field])
    row.updated_at = now
    db.add(row)
    return True


def import_hash(user_id: int, provider: str, external_id: str) -> str:
    return hashlib.sha256(f"{user_id}|{provider}|{external_id}".encode("utf-8")).hexdigest()


def upsert_workout_completion(
    db: Session,
    user_id: int,
    provider: str,
    external_id: str,
    *,
    workout_date: date,
    focus_label: str,
    started_at: datetime | None,
    ended_at: datetime | None,
    duration_seconds: int,
    activity_subtype: str | None = None,
    distance_miles: float | None = None,
    calories_burned: int | None = None,
    hr_summary: dict | None = None,
    activity_details: dict | None = None,
) -> bool:
    source_id = f"{provider}:{external_id}"
    existing = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.external_source_id == source_id)
    ).first()
    now = utcnow()
    if existing is None:
        from app.services.workout.activity_energy import cardio_load_from_hr_summary
        db.add(WorkoutCompletion(
            user_id=user_id,
            workout_date=workout_date,
            focus_label=focus_label,
            duration_seconds=max(0, duration_seconds),
            source_context=f"import_{provider}",
            activity_category="cardio",
            activity_subtype=activity_subtype,
            activity_source=provider,
            distance_miles=distance_miles,
            calories_burned=calories_burned,
            activity_details=activity_details,
            hr_summary=hr_summary,
            cardio_load=cardio_load_from_hr_summary(hr_summary),
            started_at=started_at,
            ended_at=ended_at,
            external_source_id=source_id,
            import_source=provider,
            import_hash=import_hash(user_id, provider, external_id),
            completed_at=ended_at or now,
        ))
        return True

    if duration_seconds > 0:
        existing.duration_seconds = duration_seconds
    existing.activity_subtype = activity_subtype or existing.activity_subtype
    existing.distance_miles = distance_miles if distance_miles is not None else existing.distance_miles
    existing.calories_burned = calories_burned if calories_burned is not None else existing.calories_burned
    existing.activity_details = activity_details if activity_details is not None else existing.activity_details
    existing.hr_summary = hr_summary if hr_summary is not None else existing.hr_summary
    if hr_summary is not None:
        from app.services.workout.activity_energy import cardio_load_from_hr_summary
        existing.cardio_load = cardio_load_from_hr_summary(hr_summary) or existing.cardio_load
    existing.started_at = started_at or existing.started_at
    existing.ended_at = ended_at or existing.ended_at
    db.add(existing)
    return False
