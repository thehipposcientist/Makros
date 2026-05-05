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


def test_food_search_prefers_kitchen_local_and_skips_usda() -> None:
    print("\n[test] food search: kitchen local before USDA")
    from app.enums import FoodSource
    from app.models import UserPreferences
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    original_usda = food_router._search_usda
    calls: list[str] = []
    def fake_usda(query: str, max_results: int) -> list[dict]:
        calls.append(query)
        return [{
            "name": "Turkey Breast",
            "serving": "100 g",
            "calories": 135,
            "protein": 29,
            "carbs": 0,
            "fat": 2,
            "source": "usda",
        }]
    food_router._search_usda = fake_usda
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
            assert calls == [], f"USDA should not fill when kitchen has a match: {calls}"
            assert response["sources"]["usda"] == 0, response
            assert [r["name"] for r in results] == ["Chicken Breast"], results
            assert results[0]["source"] == "seed", results[0]
            assert results[0]["food_id"] is not None, results[0]
            assert results[0]["is_preferred"] is True, results[0]
    finally:
        food_router._search_usda = original_usda
    _ok("kitchen-local foods win and skip remote USDA")


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


def test_selected_usda_result_imports_verified_catalog_food() -> None:
    print("\n[test] food search: selected USDA result imports catalog food")
    from app.enums import FoodSource
    from app.models import Food, MealItem, UserRecentFood
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = make_seed_test_engine()
    with Session(engine) as session:
        u = _user(session, email="usda-import@example.com")

        log_meal_from_plan(
            u.id,
            date(2026, 5, 2),
            "meal_0",
            {
                "meal": "Breakfast",
                "items": [{
                    "name": "Greek Yogurt Plain Nonfat",
                    "source": "usda",
                    "fdc_id": "170885",
                    "external_id": "170885",
                    "serving": "170 g",
                    "serving_grams": 170,
                    "quantity": 1,
                    "unit": "serving",
                    "calories": 100,
                    "protein": 17,
                    "carbs": 6,
                    "fat": 0,
                    "micronutrients": {"calcium": 187, "sodium": 61, "sugar": 6},
                }],
            },
            source="manual_add",
            db=session,
        )

        food = session.exec(select(Food).where(Food.external_id == "170885")).first()
        assert food is not None, "USDA food was not imported"
        item = session.exec(select(MealItem)).first()
        recent = session.exec(
            select(UserRecentFood).where(
                UserRecentFood.user_id == u.id,
                UserRecentFood.food_id == food.id,
            )
        ).first()
        assert food.source == FoodSource.USDA, food
        assert food.owner_user_id is None, food
        assert food.is_verified is True, food
        assert item is not None and item.food_id == food.id, item
        assert recent is not None, recent
    _ok("selected USDA rows become verified global foods and user recents")


def test_selected_ai_result_imports_private_user_food() -> None:
    print("\n[test] food search: selected AI result imports private user food")
    from app.enums import FoodSource
    from app.models import Food, MealItem, UserRecentFood
    from app.routers import foods as food_router
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = make_seed_test_engine()
    with Session(engine) as session:
        owner = _user(session, email="ai-import-owner@example.com")
        other = _user(session, email="ai-import-other@example.com")

        log_meal_from_plan(
            owner.id,
            date(2026, 5, 2),
            "meal_0",
            {
                "meal": "Snack",
                "items": [{
                    "name": "Sawyer's Protein Pudding",
                    "source": "ai",
                    "serving": "1 bowl",
                    "quantity": 1,
                    "unit": "bowl",
                    "calories": 260,
                    "protein": 34,
                    "carbs": 22,
                    "fat": 5,
                    "micronutrients": {"fiber": 3, "sodium": 220},
                }],
            },
            source="manual_add",
            db=session,
        )

        food = session.exec(select(Food).where(Food.name == "Sawyer's Protein Pudding")).first()
        assert food is not None, "AI food was not imported"
        item = session.exec(select(MealItem)).first()
        recent = session.exec(
            select(UserRecentFood).where(
                UserRecentFood.user_id == owner.id,
                UserRecentFood.food_id == food.id,
            )
        ).first()
        assert food.source == FoodSource.AI, food
        assert food.owner_user_id == owner.id, food
        assert food.is_verified is False, food
        assert food.is_custom is True, food
        assert item is not None and item.food_id == food.id, item
        assert recent is not None, recent

        owner_response = food_router.search_food_catalog(
            q="protein pudding",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=owner,
            db=session,
        )
        other_response = food_router.search_food_catalog(
            q="protein pudding",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=other,
            db=session,
        )
        assert [r["name"] for r in owner_response["results"]] == ["Sawyer's Protein Pudding"], owner_response
        assert other_response["results"] == [], other_response
    _ok("selected AI rows become private user foods and recents")


def test_kitchen_custom_food_searches_thallo_without_remote() -> None:
    print("\n[test] food search: kitchen custom food returns local Thallo result")
    from app.models import UserPreferences, UserState
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    old_usda = food_router._search_usda
    calls: list[str] = []

    def fake_usda(query: str, max_results: int) -> list[dict]:
        calls.append(query)
        return [{
            "name": "Remote Protein Pudding",
            "serving": "100 g",
            "calories": 99,
            "protein": 9,
            "carbs": 9,
            "fat": 1,
            "source": "usda",
        }]

    food_router._search_usda = fake_usda
    try:
        with Session(engine) as session:
            u = _user(session, email="kitchen-custom@example.com")
            session.add(UserPreferences(
                user_id=u.id,
                foods_available=["Sawyer's Protein Pudding"],
            ))
            session.add(UserState(
                user_id=u.id,
                state_json={
                    "userProfile": {
                        "customFoods": [{
                            "name": "Sawyer's Protein Pudding",
                            "unit": "1 bowl",
                            "calories": 260,
                            "protein": 34,
                            "carbs": 22,
                            "fat": 5,
                            "micronutrients": {"fiber": 3},
                            "verificationStatus": "ai_estimated",
                        }],
                    },
                },
            ))
            session.commit()

            response = food_router.search_food_catalog(
                q="protein pudding",
                limit=10,
                include_remote=True,
                force_ai=False,
                current_user=u,
                db=session,
            )
            assert calls == [], f"USDA should not be called for a kitchen hit: {calls}"
            assert response["sources"]["usda"] == 0, response
            assert len(response["results"]) == 1, response
            result = response["results"][0]
            assert result["name"] == "Sawyer's Protein Pudding", result
            assert result["source"] == "user", result
            assert result["is_preferred"] is True, result
            assert result["calories"] == 260, result
    finally:
        food_router._search_usda = old_usda
    _ok("kitchen custom foods search locally and skip remote USDA")


def test_food_search_does_not_leak_other_users_private_foods() -> None:
    print("\n[test] food search: private food rows are user-scoped")
    from app.enums import FoodSource
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    with Session(engine) as session:
        owner = _user(session, email="private-owner@example.com")
        other = _user(session, email="private-other@example.com")
        _food(session, name="Secret Protein Pancake", source=FoodSource.AI, owner_user_id=owner.id)

        owner_response = food_router.search_food_catalog(
            q="secret",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=owner,
            db=session,
        )
        other_response = food_router.search_food_catalog(
            q="secret",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=other,
            db=session,
        )

        assert [r["name"] for r in owner_response["results"]] == ["Secret Protein Pancake"], owner_response
        assert other_response["results"] == [], other_response
    _ok("user-owned foods only appear for their owner")


def test_food_search_supports_out_of_order_tokens() -> None:
    print("\n[test] food search: out-of-order token matching")
    from app.enums import FoodSource
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    with Session(engine) as session:
        u = _user(session, email="food-token-search@example.com")
        _food(session, name="Greek Yogurt Plain Nonfat", source=FoodSource.SEED)

        response = food_router.search_food_catalog(
            q="greek nonfat",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=u,
            db=session,
        )

        assert [r["name"] for r in response["results"]] == ["Greek Yogurt Plain Nonfat"], response
    _ok("multi-token searches match foods even when tokens are not contiguous")


def test_short_food_queries_do_not_hit_remote_or_ai() -> None:
    print("\n[test] food search: short queries stay local-only")
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    original_usda = food_router._search_usda
    original_ai = food_router._search_ai
    calls: list[str] = []

    def fake_remote(query: str, *args, **kwargs) -> list[dict]:
        calls.append(query)
        return []

    food_router._search_usda = fake_remote
    food_router._search_ai = fake_remote
    try:
        with Session(engine) as session:
            u = _user(session, email="short-food-search@example.com")

            response = food_router.search_food_catalog(
                q="zz",
                limit=10,
                include_remote=True,
                force_ai=False,
                current_user=u,
                db=session,
            )

            assert response["results"] == [], response
            assert calls == [], f"short query should not call USDA or AI: {calls}"
            assert response["sources"] == {"local": 0, "usda": 0, "ai": 0}, response
    finally:
        food_router._search_usda = original_usda
        food_router._search_ai = original_ai
    _ok("1-2 character searches avoid remote latency and AI gating")


def test_food_search_can_disable_ai_fallback_for_signup() -> None:
    print("\n[test] food search: signup can use USDA without AI fallback")
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    original_usda = food_router._search_usda
    original_ai = food_router._search_ai
    calls: list[tuple[str, str]] = []

    def fake_usda(query: str, *args, **kwargs) -> list[dict]:
        calls.append(("usda", query))
        return []

    def fake_ai(query: str) -> list[dict]:
        calls.append(("ai", query))
        return [{
            "name": "AI Only Food",
            "serving": "1 serving",
            "calories": 100,
            "protein": 5,
            "carbs": 10,
            "fat": 3,
            "source": "ai",
        }]

    food_router._search_usda = fake_usda
    food_router._search_ai = fake_ai
    try:
        with Session(engine) as session:
            u = _user(session, email="signup-food-search@example.com")

            response = food_router.search_food_catalog(
                q="obscure signup food",
                limit=10,
                include_remote=True,
                force_ai=False,
                allow_ai=False,
                current_user=u,
                db=session,
            )

            assert response["results"] == [], response
            assert calls == [("usda", "obscure signup food")], calls
            assert response["sources"] == {"local": 0, "usda": 0, "ai": 0}, response
    finally:
        food_router._search_usda = original_usda
        food_router._search_ai = original_ai
    _ok("allow_ai=false returns local/USDA results only")


def test_usda_fatty_acid_mapping_uses_real_nutrients() -> None:
    print("\n[test] food search: USDA fatty acid mapping")
    from app.services.usda_fdc import _extract_nutrients

    nutrients = _extract_nutrients({
        "foodNutrients": [
            {"nutrientId": 1292, "value": 7.3},
            {"nutrientId": 1293, "value": 1.8},
            {"nutrientId": 851, "value": 0.4},
            {"nutrientId": 629, "value": 0.2},
            {"nutrient": {"id": 621}, "amount": 0.3},
        ],
    })

    assert nutrients["monounsaturated_fat"] == 7.3, nutrients
    assert nutrients["polyunsaturated_fat"] == 1.8, nutrients
    assert nutrients["omega_3"] == 0.9, nutrients
    assert "omega_3_mg" not in nutrients, nutrients
    _ok("USDA 1292 is mono fat, not omega-3, and omega-3 components sum in grams")


cases = [
    test_food_search_prefers_kitchen_local_and_skips_usda,
    test_food_search_force_ai_returns_ai_only,
    test_preferred_food_upsert_normalizes_names,
    test_logged_search_food_id_is_preserved_and_marked_recent,
    test_selected_usda_result_imports_verified_catalog_food,
    test_selected_ai_result_imports_private_user_food,
    test_kitchen_custom_food_searches_thallo_without_remote,
    test_food_search_does_not_leak_other_users_private_foods,
    test_food_search_supports_out_of_order_tokens,
    test_short_food_queries_do_not_hit_remote_or_ai,
    test_food_search_can_disable_ai_fallback_for_signup,
    test_usda_fatty_acid_mapping_uses_real_nutrients,
]


if __name__ == "__main__":
    for case in cases:
        case()
