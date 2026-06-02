"""Unit tests for the streak service.

Pure-function — exercises `_streak_from_dates` directly. The DB-touching
`compute_streaks` is a thin wrapper; covering the algorithm here means
the SQL paths can be smoke-tested via the API test if needed.

Rules covered:
  * Empty signal → 0 / 0 / False.
  * Active streak ending today.
  * Active streak ending yesterday (today not yet logged) — still counts.
  * Single-day miss inside the streak ("freeze") doesn't reset.
  * Two consecutive misses break the streak.
  * Best streak observed within the scan window.
  * Best >= current always holds.
"""
from __future__ import annotations

from datetime import date, timedelta


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_empty_dates_zero_streak():
    print("\n[test] empty signal returns 0 / 0 / False")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    current, best, today_logged = _streak_from_dates(set(), today)
    assert (current, best, today_logged) == (0, 0, False)
    _ok("no signal → all zeros")


def test_perfect_streak_includes_today():
    print("\n[test] 7 days including today")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    dates = {today - timedelta(days=i) for i in range(7)}
    current, best, today_logged = _streak_from_dates(dates, today)
    assert current == 7
    assert best >= 7
    assert today_logged is True
    _ok("7 consecutive days from today counted correctly")


def test_streak_ending_yesterday_still_active():
    print("\n[test] streak ending yesterday counts as active")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    # User logged the prior 5 days but hasn't logged today yet — at 9am
    # we shouldn't already call their streak broken.
    dates = {today - timedelta(days=i) for i in range(1, 6)}
    current, best, today_logged = _streak_from_dates(dates, today)
    assert current == 5
    assert today_logged is False
    _ok("yesterday-anchored streak still active")


def test_single_miss_does_not_reset():
    print("\n[test] single missed day is forgiven (grace day)")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    # Logged today, yesterday, day -2 missing, day -3 / -4 / -5 logged.
    dates = {today, today - timedelta(days=1),
             today - timedelta(days=3), today - timedelta(days=4), today - timedelta(days=5)}
    current, best, _ = _streak_from_dates(dates, today)
    # Walk: today✓, -1✓, -2× (use grace), -3✓, -4✓, -5✓, -6× (break)
    assert current == 5, f"expected 5 (with 1 grace day), got {current}"
    assert best >= 5
    _ok("one missed day inside the streak is forgiven")


def test_two_consecutive_misses_breaks():
    print("\n[test] two consecutive misses break the streak")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    # today✓, -1✓, -2×, -3×, -4✓, -5✓
    dates = {today, today - timedelta(days=1),
             today - timedelta(days=4), today - timedelta(days=5)}
    current, _, _ = _streak_from_dates(dates, today)
    assert current == 2, f"expected 2 (broken at the double miss), got {current}"
    _ok("double miss breaks the streak")


def test_best_streak_within_window():
    print("\n[test] best streak observed within the scan window")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    # Best stretch was 10 days, 30 days ago. Current is 2.
    long_stretch = {today - timedelta(days=30 + i) for i in range(10)}
    current_stretch = {today, today - timedelta(days=1)}
    dates = long_stretch | current_stretch
    current, best, _ = _streak_from_dates(dates, today)
    assert current >= 2
    assert best >= 10, f"expected best >= 10, got {best}"
    _ok("historical best is preserved")


def test_best_is_always_at_least_current():
    print("\n[test] best >= current is invariant")
    from app.services.streaks import _streak_from_dates
    today = date(2026, 5, 28)
    for window in [3, 7, 14, 30]:
        dates = {today - timedelta(days=i) for i in range(window)}
        current, best, _ = _streak_from_dates(dates, today)
        assert best >= current, f"best ({best}) must be >= current ({current})"
    _ok("invariant holds across windows")


if __name__ == "__main__":
    cases = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print()
    if failures == 0:
        print(f"✓ All {len(cases)} tests passed.")
    else:
        print(f"✗ {failures}/{len(cases)} test(s) failed.")
    import sys
    sys.exit(1 if failures else 0)
