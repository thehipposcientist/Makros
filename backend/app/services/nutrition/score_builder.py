"""Build NutritionIndicators from persisted data + compute the Nutrition Score.

This is the server-side authority for the unified score. The client used
to recompute it per-render; now it just reads from this pipeline via
/meals/score. Logged meal items win; projected plan data is only the
fallback for days without logged meal items.

Flow:
  1. Load today's logged meals when they exist
  2. Fall back to the projected nutrition plan from UserDayState / PlanDay
  3. Aggregate macros + micronutrients
  4. Pull the already-computed DailyNutritionMetrics row for logged scoring
     mix, plant diversity, fermented/omega-3 servings, added sugar, etc.
  5. Load profile + active goal → compute calorie + macro targets
  6. Build NutritionIndicators, feed compute_nutrition_score
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.models import (
    Meal, MealItem, FoodNutrition, DailyNutritionMetrics,
    UserProfile, UserGoal, UserDayState, PlanDay, PlanWeek,
    DailyHealthSnapshot, WorkoutCompletion,
)
from app.services.nutrition.gut_health import compute_daily_metrics, compute_weekly_rollup
from app.services.nutrition.meal_history import dedupe_meals_for_aggregation
from app.services.nutrition.nutrition_score import (
    NutritionIndicators, SCORE_VERSION, compute_nutrition_score,
)
from app.services.nutrition.day_completeness import classify_nutrition_day
from app.services.nutrition.targets import ResolvedNutritionTargets, resolve_targets_for_user


def _get_profile_and_goal(db: Any, user_id: int) -> tuple[UserProfile | None, UserGoal | None]:
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id).where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    return profile, goal


def _compute_targets(
    db: Any,
    user_id: int,
    profile: UserProfile | None,
    goal: UserGoal | None,
    target_date: date,
) -> tuple[int, int, int, int, str, str | None, ResolvedNutritionTargets | None]:
    """Return (calorie_target, protein_target_g, carbs_target_g, fat_target_g, goal_id, sex, resolved)."""
    if not profile:
        return 2000, 120, 0, 0, "body_recomp", None, None
    goal_id = (goal.goal_type.value if goal and hasattr(goal.goal_type, "value") else str(goal.goal_type) if goal else "body_recomp")
    sex = (profile.gender.value if hasattr(profile.gender, "value") else str(profile.gender) if profile.gender else None)
    try:
        targets = resolve_targets_for_user(
            db,
            user_id,
            as_of=target_date,
            health_activity_as_of=target_date - timedelta(days=1),
        )
        if not targets:
            return 2000, 120, 0, 0, goal_id, sex, None
        return targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g, goal_id, sex, targets
    except Exception:
        return 2000, 120, 0, 0, goal_id, sex, None


def _activity_adjusted_calorie_target(
    db: Any,
    user_id: int,
    target_date: date,
    calorie_target: float,
    *,
    goal_id: str | None,
    resolved: ResolvedNutritionTargets | None,
) -> float:
    if target_date > date.today():
        return calorie_target
    try:
        rows = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == user_id)
            .where(WorkoutCompletion.workout_date == target_date)
        ).all()
        snapshot = db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == user_id)
            .where(DailyHealthSnapshot.snapshot_date == target_date)
        ).first()
        same_day_active = (
            float(snapshot.active_energy_kcal)
            if snapshot and snapshot.active_energy_kcal is not None and float(snapshot.active_energy_kcal) > 0
            else None
        )
        signal_expected = (
            getattr(resolved.health_signal, "expected_active_energy_kcal", None)
            if resolved is not None and getattr(resolved, "health_signal", None) is not None
            else None
        )
        expected_active = (
            float(signal_expected)
            if same_day_active is not None and signal_expected is not None
            else (
                float(max(150, int(round(resolved.tdee - (resolved.bmr * 1.2)))))
                if same_day_active is not None and resolved is not None
                else None
            )
        )
        if not rows and same_day_active is None:
            return calorie_target
        from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment
        adjustment = compute_activity_target_adjustment(
            rows,
            goal_bucket=(resolved.bucket_name if resolved else goal_id),
            same_day_active_energy_kcal=same_day_active,
            same_day_expected_active_energy_kcal=expected_active,
        )
        return float(calorie_target) + float(adjustment.adjustment_kcal)
    except Exception:
        return calorie_target


_LEGACY_MEAL_KEYS = ("breakfast", "lunch", "dinner", "snack")

_MICRO_ALIASES: dict[str, str] = {
    "fiber": "fiber_g",
    "fiber_g": "fiber_g",
    "added_sugar": "added_sugar_g",
    "added_sugar_g": "added_sugar_g",
    "added_sugars": "added_sugar_g",
    "added_sugars_g": "added_sugar_g",
    "saturated_fat": "saturated_fat_g",
    "saturated_fat_g": "saturated_fat_g",
    "saturatedFat": "saturated_fat_g",
    "sat_fat": "saturated_fat_g",
    "sat_fat_g": "saturated_fat_g",
    "sodium": "sodium_mg",
    "sodium_mg": "sodium_mg",
    "calcium": "calcium_mg",
    "calcium_mg": "calcium_mg",
    "iron": "iron_mg",
    "iron_mg": "iron_mg",
    "potassium": "potassium_mg",
    "potassium_mg": "potassium_mg",
    "magnesium": "magnesium_mg",
    "magnesium_mg": "magnesium_mg",
    "vitamin_d": "vitamin_d_mcg",
    "vitaminD": "vitamin_d_mcg",
    "vitamin_d_mcg": "vitamin_d_mcg",
    "vitamin_b12": "vitamin_b12_mcg",
    "vitaminB12": "vitamin_b12_mcg",
    "vitamin_b12_mcg": "vitamin_b12_mcg",
    "vitamin_c": "vitamin_c_mg",
    "vitaminC": "vitamin_c_mg",
    "vitamin_c_mg": "vitamin_c_mg",
    "vitamin_a": "vitamin_a_mcg",
    "vitaminA": "vitamin_a_mcg",
    "vitamin_a_mcg": "vitamin_a_mcg",
    "zinc": "zinc_mg",
    "zinc_mg": "zinc_mg",
    "selenium": "selenium_mcg",
    "selenium_mcg": "selenium_mcg",
    "copper": "copper_mg",
    "copper_mg": "copper_mg",
    "manganese": "manganese_mg",
    "manganese_mg": "manganese_mg",
    "boron": "boron_mg",
    "boron_mg": "boron_mg",
    "folate": "folate_mcg",
    "folate_b9": "folate_mcg",
    "folate_mcg": "folate_mcg",
    "omega_3": "omega_3_mg",
    "omega3": "omega_3_mg",
    "omega_3_mg": "omega_3_mg",
}


def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _iter_plan_meals(plan: dict | None) -> list[dict]:
    if not isinstance(plan, dict):
        return []
    meals = plan.get("meals")
    if isinstance(meals, list):
        return [m for m in meals if isinstance(m, dict)]
    out: list[dict] = []
    for key in _LEGACY_MEAL_KEYS:
        meal = plan.get(key)
        if isinstance(meal, dict):
            out.append(meal)
    return out


def _active_plan_meals(plan: dict | None) -> list[dict]:
    meals = _iter_plan_meals(plan)
    if not isinstance(plan, dict):
        return meals
    removed = {str(v) for v in (plan.get("removedMealIds") or [])}
    return [
        meal
        for idx, meal in enumerate(meals)
        if str(idx) not in removed and f"meal_{idx}" not in removed
    ]


def _plan_has_projected_meals(plan: dict | None) -> bool:
    for meal in _active_plan_meals(plan):
        if _num(meal.get("calories")) > 0 or _num(meal.get("protein")) > 0:
            return True
        items = meal.get("items")
        if isinstance(items, list) and any(isinstance(i, dict) for i in items):
            return True
    return False


def _get_projected_plan(db: Any, user_id: int, target_date: date) -> dict | None:
    """Return the projected DailyNutritionPlan for `target_date`.

    Per-day user edits in UserDayState win. If that row only contains
    hydration/check state, fall back to the active PlanWeek's PlanDay and then
    to the newest historical PlanDay for that date.
    """
    try:
        state = db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == user_id)
            .where(UserDayState.day_key == target_date)
        ).first()
        if state and _plan_has_projected_meals(state.nutrition_plan):
            return state.nutrition_plan
    except Exception:
        pass

    try:
        active_week = db.exec(
            select(PlanWeek)
            .where(PlanWeek.user_id == user_id)
            .where(PlanWeek.status == "active")
            .where(PlanWeek.start_date <= target_date)
            .where(PlanWeek.end_date >= target_date)
            .order_by(PlanWeek.created_at.desc())
        ).first()
        if active_week:
            plan_day = db.exec(
                select(PlanDay)
                .where(PlanDay.plan_week_id == active_week.id)
                .where(PlanDay.day_date == target_date)
            ).first()
            if plan_day and _plan_has_projected_meals(plan_day.nutrition_json):
                return plan_day.nutrition_json
    except Exception:
        pass

    try:
        rows = db.exec(
            select(PlanDay)
            .where(PlanDay.user_id == user_id)
            .where(PlanDay.day_date == target_date)
            .order_by(PlanDay.id.desc())
        ).all()
        for row in rows:
            if _plan_has_projected_meals(row.nutrition_json):
                return row.nutrition_json
    except Exception:
        pass
    return None


def _plan_items(meals: list[dict]) -> list[dict]:
    items: list[dict] = []
    for meal in meals:
        raw_items = meal.get("items")
        if isinstance(raw_items, list):
            items.extend([i for i in raw_items if isinstance(i, dict)])
    return items


def _macro_from_meal(meal: dict, key: str, item_key: str | None = None) -> float:
    value = _num(meal.get(key))
    if value > 0:
        return value
    if item_key:
        value = _num(meal.get(item_key))
        if value > 0:
            return value
    raw_items = meal.get("items")
    if not isinstance(raw_items, list):
        return 0.0
    total = 0.0
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        total += _num(item.get(item_key or key), _num(item.get(key), 0.0))
    return total


def _object_micros(obj: dict) -> dict[str, float]:
    micros: dict[str, float] = {}
    raw = obj.get("micronutrients")
    if isinstance(raw, dict):
        for key, value in raw.items():
            canonical = _MICRO_ALIASES.get(str(key), str(key))
            amount = _num(value)
            if amount:
                micros[canonical] = micros.get(canonical, 0.0) + amount
    for key, canonical in _MICRO_ALIASES.items():
        if canonical in micros:
            continue
        if key in obj:
            amount = _num(obj.get(key))
            if amount:
                micros[canonical] = micros.get(canonical, 0.0) + amount
    return micros


def _add_micros(total: dict[str, float], incoming: dict[str, float]) -> None:
    for key, value in incoming.items():
        total[key] = total.get(key, 0.0) + value


def _projected_micros(meals: list[dict]) -> tuple[dict[str, float], int, int]:
    """Aggregate consumed micronutrients from planned meal/item payloads."""
    micros: dict[str, float] = {}
    food_count = 0
    foods_with_micros = 0

    for meal in meals:
        raw_items = meal.get("items")
        items = [i for i in raw_items if isinstance(i, dict)] if isinstance(raw_items, list) else []
        if items:
            food_count += len(items)
            item_micro_count = 0
            for item in items:
                item_micros = _object_micros(item)
                if item_micros:
                    item_micro_count += 1
                    _add_micros(micros, item_micros)
            foods_with_micros += item_micro_count
            if item_micro_count > 0:
                continue

        meal_micros = _object_micros(meal)
        if meal_micros:
            _add_micros(micros, meal_micros)
            if not items:
                food_count += 1
            foods_with_micros += 1
        elif not items:
            food_count += 1

    return micros, food_count, foods_with_micros


def _item_processing_bucket(item: dict) -> str | None:
    bucket = item.get("processing_bucket")
    if isinstance(bucket, str) and bucket:
        return bucket
    quality = item.get("food_quality")
    if quality in ("whole", "minimally_processed"):
        return "minimally_processed"
    if quality == "processed":
        return "processed"
    if quality == "ultra_processed":
        return "ultra_processed"
    return None


def _projected_quality_signals(meals: list[dict]) -> dict[str, float]:
    items = _plan_items(meals)
    processing_counts: dict[str, int] = {}
    distinct_plants = 0
    omega3 = 0.0
    seafood = 0.0

    for item in items:
        bucket = _item_processing_bucket(item)
        if bucket:
            processing_counts[bucket] = processing_counts.get(bucket, 0) + 1
        distinct_plants += int(_num(item.get("plant_count"), 0))
        if item.get("omega3_rich") or item.get("omega3_flag"):
            omega3 += 1.0
        if item.get("seafood") or item.get("seafood_flag"):
            seafood += 1.0

    proc_total = sum(processing_counts.values()) or 1
    return {
        "minimally_processed_pct": 100.0 * processing_counts.get("minimally_processed", 0) / proc_total,
        "ultra_processed_pct": 100.0 * processing_counts.get("ultra_processed", 0) / proc_total,
        "distinct_plant_foods": float(distinct_plants),
        "omega3_servings": omega3,
        "seafood_servings": seafood,
    }


def _projected_seafood_servings_window(db: Any, user_id: int, end_date: date, days: int = 7) -> float:
    total = 0.0
    for offset in range(days):
        d = end_date - timedelta(days=offset)
        plan = _get_projected_plan(db, user_id, d)
        if not plan:
            continue
        total += _projected_quality_signals(_active_plan_meals(plan)).get("seafood_servings", 0.0)
    return total


def _build_projected_indicators(
    db: Any,
    user_id: int,
    target_date: date,
    *,
    calorie_target: int,
    protein_target: int,
    carbs_target: int,
    fat_target: int,
    goal_id: str | None,
    resolved_targets: ResolvedNutritionTargets | None,
) -> NutritionIndicators | None:
    plan = _get_projected_plan(db, user_id, target_date)
    if not plan:
        return None
    meals = _active_plan_meals(plan)
    if not meals:
        return None

    targets = plan.get("targets") if isinstance(plan.get("targets"), dict) else {}
    plan_calorie_target = _num(targets.get("calories"), calorie_target) or calorie_target
    plan_calorie_target = _activity_adjusted_calorie_target(
        db,
        user_id,
        target_date,
        plan_calorie_target,
        goal_id=goal_id,
        resolved=resolved_targets,
    )
    plan_protein_target = (
        _num(targets.get("protein"), 0.0)
        or _num(targets.get("protein_g"), 0.0)
        or protein_target
    )
    plan_carbs_target = (
        _num(targets.get("carbs"), 0.0)
        or _num(targets.get("carbs_g"), 0.0)
        or carbs_target
    )
    plan_fat_target = (
        _num(targets.get("fat"), 0.0)
        or _num(targets.get("fat_g"), 0.0)
        or fat_target
    )

    total_cal = sum(_macro_from_meal(m, "calories") for m in meals)
    total_pro = sum(_macro_from_meal(m, "protein", "protein_g") for m in meals)
    total_carb = sum(_macro_from_meal(m, "carbs", "carbs_g") for m in meals)
    total_fat = sum(_macro_from_meal(m, "fat", "fat_g") for m in meals)
    micros, food_count, foods_with_micros = _projected_micros(meals)
    quality = _projected_quality_signals(meals)
    seafood_week = _projected_seafood_servings_window(db, user_id, target_date, days=7)

    indicators = NutritionIndicators(
        calories_logged=total_cal,
        calories_target=plan_calorie_target,
        protein_logged=total_pro,
        protein_target=plan_protein_target,
        carbs_logged=total_carb,
        carbs_target=plan_carbs_target,
        fat_logged=total_fat,
        fat_target=plan_fat_target,
        fiber_g=micros.get("fiber_g", 0.0),
        added_sugar_g=micros.get("added_sugar_g", 0.0),
        saturated_fat_g=micros.get("saturated_fat_g", 0.0),
        sodium_mg=micros.get("sodium_mg", 0.0),
        minimally_processed_pct=quality["minimally_processed_pct"],
        ultra_processed_pct=quality["ultra_processed_pct"],
        distinct_plant_foods=int(quality["distinct_plant_foods"]),
        omega3_servings=quality["omega3_servings"],
        seafood_servings_weekly=seafood_week,
        meals_logged=len(meals),
        meals_expected=len(meals),
        micronutrients=micros,
        food_count=food_count,
        foods_with_micros=foods_with_micros,
        hydration_logged=False,
    )
    setattr(indicators, "source", "projected")
    return indicators


def _aggregate_micros(db: Any, items: list[MealItem]) -> tuple[dict[str, float], int, int]:
    """Sum micronutrients across meal items. Returns (totals, food_count,
    foods_with_micros). Scales extra_nutrients by serving grams."""
    food_ids = [i.food_id for i in items if i.food_id is not None]
    nut_by_food: dict[int, FoodNutrition] = {}
    if food_ids:
        for n in db.exec(select(FoodNutrition).where(FoodNutrition.food_id.in_(food_ids))).all():
            nut_by_food[n.food_id] = n

    def _grams_consumed(item: MealItem, nut: FoodNutrition) -> float:
        grams = float(item.serving_grams or 0)
        if (
            grams <= 0
            and (nut.calories or 0) > 0
            and (nut.reference_grams or 0) > 0
            and (item.calories or 0) > 0
        ):
            grams = (float(item.calories) / float(nut.calories)) * float(nut.reference_grams)
        return grams

    micro_aliases: tuple[tuple[str, tuple[str, ...]], ...] = (
        ("calcium_mg", ("calcium_mg", "calcium")),
        ("iron_mg", ("iron_mg", "iron")),
        ("potassium_mg", ("potassium_mg", "potassium")),
        ("magnesium_mg", ("magnesium_mg", "magnesium")),
        ("vitamin_d_mcg", ("vitamin_d_mcg", "vitamin_d")),
        ("vitamin_b12_mcg", ("vitamin_b12_mcg", "vitamin_b12")),
        ("vitamin_c_mg", ("vitamin_c_mg", "vitamin_c")),
        ("vitamin_a_mcg", ("vitamin_a_mcg", "vitamin_a")),
        ("zinc_mg", ("zinc_mg", "zinc")),
        ("selenium_mcg", ("selenium_mcg", "selenium")),
        ("copper_mg", ("copper_mg", "copper")),
        ("manganese_mg", ("manganese_mg", "manganese")),
        ("boron_mg", ("boron_mg", "boron")),
        ("folate_mcg", ("folate_mcg", "folate_b9", "folate")),
        ("omega_3_g", ("omega_3_g", "omega_3")),
    )
    snapshot_fields: tuple[tuple[str, str], ...] = (
        ("fiber_g", "fiber_g"),
        ("added_sugar_g", "added_sugar_g"),
        ("sodium_mg", "sodium_mg"),
        ("saturated_fat_g", "saturated_fat_g"),
        ("cholesterol_mg", "cholesterol_mg"),
        ("sugar_g", "sugar_g"),
        ("caffeine_mg", "caffeine_mg"),
        ("potassium_mg", "potassium_mg"),
        ("calcium_mg", "calcium_mg"),
        ("magnesium_mg", "magnesium_mg"),
        ("iron_mg", "iron_mg"),
        ("vitamin_d_mcg", "vitamin_d_mcg"),
        ("vitamin_b12_mcg", "vitamin_b12_mcg"),
        ("folate_mcg", "folate_mcg"),
        ("zinc_mg", "zinc_mg"),
        ("omega_3_g", "omega_3_g"),
    )

    micros: dict[str, float] = {}
    with_micros = 0
    for item in items:
        snapshot_any = False
        snapshot_keys: set[str] = set()
        for attr, key in snapshot_fields:
            try:
                snapshot = getattr(item, attr, None)
                if snapshot is None:
                    continue
                micros[key] = micros.get(key, 0) + float(snapshot)
                snapshot_keys.add(key)
                snapshot_any = True
            except Exception:
                continue
        nut = nut_by_food.get(item.food_id) if item.food_id else None
        if not nut:
            if snapshot_any:
                with_micros += 1
            continue
        grams_consumed = _grams_consumed(item, nut)
        if grams_consumed <= 0 or nut.reference_grams <= 0:
            if snapshot_any:
                with_micros += 1
            continue
        scale = grams_consumed / float(nut.reference_grams)
        extras = nut.extra_nutrients or {}
        had_any = snapshot_any
        for store_key, aliases in micro_aliases:
            if store_key in snapshot_keys:
                continue
            for key in aliases:
                if key not in extras:
                    continue
                try:
                    v = float(extras[key]) * scale
                except Exception:
                    continue
                micros[store_key] = micros.get(store_key, 0) + v
                had_any = True
                break
        # fiber is a top-level column
        if getattr(item, "fiber_g", None) is None and nut.fiber is not None:
            micros["fiber_g"] = micros.get("fiber_g", 0) + float(nut.fiber) * scale
            had_any = True
        if had_any:
            with_micros += 1
    return micros, len(items), with_micros


# Supplement ingredient → micronutrient key mapping. Only ingredients
# that meaningfully contribute to the Nutrition Score's micro coverage
# land here; performance supps (creatine, beta-alanine, caffeine) are
# intentionally excluded. Values are (micro_key, unit_converter) where
# the converter maps the user's logged dose (in the supplement's
# default_unit) to the RDA key's unit.
#
# e.g. vitamin_d3 is logged in IU, but the RDA key is vitamin_d_mcg —
# 40 IU = 1 mcg for D3, so the converter divides by 40. Omega-3 stack
# rows are seeded/logged in mg, while the score vocabulary is grams.
_SUPPLEMENT_MICRO_MAP: dict[str, tuple[str, float]] = {
    "vitamin_d3":      ("vitamin_d_mcg", 1.0 / 40.0),   # IU → mcg
    "vitamin_d":       ("vitamin_d_mcg", 1.0 / 40.0),   # alias
    "vitamin_b12":     ("vitamin_b12_mcg", 1.0),
    "magnesium":       ("magnesium_mg", 1.0),
    "magnesium_glycinate": ("magnesium_mg", 1.0),
    "magnesium_citrate": ("magnesium_mg", 1.0),
    "iron":            ("iron_mg", 1.0),
    "omega_3":         ("omega_3_g", 1.0 / 1000.0),     # mg → g
    "fish_oil":        ("omega_3_g", 1.0 / 1000.0),     # mg → g
    "calcium":         ("calcium_mg", 1.0),
    "zinc":            ("zinc_mg", 1.0),
    "selenium":        ("selenium_mcg", 1.0),
    "vitamin_c":       ("vitamin_c_mg", 1.0),
    "potassium":       ("potassium_mg", 1.0),
    "folate":          ("folate_mcg", 1.0),
    "folic_acid":      ("folate_mcg", 1.0),
}


def _normalized_unit(value: Any) -> str:
    return str(value or "").strip().lower().replace("µ", "u").replace("μ", "u")


def _unit_adjusted_converter(slug: str, micro_key: str, unit: Any, fallback: float) -> float:
    unit_normalized = _normalized_unit(unit)
    if slug in ("vitamin_d3", "vitamin_d") and unit_normalized in ("mcg", "ug"):
        return 1.0
    if micro_key == "omega_3_g":
        if unit_normalized in ("g", "gram", "grams"):
            return 1.0
        if unit_normalized in ("mg", "milligram", "milligrams"):
            return 1.0 / 1000.0
        if unit_normalized in ("mcg", "ug", "microgram", "micrograms"):
            return 1.0 / 1_000_000.0
    return fallback


def _add_supplement_micros(db: Any, user_id: int, target_date: date, micros: dict) -> None:
    """Credit today's non-skipped supplement logs toward micronutrient
    coverage. Mutates `micros` in place. Doses are added on top of food
    micros — the RDA ratio used by the score already handles over-
    coverage correctly (capped at 100% per nutrient).

    A stack row with a scanned `nutrient_content` panel credits every
    nutrient on its label; rows without one fall back to the single-
    ingredient `_SUPPLEMENT_MICRO_MAP`.

    Macros (protein from whey, for example) are NOT credited here —
    that would let the user "hit protein" without actually eating food,
    which defeats the adherence signal. Only MICROS integrate.
    """
    from datetime import datetime, time, timezone
    from sqlmodel import select
    from app.models import SupplementLog, UserSupplementStack, SupplementIngredient

    start = datetime.combine(target_date, time.min, tzinfo=timezone.utc)
    end = datetime.combine(target_date, time.max, tzinfo=timezone.utc)
    try:
        logs = db.exec(
            select(SupplementLog).where(
                SupplementLog.user_id == user_id,
                SupplementLog.taken_at >= start,
                SupplementLog.taken_at <= end,
                SupplementLog.skipped == False,  # noqa: E712
            )
        ).all()
    except Exception:
        return
    if not logs:
        return

    # Cache stack + ingredient lookups to avoid N queries per log.
    stack_ids = list({log.stack_item_id for log in logs})
    stacks = (
        db.exec(select(UserSupplementStack).where(UserSupplementStack.id.in_(stack_ids))).all()
        if stack_ids else []
    )
    stack_by_id = {s.id: s for s in stacks}
    ingredient_ids = [s.supplement_ingredient_id for s in stacks if s.supplement_ingredient_id]
    ingredients = (
        db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ingredient_ids))).all()
        if ingredient_ids else []
    )
    ing_by_id = {i.id: i for i in ingredients}

    from app.services.supplement_name_match import infer_slug_from_name
    from app.services.nutrition.supplement_facts import credited_micros_from_content

    for log in logs:
        stack = stack_by_id.get(log.stack_item_id)
        if not stack:
            continue

        # Preferred path: a scanned Supplement Facts panel credits every
        # nutrient on the label — multivitamins, ZMA, electrolyte blends —
        # including trace minerals (boron, copper, manganese) the single-
        # ingredient slug map can't express.
        content = getattr(stack, "nutrient_content", None)
        if content:
            dose_amount = log.dose_amount if log.dose_amount is not None else stack.dose_amount
            credited = credited_micros_from_content(
                content, dose_amount, log.dose_unit or stack.dose_unit
            )
            if credited:
                for micro_key, amount in credited.items():
                    micros[micro_key] = micros.get(micro_key, 0.0) + amount
                continue

        # Fallback: single-ingredient supplements resolve to a catalog
        # slug, then through the static micro map. If the stack row is
        # linked to a seeded ingredient, use that. Otherwise fall back to
        # stable stack metadata before the editable display name — covers
        # brand-product entries like "Nutricost D3 5000 IU" without losing
        # identity when the user later renames the row.
        slug: str | None = None
        if stack.supplement_ingredient_id:
            ing = ing_by_id.get(stack.supplement_ingredient_id)
            slug = ing.slug if ing else None
        if not slug:
            slug = _infer_supplement_slug_from_stack_metadata(stack)
        if not slug:
            slug = infer_slug_from_name(getattr(log, "name", None))
        if not slug:
            continue
        mapping = _SUPPLEMENT_MICRO_MAP.get(slug)
        if not mapping:
            continue
        micro_key, converter = mapping
        dose = float(log.dose_amount if log.dose_amount is not None else stack.dose_amount or 0)
        if dose <= 0:
            continue
        converter = _unit_adjusted_converter(slug, micro_key, log.dose_unit or stack.dose_unit, converter)
        micros[micro_key] = micros.get(micro_key, 0.0) + dose * converter


_OMEGA3_SUPPLEMENT_SLUGS = {"omega_3", "fish_oil", "epa_dha", "algae_oil"}
_SUPPLEMENT_SOURCE_TERM_SLUGS = {
    "fish": "omega_3",
    "sunlight": "vitamin_d3",
    "citrus": "vitamin_c",
    "banana": "potassium",
}


def _infer_supplement_slug_from_stack_metadata(stack: Any) -> str | None:
    from app.services.supplement_name_match import infer_slug_from_name

    for value in (
        getattr(stack, "custom_name", None),
        getattr(stack, "category", None),
        getattr(stack, "description", None),
    ):
        slug = infer_slug_from_name(value)
        if slug:
            return slug

    source_terms = getattr(stack, "source_terms", None)
    if isinstance(source_terms, list):
        for term in source_terms:
            normalized = str(term or "").strip().lower().replace("_", " ")
            slug = infer_slug_from_name(normalized)
            if slug:
                return slug
            if normalized in _SUPPLEMENT_SOURCE_TERM_SLUGS:
                return _SUPPLEMENT_SOURCE_TERM_SLUGS[normalized]

    food_sources = getattr(stack, "food_sources", None)
    if isinstance(food_sources, list):
        for source in food_sources:
            slug = infer_slug_from_name(source)
            if slug:
                return slug
    return None


def _supplement_slug_for_stack(stack: Any, ingredients_by_id: dict[int, Any]) -> str | None:
    if getattr(stack, "supplement_ingredient_id", None):
        ing = ingredients_by_id.get(stack.supplement_ingredient_id)
        if ing is not None and getattr(ing, "slug", None):
            return str(ing.slug)
    return _infer_supplement_slug_from_stack_metadata(stack)


def _supplement_slug_matches(requested: str, actual: str | None) -> bool:
    if not actual:
        return False
    if requested == "omega_3":
        return actual in _OMEGA3_SUPPLEMENT_SLUGS
    return actual == requested


def _count_supplement_logs(db: Any, user_id: int, target_date: date, ingredient_slug: str) -> float:
    """Count today's non-skipped supplement logs for a given ingredient
    slug. Used to credit supplement taking against Food Quality signals
    like omega-3 presence."""
    from datetime import datetime, time, timezone
    from sqlmodel import select
    from app.models import SupplementLog, UserSupplementStack, SupplementIngredient
    try:
        start = datetime.combine(target_date, time.min, tzinfo=timezone.utc)
        end = datetime.combine(target_date, time.max, tzinfo=timezone.utc)
        logs = db.exec(
            select(SupplementLog).where(
                SupplementLog.user_id == user_id,
                SupplementLog.taken_at >= start,
                SupplementLog.taken_at <= end,
                SupplementLog.skipped == False,  # noqa: E712
            )
        ).all()
        if not logs:
            return 0.0

        stack_ids = list({log.stack_item_id for log in logs})
        stacks = (
            db.exec(
                select(UserSupplementStack).where(
                    UserSupplementStack.user_id == user_id,
                    UserSupplementStack.id.in_(stack_ids),
                )
            ).all()
            if stack_ids else []
        )
        stack_by_id = {s.id: s for s in stacks}
        ingredient_ids = [s.supplement_ingredient_id for s in stacks if s.supplement_ingredient_id]
        ingredients = (
            db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ingredient_ids))).all()
            if ingredient_ids else []
        )
        ing_by_id = {i.id: i for i in ingredients}

        count = 0
        from app.services.supplement_name_match import infer_slug_from_name
        for log in logs:
            stack = stack_by_id.get(log.stack_item_id)
            if not stack:
                continue
            slug = _supplement_slug_for_stack(stack, ing_by_id)
            if not slug:
                slug = infer_slug_from_name(getattr(log, "name", None))
            if _supplement_slug_matches(ingredient_slug, slug):
                count += 1
        return float(count)
    except Exception:
        return 0.0


def build_indicators(
    db: Any, user_id: int, target_date: date,
) -> tuple[NutritionIndicators, str, str | None]:
    """Assemble today's NutritionIndicators. Returns (indicators, goal_id, sex)."""
    profile, goal = _get_profile_and_goal(db, user_id)
    cal_target, pro_target, carbs_target, fat_target, goal_id, sex, resolved_targets = _compute_targets(
        db,
        user_id,
        profile,
        goal,
        target_date,
    )
    base_cal_target = cal_target

    cal_target = int(round(_activity_adjusted_calorie_target(
        db,
        user_id,
        target_date,
        base_cal_target,
        goal_id=goal_id,
        resolved=resolved_targets,
    )))

    # Ensure today's metrics row is fresh. Keep score reads deterministic:
    # collagen/probiotic facts come from rule-based metadata, not OpenAI.
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
    items_by_meal: dict[int, list[MealItem]] = {}
    for item in items:
        items_by_meal.setdefault(item.meal_id, []).append(item)
    meals = dedupe_meals_for_aggregation(meals, items_by_meal)
    kept_meal_ids = {m.id for m in meals}
    items = [item for item in items if item.meal_id in kept_meal_ids]

    total_cal = sum(float(i.calories or 0) for i in items)
    total_pro = sum(float(i.protein_g or 0) for i in items)
    total_carb = sum(float(i.carbs_g or 0) for i in items)
    total_fat = sum(float(i.fat_g or 0) for i in items)

    if not items:
        projected = _build_projected_indicators(
            db,
            user_id,
            target_date,
            calorie_target=base_cal_target,
            protein_target=pro_target,
            carbs_target=carbs_target,
            fat_target=fat_target,
            goal_id=goal_id,
            resolved_targets=resolved_targets,
        )
        if projected is not None:
            return projected, goal_id, sex

    micros, food_count, foods_with_micros = _aggregate_micros(db, items)
    # Credit logged supplement doses toward the micro pool (vitamin D3,
    # B12, iron, magnesium, omega-3). Food still counts fully; supps
    # just add on top. Keeps the Score honest for users who fill a
    # vitamin-D gap via a pill instead of salmon — both are valid.
    _add_supplement_micros(db, user_id, target_date, micros)

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

    # Omega-3 servings — count logged omega-3 supplement doses too so a
    # user who takes EPA/DHA caps daily still shows as "omega-3 present"
    # on the Food Quality score. 1 cap / day = 1 serving-equivalent.
    supplemental_omega3 = _count_supplement_logs(db, user_id, target_date, "omega_3")
    omega3_servings_today = (float(metrics.omega3_servings) if metrics else 0.0) + supplemental_omega3

    indicators = NutritionIndicators(
        calories_logged=total_cal,
        calories_target=cal_target,
        protein_logged=total_pro,
        protein_target=pro_target,
        carbs_logged=total_carb,
        carbs_target=carbs_target,
        fat_logged=total_fat,
        fat_target=fat_target,
        fiber_g=float(metrics.fiber_total_g) if metrics else (micros.get("fiber_g", 0.0)),
        added_sugar_g=float(getattr(metrics, "added_sugar_g", 0) or 0) if metrics else 0,
        saturated_fat_g=float(metrics.saturated_fat_g) if metrics else 0,
        sodium_mg=float(getattr(metrics, "sodium_mg", 0) or 0) if metrics else 0,
        minimally_processed_pct=min_proc_pct,
        ultra_processed_pct=upf_pct,
        distinct_plant_foods=int(metrics.distinct_plant_foods) if metrics else 0,
        omega3_servings=omega3_servings_today,
        seafood_servings_weekly=seafood_week,
        meals_logged=len(meals),
        meals_expected=len(meals),
        micronutrients=micros,
        food_count=food_count,
        foods_with_micros=foods_with_micros,
        hydration_logged=hydration_logged,
    )
    setattr(indicators, "source", "logged")
    return indicators, goal_id, sex


def compute_today_score(db: Any, user_id: int, target_date: date | None = None) -> dict:
    """Return a ready-to-render payload for the UI."""
    if target_date is None:
        target_date = date.today()
    indicators, goal_id, sex = build_indicators(db, user_id, target_date)
    completeness = classify_nutrition_day(
        db,
        user_id,
        target_date,
        calorie_target=indicators.calories_target,
    )
    if indicators.calories_logged <= 0 and indicators.meals_logged == 0:
        return {
            "date": str(target_date),
            "score": 0,
            "source": "empty",
            "adherence": 0,
            "quality": 0,
            "micro": 0,
            "confidence": "low",
            "wins": [],
            "improvements": ["Add meals to your day to calculate a nutrition score."],
            "tags": [],
            "likely_gaps": [],
            "flags": {},
            "indicators": {},
            "completeness": completeness.to_dict(),
            "adherence_breakdown": [],
            "quality_breakdown": [],
            "micro_breakdown": [],
            "targets": {
                "calories": indicators.calories_target,
                "protein_g": indicators.protein_target,
                "carbs_g": indicators.carbs_target,
                "fat_g": indicators.fat_target,
            },
            "totals": {
                "calories": 0,
                "protein_g": 0,
                "carbs_g": 0,
                "fat_g": 0,
            },
            "goal": goal_id,
            "score_version": SCORE_VERSION,
        }
    score = compute_nutrition_score(indicators, goal=goal_id, sex=sex)

    return {
        "date": str(target_date),
        "score": score.total,
        "source": getattr(indicators, "source", "logged"),
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
        "completeness": completeness.to_dict(),
        "adherence_breakdown": score.adherence_breakdown,
        "quality_breakdown": score.quality_breakdown,
        "micro_breakdown": score.micro_breakdown,
        "targets": {
            "calories": indicators.calories_target,
            "protein_g": indicators.protein_target,
            "carbs_g": indicators.carbs_target,
            "fat_g": indicators.fat_target,
        },
        "totals": {
            "calories": round(indicators.calories_logged),
            "protein_g": round(indicators.protein_logged, 1),
            "carbs_g": round(indicators.carbs_logged, 1),
            "fat_g": round(indicators.fat_logged, 1),
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
        completeness = classify_nutrition_day(
            db,
            user_id,
            d,
            calorie_target=indicators.calories_target,
        )
        if indicators.calories_logged <= 0 and indicators.meals_logged == 0:
            daily.append({
                "date": str(d),
                "score": None,
                "logged": False,
                "completeness": completeness.to_dict(),
            })
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
            "source": getattr(indicators, "source", "logged"),
            "adherence": score.adherence_score,
            "quality": score.quality_score,
            "micro": score.micro_score,
            "logged": True,
            "completeness": completeness.to_dict(),
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
