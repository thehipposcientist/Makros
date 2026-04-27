"""Pure-function tests for resolve_exercise_fatigue + resolve_focus_fatigue.

Covers:
  - Skipped exercises (0 sets) produce no fatigue
  - Zero-rep sets are excluded
  - Load factor scales with weight
  - Compound vs isolation systemic cost
  - RIR/stimulus multipliers
  - PLUS_CARDIO focus label merging
  - Age multiplier
  - Cap at 1.0

Run:
    docker exec -it thallo-backend python -m tests.test_exercise_fatigue
"""
from __future__ import annotations

import math

from app.services.workout.activity_impact import (
    resolve_exercise_fatigue,
    resolve_focus_fatigue,
)


# ─── resolve_exercise_fatigue ─────────────────────────────────────────────────


def test_skipped_exercise_zero_fatigue():
    """An exercise with 0 logged sets produces no fatigue."""
    result = resolve_exercise_fatigue([
        {
            "name": "Bench Press",
            "primary_muscle": "chest",
            "secondary_muscles": ["triceps", "shoulders"],
            "is_compound": True,
            "sets": [],
            "sets_logged": 0,
        },
    ])
    assert result == {}, f"Expected empty fatigue, got {result}"


def test_zero_rep_sets_excluded():
    """Sets with reps=0 are skipped — only actual work counts."""
    result = resolve_exercise_fatigue([
        {
            "name": "Bench Press",
            "primary_muscle": "chest",
            "secondary_muscles": ["triceps"],
            "is_compound": True,
            "sets": [
                {"reps": 0, "weight_lbs": 135, "rir": None},
                {"reps": 0, "weight_lbs": 135, "rir": None},
            ],
        },
    ])
    assert result == {}, f"Expected empty fatigue for all-zero-rep sets, got {result}"


def test_basic_exercise_produces_fatigue():
    """A normal 3×10 exercise produces non-zero fatigue on primary muscle."""
    result = resolve_exercise_fatigue([
        {
            "name": "Bench Press",
            "primary_muscle": "chest",
            "secondary_muscles": ["triceps", "shoulders"],
            "is_compound": True,
            "sets": [
                {"reps": 10, "weight_lbs": 135, "rir": 2},
                {"reps": 10, "weight_lbs": 135, "rir": 2},
                {"reps": 8, "weight_lbs": 135, "rir": 1},
            ],
        },
    ])
    assert "chest" in result
    assert result["chest"] > 0
    assert "triceps" in result
    assert result["triceps"] > 0
    assert "systemic" in result
    assert result["systemic"] > 0
    # Primary gets more than secondary
    assert result["chest"] > result["triceps"]


def test_more_sets_more_fatigue():
    """5 sets produces more fatigue than 3 sets (same weight/reps)."""
    base_ex = {
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": ["glutes", "hamstrings"],
        "is_compound": True,
    }
    three_sets = resolve_exercise_fatigue([{
        **base_ex,
        "sets": [{"reps": 8, "weight_lbs": 225, "rir": 2}] * 3,
    }])
    five_sets = resolve_exercise_fatigue([{
        **base_ex,
        "sets": [{"reps": 8, "weight_lbs": 225, "rir": 2}] * 5,
    }])
    assert five_sets["quads"] > three_sets["quads"]


def test_heavier_weight_more_fatigue():
    """315 lbs produces more fatigue than 135 lbs at same reps/sets."""
    base_ex = {
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": ["glutes"],
        "is_compound": True,
    }
    light = resolve_exercise_fatigue([{
        **base_ex,
        "sets": [{"reps": 5, "weight_lbs": 135, "rir": 2}] * 4,
    }])
    heavy = resolve_exercise_fatigue([{
        **base_ex,
        "sets": [{"reps": 5, "weight_lbs": 315, "rir": 2}] * 4,
    }])
    assert heavy["quads"] > light["quads"], (
        f"Heavy ({heavy['quads']}) should > light ({light['quads']})"
    )


def test_bodyweight_exercise_load_factor_one():
    """Bodyweight exercise (0 lbs) gets load_factor = 1.0."""
    result = resolve_exercise_fatigue([
        {
            "name": "Pull-up",
            "primary_muscle": "back",
            "secondary_muscles": ["biceps"],
            "is_compound": True,
            "sets": [
                {"reps": 10, "weight_lbs": 0, "rir": 2},
                {"reps": 8, "weight_lbs": 0, "rir": 1},
            ],
        },
    ])
    # Manually compute expected: base_per_rep=0.010, total_reps=18,
    # avg_reps=9 → hypertrophy bracket (sys=1.0, mus=1.0), load_factor=1.0
    # primary: 0.010 * 18 * 1.0 * 1.0 = 0.18
    assert 0.15 < result["back"] < 0.22


def test_compound_more_systemic_than_isolation():
    """Compound exercises produce higher systemic fatigue than isolation."""
    compound = resolve_exercise_fatigue([{
        "name": "Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": ["triceps"],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3,
    }])
    isolation = resolve_exercise_fatigue([{
        "name": "Chest Fly",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": False,
        "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3,
    }])
    assert compound["systemic"] > isolation["systemic"]


def test_low_rir_more_systemic():
    """Training to failure (RIR 0) produces more systemic fatigue than RIR 3."""
    base = {
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": ["glutes"],
        "is_compound": True,
    }
    failure = resolve_exercise_fatigue([{
        **base,
        "sets": [{"reps": 8, "weight_lbs": 225, "rir": 0}] * 4,
    }])
    submaximal = resolve_exercise_fatigue([{
        **base,
        "sets": [{"reps": 8, "weight_lbs": 225, "rir": 3}] * 4,
    }])
    assert failure["systemic"] > submaximal["systemic"]


def test_heavy_vs_volume_stimulus():
    """Heavy (5 reps) produces more systemic, volume (15 reps) more muscular."""
    base = {
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": [],
        "is_compound": True,
    }
    heavy = resolve_exercise_fatigue([{
        **base,
        "sets": [{"reps": 5, "weight_lbs": 275, "rir": 2}] * 4,
    }])
    volume = resolve_exercise_fatigue([{
        **base,
        "sets": [{"reps": 15, "weight_lbs": 135, "rir": 2}] * 4,
    }])
    # Volume has more total reps so it produces more muscular fatigue
    assert volume["quads"] > heavy["quads"]
    # But heavy has higher systemic multiplier per unit of work
    # Compare systemic / total_reps ratio
    heavy_sys_per_rep = heavy["systemic"] / (5 * 4)
    volume_sys_per_rep = volume["systemic"] / (15 * 4)
    assert heavy_sys_per_rep > volume_sys_per_rep


def test_age_multiplier():
    """Older users accumulate more fatigue from same work."""
    ex = [{
        "name": "Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3,
    }]
    young = resolve_exercise_fatigue(ex, user_age=25)
    old = resolve_exercise_fatigue(ex, user_age=55)
    assert old["chest"] > young["chest"]


def test_cap_at_one():
    """Even massive volume caps at 1.0 per muscle."""
    result = resolve_exercise_fatigue([{
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 20, "weight_lbs": 315, "rir": 0}] * 20,
    }])
    assert result["quads"] <= 1.0


def test_multiple_exercises_accumulate():
    """Multiple exercises hitting the same muscle accumulate fatigue."""
    single = resolve_exercise_fatigue([{
        "name": "Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3,
    }])
    double = resolve_exercise_fatigue([
        {
            "name": "Bench Press",
            "primary_muscle": "chest",
            "secondary_muscles": [],
            "is_compound": True,
            "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3,
        },
        {
            "name": "Incline Press",
            "primary_muscle": "chest",
            "secondary_muscles": [],
            "is_compound": True,
            "sets": [{"reps": 10, "weight_lbs": 155, "rir": 2}] * 3,
        },
    ])
    assert double["chest"] > single["chest"]


def test_fallback_to_set_count():
    """When no structured sets, uses sets_logged × 10 assumed reps."""
    result = resolve_exercise_fatigue([{
        "name": "Cable Fly",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": False,
        "sets_logged": 3,
        "target_sets": 4,
    }])
    assert "chest" in result
    assert result["chest"] > 0


def test_fallback_zero_sets_logged_skipped():
    """Fallback path with sets_logged=0 produces no fatigue."""
    result = resolve_exercise_fatigue([{
        "name": "Cable Fly",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": False,
        "sets_logged": 0,
        "sets": [],
    }])
    assert result == {} or result.get("chest", 0) == 0


# ─── resolve_focus_fatigue ─────��───────────────────────────────���──────────────


def test_focus_push():
    """'Push' focus produces chest + shoulders + triceps fatigue."""
    result = resolve_focus_fatigue("Push")
    assert result["chest"] > 0
    assert result["shoulders"] > 0
    assert result["triceps"] > 0


def test_focus_recovery_negative():
    """Recovery focus produces NEGATIVE fatigue (aids recovery)."""
    result = resolve_focus_fatigue("Recovery")
    assert all(v < 0 for v in result.values())


def test_focus_plus_cardio_merges():
    """'Push + Cardio' merges push fatigue with cardio fatigue."""
    result = resolve_focus_fatigue("Push + Cardio")
    # Should have push muscles
    assert result.get("chest", 0) > 0
    assert result.get("shoulders", 0) > 0
    # AND cardio muscles
    assert result.get("cardio", 0) > 0


def test_focus_pull_plus_cardio():
    """'Pull + Cardio' has back AND cardio."""
    result = resolve_focus_fatigue("Pull + Cardio")
    assert result.get("back", 0) > 0
    assert result.get("cardio", 0) > 0


def test_focus_upper_plus_cardio():
    """'Upper + Cardio' has chest/back AND cardio."""
    result = resolve_focus_fatigue("Upper + Cardio")
    assert result.get("chest", 0) > 0
    assert result.get("back", 0) > 0
    assert result.get("cardio", 0) > 0


def test_focus_intensity_scales():
    """'hard' intensity produces more fatigue than 'easy'."""
    easy = resolve_focus_fatigue("Push", intensity="easy")
    hard = resolve_focus_fatigue("Push", intensity="hard")
    assert hard["chest"] > easy["chest"]


def test_focus_duration_scales():
    """Longer duration produces more fatigue."""
    short = resolve_focus_fatigue("Push", duration_minutes=30)
    long = resolve_focus_fatigue("Push", duration_minutes=90)
    assert long["chest"] > short["chest"]


def test_focus_unknown_label_fallback():
    """Unknown focus label falls back to generic systemic fatigue."""
    result = resolve_focus_fatigue("Some Unknown Focus")
    assert "systemic" in result
    assert result["systemic"] > 0


# ─── Load factor math ─────────────────────────────────────────────────────────


def test_load_factor_at_50_lbs():
    """50 lbs → log2(50/50) = log2(1) = 0 → factor = 1.0."""
    factor = 1.0 + 0.12 * math.log2(max(1.0, 50.0 / 50.0))
    assert abs(factor - 1.0) < 0.001


def test_load_factor_at_200_lbs():
    """200 lbs → log2(200/50) = log2(4) = 2 → factor = 1.24."""
    factor = 1.0 + 0.12 * math.log2(max(1.0, 200.0 / 50.0))
    assert abs(factor - 1.24) < 0.01


def test_load_factor_at_400_lbs():
    """400 lbs → log2(400/50) = log2(8) = 3 → factor = 1.36."""
    factor = 1.0 + 0.12 * math.log2(max(1.0, 400.0 / 50.0))
    assert abs(factor - 1.36) < 0.01


# ─── Integration: realistic workout ──────────────────────────────────────────


def test_realistic_push_workout():
    """A realistic push workout produces expected fatigue pattern."""
    result = resolve_exercise_fatigue([
        {
            "name": "Bench Press",
            "primary_muscle": "chest",
            "secondary_muscles": ["triceps", "shoulders"],
            "is_compound": True,
            "sets": [
                {"reps": 8, "weight_lbs": 185, "rir": 2},
                {"reps": 8, "weight_lbs": 185, "rir": 1},
                {"reps": 6, "weight_lbs": 185, "rir": 0},
            ],
        },
        {
            "name": "Overhead Press",
            "primary_muscle": "shoulders",
            "secondary_muscles": ["triceps"],
            "is_compound": True,
            "sets": [
                {"reps": 10, "weight_lbs": 95, "rir": 2},
                {"reps": 9, "weight_lbs": 95, "rir": 1},
                {"reps": 8, "weight_lbs": 95, "rir": 1},
            ],
        },
        {
            "name": "Tricep Pushdown",
            "primary_muscle": "triceps",
            "secondary_muscles": [],
            "is_compound": False,
            "sets": [
                {"reps": 12, "weight_lbs": 50, "rir": 2},
                {"reps": 12, "weight_lbs": 50, "rir": 1},
                {"reps": 10, "weight_lbs": 50, "rir": 0},
            ],
        },
    ])
    # Chest should be meaningfully fatigued
    assert result["chest"] > 0.15
    # Shoulders hit by both bench (secondary) and OHP (primary)
    assert result["shoulders"] > 0.15
    # Triceps hit by all three exercises
    assert result["triceps"] > 0.10
    # Systemic from compounds
    assert result["systemic"] > 0.10
    # Nothing should exceed 1.0
    assert all(v <= 1.0 for v in result.values())


def test_partial_workout_less_fatigue():
    """A workout where user only did 2/5 exercises produces less fatigue."""
    full = resolve_exercise_fatigue([
        {"name": "Bench Press", "primary_muscle": "chest", "secondary_muscles": ["triceps"], "is_compound": True,
         "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3},
        {"name": "Incline Press", "primary_muscle": "chest", "secondary_muscles": ["shoulders"], "is_compound": True,
         "sets": [{"reps": 10, "weight_lbs": 155, "rir": 2}] * 3},
        {"name": "Chest Fly", "primary_muscle": "chest", "secondary_muscles": [], "is_compound": False,
         "sets": [{"reps": 12, "weight_lbs": 30, "rir": 2}] * 3},
    ])
    partial = resolve_exercise_fatigue([
        {"name": "Bench Press", "primary_muscle": "chest", "secondary_muscles": ["triceps"], "is_compound": True,
         "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2}] * 3},
        # User skipped incline and fly (filtered out by client)
    ])
    assert partial["chest"] < full["chest"]


# ─── Heart rate intensity factor ──────────────────────────────────────────────


def test_hr_no_data_factor_one():
    """No HR data → hr_factor = 1.0 (no change to fatigue)."""
    no_hr = resolve_exercise_fatigue([{
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 225, "rir": 2}] * 3,
    }])
    with_zero_hr = resolve_exercise_fatigue([{
        "name": "Squat",
        "primary_muscle": "quads",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 225, "rir": 2, "heart_rate_avg": 0}] * 3,
    }])
    assert abs(no_hr["quads"] - with_zero_hr["quads"]) < 0.001


def test_hr_high_more_fatigue():
    """High HR (170bpm @ age 30) produces more fatigue than low HR (100bpm)."""
    low_hr = resolve_exercise_fatigue([{
        "name": "Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2, "heart_rate_avg": 100}] * 3,
    }], user_age=30)
    high_hr = resolve_exercise_fatigue([{
        "name": "Bench Press",
        "primary_muscle": "chest",
        "secondary_muscles": [],
        "is_compound": True,
        "sets": [{"reps": 8, "weight_lbs": 185, "rir": 2, "heart_rate_avg": 170}] * 3,
    }], user_age=30)
    assert high_hr["chest"] > low_hr["chest"], (
        f"High HR ({high_hr['chest']}) should > low HR ({low_hr['chest']})"
    )
    assert high_hr["systemic"] > low_hr["systemic"]


def test_hr_moderate_zone():
    """HR in 70-80% max (zone 3) → 1.10× factor."""
    from app.services.workout.activity_impact import _hr_intensity_factor
    # Age 30 → max HR 190. 70% = 133, 80% = 152.
    assert _hr_intensity_factor(140, 30) == 1.10


def test_hr_threshold_zone():
    """HR in 80-90% max (zone 4) → 1.20× factor."""
    from app.services.workout.activity_impact import _hr_intensity_factor
    # Age 30 → max HR 190. 80% = 152, 90% = 171.
    assert _hr_intensity_factor(160, 30) == 1.20


def test_hr_near_max_zone():
    """HR >90% max (zone 5) → 1.30× factor."""
    from app.services.workout.activity_impact import _hr_intensity_factor
    # Age 30 → max HR 190. 90% = 171.
    assert _hr_intensity_factor(175, 30) == 1.30


def test_hr_easy_zone():
    """HR <55% max → 0.90× factor (barely taxing)."""
    from app.services.workout.activity_impact import _hr_intensity_factor
    # Age 30 → max HR 190. 55% = 104.5. So 90 bpm is <55%.
    assert _hr_intensity_factor(90, 30) == 0.90


def test_hr_uses_age_for_max():
    """Older user (age 60, max HR 160) — 140bpm is 87.5% (zone 4)."""
    from app.services.workout.activity_impact import _hr_intensity_factor
    # Age 60 → max HR 160. 140/160 = 87.5% → zone 4 (1.20)
    assert _hr_intensity_factor(140, 60) == 1.20
    # Same 140bpm for age 25 → max HR 195, 140/195 = 71.8% → zone 3 (1.10)
    assert _hr_intensity_factor(140, 25) == 1.10


def test_hr_defaults_age_30():
    """When age is None, defaults to age 30 (max HR 190)."""
    from app.services.workout.activity_impact import _hr_intensity_factor
    assert _hr_intensity_factor(140, None) == _hr_intensity_factor(140, 30)


# ─── Runner ───────────────────────────────────────────────────────────────────

ALL_TESTS = [v for k, v in list(globals().items()) if k.startswith("test_")]


def run_all():
    passed = 0
    failed = 0
    for fn in ALL_TESTS:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
    total = passed + failed
    print(f"test_exercise_fatigue: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    success = run_all()
    sys.exit(0 if success else 1)
