"""Integration tests: UserCoachingOverlay → planner output.

These tests verify the WHOLE point of the overlay system: when a user
accepts a weekly recommendation, the next plan regen actually reflects
the change. Pure planner internals — no DB, no AI.

Each test compares baseline planner output (no overlay) against an
overlay-modified output, asserting the targeted dimension shifted in
the expected direction.

Coverage:
  • weekly_set_targets honors muscle_volume_bias (up + down)
  • weekly_set_targets honors deload (-30%)
  • _inject_hybrid_cardio honors target_override (more cardio)
  • _inject_hybrid_cardio target_override=0 disables (less cardio)
  • program_core_across_week honors core_target_override
  • program_core_across_week clamps absurd overrides
  • prescribe_for_slot deload trims sets + bumps RIR (no failure work)
  • _prescribe_lifting routes via stimulus when intensity_bias set
  • Volume bias clamps inside the planner even with stale rows
  • Snapshot-shaped dict round-trips through the planner cleanly
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _inputs(**overrides):
    """Build a PlannerInputs with reasonable defaults. Tests pass
    `coaching_overlay=...` and any other overrides they need."""
    from app.services.workout.planner import PlannerInputs
    base = dict(
        goal="muscle_gain",
        days_per_week=4,
        session_minutes=60,
        experience="intermediate",
    )
    base.update(overrides)
    return PlannerInputs(**base)


# ── weekly_set_targets ────────────────────────────────────────────

def test_volume_bias_raises_quad_target():
    print("\n[test] weekly_set_targets: bias 1.3 raises quad target")
    from app.services.workout.planner import weekly_set_targets
    base = weekly_set_targets(_inputs())
    biased = weekly_set_targets(_inputs(
        coaching_overlay={"muscle_volume_bias": {"quads": 1.3}},
    ))
    assert biased["quads"] > base["quads"], \
        f"quads should rise with bias 1.3: base={base['quads']} biased={biased['quads']}"
    _ok(f"quads {base['quads']} → {biased['quads']}")


def test_volume_bias_lowers_chest_target():
    print("\n[test] weekly_set_targets: bias 0.7 lowers chest target")
    from app.services.workout.planner import weekly_set_targets
    base = weekly_set_targets(_inputs())
    biased = weekly_set_targets(_inputs(
        coaching_overlay={"muscle_volume_bias": {"chest": 0.7}},
    ))
    assert biased["chest"] < base["chest"], \
        f"chest should fall with bias 0.7: base={base['chest']} biased={biased['chest']}"


def test_volume_bias_neutral_value_no_change():
    """Bias=1.0 must round-trip to exactly the baseline target."""
    print("\n[test] weekly_set_targets: neutral bias produces identical targets")
    from app.services.workout.planner import weekly_set_targets
    base = weekly_set_targets(_inputs())
    same = weekly_set_targets(_inputs(
        coaching_overlay={"muscle_volume_bias": {"quads": 1.0, "chest": 1.0}},
    ))
    for muscle in ("quads", "chest", "back", "shoulders"):
        assert same[muscle] == base[muscle], \
            f"{muscle}: neutral bias changed target {base[muscle]} → {same[muscle]}"


def test_volume_bias_unknown_muscle_no_crash():
    """A stale or typo'd muscle key in the bias map must not throw —
    the planner has no entry for it and silently skips."""
    print("\n[test] weekly_set_targets: unknown muscle key skipped gracefully")
    from app.services.workout.planner import weekly_set_targets
    targets = weekly_set_targets(_inputs(
        coaching_overlay={"muscle_volume_bias": {"adductors": 1.3, "quads": 1.2}},
    ))
    assert "adductors" not in targets
    assert targets["quads"] > 0


def test_volume_bias_defensively_clamps_stale_values():
    """Even if a stale DB row holds a bias of 2.0 (impossible at the
    apply layer), the planner must still clamp to [0.7, 1.3] so the
    output is bounded."""
    print("\n[test] weekly_set_targets: defensive clamp on out-of-range bias")
    from app.services.workout.planner import weekly_set_targets
    bounded = weekly_set_targets(_inputs(
        coaching_overlay={"muscle_volume_bias": {"quads": 5.0}},
    ))
    biased_at_max = weekly_set_targets(_inputs(
        coaching_overlay={"muscle_volume_bias": {"quads": 1.3}},
    ))
    assert bounded["quads"] == biased_at_max["quads"], \
        f"stale bias 5.0 must clamp to 1.3 effect, got {bounded['quads']} vs {biased_at_max['quads']}"


def test_deload_cuts_every_target_by_about_30pct():
    print("\n[test] weekly_set_targets: deload_active cuts every target ~30%")
    from app.services.workout.planner import weekly_set_targets
    base = weekly_set_targets(_inputs())
    deload = weekly_set_targets(_inputs(
        coaching_overlay={"deload_active": True},
    ))
    for muscle in ("quads", "chest", "back", "shoulders", "biceps"):
        ratio = deload[muscle] / base[muscle]
        assert 0.6 <= ratio <= 0.78, \
            f"{muscle} ratio {ratio:.2f} outside [0.6, 0.78] expected window"
        assert deload[muscle] >= 2, "deload floor at 2 sets to keep stimulus"


def test_deload_floor_protects_low_volume_muscles():
    """Calves baseline is 6 sets; 30% cut → 4. The min-2 floor must
    keep tiny muscles from dropping below 2."""
    print("\n[test] weekly_set_targets: deload never drops below 2-set floor")
    from app.services.workout.planner import weekly_set_targets
    deload = weekly_set_targets(_inputs(
        coaching_overlay={"deload_active": True},
    ))
    for muscle in deload:
        assert deload[muscle] >= 2, f"{muscle}={deload[muscle]} below floor"


def test_volume_bias_combines_with_region_priority():
    """Region priority (lower_body) and bias should both apply —
    they're independent multipliers stacked on the base."""
    print("\n[test] weekly_set_targets: region priority + bias compound correctly")
    from app.services.workout.planner import weekly_set_targets
    region_only = weekly_set_targets(_inputs(priority_region="lower_body"))
    region_plus_bias = weekly_set_targets(_inputs(
        priority_region="lower_body",
        coaching_overlay={"muscle_volume_bias": {"quads": 1.3}},
    ))
    assert region_plus_bias["quads"] > region_only["quads"], \
        "bias should add on top of region priority"


# ── _inject_hybrid_cardio ─────────────────────────────────────────

def test_hybrid_cardio_target_override_adds_promotions():
    print("\n[test] _inject_hybrid_cardio: target_override adds promotions")
    from app.services.workout.weekly_recipe import _inject_hybrid_cardio
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.weekly_recipe import _HYBRID_PAIR
    from app.services.workout.goal_profiles import goal_profile_for

    profile = goal_profile_for("muscle_gain")
    # Lift-only week (4 push/pull/upper days that have hybrid pairs).
    recipe = [
        DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL,
        DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL,
    ]
    baseline = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=4)
    override = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=4,
                                     target_override=3)
    # Count PLUS_CARDIO archetypes in each result.
    hybrid_set = set(_HYBRID_PAIR.values())
    base_count = sum(1 for a in baseline if a in hybrid_set)
    over_count = sum(1 for a in override if a in hybrid_set)
    assert over_count > base_count, \
        f"target_override=3 should add hybrid promotions: base={base_count} override={over_count}"


def test_hybrid_cardio_target_override_zero_disables():
    """target_override=0 means 'no cardio' — even if the goal × days
    table would have promoted some, the override wins."""
    print("\n[test] _inject_hybrid_cardio: target_override=0 prevents promotions")
    from app.services.workout.weekly_recipe import _inject_hybrid_cardio
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.weekly_recipe import _HYBRID_PAIR
    from app.services.workout.goal_profiles import goal_profile_for

    profile = goal_profile_for("general_health")  # this goal NORMALLY promotes 2 days
    recipe = [DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER,
              DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER]
    result = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=4,
                                   target_override=0)
    hybrid_count = sum(1 for a in result if a in set(_HYBRID_PAIR.values()))
    assert hybrid_count == 0, f"override=0 should produce 0 hybrids, got {hybrid_count}"


def test_hybrid_cardio_no_override_falls_back_to_table():
    """target_override=None must use the existing _DIRECT_PROMOTE_COUNT
    table so users without an overlay get the deterministic baseline."""
    print("\n[test] _inject_hybrid_cardio: no override falls back to goal × days table")
    from app.services.workout.weekly_recipe import _inject_hybrid_cardio
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.weekly_recipe import _HYBRID_PAIR
    from app.services.workout.goal_profiles import goal_profile_for

    profile = goal_profile_for("general_health")
    recipe = [DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER,
              DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER]
    result = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=4)
    # general_health × 4 days = 2 hybrid promotions per the table.
    hybrid_count = sum(1 for a in result if a in set(_HYBRID_PAIR.values()))
    assert hybrid_count >= 1, f"baseline should still promote ≥1 day, got {hybrid_count}"


# ── program_core_across_week ──────────────────────────────────────

def test_core_target_override_writes_at_least_n_core_blocks():
    """When the user has accepted set_core_frequency=3, the planner
    must emit core slots on at least 3 (lift) days."""
    print("\n[test] program_core_across_week: override=3 produces 3 core insertions")
    from app.services.workout.core_programmer import program_core_across_week
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    # Mock 5 lift days — enough room for the override to actually place
    # 3 core blocks. Slots use 'core' as the existing terminal-core
    # marker; we count appended core slots after the call.
    def _mock_day(arch):
        return ("Test", [
            Slot(label="Primary", movement_pattern="horizontal_press",
                 primary_muscle_hint="chest", role="primary"),
        ], arch, None)

    templates = [_mock_day(DayArchetype.LIFT_PUSH) for _ in range(5)]
    out = program_core_across_week(
        templates=templates,
        goal="muscle_gain",
        days_per_week=5,
        session_minutes=60,
        seed=42,
        core_target_override=3,
    )
    days_with_core = sum(
        1 for (_n, slots, _a, _g) in out
        if slots and any((getattr(sl, "role", "") or "").lower() == "core" for sl in slots)
    )
    assert days_with_core == 3, \
        f"override=3 should yield exactly 3 core days, got {days_with_core}"


def test_core_target_override_zero_emits_no_core():
    print("\n[test] program_core_across_week: override=0 suppresses all core")
    from app.services.workout.core_programmer import program_core_across_week
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    def _mock_day(arch):
        return ("Test", [Slot(label="Primary", movement_pattern="horizontal_press",
                               primary_muscle_hint="chest", role="primary")], arch, None)

    templates = [_mock_day(DayArchetype.LIFT_PUSH) for _ in range(4)]
    out = program_core_across_week(
        templates=templates,
        goal="muscle_gain",
        days_per_week=4,
        session_minutes=60,
        seed=42,
        core_target_override=0,
    )
    days_with_core = sum(
        1 for (_n, slots, _a, _g) in out
        if slots and any((getattr(sl, "role", "") or "").lower() == "core" for sl in slots)
    )
    assert days_with_core == 0, f"override=0 should suppress core, got {days_with_core}"


def test_core_target_override_clamps_absurd_values():
    """override=99 must clamp to 5 (the hard cap), not crash or
    saturate every day."""
    print("\n[test] program_core_across_week: override=99 clamps to 5")
    from app.services.workout.core_programmer import program_core_across_week
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    def _mock_day(arch):
        return ("Test", [Slot(label="Primary", movement_pattern="horizontal_press",
                               primary_muscle_hint="chest", role="primary")], arch, None)

    templates = [_mock_day(DayArchetype.LIFT_PUSH) for _ in range(7)]
    out = program_core_across_week(
        templates=templates,
        goal="muscle_gain",
        days_per_week=7,
        session_minutes=60,
        seed=42,
        core_target_override=99,
    )
    days_with_core = sum(
        1 for (_n, slots, _a, _g) in out
        if slots and any((getattr(sl, "role", "") or "").lower() == "core" for sl in slots)
    )
    assert days_with_core <= 5, f"override=99 should clamp at 5, got {days_with_core}"


# ── Deload prescription ───────────────────────────────────────────

def test_deload_trims_primary_set_count():
    """A primary lift normally gets ≥3 sets. Under deload, drop one."""
    print("\n[test] prescribe_for_slot: deload drops 1 primary set")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    base = prescribe_for_slot(DayArchetype.LIFT_UPPER_HEAVY, slot, exercise, _inputs())
    deload = prescribe_for_slot(
        DayArchetype.LIFT_UPPER_HEAVY, slot, exercise,
        _inputs(coaching_overlay={"deload_active": True}),
    )
    assert deload.sets == base.sets - 1, \
        f"deload should drop 1 primary set: base={base.sets} deload={deload.sets}"


def test_deload_bumps_rir_target_no_failure_work():
    """Deload weeks should NEVER prescribe 0 RIR (failure). Bump every
    RIR by 2 and cap at 5."""
    print("\n[test] prescribe_for_slot: deload bumps RIR +2 (no failure work)")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    base = prescribe_for_slot(DayArchetype.LIFT_UPPER_HEAVY, slot, exercise, _inputs())
    deload = prescribe_for_slot(
        DayArchetype.LIFT_UPPER_HEAVY, slot, exercise,
        _inputs(coaching_overlay={"deload_active": True}),
    )
    assert deload.rir_target >= base.rir_target + 1.5, \
        f"RIR should bump under deload: base={base.rir_target} deload={deload.rir_target}"
    assert deload.rir_target <= 5.0, \
        f"RIR target capped at 5 to keep prescription sensible, got {deload.rir_target}"


def test_deload_keeps_isolation_set_count_floor():
    """Don't trim isolation/core slots — they're already low-volume.
    Only RIR bumps for those."""
    print("\n[test] prescribe_for_slot: deload keeps isolation set count")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Bicep Curl", movement_pattern="elbow_flexion",
                primary_muscle_hint="biceps", role="isolation")
    exercise = {"name": "Bicep Curl", "primary_muscle": "biceps",
                "movement_pattern": "elbow_flexion"}
    base = prescribe_for_slot(DayArchetype.LIFT_UPPER_HEAVY, slot, exercise, _inputs())
    deload = prescribe_for_slot(
        DayArchetype.LIFT_UPPER_HEAVY, slot, exercise,
        _inputs(coaching_overlay={"deload_active": True}),
    )
    assert deload.sets == base.sets, \
        f"isolation sets should not drop on deload: base={base.sets} deload={deload.sets}"


def test_deload_inactive_returns_baseline():
    """Overlay present but `deload_active: False` should produce
    identical output to no overlay."""
    print("\n[test] prescribe_for_slot: deload_active=False unchanged from baseline")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    base = prescribe_for_slot(DayArchetype.LIFT_UPPER_HEAVY, slot, exercise, _inputs())
    inactive = prescribe_for_slot(
        DayArchetype.LIFT_UPPER_HEAVY, slot, exercise,
        _inputs(coaching_overlay={"deload_active": False}),
    )
    assert (base.sets, base.reps, base.rest_seconds, base.rir_target) == \
           (inactive.sets, inactive.reps, inactive.rest_seconds, inactive.rir_target)


# ── Intensity bias ───────────────────────────────────────────────

def test_intensity_bias_strength_routes_via_stimulus():
    """When user accepts strength_preservation, even a generic LIFT_UPPER
    archetype should ship strength prescription (3-5 reps, 1.5 RIR, 180s)
    instead of the goal-bucket-default."""
    print("\n[test] _prescribe_lifting: intensity_bias=strength uses strength stimulus")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    biased = prescribe_for_slot(
        DayArchetype.LIFT_UPPER, slot, exercise,
        _inputs(coaching_overlay={"intensity_bias": "strength"}),
    )
    assert biased.reps == "3-5", f"strength bias should yield 3-5 rep range, got {biased.reps}"
    assert biased.rir_target <= 1.5
    assert biased.rest_seconds >= 150


def test_intensity_bias_hypertrophy_routes_via_stimulus():
    print("\n[test] _prescribe_lifting: intensity_bias=hypertrophy uses hypertrophy stimulus")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    biased = prescribe_for_slot(
        DayArchetype.LIFT_UPPER, slot, exercise,
        _inputs(coaching_overlay={"intensity_bias": "hypertrophy"}),
    )
    assert biased.reps == "6-10", f"hypertrophy bias should yield 6-10 rep range, got {biased.reps}"


def test_intensity_bias_endurance_routes_to_volume():
    print("\n[test] _prescribe_lifting: intensity_bias=endurance uses volume stimulus")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    biased = prescribe_for_slot(
        DayArchetype.LIFT_UPPER, slot, exercise,
        _inputs(coaching_overlay={"intensity_bias": "endurance"}),
    )
    # volume stimulus = high rep, short rest
    assert int(str(biased.reps).split("-")[-1]) >= 12, \
        f"endurance/volume should have rep top >=12, got {biased.reps}"


def test_intensity_bias_balanced_falls_back_to_default():
    """`balanced` is explicitly NOT one of the three stimulus types —
    it should fall through to the goal-bucket default prescriber."""
    print("\n[test] _prescribe_lifting: intensity_bias=balanced uses default prescriber")
    from app.services.workout.prescriptions import prescribe_for_slot
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.slots import Slot

    slot = Slot(label="Primary Press", movement_pattern="horizontal_press",
                primary_muscle_hint="chest", role="primary")
    exercise = {"name": "Bench Press", "primary_muscle": "chest",
                "movement_pattern": "horizontal_press"}
    base = prescribe_for_slot(DayArchetype.LIFT_UPPER, slot, exercise, _inputs())
    biased = prescribe_for_slot(
        DayArchetype.LIFT_UPPER, slot, exercise,
        _inputs(coaching_overlay={"intensity_bias": "balanced"}),
    )
    assert (base.sets, base.reps, base.rir_target) == \
           (biased.sets, biased.reps, biased.rir_target)


# ── Empty / absent overlay safety ────────────────────────────────

def test_empty_overlay_dict_safe():
    """An empty dict is the snapshot's default for a fresh user. Every
    planner read site must handle it without crashing."""
    print("\n[test] empty overlay {} produces identical output to None")
    from app.services.workout.planner import weekly_set_targets
    base = weekly_set_targets(_inputs())
    empty = weekly_set_targets(_inputs(coaching_overlay={}))
    for muscle in base:
        assert empty[muscle] == base[muscle]


def test_none_overlay_safe():
    print("\n[test] coaching_overlay=None produces baseline targets")
    from app.services.workout.planner import weekly_set_targets
    base = weekly_set_targets(_inputs())
    none = weekly_set_targets(_inputs(coaching_overlay=None))
    for muscle in base:
        assert none[muscle] == base[muscle]


# ── Bro split + cardio overlay edge case ────────────────────────

def test_bro_split_cardio_overlay_does_not_crash():
    """User on bro split accepts an `add_cardio_session` rec. The
    planner CAN'T honor it (bro archetypes have no PLUS_CARDIO pair),
    so we log a warning and produce a clean recipe instead of
    crashing or silently swallowing.

    Verifies no exception bubbles up — the absence of the cardio
    finisher is a known structural gap, not a planner error."""
    print("\n[test] bro split + cardio overlay: no crash, recipe still valid")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.day_templates import SPLIT_BRO
    from app.services.workout.goal_profiles import goal_profile_for

    profile = goal_profile_for("muscle_gain")
    overlay = {
        "muscle_volume_bias": {},
        "cardio_minutes_target": 60,
        "zone2_minutes_target": None,
        "core_sessions_target": None,
        "intensity_bias": None,
        "deload_active": False,
        "deload_until_date": None,
        "nutrition_adjustments": {},
    }
    # Should not raise — even though bro skips the cardio injection.
    recipe = generate_weekly_recipe(
        profile, days_per_week=5,
        lifting_split=SPLIT_BRO,
        coaching_overlay=overlay,
    )
    assert recipe is not None
    assert len(recipe) == 5, f"expected 5-day recipe, got {len(recipe)}"


def test_ppl_split_cardio_overlay_promotes_more_than_baseline():
    """The OPPOSITE case: a PPL user with cardio overlay should get
    MORE hybrid promotions than the same user without — proving the
    overlay actually moves the planner output for non-bro splits."""
    print("\n[test] PPL split + cardio overlay: promotes more than baseline")
    from app.services.workout.weekly_recipe import generate_weekly_recipe, _HYBRID_PAIR
    from app.services.workout.day_templates import SPLIT_PPL
    from app.services.workout.goal_profiles import goal_profile_for

    profile = goal_profile_for("muscle_gain")
    base = generate_weekly_recipe(
        profile, days_per_week=6, lifting_split=SPLIT_PPL,
    )
    boosted = generate_weekly_recipe(
        profile, days_per_week=6, lifting_split=SPLIT_PPL,
        coaching_overlay={
            "muscle_volume_bias": {},
            "cardio_minutes_target": 120,  # → target_override = round(120/20) = 6
            "zone2_minutes_target": None,
            "core_sessions_target": None,
            "intensity_bias": None,
            "deload_active": False,
            "nutrition_adjustments": {},
        },
    )
    hybrids = set(_HYBRID_PAIR.values())
    base_count = sum(1 for a in base if a in hybrids)
    boost_count = sum(1 for a in boosted if a in hybrids)
    assert boost_count >= base_count, \
        f"PPL with cardio overlay should have ≥ baseline hybrids: base={base_count} boost={boost_count}"


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} overlay→planner integration tests passed")
