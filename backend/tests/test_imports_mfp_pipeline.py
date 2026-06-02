"""Integration-ish tests for the MyFitnessPal import pipeline.

Run from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_imports_mfp_pipeline
"""
from __future__ import annotations

from datetime import date

from sqlmodel import SQLModel, Session, create_engine, select

from app.enums import FoodCategory, FoodSource
from app.models import DailyNutritionMetrics, Food, FoodNutrition, MealItem, User
from app.services.imports.mfp_matcher import MatchResult
from app.services.imports.mfp_pipeline import run_mfp_import


def _engine():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        echo=False,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _user(session: Session) -> User:
    user = User(email="mfp-pipeline@example.com", username="mfppipeline", hashed_password="x")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _csv(text: str) -> bytes:
    return text.encode("utf-8")


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_import_preserves_mfp_nutrient_snapshots_and_refreshes_metrics() -> None:
    print("\n[test] MFP import preserves nutrient snapshots")
    engine = _engine()
    with Session(engine) as session:
        user = _user(session)
        batch = run_mfp_import(
            session,
            user.id,
            _csv(
                "Date,Meal,Food,Calories,Fat (g),Saturated Fat,"
                "Cholesterol (mg),Sodium (mg),Carbohydrates (g),Fiber,Sugar,Protein (g)\n"
                "2026-05-08,Breakfast,Mystery cereal,200,4,1.5,0,220,35,6,9,8\n"
            ),
            "mfp.csv",
            use_usda=False,
        )

        assert batch.status == "complete", batch
        assert batch.fallback_rows == 1, batch
        item = session.exec(select(MealItem)).first()
        assert item is not None, "MealItem inserted"
        assert item.food_id is None, item
        assert item.calories == 200, item
        assert item.fiber_g == 6, item
        assert item.sodium_mg == 220, item
        assert item.saturated_fat_g == 1.5, item
        assert item.sugar_g == 9, item

        metrics = session.exec(
            select(DailyNutritionMetrics).where(
                DailyNutritionMetrics.user_id == user.id,
                DailyNutritionMetrics.metric_date == date(2026, 5, 8),
            )
        ).first()
        assert metrics is not None, "DailyNutritionMetrics refreshed"
        assert metrics.calories_total == 200, metrics.model_dump()
        assert metrics.fiber_total_g == 6, metrics.model_dump()
        assert metrics.sodium_mg == 220, metrics.model_dump()
        assert metrics.saturated_fat_g == 1.5, metrics.model_dump()
    _ok("fallback MFP rows carry quality nutrients into daily metrics")


def test_usda_normalization_keeps_mfp_macros_authoritative() -> None:
    print("\n[test] MFP USDA normalization keeps MFP macros")
    import app.services.imports.mfp_pipeline as pipeline

    engine = _engine()
    original_builder = pipeline._build_usda_lookup
    try:
        with Session(engine) as session:
            user = _user(session)
            food = Food(
                name="USDA Greek Yogurt",
                normalized_name="usda greek yogurt",
                category=FoodCategory.DAIRY,
                source=FoodSource.USDA,
                external_id="123",
                is_verified=True,
                calories=90,
                protein=16,
                carbs=5,
                fat=0,
            )
            session.add(food)
            session.flush()
            session.add(FoodNutrition(
                food_id=food.id,
                reference_unit="170 g",
                reference_grams=170,
                calories=90,
                protein=16,
                carbs=5,
                fat=0,
            ))
            session.commit()
            session.refresh(food)

            def fake_builder(session: Session, *, user_id: int, max_lookups: int):
                def lookup(_name: str) -> MatchResult:
                    return MatchResult(
                        food_id=food.id,
                        food_name=food.name,
                        confidence="usda",
                        calories=90,
                        protein_g=16,
                        carbs_g=5,
                        fat_g=0,
                    )
                return lookup

            pipeline._build_usda_lookup = fake_builder
            batch = run_mfp_import(
                session,
                user.id,
                _csv(
                    "Date,Meal,Food,Calories,Fat (g),Carbohydrates (g),Protein (g)\n"
                    "2026-05-08,Snack,Brand Greek Yogurt Cup,120,2,8,20\n"
                ),
                "mfp.csv",
                use_usda=True,
            )

            assert batch.status == "complete", batch
            assert batch.ai_matched_rows == 1, batch
            item = session.exec(select(MealItem)).first()
            assert item is not None, "MealItem inserted"
            assert item.food_id == food.id, item
            assert item.food_name == "USDA Greek Yogurt", item
            assert item.calories == 120, item
            assert item.protein_g == 20, item
            assert item.carbs_g == 8, item
            assert item.fat_g == 2, item
    finally:
        pipeline._build_usda_lookup = original_builder
    _ok("external food link is attached without overwriting MFP logged macros")


def test_meal_level_mfp_export_imports_daily_metrics() -> None:
    print("\n[test] MFP meal-level export imports meal summaries")
    engine = _engine()
    with Session(engine) as session:
        user = _user(session)
        batch = run_mfp_import(
            session,
            user.id,
            _csv(
                "Date,Meal,Calories,Fat (g),Carbohydrates (g),Dietary Fiber (g),Sugars (g),Protein (g)\n"
                "2026-05-08,Breakfast,350,10,45,6,12,20\n"
                "2026-05-08,Lunch,600,22,55,8,9,42\n"
                "2026-05-08,Daily Total,950,32,100,14,21,62\n"
            ),
            "Your Nutrition.csv",
            use_usda=False,
        )

        assert batch.status == "complete", batch
        assert batch.total_rows == 3, batch
        assert batch.skipped_rows == 1, batch
        assert batch.fallback_rows == 2, batch

        items = session.exec(select(MealItem)).all()
        assert len(items) == 2, items
        assert {item.food_name for item in items} == {"MyFitnessPal Breakfast", "MyFitnessPal Lunch"}
        assert sum(item.protein_g or 0 for item in items) == 62, items
        assert sum(item.sugar_g or 0 for item in items) == 21, items

        metrics = session.exec(
            select(DailyNutritionMetrics).where(
                DailyNutritionMetrics.user_id == user.id,
                DailyNutritionMetrics.metric_date == date(2026, 5, 8),
            )
        ).first()
        assert metrics is not None, "DailyNutritionMetrics refreshed"
        assert metrics.calories_total == 950, metrics.model_dump()
        assert metrics.fiber_total_g == 14, metrics.model_dump()
    _ok("meal-level MFP rows carry calories/macros into daily metrics")


if __name__ == "__main__":
    test_import_preserves_mfp_nutrient_snapshots_and_refreshes_metrics()
    test_usda_normalization_keeps_mfp_macros_authoritative()
    test_meal_level_mfp_export_imports_daily_metrics()
    print("\n✅ test_imports_mfp_pipeline.py PASSED")
