from sqlmodel import SQLModel, Field, Column
from sqlalchemy import Enum as SAEnum, JSON, UniqueConstraint, Index, text, Date
from datetime import datetime, date, timezone

from app.enums import (
    GoalType, GoalPace, Gender, MealType,
    EquipmentType, MuscleGroup, WorkoutSource, MealSource, FoodCategory,
    FoodSource, ExerciseType, EquipmentRole,
)


# ─── Auth ─────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    email: str = Field(unique=True, index=True)
    username: str = Field(unique=True, index=True)
    hashed_password: str
    is_active: bool = Field(default=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    recovery_question: str | None = Field(default=None)
    recovery_answer_hash: str | None = Field(default=None)
    first_name: str | None = Field(default=None)
    last_name: str | None = Field(default=None)
    terms_accepted_at: datetime | None = Field(default=None)
    terms_version: str | None = Field(default=None)
    privacy_accepted_at: datetime | None = Field(default=None)
    privacy_version: str | None = Field(default=None)
    health_disclaimer_accepted_at: datetime | None = Field(default=None)
    health_disclaimer_version: str | None = Field(default=None)
    ai_disclaimer_accepted_at: datetime | None = Field(default=None)
    ai_disclaimer_version: str | None = Field(default=None)
    email_verified_at: datetime | None = Field(default=None)
    email_verification_token_hash: str | None = Field(default=None)
    email_verification_expires_at: datetime | None = Field(default=None)
    password_reset_token_hash: str | None = Field(default=None)
    password_reset_expires_at: datetime | None = Field(default=None)
    account_deleted_at: datetime | None = Field(default=None)
    subscription_tier: str = Field(default="free", index=True)
    apple_sub: str | None = Field(default=None, unique=True, index=True)
    # Bumped on logout, password change, and password reset. Encoded as
    # `tv` in JWTs; `get_current_user` rejects tokens whose `tv` is below
    # the user's current value. Lets us invalidate every existing token
    # for an account without flushing the JWT signing key globally.
    token_version: int = Field(default=0)
    # Day-of-week anchor for the user's plan-week cadence. Set once at
    # first PlanWeek creation (the user's "sign-up day"); auto-renewal
    # walks forward in 7-day increments from this date instead of
    # snapping to Monday or chaining off prev.end_date. Storing it on
    # User makes the cadence a pure function of (anchor, today) — robust
    # to PlanWeek wipes, multi-device clock skew, or any path that
    # creates a new PlanWeek out-of-band. Backfilled for pre-existing
    # users from their earliest PlanWeek.start_date in
    # `_ensure_user_plan_cadence_anchor_column`. Nullable until backfill
    # runs (callers must fall back to today / earliest plan week).
    plan_cadence_anchor: date | None = Field(default=None)


class ClientTelemetryEvent(SQLModel, table=True):
    __tablename__ = "client_telemetry_events"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = Field(default=None, foreign_key="user.id", index=True)
    anonymous_id: str | None = Field(default=None, index=True)
    event_name: str = Field(index=True)
    platform: str | None = Field(default=None)
    app_version: str | None = Field(default=None)
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


# ─── User profile / stats ─────────────────────────────────────────────────────

class UserProfile(SQLModel, table=True):
    __tablename__ = "user_profiles"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    weight_lbs: float
    height_feet: int
    height_inches: int
    # `age` stays as a materialized int so every existing consumer keeps
    # working without touching date math. When `birthdate` is set, the
    # profile router re-derives age on every read + write so the cached
    # int stays in sync as users age over time.
    age: int
    birthdate: date | None = Field(default=None, sa_column=Column(Date, nullable=True))
    gender: Gender = Field(sa_column=Column(SAEnum(Gender), nullable=False))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserGoal(SQLModel, table=True):
    __tablename__ = "user_goals"
    __table_args__ = (
        Index(
            'ix_user_goal_active_unique',
            'user_id',
            unique=True,
            postgresql_where=text('is_active = true'),
        ),
    )
    # Only one active goal per user should exist at a time.
    # Enforced at the DB level via partial unique index above.
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    goal_type: GoalType = Field(sa_column=Column(SAEnum(GoalType), nullable=False))
    goal_track: str | None = Field(default=None)
    pace: GoalPace = Field(sa_column=Column(SAEnum(GoalPace), nullable=False))
    target_weight_lbs: float | None = Field(default=None)
    timeline_weeks: int | None = Field(default=None)
    is_active: bool = Field(default=True, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserPreferences(SQLModel, table=True):
    __tablename__ = "user_preferences"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    days_per_week: int = Field(default=3)
    workout_duration_minutes: int | None = Field(default=None)
    core_frequency_per_week: int | None = Field(default=None)
    equipment: list = Field(default_factory=list, sa_column=Column(JSON))
    equipment_settings: dict | None = Field(default=None, sa_column=Column(JSON))
    foods_available: list = Field(default_factory=list, sa_column=Column(JSON))
    injuries: list = Field(default_factory=list, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserCoachingState(SQLModel, table=True):
    __tablename__ = "user_coaching_state"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    calorie_adjustment: int = Field(default=0)    # daily calories delta from baseline
    volume_adjustment_pct: int = Field(default=0) # training volume delta percentage
    deload_until_date: date | None = Field(default=None)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserDayState(SQLModel, table=True):
    __tablename__ = "user_day_state"
    __table_args__ = (UniqueConstraint("user_id", "day_key", name="uq_user_day_state"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    day_key: date = Field(index=True)
    skipped_focus: str | None = Field(default=None)
    skip_reason: str | None = Field(default=None)
    meal_checks: dict = Field(default_factory=dict, sa_column=Column(JSON))
    nutrition_plan: dict | None = Field(default=None, sa_column=Column(JSON))
    macro_overrides: dict | None = Field(default=None, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SupplementAICache(SQLModel, table=True):
    """Per-user cache for AI-generated supplement recommendations.

    Signature-based invalidation: if `signature` matches the current
    user state (goal + stack + age decade + diet shape) AND
    `generated_at` is within TTL, return cached recs. Otherwise
    regenerate. Keeps AI cost predictable and load instant.
    """
    __tablename__ = "supplement_ai_cache"
    __table_args__ = (UniqueConstraint("user_id", name="uq_supplement_ai_cache_user"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    signature: str = Field(default="")          # input-hash for invalidation
    recs_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SleepLog(SQLModel, table=True):
    """Per-night sleep snapshot. Lets us:
      1. survive device wipes (sleep history was AsyncStorage-only),
      2. compute personalized sleep score from server-side history,
      3. expose nightly sleep to the check-in / weekly-review coaches.
    night_date is the date the sleep ENDED (waking date) so today's
    score uses today's row.
    """
    __tablename__ = "sleep_logs"
    __table_args__ = (UniqueConstraint("user_id", "night_date", name="uq_sleep_log_night"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    night_date: date = Field(index=True)
    total_hours: float | None = Field(default=None)
    in_bed_minutes: int | None = Field(default=None)
    deep_hours: float | None = Field(default=None)
    rem_hours: float | None = Field(default=None)
    core_hours: float | None = Field(default=None)
    awake_minutes: int | None = Field(default=None)
    hrv_ms: float | None = Field(default=None)
    resting_hr: float | None = Field(default=None)
    respiratory_rate: float | None = Field(default=None)
    spo2_percent: float | None = Field(default=None)
    bedtime_minutes_from_midnight: int | None = Field(default=None)
    score: int | None = Field(default=None)              # last-computed score 0-100
    rating: str | None = Field(default=None)             # "Excellent" / "Good" / "Fair" / "Poor"
    mode: str | None = Field(default=None)               # "mvp" | "personalized"
    source: str = Field(default="apple_health")          # apple_health | manual | watch
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SleepLogUpsert(SQLModel):
    """Client → server payload for nightly sleep persistence. Fields
    optional so the client can patch a partial record (e.g. score
    re-computed after a stage data backfill)."""
    night_date: date
    total_hours: float | None = None
    in_bed_minutes: int | None = None
    deep_hours: float | None = None
    rem_hours: float | None = None
    core_hours: float | None = None
    awake_minutes: int | None = None
    hrv_ms: float | None = None
    resting_hr: float | None = None
    respiratory_rate: float | None = None
    spo2_percent: float | None = None
    bedtime_minutes_from_midnight: int | None = None
    score: int | None = None
    rating: str | None = None
    mode: str | None = None
    source: str | None = None


class DailyHealthSnapshot(SQLModel, table=True):
    """One row per user per day with everything Apple Health (and the
    Apple Watch via HealthKit) reports. Lets weekly_review + recovery
    flags read real history instead of the in-memory phone aggregator
    (which only knows about today + a 30-min stale window).

    All fields optional — phone can patch a partial snapshot when the
    user only granted some HealthKit permissions, and the upsert path
    fills in what's available without overwriting prior good values.

    Source: 'apple_health' (default) | 'manual' | 'watch'.
    """
    __tablename__ = "daily_health_snapshots"
    __table_args__ = (UniqueConstraint("user_id", "snapshot_date", name="uq_daily_health_snapshot"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    snapshot_date: date = Field(index=True)
    # Activity + steps
    steps: int | None = Field(default=None)
    active_energy_kcal: float | None = Field(default=None)
    workout_minutes: int | None = Field(default=None)
    cardio_minutes: int | None = Field(default=None)         # any HR-elevated activity
    zone2_minutes: int | None = Field(default=None)          # specifically Z2
    # Cardiovascular
    resting_hr: float | None = Field(default=None)
    hrv_ms: float | None = Field(default=None)
    vo2_max: float | None = Field(default=None)
    # Body
    weight_lbs: float | None = Field(default=None)
    # Optional readiness composite (computed phone-side)
    readiness_score: int | None = Field(default=None)
    source: str = Field(default="apple_health")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DailyHealthSnapshotUpsert(SQLModel):
    """Client → server payload for the daily HealthKit snapshot. All
    fields optional so a partial-permissions user can still patch."""
    snapshot_date: date
    steps: int | None = None
    active_energy_kcal: float | None = None
    workout_minutes: int | None = None
    cardio_minutes: int | None = None
    zone2_minutes: int | None = None
    resting_hr: float | None = None
    hrv_ms: float | None = None
    vo2_max: float | None = None
    weight_lbs: float | None = None
    readiness_score: int | None = None
    source: str | None = None


class WeeklyCheckIn(SQLModel, table=True):
    __tablename__ = "weekly_checkins"
    __table_args__ = (UniqueConstraint("user_id", "checkin_date", name="uq_weekly_checkin"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    checkin_date: date = Field(index=True)
    weight_lbs: float
    waist_in: float | None = Field(default=None)
    chest_in: float | None = Field(default=None)
    hips_in: float | None = Field(default=None)
    bicep_in: float | None = Field(default=None)
    thigh_in: float | None = Field(default=None)
    calf_in: float | None = Field(default=None)
    body_fat_pct: float | None = Field(default=None)
    bp_systolic: int | None = Field(default=None)
    bp_diastolic: int | None = Field(default=None)
    energy: int = Field(default=3)
    sleep: int = Field(default=3)
    adherence: int = Field(default=3)
    notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PlanWeekCheckin(SQLModel, table=True):
    """One-time coaching check-in per PlanWeek.
    Day-8 auto-renew proceeds immediately; this stores the expired week's
    prompt/recap and any submitted coach adjustments.
    Stores the deterministic review snapshot + AI decision + self-report ratings."""
    __tablename__ = "plan_week_checkins"
    __table_args__ = (UniqueConstraint("user_id", "plan_week_id", name="uq_plan_week_checkin"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    plan_week_id: int = Field(foreign_key="plan_weeks.id", index=True)
    week_start_date: date = Field(sa_column=Column(Date, nullable=False))
    week_end_date: date = Field(sa_column=Column(Date, nullable=False))
    submitted_at: datetime | None = Field(default=None)
    skipped: bool = Field(default=False)
    # Self-report ratings 1–5
    energy: int | None = Field(default=None)
    hunger: int | None = Field(default=None)
    soreness: int | None = Field(default=None)
    motivation: int | None = Field(default=None)
    schedule_issue: bool = Field(default=False)
    note: str | None = Field(default=None)
    # Snapshotted review + AI output
    review_snapshot_json: dict | None = Field(default=None, sa_column=Column(JSON))
    ai_decision_id: int | None = Field(default=None)  # references ai_decisions.id
    ai_message: str | None = Field(default=None)
    ai_delta: dict | None = Field(default=None, sa_column=Column(JSON))
    commitments_json: list | None = Field(default=None, sa_column=Column(JSON))
    plan_goal: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CoachMemory(SQLModel, table=True):
    __tablename__ = "coach_memory"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    event_type: str = Field(index=True)  # e.g. checkin_adjustment, guardrail
    summary: str
    details: dict | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RecoveryActivity(SQLModel, table=True):
    """User-logged recovery modalities — cold plunge, sauna, breathwork,
    meditation. Stored separately from workouts since they're aimed at
    parasympathetic recovery, not training stimulus. Lets the app
    correlate "ice bath last night → next-morning HRV" so users can see
    whether the modality is actually doing anything for them."""
    __tablename__ = "recovery_activities"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    activity_date: date = Field(index=True)
    modality: str       # "cold_plunge" | "sauna" | "breathwork" | "meditation" | "stretching" | "other"
    duration_min: int   # whole minutes; UI step is 1
    intensity: str | None = Field(default=None)  # e.g. "30s @ 50°F" — optional free text
    notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RecoveryActivityCreate(SQLModel):
    """Client → server payload for logging a recovery activity."""
    activity_date: date
    modality: str
    duration_min: int
    intensity: str | None = None
    notes: str | None = None


# ─── AI check-in system: rollups, flags, decisions ────────────────────────────
#
# Foundation for the coach check-in payload described in docs/ai-checkin.md.
# These tables are **derived** from existing meal/workout/checkin data so they
# can always be recomputed. Never write business logic against them as the
# source of truth — they're a precomputed cache for fast payload assembly and
# flag evaluation.

class DailyRollup(SQLModel, table=True):
    """One row per user per day. Derived from meals + workout_sessions + checkins."""
    __tablename__ = "daily_rollups"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_daily_rollup"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    day: date = Field(index=True)
    # Nutrition totals
    kcal: float = Field(default=0)
    protein_g: float = Field(default=0)
    carbs_g: float = Field(default=0)
    fat_g: float = Field(default=0)
    meals_logged: int = Field(default=0)
    # Targets snapshot (from active plan at time of rollup)
    kcal_target: float | None = Field(default=None)
    protein_target_g: float | None = Field(default=None)
    # Training
    session_planned: bool = Field(default=False)
    session_completed: bool = Field(default=False)
    session_focus: str | None = Field(default=None)   # e.g. "Upper", "Lower", "Push"
    session_rpe_avg: float | None = Field(default=None)
    session_duration_min: int | None = Field(default=None)
    # Body / recovery (sparse — may come from checkin or HealthKit later)
    weight_lbs: float | None = Field(default=None)
    sleep_h: float | None = Field(default=None)
    steps: int | None = Field(default=None)
    # Self-report (latest checkin on or before this day)
    energy: int | None = Field(default=None)
    soreness: int | None = Field(default=None)
    computed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserRollup(SQLModel, table=True):
    """Rolling 7/14/28-day aggregates for a user, keyed by window. One row per window."""
    __tablename__ = "user_rollups"
    __table_args__ = (UniqueConstraint("user_id", "window_days", name="uq_user_rollup_window"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    window_days: int = Field(index=True)  # 7, 14, or 28
    as_of: date = Field(index=True)
    # Nutrition
    kcal_avg: float | None = Field(default=None)
    kcal_target_delta_pct: float | None = Field(default=None)
    protein_adherence_pct: float | None = Field(default=None)  # % of days ≥85% of target
    days_logged: int = Field(default=0)
    adherence_pct: float | None = Field(default=None)          # % of days within ±15% of kcal target
    # Training
    sessions_planned: int = Field(default=0)
    sessions_completed: int = Field(default=0)
    session_completion_pct: float | None = Field(default=None)
    # Body / recovery
    weight_ema_lbs: float | None = Field(default=None)
    weight_slope_lbs_per_wk: float | None = Field(default=None)
    sleep_avg_h: float | None = Field(default=None)
    steps_avg: int | None = Field(default=None)
    computed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserFlag(SQLModel, table=True):
    """Active coaching flags. Evaluated from UserRollup + DailyRollup by the flag engine."""
    __tablename__ = "user_flags"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_flag_key"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    key: str = Field(index=True)                # e.g. "low_adherence_7d"
    severity: str = Field(default="low")        # low | med | high
    value: str | None = Field(default=None)     # human-readable e.g. "86% of target"
    details: dict | None = Field(default=None, sa_column=Column(JSON))
    active_since: date
    last_evaluated: date
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserState(SQLModel, table=True):
    """Opaque JSON blob holding the full client-side user state — profile,
    plans, routines, custom exercises/foods, meal edits, histories, etc.
    The client pushes this on sign-out + key lifecycle events, and pulls it
    on sign-in. Gives us cross-device sync without needing a dedicated
    column per field (which would require real migrations every time the
    client shape evolves). Individual fields can be lifted into their own
    columns later if we ever want to query them server-side.
    """
    __tablename__ = "user_state"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    state_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class PlanJob(SQLModel, table=True):
    """Async plan-generation job. Survives app kills / network drops on the
    client — the client enqueues a job, disconnects freely, and polls the
    status endpoint later to pick up the result.

    Status lifecycle: queued → running → completed | failed | cancelled.
    `result_json` is the full AI response payload (workout_plan + nutrition
    plans + notes), stored as JSON so the client can restore it verbatim.
    """
    __tablename__ = "plan_jobs"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    kind: str = Field(index=True)                      # "full" | "workout" | "nutrition"
    status: str = Field(default="queued", index=True)  # queued | running | completed | failed | cancelled
    request_json: dict | None = Field(default=None, sa_column=Column(JSON))   # opts passed to generator
    result_json: dict | None = Field(default=None, sa_column=Column(JSON))
    error: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    started_at: datetime | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)


class WorkoutPlan(SQLModel, table=True):
    """First-class persisted workout plan. One `is_active=True` row per user
    at a time — the authoritative source of truth for their current plan.
    Regeneration flips the old row to `is_active=False` (with a reason +
    timestamp) and inserts a fresh row with the new plan JSON. The client
    uses `AsyncStorage['aiWorkoutPlan']` as a zero-flicker hot cache that
    mirrors this row; cross-device sync pulls from here.

    `planner_version` is stamped on write from the constant in
    `services/workout/weekly_recipe.py`. When that constant bumps, older
    plans are considered stale and the client auto-regenerates.
    """
    __tablename__ = "workout_plans"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    planner_version: str                                # e.g. "2026.04.22.01" — bump on code change
    goal: str
    days_per_week: int
    preferred_split: str | None = Field(default=None)
    plan_json: dict = Field(default_factory=dict, sa_column=Column(JSON))  # full plan dict
    is_active: bool = Field(default=True, index=True)   # one active per user
    deactivated_at: datetime | None = Field(default=None)
    deactivation_reason: str | None = Field(default=None)  # "regen" | "goal_change" | "manual"


class NutritionPlan(SQLModel, table=True):
    """First-class persisted nutrition plan. Mirrors `WorkoutPlan` — one
    `is_active=True` row per user at a time, holding the serialized list
    of daily nutrition templates the client rotates through. Regeneration
    flips the old row to `is_active=False` with a reason + timestamp and
    inserts a fresh active row. The client's
    `AsyncStorage['aiNutritionPlans']` is a zero-flicker hot cache mirror
    of `plans_json` here; cross-device sync pulls from this row.

    `planner_version` is stamped from the same shared constant as
    `WorkoutPlan` so version staleness can be detected uniformly — a
    single planner bump invalidates both sides at once.
    """
    __tablename__ = "nutrition_plans"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    planner_version: str                                # same semantics as WorkoutPlan.planner_version
    goal: str
    days_per_week: int
    # JSON-serialized list of daily nutrition templates (client's
    # `aiNutritionPlans` array). Stored as a string so the payload is
    # opaque to the DB — shape can evolve without schema churn.
    plans_json: str
    trainer_note: str | None = Field(default=None)      # nutritionistNote
    is_active: bool = Field(default=True, index=True)   # one active per user
    deactivated_at: datetime | None = Field(default=None)
    deactivation_reason: str | None = Field(default=None)  # "regen" | "goal_change" | "manual"


# ─── Weekly Plan Model ────────────────────────────────────────────────────────

class PlanWeek(SQLModel, table=True):
    """One committed 7-day plan. One `status='active'` row per user at a time.
    Days are date-stamped and individually lockable. A new week starts only
    on explicit user request (`POST /plans/start-new-week`)."""
    __tablename__ = "plan_weeks"
    __table_args__ = (
        UniqueConstraint("user_id", "start_date", name="uq_plan_week_user_start"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    start_date: date
    end_date: date
    planner_version: str
    goal: str
    days_per_week: int
    preferred_split: str | None = Field(default=None)
    goal_pace: str | None = Field(default=None)       # conservative | moderate | aggressive
    session_minutes: int | None = Field(default=None)  # session duration at generation time
    status: str = Field(default="active")  # active | completed | abandoned
    # Travel / illness pause. When set to a future date, auto-renew, auto-skip,
    # and reminder scheduling all suspend until pause expires. Null means the
    # plan is running normally. Past dates are treated as not-paused (callers
    # check `is_paused()` rather than testing the column directly).
    paused_until: date | None = Field(default=None)
    paused_at: datetime | None = Field(default=None)
    pause_reason: str | None = Field(default=None)  # "travel" | "illness" | "other"
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = Field(default=None)
    abandoned_at: datetime | None = Field(default=None)


class PlanDay(SQLModel, table=True):
    """Individual day within a PlanWeek. Holds workout + nutrition payloads.
    Locked days are never touched by adapt/regenerate flows."""
    __tablename__ = "plan_days"
    __table_args__ = (
        UniqueConstraint("plan_week_id", "day_date", name="uq_plan_day_week_date"),
    )
    id: int | None = Field(default=None, primary_key=True)
    plan_week_id: int = Field(foreign_key="plan_weeks.id", index=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    day_date: date
    day_index: int
    status: str = Field(default="planned")  # planned | started | completed | skipped | edited
    is_rest: bool = Field(default=False)
    workout_json: dict | None = Field(default=None, sa_column=Column(JSON))
    nutrition_json: dict | None = Field(default=None, sa_column=Column(JSON))
    locked: bool = Field(default=False)
    locked_at: datetime | None = Field(default=None)
    lock_reason: str | None = Field(default=None)  # completed | started | manual_edit | skipped
    skip_reason: str | None = Field(default=None)
    generation_source: str = Field(default="initial")  # initial | adapt | swap | manual | backfill
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class BodyScan(SQLModel, table=True):
    """Persisted body-scan result. Previously stored client-side only
    (AsyncStorage `bodyScanHistory`), which meant users lost scan
    history on reinstall / device change. The AI response is stored
    verbatim plus the user's weight at time of scan."""
    __tablename__ = "body_scans"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    scan_date: date = Field(index=True)
    body_fat_pct: float | None = Field(default=None)
    body_fat_range: str | None = Field(default=None)
    muscle_mass: str | None = Field(default=None)         # low/below_average/average/above_average/high
    category: str | None = Field(default=None)            # Athletic / Lean / Average / ...
    strengths: list = Field(default_factory=list, sa_column=Column(JSON))
    improvements: list = Field(default_factory=list, sa_column=Column(JSON))
    assessment: str | None = Field(default=None)
    disclaimer: str | None = Field(default=None)
    weight_lbs: float | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class WeightEntry(SQLModel, table=True):
    __tablename__ = "weight_entries"
    __table_args__ = (UniqueConstraint("user_id", "entry_date", name="uq_weight_entry_user_date"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    entry_date: date = Field(index=True)
    weight_lbs: float
    source: str = Field(default="manual")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AIDecision(SQLModel, table=True):
    """Structured record of every AI coaching decision. Replaces prose chat history in payloads."""
    __tablename__ = "ai_decisions"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    checkin_type: str                 # "micro" | "weekly" | "manual" | "event"
    response_type: str                # "coach_only" | "small_adjust" | "deep_review" | "leave_alone" | "ask_more"
    rationale_key: str | None = Field(default=None)   # enum/slug like "stall_2wk_cut"
    delta: dict | None = Field(default=None, sa_column=Column(JSON))  # structured diff e.g. {"kcal": -100}
    flags_snapshot: list | None = Field(default=None, sa_column=Column(JSON))  # [{key, severity}, ...]
    message: str | None = Field(default=None)         # short coaching message shown to user
    plan_version_before: int | None = Field(default=None)
    plan_version_after: int | None = Field(default=None)
    accepted: bool = Field(default=True)              # user accepted the adjustment (if any)
    model: str | None = Field(default=None)           # which LLM model produced this


# ─── Exercise library (seeded reference data) ─────────────────────────────────

class Exercise(SQLModel, table=True):
    __tablename__ = "exercises"
    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(default="", index=True, unique=True)   # stable key for seeding
    name: str = Field(unique=True, index=True)
    primary_muscle: MuscleGroup = Field(sa_column=Column(SAEnum(MuscleGroup), nullable=False))
    secondary_muscles: list = Field(default_factory=list, sa_column=Column(JSON))
    # Legacy broad bucket — kept for WorkoutExercise compat. New code should use ExerciseEquipment.
    equipment: EquipmentType = Field(sa_column=Column(SAEnum(EquipmentType), nullable=False))
    is_compound: bool = Field(default=False)
    description: str | None = Field(default=None)
    is_custom: bool = Field(default=False)
    movement_pattern: str | None = Field(default=None)       # MovementPattern enum value
    exercise_type: str = Field(default="strength")           # ExerciseType enum value
    is_machine: bool = Field(default=False)
    is_unilateral: bool = Field(default=False)
    image_url: str | None = Field(default=None)
    # Curated YouTube video ID for the demo / form walkthrough. When
    # present the client shows a YouTube thumbnail card that deep-links
    # to the YouTube app. Fallback for untagged exercises is a
    # "Watch demo on YouTube" search card in the client. Only the ~50
    # most-used exercises need curation — everything else uses search.
    video_id: str | None = Field(default=None)
    # "reps" (default) | "time" | "distance" | "calories". Lets the planner
    # and the client pick the right rep-target string ("30-45s", "20-30 yds")
    # instead of defaulting to goal-based rep counts for holds / carries.
    default_tracking_mode: str = Field(default="reps")


# ─── Food library ─────────────────────────────────────────────────────────────
#
# Design: Food is the canonical identity row.  Nutrition lives in FoodNutrition
# (1-to-1 today, extensible to versioned rows later).  FoodServing holds every
# way you can measure that food.  FoodAlias enables fuzzy search.
# UserRecentFood tracks per-user recency for search ranking.
#
# Migration path:  The old `foods` table had inline macros + a single `unit`.
# The new schema keeps `foods` as the identity table (same PK, same tablename)
# but moves nutrition to `food_nutrition` and servings to `food_servings`.
# Old columns (calories, protein, …) are kept temporarily so existing
# MealItem.food_id FK and seed_foods() still work.  A data-migration step
# copies them to the new tables, after which the old columns can be dropped.

class Food(SQLModel, table=True):
    __tablename__ = "foods"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)                      # display name — NOT globally unique anymore
    normalized_name: str = Field(default="", index=True)  # lowercase, stripped, for dedup/search
    category: FoodCategory = Field(sa_column=Column(SAEnum(FoodCategory), nullable=False))
    source: FoodSource = Field(
        default=FoodSource.SEED,
        sa_column=Column(SAEnum(FoodSource), nullable=False),
    )
    owner_user_id: int | None = Field(default=None, foreign_key="user.id", index=True)
    external_id: str | None = Field(default=None, index=True)   # USDA fdc_id, Open Food Facts id, etc.
    barcode: str | None = Field(default=None, index=True)
    brand: str | None = Field(default=None)
    is_verified: bool = Field(default=False)           # True for seed + reviewed USDA entries
    is_active: bool = Field(default=True)              # soft-delete / hide AI junk
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    # ── Legacy columns (kept for backwards compat during migration) ──────────
    # These will be copied to FoodNutrition + FoodServing, then dropped.
    unit: str = Field(default="100g")
    calories: float = Field(default=0)
    protein: float = Field(default=0)
    carbs: float = Field(default=0)
    fat: float = Field(default=0)
    is_custom: bool = Field(default=False)
    serving_grams: float | None = Field(default=None)
    fiber: float | None = Field(default=None)
    sugar: float | None = Field(default=None)
    sodium_mg: float | None = Field(default=None)


class FoodNutrition(SQLModel, table=True):
    """Canonical nutrition per 100 g (or per stated reference).  One row per food.

    Top-level columns store the canonical macros + the legacy micronutrient
    fields the seed data is most likely to populate. Everything else (full
    vitamin/mineral panel, fatty-acid breakdown) lives in `extra_nutrients`
    as a free-form dict keyed by the canonical field name. Adding a JSON
    column instead of N typed columns means the schema can carry 30+ optional
    fields without a 30-column ALTER per migration.

    Canonical keys understood by the assembler (any subset may be present):
      cholesterol, vitamin_a, vitamin_c, vitamin_d, vitamin_e, vitamin_k,
      thiamin_b1, riboflavin_b2, niacin_b3, vitamin_b6, folate_b9,
      vitamin_b12, biotin_b7, pantothenic_acid_b5, calcium, iron, magnesium,
      phosphorus, potassium, zinc, selenium, copper, manganese,
      saturated_fat, monounsaturated_fat, polyunsaturated_fat, omega_3, omega_6.
    """
    __tablename__ = "food_nutrition"
    id: int | None = Field(default=None, primary_key=True)
    food_id: int = Field(foreign_key="foods.id", unique=True, index=True)
    # All values per 100 g unless reference_unit says otherwise
    reference_unit: str = Field(default="100g")        # "100g", "1 serving", etc.
    reference_grams: float = Field(default=100)        # grams that reference_unit equals
    calories: float = Field(default=0)
    protein: float = Field(default=0)
    carbs: float = Field(default=0)
    fat: float = Field(default=0)
    fiber: float | None = Field(default=None)
    sugar: float | None = Field(default=None)
    # Added sugars (FDA/USDA nutrient #1235). Distinct from total `sugar` —
    # fruit sugar has sugar but no added sugar. The Food Quality sub-score
    # uses added sugar, not total sugar, because the health signal lives here.
    added_sugar_g: float | None = Field(default=None)
    sodium_mg: float | None = Field(default=None)
    extra_nutrients: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class FoodServing(SQLModel, table=True):
    """One or more serving sizes per food.  The first inserted is the 'default'."""
    __tablename__ = "food_servings"
    __table_args__ = (UniqueConstraint("food_id", "label", name="uq_food_serving_label"),)
    id: int | None = Field(default=None, primary_key=True)
    food_id: int = Field(foreign_key="foods.id", index=True)
    label: str                                         # "1 large", "100g", "1 cup cooked"
    grams: float                                       # how many grams this serving equals
    is_default: bool = Field(default=False)            # UI pre-selects this one
    # Convenience: pre-calculated macros for this serving (derived from FoodNutrition)
    calories: float = Field(default=0)
    protein: float = Field(default=0)
    carbs: float = Field(default=0)
    fat: float = Field(default=0)


class FoodAlias(SQLModel, table=True):
    """Search aliases — maps alternate names / common misspellings to a food."""
    __tablename__ = "food_aliases"
    __table_args__ = (UniqueConstraint("alias_normalized", name="uq_food_alias_name"),)
    id: int | None = Field(default=None, primary_key=True)
    food_id: int = Field(foreign_key="foods.id", index=True)
    alias: str                                         # display form
    alias_normalized: str = Field(index=True)           # lowercased for search


class UserRecentFood(SQLModel, table=True):
    """Tracks the last time a user logged a particular food — for search ranking."""
    __tablename__ = "user_recent_foods"
    __table_args__ = (UniqueConstraint("user_id", "food_id", name="uq_user_recent_food"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    food_id: int = Field(foreign_key="foods.id", index=True)
    times_used: int = Field(default=1)
    last_used_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Equipment library (seeded reference data) ────────────────────────────────

class Equipment(SQLModel, table=True):
    __tablename__ = "equipment"
    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(default="", index=True, unique=True)  # stable key for seeding
    name: str = Field(unique=True, index=True)
    category: str  # e.g. "Bodyweight & Home", "Free Weights", etc.
    icon: str      # emoji
    is_custom: bool = Field(default=False)


class ExerciseEquipment(SQLModel, table=True):
    """Many-to-many: which concrete equipment items an exercise needs."""
    __tablename__ = "exercise_equipment"
    __table_args__ = (UniqueConstraint("exercise_id", "equipment_id", name="uq_exercise_equipment"),)
    id: int | None = Field(default=None, primary_key=True)
    exercise_id: int = Field(foreign_key="exercises.id", index=True)
    equipment_id: int = Field(foreign_key="equipment.id", index=True)
    required: bool = Field(default=True)
    role: str = Field(default="primary")  # EquipmentRole: primary | support | optional


# ─── User equipment profiles (capability-aware cardio tracking) ───────────────
#
# Tracks the specific machines/gear a user owns so cardio prescriptions can
# use the right metric tier (watts+RPM for an IC6 bike, speed+incline for a
# treadmill with display, RPE fallback for a basic bike with no metrics).
# This is separate from the seeded Equipment library — that table maps exercises
# to equipment types. This table maps users to their specific gear instances.

class UserEquipmentProfile(SQLModel, table=True):
    """One row per piece of cardio/strength equipment the user has registered."""
    __tablename__ = "user_equipment_profiles"
    __table_args__ = ()
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    # Broad category: "cardio" | "strength" | "mobility" | "recovery"
    category: str = Field(default="cardio")
    # Specific type — matches modality constants in cardio.py
    # e.g. "treadmill" | "bike" | "rower" | "elliptical" | "stair_climber"
    equipment_type: str = Field(default="")
    # User-facing label, e.g. "Life Fitness IC6"
    display_name: str = Field(default="")
    brand: str | None = Field(default=None)
    # Model name stored as model_name to avoid shadowing Python's model()
    model_name: str | None = Field(default=None)
    # "home" | "gym" | "outdoor"
    location: str = Field(default="gym")
    # Capability tokens — subset of CAP_* constants in cardio.py
    # e.g. ["time", "watts", "rpm", "heart_rate", "distance"]
    capabilities: list = Field(default_factory=list, sa_column=Column(JSON))
    notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Gear tracking ───────────────────────────────────────────────────────────
#
# Users register physical gear (running shoes, bike, jump rope…) and the
# app accumulates miles/sessions automatically from logged workouts.
# Retirement recommendations fire when accumulated use approaches the
# threshold for that gear type.

# Default retirement thresholds (miles). None = track sessions only.
GEAR_RETIREMENT_DEFAULTS: dict[str, float | None] = {
    "running_shoe":    400.0,
    "trail_shoe":      350.0,
    "cycling_shoe":    None,   # track sessions, not miles
    "bike":            None,
    "bike_tire":       2000.0,
    "bike_chain":      1500.0,
    "treadmill_belt":  3000.0,
    "jump_rope":       None,
    # Strength accessories — sessions only (no meaningful mile threshold).
    "lifting_shoe":    None,
    "lifting_belt":    None,
    "knee_sleeves":    None,
    "wrist_wraps":     None,
    "lifting_straps":  None,
    # Recovery / cardio accessories — sessions only.
    "chest_strap":     None,
    "yoga_mat":        None,
    "climbing_shoe":   None,
    "resistance_band": None,
    "foam_roller":     None,
    "massage_gun":     None,
    "boxing_gloves":   None,
    "other":           None,
}

class GearItem(SQLModel, table=True):
    __tablename__ = "gear_items"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    # Display name — user-supplied: "Brooks Ghost 14", "IC6 Spin Bike", etc.
    name: str = Field(default="")
    # Type slug drives default thresholds + auto-accumulation matching.
    gear_type: str = Field(default="other")
    purchase_date: date | None = Field(default=None)
    # Miles already on the gear when the user registered it (so the
    # retirement bar starts accurate even for used gear).
    starting_miles: float = Field(default=0.0)
    # Miles added by the app from logged workout sets (actual_distance).
    accumulated_miles: float = Field(default=0.0)
    # Session count regardless of whether distance was captured.
    accumulated_sessions: int = Field(default=0)
    is_active: bool = Field(default=True)
    # Override the type default. Null means "no mile-based threshold".
    retirement_threshold_miles: float | None = Field(default=None)
    # Session-based wear threshold for non-mileage gear (e.g. boxing gloves
    # at ~150 sessions). Null means "track usage but don't predict retirement."
    retirement_threshold_sessions: int | None = Field(default=None)
    # Last accumulation timestamp — surfaced in the UI as "Last used X ago"
    # so session-only gear feels alive even without mileage. Updated by the
    # auto-accumulation hook AND the manual log-miles endpoint.
    last_used_at: datetime | None = Field(default=None)
    # Activity keywords that trigger auto-accumulation (lowercase).
    # e.g. ["treadmill", "run", "incline walk"] for running shoes.
    auto_track_keywords: list = Field(default_factory=list, sa_column=Column(JSON))
    notes: str | None = Field(default=None)
    photos: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class GearItemCreate(SQLModel):
    name: str
    gear_type: str = "other"
    purchase_date: date | None = None
    starting_miles: float = 0.0
    retirement_threshold_miles: float | None = None
    retirement_threshold_sessions: int | None = None
    auto_track_keywords: list[str] = []
    notes: str | None = None
    photos: list[str] = []


class GearItemRead(SQLModel):
    id: int
    name: str
    gear_type: str
    purchase_date: date | None
    starting_miles: float
    accumulated_miles: float
    accumulated_sessions: int
    is_active: bool
    retirement_threshold_miles: float | None
    retirement_threshold_sessions: int | None = None
    last_used_at: datetime | None = None
    auto_track_keywords: list[str]
    notes: str | None
    photos: list[str] = []
    created_at: datetime
    # Computed fields populated by the router
    total_miles: float = 0.0
    pct_used: float | None = None        # 0–1+; None when no wear threshold
    recommendation: str | None = None   # human-readable status


# ─── Goal options (seeded reference data) ─────────────────────────────────────

class GoalOption(SQLModel, table=True):
    __tablename__ = "goal_options"
    id: int | None = Field(default=None, primary_key=True)
    value: str = Field(unique=True, index=True)
    label: str
    icon: str
    description: str


class PaceOption(SQLModel, table=True):
    __tablename__ = "pace_options"
    id: int | None = Field(default=None, primary_key=True)
    goal_value: str  # which goal this pace applies to
    value: str       # e.g. "conservative"
    label: str
    icon: str
    rate: str        # e.g. "~0.5 lbs/week"
    description: str


# ─── Workout completion tracking ──────────────────────────────────────────────

class WorkoutCompletion(SQLModel, table=True):
    __tablename__ = "workout_completions"
    __table_args__ = (
        Index('ix_completion_user_date_focus', 'user_id', 'workout_date', 'focus_label'),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    workout_date: date
    focus_label: str
    duration_seconds: int = Field(default=0)
    # Training stimulus of the session: "strength" / "hypertrophy" /
    # "volume" / "conditioning" / "mobility" / "recovery". Stored on
    # completion so the planner can space heavy days from heavy days
    # and avoid back-to-back high-intensity stimulus.
    stimulus: str | None = Field(default=None)
    source_context: str | None = Field(default=None, index=True)
    template_id: str | None = Field(default=None)
    plan_day_id: int | None = Field(default=None, index=True)
    activity_category: str | None = Field(default=None)
    activity_subtype: str | None = Field(default=None)
    activity_intensity: str | None = Field(default=None)
    activity_source: str | None = Field(default=None)
    cardio_style: str | None = Field(default=None)
    distance_miles: float | None = Field(default=None)
    calories_burned: int | None = Field(default=None)
    hr_summary: dict | None = Field(default=None, sa_column=Column(JSON))
    resolved_muscle_fatigue: dict | None = Field(default=None, sa_column=Column(JSON))
    # Post-workout feedback. Used by weekly_review for struggle metrics
    # and by the trainer for context. All optional — pre-feedback
    # completions and silent log paths still work.
    #   feeling: "great" | "good" | "okay" | "rough"
    #   intensity: 1..5 (1 = way too easy, 5 = too hard)
    #   soreness_areas: list of body-part keys ["lower_back", "knees"]
    feeling: str | None = Field(default=None)
    intensity: int | None = Field(default=None)
    soreness_areas: list | None = Field(default=None, sa_column=Column(JSON))
    feedback_notes: str | None = Field(default=None)
    completed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Workouts ──────────────────────────────────────────────────────────────────

class WorkoutSession(SQLModel, table=True):
    __tablename__ = "workout_sessions"
    __table_args__ = (
        Index('ix_session_user_date', 'user_id', 'workout_date'),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    # WorkoutFocus enum not yet defined in enums.py — using str to avoid
    # constraining focus to muscle groups, which is too narrow.
    # Values are free-form labels e.g. "Push", "Pull", "Legs", "Full Body".
    focus: str
    workout_date: date
    source: WorkoutSource = Field(sa_column=Column(SAEnum(WorkoutSource), nullable=False, default=WorkoutSource.GENERATED))
    notes: str | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WorkoutExercise(SQLModel, table=True):
    __tablename__ = "workout_exercises"
    __table_args__ = (UniqueConstraint("session_id", "order_index", name="uq_workout_exercise_order"),)
    id: int | None = Field(default=None, primary_key=True)
    session_id: int = Field(foreign_key="workout_sessions.id", index=True)
    exercise_id: int | None = Field(default=None, foreign_key="exercises.id")
    name: str
    order_index: int
    equipment: EquipmentType = Field(sa_column=Column(SAEnum(EquipmentType), nullable=False))
    exercise_slug_snapshot: str | None = Field(default=None, index=True)
    primary_muscle_snapshot: str | None = Field(default=None)
    secondary_muscles_snapshot: list | None = Field(default=None, sa_column=Column(JSON))
    is_compound_snapshot: bool | None = Field(default=None)
    notes: str | None = Field(default=None)
    target_reps_text: str | None = Field(default=None)  # e.g. "8–12" or "AMRAP"
    rest_seconds: int | None = Field(default=None)


class ExerciseSet(SQLModel, table=True):
    __tablename__ = "exercise_sets"
    __table_args__ = (UniqueConstraint("workout_exercise_id", "set_number", name="uq_exercise_set_number"),)
    id: int | None = Field(default=None, primary_key=True)
    workout_exercise_id: int = Field(foreign_key="workout_exercises.id", index=True)
    set_number: int
    # Rep range targets — use both for ranges (e.g. 8–12) or set both equal for exact targets
    target_reps_min: int | None = Field(default=None)
    target_reps_max: int | None = Field(default=None)
    target_weight_lbs: float | None = Field(default=None)
    set_type: str | None = Field(default=None)          # e.g. "working", "warmup", "dropset", "amrap"
    rpe_target: int | None = Field(default=None)         # 1–10 effort target
    rir_target: float | None = Field(default=None)       # reps-in-reserve target
    # Logged actuals
    actual_reps: int | None = Field(default=None)
    actual_weight_lbs: float | None = Field(default=None)
    rpe: int | None = Field(default=None)                # logged RPE
    # Reps in reserve at the end of the set (0 = failure, 3+ = easy).
    # Captured from the in-workout coach + Switch Day flow. Drives
    # rolling e1RM (rolling_e1rm.py) and the in_workout_review's
    # progression decisions. Stored separately from rpe because RIR
    # is a forward-looking signal (how much was left in the tank)
    # vs RPE which is the user's perceived exertion in the moment.
    actual_rir: float | None = Field(default=None)
    completed: bool = Field(default=False)
    completed_at: datetime | None = Field(default=None)
    duration_seconds: int | None = Field(default=None)
    comfort_rating: int | None = Field(default=None)
    actual_distance: float | None = Field(default=None)
    actual_pace: str | None = Field(default=None)
    heart_rate_avg: int | None = Field(default=None)
    cardio_metrics: dict | None = Field(default=None, sa_column=Column(JSON))


# ─── Meals ────────────────────────────────────────────────────────────────────

class Meal(SQLModel, table=True):
    __tablename__ = "meals"
    __table_args__ = (
        Index('ix_meal_user_date', 'user_id', 'meal_date'),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    meal_date: date
    meal_type: MealType = Field(sa_column=Column(SAEnum(MealType), nullable=False))
    name: str
    source: MealSource = Field(sa_column=Column(SAEnum(MealSource), nullable=False, default=MealSource.LOGGED))
    notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    # When the user actually ate this meal. Separate from created_at so
    # back-logging a breakfast at 2pm still shows "8am" on the timeline.
    # Nullable because existing rows pre-migration won't have it; clients
    # fall back to (meal_date + noon) when NULL.
    consumed_at: datetime | None = Field(default=None, index=True)


class MealItem(SQLModel, table=True):
    __tablename__ = "meal_items"
    id: int | None = Field(default=None, primary_key=True)
    meal_id: int = Field(foreign_key="meals.id", index=True)
    food_name: str              # always present — supports custom foods not in the library
    food_id: int | None = Field(default=None, foreign_key="foods.id")  # optional link to food library
    serving_id: int | None = Field(default=None, foreign_key="food_servings.id")  # which serving size was used
    quantity: float
    unit: str
    serving_grams: float | None = Field(default=None)  # actual grams consumed
    # Snapshotted macros — NEVER recalculated from live food data
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


# ─── Saved Meals ──────────────────────────────────────────────────────────────
#
# A SavedMeal is a user-authored reusable bundle of foods — distinct from a
# Routine (pinned/scheduled recurring meal) and from a Recipe (full
# ingredients + cooking instructions + serving size math). Saved meals let
# the user log the same combo again without retyping it.

class SavedMeal(SQLModel, table=True):
    __tablename__ = "saved_meals"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    notes: str | None = Field(default=None)
    # Snapshotted totals — lets the UI show macros/cals without joining
    # items on every list render. Recomputed on save.
    total_calories: float = Field(default=0.0)
    total_protein_g: float = Field(default=0.0)
    total_carbs_g: float = Field(default=0.0)
    total_fat_g: float = Field(default=0.0)
    # Items bundled inside — same shape as MealItem minus the meal_id.
    # Stored as JSON so a saved-meal row is self-contained (no extra
    # table for items). Shape: [{food_name, food_id, serving_id,
    # quantity, unit, serving_grams, calories, protein_g, carbs_g, fat_g}, ...]
    items: list = Field(default_factory=list, sa_column=Column(JSON))
    times_logged: int = Field(default=0)
    last_logged_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Supplement Stack ─────────────────────────────────────────────────────────
#
# V1 data model split across four tables so we can layer in product label
# parsing later without migrating user stacks. Most V1 users will create
# custom (ingredient-only) entries in UserSupplementStack; the
# SupplementProduct/Ingredient tables seed common options and provide
# evidence/risk metadata.

class SupplementIngredient(SQLModel, table=True):
    __tablename__ = "supplement_ingredients"
    id: int | None = Field(default=None, primary_key=True)
    slug: str = Field(default="", index=True, unique=True)
    name: str = Field(unique=True, index=True)
    category: str                         # "vitamin", "mineral", "performance", "amino_acid", "fatty_acid", "nootropic", "hormone_support", etc.
    default_unit: str = Field(default="mg")
    # "strong" | "moderate" | "limited" | "weak"
    evidence_tier: str = Field(default="limited")
    # "low" | "moderate" | "high"
    risk_tier: str = Field(default="low")
    description: str | None = Field(default=None)
    timing_notes: str | None = Field(default=None)   # e.g. "Take with fat-containing meal"
    safety_notes: str | None = Field(default=None)   # e.g. "Avoid if on blood thinners"


class SupplementProduct(SQLModel, table=True):
    __tablename__ = "supplement_products"
    id: int | None = Field(default=None, primary_key=True)
    brand: str
    name: str
    serving_size: str | None = Field(default=None)   # e.g. "1 scoop", "2 capsules"
    third_party_tested: bool = Field(default=False)
    label_source: str | None = Field(default=None)   # "seeded" | "user_scan" | "ocr"


class SupplementProductIngredient(SQLModel, table=True):
    __tablename__ = "supplement_product_ingredients"
    id: int | None = Field(default=None, primary_key=True)
    product_id: int = Field(foreign_key="supplement_products.id", index=True)
    ingredient_id: int = Field(foreign_key="supplement_ingredients.id", index=True)
    amount: float
    unit: str


class UserSupplementStack(SQLModel, table=True):
    __tablename__ = "user_supplement_stack"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    # Either link to a product, an ingredient, or use custom_name.
    # V1 mostly uses custom_name + ingredient_id — product label parsing
    # comes later.
    supplement_product_id: int | None = Field(default=None, foreign_key="supplement_products.id")
    supplement_ingredient_id: int | None = Field(default=None, foreign_key="supplement_ingredients.id")
    custom_name: str | None = Field(default=None)
    category: str | None = Field(default=None)
    goal: str | None = Field(default=None)                    # free-text: "strength / lean mass"
    dose_amount: float
    dose_unit: str = Field(default="mg")
    frequency: str = Field(default="daily")                    # "daily" | "weekdays" | "pre_workout" | "as_needed"
    timing: str | None = Field(default=None)                   # "morning" | "evening" | "pre_workout" | "with_meal"
    # Optional user-defined group label so supplements can be batched
    # beyond the built-in `timing` buckets. Free-text — e.g. "Stack 1",
    # "Travel pack", "Pre-bed". When set, it overrides `timing` for
    # group rendering + the "take group" action. Bulk-log endpoint reads
    # this to decide which items belong to a tap.
    group_label: str | None = Field(default=None)
    taken_with_food: bool = Field(default=False)
    active: bool = Field(default=True)
    notes: str | None = Field(default=None)
    # Denormalized from ingredient when available — keeps cards
    # informative without a join on every render.
    evidence_tier: str | None = Field(default=None)
    risk_tier: str | None = Field(default=None)
    timing_notes: str | None = Field(default=None)
    safety_notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SupplementLog(SQLModel, table=True):
    __tablename__ = "supplement_logs"
    __table_args__ = (
        Index('ix_supp_log_user_taken', 'user_id', 'taken_at'),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    stack_item_id: int = Field(foreign_key="user_supplement_stack.id", index=True)
    taken_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    dose_amount: float | None = Field(default=None)
    dose_unit: str | None = Field(default=None)
    skipped: bool = Field(default=False)


# ─── Gut health / longevity signals ───────────────────────────────────────────
#
# Two-tier storage:
#   FoodMetadata           — per-food inferred classification (plant, fermented,
#                             omega-3, processing bucket). Keyed by the
#                             normalized food name so it covers both library
#                             foods AND ad-hoc logged items.
#   DailyNutritionMetrics  — per-user-per-day derived aggregates (fiber totals,
#                             plant diversity, fermented servings, scores).
#
# Raw nutrition rows (MealItem / FoodNutrition) are never mutated. Everything
# here is additive and can be regenerated by bumping the classifier version.

class FoodMetadata(SQLModel, table=True):
    """Inferred classification of a food name. Source = deterministic, heuristic,
    ai, or unknown. Invalidated by bumping `classifier_version`."""
    __tablename__ = "food_metadata"
    __table_args__ = (
        UniqueConstraint("normalized_name", "classifier_version", name="uq_food_metadata_name_ver"),
        Index("ix_food_metadata_name", "normalized_name"),
    )
    id: int | None = Field(default=None, primary_key=True)
    normalized_name: str = Field(index=True)
    display_name: str = Field(default="")
    classifier_version: int = Field(default=1, index=True)
    # Plant-food diversity signal. List of coarse plant slugs, e.g. ["blueberry"].
    # Empty list means "no plant foods detected". None (not set) is a different
    # state — see source/confidence.
    likely_plant_foods: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    plant_count_value: int = Field(default=0)
    fermented_flag: bool = Field(default=False)
    omega3_flag: bool = Field(default=False)
    # One of: minimally_processed | processed | ultra_processed | unknown
    processing_bucket: str = Field(default="unknown")
    # 0.0 – 1.0. Anything < 0.55 is effectively "unknown" for downstream use.
    confidence: float = Field(default=0.0)
    # deterministic | heuristic | ai | unknown
    source: str = Field(default="unknown")
    notes: str | None = Field(default=None)
    # Dominant protein source: plant | animal | mixed | none | unknown.
    # Drives the plant-vs-animal protein ratio on the longevity card.
    protein_source: str = Field(default="unknown")
    # Subset of fermented_flag — true only for foods with live probiotic
    # cultures in their consumer form (yogurt, kefir, kimchi, sauerkraut,
    # kombucha, natto). Tempeh + miso excluded because they're usually
    # cooked before consumption.
    probiotic_flag: bool = Field(default=False)
    # Classifier v3 — descriptive tags used for weekly pattern metrics.
    # Not scored directly; feed drill-down facts and the omega-3 signal.
    seafood_flag: bool = Field(default=False)
    fruit_flag: bool = Field(default=False)
    vegetable_flag: bool = Field(default=False)
    alcohol_flag: bool = Field(default=False)
    processed_meat_flag: bool = Field(default=False)
    refined_grain_flag: bool = Field(default=False)
    # v4 — AI-estimated amounts for nutrients USDA doesn't label.
    # Set by an AI enrichment pass (see `ai_classify.estimate_amounts`)
    # for every food regardless of the deterministic keyword pass, so
    # a custom food like "Grandma's chicken soup" with collagen content
    # is no longer lost when its name doesn't match a regex. Per-serving
    # values; the daily aggregator multiplies by servings consumed.
    collagen_g_per_serving: float | None = Field(default=None)
    # Probiotic count in BILLIONS of CFU per serving. CFUs are the
    # bioactive unit for probiotics (1 cup yogurt ≈ 1–10B, kefir ≈
    # 25–50B, label-driven supplement ≈ 1–100B). Stored in billions
    # so typical values are small floats (1, 10, 50) rather than 1e9.
    probiotic_cfu_billions_per_serving: float | None = Field(default=None)
    # Legacy — replaced by CFU count above. Kept so existing rows
    # read without a migration. New rows leave this nil and rely on
    # cfu_billions for aggregation.
    probiotic_servings_per_serving: float | None = Field(default=None)
    # Confidence tier of the AI estimate: "high" / "med" / "low" / "none".
    # UI uses this to grey-out low-confidence numbers.
    amount_confidence: str = Field(default="none")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DailyNutritionMetrics(SQLModel, table=True):
    """Per-user-per-day derived metrics for gut health + longevity signals.
    Computed from MealItem rows using FoodMetadata lookups. Regenerable."""
    __tablename__ = "daily_nutrition_metrics"
    __table_args__ = (
        UniqueConstraint("user_id", "metric_date", name="uq_daily_metrics_user_date"),
        Index("ix_daily_metrics_user_date", "user_id", "metric_date"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    metric_date: date
    metrics_version: int = Field(default=1, index=True)
    classifier_version_used: int = Field(default=1)
    # Raw numbers derived from logged meals:
    calories_total: float = Field(default=0)
    fiber_total_g: float = Field(default=0)
    fiber_per_1000_kcal: float = Field(default=0)
    distinct_plant_foods: int = Field(default=0)
    fermented_servings: float = Field(default=0)
    # Live-culture probiotic subset of fermented servings.
    probiotic_servings: float = Field(default=0)
    omega3_servings: float = Field(default=0)
    # Protein sourced from plant vs animal vs mixed-composite items.
    # Mixed items contribute half to each pool — rough but honest.
    plant_protein_g: float = Field(default=0)
    animal_protein_g: float = Field(default=0)
    # Processing mix (counts of items by bucket):
    processing_counts: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    saturated_fat_g: float = Field(default=0)
    # Derived 0-100 scores — LEGACY, DEPRECATED. Nutrition Score lives in
    # the unified pipeline (nutrition_score.py) via Score API. These columns
    # are kept so existing rows can be read without migration, but new rows
    # no longer populate them.
    gut_support_score: float = Field(default=0)
    food_quality_score: float = Field(default=0)
    longevity_signals_score: float = Field(default=0)
    # v3 — per-item descriptive tag aggregates
    added_sugar_g: float = Field(default=0)
    sodium_mg: float = Field(default=0)
    seafood_servings: float = Field(default=0)
    fruit_servings: float = Field(default=0)
    vegetable_servings: float = Field(default=0)
    alcohol_servings: float = Field(default=0)
    processed_meat_servings: float = Field(default=0)
    refined_grain_servings: float = Field(default=0)
    # v4 — AI-estimated amounts. Sum of `collagen_g_per_serving *
    # servings_consumed` across the day's logged items. Covers foods
    # USDA doesn't label (bone broth, custom recipes, gelatin, etc).
    collagen_g: float = Field(default=0)
    # Daily probiotic dose in BILLIONS of CFU. Summed from each item's
    # per-serving CFU estimate × servings consumed. Makes "did I hit
    # my probiotic target today?" a real number instead of a coarse
    # servings count.
    probiotic_cfu_billions: float = Field(default=0)
    # Max % of daily protein concentrated in a single meal — flags the
    # "all protein at dinner" pattern for muscle-gain users.
    max_meal_protein_pct: float = Field(default=0)
    # Energy availability estimate (kcal per kg FFM). Populated only when
    # activity kcal + FFM are derivable; null-sentinel 0 means unknown.
    energy_availability: float = Field(default=0)
    # Fueling + recovery flags, stored as JSON so the shape can evolve
    # without schema churn. Keys: under_fueling, low_fat, recovery_nutrients,
    # thyroid_support. Each value is one of green / amber / red / not_enough_data.
    recovery_flags: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    # Plant slugs seen today (for weekly rollup dedup):
    plant_slugs: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    # How many items fell into each classification bucket:
    item_count: int = Field(default=0)
    classified_item_count: int = Field(default=0)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Social ──────────────────────────────────────────────────────────────────

class UserSocialProfile(SQLModel, table=True):
    __tablename__ = "user_social_profiles"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    display_name: str | None = Field(default=None)
    # Off until the user explicitly opts in. Gates whether friends see any
    # of this user's training activity in the weekly digest.
    share_activity_enabled: bool = Field(default=False)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Friendship(SQLModel, table=True):
    __tablename__ = "friendships"
    # Canonical pair: user_a_id < user_b_id so each pair has exactly one row.
    # Direction lives in `requested_by` so we can render "X sent you a request".
    __table_args__ = (UniqueConstraint("user_a_id", "user_b_id", name="uq_friendship_pair"),)
    id: int | None = Field(default=None, primary_key=True)
    user_a_id: int = Field(foreign_key="user.id", index=True)
    user_b_id: int = Field(foreign_key="user.id", index=True)
    # pending / accepted / blocked
    status: str = Field(default="pending", index=True)
    requested_by: int = Field(foreign_key="user.id")
    # When status=blocked, this is the user who issued the block.
    blocked_by: int | None = Field(default=None, foreign_key="user.id")
    requested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    accepted_at: datetime | None = Field(default=None)


class UserReport(SQLModel, table=True):
    """A user-reported abuse / safety / spam complaint about another user.

    App Review and basic platform safety require a visible "Report" affordance
    on any social surface. We store reports in their own table (not a flag
    on Friendship) so non-friends can be reported and so a single review
    queue can drive moderation. No auto-action is taken — operators read
    the table and decide.
    """
    __tablename__ = "user_reports"
    id: int | None = Field(default=None, primary_key=True)
    reporter_id: int = Field(foreign_key="user.id", index=True)
    reported_user_id: int = Field(foreign_key="user.id", index=True)
    # spam | harassment | impersonation | inappropriate_content | other
    reason: str = Field(default="other")
    note: str | None = Field(default=None)
    # open | reviewed | dismissed | actioned
    status: str = Field(default="open", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WeeklyDigestCache(SQLModel, table=True):
    __tablename__ = "weekly_digest_cache"
    __table_args__ = (UniqueConstraint("user_id", "week_start", name="uq_weekly_digest_user_week"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    week_start: date = Field(sa_column=Column(Date, nullable=False, index=True))
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    generated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ActivityFeedItem(SQLModel, table=True):
    __tablename__ = "activity_feed"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    event_type: str = Field(default="workout_completed")
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class FeedLike(SQLModel, table=True):
    __tablename__ = "feed_likes"
    __table_args__ = (UniqueConstraint("user_id", "feed_item_id", name="uq_feed_like_user_item"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    feed_item_id: int = Field(foreign_key="activity_feed.id", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Request / Response schemas ───────────────────────────────────────────────

class UserCreate(SQLModel):
    email: str
    username: str
    first_name: str | None = Field(default=None)
    last_name: str | None = Field(default=None)
    # Pydantic-level floor. Router `_validate_password` enforces the full
    # policy (must include a digit) on top of this check.
    password: str = Field(min_length=8)
    accepted_terms: bool = Field(default=False)
    accepted_privacy: bool = Field(default=False)
    accepted_health_disclaimer: bool = Field(default=False)
    accepted_ai_disclaimer: bool = Field(default=False)
    legal_version: str | None = Field(default=None)

class UserRead(SQLModel):
    id: int
    email: str
    username: str
    first_name: str | None = None
    last_name: str | None = None
    is_active: bool
    created_at: datetime
    has_recovery_question: bool = False
    email_verified: bool = False
    legal_accepted: bool = False
    terms_version: str | None = None
    privacy_version: str | None = None
    health_disclaimer_version: str | None = None
    ai_disclaimer_version: str | None = None
    subscription_tier: str = "free"

class LoginRequest(SQLModel):
    email: str
    password: str

class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"

class TokenData(SQLModel):
    user_id: int | None = None

class ProfileUpsert(SQLModel):
    weight_lbs: float
    height_feet: int
    height_inches: int
    # Either `birthdate` or `age` is required — birthdate wins when both
    # are present (router derives age from it so cached age stays fresh
    # as users age over multi-year windows).
    age: int | None = None
    birthdate: date | None = None
    gender: Gender

class GoalUpsert(SQLModel):
    goal_type: GoalType
    goal_track: str | None = None
    pace: GoalPace
    target_weight_lbs: float | None = None
    timeline_weeks: int | None = None

class PreferencesUpsert(SQLModel):
    days_per_week: int
    workout_duration_minutes: int | None = None
    core_frequency_per_week: int | None = None
    equipment: list[str]       # item names e.g. "Dumbbells", "Pull-up bar"
    equipment_settings: dict | None = None
    foods_available: list[str]

class OnboardingSync(SQLModel):
    profile: ProfileUpsert
    goal: GoalUpsert
    preferences: PreferencesUpsert


class DayStateUpsert(SQLModel):
    # All fields optional — `None` means "leave existing value untouched" so
    # callers can patch a single field without re-asserting the others.
    # Pass an explicit `{}` to clear meal_checks; pass `""` to clear skipped_focus
    # via the `clear_skipped_focus` flag below.
    skipped_focus: str | None = None
    clear_skipped_focus: bool = False
    skip_reason: str | None = None
    clear_skip_reason: bool = False
    meal_checks: dict | None = None
    nutrition_plan: dict | None = None
    macro_overrides: dict | None = None


class WeeklyCheckInCreate(SQLModel):
    checkin_date: date
    weight_lbs: float
    update_profile_weight: bool = True
    waist_in: float | None = None
    chest_in: float | None = None
    hips_in: float | None = None
    bicep_in: float | None = None
    thigh_in: float | None = None
    calf_in: float | None = None
    body_fat_pct: float | None = None
    bp_systolic: int | None = None
    bp_diastolic: int | None = None
    energy: int = 3
    sleep: int = 3
    adherence: int = 3
    notes: str | None = None

class SetCreate(SQLModel):
    set_number: int
    target_reps_min: int | None = None   # use both for a range e.g. 8–12
    target_reps_max: int | None = None
    target_weight_lbs: float | None = None
    set_type: str | None = None          # e.g. "working", "warmup", "dropset", "amrap"
    rpe_target: int | None = None
    rir_target: float | None = None
    duration_seconds: int | None = None  # for timed sets (plank, stretch)
    comfort_rating: int | None = None    # 1-5 comfort for stretch/mobility
    actual_distance: float | None = None
    actual_pace: str | None = None
    heart_rate_avg: int | None = None
    cardio_metrics: dict | None = None

class ExerciseCreate(SQLModel):
    exercise_id: int | None = None
    name: str
    order_index: int
    equipment: EquipmentType
    notes: str | None = None
    target_reps_text: str | None = None  # e.g. "8–12" or "AMRAP"
    rest_seconds: int | None = None
    sets: list[SetCreate]

class WorkoutSessionCreate(SQLModel):
    name: str
    focus: str  # free-form focus label; see WorkoutSession.focus
    workout_date: date
    source: WorkoutSource = WorkoutSource.CUSTOM
    notes: str | None = None
    exercises: list[ExerciseCreate]

class SetLog(SQLModel):
    actual_reps: int
    actual_weight_lbs: float | None = None
    rpe: int | None = None

class MealItemCreate(SQLModel):
    food_name: str
    food_id: int | None = None         # optional link to food library row
    serving_id: int | None = None      # optional link to specific serving size
    quantity: float
    unit: str
    serving_grams: float | None = None
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float

class MealCreate(SQLModel):
    meal_date: date
    meal_type: MealType
    name: str
    source: MealSource = MealSource.LOGGED
    notes: str | None = None
    items: list[MealItemCreate]
    # ISO timestamp for when the user actually ate this meal. Optional —
    # server defaults to now() when omitted. Allows back-logging.
    consumed_at: datetime | None = None


# ─── Food schemas ────────────────────────────────────────────────────────────

class FoodServingRead(SQLModel):
    id: int
    label: str
    grams: float
    is_default: bool
    calories: float
    protein: float
    carbs: float
    fat: float

class FoodRead(SQLModel):
    """Composite read model returned by food search."""
    id: int
    name: str
    category: str
    source: str
    brand: str | None = None
    is_verified: bool = False
    # Canonical nutrition (from FoodNutrition)
    calories: float = 0
    protein: float = 0
    carbs: float = 0
    fat: float = 0
    fiber: float | None = None
    reference_unit: str = "100g"
    # Available servings
    servings: list[FoodServingRead] = []

class FoodCreate(SQLModel):
    """Create a user-custom or AI food."""
    name: str
    category: FoodCategory = FoodCategory.PROTEINS
    brand: str | None = None
    # Nutrition per stated unit
    unit: str = "100g"
    serving_grams: float = 100
    calories: float = 0
    protein: float = 0
    carbs: float = 0
    fat: float = 0


# ─── User equipment profile schemas ──────────────────────────────────────────

class UserEquipmentProfileCreate(SQLModel):
    """Create / update one piece of user equipment."""
    category: str = "cardio"
    equipment_type: str
    display_name: str = ""
    brand: str | None = None
    model_name: str | None = None
    location: str = "gym"
    # List of capability tokens (see CAP_* constants in cardio.py):
    # "time" | "distance" | "speed" | "incline" | "watts" | "rpm" |
    # "resistance" | "heart_rate" | "calories" | "pace" | "stroke_rate"
    capabilities: list[str] = []
    notes: str | None = None


class UserEquipmentProfileRead(SQLModel):
    """Read schema for a registered equipment profile."""
    id: int
    user_id: int
    category: str
    equipment_type: str
    display_name: str
    brand: str | None
    model_name: str | None
    location: str
    capabilities: list[str]
    notes: str | None
    created_at: datetime
