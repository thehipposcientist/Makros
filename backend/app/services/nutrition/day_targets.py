"""Per-day nutrition target adaptation.

Plan-level calories come from ``targets.py``. This module does the smaller
daily shuffle: harder training days get a little more carbohydrate, rest/easy
days get a little less, while calories and protein stay effectively stable.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

from app.services.nutrition.carb_distribution import MacroSet, redistribute_for_day


def _get_target(targets: dict, *keys: str) -> int | None:
    for key in keys:
        value = targets.get(key)
        if value is None:
            continue
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            continue
    return None


def adapt_template_targets_for_day(
    template: dict | None,
    *,
    workout_payload: dict | None,
    goal_bucket: str | None,
) -> dict | None:
    """Return a copied nutrition template with day-specific target macros.

    Meal foods/quantities are intentionally left untouched. This preserves the
    generated meal suggestions while making the day's target/scoring reflect
    the actual scheduled demand.
    """
    if not isinstance(template, dict):
        return template
    out = deepcopy(template)
    targets = out.get("targets")
    if not isinstance(targets, dict):
        return out

    base = MacroSet(
        calories=_get_target(targets, "calories") or 0,
        protein_g=_get_target(targets, "protein_g", "protein") or 0,
        carbs_g=_get_target(targets, "carbs_g", "carbs") or 0,
        fat_g=_get_target(targets, "fat_g", "fat") or 0,
    )
    if base.calories <= 0 or base.protein_g <= 0:
        return out

    day: dict[str, Any] = workout_payload if isinstance(workout_payload, dict) else {}
    adjusted, day_type = redistribute_for_day(
        base,
        archetype=day.get("archetype"),
        focus=day.get("focus") or ("Rest" if not day else None),
        activity_category=day.get("activity_category") or ("recovery" if not day else None),
        cardio_style=day.get("cardio_style"),
        stimulus=day.get("stimulus"),
        goal_bucket=goal_bucket,
    )
    adjusted_dict = adjusted.to_dict()
    targets["calories"] = adjusted_dict["calories"]
    targets["protein"] = adjusted_dict["protein_g"]
    targets["carbs"] = adjusted_dict["carbs_g"]
    targets["fat"] = adjusted_dict["fat_g"]
    out["_adaptiveTargets"] = {
        "source": "plan_day",
        "day_type": day_type,
        "base": base.to_dict(),
        "adjusted": adjusted_dict,
    }
    return out
