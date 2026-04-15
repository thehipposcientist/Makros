"""Tests for in_workout_review.py — suspicion detector + gate logic.

The AI call itself is mocked out (returning None), so these tests
only exercise the pure deterministic paths:
  - suspicion rules for every trigger
  - feel-required gate
  - deterministic passthrough when nothing is suspicious

Run directly:  python3 -m tests.test_in_workout_review
"""
from __future__ import annotations

import sys

from app.services.workout.in_workout_review import (
    ReviewedRecommendation,
    _feel_bucket,
    is_suspicious,
    reviewed_next_set_recommendation,
)
from app.services.workout.set_programming import (
    PlannedSet,
    recommend_next_set,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _bench():
    return {
        "name": "Barbell Bench Press",
        "slug": "barbell_bench_press",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "horizontal_press",
        "primary_muscle": "chest",
    }


def _planned(reps="6-8", target_w=185.0, mode="load_first"):
    return PlannedSet(
        set_number=1, set_type="heavy_top",
        target_reps=reps, target_rir=2.0,
        target_weight_lbs=target_w, progression_mode=mode,
    )


# ── _feel_bucket ────────────────────────────────────────────────────

def test_feel_bucket_normalization():
    print("\n[test] feel bucket normalization")
    assert _feel_bucket("easy") == "easy"
    assert _feel_bucket("good") == "good"
    assert _feel_bucket("hard") == "hard"
    assert _feel_bucket("grind") == "hard"
    assert _feel_bucket("failure") == "failure"
    assert _feel_bucket("form_breakdown") == "failure"
    assert _feel_bucket("pain") == "pain"
    assert _feel_bucket(None) is None
    assert _feel_bucket("mystery") is None
    _ok("all SetFeedback values bucket correctly")


# ── is_suspicious ───────────────────────────────────────────────────

def test_pain_always_suspicious():
    print("\n[test] feel=pain always triggers review")
    planned = _planned()
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=7, actual_weight_lbs=185.0, actual_rir=2.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=7, actual_weight_lbs=185.0,
        feel="pain", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert any("pain" in r for r in reasons)
    _ok(f"reasons: {reasons}")


def test_big_overshoot_flagged():
    print("\n[test] big overshoot (reps >= top+3) flagged")
    planned = _planned(reps="6-8")
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=12, actual_weight_lbs=185.0, actual_rir=2.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=12, actual_weight_lbs=185.0,
        feel="easy", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert any("big overshoot" in r for r in reasons)
    _ok("overshoot captured")


def test_big_undershoot_flagged():
    print("\n[test] big undershoot (reps <= bottom-2) flagged")
    planned = _planned(reps="6-8")
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=3, actual_weight_lbs=185.0, actual_rir=0.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=3, actual_weight_lbs=185.0,
        feel="failure", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert any("undershoot" in r for r in reasons)
    _ok("undershoot captured")


def test_feel_conflict_easy_but_missed():
    print("\n[test] feel=easy but missed range → suspicious")
    planned = _planned(reps="6-8")
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=4, actual_weight_lbs=185.0, actual_rir=2.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=4, actual_weight_lbs=185.0,
        feel="easy", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert any("feel=easy" in r for r in reasons)
    _ok("feel conflict captured")


def test_feel_conflict_hard_but_beat_top():
    print("\n[test] feel=hard but beat top → suspicious")
    planned = _planned(reps="6-8")
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=10, actual_weight_lbs=185.0, actual_rir=0.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=10, actual_weight_lbs=185.0,
        feel="hard", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert any("hard" in r for r in reasons)
    _ok("hard-but-beat-top captured")


def test_first_session_flagged():
    print("\n[test] first session (no history) flagged")
    planned = _planned()
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=7, actual_weight_lbs=185.0, actual_rir=2.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=7, actual_weight_lbs=185.0,
        feel="good", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert any("first session" in r for r in reasons)
    _ok("first-session flag present")


def test_deterministic_reduce_but_feel_easy_flagged():
    print("\n[test] deterministic says reduce but feel=easy → suspicious")
    planned = _planned(reps="6-8", target_w=200.0)
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=4, actual_weight_lbs=200.0, actual_rir=0.0,
    )
    # Override feel to easy for the suspicion rule
    reasons = is_suspicious(
        planned_set=planned, actual_reps=4, actual_weight_lbs=200.0,
        feel="easy", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert det.action == "reduce_load"
    assert any("reduce_load" in r for r in reasons)
    _ok("conflict captured")


def test_no_suspicion_happy_path():
    print("\n[test] routine set (feel=good, hit range, has history) → no suspicion")
    planned = _planned(reps="6-8")
    det = recommend_next_set(
        exercise=_bench(), planned_set=planned,
        actual_reps=7, actual_weight_lbs=185.0, actual_rir=2.0,
    )
    reasons = is_suspicious(
        planned_set=planned, actual_reps=7, actual_weight_lbs=185.0,
        feel="good",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0}],
        last_session_sets=[{"reps": 8, "weight_lbs": 180.0}],
        deterministic=det,
    )
    assert reasons == [], f"expected no reasons, got {reasons}"
    _ok("routine set → no suspicion")


# ── reviewed_next_set_recommendation gate ─────────────────────────

def test_require_feel_blocks_when_feel_missing():
    print("\n[test] require_feel=True returns None when feel missing")
    planned = _planned()
    result = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=planned,
        actual_reps=7, actual_weight_lbs=185.0, actual_rir=2.0,
        feel=None, require_feel=True,
    )
    assert result is None
    _ok("None returned — UI will hide rec card")


def test_non_suspicious_returns_deterministic_source():
    print("\n[test] non-suspicious set bypasses AI → source=deterministic")
    planned = _planned(reps="6-8")
    result = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=planned,
        actual_reps=7, actual_weight_lbs=185.0, actual_rir=2.0,
        feel="good",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0}],
        last_session_sets=[{"reps": 8, "weight_lbs": 180.0}],
        require_feel=True,
    )
    assert result is not None
    assert result.source == "deterministic"
    assert result.suspicion_reasons == []
    _ok(f"action={result.action} weight={result.next_set_weight_lbs}")


# ─── Runner ──────────────────────────────────────────────────────────────────

def _run_all() -> int:
    tests = [
        test_feel_bucket_normalization,
        test_pain_always_suspicious,
        test_big_overshoot_flagged,
        test_big_undershoot_flagged,
        test_feel_conflict_easy_but_missed,
        test_feel_conflict_hard_but_beat_top,
        test_first_session_flagged,
        test_deterministic_reduce_but_feel_easy_flagged,
        test_no_suspicion_happy_path,
        test_require_feel_blocks_when_feel_missing,
        test_non_suspicious_returns_deterministic_source,
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
