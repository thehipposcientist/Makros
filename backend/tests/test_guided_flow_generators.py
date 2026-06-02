"""Unit tests for the guided-flow generators (yoga / stretch / foam-roll)
plus the `flow_category` propagation contract through `build_planner_exercise`.

Pure-function — no DB, no Docker. Validates:
  * generate_yoga_day orders poses warm → standing → floor → cool → breath
  * Each yoga pose carries a `flow_category` and `prescription_type`
  * generate_stretch_session skips standing balance / breath categories
  * generate_foam_roll_session pulls only foam-roll-tagged poses
  * build_planner_exercise propagates `flowCategory` from a tagged seed row
    AND emits None for an untagged one (rule 2 in .claude/rules/backend.md)
"""
from __future__ import annotations

from app.services.workout.planner import (
    generate_yoga_day,
    generate_stretch_session,
    generate_foam_roll_session,
    build_planner_exercise,
)
from app.services.workout.prescriptions import Prescription


_FLOW_ORDER = ("warm", "standing", "floor", "cool", "breath")


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_yoga_day_orders_categories():
    """Warm precedes standing precedes floor precedes cool precedes breath."""
    day = generate_yoga_day(20)
    exs = day.get("exercises") or []
    assert len(exs) >= 5, f"expected ≥5 poses for a 20-min flow, got {len(exs)}"

    seen_indices = []
    for ex in exs:
        fc = ex.get("flow_category") or ex.get("flowCategory")
        assert fc in _FLOW_ORDER, f"pose missing flow_category: {ex.get('name')!r}"
        seen_indices.append(_FLOW_ORDER.index(fc))

    # Indices must be non-decreasing.
    for i in range(1, len(seen_indices)):
        assert seen_indices[i] >= seen_indices[i - 1], (
            f"yoga ordering violated at index {i}: "
            f"{exs[i-1].get('name')!r} → {exs[i].get('name')!r}"
        )
    _ok("generate_yoga_day orders warm→standing→floor→cool→breath")


def test_yoga_day_prescription_type():
    """Every yoga pose carries prescription_type = yoga_flow."""
    day = generate_yoga_day(15)
    for ex in day.get("exercises") or []:
        ptype = ex.get("prescription_type") or ex.get("prescriptionType")
        assert ptype == "yoga_flow", f"{ex.get('name')!r} has prescription_type={ptype!r}"
    assert day.get("focus") == "Yoga"
    assert day.get("stimulus") == "mobility"
    _ok("generate_yoga_day stamps prescription_type='yoga_flow' on every pose")


def test_stretch_session_skips_standing_and_breath():
    """Stretch session = passive holds: warm/floor/cool only, no standing or breath."""
    day = generate_stretch_session(15)
    exs = day.get("exercises") or []
    assert exs, "stretch session should produce at least one exercise"
    for ex in exs:
        fc = ex.get("flow_category") or ex.get("flowCategory")
        assert fc in {"warm", "floor", "cool"}, (
            f"stretch session emitted a {fc} pose: {ex.get('name')!r}"
        )
        ptype = ex.get("prescription_type") or ex.get("prescriptionType")
        assert ptype == "stretch_hold", (
            f"stretch pose has prescription_type={ptype!r}, expected stretch_hold"
        )
    _ok("generate_stretch_session emits only warm/floor/cool poses with stretch_hold")


def test_foam_roll_session_only_foam_roll_tag():
    """Foam-roll session pulls only foam_roll-tagged exercises."""
    day = generate_foam_roll_session(10)
    exs = day.get("exercises") or []
    assert exs, "foam roll session should produce at least one exercise"
    for ex in exs:
        fc = ex.get("flow_category") or ex.get("flowCategory")
        assert fc == "foam_roll", (
            f"foam roll session emitted a {fc} pose: {ex.get('name')!r}"
        )
    _ok("generate_foam_roll_session emits only foam_roll-tagged exercises")


def test_build_planner_exercise_propagates_flow_category():
    """The canonical exercise dict helper carries flow_category through.
    Tagged → flowCategory present; untagged → flowCategory is None."""
    tagged_seed = {
        "slug": "downward_dog",
        "name": "Downward Dog",
        "primary_muscle": "back",
        "secondary_muscles": ["hamstrings"],
        "flow_category": "standing",
        "exercise_type": "mobility",
    }
    untagged_seed = {
        "slug": "barbell_bench_press",
        "name": "Barbell Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": ["triceps"],
        "exercise_type": "strength",
    }
    rx = Prescription(
        sets=1, reps="60s hold", rest_seconds=10, rir_target=0.0,
        prescription_type="yoga_flow", cardio_guidance=None,
    )

    out_tagged = build_planner_exercise(
        tagged_seed,
        prescription=rx,
        slot_label=None,
        role="mobility",
        archetype_value="yoga_flow",
        training_type="mobility",
        goal_bucket="general_health",
        experience="intermediate",
    )
    assert out_tagged.get("flowCategory") == "standing", (
        f"expected flowCategory='standing', got {out_tagged.get('flowCategory')!r}"
    )

    out_untagged = build_planner_exercise(
        untagged_seed,
        prescription=Prescription(
            sets=3, reps="8-10", rest_seconds=120, rir_target=2.0,
            prescription_type="strength", cardio_guidance=None,
        ),
        slot_label=None,
        role="primary",
        archetype_value="lift_push",
        training_type="strength",
        goal_bucket="muscle_gain",
        experience="intermediate",
    )
    assert out_untagged.get("flowCategory") is None, (
        f"expected None for untagged exercise, got {out_untagged.get('flowCategory')!r}"
    )
    _ok("build_planner_exercise propagates flow_category (tagged) and emits None (untagged)")


cases = [
    test_yoga_day_orders_categories,
    test_yoga_day_prescription_type,
    test_stretch_session_skips_standing_and_breath,
    test_foam_roll_session_only_foam_roll_tag,
    test_build_planner_exercise_propagates_flow_category,
]


if __name__ == "__main__":
    for case in cases:
        case()
    print("All guided-flow generator tests passed.")
