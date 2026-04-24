from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import text
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./workoutpal.db")

# SQLite needs check_same_thread=False; PostgreSQL doesn't use it
connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}

# Pool tuning — reasonable defaults for a small pilot on App Runner / RDS.
# Overridable via env for headroom without a redeploy.
_is_postgres = DATABASE_URL.startswith("postgres")
engine = create_engine(
    DATABASE_URL,
    connect_args=connect_args,
    echo=False,
    pool_pre_ping=True,  # detect + drop stale connections before handing them out
    **(
        {
            "pool_size": int(os.getenv("DB_POOL_SIZE", "20")),
            "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "10")),
            "pool_recycle": int(os.getenv("DB_POOL_RECYCLE_SECS", "3600")),
            "pool_timeout": int(os.getenv("DB_POOL_TIMEOUT_SECS", "30")),
        }
        if _is_postgres else {}
    ),
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


def _ensure_user_recovery_columns() -> None:
    """Add recovery_question / recovery_answer_hash columns to `user` if missing."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS recovery_question VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS recovery_answer_hash VARCHAR'
            ))
    except Exception as e:
        print(f"[migration] user recovery columns add failed (non-fatal): {e}")


def _ensure_workout_completion_stimulus_column() -> None:
    """Add the `stimulus` column to workout_completions if missing."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS stimulus VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] workout_completions stimulus column add failed (non-fatal): {e}")


def _ensure_workout_completion_health_columns() -> None:
    """Add calories_burned + hr_summary columns to workout_completions if missing."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS calories_burned INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS hr_summary JSONB"
            ))
    except Exception as e:
        print(f"[migration] workout_completions health columns add failed (non-fatal): {e}")


def _ensure_exercise_tracking_mode_column() -> None:
    """Add Exercise.default_tracking_mode if missing. Required for the
    timed/distance exercise flag (planks, carries). Existing rows default
    to "reps" — the seed re-run will update the right ones (planks → time,
    sled drag → distance) immediately after this migration finishes."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercises "
                "ADD COLUMN IF NOT EXISTS default_tracking_mode VARCHAR DEFAULT 'reps'"
            ))
    except Exception as e:
        print(f"[migration] exercise default_tracking_mode column add failed (non-fatal): {e}")


def _ensure_food_metadata_classifier_v2_columns() -> None:
    """Add protein_source + probiotic_flag to food_metadata. Needed when a
    v1 FoodMetadata table already exists; new DBs get these via create_all.
    The classifier backfill (triggered by CLASSIFIER_VERSION bump in
    food_classifier.py) will populate non-default values on next run."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE food_metadata "
                "ADD COLUMN IF NOT EXISTS protein_source VARCHAR DEFAULT 'unknown'"
            ))
            conn.execute(text(
                "ALTER TABLE food_metadata "
                "ADD COLUMN IF NOT EXISTS probiotic_flag BOOLEAN DEFAULT FALSE"
            ))
    except Exception as e:
        print(f"[migration] food_metadata classifier-v2 columns add failed (non-fatal): {e}")


def _ensure_daily_nutrition_metrics_v2_columns() -> None:
    """Add plant/animal protein + probiotic servings to daily_nutrition_metrics.
    Populated on the next backfill run (METRICS_VERSION bumped to 2, which
    re-computes every stored day)."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for col_sql in (
                "ADD COLUMN IF NOT EXISTS plant_protein_g DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS animal_protein_g DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS probiotic_servings DOUBLE PRECISION DEFAULT 0",
            ):
                conn.execute(text(f"ALTER TABLE daily_nutrition_metrics {col_sql}"))
    except Exception as e:
        print(f"[migration] daily_nutrition_metrics v2 columns add failed (non-fatal): {e}")


def _ensure_exercise_video_id_column() -> None:
    """Add Exercise.video_id (curated YouTube video ID) if missing.
    Nullable — most exercises stay unset and the client falls back to
    a YouTube search card for those."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercises "
                "ADD COLUMN IF NOT EXISTS video_id VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] exercise video_id column add failed (non-fatal): {e}")


def _ensure_nutrition_v3_columns() -> None:
    """v3: added_sugar_g on food_nutrition; seafood/fruit/vegetable/alcohol
    /processed_meat/refined_grain flags on food_metadata; per-day tag
    aggregates, recovery_flags JSON, energy_availability, and
    max_meal_protein_pct on daily_nutrition_metrics. All idempotent — safe
    to run on existing DBs, populated on next classify + metrics recompute."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE food_nutrition "
                "ADD COLUMN IF NOT EXISTS added_sugar_g DOUBLE PRECISION"
            ))
            for flag in (
                "seafood_flag", "fruit_flag", "vegetable_flag",
                "alcohol_flag", "processed_meat_flag", "refined_grain_flag",
            ):
                conn.execute(text(
                    f"ALTER TABLE food_metadata "
                    f"ADD COLUMN IF NOT EXISTS {flag} BOOLEAN DEFAULT FALSE"
                ))
            for col in (
                "ADD COLUMN IF NOT EXISTS added_sugar_g DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS sodium_mg DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS seafood_servings DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS fruit_servings DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS vegetable_servings DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS alcohol_servings DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS processed_meat_servings DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS refined_grain_servings DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS max_meal_protein_pct DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS energy_availability DOUBLE PRECISION DEFAULT 0",
                "ADD COLUMN IF NOT EXISTS recovery_flags JSONB",
            ):
                conn.execute(text(f"ALTER TABLE daily_nutrition_metrics {col}"))
    except Exception as e:
        print(f"[migration] nutrition v3 columns add failed (non-fatal): {e}")


def _backfill_exercise_video_ids() -> None:
    """Populate Exercise.video_id from the curated slug → YouTube ID map.
    Safe to run every startup: only writes when the row's video_id is
    currently NULL/empty and the slug is in the map."""
    from sqlmodel import select
    from app.models import Exercise
    from app.seed_exercise_videos import EXERCISE_VIDEOS
    try:
        with Session(engine) as session:
            rows = session.exec(select(Exercise)).all()
            patched = 0
            for ex in rows:
                if ex.video_id:
                    continue
                vid = EXERCISE_VIDEOS.get((ex.slug or "").lower().strip())
                if vid:
                    ex.video_id = vid
                    session.add(ex)
                    patched += 1
            if patched > 0:
                session.commit()
                print(f"[migration] seeded video_id on {patched} exercises")
    except Exception as e:
        print(f"[migration] exercise video_id backfill failed (non-fatal): {e}")


def _autoscrape_missing_video_ids() -> None:
    """Background task: for every Exercise row still missing a video_id
    after the curated backfill, scrape YouTube for "{name} proper form
    tutorial" and store the first embeddable result. Runs in a daemon
    thread so it never blocks server startup; takes ~3-8 seconds per
    exercise × however many rows are missing (typically <100), so a
    first boot can be a few minutes of background work.

    Idempotent: each subsequent run is a no-op because every row now
    has a video_id. Safe to call on every startup.
    """
    import threading
    from sqlmodel import select
    from app.models import Exercise
    from app.services.workout.video_resolver import find_youtube_video_id

    def _worker() -> None:
        try:
            with Session(engine) as session:
                rows = session.exec(
                    select(Exercise).where(Exercise.video_id.is_(None))  # type: ignore[union-attr]
                ).all()
                if not rows:
                    return
                print(f"[migration] autoscrape: {len(rows)} exercises missing video_id — resolving in background")
                patched = 0
                for ex in rows:
                    try:
                        vid = find_youtube_video_id(ex.name)
                    except Exception:
                        vid = None
                    if not vid:
                        continue
                    # Re-fetch a fresh row inside a new session to avoid
                    # holding the whole library in memory across slow
                    # network calls.
                    with Session(engine) as s2:
                        target = s2.get(Exercise, ex.id)
                        if target and not target.video_id:
                            target.video_id = vid
                            s2.add(target)
                            s2.commit()
                            patched += 1
                print(f"[migration] autoscrape: populated video_id on {patched}/{len(rows)} exercises")
        except Exception as e:
            print(f"[migration] autoscrape failed (non-fatal): {e}")

    threading.Thread(target=_worker, daemon=True, name="video_autoscrape").start()


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
    from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood, Equipment, ExerciseEquipment, GoalOption, PaceOption, User, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState, DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob, UserState, WorkoutPlan, NutritionPlan, FoodMetadata, DailyNutritionMetrics, WorkoutCompletion, BodyScan

    SQLModel.metadata.create_all(engine)
    _ensure_food_category_enum_values()
    _ensure_food_nutrition_extras_column()
    _ensure_workout_completion_stimulus_column()
    _ensure_workout_completion_health_columns()
    _ensure_user_recovery_columns()
    _ensure_exercise_tracking_mode_column()
    _ensure_exercise_video_id_column()
    _ensure_food_metadata_classifier_v2_columns()
    _ensure_daily_nutrition_metrics_v2_columns()
    _ensure_nutrition_v3_columns()
    _backfill_exercise_video_ids()
    _autoscrape_missing_video_ids()
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
