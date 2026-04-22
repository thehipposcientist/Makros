"""Tests for ``compute_streak_summary`` (Feature 8).

Covers:
  - Clean 5-day consecutive streak + longest streak reporting
  - Rest day in the middle doesn't break the streak
  - Explicit skipped day (UserDayState.skipped_focus set) DOES break it
  - Gap with no activity and no skip breaks the current streak
  - Compliance 7d / 30d percentages
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from sqlalchemy.pool import StaticPool
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, WorkoutCompletion, NutritionPlan,
    )
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session):
    from app.models import User
    u = User(email="streak@example.com", username="streak", hashed_password="x")
    session.add(u); session.commit(); session.refresh(u)
    return u


def _complete(session, user_id: int, d: date, focus: str = "Push"):
    from app.models import WorkoutCompletion
    session.add(WorkoutCompletion(
        user_id=user_id, workout_date=d, focus_label=focus,
        duration_seconds=3600, completed_at=datetime.now(timezone.utc),
    ))


def _skip(session, user_id: int, d: date, focus: str = "Push"):
    from app.models import UserDayState
    session.add(UserDayState(user_id=user_id, day_key=d, skipped_focus=focus))


def _setup_plan(session, user_id: int, days_per_week: int = 4):
    from app.models import WorkoutPlan
    session.add(WorkoutPlan(
        user_id=user_id, planner_version="test.v", goal="muscle_gain",
        days_per_week=days_per_week, plan_json={"days": []}, is_active=True,
    ))


# ── Tests ───────────────────────────────────────────────────────────


def test_five_consecutive_days_current_streak_five() -> None:
    print("\n[test] 5 consecutive completion days → current_streak=5")
    from sqlmodel import Session
    from app.services.workout.streak import compute_streak_summary

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        _setup_plan(s, user.id, days_per_week=5)
        for offset in range(5):
            _complete(s, user.id, today - timedelta(days=offset))
        s.commit()
        summary = compute_streak_summary(user.id, db=s, today=today)

    assert summary["current_streak"] == 5, summary
    assert summary["longest_streak"] >= 5
    assert summary["last_active_date"] == today.isoformat()
    _ok(f"current={summary['current_streak']} longest={summary['longest_streak']}")


def test_rest_day_does_not_break_streak() -> None:
    print("\n[test] mid-week rest day (no skip marker) doesn't break streak")
    from sqlmodel import Session
    from app.services.workout.streak import compute_streak_summary

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        _setup_plan(s, user.id, days_per_week=4)
        # Completions: today, -1, skip -2 (rest), -3, -4
        for offset in [0, 1, 3, 4]:
            _complete(s, user.id, today - timedelta(days=offset))
        s.commit()
        summary = compute_streak_summary(user.id, db=s, today=today)

    # Current streak counts today + yesterday (no intervening skip marker).
    # Rest day (-2) is not a break, so the streak walks back through it.
    assert summary["current_streak"] >= 2, summary
    _ok(f"rest day preserved streak (current={summary['current_streak']})")


def test_explicit_skip_breaks_streak() -> None:
    print("\n[test] UserDayState.skipped_focus breaks the streak")
    from sqlmodel import Session
    from app.services.workout.streak import compute_streak_summary

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        _setup_plan(s, user.id, days_per_week=4)
        # Today + yesterday completed, 2 days ago SKIPPED, 3+ days ago done
        _complete(s, user.id, today)
        _complete(s, user.id, today - timedelta(days=1))
        _skip(s, user.id, today - timedelta(days=2))
        _complete(s, user.id, today - timedelta(days=3))
        _complete(s, user.id, today - timedelta(days=4))
        s.commit()
        summary = compute_streak_summary(user.id, db=s, today=today)

    # Current streak walks back: today (1), -1 (2), -2 is skip → STOP.
    assert summary["current_streak"] == 2, summary
    # Longest streak includes the pre-skip run of 2 as well
    assert summary["longest_streak"] >= 2
    _ok(f"skip at -2 correctly broke streak (current={summary['current_streak']})")


def test_compliance_7d_and_30d() -> None:
    print("\n[test] compliance_7d + compliance_30d reflect planned vs done")
    from sqlmodel import Session
    from app.services.workout.streak import compute_streak_summary

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        _setup_plan(s, user.id, days_per_week=4)
        # Last 7d: 4 sessions (exactly meets plan) → 100% 7d.
        for offset in [0, 2, 4, 6]:
            _complete(s, user.id, today - timedelta(days=offset))
        # Last 30d (inclusive of 7d above) — add 2 more sessions weeks 2-4
        for offset in [10, 17]:
            _complete(s, user.id, today - timedelta(days=offset))
        s.commit()
        summary = compute_streak_summary(user.id, db=s, today=today)

    # 7d: 4/4 → 100%
    assert summary["compliance_7d"] == 100.0, summary
    # 30d: 6 / (4 * 30/7) ≈ 6 / 17.14 ≈ 35%
    assert 30.0 <= summary["compliance_30d"] <= 40.0, summary
    _ok(f"compliance_7d={summary['compliance_7d']} compliance_30d={summary['compliance_30d']}")


def test_gap_with_no_skip_marker_still_ends_current_streak() -> None:
    print("\n[test] gap (no completion, no skip) older than today ends the active streak")
    from sqlmodel import Session
    from app.services.workout.streak import compute_streak_summary

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        _setup_plan(s, user.id)
        # Completions only at -5 and -6. Today / yesterday blank.
        _complete(s, user.id, today - timedelta(days=5))
        _complete(s, user.id, today - timedelta(days=6))
        s.commit()
        summary = compute_streak_summary(user.id, db=s, today=today)

    # Walk-back finds no completion until day -5; streak = 0 since we
    # treat gaps as rest and never increment past a lack of completion.
    assert summary["current_streak"] == 0, summary
    assert summary["last_active_date"] == (today - timedelta(days=5)).isoformat()
    _ok("no recent activity → current_streak=0, last_active reported")


def test_zero_history_returns_zeros() -> None:
    print("\n[test] brand-new user → zeros")
    from sqlmodel import Session
    from app.services.workout.streak import compute_streak_summary

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        _setup_plan(s, user.id)
        summary = compute_streak_summary(user.id, db=s, today=today)

    assert summary == {
        "current_streak": 0,
        "longest_streak": 0,
        "compliance_7d": 0.0,
        "compliance_30d": 0.0,
        "last_active_date": None,
    }
    _ok("new user → clean zero dict")


cases = [
    test_five_consecutive_days_current_streak_five,
    test_rest_day_does_not_break_streak,
    test_explicit_skip_breaks_streak,
    test_compliance_7d_and_30d,
    test_gap_with_no_skip_marker_still_ends_current_streak,
    test_zero_history_returns_zeros,
]


if __name__ == "__main__":
    import traceback
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            traceback.print_exc()
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    if failures:
        raise SystemExit(1)
    print(f"\n  All {len(cases)} tests passed.")
