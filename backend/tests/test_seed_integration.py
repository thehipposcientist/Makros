"""Seed-to-consumer integration tests.

These sit between pure seed validators and live HTTP smoke tests. They
exercise the path that matters in production: reference seed data is
written into a real DB, then app services and metadata routes consume the
same rows without duplicate inserts or shape drift.
"""
from __future__ import annotations

from sqlmodel import Session, select

from tests._seed_helpers import make_seed_test_engine, point_app_database_at


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_equipment_and_exercise_seed_is_idempotent_and_meta_ready() -> None:
    print("\n[test] seed integration: equipment/exercises idempotent + meta-ready")
    from app.models import Equipment, Exercise, ExerciseEquipment
    from app.routers.meta import list_exercises
    from app.seed import seed_equipment, seed_exercises

    engine = make_seed_test_engine()
    with Session(engine) as session:
        seed_equipment(session)
        seed_exercises(session)
        first_equipment_count = len(session.exec(select(Equipment)).all())
        first_exercise_count = len(session.exec(select(Exercise)).all())
        first_mapping_count = len(session.exec(select(ExerciseEquipment)).all())

        seed_equipment(session)
        seed_exercises(session)
        second_equipment_count = len(session.exec(select(Equipment)).all())
        second_exercise_count = len(session.exec(select(Exercise)).all())
        second_mapping_count = len(session.exec(select(ExerciseEquipment)).all())

        assert second_equipment_count == first_equipment_count
        assert second_exercise_count == first_exercise_count
        assert second_mapping_count == first_mapping_count

        equipment_rows = session.exec(select(Equipment)).all()
        equipment_slugs = [row.slug for row in equipment_rows]
        assert len(equipment_slugs) == len(set(equipment_slugs)), "duplicate equipment slugs after reseed"

        ex = session.exec(
            select(Exercise).where(Exercise.slug == "stability_ball_chest_press")
        ).first()
        assert ex is not None, "stability_ball_chest_press did not seed"
        rows = session.exec(
            select(ExerciseEquipment, Equipment)
            .join(Equipment, Equipment.id == ExerciseEquipment.equipment_id)
            .where(ExerciseEquipment.exercise_id == ex.id)
        ).all()
        required_slugs = {eq.slug for link, eq in rows if link.required}
        assert required_slugs == {"dumbbells", "swiss_ball"}, required_slugs

        meta_rows = list_exercises(db=session)
        meta_entry = next(row for row in meta_rows if row["slug"] == "stability_ball_chest_press")
        meta_required = {gear["slug"] for gear in meta_entry["gear"] if gear["required"]}
        assert meta_required == {"dumbbells", "swiss_ball"}, meta_entry["gear"]

        kickbacks = session.exec(
            select(Exercise).where(Exercise.slug == "kickbacks")
        ).first()
        assert kickbacks is not None, "kickbacks did not seed"
        assert kickbacks.name == "Dumbbell Tricep Kickbacks"
        assert kickbacks.primary_muscle == "triceps"

    _ok("reseed preserves counts and /meta/exercises exposes required gear")


def test_food_seed_default_servings_hydrate_into_meal_lookup() -> None:
    print("\n[test] seed integration: food defaults hydrate into meal lookup")
    from app.models import Food, FoodAlias, FoodServing
    from app.routers.ai.utils import _hydrate_foods_from_db
    from app.routers.meta import list_foods
    from app.seed import seed_foods
    from app.services.nutrition.meal_assembler import build_food_lookup

    engine = make_seed_test_engine()
    point_app_database_at(engine)

    with Session(engine) as session:
        seed_foods(session)
        first_food_count = len(session.exec(select(Food)).all())
        first_alias_count = len(session.exec(select(FoodAlias)).all())
        first_serving_count = len(session.exec(select(FoodServing)).all())

        seed_foods(session)
        assert len(session.exec(select(Food)).all()) == first_food_count
        assert len(session.exec(select(FoodAlias)).all()) == first_alias_count
        assert len(session.exec(select(FoodServing)).all()) == first_serving_count

        foods = session.exec(select(Food)).all()
        normalized_names = [food.normalized_name for food in foods]
        assert len(normalized_names) == len(set(normalized_names)), "duplicate normalized food names after reseed"

        whey = session.exec(
            select(Food).where(Food.name == "Protein Powder (Whey)")
        ).first()
        assert whey is not None, "Protein Powder (Whey) did not seed"
        whey_servings = session.exec(
            select(FoodServing).where(FoodServing.food_id == whey.id)
        ).all()
        defaults = [serving for serving in whey_servings if serving.is_default]
        assert len(defaults) == 1, f"expected exactly one default serving, got {defaults}"
        assert defaults[0].label == "1 scoop (32g)"
        assert 119 <= defaults[0].calories <= 121
        assert 24 <= defaults[0].protein <= 26

        meta_foods = list_foods(db=session)
        meta_whey = next(row for row in meta_foods if row["name"] == "Protein Powder (Whey)")
        assert meta_whey["unit"] == "1 scoop (32g)"
        assert 119 <= meta_whey["calories"] <= 121

    hydrated, unknowns = _hydrate_foods_from_db(["whey protein"])
    assert unknowns == [], unknowns
    assert len(hydrated) == 1
    assert hydrated[0]["name"] == "Protein Powder (Whey)"
    assert hydrated[0]["serving"] == "1 scoop (32g)"
    assert 119 <= hydrated[0]["calories"] <= 121

    lookup = build_food_lookup({"foods": hydrated})
    whey_macros = lookup["protein powder (whey)"]
    assert 119 <= whey_macros.calories <= 121
    assert 24 <= whey_macros.protein <= 26
    assert whey_macros.serving_unit != "serving"

    _ok("seeded serving -> /meta/foods -> DB hydrate -> meal lookup all agree")


def test_usda_seed_backfill_survives_reseed_and_meta_stays_curated() -> None:
    print("\n[test] seed integration: USDA backfill + curated meta foods")
    from app.enums import FoodCategory, FoodSource
    from app.food_service import normalize_food_name
    from app.models import Food, FoodNutrition, FoodServing
    from app.routers.meta import list_foods
    from app.seed import seed_foods

    engine = make_seed_test_engine()
    with Session(engine) as session:
        seed_foods(session)

        chicken = session.exec(select(Food).where(Food.name == "Chicken Breast")).first()
        assert chicken is not None
        chicken.external_id = "usda-test-chicken"
        chicken.calories = 123
        chicken.protein = 29
        chicken.carbs = 0
        chicken.fat = 2
        session.add(chicken)
        chicken_nutrition = session.exec(
            select(FoodNutrition).where(FoodNutrition.food_id == chicken.id)
        ).first()
        assert chicken_nutrition is not None
        chicken_nutrition.calories = 123
        chicken_nutrition.protein = 29
        chicken_nutrition.carbs = 0
        chicken_nutrition.fat = 2
        session.add(chicken_nutrition)

        session.add(Food(
            name="USDA Catalog Apple",
            normalized_name=normalize_food_name("USDA Catalog Apple"),
            category=FoodCategory.FRUITS,
            source=FoodSource.USDA,
            external_id="usda-test-apple",
            is_verified=True,
            unit="100 g",
            calories=52,
            protein=0.3,
            carbs=14,
            fat=0.2,
        ))
        session.flush()
        usda_food = session.exec(select(Food).where(Food.name == "USDA Catalog Apple")).first()
        assert usda_food is not None
        session.add(FoodNutrition(
            food_id=usda_food.id,
            reference_unit="100g",
            reference_grams=100,
            calories=52,
            protein=0.3,
            carbs=14,
            fat=0.2,
        ))
        session.add(FoodServing(
            food_id=usda_food.id,
            label="100 g",
            grams=100,
            is_default=True,
            calories=52,
            protein=0.3,
            carbs=14,
            fat=0.2,
        ))
        session.commit()

        seed_foods(session)

        refreshed = session.exec(select(Food).where(Food.name == "Chicken Breast")).first()
        assert refreshed is not None
        refreshed_nutrition = session.exec(
            select(FoodNutrition).where(FoodNutrition.food_id == refreshed.id)
        ).first()
        assert refreshed_nutrition is not None
        assert refreshed.external_id == "usda-test-chicken"
        assert refreshed_nutrition.calories == 123
        assert refreshed_nutrition.protein == 29

        default_serving = session.exec(
            select(FoodServing)
            .where(FoodServing.food_id == refreshed.id)
            .where(FoodServing.is_default == True)  # noqa: E712
        ).first()
        assert default_serving is not None
        assert default_serving.calories == 123
        assert default_serving.protein == 29

        meta_names = {row["name"] for row in list_foods(db=session)}
        assert "Chicken Breast" in meta_names
        assert "USDA Catalog Apple" not in meta_names

    _ok("USDA-backed seed nutrition is preserved and /meta/foods stays curated")


def test_food_seed_validator_has_no_actionable_warnings() -> None:
    print("\n[test] seed integration: food seed validator clean")
    from app.seed_foods_data import SEED_FOODS
    from app.seed_validation import validate_seed

    report = validate_seed(SEED_FOODS)
    assert report.total() == 0, report.warnings
    _ok("food seed data has no validator warnings")


cases = [
    test_equipment_and_exercise_seed_is_idempotent_and_meta_ready,
    test_food_seed_default_servings_hydrate_into_meal_lookup,
    test_usda_seed_backfill_survives_reseed_and_meta_stays_curated,
    test_food_seed_validator_has_no_actionable_warnings,
]


if __name__ == "__main__":
    failed = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {case.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {case.__name__} ({type(e).__name__}): {e}")
    raise SystemExit(1 if failed else 0)
