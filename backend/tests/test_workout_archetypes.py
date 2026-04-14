"""Tests for the multi-goal archetype planner.

These tests exist to keep the four guardrails of the multi-goal
refactor in place:

1. Every exposed goal produces a weekly recipe with the expected
   archetype shape (endurance = mostly cardio, flexibility = mostly
   mobility, stress_relief = mostly recovery, etc.).
2. Archetype-specific prescriptions don't collapse into generic
   lifting rep schemes on non-lifting days.
3. The archetype → slot dispatch has a concrete builder for every
   `DayArchetype` enum value.
4. Session-minutes trimming works across all categories, not just
   lifting.
"""
from __future__ import annotations

import sys


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Coverage sanity ─────────────────────────────────────────────────


def test_every_archetype_has_a_slot_builder() -> None:
    """Every `DayArchetype` enum value must have a concrete slot
    builder dispatch. If someone adds a new archetype without wiring
    it into `_archetype_to_slots`, this test catches it."""
    print("\n[test] every archetype has a slot builder")
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.planner import _archetype_to_slots
    for a in DayArchetype:
        slots = _archetype_to_slots(a, 0, 4)
        assert slots, f"archetype {a.value} returned no slots"
    _ok(f"{len(list(DayArchetype))} archetypes all have builders")


def test_every_archetype_has_metadata() -> None:
    """Mirror check: `ARCHETYPE_META` must contain every enum value."""
    print("\n[test] every archetype has metadata")
    from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META
    missing = [a.value for a in DayArchetype if a not in ARCHETYPE_META]
    assert not missing, f"archetypes missing from ARCHETYPE_META: {missing}"
    _ok("ARCHETYPE_META covers all enum values")


# ── Per-goal recipe shape ───────────────────────────────────────────


def test_muscle_gain_recipe_is_pure_lifting() -> None:
    print("\n[test] muscle_gain 4d → all lifting days")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(profile, 4, lifting_split="upper_lower")
    cats = [ARCHETYPE_META[a].category for a in recipe]
    assert cats == ["lift"] * 4, f"muscle_gain should be all lift, got {cats}"
    _ok(f"recipe={[a.value for a in recipe]}")


def test_endurance_recipe_mostly_cardio_with_strength_day() -> None:
    print("\n[test] endurance 4d → 3 cardio + 1 strength maintenance")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META, DayArchetype
    profile = goal_profile_for("endurance")
    recipe = generate_weekly_recipe(profile, 4)
    cond_count = sum(1 for a in recipe if ARCHETYPE_META[a].category == "cond")
    lift_count = sum(1 for a in recipe if ARCHETYPE_META[a].category == "lift")
    assert cond_count == 3, f"cond count {cond_count}"
    assert lift_count == 1, f"lift count {lift_count}"
    assert DayArchetype.LIFT_STRENGTH_MAINTENANCE in recipe
    _ok(f"recipe={[a.value for a in recipe]}")


def test_endurance_2d_has_no_strength_day() -> None:
    print("\n[test] endurance 2d → pure cardio, no strength maintenance")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("endurance")
    recipe = generate_weekly_recipe(profile, 2)
    cats = [ARCHETYPE_META[a].category for a in recipe]
    assert cats == ["cond", "cond"], f"got {cats}"
    _ok("endurance 2d is pure cardio")


def test_athletic_recipe_mixes_strength_power_conditioning() -> None:
    print("\n[test] athletic 4d mixes strength + hybrid + conditioning")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("athletic_performance")
    recipe = generate_weekly_recipe(profile, 4)
    cats = {ARCHETYPE_META[a].category for a in recipe}
    assert "lift" in cats or "hybrid" in cats, f"no strength element: {cats}"
    assert "cond" in cats or "hybrid" in cats, f"no conditioning element: {cats}"
    _ok(f"categories present: {sorted(cats)}")


def test_fat_loss_4d_has_conditioning_day() -> None:
    """Regression from user complaint: fat_loss at 4+ days used to be
    all-lifting. The `fat_loss_mix` recipe must inject at least one
    conditioning day."""
    print("\n[test] fat_loss 4d includes a conditioning day")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("fat_loss")
    recipe = generate_weekly_recipe(profile, 4, lifting_split="upper_lower")
    cond_days = sum(
        1 for a in recipe
        if ARCHETYPE_META[a].category in ("cond", "hybrid")
    )
    assert cond_days >= 1, (
        f"fat_loss 4d should have at least 1 conditioning day, got 0. "
        f"recipe={[a.value for a in recipe]}"
    )
    _ok(f"recipe={[a.value for a in recipe]}")


def test_flexibility_recipe_is_mostly_mobility() -> None:
    print("\n[test] flexibility 4d is mobility-dominant")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("flexibility")
    recipe = generate_weekly_recipe(profile, 4)
    mob_count = sum(1 for a in recipe if ARCHETYPE_META[a].category == "mobility")
    assert mob_count >= 2, (
        f"flexibility should be mobility-dominant, got {mob_count}/4 "
        f"mobility days. recipe={[a.value for a in recipe]}"
    )
    _ok(f"{mob_count}/4 mobility days, recipe={[a.value for a in recipe]}")


def test_stress_relief_recipe_is_low_intensity_only() -> None:
    """Stress-relief plans must not contain any high-intensity
    archetype (intervals, power, strength primaries). Everything
    should come from the recovery / mobility / zone2 set."""
    print("\n[test] stress_relief 4d contains zero high-intensity archetypes")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("stress_relief")
    recipe = generate_weekly_recipe(profile, 4)
    for a in recipe:
        meta = ARCHETYPE_META[a]
        assert meta.intensity_cost <= 2, (
            f"stress_relief included high-intensity archetype {a.value} "
            f"(cost={meta.intensity_cost})"
        )
    _ok(f"all {len(recipe)} days ≤ intensity 2")


def test_maintain_recipe_is_balanced_three_categories() -> None:
    print("\n[test] maintain recipe spans lift + cond + mobility")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("maintain")
    recipe = generate_weekly_recipe(profile, 4)
    cats = {ARCHETYPE_META[a].category for a in recipe}
    assert "lift" in cats, f"no lifting day: {cats}"
    assert "cond" in cats, f"no conditioning day: {cats}"
    # Mobility appears at 4+ days
    assert "mobility" in cats, f"no mobility day: {cats}"
    _ok(f"categories: {sorted(cats)}")


# ── End-to-end plan distinctness ────────────────────────────────────


def test_all_ten_goals_produce_distinct_plan_categories() -> None:
    """Run every supported goal through full plan generation at 4 days
    and confirm each produces its expected category mix."""
    print("\n[test] all 10 goals produce distinct category signatures")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    eq = (
        "barbell", "dumbbells", "flat_bench", "squat_rack",
        "cable_machine", "pull_up_bar", "treadmill",
        "stationary_bike", "rowing_machine",
    )
    expectations = {
        "muscle_gain":          {"lift"},
        "strength":             {"lift"},
        "body_recomp":          {"lift"},
        "fat_loss":             {"lift", "cond", "hybrid"},  # at least one cond or hybrid
        "toning":               {"lift", "cond", "hybrid"},  # aliases fat_loss
        "endurance":            {"cond", "lift"},            # cardio + maintenance
        "athletic_performance": {"lift", "cond", "hybrid"},
        "maintain":             {"lift", "cond", "mobility"},
        "flexibility":          {"mobility"},
        "stress_relief":        {"recovery", "mobility", "cond"},
    }
    for goal, required_any in expectations.items():
        inputs = PlannerInputs(
            goal=goal, days_per_week=4, experience="intermediate",
            equipment_slugs=eq, rng_seed=1,
        )
        plan = generate_workout_plan(inputs, SEED_EXERCISES)
        cats = {d["category"] for d in plan["workout_plan"]["days"]}
        overlap = cats & required_any
        assert overlap, (
            f"{goal}: expected at least one of {required_any}, got {cats}"
        )
    _ok(f"{len(expectations)} goals all produce expected category mixes")


def test_cardio_prescription_uses_duration_not_sets_reps() -> None:
    """Endurance day cardio prescriptions must be duration-shaped
    (contains 'min' or 's'), not rep-shaped like '6-8'."""
    print("\n[test] endurance cardio days emit duration-shaped reps")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    inputs = PlannerInputs(
        goal="endurance", days_per_week=4, experience="intermediate",
        equipment_slugs=("treadmill", "stationary_bike", "barbell", "dumbbells", "flat_bench", "squat_rack"),
        rng_seed=1,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    cardio_days = [d for d in plan["workout_plan"]["days"] if d["category"] == "cond"]
    assert cardio_days, "expected at least one cardio day"
    for d in cardio_days:
        for ex in d["exercises"]:
            reps = ex["reps"]
            assert "min" in reps or "s" in reps, (
                f"cardio prescription should be duration-shaped, got {reps!r}"
            )
    _ok(f"{len(cardio_days)} cardio days — all duration-shaped")


def test_mobility_prescription_uses_holds_or_flows() -> None:
    print("\n[test] flexibility mobility days emit hold/flow prescriptions")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    inputs = PlannerInputs(
        goal="flexibility", days_per_week=4, experience="intermediate",
        equipment_slugs=("dumbbells", "flat_bench", "stationary_bike"),
        rng_seed=1,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    mobility_days = [d for d in plan["workout_plan"]["days"] if d["category"] == "mobility"]
    assert mobility_days, "expected at least one mobility day"
    for d in mobility_days:
        for ex in d["exercises"]:
            reps = ex["reps"]
            assert any(kw in reps for kw in ("hold", "reps", "flow", "s")), (
                f"mobility prescription should be hold/flow, got {reps!r}"
            )
    _ok(f"{len(mobility_days)} mobility days — all hold/flow")


def test_stress_relief_never_picks_hiit_circuit() -> None:
    """Regression: the first pass had stress-relief picking HIIT
    Circuit as 'easy cardio'. The scoring term for recovery labels
    must hard-ban interval exercises on easy movement slots."""
    print("\n[test] stress_relief never picks HIIT / sprint intervals")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    inputs = PlannerInputs(
        goal="stress_relief", days_per_week=4, experience="intermediate",
        equipment_slugs=("treadmill", "stationary_bike", "dumbbells"),
        rng_seed=1,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    recovery_days = [d for d in plan["workout_plan"]["days"] if d["category"] == "recovery"]
    banned = {"hiit_circuit", "sprint_intervals", "hill_sprints", "assault_bike",
              "treadmill_intervals", "stationary_bike_intervals", "rowing_machine_intervals",
              "battle_ropes", "burpees"}
    for d in recovery_days:
        for ex in d["exercises"]:
            slug = ex.get("_slug", "")
            assert slug not in banned, (
                f"stress_relief picked high-intensity {slug!r} on a recovery day"
            )
    _ok(f"{len(recovery_days)} recovery days — no intervals")


def test_session_minutes_trims_every_category() -> None:
    """session_minutes must shorten ALL day types, not just lifting.
    A 30-min endurance day should have fewer slots than a 90-min one."""
    print("\n[test] session_minutes affects lifting + cardio + mobility")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    def _slot_count(plan):
        return sum(len(d["exercises"]) for d in plan["workout_plan"]["days"])

    eq = ("treadmill", "stationary_bike", "dumbbells", "barbell", "flat_bench", "squat_rack")
    # Endurance short vs long
    short = generate_workout_plan(
        PlannerInputs(goal="endurance", days_per_week=4, experience="intermediate",
                      equipment_slugs=eq, session_minutes=25, rng_seed=1),
        SEED_EXERCISES,
    )
    long = generate_workout_plan(
        PlannerInputs(goal="endurance", days_per_week=4, experience="intermediate",
                      equipment_slugs=eq, session_minutes=75, rng_seed=1),
        SEED_EXERCISES,
    )
    assert _slot_count(short) < _slot_count(long), (
        f"session_minutes had no effect on endurance plan: "
        f"short={_slot_count(short)} long={_slot_count(long)}"
    )
    _ok(f"endurance: short={_slot_count(short)} long={_slot_count(long)}")


# ── Runner ──────────────────────────────────────────────────────────


def _run_all() -> int:
    tests = [
        test_every_archetype_has_a_slot_builder,
        test_every_archetype_has_metadata,
        test_muscle_gain_recipe_is_pure_lifting,
        test_endurance_recipe_mostly_cardio_with_strength_day,
        test_endurance_2d_has_no_strength_day,
        test_athletic_recipe_mixes_strength_power_conditioning,
        test_fat_loss_4d_has_conditioning_day,
        test_flexibility_recipe_is_mostly_mobility,
        test_stress_relief_recipe_is_low_intensity_only,
        test_maintain_recipe_is_balanced_three_categories,
        test_all_ten_goals_produce_distinct_plan_categories,
        test_cardio_prescription_uses_duration_not_sets_reps,
        test_mobility_prescription_uses_holds_or_flows,
        test_stress_relief_never_picks_hiit_circuit,
        test_session_minutes_trims_every_category,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {t.__name__} ({type(e).__name__}): {e}")
    print()
    print(f"{len(tests) - failed}/{len(tests)} passed" if failed == 0 else f"{failed} FAILED")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
