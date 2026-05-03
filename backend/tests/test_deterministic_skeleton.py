"""
Tests for the deterministic meal-skeleton generator — the AI-free
replacement for `meal_assembler.call_skeleton_ai`.

Coverage:
  * Calorie target is hit within ±8% across goal × pantry combos after
    the full assemble pipeline runs.
  * Protein target is hit within ±5% for muscle-gain users specifically
    (where protein adherence matters most).
  * Allergen filter is honored — a user allergic to tree_nuts gets no
    almond / walnut / cashew / etc. in their output.
  * Variety — day N and day N+1 don't produce identical meals for the
    same user + pantry.
  * Pantry-poor users (2-3 foods, no balanced archetype coverage) still
    get meals, never a crash.
  * Vegan dietary_preference → no animal foods anywhere in the output.
  * mealsPerDay in {5, 7} both produce templates with that many meals.

All tests bypass the OpenAI call entirely — the deterministic path
only needs the PlanRequest + allowed_foods list + the usual enrichment
lookup (which we stub here with `FoodMacros` dicts so we don't need
a real DB or USDA round-trip).
"""
from __future__ import annotations

from app.routers.ai.models import PlanRequest
from app.services.nutrition.deterministic_skeleton import (
    _diet_disallows,
    _filter_pantry,
    _food_is_allergen,
    generate_deterministic_skeleton,
)
from app.services.nutrition.meal_assembler import (
    DEFAULT_NUTRITION_PANTRY,
    FoodMacros,
    assemble_nutrition_response,
    assemble_template,
    food_names_for_generation,
    validate_and_repair_skeletons,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Test helpers ────────────────────────────────────────────────────────────


def _make_plan_request(**overrides) -> PlanRequest:
    """Minimal PlanRequest for nutrition skeleton tests. All non-skeleton
    fields (workout equipment, goal pace, etc.) get sensible defaults so
    Pydantic validation passes."""
    base = dict(
        goal="muscle_gain",
        daysPerWeek=4,
        physicalStats={
            "weightLbs": 180.0, "heightFeet": 5, "heightInches": 10,
            "age": 30, "gender": "male",
        },
        goalDetails={"pace": "moderate"},
        workoutDurationMinutes=60,
        equipment=["dumbbells"],
        foodsAvailable=[],
        mealsPerDay=3,
        mealVariety=3,
    )
    base.update(overrides)
    return PlanRequest(**base)


def _stub_food_lookup(foods: dict[str, tuple[float, float, float, float]]) -> dict[str, FoodMacros]:
    """Build a `name.lower() -> FoodMacros` dict from a compact macro table.

    Each entry is `(calories, protein, carbs, fat)` per 1 serving. Uses
    a generic "1 cup" label because the assembler only cares about the
    per-serving numbers here.
    """
    out: dict[str, FoodMacros] = {}
    for name, (cal, p, c, f) in foods.items():
        out[name.lower()] = FoodMacros(
            name=name, serving_label="1 cup", serving_quantity=1, serving_unit="cup",
            calories=cal, protein=p, carbs=c, fat=f,
        )
    return out


# Default realistic macros for common pantry items. All numbers are
# per-serving and in the right ballpark for USDA reference values.
_DEFAULT_FOOD_TABLE: dict[str, tuple[float, float, float, float]] = {
    "chicken breast":  (280, 53, 0,   6),
    "beef":            (240, 22, 0,  17),
    "turkey":          (170, 30, 0,   5),
    "salmon":          (280, 35, 0,  15),
    "tuna":            (110, 26, 0,   1),
    "eggs":            (78,  6,  1,   5),
    "greek yogurt":    (150, 17, 9,   4),
    "cottage cheese":  (180, 25, 8,   5),
    "whey":            (120, 24, 3,   2),
    "tofu":            (180, 20, 4,  11),
    "tempeh":          (195, 20, 9,  11),
    "lentils":         (230, 18, 40,  1),
    "chickpeas":       (270, 15, 45,  4),
    "black beans":     (220, 15, 40,  1),
    "oats":            (300, 10, 54,  5),
    "quinoa":          (220, 8,  39,  4),
    "brown rice":      (215, 5,  45,  2),
    "white rice":      (205, 4,  45,  1),
    "sweet potato":    (180, 4,  41,  0),
    "bread":           (140, 6,  27,  2),
    "pasta":           (220, 8,  44,  1),
    "broccoli":        (55,  4,  11,  1),
    "spinach":         (40,  5,  7,   0),
    "kale":            (35,  3,  7,   0),
    "asparagus":       (40,  4,  7,   0),
    "olive oil":       (120, 0,  0,  14),
    "butter":          (102, 0,  0,  11),
    "avocado":         (240, 3,  13, 22),
    "almonds":         (165, 6,  6,  14),
    "walnuts":         (185, 4,  4,  18),
    "cashews":         (160, 5,  9,  13),
    "peanut butter":   (190, 8,  8,  16),
    "cheddar":         (115, 7,  1,   9),
    "apple":           (95,  0,  25,  0),
    "banana":          (105, 1,  27,  0),
    "berries":         (85,  1,  20,  0),
}


def _enriched_for(pantry: list[str]) -> dict[str, FoodMacros]:
    """Produce a FoodMacros lookup for every pantry item that has a row
    in the default table. Unknown foods become stubs downstream."""
    table = {k: v for k, v in _DEFAULT_FOOD_TABLE.items() if k in {f.lower() for f in pantry}}
    return _stub_food_lookup({name: vals for name, vals in table.items()})


def _enriched_payload_for(pantry: list[str]) -> dict:
    """Build the enrichment payload shape consumed by assemble_nutrition_response."""
    foods: list[dict] = []
    for name in pantry:
        vals = _DEFAULT_FOOD_TABLE.get(name.lower())
        if not vals:
            continue
        cal, p, c, f = vals
        foods.append({
            "name": name,
            "serving": "1 cup",
            "calories": cal,
            "protein": p,
            "carbs": c,
            "fat": f,
            "fiber": 2,
            "sugar": 1,
            "sodium": 50,
        })
    return {"foods": foods, "routine_meals": []}


def _total_macros(template_out: dict) -> tuple[float, float, float, float]:
    """Sum calories/protein/carbs/fat across every meal in the template."""
    cal = sum(m.get("calories", 0) for m in template_out.get("meals", []))
    prot = sum(m.get("protein", 0) for m in template_out.get("meals", []))
    carb = sum(m.get("carbs", 0) for m in template_out.get("meals", []))
    fat = sum(m.get("fat", 0) for m in template_out.get("meals", []))
    return cal, prot, carb, fat


def _run_pipeline(
    req: PlanRequest,
    pantry: list[str],
    variety_n: int,
    target_cal: int,
    target_prot: int,
    target_carb: int,
    target_fat: int,
) -> list[dict]:
    """Run the full generate → validate → assemble chain so we can assert
    on the final macro totals (which is what callers actually see)."""
    templates, _note, _supps = generate_deterministic_skeleton(req, variety_n, pantry)
    templates = validate_and_repair_skeletons(templates, pantry, req.mealsPerDay)
    food_lookup = _enriched_for(pantry)
    return [
        assemble_template(tpl, food_lookup, target_cal, target_prot, target_carb, target_fat)
        for tpl in templates
    ]


# ─── 1. Calorie target accuracy across goal × pantry combos ─────────────────


def test_hits_calorie_target_within_8_percent() -> None:
    """Across a handful of (goal, pantry) combos the assembled day should
    land within ±8% of the calorie target."""
    print("\n[test] calorie target ±8% across goal × pantry combos")

    balanced_pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "almonds", "greek yogurt", "banana",
        "salmon", "sweet potato", "spinach", "avocado",
    ]
    lean_pantry = [
        "chicken breast", "white rice", "broccoli", "olive oil",
        "eggs", "oats", "apple",
    ]
    vegan_pantry = [
        "tofu", "lentils", "brown rice", "quinoa", "oats", "broccoli",
        "spinach", "olive oil", "almonds", "berries", "banana", "peanut butter",
    ]

    combos = [
        ("fat_loss",    balanced_pantry, 1800, 160, 180, 55),
        ("muscle_gain", balanced_pantry, 2800, 200, 320, 80),
        ("maintain",    lean_pantry,     2200, 170, 240, 65),
        ("fat_loss",    vegan_pantry,    1800, 140, 210, 55),
    ]
    for goal, pantry, cal, prot, carb, fat in combos:
        req = _make_plan_request(goal=goal, mealsPerDay=3, mealVariety=1)
        [plan] = _run_pipeline(req, pantry, 1, cal, prot, carb, fat)
        got_cal, _, _, _ = _total_macros(plan)
        drift = abs(got_cal - cal) / cal
        assert drift <= 0.08, (
            f"{goal}/{len(pantry)}-food pantry drift={drift:.3f} "
            f"(got {got_cal}, target {cal})"
        )
        _ok(f"{goal}: {got_cal} cal vs {cal} target (drift={drift:.1%})")


# ─── 2. Protein accuracy for muscle-gain ────────────────────────────────────


def test_hits_protein_target_within_5_percent_muscle_gain() -> None:
    """Muscle-gain users rely on protein hitting target — the deterministic
    skeleton must get within ±5% after the solver runs for a 3-meal day,
    which is the most common pattern for muscle-gain users (big meals,
    protein dense).

    The skeleton itself doesn't know per-food protein density; the solver
    in `meal_assembler.solve_portions` does the scaling. For a reasonable
    pantry with multiple protein sources and mealsPerDay=3 (fewer slots,
    bigger portions per slot so the solver has more room), we comfortably
    stay inside ±5%.
    """
    print("\n[test] protein target ±5% for muscle-gain user")
    pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "almonds", "whey", "greek yogurt",
        "salmon", "sweet potato", "spinach",
    ]
    req = _make_plan_request(goal="muscle_gain", mealsPerDay=3, mealVariety=1)
    [plan] = _run_pipeline(req, pantry, 1, 3000, 220, 330, 90)
    _, got_prot, _, _ = _total_macros(plan)
    drift = abs(got_prot - 220) / 220
    assert drift <= 0.05, f"protein drift={drift:.3f} (got {got_prot}, target 220)"
    _ok(f"protein: {got_prot}g vs 220g target (drift={drift:.1%})")


# ─── 3. Allergen filter ─────────────────────────────────────────────────────


def test_allergen_filter_blocks_tree_nuts() -> None:
    """A user declaring `tree_nuts` allergy must get zero almond / walnut /
    cashew / etc. in any emitted meal."""
    print("\n[test] tree_nut-allergic user gets no nuts")
    pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "almonds", "walnuts", "cashews", "peanut butter",
        "greek yogurt", "banana",
    ]
    req = _make_plan_request(
        goal="muscle_gain", mealsPerDay=3, mealVariety=3,
        allergies=["tree_nuts"],
    )
    templates, _, _ = generate_deterministic_skeleton(req, 3, pantry)
    blocked = {"almonds", "walnuts", "cashews"}
    for day_idx, tpl in enumerate(templates):
        for meal in tpl.meals:
            for ref in meal.food_refs:
                assert ref.lower() not in blocked, (
                    f"day {day_idx} meal '{meal.name}' has blocked food '{ref}'"
                )
    _ok("no tree_nut references in any meal across 3 days")


def test_food_is_allergen_helper() -> None:
    """Spot-check `_food_is_allergen` so future changes don't silently
    regress the keyword expansion."""
    print("\n[test] _food_is_allergen keyword expansion")
    assert _food_is_allergen("almond butter", ["tree_nuts"])
    assert _food_is_allergen("whole milk", ["dairy"])
    assert not _food_is_allergen("chicken breast", ["tree_nuts", "dairy"])
    _ok("allergen keyword matcher covers expected cases")


# ─── 4. Variety across consecutive days ─────────────────────────────────────


def test_variety_day_n_and_n_plus_one_differ() -> None:
    """For any pantry with enough breadth, day 0 and day 1 of the output
    should not have an identical meal list (food_refs must differ on at
    least one slot)."""
    print("\n[test] day N and day N+1 meals differ")
    pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "almonds", "greek yogurt", "banana",
        "salmon", "sweet potato", "spinach", "avocado", "whey",
    ]
    req = _make_plan_request(goal="muscle_gain", mealsPerDay=3, mealVariety=3)
    templates, _, _ = generate_deterministic_skeleton(req, 3, pantry)
    assert len(templates) == 3
    for i in range(len(templates) - 1):
        sig_a = [tuple(sorted(m.food_refs)) for m in templates[i].meals]
        sig_b = [tuple(sorted(m.food_refs)) for m in templates[i + 1].meals]
        assert sig_a != sig_b, f"day {i} and {i+1} produced identical meal signatures"
    _ok("consecutive days differ in at least one meal")


# ─── 5. Pantry-poor fallback — no crash ─────────────────────────────────────


def test_pantry_poor_user_gets_meals_no_crash() -> None:
    """User with only 2 foods should still produce meal skeletons with
    valid food_refs. Everything else in the pipeline handles the low
    variety downstream."""
    print("\n[test] pantry-poor user → fallback meals, no crash")
    pantry = ["eggs", "oats"]
    req = _make_plan_request(goal="general_health", mealsPerDay=3, mealVariety=1)
    templates, _, _ = generate_deterministic_skeleton(req, 1, pantry)
    assert len(templates) == 1
    assert len(templates[0].meals) == 3
    for meal in templates[0].meals:
        assert meal.food_refs, f"meal '{meal.name}' emitted with zero food_refs"
        for ref in meal.food_refs:
            assert ref in pantry, f"unknown food ref '{ref}' not in pantry"
    _ok("3 meals built from 2-food pantry without crashing")


def test_empty_pantry_returns_empty_templates() -> None:
    """Edge case: zero pantry foods → empty meals in every template. No
    crash, no exception, safe to ship downstream."""
    print("\n[test] empty pantry → empty templates, no crash")
    req = _make_plan_request(mealsPerDay=3, mealVariety=2)
    templates, note, supps = generate_deterministic_skeleton(req, 2, [])
    assert len(templates) == 2
    assert all(not tpl.meals for tpl in templates)
    assert note == ""
    assert supps == []
    _ok("empty pantry handled gracefully")


# ─── 6. Vegan dietary preference → no animal foods ──────────────────────────


def test_vegan_preference_filters_animal_foods() -> None:
    """`dietaryPreference='vegan'` must strip every meat / dairy / egg /
    honey food before the skeleton resolver picks anything."""
    print("\n[test] vegan preference → no animal foods")
    pantry = [
        "chicken breast", "beef", "salmon", "eggs", "greek yogurt",
        "cheddar", "whey", "butter",
        "tofu", "lentils", "quinoa", "brown rice", "broccoli", "spinach",
        "olive oil", "almonds", "peanut butter", "banana",
    ]
    req = _make_plan_request(
        goal="maintain", mealsPerDay=3, mealVariety=3,
        dietaryPreference="vegan",
    )
    templates, _, _ = generate_deterministic_skeleton(req, 3, pantry)
    animal_foods = {
        "chicken breast", "beef", "salmon", "eggs",
        "greek yogurt", "cheddar", "whey", "butter",
    }
    for tpl in templates:
        for meal in tpl.meals:
            for ref in meal.food_refs:
                assert ref.lower() not in animal_foods, (
                    f"vegan user received animal food '{ref}' in meal '{meal.name}'"
                )
    _ok("no animal foods across 3 days of vegan output")


def test_diet_disallows_helper() -> None:
    """Unit-level sanity on `_diet_disallows` — covers both the vegan
    (strictest) and vegetarian (meat-only) rules."""
    print("\n[test] _diet_disallows helper rules")
    assert _diet_disallows("chicken breast", "vegan")
    assert _diet_disallows("greek yogurt", "vegan")
    assert _diet_disallows("eggs", "vegan")
    assert not _diet_disallows("tofu", "vegan")
    assert _diet_disallows("chicken breast", "vegetarian")
    assert not _diet_disallows("eggs", "vegetarian")
    assert not _diet_disallows("greek yogurt", "vegetarian")
    assert not _diet_disallows("chicken breast", None)
    assert not _diet_disallows("chicken breast", "pescatarian")
    _ok("diet rules behave for vegan/vegetarian/pescatarian/None")


def test_filter_pantry_applies_both_gates() -> None:
    """`_filter_pantry` must apply diet AND allergen gates together."""
    print("\n[test] _filter_pantry combines diet + allergen gates")
    pantry = ["chicken breast", "tofu", "almonds", "brown rice"]
    out = _filter_pantry(pantry, "vegan", ["tree_nuts"])
    assert "chicken breast" not in out
    assert "almonds" not in out
    assert "tofu" in out
    assert "brown rice" in out
    _ok("vegan + tree_nuts filter leaves tofu + brown rice")


def test_incompatible_pantry_does_not_fall_back_to_blocked_foods() -> None:
    """If diet/allergy filtering removes every food, the deterministic
    skeleton must not silently repopulate meals from the raw blocked pantry."""
    print("\n[test] incompatible pantry does not fall back to blocked foods")
    pantry = ["whole milk", "cheddar", "eggs"]
    req = _make_plan_request(
        goal="maintain",
        mealsPerDay=3,
        mealVariety=1,
        dietaryPreference="vegan",
        allergies=["dairy"],
    )
    templates, _, _ = generate_deterministic_skeleton(req, 1, pantry)
    blocked = {p.lower() for p in pantry}
    for meal in templates[0].meals:
        assert not any(ref.lower() in blocked for ref in meal.food_refs), (
            f"blocked pantry food leaked into meal '{meal.name}': {meal.food_refs}"
        )
    _ok("blocked raw pantry was not reused after filtering emptied it")


def test_assembler_surfaces_no_compatible_foods_validation() -> None:
    """The full assembler should return an explicit validation sidecar when
    no selected foods survive diet/allergy filtering."""
    print("\n[test] assembler surfaces no-compatible-foods validation")
    pantry = ["whole milk", "cheddar", "eggs"]
    req = _make_plan_request(
        goal="maintain",
        mealsPerDay=3,
        mealVariety=2,
        dietaryPreference="vegan",
        allergies=["dairy"],
    )
    out = assemble_nutrition_response(
        None, req, (2100, 150, 250, 70), 2, pantry, {},
    )
    plans = out.get("nutrition_plans") or []
    assert plans, "expected nutrition templates to be returned"
    validation = plans[0].get("nutrition_validation") or {}
    codes = {w.get("code") for w in validation.get("warnings") or []}
    assert validation.get("ok") is False, f"validation should be false: {validation}"
    assert "no_compatible_foods" in codes, f"missing warning codes: {codes}"
    for meal in plans[0].get("meals") or []:
        assert meal.get("items") == [], f"blocked items should not be assembled: {meal}"
    _ok("nutrition_validation reports no_compatible_foods and emits no blocked items")


def test_assembler_uses_default_pantry_when_foods_are_skipped() -> None:
    """Skipping the optional foods step should still produce real meals."""
    print("\n[test] assembler uses default pantry when foods are skipped")
    req = _make_plan_request(
        goal="fat_loss",
        mealsPerDay=3,
        mealVariety=2,
    )
    out = assemble_nutrition_response(
        None,
        req,
        (1900, 150, 190, 60),
        2,
        [],
        _enriched_payload_for(list(DEFAULT_NUTRITION_PANTRY)),
    )
    plans = out.get("nutrition_plans") or []
    assert len(plans) == 2, f"expected 2 templates, got {len(plans)}"
    validation = plans[0].get("nutrition_validation") or {}
    codes = {w.get("code") for w in validation.get("warnings") or []}
    assert validation.get("ok") is True, validation
    assert "default_pantry_used" in codes, f"missing default pantry warning: {codes}"
    assert validation.get("allowed_foods_count") == 0, validation
    assert validation.get("compatible_foods_count", 0) > 0, validation
    for plan in plans:
        meals = plan.get("meals") or []
        assert len(meals) == 3, f"expected 3 meals, got {len(meals)}"
        assert all(m.get("items") for m in meals), meals
    _ok("skipped foods emits full meal templates from defaults")


def test_assembler_merges_custom_foods_into_generation_pantry() -> None:
    """Custom foods should be eligible for generated plans even when they
    live in the user's custom library instead of the seed foods picker."""
    print("\n[test] assembler merges custom foods into generation pantry")
    custom_name = "Kirkland Whey Protein"
    req = _make_plan_request(
        goal="muscle_gain",
        mealsPerDay=3,
        mealVariety=2,
        foodsAvailable=[],
        customFoodNames=[custom_name],
    )
    generation_foods = food_names_for_generation(req, req.foodsAvailable)
    assert custom_name in generation_foods, generation_foods

    enriched = _enriched_payload_for(list(DEFAULT_NUTRITION_PANTRY))
    enriched["foods"].append({
        "name": custom_name,
        "serving": "1 scoop",
        "calories": 130,
        "protein": 25,
        "carbs": 3,
        "fat": 2,
        "fiber": 1,
        "sugar": 1,
        "sodium": 120,
    })
    out = assemble_nutrition_response(
        None,
        req,
        (2600, 180, 290, 80),
        2,
        req.foodsAvailable,
        enriched,
    )
    item_names = [
        str(item.get("name") or "")
        for plan in (out.get("nutrition_plans") or [])
        for meal in (plan.get("meals") or [])
        for item in (meal.get("items") or [])
    ]
    assert custom_name in item_names, item_names
    _ok("custom food names are eligible and selected in generated meals")


# ─── 7. mealsPerDay in {5, 7} ───────────────────────────────────────────────


def test_meals_per_day_5() -> None:
    """mealsPerDay=5 → template emits exactly 5 meals, indices 0..4."""
    print("\n[test] mealsPerDay=5 produces 5 meals")
    pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "whey", "banana", "almonds", "greek yogurt",
    ]
    req = _make_plan_request(mealsPerDay=5, mealVariety=1)
    templates, _, _ = generate_deterministic_skeleton(req, 1, pantry)
    assert len(templates) == 1
    assert len(templates[0].meals) == 5
    assert [m.index for m in templates[0].meals] == [0, 1, 2, 3, 4]
    _ok("5 meals emitted with indices 0..4")


def test_meals_per_day_7() -> None:
    """mealsPerDay=7 → template emits exactly 7 meals, indices 0..6."""
    print("\n[test] mealsPerDay=7 produces 7 meals")
    pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "whey", "banana", "almonds", "greek yogurt",
        "cottage cheese", "apple",
    ]
    req = _make_plan_request(mealsPerDay=7, mealVariety=1)
    templates, _, _ = generate_deterministic_skeleton(req, 1, pantry)
    assert len(templates) == 1
    assert len(templates[0].meals) == 7
    assert [m.index for m in templates[0].meals] == list(range(7))
    _ok("7 meals emitted with indices 0..6")


# ─── 8. Determinism — same input → same output ──────────────────────────────


def test_determinism_identical_inputs_produce_identical_output() -> None:
    """Same PlanRequest + pantry twice → byte-equal template signatures.
    Protects against someone accidentally adding random or time-based
    logic to the generator."""
    print("\n[test] identical inputs → identical output")
    pantry = [
        "chicken breast", "brown rice", "broccoli", "olive oil",
        "eggs", "oats", "almonds", "greek yogurt", "salmon", "sweet potato",
    ]
    req_a = _make_plan_request(mealsPerDay=3, mealVariety=3)
    req_b = _make_plan_request(mealsPerDay=3, mealVariety=3)
    out_a, _, _ = generate_deterministic_skeleton(req_a, 3, pantry)
    out_b, _, _ = generate_deterministic_skeleton(req_b, 3, pantry)
    for i in range(3):
        sig_a = [tuple(m.food_refs) for m in out_a[i].meals]
        sig_b = [tuple(m.food_refs) for m in out_b[i].meals]
        assert sig_a == sig_b, f"day {i} diverged: {sig_a} vs {sig_b}"
    _ok("identical inputs produced identical output across 3 days")


# ─── Main ───────────────────────────────────────────────────────────────────


cases = [
    test_hits_calorie_target_within_8_percent,
    test_hits_protein_target_within_5_percent_muscle_gain,
    test_allergen_filter_blocks_tree_nuts,
    test_food_is_allergen_helper,
    test_variety_day_n_and_n_plus_one_differ,
    test_pantry_poor_user_gets_meals_no_crash,
    test_empty_pantry_returns_empty_templates,
    test_vegan_preference_filters_animal_foods,
    test_diet_disallows_helper,
    test_filter_pantry_applies_both_gates,
    test_incompatible_pantry_does_not_fall_back_to_blocked_foods,
    test_assembler_surfaces_no_compatible_foods_validation,
    test_assembler_uses_default_pantry_when_foods_are_skipped,
    test_assembler_merges_custom_foods_into_generation_pantry,
    test_meals_per_day_5,
    test_meals_per_day_7,
    test_determinism_identical_inputs_produce_identical_output,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Deterministic meal-skeleton tests")
    print("=" * 60)
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    print()
    print("=" * 60)
    print(f"  {len(cases) - failures}/{len(cases)} passed")
    print("=" * 60)
    raise SystemExit(0 if failures == 0 else 1)
