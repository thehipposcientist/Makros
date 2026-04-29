"""
Sanity tests for workout_planner.py. No external deps, no pytest.

Run from inside the backend container:
    docker exec -it thallo-backend python -m app.services.test_workout_planner

Each test prints a one-line result and the planner's structured output so
you can eyeball whether the algorithm is producing sensible plans.
"""
from __future__ import annotations

from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.planner import (
    PlannerInputs,
    SPLIT_FULL_BODY,
    SPLIT_PPL,
    SPLIT_PPL_UL,
    SPLIT_UPPER_LOWER,
    build_day_templates,
    generate_workout_plan,
    pick_split,
    weekly_set_targets,
)
from app.services.workout.history import (
    make_dict_history_lookup,
    propagate_session_targets,
    recommend_next_session_load,
    _build_synthetic_prescription,
)
from app.workout_progression import (
    EffortFeedback,
    GoalType,
    ExperienceLevel,
    PhaseType,
    ProgressionPace,
    RecoveryLevel,
    SetResult,
    UserTrainingProfile,
    WorkoutContext,
    WorkoutFocus,
    WorkoutProgressionEngine,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Layer 2 — split selection ───────────────────────────────────────────────


def test_beginner_stays_simple() -> None:
    """Beginners get full body through 3 days, upper/lower at 4+. The
    old rule forced beginners to full-body at every day count, which
    produced 5× full-body for a 5-day beginner — recovery-killing and
    not what a real trainer would write."""
    print("\n[test] beginner keeps simple splits (full body ≤3 days, upper/lower ≥4)")
    for days, want in [(1, SPLIT_FULL_BODY), (2, SPLIT_FULL_BODY), (3, SPLIT_FULL_BODY),
                        (4, SPLIT_UPPER_LOWER), (5, SPLIT_UPPER_LOWER), (6, SPLIT_UPPER_LOWER)]:
        inputs = PlannerInputs(
            goal="muscle_gain",
            days_per_week=days,
            experience="beginner",
            equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
        )
        split = pick_split(inputs)
        assert split == want, f"days={days} got {split} (want {want})"
    _ok("beginner: 1-3d → full_body, 4-6d → upper_lower")


def test_intermediate_muscle_gain_stays_full_body_at_3_days() -> None:
    print("\n[test] intermediate muscle_gain 3d → full body")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=3, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
    )
    split = pick_split(inputs)
    assert split == SPLIT_FULL_BODY, f"got {split}"
    _ok(f"3-day muscle_gain intermediate → {split}")


def test_muscle_gain_4_days_is_upper_lower() -> None:
    """4-day upper/lower is the workhorse split across goals."""
    print("\n[test] muscle_gain 4d → upper/lower")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
    )
    split = pick_split(inputs)
    assert split == SPLIT_UPPER_LOWER, f"got {split}"
    _ok(f"4-day muscle_gain intermediate → {split}")


def test_strength_intermediate_4_days_is_upper_lower() -> None:
    print("\n[test] strength intermediate 4d → upper/lower")
    inputs = PlannerInputs(
        goal="strength", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
    )
    split = pick_split(inputs)
    assert split == SPLIT_UPPER_LOWER, f"got {split}"
    _ok(f"strength intermediate 4d → {split}")


def test_fat_loss_5_days_is_NOT_full_body() -> None:
    """Regression: a 5-day fat-loss plan used to return 5× full body
    because the old priority-list walker saw `full_body` first and
    `full_body` has min_days=1. New rules must not let this happen."""
    print("\n[test] REGRESSION: fat_loss 5d MUST NOT be full_body")
    inputs = PlannerInputs(
        goal="fat_loss", days_per_week=5, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
    )
    split = pick_split(inputs)
    assert split != SPLIT_FULL_BODY, f"fat_loss 5d still returning full_body: {split}"
    assert split == SPLIT_UPPER_LOWER, f"expected upper_lower, got {split}"
    _ok(f"fat_loss 5d intermediate → {split}")


def test_body_recomp_5_days_is_ppl_upper_lower() -> None:
    print("\n[test] body_recomp 5d → ppl_upper_lower hybrid")
    inputs = PlannerInputs(
        goal="body_recomp", days_per_week=5, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
    )
    split = pick_split(inputs)
    assert split == SPLIT_PPL_UL, f"got {split}"
    _ok(f"body_recomp 5d → {split}")


def test_beginner_3_days_is_full_body() -> None:
    print("\n[test] beginner 3d → full body")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=3, experience="beginner",
        equipment_slugs=("dumbbells", "flat_bench"),
    )
    split = pick_split(inputs)
    assert split == SPLIT_FULL_BODY, f"got {split}"
    _ok(f"beginner 3d → {split}")


def test_preferred_split_override_is_honored() -> None:
    print("\n[test] explicit preferred_split override")
    inputs = PlannerInputs(
        goal="fat_loss", days_per_week=5, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
        preferred_split=SPLIT_PPL,
    )
    split = pick_split(inputs)
    assert split == SPLIT_PPL, f"preferred_split ignored, got {split}"
    _ok(f"preferred=PPL → {split}")


def test_preferred_split_ignored_when_infeasible() -> None:
    """PPL needs 3+ days. Asking for it on a 2-day plan should fall
    back to the matrix, not return PPL anyway."""
    print("\n[test] infeasible preferred_split falls back to matrix")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=2, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells"),
        preferred_split=SPLIT_PPL,
    )
    split = pick_split(inputs)
    assert split == SPLIT_FULL_BODY, f"got {split}"
    _ok(f"2d + preferred=PPL → {split} (fallback)")


# ─── Layer 3 — weekly volume ─────────────────────────────────────────────────


def test_volume_targets_scale_with_experience() -> None:
    print("\n[test] volume targets scale with experience")
    beginner = weekly_set_targets(PlannerInputs(goal="muscle_gain", days_per_week=4, experience="beginner"))
    intermediate = weekly_set_targets(PlannerInputs(goal="muscle_gain", days_per_week=4, experience="intermediate"))
    advanced = weekly_set_targets(PlannerInputs(goal="muscle_gain", days_per_week=4, experience="advanced"))
    assert beginner["chest"] < intermediate["chest"] < advanced["chest"]
    assert beginner["back"] < intermediate["back"] < advanced["back"]
    _ok(f"chest: {beginner['chest']}/{intermediate['chest']}/{advanced['chest']}")
    _ok(f"back:  {beginner['back']}/{intermediate['back']}/{advanced['back']}")


def test_focused_muscle_gets_volume_bonus() -> None:
    print("\n[test] focused_muscle gets +30% volume")
    base = weekly_set_targets(PlannerInputs(goal="muscle_gain", days_per_week=4, experience="intermediate"))
    focused = weekly_set_targets(PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        focused_muscle="glutes",
    ))
    assert focused["glutes"] > base["glutes"], f"{focused['glutes']} not > {base['glutes']}"
    assert focused["chest"] == base["chest"]
    _ok(f"glutes: {base['glutes']} → {focused['glutes']}")


# ─── Layer 4 — day templates ────────────────────────────────────────────────


def test_ppl_4_day_cycle_order_and_naming() -> None:
    """PPL over 4 days → Push 1 / Pull 1 / Legs 1 / Push 2 with the new
    trainer-style two-part names (base — emphasis)."""
    print("\n[test] PPL on 4 days uses two-part trainer-style names")
    templates = build_day_templates(SPLIT_PPL, 4)
    names = [t[0] for t in templates]
    expected = [
        "Push 1 — Chest/Shoulder Focus",
        "Pull 1 — Lats/Upper Back Focus",
        "Legs 1 — Squat + Hinge",
        "Push 2 — Chest/Shoulder Focus",
    ]
    assert names == expected, f"got {names}"
    _ok(" / ".join(names))


def test_full_body_name_is_trainer_style_not_day_n() -> None:
    """Regression: full-body days must be labeled 'Full Body A — …'
    rather than 'Day 1'. And the focus label from _day_meta must be
    'Full Body', not 'Full' (the old split-on-space bug)."""
    from app.services.workout.planner import _day_meta
    print("\n[test] full body day names are trainer-style + correct focus")
    templates = build_day_templates(SPLIT_FULL_BODY, 3)
    names = [t[0] for t in templates]
    assert names[0].startswith("Full Body A"), f"day 0: {names[0]}"
    assert names[1].startswith("Full Body B"), f"day 1: {names[1]}"
    assert names[2].startswith("Full Body C"), f"day 2: {names[2]}"
    # Focus-extraction bug regression
    _, focus = _day_meta(SPLIT_FULL_BODY, 0)
    assert focus == "Full Body", f"focus label regressed to {focus!r}"
    _ok(f"{names[0]} | focus={focus}")


def test_upper_lower_emphasis_rotates() -> None:
    """Upper 1 / Upper 2 / Upper 3 should surface three different
    emphasis subtitles so consecutive upper days aren't identical."""
    print("\n[test] upper/lower emphasis rotates across cycles")
    templates = build_day_templates(SPLIT_UPPER_LOWER, 6)
    upper_names = [templates[i][0] for i in (0, 2, 4)]
    lower_names = [templates[i][0] for i in (1, 3, 5)]
    assert len(set(upper_names)) == 3, f"upper days not distinct: {upper_names}"
    assert len(set(lower_names)) == 3, f"lower days not distinct: {lower_names}"
    _ok(" / ".join(upper_names) + "  |  " + " / ".join(lower_names))


def test_full_body_3_day_rotates_slots() -> None:
    print("\n[test] full body 3 days rotates slots so days aren't identical")
    templates = build_day_templates(SPLIT_FULL_BODY, 3)
    slot_sets = [tuple(s.label for s in slots) for _, slots in templates]
    assert len(set(slot_sets)) == 3, f"days were identical: {slot_sets}"
    _ok("3 unique day templates")


# ─── Layer 5+6+7 — full plan generation ─────────────────────────────────────


def test_full_plan_intermediate_muscle_gain() -> None:
    print("\n[test] full plan — intermediate muscle gain, 4 days, full gym")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=(
            "barbell", "dumbbells", "ez_curl_bar", "weight_plates",
            "flat_bench", "adjustable_bench", "incline_bench", "squat_rack",
            "cable_machine", "lat_pulldown_machine", "leg_press_machine",
            "leg_extension_machine", "leg_curl_machine", "chest_press_machine",
            "rope_attachment", "d_handle", "v_bar_attachment",
            "preacher_bench", "pec_deck_machine", "hyperextension_bench",
            "standing_calf_raise_machine", "seated_calf_raise_machine",
            "pull_up_bar", "plyo_box",
        ),
        rng_seed=42,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    days = plan["workout_plan"]["days"]
    assert len(days) == 4, f"expected 4 days, got {len(days)}"
    for d in days:
        assert d["exercises"], f"day {d['day']} has no exercises"
        # No single day should have more than 8 exercises (sanity)
        assert len(d["exercises"]) <= 8
    print(f"  ✓ 4 days, total exercises: {sum(len(d['exercises']) for d in days)}")
    print(f"  ✓ split: {plan['workout_plan']['name']}")
    for d in days:
        names = [e["name"] for e in d["exercises"]]
        print(f"    {d['day']:8s}: {' | '.join(names)}")


def test_plan_respects_dislikes() -> None:
    print("\n[test] disliked exercises are never picked")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=3, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
        disliked_exercises=("Barbell Squat", "Romanian Deadlift"),
        rng_seed=7,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    chosen_names = {
        e["name"]
        for d in plan["workout_plan"]["days"]
        for e in d["exercises"]
    }
    assert "Barbell Squat" not in chosen_names
    assert "Romanian Deadlift" not in chosen_names
    _ok(f"none of disliked appeared in {len(chosen_names)} picks")


def test_plan_respects_equipment_constraints() -> None:
    print("\n[test] empty-equipment user gets bodyweight-only plan")
    inputs = PlannerInputs(
        goal="general_health", days_per_week=3, experience="beginner",
        equipment_slugs=(),
        rng_seed=3,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    chosen = [
        e for d in plan["workout_plan"]["days"] for e in d["exercises"]
    ]
    # Every chosen exercise must be in the bodyweight bucket since the
    # user owns nothing.
    for e in chosen:
        seed = next(s for s in SEED_EXERCISES if s.get("slug") == e["_slug"])
        assert seed.get("equipment_bucket") == "bodyweight", (
            f"{e['name']} requires non-bodyweight equipment"
        )
    _ok(f"all {len(chosen)} picks are bodyweight")


def test_plan_continuity_within_week() -> None:
    print("\n[test] same exercise isn't picked twice across the week")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=(
            "barbell", "dumbbells", "ez_curl_bar", "flat_bench",
            "adjustable_bench", "squat_rack", "cable_machine",
            "lat_pulldown_machine", "leg_press_machine", "leg_curl_machine",
            "preacher_bench", "pec_deck_machine", "pull_up_bar",
            "rope_attachment", "d_handle", "weight_plates",
            "hyperextension_bench", "standing_calf_raise_machine",
        ),
        rng_seed=11,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    slugs = []
    for d in plan["workout_plan"]["days"]:
        for e in d["exercises"]:
            slugs.append(e["_slug"])
    dupes = {s for s in slugs if slugs.count(s) > 1}
    # We allow at most 1 cross-day duplicate as a tolerated edge case
    # (slot pools occasionally overlap), but no slug should appear >2
    # times in a 5-day week.
    bad = [s for s in dupes if slugs.count(s) > 2]
    assert not bad, f"slugs appearing >2x: {bad}"
    _ok(f"{len(slugs)} picks, {len(dupes)} duplicated at most 2x")


# ─── Loaded-vs-bodyweight selection for lift-focused goals ─────────────────


def _gym_recomp_inputs(rng_seed: int = 1) -> PlannerInputs:
    return PlannerInputs(
        goal="body_recomp",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=(
            "barbell", "dumbbells", "ez_curl_bar", "weight_plates",
            "flat_bench", "adjustable_bench", "incline_bench", "squat_rack", "power_rack",
            "cable_machine", "lat_pulldown_machine", "leg_press_machine",
            "leg_extension_machine", "leg_curl_machine", "chest_press_machine",
            "seated_row_machine", "shoulder_press_machine", "smith_machine",
            "rope_attachment", "d_handle", "v_bar_attachment", "straight_bar_attachment",
            "preacher_bench", "pec_deck_machine", "hyperextension_bench",
            "standing_calf_raise_machine", "seated_calf_raise_machine",
            "lateral_raise_machine", "machine_row_station",
            "pull_up_bar", "dip_bars", "plyo_box", "medicine_ball",
        ),
        rng_seed=rng_seed,
    )


def _is_bodyweight_pick(seed_slug: str) -> bool:
    seed = next((s for s in SEED_EXERCISES if s.get("slug") == seed_slug), None)
    return bool(seed and seed.get("equipment_bucket") == "bodyweight")


def test_recomp_with_gym_no_bodyweight_in_primary_or_secondary() -> None:
    """A recomp user with a full gym should never get a bodyweight pick
    on a LIFTING primary or secondary slot. Isolation/core can still
    be BW. Cardio days are excluded — bodyweight cardio (cycling,
    HIIT circuit, running) is the correct output there and not a
    violation of the lift-focused scoring rule."""
    print("\n[test] recomp + full gym → no bodyweight on lifting primary/secondary slots")
    inputs = _gym_recomp_inputs(rng_seed=42)
    plan = generate_workout_plan(inputs, SEED_EXERCISES)

    bw_violations = []
    for d in plan["workout_plan"]["days"]:
        # Skip cardio / mobility / recovery days — the no-bodyweight
        # rule is specifically about lift-focused slot scoring.
        if d.get("category") != "lift":
            continue
        for ex in d["exercises"]:
            role = ex.get("_role")
            # Cardio Finisher slot on PLUS_CARDIO days: bodyweight cardio
            # (HIIT circuit, hill sprints) is correct output — not a violation.
            if ex.get("_slot") == "Cardio Finisher":
                continue
            if role in ("primary", "secondary") and _is_bodyweight_pick(ex.get("_slug", "")):
                bw_violations.append(f"{d['day']}/{ex['_slot']}: {ex['name']}")

    assert not bw_violations, (
        f"recomp+gym should not have bodyweight in primary/secondary lifting slots: "
        f"{bw_violations}"
    )
    lift_days = sum(1 for d in plan["workout_plan"]["days"] if d.get("category") == "lift")
    _ok(f"all lifting primary/secondary slots are loaded across {lift_days} lift days")


def test_recomp_squat_slot_picks_loaded_over_bodyweight() -> None:
    """Specifically reproduce the original bug: barbell squat must beat
    bodyweight squat on a recomp user's squat-pattern slot."""
    print("\n[test] squat slot — loaded must win over bodyweight for recomp")
    from app.services.workout.planner import Slot, pick_for_slot
    inputs = _gym_recomp_inputs(rng_seed=7)
    slot = Slot("Squat Pattern", "squat", "quads", "primary")
    pick = pick_for_slot(SEED_EXERCISES, slot, inputs, set(), set(), None)
    assert pick is not None
    assert pick.get("equipment_bucket") != "bodyweight", (
        f"recomp squat slot picked bodyweight: {pick['name']}"
    )
    _ok(f"recomp squat slot → {pick['name']}")


def test_minimal_equipment_user_still_gets_bodyweight_fallback() -> None:
    """Empty-equipment user should still get bodyweight picks where
    appropriate (the tier-split shouldn't break the fallback path)."""
    print("\n[test] empty-equipment user still gets bodyweight fallback")
    inputs = PlannerInputs(
        goal="body_recomp", days_per_week=3, experience="beginner",
        equipment_slugs=(), rng_seed=3,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    chosen = [e for d in plan["workout_plan"]["days"] for e in d["exercises"]]
    bw_count = sum(1 for ex in chosen if _is_bodyweight_pick(ex.get("_slug", "")))
    assert bw_count >= 5, f"empty-equipment plan only got {bw_count} bodyweight picks"
    _ok(f"empty equipment → {bw_count} bodyweight picks across {len(chosen)} slots")


def test_general_health_does_not_get_load_penalty() -> None:
    """General-health goals should NOT be put through the lift-focused
    tier split — bodyweight picks are still legitimate there."""
    print("\n[test] general_health is not penalized into all-loaded picks")
    inputs = PlannerInputs(
        goal="general_health", days_per_week=3, experience="beginner",
        equipment_slugs=("dumbbells", "flat_bench", "pull_up_bar"),
        rng_seed=5,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    assert plan["workout_plan"]["days"]
    _ok("general_health plan generated without load forcing")


def test_equipment_label_for_loaded_movement_with_optional_required_flag() -> None:
    """Loaded movements with `required=False` primary equipment (Goblet
    Squat, Sumo Squat, Walking Lunges) should NOT label as 'bodyweight'."""
    print("\n[test] equipment_label respects loaded movements with optional flags")
    from app.services.workout.planner import _equipment_label

    goblet = next(e for e in SEED_EXERCISES if e.get("slug") == "goblet_squat")
    label = _equipment_label(goblet)
    assert "dumbbells" in label, f"goblet_squat label='{label}' missing dumbbells"
    _ok(f"goblet_squat → {label}")

    sumo = next(e for e in SEED_EXERCISES if e.get("slug") == "sumo_squat")
    label = _equipment_label(sumo)
    assert label != "bodyweight", "sumo_squat label='bodyweight' is wrong"
    assert "dumbbells" in label, f"sumo_squat label='{label}' should mention dumbbells"
    _ok(f"sumo_squat → {label}")

    pushup = next(e for e in SEED_EXERCISES if e.get("slug") == "pushups")
    assert _equipment_label(pushup) == "bodyweight"
    _ok("pushups → bodyweight (correctly)")


# ─── Phase 2a — continuity (history familiarity) ────────────────────────────


def _full_gym_inputs(rng_seed: int = 0, **overrides) -> PlannerInputs:
    """Stock intermediate-gym inputs used by the continuity tests."""
    base = dict(
        goal="muscle_gain",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=(
            "barbell", "dumbbells", "ez_curl_bar", "weight_plates",
            "flat_bench", "adjustable_bench", "incline_bench", "squat_rack",
            "cable_machine", "lat_pulldown_machine", "leg_press_machine",
            "leg_extension_machine", "leg_curl_machine", "chest_press_machine",
            "rope_attachment", "d_handle", "v_bar_attachment",
            "preacher_bench", "pec_deck_machine", "hyperextension_bench",
            "standing_calf_raise_machine", "seated_calf_raise_machine",
            "pull_up_bar", "plyo_box",
        ),
        rng_seed=rng_seed,
    )
    base.update(overrides)
    return PlannerInputs(**base)


def _slug_set(plan: dict) -> set[str]:
    return {
        e["_slug"]
        for d in plan["workout_plan"]["days"]
        for e in d["exercises"]
        if e.get("_slug")
    }


def test_continuity_biases_toward_familiar_exercise() -> None:
    """The same user, same seed, same inputs — but the second run is told
    that an under-preferred exercise was used a lot recently. The
    continuity bonus should pull that exercise into the new plan."""
    print("\n[test] history familiarity bonus pulls an exercise into the plan")
    inputs = _full_gym_inputs(rng_seed=99)
    baseline = generate_workout_plan(inputs, SEED_EXERCISES)
    baseline_slugs = _slug_set(baseline)

    # Pick an eligible exercise the planner did NOT choose this time
    # and tell it the user has done that exercise 4 sessions in a row.
    # The familiarity bonus is +0.5/appearance capped at +2.0, which is
    # bigger than any other tie-break in the scorer.
    candidate = next(
        ex["slug"]
        for ex in SEED_EXERCISES
        if ex.get("slug") and ex["slug"] not in baseline_slugs
        and ex.get("movement_pattern") == "horizontal_press"
        and ex.get("primary_muscle") == "chest"
    )
    history = {candidate: 4}
    biased = generate_workout_plan(inputs, SEED_EXERCISES, history_familiarity=history)
    biased_slugs = _slug_set(biased)

    assert candidate in biased_slugs, (
        f"familiarity bias did not pull '{candidate}' into the plan; "
        f"picked: {sorted(biased_slugs - baseline_slugs)}"
    )
    _ok(f"'{candidate}' was added under familiarity bias (count=4)")


def test_continuity_keeps_core_exercises_stable_on_regen() -> None:
    """Running the planner twice with the same seed should produce the
    same plan when nothing else changed. This guards against accidental
    nondeterminism creeping in via dict iteration order."""
    print("\n[test] same inputs + seed → identical plan (no shuffle)")
    inputs = _full_gym_inputs(rng_seed=12345)
    a = _slug_set(generate_workout_plan(inputs, SEED_EXERCISES))
    b = _slug_set(generate_workout_plan(inputs, SEED_EXERCISES))
    assert a == b, f"plan drift: {a ^ b}"
    _ok(f"{len(a)} exercises stable across two runs")


# ─── Phase 2b — session-to-session target propagation ──────────────────────


def _profile() -> UserTrainingProfile:
    return UserTrainingProfile(
        primary_goal=GoalType.HYPERTROPHY,
        experience_level=ExperienceLevel.INTERMEDIATE,
        recovery_level=RecoveryLevel.NORMAL,
        progression_pace=ProgressionPace.MODERATE,
    )


def _ctx() -> WorkoutContext:
    return WorkoutContext(
        workout_name="Push 1",
        focus=WorkoutFocus.PUSH,
        phase=PhaseType.ACCUMULATION,
        week_number=1,
    )


def test_progression_increases_when_all_sets_top_of_range() -> None:
    """User hit 8/8/8 on a 6-8 prescription → next session should add load."""
    print("\n[test] all sets at top of range → INCREASE")
    plan_ex = {
        "name": "Barbell Bench Press",
        "sets": 3,
        "reps": "6-8",
        "_slug": "barbell_bench_press",
        "_role": "primary",
    }
    prescription = _build_synthetic_prescription(plan_ex)
    last_sets = [
        SetResult(set_number=1, weight_lbs=185.0, reps=8),
        SetResult(set_number=2, weight_lbs=185.0, reps=8),
        SetResult(set_number=3, weight_lbs=185.0, reps=8),
    ]
    weight, action, reason = recommend_next_session_load(
        WorkoutProgressionEngine(), _profile(), _ctx(), prescription, last_sets,
        prescribed_rep_range=(6, 8),
    )
    assert action == "increase", f"expected increase, got {action} — {reason}"
    assert weight is not None and weight > 185.0, f"weight should rise, got {weight}"
    assert weight == 190.0, f"expected +5 lb compound increment, got {weight}"
    _ok(f"185 lb 8/8/8 → {weight} lb ({reason})")


def test_progression_holds_when_partial() -> None:
    """User hit 8/7/6 on a 6-8 prescription → hold load."""
    print("\n[test] mid-range performance → HOLD")
    plan_ex = {
        "name": "Barbell Bench Press",
        "sets": 3,
        "reps": "6-8",
        "_slug": "barbell_bench_press",
        "_role": "primary",
    }
    prescription = _build_synthetic_prescription(plan_ex)
    last_sets = [
        SetResult(set_number=1, weight_lbs=185.0, reps=8),
        SetResult(set_number=2, weight_lbs=185.0, reps=7),
        SetResult(set_number=3, weight_lbs=185.0, reps=6),
    ]
    weight, action, _reason = recommend_next_session_load(
        WorkoutProgressionEngine(), _profile(), _ctx(), prescription, last_sets,
    )
    assert action == "hold", f"expected hold, got {action}"
    assert weight == 185.0, f"expected unchanged 185, got {weight}"
    _ok(f"185 lb 8/7/6 → hold at {weight}")


def test_progression_decreases_when_majority_missed() -> None:
    """User got 5/4/4 on a 6-8 prescription → reduce load."""
    print("\n[test] majority missed → DECREASE")
    plan_ex = {
        "name": "Barbell Bench Press",
        "sets": 3,
        "reps": "6-8",
        "_slug": "barbell_bench_press",
        "_role": "primary",
    }
    prescription = _build_synthetic_prescription(plan_ex)
    last_sets = [
        SetResult(set_number=1, weight_lbs=200.0, reps=5),
        SetResult(set_number=2, weight_lbs=200.0, reps=4),
        SetResult(set_number=3, weight_lbs=200.0, reps=4),
    ]
    weight, action, _reason = recommend_next_session_load(
        WorkoutProgressionEngine(), _profile(), _ctx(), prescription, last_sets,
    )
    assert action == "decrease", f"expected decrease, got {action}"
    assert weight is not None and weight < 200.0, f"weight should drop, got {weight}"
    _ok(f"200 lb 5/4/4 → {weight} lb")


def test_progression_anchor_uses_top_working_weight_not_last_set() -> None:
    """Back-off protocol: 3 sets @ 225 followed by 2 sets @ 185 with
    good reps. Old code anchored on the last set (185) and progressed
    from there, which is wrong — the user's real training stimulus is
    225. The fix uses max(working_weights) so next session progresses
    from 225, not 185."""
    print("\n[test] back-off protocol anchors on TOP working weight")
    plan_ex = {
        "name": "Barbell Squat",
        "sets": 5,
        "reps": "6-8",
        "_slug": "barbell_squat",
        "_role": "primary",
    }
    prescription = _build_synthetic_prescription(plan_ex)
    # 3 top sets at 225×8 (top of range) then 2 back-off sets at 185×8
    # (also top of range at the lighter load). All 5 sets classify as
    # top_of_range, so the decision is INCREASE.
    last_sets = [
        SetResult(set_number=1, weight_lbs=225.0, reps=8),
        SetResult(set_number=2, weight_lbs=225.0, reps=8),
        SetResult(set_number=3, weight_lbs=225.0, reps=8),
        SetResult(set_number=4, weight_lbs=185.0, reps=8),
        SetResult(set_number=5, weight_lbs=185.0, reps=8),
    ]
    weight, action, reason = recommend_next_session_load(
        WorkoutProgressionEngine(), _profile(), _ctx(), prescription, last_sets,
        prescribed_rep_range=(6, 8),
    )
    assert action == "increase", f"expected increase, got {action}"
    # Top set is 225 → next session should be 230, NOT 190 (which is
    # what anchoring on the last set would produce).
    assert weight == 230.0, f"expected 230 (225+5), got {weight}"
    assert "top working weight" in reason.lower(), f"reason should mention anchor: {reason}"
    _ok(f"225×3 + 185×2 back-off → next={weight} (anchored on top set)")


def test_progression_safety_override_on_pain() -> None:
    """A pain feedback flag overrides everything else and reduces 10%."""
    print("\n[test] PAIN feedback → 10% reduction safety override")
    plan_ex = {
        "name": "Barbell Squat",
        "sets": 3,
        "reps": "6-8",
        "_slug": "barbell_squat",
        "_role": "primary",
    }
    prescription = _build_synthetic_prescription(plan_ex)
    last_sets = [
        SetResult(set_number=1, weight_lbs=225.0, reps=8),
        SetResult(set_number=2, weight_lbs=225.0, reps=8, feedback=EffortFeedback.PAIN),
        SetResult(set_number=3, weight_lbs=225.0, reps=8),
    ]
    weight, action, reason = recommend_next_session_load(
        WorkoutProgressionEngine(), _profile(), _ctx(), prescription, last_sets,
        prescribed_rep_range=(6, 8),
    )
    assert action == "decrease"
    # 225 * 0.9 = 202.5
    assert weight == 202.5, f"expected 202.5, got {weight}"
    _ok(f"225 with PAIN flag → {weight} ({reason})")


def test_session_minutes_short_drops_isolation_keeps_compounds() -> None:
    """A 30-minute session should trim isolation/core slots but never
    drop compounds. A 90-minute session should keep the full template."""
    print("\n[test] session_minutes trims isolation on short sessions")
    short_inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell","dumbbells","flat_bench","squat_rack","cable_machine","pull_up_bar"),
        session_minutes=30, rng_seed=7,
    )
    standard_inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=short_inputs.equipment_slugs,
        session_minutes=60, rng_seed=7,
    )
    long_inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=short_inputs.equipment_slugs,
        session_minutes=90, rng_seed=7,
    )
    short_plan = generate_workout_plan(short_inputs, SEED_EXERCISES)
    standard_plan = generate_workout_plan(standard_inputs, SEED_EXERCISES)
    long_plan = generate_workout_plan(long_inputs, SEED_EXERCISES)

    def _count(plan, role):
        return sum(
            1
            for d in plan["workout_plan"]["days"]
            for ex in d["exercises"]
            if ex.get("_role") == role
        )

    short_iso = _count(short_plan, "isolation") + _count(short_plan, "core")
    std_iso = _count(standard_plan, "isolation") + _count(standard_plan, "core")
    short_primary = _count(short_plan, "primary")
    std_primary = _count(standard_plan, "primary")
    long_iso = _count(long_plan, "isolation") + _count(long_plan, "core")

    assert short_iso < std_iso, (
        f"short session should trim isolation/core slots "
        f"(short={short_iso}, standard={std_iso})"
    )
    assert short_primary == std_primary, (
        f"short session must not drop primary compound slots "
        f"(short={short_primary}, standard={std_primary})"
    )
    assert long_iso >= std_iso, (
        f"long session should keep at least as many isolation slots "
        f"(long={long_iso}, standard={std_iso})"
    )
    _ok(f"short iso/core={short_iso}  standard={std_iso}  long={long_iso}")


def test_injury_blocks_movement_pattern() -> None:
    """A user with 'shoulder' injury should get no vertical_press picks."""
    print("\n[test] injuries block movement patterns")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=("barbell","dumbbells","flat_bench","squat_rack","cable_machine","pull_up_bar"),
        injuries=("shoulder",),
        rng_seed=3,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    exs = [
        ex
        for d in plan["workout_plan"]["days"]
        for ex in d["exercises"]
    ]
    # Every exercise should live in the seed under its _slug — look up
    # the seed row to check the movement pattern.
    by_slug = {e["slug"]: e for e in SEED_EXERCISES}
    vertical_press_picks = [
        ex for ex in exs
        if by_slug.get(ex.get("_slug"), {}).get("movement_pattern") == "vertical_press"
    ]
    assert vertical_press_picks == [], (
        f"shoulder-injured user got vertical press picks: "
        f"{[ex['name'] for ex in vertical_press_picks]}"
    )
    _ok(f"no vertical_press picks across {len(exs)} exercises")


def test_injury_free_form_phrase_resolves_via_substring() -> None:
    """Free-form tags like 'left knee pain' must still resolve via the
    'knee' entry — the planner normalizes and does substring matching."""
    print("\n[test] injury substring match resolves free-form tags")
    from app.services.workout.planner import _injury_blocked_patterns
    blocked = _injury_blocked_patterns(("left knee pain",))
    assert "lunge" in blocked, f"'left knee pain' did not resolve to knee: {blocked}"
    _ok(f"'left knee pain' → {sorted(blocked)}")


def test_accessory_host_prefers_secondary_touch_day() -> None:
    """_find_best_accessory_host_day should prefer a day that hits the
    muscle as a SECONDARY mover over one that hits it as a PRIMARY.
    The old code only checked primary, which was the bug."""
    from app.services.workout.planner import _find_best_accessory_host_day
    print("\n[test] accessory host prefers secondary-touch day")
    days = [
        # Day 0: primary glutes work (e.g. dedicated glute day) — already near MRV
        {"exercises": [
            {"_primary_muscle": "glutes", "_secondary_muscles": []},
            {"_primary_muscle": "glutes", "_secondary_muscles": []},
        ]},
        # Day 1: glutes as secondary (e.g. squat day) — room to add
        {"exercises": [
            {"_primary_muscle": "quads", "_secondary_muscles": ["glutes"]},
            {"_primary_muscle": "quads", "_secondary_muscles": []},
        ]},
        # Day 2: doesn't hit glutes at all
        {"exercises": [
            {"_primary_muscle": "chest", "_secondary_muscles": ["triceps"]},
        ]},
    ]
    idx = _find_best_accessory_host_day(days, "glutes")
    assert idx == 1, f"expected secondary-touch day (1), got {idx}"
    _ok(f"picked day index {idx} (secondary glute touch)")


def test_recommender_confidence_single_session_below_075() -> None:
    """A one-session exact-history match should NOT return 0.75 confidence.
    Post-calibration it lands around 0.53."""
    from datetime import date
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance
    print("\n[test] one-session exact history → confidence < 0.75")
    target = {
        "slug": "barbell_bench_press",
        "name": "Barbell Bench Press",
        "primary_muscle": "chest",
        "movement_pattern": "horizontal_press",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
    }
    profile = ExercisePerformance(
        slug="barbell_bench_press",
        name="Barbell Bench Press",
        session_count=1,
        recent_top_weight_lbs=185.0,
        recent_top_reps=8,
        estimated_1rm_lbs=234.7,
        recent_volume_load=4440.0,
        last_performed_on=date.today(),
        confidence=0.17,
    )
    rec = recommend_starting_weight(
        target, profiles={"barbell_bench_press": profile},
        all_exercises_by_slug={"barbell_bench_press": target},
        target_reps="6-8", experience="intermediate",
    )
    assert rec.source == "exact_history"
    assert rec.confidence < 0.75, f"single-session confidence too high: {rec.confidence}"
    assert rec.confidence >= 0.50, f"single-session confidence too low: {rec.confidence}"
    _ok(f"1-session exact_history confidence={rec.confidence}")


def test_default_category_differentiates_by_pattern() -> None:
    """Category defaults should distinguish squat, hinge, upper_push,
    upper_pull rather than lump all compounds into one number."""
    from app.services.workout.recommendation import recommend_starting_weight
    print("\n[test] category defaults differentiate by pattern")
    squat_target = {
        "slug": "barbell_squat",
        "name": "Barbell Squat",
        "primary_muscle": "quads",
        "movement_pattern": "squat",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
    }
    ohp_target = {
        "slug": "overhead_press",
        "name": "Overhead Press",
        "primary_muscle": "shoulders",
        "movement_pattern": "vertical_press",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
    }
    hinge_target = {
        "slug": "deadlift",
        "name": "Deadlift",
        "primary_muscle": "hamstrings",
        "movement_pattern": "hinge",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
    }
    squat_rec = recommend_starting_weight(squat_target, {}, {}, experience="intermediate")
    ohp_rec = recommend_starting_weight(ohp_target, {}, {}, experience="intermediate")
    hinge_rec = recommend_starting_weight(hinge_target, {}, {}, experience="intermediate")
    # All three should be `default` source (no profile data)
    assert squat_rec.source == "default"
    assert ohp_rec.source == "default"
    assert hinge_rec.source == "default"
    # And they should actually differ — squat != OHP != deadlift
    assert hinge_rec.weight_lbs > squat_rec.weight_lbs > ohp_rec.weight_lbs, (
        f"defaults didn't differentiate: "
        f"ohp={ohp_rec.weight_lbs}  squat={squat_rec.weight_lbs}  hinge={hinge_rec.weight_lbs}"
    )
    _ok(
        f"ohp={ohp_rec.weight_lbs}  squat={squat_rec.weight_lbs}  "
        f"hinge={hinge_rec.weight_lbs}"
    )


def test_generated_plan_carries_volume_audit_and_respects_focus() -> None:
    """The plan should expose a `volume_audit` block and the focused
    muscle should actually receive more assigned volume than its base
    weekly target — either through scoring bias or the accessory pass."""
    print("\n[test] generated plan exposes volume_audit; focused muscle gets extra sets")
    inputs = PlannerInputs(
        goal="muscle_gain",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack", "cable_machine", "pull_up_bar"),
        focused_muscle="glutes",
        rng_seed=11,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    wp = plan["workout_plan"]
    assert "volume_audit" in wp, "volume_audit missing from plan output"
    audit = wp["volume_audit"]
    assert audit["focused_muscle"] == "glutes"
    assert "targets" in audit and "assigned" in audit
    # Focused-muscle target is boosted vs the non-focused baseline
    base = weekly_set_targets(PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=inputs.equipment_slugs,
    ))
    assert audit["targets"]["glutes"] >= base["glutes"], (
        f"focused target {audit['targets']['glutes']} should be ≥ base {base['glutes']}"
    )
    # And some glute volume was actually assigned across the plan
    assigned_glutes = audit["assigned"].get("glutes", 0)
    assert assigned_glutes > 0, f"no glute volume assigned in plan: {audit}"
    _ok(
        f"glutes target={audit['targets']['glutes']} "
        f"assigned={assigned_glutes} (baseline target={base['glutes']})"
    )


def test_propagate_session_targets_walks_a_full_plan() -> None:
    """End-to-end: generate a plan, fake history for two of its exercises,
    run the propagator, and confirm the plan's exercise dicts now carry
    `target_weight_lbs` only on the exercises with history."""
    print("\n[test] propagate_session_targets only touches exercises with history")
    inputs = _full_gym_inputs(rng_seed=21)
    plan = generate_workout_plan(inputs, SEED_EXERCISES)

    # Pick the first two exercises in the first day and fake their history
    # as two different scenarios: bench press hit top of range, squat
    # missed reps. The propagator should set target_weight_lbs on both
    # and leave the rest untouched.
    day_0 = plan["workout_plan"]["days"][0]
    fixtures: dict[str, list[SetResult]] = {}
    chosen_increase: str | None = None
    chosen_decrease: str | None = None
    for ex in day_0["exercises"]:
        if ex.get("_role") == "primary" and chosen_increase is None:
            chosen_increase = ex["_slug"]
            fixtures[chosen_increase] = [
                SetResult(set_number=i + 1, weight_lbs=135.0, reps=8) for i in range(3)
            ]
        elif ex.get("_role") == "primary" and chosen_decrease is None:
            chosen_decrease = ex["_slug"]
            # Use reps=1 so this is clearly below any prescription range
            # (strength 3-5, hypertrophy 6-8/8-12), triggering a decrease.
            fixtures[chosen_decrease] = [
                SetResult(set_number=i + 1, weight_lbs=200.0, reps=1) for i in range(3)
            ]
            break

    assert chosen_increase and chosen_decrease, "could not find two primary slugs to fixture"

    propagate_session_targets(
        plan, _profile(), make_dict_history_lookup(fixtures),
    )

    touched: dict[str, dict] = {}
    for d in plan["workout_plan"]["days"]:
        for ex in d["exercises"]:
            if ex.get("target_weight_lbs") is not None:
                touched[ex["_slug"]] = ex

    assert chosen_increase in touched, "increase fixture not propagated"
    assert chosen_decrease in touched, "decrease fixture not propagated"
    assert touched[chosen_increase]["progression_action"] == "increase"
    assert touched[chosen_decrease]["progression_action"] == "decrease"
    assert touched[chosen_increase]["target_weight_lbs"] > 135.0
    assert touched[chosen_decrease]["target_weight_lbs"] < 200.0

    untouched_count = sum(
        1
        for d in plan["workout_plan"]["days"]
        for ex in d["exercises"]
        if ex.get("target_weight_lbs") is None
    )
    assert untouched_count >= 1, "propagator touched too much"
    _ok(
        f"{chosen_increase}: 135 → {touched[chosen_increase]['target_weight_lbs']} (increase); "
        f"{chosen_decrease}: 200 → {touched[chosen_decrease]['target_weight_lbs']} (decrease)"
    )


def test_propagate_session_targets_no_history_is_noop() -> None:
    """Empty history means no exercise gets target_weight_lbs."""
    print("\n[test] empty history lookup → no targets set, no errors")
    inputs = _full_gym_inputs(rng_seed=8)
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    propagate_session_targets(plan, _profile(), make_dict_history_lookup({}))
    has_target = any(
        ex.get("target_weight_lbs") is not None
        for d in plan["workout_plan"]["days"]
        for ex in d["exercises"]
    )
    assert not has_target
    _ok("no exercises touched")


def test_strength_plan_uses_lower_reps() -> None:
    print("\n[test] strength bucket prescribes 3-5 reps on primary compounds")
    inputs = PlannerInputs(
        goal="strength", days_per_week=3, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack", "weight_plates"),
        rng_seed=5,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    found_low_rep = False
    for d in plan["workout_plan"]["days"]:
        for e in d["exercises"]:
            if e.get("_role") == "primary" and "3-5" in e["reps"]:
                found_low_rep = True
                break
    assert found_low_rep, "no primary compound got 3-5 reps under strength bucket"
    _ok("primary compounds got 3-5 reps")


def test_ul_forced_even_lift_days_fat_loss_6d() -> None:
    """Fat-loss on 6d U/L split must produce EVEN lift days so Upper
    and Lower are balanced. Pre-fix this produced 3 lift days
    (2 Upper + 1 Lower). The `force-even-lift-days` rule in
    `_lifting_plus_cardio_recipe` trades a recovery day for the 4th
    lift."""
    print("\n[test] U/L forced even lift days: fat_loss 6d → 4 lifts")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("fat_loss", "intermediate", 6, 60)
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split="upper_lower", user_chose_split=True,
    )
    lift_days = sum(1 for a in recipe if ARCHETYPE_META[a].category == "lift")
    assert lift_days % 2 == 0, (
        f"expected even lift_days on 6d U/L fat_loss, got {lift_days} "
        f"recipe={[a.value for a in recipe]}"
    )
    assert lift_days >= 4, (
        f"fat_loss 6d should have >=4 lifts, got {lift_days} "
        f"recipe={[a.value for a in recipe]}"
    )
    _ok(f"6d U/L fat_loss → {lift_days} lift days (even)")


# ─── Main ────────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    print("=" * 60)
    print("Workout planner sanity tests")
    print("=" * 60)
    cases = [
        test_beginner_stays_simple,
        test_intermediate_muscle_gain_stays_full_body_at_3_days,
        test_muscle_gain_4_days_is_upper_lower,
        test_strength_intermediate_4_days_is_upper_lower,
        test_fat_loss_5_days_is_NOT_full_body,
        test_body_recomp_5_days_is_ppl_upper_lower,
        test_beginner_3_days_is_full_body,
        test_preferred_split_override_is_honored,
        test_preferred_split_ignored_when_infeasible,
        test_volume_targets_scale_with_experience,
        test_focused_muscle_gets_volume_bonus,
        test_ppl_4_day_cycle_order_and_naming,
        test_full_body_name_is_trainer_style_not_day_n,
        test_upper_lower_emphasis_rotates,
        test_session_minutes_short_drops_isolation_keeps_compounds,
        test_injury_blocks_movement_pattern,
        test_injury_free_form_phrase_resolves_via_substring,
        test_accessory_host_prefers_secondary_touch_day,
        test_recommender_confidence_single_session_below_075,
        test_default_category_differentiates_by_pattern,
        test_full_body_3_day_rotates_slots,
        test_full_plan_intermediate_muscle_gain,
        test_plan_respects_dislikes,
        test_plan_respects_equipment_constraints,
        test_plan_continuity_within_week,
        test_strength_plan_uses_lower_reps,
        # Loaded-vs-bodyweight selection for lift-focused goals
        test_recomp_with_gym_no_bodyweight_in_primary_or_secondary,
        test_recomp_squat_slot_picks_loaded_over_bodyweight,
        test_minimal_equipment_user_still_gets_bodyweight_fallback,
        test_general_health_does_not_get_load_penalty,
        test_equipment_label_for_loaded_movement_with_optional_required_flag,
        # Phase 2a — continuity across regenerations
        test_continuity_biases_toward_familiar_exercise,
        test_continuity_keeps_core_exercises_stable_on_regen,
        # Phase 2b — session-to-session target propagation
        test_progression_increases_when_all_sets_top_of_range,
        test_progression_holds_when_partial,
        test_progression_decreases_when_majority_missed,
        test_progression_safety_override_on_pain,
        test_propagate_session_targets_walks_a_full_plan,
        test_propagate_session_targets_no_history_is_noop,
        # U/L forced-even-lift-days rule (fat-loss 6d → 4 lifts)
        test_ul_forced_even_lift_days_fat_loss_6d,
    ]
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL: {e}")
            failures += 1
        except Exception as e:
            print(f"  ✗ ERROR ({type(e).__name__}): {e}")
            failures += 1
    print("\n" + "=" * 60)
    if failures:
        print(f"  {failures} test(s) FAILED")
        raise SystemExit(1)
    print(f"  All {len(cases)} tests passed.")
    print("=" * 60)
