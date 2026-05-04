"""Tests for plan generation respecting the user's session-minutes budget.

The user's `workoutDurationMinutes` is the contract — the planner should
fill (close to) that budget without going far under or grossly over.
Underfill is the bug we just fixed in `density_adjust_slots` (rec template
+ accessory backfill should expand to use available time on long sessions).

Uses real `SEED_EXERCISES` so test plans look like production output.
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _approx_minutes_for_day(day: dict) -> float:
    """Walk a generated day's exercises, sum estimated minutes.

    Mirrors the plan-card estimate: time-based exercises use their
    second/minute target, strength sets use realistic working time,
    and rest/transition slack is included.
    """
    import re

    total_seconds = 0.0
    exercises = day.get("exercises", [])
    for idx, ex in enumerate(exercises):
        sets = int(ex.get("sets", 0) or 0)
        reps = str(ex.get("reps", "") or "")
        rest = int(ex.get("rest_seconds", ex.get("restSeconds", 60)) or 60)
        reps_lower = reps.lower().strip()
        work_seconds: float | None = None
        sec_match = re.match(r"^(\d+)(?:\s*-\s*(\d+))?\s*(s|sec|secs|second|seconds)\b", reps_lower)
        if sec_match:
            lo = int(sec_match.group(1))
            hi = int(sec_match.group(2) or lo)
            work_seconds = (lo + hi) / 2
            if "each" in reps_lower:
                work_seconds *= 2
        else:
            # Bare "m" is meters in loaded-carry prescriptions
            # ("30-40m or 40-60s"), not minutes.
            min_match = re.match(r"^(\d+)(?:\s*-\s*(\d+))?\s*(min|mins|minute|minutes)\b", reps_lower)
            if min_match:
                lo = int(min_match.group(1))
                hi = int(min_match.group(2) or lo)
                work_seconds = ((lo + hi) / 2) * 60
            elif "each" in reps_lower:
                rep_match = re.match(r"^(\d+)", reps_lower)
                if rep_match:
                    work_seconds = int(rep_match.group(1)) * 20

        if work_seconds is None:
            work_seconds = 55

        role = str(ex.get("_role") or ex.get("slot_role") or "").lower()
        primary = str(ex.get("_primary_muscle") or ex.get("primary_muscle") or "").lower()
        training_type = str(ex.get("_training_type") or ex.get("training_type") or "").lower()
        is_mobility = (
            role == "warmup"
            or primary == "mobility"
            or training_type in {"mobility", "recovery", "stretch"}
            or re.search(r"mobility|stretch|warm.?up|flow|pose|dog|cat|hip|shoulder.dis|dead hang", str(ex.get("name", "")), re.I)
        )
        transition = 0 if idx == len(exercises) - 1 else (15 if is_mobility else 45)
        total_seconds += sets * work_seconds + (rest * max(0, sets - 1) * 1.10) + transition
    return total_seconds / 60


def _build_inputs(session_minutes: int, days_per_week: int = 4):
    from app.services.workout.planner import PlannerInputs
    return PlannerInputs(
        goal="muscle_gain",
        days_per_week=days_per_week,
        session_minutes=session_minutes,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbell", "cable", "pullup_bar", "bench", "squat_rack"),
        rng_seed=42,
    )


# ─── Underfill regression — long sessions get filled close to budget ────

def test_60min_session_uses_at_least_40min():
    """A 60-min lift session should land in the 40-75 min range. Anything
    far under means the planner is leaving the user with idle time."""
    print("\n[test] 60-min budget produces ≥40 min of work per lift day")
    from app.services.workout.planner import generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    plan = generate_workout_plan(_build_inputs(60), SEED_EXERCISES)
    lift_days = [d for d in plan["workout_plan"]["days"] if d.get("category") == "lift"]
    assert lift_days, "no lift days generated"
    for d in lift_days:
        mins = _approx_minutes_for_day(d)
        assert 40 <= mins <= 75, (
            f"day '{d.get('focus')}' got {mins:.1f} min for a 60-min budget"
        )
    _ok(f"60-min plan: lift days {[round(_approx_minutes_for_day(d)) for d in lift_days]}")


def test_90min_session_fills_more_than_60min():
    """The fix to density_adjust_slots should make a 90-min plan
    measurably longer per day than a 60-min plan, not the same."""
    print("\n[test] 90-min budget produces longer days than 60-min")
    from app.services.workout.planner import generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    plan_60 = generate_workout_plan(_build_inputs(60), SEED_EXERCISES)
    plan_90 = generate_workout_plan(_build_inputs(90), SEED_EXERCISES)

    def avg_minutes(plan):
        days = [d for d in plan["workout_plan"]["days"] if d.get("category") == "lift"]
        return sum(_approx_minutes_for_day(d) for d in days) / max(len(days), 1)

    avg_60 = avg_minutes(plan_60)
    avg_90 = avg_minutes(plan_90)
    for d in [d for d in plan_90["workout_plan"]["days"] if d.get("category") == "lift"]:
        mins = _approx_minutes_for_day(d)
        assert mins >= 65, (
            f"day '{d.get('focus')}' got {mins:.1f} min for a 90-min budget"
        )
    assert avg_90 > avg_60 + 5, (
        f"90-min plan (avg {avg_90:.1f}) should be at least 5 min longer "
        f"than 60-min plan (avg {avg_60:.1f}); got delta {avg_90 - avg_60:.1f}"
    )
    _ok(f"60-min avg {avg_60:.1f} → 90-min avg {avg_90:.1f}")


def test_30min_session_stays_short():
    """The trim path still has to work — short budgets shouldn't blow
    past 45 min just because the recipe template is full-length."""
    print("\n[test] 30-min budget stays under 50 min per lift day")
    from app.services.workout.planner import generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    plan = generate_workout_plan(_build_inputs(30), SEED_EXERCISES)
    lift_days = [d for d in plan["workout_plan"]["days"] if d.get("category") == "lift"]
    assert lift_days, "no lift days generated"
    for d in lift_days:
        mins = _approx_minutes_for_day(d)
        assert mins <= 50, (
            f"day '{d.get('focus')}' got {mins:.1f} min for a 30-min budget — trim failed"
        )
    _ok(f"30-min plan: lift days {[round(_approx_minutes_for_day(d)) for d in lift_days]}")


def test_recovery_day_fills_time_with_smaller_exercises():
    """The `_pick_exercises_for_time` two-pass fix: a recovery day with
    a long-exercise-first pool should still keep adding smaller items
    from the back of the pool, not break early."""
    print("\n[test] recovery day uses the budget instead of stopping early")
    from app.services.workout.planner import generate_recovery_day
    day = generate_recovery_day(session_minutes=45)
    mins = _approx_minutes_for_day(day)
    # Recovery moves are short (most ≤4 min), so a 45-min budget should
    # comfortably reach 30+ min of programmed work.
    assert mins >= 25, f"recovery day got only {mins:.1f} min for a 45-min budget"
    assert mins <= 55, f"recovery day overshot to {mins:.1f} min"
    _ok(f"45-min recovery day: {mins:.1f} min programmed")


def test_mobility_day_fills_time():
    """Same fix applies to mobility days — they should fill the budget."""
    print("\n[test] mobility day uses the budget")
    from app.services.workout.planner import generate_mobility_day
    day = generate_mobility_day(session_minutes=60)
    mins = _approx_minutes_for_day(day)
    assert mins >= 35, f"mobility day got only {mins:.1f} min for a 60-min budget"
    _ok(f"60-min mobility day: {mins:.1f} min programmed")


# ─── Cross-budget consistency ────────────────────────────────────────────

def test_exercise_count_scales_monotonically_with_budget():
    """45 → 60 → 75 → 90 minute budgets should produce non-decreasing
    exercise counts. Catches regressions where a budget bump fails to
    add a slot."""
    print("\n[test] exercise count is monotonic in session_minutes")
    from app.services.workout.planner import generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    counts = []
    for budget in [45, 60, 75, 90]:
        plan = generate_workout_plan(_build_inputs(budget), SEED_EXERCISES)
        lift_days = [d for d in plan["workout_plan"]["days"] if d.get("category") == "lift"]
        total = sum(len(d.get("exercises", [])) for d in lift_days)
        counts.append((budget, total))

    for i in range(1, len(counts)):
        prev_budget, prev_total = counts[i - 1]
        cur_budget, cur_total = counts[i]
        assert cur_total >= prev_total, (
            f"{cur_budget}-min plan has fewer exercises ({cur_total}) "
            f"than {prev_budget}-min plan ({prev_total})"
        )
    _ok(f"counts by budget: {counts}")


def test_duration_estimate_treats_loaded_carry_m_as_meters():
    """Loaded carries use `m` for meters, so they must not inflate the
    plan-card estimate as if 30-40m meant 30-40 minutes."""
    print("\n[test] duration estimate treats loaded-carry m as meters")
    day = {
        "exercises": [
            {
                "name": "Suitcase Carry",
                "sets": 3,
                "reps": "30-40m or 40-60s",
                "rest_seconds": 60,
                "slot_role": "core",
                "primary_muscle": "core",
            }
        ]
    }
    mins = _approx_minutes_for_day(day)
    assert mins < 8, f"carry estimate should be seconds-scale, got {mins:.1f} min"
    _ok(f"loaded carry estimate: {mins:.1f} min")
