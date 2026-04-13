from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.database import get_session
from app.enums import GoalType, GoalPace, Gender, MealType, EquipmentType, MuscleGroup, FoodCategory
from app.models import Exercise, Food, Equipment, ExerciseEquipment, GoalOption, PaceOption

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
    """
    query = select(Exercise)
    if muscle:
        query = query.where(Exercise.primary_muscle == muscle)
    if equipment:
        query = query.where(Exercise.equipment == equipment)
    exercises = db.exec(query.order_by(Exercise.primary_muscle, Exercise.name)).all()
    return exercises


@router.get("/exercises/{exercise_id}")
def get_exercise(exercise_id: int, db: Session = Depends(get_session)):
    exercise = db.get(Exercise, exercise_id)
    if not exercise:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Exercise not found")
    return exercise


@router.get("/foods")
def list_foods(category: str | None = None, db: Session = Depends(get_session)):
    """
    Returns the food library with macros scaled to each food's DEFAULT SERVING,
    not per-100g. The frontend treats `calories`/`protein`/... as "what one
    unit of this food costs", so returning per-100g values was causing
    wildly wrong numbers (e.g. 1 tbsp olive oil showing 884 cal).

    Now joins `FoodServing` and returns the default serving's precomputed
    macros plus its human-readable label as `unit`.
    """
    from app.models import FoodServing
    query = select(Food)
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
    return equipment


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


