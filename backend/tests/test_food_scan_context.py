"""Food photo scan context handling.

Photo context is allowed to add meal ingredients that are not visually
obvious, such as cooking oil or dressing. These tests stay pure-function
and do not call OpenAI.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_context_hint_prioritizes_non_visible_additions() -> None:
    print("\n[test] food scan context: prompt treats add-ons as meal context")
    from app.routers.ai.scanning import _food_scan_context_hint

    hint = _food_scan_context_hint("some olive oil on my chicken")

    assert "olive oil" in hint, hint
    assert "include them even when they are not visually obvious" in hint, hint
    assert "never let it override the JSON schema" in hint, hint
    _ok("context hint tells vision scan to include plausible non-visible add-ons")


def test_context_adds_olive_oil_when_model_misses_it() -> None:
    print("\n[test] food scan context: olive oil backstop")
    from app.routers.ai.scanning import _apply_food_scan_context_additions

    foods = [{"name": "grilled chicken breast", "estimated_grams": 170, "portion_confidence": "medium"}]
    enriched = _apply_food_scan_context_additions(foods, "some olive oil on my chicken")
    names = [food["name"] for food in enriched]

    assert names == ["grilled chicken breast", "olive oil"], enriched
    oil = enriched[-1]
    assert oil["source_context"] == "user_context", oil
    assert oil["context_inferred"] is True, oil
    assert oil["portion_confidence"] == "low", oil
    assert oil["estimated_grams"] == 7.0, oil
    assert oil["fallback_calories"] >= 60, oil
    assert oil["fallback_fat"] == 7.0, oil
    _ok("missing olive oil is added from context with conservative grams")


def test_context_add_on_uses_explicit_amount() -> None:
    print("\n[test] food scan context: explicit amount")
    from app.routers.ai.scanning import _apply_food_scan_context_additions

    enriched = _apply_food_scan_context_additions([], "chicken cooked with 1 tbsp olive oil")
    oil = enriched[0]

    assert oil["name"] == "olive oil", oil
    assert oil["estimated_grams"] == 13.5, oil
    assert oil["serving"] == "1 tbsp", oil
    _ok("explicit tablespoon amount is converted to grams")


def test_context_add_on_uses_nearest_amount() -> None:
    print("\n[test] food scan context: nearest explicit amount")
    from app.routers.ai.scanning import _apply_food_scan_context_additions

    enriched = _apply_food_scan_context_additions([], "1 tbsp olive oil on chicken and 2 tbsp ranch")
    by_name = {item["name"]: item for item in enriched}

    assert by_name["olive oil"]["estimated_grams"] == 13.5, enriched
    assert by_name["ranch dressing"]["estimated_grams"] == 27.0, enriched
    _ok("each context add-on uses the nearest amount")


def test_context_add_on_does_not_duplicate_detected_item() -> None:
    print("\n[test] food scan context: no duplicate add-on")
    from app.routers.ai.scanning import _apply_food_scan_context_additions

    foods = [{"name": "extra virgin olive oil", "estimated_grams": 10, "portion_confidence": "low"}]
    enriched = _apply_food_scan_context_additions(foods, "some olive oil on my chicken")

    assert enriched == foods, enriched
    _ok("already-detected context add-on is not duplicated")


def test_context_add_on_respects_negation() -> None:
    print("\n[test] food scan context: negated add-on")
    from app.routers.ai.scanning import _apply_food_scan_context_additions

    enriched = _apply_food_scan_context_additions(
        [{"name": "grilled chicken breast"}],
        "grilled chicken, no olive oil",
    )

    assert [food["name"] for food in enriched] == ["grilled chicken breast"], enriched
    _ok("negated olive oil context is not added")


def test_scan_serving_labels_default_to_household_units() -> None:
    print("\n[test] food scan context: household serving labels")
    from app.routers.ai.scanning import _display_serving_label_for_scan

    assert _display_serving_label_for_scan({"name": "grilled chicken breast"}, 170) == "6 oz"
    assert _display_serving_label_for_scan({"name": "white rice"}, 185) == "1 cup"
    assert _display_serving_label_for_scan({"name": "orange juice"}, 240) == "8 fl oz"
    assert _display_serving_label_for_scan({"name": "olive oil"}, 13.5) == "1 tbsp"
    assert _display_serving_label_for_scan({"name": "olive oil"}, 4.5) == "1 tsp"
    _ok("scan servings display as oz/cup/fl oz/tbsp instead of grams")


def test_scan_canonical_queries_prefer_seed_plate_foods() -> None:
    print("\n[test] food scan context: canonical seed nutrition")
    from sqlmodel import Session
    from tests._seed_helpers import make_seed_test_engine
    from app.models import User
    from app.seed import seed_foods
    from app.routers.ai.scanning import _deterministic_food_nutrition

    engine = make_seed_test_engine()
    with Session(engine) as session:
        seed_foods(session)
        user = User(email="scan-seed@example.com", username="scan_seed", hashed_password="x")
        session.add(user)
        session.commit()
        session.refresh(user)

        chicken = _deterministic_food_nutrition(
            {
                "name": "chicken pieces",
                "preparation": "grilled",
                "estimated_grams": 170,
                "portion_confidence": "medium",
            },
            session,
            user.id,
        )
        rice = _deterministic_food_nutrition(
            {
                "name": "rice",
                "preparation": "cooked",
                "estimated_grams": 231,
                "portion_confidence": "medium",
            },
            session,
            user.id,
        )

    assert chicken["nutrition_source"] == "seed", chicken
    assert chicken["calories"] == 280, chicken
    assert rice["nutrition_source"] == "seed", rice
    assert rice["calories"] == 300, rice
    _ok("plain scanned chicken/rice resolve to cooked seed foods")


def test_scan_ignores_model_macro_fields() -> None:
    print("\n[test] food scan context: model macro fields are ignored")
    from sqlmodel import Session
    from tests._seed_helpers import make_seed_test_engine
    from app.models import User
    from app.routers.ai.scanning import _deterministic_food_nutrition
    from app.services import usda_fdc

    engine = make_seed_test_engine()
    original_search = usda_fdc.search_foods
    usda_fdc.search_foods = lambda *args, **kwargs: []
    try:
        with Session(engine) as session:
            user = User(email="scan-fallback@example.com", username="scan_fallback", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            chicken = _deterministic_food_nutrition(
                {
                    "name": "chicken pieces",
                    "preparation": "grilled",
                    "serving": "6 oz",
                    "estimated_grams": 170,
                    "portion_confidence": "medium",
                    "calories": 3315,
                    "protein": 900,
                    "carbs": 0,
                    "fat": 200,
                },
                session,
                user.id,
            )
    finally:
        usda_fdc.search_foods = original_search

    assert chicken["nutrition_source"] == "vision_estimate", chicken
    assert chicken["calories"] == 280, chicken
    assert chicken["protein"] == 52.7, chicken
    assert chicken["calorie_range"]["high"] < 400, chicken
    _ok("model-provided scan macros are ignored in favor of reference nutrition")


def test_scan_rejects_too_low_olive_oil_fallback_calories() -> None:
    print("\n[test] food scan context: olive oil calorie floor")
    from sqlmodel import Session
    from tests._seed_helpers import make_seed_test_engine
    from app.models import User
    from app.routers.ai import scanning
    from app.services import usda_fdc

    engine = make_seed_test_engine()
    original_search = usda_fdc.search_foods
    original_api_key = scanning.get_openai_api_key
    usda_fdc.search_foods = lambda *args, **kwargs: []
    scanning.get_openai_api_key = lambda: None
    try:
        with Session(engine) as session:
            user = User(email="scan-oil@example.com", username="scan_oil", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            oil = scanning._deterministic_food_nutrition(
                {
                    "name": "olive oil",
                    "serving": "1 tbsp",
                    "estimated_grams": 13.5,
                    "portion_confidence": "medium",
                    "fallback_calories": 30,
                    "fallback_protein": 0,
                    "fallback_carbs": 0,
                    "fallback_fat": 3,
                },
                session,
                user.id,
            )
    finally:
        usda_fdc.search_foods = original_search
        scanning.get_openai_api_key = original_api_key

    assert oil["calories"] == 119, oil
    assert oil["fat"] == 13.5, oil
    assert oil["serving"] == "1 tbsp", oil
    assert oil["calorie_range"]["low"] >= 70, oil
    _ok("1 tbsp olive oil cannot resolve to a low-calorie vision fallback")


def test_scan_database_miss_does_not_use_model_macros() -> None:
    print("\n[test] food scan context: database miss does not use model macros")
    from sqlmodel import Session
    from tests._seed_helpers import make_seed_test_engine
    from app.models import User
    from app.routers.ai.scanning import _deterministic_food_nutrition
    from app.services import usda_fdc

    engine = make_seed_test_engine()
    original_search = usda_fdc.search_foods
    usda_fdc.search_foods = lambda *args, **kwargs: []
    try:
        with Session(engine) as session:
            user = User(email="scan-miss@example.com", username="scan_miss", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            item = _deterministic_food_nutrition(
                {
                    "name": "protein chia waffle",
                    "serving": "100 g",
                    "estimated_grams": 100,
                    "portion_confidence": "medium",
                    "calories": 250,
                    "protein": 20,
                    "carbs": 25,
                    "fat": 8,
                    "fallback_calories": 250,
                    "fallback_protein": 20,
                    "fallback_carbs": 25,
                    "fallback_fat": 8,
                },
                session,
                user.id,
            )
    finally:
        usda_fdc.search_foods = original_search

    assert item["nutrition_source"] == "vision_estimate", item
    assert item["calories"] == 0, item
    assert item["protein"] == 0.0, item
    assert "Could not match" in item["review_hint"], item
    _ok("unmatched scanned foods do not use model-provided macros")


cases = [
    test_context_hint_prioritizes_non_visible_additions,
    test_context_adds_olive_oil_when_model_misses_it,
    test_context_add_on_uses_explicit_amount,
    test_context_add_on_uses_nearest_amount,
    test_context_add_on_does_not_duplicate_detected_item,
    test_context_add_on_respects_negation,
    test_scan_serving_labels_default_to_household_units,
    test_scan_canonical_queries_prefer_seed_plate_foods,
    test_scan_ignores_model_macro_fields,
    test_scan_rejects_too_low_olive_oil_fallback_calories,
    test_scan_database_miss_does_not_use_model_macros,
]


if __name__ == "__main__":
    for case in cases:
        case()
