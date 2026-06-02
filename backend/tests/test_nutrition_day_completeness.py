"""Nutrition day completeness tests.

Sparse meal logs must stay visible without being treated as complete-day
intake. These tests cover the explicit marker, inference, and rollup gating
that protect readiness/recovery/coaching signals from partial logging.
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Meal, MealItem, ExerciseSet,
        WorkoutSession, WorkoutExercise, WorkoutCompletion,
        DailyNutritionMetrics, FoodMetadata, FoodNutrition, Food,
        FoodAlias, FoodServing, UserRecentFood,
        Exercise, ExerciseEquipment, Equipment, GoalOption, PaceOption,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, PlanWeek, PlanDay,
    )
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _seed_user(s: Session):
    from app.models import User
    user = User(email="partial@example.com", username="partial", hashed_password="x")
    s.add(user)
    s.commit()
    s.refresh(user)
    return user


def _add_meal(s: Session, user_id: int, d: date, calories: float) -> None:
    from app.enums import MealSource, MealType
    from app.models import Meal, MealItem
    meal = Meal(
        user_id=user_id,
        meal_date=d,
        meal_type=MealType.LUNCH,
        name="Logged meal",
        source=MealSource.LOGGED,
    )
    s.add(meal)
    s.commit()
    s.refresh(meal)
    s.add(MealItem(
        meal_id=meal.id,
        food_name="Bowl",
        quantity=1,
        unit="serving",
        calories=calories,
        protein_g=30,
        carbs_g=50,
        fat_g=20,
    ))
    s.commit()


def test_empty_day_is_unknown():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        result = classify_nutrition_day(s, user.id, date.today(), calorie_target=2200)
    assert result.status == "unknown", result
    assert not result.usable_for_recovery
    assert result.intake_basis == "empty", result
    assert result.to_dict()["intake_basis"] == "empty"
    _ok("empty days are unknown")


def test_single_small_meal_is_partial():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        _add_meal(s, user.id, d, 450)
        result = classify_nutrition_day(s, user.id, d, calorie_target=2200)
    assert result.status == "partial", result
    assert not result.usable_for_recovery
    _ok("small one-meal logs are partial")


def test_fullish_logged_day_is_rough_estimate():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        _add_meal(s, user.id, d, 900)
        _add_meal(s, user.id, d, 900)
        result = classify_nutrition_day(s, user.id, d, calorie_target=2200)
    assert result.status == "rough_estimate", result
    assert result.usable_for_recovery
    _ok("substantial unconfirmed logs are rough estimates")


def test_explicit_complete_overrides_sparse_logs():
    from app.models import UserDayState
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        _add_meal(s, user.id, d, 300)
        s.add(UserDayState(
            user_id=user.id,
            day_key=d,
            nutrition_log_status="complete",
            nutrition_log_status_source="test",
        ))
        s.commit()
        result = classify_nutrition_day(s, user.id, d, calorie_target=2200)
    assert result.status == "complete", result
    assert result.confidence == 1.0
    assert result.intake_basis == "explicit", result
    _ok("explicit complete wins")


def test_all_plan_meals_checked_is_complete():
    from app.models import UserDayState
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        s.add(UserDayState(
            user_id=user.id,
            day_key=d,
            meal_checks={"meal_0": True, "meal_1": True, "meal_2": True},
            nutrition_plan={
                "targets": {"calories": 2200},
                "meals": [
                    {"meal": "Breakfast", "calories": 500},
                    {"meal": "Lunch", "calories": 700},
                    {"meal": "Dinner", "calories": 800},
                ],
            },
        ))
        s.commit()
        result = classify_nutrition_day(s, user.id, d)
    assert result.status == "complete", result
    assert result.source == "plan_checks"
    # No meals were logged, so the complete status is grounded in plan checks,
    # not a real calorie total — downstream must not treat 0 kcal as intake.
    assert result.logged_calories == 0.0, result
    assert result.intake_basis == "plan_checks", result
    assert result.usable_for_recovery
    _ok("checked planned meals infer complete")


def test_partial_rollups_do_not_count_as_logged_days():
    from app.models import DailyRollup
    from app.services.coach.rollups import _aggregate_window
    today = date.today()
    rows = [
        DailyRollup(
            user_id=1,
            day=today - timedelta(days=i),
            kcal=500,
            protein_g=25,
            meals_logged=1,
            kcal_target=2200,
            protein_target_g=160,
            nutrition_log_status="partial",
            nutrition_log_confidence=0.35,
        )
        for i in range(7)
    ]
    agg = _aggregate_window(rows)
    assert agg.days_logged == 0
    assert agg.kcal_avg is None
    _ok("partial days do not drive coach nutrition rollups")


def _three_meal_plan_state(s: Session, user_id: int, d: date, meal_checks: dict) -> None:
    from app.models import UserDayState
    s.add(UserDayState(
        user_id=user_id,
        day_key=d,
        meal_checks=meal_checks,
        nutrition_plan={
            "targets": {"calories": 2200},
            "meals": [
                {"meal": "Breakfast", "calories": 500},
                {"meal": "Lunch", "calories": 700},
                {"meal": "Dinner", "calories": 800},
            ],
        },
    ))
    s.commit()


def test_some_plan_checks_with_strong_logs_is_rough_estimate():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        _three_meal_plan_state(s, user.id, d, {"meal_0": True})
        _add_meal(s, user.id, d, 900)
        _add_meal(s, user.id, d, 900)
        result = classify_nutrition_day(s, user.id, d)
    # One planned meal checked, but logged totals already cover the day, so the
    # logged-total heuristic wins over the partial-check short-circuit.
    assert result.status == "rough_estimate", result
    assert result.source == "logged_totals", result
    assert result.usable_for_recovery
    _ok("some plan checks + strong logs = rough estimate")


def test_some_plan_checks_with_weak_logs_is_partial():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        _three_meal_plan_state(s, user.id, d, {"meal_0": True})
        _add_meal(s, user.id, d, 300)
        result = classify_nutrition_day(s, user.id, d)
    assert result.status == "partial", result
    assert result.source == "plan_checks", result
    assert "checked off" in result.reason.lower(), result
    assert "incomplete" in result.reason.lower(), result
    assert not result.usable_for_recovery
    _ok("some plan checks + weak logs = partial with reason")


def test_three_tiny_meals_stay_partial():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        for _ in range(3):
            _add_meal(s, user.id, d, 100)
        result = classify_nutrition_day(s, user.id, d, calorie_target=2200)
    # meal-count coverage alone (3 >= 3) no longer earns rough estimate.
    assert result.status == "partial", result
    assert not result.usable_for_recovery
    _ok("three tiny meals stay partial")


def test_three_solid_meals_no_target_is_rough_estimate():
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        for _ in range(3):
            _add_meal(s, user.id, d, 500)
        result = classify_nutrition_day(s, user.id, d)
    # No calorie target: meal-count coverage plus a sane calorie floor (1500).
    assert result.status == "rough_estimate", result
    assert result.usable_for_recovery
    _ok("three solid meals with no target = rough estimate")


def test_active_plan_meals_removal_modes():
    from app.services.nutrition.day_completeness import _active_plan_meals
    base = [
        {"id": "abc", "meal": "Breakfast"},
        {"id": "def", "meal": "Lunch"},
        {"id": "ghi", "meal": "Dinner"},
    ]
    by_index = _active_plan_meals({"meals": base, "removedMealIds": ["1"]})
    assert len(by_index) == 2 and all(m["id"] != "def" for m in by_index), by_index

    by_prefixed = _active_plan_meals({"meals": base, "removedMealIds": ["meal_1"]})
    assert len(by_prefixed) == 2 and all(m["id"] != "def" for m in by_prefixed), by_prefixed

    by_stable = _active_plan_meals({"meals": base, "removedMealIds": ["def"]})
    assert len(by_stable) == 2 and all(m["id"] != "def" for m in by_stable), by_stable

    alt = [{"meal_id": 10}, {"mealId": 20}, {"id": 30}]
    by_alt = _active_plan_meals({"meals": alt, "removedMealIds": ["20"]})
    assert len(by_alt) == 2 and {"mealId": 20} not in by_alt, by_alt
    _ok("removed plan meals work by index, meal_{idx}, and stable id")


def test_invalid_explicit_status_falls_back_to_inference():
    from app.models import UserDayState
    from app.services.nutrition.day_completeness import classify_nutrition_day
    engine = _make_engine()
    with Session(engine) as s:
        user = _seed_user(s)
        d = date.today()
        s.add(UserDayState(
            user_id=user.id,
            day_key=d,
            nutrition_log_status="not-a-real-status",
            nutrition_log_status_source="test",
        ))
        s.commit()
        _add_meal(s, user.id, d, 900)
        _add_meal(s, user.id, d, 900)
        result = classify_nutrition_day(s, user.id, d, calorie_target=2200)
    # Garbage explicit status is ignored; inference still classifies the day.
    assert result.status == "rough_estimate", result
    assert result.source == "logged_totals", result
    _ok("invalid explicit status is ignored, inference runs")


cases = [
    test_empty_day_is_unknown,
    test_single_small_meal_is_partial,
    test_fullish_logged_day_is_rough_estimate,
    test_explicit_complete_overrides_sparse_logs,
    test_all_plan_meals_checked_is_complete,
    test_some_plan_checks_with_strong_logs_is_rough_estimate,
    test_some_plan_checks_with_weak_logs_is_partial,
    test_three_tiny_meals_stay_partial,
    test_three_solid_meals_no_target_is_rough_estimate,
    test_active_plan_meals_removal_modes,
    test_invalid_explicit_status_falls_back_to_inference,
    test_partial_rollups_do_not_count_as_logged_days,
]


if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
