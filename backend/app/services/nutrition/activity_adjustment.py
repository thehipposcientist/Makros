"""Same-day nutrition adjustments from logged activity.

Wearable calorie estimates are noisy, so this deliberately uses a partial
add-back with goal-aware caps instead of adding every reported calorie to the
meal target. On true heavy / double-session days the cap is widened so the
adjustment can actually keep up with recovery demand.

Two signals can contribute:
  1. Logged workouts → only unplanned workouts, or the excess burn from a
     planned workout that materially exceeds the expected training allowance.
     The base TDEE already includes planned weekly training, so a normal
     scheduled workout should not stack calories on top of the base target.
     When a workout does qualify, the calc consults `activity_category`,
     `cardio_style`, `activity_intensity`, and `stimulus` to pick a factor in
     [0.20, 0.50] (see `_per_completion_factor`).
  2. Same-day HealthKit NEAT excess — active energy that is *above* the
     user's expected baseline AND *not* already explained by logged workouts.
     25% add-back; this lets long walks / active jobs / unlogged activity
     show up the same day instead of waiting for the 7-day rolling signal.

The combined value is then clipped to a goal-aware cap so a noisy wearable
read can never blow the deficit. The heavy-day flag is intensity-aware:
90 min of mobility no longer flips it; you need real glycogen demand.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class ActivityTargetAdjustment:
    adjustment_kcal: int
    workout_adjustment_kcal: int
    neat_adjustment_kcal: int
    exercise_kcal: int
    duration_minutes: int
    workout_count: int
    is_heavy_training_day: bool
    at_cap: bool
    reason: str
    note: str | None
    # Recommended carb / fat split for any *added* calories from the
    # activity adjustment. Tiered to the day's most-demanding session:
    #   - mobility / recovery / casual walks → 0.50 (no glycogen draw)
    #   - Z2 / steady cardio                 → 0.60
    #   - strength / mixed                   → 0.65
    #   - Z4/Z5 intervals / HIIT / sport     → 0.80
    # Callers default to 0.60 (legacy) when there's no activity adj.
    recommended_carb_bias: float = 0.60


# Standard goal caps. Heavy-day caps are derived as a 1.5× multiplier so a
# double session, a >=700 kcal burn, or a >=90 min session can actually feed
# the user without us re-tuning two tables in lockstep.
_GOAL_CAPS: dict[str, int] = {
    "fat_loss": 150,
    "muscle_gain": 350,
    "lean_bulk": 350,
    "strength": 350,
    "endurance": 500,
    "athletic_performance": 500,
    "hyrox": 500,
}
_DEFAULT_GOAL_CAP = 250  # body_recomp / general_health / longevity / maintenance

# Sub-5-minute completions are excluded from the workout add-back. Users
# create test sessions to exercise the share-to-Instagram flow, the watch
# template path, etc., and these short rows previously bumped both the
# calorie and hydration targets like a real session — so deleting them
# read as the app "resetting your goals." 5 min is short enough that any
# real cardio/lift session still counts and long enough to filter the
# accidental tap-through completions. Rows under the threshold remain in
# history; they just don't move the day's targets.
MIN_ACTIVITY_BONUS_DURATION_SECONDS = 300

# The base TDEE activity multiplier already budgets ordinary planned sessions.
# A scheduled workout must clear this allowance before it earns same-day
# calories. Callers with a better estimate can pass
# `planned_workout_kcal_allowance`; otherwise this default suppresses normal
# 45-60 minute training bumps while still feeding unusually demanding days.
DEFAULT_PLANNED_WORKOUT_KCAL_ALLOWANCE = 500
MIN_PLANNED_WORKOUT_KCAL_ALLOWANCE = 400
_PLANNED_CONTEXTS = {"planned", "plan", "generated"}


def _round_to_25(value: float) -> int:
    return int((float(value) / 25.0) + 0.5) * 25


def _cap_for_goal(goal_bucket: str | None, *, is_heavy_day: bool) -> int:
    goal = (goal_bucket or "").lower()
    base = _GOAL_CAPS.get(goal, _DEFAULT_GOAL_CAP)
    if is_heavy_day:
        return int(round(base * 1.5 / 25.0) * 25)
    return base


def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _is_planned_completion(row: Any) -> bool:
    if getattr(row, "plan_day_id", None) is not None:
        return True
    return _norm(getattr(row, "source_context", None)) in _PLANNED_CONTEXTS


def _planned_workout_allowance(
    *,
    planned_workout_kcal_allowance: int | None,
) -> int:
    # Expected active energy is NEAT-baseline math, not a planned-workout burn
    # allowance — so when no explicit allowance is supplied we fall back to the
    # fixed default rather than the day's expected active energy.
    if planned_workout_kcal_allowance is not None:
        explicit = int(round(planned_workout_kcal_allowance))
        if explicit <= 0:
            return 0
        return max(MIN_PLANNED_WORKOUT_KCAL_ALLOWANCE, explicit)
    return DEFAULT_PLANNED_WORKOUT_KCAL_ALLOWANCE


# Activity-type → fraction of logged calories to add back for refueling.
# Higher = more demanding session = bigger same-day refuel. Calibrated so:
#   - mobility / recovery walks: low add-back (minor energy demand, no
#     meaningful glycogen depletion)
#   - Z2 / steady-state cardio: moderate (sustained but fat-adapted)
#   - default lift / hypertrophy: ~0.35 (matches the legacy blanket rate)
#   - Z4/Z5 intervals + HIIT: high (large glycogen draw, real recovery cost)
# The fallback when no metadata is present is 0.35 — it preserves the legacy
# blanket add-back rate so untyped historical / imported rows (completions that
# predate activity classification) behave exactly as they did before.
def _per_completion_factor(row: Any) -> float:
    category = _norm(getattr(row, "activity_category", None))
    cardio_style = _norm(getattr(row, "cardio_style", None))
    intensity = _norm(getattr(row, "activity_intensity", None))
    stimulus = _norm(getattr(row, "stimulus", None))

    # Recovery + mobility — low demand regardless of category framing.
    if category in {"recovery", "mobility"} or stimulus in {"recovery", "mobility"}:
        return 0.20

    if category == "cardio":
        if cardio_style in {"recovery", "easy"}:
            return 0.25
        if cardio_style == "intervals":
            return 0.50
        if intensity == "hard":
            return 0.45
        if intensity == "easy":
            return 0.27
        # steady / class / unspecified — Z2-Z3 territory.
        return 0.32

    if category == "strength":
        if intensity == "hard" or stimulus == "strength":
            return 0.38
        if intensity == "easy":
            return 0.28
        return 0.35

    if category == "sport":
        # Sports are variable but typically glycogen-heavy and mixed-zone.
        return 0.40

    if category == "active":
        # "active" = casual movement / errands / non-training walks.
        return 0.20

    # No metadata — preserve the legacy 35% blanket so untyped rows
    # (older completions, imports without activity_category) behave
    # exactly as they did before this refactor.
    return 0.35


# Tier the carb refeed bias by the most-demanding session of the day.
# Lower carb bias for low-glycogen-demand activity (walks, mobility),
# higher for intervals / sport / conditioning sessions where glycogen
# replenishment is the actual recovery priority. Returns the 4-tier
# integer rank (higher = more glycogen-demanding) alongside the bias.
_CARB_BIAS_BY_TIER: dict[int, float] = {
    0: 0.50,  # mobility / recovery / casual walk
    1: 0.60,  # default / Z2 steady / unspecified
    2: 0.65,  # strength
    3: 0.80,  # intervals / HIIT / sport / conditioning
}


def _row_demand_tier(row: Any) -> int:
    category = _norm(getattr(row, "activity_category", None))
    cardio_style = _norm(getattr(row, "cardio_style", None))
    stimulus = _norm(getattr(row, "stimulus", None))
    if cardio_style == "intervals" or stimulus == "conditioning" or category == "sport":
        return 3
    if category == "strength":
        return 2
    if cardio_style in {"recovery", "easy"}:
        return 0
    if category in {"recovery", "mobility", "active"}:
        return 0
    if stimulus in {"recovery", "mobility"}:
        return 0
    return 1


def _recommended_carb_bias(rows: list) -> float:
    if not rows:
        return _CARB_BIAS_BY_TIER[1]
    top_tier = max(_row_demand_tier(r) for r in rows)
    return _CARB_BIAS_BY_TIER[top_tier]


def _is_demanding(row: Any) -> bool:
    """True when a completion is real glycogen-demanding training. Strict by
    design: unknown / untyped rows do NOT count as demanding, so a long
    unclassified session can't trip the heavy-day flag on its own.
    """
    category = _norm(getattr(row, "activity_category", None))
    cardio_style = _norm(getattr(row, "cardio_style", None))
    intensity = _norm(getattr(row, "activity_intensity", None))
    stimulus = _norm(getattr(row, "stimulus", None))

    if category in {"recovery", "mobility", "active"}:
        return False
    if stimulus in {"recovery", "mobility"}:
        return False
    if category in {"strength", "sport"}:
        return True
    if category == "cardio":
        return cardio_style == "intervals" or intensity == "hard"
    if stimulus in {"conditioning", "strength"}:
        return True
    return False


def _is_heavy(*, rows: list) -> bool:
    """Heavy day = real high-intensity demand, not just lots of low-
    intensity volume. All triggers are measured over demanding rows only,
    so mobility / casual walks / untyped rows can't flip the flag:
      - 2+ demanding sessions
      - ≥700 kcal burned across demanding sessions
      - ≥75 min of demanding-session work
    """
    demanding_rows = [r for r in rows if _is_demanding(r)]
    if len(demanding_rows) >= 2:
        return True
    if not demanding_rows:
        return False

    demanding_kcal = 0
    for row in demanding_rows:
        try:
            demanding_kcal += int(round(float(getattr(row, "calories_burned", 0) or 0)))
        except (TypeError, ValueError):
            pass
    if demanding_kcal >= 700:
        return True

    demanding_seconds = 0
    for row in demanding_rows:
        try:
            demanding_seconds += int(getattr(row, "duration_seconds", 0) or 0)
        except (TypeError, ValueError):
            pass
    return demanding_seconds >= 75 * 60


def _neat_excess_kcal(
    *,
    today_active_energy_kcal: float | None,
    expected_active_energy_kcal: float | None,
    logged_workout_kcal: int,
) -> int:
    """Same-day NEAT add-back, avoiding double-counting workout calories.

    Apple's `active_energy_kcal` already includes workout calories, so we
    subtract `logged_workout_kcal` from the over-baseline excess before
    applying the 25% add-back. That isolates the NEAT portion (long walks,
    active jobs, unlogged movement) and prevents stacking 35% + 25% on the
    same calorie.
    """
    if today_active_energy_kcal is None or expected_active_energy_kcal is None:
        return 0
    excess_total = max(0.0, float(today_active_energy_kcal) - float(expected_active_energy_kcal))
    neat_only = max(0.0, excess_total - float(logged_workout_kcal))
    if neat_only <= 0:
        return 0
    return _round_to_25(neat_only * 0.25)


def _build_note(
    *,
    reason: str,
    adjustment_kcal: int,
    workout_count: int,
    is_heavy_day: bool,
) -> str | None:
    if adjustment_kcal <= 0:
        return None
    if reason == "neat":
        return (
            f"Extra movement today increased your target by ~{adjustment_kcal} kcal."
        )
    if reason == "workout_heavy":
        if workout_count >= 2:
            return (
                f"You logged {workout_count} workouts today. We added ~{adjustment_kcal} kcal "
                "to support performance and recovery without eating back every estimated calorie."
            )
        return (
            f"Heavy training day detected. We added ~{adjustment_kcal} kcal to better support "
            "performance and recovery."
        )
    if reason == "workout_neat":
        return (
            f"Training plus extra movement today added ~{adjustment_kcal} kcal for recovery."
        )
    return (
        f"Training today increased your target by ~{adjustment_kcal} kcal to support recovery."
    )


def compute_activity_target_adjustment(
    completions: Iterable[Any],
    *,
    goal_bucket: str | None,
    same_day_active_energy_kcal: float | None = None,
    same_day_expected_active_energy_kcal: float | None = None,
    planned_workout_kcal_allowance: int | None = None,
) -> ActivityTargetAdjustment:
    """Return a bounded same-day calorie bump from completed workouts + NEAT.

    Planned workouts spend the expected training allowance first because the
    base TDEE already includes planned weekly training. Unplanned sessions and
    planned excess burn get a partial add-back. NEAT add-back (25% of
    over-baseline active energy not already explained by workouts) is layered
    on top when same-day HealthKit data is supplied. Combined value is clipped
    to a goal-aware cap that widens 1.5× on heavy training days.
    """
    # Filter out very-short completions (test sessions, accidental
    # tap-throughs) so they don't move the calorie target. See the
    # MIN_ACTIVITY_BONUS_DURATION_SECONDS docstring for rationale.
    all_rows = list(completions or [])
    rows = []
    for row in all_rows:
        try:
            row_seconds = int(getattr(row, "duration_seconds", 0) or 0)
        except (TypeError, ValueError):
            row_seconds = 0
        if row_seconds >= MIN_ACTIVITY_BONUS_DURATION_SECONDS:
            rows.append(row)

    exercise_kcal = 0
    duration_seconds = 0
    planned_kcal = 0
    planned_weighted_addback_kcal = 0.0
    unplanned_weighted_addback_kcal = 0.0
    for row in rows:
        try:
            kcal = int(round(float(getattr(row, "calories_burned", 0) or 0)))
        except (TypeError, ValueError):
            kcal = 0
        if kcal > 0:
            factor = _per_completion_factor(row)
            exercise_kcal += kcal
            if _is_planned_completion(row):
                planned_kcal += kcal
                planned_weighted_addback_kcal += kcal * factor
            else:
                unplanned_weighted_addback_kcal += kcal * factor
        try:
            duration_seconds += int(getattr(row, "duration_seconds", 0) or 0)
        except (TypeError, ValueError):
            pass

    duration_minutes = round(duration_seconds / 60)
    workout_count = len(rows)
    is_heavy = _is_heavy(rows=rows)

    planned_excess_weighted_addback_kcal = 0.0
    if planned_kcal > 0 and planned_weighted_addback_kcal > 0:
        allowance = _planned_workout_allowance(
            planned_workout_kcal_allowance=planned_workout_kcal_allowance,
        )
        avg_planned_factor = planned_weighted_addback_kcal / planned_kcal
        planned_excess_weighted_addback_kcal = max(
            0.0,
            planned_weighted_addback_kcal - (allowance * avg_planned_factor),
        )

    weighted_addback_kcal = (
        unplanned_weighted_addback_kcal
        + planned_excess_weighted_addback_kcal
    )
    workout_adj = _round_to_25(weighted_addback_kcal) if weighted_addback_kcal > 0 else 0
    neat_adj = _neat_excess_kcal(
        today_active_energy_kcal=same_day_active_energy_kcal,
        expected_active_energy_kcal=same_day_expected_active_energy_kcal,
        logged_workout_kcal=exercise_kcal,
    )
    combined = workout_adj + neat_adj

    cap = _cap_for_goal(goal_bucket, is_heavy_day=is_heavy)
    capped_total = max(0, min(cap, combined))
    at_cap = combined > cap

    # When combined exceeds the cap, clip both components proportionally so
    # downstream callers can still report a coherent breakdown.
    if combined > 0 and combined > cap:
        scale = cap / combined
        workout_capped = int(round((workout_adj * scale) / 25.0) * 25)
        neat_capped = max(0, capped_total - workout_capped)
    else:
        workout_capped = workout_adj
        neat_capped = neat_adj

    if capped_total <= 0:
        reason = "none"
    elif workout_capped > 0 and neat_capped > 0:
        reason = "workout_neat"
    elif workout_capped > 0 and is_heavy:
        reason = "workout_heavy"
    elif workout_capped > 0:
        reason = "workout"
    else:
        reason = "neat"

    note = _build_note(
        reason=reason,
        adjustment_kcal=capped_total,
        workout_count=workout_count,
        is_heavy_day=is_heavy,
    )

    return ActivityTargetAdjustment(
        adjustment_kcal=capped_total,
        workout_adjustment_kcal=workout_capped,
        neat_adjustment_kcal=neat_capped,
        exercise_kcal=exercise_kcal,
        duration_minutes=duration_minutes,
        workout_count=workout_count,
        is_heavy_training_day=is_heavy,
        at_cap=at_cap,
        reason=reason,
        note=note,
        recommended_carb_bias=(
            _recommended_carb_bias(rows)
            if capped_total > 0
            else _CARB_BIAS_BY_TIER[1]
        ),
    )
