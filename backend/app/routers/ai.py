from __future__ import annotations

import asyncio
import json
import math
import os
import re
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import openai
from openai import OpenAI

from app.auth import get_current_user
from app.models import User
from app.workout_progression import (
    EffortFeedback,
    ExerciseCategory,
    ExercisePrescription,
    ExperienceLevel,
    GoalType,
    PhaseType,
    PlannedSet,
    ProgressionPace,
    ProgressionPriority,
    ReadinessInput,
    RecoveryLevel,
    SetResult,
    SetType,
    UserTrainingProfile,
    WorkoutContext,
    WorkoutFocus,
    WorkoutProgressionEngine,
)

router = APIRouter(prefix="/ai", tags=["ai"])
print("[AI ROUTER IMPORTED] CODE_VERSION=V6_NONE_FIX")


def get_openai_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY")

# ── Model selectors (all configurable via .env) ───────────────────────────────
# Chat/questions use gpt-5-mini for quality; everything else uses gpt-4o-mini
# for cost efficiency.  Override any via .env.
def model_plan_generation() -> str:
    return os.getenv("MODEL_PLAN_GENERATION", "gpt-4o-mini")

def model_plan_update() -> str:
    return os.getenv("MODEL_PLAN_UPDATE", "gpt-4o-mini")

def model_meal_parsing() -> str:
    return os.getenv("MODEL_MEAL_PARSING", "gpt-4o-mini")

def model_chat() -> str:
    return os.getenv("MODEL_CHAT", "gpt-4o-mini")

def model_chat_fallback() -> str:
    return os.getenv("MODEL_CHAT_FALLBACK", "gpt-4o-mini")

def model_intent() -> str:
    return os.getenv("MODEL_INTENT", "gpt-4o-mini")


# ─── Request schemas ──────────────────────────────────────────────────────────

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
    cookingSkill: str | None = None
    prepTimeMinutes: int | None = None
    budgetLevel: str | None = None
    supplementsAvailable: list[str] = []
    mealRoutine: str | None = None   # fixed meals/habits the user already follows
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
    mealRoutine: str | None = None
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


class TrainerQuestionRequest(BaseModel):
    question: str
    mode: str = "trainer"          # "trainer" | "nutritionist"
    profile: dict
    workoutPlan: dict | None = None
    nutritionPlan: dict | None = None
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


progression_engine = WorkoutProgressionEngine()


# ─── Deterministic recommendation helpers (unchanged) ────────────────────────

def map_goal_type(goal: str) -> GoalType:
    """Map any goal ID (legacy or new hierarchical) to a progression GoalType."""
    g = (goal or "").lower().strip()

    # Strength-oriented goals → STRENGTH (load-first progression)
    _STRENGTH_IDS = {
        "strength", "build_strength", "increase_overall", "improve_1rm",
        "powerlifting", "improve_squat", "improve_bench", "improve_deadlift",
        "improve_ohp", "improve_pullups", "improve_grip", "functional_strength",
        "explosive_strength", "relative_strength",
        "athletic_performance", "improve_athleticism", "improve_speed",
        "improve_agility", "improve_power", "improve_vertical",
        "improve_acceleration", "improve_cod", "improve_balance",
        "sport_performance", "offseason_training", "inseason_maintenance",
        "return_to_sport",
    }
    if g in _STRENGTH_IDS:
        return GoalType.STRENGTH

    # Fat loss / deficit goals → FAT_LOSS (reps-first, moderate load)
    _FAT_LOSS_IDS = {
        "fat_loss", "toning", "lose_fat", "get_lean", "cut",
        "preserve_muscle_cutting",
    }
    if g in _FAT_LOSS_IDS:
        return GoalType.FAT_LOSS

    # Endurance / cardio goals → ENDURANCE (high rep, low rest)
    _ENDURANCE_IDS = {
        "endurance", "improve_cardio", "improve_conditioning", "aerobic_base",
        "improve_vo2", "increase_stamina", "running_fitness",
        "train_5k", "train_10k", "train_half", "train_marathon",
        "sprint_speed", "interval_perf", "hiking_endurance",
        "cycling_endurance", "rowing_endurance", "swimming_endurance",
        "work_capacity",
    }
    if g in _ENDURANCE_IDS:
        return GoalType.ENDURANCE

    # Maintenance / lifestyle goals → MAINTAIN (balanced, sustainable)
    _MAINTAIN_IDS = {
        "maintain", "maintain_physique", "flexibility", "stress_relief",
        "longevity", "improve_coordination",
    }
    if g in _MAINTAIN_IDS:
        return GoalType.MAINTAIN

    # Everything else (muscle_gain, body_recomp, build_muscle, lean_bulk,
    # gain_weight, improve_aesthetics, build_glutes, etc.) → HYPERTROPHY
    return GoalType.HYPERTROPHY


def map_feedback(feedback: str | None) -> EffortFeedback | None:
    if not feedback:
        return None
    mapping = {
        "easy": EffortFeedback.EASY,
        "good": EffortFeedback.GOOD,
        "grind": EffortFeedback.HARD,
        "hard": EffortFeedback.HARD,
        "failure": EffortFeedback.FAILURE,
        "pain": EffortFeedback.PAIN,
        "form_breakdown": EffortFeedback.FORM_BREAKDOWN,
        "form breakdown": EffortFeedback.FORM_BREAKDOWN,
    }
    return mapping.get(feedback.lower().strip())


def infer_exercise_category(exercise_name: str) -> ExerciseCategory:
    name = (exercise_name or "").lower()
    # Machine first (highest priority — overrides other keywords)
    if any(x in name for x in [
        "machine", "cable", "smith", "leg press", "pulldown", "lat pull",
        "seated row machine", "pec deck", "leg extension", "leg curl machine",
        "hack squat machine", "chest press machine",
    ]):
        return ExerciseCategory.MACHINE
    # Bodyweight
    if any(x in name for x in [
        "push up", "push-up", "pushup", "pull up", "pull-up", "pullup",
        "chin up", "chin-up", "chinup", "plank", "dip", "bodyweight",
        "muscle up", "handstand", "pistol squat", "l-sit", "hollow",
    ]):
        return ExerciseCategory.BODYWEIGHT
    # Isolation
    if any(x in name for x in [
        "curl", "extension", "raise", "fly", "flye", "kickback", "lateral",
        "pec deck", "face pull", "shrug", "calf raise", "wrist",
        "concentration", "preacher", "skull crusher", "pushdown",
    ]):
        return ExerciseCategory.ISOLATION
    return ExerciseCategory.COMPOUND


def parse_target_reps(target_reps: str | None) -> tuple[int, int] | None:
    if not target_reps:
        return None
    cleaned = target_reps.strip()
    if "-" in cleaned:
        left, right = cleaned.split("-", 1)
        if left.strip().isdigit() and right.strip().isdigit():
            rep_min, rep_max = int(left.strip()), int(right.strip())
            if rep_min > 0 and rep_max >= rep_min:
                return rep_min, rep_max
    if cleaned.isdigit():
        reps = int(cleaned)
        if reps > 0:
            return reps, reps
    return None


def map_progression_priority(goal_type: GoalType) -> ProgressionPriority:
    if goal_type == GoalType.STRENGTH:
        return ProgressionPriority.LOAD_FIRST
    if goal_type == GoalType.HYPERTROPHY:
        return ProgressionPriority.HYBRID
    return ProgressionPriority.REPS_FIRST


def map_workout_focus(value: str | None) -> WorkoutFocus:
    raw = (value or "").lower().strip().replace(" ", "_")
    for focus in WorkoutFocus:
        if raw == focus.value:
            return focus
    return WorkoutFocus.FULL_BODY


def map_phase(value: str | None) -> PhaseType:
    raw = (value or "").lower().strip()
    if raw == PhaseType.INTENSIFICATION.value:
        return PhaseType.INTENSIFICATION
    if raw == PhaseType.DELOAD.value:
        return PhaseType.DELOAD
    return PhaseType.ACCUMULATION


def map_progression_pace(value: str | None) -> ProgressionPace:
    raw = (value or "").lower().strip()
    if raw == ProgressionPace.CONSERVATIVE.value:
        return ProgressionPace.CONSERVATIVE
    if raw == ProgressionPace.AGGRESSIVE.value:
        return ProgressionPace.AGGRESSIVE
    return ProgressionPace.MODERATE


def map_experience_level(value: str | None) -> ExperienceLevel:
    raw = (value or "").lower().strip()
    if raw == ExperienceLevel.BEGINNER.value:
        return ExperienceLevel.BEGINNER
    if raw == ExperienceLevel.ADVANCED.value:
        return ExperienceLevel.ADVANCED
    return ExperienceLevel.INTERMEDIATE


def map_recovery_level(value: str | None) -> RecoveryLevel:
    raw = (value or "").lower().strip()
    if raw == RecoveryLevel.LOW.value:
        return RecoveryLevel.LOW
    if raw == RecoveryLevel.HIGH.value:
        return RecoveryLevel.HIGH
    return RecoveryLevel.NORMAL


# ─── TDEE and macro computation ───────────────────────────────────────────────

# Weekly lb/week limits per goal direction
_MAX_LOSS_RATE  = 1.5   # lbs/week
_MAX_GAIN_RATE  = 0.5   # lbs/week
_CALS_PER_LB   = 3500   # calories per pound of body weight
_MIN_CALORIES   = 1200


def compute_tdee_and_targets(req: PlanRequest) -> dict:
    """
    Compute TDEE via Mifflin-St Jeor, then derive a calorie target and
    macro split appropriate for the user's goal.

    If targetWeightLbs + timelineWeeks are both present, we derive the
    required weekly rate, clamp it to safe ranges, and convert to a daily
    adjustment.  Otherwise we fall back to the pace-based table.
    """
    ps = req.physicalStats
    weight_kg = ps.weightLbs / 2.205
    height_cm = (ps.heightFeet * 12 + ps.heightInches) * 2.54

    # Mifflin-St Jeor BMR
    base = 10 * weight_kg + 6.25 * height_cm - 5 * ps.age
    if ps.gender == "male":
        bmr = base + 5
    elif ps.gender == "female":
        bmr = base - 161
    else:
        bmr = base - 78  # average for nonbinary / prefer not to say

    # Activity multiplier based on training days
    if req.daysPerWeek <= 1:
        multiplier = 1.2
    elif req.daysPerWeek <= 3:
        multiplier = 1.375
    elif req.daysPerWeek <= 5:
        multiplier = 1.55
    else:
        multiplier = 1.725

    tdee = round(bmr * multiplier)

    goal = req.goal
    pace = req.goalDetails.pace
    goal_rate_summary: str

    # ── Normalise goal id to a nutrition bucket ─────────────────────────────
    # New hierarchical IDs map to the same calorie/macro logic via category.
    _DEFICIT_GOALS = {
        "fat_loss", "toning",                                      # legacy
        "lose_fat", "get_lean", "cut", "preserve_muscle_cutting",  # new
    }
    _SURPLUS_MUSCLE_GOALS = {
        "muscle_gain",                                                     # legacy
        "build_muscle", "lean_bulk", "gain_weight", "improve_aesthetics",  # new
        "build_glutes", "build_upper_body", "build_lower_body",
        "build_arms", "build_shoulders",
    }
    _RECOMP_GOALS = {"body_recomp", "maintain", "maintain_physique"}
    _STRENGTH_GOALS = {
        "strength",                                                        # legacy
        "build_strength", "increase_overall", "improve_1rm", "powerlifting",
        "improve_squat", "improve_bench", "improve_deadlift", "improve_ohp",
        "improve_pullups", "improve_grip", "functional_strength",
        "explosive_strength", "relative_strength",
    }
    _ENDURANCE_GOALS = {
        "endurance",                                                       # legacy
        "improve_cardio", "improve_conditioning", "aerobic_base",
        "improve_vo2", "increase_stamina", "running_fitness",
        "train_5k", "train_10k", "train_half", "train_marathon",
        "sprint_speed", "interval_perf", "hiking_endurance",
        "cycling_endurance", "rowing_endurance", "swimming_endurance",
        "work_capacity",
    }
    _ATHLETIC_GOALS = {
        "athletic_performance",                                            # legacy
        "improve_athleticism", "improve_speed", "improve_agility",
        "improve_power", "improve_vertical", "improve_acceleration",
        "improve_cod", "improve_coordination", "improve_balance",
        "sport_performance", "offseason_training", "inseason_maintenance",
        "return_to_sport",
    }

    # ── Try target-weight / timeline path first ──────────────────────────────
    target_lbs = req.goalDetails.targetWeightLbs
    timeline_wk = req.goalDetails.timelineWeeks

    if target_lbs is not None and timeline_wk is not None and timeline_wk > 0:
        raw_delta_lbs = target_lbs - ps.weightLbs          # positive = gain, negative = loss
        raw_rate = raw_delta_lbs / timeline_wk              # lbs/week

        # Clamp per goal direction
        if goal in _DEFICIT_GOALS:
            clamped_rate = max(-_MAX_LOSS_RATE, min(raw_rate, 0.0))
        elif goal in _SURPLUS_MUSCLE_GOALS:
            clamped_rate = max(0.0, min(raw_rate, _MAX_GAIN_RATE))
        elif goal in _RECOMP_GOALS:
            clamped_rate = max(-0.25, min(raw_rate, 0.25))   # near-maintenance band
        elif goal in _STRENGTH_GOALS:
            clamped_rate = max(0.0, min(raw_rate, _MAX_GAIN_RATE * 0.6))  # mild surplus
        else:
            clamped_rate = max(-0.5, min(raw_rate, 0.5))

        daily_adjustment = round((clamped_rate * _CALS_PER_LB) / 7)

        if abs(clamped_rate) < 0.05:
            goal_rate_summary = f"Maintenance calories — target weight is close to current weight."
        elif clamped_rate < 0:
            goal_rate_summary = (
                f"Targeting {abs(clamped_rate):.2f} lb/week loss "
                f"({timeline_wk} weeks to reach {target_lbs} lbs)."
            )
        else:
            goal_rate_summary = (
                f"Targeting {clamped_rate:.2f} lb/week gain "
                f"({timeline_wk} weeks to reach {target_lbs} lbs)."
            )

    else:
        # ── Fallback: pace-based adjustment table ────────────────────────────
        # Map goal → bucket key for the pace table
        if goal in _DEFICIT_GOALS:
            _bucket = "fat_loss"
        elif goal in _SURPLUS_MUSCLE_GOALS:
            _bucket = "muscle_gain"
        elif goal in _RECOMP_GOALS:
            _bucket = "body_recomp"
        elif goal in _STRENGTH_GOALS:
            _bucket = "strength"
        elif goal in _ENDURANCE_GOALS:
            _bucket = "endurance"
        elif goal in _ATHLETIC_GOALS:
            _bucket = "athletic_performance"
        else:
            _bucket = goal  # fallback for any unrecognised id

        pace_adjustments: dict[str, dict[str, int]] = {
            "fat_loss":             {"conservative": -250, "moderate": -500, "aggressive": -750},
            "muscle_gain":          {"conservative":  150, "moderate":  300, "aggressive":  500},
            "body_recomp":          {"conservative": -100, "moderate":    0, "aggressive":  100},
            "strength":             {"conservative":  200, "moderate":  350, "aggressive":  500},
            "endurance":            {"conservative":  100, "moderate":  200, "aggressive":  300},
            "athletic_performance": {"conservative":  150, "moderate":  250, "aggressive":  400},
        }
        daily_adjustment = pace_adjustments.get(_bucket, {}).get(pace, 0)
        pace_label = {"conservative": "slow", "moderate": "moderate", "aggressive": "fast"}.get(pace, pace)
        goal_rate_summary = f"Using {pace_label} pace adjustment ({daily_adjustment:+d} cal/day from TDEE)."

    calories = max(_MIN_CALORIES, tdee + daily_adjustment)

    # ── Protein (g/lb bodyweight, goal-specific) ─────────────────────────────
    if goal in _SURPLUS_MUSCLE_GOALS | _RECOMP_GOALS | _STRENGTH_GOALS:
        protein_per_lb = 1.0
    elif goal in _DEFICIT_GOALS:
        protein_per_lb = 0.9
    elif goal in _ENDURANCE_GOALS:
        protein_per_lb = 0.8
    else:  # health, lifestyle, athletic, etc.
        protein_per_lb = 0.75

    protein = round(ps.weightLbs * protein_per_lb)
    protein_cals = protein * 4

    # ── Fat (floor at 0.3 g/lb) ──────────────────────────────────────────────
    fat_floor_g   = math.ceil(ps.weightLbs * 0.3)
    fat_floor_cal = fat_floor_g * 9

    # ── Carbs from remaining calories ────────────────────────────────────────
    remaining_for_carbs_and_fat = calories - protein_cals
    # Tentative fat: 30 % of total calories, but not below floor
    fat_target_cal = max(fat_floor_cal, round(calories * 0.30))
    fat = round(fat_target_cal / 9)

    carb_cals = remaining_for_carbs_and_fat - (fat * 9)
    carbs = max(0, round(carb_cals / 4))

    # Enforce minimum 75 g carbs: reduce fat if needed, but keep fat ≥ floor
    if carbs < 75:
        deficit_cals = (75 - carbs) * 4
        transferable_fat_cals = max(0, (fat * 9) - fat_floor_cal)
        transfer = min(deficit_cals, transferable_fat_cals)
        fat  = round((fat * 9 - transfer) / 9)
        carbs = round((carb_cals + transfer) / 4)

    # ── Apply custom macro overrides (user-set targets take precedence) ────
    cm = req.customMacros
    if cm:
        if cm.calories is not None:
            calories = cm.calories
            goal_rate_summary = f"Using custom calorie target ({calories} cal)."
        if cm.protein is not None:
            protein = cm.protein
        if cm.carbs is not None:
            carbs = cm.carbs
        if cm.fat is not None:
            fat = cm.fat

    # ── Normalise mealsPerDay ────────────────────────────────────────────────
    meals = req.mealsPerDay if req.mealsPerDay in {2, 3, 4} else 3

    # ── Per-meal splits (practical, not perfectly even) ──────────────────────
    #   Ratios: 2-meal → lunch 45% / dinner 55%
    #           3-meal → breakfast 25% / lunch 35% / dinner 40%
    #           4-meal → breakfast 25% / lunch 30% / dinner 35% / snack 10%

    def _split(total: int, ratios: list[float]) -> list[int]:
        """Split `total` across `ratios`, last bucket absorbs rounding."""
        buckets = [round(total * r) for r in ratios]
        buckets[-1] = total - sum(buckets[:-1])
        return buckets

    meal_data: dict = {}

    if meals == 2:
        cal_splits  = _split(calories, [0.45, 0.55])
        prot_splits = _split(protein,  [0.45, 0.55])
        carb_splits = _split(carbs,    [0.45, 0.55])
        fat_splits  = _split(fat,      [0.45, 0.55])
        meal_data = {
            "lunch_cal":    cal_splits[0],  "lunch_prot":   prot_splits[0],
            "lunch_carbs":  carb_splits[0], "lunch_fat":    fat_splits[0],
            "dinner_cal":   cal_splits[1],  "dinner_prot":  prot_splits[1],
            "dinner_carbs": carb_splits[1], "dinner_fat":   fat_splits[1],
        }
    elif meals == 4:
        cal_splits  = _split(calories, [0.25, 0.30, 0.35, 0.10])
        prot_splits = _split(protein,  [0.25, 0.30, 0.35, 0.10])
        carb_splits = _split(carbs,    [0.25, 0.30, 0.35, 0.10])
        fat_splits  = _split(fat,      [0.25, 0.30, 0.35, 0.10])
        meal_data = {
            "breakfast_cal":   cal_splits[0],  "breakfast_prot":  prot_splits[0],
            "breakfast_carbs": carb_splits[0], "breakfast_fat":   fat_splits[0],
            "lunch_cal":       cal_splits[1],  "lunch_prot":      prot_splits[1],
            "lunch_carbs":     carb_splits[1], "lunch_fat":       fat_splits[1],
            "dinner_cal":      cal_splits[2],  "dinner_prot":     prot_splits[2],
            "dinner_carbs":    carb_splits[2], "dinner_fat":      fat_splits[2],
            "snack_cal":       cal_splits[3],  "snack_prot":      prot_splits[3],
            "snack_carbs":     carb_splits[3], "snack_fat":       fat_splits[3],
        }
    else:  # 3 meals
        cal_splits  = _split(calories, [0.25, 0.35, 0.40])
        prot_splits = _split(protein,  [0.25, 0.35, 0.40])
        carb_splits = _split(carbs,    [0.25, 0.35, 0.40])
        fat_splits  = _split(fat,      [0.25, 0.35, 0.40])
        meal_data = {
            "breakfast_cal":   cal_splits[0],  "breakfast_prot":  prot_splits[0],
            "breakfast_carbs": carb_splits[0], "breakfast_fat":   fat_splits[0],
            "lunch_cal":       cal_splits[1],  "lunch_prot":      prot_splits[1],
            "lunch_carbs":     carb_splits[1], "lunch_fat":       fat_splits[1],
            "dinner_cal":      cal_splits[2],  "dinner_prot":     prot_splits[2],
            "dinner_carbs":    carb_splits[2], "dinner_fat":      fat_splits[2],
        }

    return {
        "tdee": tdee,
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fat": fat,
        "meals": meals,
        "goal_rate_summary": goal_rate_summary,
        **meal_data,
    }


# ─── Prompt builder ───────────────────────────────────────────────────────────

def _meal_schema_and_targets(t: dict) -> tuple[str, str]:
    """
    Return (meal_target_summary, meal_json_schema_fragment) appropriate for
    the number of meals in this plan.
    """
    meals = t["meals"]

    def _meal_block(name: str, cal: int, prot: int, carb: int, fat_g: int) -> str:
        return (
            f'    "{name}": {{\n'
            f'      "meal": "Short descriptive recipe name",\n'
            f'      "foods": ["ingredient with amount", "..."],\n'
            f'      "calories": {cal},\n'
            f'      "protein": {prot},\n'
            f'      "carbs": {carb},\n'
            f'      "fat": {fat_g},\n'
            f'      "fiber": 0,\n'
            f'      "micronutrients": {{"fiber": 0, "sugar": 0, "sodium": 0, "cholesterol": 0, "vitaminA": 0, "vitaminC": 0, "vitaminD": 0, "calcium": 0, "iron": 0, "potassium": 0}},\n'
            f'      "estimated_alignment": "e.g. high protein, moderate carb",\n'
            f'      "isRoutine": false\n'
            f'    }}'
        )

    def _target_line(name: str, cal: int, prot: int, carb: int, fat_g: int) -> str:
        return f"  {name.capitalize()}: ~{cal} cal / ~{prot}g protein / ~{carb}g carbs / ~{fat_g}g fat"

    if meals == 2:
        summary = "\n".join([
            _target_line("lunch",  t["lunch_cal"],  t["lunch_prot"],  t["lunch_carbs"],  t["lunch_fat"]),
            _target_line("dinner", t["dinner_cal"], t["dinner_prot"], t["dinner_carbs"], t["dinner_fat"]),
        ])
        schema = ",\n".join([
            _meal_block("lunch",  t["lunch_cal"],  t["lunch_prot"],  t["lunch_carbs"],  t["lunch_fat"]),
            _meal_block("dinner", t["dinner_cal"], t["dinner_prot"], t["dinner_carbs"], t["dinner_fat"]),
        ])
    elif meals == 4:
        summary = "\n".join([
            _target_line("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _target_line("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _target_line("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
            _target_line("snack",     t["snack_cal"],     t["snack_prot"],     t["snack_carbs"],     t["snack_fat"]),
        ])
        schema = ",\n".join([
            _meal_block("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _meal_block("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _meal_block("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
            _meal_block("snack",     t["snack_cal"],     t["snack_prot"],     t["snack_carbs"],     t["snack_fat"]),
        ])
    else:  # 3
        summary = "\n".join([
            _target_line("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _target_line("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _target_line("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
        ])
        schema = ",\n".join([
            _meal_block("breakfast", t["breakfast_cal"], t["breakfast_prot"], t["breakfast_carbs"], t["breakfast_fat"]),
            _meal_block("lunch",     t["lunch_cal"],     t["lunch_prot"],     t["lunch_carbs"],     t["lunch_fat"]),
            _meal_block("dinner",    t["dinner_cal"],    t["dinner_prot"],    t["dinner_carbs"],    t["dinner_fat"]),
        ])

    return summary, schema


def _build_weekly_review_section(req: PlanRequest) -> str:
    """Format weekly review data into a prompt section the AI can use."""
    wr = req.weeklyReview
    if not wr:
        return ""
    adherence = wr.get("adherence", 3)
    energy = wr.get("energy", 3)
    notes = wr.get("notes", "")
    pending = wr.get("pendingChanges", [])
    adherence_labels = {1: "completed almost none", 2: "missed most sessions", 3: "did about half", 4: "completed most", 5: "completed all"}
    energy_labels = {1: "burned out / overtrained", 2: "tired and sluggish", 3: "okay / average", 4: "good energy", 5: "great / fully recovered"}
    lines = [
        "WEEKLY CHECK-IN (use this to adapt the next week's plan):",
        f"- Workout adherence: {adherence}/5 — {adherence_labels.get(adherence, 'unknown')}",
        f"- Energy / recovery: {energy}/5 — {energy_labels.get(energy, 'unknown')}",
    ]
    if notes:
        lines.append(f"- User notes: {notes}")
    if pending:
        changes = "; ".join(p.get("summary", "") for p in pending if p.get("summary"))
        if changes:
            lines.append(f"- Profile changes made this week: {changes}")
    lines.append("")
    lines.append(
        "ADAPTATION RULES based on the check-in above:\n"
        "- If adherence ≤ 2: simplify the plan — fewer exercises per session, or fewer training days.\n"
        "- If energy ≤ 2: reduce volume/intensity — this is a deload week. Lighter weights, fewer sets.\n"
        "- If adherence and energy are both ≥ 4: consider progressing — add volume, intensity, or a new exercise variation.\n"
        "- If profile changes mention new equipment or foods: incorporate them into the plan.\n"
        "- If user notes mention pain/injury: avoid those muscle groups or movements.\n"
        "- Always explain in the trainerNote why you made specific adaptations based on this check-in."
    )
    return "\n".join(lines)


def build_workout_prompt(req: PlanRequest) -> str:
    """Prompt for workout plan only — runs in parallel with nutrition prompt."""
    ps  = req.physicalStats
    t   = compute_tdee_and_targets(req)

    height_str    = f"{ps.heightFeet}'{ps.heightInches}\""
    equipment_str = ", ".join(req.equipment) if req.equipment else "bodyweight only"
    foods_str     = ", ".join(req.foodsAvailable) if req.foodsAvailable else "general healthy foods"
    supps_str     = ", ".join(req.supplementsAvailable) if req.supplementsAvailable else None

    # ── Equipment-based forbidden list ───────────────────────────────────────
    has_barbell   = any(e in {"Barbell", "Squat rack", "Power rack", "Smith machine"} for e in req.equipment)
    has_dumbbells = any(e in {"Dumbbells", "Kettlebell"} for e in req.equipment)
    has_machines  = any(e in {
        "Cable machine", "Leg press", "Lat pulldown",
        "Chest press machine", "Seated row machine", "Leg extension", "Leg curl",
    } for e in req.equipment)
    has_pullupbar = "Pull-up bar" in req.equipment or has_barbell or has_machines
    has_bench     = any(e in {"Flat bench", "Incline bench"} for e in req.equipment)

    forbidden: list[str] = []
    if not has_barbell:   forbidden.append("barbells or barbell exercises (squat, deadlift, bench press with barbell)")
    if not has_dumbbells: forbidden.append("dumbbells or kettlebells")
    if not has_machines:  forbidden.append("cable machines, leg press, lat pulldown, or any gym machine")
    if not has_pullupbar: forbidden.append("pull-up bar exercises")
    if not has_bench:     forbidden.append("flat or incline bench exercises")
    forbidden_str = "; ".join(forbidden) if forbidden else "none"

    cardio_equipment = [e for e in req.equipment if e in {
        "Treadmill", "Stationary Bike", "Elliptical", "Rowing Machine",
        "Stair Climber", "Assault Bike", "Battle Ropes", "Jump rope", "Swimming Pool",
    }]

    # ── Goal-specific workout rule ────────────────────────────────────────────
    goal_workout_rules: dict[str, str] = {
        "muscle_gain": (
            "GOAL IS MUSCLE GAIN: Every session must be pure hypertrophy/strength lifting — "
            "compound and isolation exercises targeting specific muscle groups. "
            "DO NOT include cardio exercises. "
            "Focus: progressive overload, 3-5 sets, 6-15 reps, 60-120s rest."
        ),
        "strength": (
            "GOAL IS STRENGTH: Heavy compound movements — squat, deadlift, bench, row, overhead press. "
            "DO NOT include cardio. Low reps (3-6), high load, 2-5 min rest."
        ),
        "fat_loss": (
            "GOAL IS FAT LOSS: Strength training base (compound lifts) with ONE cardio finisher per session. "
            "Moderate rest (60-90s), higher rep ranges (10-15)."
        ),
        "toning": (
            "GOAL IS TONING: Circuit-style strength training with moderate weight, higher reps (12-20). "
            "Add one short cardio finisher (5-10 min). Short rest (45-60s)."
        ),
        "body_recomp": (
            "GOAL IS BODY RECOMPOSITION: Balanced strength training, moderate weight/reps (8-12). "
            "One optional cardio finisher. Mix compound and isolation."
        ),
        "endurance": (
            "GOAL IS ENDURANCE: Prioritise cardio sessions using available cardio equipment. "
            "Include 1-2 strength sessions per week. High reps (15-20), light weight."
        ),
        "athletic_performance": (
            "GOAL IS ATHLETIC PERFORMANCE: Mix of power-focused strength, cardio conditioning, and agility. "
            "Include explosive movements where equipment allows."
        ),
        "maintain": (
            "GOAL IS MAINTENANCE: Balanced mix of strength and cardio. Moderate volume, all rep ranges. "
            "Manageable effort — not a cut or bulk."
        ),
        "flexibility": (
            "GOAL IS FLEXIBILITY: Mobility work, dynamic stretching, yoga-style movements. "
            "Light bodyweight strength only. Avoid heavy loading."
        ),
        "stress_relief": (
            "GOAL IS STRESS RELIEF: Low-intensity, enjoyable movement. Light strength, easy cardio, yoga. "
            "Keep sessions feel-good, not exhausting."
        ),
        "longevity": (
            "GOAL IS LONGEVITY: Focus on joint-friendly compound movements, mobility work, and sustainable "
            "training. Moderate intensity, controlled tempo, emphasis on form and recovery. "
            "Avoid maximal loading or high-impact movements."
        ),
    }
    primary_rule = goal_workout_rules.get(req.goal, f"Goal is {req.goal} — choose appropriate exercise selection and intensity.")
    goal_rule = primary_rule

    # ── Hierarchical goal (new model) — overrides legacy secondaryGoal ─────
    gs = req.goalSelection
    if gs:
        modifier_lines = [f"- Modifier: {m.replace('_', ' ')}" for m in gs.modifiers] if gs.modifiers else []
        if modifier_lines:
            goal_rule += "\nGOAL MODIFIERS (apply these refinements to the plan):\n" + "\n".join(modifier_lines)
        target_focus = gs.targetFocus
    else:
        # Legacy fallback
        if req.secondaryGoal and req.secondaryGoal != req.goal:
            secondary_rule = goal_workout_rules.get(req.secondaryGoal, "")
            goal_rule = (
                f"PRIMARY GOAL: {primary_rule}\n"
                f"SECONDARY GOAL (blend into programming where possible): {secondary_rule}"
            )
        target_focus = req.focusedMuscleGroup

    focused_muscle_line = (
        f"TARGET FOCUS: The user wants to emphasise {target_focus} — "
        f"include extra volume and at least one dedicated session for {target_focus} per week."
        if target_focus else ""
    )

    # ── Experience / recovery / split context ────────────────────────────────
    exp_str      = req.experienceLevel or "intermediate"
    recovery_str = req.recoveryLevel or "normal"
    split_str    = req.preferredSplit or "auto (choose best split for the goal and days)"
    focus_str    = req.workoutFocus or "auto"

    # ── Preferred / disliked / injury lines ──────────────────────────────────
    preferred_str = (
        "Preferred exercises (use where suitable): " + ", ".join(req.preferredExercises)
        if req.preferredExercises else ""
    )
    disliked_str = (
        "Exercises to AVOID (user dislikes): " + ", ".join(req.dislikedExercises)
        if req.dislikedExercises else ""
    )
    injury_str = (
        "Injuries / limitations — avoid conflicting movements: " + ", ".join(req.injuriesOrLimitations)
        if req.injuriesOrLimitations else ""
    )

    # ── Exercise library constraint ───────────────────────────────────────────
    if req.exerciseLibrary:
        lib_names = [ex.get("name", "") for ex in req.exerciseLibrary if ex.get("name")]
        library_str = (
            "EXERCISE LIBRARY CONSTRAINT: You MUST only choose exercises from this list — "
            "do not invent exercises outside it:\n" + ", ".join(lib_names)
        )
    else:
        library_str = (
            "No exercise library provided — choose any exercises appropriate for the available equipment."
        )

    # ── Nutrition context ────────────────────────────────────────────────────
    diet_lines: list[str] = []
    if req.dietaryPreference:
        diet_lines.append(f"Dietary preference: {req.dietaryPreference}")
    if req.allergies:
        diet_lines.append(f"Allergies / intolerances (NEVER include these): {', '.join(req.allergies)}")
    if req.cookingSkill:
        diet_lines.append(f"Cooking skill: {req.cookingSkill}")
    if req.prepTimeMinutes:
        diet_lines.append(f"Max prep time per meal: {req.prepTimeMinutes} minutes")
    if req.budgetLevel:
        diet_lines.append(f"Budget: {req.budgetLevel}")
    diet_context = "\n".join(f"- {l}" for l in diet_lines) if diet_lines else "- No special dietary restrictions"

    # ── Per-meal targets and JSON schema ────────────────────────────────────
    meal_summary, meal_schema = _meal_schema_and_targets(t)

    # ── Workout prompt ────────────────────────────────────────────────────────
    return f"""You are an expert fitness coach.
Generate a personalised {req.daysPerWeek}-day weekly workout plan for this user.

USER PROFILE:
- Primary goal: {gs.primaryGoal if gs else req.goal} (category: {gs.category if gs else 'auto'}, pace: {req.goalDetails.pace}){f"  |  Modifiers: {', '.join(gs.modifiers)}" if gs and gs.modifiers else ""}{f"  |  Target focus: {gs.targetFocus}" if gs and gs.targetFocus else ""}
- Age: {ps.age}  Gender: {ps.gender}  Weight: {ps.weightLbs} lbs  Height: {height_str}
{f"- Target weight: {req.goalDetails.targetWeightLbs} lbs" if req.goalDetails.targetWeightLbs else ""}
- Training days/week: {req.daysPerWeek}  Session length: {req.workoutDurationMinutes} min
- Experience: {exp_str}  Recovery: {recovery_str}
- Preferred split: {split_str}  Focus: {focus_str}

EQUIPMENT:
Available: {equipment_str}
Cardio equipment: {', '.join(cardio_equipment) if cardio_equipment else 'none'}
FORBIDDEN (user does NOT own): {forbidden_str}

{library_str}
{preferred_str}
{disliked_str}
{injury_str}
{f"""TODAY'S CONTEXT — READ THIS CAREFULLY AND APPLY IT:
{req.userContext}

CRITICAL: Day 1 of this plan is TODAY. If the user trained any muscle group today or yesterday (as described above), that muscle group MUST NOT appear as the primary focus of Day 1. Schedule Day 1 around muscles that have had adequate rest. Rearrange the split so recovered muscles come first.""" if req.userContext else ""}

{_build_weekly_review_section(req)}
GOAL RULE (follow strictly): {goal_rule}
{focused_muscle_line}

INSTRUCTIONS:
- Provide exactly {req.daysPerWeek} training day objects.
- Each exercise: sets (int), reps (string e.g. "8-10"), restSeconds (int), equipment (string).
- Sessions should fill ~{req.workoutDurationMinutes} minutes (roughly 8 min per exercise slot).
- ONLY use exercises requiring equipment from the available list.
- If an exercise library is provided, use ONLY exercises from that list.
- Apply the TODAY'S CONTEXT above — Day 1 must respect recent muscle training and any other user preferences stated.

Return ONLY valid JSON matching this schema exactly:
{{
  "trainerNote": "60-80 word explanation of why this split suits this user's goal and equipment.",
  "workout_plan": {{
    "name": "string",
    "totalDays": {req.daysPerWeek},
    "days": [
      {{
        "day": "Day 1",
        "focus": "string",
        "exercises": [
          {{"name": "string", "sets": 3, "reps": "8-10", "restSeconds": 60, "equipment": "string"}}
        ]
      }}
    ]
  }}
}}

IMPORTANT: Each day must have exactly 5 exercises. No more, no fewer."""


def build_nutrition_prompt(req: PlanRequest) -> str:
    """Prompt for nutrition plan only — runs in parallel with workout prompt."""
    ps  = req.physicalStats
    t   = compute_tdee_and_targets(req)
    foods_str = ", ".join(req.foodsAvailable) if req.foodsAvailable else "general healthy foods"
    supps_str = ", ".join(req.supplementsAvailable) if req.supplementsAvailable else None

    diet_lines: list[str] = []
    if req.dietaryPreference:
        diet_lines.append(f"Dietary preference: {req.dietaryPreference}")
    if req.allergies:
        diet_lines.append(f"Allergies (NEVER include): {', '.join(req.allergies)}")
    if req.cookingSkill:
        diet_lines.append(f"Cooking skill: {req.cookingSkill}")
    if req.prepTimeMinutes:
        diet_lines.append(f"Max prep time: {req.prepTimeMinutes} min")
    if req.budgetLevel:
        diet_lines.append(f"Budget: {req.budgetLevel}")
    diet_context = "\n".join(f"- {l}" for l in diet_lines) if diet_lines else "- No special restrictions"

    height_str = f"{ps.heightFeet}'{ps.heightInches}\""
    _, meal_schema = _meal_schema_and_targets(t)
    meal_summary, _ = _meal_schema_and_targets(t)

    meal_routine_block = (
        f"\nUSER'S FIXED MEAL ROUTINE — READ CAREFULLY AND FOLLOW EXACTLY:\n{req.mealRoutine}\n\n"
        "ROUTINE RULES (non-negotiable):\n"
        "1. Parse each meal the user describes above. Include it in ALL 3 plan templates VERBATIM.\n"
        "2. Use the exact foods and quantities they specified — do NOT substitute or modify routine meals.\n"
        "3. Set \"isRoutine\": true on every meal that comes from the routine above.\n"
        "4. Calculate the macros for routine meals accurately based on stated portions.\n"
        "5. Fill the REMAINING meal slots with AI-generated meals (\"isRoutine\": false) "
        "using available foods to hit the daily targets after accounting for routine meal macros.\n"
        "6. If the routine covers breakfast, then your breakfast in ALL 3 templates must be that routine meal.\n"
        if req.mealRoutine else ""
    )

    user_context_block = (
        f"\nUSER CONTEXT — READ AND APPLY THIS:\n{req.userContext}\n"
        "Factor in any foods, habits, schedule constraints, or preferences mentioned above when building all 3 templates."
        if req.userContext else ""
    )

    return f"""You are a registered dietitian.
Generate 3 distinct daily meal templates (A, B, C) for this user. All three must hit the same daily targets using the same available foods, but vary the meals, recipes, and portion combinations to provide variety across the week.

USER PROFILE:
- Goal: {req.goalSelection.primaryGoal if req.goalSelection else req.goal} (pace: {req.goalDetails.pace}){f"  |  Modifiers: {', '.join(req.goalSelection.modifiers)}" if req.goalSelection and req.goalSelection.modifiers else ""}
- Age: {ps.age}  Gender: {ps.gender}  Weight: {ps.weightLbs} lbs  Height: {height_str}
- Calorie strategy: {t['goal_rate_summary']}
{meal_routine_block}
{user_context_block}
{_build_weekly_review_section(req)}
AVAILABLE FOODS (use ONLY these — no substitutions, no additions):
{foods_str}

Supplements user already takes: {supps_str if supps_str else "none — recommend best for goal"}
{diet_context}
Meals per day: {t['meals']}

DAILY TARGETS (same for all three templates):
{t['calories']} cal / {t['protein']}g protein / {t['carbs']}g carbs / {t['fat']}g fat
Per-meal targets (reference):
{meal_summary}

INSTRUCTIONS:
- Each template: recipe name + ingredient list with amounts per meal.
- "estimated_alignment" per meal (e.g. "high protein, moderate carb").
- Templates must differ meaningfully — vary recipes, not just amounts.
- Fixed routine meals → "isRoutine": true; AI meals → "isRoutine": false.
- supplementStack: 2-4 evidence-based supplements at top level.
- For each meal include "fiber" (grams) and "micronutrients" object with estimated values:
  fiber (g), sugar (g), sodium (mg), cholesterol (mg), vitaminA (% DV), vitaminC (% DV),
  vitaminD (% DV), calcium (% DV), iron (% DV), potassium (mg).
  Estimate based on the actual ingredients and amounts. Use 0 if negligible.

Return only the required JSON.

Return ONLY valid JSON:
{{
  "nutritionistNote": "60-80 word explanation of calorie target, macro split, and rotation approach.",
  "supplementStack": [
    {{"name": "string", "dose": "string", "timing": "string", "purpose": "string"}}
  ],
  "nutrition_plan_a": {{
    "targets": {{"calories": {t['calories']}, "protein": {t['protein']}, "carbs": {t['carbs']}, "fat": {t['fat']}}},
{meal_schema}
  }},
  "nutrition_plan_b": {{
    "targets": {{"calories": {t['calories']}, "protein": {t['protein']}, "carbs": {t['carbs']}, "fat": {t['fat']}}},
{meal_schema}
  }},
  "nutrition_plan_c": {{
    "targets": {{"calories": {t['calories']}, "protein": {t['protein']}, "carbs": {t['carbs']}, "fat": {t['fat']}}},
{meal_schema}
  }}
}}"""


# ─── Validation helper ────────────────────────────────────────────────────────

def _validate_plans(plans: dict, req: PlanRequest) -> None:
    """Raise ValueError only for hard structural failures that make the plan unusable."""
    if "workout_plan" not in plans:
        raise ValueError("AI response missing 'workout_plan'")
    if "nutrition_plan" not in plans:
        raise ValueError("AI response missing 'nutrition_plan'")

    wp = plans["workout_plan"]
    days = wp.get("days", [])
    # Accept if AI generates at least 1 day (it may round down on very long plans)
    if not days:
        raise ValueError("workout_plan.days is empty")
    if len(days) < req.daysPerWeek - 1:
        raise ValueError(
            f"workout_plan.days has only {len(days)} entries, expected {req.daysPerWeek}"
        )

    np_ = plans["nutrition_plan"]
    if "targets" not in np_:
        raise ValueError("nutrition_plan missing 'targets'")

    # Require at least one meal key — don't hard-fail on missing snack etc.
    meal_keys = {"breakfast", "lunch", "dinner", "snack"}
    if not any(k in np_ for k in meal_keys):
        raise ValueError("nutrition_plan has no meal entries")

    # Notes and supplementStack are logged but NOT blocking — the plan works without them
    trainer_note = plans.get("trainerNote", "") or wp.get("trainerNote", "")
    nutritionist_note = plans.get("nutritionistNote", "") or np_.get("nutritionistNote", "")
    if not trainer_note:
        print("[AI /plans] WARNING: trainerNote missing from response")
    if not nutritionist_note:
        print("[AI /plans] WARNING: nutritionistNote missing from response")
    if not np_.get("supplementStack"):
        print("[AI /plans] WARNING: supplementStack missing from response")


# ─── Parallel AI call helpers ────────────────────────────────────────────────

def _log_openai_error(tag: str, attempt: int, model: str, e: Exception) -> str:
    """Log full upstream OpenAI error detail and return a diagnostic string."""
    err_type = type(e).__name__
    if isinstance(e, openai.APIStatusError):
        status = e.status_code
        # Dump every possible field — body can be dict, str, or None
        raw_body   = getattr(e, 'body', 'NO_BODY_ATTR')
        raw_str    = str(e)
        raw_repr   = repr(e)
        raw_message = getattr(e, 'message', None)
        raw_response = getattr(e, 'response', None)

        # Try nested error dict (standard OpenAI format)
        if isinstance(raw_body, dict):
            err_code = raw_body.get('error', {}).get('code')
            err_msg  = raw_body.get('error', {}).get('message') or raw_message or raw_str
        else:
            err_code = None
            err_msg  = raw_message or raw_str

        print(
            f"[{tag}] attempt {attempt} OPENAI {status} ERROR"
            f"\n  model      : {model}"
            f"\n  error_type : {err_type}"
            f"\n  error_code : {err_code}"
            f"\n  message    : {err_msg}"
            f"\n  body       : {raw_body}"
            f"\n  str(e)     : {raw_str}"
            f"\n  repr(e)    : {raw_repr}"
        )
        if status == 401:
            print(f"  → DIAGNOSIS A/B: bad API key or key has no access to this model")
        elif status == 403:
            print(f"  → DIAGNOSIS B: API key / project lacks access to model '{model}'")
        elif status == 404:
            print(f"  → DIAGNOSIS A: model '{model}' not found — check exact name")
        elif status == 400:
            print(f"  → DIAGNOSIS C/D: bad request — unsupported param or payload for this model")
        elif status == 429:
            print(f"  → DIAGNOSIS D: rate limit or quota exceeded")
        return f"OpenAI {status} ({err_type}) model={model}: {err_msg}"
    elif isinstance(e, openai.APIConnectionError):
        print(f"[{tag}] attempt {attempt} CONNECTION ERROR model={model}: {e}")
        return f"OpenAI connection error model={model}: {e}"
    elif isinstance(e, openai.APITimeoutError):
        print(f"[{tag}] attempt {attempt} TIMEOUT model={model}: {e}")
        return f"OpenAI timeout model={model}: {e}"
    else:
        print(f"[{tag}] attempt {attempt} UNEXPECTED {err_type} model={model}: {e}")
        return f"{err_type} model={model}: {e}"


def _is_gpt5(model: str) -> bool:
    """True for any gpt-5 family model. Uses prefix only — no o-series."""
    return model.startswith("gpt-5")


def _chat_create(client: OpenAI, **kwargs) -> object:
    """
    Drop-in wrapper for client.chat.completions.create() that normalises params
    per model family.

    gpt-5 family:
      - strip temperature (only default accepted)
      - strip response_format=json_object (use json_schema instead)
      - rename max_tokens -> max_completion_tokens
    All other models: params passed through unchanged.
    """
    model = kwargs.get("model", "")
    print(f"[_chat_create] CODE_VERSION=V6_NONE_FIX model={model!r} keys={list(kwargs.keys())} rf={kwargs.get('response_format')}")
    if _is_gpt5(model):
        kwargs["temperature"] = 1
        # gpt-5 supports json_object and json_schema — keep response_format as-is
        if "max_tokens" in kwargs:
            kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
    return client.chat.completions.create(**kwargs)


def _build_chat_kwargs(
    model: str,
    messages: list[dict],
    json_schema: dict | None = None,
    max_tokens: int | None = None,
    timeout_secs: int = 120,
) -> dict:
    """
    Build kwargs for _chat_create adapted to model family.

    gpt-4o family  → response_format=json_object
    gpt-5 family   → response_format=json_schema (strict flag from schema def)
                     Falls back to prompt-enforced JSON if no schema provided.
    """
    kwargs: dict = dict(model=model, messages=messages, timeout=timeout_secs)
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if _is_gpt5(model):
        kwargs["temperature"] = 1
        if json_schema:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": json_schema.get("name", "response"),
                    "strict": json_schema.get("strict", True),
                    "schema": json_schema["schema"],
                },
            }
        else:
            # No strict schema — still force JSON output to avoid None content
            kwargs["response_format"] = {"type": "json_object"}
    else:
        kwargs["response_format"] = {"type": "json_object"}
    return kwargs


def _looks_truncated(content: str) -> bool:
    """Heuristic: response is likely cut off if it doesn't end with a closing brace/bracket."""
    stripped = content.strip().rstrip("`").strip()
    return bool(stripped) and stripped[-1] not in ("}", "]")


def _extract_json(content: str) -> dict:
    """Extract JSON from model output, handling markdown fences, trailing commas, and truncation."""
    text = content.strip()
    # Strip markdown fences
    if text.startswith("```"):
        lines = text.split("\n")
        inner = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        text = inner.strip()
    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fix trailing commas before } or ]
    cleaned = re.sub(r',\s*([}\]])', r'\1', text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    # Try to find the outermost JSON object
    start = text.find('{')
    if start >= 0:
        depth = 0
        end = start
        for i in range(start, len(text)):
            if text[i] == '{': depth += 1
            elif text[i] == '}': depth -= 1
            if depth == 0:
                end = i + 1
                break
        else:
            # Truncated — try to close open braces/brackets
            tail = text[start:]
            open_b = tail.count('{') - tail.count('}')
            open_a = tail.count('[') - tail.count(']')
            tail += ']' * max(open_a, 0) + '}' * max(open_b, 0)
            cleaned = re.sub(r',\s*([}\]])', r'\1', tail)
            return json.loads(cleaned)
        snippet = text[start:end]
        cleaned = re.sub(r',\s*([}\]])', r'\1', snippet)
        return json.loads(cleaned)
    raise json.JSONDecodeError("No JSON object found", text, 0)


# ─── JSON schemas for structured output ───────────────────────────────────────
# strict=True  → all properties required, additionalProperties=false (gpt-5 enforced)
# strict=False → advisory schema; used when output shape is variable

SCHEMA_WORKOUT = {
    "name": "workout_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "trainerNote": {"type": "string"},
            "workout_plan": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "totalDays": {"type": "integer"},
                    "days": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "day": {"type": "string"},
                                "focus": {"type": "string"},
                                "exercises": {
                                    "type": "array",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "name": {"type": "string"},
                                            "sets": {"type": "integer"},
                                            "reps": {"type": "string"},
                                            "restSeconds": {"type": "integer"},
                                            "equipment": {"type": "string"},
                                        },
                                        "required": ["name", "sets", "reps", "restSeconds", "equipment"],
                                        "additionalProperties": False,
                                    },
                                },
                            },
                            "required": ["day", "focus", "exercises"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["name", "totalDays", "days"],
                "additionalProperties": False,
            },
        },
        "required": ["trainerNote", "workout_plan"],
        "additionalProperties": False,
    },
}

# Nutrition: strict=False because meal keys vary (breakfast/lunch/dinner/snack/snack_1/snack_2)
_NUTRITION_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "targets": {
            "type": "object",
            "properties": {
                "calories": {"type": "integer"},
                "protein": {"type": "integer"},
                "carbs": {"type": "integer"},
                "fat": {"type": "integer"},
            },
            "required": ["calories", "protein", "carbs", "fat"],
        },
    },
    "required": ["targets"],
}

SCHEMA_NUTRITION = {
    "name": "nutrition_response",
    "strict": False,
    "schema": {
        "type": "object",
        "properties": {
            "nutritionistNote": {"type": "string"},
            "supplementStack": {"type": "array", "items": {"type": "object"}},
            "nutrition_plan_a": _NUTRITION_PLAN_SCHEMA,
            "nutrition_plan_b": _NUTRITION_PLAN_SCHEMA,
            "nutrition_plan_c": _NUTRITION_PLAN_SCHEMA,
        },
        "required": ["nutritionistNote", "nutrition_plan_a", "nutrition_plan_b", "nutrition_plan_c"],
    },
}

# Trainer Q&A: strict=False because updated plan fields are optional/null
SCHEMA_TRAINER_QUESTION = {
    "name": "trainer_question_response",
    "strict": False,
    "schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "action_items": {"type": "array", "items": {"type": "string"}},
            "needs_plan_update": {"type": "boolean"},
            "safety_note": {"type": "string"},
            "updated_workout_plan": {},
            "updated_nutrition_plan": {},
            "updated_injuries": {
                "type": ["array", "null"],
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "description": {"type": "string"},
                        "bodyPart": {"type": "string"},
                        "status": {"type": "string"},
                        "notes": {"type": "string"},
                    },
                },
            },
            "injury_clarification_needed": {"type": "boolean"},
            "logged_workouts": {
                "type": ["array", "null"],
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string"},
                        "focus": {"type": "string"},
                        "durationSeconds": {"type": "number"},
                        "exercises": {"type": "array", "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "sets": {"type": "array", "items": {
                                    "type": "object",
                                    "properties": {
                                        "weightLbs": {"type": "number"},
                                        "reps": {"type": "number"},
                                    },
                                }},
                            },
                        }},
                    },
                },
            },
        },
        "required": ["answer", "action_items", "needs_plan_update", "safety_note"],
    },
}

SCHEMA_WORKOUT_QUESTION = {
    "name": "workout_question_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "quick_cues": {"type": "array", "items": {"type": "string"}},
            "adjustment": {"type": "string"},
            "safety_note": {"type": "string"},
        },
        "required": ["answer", "quick_cues", "adjustment", "safety_note"],
        "additionalProperties": False,
    },
}

SCHEMA_WORKOUT_SUMMARY = {
    "name": "workout_summary_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "motivationMessage": {"type": "string"},
            "recommendations": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["motivationMessage", "recommendations"],
        "additionalProperties": False,
    },
}

SCHEMA_FOOD_PHOTO = {
    "name": "food_photo_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "meal_name": {"type": "string"},
            "items": {"type": "array", "items": {"type": "string"}},
            "calories": {"type": "number"},
            "protein": {"type": "number"},
            "carbs": {"type": "number"},
            "fat": {"type": "number"},
        },
        "required": ["meal_name", "items", "calories", "protein", "carbs", "fat"],
        "additionalProperties": False,
    },
}

SCHEMA_SCAN_FOODS = {
    "name": "scan_foods_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "foods": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "serving": {"type": "string"},
                        "calories": {"type": "number"},
                        "protein": {"type": "number"},
                        "carbs": {"type": "number"},
                        "fat": {"type": "number"},
                    },
                    "required": ["name", "serving", "calories", "protein", "carbs", "fat"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["foods"],
        "additionalProperties": False,
    },
}

# Supplement: strict=False — two shapes: found=true (full) vs found=false (minimal)
SCHEMA_SUPPLEMENT_INFO = {
    "name": "supplement_info_response",
    "strict": False,
    "schema": {
        "type": "object",
        "properties": {
            "found": {"type": "boolean"},
            "name": {"type": "string"},
            "category": {"type": "string"},
            "tagline": {"type": "string"},
            "whatItDoes": {"type": "string"},
            "evidence": {"type": "string"},
            "dose": {"type": "string"},
            "timing": {"type": "string"},
            "goodFor": {"type": "array", "items": {"type": "string"}},
            "cautions": {"type": "string"},
        },
        "required": ["found", "name"],
    },
}

SCHEMA_SCAN_EQUIPMENT = {
    "name": "scan_equipment_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "equipment": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["equipment"],
        "additionalProperties": False,
    },
}

SCHEMA_FORM_PHOTO = {
    "name": "form_photo_response",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "quick_cues": {"type": "array", "items": {"type": "string"}},
            "likely_target": {"type": "string"},
            "red_flags": {"type": "array", "items": {"type": "string"}},
            "safety_note": {"type": "string"},
        },
        "required": ["answer", "quick_cues", "likely_target", "red_flags", "safety_note"],
        "additionalProperties": False,
    },
}


def _call_workout_ai(client: OpenAI, prompt: str, model: str | None = None, max_tokens: int = 2000) -> dict:
    """Synchronous OpenAI call for the workout plan (run in a thread)."""
    last_error: Exception | None = None
    _model = model or model_plan_generation()
    token_limits = [max_tokens, max_tokens + 500]  # retry with more tokens if truncated
    for attempt, tok_limit in enumerate(token_limits, start=1):
        try:
            kwargs = _build_chat_kwargs(
                _model,
                [
                    {"role": "system", "content": "You are an expert fitness coach. Be concise. Return only the required JSON."},
                    {"role": "user", "content": prompt},
                ],
                json_schema=SCHEMA_WORKOUT,
                max_tokens=tok_limit,
                timeout_secs=120,
            )
            response = _chat_create(client, **kwargs)
            raw = response.choices[0].message.content
            if _looks_truncated(raw):
                print(f"[AI /plans workout] attempt {attempt} TRUNCATED (tok_limit={tok_limit}) — retrying with more tokens")
                last_error = ValueError(f"response truncated at {tok_limit} tokens")
                continue
            data = _extract_json(raw)
            if not data.get("workout_plan") or not data["workout_plan"].get("days"):
                raise ValueError("workout_plan missing or has no days")
            print(f"[AI /plans workout] attempt {attempt} OK — {len(data['workout_plan']['days'])} days")
            return data
        except json.JSONDecodeError as e:
            last_error = ValueError(f"invalid JSON attempt {attempt}: {e}")
            print(f"[AI /plans workout] attempt {attempt} JSON decode error: {e}")
        except ValueError as e:
            last_error = e
            print(f"[AI /plans workout] attempt {attempt} value error: {e}")
        except (openai.APIStatusError, openai.APIConnectionError, openai.APITimeoutError) as e:
            diag = _log_openai_error("AI /plans workout", attempt, _model, e)
            raise ValueError(diag) from e
        except Exception as e:
            print(f"[AI /plans workout] attempt {attempt} unexpected {type(e).__name__}: {e}")
            raise
    raise ValueError(f"Workout AI failed after {len(token_limits)} attempts: {last_error}")


def _food_covered(item: str, allowed_lower: list[str]) -> bool:
    """
    Return True if this food item is covered by at least one entry in allowed_lower.
    Handles quantity prefixes ("1 egg" vs "eggs"), plural/singular, and multi-word foods.
    """
    item_lower = item.lower()
    for a in allowed_lower:
        # Direct substring match
        if a in item_lower:
            return True
        # Check each significant word in the allowed food against the item
        for word in a.split():
            if len(word) <= 3:
                continue
            if word in item_lower:
                return True
            # Singular ↔ plural: strip trailing 's' from either side
            stem = word.rstrip("s")
            if len(stem) > 3 and stem in item_lower:
                return True
            # Check if item word matches allowed stem
            for item_word in item_lower.split():
                if len(item_word) <= 3:
                    continue
                if item_word == word or item_word == stem or item_word.rstrip("s") == stem:
                    return True
    return False


def _check_food_violations(nutrition_plan: dict, allowed_foods: list[str]) -> list[str]:
    """
    Return a list of food strings that appear in the plan but are NOT covered
    by the allowed_foods list.
    """
    if not allowed_foods:
        return []
    allowed_lower = [f.lower() for f in allowed_foods]
    meal_keys = ("breakfast", "lunch", "dinner", "snack", "snack_1", "snack_2")
    violations: list[str] = []
    for key in meal_keys:
        meal = nutrition_plan.get(key)
        if not meal or not isinstance(meal, dict):
            continue
        for food_item in meal.get("foods", []):
            if not _food_covered(str(food_item), allowed_lower):
                violations.append(food_item)
    return violations


def _call_nutrition_ai(client: OpenAI, prompt: str, allowed_foods: list[str] | None = None, model: str | None = None, max_tokens: int = 1500) -> dict:
    """Synchronous OpenAI call for the nutrition plan (run in a thread)."""
    last_error: Exception | None = None
    _model = model or model_plan_generation()
    max_attempts = 3
    current_max_tokens = max_tokens
    for attempt in range(1, max_attempts + 1):
        try:
            full_prompt = prompt
            kwargs = _build_chat_kwargs(
                _model,
                [
                    {"role": "system", "content": "You are a registered dietitian. Be concise. Return only the required JSON."},
                    {"role": "user", "content": full_prompt},
                ],
                json_schema=SCHEMA_NUTRITION,
                max_tokens=current_max_tokens,
                timeout_secs=120,
            )
            response = _chat_create(client, **kwargs)
            raw = response.choices[0].message.content
            if _looks_truncated(raw):
                current_max_tokens = current_max_tokens + 400
                print(f"[AI /plans nutrition] attempt {attempt} TRUNCATED — retrying with max_tokens={current_max_tokens}")
                last_error = ValueError(f"response truncated at {current_max_tokens - 400} tokens")
                continue
            data = _extract_json(raw)
            # Validate all 3 templates
            meal_keys_set = {"breakfast", "lunch", "dinner", "snack"}
            for key in ("nutrition_plan_a", "nutrition_plan_b", "nutrition_plan_c"):
                np_ = data.get(key, {})
                if not np_.get("targets"):
                    raise ValueError(f"{key} missing targets")
                if not any(k in np_ for k in meal_keys_set):
                    raise ValueError(f"{key} has no meal entries")

            # Food constraint is enforced via the prompt — no hard rejection here

            print(f"[AI /plans nutrition] attempt {attempt} OK — nutritionistNote: {bool(data.get('nutritionistNote'))}")
            return data
        except json.JSONDecodeError as e:
            last_error = ValueError(f"invalid JSON attempt {attempt}: {e}")
            print(f"[AI /plans nutrition] attempt {attempt} JSON decode error: {e}")
        except ValueError as e:
            last_error = e
            print(f"[AI /plans nutrition] attempt {attempt} value error: {e}")
        except (openai.APIStatusError, openai.APIConnectionError, openai.APITimeoutError) as e:
            diag = _log_openai_error("AI /plans nutrition", attempt, _model, e)
            raise ValueError(diag) from e
        except Exception as e:
            print(f"[AI /plans nutrition] attempt {attempt} unexpected {type(e).__name__}: {e}")
            raise
    raise ValueError(f"Nutrition AI failed after {max_attempts} attempts: {last_error}")


# ─── Plan validation ─────────────────────────────────────────────────────────

def _validate_plans(result: dict, req: PlanRequest) -> None:
    """Raise ValueError if the assembled plan result is structurally invalid."""
    wp = result.get("workout_plan")
    if not wp or not isinstance(wp, dict):
        raise ValueError("workout_plan missing from result")
    days = wp.get("days", [])
    if not days:
        raise ValueError("workout_plan has no days")
    if len(days) != req.daysPerWeek:
        print(f"[_validate_plans] WARN: expected {req.daysPerWeek} days, got {len(days)}")
    for d in days:
        if not d.get("exercises"):
            raise ValueError(f"Day '{d.get('day', '?')}' has no exercises")

    meal_keys_set = ("breakfast", "lunch", "dinner", "snack")
    for key in ("nutrition_plan_a", "nutrition_plan_b", "nutrition_plan_c"):
        np_ = result.get(key)
        if not np_ or not isinstance(np_, dict):
            raise ValueError(f"{key} missing from result")
        if not np_.get("targets"):
            raise ValueError(f"{key} missing targets")
        if not any(k in np_ for k in meal_keys_set):
            raise ValueError(f"{key} has no meal entries")


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/recommend-weight")
def recommend_weight(
    body: WeightRecommendRequest,
    current_user: User = Depends(get_current_user),
):
    """Deterministic next-set recommendation based on recent performance and feedback."""
    try:
        planned_set_count = body.targetSets if body.targetSets and body.targetSets > 0 else max(1, body.nextSetNumber)
        planned_sets = [
            PlannedSet(set_number=idx + 1, set_type=SetType.STRAIGHT)
            for idx in range(planned_set_count)
        ]

        sets_completed = [
            SetResult(
                set_number=s.setNumber,
                weight_lbs=s.weightLbs,
                reps=s.reps,
                rir=s.rir,
                feedback=map_feedback(s.feedback),
            )
            for s in body.lastSets
        ]
        last_weight = sets_completed[-1].weight_lbs if sets_completed else None

        goal_type  = map_goal_type(body.goal)
        profile    = UserTrainingProfile(
            primary_goal=goal_type,
            experience_level=map_experience_level(body.experienceLevel),
            recovery_level=map_recovery_level(body.recoveryLevel),
            progression_pace=map_progression_pace(body.progressionPace),
        )
        workout    = WorkoutContext(
            workout_name="Current Workout",
            focus=map_workout_focus(body.workoutFocus),
            phase=map_phase(body.phase),
            week_number=max(1, body.weekNumber or 1),
        )
        ex_category = infer_exercise_category(body.exerciseName)
        # Sensible default if no prior sets exist
        if last_weight is None:
            last_weight = {
                ExerciseCategory.COMPOUND: 65.0,
                ExerciseCategory.ISOLATION: 20.0,
                ExerciseCategory.MACHINE: 80.0,
                ExerciseCategory.BODYWEIGHT: 0.0,
            }.get(ex_category, 45.0)
        prescription = ExercisePrescription(
            exercise_name=body.exerciseName,
            category=ex_category,
            planned_sets=planned_sets,
            increment_lbs=max(1.0, body.incrementLbs or 5.0),
            progression_priority=map_progression_priority(goal_type),
            default_start_weight_lbs=last_weight,
        )
        readiness  = ReadinessInput(
            sleep_hours=body.sleepHours,
            energy_1_to_5=body.energy1to5,
            soreness_1_to_5=body.soreness1to5,
            stress_1_to_5=body.stress1to5,
            calories_on_target_recently=body.caloriesOnTargetRecently,
        )
        rec = progression_engine.recommend_next_set(
            profile=profile,
            workout=workout,
            prescription=prescription,
            sets_completed_this_workout=sets_completed,
            readiness=readiness,
            target_rep_override=parse_target_reps(body.targetReps),
        )

        if rec.action.value == "end_exercise":
            return {
                "weightLbs": float(last_weight or 0),
                "reps": 0,
                "tip": f"{body.exerciseName} complete for today.",
                "action": rec.action.value,
                "debug": rec.debug,
            }

        rec_weight = float(rec.recommended_weight_lbs or last_weight or 0)
        rep_min    = int(rec.target_rep_min or 8)
        rep_max    = int(rec.target_rep_max or rep_min)
        rec_reps   = max(1, round((rep_min + rep_max) / 2))

        return {
            "weightLbs": rec_weight,
            "reps": rec_reps,
            "tip": rec.coach_message,
            "action": rec.action.value,
            "repRange": f"{rep_min}-{rep_max}",
            "debug": rec.debug,
        }
    except Exception as e:
        print(f"[BACKEND] recommend-weight error: {e}")
        raise HTTPException(status_code=502, detail=f"Recommendation failed: {str(e)}")


@router.get("/smoke-test")
async def smoke_test(model: str = "gpt-5"):
    """
    Diagnostic endpoint — tests bare chat completions with no structured output.
    GET /ai/smoke-test?model=gpt-5
    Returns {"ok": true, "reply": "..."} or {"ok": false, "error": "..."}
    No auth required so it can be hit with curl quickly.
    """
    api_key = get_openai_api_key()
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY not configured"}
    client = OpenAI(api_key=api_key)
    print(f"[smoke-test] model={model}")
    try:
        response = await asyncio.to_thread(
            lambda: _chat_create(client,
                model=model,
                messages=[
                    {"role": "system", "content": "You are a helpful assistant."},
                    {"role": "user", "content": "Say hello in exactly 5 words."},
                ],
                timeout=30,
            )
        )
        reply = response.choices[0].message.content
        print(f"[smoke-test] OK — reply: {reply!r}")
        return {"ok": True, "model": model, "reply": reply}
    except openai.APIStatusError as e:
        body = getattr(e, 'body', None)
        msg = str(e)
        print(f"[smoke-test] FAIL {e.status_code} — body={body}  str={msg}")
        return {"ok": False, "model": model, "http_status": e.status_code, "error": msg, "body": body}
    except Exception as e:
        print(f"[smoke-test] FAIL {type(e).__name__}: {e}")
        return {"ok": False, "model": model, "error": f"{type(e).__name__}: {e}"}


@router.post("/plans")
async def generate_plans(  # CODE_VERSION=NO_TEMP_2
    req: PlanRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate both workout and nutrition plans in parallel."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    _m = model_plan_generation()
    print(f"[AI /plans] generating both — goal={req.goal}, days={req.daysPerWeek}, model={_m}")
    try:
        workout_data, nutrition_data = await asyncio.gather(
            asyncio.to_thread(_call_workout_ai, client, build_workout_prompt(req), _m, 1400),
            asyncio.to_thread(_call_nutrition_ai, client, build_nutrition_prompt(req), req.foodsAvailable, _m, 3000),
        )
    except (ValueError, Exception) as e:
        detail = str(e)
        print(f"[AI /plans] FAILED — {detail}")
        raise HTTPException(status_code=502, detail=detail)

    result = {
        "trainerNote":      workout_data.get("trainerNote", ""),
        "nutritionistNote": nutrition_data.get("nutritionistNote", ""),
        "supplementStack":  nutrition_data.get("supplementStack", []),
        "workout_plan":     workout_data["workout_plan"],
        "nutrition_plan_a": nutrition_data["nutrition_plan_a"],
        "nutrition_plan_b": nutrition_data["nutrition_plan_b"],
        "nutrition_plan_c": nutrition_data["nutrition_plan_c"],
    }
    try:
        _validate_plans(result, req)
    except ValueError as e:
        print(f"[AI /plans] validation failed — {e}")
        raise HTTPException(status_code=502, detail=f"Plan validation failed: {e}")
    print(f"[AI /plans] done — workout days={len(result['workout_plan'].get('days', []))}")
    return result


@router.post("/plans/workout")
async def generate_workout_plan(
    req: WorkoutOnlyRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate a workout plan only — called when equipment changes."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    # Build a PlanRequest with only workout-relevant fields populated
    plan_req = PlanRequest(
        goal=req.goal,
        secondaryGoal=req.secondaryGoal,
        focusedMuscleGroup=req.focusedMuscleGroup,
        goalDetails=req.goalDetails,
        physicalStats=req.physicalStats,
        daysPerWeek=req.daysPerWeek,
        workoutDurationMinutes=req.workoutDurationMinutes,
        equipment=req.equipment,
        foodsAvailable=[],
        experienceLevel=req.experienceLevel,
        injuriesOrLimitations=req.injuriesOrLimitations,
        userContext=req.userContext,
    )

    client = OpenAI(api_key=api_key)
    _m = model_plan_update()
    print(f"[AI /plans/workout] updating — goal={req.goal}, days={req.daysPerWeek}, equipment={len(req.equipment)}, model={_m}")
    try:
        workout_data = await asyncio.to_thread(_call_workout_ai, client, build_workout_prompt(plan_req), _m, 800)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")

    result = {
        "trainerNote":  workout_data.get("trainerNote", ""),
        "workout_plan": workout_data["workout_plan"],
    }
    print(f"[AI /plans/workout] done — days={len(result['workout_plan'].get('days', []))}, trainerNote={bool(result['trainerNote'])}")
    return result


@router.post("/plans/nutrition")
async def generate_nutrition_plan(
    req: NutritionOnlyRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate a nutrition plan only — called when foods change."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    # Build a PlanRequest with only nutrition-relevant fields populated
    plan_req = PlanRequest(
        goal=req.goal,
        goalDetails=req.goalDetails,
        physicalStats=req.physicalStats,
        daysPerWeek=req.daysPerWeek,
        equipment=[],
        foodsAvailable=req.foodsAvailable,
        supplementsAvailable=req.supplementsAvailable,
        dietaryPreference=req.dietaryPreference,
        allergies=req.allergies,
        mealsPerDay=req.mealsPerDay,
        mealRoutine=req.mealRoutine,
        customMacros=req.customMacros,
        userContext=req.userContext,
    )

    client = OpenAI(api_key=api_key)
    _m = model_plan_update()
    print(f"[AI /plans/nutrition] updating — goal={req.goal}, foods={len(req.foodsAvailable)}, model={_m}")
    try:
        nutrition_data = await asyncio.to_thread(_call_nutrition_ai, client, build_nutrition_prompt(plan_req), req.foodsAvailable, _m, 3500)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")

    result = {
        "nutritionistNote": nutrition_data.get("nutritionistNote", ""),
        "supplementStack":  nutrition_data.get("supplementStack", []),
        "nutrition_plan_a": nutrition_data["nutrition_plan_a"],
        "nutrition_plan_b": nutrition_data["nutrition_plan_b"],
        "nutrition_plan_c": nutrition_data["nutrition_plan_c"],
    }
    print(f"[AI /plans/nutrition] done — nutritionistNote={bool(result['nutritionistNote'])}")
    return result


class ParseWorkoutsRequest(BaseModel):
    """Parse natural language workout descriptions into structured sessions."""
    text: str                   # e.g. "I did legs yesterday and recovery today"
    currentDate: str | None = None   # ISO date, defaults to today on server


@router.post("/parse-workouts")
def parse_recent_workouts(
    body: ParseWorkoutsRequest,
    current_user: User = Depends(get_current_user),
):
    """Parse natural language like 'legs yesterday, recovery today' into WorkoutSession objects."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    today = body.currentDate or __import__("datetime").date.today().isoformat()

    prompt = f"""Parse the user's description of recent workouts into structured session data.
Today's date is {today}.

User said: "{body.text}"

Return a JSON array of workout sessions. For each workout mentioned:
- "date": ISO date string (YYYY-MM-DD). "today" = {today}, "yesterday" = the day before, etc.
- "focus": short description of the workout focus (e.g. "Legs", "Upper Body", "Recovery", "Cardio")
- "completed": true (they did it)
- "durationSeconds": estimated duration in seconds (default 3600 if not mentioned)
- "exercises": array of exercises if mentioned, each with:
  - "name": exercise name
  - "sets": array of completed sets, each with "weightLbs" (number) and "reps" (number)

If the user just says a body part or type (e.g. "legs yesterday"), create the session with an empty exercises array — just log the date and focus.
If they mention specific exercises/weights (e.g. "benched 185 for 3x8"), include those.
If they say "rest day" or "off day", do NOT create a session for that day.

Return ONLY a valid JSON array — no markdown, no explanation:
[
  {{
    "date": "YYYY-MM-DD",
    "focus": "string",
    "completed": true,
    "durationSeconds": 3600,
    "exercises": []
  }}
]

If nothing parseable, return an empty array: []"""

    try:
        resp = client.chat.completions.create(
            model=model_plan_generation(),
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=800,
        )
        raw = resp.choices[0].message.content or "[]"
        data = json.loads(raw)
        # Handle both {"sessions": [...]} and direct array
        sessions = data if isinstance(data, list) else data.get("sessions", data.get("workouts", []))
        print(f"[parse-workouts] parsed {len(sessions)} sessions from: {body.text[:80]}")
        return {"sessions": sessions}
    except Exception as e:
        print(f"[parse-workouts] error: {e}")
        return {"sessions": []}


@router.post("/trainer-question")
def ask_trainer_question(
    body: TrainerQuestionRequest,
    current_user: User = Depends(get_current_user),
):
    """General trainer Q&A with broad plan/profile/progress context."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    q = body.question.strip()
    if len(q) < 6:
        raise HTTPException(status_code=400, detail="Question is too short")

    is_nutritionist = body.mode == "nutritionist"

    # Only send context relevant to this coach's domain — keep payload lean for speed
    profile_slim = body.profile or {}
    # Drop heavy fields from profile context to reduce token count
    if isinstance(profile_slim, dict):
        for drop_key in ("customFoods", "savedMeals", "foodsAvailable", "supplementsAvailable"):
            profile_slim.pop(drop_key, None)
    context_blob: dict = {"profile": profile_slim, "progress": body.progress}
    if is_nutritionist:
        context_blob["nutritionPlan"] = body.nutritionPlan
    else:
        # Slim down workout plan — only send exercise names/sets/reps per day, not full details
        wp = body.workoutPlan
        if isinstance(wp, dict) and "days" in wp:
            slim_days = []
            for d in wp.get("days", []):
                slim_exs = [{"name": e.get("name"), "sets": e.get("sets"), "reps": e.get("reps")} for e in (d.get("exercises") or [])]
                slim_days.append({"day": d.get("day"), "focus": d.get("focus"), "exercises": slim_exs})
            context_blob["workoutPlan"] = {"name": wp.get("name"), "totalDays": wp.get("totalDays"), "days": slim_days}
        else:
            context_blob["workoutPlan"] = wp
    if body.userContext:
        context_blob["recentActivityLog"] = body.userContext[:800]

    # Truncate the serialized context if it's still too large (target ~8k chars)
    context_str = json.dumps(context_blob, ensure_ascii=True)
    if len(context_str) > 8000:
        # Drop workout history from progress to save space
        if isinstance(context_blob.get("progress"), dict):
            context_blob["progress"].pop("recentHistory", None)
            context_blob["progress"].pop("workoutHistory", None)
        context_str = json.dumps(context_blob, ensure_ascii=True)
    if len(context_str) > 8000:
        context_str = context_str[:8000] + '...(truncated)}'
    print(f"[trainer-question] context_str length: {len(context_str)} chars")

    trimmed_convo = (body.conversation or [])[-6:]

    # Schema differs by mode — AI can only update its own side
    if is_nutritionist:
        plan_schema = (
            '  "updated_workout_plan": null,\n'
            '  "updated_nutrition_plan": <full nutrition plan object matching original structure, or null>\n'
        )
        system_prompt = (
            "You are an expert registered dietitian and sports nutritionist. "
            "Give detailed, personalised nutritional advice referencing specific foods, quantities, and macros from their plan. "
            "Use realistic ingredient amounts (e.g. '150g chicken breast', '1 cup cooked oats'). "
            "If the user asks to modify meals, swap foods, change macro targets, or adjust calories/protein/carbs/fat, "
            "set needs_plan_update=true and return the COMPLETE updated nutrition plan. "
            "WHEN UPDATING MACRO TARGETS: update the 'targets' object with the new values, then adjust ALL meals "
            "so their totals actually hit the new targets. Don't just change targets without changing meals. "
            "Preserve isRoutine=true meals exactly as-is. "
            "updated_workout_plan must always be null. Return JSON only."
        )
    else:
        plan_schema = (
            '  "updated_workout_plan": <full workout plan object matching original structure, or null>,\n'
            '  "updated_nutrition_plan": null\n'
        )
        system_prompt = (
            "You are an expert strength and conditioning coach. "
            "You have access to the user's full profile, workout plan, progress history, and activity log. "
            "Give detailed, personalised training advice. Always reference specific exercises, sets, "
            "reps, and weights from their actual plan. "
            "Always check the profile's 'injuries' and 'injuryEntries' fields first — if injuries are present, "
            "remove or substitute any exercises that stress those areas. "
            "If the user asks for plan changes, exercise swaps, or injury modifications, "
            "set needs_plan_update=true and return the COMPLETE updated workout plan "
            "(all days, all exercises — not just the changed ones). "
            "The workout plan uses this exact structure: { name, totalDays, days: [{ day, focus, exercises: [{ name, sets, reps, restSeconds, equipment }] }] }. "
            "Return the full plan in this exact format — do NOT use 'workoutDays' key, use 'days'. "
            "INJURY HANDLING: If the user mentions pain, discomfort, or injury, "
            "and you don't already have enough info (body part, type of pain, when it occurs), "
            "ask ONE clarifying question in your answer and set injury_clarification_needed=true. "
            "Once you have enough info, set updated_injuries with the new/updated entries "
            "(each with id=new UUID or existing id, description, bodyPart, status='active'|'recovering'|'resolved', notes). "
            "When updating injuries, also update the workout plan to avoid the injured area. "
            "If pain/injury red flags are present, advise reducing load and seeing a clinician. "
            "IMPORTANT: updated_nutrition_plan must always be null — you only manage training. "
            "WORKOUT LOGGING: If the user tells you they completed a workout, trained a muscle group, "
            "did cardio, or any physical activity (today or recently), set logged_workouts with session data. "
            "Each entry needs: date (YYYY-MM-DD), focus (e.g. 'Legs', 'Upper Body', 'Cardio'), "
            "durationSeconds (estimate if not stated, default 3600), and exercises array "
            "(each with name and sets [{weightLbs, reps}] if mentioned). "
            "If they just say 'I did legs today' with no details, log it with an empty exercises array. "
            "Do NOT log workouts if the user is just asking about future plans or hypotheticals. "
            "Return JSON only."
        )

    workout_log_schema = (
        '  "logged_workouts": [{"date": "YYYY-MM-DD", "focus": "...", "durationSeconds": 3600, "exercises": [{"name": "...", "sets": [{"weightLbs": 0, "reps": 0}]}]}] or null,\n'
        if not is_nutritionist else
        '  "logged_workouts": null,\n'
    )
    injury_schema = (
        '  "updated_injuries": [{"id": "uuid", "description": "...", "bodyPart": "...", "status": "active|recovering|resolved", "notes": "..."}] or null,\n'
        '  "injury_clarification_needed": true|false\n'
        if not is_nutritionist else
        '  "updated_injuries": null,\n'
        '  "injury_clarification_needed": false\n'
    )

    today_date = __import__("datetime").date.today().isoformat()
    user_text = (
        f"Today's date is {today_date}.\n\n"
        f"Recent conversation (most recent last):\n"
        f"{json.dumps(trimmed_convo, ensure_ascii=True)}\n\n"
        f"User question:\n{q}\n\n"
        f"Context:\n{context_str}\n\n"
        "Return ONLY valid JSON matching this schema exactly - no markdown, no extra text:\n"
        '{\n'
        '  "answer": "Detailed, personalised response to the user",\n'
        '  "action_items": ["specific actionable step 1", "..."],\n'
        '  "needs_plan_update": true|false,\n'
        '  "safety_note": "string or empty string",\n'
        + plan_schema
        + workout_log_schema
        + injury_schema +
        '}\n\n'
        "IMPORTANT: If needs_plan_update is true, you MUST include the complete updated plan object "
        "(not just the changed parts - the full structure). Preserve all unchanged days/meals exactly.\n"
        + (
            "WORKOUT PLAN FORMAT: updated_workout_plan must use this exact structure: "
            '{"name": "...", "totalDays": N, "days": [{"day": "Day 1", "focus": "...", "exercises": [{"name": "...", "sets": N, "reps": "...", "restSeconds": N, "equipment": "..."}]}]}'
            if not is_nutritionist else
            "NUTRITION PLAN FORMAT: updated_nutrition_plan must use this exact structure: "
            '{"targets": {"calories": N, "protein": N, "carbs": N, "fat": N}, '
            '"breakfast": {"meal": "...", "foods": ["..."], "calories": N, "protein": N, "carbs": N, "fat": N, "estimated_alignment": "...", "isRoutine": false}, '
            '"lunch": {...same structure...}, "dinner": {...same structure...}, "snack": {...same structure or omit if no snack...}}. '
            "CRITICAL: When the user asks to change a macro target (e.g. 'set protein to 200g'), "
            "you MUST update the targets object AND recalculate all meal portions to match the new totals."
        )
    )

    # Build user message — use vision format if image is attached
    if body.image_base64:
        user_message = {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{body.mime_type};base64,{body.image_base64}",
                        "detail": "low",
                    },
                },
            ],
        }
    else:
        user_message = {"role": "user", "content": user_text}

    # Debug: log what we're sending
    print(f"[trainer-question] mode={body.mode} question={repr(q[:120])}")
    print(f"[trainer-question] convo_turns={len(trimmed_convo)} has_image={bool(body.image_base64)} has_userContext={bool(body.userContext)}")
    print(f"[trainer-question] context keys: {list(context_blob.keys())}")

    messages = [
        {"role": "system", "content": system_prompt},
        user_message,
    ]

    client = OpenAI(api_key=api_key)
    try:
        _m_fast = model_chat()           # Phase 1: fast model for answer
        _m_full = model_chat_fallback()   # Phase 2: fallback model for plan generation
        print(f"[trainer-question] phase1_model={_m_fast} phase2_model={_m_full}")

        # Phase 1: answer + optional plan in one call.
        # Don't pass json_schema for gpt-5 — the trainer schema has optional/typeless
        # fields (updated_workout_plan: {}) that gpt-5's json_schema mode rejects.
        # Instead, rely on prompt-enforced JSON which works reliably.
        kwargs = _build_chat_kwargs(_m_fast, messages, json_schema=None, max_tokens=2500, timeout_secs=50)
        response = _chat_create(client, **kwargs)
        choice = response.choices[0]
        raw = choice.message.content

        # Debug: dump full response details
        print(f"[trainer-question] phase-1 response: finish_reason={getattr(choice, 'finish_reason', '?')} content_is_none={raw is None} content_len={len(raw) if raw else 0}")
        print(f"[trainer-question] phase-1 message attrs: {[a for a in dir(choice.message) if not a.startswith('_')]}")
        if hasattr(choice.message, 'refusal') and choice.message.refusal:
            print(f"[trainer-question] phase-1 REFUSAL: {choice.message.refusal}")
        if hasattr(choice.message, 'tool_calls') and choice.message.tool_calls:
            print(f"[trainer-question] phase-1 TOOL_CALLS: {choice.message.tool_calls}")

        # Handle None/empty content — can happen with gpt-5 + json_object format
        if not raw:
            refusal = getattr(choice.message, 'refusal', None)
            finish = getattr(choice, 'finish_reason', 'unknown')
            print(f"[trainer-question] phase-1 returned empty! finish_reason={finish} refusal={refusal}")

            # Retry 1: same model, NO response_format (prompt-enforced JSON)
            print(f"[trainer-question] retry-1: {_m_fast} without response_format")
            kwargs_r1 = dict(model=_m_fast, messages=messages, timeout=55, max_tokens=2500, temperature=1)
            if _is_gpt5(_m_fast):
                kwargs_r1["max_completion_tokens"] = kwargs_r1.pop("max_tokens")
            response = client.chat.completions.create(**kwargs_r1)
            raw = response.choices[0].message.content
            print(f"[trainer-question] retry-1 result: len={len(raw) if raw else 0} finish={getattr(response.choices[0], 'finish_reason', '?')}")

        if not raw:
            # Retry 2: fall back to gpt-4o-mini which reliably supports json_object
            _m_fallback = "gpt-4o-mini"
            print(f"[trainer-question] retry-2: falling back to {_m_fallback}")
            kwargs_r2 = _build_chat_kwargs(_m_fallback, messages, json_schema=None, max_tokens=2500, timeout_secs=55)
            response = _chat_create(client, **kwargs_r2)
            raw = response.choices[0].message.content
            print(f"[trainer-question] retry-2 result: len={len(raw) if raw else 0} finish={getattr(response.choices[0], 'finish_reason', '?')}")

        # Still empty after retries — give up gracefully
        if not raw:
            print(f"[trainer-question] still None after retry — returning fallback")
            return {
                "answer": "I received your message but couldn't generate a response. Please try rephrasing or asking again.",
                "action_items": [],
                "needs_plan_update": False,
                "safety_note": "",
                "updated_workout_plan": None,
                "updated_nutrition_plan": None,
                "updated_injuries": None,
                "injury_clarification_needed": False,
            }

        if _looks_truncated(raw):
            print(f"[trainer-question] phase-1 truncated — retrying at 3500 tokens")
            kwargs1b = _build_chat_kwargs(_m_fast, messages, json_schema=None, max_tokens=3500, timeout_secs=60)
            response = _chat_create(client, **kwargs1b)
            raw = response.choices[0].message.content or raw

        result = _extract_json(raw)
        print(f"[trainer-question] phase-1: needs_plan_update={result.get('needs_plan_update')} has_workout={bool(result.get('updated_workout_plan'))} has_nutrition={bool(result.get('updated_nutrition_plan'))} injuries={result.get('updated_injuries')} logged_workouts={len(result.get('logged_workouts') or [])}")

        # Phase 2: if a plan update was signalled but no plan included, do a dedicated plan-generation call
        needs_workout = not is_nutritionist and result.get("needs_plan_update") and not result.get("updated_workout_plan")
        needs_nutrition = is_nutritionist and result.get("needs_plan_update") and not result.get("updated_nutrition_plan")
        if needs_workout or needs_nutrition:
            plan_type = "workout" if needs_workout else "nutrition"
            print(f"[trainer-question] phase-2: generating {plan_type} plan update at 3500 tokens")
            # Build a focused phase-2 message: carry the answer already given, just ask for the plan
            phase2_answer = result.get("answer", "")
            phase2_injuries = result.get("updated_injuries")
            phase2_injury_note = result.get("injury_clarification_needed", False)
            if needs_workout:
                phase2_user = (
                    f"The coach already answered: {json.dumps(phase2_answer)}\n\n"
                    "Now return ONLY a JSON object with the COMPLETE updated_workout_plan. "
                    "Include ALL days and ALL exercises — even unchanged ones. "
                    "Use this exact structure: "
                    '{"name": "...", "totalDays": N, "days": [{"day": "Day 1", "focus": "...", "exercises": [{"name": "...", "sets": N, "reps": "...", "restSeconds": N, "equipment": "..."}]}]}\n'
                    "Return the full JSON response schema with the plan included:\n"
                    '{"answer": ' + json.dumps(phase2_answer) + ', "action_items": [], "needs_plan_update": true, "safety_note": "", '
                    '"updated_workout_plan": <FULL PLAN HERE>, "updated_nutrition_plan": null, '
                    '"updated_injuries": ' + json.dumps(phase2_injuries) + ', "injury_clarification_needed": ' + json.dumps(phase2_injury_note) + '}'
                )
            else:
                phase2_user = (
                    f"The nutritionist already answered: {json.dumps(phase2_answer)}\n\n"
                    "Now return ONLY a JSON object with the COMPLETE updated_nutrition_plan. "
                    "Include ALL meal keys even if unchanged. Preserve all isRoutine=true meals exactly.\n"
                    "Structure: {\"targets\": {\"calories\": N, \"protein\": N, \"carbs\": N, \"fat\": N}, "
                    "\"breakfast\": {\"meal\": \"...\", \"foods\": [\"...\"], \"calories\": N, \"protein\": N, \"carbs\": N, \"fat\": N, \"isRoutine\": bool}, ...}\n"
                    "Return the full JSON response schema with the plan included:\n"
                    '{"answer": ' + json.dumps(phase2_answer) + ', "action_items": [], "needs_plan_update": true, "safety_note": "", '
                    '"updated_workout_plan": null, "updated_nutrition_plan": <FULL PLAN HERE>, '
                    '"updated_injuries": null, "injury_clarification_needed": false}'
                )
            phase2_messages = [
                {"role": "system", "content": system_prompt},
                user_message,
                {"role": "assistant", "content": raw},
                {"role": "user", "content": phase2_user},
            ]
            kwargs2 = _build_chat_kwargs(_m_full, phase2_messages, json_schema=None, max_tokens=3500, timeout_secs=65)
            response2 = _chat_create(client, **kwargs2)
            raw2 = response2.choices[0].message.content
            result2 = _extract_json(raw2)
            # Merge: keep phase-1 answer/action_items/safety_note, take plan from phase-2
            if needs_workout and result2.get("updated_workout_plan"):
                result["updated_workout_plan"] = result2["updated_workout_plan"]
                print(f"[trainer-question] phase-2: workout plan keys={list(result2['updated_workout_plan'].keys()) if isinstance(result2['updated_workout_plan'], dict) else 'non-dict'}")
            elif needs_nutrition and result2.get("updated_nutrition_plan"):
                result["updated_nutrition_plan"] = result2["updated_nutrition_plan"]
            # Pick up any injury updates from phase-2 if phase-1 didn't have them
            if not result.get("updated_injuries") and result2.get("updated_injuries"):
                result["updated_injuries"] = result2["updated_injuries"]

        print(f"[trainer-question] final: needs_plan_update={result.get('needs_plan_update')} has_workout={bool(result.get('updated_workout_plan'))} has_nutrition={bool(result.get('updated_nutrition_plan'))} injuries={result.get('updated_injuries')}")
        print(f"[trainer-question] answer preview: {repr(result.get('answer', '')[:200])}")
        return result
    except json.JSONDecodeError as e:
        print(f"[trainer-question] JSON decode error: {e}")
        print(f"[trainer-question] raw content: {repr(raw[:500]) if raw else 'None'}")
        # Return a graceful fallback so the chat doesn't break
        return {
            "answer": "I'm sorry, I had trouble processing that response. Could you try rephrasing your question?",
            "action_items": [],
            "needs_plan_update": False,
            "safety_note": "",
            "updated_workout_plan": None,
            "updated_nutrition_plan": None,
            "updated_injuries": None,
            "injury_clarification_needed": False,
        }
    except Exception as e:
        print(f"[trainer-question] Exception: {e}")
        raise HTTPException(status_code=502, detail=f"Trainer question failed: {str(e)}")


@router.post("/workout-question")
def ask_workout_question(
    body: WorkoutCoachQuestionRequest,
    current_user: User = Depends(get_current_user),
):
    """Workout-session scoped coach Q&A focused on form, pain flags, and execution cues."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    q = body.question.strip()
    if len(q) < 4:
        raise HTTPException(status_code=400, detail="Question is too short")

    context_blob = {
        "workout": body.workout,
        "activeExerciseName": body.activeExerciseName,
        "currentSetNumber": body.currentSetNumber,
        "loggedSets": body.loggedSets or [],
    }

    _wq_messages = [
        {
            "role": "system",
            "content": (
                "You are an in-workout coach. Scope is limited to form cues, muscle targeting cues, "
                "load/rep adjustment, pain/injury caution, and immediate substitutions. "
                "If the user asks unrelated nutrition/lifestyle topics, reply briefly and suggest "
                "using Ask Trainer from Home for broader planning. Return JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Workout question:\n{q}\n\n"
                f"Context JSON:\n{json.dumps(context_blob, ensure_ascii=True)}\n\n"
                'Return this JSON schema exactly: '
                '{"answer": string, "quick_cues": [string], "adjustment": string, "safety_note": string}'
            ),
        },
    ]
    client = OpenAI(api_key=api_key)
    try:
        kwargs = _build_chat_kwargs(model_chat(), _wq_messages, json_schema=SCHEMA_WORKOUT_QUESTION, max_tokens=300, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Workout question failed: {str(e)}")


@router.post("/food-photo")
def analyze_food_photo(
    body: FoodPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Estimate meal contents and macros from a food photo."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    _fp_messages = [
        {
            "role": "system",
            "content": (
                "You are a nutrition coach analyzing meal photos. Estimate likely meal contents and macros. "
                "Use practical ranges but return a single best estimate. Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Analyze this meal photo. Identify likely foods in plain English, "
                        "estimate total macros and micronutrients, and provide a short meal name. "
                        'Return exactly this JSON schema: '
                        '{"meal_name": string, "items": [string], "calories": number, '
                        '"protein": number, "carbs": number, "fat": number, "fiber": number, '
                        '"micronutrients": {"fiber": number, "sugar": number, "sodium": number, '
                        '"cholesterol": number, "vitaminA": number, "vitaminC": number, '
                        '"vitaminD": number, "calcium": number, "iron": number, "potassium": number}}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _fp_messages, json_schema=SCHEMA_FOOD_PHOTO, max_tokens=200, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Food photo analysis failed: {str(e)}")


@router.post("/scan-foods")
def scan_foods_photo(
    body: ScanFoodsRequest,
    current_user: User = Depends(get_current_user),
):
    """Identify multiple individual food items from one or more photos, each with macros per serving."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.images:
        raise HTTPException(status_code=400, detail="At least one image is required")

    client = OpenAI(api_key=api_key)

    context_hint = f"\nExtra context from the user: {body.context}" if body.context else ""

    # Build content blocks: text prompt first, then all images
    user_content: list[dict] = [
        {
            "type": "text",
            "text": (
                f"List every individual food item you can identify across all provided image(s). "
                "For each one, provide a short common name, typical serving size, and estimated macros. "
                f"{context_hint}"
                "Return exactly this JSON schema — no extra text: "
                '{"foods": [{"name": string, "serving": string, "calories": number, '
                '"protein": number, "carbs": number, "fat": number, "fiber": number}]}'
            ),
        }
    ]
    for img in body.images:
        image_data_url = f"data:{img.mime_type};base64,{img.image_base64}"
        user_content.append({"type": "image_url", "image_url": {"url": image_data_url}})

    _sf_messages = [
        {
            "role": "system",
            "content": (
                "You are a nutrition expert. Identify every distinct food item visible in the image(s). "
                "For each item, estimate its name, a typical serving size, and macros per that serving. "
                "Return valid JSON only."
            ),
        },
        {"role": "user", "content": user_content},
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _sf_messages, json_schema=SCHEMA_SCAN_FOODS, max_tokens=500, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Food scan failed: {str(e)}")


@router.post("/supplement-info")
def get_supplement_info(
    body: SupplementLookupRequest,
    current_user: User = Depends(get_current_user),
):
    """Look up evidence-based info for any supplement by name."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="Supplement name is required")

    _si_messages = [
        {
            "role": "system",
            "content": (
                "You are a sports nutrition expert with deep knowledge of supplements, "
                "their mechanisms, evidence base, and safe use. Always respond with valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f'Look up this supplement: "{body.name.strip()}"\n\n'
                "If it is a real, recognized supplement or ingredient, return a JSON object with:\n"
                '- "found": true\n'
                '- "name": canonical common name\n'
                '- "category": one of "Protein", "Performance", "Recovery", "Health", "Weight Management", "Sleep & Stress", "Other"\n'
                '- "tagline": one short sentence\n'
                '- "whatItDoes": 2-3 sentences on mechanism and benefits\n'
                '- "evidence": one of "strong", "moderate", or "limited"\n'
                '- "dose": typical effective dose with unit (e.g. "5g daily")\n'
                '- "timing": when to take it\n'
                '- "goodFor": array of 1-4 strings from: "Strength", "Muscle gain", "Fat loss", "Endurance", "Recovery", "General health", "Athletic performance", "Sleep"\n'
                '- "cautions": 1-2 sentences on side effects or who should avoid it\n\n'
                'If not a real supplement, return {"found": false, "name": "' + body.name.strip() + '"}'
            ),
        },
    ]
    client = OpenAI(api_key=api_key)
    try:
        kwargs = _build_chat_kwargs(model_chat(), _si_messages, json_schema=SCHEMA_SUPPLEMENT_INFO, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Supplement lookup failed: {str(e)}")


@router.post("/supplement-photo")
def get_supplement_from_photo(
    body: SupplementPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Identify a supplement from a photo of its label/packaging and return evidence-based info."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"

    _sp_messages = [
        {
            "role": "system",
            "content": (
                "You are a sports nutrition expert. Identify supplements from photos of labels, "
                "packaging, or pills, then provide evidence-based information. "
                "Always respond with valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "Identify the supplement shown in this image. "
                        'If you can identify it, return {"found": true, "name": ..., "category": ..., '
                        '"tagline": ..., "whatItDoes": ..., "evidence": ..., "dose": ..., "timing": ..., '
                        '"goodFor": [...], "cautions": ...}. '
                        'If you cannot identify it, return {"found": false, "name": ""}.'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _sp_messages, json_schema=SCHEMA_SUPPLEMENT_INFO, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Supplement photo lookup failed: {str(e)}")


@router.post("/scan-equipment")
def scan_equipment_photo(
    body: FoodPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Identify gym equipment visible in a photo and return names matching the app's equipment library."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    known_equipment = [
        "Pull-up bar", "Resistance bands", "Yoga mat", "Jump rope", "Foam roller",
        "Ab wheel", "Dip bars", "Suspension trainer",
        "Dumbbells", "Barbell", "Kettlebell", "EZ curl bar", "Weight plates",
        "Trap bar", "Medicine ball",
        "Flat bench", "Adjustable bench", "Incline bench",
        "Squat rack", "Power rack", "Landmine attachment",
        "Cable machine", "Leg press", "Lat pulldown", "Chest press machine",
        "Seated row machine", "Leg extension", "Leg curl machine",
        "Shoulder press machine", "Hip abduction machine", "Hip adduction machine",
        "Smith machine", "Hack squat machine", "Assisted pull-up machine",
        "Treadmill", "Stationary bike", "Elliptical", "Rowing machine",
        "Stair climber", "Assault bike", "Swimming pool", "Battle ropes",
        "Plyo box", "Sled",
    ]

    _eq_messages = [
        {
            "role": "system",
            "content": (
                "You are a fitness equipment expert. Identify gym equipment visible in the image. "
                "Only return equipment names that exactly match items in the provided list. "
                "Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Identify all gym equipment visible in this image. "
                        f"Only include items whose names exactly match something in this list: {known_equipment}. "
                        'Return exactly this JSON: {"equipment": [<array of matching equipment name strings>]}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), _eq_messages, json_schema=SCHEMA_SCAN_EQUIPMENT, max_tokens=150, timeout_secs=20)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Equipment scan failed: {str(e)}")


class WorkoutSummaryRequest(BaseModel):
    exercises: list[dict]
    durationSeconds: int
    focus: str
    goal: str
    weightLbs: float = 150.0


@router.post("/workout-summary")
def generate_workout_summary(
    body: WorkoutSummaryRequest,
    current_user: User = Depends(get_current_user),
):
    """AI post-workout summary: calories burned, achievements, and personalised recommendations."""
    weight_kg      = body.weightLbs / 2.205
    duration_hours = body.durationSeconds / 3600

    focus_lower = body.focus.lower()
    if any(kw in focus_lower for kw in ["cardio", "run", "cycle", "hiit", "conditioning"]):
        met = 8.0
    elif any(kw in focus_lower for kw in ["strength", "power", "heavy"]):
        met = 6.5
    else:
        met = 5.5

    calories_burned = max(1, round(met * weight_kg * duration_hours))

    total_sets     = sum(len(ex.get("sets", [])) for ex in body.exercises)
    exercises_done = sum(1 for ex in body.exercises if len(ex.get("sets", [])) > 0)
    achievements: list[str] = []
    for ex in body.exercises:
        sets = ex.get("sets", [])
        if sets:
            best   = max(sets, key=lambda s: s.get("weightLbs", 0) * s.get("reps", 0))
            weight = best.get("weightLbs", 0)
            reps   = best.get("reps", 0)
            if weight > 0:
                achievements.append(f"{ex['name']}: {weight} lbs × {reps} reps")

    api_key = get_openai_api_key()
    if not api_key:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Solid effort — every set counts toward your goal. Keep showing up!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours for optimal recovery.",
                "Hydrate well — aim for at least 16 oz of water post-workout.",
                "Sleep 7–9 hours tonight to lock in the gains from this session.",
            ],
        }

    client = OpenAI(api_key=api_key)
    try:
        prompt = (
            f"Post-workout summary request:\n"
            f"- Focus: {body.focus}\n"
            f"- Goal: {body.goal}\n"
            f"- Duration: {body.durationSeconds // 60} min\n"
            f"- Exercises completed: {exercises_done}\n"
            f"- Total sets logged: {total_sets}\n"
            f"- Estimated calories burned: {calories_burned}\n"
            f"- Best sets: {'; '.join(achievements[:4]) or 'none logged'}\n\n"
            "Write a short, energetic post-workout message and 3 concrete recovery/nutrition tips.\n"
            'Return JSON: {"motivationMessage": string, "recommendations": [string, string, string]}'
        )
        _ws_messages = [
            {"role": "system", "content": "You are an upbeat fitness coach. Give brief, practical post-workout feedback. Return JSON only."},
            {"role": "user", "content": prompt},
        ]
        kwargs = _build_chat_kwargs(model_chat(), _ws_messages, json_schema=SCHEMA_WORKOUT_SUMMARY, max_tokens=300, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        ai = _extract_json(response.choices[0].message.content)
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": ai.get("motivationMessage", "Great work today!"),
            "achievements": achievements[:4],
            "recommendations": ai.get("recommendations", []),
        }
    except Exception:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Strong session — consistency is the key to progress!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours.",
                "Hydrate well post-workout.",
                "Aim for 7–9 hours of sleep tonight.",
            ],
        }


@router.post("/form-photo")
def analyze_form_photo(
    body: FormPhotoRequest,
    current_user: User = Depends(get_current_user),
):
    """Analyze a form photo for quick coaching cues."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    _form_messages = [
        {
            "role": "system",
            "content": (
                "You are a workout form coach analyzing a single exercise photo. "
                "Provide practical setup/posture cues, likely muscle targeting notes, and obvious red flags. "
                "Do not pretend to diagnose injury from one image. Return JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"Exercise: {body.exercise_name or 'unknown'}\n"
                        f"User concern: {body.question or 'General form check'}\n\n"
                        "Analyze this form photo. Return exactly this JSON schema: "
                        '{"answer": string, "quick_cues": [string], "likely_target": string, '
                        '"red_flags": [string], "safety_note": string}'
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_chat(), _form_messages, json_schema=SCHEMA_FORM_PHOTO, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        return _extract_json(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Form photo analysis failed: {str(e)}")


@router.post("/body-scan")
def body_scan(
    body: BodyScanRequest,
    current_user: User = Depends(get_current_user),
):
    """Estimate body composition from a photo using AI vision."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")
    if not body.image_base64:
        raise HTTPException(status_code=400, detail="image_base64 is required")

    image_data_url = f"data:{body.mime_type};base64,{body.image_base64}"
    client = OpenAI(api_key=api_key)

    context_lines = []
    if body.gender:
        context_lines.append(f"Gender: {body.gender}")
    if body.weight_lbs:
        context_lines.append(f"Weight: {body.weight_lbs} lbs")
    if body.height_inches:
        feet = int(body.height_inches // 12)
        inches = int(body.height_inches % 12)
        context_lines.append(f"Height: {feet}'{inches}\"")
    if body.age:
        context_lines.append(f"Age: {body.age}")
    context_str = "\n".join(context_lines) if context_lines else "No additional info provided."

    _scan_messages = [
        {
            "role": "system",
            "content": (
                "You are an expert physique analyst and certified personal trainer. "
                "Analyze the provided photo to estimate body composition. "
                "Be honest but encouraging. This is an ESTIMATE — always include a disclaimer. "
                "Return JSON only."
            ),
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"User info:\n{context_str}\n\n"
                        "Analyze this physique photo. Estimate body composition and provide feedback.\n\n"
                        "Return exactly this JSON:\n"
                        "{\n"
                        '  "bodyFatPct": number (estimated body fat percentage, e.g. 18.5),\n'
                        '  "bodyFatRange": string (e.g. "17-20%"),\n'
                        '  "muscleMass": string (one of: "low", "below_average", "average", "above_average", "high"),\n'
                        '  "category": string (e.g. "Athletic", "Lean", "Average", "Overweight"),\n'
                        '  "strengths": [string] (2-3 visible strong points),\n'
                        '  "improvements": [string] (2-3 areas to work on),\n'
                        '  "assessment": string (2-3 sentence overall assessment, encouraging tone),\n'
                        '  "disclaimer": string (brief note that this is a visual estimate)\n'
                        "}"
                    ),
                },
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_chat(), _scan_messages, json_schema=None, max_tokens=500, timeout_secs=40)
        response = _chat_create(client, **kwargs)
        result = _extract_json(response.choices[0].message.content)
        return result
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Body scan failed: {str(e)}")
