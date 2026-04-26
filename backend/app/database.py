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
    """Add calories_burned + hr_summary + post-workout feedback columns
    to workout_completions if missing. Feedback fields (feeling /
    intensity / soreness_areas / feedback_notes) are read by
    weekly_review's struggle metrics + the trainer context."""
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
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS feeling VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS intensity INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS soreness_areas JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS feedback_notes TEXT"
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


def _backfill_mealitem_food_ids() -> None:
    """One-shot backfill: resolve `food_id` on MealItems where it's
    NULL but the `food_name` matches a Food row. Without this,
    previously-logged meal items miss the FoodNutrition join and
    fiber / sodium / added_sugar / saturated_fat all come out zero
    for those days. Idempotent — rows that already have a food_id
    are skipped, and rows whose name can't be matched stay NULL.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            # Resolve + update in a single pass. Uses normalized_name
            # for matching to handle case / whitespace variants.
            # Tolerant match: both sides lowercase + strip parens +
            # collapse whitespace. Handles `"Spinach (Raw)"` vs Food row
            # `"Spinach Raw"` (normalized_name = `"spinach raw"`), and
            # other variants where punctuation diverges.
            result = conn.execute(text("""
                UPDATE meal_items mi
                SET food_id = f.id
                FROM foods f
                WHERE mi.food_id IS NULL
                  AND TRIM(regexp_replace(LOWER(mi.food_name), '[^a-z0-9]+', ' ', 'g'))
                      = TRIM(regexp_replace(f.normalized_name, '[^a-z0-9]+', ' ', 'g'))
            """))
            n = result.rowcount or 0
            if n > 0:
                print(f"[migration] mealitem food_id backfill matched {n} rows")
    except Exception as e:
        print(f"[migration] mealitem food_id backfill failed (non-fatal): {e}")


def _recompute_recent_daily_metrics() -> None:
    """After the food_id backfill, the classifier + fiber sums change,
    so recompute DailyNutritionMetrics for anyone with a row in the
    last 14 days. Cheap — each recompute is a per-day query. Users
    who haven't logged anything stay untouched."""
    from datetime import date, timedelta
    from sqlmodel import select
    from app.models import DailyNutritionMetrics
    try:
        with Session(engine) as session:
            cutoff = date.today() - timedelta(days=14)
            rows = session.exec(
                select(DailyNutritionMetrics)
                .where(DailyNutritionMetrics.metric_date >= cutoff)
            ).all()
            if not rows:
                return
            from app.services.nutrition.gut_health import compute_daily_metrics
            done = 0
            for row in rows:
                try:
                    compute_daily_metrics(session, user_id=row.user_id, metric_date=row.metric_date, allow_ai=False)
                    done += 1
                except Exception:
                    continue
            print(f"[migration] recomputed daily metrics for {done} user-day rows")
    except Exception as e:
        print(f"[migration] recompute daily metrics failed (non-fatal): {e}")


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


def _seed_supplement_ingredients() -> None:
    """Seed the common supplement ingredient catalog with evidence +
    risk tiers. Idempotent — existing slugs are left alone; new rows
    added on first startup after the migration."""
    from sqlmodel import select
    from app.models import SupplementIngredient

    seeds = [
        # slug, name, category, default_unit, evidence, risk, description, timing, safety
        ("creatine_monohydrate", "Creatine Monohydrate", "performance", "g", "strong", "low",
         "Among the most-studied supplements. Supports strength + lean mass across training styles.",
         "Daily, any time — consistency matters more than timing.",
         "Stay hydrated. Discuss with a clinician if you have kidney disease."),
        ("whey_protein", "Whey Protein", "protein", "g", "strong", "low",
         "Convenient protein source. Useful when whole-food protein intake is consistently low.",
         "Post-workout or any meal where you're short on protein.",
         None),
        ("caffeine", "Caffeine", "stimulant", "mg", "strong", "moderate",
         "Ergogenic aid for training performance. Dose-dependent effects on sleep, anxiety, heart rate.",
         "Morning / pre-workout. Avoid within 6–8 hours of bedtime.",
         "Limit total daily intake. Caution with heart conditions or pregnancy."),
        ("vitamin_d3", "Vitamin D3", "vitamin", "IU", "moderate", "moderate",
         "May support bone + immune function. Blood levels vary widely — dosing should ideally be guided by bloodwork.",
         "With a fat-containing meal for better absorption.",
         "High long-term doses can be harmful. Discuss with a clinician."),
        ("omega_3", "Omega-3 (EPA/DHA)", "fatty_acid", "mg", "moderate", "low",
         "Provides EPA/DHA when fish intake is low. May support cardiovascular + inflammatory markers.",
         "Any meal with fat.",
         "High doses (>3g combined EPA+DHA) may increase bleeding risk."),
        ("magnesium", "Magnesium", "mineral", "mg", "limited", "low",
         "Supports many metabolic pathways. Most benefit seen in people with low dietary intake.",
         "Evening, with or without food.",
         "Citrate/oxide forms can cause loose stools at higher doses."),
        ("electrolytes", "Electrolytes", "mineral", "serving", "moderate", "low",
         "Useful during heavy sweating, long training sessions, or hot climates.",
         "During/after training; during hot days.",
         "Read sodium content on labels if you're managing blood pressure."),
        ("iron", "Iron", "mineral", "mg", "moderate", "moderate",
         "Targeted use for diagnosed deficiency. Not recommended without bloodwork.",
         "On an empty stomach when tolerated; with vitamin C aids absorption.",
         "Excess iron is harmful. Do not supplement without a blood test."),
        ("vitamin_b12", "Vitamin B12", "vitamin", "mcg", "moderate", "low",
         "Particularly useful for vegans/vegetarians or adults over 50.",
         "Any time.",
         None),
        ("beta_alanine", "Beta-Alanine", "performance", "g", "moderate", "low",
         "May support repeated high-intensity efforts in the 1–4 minute range.",
         "Split across the day to minimize tingling sensation.",
         "Causes harmless paresthesia (tingling) at higher single doses."),
    ]
    try:
        with Session(engine) as session:
            existing_slugs = {
                r.slug for r in session.exec(select(SupplementIngredient)).all()
            }
            added = 0
            for (slug, name, cat, unit, evid, risk, desc, timing, safety) in seeds:
                if slug in existing_slugs:
                    continue
                session.add(SupplementIngredient(
                    slug=slug, name=name, category=cat, default_unit=unit,
                    evidence_tier=evid, risk_tier=risk,
                    description=desc, timing_notes=timing, safety_notes=safety,
                ))
                added += 1
            if added:
                session.commit()
                print(f"[migration] seeded {added} supplement ingredients")
    except Exception as e:
        print(f"[migration] supplement ingredient seed failed (non-fatal): {e}")


def _ensure_meal_consumed_at_column() -> None:
    """Add `consumed_at` timestamp + new meal_type enum values.

    `meal_type` is a Postgres enum and `ALTER TYPE ... ADD VALUE` is how
    we grow it in-place. `consumed_at` is a plain nullable timestamptz
    — existing rows get NULL and the client falls back to meal_date +
    noon for display.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE meals ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meals_consumed_at ON meals(user_id, consumed_at)"
            ))
            # PRE_WORKOUT / POST_WORKOUT aren't in the Postgres enum on
            # existing DBs — add them. SAEnum serializes by member name
            # (uppercase), so this is what Postgres expects.
            for member in ("PRE_WORKOUT", "POST_WORKOUT"):
                conn.execute(text(
                    f"ALTER TYPE mealtype ADD VALUE IF NOT EXISTS '{member}'"
                ))
    except Exception as e:
        print(f"[migration] meal consumed_at / meal_type add failed (non-fatal): {e}")


def _ensure_exercise_set_actual_rir_column() -> None:
    """Add `actual_rir` to exercise_sets — drives rolling e1RM + the
    in-workout coach's progression decisions. Idempotent."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS actual_rir DOUBLE PRECISION",
            ))
    except Exception as e:
        print(f"[migration] exercise_sets actual_rir add failed (non-fatal): {e}")


def _ensure_food_metadata_amounts_columns() -> None:
    """Add AI-estimated amount columns to food_metadata.

    `collagen_g_per_serving` + `probiotic_servings_per_serving` carry
    nutrient estimates USDA doesn't label. `amount_confidence` lets
    downstream UIs fade out low-confidence numbers. Also extends
    daily_nutrition_metrics with `collagen_g` so day-level totals can
    aggregate from per-food amounts.

    Idempotent — safe to run on every startup."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS collagen_g_per_serving DOUBLE PRECISION",
            ))
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS probiotic_servings_per_serving DOUBLE PRECISION",
            ))
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS amount_confidence VARCHAR(16) DEFAULT 'none'",
            ))
            conn.execute(text(
                "ALTER TABLE daily_nutrition_metrics ADD COLUMN IF NOT EXISTS collagen_g DOUBLE PRECISION DEFAULT 0",
            ))
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS probiotic_cfu_billions_per_serving DOUBLE PRECISION",
            ))
            conn.execute(text(
                "ALTER TABLE daily_nutrition_metrics ADD COLUMN IF NOT EXISTS probiotic_cfu_billions DOUBLE PRECISION DEFAULT 0",
            ))
    except Exception as e:
        print(f"[migration] food_metadata / daily_metrics amount columns add failed (non-fatal): {e}")


def _ensure_daily_health_snapshot_table() -> None:
    """Create `daily_health_snapshots` if missing and add the unique
    `(user_id, snapshot_date)` constraint. SQLModel.create_all already
    handles the table itself, so this guarantees the constraint exists
    on legacy DBs that may have an older partial table.

    Idempotent — safe to run on every startup.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_health_snapshot "
                "ON daily_health_snapshots (user_id, snapshot_date)"
            ))
    except Exception as e:
        print(f"[migration] daily_health_snapshots constraint ensure failed (non-fatal): {e}")


def _ensure_user_profile_birthdate_column() -> None:
    """Add nullable `birthdate` to user_profiles. Existing rows get NULL;
    the profile router treats a NULL birthdate as "not filled in" and
    falls back to the stored `age` int. A soft-prompt on the client
    backfills it on next app open."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS birthdate DATE"
            ))
    except Exception as e:
        print(f"[migration] user_profiles birthdate add failed (non-fatal): {e}")


def _ensure_social_tables() -> None:
    """Create indexes for the social tables on legacy DBs. SQLModel
    create_all builds the tables themselves; this just guarantees the
    pair-uniqueness + week-uniqueness constraints exist.

    Idempotent — safe on every startup.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_friendship_pair "
                "ON friendships (user_a_id, user_b_id)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_digest_user_week "
                "ON weekly_digest_cache (user_id, week_start)"
            ))
    except Exception as e:
        print(f"[migration] social indexes ensure failed (non-fatal): {e}")


def create_db_and_tables():
    # Import all models to register them with SQLModel.metadata
    from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood, Equipment, ExerciseEquipment, GoalOption, PaceOption, User, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState, DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob, UserState, WorkoutPlan, NutritionPlan, FoodMetadata, DailyNutritionMetrics, WorkoutCompletion, BodyScan, SavedMeal, SupplementIngredient, SupplementProduct, SupplementProductIngredient, UserSupplementStack, SupplementLog, SleepLog, SupplementAICache, DailyHealthSnapshot, UserSocialProfile, Friendship, WeeklyDigestCache

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
    _ensure_meal_consumed_at_column()
    _ensure_user_profile_birthdate_column()
    _ensure_food_metadata_amounts_columns()
    _ensure_exercise_set_actual_rir_column()
    _ensure_daily_health_snapshot_table()
    _ensure_social_tables()
    _backfill_exercise_video_ids()
    _autoscrape_missing_video_ids()
    _backfill_custom_food_micronutrients()
    _backfill_mealitem_food_ids()
    _recompute_recent_daily_metrics()
    _seed_supplement_ingredients()
    from app.seed import seed_equipment, seed_exercises, seed_foods, seed_goals
    with Session(engine) as session:
        seed_equipment(session)   # must run before exercises (FK dependency)
        seed_exercises(session)
        seed_foods(session)
        seed_goals(session)


def get_session():
    with Session(engine) as session:
        yield session
