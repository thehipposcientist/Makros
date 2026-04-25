"""Tests for `services.nutrition.allergen_filter.filter_allergens`.

The hard safety net for AI-generated meals. The AI prompt instructs it
to avoid allergens, but a hallucination here means the user gets a
real meal containing their declared allergen. The filter strips
matching items + re-sums macros so the meal still has consistent totals.

Coverage:
  - Each allergen category strips its keywords (peanuts/tree_nuts/dairy/
    gluten/soy/eggs/shellfish/fish)
  - Macros are re-summed after strip (calories/protein/carbs/fat/fiber)
  - Word-boundary match (does NOT strip 'crab' from 'crabapple', etc)
  - No-allergens / empty plans → no-op
  - Multiple allergens → all matching items removed
  - Items list left untouched if no removal happened
  - Negative: items that don't contain the allergen are preserved
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_plan(meals: list[dict]) -> list[dict]:
    """Wrap a list of meals into the plan-list shape the function expects."""
    return [{"date": "2026-04-25", "meals": meals}]


def _meal(name: str, items: list[dict]) -> dict:
    cal = sum(it.get("calories", 0) for it in items)
    pro = sum(it.get("protein", 0) for it in items)
    carb = sum(it.get("carbs", 0) for it in items)
    fat = sum(it.get("fat", 0) for it in items)
    return {
        "name": name, "items": items,
        "calories": cal, "protein": pro, "carbs": carb, "fat": fat,
    }


def _item(name: str, *, calories=100, protein=10, carbs=10, fat=5, fiber=0) -> dict:
    return {
        "name": name, "calories": calories, "protein": protein,
        "carbs": carbs, "fat": fat, "fiber": fiber,
    }


# ── Per-allergen strip ─────────────────────────────────────────

def test_dairy_strips_milk_and_cheese():
    print("\n[test] dairy filter strips milk + cheese, keeps chicken")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Breakfast", [
            _item("Greek Yogurt"),
            _item("Granola"),
            _item("Almond Milk"),  # negative: 'almond' not 'milk' word
        ]),
        _meal("Lunch", [
            _item("Grilled Chicken"),
            _item("Cheddar Cheese"),
        ]),
    ])
    removed = filter_allergens(plans, ["dairy"])
    items_b = plans[0]["meals"][0]["items"]
    items_l = plans[0]["meals"][1]["items"]
    # Greek Yogurt has no 'milk'/'cheese'/'cream'/'yogurt' word boundaries...
    # actually 'yogurt' IS in the dairy keywords, so it should be stripped.
    bf_names = [i["name"] for i in items_b]
    assert "Greek Yogurt" not in bf_names, "yogurt is dairy"
    lunch_names = [i["name"] for i in items_l]
    assert "Cheddar Cheese" not in lunch_names
    assert "Grilled Chicken" in lunch_names, "chicken kept"
    assert removed >= 2


def test_gluten_strips_bread_and_pasta():
    print("\n[test] gluten filter strips bread + pasta, keeps rice")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Lunch", [
            _item("Whole Wheat Bread"),
            _item("Pasta"),
            _item("Rice"),
        ]),
    ])
    filter_allergens(plans, ["gluten"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Whole Wheat Bread" not in names
    assert "Pasta" not in names
    assert "Rice" in names, "rice has no gluten keyword"


def test_peanuts_strips_peanut_butter_keeps_almonds():
    print("\n[test] peanuts filter strips peanut butter, keeps tree nuts")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Snack", [
            _item("Peanut Butter"),
            _item("Almonds"),
        ]),
    ])
    filter_allergens(plans, ["peanuts"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Peanut Butter" not in names
    assert "Almonds" in names


def test_tree_nuts_strips_walnuts_keeps_peanut():
    """tree_nuts ≠ peanuts. Filtering tree_nuts must keep peanut butter."""
    print("\n[test] tree_nuts filter does NOT strip peanut butter")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Snack", [
            _item("Walnuts"),
            _item("Peanut Butter"),
        ]),
    ])
    filter_allergens(plans, ["tree_nuts"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Walnuts" not in names
    assert "Peanut Butter" in names


def test_shellfish_strips_shrimp_keeps_salmon():
    print("\n[test] shellfish filter strips shrimp, keeps salmon")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Dinner", [
            _item("Shrimp Stir Fry"),
            _item("Salmon Fillet"),
        ]),
    ])
    filter_allergens(plans, ["shellfish"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Shrimp Stir Fry" not in names
    assert "Salmon Fillet" in names


def test_fish_strips_salmon_and_tuna_keeps_chicken():
    print("\n[test] fish filter strips salmon/tuna, keeps chicken")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Lunch", [
            _item("Tuna Salad"),
            _item("Salmon Roll"),
            _item("Grilled Chicken"),
        ]),
    ])
    filter_allergens(plans, ["fish"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Tuna Salad" not in names
    assert "Salmon Roll" not in names
    assert "Grilled Chicken" in names


def test_soy_strips_tofu_and_edamame():
    print("\n[test] soy filter strips tofu + edamame")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Bowl", [
            _item("Tofu"),
            _item("Edamame"),
            _item("Quinoa"),
        ]),
    ])
    filter_allergens(plans, ["soy"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Tofu" not in names
    assert "Edamame" not in names
    assert "Quinoa" in names


def test_eggs_strips_egg_items():
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Breakfast", [
            _item("Scrambled Eggs"),
            _item("Omelette"),
            _item("Oatmeal"),
        ]),
    ])
    filter_allergens(plans, ["eggs"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Scrambled Eggs" not in names
    assert "Omelette" not in names
    assert "Oatmeal" in names


# ── Macro re-sum ──────────────────────────────────────────────

def test_macros_resum_after_strip():
    """Item totals after strip must equal sum of remaining items."""
    print("\n[test] macros re-summed correctly after strip")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Lunch", [
            _item("Cheese", calories=200, protein=15, carbs=2, fat=15),
            _item("Chicken", calories=250, protein=40, carbs=0, fat=10),
        ]),
    ])
    filter_allergens(plans, ["dairy"])
    meal = plans[0]["meals"][0]
    assert meal["calories"] == 250, f"expected 250 kcal after strip, got {meal['calories']}"
    assert meal["protein"] == 40
    assert meal["carbs"] == 0
    assert meal["fat"] == 10


def test_fiber_re_summed_when_present():
    print("\n[test] fiber re-summed when remaining items have fiber")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Lunch", [
            _item("Cheese", calories=100, protein=10, fat=8),
            _item("Beans", calories=150, protein=10, carbs=25, fat=1, fiber=10),
        ]),
    ])
    filter_allergens(plans, ["dairy"])
    meal = plans[0]["meals"][0]
    assert meal.get("fiber") == 10


# ── Multiple allergens ───────────────────────────────────────

def test_multiple_allergens_all_match():
    print("\n[test] dairy + gluten filters strip both")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Lunch", [
            _item("Bread"),
            _item("Cheese"),
            _item("Chicken"),
        ]),
    ])
    removed = filter_allergens(plans, ["dairy", "gluten"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Bread" not in names
    assert "Cheese" not in names
    assert "Chicken" in names
    assert removed == 2


# ── Word-boundary safety ─────────────────────────────────────

def test_word_boundary_prevents_partial_match():
    """'crabapple' should NOT match shellfish 'crab' — word boundary."""
    print("\n[test] crabapple is NOT stripped by shellfish filter (word boundary)")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        _meal("Snack", [
            _item("Crabapple Jelly"),
            _item("Crab Cake"),
        ]),
    ])
    filter_allergens(plans, ["shellfish"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Crabapple Jelly" in names, "crabapple should NOT match 'crab' word"
    assert "Crab Cake" not in names, "crab cake DOES match"


# ── No-op cases ──────────────────────────────────────────────

def test_no_allergens_returns_zero():
    print("\n[test] empty allergens → no-op, returns 0")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([_meal("Lunch", [_item("Cheese")])])
    n = filter_allergens(plans, None)
    assert n == 0
    n = filter_allergens(plans, [])
    assert n == 0


def test_empty_plans_returns_zero():
    from app.services.nutrition.allergen_filter import filter_allergens
    assert filter_allergens([], ["dairy"]) == 0


def test_no_matching_items_returns_zero():
    print("\n[test] no items match → 0 removed, items unchanged")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([_meal("Lunch", [_item("Chicken"), _item("Rice")])])
    items_before = list(plans[0]["meals"][0]["items"])
    n = filter_allergens(plans, ["dairy"])
    assert n == 0
    assert plans[0]["meals"][0]["items"] == items_before


def test_unknown_allergen_treated_as_keyword():
    """Custom allergen string → used as a keyword."""
    print("\n[test] unknown allergen string used as keyword")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([_meal("Snack", [_item("Coconut Water"), _item("Apple")])])
    n = filter_allergens(plans, ["coconut"])
    names = [i["name"] for i in plans[0]["meals"][0]["items"]]
    assert "Coconut Water" not in names
    assert "Apple" in names
    assert n == 1


# ── Malformed input safety ───────────────────────────────────

def test_malformed_meal_item_skipped_safely():
    """A non-dict item should be preserved (no crash)."""
    print("\n[test] non-dict items are preserved without crash")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = _make_plan([
        {"name": "Lunch", "items": ["weird_string", _item("Cheese")],
         "calories": 100, "protein": 10, "carbs": 0, "fat": 5},
    ])
    n = filter_allergens(plans, ["dairy"])
    assert n == 1
    items = plans[0]["meals"][0]["items"]
    assert "weird_string" in items, "non-dict item preserved"


def test_meal_without_items_key_skipped():
    print("\n[test] meal with no items key → no crash")
    from app.services.nutrition.allergen_filter import filter_allergens
    plans = [{"date": "2026-04-25", "meals": [{"name": "Lunch"}]}]
    n = filter_allergens(plans, ["dairy"])
    assert n == 0


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} allergen_filter tests passed")
