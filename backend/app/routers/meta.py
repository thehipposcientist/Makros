from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.database import get_session
from app.enums import GoalType, GoalPace, Gender, MealType, EquipmentType, MuscleGroup, FoodCategory, FoodSource
from app.models import Exercise, Food, Equipment, ExerciseEquipment, GoalOption, PaceOption
from app.seed_exercises_data import RETIRED_EXERCISE_SLUGS, SEED_EQUIPMENT, SEED_EXERCISES

router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("/options")
def get_options():
    """
    Returns all valid enum values for every categorical field in the app.
    The frontend uses this to populate dropdowns and validate inputs
    without hardcoding values in two places.
    """
    return {
        "goal_types":   [e.value for e in GoalType],
        "goal_paces":   [e.value for e in GoalPace],
        "genders":      [e.value for e in Gender],
        "meal_types":   [e.value for e in MealType],
        "equipment":    [e.value for e in EquipmentType],
        "muscle_groups":[e.value for e in MuscleGroup],
    }


@router.get("/exercises")
def list_exercises(
    muscle: str | None = None,
    equipment: str | None = None,
    db: Session = Depends(get_session),
):
    """
    Returns the exercise library. Filterable by muscle group and equipment.
    Used to populate exercise picker / autocomplete in the app.

    Response includes both the legacy `equipment` bucket (home/gym/minimal/
    full) and a `gear` list of concrete items from ExerciseEquipment
    (resistance_bands / dumbbell / barbell ...). The client renders `gear`
    as "Equipment: Resistance Band" and treats the bucket as a separate
    "Setting: Home-friendly" label so users don't see "Equipment: Home".
    """
    query = select(Exercise)
    if muscle:
        query = query.where(Exercise.primary_muscle == muscle)
    if equipment:
        query = query.where(Exercise.equipment == equipment)
    exercises = db.exec(query.order_by(Exercise.primary_muscle, Exercise.name)).all()
    if RETIRED_EXERCISE_SLUGS:
        exercises = [e for e in exercises if e.slug not in RETIRED_EXERCISE_SLUGS]

    # Batch the gear lookup so we don't issue one query per exercise.
    ex_ids = [e.id for e in exercises if e.id is not None]
    gear_by_exercise: dict[int, list[dict]] = {}
    if ex_ids:
        rows = db.exec(
            select(ExerciseEquipment, Equipment)
            .join(Equipment, Equipment.id == ExerciseEquipment.equipment_id)
            .where(ExerciseEquipment.exercise_id.in_(ex_ids))
        ).all()
        for link, eq in rows:
            gear_by_exercise.setdefault(link.exercise_id, []).append({
                "slug": eq.slug,
                "name": eq.name,
                "category": eq.category,
                "required": link.required,
                "role": link.role,
            })

    seed_aliases_by_slug = {
        row.get("slug"): row.get("aliases", [])
        for row in SEED_EXERCISES
        if row.get("slug")
    }
    out: list[dict] = []
    for e in exercises:
        d = e.model_dump() if hasattr(e, "model_dump") else e.dict()
        d["gear"] = gear_by_exercise.get(e.id or -1, [])
        d["aliases"] = seed_aliases_by_slug.get(e.slug, [])
        # Keep `equipment` (the bucket) as-is for backwards compat. The
        # client reads `gear` first and only falls back to bucket.
        out.append(d)
    return out


@router.get("/exercises/{exercise_id}")
def get_exercise(exercise_id: int, db: Session = Depends(get_session)):
    exercise = db.get(Exercise, exercise_id)
    if not exercise:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Exercise not found")
    return exercise


@router.post("/exercises/enrich-images")
def enrich_exercise_images(db: Session = Depends(get_session)):
    """One-time enrichment: match exercises to wger.de and store image URLs."""
    from app.services.workout.wger_exercises import _INDEX, _fetch_exercise_info

    exercises = db.exec(select(Exercise).where(Exercise.image_url == None)).all()
    if not exercises:
        return {"enriched": 0, "message": "All exercises already have images or none need enrichment"}

    enriched = 0
    for ex in exercises:
        entry = _INDEX.by_name.get(ex.name.lower().strip())
        if not entry:
            for wname, wentry in _INDEX.by_name.items():
                if ex.name.lower() in wname or wname in ex.name.lower():
                    entry = wentry
                    break
        if not entry:
            continue
        info = _fetch_exercise_info(entry["wger_id"])
        if not info:
            continue
        images = [i.get("image", "") for i in info.get("images", []) if i.get("image")]
        if images:
            ex.image_url = images[0]
            db.add(ex)
            enriched += 1
            print(f"[enrich] {ex.name} → {images[0][:60]}...")

    db.commit()
    return {"enriched": enriched, "total": len(exercises)}


@router.get("/foods")
def list_foods(category: str | None = None, db: Session = Depends(get_session)):
    """
    Returns the curated template food library with macros scaled to each
    food's DEFAULT SERVING, not per-100g. Larger USDA catalog rows live behind
    /foods/search so signup/settings stay focused instead of downloading the
    full searchable catalog.

    Now joins `FoodServing` and returns the default serving's precomputed
    macros plus its human-readable label as `unit`.
    """
    from app.models import FoodMetadata, FoodNutrition, FoodServing
    from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, normalize_name
    query = select(Food).where(Food.source == FoodSource.SEED, Food.owner_user_id == None)  # noqa: E711
    if category:
        query = query.where(Food.category == category)
    foods = db.exec(query.order_by(Food.category, Food.name)).all()
    if not foods:
        return []

    # Batch-fetch default servings for every food we're returning.
    food_ids = [f.id for f in foods if f.id is not None]
    servings = db.exec(
        select(FoodServing).where(FoodServing.food_id.in_(food_ids))
    ).all()
    # Group by food_id; pick is_default, or fall back to first.
    by_food: dict[int, list[FoodServing]] = {}
    for s in servings:
        by_food.setdefault(s.food_id, []).append(s)
    nutrition_rows = db.exec(
        select(FoodNutrition).where(FoodNutrition.food_id.in_(food_ids))
    ).all()
    nutrition_by_food = {n.food_id: n for n in nutrition_rows}
    normalized_names = [normalize_name(f.name) for f in foods if f.name]
    metadata_rows = db.exec(
        select(FoodMetadata)
        .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
        .where(FoodMetadata.normalized_name.in_(normalized_names))
    ).all() if normalized_names else []
    metadata_by_name = {m.normalized_name: m for m in metadata_rows}

    def scaled_nutrients(food_id: int | None, grams: float | None) -> dict:
        nutrition = nutrition_by_food.get(food_id or -1)
        if nutrition is None:
            return {}
        ratio = (
            float(grams) / float(nutrition.reference_grams)
            if grams and nutrition.reference_grams and nutrition.reference_grams > 0
            else 1.0
        )
        out = {
            "fiber": round(float(nutrition.fiber or 0) * ratio, 2),
            "sugar": round(float(nutrition.sugar or 0) * ratio, 2),
            "added_sugar_g": round(float(getattr(nutrition, "added_sugar_g", 0) or 0) * ratio, 2),
            "sodium": round(float(nutrition.sodium_mg or 0) * ratio, 2),
            "sodium_mg": round(float(nutrition.sodium_mg or 0) * ratio, 2),
        }
        extras = nutrition.extra_nutrients or {}
        if isinstance(extras, dict):
            for key in (
                "saturated_fat", "omega_3", "calcium", "iron", "potassium",
                "magnesium", "vitamin_d", "vitamin_b12",
            ):
                try:
                    out[key] = round(float(extras.get(key) or 0) * ratio, 2)
                except (TypeError, ValueError):
                    out[key] = 0
        return out

    def classification_fields(food: Food) -> dict:
        meta = metadata_by_name.get(normalize_name(food.name))
        if meta is None:
            return {}
        bucket = meta.processing_bucket
        return {
            "processing_bucket": bucket,
            "food_quality": (
                "whole" if bucket == "minimally_processed"
                else "processed" if bucket in ("processed", "ultra_processed")
                else "unknown"
            ),
            "plant_count": meta.plant_count_value,
            "omega3_rich": meta.omega3_flag,
            "omega3_flag": meta.omega3_flag,
            "seafood": meta.seafood_flag,
            "seafood_flag": meta.seafood_flag,
        }

    result = []
    for f in foods:
        entry = {
            "id": f.id,
            "name": f.name,
            "category": f.category,
            "unit": f.unit,
            "calories": f.calories,
            "protein": f.protein,
            "carbs": f.carbs,
            "fat": f.fat,
            "is_custom": f.is_custom,
        }
        rows = by_food.get(f.id or -1, [])
        default_row = next((r for r in rows if r.is_default), rows[0] if rows else None)
        if default_row is not None:
            entry["unit"] = default_row.label
            entry["calories"] = default_row.calories
            entry["protein"] = default_row.protein
            entry["carbs"] = default_row.carbs
            entry["fat"] = default_row.fat
            entry["serving_grams"] = default_row.grams
            entry.update(scaled_nutrients(f.id, default_row.grams))
        else:
            entry.update(scaled_nutrients(f.id, f.serving_grams))
        entry.update(classification_fields(f))
        result.append(entry)
    return result


@router.get("/food-categories")
def list_food_categories():
    """
    Returns food category metadata (label + icon) keyed by the FoodCategory enum value.
    Matches the keys used in the foods table so the frontend can group foods by category.
    """
    return {
        "proteins":       {"label": "Proteins",       "icon": "🥩"},
        "plant_proteins": {"label": "Plant Proteins",  "icon": "🌱"},
        "dairy":          {"label": "Dairy & Eggs",    "icon": "🥛"},
        "grains_carbs":   {"label": "Grains & Carbs",  "icon": "🍞"},
        "vegetables":     {"label": "Vegetables",      "icon": "🥦"},
        "fruits":         {"label": "Fruits",          "icon": "🍎"},
        "fats_oils":      {"label": "Fats & Oils",     "icon": "🥜"},
    }


@router.get("/equipment")
def list_equipment(category: str | None = None, db: Session = Depends(get_session)):
    """
    Returns the equipment library. Optionally filterable by category.
    Used to populate equipment picker in EditProfileScreen.
    """
    query = select(Equipment)
    if category:
        query = query.where(Equipment.category == category)
    equipment = db.exec(query.order_by(Equipment.category, Equipment.name)).all()
    aliases_by_slug = {
        row.get("slug"): row.get("aliases", [])
        for row in SEED_EQUIPMENT
        if row.get("slug")
    }
    out: list[dict] = []
    for e in equipment:
        d = e.model_dump() if hasattr(e, "model_dump") else e.dict()
        d["aliases"] = aliases_by_slug.get(e.slug, [])
        out.append(d)
    return out


@router.get("/goals")
def list_goals(db: Session = Depends(get_session)):
    """
    Returns all goal options with their metadata.
    Used to populate goal picker in onboarding.
    """
    goals = db.exec(select(GoalOption).order_by(GoalOption.label)).all()
    return goals


@router.get("/paces")
def list_paces(goal: str | None = None, db: Session = Depends(get_session)):
    """
    Returns pace options, optionally filtered by goal type.
    Used to populate pace picker in onboarding.
    """
    query = select(PaceOption)
    if goal:
        query = query.where(PaceOption.goal_value == goal)
    paces = db.exec(query.order_by(PaceOption.label)).all()
    return paces


@router.get("/goal-config")
def get_goal_config():
    """
    Returns goal category classification and timeline weeks mapping.
    Replaces the frontend constants/goals.ts goal-category sets and TIMELINE_WEEKS.
    """
    return {
        "weight_goals":   ["fat_loss", "toning", "muscle_gain"],
        "timeline_goals": ["body_recomp", "strength", "endurance", "athletic_performance"],
        "lifestyle_goals":["maintain", "flexibility", "stress_relief"],
        "timeline_weeks": {
            "body_recomp":          {"conservative": 12, "moderate": 24, "aggressive": 52},
            "strength":             {"conservative": 4,  "moderate": 12, "aggressive": 26},
            "endurance":            {"conservative": 4,  "moderate": 8,  "aggressive": 16},
            "athletic_performance": {"conservative": 4,  "moderate": 12, "aggressive": 26},
        },
    }
