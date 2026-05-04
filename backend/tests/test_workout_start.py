"""Regression tests for /workouts/start in-progress semantics."""
from __future__ import annotations

from datetime import date, timedelta


def _make_session():
    from sqlmodel import SQLModel, Session, create_engine
    from sqlalchemy.pool import StaticPool
    from app.models import (  # noqa: F401
        User, WorkoutSession, WorkoutExercise, ExerciseSet, WorkoutCompletion,
        PlanWeek, PlanDay,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_workout_start_creates_in_progress_session_not_completion():
    print("\n[test] /workouts/start creates in-progress session, not completion")
    from sqlmodel import select
    from app.models import User, PlanWeek, PlanDay, WorkoutCompletion, WorkoutSession
    from app.routers.workouts import WorkoutStartRequest, mark_workout_started

    s = _make_session()
    user = User(email="start@example.com", username="start", hashed_password="x")
    s.add(user)
    s.commit()
    s.refresh(user)

    today = date.today()
    week = PlanWeek(
        user_id=user.id,
        start_date=today,
        end_date=today + timedelta(days=6),
        planner_version="test",
        goal="muscle_gain",
        days_per_week=4,
        status="active",
    )
    s.add(week)
    s.flush()
    day = PlanDay(
        plan_week_id=week.id,
        user_id=user.id,
        day_date=today,
        day_index=0,
        status="planned",
        workout_json={"focus": "Push", "exercises": []},
        is_rest=False,
    )
    s.add(day)
    s.commit()

    res = mark_workout_started(
        WorkoutStartRequest(workout_date=today, focus_label="Push"),
        current_user=user,
        db=s,
    )

    completions = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == user.id)).all()
    sessions = s.exec(select(WorkoutSession).where(WorkoutSession.user_id == user.id)).all()
    started_day = s.get(PlanDay, day.id)
    assert res["ok"] is True
    assert res["completion_created"] is False
    assert len(completions) == 0
    assert len(sessions) == 1
    assert sessions[0].completed_at is None
    assert started_day.status == "started"
    assert started_day.lock_reason == "started"


if __name__ == "__main__":
    test_workout_start_creates_in_progress_session_not_completion()
    print("\nAll workout_start tests passed")
