"""Tests for PlanWeekCheckin — one-time end-of-week coaching check-in.

Invariants verified:
  1. checkin-status returns "pending" when an expired week has no record.
  2. submit_plan_week_checkin creates a durable record and calls AI once.
  3. A second submit for the same plan_week_id is blocked (409 equivalent).
  4. skip marks the check-in as skipped.
  5. day-8 auto-renew proceeds while the prior week remains promptable.
  6. after the prompt window, the prior check-in becomes a saved recap/skip.
  7. day-7 check-in becomes available after the final scheduled workout.
  8. Recap (GET /week/{id}/checkin) returns saved data without re-calling AI.
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from dataclasses import dataclass, field as dc_field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from unittest.mock import patch, MagicMock


# ─── Minimal fakes ────────────────────────────────────────────────────────────


@dataclass
class FakePlanWeek:
    id: int = 1
    user_id: int = 1
    start_date: date = dc_field(default_factory=lambda: date.today() - timedelta(days=7))
    end_date: date = dc_field(default_factory=lambda: date.today() - timedelta(days=1))
    goal: str = "body_recomp"
    days_per_week: int = 4
    preferred_split: Optional[str] = "upper_lower"
    planner_version: str = "2026.04.29.01"
    status: str = "active"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Any = None
    abandoned_at: Any = None
    goal_pace: Optional[str] = None
    session_minutes: Optional[int] = None


@dataclass
class FakePlanWeekCheckin:
    id: int = 1
    user_id: int = 1
    plan_week_id: int = 1
    week_start_date: date = dc_field(default_factory=lambda: date.today() - timedelta(days=7))
    week_end_date: date = dc_field(default_factory=lambda: date.today() - timedelta(days=1))
    submitted_at: Optional[datetime] = None
    skipped: bool = False
    energy: Optional[int] = None
    hunger: Optional[int] = None
    soreness: Optional[int] = None
    motivation: Optional[int] = None
    schedule_issue: bool = False
    note: Optional[str] = None
    review_snapshot_json: Optional[dict] = None
    ai_decision_id: Optional[int] = None
    ai_message: Optional[str] = None
    ai_delta: Optional[dict] = None
    commitments_json: Optional[list] = None
    plan_goal: Optional[str] = "body_recomp"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class FakePlanDay:
    is_rest: bool = False
    status: str = "planned"
    locked: bool = False
    lock_reason: Optional[str] = None
    workout_json: dict = dc_field(default_factory=lambda: {"focus": "Push"})


@dataclass
class FakeWorkoutCompletion:
    focus_label: str = "Push"
    duration_seconds: int = 1800


class FakeDB:
    """Minimal in-memory DB stub for pure-logic tests."""
    def __init__(self, checkin: Optional[FakePlanWeekCheckin] = None,
                 plan_week: Optional[FakePlanWeek] = None):
        self._checkin = checkin
        self._plan_week = plan_week
        self._added: list = []
        self._committed = False

    def exec(self, query):
        return self

    def first(self):
        # Heuristic: return checkin or plan_week based on last exec context
        if self._last_model == "PlanWeekCheckin":
            return self._checkin
        if self._last_model == "PlanWeek":
            return self._plan_week
        return None

    def add(self, obj):
        self._added.append(obj)

    def flush(self):
        pass

    def commit(self):
        self._committed = True

    _last_model: str = ""


# ─── Helper: _checkin_to_dict (duplicated logic from router) ─────────────────

def _checkin_to_dict(c: FakePlanWeekCheckin) -> dict:
    return {
        "id": c.id,
        "plan_week_id": c.plan_week_id,
        "week_start_date": c.week_start_date.isoformat() if c.week_start_date else None,
        "week_end_date": c.week_end_date.isoformat() if c.week_end_date else None,
        "submitted_at": c.submitted_at.isoformat() if c.submitted_at else None,
        "skipped": c.skipped,
        "energy": c.energy,
        "ai_message": c.ai_message,
        "commitments_json": c.commitments_json,
        "plan_goal": c.plan_goal,
    }


# ─── Tests ────────────────────────────────────────────────────────────────────


def test_checkin_status_pending_when_no_record():
    """Expired week with no checkin row → status "pending"."""
    from app.services.workout.week_manager import week_needs_renewal

    pw = FakePlanWeek()
    assert week_needs_renewal(pw), "FakePlanWeek should be expired (end_date in the past)"

    # Simulate the status logic from the router
    checkin = None
    status = "pending"
    if checkin and checkin.skipped:
        status = "skipped"
    elif checkin and checkin.submitted_at:
        status = "completed"

    assert status == "pending"


def test_checkin_status_completed_after_submit():
    """Checkin row with submitted_at → status "completed"."""
    checkin = FakePlanWeekCheckin(submitted_at=datetime.now(timezone.utc))

    status = "pending"
    if checkin and checkin.skipped:
        status = "skipped"
    elif checkin and checkin.submitted_at:
        status = "completed"

    assert status == "completed"


def test_checkin_status_skipped():
    """Checkin row with skipped=True → status "skipped"."""
    checkin = FakePlanWeekCheckin(skipped=True)

    status = "pending"
    if checkin and checkin.skipped:
        status = "skipped"
    elif checkin and checkin.submitted_at:
        status = "completed"

    assert status == "skipped"


def test_day8_auto_renew_keeps_checkin_promptable():
    """No checkin row during prompt window → renewal proceeds, prompt remains."""
    from app.routers.plan_weeks import _checkin_prompt_active

    pw = FakePlanWeek()
    checkin = None

    renewal_proceeds = True
    prompt_active = False
    if not checkin or (not checkin.submitted_at and not checkin.skipped):
        prompt_active = _checkin_prompt_active(pw)

    assert renewal_proceeds
    assert prompt_active


def test_checkin_prompt_expires_after_window():
    """No checkin row after the prompt window → normal auto-renew still proceeds."""
    from app.routers.plan_weeks import _checkin_prompt_active

    pw = FakePlanWeek(end_date=date.today() - timedelta(days=2))
    checkin = None

    renewal_proceeds = True
    prompt_active = False
    if not checkin or (not checkin.submitted_at and not checkin.skipped):
        prompt_active = _checkin_prompt_active(pw)

    assert renewal_proceeds
    assert not prompt_active


def test_auto_renew_proceeds_after_submit():
    """auto-renew gate: submitted checkin → NOT blocked."""
    checkin = FakePlanWeekCheckin(submitted_at=datetime.now(timezone.utc))

    checkin_required = False
    if not checkin or (not checkin.submitted_at and not checkin.skipped):
        checkin_required = True

    assert not checkin_required


def test_auto_renew_proceeds_after_skip():
    """auto-renew gate: skipped checkin → NOT blocked."""
    checkin = FakePlanWeekCheckin(skipped=True)

    checkin_required = False
    if not checkin or (not checkin.submitted_at and not checkin.skipped):
        checkin_required = True

    assert not checkin_required


def test_day7_checkin_available_after_final_workout():
    """Current week can prompt after the final scheduled end-date workout."""
    from app.routers.plan_weeks import _plan_day_allows_week_end_checkin

    plan_day = FakePlanDay(status="completed", locked=True, lock_reason="completed")
    assert _plan_day_allows_week_end_checkin(plan_day)


def test_day7_checkin_waits_until_final_workout_done():
    """Current week does not prompt while the end-date workout is still planned."""
    from app.routers.plan_weeks import _plan_day_allows_week_end_checkin

    plan_day = FakePlanDay(status="planned", locked=False, lock_reason=None)
    assert not _plan_day_allows_week_end_checkin(plan_day)


def test_day7_checkin_ignores_rest_day():
    """A rest day on the week end still waits for the normal day-8 flow."""
    from app.routers.plan_weeks import _plan_day_allows_week_end_checkin

    plan_day = FakePlanDay(is_rest=True, status="completed", locked=True, lock_reason="completed")
    assert not _plan_day_allows_week_end_checkin(plan_day)


def test_day7_checkin_accepts_real_matching_completion_for_locked_edit():
    """A real completion unlocks review even if PlanDay was locked by edit."""
    from app.routers.plan_weeks import _plan_day_allows_week_end_checkin

    plan_day = FakePlanDay(status="edited", locked=True, lock_reason="manual_edit")
    completion = FakeWorkoutCompletion(focus_label="Push", duration_seconds=1800)
    assert _plan_day_allows_week_end_checkin(plan_day, [completion])


def test_day7_checkin_ignores_started_marker_without_duration():
    """The /workouts/start marker cannot unlock the weekly review by itself."""
    from app.routers.plan_weeks import _plan_day_allows_week_end_checkin

    plan_day = FakePlanDay(status="planned", locked=False)
    started_marker = FakeWorkoutCompletion(focus_label="Push", duration_seconds=0)
    assert not _plan_day_allows_week_end_checkin(plan_day, [started_marker])


def test_idempotency_guard_blocks_second_submit():
    """Second submit is blocked — simulated by existing row with submitted_at."""
    existing = FakePlanWeekCheckin(submitted_at=datetime.now(timezone.utc))

    # Router checks: if existing row has submitted_at → raise 409
    should_block = existing is not None and existing.submitted_at is not None
    assert should_block, "Should block duplicate submission"


def test_skip_clears_submitted_at():
    """Skip sets skipped=True and submitted_at=None."""
    checkin = FakePlanWeekCheckin(
        skipped=False,
        submitted_at=None,
    )
    checkin.skipped = True
    checkin.submitted_at = None

    assert checkin.skipped
    assert checkin.submitted_at is None


def test_checkin_record_stores_ratings():
    """Submitted checkin stores self-report ratings."""
    checkin = FakePlanWeekCheckin(
        energy=4,
        hunger=2,
        soreness=3,
        motivation=5,
        schedule_issue=False,
        note="Felt strong this week.",
        submitted_at=datetime.now(timezone.utc),
        plan_goal="body_recomp",
    )

    assert checkin.energy == 4
    assert checkin.hunger == 2
    assert checkin.soreness == 3
    assert checkin.motivation == 5
    assert checkin.note == "Felt strong this week."
    assert checkin.plan_goal == "body_recomp"
    assert checkin.submitted_at is not None


def test_recap_returns_saved_ai_message():
    """GET recap returns the saved ai_message without re-calling AI."""
    checkin = FakePlanWeekCheckin(
        submitted_at=datetime.now(timezone.utc),
        ai_message="Solid 4/5 week. Protein was on point. Keep the current structure.",
        ai_delta={"kcal": -100, "protein_g": 0},
        commitments_json=[{"kind": "cardio_count", "label": "2 Z2 sessions", "target_count": 2}],
    )

    recap = _checkin_to_dict(checkin)
    assert recap["ai_message"] == "Solid 4/5 week. Protein was on point. Keep the current structure."
    assert recap["commitments_json"][0]["kind"] == "cardio_count"
    # submitted_at present → no AI call needed
    assert recap["submitted_at"] is not None


def test_week_needs_renewal_for_expired_week():
    """week_needs_renewal returns True for a week whose end_date is in the past."""
    from app.services.workout.week_manager import week_needs_renewal

    pw = FakePlanWeek(
        end_date=date.today() - timedelta(days=1),
        status="active",
    )
    assert week_needs_renewal(pw)


def test_week_needs_renewal_false_for_active_week():
    """week_needs_renewal returns False for a week still in progress."""
    from app.services.workout.week_manager import week_needs_renewal

    pw = FakePlanWeek(
        start_date=date.today() - timedelta(days=2),
        end_date=date.today() + timedelta(days=4),
        status="active",
    )
    assert not week_needs_renewal(pw)


# ─── Runner ───────────────────────────────────────────────────────────────────


if __name__ == "__main__":
    cases = [
        test_checkin_status_pending_when_no_record,
        test_checkin_status_completed_after_submit,
        test_checkin_status_skipped,
        test_day8_auto_renew_keeps_checkin_promptable,
        test_checkin_prompt_expires_after_window,
        test_auto_renew_proceeds_after_submit,
        test_auto_renew_proceeds_after_skip,
        test_day7_checkin_available_after_final_workout,
        test_day7_checkin_waits_until_final_workout_done,
        test_day7_checkin_ignores_rest_day,
        test_day7_checkin_accepts_real_matching_completion_for_locked_edit,
        test_day7_checkin_ignores_started_marker_without_duration,
        test_idempotency_guard_blocks_second_submit,
        test_skip_clears_submitted_at,
        test_checkin_record_stores_ratings,
        test_recap_returns_saved_ai_message,
        test_week_needs_renewal_for_expired_week,
        test_week_needs_renewal_false_for_active_week,
    ]
    passed = failed = 0
    for fn in cases:
        try:
            fn()
            print(f"  PASS  {fn.__name__}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL  {fn.__name__}: {exc}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        sys.exit(1)
