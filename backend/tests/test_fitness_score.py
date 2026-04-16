"""Tests for the 4-pillar fitness score composite.

Covers each pillar's boundary behavior + the weighted composite.
Run directly:  python3 -m tests.test_fitness_score
"""
from __future__ import annotations

import sys
from dataclasses import dataclass

from app.services.workout.fitness_score import (
    compute_fitness_score,
    _rating_for,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


@dataclass
class MockProfile:
    slug: str
    name: str
    estimated_1rm_lbs: float
    recent_top_weight_lbs: float = 0.0
    recent_top_reps: int = 0
    session_count: int = 3
    confidence: float = 0.7
    last_performed_on = None


# ── Rating thresholds ───────────────────────────────────────────────

def test_rating_thresholds():
    print("\n[test] rating thresholds")
    assert _rating_for(90) == "Elite"
    assert _rating_for(75) == "Strong"
    assert _rating_for(60) == "Solid"
    assert _rating_for(45) == "Building"
    assert _rating_for(20) == "Starting"
    _ok("all rating bands")


# ── Strength pillar ─────────────────────────────────────────────────

def test_strength_missing_bodyweight():
    print("\n[test] strength: no bodyweight → 0 + hint")
    s = compute_fitness_score(
        profiles={'barbell_bench_press': MockProfile('barbell_bench_press', 'Bench', 200)},
        bodyweight_lbs=None,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
    )
    strength = s.pillars[0]
    assert strength.name == "Strength"
    assert strength.score == 0.0
    assert strength.data_quality == "missing"
    _ok("strength pillar handles missing bodyweight")


def test_strength_compound_base_only_caps_at_35():
    print("\n[test] strength: 4 showcase lifts at intermediate, no other data → ~35")
    profiles = {
        'barbell_bench_press': MockProfile('barbell_bench_press', 'Bench', 180),
        'barbell_back_squat': MockProfile('barbell_back_squat', 'Squat', 270),
        'barbell_deadlift': MockProfile('barbell_deadlift', 'DL', 360),
        'overhead_press': MockProfile('overhead_press', 'OHP', 120),
    }
    s = compute_fitness_score(
        profiles=profiles,
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
    )
    strength = s.pillars[0]
    # Compound base is 35% of pillar. 4 lifts at intermediate → ~35; other
    # sub-components are 0 with no pattern/volume/variety/progression data.
    assert 33 <= strength.score <= 37, f"expected ~35, got {strength.score}"
    _ok(f"compound-only intermediate → strength {strength.score:.0f}")


def test_strength_full_composite_hits_100():
    print("\n[test] strength: full composite (all sub-components maxed) → 100")
    profiles = {
        'barbell_bench_press': MockProfile('barbell_bench_press', 'Bench', 180),
        'barbell_back_squat': MockProfile('barbell_back_squat', 'Squat', 270),
        'barbell_deadlift': MockProfile('barbell_deadlift', 'DL', 360),
        'overhead_press': MockProfile('overhead_press', 'OHP', 120),
    }
    s = compute_fitness_score(
        profiles=profiles,
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
        patterns_hit={'squat', 'hinge', 'horizontal_press', 'vertical_press', 'horizontal_pull', 'vertical_pull'},
        volume_load_lbs=180 * 50000,
        distinct_exercises=12,
        progression_ratio=1.0,
    )
    strength = s.pillars[0]
    assert strength.score == 100.0, f"expected 100, got {strength.score}"
    _ok("full composite → 100")


def test_strength_non_showcase_work_partial_credit():
    print("\n[test] strength: non-showcase work only → partial credit")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
        patterns_hit={'horizontal_press', 'vertical_pull'},
        volume_load_lbs=180 * 25000,
        distinct_exercises=8,
        progression_ratio=0.5,
    )
    strength = s.pillars[0]
    # 2/6 patterns × 20 = 6.67, half volume × 15 = 7.5, 8/12 × 15 = 10, 0.5 × 15 = 7.5 → ~32
    assert 28 <= strength.score <= 36, f"expected ~32, got {strength.score}"
    _ok(f"non-showcase work → strength {strength.score:.0f}")


def test_strength_caps_at_100():
    print("\n[test] strength: way above all thresholds → capped at 100")
    profiles = {
        'barbell_bench_press': MockProfile('barbell_bench_press', 'Bench', 500),
    }
    s = compute_fitness_score(
        profiles=profiles,
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
        patterns_hit={'squat', 'hinge', 'horizontal_press', 'vertical_press', 'horizontal_pull', 'vertical_pull'},
        volume_load_lbs=180 * 100000,
        distinct_exercises=30,
        progression_ratio=1.0,
    )
    strength = s.pillars[0]
    assert strength.score == 100.0
    _ok("strength composite caps at 100")


# ── Cardio pillar ───────────────────────────────────────────────────

def test_cardio_no_sessions():
    print("\n[test] cardio: no sessions → 0 + missing")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
    )
    cardio = s.pillars[1]
    assert cardio.score == 0.0
    assert cardio.data_quality == "missing"
    _ok("no cardio → 0/missing")


def test_cardio_meets_acsm_baseline():
    print("\n[test] cardio: 300 min Z2 + 4 intervals → 100")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[
            # 5 × 60 min Z2 sessions = 300 min
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 60 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 60 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 60 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 60 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 60 * 60},
            # 4 interval sessions
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
        ],
        session_count_14d=9,
        days_per_week=5,
    )
    cardio = s.pillars[1]
    assert cardio.score == 100.0
    _ok(f"ACSM baseline met → cardio {cardio.score:.0f}")


def test_cardio_half_baseline():
    print("\n[test] cardio: 150 min Z2 + 2 intervals → ~50")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[
            {'focus': 'Zone 2', 'duration_seconds': 75 * 60},
            {'focus': 'Zone 2', 'duration_seconds': 75 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
        ],
        session_count_14d=4,
        days_per_week=3,
    )
    cardio = s.pillars[1]
    assert 45 <= cardio.score <= 55, f"expected ~50, got {cardio.score}"
    _ok(f"half baseline → cardio {cardio.score:.0f}")


# ── Consistency pillar ──────────────────────────────────────────────

def test_consistency_full_target():
    print("\n[test] consistency: 10 of 10 sessions → 100")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=10,
        days_per_week=5,  # target = 10
    )
    consistency = s.pillars[2]
    assert consistency.score == 100.0
    _ok(f"full target → consistency {consistency.score:.0f}")


def test_consistency_capped():
    print("\n[test] consistency: 15 of 10 → capped at 100")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=15,
        days_per_week=5,
    )
    consistency = s.pillars[2]
    assert consistency.score == 100.0
    _ok("over-target capped at 100 (no extra credit for overtraining)")


def test_consistency_zero():
    print("\n[test] consistency: 0 of 6 → 0")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
    )
    consistency = s.pillars[2]
    assert consistency.score == 0.0
    _ok("zero sessions → 0")


# ── Recovery pillar ─────────────────────────────────────────────────

def test_recovery_missing_all_inputs():
    print("\n[test] recovery: no sleep/RPE → neutral 50 + hint")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
    )
    recovery = s.pillars[3]
    assert recovery.score == 50.0
    assert recovery.data_quality == "missing"
    _ok("no recovery data → neutral 50")


def test_recovery_ideal_inputs():
    print("\n[test] recovery: 8h sleep + RPE 7 → 100")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
        recent_sleep_hours=8.0,
        avg_session_rpe=7.0,
    )
    recovery = s.pillars[3]
    assert recovery.score == 100.0
    _ok("ideal sleep + moderate RPE → 100")


def test_recovery_poor_sleep_high_rpe():
    print("\n[test] recovery: 5h sleep + RPE 9.5 → low")
    s = compute_fitness_score(
        profiles={},
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
        recent_sleep_hours=5.0,
        avg_session_rpe=9.5,
    )
    recovery = s.pillars[3]
    assert recovery.score <= 30, f"expected low, got {recovery.score}"
    _ok(f"poor recovery inputs → {recovery.score:.0f}")


# ── Composite ──────────────────────────────────────────────────────

def test_composite_weighted_average():
    print("\n[test] composite: compound-only intermediate → low weighted total")
    s = compute_fitness_score(
        profiles={
            'barbell_bench_press': MockProfile('barbell_bench_press', 'Bench', 180),
            'barbell_back_squat': MockProfile('barbell_back_squat', 'Squat', 270),
            'barbell_deadlift': MockProfile('barbell_deadlift', 'DL', 360),
            'overhead_press': MockProfile('overhead_press', 'OHP', 120),
        },
        bodyweight_lbs=180,
        recent_completions=[],
        session_count_14d=0,
        days_per_week=3,
    )
    # Strength ≈ 35 × 30% = 10.5, cardio 0, consistency 0, recovery 50 × 15% = 7.5.
    # Total ≈ 18. The new composite punishes users who only train showcase
    # lifts and skip cardio + non-compound work, which is the whole point.
    assert 15 <= s.total <= 22, f"expected ~18, got {s.total}"
    assert s.rating == "Starting"
    _ok(f"compound-only → total {s.total:.1f} ({s.rating})")


def test_composite_balanced_user():
    print("\n[test] composite: balanced healthy user → Strong/Elite")
    s = compute_fitness_score(
        profiles={
            'barbell_bench_press': MockProfile('barbell_bench_press', 'Bench', 200),
            'barbell_back_squat': MockProfile('barbell_back_squat', 'Squat', 290),
            'barbell_deadlift': MockProfile('barbell_deadlift', 'DL', 380),
        },
        bodyweight_lbs=180,
        recent_completions=[
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 45 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 45 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 45 * 60},
            {'focus': 'Zone 2 Cardio', 'duration_seconds': 45 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
            {'focus': 'Short Intervals', 'duration_seconds': 30 * 60},
        ],
        session_count_14d=9,
        days_per_week=5,
        recent_sleep_hours=7.8,
        avg_session_rpe=7.5,
        # Now realistic — a balanced user also has pattern coverage,
        # volume, variety, and progression to feed the strength composite.
        patterns_hit={'squat', 'hinge', 'horizontal_press', 'horizontal_pull', 'vertical_pull'},
        volume_load_lbs=180 * 40000,
        distinct_exercises=14,
        progression_ratio=0.75,
    )
    assert s.total >= 70, f"expected >=70, got {s.total}"
    assert s.rating in ("Strong", "Elite")
    _ok(f"balanced user → total {s.total:.1f} ({s.rating})")


# ─── Runner ──────────────────────────────────────────────────────────────────

def _run_all() -> int:
    tests = [
        test_rating_thresholds,
        test_strength_missing_bodyweight,
        test_strength_compound_base_only_caps_at_35,
        test_strength_full_composite_hits_100,
        test_strength_non_showcase_work_partial_credit,
        test_strength_caps_at_100,
        test_cardio_no_sessions,
        test_cardio_meets_acsm_baseline,
        test_cardio_half_baseline,
        test_consistency_full_target,
        test_consistency_capped,
        test_consistency_zero,
        test_recovery_missing_all_inputs,
        test_recovery_ideal_inputs,
        test_recovery_poor_sleep_high_rpe,
        test_composite_weighted_average,
        test_composite_balanced_user,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            import traceback; traceback.print_exc()
            print(f"  ✗ {t.__name__} ({type(e).__name__}: {e})")
    print()
    print(f"{len(tests) - failed}/{len(tests)} passed" if failed == 0 else f"{failed} FAILED")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
