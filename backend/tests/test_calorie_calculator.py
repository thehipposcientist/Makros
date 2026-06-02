"""
Sanity tests for calorie_calculator.py — NO external deps, no pytest.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m app.services.test_calorie_calculator

Purpose: give you concrete "170 lb male fat-loss moderate → X cal / Y protein"
numbers to eyeball before trusting the calculator in production. Every case
below describes WHY we expect the number so you can check our math.

If any of these assertions fail after a code change, stop and look at the
debug fields in the CalorieTargets output — the bmr / tdee / goal_adjustment
trail will tell you which step diverged.
"""
from __future__ import annotations

from app.services.nutrition.calorie_calculator import (
    CalorieInputs,
    CustomMacroOverrides,
    calculate_reference_ranges,
    compute_targets,
    macro_consistency_delta,
    CALORIES_PER_GRAM_PROTEIN,
    CALORIES_PER_GRAM_CARB,
    CALORIES_PER_GRAM_FAT,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _assert_near(actual: int, expected: int, tolerance: int, label: str) -> None:
    """Assert `actual` is within `tolerance` of `expected`. Prints the full
    comparison on failure so you can see exactly where a drift happened."""
    if abs(actual - expected) > tolerance:
        raise AssertionError(
            f"[{label}] expected {expected} ± {tolerance}, got {actual} "
            f"(diff={actual - expected:+d})"
        )
    print(f"  ✓ {label}: {actual} (expected {expected} ± {tolerance})")


# ─── Test cases ──────────────────────────────────────────────────────────────

def test_male_fat_loss_moderate() -> None:
    """30yo male, 180 lb, 5'10", training 4 days/wk, fat loss moderate.

    Expected chain:
        BMR    = 10*(180/2.205) + 6.25*70*2.54 - 5*30 + 5
               ≈ 10*81.63 + 6.25*177.8 - 150 + 5
               ≈ 816 + 1111 - 150 + 5
               ≈ 1782
        TDEE   = 1782 * 1.55 ≈ 2762
        cut    = 2762 * -15% ≈ -414 → 2348

        Protein = 180 * 1.0 = 180g
        Fat     = max(0.3*180=54, 0.28*2349/9=73) = 73g
        Carbs   ≈ (2349 - 180*4 - 73*9) / 4 = 243g
    """
    print("\n[test] 30yo M, 180lb, 5'10\", 4d/wk, fat_loss, moderate")
    targets = compute_targets(CalorieInputs(
        weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
        training_days_per_week=4,
        goal_id="fat_loss", pace="moderate",
    ))
    _assert_near(targets.bmr,      1782, 10,  "BMR")
    _assert_near(targets.tdee,     2762, 15,  "TDEE")
    _assert_near(targets.calories, 2349, 15,  "calories")
    _assert_near(targets.protein_g, 180, 2,   "protein_g")
    _assert_near(targets.fat_g,      73, 5,   "fat_g")
    _assert_near(targets.carbs_g,   243, 10,  "carbs_g")
    assert targets.bucket_name == "fat_loss"
    assert targets.goal_adjustment_pct == -0.15


def test_body_recomp_moderate() -> None:
    """30yo male, 175 lb, 5'11", training 4 days/wk, body_recomp moderate.

    Moderate recomp = 95% of maintenance. High protein 1.0 g/lb.

    Expected chain:
        BMR    = 10*(175/2.205) + 6.25*71*2.54 - 5*30 + 5
               ≈ 10*79.37 + 6.25*180.34 - 150 + 5
               ≈ 793 + 1127 - 150 + 5
               ≈ 1775
        TDEE   = 1775 * 1.55 ≈ 2751
        recomp = 2751 * 0.95 ≈ 2613

        Protein = 175 * 1.0 = 175g
        Fat     = max(0.3*175=52.5, 0.28*2613/9=81.3) = 81g
        Carbs   ≈ (2613 - 175*4 - 81*9) / 4 = (2613 - 700 - 729) / 4 = 1184/4 ≈ 296g
    """
    print("\n[test] 30yo M, 175lb, 5'11\", 4d/wk, body_recomp, moderate")
    targets = compute_targets(CalorieInputs(
        weight_lbs=175, height_feet=5, height_inches=11,
        age=30, gender="male",
        training_days_per_week=4,
        goal_id="body_recomp", pace="moderate",
    ))
    _assert_near(targets.bmr,       1775, 15, "BMR")
    _assert_near(targets.tdee,      2751, 20, "TDEE")
    _assert_near(targets.calories,  2613, 20, "calories (95% maintenance)")
    _assert_near(targets.protein_g,  175,  3, "protein_g (1.0 g/lb)")
    assert targets.bucket_name == "body_recomp", f"expected body_recomp, got {targets.bucket_name}"
    assert targets.goal_adjustment_pct == -0.05
    # Macro consistency — sum must match stated calories within 10 kcal.
    delta = macro_consistency_delta(
        targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g,
    )
    assert abs(delta) <= 10, f"macro sum inconsistent: delta={delta} kcal"
    print(f"  ✓ macros consistent, delta={delta}")


def test_female_muscle_gain_aggressive() -> None:
    """25yo female, 140 lb, 5'5", training 5 days/wk, muscle gain aggressive.

    Expected chain: aggressive lean bulk now uses +11% of maintenance,
    clamped to the safe surplus band instead of a fixed +375 kcal.
        BMR    = 10*(140/2.205) + 6.25*65*2.54 - 5*25 - 161
               ≈ 635 + 1032 - 125 - 161
               ≈ 1381
        TDEE   = 1381 * 1.55 ≈ 2140
        bulk   = 2140 + 236 ≈ 2376

        Protein = 140 * 1.0 = 140g
        Fat     = max(0.3*140=42, 0.25*2515/9=70) = 70g
        Carbs   ≈ (2515 - 140*4 - 70*9) / 4 ≈ 331g
    """
    print("\n[test] 25yo F, 140lb, 5'5\", 5d/wk, muscle_gain, aggressive")
    targets = compute_targets(CalorieInputs(
        weight_lbs=140, height_feet=5, height_inches=5,
        age=25, gender="female",
        training_days_per_week=5,
        goal_id="muscle_gain", pace="aggressive",
    ))
    _assert_near(targets.bmr,      1381, 10,  "BMR")
    _assert_near(targets.tdee,     2140, 15,  "TDEE")
    _assert_near(targets.calories, 2377, 15,  "calories")
    _assert_near(targets.protein_g, 140, 2,   "protein_g")
    _assert_near(targets.fat_g,      66, 5,   "fat_g")
    _assert_near(targets.carbs_g,   306, 15,  "carbs_g")
    assert targets.bucket_name == "muscle_gain"
    assert targets.goal_adjustment_pct == 0.11


def test_minimum_calorie_floor() -> None:
    """Extreme case — very small user with aggressive cut. Calculator should
    clamp up to MIN_SAFE_CALORIES (1200) rather than return something unsafe.
    """
    print("\n[test] 50yo F, 110lb, 5'0\", 1d/wk, fat_loss, aggressive (MIN FLOOR)")
    targets = compute_targets(CalorieInputs(
        weight_lbs=110, height_feet=5, height_inches=0,
        age=50, gender="female",
        training_days_per_week=1,
        goal_id="fat_loss", pace="aggressive",
    ))
    # Raw TDEE = ~1250*1.2 = 1500; aggressive cut = -750 → 750 cal which
    # is way below safe floor. Calculator should clamp to 1200.
    assert targets.calories >= 1200, f"Safety floor breached: {targets.calories}"
    assert targets.min_calories_enforced, "min_calories_enforced flag not set"
    print(f"  ✓ clamped to {targets.calories} (floor enforced)")


def test_custom_override_pins_value() -> None:
    """Manual override wins over the calculated value. User pins protein to
    200g but leaves everything else on auto."""
    print("\n[test] manual protein override")
    targets = compute_targets(CalorieInputs(
        weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
        training_days_per_week=4,
        goal_id="muscle_gain", pace="moderate",
        custom_overrides=CustomMacroOverrides(protein=200),
    ))
    assert targets.protein_g == 200, f"Override not honored: {targets.protein_g}"
    assert targets.override_applied, "override_applied flag not set"
    print(f"  ✓ protein pinned at 200, override_applied={targets.override_applied}")


def test_reference_ranges_card() -> None:
    """Cut/maintain/bulk preview card — all three numbers should be strictly
    ordered: cut < maintenance < bulk."""
    print("\n[test] cut / maintain / bulk reference card")
    card = calculate_reference_ranges(CalorieInputs(
        weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
        training_days_per_week=4,
        goal_id="muscle_gain", pace="moderate",  # pace ignored for ranges
    ))
    assert card.cut_calories < card.maintenance_calories < card.bulk_calories, (
        f"Ranges not strictly ordered: cut={card.cut_calories} "
        f"maintain={card.maintenance_calories} bulk={card.bulk_calories}"
    )
    print(f"  ✓ cut={card.cut_calories} / maintain={card.maintenance_calories} / bulk={card.bulk_calories}")
    print(f"    protein: cut={card.cut_protein_g}g / maintain={card.maintain_protein_g}g / bulk={card.bulk_protein_g}g")


def test_reference_ranges_match_visible_example() -> None:
    """User-visible example: 215 lb, 6'2", 5 days/week, 60-75 min."""
    print("\n[test] reference ranges visible basis: 215lb, 6'2\", 5d/wk, 60-75 min")
    card = calculate_reference_ranges(CalorieInputs(
        weight_lbs=215, height_feet=6, height_inches=2,
        age=30, gender="male",
        training_days_per_week=5,
        session_minutes=75,
    ))
    assert card.bmr == 2005, f"expected BMR 2005, got {card.bmr}"
    assert card.activity_multiplier == 1.55
    assert card.maintenance_calories == 3108
    assert card.cut_calories == 2642
    assert card.bulk_calories == 3357
    assert card.session_duration_label == "60-75 min"
    assert card.formula == "Mifflin-St Jeor"
    print(f"  ✓ cut={card.cut_calories} / maintain={card.maintenance_calories} / bulk={card.bulk_calories}")


def test_reference_ranges_honor_minimum_floor() -> None:
    """The reference card should not display an unsafe cut target."""
    print("\n[test] reference ranges honor minimum calorie floor")
    card = calculate_reference_ranges(CalorieInputs(
        weight_lbs=110, height_feet=5, height_inches=0,
        age=50, gender="female",
        training_days_per_week=1,
        session_minutes=60,
    ))
    assert card.cut_calories >= 1200, f"unsafe cut target shown: {card.cut_calories}"
    print(f"  ✓ cut floor held at {card.cut_calories}")


# ─── Partial override recalculation ──────────────────────────────────────────
# These tests cover the fix to `step_8_apply_custom_overrides`. The old
# implementation just swapped pinned fields; the new one recomputes the
# non-pinned macros so totals stay internally consistent.


def _base_inputs(**overrides) -> CalorieInputs:
    """Standard profile used by every override test unless told otherwise."""
    defaults = dict(
        weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
        training_days_per_week=4,
        goal_id="muscle_gain", pace="moderate",
    )
    defaults.update(overrides)
    return CalorieInputs(**defaults)


def test_override_calories_only_recomputes_fat_and_carbs() -> None:
    """User pins calories only. Expectation: protein stays on calculated
    value, fat is recomputed from the new calorie total, carbs absorb the
    remainder. The macro sum must equal the new calorie target within
    rounding noise."""
    print("\n[test] override calories only (recomputes fat + carbs)")
    baseline = compute_targets(_base_inputs())
    pinned_cal = baseline.calories - 500  # user wants a deficit
    overridden = compute_targets(_base_inputs(
        custom_overrides=CustomMacroOverrides(calories=pinned_cal),
    ))
    assert overridden.calories == pinned_cal, f"calories not pinned: {overridden.calories}"
    assert overridden.protein_g == baseline.protein_g, (
        f"protein changed when only calories were pinned: "
        f"{baseline.protein_g} → {overridden.protein_g}"
    )
    # Sum must match stated calories within 3 kcal (int rounding tolerance).
    delta = macro_consistency_delta(
        overridden.calories, overridden.protein_g, overridden.carbs_g, overridden.fat_g,
    )
    assert abs(delta) <= 3, f"macro sum inconsistent: delta={delta} kcal"
    assert overridden.override_applied
    assert not overridden.override_inconsistent, (
        f"unexpectedly flagged inconsistent: delta={delta}"
    )
    assert overridden.calculated_calories == baseline.calories
    print(f"  ✓ cal pinned={pinned_cal}, prot={overridden.protein_g}, "
          f"carbs={overridden.carbs_g}, fat={overridden.fat_g}, delta={delta}")


def test_override_protein_only_recomputes_carbs_fat() -> None:
    """Pinning protein keeps the override and lets carbs/fat absorb the
    calorie budget. Protein override must not cascade into calories."""
    print("\n[test] override protein only (recomputes carbs + fat)")
    targets = compute_targets(_base_inputs(
        custom_overrides=CustomMacroOverrides(protein=250),
    ))
    assert targets.protein_g == 250
    # Calories stay on the calculated value.
    assert targets.calculated_calories == targets.calories
    delta = macro_consistency_delta(
        targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g,
    )
    assert abs(delta) <= 3, f"protein-only override drift: {delta}"
    print(f"  ✓ prot pinned=250, cal={targets.calories}, "
          f"carbs={targets.carbs_g}, fat={targets.fat_g}, delta={delta}")


def test_override_fat_only_recomputes_carbs() -> None:
    """Pinning fat keeps it; carbs absorb the leftover calories."""
    print("\n[test] override fat only (recomputes carbs)")
    targets = compute_targets(_base_inputs(
        custom_overrides=CustomMacroOverrides(fat=80),
    ))
    assert targets.fat_g == 80, f"fat not pinned: {targets.fat_g}"
    delta = macro_consistency_delta(
        targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g,
    )
    assert abs(delta) <= 3, f"fat-only override drift: {delta}"
    print(f"  ✓ fat pinned=80, cal={targets.calories}, "
          f"prot={targets.protein_g}, carbs={targets.carbs_g}, delta={delta}")


def test_override_all_four_uses_verbatim() -> None:
    """If the user pins every field, the calculator uses them verbatim and
    flags `override_inconsistent` when the totals don't add up."""
    print("\n[test] override all four (verbatim, inconsistency flagged)")
    # Intentionally inconsistent: 2000 cal but only 1600 kcal in macros.
    targets = compute_targets(_base_inputs(
        custom_overrides=CustomMacroOverrides(
            calories=2000, protein=150, carbs=150, fat=50,
        ),
    ))
    assert targets.calories == 2000
    assert targets.protein_g == 150
    assert targets.carbs_g == 150
    assert targets.fat_g == 50
    delta = macro_consistency_delta(2000, 150, 150, 50)
    assert delta == 2000 - (150 * 4 + 150 * 4 + 50 * 9), "delta formula wrong"
    assert targets.override_inconsistent, (
        f"expected inconsistency flag, got delta={targets.consistency_kcal_delta}"
    )
    print(f"  ✓ pinned verbatim, inconsistency delta={targets.consistency_kcal_delta}")


def test_override_fat_below_floor_flag() -> None:
    """Pinning fat below the 0.3 g/lb physiological floor should preserve
    the user's value but raise the `override_fat_below_floor` diagnostic
    so the UI can warn them."""
    print("\n[test] override fat below floor (diagnostic flagged)")
    targets = compute_targets(_base_inputs(
        weight_lbs=200,
        custom_overrides=CustomMacroOverrides(fat=30),  # 30 < 0.3*200=60
    ))
    assert targets.fat_g == 30
    assert targets.override_fat_below_floor, (
        "expected override_fat_below_floor=True for 30g fat at 200lb"
    )
    print(f"  ✓ fat=30g flagged below floor for 200lb user")


def test_calculated_target_is_internally_consistent() -> None:
    """A plain calculated target (no overrides) should always satisfy the
    consistency check within a handful of kcal. This is a regression
    guard — step 7's fat-floor/carb-floor logic must never leave the
    three macros summing to something wildly different from calories."""
    print("\n[test] calculated targets stay internally consistent")
    for goal in ("fat_loss", "muscle_gain", "body_recomp", "maintain", "strength",
                 "endurance", "athletic_performance", "general_health"):
        targets = compute_targets(_base_inputs(goal_id=goal))
        delta = macro_consistency_delta(
            targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g,
        )
        assert abs(delta) <= 10, f"goal={goal} drift={delta}"
    print(f"  ✓ all 8 sampled buckets consistent within 10 kcal")


def test_moderate_recomp_180_lb_example() -> None:
    """Regression for the user-visible case: 180 lb, 32yo male, 6'0",
    4 day/week balanced recomp should be near 2650 kcal and label the pace
    as balanced rather than "aggressive/conservative" semantics."""
    print("\n[test] 32yo M, 180lb, 6'0\", 4d/wk, body_recomp, moderate")
    targets = compute_targets(CalorieInputs(
        weight_lbs=180, height_feet=6, height_inches=0,
        age=32, gender="male",
        training_days_per_week=4,
        goal_id="body_recomp", pace="moderate",
    ))
    _assert_near(targets.bmr, 1804, 10, "BMR")
    _assert_near(targets.tdee, 2796, 20, "TDEE")
    _assert_near(targets.calories, 2656, 20, "calories")
    _assert_near(targets.protein_g, 180, 2, "protein_g")
    assert targets.goal_adjustment_kcal == -140
    assert targets.goal_pace_label == "balanced"
    assert 0.25 <= (targets.fat_percent or 0) <= 0.30
    assert targets.carbs_g > 0
    print(f"  ✓ recomp kcal={targets.calories}, P/C/F={targets.protein_g}/{targets.carbs_g}/{targets.fat_g}")


def test_fat_loss_adjustment_scales_by_tdee() -> None:
    print("\n[test] fat-loss adjustment scales by TDEE")
    small = compute_targets(CalorieInputs(
        weight_lbs=130, height_feet=5, height_inches=4,
        age=35, gender="female", training_days_per_week=2,
        goal_id="fat_loss", pace="moderate",
    ))
    large = compute_targets(CalorieInputs(
        weight_lbs=240, height_feet=6, height_inches=2,
        age=35, gender="male", training_days_per_week=5,
        goal_id="fat_loss", pace="moderate",
    ))
    assert small.goal_adjustment_kcal != large.goal_adjustment_kcal
    assert small.goal_adjustment_kcal <= -250
    assert large.goal_adjustment_kcal < small.goal_adjustment_kcal
    print(f"  ✓ small delta={small.goal_adjustment_kcal}, large delta={large.goal_adjustment_kcal}")


def test_lean_bulk_adjustment_scales_by_tdee() -> None:
    print("\n[test] lean-bulk adjustment scales by TDEE")
    small = compute_targets(CalorieInputs(
        weight_lbs=130, height_feet=5, height_inches=4,
        age=35, gender="female", training_days_per_week=2,
        goal_id="muscle_gain", pace="moderate",
    ))
    large = compute_targets(CalorieInputs(
        weight_lbs=240, height_feet=6, height_inches=2,
        age=35, gender="male", training_days_per_week=5,
        goal_id="muscle_gain", pace="moderate",
    ))
    assert small.goal_adjustment_kcal != large.goal_adjustment_kcal
    assert 150 <= small.goal_adjustment_kcal <= 500
    assert large.goal_adjustment_kcal > small.goal_adjustment_kcal
    print(f"  ✓ small delta={small.goal_adjustment_kcal}, large delta={large.goal_adjustment_kcal}")


def test_overweight_fat_loss_uses_adjusted_protein_basis() -> None:
    print("\n[test] overweight fat-loss protein basis is adjusted")
    targets = compute_targets(CalorieInputs(
        weight_lbs=300, height_feet=5, height_inches=10,
        age=40, gender="male", training_days_per_week=3,
        goal_id="fat_loss", pace="moderate",
    ))
    assert targets.protein_basis_kind == "adjusted_weight"
    assert targets.protein_basis_lbs is not None and targets.protein_basis_lbs < 300
    assert targets.protein_g < 300
    print(f"  ✓ basis={targets.protein_basis_lbs} lb, protein={targets.protein_g}g")


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Calorie calculator sanity tests")
    print("=" * 60)

    cases = [
        test_male_fat_loss_moderate,
        test_body_recomp_moderate,
        test_female_muscle_gain_aggressive,
        test_minimum_calorie_floor,
        test_custom_override_pins_value,
        test_reference_ranges_card,
        test_reference_ranges_match_visible_example,
        test_reference_ranges_honor_minimum_floor,
        test_override_calories_only_recomputes_fat_and_carbs,
        test_override_protein_only_recomputes_carbs_fat,
        test_override_fat_only_recomputes_carbs,
        test_override_all_four_uses_verbatim,
        test_override_fat_below_floor_flag,
        test_calculated_target_is_internally_consistent,
        test_moderate_recomp_180_lb_example,
        test_fat_loss_adjustment_scales_by_tdee,
        test_lean_bulk_adjustment_scales_by_tdee,
        test_overweight_fat_loss_uses_adjusted_protein_basis,
    ]

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

    print("\n" + "=" * 60)
    if failures:
        print(f"  {failures} test(s) FAILED")
        raise SystemExit(1)
    print(f"  All {len(cases)} tests passed.")
    print("=" * 60)
