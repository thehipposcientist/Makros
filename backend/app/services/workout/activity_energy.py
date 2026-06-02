"""Conservative calorie estimates for manually logged activities."""
from __future__ import annotations


_CARDIO_MET = {
    "walk": 3.3,
    "walking": 3.3,
    "run": 9.0,
    "running": 9.0,
    "ride": 6.8,
    "cycling": 6.8,
    "bike": 6.8,
    "spin": 7.8,
    "hike": 6.0,
    "hiking": 6.0,
    "swim": 6.0,
    "swimming": 6.0,
    "row": 7.0,
    "rowing": 7.0,
    "stair": 8.0,
    "elliptical": 5.0,
    "bootcamp": 8.0,
    "hiit": 8.0,
}

_SPORT_MET = {
    "basketball": 6.5,
    "soccer": 7.0,
    "tennis": 5.5,
    "pickleball": 4.5,
    "volleyball": 4.0,
    "beach_volleyball": 6.0,
    "golf": 3.5,
    "climbing": 6.0,
    "boxing": 7.8,
    "kickboxing": 7.8,
    "martial_arts": 7.0,
    "skiing": 6.0,
    "surfing": 3.5,
}

_ACTIVE_MET = {
    "yard_work": 4.0,
    "gardening": 3.5,
    "cleaning": 3.3,
    "moving": 5.5,
    "construction": 4.5,
    "chopping_wood": 6.0,
    "shoveling": 5.5,
    "playing": 4.0,
    "dancing": 5.0,
}

_MOBILITY_MET = {
    "yoga": 2.5,
    "stretching": 2.0,
    "foam_roll": 2.0,
    "pilates": 3.0,
}


def _norm(value: str | None) -> str:
    return (value or "").strip().lower().replace(" ", "_").replace("-", "_")


def _intensity_factor(intensity: str | None) -> float:
    value = _norm(intensity)
    if value == "easy":
        return 0.85
    if value == "hard":
        return 1.15
    return 1.0


def _cardio_style_factor(style: str | None) -> float:
    value = _norm(style)
    if value in {"recovery", "easy"}:
        return 0.8
    if value == "intervals":
        return 1.12
    if value == "class":
        return 1.05
    return 1.0


def _base_met(category: str | None, subtype: str | None) -> float | None:
    cat = _norm(category)
    sub = _norm(subtype)
    if cat == "cardio":
        return _CARDIO_MET.get(sub, 5.5)
    if cat == "strength":
        return 4.0
    if cat == "sport":
        return _SPORT_MET.get(sub, 5.5)
    if cat == "active":
        return _ACTIVE_MET.get(sub, 3.8)
    if cat == "mobility":
        return _MOBILITY_MET.get(sub, 2.5)
    if cat == "recovery":
        return 2.5 if sub in {"walk", "walking"} else None
    return None


def estimate_activity_calories(
    *,
    duration_seconds: int | None,
    weight_lbs: float | None,
    category: str | None,
    subtype: str | None = None,
    intensity: str | None = None,
    cardio_style: str | None = None,
) -> int | None:
    """Estimate active calories from METs when no wearable/import value exists."""
    minutes = max(0.0, float(duration_seconds or 0) / 60.0)
    if minutes < 1 or not weight_lbs or weight_lbs <= 0:
        return None

    met = _base_met(category, subtype)
    if met is None:
        return None

    if _norm(category) in {"cardio", "sport"}:
        met *= _cardio_style_factor(cardio_style)
    met *= _intensity_factor(intensity)
    met = max(1.5, min(12.0, met))

    weight_kg = float(weight_lbs) / 2.2046226218
    kcal = met * 3.5 * weight_kg / 200.0 * minutes
    if kcal < 10:
        return None
    return int(round(kcal))


# Heart-rate zone distribution profiles for a manually logged cardio
# session that carries no wearable HR data. Each profile is the fraction
# of total minutes spent in [Z1, Z2, Z3, Z4, Z5]. Selected by cardio
# style first, then intensity. Deliberately conservative — a manual log
# should nudge the Zone-2 trend, not dominate it.
_ZONE_PROFILES: dict[str, tuple[float, float, float, float, float]] = {
    "recovery":  (0.35, 0.55, 0.10, 0.00, 0.00),
    "easy":      (0.30, 0.60, 0.10, 0.00, 0.00),
    "steady":    (0.10, 0.62, 0.23, 0.05, 0.00),
    "class":     (0.10, 0.40, 0.35, 0.13, 0.02),
    "intervals": (0.10, 0.22, 0.26, 0.30, 0.12),
    "hard":      (0.05, 0.30, 0.40, 0.20, 0.05),
}


def estimate_cardio_zone_minutes(
    *,
    duration_seconds: int | None,
    intensity: str | None = None,
    cardio_style: str | None = None,
) -> list[int] | None:
    """Estimate HR zone minutes [Z1..Z5] for a manually logged cardio
    session with no wearable data.

    Returns None for sessions under a minute. The caller is responsible
    for restricting this to cardio activities — strength work must never
    receive cardio zone minutes. The breakdown sums to the logged
    duration so it reads like real wearable zone data downstream.
    """
    minutes = int(round(max(0.0, float(duration_seconds or 0) / 60.0)))
    if minutes < 1:
        return None

    style = _norm(cardio_style)
    profile = _ZONE_PROFILES.get(style)
    if profile is None:
        intensity_n = _norm(intensity)
        profile = (
            _ZONE_PROFILES["easy"] if intensity_n == "easy"
            else _ZONE_PROFILES["hard"] if intensity_n == "hard"
            else _ZONE_PROFILES["steady"]
        )

    raw = [minutes * frac for frac in profile]
    zones = [int(round(v)) for v in raw]
    # Push rounding drift onto the dominant zone so the breakdown still
    # sums to the logged duration.
    drift = minutes - sum(zones)
    if drift:
        dominant = max(range(5), key=lambda i: raw[i])
        zones[dominant] = max(0, zones[dominant] + drift)
    return zones


# ── Cardio training load (Edwards' TRIMP) ────────────────────────────────────
#
# Edwards' TRIMP is the simplest defensible cardio-load metric: each HR zone
# contributes minutes × zone weight. Z1 counts a little, Z5 counts five times
# as much. The result is a single "training impulse" number per session that
# parallels strength volume (sets × reps × weight) — comparable across days
# and aggregatable across weeks without per-user calibration.
#
# Why Edwards' over Banister's exponential TRIMP: Banister's needs a sex
# coefficient and resting/max HR per user, which we don't reliably have for
# manual logs. Edwards' just needs zone minutes, which we ALWAYS have once
# `_completion_hr_summary` resolves — real wearable or synthesized.
#
# Reference: Edwards, "The Heart Rate Monitor Book" (1993). Industry-
# standard fallback when individualized HR thresholds aren't available.

# Zone weights: Z1 × 1, Z2 × 2, Z3 × 3, Z4 × 4, Z5 × 5.
_EDWARDS_TRIMP_WEIGHTS: tuple[float, float, float, float, float] = (1.0, 2.0, 3.0, 4.0, 5.0)


def compute_cardio_load(zone_minutes: list[float] | list[int] | None) -> float | None:
    """Return Edwards' TRIMP for a session given its [Z1..Z5] minutes.

    Returns None when there's no usable signal — never returns 0 from
    missing input. Explicit all-zero zones return 0.0 because that means
    "we know the session existed and produced no aerobic stimulus", which
    is different from "we don't know."

    A typical 45-min easy run with 5/27/10/3/0 zones scores about
      5×1 + 27×2 + 10×3 + 3×4 + 0×5 = 101 TRIMP.
    A 30-min HIIT with 2/3/5/15/5 zones scores about
      2 + 6 + 15 + 60 + 25 = 108 TRIMP — comparable load, different shape.
    A 60-min recovery walk with 30/28/2/0/0 zones scores about
      30 + 56 + 6 + 0 + 0 = 92 TRIMP — close, as it should be on volume.
    """
    if zone_minutes is None:
        return None
    if not isinstance(zone_minutes, (list, tuple)) or len(zone_minutes) < 5:
        return None
    total = 0.0
    for minutes, weight in zip(zone_minutes[:5], _EDWARDS_TRIMP_WEIGHTS):
        try:
            m = float(minutes)
        except (TypeError, ValueError):
            return None
        if m < 0 or m != m:  # negative or NaN — bad input
            return None
        total += m * weight
    return round(total, 1)


def cardio_load_from_hr_summary(hr_summary: dict | None) -> float | None:
    """Convenience wrapper: read `zoneMinutes` (or snake-case alias) off an
    `hr_summary` dict and compute the load. Returns None when no zones are
    present — non-cardio sessions, or cardio sessions with HR data the
    importer couldn't normalize.
    """
    if not isinstance(hr_summary, dict):
        return None
    zones = hr_summary.get("zoneMinutes") or hr_summary.get("zone_minutes")
    if not isinstance(zones, (list, tuple)) or len(zones) < 5:
        return None
    return compute_cardio_load(list(zones))
