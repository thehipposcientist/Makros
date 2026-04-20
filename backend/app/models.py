from sqlmodel import SQLModel, Field, Column
from sqlalchemy import Enum as SAEnum, JSON, UniqueConstraint, Index, text
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


# ─── User profile / stats ─────────────────────────────────────────────────────

class UserProfile(SQLModel, table=True):
    __tablename__ = "user_profiles"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    weight_lbs: float
    height_feet: int
    height_inches: int
    age: int
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
    equipment: list = Field(default_factory=list, sa_column=Column(JSON))
    foods_available: list = Field(default_factory=list, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserCoachingState(SQLModel, table=True):
    __tablename__ = "user_coaching_state"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    calorie_adjustment: int = Field(default=0)    # daily calories delta from baseline
    volume_adjustment_pct: int = Field(default=0) # training volume delta percentage
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserDayState(SQLModel, table=True):
    __tablename__ = "user_day_state"
    __table_args__ = (UniqueConstraint("user_id", "day_key", name="uq_user_day_state"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    day_key: date = Field(index=True)
    skipped_focus: str | None = Field(default=None)
    meal_checks: dict = Field(default_factory=dict, sa_column=Column(JSON))
    nutrition_plan: dict | None = Field(default=None, sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WeeklyCheckIn(SQLModel, table=True):
    __tablename__ = "weekly_checkins"
    __table_args__ = (UniqueConstraint("user_id", "checkin_date", name="uq_weekly_checkin"),)
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    checkin_date: date = Field(index=True)
    weight_lbs: float
    waist_in: float | None = Field(default=None)
    energy: int = Field(default=3)
    sleep: int = Field(default=3)
    adherence: int = Field(default=3)
    notes: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CoachMemory(SQLModel, table=True):
    __tablename__ = "coach_memory"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    event_type: str = Field(index=True)  # e.g. checkin_adjustment, guardrail
    summary: str
    details: dict | None = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


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
    activity_category: str | None = Field(default=None)
    activity_subtype: str | None = Field(default=None)
    activity_intensity: str | None = Field(default=None)
    activity_source: str | None = Field(default=None)
    cardio_style: str | None = Field(default=None)
    resolved_muscle_fatigue: dict | None = Field(default=None, sa_column=Column(JSON))
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
    completed: bool = Field(default=False)
    completed_at: datetime | None = Field(default=None)


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


# ─── Request / Response schemas ───────────────────────────────────────────────

class UserCreate(SQLModel):
    email: str
    username: str
    # Pydantic-level floor. Router `_validate_password` enforces the full
    # policy (must include a digit) on top of this check.
    password: str = Field(min_length=8)

class UserRead(SQLModel):
    id: int
    email: str
    username: str
    is_active: bool
    created_at: datetime

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
    age: int
    gender: Gender

class GoalUpsert(SQLModel):
    goal_type: GoalType
    pace: GoalPace
    target_weight_lbs: float | None = None
    timeline_weeks: int | None = None

class PreferencesUpsert(SQLModel):
    days_per_week: int
    equipment: list[str]       # item names e.g. "Dumbbells", "Pull-up bar"
    foods_available: list[str]

class OnboardingSync(SQLModel):
    profile: ProfileUpsert
    goal: GoalUpsert
    preferences: PreferencesUpsert


class DayStateUpsert(SQLModel):
    skipped_focus: str | None = None
    meal_checks: dict = Field(default_factory=dict)
    nutrition_plan: dict | None = None


class WeeklyCheckInCreate(SQLModel):
    checkin_date: date
    weight_lbs: float
    waist_in: float | None = None
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
