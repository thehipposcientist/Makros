"""Pure-function tests for manual-activity energy + zone estimation.

Covers:
  - estimate_cardio_zone_minutes: sums to duration, style/intensity shape
  - rpe_to_intensity_mult: anchors, clamps, None handling
  - session_rpe_from_details: extraction + validation
  - resolve_focus_fatigue: RPE overrides the coarse intensity string

Run:
    docker exec -it thallo-backend python -m tests.test_activity_energy
"""
from __future__ import annotations

from app.services.workout.activity_energy import estimate_cardio_zone_minutes
from app.services.workout.activity_impact import (
    resolve_focus_fatigue,
    rpe_to_intensity_mult,
    session_rpe_from_details,
)


# ─── estimate_cardio_zone_minutes ─────────────────────────────────────────────


def test_zone_minutes_sum_to_duration():
    """The zone breakdown sums exactly to the logged duration."""
    zones = estimate_cardio_zone_minutes(duration_seconds=45 * 60, cardio_style="steady")
    assert zones is not None
    assert sum(zones) == 45
    assert len(zones) == 5


def test_zone_minutes_short_session_none():
    """A session under a minute produces no zone breakdown."""
    assert estimate_cardio_zone_minutes(duration_seconds=30) is None
    assert estimate_cardio_zone_minutes(duration_seconds=0) is None
    assert estimate_cardio_zone_minutes(duration_seconds=None) is None


def test_zone_minutes_steady_is_zone2_dominant():
    """A steady cardio session lands mostly in Zone 2."""
    zones = estimate_cardio_zone_minutes(duration_seconds=60 * 60, cardio_style="steady")
    assert zones is not None
    assert zones.index(max(zones)) == 1  # Z2 is the dominant zone


def test_zone_minutes_intervals_shift_up():
    """Intervals put more minutes in Z3-Z5 than an easy session does."""
    easy = estimate_cardio_zone_minutes(duration_seconds=60 * 60, cardio_style="easy")
    intervals = estimate_cardio_zone_minutes(duration_seconds=60 * 60, cardio_style="intervals")
    assert easy is not None and intervals is not None
    assert sum(intervals[2:]) > sum(easy[2:])


def test_zone_minutes_intensity_fallback():
    """With no cardio style, intensity selects the profile."""
    easy = estimate_cardio_zone_minutes(duration_seconds=60 * 60, intensity="easy")
    hard = estimate_cardio_zone_minutes(duration_seconds=60 * 60, intensity="hard")
    assert easy is not None and hard is not None
    assert sum(hard[2:]) > sum(easy[2:])


# ─── rpe_to_intensity_mult ────────────────────────────────────────────────────


def test_rpe_mult_none_for_missing_or_invalid():
    """No RPE → None so callers fall back to the intensity string."""
    assert rpe_to_intensity_mult(None) is None
    assert rpe_to_intensity_mult(0) is None
    assert rpe_to_intensity_mult("not a number") is None


def test_rpe_mult_monotonic_and_clamped():
    """Higher RPE → higher multiplier, bounded to [0.4, 1.5]."""
    low = rpe_to_intensity_mult(2)
    mid = rpe_to_intensity_mult(6)
    high = rpe_to_intensity_mult(10)
    assert low is not None and mid is not None and high is not None
    assert low < mid < high
    assert 0.4 <= low and high <= 1.5


def test_rpe_mult_anchored_to_buckets():
    """RPE 6 reads close to the 'moderate' (1.0) bucket."""
    mult = rpe_to_intensity_mult(6)
    assert mult is not None
    assert 0.85 <= mult <= 1.05


# ─── session_rpe_from_details ─────────────────────────────────────────────────


def test_session_rpe_extracted():
    """sessionRpe is pulled out of the activity_details blob."""
    assert session_rpe_from_details({"sessionRpe": 8}) == 8.0
    assert session_rpe_from_details({"sessionRpe": "7.5"}) == 7.5


def test_session_rpe_rejects_bad_values():
    """Out-of-range / missing / malformed RPE → None."""
    assert session_rpe_from_details(None) is None
    assert session_rpe_from_details({}) is None
    assert session_rpe_from_details({"sessionRpe": 0}) is None
    assert session_rpe_from_details({"sessionRpe": 99}) is None
    assert session_rpe_from_details({"sessionRpe": "hard"}) is None


# ─── resolve_focus_fatigue with RPE ───────────────────────────────────────────


def test_rpe_overrides_intensity_string():
    """A high RPE produces more fatigue than a low RPE for the same focus,
    regardless of the coarse intensity string."""
    low_rpe = resolve_focus_fatigue("Run", intensity="hard", rpe=2)
    high_rpe = resolve_focus_fatigue("Run", intensity="easy", rpe=9)
    assert sum(high_rpe.values()) > sum(low_rpe.values())


def test_no_rpe_preserves_intensity_behavior():
    """Without RPE, fatigue still keys off the intensity string."""
    easy = resolve_focus_fatigue("Run", intensity="easy")
    hard = resolve_focus_fatigue("Run", intensity="hard")
    assert sum(hard.values()) > sum(easy.values())


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
    print(f"test_activity_energy: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    success = run_all()
    sys.exit(0 if success else 1)
