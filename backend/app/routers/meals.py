from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select
from datetime import date

from app.database import get_session
from app.models import User, Meal, MealItem, MealCreate
from app.auth import get_current_user

router = APIRouter(prefix="/meals", tags=["meals"])


def _build_meal_response(meal: Meal, db: Session) -> dict:
    items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
    return {**meal.model_dump(), "items": [i.model_dump() for i in items]}


# ─── Create ───────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_meal(
    body: MealCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    meal = Meal(
        user_id=current_user.id,
        meal_date=body.meal_date,
        meal_type=body.meal_type,
        name=body.name,
        source=body.source,
        notes=body.notes,
    )
    db.add(meal)
    db.flush()

    for item_body in body.items:
        db.add(MealItem(meal_id=meal.id, **item_body.model_dump()))

    db.commit()
    db.refresh(meal)
    return _build_meal_response(meal, db)


# ─── List ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_meals(
    meal_date: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    query = select(Meal).where(Meal.user_id == current_user.id)
    if meal_date:
        query = query.where(Meal.meal_date == meal_date)
    meals = db.exec(query.order_by(Meal.meal_date.desc(), Meal.created_at)).all()
    return [_build_meal_response(m, db) for m in meals]


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

    totals = {"calories": 0.0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0}
    meal_data = []
    for meal in meals:
        items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
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
    for item in db.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all():
        db.delete(item)
    db.delete(meal)
    db.commit()
