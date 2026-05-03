"""Food search/catalog integration tests.

The product contract is search-first logging: local/recent foods rank ahead
of remote USDA hits, AI stays explicit/fallback, and selected foods remain
the user's planning pantry rather than the only searchable catalog.
"""
from __future__ import annotations

from datetime import date

from sqlmodel import Session, select

from tests._seed_helpers import make_seed_test_engine


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _user(session: Session, *, email: str = "food-search@example.com", pro: bool = False):
    from app.models import User

    u = User(
        email=email,
        username=email.split("@", 1)[0],
        hashed_password="x",
        subscription_tier="pro" if pro else "free",
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _food(session: Session, *, name: str, source, owner_user_id: int | None = None):
    from app.enums import FoodCategory
    from app.models import Food, FoodNutrition, FoodServing
    from app.food_service import normalize_food_name

    food = Food(
        name=name,
        normalized_name=normalize_food_name(name),
        category=FoodCategory.PROTEINS,
        source=source,
        owner_user_id=owner_user_id,
        is_verified=True,
        unit="100 g",
        serving_grams=100,
        calories=165,
        protein=31,
        carbs=0,
        fat=4,
    )
    session.add(food)
    session.flush()
    session.add(FoodNutrition(
        food_id=food.id,
        reference_unit="100 g",
        reference_grams=100,
        calories=165,
        protein=31,
        carbs=0,
        fat=4,
        fiber=0,
    ))
    session.add(FoodServing(
        food_id=food.id,
        label="100 g",
        grams=100,
        is_default=True,
        calories=165,
        protein=31,
        carbs=0,
        fat=4,
    ))
    session.commit()
    session.refresh(food)
    return food


def test_food_search_merges_local_before_usda_and_marks_preferred() -> None:
    print("\n[test] food search: local/preferred before USDA")
    from app.enums import FoodSource
    from app.models import UserPreferences
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    original_usda = food_router._search_usda
    food_router._search_usda = lambda query, max_results: [
        {
            "name": "Chicken Breast",
            "serving": "100 g",
            "calories": 120,
            "protein": 25,
            "carbs": 0,
            "fat": 2,
            "source": "usda",
        },
        {
            "name": "Turkey Breast",
            "serving": "100 g",
            "calories": 135,
            "protein": 29,
            "carbs": 0,
            "fat": 2,
            "source": "usda",
        },
    ]
    try:
        with Session(engine) as session:
            u = _user(session)
            _food(session, name="Chicken Breast", source=FoodSource.SEED)
            session.add(UserPreferences(user_id=u.id, foods_available=["chicken breast"]))
            session.commit()

            response = food_router.search_food_catalog(
                q="chicken",
                limit=10,
                include_remote=True,
                force_ai=False,
                current_user=u,
                db=session,
            )

            results = response["results"]
            assert [r["name"] for r in results] == ["Chicken Breast", "Turkey Breast"], results
            assert results[0]["source"] == "seed", results[0]
            assert results[0]["food_id"] is not None, results[0]
            assert results[0]["is_preferred"] is True, results[0]
            assert results[1]["source"] == "usda", results[1]
    finally:
        food_router._search_usda = original_usda
    _ok("local preferred foods win de-dupes and USDA fills gaps")


def test_food_search_force_ai_returns_ai_only() -> None:
    print("\n[test] food search: force AI returns only AI")
    from app.enums import FoodSource
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    original_ai = food_router._search_ai
    food_router._search_ai = lambda query: [{
        "name": "Homemade Pizza Slice",
        "serving": "1 slice",
        "calories": 285,
        "protein": 12,
        "carbs": 34,
        "fat": 11,
        "source": "ai",
    }]
    try:
        with Session(engine) as session:
            u = _user(session, email="food-ai@example.com", pro=True)
            _food(session, name="Pizza", source=FoodSource.SEED)

            response = food_router.search_food_catalog(
                q="pizza",
                limit=10,
                include_remote=True,
                force_ai=True,
                current_user=u,
                db=session,
            )

            results = response["results"]
            assert len(results) == 1, results
            assert results[0]["source"] == "ai", results
            assert results[0]["name"] == "Homemade Pizza Slice", results
            assert response["sources"] == {"local": 0, "usda": 0, "ai": 1}, response
    finally:
        food_router._search_ai = original_ai
    _ok("force_ai does not mix local/USDA rows into append results")


def test_preferred_food_upsert_normalizes_names() -> None:
    print("\n[test] food search: preferred food upsert")
    from app.routers.foods import PreferredFoodRequest, add_preferred_food

    engine = make_seed_test_engine()
    with Session(engine) as session:
        u = _user(session, email="preferred-food@example.com")
        first = add_preferred_food(PreferredFoodRequest(name="Greek Yogurt"), current_user=u, db=session)
        second = add_preferred_food(PreferredFoodRequest(name="greek yogurt"), current_user=u, db=session)

        assert first["foods_available"] == ["Greek Yogurt"], first
        assert second["foods_available"] == ["Greek Yogurt"], second
    _ok("preferred foods de-dupe by normalized name")


def test_logged_search_food_id_is_preserved_and_marked_recent() -> None:
    print("\n[test] food search: logged food_id preserved + recent")
    from app.enums import FoodSource
    from app.models import MealItem, UserRecentFood
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = make_seed_test_engine()
    with Session(engine) as session:
        u = _user(session, email="recent-food@example.com")
        food = _food(session, name="Salmon", source=FoodSource.USDA)

        log_meal_from_plan(
            u.id,
            date(2026, 5, 2),
            "meal_0",
            {
                "meal": "Lunch",
                "items": [{
                    "name": "Wild salmon filet",
                    "food_id": food.id,
                    "quantity": 1,
                    "unit": "serving",
                    "serving_grams": 140,
                    "calories": 240,
                    "protein": 34,
                    "carbs": 0,
                    "fat": 11,
                }],
            },
            source="manual_add",
            db=session,
        )

        item = session.exec(select(MealItem)).first()
        recent = session.exec(
            select(UserRecentFood).where(
                UserRecentFood.user_id == u.id,
                UserRecentFood.food_id == food.id,
            )
        ).first()
        assert item is not None and item.food_id == food.id, item
        assert recent is not None and recent.times_used == 1, recent
    _ok("search-selected food IDs survive meal logging and become recent")


cases = [
    test_food_search_merges_local_before_usda_and_marks_preferred,
    test_food_search_force_ai_returns_ai_only,
    test_preferred_food_upsert_normalizes_names,
    test_logged_search_food_id_is_preserved_and_marked_recent,
]


if __name__ == "__main__":
    for case in cases:
        case()
