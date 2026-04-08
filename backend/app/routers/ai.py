from __future__ import annotations

import json
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

# Helper function to get OpenAI model from env
def get_openai_model():
    return os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# Helper function to get OpenAI API key from env
def get_openai_api_key():
    return os.getenv("OPENAI_API_KEY")


# ─── Request schema (mirrors frontend UserProfile) ────────────────────────────

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
    goal: str
    goalDetails: GoalDetailsIn
    physicalStats: PhysicalStatsIn
    daysPerWeek: int
    workoutDurationMinutes: int = 60
    equipment: list[str]
    foodsAvailable: list[str]

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
    profile: dict
    workoutPlan: dict | None = None
    nutritionPlan: dict | None = None
    progress: dict | None = None
    conversation: list[dict] | None = None


class WorkoutCoachQuestionRequest(BaseModel):
    question: str
    workout: dict
    activeExerciseName: str | None = None
    currentSetNumber: int | None = None
    loggedSets: list[dict] | None = None


class FoodPhotoRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"


class FormPhotoRequest(BaseModel):
    image_base64: str
    mime_type: str = "image/jpeg"
    exercise_name: str | None = None
    question: str | None = None


progression_engine = WorkoutProgressionEngine()


def map_goal_type(goal: str) -> GoalType:
    g = (goal or "").lower().strip()
    if g in {"strength"}:
        return GoalType.STRENGTH
    if g in {"fat_loss", "toning"}:
        return GoalType.FAT_LOSS
    if g in {"maintain", "flexibility", "stress_relief"}:
        return GoalType.MAINTAIN
    if g in {"endurance"}:
        return GoalType.ENDURANCE
    return GoalType.HYPERTROPHY


def map_feedback(feedback: str | None) -> EffortFeedback | None:
    if not feedback:
        return None
    value = feedback.lower().strip()
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
    return mapping.get(value)


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
            rep_min = int(left.strip())
            rep_max = int(right.strip())
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


# ─── Prompt builder ───────────────────────────────────────────────────────────

def compute_tdee_and_targets(req: PlanRequest) -> dict:
    """Compute TDEE and macro targets using Mifflin-St Jeor + goal adjustment."""
    ps = req.physicalStats
    weight_kg = ps.weightLbs / 2.205
    height_cm = (ps.heightFeet * 12 + ps.heightInches) * 2.54

    # Mifflin-St Jeor BMR
    base = 10 * weight_kg + 6.25 * height_cm - 5 * ps.age
    if ps.gender == 'male':
        bmr = base + 5
    elif ps.gender == 'female':
        bmr = base - 161
    else:
        bmr = base - 78  # average for nonbinary / prefer not to say

    # Activity multiplier
    if req.daysPerWeek <= 1:   multiplier = 1.2
    elif req.daysPerWeek <= 3: multiplier = 1.375
    elif req.daysPerWeek <= 5: multiplier = 1.55
    else:                      multiplier = 1.725

    tdee = round(bmr * multiplier)

    # Goal-based calorie adjustment
    pace = req.goalDetails.pace
    adjustments = {
        'fat_loss':             {'conservative': -250, 'moderate': -500, 'aggressive': -750},
        'toning':               {'conservative': -200, 'moderate': -350, 'aggressive': -500},
        'muscle_gain':          {'conservative':  150, 'moderate':  300, 'aggressive':  500},
        'body_recomp':          {'conservative': -100, 'moderate':    0, 'aggressive':  100},
        'strength':             {'conservative':  200, 'moderate':  350, 'aggressive':  500},
        'endurance':            {'conservative':  100, 'moderate':  200, 'aggressive':  300},
        'athletic_performance': {'conservative':  150, 'moderate':  250, 'aggressive':  400},
    }
    adjustment = adjustments.get(req.goal, {}).get(pace, 0)
    calories = max(1200, tdee + adjustment)

    # Protein: 1.0 g/lb for high-protein goals, 0.75 g/lb otherwise
    high_protein_goals = {'muscle_gain', 'body_recomp', 'strength', 'toning'}
    protein_per_lb = 1.0 if req.goal in high_protein_goals else 0.75
    protein = round(ps.weightLbs * protein_per_lb)

    # Carbs: 45% of calories; Fat: 30% of calories
    carbs = round((calories * 0.45) / 4)
    fat   = round((calories * 0.30) / 9)

    # Per-meal calorie split: 25% breakfast, 35% lunch, 40% dinner
    breakfast_cal = round(calories * 0.25)
    lunch_cal     = round(calories * 0.35)
    dinner_cal    = calories - breakfast_cal - lunch_cal  # remainder to avoid rounding drift

    # Per-meal protein split: same ratio as calories
    breakfast_prot = round(protein * 0.25)
    lunch_prot     = round(protein * 0.35)
    dinner_prot    = protein - breakfast_prot - lunch_prot

    # Per-meal carbs/fat split (proportional)
    breakfast_carbs = round(carbs * 0.25)
    lunch_carbs     = round(carbs * 0.35)
    dinner_carbs    = carbs - breakfast_carbs - lunch_carbs

    breakfast_fat = round(fat * 0.25)
    lunch_fat     = round(fat * 0.35)
    dinner_fat    = fat - breakfast_fat - lunch_fat

    return {
        'calories': calories, 'protein': protein, 'carbs': carbs, 'fat': fat,
        'breakfast_cal': breakfast_cal, 'breakfast_prot': breakfast_prot,
        'breakfast_carbs': breakfast_carbs, 'breakfast_fat': breakfast_fat,
        'lunch_cal': lunch_cal, 'lunch_prot': lunch_prot,
        'lunch_carbs': lunch_carbs, 'lunch_fat': lunch_fat,
        'dinner_cal': dinner_cal, 'dinner_prot': dinner_prot,
        'dinner_carbs': dinner_carbs, 'dinner_fat': dinner_fat,
    }


def build_prompt(req: PlanRequest) -> str:
    ps = req.physicalStats
    height_str = f"{ps.heightFeet}'{ps.heightInches}\""
    foods_str = ', '.join(req.foodsAvailable) if req.foodsAvailable else 'general healthy foods'
    equipment_str = ', '.join(req.equipment) if req.equipment else 'bodyweight only'

    has_barbell   = any(e in ['Barbell', 'Squat rack', 'Power rack', 'Smith machine'] for e in req.equipment)
    has_dumbbells = any(e in ['Dumbbells', 'Kettlebell'] for e in req.equipment)
    has_machines  = any(e in ['Cable machine', 'Leg press', 'Lat pulldown', 'Chest press machine', 'Seated row machine', 'Leg extension', 'Leg curl'] for e in req.equipment)
    has_pullupbar = 'Pull-up bar' in req.equipment or has_barbell or has_machines
    has_bench     = any(e in ['Flat bench', 'Incline bench'] for e in req.equipment)

    forbidden = []
    if not has_barbell:   forbidden.append("barbells or barbell exercises (squat, deadlift, bench press with barbell)")
    if not has_dumbbells: forbidden.append("dumbbells or kettlebells")
    if not has_machines:  forbidden.append("cable machines, leg press, lat pulldown, or any gym machine")
    if not has_pullupbar: forbidden.append("pull-up bar")
    if not has_bench:     forbidden.append("flat or incline bench")
    forbidden_str = '; '.join(forbidden) if forbidden else 'none'

    t = compute_tdee_and_targets(req)

    return f"""You are an expert fitness coach and registered dietitian.
Generate a personalised weekly workout plan and a daily nutrition plan for this user.

USER PROFILE
- Goal: {req.goal} (pace: {req.goalDetails.pace})
- Age: {ps.age}  Gender: {ps.gender}
- Weight: {ps.weightLbs} lbs  Height: {height_str}
{"- Target weight: " + str(req.goalDetails.targetWeightLbs) + " lbs" if req.goalDetails.targetWeightLbs else ""}
- Training days per week: {req.daysPerWeek}
- Session length: {req.workoutDurationMinutes} minutes
- Equipment the user HAS: {equipment_str if req.equipment else 'bodyweight only — NO equipment'}
- FORBIDDEN (user does NOT have these): {forbidden_str}
- Foods in kitchen: {foods_str}

MACRO TARGETS (computed from user stats — use EXACTLY these numbers, do not change them):
  Daily totals  → {t['calories']} cal / {t['protein']}g protein / {t['carbs']}g carbs / {t['fat']}g fat
  Breakfast     → {t['breakfast_cal']} cal / {t['breakfast_prot']}g protein / {t['breakfast_carbs']}g carbs / {t['breakfast_fat']}g fat
  Lunch         → {t['lunch_cal']} cal / {t['lunch_prot']}g protein / {t['lunch_carbs']}g carbs / {t['lunch_fat']}g fat
  Dinner        → {t['dinner_cal']} cal / {t['dinner_prot']}g protein / {t['dinner_carbs']}g carbs / {t['dinner_fat']}g fat

INSTRUCTIONS
- Workout plan: provide exactly {req.daysPerWeek} training day objects.
  Each exercise must have realistic sets, reps (as a string like "8-10"), and rest seconds.
  STRICT EQUIPMENT RULE: ONLY use exercises that require equipment from the user's list above.
  If the forbidden list says "no barbells", do NOT include barbell exercises — use dumbbells or bodyweight alternatives.
  If bodyweight only, every exercise must be doable with zero equipment.
  Number of exercises per session should match approximately {req.workoutDurationMinutes} minutes (roughly 8 min per exercise).
- Nutrition plan: use the EXACT macro targets listed above — do NOT recalculate or substitute different numbers.
  Suggest meals using ONLY the foods they listed (or close substitutes if list is empty).
  Each meal must include calories, protein, carbs, and fat matching the per-meal targets above.

Return ONLY valid JSON matching this exact schema, no extra text:

{{
  "workout_plan": {{
    "name": "string",
    "totalDays": {req.daysPerWeek},
    "days": [
      {{
        "day": "Day 1",
        "focus": "string",
        "exercises": [
          {{
            "name": "string",
            "sets": 3,
            "reps": "8-10",
            "restSeconds": 60,
            "equipment": "string"
          }}
        ]
      }}
    ]
  }},
  "nutrition_plan": {{
    "targets": {{
      "calories": {t['calories']},
      "protein": {t['protein']},
      "carbs": {t['carbs']},
      "fat": {t['fat']}
    }},
    "breakfast": {{
      "meal": "Recipe name (e.g. Oat & Egg White Bowl)",
      "foods": ["100g oats", "3 egg whites", "1 tbsp honey"],
      "instructions": "Cook oats 3 min. Whisk egg whites, scramble 2 min. Drizzle honey.",
      "calories": {t['breakfast_cal']},
      "protein": {t['breakfast_prot']},
      "carbs": {t['breakfast_carbs']},
      "fat": {t['breakfast_fat']}
    }},
    "lunch": {{
      "meal": "Recipe name",
      "foods": ["ingredient with amount", "ingredient with amount"],
      "instructions": "Brief 1-3 sentence cooking method.",
      "calories": {t['lunch_cal']},
      "protein": {t['lunch_prot']},
      "carbs": {t['lunch_carbs']},
      "fat": {t['lunch_fat']}
    }},
    "dinner": {{
      "meal": "Recipe name",
      "foods": ["ingredient with amount", "ingredient with amount"],
      "instructions": "Brief 1-3 sentence cooking method.",
      "calories": {t['dinner_cal']},
      "protein": {t['dinner_prot']},
      "carbs": {t['dinner_carbs']},
      "fat": {t['dinner_fat']}
    }}
  }}
}}"""


# ─── Endpoint ─────────────────────────────────────────────────────────────────

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
                set_number=set_data.setNumber,
                weight_lbs=set_data.weightLbs,
                reps=set_data.reps,
                rir=set_data.rir,
                feedback=map_feedback(set_data.feedback),
            )
            for set_data in body.lastSets
        ]
        last_weight = sets_completed[-1].weight_lbs if sets_completed else None

        goal_type = map_goal_type(body.goal)
        profile = UserTrainingProfile(
            primary_goal=goal_type,
            experience_level=map_experience_level(body.experienceLevel),
            recovery_level=map_recovery_level(body.recoveryLevel),
            progression_pace=map_progression_pace(body.progressionPace),
        )
        workout = WorkoutContext(
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
        readiness = ReadinessInput(
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
        rep_min = int(rec.target_rep_min or 8)
        rep_max = int(rec.target_rep_max or rep_min)
        rec_reps = max(1, round((rep_min + rep_max) / 2))

        return {
            "weightLbs": rec_weight,
            "reps": rec_reps,
            "tip": rec.coach_message,
            "action": rec.action.value,
            "repRange": f"{rep_min}-{rep_max}",
            "debug": rec.debug,
        }
    except Exception as e:
        print(f"[BACKEND] ERROR: deterministic recommendation failed: {str(e)}")
        raise HTTPException(status_code=502, detail=f"Recommendation failed: {str(e)}")


@router.post("/plans")
def generate_plans(
    req: PlanRequest,
    current_user: User = Depends(get_current_user),
):
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)

    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": "You are a fitness and nutrition expert. Always respond with valid JSON only.",
                },
                {
                    "role": "user",
                    "content": build_prompt(req),
                },
            ],
            temperature=0.7,
            max_tokens=2000,
        )

        content = response.choices[0].message.content
        plans = json.loads(content)

        # Basic validation
        if "workout_plan" not in plans or "nutrition_plan" not in plans:
            raise ValueError("Invalid response structure from AI")

        return plans

    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")


@router.post("/trainer-question")
def ask_trainer_question(
    body: TrainerQuestionRequest,
    current_user: User = Depends(get_current_user),
):
    """General trainer Q&A with broad plan/profile/progress context for plan updates and troubleshooting."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    q = body.question.strip()
    if len(q) < 6:
        raise HTTPException(status_code=400, detail="Question is too short")

    context_blob = {
        "profile": body.profile,
        "workoutPlan": body.workoutPlan,
        "nutritionPlan": body.nutritionPlan,
        "progress": body.progress,
    }
    convo = body.conversation or []
    trimmed_convo = convo[-12:]

    client = OpenAI(api_key=api_key)
    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert strength coach and injury-aware trainer. "
                        "Use provided profile/plan/progress context to give practical, safe advice. "
                        "If pain/injury red flags are present, advise reducing load and seeking a clinician. "
                        "When user asks for plan changes, include concrete updated plan objects. "
                        "Return JSON only."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Recent conversation (most recent last):\n"
                        f"{json.dumps(trimmed_convo, ensure_ascii=True)}\n\n"
                        "User question:\n"
                        f"{q}\n\n"
                        "Context JSON:\n"
                        f"{json.dumps(context_blob, ensure_ascii=True)}\n\n"
                        "Return this JSON schema exactly:\n"
                        "{\"answer\": string, \"action_items\": [string], \"needs_plan_update\": boolean, \"safety_note\": string, \"updated_workout_plan\": object|null, \"updated_nutrition_plan\": object|null}"
                    ),
                },
            ],
            temperature=0.4,
            max_tokens=500,
        )
        return json.loads(response.choices[0].message.content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="AI returned invalid JSON")
    except Exception as e:
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
                        "If the user asks unrelated nutrition/lifestyle topics, reply briefly that this in-workout coach "
                        "only handles form/injury/execution and suggest using Ask Trainer from Home for broader planning. "
                        "Return JSON only."
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
                        "{\"answer\": string, \"quick_cues\": [string], \"adjustment\": string, \"safety_note\": string}"
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
                                "Analyze this meal photo. Identify likely foods in plain English, estimate total macros, and provide a short meal name. "
                                "Return exactly this JSON schema: "
                                "{\"meal_name\": string, \"items\": [string], \"calories\": number, \"protein\": number, \"carbs\": number, \"fat\": number}"
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url},
                        },
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
    """AI post-workout summary: calories burned, achievements, and personalized recommendations."""
    weight_kg = body.weightLbs / 2.205
    duration_hours = body.durationSeconds / 3600

    focus_lower = body.focus.lower()
    if any(kw in focus_lower for kw in ["cardio", "run", "cycle", "hiit", "conditioning"]):
        met = 8.0
    elif any(kw in focus_lower for kw in ["strength", "power", "heavy"]):
        met = 6.5
    else:
        met = 5.5  # hypertrophy / general resistance training

    calories_burned = max(1, round(met * weight_kg * duration_hours))

    total_sets = sum(len(ex.get("sets", [])) for ex in body.exercises)
    exercises_done = sum(1 for ex in body.exercises if len(ex.get("sets", [])) > 0)
    achievements: list[str] = []
    for ex in body.exercises:
        sets = ex.get("sets", [])
        if sets:
            best = max(sets, key=lambda s: s.get("weightLbs", 0) * s.get("reps", 0))
            weight = best.get("weightLbs", 0)
            reps = best.get("reps", 0)
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
                {"role": "system", "content": "You are an upbeat fitness coach. Give brief, practical post-workout feedback. Return JSON only."},
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
                                "{\"answer\": string, \"quick_cues\": [string], \"likely_target\": string, \"red_flags\": [string], \"safety_note\": string}"
                            ),
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": image_data_url},
                        },
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
