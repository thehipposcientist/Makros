from __future__ import annotations

import json
import math
import os
import re
import time
from collections import defaultdict, deque
from datetime import datetime, time as datetime_time, timezone

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


class AIUsageLimitError(RuntimeError):
    """Raised when a route exceeds a configured AI budget."""

# ── Model selectors (all configurable via .env) ───────────────────────────────
# Model-selection policy (2026-Q2):
#   - gpt-5.4-mini is used for dedicated image-analysis tasks (food photo,
#     meal photo, body scan, form photo, supplement label).
#   - Everything else runs on gpt-4o-mini for cost + latency.
# Override any via .env.
def model_image() -> str:
    """Vision / image-analysis model. Used only when the prompt includes
    an image_url content part."""
    return os.getenv("MODEL_IMAGE", "gpt-5.4-mini")

def model_plan_generation() -> str:
    return os.getenv("MODEL_PLAN_GENERATION", "gpt-4o-mini")

def model_plan_update() -> str:
    return os.getenv("MODEL_PLAN_UPDATE", "gpt-4o-mini")

def model_meal_parsing() -> str:
    """Text-only meal parsing (food search, meal instructions). For
    photo-based parsing use `model_image()` instead."""
    return os.getenv("MODEL_MEAL_PARSING", "gpt-4o-mini")

def model_chat() -> str:
    return os.getenv("MODEL_CHAT", "gpt-4o-mini")

def model_chat_fallback() -> str:
    return os.getenv("MODEL_CHAT_FALLBACK", "gpt-4o-mini")

def model_intent() -> str:
    return os.getenv("MODEL_INTENT", "gpt-4o-mini")

def model_food_enrichment() -> str:
    return os.getenv("MODEL_FOOD_ENRICHMENT", "gpt-4o-mini")


_MODEL_PRICES_PER_1M: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-5-mini": (0.25, 2.00),
    "gpt-5.4-nano": (0.20, 1.25),
    "gpt-5.4-mini": (0.75, 4.50),
    "gpt-5.4": (2.50, 15.00),
    "gpt-5.5": (5.00, 30.00),
}

_PUBLIC_RATE_WINDOWS: dict[str, deque[float]] = defaultdict(deque)


def _price_for_model(model: str) -> tuple[float, float] | None:
    for prefix, price in _MODEL_PRICES_PER_1M.items():
        if model.startswith(prefix):
            return price
    return None


def _estimate_cost_usd(model: str, prompt_tokens: int | None, completion_tokens: int | None) -> float | None:
    price = _price_for_model(model)
    if not price:
        return None
    input_price, output_price = price
    return round(((prompt_tokens or 0) * input_price + (completion_tokens or 0) * output_price) / 1_000_000, 8)


def _usage_token_counts(response: object) -> tuple[int | None, int | None, int | None]:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None, None, None
    prompt = getattr(usage, "prompt_tokens", None)
    completion = getattr(usage, "completion_tokens", None)
    total = getattr(usage, "total_tokens", None)
    return prompt, completion, total


def _record_ai_usage_event(
    *,
    user_id: int | None,
    route: str,
    budget_bucket: str | None,
    model: str,
    success: bool,
    image_count: int,
    latency_ms: int | None,
    response: object | None = None,
    error: Exception | None = None,
) -> None:
    """Best-effort DB log for OpenAI usage. Never affects user flows."""
    try:
        from sqlmodel import Session
        from app.database import engine
        from app.models import AIUsageEvent
        prompt_tokens, completion_tokens, total_tokens = _usage_token_counts(response) if response is not None else (None, None, None)
        row = AIUsageEvent(
            user_id=user_id,
            route=route[:120] or "unknown",
            budget_bucket=(budget_bucket or None),
            model=model[:80] or "unknown",
            success=success,
            image_count=max(0, int(image_count or 0)),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            estimated_cost_usd=_estimate_cost_usd(model, prompt_tokens, completion_tokens),
            latency_ms=latency_ms,
            error_type=type(error).__name__[:120] if error else None,
        )
        with Session(engine) as session:
            session.add(row)
            session.commit()
    except Exception as exc:
        print(f"[ai_usage] record failed (non-fatal): {exc}")


def _daily_ai_call_count(user_id: int, *, budget_bucket: str | None = None) -> int:
    try:
        from sqlmodel import Session, select
        from app.database import engine
        from app.models import AIUsageEvent
        start = datetime.combine(datetime.now(timezone.utc).date(), datetime_time.min, tzinfo=timezone.utc)
        with Session(engine) as session:
            stmt = (
                select(AIUsageEvent)
                .where(AIUsageEvent.user_id == user_id)
                .where(AIUsageEvent.created_at >= start)
            )
            if budget_bucket:
                stmt = stmt.where(AIUsageEvent.budget_bucket == budget_bucket)
            return len(session.exec(stmt).all())
    except Exception as exc:
        print(f"[ai_usage] budget count failed (non-fatal): {exc}")
        return 0


def _enforce_ai_budget(user_id: int | None, budget_bucket: str | None) -> None:
    if user_id is None:
        return
    total_limit = int(os.getenv("AI_DAILY_CALL_LIMIT_PER_USER", "120"))
    bucket_limit = None
    if budget_bucket in {"image_scan", "vision"}:
        bucket_limit = int(os.getenv("AI_DAILY_IMAGE_SCAN_LIMIT_PER_USER", "40"))
    elif budget_bucket:
        env_name = f"AI_DAILY_{budget_bucket.upper()}_LIMIT_PER_USER"
        raw = os.getenv(env_name)
        bucket_limit = int(raw) if raw and raw.isdigit() else None

    if total_limit > 0 and _daily_ai_call_count(user_id) >= total_limit:
        raise AIUsageLimitError("Daily AI call limit reached")
    if bucket_limit and bucket_limit > 0 and _daily_ai_call_count(user_id, budget_bucket=budget_bucket) >= bucket_limit:
        raise AIUsageLimitError(f"Daily {budget_bucket.replace('_', ' ')} limit reached")


def check_public_ai_rate_limit(
    key: str,
    *,
    bucket: str,
    limit: int | None = None,
    window_secs: int = 3600,
) -> bool:
    """In-process throttle for unauthenticated AI helpers.

    Returns True when the caller may spend tokens. False means use the
    deterministic fallback. This intentionally fails closed to "no AI",
    not to "error".
    """
    max_calls = limit if limit is not None else int(os.getenv("AI_PUBLIC_MATCH_GOAL_LIMIT_PER_HOUR", "20"))
    if max_calls <= 0:
        return False
    now = time.time()
    q = _PUBLIC_RATE_WINDOWS[f"{bucket}:{key or 'unknown'}"]
    while q and now - q[0] > window_secs:
        q.popleft()
    if len(q) >= max_calls:
        return False
    q.append(now)
    return True


def _hydrate_foods_from_db(food_names: list[str], *, user_id: int | None = None) -> tuple[list[dict], list[str]]:
    """Look up each food name in the local Food DB. Returns (hydrated, unknowns).

    For every name we find (by normalized name or alias), pull its default
    serving's precomputed macros — no AI call needed. Names we can't match
    are returned as `unknowns` so the caller can decide whether to ask an
    LLM about them.

    This is the first half of the meal-planning refactor: enrichment used
    to be 100% AI regardless of whether we already knew every food in the
    list. In practice users pick ~99% of their foods from the DB-backed
    picker, so the AI call was pure waste.
    """
    from sqlmodel import Session, select, or_
    from app.database import engine
    from app.models import Food, FoodAlias, FoodServing, FoodNutrition

    hydrated: list[dict] = []
    unknowns: list[str] = []
    if not food_names:
        return hydrated, unknowns

    def _norm(s: str) -> str:
        return re.sub(r"[^a-z0-9 ]", "", s.lower()).strip()

    def _visible_food_filter():
        if user_id is None:
            return Food.owner_user_id == None  # noqa: E711
        return or_(Food.owner_user_id == None, Food.owner_user_id == user_id)  # noqa: E711

    def _pick_best_visible(rows):
        visible = [f for f in rows if f and f.is_active and (f.owner_user_id is None or f.owner_user_id == user_id)]
        if not visible:
            return None
        visible.sort(key=lambda f: (0 if f.owner_user_id == user_id else 1, 0 if f.is_verified else 1, f.name.lower()))
        return visible[0]

    with Session(engine) as session:
        for raw in food_names:
            name = raw.strip()
            if not name:
                continue
            norm = _norm(name)

            # Try normalized_name exact match first, then alias, then
            # case-insensitive name match as a last resort.
            food = _pick_best_visible(session.exec(
                select(Food).where(Food.normalized_name == norm, _visible_food_filter())
            ).all())
            if not food:
                aliases = session.exec(
                    select(FoodAlias).where(FoodAlias.alias_normalized == norm)
                ).all()
                if aliases:
                    food = _pick_best_visible(session.exec(
                        select(Food).where(
                            Food.id.in_([a.food_id for a in aliases]),
                            _visible_food_filter(),
                        )
                    ).all())
            if not food:
                # Final fuzzy: startswith match. Cheap and catches minor typos.
                food = _pick_best_visible(session.exec(
                    select(Food).where(Food.normalized_name.like(f"{norm}%"), _visible_food_filter())
                ).all())
            if not food:
                unknowns.append(name)
                continue

            # Prefer the default serving's precomputed macros. Fall back to
            # FoodNutrition (per-100g) if servings aren't populated.
            servings = session.exec(
                select(FoodServing).where(FoodServing.food_id == food.id)
            ).all()
            default_serving = next((s for s in servings if s.is_default), servings[0] if servings else None)

            # FoodNutrition holds the full per-100g micronutrient data
            # (fiber, sugar, added_sugar_g, sodium_mg). FoodServing only stores the
            # basic four macros. We need both: the serving for portion
            # info, the nutrition for micros — scaled by the serving's
            # grams ratio.
            nutrition = session.exec(
                select(FoodNutrition).where(FoodNutrition.food_id == food.id)
            ).first()

            def _scaled_micros(grams_in_serving: float) -> dict:
                """Scale all micronutrient fields from per-`reference_grams`
                values down to the actual serving grams. Returns a flat dict
                of {canonical_field_name: float}. Includes the legacy
                top-level columns (fiber/sugar/sodium) AND every key in the
                free-form `extra_nutrients` JSON. Missing values default to 0."""
                if nutrition is None or nutrition.reference_grams <= 0:
                    return {"fiber": 0, "sugar": 0, "sodium": 0}
                ratio = grams_in_serving / nutrition.reference_grams
                out = {
                    "fiber":  round((nutrition.fiber or 0) * ratio, 2),
                    "sugar":  round((nutrition.sugar or 0) * ratio, 2),
                    "added_sugar_g": round((getattr(nutrition, "added_sugar_g", 0) or 0) * ratio, 2),
                    "sodium": round((nutrition.sodium_mg or 0) * ratio, 2),
                }
                extras = getattr(nutrition, "extra_nutrients", None) or {}
                if isinstance(extras, dict):
                    for k, v in extras.items():
                        try:
                            out[k] = round(float(v or 0) * ratio, 1)
                        except (TypeError, ValueError):
                            continue
                return out

            if default_serving is not None:
                micros = _scaled_micros(default_serving.grams)
                hydrated.append({
                    "name": food.name,
                    "quantity": None,  # label already has the number
                    "unit": None,      # label already has the unit
                    "serving": default_serving.label,
                    "calories": default_serving.calories,
                    "protein": default_serving.protein,
                    "carbs": default_serving.carbs,
                    "fat": default_serving.fat,
                    **micros,
                })
                continue

            if nutrition is not None:
                # No FoodServing rows — fall back to 100g reference. Use
                # the same scaling helper so extras flow through identically.
                micros = _scaled_micros(nutrition.reference_grams)
                hydrated.append({
                    "name": food.name,
                    "serving": "100 g",
                    "calories": nutrition.calories,
                    "protein": nutrition.protein,
                    "carbs": nutrition.carbs,
                    "fat": nutrition.fat,
                    **micros,
                })
                continue

            # Food row exists but has no nutrition data — treat as unknown.
            unknowns.append(name)

    return hydrated, unknowns


# Layer 1 + Layer 2 micronutrient fields that should be present on
# every hydrated food for the insight engine to work. Used by the
# on-the-fly AI backfill below to decide whether a DB-hydrated food
# needs an AI top-up and to write the results back to FoodNutrition
# so we only pay once per food.
_REQUIRED_MICRO_FIELDS: tuple[str, ...] = (
    "fiber", "sugar", "sodium", "cholesterol",
    "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
    "omega_3", "omega_6",
    "potassium", "calcium", "iron", "magnesium",
    "vitamin_c", "vitamin_d", "vitamin_b12",
)


def _safe_float(v) -> float:
    """Convert a value to float, returning 0.0 on any failure."""
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _food_needs_micro_backfill(food_dict: dict) -> bool:
    """Return True if this food is missing ANY of the required micro fields.
    Aggressive by design — we'd rather burn a cheap AI call than ship a
    food card with half-empty chips. Once backfilled, the food is cached
    in FoodNutrition.extra_nutrients so the cost is one-time per food."""
    for k in _REQUIRED_MICRO_FIELDS:
        v = food_dict.get(k)
        try:
            if v is None or float(v or 0) <= 0:
                # Allow legitimate zeros ONLY for cholesterol (vegan foods)
                # and vitamin_b12 (plant foods) — everything else should
                # have SOMETHING on a real food.
                if k in ("cholesterol", "vitamin_b12") and v is not None:
                    continue
                return True
        except (TypeError, ValueError):
            return True
    return False


def _ai_backfill_micros(
    client: OpenAI,
    thin_foods: list[dict],
) -> dict[str, dict[str, float]]:
    """One AI call to backfill Layer 1 + Layer 2 micronutrients for a
    batch of DB-hydrated foods that came back missing most of them.
    Returns {food_name_lower: micros_dict}. Silently fails to {} on
    any error — the plan pipeline can still ship the macros it already
    has.

    Batched to avoid N+1 calls: even 20 thin foods = 1 call ≈ $0.001.
    """
    if not thin_foods:
        return {}
    prompt_items = []
    for f in thin_foods:
        prompt_items.append({
            "name": f.get("name"),
            "serving": f.get("serving") or f.get("quantity") or "1 serving",
        })
    prompt = (
        "Return USDA micronutrient values for each food at its STATED serving "
        "size. Use snake_case keys, match the exact units below, omit a field only "
        "if it is truly zero for that food.\n\n"
        "Units: fiber/sugar/saturated_fat/monounsaturated_fat/polyunsaturated_fat/"
        "omega_3/omega_6 in grams; sodium/cholesterol/potassium/calcium/iron/"
        "magnesium/vitamin_c in milligrams; vitamin_d and vitamin_b12 in micrograms.\n\n"
        f"Foods:\n{json.dumps(prompt_items, indent=2)}\n\n"
        "Return JSON with this exact shape:\n"
        '{"foods": [\n'
        '  {"name": "chicken breast", "micros": {"fiber": 0, "sugar": 0, "sodium": 120, '
        '"cholesterol": 140, "saturated_fat": 1.5, "monounsaturated_fat": 2, '
        '"polyunsaturated_fat": 1, "omega_3": 0.04, "omega_6": 0.6, "potassium": 440, '
        '"calcium": 12, "iron": 1.5, "magnesium": 50, "vitamin_c": 0, "vitamin_d": 0.2, '
        '"vitamin_b12": 0.5}},\n'
        '  ...\n'
        ']}'
    )
    try:
        resp = client.chat.completions.create(
            model=model_food_enrichment(),
            messages=[
                {"role": "system", "content": "You are a USDA nutrition database. Return only the required JSON, no prose."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            max_tokens=2500,
            timeout=25,
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
    except Exception as e:
        print(f"[enrich_foods] backfill AI call failed: {e}")
        return {}

    out: dict[str, dict[str, float]] = {}
    for entry in data.get("foods") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip().lower()
        micros = entry.get("micros")
        if not name or not isinstance(micros, dict):
            continue
        clean: dict[str, float] = {}
        for k, v in micros.items():
            if k not in _REQUIRED_MICRO_FIELDS:
                continue
            try:
                clean[k] = float(v)
            except (TypeError, ValueError):
                continue
        if clean:
            out[name] = clean
    return out


def _persist_backfilled_micros(name_to_micros: dict[str, dict[str, float]], *, user_id: int | None = None) -> None:
    """Write the AI-backfilled micros back to FoodNutrition.extra_nutrients
    so the next plan gen hydrates them from the DB and skips the AI call.
    Silent failure — persistence is an optimization, not a correctness
    requirement."""
    if not name_to_micros:
        return
    try:
        from sqlmodel import Session, select, or_
        from app.database import engine
        from app.models import Food, FoodNutrition
        with Session(engine) as db:
            for name_lower, micros in name_to_micros.items():
                norm = re.sub(r"[^a-z0-9 ]", "", name_lower.lower()).strip()
                visibility_filter = (
                    Food.owner_user_id == None  # noqa: E711
                    if user_id is None
                    else or_(Food.owner_user_id == None, Food.owner_user_id == user_id)  # noqa: E711
                )
                matches = db.exec(
                    select(Food).where(Food.normalized_name == norm, visibility_filter)
                ).all()
                matches = [f for f in matches if f.is_active and (f.owner_user_id is None or f.owner_user_id == user_id)]
                matches.sort(key=lambda f: (0 if f.owner_user_id == user_id else 1, 0 if f.is_verified else 1, f.name.lower()))
                food = matches[0] if matches else None
                if not food:
                    continue
                nut = db.exec(
                    select(FoodNutrition).where(FoodNutrition.food_id == food.id)
                ).first()
                if not nut:
                    continue
                extras = dict(getattr(nut, "extra_nutrients", None) or {})
                for k, v in micros.items():
                    if k == "fiber":
                        nut.fiber = v
                    elif k == "sugar":
                        nut.sugar = v
                    elif k == "sodium":
                        nut.sodium_mg = v
                    else:
                        extras[k] = v
                nut.extra_nutrients = extras
                db.add(nut)
            db.commit()
    except Exception as e:
        print(f"[enrich_foods] backfill persist failed (non-fatal): {e}")


def enrich_foods_with_macros(
    client: OpenAI,
    foods: list[str],
    meal_routine: str | None = None,
    *,
    user_id: int | None = None,
) -> dict:
    """
    Convert raw food names and meal routine text into structured macro data.
    Returns {"foods": [{name, serving, calories, protein, carbs, fat, ...micros}], "routine_meals": [...]}.

    Resolution order:
      1. Hydrate every food we can from the local DB (zero AI cost).
      2. Any DB-hydrated food that came back thin on micronutrients gets
         its Layer 2 fields topped up via a single batched AI call. The
         result is persisted back to `FoodNutrition.extra_nutrients` so
         future plans skip the AI call.
      3. If there's a `meal_routine` free-text OR any unknown foods, make
         a SINGLE AI call for just those — not the whole list.
      4. Merge DB + AI results before returning.
    """
    if not foods and not meal_routine:
        return {"foods": [], "routine_meals": []}

    hydrated, unknowns = _hydrate_foods_from_db(foods or [], user_id=user_id)
    print(
        f"[enrich_foods] STEP 1 hydrate: {len(hydrated)} from DB, "
        f"{len(unknowns)} unknowns (input={len(foods or [])})"
    )

    # Sample the first hydrated food's micro coverage for diagnostic.
    if hydrated:
        sample = hydrated[0]
        present = sum(1 for k in _REQUIRED_MICRO_FIELDS if float(sample.get(k) or 0) > 0)
        print(
            f"[enrich_foods] STEP 1 sample '{sample.get('name')}' has "
            f"{present}/{len(_REQUIRED_MICRO_FIELDS)} micro fields populated"
        )

    # ── Lazy inline micro backfill (batched at 5) ──────────────────
    # Check each hydrated food: if fewer than 8 of the 16 required
    # micro fields have non-zero values, queue it for AI enrichment.
    # This runs during plan gen so every food in the plan ships with
    # full micros — no separate script or startup hook needed.
    thin_foods = []
    for f in hydrated:
        populated = sum(
            1 for k in _REQUIRED_MICRO_FIELDS
            if _safe_float(f.get(k)) > 0
        )
        if populated < 8:
            thin_foods.append(f)

    if thin_foods:
        print(
            f"[enrich_foods] {len(thin_foods)}/{len(hydrated)} DB foods have "
            f"<8/16 micro fields — running lazy backfill in batches of 5"
        )
        # Process in batches of 5 to avoid timeouts
        for batch_start in range(0, len(thin_foods), 5):
            batch = thin_foods[batch_start:batch_start + 5]
            name_to_micros = _ai_backfill_micros(client, batch)
            if name_to_micros:
                # Write back to the hydrated food dicts so this plan
                # gen sees the data immediately.
                for f in hydrated:
                    fname = str(f.get("name") or "").strip().lower()
                    if fname in name_to_micros:
                        for mk, mv in name_to_micros[fname].items():
                            f[mk] = mv
                # Persist to DB so future plan gens skip the AI call.
                _persist_backfilled_micros(name_to_micros, user_id=user_id)
                print(
                    f"[enrich_foods] backfill batch "
                    f"{batch_start // 5 + 1}: enriched "
                    f"{len(name_to_micros)} foods"
                )

    # Fast path: if everything resolved from DB AND there's no free-text
    # routine, we're done — no AI call at all.
    if not unknowns and not meal_routine:
        return {"foods": hydrated, "routine_meals": []}

    # Slow path: AI call for just the unknowns + the routine text. Same prompt
    # structure as before but with a much smaller food list.
    ai_result = _enrich_via_ai(client, unknowns, meal_routine)
    return {
        "foods": hydrated + ai_result.get("foods", []),
        "routine_meals": ai_result.get("routine_meals", []),
    }


def _enrich_via_ai(
    client: OpenAI,
    foods: list[str],
    meal_routine: str | None = None,
) -> dict:
    """AI fallback for foods we couldn't hydrate from the DB. Same prompt as
    the original `enrich_foods_with_macros`, kept as a private helper."""
    if not foods and not meal_routine:
        return {"foods": [], "routine_meals": []}

    parts: list[str] = []
    if foods:
        parts.append(f"FOOD LIST:\n{chr(10).join(f'- {f}' for f in foods)}")
    if meal_routine:
        parts.append(f"MEAL ROUTINE (user's fixed meals):\n{meal_routine}")

    # Lean prompt — macros + core label nutrients only. Full Layer 2
    # micros (omega-3, calcium, etc.) are handled by the startup
    # enrichment script with proper batching. Keeping this prompt
    # small avoids the 32k-token cost + timeout issue that hit when
    # we asked for 16 micro fields on 20+ foods in one shot.
    prompt = (
        "Convert the following food items and/or meal routine into structured nutrition data.\n"
        "For each food, return a STANDARD SERVING as an explicit numeric quantity and unit.\n"
        "Units: oz (meat/fish), cup (grains/veg/liquid), piece (eggs/fruit), "
        "tbsp (oils/butters), scoop (protein powder), slice (bread).\n"
        "Include: calories, protein, carbs, fat, fiber (g), sugar (g), "
        "added_sugar_g (g), sodium (mg).\n\n"
        + "\n\n".join(parts) + "\n\n"
        'Return JSON:\n'
        '{"foods": [{"name": "chicken breast", "quantity": 6, "unit": "oz", '
        '"calories": 280, "protein": 53, "carbs": 0, "fat": 6, '
        '"fiber": 0, "sugar": 0, "added_sugar_g": 0, "sodium": 120}], '
        '"routine_meals": [{"meal_slot": "breakfast", "description": "...", '
        '"foods": [{"name": "...", "quantity": "...", "calories": 0, '
        '"protein": 0, "carbs": 0, "fat": 0}], '
        '"total": {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}}]}\n\n'
        "Empty routine_meals if no meal routine provided. Empty foods if no food list.\n"
        "Use USDA values. Be accurate."
    )

    _model = model_food_enrichment()
    # Scale max_tokens by food count so large lists don't truncate.
    _max_tokens = min(4000, max(1000, len(foods) * 80 + 500))
    try:
        resp = client.chat.completions.create(
            model=_model,
            messages=[
                {"role": "system", "content": "You are a nutrition database. Return accurate macro data as JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            max_tokens=_max_tokens,
            timeout=30,
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


def compute_tdee_and_targets(req: PlanRequest, db=None, user_id: int | None = None) -> dict:
    """
    Compute TDEE via Mifflin-St Jeor, then derive a calorie target and
    macro split appropriate for the user's goal.

    Thin delegator — all the actual math lives in
    `app/services/calorie_calculator.py` and the goal-specific params
    live in `app/services/goal_nutrition_params.py`. This function just
    builds the inputs and re-shapes the output into the dict shape the
    prompt builder expects (with per-meal splits).
    """
    from app.services.nutrition.targets import resolve_targets_for_request

    targets = resolve_targets_for_request(req, db=db, user_id=user_id)

    # Diagnostic log — lets us (and the user) verify that the numbers
    # flowing into the prompt match the user's profile + goal. If the
    # app ever displays calories that don't match this line, the drift
    # happened downstream (in the AI response or the client-side sum),
    # not in our calculator.
    print(
        f"[compute_tdee_and_targets] goal={req.goal} pace={req.goalDetails.pace} "
        f"weight={targets.source_weight_lbs}lb({targets.source_weight_kind}) days/wk={req.daysPerWeek} → "
        f"bucket={targets.bucket_name} bmr={targets.bmr} tdee={targets.tdee} "
        f"kcal={targets.calories} protein={targets.protein_g}g "
        f"carbs={targets.carbs_g}g fat={targets.fat_g}g "
        f"coach={targets.coaching_adjustment_kcal:+d} health={targets.health_activity_adjustment_kcal:+d} "
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
    # Accept any value 1..10. Previously this silently snapped any value
    # outside {2,3,4} back to 3, which made the user's actual setting
    # invisible to the rest of the pipeline. The downstream meal-data dict
    # only has slot keys for the 2/3/4-meal cases (legacy display), so we
    # still pick one of those for those keys, but the canonical `meals`
    # field carries the real number for the assembler.
    raw_meals = int(req.mealsPerDay or 3)
    meals = max(1, min(10, raw_meals))
    legacy_meal_bucket = meals if meals in (2, 3, 4) else (4 if meals > 4 else 3)

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

    if legacy_meal_bucket == 2:
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
    elif legacy_meal_bucket == 4:
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


def _default_reasoning_effort(model: str) -> str:
    """Return a supported low-latency reasoning effort for the model."""
    if model.startswith("gpt-5-pro"):
        return "high"
    if model.startswith("gpt-5.1") or model.startswith("gpt-5.4"):
        return "low"
    return "minimal"


def _normalize_reasoning_effort(model: str, effort: str | None) -> str:
    """Coerce unsupported legacy effort values onto a valid setting."""
    if not effort:
        return _default_reasoning_effort(model)
    if model.startswith("gpt-5-pro"):
        return "high"
    if effort == "minimal" and (model.startswith("gpt-5.1") or model.startswith("gpt-5.4")):
        return "low"
    return effort


def _chat_create(client: OpenAI, **kwargs) -> object:
    """
    Drop-in wrapper for client.chat.completions.create() that normalises params
    per model family.

    gpt-5 family (reasoning models):
      - strip temperature and top_p (reasoning models reject these)
      - rename max_tokens -> max_completion_tokens
      - add a model-supported low-latency reasoning_effort if not already set
    All other models: params passed through unchanged.
    """
    ai_route = kwargs.pop("ai_route", None)
    ai_user_id = kwargs.pop("ai_user_id", None)
    ai_budget_bucket = kwargs.pop("ai_budget_bucket", None)
    ai_image_count = int(kwargs.pop("ai_image_count", 0) or 0)
    model = kwargs.get("model", "")
    print(f"[_chat_create] CODE_VERSION=V7_GPT5_MINI model={model!r} keys={list(kwargs.keys())} rf={kwargs.get('response_format')}")
    start = time.perf_counter()
    if ai_route:
        try:
            _enforce_ai_budget(ai_user_id, ai_budget_bucket)
        except Exception as exc:
            _record_ai_usage_event(
                user_id=ai_user_id,
                route=ai_route,
                budget_bucket=ai_budget_bucket,
                model=str(model or "unknown"),
                success=False,
                image_count=ai_image_count,
                latency_ms=int((time.perf_counter() - start) * 1000),
                error=exc,
            )
            raise
    if _is_gpt5(model):
        # Reasoning models reject temperature and top_p
        kwargs.pop("temperature", None)
        kwargs.pop("top_p", None)
        # Rename max_tokens -> max_completion_tokens for reasoning models
        if "max_tokens" in kwargs:
            kwargs["max_completion_tokens"] = kwargs.pop("max_tokens")
        # chat.completions API uses reasoning_effort (string), not reasoning (dict — that's Responses API)
        if "reasoning" in kwargs:
            r = kwargs.pop("reasoning")
            if isinstance(r, dict) and "effort" in r:
                kwargs.setdefault("reasoning_effort", r["effort"])
        kwargs["reasoning_effort"] = _normalize_reasoning_effort(
            model,
            kwargs.get("reasoning_effort"),
        )
    try:
        response = client.chat.completions.create(**kwargs)
    except Exception as exc:
        if ai_route:
            _record_ai_usage_event(
                user_id=ai_user_id,
                route=ai_route,
                budget_bucket=ai_budget_bucket,
                model=str(model or "unknown"),
                success=False,
                image_count=ai_image_count,
                latency_ms=int((time.perf_counter() - start) * 1000),
                error=exc,
            )
        raise
    if ai_route:
        _record_ai_usage_event(
            user_id=ai_user_id,
            route=ai_route,
            budget_bucket=ai_budget_bucket,
            model=str(model or "unknown"),
            success=True,
            image_count=ai_image_count,
            latency_ms=int((time.perf_counter() - start) * 1000),
            response=response,
        )
    return response


def _build_chat_kwargs(
    model: str,
    messages: list[dict],
    json_schema: dict | None = None,
    max_tokens: int | None = None,
    timeout_secs: int = 120,
    ai_route: str | None = None,
    ai_user_id: int | None = None,
    ai_budget_bucket: str | None = None,
    ai_image_count: int = 0,
) -> dict:
    """
    Build kwargs for _chat_create adapted to model family.

    gpt-4o family  → response_format=json_object, max_tokens, temperature
    gpt-5 family   → max_completion_tokens (includes reasoning tokens),
                     model-supported low-latency reasoning_effort,
                     NO temperature/top_p (reasoning models reject these).
                     response_format=json_schema when schema provided,
                     falls back to prompt-enforced JSON otherwise.
    """
    kwargs: dict = dict(model=model, messages=messages, timeout=timeout_secs)
    if ai_route:
        kwargs["ai_route"] = ai_route
        kwargs["ai_user_id"] = ai_user_id
        kwargs["ai_budget_bucket"] = ai_budget_bucket
        kwargs["ai_image_count"] = ai_image_count
    if _is_gpt5(model):
        # Reasoning model: use max_completion_tokens, add reasoning control,
        # do NOT pass temperature or top_p.
        if max_tokens is not None:
            kwargs["max_completion_tokens"] = max_tokens
        kwargs["reasoning_effort"] = _default_reasoning_effort(model)
        if json_schema:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": json_schema.get("name", "response"),
                    "strict": json_schema.get("strict", True),
                    "schema": json_schema["schema"],
                },
            }
        # gpt-5 with no schema: rely on prompt-enforced JSON.
        # Do NOT set response_format=json_object — let the prompt handle it.
    else:
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
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

# Canonical micronutrient field set the AI can return on any food-related
# response. Mirrors `MICRONUTRIENT_FIELDS` in services/meal_assembler.py —
# keep these in sync. Field name + unit guidance is duplicated in the
# prompts that ask the AI to populate them.
MICRONUTRIENT_AI_FIELDS: tuple[str, ...] = (
    "fiber", "sugar", "added_sugar_g", "sodium",
    "cholesterol",
    "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
    "omega_3", "omega_6",
    "vitamin_a", "vitamin_c", "vitamin_d", "vitamin_e", "vitamin_k",
    "thiamin_b1", "riboflavin_b2", "niacin_b3", "vitamin_b6",
    "folate_b9", "vitamin_b12", "biotin_b7", "pantothenic_acid_b5",
    "calcium", "iron", "magnesium", "phosphorus", "potassium",
    "zinc", "selenium", "copper", "manganese",
)


def _micros_schema_props() -> dict:
    """Return a JSON-schema `properties` dict mapping every canonical
    micronutrient field to a number. Used by the strict schemas that
    accept a `micronutrients` object on AI responses."""
    return {k: {"type": "number"} for k in MICRONUTRIENT_AI_FIELDS}


# Shared text fragment for AI prompts. Asks the AI to populate the full
# panel using USDA per-serving values, with explicit unit guidance.
MICRONUTRIENT_PROMPT_GUIDE = (
    "Populate `micronutrients` with USDA-style values per the SAME serving "
    "you reported in the macros. Units: fiber/sugar/added_sugar_g in grams; sodium, "
    "cholesterol, calcium, iron, magnesium, phosphorus, potassium, zinc, "
    "vitamin_c, vitamin_e, thiamin_b1, riboflavin_b2, niacin_b3, vitamin_b6, "
    "pantothenic_acid_b5 in mg; vitamin_a, vitamin_d, vitamin_k, folate_b9, "
    "biotin_b7, vitamin_b12, selenium in µg; saturated_fat, monounsaturated_fat, "
    "polyunsaturated_fat, omega_3, omega_6 in grams; copper, manganese in mg. "
    "Return 0 for any value you don't have data on. Never omit fields."
)


SCHEMA_FOOD_PHOTO = {
    "name": "food_photo_response",
    # `strict=False` because we want the AI to fill in micronutrients but
    # OpenAI's strict mode requires every nested optional field to appear
    # in `required`, which makes the schema brittle. Validation happens
    # downstream when the assembler reads the dict.
    "strict": False,
    "schema": {
        "type": "object",
        "properties": {
            "meal_name": {"type": "string"},
            "items": {"type": "array", "items": {"type": "string"}},
            "calories": {"type": "number"},
            "protein": {"type": "number"},
            "carbs": {"type": "number"},
            "fat": {"type": "number"},
            "micronutrients": {
                "type": "object",
                "properties": _micros_schema_props(),
            },
        },
        "required": ["meal_name", "items", "calories", "protein", "carbs", "fat"],
    },
}

SCHEMA_SCAN_FOODS = {
    "name": "scan_foods_response",
    "strict": False,
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
                        "micronutrients": {
                            "type": "object",
                            "properties": _micros_schema_props(),
                        },
                    },
                    "required": ["name", "serving", "calories", "protein", "carbs", "fat"],
                },
            },
        },
        "required": ["foods"],
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
