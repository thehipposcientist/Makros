"""Same-day nutrition adjustments from logged activity.

Wearable calorie estimates are noisy, so this deliberately uses a partial
add-back with goal-aware caps instead of adding every reported calorie to the
meal target.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class ActivityTargetAdjustment:
    adjustment_kcal: int
    exercise_kcal: int
    duration_minutes: int
    workout_count: int
    at_cap: bool
    note: str | None


def _round_to_25(value: float) -> int:
    return int(round(value / 25.0) * 25)


def _cap_for_goal(goal_bucket: str | None) -> int:
    goal = (goal_bucket or "").lower()
    if goal == "fat_loss":
        return 125
    if goal in {"muscle_gain", "strength", "endurance", "athletic_performance", "hyrox"}:
        return 200
    return 150


def compute_activity_target_adjustment(
    completions: Iterable[Any],
    *,
    goal_bucket: str | None,
) -> ActivityTargetAdjustment:
    """Return a bounded same-day calorie bump from completed workouts.

    The app stores actual workout calories when HealthKit/import/manual data
    supplies them. We use 35% of that signal, rounded to 25 kcal, because the
    base target already includes expected training volume and wrist-based
    energy expenditure is best treated as directional, not exact.
    """
    rows = list(completions or [])
    exercise_kcal = 0
    duration_seconds = 0
    for row in rows:
        try:
            kcal = int(round(float(getattr(row, "calories_burned", 0) or 0)))
        except (TypeError, ValueError):
            kcal = 0
        if kcal > 0:
            exercise_kcal += kcal
        try:
            duration_seconds += int(getattr(row, "duration_seconds", 0) or 0)
        except (TypeError, ValueError):
            pass

    if exercise_kcal <= 0:
        return ActivityTargetAdjustment(
            adjustment_kcal=0,
            exercise_kcal=0,
            duration_minutes=round(duration_seconds / 60),
            workout_count=len(rows),
            at_cap=False,
            note=None,
        )

    raw = exercise_kcal * 0.35
    cap = _cap_for_goal(goal_bucket)
    rounded = _round_to_25(raw)
    adjustment = max(0, min(cap, rounded))
    at_cap = rounded > cap
    note = (
        f"Training today added ~{adjustment} kcal for recovery "
        "without eating back every estimated workout calorie."
        if adjustment > 0 else None
    )
    return ActivityTargetAdjustment(
        adjustment_kcal=adjustment,
        exercise_kcal=exercise_kcal,
        duration_minutes=round(duration_seconds / 60),
        workout_count=len(rows),
        at_cap=at_cap,
        note=note,
    )
