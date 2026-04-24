"""Pure-function tests for rolling_e1rm.

Lock down: weighted-median behaviour, recency decay, role-aware rep
filtering, and the <3 sample fallback.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_rolling_e1rm
"""
from __future__ import annotations

from datetime import date, timedelta

from app.services.workout.rolling_e1rm import (
    UsableSet, compute_rolling_e1rm,
)


def make_set(*, days_ago: int, w: float, reps: int, rir: float | None,
             role_compat: str = "primary"):
    """Build a UsableSet at `days_ago` days back."""
    completed = date.today() - timedelta(days=days_ago)
    return UsableSet(
        completed_at=completed,
        actual_weight_lbs=w,
        actual_reps=reps,
        actual_rir=rir,
        target_rir=2.0,
        set_type="working",
    )


def assert_close(actual, expected, tol, label):
    assert abs(actual - expected) <= tol, f"{label}: got {actual}, expected {expected}±{tol}"
    print(f"  ✓ {label}")


def test_returns_none_under_3():
    print("[test] returns None with <3 usable sets")
    out = compute_rolling_e1rm([
        make_set(days_ago=1, w=185, reps=8, rir=2.0),
        make_set(days_ago=3, w=185, reps=7, rir=2.0),
    ])
    assert out is None, f"expected None, got {out}"
    print("  ✓ 2 sets → None")


def test_basic_estimate():
    print("[test] basic e1RM estimate (Epley with RIR)")
    # 185 × 8 reps with 2 RIR → reps_to_failure = 10 → e1rm = 185 * (1 + 10/30) = ~246.7
    sets = [
        make_set(days_ago=1, w=185, reps=8, rir=2.0),
        make_set(days_ago=3, w=185, reps=8, rir=2.0),
        make_set(days_ago=5, w=185, reps=8, rir=2.0),
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    expected = 185 * (1 + 10 / 30.0)
    assert_close(out.e1rm_lbs, expected, 1.0, f"3 identical sets → {expected:.1f}")


def test_recency_weighting():
    print("[test] recency: 3 recent heavy sets dominate 1 stale light set")
    # 3 recent 225-lb sets vs 1 stale 30-day-old 185-lb set. Weighted
    # median should land on the recent value: stale set's weight at
    # 30 days with 14-day half-life is exp(-30*ln(2)/14) ≈ 0.23, while
    # 3 recent sets carry weight ~1.0 each → recent dominates.
    sets = [
        make_set(days_ago=0,  w=225, reps=8, rir=2.0),
        make_set(days_ago=2,  w=225, reps=8, rir=2.0),
        make_set(days_ago=4,  w=225, reps=8, rir=2.0),
        make_set(days_ago=30, w=185, reps=8, rir=2.0),  # stale
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    expected = 225 * (1 + 10 / 30.0)
    assert_close(out.e1rm_lbs, expected, 1.0, "recent dominates stale")


def test_filters_warmups():
    print("[test] warmup sets are excluded")
    sets = [
        make_set(days_ago=1, w=185, reps=8, rir=2.0),
        make_set(days_ago=2, w=185, reps=8, rir=2.0),
        make_set(days_ago=3, w=185, reps=8, rir=2.0),
        UsableSet(completed_at=date.today(), actual_weight_lbs=95, actual_reps=10,
                  actual_rir=4.0, target_rir=4.0, set_type="warmup"),
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    expected = 185 * (1 + 10 / 30.0)
    assert_close(out.e1rm_lbs, expected, 1.0, "warmup ignored")


def test_role_aware_rep_band():
    print("[test] isolation role allows higher rep bands")
    # Compound role rejects 14-rep sets (band is 3-10).
    iso_set = make_set(days_ago=1, w=30, reps=14, rir=1.0)
    out_compound = compute_rolling_e1rm([iso_set, iso_set, iso_set], role="primary")
    assert out_compound is None, "compound role should reject 14-rep sets"
    print("  ✓ compound role rejects 14-rep")
    # Isolation role accepts (band is 6-15).
    out_iso = compute_rolling_e1rm([iso_set, iso_set, iso_set], role="isolation")
    assert out_iso is not None, "isolation role should accept 14-rep"
    print("  ✓ isolation role accepts 14-rep")


def test_rir_fallback_to_target():
    print("[test] missing actual_rir falls back to target_rir")
    sets = [
        UsableSet(completed_at=date.today(), actual_weight_lbs=185, actual_reps=8,
                  actual_rir=None, target_rir=2.0, set_type="working"),
        UsableSet(completed_at=date.today(), actual_weight_lbs=185, actual_reps=8,
                  actual_rir=None, target_rir=2.0, set_type="working"),
        UsableSet(completed_at=date.today(), actual_weight_lbs=185, actual_reps=8,
                  actual_rir=None, target_rir=2.0, set_type="working"),
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None, "fallback should produce an estimate"
    print("  ✓ target_rir fallback produces estimate")


def test_confidence_tiers():
    print("[test] confidence tier from sample count + spread")
    # Many samples, tight spread → high confidence.
    tight = [make_set(days_ago=i, w=185, reps=8, rir=2.0) for i in range(7)]
    out = compute_rolling_e1rm(tight)
    assert out is not None
    assert out.confidence == "high", f"expected high, got {out.confidence}"
    print(f"  ✓ tight: confidence={out.confidence}")
    # Few samples → low confidence regardless of spread.
    few = [make_set(days_ago=i, w=185, reps=8, rir=2.0) for i in range(3)]
    out = compute_rolling_e1rm(few)
    assert out is not None
    assert out.confidence in ("low", "med"), f"expected low/med, got {out.confidence}"
    print(f"  ✓ few samples: confidence={out.confidence}")


if __name__ == "__main__":
    test_returns_none_under_3()
    test_basic_estimate()
    test_recency_weighting()
    test_filters_warmups()
    test_role_aware_rep_band()
    test_rir_fallback_to_target()
    test_confidence_tiers()
    print("\n✅ test_rolling_e1rm.py PASSED")
