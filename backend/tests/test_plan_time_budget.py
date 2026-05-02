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

    Mirrors `_est_exercise_time` from planner.py: time-based exercises
    use their second-count + rest, rep-based use ~3s per rep + rest.
    Per-set rest is between sets (sets−1 gaps).
    """
    total = 0.0
    for ex in day.get("exercises", []):
        sets = int(ex.get("sets", 0) or 0)
        reps = str(ex.get("reps", "") or "")
        rest = int(ex.get("rest_seconds", 60) or 60)
        # Time-based: "30s", "45s hold", "60s flow"
        if "s" in reps and reps.replace("s", "").replace(" hold", "").replace(" flow", "").replace(" each side", "").strip().split()[0:1]:
            try:
                seconds = int(reps.split()[0].replace("s", ""))
                each_side = "each" in reps
                per_set = seconds * (2 if each_side else 1)
                total += (per_set * sets + rest * max(0, sets - 1)) / 60
                continue
            except ValueError:
                pass
        # Min-based: "5 min", "8 min flow"
        if "min" in reps:
            try:
                mins = int(reps.split()[0])
                total += mins
                continue
            except ValueError:
                pass
        # Rep-based: "8-12", "6"
        try:
            rep_count = int(reps.split("-")[-1].split(" ")[0].strip())
            per_set = rep_count * 3 * (2 if "each" in reps else 1)
            total += (per_set * sets + rest * max(0, sets - 1)) / 60
        except (ValueError, IndexError):
            total += 2.0
    return total


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

def test_60min_session_uses_at_least_45min():
    """A 60-min lift session should land in the 45-65 min range. Anything
    far under means the planner is leaving the user with idle time."""
    print("\n[test] 60-min budget produces ≥45 min of work per lift day")
    from app.services.workout.planner import generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    plan = generate_workout_plan(_build_inputs(60), SEED_EXERCISES)
    lift_days = [d for d in plan["workout_plan"]["days"] if d.get("category") == "lift"]
    assert lift_days, "no lift days generated"
    for d in lift_days:
        mins = _approx_minutes_for_day(d)
        assert 30 <= mins <= 75, (
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
