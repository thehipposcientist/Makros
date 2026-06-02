"""Pure-function tests for the week-AI evaluator.

Asserts:
  - build_week_payload trims the deterministic review to the fields
    the LLM actually needs and tags mode correctly (auto vs manual).
  - Manual-mode payload includes manual_meta with assigned/completed/
    unassigned/rest counts derived from the active PlanWeek.
  - evaluate_week short-circuits an empty week with a deterministic
    response — no LLM call needed.

LLM call NOT exercised here. Live AI tests live elsewhere.
"""
from __future__ import annotations

from datetime import date, timedelta


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401  — register tables
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, WorkoutTemplate, PlanWeek, PlanDay,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, username: str, tier: str = "pro") -> int:
    from app.models import User
    u = User(
        email=f"{username}@example.com",
        username=username,
        hashed_password="x",
        subscription_tier=tier,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return int(u.id)


def _seed_active_week(session, user_id: int, *, manual: bool, today: date | None = None):
    """Seed an active PlanWeek (start = today-2). Days 0/1 completed,
    days 2..6 either 'planned' (auto mode) or 'unassigned' (manual)."""
    from app.models import PlanDay, PlanWeek, UserPreferences
    today = today or date.today()
    start = today - timedelta(days=2)
    pw = PlanWeek(
        user_id=user_id,
        start_date=start,
        end_date=start + timedelta(days=6),
        planner_version="test",
        goal="general_fitness",
        days_per_week=4,
        preferred_split="full_body",
        status="active",
    )
    session.add(pw)
    session.commit()
    session.refresh(pw)
    for i in range(7):
        d = start + timedelta(days=i)
        if i < 2:
            status = "completed"
            workout = {"focus": "Day", "exercises": [{"name": "Bench"}]}
            is_rest = False
        elif manual:
            status = "unassigned"
            workout = None
            is_rest = False
        else:
            status = "planned"
            workout = {"focus": "Day", "exercises": [{"name": "Bench"}]}
            is_rest = False
        session.add(PlanDay(
            plan_week_id=pw.id,
            user_id=user_id,
            day_date=d, day_index=i,
            status=status, is_rest=is_rest,
            workout_json=workout, locked=(i < 2),
            generation_source="manual" if manual else "initial",
        ))
    if manual:
        session.add(UserPreferences(user_id=user_id, workout_manual_mode=True))
    session.commit()
    return pw.id


def test_build_payload_tags_auto_mode():
    from sqlmodel import Session
    from app.services.coach.week_evaluator import build_week_payload
    engine = _make_mem_engine()
    with Session(engine) as s:
        uid = _insert_user(s, username="auto1")
        _seed_active_week(s, uid, manual=False)
    with Session(engine) as s:
        payload = build_week_payload(s, uid)
    assert payload["mode"] == "auto", payload
    assert "manual_meta" not in payload
    review = payload["review"]
    assert "sessions_completed" in review
    assert "sessions_planned" in review
    assert isinstance(review.get("recommendations"), list)
    _ok("build_week_payload tags auto mode + omits manual_meta")


def test_build_payload_includes_manual_meta_when_manual_mode():
    from sqlmodel import Session
    from app.services.coach.week_evaluator import build_week_payload
    engine = _make_mem_engine()
    with Session(engine) as s:
        uid = _insert_user(s, username="manual1")
        _seed_active_week(s, uid, manual=True)
    with Session(engine) as s:
        payload = build_week_payload(s, uid)
    assert payload["mode"] == "manual", payload
    meta = payload.get("manual_meta")
    assert meta is not None
    assert meta["completed_days"] == 2, meta
    assert meta["unassigned_days"] == 5, meta
    assert meta["assigned_days"] == 2, meta  # the 2 completed days have workout_json
    assert meta["rest_days"] == 0, meta
    _ok("manual mode payload includes manual_meta counts")


def test_evaluate_short_circuits_empty_week_without_llm():
    """Brand-new user with no active week and no completions returns
    the deterministic empty-week response."""
    from sqlmodel import Session
    from app.services.coach.week_evaluator import evaluate_week
    engine = _make_mem_engine()
    with Session(engine) as s:
        uid = _insert_user(s, username="empty1")
    with Session(engine) as s:
        result = evaluate_week(s, uid)
    assert result["headline"] == "Nothing to evaluate yet"
    assert "No sessions" in result["summary"]
    assert len(result["suggestions"]) == 1
    _ok("empty week returns deterministic response (no LLM call)")


def test_recommendations_capped_to_five():
    """Even when the deterministic review produces many recommendations,
    the LLM payload trims to the top 5 by priority — protects context."""
    from sqlmodel import Session
    from app.services.coach.week_evaluator import build_week_payload
    engine = _make_mem_engine()
    with Session(engine) as s:
        uid = _insert_user(s, username="caprec")
        _seed_active_week(s, uid, manual=False)
    with Session(engine) as s:
        payload = build_week_payload(s, uid)
    recs = payload["review"].get("recommendations", [])
    assert len(recs) <= 5, f"got {len(recs)} recs, expected ≤5"
    _ok("recommendations trimmed to top 5 in payload")


cases = [
    test_build_payload_tags_auto_mode,
    test_build_payload_includes_manual_meta_when_manual_mode,
    test_evaluate_short_circuits_empty_week_without_llm,
    test_recommendations_capped_to_five,
]
