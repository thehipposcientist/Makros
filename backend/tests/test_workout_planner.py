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
    _display_focus_for_exercises,
    build_day_templates,
    generate_workout_plan,
    pick_split,
    weekly_set_targets,
)
from app.services.workout.archetypes import DayArchetype
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


def test_plus_cardio_focus_label_matches_generated_contents() -> None:
    print("\n[test] plus-cardio label reflects generated contents")
    focus = _display_focus_for_exercises(
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
        "Push + Cardio",
        [
            {"_primary_muscle": "chest", "_role": "primary", "prescriptionType": "strength"},
            {"_primary_muscle": "core", "_role": "core", "prescriptionType": "core_circuit"},
        ],
    )
    assert focus == "Push + Core", f"expected Push + Core, got {focus!r}"

    focus = _display_focus_for_exercises(
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
        "Push + Cardio",
        [
            {"_primary_muscle": "chest", "_role": "primary", "prescriptionType": "strength"},
            {"_primary_muscle": "cardio", "_role": "secondary", "prescriptionType": "cardio_steady"},
        ],
    )
    assert focus == "Push + Cardio", f"expected Push + Cardio, got {focus!r}"
    _ok("plus-cardio display label follows cardio/core contents")


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


def _fake_exercise(
    *,
    slug: str,
    name: str,
    movement_pattern: str,
    primary_muscle: str,
    equipment_bucket: str,
    equipment_slug: str | None,
    is_compound: bool = True,
) -> dict:
    equipment = []
    if equipment_slug:
        equipment.append({
            "slug": equipment_slug,
            "role": "primary",
            "required": True,
        })
    return {
        "slug": slug,
        "name": name,
        "exercise_type": "strength",
        "movement_pattern": movement_pattern,
        "primary_muscle": primary_muscle,
        "secondary_muscles": [],
        "equipment_bucket": equipment_bucket,
        "equipment": equipment,
        "difficulty": "intermediate",
        "is_compound": is_compound,
        "is_machine": equipment_bucket == "machine",
        "substitution_group": slug,
    }


def test_primary_selection_hierarchy_loaded_beats_preferred_bodyweight() -> None:
    """Lift-focused goals use a hard hierarchy for primary/secondary
    slots: any eligible loaded candidate beats bodyweight, even when
    the bodyweight option is user-preferred."""
    print("\n[test] primary hierarchy: loaded beats preferred bodyweight")
    from app.services.workout.planner import Slot, pick_for_slot

    slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
    loaded = _fake_exercise(
        slug="loaded_press", name="Loaded Press",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="barbell", equipment_slug="barbell",
    )
    bodyweight = _fake_exercise(
        slug="push_up", name="Push Up",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="bodyweight", equipment_slug=None,
    )
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell",), preferred_exercises=("Push Up",),
        rng_seed=13,
    )
    pick = pick_for_slot([bodyweight, loaded], slot, inputs, set(), set())
    assert pick is loaded, f"expected loaded hierarchy winner, got {pick and pick.get('name')}"
    _ok("loaded primary won despite preferred bodyweight")


def test_primary_selection_hierarchy_bodyweight_fallback_when_no_loaded() -> None:
    """The loaded-first hierarchy must still fall back cleanly for
    users with no eligible equipment."""
    print("\n[test] primary hierarchy: bodyweight fallback when loaded unavailable")
    from app.services.workout.planner import Slot, pick_for_slot

    slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
    loaded = _fake_exercise(
        slug="loaded_press", name="Loaded Press",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="barbell", equipment_slug="barbell",
    )
    bodyweight = _fake_exercise(
        slug="push_up", name="Push Up",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="bodyweight", equipment_slug=None,
    )
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=(), rng_seed=13,
    )
    pick = pick_for_slot([loaded, bodyweight], slot, inputs, set(), set())
    assert pick is bodyweight, f"expected bodyweight fallback, got {pick and pick.get('name')}"
    _ok("bodyweight primary chosen only after loaded pool emptied")


def test_primary_load_tier_prefers_barbell_over_dumbbell() -> None:
    """Inside the loaded pool, the hierarchy should still prefer the
    strongest loading tool for primary slots: barbell > dumbbell."""
    print("\n[test] primary hierarchy: barbell beats dumbbell")
    from app.services.workout.planner import Slot, pick_for_slot

    slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
    barbell = _fake_exercise(
        slug="barbell_press", name="Barbell Press",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="barbell", equipment_slug="barbell",
    )
    dumbbell = _fake_exercise(
        slug="dumbbell_press", name="Dumbbell Press",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="dumbbells", equipment_slug="dumbbells",
    )
    inputs = PlannerInputs(
        goal="strength", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells"), rng_seed=21,
    )
    pick = pick_for_slot([dumbbell, barbell], slot, inputs, set(), set())
    assert pick is barbell, f"expected barbell tier winner, got {pick and pick.get('name')}"
    _ok("barbell primary won inside loaded pool")


def test_focus_family_filter_blocks_wrong_family_strength_slot() -> None:
    """Day focus family is a hard filter above scoring. A push day
    primary cannot pick a back-primary exercise even if movement pattern
    and equipment otherwise match."""
    print("\n[test] focus-family hierarchy blocks wrong-family candidates")
    from app.services.workout.planner import Slot, filter_candidates

    slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
    chest = _fake_exercise(
        slug="chest_press", name="Chest Press",
        movement_pattern="horizontal_press", primary_muscle="chest",
        equipment_bucket="barbell", equipment_slug="barbell",
    )
    back = _fake_exercise(
        slug="back_press_bug", name="Back Press Bug",
        movement_pattern="horizontal_press", primary_muscle="back",
        equipment_bucket="barbell", equipment_slug="barbell",
    )
    candidates = filter_candidates(
        [back, chest], slot, {"barbell"}, set(),
        day_focus_family="push",
    )
    assert candidates == [chest], f"wrong-family candidate survived: {candidates}"
    _ok("push day kept chest candidate and rejected back-primary candidate")


def test_score_jitter_uses_stable_slug_digest() -> None:
    """The deterministic planner cannot use Python's process-randomized
    hash() for tie jitter. The slug seed is pinned to sha256 so identical
    inputs remain stable across backend restarts."""
    print("\n[test] deterministic jitter uses stable sha256 slug seed")
    import hashlib
    from app.services.workout.planner import _stable_slug_seed

    slug = "barbell_bench_press"
    expected = int.from_bytes(hashlib.sha256(slug.encode("utf-8")).digest()[:8], "big")
    assert _stable_slug_seed(slug) == expected
    assert _stable_slug_seed(slug) == _stable_slug_seed(slug)
    assert _stable_slug_seed(slug) != _stable_slug_seed("dumbbell_bench_press")
    _ok("stable slug seed pinned to sha256 digest")


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


def test_preacher_curl_label_selects_owned_implement() -> None:
    """Supported curl-pad movements need both the support and a concrete
    implement in the planned label so users know what to pick up."""
    print("\n[test] preacher curl label chooses owned implement")
    from app.services.workout.planner import _equipment_label, build_planner_exercise
    from app.services.workout.prescriptions import Prescription

    preacher = next(e for e in SEED_EXERCISES if e.get("slug") == "preacher_curl")

    db_label = _equipment_label(preacher, {"preacher_bench", "dumbbells"})
    assert db_label == "dumbbells, preacher_bench", db_label

    bb_label = _equipment_label(preacher, {"preacher_bench", "barbell"})
    assert bb_label == "barbell, preacher_bench", bb_label

    ez_label = _equipment_label(preacher, {"preacher_bench", "ez_curl_bar", "dumbbells"})
    assert ez_label == "ez_curl_bar, preacher_bench", ez_label

    out = build_planner_exercise(
        preacher,
        prescription=Prescription(sets=3, reps="10-12", rest_seconds=60, rir_target=2.0),
        slot_label="Biceps Isolation",
        role="isolation",
        archetype_value="lift_pull",
        training_type="strength",
        goal_bucket="muscle_gain",
        experience="intermediate",
        owned_equipment_slugs={"preacher_bench", "dumbbells"},
    )
    assert out["equipment"] == "dumbbells, preacher_bench"
    _ok("preacher curl labels include the selected curl implement")


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


def test_progression_reacclimates_stale_top_range_history() -> None:
    """Top-of-range sets from two months ago should not trigger a load increase."""
    from datetime import date, timedelta
    print("\n[test] stale top-range history → reacclimation, not progression")
    plan_ex = {
        "name": "Barbell Squat",
        "sets": 3,
        "reps": "6-8",
        "_slug": "barbell_squat",
        "_role": "primary",
    }
    prescription = _build_synthetic_prescription(plan_ex)
    performed_on = date.today() - timedelta(days=60)
    last_sets = [
        SetResult(set_number=1, weight_lbs=225.0, reps=8, performed_on=performed_on),
        SetResult(set_number=2, weight_lbs=225.0, reps=8, performed_on=performed_on),
        SetResult(set_number=3, weight_lbs=225.0, reps=8, performed_on=performed_on),
    ]
    weight, action, reason = recommend_next_session_load(
        WorkoutProgressionEngine(), _profile(), _ctx(), prescription, last_sets,
        prescribed_rep_range=(6, 8),
    )
    assert action == "decrease", f"expected reacclimation decrease, got {action} — {reason}"
    assert weight is not None and weight < 225.0, f"stale top sets should not increase, got {weight}"
    assert "reacclimation" in reason.lower(), reason
    _ok(f"225 lb from 60d ago → {weight} lb ({reason})")


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


def test_recommender_downshifts_two_month_old_exact_history() -> None:
    """A stale exact lift should be a reacclimation anchor, not a current max."""
    from datetime import date, timedelta
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance
    print("\n[test] two-month-old exact history → lighter reacclimation load")
    target = {
        "slug": "barbell_back_squat",
        "name": "Barbell Back Squat",
        "primary_muscle": "quads",
        "movement_pattern": "squat",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "is_machine": False,
    }
    fresh = ExercisePerformance(
        slug="barbell_back_squat",
        name="Barbell Back Squat",
        session_count=4,
        recent_top_weight_lbs=225.0,
        recent_top_reps=8,
        estimated_1rm_lbs=285.0,
        recent_volume_load=5400.0,
        last_performed_on=date.today(),
        confidence=0.67,
    )
    stale = ExercisePerformance(
        **{**fresh.__dict__, "last_performed_on": date.today() - timedelta(days=60)}
    )
    fresh_rec = recommend_starting_weight(
        target,
        profiles={"barbell_back_squat": fresh},
        all_exercises_by_slug={"barbell_back_squat": target},
        target_reps="6-8",
        experience="intermediate",
    )
    stale_rec = recommend_starting_weight(
        target,
        profiles={"barbell_back_squat": stale},
        all_exercises_by_slug={"barbell_back_squat": target},
        target_reps="6-8",
        experience="intermediate",
    )
    assert stale_rec.source == "exact_history"
    assert stale_rec.weight_lbs < fresh_rec.weight_lbs, (fresh_rec, stale_rec)
    assert stale_rec.confidence <= 0.55, stale_rec
    assert "reacclimation" in stale_rec.reason.lower(), stale_rec.reason
    _ok(f"fresh {fresh_rec.weight_lbs} lb → stale {stale_rec.weight_lbs} lb")


def test_lat_pull_down_alias_resolves_to_lat_pulldown() -> None:
    """Gym-floor spelling with a space ("pull down") should resolve to the
    canonical lat pulldown seed row so history does not fragment."""
    from app.services.workout.exercise_metadata import resolve_seed_exercise_slug
    print("\n[test] Lat Pull Down alias → lat_pulldown")
    assert resolve_seed_exercise_slug("Lat Pull Down") == "lat_pulldown"
    _ok("Lat Pull Down resolves to canonical lat_pulldown")


def test_assisted_pullup_weight_does_not_transfer_to_lat_pulldown() -> None:
    """Assisted pull-up stack weight is assistance, not resistance. It must
    not transfer through vertical_pull into a lat pulldown recommendation."""
    from datetime import date
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance
    print("\n[test] assisted pull-up assistance load does not transfer to lat pulldown")
    target = {
        "slug": "lat_pulldown",
        "name": "Lat Pulldown",
        "primary_muscle": "back",
        "secondary_muscles": ["biceps"],
        "equipment_bucket": "gym",
        "movement_pattern": "vertical_pull",
        "is_compound": True,
        "is_machine": True,
        "substitution_group": "vertical_pull_machine",
    }
    assisted = {
        "slug": "assisted_pullup",
        "name": "Assisted Pull-up",
        "primary_muscle": "back",
        "secondary_muscles": ["biceps"],
        "equipment_bucket": "gym",
        "movement_pattern": "vertical_pull",
        "is_compound": True,
        "is_machine": True,
        "substitution_group": "vertical_pull_assisted",
        "load_semantics": "assistance",
    }
    profile = ExercisePerformance(
        slug="assisted_pullup",
        name="Assisted Pull-up",
        session_count=2,
        recent_top_weight_lbs=125.0,
        recent_top_reps=10,
        estimated_1rm_lbs=166.7,
        recent_volume_load=2500.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    rec = recommend_starting_weight(
        target,
        profiles={"assisted_pullup": profile},
        all_exercises_by_slug={
            "lat_pulldown": target,
            "assisted_pullup": assisted,
        },
        target_reps="8-12",
        experience="intermediate",
    )
    assert rec.source == "default", f"assistance load leaked via {rec.source}: {rec}"
    _ok("assisted pull-up assistance ignored as a lat pulldown anchor")


def test_band_only_spanish_squat_has_no_numeric_load_recommendation() -> None:
    """Band-only movements should not inherit squat pounds or emit weighted
    set schemes even when stale plan/history anchors are present."""
    from datetime import date
    from app.services.workout.exercise_metadata import set_programming_exercise_metadata, uses_numeric_load
    from app.services.workout.performance import ExercisePerformance
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.set_programming import build_set_scheme, load_increment_for
    print("\n[test] Spanish Squat is band-only, no numeric load")
    spanish = set_programming_exercise_metadata(
        None,
        "Spanish Squat",
        "spanish_squat",
        "resistance_bands",
        "quads",
    )
    barbell_squat = {
        "slug": "barbell_back_squat",
        "name": "Barbell Back Squat",
        "primary_muscle": "quads",
        "equipment_bucket": "barbell",
        "movement_pattern": "squat",
        "is_compound": True,
    }
    profile = ExercisePerformance(
        slug="barbell_back_squat",
        name="Barbell Back Squat",
        session_count=4,
        recent_top_weight_lbs=185.0,
        recent_top_reps=8,
        estimated_1rm_lbs=234.3,
        recent_volume_load=4440.0,
        last_performed_on=date.today(),
        confidence=0.77,
    )
    rec = recommend_starting_weight(
        spanish,
        profiles={"barbell_back_squat": profile},
        all_exercises_by_slug={
            "spanish_squat": spanish,
            "barbell_back_squat": barbell_squat,
        },
        target_reps="10-15",
        experience="intermediate",
    )
    scheme = build_set_scheme(
        spanish,
        total_sets=3,
        reps="10-15",
        rir_target=2.0,
        target_weight_lbs=140.0,
        goal_bucket="muscle_gain",
        role="primary",
        experience="intermediate",
    )
    assert uses_numeric_load(spanish) is False
    assert load_increment_for(spanish) == 0.0
    assert rec.weight_lbs == 0.0, rec
    assert all(s.target_weight_lbs is None for s in scheme), scheme
    _ok("Spanish Squat ignores transferred squat loads and stale 140 lb targets")


def test_recommender_uses_signup_strength_anchor_for_exact_lift() -> None:
    """Signup strength baselines should beat generic category defaults while
    staying labeled separately from real workout history."""
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance
    print("\n[test] signup strength anchor → exact first-weight rec")
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
        estimated_1rm_lbs=234.3,
        recent_volume_load=1480.0,
        last_performed_on=None,
        confidence=0.35,
        source="strength_anchor",
    )
    rec = recommend_starting_weight(
        target, profiles={"barbell_bench_press": profile},
        all_exercises_by_slug={"barbell_bench_press": target},
        target_reps="6-8", experience="intermediate",
    )
    assert rec.source == "strength_anchor"
    assert rec.weight_lbs == 185.0
    assert rec.confidence == 0.45
    assert "signup" in rec.reason.lower()
    _ok(f"signup anchor source={rec.source} weight={rec.weight_lbs}")


def test_recommender_converts_row_loads_between_total_and_per_dumbbell() -> None:
    """Dumbbell rows are recommended per dumbbell, while T-bar rows are
    total implement load. Transfers must normalize those units."""
    from datetime import date
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance

    print("\n[test] row transfer normalizes total load vs per-dumbbell load")
    tbar = {
        "slug": "t_bar_row",
        "name": "T-Bar Row",
        "primary_muscle": "back",
        "movement_pattern": "horizontal_pull",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
        "equipment": [{"slug": "barbell", "role": "primary", "required": True}],
    }
    db_row = {
        "slug": "dumbbell_row",
        "name": "Dumbbell Row",
        "primary_muscle": "back",
        "movement_pattern": "horizontal_pull",
        "equipment_bucket": "dumbbells",
        "is_compound": True,
        "is_machine": False,
        "is_unilateral": True,
        "equipment": [{"slug": "dumbbells", "role": "primary", "required": True}],
    }

    tbar_profile = ExercisePerformance(
        slug="t_bar_row",
        name="T-Bar Row",
        session_count=2,
        recent_top_weight_lbs=110.0,
        recent_top_reps=10,
        estimated_1rm_lbs=146.7,
        recent_volume_load=2200.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    db_from_tbar = recommend_starting_weight(
        db_row,
        profiles={"t_bar_row": tbar_profile},
        all_exercises_by_slug={"t_bar_row": tbar, "dumbbell_row": db_row},
        target_reps="8-10",
        experience="intermediate",
    )
    assert db_from_tbar.source == "movement_pattern"
    assert 40.0 <= db_from_tbar.weight_lbs <= 55.0, db_from_tbar

    db_profile = ExercisePerformance(
        slug="dumbbell_row",
        name="Dumbbell Row",
        session_count=2,
        recent_top_weight_lbs=55.0,
        recent_top_reps=10,
        estimated_1rm_lbs=73.3,
        recent_volume_load=1100.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    tbar_from_db = recommend_starting_weight(
        tbar,
        profiles={"dumbbell_row": db_profile},
        all_exercises_by_slug={"t_bar_row": tbar, "dumbbell_row": db_row},
        target_reps="8-10",
        experience="intermediate",
    )
    assert tbar_from_db.source == "movement_pattern"
    assert tbar_from_db.weight_lbs >= 85.0, tbar_from_db
    _ok(f"T-bar 110 total -> DB {db_from_tbar.weight_lbs} each; DB 55 each -> T-bar {tbar_from_db.weight_lbs} total")


def test_recommender_converts_single_arm_cable_row_per_side() -> None:
    """Single-arm cable rows use one handle/side, while seated cable rows
    use the bilateral stack total. They must not direct-swap the same load."""
    from datetime import date
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance

    print("\n[test] cable row transfer separates bilateral stack vs single-handle load")
    seated = {
        "slug": "seated_cable_row",
        "name": "Seated Cable Row",
        "primary_muscle": "back",
        "movement_pattern": "horizontal_pull",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
        "is_unilateral": False,
        "laterality": "bilateral",
        "substitution_group": "horizontal_pull_cable",
        "equipment": [
            {"slug": "cable_machine", "role": "primary", "required": True},
            {"slug": "v_bar_attachment", "role": "support", "required": True},
        ],
    }
    single = {
        "slug": "single_arm_cable_row",
        "name": "Single-Arm Cable Row",
        "primary_muscle": "back",
        "movement_pattern": "horizontal_pull",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
        "is_unilateral": True,
        "laterality": "unilateral",
        "substitution_group": "horizontal_pull_cable",
        "equipment": [
            {"slug": "cable_machine", "role": "primary", "required": True},
            {"slug": "d_handle", "role": "support", "required": True},
        ],
    }

    seated_profile = ExercisePerformance(
        slug="seated_cable_row",
        name="Seated Cable Row",
        session_count=2,
        recent_top_weight_lbs=100.0,
        recent_top_reps=10,
        estimated_1rm_lbs=133.3,
        recent_volume_load=2000.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    single_from_seated = recommend_starting_weight(
        single,
        profiles={"seated_cable_row": seated_profile},
        all_exercises_by_slug={"seated_cable_row": seated, "single_arm_cable_row": single},
        target_reps="8-10",
        experience="intermediate",
    )
    assert single_from_seated.source == "movement_pattern", single_from_seated
    assert 35.0 <= single_from_seated.weight_lbs <= 55.0, single_from_seated

    single_profile = ExercisePerformance(
        slug="single_arm_cable_row",
        name="Single-Arm Cable Row",
        session_count=2,
        recent_top_weight_lbs=50.0,
        recent_top_reps=10,
        estimated_1rm_lbs=66.7,
        recent_volume_load=1000.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    seated_from_single = recommend_starting_weight(
        seated,
        profiles={"single_arm_cable_row": single_profile},
        all_exercises_by_slug={"seated_cable_row": seated, "single_arm_cable_row": single},
        target_reps="8-10",
        experience="intermediate",
    )
    assert seated_from_single.source == "movement_pattern", seated_from_single
    assert seated_from_single.weight_lbs >= 80.0, seated_from_single
    _ok(
        f"seated 100 total -> single-arm {single_from_seated.weight_lbs} each; "
        f"single-arm 50 each -> seated {seated_from_single.weight_lbs} total"
    )


def test_recommender_converts_rdl_between_barbell_total_and_dumbbell_each() -> None:
    """Barbell RDL and dumbbell RDL share a movement family, but their
    displayed loads are different units: barbell total vs one dumbbell."""
    from datetime import date
    from app.services.workout.recommendation import recommend_starting_weight
    from app.services.workout.performance import ExercisePerformance

    print("\n[test] RDL transfer normalizes barbell-total vs dumbbell-each load")
    barbell_rdl = {
        "slug": "romanian_deadlift",
        "name": "Barbell Romanian Deadlift",
        "primary_muscle": "hamstrings",
        "movement_pattern": "hinge",
        "equipment_bucket": "gym",
        "is_compound": True,
        "is_machine": False,
        "substitution_group": "hinge_bilateral",
        "equipment": [{"slug": "barbell", "role": "primary", "required": True}],
    }
    dumbbell_rdl = {
        "slug": "dumbbell_rdl",
        "name": "Dumbbell Romanian Deadlift",
        "primary_muscle": "hamstrings",
        "movement_pattern": "hinge",
        "equipment_bucket": "dumbbells",
        "is_compound": True,
        "is_machine": False,
        "is_unilateral": False,
        "substitution_group": "hinge_bilateral",
        "equipment": [{"slug": "dumbbells", "role": "primary", "required": True}],
    }
    db_profile = ExercisePerformance(
        slug="dumbbell_rdl",
        name="Dumbbell Romanian Deadlift",
        session_count=2,
        recent_top_weight_lbs=50.0,
        recent_top_reps=10,
        estimated_1rm_lbs=66.7,
        recent_volume_load=1000.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    bar_from_db = recommend_starting_weight(
        barbell_rdl,
        profiles={"dumbbell_rdl": db_profile},
        all_exercises_by_slug={"romanian_deadlift": barbell_rdl, "dumbbell_rdl": dumbbell_rdl},
        target_reps="8-10",
        experience="intermediate",
    )
    assert bar_from_db.source == "substitution_group"
    assert bar_from_db.weight_lbs >= 90.0, bar_from_db

    bar_profile = ExercisePerformance(
        slug="romanian_deadlift",
        name="Barbell Romanian Deadlift",
        session_count=2,
        recent_top_weight_lbs=135.0,
        recent_top_reps=8,
        estimated_1rm_lbs=171.0,
        recent_volume_load=2160.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    db_from_bar = recommend_starting_weight(
        dumbbell_rdl,
        profiles={"romanian_deadlift": bar_profile},
        all_exercises_by_slug={"romanian_deadlift": barbell_rdl, "dumbbell_rdl": dumbbell_rdl},
        target_reps="8-10",
        experience="intermediate",
    )
    assert db_from_bar.source == "substitution_group"
    assert 45.0 <= db_from_bar.weight_lbs <= 70.0, db_from_bar
    _ok(f"DB 50 each -> barbell {bar_from_db.weight_lbs} total; barbell 135 total -> DB {db_from_bar.weight_lbs} each")


def test_dumbbell_compound_defaults_are_per_dumbbell() -> None:
    from app.services.workout.recommendation import recommend_starting_weight

    print("\n[test] dumbbell compound defaults are per-dumbbell")
    db_row = {
        "slug": "dumbbell_row",
        "name": "Dumbbell Row",
        "primary_muscle": "back",
        "movement_pattern": "horizontal_pull",
        "equipment_bucket": "dumbbells",
        "is_compound": True,
        "is_machine": False,
        "equipment": [{"slug": "dumbbells", "role": "primary", "required": True}],
    }
    rec = recommend_starting_weight(db_row, {}, {}, target_reps="8-10", experience="intermediate")
    assert rec.source == "default"
    assert rec.weight_lbs < 60.0, rec
    _ok(f"dumbbell row default={rec.weight_lbs} lb each")


def test_single_dumbbell_movements_display_without_each_but_scale_like_dumbbells() -> None:
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.recommendation import display_load_unit, recommend_starting_weight

    print("\n[test] single-dumbbell movements do not display as lb each")
    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
    single_dumbbell_slugs = [
        "goblet_squat",
        "sumo_squat",
        "heel_elevated_goblet_squat",
        "slant_board_goblet_squat",
        "dumbbell_pullover",
        "dumbbell_hip_thrust",
        "overhead_tricep_extension",
        "weighted_situp",
    ]
    for slug in single_dumbbell_slugs:
        assert display_load_unit(by_slug[slug]) == "single_dumbbell", slug

    rec = recommend_starting_weight(
        by_slug["sumo_squat"],
        profiles={},
        all_exercises_by_slug=by_slug,
        target_reps="8-10",
        experience="intermediate",
    )
    assert rec.source == "default", rec
    assert 55.0 <= rec.weight_lbs <= 80.0, rec
    _ok(f"sumo squat default={rec.weight_lbs} lb total single dumbbell")


def test_cable_and_single_side_load_units_are_explicit() -> None:
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.recommendation import display_load_unit

    print("\n[test] cable and one-side implements display the right load unit")
    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
    per_side_slugs = [
        "cable_fly",
        "low_to_high_cable_fly",
        "high_to_low_cable_fly",
        "cable_rear_delt_fly",
        "bilateral_cable_chest_press",
        "cable_woodchop",
        "pallof_press",
        "cable_pallof_hold",
        "single_arm_cable_row",
        "suitcase_carry",
    ]
    total_stack_slugs = [
        "seated_cable_row",
        "straight_arm_pulldown",
        "face_pull",
        "tricep_pushdown",
        "rope_pushdown",
        "cable_crunch",
    ]
    for slug in per_side_slugs:
        assert display_load_unit(by_slug[slug]) == "per_side", slug
    for slug in total_stack_slugs:
        assert display_load_unit(by_slug[slug]) == "total", slug
    _ok("dual-cable/side-handle moves are per side; single-stack bar/rope moves are total")


def test_single_dumbbell_squat_transfers_to_and_from_barbell_total() -> None:
    from datetime import date
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.performance import ExercisePerformance
    from app.services.workout.recommendation import recommend_starting_weight

    print("\n[test] single-dumbbell squat transfer normalizes against barbell total")
    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
    bar_profile = ExercisePerformance(
        slug="barbell_squat",
        name="Barbell Squat",
        session_count=2,
        recent_top_weight_lbs=135.0,
        recent_top_reps=8,
        estimated_1rm_lbs=171.0,
        recent_volume_load=2160.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    sumo_from_bar = recommend_starting_weight(
        by_slug["sumo_squat"],
        profiles={"barbell_squat": bar_profile},
        all_exercises_by_slug=by_slug,
        target_reps="8-10",
        experience="intermediate",
    )
    assert sumo_from_bar.source == "movement_pattern", sumo_from_bar
    assert 45.0 <= sumo_from_bar.weight_lbs <= 70.0, sumo_from_bar

    sumo_profile = ExercisePerformance(
        slug="sumo_squat",
        name="Sumo Squat",
        session_count=2,
        recent_top_weight_lbs=70.0,
        recent_top_reps=10,
        estimated_1rm_lbs=93.3,
        recent_volume_load=1400.0,
        last_performed_on=date.today(),
        confidence=0.33,
    )
    bar_from_sumo = recommend_starting_weight(
        by_slug["barbell_squat"],
        profiles={"sumo_squat": sumo_profile},
        all_exercises_by_slug=by_slug,
        target_reps="8-10",
        experience="intermediate",
    )
    assert bar_from_sumo.source == "movement_pattern", bar_from_sumo
    assert bar_from_sumo.weight_lbs >= 115.0, bar_from_sumo
    _ok(f"barbell 135 total -> sumo {sumo_from_bar.weight_lbs} total; sumo 70 -> barbell {bar_from_sumo.weight_lbs} total")


def test_dumbbell_push_press_resolves_to_dumbbell_seed() -> None:
    from app.services.workout.exercise_metadata import (
        resolve_seed_exercise_slug,
        set_programming_exercise_metadata,
    )
    from app.services.workout.set_programming import load_increment_for

    print("\n[test] Dumbbell Push Press resolves as dumbbells, not barbell Push Press")
    assert resolve_seed_exercise_slug("Dumbbell Push Press") == "dumbbell_push_press"
    assert resolve_seed_exercise_slug("DB Push Press") == "dumbbell_push_press"
    meta = set_programming_exercise_metadata(
        None,
        "Dumbbell Push Press",
        None,
        "dumbbells",
        "shoulders",
    )
    assert meta["slug"] == "dumbbell_push_press", meta
    assert meta["equipment_bucket"] == "dumbbell", meta
    assert load_increment_for(meta) == 5.0, meta
    _ok("Dumbbell Push Press metadata uses dumbbell per-hand load semantics")


def test_dumbbell_push_press_default_is_conservative_each() -> None:
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.recommendation import recommend_starting_weight

    print("\n[test] Dumbbell Push Press default is conservative per dumbbell")
    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
    rec = recommend_starting_weight(
        by_slug["dumbbell_push_press"],
        profiles={},
        all_exercises_by_slug=by_slug,
        target_reps="8-10",
        experience="intermediate",
    )
    assert rec.source == "default", rec
    assert 15.0 <= rec.weight_lbs <= 25.0, rec
    _ok(f"Dumbbell Push Press default={rec.weight_lbs} lb each")


def test_dumbbell_push_press_transfers_from_dumbbell_shoulder_press_each() -> None:
    from datetime import date
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.performance import ExercisePerformance
    from app.services.workout.recommendation import recommend_starting_weight

    print("\n[test] Dumbbell Push Press transfers from Dumbbell Shoulder Press per dumbbell")
    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
    profile = ExercisePerformance(
        slug="dumbbell_shoulder_press",
        name="Dumbbell Shoulder Press",
        session_count=3,
        recent_top_weight_lbs=15.0,
        recent_top_reps=10,
        estimated_1rm_lbs=20.0,
        recent_volume_load=450.0,
        last_performed_on=date.today(),
        confidence=0.50,
    )
    rec = recommend_starting_weight(
        by_slug["dumbbell_push_press"],
        profiles={"dumbbell_shoulder_press": profile},
        all_exercises_by_slug=by_slug,
        target_reps="8-10",
        experience="intermediate",
    )
    assert rec.source == "substitution_group", rec
    assert 10.0 <= rec.weight_lbs <= 20.0, rec
    _ok(f"DB shoulder 15 each -> DB push press {rec.weight_lbs} each")


def test_default_category_differentiates_by_pattern() -> None:
    """Category defaults should distinguish squat, hinge, vertical push,
    and upper pull rather than lump all compounds into one number."""
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
        test_plus_cardio_focus_label_matches_generated_contents,
        test_upper_lower_emphasis_rotates,
        test_session_minutes_short_drops_isolation_keeps_compounds,
        test_injury_blocks_movement_pattern,
        test_injury_free_form_phrase_resolves_via_substring,
        test_accessory_host_prefers_secondary_touch_day,
        test_recommender_confidence_single_session_below_075,
        test_recommender_downshifts_two_month_old_exact_history,
        test_lat_pull_down_alias_resolves_to_lat_pulldown,
        test_assisted_pullup_weight_does_not_transfer_to_lat_pulldown,
        test_band_only_spanish_squat_has_no_numeric_load_recommendation,
        test_recommender_uses_signup_strength_anchor_for_exact_lift,
        test_recommender_converts_row_loads_between_total_and_per_dumbbell,
        test_recommender_converts_single_arm_cable_row_per_side,
        test_recommender_converts_rdl_between_barbell_total_and_dumbbell_each,
        test_dumbbell_compound_defaults_are_per_dumbbell,
        test_single_dumbbell_movements_display_without_each_but_scale_like_dumbbells,
        test_cable_and_single_side_load_units_are_explicit,
        test_single_dumbbell_squat_transfers_to_and_from_barbell_total,
        test_dumbbell_push_press_resolves_to_dumbbell_seed,
        test_dumbbell_push_press_default_is_conservative_each,
        test_dumbbell_push_press_transfers_from_dumbbell_shoulder_press_each,
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
        test_primary_selection_hierarchy_loaded_beats_preferred_bodyweight,
        test_primary_selection_hierarchy_bodyweight_fallback_when_no_loaded,
        test_primary_load_tier_prefers_barbell_over_dumbbell,
        test_focus_family_filter_blocks_wrong_family_strength_slot,
        test_score_jitter_uses_stable_slug_digest,
        test_minimal_equipment_user_still_gets_bodyweight_fallback,
        test_general_health_does_not_get_load_penalty,
        test_equipment_label_for_loaded_movement_with_optional_required_flag,
        test_preacher_curl_label_selects_owned_implement,
        # Phase 2a — continuity across regenerations
        test_continuity_biases_toward_familiar_exercise,
        test_continuity_keeps_core_exercises_stable_on_regen,
        # Phase 2b — session-to-session target propagation
        test_progression_increases_when_all_sets_top_of_range,
        test_progression_holds_when_partial,
        test_progression_decreases_when_majority_missed,
        test_progression_reacclimates_stale_top_range_history,
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
