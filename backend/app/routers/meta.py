from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from app.database import get_session
from app.enums import GoalType, GoalPace, Gender, MealType, EquipmentType, MuscleGroup
from app.models import Exercise

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
