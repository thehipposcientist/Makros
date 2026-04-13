from __future__ import annotations

import json
import math
import os
import re

import openai
from openai import OpenAI

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

from .models import PlanRequest

progression_engine = WorkoutProgressionEngine()


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

def model_food_enrichment() -> str:
    return os.getenv("MODEL_FOOD_ENRICHMENT", "gpt-4o-mini")


def enrich_foods_with_macros(
    client: OpenAI,
    foods: list[str],
    meal_routine: str | None = None,
) -> dict:
    """
    Convert raw food names and meal routine text into structured macro data.
    Returns {"foods": [{name, serving, calories, protein, carbs, fat}], "routine_meals": [...]}.
    Uses a fast/cheap model (gpt-5-mini or gpt-4o-mini) for speed.
    """
    if not foods and not meal_routine:
        return {"foods": [], "routine_meals": []}

    parts: list[str] = []
    if foods:
        parts.append(f"FOOD LIST:\n{chr(10).join(f'- {f}' for f in foods)}")
    if meal_routine:
        parts.append(f"MEAL ROUTINE (user's fixed meals):\n{meal_routine}")

    prompt = (
        "Convert the following food items and/or meal routine into structured nutrition data.\n"
        "For each food, return a STANDARD SERVING as an explicit numeric quantity and a\n"
        "concrete unit. NEVER use the word 'serving' as a unit — always pick one of:\n"
        "  g, oz, lb, ml, fl_oz, cup, tbsp, tsp, piece, slice, scoop\n"
        "Guidelines for choosing the unit:\n"
        "  - Meats, fish, tofu → oz (e.g. 6 oz chicken breast)\n"
        "  - Cooked grains, pasta, rice, oatmeal → cup\n"
        "  - Dry grains (oats, rice uncooked) → cup\n"
        "  - Eggs, fruit (apple, banana, orange) → piece\n"
        "  - Nuts, seeds, cheese chunks → oz\n"
        "  - Protein powder → scoop\n"
        "  - Bread, deli meat → slice\n"
        "  - Oils, dressings, nut butters → tbsp\n"
        "  - Milk, yogurt, liquids → cup or fl_oz\n"
        "  - Vegetables → cup\n"
        "Macros must match the quantity + unit exactly (USDA values).\n\n"
        + "\n\n".join(parts) + "\n\n"
        "Return JSON with this exact schema:\n"
        '{\n'
        '  "foods": [\n'
        '    {"name": "chicken breast", "quantity": 6, "unit": "oz", "calories": 280, "protein": 53, "carbs": 0, "fat": 6}\n'
        '  ],\n'
        '  "routine_meals": [\n'
        '    {\n'
        '      "meal_slot": "breakfast",\n'
        '      "description": "2 eggs and oatmeal",\n'
        '      "foods": [\n'
        '        {"name": "eggs", "quantity": "2 large", "calories": 140, "protein": 12, "carbs": 1, "fat": 10},\n'
        '        {"name": "oatmeal", "quantity": "1 cup cooked", "calories": 150, "protein": 5, "carbs": 27, "fat": 3}\n'
        '      ],\n'
        '      "total": {"calories": 290, "protein": 17, "carbs": 28, "fat": 13}\n'
        '    }\n'
        '  ]\n'
        '}\n\n'
        "If no meal routine is provided, return an empty routine_meals array.\n"
        "If no food list is provided, return an empty foods array.\n"
        "Be accurate with macro values. Use USDA-style nutrition data."
    )

    _model = model_food_enrichment()
    try:
        resp = client.chat.completions.create(
            model=_model,
            messages=[
                {"role": "system", "content": "You are a nutrition database. Return accurate macro data as JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            max_tokens=2000,
            timeout=20,
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
        food_count = len(data.get("foods", []))
        routine_count = len(data.get("routine_meals", []))
        print(f"[enrich_foods] OK — {food_count} foods, {routine_count} routine meals, model={_model}")
        return data
    except Exception as e:
        print(f"[enrich_foods] FAILED ({type(e).__name__}: {e}) — falling back to raw text")
        return {"foods": [], "routine_meals": []}


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



# Weekly lb/week limits per goal direction
_MAX_LOSS_RATE  = 1.5   # lbs/week
_MAX_GAIN_RATE  = 0.5   # lbs/week
_CALS_PER_LB   = 3500   # calories per pound of body weight
_MIN_CALORIES   = 1200


def compute_tdee_and_targets(req: PlanRequest) -> dict:
    """
    Compute TDEE via Mifflin-St Jeor, then derive a calorie target and
    macro split appropriate for the user's goal.

    Thin delegator — all the actual math lives in
    `app/services/calorie_calculator.py` and the goal-specific params
    live in `app/services/goal_nutrition_params.py`. This function just
    builds the inputs and re-shapes the output into the dict shape the
    prompt builder expects (with per-meal splits).
    """
    from app.services.calorie_calculator import (
        CalorieInputs, CustomMacroOverrides, compute_targets,
    )

    ps = req.physicalStats

    # Build the calculator's input dataclass from the PlanRequest shape.
    # PlanRequest stores the user's goal config under slightly different
    # field names; this is the ONLY place that bridges the two.
    overrides = None
    if req.customMacros:
        overrides = CustomMacroOverrides(
            calories=req.customMacros.calories,
            protein=req.customMacros.protein,
            carbs=req.customMacros.carbs,
            fat=req.customMacros.fat,
        )
    calc_inputs = CalorieInputs(
        weight_lbs=ps.weightLbs,
        height_feet=ps.heightFeet,
        height_inches=ps.heightInches,
        age=ps.age,
        gender=ps.gender,
        training_days_per_week=req.daysPerWeek,
        session_minutes=getattr(req, "workoutDurationMinutes", 60) or 60,
        goal_id=req.goal,
        pace=req.goalDetails.pace,
        target_weight_lbs=req.goalDetails.targetWeightLbs,
        timeline_weeks=req.goalDetails.timelineWeeks,
        custom_overrides=overrides,
    )

    targets = compute_targets(calc_inputs)

    # Diagnostic log — lets us (and the user) verify that the numbers
    # flowing into the prompt match the user's profile + goal. If the
    # app ever displays calories that don't match this line, the drift
    # happened downstream (in the AI response or the client-side sum),
    # not in our calculator.
    print(
        f"[compute_tdee_and_targets] goal={req.goal} pace={req.goalDetails.pace} "
        f"weight={ps.weightLbs}lb days/wk={req.daysPerWeek} → "
        f"bucket={targets.bucket_name} bmr={targets.bmr} tdee={targets.tdee} "
        f"kcal={targets.calories} protein={targets.protein_g}g "
        f"carbs={targets.carbs_g}g fat={targets.fat_g}g "
        f"override={targets.override_applied} floor={targets.min_calories_enforced} "
        f"[{targets.rate_summary}]"
    )

    # Re-shape the calculator output into the existing dict contract so
    # prompt builders don't need to change. Debug fields (`bmr`, `tdee`,
    # `rate_summary`, etc.) come straight from the calculator for
    # transparency.
    tdee = targets.tdee
    calories = targets.calories
    protein = targets.protein_g
    carbs = targets.carbs_g
    fat = targets.fat_g
    goal_rate_summary = targets.rate_summary

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

