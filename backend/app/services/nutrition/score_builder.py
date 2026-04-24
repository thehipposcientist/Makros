"""Build NutritionIndicators from persisted data + compute the Nutrition Score.

This is the server-side authority for the unified score. The client used
to recompute it per-render; now it just reads from this pipeline via
/meals/score. Having a single source eliminates drift between "plan
preview" and "logged meals" numbers.

Flow:
  1. Load today's meals + items
  2. Aggregate macros + micronutrients (via FoodNutrition.extra_nutrients)
  3. Pull the already-computed DailyNutritionMetrics row for processing
     mix, plant diversity, fermented/omega-3 servings, added sugar, etc.
  4. Load profile + active goal → compute calorie + protein targets
  5. Build NutritionIndicators, feed compute_nutrition_score
"""
from __future__ import annotations

from dataclasses import asdict
from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.models import (
    Meal, MealItem, FoodNutrition, DailyNutritionMetrics,
    UserProfile, UserGoal, UserDayState,
)
from app.services.nutrition.gut_health import compute_daily_metrics, compute_weekly_rollup
from app.services.nutrition.nutrition_score import (
    NutritionIndicators, compute_nutrition_score, NutritionScore, RDA,
)
from app.services.nutrition.calorie_calculator import (
    CalorieInputs, compute_targets,
)


def _get_profile_and_goal(db: Any, user_id: int) -> tuple[UserProfile | None, UserGoal | None]:
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id).where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    return profile, goal


def _compute_targets(profile: UserProfile | None, goal: UserGoal | None) -> tuple[int, int, str, str | None]:
    """Return (calorie_target, protein_target_g, goal_id, sex)."""
    if not profile:
        return 2000, 120, "body_recomp", None
    from app.enums import GoalType, GoalPace
    goal_id = (goal.goal_type.value if goal else "body_recomp")
    pace = (goal.pace.value if goal else "moderate")
    sex = (profile.gender.value if profile.gender else None)
    try:
        targets = compute_targets(CalorieInputs(
            weight_lbs=profile.weight_lbs,
            height_feet=profile.height_feet,
            height_inches=profile.height_inches,
            age=profile.age,
            gender=sex or "",
            training_days_per_week=3,
            session_minutes=60,
            goal_id=goal_id,
            pace=pace,
            target_weight_lbs=goal.target_weight_lbs if goal else None,
            timeline_weeks=goal.timeline_weeks if goal else None,
        ))
        return targets.calories, targets.protein_g, goal_id, sex
    except Exception:
        return 2000, 120, goal_id, sex


def _aggregate_micros(db: Any, items: list[MealItem]) -> tuple[dict[str, float], int, int]:
    """Sum micronutrients across meal items. Returns (totals, food_count,
    foods_with_micros). Scales extra_nutrients by serving grams."""
    food_ids = [i.food_id for i in items if i.food_id is not None]
    nut_by_food: dict[int, FoodNutrition] = {}
    if food_ids:
        for n in db.exec(select(FoodNutrition).where(FoodNutrition.food_id.in_(food_ids))).all():
            nut_by_food[n.food_id] = n

    micros: dict[str, float] = {}
    with_micros = 0
    for item in items:
        nut = nut_by_food.get(item.food_id) if item.food_id else None
        if not nut:
            continue
        grams_consumed = float(item.serving_grams or 0)
        if grams_consumed <= 0 or nut.reference_grams <= 0:
            continue
        scale = grams_consumed / float(nut.reference_grams)
        extras = nut.extra_nutrients or {}
        had_any = False
        # Canonical keys we care about for scoring
        for key in (
            "calcium_mg", "iron_mg", "potassium_mg", "magnesium_mg",
            "vitamin_d_mcg", "vitamin_b12_mcg", "vitamin_c_mg", "vitamin_a_mcg",
            "zinc_mg", "selenium_mcg", "folate_b9", "folate_mcg",
        ):
            if key in extras:
                try:
                    v = float(extras[key]) * scale
                    # Normalize folate_b9 → folate_mcg
                    store_key = "folate_mcg" if key in ("folate_b9", "folate_mcg") else key
                    micros[store_key] = micros.get(store_key, 0) + v
                    had_any = True
                except Exception:
                    pass
        # fiber is a top-level column
        if nut.fiber is not None:
            micros["fiber_g"] = micros.get("fiber_g", 0) + float(nut.fiber) * scale
            had_any = True
        if had_any:
            with_micros += 1
    return micros, len(items), with_micros


def build_indicators(
    db: Any, user_id: int, target_date: date,
) -> tuple[NutritionIndicators, str, str | None]:
    """Assemble today's NutritionIndicators. Returns (indicators, goal_id, sex)."""
    profile, goal = _get_profile_and_goal(db, user_id)
    cal_target, pro_target, goal_id, sex = _compute_targets(profile, goal)

    # Ensure today's metrics row is fresh — cheap if already computed.
    try:
        metrics = compute_daily_metrics(db, user_id=user_id, metric_date=target_date, allow_ai=False)
    except Exception:
        metrics = None

    # Meals + items for the day
    meals = db.exec(
        select(Meal).where(Meal.user_id == user_id).where(Meal.meal_date == target_date)
    ).all()
    meal_ids = [m.id for m in meals]
    items: list[MealItem] = []
    if meal_ids:
        items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()

    total_cal = sum(float(i.calories or 0) for i in items)
    total_pro = sum(float(i.protein_g or 0) for i in items)

    micros, food_count, foods_with_micros = _aggregate_micros(db, items)

    # Processing mix: minimally / ultra percentages from today's counts.
    processing = (metrics.processing_counts or {}) if metrics else {}
    proc_total = sum(int(v) for v in processing.values()) or 1
    min_proc_pct = 100.0 * processing.get("minimally_processed", 0) / proc_total
    upf_pct = 100.0 * processing.get("ultra_processed", 0) / proc_total

    # Seafood weekly for omega-3 signal
    try:
        rollup = compute_weekly_rollup(db, user_id=user_id, end_date=target_date, days=7)
        seafood_week = float(rollup.get("seafood_servings", 0) or 0)
    except Exception:
        seafood_week = 0.0

    # Hydration: read from UserDayState + profile target. Flagged as logged
    # when >= 70% of the day's target to avoid rewarding tiny sips.
    hydration_logged = False
    try:
        state = db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == user_id)
            .where(UserDayState.day_key == target_date)
        ).first()
        oz = 0.0
        if state and state.nutrition_plan:
            try: oz = float((state.nutrition_plan or {}).get("_hydration_oz", 0) or 0)
            except Exception: pass
        target_oz = (profile.weight_lbs / 2.0) if profile else 64.0
        if target_oz > 0 and oz >= 0.7 * target_oz:
            hydration_logged = True
    except Exception:
        pass

    indicators = NutritionIndicators(
        calories_logged=total_cal,
        calories_target=cal_target,
        protein_logged=total_pro,
        protein_target=pro_target,
        fiber_g=float(metrics.fiber_total_g) if metrics else (micros.get("fiber_g", 0.0)),
        added_sugar_g=float(getattr(metrics, "added_sugar_g", 0) or 0) if metrics else 0,
        saturated_fat_g=float(metrics.saturated_fat_g) if metrics else 0,
        sodium_mg=float(getattr(metrics, "sodium_mg", 0) or 0) if metrics else 0,
        minimally_processed_pct=min_proc_pct,
        ultra_processed_pct=upf_pct,
        distinct_plant_foods=int(metrics.distinct_plant_foods) if metrics else 0,
        omega3_servings=float(metrics.omega3_servings) if metrics else 0,
        seafood_servings_weekly=seafood_week,
        meals_logged=len(meals),
        meals_expected=max(3, len(meals)),
        micronutrients=micros,
        food_count=food_count,
        foods_with_micros=foods_with_micros,
        hydration_logged=hydration_logged,
    )
    return indicators, goal_id, sex


def compute_today_score(db: Any, user_id: int, target_date: date | None = None) -> dict:
    """Return a ready-to-render payload for the UI."""
    if target_date is None:
        target_date = date.today()
    indicators, goal_id, sex = build_indicators(db, user_id, target_date)
    score = compute_nutrition_score(indicators, goal=goal_id, sex=sex)

    return {
        "date": str(target_date),
        "score": score.total,
        "adherence": score.adherence_score,
        "quality": score.quality_score,
        "micro": score.micro_score,
        "confidence": score.confidence,
        "wins": score.wins,
        "improvements": score.improvements,
        "tags": score.tags,
        "likely_gaps": score.likely_gaps,
        "flags": score.flags,
        "indicators": score.indicators,
        "adherence_breakdown": score.adherence_breakdown,
        "quality_breakdown": score.quality_breakdown,
        "micro_breakdown": score.micro_breakdown,
        "targets": {
            "calories": indicators.calories_target,
            "protein_g": indicators.protein_target,
        },
        "totals": {
            "calories": round(indicators.calories_logged),
            "protein_g": round(indicators.protein_logged, 1),
        },
        "goal": goal_id,
        "score_version": score.score_version,
    }


def compute_weekly_score(db: Any, user_id: int, end_date: date | None = None, days: int = 7) -> dict:
    """Compute per-day scores for the last `days` days and a weekly average.
    Used by the weekly drill-down."""
    if end_date is None:
        end_date = date.today()
    daily: list[dict] = []
    score_values: list[int] = []
    protein_hits = 0
    fiber_hits = 0
    cal_hits = 0
    days_with_data = 0

    for offset in range(days - 1, -1, -1):
        d = end_date - timedelta(days=offset)
        indicators, goal_id, sex = build_indicators(db, user_id, d)
        if indicators.calories_logged <= 0 and indicators.meals_logged == 0:
            daily.append({"date": str(d), "score": None, "logged": False})
            continue
        score = compute_nutrition_score(indicators, goal=goal_id, sex=sex)
        days_with_data += 1
        score_values.append(score.total)
        if score.flags.get("protein_on_track"):
            protein_hits += 1
        if score.flags.get("fiber_on_track"):
            fiber_hits += 1
        if score.flags.get("calorie_on_track"):
            cal_hits += 1
        daily.append({
            "date": str(d),
            "score": score.total,
            "adherence": score.adherence_score,
            "quality": score.quality_score,
            "micro": score.micro_score,
            "logged": True,
        })

    avg_score = round(sum(score_values) / len(score_values)) if score_values else 0

    rollup = compute_weekly_rollup(db, user_id=user_id, end_date=end_date, days=days)

    # Energy availability = (avg intake − avg exercise kcal) / FFM kg.
    # Pulled via recovery_flags which does the FFM math. Stashed on the
    # weekly card so the client can show "EA 28 kcal/kg FFM — low".
    try:
        from app.services.nutrition.recovery_flags import compute_energy_availability
        ea_ctx = compute_energy_availability(db, user_id=user_id, end_date=end_date, days=days)
    except Exception:
        ea_ctx = None

    return {
        "window_days": days,
        "days_with_data": days_with_data,
        "end_date": str(end_date),
        "avg_score": avg_score,
        "daily": daily,
        "days_hit_protein": protein_hits,
        "days_hit_fiber": fiber_hits,
        "days_hit_calories": cal_hits,
        "calorie_stability_cv": rollup.get("calorie_stability_cv", 0.0),
        "energy_availability": ea_ctx,
        "rollup": rollup,
    }
