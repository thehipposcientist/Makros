"""Tests for capability-aware cardio prescriptions.

Covers:
  - Incline walk → duration + speed range + incline + zone (NOT strength-style reps)
  - IC6 bike (watts+rpm caps) → watts/RPM prescription
  - Basic bike (resistance only) → resistance/RPE prescription
  - No-display bike (time only) → conversational-pace + RPE fallback
  - Cardio steady vs interval → different prescription_types
  - Yoga → yoga_flow prescription_type, NOT generic stretching
  - Core slots → core_circuit prescription_type with rounds/hold structure
"""
from __future__ import annotations

import sys
import traceback


# ─── helpers ──────────────────────────────────────────────────────────────────

def _make_exercise(name: str, ex_type: str = "cardio", mp: str = "cardio",
                   is_compound: bool = False, cardio_modality: str | None = None) -> dict:
    ex = {"name": name, "exercise_type": ex_type, "movement_pattern": mp,
          "is_compound": is_compound, "default_tracking_mode": "time"}
    if cardio_modality:
        ex["cardio_modality"] = cardio_modality
    return ex


def _make_mobility_ex(name: str) -> dict:
    return {"name": name, "exercise_type": "mobility", "movement_pattern": "mobility",
            "is_compound": False, "default_tracking_mode": "time"}


class FakeSlot:
    def __init__(self, role: str = "primary", label: str = ""):
        self.role  = role
        self.label = label


class FakeInputs:
    def __init__(self, session_minutes: int = 45, user_age: int | None = None,
                 resting_hr: int | None = None,
                 user_equipment_capabilities: dict | None = None):
        self.session_minutes             = session_minutes
        self.user_age                    = user_age
        self.resting_hr                  = resting_hr
        self.user_equipment_capabilities = user_equipment_capabilities or {}


# ─── cardio guidance builder ──────────────────────────────────────────────────

def test_incline_walk_guidance_no_caps():
    """Incline Walk with no capability data → speed_range + incline_range (treadmill walk branch)."""
    from app.services.workout.cardio import build_cardio_guidance, MODALITY_TREADMILL
    ex = _make_exercise("Incline Walk", cardio_modality="treadmill")
    g  = build_cardio_guidance(ex, session_minutes=40, capabilities=[])
    assert g["modality"] == MODALITY_TREADMILL
    assert "speed_range"   in g, "Incline walk must include speed range"
    assert "incline_range" in g, "Incline walk must include incline range"
    assert g.get("is_intervals") is False
    print("  ✓ incline_walk: speed_range + incline_range present without caps")


def test_incline_walk_prescription_text():
    """render_cardio_prescription_text for incline walk mentions incline and speed, not reps."""
    from app.services.workout.cardio import build_cardio_guidance, render_cardio_prescription_text
    ex   = _make_exercise("Incline Walk", cardio_modality="treadmill")
    g    = build_cardio_guidance(ex, session_minutes=40, capabilities=[])
    text = render_cardio_prescription_text(g, "Incline Walk")
    assert "incline" in text.lower(),     f"Expected 'incline' in '{text}'"
    assert "rpm" not in text.lower(),     f"Got RPM in incline walk prescription"
    assert "reps" not in text.lower(),    f"Got 'reps' in incline walk prescription"
    print(f"  ✓ incline_walk render: '{text}'")


def test_ic6_bike_guidance_watts_rpm():
    """Bike with [watts, rpm, heart_rate] caps → watts_range + rpm_range."""
    from app.services.workout.cardio import (
        build_cardio_guidance, render_cardio_prescription_text, MODALITY_BIKE,
        CAP_WATTS, CAP_RPM, CAP_HEART_RATE,
    )
    ex   = _make_exercise("Stationary Bike", cardio_modality="bike")
    caps = [CAP_WATTS, CAP_RPM, CAP_HEART_RATE]
    g    = build_cardio_guidance(ex, session_minutes=45, capabilities=caps)
    assert g["modality"] == MODALITY_BIKE
    assert "watts_range" in g,            "IC6 must get watts_range"
    assert "rpm_range"   in g,            "IC6 must get rpm_range"
    assert "resistance_cue" not in g,     "IC6 should not fall back to resistance_cue"
    text = render_cardio_prescription_text(g, "Stationary Bike")
    assert "W" in text or "watts" in text.lower(), f"Watts not in '{text}'"
    assert "RPM" in text,                 f"RPM not in '{text}'"
    print(f"  ✓ IC6 bike render: '{text}'")


def test_basic_bike_resistance_no_watts():
    """Bike with [resistance, rpm] caps but no watts → resistance_cue, no watts."""
    from app.services.workout.cardio import (
        build_cardio_guidance, render_cardio_prescription_text,
        CAP_RESISTANCE, CAP_RPM,
    )
    ex   = _make_exercise("Stationary Bike", cardio_modality="bike")
    caps = [CAP_RESISTANCE, CAP_RPM]
    g    = build_cardio_guidance(ex, session_minutes=40, capabilities=caps)
    assert "resistance_cue" in g,         "Basic bike must get resistance_cue"
    assert "watts_range"    not in g,     "Basic bike must not get watts_range"
    assert "rpm_range"      in g,         "Basic bike should still get rpm_range"
    text = render_cardio_prescription_text(g, "Stationary Bike")
    assert "resistance" in text.lower(),  f"Expected 'resistance' in '{text}'"
    print(f"  ✓ basic bike render: '{text}'")


def test_no_display_bike_rpe_only():
    """Bike with [time] only (no watts/resistance/rpm) → conversational pace + RPE."""
    from app.services.workout.cardio import (
        build_cardio_guidance, render_cardio_prescription_text, CAP_TIME,
    )
    ex   = _make_exercise("Stationary Bike", cardio_modality="bike")
    caps = [CAP_TIME]
    g    = build_cardio_guidance(ex, session_minutes=40, capabilities=caps)
    assert "intensity_cue" in g,          "No-display bike must get intensity_cue"
    assert "watts_range"   not in g,      "No-display bike must not get watts_range"
    assert "resistance_cue" not in g,     "No-display bike must not get resistance_cue"
    text = render_cardio_prescription_text(g, "Stationary Bike")
    assert "RPE" in text or "pace" in text.lower(), f"Expected RPE or pace cue in '{text}'"
    print(f"  ✓ no-display bike render: '{text}'")


def test_rower_with_pace_caps():
    """Rower with [pace, stroke_rate] caps → pace_per_500m + stroke_rate."""
    from app.services.workout.cardio import (
        build_cardio_guidance, render_cardio_prescription_text,
        CAP_PACE, CAP_STROKE_RATE, MODALITY_ROWER,
    )
    ex   = _make_exercise("Rowing Machine", cardio_modality="rower")
    caps = [CAP_PACE, CAP_STROKE_RATE]
    g    = build_cardio_guidance(ex, session_minutes=40, capabilities=caps)
    assert g["modality"] == MODALITY_ROWER
    assert "pace_per_500m" in g
    assert "stroke_rate"   in g
    text = render_cardio_prescription_text(g, "Rowing Machine")
    assert "/500m" in text,               f"Expected /500m in '{text}'"
    print(f"  ✓ rower with pace caps: '{text}'")


def test_rower_no_caps():
    """Rower with no caps → intensity_cue + RPE fallback."""
    from app.services.workout.cardio import build_cardio_guidance, render_cardio_prescription_text
    ex   = _make_exercise("Rowing Machine", cardio_modality="rower")
    g    = build_cardio_guidance(ex, session_minutes=40, capabilities=[])
    assert "intensity_cue" in g
    text = render_cardio_prescription_text(g, "Rowing Machine")
    assert "RPE" in text or "pull" in text.lower(), f"Expected fallback cue in '{text}'"
    print(f"  ✓ rower fallback (no caps): '{text}'")


# ─── prescription_type tagging ────────────────────────────────────────────────

def test_cardio_steady_prescription_type():
    """Zone2 archetype → prescription_type='cardio_steady'."""
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.prescriptions import prescribe_for_slot
    ex   = _make_exercise("Stationary Bike", cardio_modality="bike")
    slot = FakeSlot(role="primary", label="Zone 2")
    p    = prescribe_for_slot(DayArchetype.COND_ZONE2, slot, ex, FakeInputs())
    assert p.prescription_type == "cardio_steady", f"Got '{p.prescription_type}'"
    assert p.cardio_guidance is not None,          "cardio_guidance should be present"
    print(f"  ✓ Zone2 → prescription_type=cardio_steady, reps='{p.reps}'")


def test_bike_zone2_prescription_uses_bike_capabilities():
    """Bike Zone 2 must use stationary-bike guidance, not generic cardio text."""
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.cardio import CAP_RESISTANCE, CAP_RPM, MODALITY_BIKE
    from app.services.workout.prescriptions import prescribe_for_slot
    ex   = _make_exercise("Bike Zone 2", cardio_modality="bike")
    slot = FakeSlot(role="primary", label="Zone 2")
    p    = prescribe_for_slot(
        DayArchetype.COND_ZONE2,
        slot,
        ex,
        FakeInputs(
            session_minutes=45,
            user_equipment_capabilities={MODALITY_BIKE: [CAP_RESISTANCE, CAP_RPM]},
        ),
    )
    assert p.cardio_guidance is not None, "cardio_guidance should be present"
    assert p.cardio_guidance.get("modality") == MODALITY_BIKE
    assert "resistance" in p.reps.lower(), f"expected bike resistance cue in '{p.reps}'"
    assert "RPM" in p.reps, f"expected bike RPM cue in '{p.reps}'"
    print(f"  ✓ Bike Zone 2 uses bike caps: reps='{p.reps}'")


def test_cardio_intervals_prescription_type():
    """Short intervals archetype → prescription_type='cardio_intervals'."""
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.prescriptions import prescribe_for_slot
    ex   = _make_exercise("Stationary Bike Intervals", is_compound=True, cardio_modality="bike")
    slot = FakeSlot(role="primary", label="Intervals")
    p    = prescribe_for_slot(DayArchetype.COND_INTERVALS_SHORT, slot, ex, FakeInputs())
    assert p.prescription_type == "cardio_intervals", f"Got '{p.prescription_type}'"
    print(f"  ✓ COND_INTERVALS_SHORT → prescription_type=cardio_intervals")


def test_incline_walk_not_strength_type():
    """Incline Walk on a Zone2 archetype must NOT get prescription_type='strength'."""
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.prescriptions import prescribe_for_slot
    ex   = _make_exercise("Incline Walk", cardio_modality="treadmill")
    slot = FakeSlot(role="primary")
    p    = prescribe_for_slot(DayArchetype.COND_ZONE2, slot, ex, FakeInputs(session_minutes=40))
    assert p.prescription_type != "strength",      f"Incline Walk must not be 'strength'"
    assert "reps" not in p.reps.lower(),            f"Got raw reps in incline walk: '{p.reps}'"
    # Must mention some form of duration/distance
    assert "min" in p.reps.lower() or "incline" in p.reps.lower(), \
        f"Incline walk prescription must mention duration or incline: '{p.reps}'"
    print(f"  ✓ incline_walk not strength: prescription_type={p.prescription_type}, reps='{p.reps}'")


# ─── yoga prescription ────────────────────────────────────────────────────────

def test_yoga_prescription_type():
    """Yoga exercises get prescription_type='yoga_flow', NOT strength or mobility."""
    from app.services.workout.prescriptions import _prescribe_mobility
    ex   = _make_mobility_ex("Yoga Flow")
    slot = FakeSlot(role="primary", label="Yoga Flow")
    p    = _prescribe_mobility(slot, ex)
    assert p.prescription_type == "yoga_flow",    f"Got '{p.prescription_type}'"
    assert "min" in p.reps,                        f"Yoga must be duration-based: '{p.reps}'"
    assert "hold" not in p.reps.lower(),           f"Yoga should not say 'hold': '{p.reps}'"
    print(f"  ✓ yoga_flow prescription_type, reps='{p.reps}'")


def test_stretch_prescription_type():
    """Static stretch blocks get prescription_type='stretch_hold'."""
    from app.services.workout.prescriptions import _prescribe_mobility
    ex   = _make_mobility_ex("Hip Flexor Stretch")
    slot = FakeSlot(role="primary", label="Stretch Block")
    p    = _prescribe_mobility(slot, ex)
    assert p.prescription_type == "stretch_hold",  f"Got '{p.prescription_type}'"
    assert "hold" in p.reps.lower(),               f"Stretch must mention hold: '{p.reps}'"
    print(f"  ✓ stretch_hold prescription_type, reps='{p.reps}'")


def test_yoga_not_treated_as_generic_mobility():
    """Yoga exercise name detected regardless of slot label."""
    from app.services.workout.prescriptions import _prescribe_mobility
    ex   = _make_mobility_ex("Vinyasa Flow")
    slot = FakeSlot(role="primary", label="Mobility Flow")
    p    = _prescribe_mobility(slot, ex)
    # Vinyasa keyword should trigger yoga_flow
    assert p.prescription_type == "yoga_flow",    f"Vinyasa must be yoga_flow, got '{p.prescription_type}'"
    print("  ✓ vinyasa flow → yoga_flow via exercise name")


# ─── core circuit prescription ────────────────────────────────────────────────

def test_core_slot_prescription_type():
    """Core-role slots always get prescription_type='core_circuit'."""
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.prescriptions import prescribe_for_slot
    ex   = {"name": "Dead Bug", "exercise_type": "strength", "movement_pattern": "anti_extension",
            "default_tracking_mode": "time", "is_compound": False}
    slot = FakeSlot(role="core", label="Core — Anti-Extension")
    p    = prescribe_for_slot(DayArchetype.LIFT_PUSH, slot, ex, FakeInputs())
    assert p.prescription_type == "core_circuit",  f"Core slot must be core_circuit, got '{p.prescription_type}'"
    # Must not be generic strength reps
    assert "8-12" not in p.reps or "hold" in p.reps.lower() or "s hold" in p.reps.lower(), \
        f"Core slot should not return raw '8-12 reps': '{p.reps}'"
    print(f"  ✓ core_circuit prescription_type, reps='{p.reps}'")


def test_core_plank_timed_prescription():
    """Anti-extension core with time tracking → hold-based prescription."""
    from app.services.workout.prescriptions import _prescribe_core
    ex   = {"name": "Plank", "exercise_type": "strength", "movement_pattern": "anti_extension",
            "default_tracking_mode": "time", "is_compound": False}
    slot = FakeSlot(role="core", label="Core — Anti-Extension")
    p    = _prescribe_core(slot, ex)
    assert "hold" in p.reps.lower() or "s" in p.reps, \
        f"Plank must get hold-based prescription: '{p.reps}'"
    assert p.prescription_type == "core_circuit"
    print(f"  ✓ plank → hold prescription: '{p.reps}'")


def test_core_pallof_reps_prescription():
    """Anti-rotation core → reps-per-side prescription."""
    from app.services.workout.prescriptions import _prescribe_core
    ex   = {"name": "Pallof Press", "exercise_type": "strength", "movement_pattern": "anti_rotation",
            "default_tracking_mode": "reps", "is_compound": False}
    slot = FakeSlot(role="core", label="Core — Anti-Rotation")
    p    = _prescribe_core(slot, ex)
    assert "side" in p.reps.lower() or "reps" in p.reps.lower(), \
        f"Pallof press must get per-side or reps prescription: '{p.reps}'"
    print(f"  ✓ pallof press → per-side prescription: '{p.reps}'")


def test_core_carry_prescription():
    """Carry / bracing core → distance or time prescription."""
    from app.services.workout.prescriptions import _prescribe_core
    ex   = {"name": "Farmer Carry", "exercise_type": "strength", "movement_pattern": "carry",
            "default_tracking_mode": "distance", "is_compound": False}
    slot = FakeSlot(role="core", label="Core — Carry / Bracing")
    p    = _prescribe_core(slot, ex)
    assert "m" in p.reps or "s" in p.reps, \
        f"Carry must get distance/time prescription: '{p.reps}'"
    print(f"  ✓ carry → distance/time prescription: '{p.reps}'")


# ─── warmup prescription ─────────────────────────────────────────────────────

def test_warmup_prescription_type():
    """Warmup-role slots always get prescription_type='warmup'."""
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.prescriptions import prescribe_for_slot
    ex   = {"name": "Hip Circle", "exercise_type": "mobility", "movement_pattern": "mobility",
            "default_tracking_mode": "reps", "is_compound": False}
    slot = FakeSlot(role="warmup", label="Dynamic Warm-Up")
    p    = prescribe_for_slot(DayArchetype.LIFT_PUSH, slot, ex, FakeInputs())
    assert p.prescription_type == "warmup",        f"Warmup slot must be 'warmup', got '{p.prescription_type}'"
    print(f"  ✓ warmup slot → prescription_type=warmup")


# ─── detect_cardio_modality ───────────────────────────────────────────────────

def test_modality_detection():
    """detect_cardio_modality correctly identifies exercise names."""
    from app.services.workout.cardio import (
        detect_cardio_modality,
        MODALITY_TREADMILL, MODALITY_BIKE, MODALITY_ROWER,
        MODALITY_ELLIPTICAL, MODALITY_STAIR_CLIMBER, MODALITY_ASSAULT_BIKE,
    )
    cases = [
        ("Incline Walk",                  MODALITY_TREADMILL),
        ("Treadmill Run",                 MODALITY_TREADMILL),
        ("Stationary Bike",               MODALITY_BIKE),
        ("Stationary Bike Intervals",     MODALITY_BIKE),
        ("Bike Zone 2",                   MODALITY_BIKE),
        ("Rowing Machine",                MODALITY_ROWER),
        ("Rowing Machine Intervals",      MODALITY_ROWER),
        ("Elliptical",                    MODALITY_ELLIPTICAL),
        ("Stair Climber",                 MODALITY_STAIR_CLIMBER),
        ("Assault Bike",                  MODALITY_ASSAULT_BIKE),
        ("Barbell Squat",                 None),
    ]
    for name, expected in cases:
        got = detect_cardio_modality(name)
        assert got == expected, f"detect_cardio_modality('{name}') = {got!r}, expected {expected!r}"
    print("  ✓ modality detection covers treadmill/bike/rower/elliptical/stair/assault/none")


# ─── runner ──────────────────────────────────────────────────────────────────

TESTS = [
    test_incline_walk_guidance_no_caps,
    test_incline_walk_prescription_text,
    test_ic6_bike_guidance_watts_rpm,
    test_basic_bike_resistance_no_watts,
    test_no_display_bike_rpe_only,
    test_rower_with_pace_caps,
    test_rower_no_caps,
    test_cardio_steady_prescription_type,
    test_bike_zone2_prescription_uses_bike_capabilities,
    test_cardio_intervals_prescription_type,
    test_incline_walk_not_strength_type,
    test_yoga_prescription_type,
    test_stretch_prescription_type,
    test_yoga_not_treated_as_generic_mobility,
    test_core_slot_prescription_type,
    test_core_plank_timed_prescription,
    test_core_pallof_reps_prescription,
    test_core_carry_prescription,
    test_warmup_prescription_type,
    test_modality_detection,
]


def run_all():
    passed = failed = 0
    for test_fn in TESTS:
        try:
            print(f"[{test_fn.__name__}]")
            test_fn()
            passed += 1
        except Exception:
            print(f"  ✗ FAILED")
            traceback.print_exc()
            failed += 1
    print(f"\n{'='*55}")
    print(f"Cardio prescription tests: {passed} passed, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    run_all()
