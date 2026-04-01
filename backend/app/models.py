from sqlmodel import SQLModel, Field, Column
from sqlalchemy import Enum as SAEnum, JSON
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
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    goal_type: GoalType = Field(sa_column=Column(SAEnum(GoalType), nullable=False))
    pace: GoalPace = Field(sa_column=Column(SAEnum(GoalPace), nullable=False))
    target_weight_lbs: float | None = Field(default=None)
    timeline_weeks: int | None = Field(default=None)
    is_active: bool = Field(default=True)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserPreferences(SQLModel, table=True):
    __tablename__ = "user_preferences"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, index=True)
    days_per_week: int = Field(default=3)
    equipment: list = Field(default=[], sa_column=Column(JSON))
    foods_available: list = Field(default=[], sa_column=Column(JSON))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Exercise library (seeded reference data) ─────────────────────────────────

class Exercise(SQLModel, table=True):
    __tablename__ = "exercises"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    primary_muscle: MuscleGroup = Field(sa_column=Column(SAEnum(MuscleGroup), nullable=False))
    secondary_muscles: list = Field(default=[], sa_column=Column(JSON))
    equipment: EquipmentType = Field(sa_column=Column(SAEnum(EquipmentType), nullable=False))
    is_compound: bool = Field(default=False)
    description: str | None = Field(default=None)
    is_custom: bool = Field(default=False)


# ─── Food library (seeded reference data) ────────────────────────────────────

class Food(SQLModel, table=True):
    __tablename__ = "foods"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    category: FoodCategory = Field(sa_column=Column(SAEnum(FoodCategory), nullable=False))
    unit: str  # e.g. "100g", "1 cup", "1 medium"
    calories: float
    protein: float  # grams
    carbs: float    # grams
    fat: float      # grams
    is_custom: bool = Field(default=False)


# ─── Equipment library (seeded reference data) ───────────────────────────────

class Equipment(SQLModel, table=True):
    __tablename__ = "equipment"
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    category: str  # e.g. "Bodyweight & Home", "Free Weights", etc.
    icon: str      # emoji
    is_custom: bool = Field(default=False)


# ─── Goal options (seeded reference data) ────────────────────────────────────

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


# ─── Workout completion tracking ─────────────────────────────────────────────

class WorkoutCompletion(SQLModel, table=True):
    __tablename__ = "workout_completions"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    workout_date: date
    focus_label: str
    duration_seconds: int = Field(default=0)
    completed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


# ─── Workouts ─────────────────────────────────────────────────────────────────

class WorkoutSession(SQLModel, table=True):
    __tablename__ = "workout_sessions"
    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    name: str
    focus: MuscleGroup = Field(sa_column=Column(SAEnum(MuscleGroup), nullable=False))
    workout_date: date
    source: WorkoutSource = Field(sa_column=Column(SAEnum(WorkoutSource), nullable=False, default=WorkoutSource.GENERATED))
    notes: str | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class WorkoutExercise(SQLModel, table=True):
    __tablename__ = "workout_exercises"
    id: int | None = Field(default=None, primary_key=True)
    session_id: int = Field(foreign_key="workout_sessions.id", index=True)
    exercise_id: int | None = Field(default=None, foreign_key="exercises.id")
    name: str
    order_index: int
    equipment: EquipmentType = Field(sa_column=Column(SAEnum(EquipmentType), nullable=False))
    notes: str | None = Field(default=None)


class ExerciseSet(SQLModel, table=True):
    __tablename__ = "exercise_sets"
    id: int | None = Field(default=None, primary_key=True)
    exercise_id: int = Field(foreign_key="workout_exercises.id", index=True)
    set_number: int
    target_reps: int
    target_weight_lbs: float | None = Field(default=None)
    actual_reps: int | None = Field(default=None)
    actual_weight_lbs: float | None = Field(default=None)
    rpe: int | None = Field(default=None)
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
    food_name: str
    quantity: float
    unit: str
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
    equipment: list[str]          # specific item names e.g. "Dumbbells", "Pull-up bar"
    foods_available: list[str]

class OnboardingSync(SQLModel):
    profile: ProfileUpsert
    goal: GoalUpsert
    preferences: PreferencesUpsert

class SetCreate(SQLModel):
    set_number: int
    target_reps: int
    target_weight_lbs: float | None = None

class ExerciseCreate(SQLModel):
    exercise_id: int | None = None
    name: str
    order_index: int
    equipment: EquipmentType
    notes: str | None = None
    sets: list[SetCreate]

class WorkoutSessionCreate(SQLModel):
    name: str
    focus: MuscleGroup
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
    quantity: float
    unit: str
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
