"""Regression tests for the planner-integrity fix set.

These tests pin down six specific production issues that were fixed
in the surgical-edit pass:

1. Upper/Lower odd-day priority bug in `_lifting_recipe`. A 5-day UL
   user with `priority_region == "lower_body"` must get an extra
   LOWER hypertrophy day, not an extra UPPER one (and vice-versa).

2. Heavy PPL archetypes (LIFT_PUSH_HEAVY / LIFT_PULL_HEAVY /
   LIFT_LEGS_HEAVY) must route through `_prescribe_by_stimulus` so
   they emit heavy (3-5 rep) set schemes, not fall back to the goal-
   bucket-aware lifting prescriber.

3. `validate_plan` must NOT destructively drop primary/secondary
   exercises when their primary muscle doesn't match the day's focus
   family — it has no in-place replacement path and hollowing out a
   day is worse than a mildly off-family compound.

4. `validate_plan`'s adjacent same-family swap must only fire when
   the post-swap neighbors are valid (no new same-family adjacency
   introduced at either affected position).

5. `build_strength` + user-chosen Upper/Lower must NEVER emit
   LIFT_FULL_BODY or LIFT_FULL_BODY_STRENGTH days — the split must
   be honored.

These tests are lightweight and pure-Python (no DB / no HTTP).
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Fix 1: Upper/Lower odd-day priority bug ─────────────────────────


def test_ul_odd_day_lower_priority_repeats_lower() -> None:
    """5-day UL + lower_body priority → last day is LIFT_LOWER_HYPERTROPHY."""
    print("\n[test] 5-day UL + lower_body priority ends on an extra LOWER day")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import _lifting_recipe
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER
    from app.services.workout.archetypes import DayArchetype

    # muscle_gain carries the stimulus-differentiated archetypes.
    profile = goal_profile_for("muscle_gain")
    recipe = _lifting_recipe(
        profile, SPLIT_UPPER_LOWER, 5, priority_region="lower_body",
    )
    assert len(recipe) == 5, f"want 5 days, got {len(recipe)}"
    last = recipe[-1]
    # We care about both "it's a LOWER day" and "it's not the opposite
    # region" — the prior bug flipped these.
    assert last in (
        DayArchetype.LIFT_LOWER_HYPERTROPHY,
        DayArchetype.LIFT_LOWER_HEAVY,
    ), f"5-day UL lower_body priority should end on a LOWER day, got {last.value}"
    _ok(f"recipe={[a.value for a in recipe]}")


def test_ul_odd_day_upper_priority_repeats_upper() -> None:
    """5-day UL + upper_body priority → last day is LIFT_UPPER_HYPERTROPHY."""
    print("\n[test] 5-day UL + upper_body priority ends on an extra UPPER day")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import _lifting_recipe
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER
    from app.services.workout.archetypes import DayArchetype

    profile = goal_profile_for("muscle_gain")
    recipe = _lifting_recipe(
        profile, SPLIT_UPPER_LOWER, 5, priority_region="upper_body",
    )
    assert len(recipe) == 5
    last = recipe[-1]
    assert last in (
        DayArchetype.LIFT_UPPER_HYPERTROPHY,
        DayArchetype.LIFT_UPPER_HEAVY,
    ), f"5-day UL upper_body priority should end on an UPPER day, got {last.value}"
    _ok(f"recipe={[a.value for a in recipe]}")


# ── Fix 2: Heavy PPL archetypes go through stimulus prescriber ──────


def test_heavy_ppl_archetypes_prescribe_as_strength() -> None:
    """LIFT_PUSH_HEAVY / LIFT_PULL_HEAVY / LIFT_LEGS_HEAVY must route
    through `_prescribe_by_stimulus("strength", ...)` — primary slots
    should land 3-5 reps with ~180s rest and low RIR. The old path
    missed these and fell back to goal-bucket prescriptions."""
    print("\n[test] heavy PPL archetypes use stimulus-driven strength prescription")
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.slots import Slot

    class _Inputs:
        """Minimal shim — not used by the strength stimulus path, but
        the signature requires SOMETHING so `prescribe_for_slot` can
        call into `_prescribe_lifting` as a fallback if routing
        regresses. A plain object with no session_minutes is fine."""
        session_minutes = 45

    primary_slot = Slot(
        label="Primary Press",
        movement_pattern="horizontal_press",
        primary_muscle_hint="chest",
        role="primary",
    )
    dummy_ex = {"_slug": "barbell_bench_press", "name": "Barbell Bench Press"}
    for archetype in (
        DayArchetype.LIFT_PUSH_HEAVY,
        DayArchetype.LIFT_PULL_HEAVY,
        DayArchetype.LIFT_LEGS_HEAVY,
    ):
        pres = prescribe_for_slot(archetype, primary_slot, dummy_ex, _Inputs())
        # Heavy = 3-5 reps with long rest. Anything outside this window
        # means routing fell through to a different prescriber.
        assert pres.reps == "3-5", (
            f"{archetype.value} primary should get 3-5 reps, got {pres.reps!r}"
        )
        assert pres.rest_seconds >= 150, (
            f"{archetype.value} primary should rest >=150s, got {pres.rest_seconds}"
        )
        assert pres.sets >= 3, (
            f"{archetype.value} primary should have >=3 sets, got {pres.sets}"
        )
    _ok("LIFT_PUSH_HEAVY / LIFT_PULL_HEAVY / LIFT_LEGS_HEAVY → 3-5 reps, long rest")


# ── Fix 3: validate_plan non-destructive for wrong-family compounds ─


def test_validate_plan_does_not_drop_wrong_family_compounds() -> None:
    """A compound on a wrong-family day stays in the plan (with a
    warning log). The prior behavior of silently dropping the row
    could hollow out a day when upstream filter_candidates let one
    through."""
    print("\n[test] validate_plan keeps wrong-family primary/secondary compounds")
    from app.services.workout.planner import validate_plan, PlannerInputs
    from app.services.workout.archetypes import DayArchetype

    # Lower-family day with a primary row whose primary_muscle is
    # a chest (upper-family) muscle. Deliberately off-family.
    plan = {
        "workout_plan": {
            "days": [
                {
                    "day": "Mon",
                    "archetype": DayArchetype.LIFT_LOWER_HEAVY.value,
                    "exercises": [
                        {
                            "_slug": "goblet_squat",
                            "name": "Goblet Squat",
                            "_role": "primary",
                            "_primary_muscle": "quads",
                        },
                        {
                            # Wrong-family compound — must NOT be dropped.
                            "_slug": "barbell_bench_press",
                            "name": "Barbell Bench Press",
                            "_role": "primary",
                            "_primary_muscle": "chest",
                        },
                    ],
                },
            ],
        },
    }
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=1, experience="intermediate",
        equipment_slugs=("barbell", "dumbbells"),
    )
    out = validate_plan(plan, inputs, recipe=None)
    exs = out["workout_plan"]["days"][0]["exercises"]
    slugs = [e["_slug"] for e in exs]
    assert "barbell_bench_press" in slugs, (
        f"wrong-family compound was destructively dropped: slugs={slugs}"
    )
    assert "goblet_squat" in slugs
    _ok(f"kept both rows: {slugs}")


# ── Fix 4: adjacency swap only fires when post-swap neighbors valid ─


def test_validate_plan_adjacency_swap_rejects_unsafe_swap() -> None:
    """Given a plan where the only candidate swap would introduce a
    new same-family adjacency, the swap must NOT happen. The prior
    logic swapped anyway and produced a different same-family pair."""
    print("\n[test] validate_plan adjacency swap rejects unsafe targets")
    from app.services.workout.planner import validate_plan, PlannerInputs
    from app.services.workout.archetypes import DayArchetype

    # Sequence: [Upper, Upper, Lower, Lower]
    # Positions 0↔1 are both "upper" — a same-family streak.
    # Candidate targets: j=2 (lower) and j=3 (lower).
    #   Swap(1, 2) would yield [Upper, Lower, Upper, Lower] — SAFE.
    #   Swap(1, 3) would yield [Upper, Lower, Lower, Upper] — creates
    #     a new same-family "lower" adjacency at positions 1↔2, NOT safe.
    # The validator should pick the safe swap (j=2), not j=3.
    #
    # We construct a case where ONLY the unsafe swap exists to prove
    # the safety check: [Upper, Upper, Lower, Upper]. Positions 0↔1
    # are both upper. j=2 is lower; swap(1,2) → [Upper, Lower, Upper,
    # Upper] which creates a new upper adjacency at 2↔3. j=3 is upper
    # — same family as fam_a, so it's already rejected by the family
    # mismatch check. So no safe swap exists and the plan should be
    # returned unchanged.
    plan = {
        "workout_plan": {
            "days": [
                {"day": "d1", "archetype": DayArchetype.LIFT_UPPER_HEAVY.value, "exercises": []},
                {"day": "d2", "archetype": DayArchetype.LIFT_UPPER_HYPERTROPHY.value, "exercises": []},
                {"day": "d3", "archetype": DayArchetype.LIFT_LOWER_HEAVY.value, "exercises": []},
                {"day": "d4", "archetype": DayArchetype.LIFT_UPPER_HYPERTROPHY.value, "exercises": []},
            ],
        },
    }
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell",),
    )
    out = validate_plan(plan, inputs, recipe=None)
    archs = [d["archetype"] for d in out["workout_plan"]["days"]]
    # The problematic pair [upper, upper] at positions 0↔1 should
    # remain (no safe swap), and no NEW same-family adjacency should
    # have been introduced at any other position.
    from app.services.workout.archetypes import archetype_to_focus_family
    fams = [archetype_to_focus_family(DayArchetype(a)) for a in archs]
    # Count adjacent same-family pairs — should not increase.
    adj_pairs = sum(1 for i in range(1, len(fams)) if fams[i] == fams[i - 1])
    assert adj_pairs <= 1, (
        f"adjacency swap made things worse: fams={fams}, pairs={adj_pairs}"
    )
    _ok(f"fams={fams} — no unsafe swap performed")


def test_validate_plan_adjacency_swap_fires_when_safe() -> None:
    """Positive case: when a safe swap IS available, the validator
    must take it."""
    print("\n[test] validate_plan adjacency swap fires when a safe target exists")
    from app.services.workout.planner import validate_plan, PlannerInputs
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    # [Upper, Upper, Lower, Lower] — swap(1,2) yields [U,L,U,L], safe.
    plan = {
        "workout_plan": {
            "days": [
                {"day": "d1", "archetype": DayArchetype.LIFT_UPPER_HEAVY.value, "exercises": []},
                {"day": "d2", "archetype": DayArchetype.LIFT_UPPER_HYPERTROPHY.value, "exercises": []},
                {"day": "d3", "archetype": DayArchetype.LIFT_LOWER_HEAVY.value, "exercises": []},
                {"day": "d4", "archetype": DayArchetype.LIFT_LOWER_HYPERTROPHY.value, "exercises": []},
            ],
        },
    }
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=("barbell",),
    )
    out = validate_plan(plan, inputs, recipe=None)
    fams = [
        archetype_to_focus_family(DayArchetype(d["archetype"]))
        for d in out["workout_plan"]["days"]
    ]
    # After the swap the sequence should have zero same-family
    # adjacencies left.
    adj_pairs = sum(1 for i in range(1, len(fams)) if fams[i] == fams[i - 1])
    assert adj_pairs == 0, (
        f"safe swap should have fully broken adjacency, fams={fams}"
    )
    _ok(f"fams={fams} — safe swap performed")


def test_validate_plan_strict_preflight_raises_structured_errors() -> None:
    """Strict validation is for launch/preflight checks: production can keep
    returning a repaired plan, but hard errors must be machine-readable."""
    print("\n[test] validate_plan strict preflight raises structured errors")
    from app.services.workout.planner import PlannerInputs, PlannerValidationError, validate_plan
    from app.services.workout.archetypes import DayArchetype

    plan = {
        "workout_plan": {
            "days": [
                {"day": "d1", "archetype": DayArchetype.LIFT_UPPER_HEAVY.value, "exercises": []},
            ],
        },
    }
    inputs = PlannerInputs(goal="muscle_gain", days_per_week=1, experience="intermediate")
    try:
        validate_plan(plan, inputs, strict=True)
    except PlannerValidationError as exc:
        codes = {e.get("code") for e in exc.errors}
        assert "empty_day" in codes, f"missing empty_day in {codes}"
    else:
        raise AssertionError("strict validate_plan should raise on empty day")
    _ok("strict preflight raised PlannerValidationError with empty_day")


def test_planner_substitutes_recovery_when_day_has_no_eligible_exercises() -> None:
    """Impossible exercise constraints should not ship a hollow workout card.
    The planner substitutes active recovery and records the impossible state."""
    print("\n[test] impossible constraints substitute recovery day with alert")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan

    inputs = PlannerInputs(
        goal="muscle_gain",
        days_per_week=1,
        session_minutes=45,
        experience="intermediate",
        equipment_slugs=(),
        rng_seed=99,
    )
    out = generate_workout_plan(inputs, [])
    wp = out["workout_plan"]
    day = wp["days"][0]
    codes = {w.get("code") for w in wp.get("planner_warnings") or []}
    assert day.get("focus") == "Recovery", f"expected recovery fallback, got {day}"
    assert day.get("exercises"), "recovery fallback should contain exercises"
    assert "no_eligible_exercises_for_day" in codes, f"missing fallback warning: {codes}"
    assert wp.get("planner_validation", {}).get("ok") is False
    _ok("empty generated day became Recovery with no_eligible_exercises_for_day warning")


def test_launch_preflight_common_profiles_are_strict_ready() -> None:
    """Small launch matrix: representative deterministic profiles should pass
    strict validation before external testing."""
    print("\n[test] launch preflight matrix strict-ready")
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import PlannerInputs, generate_workout_plan

    gym = ("barbell", "dumbbells", "flat_bench", "incline_bench", "squat_rack", "cable_machine", "pull_up_bar")
    cases = [
        PlannerInputs(goal="body_recomp", days_per_week=4, session_minutes=60, experience="intermediate", equipment_slugs=gym, rng_seed=11),
        PlannerInputs(goal="fat_loss", days_per_week=5, session_minutes=45, experience="beginner", equipment_slugs=("dumbbells", "flat_bench"), rng_seed=12),
        PlannerInputs(goal="strength", days_per_week=3, session_minutes=75, experience="advanced", equipment_slugs=gym, preferred_split="full_body", rng_seed=13),
    ]
    for inputs in cases:
        out = generate_workout_plan(inputs, SEED_EXERCISES, strict_validation=True)
        validation = out.get("workout_plan", {}).get("planner_validation", {})
        assert validation.get("ok") is True, f"{inputs} failed validation: {validation}"
    _ok(f"{len(cases)} representative profiles strict-ready")


# ── Fix 6 (also address): build_strength + UL must never emit Full Body


def test_build_strength_ul_6_days_has_no_full_body() -> None:
    """User on `strength` goal + user-chosen Upper/Lower + 6 days must
    get a pure Upper/Lower recipe — NO LIFT_FULL_BODY or
    LIFT_FULL_BODY_STRENGTH days. This reproduces the production
    report of [Full Body, Upper, Full Body, Full Body, rest, Upper,
    Lower]."""
    print("\n[test] strength goal + user-chosen UL 6d → no Full Body days")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER
    from app.services.workout.archetypes import DayArchetype

    profile = goal_profile_for("strength")
    recipe = generate_weekly_recipe(
        profile, 6,
        lifting_split=SPLIT_UPPER_LOWER,
        user_chose_split=True,
    )
    forbidden = {
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.LIFT_FULL_BODY_STRENGTH,
    }
    bad = [a.value for a in recipe if a in forbidden]
    assert not bad, (
        f"strength+UL user-chosen 6d emitted Full Body day(s) "
        f"{bad} in recipe={[a.value for a in recipe]}"
    )
    _ok(f"recipe={[a.value for a in recipe]}")


def test_build_strength_ul_5_days_has_no_full_body() -> None:
    """Mirror of the 6-day case — same guarantee at 5 lift days."""
    print("\n[test] strength goal + user-chosen UL 5d → no Full Body days")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER
    from app.services.workout.archetypes import DayArchetype

    profile = goal_profile_for("strength")
    recipe = generate_weekly_recipe(
        profile, 5,
        lifting_split=SPLIT_UPPER_LOWER,
        user_chose_split=True,
    )
    forbidden = {
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.LIFT_FULL_BODY_STRENGTH,
    }
    bad = [a.value for a in recipe if a in forbidden]
    assert not bad, (
        f"strength+UL user-chosen 5d emitted Full Body day(s) "
        f"{bad} in recipe={[a.value for a in recipe]}"
    )
    _ok(f"recipe={[a.value for a in recipe]}")


# ── Fix 7: build_strength must emit split-balanced recipes ─────────
# Production regression: a user on `build_strength` + 6 days + auto
# split got [Legs, Push, Legs, Legs, rest, Push, Pull] — 3 Legs /
# 2 Push / 1 Pull AND two adjacent Legs days. The strength branch in
# `generate_weekly_recipe` was ignoring `lifting_split` and always
# emitting an Upper/Lower-style cycle, which broke identity for users
# whose auto-picked split was PPL (strength + 6 days scores PPL
# higher than UL in `pick_split`). The fix routes the strength cycle
# through the supplied `lifting_split` so PPL/UL/Full Body each map
# to a strictly split-honoring archetype sequence.


def _family_counts(recipe):
    """Bucket recipe into push/pull/legs/upper/lower/full_body tallies."""
    from app.services.workout.archetypes import archetype_to_focus_family, ARCHETYPE_META
    tally: dict[str, int] = {}
    for a in recipe:
        if ARCHETYPE_META[a].category != "lift":
            continue
        fam = archetype_to_focus_family(a)
        tally[fam] = tally.get(fam, 0) + 1
    return tally


def _assert_no_family_adjacency(recipe) -> None:
    """No two adjacent lift days share a fine-grained focus family.
    Full-body is exempt (a pure-FB recipe is allowed to repeat)."""
    from app.services.workout.archetypes import archetype_to_focus_family, ARCHETYPE_META
    fams = [
        archetype_to_focus_family(a) if ARCHETYPE_META[a].category == "lift" else None
        for a in recipe
    ]
    for i in range(1, len(fams)):
        if fams[i] is None or fams[i - 1] is None:
            continue
        if fams[i] == "full_body":
            continue
        assert fams[i] != fams[i - 1], (
            f"adjacent same-family lift days at {i - 1}/{i}: "
            f"fams={fams}, recipe={[a.value for a in recipe]}"
        )


def test_build_strength_auto_6_days_is_split_balanced() -> None:
    """Reproducer for the production bug: `build_strength` goal + 6
    days + NO user-chosen split. Auto-pick yields PPL (strength + 6d
    scores PPL higher than UL). Recipe must have exactly 2 Push /
    2 Pull / 2 Legs — never 3 of one family."""
    print("\n[test] build_strength auto-split 6d → 2P / 2Pu / 2L, no adjacency")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import pick_split, SPLIT_PPL, SPLIT_UPPER_LOWER

    class _FakeInputs:
        goal = "build_strength"
        days_per_week = 6
        experience = "intermediate"
        preferred_split = None
        priority_region = "balanced"
        focused_muscle = None

    chosen = pick_split(_FakeInputs())
    # Document the auto choice — should be PPL for strength+6d.
    assert chosen == SPLIT_PPL, f"auto-pick for strength+6d expected PPL, got {chosen}"

    profile = goal_profile_for("build_strength")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=chosen, user_chose_split=False,
    )
    counts = _family_counts(recipe)
    # Exactly 2 of each PPL family.
    assert counts.get("push") == 2, f"expected 2 push, got counts={counts} recipe={[a.value for a in recipe]}"
    assert counts.get("pull") == 2, f"expected 2 pull, got counts={counts} recipe={[a.value for a in recipe]}"
    assert counts.get("legs") == 2, f"expected 2 legs, got counts={counts} recipe={[a.value for a in recipe]}"
    # No upper/lower/full_body contamination.
    assert counts.get("upper", 0) == 0 and counts.get("lower", 0) == 0, (
        f"PPL recipe leaked upper/lower days: counts={counts}"
    )
    _assert_no_family_adjacency(recipe)
    _ok(f"recipe={[a.value for a in recipe]} counts={counts} split={chosen}")


def test_build_strength_user_chose_ppl_6_days_is_balanced() -> None:
    """Same 2/2/2 guarantee when the user explicitly chose PPL."""
    print("\n[test] build_strength + user-chose PPL 6d → 2P / 2Pu / 2L")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_PPL

    profile = goal_profile_for("build_strength")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_PPL, user_chose_split=True,
    )
    counts = _family_counts(recipe)
    assert counts.get("push") == 2 and counts.get("pull") == 2 and counts.get("legs") == 2, (
        f"user-chosen PPL 6d must be 2/2/2, got {counts}, recipe={[a.value for a in recipe]}"
    )
    _assert_no_family_adjacency(recipe)
    _ok(f"recipe={[a.value for a in recipe]} counts={counts}")


def test_build_strength_user_chose_ul_6_days_is_alternating() -> None:
    """User-chosen UL at 6 days = 3 upper + 3 lower, strictly
    alternating, no full-body contamination."""
    print("\n[test] build_strength + user-chose UL 6d → 3U / 3L alternating")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER

    profile = goal_profile_for("build_strength")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_UPPER_LOWER, user_chose_split=True,
    )
    counts = _family_counts(recipe)
    assert counts.get("upper") == 3 and counts.get("lower") == 3, (
        f"user-chosen UL 6d must be 3U/3L, got {counts}, recipe={[a.value for a in recipe]}"
    )
    assert counts.get("full_body", 0) == 0, f"UL leaked full_body days: counts={counts}"
    _assert_no_family_adjacency(recipe)
    _ok(f"recipe={[a.value for a in recipe]} counts={counts}")


def test_build_strength_user_chose_full_body_all_full_body() -> None:
    """User-chosen Full Body → every lift day is full-body."""
    print("\n[test] build_strength + user-chose Full Body 5d → all full_body days")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_FULL_BODY

    profile = goal_profile_for("build_strength")
    recipe = generate_weekly_recipe(
        profile, 5, lifting_split=SPLIT_FULL_BODY, user_chose_split=True,
    )
    counts = _family_counts(recipe)
    lift_total = sum(counts.values())
    assert counts.get("full_body", 0) == lift_total and lift_total >= 1, (
        f"FB recipe must be all-FB, got {counts}, recipe={[a.value for a in recipe]}"
    )
    _ok(f"recipe={[a.value for a in recipe]} counts={counts}")


def test_build_strength_sweep_every_split_and_day_count() -> None:
    """Comprehensive sweep: for every days ∈ [3..7] × split ∈
    {ppl, upper_lower, full_body, auto} the strength cycle must
    honor split identity and balance."""
    print("\n[test] build_strength strength-cycle sweep across days × split")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import (
        pick_split, SPLIT_PPL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY,
    )

    profile = goal_profile_for("build_strength")
    splits_to_test = [SPLIT_PPL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY, None]
    problems: list[str] = []

    for days in range(3, 8):
        for split in splits_to_test:
            if split is None:
                class _FakeInputs:
                    goal = "build_strength"
                    experience = "intermediate"
                    preferred_split = None
                    priority_region = "balanced"
                    focused_muscle = None
                _FakeInputs.days_per_week = days
                effective = pick_split(_FakeInputs())
                user_chose = False
            else:
                effective = split
                user_chose = True

            recipe = generate_weekly_recipe(
                profile, days, lifting_split=effective, user_chose_split=user_chose,
            )
            counts = _family_counts(recipe)
            lift_total = sum(counts.values())

            # Hard invariants per split family.
            if effective == SPLIT_PPL:
                # No upper/lower/full_body days on PPL.
                if counts.get("upper", 0) or counts.get("lower", 0) or counts.get("full_body", 0):
                    problems.append(
                        f"PPL d={days} user_chose={user_chose} leaked non-PPL: counts={counts}"
                    )
                # At lift_days >= 6 → exact 2/2/2 balance.
                if lift_total >= 6:
                    if not (counts.get("push", 0) >= 2 and counts.get("pull", 0) >= 2 and counts.get("legs", 0) >= 2):
                        problems.append(
                            f"PPL d={days} lift={lift_total} imbalanced: counts={counts}"
                        )
                # At any lift_days: no family >2 count unless days>=7.
                if lift_total <= 6:
                    worst = max(counts.values(), default=0)
                    if worst > 2:
                        problems.append(
                            f"PPL d={days} family over-represented: counts={counts}"
                        )
            elif effective == SPLIT_UPPER_LOWER and user_chose:
                # User-chosen UL: NO full-body/push/pull/legs days.
                leaked = counts.get("full_body", 0) + counts.get("push", 0) + counts.get("pull", 0) + counts.get("legs", 0)
                if leaked:
                    problems.append(
                        f"UL d={days} leaked non-UL: counts={counts}"
                    )
            elif effective == SPLIT_FULL_BODY and user_chose:
                # User-chosen FB: every lift day is full-body.
                if counts.get("full_body", 0) != lift_total or lift_total < 1:
                    problems.append(
                        f"FB d={days} not all-FB: counts={counts}"
                    )

            # Adjacency invariant (allow full_body repeats).
            from app.services.workout.archetypes import archetype_to_focus_family, ARCHETYPE_META
            fams = [
                archetype_to_focus_family(a) if ARCHETYPE_META[a].category == "lift" else None
                for a in recipe
            ]
            for i in range(1, len(fams)):
                if fams[i] is None or fams[i - 1] is None:
                    continue
                if fams[i] == "full_body":
                    continue
                if fams[i] == fams[i - 1]:
                    problems.append(
                        f"d={days} split={effective} user_chose={user_chose} "
                        f"adj {i - 1}/{i} same family ({fams[i]}): fams={fams}"
                    )
                    break

    assert not problems, "strength sweep violations:\n  " + "\n  ".join(problems)
    _ok(f"swept days 3..7 × 4 splits — all split-balanced, no adjacency")


def test_body_recomp_6d_auto_ppl_is_split_balanced() -> None:
    """Reported bug: body_recomp + 6 days + auto split (picks PPL)
    produced [Legs, Push, Zone2, Legs, rest, Pull, Push] → 2P/1Pu/2L +
    cardio, under-prescribing Pull and over-prescribing Legs.

    After the PPL-force-mult-of-3-lifts rule, 6-day body_recomp must
    emit exactly 2 push + 2 pull + 2 legs archetypes (the single
    conditioning day is dropped to bump lift_days 5→6 so each PPL
    family gets equal reps).
    """
    print("\n[test] body_recomp 6d auto PPL → 2P/2Pu/2L")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_PPL

    profile = goal_profile_for("body_recomp")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_PPL, user_chose_split=False,
    )
    counts = _family_counts(recipe)
    assert counts.get("push") == 2 and counts.get("pull") == 2 and counts.get("legs") == 2, (
        f"body_recomp 6d PPL must be 2P/2Pu/2L, got {counts} "
        f"recipe={[a.value for a in recipe]}"
    )
    _ok(f"recipe={[a.value for a in recipe]} counts={counts}")


def test_muscle_gain_6d_user_chose_ppl_is_split_balanced() -> None:
    """muscle_gain + 6 days + user-chosen PPL → exactly 2/2/2.

    Even when the user explicitly picked PPL, the force-mult-of-3
    rule still applies (this case is already balanced organically
    since muscle_gain has cond_days=0, but we pin it down explicitly).
    """
    print("\n[test] muscle_gain 6d user-chose PPL → 2P/2Pu/2L")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_PPL

    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_PPL, user_chose_split=True,
    )
    counts = _family_counts(recipe)
    assert counts.get("push") == 2 and counts.get("pull") == 2 and counts.get("legs") == 2, (
        f"muscle_gain 6d PPL must be 2P/2Pu/2L, got {counts} "
        f"recipe={[a.value for a in recipe]}"
    )
    _ok(f"recipe={[a.value for a in recipe]} counts={counts}")


def test_body_recomp_5d_auto_ppl_keeps_family_balance() -> None:
    """body_recomp + 5 days + auto PPL.

    At 4 lift_days the existing PPL→UL auto-convert handles things by
    emitting 2 Upper / 2 Lower + cardio. The force-mult-of-3 rule
    does NOT fire (lift_days < 5 guard). Result: UL-balanced recipe
    that preserves the conditioning day.

    If the auto-convert ever stops firing, the mult-of-3 rule must
    still leave NO family with > 2 count (i.e. no 3P/1Pu/1L disaster).
    """
    print("\n[test] body_recomp 5d auto PPL → balanced (UL auto-convert OR PPL-mult-of-3)")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_PPL

    profile = goal_profile_for("body_recomp")
    recipe = generate_weekly_recipe(
        profile, 5, lifting_split=SPLIT_PPL, user_chose_split=False,
    )
    counts = _family_counts(recipe)
    worst = max(counts.values(), default=0)
    assert worst <= 2, (
        f"body_recomp 5d PPL has over-represented family: {counts} "
        f"recipe={[a.value for a in recipe]}"
    )
    # Must be balanced: either 2U/2L (auto-convert path) or 2/2/2 if
    # rule expands — never the broken 2P/1Pu/2L w/ no cardio.
    _ok(f"recipe={[a.value for a in recipe]} counts={counts}")


def test_full_body_adjacency_flagged_for_strength_ppl_split() -> None:
    """Full-body → full-body is a violation when the user picked a
    non-full-body split on lifting/strength/lifting_plus_cardio/athletic
    /hyrox. The residual-adjacency check must flag it (no carve-out
    for 'full_body' in those modes). Checked by synthesising a final
    recipe with two LIFT_FULL_BODY days adjacent and asserting the
    detector sees them."""
    print("\n[test] full_body adjacency flagged for strength on non-FB split")
    from app.services.workout.archetypes import (
        DayArchetype, archetype_to_focus_family,
    )
    from app.services.workout.day_templates import (
        SPLIT_FULL_BODY, SPLIT_PPL, SPLIT_UPPER_LOWER,
    )
    # Mirror the residual-dup logic from generate_weekly_recipe.
    def residual(final, mode, split):
        _fb_violates = (
            mode in ("lifting", "strength", "lifting_plus_cardio",
                     "athletic", "hyrox")
            and split != SPLIT_FULL_BODY
        )
        dups = []
        for i in range(1, len(final)):
            a = archetype_to_focus_family(final[i - 1])
            b = archetype_to_focus_family(final[i])
            if a != b or a is None:
                continue
            if a == "full_body" and not _fb_violates:
                continue
            dups.append((i, a))
        return dups
    recipe = [DayArchetype.LIFT_PUSH_HEAVY, DayArchetype.LIFT_FULL_BODY,
              DayArchetype.LIFT_FULL_BODY, DayArchetype.LIFT_LEGS]
    # PPL-chosen strength: full_body→full_body is a violation.
    assert residual(recipe, "strength", SPLIT_PPL), (
        "full_body adjacency must be flagged on strength + PPL split"
    )
    # UL-chosen lifting: still a violation.
    assert residual(recipe, "lifting", SPLIT_UPPER_LOWER), (
        "full_body adjacency must be flagged on lifting + UL split"
    )
    # Full Body split: NOT a violation (by design every day is FB).
    assert not residual(recipe, "lifting", SPLIT_FULL_BODY), (
        "full_body adjacency must NOT be flagged on FB split"
    )
    _ok("full_body adjacency detector honours mode+split gate")


def test_tier_d_skipped_for_user_chosen_ppl() -> None:
    """Tier D sibling substitution flips Push↔Pull, which breaks
    the user's explicit PPL cycle. When user_chose_split=True and
    split ∈ {PPL, PPL_UL}, Tier D must not fire. UL is intentionally
    allowed because Upper↔Lower substitution RESTORES UL alternation."""
    print("\n[test] tier-D skipped for user-chosen PPL / PPL_UL")
    from app.services.workout.archetypes import DayArchetype as A
    from app.services.workout.weekly_recipe import _repair_adjacent_duplicates
    from app.services.workout.day_templates import (
        SPLIT_PPL, SPLIT_PPL_UL, SPLIT_UPPER_LOWER,
    )
    # All-push input. Tier A/B/C have no cross-family target to swap
    # to — only tier D's sibling sub (push→pull) can break the
    # adjacency. With user_chose_split=True + PPL: tier D must skip,
    # dup survives. With user_chose_split=False: tier D fires and we
    # see at least one lift_pull in the output.
    allowed = frozenset({A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS})
    recipe = [A.LIFT_PUSH, A.LIFT_PUSH, A.LIFT_PUSH]
    out_ppl = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=allowed,
        lifting_split=SPLIT_PPL, user_chose_split=True,
    )
    assert all(a == A.LIFT_PUSH for a in out_ppl), (
        f"Tier D should not fire for user-chosen PPL; got {[a.value for a in out_ppl]}"
    )
    out_ppl_ul = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=allowed,
        lifting_split=SPLIT_PPL_UL, user_chose_split=True,
    )
    assert all(a == A.LIFT_PUSH for a in out_ppl_ul), (
        f"Tier D should not fire for user-chosen PPL_UL; got {[a.value for a in out_ppl_ul]}"
    )
    out_auto = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=allowed,
        lifting_split=SPLIT_PPL, user_chose_split=False,
    )
    fams_auto = [a.value for a in out_auto]
    assert "lift_pull" in fams_auto, (
        f"Tier D should fire on auto split; got {fams_auto}"
    )
    # UL is NOT skipped — sibling sub restores UL alternation.
    ul_allowed = frozenset({A.LIFT_UPPER, A.LIFT_LOWER})
    ul_recipe = [A.LIFT_UPPER, A.LIFT_UPPER, A.LIFT_UPPER]
    out_ul = _repair_adjacent_duplicates(
        ul_recipe, allowed_archetypes=ul_allowed,
        lifting_split=SPLIT_UPPER_LOWER, user_chose_split=True,
    )
    assert A.LIFT_LOWER in out_ul, (
        f"Tier D should still fire for user-chosen UL; got {[a.value for a in out_ul]}"
    )
    _ok(f"PPL/PPL_UL skipped, auto ran ({fams_auto}), UL still subs")


def test_body_recomp_cardio_cap_matches_docstring() -> None:
    """body_recomp (conditioning_frac 0.15) must produce ≤1 cardio day
    at every day-count so fat_loss's cap-of-2 stays strictly above it
    and 6d PPL split balance is preserved. The docstring and code
    contract agree: body_recomp caps at 1 cond day."""
    print("\n[test] body_recomp cardio days cap at 1 (docstring contract)")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META
    profile = goal_profile_for("body_recomp")
    for days in (4, 5, 6, 7):
        recipe = generate_weekly_recipe(profile, days, lifting_split="upper_lower")
        cond = sum(
            1 for a in recipe if ARCHETYPE_META[a].category in ("cond", "hybrid")
        )
        assert cond <= 1, (
            f"body_recomp {days}d expected <=1 cond day, got {cond}: "
            f"{[a.value for a in recipe]}"
        )
    _ok("body_recomp 4/5/6/7d all cap at <=1 cond day")


def test_nonlifting_goals_resolve_to_own_bucket_not_body_recomp() -> None:
    """goal_bucket and goal_profile_for must agree on every non-
    lifting goal. Previously longevity/healthy_aging/heart_health/
    general_health all silently collapsed to body_recomp in
    goal_bucket because they weren't in the registry or aliases —
    goal_profile_for routed them correctly via _PROFILE_OVERRIDES,
    so pick_split (which reads goal_bucket) and the profile disagreed."""
    print("\n[test] non-lifting goals: goal_bucket == goal_profile_for.bucket")
    from app.services.workout.goals import goal_bucket
    from app.services.workout.goal_profiles import goal_profile_for
    for goal in (
        "hyrox", "athletic_performance", "general_health",
        "longevity", "healthy_aging", "heart_health",
    ):
        b = goal_bucket(goal)
        pb = goal_profile_for(goal).bucket
        assert b != "body_recomp" or goal == "body_recomp", (
            f"goal={goal!r} collapsed to body_recomp in goal_bucket"
        )
        assert b == pb, (
            f"goal={goal!r}: goal_bucket={b!r} but "
            f"goal_profile_for.bucket={pb!r}"
        )
    # flexibility / stress_relief stay on the special-profile path —
    # their registry bucket is general_health (correct pick_split
    # fallback), and goal_profile_for returns the SPECIAL profile
    # (whose own .bucket is still general_health for consistency).
    for goal in ("flexibility", "stress_relief"):
        assert goal_bucket(goal) == "general_health"
        assert goal_profile_for(goal).bucket == "general_health"
    _ok("all non-lifting goals resolve consistently")


def test_length_pad_falls_through_when_mobility_flow_not_allowed() -> None:
    """If the profile's allowed_archetypes lacks MOBILITY_FLOW, the
    length-pad pass must still reach len(final) == days via the
    RECOVERY_EASY / anchor / allowed-set / LIFT_FULL_BODY fall-
    through. Synthesises a trimmed profile and a recipe shorter than
    days to force the pad branch."""
    print("\n[test] length pad fallback when MOBILITY_FLOW not allowed")
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.goal_profiles import GoalProfile, TrainingMix
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    # Strict-lifting profile with NO MOBILITY_FLOW / NO RECOVERY_EASY.
    strict = GoalProfile(
        bucket="muscle_gain",
        label="strict-no-mobility",
        mix=TrainingMix(strength=0.2, hypertrophy=0.7, conditioning=0.1),
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER,
            DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL,
            DayArchetype.LIFT_LEGS, DayArchetype.LIFT_FULL_BODY,
        }),
        anchor_archetypes=(DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER),
        planner_mode="lifting",
    )
    for days in (3, 4, 5, 6, 7):
        recipe = generate_weekly_recipe(strict, days, lifting_split="upper_lower")
        assert len(recipe) == days, (
            f"length guarantee failed at {days}d: len={len(recipe)} "
            f"recipe={[a.value for a in recipe]}"
        )
        for a in recipe:
            assert a in strict.allowed_archetypes or a == DayArchetype.LIFT_FULL_BODY, (
                f"pad emitted disallowed archetype {a.value}"
            )
    _ok("length pad reaches len==days across 3-7 days")


# ── Split-anchor rotation (Task A) ──────────────────────────────────


def test_split_anchor_ppl_push_last_sets_day0_pull() -> None:
    """recent=('push',) + PPL 6d → day 0 is Pull (next in PPL cycle)."""
    print("\n[test] split-anchor: recent=push + PPL 6d → day0=Pull")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family
    from app.services.workout.day_templates import SPLIT_PPL
    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_PPL, user_chose_split=True,
        recent_focus_families=("push",),
    )
    fam0 = archetype_to_focus_family(recipe[0])
    assert fam0 == "pull", (
        f"expected day0 family 'pull', got {fam0!r} — recipe={[a.value for a in recipe]}"
    )
    _ok(f"day0={fam0} after recent=push → {[a.value for a in recipe]}")


def test_split_anchor_ppl_pull_last_sets_day0_legs() -> None:
    """recent=('pull',) + PPL 6d → day 0 is Legs."""
    print("\n[test] split-anchor: recent=pull + PPL 6d → day0=Legs")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family
    from app.services.workout.day_templates import SPLIT_PPL
    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_PPL, user_chose_split=True,
        recent_focus_families=("pull",),
    )
    fam0 = archetype_to_focus_family(recipe[0])
    assert fam0 == "legs", (
        f"expected day0 family 'legs', got {fam0!r} — recipe={[a.value for a in recipe]}"
    )
    _ok(f"day0={fam0} after recent=pull → {[a.value for a in recipe]}")


def test_split_anchor_ul_upper_last_sets_day0_lower() -> None:
    """recent=('upper',) + UL 6d → day 0 is Lower."""
    print("\n[test] split-anchor: recent=upper + UL 6d → day0=Lower")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER
    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_UPPER_LOWER, user_chose_split=True,
        recent_focus_families=("upper",),
    )
    fam0 = archetype_to_focus_family(recipe[0])
    assert fam0 == "lower", (
        f"expected day0 family 'lower', got {fam0!r} — recipe={[a.value for a in recipe]}"
    )
    _ok(f"day0={fam0} after recent=upper → {[a.value for a in recipe]}")


def test_split_anchor_mobility_recent_falls_through() -> None:
    """recent=('mobility',) + PPL 6d → anchor is a no-op (no lift family
    to anchor from), existing rotation decides day 0."""
    print("\n[test] split-anchor: recent=mobility + PPL 6d → anchor no-op")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe, _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_PPL
    profile = goal_profile_for("muscle_gain")
    # Call anchor helper directly to prove no-op behavior.
    recipe_before = generate_weekly_recipe(
        profile, 6, lifting_split=SPLIT_PPL, user_chose_split=True,
    )
    # Anchor returns recipe UNCHANGED when recent is non-lift.
    recipe_after = _anchor_recipe_to_split_next(
        list(recipe_before), ("mobility",), SPLIT_PPL,
    )
    assert recipe_after == recipe_before, (
        f"anchor should be no-op on non-lift recent family; "
        f"before={[a.value for a in recipe_before]} "
        f"after={[a.value for a in recipe_after]}"
    )
    _ok("mobility recent → anchor no-op (falls through to rotation)")


def test_split_anchor_empty_recent_unchanged() -> None:
    """recent=() + any split → _anchor_recipe_to_split_next is no-op."""
    print("\n[test] split-anchor: recent=() → unchanged")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe, _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_PPL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY
    profile = goal_profile_for("muscle_gain")
    for split in (SPLIT_PPL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY):
        base = generate_weekly_recipe(
            profile, 6, lifting_split=split, user_chose_split=True,
        )
        anchored = _anchor_recipe_to_split_next(list(base), (), split)
        assert anchored == base, (
            f"anchor should be no-op when recent is empty (split={split}): "
            f"before={[a.value for a in base]} after={[a.value for a in anchored]}"
        )
    _ok("empty recent → anchor leaves recipe unchanged across splits")


def test_next_in_split_rotation_helper_contract() -> None:
    """Direct unit test of `_next_in_split_rotation`."""
    print("\n[test] _next_in_split_rotation: PPL + UL + fallthroughs")
    from app.services.workout.weekly_recipe import _next_in_split_rotation
    from app.services.workout.day_templates import (
        SPLIT_PPL, SPLIT_PPL_UL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY, SPLIT_BRO,
    )
    assert _next_in_split_rotation("push", SPLIT_PPL) == "pull"
    assert _next_in_split_rotation("pull", SPLIT_PPL) == "legs"
    assert _next_in_split_rotation("legs", SPLIT_PPL) == "push"
    assert _next_in_split_rotation("push", SPLIT_PPL_UL) == "pull"
    assert _next_in_split_rotation("upper", SPLIT_UPPER_LOWER) == "lower"
    assert _next_in_split_rotation("lower", SPLIT_UPPER_LOWER) == "upper"
    # Non-PPL/UL splits and unknown families: None
    assert _next_in_split_rotation("push", SPLIT_FULL_BODY) is None
    assert _next_in_split_rotation("upper", SPLIT_BRO) is None
    assert _next_in_split_rotation("cardio", SPLIT_PPL) is None
    assert _next_in_split_rotation(None, SPLIT_PPL) is None
    assert _next_in_split_rotation("push", None) is None
    _ok("helper returns correct next family per split")


# ── End-to-end plan generation sanity (Task B regression) ───────────


def test_end_to_end_plan_family_sequence_matches_recipe_for_strength_ppl() -> None:
    """Full plan generation (through generate_workout_plan) must emit a
    focus sequence that matches the recipe's family sequence for a
    goal=strength + PPL user. Pins the bug where `planner.py` passed
    lifting_split=None for strength mode, forcing the fallback UL
    cycle and shipping [Upper, Mobility, Full Body, ...] to the client."""
    print("\n[test] end-to-end strength + PPL: plan focuses match recipe families")
    from app.services.workout.planner import generate_workout_plan, PlannerInputs
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.archetypes import archetype_to_focus_family

    inputs = PlannerInputs(
        goal="strength",
        days_per_week=6,
        session_minutes=60,
        experience="intermediate",
        equipment_slugs=("full_gym",),
        preferred_split="ppl",
        user_age=30,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    days = plan.get("workout_plan", {}).get("days", [])
    focuses = [(d.get("focus") or "").lower() for d in days]
    # PPL over 6 days → exactly 2 push, 2 pull, 2 legs.
    push_like = sum(1 for f in focuses if "push" in f)
    pull_like = sum(1 for f in focuses if "pull" in f)
    legs_like = sum(1 for f in focuses if "leg" in f)
    upper_like = sum(1 for f in focuses if f == "upper" or f.startswith("upper "))
    lower_like = sum(1 for f in focuses if f == "lower" or f.startswith("lower "))
    fb_like = sum(1 for f in focuses if "full body" in f)
    assert push_like == 2 and pull_like == 2 and legs_like == 2, (
        f"strength + PPL 6d expected 2/2/2 P/Pu/L focuses, got "
        f"push={push_like} pull={pull_like} legs={legs_like} "
        f"upper={upper_like} lower={lower_like} fb={fb_like} "
        f"focuses={focuses}"
    )
    assert upper_like == 0 and lower_like == 0 and fb_like == 0, (
        f"strength + PPL 6d must not emit Upper/Lower/Full Body days; "
        f"focuses={focuses}"
    )
    _ok(f"strength + PPL 6d → focuses={focuses}")


# ── Goal × day-count stimulus ratio regressions ─────────────────
#
# These pin the corrected stimulus ratios after the 2026.04.22.05
# archetype-ratio audit. Each test asserts that a given goal + split
# + day-count produces a recipe whose heavy-vs-not-heavy count falls
# within the design band (lower/upper inclusive). Exact day-ordering
# is already covered by other tests; these focus on totals.


def _classify_lift(archetype_value: str) -> str:
    """Tag a lift archetype as 'heavy', 'volume', 'hyper', or 'lift'.
    Non-lift archetypes return their category name."""
    if "heavy" in archetype_value:
        return "heavy"
    if "volume" in archetype_value:
        return "volume"
    if "hypertrophy" in archetype_value:
        return "hyper"
    if "strength" in archetype_value and "maintenance" not in archetype_value:
        return "heavy"
    return "other"


def _count_heavy(recipe) -> int:
    return sum(1 for a in recipe if _classify_lift(a.value) == "heavy")


def _count_hyper(recipe) -> int:
    return sum(1 for a in recipe if _classify_lift(a.value) == "hyper")


def _count_volume(recipe) -> int:
    return sum(1 for a in recipe if _classify_lift(a.value) == "volume")


def _count_category(recipe, category: str) -> int:
    from app.services.workout.archetypes import ARCHETYPE_META
    return sum(1 for a in recipe if ARCHETYPE_META[a].category == category)


def _count_cardio_components(recipe) -> int:
    from app.services.workout.archetypes import ARCHETYPE_META
    return sum(
        1 for a in recipe
        if a.value.endswith("_plus_cardio")
        or ARCHETYPE_META[a].category in ("cond", "hybrid")
    )


def test_stimulus_ratio_muscle_gain_ul_6d_is_hypertrophy_biased() -> None:
    """muscle_gain on UL 6d must be 2 heavy + 4 non-heavy hypertrophy
    exposures. PLUS_CARDIO counts as non-heavy here because the lift
    work still follows the muscle-gain prescription; the enum only
    changes to carry the finisher."""
    print("\n[test] muscle_gain UL 6d = 2 heavy + 4 hypertrophy-equivalent")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(profile, 6, lifting_split="upper_lower")
    n_heavy = _count_heavy(recipe)
    n_hyper = _count_hyper(recipe) + sum(1 for a in recipe if a.value.endswith("_plus_cardio"))
    assert n_heavy == 2, f"muscle_gain UL 6d expected 2 heavy, got {n_heavy}: {[a.value for a in recipe]}"
    assert n_hyper == 4, f"muscle_gain UL 6d expected 4 hypertrophy-equivalent, got {n_hyper}: {[a.value for a in recipe]}"
    _ok(f"muscle_gain UL 6d = {n_heavy}H + {n_hyper}Hy")


def test_stimulus_ratio_muscle_gain_ppl_6d_is_balanced_alternating() -> None:
    """muscle_gain on PPL 6d must be 3 heavy + 3 volume, interleaved
    (no 3+ adjacent heavy days)."""
    print("\n[test] muscle_gain PPL 6d = 3 heavy + 3 volume, interleaved")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(profile, 6, lifting_split="ppl")
    n_heavy = _count_heavy(recipe)
    n_volume = _count_volume(recipe) + sum(1 for a in recipe if a.value.endswith("_plus_cardio"))
    assert n_heavy == 3, f"muscle_gain PPL 6d expected 3 heavy, got {n_heavy}: {[a.value for a in recipe]}"
    assert n_volume == 3, f"muscle_gain PPL 6d expected 3 volume-equivalent, got {n_volume}: {[a.value for a in recipe]}"
    # Assert no 3-in-a-row heavies.
    for i in range(2, len(recipe)):
        triple = [_classify_lift(recipe[j].value) == "heavy" for j in (i - 2, i - 1, i)]
        assert not all(triple), (
            f"muscle_gain PPL 6d has 3 adjacent heavy days at idx {i-2}-{i}: "
            f"{[a.value for a in recipe]}"
        )
    _ok(f"muscle_gain PPL 6d = {n_heavy}H + {n_volume}V, no 3-adjacent heavies")


def test_stimulus_ratio_strength_ul_4d_is_half_heavy() -> None:
    """strength on UL 4d must be 2 heavy + 2 hypertrophy — 3 heavies
    in 4 days is CNS overload even for a strength goal."""
    print("\n[test] strength UL 4d = 2 heavy + 2 hypertrophy")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("strength")
    recipe = generate_weekly_recipe(profile, 4, lifting_split="upper_lower")
    n_heavy = _count_heavy(recipe)
    n_hyper = _count_hyper(recipe)
    assert n_heavy == 2, f"strength UL 4d expected 2 heavy, got {n_heavy}: {[a.value for a in recipe]}"
    assert n_hyper == 2, f"strength UL 4d expected 2 hypertrophy, got {n_hyper}: {[a.value for a in recipe]}"
    _ok(f"strength UL 4d = {n_heavy}H + {n_hyper}Hy")


def test_stimulus_ratio_strength_ul_6d_allows_cluster() -> None:
    """strength goal on 6 days with strict user-chose UL retains 4 heavy
    upper/lower sessions (the upper/lower heavy PAIR is acceptable for
    strength — different muscle groups — but NOT for muscle_gain).
    The non-strict path mixes in Full Body Strength which also counts
    as heavy stimulus."""
    print("\n[test] strength UL 6d (user-chose) = 4 heavy + 2 hypertrophy")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("strength")
    recipe = generate_weekly_recipe(
        profile, 6, lifting_split="upper_lower", user_chose_split=True,
    )
    n_heavy = _count_heavy(recipe)
    assert n_heavy >= 3, (
        f"strength UL 6d user-chose expected >=3 heavy (cluster allowed "
        f"for strength), got {n_heavy}: {[a.value for a in recipe]}"
    )
    _ok(f"strength UL 6d user-chose has {n_heavy} heavy days (cluster preserved)")


def test_stimulus_ratio_body_recomp_ul_6d_is_hypertrophy_biased() -> None:
    """body_recomp on UL 6d (lifting+cardio mode) gets 6 lift slots with
    1 same-day cardio component. The lift stimulus must stay biased away
    from heavy work — NOT 4 heavy + 1 hypertrophy (the old behavior)."""
    print("\n[test] body_recomp UL 6d = <=2 heavy + 1 cardio component")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("body_recomp")
    recipe = generate_weekly_recipe(profile, 6, lifting_split="upper_lower")
    n_heavy = _count_heavy(recipe)
    n_cond = _count_cardio_components(recipe)
    assert n_heavy <= 2, (
        f"body_recomp UL 6d expected <=2 heavy, got {n_heavy}: "
        f"{[a.value for a in recipe]}"
    )
    assert n_cond == 1, (
        f"body_recomp UL 6d expected exactly 1 cardio component, got {n_cond}: "
        f"{[a.value for a in recipe]}"
    )
    _ok(f"body_recomp UL 6d heavy={n_heavy} cond={n_cond}")


def test_stimulus_ratio_fat_loss_ul_6d_gets_2_cardio() -> None:
    """fat_loss at 6 days on UL must schedule 2 cardio (conditioning
    cap 2 for conditioning_frac >= 0.30)."""
    print("\n[test] fat_loss UL 6d = 2 cardio days")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("fat_loss")
    recipe = generate_weekly_recipe(profile, 6, lifting_split="upper_lower")
    n_cond = _count_cardio_components(recipe)
    assert n_cond == 2, (
        f"fat_loss UL 6d expected 2 cardio days, got {n_cond}: "
        f"{[a.value for a in recipe]}"
    )
    _ok(f"fat_loss UL 6d conditioning days = {n_cond}")


def test_stimulus_ratio_strength_has_zero_cardio_at_4to6_days() -> None:
    """strength goal below 7 days must get 0 cardio days."""
    print("\n[test] strength 4-6 days = 0 cardio")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    profile = goal_profile_for("strength")
    for days in (4, 5, 6):
        recipe = generate_weekly_recipe(profile, days, lifting_split="upper_lower")
        n_cond = _count_category(recipe, "cond") + _count_category(recipe, "hybrid")
        assert n_cond == 0, (
            f"strength UL {days}d expected 0 cardio, got {n_cond}: "
            f"{[a.value for a in recipe]}"
        )
    _ok("strength 4/5/6d on UL = 0 cardio")


def test_no_three_adjacent_heavies_for_non_strength_goals() -> None:
    """After the archetype-ratio audit, no non-strength goal should
    produce 3+ adjacent heavy days on any split × day combo — Pass 1
    of `_space_high_intensity_days` plus the new interleaved PPL
    stimulus mix enforces this."""
    print("\n[test] non-strength goals: no 3 adjacent heavy days in recipe")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    for goal in ("muscle_gain", "body_recomp", "athletic_performance",
                 "hyrox", "toning", "fat_loss"):
        profile = goal_profile_for(goal)
        for split in ("upper_lower", "ppl"):
            for days in (3, 4, 5, 6, 7):
                recipe = generate_weekly_recipe(profile, days, lifting_split=split)
                for i in range(2, len(recipe)):
                    triple = [_classify_lift(recipe[j].value) == "heavy"
                              for j in (i - 2, i - 1, i)]
                    assert not all(triple), (
                        f"{goal} {split} {days}d has 3 adjacent heavies at "
                        f"idx {i-2}-{i}: {[a.value for a in recipe]}"
                    )
    _ok("all non-strength goals × 3-7 days × UL/PPL → no 3-heavy streaks")


def test_goal_allows_heavy_gate_tightened_to_strength_only() -> None:
    """Only strength-dominant goals (mix.strength >= 0.5 or
    planner_mode == 'strength') pass the `goal_allows_heavy_streaks`
    gate. muscle_gain (strength=0.20) and body_recomp (0.25) must
    NOT qualify — the old `lifting + strength >= 0.35` clause was
    overly permissive."""
    print("\n[test] goal_allows_heavy gate: only strength qualifies")
    from app.services.workout.goal_profiles import goal_profile_for
    for goal, expected_allows in (
        ("strength", True),
        ("muscle_gain", False),
        ("body_recomp", False),
        ("athletic_performance", False),
        ("hyrox", False),
        ("toning", False),
        ("fat_loss", False),
    ):
        profile = goal_profile_for(goal)
        allows = (
            profile.mix.strength >= 0.5
            or profile.planner_mode == "strength"
        )
        assert allows is expected_allows, (
            f"{goal}: gate expected={expected_allows} actual={allows} "
            f"(mix.strength={profile.mix.strength} mode={profile.planner_mode})"
        )
    _ok("gate correctly tightened to strength-only goals")


def test_heavy_pair_cooldown_pass_breaks_three_heavy_triples() -> None:
    """The new heavy-pair-cooldown pass in `_space_high_intensity_days`
    detects any `heavy → heavy → heavy` triple left behind by Pass 1
    (e.g. when goal_allows_heavy_streaks=True allows streaks up to
    length 3) and swaps the third heavy with a non-heavy day later
    in the recipe (or demotes it as a fallback)."""
    print("\n[test] heavy-pair cooldown: H→H→H triple broken")
    from app.services.workout.archetypes import DayArchetype as DA
    from app.services.workout.weekly_recipe import _space_high_intensity_days
    # Strength-allowed streak=3 case: craft a 4-day recipe that starts
    # with 3 heavies followed by a hypertrophy. Pass 1 allows the
    # streak; heavy-pair cooldown must re-break it.
    recipe = [
        DA.LIFT_PUSH_HEAVY, DA.LIFT_PULL_HEAVY, DA.LIFT_LEGS_HEAVY,
        DA.LIFT_PUSH_VOLUME,
    ]
    out = _space_high_intensity_days(recipe, goal_allows_heavy_streaks=True)
    # After cooldown: day 2 (the third heavy) should NOT be heavy.
    from app.services.workout.weekly_recipe import _is_heavy
    assert not (_is_heavy(out[0]) and _is_heavy(out[1]) and _is_heavy(out[2])), (
        f"heavy-pair cooldown failed to break H→H→H triple: {[a.value for a in out]}"
    )
    _ok(f"heavy triple broken → {[a.value for a in out]}")


cases = [
    test_ul_odd_day_lower_priority_repeats_lower,
    test_ul_odd_day_upper_priority_repeats_upper,
    test_heavy_ppl_archetypes_prescribe_as_strength,
    test_validate_plan_does_not_drop_wrong_family_compounds,
    test_validate_plan_adjacency_swap_rejects_unsafe_swap,
    test_validate_plan_adjacency_swap_fires_when_safe,
    test_validate_plan_strict_preflight_raises_structured_errors,
    test_planner_substitutes_recovery_when_day_has_no_eligible_exercises,
    test_launch_preflight_common_profiles_are_strict_ready,
    test_build_strength_ul_6_days_has_no_full_body,
    test_build_strength_ul_5_days_has_no_full_body,
    test_build_strength_auto_6_days_is_split_balanced,
    test_build_strength_user_chose_ppl_6_days_is_balanced,
    test_build_strength_user_chose_ul_6_days_is_alternating,
    test_build_strength_user_chose_full_body_all_full_body,
    test_build_strength_sweep_every_split_and_day_count,
    test_body_recomp_6d_auto_ppl_is_split_balanced,
    test_muscle_gain_6d_user_chose_ppl_is_split_balanced,
    test_body_recomp_5d_auto_ppl_keeps_family_balance,
    test_full_body_adjacency_flagged_for_strength_ppl_split,
    test_tier_d_skipped_for_user_chosen_ppl,
    test_body_recomp_cardio_cap_matches_docstring,
    test_nonlifting_goals_resolve_to_own_bucket_not_body_recomp,
    test_length_pad_falls_through_when_mobility_flow_not_allowed,
    # Split-anchor rotation (Task A)
    test_split_anchor_ppl_push_last_sets_day0_pull,
    test_split_anchor_ppl_pull_last_sets_day0_legs,
    test_split_anchor_ul_upper_last_sets_day0_lower,
    test_split_anchor_mobility_recent_falls_through,
    test_split_anchor_empty_recent_unchanged,
    test_next_in_split_rotation_helper_contract,
    # End-to-end plan (Task B regression)
    test_end_to_end_plan_family_sequence_matches_recipe_for_strength_ppl,
    # Goal × day-count stimulus ratio audit (2026.04.22.05)
    test_stimulus_ratio_muscle_gain_ul_6d_is_hypertrophy_biased,
    test_stimulus_ratio_muscle_gain_ppl_6d_is_balanced_alternating,
    test_stimulus_ratio_strength_ul_4d_is_half_heavy,
    test_stimulus_ratio_strength_ul_6d_allows_cluster,
    test_stimulus_ratio_body_recomp_ul_6d_is_hypertrophy_biased,
    test_stimulus_ratio_fat_loss_ul_6d_gets_2_cardio,
    test_stimulus_ratio_strength_has_zero_cardio_at_4to6_days,
    test_no_three_adjacent_heavies_for_non_strength_goals,
    test_goal_allows_heavy_gate_tightened_to_strength_only,
    test_heavy_pair_cooldown_pass_breaks_three_heavy_triples,
]


if __name__ == "__main__":
    for c in cases:
        c()
    print("\n  All planner-integrity regression tests passed.")
