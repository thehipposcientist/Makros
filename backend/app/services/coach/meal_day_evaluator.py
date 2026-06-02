"""AI evaluation of a single day's logged meals.

Used by `POST /coach/evaluate-meal-day` — a Pro user taps "Evaluate this
day" on their meal card and gets an AI critique that compares actual
intake (calories/macros, meals logged) against their daily targets and
goal. The output is read-only feedback; any state mutation goes through
the regular `/coach/apply-action` path so this evaluator can NEVER
silently change targets, plans, or coaching state.

The payload is fully assembled by the `build_meal_day_payload` pure
function; the LLM call (`call_meal_day_llm`) only formats and parses.
That separation lets us unit-test the data assembly without burning AI
tokens.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import date as DateType
from typing import Any

from openai import OpenAI
from sqlmodel import Session, select

from app.models import Meal, MealItem, User, UserGoal, UserProfile, WorkoutCompletion
from app.routers.ai.utils import (
    _build_chat_kwargs,
    _chat_create,
    _extract_json,
    get_openai_api_key,
    model_chat,
)
from app.services.nutrition.meal_history import dedupe_meals_for_aggregation


SYSTEM_PROMPT = """You are a registered-dietitian-style nutrition coach evaluating ONE DAY of a user's logged meals.

You receive:
- `goal`: the user's primary goal (muscle_gain | fat_loss | recomp | maintenance | endurance | general_health)
- `targets`: { calories, protein_g, carbs_g, fat_g } daily targets (already adjusted for today's training)
- `actuals`: { calories, protein_g, carbs_g, fat_g } summed from logged meals
- `meals[]`: each with { name, meal_type, totals, items[] }
- `training` (optional): { workout_count, total_duration_minutes, total_calories_burned, is_heavy_training_day, archetypes[] } — today's training context

Your job: write a short, specific critique. Reference real numbers. Stay constructive. Never moralize.

Output ONLY a single JSON object (no prose, no code fences) with this shape:
{
  "headline": "<one-sentence verdict, max 90 chars>",
  "summary": "<2-3 sentences explaining the day vs the goal, citing specific numbers>",
  "observations": [
    { "kind": "win" | "gap" | "note", "text": "<single observation, max 120 chars>" },
    ...up to 4
  ],
  "suggestions": [
    "<concrete change for tomorrow, max 100 chars>",
    ...up to 3
  ]
}

Rules:
- "On target" means calories are within ±5% of the displayed target and protein is at least 95% of target.
- Calories within ±10% but outside ±5% are "close", not equally on target.
- If protein is more than 10% under target, that's the top "gap".
- If calories are >10% over target on a fat-loss goal, flag as the top "gap".
- For muscle-gain or recomp, under-eating calories is a real concern — call it out.
- Empty days (no meals logged) get headline "No meals logged today" and exactly one suggestion: "Log at least breakfast tomorrow to get a real read."
- Never recommend supplements. Never recommend specific brands. Never give medical advice.
- Plain English. No emojis. No "great job" / "keep crushing it" / "you got this".

Training-context rules (when `training` is present):
- You MAY reference today's workout count, total training time, whether it was a heavy or double-session day, and goal-aligned recovery fueling (carbs around training, post-workout protein).
- You MAY connect under-eating to recovery demand on heavy / double-session days.
- DO NOT cite the exact workout-burn number as if it were precise — wearable estimates are noisy. Talk about training load qualitatively ("a heavier session", "a double day") rather than as a calorie ledger.
- DO NOT tell the user to eat back every calorie burned. The target already includes a partial, capped recovery add-back.
- DO NOT prescribe muscle-group splits, programming changes, or anything outside nutrition.
"""


class MealDayEvaluatorError(Exception):
    pass


def build_meal_day_payload(
    db: Session,
    user_id: int,
    target_date: DateType,
    *,
    targets: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Assemble the structured input the LLM sees for one day.

    `targets` is optional — when omitted we attempt to look up the
    user's goal-derived defaults. The frontend already has the user's
    adjusted daily target from /meals/adjusted-daily-target, so it can
    inject that value to ensure the AI sees exactly what the user sees.
    """
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    goal_row = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()
    goal_id = (
        goal_row.goal_id.value if goal_row and hasattr(goal_row.goal_id, "value")
        else (goal_row.goal_id if goal_row else "general_health")
    )

    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id, Meal.meal_date == target_date)
        .order_by(Meal.consumed_at, Meal.id)
    ).all()
    meal_ids = [m.id for m in meals if m.id is not None]
    items_raw = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list[MealItem]] = defaultdict(list)
    for it in items_raw:
        items_by_meal[it.meal_id].append(it)
    meals_deduped = dedupe_meals_for_aggregation(meals, items_by_meal)

    actuals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
    serialized_meals: list[dict[str, Any]] = []
    for meal in meals_deduped:
        items = items_by_meal.get(meal.id, [])
        meal_totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
        item_summary: list[dict[str, Any]] = []
        for it in items:
            actuals["calories"]  += float(it.calories or 0)
            actuals["protein_g"] += float(it.protein_g or 0)
            actuals["carbs_g"]   += float(it.carbs_g or 0)
            actuals["fat_g"]     += float(it.fat_g or 0)
            meal_totals["calories"]  += float(it.calories or 0)
            meal_totals["protein_g"] += float(it.protein_g or 0)
            meal_totals["carbs_g"]   += float(it.carbs_g or 0)
            meal_totals["fat_g"]     += float(it.fat_g or 0)
            item_summary.append({
                "name": it.food_name,
                "quantity": float(it.quantity or 0),
                "unit": it.unit,
                "calories": round(float(it.calories or 0), 1),
                "protein_g": round(float(it.protein_g or 0), 1),
                "carbs_g": round(float(it.carbs_g or 0), 1),
                "fat_g": round(float(it.fat_g or 0), 1),
            })
        serialized_meals.append({
            "name": meal.name,
            "meal_type": (meal.meal_type.value if hasattr(meal.meal_type, "value") else str(meal.meal_type or "meal")),
            "totals": {k: round(v, 1) for k, v in meal_totals.items()},
            "items": item_summary,
        })

    actuals = {k: round(v, 1) for k, v in actuals.items()}

    if targets is None and profile is not None:
        targets = {
            "calories": float(getattr(profile, "calorie_target", 0) or 0),
            "protein_g": float(getattr(profile, "protein_target_g", 0) or 0),
            "carbs_g": float(getattr(profile, "carbs_target_g", 0) or 0),
            "fat_g": float(getattr(profile, "fat_target_g", 0) or 0),
        }
    if targets is None:
        targets = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}

    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date == target_date)
    ).all()
    training_block = _build_training_block(completions)

    out: dict[str, Any] = {
        "date": target_date.isoformat(),
        "goal": str(goal_id),
        "targets": {k: round(float(v or 0), 1) for k, v in targets.items()},
        "actuals": actuals,
        "meals": serialized_meals,
        "meal_count": len(serialized_meals),
    }
    if training_block is not None:
        out["training"] = training_block
    return out


def _build_training_block(completions: list) -> dict[str, Any] | None:
    """Compact summary of today's training for the coach prompt.

    Returns None when nothing was logged so the prompt doesn't waste tokens
    on an empty block. Numbers are intentionally coarse — we tell the LLM
    not to treat the calorie burn as precise.
    """
    if not completions:
        return None
    total_kcal = 0
    total_seconds = 0
    archetypes: list[str] = []
    for row in completions:
        try:
            total_kcal += int(round(float(getattr(row, "calories_burned", 0) or 0)))
        except (TypeError, ValueError):
            pass
        try:
            total_seconds += int(getattr(row, "duration_seconds", 0) or 0)
        except (TypeError, ValueError):
            pass
        archetype = getattr(row, "archetype", None) or getattr(row, "focus_label", None)
        if archetype:
            archetypes.append(str(archetype))
    duration_min = round(total_seconds / 60)
    is_heavy = (
        len(completions) >= 2
        or total_kcal >= 700
        or duration_min >= 90
    )
    return {
        "workout_count": len(completions),
        "total_duration_minutes": duration_min,
        "total_calories_burned": total_kcal,
        "is_heavy_training_day": is_heavy,
        "archetypes": archetypes[:4],
    }


def call_meal_day_llm(payload: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    """Format payload, call the LLM, parse + minimally validate the response."""
    api_key = get_openai_api_key()
    if not api_key:
        raise MealDayEvaluatorError("OPENAI_API_KEY not configured")

    client = OpenAI(api_key=api_key)
    model_name = model or os.getenv("MODEL_MEAL_EVALUATE", model_chat())
    user_content = json.dumps(payload, default=str, separators=(",", ":"))

    try:
        kwargs = _build_chat_kwargs(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            max_tokens=400,
            timeout_secs=25,
            ai_route="/coach/evaluate-meal-day",
            ai_budget_bucket="coach_chat",
        )
        resp = _chat_create(client, **kwargs)
    except Exception as e:
        raise MealDayEvaluatorError(f"OpenAI call failed: {e}") from e

    content = (resp.choices[0].message.content or "").strip()
    if not content:
        raise MealDayEvaluatorError("empty LLM response")
    try:
        parsed = _extract_json(content)
    except json.JSONDecodeError as e:
        raise MealDayEvaluatorError(f"LLM returned non-JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise MealDayEvaluatorError(f"LLM returned non-object: {type(parsed).__name__}")

    parsed.setdefault("headline", "Day reviewed.")
    parsed.setdefault("summary", "")
    parsed.setdefault("observations", [])
    parsed.setdefault("suggestions", [])
    if not isinstance(parsed["observations"], list):
        parsed["observations"] = []
    if not isinstance(parsed["suggestions"], list):
        parsed["suggestions"] = []
    # Trim to caps so a misbehaving model can't blow up the UI.
    parsed["observations"] = [o for o in parsed["observations"][:4] if isinstance(o, dict) and o.get("text")]
    parsed["suggestions"] = [s for s in parsed["suggestions"][:3] if isinstance(s, str) and s.strip()]
    parsed["_model"] = model_name
    return parsed


def evaluate_meal_day(
    db: Session,
    user_id: int,
    target_date: DateType,
    *,
    targets: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Public entry point: build payload + call LLM + return critique."""
    payload = build_meal_day_payload(db, user_id, target_date, targets=targets)
    if payload["meal_count"] == 0:
        # Short-circuit empty days — no point burning a token to say "log
        # something." The system-prompt rule already covers this, but
        # returning a deterministic empty-day response means the UI is
        # consistent and we save the API call.
        return {
            "headline": "No meals logged today",
            "summary": "Nothing's been logged for this day yet, so there's nothing to evaluate.",
            "observations": [],
            "suggestions": ["Log at least breakfast tomorrow to get a real read."],
            "_payload": payload,
        }
    result = call_meal_day_llm(payload)
    result["_payload"] = payload
    return result
