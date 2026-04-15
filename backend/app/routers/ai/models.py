from __future__ import annotations
from pydantic import BaseModel


class PhysicalStatsIn(BaseModel):
    weightLbs: float
    heightFeet: int
    heightInches: int
    age: int
    gender: str


class GoalDetailsIn(BaseModel):
    pace: str
    targetWeightLbs: float | None = None
    timelineWeeks: int | None = None


class GoalSelectionIn(BaseModel):
    """Hierarchical goal selection."""
    primaryGoal: str
    category: str
    modifiers: list[str] = []
    targetFocus: str | None = None


class CustomMacrosIn(BaseModel):
    """User-set macro overrides — any present value replaces the computed TDEE target."""
    calories: int | None = None
    protein: int | None = None
    carbs: int | None = None
    fat: int | None = None


class PlanRequest(BaseModel):
    """Full plan generation — both workout and nutrition."""
    goal: str
    goalSelection: GoalSelectionIn | None = None
    # Legacy fields — ignored when goalSelection is present
    secondaryGoal: str | None = None
    focusedMuscleGroup: str | None = None
    goalDetails: GoalDetailsIn
    physicalStats: PhysicalStatsIn
    customMacros: CustomMacrosIn | None = None
    daysPerWeek: int
    workoutDurationMinutes: int = 60
    equipment: list[str]
    foodsAvailable: list[str]

    # Training context (optional)
    experienceLevel: str | None = None
    recoveryLevel: str | None = None
    workoutFocus: str | None = None
    preferredSplit: str | None = None
    preferredExercises: list[str] = []
    dislikedExercises: list[str] = []
    injuriesOrLimitations: list[str] = []
    exerciseLibrary: list[dict] = []

    # Nutrition context (optional)
    dietaryPreference: str | None = None
    allergies: list[str] = []
    mealsPerDay: int = 3
    # How many distinct daily meal templates to generate (1-7). Client
    # rotates these across 7 days. Fewer templates = faster generation.
    mealVariety: int = 3
    cookingSkill: str | None = None
    prepTimeMinutes: int | None = None
    budgetLevel: str | None = None
    supplementsAvailable: list[str] = []
    mealRoutine: str | None = None   # fixed meals/habits the user already follows
    # Pinned-routine accounting for nutrition regen. The client overlays
    # routine meals on top of generated plans, which would push the day
    # over the calorie target unless the assembler subtracts the routine
    # macros from the daily target before sizing the remaining slots.
    routineMacros: dict | None = None   # {calories, protein, carbs, fat} — totals across all pinned routines
    routineSlots: list[str] = []        # which slot keys are owned by routines: ["breakfast", "extra"]
    userContext: str | None = None

    # Weekly review (sent when regenerating after a weekly check-in)
    weeklyReview: dict | None = None   # {adherence: 1-5, energy: 1-5, notes?: str, pendingChanges?: [...]}


class WorkoutOnlyRequest(BaseModel):
    """Workout-only plan generation — no food/nutrition fields."""
    goal: str
    goalSelection: GoalSelectionIn | None = None
    secondaryGoal: str | None = None
    focusedMuscleGroup: str | None = None
    goalDetails: GoalDetailsIn
    physicalStats: PhysicalStatsIn
    daysPerWeek: int
    workoutDurationMinutes: int = 60
    equipment: list[str]

    experienceLevel: str | None = None
    injuriesOrLimitations: list[str] = []
    userContext: str | None = None


class NutritionOnlyRequest(BaseModel):
    """Nutrition-only plan generation — no equipment fields."""
    goal: str
    goalDetails: GoalDetailsIn
    physicalStats: PhysicalStatsIn
    daysPerWeek: int
    customMacros: CustomMacrosIn | None = None

    foodsAvailable: list[str]
    supplementsAvailable: list[str] = []
    dietaryPreference: str | None = None
    allergies: list[str] = []
    mealsPerDay: int = 3
    # Number of distinct daily meal templates (1-7). variety=1 takes the
    # deterministic non-AI path in the assembler so regens land on the
    # same template every time.
    mealVariety: int = 3
    mealRoutine: str | None = None
    routineMacros: dict | None = None
    routineSlots: list[str] = []
    userContext: str | None = None


class CompletedSetIn(BaseModel):
    setNumber: int
    reps: int
    weightLbs: float
    feedback: str | None = None
    rir: float | None = None


class WeightRecommendRequest(BaseModel):
    exerciseName: str
    goal: str
    lastSets: list[CompletedSetIn]
    nextSetNumber: int
    targetSets: int | None = None
    targetReps: str | None = None
    progressionPace: str | None = None
    experienceLevel: str | None = None
    recoveryLevel: str | None = None
    phase: str | None = None
    workoutFocus: str | None = None
    weekNumber: int | None = None
    incrementLbs: float | None = None
    sleepHours: float | None = None
    energy1to5: int | None = None
    soreness1to5: int | None = None
    stress1to5: int | None = None
    caloriesOnTargetRecently: bool | None = None
    allTimeBestWeightLbs: float | None = None
    allTimeBestReps: int | None = None
    lastSessionBestWeightLbs: float | None = None
    lastSessionBestReps: int | None = None
    # Propagated next-session target from the deterministic workout
    # planner. When present, this is the preferred anchor for the first
    # set of the session — it already reflects the user's history + the
    # goal-specific progression rules.
    plannedTargetWeightLbs: float | None = None
    # Optional canonical slug for the active exercise. When the client
    # knows the slug (from the generated plan), passing it here lets the
    # recommend-weight endpoint skip a `Exercise.name.ilike` lookup and
    # run the layered performance profile / transfer pipeline directly.
    exerciseSlug: str | None = None


class TrainerQuestionRequest(BaseModel):
    question: str
    mode: str = "trainer"          # "trainer" | "nutritionist"
    topic: str | None = None       # scoped topic — trims context sent to AI
    profile: dict
    workoutPlan: dict | None = None
    nutritionPlan: dict | None = None
    currentPlanContext: dict | None = None  # scheduleMapping, workoutDays, todayMeals
    progress: dict | None = None
    conversation: list[dict] | None = None
    userContext: str | None = None  # recent activity log, same as plan generation
    image_base64: str | None = None
    mime_type: str = "image/jpeg"


class WorkoutCoachQuestionRequest(BaseModel):
    question: str
    workout: dict
    activeExerciseName: str | None = None
    currentSetNumber: int | None = None
    loggedSets: list[dict] | None = None


class FoodPhotoRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"


class ScanFoodsImageItem(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"


class ScanFoodsRequest(BaseModel):
    images: list[ScanFoodsImageItem]
    context: str | None = None


class FormPhotoRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"
    exercise_name: str | None = None
    question: str | None = None


class FoodNutritionSearchRequest(BaseModel):
    query: str   # free-text: "100g chicken breast" or "1 avocado" or "pizza slice"

class ExerciseSearchRequest(BaseModel):
    query: str                            # free-text: "lower chest dumbbell", "knee-friendly quad"
    equipment: list[str] | None = None    # equipment user has available
    muscle_group: str | None = None       # optional: target specific muscle
    injuries: list[str] | None = None     # list of injuries to avoid
    exclude: list[str] | None = None      # exercise names the user already has — do not return these

class SupplementLookupRequest(BaseModel):
    name: str

class SupplementPhotoRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"

class BodyScanRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"
    gender: str | None = None
    weight_lbs: float | None = None
    height_inches: float | None = None
    age: int | None = None


class MealInstructionsRequest(BaseModel):
    """Generate prep instructions / quick recipe for a single meal on demand."""
    meal_name: str
    items: list[dict] = []        # [{name, quantity, unit}, ...]
    cooking_skill: str | None = None
    prep_time_minutes: int | None = None
    dietary_preference: str | None = None
    allergies: list[str] = []
    # Optional: previous recipe(s) the user has already seen for this meal.
    # When populated, we tell the AI to return a DIFFERENT preparation
    # (different technique / flavor / cuisine) while using the same
    # ingredient list. Powers the "Try another way" button.
    previous_variants: list[str] = []


class ParseWorkoutsRequest(BaseModel):
    """Parse natural language workout descriptions into structured sessions."""
    text: str                   # e.g. "I did legs yesterday and recovery today"
    currentDate: str | None = None   # ISO date, defaults to today on server


class WorkoutSummaryRequest(BaseModel):
    exercises: list[dict]
    durationSeconds: int
    focus: str
    goal: str
    weightLbs: float = 150.0


class WarmupRequest(BaseModel):
    focus: str
    exercises: list[dict]                   # each has name + equipment
    injuries: list[str] = []
    experience: str | None = None
    durationMinutes: int | None = 60
