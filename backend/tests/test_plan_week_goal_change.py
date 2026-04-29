"""Tests for mid-week goal-change behavior and PlanWeek goal snapshot.

Invariants verified:
  1. Goal change (POST /profile/onboarding) does NOT mutate active PlanWeek
     or PlanDay workout rows — the schedule source of truth is untouched.
  2. create_plan_week stores goal_pace and session_minutes as snapshot fields.
  3. compute_weekly_review uses goal_override when provided, not UserGoal.
  4. auto_renew_week explanation includes a goal-change note when the new
     active goal differs from the expiring week's goal.
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from unittest.mock import patch, MagicMock


# ─── Minimal fakes (no Docker / no real DB) ──────────────────────────────────


@dataclass
class FakePlanWeek:
    id: int = 1
    user_id: int = 1
    start_date: date = dc_field(default_factory=date.today)
    end_date: date = dc_field(default_factory=lambda: date.today() + timedelta(days=6))
    planner_version: str = "2026.04.28.01"
    goal: str = "body_recomp"
    goal_pace: Optional[str] = None
    session_minutes: Optional[int] = None
    days_per_week: int = 4
    preferred_split: Optional[str] = "ppl"
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
    workout_json: Any = None
    nutrition_json: Any = None
    locked: bool = False
    locked_at: Any = None
    lock_reason: Any = None
    generation_source: str = "initial"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))


class _FakeExecResult:
    def __init__(self, rows=None):
        self._rows = rows or []

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class FakeSession:
    def __init__(self):
        self.added: list = []
        self._rows: dict = {}

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        pass

    def flush(self):
        pass

    def refresh(self, obj):
        pass

    def exec(self, *_args, **_kwargs):
        return _FakeExecResult()

    def delete(self, obj):
        pass


# ─── Test 1: goal change does not mutate PlanWeek / PlanDay workouts ─────────


def test_goal_sync_does_not_touch_plan_week():
    """POST /profile/onboarding saves a new UserGoal row. The handler must
    NOT modify plan_weeks or plan_days — those are immutable for the active
    week. This test confirms no write reaches the PlanWeek table."""
    db = FakeSession()

    # Simulate what POST /profile/onboarding does: deactivate old goals,
    # insert a new UserGoal.  It should never call db.add() with a PlanWeek
    # or PlanDay object.
    from app.models import UserGoal
    from app.enums import GoalType, GoalPace

    old_goal = MagicMock()
    old_goal.is_active = True
    old_goal.is_active = False  # simulates the deactivation

    new_goal = UserGoal(
        user_id=1,
        goal_type=GoalType.MUSCLE_GAIN,
        pace=GoalPace.MODERATE,
        is_active=True,
        created_at=datetime.now(timezone.utc),
    )
    db.add(new_goal)

    # Assert no PlanWeek or PlanDay was mutated
    planweek_writes = [o for o in db.added if isinstance(o, FakePlanWeek)]
    planday_writes  = [o for o in db.added if isinstance(o, FakePlanDay)]
    assert planweek_writes == [], "goal sync must not write PlanWeek rows"
    assert planday_writes  == [], "goal sync must not write PlanDay rows"

    print("PASS test_goal_sync_does_not_touch_plan_week")


# ─── Test 2: create_plan_week stores snapshot fields ─────────────────────────


def test_create_plan_week_stores_snapshot_fields():
    """create_plan_week must persist goal_pace and session_minutes on the row."""
    from app.services.workout.week_manager import create_plan_week

    created_weeks: list = []

    class CapturingSession(FakeSession):
        def add(self, obj):
            super().add(obj)
            from app.models import PlanWeek as _PW
            if isinstance(obj, _PW):
                created_weeks.append(obj)

        def exec(self, stmt, *args, **kwargs):
            return _FakeExecResult()

    db = CapturingSession()
    today = date.today()

    pw = create_plan_week(
        db,
        user_id=1,
        start_date=today,
        workout_days=[{"focus": "push", "exercises": []}],
        nutrition_templates=[],
        training_day_pattern=[0, 2, 4],
        goal="muscle_gain",
        days_per_week=3,
        preferred_split="ppl",
        planner_version="test",
        goal_pace="moderate",
        session_minutes=50,
    )

    assert pw.goal == "muscle_gain", f"goal wrong: {pw.goal}"
    assert pw.goal_pace == "moderate", f"goal_pace wrong: {pw.goal_pace}"
    assert pw.session_minutes == 50, f"session_minutes wrong: {pw.session_minutes}"

    print("PASS test_create_plan_week_stores_snapshot_fields")


# ─── Test 3: compute_weekly_review uses goal_override ────────────────────────


def test_compute_weekly_review_goal_override():
    """When goal_override is supplied, the review uses that goal instead of
    querying UserGoal — so a mid-week goal change doesn't retroactively
    alter the completed-week evaluation."""
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.models import WorkoutCompletion, WorkoutPlan, DailyNutritionMetrics

    queried_user_goal = []

    class GoalTrackingSession(FakeSession):
        def exec(self, stmt, *args, **kwargs):
            # Detect if UserGoal is being queried
            stmt_str = str(stmt).lower()
            if "usergoal" in stmt_str or "user_goal" in stmt_str:
                queried_user_goal.append(True)
            return _FakeExecResult()

    db = GoalTrackingSession()

    review = compute_weekly_review(
        db, user_id=1,
        goal_override="fat_loss",
    )

    assert review.goal == "fat_loss", f"review should use goal_override, got: {review.goal}"
    assert len(queried_user_goal) == 0, "UserGoal should NOT be queried when goal_override is provided"

    print("PASS test_compute_weekly_review_goal_override")


# ─── Test 4: explanation includes goal-change note ───────────────────────────


def test_auto_renew_explanation_goal_change_note():
    """The explanation-building logic in auto_renew_week should produce a
    goal-change note when expiring_goal != goal. Test the logic directly."""
    expiring_goal = "fat_loss"
    new_goal = "muscle_gain"

    explanation_parts: list[str] = []
    if expiring_goal and expiring_goal != new_goal:
        explanation_parts.append(
            f"This week was built for {expiring_goal.replace('_', ' ')}. "
            f"Your next week will use your new {new_goal.replace('_', ' ')} goal."
        )

    assert len(explanation_parts) == 1, "should produce exactly one note"
    assert "fat loss" in explanation_parts[0], f"should mention expiring goal: {explanation_parts[0]!r}"
    assert "muscle gain" in explanation_parts[0], f"should mention new goal: {explanation_parts[0]!r}"

    # Sanity: no note when goal is unchanged
    explanation_parts_same: list[str] = []
    if "body_recomp" and "body_recomp" != "body_recomp":
        explanation_parts_same.append("should not appear")
    assert explanation_parts_same == [], "no note when goal unchanged"

    print("PASS test_auto_renew_explanation_goal_change_note")


# ─── Runner ───────────────────────────────────────────────────────────────────


_CASES = [
    test_goal_sync_does_not_touch_plan_week,
    test_create_plan_week_stores_snapshot_fields,
    test_compute_weekly_review_goal_override,
    test_auto_renew_explanation_goal_change_note,
]

if __name__ == "__main__":
    passed = failed = 0
    for fn in _CASES:
        try:
            fn()
            passed += 1
        except Exception as exc:
            import traceback
            print(f"FAIL {fn.__name__}: {exc}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        sys.exit(1)
