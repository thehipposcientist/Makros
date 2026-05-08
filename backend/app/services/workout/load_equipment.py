"""Strength-equipment loading constraints.

The planner can know a user owns "dumbbells" or a "barbell", but load
recommendations also need to know what weights are actually loadable:
adjustable dumbbell range/step, bar weight, and available plate sizes.
All helpers are deterministic and no-op when settings are missing.
"""
from __future__ import annotations

from math import floor
from typing import Any


def _get_any(source: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in source:
            return source.get(key)
    return None


def _as_float(value: Any, default: float | None = None) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def _as_float_list(value: Any) -> list[float]:
    if not isinstance(value, list):
        return []
    out: list[float] = []
    for item in value:
        parsed = _as_float(item)
        if parsed is not None:
            out.append(parsed)
    return sorted(set(out), reverse=True)


def _equipment_text(equipment: str | None) -> str:
    return (equipment or "").lower().replace("-", " ").replace("_", " ")


def _practical_fallback_increment(equipment: str | None, fallback: float) -> float:
    """Default load grid when the user has not configured exact gear.

    A 2.5 lb calculation is mathematically tidy, but most users cannot
    select "23 lb" or "58 lb" in the gym. Until we know their actual
    adjustable dumbbell/plate setup, keep recommendations on whole 5 lb
    jumps.
    """
    safe_fallback = max(1.0, fallback)
    if any(token in _equipment_text(equipment) for token in ("bodyweight", "none", "bw")):
        return safe_fallback
    return max(5.0, safe_fallback)


def _round_to_increment(weight: float, increment: float) -> float:
    if increment <= 0:
        return round(weight, 1)
    return round(floor(weight / increment + 0.5) * increment, 1)


def _settings(settings: dict | None) -> dict[str, Any]:
    return settings if isinstance(settings, dict) else {}


def _dumbbell_settings(settings: dict | None) -> dict[str, Any]:
    raw = _settings(settings).get("dumbbells")
    return raw if isinstance(raw, dict) else {}


def _barbell_settings(settings: dict | None) -> dict[str, Any]:
    raw = _settings(settings).get("barbell")
    return raw if isinstance(raw, dict) else {}


def is_dumbbell_equipment(equipment: str | None) -> bool:
    text = _equipment_text(equipment)
    return "dumbbell" in text


def is_barbell_equipment(equipment: str | None) -> bool:
    text = _equipment_text(equipment)
    return any(token in text for token in ("barbell", "ez curl", "trap bar", "smith", "landmine", "plate loaded", "weight plates"))


def load_increment_lbs(
    equipment: str | None,
    settings: dict | None,
    *,
    fallback: float,
) -> float:
    """Smallest practical load jump for this exercise.

    Missing settings intentionally preserve existing behavior. When the
    user configured plates or adjustable dumbbells, we use the smallest
    loadable jump instead of pretending 2.5/5 lb is always possible.
    """
    safe_fallback = _practical_fallback_increment(equipment, fallback)
    if is_dumbbell_equipment(equipment):
        db = _dumbbell_settings(settings)
        increment = _as_float(_get_any(db, "incrementLbs", "increment_lbs", "stepLbs", "step_lbs"))
        if increment is not None:
            return increment
        if str(_get_any(db, "type", "kind") or "").lower() == "adjustable":
            return 2.5
        return safe_fallback

    if is_barbell_equipment(equipment):
        bb = _barbell_settings(settings)
        plates = _as_float_list(_get_any(bb, "platePairsLbs", "plate_pairs_lbs", "platesLbs", "plates_lbs"))
        if plates:
            return max(1.0, min(plates) * 2.0)
    return safe_fallback


def snap_load_lbs(
    weight_lbs: float | None,
    equipment: str | None,
    settings: dict | None,
    *,
    fallback_increment: float,
) -> float | None:
    """Snap a recommended load to what the user can actually set up.

    Configured gear rounds down to the nearest loadable value after
    clamping to min/max. Missing settings use a practical fallback grid
    so generic recommendations stay selectable in a normal gym.
    """
    weight = _as_float(weight_lbs)
    if weight is None:
        return weight_lbs

    if is_dumbbell_equipment(equipment):
        db = _dumbbell_settings(settings)
        if not db:
            return _round_to_increment(
                weight,
                _practical_fallback_increment(equipment, fallback_increment),
            )
        increment = load_increment_lbs(equipment, settings, fallback=fallback_increment)
        min_lbs = _as_float(_get_any(db, "minLbs", "min_lbs"), 0.0) or 0.0
        max_lbs = _as_float(_get_any(db, "maxLbs", "max_lbs"))
        snapped = min_lbs + floor(max(0.0, weight - min_lbs) / increment) * increment
        if max_lbs is not None:
            snapped = min(snapped, max_lbs)
        if snapped <= 0 and min_lbs > 0:
            snapped = min_lbs
        return round(snapped, 1)

    if is_barbell_equipment(equipment):
        bb = _barbell_settings(settings)
        plates = _as_float_list(_get_any(bb, "platePairsLbs", "plate_pairs_lbs", "platesLbs", "plates_lbs"))
        if plates:
            bar_lbs = _as_float(_get_any(bb, "barWeightLbs", "bar_weight_lbs"), 45.0) or 45.0
            max_load = _as_float(_get_any(bb, "maxLoadLbs", "max_load_lbs"))
            increment = max(1.0, min(plates) * 2.0)
            if max_load is not None:
                weight = min(weight, max_load)
            if weight <= bar_lbs:
                return round(bar_lbs, 1)
            snapped = bar_lbs + floor((weight - bar_lbs) / increment) * increment
            return round(max(bar_lbs, snapped), 1)

    return _round_to_increment(
        weight,
        _practical_fallback_increment(equipment, fallback_increment),
    )
