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
    create_food,
    food_read_to_search_result,
    infer_food_category,
    merge_food_search_results,
    normalize_food_name,
    search_foods as search_local_foods,
)
from app.enums import FoodSource
from app.models import User, UserPreferences, UserState, FoodSubmission
from app.services.nutrition.added_sugar import resolve_added_sugar_g

router = APIRouter(prefix="/foods", tags=["foods"])
_REMOTE_SEARCH_MIN_CHARS = 3


class PreferredFoodRequest(BaseModel):
    name: str


class FoodSubmissionRequest(BaseModel):
    name: str
    brand: str | None = None
    barcode: str | None = None
    serving: str | None = None
    serving_grams: float | None = None
    calories: float = 0
    protein: float | None = None
    protein_g: float | None = None
    carbs: float | None = None
    carbs_g: float | None = None
    fat: float | None = None
    fat_g: float | None = None
    fiber: float | None = None
    fiber_g: float | None = None
    sugar: float | None = None
    sugar_g: float | None = None
    added_sugar_g: float | None = None
    sodium_mg: float | None = None
    micronutrients: dict[str, float] | None = None
    aliases: list[str] | None = None
    front_image_url: str | None = None
    nutrition_label_image_url: str | None = None
    source_context: str = "manual"
    raw_payload: dict | None = None


def _coalesce_float(*values, default: float | None = 0.0) -> float | None:
    for value in values:
        if value in (None, ""):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return default


def _submission_to_read(row: FoodSubmission) -> dict:
    return {
        "id": row.id,
        "status": row.status,
        "source_context": row.source_context,
        "food_id": row.food_id,
        "linked_food_id": row.linked_food_id,
        "name": row.name,
        "brand": row.brand,
        "barcode": row.barcode,
        "serving": row.serving_label,
        "serving_grams": row.serving_grams,
        "calories": row.calories,
        "protein": row.protein_g,
        "carbs": row.carbs_g,
        "fat": row.fat_g,
        "fiber": row.fiber_g,
        "sugar": row.sugar_g,
        "added_sugar_g": row.added_sugar_g,
        "sodium_mg": row.sodium_mg,
        "micronutrients": row.micronutrients or {},
        "aliases": row.aliases or [],
        "front_image_url": row.front_image_url,
        "nutrition_label_image_url": row.nutrition_label_image_url,
        "review_note": row.review_note,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "reviewed_at": row.reviewed_at.isoformat() if row.reviewed_at else None,
    }


def _attach_food_classification(item: dict, db: Session) -> dict:
    """Attach cached classification tags to a search-result item.

    Read-only — never triggers a classification pass. A food that has not
    been classified yet (brand-new AI/USDA result) is returned without tags;
    the meal-write path classifies it via AI the first time it is logged.
    """
    try:
        from app.services.nutrition.ai_classify import lookup_classification

        name = item.get("name") or ""
        if not name or item.get("protein_source"):
            return item
        meta = lookup_classification(name, db)
        if meta is None:
            return item
        item["protein_source"] = meta.protein_source
        item["fermented"] = meta.fermented_flag
        item["probiotic"] = meta.probiotic_flag
        item["omega3_rich"] = meta.omega3_flag
        item["plant_count"] = meta.plant_count_value
        item["seafood"] = meta.seafood_flag
        item["fruit"] = meta.fruit_flag
        item["vegetable"] = meta.vegetable_flag
        item["alcohol"] = meta.alcohol_flag
        item["processed_meat"] = meta.processed_meat_flag
        item["refined_grain"] = meta.refined_grain_flag
        if not item.get("food_quality"):
            bucket = meta.processing_bucket
            item["food_quality"] = (
                "whole" if bucket == "minimally_processed"
                else "processed" if bucket in ("processed", "ultra_processed")
                else "unknown"
            )
            item["processing_bucket"] = bucket
    except Exception:
        pass
    return item


_PROCESSING_BUCKETS = {"minimally_processed", "processed", "ultra_processed"}


def _source_value(value) -> str:
    return str(getattr(value, "value", value) or "").strip().lower()


def _attach_local_search_classification(item: dict, db: Session) -> dict:
    out = _attach_food_classification(_resolve_search_result_added_sugar(dict(item)), db)
    source = _source_value(out.get("source"))
    bucket = str(out.get("processing_bucket") or "").strip().lower()
    if (source == "barcode" or out.get("barcode")) and bucket not in _PROCESSING_BUCKETS:
        out["processing_bucket"] = "processed"
        out["food_quality"] = "processed"
    return out


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
    return _resolve_search_result_added_sugar(result)


def _resolve_search_result_added_sugar(item: dict) -> dict:
    micros = item.get("micronutrients") if isinstance(item.get("micronutrients"), dict) else {}
    sugar = item.get("sugar") if item.get("sugar") is not None else micros.get("sugar")
    added_sugar = resolve_added_sugar_g(
        item.get("name") or item.get("food_name"),
        reported_added_sugar_g=item.get("added_sugar_g") if item.get("added_sugar_g") is not None else micros.get("added_sugar_g", micros.get("added_sugar")),
        sugar_g=sugar,
        serving_grams=item.get("serving_grams"),
    )
    if added_sugar is not None:
        item["added_sugar_g"] = added_sugar
        item["micronutrients"] = {**micros, "added_sugar_g": added_sugar}
    return item


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


def _search_usda(query: str, max_results: int, db: Session) -> list[dict]:
    try:
        from app.services.usda_fdc import search_foods as usda_search

        return [_attach_food_classification(_resolve_search_result_added_sugar(r), db) for r in usda_search(query, max_results=max_results)]
    except Exception:
        return []


def _search_fatsecret(query: str, max_results: int, db: Session) -> list[dict]:
    try:
        from app.services.fatsecret import search_foods as fatsecret_search

        return [_attach_food_classification(_resolve_search_result_added_sugar(r), db) for r in fatsecret_search(query, max_results=max_results)]
    except Exception:
        return []


def _search_ai(query: str, db: Session, *, user_id: int | None = None) -> list[dict]:
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
        kwargs = _build_chat_kwargs(
            model_meal_parsing(),
            messages,
            max_tokens=1500,
            timeout_secs=30,
            ai_route="/foods/search",
            ai_user_id=user_id,
            ai_budget_bucket="meal_parsing",
        )
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
        _resolve_search_result_added_sugar(item)
        out.append(_attach_food_classification(item, db))
    return out


@router.get("/search")
def search_food_catalog(
    q: str = Query(..., min_length=1),
    limit: int = Query(default=20, ge=1, le=50),
    include_remote: bool = Query(default=True),
    force_ai: bool = Query(default=False),
    allow_ai: bool = Query(default=True),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Search the food catalog in the order users expect:

    user/recent/local foods first, then remote restaurant/provider + USDA
    data, then AI only when explicitly requested or when no verified/local
    result exists.
    """
    query = q.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")

    prefs = _preferences_for_user(db, current_user.id)
    preferred = _preferred_names(prefs)

    if force_ai:
        ensure_pro(current_user, "AI food lookup")
        ai_results = _search_ai(query, db, user_id=current_user.id)
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
    local_results = [
        _attach_local_search_classification(r, db)
        for r in kitchen_results + [food_read_to_search_result(f, preferred_names=preferred) for f in local_reads]
    ]
    fatsecret_results: list[dict] = []
    usda_results: list[dict] = []
    has_kitchen_hit = any(r.get("is_preferred") or r.get("source") == "user" for r in local_results)
    can_search_remote = len(normalize_food_name(query)) >= _REMOTE_SEARCH_MIN_CHARS
    if include_remote and can_search_remote and len(local_results) < limit and not has_kitchen_hit:
        remote_limit = min(8, max(3, limit - len(local_results)))
        fatsecret_results = _search_fatsecret(query, remote_limit, db)
        remaining = limit - len(local_results) - len(fatsecret_results)
        if remaining > 0:
            usda_results = _search_usda(query, min(8, max(3, remaining)), db)

    merged = merge_food_search_results(
        local_results=local_results,
        remote_results=fatsecret_results + usda_results,
        preferred_names=preferred,
        limit=limit,
    )

    ai_results: list[dict] = []
    if allow_ai and include_remote and can_search_remote and not merged:
        ensure_pro(current_user, "AI food lookup")
        ai_results = _search_ai(query, db, user_id=current_user.id)
        merged = merge_food_search_results(
            local_results=[],
            remote_results=ai_results,
            preferred_names=preferred,
            limit=limit,
        )

    sources = {"local": len(local_results), "usda": len(usda_results), "ai": len(ai_results)}
    if fatsecret_results:
        sources["fatsecret"] = len(fatsecret_results)

    return {
        "results": merged,
        "sources": sources,
        "preferred_foods": prefs.foods_available if prefs else [],
    }


@router.post("/submissions", status_code=201)
def submit_food_to_catalog(
    body: FoodSubmissionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Food name is required")

    serving_label = (body.serving or "1 serving").strip() or "1 serving"
    micros = body.micronutrients or {}
    calories = _coalesce_float(body.calories, default=0.0) or 0.0
    protein = _coalesce_float(body.protein, body.protein_g, default=0.0) or 0.0
    carbs = _coalesce_float(body.carbs, body.carbs_g, default=0.0) or 0.0
    fat = _coalesce_float(body.fat, body.fat_g, default=0.0) or 0.0
    fiber = _coalesce_float(body.fiber, body.fiber_g, micros.get("fiber"), default=None)
    sugar = _coalesce_float(body.sugar, body.sugar_g, micros.get("sugar"), default=None)
    sodium_mg = _coalesce_float(body.sodium_mg, micros.get("sodium_mg"), micros.get("sodium"), default=None)
    added_sugar_g = _coalesce_float(body.added_sugar_g, micros.get("added_sugar_g"), micros.get("added_sugar"), default=None)
    serving_grams = _coalesce_float(body.serving_grams, default=None) or 100.0

    aliases = [a.strip() for a in (body.aliases or []) if str(a).strip()]
    barcode = body.barcode.strip() if body.barcode else None

    food = create_food(
        db,
        name=name,
        category=infer_food_category(name, db),
        source=FoodSource.USER,
        owner_user_id=current_user.id,
        unit=serving_label,
        serving_grams=serving_grams,
        calories=calories,
        protein=protein,
        carbs=carbs,
        fat=fat,
        fiber=fiber,
        sugar=sugar,
        added_sugar_g=added_sugar_g,
        sodium_mg=sodium_mg,
        brand=body.brand,
        barcode=barcode,
        is_verified=False,
        aliases=aliases,
        classify_on_create=False,
    )

    submission = FoodSubmission(
        user_id=current_user.id,
        food_id=food.id,
        status="pending",
        source_context=body.source_context or "manual",
        name=name,
        normalized_name=normalize_food_name(name),
        brand=body.brand,
        barcode=barcode,
        serving_label=serving_label,
        serving_grams=serving_grams,
        calories=calories,
        protein_g=protein,
        carbs_g=carbs,
        fat_g=fat,
        fiber_g=fiber,
        sugar_g=sugar,
        added_sugar_g=added_sugar_g,
        sodium_mg=sodium_mg,
        micronutrients=micros or None,
        aliases=aliases or None,
        front_image_url=body.front_image_url,
        nutrition_label_image_url=body.nutrition_label_image_url,
        raw_payload=body.raw_payload or body.model_dump(exclude_none=True),
    )
    db.add(submission)
    db.commit()
    db.refresh(submission)
    return _submission_to_read(submission)


@router.get("/submissions")
def list_my_food_submissions(
    status: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    stmt = select(FoodSubmission).where(FoodSubmission.user_id == current_user.id)
    if status:
        stmt = stmt.where(FoodSubmission.status == status)
    rows = db.exec(stmt.order_by(FoodSubmission.created_at.desc()).limit(limit)).all()
    return {"submissions": [_submission_to_read(row) for row in rows]}


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
