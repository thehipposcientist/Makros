"""Weekly calorie behavior smoothing.

This module adjusts the base daily target from meaningful recent calorie
behavior without treating every missed calorie like debt. Small misses are
absorbed by a per-day deadband, partial logging days are ignored, and same-day
activity refuel remains a separate add-on in the caller.

Target shape:

    final_target_today =
        base_target
        + activity_refuel_today
        + trend_adjustment
        + weekly_behavior_delta

The comparison target for prior days must exclude any previous weekly behavior
delta so the smoothing does not feed back into itself.

Protein target is kept stable. Only carbs and fat absorb the adjustment. The
module is intentionally pure-function so it can be unit-tested without any
database access.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence


_RECOMP_GOALS = {"body_recomp", "maintain", "maintenance"}
_GROWTH_GOALS = {"muscle_gain", "lean_bulk", "strength"}


@dataclass(frozen=True)
class CalorieDay:
    """One prior day used for weekly behavior smoothing.

    ``comparison_target`` should include the base target, same-day activity
    refuel, and trend/coaching adjustment for that historical day. It must not
    include weekly behavior smoothing.
    """

    logged_calories: float
    comparison_target: float
    marked_complete: bool = False


@dataclass(frozen=True)
class WeeklyBehaviorDelta:
    adjustment_applied: int
    over_budget: float
    under_budget: float
    valid_days: int
    at_cap: bool
    note: str


@dataclass
class AdjustedDailyTarget:
    """Result of the weekly behavior calculation.

    ``adjusted_calories`` is the base target plus the weekly behavior delta.
    Same-day activity refuel is intentionally added by the caller so the two
    effects remain explainable separately.
    """

    adjusted_calories: int
    base_daily_target: int
    weekly_budget_remaining: int
    days_remaining: int
    adjustment_applied: int
    at_cap: bool
    note: str
    over_budget: int = 0
    under_budget: int = 0
    valid_days: int = 0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _round_delta(value: float) -> int:
    rounded = int(round(value / 5.0) * 5)
    return 0 if abs(rounded) < 15 else rounded


def is_valid_calorie_day(
    *,
    logged_calories: float,
    comparison_target: float,
    marked_complete: bool = False,
) -> bool:
    """Return True when a prior day is complete enough to influence targets."""

    if comparison_target <= 0:
        return False
    return bool(marked_complete) or logged_calories >= comparison_target * 0.50


def effective_calorie_error(
    *,
    logged_calories: float,
    comparison_target: float,
) -> float:
    """Return calorie error after absorbing normal daily noise."""

    if comparison_target <= 0:
        return 0.0
    daily_error = logged_calories - comparison_target
    deadband = max(100.0, 0.05 * comparison_target)
    if abs(daily_error) <= deadband:
        return 0.0
    if daily_error > 0:
        return daily_error - deadband
    return daily_error + deadband


def _coerce_day(
    day: CalorieDay | Mapping[str, Any],
    base_daily_target: int | None,
) -> CalorieDay | None:
    if isinstance(day, CalorieDay):
        return day

    logged = day.get("logged_calories", day.get("calories"))
    target = day.get("comparison_target", day.get("target", base_daily_target))
    if logged is None or target is None:
        return None

    try:
        logged_calories = float(logged)
        comparison_target = float(target)
    except (TypeError, ValueError):
        return None

    return CalorieDay(
        logged_calories=logged_calories,
        comparison_target=comparison_target,
        marked_complete=bool(day.get("marked_complete", False)),
    )


def _legacy_prior_days(
    *,
    base_daily_target: int,
    calories_logged_so_far: int,
    days_remaining: int,
) -> list[CalorieDay]:
    completed_days = max(0, 7 - max(0, days_remaining))
    if completed_days <= 0:
        return []
    avg_logged = calories_logged_so_far / completed_days
    return [
        CalorieDay(logged_calories=avg_logged, comparison_target=base_daily_target)
        for _ in range(completed_days)
    ]


def compute_weekly_behavior_delta(
    *,
    prior_days: Sequence[CalorieDay | Mapping[str, Any]],
    days_remaining: int,
    goal: str = "general_health",
    base_daily_target: int | None = None,
    allow_fat_loss_under_budget_correction: bool = False,
) -> WeeklyBehaviorDelta:
    """Compute the weekly behavior delta without banking small misses."""

    if days_remaining <= 0:
        return WeeklyBehaviorDelta(
            adjustment_applied=0,
            over_budget=0.0,
            under_budget=0.0,
            valid_days=0,
            at_cap=False,
            note="no days remaining - using base target",
        )

    over_budget = 0.0
    under_budget = 0.0
    valid_days = 0

    for raw_day in prior_days:
        day = _coerce_day(raw_day, base_daily_target)
        if day is None:
            continue
        if not is_valid_calorie_day(
            logged_calories=day.logged_calories,
            comparison_target=day.comparison_target,
            marked_complete=day.marked_complete,
        ):
            continue

        valid_days += 1
        error = effective_calorie_error(
            logged_calories=day.logged_calories,
            comparison_target=day.comparison_target,
        )
        if error > 0:
            over_budget += error
        elif error < 0:
            under_budget += abs(error)

    normalized_goal = (goal or "").lower()

    if normalized_goal == "fat_loss":
        raw_delta = -0.5 * over_budget / days_remaining
        if allow_fat_loss_under_budget_correction:
            raw_delta += min(100.0, 0.25 * under_budget / days_remaining)
        clamped_delta = _clamp(raw_delta, -100.0, 100.0)
    elif normalized_goal in _RECOMP_GOALS:
        raw_delta = (0.25 * under_budget - 0.35 * over_budget) / days_remaining
        clamped_delta = _clamp(raw_delta, -75.0, 75.0)
    elif normalized_goal in _GROWTH_GOALS:
        raw_delta = 0.5 * under_budget / days_remaining
        clamped_delta = _clamp(raw_delta, 0.0, 150.0)
    else:
        raw_delta = (0.20 * under_budget - 0.30 * over_budget) / days_remaining
        clamped_delta = _clamp(raw_delta, -50.0, 50.0)

    at_cap = abs(raw_delta - clamped_delta) > 0.5
    adjustment = _round_delta(clamped_delta)

    if adjustment == 0:
        note = "on target - using base daily target"
    elif adjustment < 0:
        note = f"recent overages - trimming ~{abs(adjustment)} kcal/day for {days_remaining} days"
    else:
        note = f"meaningful under-fueling - adding ~{adjustment} kcal/day for {days_remaining} days"
    if at_cap:
        note += " (adjustment capped per goal)"

    return WeeklyBehaviorDelta(
        adjustment_applied=adjustment,
        over_budget=over_budget,
        under_budget=under_budget,
        valid_days=valid_days,
        at_cap=at_cap,
        note=note,
    )


def compute_adjusted_daily_target(
    *,
    base_daily_target: int,
    calories_logged_so_far: int = 0,
    days_remaining: int,
    goal: str = "general_health",
    prior_days: Sequence[CalorieDay | Mapping[str, Any]] | None = None,
    allow_fat_loss_under_budget_correction: bool = False,
) -> AdjustedDailyTarget:
    """Compute a smoothed daily calorie target for the rest of the week.

    Prefer ``prior_days`` over ``calories_logged_so_far`` so the deadband and
    valid-day filter can be applied per day. The aggregate total remains as a
    compatibility fallback for older callers.
    """

    if days_remaining <= 0:
        return AdjustedDailyTarget(
            adjusted_calories=base_daily_target,
            base_daily_target=base_daily_target,
            weekly_budget_remaining=0,
            days_remaining=0,
            adjustment_applied=0,
            at_cap=False,
            note="no days remaining - using base target",
        )

    behavior_days = list(prior_days) if prior_days is not None else _legacy_prior_days(
        base_daily_target=base_daily_target,
        calories_logged_so_far=calories_logged_so_far,
        days_remaining=days_remaining,
    )
    behavior = compute_weekly_behavior_delta(
        prior_days=behavior_days,
        days_remaining=days_remaining,
        goal=goal,
        base_daily_target=base_daily_target,
        allow_fat_loss_under_budget_correction=allow_fat_loss_under_budget_correction,
    )

    if prior_days is None:
        logged_total = float(calories_logged_so_far)
    else:
        logged_total = 0.0
        for raw_day in behavior_days:
            day = _coerce_day(raw_day, base_daily_target)
            if day is not None:
                logged_total += day.logged_calories
    budget_remaining = (base_daily_target * 7) - logged_total

    adjusted = base_daily_target + behavior.adjustment_applied
    adjusted_rounded = round(adjusted / 5) * 5

    return AdjustedDailyTarget(
        adjusted_calories=adjusted_rounded,
        base_daily_target=base_daily_target,
        weekly_budget_remaining=int(budget_remaining),
        days_remaining=days_remaining,
        adjustment_applied=behavior.adjustment_applied,
        at_cap=behavior.at_cap,
        note=behavior.note,
        over_budget=int(round(behavior.over_budget)),
        under_budget=int(round(behavior.under_budget)),
        valid_days=behavior.valid_days,
    )


def compute_adjusted_macros(
    *,
    base_protein_g: int,
    base_carbs_g: int,
    base_fat_g: int,
    adjusted_calories: int,
    base_calories: int,
    carb_bias_pct: float = 0.60,
    fat_floor_g: int = 30,
    min_carbs_g: int = 40,
) -> dict:
    """Redistribute carbs/fat to hit adjusted_calories while keeping protein stable.

    Protein is always preserved. The calorie delta is split between carbs and
    fat by ``carb_bias_pct`` (default 60% carbs / 40% fat). On heavy / double-
    session training days callers can pass a higher carb bias (e.g. 0.80) so
    the extra calories from the activity adjustment skew toward glycogen
    replenishment instead of fat.

    Fat is floored by caller-provided target metadata when available. The
    default is the legacy absolute 30 g/day floor.

    Returns a dict with keys: protein_g, carbs_g, fat_g, calories.
    """

    delta_kcal = adjusted_calories - base_calories
    if delta_kcal == 0:
        return {"protein_g": base_protein_g, "carbs_g": base_carbs_g,
                "fat_g": base_fat_g, "calories": base_calories}

    bias = max(0.0, min(1.0, float(carb_bias_pct)))
    carb_delta_g = round((delta_kcal * bias) / 4)
    fat_delta_g = round((delta_kcal * (1.0 - bias)) / 9)

    floor = max(30, int(round(fat_floor_g or 30)))
    carb_floor = max(0, int(round(min_carbs_g or 40)))
    new_carbs = max(carb_floor, base_carbs_g + carb_delta_g)
    new_fat = max(floor, base_fat_g + fat_delta_g)

    # If a floor prevented the requested cut/add split, rebalance carbs first
    # so the returned macro calories still match the requested target as
    # closely as integer grams allow.
    current = base_protein_g * 4 + new_carbs * 4 + new_fat * 9
    drift = adjusted_calories - current
    if drift < -5:
        reducible_carbs = max(0, new_carbs - carb_floor)
        carb_reduction = min(reducible_carbs, int(round(abs(drift) / 4.0)))
        new_carbs -= carb_reduction
        current = base_protein_g * 4 + new_carbs * 4 + new_fat * 9
        drift = adjusted_calories - current
    if drift < -5:
        reducible_fat = max(0, new_fat - floor)
        fat_reduction = min(reducible_fat, int(round(abs(drift) / 9.0)))
        new_fat -= fat_reduction
        current = base_protein_g * 4 + new_carbs * 4 + new_fat * 9
        drift = adjusted_calories - current
    if drift > 5:
        new_carbs += int(round(drift / 4.0))

    new_calories = (
        base_protein_g * 4
        + new_carbs * 4
        + new_fat * 9
    )

    return {
        "protein_g": base_protein_g,
        "carbs_g": new_carbs,
        "fat_g": new_fat,
        "calories": new_calories,
    }
