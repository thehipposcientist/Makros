"""Training streak + compliance aggregator.

Definitions:
  - ``current_streak`` — consecutive days ending today where the user
    either (a) completed a workout (any ``WorkoutCompletion``) OR
    (b) had a scheduled rest day (count < planned_days_per_week for the
    7-day window). A skipped day breaks the streak.
  - ``longest_streak`` — longest such run in the user's history (up to
    a 365-day lookback).
  - ``compliance_7d`` / ``compliance_30d`` — percentage of PLANNED
    training days the user actually completed. Planned days = days
    per week × window weeks (1 for 7d, ~4.29 for 30d).

The streak definition is intentionally lenient on rest days — most users
train 3-5 days/week, and we don't want a normal rest day to zero them
out. A day is ONLY considered a break when the user had a planned
workout that got skipped (tracked via ``UserDayState.skipped_focus``).
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from sqlalchemy import func
from sqlmodel import Session, select


def _completed_dates(user_id: int, db: Session, since: date) -> set[date]:
    """Return distinct workout_dates with at least one completion row."""
    from app.models import WorkoutCompletion

    rows = db.exec(
        select(WorkoutCompletion.workout_date)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= since)
    ).all()
    return {d for d in rows if d is not None}


def _skipped_dates(user_id: int, db: Session, since: date) -> set[date]:
    """Return day_keys where the user explicitly skipped a planned workout.

    Source: ``UserDayState.skipped_focus`` is non-null. Missing day_state
    rows are NOT skips (the user just didn't interact with the plan that
    day); that case is handled by the planned-days count.
    """
    from app.models import UserDayState

    rows = db.exec(
        select(UserDayState.day_key)
        .where(UserDayState.user_id == user_id)
        .where(UserDayState.day_key >= since)
        .where(UserDayState.skipped_focus.is_not(None))
    ).all()
    return {d for d in rows if d is not None}


def _planned_days_per_week(user_id: int, db: Session) -> int:
    """User's active-plan training frequency. Defaults to 4 when missing."""
    from app.models import WorkoutPlan, UserPreferences

    row = db.exec(
        select(WorkoutPlan)
        .where(WorkoutPlan.user_id == user_id)
        .where(WorkoutPlan.is_active == True)  # noqa: E712
        .order_by(WorkoutPlan.created_at.desc())
    ).first()
    if row and row.days_per_week:
        return int(row.days_per_week)
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    if prefs and prefs.days_per_week:
        return int(prefs.days_per_week)
    return 4


def compute_streak_summary(
    user_id: int,
    *,
    db: Session,
    today: date | None = None,
    lookback_days: int = 365,
) -> dict:
    """Return the streak / compliance dict for a user.

    Shape:
        {
          "current_streak": int,
          "longest_streak": int,
          "compliance_7d": float,    # 0-100
          "compliance_30d": float,   # 0-100
          "last_active_date": str | None,
        }
    """
    today = today or date.today()
    window_start = today - timedelta(days=lookback_days)
    completed = _completed_dates(user_id, db, window_start)
    skipped = _skipped_dates(user_id, db, window_start)
    planned_per_week = _planned_days_per_week(user_id, db)

    # Compute current + longest streak by walking day-by-day.
    # Rules:
    #   - A day with a completion contributes +1 to the streak.
    #   - A day that is a SKIPPED day breaks the streak.
    #   - A day with no completion AND no skip is ambiguous — treat it
    #     as "rest" so mid-week rest doesn't zero the user out.
    current_streak = 0
    longest_streak = 0
    run = 0
    rest_gap = 0
    d = window_start
    while d <= today:
        if d in skipped and d not in completed:
            run = 0
            rest_gap = 0
        elif d in completed:
            run += 1
            rest_gap = 0
        else:
            # Rest day. Mirror the current_streak walk's gap heuristic
            # so 3+ consecutive non-completion days break the run — this
            # prevents an imported Feb streak + 2-month gap + April
            # streak from collapsing into one continuous run.
            rest_gap += 1
            if rest_gap >= 3:
                run = 0
        if run > longest_streak:
            longest_streak = run
        d = d + timedelta(days=1)
    # Walk backward from today for the current streak so we correctly
    # ignore trailing rest days. The streak ends at:
    #   - an explicit skip (UserDayState.skipped_focus set), OR
    #   - a gap of 3+ consecutive rest days (no activity, no skip).
    # The gap heuristic protects against "last week + rest-heavy gap +
    # today" looking like a long streak when really the user took four
    # days off before today.
    cur = 0
    cursor = today
    rest_gap = 0
    while cursor >= window_start:
        if cursor in skipped and cursor not in completed:
            break
        if cursor in completed:
            cur += 1
            rest_gap = 0
        else:
            rest_gap += 1
            if rest_gap >= 3 and cur > 0:
                break
            if rest_gap >= 3 and cur == 0 and cursor < today:
                # Haven't trained recently at all — streak stays 0.
                break
        cursor = cursor - timedelta(days=1)
    current_streak = cur

    # Compliance: completed/planned across 7-day and 30-day windows.
    def _compliance(window_days: int) -> float:
        start = today - timedelta(days=window_days - 1)
        planned = planned_per_week * (window_days / 7.0)
        if planned <= 0:
            return 0.0
        done = sum(1 for x in completed if x >= start and x <= today)
        return round(min(done / planned, 1.0) * 100, 1)

    last_active = max(completed) if completed else None

    return {
        "current_streak": current_streak,
        "longest_streak": longest_streak,
        "compliance_7d": _compliance(7),
        "compliance_30d": _compliance(30),
        "last_active_date": last_active.isoformat() if last_active else None,
    }


def _volume_for_week(
    user_id: int, start: date, end: date, db: Session
) -> float:
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet

    rows = db.exec(
        select(ExerciseSet.actual_weight_lbs, ExerciseSet.actual_reps)
        .join(WorkoutExercise, WorkoutExercise.id == ExerciseSet.workout_exercise_id)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= start)
        .where(WorkoutSession.workout_date <= end)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    ).all()
    total = 0.0
    for weight, reps in rows:
        w = float(weight or 0)
        r = int(reps or 0)
        if r > 0:
            total += w * r
    return round(total, 1)


def build_adherence_trend(
    user_id: int,
    *,
    db: Session,
    weeks: int = 8,
    today: date | None = None,
) -> list[dict]:
    """Return per-week adherence data for the last *weeks* weeks.

    Each entry: {week_start, week_end, planned, completed, compliance_pct, total_volume}.
    Sorted oldest-first.
    """
    today = today or date.today()
    planned_per_week = _planned_days_per_week(user_id, db)

    lookback_start = today - timedelta(days=weeks * 7)
    completed = _completed_dates(user_id, db, lookback_start)

    result: list[dict] = []
    for i in range(weeks):
        week_end = today - timedelta(days=i * 7)
        week_start = week_end - timedelta(days=6)
        done = sum(1 for d in completed if week_start <= d <= week_end)
        planned = max(planned_per_week, 1)
        pct = round(min(done / planned, 1.0) * 100, 1)
        vol = _volume_for_week(user_id, week_start, week_end, db)
        result.append({
            "week_start": week_start.isoformat(),
            "week_end": week_end.isoformat(),
            "planned": planned,
            "completed": done,
            "compliance_pct": pct,
            "total_volume": vol,
        })

    result.reverse()
    return result
