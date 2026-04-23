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

    try:
        meal_date = date.fromisoformat(body.meal_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_date format. Use YYYY-MM-DD.")

    result = log_meal_from_plan(
        user_id=current_user.id,
        meal_date=meal_date,
        meal_type=body.meal_type,
        meal_data=body.meal,
        source=body.source or "plan_check",
        db=db,
    )
    # Incrementally refresh today's derived gut-health metrics. Non-blocking
    # semantics — failures here should never break logging a meal.
    try:
        from app.services.nutrition.gut_health import compute_daily_metrics
        compute_daily_metrics(db, user_id=current_user.id, metric_date=meal_date, allow_ai=False)
    except Exception:
        pass
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
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return derived gut-health + longevity signals for today + the rolling
    window. Reads from DailyNutritionMetrics (regenerable) so this endpoint
    is cheap; computes today on-the-fly in case the background pass hasn't
    caught up yet."""
    from app.services.nutrition.gut_health import compute_daily_metrics, compute_weekly_rollup

    today = date.today()
    try:
        today_row = compute_daily_metrics(db, user_id=current_user.id, metric_date=today, allow_ai=False)
    except Exception:
        today_row = None

    rollup = compute_weekly_rollup(db, user_id=current_user.id, end_date=today, days=days)

    if today_row is None:
        return {"today": None, "window": rollup}

    return {
        "today": {
            "date": str(today_row.metric_date),
            "calories_total": today_row.calories_total,
            "fiber_total_g": today_row.fiber_total_g,
            "fiber_per_1000_kcal": today_row.fiber_per_1000_kcal,
            "distinct_plant_foods": today_row.distinct_plant_foods,
            "fermented_servings": today_row.fermented_servings,
            "omega3_servings": today_row.omega3_servings,
            "processing_counts": today_row.processing_counts or {},
            "saturated_fat_g": today_row.saturated_fat_g,
            "gut_support_score": today_row.gut_support_score,
            "food_quality_score": today_row.food_quality_score,
            "longevity_signals_score": today_row.longevity_signals_score,
            "classified_item_count": today_row.classified_item_count,
            "item_count": today_row.item_count,
        },
        "window": rollup,
    }


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
