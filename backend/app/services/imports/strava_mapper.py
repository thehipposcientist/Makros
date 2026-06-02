"""Strava activity → Thallo WorkoutCompletion mapper.

Pure-function — no network, no DB. Takes a raw Strava activity dict
(as returned by GET /api/v3/athlete/activities) and converts it into a
Thallo-shaped record the pipeline can persist.

Strava activity schema (relevant fields):
    {
      "id": 12345,
      "name": "Morning Run",
      "type": "Run",  // Activity type — see _STRAVA_TYPE_MAP below
      "sport_type": "Run",
      "start_date": "2026-05-10T07:00:00Z",  // UTC ISO
      "distance": 5234.5,           // meters
      "moving_time": 1820,          // seconds
      "elapsed_time": 1980,         // seconds (includes pauses)
      "total_elevation_gain": 45.2, // meters
      "average_speed": 2.87,        // m/s
      "max_speed": 4.12,
      "average_heartrate": 152,     // bpm (optional — needs HR device)
      "max_heartrate": 178,
      "calories": 412,
      "average_watts": 175,         // cycling/rowing
      "kilojoules": 350,
    }

Mapping decisions:
  - distance: m → miles (Thallo internal unit)
  - duration: moving_time preferred over elapsed_time (rest-paused
    sessions shouldn't count their pause time toward fatigue)
  - focus_label: derived from activity type — Strava's Run → "Run",
    Ride → "Cycling", Swim → "Swimming", VirtualRide → "Cycling", etc.
  - activity_category: always "cardio" (Strava is a cardio app — even
    "WeightTraining" type rarely has set-level data we can use)
  - cardio_style: heuristic — "intervals" if max_hr/avg_hr ratio > 1.25,
    "easy" if avg_hr < 0.65 * MaxHR (need user age), else "steady"

External_source_id: Strava activity ID, prefixed `"strava:"` so it
doesn't collide with HK workout IDs in the same column.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
import math
from typing import Any


_METERS_PER_MILE = 1609.344
_METERS_PER_FOOT = 0.3048
_MPS_TO_MPH = 2.2369362920544


# Strava activity types → Thallo focus labels. Strava enumerates ~30
# types; we collapse them into the labels the planner already knows.
_STRAVA_TYPE_MAP: dict[str, str] = {
    "Run":             "Run",
    "TrailRun":        "Run",
    "VirtualRun":      "Run",
    "Treadmill":       "Run",
    "Walk":            "Walk",
    "Hike":            "Hike",
    "Ride":            "Cycling",
    "VirtualRide":     "Cycling",
    "EBikeRide":       "Cycling",
    "MountainBikeRide":"Cycling",
    "GravelRide":      "Cycling",
    "Swim":            "Swimming",
    "Rowing":          "Rowing",
    "Elliptical":      "Cardio",
    "StairStepper":    "Cardio",
    "Workout":         "Cross Training",
    "WeightTraining":  "Strength",
    "Yoga":            "Mobility",
    "Crossfit":        "Cross Training",
}


@dataclass(frozen=True)
class MappedActivity:
    """Pre-persistence shape — pipeline fills in import_batch_id +
    import_hash + import_source before insert."""
    external_id: str               # "strava:12345"
    workout_date: date
    focus_label: str
    duration_seconds: int
    activity_category: str         # "cardio" | "strength" | "mobility"
    activity_subtype: str | None   # e.g. "VirtualRide"
    cardio_style: str | None       # "intervals" | "steady" | "easy" | None
    distance_miles: float | None
    calories_burned: int | None
    avg_hr_bpm: int | None
    max_hr_bpm: int | None
    started_at: datetime
    ended_at: datetime
    name: str | None               # original Strava activity name
    notes: str | None
    activity_details: dict | None = None
    route_coords: list[dict] | None = None


def _meters_to_miles(m: float | None) -> float | None:
    if m is None or m <= 0:
        return None
    return round(m / _METERS_PER_MILE, 2)


def _meters_to_feet(m: float | None) -> float | None:
    if m is None:
        return None
    return round(m / _METERS_PER_FOOT)


def _mps_to_mph(mps: float | None) -> float | None:
    if mps is None or mps <= 0:
        return None
    return round(mps * _MPS_TO_MPH, 1)


def _pace_sec_per_mile_from_mps(mps: float | None) -> int | None:
    if mps is None or mps <= 0:
        return None
    return round(_METERS_PER_MILE / mps)


def _number(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _positive_int(value: Any) -> int | None:
    n = _number(value)
    if n is None or n <= 0:
        return None
    return int(n)


def _decode_polyline(polyline: str | None) -> list[dict] | None:
    if not polyline:
        return None
    coords: list[dict] = []
    index = 0
    lat = 0
    lon = 0
    try:
        while index < len(polyline):
            result = 0
            shift = 0
            while True:
                b = ord(polyline[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            dlat = ~(result >> 1) if result & 1 else result >> 1
            lat += dlat

            result = 0
            shift = 0
            while True:
                b = ord(polyline[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            dlon = ~(result >> 1) if result & 1 else result >> 1
            lon += dlon

            coords.append({"lat": round(lat / 1e5, 6), "lon": round(lon / 1e5, 6)})
    except (IndexError, TypeError, ValueError):
        return None
    return coords if len(coords) >= 2 else None


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    # Strava returns "2026-05-10T07:00:00Z". Python's fromisoformat in
    # 3.11+ handles Z directly; for safety we normalize.
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def _classify_category(strava_type: str) -> str:
    if strava_type == "WeightTraining":
        return "strength"
    if strava_type == "Yoga":
        return "mobility"
    return "cardio"


def _classify_cardio_style(
    avg_hr: float | None,
    max_hr: float | None,
    age: int | None = None,
) -> str | None:
    """Best-effort style classification. Returns None when we don't
    have enough signal — pipeline falls back to leaving the column null.

    Rules (kept simple — the planner's fatigue model is forgiving):
      - "intervals": max_hr / avg_hr ratio > 1.25 (high variance)
      - "easy":      avg_hr < 0.65 * estimated MaxHR (needs age)
      - "steady":    everything else when we have HR data
    """
    if avg_hr is None:
        return None
    if max_hr is not None and avg_hr > 0:
        ratio = max_hr / avg_hr
        if ratio > 1.25:
            return "intervals"
    if age is not None and age > 0:
        # 220 - age is the textbook MaxHR proxy; not great for trained
        # athletes but fine for the easy/steady cutoff at 65%.
        est_max_hr = 220 - age
        if avg_hr < 0.65 * est_max_hr:
            return "easy"
    return "steady"


def _strava_route_coords(activity: dict[str, Any]) -> list[dict] | None:
    map_obj = activity.get("map")
    if not isinstance(map_obj, dict):
        return None
    polyline = map_obj.get("summary_polyline") or map_obj.get("polyline")
    return _decode_polyline(polyline)


def _strava_activity_details(
    activity: dict[str, Any],
    *,
    distance_miles: float | None,
    duration_seconds: int,
    duration_source: str,
) -> dict | None:
    details: dict[str, Any] = {}

    moving_seconds = _positive_int(activity.get("moving_time"))
    elapsed_seconds = _positive_int(activity.get("elapsed_time"))
    if moving_seconds is not None:
        details["movingSeconds"] = moving_seconds
    if elapsed_seconds is not None:
        details["elapsedSeconds"] = elapsed_seconds
    details["durationSource"] = duration_source
    if moving_seconds is not None and elapsed_seconds is not None and elapsed_seconds > moving_seconds:
        details["stoppedSeconds"] = elapsed_seconds - moving_seconds

    elevation_ft = _meters_to_feet(_number(activity.get("total_elevation_gain")))
    if elevation_ft is not None:
        details["elevationGainFt"] = elevation_ft
    elev_high_ft = _meters_to_feet(_number(activity.get("elev_high")))
    if elev_high_ft is not None:
        details["elevationHighFt"] = elev_high_ft
    elev_low_ft = _meters_to_feet(_number(activity.get("elev_low")))
    if elev_low_ft is not None:
        details["elevationLowFt"] = elev_low_ft

    avg_speed_mps = _number(activity.get("average_speed"))
    avg_speed_mph = _mps_to_mph(avg_speed_mps)
    if avg_speed_mph is not None:
        details["avgSpeedMph"] = avg_speed_mph
    max_speed_mph = _mps_to_mph(_number(activity.get("max_speed")))
    if max_speed_mph is not None:
        details["maxSpeedMph"] = max_speed_mph

    strava_type = str(activity.get("sport_type") or activity.get("type") or "").lower()
    prefers_speed = any(token in strava_type for token in ("ride", "cycl", "bike"))
    if not prefers_speed:
        avg_pace = _pace_sec_per_mile_from_mps(avg_speed_mps)
        if avg_pace is None and distance_miles and distance_miles > 0 and duration_seconds > 0:
            avg_pace = round(duration_seconds / distance_miles)
        if avg_pace is not None:
            details["avgPaceSecPerMi"] = avg_pace

    avg_cadence = _number(activity.get("average_cadence"))
    if avg_cadence is not None:
        details["avgCadence"] = round(avg_cadence, 1)

    avg_watts = _number(activity.get("average_watts"))
    if avg_watts is not None and avg_watts > 0:
        details["avgWatts"] = round(avg_watts)
        device_watts = activity.get("device_watts")
        details["avgWattsSource"] = "strava_device" if device_watts is True else "strava_estimated"
    weighted_watts = _number(activity.get("weighted_average_watts"))
    if weighted_watts is not None and weighted_watts > 0:
        details["weightedAvgWatts"] = round(weighted_watts)
    max_watts = _number(activity.get("max_watts"))
    if max_watts is not None and max_watts > 0:
        details["maxWatts"] = round(max_watts)
    kilojoules = _number(activity.get("kilojoules"))
    if kilojoules is not None and kilojoules > 0:
        details["kilojoules"] = round(kilojoules)

    if activity.get("has_heartrate") is not None:
        details["hasHeartRate"] = bool(activity.get("has_heartrate"))
    if activity.get("device_watts") is not None:
        details["deviceWatts"] = bool(activity.get("device_watts"))
    suffer_score = _number(activity.get("suffer_score"))
    if suffer_score is not None and suffer_score > 0:
        details["stravaSufferScore"] = round(suffer_score)

    gear_id = activity.get("gear_id")
    if gear_id:
        details["stravaGearId"] = str(gear_id)
    map_obj = activity.get("map")
    if isinstance(map_obj, dict) and map_obj.get("id"):
        details["stravaMapId"] = str(map_obj["id"])

    return details or None


def map_strava_activity(activity: dict[str, Any], age: int | None = None) -> MappedActivity | None:
    """Map one Strava activity dict to a `MappedActivity`. Returns
    `None` when the activity is too malformed to import (missing id,
    missing start_date, missing moving_time)."""
    activity_id = activity.get("id")
    if activity_id is None:
        return None

    started_at = _parse_iso(activity.get("start_date") or activity.get("start_date_local"))
    if not started_at:
        return None

    moving_time = _positive_int(activity.get("moving_time"))
    elapsed_time = _positive_int(activity.get("elapsed_time"))
    duration_seconds = moving_time if moving_time else (elapsed_time if elapsed_time else 0)
    if duration_seconds <= 0:
        return None
    duration_source = "moving_time" if moving_time else "elapsed_time"

    strava_type = activity.get("sport_type") or activity.get("type") or "Workout"
    focus_label = _STRAVA_TYPE_MAP.get(strava_type, "Cardio")
    activity_category = _classify_category(strava_type)

    distance_miles = _meters_to_miles(activity.get("distance"))
    cardio_style = (
        _classify_cardio_style(
            activity.get("average_heartrate"),
            activity.get("max_heartrate"),
            age=age,
        )
        if activity_category == "cardio"
        else None
    )

    ended_at = datetime.fromtimestamp(
        started_at.timestamp() + duration_seconds,
        tz=started_at.tzinfo,
    )

    activity_details = _strava_activity_details(
        activity,
        distance_miles=distance_miles,
        duration_seconds=duration_seconds,
        duration_source=duration_source,
    )

    return MappedActivity(
        external_id=f"strava:{activity_id}",
        workout_date=started_at.date(),
        focus_label=focus_label,
        duration_seconds=duration_seconds,
        activity_category=activity_category,
        activity_subtype=strava_type,
        cardio_style=cardio_style,
        distance_miles=distance_miles,
        calories_burned=int(activity["calories"]) if activity.get("calories") else None,
        avg_hr_bpm=int(activity["average_heartrate"]) if activity.get("average_heartrate") else None,
        max_hr_bpm=int(activity["max_heartrate"]) if activity.get("max_heartrate") else None,
        started_at=started_at,
        ended_at=ended_at,
        name=activity.get("name"),
        notes=activity.get("description"),
        activity_details=activity_details,
        route_coords=_strava_route_coords(activity),
    )


def map_strava_activities(
    activities: list[dict[str, Any]],
    age: int | None = None,
) -> list[MappedActivity]:
    """Map a list of activities, silently dropping unparseable ones.
    Pipeline counters track how many got dropped via the diff between
    input length and output length."""
    out: list[MappedActivity] = []
    for a in activities:
        mapped = map_strava_activity(a, age=age)
        if mapped is not None:
            out.append(mapped)
    return out
