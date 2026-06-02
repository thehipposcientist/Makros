"""Unit tests for density trimming (slots.py) + prescription dispatch
(prescriptions.py) + core programmer (core_programmer.py).

These are the three pure-function modules that shape what a workout day
actually looks like — slot count, set/rep/rest numbers, and core
placement. All deterministic, no DB, no AI.

Coverage:
  - density_adjust_slots: budget-aware trimming per category
  - prescribe_for_slot: correct dispatch for every training_type
  - _prescribe_by_stimulus: strength/hypertrophy/volume rep tables
  - _prescribe_conditioning: budget-scaled interval counts
  - core_programmer: decide_core_for_day + program_core_across_week
"""
from __future__ import annotations

from app.services.workout.slots import Slot, density_adjust_slots
from app.services.workout.prescriptions import (
    Prescription,
    prescribe_for_slot,
    _prescribe_by_stimulus,
    _prescribe_conditioning,
    _prescribe_warmup,
    _prescribe_mobility,
    _prescribe_recovery,
    _prescribe_power,
)
from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META
from app.services.workout.core_programmer import (
    weekly_core_target,
    CoreFrequency,
    decide_core_for_day,
    _day_type_for_archetype,
    _duration_bucket,
    _core_exercise_count,
    _is_session_dense,
    build_core_slot,
    core_slot_accepts_exercise,
    core_slot_score_bonus,
    program_core_across_week,
    _NEVER_CORE_ARCHETYPES,
    CAT_ANTI_EXTENSION,
    CAT_ANTI_ROTATION,
    CAT_LATERAL_STABILITY,
    CAT_FLEXION,
    CAT_POSTERIOR_BRACING,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── density_adjust_slots ───────────────────────────────────────────────────

def _make_slots(roles: list[str]) -> list[Slot]:
    return [Slot(f"Slot-{i}", "horizontal_press", "chest", r)
            for i, r in enumerate(roles)]


def test_density_expands_when_budget_has_room():
    """If a lift template underfills a larger budget, add bounded accessories."""
    print("\n[test] density: lift template expands when budget has room")
    slots = _make_slots(["primary", "primary", "secondary", "isolation", "core"])
    result = density_adjust_slots(slots, 75, category="lift")
    assert len(result) == 9, f"expected 9, got {len(result)}"
    assert [s.role for s in result[-4:]] == [
        "isolation", "isolation", "isolation", "isolation",
    ]
    _ok("75 min budget adds bounded isolation slots")


def test_density_trims_warmup_first():
    """Warmup is the first to be dropped."""
    print("\n[test] density: warmup drops first")
    slots = _make_slots(["warmup", "primary", "primary", "secondary", "isolation", "core"])
    result = density_adjust_slots(slots, 30, category="lift")
    roles = [s.role for s in result]
    assert "warmup" not in roles, f"warmup survived trim at 30min: {roles}"
    _ok("warmup dropped first on 30min budget")


def test_density_never_drops_primary():
    """Primary slots survive even if budget is too small for them."""
    print("\n[test] density: primaries never dropped")
    slots = _make_slots(["primary", "primary", "secondary", "isolation", "core", "warmup"])
    result = density_adjust_slots(slots, 20, category="lift")
    roles = [s.role for s in result]
    primary_count = roles.count("primary")
    assert primary_count == 2, f"primaries dropped! {roles}"
    _ok("2 primaries survive at 20min budget")


def test_density_drop_order_is_warmup_core_iso_secondary():
    """Drop order: warmup → core → isolation → secondary."""
    print("\n[test] density: drop order warmup > core > iso > secondary")
    slots = _make_slots(["warmup", "primary", "secondary", "isolation", "core"])
    # Budget that forces dropping warmup + core + isolation (3+4+6=13 saved)
    # total = 3+12+8+6+4 = 33. Budget = 21 → need to drop 12.
    # warmup(3) + core(4) + iso(6) = 13 saved → total=20 ≤ 21 ✓
    result = density_adjust_slots(slots, 21, category="lift")
    roles = [s.role for s in result]
    assert "warmup" not in roles
    assert "core" not in roles
    assert "isolation" not in roles
    assert "primary" in roles and "secondary" in roles
    _ok("correct drop order: warmup, core, isolation")


def test_density_cond_category_uses_different_costs():
    """Conditioning category has a 25-min primary, not 12-min."""
    print("\n[test] density: cond category has expensive primary")
    slots = _make_slots(["primary", "secondary", "warmup"])
    # Cond: primary=25, secondary=6, warmup=3. Total=34.
    # Budget=30 should drop warmup (3) → 31 > 30, drop secondary(6) → 25 ≤ 30.
    result = density_adjust_slots(slots, 30, category="cond")
    roles = [s.role for s in result]
    # Primary survives (never dropped); secondary might be kept or not depending on budget math.
    assert "primary" in roles
    _ok("cond category: primary survives at 30min budget")


def test_density_none_session_minutes_no_trim():
    """None session_minutes means no trimming at all."""
    print("\n[test] density: None minutes → no trim")
    slots = _make_slots(["warmup", "primary", "secondary", "isolation", "core"])
    result = density_adjust_slots(slots, None, category="lift")
    assert len(result) == 5
    _ok("None minutes → all 5 slots kept")


# ─── prescribe_for_slot ────────────────────────────────────────────────────

def _make_inputs(goal="muscle_gain", session_minutes=60, cardio_baseline=None):
    """Minimal PlannerInputs-shaped object for prescription tests."""
    from types import SimpleNamespace
    return SimpleNamespace(
        goal=goal,
        session_minutes=session_minutes,
        experience="intermediate",
        days_per_week=5,
        cardio_baseline=cardio_baseline,
    )


def test_prescribe_warmup_always_light():
    """Warmup-role slots always get 2 sets × 6-8 reps, no rest."""
    print("\n[test] prescriptions: warmup role → 2 × 6-8, 0 rest")
    slot = Slot("Warmup", "mobility", "full_body", "warmup")
    ex = {"name": "Mobility Flow", "movement_pattern": "mobility"}
    pres = _prescribe_warmup(slot, ex)
    assert pres.sets == 2, f"sets={pres.sets}"
    assert "6" in pres.reps and "8" in pres.reps, f"reps={pres.reps}"
    assert pres.rest_seconds == 0, f"rest={pres.rest_seconds}"
    _ok("warmup: 2×6-8, 0s rest")


def test_prescribe_stimulus_strength_primary():
    """Strength stimulus + primary role → 4×3-5, 180s rest."""
    print("\n[test] prescriptions: strength stimulus primary → 4×3-5, 180s")
    slot = Slot("Squat", "squat", "quads", "primary")
    ex = {"name": "Barbell Squat", "movement_pattern": "squat"}
    pres = _prescribe_by_stimulus("strength", slot, ex)
    assert pres.sets == 4, f"sets={pres.sets}"
    assert pres.reps == "3-5", f"reps={pres.reps}"
    assert pres.rest_seconds == 180, f"rest={pres.rest_seconds}"
    assert pres.rir_target == 1.5, f"rir={pres.rir_target}"
    _ok("strength primary: 4×3-5, 180s, RIR 1.5")


def test_prescribe_stimulus_hypertrophy_isolation():
    """Hypertrophy stimulus + isolation role → 3×10-15, 75s rest."""
    print("\n[test] prescriptions: hypertrophy isolation → 3×10-15, 75s")
    slot = Slot("Curls", "isolation", "biceps", "isolation")
    ex = {"name": "Dumbbell Curl", "movement_pattern": "isolation"}
    pres = _prescribe_by_stimulus("hypertrophy", slot, ex)
    assert pres.sets == 3
    assert pres.reps == "10-15"
    assert pres.rest_seconds == 75
    _ok("hypertrophy iso: 3×10-15, 75s")


def test_prescribe_stimulus_volume_primary():
    """Volume stimulus + primary → 3×10-15, 90s rest."""
    print("\n[test] prescriptions: volume primary → 3×10-15, 90s")
    slot = Slot("Bench", "horizontal_press", "chest", "primary")
    ex = {"name": "Bench Press", "movement_pattern": "horizontal_press"}
    pres = _prescribe_by_stimulus("volume", slot, ex)
    assert pres.sets == 3
    assert pres.reps == "10-15"
    assert pres.rest_seconds == 90
    _ok("volume primary: 3×10-15, 90s")


def test_prescribe_conditioning_zone2_scales_to_session():
    """Zone 2 primary prescription scales to session_minutes.

    With enhanced cardio guidance, the reps string now includes modality-
    specific metrics (e.g. speed/incline for treadmill). We verify the
    core invariants: 1 set, duration-based (contains "min"), and the
    prescription_type is cardio_steady.
    """
    print("\n[test] prescriptions: zone2 scales to session")
    slot = Slot("Main Cardio", "cardio", None, "primary")
    ex = {"name": "Treadmill", "movement_pattern": "cardio", "exercise_type": "cardio"}
    inputs = _make_inputs(session_minutes=60)
    pres = _prescribe_conditioning(DayArchetype.COND_ZONE2, slot, ex, inputs)
    assert pres.sets == 1
    assert "min" in pres.reps, f"Zone2 must be duration-based: '{pres.reps}'"
    assert pres.prescription_type == "cardio_steady", f"Got '{pres.prescription_type}'"
    # Duration budget: 60min session → main block ~50 min (budget-scaled)
    # The reps string may be enhanced with speed/incline but must still contain a duration.
    # Accept either old "NN-NN min" format or new "NN min, ..." format.
    import re
    assert re.search(r"\d{2,3}\s*min", pres.reps), \
        f"Zone2 prescription must contain a NN min duration: '{pres.reps}'"
    _ok(f"zone2 60min → {pres.reps}")


def test_prescribe_conditioning_cardio_baseline_caps_zone2():
    """Signup cardio baseline should tune duration/cues deterministically."""
    print("\n[test] prescriptions: cardio baseline caps early zone2")
    slot = Slot("Main Cardio", "cardio", None, "primary")
    ex = {"name": "Treadmill", "movement_pattern": "cardio", "exercise_type": "cardio"}
    inputs = _make_inputs(
        session_minutes=60,
        cardio_baseline={
            "canJog10Min": False,
            "comfortableDurationMin": 12,
        },
    )
    pres = _prescribe_conditioning(DayArchetype.COND_ZONE2, slot, ex, inputs)
    assert pres.cardio_guidance is not None
    duration = pres.cardio_guidance["duration_min"]
    assert duration <= 20, pres.cardio_guidance
    assert pres.cardio_guidance["intensity_cue"] == "walk/jog intervals"
    assert f"{duration} min" in pres.reps, pres.reps
    _ok(f"cardio baseline → {pres.reps}")


def test_prescribe_conditioning_short_intervals_count_scales():
    """Short intervals count = round(work_minutes / 2.75), clamped 6-16."""
    print("\n[test] prescriptions: short intervals count scales with duration")
    slot = Slot("Intervals", "cardio", None, "primary")
    ex = {"name": "Bike Sprint", "movement_pattern": "cardio"}

    # 30min session → work_minutes=20 → count=round(20/2.75)=7
    inputs_30 = _make_inputs(session_minutes=30)
    pres_30 = _prescribe_conditioning(DayArchetype.COND_INTERVALS_SHORT, slot, ex, inputs_30)
    assert 6 <= pres_30.sets <= 8, f"30min: sets={pres_30.sets}"

    # 60min session → work_minutes=50 → count=round(50/2.75)=18→clamped 16
    inputs_60 = _make_inputs(session_minutes=60)
    pres_60 = _prescribe_conditioning(DayArchetype.COND_INTERVALS_SHORT, slot, ex, inputs_60)
    assert pres_60.sets <= 16, f"60min: sets={pres_60.sets} (should be <=16)"
    assert pres_60.sets > pres_30.sets, "60min should have more intervals than 30min"
    _ok(f"short intervals: 30min→{pres_30.sets}, 60min→{pres_60.sets}")


def test_prescribe_power_cardio_gets_sprints():
    """Power archetype + cardio exercise → sprint prescription, not '3-5 reps'."""
    print("\n[test] prescriptions: power + cardio exercise → sprints")
    slot = Slot("Sprint", "cardio", None, "primary")
    ex = {"name": "Bike Sprint", "movement_pattern": "cardio"}
    inputs = _make_inputs()
    pres = _prescribe_power(slot, ex, inputs)
    assert pres.sets == 8
    assert "s" in pres.reps  # "10-15s"
    _ok("power + cardio → 8×10-15s sprints")


def test_prescribe_power_plyometric():
    """Power + plyometric → 4×3-5."""
    print("\n[test] prescriptions: power + plyometric → 4×3-5")
    slot = Slot("Jump", "plyometric", None, "primary")
    ex = {"name": "Box Jump", "movement_pattern": "plyometric"}
    inputs = _make_inputs()
    pres = _prescribe_power(slot, ex, inputs)
    assert pres.sets == 4
    assert pres.reps == "3-5"
    _ok("power + plyometric → 4×3-5")


def test_prescribe_mobility_minimal_rest():
    """Mobility prescription has minimal rest (<=30s)."""
    print("\n[test] prescriptions: mobility → minimal rest")
    slot = Slot("Flow", "mobility", None, "primary")
    ex = {"name": "Hip Flow", "movement_pattern": "mobility"}
    pres = _prescribe_mobility(slot, ex)
    assert pres.rest_seconds <= 30, f"rest={pres.rest_seconds}, expected <=30"
    assert pres.sets in (2, 3)
    _ok(f"mobility: {pres.sets} sets, {pres.rest_seconds}s rest")


def test_prescribe_recovery_easy():
    """Recovery → 1 set of easy duration."""
    print("\n[test] prescriptions: recovery → 1×easy duration")
    slot = Slot("Easy Walk", "cardio", None, "primary")
    ex = {"name": "Walk", "movement_pattern": "cardio"}
    pres = _prescribe_recovery(slot, ex)
    assert pres.sets == 1
    assert "min" in pres.reps or "easy" in pres.reps.lower()
    _ok(f"recovery: 1×{pres.reps}")


# ─── Core programmer ───────────────────────────────────────────────────────

def test_weekly_core_target_known_goal():
    """Known goal×days returns correct CoreFrequency."""
    print("\n[test] core: weekly_core_target known goal")
    freq = weekly_core_target("fat_loss", 5)
    assert freq == CoreFrequency(2, 3, 3), f"got {freq}"
    freq2 = weekly_core_target("muscle_gain", 3)
    assert freq2 == CoreFrequency(1, 2, 2), f"got {freq2}"
    _ok("fat_loss 5d → (2,3,3), muscle_gain 3d → (1,2,2)")


def test_weekly_core_target_unknown_goal_fallback():
    """Unknown goal falls back to muscle_gain."""
    print("\n[test] core: unknown goal → muscle_gain fallback")
    freq = weekly_core_target("made_up_goal", 4)
    expected = weekly_core_target("muscle_gain", 4)
    assert freq == expected, f"got {freq}, expected {expected}"
    _ok("unknown goal uses muscle_gain fallback")


def test_day_type_for_archetype_push():
    """Push archetypes map to 'push' day type."""
    print("\n[test] core: push archetype → push day type")
    assert _day_type_for_archetype(DayArchetype.LIFT_PUSH) == "push"
    assert _day_type_for_archetype(DayArchetype.LIFT_PUSH_HEAVY) == "push"
    assert _day_type_for_archetype(DayArchetype.LIFT_PUSH_PLUS_CARDIO) == "push"
    _ok("LIFT_PUSH* → push day type")


def test_day_type_for_never_core_returns_none():
    """NEVER_CORE archetypes return None (skip core)."""
    print("\n[test] core: never-core archetypes → None")
    for a in _NEVER_CORE_ARCHETYPES:
        result = _day_type_for_archetype(a)
        assert result is None, f"{a} should return None, got {result}"
    _ok(f"all {len(_NEVER_CORE_ARCHETYPES)} never-core archetypes → None")


def test_duration_bucket_thresholds():
    """short=<=30, medium=31-60, long=61+."""
    print("\n[test] core: duration bucket thresholds")
    assert _duration_bucket(25) == "short"
    assert _duration_bucket(30) == "short"
    assert _duration_bucket(31) == "medium"
    assert _duration_bucket(45) == "medium"
    assert _duration_bucket(46) == "medium"
    assert _duration_bucket(60) == "medium"
    assert _duration_bucket(61) == "long"
    assert _duration_bucket(90) == "long"
    assert _duration_bucket(None) == "medium"  # default 60 → medium
    _ok("bucket: <=30→short, 31-60→medium, 61+→long")


def test_decide_core_skips_heavy_lower():
    """Heavy lower archetype → core skipped."""
    print("\n[test] core: decide skips heavy lower")
    decision = decide_core_for_day(
        archetype=DayArchetype.LIFT_LEGS_HEAVY,
        slots_count=5, session_minutes=60, goal="muscle_gain",
        recent_core_categories=[], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=3,
    )
    assert not decision.add, f"should skip, got add={decision.add}: {decision.reason}"
    _ok("heavy legs → core skipped")


def test_decide_core_skips_when_budget_exhausted():
    """Budget=0 → skip regardless of archetype."""
    print("\n[test] core: budget exhausted → skip")
    decision = decide_core_for_day(
        archetype=DayArchetype.LIFT_PUSH,
        slots_count=5, session_minutes=60, goal="muscle_gain",
        recent_core_categories=[], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=0,
    )
    assert not decision.add
    assert "budget" in decision.reason
    _ok("budget=0 → skip")


def test_decide_core_skips_short_session_non_metabolic():
    """Short session + non-metabolic goal → skip."""
    print("\n[test] core: short session + muscle_gain → skip")
    decision = decide_core_for_day(
        archetype=DayArchetype.LIFT_PUSH,
        slots_count=4, session_minutes=25, goal="muscle_gain",
        recent_core_categories=[], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=3,
    )
    assert not decision.add
    assert decision.reason == "time_cap"
    _ok("short session + non-metabolic → skip")


def test_decide_core_allows_short_session_fat_loss():
    """Short session + fat_loss → still adds core (metabolic goal)."""
    print("\n[test] core: short session + fat_loss → allows")
    decision = decide_core_for_day(
        archetype=DayArchetype.LIFT_PUSH,
        slots_count=4, session_minutes=25, goal="fat_loss",
        recent_core_categories=[], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=3,
    )
    assert decision.add, f"should allow, reason: {decision.reason}"
    _ok("short session + fat_loss → core allowed")


def test_decide_core_rotates_categories():
    """Recently-used categories are pushed to the back."""
    print("\n[test] core: category rotation avoids repeats")
    d1 = decide_core_for_day(
        archetype=DayArchetype.LIFT_PUSH,
        slots_count=5, session_minutes=60, goal="fat_loss",
        recent_core_categories=[], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=3,
    )
    assert d1.add and d1.category is not None
    cat1 = d1.category

    d2 = decide_core_for_day(
        archetype=DayArchetype.LIFT_PULL,
        slots_count=5, session_minutes=60, goal="fat_loss",
        recent_core_categories=[cat1], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=2,
    )
    assert d2.add and d2.category is not None
    assert d2.category != cat1, f"should rotate, got same: {cat1}"
    _ok(f"rotated: {cat1} → {d2.category}")


def test_decide_core_long_metabolic_uses_mixed_circuit():
    """Long metabolic sessions should get a mixed 3-move core circuit."""
    print("\n[test] core: long metabolic circuit uses mixed categories")
    decision = decide_core_for_day(
        archetype=DayArchetype.LIFT_PUSH,
        slots_count=5, session_minutes=75, goal="fat_loss",
        recent_core_categories=[], hip_flexor_recent=False,
        is_recovery_day=False, remaining_weekly_budget=3,
    )
    assert decision.add
    assert decision.count == 3, f"expected 3 core slots, got {decision.count}"
    assert len(decision.categories) == 3
    assert len(set(decision.categories)) == 3, decision.categories
    assert decision.categories.count(CAT_POSTERIOR_BRACING) <= 1
    _ok(f"mixed circuit categories: {decision.categories}")


def test_decide_core_does_not_repeat_recent_carry_when_alternatives_exist():
    """Carry/bracing should not appear in back-to-back core sessions
    when other category options can fill the circuit."""
    print("\n[test] core: recent carry is pushed behind alternatives")
    decision = decide_core_for_day(
        archetype=DayArchetype.LIFT_PULL,
        slots_count=5, session_minutes=75, goal="fat_loss",
        recent_core_categories=[
            CAT_ANTI_EXTENSION,
            CAT_FLEXION,
            CAT_POSTERIOR_BRACING,
        ],
        hip_flexor_recent=True,
        is_recovery_day=False, remaining_weekly_budget=3,
    )
    assert decision.add
    assert decision.count == 3
    assert CAT_POSTERIOR_BRACING not in decision.categories, decision.categories
    _ok(f"recent carry avoided: {decision.categories}")


def test_build_core_slot_uses_true_flexion_pattern():
    """Lower-ab slots should target trunk flexion, not generic isolation."""
    print("\n[test] core: lower-ab slot uses flexion pattern")
    slot = build_core_slot(CAT_FLEXION)
    assert slot.movement_pattern == "flexion", slot.movement_pattern
    _ok("Core — Lower Ab emits movement_pattern='flexion'")


def test_core_slot_accepts_only_true_anti_extension_exercises():
    """Anti-extension should reject back/posterior-chain lookalikes."""
    print("\n[test] core: anti-extension rejects non-core lookalikes")
    slot = build_core_slot(CAT_ANTI_EXTENSION)
    assert core_slot_accepts_exercise(slot, {
        "slug": "dead_bug",
        "name": "Dead Bug",
        "primary_muscle": "core",
        "movement_pattern": "anti_extension",
    })
    assert not core_slot_accepts_exercise(slot, {
        "slug": "superman_hold",
        "name": "Superman Hold",
        "primary_muscle": "back",
        "movement_pattern": "anti_extension",
    })
    assert not core_slot_accepts_exercise(slot, {
        "slug": "copenhagen_plank",
        "name": "Copenhagen Plank",
        "primary_muscle": "core",
        "movement_pattern": "anti_extension",
    })
    _ok("anti-extension accepts dead bug, rejects superman/Copenhagen")


def test_core_slot_accepts_lateral_only_side_plank_family():
    """Lateral stability should stay in the side-plank family."""
    print("\n[test] core: lateral stability stays side-plank family")
    slot = build_core_slot(CAT_LATERAL_STABILITY)
    assert core_slot_accepts_exercise(slot, {
        "slug": "side_plank",
        "name": "Side Plank",
        "primary_muscle": "core",
        "movement_pattern": "anti_extension",
    })
    assert core_slot_accepts_exercise(slot, {
        "slug": "copenhagen_plank",
        "name": "Copenhagen Plank",
        "primary_muscle": "core",
        "movement_pattern": "anti_extension",
    })
    assert core_slot_accepts_exercise(slot, {
        "slug": "side_plank_reach_through",
        "name": "Side Plank Reach-Through",
        "primary_muscle": "core",
        "movement_pattern": "anti_extension",
    })
    assert not core_slot_accepts_exercise(slot, {
        "slug": "dead_bug",
        "name": "Dead Bug",
        "primary_muscle": "core",
        "movement_pattern": "anti_extension",
    })
    assert core_slot_score_bonus(slot, {
        "slug": "side_plank",
        "name": "Side Plank",
    }) > core_slot_score_bonus(slot, {
        "slug": "copenhagen_plank",
        "name": "Copenhagen Plank",
    })
    _ok("lateral slot narrows to side plank / Copenhagen")


def test_core_slot_accepts_flexion_family_only():
    """Lower-ab slots should admit real flexion exercises."""
    print("\n[test] core: lower-ab slot accepts flexion family")
    slot = build_core_slot(CAT_FLEXION)
    assert core_slot_accepts_exercise(slot, {
        "slug": "reverse_crunch",
        "name": "Reverse Crunch",
        "primary_muscle": "core",
        "movement_pattern": "flexion",
    })
    assert core_slot_accepts_exercise(slot, {
        "slug": "captains_chair_leg_raise",
        "name": "Captain's Chair Leg Raise",
        "primary_muscle": "core",
        "movement_pattern": "flexion",
    })
    assert not core_slot_accepts_exercise(slot, {
        "slug": "cable_tricep_pushdown",
        "name": "Cable Tricep Pushdown",
        "primary_muscle": "triceps",
        "movement_pattern": "isolation",
    })
    _ok("lower-ab slot stays on core flexion exercises")


def test_bodyweight_floor_core_candidates_survive_planner_filter():
    """No-equipment floor core should be available in each core category."""
    print("\n[test] core: floor bodyweight candidates survive planner filter")
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import filter_candidates

    expected_by_category = {
        CAT_ANTI_EXTENSION: {"dead_bug_heel_tap", "long_lever_plank", "bear_plank_hold", "hollow_rocks"},
        CAT_ANTI_ROTATION: {"plank_reach"},
        CAT_LATERAL_STABILITY: {"side_plank_hip_dip", "side_plank_reach_through"},
        CAT_FLEXION: {
            "floor_crunch", "lying_leg_raise", "flutter_kicks", "scissor_kicks",
            "bicycle_crunch", "heel_taps", "toe_touch_crunch",
            "cross_body_crunch", "double_crunch", "bent_knee_leg_raise",
            "alternating_leg_lower", "mcgill_curl_up",
        },
    }
    for category, expected_slugs in expected_by_category.items():
        slot = build_core_slot(category)
        candidates = filter_candidates(
            SEED_EXERCISES,
            slot,
            {"bodyweight"},
            set(),
            day_focus_family="full_body",
        )
        slugs = {ex["slug"] for ex in candidates}
        missing = expected_slugs - slugs
        assert not missing, f"{category} missing floor candidates: {sorted(missing)}"
        for ex in candidates:
            if ex["slug"] in expected_slugs:
                assert ex["equipment_bucket"] == "bodyweight", ex
                assert ex.get("equipment") == [], ex
    _ok("floor core candidates cover anti-extension, anti-rotation, lateral, and flexion")


def test_program_core_across_week_budget_honored():
    """Core slots added across week <= default budget."""
    print("\n[test] core: program_core_across_week respects budget")
    from app.services.workout.slots import Slot as S
    templates = [
        ("Push", [S("A", "horizontal_press", "chest", "primary"),
                  S("B", "isolation", "triceps", "secondary")],
         DayArchetype.LIFT_PUSH, None),
        ("Pull", [S("A", "horizontal_pull", "back", "primary"),
                  S("B", "isolation", "biceps", "secondary")],
         DayArchetype.LIFT_PULL, None),
        ("Legs", [S("A", "squat", "quads", "primary"),
                  S("B", "hinge", "hamstrings", "secondary")],
         DayArchetype.LIFT_LEGS, None),  # NEVER_CORE — should be skipped
        ("Push2", [S("A", "horizontal_press", "chest", "primary"),
                   S("B", "isolation", "triceps", "secondary")],
         DayArchetype.LIFT_PUSH, None),
        ("Pull2", [S("A", "horizontal_pull", "back", "primary"),
                   S("B", "isolation", "biceps", "secondary")],
         DayArchetype.LIFT_PULL, None),
    ]
    result = program_core_across_week(
        templates=templates, goal="muscle_gain",
        days_per_week=5, session_minutes=60, seed=42,
    )
    freq = weekly_core_target("muscle_gain", 5)
    core_days = sum(1 for (_, slots, _, _) in result
                    if slots and any(s.role == "core" for s in slots))
    assert core_days <= freq.default, \
        f"core_days={core_days} > budget={freq.default}"
    # Legs day should NOT have core
    legs_entry = result[2]
    legs_slots = legs_entry[1]
    legs_core = [s for s in legs_slots if s.role == "core"]
    assert len(legs_core) == 0, "Legs day should not have core!"
    _ok(f"core added to {core_days} days (budget={freq.default}), legs skipped")


def test_program_core_across_week_does_not_duplicate_carry_slots():
    """A multi-exercise circuit should not duplicate carry/bracing slots."""
    print("\n[test] core: programmed circuit avoids duplicate carry slots")
    from app.services.workout.slots import Slot as S
    templates = [
        ("Push", [S("A", "horizontal_press", "chest", "primary"),
                  S("B", "isolation", "triceps", "secondary")],
         DayArchetype.LIFT_PUSH, None),
    ]
    result = program_core_across_week(
        templates=templates, goal="fat_loss",
        days_per_week=4, session_minutes=75, seed=42,
    )
    slots = result[0][1] or []
    core_labels = [s.label for s in slots if s.role == "core"]
    assert len(core_labels) == 3, core_labels
    assert len(set(core_labels)) == 3, core_labels
    assert sum(1 for label in core_labels if "Carry" in label) <= 1
    _ok(f"core labels: {core_labels}")


# ─── Main ──────────────────────────────────────────────────────────────────

cases = [
    # Density
    test_density_expands_when_budget_has_room,
    test_density_trims_warmup_first,
    test_density_never_drops_primary,
    test_density_drop_order_is_warmup_core_iso_secondary,
    test_density_cond_category_uses_different_costs,
    test_density_none_session_minutes_no_trim,
    # Prescriptions
    test_prescribe_warmup_always_light,
    test_prescribe_stimulus_strength_primary,
    test_prescribe_stimulus_hypertrophy_isolation,
    test_prescribe_stimulus_volume_primary,
    test_prescribe_conditioning_zone2_scales_to_session,
    test_prescribe_conditioning_cardio_baseline_caps_zone2,
    test_prescribe_conditioning_short_intervals_count_scales,
    test_prescribe_power_cardio_gets_sprints,
    test_prescribe_power_plyometric,
    test_prescribe_mobility_minimal_rest,
    test_prescribe_recovery_easy,
    # Core programmer
    test_weekly_core_target_known_goal,
    test_weekly_core_target_unknown_goal_fallback,
    test_day_type_for_archetype_push,
    test_day_type_for_never_core_returns_none,
    test_duration_bucket_thresholds,
    test_decide_core_skips_heavy_lower,
    test_decide_core_skips_when_budget_exhausted,
    test_decide_core_skips_short_session_non_metabolic,
    test_decide_core_allows_short_session_fat_loss,
    test_decide_core_rotates_categories,
    test_decide_core_long_metabolic_uses_mixed_circuit,
    test_decide_core_does_not_repeat_recent_carry_when_alternatives_exist,
    test_build_core_slot_uses_true_flexion_pattern,
    test_core_slot_accepts_only_true_anti_extension_exercises,
    test_core_slot_accepts_lateral_only_side_plank_family,
    test_core_slot_accepts_flexion_family_only,
    test_bodyweight_floor_core_candidates_survive_planner_filter,
    test_program_core_across_week_budget_honored,
    test_program_core_across_week_does_not_duplicate_carry_slots,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Density + Prescription + Core programmer tests")
    print("=" * 60)
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
    print()
    print("=" * 60)
    print(f"  {len(cases) - failures}/{len(cases)} passed")
    print("=" * 60)
    raise SystemExit(0 if failures == 0 else 1)
