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
    food_router._search_ai = lambda query, db, **kwargs: [{
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


def test_selected_sweetened_usda_result_infers_added_sugar_when_1235_missing() -> None:
    print("\n[test] food search: sweetened USDA result infers missing added sugar")
    from app.models import FoodNutrition, MealItem
    from app.services.nutrition.gut_health import compute_daily_metrics
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = make_seed_test_engine()
    with Session(engine) as session:
        u = _user(session, email="usda-added-sugar@example.com")
        meal_date = date(2026, 5, 2)

        log_meal_from_plan(
            u.id,
            meal_date,
            "meal_0",
            {
                "meal": "Snack",
                "items": [{
                    "name": "Chocolate Milkshake",
                    "source": "usda",
                    "fdc_id": "milkshake-123",
                    "external_id": "milkshake-123",
                    "serving": "350 g",
                    "serving_grams": 350,
                    "quantity": 1,
                    "unit": "serving",
                    "calories": 520,
                    "protein": 12,
                    "carbs": 82,
                    "fat": 16,
                    "micronutrients": {"sugar": 70, "sodium": 280},
                }],
            },
            source="manual_add",
            db=session,
        )

        item = session.exec(select(MealItem)).first()
        assert item is not None, "MealItem inserted"
        assert item.sugar_g == 70, item
        assert item.added_sugar_g is not None and 50 <= item.added_sugar_g <= 55, item
        nutrition = session.exec(select(FoodNutrition).where(FoodNutrition.food_id == item.food_id)).first()
        assert nutrition is not None
        assert nutrition.added_sugar_g == item.added_sugar_g

        metrics = compute_daily_metrics(session, user_id=u.id, metric_date=meal_date, allow_ai=False)
        assert metrics.added_sugar_g == item.added_sugar_g, metrics.model_dump()
    _ok("milkshake-style rows no longer show added sugar as zero")


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


def test_selected_barcode_result_imports_private_user_food() -> None:
    print("\n[test] food search: selected barcode result imports private user food")
    from app.enums import FoodSource
    from app.models import Food, MealItem, UserRecentFood
    from app.routers import foods as food_router
    from app.services.nutrition.gut_health import compute_daily_metrics
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = make_seed_test_engine()
    with Session(engine) as session:
        owner = _user(session, email="barcode-import-owner@example.com")
        other = _user(session, email="barcode-import-other@example.com")

        log_meal_from_plan(
            owner.id,
            date(2026, 5, 2),
            "meal_0",
            {
                "meal": "Snack",
                "items": [{
                    "name": "Acme Protein Bar",
                    "source": "barcode",
                    "barcode": "012345678905",
                    "brand": "Acme",
                    "serving": "1 bar",
                    "serving_grams": 60,
                    "quantity": 1,
                    "unit": "bar",
                    "calories": 220,
                    "protein": 20,
                    "carbs": 23,
                    "fat": 7,
                    "fiber": 5,
                    "sugar": 3,
                    "sodium_mg": 180,
                }],
            },
            source="manual_add",
            db=session,
        )

        food = session.exec(select(Food).where(Food.barcode == "012345678905")).first()
        assert food is not None, "barcode food was not imported"
        item = session.exec(select(MealItem)).first()
        recent = session.exec(
            select(UserRecentFood).where(
                UserRecentFood.user_id == owner.id,
                UserRecentFood.food_id == food.id,
            )
        ).first()
        assert food.source == FoodSource.BARCODE, food
        assert food.owner_user_id == owner.id, food
        assert food.is_verified is False, food
        assert item is not None and item.food_id == food.id, item
        assert recent is not None, recent
        metrics = compute_daily_metrics(session, user_id=owner.id, metric_date=date(2026, 5, 2), allow_ai=False)
        processed_count = (
            (metrics.processing_counts or {}).get("processed", 0)
            + (metrics.processing_counts or {}).get("ultra_processed", 0)
        )
        assert processed_count == 1, metrics.processing_counts

        owner_response = food_router.search_food_catalog(
            q="protein bar",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=owner,
            db=session,
        )
        other_response = food_router.search_food_catalog(
            q="protein bar",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=other,
            db=session,
        )
        assert [r["name"] for r in owner_response["results"]] == ["Acme Protein Bar"], owner_response
        assert owner_response["results"][0]["source"] == "barcode", owner_response
        assert owner_response["results"][0]["processing_bucket"] in {"processed", "ultra_processed"}, owner_response
        assert owner_response["results"][0]["food_quality"] == "processed", owner_response
        assert other_response["results"] == [], other_response
    _ok("barcode fallback rows become private user foods and recents")


def test_food_metadata_unknown_cache_upgrades_when_ai_allowed() -> None:
    print("\n[test] food metadata: unknown cache upgrades when AI is allowed")
    from app.models import FoodMetadata
    from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, FoodClassification, normalize_name
    import app.services.nutrition.ai_classify as ai_mod

    engine = make_seed_test_engine()
    original_ai = ai_mod.ai_classify_food
    original_amounts = ai_mod.estimate_amounts

    def fake_ai(raw_name: str, *, db=None, context=None):
        normalized = normalize_name(raw_name)
        return FoodClassification(
            normalized_name=normalized,
            display_name=raw_name,
            likely_plant_foods=[],
            plant_count_value=0,
            fermented_flag=False,
            omega3_flag=False,
            processing_bucket="ultra_processed",
            confidence=0.82,
            source="ai",
            notes="packaged snack product",
        )

    ai_mod.ai_classify_food = fake_ai
    ai_mod.estimate_amounts = lambda raw_name: {
        "collagen_g_per_serving": 0,
        "probiotic_cfu_billions_per_serving": 0,
        "prebiotic_g_per_serving": 0,
        "amount_confidence": "none",
    }
    try:
        with Session(engine) as session:
            session.add(FoodMetadata(
                normalized_name=normalize_name("Acme Mystery Crunch"),
                display_name="Acme Mystery Crunch",
                classifier_version=CLASSIFIER_VERSION,
                processing_bucket="unknown",
                confidence=0,
                source="unknown",
            ))
            session.commit()

            row = ai_mod.get_or_create_metadata(
                "Acme Mystery Crunch",
                db=session,
                allow_ai=True,
                require_processing_bucket=True,
            )

            assert row.source == "ai", row
            assert row.processing_bucket == "ultra_processed", row
            assert row.confidence >= 0.82, row
    finally:
        ai_mod.ai_classify_food = original_ai
        ai_mod.estimate_amounts = original_amounts
    _ok("current-version unknown metadata is no longer sticky")


def test_barcode_enrichment_defaults_processing_bucket_when_ai_unavailable() -> None:
    print("\n[test] food metadata: barcode enrichment avoids unknown bucket")
    from app.food_service import enrich_search_item_classification
    from app.models import FoodMetadata
    from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, normalize_name
    import app.services.nutrition.ai_classify as ai_mod

    engine = make_seed_test_engine()
    original_ai = ai_mod.ai_classify_food
    original_amounts = ai_mod.estimate_amounts
    ai_mod.ai_classify_food = lambda raw_name, *, db=None, context=None: None
    ai_mod.estimate_amounts = lambda raw_name: None
    try:
        with Session(engine) as session:
            item = {
                "name": "Acme Mystery Crunch",
                "source": "barcode",
                "barcode": "012345678905",
                "serving": "1 pouch",
                "calories": 180,
                "protein": 3,
                "carbs": 25,
                "fat": 8,
            }
            enriched = enrich_search_item_classification(
                session,
                item,
                allow_ai=True,
                require_processing_bucket=True,
                default_processing_bucket="processed",
            )
            row = session.exec(
                select(FoodMetadata)
                .where(FoodMetadata.normalized_name == normalize_name("Acme Mystery Crunch"))
                .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
            ).first()

            assert enriched["processing_bucket"] == "processed", enriched
            assert enriched["food_quality"] == "processed", enriched
            assert row is not None, "metadata row should be persisted"
            assert row.processing_bucket == "processed", row
            assert row.source == "defaulted", row
    finally:
        ai_mod.ai_classify_food = original_ai
        ai_mod.estimate_amounts = original_amounts
    _ok("barcode lookup has a trusted fallback instead of unknown")


def test_existing_ai_metadata_does_not_reenrich_on_live_lookup() -> None:
    print("\n[test] food metadata: live lookup does not re-enrich existing AI row")
    from app.models import FoodMetadata
    from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, normalize_name
    import app.services.nutrition.ai_classify as ai_mod

    engine = make_seed_test_engine()
    original_ai = ai_mod.ai_classify_food
    original_amounts = ai_mod.estimate_amounts
    original_tags = ai_mod.estimate_insight_tags
    calls: list[str] = []

    def fail_ai(*args, **kwargs):
        calls.append("classify")
        raise AssertionError("existing AI row should not be classified again")

    def fail_amounts(*args, **kwargs):
        calls.append("amounts")
        raise AssertionError("existing AI row should not be amount-enriched from live lookup")

    def fail_tags(*args, **kwargs):
        calls.append("tags")
        raise AssertionError("existing AI row should not be tag-enriched from live lookup")

    ai_mod.ai_classify_food = fail_ai
    ai_mod.estimate_amounts = fail_amounts
    ai_mod.estimate_insight_tags = fail_tags
    try:
        with Session(engine) as session:
            session.add(FoodMetadata(
                normalized_name=normalize_name("Cooked Lentils"),
                display_name="Cooked Lentils",
                classifier_version=CLASSIFIER_VERSION,
                processing_bucket="minimally_processed",
                confidence=0.92,
                source="ai",
                protein_source="plant",
                notes="cached AI grade",
            ))
            session.commit()

            row = ai_mod.get_or_create_metadata("Cooked Lentils", db=session, allow_ai=True)

            assert row.source == "ai", row
            assert row.processing_bucket == "minimally_processed", row
            assert calls == [], calls
    finally:
        ai_mod.ai_classify_food = original_ai
        ai_mod.estimate_amounts = original_amounts
        ai_mod.estimate_insight_tags = original_tags
    _ok("existing current metadata stays a cache hit even with allow_ai=True")


def test_food_submission_creates_private_food_and_pending_review() -> None:
    print("\n[test] food submissions: private now, review later")
    from app.enums import FoodSource
    from app.models import Food, FoodSubmission
    from app.routers import foods as food_router
    from app.routers.foods import FoodSubmissionRequest

    engine = make_seed_test_engine()
    with Session(engine) as session:
        owner = _user(session, email="submission-owner@example.com")
        other = _user(session, email="submission-other@example.com")

        response = food_router.submit_food_to_catalog(
            FoodSubmissionRequest(
                name="Sawyer's Overnight Oats",
                brand="Home",
                barcode="998877665544",
                serving="1 jar",
                serving_grams=280,
                calories=410,
                protein=31,
                carbs=52,
                fat=9,
                fiber=8,
                micronutrients={"fiber": 8, "sodium": 210},
                aliases=["protein oats"],
                source_context="label_photo",
            ),
            current_user=owner,
            db=session,
        )

        submission = session.get(FoodSubmission, response["id"])
        food = session.get(Food, response["food_id"])
        assert submission is not None and submission.status == "pending", submission
        assert submission.source_context == "label_photo", submission
        assert food is not None, response
        assert food.source == FoodSource.USER, food
        assert food.owner_user_id == owner.id, food
        assert food.is_verified is False, food

        owner_response = food_router.search_food_catalog(
            q="protein oats",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=owner,
            db=session,
        )
        other_response = food_router.search_food_catalog(
            q="protein oats",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=other,
            db=session,
        )
        assert [r["name"] for r in owner_response["results"]] == ["Sawyer's Overnight Oats"], owner_response
        assert other_response["results"] == [], other_response
    _ok("submitted foods are reusable privately while pending review")


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


def test_food_search_tolerates_small_typo() -> None:
    print("\n[test] food search: typo-tolerant local matching")
    from app.enums import FoodSource
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    with Session(engine) as session:
        u = _user(session, email="food-typo-search@example.com")
        _food(session, name="Greek Yogurt Plain Nonfat", source=FoodSource.SEED)

        response = food_router.search_food_catalog(
            q="greek yogrt",
            limit=10,
            include_remote=False,
            force_ai=False,
            current_user=u,
            db=session,
        )

        assert [r["name"] for r in response["results"]] == ["Greek Yogurt Plain Nonfat"], response
    _ok("small typos still find local catalog rows")


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

    def fake_ai(query: str, **kwargs) -> list[dict]:
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


def test_food_search_uses_fatsecret_before_usda_and_ai() -> None:
    print("\n[test] food search: FatSecret provider fills restaurant results")
    from app.routers import foods as food_router

    engine = make_seed_test_engine()
    original_fatsecret = food_router._search_fatsecret
    original_usda = food_router._search_usda
    original_ai = food_router._search_ai
    calls: list[str] = []

    def fake_fatsecret(query: str, max_results: int, db: Session) -> list[dict]:
        calls.append(f"fatsecret:{query}:{max_results}")
        return [{
            "name": "McDonald's Cheeseburger",
            "serving": "1 serving",
            "calories": 300,
            "protein": 15,
            "carbs": 32,
            "fat": 13,
            "source": "fatsecret",
            "external_id": "fatsecret:41963",
            "brand": "McDonald's",
            "is_verified": True,
        }]

    def fake_usda(query: str, *args, **kwargs) -> list[dict]:
        calls.append(f"usda:{query}")
        return []

    def fake_ai(query: str, *args, **kwargs) -> list[dict]:
        calls.append(f"ai:{query}")
        return []

    food_router._search_fatsecret = fake_fatsecret
    food_router._search_usda = fake_usda
    food_router._search_ai = fake_ai
    try:
        with Session(engine) as session:
            u = _user(session, email="fatsecret-search@example.com")

            response = food_router.search_food_catalog(
                q="mcdonalds cheeseburger",
                limit=1,
                include_remote=True,
                force_ai=False,
                current_user=u,
                db=session,
            )

            assert calls == ["fatsecret:mcdonalds cheeseburger:3"], calls
            assert response["sources"] == {"local": 0, "usda": 0, "ai": 0, "fatsecret": 1}, response
            assert response["results"][0]["source"] == "fatsecret", response
            assert response["results"][0]["brand"] == "McDonald's", response
    finally:
        food_router._search_fatsecret = original_fatsecret
        food_router._search_usda = original_usda
        food_router._search_ai = original_ai
    _ok("FatSecret search results satisfy restaurant queries before USDA/AI")


def test_fatsecret_v1_search_parser_normalizes_restaurant_item() -> None:
    print("\n[test] food search: FatSecret v1 parser")
    from app.services.fatsecret import _parse_search_response

    results = _parse_search_response({
        "foods": {
            "food": {
                "brand_name": "McDonald's",
                "food_description": "Per 1 serving - Calories: 300kcal | Fat: 13.00g | Carbs: 32.00g | Protein: 15.00g",
                "food_id": "41963",
                "food_name": "Cheeseburger",
                "food_type": "Brand",
            }
        }
    }, "v1", 5)

    assert len(results) == 1, results
    item = results[0]
    assert item["name"] == "McDonald's Cheeseburger", item
    assert item["source"] == "fatsecret", item
    assert item["external_id"] == "fatsecret:41963", item
    assert item["serving_id"] is None, item
    assert item["calories"] == 300, item
    assert item["carbs"] == 32, item
    _ok("FatSecret v1 restaurant rows become Thallo search results")


def test_fatsecret_v5_search_parser_keeps_serving_id_external() -> None:
    print("\n[test] food search: FatSecret v5 parser")
    from app.services.fatsecret import _parse_search_response

    results = _parse_search_response({
        "foods_search": {
            "results": {
                "food": [{
                    "food_id": "50953",
                    "food_name": "Whole Grain Cheerios",
                    "brand_name": "General Mills",
                    "food_type": "Brand",
                    "servings": {
                        "serving": [
                            {
                                "serving_id": "0",
                                "serving_description": "100 g",
                                "metric_serving_amount": "100.0",
                                "metric_serving_unit": "g",
                                "calories": "333",
                                "carbohydrate": "66.67",
                                "protein": "10.00",
                                "fat": "6.67",
                            },
                            {
                                "serving_id": "100675",
                                "serving_description": "1 cup",
                                "metric_serving_amount": "30.000",
                                "metric_serving_unit": "g",
                                "is_default": "1",
                                "calories": "100",
                                "carbohydrate": "20.00",
                                "protein": "3.00",
                                "fat": "2.00",
                                "fiber": "3.0",
                                "sodium": "160",
                                "added_sugars": "0",
                            },
                        ],
                    },
                }]
            }
        }
    }, "v5", 5)

    assert len(results) == 1, results
    item = results[0]
    assert item["name"] == "General Mills Whole Grain Cheerios", item
    assert item["serving"] == "1 cup", item
    assert item["serving_grams"] == 30.0, item
    assert item["serving_id"] is None, item
    assert item["fatsecret_serving_id"] == "100675", item
    assert item["micronutrients"]["added_sugar"] == 0, item
    _ok("FatSecret serving ids stay external instead of pretending to be FoodServing ids")


def test_fatsecret_provider_status_probe_is_sanitized() -> None:
    print("\n[test] food search: FatSecret provider status")
    import os
    import app.services.fatsecret as fs

    original_search = fs.search_foods
    original_env = {
        key: os.environ.get(key)
        for key in (
            "FATSECRET_ENABLED",
            "FATSECRET_CLIENT_ID",
            "FATSECRET_CLIENT_SECRET",
            "FATSECRET_SCOPE",
            "FATSECRET_SEARCH_VERSION",
            "FATSECRET_REGION",
        )
    }
    try:
        os.environ["FATSECRET_ENABLED"] = "1"
        os.environ["FATSECRET_CLIENT_ID"] = "client-id"
        os.environ["FATSECRET_CLIENT_SECRET"] = "client-secret"
        os.environ["FATSECRET_SCOPE"] = "basic"
        os.environ["FATSECRET_SEARCH_VERSION"] = "v1"
        os.environ.pop("FATSECRET_REGION", None)
        fs.search_foods = lambda query, max_results=3: [{
            "name": "McDonald's Cheeseburger",
            "source": "fatsecret",
        }]

        status = fs.provider_status("mcdonalds cheeseburger", max_results=3)

        assert status["status"] == "ok", status
        assert status["configured"] is True, status
        assert status["result_count"] == 1, status
        assert status["first_result_source"] == "fatsecret", status
        assert "client-secret" not in repr(status), status
        assert "client-id" not in repr(status), status
    finally:
        fs.search_foods = original_search
        for key, value in original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
    _ok("FatSecret provider status exposes health, not credentials")


def test_openfoodfacts_barcode_keeps_serving_grams() -> None:
    print("\n[test] food search: OpenFoodFacts barcode serving grams")
    import app.services.openfoodfacts as off

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "status": 1,
                "product": {
                    "product_name": "Kirkland Beef Patty",
                    "brands": "Costco",
                    "serving_size": "1 patty",
                    "serving_quantity": "113",
                    "nova_group": "3",
                    "nutriments": {
                        "energy-kcal_100g": "150.4",
                        "proteins_100g": "20",
                        "carbohydrates_100g": "0",
                        "fat_100g": "8",
                        "fiber_100g": "0",
                        "sugars_100g": "0",
                        "sodium_100g": "0.08",
                    },
                },
            }

    original_get = off.httpx.get
    off.httpx.get = lambda *args, **kwargs: FakeResponse()
    try:
        item = off.lookup_barcode("123456789012")
    finally:
        off.httpx.get = original_get

    assert item is not None, item
    assert item["serving"] == "1 patty", item
    assert item["serving_grams"] == 113.0, item
    assert item["calories"] == 170, item
    assert item["source"] == "barcode", item
    assert item["nova_bucket"] == "processed", item
    _ok("OpenFoodFacts serving_quantity flows through as serving_grams")


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
    test_selected_sweetened_usda_result_infers_added_sugar_when_1235_missing,
    test_selected_ai_result_imports_private_user_food,
    test_selected_barcode_result_imports_private_user_food,
    test_food_metadata_unknown_cache_upgrades_when_ai_allowed,
    test_barcode_enrichment_defaults_processing_bucket_when_ai_unavailable,
    test_existing_ai_metadata_does_not_reenrich_on_live_lookup,
    test_food_submission_creates_private_food_and_pending_review,
    test_kitchen_custom_food_searches_thallo_without_remote,
    test_food_search_does_not_leak_other_users_private_foods,
    test_food_search_supports_out_of_order_tokens,
    test_food_search_tolerates_small_typo,
    test_short_food_queries_do_not_hit_remote_or_ai,
    test_food_search_can_disable_ai_fallback_for_signup,
    test_food_search_uses_fatsecret_before_usda_and_ai,
    test_fatsecret_v1_search_parser_normalizes_restaurant_item,
    test_fatsecret_v5_search_parser_keeps_serving_id_external,
    test_fatsecret_provider_status_probe_is_sanitized,
    test_openfoodfacts_barcode_keeps_serving_grams,
    test_usda_fatty_acid_mapping_uses_real_nutrients,
]


if __name__ == "__main__":
    for case in cases:
        case()
