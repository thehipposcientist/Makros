"""Meal history service — persists checked-off meals and derives insights."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, timedelta, timezone, datetime
import json

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


def _normalize_meal_text(value: str | None) -> str:
    return " ".join((value or "").lower().strip().split())


def _normalized_item_signature(items: list[dict]) -> str:
    canonical = []
    for item in items or []:
        canonical.append({
            "name": _normalize_meal_text(str(item.get("name", ""))),
            "quantity": round(float(item.get("quantity", 0) or 0), 3),
            "unit": _normalize_meal_text(str(item.get("unit", ""))),
            "calories": round(float(item.get("calories", 0) or 0), 2),
            "protein": round(float(item.get("protein", 0) or 0), 2),
            "carbs": round(float(item.get("carbs", 0) or 0), 2),
            "fat": round(float(item.get("fat", 0) or 0), 2),
        })
    canonical.sort(key=lambda row: (
        row["name"], row["unit"], row["quantity"], row["calories"], row["protein"], row["carbs"], row["fat"]
    ))
    return json.dumps(canonical, separators=(",", ":"), sort_keys=True)


def _meal_source_name(meal: object) -> str:
    source = getattr(meal, "source", None)
    if source is None:
        return ""
    return str(getattr(source, "value", None) or getattr(source, "name", None) or source).lower()


def _is_generated_plan_meal(meal: object) -> bool:
    return _meal_source_name(meal) == "generated"


def _meal_recency_key(meal: object) -> tuple[str, int]:
    created = getattr(meal, "created_at", None)
    created_key = created.isoformat() if hasattr(created, "isoformat") else ""
    return (created_key, int(getattr(meal, "id", 0) or 0))


_GENERIC_MEAL_NAMES = frozenset({"new meal", "checked meal", "meal", "breakfast", "lunch", "dinner", "snack"})


def _meal_type_name(meal: object) -> str:
    meal_type = getattr(meal, "meal_type", None)
    return str(getattr(meal_type, "value", None) or getattr(meal_type, "name", None) or meal_type or "").lower()


def dedupe_generated_plan_meals(meals: list, items_by_meal: dict[int, list] | None = None) -> list:
    """Collapse repeated generated plan check-offs to the latest row.

    The client can legitimately add the same manually logged meal twice,
    so manual/logged rows stay untouched. Generated plan rows, however,
    represent checking a scheduled meal off once. Repeated taps, retries,
    or a plan reload can leave several rows with the same date + meal
    name; aggregators should count the latest copy only.
    """
    latest_generated_by_key: dict[tuple, object] = {}
    passthrough_ids: set[int] = set()

    for meal in meals:
        meal_id = int(getattr(meal, "id", 0) or 0)
        if not _is_generated_plan_meal(meal):
            passthrough_ids.add(meal_id)
            continue
        name_key = _normalize_meal_text(getattr(meal, "name", ""))
        meal_date = getattr(meal, "meal_date", None)
        if not name_key or meal_date is None:
            passthrough_ids.add(meal_id)
            continue
        type_key = _meal_type_name(meal)
        if name_key in _GENERIC_MEAL_NAMES:
            if items_by_meal is None:
                passthrough_ids.add(meal_id)
                continue
            signature = _normalized_item_signature([
                {
                    "name": getattr(item, "food_name", ""),
                    "quantity": getattr(item, "quantity", 0),
                    "unit": getattr(item, "unit", ""),
                    "calories": getattr(item, "calories", 0),
                    "protein": getattr(item, "protein_g", 0),
                    "carbs": getattr(item, "carbs_g", 0),
                    "fat": getattr(item, "fat_g", 0),
                }
                for item in items_by_meal.get(meal_id, [])
            ])
            key = (meal_date, type_key, name_key, signature)
        else:
            key = (meal_date, type_key, name_key)
        current = latest_generated_by_key.get(key)
        if current is None or _meal_recency_key(meal) >= _meal_recency_key(current):
            latest_generated_by_key[key] = meal

    kept_generated_ids = {
        int(getattr(meal, "id", 0) or 0)
        for meal in latest_generated_by_key.values()
    }
    return [
        meal for meal in meals
        if int(getattr(meal, "id", 0) or 0) in passthrough_ids
        or int(getattr(meal, "id", 0) or 0) in kept_generated_ids
    ]


def _meal_timestamp(meal: object) -> float | None:
    raw = getattr(meal, "consumed_at", None) or getattr(meal, "created_at", None)
    if raw is None or not hasattr(raw, "timestamp"):
        return None
    try:
        if raw.tzinfo is None:
            raw = raw.replace(tzinfo=timezone.utc)
        return float(raw.timestamp())
    except Exception:
        return None


def _meal_items_signature(items: list) -> str:
    return _normalized_item_signature([
        {
            "name": getattr(item, "food_name", ""),
            "quantity": getattr(item, "quantity", 0),
            "unit": getattr(item, "unit", ""),
            "calories": getattr(item, "calories", 0),
            "protein": getattr(item, "protein_g", 0),
            "carbs": getattr(item, "carbs_g", 0),
            "fat": getattr(item, "fat_g", 0),
        }
        for item in items
    ])


def dedupe_meals_for_aggregation(
    meals: list,
    items_by_meal: dict[int, list] | None = None,
    *,
    logged_retry_window_seconds: int = 120,
) -> list:
    """Collapse generated duplicates plus obvious logged-meal retries.

    Manual/saved meals can be intentionally repeated, so logged rows are
    only collapsed when the same date/type/name/items land within a short
    retry window.
    """
    deduped = dedupe_generated_plan_meals(meals, items_by_meal)
    if not items_by_meal or logged_retry_window_seconds <= 0:
        return deduped

    passthrough_ids: set[int] = set()
    logged_groups: dict[tuple, list] = defaultdict(list)
    for meal in deduped:
        meal_id = int(getattr(meal, "id", 0) or 0)
        if _meal_source_name(meal) != "logged":
            passthrough_ids.add(meal_id)
            continue
        name_key = _normalize_meal_text(getattr(meal, "name", ""))
        meal_date = getattr(meal, "meal_date", None)
        type_key = _meal_type_name(meal)
        signature = _meal_items_signature(items_by_meal.get(meal_id, []))
        if not name_key or meal_date is None or not signature:
            passthrough_ids.add(meal_id)
            continue
        logged_groups[(meal_date, type_key, name_key, signature)].append(meal)

    kept_logged_ids: set[int] = set()
    for rows in logged_groups.values():
        kept_times: list[float] = []
        for meal in sorted(rows, key=_meal_recency_key, reverse=True):
            meal_id = int(getattr(meal, "id", 0) or 0)
            ts = _meal_timestamp(meal)
            if ts is not None and any(abs(ts - kept) <= logged_retry_window_seconds for kept in kept_times):
                continue
            kept_logged_ids.add(meal_id)
            if ts is not None:
                kept_times.append(ts)

    kept_ids = passthrough_ids | kept_logged_ids
    return [
        meal for meal in deduped
        if int(getattr(meal, "id", 0) or 0) in kept_ids
    ]


def _delete_meal_with_items(db: Session, meal: object) -> None:
    from app.models import MealItem

    meal_id = getattr(meal, "id", None)
    if meal_id is None:
        return
    for item in db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all():
        db.delete(item)
    db.delete(meal)


# ─── Log a meal from plan check-off ──────────────────────────────────────────

def log_meal_from_plan(
    user_id: int,
    meal_date: date,
    meal_type: str,
    meal_data: dict,
    source: str = "plan_check",
    consumed_at: datetime | None = None,
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
        "pre_workout": MealType.PRE_WORKOUT,
        "post_workout": MealType.POST_WORKOUT,
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
    incoming_name = _normalize_meal_text(meal_data.get("meal", "Checked meal"))
    incoming_signature = _normalized_item_signature(meal_data.get("items") or [])

    # Idempotency for flaky networks / repeated meal-check taps:
    # if the exact same payload has already been logged for this
    # user/date/type/source, return the existing row instead of adding
    # another duplicate meal entry.
    existing_query = (
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(Meal.meal_date == meal_date)
        .where(Meal.source == resolved_source)
        .order_by(col(Meal.created_at).desc())
        .limit(20)
    )
    if source != "plan_check":
        existing_query = existing_query.where(Meal.meal_type == resolved_type)
    existing_meals = db.exec(existing_query).all()
    if existing_meals:
        existing_items = db.exec(
            select(MealItem).where(col(MealItem.meal_id).in_([m.id for m in existing_meals]))
        ).all()
        items_by_meal: dict[int, list[MealItem]] = defaultdict(list)
        for item in existing_items:
            items_by_meal[item.meal_id].append(item)
        for existing in existing_meals:
            if _normalize_meal_text(existing.name) != incoming_name:
                continue
            signature = _normalized_item_signature([
                {
                    "name": item.food_name,
                    "quantity": item.quantity,
                    "unit": item.unit,
                    "calories": item.calories,
                    "protein": item.protein_g,
                    "carbs": item.carbs_g,
                    "fat": item.fat_g,
                }
                for item in items_by_meal.get(existing.id, [])
            ])
            if signature == incoming_signature:
                deleted_duplicates = False
                if source == "plan_check":
                    for duplicate in existing_meals:
                        if duplicate.id == existing.id:
                            continue
                        if _normalize_meal_text(duplicate.name) != incoming_name:
                            continue
                        _delete_meal_with_items(db, duplicate)
                        deleted_duplicates = True
                if consumed_at is not None:
                    existing.consumed_at = consumed_at
                if source == "plan_check":
                    existing.meal_type = resolved_type
                    existing.source = resolved_source
                if consumed_at is not None or deleted_duplicates or source == "plan_check":
                    db.add(existing)
                    db.commit()
                    db.refresh(existing)
                return {
                    "id": existing.id,
                    "name": existing.name,
                    "meal_date": str(existing.meal_date),
                    "consumed_at": existing.consumed_at.isoformat() if existing.consumed_at else None,
                }

    replace_target = None
    if source == "plan_check" and existing_meals:
        same_name = [m for m in existing_meals if _normalize_meal_text(m.name) == incoming_name]
        if same_name:
            replace_target = max(same_name, key=_meal_recency_key)
            for duplicate in same_name:
                if duplicate.id != replace_target.id:
                    _delete_meal_with_items(db, duplicate)
        else:
            same_type = [m for m in existing_meals if m.meal_type == resolved_type]
            if len(same_type) == 1:
                replace_target = same_type[0]

    if replace_target is None and source == "plan_check":
        cross_source_meals = db.exec(
            select(Meal)
            .where(Meal.user_id == user_id)
            .where(Meal.meal_date == meal_date)
            .where(Meal.meal_type == resolved_type)
            .order_by(col(Meal.created_at).desc())
            .limit(10)
        ).all()
        if cross_source_meals:
            same_name = [m for m in cross_source_meals if _normalize_meal_text(m.name) == incoming_name]
            if len(same_name) == 1:
                replace_target = same_name[0]
            elif len(cross_source_meals) == 1:
                replace_target = cross_source_meals[0]

    if replace_target is not None:
        old_items = db.exec(select(MealItem).where(MealItem.meal_id == replace_target.id)).all()
        for item in old_items:
            db.delete(item)
        replace_target.name = meal_data.get("meal", "Checked meal")
        replace_target.meal_type = resolved_type
        replace_target.source = resolved_source
        replace_target.consumed_at = consumed_at or replace_target.consumed_at or datetime.now(timezone.utc)
        db.add(replace_target)
        db.flush()
        meal = replace_target
    else:
        meal = Meal(
            user_id=user_id,
            meal_date=meal_date,
            meal_type=resolved_type,
            name=meal_data.get("meal", "Checked meal"),
            source=resolved_source,
            notes=None,
            consumed_at=consumed_at or datetime.now(timezone.utc),
        )
        db.add(meal)
        db.flush()  # get meal.id

    # Build a name→food_id index so items can be linked to the food
    # library. Without this link, downstream code (gut_health metrics,
    # micronutrient aggregation) can't pull fiber/sodium/added_sugar
    # from FoodNutrition and everything reports zero.
    from app.models import Food
    import re as _re

    def _norm(s: str) -> str:
        # Lowercase, strip parens + punctuation, collapse whitespace.
        s = (s or "").lower()
        s = _re.sub(r"\([^)]*\)", " ", s)
        s = _re.sub(r"[^a-z0-9\s]+", " ", s)
        return _re.sub(r"\s+", " ", s).strip()

    food_rows = db.exec(select(Food).where(col(Food.is_active) == True)).all()  # noqa: E712
    # Build: exact-normalized index + first-word → list of candidates.
    food_id_by_norm: dict[str, tuple[int, float | None]] = {}
    first_word_index: dict[str, list[tuple[int, float | None, str]]] = {}
    for f in food_rows:
        norm_full = _norm(f.name or "")
        if norm_full and norm_full not in food_id_by_norm:
            food_id_by_norm[norm_full] = (f.id, f.serving_grams)
        first = norm_full.split(" ", 1)[0] if norm_full else ""
        if first:
            first_word_index.setdefault(first, []).append((f.id, f.serving_grams, norm_full))

    def _match_food(name: str) -> tuple[int | None, float | None]:
        key = _norm(name)
        if not key:
            return (None, None)
        # Tier 1: exact normalized match.
        if key in food_id_by_norm:
            fid, sg = food_id_by_norm[key]
            return (fid, sg)
        # Tier 2: query is a prefix of a known food (e.g. "bread" →
        # "bread white"). Pick shortest match so "chicken" beats
        # "chicken caesar salad" when user logged generic "chicken".
        first = key.split(" ", 1)[0]
        candidates = first_word_index.get(first, [])
        if candidates:
            # Prefer exact first-token match; fall back to shortest name.
            shortest = sorted(candidates, key=lambda t: len(t[2]))[0]
            return (shortest[0], shortest[1])
        # Tier 3: singular → plural (egg → eggs) via a suffix check.
        if not key.endswith("s"):
            plural = key + "s"
            if plural in food_id_by_norm:
                fid, sg = food_id_by_norm[plural]
                return (fid, sg)
        return (None, None)

    # Pre-load FoodNutrition for matched food_ids so we can reverse-
    # compute grams from calories (more robust than unit parsing, which
    # has to handle oz / fl_oz / cup / slice / piece / etc).
    from app.models import FoodNutrition, FoodServing
    from app.enums import FoodCategory, FoodSource
    match_cache: dict[str, tuple[int | None, float | None]] = {}
    for it in (meal_data.get("items") or []):
        nm = it.get("name") or ""
        if nm and nm not in match_cache:
            match_cache[nm] = _match_food(nm)
    all_food_ids = [fid for fid, _ in match_cache.values() if fid is not None]
    nut_by_food: dict[int, FoodNutrition] = {}
    if all_food_ids:
        for n in db.exec(select(FoodNutrition).where(col(FoodNutrition.food_id).in_(all_food_ids))).all():
            nut_by_food[n.food_id] = n

    def _item_micros(item: dict) -> dict:
        raw = item.get("micronutrients") or {}
        return raw if isinstance(raw, dict) else {}

    def _estimate_item_grams(item: dict) -> float:
        explicit = item.get("serving_grams")
        try:
            if explicit is not None and float(explicit) > 0:
                return float(explicit)
        except Exception:
            pass
        qty = float(item.get("quantity", 1) or 1)
        unit = str(item.get("unit") or "").strip().lower()
        if unit in ("g", "gram", "grams"):
            return qty
        if unit in ("kg", "kilogram", "kilograms"):
            return qty * 1000.0
        if unit in ("mg", "milligram", "milligrams"):
            return qty / 1000.0
        if unit in ("oz", "ounce", "ounces"):
            return qty * 28.35
        if unit in ("lb", "lbs", "pound", "pounds"):
            return qty * 453.59
        if unit in ("ml", "milliliter", "milliliters"):
            return qty
        if unit in ("l", "liter", "liters"):
            return qty * 1000.0
        household = {
            "cup": 240.0, "cups": 240.0,
            "tbsp": 15.0, "tablespoon": 15.0, "tablespoons": 15.0,
            "tsp": 5.0, "teaspoon": 5.0, "teaspoons": 5.0,
            "fl_oz": 30.0, "fl oz": 30.0,
            "piece": 50.0, "pieces": 50.0,
            "slice": 30.0, "slices": 30.0,
            "scoop": 30.0, "scoops": 30.0,
        }
        return max(1.0, qty * household.get(unit, 100.0))

    def _category_for_food(name: str) -> FoodCategory:
        from app.services.nutrition.food_classifier import classify_food
        cls = classify_food(name)
        lower = name.lower()
        if getattr(cls, "fruit_flag", False):
            return FoodCategory.FRUITS
        if getattr(cls, "vegetable_flag", False):
            return FoodCategory.VEGETABLES
        if cls.protein_source == "plant":
            return FoodCategory.PLANT_PROTEINS
        if cls.protein_source == "animal":
            if any(k in lower for k in ("milk", "yogurt", "cheese", "egg", "kefir", "skyr")):
                return FoodCategory.DAIRY
            return FoodCategory.PROTEINS
        if any(k in lower for k in ("oil", "butter", "nut", "avocado", "tahini")):
            return FoodCategory.FATS_OILS
        if any(k in lower for k in ("coffee", "tea", "juice", "smoothie", "water", "soda")):
            return FoodCategory.BEVERAGES
        return FoodCategory.GRAINS_CARBS

    def _upsert_logged_food_from_item(item: dict) -> tuple[int | None, float | None]:
        micros = _item_micros(item)
        if not micros:
            return (None, None)
        name = str(item.get("name") or "").strip()
        if not name:
            return (None, None)
        from app.services.nutrition.food_classifier import normalize_name
        normalized = normalize_name(name)
        grams = _estimate_item_grams(item)
        reference_unit = f"{item.get('quantity', 1) or 1} {item.get('unit') or 'serving'}".strip()

        food = db.exec(
            select(Food)
            .where(Food.normalized_name == normalized)
            .where(Food.owner_user_id == user_id)
            .where(Food.is_active == True)  # noqa: E712
        ).first()
        if food is None:
            food = Food(
                name=name,
                normalized_name=normalized,
                category=_category_for_food(name),
                source=FoodSource.AI,
                owner_user_id=user_id,
                is_verified=False,
                is_custom=True,
                unit=reference_unit,
                serving_grams=grams,
                calories=float(item.get("calories", 0) or 0),
                protein=float(item.get("protein", 0) or 0),
                carbs=float(item.get("carbs", 0) or 0),
                fat=float(item.get("fat", 0) or 0),
            )
            db.add(food)
            db.flush()

        nutrition = db.exec(select(FoodNutrition).where(FoodNutrition.food_id == food.id)).first()
        if nutrition is None:
            nutrition = FoodNutrition(food_id=food.id)

        extras = dict(nutrition.extra_nutrients or {})
        for k, raw_v in micros.items():
            try:
                v = float(raw_v or 0)
            except (TypeError, ValueError):
                continue
            if k == "fiber":
                nutrition.fiber = v
            elif k == "sugar":
                nutrition.sugar = v
            elif k in ("sodium", "sodium_mg"):
                nutrition.sodium_mg = v
            elif k in ("added_sugar", "added_sugar_g"):
                nutrition.added_sugar_g = v
            else:
                extras[k] = v
        nutrition.reference_unit = reference_unit
        nutrition.reference_grams = grams
        nutrition.calories = float(item.get("calories", 0) or 0)
        nutrition.protein = float(item.get("protein", 0) or 0)
        nutrition.carbs = float(item.get("carbs", 0) or 0)
        nutrition.fat = float(item.get("fat", 0) or 0)
        nutrition.extra_nutrients = extras
        db.add(nutrition)

        serving = db.exec(
            select(FoodServing)
            .where(FoodServing.food_id == food.id)
            .where(FoodServing.label == reference_unit)
        ).first()
        if serving is None:
            serving = FoodServing(food_id=food.id, label=reference_unit, grams=grams, is_default=True)
        serving.calories = nutrition.calories
        serving.protein = nutrition.protein
        serving.carbs = nutrition.carbs
        serving.fat = nutrition.fat
        db.add(serving)
        match_cache[name] = (food.id, grams)
        nut_by_food[food.id] = nutrition
        return (food.id, grams)

    items = meal_data.get("items") or []
    for item in items:
        name = item.get("name", "Unknown")
        food_id, default_grams = match_cache.get(name, (None, None))
        if food_id is None:
            food_id, default_grams = _upsert_logged_food_from_item(item)
        qty = float(item.get("quantity", 1) or 1)
        unit = str(item.get("unit") or "").strip().lower()
        item_cal = float(item.get("calories", 0) or 0)
        # Resolve consumed grams. Priority:
        #   1. Explicit `serving_grams` on the item.
        #   2. Unit is grams → quantity IS grams.
        #   3. Calories-based reverse computation using FoodNutrition
        #      per-100g calories (most robust, independent of unit zoo).
        #   4. Fallback: quantity × default_serving_grams.
        serving_grams = item.get("serving_grams")
        try:
            serving_grams = float(serving_grams) if serving_grams is not None else None
        except Exception:
            serving_grams = None
        if serving_grams is None:
            if unit in ("g", "gram", "grams"):
                serving_grams = qty
            elif unit in ("kg", "kilogram"):
                serving_grams = qty * 1000.0
            elif unit in ("mg", "milligram"):
                serving_grams = qty / 1000.0
            elif food_id is not None and item_cal > 0:
                nut = nut_by_food.get(food_id)
                if nut and nut.calories and nut.reference_grams:
                    # grams = (item_cal / per-ref calories) × reference_grams
                    per_ref_cal = float(nut.calories)
                    if per_ref_cal > 0:
                        serving_grams = (item_cal / per_ref_cal) * float(nut.reference_grams)
            if serving_grams is None and default_grams:
                serving_grams = float(default_grams) * qty
        db.add(MealItem(
            meal_id=meal.id,
            food_name=name,
            food_id=food_id,
            quantity=qty,
            unit=item.get("unit", "serving"),
            serving_grams=serving_grams,
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
    return {
        "id": meal.id,
        "name": meal.name,
        "meal_date": str(meal.meal_date),
        "consumed_at": meal.consumed_at.isoformat() if meal.consumed_at else None,
    }


# ─── Meal history query ──────────────────────────────────────────────────────

def get_meal_history(
    user_id: int,
    days: int = 30,
    limit: int = 50,
    *,
    db: Session,
) -> list[dict]:
    """Get recent meal history with items, ordered by date desc. Bounded by
    `days` lookback window and `limit` row count."""
    from app.models import Meal, MealItem

    cutoff = date.today() - timedelta(days=days)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
        .order_by(col(Meal.meal_date).desc(), col(Meal.created_at).desc())
    ).all()

    # Batch-load all items to avoid N+1
    meal_ids = [m.id for m in meals]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)
    meals = dedupe_meals_for_aggregation(meals, items_by_meal)[:limit]

    result = []
    for m in meals:
        items = items_by_meal.get(m.id, [])
        result.append({
            "id": m.id,
            "meal_date": str(m.meal_date),
            "meal_type": m.meal_type.value if m.meal_type else None,
            "name": m.name,
            "source": m.source.value if m.source else None,
            "consumed_at": m.consumed_at.isoformat() if m.consumed_at else None,
            "created_at": m.created_at.isoformat() if m.created_at else None,
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

def get_rolling_averages(user_id: int, window: int = 7, *, db: Session, end_date: date | None = None) -> dict:
    """Compute rolling nutrition averages: calories, protein, carbs, fat,
    meals/day. Aggregates directly from meals + meal_items tables.

    Returns BOTH a window-divided "true daily average" and a
    days-with-data-divided "average when logged":

      avg_calories            — sum / window_days. Honest per-day mean.
                                A user who logged 1 day at 2000cal across
                                a 7-day window reads as 286 cal/day, which
                                is the actual signal — they're undertracking
                                and/or undereating.
      avg_calories_when_logged — sum / days_with_data. Average for the days
                                the user actually tracked. Useful for
                                "your typical eating day" framing without
                                punishing imperfect tracking.

    Earlier version only returned the second flavor under the name
    `avg_calories`, which let sparse-loggers' downstream signals
    (supplement recs, readiness's nutrition pillar, weekly review) read
    as if their averages were target-aligned. Switching the headline to
    the honest window denominator is the user-visible bug fix; the
    `_when_logged` variants stay available for narrative copy.
    """
    from app.models import Meal, MealItem

    today_d = end_date or date.today()
    cutoff = today_d - timedelta(days=window - 1)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
        # Future-dated rows would otherwise inflate totals (timezone glitches,
        # back-log entry typos). Cap at today.
        .where(col(Meal.meal_date) <= today_d)
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
    meals = dedupe_meals_for_aggregation(meals, items_by_meal)

    for m in meals:
        items = items_by_meal.get(m.id, [])
        day_data = daily[m.meal_date]
        day_data["meal_count"] += 1
        for it in items:
            day_data["calories"] += it.calories
            day_data["protein_g"] += it.protein_g
            day_data["carbs_g"] += it.carbs_g
            day_data["fat_g"] += it.fat_g

    days_with_data = len(daily)
    window_denom = max(window, 1)
    logged_denom = max(days_with_data, 1)

    total_cal = sum(d["calories"] for d in daily.values())
    total_pro = sum(d["protein_g"] for d in daily.values())
    total_carb = sum(d["carbs_g"] for d in daily.values())
    total_fat = sum(d["fat_g"] for d in daily.values())
    total_meals = sum(d["meal_count"] for d in daily.values())

    return {
        "window_days": window,
        "days_with_data": days_with_data,
        # Honest window-divided averages — the headline numbers callers
        # should compare to daily targets (protein goal, calorie target).
        "avg_calories": round(total_cal / window_denom, 1),
        "avg_protein_g": round(total_pro / window_denom, 1),
        "avg_carbs_g": round(total_carb / window_denom, 1),
        "avg_fat_g": round(total_fat / window_denom, 1),
        "avg_meals_per_day": round(total_meals / window_denom, 1),
        # Per-tracked-day averages — for narrative ("your typical day looks
        # like…") and the "when you do log, you're hitting protein" framing.
        "avg_calories_when_logged": round(total_cal / logged_denom, 1),
        "avg_protein_g_when_logged": round(total_pro / logged_denom, 1),
        "avg_carbs_g_when_logged": round(total_carb / logged_denom, 1),
        "avg_fat_g_when_logged": round(total_fat / logged_denom, 1),
        "tracking_rate_pct": round(days_with_data / window_denom * 100, 1),
        "total_meals_logged": total_meals,
        "daily": [
            {
                "date": str(day),
                "calories": round(data["calories"], 1),
                "protein_g": round(data["protein_g"], 1),
                "carbs_g": round(data["carbs_g"], 1),
                "fat_g": round(data["fat_g"], 1),
                "meal_count": int(data["meal_count"]),
            }
            for day, data in sorted(daily.items())
            if data["meal_count"] > 0
        ],
    }


# ─── Common meals ────────────────────────────────────────────────────────────

def _normalize_meal_name(name: str) -> str:
    """Normalize a meal name for grouping: lowercase, strip parentheticals,
    collapse whitespace, handle common plural/singular equivalences."""
    import re
    n = (name or "").lower().strip()
    n = re.sub(r"\([^)]*\)", " ", n)
    n = re.sub(r"[^a-z0-9\s]+", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    n = re.sub(r"\b(\w+?)s\b", r"\1", n) if len(n) > 4 else n
    return n


def get_common_meals(
    user_id: int,
    min_count: int = 2,
    lookback_days: int = 90,
    limit: int = 20,
    *,
    db: Session,
) -> list[dict]:
    """Find meals the user eats repeatedly (by name similarity). Bounded
    by `lookback_days` (default 90) and `limit` (default 20)."""
    from app.models import Meal, MealItem

    cutoff = date.today() - timedelta(days=lookback_days)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
    ).all()

    # Batch-load all items up front so generic generated names ("New Meal")
    # only collapse when their item signatures are identical.
    meal_ids = [m.id for m in meals]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)
    meals = dedupe_meals_for_aggregation(meals, items_by_meal)

    # Group by normalized meal name for better deduplication
    name_groups: dict[str, list[int]] = defaultdict(list)
    for m in meals:
        key = _normalize_meal_name(m.name)
        name_groups[key].append(m.id)

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
    return results[:limit]


# ─── Nutrition patterns ──────────────────────────────────────────────────────

def get_nutrition_patterns(user_id: int, days: int = 14, *, db: Session) -> dict:
    """Detect patterns: skipped meals, protein deficits, calorie trends, weekday vs weekend."""
    from app.models import Meal, MealItem, UserGoal, UserProfile

    today_d = date.today()
    cutoff = today_d - timedelta(days=days)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= cutoff)
        # Future-dated rows would inflate totals (timezone glitches,
        # back-log typos). Cap at today.
        .where(col(Meal.meal_date) <= today_d)
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
    meals = dedupe_meals_for_aggregation(meals, _pattern_items_by_meal)

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

    # Average daily protein — divide by the FULL window, not just logged days.
    # Sparse loggers used to read as "on target" because dividing by 1-2
    # logged days made any single high-protein day look like the daily
    # average. The honest signal — total_protein / window_days — is what
    # downstream consumers (insights, supplement recs) need to compare
    # against the protein target. `avg_protein_when_logged` stays available
    # for narrative copy ("your typical eating day").
    all_daily_protein = [data["protein_g"] for data in daily.values()]
    logged_protein = [data["protein_g"] for data in daily.values() if data["meal_count"] > 0]
    avg_protein = round(sum(all_daily_protein) / max(days, 1), 1)
    avg_protein_when_logged = round(sum(logged_protein) / max(len(logged_protein), 1), 1)

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

    # Average calories — same window-divided treatment as protein above.
    # The headline "avg_calories" is the honest per-day signal; the
    # "_when_logged" companion is for "your typical eating day" framing.
    all_daily_cal = [data["calories"] for data in daily.values()]
    logged_cal = [data["calories"] for data in daily.values() if data["meal_count"] > 0]
    avg_calories = round(sum(all_daily_cal) / max(days, 1), 0)
    avg_calories_when_logged = round(sum(logged_cal) / max(len(logged_cal), 1), 0)

    ordered_days = sorted(daily.keys())
    midpoint = max(1, len(ordered_days) // 2)
    previous_days = ordered_days[:midpoint]
    recent_days = ordered_days[midpoint:]

    def _adherence_window(day_keys: list[date]) -> dict:
        # `logged` = days in this segment that have at least one meal.
        # Compare-vs-prior-week deltas need an APPLES-TO-APPLES denominator,
        # which is the full segment length — otherwise a user who logs 1
        # day at 3000 cal in week A vs 4 days at 2000 cal in week B reads
        # as "week A is higher" (3000 > 2000) even though week B's actual
        # daily intake was higher. Window denominator is the truthful one.
        logged = [daily[d] for d in day_keys if daily[d]["meal_count"] > 0]
        segment_days = max(len(day_keys), 1)
        protein_hits = 0
        if protein_target:
            protein_hits = sum(1 for data in logged if data["protein_g"] >= protein_target * 0.9)
        return {
            "days": len(day_keys),
            "logged_days": len(logged),
            "tracking_rate_pct": round(len(logged) / segment_days * 100, 0),
            # Honest segment-divided averages (sum / segment_days).
            "avg_calories": round(sum(d["calories"] for d in (daily[k] for k in day_keys)) / segment_days, 0),
            "avg_protein_g": round(sum(d["protein_g"] for d in (daily[k] for k in day_keys)) / segment_days, 1),
            # Per-tracked-day flavor for narrative copy.
            "avg_calories_when_logged": round(sum(d["calories"] for d in logged) / max(len(logged), 1), 0),
            "avg_protein_g_when_logged": round(sum(d["protein_g"] for d in logged) / max(len(logged), 1), 1),
            "protein_hit_days": protein_hits,
            "protein_hit_pct": round(protein_hits / segment_days * 100, 0) if protein_target else None,
        }

    recent_adherence = _adherence_window(recent_days)
    previous_adherence = _adherence_window(previous_days)
    tracking_delta = recent_adherence["tracking_rate_pct"] - previous_adherence["tracking_rate_pct"]
    recent_protein_pct = recent_adherence.get("protein_hit_pct")
    previous_protein_pct = previous_adherence.get("protein_hit_pct")
    protein_delta = (
        recent_protein_pct - previous_protein_pct
        if recent_protein_pct is not None and previous_protein_pct is not None
        else None
    )
    trend_signal = tracking_delta if protein_delta is None else (tracking_delta * 0.55 + protein_delta * 0.45)
    if trend_signal >= 10:
        direction = "improving"
    elif trend_signal <= -10:
        direction = "slipping"
    else:
        direction = "steady"

    current_logging_streak = 0
    current_protein_streak = 0
    for d in (date.today() - timedelta(days=i) for i in range(days)):
        data = daily.get(d)
        if not data or data["meal_count"] == 0:
            break
        current_logging_streak += 1
        if protein_target and data["protein_g"] >= protein_target * 0.9:
            current_protein_streak += 1
        elif protein_target:
            break

    return {
        "period_days": days,
        "days_tracked": len(days_with_meals),
        "skipped_days": skipped_days,
        "skipped_day_count": len(skipped_days),
        # Honest window-divided headlines — what a user expects to see when
        # they read "your average daily protein."
        "avg_calories": avg_calories,
        "avg_protein_g": avg_protein,
        # Per-tracked-day flavor — for "your typical eating day" copy.
        "avg_calories_when_logged": avg_calories_when_logged,
        "avg_protein_g_when_logged": avg_protein_when_logged,
        "tracking_rate_pct": round(len(days_with_meals) / max(days, 1) * 100, 0),
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
        "adherence_trends": {
            "direction": direction,
            "recent": recent_adherence,
            "previous": previous_adherence,
            "tracking_delta_pct": round(tracking_delta, 0),
            "protein_hit_delta_pct": round(protein_delta, 0) if protein_delta is not None else None,
            "calorie_delta": round(recent_adherence["avg_calories"] - previous_adherence["avg_calories"], 0),
            "calorie_delta_when_logged": round(
                recent_adherence["avg_calories_when_logged"] - previous_adherence["avg_calories_when_logged"], 0
            ),
            "current_logging_streak_days": current_logging_streak,
            "current_protein_streak_days": current_protein_streak if protein_target else None,
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

    # 5. Adherence trend
    trends = patterns.get("adherence_trends", {})
    direction = trends.get("direction")
    if direction == "improving":
        insights.append(
            f"Nutrition adherence is improving — tracking is up {trends.get('tracking_delta_pct', 0):.0f} points vs the prior week."
        )
    elif direction == "slipping":
        insights.append(
            f"Nutrition adherence is slipping — tracking is down {abs(trends.get('tracking_delta_pct', 0)):.0f} points vs the prior week."
        )
    elif trends.get("current_logging_streak_days", 0) >= 3:
        insights.append(
            f"You're on a {trends['current_logging_streak_days']}-day meal logging streak."
        )

    # 6. Food quality
    fq = patterns.get("food_quality", {})
    whole_pct = fq.get("whole_pct", 0)
    if whole_pct >= 70:
        insights.append("Your diet is mostly whole foods — keep it up!")
    elif fq.get("processed", 0) > fq.get("whole", 0):
        insights.append(
            "You're eating more processed than whole foods — try swapping in more lean proteins and vegetables."
        )

    return insights[:5]
