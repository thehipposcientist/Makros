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

class FoodLookupRequest(BaseModel):
    name: str

class EquipmentLookupRequest(BaseModel):
    name: str

class CompletedSetIn(BaseModel):
    setNumber: int
    reps: int
    weightLbs: float

class WeightRecommendRequest(BaseModel):
    exerciseName: str
    goal: str
    lastSets: list[CompletedSetIn]
    nextSetNumber: int


# ─── Prompt builder ───────────────────────────────────────────────────────────

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
    bodyweight_only = not has_barbell and not has_dumbbells and not has_machines

    forbidden = []
    if not has_barbell:   forbidden.append("barbells or barbell exercises (squat, deadlift, bench press with barbell)")
    if not has_dumbbells: forbidden.append("dumbbells or kettlebells")
    if not has_machines:  forbidden.append("cable machines, leg press, lat pulldown, or any gym machine")
    if not has_pullupbar: forbidden.append("pull-up bar")
    if not has_bench:     forbidden.append("flat or incline bench")
    forbidden_str = '; '.join(forbidden) if forbidden else 'none'

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

INSTRUCTIONS
- Workout plan: provide exactly {req.daysPerWeek} training day objects.
  Each exercise must have realistic sets, reps (as a string like "8-10"), and rest seconds.
  STRICT EQUIPMENT RULE: ONLY use exercises that require equipment from the user's list above.
  If the forbidden list says "no barbells", do NOT include barbell exercises — use dumbbells or bodyweight alternatives.
  If bodyweight only, every exercise must be doable with zero equipment.
  Number of exercises per session should match approximately {req.workoutDurationMinutes} minutes (roughly 8 min per exercise).
- Nutrition plan: calculate calories and macros based on their stats and goal.
  Suggest meals using ONLY the foods they listed (or close substitutes if list is empty).
  Each meal needs a realistic calorie and protein count.

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
      "calories": 2000,
      "protein": 150,
      "carbs": 200,
      "fat": 65
    }},
    "breakfast": {{
      "meal": "Breakfast",
      "foods": ["string"],
      "calories": 500,
      "protein": 35
    }},
    "lunch": {{
      "meal": "Lunch",
      "foods": ["string"],
      "calories": 700,
      "protein": 50
    }},
    "dinner": {{
      "meal": "Dinner",
      "foods": ["string"],
      "calories": 800,
      "protein": 65
    }}
  }}
}}"""


# ─── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/lookup-food")
def lookup_food_macros(
    body: FoodLookupRequest,
    current_user: User = Depends(get_current_user),
):
    """Given a food name, return its macros per standard serving."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")

    client = OpenAI(api_key=api_key)
    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are a nutrition expert. Respond with valid JSON only."},
                {"role": "user", "content": (
                    f'Return the macros for "{name}" per one standard serving as JSON:\n'
                    '{"name": "string", "unit": "string (e.g. 100g, 1 cup)", '
                    '"calories": number, "protein": number, "carbs": number, "fat": number}'
                )},
            ],
            temperature=0.2,
            max_tokens=150,
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Lookup failed: {str(e)}")


@router.post("/lookup-equipment")
def lookup_equipment_info(
    body: EquipmentLookupRequest,
    current_user: User = Depends(get_current_user),
):
    """Given an equipment name, return primary muscle groups it targets."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")

    client = OpenAI(api_key=api_key)
    try:
        response = client.chat.completions.create(
            model=get_openai_model(),
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "You are a fitness expert. Respond with valid JSON only."},
                {"role": "user", "content": (
                    f'For the gym equipment "{name}", return:\n'
                    '{"name": "string", "muscleGroups": ["string"], "category": "string"}'
                )},
            ],
            temperature=0.2,
            max_tokens=150,
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Lookup failed: {str(e)}")


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
                    'Based on the sets completed and goal, recommend the weight and reps for the next set. '
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
