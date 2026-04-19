from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select
from datetime import date
from typing import Optional

from app.database import get_session
from app.models import User, Meal, MealItem, MealCreate, UserDayState
from app.auth import get_current_user

router = APIRouter(prefix="/meals", tags=["meals"])


# ─── Request schemas for new endpoints ────────────────────────────────────────

class LogCheckedBody(BaseModel):
    meal_date: str          # "YYYY-MM-DD"
    meal_type: str          # "meal_0", "breakfast", etc.
    meal: dict              # full MealSuggestion dict from the client
    source: Optional[str] = "plan_check"


@router.get("/grocery-list")
def grocery_list(
    days: int = Query(default=3, ge=1, le=14),
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
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


# ─── Create ───────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_meal(
    body: MealCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    meal = Meal(
        user_id=current_user.id,
        meal_date=body.meal_date,
        meal_type=body.meal_type,
        name=body.name,
        source=body.source,
        notes=body.notes,
    )
    db.add(meal)
    db.flush()

    for item_body in body.items:
        db.add(MealItem(meal_id=meal.id, **item_body.model_dump()))

    db.commit()
    db.refresh(meal)
    return _build_meal_response(meal, db)


# ─── List ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_meals(
    meal_date: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    query = select(Meal).where(Meal.user_id == current_user.id)
    if meal_date:
        query = query.where(Meal.meal_date == meal_date)
    meals = db.exec(query.order_by(Meal.meal_date.desc(), Meal.created_at)).all()

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

    try:
        meal_date = date.fromisoformat(body.meal_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_date format. Use YYYY-MM-DD.")

    return log_meal_from_plan(
        user_id=current_user.id,
        meal_date=meal_date,
        meal_type=body.meal_type,
        meal_data=body.meal,
        source=body.source or "plan_check",
        db=db,
    )


@router.get("/history")
def meal_history(
    days: int = Query(default=30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the user's recent meal history with items."""
    from app.services.nutrition.meal_history import get_meal_history

    return {"meals": get_meal_history(current_user.id, days=days, db=db)}


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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the user's most commonly eaten meals."""
    from app.services.nutrition.meal_history import get_common_meals

    return {"meals": get_common_meals(current_user.id, min_count=min_count, db=db)}


@router.get("/insights")
def meal_insights(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return coaching-style nutrition insights and pattern analysis."""
    from app.services.nutrition.meal_history import get_meal_insights, get_nutrition_patterns

    patterns = get_nutrition_patterns(current_user.id, days=14, db=db)
    insights = get_meal_insights(current_user.id, db=db)
    return {"insights": insights, "patterns": patterns}


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


# ─── Daily summary ────────────────────────────────────────────────────────────

@router.get("/summary/{summary_date}")
def daily_summary(
    summary_date: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Total macros consumed across all meals for a given day."""
    meals = db.exec(
        select(Meal).where(Meal.user_id == current_user.id, Meal.meal_date == summary_date)
    ).all()

    # Batch-load items
    meal_ids = [m.id for m in meals]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)

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


# ─── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/{meal_id}", status_code=204)
def delete_meal(
    meal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    for item in db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all():
        db.delete(item)
    db.delete(meal)
    db.commit()
