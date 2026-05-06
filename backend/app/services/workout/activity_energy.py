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

    if _norm(category) == "cardio":
        met *= _cardio_style_factor(cardio_style)
    met *= _intensity_factor(intensity)
    met = max(1.5, min(12.0, met))

    weight_kg = float(weight_lbs) / 2.2046226218
    kcal = met * 3.5 * weight_kg / 200.0 * minutes
    if kcal < 10:
        return None
    return int(round(kcal))
