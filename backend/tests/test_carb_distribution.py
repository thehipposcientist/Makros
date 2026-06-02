"""Pure-function tests for carb_distribution.

Carb redistribution must keep weekly calories + protein invariant
(zero-sum across the day). The most important property to lock down
in a regression test.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_carb_distribution
"""
from __future__ import annotations

from app.services.nutrition.carb_distribution import (
    MacroSet, classify_day, redistribute_macros, redistribute_for_day,
)


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_close(actual, expected, tol, label):
    assert abs(actual - expected) <= tol, f"{label}: got {actual}, expected {expected}±{tol}"
    print(f"  ✓ {label}")


def base_macros() -> MacroSet:
    # 2500 kcal / 180p / 280c / 75f. Sums to: 720 + 1120 + 675 = 2515 kcal.
    # Protein + carbs * 4 + fat * 9 = exact 2515 (close enough for the
    # invariant — we round to ints so ±5 kcal drift is acceptable).
    return MacroSet(calories=2515, protein_g=180, carbs_g=280, fat_g=75)


def test_classify_day():
    print("[test] classify_day mapping")
    assert_eq(classify_day(focus="Rest"), "rest", "rest focus")
    assert_eq(classify_day(activity_category="recovery"), "rest", "recovery category")
    assert_eq(classify_day(archetype="MOBILITY_FLOW"), "easy", "mobility archetype")
    assert_eq(classify_day(activity_category="cardio", cardio_style="steady"), "easy", "steady cardio")
    assert_eq(classify_day(activity_category="cardio", cardio_style="intervals"), "heavy", "interval cardio")
    assert_eq(classify_day(focus="Push"), "standard", "push standard")
    assert_eq(classify_day(focus="Legs"), "leg", "legs day")
    assert_eq(classify_day(archetype="LIFT_LOWER_HEAVY"), "heavy", "heavy lower lift archetype")
    assert_eq(classify_day(archetype="LIFT_FULL_BODY_STRENGTH"), "heavy", "full body strength")
    assert_eq(classify_day(stimulus="strength"), "hard", "strength stimulus")


def test_protein_invariant():
    print("[test] protein never changes")
    base = base_macros()
    for dt in ("heavy", "leg", "hard", "standard", "easy", "rest"):
        out = redistribute_macros(base, day_type=dt)
        assert_eq(out.protein_g, base.protein_g, f"protein on {dt}")


def test_carb_shifts():
    print("[test] carb shifts by day type")
    base = base_macros()
    heavy = redistribute_macros(base, day_type="heavy")
    leg = redistribute_macros(base, day_type="leg")
    rest = redistribute_macros(base, day_type="rest")
    # Heavy day: +25 g vs base (uncapped at default goal).
    assert_eq(heavy.carbs_g - base.carbs_g, 25, "heavy +25g")
    # Leg day: +15 g.
    assert_eq(leg.carbs_g - base.carbs_g, 15, "leg +15g")
    # Rest day: -25 g.
    assert_eq(rest.carbs_g - base.carbs_g, -25, "rest -25g")


def test_goal_caps():
    print("[test] per-goal caps")
    base = base_macros()
    # Fat-loss caps at ±20 → heavy +25 should cap to +20.
    cut = redistribute_macros(base, day_type="heavy", goal_bucket="fat_loss")
    assert_eq(cut.carbs_g - base.carbs_g, 20, "fat_loss heavy caps at +20")
    # Muscle-gain widens to ±35 → heavy gets full +25, no extra
    # (since base shift is +25, not 35).
    bulk = redistribute_macros(base, day_type="heavy", goal_bucket="muscle_gain")
    assert_eq(bulk.carbs_g - base.carbs_g, 25, "muscle_gain heavy gets full +25")


def test_calorie_invariant():
    print("[test] daily calories preserved (±5 kcal rounding)")
    base = base_macros()
    for dt in ("heavy", "leg", "hard", "standard", "easy", "rest"):
        out = redistribute_macros(base, day_type=dt)
        # ±5 kcal drift acceptable (integer rounding on fat grams).
        assert_close(out.calories, base.calories, 6, f"calories on {dt}")


def test_carb_floor():
    print("[test] carb floor of 40g")
    low = MacroSet(calories=1500, protein_g=140, carbs_g=50, fat_g=50)
    out = redistribute_macros(low, day_type="rest")
    # Rest would shift -25 → 25, but floor clamps to 40.
    assert out.carbs_g >= 40, f"carb floor: got {out.carbs_g}"
    print(f"  ✓ carb floor enforced ({out.carbs_g}g)")


def test_fat_floor_reduces_carb_upshift():
    print("[test] fat floor limits carb upshift")
    base = MacroSet(
        calories=2335,
        protein_g=180,
        carbs_g=280,
        fat_g=55,
        fat_floor_g=50,
    )
    out = redistribute_macros(base, day_type="heavy")
    assert out.fat_g >= 50, f"fat floor breached: {out.fat_g}"
    assert 0 < out.carbs_g - base.carbs_g < 25, (
        f"expected reduced carb shift, got {out.carbs_g - base.carbs_g}"
    )
    assert_close(out.calories, base.calories, 6, "calories after reduced shift")
    print(f"  ✓ carb shift reduced to +{out.carbs_g - base.carbs_g}g while fat held at {out.fat_g}g")


def test_redistribute_for_day_wrapper():
    print("[test] redistribute_for_day classifies + redistributes")
    base = base_macros()
    out, day_type = redistribute_for_day(base, focus="Legs")
    assert_eq(day_type, "leg", "classified as leg")
    assert_eq(out.carbs_g - base.carbs_g, 15, "leg +15g via wrapper")


if __name__ == "__main__":
    test_classify_day()
    test_protein_invariant()
    test_carb_shifts()
    test_goal_caps()
    test_calorie_invariant()
    test_carb_floor()
    test_fat_floor_reduces_carb_upshift()
    test_redistribute_for_day_wrapper()
    print("\n✅ test_carb_distribution.py PASSED")
