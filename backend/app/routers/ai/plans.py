from __future__ import annotations

import asyncio
import json

import openai
from openai import OpenAI
from fastapi import HTTPException, Depends

from app.auth import get_current_user
from app.models import User

from .router import router
from .models import PlanRequest, WorkoutOnlyRequest, NutritionOnlyRequest, ParseWorkoutsRequest
from .utils import (
    get_openai_api_key, model_plan_generation, model_plan_update,
    _build_chat_kwargs, _chat_create, _looks_truncated, _extract_json,
    _log_openai_error, enrich_foods_with_macros,
    SCHEMA_WORKOUT, SCHEMA_NUTRITION,
)
from .prompts import build_workout_prompt, build_nutrition_prompt


def _validate_plans_legacy(plans: dict, req: PlanRequest) -> None:
    """Legacy single-plan validator — unused in parallel flow."""
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

    # Enrich foods with macros first (fast model, runs in parallel with workout)
    enriched = await asyncio.to_thread(
        enrich_foods_with_macros, client, req.foodsAvailable, req.mealRoutine
    )

    try:
        workout_data, nutrition_data = await asyncio.gather(
            asyncio.to_thread(_call_workout_ai, client, build_workout_prompt(req), _m, 1400),
            asyncio.to_thread(_call_nutrition_ai, client, build_nutrition_prompt(req, enriched), req.foodsAvailable, _m, 3000),
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

    enriched = await asyncio.to_thread(
        enrich_foods_with_macros, client, req.foodsAvailable, req.mealRoutine
    )

    try:
        nutrition_data = await asyncio.to_thread(_call_nutrition_ai, client, build_nutrition_prompt(plan_req, enriched), req.foodsAvailable, _m, 3500)
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

Return ONLY a valid JSON object with a "sessions" key — no markdown, no explanation:
{{
  "sessions": [
    {{
      "date": "YYYY-MM-DD",
      "focus": "string",
      "completed": true,
      "durationSeconds": 3600,
      "exercises": []
    }}
  ]
}}

If nothing parseable, return: {{"sessions": []}}"""

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

