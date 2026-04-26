from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select
from datetime import date
from typing import Optional

from app.database import get_session
from app.models import User, Meal, MealItem, MealCreate, UserDayState, UserGoal
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


# Per-meal-log refresh runs the daily metrics with AI enabled so each
# newly-logged food gets its collagen_g + probiotic_cfu amounts
# estimated. The estimator is cached per food forever (one call per
# unique food name + classifier version), so logging a salmon dinner
# 30 times pays for AI exactly once. Without allow_ai=True we'd
# silently zero out collagen + CFU for every food the deterministic
# keyword classifier doesn't recognise — which was the bug.
def _refresh_daily_metrics(db: Session, user_id: int, meal_date: date) -> None:
    """Recompute DailyNutritionMetrics for the given user + date. Called
    after any write that changes what meals exist on that day so the
    Nutrition Score reflects reality on the next /meals/score fetch.
    Non-blocking — failures here never break the caller."""
    try:
        from app.services.nutrition.gut_health import compute_daily_metrics
        compute_daily_metrics(db, user_id=user_id, metric_date=meal_date, allow_ai=True)
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
    from datetime import datetime as _dt, time as _time, timezone as _tz
    if getattr(body, "consumed_at", None):
        consumed_at = body.consumed_at
    else:
        consumed_at = _dt.now(_tz.utc)

    meal = Meal(
        user_id=current_user.id,
        meal_date=body.meal_date,
        meal_type=body.meal_type,
        name=body.name,
        source=body.source,
        notes=body.notes,
        consumed_at=consumed_at,
    )
    db.add(meal)
    db.flush()

    for item_body in body.items:
        db.add(MealItem(meal_id=meal.id, **item_body.model_dump()))

    db.commit()
    db.refresh(meal)
    _refresh_daily_metrics(db, current_user.id, meal.meal_date)
    return _build_meal_response(meal, db)


@router.patch("/{meal_id}")
def update_meal(
    meal_id: int,
    body: dict,  # accept partial — {meal_type, consumed_at, notes, name}
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Patch a small set of mutable fields on an existing meal. Used by
    the meal editor to change `meal_type` (e.g. correct a mis-defaulted
    breakfast → pre_workout) and `consumed_at` (back-log time)."""
    meal = db.get(Meal, meal_id)
    if not meal or meal.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Meal not found")
    if "meal_type" in body and body["meal_type"]:
        try:
            from app.enums import MealType as _MT
            meal.meal_type = _MT(body["meal_type"])
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid meal_type")
    if "consumed_at" in body and body["consumed_at"]:
        from datetime import datetime as _dt
        try:
            meal.consumed_at = _dt.fromisoformat(str(body["consumed_at"]).replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid consumed_at")
    if "notes" in body:
        meal.notes = body["notes"]
    if "name" in body and body["name"]:
        meal.name = body["name"]
    db.add(meal)
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
    from app.services.nutrition.allergen_filter import _item_matches_allergen, ALLERGEN_KEYWORDS
    from app.models import UserProfile

    try:
        meal_date = date.fromisoformat(body.meal_date)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid meal_date format. Use YYYY-MM-DD.")

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
        meal_data=body.meal,
        source=body.source or "plan_check",
        db=db,
    )
    _refresh_daily_metrics(db, current_user.id, meal_date)
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
    """Return descriptive Gut & Plants facts for today + the rolling window.
    Returns facts only — plant diversity, fermented/probiotic servings,
    omega-3 foods, processing mix, protein source split. No scores.
    The unified Nutrition Score lives at /meals/score."""
    from app.services.nutrition.gut_health import compute_daily_metrics, compute_weekly_rollup

    today = date.today()
    try:
        # The gut-health endpoint also drives the daily NutritionCard,
        # so it needs amounts populated. Cached per-food, so the first
        # query of the day is the only AI cost.
        today_row = compute_daily_metrics(db, user_id=current_user.id, metric_date=today, allow_ai=True)
    except Exception:
        today_row = None

    rollup = compute_weekly_rollup(db, user_id=current_user.id, end_date=today, days=days)

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
    current_user: User = Depends(get_current_user),
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
    from app.services.nutrition.food_classifier import normalize_name as _norm
    from sqlalchemy import func as _sa_func
    today_d = date.today()
    rows = db.exec(
        select(MealItem, FoodMetadata)
        .join(Meal, Meal.id == MealItem.meal_id)
        .join(
            FoodMetadata,
            FoodMetadata.normalized_name == _sa_func.lower(MealItem.food_name),
            isouter=True,
        )
        .where(Meal.user_id == current_user.id)
        .where(_sa_func.date(Meal.consumed_at) == today_d)
    ).all()

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

    for item, meta in rows:
        protein_g = float(item.protein_g or 0.0)
        if protein_g <= 0:
            continue
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
    return {
        "day_type": day_type,
        "goal": goal_bucket,
        "base": base.to_dict(),
        "adjusted": adjusted.to_dict(),
        "carb_delta_g": adjusted.carbs_g - base.carbs_g,
        "fat_delta_g": adjusted.fat_g - base.fat_g,
    }


class HydrationLogBody(BaseModel):
    ounces: float
    log_date: Optional[str] = None   # YYYY-MM-DD, defaults to today


@router.post("/hydration")
def log_hydration(
    body: HydrationLogBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Log hydration for a given day. Stored on UserDayState.nutrition_plan
    under _hydration_oz — lightweight, survives app kill via existing sync."""
    from datetime import date as _date
    try:
        d = _date.fromisoformat(body.log_date) if body.log_date else _date.today()
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid log_date")

    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id)
        .where(UserDayState.day_key == d)
    ).first()
    if state is None:
        state = UserDayState(user_id=current_user.id, day_key=d)
        db.add(state)
    plan = dict(state.nutrition_plan or {})
    plan["_hydration_oz"] = max(0.0, float(body.ounces))
    state.nutrition_plan = plan
    db.commit()
    return {"date": str(d), "ounces": plan["_hydration_oz"]}


@router.get("/hydration")
def get_hydration(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Today's logged ounces + suggested target derived from weight."""
    from datetime import date as _date
    from app.models import UserProfile
    d = _date.today()
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
    # Target: half bodyweight in oz (mirrors client hydration.ts).
    target_oz = round((profile.weight_lbs / 2.0) if profile else 64.0)
    return {"date": str(d), "ounces": round(oz, 1), "target_ounces": target_oz}


@router.get("/score")
def nutrition_score_endpoint(
    days: int = Query(default=7, ge=1, le=30),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Authoritative Nutrition Score for today + the rolling window.
    This is the server-side source of truth; the client renders it verbatim."""
    from app.services.nutrition.score_builder import compute_today_score, compute_weekly_score

    today = compute_today_score(db, current_user.id)
    weekly = compute_weekly_score(db, current_user.id, days=days)
    return {"today": today, "weekly": weekly}


@router.get("/recovery-flags")
def recovery_flags_endpoint(
    days: int = Query(default=7, ge=5, le=30),
    thyroid_opt_in: bool = Query(default=False),
    current_user: User = Depends(get_current_user),
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
    affected_date = meal.meal_date
    for item in db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all():
        db.delete(item)
    db.delete(meal)
    db.commit()
    _refresh_daily_metrics(db, current_user.id, affected_date)
