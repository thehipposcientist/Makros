"""Tests for session-duration-aware slot injection and the range-threshold
trimming behavior introduced alongside the 20–30/30–45/45–60/60–75/75–90
duration picker.

Covers:
  - _inject_bonus_slots: +0/+1/+2 isolation slots at 60/75/90 min
  - PLUS_CARDIO archetypes: no bonus injected (cardio finisher is the bonus)
  - Non-lift archetypes (cond/mobility/recovery): no bonus injected
  - archetype_to_slots wrapper: session_minutes flows through correctly
  - density_adjust_slots interaction: bonus slots drop first when over budget
  - Integration: generate_workout_plan produces correct slot counts at each tier
"""
from __future__ import annotations

from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META
from app.services.workout.day_templates import archetype_to_slots, _inject_bonus_slots
from app.services.workout.slots import Slot, density_adjust_slots


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _bonus_count(slots: list[Slot]) -> int:
    return sum(1 for s in slots if s.label.startswith("Bonus Isolation"))


# ─── _inject_bonus_slots unit ───────────────────────────────────────────────

def _base_slots() -> list[Slot]:
    return [
        Slot("Primary Press",  "horizontal_press", "chest",     "primary"),
        Slot("Primary Pull",   "vertical_pull",    "back",      "primary"),
        Slot("Secondary",      "horizontal_press", "chest",     "secondary"),
        Slot("Isolation A",    "isolation",        "shoulders", "isolation"),
        Slot("Isolation B",    "isolation",        "triceps",   "isolation"),
    ]


def test_inject_bonus_no_op_at_60():
    """Below 75 min → no bonus slots appended."""
    print("\n[test] inject_bonus: 60 min → no bonus")
    slots = _base_slots()
    for mins in (30, 45, 60, 74):
        result = _inject_bonus_slots(slots, DayArchetype.LIFT_PUSH, mins)
        assert _bonus_count(result) == 0, (
            f"session_minutes={mins} should not inject bonus, got {_bonus_count(result)}"
        )
    _ok("no bonus slots below 75 min")


def test_inject_bonus_one_at_75():
    """75 ≤ session_minutes < 90 → exactly +1 bonus isolation."""
    print("\n[test] inject_bonus: 75–89 min → +1 bonus")
    slots = _base_slots()
    for mins in (75, 80, 89):
        result = _inject_bonus_slots(slots, DayArchetype.LIFT_PUSH, mins)
        assert _bonus_count(result) == 1, (
            f"session_minutes={mins} expected 1 bonus, got {_bonus_count(result)}"
        )
        assert result[-1].label == "Bonus Isolation"
        assert result[-1].role == "isolation"
    _ok("+1 bonus isolation at 75–89 min")


def test_inject_bonus_two_at_90():
    """session_minutes >= 90 → exactly +2 bonus isolations."""
    print("\n[test] inject_bonus: 90+ min → +2 bonus")
    slots = _base_slots()
    for mins in (90, 100, 120):
        result = _inject_bonus_slots(slots, DayArchetype.LIFT_PUSH, mins)
        assert _bonus_count(result) == 2, (
            f"session_minutes={mins} expected 2 bonus, got {_bonus_count(result)}"
        )
        labels = [s.label for s in result if s.label.startswith("Bonus")]
        assert "Bonus Isolation" in labels and "Bonus Isolation 2" in labels
    _ok("+2 bonus isolations at 90+ min")


def test_inject_bonus_does_not_mutate_input():
    """_inject_bonus_slots must not mutate the original list."""
    print("\n[test] inject_bonus: input list not mutated")
    slots = _base_slots()
    original_len = len(slots)
    _inject_bonus_slots(slots, DayArchetype.LIFT_PUSH, 90)
    assert len(slots) == original_len, "original slot list was mutated"
    _ok("original slot list unchanged after injection")


# ─── PLUS_CARDIO archetypes: no bonus ────────────────────────────────────────

def test_plus_cardio_archetypes_no_bonus():
    """PLUS_CARDIO days already have a Cardio Finisher — no bonus injected."""
    print("\n[test] inject_bonus: PLUS_CARDIO → no bonus at any duration")
    plus_cardio = [
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
        DayArchetype.LIFT_PULL_PLUS_CARDIO,
        DayArchetype.LIFT_UPPER_PLUS_CARDIO,
        DayArchetype.LIFT_FULL_BODY_PLUS_CARDIO,
    ]
    slots = _base_slots()
    for arch in plus_cardio:
        for mins in (75, 90):
            result = _inject_bonus_slots(slots, arch, mins)
            assert _bonus_count(result) == 0, (
                f"{arch.value} at {mins} min should not get bonus slots"
            )
    _ok("PLUS_CARDIO archetypes: no bonus injected at 75 or 90 min")


# ─── Non-lift archetypes: no bonus ───────────────────────────────────────────

def test_non_lift_archetypes_no_bonus():
    """Cardio, mobility, and recovery days never get bonus isolation slots."""
    print("\n[test] inject_bonus: non-lift archetypes → no bonus")
    non_lift = [
        DayArchetype.COND_ZONE2,
        DayArchetype.COND_INTERVALS_SHORT,
        DayArchetype.MOBILITY_FLOW,
        DayArchetype.RECOVERY_EASY,
    ]
    slots = _base_slots()
    for arch in non_lift:
        for mins in (75, 90):
            result = _inject_bonus_slots(slots, arch, mins)
            assert _bonus_count(result) == 0, (
                f"{arch.value} at {mins} min should not get bonus, got {_bonus_count(result)}"
            )
    _ok("non-lift archetypes: no bonus injected")


# ─── archetype_to_slots wrapper ──────────────────────────────────────────────

_LIFT_SAMPLE = [
    DayArchetype.LIFT_PUSH,
    DayArchetype.LIFT_PULL,
    DayArchetype.LIFT_UPPER,
    DayArchetype.LIFT_LOWER,
    DayArchetype.LIFT_LEGS,
    DayArchetype.LIFT_FULL_BODY,
    DayArchetype.LIFT_BRO_CHEST,
    DayArchetype.LIFT_BRO_BACK,
]


def test_archetype_to_slots_no_bonus_at_60():
    """archetype_to_slots with default session_minutes → no bonus."""
    print("\n[test] archetype_to_slots: default (60 min) → no bonus slots")
    for arch in _LIFT_SAMPLE:
        slots = archetype_to_slots(arch, 0, 4, session_minutes=60)
        assert _bonus_count(slots) == 0, (
            f"{arch.value}: unexpected bonus at 60 min"
        )
    _ok("no bonus slots at 60 min across lift archetypes")


def test_archetype_to_slots_one_bonus_at_75():
    """+1 bonus isolation via archetype_to_slots at 75 min."""
    print("\n[test] archetype_to_slots: 75 min → +1 bonus")
    for arch in _LIFT_SAMPLE:
        slots_60 = archetype_to_slots(arch, 0, 4, session_minutes=60)
        slots_75 = archetype_to_slots(arch, 0, 4, session_minutes=75)
        assert len(slots_75) == len(slots_60) + 1, (
            f"{arch.value}: expected len+1 at 75 min, "
            f"got {len(slots_60)} vs {len(slots_75)}"
        )
        assert _bonus_count(slots_75) == 1
    _ok("+1 bonus slot in archetype_to_slots at 75 min")


def test_archetype_to_slots_two_bonus_at_90():
    """+2 bonus isolations via archetype_to_slots at 90 min."""
    print("\n[test] archetype_to_slots: 90 min → +2 bonus")
    for arch in _LIFT_SAMPLE:
        slots_60 = archetype_to_slots(arch, 0, 4, session_minutes=60)
        slots_90 = archetype_to_slots(arch, 0, 4, session_minutes=90)
        assert len(slots_90) == len(slots_60) + 2, (
            f"{arch.value}: expected len+2 at 90 min, "
            f"got {len(slots_60)} vs {len(slots_90)}"
        )
        assert _bonus_count(slots_90) == 2
    _ok("+2 bonus slots in archetype_to_slots at 90 min")


def test_plus_cardio_slot_count_unchanged_at_90():
    """PLUS_CARDIO slot count must not grow at 90 min."""
    print("\n[test] archetype_to_slots: PLUS_CARDIO unchanged at 90 min")
    plus_cardio = [
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
        DayArchetype.LIFT_PULL_PLUS_CARDIO,
        DayArchetype.LIFT_UPPER_PLUS_CARDIO,
        DayArchetype.LIFT_FULL_BODY_PLUS_CARDIO,
    ]
    for arch in plus_cardio:
        slots_60 = archetype_to_slots(arch, 0, 4, session_minutes=60)
        slots_90 = archetype_to_slots(arch, 0, 4, session_minutes=90)
        assert len(slots_90) == len(slots_60), (
            f"{arch.value}: PLUS_CARDIO slot count changed at 90 min"
        )
    _ok("PLUS_CARDIO slot counts identical at 60 vs 90 min")


# ─── density_adjust_slots interaction ───────────────────────────────────────

def test_bonus_slots_trimmed_first_when_over_budget():
    """Bonus isolation slots sit at the end of the list and drop before
    standard isolations when the session_minutes budget is tight."""
    print("\n[test] density: bonus slots drop before standard isolations")
    # Build a template that fits at 75 min but needs trimming at 60 min.
    # lift cost: primary=12, secondary=8, isolation=6
    # 2 primary (24) + secondary (8) + 2 standard iso (12) + 1 bonus iso (6) = 50 min
    # — fits at 60, so let's make it tighter: 3 primary (36) + secondary (8) + 2 iso (12) + bonus (6) = 62 min
    slots = [
        Slot("P1",            "horizontal_press", "chest",     "primary"),
        Slot("P2",            "vertical_press",   "shoulders", "primary"),
        Slot("P3",            "vertical_pull",    "back",      "primary"),
        Slot("Sec",           "horizontal_pull",  "back",      "secondary"),
        Slot("Iso A",         "isolation",        "biceps",    "isolation"),
        Slot("Iso B",         "isolation",        "triceps",   "isolation"),
        Slot("Bonus Isolation","isolation",        None,        "isolation"),  # bonus is last
    ]
    # Total: 3×12 + 8 + 2×6 + 6 = 62 min → over 60 min budget
    result = density_adjust_slots(slots, 60, category="lift")
    labels = [s.label for s in result]
    assert "Bonus Isolation" not in labels, "bonus slot should have been trimmed first"
    assert "Iso A" in labels or "Iso B" in labels, "standard isolation should survive"
    _ok("bonus isolation trimmed before standard isolations at tight budget")


def test_bonus_slot_survives_at_generous_budget():
    """Bonus slot is kept when the budget comfortably fits the full template."""
    print("\n[test] density: bonus slot survives at 90 min budget")
    slots = [
        Slot("P1",             "horizontal_press", "chest",     "primary"),
        Slot("P2",             "vertical_press",   "shoulders", "primary"),
        Slot("Sec",            "horizontal_pull",  "back",      "secondary"),
        Slot("Iso A",          "isolation",        "biceps",    "isolation"),
        Slot("Bonus Isolation","isolation",        None,        "isolation"),
    ]
    # Total: 24 + 8 + 12 = 44 min → well under 90
    result = density_adjust_slots(slots, 90, category="lift")
    labels = [s.label for s in result]
    assert "Bonus Isolation" in labels, "bonus slot should survive at 90 min"
    _ok("bonus isolation kept at 90 min budget")


# ─── Integration: generate_workout_plan slot counts ─────────────────────────

def test_plan_has_more_exercises_at_90_than_60():
    """End-to-end: a freshly generated plan at 90 min should have more
    exercises per lift day than the same plan at 60 min."""
    print("\n[test] integration: 90 min plan has more exercises than 60 min plan")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    base_inputs = dict(
        goal="muscle_gain",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbell", "cable", "pullup_bar",
                         "bench", "squat_rack"),
        rng_seed=99,
    )

    plan_60 = generate_workout_plan(
        PlannerInputs(**base_inputs, session_minutes=60), SEED_EXERCISES
    )
    plan_90 = generate_workout_plan(
        PlannerInputs(**base_inputs, session_minutes=90), SEED_EXERCISES
    )

    def lift_day_exercise_counts(plan: dict) -> list[int]:
        return [
            len(d["exercises"])
            for d in plan["workout_plan"]["days"]
            if d.get("category") == "lift"
        ]

    counts_60 = lift_day_exercise_counts(plan_60)
    counts_90 = lift_day_exercise_counts(plan_90)

    assert counts_90, "90-min plan has no lift days"
    assert counts_60, "60-min plan has no lift days"
    total_60 = sum(counts_60)
    total_90 = sum(counts_90)
    assert total_90 > total_60, (
        f"90-min plan should have more exercises than 60-min: "
        f"got {total_90} vs {total_60}"
    )
    _ok(f"90 min: {total_90} exercises across lift days vs {total_60} at 60 min")


def test_plan_at_60_and_75_same_structure_different_count():
    """60 min and 75 min plans should have the same split structure
    (same archetypes) but 75 min adds bonus isolations."""
    print("\n[test] integration: 75 min adds exercises without changing split")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    base_inputs = dict(
        goal="muscle_gain",
        days_per_week=4,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbell", "cable", "pullup_bar",
                         "bench", "squat_rack"),
        rng_seed=77,
    )

    plan_60 = generate_workout_plan(
        PlannerInputs(**base_inputs, session_minutes=60), SEED_EXERCISES
    )
    plan_75 = generate_workout_plan(
        PlannerInputs(**base_inputs, session_minutes=75), SEED_EXERCISES
    )

    days_60 = plan_60["workout_plan"]["days"]
    days_75 = plan_75["workout_plan"]["days"]

    assert len(days_60) == len(days_75), "day count should be identical"

    # Same archetype on each day
    for d60, d75 in zip(days_60, days_75):
        assert d60.get("archetype") == d75.get("archetype"), (
            f"archetype mismatch: {d60.get('archetype')} vs {d75.get('archetype')}"
        )

    # 75 min has at least as many exercises per lift day
    for d60, d75 in zip(days_60, days_75):
        if d60.get("category") == "lift" and "plus_cardio" not in (d60.get("archetype") or ""):
            ex60 = len(d60["exercises"])
            ex75 = len(d75["exercises"])
            assert ex75 >= ex60, (
                f"Day {d60['day']}: 75-min should have ≥ exercises vs 60-min "
                f"({ex75} vs {ex60})"
            )

    _ok("75-min plan: same split structure, more exercises on lift days")


cases = [
    test_inject_bonus_no_op_at_60,
    test_inject_bonus_one_at_75,
    test_inject_bonus_two_at_90,
    test_inject_bonus_does_not_mutate_input,
    test_plus_cardio_archetypes_no_bonus,
    test_non_lift_archetypes_no_bonus,
    test_archetype_to_slots_no_bonus_at_60,
    test_archetype_to_slots_one_bonus_at_75,
    test_archetype_to_slots_two_bonus_at_90,
    test_plus_cardio_slot_count_unchanged_at_90,
    test_bonus_slots_trimmed_first_when_over_budget,
    test_bonus_slot_survives_at_generous_budget,
    test_plan_has_more_exercises_at_90_than_60,
    test_plan_at_60_and_75_same_structure_different_count,
]

if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
