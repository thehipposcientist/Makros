from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select, delete as _sm_delete
from datetime import date, datetime, timezone
from typing import Optional

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import User, Meal, MealItem, MealCreate, UserDayState, UserGoal, WorkoutCompletion, SavedMeal, WatchCommandEvent
from app.auth import get_current_user
from app.services.nutrition.added_sugar import resolve_added_sugar_g

router = APIRouter(prefix="/meals", tags=["meals"])


# ─── Request schemas for new endpoints ────────────────────────────────────────

class LogCheckedBody(BaseModel):
    meal_date: str          # "YYYY-MM-DD"
    meal_type: str          # "meal_0", "breakfast", etc.
    client_meal_key: Optional[str] = None
    meal: dict              # full MealSuggestion dict from the client
    source: Optional[str] = "plan_check"
    consumed_at: Optional[datetime] = None
    # Client idempotency token. A retried / double-tapped check-off with the
    # same key returns the already-logged row instead of inserting a second.
    idempotency_key: Optional[str] = None


class CopyMealBody(BaseModel):
    meal_date: str | None = None
    meal_type: str | None = None
    consumed_at: datetime | None = None
    name: str | None = None
    notes: str | None = None
    quantity_scale: float = Field(default=1.0, gt=0, le=10)
    # Client idempotency token. A retried "Copy to today" tap with the same
    # key returns the already-cloned row via the (user_id, idempotency_key)
    # partial unique index on `meals`, instead of duplicating the clone.
    idempotency_key: str | None = None


class SplitMealBody(BaseModel):
    keep_fraction: float = Field(default=0.5, gt=0, lt=1)
    remaining_meal_date: str | None = None
    remaining_meal_type: str | None = None
    remaining_consumed_at: datetime | None = None
    remaining_name: str | None = None


class MealPageViewer(BaseModel):
    is_favorite: bool
    can_edit: bool
    saved_meal_id: int | None = None
    last_logged_at: datetime | None = None
    user_specific_notes: str | None = None


class MealPagePermissions(BaseModel):
    can_edit: bool
    can_delete: bool
    can_favorite: bool
    can_log: bool


class MealPageResponse(BaseModel):
    meal: dict
    viewer: MealPageViewer
    logs: list[dict]
    permissions: MealPagePermissions


@router.get("/grocery-list")
def grocery_list(
    days: int = Query(default=3, ge=1, le=14),
    current_user: User = Depends(require_pro_feature("AI meal plans")),
    db: Session = Depends(get_session),
):
    """Build grocery list from saved day-state nutrition plans over next N days."""
    from datetime import date, timedelta

    start = date.today()
    end = start + timedelta(days=days - 1)
    states = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id)
        .where(UserDayState.day_key >= start)
        .where(UserDayState.day_key <= end)
        .order_by(UserDayState.day_key)
    ).all()

    counts: dict[str, int] = {}
    for s in states:
        plan = s.nutrition_plan or {}
        # New shape: plan["meals"] = [...]. Legacy: plan[breakfast/lunch/...].
        meals_list: list[dict] = []
        if isinstance(plan.get("meals"), list):
            meals_list = [m for m in plan["meals"] if isinstance(m, dict)]
        else:
            for key in ("breakfast", "lunch", "dinner", "snack"):
                meal = plan.get(key)
                if isinstance(meal, dict):
                    meals_list.append(meal)
        for meal in meals_list:
            for food in meal.get("foods", []):
                counts[food] = counts.get(food, 0) + 1

    items = sorted([{"food": k, "frequency": v} for k, v in counts.items()], key=lambda x: (-x["frequency"], x["food"]))
    return {"days": days, "items": items}


@router.post("/swap")
def meal_swap(
    meal_type: str,
    foods: list[str],
    current_user: User = Depends(require_pro_feature("AI meal swaps")),
    db: Session = Depends(get_session),
):
    """Suggest simple swap candidates from the user's available foods in preferences."""
    from app.models import UserPreferences

    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == current_user.id)).first()
    available = prefs.foods_available if prefs else []
    suggestions = [f for f in available if f not in foods][:6]
    if not suggestions:
        suggestions = foods[:]
    return {
        "meal_type": meal_type,
        "original": foods,
        "suggested": suggestions,
    }


def _build_meal_response(meal: Meal, db: Session) -> dict:
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
    return {**meal.model_dump(), "items": [i.model_dump() for i in items]}


def _meal_totals(items: list[MealItem]) -> dict:
    return {
        "calories": round(sum(float(i.calories or 0) for i in items), 1),
        "protein_g": round(sum(float(i.protein_g or 0) for i in items), 1),
        "carbs_g": round(sum(float(i.carbs_g or 0) for i in items), 1),
        "fat_g": round(sum(float(i.fat_g or 0) for i in items), 1),
        "fiber_g": round(sum(float(i.fiber_g or 0) for i in items), 1),
    }


def _serialize_meal_with_items(meal: Meal, items: list[MealItem]) -> dict:
    return {
        **meal.model_dump(),
        "items": [i.model_dump() for i in items],
        "totals": _meal_totals(items),
    }


def _items_signature(items: list[MealItem]) -> tuple:
    return tuple(sorted(
        (
            (item.food_name or "").strip().lower(),
            round(float(item.quantity or 0), 4),
            (item.unit or "").strip().lower(),
            round(float(item.calories or 0), 1),
            round(float(item.protein_g or 0), 1),
            round(float(item.carbs_g or 0), 1),
            round(float(item.fat_g or 0), 1),
        )
        for item in items
    ))


def _saved_items_signature(items: list[dict]) -> tuple:
    return tuple(sorted(
        (
            str(item.get("food_name") or item.get("name") or "").strip().lower(),
            round(float(item.get("quantity") or 0), 4),
            str(item.get("unit") or "").strip().lower(),
            round(float(item.get("calories") or 0), 1),
            round(float(item.get("protein_g", item.get("protein", 0)) or 0), 1),
            round(float(item.get("carbs_g", item.get("carbs", 0)) or 0), 1),
            round(float(item.get("fat_g", item.get("fat", 0)) or 0), 1),
        )
        for item in (items or [])
    ))


def _plan_item_from_meal_item(item: MealItem) -> dict:
    return {
        "name": item.food_name,
        "food_name": item.food_name,
        "food_id": item.food_id,
        "serving_id": item.serving_id,
        "serving_grams": item.serving_grams,
        "quantity": item.quantity,
        "unit": item.unit,
        "calories": item.calories,
        "protein": item.protein_g,
        "protein_g": item.protein_g,
        "carbs": item.carbs_g,
        "carbs_g": item.carbs_g,
        "fat": item.fat_g,
        "fat_g": item.fat_g,
        "saturated_fat_g": item.saturated_fat_g,
        "trans_fat_g": item.trans_fat_g,
        "cholesterol_mg": item.cholesterol_mg,
        "sodium_mg": item.sodium_mg,
        "fiber_g": item.fiber_g,
        "sugar_g": item.sugar_g,
        "added_sugar_g": item.added_sugar_g,
        "caffeine_mg": item.caffeine_mg,
        "alcohol_g": item.alcohol_g,
        "potassium_mg": item.potassium_mg,
        "calcium_mg": item.calcium_mg,
        "magnesium_mg": item.magnesium_mg,
        "iron_mg": item.iron_mg,
        "phosphorus_mg": item.phosphorus_mg,
        "iodine_mcg": item.iodine_mcg,
        "choline_mg": item.choline_mg,
        "vitamin_d_mcg": item.vitamin_d_mcg,
        "vitamin_b12_mcg": item.vitamin_b12_mcg,
        "vitamin_k_mcg": item.vitamin_k_mcg,
        "vitamin_e_mg": item.vitamin_e_mg,
        "folate_mcg": item.folate_mcg,
        "zinc_mg": item.zinc_mg,
        "omega_3_g": item.omega_3_g,
        "omega_3_ala_mg": item.omega_3_ala_mg,
        "omega_3_epa_mg": item.omega_3_epa_mg,
        "omega_3_dha_mg": item.omega_3_dha_mg,
        "omega_6_mg": item.omega_6_mg,
    }


def _logged_meal_to_plan_suggestion(meal: Meal, items: list[MealItem]) -> dict:
    totals = _meal_totals(items)
    mapped_items = [_plan_item_from_meal_item(item) for item in items]
    payload = {
        "meal": meal.name,
        "name": meal.name,
        "items": mapped_items,
        "foods": [item.food_name for item in items],
        "amounts": [f"{item.quantity} {item.unit}" for item in items],
        "calories": totals["calories"],
        "protein": totals["protein_g"],
        "carbs": totals["carbs_g"],
        "fat": totals["fat_g"],
        "_loggedMealId": meal.id,
        "_clientMealKey": meal.client_meal_key or f"log_{meal.id}",
        "_consumedAt": meal.consumed_at.isoformat() if meal.consumed_at else None,
        "_updatedAt": meal.updated_at.isoformat() if meal.updated_at else None,
        "_version": meal.version,
    }
    if meal.saved_meal_id is not None:
        payload["_savedMealId"] = meal.saved_meal_id
    if meal.source_type:
        payload["source_type"] = meal.source_type
    if meal.source_routine_id is not None:
        payload["source_routine_id"] = meal.source_routine_id
    if meal.routine_occurrence_key:
        payload["routine_occurrence_key"] = meal.routine_occurrence_key
    return payload


def _sync_updated_meal_day_state(db: Session, user_id: int, meal: Meal) -> bool:
    """Refresh the DB-backed home-plan snapshot for an edited logged meal."""
    state = db.exec(
        select(UserDayState).where(
            UserDayState.user_id == user_id,
            UserDayState.day_key == meal.meal_date,
        )
    ).first()
    if not state or not isinstance(state.nutrition_plan, dict):
        return False

    plan = dict(state.nutrition_plan)
    meals = list(plan.get("meals") or []) if isinstance(plan.get("meals"), list) else []
    if not meals:
        return False

    target_idx: int | None = None
    meal_id = int(meal.id or 0)
    for idx, candidate in enumerate(meals):
        if not isinstance(candidate, dict):
            continue
        try:
            candidate_id = int(candidate.get("_loggedMealId") or candidate.get("logged_meal_id") or 0)
        except (TypeError, ValueError):
            candidate_id = 0
        if meal_id and candidate_id == meal_id:
            target_idx = idx
            break

    client_key = str(meal.client_meal_key or "").strip().lower()
    if target_idx is None and client_key:
        for idx, candidate in enumerate(meals):
            if not isinstance(candidate, dict):
                continue
            candidate_key = str(candidate.get("_clientMealKey") or candidate.get("client_meal_key") or "").strip().lower()
            if candidate_key and candidate_key == client_key:
                target_idx = idx
                break

    if target_idx is None:
        return False

    existing = meals[target_idx] if isinstance(meals[target_idx], dict) else {}
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
    replacement = _logged_meal_to_plan_suggestion(meal, items)
    existing_client_key = existing.get("_clientMealKey") or existing.get("client_meal_key")
    if existing_client_key:
        replacement["_clientMealKey"] = existing_client_key
    for key in ("_localId", "_routineId", "isRoutine", "instructions"):
        if key in existing and key not in replacement:
            replacement[key] = existing[key]

    meals[target_idx] = replacement
    plan["meals"] = meals
    state.nutrition_plan = plan
    db.add(state)
    return True


def _favorite_for_meal(db: Session, user_id: int, meal: Meal, items: list[MealItem] | None = None) -> SavedMeal | None:
    if meal.saved_meal_id is not None:
        saved = db.get(SavedMeal, meal.saved_meal_id)
        if saved and saved.user_id == user_id:
            return saved
    if meal.id is not None:
        saved = db.exec(
            select(SavedMeal)
            .where(SavedMeal.user_id == user_id)
            .where(SavedMeal.source_meal_id == meal.id)
        ).first()
        if saved is not None:
            return saved
    if items is None:
        items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
    meal_sig = _items_signature(items)
    if not meal_sig:
        return None
    candidates = db.exec(
        select(SavedMeal)
        .where(SavedMeal.user_id == user_id)
        .where(SavedMeal.name == meal.name)
    ).all()
    for candidate in candidates:
        if _saved_items_signature(candidate.items or []) == meal_sig:
            return candidate
    return None


def _build_meal_page_response(db: Session, current_user: User, meal_id: int) -> MealPageResponse:
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
    favorite = _favorite_for_meal(db, current_user.id, meal, items)

    if favorite is not None:
        related_logs = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.saved_meal_id == favorite.id)
            .order_by(Meal.meal_date.desc(), Meal.created_at.desc())
            .limit(25)
        ).all()
    else:
        related_logs = [meal]
    if meal.id not in {m.id for m in related_logs}:
        related_logs = [meal, *related_logs]

    meal_ids = [int(m.id) for m in related_logs if m.id is not None]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list[MealItem]] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)

    logs = [_serialize_meal_with_items(m, items_by_meal.get(int(m.id or 0), [])) for m in related_logs]
    last_logged_at = max(
        (m.consumed_at or m.created_at for m in related_logs if (m.consumed_at or m.created_at)),
        default=None,
    )
    return MealPageResponse(
        meal=_serialize_meal_with_items(meal, items),
        viewer=MealPageViewer(
            is_favorite=favorite is not None,
            can_edit=True,
            saved_meal_id=favorite.id if favorite else None,
            last_logged_at=last_logged_at,
            user_specific_notes=meal.notes,
        ),
        logs=logs,
        permissions=MealPagePermissions(
            can_edit=True,
            can_delete=True,
            can_favorite=True,
            can_log=True,
        ),
    )


_MEAL_ITEM_SCALE_FIELDS = (
    "quantity",
    "serving_grams",
    "calories",
    "protein_g",
    "carbs_g",
    "fat_g",
    "saturated_fat_g",
    "trans_fat_g",
    "cholesterol_mg",
    "sodium_mg",
    "fiber_g",
    "sugar_g",
    "added_sugar_g",
    "caffeine_mg",
    "alcohol_g",
    "potassium_mg",
    "calcium_mg",
    "magnesium_mg",
    "iron_mg",
    "phosphorus_mg",
    "iodine_mcg",
    "choline_mg",
    "vitamin_d_mcg",
    "vitamin_b12_mcg",
    "vitamin_k_mcg",
    "vitamin_e_mg",
    "folate_mcg",
    "zinc_mg",
    "omega_3_g",
    "omega_3_ala_mg",
    "omega_3_epa_mg",
    "omega_3_dha_mg",
    "omega_6_mg",
)

_MEAL_ITEM_NUTRIENT_SOURCES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "saturated_fat_g": (("saturated_fat_g",), ("saturated_fat_g", "saturated_fat")),
    "trans_fat_g": (("trans_fat_g", "trans_fat"), ("trans_fat_g", "trans_fat")),
    "cholesterol_mg": (("cholesterol_mg",), ("cholesterol_mg", "cholesterol")),
    "sodium_mg": (("sodium_mg",), ("sodium_mg", "sodium")),
    "fiber_g": (("fiber_g", "fiber"), ("fiber_g", "fiber")),
    "sugar_g": (("sugar_g", "sugar"), ("sugar_g", "sugar")),
    "added_sugar_g": (("added_sugar_g", "added_sugar"), ("added_sugar_g", "added_sugar")),
    "caffeine_mg": (("caffeine_mg",), ("caffeine_mg", "caffeine")),
    "alcohol_g": (("alcohol_g", "alcohol"), ("alcohol_g", "alcohol")),
    "potassium_mg": (("potassium_mg",), ("potassium_mg", "potassium")),
    "calcium_mg": (("calcium_mg",), ("calcium_mg", "calcium")),
    "magnesium_mg": (("magnesium_mg",), ("magnesium_mg", "magnesium")),
    "iron_mg": (("iron_mg",), ("iron_mg", "iron")),
    "phosphorus_mg": (("phosphorus_mg",), ("phosphorus_mg", "phosphorus")),
    "iodine_mcg": (("iodine_mcg",), ("iodine_mcg", "iodine")),
    "choline_mg": (("choline_mg",), ("choline_mg", "choline")),
    "vitamin_d_mcg": (("vitamin_d_mcg",), ("vitamin_d_mcg", "vitamin_d")),
    "vitamin_b12_mcg": (("vitamin_b12_mcg",), ("vitamin_b12_mcg", "vitamin_b12")),
    "vitamin_k_mcg": (("vitamin_k_mcg",), ("vitamin_k_mcg", "vitamin_k")),
    "vitamin_e_mg": (("vitamin_e_mg",), ("vitamin_e_mg", "vitamin_e")),
    "folate_mcg": (("folate_mcg",), ("folate_mcg", "folate", "folate_b9")),
    "zinc_mg": (("zinc_mg",), ("zinc_mg", "zinc")),
    "omega_3_g": (("omega_3_g",), ("omega_3_g", "omega_3")),
    # Subtype mg fields preserve their own provenance. Frontend derives a
    # total mg when the subtypes are present and the legacy `omega_3_g`
    # is missing, so do NOT cross-fallback here.
    "omega_3_ala_mg": (("omega_3_ala_mg",), ("omega_3_ala_mg",)),
    "omega_3_epa_mg": (("omega_3_epa_mg",), ("omega_3_epa_mg",)),
    "omega_3_dha_mg": (("omega_3_dha_mg",), ("omega_3_dha_mg",)),
    "omega_6_mg": (("omega_6_mg",), ("omega_6_mg", "omega_6")),
}


def _scaled_value(value, factor: float):
    if value is None:
        return None
    try:
        return round(float(value) * factor, 6)
    except (TypeError, ValueError):
        return value


def _first_float_from_mapping(raw: dict, keys: tuple[str, ...]) -> float | None:
    for key in keys:
        value = raw.get(key)
        if value in (None, ""):
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _meal_item_nutrient_value(raw: dict, field: str) -> float | None:
    direct_keys, micro_keys = _MEAL_ITEM_NUTRIENT_SOURCES[field]
    value = _first_float_from_mapping(raw, direct_keys)
    if value is not None:
        return value
    micros = raw.get("micronutrients") if isinstance(raw.get("micronutrients"), dict) else {}
    return _first_float_from_mapping(micros, micro_keys)


def _meal_item_added_sugar_value(raw: dict, sugar_g: float | None, serving_grams: float | None) -> float | None:
    return resolve_added_sugar_g(
        raw.get("food_name") or raw.get("name"),
        reported_added_sugar_g=_meal_item_nutrient_value(raw, "added_sugar_g"),
        sugar_g=sugar_g,
        serving_grams=serving_grams,
    )


def _meal_item_clone_kwargs(item: MealItem, meal_id: int, factor: float = 1.0) -> dict:
    data = {
        "meal_id": meal_id,
        "food_name": item.food_name,
        "food_id": item.food_id,
        "serving_id": item.serving_id,
        "unit": item.unit,
    }
    for field in _MEAL_ITEM_SCALE_FIELDS:
        data[field] = _scaled_value(getattr(item, field, None), factor)
    return data


def _scale_meal_item_in_place(item: MealItem, factor: float) -> None:
    for field in _MEAL_ITEM_SCALE_FIELDS:
        setattr(item, field, _scaled_value(getattr(item, field, None), factor))


def _meal_date_or_default(raw: str | None, fallback: date) -> date:
    if not raw:
        return fallback
    try:
        return date.fromisoformat(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_date format. Use YYYY-MM-DD.")


def _meal_type_or_default(raw: str | None, fallback):
    if not raw:
        return fallback
    try:
        from app.enums import MealType as _MealType
        return _MealType(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_type")


def _copied_consumed_at(source: Meal, target_date: date, explicit: datetime | None) -> datetime:
    if explicit is not None:
        return explicit
    if source.consumed_at is not None:
        return datetime.combine(target_date, source.consumed_at.timetz())
    return datetime.now(timezone.utc)


# Per-meal-log refresh runs daily metrics immediately after writes. Food
# metadata uses deterministic rules first, then AI only for unresolved names
# so barcode/USDA foods do not stay stuck as `unknown`.
#
# Burst-save debounce: a user adding several meals in quick succession
# (or the watch + phone double-firing) used to trigger N consecutive
# recomputes. We coalesce by skipping refreshes within
# `_REFRESH_DEBOUNCE_SECONDS` of the last refresh for the same
# (user_id, meal_date). The skipped writes' data still lands in the
# next score/readiness fetch — both `compute_today_score` and
# `/gut-health` self-refresh on read.
import time as _time
_last_refresh_at: dict[tuple[int, date], float] = {}
_REFRESH_DEBOUNCE_SECONDS = 3.0


def _refresh_daily_metrics(db: Session, user_id: int, meal_date: date, *, force: bool = False) -> None:
    """Recompute DailyNutritionMetrics for the given user + date. Called
    after any write that changes what meals exist on that day so logged
    meal history, gut facts, and recovery signals refresh on the next read.
    Non-blocking — failures here never break the caller."""
    key = (user_id, meal_date)
    now = _time.time()
    last = _last_refresh_at.get(key, 0.0)
    if not force and now - last < _REFRESH_DEBOUNCE_SECONDS:
        return
    _last_refresh_at[key] = now
    try:
        from app.services.nutrition.gut_health import compute_daily_metrics
        compute_daily_metrics(db, user_id=user_id, metric_date=meal_date, allow_ai=True)
    except Exception:
        pass
    # Nutrition adherence is one of readiness's pillars — clear the
    # per-user cache so the next /readiness/today reflects the new meal.
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(user_id)
    except Exception:
        pass


# ─── Create ───────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_meal(
    body: MealCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    # consumed_at: honor the explicit value when the client sends one
    # (e.g. user back-logged yesterday's lunch), otherwise default to
    # now. Falling back to meal_date alone would lose time-of-day data
    # needed for fasting windows / late-eating / pre-post workout.
    from datetime import datetime as _dt, timezone as _tz, date as _date
    _md = body.meal_date
    if isinstance(_md, str):
        try:
            _md = _date.fromisoformat(_md)
        except ValueError:
            _md = None
    if getattr(body, "consumed_at", None):
        consumed_at = body.consumed_at
    elif _md == _date.today():
        consumed_at = _dt.now(_tz.utc)
    else:
        # Back-logged day with no explicit time: do NOT stamp today's
        # timestamp — that makes yesterday's lunch sort/appear as eaten today
        # (rule G). Leave NULL; clients render a null consumed_at as
        # meal_date + noon.
        consumed_at = None
    saved_meal_id = body.saved_meal_id
    if saved_meal_id is not None:
        saved = db.get(SavedMeal, saved_meal_id)
        if not saved or saved.user_id != current_user.id:
            raise HTTPException(status_code=404, detail="Saved meal not found")

    # Idempotency: a retried / double-tapped create with the same key
    # collapses to the existing row instead of inserting a duplicate.
    idem_key = (body.idempotency_key or "").strip() or None
    if idem_key:
        existing = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.idempotency_key == idem_key)
        ).first()
        if existing is not None:
            return _build_meal_response(existing, db)

    meal = Meal(
        user_id=current_user.id,
        meal_date=body.meal_date,
        meal_type=body.meal_type,
        name=body.name,
        source=body.source,
        notes=body.notes,
        consumed_at=consumed_at,
        image_url=body.image_url,
        image_source=body.image_source,
        saved_meal_id=saved_meal_id,
        source_type=(body.source_type or ("favorite" if saved_meal_id else "manual")),
        idempotency_key=idem_key,
    )
    db.add(meal)
    # Flush inside the IntegrityError guard: the (user_id, idempotency_key)
    # unique index fires on the INSERT at flush time, not at commit, so the
    # duplicate-safe recovery must wrap the flush — otherwise a racing retry
    # 500s instead of returning the already-created winning row (rule A).
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        if idem_key:
            existing = db.exec(
                select(Meal)
                .where(Meal.user_id == current_user.id)
                .where(Meal.idempotency_key == idem_key)
            ).first()
            if existing is not None:
                return _build_meal_response(existing, db)
        raise

    from app.food_service import touch_recent_food, upsert_catalog_food_from_search_item

    seen_food_ids: set[int] = set()
    for item_body in body.items:
        raw = item_body.model_dump()
        food_id = item_body.food_id
        serving_grams = item_body.serving_grams
        if food_id is None:
            raw.setdefault("name", item_body.food_name)
            imported = upsert_catalog_food_from_search_item(db, raw, user_id=current_user.id)
            if imported and imported.id is not None:
                food_id = imported.id
                if serving_grams is None:
                    serving_grams = imported.serving_grams
        sugar_g = _meal_item_nutrient_value(raw, "sugar_g")
        added_sugar_g = _meal_item_added_sugar_value(raw, sugar_g, serving_grams)
        db.add(MealItem(
            meal_id=meal.id,
            food_name=item_body.food_name,
            food_id=food_id,
            serving_id=item_body.serving_id,
            quantity=item_body.quantity,
            unit=item_body.unit,
            serving_grams=serving_grams,
            calories=item_body.calories,
            protein_g=item_body.protein_g,
            carbs_g=item_body.carbs_g,
            fat_g=item_body.fat_g,
            saturated_fat_g=_meal_item_nutrient_value(raw, "saturated_fat_g"),
            trans_fat_g=_meal_item_nutrient_value(raw, "trans_fat_g"),
            cholesterol_mg=_meal_item_nutrient_value(raw, "cholesterol_mg"),
            sodium_mg=_meal_item_nutrient_value(raw, "sodium_mg"),
            fiber_g=_meal_item_nutrient_value(raw, "fiber_g"),
            sugar_g=sugar_g,
            added_sugar_g=added_sugar_g,
            caffeine_mg=_meal_item_nutrient_value(raw, "caffeine_mg"),
            alcohol_g=_meal_item_nutrient_value(raw, "alcohol_g"),
            potassium_mg=_meal_item_nutrient_value(raw, "potassium_mg"),
            calcium_mg=_meal_item_nutrient_value(raw, "calcium_mg"),
            magnesium_mg=_meal_item_nutrient_value(raw, "magnesium_mg"),
            iron_mg=_meal_item_nutrient_value(raw, "iron_mg"),
            phosphorus_mg=_meal_item_nutrient_value(raw, "phosphorus_mg"),
            iodine_mcg=_meal_item_nutrient_value(raw, "iodine_mcg"),
            choline_mg=_meal_item_nutrient_value(raw, "choline_mg"),
            vitamin_d_mcg=_meal_item_nutrient_value(raw, "vitamin_d_mcg"),
            vitamin_b12_mcg=_meal_item_nutrient_value(raw, "vitamin_b12_mcg"),
            vitamin_k_mcg=_meal_item_nutrient_value(raw, "vitamin_k_mcg"),
            vitamin_e_mg=_meal_item_nutrient_value(raw, "vitamin_e_mg"),
            folate_mcg=_meal_item_nutrient_value(raw, "folate_mcg"),
            zinc_mg=_meal_item_nutrient_value(raw, "zinc_mg"),
            omega_3_g=_meal_item_nutrient_value(raw, "omega_3_g"),
            omega_3_ala_mg=_meal_item_nutrient_value(raw, "omega_3_ala_mg"),
            omega_3_epa_mg=_meal_item_nutrient_value(raw, "omega_3_epa_mg"),
            omega_3_dha_mg=_meal_item_nutrient_value(raw, "omega_3_dha_mg"),
            omega_6_mg=_meal_item_nutrient_value(raw, "omega_6_mg"),
        ))
        if food_id and food_id not in seen_food_ids:
            touch_recent_food(db, current_user.id, food_id, commit=False)
            seen_food_ids.add(food_id)

    try:
        db.commit()
    except IntegrityError:
        # Lost a race on the (user_id, idempotency_key) unique index — the
        # other request already created the row. Return the winner.
        db.rollback()
        if idem_key:
            existing = db.exec(
                select(Meal)
                .where(Meal.user_id == current_user.id)
                .where(Meal.idempotency_key == idem_key)
            ).first()
            if existing is not None:
                return _build_meal_response(existing, db)
        raise
    db.refresh(meal)
    _refresh_daily_metrics(db, current_user.id, meal.meal_date)
    return _build_meal_response(meal, db)


@router.patch("/{meal_id}", response_model=MealPageResponse)
def update_meal(
    meal_id: int,
    body: dict,  # accept partial — {meal_type, consumed_at, notes, name, items}
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Patch a small set of mutable fields on an existing meal. Used by
    the meal editor to change name/items/macros, `meal_type` (e.g.
    correct a mis-defaulted breakfast → pre_workout), and `consumed_at`
    (back-log time)."""
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    expected_version = body.get("version", body.get("expected_version"))
    if expected_version not in (None, ""):
        try:
            expected_version_int = int(expected_version)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="version must be an integer")
        current_version = int(getattr(meal, "version", 1) or 1)
        if expected_version_int != current_version:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "stale_meal_version",
                    "message": "Meal was updated elsewhere. Reload the meal and try again.",
                    "current": _build_meal_page_response(db, current_user, meal_id).model_dump(mode="json"),
                },
            )
    affected_dates = {meal.meal_date}
    if "meal_type" in body and body["meal_type"]:
        try:
            from app.enums import MealType as _MT
            meal.meal_type = _MT(body["meal_type"])
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid meal_type")
    if "consumed_at" in body:
        if body["consumed_at"] in (None, ""):
            meal.consumed_at = None
        else:
            from datetime import datetime as _dt
            try:
                meal.consumed_at = _dt.fromisoformat(str(body["consumed_at"]).replace("Z", "+00:00"))
            except ValueError:
                raise HTTPException(status_code=422, detail="Invalid consumed_at")
    if "notes" in body:
        meal.notes = body["notes"]
    if "name" in body and body["name"]:
        meal.name = body["name"]
        # Editing a favorite-derived log's name makes it a distinct concrete
        # meal — drop the template link and re-mark it manual (rule E).
        meal.saved_meal_id = None
        meal.source_type = "manual"
    if "image_url" in body:
        meal.image_url = body["image_url"] or None
    if "image_source" in body:
        meal.image_source = body["image_source"] or None
    if "items" in body:
        raw_items = body.get("items") or []
        if not isinstance(raw_items, list):
            raise HTTPException(status_code=422, detail="items must be a list")
        from app.food_service import touch_recent_food, upsert_catalog_food_from_search_item
        from app.models import Food, FoodServing
        def _optional_int(value):
            if value in (None, ""):
                return None
            return int(value)

        def _optional_float(value):
            if value in (None, ""):
                return None
            return float(value)

        def _valid_food_id(value):
            fid = _optional_int(value)
            if fid is None:
                return None
            food = db.get(Food, fid)
            if not food or not getattr(food, "is_active", True):
                return None
            owner_user_id = getattr(food, "owner_user_id", None)
            if owner_user_id is not None and owner_user_id != current_user.id:
                return None
            return fid

        def _valid_serving_id(value, food_id):
            sid = _optional_int(value)
            if sid is None:
                return None
            serving = db.get(FoodServing, sid)
            if not serving:
                return None
            if food_id is not None and serving.food_id != food_id:
                return None
            return sid

        db.exec(_sm_delete(MealItem).where(MealItem.meal_id == meal_id))
        db.flush()
        # Replacing items means the row no longer matches its favorite
        # template — detach and re-mark manual (rule E).
        meal.saved_meal_id = None
        meal.source_type = "manual"
        seen_food_ids: set[int] = set()
        for raw in raw_items:
            if not isinstance(raw, dict):
                raise HTTPException(status_code=422, detail="Each meal item must be an object")
            try:
                food_id = _valid_food_id(raw.get("food_id"))
                serving_grams = _optional_float(raw.get("serving_grams"))
                if food_id is None:
                    imported = upsert_catalog_food_from_search_item(db, raw, user_id=current_user.id)
                    if imported and imported.id is not None:
                        food_id = imported.id
                        if serving_grams is None:
                            serving_grams = imported.serving_grams
                sugar_g = _meal_item_nutrient_value(raw, "sugar_g")
                added_sugar_g = _meal_item_added_sugar_value(raw, sugar_g, serving_grams)
                item = MealItem(
                    meal_id=meal.id,
                    food_name=str(raw.get("food_name") or raw.get("name") or "Item"),
                    food_id=food_id,
                    serving_id=_valid_serving_id(raw.get("serving_id"), food_id),
                    quantity=float(raw.get("quantity") or 1),
                    unit=str(raw.get("unit") or "serving"),
                    serving_grams=serving_grams,
                    calories=float(raw.get("calories") or 0),
                    protein_g=float(raw.get("protein_g", raw.get("protein", 0)) or 0),
                    carbs_g=float(raw.get("carbs_g", raw.get("carbs", 0)) or 0),
                    fat_g=float(raw.get("fat_g", raw.get("fat", 0)) or 0),
                    saturated_fat_g=_meal_item_nutrient_value(raw, "saturated_fat_g"),
                    trans_fat_g=_meal_item_nutrient_value(raw, "trans_fat_g"),
                    cholesterol_mg=_meal_item_nutrient_value(raw, "cholesterol_mg"),
                    sodium_mg=_meal_item_nutrient_value(raw, "sodium_mg"),
                    fiber_g=_meal_item_nutrient_value(raw, "fiber_g"),
                    sugar_g=sugar_g,
                    added_sugar_g=added_sugar_g,
                    caffeine_mg=_meal_item_nutrient_value(raw, "caffeine_mg"),
                    alcohol_g=_meal_item_nutrient_value(raw, "alcohol_g"),
                    potassium_mg=_meal_item_nutrient_value(raw, "potassium_mg"),
                    calcium_mg=_meal_item_nutrient_value(raw, "calcium_mg"),
                    magnesium_mg=_meal_item_nutrient_value(raw, "magnesium_mg"),
                    iron_mg=_meal_item_nutrient_value(raw, "iron_mg"),
                    phosphorus_mg=_meal_item_nutrient_value(raw, "phosphorus_mg"),
                    iodine_mcg=_meal_item_nutrient_value(raw, "iodine_mcg"),
                    choline_mg=_meal_item_nutrient_value(raw, "choline_mg"),
                    vitamin_d_mcg=_meal_item_nutrient_value(raw, "vitamin_d_mcg"),
                    vitamin_b12_mcg=_meal_item_nutrient_value(raw, "vitamin_b12_mcg"),
                    vitamin_k_mcg=_meal_item_nutrient_value(raw, "vitamin_k_mcg"),
                    vitamin_e_mg=_meal_item_nutrient_value(raw, "vitamin_e_mg"),
                    folate_mcg=_meal_item_nutrient_value(raw, "folate_mcg"),
                    zinc_mg=_meal_item_nutrient_value(raw, "zinc_mg"),
                    omega_3_g=_meal_item_nutrient_value(raw, "omega_3_g"),
                    omega_3_ala_mg=_meal_item_nutrient_value(raw, "omega_3_ala_mg"),
                    omega_3_epa_mg=_meal_item_nutrient_value(raw, "omega_3_epa_mg"),
                    omega_3_dha_mg=_meal_item_nutrient_value(raw, "omega_3_dha_mg"),
                    omega_6_mg=_meal_item_nutrient_value(raw, "omega_6_mg"),
                )
            except (TypeError, ValueError):
                raise HTTPException(status_code=422, detail="Invalid meal item nutrition values")
            db.add(item)
            if food_id and food_id not in seen_food_ids:
                touch_recent_food(db, current_user.id, food_id, commit=False)
                seen_food_ids.add(food_id)
    meal.updated_at = datetime.now(timezone.utc)
    meal.version = int(getattr(meal, "version", 1) or 1) + 1
    db.add(meal)
    try:
        db.flush()
        _sync_updated_meal_day_state(db, current_user.id, meal)
        db.commit()
        db.refresh(meal)
    except Exception as e:
        try:
            db.rollback()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Could not save meal: {e!s}")
    for affected_date in affected_dates:
        _refresh_daily_metrics(db, current_user.id, affected_date, force=True)
    return _build_meal_page_response(db, current_user, meal_id)


@router.post("/{meal_id}/copy", status_code=201)
def copy_meal(
    meal_id: int,
    body: CopyMealBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Clone a logged meal, optionally onto a new date/type and scaled by
    `quantity_scale`. The clone is a normal Meal + MealItem set and does
    not inherit saved-meal/favorite provenance from the source row.

    Idempotency: a retried POST with the same client-provided
    `idempotency_key` returns the existing clone (no second copy). The
    Meal table's partial unique index (uq_meals_user_idempotency_key)
    is the durable backstop; we also fast-path with an early lookup so
    the cheap retry skips the items loop + metrics refresh entirely."""
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")

    idem_key = (body.idempotency_key or "").strip() or None
    if idem_key:
        existing = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.idempotency_key == idem_key)
        ).first()
        if existing is not None:
            return _build_meal_response(existing, db)

    items = db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all()

    target_date = _meal_date_or_default(body.meal_date, meal.meal_date)
    target_type = _meal_type_or_default(body.meal_type, meal.meal_type)
    clone = Meal(
        user_id=current_user.id,
        meal_date=target_date,
        meal_type=target_type,
        name=(body.name or meal.name).strip() or meal.name,
        source=meal.source,
        notes=body.notes if body.notes is not None else meal.notes,
        consumed_at=_copied_consumed_at(meal, target_date, body.consumed_at),
        image_url=meal.image_url,
        image_source=meal.image_source,
        # A copy is always a fresh, standalone manual log — it inherits no
        # favorite / routine / plan provenance from the source row (rule E).
        saved_meal_id=None,
        source_type="manual",
        source_routine_id=None,
        routine_occurrence_key=None,
        client_meal_key=None,
        idempotency_key=idem_key,
    )
    db.add(clone)
    try:
        db.flush()
    except IntegrityError:
        # Lost the race on (user_id, idempotency_key). Return the winner.
        db.rollback()
        if idem_key:
            existing = db.exec(
                select(Meal)
                .where(Meal.user_id == current_user.id)
                .where(Meal.idempotency_key == idem_key)
            ).first()
            if existing is not None:
                return _build_meal_response(existing, db)
        raise

    from app.food_service import touch_recent_food

    seen_food_ids: set[int] = set()
    for item in items:
        db.add(MealItem(**_meal_item_clone_kwargs(item, clone.id, body.quantity_scale)))
        if item.food_id and item.food_id not in seen_food_ids:
            touch_recent_food(db, current_user.id, item.food_id, commit=False)
            seen_food_ids.add(item.food_id)

    db.commit()
    db.refresh(clone)
    _refresh_daily_metrics(db, current_user.id, target_date, force=True)
    return _build_meal_response(clone, db)


@router.post("/{meal_id}/split", status_code=201)
def split_meal(
    meal_id: int,
    body: SplitMealBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Split a logged meal into two logged meals. The original meal keeps
    `keep_fraction`; the remainder is cloned into a second Meal row. Every
    snapshotted macro/micronutrient field scales with the quantities."""
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all()
    if not items:
        raise HTTPException(status_code=422, detail="Meal has no items to split")

    keep_fraction = float(body.keep_fraction)
    remainder_fraction = 1.0 - keep_fraction
    target_date = _meal_date_or_default(body.remaining_meal_date, meal.meal_date)
    target_type = _meal_type_or_default(body.remaining_meal_type, meal.meal_type)
    remainder = Meal(
        user_id=current_user.id,
        meal_date=target_date,
        meal_type=target_type,
        name=(body.remaining_name or f"{meal.name} split").strip() or f"{meal.name} split",
        source=meal.source,
        notes=meal.notes,
        consumed_at=_copied_consumed_at(meal, target_date, body.remaining_consumed_at),
        image_url=meal.image_url,
        image_source=meal.image_source,
        # The split-off remainder is a fresh standalone manual log (rule E).
        saved_meal_id=None,
        source_type="manual",
        source_routine_id=None,
        routine_occurrence_key=None,
        client_meal_key=None,
    )
    db.add(remainder)
    db.flush()

    from app.food_service import touch_recent_food

    seen_food_ids: set[int] = set()
    for item in items:
        db.add(MealItem(**_meal_item_clone_kwargs(item, remainder.id, remainder_fraction)))
        _scale_meal_item_in_place(item, keep_fraction)
        db.add(item)
        if item.food_id and item.food_id not in seen_food_ids:
            touch_recent_food(db, current_user.id, item.food_id, commit=False)
            seen_food_ids.add(item.food_id)
    # The kept portion is now a partial, hand-edited meal — both halves of a
    # split are plain manual logs, neither linked to a favorite/routine (rule E).
    meal.saved_meal_id = None
    meal.source_type = "manual"
    meal.source_routine_id = None
    meal.routine_occurrence_key = None
    db.add(meal)

    db.commit()
    db.refresh(meal)
    db.refresh(remainder)
    for affected_date in {meal.meal_date, target_date}:
        _refresh_daily_metrics(db, current_user.id, affected_date, force=True)
    return {
        "kept": _build_meal_response(meal, db),
        "remainder": _build_meal_response(remainder, db),
    }


# ─── List ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_meals(
    meal_date: date | None = Query(default=None),
    since: date | None = Query(default=None, description="Inclusive lower-bound meal_date"),
    before: date | None = Query(default=None, description="Inclusive upper-bound meal_date"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Paginated meal list. When no `meal_date` / `since` / `before` filter
    is supplied we default to the last 30 days so the response is always
    bounded. `skip` + `limit` for basic pagination."""
    from datetime import timedelta
    query = select(Meal).where(Meal.user_id == current_user.id)
    if meal_date:
        query = query.where(Meal.meal_date == meal_date)
    else:
        effective_since = since or (date.today() - timedelta(days=30))
        query = query.where(Meal.meal_date >= effective_since)
        if before:
            query = query.where(Meal.meal_date <= before)
    meals = db.exec(
        query.order_by(Meal.meal_date.desc(), Meal.created_at.desc())
        .offset(skip)
        .limit(limit)
    ).all()

    # Batch-load all items to avoid N+1 queries
    meal_ids = [m.id for m in meals]
    if meal_ids:
        items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
    else:
        items = []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in items:
        items_by_meal[item.meal_id].append(item)

    return [
        {**m.model_dump(), "items": [i.model_dump() for i in items_by_meal.get(m.id, [])]}
        for m in meals
    ]


# ─── Meal history endpoints (must be before /{meal_id} to avoid capture) ─────

@router.post("/log-checked", status_code=201)
def log_checked_meal(
    body: LogCheckedBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Persist a meal the user checked off from their nutrition plan."""
    from app.services.nutrition.meal_history import log_meal_from_plan
    from app.services.nutrition.allergen_filter import _item_matches_allergen, ALLERGEN_KEYWORDS
    from app.models import UserProfile

    try:
        meal_date = date.fromisoformat(body.meal_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_date format. Use YYYY-MM-DD.")

    # Idempotency short-circuit: a retried / double-tapped check-off with the
    # same key returns the existing row rather than creating a duplicate.
    idem_key = (body.idempotency_key or "").strip() or None
    if idem_key:
        existing = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.idempotency_key == idem_key)
        ).first()
        if existing is not None:
            return _build_meal_response(existing, db)

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    user_allergens = (profile.allergies if profile and hasattr(profile, "allergies") else None) or []
    if user_allergens:
        blocked_keywords: list[str] = []
        for allergen in user_allergens:
            key = allergen.strip().lower().replace(" ", "_")
            kws = ALLERGEN_KEYWORDS.get(key, [])
            blocked_keywords.extend(kws) if kws else blocked_keywords.append(key)
        if blocked_keywords:
            items = body.meal.get("items") or []
            flagged = [
                it.get("name", "Unknown") for it in items
                if isinstance(it, dict) and _item_matches_allergen(it.get("name", ""), blocked_keywords)
            ]
            if flagged:
                return {
                    "allergen_warning": True,
                    "flagged_items": flagged,
                    "message": f"Contains potential allergen(s): {', '.join(flagged[:3])}",
                }

    result = log_meal_from_plan(
        user_id=current_user.id,
        meal_date=meal_date,
        meal_type=body.meal_type,
        client_meal_key=body.client_meal_key,
        meal_data=body.meal,
        source=body.source or "plan_check",
        consumed_at=body.consumed_at,
        idempotency_key=idem_key,
        db=db,
    )
    # Idempotency key + source_type are written by log_meal_from_plan BEFORE
    # the row's first flush (rule A). No post-hoc stamping — that left a race
    # window where a concurrent retry could insert a second row before the
    # key landed.
    _refresh_daily_metrics(db, current_user.id, meal_date)
    return result


@router.post("/unlog-checked")
def unlog_checked_meal(
    body: LogCheckedBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Remove a meal history row when the user unchecks a planned meal."""
    from app.services.nutrition.meal_history import unlog_meal_from_plan

    try:
        meal_date = date.fromisoformat(body.meal_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_date format. Use YYYY-MM-DD.")

    result = unlog_meal_from_plan(
        user_id=current_user.id,
        meal_date=meal_date,
        meal_type=body.meal_type,
        client_meal_key=body.client_meal_key,
        meal_data=body.meal,
        source=body.source or "plan_check",
        db=db,
    )
    if result.get("deleted", 0) > 0:
        _refresh_daily_metrics(db, current_user.id, meal_date, force=True)
    return result


@router.get("/history")
def meal_history(
    days: int = Query(default=30, ge=1, le=365),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the user's recent meal history with items. Bounded by
    `days` lookback and `limit` (default 50, max 100)."""
    from app.services.nutrition.meal_history import get_meal_history

    return {"meals": get_meal_history(current_user.id, days=days, limit=limit, db=db)}


@router.get("/averages")
def meal_averages(
    window: int = Query(default=7, ge=1, le=90),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return rolling nutrition averages over a configurable window."""
    from app.services.nutrition.meal_history import get_rolling_averages

    return get_rolling_averages(current_user.id, window=window, db=db)


@router.get("/common")
def common_meals(
    min_count: int = Query(default=2, ge=1),
    lookback_days: int = Query(default=90, ge=1, le=180),
    limit: int = Query(default=20, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the user's most commonly eaten meals. Bounded by
    `lookback_days` (default 90, max 180) and `limit` (default 20, max 50)."""
    from app.services.nutrition.meal_history import get_common_meals

    return {"meals": get_common_meals(
        current_user.id,
        min_count=min_count,
        lookback_days=lookback_days,
        limit=limit,
        db=db,
    )}


@router.get("/insights")
def meal_insights(
    current_user: User = Depends(require_pro_feature("Nutrition insights")),
    db: Session = Depends(get_session),
):
    """Return coaching-style nutrition insights and pattern analysis."""
    from app.services.nutrition.meal_history import get_meal_insights, get_nutrition_patterns

    patterns = get_nutrition_patterns(current_user.id, days=14, db=db)
    insights = get_meal_insights(current_user.id, db=db)
    return {"insights": insights, "patterns": patterns}


@router.get("/gut-health")
def gut_health_signals(
    days: int = Query(default=7, ge=1, le=30),
    current_user: User = Depends(require_pro_feature("Nutrition insights")),
    db: Session = Depends(get_session),
):
    """Return descriptive Gut & Plants facts for today + the rolling window.
    Returns facts only — plant diversity, fermented/probiotic servings,
    omega-3 foods, processing mix, protein source split. No scores.
    The unified Nutrition Score lives at /meals/score."""
    from app.services.nutrition.gut_health import compute_daily_metrics, compute_weekly_rollup

    today = date.today()
    try:
        # The gut-health endpoint also drives the daily NutritionCard.
        # Keep normal reads deterministic; food metadata enrichment should
        # not spend AI just because the user opened the app.
        today_row = compute_daily_metrics(db, user_id=current_user.id, metric_date=today, allow_ai=False)
    except Exception:
        db.rollback()
        today_row = None

    rollup = compute_weekly_rollup(db, user_id=current_user.id, end_date=today, days=days, allow_ai=False)

    if today_row is None:
        return {"today": None, "window": rollup}

    plant_p = getattr(today_row, "plant_protein_g", 0) or 0
    animal_p = getattr(today_row, "animal_protein_g", 0) or 0
    total_p = plant_p + animal_p

    return {
        "today": {
            "date": str(today_row.metric_date),
            "calories_total": today_row.calories_total,
            "fiber_total_g": today_row.fiber_total_g,
            "fiber_per_1000_kcal": today_row.fiber_per_1000_kcal,
            "added_sugar_g": getattr(today_row, "added_sugar_g", 0) or 0,
            "sodium_mg": getattr(today_row, "sodium_mg", 0) or 0,
            "saturated_fat_g": today_row.saturated_fat_g,
            "distinct_plant_foods": today_row.distinct_plant_foods,
            "fermented_servings": today_row.fermented_servings,
            "probiotic_servings": getattr(today_row, "probiotic_servings", 0) or 0,
            "omega3_servings": today_row.omega3_servings,
            # AI-estimated amounts. `collagen_g` = grams today;
            # `probiotic_cfu_billions` = billions of CFU today.
            # 0 for either means the AI confidently found nothing OR
            # the food predates the v4 classifier (logs after v4
            # populate real numbers).
            "collagen_g": getattr(today_row, "collagen_g", 0) or 0,
            "probiotic_cfu_billions": getattr(today_row, "probiotic_cfu_billions", 0) or 0,
            "prebiotic_g": getattr(today_row, "prebiotic_g", 0) or 0,
            "seafood_servings": getattr(today_row, "seafood_servings", 0) or 0,
            "fruit_servings": getattr(today_row, "fruit_servings", 0) or 0,
            "vegetable_servings": getattr(today_row, "vegetable_servings", 0) or 0,
            "alcohol_servings": getattr(today_row, "alcohol_servings", 0) or 0,
            "processed_meat_servings": getattr(today_row, "processed_meat_servings", 0) or 0,
            "refined_grain_servings": getattr(today_row, "refined_grain_servings", 0) or 0,
            "plant_protein_g": plant_p,
            "animal_protein_g": animal_p,
            "plant_protein_pct": round(100 * plant_p / total_p) if total_p > 0 else 0,
            "processing_counts": today_row.processing_counts or {},
            "max_meal_protein_pct": getattr(today_row, "max_meal_protein_pct", 0) or 0,
            "classified_item_count": today_row.classified_item_count,
            "item_count": today_row.item_count,
        },
        "window": rollup,
    }


@router.get("/protein-breakdown")
def protein_breakdown_today(
    current_user: User = Depends(require_pro_feature("Nutrition insights")),
    db: Session = Depends(get_session),
):
    """Per-food plant vs animal protein contributions for today.

    Joins MealItem → Food → FoodMetadata to bucket each item's protein
    grams by `protein_source` ('plant' | 'animal' | 'mixed' | 'none' |
    'unknown'). Powers the NutritionCard plant-vs-meat tile + drill-
    down modal. Mixed items get their grams split 50/50 between plant
    and animal so the totals add up to the day's total protein. Custom
    foods without a metadata row default to 'unknown' and don't show
    in either bucket — but their grams are surfaced under `unclassified`
    so the UI can prompt the user to classify.
    """
    from app.models import Meal, MealItem, FoodMetadata
    from app.services.nutrition.ai_classify import get_or_create_metadata
    from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, normalize_name
    from sqlalchemy import and_, func as _sa_func, or_
    today_d = date.today()
    items = db.exec(
        select(MealItem)
        .join(Meal, Meal.id == MealItem.meal_id)
        .where(Meal.user_id == current_user.id)
        .where(or_(
            _sa_func.date(Meal.consumed_at) == today_d,
            and_(Meal.consumed_at.is_(None), Meal.meal_date == today_d),
        ))
    ).all()
    normalized_names = {normalize_name(item.food_name) for item in items if item.food_name}
    metas = db.exec(
        select(FoodMetadata)
        .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
        .where(FoodMetadata.normalized_name.in_(normalized_names))
    ).all() if normalized_names else []
    meta_by_name = {m.normalized_name: m for m in metas}

    plant: list[dict] = []
    animal: list[dict] = []
    unclassified: list[dict] = []
    plant_total = 0.0
    animal_total = 0.0
    # Aggregate by food name within each bucket so a user who logs
    # "Chicken" three times sees one row with combined grams, not three
    # rows with 30g each.
    plant_agg: dict[str, float] = {}
    animal_agg: dict[str, float] = {}
    uncls_agg: dict[str, float] = {}

    for item in items:
        protein_g = float(item.protein_g or 0.0)
        if protein_g <= 0:
            continue
        norm = normalize_name(item.food_name)
        meta = meta_by_name.get(norm)
        if meta is None:
            try:
                meta = get_or_create_metadata(item.food_name, db=db, allow_ai=False)
                meta_by_name[norm] = meta
            except Exception:
                meta = None
        source = (meta.protein_source if meta else "unknown") or "unknown"
        name = item.food_name
        if source == "plant":
            plant_agg[name] = plant_agg.get(name, 0.0) + protein_g
            plant_total += protein_g
        elif source == "animal":
            animal_agg[name] = animal_agg.get(name, 0.0) + protein_g
            animal_total += protein_g
        elif source == "mixed":
            half = protein_g / 2.0
            plant_agg[name] = plant_agg.get(name, 0.0) + half
            animal_agg[name] = animal_agg.get(name, 0.0) + half
            plant_total += half
            animal_total += half
        else:
            # 'none' / 'unknown' — surface as unclassified so the UI
            # can prompt the user. We don't bucket into either side.
            uncls_agg[name] = uncls_agg.get(name, 0.0) + protein_g

    plant = [{"name": n, "protein_g": round(g, 1)} for n, g in sorted(plant_agg.items(), key=lambda x: -x[1])]
    animal = [{"name": n, "protein_g": round(g, 1)} for n, g in sorted(animal_agg.items(), key=lambda x: -x[1])]
    unclassified = [{"name": n, "protein_g": round(g, 1)} for n, g in sorted(uncls_agg.items(), key=lambda x: -x[1])]

    total_known = plant_total + animal_total
    return {
        "date": str(today_d),
        "plant_total_g": round(plant_total, 1),
        "animal_total_g": round(animal_total, 1),
        "plant_pct": round(100.0 * plant_total / total_known) if total_known > 0 else 0,
        "animal_pct": round(100.0 * animal_total / total_known) if total_known > 0 else 0,
        "plant": plant,
        "animal": animal,
        "unclassified": unclassified,
    }


class DailyMacrosBody(BaseModel):
    """Body for /meals/daily-macros — the base weekly targets plus
    today's planned workout context. Returns macros redistributed for
    the day. Calories + protein unchanged; carbs shift by day type;
    fat absorbs the kcal delta. See `carb_distribution.py` for rules."""
    base_calories: int
    base_protein_g: int
    base_carbs_g: int
    base_fat_g: int
    fat_floor_g: int | None = None
    min_carbs_g: int | None = None
    archetype: str | None = None
    focus: str | None = None
    activity_category: str | None = None
    cardio_style: str | None = None
    stimulus: str | None = None


@router.post("/daily-macros")
def daily_macros_for_day(
    body: DailyMacrosBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return today's macros redistributed for the scheduled workout.

    Weekly calories + protein stay constant — this endpoint only
    shifts carbs up on hard / leg days and down on rest / easy days,
    with fat absorbing the kcal delta. Pure function; no side
    effects. Client calls it once per day or whenever the day's
    archetype changes."""
    from app.services.nutrition.carb_distribution import (
        MacroSet, redistribute_for_day,
    )
    # Look up goal for the per-goal shift cap (fat loss tightens, bulk
    # widens). Falls back to a middle cap if no goal is set.
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == current_user.id, UserGoal.is_active == True)
    ).first()
    goal_bucket = (goal.goal_type.value if goal and hasattr(goal.goal_type, "value") else None) or "general_health"

    base = MacroSet(
        calories=body.base_calories,
        protein_g=body.base_protein_g,
        carbs_g=body.base_carbs_g,
        fat_g=body.base_fat_g,
        fat_floor_g=body.fat_floor_g,
        min_carbs_g=body.min_carbs_g,
    )
    adjusted, day_type = redistribute_for_day(
        base,
        archetype=body.archetype,
        focus=body.focus,
        activity_category=body.activity_category,
        cardio_style=body.cardio_style,
        stimulus=body.stimulus,
        goal_bucket=goal_bucket,
    )
    macro_override = None
    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id, UserDayState.day_key == date.today())
    ).first()
    if state and state.macro_overrides:
        extra_carbs = int((state.macro_overrides or {}).get("carb_bump_g") or 0)
        if extra_carbs > 0:
            adjusted = MacroSet(
                calories=adjusted.calories + extra_carbs * 4,
                protein_g=adjusted.protein_g,
                carbs_g=adjusted.carbs_g + extra_carbs,
                fat_g=adjusted.fat_g,
                fat_floor_g=adjusted.fat_floor_g,
                min_carbs_g=adjusted.min_carbs_g,
            )
            macro_override = {
                "type": "carb_bump_today",
                "carb_bump_g": extra_carbs,
                "source": (state.macro_overrides or {}).get("source") or "coach",
            }
    return {
        "day_type": day_type,
        "goal": goal_bucket,
        "base": base.to_dict(),
        "adjusted": adjusted.to_dict(),
        "carb_delta_g": adjusted.carbs_g - base.carbs_g,
        "fat_delta_g": adjusted.fat_g - base.fat_g,
        "macro_override": macro_override,
    }


class HydrationLogBody(BaseModel):
    # Absolute set: caller computes the new total client-side. Used by
    # explicit "set to N oz" UI. Loses increments under concurrent taps
    # because the client may compute `next` from a stale snapshot.
    ounces: Optional[float] = None
    # Atomic increment: server reads the current row, adds the delta,
    # writes back in one transaction. Use this for quick-add buttons so
    # rapid taps compose correctly (the client otherwise sends three
    # POSTs that all reference the same pre-tap value).
    delta_oz: Optional[float] = None
    log_date: Optional[str] = None   # YYYY-MM-DD, defaults to today
    command_id: Optional[str] = None


@router.post("/hydration")
def log_hydration(
    body: HydrationLogBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Log hydration for a given day. Stored on UserDayState.nutrition_plan
    under _hydration_oz — lightweight, survives app kill via existing sync.

    Two modes:
      - delta_oz: atomic increment. Reads current value under a row lock,
        adds the delta, writes back. Concurrent +8oz taps compose to +24
        because each request reads the prior request's committed value.
      - ounces: absolute set. Client owns the math. Use only for explicit
        "set to N" UI, never for quick-add buttons.

    Exactly one of delta_oz / ounces must be set. If both are provided
    we honor delta_oz (the additive operation is the safer default)."""
    from datetime import date as _date
    try:
        d = _date.fromisoformat(body.log_date) if body.log_date else _date.today()
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid log_date")

    if body.delta_oz is None and body.ounces is None:
        raise HTTPException(status_code=422, detail="Provide either delta_oz or ounces")

    command_id = (body.command_id or "").strip()
    command_event = None
    if command_id:
        command_event = db.exec(
            select(WatchCommandEvent)
            .where(WatchCommandEvent.user_id == current_user.id)
            .where(WatchCommandEvent.command_id == command_id)
        ).first()
        if command_event and command_event.status == "applied" and isinstance(command_event.result_json, dict):
            return command_event.result_json

    # SELECT FOR UPDATE locks the row in Postgres so the read+write below
    # is atomic across concurrent requests. SQLite serializes writes at
    # the connection level so the lock is a no-op there but the semantics
    # still hold.
    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id)
        .where(UserDayState.day_key == d)
        .with_for_update()
    ).first()
    if state is None:
        state = UserDayState(user_id=current_user.id, day_key=d)
        db.add(state)
        db.flush()
    plan = dict(state.nutrition_plan or {})
    try:
        prior = float(plan.get("_hydration_oz", 0) or 0)
    except (TypeError, ValueError):
        prior = 0.0
    if body.delta_oz is not None:
        new_total = max(0.0, round((prior + float(body.delta_oz)) * 10) / 10)
    else:
        new_total = max(0.0, float(body.ounces))
    plan["_hydration_oz"] = new_total
    state.nutrition_plan = plan
    result = {"date": str(d), "ounces": new_total}
    if command_id:
        command_event = command_event or WatchCommandEvent(
            user_id=current_user.id,
            command_id=command_id,
            command="log_hydration",
            payload=body.model_dump(exclude_none=True),
        )
        command_event.command = "log_hydration"
        command_event.payload = body.model_dump(exclude_none=True)
        command_event.status = "applied"
        command_event.result_json = result
        command_event.applied_at = datetime.now(timezone.utc)
        db.add(command_event)
    db.commit()
    return result


def _compute_hydration_target_oz(
    weight_lbs: float | None,
    gender: "Gender | None",
    workout_minutes_today: float = 0.0,
    protein_g_today: float = 0.0,
    alcohol_servings_today: float = 0.0,
) -> tuple[int, dict]:
    """Evidence-based daily hydration target in fluid ounces, plus a
    breakdown of which signals contributed so the UI can explain "why
    your number is what it is."

    The previous formula was just `weight_lbs / 2` — a popular gym-bro rule
    that's a rough approximation of 30 ml/kg but breaks at the extremes
    (a 100 lb person doesn't need only 50 oz; a 350 lb person doesn't need
    175 oz). This version layers four evidence-supported signals:

      1. **Bodyweight × sex** — base rate aligned to IOM / National
         Academies total-water guidance (~3.7 L men, ~2.7 L women). Males
         default higher because of greater lean mass and sweat rate.
      2. **Activity** — sweat replacement, ~16 oz per 30 min of training.
         Caller passes MAX(planned, actually-completed) minutes so a user
         who trained extra (or unplanned) gets the bump.
      3. **Protein-heavy diet** — kidneys process nitrogen waste with water.
         Active users at >1 g/lb consumed get +8 oz; >1.5 g/lb (very high)
         gets +16 oz. No bonus until the user actually eats the protein —
         the target reflects today's load, not a target.
      4. **Alcohol** — net diuretic. +12 oz per standard drink already
         logged today, capped at +36 oz so the recommendation doesn't
         become punitive on a heavy night.

    Output: (target_ounces, breakdown_dict). Breakdown keys: `base`,
    `activity`, `protein`, `alcohol` — each in oz, all integers. UI can
    render them as a stack or expose on tap.

    Pre-bonus base is clamped to [64, 140] — floor matches IOM lower bound
    for healthy adults at rest; ceiling guards against dilutional
    hyponatremia for very heavy users where the linear scaling would
    otherwise suggest dangerous amounts. Bonuses are added AFTER the cap
    because the science supports the additional needs they represent.
    """
    from app.enums import Gender as _Gender

    weight = weight_lbs if (weight_lbs and weight_lbs > 0) else 150.0
    # 0.52 oz/lb ≈ 35 ml/kg (men), 0.45 oz/lb ≈ 30 ml/kg (women).
    if gender == _Gender.MALE:
        oz_per_lb = 0.52
    elif gender == _Gender.FEMALE:
        oz_per_lb = 0.45
    else:
        oz_per_lb = 0.48
    base = max(64.0, min(140.0, weight * oz_per_lb))

    # Activity bonus — capped at +48 oz so a 90-min session doesn't push
    # the total to hyponatremia territory; anything beyond that should be
    # paired with electrolytes anyway.
    activity_bonus = min(48.0, max(0.0, workout_minutes_today / 30.0) * 16.0)

    # Protein bonus — keyed off TODAY'S CONSUMED protein, not target. Means
    # the recommendation rises as the user logs heavy-protein meals during
    # the day rather than asking them to drink ahead of an aspirational
    # number. Threshold is per-pound bodyweight so it scales with user size.
    protein_bonus = 0.0
    if protein_g_today and weight > 0:
        per_lb = protein_g_today / weight
        if per_lb >= 1.5:
            protein_bonus = 16.0
        elif per_lb >= 1.0:
            protein_bonus = 8.0

    # Alcohol bonus — diuretic effect. Capped at +36 oz so a binge doesn't
    # explode the recommendation; capping is also defensive (heavy intake
    # has bigger problems than fluid balance).
    alcohol_bonus = min(36.0, max(0.0, alcohol_servings_today) * 12.0)

    target = round(base + activity_bonus + protein_bonus + alcohol_bonus)
    breakdown = {
        "base": round(base),
        "activity": round(activity_bonus),
        "protein": round(protein_bonus),
        "alcohol": round(alcohol_bonus),
    }
    return target, breakdown


def _matches_hydration_supplement_signal(item, ingredient, tokens: tuple[str, ...]) -> bool:
    haystack = " ".join(
        str(v or "")
        for v in (
            getattr(ingredient, "slug", None),
            getattr(ingredient, "name", None),
            getattr(ingredient, "category", None),
            getattr(item, "custom_name", None),
            getattr(item, "category", None),
            getattr(item, "notes", None),
        )
    ).lower().replace("_", " ").replace("-", " ").replace(".", "")
    return any(token in haystack for token in tokens)


def _hydration_supplement_flags(db: Session, user_id: int, target_date: date) -> dict:
    from datetime import datetime as _dt, time as _time, timezone as _timezone, timedelta
    from app.models import SupplementIngredient, SupplementLog, UserSupplementStack

    flags = {
        "electrolytes_in_stack": False,
        "electrolytes_logged": False,
        "creatine_in_stack": False,
        "creatine_logged": False,
        "caffeine_in_stack": False,
        "caffeine_logged": False,
    }
    stack = db.exec(
        select(UserSupplementStack).where(
            UserSupplementStack.user_id == user_id,
            UserSupplementStack.active == True,  # noqa: E712
        )
    ).all()
    if not stack:
        return flags

    ing_ids = [s.supplement_ingredient_id for s in stack if s.supplement_ingredient_id]
    ingredients = {}
    if ing_ids:
        rows = db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ing_ids))).all()
        ingredients = {r.id: r for r in rows}

    start = _dt.combine(target_date, _time.min, tzinfo=_timezone.utc)
    end = start + timedelta(days=1)
    stack_ids = [s.id for s in stack if s.id is not None]
    logged_ids: set[int] = set()
    if stack_ids:
        logs = db.exec(
            select(SupplementLog).where(
                SupplementLog.user_id == user_id,
                SupplementLog.stack_item_id.in_(stack_ids),
                SupplementLog.taken_at >= start,
                SupplementLog.taken_at < end,
                SupplementLog.skipped == False,  # noqa: E712
            )
        ).all()
        logged_ids = {int(log.stack_item_id) for log in logs if log.stack_item_id is not None}

    signals = (
        ("electrolytes", ("electrolyte", "sodium", "salt", "lmnt", "nuun", "liquid iv", "hydration")),
        ("creatine", ("creatine",)),
        ("caffeine", ("caffeine", "pre workout", "preworkout")),
    )
    for item in stack:
        ingredient = ingredients.get(item.supplement_ingredient_id) if item.supplement_ingredient_id else None
        for key, tokens in signals:
            if _matches_hydration_supplement_signal(item, ingredient, tokens):
                flags[f"{key}_in_stack"] = True
                if item.id in logged_ids:
                    flags[f"{key}_logged"] = True
    return flags


def _build_hydration_guidance(
    workout_minutes_today: float,
    sodium_mg_today: float,
    supplement_flags: dict | None = None,
) -> dict:
    flags = {
        "electrolytes_in_stack": False,
        "electrolytes_logged": False,
        "creatine_in_stack": False,
        "creatine_logged": False,
        "caffeine_in_stack": False,
        "caffeine_logged": False,
        **(supplement_flags or {}),
    }
    workout_minutes = max(0.0, float(workout_minutes_today or 0))
    sodium_mg = max(0, round(float(sodium_mg_today or 0)))
    electrolyte = {
        "status": "not_needed",
        "message": None,
        "sodium_mg": sodium_mg,
        "has_electrolytes_in_stack": bool(flags["electrolytes_in_stack"]),
        "electrolytes_logged": bool(flags["electrolytes_logged"]),
    }

    if workout_minutes >= 60:
        if flags["electrolytes_logged"]:
            electrolyte.update({
                "status": "covered",
                "message": "Longer session today. Logged electrolytes can help replace sweat sodium; keep fluids near target and avoid forcing extra water.",
            })
        elif flags["electrolytes_in_stack"]:
            electrolyte.update({
                "status": "planned",
                "message": "Longer session today. You have electrolytes in your stack; use them around the session if you sweat heavily.",
            })
        elif 0 < sodium_mg < 1500:
            electrolyte.update({
                "status": "consider",
                "message": f"Longer session + only {sodium_mg} mg sodium logged so far. Pair some fluids with electrolytes or a salty meal if you sweat heavily.",
            })
        else:
            electrolyte.update({
                "status": "consider",
                "message": "Longer session today. If you sweat heavily, pair some fluids with electrolytes or sodium; plain water alone may not replace sweat salt.",
            })

    notes = []
    if sodium_mg >= 3500:
        notes.append({
            "key": "high_sodium",
            "message": "High sodium can increase thirst, but it should not automatically raise the water range. Keep the range steady and follow thirst.",
        })
    if flags["creatine_in_stack"] or flags["creatine_logged"]:
        notes.append({
            "key": "creatine",
            "message": "Creatine can shift water into muscle, but it does not need a fixed extra-water bonus.",
        })
    if flags["caffeine_logged"]:
        notes.append({
            "key": "caffeine",
            "message": "Typical caffeine intake can still contribute fluid; very high doses are the hydration caveat.",
        })

    return {
        "workout_minutes": round(workout_minutes, 1),
        "sodium_mg": sodium_mg,
        "electrolytes": electrolyte,
        "supplements": flags,
        "notes": notes,
    }


@router.get("/hydration")
def get_hydration(
    log_date: Optional[str] = Query(default=None, description="YYYY-MM-DD, defaults to today"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Logged ounces + a per-day target range for the requested date.

    Defaults to today. The midpoint target reflects the user's weight, sex,
    planned + actual workout minutes, that day's protein intake,
    and any alcohol logged. Sodium and supplements are returned as guidance
    signals, but they do not inflate the ounce target by themselves. See
    `services.nutrition.hydration.compute_hydration_target_oz` for the
    formula and breakdown."""
    from datetime import date as _date
    from app.models import (
        UserProfile, PlanDay, WorkoutCompletion, DailyHealthSnapshot, DailyNutritionMetrics,
    )
    from app.services.nutrition.hydration import compute_hydration_target_oz
    try:
        d = _date.fromisoformat(log_date) if log_date else _date.today()
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid log_date")
    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id)
        .where(UserDayState.day_key == d)
    ).first()
    oz = 0.0
    if state and state.nutrition_plan:
        try:
            oz = float((state.nutrition_plan or {}).get("_hydration_oz", 0) or 0)
        except Exception:
            oz = 0.0
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == current_user.id)).first()

    # Workout demand — before training, use the planned session as a
    # forecast; after training, use the actual completed rows so a cut-short
    # workout does not keep the larger planned hydration bump.
    planned_minutes = 0.0
    planned_meta: dict[str, str | None] = {
        "activity_category": None,
        "activity_intensity": None,
        "cardio_style": None,
        "stimulus": None,
    }

    def _planned_hydration_meta(workout_json: dict) -> dict[str, str | None]:
        focus = str(workout_json.get("focus") or workout_json.get("day") or "")
        stimulus = str(workout_json.get("stimulus") or "")
        archetype = str(workout_json.get("archetype") or "")
        text = f"{focus} {stimulus} {archetype}".lower()
        if any(token in text for token in ("mobility", "yoga", "stretch", "foam")):
            return {
                "activity_category": "mobility",
                "activity_intensity": "easy",
                "cardio_style": "recovery",
                "stimulus": stimulus or "mobility",
            }
        if "recovery" in text:
            return {
                "activity_category": "recovery",
                "activity_intensity": "easy",
                "cardio_style": "recovery",
                "stimulus": stimulus or "recovery",
            }
        if any(token in text for token in ("interval", "hiit", "sprint")):
            return {
                "activity_category": "cardio",
                "activity_intensity": "hard",
                "cardio_style": "intervals",
                "stimulus": stimulus or "conditioning",
            }
        if any(token in text for token in ("cardio", "conditioning", "zone 2", "zone2", "tempo", "cond_")):
            return {
                "activity_category": "cardio",
                "activity_intensity": "moderate",
                "cardio_style": "steady",
                "stimulus": stimulus or "conditioning",
            }
        return {
            "activity_category": "strength",
            "activity_intensity": "hard" if any(token in text for token in ("strength", "power", "heavy")) else "moderate",
            "cardio_style": None,
            "stimulus": stimulus or None,
        }

    try:
        plan_day = db.exec(
            select(PlanDay)
            .where(PlanDay.user_id == current_user.id)
            .where(PlanDay.day_date == d)
        ).first()
        if plan_day and plan_day.workout_json and not plan_day.is_rest:
            wj = plan_day.workout_json or {}
            planned_minutes = float(
                wj.get("session_minutes")
                or wj.get("duration_minutes")
                or 0
            )
            planned_meta = _planned_hydration_meta(wj)
    except Exception:
        pass
    actual_minutes = 0.0
    actual_kcal = 0.0
    top_row = None
    try:
        from app.services.nutrition.activity_adjustment import MIN_ACTIVITY_BONUS_DURATION_SECONDS
        completed = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.workout_date == d)
        ).all()
        # Match the calorie-bonus filter so hydration and calorie
        # targets move in lockstep — sub-5-minute completions (test
        # workouts for share screens, accidental tap-throughs) don't
        # bump the target, and deleting them doesn't "reset" it.
        completed = [
            c for c in completed
            if (c.duration_seconds or 0) >= MIN_ACTIVITY_BONUS_DURATION_SECONDS
        ]
        actual_minutes = sum((c.duration_seconds or 0) / 60.0 for c in completed)
        actual_kcal = sum(float(c.calories_burned or 0) for c in completed)

        def _row_demand_rank(row) -> int:
            style = str(getattr(row, "cardio_style", "") or "").lower()
            cat = str(getattr(row, "activity_category", "") or "").lower()
            stim = str(getattr(row, "stimulus", "") or "").lower()
            intensity = str(getattr(row, "activity_intensity", "") or "").lower()
            if style == "intervals" or stim == "conditioning" or intensity == "hard":
                return 4
            if cat in {"cardio", "sport"}:
                return 3
            if cat == "strength":
                return 2
            if style in {"recovery", "easy"} or cat in {"mobility", "recovery", "active"}:
                return 0
            return 1

        top_row = max(completed, key=_row_demand_rank, default=None)
    except Exception:
        pass
    workout_minutes = actual_minutes if actual_minutes > 0 else planned_minutes

    hydration_category = getattr(top_row, "activity_category", None) if top_row else planned_meta.get("activity_category")
    hydration_intensity = getattr(top_row, "activity_intensity", None) if top_row else planned_meta.get("activity_intensity")
    hydration_cardio_style = getattr(top_row, "cardio_style", None) if top_row else planned_meta.get("cardio_style")
    hydration_stimulus = getattr(top_row, "stimulus", None) if top_row else planned_meta.get("stimulus")

    active_energy_kcal = None
    try:
        snapshot = db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == current_user.id)
            .where(DailyHealthSnapshot.snapshot_date == d)
        ).first()
        if snapshot and snapshot.active_energy_kcal is not None and float(snapshot.active_energy_kcal) > 0:
            active_energy_kcal = float(snapshot.active_energy_kcal)
    except Exception:
        active_energy_kcal = None
    hydration_energy_kcal = max(
        [value for value in (active_energy_kcal, actual_kcal if actual_kcal > 0 else None) if value is not None],
        default=None,
    )

    # Diet signals — protein consumed today (drives kidney filtration load)
    # and alcohol servings (diuretic). Both are computed by the meal
    # pipeline and stored on DailyNutritionMetrics; missing rows just zero
    # out the bonuses.
    protein_today = 0.0
    alcohol_today = 0.0
    sodium_today = 0.0
    try:
        metrics = db.exec(
            select(DailyNutritionMetrics)
            .where(DailyNutritionMetrics.user_id == current_user.id)
            .where(DailyNutritionMetrics.metric_date == d)
        ).first()
        if metrics:
            protein_today = float((metrics.plant_protein_g or 0) + (metrics.animal_protein_g or 0))
            alcohol_today = float(metrics.alcohol_servings or 0)
            sodium_today = float(metrics.sodium_mg or 0)
    except Exception:
        pass

    supplement_flags = _hydration_supplement_flags(db, current_user.id, d)
    guidance = _build_hydration_guidance(workout_minutes, sodium_today, supplement_flags)
    profile_gender = (
        str(profile.gender.value)
        if (profile and profile.gender is not None and hasattr(profile.gender, "value"))
        else (str(profile.gender) if profile and profile.gender is not None else None)
    )
    hydration_target = compute_hydration_target_oz(
        bodyweight_lb=profile.weight_lbs if profile else None,
        workout_duration_min=workout_minutes,
        workout_intensity=hydration_intensity,
        active_energy_kcal=hydration_energy_kcal,
        protein_g_today=protein_today,
        alcohol_servings_today=alcohol_today,
        cardio_style=hydration_cardio_style,
        activity_category=hydration_category,
        stimulus=hydration_stimulus,
        sex=profile_gender,
        age=int(profile.age) if (profile and profile.age) else None,
    )
    breakdown = {
        "base": hydration_target["baseline_oz"],
        "activity": (
            hydration_target["training_addon_oz"]
            + hydration_target["active_energy_addon_oz"]
            + hydration_target["heat_addon_oz"]
        ),
        "protein": hydration_target["protein_addon_oz"],
        "alcohol": hydration_target["alcohol_addon_oz"],
        "target_min_oz": hydration_target["target_min_oz"],
        "target_max_oz": hydration_target["target_max_oz"],
        "training": hydration_target["training_addon_oz"],
        "active_energy": hydration_target["active_energy_addon_oz"],
        "heat": hydration_target["heat_addon_oz"],
        "intensity": hydration_target.get("intensity_bucket"),
        "reason": hydration_target.get("reason"),
    }
    guidance.update({
        "active_energy_kcal": round(active_energy_kcal) if active_energy_kcal is not None else None,
        "workout_calories_burned": round(actual_kcal) if actual_kcal > 0 else None,
        "activity_category": hydration_category,
        "activity_intensity": hydration_intensity,
        "cardio_style": hydration_cardio_style,
        "target_reason": hydration_target.get("reason"),
    })
    return {
        "date": str(d),
        "ounces": round(oz, 1),
        "target_ounces": hydration_target["target_oz"],
        "target_ounces_min": hydration_target["target_min_oz"],
        "target_ounces_max": hydration_target["target_max_oz"],
        "breakdown": breakdown,
        "guidance": guidance,
    }


@router.get("/score")
def nutrition_score_endpoint(
    days: int = Query(default=7, ge=1, le=30),
    current_user: User = Depends(require_pro_feature("Nutrition scoring")),
    db: Session = Depends(get_session),
):
    """Authoritative projected Nutrition Score for today + rolling window.
    This is the server-side source of truth; the client renders it verbatim."""
    from app.services.nutrition.score_builder import compute_today_score, compute_weekly_score

    today = compute_today_score(db, current_user.id)
    weekly = compute_weekly_score(db, current_user.id, days=days)
    return {"today": today, "weekly": weekly}


@router.get("/recovery-flags")
def recovery_flags_endpoint(
    days: int = Query(default=7, ge=5, le=30),
    thyroid_opt_in: bool = Query(default=False),
    current_user: User = Depends(require_pro_feature("Recovery tracking")),
    db: Session = Depends(get_session),
):
    """Fueling & Recovery Signals. Flag-based (green/amber/red/not_enough_data).
    Never a score. Never hormone-named. Returns a list of flags the client
    renders as a conditional chip strip or dedicated drill-down."""
    from app.services.nutrition.recovery_flags import (
        compute_flags, flags_to_dict,
    )
    flags = compute_flags(db, current_user.id, days=days, thyroid_opt_in=thyroid_opt_in)
    payload = flags_to_dict(flags)
    payload["any_actionable"] = any(f.state in ("amber", "red") for f in flags)
    return payload


# ─── Weekly calorie smoothing ─────────────────────────────────────────────────


@router.get("/adjusted-daily-target")
def adjusted_daily_target(
    target_date: date = Query(default=None, description="Date to compute adjustment for (defaults to today)"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return a smoothed daily calorie target for the current week.

    When the user has logged more or fewer calories than their weekly target
    allows, this endpoint spreads the difference across the remaining days
    rather than creating a harsh single-day swing.
    The target is computed from completed prior days only, so today's weekly
    smoothing stays stable while the user logs meals during the day.

    The response includes:
      - ``adjusted_calories``: recommended daily target for remaining days
      - ``base_daily_target``: unmodified per-day target from the user's plan
      - ``adjustment_applied``: signed delta (negative = cut, positive = add)
      - ``at_cap``: True when the adjustment was clipped by the goal cap
      - ``adjusted_macros``: carbs/fat redistributed to hit adjusted_calories
        (protein is always kept stable)
      - ``note``: human-readable explanation
    """
    from datetime import date as date_cls, timedelta
    from app.services.nutrition.meal_history import dedupe_meals_for_aggregation
    from app.services.nutrition.targets import resolve_targets_for_user
    from app.services.nutrition.activity_adjustment import (
        DEFAULT_PLANNED_WORKOUT_KCAL_ALLOWANCE,
        compute_activity_target_adjustment,
    )
    from app.services.nutrition.weekly_calorie_budget import (
        CalorieDay, compute_adjusted_daily_target, compute_adjusted_macros,
    )
    from app.services.nutrition.carb_distribution import MacroSet, redistribute_for_day
    from app.services.nutrition.hydration import compute_hydration_target_oz
    from app.models import DailyHealthSnapshot, PlanDay, UserProfile

    today = target_date or date_cls.today()
    # Day of week: Monday=0 … Sunday=6. Days remaining = 7 - weekday (includes today)
    days_remaining = 7 - today.weekday()

    # Week start = most recent Monday
    week_start = today - timedelta(days=today.weekday())
    completed_days_end = today - timedelta(days=1)

    # Calories logged on completed days this week. Excluding the selected
    # date keeps its weekly smoothing value fixed from morning through night;
    # today's intake is reconciled by the next start-of-day calculation.
    week_meals = db.exec(
        select(Meal).where(
            Meal.user_id == current_user.id,
            Meal.meal_date >= week_start,
            Meal.meal_date < today,
        )
    ).all() if completed_days_end >= week_start else []
    calories_by_day: dict[date_cls, float] = {}
    meal_ids = [m.id for m in week_meals]
    if meal_ids:
        items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
        items_by_meal: dict[int, list] = defaultdict(list)
        for item in items:
            items_by_meal[item.meal_id].append(item)
        week_meals = dedupe_meals_for_aggregation(week_meals, items_by_meal)
        kept_meal_ids = {m.id for m in week_meals}
        meal_date_by_id = {m.id: m.meal_date for m in week_meals if m.id is not None}
        for item in items:
            if item.meal_id not in kept_meal_ids:
                continue
            meal_day = meal_date_by_id.get(item.meal_id)
            if meal_day is None:
                continue
            calories_by_day[meal_day] = calories_by_day.get(meal_day, 0.0) + float(item.calories or 0)
        calories_this_week = sum(calories_by_day.values())
    else:
        calories_this_week = 0.0

    plan_day_by_date: dict[date_cls, PlanDay] = {}
    for pd in db.exec(
        select(PlanDay)
        .where(PlanDay.user_id == current_user.id)
        .where(PlanDay.day_date >= week_start)
        .where(PlanDay.day_date <= today)
    ).all():
        existing = plan_day_by_date.get(pd.day_date)
        if existing is None or (pd.id or 0) >= (existing.id or 0):
            plan_day_by_date[pd.day_date] = pd

    day_state_by_date: dict[date_cls, UserDayState] = {
        row.day_key: row
        for row in db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == current_user.id)
            .where(UserDayState.day_key >= week_start)
            .where(UserDayState.day_key <= today)
        ).all()
    }
    snapshots_by_date: dict[date_cls, DailyHealthSnapshot] = {
        row.snapshot_date: row
        for row in db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == current_user.id)
            .where(DailyHealthSnapshot.snapshot_date >= week_start)
            .where(DailyHealthSnapshot.snapshot_date <= today)
        ).all()
    }
    activity_rows_by_date: dict[date_cls, list[WorkoutCompletion]] = defaultdict(list)
    for row in db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date >= week_start)
        .where(WorkoutCompletion.workout_date <= today)
    ).all():
        activity_rows_by_date[row.workout_date].append(row)

    def _resolved_targets_for_day(day: date_cls):
        return resolve_targets_for_user(
            db,
            current_user.id,
            as_of=day,
            health_activity_as_of=day - timedelta(days=1),
        )

    def _macro_base_for_day(targets_for_day, day: date_cls) -> tuple[MacroSet, str | None]:
        base = MacroSet(
            calories=int(targets_for_day.calories),
            protein_g=int(targets_for_day.protein_g),
            carbs_g=int(targets_for_day.carbs_g),
            fat_g=int(targets_for_day.fat_g),
            fat_floor_g=int(targets_for_day.fat_floor_g or 30),
            min_carbs_g=40,
        )
        plan_day = plan_day_by_date.get(day)
        day_state = day_state_by_date.get(day)
        is_skipped = bool(getattr(day_state, "skipped_focus", None)) or (
            plan_day is not None and plan_day.status == "skipped"
        )

        if is_skipped:
            adjusted, day_type = redistribute_for_day(
                base,
                focus="Rest",
                activity_category="recovery",
                stimulus="recovery",
                goal_bucket=targets_for_day.bucket_name,
            )
        elif plan_day is not None:
            workout = plan_day.workout_json if isinstance(plan_day.workout_json, dict) else {}
            if workout and not plan_day.is_rest:
                adjusted, day_type = redistribute_for_day(
                    base,
                    archetype=workout.get("archetype"),
                    focus=workout.get("focus") or workout.get("day"),
                    activity_category=workout.get("activity_category"),
                    cardio_style=workout.get("cardio_style"),
                    stimulus=workout.get("stimulus"),
                    goal_bucket=targets_for_day.bucket_name,
                )
            else:
                adjusted, day_type = redistribute_for_day(
                    base,
                    focus="Rest",
                    activity_category="recovery",
                    stimulus="recovery",
                    goal_bucket=targets_for_day.bucket_name,
                )
        else:
            adjusted = base
            day_type = None

        extra_carbs = 0
        if day_state and isinstance(day_state.macro_overrides, dict):
            try:
                extra_carbs = int((day_state.macro_overrides or {}).get("carb_bump_g") or 0)
            except (TypeError, ValueError):
                extra_carbs = 0
        if extra_carbs > 0:
            adjusted = MacroSet(
                calories=adjusted.calories + extra_carbs * 4,
                protein_g=adjusted.protein_g,
                carbs_g=adjusted.carbs_g + extra_carbs,
                fat_g=adjusted.fat_g,
                fat_floor_g=adjusted.fat_floor_g,
                min_carbs_g=adjusted.min_carbs_g,
            )
        return adjusted, day_type

    def _activity_adjustment_for_day(targets_for_day, day: date_cls):
        snapshot = snapshots_by_date.get(day)
        signal_expected_active = (
            getattr(targets_for_day.health_signal, "expected_active_energy_kcal", None)
            if getattr(targets_for_day, "health_signal", None) is not None
            else None
        )
        expected_active_kcal = float(signal_expected_active) if signal_expected_active is not None else float(max(
            150,
            int(round(targets_for_day.tdee - (targets_for_day.bmr * 1.2))),
        ))
        same_day_active_kcal: float | None = None
        same_day_expected_kcal: float | None = None
        if (
            snapshot is not None
            and snapshot.active_energy_kcal is not None
            and float(snapshot.active_energy_kcal) > 0
        ):
            same_day_active_kcal = float(snapshot.active_energy_kcal)
            same_day_expected_kcal = expected_active_kcal

        plan_day = plan_day_by_date.get(day)
        day_state = day_state_by_date.get(day)
        is_skipped = bool(getattr(day_state, "skipped_focus", None)) or (
            plan_day is not None and plan_day.status == "skipped"
        )
        planned_allowance = None
        if (
            plan_day is not None
            and isinstance(plan_day.workout_json, dict)
            and plan_day.workout_json
            and not plan_day.is_rest
            and not is_skipped
        ):
            planned_allowance = int(round(max(
                DEFAULT_PLANNED_WORKOUT_KCAL_ALLOWANCE,
                expected_active_kcal,
            )))
        return compute_activity_target_adjustment(
            activity_rows_by_date.get(day, []),
            goal_bucket=targets_for_day.bucket_name,
            same_day_active_energy_kcal=same_day_active_kcal,
            same_day_expected_active_energy_kcal=same_day_expected_kcal,
            planned_workout_kcal_allowance=planned_allowance,
        )

    targets = _resolved_targets_for_day(today)
    if not targets:
        raise HTTPException(status_code=404, detail="User profile not found")
    formula_targets = resolve_targets_for_user(
        db,
        current_user.id,
        as_of=today,
        include_health=False,
    )

    goal_id = targets.bucket_name
    today_base_macros, today_day_type = _macro_base_for_day(targets, today)
    base_daily = int(today_base_macros.calories)
    formula_daily_target = int(formula_targets.calories) if formula_targets else int(targets.calories)
    rolling_health_activity_delta = int(targets.health_activity_adjustment_kcal or 0)
    health_energy_target_delta = int(targets.health_energy_adjustment_kcal or 0)
    if getattr(targets, "source_tdee_kind", None) in {"apple_health_total_energy", "apple_health_blend"}:
        health_basal_target_delta = 0
    else:
        health_basal_target_delta = int(round(
            int(targets.calories)
            - formula_daily_target
            - rolling_health_activity_delta
        ))
    day_type_adjustment_delta = int(base_daily - int(targets.calories))
    # TODO(nutrition-day-complete): pass marked_complete=True if/when
    # UserDayState gets an explicit "nutrition day complete" field. Meal
    # check-offs are per-meal, not a whole-day completion marker.
    prior_calorie_days: list[CalorieDay] = []
    for day, logged in sorted(calories_by_day.items()):
        day_targets = _resolved_targets_for_day(day)
        if not day_targets:
            continue
        day_base_macros, _day_type = _macro_base_for_day(day_targets, day)
        day_activity_adj = _activity_adjustment_for_day(day_targets, day)
        prior_calorie_days.append(
            CalorieDay(
                logged_calories=logged,
                comparison_target=int(day_base_macros.calories + day_activity_adj.adjustment_kcal),
            )
        )

    fat_loss_recovery_risk = False
    if goal_id == "fat_loss" and completed_days_end >= week_start:
        from app.services.nutrition.recovery_flags import compute_flags

        recovery_flags = compute_flags(db, current_user.id, end_date=completed_days_end, days=7)
        fat_loss_recovery_risk = any(
            flag.key == "under_fueling" and flag.state in ("amber", "red")
            for flag in recovery_flags
        )

    activity_rows = activity_rows_by_date.get(today, [])
    activity_adj = _activity_adjustment_for_day(targets, today)

    result = compute_adjusted_daily_target(
        base_daily_target=base_daily,
        calories_logged_so_far=int(calories_this_week),
        days_remaining=days_remaining,
        goal=goal_id,
        prior_days=prior_calorie_days,
        allow_fat_loss_under_budget_correction=fat_loss_recovery_risk,
    )
    adjusted_calories = int(result.adjusted_calories + activity_adj.adjustment_kcal)

    # Carb bias for added calories now scales with the day's most-
    # demanding session type (see ActivityTargetAdjustment.
    # recommended_carb_bias). Replaces the binary heavy/not-heavy
    # 80/20-vs-60/40 split so a long mobility block stops triggering
    # the same high-carb refeed as a Z4 interval session.
    carb_bias = activity_adj.recommended_carb_bias
    adjusted_macros = compute_adjusted_macros(
        base_protein_g=today_base_macros.protein_g,
        base_carbs_g=today_base_macros.carbs_g,
        base_fat_g=today_base_macros.fat_g,
        adjusted_calories=adjusted_calories,
        base_calories=base_daily,
        carb_bias_pct=carb_bias,
        fat_floor_g=today_base_macros.fat_floor_g or 30,
        min_carbs_g=40,
    )
    if activity_adj.note and abs(result.adjustment_applied) >= 15:
        note = f"{activity_adj.note} {result.note}"
    else:
        note = activity_adj.note or result.note

    target_explanation_parts: list[str] = []
    if activity_adj.adjustment_kcal > 0:
        target_explanation_parts.append(activity_adj.note or "")
    if abs(result.adjustment_applied) >= 15 and result.note:
        target_explanation_parts.append(result.note)
    target_explanation = " ".join(p for p in target_explanation_parts if p) or None

    target_basis = {
        "goal": goal_id,
        "goal_type": targets.goal_type,
        "goal_pace": targets.goal_pace,
        "rate_summary": targets.rate_summary,
        "formula_daily_target": formula_daily_target,
        "formula_tdee": int(formula_targets.tdee) if formula_targets else None,
        "formula_tdee_kcal": int(targets.formula_tdee_kcal or (formula_targets.tdee if formula_targets else targets.tdee)),
        "apple_tdee_kcal": targets.apple_tdee_kcal,
        "apple_valid_days": targets.apple_valid_days,
        "maintenance_source": targets.maintenance_source,
        "maintenance_blend": targets.maintenance_blend,
        "resolved_daily_target": int(targets.calories),
        "base_daily_target": base_daily,
        "maintenance_calories": int(targets.tdee),
        "goal_adjustment_kcal": int(targets.goal_adjustment_kcal),
        "goal_adjustment_pct": targets.goal_adjustment_pct,
        "goal_pace_label": targets.goal_pace_label,
        "coaching_adjustment_kcal": int(targets.coaching_adjustment_kcal),
        "health_basal_adjustment_kcal": int(targets.health_basal_adjustment_kcal),
        "health_basal_target_adjustment_kcal": health_basal_target_delta,
        "health_energy_adjustment_kcal": health_energy_target_delta,
        "rolling_health_activity_adjustment_kcal": rolling_health_activity_delta,
        "day_type_adjustment_kcal": day_type_adjustment_delta,
        "source_bmr_kind": targets.source_bmr_kind,
        "source_bmr_kcal": targets.source_bmr_kcal,
        "source_tdee_kind": getattr(targets, "source_tdee_kind", "formula"),
        "source_tdee_kcal": getattr(targets, "source_tdee_kcal", None),
        "bmr": int(targets.bmr),
        "activity_multiplier": float(targets.activity_multiplier),
        "source_weight_lbs": round(float(targets.source_weight_lbs), 1),
        "source_weight_kind": targets.source_weight_kind,
        "protein_basis_lbs": targets.protein_basis_lbs,
        "protein_basis_kind": targets.protein_basis_kind,
        "protein_factor": targets.protein_factor,
        "fat_percent": targets.fat_percent,
        "fat_floor_g": targets.fat_floor_g,
        "min_carbs_g": targets.min_carbs_g,
        "warnings": targets.warnings or [],
        "health_signal": targets.health_signal.__dict__ if targets.health_signal else None,
        "health_energy_signal": targets.health_energy_signal.__dict__ if getattr(targets, "health_energy_signal", None) else None,
    }

    # Adaptive hydration. Bodyweight + today's workout duration/intensity +
    # HealthKit active energy. Ambient temp isn't wired through HealthKit
    # yet, so it stays None for now — the calc handles that gracefully.
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    workout_intensity = "heavy" if activity_adj.is_heavy_training_day else (
        "moderate" if activity_adj.duration_minutes > 0 else None
    )
    # Pick the most-demanding row's metadata so an interval session in a
    # mixed day still classifies hydration correctly. Ranking is by
    # cardio_style first (intervals > steady > easy), then by
    # activity_category (cardio/sport/strength > mobility/recovery).
    def _row_demand_rank(row) -> int:
        style = str(getattr(row, "cardio_style", "") or "").lower()
        cat = str(getattr(row, "activity_category", "") or "").lower()
        stim = str(getattr(row, "stimulus", "") or "").lower()
        if style == "intervals" or stim == "conditioning":
            return 4
        if cat in {"cardio", "sport"}:
            return 3
        if cat == "strength":
            return 2
        if style in {"recovery", "easy"} or cat in {"mobility", "recovery", "active"}:
            return 0
        return 1
    top_row = max(activity_rows, key=_row_demand_rank, default=None) if activity_rows else None
    hydration_cardio_style = getattr(top_row, "cardio_style", None) if top_row else None
    hydration_category = getattr(top_row, "activity_category", None) if top_row else None
    hydration_stimulus = getattr(top_row, "stimulus", None) if top_row else None
    hydration_energy_kcal = max(
        [
            value for value in (
                float(snapshots_by_date[today].active_energy_kcal)
                if (
                    today in snapshots_by_date
                    and snapshots_by_date[today].active_energy_kcal is not None
                    and float(snapshots_by_date[today].active_energy_kcal) > 0
                )
                else None,
                float(activity_adj.exercise_kcal) if activity_adj.exercise_kcal > 0 else None,
            )
            if value is not None
        ],
        default=None,
    )
    hydration = compute_hydration_target_oz(
        bodyweight_lb=float(profile.weight_lbs) if (profile and profile.weight_lbs) else None,
        workout_duration_min=float(activity_adj.duration_minutes or 0),
        workout_intensity=workout_intensity,
        active_energy_kcal=hydration_energy_kcal,
        ambient_temp_f=None,
        goal=goal_id,
        cardio_style=hydration_cardio_style,
        activity_category=hydration_category,
        stimulus=hydration_stimulus,
        sex=str(profile.gender.value) if (profile and profile.gender is not None) else None,
        age=int(profile.age) if (profile and profile.age) else None,
    )

    return {
        "adjusted_calories":    adjusted_calories,
        "base_daily_target":    result.base_daily_target,
        "weekly_budget_remaining": result.weekly_budget_remaining,
        "days_remaining":       result.days_remaining,
        "calories_logged_so_far": int(calories_this_week),
        "calories_logged_before_date": int(calories_this_week),
        "weekly_smoothing_basis": "prior_days",
        "weekly_smoothing_locked_for_date": True,
        "weekly_smoothing_cutoff_date": completed_days_end.isoformat() if completed_days_end >= week_start else None,
        "target_day_type":       today_day_type,
        "adjustment_applied":   result.adjustment_applied + activity_adj.adjustment_kcal,
        "weekly_adjustment_applied": result.adjustment_applied,
        # 2026-05: expose the raw over/under-budget calorie totals + the
        # number of valid days so the client tooltip can write specific
        # "you went ~N over earlier this week" copy instead of vague
        # "based on earlier days" text. See DailyTargetAdjustmentBanner.
        "weekly_over_budget_kcal":  int(round(result.over_budget)),
        "weekly_under_budget_kcal": int(round(result.under_budget)),
        "weekly_valid_days":        int(result.valid_days),
        "activity_adjustment_applied": activity_adj.adjustment_kcal,
        "activity_adjustment_kcal":   activity_adj.adjustment_kcal,
        "activity_workout_adjustment_kcal": activity_adj.workout_adjustment_kcal,
        "activity_neat_adjustment_kcal":    activity_adj.neat_adjustment_kcal,
        "activity_total_burned_kcal": activity_adj.exercise_kcal,
        "activity_calories_burned": activity_adj.exercise_kcal,
        "activity_duration_minutes": activity_adj.duration_minutes,
        "activity_workout_count": activity_adj.workout_count,
        "is_heavy_training_day": activity_adj.is_heavy_training_day,
        "activity_adjustment_reason": activity_adj.reason,
        "at_cap":               result.at_cap or activity_adj.at_cap,
        "activity_at_cap":      activity_adj.at_cap,
        "note":                 note,
        "activity_note":        activity_adj.note,
        "nutrition_target_explanation": target_explanation,
        "target_basis":          target_basis,
        "formula_daily_target":  formula_daily_target,
        "resolved_daily_target": int(targets.calories),
        "maintenance_calories":  int(targets.tdee),
        "goal_adjustment_kcal":  int(targets.goal_adjustment_kcal),
        "goal_adjustment_pct":   targets.goal_adjustment_pct,
        "goal_pace_label":       targets.goal_pace_label,
        "coaching_adjustment_kcal": int(targets.coaching_adjustment_kcal),
        "health_basal_adjustment_kcal": int(targets.health_basal_adjustment_kcal),
        "health_basal_target_adjustment_kcal": health_basal_target_delta,
        "health_energy_adjustment_kcal": health_energy_target_delta,
        "rolling_health_activity_adjustment_kcal": rolling_health_activity_delta,
        "day_type_adjustment_kcal": day_type_adjustment_delta,
        "same_day_activity_refuel": activity_adj.adjustment_kcal,
        "workout_day_type": today_day_type,
        "protein_basis_lbs": targets.protein_basis_lbs,
        "protein_factor": targets.protein_factor,
        "fat_percent": targets.fat_percent,
        "fat_floor_g": targets.fat_floor_g,
        "warnings": targets.warnings or [],
        "adjusted_macros":      adjusted_macros,
        "hydration_target_oz":  hydration["target_oz"],
        "hydration_breakdown":  hydration,
        "goal":                 goal_id,
        "week_start":           week_start.isoformat(),
        "date":                 today.isoformat(),
    }


# ─── Daily summary ────────────────────────────────────────────────────────────

@router.get("/summary/{summary_date}")
def daily_summary(
    summary_date: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Total macros consumed across all meals for a given day."""
    from app.services.nutrition.meal_history import dedupe_meals_for_aggregation

    meals = db.exec(
        select(Meal).where(Meal.user_id == current_user.id, Meal.meal_date == summary_date)
    ).all()

    # Batch-load items
    meal_ids = [m.id for m in meals]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)
    meals = dedupe_meals_for_aggregation(meals, items_by_meal)

    totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
    meal_data = []
    for meal in meals:
        items = items_by_meal.get(meal.id, [])
        for item in items:
            totals["calories"]  += item.calories
            totals["protein_g"] += item.protein_g
            totals["carbs_g"]   += item.carbs_g
            totals["fat_g"]     += item.fat_g
        meal_data.append({**meal.model_dump(), "items": [i.model_dump() for i in items]})

    return {
        "date": summary_date,
        "totals": {k: round(v, 1) for k, v in totals.items()},
        "meals": meal_data,
    }


# ─── Canonical meal page ──────────────────────────────────────────────────────

@router.get("/{meal_id}/page", response_model=MealPageResponse)
def get_meal_page(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    return _build_meal_page_response(db, current_user, meal_id)


def _saved_item_from_log_item(item: MealItem) -> dict:
    raw = {
        "food_name": item.food_name,
        "food_id": item.food_id,
        "serving_id": item.serving_id,
        "quantity": item.quantity,
        "unit": item.unit,
        "serving_grams": item.serving_grams,
        "calories": item.calories,
        "protein_g": item.protein_g,
        "carbs_g": item.carbs_g,
        "fat_g": item.fat_g,
    }
    for field in (
        "saturated_fat_g",
        "trans_fat_g",
        "cholesterol_mg",
        "sodium_mg",
        "fiber_g",
        "sugar_g",
        "added_sugar_g",
        "caffeine_mg",
        "alcohol_g",
        "potassium_mg",
        "calcium_mg",
        "magnesium_mg",
        "iron_mg",
        "phosphorus_mg",
        "iodine_mcg",
        "choline_mg",
        "vitamin_d_mcg",
        "vitamin_b12_mcg",
        "vitamin_k_mcg",
        "vitamin_e_mg",
        "folate_mcg",
        "zinc_mg",
        "omega_3_g",
        "omega_3_ala_mg",
        "omega_3_epa_mg",
        "omega_3_dha_mg",
        "omega_6_mg",
    ):
        value = getattr(item, field, None)
        if value is not None:
            raw[field] = value
    return raw


@router.put("/{meal_id}/favorite", response_model=MealPageResponse)
def favorite_meal(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all()
    favorite = _favorite_for_meal(db, current_user.id, meal, items)
    if favorite is not None:
        if meal.saved_meal_id != favorite.id:
            meal.saved_meal_id = favorite.id
            meal.updated_at = datetime.now(timezone.utc)
            meal.version = int(getattr(meal, "version", 1) or 1) + 1
            db.add(meal)
            # Mirror saved_meal_id into the UserDayState snapshot so the
            # plan-side bookmark icon flips on next render instead of
            # waiting for a full reload. Without this, the client's
            # `isSavedFavoriteMeal` check on a plan-rendered meal falls
            # back to name-signature matching and lights up unrelated
            # rows.
            _sync_updated_meal_day_state(db, current_user.id, meal)
            db.commit()
        return _build_meal_page_response(db, current_user, meal_id)

    totals = _meal_totals(items)
    favorite = SavedMeal(
        user_id=current_user.id,
        source_meal_id=meal_id,
        name=meal.name,
        notes=meal.notes,
        total_calories=totals["calories"],
        total_protein_g=totals["protein_g"],
        total_carbs_g=totals["carbs_g"],
        total_fat_g=totals["fat_g"],
        items=[_saved_item_from_log_item(item) for item in items],
        image_url=meal.image_url,
        image_source=meal.image_source,
    )
    db.add(favorite)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        favorite = db.exec(
            select(SavedMeal)
            .where(SavedMeal.user_id == current_user.id)
            .where(SavedMeal.source_meal_id == meal_id)
        ).first()
        if favorite is None:
            raise
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    meal.saved_meal_id = favorite.id
    meal.updated_at = datetime.now(timezone.utc)
    meal.version = int(getattr(meal, "version", 1) or 1) + 1
    db.add(meal)
    _sync_updated_meal_day_state(db, current_user.id, meal)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        favorite = db.exec(
            select(SavedMeal)
            .where(SavedMeal.user_id == current_user.id)
            .where(SavedMeal.source_meal_id == meal_id)
        ).first()
        if favorite is None:
            raise
        meal = db.get(Meal, meal_id)
        if meal and meal.user_id == current_user.id:
            meal.saved_meal_id = favorite.id
            db.add(meal)
            _sync_updated_meal_day_state(db, current_user.id, meal)
            db.commit()
    return _build_meal_page_response(db, current_user, meal_id)


@router.delete("/{meal_id}/favorite", response_model=MealPageResponse)
def unfavorite_meal(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all()
    favorite = _favorite_for_meal(db, current_user.id, meal, items)
    if favorite is not None:
        linked_logs = db.exec(
            select(Meal)
            .where(Meal.user_id == current_user.id)
            .where(Meal.saved_meal_id == favorite.id)
        ).all()
        for linked in linked_logs:
            linked.saved_meal_id = None
            linked.updated_at = datetime.now(timezone.utc)
            linked.version = int(getattr(linked, "version", 1) or 1) + 1
            db.add(linked)
            # Each linked log may have an entry in a different day's
            # UserDayState snapshot — sync them all so `_savedMealId`
            # is cleared everywhere, not just on the row being viewed.
            _sync_updated_meal_day_state(db, current_user.id, linked)
        db.delete(favorite)
        db.commit()
    return _build_meal_page_response(db, current_user, meal_id)


# ─── Get one ──────────────────────────────────────────────────────────────────

@router.get("/{meal_id}")
def get_meal(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    return _build_meal_response(meal, db)


# ─── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/{meal_id}", status_code=204)
def delete_meal(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Hard-delete a meal + its items. The post-commit metrics refresh is
    isolated — if anything in `_refresh_daily_metrics` (gut-health
    classifier, readiness cache invalidation, etc.) raises, we still
    return 204 because the deletion itself succeeded. Older builds let a
    metrics-side hiccup surface as a misleading 500 to the client even
    though the row was already gone."""
    import logging as _logging
    _log = _logging.getLogger(__name__)

    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    affected_date = meal.meal_date
    meal_name = meal.name
    client_meal_key = getattr(meal, "client_meal_key", None)
    src_type = (getattr(meal, "source_type", None) or "").lower()
    src_routine_id = getattr(meal, "source_routine_id", None)
    occ_key = getattr(meal, "routine_occurrence_key", None)

    # Delete semantics depend on what the row represents (rule F):
    #   plan      → sync/remove the planned-meal slot from the day's plan
    #   routine   → delete the log AND mark that occurrence skipped (below);
    #               the plan is unrelated, so don't touch it
    #   favorite/ → just delete the log + refresh metrics; the nutrition plan
    #   manual      must NOT be mutated (deleting an extra used to wrongly
    #               remove a plan slot by name match)
    #   legacy/unknown source_type → only sync when it carries a plan slot key
    if src_type == "plan":
        remove_from_plan = True
    elif src_type in ("favorite", "manual", "routine"):
        remove_from_plan = False
    else:
        remove_from_plan = bool(client_meal_key)

    try:
        existing_items = db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all()
        meal_calories = sum(float(item.calories or 0) for item in existing_items)
        if remove_from_plan:
            from app.services.nutrition.meal_history import sync_deleted_meal_day_state
            sync_deleted_meal_day_state(
                db,
                current_user.id,
                affected_date,
                meal_id=meal_id,
                client_meal_key=client_meal_key,
                meal_name=meal_name,
                meal_calories=meal_calories,
                remove_from_plan=True,
            )
        if src_type == "routine" and src_routine_id is not None:
            # Deleting a routine occurrence == skipping that day. Record the
            # skip so a stale client can't silently re-log it afterward.
            from app.routers.meal_routines import upsert_routine_exception
            upsert_routine_exception(
                db,
                user_id=current_user.id,
                routine_id=src_routine_id,
                occ_date=affected_date,
                occurrence_key=occ_key,
                skipped=True,
            )
        # Issue a bulk DELETE for the child rows in a single statement,
        # then flush so the SQL actually hits the DB BEFORE we mark the
        # parent for deletion. The earlier per-row `db.delete(item)` +
        # `db.delete(meal)` + `db.commit()` pattern relied on SQLAlchemy's
        # unit-of-work to topologically order the deletes — which it
        # USUALLY does, but in some session states (post-commit, after
        # certain reads) the meal DELETE was being issued first and
        # tripping the FK constraint:
        #   "update or delete on table meals violates foreign key
        #    constraint, still referenced from meal_items".
        # Forcing a flush between child + parent removes the ambiguity.
        db.exec(_sm_delete(MealItem).where(MealItem.meal_id == meal_id))
        db.flush()
        db.delete(meal)
        db.commit()
    except Exception as e:
        # Roll back so the session isn't left in a bad state for the next
        # request handled by this connection.
        try:
            db.rollback()
        except Exception:
            pass
        _log.exception("[meals/delete] commit failed for meal_id=%s user=%s: %s", meal_id, current_user.id, e)
        # Re-raise as a typed HTTPException so the client gets a clear
        # error instead of a generic 500.
        raise HTTPException(status_code=500, detail=f"Could not delete meal: {e!s}")

    # Metrics refresh — best-effort. The deletion already committed; any
    # failure here is a server-side observability concern, not a user one.
    try:
        _refresh_daily_metrics(db, current_user.id, affected_date, force=True)
    except Exception as e:
        _log.warning("[meals/delete] metrics refresh failed (non-fatal) meal_id=%s: %s", meal_id, e)
