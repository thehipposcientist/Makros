"""Logged meal copy/split semantics.

These endpoints are deliberately DB-backed instead of client-only helpers:
copied/split meals need to refresh daily nutrition metrics and behave like
normal logged history rows.
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlmodel import Session, select

from tests._seed_helpers import make_seed_test_engine


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _user(session: Session):
    from app.models import User

    u = User(email="meal-copy@example.com", username="meal-copy", hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _logged_meal(session: Session, user_id: int):
    from app.enums import MealSource, MealType
    from app.models import Meal, MealItem

    meal = Meal(
        user_id=user_id,
        meal_date=date(2026, 5, 1),
        meal_type=MealType.LUNCH,
        name="Chicken rice bowl",
        source=MealSource.LOGGED,
        consumed_at=datetime(2026, 5, 1, 12, 30, tzinfo=timezone.utc),
    )
    session.add(meal)
    session.flush()
    session.add(MealItem(
        meal_id=meal.id,
        food_name="chicken breast",
        quantity=6,
        unit="oz",
        serving_grams=170,
        calories=280,
        protein_g=52,
        carbs_g=0,
        fat_g=6,
        sodium_mg=120,
        fiber_g=0,
        potassium_mg=420,
        calcium_mg=16,
        magnesium_mg=42,
    ))
    session.add(MealItem(
        meal_id=meal.id,
        food_name="rice",
        quantity=1,
        unit="cup",
        serving_grams=185,
        calories=205,
        protein_g=4,
        carbs_g=45,
        fat_g=0,
        sodium_mg=2,
        fiber_g=1,
        potassium_mg=55,
        calcium_mg=19,
        magnesium_mg=84,
    ))
    session.commit()
    session.refresh(meal)
    return meal


def test_copy_meal_can_scale_and_move_date() -> None:
    print("\n[test] copy logged meal: scaled clone on target date")
    from app.enums import MealType
    from app.models import Meal, MealItem, SavedMeal
    from app.routers.meals import CopyMealBody, copy_meal

    engine = make_seed_test_engine()
    with Session(engine) as session:
        user = _user(session)
        meal = _logged_meal(session, user.id)
        saved = SavedMeal(user_id=user.id, name="Favorite bowl", total_calories=485, total_protein_g=56, total_carbs_g=45, total_fat_g=6)
        session.add(saved)
        session.flush()
        meal.saved_meal_id = saved.id
        meal.client_meal_key = "meal_1"
        session.add(meal)
        session.commit()

        copied = copy_meal(
            meal_id=meal.id,
            body=CopyMealBody(
                meal_date="2026-05-02",
                meal_type="dinner",
                name="Half bowl",
                quantity_scale=0.5,
            ),
            current_user=user,
            db=session,
        )

        clone = session.get(Meal, copied["id"])
        assert clone is not None
        assert clone.meal_date == date(2026, 5, 2)
        assert clone.meal_type == MealType.DINNER
        assert clone.saved_meal_id is None
        assert clone.client_meal_key is None
        assert clone.consumed_at.hour == 12 and clone.consumed_at.minute == 30
        items = session.exec(select(MealItem).where(MealItem.meal_id == clone.id).order_by(MealItem.food_name)).all()
        assert len(items) == 2
        chicken = next(i for i in items if i.food_name == "chicken breast")
        assert chicken.quantity == 3
        assert chicken.calories == 140
        assert chicken.protein_g == 26
        assert chicken.sodium_mg == 60
        from app.services.nutrition.score_builder import _aggregate_micros
        micros, food_count, foods_with_micros = _aggregate_micros(session, items)
        assert food_count == 2
        assert foods_with_micros == 2
        assert micros["potassium_mg"] == 237.5
        assert micros["calcium_mg"] == 17.5
        assert micros["magnesium_mg"] == 63
    _ok("copy creates a normal scaled Meal row")


def test_split_meal_scales_original_and_creates_remainder() -> None:
    print("\n[test] split logged meal: original keeps fraction, remainder cloned")
    from app.models import Meal, MealItem, SavedMeal
    from app.routers.meals import SplitMealBody, split_meal

    engine = make_seed_test_engine()
    with Session(engine) as session:
        user = _user(session)
        meal = _logged_meal(session, user.id)
        saved = SavedMeal(user_id=user.id, name="Favorite bowl", total_calories=485, total_protein_g=56, total_carbs_g=45, total_fat_g=6)
        session.add(saved)
        session.flush()
        meal.saved_meal_id = saved.id
        meal.client_meal_key = "meal_1"
        session.add(meal)
        session.commit()

        result = split_meal(
            meal_id=meal.id,
            body=SplitMealBody(keep_fraction=0.25, remaining_meal_type="snack"),
            current_user=user,
            db=session,
        )

        kept = session.get(Meal, result["kept"]["id"])
        remainder = session.get(Meal, result["remainder"]["id"])
        assert kept is not None and kept.saved_meal_id is None
        assert remainder is not None and remainder.saved_meal_id is None
        assert remainder.client_meal_key is None
        kept_items = session.exec(select(MealItem).where(MealItem.meal_id == result["kept"]["id"])).all()
        remainder_items = session.exec(select(MealItem).where(MealItem.meal_id == result["remainder"]["id"])).all()
        kept_chicken = next(i for i in kept_items if i.food_name == "chicken breast")
        remainder_chicken = next(i for i in remainder_items if i.food_name == "chicken breast")
        assert kept_chicken.quantity == 1.5
        assert kept_chicken.calories == 70
        assert kept_chicken.potassium_mg == 105
        assert remainder_chicken.quantity == 4.5
        assert remainder_chicken.calories == 210
        assert remainder_chicken.potassium_mg == 315
    _ok("split scales macros and micronutrients on both rows")


if __name__ == "__main__":
    test_copy_meal_can_scale_and_move_date()
    test_split_meal_scales_original_and_creates_remainder()
