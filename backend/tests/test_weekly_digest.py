"""Tests for ``build_weekly_digest`` (Feature 3).

Covers three shapes of history:
  - Full week: completions on 4 distinct days + meals on 5 days
  - Partial week: completions on 1 day only
  - Zero completions: confirm the payload still returns with sane zeros
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


def _insert_user(session, *, email: str = "digest_test@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _add_completion(session, user_id: int, d: date, *, focus: str = "Push", duration: int = 3600, stimulus: str = "hypertrophy"):
    from app.models import WorkoutCompletion
    session.add(WorkoutCompletion(
        user_id=user_id,
        workout_date=d,
        focus_label=focus,
        duration_seconds=duration,
        stimulus=stimulus,
        completed_at=datetime.now(timezone.utc),
    ))


def _add_session_with_sets(session, user_id: int, d: date, name: str, exercise_sets: list[tuple[str, list[tuple[float, int]]]]):
    from app.enums import WorkoutSource, EquipmentType
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet
    ws = WorkoutSession(
        user_id=user_id,
        name=name,
        focus=name,
        workout_date=d,
        source=WorkoutSource.GENERATED,
        completed_at=datetime.now(timezone.utc),
    )
    session.add(ws)
    session.flush()
    for idx, (ex_name, sets) in enumerate(exercise_sets):
        we = WorkoutExercise(
            session_id=ws.id, name=ex_name, order_index=idx, equipment=EquipmentType.GYM,
        )
        session.add(we)
        session.flush()
        for i, (w, r) in enumerate(sets):
            session.add(ExerciseSet(
                workout_exercise_id=we.id,
                set_number=i + 1,
                actual_weight_lbs=w,
                actual_reps=r,
                completed=True,
                completed_at=datetime.now(timezone.utc),
            ))


def _add_meal(session, user_id: int, d: date, calories: float, protein: float):
    from app.enums import MealType, MealSource
    from app.models import Meal, MealItem
    m = Meal(
        user_id=user_id, meal_date=d, meal_type=MealType.LUNCH,
        name="Chicken bowl", source=MealSource.LOGGED,
    )
    session.add(m)
    session.flush()
    session.add(MealItem(
        meal_id=m.id, food_name="Chicken", quantity=1, unit="serving",
        calories=calories, protein_g=protein, carbs_g=50, fat_g=10,
    ))


# ── Tests ───────────────────────────────────────────────────────────


def test_zero_completions_returns_zeroed_payload() -> None:
    print("\n[test] zero completions → payload returns with zeroed counts + empty lists")
    from sqlmodel import Session
    from app.services.workout.weekly_digest import build_weekly_digest

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        digest = build_weekly_digest(user.id, today=date(2026, 4, 19), db=s)

    assert digest["sessions"]["completed"] == 0
    assert digest["sessions"]["distinct_days"] == 0
    assert digest["volume"]["total_sets"] == 0
    assert digest["volume"]["volume_load_lbs"] == 0.0
    assert digest["prs"] == []
    assert digest["pr_count"] == 0
    assert digest["sessions"]["adherence_pct"] == 0.0
    # Week dates are correct
    assert digest["week_end"] == "2026-04-19"
    assert digest["week_start"] == "2026-04-13"
    _ok("zero history → clean zeroed dict with correct date range")


def test_full_week_reports_sessions_volume_and_adherence() -> None:
    print("\n[test] full week with 4 distinct training days → correct counts + adherence")
    from sqlmodel import Session
    from app.models import WorkoutPlan
    from app.services.workout.weekly_digest import build_weekly_digest

    engine = _make_mem_engine()
    today = date(2026, 4, 19)  # Sunday
    with Session(engine) as s:
        user = _insert_user(s)
        # Plan says 4 days/week → 4 distinct days = 100% adherence.
        s.add(WorkoutPlan(
            user_id=user.id, planner_version="test.version", goal="muscle_gain",
            days_per_week=4, plan_json={"days": []}, is_active=True,
        ))
        # 4 workouts across Mon-Thu.
        for offset, focus in [(6, "Push"), (5, "Pull"), (4, "Legs"), (3, "Upper")]:
            d = today - timedelta(days=offset)
            _add_completion(s, user.id, d, focus=focus)
            _add_session_with_sets(s, user.id, d, focus, [
                ("Bench Press" if focus == "Push" else "Row" if focus == "Pull" else "Squat",
                 [(185.0, 8), (185.0, 8), (185.0, 7)]),
            ])
        # Meal logging on 5 days → feeds nutrition averages.
        for offset in [0, 1, 2, 3, 4]:
            _add_meal(s, user.id, today - timedelta(days=offset), 2200, 165)
        s.commit()

        digest = build_weekly_digest(user.id, today=today, db=s)

    assert digest["sessions"]["completed"] == 4, digest["sessions"]
    assert digest["sessions"]["distinct_days"] == 4
    assert digest["sessions"]["planned"] == 4
    assert digest["sessions"]["adherence_pct"] == 100.0
    # 4 sessions * 3 sets = 12 total sets
    assert digest["volume"]["total_sets"] == 12
    # 4 sessions * (185*8 + 185*8 + 185*7) = 4 * 4255 = 17020
    assert abs(digest["volume"]["volume_load_lbs"] - 17020.0) < 0.5
    # Focus distribution counts each label
    focus_dist = digest["sessions"]["focus_distribution"]
    assert focus_dist.get("Push") == 1 and focus_dist.get("Pull") == 1
    # Nutrition reflects the logged meals
    assert digest["nutrition"]["days_logged"] == 5
    assert digest["nutrition"]["avg_protein_g"] > 100
    _ok("full week: 4 days / 4 planned → 100%, 12 sets, volume reported")


def test_partial_week_single_session() -> None:
    print("\n[test] partial week: 1 session, 5 days plan → 20% adherence")
    from sqlmodel import Session
    from app.models import WorkoutPlan
    from app.services.workout.weekly_digest import build_weekly_digest

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        s.add(WorkoutPlan(
            user_id=user.id, planner_version="test.version", goal="muscle_gain",
            days_per_week=5, plan_json={"days": []}, is_active=True,
        ))
        _add_completion(s, user.id, today - timedelta(days=3), focus="Legs")
        _add_session_with_sets(s, user.id, today - timedelta(days=3), "Legs", [
            ("Squat", [(225.0, 5)]),
        ])
        s.commit()
        digest = build_weekly_digest(user.id, today=today, db=s)

    assert digest["sessions"]["completed"] == 1
    assert digest["sessions"]["distinct_days"] == 1
    assert digest["sessions"]["planned"] == 5
    assert digest["sessions"]["adherence_pct"] == 20.0
    # First-ever lift establishes a baseline; it is not shown as a PR.
    assert digest["prs"] == []
    assert digest["pr_count"] == 0
    _ok("1 session on a 5-day plan → 20% adherence, baseline PRs omitted")


def test_deltas_vs_prior_week() -> None:
    print("\n[test] deltas reflect vs prior-week totals")
    from sqlmodel import Session
    from app.models import WorkoutPlan
    from app.services.workout.weekly_digest import build_weekly_digest

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        s.add(WorkoutPlan(
            user_id=user.id, planner_version="test.version", goal="muscle_gain",
            days_per_week=4, plan_json={"days": []}, is_active=True,
        ))
        # Prior week: 2 sessions (days 7-13 ago)
        for offset in [10, 12]:
            d = today - timedelta(days=offset)
            _add_completion(s, user.id, d, focus="Push")
        # This week: 4 sessions
        for offset in [1, 2, 3, 4]:
            d = today - timedelta(days=offset)
            _add_completion(s, user.id, d, focus="Push")
        s.commit()
        digest = build_weekly_digest(user.id, today=today, db=s)

    assert digest["sessions"]["completed"] == 4
    assert digest["prior_week"]["completed"] == 2
    assert digest["deltas"]["sessions"] == 2, digest["deltas"]
    _ok("deltas correctly computed against prior 7 days")


def test_pr_window_only_counts_sessions_inside_week() -> None:
    print("\n[test] PRs emitted only for sessions within the 7-day window")
    from sqlmodel import Session
    from app.services.workout.weekly_digest import build_weekly_digest

    engine = _make_mem_engine()
    today = date(2026, 4, 19)
    with Session(engine) as s:
        user = _insert_user(s)
        # Baseline OUTSIDE window (20 days ago): 225 × 5 Squat
        _add_session_with_sets(s, user.id, today - timedelta(days=20), "Legs", [
            ("Squat", [(225.0, 5)]),
        ])
        # This week: new PR 245 × 3
        _add_session_with_sets(s, user.id, today - timedelta(days=2), "Legs", [
            ("Squat", [(245.0, 3)]),
        ])
        s.commit()
        digest = build_weekly_digest(user.id, today=today, db=s)

    # Only the in-week session emits PRs; baseline lifted 20 days ago is NOT
    # listed again despite also being "first ever" at the time.
    pr_dates = {p["session_date"] for p in digest["prs"]}
    assert pr_dates == {(today - timedelta(days=2)).isoformat()}, pr_dates
    heaviest = [p for p in digest["prs"] if p["kind"] == "heaviest_weight"]
    assert len(heaviest) == 1 and heaviest[0]["new_value"] == 245.0
    # Old value reads off the 20-day-old session → 225.0
    assert heaviest[0]["old_value"] == 225.0
    _ok("PR list scoped to current 7-day window; historical baseline respected")


cases = [
    test_zero_completions_returns_zeroed_payload,
    test_full_week_reports_sessions_volume_and_adherence,
    test_partial_week_single_session,
    test_deltas_vs_prior_week,
    test_pr_window_only_counts_sessions_inside_week,
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
