from sqlmodel import SQLModel, Field, Column
from sqlalchemy import Enum as SAEnum, JSON, UniqueConstraint
from datetime import datetime, date, timezone

from app.enums import (
    GoalType, GoalPace, Gender, MealType,
    EquipmentType, MuscleGroup, WorkoutSource, MealSource, FoodCategory,
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
    # Only one active goal per user should exist at a time.
    # Enforce at the application layer: deactivate all existing goals before
    # inserting a new one. user_id is indexed for efficient active-goal queries.
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


# ─── Exercise library (seeded reference data) ─────────────────────────────────

class Exercise(SQLModel, table=True):
    __tablename__ = "exercises"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    primary_muscle: MuscleGroup = Field(sa_column=Column(SAEnum(MuscleGroup), nullable=False))
    secondary_muscles: list = Field(default_factory=list, sa_column=Column(JSON))
    equipment: EquipmentType = Field(sa_column=Column(SAEnum(EquipmentType), nullable=False))
    is_compound: bool = Field(default=False)
    description: str | None = Field(default=None)
    is_custom: bool = Field(default=False)
    # Extended metadata — optional, defaults safe for existing rows
    movement_pattern: str | None = Field(default=None)      # e.g. "push", "pull", "hinge", "squat", "carry"
    difficulty: str | None = Field(default=None)            # e.g. "beginner", "intermediate", "advanced"
    requires_equipment: list = Field(default_factory=list, sa_column=Column(JSON))  # specific equipment names
    contraindications: list = Field(default_factory=list, sa_column=Column(JSON))   # injury notes e.g. ["knee pain"]
    is_unilateral: bool = Field(default=False)
    is_cardio: bool = Field(default=False)
    is_mobility: bool = Field(default=False)


# ─── Food library (seeded reference data) ─────────────────────────────────────

class Food(SQLModel, table=True):
    __tablename__ = "foods"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    category: FoodCategory = Field(sa_column=Column(SAEnum(FoodCategory), nullable=False))
    unit: str              # e.g. "100g", "1 cup", "1 medium"
    calories: float
    protein: float         # grams
    carbs: float           # grams
    fat: float             # grams
    is_custom: bool = Field(default=False)
    # Extended nutrition — optional, all None-safe for existing rows
    serving_grams: float | None = Field(default=None)  # canonical serving size in grams
    fiber: float | None = Field(default=None)           # grams
    sugar: float | None = Field(default=None)           # grams
    sodium_mg: float | None = Field(default=None)       # milligrams
    brand: str | None = Field(default=None)             # brand or source label


# ─── Equipment library (seeded reference data) ────────────────────────────────

class Equipment(SQLModel, table=True):
    __tablename__ = "equipment"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    category: str  # e.g. "Bodyweight & Home", "Free Weights", etc.
    icon: str      # emoji
    is_custom: bool = Field(default=False)


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
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    workout_date: date
    focus_label: str
    duration_seconds: int = Field(default=0)
    completed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Workouts ──────────────────────────────────────────────────────────────────

class WorkoutSession(SQLModel, table=True):
    __tablename__ = "workout_sessions"
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
    quantity: float
    unit: str
    serving_grams: float | None = Field(default=None)  # actual grams consumed
    calories: float
    protein_g: float
    carbs_g: float
    fat_g: float


# ─── Request / Response schemas ───────────────────────────────────────────────

class UserCreate(SQLModel):
    email: str
    username: str
    password: str

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
