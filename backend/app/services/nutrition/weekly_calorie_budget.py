"""Weekly calorie budget smoothing.

When a user goes over or under their daily calorie target, this module
redistributes the difference across the remaining days of the week instead
of creating a harsh single-day correction the next day.

Formula
-------
    weekly_budget_remaining = weekly_target - calories_logged_so_far
    adjusted_daily_target   = weekly_budget_remaining / days_remaining

Caps by goal (applied symmetrically — prevents extreme swings):

    fat_loss      : ±150–200 kcal/day max adjustment
    body_recomp   : ±100–150 kcal/day max adjustment
    muscle_gain   : no downward cut (only upward smoothing for under-eating)
    strength      : no aggressive cuts (same as muscle_gain)
    other goals   : ±100 kcal/day gentle smoothing

Protein target is kept stable — only carbs and fat absorb the adjustment.
The module is intentionally pure-function so it can be unit-tested without
any database access.
"""
from __future__ import annotations

from dataclasses import dataclass


# ─── Per-goal caps ────────────────────────────────────────────────────────────

# (max_down, max_up) in kcal/day — how much we allow the adjustment to push
# the day's target below or above the base daily target.
_GOAL_CAPS: dict[str, tuple[int, int]] = {
    "fat_loss":            (200, 150),   # allow up to 200 down, 150 up
    "body_recomp":         (150, 100),
    "muscle_gain":         (0,   200),   # never cut; allow extra upward
    "strength":            (0,   200),   # never cut; allow extra upward
    "endurance":           (100, 150),
    "athletic_performance":(100, 150),
    "hyrox":               (100, 150),
    "toning":              (150, 100),
    "general_health":      (100, 100),
    "longevity":           (100, 100),
    "maintain":            (75,  75),
    "flexibility":         (75,  75),
    "stress_relief":       (75,  75),
}

_DEFAULT_CAPS = (100, 100)


def _caps_for_goal(goal: str) -> tuple[int, int]:
    return _GOAL_CAPS.get(goal, _DEFAULT_CAPS)


# ─── Output type ─────────────────────────────────────────────────────────────

@dataclass
class AdjustedDailyTarget:
    """Result of the weekly smoothing calculation.

    ``adjusted_calories`` is the target for today (and each remaining day
    if smoothed evenly — callers may choose to apply it only to today and
    recalculate daily).
    ``adjustment_applied`` is the signed delta from the base daily target.
    ``at_cap`` is True when the raw adjustment was clipped by the goal cap.
    ``days_remaining`` includes today.
    """
    adjusted_calories: int
    base_daily_target: int
    weekly_budget_remaining: int
    days_remaining: int
    adjustment_applied: int   # signed: negative = cut, positive = add
    at_cap: bool              # True when the goal cap clipped the raw delta
    note: str                 # human-readable explanation


# ─── Pure computation ─────────────────────────────────────────────────────────

def compute_adjusted_daily_target(
    *,
    base_daily_target: int,
    calories_logged_so_far: int,
    days_remaining: int,
    goal: str = "general_health",
) -> AdjustedDailyTarget:
    """Compute a smoothed daily calorie target for the rest of the week.

    Args:
        base_daily_target       Per-day target from CalorieTargets (e.g. 2000).
        calories_logged_so_far  Sum of calories already logged this week.
        days_remaining          How many days are left INCLUDING today.
                                Caller passes (7 - weekday_index) so Monday=7,
                                Sunday=1.
        goal                    User's goal_id — determines how aggressively
                                we allow the adjustment to deviate from the
                                base target.

    Returns:
        AdjustedDailyTarget with adjusted_calories rounded to the nearest 5.
    """
    if days_remaining <= 0:
        return AdjustedDailyTarget(
            adjusted_calories=base_daily_target,
            base_daily_target=base_daily_target,
            weekly_budget_remaining=0,
            days_remaining=0,
            adjustment_applied=0,
            at_cap=False,
            note="no days remaining — using base target",
        )

    weekly_target = base_daily_target * 7
    budget_remaining = weekly_target - calories_logged_so_far

    # Raw adjusted target: how many calories per remaining day to hit the budget
    raw_adjusted = budget_remaining / days_remaining
    raw_delta    = raw_adjusted - base_daily_target  # negative = cut, positive = surplus

    # Apply goal cap
    max_down, max_up = _caps_for_goal(goal)
    clamped_delta = max(-max_down, min(max_up, raw_delta))
    at_cap = abs(clamped_delta - raw_delta) > 0.5  # clipped if delta moved significantly

    adjusted = base_daily_target + clamped_delta
    # Round to nearest 5 to avoid confusing targets like 1987 kcal
    adjusted_rounded = round(adjusted / 5) * 5

    if abs(clamped_delta) < 15:
        note = "on target — using base daily target"
    elif clamped_delta < 0:
        note = f"slightly over budget — cutting ~{abs(int(clamped_delta))} kcal/day for {days_remaining} days"
    else:
        note = f"under budget — adding ~{int(clamped_delta)} kcal/day for {days_remaining} days"
    if at_cap:
        note += " (adjustment capped per goal)"

    return AdjustedDailyTarget(
        adjusted_calories=adjusted_rounded,
        base_daily_target=base_daily_target,
        weekly_budget_remaining=int(budget_remaining),
        days_remaining=days_remaining,
        adjustment_applied=int(clamped_delta),
        at_cap=at_cap,
        note=note,
    )


def compute_adjusted_macros(
    *,
    base_protein_g: int,
    base_carbs_g: int,
    base_fat_g: int,
    adjusted_calories: int,
    base_calories: int,
) -> dict:
    """Redistribute carbs/fat to hit adjusted_calories while keeping protein stable.

    Protein is always preserved. The calorie delta is split 60/40 carbs/fat.
    Fat is floored at 0.3 g/lb×body_weight but since we don't have bodyweight
    here, we use an absolute floor of 30 g/day as a safe minimum.

    Returns a dict with keys: protein_g, carbs_g, fat_g, calories.
    """
    delta_kcal = adjusted_calories - base_calories
    if delta_kcal == 0:
        return {"protein_g": base_protein_g, "carbs_g": base_carbs_g,
                "fat_g": base_fat_g, "calories": base_calories}

    # Split delta: 60% carbs (4 kcal/g), 40% fat (9 kcal/g)
    carb_delta_g = round((delta_kcal * 0.60) / 4)
    fat_delta_g  = round((delta_kcal * 0.40) / 9)

    new_carbs = max(40, base_carbs_g + carb_delta_g)   # 40 g floor
    new_fat   = max(30, base_fat_g   + fat_delta_g)    # 30 g absolute floor

    # Recompute calories from adjusted macros
    new_calories = (
        base_protein_g * 4
        + new_carbs    * 4
        + new_fat      * 9
    )

    return {
        "protein_g":  base_protein_g,
        "carbs_g":    new_carbs,
        "fat_g":      new_fat,
        "calories":   new_calories,
    }
