from sqlmodel import SQLModel, Field, Column
from sqlalchemy import Enum as SAEnum, JSON, UniqueConstraint, Index, text, Date, Text
from datetime import datetime, date, timezone
from typing import Any

from app.enums import (
    SubscriptionTier, GoalType, GoalPace, Gender, MealType,
    EquipmentType, MuscleGroup, WorkoutSource, MealSource, FoodCategory,
    FoodSource, ExerciseType, EquipmentRole,
)

DateType = date


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
    subscription_tier: str = Field(default=SubscriptionTier.FREE.value, index=True)
    subscription_status: str | None = Field(default=None, index=True)
    subscription_source: str | None = Field(default=None, index=True)
    subscription_product_id: str | None = Field(default=None)
    subscription_entitlement_id: str | None = Field(default=None)
    subscription_store: str | None = Field(default=None)
    subscription_environment: str | None = Field(default=None)
    subscription_expires_at: datetime | None = Field(default=None, index=True)
    trial_started_at: datetime | None = Field(default=None)
    trial_ends_at: datetime | None = Field(default=None, index=True)
    revenuecat_original_app_user_id: str | None = Field(default=None, index=True)
    revenuecat_original_transaction_id: str | None = Field(default=None, index=True)
    apple_sub: str | None = Field(default=None, unique=True, index=True)
    google_sub: str | None = Field(default=None, unique=True, index=True)
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


class LegalAcceptanceEvent(SQLModel, table=True):
    __tablename__ = "legal_acceptance_events"
    __table_args__ = (
        Index("ix_legal_acceptance_user_accepted", "user_id", "accepted_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    legal_version: str = Field(index=True)
    source: str = Field(index=True)
    accepted_terms: bool = Field(default=True)
    accepted_privacy: bool = Field(default=True)
    accepted_health_disclaimer: bool = Field(default=True)
    accepted_ai_disclaimer: bool = Field(default=True)
    client_ip: str | None = Field(default=None)
    user_agent: str | None = Field(default=None)
    accepted_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


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


class WatchDevice(SQLModel, table=True):
    __tablename__ = "watch_devices"
    __table_args__ = (
        UniqueConstraint("user_id", "device_id", name="uq_watch_device_user_device"),
        Index("ix_watch_device_user_active", "user_id", "revoked_at", "expires_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    device_id: str = Field(index=True)
    token_hash: str = Field(unique=True, index=True)
    issued_token_version: int = Field(default=0)
    issued_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    expires_at: datetime = Field(index=True)
    revoked_at: datetime | None = Field(default=None, index=True)
    last_seen_at: datetime | None = Field(default=None)
    last_app_version: str | None = Field(default=None)
    last_seen_ip: str | None = Field(default=None)


class WatchCommandEvent(SQLModel, table=True):
    __tablename__ = "watch_command_events"
    __table_args__ = (
        UniqueConstraint("user_id", "command_id", name="uq_watch_command_user_command"),
        Index("ix_watch_command_user_created", "user_id", "created_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    watch_device_id: int | None = Field(default=None, foreign_key="watch_devices.id", index=True)
    command_id: str = Field(index=True)
    command: str = Field(index=True)
    payload: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="received", index=True)
    result_json: dict[str, Any] | None = Field(default=None, sa_column=Column(JSON))
    error: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    applied_at: datetime | None = Field(default=None)


class AIUsageEvent(SQLModel, table=True):
    """Best-effort server-side accounting for OpenAI calls.

    This is not invoice-grade billing. It gives us enough signal to spot
    runaway routes, per-user scan spikes, and model-routing mistakes.
    """
    __tablename__ = "ai_usage_events"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int | None = Field(default=None, foreign_key="user.id", index=True)
    route: str = Field(index=True)
    budget_bucket: str | None = Field(default=None, index=True)
    model: str = Field(index=True)
    success: bool = Field(default=True, index=True)
    image_count: int = Field(default=0)
    prompt_tokens: int | None = Field(default=None)
    completion_tokens: int | None = Field(default=None)
    total_tokens: int | None = Field(default=None)
    estimated_cost_usd: float | None = Field(default=None)
    latency_ms: int | None = Field(default=None)
    error_type: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class BillingEvent(SQLModel, table=True):
    __tablename__ = "billing_events"
    __table_args__ = (
        UniqueConstraint("provider", "event_id", name="uq_billing_event_provider_event"),
        Index("ix_billing_event_user_processed", "user_id", "processed_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    provider: str = Field(index=True)
    event_id: str = Field(index=True)
    event_type: str = Field(index=True)
    app_user_id: str | None = Field(default=None, index=True)
    user_id: int | None = Field(default=None, foreign_key="user.id", index=True)
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    processed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


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
    # Display-unit preferences. Storage of the values themselves stays canonical
    # (lbs, miles, ft+in). Null = defaults (imperial: lbs / mi / in).
    weight_unit: str | None = Field(default=None)    # 'lbs' | 'kg'
    distance_unit: str | None = Field(default=None)  # 'mi'  | 'km'
    height_unit: str | None = Field(default=None)    # 'in'  | 'cm'
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
    # Baselines snapshotted when the goal row is created. Persisted so
    # "fat lost since goal start" survives later weight/scan logging gaps —
    # without these, computing progress relies on the earliest available
    # entry, which silently shifts if the user back-logs a weigh-in.
    start_weight_lbs: float | None = Field(default=None)
    start_body_fat_pct: float | None = Field(default=None)
    start_scan_id: int | None = Field(default=None, foreign_key="body_scans.id")


class UserPreferences(SQLModel, table=True):
    __tablename__ = "user_preferences"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    days_per_week: int = Field(default=3)
    workout_duration_minutes: int | None = Field(default=None)
    core_frequency_per_week: int | None = Field(default=None)
    preferred_split: str | None = Field(default=None)
    # Lifestyle activity outside of planned training. Drives a TDEE
    # multiplier nudge in calorie_calculator.step_2b. Without this, the
    # TDEE chain treats every user with the same training schedule
    # identically — a desk worker and a construction worker who both
    # lift 4×/wk would get the same maintenance calories, which is
    # wrong by ~300–500 kcal/day. Values: "sedentary" | "light" |
    # "moderate" | "active" | "very_active". None means "unknown / not
    # asked yet" and the modifier is skipped (preserves legacy TDEE).
    lifestyle_activity: str | None = Field(default=None)
    equipment: list = Field(default_factory=list, sa_column=Column(JSON))
    equipment_settings: dict | None = Field(default=None, sa_column=Column(JSON))
    training_day_pattern: list | None = Field(default=None, sa_column=Column(JSON))
    experience_level: str | None = Field(default=None)
    strength_baselines: dict | None = Field(default=None, sa_column=Column(JSON))
    cardio_baseline: dict | None = Field(default=None, sa_column=Column(JSON))
    foods_available: list = Field(default_factory=list, sa_column=Column(JSON))
    # Legacy free-text injury list (one flattened string per injury). Kept
    # for backward compatibility and as the substring-match fallback for
    # the planner. New writes should populate injuries_structured below.
    injuries: list = Field(default_factory=list, sa_column=Column(JSON))
    # Severity-aware structured records (one dict per active/recovering
    # injury). Each item: {bodyPart, status, severity, muscleGroups,
    # estimatedRecoveryDate}. The planner prefers this over the legacy
    # strings; both can coexist (planner unions them — see
    # planner._injury_blocked_patterns_combined).
    injuries_structured: list = Field(default_factory=list, sa_column=Column(JSON))
    # Manual mode (Pro-only): when on, the planner stops auto-generating
    # workouts/meals; the user assembles their own week from saved
    # templates (workout) or just logs freely against daily targets (meal).
    # See backend/app/routers/profile.py::set_manual_mode and the
    # auto_renew gate in week_manager.auto_renew_week.
    workout_manual_mode: bool = Field(default=False)
    meal_manual_mode: bool = Field(default=False)
    # In-flight data imports from competitor apps. Each entry is a dict
    # with shape:
    #   { source: str,           # "myfitnesspal" | "cronometer" | "hevy"
    #                            # | "strong" | "strava"
    #     requested_at: str,     # ISO date — when the user tapped
    #                            # "Open <app>" during onboarding
    #     notified_at: str|null, # ISO date — last reminder notification
    #     completed_at: str|null,# ISO date — when the actual import finished
    #     dismissed_at: str|null }# ISO date — user dismissed the banner
    # The list is patched as a whole on every PATCH /profile/preferences
    # write (frontend manages the entry lifecycle). Banners and reminder
    # notifications read this list to know what to surface.
    pending_imports: list = Field(default_factory=list, sa_column=Column(JSON))
    # Optional Health Insights profile facts. Defaults keep existing users
    # in the "unknown / not opted in" state until they deliberately provide
    # more context.
    kidney_stone_history: str = Field(default="unknown")  # true | false | unknown
    stone_type: str | None = Field(default=None)          # calcium_oxalate | uric_acid | struvite | cystine | unknown
    stone_history_source: str | None = Field(default=None)  # self_reported | clinician_confirmed | unknown
    stone_history_updated_at: datetime | None = Field(default=None)
    reproductive_health_opt_in: bool = Field(default=False)
    cycle_tracking_enabled: bool = Field(default=False)
    trying_to_conceive: bool | None = Field(default=None)
    pregnancy_status: str | None = Field(default=None)
    known_pcos: bool | None = Field(default=None)
    known_endometriosis: bool | None = Field(default=None)
    gestational_diabetes_history: bool | None = Field(default=None)
    glp1_support: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    sun_exposure_preferences: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    custom_macros: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserCoachingState(SQLModel, table=True):
    __tablename__ = "user_coaching_state"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    calorie_adjustment: int = Field(default=0)    # daily calories delta from baseline
    volume_adjustment_pct: int = Field(default=0) # training volume delta percentage
    muscle_volume_adjustments: dict | None = Field(default=None, sa_column=Column(JSON))
    intensity_adjustment_pct: int = Field(default=0)
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
    nutrition_log_status: str | None = Field(default=None, index=True)
    nutrition_log_status_source: str | None = Field(default=None)
    nutrition_log_status_updated_at: datetime | None = Field(default=None)
    macro_overrides: dict | None = Field(default=None, sa_column=Column(JSON))
    pain_present: bool | None = Field(default=None)
    pain_body_part: str | None = Field(default=None)
    pain_side: str | None = Field(default=None)
    pain_severity_0_10: int | None = Field(default=None)
    soreness_body_part: str | None = Field(default=None)
    soreness_severity_0_10: int | None = Field(default=None)
    pain_note: str | None = Field(default=None)
    onset_context: str | None = Field(default=None)  # workout | daily_activity | unknown
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
    basal_energy_kcal: float | None = Field(default=None)
    workout_minutes: int | None = Field(default=None)
    cardio_minutes: int | None = Field(default=None)         # cardio-classified workout minutes only
    zone2_minutes: int | None = Field(default=None)          # Z2 minutes from cardio-classified workouts only
    # Cardiovascular
    resting_hr: float | None = Field(default=None)
    hrv_ms: float | None = Field(default=None)
    vo2_max: float | None = Field(default=None)
    respiratory_rate: float | None = Field(default=None)
    oxygen_saturation: float | None = Field(default=None)
    wrist_temperature_c: float | None = Field(default=None)
    sleep_breathing_disturbances: float | None = Field(default=None)
    sleep_breathing_disturbances_elevated: bool | None = Field(default=None)
    # Body
    weight_lbs: float | None = Field(default=None)
    # Optional readiness composite (computed phone-side)
    readiness_score: int | None = Field(default=None)
    source: str = Field(default="apple_health")
    # Optional per-provider/per-field provenance. Example:
    # {"providers": ["apple_health", "oura"], "fields": {"hrv_ms": "oura"}}
    source_details: dict | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DailyHealthSnapshotUpsert(SQLModel):
    """Client → server payload for the daily HealthKit snapshot. All
    fields optional so a partial-permissions user can still patch."""
    snapshot_date: date
    steps: int | None = None
    active_energy_kcal: float | None = None
    basal_energy_kcal: float | None = None
    workout_minutes: int | None = None
    cardio_minutes: int | None = None
    zone2_minutes: int | None = None
    resting_hr: float | None = None
    hrv_ms: float | None = None
    vo2_max: float | None = None
    respiratory_rate: float | None = None
    oxygen_saturation: float | None = None
    wrist_temperature_c: float | None = None
    sleep_breathing_disturbances: float | None = None
    sleep_breathing_disturbances_elevated: bool | None = None
    weight_lbs: float | None = None
    readiness_score: int | None = None
    source: str | None = None
    source_details: dict | None = None


class DailyStressSummary(SQLModel, table=True):
    """One client-computed daily stress summary per user.

    The timeline card models stress across the day from logged meals,
    workouts/activity, and optional heart-rate samples. Persisting the
    daily average lets the UI compare today against the user's own
    baseline without treating stress as a planner mutation.
    """
    __tablename__ = "daily_stress_summaries"
    __table_args__ = (
        UniqueConstraint("user_id", "summary_date", name="uq_daily_stress_summary"),
        Index("ix_daily_stress_user_date", "user_id", "summary_date"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    summary_date: date = Field(index=True)
    avg_stress: float = Field(default=0)
    max_stress: float | None = Field(default=None)
    latest_stress: float | None = Field(default=None)
    sample_count: int = Field(default=0)
    source_count: int = Field(default=0)
    source: str = Field(default="thallo_estimate")
    source_details: dict | None = Field(default=None, sa_column=Column(JSON))
    computed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class DailyStressSummaryUpsert(SQLModel):
    summary_date: date
    avg_stress: float
    max_stress: float | None = None
    latest_stress: float | None = None
    sample_count: int | None = None
    source_count: int | None = None
    source: str | None = None
    source_details: dict | None = None
    computed_at: datetime | None = None


class DailyLifestyleLog(SQLModel, table=True):
    """Optional private daily context entered by the user.

    These rows explain recovery, sleep, digestion, and nutrition patterns.
    They are never required for core app behavior and are not shared across
    social surfaces.
    """
    __tablename__ = "daily_lifestyle_logs"
    __table_args__ = (
        UniqueConstraint("user_id", "local_date", name="uq_daily_lifestyle_log_user_date"),
        Index("ix_daily_lifestyle_logs_user_date", "user_id", "local_date"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    local_date: date = Field(index=True)
    alcohol_level: str | None = Field(default=None, index=True)
    alcohol_drinks: float | None = Field(default=None)
    alcohol_timing: str | None = Field(default=None)
    cannabis_level: str | None = Field(default=None, index=True)
    cannabis_timing: str | None = Field(default=None)
    bowel_movement_count: int | None = Field(default=None)
    bowel_consistency: str | None = Field(default=None)
    stress_level: str | None = Field(default=None, index=True)
    illness_state: str | None = Field(default=None, index=True)
    caffeine_mg: float | None = Field(default=None)
    caffeine_timing: str | None = Field(default=None)
    late_caffeine: bool | None = Field(default=None)
    appetite: str | None = Field(default=None, index=True)
    notes: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    source: str = Field(default="manual", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class HealthLabResult(SQLModel, table=True):
    """Optional user-entered/imported lab result for cardiometabolic context.

    Insight cards may use these as stronger screening context, but never as
    diagnoses. Rows are sparse and additive so frontend collection can arrive
    later without changing existing health snapshot behavior.
    """
    __tablename__ = "health_lab_results"
    __table_args__ = (
        Index("ix_health_lab_user_type_collected", "user_id", "lab_type", "collected_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    lab_type: str = Field(index=True)  # a1c | fasting_glucose | ldl | hdl | triglycerides | ...
    value: float
    unit: str
    collected_at: datetime = Field(index=True)
    source: str = Field(default="manual")  # manual | scan | imported | clinician | unknown
    reference_range_low: float | None = Field(default=None)
    reference_range_high: float | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CycleLog(SQLModel, table=True):
    """Opt-in reproductive-health cycle entry.

    This table is deliberately separate from generic health snapshots so cycle
    insights can stay gated by explicit preferences and can be deleted/exported
    independently later.
    """
    __tablename__ = "cycle_logs"
    __table_args__ = (
        Index("ix_cycle_logs_user_period_start", "user_id", "period_start_date"),
        Index("ix_cycle_logs_user_log_date", "user_id", "log_date"),
        UniqueConstraint("user_id", "log_date", name="uq_cycle_logs_user_log_date"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    log_date: date | None = Field(default=None, index=True)
    period_start_date: date = Field(index=True)
    period_end_date: date | None = Field(default=None)
    phase: str | None = Field(default=None)
    cycle_day: int | None = Field(default=None)
    cycle_length: int | None = Field(default=None)
    symptoms: list = Field(default_factory=list, sa_column=Column(JSON))
    flow_level: str | None = Field(default=None)
    cramps: str | None = Field(default=None)
    energy: str | None = Field(default=None)
    training_action: str | None = Field(default=None)
    ovulation_estimate_source: str = Field(default="unknown")  # manual | predicted | test | unknown
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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


class FitnessScoreSnapshot(SQLModel, table=True):
    """One persisted Thallo-score reading per user per day.

    `/ai/fitness/composite-score` upserts today's row on every call;
    the headline `total` it returns is the average of these rows over
    the last 28 days (or however many exist for a newer user). The
    per-pillar columns are stored for future per-pillar smoothing —
    today the endpoint only averages `total`."""
    __tablename__ = "fitness_score_snapshots"
    __table_args__ = (
        UniqueConstraint("user_id", "snapshot_date", name="uq_fitness_score_snapshot"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    snapshot_date: date = Field(sa_column=Column(Date, nullable=False))
    total: float
    strength: float
    cardio: float
    consistency: float
    recovery: float
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
    nutrition_log_status: str = Field(default="unknown", index=True)
    nutrition_log_confidence: float = Field(default=0)
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
    protein_adherence_pct: float | None = Field(default=None)  # % of days >=95% of target
    days_logged: int = Field(default=0)
    adherence_pct: float | None = Field(default=None)          # % of days within +/-5% of kcal target
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
    kind: str = Field(index=True)                      # "full" | "workout" | "nutrition" | "nutrition_remaining"
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
    generation_source: str = Field(default="initial")  # initial | adapt | swap | manual | backfill | injury_repair
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
    confidence: str | None = Field(default=None)          # high / medium / low
    photo_quality: str | None = Field(default=None)       # good / usable / poor
    quality_flags: list = Field(default_factory=list, sa_column=Column(JSON))
    needs_retake: bool = Field(default=False)
    method: str | None = Field(default=None)
    visual_estimate_pct: float | None = Field(default=None)
    measurement_estimate_pct: float | None = Field(default=None)
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
    logged_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
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
    # free-exercise-db identifier (e.g. "Barbell_Bench_Press_-_Medium_Grip").
    # Resolved at seed time by name normalization. Drives the in-app form
    # demo card — two real photo frames cycled on the FormVideoModal and
    # used as the thumbnail on ExerciseVideoCard. Null = no match in the
    # public dataset; client falls back to the YouTube thumbnail.
    demo_exercise_db_id: str | None = Field(default=None)
    # "reps" (default) | "time" | "distance" | "calories". Lets the planner
    # and the client pick the right rep-target string ("30-45s", "20-30 yds")
    # instead of defaulting to goal-based rep counts for holds / carries.
    default_tracking_mode: str = Field(default="reps")
    # Guided-flow ordering tag for stretches / yoga / foam-roll poses.
    # Values: "warm" | "standing" | "floor" | "cool" | "breath" | "foam_roll" | None.
    # Drives generate_yoga_day ordering and the GuidedFlowView swap filter.
    flow_category: str | None = Field(default=None)
    # Fine-grained muscle emphasis — display-layer only, orthogonal to
    # `primary_muscle` + `secondary_muscles` (which drive the 12-bucket
    # fatigue model). Values are from a fixed taxonomy in
    # `services/workout/emphasis_inference.py::EMPHASIS_TAGS` (e.g.
    # "front_delt", "side_delt", "rear_delt", "lats", "upper_back",
    # "traps", "upper_chest", "lower_chest", "brachialis", etc.). The
    # planner does NOT read this field — it's only surfaced in library
    # detail UI + filter chips. Errors here are cosmetic.
    emphasis: list = Field(default_factory=list, sa_column=Column(JSON))


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


class FoodSubmission(SQLModel, table=True):
    """User-submitted food awaiting review before it can become global.

    Submitted foods are immediately saved as private `Food` rows so the user
    can reuse them, while this row preserves the review/audit payload needed
    to promote the item later without leaking unreviewed data into the shared
    catalog.
    """
    __tablename__ = "food_submissions"
    __table_args__ = (
        Index("ix_food_submissions_status_created", "status", "created_at"),
        Index("ix_food_submissions_user_status", "user_id", "status"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    food_id: int | None = Field(default=None, foreign_key="foods.id", index=True)
    linked_food_id: int | None = Field(default=None, foreign_key="foods.id", index=True)
    status: str = Field(default="pending", index=True)  # pending, approved, rejected
    source_context: str = Field(default="manual")       # manual, barcode, label_photo, search_gap
    name: str
    normalized_name: str = Field(default="", index=True)
    brand: str | None = Field(default=None)
    barcode: str | None = Field(default=None, index=True)
    serving_label: str = Field(default="1 serving")
    serving_grams: float | None = Field(default=None)
    calories: float = Field(default=0)
    protein_g: float = Field(default=0)
    carbs_g: float = Field(default=0)
    fat_g: float = Field(default=0)
    fiber_g: float | None = Field(default=None)
    sugar_g: float | None = Field(default=None)
    added_sugar_g: float | None = Field(default=None)
    sodium_mg: float | None = Field(default=None)
    micronutrients: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    aliases: list[str] | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    front_image_url: str | None = Field(default=None)
    nutrition_label_image_url: str | None = Field(default=None)
    raw_payload: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    review_note: str | None = Field(default=None)
    reviewed_by_user_id: int | None = Field(default=None, foreign_key="user.id")
    reviewed_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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


# ─── User-created exercise library ────────────────────────────────────────────

class UserCustomExercise(SQLModel, table=True):
    """User-scoped exercise rows created manually or from AI search/photo scans.

    These are intentionally separate from the canonical seeded `Exercise`
    catalog. A scan can make a lift available to one user without polluting the
    global planner library for everyone else.
    """
    __tablename__ = "user_custom_exercises"
    __table_args__ = (
        UniqueConstraint("user_id", "normalized_name", name="uq_user_custom_exercise_name"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    normalized_name: str = Field(index=True)
    primary_muscle: str = Field(default="full_body")
    secondary_muscles: list = Field(default_factory=list, sa_column=Column(JSON))
    equipment: str = Field(default="")
    equipment_slugs: list = Field(default_factory=list, sa_column=Column(JSON))
    equipment_bucket: str = Field(default="")
    movement_pattern: str | None = Field(default=None)
    exercise_type: str = Field(default="strength")
    default_tracking_mode: str = Field(default="reps")
    is_compound: bool | None = Field(default=None)
    image_url: str | None = Field(default=None)
    video_id: str | None = Field(default=None)
    demo_exercise_db_id: str | None = Field(default=None)
    sets: int = Field(default=3)
    reps: str = Field(default="8-12")
    rest_seconds: int = Field(default=60)
    description: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    form_cues: list = Field(default_factory=list, sa_column=Column(JSON))
    aliases: list = Field(default_factory=list, sa_column=Column(JSON))
    programming_tags: list = Field(default_factory=list, sa_column=Column(JSON))
    source: str = Field(default="manual")
    plan_eligible: bool = Field(default=False)
    ai_confidence: str | None = Field(default=None)
    validation_status: str = Field(default="needs_review")
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
    "stationary_bike": None,
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
    # Per-subtype structured detail captured by LogActivityModal: sauna
    # temperature, cold plunge water temp + immersion depth, breathwork
    # protocol, climbing grade, yoga style, swim pool length + stroke,
    # cycling watts + elevation, etc. Shape varies by activity_category +
    # activity_subtype — see src/types/index.ts ManualActivityDetails.
    activity_details: dict | None = Field(default=None, sa_column=Column(JSON))
    # GPS route — list of {lat, lon, t_ms, acc_m, alt_m, v_acc_m} samples captured by
    # cardioGpsTracker (iPhone) or HKWorkoutRouteBuilder (watch). Drives
    # the post-workout map summary + the live polyline during the
    # session. Null for indoor cardio + lifting; up to ~3600 entries
    # per hour at 1Hz, ~30 KB serialized — well under JSONB limits.
    route_coords: list | None = Field(default=None, sa_column=Column(JSON))
    hr_summary: dict | None = Field(default=None, sa_column=Column(JSON))
    resolved_muscle_fatigue: dict | None = Field(default=None, sa_column=Column(JSON))
    started_at: datetime | None = Field(default=None)
    ended_at: datetime | None = Field(default=None)
    external_source_id: str | None = Field(default=None, index=True)
    # Client-supplied idempotency token. Native double-taps/retries should
    # send the same value so the completion and structured WorkoutSession rows
    # update in place instead of creating duplicates.
    idempotency_key: str | None = Field(default=None, index=True)
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
    training_score: int | None = Field(default=None)
    training_rating: str | None = Field(default=None)
    training_pillars: dict | None = Field(default=None, sa_column=Column(JSON))
    training_pillar_breakdown: list | None = Field(default=None, sa_column=Column(JSON))
    # Edwards' TRIMP (Training Impulse) — cardio session load = sum of
    # zone-minutes × zone-weight. Null for non-cardio sessions (strength,
    # mobility) and for cardio sessions that have no `hr_summary.zoneMinutes`
    # to compute from. Aggregatable across a week the way strength volume is.
    # See `activity_energy.compute_cardio_load` for the formula + rationale.
    cardio_load: float | None = Field(default=None)
    # Import provenance — null for native completions. Set by the
    # Strong / Strava / Hevy importers. Imported workouts feed fatigue
    # and progression identically to native ones.
    import_source: str | None = Field(default=None, index=True)
    import_batch_id: int | None = Field(default=None, foreign_key="import_batches.id")
    # Idempotency hash, partial-unique on (user_id, import_hash).
    import_hash: str | None = Field(default=None)
    completed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Sun exposure estimation ─────────────────────────────────────────────────

class SunExposureSegment(SQLModel, table=True):
    """Derived, privacy-bounded estimate for a daylight/activity window.

    Raw GPS is deliberately absent. If a workout route is used, the service
    stores only a coarse geohash/context bucket plus coefficients.
    """
    __tablename__ = "sun_exposure_segments"
    __table_args__ = (
        Index("ix_sun_exposure_user_start", "user_id", "start_time"),
        Index("ix_sun_exposure_user_activity", "user_id", "activity_id"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    start_time: datetime = Field(index=True)
    end_time: datetime
    duration_minutes: float
    coarse_location_hash: str | None = Field(default=None, index=True)
    activity_id: int | None = Field(default=None, foreign_key="workout_completions.id", index=True)
    uv_index_average: float = Field(default=0.0)
    uv_index_max: float = Field(default=0.0)
    light_intensity_lux: float | None = Field(default=None)
    local_start_minute: int | None = Field(default=None)
    local_end_minute: int | None = Field(default=None)
    timezone_offset_minutes: int | None = Field(default=None)
    daylight: bool = Field(default=True)
    outdoor_confidence: float = Field(default=0.0)
    area_context: dict = Field(default_factory=dict, sa_column=Column(JSON))
    effective_uv_minutes: float = Field(default=0.0)
    open_sky_equivalent_minutes: float = Field(default=0.0)
    confidence: str = Field(default="low")
    source: str = Field(default="coarse_location", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class SunExposureCorrection(SQLModel, table=True):
    __tablename__ = "sun_exposure_corrections"
    __table_args__ = (
        Index("ix_sun_exposure_correction_context", "user_id", "context_key"),
        Index("ix_sun_exposure_correction_segment", "user_id", "segment_id"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    segment_id: int | None = Field(default=None, foreign_key="sun_exposure_segments.id", index=True)
    correction_type: str = Field(index=True)
    context_key: str | None = Field(default=None, index=True)
    area_type: str | None = Field(default=None, index=True)
    adjusted_sky_exposure_coefficient: float | None = Field(default=None)
    adjusted_outdoor_confidence: float | None = Field(default=None)
    notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


# ─── Context-aware health insights ───────────────────────────────────────────

class UserInsightPreferences(SQLModel, table=True):
    __tablename__ = "user_insight_preferences"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    enable_move_insights: bool = Field(default=False)
    enable_recovery_insights: bool = Field(default=False)
    enable_environment_insights: bool = Field(default=False)
    enable_social_insights: bool = Field(default=False)
    enable_pattern_insights: bool = Field(default=False)
    use_coarse_location: bool = Field(default=False)
    use_workout_routes: bool = Field(default=False)
    use_weather_environment_data: bool = Field(default=False)
    use_social_context: bool = Field(default=False)
    allow_notifications: bool = Field(default=False)
    allow_occasional_correction_prompts: bool = Field(default=False)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ContextInsight(SQLModel, table=True):
    __tablename__ = "context_insights"
    __table_args__ = (
        UniqueConstraint("user_id", "insight_key", name="uq_context_insight_user_key"),
        Index("ix_context_insight_user_created", "user_id", "created_at"),
        Index("ix_context_insight_user_category", "user_id", "category"),
    )
    id: int | None = Field(default=None, primary_key=True)
    insight_key: str = Field(index=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    type: str = Field(index=True)
    category: str = Field(index=True)
    title: str
    summary: str = Field(sa_column=Column(Text, nullable=False))
    recommended_action: str = Field(sa_column=Column(Text, nullable=False))
    confidence: str = Field(default="low", index=True)
    data_sources: list = Field(default_factory=list, sa_column=Column(JSON))
    explanation: str = Field(sa_column=Column(Text, nullable=False))
    safety_note: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    valid_until: datetime | None = Field(default=None, index=True)
    dismissed_at: datetime | None = Field(default=None, index=True)


class ContextSegment(SQLModel, table=True):
    __tablename__ = "context_segments"
    __table_args__ = (
        Index("ix_context_segment_user_start", "user_id", "start_time"),
        Index("ix_context_segment_user_place", "user_id", "place_category"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    start_time: datetime = Field(index=True)
    end_time: datetime
    coarse_location_hash: str | None = Field(default=None, index=True)
    place_category: str | None = Field(default=None, index=True)
    activity_type: str | None = Field(default=None, index=True)
    workout_id: int | None = Field(default=None, foreign_key="workout_completions.id", index=True)
    daylight: bool | None = Field(default=None)
    uv_index: float | None = Field(default=None)
    air_quality_index: int | None = Field(default=None)
    temperature: float | None = Field(default=None)
    humidity: float | None = Field(default=None)
    elevation_gain_meters: float | None = Field(default=None)
    steps: int | None = Field(default=None)
    heart_rate_avg: float | None = Field(default=None)
    social_context: str | None = Field(default=None)
    confidence: str = Field(default="low")
    source: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class DailyFeatureSet(SQLModel, table=True):
    __tablename__ = "daily_feature_sets"
    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_daily_feature_set_user_date"),
        Index("ix_daily_feature_set_user_date", "user_id", "date"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    date: DateType = Field(sa_column=Column(Date, nullable=False, index=True))
    steps: int = Field(default=0)
    active_minutes: int = Field(default=0)
    strength_workout_count: int = Field(default=0)
    weight_bearing_minutes: int = Field(default=0)
    mobility_minutes: int = Field(default=0)
    elevation_gain_meters: float = Field(default=0.0)
    outdoor_daylight_minutes: int = Field(default=0)
    open_sky_equivalent_minutes: int = Field(default=0)
    high_uv_minutes: int = Field(default=0)
    sleep_duration_minutes: int | None = Field(default=None)
    sleep_consistency_score: float | None = Field(default=None)
    resting_heart_rate: float | None = Field(default=None)
    hrv: float | None = Field(default=None)
    workout_load: float | None = Field(default=None)
    recovery_score: float | None = Field(default=None)
    social_activity_count: int | None = Field(default=None)
    active_commute_minutes: int | None = Field(default=None)
    sedentary_block_minutes: int | None = Field(default=None)
    source: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
    external_source_id: str | None = Field(default=None, index=True)
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
    movement_pattern_snapshot: str | None = Field(default=None)
    impact_level: str | None = Field(default=None)       # low | moderate | high | unknown
    load_type: str | None = Field(default=None)          # bodyweight | free_weight | machine | cardio | mixed
    intensity_estimate: float | None = Field(default=None)
    novelty_flag: bool | None = Field(default=None)
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
    # Free-form per-set notes ("form felt sloppy", "left shoulder tight").
    # Surfaced inline on the set card in ActiveWorkoutScreen.
    notes: str | None = Field(default=None)


# ─── Meals ────────────────────────────────────────────────────────────────────

class Meal(SQLModel, table=True):
    __tablename__ = "meals"
    __table_args__ = (
        Index('ix_meal_user_date', 'user_id', 'meal_date'),
        # Partial unique index on import_hash — only enforces uniqueness
        # when the column is non-null (native logs have null and can
        # repeat freely). See database._ensure_meal_import_columns.
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    meal_date: date
    meal_type: MealType = Field(sa_column=Column(SAEnum(MealType), nullable=False))
    name: str
    source: MealSource = Field(sa_column=Column(SAEnum(MealSource), nullable=False, default=MealSource.LOGGED))
    notes: str | None = Field(default=None)
    # Import provenance — null for native logs. The `MealSource` enum
    # stays {generated, logged}; this column is the orthogonal "where
    # did the logged data come from" answer. Imported meals behave
    # identically to native logs in scoring/recovery/social — they're
    # just visually distinguishable in the diary UI.
    import_source: str | None = Field(default=None, index=True)
    import_batch_id: int | None = Field(default=None, foreign_key="import_batches.id")
    # sha256(user_id|source|external_date|meal_type|food_name|calories|protein)
    # Idempotency: re-uploading the same export doesn't duplicate. The
    # backend migration adds a partial unique index on (user_id, import_hash)
    # so native rows with null hash can repeat freely.
    import_hash: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    version: int = Field(default=1)
    # When the user actually ate this meal. Separate from created_at so
    # back-logging a breakfast at 2pm still shows "8am" on the timeline.
    # Nullable because existing rows pre-migration won't have it; clients
    # fall back to (meal_date + noon) when NULL.
    consumed_at: datetime | None = Field(default=None, index=True)
    # Optional meal-level image. Both fields nullable — the meal UI must
    # render fine with no image at all. `image_source` is a free-form
    # provenance tag ("user_photo", "recipe", "pexels", "product", "category") used
    # by the client resolver to pick a fallback and by future cleanup
    # jobs to tell user-uploaded photos apart from auto-resolved ones.
    image_url: str | None = Field(default=None)
    image_source: str | None = Field(default=None)
    # Nullable provenance link for meals logged from a SavedMeal/Favorite.
    # Logged rows remain snapshots; the link is for provenance and delete
    # detach cleanup, not retroactive template propagation.
    saved_meal_id: int | None = Field(default=None, foreign_key="saved_meals.id", index=True)
    # Original client row key for plan/manual-day rows. `meal_type`
    # intentionally stays coarse for analytics, but this preserves exact
    # row identity when users reorder, duplicate, or have 5+ meals in a day.
    client_meal_key: str | None = Field(default=None, index=True)
    # ── Template/routine provenance + idempotency ───────────────────────
    # A logged meal is ALWAYS its own snapshot. These fields only record
    # where the snapshot came from (traceability) and guarantee one row per
    # user action — they never cause retroactive template propagation.
    #
    # source_type: "manual" | "favorite" | "routine" | "plan" — orthogonal
    # to MealSource (generated/logged). Nullable for pre-migration rows.
    source_type: str | None = Field(default=None, index=True)
    # Routine-occurrence linkage. A partial unique index on
    # (user_id, source_routine_id, routine_occurrence_key) guarantees one
    # logged row per routine occurrence (see database._ensure_meal_idempotency_columns).
    source_routine_id: int | None = Field(default=None, index=True)
    routine_occurrence_key: str | None = Field(default=None)
    # Client-supplied idempotency token. Partial unique index on
    # (user_id, idempotency_key) collapses retried / double-tapped creates
    # to a single row. Native rows with NULL repeat freely.
    idempotency_key: str | None = Field(default=None)


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
    # Optional per-serving nutrient snapshots from external imports or
    # scan/search payloads. These preserve user-logged historical data
    # even when the row cannot be linked to a canonical FoodNutrition row.
    saturated_fat_g: float | None = Field(default=None)
    # Trans fat is tracked separately because dietary guidance treats it as a
    # "keep close to zero" target. Null = unknown source, 0 = source said 0.
    trans_fat_g: float | None = Field(default=None)
    cholesterol_mg: float | None = Field(default=None)
    sodium_mg: float | None = Field(default=None)
    fiber_g: float | None = Field(default=None)
    sugar_g: float | None = Field(default=None)
    added_sugar_g: float | None = Field(default=None)
    caffeine_mg: float | None = Field(default=None)
    # Alcohol stored in grams (canonical). Standard-drinks display is derived.
    alcohol_g: float | None = Field(default=None)
    potassium_mg: float | None = Field(default=None)
    calcium_mg: float | None = Field(default=None)
    magnesium_mg: float | None = Field(default=None)
    iron_mg: float | None = Field(default=None)
    phosphorus_mg: float | None = Field(default=None)
    iodine_mcg: float | None = Field(default=None)
    choline_mg: float | None = Field(default=None)
    vitamin_d_mcg: float | None = Field(default=None)
    vitamin_b12_mcg: float | None = Field(default=None)
    vitamin_k_mcg: float | None = Field(default=None)
    vitamin_e_mg: float | None = Field(default=None)
    folate_mcg: float | None = Field(default=None)
    zinc_mg: float | None = Field(default=None)
    # Total omega-3 in grams (legacy field, preserved for backward compat).
    # When subtypes (ALA/EPA/DHA) are known, they're stored in mg below.
    omega_3_g: float | None = Field(default=None)
    omega_3_ala_mg: float | None = Field(default=None)
    omega_3_epa_mg: float | None = Field(default=None)
    omega_3_dha_mg: float | None = Field(default=None)
    omega_6_mg: float | None = Field(default=None)


# ─── Integration credentials ────────────────────────────────────────────────
#
# Per-user OAuth tokens for third-party services (Strava, Oura, WHOOP,
# Garmin, ...). Each row is one (user, provider) pair. Refresh tokens
# are bearer credentials — treat them like passwords. Never log them.
#
# The pipeline pattern:
#   1. User taps "Connect Strava" → backend returns authorize URL with
#      a CSRF state nonce.
#   2. Strava redirects to our /callback → backend exchanges code,
#      writes a row here with access + refresh + expires_at.
#   3. Periodic sync reads the row, refreshes if expired, calls the
#      provider API, persists results into the existing target tables
#      (WorkoutCompletion etc.) the same way file imports do.

class IntegrationCredential(SQLModel, table=True):
    __tablename__ = "integration_credentials"
    __table_args__ = (
        UniqueConstraint("user_id", "provider", name="uq_integration_user_provider"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    # "strava" | "oura" | "whoop" | "garmin" | "fitbit"
    provider: str = Field(index=True)
    # Stored via app.field_encryption.encrypt_text/decrypt_text. Legacy
    # plaintext rows remain readable and are re-encrypted on token refresh.
    access_token: str | None = Field(default=None)
    refresh_token: str | None = Field(default=None)
    expires_at: datetime | None = Field(default=None)
    # Provider's user identifier (e.g. Strava's athlete.id). Useful for
    # webhook routing and debugging multi-account ambiguity.
    external_user_id: str | None = Field(default=None)
    # JSON blob — provider-specific extras (Strava's `scope`, Oura's
    # device list, etc.). Schema-on-read so each provider can carry
    # whatever it needs without new columns per integration.
    extras: dict | None = Field(default=None, sa_column=Column(JSON))
    # "active" | "revoked" | "expired"
    status: str = Field(default="active", index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_synced_at: datetime | None = Field(default=None)


# ─── Data imports ────────────────────────────────────────────────────────────
#
# Tracks one upload from an external app (MFP / Strong / Strava / etc.).
# `data_type` discriminates which downstream tables got rows:
#   "meals"    — populated Meal + MealItem rows
#   "workouts" — populated WorkoutCompletion + ExerciseSet rows
#
# Per-row idempotency lives on the target tables (`Meal.import_hash`,
# `WorkoutCompletion.import_hash`) — re-uploading the same export
# doesn't duplicate rows; it just updates this batch's counters.
#
# Rollback path: `DELETE /imports/{batch_id}` removes all rows where
# `import_batch_id == batch_id` and marks the batch `status='rolled_back'`.

class ImportBatch(SQLModel, table=True):
    __tablename__ = "import_batches"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    # "myfitnesspal" | "cronometer" | "hevy" | "strong" | "fitnotes" | "strava" | "csv"
    source: str = Field(index=True)
    # "meals" | "workouts"
    data_type: str = Field(default="meals")
    # Original filename, for UI display only. May be null for OAuth-based
    # sources (Strava) that don't upload a file.
    filename: str | None = Field(default=None)
    # "processing" | "complete" | "failed" | "rolled_back"
    status: str = Field(default="processing", index=True)
    # Tallies — surfaced in the import-status UI.
    total_rows: int = Field(default=0)
    matched_rows: int = Field(default=0)    # row mapped to a Thallo Food/Exercise with high confidence
    ai_matched_rows: int = Field(default=0) # AI fallback was used
    fallback_rows: int = Field(default=0)   # imported with parsed macros but no Food link
    skipped_rows: int = Field(default=0)    # deliberately ignored (totals, blanks)
    error_rows: int = Field(default=0)      # parse errors surfaced to the user for review
    # Errors list: [{row_index, message}, ...]. Surfaced in the review UI.
    errors: list = Field(default_factory=list, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: datetime | None = Field(default=None)


# ─── Saved Meals ──────────────────────────────────────────────────────────────
#
# A SavedMeal is a user-authored reusable bundle of foods — distinct from a
# Routine (pinned/scheduled recurring meal) and from a Recipe (full
# ingredients + cooking instructions + serving size math). Saved meals let
# the user log the same combo again without retyping it.

class SavedMeal(SQLModel, table=True):
    __tablename__ = "saved_meals"
    __table_args__ = (
        UniqueConstraint("user_id", "source_meal_id", name="uq_saved_meals_user_source_meal"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    source_meal_id: int | None = Field(default=None, index=True)
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
    # Optional thumbnail for the favorites carousel. Same convention as
    # Meal.image_url: nullable, fallback handled client-side via the
    # food-image resolver (category icon → placeholder).
    image_url: str | None = Field(default=None)
    image_source: str | None = Field(default=None)
    # Optional share/import metadata. A saved meal is private until
    # share_code is minted; imports are copied into the recipient's
    # library and keep only attribution + original code provenance.
    share_code: str | None = Field(default=None, index=True, unique=True)
    times_imported: int = Field(default=0)
    source_share_code: str | None = Field(default=None)
    source_owner_username: str | None = Field(default=None)
    # Client-side idempotency token for "Save as Favorite". A retried POST
    # carrying the same key collapses to the existing row via the partial
    # unique index `uq_saved_meals_user_idempotency_key`. Older rows leave
    # this null and can repeat freely; only present-keyed writes dedupe.
    idempotency_key: str | None = Field(default=None)


# ─── Meal Routines ────────────────────────────────────────────────────────────
#
# A MealRoutine is a recurring scheduled meal *template* — the durable,
# server-owned successor to the old AsyncStorage-only "mealRoutines" list.
# It is NEVER itself a logged meal. A routine occurrence for a date only
# becomes a Meal row when the user logs it, edits that day, or marks it
# complete (see routers/meal_routines.log_routine_occurrence).
#
# Editing a routine updates THIS row (and its JSON items) in place — it
# never duplicates the routine and never mutates already-logged Meal rows.
# Items use the same JSON shape as SavedMeal.items so a routine is
# self-contained (snapshot copied into meal_log_items at log time).

class MealRoutine(SQLModel, table=True):
    __tablename__ = "meal_routines"
    __table_args__ = (
        Index("ix_meal_routines_user_order", "user_id", "display_order", "created_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    notes: str | None = Field(default=None)
    # Coarse meal type the routine logs under. Nullable → resolver picks by time.
    meal_type: MealType | None = Field(
        default=None, sa_column=Column(SAEnum(MealType), nullable=True)
    )
    # Schedule. days_of_week: list[int], 0=Mon..6=Sun. Empty == every day.
    days_of_week: list = Field(default_factory=list, sa_column=Column(JSON))
    default_time: str | None = Field(default=None)   # "HH:MM" local clock time
    start_date: date | None = Field(default=None)
    end_date: date | None = Field(default=None)
    active: bool = Field(default=True, index=True)
    # Optional provenance: the SavedMeal this routine was created from.
    source_template_id: int | None = Field(default=None, index=True)
    # Client idempotency token for create. (user_id, idempotency_key) is unique
    # (partial index) so a retried / double-submitted create dedupes instead of
    # inserting a duplicate routine.
    idempotency_key: str | None = Field(default=None, index=True)
    # Snapshotted totals + items (same JSON item shape as SavedMeal.items).
    total_calories: float = Field(default=0.0)
    total_protein_g: float = Field(default=0.0)
    total_carbs_g: float = Field(default=0.0)
    total_fat_g: float = Field(default=0.0)
    items: list = Field(default_factory=list, sa_column=Column(JSON))
    display_order: int = Field(default=0, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# A per-date override for a single routine occurrence the user has NOT
# logged yet (a logged occurrence lives as a Meal row instead). Lets a user
# skip or edit one day without touching the base routine. Unique per
# (user, routine, date) so editing the same day twice updates in place.

class RoutineOccurrenceException(SQLModel, table=True):
    __tablename__ = "routine_occurrence_exceptions"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "routine_id", "occurrence_date",
            name="uq_routine_occurrence_exception",
        ),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    routine_id: int = Field(index=True)
    occurrence_date: date
    occurrence_key: str | None = Field(default=None)
    override_time: str | None = Field(default=None)
    skipped: bool = Field(default=False)
    # Edited name + items JSON for an un-logged one-day edit.
    edited_payload: dict | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Workout Templates ───────────────────────────────────────────────────────
#
# A WorkoutTemplate is a user-authored, reusable single-day workout the user
# can launch from the "Saved templates" section of the home screen. The full
# WorkoutDay payload is snapshotted in workout_json so a template row is
# self-contained and portable across users on import.
#
# Sharing: when the user generates a share code, share_code is set to a
# 6-char ambiguity-stripped uppercase string (unique across the table).
# Recipients call /workouts/templates/shared/{code}/import which COPIES the
# template into a fresh row on their own user_id. Deleting the original or
# revoking the code never affects already-imported copies.
#
# client_id is a frontend-assigned UUID. The mobile cache is keyed by uuid
# so we keep it as the public identifier for API paths; the int PK is
# server-internal. UNIQUE (user_id, client_id) guarantees idempotent upsert.

class WorkoutTemplate(SQLModel, table=True):
    __tablename__ = "workout_templates"
    __table_args__ = (
        UniqueConstraint("user_id", "client_id", name="uq_workout_template_user_client"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    client_id: str = Field(default="", index=True)
    name: str
    notes: str | None = Field(default=None)
    workout_json: dict = Field(default_factory=dict, sa_column=Column(JSON))
    share_code: str | None = Field(default=None, index=True, unique=True)
    times_imported: int = Field(default=0)
    source_share_code: str | None = Field(default=None)
    # Attribution — captured at import time so revoking the share code
    # later doesn't strip credit from already-imported copies. Username
    # snapshot is intentional (not a FK) so we don't have to join on
    # every read and so deleted-user fallout stays scoped.
    source_owner_username: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Workout Template Bundle ─────────────────────────────────────────────────
#
# A bundle is a named collection of share codes — the multi-template share
# layer on top of WorkoutTemplate.share_code. Bundle codes are 8 chars (vs
# the 6-char per-template code) so URL/path routing can disambiguate by
# length without an extra prefix.
#
# Items hold *snapshots* of the shareCode at bundle creation time. We do
# not FK into workout_templates: the owner can revoke an underlying
# template's share_code or delete it, and the bundle should degrade to
# "this item is no longer available" rather than crash. The receiver-side
# import path resolves each item by share code at import time.

class WorkoutTemplateBundle(SQLModel, table=True):
    __tablename__ = "workout_template_bundles"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str = Field(default="")
    share_code: str = Field(default="", index=True, unique=True)
    times_imported: int = Field(default=0)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WorkoutTemplateBundleItem(SQLModel, table=True):
    __tablename__ = "workout_template_bundle_items"
    __table_args__ = (
        UniqueConstraint("bundle_id", "share_code", name="uq_bundle_item_share_code"),
    )
    id: int | None = Field(default=None, primary_key=True)
    bundle_id: int = Field(foreign_key="workout_template_bundles.id", index=True)
    # Snapshot of the per-template share code at bundle-creation time.
    # NOT an FK to WorkoutTemplate — see the bundle docstring for the
    # reasoning. Resolution happens at preview/import time.
    share_code: str
    position: int = Field(default=0)


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
    common_uses: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    deficiency_risks: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    excess_risks: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    food_sources: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))


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
    description: str | None = Field(default=None)
    effectiveness_confidence: str | None = Field(default=None)  # "high" | "medium" | "low"
    # Denormalized from ingredient when available — keeps cards
    # informative without a join on every render.
    evidence_tier: str | None = Field(default=None)
    risk_tier: str | None = Field(default=None)
    timing_notes: str | None = Field(default=None)
    safety_notes: str | None = Field(default=None)
    common_uses: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    deficiency_risks: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    excess_risks: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    food_sources: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    source_terms: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    # Structured Supplement Facts panel parsed from a label scan —
    # {"serving_size": {count, unit}, "nutrients": [{key, nutrient, amount,
    # unit, percent_dv}], "parse_source": ...}. Credited toward micronutrient
    # coverage via supplement_facts.credited_micros_from_content.
    nutrient_content: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
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
    name: str | None = Field(default=None)
    normalized_name: str | None = Field(default=None, index=True)
    dose_amount: float | None = Field(default=None)
    dose_unit: str | None = Field(default=None)
    timing_context: str = Field(default="unknown")  # morning | pre_workout | post_workout | evening | bedtime | unknown
    source: str = Field(default="manual")           # manual | imported | inferred
    confidence: float | None = Field(default=None)
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
    # Set only during live cold-miss classification, never by startup or
    # deploy backfills. Per-serving values; the daily aggregator multiplies
    # by servings consumed.
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
    # Prebiotic fiber per serving (grams). Fermentable fibers (inulin,
    # FOS, GOS, resistant starch) that feed the gut microbiome. USDA
    # doesn't expose this; values come from a curated lookup table for
    # high-confidence foods (chicory, garlic, onion, etc.) plus live AI
    # estimation for unknown foods. Aggregated daily as
    # `prebiotic_g_per_serving × servings_consumed`.
    prebiotic_g_per_serving: float | None = Field(default=None)
    # Confidence tier of the AI estimate: "high" / "med" / "low" / "none".
    # UI uses this to grey-out low-confidence numbers.
    amount_confidence: str = Field(default="none")
    # Structured tags used by Health Insights. These are populated at live
    # classification time and consumed as facts; insight cards must not
    # re-scan food names to infer them.
    insight_tags: list | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    insight_tags_source: str = Field(default="none")
    insight_tags_confidence: float = Field(default=0.0)
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
    caffeine_mg: float = Field(default=0)
    potassium_mg: float = Field(default=0)
    calcium_mg: float = Field(default=0)
    magnesium_mg: float = Field(default=0)
    iron_mg: float = Field(default=0)
    vitamin_d_mcg: float = Field(default=0)
    vitamin_b12_mcg: float = Field(default=0)
    folate_mcg: float = Field(default=0)
    zinc_mg: float = Field(default=0)
    omega_3_g: float = Field(default=0)
    micronutrient_item_count: int = Field(default=0)
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
    # Daily prebiotic fiber (grams). Sum of `prebiotic_g_per_serving ×
    # servings consumed` across the day's items. Tracks fermentable
    # fibers that feed the gut microbiome — the food side of the
    # pre/probiotic axis. Distinct from `fiber_total_g` (which counts
    # all fiber, including non-fermentable cellulose).
    prebiotic_g: float = Field(default=0)
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
    # Per-day counts for enriched Health Insight tags, e.g.
    # {"red_meat": 1, "caffeine": 2}. Built from FoodMetadata, not from
    # insight-engine food-name scanning.
    insight_tag_counts: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
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
    avatar_url: str | None = Field(default=None)
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
    __table_args__ = (
        Index("ix_activity_feed_user_created", "user_id", "created_at"),
    )
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


class FeedComment(SQLModel, table=True):
    __tablename__ = "feed_comments"
    __table_args__ = (
        Index("ix_feed_comments_item_created", "feed_item_id", "created_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    feed_item_id: int = Field(foreign_key="activity_feed.id", index=True)
    body: str = Field(sa_column=Column(Text, nullable=False))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


class SocialNotification(SQLModel, table=True):
    __tablename__ = "social_notifications"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "actor_user_id",
            "notification_type",
            "subject_type",
            "subject_id",
            name="uq_social_notification_actor_subject",
        ),
        Index("ix_social_notifications_user_created", "user_id", "created_at"),
        Index("ix_social_notifications_user_read", "user_id", "read_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    actor_user_id: int = Field(foreign_key="user.id", index=True)
    # friend_request | friend_accept | feed_like
    notification_type: str = Field(index=True)
    # friendship | feed_item
    subject_type: str = Field(index=True)
    subject_id: int = Field(index=True)
    payload: dict = Field(default_factory=dict, sa_column=Column(JSON))
    read_at: datetime | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)


# ─── Trainer / client relationships ─────────────────────────────────────────

class TrainerProfile(SQLModel, table=True):
    __tablename__ = "trainer_profiles"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    display_name: str | None = Field(default=None)
    business_name: str | None = Field(default=None)
    bio: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    website_url: str | None = Field(default=None)
    contact_email: str | None = Field(default=None)
    is_accepting_clients: bool = Field(default=True, index=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class TrainerClientRelationship(SQLModel, table=True):
    __tablename__ = "trainer_client_relationships"
    __table_args__ = (
        UniqueConstraint("trainer_user_id", "client_user_id", name="uq_trainer_client_pair"),
        Index("ix_trainer_client_trainer_status", "trainer_user_id", "status"),
        Index("ix_trainer_client_client_status", "client_user_id", "status"),
    )
    id: int | None = Field(default=None, primary_key=True)
    trainer_user_id: int = Field(foreign_key="user.id", index=True)
    client_user_id: int = Field(foreign_key="user.id", index=True)
    # pending | active | declined | revoked
    status: str = Field(default="pending", index=True)
    requested_by_id: int = Field(foreign_key="user.id", index=True)
    requested_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    accepted_at: datetime | None = Field(default=None)
    revoked_at: datetime | None = Field(default=None)
    invite_message: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    share_workouts: bool = Field(default=True)
    share_nutrition: bool = Field(default=False)
    share_body_metrics: bool = Field(default=False)
    share_recovery: bool = Field(default=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class TrainerClientNote(SQLModel, table=True):
    __tablename__ = "trainer_client_notes"
    __table_args__ = (
        Index("ix_trainer_client_notes_relationship_created", "relationship_id", "created_at"),
    )
    id: int | None = Field(default=None, primary_key=True)
    relationship_id: int = Field(foreign_key="trainer_client_relationships.id", index=True)
    trainer_user_id: int = Field(foreign_key="user.id", index=True)
    client_user_id: int = Field(foreign_key="user.id", index=True)
    author_user_id: int = Field(foreign_key="user.id", index=True)
    body: str = Field(sa_column=Column(Text, nullable=False))
    visible_to_client: bool = Field(default=False)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc), index=True)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
    subscription_status: str = "free"
    subscription_source: str | None = None
    subscription_product_id: str | None = None
    subscription_entitlement_id: str | None = None
    subscription_store: str | None = None
    subscription_environment: str | None = None
    subscription_expires_at: datetime | None = None
    trial_started_at: datetime | None = None
    trial_ends_at: datetime | None = None
    revenuecat_app_user_id: str | None = None

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
    # Display-unit preferences. Optional so older clients keep working;
    # null is treated as default (imperial: lbs / mi / in).
    weight_unit: str | None = None     # 'lbs' | 'kg'
    distance_unit: str | None = None   # 'mi'  | 'km'
    height_unit: str | None = None     # 'in'  | 'cm'

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
    preferred_split: str | None = None
    # Lifestyle activity outside training. Drives the TDEE step_2b
    # nudge — see calorie_calculator. Optional; older clients that
    # don't send this field leave the stored value untouched (see the
    # onboarding-sync upsert which only overwrites when present).
    lifestyle_activity: str | None = None
    equipment: list[str]       # item names e.g. "Dumbbells", "Pull-up bar"
    equipment_settings: dict | None = None
    training_day_pattern: list[int] | None = None
    experience_level: str | None = None
    strength_baselines: dict | None = None
    cardio_baseline: dict | None = None
    foods_available: list[str]
    injuries: list[str] = Field(default_factory=list)
    # Optional severity-aware structured payload. Each item:
    # {bodyPart, status, severity, muscleGroups[], estimatedRecoveryDate?}.
    # Older clients that only know about the legacy string field can
    # omit this and the backend keeps the existing behavior.
    injuries_structured: list[dict] = Field(default_factory=list)
    # Optional because older clients do not send these through the
    # onboarding/profile-sync route. The router preserves existing values
    # when omitted and only allows Pro users to turn manual mode on.
    workout_manual_mode: bool | None = None
    meal_manual_mode: bool | None = None
    # Optional in-flight import state. Each item:
    # {source, requested_at, notified_at?, completed_at?, dismissed_at?}.
    # Older clients omit this; backend leaves any previously-stored list
    # untouched in that case (see /onboarding-sync upsert logic).
    pending_imports: list[dict] = Field(default_factory=list)
    kidney_stone_history: str | None = None
    stone_type: str | None = None
    stone_history_source: str | None = None
    reproductive_health_opt_in: bool | None = None
    cycle_tracking_enabled: bool | None = None
    trying_to_conceive: bool | None = None
    pregnancy_status: str | None = None
    known_pcos: bool | None = None
    known_endometriosis: bool | None = None
    gestational_diabetes_history: bool | None = None
    glp1_support: dict | None = None
    sun_exposure_preferences: dict | None = None
    custom_macros: dict | None = None

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
    nutrition_log_status: str | None = None
    nutrition_log_status_source: str | None = None
    clear_nutrition_log_status: bool = False
    macro_overrides: dict | None = None
    pain_present: bool | None = None
    pain_body_part: str | None = None
    pain_side: str | None = None
    pain_severity_0_10: int | None = None
    soreness_body_part: str | None = None
    soreness_severity_0_10: int | None = None
    pain_note: str | None = None
    onset_context: str | None = None


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
    movement_pattern: str | None = None
    impact_level: str | None = None
    load_type: str | None = None
    intensity_estimate: float | None = None
    novelty_flag: bool | None = None
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
    notes: str | None = None

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
    source: str | None = None
    fdc_id: str | None = None
    external_id: str | None = None
    barcode: str | None = None
    brand: str | None = None
    serving: str | None = None
    fiber: float | None = None
    sugar: float | None = None
    sodium_mg: float | None = None
    micronutrients: dict | None = None
    saturated_fat_g: float | None = None
    cholesterol_mg: float | None = None
    fiber_g: float | None = None
    sugar_g: float | None = None
    added_sugar_g: float | None = None
    caffeine_mg: float | None = None
    potassium_mg: float | None = None
    calcium_mg: float | None = None
    magnesium_mg: float | None = None
    iron_mg: float | None = None
    vitamin_d_mcg: float | None = None
    vitamin_b12_mcg: float | None = None
    folate_mcg: float | None = None
    zinc_mg: float | None = None
    omega_3_g: float | None = None

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
    image_url: str | None = None
    image_source: str | None = None
    saved_meal_id: int | None = None
    # Where the snapshot came from: "manual" | "favorite" | "plan". Routine
    # logs go through the routine endpoint (which also sets source_routine_id).
    source_type: str | None = None
    # Client idempotency token — a retried/double-tapped create collapses to
    # one row via the (user_id, idempotency_key) partial unique index.
    idempotency_key: str | None = None


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
    external_id: str | None = None
    brand: str | None = None
    is_verified: bool = False
    # Canonical nutrition (from FoodNutrition)
    calories: float = 0
    protein: float = 0
    carbs: float = 0
    fat: float = 0
    fiber: float | None = None
    sugar: float | None = None
    added_sugar_g: float | None = None
    sodium_mg: float | None = None
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

class UserCustomExerciseCreate(SQLModel):
    """Create / update a user-owned custom exercise."""
    name: str
    primary_muscle: str = "full_body"
    secondary_muscles: list[str] = Field(default_factory=list)
    equipment: str = ""
    equipment_slugs: list[str] = Field(default_factory=list)
    equipment_bucket: str | None = None
    movement_pattern: str | None = None
    exercise_type: str | None = "strength"
    default_tracking_mode: str | None = "reps"
    is_compound: bool | None = None
    image_url: str | None = None
    video_id: str | None = None
    demo_exercise_db_id: str | None = None
    sets: int = 3
    reps: str = "8-12"
    rest_seconds: int = 60
    description: str | None = None
    form_cues: list[str] = Field(default_factory=list)
    aliases: list[str] = Field(default_factory=list)
    programming_tags: list[str] = Field(default_factory=list)
    source: str = "manual"
    plan_eligible: bool | None = None
    ai_confidence: str | None = None
    validation_status: str | None = None


class UserCustomExerciseRead(SQLModel):
    id: int
    user_id: int
    name: str
    normalized_name: str
    primary_muscle: str
    secondary_muscles: list[str]
    equipment: str
    equipment_slugs: list[str]
    equipment_bucket: str
    movement_pattern: str | None
    exercise_type: str
    default_tracking_mode: str
    is_compound: bool | None
    image_url: str | None
    video_id: str | None
    demo_exercise_db_id: str | None
    sets: int
    reps: str
    rest_seconds: int
    description: str | None
    form_cues: list[str]
    aliases: list[str]
    programming_tags: list[str]
    source: str
    plan_eligible: bool
    ai_confidence: str | None
    validation_status: str
    created_at: datetime
    updated_at: datetime


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
