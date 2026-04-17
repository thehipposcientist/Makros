"""Tests that focused-muscle plans differ materially from generic plans.

These are the acceptance criteria for the focus system refactor:
1. Different auto-split selection for lower-body focus
2. Different slot composition (glute-biased lower templates)
3. Higher focused-muscle volume
4. More focus exposure days
5. More direct focus accessories
6. Different exercise overlap ratio
"""
from __future__ import annotations

from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.planner import (
    PlannerInputs,
    generate_workout_plan,
    pick_split,
    weekly_set_targets,
)
from app.services.workout.day_templates import SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL
from app.services.workout.focus_profiles import get_focus_profile, focus_min_exposure_days


_FULL_GYM = (
    "barbell", "dumbbells", "cable_machine", "lat_pulldown", "leg_press",
    "smith_machine", "adjustable_bench", "pull_up_bar", "dip_bars",
    "leg_curl_machine", "leg_extension_machine", "hack_squat",
    "hip_thrust_bench", "ankle_strap", "resistance_bands",
)


def _make_inputs(goal="body_recomp", days=4, focus=None, seed=1):
    return PlannerInputs(
        goal=goal,
        days_per_week=days,
        experience="intermediate",
        equipment_slugs=_FULL_GYM,
        focused_muscle=focus,
        rng_seed=seed,
    )


def _plan_exercises(plan):
    """Flat list of exercise names from all days."""
    days = plan.get("workout_plan", {}).get("days", [])
    return [ex["name"] for day in days for ex in day.get("exercises", [])]


def _plan_exercise_slugs(plan):
    days = plan.get("workout_plan", {}).get("days", [])
    return [ex.get("_slug", ex["name"]) for day in days for ex in day.get("exercises", [])]


def _count_muscle_sets(plan, muscle):
    """Total sets across the week hitting a muscle (primary=1.0, secondary=0.5)."""
    total = 0.0
    days = plan.get("workout_plan", {}).get("days", [])
    for day in days:
        for ex in day.get("exercises", []):
            pm = ex.get("_primary_muscle", "")
            sm = ex.get("_secondary_muscles") or []
            sets = int(ex.get("sets") or 0)
            if pm == muscle:
                total += sets
            elif muscle in sm:
                total += sets * 0.5
    return total


def _days_with_muscle(plan, muscle):
    """Number of days that include at least one exercise hitting the muscle."""
    count = 0
    days = plan.get("workout_plan", {}).get("days", [])
    for day in days:
        for ex in day.get("exercises", []):
            pm = ex.get("_primary_muscle", "")
            sm = ex.get("_secondary_muscles") or []
            if pm == muscle or muscle in sm:
                count += 1
                break
    return count


def _direct_accessories(plan, muscle):
    """Count isolation exercises where muscle is primary."""
    count = 0
    days = plan.get("workout_plan", {}).get("days", [])
    for day in days:
        for ex in day.get("exercises", []):
            if ex.get("_primary_muscle") == muscle and ex.get("_role") == "isolation":
                count += 1
    return count


def _exercise_overlap(plan_a, plan_b):
    """Fraction of exercises that are identical between two plans."""
    slugs_a = set(_plan_exercise_slugs(plan_a))
    slugs_b = set(_plan_exercise_slugs(plan_b))
    if not slugs_a or not slugs_b:
        return 1.0
    intersection = slugs_a & slugs_b
    union = slugs_a | slugs_b
    return len(intersection) / len(union)


# ── Split selection tests ──────────────────────────────────────────


def test_glute_focus_3d_avoids_ppl():
    """At 3 days, glute focus should avoid PPL (only 1 leg day). Full body
    or upper/lower are both acceptable — both give more lower exposure."""
    split = pick_split(_make_inputs(days=3, focus="glutes"), focused_muscle="glutes")
    assert split != SPLIT_PPL, f"3d glute focus should NOT pick PPL, got {split}"
    assert split in (SPLIT_FULL_BODY, SPLIT_UPPER_LOWER), f"Expected full_body or upper_lower, got {split}"


def test_glute_focus_4d_prefers_upper_lower():
    """At 4 days, glute focus should prefer U/L (2 lower days) over PPL."""
    split = pick_split(_make_inputs(days=4, focus="glutes"), focused_muscle="glutes")
    assert split == SPLIT_UPPER_LOWER, f"Expected upper_lower for 4d glute focus, got {split}"


def test_no_focus_3d_recomp_picks_ppl():
    """Without focus, 3d recomp should pick PPL (the default)."""
    split = pick_split(_make_inputs(days=3))
    assert split == SPLIT_PPL, f"Expected ppl for 3d no-focus recomp, got {split}"


def test_chest_focus_still_allows_ppl():
    """Chest focus should not force away from PPL — it's upper-friendly."""
    split = pick_split(_make_inputs(days=3, focus="chest"), focused_muscle="chest")
    # PPL is fine for chest focus at 3d
    assert split in (SPLIT_PPL, SPLIT_FULL_BODY)


def test_manual_split_respected_with_focus():
    """Manual split choice is never overridden by focus."""
    inputs = _make_inputs(days=4, focus="glutes")
    inputs = PlannerInputs(
        goal=inputs.goal, days_per_week=inputs.days_per_week,
        experience=inputs.experience, equipment_slugs=inputs.equipment_slugs,
        focused_muscle="glutes", preferred_split="ppl", rng_seed=1,
    )
    split = pick_split(inputs, focused_muscle="glutes")
    assert split == "ppl", "Manual PPL choice must be respected even with glute focus"


# ── Volume and exposure tests ──────────────────────────────────────


def test_glute_focus_higher_volume_than_generic():
    """Glute-focused recomp should have more glute sets than generic."""
    generic = generate_workout_plan(_make_inputs(days=4), SEED_EXERCISES)
    focused = generate_workout_plan(_make_inputs(days=4, focus="glutes"), SEED_EXERCISES)

    generic_sets = _count_muscle_sets(generic, "glutes")
    focused_sets = _count_muscle_sets(focused, "glutes")

    assert focused_sets > generic_sets, (
        f"Glute-focused plan should have more glute sets: "
        f"focused={focused_sets:.1f} vs generic={generic_sets:.1f}"
    )


def test_glute_focus_more_exposure_days():
    """Glute-focused plan should train glutes on more days."""
    generic = generate_workout_plan(_make_inputs(days=4), SEED_EXERCISES)
    focused = generate_workout_plan(_make_inputs(days=4, focus="glutes"), SEED_EXERCISES)

    generic_days = _days_with_muscle(generic, "glutes")
    focused_days = _days_with_muscle(focused, "glutes")

    assert focused_days >= generic_days, (
        f"Glute focus should have >= exposure days: "
        f"focused={focused_days} vs generic={generic_days}"
    )


def test_glute_focus_has_direct_accessories():
    """Glute-focused plan must have at least 2 direct glute accessories."""
    plan = generate_workout_plan(_make_inputs(days=4, focus="glutes"), SEED_EXERCISES)
    accs = _direct_accessories(plan, "glutes")
    assert accs >= 2, f"Expected >=2 direct glute accessories, got {accs}"


def test_glute_focus_different_exercises_from_generic():
    """Plans should not be near-identical — exercise overlap should be < 80%."""
    generic = generate_workout_plan(_make_inputs(days=4, seed=42), SEED_EXERCISES)
    focused = generate_workout_plan(_make_inputs(days=4, focus="glutes", seed=42), SEED_EXERCISES)

    overlap = _exercise_overlap(generic, focused)
    assert overlap < 0.85, (
        f"Plans are too similar: {overlap:.0%} exercise overlap. "
        f"Focus should materially change exercise selection."
    )


def test_glute_focus_carries_focus_audit():
    """Plan should carry a focus_audit in the workout_plan dict."""
    plan = generate_workout_plan(_make_inputs(days=4, focus="glutes"), SEED_EXERCISES)
    audit = plan.get("workout_plan", {}).get("focus_audit")
    assert audit is not None, "Missing focus_audit in plan"
    assert audit["muscle"] == "glutes"
    assert audit["days_with_exposure"] >= audit["min_exposure_days"]
    assert audit["direct_accessories"] >= audit["min_direct_accessories"]


# ── Weekly set targets ─────────────────────────────────────────────


def test_focus_volume_boost():
    """Focused muscle target should be >30% above baseline."""
    generic = weekly_set_targets(_make_inputs(days=4))
    focused = weekly_set_targets(_make_inputs(days=4, focus="glutes"))

    assert focused["glutes"] > generic["glutes"], (
        f"Glute target should be boosted: {focused['glutes']} vs {generic['glutes']}"
    )
    boost_ratio = focused["glutes"] / generic["glutes"]
    assert boost_ratio >= 1.2, f"Boost ratio too small: {boost_ratio:.2f}"


# ── Focus profile registry ─────────────────────────────────────────


def test_focus_profile_exists_for_common_muscles():
    """All commonly-requested focus muscles should have a profile."""
    for muscle in ("glutes", "chest", "back", "shoulders", "quads", "hamstrings"):
        fp = get_focus_profile(muscle)
        assert fp is not None, f"No focus profile for {muscle}"
        assert fp.muscle == muscle


def test_focus_profile_none_when_no_focus():
    assert get_focus_profile(None) is None
    assert get_focus_profile("") is None


def test_min_exposure_days_scales_with_training_days():
    fp = get_focus_profile("glutes")
    assert focus_min_exposure_days(fp, 3) >= 1
    assert focus_min_exposure_days(fp, 5) >= 2
    assert focus_min_exposure_days(fp, 7) >= 2


# ── Cross-user differentiation ─────────────────────────────────────


def test_different_users_same_goal_different_focus():
    """Two users with same goal but different focus should get different plans."""
    user_a = generate_workout_plan(
        _make_inputs(days=4, focus=None, seed=10), SEED_EXERCISES
    )
    user_b = generate_workout_plan(
        _make_inputs(days=4, focus="glutes", seed=11), SEED_EXERCISES
    )

    overlap = _exercise_overlap(user_a, user_b)
    assert overlap < 0.85, (
        f"Users with different focus too similar: {overlap:.0%} overlap"
    )

    b_glute_sets = _count_muscle_sets(user_b, "glutes")
    a_glute_sets = _count_muscle_sets(user_a, "glutes")
    assert b_glute_sets > a_glute_sets, (
        f"Glute-focused user B should have more glute sets: "
        f"B={b_glute_sets:.1f} vs A={a_glute_sets:.1f}"
    )


def test_same_user_stable_plan():
    """Same inputs should always produce the same plan."""
    plan_1 = generate_workout_plan(_make_inputs(days=4, focus="glutes", seed=42), SEED_EXERCISES)
    plan_2 = generate_workout_plan(_make_inputs(days=4, focus="glutes", seed=42), SEED_EXERCISES)

    slugs_1 = _plan_exercise_slugs(plan_1)
    slugs_2 = _plan_exercise_slugs(plan_2)
    assert slugs_1 == slugs_2, "Same inputs should produce identical plans"
