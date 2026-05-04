from sqlmodel import SQLModel, create_engine, Session
from sqlalchemy import bindparam, text
from dotenv import load_dotenv
import os
from collections.abc import Mapping

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


def _ensure_food_search_indexes() -> None:
    """Add trigram/composite indexes for fast local food search.

    The app's broad catalog grows as users select USDA/barcode foods. Plain
    `%term%` lookups on normalized names and aliases do not use the default
    btree indexes, so Postgres needs pg_trgm indexes to keep search feeling
    instant once the catalog is no longer just the curated seed set.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_foods_normalized_name_trgm "
                "ON foods USING GIN (normalized_name gin_trgm_ops)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_food_aliases_alias_normalized_trgm "
                "ON food_aliases USING GIN (alias_normalized gin_trgm_ops)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_foods_search_visibility "
                "ON foods (is_active, owner_user_id, source, normalized_name)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_recent_foods_user_last_used "
                "ON user_recent_foods (user_id, last_used_at DESC)"
            ))
    except Exception as e:
        print(f"[migration] food search indexes ensure failed (non-fatal): {e}")


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


def _ensure_user_subscription_tier_column() -> None:
    """Add server-authoritative subscription tier to users.

    Client-side tier flags are display hints only; paid feature access
    checks read this column on every authenticated request.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        backfill_marker = "subscription_tier_existing_users_pro_backfill_20260501"
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE TABLE IF NOT EXISTS app_migrations ("
                "name VARCHAR PRIMARY KEY, "
                "applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
                ")"
            ))
            conn.execute(text(
                'ALTER TABLE "user" '
                "ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR DEFAULT 'free'"
            ))
            conn.execute(text(
                'ALTER TABLE "user" '
                "ALTER COLUMN subscription_tier SET DEFAULT 'free'"
            ))
            conn.execute(text(
                'UPDATE "user" SET subscription_tier = CASE '
                "WHEN lower(trim(COALESCE(subscription_tier, ''))) = 'pro' THEN 'pro' "
                "ELSE 'free' END"
            ))
            applied = conn.execute(
                text("SELECT 1 FROM app_migrations WHERE name = :name"),
                {"name": backfill_marker},
            ).first()
            if applied is None and os.getenv("BETA_BACKFILL_EXISTING_USERS_TO_PRO", "0") == "1":
                conn.execute(text(
                    'UPDATE "user" SET subscription_tier = \'pro\' '
                    "WHERE subscription_tier IS NULL "
                    "OR subscription_tier = '' "
                    "OR lower(subscription_tier) = 'free'"
                ))
                conn.execute(
                    text("INSERT INTO app_migrations (name) VALUES (:name)"),
                    {"name": backfill_marker},
                )
            elif applied is None:
                conn.execute(
                    text("INSERT INTO app_migrations (name) VALUES (:name)"),
                    {"name": backfill_marker},
                )
            conn.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_user_subscription_tier '
                'ON "user"(subscription_tier)'
            ))
    except Exception as e:
        print(f"[migration] user subscription_tier column add failed (non-fatal): {e}")


def _ensure_user_plan_cadence_anchor_column() -> None:
    """Add `plan_cadence_anchor` to users + backfill from earliest PlanWeek.

    The anchor day persists the user's "sign-up weekday" so plan-week
    auto-renewal stays on the same day-of-week cadence forever, even if
    PlanWeek rows are wiped, regenerated, or get out-of-sync across
    devices. Backfill walks every existing user's earliest PlanWeek
    and copies its `start_date` into `plan_cadence_anchor`. Marker
    prevents the backfill from running twice — subsequent renewals
    are responsible for keeping the anchor in sync (they don't need to
    update it; the anchor is set once and never moves).
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        backfill_marker = "user_plan_cadence_anchor_backfill_20260502"
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE TABLE IF NOT EXISTS app_migrations ("
                "name VARCHAR PRIMARY KEY, "
                "applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()"
                ")"
            ))
            conn.execute(text(
                'ALTER TABLE "user" '
                "ADD COLUMN IF NOT EXISTS plan_cadence_anchor DATE"
            ))
            applied = conn.execute(
                text("SELECT 1 FROM app_migrations WHERE name = :name"),
                {"name": backfill_marker},
            ).first()
            if applied is None:
                # Backfill: earliest plan_weeks.start_date per user.
                # NULL when a user has no PlanWeek yet — the anchor will
                # be set lazily on their first PlanWeek creation
                # (`set_plan_cadence_anchor_if_unset`).
                conn.execute(text(
                    'UPDATE "user" u '
                    'SET plan_cadence_anchor = sub.first_start '
                    'FROM ( '
                    '  SELECT user_id, MIN(start_date) AS first_start '
                    '  FROM plan_weeks '
                    '  GROUP BY user_id '
                    ') sub '
                    'WHERE sub.user_id = u.id '
                    'AND u.plan_cadence_anchor IS NULL'
                ))
                conn.execute(
                    text("INSERT INTO app_migrations (name) VALUES (:name)"),
                    {"name": backfill_marker},
                )
    except Exception as e:
        print(f"[migration] user plan_cadence_anchor column add/backfill failed (non-fatal): {e}")


def _ensure_user_goal_track_column() -> None:
    """Persist rich frontend goal ids alongside the legacy GoalType enum."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_goals "
                "ADD COLUMN IF NOT EXISTS goal_track VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] user_goals goal_track add failed (non-fatal): {e}")


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
    """Add distance/calories/HR + post-workout feedback columns
    to workout_completions if missing. Feedback fields (feeling /
    intensity / soreness_areas / feedback_notes) are read by
    weekly_review's struggle metrics + the trainer context."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS distance_miles DOUBLE PRECISION"
            ))
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


def _ensure_workout_history_source_columns() -> None:
    """Add source/origin + custom-exercise snapshots used by history rollups."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS source_context VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS template_id VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS plan_day_id INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE workout_exercises "
                "ADD COLUMN IF NOT EXISTS exercise_slug_snapshot VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_exercises "
                "ADD COLUMN IF NOT EXISTS primary_muscle_snapshot VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_exercises "
                "ADD COLUMN IF NOT EXISTS secondary_muscles_snapshot JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE workout_exercises "
                "ADD COLUMN IF NOT EXISTS is_compound_snapshot BOOLEAN"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_completion_source_context "
                "ON workout_completions(source_context)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_completion_plan_day_id "
                "ON workout_completions(plan_day_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_exercise_slug_snapshot "
                "ON workout_exercises(exercise_slug_snapshot)"
            ))
    except Exception as e:
        print(f"[migration] workout history source columns add failed (non-fatal): {e}")


def _ensure_user_preferences_equipment_settings_column() -> None:
    """Add strength-equipment load settings to user_preferences.

    This stores optional plate/dumbbell loading constraints separately
    from the owned-equipment list so existing profiles keep working.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS equipment_settings JSONB"
            ))
    except Exception as e:
        print(f"[migration] user_preferences equipment_settings add failed (non-fatal): {e}")


def _ensure_user_supplement_stack_group_column() -> None:
    """Add user-defined group label to user_supplement_stack.

    Lets users batch supplements beyond the built-in timing buckets
    ("Stack 1", "Travel pack", etc.). Nullable so existing rows keep
    working unchanged. Per-row index speeds up the grouped query the
    Today tab fires on every render.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_supplement_stack "
                "ADD COLUMN IF NOT EXISTS group_label VARCHAR"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_supp_stack_user_group "
                "ON user_supplement_stack(user_id, group_label)"
            ))
    except Exception as e:
        print(f"[migration] user_supplement_stack group_label add failed (non-fatal): {e}")


def _ensure_coach_apply_state_columns() -> None:
    """Add durable settings used by /coach/apply-action.

    These columns let accepted coach actions mutate the same settings a
    user can change directly, while keeping active PlanWeek rows fixed.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS workout_duration_minutes INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS core_frequency_per_week INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS preferred_split VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS injuries JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE user_coaching_state "
                "ADD COLUMN IF NOT EXISTS deload_until_date DATE"
            ))
            conn.execute(text(
                "ALTER TABLE user_day_state "
                "ADD COLUMN IF NOT EXISTS macro_overrides JSONB"
            ))
    except Exception as e:
        print(f"[migration] coach apply state columns add failed (non-fatal): {e}")


def _backfill_user_preferences_preferred_split() -> None:
    """Fill missing UserPreferences.preferred_split from reliable saved sources.

    Priority:
    1. The synced client `user_state.userProfile.preferredSplit` value,
       which represents what the user actually selected in-app.
    2. The explicit `plan_weeks.preferred_split` snapshot, if present.

    We intentionally do not infer from PlanDay labels. A NULL split may
    have produced an auto upper/lower-looking week, and writing that back
    would cement the wrong preference for users who had selected PPL.
    """
    if engine.dialect.name != "postgresql":
        return
    valid = ("full_body", "upper_lower", "ppl", "ppl_upper_lower", "bro")
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(
                text(
                    """
                    WITH state_splits AS (
                      SELECT
                        user_id,
                        lower(btrim(coalesce(
                          state_json -> 'userProfile' ->> 'preferredSplit',
                          state_json -> 'userProfile' ->> 'preferred_split'
                        ))) AS split
                      FROM user_state
                    )
                    UPDATE user_preferences p
                    SET preferred_split = s.split,
                        updated_at = NOW()
                    FROM state_splits s
                    WHERE s.user_id = p.user_id
                      AND (p.preferred_split IS NULL
                           OR btrim(p.preferred_split) = ''
                           OR lower(btrim(p.preferred_split)) = 'auto')
                      AND s.split IN :valid_splits
                    """
                ).bindparams(bindparam("valid_splits", expanding=True)),
                {"valid_splits": valid},
            )
            conn.execute(
                text(
                    """
                    WITH ranked_plan_splits AS (
                      SELECT
                        user_id,
                        lower(btrim(preferred_split)) AS split,
                        row_number() OVER (
                          PARTITION BY user_id
                          ORDER BY
                            CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                            start_date DESC NULLS LAST,
                            id DESC
                        ) AS rn
                      FROM plan_weeks
                      WHERE preferred_split IS NOT NULL
                        AND btrim(preferred_split) <> ''
                    )
                    UPDATE user_preferences p
                    SET preferred_split = r.split,
                        updated_at = NOW()
                    FROM ranked_plan_splits r
                    WHERE r.user_id = p.user_id
                      AND r.rn = 1
                      AND (p.preferred_split IS NULL
                           OR btrim(p.preferred_split) = ''
                           OR lower(btrim(p.preferred_split)) = 'auto')
                      AND r.split IN :valid_splits
                    """
                ).bindparams(bindparam("valid_splits", expanding=True)),
                {"valid_splits": valid},
            )
    except Exception as e:
        print(f"[migration] user preferred_split backfill failed (non-fatal): {e}")


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
    we grow it in-place. `consumed_at` is a plain nullable timestamptz;
    existing rows are backfilled from `created_at`.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE meals ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ"
            ))
            conn.execute(text(
                "UPDATE meals SET consumed_at = created_at WHERE consumed_at IS NULL"
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


def _ensure_exercise_set_duration_columns() -> None:
    """Add duration_seconds + comfort_rating to exercise_sets for
    stretch/mobility logging. Idempotent."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS duration_seconds INTEGER",
            ))
            conn.execute(text(
                "ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS comfort_rating INTEGER",
            ))
    except Exception as e:
        print(f"[migration] exercise_sets duration columns failed (non-fatal): {e}")


def _ensure_exercise_set_cardio_hr_columns() -> None:
    """Add actual_distance, actual_pace, heart_rate_avg, cardio_metrics
    to exercise_sets for cardio tracking + per-set HR capture."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS actual_distance DOUBLE PRECISION"))
            conn.execute(text("ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS actual_pace VARCHAR"))
            conn.execute(text("ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS heart_rate_avg INTEGER"))
            conn.execute(text("ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS cardio_metrics JSONB"))
    except Exception as e:
        print(f"[migration] exercise_sets cardio/HR columns failed (non-fatal): {e}")


def _ensure_user_equipment_profiles_table() -> None:
    """Create user_equipment_profiles if it doesn't exist.

    The table is created by SQLModel.metadata.create_all on a fresh DB.
    This migration creates it on legacy DBs that pre-date the feature.
    """
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS user_equipment_profiles (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    category VARCHAR NOT NULL DEFAULT 'cardio',
                    equipment_type VARCHAR NOT NULL DEFAULT '',
                    display_name VARCHAR NOT NULL DEFAULT '',
                    brand VARCHAR,
                    model_name VARCHAR,
                    location VARCHAR NOT NULL DEFAULT 'gym',
                    capabilities JSONB NOT NULL DEFAULT '[]',
                    notes TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_equipment_profiles_user_id "
                "ON user_equipment_profiles(user_id)"
            ))
    except Exception as e:
        print(f"[migration] user_equipment_profiles table failed (non-fatal): {e}")


def _ensure_gear_items_table() -> None:
    """Create gear_items if it doesn't exist (idempotent)."""
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS gear_items (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    name VARCHAR NOT NULL DEFAULT '',
                    gear_type VARCHAR NOT NULL DEFAULT 'other',
                    purchase_date DATE,
                    starting_miles FLOAT NOT NULL DEFAULT 0.0,
                    accumulated_miles FLOAT NOT NULL DEFAULT 0.0,
                    accumulated_sessions INTEGER NOT NULL DEFAULT 0,
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    retirement_threshold_miles FLOAT,
                    auto_track_keywords JSONB NOT NULL DEFAULT '[]',
                    notes TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_gear_items_user_id ON gear_items(user_id)"
            ))
    except Exception as e:
        print(f"[migration] gear_items table failed (non-fatal): {e}")


def _ensure_gear_items_photos_column() -> None:
    """Add photos JSONB column to gear_items if missing (idempotent)."""
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS photos JSONB DEFAULT '[]'"
            ))
    except Exception as e:
        print(f"[migration] gear_items photos column failed (non-fatal): {e}")


def _ensure_gear_items_usage_columns() -> None:
    """Add usage-tracking columns to gear_items so non-mileage gear (boxing
    gloves, lifting belts, yoga mats) has meaningful telemetry: a session-
    based retirement threshold + a last-used timestamp for the "Last used X
    ago" UI strip. Idempotent."""
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS retirement_threshold_sessions INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE gear_items ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ"
            ))
    except Exception as e:
        print(f"[migration] gear_items usage columns failed (non-fatal): {e}")


def _ensure_weekly_checkin_body_columns() -> None:
    """Add body_fat_pct / bp_systolic / bp_diastolic to weekly_checkins
    if they don't exist yet. All optional — `None` for any user who
    doesn't log them, no scoring impact when absent."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE weekly_checkins "
                "ADD COLUMN IF NOT EXISTS body_fat_pct DOUBLE PRECISION"
            ))
            conn.execute(text(
                "ALTER TABLE weekly_checkins "
                "ADD COLUMN IF NOT EXISTS bp_systolic INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE weekly_checkins "
                "ADD COLUMN IF NOT EXISTS bp_diastolic INTEGER"
            ))
    except Exception as e:
        print(f"[migration] weekly_checkins body columns failed (non-fatal): {e}")


def _ensure_weekly_checkin_measurements_columns() -> None:
    """Add chest_in / hips_in / bicep_in / thigh_in / calf_in to weekly_checkins.
    All optional — no scoring impact when absent."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for col in ("chest_in", "hips_in", "bicep_in", "thigh_in", "calf_in"):
                conn.execute(text(
                    f"ALTER TABLE weekly_checkins ADD COLUMN IF NOT EXISTS {col} DOUBLE PRECISION"
                ))
    except Exception as e:
        print(f"[migration] weekly_checkins measurements columns failed (non-fatal): {e}")


def _ensure_recovery_activities_table() -> None:
    """Create recovery_activities table for cold plunge / sauna /
    breathwork / meditation logging if it doesn't exist yet."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS recovery_activities (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
                    activity_date DATE NOT NULL,
                    modality VARCHAR NOT NULL,
                    duration_min INTEGER NOT NULL,
                    intensity VARCHAR,
                    notes TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_recovery_activities_user_date "
                "ON recovery_activities(user_id, activity_date DESC)"
            ))
    except Exception as e:
        print(f"[migration] recovery_activities table failed (non-fatal): {e}")


def _ensure_plan_week_tables() -> None:
    """Create plan_weeks + plan_days tables if they don't exist yet.
    These are created by SQLModel.metadata.create_all, but we add indexes
    that create_all doesn't handle (partial indexes, composite)."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_plan_week_user_active "
                "ON plan_weeks(user_id) WHERE status = 'active'"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_plan_day_user_date "
                "ON plan_days(user_id, day_date)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_plan_day_week_unlocked "
                "ON plan_days(plan_week_id) WHERE locked = FALSE"
            ))
    except Exception as e:
        print(f"[migration] plan_week indexes failed (non-fatal): {e}")


def _backfill_plan_weeks() -> None:
    """One-time backfill: for every user with an active WorkoutPlan but no
    active PlanWeek, generate a PlanWeek from their current plan.
    Runs on startup — idempotent (skips users who already have one)."""
    if engine.dialect.name != "postgresql":
        return
    try:
        from app.models import WorkoutPlan, NutritionPlan, PlanWeek, PlanDay, WorkoutCompletion
        from app.services.workout.weekly_recipe import PLANNER_VERSION
        from datetime import date, datetime, timedelta, timezone
        import json

        with Session(engine) as db:
            active_plans = db.exec(
                text(
                    "SELECT wp.id, wp.user_id, wp.goal, wp.days_per_week, "
                    "wp.preferred_split, wp.planner_version, wp.plan_json "
                    "FROM workout_plans wp "
                    "WHERE wp.is_active = TRUE "
                    "AND NOT EXISTS ("
                    "  SELECT 1 FROM plan_weeks pw "
                    "  WHERE pw.user_id = wp.user_id AND pw.status = 'active'"
                    ")"
                )
            ).all()
            if not active_plans:
                return

            print(f"[backfill] plan_weeks: {len(active_plans)} users to backfill")
            today = date.today()
            # Monday of this week
            start = today - timedelta(days=today.weekday())
            end = start + timedelta(days=6)

            for row in active_plans:
                wp_id, user_id, goal, days_per_week, preferred_split, pv, plan_json = row
                if not plan_json:
                    continue

                days_list = []
                if isinstance(plan_json, dict):
                    wp_data = plan_json.get("workout_plan", plan_json)
                    days_list = wp_data.get("days", [])
                elif isinstance(plan_json, str):
                    try:
                        parsed = json.loads(plan_json)
                        wp_data = parsed.get("workout_plan", parsed)
                        days_list = wp_data.get("days", [])
                    except Exception:
                        continue

                if not days_list:
                    continue

                # Load nutrition templates
                nutrition_templates = []
                try:
                    np_row = db.exec(
                        text(
                            "SELECT plans_json FROM nutrition_plans "
                            "WHERE user_id = :uid AND is_active = TRUE LIMIT 1"
                        ),
                        {"uid": user_id},
                    ).first()
                    if np_row and np_row[0]:
                        nutrition_templates = json.loads(np_row[0]) if isinstance(np_row[0], str) else np_row[0]
                except Exception:
                    pass

                # Load completions this week to mark days as completed
                completions_this_week: set[date] = set()
                try:
                    comp_rows = db.exec(
                        text(
                            "SELECT DISTINCT workout_date FROM workout_completions "
                            "WHERE user_id = :uid AND workout_date >= :start AND workout_date <= :end"
                        ),
                        {"uid": user_id, "start": start, "end": end},
                    ).all()
                    for cr in comp_rows:
                        completions_this_week.add(cr[0])
                except Exception:
                    pass

                # Training day pattern: default to Mon-Fri for days_per_week<=5,
                # else fill from Monday
                training_indices = list(range(min(days_per_week, 7)))

                pw = PlanWeek(
                    user_id=user_id,
                    start_date=start,
                    end_date=end,
                    planner_version=pv or PLANNER_VERSION,
                    goal=goal or "",
                    days_per_week=days_per_week or len(days_list),
                    preferred_split=preferred_split,
                    status="active",
                )
                db.add(pw)
                db.flush()  # get pw.id

                workout_idx = 0
                for i in range(7):
                    d = start + timedelta(days=i)
                    is_training = i in training_indices
                    is_rest = not is_training

                    workout_payload = None
                    if is_training and days_list:
                        workout_payload = days_list[workout_idx % len(days_list)]
                        workout_idx += 1

                    nutrition_payload = None
                    if nutrition_templates:
                        nutrition_payload = nutrition_templates[i % len(nutrition_templates)]

                    day_completed = d in completions_this_week
                    day_in_past = d < today

                    pd = PlanDay(
                        plan_week_id=pw.id,
                        user_id=user_id,
                        day_date=d,
                        day_index=i,
                        status="completed" if day_completed else ("planned" if not day_in_past or is_rest else "planned"),
                        is_rest=is_rest,
                        workout_json=workout_payload,
                        nutrition_json=nutrition_payload,
                        locked=day_completed,
                        locked_at=datetime.now(timezone.utc) if day_completed else None,
                        lock_reason="completed" if day_completed else None,
                        generation_source="backfill",
                    )
                    db.add(pd)

                db.commit()
            print(f"[backfill] plan_weeks: done ({len(active_plans)} users)")
    except Exception as e:
        print(f"[backfill] plan_weeks failed (non-fatal): {e}")
        try:
            db.rollback()
        except Exception:
            pass


def _backfill_tricep_kickbacks_display_name() -> None:
    """Rename legacy triceps `Kickbacks` rows and persisted plan payloads."""
    from copy import deepcopy
    from datetime import datetime, timezone
    from sqlmodel import select
    from app.models import Exercise, PlanDay, WorkoutExercise

    old_name = "Kickbacks"
    new_name = "Dumbbell Tricep Kickbacks"
    new_description = "Strict dumbbell tricep kickback with a full elbow lockout"

    def _is_tricep_kickback(ex: dict) -> bool:
        if not isinstance(ex, dict):
            return False
        name = str(ex.get("name") or "").strip()
        slug = str(
            ex.get("_slug")
            or ex.get("slug")
            or ex.get("exercise_slug")
            or ex.get("exerciseSlug")
            or ""
        ).strip()
        primary = str(
            ex.get("_primary_muscle")
            or ex.get("primary_muscle")
            or ex.get("primaryMuscle")
            or ""
        ).strip()
        return name == old_name and (slug == "kickbacks" or primary == "triceps")

    def _rewrite_workout_payload(payload: dict | None) -> tuple[dict | None, bool]:
        if not isinstance(payload, dict):
            return payload, False
        updated = deepcopy(payload)
        changed = False
        for ex in updated.get("exercises") or []:
            if _is_tricep_kickback(ex):
                ex["name"] = new_name
                changed = True
        return updated, changed

    try:
        changed = 0
        with Session(engine) as db:
            for ex in db.exec(select(Exercise).where(Exercise.slug == "kickbacks")).all():
                if ex.name != new_name:
                    ex.name = new_name
                    changed += 1
                if ex.description != new_description:
                    ex.description = new_description
                    changed += 1
                db.add(ex)

            for pd in db.exec(select(PlanDay).where(PlanDay.workout_json != None)).all():
                updated, did_change = _rewrite_workout_payload(pd.workout_json)
                if did_change:
                    pd.workout_json = updated
                    pd.updated_at = datetime.now(timezone.utc)
                    db.add(pd)
                    changed += 1

            workout_rows = db.exec(
                select(WorkoutExercise).where(WorkoutExercise.name == old_name)
            ).all()
            for row in workout_rows:
                if (
                    getattr(row, "exercise_slug_snapshot", None) == "kickbacks"
                    or getattr(row, "primary_muscle_snapshot", None) == "triceps"
                ):
                    row.name = new_name
                    db.add(row)
                    changed += 1

            if changed:
                db.commit()
                print(f"[backfill] tricep_kickbacks_display_name: {changed} rows/payloads updated")
    except Exception as e:
        print(f"[backfill] tricep_kickbacks_display_name failed (non-fatal): {e}")


def _ensure_user_name_columns() -> None:
    """Add first_name / last_name to the user table. Nullable so existing
    rows migrate cleanly without a default."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS first_name VARCHAR'))
            conn.execute(text('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS last_name VARCHAR'))
    except Exception as e:
        print(f"[migration] user name columns failed (non-fatal): {e}")


def _ensure_user_reports_table() -> None:
    """Create the user_reports table if absent and add the indexes that
    SQLModel.metadata.create_all doesn't emit by default."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_reports_status "
                "ON user_reports(status)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_reports_reported_user "
                "ON user_reports(reported_user_id)"
            ))
    except Exception as e:
        print(f"[migration] user_reports indexes failed (non-fatal): {e}")


def _ensure_user_token_version_column() -> None:
    """Add token_version to the user table. Existing rows get 0 so any
    JWTs already issued (with no `tv` claim) still validate against the
    default. Bumped on logout / password change / password reset so a
    stolen-token window is bounded by the next of those events."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0'
            ))
    except Exception as e:
        print(f"[migration] user token_version column failed (non-fatal): {e}")


def _ensure_user_oauth_columns() -> None:
    """Add provider identity links for native account sign-in."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS apple_sub VARCHAR'))
            conn.execute(text('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS google_sub VARCHAR'))
            conn.execute(text(
                'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_apple_sub '
                'ON "user"(apple_sub) WHERE apple_sub IS NOT NULL'
            ))
            conn.execute(text(
                'CREATE UNIQUE INDEX IF NOT EXISTS ix_user_google_sub '
                'ON "user"(google_sub) WHERE google_sub IS NOT NULL'
            ))
    except Exception as e:
        print(f"[migration] user oauth columns failed (non-fatal): {e}")


def _ensure_user_trust_account_columns() -> None:
    """Add launch-readiness account/legal columns to the user table.

    These are nullable so existing pilot users migrate cleanly; new signup
    enforces acceptance in the auth router before writing timestamps.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for col_sql in (
                "terms_accepted_at TIMESTAMPTZ",
                "terms_version VARCHAR",
                "privacy_accepted_at TIMESTAMPTZ",
                "privacy_version VARCHAR",
                "health_disclaimer_accepted_at TIMESTAMPTZ",
                "health_disclaimer_version VARCHAR",
                "ai_disclaimer_accepted_at TIMESTAMPTZ",
                "ai_disclaimer_version VARCHAR",
                "email_verified_at TIMESTAMPTZ",
                "email_verification_token_hash VARCHAR",
                "email_verification_expires_at TIMESTAMPTZ",
                "password_reset_token_hash VARCHAR",
                "password_reset_expires_at TIMESTAMPTZ",
                "account_deleted_at TIMESTAMPTZ",
            ):
                conn.execute(text(f'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS {col_sql}'))
    except Exception as e:
        print(f"[migration] user trust/account columns failed (non-fatal): {e}")


def _ensure_plan_week_snapshot_columns() -> None:
    """Add goal_pace + session_minutes to plan_weeks.

    These snapshot the UserGoal.pace and workout duration at the moment the
    week was generated so compute_weekly_review can evaluate the completed
    week against the goal/pace it was actually built for — not whatever
    UserGoal happens to be active at review time (user may have changed it
    mid-week)."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE plan_weeks ADD COLUMN IF NOT EXISTS goal_pace VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE plan_weeks ADD COLUMN IF NOT EXISTS session_minutes INTEGER"
            ))
    except Exception as e:
        print(f"[migration] plan_weeks snapshot columns failed (non-fatal): {e}")


def _ensure_plan_week_pause_columns() -> None:
    """Add travel/illness pause columns to plan_weeks. While `paused_until`
    is in the future, auto-renew + auto-skip suspend so the user's streak
    and metrics don't degrade during a known-off period."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE plan_weeks ADD COLUMN IF NOT EXISTS paused_until DATE"
            ))
            conn.execute(text(
                "ALTER TABLE plan_weeks ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ"
            ))
            conn.execute(text(
                "ALTER TABLE plan_weeks ADD COLUMN IF NOT EXISTS pause_reason VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] plan_weeks pause columns failed (non-fatal): {e}")


def _ensure_skip_reason_columns() -> None:
    """Add human-readable skip reasons to day-state and PlanDay rows."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_day_state ADD COLUMN IF NOT EXISTS skip_reason VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE plan_days ADD COLUMN IF NOT EXISTS skip_reason VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] skip reason columns failed (non-fatal): {e}")


def _ensure_plan_week_checkins_table() -> None:
    """Create plan_week_checkins — one coaching check-in record per PlanWeek.
    Stores the expired-week prompt/recap while day-8 auto-renew proceeds."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS plan_week_checkins (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    plan_week_id INTEGER NOT NULL REFERENCES plan_weeks(id),
                    week_start_date DATE NOT NULL,
                    week_end_date DATE NOT NULL,
                    submitted_at TIMESTAMPTZ,
                    skipped BOOLEAN NOT NULL DEFAULT FALSE,
                    energy INTEGER,
                    hunger INTEGER,
                    soreness INTEGER,
                    motivation INTEGER,
                    schedule_issue BOOLEAN NOT NULL DEFAULT FALSE,
                    note TEXT,
                    review_snapshot_json JSONB,
                    ai_decision_id INTEGER,
                    ai_message TEXT,
                    ai_delta JSONB,
                    commitments_json JSONB,
                    plan_goal VARCHAR,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_plan_week_checkin UNIQUE (user_id, plan_week_id)
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_plan_week_checkins_user "
                "ON plan_week_checkins(user_id)"
            ))
    except Exception as e:
        print(f"[migration] plan_week_checkins table failed (non-fatal): {e}")


def run_data_maintenance_tasks(
    *,
    include_backfills: bool = True,
    include_seeds: bool = True,
) -> None:
    """Run non-schema maintenance explicitly.

    These tasks scan data, recompute derived fields, seed reference rows,
    or call external services. They stay out of the normal startup path
    unless an env flag opts them back in.
    """
    import time as _time
    if include_backfills:
        for fn in (
            _backfill_exercise_video_ids,
            _autoscrape_missing_video_ids,  # already daemonized internally
            _backfill_custom_food_micronutrients,
            _backfill_mealitem_food_ids,
            _recompute_recent_daily_metrics,
            _seed_supplement_ingredients,
            _backfill_plan_weeks,
        ):
            t0 = _time.time()
            try:
                fn()
            except Exception as e:
                print(f"[maintenance] {fn.__name__} failed (non-fatal): {e}")
            elapsed = (_time.time() - t0) * 1000
            if elapsed > 250:
                print(f"[maintenance] {fn.__name__} took {elapsed:.0f}ms")
    else:
        print("[maintenance] skipping data backfills")

    if include_seeds:
        from app.seed import seed_equipment, seed_exercises, seed_foods, seed_goals
        with Session(engine) as session:
            for seed_fn in (seed_equipment, seed_exercises, seed_foods, seed_goals):
                t0 = _time.time()
                try:
                    seed_fn(session)
                except Exception as e:
                    print(f"[seed] {seed_fn.__name__} failed (non-fatal): {e}")
                elapsed = (_time.time() - t0) * 1000
                if elapsed > 250:
                    print(f"[seed] {seed_fn.__name__} took {elapsed:.0f}ms")
    else:
        print("[maintenance] skipping seed inserts")

    _backfill_tricep_kickbacks_display_name()


def startup_data_maintenance_settings(
    env: Mapping[str, str] | None = None,
) -> tuple[bool, bool, bool]:
    env = os.environ if env is None else env
    enabled = env.get("STARTUP_DATA_MAINTENANCE_ENABLED", "0") == "1"
    include_backfills = env.get("STARTUP_BACKFILLS_ENABLED", "1") == "1"
    include_seeds = env.get("STARTUP_SEEDS_ENABLED", "1") == "1"
    return enabled, include_backfills, include_seeds


def create_db_and_tables():
    # Import all models to register them with SQLModel.metadata
    from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood, Equipment, ExerciseEquipment, GoalOption, PaceOption, User, ClientTelemetryEvent, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState, DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob, UserState, WorkoutPlan, NutritionPlan, FoodMetadata, DailyNutritionMetrics, WorkoutCompletion, BodyScan, SavedMeal, SupplementIngredient, SupplementProduct, SupplementProductIngredient, UserSupplementStack, SupplementLog, SleepLog, SupplementAICache, DailyHealthSnapshot, UserSocialProfile, Friendship, WeeklyDigestCache, ActivityFeedItem, FeedLike, PlanWeek, PlanDay, UserEquipmentProfile, GearItem

    SQLModel.metadata.create_all(engine)
    _ensure_food_category_enum_values()
    _ensure_food_nutrition_extras_column()
    _ensure_food_search_indexes()
    _ensure_workout_completion_stimulus_column()
    _ensure_workout_completion_health_columns()
    _ensure_workout_history_source_columns()
    _ensure_user_preferences_equipment_settings_column()
    _ensure_user_supplement_stack_group_column()
    _ensure_coach_apply_state_columns()
    _backfill_user_preferences_preferred_split()
    _ensure_user_recovery_columns()
    _ensure_user_subscription_tier_column()
    _ensure_user_plan_cadence_anchor_column()
    _ensure_user_goal_track_column()
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
    _ensure_exercise_set_duration_columns()
    _ensure_exercise_set_cardio_hr_columns()
    _ensure_user_equipment_profiles_table()
    _ensure_weekly_checkin_body_columns()
    _ensure_weekly_checkin_measurements_columns()
    _ensure_recovery_activities_table()
    _ensure_gear_items_table()
    _ensure_gear_items_photos_column()
    _ensure_gear_items_usage_columns()
    _ensure_user_name_columns()
    _ensure_user_trust_account_columns()
    _ensure_user_oauth_columns()
    _ensure_user_token_version_column()
    _ensure_user_reports_table()
    _ensure_plan_week_tables()
    _ensure_plan_week_snapshot_columns()
    _ensure_plan_week_pause_columns()
    _ensure_skip_reason_columns()
    _ensure_plan_week_checkins_table()

    maintenance_enabled, include_backfills, include_seeds = startup_data_maintenance_settings()
    if maintenance_enabled:
        run_data_maintenance_tasks(
            include_backfills=include_backfills,
            include_seeds=include_seeds,
        )
    else:
        print("[maintenance] STARTUP_DATA_MAINTENANCE_ENABLED=0 — skipping data maintenance")


def get_session():
    with Session(engine) as session:
        yield session
