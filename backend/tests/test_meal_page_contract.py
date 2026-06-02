"""Canonical meal-page contract tests."""
from __future__ import annotations

from datetime import date


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine
    import app.models  # noqa: F401

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, username: str = "mealpage") -> int:
    from app.models import User

    user = User(
        email=f"{username}@example.com",
        username=username,
        hashed_password="x",
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return int(user.id)


def _seed_meal(session, user_id: int, *, name: str = "Chicken bowl") -> int:
    from app.enums import MealSource, MealType
    from app.models import Meal, MealItem

    meal = Meal(
        user_id=user_id,
        meal_date=date(2026, 5, 25),
        meal_type=MealType.LUNCH,
        name=name,
        source=MealSource.LOGGED,
    )
    session.add(meal)
    session.flush()
    session.add(MealItem(
        meal_id=meal.id,
        food_name="chicken",
        quantity=6,
        unit="oz",
        serving_grams=170,
        calories=280,
        protein_g=52,
        carbs_g=0,
        fat_g=6,
    ))
    session.commit()
    session.refresh(meal)
    return int(meal.id)


def _make_test_app(engine, user_id_holder: dict):
    from fastapi import FastAPI
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.meals import router as meals_router
    from app.routers.saved_meals import router as saved_meals_router

    app_db.engine = engine

    def _session_override():
        with Session(engine) as session:
            yield session

    def _user_override():
        with Session(engine) as session:
            user = session.get(User, user_id_holder["id"])
            if user is not None:
                _ = (user.id, user.email, user.username, user.hashed_password, user.subscription_tier)
                session.expunge(user)
            return user

    app = FastAPI()
    app.include_router(meals_router)
    app.include_router(saved_meals_router)
    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_user] = _user_override
    return app


def _client(engine, holder):
    from fastapi.testclient import TestClient

    return TestClient(_make_test_app(engine, holder))


def test_get_meal_page_has_no_side_effects() -> None:
    from sqlmodel import Session, select
    from app.models import SavedMeal

    engine = _make_mem_engine()
    with Session(engine) as session:
        user_id = _insert_user(session)
        meal_id = _seed_meal(session, user_id)

    client = _client(engine, {"id": user_id})
    first = client.get(f"/meals/{meal_id}/page")
    second = client.get(f"/meals/{meal_id}/page")
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["meal"]["id"] == meal_id
    assert first.json()["viewer"]["is_favorite"] is False
    with Session(engine) as session:
        count = len(session.exec(select(SavedMeal)).all())
    assert count == 0
    _ok("GET /meals/{id}/page is canonical and read-only")


def test_favorite_put_is_idempotent_and_returns_page() -> None:
    from sqlmodel import Session, select
    from app.models import Meal, SavedMeal

    engine = _make_mem_engine()
    with Session(engine) as session:
        user_id = _insert_user(session, username="favorite")
        meal_id = _seed_meal(session, user_id)

    client = _client(engine, {"id": user_id})
    first = client.put(f"/meals/{meal_id}/favorite")
    second = client.put(f"/meals/{meal_id}/favorite")
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["viewer"]["is_favorite"] is True
    with Session(engine) as session:
        rows = session.exec(select(SavedMeal).where(SavedMeal.source_meal_id == meal_id)).all()
        meal = session.get(Meal, meal_id)
    assert len(rows) == 1
    assert meal.saved_meal_id == rows[0].id
    _ok("favorite PUT collapses repeat calls to one saved meal")


def test_saved_meal_log_reuses_same_idempotency_key() -> None:
    from sqlmodel import Session, select
    from app.models import Meal

    engine = _make_mem_engine()
    with Session(engine) as session:
        user_id = _insert_user(session, username="logidem")

    client = _client(engine, {"id": user_id})
    saved = client.post("/meals/saved", json={
        "name": "Yogurt bowl",
        "items": [{
            "food_name": "yogurt",
            "quantity": 1,
            "unit": "bowl",
            "serving_grams": 225,
            "calories": 220,
            "protein_g": 24,
            "carbs_g": 18,
            "fat_g": 4,
        }],
    })
    assert saved.status_code == 201, saved.text
    saved_id = saved.json()["id"]
    body = {
        "meal_date": "2026-05-25",
        "meal_type": "snack",
        "idempotency_key": "test-fav-log-1",
    }
    first = client.post(f"/meals/saved/{saved_id}/log", json=body)
    second = client.post(f"/meals/saved/{saved_id}/log", json=body)
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["meal_id"] == second.json()["meal_id"]
    with Session(engine) as session:
        rows = session.exec(select(Meal).where(Meal.idempotency_key == "test-fav-log-1")).all()
    assert len(rows) == 1
    _ok("saved-meal log idempotency key returns the original log")


def test_meal_edit_rejects_stale_version_and_returns_canonical_page() -> None:
    from sqlmodel import Session
    from app.models import Meal

    engine = _make_mem_engine()
    with Session(engine) as session:
        user_id = _insert_user(session, username="versioned")
        meal_id = _seed_meal(session, user_id)
        meal = session.get(Meal, meal_id)
        version = meal.version

    client = _client(engine, {"id": user_id})
    stale = client.patch(f"/meals/{meal_id}", json={"name": "Stale", "version": version + 1})
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "stale_meal_version"

    fresh = client.patch(f"/meals/{meal_id}", json={
        "name": "Chicken bowl plus rice",
        "version": version,
        "items": [{
            "food_name": "chicken",
            "quantity": 6,
            "unit": "oz",
            "serving_grams": 170,
            "calories": 280,
            "protein_g": 52,
            "carbs_g": 0,
            "fat_g": 6,
        }, {
            "food_name": "rice",
            "quantity": 1,
            "unit": "cup",
            "serving_grams": 185,
            "calories": 205,
            "protein_g": 4,
            "carbs_g": 45,
            "fat_g": 0,
        }],
    })
    assert fresh.status_code == 200, fresh.text
    payload = fresh.json()
    assert payload["meal"]["name"] == "Chicken bowl plus rice"
    assert payload["meal"]["version"] == version + 1
    assert payload["meal"]["totals"]["calories"] == 485
    assert len(payload["meal"]["items"]) == 2
    _ok("meal edit uses version check and returns canonical page")


def test_meal_edit_refreshes_day_state_snapshot() -> None:
    from sqlmodel import Session, select
    from app.models import Meal, UserDayState

    engine = _make_mem_engine()
    with Session(engine) as session:
        user_id = _insert_user(session, username="daystate")
        meal_id = _seed_meal(session, user_id, name="Chicken bowl")
        meal = session.get(Meal, meal_id)
        meal.client_meal_key = "lunch_slot"
        version = meal.version
        session.add(meal)
        session.add(UserDayState(
            user_id=user_id,
            day_key=date(2026, 5, 25),
            meal_checks={"lunch_slot": True},
            nutrition_plan={
                "targets": {"calories": 2200, "protein": 160, "carbs": 240, "fat": 70},
                "removedMealIds": [],
                "meals": [{
                    "meal": "Chicken bowl",
                    "name": "Chicken bowl",
                    "foods": ["chicken"],
                    "items": [{
                        "name": "chicken",
                        "quantity": 6,
                        "unit": "oz",
                        "calories": 280,
                        "protein": 52,
                        "carbs": 0,
                        "fat": 6,
                    }],
                    "calories": 280,
                    "protein": 52,
                    "carbs": 0,
                    "fat": 6,
                    "_loggedMealId": meal_id,
                    "_clientMealKey": "lunch_slot",
                }],
            },
        ))
        session.commit()

    client = _client(engine, {"id": user_id})
    renamed = client.patch(f"/meals/{meal_id}", json={
        "name": "Chicken bowl plus rice",
        "version": version,
        "items": [{
            "food_name": "chicken",
            "quantity": 6,
            "unit": "oz",
            "serving_grams": 170,
            "calories": 280,
            "protein_g": 52,
            "carbs_g": 0,
            "fat_g": 6,
        }, {
            "food_name": "rice",
            "quantity": 1,
            "unit": "cup",
            "serving_grams": 185,
            "calories": 205,
            "protein_g": 4,
            "carbs_g": 45,
            "fat_g": 0,
        }],
    })
    assert renamed.status_code == 200, renamed.text
    with Session(engine) as session:
        state = session.exec(
            select(UserDayState).where(UserDayState.user_id == user_id)
        ).first()
    meals = state.nutrition_plan["meals"]
    assert len(meals) == 1
    assert meals[0]["meal"] == "Chicken bowl plus rice"
    assert meals[0]["_loggedMealId"] == meal_id
    assert meals[0]["_clientMealKey"] == "lunch_slot"
    assert meals[0]["calories"] == 485
    assert len(meals[0]["items"]) == 2
    assert state.meal_checks == {"lunch_slot": True}
    _ok("meal edit refreshes UserDayState nutrition snapshot in place")


cases = [
    test_get_meal_page_has_no_side_effects,
    test_favorite_put_is_idempotent_and_returns_page,
    test_saved_meal_log_reuses_same_idempotency_key,
    test_meal_edit_rejects_stale_version_and_returns_canonical_page,
    test_meal_edit_refreshes_day_state_snapshot,
]


if __name__ == "__main__":
    for case in cases:
        case()
