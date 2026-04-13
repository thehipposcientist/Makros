"""
Sanity tests for calorie_calculator.py — NO external deps, no pytest.

Run manually from inside the backend container:
    docker exec -it makros-backend python -m app.services.test_calorie_calculator

Purpose: give you concrete "170 lb male fat-loss moderate → X cal / Y protein"
numbers to eyeball before trusting the calculator in production. Every case
below describes WHY we expect the number so you can check our math.

If any of these assertions fail after a code change, stop and look at the
debug fields in the CalorieTargets output — the bmr / tdee / goal_adjustment
trail will tell you which step diverged.
"""
from __future__ import annotations

from app.services.calorie_calculator import (
    CalorieInputs,
    CustomMacroOverrides,
    calculate_reference_ranges,
    compute_targets,
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
        cut    = 2762 - 500 ≈ 2262

        Protein = 180 * 0.9 = 162g
        Fat     = max(0.3*180=54, 0.28*2262/9=70) = 70g
        Carbs   ≈ (2262 - 162*4 - 70*9) / 4 = (2262 - 648 - 630) / 4 = 984/4 ≈ 246g
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
    _assert_near(targets.calories, 2262, 15,  "calories")
    _assert_near(targets.protein_g, 162, 2,   "protein_g")
    _assert_near(targets.fat_g,      70, 5,   "fat_g")
    _assert_near(targets.carbs_g,   246, 10,  "carbs_g")
    assert targets.bucket_name == "fat_loss"


def test_female_muscle_gain_aggressive() -> None:
    """25yo female, 140 lb, 5'5", training 5 days/wk, muscle gain aggressive.

    Expected chain:
        BMR    = 10*(140/2.205) + 6.25*65*2.54 - 5*25 - 161
               ≈ 635 + 1032 - 125 - 161
               ≈ 1381
        TDEE   = 1381 * 1.55 ≈ 2140
        bulk   = 2140 + 500 ≈ 2640

        Protein = 140 * 1.0 = 140g
        Fat     = max(0.3*140=42, 0.25*2640/9=73) = 73g
        Carbs   ≈ (2640 - 140*4 - 73*9) / 4 = (2640 - 560 - 657) / 4 ≈ 356g
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
    _assert_near(targets.calories, 2640, 15,  "calories")
    _assert_near(targets.protein_g, 140, 2,   "protein_g")
    _assert_near(targets.fat_g,      73, 5,   "fat_g")
    _assert_near(targets.carbs_g,   356, 15,  "carbs_g")
    assert targets.bucket_name == "muscle_gain"


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


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 60)
    print("Calorie calculator sanity tests")
    print("=" * 60)

    cases = [
        test_male_fat_loss_moderate,
        test_female_muscle_gain_aggressive,
        test_minimum_calorie_floor,
        test_custom_override_pins_value,
        test_reference_ranges_card,
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
