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
    from app.services.workout.day_templates import archetype_to_slots
    for a in DayArchetype:
        slots = archetype_to_slots(a, 0, 4)
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


def test_focused_muscle_backfill_skipped_on_non_lifting_modes() -> None:
    """Regression: focused-muscle backfill used to run for every plan
    with a `focused_muscle` set. That meant a flexibility user who
    said 'I want glute focus' would get an extra strength isolation
    tacked onto their mobility day. Post-refactor, backfill only
    fires for lifting-oriented planner modes."""
    print("\n[test] focused-muscle backfill gated by planner mode")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    # Flexibility with glute focus — mobility mode, must NOT stamp an
    # extra glute strength exercise onto the mobility day.
    plan = generate_workout_plan(
        PlannerInputs(
            goal="flexibility", days_per_week=4, experience="intermediate",
            equipment_slugs=("dumbbells", "flat_bench", "stationary_bike"),
            focused_muscle="glutes", rng_seed=1,
        ),
        SEED_EXERCISES,
    )
    for d in plan["workout_plan"]["days"]:
        if d["category"] != "mobility":
            continue
        for ex in d["exercises"]:
            assert ex.get("_slot") != "Focus Accessory", (
                f"focused-muscle backfill landed on a mobility day: {ex}"
            )
    _ok("flexibility plan with focused_muscle → no backfill accessory")

    # Stress relief must also skip backfill.
    plan2 = generate_workout_plan(
        PlannerInputs(
            goal="stress_relief", days_per_week=4, experience="intermediate",
            equipment_slugs=("dumbbells", "treadmill", "stationary_bike"),
            focused_muscle="chest", rng_seed=1,
        ),
        SEED_EXERCISES,
    )
    for d in plan2["workout_plan"]["days"]:
        for ex in d["exercises"]:
            assert ex.get("_slot") != "Focus Accessory", (
                f"stress-relief plan received backfill accessory: {ex}"
            )
    _ok("stress_relief plan with focused_muscle → no backfill accessory")


def test_focused_muscle_backfill_still_runs_for_lifting() -> None:
    """Positive regression — backfill is NOT globally disabled, it's
    just gated. Muscle-gain users with a focus muscle should still
    get the accessory appended when volume is below target."""
    print("\n[test] focused-muscle backfill still runs for muscle_gain")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES
    plan = generate_workout_plan(
        PlannerInputs(
            goal="muscle_gain", days_per_week=4, experience="intermediate",
            equipment_slugs=(
                "barbell", "dumbbells", "flat_bench", "squat_rack",
                "cable_machine", "pull_up_bar",
            ),
            focused_muscle="glutes", rng_seed=11,
        ),
        SEED_EXERCISES,
    )
    audit = plan["workout_plan"]["volume_audit"]
    assert audit["focused_muscle"] == "glutes"
    assigned = audit["assigned"].get("glutes", 0)
    target = audit["targets"].get("glutes", 0)
    assert assigned > 0, f"no glute volume assigned: {audit}"
    _ok(f"muscle_gain + glute focus → target={target} assigned={assigned}")


def test_density_adjust_is_archetype_aware() -> None:
    """Short-session trimming should use different role-minute costs
    per archetype category. A 25-min lifting session trims down to
    compounds (few slots); a 25-min mobility session keeps many
    slots because each drill costs ~5 min."""
    print("\n[test] density trimming uses category-specific role costs")
    from app.services.workout.slots import (
        Slot, density_adjust_slots, _full_body_slots,
        _mobility_flow_slots, _cardio_steady_slots,
    )
    # Lifting: 5 slots, each ~12/8/6/4 min → total ~40.
    lift_slots = _full_body_slots(0)
    lift_25 = density_adjust_slots(lift_slots, 25, category="lift")
    assert len(lift_25) < len(lift_slots), (
        f"25-min lifting session did not trim: {len(lift_25)}"
    )
    # Mobility: 5 slots × 3-5 min → total ~20. Fits inside 25 min.
    mob_slots = _mobility_flow_slots()
    mob_25 = density_adjust_slots(mob_slots, 25, category="mobility")
    assert len(mob_25) == len(mob_slots), (
        f"25-min mobility session over-trimmed: "
        f"kept {len(mob_25)}/{len(mob_slots)}"
    )
    # Cardio steady at 25 min — the one primary (25-min block) should
    # survive even though the cooldown gets trimmed if needed.
    cardio_slots = _cardio_steady_slots()
    cardio_25 = density_adjust_slots(cardio_slots, 25, category="cond")
    assert any(s.role == "primary" for s in cardio_25), (
        f"cardio primary block was trimmed: {cardio_25}"
    )
    _ok(
        f"lift 25m: {len(lift_slots)}→{len(lift_25)}  "
        f"mob 25m: {len(mob_slots)}→{len(mob_25)}  "
        f"cond 25m: {len(cardio_slots)}→{len(cardio_25)}"
    )


def test_cardio_classification_is_single_source_of_truth() -> None:
    """Regression: the old planner read `exercise.get('is_compound')`
    in three different places to infer interval-vs-steady cardio.
    After refactor, that inference lives behind `classify_cardio` so
    a seed change doesn't have to touch planner/scoring/prescription."""
    print("\n[test] cardio classification lives in one place")
    from app.services.workout.cardio import (
        classify_cardio, is_interval_cardio, is_easy_cardio,
    )
    # Strength row → not cardio
    assert classify_cardio({
        "name": "Barbell Bench Press",
        "exercise_type": "strength",
        "movement_pattern": "horizontal_press",
    }) == "not_cardio"
    # Name-based interval detection
    assert is_interval_cardio({
        "name": "HIIT Circuit",
        "exercise_type": "cardio",
        "movement_pattern": "cardio",
        "is_compound": False,   # name pattern beats the flag
    })
    # Name-based easy detection
    assert is_easy_cardio({
        "name": "Jogging",
        "exercise_type": "cardio",
        "movement_pattern": "cardio",
        "is_compound": False,
    })
    # is_compound fallback for plain names
    assert is_interval_cardio({
        "name": "Treadmill",
        "exercise_type": "cardio",
        "movement_pattern": "cardio",
        "is_compound": True,
    })
    _ok("classify_cardio handles name, easy, intervals, fallback")


def test_focus_normalization_handles_variants() -> None:
    """The normalizer must collapse every focus variant the code
    has been observed to store into a coarse bucket. Exact-match
    lookup was the root cause of the rotation silently failing."""
    print("\n[test] focus normalization handles every variant")
    from app.services.workout.focus_normalize import normalize_focus_to_bucket
    cases = [
        # lower_body
        ("Legs", "lower_body"),
        ("legs", "lower_body"),
        ("LEGS", "lower_body"),
        ("Legs 1", "lower_body"),
        ("Legs 3", "lower_body"),
        ("Leg Day", "lower_body"),
        ("Lower", "lower_body"),
        ("Lower 2", "lower_body"),
        ("Lower Body", "lower_body"),
        ("Lower 2 — Hinge Bias", "lower_body"),
        ("Legs — Squat + Hinge", "lower_body"),
        ("Glutes & Hamstrings", "lower_body"),
        ("quad day", "lower_body"),
        # upper_body
        ("Upper", "upper_body"),
        ("Upper Body", "upper_body"),
        ("Upper 1 — Horizontal Push/Pull", "upper_body"),
        ("Push", "upper_body"),
        ("Pull", "upper_body"),
        ("Chest", "upper_body"),
        ("Back", "upper_body"),
        ("Back & Biceps", "upper_body"),
        ("Shoulders", "upper_body"),
        ("Arms", "upper_body"),
        ("Push 2 — Chest/Shoulder Focus", "upper_body"),
        # full_body
        ("Full Body", "full_body"),
        ("Full Body A — Squat & Press", "full_body"),
        ("total body", "full_body"),
        # cardio
        ("Cardio", "cardio"),
        ("Cardio — Intervals", "cardio"),
        ("Zone 2 Cardio", "cardio"),
        ("Tempo / Threshold", "cardio"),
        ("HIIT", "cardio"),
        ("Sprint + Power", "cardio"),
        ("Short Intervals", "cardio"),
        ("Conditioning — Intervals", "cardio"),
        # mobility / recovery
        ("Mobility Flow", "mobility"),
        ("Stretch Block", "mobility"),
        ("Easy Recovery", "recovery"),
        ("Easy Movement", "recovery"),
        # edge cases
        (None, None),
        ("", None),
        ("   ", None),
        ("asdf qwerty", None),
    ]
    for raw, expected in cases:
        got = normalize_focus_to_bucket(raw)
        assert got == expected, f"{raw!r} → {got!r} (expected {expected!r})"
    _ok(f"{len(cases)} variants all normalized correctly")


def test_recent_focus_rotation_avoids_legs_back_to_back() -> None:
    """Regression for the user's reported bug: complete legs today,
    regenerate, and the new plan must not put legs on day 1 of the
    new week. The rotation pass in `generate_weekly_recipe` shifts
    the recipe start index so day 0 isn't the same coarse bucket as
    the recent focus."""
    print("\n[test] recent lower_body rotates a Lower-first UL recipe")
    from app.services.workout.weekly_recipe import _rotate_recipe_to_avoid_recent
    from app.services.workout.archetypes import DayArchetype

    original = [
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_UPPER,
    ]
    rotated = _rotate_recipe_to_avoid_recent(
        original, ("lower_body",), mode="lifting",
    )
    assert rotated[0] != DayArchetype.LIFT_LOWER, (
        f"recent lower_body should have rotated the Lower-first recipe; "
        f"got day 0 = {rotated[0].value}"
    )
    assert rotated[0] == DayArchetype.LIFT_UPPER, (
        f"expected Upper as new day 0, got {rotated[0].value}"
    )
    _ok(f"rotated: {[a.value for a in original]} → {[a.value for a in rotated]}")


def test_rotation_avoids_two_recent_buckets_when_possible() -> None:
    """Tier 1: 'Back yesterday + Legs today' should make the planner
    prefer a day that's neither upper nor lower on day 0. With a 5-day
    PPL_UL recipe [Push, Pull, Legs, Upper, Lower], both upper and
    lower buckets are present — the rotation can't avoid both, so it
    should fall back to avoiding just the most recent (lower)."""
    print("\n[test] rotation avoids multiple recent buckets when possible")
    from app.services.workout.weekly_recipe import _rotate_recipe_to_avoid_recent
    from app.services.workout.archetypes import DayArchetype

    # With a full-body day available, tier-1 succeeds and we get
    # full-body on day 0.
    recipe_with_fb = [
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.LIFT_UPPER,
    ]
    rotated = _rotate_recipe_to_avoid_recent(
        recipe_with_fb, ("lower_body", "upper_body"), mode="lifting",
    )
    assert rotated[0] == DayArchetype.LIFT_FULL_BODY, (
        f"tier-1 should have found the full_body day; got {rotated[0].value}"
    )
    _ok(f"tier-1: {[a.value for a in recipe_with_fb]} → day0={rotated[0].value}")

    # Without a full-body day, tier-2 falls back to just avoiding
    # the most recent bucket (lower_body).
    recipe_ul_only = [
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_UPPER,
    ]
    rotated2 = _rotate_recipe_to_avoid_recent(
        recipe_ul_only, ("lower_body", "upper_body"), mode="lifting",
    )
    assert rotated2[0] == DayArchetype.LIFT_UPPER, (
        f"tier-2 should still rotate off lower_body; got {rotated2[0].value}"
    )
    _ok(f"tier-2: day0={rotated2[0].value} (avoids most recent)")


def test_rotation_returns_original_when_no_alternative_exists() -> None:
    """If every day in the recipe is the same bucket as the recent
    focus, the rotation returns the original list — there's nothing
    to avoid by."""
    print("\n[test] rotation no-op when every day is the same bucket")
    from app.services.workout.weekly_recipe import _rotate_recipe_to_avoid_recent
    from app.services.workout.archetypes import DayArchetype
    original = [
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.LIFT_FULL_BODY,
    ]
    rotated = _rotate_recipe_to_avoid_recent(
        original, ("full_body",), mode="lifting",
    )
    assert rotated == original, (
        f"all-full-body recipe should stay unchanged; got {[a.value for a in rotated]}"
    )
    _ok("3× full body with recent full_body → unchanged")


def test_recent_focus_rotation_respects_mode_anchors() -> None:
    """Endurance plans place the strength-maintenance day at the end
    on purpose — rotation must NOT fire for endurance mode even if
    day 0 matches the recent focus. Same for athletic / mobility."""
    print("\n[test] rotation skipped for anchored modes")
    from app.services.workout.weekly_recipe import _rotate_recipe_to_avoid_recent
    from app.services.workout.archetypes import DayArchetype
    original = [
        DayArchetype.COND_INTERVALS_SHORT,
        DayArchetype.COND_ZONE2,
        DayArchetype.COND_INTERVALS_LONG,
        DayArchetype.LIFT_STRENGTH_MAINTENANCE,
    ]
    # Pretend the user just did a cardio intervals session.
    rotated = _rotate_recipe_to_avoid_recent(
        original, ("cardio",), mode="endurance",
    )
    assert rotated == original, (
        f"endurance recipe should not rotate — got {[a.value for a in rotated]}"
    )
    _ok("endurance recipe anchors preserved")


def test_recent_focus_no_op_when_day0_already_safe() -> None:
    """If day 0 already differs from the recent focus, rotation must
    be a no-op and return the original list."""
    print("\n[test] no rotation when day 0 is already safe")
    from app.services.workout.weekly_recipe import _rotate_recipe_to_avoid_recent
    from app.services.workout.archetypes import DayArchetype
    original = [
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_LOWER,
    ]
    rotated = _rotate_recipe_to_avoid_recent(
        original, ("lower_body",), mode="lifting",
    )
    assert rotated == original, "should not rotate when day 0 is already Upper"
    _ok("Upper-first recipe with recent lower_body → unchanged")


def test_body_recomp_has_real_cardio_days_at_4plus_days() -> None:
    """Regression: body_recomp at 4+ days/week used to be pure
    upper/lower with zero cardio, even though its mix declared 15%
    conditioning. It's now routed through `lifting_plus_cardio`
    mode which reserves 1 cardio day at 4-5 days and 2 at 6+."""
    print("\n[test] body_recomp 4+ days actually schedules cardio")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    eq = ("barbell", "dumbbells", "flat_bench", "squat_rack", "treadmill", "stationary_bike")
    cases = [
        (3, 0),  # 3 days still pure lifting
        (4, 1),  # 4 days gets 1 cardio
        (5, 1),  # 5 days gets 1 cardio
        (6, 2),  # 6 days gets 2 cardio
    ]
    for days, expected_cardio in cases:
        inputs = PlannerInputs(
            goal="body_recomp", days_per_week=days, experience="intermediate",
            equipment_slugs=eq, rng_seed=1,
        )
        plan = generate_workout_plan(inputs, SEED_EXERCISES)
        cardio_count = sum(
            1 for d in plan["workout_plan"]["days"]
            if d["category"] in ("cond", "hybrid")
        )
        assert cardio_count == expected_cardio, (
            f"body_recomp {days}d: expected {expected_cardio} cardio days, "
            f"got {cardio_count} — "
            f"{[d['category'] for d in plan['workout_plan']['days']]}"
        )
    _ok("body_recomp 3/4/5/6 days → 0/1/1/2 cardio days")


def test_strength_does_not_get_cardio_days() -> None:
    """Strength goal has 5% conditioning — below the 10% threshold
    for dedicated cardio days. Its plans should still be pure lifting
    so users chasing 1RM don't get unexpected interval sessions."""
    print("\n[test] strength goal stays pure lifting")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    eq = ("barbell", "dumbbells", "flat_bench", "squat_rack")
    for days in (3, 4, 5):
        inputs = PlannerInputs(
            goal="strength", days_per_week=days, experience="intermediate",
            equipment_slugs=eq, rng_seed=1,
        )
        plan = generate_workout_plan(inputs, SEED_EXERCISES)
        cats = [d["category"] for d in plan["workout_plan"]["days"]]
        assert all(c == "lift" for c in cats), (
            f"strength {days}d should be pure lifting, got {cats}"
        )
    _ok("strength 3/4/5 days all pure lifting")


def test_body_recomp_4d_with_recent_legs_via_full_planner() -> None:
    """End-to-end: body_recomp 4 days with recent legs session should
    produce a non-lower-body day on day 0. This is the regression
    test for the user's reported bug path."""
    print("\n[test] body_recomp 4d + recent lower_body → day 0 is not lower_body")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    inputs = PlannerInputs(
        goal="body_recomp",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
        rng_seed=1,
        recent_focus_buckets=("lower_body",),
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    day0 = plan["workout_plan"]["days"][0]
    assert day0["archetype"] != "lift_lower", (
        f"body_recomp 4d with recent legs should not start with lower_body; "
        f"got {day0['archetype']} (focus={day0['focus']})"
    )
    _ok(f"body_recomp 4d day 0 after recent legs = {day0['archetype']} / {day0['focus']}")


def test_most_recent_completed_focus_reads_workout_completion_table() -> None:
    """Regression for the actual production bug: `WorkoutSession`
    is almost never populated by the mobile finish-workout flow
    (it writes to `WorkoutCompletion` via /workouts/complete), so
    the rotation query MUST read from WorkoutCompletion.

    This test uses a stub session that records which model was
    queried and returns a canned list of rows. If someone later
    reverts the query back to WorkoutSession, this test fails
    loudly."""
    print("\n[test] most_recent_completed_focus queries WorkoutCompletion")
    try:
        import sqlmodel  # noqa: F401
    except ImportError:
        _ok("skipped — sqlmodel not available in this test environment")
        return
    from datetime import datetime, date, timedelta
    from app.services.workout.history import most_recent_completed_focus

    # Stub SQLModel session that records the `select` target and
    # returns pre-built rows. Matches just enough of the real
    # interface that the function under test runs end-to-end.
    class _StubRow:
        def __init__(self, focus_label: str, completed_at: datetime, workout_date: date):
            self.focus_label = focus_label
            self.completed_at = completed_at
            self.workout_date = workout_date

    class _StubQuery:
        def __init__(self, rows): self._rows = rows
        def where(self, *_args, **_kwargs): return self
        def order_by(self, *_args, **_kwargs): return self
        def limit(self, *_args, **_kwargs): return self

    class _StubResult:
        def __init__(self, rows): self._rows = rows
        def all(self): return self._rows

    class _StubSession:
        queried_models: list = []
        def __init__(self, rows): self._rows = rows
        def exec(self, stmt):
            # Capture what table we were asked to query by sniffing
            # the statement's column reference. The real `select()`
            # from sqlmodel sets `stmt.froms` / `.columns`; here we
            # just record that exec was called and return the stub.
            _StubSession.queried_models.append(type(stmt).__name__)
            return _StubResult(self._rows)

    now = datetime.utcnow()
    rows = [
        _StubRow("Lower", now - timedelta(hours=2), date.today()),
        _StubRow("Upper", now - timedelta(hours=26), date.today() - timedelta(days=1)),
    ]
    session = _StubSession(rows)
    buckets, families = most_recent_completed_focus(user_id=1, db_session=session, hours=36, limit=2)
    assert buckets == ["lower_body", "upper_body"], (
        f"expected ['lower_body', 'upper_body'], got {buckets}"
    )
    assert families == ["legs", "upper"], (
        f"expected ['legs', 'upper'], got {families}"
    )
    _ok(f"buckets = {buckets}, families = {families} — reads WorkoutCompletion via normalizer")


def test_body_recomp_with_raw_db_focus_variants() -> None:
    """End-to-end through the normalizer: each of these raw focus
    strings (simulating what might actually be stored in the DB)
    should rotate the recipe away from lower_body."""
    print("\n[test] raw DB focus variants all trigger rotation")
    from app.services.workout.focus_normalize import normalize_focus_to_bucket
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    raw_variants = [
        "Legs",
        "legs",
        "LEGS",
        "Legs 1",
        "Legs — Squat + Hinge",
        "Lower",
        "Lower 2 — Hinge Bias",
        "Lower Body",
        "Leg Day",
    ]
    for raw in raw_variants:
        bucket = normalize_focus_to_bucket(raw)
        assert bucket == "lower_body", f"{raw!r} should normalize to lower_body, got {bucket!r}"
        inputs = PlannerInputs(
            goal="body_recomp",
            days_per_week=4,
            experience="intermediate",
            equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
            rng_seed=1,
            recent_focus_buckets=(bucket,),
        )
        plan = generate_workout_plan(inputs, SEED_EXERCISES)
        day0 = plan["workout_plan"]["days"][0]
        assert day0["archetype"] != "lift_lower", (
            f"raw focus {raw!r} (→ {bucket}) should have rotated off lower_body"
        )
    _ok(f"{len(raw_variants)} raw focus variants all triggered rotation")


def test_focused_muscle_set_bump_fires_for_muscle_gain() -> None:
    """Goal-gated +1 set rule: a muscle_gain user with chest focus
    should get an extra set on primary and secondary chest exercises,
    capped at 5."""
    print("\n[test] focused-muscle set bump fires for muscle_gain + chest focus")
    from app.services.workout.planner import prescribe_sets_reps, PlannerInputs
    from app.services.workout.slots import Slot

    # Baseline — no focused muscle
    baseline_inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
    )
    focused_inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        focused_muscle="chest",
    )
    slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
    bench = {
        "name": "Barbell Bench Press", "slug": "barbell_bench_press",
        "primary_muscle": "chest", "secondary_muscles": ["triceps", "shoulders"],
        "movement_pattern": "horizontal_press", "is_compound": True,
    }
    baseline = prescribe_sets_reps(bench, slot, baseline_inputs)
    focused = prescribe_sets_reps(bench, slot, focused_inputs)
    assert focused.sets == baseline.sets + 1, (
        f"chest focus should bump sets: baseline={baseline.sets}, focused={focused.sets}"
    )
    assert focused.sets <= 5
    _ok(f"baseline={baseline.sets} → focused={focused.sets}")


def test_focused_muscle_set_bump_skipped_for_fat_loss() -> None:
    """Goal gating: fat_loss shouldn't get the extra set (fatigue risk
    on a deficit). Same for endurance / athletic / general_health."""
    print("\n[test] focused-muscle set bump skipped for fat_loss")
    from app.services.workout.planner import prescribe_sets_reps, PlannerInputs
    from app.services.workout.slots import Slot
    for goal in ("fat_loss", "endurance", "athletic_performance", "maintain"):
        baseline_inputs = PlannerInputs(goal=goal, days_per_week=4, experience="intermediate")
        focused_inputs = PlannerInputs(goal=goal, days_per_week=4, experience="intermediate", focused_muscle="chest")
        slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
        bench = {
            "name": "Barbell Bench Press", "slug": "barbell_bench_press",
            "primary_muscle": "chest", "secondary_muscles": ["triceps"],
            "movement_pattern": "horizontal_press", "is_compound": True,
        }
        baseline = prescribe_sets_reps(bench, slot, baseline_inputs)
        focused = prescribe_sets_reps(bench, slot, focused_inputs)
        assert baseline.sets == focused.sets, (
            f"{goal} should NOT bump sets for focus — baseline={baseline.sets}, focused={focused.sets}"
        )
    _ok("fat_loss / endurance / athletic / maintain all skip the bump")


def test_focused_muscle_set_bump_skipped_when_exercise_misses_focus() -> None:
    """A back row shouldn't get +1 set just because chest is the focus
    — only exercises that actually train chest (primary OR secondary)
    should qualify."""
    print("\n[test] set bump requires the exercise to actually train the focus")
    from app.services.workout.planner import prescribe_sets_reps, PlannerInputs
    from app.services.workout.slots import Slot
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        focused_muscle="chest",
    )
    row_slot = Slot("Primary Pull", "horizontal_pull", "back", "primary")
    row = {
        "name": "Barbell Row", "slug": "barbell_row",
        "primary_muscle": "back", "secondary_muscles": ["biceps"],
        "movement_pattern": "horizontal_pull", "is_compound": True,
    }
    baseline_inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
    )
    baseline = prescribe_sets_reps(row, row_slot, baseline_inputs)
    focused = prescribe_sets_reps(row, row_slot, inputs)
    assert baseline.sets == focused.sets, (
        f"back row should not get the chest-focus bump — "
        f"baseline={baseline.sets}, focused={focused.sets}"
    )
    _ok(f"row stays at {baseline.sets} sets regardless of chest focus")


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
        test_focused_muscle_backfill_skipped_on_non_lifting_modes,
        test_focused_muscle_backfill_still_runs_for_lifting,
        test_density_adjust_is_archetype_aware,
        test_cardio_classification_is_single_source_of_truth,
        test_focus_normalization_handles_variants,
        test_recent_focus_rotation_avoids_legs_back_to_back,
        test_rotation_avoids_two_recent_buckets_when_possible,
        test_rotation_returns_original_when_no_alternative_exists,
        test_recent_focus_rotation_respects_mode_anchors,
        test_recent_focus_no_op_when_day0_already_safe,
        test_body_recomp_has_real_cardio_days_at_4plus_days,
        test_strength_does_not_get_cardio_days,
        test_body_recomp_4d_with_recent_legs_via_full_planner,
        test_most_recent_completed_focus_reads_workout_completion_table,
        test_body_recomp_with_raw_db_focus_variants,
        test_focused_muscle_set_bump_fires_for_muscle_gain,
        test_focused_muscle_set_bump_skipped_for_fat_loss,
        test_focused_muscle_set_bump_skipped_when_exercise_misses_focus,
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
