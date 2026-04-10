from __future__ import annotations

import asyncio
import json
import math
import os
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
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


def get_openai_model() -> str:
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini")


def get_openai_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY")


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


class PlanRequest(BaseModel):
    """Full plan generation — both workout and nutrition."""
    goal: str
    secondaryGoal: str | None = None
    focusedMuscleGroup: str | None = None
    goalDetails: GoalDetailsIn
    physicalStats: PhysicalStatsIn
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
    userContext: str | None = None


class WorkoutOnlyRequest(BaseModel):
    """Workout-only plan generation — no food/nutrition fields."""
    goal: str
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

    foodsAvailable: list[str]
    supplementsAvailable: list[str] = []
    dietaryPreference: str | None = None
    allergies: list[str] = []
    mealsPerDay: int = 3
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


progression_engine = WorkoutProgressionEngine()


# ─── Deterministic recommendation helpers (unchanged) ────────────────────────

def map_goal_type(goal: str) -> GoalType:
    g = (goal or "").lower().strip()
    if g == "strength":
        return GoalType.STRENGTH
    if g in {"fat_loss", "toning"}:
        return GoalType.FAT_LOSS
    if g in {"maintain", "flexibility", "stress_relief"}:
        return GoalType.MAINTAIN
    if g == "endurance":
        return GoalType.ENDURANCE
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
    if any(x in name for x in ["machine", "cable", "leg press", "pulldown", "row machine"]):
        return ExerciseCategory.MACHINE
    if any(x in name for x in ["push up", "pull up", "plank", "dip", "bodyweight"]):
        return ExerciseCategory.BODYWEIGHT
    if any(x in name for x in ["curl", "extension", "raise", "fly", "kickback", "lateral"]):
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

    # ── Try target-weight / timeline path first ──────────────────────────────
    target_lbs = req.goalDetails.targetWeightLbs
    timeline_wk = req.goalDetails.timelineWeeks

    if target_lbs is not None and timeline_wk is not None and timeline_wk > 0:
        raw_delta_lbs = target_lbs - ps.weightLbs          # positive = gain, negative = loss
        raw_rate = raw_delta_lbs / timeline_wk              # lbs/week

        # Clamp per goal direction
        if goal in {"fat_loss", "toning"}:
            clamped_rate = max(-_MAX_LOSS_RATE, min(raw_rate, 0.0))
        elif goal in {"muscle_gain"}:
            clamped_rate = max(0.0, min(raw_rate, _MAX_GAIN_RATE))
        elif goal in {"body_recomp", "maintain"}:
            clamped_rate = max(-0.25, min(raw_rate, 0.25))   # near-maintenance band
        elif goal in {"strength"}:
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
        pace_adjustments: dict[str, dict[str, int]] = {
            "fat_loss":             {"conservative": -250, "moderate": -500, "aggressive": -750},
            "toning":               {"conservative": -200, "moderate": -350, "aggressive": -500},
            "muscle_gain":          {"conservative":  150, "moderate":  300, "aggressive":  500},
            "body_recomp":          {"conservative": -100, "moderate":    0, "aggressive":  100},
            "strength":             {"conservative":  200, "moderate":  350, "aggressive":  500},
            "endurance":            {"conservative":  100, "moderate":  200, "aggressive":  300},
            "athletic_performance": {"conservative":  150, "moderate":  250, "aggressive":  400},
        }
        daily_adjustment = pace_adjustments.get(goal, {}).get(pace, 0)
        pace_label = {"conservative": "slow", "moderate": "moderate", "aggressive": "fast"}.get(pace, pace)
        goal_rate_summary = f"Using {pace_label} pace adjustment ({daily_adjustment:+d} cal/day from TDEE)."

    calories = max(_MIN_CALORIES, tdee + daily_adjustment)

    # ── Protein (g/lb bodyweight, goal-specific) ─────────────────────────────
    if goal in {"muscle_gain", "body_recomp", "strength", "toning"}:
        protein_per_lb = 1.0
    elif goal == "fat_loss":
        protein_per_lb = 0.9
    elif goal == "endurance":
        protein_per_lb = 0.8
    else:  # maintain, flexibility, stress_relief, athletic_performance, etc.
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
            f'      "estimated_alignment": "e.g. high protein, moderate carb"\n'
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
    if req.secondaryGoal and req.secondaryGoal != req.goal:
        secondary_rule = goal_workout_rules.get(req.secondaryGoal, "")
        goal_rule = (
            f"PRIMARY GOAL: {primary_rule}\n"
            f"SECONDARY GOAL (blend into programming where possible): {secondary_rule}"
        )
    else:
        goal_rule = primary_rule
    focused_muscle_line = (
        f"FOCUSED MUSCLE GROUP: The user wants to emphasise {req.focusedMuscleGroup} — "
        f"include at least one dedicated {req.focusedMuscleGroup} session per week and "
        f"prioritise {req.focusedMuscleGroup} volume across the plan."
        if req.focusedMuscleGroup else ""
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
- Primary goal: {req.goal} (pace: {req.goalDetails.pace}){f"  |  Secondary goal: {req.secondaryGoal}" if req.secondaryGoal else ""}
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
{f"Recent history:{chr(10)}{req.userContext}" if req.userContext else ""}

GOAL RULE (follow strictly): {goal_rule}
{focused_muscle_line}

INSTRUCTIONS:
- Provide exactly {req.daysPerWeek} training day objects.
- Each exercise: sets (int), reps (string e.g. "8-10"), restSeconds (int), equipment (string).
- Sessions should fill ~{req.workoutDurationMinutes} minutes (roughly 8 min per exercise slot).
- ONLY use exercises requiring equipment from the available list.
- If an exercise library is provided, use ONLY exercises from that list.
- If recent workout history is provided, check which muscles were trained in the last 1-2 days and give them adequate recovery — do not schedule the same primary muscle group within 48 hours.

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

    return f"""You are a registered dietitian.
Generate a personalised daily nutrition plan for this user.

USER PROFILE:
- Goal: {req.goal} (pace: {req.goalDetails.pace})
- Age: {ps.age}  Gender: {ps.gender}  Weight: {ps.weightLbs} lbs  Height: {height_str}
- Calorie strategy: {t['goal_rate_summary']}

STRICT FOOD CONSTRAINT — THIS IS NON-NEGOTIABLE:
The user's ONLY available foods are: {foods_str}

Every single ingredient in every meal MUST come from this list and nowhere else.
Do NOT add any food that is not in this list — not as a variation, not as a substitution, not as a garnish.
If a food is not on the list above, it does not exist for this user. Do not use it.

Supplements user already takes: {supps_str if supps_str else "none — recommend best for goal"}
{diet_context}
Meals per day: {t['meals']}

DAILY TARGETS (include these exactly in "targets"):
{t['calories']} cal / {t['protein']}g protein / {t['carbs']}g carbs / {t['fat']}g fat
Per-meal approximate targets (reference only):
{meal_summary}

INSTRUCTIONS:
- Every ingredient must be from the available foods list above — no exceptions.
- For each meal: recipe name and ingredient list with amounts.
- Add "estimated_alignment" field (e.g. "high protein, moderate carb").
- supplementStack: 2-4 evidence-based supplements. Prioritise from user's existing list, add critical missing ones.

Return ONLY valid JSON matching this schema exactly:
{{
  "nutritionistNote": "60-80 word explanation of calorie target, macro split, and food choices for this user.",
  "nutrition_plan": {{
    "targets": {{
      "calories": {t['calories']},
      "protein": {t['protein']},
      "carbs": {t['carbs']},
      "fat": {t['fat']}
    }},
    "supplementStack": [
      {{"name": "string", "dose": "string", "timing": "string", "purpose": "string"}}
    ],
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

def _call_workout_ai(client: OpenAI, prompt: str) -> dict:
    """Synchronous OpenAI call for the workout plan (run in a thread)."""
    last_error: Exception | None = None
    for attempt in range(1, 3):
        try:
            response = client.chat.completions.create(
                model=get_openai_model(),
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "You are an expert fitness coach. Always respond with valid JSON only — no markdown, no extra text."},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.7,
                timeout=100,
            )
            data = json.loads(response.choices[0].message.content)
            if not data.get("workout_plan") or not data["workout_plan"].get("days"):
                raise ValueError("workout_plan missing or has no days")
            print(f"[AI /plans workout] attempt {attempt} OK — {len(data['workout_plan']['days'])} days, trainerNote: {bool(data.get('trainerNote'))}")
            return data
        except json.JSONDecodeError as e:
            last_error = ValueError(f"invalid JSON attempt {attempt}: {e}")
        except ValueError as e:
            last_error = e
            print(f"[AI /plans workout] attempt {attempt} failed: {e}")
        except Exception as e:
            raise
    raise ValueError(f"Workout generation failed after 2 attempts: {last_error}")


def _check_food_violations(nutrition_plan: dict, allowed_foods: list[str]) -> list[str]:
    """
    Return a list of food strings that appear in the plan but are NOT covered
    by the allowed_foods list.  A food item is 'covered' if at least one allowed
    food name is a case-insensitive substring of the ingredient string.
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
            item_lower = str(food_item).lower()
            # Strip quantities like "150g ", "2 tbsp " before checking
            # covered = at least one allowed food is a substring of the item
            if not any(a in item_lower for a in allowed_lower):
                violations.append(food_item)
    return violations


def _call_nutrition_ai(client: OpenAI, prompt: str, allowed_foods: list[str] | None = None) -> dict:
    """Synchronous OpenAI call for the nutrition plan (run in a thread)."""
    last_error: Exception | None = None
    violation_note = ""
    for attempt in range(1, 4):  # up to 3 attempts
        try:
            full_prompt = prompt + violation_note
            response = client.chat.completions.create(
                model=get_openai_model(),
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": "You are a registered dietitian. Always respond with valid JSON only — no markdown, no extra text."},
                    {"role": "user", "content": full_prompt},
                ],
                temperature=0.7,
                timeout=100,
            )
            data = json.loads(response.choices[0].message.content)
            np_ = data.get("nutrition_plan", {})
            if not np_.get("targets"):
                raise ValueError("nutrition_plan missing targets")
            meal_keys_set = {"breakfast", "lunch", "dinner", "snack"}
            if not any(k in np_ for k in meal_keys_set):
                raise ValueError("nutrition_plan has no meal entries")

            # Food constraint check — reject and retry if forbidden foods used
            if allowed_foods:
                violations = _check_food_violations(np_, allowed_foods)
                if violations:
                    unique_v = list(dict.fromkeys(violations))[:10]
                    violation_note = (
                        f"\n\nPREVIOUS ATTEMPT VIOLATION — the following ingredients are NOT in the user's food list "
                        f"and must be replaced immediately: {', '.join(unique_v)}.\n"
                        f"Use ONLY foods from the list provided. Every single ingredient must be from that list. "
                        f"Do not include any other foods under any circumstances."
                    )
                    raise ValueError(f"Forbidden foods used: {unique_v}")

            print(f"[AI /plans nutrition] attempt {attempt} OK — nutritionistNote: {bool(data.get('nutritionistNote'))}")
            return data
        except json.JSONDecodeError as e:
            last_error = ValueError(f"invalid JSON attempt {attempt}: {e}")
        except ValueError as e:
            last_error = e
            print(f"[AI /plans nutrition] attempt {attempt} failed: {e}")
        except Exception as e:
            raise
    raise ValueError(f"Nutrition generation failed after {attempt} attempts: {last_error}")


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
        prescription = ExercisePrescription(
            exercise_name=body.exerciseName,
            category=infer_exercise_category(body.exerciseName),
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


@router.post("/plans")
async def generate_plans(
    req: PlanRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate both workout and nutrition plans in parallel."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    print(f"[AI /plans] generating both — goal={req.goal}, days={req.daysPerWeek}")
    try:
        workout_data, nutrition_data = await asyncio.gather(
            asyncio.to_thread(_call_workout_ai, client, build_workout_prompt(req)),
            asyncio.to_thread(_call_nutrition_ai, client, build_nutrition_prompt(req), req.foodsAvailable),
        )
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")

    result = {
        "trainerNote":      workout_data.get("trainerNote", ""),
        "nutritionistNote": nutrition_data.get("nutritionistNote", ""),
        "workout_plan":     workout_data["workout_plan"],
        "nutrition_plan":   nutrition_data["nutrition_plan"],
    }
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
    print(f"[AI /plans/workout] generating — goal={req.goal}, days={req.daysPerWeek}, equipment={len(req.equipment)}")
    try:
        workout_data = await asyncio.to_thread(_call_workout_ai, client, build_workout_prompt(plan_req))
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
        userContext=req.userContext,
    )

    client = OpenAI(api_key=api_key)
    print(f"[AI /plans/nutrition] generating — goal={req.goal}, foods={len(req.foodsAvailable)}")
    try:
        nutrition_data = await asyncio.to_thread(_call_nutrition_ai, client, build_nutrition_prompt(plan_req), req.foodsAvailable)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")

    result = {
        "nutritionistNote": nutrition_data.get("nutritionistNote", ""),
        "nutrition_plan":   nutrition_data["nutrition_plan"],
    }
    print(f"[AI /plans/nutrition] done — nutritionistNote={bool(result['nutritionistNote'])}")
    return result


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

    # Only send context relevant to this coach's domain
    context_blob: dict = {"profile": body.profile, "progress": body.progress}
    if is_nutritionist:
        context_blob["nutritionPlan"] = body.nutritionPlan
    else:
        context_blob["workoutPlan"] = body.workoutPlan
    if body.userContext:
        context_blob["recentActivityLog"] = body.userContext

    trimmed_convo = (body.conversation or [])[-14:]

    # Schema differs by mode — AI can only update its own side
    if is_nutritionist:
        plan_schema = (
            '  "updated_workout_plan": null,\n'
            '  "updated_nutrition_plan": <full nutrition plan object matching original structure, or null>\n'
        )
        system_prompt = (
            "You are an expert registered dietitian and sports nutritionist. "
            "You have access to the user's full profile, nutrition plan, and activity log. "
            "Give detailed, personalised nutritional advice. Always reference specific foods, quantities, "
            "and macros from their actual plan. When updating the nutrition plan, include realistic "
            "ingredient amounts (e.g. '150g chicken breast', '1 cup cooked oats', '2 tbsp peanut butter'). "
            "If the user asks to modify meals, swap foods, or change targets, set needs_plan_update=true "
            "and return the COMPLETE updated nutrition plan (full structure, not partial). "
            "Never return a partial plan — always include all meal keys even if unchanged. "
            "IMPORTANT: updated_workout_plan must always be null — you only manage nutrition. "
            "Return JSON only."
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
            "Always check the profile's 'injuries' field first — if injuries are present, "
            "remove or substitute any exercises that stress those areas. "
            "If the user asks for plan changes, exercise swaps, or injury modifications, "
            "set needs_plan_update=true and return the COMPLETE updated workout plan "
            "(all days, all exercises — not just the changed ones). "
            "If pain/injury red flags are present, advise reducing load and seeing a clinician. "
            "IMPORTANT: updated_nutrition_plan must always be null — you only manage training. "
            "Return JSON only."
        )

    user_text = (
        f"Recent conversation (most recent last):\n"
        f"{json.dumps(trimmed_convo, ensure_ascii=True)}\n\n"
        f"User question:\n{q}\n\n"
        f"Full context JSON:\n{json.dumps(context_blob, ensure_ascii=True)}\n\n"
        "Return ONLY valid JSON matching this schema exactly - no markdown, no extra text:\n"
        '{\n'
        '  "answer": "Detailed, personalised response to the user",\n'
        '  "action_items": ["specific actionable step 1", "..."],\n'
        '  "needs_plan_update": true|false,\n'
        '  "safety_note": "string or empty string",\n'
        + plan_schema +
        '}\n\n'
        "IMPORTANT: If needs_plan_update is true, you MUST include the complete updated plan object "
        "(not just the changed parts - the full structure). Preserve all unchanged days/meals exactly."
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

    client = OpenAI(api_key=api_key)
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                user_message,
            ],
            temperature=0.4,
            max_tokens=4000,  # enough for a full updated plan
        )
        raw = response.choices[0].message.content
        result = json.loads(raw)

        # Debug: log what we're returning
        print(f"[trainer-question] needs_plan_update={result.get('needs_plan_update')} has_workout_update={bool(result.get('updated_workout_plan'))} has_nutrition_update={bool(result.get('updated_nutrition_plan'))}")
        print(f"[trainer-question] answer preview: {repr(result.get('answer', '')[:200])}")
        if result.get('updated_workout_plan'):
            wp = result['updated_workout_plan']
            print(f"[trainer-question] updated_workout_plan keys: {list(wp.keys()) if isinstance(wp, dict) else 'NOT A DICT'}")
        if result.get('updated_nutrition_plan'):
            np_ = result['updated_nutrition_plan']
            print(f"[trainer-question] updated_nutrition_plan keys: {list(np_.keys()) if isinstance(np_, dict) else 'NOT A DICT'}")

        return result
    except json.JSONDecodeError as e:
        print(f"[trainer-question] JSON decode error: {e}")
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
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

    client = OpenAI(api_key=api_key)
    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
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
                        "Workout question:\n"
                        f"{q}\n\n"
                        "Context JSON:\n"
                        f"{json.dumps(context_blob, ensure_ascii=True)}\n\n"
                        "Return this JSON schema exactly:\n"
                        '{"answer": string, "quick_cues": [string], "adjustment": string, "safety_note": string}'
                    ),
                },
            ],
            temperature=0.3,
            max_tokens=350,
        )
        return json.loads(response.choices[0].message.content)
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

    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
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
                                "estimate total macros, and provide a short meal name. "
                                'Return exactly this JSON schema: '
                                '{"meal_name": string, "items": [string], "calories": number, '
                                '"protein": number, "carbs": number, "fat": number}'
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                },
            ],
            temperature=0.2,
            max_tokens=300,
        )
        return json.loads(response.choices[0].message.content)
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
                '"protein": number, "carbs": number, "fat": number}]}'
            ),
        }
    ]
    for img in body.images:
        image_data_url = f"data:{img.mime_type};base64,{img.image_base64}"
        user_content.append({"type": "image_url", "image_url": {"url": image_data_url}})

    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a nutrition expert. Identify every distinct food item visible in the image(s). "
                        "For each item, estimate its name, a typical serving size, and macros per that serving. "
                        "Return valid JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": user_content,
                },
            ],
            temperature=0.2,
        )
        return json.loads(response.choices[0].message.content)
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

    client = OpenAI(api_key=api_key)
    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a sports nutrition expert with deep knowledge of supplements, "
                        "their mechanisms, evidence base, and safe use. "
                        "Always respond with valid JSON only."
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
                        '- "tagline": one short sentence describing what it is\n'
                        '- "whatItDoes": 2-3 sentences on mechanism and benefits\n'
                        '- "evidence": one of "strong", "moderate", or "limited" based on the research base\n'
                        '- "dose": typical effective dose with unit (e.g. "5g daily")\n'
                        '- "timing": when to take it (e.g. "Post-workout or anytime")\n'
                        '- "goodFor": array of 1-4 strings from: "Strength", "Muscle gain", "Fat loss", "Endurance", "Recovery", "General health", "Athletic performance", "Sleep"\n'
                        '- "cautions": 1-2 sentences on side effects, interactions, or who should avoid it\n\n'
                        'If not a real supplement or completely unrecognized, return {"found": false, "name": "' + body.name.strip() + '"}'
                    ),
                },
            ],
            temperature=0.3,
        )
        return json.loads(response.choices[0].message.content)
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

    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
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
                                "If you can identify it, return a JSON object with:\n"
                                '- "found": true\n'
                                '- "name": canonical common name of the active ingredient/supplement\n'
                                '- "category": one of "Protein", "Performance", "Recovery", "Health", "Weight Management", "Sleep & Stress", "Other"\n'
                                '- "tagline": one short sentence describing what it is\n'
                                '- "whatItDoes": 2-3 sentences on mechanism and benefits\n'
                                '- "evidence": one of "strong", "moderate", or "limited"\n'
                                '- "dose": typical effective dose with unit\n'
                                '- "timing": when to take it\n'
                                '- "goodFor": array of 1-4 strings from: "Strength", "Muscle gain", "Fat loss", "Endurance", "Recovery", "General health", "Athletic performance", "Sleep"\n'
                                '- "cautions": 1-2 sentences on side effects or who should avoid it\n\n'
                                'If you cannot identify a supplement, return {"found": false, "name": ""}'
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                },
            ],
            temperature=0.3,
        )
        return json.loads(response.choices[0].message.content)
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

    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
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
                                "Return exactly this JSON — no extra text: "
                                '{"equipment": [<array of matching equipment name strings>]}'
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": image_data_url}},
                    ],
                },
            ],
            temperature=0.1,
            max_tokens=400,
        )
        return json.loads(response.choices[0].message.content)
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
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": "You are an upbeat fitness coach. Give brief, practical post-workout feedback. Return JSON only.",
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.7,
            max_tokens=250,
        )
        ai = json.loads(response.choices[0].message.content)
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

    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
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
            ],
            temperature=0.2,
            max_tokens=350,
        )
        return json.loads(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Form photo analysis failed: {str(e)}")
