"""Pure-function tests for social digest helpers.

Tests the streak / week-bucketing math without touching the DB.

Run manually:
    docker exec -it thallo-backend python -m tests.test_social_digest
"""
from __future__ import annotations

from datetime import date, timedelta

from app.services.social.digest import (
    week_start_for, _streak_days, _last_active,
)


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def test_week_start_is_monday():
    print("[test] week_start_for returns Monday of the containing week")
    # 2026-04-26 is a Sunday → Monday is 2026-04-20.
    assert_eq(week_start_for(date(2026, 4, 26)), date(2026, 4, 20), "Sunday → prior Monday")
    assert_eq(week_start_for(date(2026, 4, 20)), date(2026, 4, 20), "Monday → self")
    assert_eq(week_start_for(date(2026, 4, 22)), date(2026, 4, 20), "Wednesday → Monday of week")


def test_streak_consecutive():
    print("[test] _streak_days counts back-to-back days ending today")
    today = date(2026, 4, 26)
    dates = {today, today - timedelta(days=1), today - timedelta(days=2)}
    assert_eq(_streak_days(dates, today), 3, "3-day streak")


def test_streak_tolerates_missed_today():
    print("[test] _streak_days starts from yesterday if today is missing")
    today = date(2026, 4, 26)
    dates = {today - timedelta(days=1), today - timedelta(days=2), today - timedelta(days=3)}
    assert_eq(_streak_days(dates, today), 3, "no today, 3 days before")


def test_streak_breaks_on_gap():
    print("[test] _streak_days breaks at first missing day")
    today = date(2026, 4, 26)
    # Today + yesterday, then a gap, then 5 more days.
    dates = {
        today, today - timedelta(days=1),
        today - timedelta(days=3),  # gap on day-2
        today - timedelta(days=4),
    }
    assert_eq(_streak_days(dates, today), 2, "stops at first gap")


def test_streak_empty():
    print("[test] _streak_days returns 0 for empty set")
    assert_eq(_streak_days(set(), date(2026, 4, 26)), 0, "no completions")


def test_last_active_picks_most_recent():
    print("[test] _last_active returns the most recent date <= today")
    today = date(2026, 4, 26)
    dates = {
        today - timedelta(days=5),
        today - timedelta(days=2),
        today - timedelta(days=10),
    }
    assert_eq(_last_active(dates, today), today - timedelta(days=2), "most recent")


def test_last_active_ignores_future():
    print("[test] _last_active ignores future dates")
    today = date(2026, 4, 26)
    dates = {today - timedelta(days=3), today + timedelta(days=2)}
    assert_eq(_last_active(dates, today), today - timedelta(days=3), "future ignored")


def test_canonical_pair_orders_smallest_first():
    print("[test] canonical_pair sorts user IDs ascending")
    from app.routers.social import _canonical_pair
    assert_eq(_canonical_pair(7, 3), (3, 7), "high, low → low, high")
    assert_eq(_canonical_pair(3, 7), (3, 7), "already ordered")
    assert_eq(_canonical_pair(5, 5), (5, 5), "self pair (degenerate but valid)")


if __name__ == "__main__":
    test_week_start_is_monday()
    test_streak_consecutive()
    test_streak_tolerates_missed_today()
    test_streak_breaks_on_gap()
    test_streak_empty()
    test_last_active_picks_most_recent()
    test_last_active_ignores_future()
    test_canonical_pair_orders_smallest_first()
    print("\n✅ test_social_digest.py PASSED")
