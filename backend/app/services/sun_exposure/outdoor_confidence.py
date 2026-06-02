from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.services.sun_exposure.types import AreaSunContext, OutdoorConfidenceEstimate


OUTDOOR_ACTIVITY_SUBTYPES = {
    "walk",
    "run",
    "ride",
    "bike",
    "cycling",
    "row",
    "rowing",
    "hike",
    "hiking",
    "golf",
    "soccer",
    "basketball",
    "tennis",
    "pickleball",
    "volleyball",
    "beach_volleyball",
    "skiing",
    "surfing",
    "yard_work",
    "gardening",
    "chopping_wood",
    "shoveling",
    "construction",
    "playing",
}

VEHICLE_TERMS = {"drive", "driving", "vehicle", "car", "commute", "automotive"}

OUTDOOR_AREA_TYPES = {
    "park_mixed", "open_grass", "beach", "water_edge",
    "sports_field", "wooded_trail", "dense_forest", "snow",
}


def _clean(value: Any) -> str:
    return str(value or "").strip().lower()


def _explicit_venue(signals: Mapping[str, Any]) -> str:
    """The user-declared / logger-captured venue, if any. This is authoritative
    truth (the user told us), so it wins over the subtype prior below — an
    indoor treadmill run or trainer ride must NOT be credited as outdoor just
    because "run"/"ride" is usually outdoors. Returns "indoor" | "outdoor" | ""."""
    venue = _clean(signals.get("venue") or signals.get("indoorOutdoor") or signals.get("indoor_outdoor"))
    terrain = _clean(signals.get("terrain"))
    cardio_style = _clean(signals.get("cardioStyle") or signals.get("cardio_style"))
    # Indoor wins ties: if ANY signal says indoor, treat the session as indoor
    # (the conservative choice for sun credit). This matters when a default
    # venue is "outdoor" but the user picked a treadmill/indoor terrain.
    if venue == "indoor" or terrain in {"indoor", "treadmill"} or cardio_style == "indoor":
        return "indoor"
    if venue == "outdoor" or terrain in {"outdoor", "road", "trail", "track"} or cardio_style == "outdoor":
        return "outdoor"
    return ""


def _is_outdoor_activity(signals: Mapping[str, Any]) -> bool:
    """WEAK prior: this activity *type* is usually outdoors. Only consulted when
    there is no explicit venue / GPS / daylight signal, and even then it yields
    a low "unknown" confidence at the call site — most of these subtypes (run,
    ride, soccer, …) are venue-ambiguous, so the type alone is a hint, not
    proof. Explicit-venue handling above overrides it."""
    subtype = _clean(signals.get("activitySubtype") or signals.get("activity_subtype") or signals.get("subtype"))
    category = _clean(signals.get("activityCategory") or signals.get("activity_category") or signals.get("category"))
    if subtype in OUTDOOR_ACTIVITY_SUBTYPES:
        return True
    if any(term in subtype for term in OUTDOOR_ACTIVITY_SUBTYPES):
        return True
    if category == "sport" and subtype not in {"boxing", "kickboxing", "martial_arts", "climbing"}:
        return True
    return False


def estimate_outdoor_confidence(
    *,
    source: str | None = None,
    area_context: AreaSunContext | None = None,
    signals: Mapping[str, Any] | None = None,
) -> OutdoorConfidenceEstimate:
    signals = signals or {}
    reason_codes: list[str] = []
    normalized_source = _clean(source or signals.get("source"))
    correction = _clean(signals.get("userCorrection") or signals.get("user_correction"))

    if correction == "indoors":
        return OutdoorConfidenceEstimate(0.0, False, ["user_correction_indoors"])
    if correction in {"mostly_sunny", "mixed", "mostly_shaded"}:
        return OutdoorConfidenceEstimate(0.98, True, [f"user_correction_{correction}"])

    if bool(signals.get("buildingPolygon") or signals.get("building_polygon")):
        return OutdoorConfidenceEstimate(0.05, False, ["building_polygon_negative"])

    if area_context and area_context.area_type == "indoor":
        return OutdoorConfidenceEstimate(0.05, False, ["area_context_indoor"])
    if area_context and area_context.area_type == "vehicle":
        return OutdoorConfidenceEstimate(0.10, False, ["area_context_vehicle"])

    # Explicit venue is user-declared truth — an indoor session is a hard
    # negative regardless of how "outdoorsy" the activity type usually is.
    venue = _explicit_venue(signals)
    if venue == "indoor":
        return OutdoorConfidenceEstimate(0.05, False, ["explicit_indoor_venue"])

    activity_text = " ".join(
        _clean(signals.get(key))
        for key in ("activitySubtype", "activity_subtype", "activitySource", "activity_source", "motion")
    )
    if any(term in activity_text for term in VEHICLE_TERMS):
        return OutdoorConfidenceEstimate(0.10, False, ["vehicle_activity_negative"])

    daylight_minutes = signals.get("healthkitDaylightMinutes") or signals.get("healthkit_daylight_minutes")
    if normalized_source == "healthkit_daylight" or (isinstance(daylight_minutes, (int, float)) and daylight_minutes > 0):
        return OutdoorConfidenceEstimate(0.95, True, ["healthkit_daylight_signal"])

    has_route = bool(signals.get("hasWorkoutRoute") or signals.get("has_workout_route") or normalized_source == "workout_route")
    if has_route:
        return OutdoorConfidenceEstimate(0.90, True, ["workout_route_signal"])

    # Explicit outdoor venue — strong positive (the user said outdoors).
    if venue == "outdoor":
        if area_context and area_context.area_type in OUTDOOR_AREA_TYPES:
            return OutdoorConfidenceEstimate(0.92, True, ["explicit_outdoor_venue_area_match"])
        return OutdoorConfidenceEstimate(0.88, True, ["explicit_outdoor_venue"])

    if _is_outdoor_activity(signals):
        if area_context and area_context.area_type in OUTDOOR_AREA_TYPES:
            # Subtype prior corroborated by an outdoor area — moderate.
            return OutdoorConfidenceEstimate(0.72, True, ["outdoor_activity_area_match"])
        # Subtype prior alone, venue unknown → weak, leaning-outdoor guess.
        # (Most of these subtypes can be indoor; without a venue we don't
        # assume sun exposure.)
        return OutdoorConfidenceEstimate(0.55, "unknown", ["outdoor_activity_type_prior"])

    if area_context and area_context.area_type in OUTDOOR_AREA_TYPES:
        moving = bool(signals.get("motion") or signals.get("moving") or signals.get("steps"))
        if moving:
            return OutdoorConfidenceEstimate(0.70, True, ["outdoor_area_with_motion"])
        return OutdoorConfidenceEstimate(0.55, "unknown", ["outdoor_area_without_motion"])

    if normalized_source == "coarse_location":
        return OutdoorConfidenceEstimate(0.40, "unknown", ["coarse_location_unknown"])

    return OutdoorConfidenceEstimate(0.30, "unknown", ["insufficient_outdoor_signals"])
