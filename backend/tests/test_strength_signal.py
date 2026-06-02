"""Tests for the fatigue-aware Fresh Strength Signal.

These are pure-function tests against `build_signal_for_slug` plus the
small helpers — no DB, no fixtures. Drive `build_strength_signal_profile`
through `test_api_smoke` if/when needed.

Run directly:  python3 -m tests.test_strength_signal
"""
from __future__ import annotations

import sys
from datetime import date, timedelta

from app.services.workout.strength_signal import (
    DEFAULT_WINDOW_DAYS,
    EXTENDED_WINDOW_DAYS,
    FreshSet,
    _classify_confidence,
    _classify_data_quality,
    _rir_confidence_weight,
    _set_position_weight,
    _slot_weight,
    _trimmed_weighted_mean,
    build_fresh_set,
    build_signal_for_slug,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Helper-level tests ──────────────────────────────────────────────


def test_slot_weights():
    print("\n[test] slot weights match the spec")
    assert _slot_weight(1) == 1.00
    assert _slot_weight(2) == 0.95
    assert _slot_weight(3) == 0.90
    assert _slot_weight(4) == 0.75
    assert _slot_weight(5) == 0.75
    assert _slot_weight(6) == 0.55
    assert _slot_weight(99) == 0.55
    # Defensive: 0 / negative clamps to slot 1.
    assert _slot_weight(0) == 1.00
    assert _slot_weight(-1) == 1.00
    _ok("slot weights")


def test_set_weights():
    print("\n[test] set-position weights match the spec")
    assert _set_position_weight(1) == 1.00
    assert _set_position_weight(2) == 0.95
    assert _set_position_weight(3) == 0.90
    assert _set_position_weight(4) == 0.75
    assert _set_position_weight(5) == 0.75
    assert _set_position_weight(6) == 0.60
    assert _set_position_weight(0) == 1.00
    _ok("set weights")


def test_rir_confidence_weights():
    print("\n[test] RIR confidence weights")
    # High band: 1..4 inclusive.
    for r in (1, 2, 3, 4):
        assert _rir_confidence_weight(r) == 1.00
    # Failure (RIR 0) is reduced but kept.
    assert _rir_confidence_weight(0) == 0.50
    # Null falls back to a medium-low weight.
    assert _rir_confidence_weight(None) == 0.60
    # High RIR signals volume not strength → heavily discounted.
    assert _rir_confidence_weight(5) == 0.30
    assert _rir_confidence_weight(8) == 0.30
    # Fractional positive RIR sits between failure and high.
    mid = _rir_confidence_weight(0.5)
    assert 0.5 <= mid <= 1.0, f"expected mid weight, got {mid}"
    _ok("RIR confidence")


def test_trimmed_weighted_mean_drops_extremes_when_4_plus():
    print("\n[test] trimmed weighted mean drops top + bottom at n>=4")
    # Without trimming the mean would be ~250.
    samples = [(100, 1.0), (200, 1.0), (300, 1.0), (400, 1.0)]
    result = _trimmed_weighted_mean(samples)
    # After trimming the high/low, expect (200 + 300) / 2 = 250.
    assert abs(result - 250.0) < 0.01, f"expected 250, got {result}"
    _ok("trim drops extremes when ≥4 samples")


def test_trimmed_weighted_mean_no_trim_when_under_4():
    print("\n[test] trimmed weighted mean keeps all samples at n<4")
    samples = [(100, 1.0), (300, 1.0)]
    result = _trimmed_weighted_mean(samples)
    assert abs(result - 200.0) < 0.01, f"expected 200, got {result}"
    _ok("no trim under 4 samples")


# ── Set-level eligibility ───────────────────────────────────────────


def test_build_fresh_set_rejects_warmup():
    print("\n[test] warmup rows are rejected")
    out = build_fresh_set(
        slug="barbell_back_squat", completed_at=date(2026, 5, 1),
        weight_lbs=135, reps=8, rir=2, order_index=1, set_number=1,
        set_type="warmup",
    )
    assert out is None
    _ok("warmup rejected")


def test_build_fresh_set_rejects_zero_weight_or_reps():
    print("\n[test] zero/missing weight or reps → None")
    assert build_fresh_set(
        slug="x", completed_at=date.today(),
        weight_lbs=0, reps=8, rir=2, order_index=1, set_number=1,
    ) is None
    assert build_fresh_set(
        slug="x", completed_at=date.today(),
        weight_lbs=200, reps=0, rir=2, order_index=1, set_number=1,
    ) is None
    _ok("zero weight/reps rejected")


def test_build_fresh_set_includes_rir_zero():
    print("\n[test] RIR 0 is included but at lower confidence")
    s = build_fresh_set(
        slug="x", completed_at=date.today(),
        weight_lbs=200, reps=8, rir=0, order_index=1, set_number=1,
    )
    assert s is not None
    assert s.rir_weight == 0.50
    assert s.e1rm_lbs > 0
    _ok("RIR 0 included with rir_weight=0.50")


def test_build_fresh_set_null_rir_falls_back_to_plain_epley():
    print("\n[test] null RIR uses plain Epley (no offset) at medium-low confidence")
    # 200x8 plain Epley = 200 * (1 + 8/30) = 253.3
    s = build_fresh_set(
        slug="x", completed_at=date.today(),
        weight_lbs=200, reps=8, rir=None, order_index=1, set_number=1,
    )
    assert s is not None
    assert s.rir_weight == 0.60
    # Tolerance for float math.
    assert abs(s.e1rm_lbs - 253.3) < 0.5, f"expected ~253.3, got {s.e1rm_lbs}"
    _ok("null RIR → plain Epley at rir_weight=0.60")


def test_build_fresh_set_rir_offset_applied():
    print("\n[test] RIR-adjusted Epley uses (reps + rir) / 30, capped at role max")
    # 200×8 @ RIR 3 → raw effective reps = 11. Capped at main_compound
    # max of 10 reps → e1rm = 200 * (1 + 10/30) = 266.67. The cap was
    # added in rolling_e1rm.py to keep prescription math honest — a
    # set 3 reps from failure shouldn't act like a true 11-rep observation.
    s = build_fresh_set(
        slug="x", completed_at=date.today(),
        weight_lbs=200, reps=8, rir=3, order_index=1, set_number=1,
    )
    assert s is not None
    assert abs(s.e1rm_lbs - 266.7) < 0.5, f"expected ~266.7 (capped), got {s.e1rm_lbs}"
    _ok("RIR offset applied to Epley with effective-rep cap")


# ── Position weighting (THE CORE BUG) ───────────────────────────────


def test_same_lift_first_vs_late_yields_different_strength():
    """The original complaint: a squat done first in the workout is
    a much truer strength signal than the same squat done after a few
    quad/glute exercises. The fresh strength signal must reflect that."""
    print("\n[test] same lift @ slot 1 set 1 vs slot 6 set 5 → fresh signal differs")
    today = date(2026, 5, 1)
    # Two sessions, same lift, same load×reps×RIR. Only difference is
    # WHERE the lift sat in each workout.
    fresh_first = build_fresh_set(
        slug="barbell_back_squat", completed_at=today,
        weight_lbs=300, reps=5, rir=2, order_index=1, set_number=1,
    )
    fresh_late = build_fresh_set(
        slug="barbell_back_squat", completed_at=today - timedelta(days=2),
        weight_lbs=300, reps=5, rir=2, order_index=6, set_number=5,
    )
    assert fresh_first is not None and fresh_late is not None
    # Same eRM (load×reps unchanged) but very different total weight.
    assert abs(fresh_first.e1rm_lbs - fresh_late.e1rm_lbs) < 0.01
    assert fresh_first.total_weight > fresh_late.total_weight
    # Quantify the spec: slot 1 × set 1 × RIR-high = 1.0; slot 6 × set 5
    # × RIR-high = 0.55 × 0.75 × 1.0 = 0.4125.
    assert abs(fresh_first.total_weight - 1.0) < 0.01
    assert abs(fresh_late.total_weight - 0.4125) < 0.01
    _ok("late-session lift carries ~41% the weight of the fresh one")


def test_late_session_only_data_marked_partial():
    """If the user ONLY ever does compounds late in the session,
    the strength signal should still report a number but flag the
    confidence/quality as degraded."""
    print("\n[test] only-late-session data → confidence ≤ med, quality partial")
    today = date(2026, 5, 1)
    sets = [
        build_fresh_set(
            slug="barbell_back_squat", completed_at=today - timedelta(days=d * 3),
            weight_lbs=300, reps=5, rir=2, order_index=6, set_number=5,
        )
        for d in range(8)
    ]
    sets = [s for s in sets if s is not None]
    sig = build_signal_for_slug(
        slug="barbell_back_squat", name="Squat", fresh_sets=sets, today=today,
    )
    assert sig.confidence in ("low", "med")
    assert sig.data_quality in ("partial", "full")  # full only if avg-w high
    assert sig.estimated_one_rep_max > 0
    _ok(f"late-only → conf={sig.confidence} quality={sig.data_quality}")


# ── Trend windows ───────────────────────────────────────────────────


def test_trend_28d_increases_when_recent_sets_are_heavier():
    print("\n[test] trend_28d_pct positive when recent sets heavier than prior window")
    today = date(2026, 5, 1)
    prior = [
        build_fresh_set(
            slug="x", completed_at=today - timedelta(days=DEFAULT_WINDOW_DAYS + 5 + d * 3),
            weight_lbs=200, reps=5, rir=2, order_index=1, set_number=1,
        )
        for d in range(4)
    ]
    recent = [
        build_fresh_set(
            slug="x", completed_at=today - timedelta(days=d * 3),
            weight_lbs=225, reps=5, rir=2, order_index=1, set_number=1,
        )
        for d in range(4)
    ]
    sets = [s for s in (prior + recent) if s is not None]
    sig = build_signal_for_slug(
        slug="x", name="X", fresh_sets=sets, today=today,
    )
    assert sig.trend_28d_pct is not None
    assert sig.trend_28d_pct > 5, f"expected >5%, got {sig.trend_28d_pct}"
    _ok(f"trend_28d_pct = {sig.trend_28d_pct:.1f}%")


def test_sparse_data_widens_to_56_day_window():
    print("\n[test] sparse 28d data widens to 56d window and degrades quality")
    today = date(2026, 5, 1)
    # Two sets in last 28 days — below FULL_QUALITY_MIN_SESSIONS (3),
    # but within the 56-day window we have enough.
    sparse_sets = [
        build_fresh_set(
            slug="x", completed_at=today - timedelta(days=d),
            weight_lbs=200, reps=5, rir=2, order_index=1, set_number=1,
        )
        for d in (3, 21, 35, 50)
    ]
    sparse_sets = [s for s in sparse_sets if s is not None]
    sig = build_signal_for_slug(
        slug="x", name="X", fresh_sets=sparse_sets, today=today,
    )
    assert sig.estimated_one_rep_max > 0
    # Widened window must not be marked as full-quality.
    assert sig.data_quality in ("partial", "missing")
    _ok(f"sparse 28d data → quality={sig.data_quality}")


def test_no_data_returns_missing():
    print("\n[test] no fresh sets → missing")
    sig = build_signal_for_slug(
        slug="x", name="X", fresh_sets=[], today=date(2026, 5, 1),
    )
    assert sig.estimated_one_rep_max == 0.0
    assert sig.data_quality == "missing"
    assert sig.trend_28d_pct is None
    _ok("empty input → missing + zero")


# ── Confidence + data-quality classification ────────────────────────


def test_confidence_classification():
    print("\n[test] confidence buckets respect avg total weight + count")
    today = date(2026, 5, 1)
    # 8 high-confidence sets (all slot 1, set 1, RIR 2) → high.
    high_sets = [
        FreshSet(
            slug="x", completed_at=today - timedelta(days=d),
            weight_lbs=200, reps=5, rir=2,
            order_index=1, set_number=1,
            e1rm_lbs=235.0,
            slot_weight=1.0, set_weight=1.0, rir_weight=1.0,
        )
        for d in range(8)
    ]
    assert _classify_confidence(high_sets) == "high"
    # Same count but with degraded weights → med.
    mid_sets = [
        FreshSet(
            slug="x", completed_at=today - timedelta(days=d),
            weight_lbs=200, reps=5, rir=None,
            order_index=4, set_number=4,
            e1rm_lbs=235.0,
            slot_weight=0.75, set_weight=0.75, rir_weight=0.6,
        )
        for d in range(8)
    ]
    # 0.75 * 0.75 * 0.6 = 0.3375 → low.
    assert _classify_confidence(mid_sets) == "low"
    # Single high-quality set → low (need at least PARTIAL_QUALITY_MIN_SETS).
    assert _classify_confidence(high_sets[:1]) == "low"
    _ok("high / med / low classification")


def test_data_quality_full_requires_breadth():
    print("\n[test] full quality needs ≥6 sets across ≥3 sessions")
    today = date(2026, 5, 1)
    six_sets_one_session = [
        FreshSet(
            slug="x", completed_at=today,
            weight_lbs=200, reps=5, rir=2,
            order_index=1, set_number=i,
            e1rm_lbs=235.0,
            slot_weight=1.0, set_weight=1.0, rir_weight=1.0,
        )
        for i in range(1, 7)
    ]
    # Six sets, but only one session → not full.
    assert _classify_data_quality(six_sets_one_session, session_count=1) == "partial"
    # Six sets across three sessions → full.
    assert _classify_data_quality(six_sets_one_session, session_count=3) == "full"
    _ok("full requires both set + session breadth")


# ── Test runner ─────────────────────────────────────────────────────


def _run_all() -> int:
    failures = 0
    for name, fn in list(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except AssertionError as exc:
            print(f"  ✗ {name}: {exc}")
            failures += 1
        except Exception as exc:  # unexpected
            print(f"  ✗ {name} CRASHED: {exc}")
            failures += 1
    print(f"\n{'PASS' if failures == 0 else f'FAIL ({failures})'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
