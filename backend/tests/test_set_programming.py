"""Tests for set_programming.py — the deterministic progression layer.

Exercises the pure helpers (no DB, no planner wiring) so they stay
fast and easy to debug.

Run directly:  python3 -m tests.test_set_programming
"""
from __future__ import annotations

import sys

from app.services.workout.set_programming import (
    PlannedSet,
    build_set_scheme,
    load_increment_for,
    parse_rep_range,
    recommend_next_session_load,
    recommend_next_set,
    round_to_increment,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _compound_bench():
    return {
        "slug": "barbell_bench_press",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "horizontal_press",
        "primary_muscle": "chest",
    }


def _compound_squat():
    return {
        "slug": "barbell_back_squat",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "squat",
        "primary_muscle": "quads",
    }


def _isolation_curl():
    return {
        "slug": "dumbbell_curl",
        "equipment_bucket": "dumbbell",
        "is_compound": False,
        "movement_pattern": "elbow_flexion",
        "primary_muscle": "biceps",
    }


# ── load_increment_for ─────────────────────────────────────────────

def test_load_increment_lower_body_barbell_compound():
    print("\n[test] lower-body barbell compound → +10 lb")
    assert load_increment_for(_compound_squat()) == 10.0
    _ok("squat uses 10 lb increment")


def test_load_increment_upper_body_barbell_compound():
    print("\n[test] upper-body barbell compound → +5 lb")
    assert load_increment_for(_compound_bench()) == 5.0
    _ok("bench uses 5 lb increment")


def test_load_increment_dumbbell_isolation():
    print("\n[test] dumbbell isolation → +2.5 lb")
    assert load_increment_for(_isolation_curl()) == 2.5
    _ok("curl uses 2.5 lb increment")


def test_load_increment_bodyweight_is_zero():
    print("\n[test] bodyweight → 0 (progression is reps)")
    ex = {"equipment_bucket": "bodyweight", "is_compound": False}
    assert load_increment_for(ex) == 0.0
    _ok("bodyweight increment is 0")


def test_round_to_increment_rounds_to_nearest():
    print("\n[test] round_to_increment")
    assert round_to_increment(157.0, 5.0) == 155.0
    assert round_to_increment(158.0, 5.0) == 160.0
    assert round_to_increment(137.2, 0) == 137.2
    _ok("rounds to nearest, 0-increment passthrough")


# ── parse_rep_range ────────────────────────────────────────────────

def test_parse_rep_range_variants():
    print("\n[test] parse_rep_range")
    assert parse_rep_range("6-8") == (6, 8)
    assert parse_rep_range("5") == (5, 5)
    assert parse_rep_range("30s") is None
    assert parse_rep_range("25-40 min") is None
    _ok("numeric ranges parse, timed strings return None")


# ── build_set_scheme ───────────────────────────────────────────────

def test_strength_primary_compound_gets_heavy_top_then_backoff():
    print("\n[test] strength + primary compound → heavy top + backoffs")
    scheme = build_set_scheme(
        _compound_bench(),
        total_sets=4, reps="4-6", rir_target=2.0,
        target_weight_lbs=200.0, goal_bucket="strength",
        role="primary", experience="intermediate",
    )
    assert len(scheme) == 4
    assert scheme[0].set_type == "heavy_top"
    assert scheme[0].progression_mode == "load_first"
    assert all(s.set_type == "backoff" for s in scheme[1:])
    assert (scheme[0].target_weight_lbs or 0) > (scheme[1].target_weight_lbs or 0)
    assert (scheme[1].target_weight_lbs or 0) % 5 == 0
    _ok(f"heavy {scheme[0].target_weight_lbs} → backoff {scheme[1].target_weight_lbs}")


def test_muscle_gain_primary_compound_scheme():
    print("\n[test] muscle_gain + primary compound → heavy_top, backoff, volume")
    scheme = build_set_scheme(
        _compound_bench(),
        total_sets=5, reps="6-8", rir_target=2.0,
        target_weight_lbs=180.0, goal_bucket="muscle_gain",
        role="primary", experience="intermediate",
    )
    assert scheme[0].set_type == "heavy_top"
    assert scheme[0].progression_mode == "load_first"
    assert scheme[1].set_type == "backoff"
    assert scheme[1].progression_mode == "reps_first"
    assert scheme[4].set_type == "volume"
    _ok("set 1 heavy_top, sets 2-3 backoff, set 5 volume")


def test_isolation_always_volume():
    print("\n[test] isolation → all volume, reps_first")
    scheme = build_set_scheme(
        _isolation_curl(),
        total_sets=3, reps="10-15", rir_target=1.0,
        target_weight_lbs=30.0, goal_bucket="muscle_gain",
        role="isolation", experience="intermediate",
    )
    assert all(s.set_type == "volume" for s in scheme)
    assert all(s.progression_mode == "reps_first" for s in scheme)
    _ok("3/3 sets are volume, reps_first")


def test_beginner_gets_simplified_scheme():
    print("\n[test] beginner experience → straight volume sets")
    scheme = build_set_scheme(
        _compound_bench(),
        total_sets=3, reps="6-8", rir_target=2.0,
        target_weight_lbs=135.0, goal_bucket="strength",
        role="primary", experience="beginner",
    )
    assert all(s.set_type == "volume" for s in scheme)
    assert all(s.progression_mode == "reps_first" for s in scheme)
    _ok("beginner scheme is straight volume")


def test_timed_scheme_emits_null_loads():
    print("\n[test] timed reps (plank hold) → null loads, fixed_skill")
    plank = {
        "slug": "plank", "equipment_bucket": "bodyweight",
        "is_compound": False, "primary_muscle": "core",
    }
    scheme = build_set_scheme(
        plank,
        total_sets=3, reps="30-45s", rir_target=1.0,
        target_weight_lbs=None, goal_bucket="muscle_gain",
        role="accessory", experience="intermediate",
    )
    assert len(scheme) == 3
    assert all(s.target_weight_lbs is None for s in scheme)
    assert all(s.progression_mode == "fixed_skill" for s in scheme)
    _ok("plank scheme: 3 sets, null loads, fixed_skill")


# ── recommend_next_set (intra-workout) ─────────────────────────────

def test_beat_top_with_rir_on_load_first_adds_increment():
    print("\n[test] beat top + RIR on load_first → +increment")
    planned = PlannedSet(
        set_number=1, set_type="heavy_top", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=185.0, progression_mode="load_first",
    )
    rec = recommend_next_set(
        exercise=_compound_bench(), planned_set=planned,
        actual_reps=9, actual_weight_lbs=185.0, actual_rir=2.0,
    )
    assert rec.action == "increase_load", rec.action
    assert rec.next_set_weight_lbs == 190.0, rec.next_set_weight_lbs
    _ok("+5 lb bench next set")


def test_beat_top_with_rir_on_reps_first_holds_load():
    print("\n[test] beat top on reps_first → hold_load")
    planned = PlannedSet(
        set_number=2, set_type="backoff", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=170.0, progression_mode="reps_first",
    )
    rec = recommend_next_set(
        exercise=_compound_bench(), planned_set=planned,
        actual_reps=9, actual_weight_lbs=170.0, actual_rir=2.0,
    )
    assert rec.action == "hold_load"
    assert rec.next_set_weight_lbs == 170.0
    _ok("reps_first holds load, banks reps")


def test_hit_range_holds_load():
    print("\n[test] hit range → hold")
    planned = PlannedSet(
        set_number=1, set_type="volume", target_reps="10-15",
        target_rir=1.0, target_weight_lbs=30.0, progression_mode="reps_first",
    )
    rec = recommend_next_set(
        exercise=_isolation_curl(), planned_set=planned,
        actual_reps=12, actual_weight_lbs=30.0, actual_rir=1.0,
    )
    assert rec.action == "hold_load"
    _ok("in range → hold")


def test_missed_range_at_failure_drops_load():
    print("\n[test] missed range + RIR 0 → reduce_load")
    planned = PlannedSet(
        set_number=1, set_type="heavy_top", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=200.0, progression_mode="load_first",
    )
    rec = recommend_next_set(
        exercise=_compound_bench(), planned_set=planned,
        actual_reps=4, actual_weight_lbs=200.0, actual_rir=0.0,
    )
    assert rec.action == "reduce_load", rec.action
    assert rec.next_set_weight_lbs == 195.0
    _ok("missed at failure → -5 lb")


def test_missed_range_without_failure_holds_load():
    print("\n[test] missed range but RIR > 0 → hold")
    planned = PlannedSet(
        set_number=1, set_type="volume", target_reps="8-10",
        target_rir=2.0, target_weight_lbs=150.0, progression_mode="reps_first",
    )
    rec = recommend_next_set(
        exercise=_compound_bench(), planned_set=planned,
        actual_reps=7, actual_weight_lbs=150.0, actual_rir=1.0,
    )
    assert rec.action == "hold_load"
    _ok("missed without failure → hold and retry")


# ── recommend_next_session_load ────────────────────────────────────

def test_next_session_all_sets_at_top_adds_load():
    print("\n[test] all sets at top last session → +load")
    planned = PlannedSet(
        set_number=1, set_type="heavy_top", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=185.0, progression_mode="load_first",
    )
    w, action, _ = recommend_next_session_load(
        exercise=_compound_bench(), planned_set=planned,
        last_session_sets=[
            {"reps": 8, "weight_lbs": 185.0},
            {"reps": 8, "weight_lbs": 185.0},
            {"reps": 8, "weight_lbs": 185.0},
        ],
    )
    assert action == "increase_load"
    assert w == 190.0
    _ok(f"next session → {w} lb")


def test_next_session_majority_missed_drops_load():
    print("\n[test] majority missed last session → -load")
    planned = PlannedSet(
        set_number=1, set_type="heavy_top", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=200.0, progression_mode="load_first",
    )
    w, action, _ = recommend_next_session_load(
        exercise=_compound_bench(), planned_set=planned,
        last_session_sets=[
            {"reps": 4, "weight_lbs": 200.0},
            {"reps": 5, "weight_lbs": 200.0},
            {"reps": 5, "weight_lbs": 200.0},
        ],
    )
    assert action == "reduce_load"
    assert w == 195.0
    _ok(f"next session → {w} lb")


def test_next_session_partial_holds():
    print("\n[test] partial progress → hold")
    planned = PlannedSet(
        set_number=1, set_type="heavy_top", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=185.0, progression_mode="load_first",
    )
    w, action, _ = recommend_next_session_load(
        exercise=_compound_bench(), planned_set=planned,
        last_session_sets=[
            {"reps": 8, "weight_lbs": 185.0},
            {"reps": 7, "weight_lbs": 185.0},
            {"reps": 6, "weight_lbs": 185.0},
        ],
    )
    assert action == "hold_load"
    assert w == 185.0
    _ok("partial → hold")


# ─── Runner ──────────────────────────────────────────────────────────────────

def _run_all() -> int:
    tests = [
        test_load_increment_lower_body_barbell_compound,
        test_load_increment_upper_body_barbell_compound,
        test_load_increment_dumbbell_isolation,
        test_load_increment_bodyweight_is_zero,
        test_round_to_increment_rounds_to_nearest,
        test_parse_rep_range_variants,
        test_strength_primary_compound_gets_heavy_top_then_backoff,
        test_muscle_gain_primary_compound_scheme,
        test_isolation_always_volume,
        test_beginner_gets_simplified_scheme,
        test_timed_scheme_emits_null_loads,
        test_beat_top_with_rir_on_load_first_adds_increment,
        test_beat_top_with_rir_on_reps_first_holds_load,
        test_hit_range_holds_load,
        test_missed_range_at_failure_drops_load,
        test_missed_range_without_failure_holds_load,
        test_next_session_all_sets_at_top_adds_load,
        test_next_session_majority_missed_drops_load,
        test_next_session_partial_holds,
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
            import traceback
            traceback.print_exc()
            failed_detail = f"{type(e).__name__}: {e}"
            print(f"  ✗ {t.__name__} ({failed_detail})")
    print()
    print(f"{len(tests) - failed}/{len(tests)} passed" if failed == 0 else f"{failed} FAILED")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
