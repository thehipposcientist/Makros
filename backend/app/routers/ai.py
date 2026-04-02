import json
import os
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from openai import OpenAI

from app.auth import get_current_user
from app.models import User

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

class WeightRecommendRequest(BaseModel):
    exerciseName: str
    goal: str
    lastSets: list[CompletedSetIn]
    nextSetNumber: int


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
      "meal": "Breakfast",
      "foods": ["string"],
      "calories": {t['breakfast_cal']},
      "protein": {t['breakfast_prot']},
      "carbs": {t['breakfast_carbs']},
      "fat": {t['breakfast_fat']}
    }},
    "lunch": {{
      "meal": "Lunch",
      "foods": ["string"],
      "calories": {t['lunch_cal']},
      "protein": {t['lunch_prot']},
      "carbs": {t['lunch_carbs']},
      "fat": {t['lunch_fat']}
    }},
    "dinner": {{
      "meal": "Dinner",
      "foods": ["string"],
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
    """Given recent sets for an exercise, return the next weight/rep recommendation."""
    print(f"[BACKEND] Received weight recommendation request for {body.exerciseName}, set {body.nextSetNumber}")
    api_key = get_openai_api_key()
    if not api_key:
        print("[BACKEND] ERROR: OpenAI API key not configured")
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    sets_str = '; '.join(
        f"Set {s.setNumber}: {s.weightLbs} lbs × {s.reps} reps"
        + (f" ({s.feedback})" if s.feedback else "")
        for s in body.lastSets
    )

    client = OpenAI(api_key=api_key)
    try:
        print(f"[BACKEND] Calling OpenAI for {body.exerciseName} recommendation...")
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are an expert strength coach. Respond with valid JSON only."},
                {"role": "user", "content": (
                    f'Exercise: {body.exerciseName}\n'
                    f'User goal: {body.goal}\n'
                    f'Sets completed so far: {sets_str}\n'
                    f'This is set number {body.nextSetNumber}.\n\n'
                    'Based on the sets completed, goal, and any set feedback labels like easy, good, grind, or pain, recommend the weight and reps for the next set. '
                    'If the last set was marked pain, be conservative and prioritize safety. '
                    'Be concise and motivational. Return JSON:\n'
                    '{"weightLbs": number, "reps": number, "tip": "one short sentence"}'
                )},
            ],
            temperature=0.4,
            max_tokens=100,
        )
        result = json.loads(response.choices[0].message.content)
        print(f"[BACKEND] OpenAI response: {result}")
        return result
    except Exception as e:
        print(f"[BACKEND] ERROR: OpenAI call failed: {str(e)}")
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
