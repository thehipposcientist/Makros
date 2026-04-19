"""Meal history service — persists checked-off meals and derives insights."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta, timezone, datetime

from sqlmodel import Session, select, col


# ─── Processed-food keyword detection ────────────────────────────────────────

_PROCESSED_KEYWORDS = frozenset([
    "chips", "candy", "soda", "cookie", "cookies", "cake", "donut", "donuts",
    "ice cream", "fries", "pizza", "burger", "hot dog", "nachos", "nuggets",
    "cereal", "granola bar", "protein bar", "pop tart", "instant", "frozen",
    "microwave", "packaged", "wrap", "tortilla chips", "crackers", "pretzels",
    "muffin", "bagel", "croissant", "pastry", "brownie", "syrup", "jam",
    "jelly", "margarine", "ranch", "mayo", "ketchup", "bbq sauce",
])

_WHOLE_KEYWORDS = frozenset([
    "chicken", "salmon", "tuna", "beef", "turkey", "egg", "eggs", "rice",
    "oats", "oatmeal", "quinoa", "sweet potato", "potato", "broccoli",
    "spinach", "kale", "avocado", "banana", "apple", "berries", "blueberries",
    "strawberries", "almonds", "walnuts", "olive oil", "greek yogurt",
    "cottage cheese", "lentils", "beans", "tofu", "tempeh", "shrimp",
])


def _classify_food(name: str) -> str:
    lower = name.lower()
    for kw in _PROCESSED_KEYWORDS:
        if kw in lower:
            return "processed"
    for kw in _WHOLE_KEYWORDS:
        if kw in lower:
            return "whole"
    return "unknown"


# ─── Log a meal from plan check-off ──────────────────────────────────────────

def log_meal_from_plan(
    user_id: int,
    meal_date: date,
    meal_type: str,
    meal_data: dict,
    source: str = "plan_check",
    *,
    db: Session,
) -> dict:
    """Create a Meal + MealItems from a checked-off MealSuggestion dict.

    ``meal_data`` mirrors the frontend MealSuggestion shape:
      { meal: str, items: [{name, quantity, unit, calories, protein, carbs, fat}], ... }
    """
    from app.models import Meal, MealItem
    from app.enums import MealType, MealSource

    # Resolve meal_type to enum — the client sends "meal_0", "breakfast", etc.
    mt_map = {
        "breakfast": MealType.BREAKFAST,
        "lunch": MealType.LUNCH,
        "dinner": MealType.DINNER,
        "snack": MealType.SNACK,
    }
    # If meal_type is "meal_N", try to infer from index or fall back to SNACK.
    resolved_type = mt_map.get(meal_type.lower())
    if resolved_type is None:
        # Heuristic: meal_0→breakfast, meal_1→lunch, meal_2→dinner, rest→snack
        try:
            idx = int(meal_type.split("_")[1])
            resolved_type = [MealType.BREAKFAST, MealType.LUNCH, MealType.DINNER, MealType.SNACK][min(idx, 3)]
        except (ValueError, IndexError):
            resolved_type = MealType.SNACK

    resolved_source = MealSource.GENERATED if source == "plan_check" else MealSource.LOGGED

    meal = Meal(
        user_id=user_id,
        meal_date=meal_date,
        meal_type=resolved_type,
        name=meal_data.get("meal", "Checked meal"),
        source=resolved_source,
        notes=None,
    )
    db.add(meal)
    db.flush()  # get meal.id

    items = meal_data.get("items") or []
    for item in items:
        db.add(MealItem(
            meal_id=meal.id,
            food_name=item.get("name", "Unknown"),
            quantity=float(item.get("quantity", 1)),
            unit=item.get("unit", "serving"),
            calories=float(item.get("calories", 0)),
            protein_g=float(item.get("protein", 0)),
            carbs_g=float(item.get("carbs", 0)),
            fat_g=float(item.get("fat", 0)),
        ))

    # If no structured items, create a single synthetic item from totals.
    if not items:
        db.add(MealItem(
            meal_id=meal.id,
            food_name=meal_data.get("meal", "Checked meal"),
            quantity=1,
            unit="serving",
            calories=float(meal_data.get("calories", 0)),
            protein_g=float(meal_data.get("protein", 0)),
            carbs_g=float(meal_data.get("carbs", 0)),
            fat_g=float(meal_data.get("fat", 0)),
        ))

    db.commit()
    db.refresh(meal)
    return {"id": meal.id, "name": meal.name, "meal_date": str(meal.meal_date)}


# ─── Meal history query ──────────────────────────────────────────────────────

def get_meal_history(user_id: int, days: int = 30, *, db: Session) -> list[dict]:
    """Get recent meal history with items, ordered by date desc."""
    from app.models import Meal, MealItem

    cutoff = date.today() - timedelta(days=days)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
        .order_by(col(Meal.meal_date).desc(), Meal.created_at)
    ).all()

    # Batch-load all items to avoid N+1
    meal_ids = [m.id for m in meals]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)

    result = []
    for m in meals:
        items = items_by_meal.get(m.id, [])
        result.append({
            "id": m.id,
            "meal_date": str(m.meal_date),
            "meal_type": m.meal_type.value if m.meal_type else None,
            "name": m.name,
            "source": m.source.value if m.source else None,
            "items": [
                {
                    "food_name": it.food_name,
                    "quantity": it.quantity,
                    "unit": it.unit,
                    "calories": it.calories,
                    "protein_g": it.protein_g,
                    "carbs_g": it.carbs_g,
                    "fat_g": it.fat_g,
                }
                for it in items
            ],
            "totals": {
                "calories": round(sum(it.calories for it in items), 1),
                "protein_g": round(sum(it.protein_g for it in items), 1),
                "carbs_g": round(sum(it.carbs_g for it in items), 1),
                "fat_g": round(sum(it.fat_g for it in items), 1),
            },
        })
    return result


# ─── Rolling averages ────────────────────────────────────────────────────────

def get_rolling_averages(user_id: int, window: int = 7, *, db: Session) -> dict:
    """Compute rolling nutrition averages: calories, protein, carbs, fat, fiber, meals_per_day.

    Aggregates directly from meals + meal_items tables.
    """
    from app.models import Meal, MealItem

    cutoff = date.today() - timedelta(days=window)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
    ).all()

    daily: dict[date, dict] = defaultdict(lambda: {
        "calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0, "meal_count": 0
    })

    # Batch-load all items to avoid N+1
    meal_ids = [m.id for m in meals]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)

    for m in meals:
        items = items_by_meal.get(m.id, [])
        day_data = daily[m.meal_date]
        day_data["meal_count"] += 1
        for it in items:
            day_data["calories"] += it.calories
            day_data["protein_g"] += it.protein_g
            day_data["carbs_g"] += it.carbs_g
            day_data["fat_g"] += it.fat_g

    # Use the full window as the denominator so that days with no data
    # count as zero, giving a true daily average over the period.
    denom = max(window, 1)

    return {
        "window_days": window,
        "days_with_data": len(daily),
        "avg_calories": round(sum(d["calories"] for d in daily.values()) / denom, 1),
        "avg_protein_g": round(sum(d["protein_g"] for d in daily.values()) / denom, 1),
        "avg_carbs_g": round(sum(d["carbs_g"] for d in daily.values()) / denom, 1),
        "avg_fat_g": round(sum(d["fat_g"] for d in daily.values()) / denom, 1),
        "avg_meals_per_day": round(
            sum(d["meal_count"] for d in daily.values()) / denom, 1
        ),
        "total_meals_logged": sum(d["meal_count"] for d in daily.values()),
    }


# ─── Common meals ────────────────────────────────────────────────────────────

def get_common_meals(user_id: int, min_count: int = 2, *, db: Session) -> list[dict]:
    """Find meals the user eats repeatedly (by name similarity). Top 10."""
    from app.models import Meal, MealItem

    meals = db.exec(
        select(Meal).where(Meal.user_id == user_id)
    ).all()

    # Group by lowercased meal name
    name_groups: dict[str, list[int]] = defaultdict(list)
    for m in meals:
        key = m.name.strip().lower()
        name_groups[key].append(m.id)

    # Batch-load all items for all meals to avoid N+1
    all_meal_ids = [mid for ids in name_groups.values() if len(ids) >= min_count for mid in ids]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(all_meal_ids))).all() if all_meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)

    results = []
    for name_key, meal_ids in name_groups.items():
        if len(meal_ids) < min_count:
            continue

        total_cal = 0.0
        total_pro = 0.0
        total_carb = 0.0
        total_fat = 0.0
        display_name = name_key  # will be overwritten

        for mid in meal_ids:
            items = items_by_meal.get(mid, [])
            total_cal += sum(it.calories for it in items)
            total_pro += sum(it.protein_g for it in items)
            total_carb += sum(it.carbs_g for it in items)
            total_fat += sum(it.fat_g for it in items)

        # Get a proper display name from the most recent meal
        last_meal = db.get(type(meals[0]), meal_ids[-1]) if meals else None
        if last_meal:
            display_name = last_meal.name

        n = len(meal_ids)
        results.append({
            "name": display_name,
            "count": n,
            "avg_calories": round(total_cal / n, 1),
            "avg_protein_g": round(total_pro / n, 1),
            "avg_carbs_g": round(total_carb / n, 1),
            "avg_fat_g": round(total_fat / n, 1),
        })

    results.sort(key=lambda r: -r["count"])
    return results[:10]


# ─── Nutrition patterns ──────────────────────────────────────────────────────

def get_nutrition_patterns(user_id: int, days: int = 14, *, db: Session) -> dict:
    """Detect patterns: skipped meals, protein deficits, calorie trends, weekday vs weekend."""
    from app.models import Meal, MealItem, UserGoal, UserProfile

    cutoff = date.today() - timedelta(days=days)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
    ).all()

    # Build daily aggregates
    daily: dict[date, dict] = {}
    for d in range(days):
        day = date.today() - timedelta(days=d)
        daily[day] = {
            "calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0,
            "meal_count": 0, "meal_types": Counter(),
            "food_names": [],
        }

    # Batch-load all items to avoid N+1
    _pattern_meal_ids = [m.id for m in meals]
    _pattern_all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(_pattern_meal_ids))).all() if _pattern_meal_ids else []
    _pattern_items_by_meal: dict[int, list] = defaultdict(list)
    for _item in _pattern_all_items:
        _pattern_items_by_meal[_item.meal_id].append(_item)

    for m in meals:
        if m.meal_date not in daily:
            continue
        items = _pattern_items_by_meal.get(m.id, [])
        day_data = daily[m.meal_date]
        day_data["meal_count"] += 1
        mt_val = m.meal_type.value if m.meal_type else "snack"
        day_data["meal_types"][mt_val] += 1
        for it in items:
            day_data["calories"] += it.calories
            day_data["protein_g"] += it.protein_g
            day_data["carbs_g"] += it.carbs_g
            day_data["fat_g"] += it.fat_g
            day_data["food_names"].append(it.food_name)

    # Days with 0 meals
    skipped_days = [str(d) for d, data in sorted(daily.items()) if data["meal_count"] == 0]

    # Meal type distribution
    type_totals: Counter = Counter()
    for data in daily.values():
        type_totals += data["meal_types"]

    # Skipped meal types (days where a specific type is missing)
    days_with_meals = [d for d, data in daily.items() if data["meal_count"] > 0]
    meal_type_skip_counts = {}
    for mt in ["breakfast", "lunch", "dinner"]:
        missing = sum(1 for d in days_with_meals if daily[d]["meal_types"].get(mt, 0) == 0)
        meal_type_skip_counts[mt] = missing

    # Weekday vs weekend calories
    weekday_cals = [data["calories"] for d, data in daily.items()
                    if d.weekday() < 5 and data["meal_count"] > 0]
    weekend_cals = [data["calories"] for d, data in daily.items()
                    if d.weekday() >= 5 and data["meal_count"] > 0]
    avg_weekday = round(sum(weekday_cals) / max(len(weekday_cals), 1), 0)
    avg_weekend = round(sum(weekend_cals) / max(len(weekend_cals), 1), 0)

    # Average daily protein
    protein_days = [data["protein_g"] for data in daily.values() if data["meal_count"] > 0]
    avg_protein = round(sum(protein_days) / max(len(protein_days), 1), 1)

    # Protein target from user goal/profile
    protein_target = None
    try:
        profile = db.exec(
            select(UserProfile).where(UserProfile.user_id == user_id)
        ).first()
        goal = db.exec(
            select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
        ).first()
        if profile and goal:
            # Rough protein target: 1g per lb bodyweight for muscle gain, 0.8 otherwise
            if goal.goal_type.value in ("muscle_gain", "strength", "body_recomp"):
                protein_target = round(profile.weight_lbs * 1.0, 0)
            else:
                protein_target = round(profile.weight_lbs * 0.8, 0)
    except Exception:
        pass  # Non-critical — insights degrade gracefully

    # Food quality distribution
    all_foods = []
    for data in daily.values():
        all_foods.extend(data["food_names"])
    whole_count = sum(1 for f in all_foods if _classify_food(f) == "whole")
    processed_count = sum(1 for f in all_foods if _classify_food(f) == "processed")
    unknown_count = len(all_foods) - whole_count - processed_count

    # Average calories
    cal_days = [data["calories"] for data in daily.values() if data["meal_count"] > 0]
    avg_calories = round(sum(cal_days) / max(len(cal_days), 1), 0)

    return {
        "period_days": days,
        "days_tracked": len(days_with_meals),
        "skipped_days": skipped_days,
        "skipped_day_count": len(skipped_days),
        "avg_calories": avg_calories,
        "avg_protein_g": avg_protein,
        "protein_target_g": protein_target,
        "weekday_avg_calories": avg_weekday,
        "weekend_avg_calories": avg_weekend,
        "calorie_weekday_weekend_diff": round(avg_weekday - avg_weekend, 0),
        "meal_type_distribution": dict(type_totals),
        "meal_type_skip_counts": meal_type_skip_counts,
        "food_quality": {
            "whole": whole_count,
            "processed": processed_count,
            "unknown": unknown_count,
            "whole_pct": round(whole_count / max(len(all_foods), 1) * 100, 0),
        },
    }


# ─── Coaching insights ───────────────────────────────────────────────────────

def get_meal_insights(user_id: int, *, db: Session) -> list[str]:
    """Generate 3-5 short coaching strings from meal patterns."""
    patterns = get_nutrition_patterns(user_id, days=14, db=db)
    averages = get_rolling_averages(user_id, window=7, db=db)
    insights: list[str] = []

    # Guard: not enough data
    if averages["days_with_data"] < 2:
        return ["Log a few more days of meals to unlock nutrition insights."]

    # 1. Protein tracking
    avg_pro = patterns["avg_protein_g"]
    target = patterns.get("protein_target_g")
    if target:
        pct = round(avg_pro / target * 100)
        if pct >= 90:
            insights.append(f"You average {avg_pro:.0f}g protein — on track for your goal ({target:.0f}g target).")
        elif pct >= 70:
            insights.append(f"You average {avg_pro:.0f}g protein — try to close the gap to your {target:.0f}g target.")
        else:
            insights.append(f"Your protein is averaging {avg_pro:.0f}g — well below your {target:.0f}g target. Prioritize protein-rich foods.")
    else:
        insights.append(f"You're averaging {avg_pro:.0f}g protein per day over the last 2 weeks.")

    # 2. Skipped meals
    skip_counts = patterns.get("meal_type_skip_counts", {})
    tracked = patterns["days_tracked"]
    if tracked > 0:
        worst_skip = max(skip_counts.items(), key=lambda x: x[1]) if skip_counts else None
        if worst_skip and worst_skip[1] >= 3:
            insights.append(
                f"{worst_skip[0].capitalize()} is your most skipped meal "
                f"(skipped {worst_skip[1]} of {tracked} days)."
            )

    # 3. Weekday vs weekend difference
    diff = patterns["calorie_weekday_weekend_diff"]
    if abs(diff) >= 200:
        direction = "drop" if diff > 0 else "increase"
        insights.append(
            f"Your calories {direction} ~{abs(diff):.0f}cal on weekends vs weekdays."
        )

    # 4. Consistency
    period = patterns["period_days"]
    skipped = patterns["skipped_day_count"]
    if skipped > period * 0.4:
        insights.append(
            f"You logged meals on {tracked} of {period} days — try to track more consistently."
        )
    elif tracked >= period * 0.8:
        insights.append(
            f"Great consistency — you tracked {tracked} of {period} days."
        )

    # 5. Food quality
    fq = patterns.get("food_quality", {})
    whole_pct = fq.get("whole_pct", 0)
    if whole_pct >= 70:
        insights.append("Your diet is mostly whole foods — keep it up!")
    elif fq.get("processed", 0) > fq.get("whole", 0):
        insights.append(
            "You're eating more processed than whole foods — try swapping in more lean proteins and vegetables."
        )

    return insights[:5]
