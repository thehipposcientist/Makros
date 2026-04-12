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
from sqlalchemy import func

from app.models import (
    Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
    FoodRead, FoodServingRead,
)
from app.enums import FoodSource, FoodCategory


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _normalize(name: str) -> str:
    """Lowercase, collapse whitespace, strip punctuation."""
    return re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()


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

    pattern = f"%{norm}%"

    # Find food_ids matching by name or alias
    name_matches = db.exec(
        select(Food.id).where(
            Food.is_active == True,
            col(Food.normalized_name).contains(norm),
        )
    ).all()

    alias_matches = db.exec(
        select(FoodAlias.food_id).where(
            col(FoodAlias.alias_normalized).contains(norm),
        )
    ).all()

    food_ids = list(set(name_matches) | set(alias_matches))
    if not food_ids:
        return []

    # Fetch all matching foods
    foods = db.exec(select(Food).where(col(Food.id).in_(food_ids))).all()

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
        if source == "user" and f.owner_user_id == user_id:
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
        # Within tier, prefer exact prefix match
        is_prefix = 0 if f.normalized_name.startswith(norm) else 1
        return (tier, is_prefix, f.name.lower())

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

    db.add(FoodNutrition(
        food_id=food.id,
        reference_unit=unit,
        reference_grams=serving_grams,
        calories=calories, protein=protein, carbs=carbs, fat=fat,
        fiber=fiber, sugar=sugar, sodium_mg=sodium_mg,
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
    return food


def touch_recent_food(db: Session, user_id: int, food_id: int) -> None:
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
    db.commit()


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
