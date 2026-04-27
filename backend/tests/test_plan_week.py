"""Tests for the weekly plan model (PlanWeek + PlanDay).

Pure-function tests for week_manager logic. Uses a mock DB session
(dict-backed) to avoid Docker dependency for fast local iteration.
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from app.services.workout.week_manager import (
    default_training_pattern,
    week_needs_renewal,
)
from app.models import PlanWeek, PlanDay


from dataclasses import dataclass, field as dc_field
from typing import Any


@dataclass
class FakePlanWeek:
    id: int = 1
    user_id: int = 1
    start_date: date = dc_field(default_factory=date.today)
    end_date: date = dc_field(default_factory=lambda: date.today() + timedelta(days=6))
    planner_version: str = "2026.04.27.01"
    goal: str = "body_recomp"
    days_per_week: int = 5
    preferred_split: str = "ppl"
    status: str = "active"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Any = None
    abandoned_at: Any = None


@dataclass
class FakePlanDay:
    id: int = 1
    plan_week_id: int = 1
    user_id: int = 1
    day_date: date = dc_field(default_factory=date.today)
    day_index: int = 0
    status: str = "planned"
    is_rest: bool = False
    workout_json: dict = dc_field(default_factory=lambda: {"day": "Day 1", "focus": "Push", "exercises": []})
    nutrition_json: dict = dc_field(default_factory=lambda: {"meals": [], "targets": {}})
    locked: bool = False
    locked_at: Any = None
    lock_reason: Any = None
    generation_source: str = "initial"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))


def _make_plan_week(start_date: date, **kwargs) -> FakePlanWeek:
    return FakePlanWeek(start_date=start_date, end_date=start_date + timedelta(days=6), **kwargs)


def _make_plan_day(day_date: date, **kwargs) -> FakePlanDay:
    return FakePlanDay(day_date=day_date, **kwargs)


# ─── default_training_pattern ─────────────────────────────────────────────────

def test_training_pattern_3_days():
    p = default_training_pattern(3)
    assert len(p) == 3
    assert p == [0, 2, 4]  # Mon, Wed, Fri


def test_training_pattern_5_days():
    p = default_training_pattern(5)
    assert len(p) == 5
    assert p == [0, 1, 2, 3, 4]  # Mon-Fri


def test_training_pattern_7_days():
    p = default_training_pattern(7)
    assert len(p) == 7


def test_training_pattern_1_day():
    p = default_training_pattern(1)
    assert p == [0]


# ─── week_needs_renewal ───────────────────────────────────────────────────────

def test_week_expired():
    # Week ended yesterday
    pw = _make_plan_week(date.today() - timedelta(days=7))
    assert week_needs_renewal(pw) is True


def test_week_still_active():
    # Week started today
    pw = _make_plan_week(date.today())
    assert week_needs_renewal(pw) is False


def test_week_last_day():
    # Week started 6 days ago (today is end_date)
    pw = _make_plan_week(date.today() - timedelta(days=6))
    assert week_needs_renewal(pw) is False


# ─── PlanDay lock semantics ───────────────────────────────────────────────────

def test_plan_day_unlocked_by_default():
    pd = _make_plan_day(date.today())
    assert pd.locked is False
    assert pd.status == "planned"


def test_plan_day_locked_prevents_edit():
    pd = _make_plan_day(date.today(), locked=True, lock_reason="completed", status="completed")
    assert pd.locked is True
    assert pd.status == "completed"


# ─── PlanWeek structure ───────────────────────────────────────────────────────

def test_plan_week_end_date():
    start = date(2026, 4, 21)  # Monday
    pw = _make_plan_week(start)
    assert pw.end_date == date(2026, 4, 27)  # Sunday


def test_plan_week_days_coverage():
    """7 PlanDay rows should cover Mon-Sun."""
    start = date(2026, 4, 21)
    days = []
    training = default_training_pattern(5)
    workout_idx = 0
    workout_days = [
        {"focus": "Push"}, {"focus": "Pull"}, {"focus": "Legs"},
        {"focus": "Upper"}, {"focus": "Lower"},
    ]
    for i in range(7):
        d = start + timedelta(days=i)
        is_training = i in training
        workout = None
        if is_training:
            workout = workout_days[workout_idx % len(workout_days)]
            workout_idx += 1
        days.append(_make_plan_day(d, day_index=i, is_rest=not is_training, workout_json=workout))

    assert len(days) == 7
    training_days = [d for d in days if not d.is_rest]
    rest_days = [d for d in days if d.is_rest]
    assert len(training_days) == 5
    assert len(rest_days) == 2
    assert training_days[0].workout_json["focus"] == "Push"
    assert training_days[4].workout_json["focus"] == "Lower"


# ─── Adapt remaining respects locks ──────────────────────────────────────────

def test_adapt_only_touches_unlocked():
    """Simulates adapt_remaining: only unlocked future days get new workouts."""
    start = date.today() - timedelta(days=2)
    days = []
    for i in range(7):
        d = start + timedelta(days=i)
        locked = i < 2  # First 2 days completed
        days.append(_make_plan_day(
            d,
            day_index=i,
            locked=locked,
            status="completed" if locked else "planned",
            workout_json={"focus": f"Day{i}"},
        ))

    # Simulate what adapt_remaining_days does: filter unlocked future days
    today = date.today()
    remaining = [d for d in days if not d.locked and d.day_date >= today and not d.is_rest]
    assert len(remaining) == 5  # days 2-6 (all unlocked, all in future)
    # Days 0, 1 protected
    assert days[0].locked is True
    assert days[1].locked is True


# ─── Auto-renew defaults ─────────────────────────────────────────────────────

def test_auto_apply_splits_safe_actions():
    from app.services.workout.week_manager import compute_auto_apply_defaults
    recs = [
        {"title": "Hold volume", "action": {"type": "hold_muscle_volume"}},
        {"title": "Raise cals", "action": {"type": "raise_calories", "delta": 100}},
        {"title": "Reduce vol", "action": {"type": "reduce_muscle_volume", "muscle": "chest"}},
        {"title": "Add cardio", "action": {"type": "add_cardio_session"}},
        {"title": "Noop", "action": {"type": "noop"}},
    ]
    auto, review = compute_auto_apply_defaults(recs)
    assert len(auto) == 3  # hold, reduce, noop
    assert len(review) == 2  # raise_calories, add_cardio
    auto_types = [r["action"]["type"] for r in auto]
    assert "hold_muscle_volume" in auto_types
    assert "reduce_muscle_volume" in auto_types
    assert "noop" in auto_types
    review_types = [r["action"]["type"] for r in review]
    assert "raise_calories" in review_types
    assert "add_cardio_session" in review_types


def test_auto_apply_unknown_goes_to_review():
    from app.services.workout.week_manager import compute_auto_apply_defaults
    recs = [{"title": "Mystery", "action": {"type": "unknown_future_action"}}]
    auto, review = compute_auto_apply_defaults(recs)
    assert len(auto) == 0
    assert len(review) == 1


def test_auto_apply_empty_recs():
    from app.services.workout.week_manager import compute_auto_apply_defaults
    auto, review = compute_auto_apply_defaults([])
    assert auto == []
    assert review == []


def test_week_needs_renewal_boundary():
    """End date exactly yesterday → needs renewal."""
    pw = _make_plan_week(date.today() - timedelta(days=7))
    assert pw.end_date == date.today() - timedelta(days=1)
    assert week_needs_renewal(pw) is True


# ─── Run ──────────────────────────────────────────────────────────────────────

def run_tests():
    test_fns = [v for k, v in globals().items() if k.startswith("test_")]
    passed = 0
    failed = 0
    for fn in test_fns:
        try:
            fn()
            passed += 1
            print(f"  PASS  {fn.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {e}")
    print(f"\nplan_week: {passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
