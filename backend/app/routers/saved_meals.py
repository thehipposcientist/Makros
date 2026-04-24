"""Saved Meals — user-authored reusable food bundles.

Distinct from:
  • Routine meals (pinned/scheduled recurring — lives on UserProfile /
    NutritionPlan.routine_meals).
  • Recipes (ingredients + serving math + cooking instructions — later).

A SavedMeal stores a flat list of items + macro totals. Logging a saved
meal clones its items into a fresh Meal row, so the two concepts don't
leak state.
"""
from __future__ import annotations

from datetime import datetime, date, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.database import get_session
from app.models import Meal, MealItem, SavedMeal, User
from app.enums import MealType, MealSource
from app.auth import get_current_user


router = APIRouter(prefix="/meals/saved", tags=["meals"])


def _totals_from_items(items: list[dict]) -> tuple[float, float, float, float]:
    cal = sum(float(i.get("calories") or 0) for i in items)
    p = sum(float(i.get("protein_g") or 0) for i in items)
    c = sum(float(i.get("carbs_g") or 0) for i in items)
    f = sum(float(i.get("fat_g") or 0) for i in items)
    return round(cal, 1), round(p, 1), round(c, 1), round(f, 1)


@router.get("")
def list_saved_meals(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(SavedMeal)
        .where(SavedMeal.user_id == current_user.id)
        .order_by(SavedMeal.times_logged.desc(), SavedMeal.created_at.desc())
    ).all()
    return [r.model_dump() for r in rows]


@router.post("", status_code=201)
def create_saved_meal(
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Create a Saved Meal. Expected body:
        { name, notes?, items: [{food_name, food_id?, serving_id?,
          quantity, unit, serving_grams?, calories, protein_g, carbs_g, fat_g}, ...] }
    Can also create from an existing meal_id: {from_meal_id, name?}"""
    items: list[dict] = []
    name: str | None = body.get("name")

    from_meal_id = body.get("from_meal_id")
    if from_meal_id:
        meal = db.get(Meal, from_meal_id)
        if not meal or meal.user_id != current_user.id:
            raise HTTPException(status_code=404, detail="Source meal not found")
        if not name:
            name = meal.name
        meal_items = db.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
        items = [
            {
                "food_name": mi.food_name, "food_id": mi.food_id,
                "serving_id": mi.serving_id, "quantity": mi.quantity, "unit": mi.unit,
                "serving_grams": mi.serving_grams,
                "calories": mi.calories, "protein_g": mi.protein_g,
                "carbs_g": mi.carbs_g, "fat_g": mi.fat_g,
            }
            for mi in meal_items
        ]
    else:
        raw_items = body.get("items") or []
        if not isinstance(raw_items, list) or not raw_items:
            raise HTTPException(status_code=422, detail="items is required when from_meal_id not provided")
        for it in raw_items:
            if not isinstance(it, dict):
                continue
            items.append({
                "food_name": str(it.get("food_name") or it.get("name") or "").strip() or "Item",
                "food_id": it.get("food_id"),
                "serving_id": it.get("serving_id"),
                "quantity": float(it.get("quantity") or 1),
                "unit": str(it.get("unit") or "serving"),
                "serving_grams": it.get("serving_grams"),
                "calories": float(it.get("calories") or 0),
                "protein_g": float(it.get("protein_g") or 0),
                "carbs_g": float(it.get("carbs_g") or 0),
                "fat_g": float(it.get("fat_g") or 0),
            })

    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if not items:
        raise HTTPException(status_code=422, detail="at least one item is required")

    cal, p, c, f = _totals_from_items(items)
    row = SavedMeal(
        user_id=current_user.id, name=name, notes=body.get("notes"),
        total_calories=cal, total_protein_g=p, total_carbs_g=c, total_fat_g=f,
        items=items,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.patch("/{saved_id}")
def update_saved_meal(
    saved_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Edit the template. Past logs created from this saved meal are
    snapshots and stay unchanged — this matches how most trackers
    treat recipe/saved-meal edits (retroactive macro changes would
    rewrite history)."""
    row = db.get(SavedMeal, saved_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved meal not found")
    if "name" in body and body["name"]:
        row.name = str(body["name"]).strip()
    if "notes" in body:
        row.notes = body["notes"]
    if "items" in body and isinstance(body["items"], list):
        cleaned: list[dict] = []
        for it in body["items"]:
            if not isinstance(it, dict):
                continue
            cleaned.append({
                "food_name": str(it.get("food_name") or it.get("name") or "").strip() or "Item",
                "food_id": it.get("food_id"),
                "serving_id": it.get("serving_id"),
                "quantity": float(it.get("quantity") or 1),
                "unit": str(it.get("unit") or "serving"),
                "serving_grams": it.get("serving_grams"),
                "calories": float(it.get("calories") or 0),
                "protein_g": float(it.get("protein_g") or 0),
                "carbs_g": float(it.get("carbs_g") or 0),
                "fat_g": float(it.get("fat_g") or 0),
            })
        if not cleaned:
            raise HTTPException(status_code=422, detail="At least one item is required")
        row.items = cleaned
        cal, p, c, f = _totals_from_items(cleaned)
        row.total_calories = cal
        row.total_protein_g = p
        row.total_carbs_g = c
        row.total_fat_g = f
    db.add(row)
    db.commit()
    db.refresh(row)
    return row.model_dump()


@router.delete("/{saved_id}", status_code=204)
def delete_saved_meal(
    saved_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = db.get(SavedMeal, saved_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved meal not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.post("/{saved_id}/log", status_code=201)
def log_saved_meal(
    saved_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Log a saved meal as a fresh Meal row on `meal_date` / `meal_type`
    provided in the body (default today / snack). Clones items so the
    logged meal is independent of future edits to the saved template.
    """
    saved = db.get(SavedMeal, saved_id)
    if not saved or saved.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Saved meal not found")

    meal_date_str = body.get("meal_date")
    target_date = date.fromisoformat(meal_date_str) if meal_date_str else date.today()
    mt_str = (body.get("meal_type") or "snack").lower()
    try:
        mt = MealType(mt_str)
    except ValueError:
        mt = MealType.SNACK

    consumed_at = datetime.now(timezone.utc)
    if body.get("consumed_at"):
        try:
            consumed_at = datetime.fromisoformat(str(body["consumed_at"]).replace("Z", "+00:00"))
        except ValueError:
            pass

    meal = Meal(
        user_id=current_user.id, meal_date=target_date,
        meal_type=mt, name=saved.name,
        source=MealSource.LOGGED, notes=saved.notes,
        consumed_at=consumed_at,
    )
    db.add(meal)
    db.flush()

    # Backfill food_id at log time for any saved item that doesn't
    # carry one (older saves, items the user created by hand). Missing
    # food_id breaks the gut-health pipeline — fiber / sodium /
    # saturated fat / extras all come from FoodNutrition, joined by
    # food_id. Match by exact lowercase name against the Food table.
    from app.models import Food
    needed_names = {
        (it.get("food_name") or "").lower().strip()
        for it in (saved.items or [])
        if not it.get("food_id") and (it.get("food_name") or "").strip()
    }
    food_by_name: dict[str, int] = {}
    if needed_names:
        # Tolerant matcher: normalize both sides by lowercasing +
        # replacing non-alphanumerics with spaces + collapsing
        # whitespace. Matches "Spinach (Raw)" → "spinach raw" etc.
        import re as _re
        def _norm(s: str) -> str:
            return _re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()
        # Load all foods matching ANY of the normalized variants.
        normalized_targets = {_norm(n) for n in needed_names}
        if normalized_targets:
            rows = db.exec(select(Food)).all()
            for f in rows:
                key = _norm(f.name or "")
                if key and key in normalized_targets and key not in food_by_name:
                    food_by_name[key] = f.id

    for it in saved.items or []:
        fid = it.get("food_id")
        if not fid:
            # Use the same tolerant normalizer as the loader above.
            import re as _re2
            key = _re2.sub(r"[^a-z0-9]+", " ", (it.get("food_name") or "").lower()).strip()
            fid = food_by_name.get(key)
        db.add(MealItem(
            meal_id=meal.id,
            food_name=it.get("food_name") or "Item",
            food_id=fid,
            serving_id=it.get("serving_id"),
            quantity=float(it.get("quantity") or 1),
            unit=str(it.get("unit") or "serving"),
            serving_grams=it.get("serving_grams"),
            calories=float(it.get("calories") or 0),
            protein_g=float(it.get("protein_g") or 0),
            carbs_g=float(it.get("carbs_g") or 0),
            fat_g=float(it.get("fat_g") or 0),
        ))

    saved.times_logged = (saved.times_logged or 0) + 1
    saved.last_logged_at = datetime.now(timezone.utc)
    db.add(saved)
    db.commit()
    db.refresh(meal)

    # Refresh daily metrics so the new meal contributes immediately.
    try:
        from app.routers.meals import _refresh_daily_metrics  # noqa
        _refresh_daily_metrics(db, current_user.id, meal.meal_date)
    except Exception:
        pass
    return {"meal_id": meal.id, "saved_meal_id": saved.id, "times_logged": saved.times_logged}
