from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from .types import ContextSegment


SENSITIVE_PLACE_CATEGORIES = {
    "abortion_clinic",
    "addiction_treatment",
    "clinic",
    "courthouse",
    "domestic_violence_shelter",
    "hospital",
    "mental_health",
    "pharmacy",
    "place_of_worship",
    "political",
    "prison",
    "reproductive_health",
    "school",
    "shelter",
}

RAW_LOCATION_KEYS = {
    "lat",
    "latitude",
    "lon",
    "lng",
    "longitude",
    "gps",
    "gps_points",
    "gpsPoints",
    "route",
    "route_coords",
    "routeCoords",
    "coordinates",
}


def is_sensitive_place_category(value: str | None) -> bool:
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return key in SENSITIVE_PLACE_CATEGORIES


def strips_raw_location(payload: Mapping[str, Any]) -> bool:
    keys = {str(k) for k in payload.keys()}
    return not any(key in keys for key in RAW_LOCATION_KEYS)


def sanitize_context_segment(payload: Mapping[str, Any], *, user_id: int, fallback_id: str = "segment") -> ContextSegment | None:
    if is_sensitive_place_category(str(payload.get("placeCategory") or payload.get("place_category") or "")):
        return None

    start = _parse_datetime(payload.get("startTime") or payload.get("start_time"))
    end = _parse_datetime(payload.get("endTime") or payload.get("end_time"))
    return ContextSegment(
        id=str(payload.get("id") or fallback_id),
        user_id=user_id,
        start_time=start,
        end_time=end,
        coarse_location_hash=_string_or_none(payload.get("coarseLocationHash") or payload.get("coarse_location_hash")),
        place_category=_string_or_none(payload.get("placeCategory") or payload.get("place_category")),
        activity_type=_string_or_none(payload.get("activityType") or payload.get("activity_type")),
        workout_id=_int_or_none(payload.get("workoutId") or payload.get("workout_id")),
        daylight=_bool_or_none(payload.get("daylight")),
        uv_index=_float_or_none(payload.get("uvIndex") or payload.get("uv_index")),
        air_quality_index=_int_or_none(payload.get("airQualityIndex") or payload.get("air_quality_index")),
        temperature=_float_or_none(payload.get("temperature")),
        humidity=_float_or_none(payload.get("humidity")),
        elevation_gain_meters=_float_or_none(payload.get("elevationGainMeters") or payload.get("elevation_gain_meters")),
        steps=_int_or_none(payload.get("steps")),
        heart_rate_avg=_float_or_none(payload.get("heartRateAvg") or payload.get("heart_rate_avg")),
        social_context=_social_context(payload.get("socialContext") or payload.get("social_context")),
        confidence=_confidence(payload.get("confidence")),
        source=_source_list(payload.get("source") or payload.get("sources")),
    )


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)


def _string_or_none(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except Exception:
        return None


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except Exception:
        return None


def _bool_or_none(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None


def _confidence(value: Any):
    text = str(value or "").strip().lower()
    return text if text in {"low", "medium", "high"} else "low"


def _social_context(value: Any):
    text = str(value or "").strip().lower()
    return text if text in {"alone", "with_friend", "group", "unknown"} else None


def _source_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").strip()
    return [text] if text else []

