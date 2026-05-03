from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from openai import OpenAI
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import ensure_pro
from app.food_service import (
    food_read_to_search_result,
    merge_food_search_results,
    normalize_food_name,
    search_foods as search_local_foods,
)
from app.models import User, UserPreferences, UserState

router = APIRouter(prefix="/foods", tags=["foods"])


class PreferredFoodRequest(BaseModel):
    name: str


def _attach_food_classification(item: dict) -> dict:
    try:
        from app.services.nutrition.food_classifier import classify_food

        name = item.get("name") or ""
        if not name or item.get("protein_source"):
            return item
        cls = classify_food(name)
        item["protein_source"] = cls.protein_source
        item["fermented"] = cls.fermented_flag
        item["probiotic"] = cls.probiotic_flag
        item["omega3_rich"] = cls.omega3_flag
        item["plant_count"] = cls.plant_count_value
        item["seafood"] = cls.seafood_flag
        item["fruit"] = cls.fruit_flag
        item["vegetable"] = cls.vegetable_flag
        item["alcohol"] = cls.alcohol_flag
        item["processed_meat"] = cls.processed_meat_flag
        item["refined_grain"] = cls.refined_grain_flag
        if not item.get("food_quality"):
            bucket = cls.processing_bucket
            item["food_quality"] = (
                "whole" if bucket == "minimally_processed"
                else "processed" if bucket in ("processed", "ultra_processed")
                else "unknown"
            )
            item["processing_bucket"] = bucket
    except Exception:
        pass
    return item


def _preferences_for_user(db: Session, user_id: int, *, create: bool = False) -> UserPreferences | None:
    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
    if prefs is None and create:
        prefs = UserPreferences(user_id=user_id)
        db.add(prefs)
        db.flush()
    return prefs


def _preferred_names(prefs: UserPreferences | None) -> set[str]:
    return {normalize_food_name(str(name)) for name in (prefs.foods_available if prefs else []) if str(name).strip()}


def _query_matches_name(query: str, name: str) -> bool:
    norm_query = normalize_food_name(query)
    norm_name = normalize_food_name(name)
    if not norm_query or not norm_name:
        return False
    return norm_query in norm_name or all(token in norm_name for token in norm_query.split())


def _custom_foods_from_state(db: Session, user_id: int) -> list[dict]:
    row = db.exec(select(UserState).where(UserState.user_id == user_id)).first()
    state = row.state_json if row and isinstance(row.state_json, dict) else {}
    profile = state.get("userProfile") if isinstance(state.get("userProfile"), dict) else {}
    foods = profile.get("customFoods") if isinstance(profile, dict) else []
    if not isinstance(foods, list):
        return []
    return [f for f in foods if isinstance(f, dict)]


def _custom_food_to_search_result(item: dict, *, preferred_names: set[str]) -> dict | None:
    name = str(item.get("name") or "").strip()
    if not name:
        return None
    try:
        calories = float(item.get("calories") or 0)
        protein = float(item.get("protein") or 0)
        carbs = float(item.get("carbs") or 0)
        fat = float(item.get("fat") or 0)
    except (TypeError, ValueError):
        calories = protein = carbs = fat = 0
    result = {
        "name": name,
        "serving": str(item.get("unit") or "1 serving"),
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fat": fat,
        "source": "user",
        "food_id": None,
        "serving_id": None,
        "serving_grams": None,
        "external_id": None,
        "fdc_id": None,
        "brand": item.get("brand"),
        "is_verified": item.get("verificationStatus") in ("ai_validated", "seed_verified"),
        "is_preferred": normalize_food_name(name) in preferred_names,
    }
    micros = item.get("micronutrients")
    if isinstance(micros, dict):
        result["micronutrients"] = micros
        if "fiber" in micros:
            result["fiber"] = micros.get("fiber")
    return result


def _kitchen_custom_results(
    db: Session,
    *,
    user_id: int,
    query: str,
    preferred_names: set[str],
) -> list[dict]:
    results: list[dict] = []
    seen: set[str] = set()
    for item in _custom_foods_from_state(db, user_id):
        name = str(item.get("name") or "").strip()
        key = normalize_food_name(name)
        if not key or key in seen or key not in preferred_names:
            continue
        if not _query_matches_name(query, name):
            continue
        result = _custom_food_to_search_result(item, preferred_names=preferred_names)
        if result:
            results.append(result)
            seen.add(key)
    return results


def _search_usda(query: str, max_results: int) -> list[dict]:
    try:
        from app.services.usda_fdc import search_foods as usda_search

        return [_attach_food_classification(r) for r in usda_search(query, max_results=max_results)]
    except Exception:
        return []


def _search_ai(query: str) -> list[dict]:
    from app.routers.ai.utils import (
        MICRONUTRIENT_AI_FIELDS,
        MICRONUTRIENT_PROMPT_GUIDE,
        _build_chat_kwargs,
        _chat_create,
        get_openai_api_key,
        model_meal_parsing,
    )

    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="No verified food results and OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    micros_example = ", ".join(f'"{k}": 0' for k in MICRONUTRIENT_AI_FIELDS)
    messages = [
        {
            "role": "system",
            "content": (
                "You are a USDA-grade nutrition database. Given a food query, return nutrition info "
                "including the full micronutrient panel. If the user specifies a quantity, use that; "
                "otherwise use a standard serving size. Return valid JSON only."
            ),
        },
        {
            "role": "user",
            "content": (
                f'Food query: "{query}"\n\n'
                f"{MICRONUTRIENT_PROMPT_GUIDE}\n\n"
                "Return JSON in exactly this shape, one entry per result:\n"
                '{"results": [{"name": "chicken breast", "serving": "6 oz", '
                '"calories": 0, "protein": 0, "carbs": 0, "fat": 0, '
                f'"micronutrients": {{{micros_example}}}}}]}}\n\n'
                "Return 1-5 results. If the query is vague, return common preparations. "
                "If it is specific, return exactly that."
            ),
        },
    ]
    try:
        kwargs = _build_chat_kwargs(model_meal_parsing(), messages, max_tokens=1500, timeout_secs=30)
        resp = _chat_create(client, **kwargs)
        data = json.loads(resp.choices[0].message.content or '{"results": []}')
        results = data if isinstance(data, list) else data.get("results", [])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Food search failed: {str(e)}")

    out: list[dict] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        item["source"] = "ai"
        out.append(_attach_food_classification(item))
    return out


@router.get("/search")
def search_food_catalog(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=50),
    include_remote: bool = Query(default=True),
    force_ai: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Search the food catalog in the order users expect:

    user/recent/local foods first, then verified USDA, then AI only when
    explicitly requested or when no verified/local result exists.
    """
    query = q.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")

    prefs = _preferences_for_user(db, current_user.id)
    preferred = _preferred_names(prefs)

    if force_ai:
        ensure_pro(current_user, "AI food lookup")
        ai_results = _search_ai(query)
        return {
            "results": merge_food_search_results(
                local_results=[],
                remote_results=ai_results,
                preferred_names=preferred,
                limit=limit,
            ),
            "sources": {"local": 0, "usda": 0, "ai": len(ai_results)},
            "preferred_foods": prefs.foods_available if prefs else [],
        }

    kitchen_results = _kitchen_custom_results(
        db,
        user_id=current_user.id,
        query=query,
        preferred_names=preferred,
    )
    local_reads = search_local_foods(db, query, user_id=current_user.id, limit=limit)
    local_results = kitchen_results + [food_read_to_search_result(f, preferred_names=preferred) for f in local_reads]
    remote_results: list[dict] = []
    has_kitchen_hit = any(r.get("is_preferred") or r.get("source") == "user" for r in local_results)
    if include_remote and len(local_results) < limit and not has_kitchen_hit:
        remote_results = _search_usda(query, max_results=min(8, max(3, limit - len(local_results))))

    merged = merge_food_search_results(
        local_results=local_results,
        remote_results=remote_results,
        preferred_names=preferred,
        limit=limit,
    )

    ai_results: list[dict] = []
    if include_remote and not merged:
        ensure_pro(current_user, "AI food lookup")
        ai_results = _search_ai(query)
        merged = merge_food_search_results(
            local_results=[],
            remote_results=ai_results,
            preferred_names=preferred,
            limit=limit,
        )

    return {
        "results": merged,
        "sources": {"local": len(local_results), "usda": len(remote_results), "ai": len(ai_results)},
        "preferred_foods": prefs.foods_available if prefs else [],
    }


@router.get("/preferred")
def list_preferred_foods(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    prefs = _preferences_for_user(db, current_user.id)
    return {"foods_available": prefs.foods_available if prefs else []}


@router.post("/preferred")
def add_preferred_food(
    body: PreferredFoodRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Food name is required")

    prefs = _preferences_for_user(db, current_user.id, create=True)
    foods = list(prefs.foods_available or [])
    existing = {normalize_food_name(str(f)) for f in foods}
    if normalize_food_name(name) not in existing:
        foods.append(name)
        prefs.foods_available = foods
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        db.commit()
        db.refresh(prefs)
    return {"foods_available": prefs.foods_available}


@router.delete("/preferred/{food_name:path}")
def remove_preferred_food(
    food_name: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    prefs = _preferences_for_user(db, current_user.id)
    if prefs is None:
        return {"foods_available": []}
    target = normalize_food_name(food_name)
    foods = [name for name in (prefs.foods_available or []) if normalize_food_name(str(name)) != target]
    if foods != (prefs.foods_available or []):
        prefs.foods_available = foods
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        db.commit()
        db.refresh(prefs)
    return {"foods_available": prefs.foods_available}
