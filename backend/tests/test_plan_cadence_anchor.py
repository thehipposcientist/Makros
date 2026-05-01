"""Tests for the plan_cadence_anchor helper.

The anchor is the user's "sign-up day-of-week" — set once on first
PlanWeek creation and used by `auto_renew_week` to keep every future
week dated on the same day-of-week. This file tests the pure helper
`next_plan_week_start(anchor, today)` since the cadence math itself is
the load-bearing logic.

Pure function tests — no DB, no fixtures.
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from datetime import date, timedelta
from app.services.workout.week_manager import next_plan_week_start


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_anchor_is_returned_when_today_equals_anchor() -> None:
    """User's first day — week should start on the anchor itself."""
    print("\n[test] anchor == today returns anchor")
    anchor = date(2026, 4, 11)  # Friday
    assert next_plan_week_start(anchor, today=anchor) == anchor
    _ok("returns anchor verbatim on day 0")


def test_within_first_week_returns_anchor() -> None:
    """Days 1-6 after anchor still inside week 1 — start_date stays anchored."""
    print("\n[test] mid-week (days 1-6 after anchor) returns anchor")
    anchor = date(2026, 4, 11)  # Friday
    for offset in range(7):
        today = anchor + timedelta(days=offset)
        assert next_plan_week_start(anchor, today=today) == anchor, (
            f"day +{offset}: expected {anchor}, got {next_plan_week_start(anchor, today=today)}"
        )
    _ok("days 0-6 all map to the anchor")


def test_day_seven_advances_one_week() -> None:
    """Exactly 7 days later — start a fresh week dated anchor + 7."""
    print("\n[test] day +7 advances one cycle")
    anchor = date(2026, 4, 11)  # Friday
    today = anchor + timedelta(days=7)  # next Friday
    assert next_plan_week_start(anchor, today=today) == anchor + timedelta(days=7)
    _ok("anchor + 7 → next cycle start")


def test_long_absence_advances_to_correct_cycle() -> None:
    """User skips weeks — should land on the 7-day boundary that contains today."""
    print("\n[test] long absence lands on correct cycle boundary")
    anchor = date(2026, 4, 11)  # Friday
    # 19 days after sign-up (mid-cycle of what would be week 3).
    # Week 1: Apr 11-17, Week 2: Apr 18-24, Week 3: Apr 25-May 1.
    today = anchor + timedelta(days=19)  # Apr 30
    assert next_plan_week_start(anchor, today=today) == date(2026, 4, 25)
    _ok("19 days out → week 3 (Apr 25)")


def test_cadence_preserves_day_of_week_for_a_year() -> None:
    """Spot-check: the start_date weekday is always the anchor's weekday."""
    print("\n[test] every cycle start lands on the anchor's weekday")
    anchor = date(2026, 4, 11)  # Friday (weekday=4)
    for week_offset in range(0, 53):
        today = anchor + timedelta(days=week_offset * 7)
        result = next_plan_week_start(anchor, today=today)
        assert result.weekday() == anchor.weekday(), (
            f"week +{week_offset}: {result} is {result.strftime('%A')}, expected Friday"
        )
    _ok("52 cycles all land on Friday")


def test_clock_skew_today_before_anchor_returns_anchor() -> None:
    """Defensive: if `today < anchor` somehow (clock skew, test data),
    return the anchor itself instead of a negative-week date."""
    print("\n[test] today before anchor returns anchor (defensive)")
    anchor = date(2026, 4, 11)
    weird_today = date(2026, 4, 5)  # 6 days BEFORE anchor
    assert next_plan_week_start(anchor, today=weird_today) == anchor
    _ok("clock-skew case returns anchor verbatim")


def test_next_plan_week_start_is_pure() -> None:
    """Same inputs → same outputs. Function takes only date args."""
    print("\n[test] helper is referentially transparent")
    anchor = date(2026, 4, 11)
    today = date(2026, 4, 25)
    a = next_plan_week_start(anchor, today=today)
    b = next_plan_week_start(anchor, today=today)
    assert a == b
    _ok("idempotent on repeated calls")


def run_all() -> None:
    test_anchor_is_returned_when_today_equals_anchor()
    test_within_first_week_returns_anchor()
    test_day_seven_advances_one_week()
    test_long_absence_advances_to_correct_cycle()
    test_cadence_preserves_day_of_week_for_a_year()
    test_clock_skew_today_before_anchor_returns_anchor()
    test_next_plan_week_start_is_pure()
    print("\n[plan_cadence_anchor] all passed")


if __name__ == "__main__":
    run_all()
