"""Tests for ``detect_plateaus`` (Feature 5).

Covers:
  - Steady 1RM across 4 weeks → plateau (within tolerance)
  - 1RM climbed in week 3 → no plateau
  - Fewer than 4 weeks of history → no plateau (insufficient data)
  - Mixed: one exercise plateaued + one progressing → only the first returned
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


def _insert_user(session, *, email="plateau@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _add_session(session, user_id: int, d: date, exercise_name: str, weight: float, reps: int):
    from app.enums import WorkoutSource, EquipmentType
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet
    ws = WorkoutSession(
        user_id=user_id, name="Lift", focus="lift", workout_date=d,
        source=WorkoutSource.GENERATED, completed_at=datetime.now(timezone.utc),
    )
    session.add(ws); session.flush()
    we = WorkoutExercise(
        session_id=ws.id, name=exercise_name, order_index=0, equipment=EquipmentType.GYM,
    )
    session.add(we); session.flush()
    session.add(ExerciseSet(
        workout_exercise_id=we.id, set_number=1,
        actual_weight_lbs=weight, actual_reps=reps,
        completed=True, completed_at=datetime.now(timezone.utc),
    ))


# ── Tests ───────────────────────────────────────────────────────────


def test_steady_1rm_four_weeks_is_plateau() -> None:
    print("\n[test] same peak 1RM across 4 weeks → plateau")
    from sqlmodel import Session
    from app.services.workout.plateau_detection import detect_plateaus

    engine = _make_mem_engine()
    # Fixed today = Sunday 2026-04-19 so week math is stable.
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        # One session per week, identical 225 × 5 (= est 1RM ~262.5)
        for weeks_ago in range(1, 5):
            d = today - timedelta(weeks=weeks_ago)
            _add_session(s, user.id, d, "Back Squat", 225.0, 5)
        s.commit()
        result = detect_plateaus(user.id, db=s, window_weeks=4, today=today)

    assert len(result) == 1, f"expected one plateau entry, got {result}"
    entry = result[0]
    assert entry["exercise_name"] == "Back Squat"
    assert entry["weeks_stuck"] == 4
    assert entry["suggestion"] in ("deload", "add_volume", "swap")
    # 225 * (1 + 5/30) = 262.5
    assert abs(entry["current_1rm"] - 262.5) < 0.1
    _ok(f"4-week flat 225×5 → plateau, 1rm={entry['current_1rm']}, suggestion={entry['suggestion']}")


def test_climbing_in_week_three_is_not_plateau() -> None:
    print("\n[test] 1RM climbed mid-window → no plateau")
    from sqlmodel import Session
    from app.services.workout.plateau_detection import detect_plateaus

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        # Week offsets (newest-first): 4w,3w,2w,1w = 185, 195, 195, 205 (rising)
        offsets_and_weights = [(4, 185), (3, 195), (2, 195), (1, 205)]
        for weeks_ago, w in offsets_and_weights:
            d = today - timedelta(weeks=weeks_ago)
            _add_session(s, user.id, d, "Bench Press", float(w), 5)
        s.commit()
        result = detect_plateaus(user.id, db=s, window_weeks=4, today=today)

    assert result == [], f"climbing series should not plateau: {result}"
    _ok("rising 185→205 across 4 weeks → no plateau detected")


def test_short_history_insufficient_data() -> None:
    print("\n[test] <4 weeks of history → no plateau (insufficient data)")
    from sqlmodel import Session
    from app.services.workout.plateau_detection import detect_plateaus

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        # Only 2 weeks of data
        for weeks_ago in (1, 2):
            d = today - timedelta(weeks=weeks_ago)
            _add_session(s, user.id, d, "Deadlift", 315.0, 3)
        s.commit()
        result = detect_plateaus(user.id, db=s, window_weeks=4, today=today)

    assert result == [], f"not enough history to declare a plateau: {result}"
    _ok("2 weeks of history → empty list (no plateau)")


def test_mixed_plateau_and_progress_returns_only_stuck_one() -> None:
    print("\n[test] mixed: one flat + one progressing → only flat one reported")
    from sqlmodel import Session
    from app.services.workout.plateau_detection import detect_plateaus

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        # Overhead Press: flat 135×5 every week → plateau
        for weeks_ago in range(1, 5):
            d = today - timedelta(weeks=weeks_ago)
            _add_session(s, user.id, d, "Overhead Press", 135.0, 5)
        # Pull-Up: rising 5, 6, 7, 8 bodyweight reps → progressing
        for weeks_ago, reps in [(4, 5), (3, 6), (2, 7), (1, 8)]:
            d = today - timedelta(weeks=weeks_ago)
            _add_session(s, user.id, d, "Pull-Up", 185.0, reps)
        s.commit()
        result = detect_plateaus(user.id, db=s, window_weeks=4, today=today)

    names = {r["exercise_name"] for r in result}
    assert "Overhead Press" in names, f"expected OHP flat: {result}"
    assert "Pull-Up" not in names, f"Pull-Up was progressing: {result}"
    _ok(f"returned {len(result)} plateau(s); progressing exercise correctly excluded")


def test_tolerance_band_counts_small_wobble_as_plateau() -> None:
    print("\n[test] 225, 227.5, 225, 227.5 (<1% drift) still counts as plateau")
    from sqlmodel import Session
    from app.services.workout.plateau_detection import detect_plateaus

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        weights = [225, 227.5, 225, 227.5]
        for weeks_ago, w in zip([4, 3, 2, 1], weights):
            d = today - timedelta(weeks=weeks_ago)
            _add_session(s, user.id, d, "Back Squat", float(w), 5)
        s.commit()
        result = detect_plateaus(user.id, db=s, window_weeks=4, today=today)

    assert len(result) == 1 and result[0]["exercise_name"] == "Back Squat"
    _ok("wobble within 2% tolerance → still a plateau")


cases = [
    test_steady_1rm_four_weeks_is_plateau,
    test_climbing_in_week_three_is_not_plateau,
    test_short_history_insufficient_data,
    test_mixed_plateau_and_progress_returns_only_stuck_one,
    test_tolerance_band_counts_small_wobble_as_plateau,
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
