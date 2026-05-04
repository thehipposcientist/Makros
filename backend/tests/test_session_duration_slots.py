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
    slots.append(Slot("Bonus Isolation 2", "isolation", None, "isolation"))
    # Total: 3×12 + 8 + 2×6 + 2×6 = 68 min → over 60 min budget
    result = density_adjust_slots(slots, 60, category="lift")
    labels = [s.label for s in result]
    assert "Bonus Isolation" not in labels, "bonus slot should have been trimmed first"
    assert "Bonus Isolation 2" not in labels, "bonus slot should have been trimmed first"
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


def test_body_recomp_ppl_60_min_does_not_stack_extended_density():
    """45-60 min 7-day PPL should not look like a 75-90 min plan.

    Regression guard for filler-accessory expansion followed by core
    circuit injection, which produced 10-exercise Push/Pull days at a
    60-minute setting.
    """
    print("\n[test] integration: 60-min body_recomp PPL avoids extended density")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    plan = generate_workout_plan(
        PlannerInputs(
            goal="body_recomp",
            days_per_week=7,
            preferred_split="ppl",
            session_minutes=60,
            experience="intermediate",
            equipment_slugs=(
                "barbell", "dumbbell", "cable", "bench", "squat_rack",
                "pullup_bar", "resistance_bands", "jump_rope",
            ),
            rng_seed=37,
        ),
        SEED_EXERCISES,
    )

    dense_lift_days = [
        (d.get("focus"), len(d.get("exercises", [])))
        for d in plan["workout_plan"]["days"]
        if d.get("category") == "lift" and len(d.get("exercises", [])) > 8
    ]

    assert not dense_lift_days, f"60-min lift days too dense: {dense_lift_days}"
    _ok("60-min body_recomp PPL lift days stay at 8 exercises or fewer")


def test_heavy_lower_archetypes_include_direct_calves():
    """Heavy lower/legs days still need direct calf work.

    Calves are a first-class fatigue/volume group, but the heavy lower
    templates used to omit them entirely.
    """
    print("\n[test] calf coverage: heavy lower archetypes include calf slot")
    heavy_lower = (
        DayArchetype.LIFT_LOWER_HEAVY,
        DayArchetype.LIFT_LEGS_HEAVY,
    )
    for arch in heavy_lower:
        slots = archetype_to_slots(arch, 0, 4, session_minutes=60)
        hints = [s.primary_muscle_hint for s in slots]
        assert "calves" in hints, f"{arch.value} missing direct calf slot: {hints}"
    _ok("heavy lower/legs templates include direct calf slot")


def test_all_lower_leg_archetypes_include_direct_calf_slot():
    """Every lower-family lifting archetype should expose at least one
    direct calf slot before density trimming."""
    print("\n[test] calf coverage: all lower/legs archetypes include calf slot")
    lower_leg_archetypes = (
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_LOWER_HEAVY,
        DayArchetype.LIFT_LOWER_HYPERTROPHY,
        DayArchetype.LIFT_LEGS,
        DayArchetype.LIFT_LEGS_HEAVY,
        DayArchetype.LIFT_LEGS_VOLUME,
        DayArchetype.LIFT_BRO_LEGS,
    )
    missing = []
    for arch in lower_leg_archetypes:
        slots = archetype_to_slots(arch, 0, 5, session_minutes=60)
        if not any(s.primary_muscle_hint == "calves" for s in slots):
            missing.append((arch.value, [(s.label, s.primary_muscle_hint) for s in slots]))
    assert not missing, f"lower/legs archetypes missing calf slot: {missing}"
    _ok(f"{len(lower_leg_archetypes)} lower/legs archetypes include direct calf slot")


def test_density_trim_preserves_calves_before_secondary_work():
    """Calf slots should survive normal short-session trimming.

    At 30 minutes we keep squat + hinge + direct calves and drop the
    secondary lunge plus another isolation. At an impossible 20-minute
    budget, the two primaries remain and calves may be sacrificed.
    """
    print("\n[test] calf coverage: density trim protects calves before secondary")
    slots = [
        Slot("Primary Squat", "squat", "quads", "primary"),
        Slot("Primary Hinge", "hinge", "hamstrings", "primary"),
        Slot("Secondary Lunge", "lunge", "quads", "secondary"),
        Slot("Glute Isolation", "isolation", "glutes", "isolation"),
        Slot("Calves", "isolation", "calves", "isolation"),
    ]

    at_30 = density_adjust_slots(slots, 30, category="lift")
    labels_30 = [s.label for s in at_30]
    assert "Calves" in labels_30, f"30-min trim dropped calves: {labels_30}"
    assert "Secondary Lunge" not in labels_30, (
        f"30-min trim should drop secondary before protected calves: {labels_30}"
    )

    at_20 = density_adjust_slots(slots, 20, category="lift")
    labels_20 = [s.label for s in at_20]
    assert labels_20 == ["Primary Squat", "Primary Hinge"], labels_20
    _ok("30-min keeps calves; 20-min keeps only primaries")


def test_short_ppl_leg_days_preserve_direct_calves():
    """At 45 minutes, lower days should trim duplicate leg volume before
    dropping the only direct calf exercise."""
    print("\n[test] calf coverage: 45-min PPL leg days keep direct calves")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    plan = generate_workout_plan(
        PlannerInputs(
            goal="muscle_gain",
            days_per_week=4,
            preferred_split="ppl",
            session_minutes=45,
            experience="intermediate",
            equipment_slugs=(
                "barbell", "dumbbells", "bench", "squat_rack",
                "leg_press_machine", "leg_extension_machine",
                "leg_curl_machine", "standing_calf_raise_machine",
                "seated_calf_raise_machine", "smith_machine",
            ),
            rng_seed=37,
        ),
        SEED_EXERCISES,
    )

    lower_archetypes = {
        DayArchetype.LIFT_LOWER.value,
        DayArchetype.LIFT_LOWER_HEAVY.value,
        DayArchetype.LIFT_LOWER_HYPERTROPHY.value,
        DayArchetype.LIFT_LEGS.value,
        DayArchetype.LIFT_LEGS_HEAVY.value,
        DayArchetype.LIFT_LEGS_VOLUME.value,
    }
    lower_days = [
        d for d in plan["workout_plan"]["days"]
        if d.get("archetype") in lower_archetypes
    ]
    assert lower_days, "test plan did not generate any lower/legs days"
    missing = [
        (d.get("day"), d.get("archetype"), [e.get("name") for e in d.get("exercises", [])])
        for d in lower_days
        if not any(e.get("_primary_muscle") == "calves" for e in d.get("exercises", []))
    ]
    assert not missing, f"lower/legs days missing direct calves: {missing}"
    _ok(f"{len(lower_days)} short lower/legs days include direct calf work")


def test_lower_leg_calf_coverage_matrix_normal_durations():
    """Representative split × goal × equipment sweep for normal short
    and medium sessions.

    Excludes 20-minute sessions by design: those are hard-budget days
    where the planner must keep only the two main compounds.
    """
    print("\n[test] calf coverage: split/goal/equipment matrix at 30-75 min")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    equipment_profiles = {
        "full_gym": (
            "barbell", "dumbbells", "bench", "flat_bench", "adjustable_bench",
            "squat_rack", "power_rack", "cable_machine", "leg_press_machine",
            "leg_extension_machine", "leg_curl_machine", "standing_calf_raise_machine",
            "seated_calf_raise_machine", "smith_machine", "pull_up_bar",
        ),
        "no_calf_machine": (
            "barbell", "dumbbells", "bench", "flat_bench", "squat_rack",
            "leg_press_machine", "leg_extension_machine", "leg_curl_machine",
        ),
        "dumbbell_home": ("dumbbells", "bench"),
        "bodyweight": ("bodyweight",),
    }
    scenarios = (
        ("ppl", "muscle_gain", 3, "intermediate"),
        ("ppl", "muscle_gain", 4, "intermediate"),
        ("ppl", "body_recomp", 7, "intermediate"),
        ("ppl", "strength", 6, "intermediate"),
        ("upper_lower", "muscle_gain", 4, "intermediate"),
        ("upper_lower", "strength", 4, "intermediate"),
        ("upper_lower", "fat_loss", 6, "intermediate"),
        ("ppl_upper_lower", "muscle_gain", 5, "intermediate"),
        ("ppl_upper_lower", "body_recomp", 7, "intermediate"),
        ("lower_focused", "muscle_gain", 4, "intermediate"),
        ("lower_focused", "body_recomp", 6, "intermediate"),
        ("bro", "muscle_gain", 5, "advanced"),
    )
    lower_archetypes = {
        DayArchetype.LIFT_LOWER.value,
        DayArchetype.LIFT_LOWER_HEAVY.value,
        DayArchetype.LIFT_LOWER_HYPERTROPHY.value,
        DayArchetype.LIFT_LEGS.value,
        DayArchetype.LIFT_LEGS_HEAVY.value,
        DayArchetype.LIFT_LEGS_VOLUME.value,
        DayArchetype.LIFT_BRO_LEGS.value,
    }

    checked = 0
    failures = []
    for equipment_name, equipment in equipment_profiles.items():
        for split, goal, days_per_week, experience in scenarios:
            for session_minutes in (30, 45, 60, 75):
                plan = generate_workout_plan(
                    PlannerInputs(
                        goal=goal,
                        days_per_week=days_per_week,
                        preferred_split=split,
                        session_minutes=session_minutes,
                        experience=experience,
                        equipment_slugs=equipment,
                        rng_seed=17,
                    ),
                    SEED_EXERCISES,
                )
                for day in plan["workout_plan"]["days"]:
                    if day.get("archetype") not in lower_archetypes:
                        continue
                    if day.get("category") != "lift":
                        continue
                    checked += 1
                    if not any(ex.get("_primary_muscle") == "calves" for ex in day.get("exercises", [])):
                        failures.append({
                            "equipment": equipment_name,
                            "split": split,
                            "goal": goal,
                            "days": days_per_week,
                            "minutes": session_minutes,
                            "archetype": day.get("archetype"),
                            "exercises": [ex.get("name") for ex in day.get("exercises", [])],
                        })

    assert checked > 0, "matrix did not inspect any lower/legs days"
    assert not failures, f"lower/legs calf coverage failures: {failures[:8]}"
    _ok(f"{checked} lower/legs days across matrix include direct calves")


def test_calf_focus_meets_direct_accessory_minimum():
    """When calves are the explicit focus, the focus audit should meet
    the direct-accessory floor even without calf machines."""
    print("\n[test] calf coverage: focused calves meet direct accessory floor")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    equipment_profiles = (
        (
            "full_gym",
            (
                "barbell", "dumbbells", "bench", "flat_bench", "squat_rack",
                "leg_press_machine", "leg_extension_machine", "leg_curl_machine",
                "standing_calf_raise_machine", "seated_calf_raise_machine",
            ),
        ),
        ("bodyweight", ("bodyweight",)),
        ("dumbbell_home", ("dumbbells", "bench")),
    )
    for label, equipment in equipment_profiles:
        plan = generate_workout_plan(
            PlannerInputs(
                goal="muscle_gain",
                days_per_week=4,
                preferred_split="upper_lower",
                session_minutes=45,
                experience="intermediate",
                equipment_slugs=equipment,
                focused_muscle="calves",
                rng_seed=12,
            ),
            SEED_EXERCISES,
        )["workout_plan"]
        audit = plan.get("focus_audit") or {}
        assert audit.get("muscle") == "calves", f"{label}: missing calf focus audit"
        assert audit.get("direct_accessories", 0) >= audit.get("min_direct_accessories", 999), (
            f"{label}: calf direct accessories below floor: {audit}"
        )
        assert audit.get("days_with_exposure", 0) >= audit.get("min_exposure_days", 999), (
            f"{label}: calf exposure below floor: {audit}"
        )
    _ok("calf focus meets direct accessory and exposure floors across gear profiles")


# ─── Cardio Finisher duration scaling ────────────────────────────────────────

def _finisher_reps(session_minutes: int) -> str:
    """Run the actual prescription path and return the reps string the
    Cardio Finisher slot would get at this session_minutes."""
    from app.services.workout.prescriptions import _prescribe_conditioning
    from app.services.workout.slots import Slot
    from types import SimpleNamespace

    finisher_slot = Slot("Cardio Finisher", "cardio", None, "secondary")
    fake_exercise = {
        "name": "Treadmill",
        "movement_pattern": "cardio",
        "primary_muscle": "cardio",
    }
    fake_inputs = SimpleNamespace(
        session_minutes=session_minutes,
        user_equipment_capabilities={},
        user_age=None,
        resting_hr=None,
    )
    presc = _prescribe_conditioning(
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
        finisher_slot,
        fake_exercise,
        fake_inputs,
    )
    return presc.reps


def _displayed_minutes(reps: str) -> int:
    """Pull the leading 'N min' value rendered by render_cardio_prescription_text."""
    import re
    m = re.match(r"\s*(\d+)\s*min", reps)
    return int(m.group(1)) if m else 0


def test_cardio_finisher_short_at_45_min():
    """At 45 min sessions, Cardio Finisher caps near 5 min so the
    lift portion still fits the budget."""
    print("\n[test] cardio finisher: 45 min → ≤5 min finisher")
    reps = _finisher_reps(45)
    mins = _displayed_minutes(reps)
    assert 3 <= mins <= 5, f"expected 3-5 min at sm=45, got: {mins} min ('{reps}')"
    _ok(f"45 min: '{reps}'")


def test_cardio_finisher_medium_at_60_min():
    """At 60 min, Cardio Finisher caps near 12 min so lift+cardio total
    stays within the user's chosen 45-60 range."""
    print("\n[test] cardio finisher: 60 min → ≤12 min finisher")
    reps = _finisher_reps(60)
    mins = _displayed_minutes(reps)
    assert 8 <= mins <= 12, f"expected 8-12 min at sm=60, got: {mins} min ('{reps}')"
    _ok(f"60 min: '{reps}'")


def test_cardio_finisher_extended_at_75_min():
    """At 75 min, Cardio Finisher is 12-18 min."""
    print("\n[test] cardio finisher: 75 min → 12-18 min finisher")
    reps = _finisher_reps(75)
    mins = _displayed_minutes(reps)
    assert 12 <= mins <= 18, f"expected 12-18 min at sm=75, got: {mins} min ('{reps}')"
    _ok(f"75 min: '{reps}'")


def test_cardio_finisher_long_at_90_min():
    """At 90 min, Cardio Finisher is 18-25 min."""
    print("\n[test] cardio finisher: 90 min → 18-25 min finisher")
    reps = _finisher_reps(90)
    mins = _displayed_minutes(reps)
    assert 18 <= mins <= 25, f"expected 18-25 min at sm=90, got: {mins} min ('{reps}')"
    _ok(f"90 min: '{reps}'")


def test_cardio_finisher_scales_monotonically():
    """Sanity: each tier's finisher midpoint should be ≥ the previous tier."""
    print("\n[test] cardio finisher: midpoint scales monotonically with session_minutes")
    import re

    def _mid(reps: str) -> float:
        m = re.search(r"(\d+)\s*-\s*(\d+)\s*min", reps)
        if m:
            return (int(m.group(1)) + int(m.group(2))) / 2.0
        m = re.search(r"(\d+)\s*min", reps)
        return float(m.group(1)) if m else 0.0

    mids = [_mid(_finisher_reps(sm)) for sm in (45, 60, 75, 90)]
    for prev, cur in zip(mids, mids[1:]):
        assert cur >= prev, f"finisher midpoints not monotonic: {mids}"
    _ok(f"midpoints monotonic: {mids}")


def test_lifting_set_density_starts_at_75_min():
    """The 45-60 min picker stores 60 as the upper bound; it should not
    receive the extended-session set bump reserved for 60-75+ min."""
    print("\n[test] lifting set density: 60 min has no extended-set bump")
    from types import SimpleNamespace
    from app.services.workout.prescriptions import _prescribe_by_stimulus

    slot = Slot("Primary Press", "horizontal_press", "chest", "primary")
    exercise = {"name": "Bench Press", "movement_pattern": "horizontal_press"}

    at_60 = _prescribe_by_stimulus(
        "strength", slot, exercise, SimpleNamespace(session_minutes=60)
    )
    at_75 = _prescribe_by_stimulus(
        "strength", slot, exercise, SimpleNamespace(session_minutes=75)
    )
    at_90 = _prescribe_by_stimulus(
        "strength", slot, exercise, SimpleNamespace(session_minutes=90)
    )

    assert at_60.sets == 4, f"60 min should keep base primary sets, got {at_60.sets}"
    assert at_75.sets == 5, f"75 min should add one primary set, got {at_75.sets}"
    assert at_90.sets == 6, f"90 min should add two primary sets, got {at_90.sets}"
    _ok("60/75/90 min lifting density tiers are distinct")


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
    test_body_recomp_ppl_60_min_does_not_stack_extended_density,
    test_heavy_lower_archetypes_include_direct_calves,
    test_all_lower_leg_archetypes_include_direct_calf_slot,
    test_density_trim_preserves_calves_before_secondary_work,
    test_short_ppl_leg_days_preserve_direct_calves,
    test_lower_leg_calf_coverage_matrix_normal_durations,
    test_calf_focus_meets_direct_accessory_minimum,
    test_cardio_finisher_short_at_45_min,
    test_cardio_finisher_medium_at_60_min,
    test_cardio_finisher_extended_at_75_min,
    test_cardio_finisher_long_at_90_min,
    test_cardio_finisher_scales_monotonically,
    test_lifting_set_density_starts_at_75_min,
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
