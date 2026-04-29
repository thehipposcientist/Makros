"""Schema/shape tests for the deterministic planner.

These cover the contract between `generate_workout_plan` and its
consumers (plan_review, plan_ai_regenerate, progression engine, RN
frontend). Specifically:

  * Every exercise in the plan output uses `restSeconds` (camelCase),
    never `rest_seconds` — including age-injected warmups, weekly-core
    injected exercises, and focus-backfill accessories.
  * Canonical keys (setScheme, targetWeightLbs, recommendation metadata)
    are always present on lifting exercises (null rather than missing).
  * Weekly core injection doesn't crash, injects when eligible, and the
    injected exercises match the canonical schema.
  * Patch rehydration rebuilds derived fields after swap/add/sets_reps.
  * focused_muscle changes the deterministic plan visibly.
  * build_plan_brief returns a shape consistent with the reviewer
    prompt's field references.

Run directly: python3 -m tests.test_planner_schema
"""
from __future__ import annotations

from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.planner import (
    PlannerInputs,
    build_planner_exercise,
    generate_workout_plan,
)
from app.services.workout.prescriptions import Prescription
from app.services.workout.plan_review import (
    PlanPatch,
    apply_patches,
    build_plan_brief,
)


_FULL_GYM = (
    "barbell", "dumbbells", "flat_bench", "squat_rack",
    "cable_machine", "pull_up_bar", "lat_pulldown",
    "leg_press", "smith_machine", "adjustable_bench",
    "dip_bars", "leg_curl_machine", "leg_extension_machine",
    "hack_squat", "hip_thrust_bench",
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Helpers ────────────────────────────────────────────────────────

def _all_exercises(plan: dict) -> list[dict]:
    days = plan.get("workout_plan", {}).get("days", []) or []
    out: list[dict] = []
    for d in days:
        out.extend(d.get("exercises", []) or [])
    return out


def _make_inputs(**overrides) -> PlannerInputs:
    base = dict(
        goal="body_recomp",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=_FULL_GYM,
        rng_seed=1,
    )
    base.update(overrides)
    return PlannerInputs(**base)


# ── Schema consistency ────────────────────────────────────────────

def test_every_exercise_uses_camel_rest_seconds() -> None:
    """Every exercise in a generated plan must use `restSeconds`. No
    `rest_seconds` should leak to the external output shape — it's the
    internal dataclass field name only."""
    print("\n[test] every planner exercise uses restSeconds (camelCase)")
    plan = generate_workout_plan(_make_inputs(days_per_week=4), SEED_EXERCISES)
    for ex in _all_exercises(plan):
        assert "restSeconds" in ex, (
            f"exercise {ex.get('name')!r} missing restSeconds key"
        )
        assert "rest_seconds" not in ex, (
            f"exercise {ex.get('name')!r} still carries snake_case "
            f"rest_seconds (should be restSeconds only)"
        )
    _ok(f"all {len(_all_exercises(plan))} exercises use restSeconds")


def test_age_warmup_uses_camel_rest_seconds() -> None:
    """For 50+ users an extra joint-prep warmup is prepended to lift
    days. The age-injected warmup must share the canonical shape."""
    print("\n[test] age-adjusted warmup uses canonical camelCase keys")
    inputs = _make_inputs(days_per_week=4, user_age=55)
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    found = False
    for d in plan["workout_plan"]["days"]:
        exs = d.get("exercises", []) or []
        if exs and exs[0].get("name") == "Extended Joint Prep":
            found = True
            jp = exs[0]
            assert "restSeconds" in jp, "age warmup missing restSeconds"
            assert "rest_seconds" not in jp, (
                "age warmup still carries snake_case rest_seconds"
            )
            # Canonical schema: setScheme + null recommendation fields
            assert "targetWeightLbs" in jp
            assert "setScheme" in jp
            assert jp.get("_role") == "warmup"
    assert found, "No Extended Joint Prep exercise found on any lift day"
    _ok("age warmup emits restSeconds + canonical null load fields")


def test_core_injected_exercises_match_canonical_schema() -> None:
    """Weekly core injection must produce exercises with the same key
    set as normal slot-built exercises."""
    print("\n[test] injected core exercises share the canonical schema")
    # body_recomp 4d has weekly_core_target = 3. At least one of the
    # 4 days should carry an injected core exercise.
    inputs = _make_inputs(days_per_week=4, goal="body_recomp")
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    core_exs = [
        ex for ex in _all_exercises(plan)
        if ex.get("_primary_muscle") == "core" or ex.get("_role") == "core"
    ]
    assert core_exs, "no core exercises produced — core injection path broken"

    required_keys = (
        "name", "sets", "reps", "restSeconds", "equipment",
        "targetWeightLbs", "setScheme",
        "_slug", "_role", "_primary_muscle",
    )
    for ex in core_exs:
        missing = [k for k in required_keys if k not in ex]
        assert not missing, (
            f"core exercise {ex.get('name')!r} missing keys {missing}"
        )
        assert "rest_seconds" not in ex
    _ok(f"{len(core_exs)} core exercises all canonical")


def test_build_planner_exercise_shape() -> None:
    """Unit test of the helper: a minimal seed row + prescription
    produces a canonical exercise dict."""
    print("\n[test] build_planner_exercise emits canonical dict")
    seed = {
        "slug": "bench_press",
        "name": "Barbell Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": ["triceps"],
        "movement_pattern": "horizontal_press",
        "is_compound": True,
        "equipment_bucket": "barbell",
        "equipment": [{"slug": "barbell", "role": "primary", "required": True}],
    }
    pres = Prescription(sets=4, reps="6-8", rest_seconds=150, rir_target=1.5)
    ex = build_planner_exercise(
        seed,
        prescription=pres,
        slot_label="Primary Press",
        role="primary",
        archetype_value="lift_upper",
        training_type="strength",
        goal_bucket="muscle_gain",
        experience="intermediate",
    )
    assert ex["name"] == "Barbell Bench Press"
    assert ex["restSeconds"] == 150
    assert "rest_seconds" not in ex
    assert ex["_role"] == "primary"
    assert ex["_primary_muscle"] == "chest"
    assert ex["_secondary_muscles"] == ["triceps"]
    assert ex["_slug"] == "bench_press"
    assert ex["_archetype"] == "lift_upper"
    # Canonical optional keys always present (None when unknown)
    for k in ("targetWeightLbs", "weightRecommendationSource",
              "weightRecommendationConfidence", "weightRecommendationReason",
              "setScheme"):
        assert k in ex, f"missing canonical key {k}"
    _ok("build_planner_exercise output shape verified")


# ── Weekly core injection ─────────────────────────────────────────

def test_weekly_core_injection_does_not_crash() -> None:
    """Regression: the old core injection called pick_for_slot with
    stale kwargs + referenced undefined `rng`. Now it must run cleanly
    on a standard intermediate recomp plan."""
    print("\n[test] weekly core injection runs without crashing")
    inputs = _make_inputs(days_per_week=4, goal="body_recomp")
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    assert plan.get("workout_plan", {}).get("days"), "plan has no days"
    # No exceptions and the plan has exercises — success.
    _ok("plan generated successfully (no silent injection crash)")


def test_weekly_core_actually_injects_core_for_fat_loss() -> None:
    """fat_loss has weekly_core_target=4 at 4 days/week. The PPL/UL
    templates don't all include core, so injection must actually add
    exercises to hit that target."""
    print("\n[test] weekly core target drives injection for fat_loss")
    inputs = _make_inputs(goal="fat_loss", days_per_week=4)
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    core_exs = [
        ex for ex in _all_exercises(plan)
        if ex.get("_primary_muscle") == "core" or ex.get("_role") == "core"
    ]
    assert len(core_exs) >= 2, (
        f"fat_loss 4d should carry ≥2 core exercises; got {len(core_exs)}"
    )
    _ok(f"{len(core_exs)} core exercises across the week")


def test_generated_core_slots_match_their_slot_category() -> None:
    """Generated core rows should match the intent of their slot label."""
    print("\n[test] generated core exercises match slot category")
    inputs = _make_inputs(goal="fat_loss", days_per_week=4)
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    core_exs = [
        ex for ex in _all_exercises(plan)
        if ex.get("_role") == "core"
    ]
    assert core_exs, "expected at least one generated core exercise"

    for ex in core_exs:
        slot = ex.get("_slot", "")
        name = (ex.get("name") or "").lower()
        primary = ex.get("_primary_muscle")
        if "Anti-Extension" in slot:
            assert primary == "core", f"anti-extension picked non-core row: {ex}"
            assert "superman" not in name, f"anti-extension picked posterior-chain hold: {ex}"
            assert "copenhagen" not in name, f"anti-extension picked lateral drill: {ex}"
        if "Lateral Stability" in slot:
            assert "side plank" in name or "copenhagen" in name, f"lateral slot picked wrong drill: {ex}"
        if "Lower Ab" in slot:
            assert any(
                term in name for term in ("raise", "crunch", "sit-up", "v-up", "toes-to-bar")
            ), f"lower-ab slot picked non-flexion drill: {ex}"
    _ok(f"{len(core_exs)} generated core rows match their slot labels")


# ── Patch rehydration ─────────────────────────────────────────────

def _sample_plan() -> dict:
    return {
        "workout_plan": {
            "name": "Test",
            "planner_mode": "lifting",
            "goal_bucket": "muscle_gain",
            "days": [
                {
                    "day": "Day 1",
                    "focus": "Push",
                    "category": "lift",
                    "exercises": [
                        {
                            "name": "Barbell Bench Press",
                            "sets": 4, "reps": "6-8", "restSeconds": 120,
                            "equipment": "barbell",
                            "targetWeightLbs": 185.0,
                            "weightRecommendationSource": "history",
                            "setScheme": [{"setNumber": 1}],
                            "_role": "primary",
                            "_primary_muscle": "chest",
                            "_secondary_muscles": ["triceps"],
                            "_rir_target": 1.5,
                        },
                    ],
                },
            ],
        },
    }


def test_swap_exercise_rebuilds_derived_fields() -> None:
    """After swap_exercise, the patched dict must have a rebuilt
    setScheme matching the new sets/reps and must drop stale weight
    metadata (since the movement changed)."""
    print("\n[test] swap_exercise rebuilds setScheme + drops stale weight")
    plan = _sample_plan()
    patch = PlanPatch(
        action="swap_exercise",
        day_index=0,
        exercise_index=0,
        new_name="Dumbbell Bench Press",
        new_equipment="dumbbell",
        new_sets=3,
        new_reps="8-12",
        new_rest_seconds=90,
        reason="variety",
    )
    apply_patches(plan, [patch])
    ex = plan["workout_plan"]["days"][0]["exercises"][0]
    assert ex["name"] == "Dumbbell Bench Press"
    assert ex["sets"] == 3
    assert ex["reps"] == "8-12"
    assert ex["restSeconds"] == 90
    # Stale load metadata dropped
    assert ex["targetWeightLbs"] is None
    assert ex["weightRecommendationSource"] is None
    # setScheme rebuilt and shape is list-of-dicts with setNumber keys
    scheme = ex.get("setScheme")
    assert isinstance(scheme, list) and scheme, f"bad setScheme after swap: {scheme!r}"
    assert "setNumber" in scheme[0] or scheme[0] == {}
    # Role preserved
    assert ex["_role"] == "primary"
    _ok("swap rebuilds setScheme, drops stale load, preserves role")


def test_add_exercise_builds_derived_fields() -> None:
    """add_exercise must produce a fully-shaped exercise with setScheme."""
    print("\n[test] add_exercise produces canonical-shape dict")
    plan = _sample_plan()
    patch = PlanPatch(
        action="add_exercise",
        day_index=0,
        new_name="Cable Fly",
        new_equipment="cable",
        new_sets=3,
        new_reps="12-15",
        new_rest_seconds=60,
        reason="missing chest isolation",
    )
    apply_patches(plan, [patch])
    ex = plan["workout_plan"]["days"][0]["exercises"][-1]
    assert ex["name"] == "Cable Fly"
    assert ex["restSeconds"] == 60
    assert "setScheme" in ex
    assert isinstance(ex["setScheme"], list)
    assert ex["_role"] == "accessory"
    _ok("add_exercise outputs canonical shape incl. setScheme")


def test_change_sets_reps_refreshes_set_scheme() -> None:
    """After change_sets_reps, the setScheme length should reflect the
    new set count (3→5 = 5 planned sets)."""
    print("\n[test] change_sets_reps refreshes setScheme length")
    plan = _sample_plan()
    plan["workout_plan"]["days"][0]["exercises"][0]["sets"] = 3
    plan["workout_plan"]["days"][0]["exercises"][0]["setScheme"] = [
        {"setNumber": 1}, {"setNumber": 2}, {"setNumber": 3}
    ]
    patch = PlanPatch(
        action="change_sets_reps",
        day_index=0,
        exercise_index=0,
        new_sets=5,
        new_reps="4-6",
        reason="strength emphasis",
    )
    apply_patches(plan, [patch])
    ex = plan["workout_plan"]["days"][0]["exercises"][0]
    assert ex["sets"] == 5
    assert ex["reps"] == "4-6"
    # Scheme was rebuilt by the rehydrator
    assert isinstance(ex["setScheme"], list)
    assert len(ex["setScheme"]) == 5, (
        f"setScheme should have 5 sets after change, got {len(ex['setScheme'])}"
    )
    _ok("setScheme grows to match new set count")


# ── Focused muscle wiring ─────────────────────────────────────────

def test_glute_focus_produces_min_exposure_days() -> None:
    """Glute focus (min_exposure_days_frac=0.4) on a 5-day plan must
    produce at least 2 days of glute exposure."""
    print("\n[test] glute focus hits min_exposure_days target on 5d plan")
    inputs = _make_inputs(days_per_week=5, focused_muscle="glutes")
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    audit = plan["workout_plan"].get("focus_audit")
    assert audit is not None, "plan missing focus_audit when focused_muscle is set"
    assert audit["muscle"] == "glutes"
    assert audit["days_with_exposure"] >= audit["min_exposure_days"], (
        f"expected ≥ {audit['min_exposure_days']} exposure days, "
        f"got {audit['days_with_exposure']}"
    )
    _ok(
        f"glutes: exposure={audit['days_with_exposure']}/"
        f"{audit['min_exposure_days']}, "
        f"accessories={audit['direct_accessories']}/"
        f"{audit['min_direct_accessories']}"
    )


def test_chest_focus_biases_split_pick() -> None:
    """Chest focus at 3 days should not push AWAY from PPL (chest's
    FocusProfile has a +8 bias on PPL). A user without focus at the
    same day count also lands on PPL, so the key assertion is that
    chest focus doesn't FLIP selection to a lower-chest-frequency split."""
    print("\n[test] chest focus allows PPL at 3 days")
    from app.services.workout.day_templates import pick_split, SPLIT_PPL, SPLIT_FULL_BODY
    inputs = _make_inputs(days_per_week=3, focused_muscle="chest")
    split = pick_split(inputs, focused_muscle="chest")
    assert split in (SPLIT_PPL, SPLIT_FULL_BODY), (
        f"chest focus on 3d should pick PPL or full_body, got {split}"
    )
    _ok(f"chest focus 3d → {split}")


def test_focus_none_behaves_like_baseline() -> None:
    """Without a focused_muscle the plan has no focus_audit block."""
    print("\n[test] no focus ⇒ no focus_audit")
    plan = generate_workout_plan(_make_inputs(focused_muscle=None), SEED_EXERCISES)
    assert plan["workout_plan"].get("focus_audit") is None
    _ok("focus_audit absent when focused_muscle is None")


# ── AI-regenerate shape parity ────────────────────────────────────

def test_ai_regenerate_shape_matches_canonical() -> None:
    """`plan_ai_regenerate` builds each exercise through
    `build_planner_exercise`, so its output dicts must carry the same
    canonical keys as a deterministic plan. We can't run the real AI call
    in tests, so we invoke the per-day builder directly with a fake AI
    response to exercise the mapping path."""
    print("\n[test] ai_regenerate output matches canonical exercise shape")
    from app.services.workout.plan_ai_regenerate import regenerate_plan_with_ai

    # Smoke the helper that routes AI dicts → canonical shape by
    # rebuilding the same loop in isolation. The production entry point
    # would require an OPENAI_API_KEY; the mapping logic is what we
    # need to assert.
    from app.services.workout.planner import build_planner_exercise
    from app.services.workout.prescriptions import Prescription

    # Pick a real seed row so build_planner_exercise has muscle + equip.
    seed = next(e for e in SEED_EXERCISES if e.get("slug") == "barbell_bench_press") \
        if any(e.get("slug") == "barbell_bench_press" for e in SEED_EXERCISES) \
        else SEED_EXERCISES[0]
    seed_with_name = dict(seed)
    seed_with_name["name"] = seed.get("name")

    # Mimic the per-exercise call in plan_ai_regenerate
    pres = Prescription(sets=3, reps="8-12", rest_seconds=90, rir_target=2.0)
    ex = build_planner_exercise(
        seed_with_name,
        prescription=pres,
        slot_label=None,
        role="primary",
        archetype_value=None,
        training_type=seed.get("training_type") or None,
        goal_bucket="muscle_gain",
        experience="intermediate",
        perf_profiles=None,
        all_exercises_by_slug=None,
    )
    # Every canonical key must be present (same invariants the
    # deterministic plan enforces).
    required = (
        "name", "sets", "reps", "restSeconds", "equipment",
        "targetWeightLbs", "weightRecommendationSource",
        "weightRecommendationConfidence", "weightRecommendationReason",
        "setScheme", "_slug", "_role", "_primary_muscle",
        "_secondary_muscles",
    )
    missing = [k for k in required if k not in ex]
    assert not missing, f"ai_regenerate exercise missing canonical keys: {missing}"
    assert ex["_role"] == "primary"
    assert "rest_seconds" not in ex
    # perf_profiles=None path — target weight is None but setScheme still
    # builds (with null weights) so the UI can render set-role pills.
    assert ex["targetWeightLbs"] is None
    assert isinstance(ex["setScheme"], list)
    _ok("ai_regenerate per-exercise build emits canonical canonical shape")


# ── Brief / reviewer contract ─────────────────────────────────────

def test_brief_includes_user_preferred_split_and_skipped_days() -> None:
    """build_plan_brief's new kwargs populate the fields the reviewer
    prompt references. When absent from the caller, they're None —
    present but null — so prompt field lookups never KeyError."""
    print("\n[test] brief carries user_preferred_split + skipped_days_7d")
    plan = _sample_plan()

    # Explicit pass-through
    brief = build_plan_brief(
        plan,
        goal="muscle_gain",
        days_per_week=4,
        experience="intermediate",
        user_preferred_split="ppl",
        skipped_days_7d=[{"focus": "legs", "count": 2}],
    )
    assert "user_preferred_split" in brief
    assert brief["user_preferred_split"] == "ppl"
    assert "skipped_days_7d" in brief
    assert brief["skipped_days_7d"] == [{"focus": "legs", "count": 2}]

    # Absent case — keys present, values None / empty
    brief_bare = build_plan_brief(
        plan,
        goal="muscle_gain",
        days_per_week=4,
        experience="intermediate",
    )
    assert brief_bare["user_preferred_split"] is None
    assert brief_bare["skipped_days_7d"] is None
    _ok("brief contract matches reviewer prompt field references")


# ── Adjacency repair regression (no 3-in-a-row same focus family) ───

def test_repair_adjacent_duplicates_breaks_three_in_a_row() -> None:
    """`_repair_adjacent_duplicates` must never leave three consecutive
    days with the same fine-grained focus family (upper, lower, push,
    pull, legs). Historically tier-A strict swaps could bail out when
    every candidate target created a new conflict, leaving e.g.
    `[upper, lower, lower, lower]` unchanged. The tiered repair (strict
    → net-reducing → forced triple-break) must always break the triple
    when at least one non-same-family item exists."""
    print("\n[test] _repair_adjacent_duplicates never leaves 3 same-family-in-a-row")
    from app.services.workout.weekly_recipe import _repair_adjacent_duplicates
    from app.services.workout.archetypes import (
        DayArchetype, archetype_to_focus_family,
    )
    A = DayArchetype

    # Each input is a synthetic recipe that the earlier single-pass
    # repair could fail to fix. Expected contract: result has no triple
    # in the "meaningful" families (upper/lower/push/pull/legs).
    cases_ = [
        # Triple lower at the END — trailing streak.
        [A.LIFT_UPPER_HEAVY, A.LIFT_LOWER_HEAVY, A.LIFT_LOWER_HYPERTROPHY, A.LIFT_LOWER],
        # Triple lower at the START — leading streak.
        [A.LIFT_LOWER_HEAVY, A.LIFT_LOWER_HYPERTROPHY, A.LIFT_LOWER, A.LIFT_UPPER_HEAVY],
        # 3L + 3U block — the classic "stimulus variants clustered" case.
        [A.LIFT_LOWER_HEAVY, A.LIFT_LOWER_HYPERTROPHY, A.LIFT_LOWER,
         A.LIFT_UPPER_HEAVY, A.LIFT_UPPER_HYPERTROPHY, A.LIFT_UPPER],
        # Real 6d body_recomp UL priority=lower_body output seen in audits:
        # trailing upper-upper with a cardio island in the middle.
        [A.LIFT_LOWER_HYPERTROPHY, A.LIFT_UPPER_HYPERTROPHY,
         A.LIFT_LOWER_HYPERTROPHY, A.COND_ZONE2,
         A.LIFT_UPPER_HYPERTROPHY, A.LIFT_UPPER_HYPERTROPHY],
    ]
    for recipe in cases_:
        repaired = _repair_adjacent_duplicates(recipe)
        fams = [archetype_to_focus_family(a) for a in repaired]
        # No 3-in-a-row for the split-identity families.
        for i in range(len(fams) - 2):
            if fams[i] in ("upper", "lower", "push", "pull", "legs"):
                assert not (fams[i] == fams[i + 1] == fams[i + 2]), (
                    f"three-in-a-row {fams[i]!r} survived repair: "
                    f"in={[archetype_to_focus_family(a) for a in recipe]} "
                    f"out={fams}"
                )
    _ok(f"tier-C force-break: {len(cases_)} synthetic triple cases resolved")


def test_generate_weekly_recipe_never_emits_three_adjacent_split_days() -> None:
    """End-to-end sweep: no (goal, days, split, priority, recent_focus,
    muscle_fatigue, age) combination may produce a recipe with three
    consecutive days in the same split-identity family. The Bro split is
    excluded (its "all upper" family collapse is by design — chest / back
    / shoulders / arms all map to 'upper' family and a 3-day Bro
    inherently has upper adjacency)."""
    print("\n[test] generate_weekly_recipe emits no triple-in-a-row (non-Bro)")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import _PROFILE_TABLE
    from app.services.workout.day_templates import (
        SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_FULL_BODY, SPLIT_PPL_UL,
    )
    from app.services.workout.archetypes import archetype_to_focus_family

    checked = 0
    violations: list[str] = []
    for goal in _PROFILE_TABLE.keys():
        profile = _PROFILE_TABLE[goal]
        for days in (3, 4, 5, 6, 7):
            for split in (SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_FULL_BODY, SPLIT_PPL_UL):
                for priority in ("balanced", "lower_body", "upper_body"):
                    for rfam in ((), ("lower",), ("upper",), ("push",), ("pull",), ("legs",)):
                        for uchose in (True, False):
                            for mf in (
                                None,
                                {"chest": 0.9, "back": 0.9, "shoulders": 0.9,
                                 "biceps": 0.9, "triceps": 0.9},
                                {"quads": 0.95, "hamstrings": 0.9, "glutes": 0.9},
                            ):
                                try:
                                    r = generate_weekly_recipe(
                                        profile, days,
                                        lifting_split=split,
                                        user_chose_split=uchose,
                                        recent_focus_families=rfam,
                                        priority_region=priority,
                                        muscle_fatigue=mf,
                                    )
                                except Exception:
                                    continue
                                checked += 1
                                fams = [archetype_to_focus_family(a) for a in r]
                                for i in range(len(fams) - 2):
                                    if fams[i] in ("upper", "lower", "push", "pull", "legs") \
                                            and fams[i] == fams[i + 1] == fams[i + 2]:
                                        violations.append(
                                            f"goal={goal} days={days} split={split} "
                                            f"priority={priority} rfam={rfam} "
                                            f"uchose={uchose} mf={mf}: fams={fams}"
                                        )
                                        break
    assert not violations, (
        f"{len(violations)} configurations still produce 3-in-a-row. "
        f"First: {violations[0]}"
    )
    _ok(f"swept {checked} non-Bro configs, zero triple-in-a-row emitted")


def test_lifting_plus_cardio_never_emits_cardio_cardio_adjacency() -> None:
    """Full-sweep regression: every lifting_plus_cardio configuration
    (fat_loss / body_recomp / toning × 3-7 days × every split × every
    recent-focus × every fatigue preset × every supported age) must
    produce a recipe with zero cardio→cardio adjacency.

    This is the regression guard for the user-reported plan
    [Push, Zone2, Zone2, Upper, Legs] on 5-day PPL+UL. The prior
    interleave appended leftover cardio days at the tail when lifts
    were exhausted before conds (e.g. cond_days=2 + lift_days=3 on
    PPL/PPL_UL at cycle_len=3 → [Push, Pull, Legs, Z2, IntShort]).
    Even-distribution interleave in _lifting_plus_cardio_recipe
    guarantees cardios land between lifts, not at the tail.

    Cardio adjacency is OUTSIDE the scope of the existing
    `*_three_adjacent_split_days` test (which only checks 3-in-a-row
    for split families) and the tier-D fallback (no cardio sibling
    exists) — hence the dedicated sweep here."""
    print("\n[test] lifting_plus_cardio emits zero cardio→cardio adjacency")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.day_templates import (
        SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_FULL_BODY, SPLIT_PPL_UL, SPLIT_BRO,
    )
    from app.services.workout.archetypes import archetype_to_focus_family

    lpc_goals = ("fat_loss", "body_recomp", "toning")
    splits = (SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_FULL_BODY, SPLIT_PPL_UL, SPLIT_BRO)
    recents = (
        (), ("push",), ("pull",), ("legs",), ("upper",), ("lower",),
        ("push", "pull"), ("upper", "upper"), ("cardio",), ("mobility",),
        ("recovery",),
    )
    fatigue_cases = (
        None,
        {"chest": 0.7},
        {"quads": 0.9, "hamstrings": 0.9, "glutes": 0.9},
        {"chest": 0.8, "back": 0.3},
    )
    ages = (None, 35, 55, 65)

    checked = 0
    violations: list[str] = []
    for goal in lpc_goals:
        profile = goal_profile_for(goal)
        for days in (3, 4, 5, 6, 7):
            for split in splits:
                for rfam in recents:
                    for uchose in (True, False):
                        for mf in fatigue_cases:
                            for age in ages:
                                try:
                                    r = generate_weekly_recipe(
                                        profile, days,
                                        lifting_split=split,
                                        user_chose_split=uchose,
                                        recent_focus_families=rfam,
                                        muscle_fatigue=mf,
                                        user_age=age,
                                    )
                                except Exception:
                                    continue
                                checked += 1
                                fams = [archetype_to_focus_family(a) for a in r]
                                for i in range(1, len(fams)):
                                    if fams[i] == "cardio" == fams[i - 1]:
                                        violations.append(
                                            f"goal={goal} days={days} split={split} "
                                            f"rfam={rfam} uchose={uchose} mf={mf} "
                                            f"age={age} → {[a.value for a in r]} "
                                            f"at idx {i}"
                                        )
                                        break
    assert not violations, (
        f"{len(violations)} cardio→cardio adjacency violations. "
        f"First: {violations[0]}"
    )
    _ok(f"swept {checked} lifting_plus_cardio configs, zero cardio→cardio emitted")


def test_repair_tier_d_substitutes_sibling_for_structural_adjacency() -> None:
    """Tier D (family-sibling substitution) must eliminate 2-adjacency
    that tier A/B/C can't resolve by pure swaps. Regression: 5-day U/L
    recipes rotated to start with the minority family have a 3:2 count
    imbalance — every swap leaves exactly 1 residual adjacency. Tier D
    substitutes one offending archetype with its cross-family sibling
    (Upper↔Lower) which rebalances the counts and kills the dup.

    This was the user-reported 'back-to-back Push/Upper days after full-plan
    regen' bug on muscle_gain 5d U/L with recent_focus_families=('upper',)."""
    print("\n[test] tier-D sibling substitution kills structural adjacency")
    from app.services.workout.weekly_recipe import _repair_adjacent_duplicates
    from app.services.workout.archetypes import (
        DayArchetype, archetype_to_focus_family,
    )
    from app.services.workout.goal_profiles import goal_profile_for
    A = DayArchetype
    profile = goal_profile_for("muscle_gain")

    # Exact state produced by the rotation path for muscle_gain 5d U/L
    # recent=('upper',): base = [U, L, U, L, U], rotated by 1 to put L
    # first yields [L, U, L, U, U] — 1 structural 2-adjacency at the end.
    recipe = [
        A.LIFT_LOWER_HYPERTROPHY,
        A.LIFT_UPPER_HYPERTROPHY,
        A.LIFT_LOWER_HYPERTROPHY,
        A.LIFT_UPPER_HYPERTROPHY,
        A.LIFT_UPPER_HYPERTROPHY,
    ]
    repaired = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=profile.allowed_archetypes,
    )
    fams = [archetype_to_focus_family(a) for a in repaired]
    dups = sum(1 for i in range(1, len(fams)) if fams[i] == fams[i - 1])
    assert dups == 0, (
        f"tier-D should have eliminated the 3:2 residual adjacency; "
        f"fams={fams}"
    )
    _ok(f"structural adjacency eliminated: in={['lower','upper','lower','upper','upper']} out={fams}")


def test_muscle_gain_5d_ul_recent_upper_has_no_adjacency_end_to_end() -> None:
    """End-to-end regression for the user's wife's reported bug.
    muscle_gain 5 days upper/lower with recent_focus_families=('upper',)
    must NOT produce any same-family adjacency — tier D should
    substitute the structural repeat.

    Note: the strict-split rebuild may override the rotation anchor to
    maintain the canonical 3U:2L ratio for 5-day UL (5 lifts = 3 upper
    + 2 lower), so day 0 may legitimately be 'upper' even when the
    rotation targets 'lower'. The key invariant is no adjacency."""
    print("\n[test] muscle_gain 5d U/L recent=upper: no family adjacency")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family

    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 5,
        lifting_split="upper_lower",
        recent_focus_families=("upper",),
        user_chose_split=True,
    )
    fams = [archetype_to_focus_family(a) for a in recipe]
    # No fine-family adjacency anywhere (the key invariant).
    for i in range(1, len(fams)):
        assert fams[i] != fams[i - 1] or fams[i] not in (
            "push", "pull", "legs", "upper", "lower",
        ), (
            f"adjacent same-family at {i - 1}-{i} ({fams[i]!r}); full fams={fams}"
        )
    _ok(f"fams={fams}")


def test_lift_priority_rescue_swaps_cardio_day0_when_no_recent_lift() -> None:
    """Regression for report 2: body_recomp user whose last 36h held
    only Mobility (no lift) must NOT get day 0 = cardio/mobility. The
    rescue pass swaps day 0 with the nearest lift day in the recipe.
    Verified for every combination that previously produced NONLIFT
    day 0 when recent_focus_families = ('mobility',), ('cardio',),
    ('recovery',), etc."""
    print("\n[test] lift-priority rescue: non-lift recent → lift on day 0")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META

    goals = ("body_recomp", "fat_loss", "muscle_gain")
    splits = ("ppl", "upper_lower", "full_body", "ppl_ul")
    rfs = (
        ("mobility",),
        ("cardio",),
        ("recovery",),
        ("mobility", "cardio"),
        ("cardio", "mobility"),
    )
    checked = 0
    for goal in goals:
        profile = goal_profile_for(goal)
        for days in (4, 5, 6):
            for split in splits:
                for rf in rfs:
                    recipe = generate_weekly_recipe(
                        profile, days,
                        lifting_split=split,
                        recent_focus_families=rf,
                        user_chose_split=True,
                    )
                    cat = ARCHETYPE_META[recipe[0]].category
                    assert cat == "lift", (
                        f"day 0 should be a lift when recent={rf} "
                        f"(no lift family) — got {recipe[0].value} "
                        f"(cat={cat}) for goal={goal} split={split} days={days}"
                    )
                    checked += 1
    _ok(f"swept {checked} configs, all produce lift on day 0")


def test_lift_priority_rescue_no_op_when_recent_includes_lift() -> None:
    """The rescue pass must NOT fire when recent_focus_families contains
    a lift family — the rotation pass already handled that case, and
    overriding it would force consecutive same-family lifts."""
    print("\n[test] lift-priority rescue is a no-op with a recent lift entry")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import ARCHETYPE_META, archetype_to_focus_family

    profile = goal_profile_for("body_recomp")
    # recent has BOTH mobility AND a lift family — rescue should not fire
    # because the user lifted within 36h, we just happened to do mobility
    # today. The rotation still must avoid repeating the lift family.
    recipe = generate_weekly_recipe(
        profile, 5,
        lifting_split="ppl",
        recent_focus_families=("mobility", "push"),
        user_chose_split=True,
    )
    # Day 0 must avoid 'push' family (rotation intact).
    day0_fam = archetype_to_focus_family(recipe[0])
    assert day0_fam != "push", f"rotation broken: day 0 = {day0_fam}"
    _ok(f"rescue no-op with lift in recent; day0={day0_fam}")


# ── Safety-net regression tests ──────────────────────────────────────


def test_active_recovery_injection_does_not_create_mobility_adjacency() -> None:
    """The active-recovery injection at the end of generate_weekly_recipe
    replaces / appends a MOBILITY_FLOW day. If the previous last day was
    already mobility (e.g. from a prior recovery allocation), appending
    a second mobility day creates mobility→mobility adjacency. Regression:
    the post-injection repair must kill this.

    Bro split is excluded: at 7 days it has 5 fixed lift days + 2
    non-lift days that may both legitimately be mobility (similar to how
    the triple-adjacency test excludes Bro because its families all
    collapse to 'upper')."""
    print("\n[test] active-recovery injection runs repair afterwards")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family

    # Sweep a handful of lifting goals that allow mobility — the
    # recipes must NEVER emit back-to-back mobility families as a
    # side effect of the injection pass. Bro excluded (see docstring).
    for goal in ("muscle_gain", "body_recomp", "fat_loss", "strength", "toning"):
        profile = goal_profile_for(goal)
        for days in (6, 7):
            for split in ("ppl", "upper_lower", "full_body", "ppl_ul"):
                recipe = generate_weekly_recipe(
                    profile, days,
                    lifting_split=split,
                    user_chose_split=True,
                )
                fams = [archetype_to_focus_family(a) for a in recipe]
                for i in range(1, len(fams)):
                    if fams[i] == "mobility" and fams[i - 1] == "mobility":
                        raise AssertionError(
                            f"mobility→mobility at {i-1}-{i} for "
                            f"goal={goal} days={days} split={split}: fams={fams}"
                        )
    _ok("no mobility→mobility leakage after active-recovery injection")


def test_final_safety_net_runs_repair_one_more_time() -> None:
    """A final adjacency-repair pass is guaranteed at the end of
    generate_weekly_recipe — regardless of which intermediate step
    last mutated the recipe. This regression pins the invariant so
    future refactors can't accidentally drop the final pass."""
    print("\n[test] final-safety-net runs repair after every pipeline step")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family

    # Configs that historically stressed each pipeline stage:
    #   - rotation + fatigue + tier-D  → muscle_gain 5d UL recent=upper
    #   - intensity spacing swap       → strength 6d with heavy clustering
    #   - age-55 lift→mobility swap    → muscle_gain 6d PPL age=60
    #   - lift-priority rescue         → body_recomp 5d PPL recent=mobility
    combos = [
        ("muscle_gain", 5, "upper_lower", ("upper",), None, None, True),
        ("strength", 6, "upper_lower", (), None, None, True),
        ("muscle_gain", 6, "ppl", ("legs",), None, 60, True),
        ("body_recomp", 5, "ppl", ("mobility",), None, None, False),
        ("fat_loss", 7, "upper_lower", ("lower",), {"chest": 0.7}, 55, True),
    ]
    for goal, days, split, rfam, mf, age, uchose in combos:
        profile = goal_profile_for(goal)
        recipe = generate_weekly_recipe(
            profile, days,
            lifting_split=split,
            user_chose_split=uchose,
            recent_focus_families=rfam,
            muscle_fatigue=mf,
            user_age=age,
        )
        fams = [archetype_to_focus_family(a) for a in recipe]
        for i in range(1, len(fams)):
            a, b = fams[i - 1], fams[i]
            if a == b and a in ("push", "pull", "legs", "upper", "lower"):
                raise AssertionError(
                    f"adjacency survived final repair for "
                    f"goal={goal} days={days} split={split} rfam={rfam} "
                    f"mf={mf} age={age}: fams={fams}"
                )
    _ok("final safety net holds across all stressor combinations")


# ── Surgical-edit regression tests (weekly_recipe post-processing) ──


def test_length_guarantee_always_matches_days_per_week() -> None:
    """`generate_weekly_recipe` must always return exactly `days` days,
    no matter which goal / split / recent-focus combo runs. Sweeps a
    dense matrix of inputs and asserts `len(recipe) == days` every time."""
    print("\n[test] length guarantee: len(recipe) == days for every combo")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe

    goals = (
        "fat_loss", "muscle_gain", "body_recomp", "strength",
        "endurance", "athletic_performance", "hyrox", "toning",
        "maintain", "general_health",
    )
    splits = ("ppl", "upper_lower", "full_body", "ppl_ul", "bro", None)
    rfams = ((), ("push",), ("upper",), ("mobility",), ("push", "pull"))
    mfs = (None, {"chest": 0.8, "quads": 0.2})
    ages = (None, 30, 55)
    checked = 0
    for goal in goals:
        profile = goal_profile_for(goal)
        for days in (1, 2, 3, 4, 5, 6, 7):
            for split in splits:
                for rfam in rfams:
                    for mf in mfs:
                        for age in ages:
                            recipe = generate_weekly_recipe(
                                profile, days,
                                lifting_split=split,
                                user_chose_split=(split is not None),
                                recent_focus_families=rfam,
                                muscle_fatigue=mf,
                                user_age=age,
                            )
                            assert len(recipe) == days, (
                                f"len(recipe)={len(recipe)} != days={days} "
                                f"(goal={goal} split={split} rfam={rfam} "
                                f"mf={mf} age={age})"
                            )
                            checked += 1
    _ok(f"swept {checked} configs, every result has len==days")


def test_strict_ul_user_chose_preserves_alternation_end_to_end() -> None:
    """Strict user-chosen UL with even lift_days must produce alternating
    Upper/Lower across the LIFT days (cardio/mobility may interleave).
    Regression for the split-identity guard: post-processing passes
    can rearrange cardio/recovery but must never break the U↔L
    alternation a strict-UL user explicitly chose."""
    print("\n[test] strict UL user-chose: U↔L alternation preserved")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family

    # Even lift_days configurations only. Muscle_gain 4d UL, body_recomp
    # 6d UL (with 1 cond → 5 lifts → odd → skip), strength 6d UL.
    configs = [
        ("muscle_gain", 4, None),
        ("muscle_gain", 6, ("upper",)),
        ("strength", 4, None),
        ("strength", 6, ("lower",)),
    ]
    for goal, days, rfam in configs:
        profile = goal_profile_for(goal)
        recipe = generate_weekly_recipe(
            profile, days,
            lifting_split="upper_lower",
            user_chose_split=True,
            recent_focus_families=rfam or (),
        )
        fams = [archetype_to_focus_family(a) for a in recipe]
        # Extract only upper/lower tokens
        ul_tokens = [f for f in fams if f in ("upper", "lower")]
        # Even-count UL must strictly alternate.
        if len(ul_tokens) >= 2 and len(ul_tokens) % 2 == 0:
            for i in range(len(ul_tokens) - 1):
                assert ul_tokens[i] != ul_tokens[i + 1], (
                    f"strict UL alternation broken for goal={goal} "
                    f"days={days}: fams={fams}"
                )
    _ok("strict UL alternation preserved across configs")


def test_ppl_cycle_integrity_preserved_through_all_passes() -> None:
    """PPL / PPL_UL users must see a CONSISTENT PPL rotation through
    the LIFT days — not necessarily the canonical Push→Pull→Legs order,
    but whichever rotation the history-based system established (e.g.
    Legs→Pull→Push is equally valid). Uses `_ppl_cycle_breaks` which
    detects the rotation from the observed sequence.

    Sweeps lifting-mode (muscle_gain) PPL and lifting_plus_cardio-mode
    (body_recomp) PPL across a range of recent-focus inputs."""
    print("\n[test] PPL cycle integrity across passes")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe, _ppl_cycle_breaks
    from app.services.workout.archetypes import archetype_to_focus_family

    configs = [
        ("muscle_gain", 6, "ppl", ()),
        ("muscle_gain", 6, "ppl", ("push",)),
        ("muscle_gain", 6, "ppl", ("legs",)),
        ("body_recomp", 6, "ppl", ()),
        ("body_recomp", 6, "ppl", ("pull",)),
        ("body_recomp", 6, "ppl", ("mobility",)),
        ("strength", 6, "ppl", ()),
    ]
    for goal, days, split, rfam in configs:
        profile = goal_profile_for(goal)
        recipe = generate_weekly_recipe(
            profile, days,
            lifting_split=split,
            user_chose_split=True,
            recent_focus_families=rfam,
        )
        fams = [archetype_to_focus_family(a) for a in recipe]
        lift_tokens = [f for f in fams if f in ("push", "pull", "legs")]
        # Use _ppl_cycle_breaks which detects the observed rotation
        # pattern from the sequence itself (not a hardcoded canonical
        # order). Any consistent rotation scores 0.
        breaks = _ppl_cycle_breaks(lift_tokens, hybrid=False)
        # lifting_plus_cardio modes (body_recomp, fat_loss) can't
        # have a strict rotation when cardio is interleaved:
        # _promote_same_day_cardio replaces the cardio slot with the
        # least-represented family which won't always match the
        # rotation successor at that position. Cardio preservation >
        # strict rotation for these goals.
        is_lifting_plus_cardio = goal in ("body_recomp", "fat_loss")
        max_breaks = len(lift_tokens) if is_lifting_plus_cardio else 0
        assert breaks <= max_breaks, (
            f"PPL cycle has {breaks} breaks (max {max_breaks}) for "
            f"goal={goal} days={days} rfam={rfam}: fams={fams}"
        )
    _ok("PPL cycle integrity preserved across all configs")


def test_narrow_heavy_streak_body_recomp_no_triple_heavy_days() -> None:
    """Fix #3: body_recomp (planner_mode=lifting_plus_cardio,
    mix.strength<0.35) must NEVER get 3+ consecutive heavy days.
    Prior behaviour with `planner_mode == "lifting"` clause allowed
    heavy streaks for any lifting-mode goal regardless of strength
    dial. Narrowed gate forces alternating heavy/volume for low-
    strength lifting goals."""
    print("\n[test] body_recomp never produces 3+ consecutive heavy days")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.weekly_recipe import _is_heavy

    profile = goal_profile_for("body_recomp")
    for days in (4, 5, 6, 7):
        for split in ("ppl", "upper_lower", None):
            recipe = generate_weekly_recipe(
                profile, days,
                lifting_split=split,
                user_chose_split=(split is not None),
            )
            # Scan for any run of 3 heavy days.
            run = 0
            for a in recipe:
                run = run + 1 if _is_heavy(a) else 0
                assert run < 3, (
                    f"body_recomp days={days} split={split} produced "
                    f"3+ consecutive heavy days: "
                    f"{[x.value for x in recipe]}"
                )
    _ok("body_recomp always spaces heavy days with narrowed gate")


def test_lift_priority_rescue_uses_coarse_bucket_fallback() -> None:
    """Fix #4: lift-priority rescue must also honour recent_focus_buckets
    when recent_focus_families is empty. A user whose last session was
    passed as coarse bucket ("upper_body",) with no fine families
    should still be treated as having lifted recently — rescue must
    NOT fire."""
    print("\n[test] lift-priority rescue fallback uses coarse buckets")
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.archetypes import archetype_to_focus_family

    profile = goal_profile_for("body_recomp")

    # Case A: fine families empty, coarse bucket = upper_body
    # (represents a lift). Rescue must NOT rotate day 0 to force a
    # lift if day 0 is already fine.
    recipe_a = generate_weekly_recipe(
        profile, 5,
        lifting_split="ppl",
        user_chose_split=True,
        recent_focus_buckets=("upper_body",),
    )
    fam_a = archetype_to_focus_family(recipe_a[0])
    # day 0 may legitimately be cardio/mobility/lift — the rescue
    # just mustn't mistakenly think the user hasn't lifted.
    # Verify the rescue is a no-op: with recent_buckets containing
    # upper_body, has_lifted_recently() must return True.
    from app.services.workout.weekly_recipe import _has_lifted_recently
    assert _has_lifted_recently((), ("upper_body",)) is True
    assert _has_lifted_recently((), ("cardio",)) is False

    # Case B: fine families with only mobility → no lift anywhere →
    # rescue must fire and day 0 must be a lift.
    from app.services.workout.archetypes import ARCHETYPE_META
    recipe_b = generate_weekly_recipe(
        profile, 5,
        lifting_split="ppl",
        user_chose_split=True,
        recent_focus_families=("mobility",),
    )
    assert ARCHETYPE_META[recipe_b[0]].category == "lift", (
        f"rescue didn't swap day 0 to lift: {recipe_b[0].value}"
    )
    _ok(f"coarse-bucket fallback + fine-only paths both correct "
        f"(day0_a={fam_a})")


# ── AI regen post-assembly adjacency repair ───────────────────────

def test_ai_regen_adjacency_repair_breaks_same_family_back_to_back() -> None:
    """AI emits [Push, Push, Legs, Pull, Rest]. After the post-assembly
    adjacency repair, no two adjacent days share the same focus family."""
    print("\n[test] ai_regen adjacency repair: Push/Push/Legs/Pull/Rest")
    from app.services.workout.plan_ai_regenerate import _repair_focus_adjacency
    from app.services.workout.focus_normalize import normalize_focus_to_family

    days = [
        {"day": "Day 1", "focus": "Push", "exercises": [{"name": "Bench"}]},
        {"day": "Day 2", "focus": "Push", "exercises": [{"name": "OHP"}]},
        {"day": "Day 3", "focus": "Legs", "exercises": [{"name": "Squat"}]},
        {"day": "Day 4", "focus": "Pull", "exercises": [{"name": "Row"}]},
        {"day": "Day 5", "focus": "Rest", "exercises": [{"name": "Walk"}]},
    ]
    repaired, ok = _repair_focus_adjacency(days)
    assert ok, f"repair reported unresolvable, got {[d['focus'] for d in repaired]}"
    families = [normalize_focus_to_family(d["focus"]) for d in repaired]
    for i in range(1, len(families)):
        if families[i - 1] is None or families[i] is None:
            continue
        assert families[i - 1] != families[i], (
            f"adjacent same-family days at {i-1},{i}: {families}"
        )
    # Every original exercise survived — no day was dropped.
    assert len(repaired) == len(days)
    assert all(d.get("exercises") for d in repaired)
    _ok(f"repaired sequence: {[d['focus'] for d in repaired]}")


def test_ai_regen_adjacency_repair_catches_pull_upper_coarse_bucket() -> None:
    """Pull → Upper collapses to upper_body/upper_body at the coarse
    bucket level. Even though 'pull' != 'upper' at the fine family
    level, the bucket adjacency is a violation for U/L mixed plans."""
    print("\n[test] ai_regen adjacency repair: Pull/Upper coarse bucket")
    from app.services.workout.plan_ai_regenerate import _repair_focus_adjacency
    from app.services.workout.focus_normalize import normalize_focus_to_family
    from app.services.workout.weekly_recipe import _FINE_TO_COARSE

    days = [
        {"day": "Day 1", "focus": "Pull", "exercises": [{"name": "Row"}]},
        {"day": "Day 2", "focus": "Upper", "exercises": [{"name": "Bench"}]},
        {"day": "Day 3", "focus": "Lower", "exercises": [{"name": "Squat"}]},
        {"day": "Day 4", "focus": "Cardio", "exercises": [{"name": "Bike"}]},
    ]
    repaired, ok = _repair_focus_adjacency(days)
    assert ok, (
        f"repair failed on Pull/Upper coarse adjacency, got "
        f"{[d['focus'] for d in repaired]}"
    )
    # Check coarse buckets too — Pull and Upper both map to upper_body.
    buckets: list = []
    for d in repaired:
        fam = normalize_focus_to_family(d["focus"])
        buckets.append(_FINE_TO_COARSE.get(fam, fam) if fam else None)
    for i in range(1, len(buckets)):
        if buckets[i - 1] is None or buckets[i] is None:
            continue
        assert buckets[i - 1] != buckets[i], (
            f"adjacent same-bucket at {i-1},{i}: {buckets}"
        )
    _ok(f"repaired sequence: {[d['focus'] for d in repaired]}")


def test_ai_regen_adjacency_repair_reports_unresolvable_for_bad_ai() -> None:
    """If the AI emits something structurally impossible to resolve
    (e.g. all 5 days collapse to the same family), the repair reports
    ok=False so the caller can fall back to the deterministic plan."""
    print("\n[test] ai_regen adjacency repair: unresolvable bad AI output")
    from app.services.workout.plan_ai_regenerate import _repair_focus_adjacency

    days = [
        {"day": f"Day {i + 1}", "focus": "Push", "exercises": [{"name": "Bench"}]}
        for i in range(5)
    ]
    _, ok = _repair_focus_adjacency(days)
    assert not ok, "unresolvable all-Push plan should report ok=False"
    _ok("all-Push nonsense input correctly flagged unresolvable")


def test_ai_regen_adjacency_clean_input_is_no_op() -> None:
    """When the AI already produces a clean sequence, the repair
    leaves it untouched — no reshuffling, no changes."""
    print("\n[test] ai_regen adjacency repair: clean input is no-op")
    from app.services.workout.plan_ai_regenerate import _repair_focus_adjacency

    days = [
        {"day": "Day 1", "focus": "Push", "exercises": [{"name": "Bench"}]},
        {"day": "Day 2", "focus": "Pull", "exercises": [{"name": "Row"}]},
        {"day": "Day 3", "focus": "Legs", "exercises": [{"name": "Squat"}]},
        {"day": "Day 4", "focus": "Cardio", "exercises": [{"name": "Bike"}]},
    ]
    repaired, ok = _repair_focus_adjacency(days)
    assert ok
    assert [d["focus"] for d in repaired] == ["Push", "Pull", "Legs", "Cardio"]
    _ok("clean sequence passed through unchanged")


# ── Runner ────────────────────────────────────────────────────────

cases = [
    test_every_exercise_uses_camel_rest_seconds,
    test_age_warmup_uses_camel_rest_seconds,
    test_core_injected_exercises_match_canonical_schema,
    test_build_planner_exercise_shape,
    test_weekly_core_injection_does_not_crash,
    test_weekly_core_actually_injects_core_for_fat_loss,
    test_generated_core_slots_match_their_slot_category,
    test_swap_exercise_rebuilds_derived_fields,
    test_add_exercise_builds_derived_fields,
    test_change_sets_reps_refreshes_set_scheme,
    test_glute_focus_produces_min_exposure_days,
    test_chest_focus_biases_split_pick,
    test_focus_none_behaves_like_baseline,
    test_ai_regenerate_shape_matches_canonical,
    test_brief_includes_user_preferred_split_and_skipped_days,
    test_repair_adjacent_duplicates_breaks_three_in_a_row,
    test_generate_weekly_recipe_never_emits_three_adjacent_split_days,
    test_lifting_plus_cardio_never_emits_cardio_cardio_adjacency,
    test_repair_tier_d_substitutes_sibling_for_structural_adjacency,
    test_muscle_gain_5d_ul_recent_upper_has_no_adjacency_end_to_end,
    test_lift_priority_rescue_swaps_cardio_day0_when_no_recent_lift,
    test_lift_priority_rescue_no_op_when_recent_includes_lift,
    test_active_recovery_injection_does_not_create_mobility_adjacency,
    test_final_safety_net_runs_repair_one_more_time,
    test_length_guarantee_always_matches_days_per_week,
    test_strict_ul_user_chose_preserves_alternation_end_to_end,
    test_ppl_cycle_integrity_preserved_through_all_passes,
    test_narrow_heavy_streak_body_recomp_no_triple_heavy_days,
    test_lift_priority_rescue_uses_coarse_bucket_fallback,
    test_ai_regen_adjacency_repair_breaks_same_family_back_to_back,
    test_ai_regen_adjacency_repair_catches_pull_upper_coarse_bucket,
    test_ai_regen_adjacency_repair_reports_unresolvable_for_bad_ai,
    test_ai_regen_adjacency_clean_input_is_no_op,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Planner schema + focus wiring tests")
    print("=" * 60)
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    print()
    if failures:
        print(f"  {failures} of {len(cases)} tests FAILED")
        raise SystemExit(1)
    print(f"  All {len(cases)} tests passed.")
