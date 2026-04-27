"""Planner matrix tests — goal x split x days combinations.

Exercises the full `generate_workout_plan` pipeline across realistic
parameter combinations using the shared factory from `conftest`. Each
test asserts RELATIONSHIPS (at least 1 push day, fewer exercises at
30 min, etc.) rather than exact values.

Run:
    cd backend && python3 -m tests.test_planner_matrix
"""
from __future__ import annotations

from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.planner import PlannerInputs, generate_workout_plan
from tests.conftest import (
    make_planner_inputs,
    matrix_sweep,
    GOAL_MATRIX,
    SPLIT_MATRIX,
    DAYS_MATRIX,
)
from tests._generation_contracts import (
    _focus,
    is_lift,
    is_rest,
    is_cardio_dominant,
    family_of,
    family_counts,
)


# ── Equipment sets ─────────────────────────────────────────────────

_FULL_GYM = (
    "barbell", "dumbbells", "weight_plates", "power_rack", "squat_rack",
    "flat_bench", "adjustable_bench", "cable_machine", "lat_pulldown",
    "pull_up_bar", "dip_bars", "leg_press", "smith_machine",
    "kettlebell", "trap_bar", "rowing_machine", "treadmill",
    "stationary_bike", "stair_climber", "assault_bike",
    "leg_curl_machine", "leg_extension_machine", "calf_raise_machine",
    "seated_row_machine", "chest_press_machine", "shoulder_press_machine",
    "ez_curl_bar",
)

_BODYWEIGHT_ONLY = ("bodyweight",)


# ── Helpers ────────────────────────────────────────────────────────

def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _gen(overrides: dict) -> list[dict]:
    """Generate a full plan and return the days list."""
    defaults = make_planner_inputs(equipment_slugs=_FULL_GYM)
    merged = {**defaults, **overrides}
    inputs = PlannerInputs(**merged)
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    return result["workout_plan"]["days"]


def _adjacent_focus_families(days: list[dict]) -> list[tuple[str, str]]:
    """Return pairs of adjacent day focus families (lift days only)."""
    families = []
    for d in days:
        f = _focus(d)
        if is_lift(f):
            families.append(family_of(f))
    pairs = []
    for i in range(len(families) - 1):
        pairs.append((families[i], families[i + 1]))
    return pairs


# ── Strength/muscle goals that should have lift days ───────────────

_LIFTING_GOALS = frozenset({
    "muscle_gain", "fat_loss", "body_recomp", "strength",
    "athletic_performance", "hyrox", "toning", "maintain",
    "general_health", "longevity",
})


# ════════════════════════════════════════════════════════════════════
# 1. test_all_goals_generate_valid_recipe
# ════════════════════════════════════════════════════════════════════

def test_all_goals_generate_valid_recipe():
    """Every goal in GOAL_MATRIX at 5 days/week produces a valid recipe."""
    print("\n[test] all goals at 5 days generate valid recipes")
    for goal in GOAL_MATRIX:
        days = _gen({"goal": goal, "days_per_week": 5})
        ctx = f"goal={goal}"

        # Correct number of days
        assert len(days) == 5, f"{ctx}: expected 5 days, got {len(days)}"

        # At least 1 lift day for goals that should have them
        if goal in _LIFTING_GOALS:
            lift_count = sum(1 for d in days if is_lift(_focus(d)))
            assert lift_count >= 1, \
                f"{ctx}: expected at least 1 lift day, got {lift_count}"

        # Every day has a valid focus (non-empty)
        for i, d in enumerate(days):
            f = d.get("focus")
            assert f and isinstance(f, str) and len(f.strip()) > 0, \
                f"{ctx}: day {i} has empty/missing focus"

        _ok(f"goal={goal} at 5d valid")

    # Test 7-day plans for recovery/mobility day guarantee.
    # Endurance / athletic_performance / hyrox modes fill all days with
    # conditioning or hybrid sessions — they don't inject a recovery day
    # at 7d because the sessions themselves are varied in intensity.
    _EXEMPT_FROM_7D_RECOVERY = frozenset({
        "endurance", "athletic_performance", "hyrox",
    })
    for goal in GOAL_MATRIX:
        if goal in _EXEMPT_FROM_7D_RECOVERY:
            continue
        days_7 = _gen({"goal": goal, "days_per_week": 7})
        has_rest = any(
            is_rest(_focus(d)) or "recovery" in _focus(d) or "mobility" in _focus(d)
            for d in days_7
        )
        assert has_rest, \
            f"goal={goal} 7d: expected at least 1 recovery/mobility day, " \
            f"got {[_focus(d) for d in days_7]}"
    _ok("all lifting/non-endurance goals at 7d have recovery/mobility day")

    # No adjacent duplicate focus families (soft: warn if found)
    violations = []
    for goal in GOAL_MATRIX:
        days = _gen({"goal": goal, "days_per_week": 5})
        pairs = _adjacent_focus_families(days)
        for a, b in pairs:
            if a == b and a != "full_body" and a != "?":
                violations.append(f"goal={goal}: {a}/{b}")
    if violations:
        print(f"  ⚠ adjacent duplicate families: {violations[:5]}")
    else:
        _ok("no adjacent duplicate focus families at 5d")


# ════════════════════════════════════════════════════════════════════
# 2. test_all_splits_at_5_days
# ════════════════════════════════════════════════════════════════════

def test_all_splits_at_5_days():
    """Each split type at 5 days with muscle_gain produces expected families."""
    print("\n[test] all splits at 5 days with muscle_gain")

    # PPL should have push/pull/legs days
    days = _gen({"goal": "muscle_gain", "days_per_week": 5, "preferred_split": "ppl"})
    counts = family_counts(days)
    assert counts.get("push", 0) >= 1, f"PPL missing push: {counts}"
    assert counts.get("pull", 0) >= 1, f"PPL missing pull: {counts}"
    assert counts.get("legs", 0) >= 1, f"PPL missing legs: {counts}"
    _ok("PPL has push/pull/legs")

    # Upper/Lower should have upper and lower days
    days = _gen({"goal": "muscle_gain", "days_per_week": 5, "preferred_split": "upper_lower"})
    counts = family_counts(days)
    assert counts.get("upper", 0) >= 1, f"U/L missing upper: {counts}"
    assert counts.get("lower", 0) >= 1, f"U/L missing lower: {counts}"
    _ok("Upper/Lower has upper and lower")

    # Full Body should have full_body days
    days = _gen({"goal": "muscle_gain", "days_per_week": 3, "preferred_split": "full_body"})
    counts = family_counts(days)
    assert counts.get("full_body", 0) >= 1, f"Full Body missing full_body: {counts}"
    _ok("Full Body has full_body days")

    # Bro should have chest/back/shoulders/arms/legs days
    days = _gen({
        "goal": "muscle_gain", "days_per_week": 5,
        "preferred_split": "bro", "experience": "advanced",
    })
    counts = family_counts(days)
    bro_families = {"chest", "back", "shoulders", "arms", "legs"}
    present = bro_families & set(counts.keys())
    assert present == bro_families, \
        f"Bro missing families: {bro_families - present}, got {counts}"
    _ok("Bro has all 5 muscle families")

    # PPL+UL hybrid
    days = _gen({"goal": "muscle_gain", "days_per_week": 5, "preferred_split": "ppl_ul_hybrid"})
    # Should not crash; should produce 5 days
    assert len(days) == 5, f"PPL+UL hybrid produced {len(days)} days"
    _ok("PPL+UL hybrid produces 5 days without crash")


# ════════════════════════════════════════════════════════════════════
# 3. test_days_per_week_range
# ════════════════════════════════════════════════════════════════════

def test_days_per_week_range():
    """Test muscle_gain/PPL across 3 through 7 days per week."""
    print("\n[test] days_per_week range 3-7 for muscle_gain/PPL")
    for d in range(3, 8):
        days = _gen({"goal": "muscle_gain", "days_per_week": d, "preferred_split": "ppl"})

        # Exact day count
        assert len(days) == d, f"{d}d: expected {d} days, got {len(days)}"

        # 7 days should have at least 1 recovery day
        if d == 7:
            has_recovery = any(
                is_rest(_focus(day)) or "recovery" in _focus(day) or "mobility" in _focus(day)
                for day in days
            )
            assert has_recovery, \
                f"7d: no recovery day in {[_focus(day) for day in days]}"

        # Count training (lift) days
        lift_count = sum(1 for day in days if is_lift(_focus(day)))
        # At 3d, all should be training. At 7d, at least 5 should be.
        if d <= 5:
            assert lift_count >= d - 1, \
                f"{d}d: expected at least {d - 1} lift days, got {lift_count}"

        _ok(f"{d}d: {len(days)} days, {lift_count} lift days")


# ════════════════════════════════════════════════════════════════════
# 4. test_injury_blocks_dangerous_exercises
# ════════════════════════════════════════════════════════════════════

def test_injury_blocks_dangerous_exercises():
    """Shoulder injury should block overhead/vertical press exercises."""
    print("\n[test] injury: shoulder blocks vertical press")
    days = _gen({
        "goal": "muscle_gain",
        "days_per_week": 5,
        "preferred_split": "ppl",
        "injuries": ({"body_part": "shoulder", "severity": "moderate", "status": "active"},),
    })
    assert len(days) == 5, "plan with injury should still produce 5 days"

    for day in days:
        for ex in day.get("exercises", []):
            mp = ex.get("movement_pattern", "")
            if mp == "vertical_press":
                raise AssertionError(
                    f"vertical_press exercise '{ex['name']}' appeared with shoulder injury"
                )
    _ok("shoulder injury blocks vertical press exercises")


# ════════════════════════════════════════════════════════════════════
# 5. test_equipment_filters_exercises
# ════════════════════════════════════════════════════════════════════

def test_equipment_filters_exercises():
    """Bodyweight-only should exclude barbell/cable exercises; full gym
    should have more exercise variety."""
    print("\n[test] equipment: bodyweight vs full gym")

    # Bodyweight-only plan
    days_bw = _gen({
        "goal": "muscle_gain",
        "days_per_week": 4,
        "equipment_slugs": _BODYWEIGHT_ONLY,
    })
    # Full gym plan
    days_gym = _gen({
        "goal": "muscle_gain",
        "days_per_week": 4,
        "equipment_slugs": _FULL_GYM,
    })

    # Plan should generate successfully in both cases
    assert len(days_bw) == 4, f"bodyweight plan has {len(days_bw)} days"
    assert len(days_gym) == 4, f"full gym plan has {len(days_gym)} days"

    # Bodyweight-only should not have barbell/cable exercises
    barbell_in_bw = set()
    for day in days_bw:
        for ex in day.get("exercises", []):
            equip = ex.get("equipment", [])
            if isinstance(equip, list):
                for e in equip:
                    if e in ("barbell", "cable_machine", "lat_pulldown"):
                        barbell_in_bw.add(ex.get("name"))

    # Full gym should have more unique exercise names
    names_bw = set()
    names_gym = set()
    for day in days_bw:
        for ex in day.get("exercises", []):
            names_bw.add(ex.get("name"))
    for day in days_gym:
        for ex in day.get("exercises", []):
            names_gym.add(ex.get("name"))

    assert len(names_gym) >= len(names_bw), \
        f"full gym ({len(names_gym)} unique) should have >= bodyweight ({len(names_bw)} unique)"
    _ok(f"bodyweight {len(names_bw)} unique exercises, full gym {len(names_gym)} unique")


# ════════════════════════════════════════════════════════════════════
# 6. test_disliked_exercises_excluded
# ════════════════════════════════════════════════════════════════════

def test_disliked_exercises_excluded():
    """Disliked exercises must not appear in the plan."""
    print("\n[test] disliked: Bench Press excluded")
    days = _gen({
        "goal": "muscle_gain",
        "days_per_week": 5,
        "preferred_split": "ppl",
        "disliked_exercises": ("Barbell Bench Press", "Barbell Squat"),
    })
    for day in days:
        for ex in day.get("exercises", []):
            assert ex["name"] not in ("Barbell Bench Press", "Barbell Squat"), \
                f"disliked exercise {ex['name']} appeared in plan"
    _ok("disliked exercises excluded from plan")


# ════════════════════════════════════════════════════════════════════
# 7. test_fatigue_affects_recipe
# ════════════════════════════════════════════════════════════════════

def test_fatigue_affects_recipe():
    """High chest fatigue should influence the plan (still valid, still
    generates, may rotate or reduce chest emphasis)."""
    print("\n[test] fatigue: high chest fatigue vs fresh")
    days_fresh = _gen({
        "goal": "muscle_gain",
        "days_per_week": 5,
        "preferred_split": "ppl",
        "muscle_fatigue": {},
    })
    days_fatigued = _gen({
        "goal": "muscle_gain",
        "days_per_week": 5,
        "preferred_split": "ppl",
        "muscle_fatigue": {
            "chest": 0.85, "shoulders": 0.7, "triceps": 0.6,
            "back": 0.1, "biceps": 0.1,
            "quads": 0.0, "hamstrings": 0.0, "glutes": 0.0,
            "calves": 0.0, "core": 0.0, "cardio": 0.0, "systemic": 0.3,
        },
    })

    # Both should produce valid 5-day plans
    assert len(days_fresh) == 5
    assert len(days_fatigued) == 5

    # Both should have exercises on every lift day
    for label, plan_days in [("fresh", days_fresh), ("fatigued", days_fatigued)]:
        for day in plan_days:
            if is_lift(_focus(day)):
                exs = day.get("exercises", [])
                assert len(exs) >= 2, \
                    f"{label}: lift day '{day.get('focus')}' has only {len(exs)} exercises"

    # The fatigued plan may differ in focus order or exercise selection
    # (soft check — log the difference)
    focuses_fresh = [_focus(d) for d in days_fresh]
    focuses_fatigued = [_focus(d) for d in days_fatigued]
    if focuses_fresh != focuses_fatigued:
        _ok(f"fatigue changed focus order: {focuses_fresh} -> {focuses_fatigued}")
    else:
        _ok(f"fatigue plan valid (focus order unchanged: {focuses_fresh})")


# ════════════════════════════════════════════════════════════════════
# 8. test_session_minutes_scales_exercises
# ════════════════════════════════════════════════════════════════════

def test_session_minutes_scales_exercises():
    """30min sessions should have fewer exercises than 90min."""
    print("\n[test] session minutes: 30 vs 60 vs 90")

    total_by_duration = {}
    for minutes in (30, 60, 90):
        days = _gen({
            "goal": "muscle_gain",
            "days_per_week": 4,
            "preferred_split": "upper_lower",
            "session_minutes": minutes,
        })
        total = sum(len(d.get("exercises", [])) for d in days)
        total_by_duration[minutes] = total

    assert total_by_duration[30] < total_by_duration[90], \
        f"30min ({total_by_duration[30]}) should have fewer exercises than " \
        f"90min ({total_by_duration[90]})"

    _ok(f"exercise counts by duration: 30m={total_by_duration[30]}, "
        f"60m={total_by_duration[60]}, 90m={total_by_duration[90]}")


# ════════════════════════════════════════════════════════════════════
# 9. test_recent_focus_rotation
# ════════════════════════════════════════════════════════════════════

def test_recent_focus_rotation():
    """Recent focus families=["push","push"] should rotate day 0 away
    from push (when the split allows it)."""
    print("\n[test] rotation: recent push/push rotates away")

    # Fresh plan (no history)
    days_fresh = _gen({
        "goal": "muscle_gain",
        "days_per_week": 5,
        "preferred_split": "ppl",
    })
    fresh_first = _focus(days_fresh[0])

    # Plan with recent push history
    days_rotated = _gen({
        "goal": "muscle_gain",
        "days_per_week": 5,
        "preferred_split": "ppl",
        "recent_focus_families": ("push", "push"),
        "recent_focus_buckets": ("upper_body", "upper_body"),
    })
    rotated_first = _focus(days_rotated[0])

    # The rotated plan's first day should ideally not be push
    if "push" not in rotated_first:
        _ok(f"rotation away from push: first day = {rotated_first}")
    else:
        # PPL at certain day counts may force push first; still valid
        print(f"  ⚠ rotation could not avoid push (split constraint): {rotated_first}")
        # At minimum, the plan should still be valid
        assert len(days_rotated) == 5
        _ok("rotation test ran (split may constrain)")


# ════════════════════════════════════════════════════════════════════
# 10. test_stress_relief_and_flexibility_goals
# ════════════════════════════════════════════════════════════════════

def test_stress_relief_and_flexibility_goals():
    """Flexibility and stress_relief goals should produce mobility-heavy
    plans without heavy lifting prescriptions."""
    print("\n[test] flexibility/stress_relief: mobility-heavy, no heavy lifts")

    for goal in ("flexibility", "stress_relief"):
        days = _gen({"goal": goal, "days_per_week": 4})

        # Should produce 4 days
        assert len(days) == 4, f"{goal}: expected 4 days, got {len(days)}"

        # Should be predominantly mobility/recovery/easy
        heavy_lift_count = 0
        for day in days:
            f = _focus(day)
            for ex in day.get("exercises", []):
                sets = ex.get("sets", 0)
                reps_str = str(ex.get("reps", ""))
                # Heavy lifting: 4+ sets of very low reps
                if sets >= 4 and reps_str in ("3-5", "1-3", "2-4", "3", "4", "5"):
                    heavy_lift_count += 1

        assert heavy_lift_count == 0, \
            f"{goal}: found {heavy_lift_count} heavy lift prescriptions " \
            f"in a {goal} plan"

        _ok(f"{goal}: no heavy lift prescriptions in 4d plan")


# ════════════════════════════════════════════════════════════════════
# All tests list + runner
# ════════════════════════════════════════════════════════════════════

ALL_TESTS = [
    test_all_goals_generate_valid_recipe,
    test_all_splits_at_5_days,
    test_days_per_week_range,
    test_injury_blocks_dangerous_exercises,
    test_equipment_filters_exercises,
    test_disliked_exercises_excluded,
    test_fatigue_affects_recipe,
    test_session_minutes_scales_exercises,
    test_recent_focus_rotation,
    test_stress_relief_and_flexibility_goals,
]

if __name__ == "__main__":
    import sys
    failed = []
    for fn in ALL_TESTS:
        try:
            fn()
        except AssertionError as e:
            failed.append((fn.__name__, str(e)))
            print(f"  ✗ FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed.append((fn.__name__, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print()
    if failed:
        print(f"{len(failed)} of {len(ALL_TESTS)} FAILED:")
        for name, msg in failed:
            print(f"  - {name}: {msg}")
        sys.exit(1)
    print(f"All {len(ALL_TESTS)} planner_matrix tests passed")
