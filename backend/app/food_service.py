"""
Food search, creation, USDA import, and AI-fallback helpers.

All functions accept a SQLModel Session so they integrate naturally with
the existing FastAPI dependency-injection pattern:

    @router.get("/foods/search")
    def search(q: str, db: Session = Depends(get_session), user: User = Depends(get_current_user)):
        return search_foods(db, q, user_id=user.id)
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlmodel import Session, select, col, or_
from sqlalchemy import and_

from app.models import (
    Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
    FoodRead, FoodServingRead,
)
from app.enums import FoodSource, FoodCategory
from app.seed_micronutrients_data import (
    get_micronutrients_for,
    split_into_columns_and_extras,
)


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _normalize(name: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation."""
    return re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()


def normalize_food_name(name: str) -> str:
    """Public normalizer for food search/result de-duping."""
    return _normalize(name)


def _search_match_clauses(column, norm: str) -> list:
    """Build local-search clauses for contiguous and out-of-order tokens."""
    tokens = [token for token in norm.split() if token]
    if not tokens:
        return []
    clauses = [col(column).contains(norm)]
    if len(tokens) > 1:
        clauses.append(and_(*(col(column).contains(token) for token in tokens)))
    return clauses


def _serving_grams_estimate(unit: str) -> float:
    """Best-effort gram estimate from a unit label."""
    u = unit.lower().strip()
    if "g" in u:
        m = re.search(r"(\d+)\s*g", u)
        if m:
            return float(m.group(1))
    if "cup" in u:
        return 240
    if "tbsp" in u:
        return 15
    if "oz" in u:
        m = re.search(r"([\d.]+)\s*oz", u)
        if m:
            return float(m.group(1)) * 28.35
    return 100


def _food_to_read(food: Food, nutrition: FoodNutrition | None, servings: list[FoodServing]) -> FoodRead:
    """Assemble a FoodRead response from DB rows."""
    return FoodRead(
        id=food.id,
        name=food.name,
        category=food.category.value if hasattr(food.category, "value") else food.category,
        source=food.source.value if hasattr(food.source, "value") else food.source,
        external_id=food.external_id,
        brand=food.brand,
        is_verified=food.is_verified,
        calories=nutrition.calories if nutrition else food.calories,
        protein=nutrition.protein if nutrition else food.protein,
        carbs=nutrition.carbs if nutrition else food.carbs,
        fat=nutrition.fat if nutrition else food.fat,
        fiber=nutrition.fiber if nutrition else food.fiber,
        reference_unit=nutrition.reference_unit if nutrition else food.unit,
        servings=[
            FoodServingRead(
                id=s.id, label=s.label, grams=s.grams, is_default=s.is_default,
                calories=s.calories, protein=s.protein, carbs=s.carbs, fat=s.fat,
            )
            for s in servings
        ],
    )


def _first_serving(food: FoodRead) -> FoodServingRead | None:
    default = next((s for s in food.servings if s.is_default), None)
    return default or (food.servings[0] if food.servings else None)


def food_read_to_search_result(food: FoodRead, *, preferred_names: set[str] | None = None) -> dict:
    """Convert a DB food read model into the search-result shape used by
    the mobile food picker. Existing clients expect USDA/AI-style fields,
    so this keeps `serving`, top-level macros, and `source` stable while
    adding IDs when we have them."""
    preferred_names = preferred_names or set()
    serving = _first_serving(food)
    serving_label = serving.label if serving else (food.reference_unit or "100 g")
    serving_grams = serving.grams if serving else None
    source_value = food.source.value if hasattr(food.source, "value") else food.source
    result = {
        "name": food.name,
        "serving": serving_label,
        "calories": serving.calories if serving else food.calories,
        "protein": serving.protein if serving else food.protein,
        "carbs": serving.carbs if serving else food.carbs,
        "fat": serving.fat if serving else food.fat,
        "fiber": food.fiber,
        "source": food.source,
        "food_id": food.id,
        "serving_id": serving.id if serving else None,
        "serving_grams": serving_grams,
        "fdc_id": food.external_id if source_value == FoodSource.USDA.value else None,
        "external_id": food.external_id,
        "brand": food.brand,
        "is_verified": food.is_verified,
        "is_preferred": _normalize(food.name) in preferred_names,
    }
    if food.fiber is not None:
        result["micronutrients"] = {"fiber": food.fiber}
    return result


def merge_food_search_results(
    *,
    local_results: list[dict],
    remote_results: list[dict],
    preferred_names: set[str] | None = None,
    limit: int = 20,
) -> list[dict]:
    """Merge local and remote search results with stable source priority.

    Local DB rows win de-dupes because they can carry `food_id` and user
    history. Remote rows still fill gaps, which gives the MyFitnessPal-style
    broad search without demoting the user's own foods or the curated set.
    """
    preferred_names = preferred_names or set()
    merged: list[dict] = []
    seen: set[str] = set()

    for group in (local_results, remote_results):
        for item in group:
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            source = str(item.get("source") or "")
            key = _normalize(name)
            if key in seen:
                continue
            seen.add(key)
            copy = dict(item)
            copy["source"] = source or "unknown"
            copy["is_preferred"] = copy.get("is_preferred", key in preferred_names)
            merged.append(copy)
            if len(merged) >= limit:
                return merged
    return merged


# ─── Search ───────────────────────────────────────────────────────────────────

def search_foods(
    db: Session,
    query: str,
    user_id: int | None = None,
    limit: int = 30,
) -> list[FoodRead]:
    """
    Search foods with ranked results:
      1. User's own custom foods  (source=user, owner_user_id matches)
      2. User's recent foods      (by last_used_at desc)
      3. Curated seed foods       (source=seed, is_verified=True)
      4. Verified imported foods   (source=usda/barcode, is_verified=True)
      5. AI-created foods          (source=ai)

    Uses LIKE on normalized_name + aliases.
    """
    norm = _normalize(query)
    if not norm:
        return []

    visibility_filter = (
        Food.owner_user_id == None  # noqa: E711
        if user_id is None
        else or_(Food.owner_user_id == None, Food.owner_user_id == user_id)  # noqa: E711
    )
    candidate_limit = max(limit * 8, 50)
    name_clauses = _search_match_clauses(Food.normalized_name, norm)
    alias_clauses = _search_match_clauses(FoodAlias.alias_normalized, norm)

    # Find food_ids matching by name or alias
    name_matches = db.exec(
        select(Food.id).where(
            Food.is_active == True,
            visibility_filter,
            or_(*name_clauses),
        ).limit(candidate_limit)
    ).all()

    alias_matches = db.exec(
        select(FoodAlias.food_id).where(
            or_(*alias_clauses),
        ).limit(candidate_limit)
    ).all()

    name_match_ids = set(name_matches)
    alias_match_ids = set(alias_matches)
    food_ids = list(name_match_ids | alias_match_ids)
    if not food_ids:
        return []

    # Fetch all matching foods
    foods = db.exec(select(Food).where(col(Food.id).in_(food_ids), visibility_filter)).all()
    food_ids = [f.id for f in foods if f.id is not None]
    if not food_ids:
        return []

    # Fetch nutrition + servings in batch
    nutrition_map: dict[int, FoodNutrition] = {}
    for fn in db.exec(select(FoodNutrition).where(col(FoodNutrition.food_id).in_(food_ids))).all():
        nutrition_map[fn.food_id] = fn

    servings_map: dict[int, list[FoodServing]] = {}
    for fs in db.exec(select(FoodServing).where(col(FoodServing.food_id).in_(food_ids))).all():
        servings_map.setdefault(fs.food_id, []).append(fs)

    # Recent foods for ranking
    recent_ids: set[int] = set()
    if user_id:
        recents = db.exec(
            select(UserRecentFood.food_id)
            .where(UserRecentFood.user_id == user_id)
            .where(col(UserRecentFood.food_id).in_(food_ids))
        ).all()
        recent_ids = set(recents)

    # Rank
    def _sort_key(f: Food) -> tuple:
        source = f.source.value if hasattr(f.source, "value") else f.source
        # Lower = better
        if f.owner_user_id is not None and f.owner_user_id == user_id:
            tier = 0
        elif f.id in recent_ids:
            tier = 1
        elif source == "seed":
            tier = 2
        elif source in ("usda", "barcode") and f.is_verified:
            tier = 3
        elif source == "ai":
            tier = 5
        else:
            tier = 4
        # Within tier, prefer exact/prefix name matches, then name token
        # matches, then alias-only matches. This makes "greek nonfat" and
        # "protein whey" feel closer to consumer food-database search.
        normalized = f.normalized_name or _normalize(f.name)
        if normalized == norm:
            match_rank = 0
        elif normalized.startswith(norm):
            match_rank = 1
        elif f.id in name_match_ids:
            match_rank = 2
        elif f.id in alias_match_ids:
            match_rank = 3
        else:
            match_rank = 4
        return (tier, match_rank, f.name.lower())

    foods.sort(key=_sort_key)

    return [
        _food_to_read(f, nutrition_map.get(f.id), servings_map.get(f.id, []))
        for f in foods[:limit]
    ]


# ─── Create / Upsert ─────────────────────────────────────────────────────────

def create_food(
    db: Session,
    *,
    name: str,
    category: FoodCategory = FoodCategory.PROTEINS,
    source: FoodSource = FoodSource.USER,
    owner_user_id: int | None = None,
    unit: str = "100g",
    serving_grams: float = 100,
    calories: float = 0,
    protein: float = 0,
    carbs: float = 0,
    fat: float = 0,
    fiber: float | None = None,
    sugar: float | None = None,
    added_sugar_g: float | None = None,
    sodium_mg: float | None = None,
    brand: str | None = None,
    external_id: str | None = None,
    barcode: str | None = None,
    is_verified: bool = False,
    aliases: list[str] | None = None,
    extra_servings: list[dict] | None = None,
) -> Food:
    """
    Create a food with its nutrition row, default serving, and optional aliases.
    Returns the Food row (with .id populated).
    """
    norm = _normalize(name)
    food = Food(
        name=name,
        normalized_name=norm,
        category=category,
        source=source,
        owner_user_id=owner_user_id,
        external_id=external_id,
        barcode=barcode,
        brand=brand,
        is_verified=is_verified,
        is_custom=(source == FoodSource.USER),
        # Legacy compat
        unit=unit,
        calories=calories,
        protein=protein,
        carbs=carbs,
        fat=fat,
        serving_grams=serving_grams,
    )
    db.add(food)
    db.flush()

    # Look up the micronutrient panel by name. If we have USDA-accurate
    # data for this food, merge it in — prefer caller-provided values for
    # the legacy macro columns (fiber/sugar/sodium) but fill any gaps from
    # the seed, and always populate `extra_nutrients` with the full panel
    # so nutrition-details UI doesn't show blanks for custom foods.
    panel = get_micronutrients_for(name)
    extras_json: dict | None = None
    if panel:
        top, extras_json = split_into_columns_and_extras(panel)
        if fiber == 0 and "fiber" in top:
            fiber = top["fiber"]
        if sugar == 0 and "sugar" in top:
            sugar = top["sugar"]
        if sodium_mg == 0 and "sodium_mg" in top:
            sodium_mg = top["sodium_mg"]

    if added_sugar_g is None and panel and "added_sugar_g" in (panel or {}):
        added_sugar_g = panel.get("added_sugar_g")
    if added_sugar_g is None and extras_json and "added_sugar" in extras_json:
        try:
            added_sugar_g = float(extras_json["added_sugar"])
        except Exception:
            pass
    db.add(FoodNutrition(
        food_id=food.id,
        reference_unit=unit,
        reference_grams=serving_grams,
        calories=calories, protein=protein, carbs=carbs, fat=fat,
        fiber=fiber, sugar=sugar, added_sugar_g=added_sugar_g, sodium_mg=sodium_mg,
        extra_nutrients=extras_json,
    ))
    db.add(FoodServing(
        food_id=food.id,
        label=unit,
        grams=serving_grams,
        is_default=True,
        calories=calories, protein=protein, carbs=carbs, fat=fat,
    ))

    # Extra servings (e.g. "1 cup" = 240g alongside "100g" default)
    if extra_servings:
        for es in extra_servings:
            ratio = es["grams"] / serving_grams if serving_grams > 0 else 1
            db.add(FoodServing(
                food_id=food.id,
                label=es["label"],
                grams=es["grams"],
                is_default=False,
                calories=round(calories * ratio, 1),
                protein=round(protein * ratio, 1),
                carbs=round(carbs * ratio, 1),
                fat=round(fat * ratio, 1),
            ))

    # Aliases
    if aliases:
        for alias in aliases:
            alias_norm = _normalize(alias)
            if alias_norm and alias_norm != norm:
                db.add(FoodAlias(
                    food_id=food.id,
                    alias=alias,
                    alias_normalized=alias_norm,
                ))

    db.commit()
    db.refresh(food)

    # Pre-classify processing_bucket for non-seed foods so the first meal
    # log doesn't pay the classification cost. AI is only called for USER
    # and BARCODE sources (explicit user-created foods); USDA gets the
    # deterministic pass only since the name is already canonical.
    if source != FoodSource.SEED:
        try:
            from app.services.nutrition.ai_classify import get_or_create_metadata
            get_or_create_metadata(
                name, db=db,
                allow_ai=(source in (FoodSource.USER, FoodSource.BARCODE)),
            )
        except Exception:
            pass  # classification failure must never block food creation

    return food


def touch_recent_food(db: Session, user_id: int, food_id: int, *, commit: bool = True) -> None:
    """Record that a user just logged this food (upsert)."""
    existing = db.exec(
        select(UserRecentFood).where(
            UserRecentFood.user_id == user_id,
            UserRecentFood.food_id == food_id,
        )
    ).first()
    if existing:
        existing.times_used += 1
        existing.last_used_at = datetime.now(timezone.utc)
        db.add(existing)
    else:
        db.add(UserRecentFood(user_id=user_id, food_id=food_id))
    if commit:
        db.commit()


def _float_or_none(value) -> float | None:
    try:
        if value in (None, ""):
            return None
        parsed = float(value)
        return parsed if parsed > 0 else None
    except (TypeError, ValueError):
        return None


def _grams_from_serving_label(label: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*g\b", label or "", flags=re.IGNORECASE)
    return float(match.group(1)) if match else None


def _category_from_food_name(name: str) -> FoodCategory:
    try:
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
        if any(k in lower for k in ("coffee", "tea", "juice", "smoothie", "water", "soda")):
            return FoodCategory.BEVERAGES
        if any(k in lower for k in ("oil", "butter", "nut", "avocado", "tahini")):
            return FoodCategory.FATS_OILS
    except Exception:
        pass
    return FoodCategory.GRAINS_CARBS


def upsert_catalog_food_from_search_item(db: Session, item: dict, *, user_id: int | None = None) -> Food | None:
    """Persist a selected search result once it becomes part of a logged meal.

    Searching alone stays read-through. User-selected USDA foods become
    verified global rows. User-selected AI foods become private, unverified
    rows for that user so they are easy to reuse without leaking estimates into
    the shared catalog.
    """
    if not isinstance(item, dict):
        return None
    source = str(item.get("source") or "").lower()
    fdc_id = str(item.get("fdc_id") or item.get("external_id") or "").strip()
    if source not in {"usda", "ai", "user"}:
        return None
    if source == "usda" and not fdc_id:
        return None

    name = str(item.get("name") or "").strip()
    if not name:
        return None
    norm = _normalize(name)

    if source == "usda":
        existing = db.exec(
            select(Food).where(Food.external_id == fdc_id, Food.source == FoodSource.USDA)
        ).first()
        if existing:
            return existing
    else:
        if user_id is None:
            return None
        food_source = FoodSource.AI if source == "ai" else FoodSource.USER
        existing = db.exec(
            select(Food).where(
                Food.normalized_name == norm,
                Food.owner_user_id == user_id,
                Food.source == food_source,
                Food.is_active == True,  # noqa: E712
            )
        ).first()
        if existing:
            return existing

    serving_label = str(item.get("serving") or item.get("unit") or "100 g").strip() or "100 g"
    serving_grams = (
        _float_or_none(item.get("serving_grams"))
        or _grams_from_serving_label(serving_label)
        or 100.0
    )
    micros = item.get("micronutrients") if isinstance(item.get("micronutrients"), dict) else {}

    def micro(*keys: str) -> float | None:
        for key in keys:
            val = _float_or_none(micros.get(key))
            if val is not None:
                return val
        return None

    fiber = _float_or_none(item.get("fiber")) or micro("fiber")
    sugar = micro("sugar")
    sodium_mg = micro("sodium_mg", "sodium")
    added_sugar_g = micro("added_sugar_g", "added_sugar")
    extras = {}
    for k, raw in micros.items():
        if k in {"fiber", "sugar", "sodium", "sodium_mg", "added_sugar", "added_sugar_g"}:
            continue
        parsed = _float_or_none(raw)
        if parsed is not None:
            extras[k] = parsed
    extras = extras or None

    food = Food(
        name=name,
        normalized_name=norm,
        category=_category_from_food_name(name),
        source=FoodSource.USDA if source == "usda" else FoodSource.AI if source == "ai" else FoodSource.USER,
        owner_user_id=None if source == "usda" else user_id,
        external_id=fdc_id or None,
        brand=item.get("brand"),
        is_verified=(source == "usda"),
        is_custom=(source in {"ai", "user"}),
        unit=serving_label,
        serving_grams=serving_grams,
        calories=float(item.get("calories") or 0),
        protein=float(item.get("protein") or 0),
        carbs=float(item.get("carbs") or 0),
        fat=float(item.get("fat") or 0),
    )
    db.add(food)
    db.flush()

    db.add(FoodNutrition(
        food_id=food.id,
        reference_unit=serving_label,
        reference_grams=serving_grams,
        calories=food.calories,
        protein=food.protein,
        carbs=food.carbs,
        fat=food.fat,
        fiber=fiber,
        sugar=sugar,
        added_sugar_g=added_sugar_g,
        sodium_mg=sodium_mg,
        extra_nutrients=extras,
    ))
    db.add(FoodServing(
        food_id=food.id,
        label=serving_label,
        grams=serving_grams,
        is_default=True,
        calories=food.calories,
        protein=food.protein,
        carbs=food.carbs,
        fat=food.fat,
    ))
    alias_norm = _normalize(name)
    if alias_norm and alias_norm != food.normalized_name:
        db.add(FoodAlias(food_id=food.id, alias=name, alias_normalized=alias_norm))
    return food


# ─── USDA Import ──────────────────────────────────────────────────────────────

def import_usda_food(
    db: Session,
    *,
    fdc_id: str,
    name: str,
    category: FoodCategory = FoodCategory.PROTEINS,
    brand: str | None = None,
    calories: float = 0,
    protein: float = 0,
    carbs: float = 0,
    fat: float = 0,
    fiber: float | None = None,
    sugar: float | None = None,
    sodium_mg: float | None = None,
    servings: list[dict] | None = None,
) -> Food:
    """
    Import a USDA FoodData Central food.  Deduplicates by external_id.
    servings: [{"label": "1 cup", "grams": 240}, ...]
    """
    existing = db.exec(
        select(Food).where(Food.external_id == fdc_id, Food.source == FoodSource.USDA)
    ).first()
    if existing:
        return existing

    extra = []
    if servings:
        for s in servings:
            extra.append({"label": s["label"], "grams": s["grams"]})

    return create_food(
        db,
        name=name,
        category=category,
        source=FoodSource.USDA,
        external_id=fdc_id,
        brand=brand,
        unit="100g",
        serving_grams=100,
        calories=calories, protein=protein, carbs=carbs, fat=fat,
        fiber=fiber, sugar=sugar, sodium_mg=sodium_mg,
        is_verified=True,
        extra_servings=extra,
        aliases=[name],  # creates an alias matching the display name
    )


# ─── AI Fallback ──────────────────────────────────────────────────────────────

def resolve_food_text(
    db: Session,
    text: str,
    user_id: int | None = None,
) -> Food | None:
    """
    Try to match free-text (e.g. 'grilled chicken breast 6oz') against existing
    foods before creating an AI fallback.  Returns an existing Food if found,
    or None if no match (caller should then call create_ai_food).
    """
    norm = _normalize(text)
    if not norm:
        return None

    # 1. Exact normalized_name match
    exact = db.exec(
        select(Food).where(Food.normalized_name == norm, Food.is_active == True)
    ).first()
    if exact:
        return exact

    # 2. Alias match
    alias = db.exec(
        select(FoodAlias).where(FoodAlias.alias_normalized == norm)
    ).first()
    if alias:
        return db.get(Food, alias.food_id)

    # 3. Substring match — take best seed/verified food
    candidates = db.exec(
        select(Food).where(
            Food.is_active == True,
            col(Food.normalized_name).contains(norm),
        ).limit(5)
    ).all()
    if candidates:
        # Prefer seed > usda > user > ai
        priority = {"seed": 0, "usda": 1, "barcode": 2, "user": 3, "ai": 4}
        candidates.sort(key=lambda f: priority.get(
            f.source.value if hasattr(f.source, "value") else f.source, 9
        ))
        return candidates[0]

    # 4. Try matching individual words (e.g. "grilled chicken breast" → "chicken breast")
    words = norm.split()
    if len(words) > 1:
        for length in range(len(words), 0, -1):
            for start in range(len(words) - length + 1):
                sub = " ".join(words[start:start + length])
                match = db.exec(
                    select(Food).where(
                        Food.normalized_name == sub, Food.is_active == True
                    )
                ).first()
                if match:
                    return match

    return None


def create_ai_food(
    db: Session,
    *,
    name: str,
    unit: str = "1 serving",
    serving_grams: float = 100,
    calories: float = 0,
    protein: float = 0,
    carbs: float = 0,
    fat: float = 0,
    category: FoodCategory = FoodCategory.PROTEINS,
) -> Food:
    """
    Create a temporary AI-generated food.  Marked source=ai, is_verified=False.
    These can be merged/cleaned up later or promoted to verified by admin review.
    """
    return create_food(
        db,
        name=name,
        category=category,
        source=FoodSource.AI,
        unit=unit,
        serving_grams=serving_grams,
        calories=calories, protein=protein, carbs=carbs, fat=fat,
        is_verified=False,
    )


def resolve_or_create_food(
    db: Session,
    *,
    name: str,
    unit: str = "1 serving",
    serving_grams: float = 100,
    calories: float = 0,
    protein: float = 0,
    carbs: float = 0,
    fat: float = 0,
    category: FoodCategory = FoodCategory.PROTEINS,
    user_id: int | None = None,
) -> Food:
    """
    Try to match the name against existing foods.  If no match, create an AI
    fallback food.  This is the main entry point for converting messy AI text
    into structured food references.
    """
    existing = resolve_food_text(db, name, user_id=user_id)
    if existing:
        return existing

    return create_ai_food(
        db,
        name=name, unit=unit, serving_grams=serving_grams,
        calories=calories, protein=protein, carbs=carbs, fat=fat,
        category=category,
    )
