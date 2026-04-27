"""Phase 2 — three new health-signal flags in flags.py.

Covers:
  - flag_suppressed_hrv_7d:   7d HRV < 0.90× 30d baseline for ≥3 days
  - flag_elevated_respiratory_rate_7d: 7d avg RR >16/min from SleepLog
  - flag_erratic_hrv_7d:      coefficient of variation >30% over 7d HRV

Each test seeds a SQLite in-memory DB with the minimum data needed to
exercise the data-sufficiency gate AND the firing condition, then
inverts one parameter to verify the gate / threshold behaves correctly.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import DailyHealthSnapshot, SleepLog, User
from app.services.coach.flags import (
    flag_elevated_respiratory_rate_7d,
    flag_erratic_hrv_7d,
    flag_suppressed_hrv_7d,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_user(s: Session, user_id: int = 1) -> None:
    s.add(User(id=user_id, email=f"u{user_id}@t", username=f"u{user_id}", hashed_password="x"))
    s.commit()


def _seed_hrv_series(s: Session, user_id: int, as_of: date, values: list[float]) -> None:
    """Seed `values` as DailyHealthSnapshot.hrv_ms ending on `as_of` (newest)."""
    n = len(values)
    for i, v in enumerate(values):
        d = as_of - timedelta(days=(n - 1 - i))
        s.add(DailyHealthSnapshot(
            user_id=user_id, snapshot_date=d, hrv_ms=v,
        ))
    s.commit()


def _seed_rr_nights(s: Session, user_id: int, as_of: date, rr_values: list[float]) -> None:
    """Seed nightly SleepLog.respiratory_rate values ending on `as_of`."""
    n = len(rr_values)
    for i, v in enumerate(rr_values):
        d = as_of - timedelta(days=(n - 1 - i))
        s.add(SleepLog(
            user_id=user_id, night_date=d, respiratory_rate=v,
        ))
    s.commit()


# ─── #29  flag_suppressed_hrv_7d ──────────────────────────────────────────────

def test_suppressed_hrv_fires_when_7d_below_baseline():
    """30 days of healthy HRV (~70ms) followed by 7 days at ~55ms (78%)
    should fire med severity."""
    print("\n[test] suppressed_hrv: fires with sustained 7d suppression")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        # 30d baseline at 70 + 7d recent at 55 (with overlap on day 7-30 vs 0-6).
        # Build a 30-day series where the FIRST 23 days are baseline-high (70)
        # and the LAST 7 days are suppressed (55). The 7d window pulls just
        # the last 7; the 30d window pulls all 30.
        baseline_hrv = [70.0] * 23 + [55.0] * 7
        _seed_hrv_series(s, 1, as_of, baseline_hrv)

        result = flag_suppressed_hrv_7d(s, 1, as_of)
    assert result is not None, "expected a flag"
    assert result["severity"] in ("low", "med"), f"got severity {result['severity']}"
    assert result["details"]["suppressed_days"] >= 3
    _ok(f"fires with 7d suppressed below baseline: {result['value']}")


def test_suppressed_hrv_silent_when_baseline_thin():
    """<14 days of baseline data → silent (anti-noise gate)."""
    print("\n[test] suppressed_hrv: stays silent without enough baseline")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        # Only 10 days of data — below the 14-day baseline minimum.
        _seed_hrv_series(s, 1, as_of, [55.0] * 10)
        result = flag_suppressed_hrv_7d(s, 1, as_of)
    assert result is None, f"expected silent, got {result}"
    _ok("silent when baseline is too short")


def test_suppressed_hrv_silent_when_recent_matches_baseline():
    """Recent HRV at baseline → no flag."""
    print("\n[test] suppressed_hrv: silent when recent matches baseline")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_hrv_series(s, 1, as_of, [68.0] * 30)
        result = flag_suppressed_hrv_7d(s, 1, as_of)
    assert result is None, f"expected silent at baseline, got {result}"
    _ok("silent when 7d HRV matches baseline")


# ─── #33  flag_elevated_respiratory_rate_7d ──────────────────────────────────

def test_elevated_rr_low_severity_at_above_16():
    """Avg RR 17/min → low severity flag."""
    print("\n[test] elevated_rr: low severity above 16/min")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_rr_nights(s, 1, as_of, [17.0, 17.5, 16.8, 17.2, 17.0])
        result = flag_elevated_respiratory_rate_7d(s, 1, as_of)
    assert result is not None and result["severity"] == "low", result
    _ok(f"low severity at 17/min avg: {result['value']}")


def test_elevated_rr_med_severity_at_above_18():
    """Avg RR 19/min → med severity (clear systemic-stress signal)."""
    print("\n[test] elevated_rr: med severity above 18/min")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_rr_nights(s, 1, as_of, [19.0, 19.5, 18.8, 19.2, 18.5])
        result = flag_elevated_respiratory_rate_7d(s, 1, as_of)
    assert result is not None and result["severity"] == "med", result
    _ok(f"med severity at 19/min avg: {result['value']}")


def test_elevated_rr_silent_when_normal():
    """Avg RR 14/min → no flag."""
    print("\n[test] elevated_rr: silent at normal RR")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_rr_nights(s, 1, as_of, [14.0, 14.5, 13.8, 14.2, 14.0])
        result = flag_elevated_respiratory_rate_7d(s, 1, as_of)
    assert result is None, f"expected silent at 14/min, got {result}"
    _ok("silent at 14/min avg")


def test_elevated_rr_silent_with_too_few_nights():
    """<4 nights of RR → silent."""
    print("\n[test] elevated_rr: silent with too few nights")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_rr_nights(s, 1, as_of, [19.0, 19.5])  # only 2 nights
        result = flag_elevated_respiratory_rate_7d(s, 1, as_of)
    assert result is None, f"expected silent with 2 nights, got {result}"
    _ok("silent with too few nights of data")


# ─── #34  flag_erratic_hrv_7d (CV) ────────────────────────────────────────────

def test_erratic_hrv_fires_on_high_cv():
    """A wildly variable 7d HRV series (35→90→40→85 etc.) has CV > 30%."""
    print("\n[test] erratic_hrv: fires with high coefficient of variation")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_hrv_series(s, 1, as_of, [35.0, 90.0, 40.0, 85.0, 38.0, 88.0, 42.0])
        result = flag_erratic_hrv_7d(s, 1, as_of)
    assert result is not None, "expected an erratic flag"
    assert result["details"]["hrv_cv_pct"] > 30
    _ok(f"erratic flag fires: {result['value']}")


def test_erratic_hrv_silent_on_consistent_series():
    """Consistent HRV (low variance) → no flag."""
    print("\n[test] erratic_hrv: silent on consistent series")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_hrv_series(s, 1, as_of, [68.0, 70.0, 71.0, 69.0, 70.0, 72.0, 70.5])
        result = flag_erratic_hrv_7d(s, 1, as_of)
    assert result is None, f"expected silent on consistent HRV, got {result}"
    _ok("silent when HRV is stable day-to-day")


def test_erratic_hrv_silent_with_too_few_days():
    """<5 days → silent (data sufficiency gate)."""
    print("\n[test] erratic_hrv: silent with too few days")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        as_of = date.today()
        _seed_hrv_series(s, 1, as_of, [40.0, 80.0, 35.0])  # only 3 days
        result = flag_erratic_hrv_7d(s, 1, as_of)
    assert result is None, f"expected silent with 3 days, got {result}"
    _ok("silent when fewer than 5 HRV days available")


# ─── Registry sanity ──────────────────────────────────────────────────────────

def test_new_flags_registered():
    """All three new flags must appear in FLAG_REGISTRY so evaluate_flags
    actually evaluates them."""
    print("\n[test] flags: new entries registered in FLAG_REGISTRY")
    from app.services.coach.flags import FLAG_REGISTRY
    expected = {
        "suppressed_hrv_7d",
        "elevated_respiratory_rate_7d",
        "erratic_hrv_7d",
    }
    missing = expected - set(FLAG_REGISTRY)
    assert not missing, f"missing from registry: {missing}"
    _ok("all three new flags registered")


cases = [
    test_suppressed_hrv_fires_when_7d_below_baseline,
    test_suppressed_hrv_silent_when_baseline_thin,
    test_suppressed_hrv_silent_when_recent_matches_baseline,
    test_elevated_rr_low_severity_at_above_16,
    test_elevated_rr_med_severity_at_above_18,
    test_elevated_rr_silent_when_normal,
    test_elevated_rr_silent_with_too_few_nights,
    test_erratic_hrv_fires_on_high_cv,
    test_erratic_hrv_silent_on_consistent_series,
    test_erratic_hrv_silent_with_too_few_days,
    test_new_flags_registered,
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
