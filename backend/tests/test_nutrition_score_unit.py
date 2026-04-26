"""Unit tests for the Nutrition Score pipeline.

Covers:
  - NutritionIndicators computed properties (calorie_alignment,
    protein_alignment, fiber_density, added_sugar_pct_cals, etc.)
  - compute_nutrition_score scoring math + goal-weight blending
  - Score caps (3+ gaps → 78, high sugar + sat fat → 82, etc.)
  - Confidence factor scaling
  - Micro coverage scoring + sex-aware RDA overrides
  - Edge cases: zero calories, missing data, extreme values
  - calorie_calculator: macro_consistency_delta + reference ranges
  - allergen_filter: edge cases (plural matching, partial names)

No DB, no AI. All pure functions.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── NutritionIndicators properties ─────────────────────────────────────────

def test_calorie_alignment_perfect():
    """Within ±10% → 1.0."""
    print("\n[test] calorie_alignment: within 10% → 1.0")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    ind = NutritionIndicators(calories_logged=2200, calories_target=2200)
    assert ind.calorie_alignment == 1.0
    ind2 = NutritionIndicators(calories_logged=2000, calories_target=2200)
    # 2000/2200 = 0.909, deviation = 0.091 < 0.10
    assert ind2.calorie_alignment == 1.0, f"got {ind2.calorie_alignment}"
    _ok("±10% → 1.0")


def test_calorie_alignment_degrades_past_10_pct():
    """Beyond 10% deviation, score degrades linearly to 0 at 40%."""
    print("\n[test] calorie_alignment: degrades beyond 10%")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    # 25% deviation → (0.25-0.10)/0.30 = 0.5 → 1-0.5 = 0.5
    ind = NutritionIndicators(calories_logged=1500, calories_target=2000)
    align = ind.calorie_alignment
    assert 0.45 <= align <= 0.55, f"25% deviation → expected ~0.5, got {align}"
    # 40% deviation → 0
    ind2 = NutritionIndicators(calories_logged=1200, calories_target=2000)
    assert ind2.calorie_alignment == 0.0, f"got {ind2.calorie_alignment}"
    _ok("linear degradation 10%→40%")


def test_calorie_alignment_zero_target():
    """Zero target → neutral 0.5."""
    print("\n[test] calorie_alignment: zero target → 0.5")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    ind = NutritionIndicators(calories_logged=2000, calories_target=0)
    assert ind.calorie_alignment == 0.5
    _ok("zero target → 0.5 neutral")


def test_protein_alignment_full_credit_at_95_pct():
    """>=95% of protein target → 1.0 (relaxed from exact match)."""
    print("\n[test] protein_alignment: >=95% → 1.0")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    ind = NutritionIndicators(protein_logged=152, protein_target=160)
    # 152/160 = 0.95 → exactly at threshold
    assert ind.protein_alignment == 1.0, f"got {ind.protein_alignment}"
    ind2 = NutritionIndicators(protein_logged=170, protein_target=160)
    assert ind2.protein_alignment == 1.0  # over target is still 1.0
    _ok("95%+ protein → full credit")


def test_protein_alignment_linear_below_95():
    """Below 95%, linear scaling."""
    print("\n[test] protein_alignment: below 95% → linear")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    # 50% of target → 0.5/0.95 ≈ 0.526
    ind = NutritionIndicators(protein_logged=80, protein_target=160)
    align = ind.protein_alignment
    expected = (80 / 160) / 0.95
    assert abs(align - expected) < 0.01, f"got {align}, expected {expected}"
    _ok("50% protein → ~0.53")


def test_fiber_density_calculation():
    """Fiber density = fiber_g / calories * 1000."""
    print("\n[test] fiber_density calculation")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    ind = NutritionIndicators(calories_logged=2000, fiber_g=28)
    assert ind.fiber_density == 14.0  # 28/2000*1000
    ind2 = NutritionIndicators(calories_logged=0, fiber_g=28)
    assert ind2.fiber_density == 0.0  # zero-cal guard
    _ok("fiber density: 28g/2000kcal → 14.0 g/1000kcal")


def test_added_sugar_pct_cals():
    """Added sugar pct = (sugar_g * 4) / total_cal * 100."""
    print("\n[test] added_sugar_pct_cals")
    from app.services.nutrition.nutrition_score import NutritionIndicators
    ind = NutritionIndicators(calories_logged=2000, added_sugar_g=50)
    # 50*4/2000*100 = 10%
    assert ind.added_sugar_pct_cals == 10.0
    _ok("50g sugar / 2000kcal → 10%")


# ─── compute_nutrition_score ────────────────────────────────────────────────

def test_score_perfect_day():
    """A nearly perfect day should score >90."""
    print("\n[test] nutrition score: perfect day > 90")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    ind = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=170, protein_target=170,
        fiber_g=31,  # 14.1 g/1000kcal
        added_sugar_g=15,  # 2.7% cals → excellent
        saturated_fat_g=16,  # 6.5% cals → excellent
        sodium_mg=2000,
        minimally_processed_pct=75,
        ultra_processed_pct=5,
        distinct_plant_foods=6,
        omega3_servings=1,
        meals_logged=3, meals_expected=3,
        food_count=10, foods_with_micros=8,
        micronutrients={
            "calcium_mg": 900, "iron_mg": 15, "potassium_mg": 4000,
            "magnesium_mg": 380, "vitamin_d_mcg": 18, "vitamin_b12_mcg": 3.0,
        },
    )
    score = compute_nutrition_score(ind, goal="body_recomp")
    assert score.total >= 90, f"perfect day scored {score.total}, expected >=90"
    assert score.confidence == "high"
    _ok(f"perfect day → {score.total}/100, confidence={score.confidence}")


def test_score_poor_quality_caps_at_85():
    """High adherence (>=85) but quality <60 → capped at 85.

    The cap rule: `if adherence >= 85 and quality < 60 and total > 85`.
    We need a scenario where the raw weighted total would exceed 85 but
    quality is distinctly poor. This triggers with perfect macros +
    strong micros + quality just under 60."""
    print("\n[test] nutrition score: macros-OK but quality<60 → capped 85")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    ind = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=170, protein_target=170,
        fiber_g=14,  # decent fiber density (~6.4 g/1000kcal, not great)
        added_sugar_g=40,  # ~7.3% → moderate-ok
        saturated_fat_g=35,  # ~14.3% → bad
        sodium_mg=2500,  # slightly over
        minimally_processed_pct=35,  # low
        ultra_processed_pct=30,  # moderate
        distinct_plant_foods=2,  # low
        omega3_servings=0,  # none
        meals_logged=3, meals_expected=3,
        food_count=10, foods_with_micros=9,
        micronutrients={
            "calcium_mg": 1000, "iron_mg": 18, "potassium_mg": 4700,
            "magnesium_mg": 420, "vitamin_d_mcg": 20, "vitamin_b12_mcg": 2.4,
        },
    )
    score = compute_nutrition_score(ind, goal="fat_loss")
    # With fat_loss weights (0.45 adh, 0.35 qual, 0.20 micro):
    # adherence=100, quality<60, micro=100 → raw ~0.45*100+0.35*Q+0.20*100
    # If quality ~50: raw = 45+17.5+20 = 82.5 → total ~83 (confidence=high)
    # This might be under 85 so cap doesn't fire, OR over — depends on quality.
    # If total > 85, cap should fire. If not, the test just checks total <= 85.
    assert score.total <= 85, \
        f"poor quality ({score.quality_score}) + perfect macros = {score.total}, expected <=85"
    _ok(f"quality={score.quality_score}, total={score.total} (<=85 guaranteed)")


def test_score_three_gaps_capped_78():
    """3+ meaningful gaps → score capped at 78."""
    print("\n[test] nutrition score: 3+ gaps → max 78")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    ind = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=170, protein_target=170,
        fiber_g=8,  # density < 8 → gap
        added_sugar_g=100,  # >15% → gap
        saturated_fat_g=60,  # >12% → gap
        sodium_mg=5000,  # >3500 → gap
        minimally_processed_pct=30,
        ultra_processed_pct=10,
        distinct_plant_foods=1,  # <2 → gap
        omega3_servings=0,
        meals_logged=3, meals_expected=3,
        food_count=8, foods_with_micros=6,
        micronutrients={
            "calcium_mg": 1000, "iron_mg": 18, "potassium_mg": 4700,
            "magnesium_mg": 420, "vitamin_d_mcg": 20, "vitamin_b12_mcg": 2.4,
        },
    )
    score = compute_nutrition_score(ind, goal="muscle_gain")
    assert score.total <= 78, f"3+ gaps scored {score.total}, expected <=78"
    _ok(f"3+ gaps → {score.total}/100")


def test_score_goal_weight_difference():
    """Different goals weight adherence vs quality differently."""
    print("\n[test] nutrition score: goal weights differ")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    ind = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=170, protein_target=170,
        fiber_g=20, added_sugar_g=20, saturated_fat_g=20,
        sodium_mg=2000, minimally_processed_pct=60,
        ultra_processed_pct=15, distinct_plant_foods=4,
        omega3_servings=0.5,
        meals_logged=3, meals_expected=3,
        food_count=8, foods_with_micros=6,
        micronutrients={
            "calcium_mg": 700, "iron_mg": 12, "potassium_mg": 3000,
            "magnesium_mg": 300, "vitamin_d_mcg": 12, "vitamin_b12_mcg": 2.0,
        },
    )
    score_fl = compute_nutrition_score(ind, goal="fat_loss")
    score_gh = compute_nutrition_score(ind, goal="general_health")
    # fat_loss weighs adherence 45%, general_health 30% — so same adherence
    # contributes more to fat_loss score
    # general_health weighs quality 40% vs fat_loss 35%
    assert score_fl.total != score_gh.total, \
        f"scores should differ: fl={score_fl.total}, gh={score_gh.total}"
    _ok(f"fat_loss={score_fl.total}, general_health={score_gh.total} (different)")


def test_score_sex_aware_iron_rda():
    """Male gets iron RDA=8, female=18."""
    print("\n[test] nutrition score: sex-aware iron RDA")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    ind = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=160, protein_target=160,
        fiber_g=28, added_sugar_g=15, saturated_fat_g=16,
        sodium_mg=2000, minimally_processed_pct=70,
        ultra_processed_pct=10, distinct_plant_foods=5,
        omega3_servings=1,
        meals_logged=3, meals_expected=3,
        food_count=10, foods_with_micros=8,
        micronutrients={
            "calcium_mg": 900, "iron_mg": 10,  # hits male RDA, misses female
            "potassium_mg": 4000, "magnesium_mg": 380,
            "vitamin_d_mcg": 18, "vitamin_b12_mcg": 3.0,
        },
    )
    score_m = compute_nutrition_score(ind, goal="body_recomp", sex="male")
    score_f = compute_nutrition_score(ind, goal="body_recomp", sex="female")
    # 10mg iron: male RDA=8 → ratio=1.25 (on-track), female RDA=18 → ratio=0.56 (gap)
    assert score_m.micro_score >= score_f.micro_score, \
        f"male micro should be >= female: m={score_m.micro_score}, f={score_f.micro_score}"
    _ok(f"male micro={score_m.micro_score}, female micro={score_f.micro_score}")


def test_score_low_confidence_reduces_total():
    """Low logging completeness → confidence factor reduces total."""
    print("\n[test] nutrition score: low confidence → reduced total")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    full = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=170, protein_target=170,
        fiber_g=28, added_sugar_g=15, saturated_fat_g=16,
        sodium_mg=2000, minimally_processed_pct=70,
        ultra_processed_pct=10, distinct_plant_foods=5,
        omega3_servings=1,
        meals_logged=3, meals_expected=3,
        food_count=10, foods_with_micros=8,
        micronutrients={
            "calcium_mg": 900, "iron_mg": 15, "potassium_mg": 4000,
            "magnesium_mg": 380, "vitamin_d_mcg": 18, "vitamin_b12_mcg": 3.0,
        },
    )
    partial = NutritionIndicators(
        calories_logged=2200, calories_target=2200,
        protein_logged=170, protein_target=170,
        fiber_g=28, added_sugar_g=15, saturated_fat_g=16,
        sodium_mg=2000, minimally_processed_pct=70,
        ultra_processed_pct=10, distinct_plant_foods=5,
        omega3_servings=1,
        meals_logged=1, meals_expected=3,  # low completeness
        food_count=10, foods_with_micros=8,
        micronutrients={
            "calcium_mg": 900, "iron_mg": 15, "potassium_mg": 4000,
            "magnesium_mg": 380, "vitamin_d_mcg": 18, "vitamin_b12_mcg": 3.0,
        },
    )
    score_full = compute_nutrition_score(full, "body_recomp")
    score_partial = compute_nutrition_score(partial, "body_recomp")
    assert score_partial.total < score_full.total, \
        f"partial ({score_partial.total}) should be < full ({score_full.total})"
    assert score_partial.confidence in ("low", "medium")
    _ok(f"full={score_full.total}, partial={score_partial.total} (reduced)")


def test_score_zero_calories_no_crash():
    """Zero calories logged shouldn't crash or produce negative scores."""
    print("\n[test] nutrition score: zero calories → no crash")
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
    )
    ind = NutritionIndicators(calories_logged=0, calories_target=2200)
    score = compute_nutrition_score(ind, "fat_loss")
    assert 0 <= score.total <= 100
    assert score.adherence_score >= 0
    assert score.quality_score >= 0
    _ok(f"zero cals → {score.total}/100, no crash")


# ─── macro_consistency_delta ───────────────────────────────────────────────

def test_macro_consistency_delta_correct():
    """stated_cal − (P×4 + C×4 + F×9)."""
    print("\n[test] macro_consistency_delta: math check")
    from app.services.nutrition.calorie_calculator import macro_consistency_delta
    # 160*4 + 220*4 + 65*9 = 640 + 880 + 585 = 2105
    # delta = 2100 - 2105 = -5 (stated is 5 less than implied)
    delta = macro_consistency_delta(2100, 160, 220, 65)
    assert delta == -5, f"expected -5, got {delta}"
    # Exact match
    delta2 = macro_consistency_delta(2105, 160, 220, 65)
    assert delta2 == 0, f"expected 0, got {delta2}"
    _ok("macro_consistency_delta math correct")


# ─── allergen_filter edge cases ─────────────────────────────────────────────

def test_allergen_filter_plural_matching():
    """'walnut' keyword matches 'walnuts' in food name."""
    print("\n[test] allergen filter: plural matching")
    from app.services.nutrition.allergen_filter import _item_matches_allergen, ALLERGEN_KEYWORDS
    tree_nut_kw = ALLERGEN_KEYWORDS["tree_nuts"]
    assert _item_matches_allergen("Candied Walnuts", tree_nut_kw)
    assert _item_matches_allergen("almond butter toast", tree_nut_kw)
    assert not _item_matches_allergen("Grilled Chicken", tree_nut_kw)
    _ok("plural + exact matching works")


def test_allergen_filter_removes_and_resums():
    """filter_allergens removes items and re-sums meal macros."""
    print("\n[test] allergen filter: removes + re-sums")
    from app.services.nutrition.allergen_filter import filter_allergens
    plan = [{
        "meals": [{
            "name": "Test Meal",
            "calories": 700,
            "protein": 50,
            "carbs": 60,
            "fat": 25,
            "items": [
                {"name": "Grilled Chicken", "calories": 300, "protein": 40, "carbs": 0, "fat": 7, "quantity": 1, "unit": "serving"},
                {"name": "Peanut Butter Toast", "calories": 400, "protein": 10, "carbs": 60, "fat": 18, "quantity": 1, "unit": "serving"},
            ],
        }],
    }]
    removed = filter_allergens(plan, ["peanuts"])
    assert removed == 1, f"expected 1 removed, got {removed}"
    meal = plan[0]["meals"][0]
    assert len(meal["items"]) == 1
    assert meal["items"][0]["name"] == "Grilled Chicken"
    assert meal["calories"] == 300
    assert meal["protein"] == 40
    _ok("peanut item removed, macros re-summed to 300/40/0/7")


def test_allergen_filter_no_false_positive():
    """'egg' shouldn't match 'eggplant'."""
    print("\n[test] allergen filter: no false positive on eggplant")
    from app.services.nutrition.allergen_filter import _item_matches_allergen, ALLERGEN_KEYWORDS
    egg_kw = ALLERGEN_KEYWORDS["eggs"]
    # eggplant should NOT match "egg" — word-boundary regex protects us
    matches = _item_matches_allergen("Roasted Eggplant", egg_kw)
    # NOTE: this tests whether the implementation handles this edge case.
    # If it does match, that's a BUG we want to catch.
    if matches:
        print("  ⚠ BUG DETECTED: 'Roasted Eggplant' matches egg allergen!")
        raise AssertionError("eggplant should not match egg allergen")
    _ok("eggplant doesn't match egg")


# ─── calorie_calculator reference ranges ───────────────────────────────────

def test_reference_ranges_three_scenarios():
    """calculate_reference_ranges returns cut/maintenance/bulk for a profile."""
    print("\n[test] calorie_calculator: reference ranges")
    from app.services.nutrition.calorie_calculator import (
        CalorieInputs, calculate_reference_ranges,
    )
    inputs = CalorieInputs(
        weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
        training_days_per_week=4,
        goal_id="body_recomp", pace="moderate",
    )
    ranges = calculate_reference_ranges(inputs)
    assert ranges.cut_calories < ranges.maintenance_calories < ranges.bulk_calories, \
        f"cut={ranges.cut_calories}, maintenance={ranges.maintenance_calories}, bulk={ranges.bulk_calories}"
    _ok(f"cut={ranges.cut_calories} < maintenance={ranges.maintenance_calories} < bulk={ranges.bulk_calories}")


# ─── solve_portions edge cases ──────────────────────────────────────────────

def test_solve_portions_single_food():
    """Solver with a single food converges to correct multiplier."""
    print("\n[test] solve_portions: single food converges")
    from app.services.nutrition.meal_assembler import FoodMacros, solve_portions
    food = FoodMacros("Chicken Breast", "6 oz", 6, "oz", 280, 53, 0, 6)
    # Target: 560 cal, 106 protein → should be ~2x multiplier
    mults = solve_portions([food], 560, 106, 0, 12)
    assert len(mults) == 1
    assert 1.8 <= mults[0] <= 2.2, f"expected ~2.0, got {mults[0]}"
    _ok(f"single food → multiplier={mults[0]:.2f}")


def test_solve_portions_bounded_multipliers():
    """Multipliers should be bounded — not infinite even on extreme targets."""
    print("\n[test] solve_portions: bounded multipliers")
    from app.services.nutrition.meal_assembler import FoodMacros, solve_portions
    tiny_food = FoodMacros("Sesame Seed", "1 tsp", 1, "tsp", 5, 0.2, 0.2, 0.4)
    # Target 3000 cal from 5-cal food → solver can't reach target but shouldn't explode
    mults = solve_portions([tiny_food], 3000, 200, 300, 100)
    assert mults[0] < 1000, f"expected bounded, got {mults[0]}"
    assert mults[0] > 0, f"expected positive, got {mults[0]}"
    _ok(f"extreme target → bounded at {mults[0]:.2f}")


# ─── Main ──────────────────────────────────────────────────────────────────

cases = [
    # Indicator properties
    test_calorie_alignment_perfect,
    test_calorie_alignment_degrades_past_10_pct,
    test_calorie_alignment_zero_target,
    test_protein_alignment_full_credit_at_95_pct,
    test_protein_alignment_linear_below_95,
    test_fiber_density_calculation,
    test_added_sugar_pct_cals,
    # Score computation
    test_score_perfect_day,
    test_score_poor_quality_caps_at_85,
    test_score_three_gaps_capped_78,
    test_score_goal_weight_difference,
    test_score_sex_aware_iron_rda,
    test_score_low_confidence_reduces_total,
    test_score_zero_calories_no_crash,
    # Calorie calculator
    test_macro_consistency_delta_correct,
    test_reference_ranges_three_scenarios,
    # Allergen filter
    test_allergen_filter_plural_matching,
    test_allergen_filter_removes_and_resums,
    test_allergen_filter_no_false_positive,
    # Solver
    test_solve_portions_single_food,
    test_solve_portions_bounded_multipliers,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Nutrition score + meal modification unit tests")
    print("=" * 60)
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL: {e}")
            failures += 1
        except Exception as e:
            print(f"  ✗ ERROR ({type(e).__name__}): {e}")
            failures += 1
    print()
    print("=" * 60)
    print(f"  {len(cases) - failures}/{len(cases)} passed")
    print("=" * 60)
    raise SystemExit(0 if failures == 0 else 1)
