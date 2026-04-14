from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import text
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./workoutpal.db")

# SQLite needs check_same_thread=False; PostgreSQL doesn't use it
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    echo=False,
    pool_pre_ping=True,  # reconnect stale connections (useful for PostgreSQL)
)


def _ensure_food_category_enum_values() -> None:
    """Idempotent migration helper for FoodCategory enum growth.

    `SQLModel.metadata.create_all` creates tables but does NOT alter an
    existing Postgres enum type when the Python enum gains values. This
    adds any missing values in-place so existing databases don't need a
    wipe when we expand FoodCategory. No-op on SQLite.

    IMPORTANT: SAEnum serializes using the enum MEMBER NAME (uppercase),
    not the lowercase string value. So the Postgres type holds values
    like 'PROTEINS', 'DAIRY', etc. We must add new members using `.name`
    to match — if you add the `.value` instead, inserts will fail with
    "invalid input value for enum foodcategory: 'CONDIMENTS'".
    """
    from app.enums import FoodCategory

    if engine.dialect.name != "postgresql":
        return
    # `ALTER TYPE ... ADD VALUE IF NOT EXISTS` must run in autocommit mode
    # on Postgres < 12; harmless on >= 12.
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for member in FoodCategory:
                # `name` = SAEnum default serialization form (uppercase).
                conn.execute(
                    text(f"ALTER TYPE foodcategory ADD VALUE IF NOT EXISTS '{member.name}'")
                )
    except Exception as e:
        print(f"[migration] food category enum expand failed (non-fatal): {e}")


def _ensure_food_nutrition_extras_column() -> None:
    """Idempotent migration: add the `extra_nutrients` JSON column to
    `food_nutrition` if it doesn't exist. SQLModel.create_all only creates
    *missing tables* — it never adds columns to existing tables. Without
    this helper, deploying the new micronutrient model on top of an
    existing prod DB would silently produce inserts that drop the JSON
    column on the floor."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE food_nutrition "
                "ADD COLUMN IF NOT EXISTS extra_nutrients JSONB"
            ))
    except Exception as e:
        print(f"[migration] food_nutrition extras column add failed (non-fatal): {e}")


def _backfill_custom_food_micronutrients() -> None:
    """One-shot backfill: walk every FoodNutrition row whose `extra_nutrients`
    is NULL/empty, look the food name up in the seed micronutrient table,
    and fill in both the legacy columns (fiber/sugar/sodium) and the JSON
    panel. Runs on startup — idempotent because matching rows re-compute
    the same values, and unmatched rows stay unchanged.

    This exists because `create_food_with_nutrition` historically stored
    custom foods with empty micros, so the Nutrition Details card showed
    blanks for any meal built from user/AI-scanned foods."""
    from sqlmodel import select
    from app.models import Food, FoodNutrition
    from app.seed_micronutrients_data import (
        get_micronutrients_for,
        split_into_columns_and_extras,
    )
    try:
        with Session(engine) as session:
            rows = session.exec(
                select(FoodNutrition, Food).join(Food, Food.id == FoodNutrition.food_id)
            ).all()
            patched = 0
            for nutrition, food in rows:
                if nutrition.extra_nutrients:
                    continue
                panel = get_micronutrients_for(food.name)
                if not panel:
                    continue
                top, extras = split_into_columns_and_extras(panel)
                if (nutrition.fiber or 0) == 0 and "fiber" in top:
                    nutrition.fiber = top["fiber"]
                if (nutrition.sugar or 0) == 0 and "sugar" in top:
                    nutrition.sugar = top["sugar"]
                if (nutrition.sodium_mg or 0) == 0 and "sodium_mg" in top:
                    nutrition.sodium_mg = top["sodium_mg"]
                nutrition.extra_nutrients = extras
                session.add(nutrition)
                patched += 1
            if patched > 0:
                session.commit()
                print(f"[migration] backfilled micronutrients for {patched} food rows")
    except Exception as e:
        print(f"[migration] micronutrient backfill failed (non-fatal): {e}")


def create_db_and_tables():
    # Import all models to register them with SQLModel.metadata
    from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood, Equipment, ExerciseEquipment, GoalOption, PaceOption, User, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState, DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob, UserState

    SQLModel.metadata.create_all(engine)
    _ensure_food_category_enum_values()
    _ensure_food_nutrition_extras_column()
    _backfill_custom_food_micronutrients()
    from app.seed import seed_equipment, seed_exercises, seed_foods, seed_goals
    with Session(engine) as session:
        seed_equipment(session)   # must run before exercises (FK dependency)
        seed_exercises(session)
        seed_foods(session)
        seed_goals(session)


def get_session():
    with Session(engine) as session:
        yield session
