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
                "ADD COLUMN IF NOT EXISTS subscription_status VARCHAR DEFAULT 'free'"
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS subscription_source VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS subscription_product_id VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS subscription_entitlement_id VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS subscription_store VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS subscription_environment VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS revenuecat_original_app_user_id VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" ADD COLUMN IF NOT EXISTS revenuecat_original_transaction_id VARCHAR'
            ))
            conn.execute(text(
                'ALTER TABLE "user" '
                "ALTER COLUMN subscription_tier SET DEFAULT 'free'"
            ))
            conn.execute(text(
                'ALTER TABLE "user" '
                "ALTER COLUMN subscription_status DROP DEFAULT"
            ))
            conn.execute(text(
                'UPDATE "user" SET subscription_tier = CASE '
                "WHEN lower(trim(COALESCE(subscription_tier, ''))) = 'pro' THEN 'pro' "
                "ELSE 'free' END"
            ))
            conn.execute(text(
                "UPDATE \"user\" SET subscription_status = CASE "
                "WHEN lower(trim(COALESCE(subscription_status, ''))) <> '' THEN lower(trim(subscription_status)) "
                "WHEN lower(trim(COALESCE(subscription_tier, ''))) = 'pro' THEN 'active' "
                "ELSE 'free' END"
            ))
            conn.execute(text(
                "UPDATE \"user\" SET subscription_status = 'free' "
                "WHERE subscription_status NOT IN ("
                "'free', 'trialing', 'trial_cancelled', 'active', 'grace_period', "
                "'cancelled', 'expired', 'revoked', 'billing_issue', 'beta', "
                "'promotional', 'temporary'"
                ")"
            ))
            conn.execute(text(
                "UPDATE \"user\" SET subscription_status = 'active' "
                "WHERE subscription_tier = 'pro' AND subscription_status = 'free'"
            ))
            conn.execute(text(
                "UPDATE \"user\" SET subscription_tier = 'free' "
                "WHERE subscription_status IN ('free', 'expired', 'revoked', 'billing_issue')"
            ))
            conn.execute(text(
                """
                DO $$
                BEGIN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'ck_user_subscription_tier_values'
                    ) THEN
                        ALTER TABLE "user"
                        ADD CONSTRAINT ck_user_subscription_tier_values
                        CHECK (subscription_tier IN ('free', 'pro'));
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'ck_user_subscription_status_values'
                    ) THEN
                        ALTER TABLE "user"
                        ADD CONSTRAINT ck_user_subscription_status_values
                        CHECK (
                            subscription_status IS NULL
                            OR subscription_status IN (
                                'free', 'trialing', 'trial_cancelled', 'active',
                                'grace_period', 'cancelled', 'expired', 'revoked',
                                'billing_issue', 'beta', 'promotional', 'temporary'
                            )
                        );
                    END IF;
                END $$;
                """
            ))
            applied = conn.execute(
                text("SELECT 1 FROM app_migrations WHERE name = :name"),
                {"name": backfill_marker},
            ).first()
            if applied is None and os.getenv("BETA_BACKFILL_EXISTING_USERS_TO_PRO", "0") == "1":
                conn.execute(text(
                    "UPDATE \"user\" SET subscription_tier = 'pro', subscription_status = 'active' "
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
            conn.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_user_subscription_status '
                'ON "user"(subscription_status)'
            ))
            conn.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_user_subscription_expires_at '
                'ON "user"(subscription_expires_at)'
            ))
            conn.execute(text(
                'CREATE INDEX IF NOT EXISTS ix_user_trial_ends_at '
                'ON "user"(trial_ends_at)'
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


def _ensure_user_goal_baseline_columns() -> None:
    """Snapshot the user's start-weight + body-fat at goal creation. Lets
    the progress meter compute fat-mass delta and "since goal start"
    numbers without re-deriving from history (which silently shifts if
    the user back-logs a weigh-in or scan)."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_goals "
                "ADD COLUMN IF NOT EXISTS start_weight_lbs DOUBLE PRECISION"
            ))
            conn.execute(text(
                "ALTER TABLE user_goals "
                "ADD COLUMN IF NOT EXISTS start_body_fat_pct DOUBLE PRECISION"
            ))
            conn.execute(text(
                "ALTER TABLE user_goals "
                "ADD COLUMN IF NOT EXISTS start_scan_id INTEGER"
            ))
    except Exception as e:
        print(f"[migration] user_goals baseline columns add failed (non-fatal): {e}")


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
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS activity_details JSONB"
            ))
    except Exception as e:
        print(f"[migration] workout_completions health columns add failed (non-fatal): {e}")


def _ensure_workout_completion_training_score_columns() -> None:
    """Add persisted training-score fields to workout_completions."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS training_score INTEGER"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS training_rating VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS training_pillars JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS training_pillar_breakdown JSONB"
            ))
            # Edwards' TRIMP cardio load — populated at completion-write time
            # for sessions with usable HR zone minutes. Null on strength /
            # mobility / pre-2026-06 cardio rows that pre-date the column.
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS cardio_load DOUBLE PRECISION"
            ))
    except Exception as e:
        print(f"[migration] workout_completions training score columns failed (non-fatal): {e}")


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
                "ALTER TABLE workout_sessions "
                "ADD COLUMN IF NOT EXISTS external_source_id VARCHAR"
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
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_sessions_external_source "
                "ON workout_sessions(user_id, external_source_id)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_workout_sessions_user_external_source "
                "ON workout_sessions(user_id, external_source_id) "
                "WHERE external_source_id IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] workout history source columns add failed (non-fatal): {e}")


def _ensure_workout_completion_activity_identity_columns() -> None:
    """Add wall-clock activity timestamps + external identity.

    Manual/Apple imports can be backlogged and multiple same-focus
    activities can happen on the same day. These fields let the backend
    preserve the activity's actual window and upsert by a stable local/HealthKit
    id instead of collapsing everything to `(date, focus)`.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS external_source_id VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_completions_external_source "
                "ON workout_completions(user_id, external_source_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_completions_idempotency_key "
                "ON workout_completions(idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_workout_completions_user_external_source "
                "ON workout_completions(user_id, external_source_id) "
                "WHERE external_source_id IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_workout_completions_user_idempotency_key "
                "ON workout_completions(user_id, idempotency_key) "
                "WHERE idempotency_key IS NOT NULL"
            ))
            conn.execute(text(
                "UPDATE workout_completions "
                "SET ended_at = completed_at "
                "WHERE ended_at IS NULL AND completed_at IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] workout completion identity columns add failed (non-fatal): {e}")


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


def _ensure_user_preferences_baseline_columns() -> None:
    """Add optional signup performance baselines to user_preferences.

    These are user-entered anchors, not workout history. They help the
    deterministic planner choose first-week loads without polluting streaks,
    compliance, social digest, or progress charts.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS experience_level VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS strength_baselines JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS cardio_baseline JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS training_day_pattern JSONB"
            ))
    except Exception as e:
        print(f"[migration] user_preferences baseline columns add failed (non-fatal): {e}")


def _ensure_user_preferences_injuries_structured_column() -> None:
    """Add severity-aware structured injury records to user_preferences.

    Each row in this JSONB array is {bodyPart, status, severity,
    muscleGroups[], estimatedRecoveryDate?}. The legacy `injuries`
    free-text column stays in place — both columns coexist and the
    planner unions them, so older rows continue to work.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS injuries_structured JSONB DEFAULT '[]'::jsonb"
            ))
    except Exception as e:
        print(f"[migration] user_preferences injuries_structured add failed (non-fatal): {e}")


def _ensure_user_preferences_pending_imports_column() -> None:
    """Add in-flight import tracking to user_preferences.

    Each row in this JSONB array is
    {source, requested_at, notified_at?, completed_at?, dismissed_at?}.
    Drives the onboarding awareness flow and HomeScreen banners that
    remind the user to come back and finish a pending MyFitnessPal /
    Cronometer / Hevy / Strong / Strava import. Defaults to empty list
    so existing rows keep working unchanged.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS pending_imports JSONB DEFAULT '[]'::jsonb"
            ))
    except Exception as e:
        print(f"[migration] user_preferences pending_imports add failed (non-fatal): {e}")


def _ensure_user_preferences_custom_macros_column() -> None:
    """Add durable user-set macro overrides to user_preferences.

    These are the typed-table replacement for the old userProfile cache
    value. They drive nutrition target resolution and must survive app
    restart, sign-in, and legacy user-state quarantine.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS custom_macros JSONB"
            ))
    except Exception as e:
        print(f"[migration] user_preferences custom_macros add failed (non-fatal): {e}")


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


def _ensure_user_supplement_stack_ai_metadata_columns() -> None:
    """Add denormalized AI supplement purpose/effectiveness metadata.

    The user stack can contain custom products that are not in the
    seeded ingredient catalog. These nullable columns store cautious,
    user-visible context without re-calling AI on every render.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_supplement_stack "
                "ADD COLUMN IF NOT EXISTS description TEXT"
            ))
            conn.execute(text(
                "ALTER TABLE user_supplement_stack "
                "ADD COLUMN IF NOT EXISTS effectiveness_confidence VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE user_supplement_stack "
                "ADD COLUMN IF NOT EXISTS source_terms JSONB"
            ))
            conn.execute(text(
                "ALTER TABLE user_supplement_stack "
                "ADD COLUMN IF NOT EXISTS nutrient_content JSONB"
            ))
    except Exception as e:
        print(f"[migration] user_supplement_stack AI metadata add failed (non-fatal): {e}")


def _ensure_supplement_detail_metadata_columns() -> None:
    """Add structured supplement detail fields to catalog + user stack."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for table in ("supplement_ingredients", "user_supplement_stack"):
                for column in ("common_uses", "deficiency_risks", "excess_risks", "food_sources"):
                    conn.execute(text(
                        f"ALTER TABLE {table} "
                        f"ADD COLUMN IF NOT EXISTS {column} JSONB"
                    ))
    except Exception as e:
        print(f"[migration] supplement detail metadata add failed (non-fatal): {e}")


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
                "ALTER TABLE user_coaching_state "
                "ADD COLUMN IF NOT EXISTS muscle_volume_adjustments JSONB DEFAULT '{}'::jsonb"
            ))
            conn.execute(text(
                "ALTER TABLE user_coaching_state "
                "ADD COLUMN IF NOT EXISTS intensity_adjustment_pct INTEGER DEFAULT 0"
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


def _ensure_exercise_flow_category_column() -> None:
    """Add Exercise.flow_category for guided-flow ordering of stretch/yoga/
    foam-roll poses. Nullable — only mobility-list entries are tagged.
    Populated by the seed re-run immediately after this migration."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercises "
                "ADD COLUMN IF NOT EXISTS flow_category VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] exercise flow_category column add failed (non-fatal): {e}")


def _ensure_exercise_demo_db_id_column() -> None:
    """Add Exercise.demo_exercise_db_id (free-exercise-db identifier) if
    missing. Nullable — only resolved exercises get a value, the rest
    fall back to YouTube thumbnail at the client. Populated by the
    seed-time resolver in seed_exercises_data.py."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercises "
                "ADD COLUMN IF NOT EXISTS demo_exercise_db_id VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] exercise demo_exercise_db_id column add failed (non-fatal): {e}")


def _clear_stale_tibialis_demo_id() -> None:
    """Tibialis Raise has no correct free-exercise-db form demo — the only
    dataset match is "Anterior Tibialis-SMR" (foam-rolling the shin), the
    wrong movement. The seed-time resolver returns None for it on purpose
    so the client falls back to the curated YouTube demo. DBs seeded
    before that resolver fix still carry the wrong demo id, and startup
    seeding is gated off by default (STARTUP_DATA_MAINTENANCE_ENABLED) so
    it never self-heals. Clear it here, idempotently, on every startup."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "UPDATE exercises SET demo_exercise_db_id = NULL "
                "WHERE slug = 'tibialis_raise' AND demo_exercise_db_id IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] tibialis demo id clear failed (non-fatal): {e}")


def _patch_band_squat_loaded_setup() -> None:
    """Band Squat is a barbell squat with accommodating band resistance.
    Existing DBs seeded before this correction modeled it as a home
    resistance-band-only movement, which hid weight logging and ranked the
    wrong setup in the library. Patch the reference row even when startup
    seed maintenance is disabled."""
    from sqlmodel import select
    from app.enums import EquipmentType
    from app.models import Equipment, Exercise, ExerciseEquipment

    try:
        with Session(engine) as session:
            ex = session.exec(select(Exercise).where(Exercise.slug == "band_squat")).first()
            if not ex or ex.id is None:
                return

            ex.equipment = EquipmentType.GYM
            ex.secondary_muscles = ["glutes", "hamstrings", "core"]
            ex.description = "Barbell squat with bands anchored to the rack for accommodating resistance"
            ex.demo_exercise_db_id = "Reverse_Band_Box_Squat"
            session.add(ex)

            wanted = {
                "barbell": ("primary", True),
                "resistance_bands": ("support", True),
                "squat_rack": ("support", True),
            }
            equipment_rows = session.exec(
                select(Equipment).where(Equipment.slug.in_(list(wanted)))
            ).all()
            equipment_by_slug = {row.slug: row for row in equipment_rows if row.slug}
            if set(equipment_by_slug) != set(wanted):
                session.commit()
                return

            existing = session.exec(
                select(ExerciseEquipment).where(ExerciseEquipment.exercise_id == ex.id)
            ).all()
            for row in existing:
                session.delete(row)
            session.flush()

            for slug, (role, required) in wanted.items():
                session.add(ExerciseEquipment(
                    exercise_id=ex.id,
                    equipment_id=equipment_by_slug[slug].id,
                    role=role,
                    required=required,
                ))
            session.commit()
    except Exception as e:
        print(f"[migration] band squat setup patch failed (non-fatal): {e}")


def _ensure_exercise_emphasis_column() -> None:
    """Add Exercise.emphasis (fine-grained muscle tags) if missing.

    Display-layer only — the 12-bucket fatigue model still reads
    `primary_muscle` + `secondary_muscles`. Default empty array so
    existing rows keep working; the post-seed inference pass fills
    them in. Errors here are cosmetic, so non-fatal.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercises "
                "ADD COLUMN IF NOT EXISTS emphasis JSONB DEFAULT '[]'::jsonb"
            ))
    except Exception as e:
        print(f"[migration] exercise emphasis column add failed (non-fatal): {e}")


def _backfill_exercise_emphasis() -> None:
    """One-shot inference backfill for `Exercise.emphasis`.

    Runs on every startup but is cheap when fully populated — only
    rows where emphasis is NULL or '[]' get re-inferred. Seeds set
    emphasis directly, but this catches existing rows on a deployment
    where `STARTUP_SEEDS_ENABLED=0` (which is the default in prod
    after the A6 launch-readiness pass).

    Importing the inference helper lazily so this module stays
    importable without the full app context.
    """
    try:
        from sqlmodel import Session, select
        from app.models import Exercise
        from app.services.workout.emphasis_inference import infer_emphasis
    except Exception:
        return
    try:
        with Session(engine) as session:
            rows = session.exec(
                select(Exercise).where(Exercise.is_custom.is_(False))
            ).all()
            updated = 0
            # Always re-infer so rule-table changes propagate on the
            # next deploy without manual flushing. Cheap enough — pure-
            # function calls against ~450 rows on every startup.
            for ex in rows:
                prim = (
                    ex.primary_muscle.value
                    if hasattr(ex.primary_muscle, "value")
                    else str(ex.primary_muscle or "")
                ).lower()
                secs = [
                    (s.value if hasattr(s, "value") else str(s)).lower()
                    for s in (ex.secondary_muscles or [])
                ]
                tags = infer_emphasis(ex.name, prim, secs)
                if tags != (ex.emphasis or []):
                    ex.emphasis = tags
                    session.add(ex)
                    updated += 1
            if updated:
                session.commit()
                print(f"[backfill] exercise.emphasis updated for {updated} rows")
    except Exception as e:
        print(f"[backfill] exercise.emphasis failed (non-fatal): {e}")


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


def _ensure_nutrition_log_status_columns() -> None:
    """Add explicit nutrition day completeness columns.

    UserDayState stores user-confirmed status; DailyRollup snapshots the
    inferred/explicit status so coach flags can gate on usable nutrition days
    without re-reading raw meals for every flag.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for column_sql in (
                "nutrition_log_status VARCHAR",
                "nutrition_log_status_source VARCHAR",
                "nutrition_log_status_updated_at TIMESTAMP WITH TIME ZONE",
            ):
                conn.execute(text(
                    f"ALTER TABLE user_day_state ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            for column_sql in (
                "nutrition_log_status VARCHAR DEFAULT 'unknown'",
                "nutrition_log_confidence DOUBLE PRECISION DEFAULT 0",
            ):
                conn.execute(text(
                    f"ALTER TABLE daily_rollups ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_day_state_nutrition_log_status "
                "ON user_day_state(nutrition_log_status)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_daily_rollups_nutrition_log_status "
                "ON daily_rollups(nutrition_log_status)"
            ))
    except Exception as e:
        print(f"[migration] nutrition log status columns add failed (non-fatal): {e}")


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
    after the curated backfill, scrape YouTube for an equipment-aware
    form tutorial query and store the first embeddable result. Runs in a
    daemon thread so it never blocks server startup; takes ~3-8 seconds
    per exercise × however many rows are missing (typically <100), so a
    first boot can be a few minutes of background work.

    Idempotent: each subsequent run is a no-op because every row now
    has a video_id. Safe to call on every startup.
    """
    import threading
    from sqlmodel import select
    from app.models import Exercise, Equipment, ExerciseEquipment
    from app.services.workout.video_resolver import find_youtube_video_id

    def _video_equipment_for_exercise(session: Session, exercise_id: int | None) -> str | None:
        if exercise_id is None:
            return None
        rows = session.exec(
            select(ExerciseEquipment, Equipment)
            .join(Equipment, Equipment.id == ExerciseEquipment.equipment_id)
            .where(ExerciseEquipment.exercise_id == exercise_id)
        ).all()
        if not rows:
            return None
        role_rank = {"primary": 0, "support": 1, "optional": 2}
        ordered = sorted(
            rows,
            key=lambda row: (
                role_rank.get((row[0].role or "primary").lower(), 9),
                0 if row[0].required else 1,
                row[1].slug or row[1].name,
            ),
        )
        return ", ".join((eq.slug or eq.name) for _, eq in ordered[:2])

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
                        equipment = _video_equipment_for_exercise(session, ex.id)
                        vid = find_youtube_video_id(ex.name, equipment=equipment)
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
    from app.services.supplement_details import supplement_detail_metadata

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
        ("casein_protein", "Casein Protein", "protein", "g", "strong", "low",
         "Slow-digesting dairy protein. Useful when a convenient protein serving is needed between meals or before bed.",
         "Any time protein is low; often used before sleep.",
         "Contains milk proteins. Choose another option with dairy allergy or intolerance."),
        ("plant_protein", "Plant Protein", "protein", "g", "moderate", "low",
         "Convenient protein from pea, soy, rice, hemp, or blended plant sources.",
         "Post-workout or any meal where protein is short.",
         "Choose third-party tested brands when possible; some powders can be gritty or cause GI discomfort."),
        ("bcaa", "BCAA", "amino_acid", "g", "limited", "low",
         "Leucine, isoleucine, and valine. Most useful when training fasted or total protein intake is low.",
         "Around training if used.",
         "Usually redundant when daily protein intake is already adequate."),
        ("eaa", "EAA", "amino_acid", "g", "moderate", "low",
         "Essential amino acid blend. Can be useful around training when a full protein meal is not practical.",
         "During or after training if used.",
         "Can be expensive relative to complete protein foods or powders."),
        ("l_citrulline", "L-Citrulline", "performance", "g", "moderate", "low",
         "May support blood flow, perceived pump, and high-effort training performance.",
         "About 30–60 minutes before training.",
         "High doses can cause GI discomfort; use caution with blood-pressure medications."),
        ("pre_workout", "Pre-Workout", "performance", "serving", "moderate", "moderate",
         "Combination formulas usually built around caffeine, citrulline, beta-alanine, and flavoring.",
         "Before training; avoid late-day stimulant use.",
         "Check total caffeine and avoid stacking multiple stimulant products."),
        ("l_glutamine", "L-Glutamine", "amino_acid", "g", "limited", "low",
         "Conditionally useful for gut comfort or heavy training blocks, but limited for muscle gain when protein is adequate.",
         "Any time; often post-workout or evening.",
         "Limited direct performance benefit for well-fed athletes."),
        ("zinc", "Zinc", "mineral", "mg", "moderate", "moderate",
         "Essential mineral for immune function and normal metabolism. Most useful when intake is low.",
         "With food to reduce nausea.",
         "High long-term doses can lower copper status."),
        ("ashwagandha", "Ashwagandha", "adaptogen", "mg", "moderate", "moderate",
         "Adaptogenic herb that may support stress perception and sleep quality for some users.",
         "Daily, often morning or evening depending on response.",
         "Avoid during pregnancy; use caution with thyroid, sedative, or immune-related medications."),
        ("melatonin", "Melatonin", "sleep", "mg", "moderate", "low",
         "Sleep-timing hormone. Most useful for circadian shifts, travel, or occasional sleep-onset support.",
         "30–60 minutes before target bedtime.",
         "Can cause next-day grogginess or vivid dreams, especially at higher doses."),
        ("l_theanine", "L-Theanine", "nootropic", "mg", "moderate", "low",
         "Amino acid from tea that may support calm focus, especially alongside caffeine.",
         "With caffeine or in the evening if it feels calming.",
         "May add to sedating medications for some users."),
        ("l_carnitine", "L-Carnitine", "performance", "g", "limited", "low",
         "May support recovery or fatty-acid transport in some groups; fat-loss effects are modest.",
         "With meals; often used daily.",
         "Can cause GI discomfort or a fishy body odor in some users."),
        ("collagen_peptides", "Collagen Peptides", "protein", "g", "moderate", "low",
         "Provides collagen-rich amino acids that may support tendons, ligaments, and joints.",
         "Often 30–60 minutes before tendon or joint-loading training, ideally with vitamin C.",
         "Not a complete protein; do not count it as a full replacement for high-leucine protein."),
        ("zma", "ZMA", "mineral", "serving", "limited", "moderate",
         "Zinc, magnesium, and B6 blend. Most useful when zinc or magnesium intake is low.",
         "Evening or before bed, following label directions.",
         "Avoid doubling up with separate high-dose zinc or magnesium unless directed."),
        ("multivitamin", "Multivitamin", "vitamin", "serving", "moderate", "moderate",
         "Broad micronutrient blend. Useful as nutritional insurance when diet variety is inconsistent.",
         "With a meal.",
         "Avoid mega-dose formulas, especially for fat-soluble vitamins and minerals."),
        ("tart_cherry", "Tart Cherry Extract", "recovery", "mg", "moderate", "low",
         "Polyphenol-rich cherry extract or concentrate that may support soreness and recovery around hard training.",
         "Around intense training blocks or evening, depending on product.",
         "Juice concentrates can add significant sugar."),
        ("green_tea_extract", "Green Tea Extract", "botanical", "mg", "moderate", "moderate",
         "EGCG/catechin source. May modestly support fat oxidation and antioxidant intake.",
         "With food.",
         "Concentrated extracts can stress the liver, especially high-dose or empty-stomach use."),
        ("probiotic", "Probiotic", "gut_health", "billion CFU", "moderate", "low",
         "Live microbial strains that may support gut comfort in strain-specific contexts.",
         "Daily per product label; consistency matters.",
         "Use caution if immunocompromised or critically ill."),
        ("vitamin_c", "Vitamin C", "vitamin", "mg", "moderate", "low",
         "Essential antioxidant vitamin involved in collagen formation and iron absorption.",
         "Any time; with iron-containing meals if supporting absorption.",
         "High doses can cause GI upset and may raise kidney-stone risk in susceptible users."),
        ("calcium", "Calcium", "mineral", "mg", "moderate", "moderate",
         "Supports bone health when dietary calcium is low.",
         "With meals; split larger doses.",
         "Avoid excess total calcium; discuss use with kidney-stone history or cardiovascular risk."),
        ("potassium", "Potassium", "mineral", "mg", "limited", "moderate",
         "Electrolyte important for fluid balance and muscle function. Food-first is preferred.",
         "With meals if used.",
         "Supplemental potassium can be unsafe with kidney disease or some blood-pressure medications."),
        ("selenium", "Selenium", "mineral", "mcg", "moderate", "moderate",
         "Trace mineral involved in thyroid and antioxidant systems.",
         "With food.",
         "Too much selenium can be toxic; avoid stacking high-dose products."),
        ("folate", "Folate", "vitamin", "mcg", "moderate", "low",
         "B vitamin involved in red blood cell formation and methylation pathways.",
         "Any time; often with food.",
         "High folic acid intake can mask B12 deficiency."),
        ("vitamin_k2", "Vitamin K2", "vitamin", "mcg", "limited", "moderate",
         "Fat-soluble vitamin involved in normal blood clotting and bone-related pathways.",
         "With a fat-containing meal.",
         "Avoid unsupervised use with warfarin or other vitamin-K-sensitive anticoagulants."),
        ("vitamin_e", "Vitamin E", "vitamin", "IU", "limited", "moderate",
         "Fat-soluble antioxidant vitamin. Food-first intake is usually preferred.",
         "With a fat-containing meal.",
         "High-dose supplements may increase bleeding risk."),
        ("coq10", "CoQ10", "antioxidant", "mg", "moderate", "low",
         "Compound involved in mitochondrial energy pathways; commonly used with statins or for general energy support.",
         "With a fat-containing meal.",
         "May interact with anticoagulants; discuss if taking heart medications."),
        ("turmeric_curcumin", "Turmeric / Curcumin", "botanical", "mg", "moderate", "moderate",
         "Curcuminoid extract used for joint comfort and inflammatory-marker support.",
         "With food; some formulas include piperine to improve absorption.",
         "Use caution with blood thinners, gallbladder disease, or before surgery."),
        ("glucosamine_chondroitin", "Glucosamine / Chondroitin", "joint", "mg", "moderate", "low",
         "Joint-support ingredients commonly used for knee or cartilage comfort.",
         "Daily with meals; effects, if any, build gradually.",
         "Check shellfish source and use caution with blood thinners."),
        ("psyllium_fiber", "Psyllium Fiber", "gut_health", "g", "strong", "low",
         "Soluble fiber that supports bowel regularity and can help improve cholesterol markers.",
         "With plenty of water; separate from medications by a few hours.",
         "Can cause bloating if increased too quickly; avoid dry swallowing."),
        ("beetroot_nitrate", "Beetroot / Nitrate", "performance", "mg", "moderate", "low",
         "Dietary nitrate source that may support endurance performance and blood-flow markers.",
         "2–3 hours before endurance or interval work.",
         "Can lower blood pressure; beet products may turn urine or stool pink/red."),
        ("sodium_bicarbonate", "Sodium Bicarbonate", "performance", "g", "moderate", "moderate",
         "Buffering agent that may support repeated high-intensity efforts.",
         "Before high-intensity training or competition after testing tolerance.",
         "Commonly causes GI distress and adds a large sodium load."),
        ("hmb", "HMB", "recovery", "g", "limited", "low",
         "Leucine metabolite that may help during new training phases or periods of low calorie intake.",
         "Daily, often split across the day.",
         "Benefits are less clear for trained athletes already eating enough protein."),
        ("taurine", "Taurine", "amino_acid", "mg", "limited", "low",
         "Amino-sulfonic acid found in many energy drinks; may support endurance or hydration markers.",
         "Any time; often pre-workout in formulas.",
         "Watch total stimulant intake when used in energy-drink products."),
        ("glycine", "Glycine", "amino_acid", "g", "limited", "low",
         "Amino acid that may support sleep quality and collagen-related amino acid intake.",
         "Evening or before bed if used for sleep.",
         "Can cause mild GI discomfort at higher doses."),
        ("garlic", "Garlic Extract", "botanical", "mg", "moderate", "moderate",
         "Garlic preparations are commonly used for cardiovascular health markers.",
         "With meals.",
         "Can increase bleeding risk and cause reflux or odor."),
        ("ginger", "Ginger", "botanical", "mg", "moderate", "low",
         "Common botanical used for nausea, digestion, and soreness support.",
         "With meals or around training depending on goal.",
         "High doses may cause heartburn and may interact with blood thinners."),
        ("berberine", "Berberine", "botanical", "mg", "moderate", "moderate",
         "Plant alkaloid commonly used for glucose and lipid-marker support.",
         "With meals if used.",
         "Can interact with diabetes medications, antibiotics, and pregnancy; clinician guidance is important."),
        ("cranberry_extract", "Cranberry Extract", "botanical", "mg", "moderate", "low",
         "Cranberry polyphenols are commonly used for urinary tract support.",
         "Daily per product label.",
         "Use caution with warfarin or kidney-stone history."),
        ("spirulina", "Spirulina", "algae", "g", "limited", "moderate",
         "Blue-green algae product used for protein, pigments, and micronutrient support.",
         "With meals or smoothies.",
         "Choose third-party tested products due to contamination risk."),
        ("maca", "Maca", "botanical", "g", "limited", "low",
         "Root powder often used for energy, mood, or libido support; evidence is limited.",
         "Daily with food.",
         "May cause GI discomfort; use caution with hormone-sensitive conditions."),
        ("panax_ginseng", "Panax Ginseng", "botanical", "mg", "moderate", "moderate",
         "Asian ginseng root used for energy, stress, and sexual-function routines; benefits appear modest and context-dependent.",
         "Morning or early afternoon with food; avoid late use if it affects sleep.",
         "May affect blood sugar, sleep, and bleeding risk; use caution with diabetes medicines, blood thinners, autoimmune conditions, pregnancy, or breastfeeding."),
        ("tongkat_ali", "Tongkat Ali", "hormone_support", "mg", "limited", "moderate",
         "Eurycoma longifolia root marketed for libido and testosterone support; human evidence is limited and long-term safety is not well established.",
         "Morning with food; avoid high-dose or multi-stimulant stacks.",
         "Use caution with liver disease, hormone-sensitive conditions, or medications. Choose third-party tested products."),
        ("fenugreek", "Fenugreek Extract", "botanical", "mg", "limited", "moderate",
         "Seed extract sometimes used in libido and metabolic-support stacks; evidence for sexual-function claims is limited.",
         "With meals to reduce stomach upset.",
         "Avoid supplement doses during pregnancy. May lower blood sugar, increase bleeding risk, or trigger legume allergies."),
        ("saffron", "Saffron Extract", "botanical", "mg", "moderate", "low",
         "Crocus sativus extract studied for mood and some sexual-function contexts, including desire and SSRI-related sexual side effects.",
         "Daily with or without food, following standardized-extract label directions.",
         "Avoid high doses and use caution during pregnancy, bipolar disorder, or with serotonergic medications unless supervised."),
        ("tribulus_terrestris", "Tribulus Terrestris", "hormone_support", "mg", "limited", "moderate",
         "Botanical often marketed for libido and testosterone; evidence for testosterone support is weak and product quality varies.",
         "With food, following label directions.",
         "Use caution with hormone-sensitive conditions, blood-pressure or diabetes medicines, kidney disease, or liver disease."),
        ("epimedium", "Epimedium (Horny Goat Weed)", "hormone_support", "mg", "limited", "high",
         "Traditional botanical marketed for libido and erectile-function support; human evidence is limited and safety concerns are more important than claims.",
         "If used, follow label directions and avoid stimulant or ED-medication stacking.",
         "Avoid with cardiovascular disease, arrhythmias, nitrates, PDE-5 inhibitors, blood-pressure medicines, pregnancy, or breastfeeding unless a clinician approves."),
        ("boron", "Boron", "mineral", "mg", "limited", "moderate",
         "Trace mineral found in plant foods; sometimes included in hormone-support stacks, but libido and testosterone claims are not well established.",
         "With food; keep total supplemental dose conservative.",
         "Do not exceed labeled doses. Avoid high-dose use, especially with kidney disease, pregnancy, or breastfeeding unless directed by a clinician."),
        ("inositol", "Inositol", "metabolic", "g", "moderate", "low",
         "Carbohydrate-like compound commonly used for metabolic and cycle-related support.",
         "Daily, often split across meals.",
         "Can cause GI upset at higher doses."),
        ("nac", "N-Acetylcysteine", "antioxidant", "mg", "moderate", "moderate",
         "Cysteine precursor used to support glutathione pathways and respiratory mucus clearance.",
         "With or without food, following label directions.",
         "Can interact with nitroglycerin and may not fit some asthma or bleeding-risk situations."),
        ("iodine", "Iodine", "mineral", "mcg", "moderate", "moderate",
         "Trace mineral needed for thyroid hormone production; useful when intake is low.",
         "With food.",
         "Too much or too little can affect thyroid function; use caution with thyroid disease."),
        ("copper", "Copper", "mineral", "mg", "limited", "moderate",
         "Trace mineral sometimes used to balance long-term zinc supplementation.",
         "With food.",
         "Excess copper can be harmful; avoid stacking multiple mineral products."),
        ("cla", "CLA", "weight_management", "g", "limited", "moderate",
         "Conjugated linoleic acid is marketed for body composition, but practical effects are small.",
         "With meals if used.",
         "Can cause GI discomfort and may worsen lipid or glucose markers in some users."),
        ("apple_cider_vinegar", "Apple Cider Vinegar", "metabolic", "serving", "limited", "low",
         "Popular vinegar-based product for appetite or glucose-response support; effects are modest.",
         "With meals, diluted if liquid.",
         "Undiluted vinegar can irritate the throat and tooth enamel."),
    ]
    try:
        with Session(engine) as session:
            existing_by_slug = {
                r.slug: r for r in session.exec(select(SupplementIngredient)).all()
            }
            added = 0
            updated = 0
            for (slug, name, cat, unit, evid, risk, desc, timing, safety) in seeds:
                details = supplement_detail_metadata(slug)
                existing = existing_by_slug.get(slug)
                if existing:
                    changed = False
                    for field in ("common_uses", "deficiency_risks", "excess_risks", "food_sources"):
                        if getattr(existing, field, None) in (None, [], "") and details.get(field):
                            setattr(existing, field, details[field])
                            changed = True
                    if changed:
                        session.add(existing)
                        updated += 1
                    continue
                session.add(SupplementIngredient(
                    slug=slug, name=name, category=cat, default_unit=unit,
                    evidence_tier=evid, risk_tier=risk,
                    description=desc, timing_notes=timing, safety_notes=safety,
                    common_uses=details.get("common_uses"),
                    deficiency_risks=details.get("deficiency_risks"),
                    excess_risks=details.get("excess_risks"),
                    food_sources=details.get("food_sources"),
                ))
                added += 1
            if added or updated:
                session.commit()
                print(f"[migration] seeded {added} supplement ingredients, updated {updated}")
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


def _ensure_meal_item_nutrient_snapshot_columns() -> None:
    """Add optional per-item nutrient snapshots for imported/scanned meals.

    MFP and similar exports carry serving-level fiber/sodium/sugar/sat-fat
    values. Storing them on MealItem lets historical rows contribute to
    quality/recovery metrics even when no canonical FoodNutrition row exists.

    The 2026-05 expansion adds the rest of the panel the AI / USDA can
    actually return: trans fat, alcohol, omega-3 subtypes (ALA/EPA/DHA),
    omega-6, choline, iodine, vitamin K/E, and phosphorus. Each is
    nullable — NULL means "source didn't report it", 0 means "source
    reported zero". Aggregations must preserve that distinction.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for column_sql in (
                # 2024 nutrient snapshot set.
                "saturated_fat_g DOUBLE PRECISION",
                "cholesterol_mg DOUBLE PRECISION",
                "sodium_mg DOUBLE PRECISION",
                "fiber_g DOUBLE PRECISION",
                "sugar_g DOUBLE PRECISION",
                "added_sugar_g DOUBLE PRECISION",
                # 2026-05 expansion — fats panel completeness, stimulants,
                # micronutrient completeness for insight scoring.
                "trans_fat_g DOUBLE PRECISION",
                "alcohol_g DOUBLE PRECISION",
                "omega_3_ala_mg DOUBLE PRECISION",
                "omega_3_epa_mg DOUBLE PRECISION",
                "omega_3_dha_mg DOUBLE PRECISION",
                "omega_6_mg DOUBLE PRECISION",
                "choline_mg DOUBLE PRECISION",
                "iodine_mcg DOUBLE PRECISION",
                "vitamin_k_mcg DOUBLE PRECISION",
                "vitamin_e_mg DOUBLE PRECISION",
                "phosphorus_mg DOUBLE PRECISION",
            ):
                conn.execute(text(
                    f"ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
    except Exception as e:
        print(f"[migration] meal_items nutrient snapshot columns add failed (non-fatal): {e}")


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


def _ensure_exercise_set_notes_column() -> None:
    """Add free-form `notes` to exercise_sets — surfaced inline on each
    set card in ActiveWorkoutScreen for per-set commentary."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE exercise_sets ADD COLUMN IF NOT EXISTS notes TEXT",
            ))
    except Exception as e:
        print(f"[migration] exercise_sets notes add failed (non-fatal): {e}")


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
            # Prebiotic fiber — fermentable fibers (inulin, FOS, GOS,
            # resistant starch) that feed the gut microbiome. USDA
            # doesn't expose this cleanly so values come from a curated
            # lookup (high-confidence foods) + AI estimation fallback.
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS prebiotic_g_per_serving DOUBLE PRECISION",
            ))
            conn.execute(text(
                "ALTER TABLE daily_nutrition_metrics ADD COLUMN IF NOT EXISTS prebiotic_g DOUBLE PRECISION DEFAULT 0",
            ))
    except Exception as e:
        print(f"[migration] food_metadata / daily_metrics amount columns add failed (non-fatal): {e}")


def _ensure_food_metadata_insight_tag_columns() -> None:
    """Add cached Health Insight tag columns to food metadata and daily metrics."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS insight_tags JSONB",
            ))
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS insight_tags_source VARCHAR DEFAULT 'none'",
            ))
            conn.execute(text(
                "ALTER TABLE food_metadata ADD COLUMN IF NOT EXISTS insight_tags_confidence DOUBLE PRECISION DEFAULT 0",
            ))
            conn.execute(text(
                "ALTER TABLE daily_nutrition_metrics ADD COLUMN IF NOT EXISTS insight_tag_counts JSONB",
            ))
    except Exception as e:
        print(f"[migration] food_metadata insight tag columns add failed (non-fatal): {e}")


def _ensure_health_insights_v2_columns() -> None:
    """Nullable source-data columns for Health Insights V2 accuracy.

    These are all additive. Existing users stay in unknown/missing-data
    states until clients send structured values.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for column_sql in (
                "kidney_stone_history VARCHAR DEFAULT 'unknown'",
                "stone_type VARCHAR",
                "stone_history_source VARCHAR",
                "stone_history_updated_at TIMESTAMPTZ",
                "reproductive_health_opt_in BOOLEAN DEFAULT FALSE",
                "cycle_tracking_enabled BOOLEAN DEFAULT FALSE",
                "trying_to_conceive BOOLEAN",
                "pregnancy_status VARCHAR",
                "known_pcos BOOLEAN",
                "known_endometriosis BOOLEAN",
                "gestational_diabetes_history BOOLEAN",
                "glp1_support JSONB",
            ):
                conn.execute(text(
                    f"ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            for column_sql in (
                "pain_present BOOLEAN",
                "pain_body_part VARCHAR",
                "pain_side VARCHAR",
                "pain_severity_0_10 INTEGER",
                "soreness_body_part VARCHAR",
                "soreness_severity_0_10 INTEGER",
                "pain_note TEXT",
                "onset_context VARCHAR",
            ):
                conn.execute(text(
                    f"ALTER TABLE user_day_state ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            for column_sql in (
                "caffeine_mg DOUBLE PRECISION",
                "potassium_mg DOUBLE PRECISION",
                "calcium_mg DOUBLE PRECISION",
                "magnesium_mg DOUBLE PRECISION",
                "iron_mg DOUBLE PRECISION",
                "vitamin_d_mcg DOUBLE PRECISION",
                "vitamin_b12_mcg DOUBLE PRECISION",
                "folate_mcg DOUBLE PRECISION",
                "zinc_mg DOUBLE PRECISION",
                "omega_3_g DOUBLE PRECISION",
            ):
                conn.execute(text(
                    f"ALTER TABLE meal_items ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            for column_sql in (
                "caffeine_mg DOUBLE PRECISION DEFAULT 0",
                "potassium_mg DOUBLE PRECISION DEFAULT 0",
                "calcium_mg DOUBLE PRECISION DEFAULT 0",
                "magnesium_mg DOUBLE PRECISION DEFAULT 0",
                "iron_mg DOUBLE PRECISION DEFAULT 0",
                "vitamin_d_mcg DOUBLE PRECISION DEFAULT 0",
                "vitamin_b12_mcg DOUBLE PRECISION DEFAULT 0",
                "folate_mcg DOUBLE PRECISION DEFAULT 0",
                "zinc_mg DOUBLE PRECISION DEFAULT 0",
                "omega_3_g DOUBLE PRECISION DEFAULT 0",
                "micronutrient_item_count INTEGER DEFAULT 0",
            ):
                conn.execute(text(
                    f"ALTER TABLE daily_nutrition_metrics ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            for column_sql in (
                "name VARCHAR",
                "normalized_name VARCHAR",
                "timing_context VARCHAR DEFAULT 'unknown'",
                "source VARCHAR DEFAULT 'manual'",
                "confidence DOUBLE PRECISION",
            ):
                conn.execute(text(
                    f"ALTER TABLE supplement_logs ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_supplement_logs_normalized_name "
                "ON supplement_logs(user_id, normalized_name)"
            ))
            for column_sql in (
                "movement_pattern_snapshot VARCHAR",
                "impact_level VARCHAR",
                "load_type VARCHAR",
                "intensity_estimate DOUBLE PRECISION",
                "novelty_flag BOOLEAN",
            ):
                conn.execute(text(
                    f"ALTER TABLE workout_exercises ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
    except Exception as e:
        print(f"[migration] health insights v2 columns add failed (non-fatal): {e}")


def _ensure_daily_health_snapshot_table() -> None:
    """Create `daily_health_snapshots` if missing, add new HealthKit
    columns, and add the unique `(user_id, snapshot_date)` constraint.
    SQLModel.create_all already handles the table itself, so this
    guarantees legacy DBs converge to the current shape.

    Idempotent — safe to run on every startup.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            for column_sql in (
                "basal_energy_kcal DOUBLE PRECISION",
                "respiratory_rate DOUBLE PRECISION",
                "oxygen_saturation DOUBLE PRECISION",
                "wrist_temperature_c DOUBLE PRECISION",
                "sleep_breathing_disturbances DOUBLE PRECISION",
                "sleep_breathing_disturbances_elevated BOOLEAN",
                "source_details JSONB",
            ):
                conn.execute(text(
                    f"ALTER TABLE daily_health_snapshots ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_health_snapshot "
                "ON daily_health_snapshots (user_id, snapshot_date)"
            ))
    except Exception as e:
        print(f"[migration] daily_health_snapshots constraint ensure failed (non-fatal): {e}")


def _ensure_daily_stress_summary_table() -> None:
    """Ensure persisted Daily Stress summaries converge on existing DBs."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_stress_summary "
                "ON daily_stress_summaries (user_id, summary_date)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_daily_stress_user_date "
                "ON daily_stress_summaries (user_id, summary_date)"
            ))
    except Exception as e:
        print(f"[migration] daily_stress_summaries ensure failed (non-fatal): {e}")


def _ensure_daily_lifestyle_logs_table() -> None:
    """Ensure optional daily lifestyle logs exist on legacy databases."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                """
                CREATE TABLE IF NOT EXISTS daily_lifestyle_logs (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    local_date DATE NOT NULL,
                    alcohol_level VARCHAR,
                    alcohol_drinks DOUBLE PRECISION,
                    alcohol_timing VARCHAR,
                    cannabis_level VARCHAR,
                    cannabis_timing VARCHAR,
                    bowel_movement_count INTEGER,
                    bowel_consistency VARCHAR,
                    stress_level VARCHAR,
                    illness_state VARCHAR,
                    caffeine_mg DOUBLE PRECISION,
                    caffeine_timing VARCHAR,
                    late_caffeine BOOLEAN,
                    appetite VARCHAR,
                    notes TEXT,
                    source VARCHAR NOT NULL DEFAULT 'manual',
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
                """
            ))
            for column_sql in (
                "alcohol_level VARCHAR",
                "alcohol_drinks DOUBLE PRECISION",
                "alcohol_timing VARCHAR",
                "cannabis_level VARCHAR",
                "cannabis_timing VARCHAR",
                "bowel_movement_count INTEGER",
                "bowel_consistency VARCHAR",
                "stress_level VARCHAR",
                "illness_state VARCHAR",
                "caffeine_mg DOUBLE PRECISION",
                "caffeine_timing VARCHAR",
                "late_caffeine BOOLEAN",
                "appetite VARCHAR",
                "notes TEXT",
                "source VARCHAR NOT NULL DEFAULT 'manual'",
                "created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()",
                "updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()",
            ):
                conn.execute(text(
                    f"ALTER TABLE daily_lifestyle_logs ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_lifestyle_log_user_date "
                "ON daily_lifestyle_logs (user_id, local_date)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_daily_lifestyle_logs_user_date "
                "ON daily_lifestyle_logs (user_id, local_date)"
            ))
    except Exception as e:
        print(f"[migration] daily_lifestyle_logs ensure failed (non-fatal): {e}")


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


def _ensure_user_profile_lifestyle_activity_column() -> None:
    """Add nullable `lifestyle_activity` to user_profiles. Drives the
    step_2b TDEE modifier in calorie_calculator. Existing rows get NULL
    which means "not asked yet" — the calorie path skips the modifier
    so TDEE stays at the legacy training-schedule-only estimate. The
    onboarding flow and the EditProfile screen both write this field."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS lifestyle_activity VARCHAR"
            ))
            # Same field also lives on user_preferences (the model + onboarding
            # upsert read/write it there). Missing here caused every endpoint
            # that loads UserPreferences — food search, sun exposure, change-
            # focus, etc. — to 500 with UndefinedColumn. VARCHAR matches the
            # model's `lifestyle_activity: str | None`.
            conn.execute(text(
                "ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS lifestyle_activity VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] user_profiles lifestyle_activity add failed (non-fatal): {e}")


def _ensure_user_profile_unit_preference_columns() -> None:
    """Add nullable display-unit preference columns. NULL = defaults (imperial:
    lbs / mi / in). Values themselves stay canonical lbs / miles / ft+in so
    no data migration is needed when a user toggles units."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS weight_unit VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS distance_unit VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS height_unit VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] user_profiles unit preference columns add failed (non-fatal): {e}")


def _ensure_social_tables() -> None:
    """Create indexes for the social tables on legacy DBs. SQLModel
    create_all builds the tables themselves; this just guarantees the
    pair-uniqueness + week-uniqueness + notification indexes exist.

    Idempotent — safe on every startup.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_social_profiles "
                "ADD COLUMN IF NOT EXISTS avatar_url TEXT"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_friendship_pair "
                "ON friendships (user_a_id, user_b_id)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_weekly_digest_user_week "
                "ON weekly_digest_cache (user_id, week_start)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_feed_like_user_item "
                "ON feed_likes (user_id, feed_item_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_feed_comments_item_created "
                "ON feed_comments(feed_item_id, created_at)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_activity_feed_user_created "
                "ON activity_feed(user_id, created_at)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_social_notification_actor_subject "
                "ON social_notifications (user_id, actor_user_id, notification_type, subject_type, subject_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_social_notifications_user_created "
                "ON social_notifications(user_id, created_at DESC)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_social_notifications_user_read "
                "ON social_notifications(user_id, read_at)"
            ))
    except Exception as e:
        print(f"[migration] social indexes ensure failed (non-fatal): {e}")


def _ensure_trainer_tables() -> None:
    """Create indexes for trainer/client relationship tables on legacy DBs.

    The tables are created by SQLModel.metadata.create_all; this helper keeps
    the role/status lookup paths and pair uniqueness ready for existing DBs.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_trainer_client_pair "
                "ON trainer_client_relationships (trainer_user_id, client_user_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_trainer_client_trainer_status "
                "ON trainer_client_relationships(trainer_user_id, status)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_trainer_client_client_status "
                "ON trainer_client_relationships(client_user_id, status)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_trainer_client_notes_relationship_created "
                "ON trainer_client_notes(relationship_id, created_at DESC)"
            ))
    except Exception as e:
        print(f"[migration] trainer indexes ensure failed (non-fatal): {e}")


def _ensure_watch_device_tables() -> None:
    """Keep watch cellular auth/command indexes present on existing DBs."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_watch_device_user_active "
                "ON watch_devices(user_id, revoked_at, expires_at)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_watch_command_user_created "
                "ON watch_command_events(user_id, created_at)"
            ))
    except Exception as e:
        print(f"[migration] watch device indexes ensure failed (non-fatal): {e}")


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


def _ensure_weight_entry_logged_at_column() -> None:
    """Add logged_at to weight_entries so same-day weigh-ins keep the
    actual log time while entry_date remains the trend bucket."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE weight_entries ADD COLUMN IF NOT EXISTS logged_at TIMESTAMPTZ",
            ))
            conn.execute(text(
                "UPDATE weight_entries SET logged_at = created_at WHERE logged_at IS NULL",
            ))
    except Exception as e:
        print(f"[migration] weight_entries logged_at column failed (non-fatal): {e}")


def _ensure_cycle_log_symptom_columns() -> None:
    """Move period symptom check-ins from client storage into cycle_logs.

    log_date is the per-user idempotency key for daily symptom check-ins;
    legacy rows without it remain exportable but are not returned as saved
    app check-ins unless they can be backfilled.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE cycle_logs ADD COLUMN IF NOT EXISTS log_date DATE"))
            conn.execute(text("ALTER TABLE cycle_logs ADD COLUMN IF NOT EXISTS phase VARCHAR"))
            conn.execute(text("ALTER TABLE cycle_logs ADD COLUMN IF NOT EXISTS cramps VARCHAR"))
            conn.execute(text("ALTER TABLE cycle_logs ADD COLUMN IF NOT EXISTS energy VARCHAR"))
            conn.execute(text("ALTER TABLE cycle_logs ADD COLUMN IF NOT EXISTS training_action VARCHAR"))
            conn.execute(text("ALTER TABLE cycle_logs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"))
            conn.execute(text("""
                UPDATE cycle_logs
                SET log_date = (
                    period_start_date
                    + ((GREATEST(COALESCE(cycle_day, 1), 1) - 1) * INTERVAL '1 day')
                )::date
                WHERE log_date IS NULL
                  AND period_start_date IS NOT NULL
                  AND cycle_day IS NOT NULL
            """))
            conn.execute(text("""
                WITH ranked AS (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY user_id, log_date
                               ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
                           ) AS rn
                    FROM cycle_logs
                    WHERE log_date IS NOT NULL
                )
                UPDATE cycle_logs
                SET log_date = NULL
                WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_cycle_logs_user_log_date "
                "ON cycle_logs(user_id, log_date)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_cycle_logs_user_log_date "
                "ON cycle_logs(user_id, log_date) WHERE log_date IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] cycle_logs symptom columns failed (non-fatal): {e}")


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


def _ensure_user_custom_exercises_table() -> None:
    """Create user_custom_exercises if it doesn't exist.

    `SQLModel.create_all` handles fresh databases; this keeps existing
    Postgres databases in sync after lifting custom exercises out of the
    opaque user_state blob.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS user_custom_exercises (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    name VARCHAR NOT NULL,
                    normalized_name VARCHAR NOT NULL,
                    primary_muscle VARCHAR NOT NULL DEFAULT 'full_body',
                    secondary_muscles JSONB NOT NULL DEFAULT '[]',
                    equipment VARCHAR NOT NULL DEFAULT '',
                    equipment_slugs JSONB NOT NULL DEFAULT '[]',
                    equipment_bucket VARCHAR NOT NULL DEFAULT '',
                    movement_pattern VARCHAR,
                    exercise_type VARCHAR NOT NULL DEFAULT 'strength',
                    default_tracking_mode VARCHAR NOT NULL DEFAULT 'reps',
                    is_compound BOOLEAN,
                    image_url VARCHAR,
                    video_id VARCHAR,
                    demo_exercise_db_id VARCHAR,
                    sets INTEGER NOT NULL DEFAULT 3,
                    reps VARCHAR NOT NULL DEFAULT '8-12',
                    rest_seconds INTEGER NOT NULL DEFAULT 60,
                    description TEXT,
                    form_cues JSONB NOT NULL DEFAULT '[]',
                    aliases JSONB NOT NULL DEFAULT '[]',
                    programming_tags JSONB NOT NULL DEFAULT '[]',
                    source VARCHAR NOT NULL DEFAULT 'manual',
                    plan_eligible BOOLEAN NOT NULL DEFAULT FALSE,
                    ai_confidence VARCHAR,
                    validation_status VARCHAR NOT NULL DEFAULT 'needs_review',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_user_custom_exercise_name UNIQUE(user_id, normalized_name)
                )
            """))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS equipment_slugs JSONB NOT NULL DEFAULT '[]'"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS equipment_bucket VARCHAR NOT NULL DEFAULT ''"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS exercise_type VARCHAR NOT NULL DEFAULT 'strength'"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS default_tracking_mode VARCHAR NOT NULL DEFAULT 'reps'"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS plan_eligible BOOLEAN NOT NULL DEFAULT FALSE"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS ai_confidence VARCHAR"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS validation_status VARCHAR NOT NULL DEFAULT 'needs_review'"))
            conn.execute(text("ALTER TABLE user_custom_exercises ADD COLUMN IF NOT EXISTS programming_tags JSONB NOT NULL DEFAULT '[]'"))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_custom_exercises_user_id "
                "ON user_custom_exercises(user_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_custom_exercises_normalized_name "
                "ON user_custom_exercises(normalized_name)"
            ))
    except Exception as e:
        print(f"[migration] user_custom_exercises table failed (non-fatal): {e}")


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


def _ensure_meal_image_columns() -> None:
    """Add optional `image_url` / `image_source` columns to meals and
    saved_meals. Both nullable — meal write paths and the meal UI must
    keep working when the fields are NULL. `image_source` is a free-form
    provenance tag (e.g. "user_photo", "recipe", "product", "category")
    so future cleanup jobs can distinguish user-uploaded photos from
    auto-resolved fallbacks."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS image_url TEXT"))
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS image_source VARCHAR"))
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS image_url TEXT"))
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS image_source VARCHAR"))
    except Exception as e:
        print(f"[migration] meal image columns failed (non-fatal): {e}")


def _ensure_saved_meal_sharing_columns() -> None:
    """Add share/import metadata for saved meal templates.

    Share codes are nullable and unique only when present, so private
    saved meals can coexist without a code while shared meals are
    addressable by the import endpoint.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS share_code VARCHAR"))
            conn.execute(text(
                "ALTER TABLE saved_meals "
                "ADD COLUMN IF NOT EXISTS times_imported INTEGER NOT NULL DEFAULT 0"
            ))
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS source_share_code VARCHAR"))
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS source_owner_username VARCHAR"))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_saved_meals_share_code "
                "ON saved_meals(share_code) WHERE share_code IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_saved_meals_source_share_code "
                "ON saved_meals(source_share_code) WHERE source_share_code IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] saved_meals sharing columns failed (non-fatal): {e}")


def _ensure_meal_saved_meal_link_column() -> None:
    """Add an optional link from logged meals back to the saved-meal
    template they came from. Renaming a favorite can then update every
    linked meal name while leaving macro/item snapshots untouched."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS saved_meal_id INTEGER"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_meals_saved_meal_id ON meals(saved_meal_id)"))
    except Exception as e:
        print(f"[migration] meal saved-meal link column failed (non-fatal): {e}")


def _ensure_meal_client_key_column() -> None:
    """Add the original client slot key for meal rows.

    MealType is intentionally coarse for analytics, but the client can
    render arbitrary plan rows such as meal_4 and meal_5. Keeping the slot
    key prevents plan-check idempotency from collapsing distinct extra
    meals into one snack row.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS client_meal_key VARCHAR"))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meals_client_meal_key "
                "ON meals(client_meal_key) WHERE client_meal_key IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] meal client_meal_key column failed (non-fatal): {e}")


def _ensure_meal_delete_constraints() -> None:
    """Make meal deletes child-safe and saved-meal unlinking non-blocking."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'meal_items_meal_id_fkey'
                          AND conrelid = 'meal_items'::regclass
                          AND confdeltype <> 'c'
                    ) THEN
                        ALTER TABLE meal_items DROP CONSTRAINT meal_items_meal_id_fkey;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'meal_items_meal_id_fkey'
                          AND conrelid = 'meal_items'::regclass
                    ) THEN
                        ALTER TABLE meal_items
                        ADD CONSTRAINT meal_items_meal_id_fkey
                        FOREIGN KEY (meal_id) REFERENCES meals(id) ON DELETE CASCADE;
                    END IF;
                END $$;
            """))
            conn.execute(text("""
                UPDATE meals m
                SET saved_meal_id = NULL
                WHERE saved_meal_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM saved_meals sm WHERE sm.id = m.saved_meal_id
                  )
            """))
            conn.execute(text("""
                DO $$
                BEGIN
                    IF EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'meals_saved_meal_id_fkey'
                          AND conrelid = 'meals'::regclass
                          AND confdeltype <> 'n'
                    ) THEN
                        ALTER TABLE meals DROP CONSTRAINT meals_saved_meal_id_fkey;
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1
                        FROM pg_constraint
                        WHERE conname = 'meals_saved_meal_id_fkey'
                          AND conrelid = 'meals'::regclass
                    ) THEN
                        ALTER TABLE meals
                        ADD CONSTRAINT meals_saved_meal_id_fkey
                        FOREIGN KEY (saved_meal_id) REFERENCES saved_meals(id) ON DELETE SET NULL;
                    END IF;
                END $$;
            """))
    except Exception as e:
        print(f"[migration] meal delete constraints failed (non-fatal): {e}")


def _ensure_body_scan_quality_columns() -> None:
    """Add quality/provenance columns to body_scans for photo-estimate ranges.
    Optional metadata only; older rows remain valid."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS confidence VARCHAR"))
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS photo_quality VARCHAR"))
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS quality_flags JSONB DEFAULT '[]'"))
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS needs_retake BOOLEAN NOT NULL DEFAULT FALSE"))
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS method VARCHAR"))
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS visual_estimate_pct DOUBLE PRECISION"))
            conn.execute(text("ALTER TABLE body_scans ADD COLUMN IF NOT EXISTS measurement_estimate_pct DOUBLE PRECISION"))
    except Exception as e:
        print(f"[migration] body_scans quality columns failed (non-fatal): {e}")


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


def _ensure_workout_completion_route_coords_column() -> None:
    """Add route_coords JSONB to workout_completions for outdoor cardio
    GPS trails. Captured by cardioGpsTracker (iPhone) or
    HKWorkoutRouteBuilder (watch), including optional altitude; rendered
    on the post-workout map."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS route_coords JSONB"
            ))
    except Exception as e:
        print(f"[migration] workout_completions route_coords failed (non-fatal): {e}")


def _ensure_user_preferences_sun_exposure_column() -> None:
    """Store opt-in sun exposure preferences as a JSON object on preferences."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS sun_exposure_preferences JSONB"
            ))
    except Exception as e:
        print(f"[migration] user_preferences sun exposure prefs failed (non-fatal): {e}")


def _ensure_sun_exposure_tables() -> None:
    """Create derived sun exposure tables for existing Postgres DBs."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS sun_exposure_segments (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    start_time TIMESTAMPTZ NOT NULL,
                    end_time TIMESTAMPTZ NOT NULL,
                    duration_minutes DOUBLE PRECISION NOT NULL,
                    coarse_location_hash VARCHAR,
                    activity_id INTEGER REFERENCES workout_completions(id),
                    uv_index_average DOUBLE PRECISION NOT NULL DEFAULT 0,
                    uv_index_max DOUBLE PRECISION NOT NULL DEFAULT 0,
                    light_intensity_lux DOUBLE PRECISION,
                    local_start_minute INTEGER,
                    local_end_minute INTEGER,
                    timezone_offset_minutes INTEGER,
                    daylight BOOLEAN NOT NULL DEFAULT TRUE,
                    outdoor_confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
                    area_context JSONB NOT NULL DEFAULT '{}'::jsonb,
                    effective_uv_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
                    open_sky_equivalent_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
                    confidence VARCHAR NOT NULL DEFAULT 'low',
                    source VARCHAR NOT NULL DEFAULT 'coarse_location',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "ALTER TABLE sun_exposure_segments "
                "ADD COLUMN IF NOT EXISTS light_intensity_lux DOUBLE PRECISION"
            ))
            for column_sql in (
                "local_start_minute INTEGER",
                "local_end_minute INTEGER",
                "timezone_offset_minutes INTEGER",
            ):
                conn.execute(text(
                    f"ALTER TABLE sun_exposure_segments ADD COLUMN IF NOT EXISTS {column_sql}"
                ))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS sun_exposure_corrections (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    segment_id INTEGER REFERENCES sun_exposure_segments(id),
                    correction_type VARCHAR NOT NULL,
                    context_key VARCHAR,
                    area_type VARCHAR,
                    adjusted_sky_exposure_coefficient DOUBLE PRECISION,
                    adjusted_outdoor_confidence DOUBLE PRECISION,
                    notes TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_sun_exposure_user_start "
                "ON sun_exposure_segments(user_id, start_time)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_sun_exposure_user_activity "
                "ON sun_exposure_segments(user_id, activity_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_sun_exposure_correction_context "
                "ON sun_exposure_corrections(user_id, context_key)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_sun_exposure_correction_segment "
                "ON sun_exposure_corrections(user_id, segment_id)"
            ))
    except Exception as e:
        print(f"[migration] sun exposure tables failed (non-fatal): {e}")


def _ensure_context_insight_tables() -> None:
    """Create context-aware insight tables for existing Postgres DBs."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS user_insight_preferences (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL UNIQUE REFERENCES "user"(id),
                    enable_move_insights BOOLEAN NOT NULL DEFAULT FALSE,
                    enable_recovery_insights BOOLEAN NOT NULL DEFAULT FALSE,
                    enable_environment_insights BOOLEAN NOT NULL DEFAULT FALSE,
                    enable_social_insights BOOLEAN NOT NULL DEFAULT FALSE,
                    enable_pattern_insights BOOLEAN NOT NULL DEFAULT FALSE,
                    use_coarse_location BOOLEAN NOT NULL DEFAULT FALSE,
                    use_workout_routes BOOLEAN NOT NULL DEFAULT FALSE,
                    use_weather_environment_data BOOLEAN NOT NULL DEFAULT FALSE,
                    use_social_context BOOLEAN NOT NULL DEFAULT FALSE,
                    allow_notifications BOOLEAN NOT NULL DEFAULT FALSE,
                    allow_occasional_correction_prompts BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS context_insights (
                    id SERIAL PRIMARY KEY,
                    insight_key VARCHAR NOT NULL,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    type VARCHAR NOT NULL,
                    category VARCHAR NOT NULL,
                    title VARCHAR NOT NULL,
                    summary TEXT NOT NULL,
                    recommended_action TEXT NOT NULL,
                    confidence VARCHAR NOT NULL DEFAULT 'low',
                    data_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
                    explanation TEXT NOT NULL,
                    safety_note TEXT,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    valid_until TIMESTAMPTZ,
                    dismissed_at TIMESTAMPTZ,
                    CONSTRAINT uq_context_insight_user_key UNIQUE (user_id, insight_key)
                )
            """))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS context_segments (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    start_time TIMESTAMPTZ NOT NULL,
                    end_time TIMESTAMPTZ NOT NULL,
                    coarse_location_hash VARCHAR,
                    place_category VARCHAR,
                    activity_type VARCHAR,
                    workout_id INTEGER REFERENCES workout_completions(id),
                    daylight BOOLEAN,
                    uv_index DOUBLE PRECISION,
                    air_quality_index INTEGER,
                    temperature DOUBLE PRECISION,
                    humidity DOUBLE PRECISION,
                    elevation_gain_meters DOUBLE PRECISION,
                    steps INTEGER,
                    heart_rate_avg DOUBLE PRECISION,
                    social_context VARCHAR,
                    confidence VARCHAR NOT NULL DEFAULT 'low',
                    source JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS daily_feature_sets (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    date DATE NOT NULL,
                    steps INTEGER NOT NULL DEFAULT 0,
                    active_minutes INTEGER NOT NULL DEFAULT 0,
                    strength_workout_count INTEGER NOT NULL DEFAULT 0,
                    weight_bearing_minutes INTEGER NOT NULL DEFAULT 0,
                    mobility_minutes INTEGER NOT NULL DEFAULT 0,
                    elevation_gain_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
                    outdoor_daylight_minutes INTEGER NOT NULL DEFAULT 0,
                    open_sky_equivalent_minutes INTEGER NOT NULL DEFAULT 0,
                    high_uv_minutes INTEGER NOT NULL DEFAULT 0,
                    sleep_duration_minutes INTEGER,
                    sleep_consistency_score DOUBLE PRECISION,
                    resting_heart_rate DOUBLE PRECISION,
                    hrv DOUBLE PRECISION,
                    workout_load DOUBLE PRECISION,
                    recovery_score DOUBLE PRECISION,
                    social_activity_count INTEGER,
                    active_commute_minutes INTEGER,
                    sedentary_block_minutes INTEGER,
                    source JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_daily_feature_set_user_date UNIQUE (user_id, date)
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_context_insight_user_created "
                "ON context_insights(user_id, created_at DESC)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_context_insight_user_category "
                "ON context_insights(user_id, category)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_context_segment_user_start "
                "ON context_segments(user_id, start_time)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_context_segment_user_place "
                "ON context_segments(user_id, place_category)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_daily_feature_set_user_date "
                "ON daily_feature_sets(user_id, date)"
            ))
    except Exception as e:
        print(f"[migration] context insight tables failed (non-fatal): {e}")


def _ensure_fitness_score_snapshots_table() -> None:
    """Create fitness_score_snapshots — one persisted Thallo-score
    reading per user per day. The /ai/fitness/composite-score endpoint
    upserts today's row and returns the 28-day average across these
    rows. SQLModel.create_all builds the table on a fresh DB; this
    handles legacy DBs."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS fitness_score_snapshots (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    snapshot_date DATE NOT NULL,
                    total DOUBLE PRECISION NOT NULL,
                    strength DOUBLE PRECISION NOT NULL,
                    cardio DOUBLE PRECISION NOT NULL,
                    consistency DOUBLE PRECISION NOT NULL,
                    recovery DOUBLE PRECISION NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_fitness_score_snapshot UNIQUE (user_id, snapshot_date)
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_fitness_score_snapshots_user_date "
                "ON fitness_score_snapshots(user_id, snapshot_date)"
            ))
    except Exception as e:
        print(f"[migration] fitness_score_snapshots table failed (non-fatal): {e}")


def _ensure_workout_template_owner_attribution_column() -> None:
    """Add source_owner_username so imported copies carry attribution
    even after the original share code is revoked."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_templates "
                "ADD COLUMN IF NOT EXISTS source_owner_username VARCHAR"
            ))
    except Exception as e:
        print(f"[migration] workout_templates source_owner_username failed (non-fatal): {e}")


def _ensure_user_preferences_manual_mode_columns() -> None:
    """Add Pro-only manual-mode flags to user_preferences. When set, the
    planner stops auto-generating workouts/meals and the user assembles
    their own week from saved templates."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS workout_manual_mode BOOLEAN NOT NULL DEFAULT FALSE"
            ))
            conn.execute(text(
                "ALTER TABLE user_preferences "
                "ADD COLUMN IF NOT EXISTS meal_manual_mode BOOLEAN NOT NULL DEFAULT FALSE"
            ))
    except Exception as e:
        print(f"[migration] user_preferences manual-mode columns failed (non-fatal): {e}")


def _ensure_workout_template_bundles_tables() -> None:
    """Create workout_template_bundles + workout_template_bundle_items.

    A bundle is a named collection of per-template share codes — the
    multi-template share layer. Bundle codes are 8 chars (the per-template
    code is 6) so the API path can disambiguate by length. Items store the
    underlying template share_code as a snapshot, not an FK — see the model
    docstring for why.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS workout_template_bundles (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    name VARCHAR NOT NULL DEFAULT '',
                    share_code VARCHAR NOT NULL DEFAULT '',
                    times_imported INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_template_bundles_user "
                "ON workout_template_bundles(user_id)"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_workout_template_bundles_share_code "
                "ON workout_template_bundles(share_code) WHERE share_code <> ''"
            ))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS workout_template_bundle_items (
                    id SERIAL PRIMARY KEY,
                    bundle_id INTEGER NOT NULL REFERENCES workout_template_bundles(id) ON DELETE CASCADE,
                    share_code VARCHAR NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    CONSTRAINT uq_bundle_item_share_code UNIQUE (bundle_id, share_code)
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_template_bundle_items_bundle "
                "ON workout_template_bundle_items(bundle_id)"
            ))
    except Exception as e:
        print(f"[migration] workout_template_bundles tables failed (non-fatal): {e}")


def _ensure_workout_templates_table() -> None:
    """Create workout_templates — user-authored single-day workouts that can
    optionally be shared via a 6-char alphanumeric code. SQLModel.create_all
    handles fresh installs; this helper keeps existing prod DBs in sync."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS workout_templates (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES "user"(id),
                    client_id VARCHAR NOT NULL DEFAULT '',
                    name VARCHAR NOT NULL,
                    notes TEXT,
                    workout_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    share_code VARCHAR,
                    times_imported INTEGER NOT NULL DEFAULT 0,
                    source_share_code VARCHAR,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_workout_template_user_client UNIQUE (user_id, client_id)
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_templates_user "
                "ON workout_templates(user_id)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_templates_client "
                "ON workout_templates(client_id)"
            ))
            # Partial unique index: share_code is unique only when set, so
            # multiple private templates (NULL share_code) can coexist.
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ux_workout_templates_share_code "
                "ON workout_templates(share_code) WHERE share_code IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] workout_templates table failed (non-fatal): {e}")


def _ensure_meal_routine_idempotency_column() -> None:
    """Per-create idempotency key on meal_routines, with a partial-unique index
    so a retried / double-submitted create dedupes instead of duplicating."""
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE meal_routines ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meal_routines_user_idem "
                "ON meal_routines (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] meal_routines idempotency ensure failed (non-fatal): {e}")


def _ensure_readiness_hot_indexes() -> None:
    """Composite (user_id, date) indexes on the hottest per-user-per-day tables.
    Each is filtered by both columns together on the readiness compute and home
    day-state paths; a composite index beats bitmap-AND-ing two single-column
    indexes and avoids heap re-checks for these high-frequency lookups."""
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_daily_lifestyle_user_date "
                "ON daily_lifestyle_logs (user_id, local_date)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_user_day_state_user_day "
                "ON user_day_state (user_id, day_key)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_workout_completions_user_date "
                "ON workout_completions (user_id, workout_date)"
            ))
    except Exception as e:
        print(f"[migration] readiness hot indexes ensure failed (non-fatal): {e}")


def _ensure_integration_credentials_table() -> None:
    """Per-user OAuth credential storage for Strava / Oura / WHOOP / etc.

    Tokens are plaintext for now — see model docstring for the
    production-encryption note. Index on (user_id, provider) enforces
    one connection per provider per user.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE TABLE IF NOT EXISTS integration_credentials ("
                "id SERIAL PRIMARY KEY, "
                'user_id INTEGER NOT NULL REFERENCES "user"(id), '
                "provider VARCHAR NOT NULL, "
                "access_token VARCHAR, "
                "refresh_token VARCHAR, "
                "expires_at TIMESTAMPTZ, "
                "external_user_id VARCHAR, "
                "extras JSONB, "
                "status VARCHAR NOT NULL DEFAULT 'active', "
                "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), "
                "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), "
                "last_synced_at TIMESTAMPTZ, "
                "CONSTRAINT uq_integration_user_provider UNIQUE(user_id, provider)"
                ")"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_integration_status "
                "ON integration_credentials(status)"
            ))
    except Exception as e:
        print(f"[migration] integration_credentials table failed (non-fatal): {e}")


def _ensure_import_batches_table() -> None:
    """Create the `import_batches` table + supporting indexes.

    Each row is one upload from an external app (MFP / Strong / Strava /
    etc.). Per-row idempotency lives on the target tables (`Meal` and
    `WorkoutCompletion` got new `import_hash` columns); this table just
    tracks the upload itself + the user-facing counters.

    SQLModel.create_all() will create the table on a fresh install, but
    existing DBs need this idempotent helper. Indexes are partial
    where possible to keep them small.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "CREATE TABLE IF NOT EXISTS import_batches ("
                "id SERIAL PRIMARY KEY, "
                'user_id INTEGER NOT NULL REFERENCES "user"(id), '
                "source VARCHAR NOT NULL, "
                "data_type VARCHAR NOT NULL DEFAULT 'meals', "
                "filename VARCHAR, "
                "status VARCHAR NOT NULL DEFAULT 'processing', "
                "total_rows INTEGER NOT NULL DEFAULT 0, "
                "matched_rows INTEGER NOT NULL DEFAULT 0, "
                "ai_matched_rows INTEGER NOT NULL DEFAULT 0, "
                "fallback_rows INTEGER NOT NULL DEFAULT 0, "
                "skipped_rows INTEGER NOT NULL DEFAULT 0, "
                "error_rows INTEGER NOT NULL DEFAULT 0, "
                "errors JSONB NOT NULL DEFAULT '[]'::jsonb, "
                "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), "
                "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), "
                "completed_at TIMESTAMPTZ"
                ")"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_import_batches_user_status "
                "ON import_batches(user_id, status)"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_import_batches_source "
                "ON import_batches(source)"
            ))
    except Exception as e:
        print(f"[migration] import_batches table failed (non-fatal): {e}")


def _ensure_meal_import_columns() -> None:
    """Add import provenance columns to `meals` + partial unique index.

    Native meal logs leave these null and behave exactly as before. The
    partial unique index on (user_id, import_hash) WHERE import_hash IS
    NOT NULL is the idempotency guarantee — re-uploading the same MFP
    export hits a constraint instead of inserting duplicate rows.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE meals "
                "ADD COLUMN IF NOT EXISTS import_source VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE meals "
                "ADD COLUMN IF NOT EXISTS import_batch_id INTEGER "
                "REFERENCES import_batches(id) ON DELETE SET NULL"
            ))
            conn.execute(text(
                "ALTER TABLE meals "
                "ADD COLUMN IF NOT EXISTS import_hash VARCHAR"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meals_import_source "
                "ON meals(import_source) WHERE import_source IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meals_import_batch "
                "ON meals(import_batch_id) WHERE import_batch_id IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meals_user_import_hash "
                "ON meals(user_id, import_hash) WHERE import_hash IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] meals import columns failed (non-fatal): {e}")


def _ensure_meal_idempotency_columns() -> None:
    """Add template/routine provenance + idempotency columns to `meals`.

    Two partial unique indexes provide the core write-safety guarantees of
    the meal-logging refactor (templates vs instances):

      * uq_meals_user_idempotency_key (user_id, idempotency_key) — a
        double-tapped / retried "log" collapses to one row.
      * uq_meals_user_routine_occurrence (user_id, source_routine_id,
        routine_occurrence_key) — a routine occurrence logs at most once.

    Both are partial (WHERE ... IS NOT NULL) so legacy / manual rows that
    leave the columns null can repeat freely. The meal_routines and
    routine_occurrence_exceptions tables themselves are created by
    SQLModel.metadata.create_all on startup; this only alters `meals`.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS source_type VARCHAR"))
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS source_routine_id INTEGER"))
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS routine_occurrence_key VARCHAR"))
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR"))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meals_source_type "
                "ON meals(source_type) WHERE source_type IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meals_source_routine_id "
                "ON meals(source_routine_id) WHERE source_routine_id IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meals_user_idempotency_key "
                "ON meals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meals_user_routine_occurrence "
                "ON meals(user_id, source_routine_id, routine_occurrence_key) "
                "WHERE source_routine_id IS NOT NULL AND routine_occurrence_key IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] meals idempotency columns failed (non-fatal): {e}")


def _ensure_saved_meal_idempotency_columns() -> None:
    """Add `idempotency_key` to `saved_meals` plus a partial unique index.

    Mirrors `_ensure_meal_idempotency_columns`. The (user_id,
    idempotency_key) partial unique index lets a retried "Save as
    Favorite" POST collapse to the existing row instead of creating a
    duplicate saved-meal template. WHERE-clause is partial so legacy
    rows (NULL idempotency_key) are unaffected.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR"))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_meals_user_idempotency_key "
                "ON saved_meals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] saved_meals idempotency column failed (non-fatal): {e}")


def _ensure_meal_page_contract_columns() -> None:
    """Add canonical meal-page fields used for concurrency + favorites."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"))
            conn.execute(text("ALTER TABLE meals ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1"))
            conn.execute(text("ALTER TABLE saved_meals ADD COLUMN IF NOT EXISTS source_meal_id INTEGER"))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_saved_meals_source_meal_id "
                "ON saved_meals(source_meal_id) WHERE source_meal_id IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_meals_user_source_meal "
                "ON saved_meals(user_id, source_meal_id) WHERE source_meal_id IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] meal page contract columns failed (non-fatal): {e}")


def _ensure_meal_routine_display_order_column() -> None:
    """Add routine display ordering for account-wide meal routine order."""
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE meal_routines "
                "ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_meal_routines_user_order "
                "ON meal_routines(user_id, display_order, created_at)"
            ))
    except Exception as e:
        print(f"[migration] meal routine display order column failed (non-fatal): {e}")


def _ensure_workout_completion_import_columns() -> None:
    """Same pattern as `_ensure_meal_import_columns` but for
    `workout_completions`. Powers Strong + Strava + Hevy imports.
    """
    if engine.dialect.name != "postgresql":
        return
    try:
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS import_source VARCHAR"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS import_batch_id INTEGER "
                "REFERENCES import_batches(id) ON DELETE SET NULL"
            ))
            conn.execute(text(
                "ALTER TABLE workout_completions "
                "ADD COLUMN IF NOT EXISTS import_hash VARCHAR"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_wc_import_source "
                "ON workout_completions(import_source) WHERE import_source IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_wc_import_batch "
                "ON workout_completions(import_batch_id) WHERE import_batch_id IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_wc_user_import_hash "
                "ON workout_completions(user_id, import_hash) WHERE import_hash IS NOT NULL"
            ))
    except Exception as e:
        print(f"[migration] workout_completions import columns failed (non-fatal): {e}")


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
    include_backfills = env.get("STARTUP_BACKFILLS_ENABLED", "0") == "1"
    include_seeds = env.get("STARTUP_SEEDS_ENABLED", "1") == "1"
    return enabled, include_backfills, include_seeds


def create_db_and_tables():
    # Import all models to register them with SQLModel.metadata
    from app.models import Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood, FoodSubmission, Equipment, ExerciseEquipment, UserCustomExercise, GoalOption, PaceOption, User, LegalAcceptanceEvent, ClientTelemetryEvent, AIUsageEvent, BillingEvent, UserProfile, UserGoal, UserPreferences, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet, UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState, DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob, UserState, WorkoutPlan, NutritionPlan, FoodMetadata, DailyNutritionMetrics, WorkoutCompletion, BodyScan, SavedMeal, WorkoutTemplate, WorkoutTemplateBundle, WorkoutTemplateBundleItem, SupplementIngredient, SupplementProduct, SupplementProductIngredient, UserSupplementStack, SupplementLog, SleepLog, DailyHealthSnapshot, DailyStressSummary, DailyLifestyleLog, HealthLabResult, CycleLog, UserSocialProfile, Friendship, WeeklyDigestCache, ActivityFeedItem, FeedLike, FeedComment, SocialNotification, TrainerProfile, TrainerClientRelationship, TrainerClientNote, PlanWeek, PlanDay, UserEquipmentProfile, GearItem, ImportBatch, IntegrationCredential, FitnessScoreSnapshot, SunExposureSegment, SunExposureCorrection, UserInsightPreferences, ContextInsight, ContextSegment, DailyFeatureSet

    SQLModel.metadata.create_all(engine)
    _ensure_food_category_enum_values()
    _ensure_food_nutrition_extras_column()
    _ensure_food_search_indexes()
    _ensure_workout_completion_stimulus_column()
    _ensure_workout_completion_health_columns()
    _ensure_workout_completion_training_score_columns()
    _ensure_workout_history_source_columns()
    _ensure_workout_completion_activity_identity_columns()
    _ensure_user_preferences_equipment_settings_column()
    _ensure_user_preferences_baseline_columns()
    _ensure_user_preferences_injuries_structured_column()
    _ensure_user_preferences_pending_imports_column()
    _ensure_user_preferences_custom_macros_column()
    _ensure_user_supplement_stack_group_column()
    _ensure_user_supplement_stack_ai_metadata_columns()
    _ensure_supplement_detail_metadata_columns()
    _ensure_coach_apply_state_columns()
    _backfill_user_preferences_preferred_split()
    _ensure_user_recovery_columns()
    _ensure_user_subscription_tier_column()
    _ensure_user_plan_cadence_anchor_column()
    _ensure_user_goal_track_column()
    _ensure_user_goal_baseline_columns()
    _ensure_exercise_tracking_mode_column()
    _ensure_exercise_video_id_column()
    _ensure_exercise_flow_category_column()
    _ensure_exercise_demo_db_id_column()
    _clear_stale_tibialis_demo_id()
    _patch_band_squat_loaded_setup()
    _ensure_exercise_emphasis_column()
    _backfill_exercise_emphasis()
    _ensure_food_metadata_classifier_v2_columns()
    _ensure_daily_nutrition_metrics_v2_columns()
    _ensure_nutrition_v3_columns()
    _ensure_nutrition_log_status_columns()
    _ensure_meal_consumed_at_column()
    _ensure_meal_image_columns()
    _ensure_saved_meal_sharing_columns()
    _ensure_meal_saved_meal_link_column()
    _ensure_meal_client_key_column()
    _ensure_meal_delete_constraints()
    _ensure_meal_item_nutrient_snapshot_columns()
    _ensure_weight_entry_logged_at_column()
    _ensure_user_profile_birthdate_column()
    _ensure_user_profile_lifestyle_activity_column()
    _ensure_user_profile_unit_preference_columns()
    _ensure_food_metadata_amounts_columns()
    _ensure_food_metadata_insight_tag_columns()
    _ensure_health_insights_v2_columns()
    _ensure_exercise_set_actual_rir_column()
    _ensure_exercise_set_notes_column()
    _ensure_daily_health_snapshot_table()
    _ensure_daily_stress_summary_table()
    _ensure_daily_lifestyle_logs_table()
    _ensure_social_tables()
    _ensure_trainer_tables()
    _ensure_watch_device_tables()
    _ensure_exercise_set_duration_columns()
    _ensure_exercise_set_cardio_hr_columns()
    _ensure_cycle_log_symptom_columns()
    _ensure_user_custom_exercises_table()
    _ensure_user_equipment_profiles_table()
    _ensure_weekly_checkin_body_columns()
    _ensure_weekly_checkin_measurements_columns()
    _ensure_body_scan_quality_columns()
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
    _ensure_workout_templates_table()
    _ensure_workout_template_owner_attribution_column()
    _ensure_workout_completion_route_coords_column()
    _ensure_user_preferences_sun_exposure_column()
    _ensure_sun_exposure_tables()
    _ensure_context_insight_tables()
    _ensure_fitness_score_snapshots_table()
    _ensure_workout_template_bundles_tables()
    _ensure_user_preferences_manual_mode_columns()
    # Data-import provenance (MFP/Strong/Strava/etc.). Order matters:
    # import_batches table must exist before meals + workout_completions
    # can install their FK columns.
    _ensure_import_batches_table()
    _ensure_meal_import_columns()
    _ensure_meal_idempotency_columns()
    _ensure_saved_meal_idempotency_columns()
    _ensure_meal_page_contract_columns()
    _ensure_meal_routine_display_order_column()
    _ensure_workout_completion_import_columns()
    # Per-user OAuth credentials for Strava/Oura/WHOOP/Garmin/Fitbit.
    _ensure_integration_credentials_table()
    _ensure_readiness_hot_indexes()
    _ensure_meal_routine_idempotency_column()

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
