"""Tests for weekly calorie budget smoothing.

Covers:
  - Fat loss: over-budget → cut spread across remaining days (capped at 200/day)
  - Body recomp: over-budget → cut capped at 150/day
  - Muscle gain: over-budget → no downward cut (cap_down=0)
  - Strength: no aggressive cuts
  - Under-budget → adds calories back
  - Days remaining = 0 → base target returned unchanged
  - Days remaining = 1 → full delta on today only
  - compute_adjusted_macros: protein stable, carbs/fat adjust
  - Conservative caps enforced
"""
from __future__ import annotations

import sys
import traceback

from app.services.nutrition.weekly_calorie_budget import (
    compute_adjusted_daily_target, compute_adjusted_macros,
)


# ─── helpers ──────────────────────────────────────────────────────────────────

def _run(goal: str, base: int, logged_so_far: int, days_remaining: int):
    return compute_adjusted_daily_target(
        base_daily_target=base,
        calories_logged_so_far=logged_so_far,
        days_remaining=days_remaining,
        goal=goal,
    )


# ─── tests ────────────────────────────────────────────────────────────────────

def test_fat_loss_over_budget_spread():
    """Fat loss: 200 cal over budget with 5 days left → ~40 cal/day cut."""
    # base = 1800/day, weekly = 12600
    # logged 3 days: 1800+1800+1800 + 200 over = 5600
    # remaining = 12600 - 5600 = 7000, 5 days → 1400/day, delta = -400
    # but cap_down for fat_loss is 200, so adjustment = -200
    r = _run("fat_loss", base=1800, logged_so_far=5600, days_remaining=5)
    assert r.adjustment_applied <= 0, f"Over-budget should cut, got {r.adjustment_applied}"
    assert r.adjustment_applied >= -200, f"Fat loss cap is 200, got {r.adjustment_applied}"
    assert r.adjusted_calories < r.base_daily_target
    assert r.at_cap is True, "Should be at cap when raw delta exceeds 200"
    print(f"  ✓ fat_loss over-budget: adj={r.adjusted_calories}, delta={r.adjustment_applied}")


def test_fat_loss_small_over_no_cap():
    """Fat loss: small overage → adjustment within cap, at_cap=False."""
    # base = 2000/day, weekly = 14000
    # logged 3 days: 6100 (100 over), 4 days remaining
    # remaining = 14000 - 6100 = 7900, /4 = 1975, delta = -25
    r = _run("fat_loss", base=2000, logged_so_far=6100, days_remaining=4)
    assert r.adjustment_applied < 0
    assert abs(r.adjustment_applied) <= 200
    assert r.at_cap is False, "Small delta should NOT be at cap"
    print(f"  ✓ fat_loss small over: adj={r.adjusted_calories}, at_cap={r.at_cap}")


def test_fat_loss_under_budget_adds_back():
    """Fat loss: under budget → adjusted target is higher than base."""
    # base = 1800/day, logged 2 days at 1500 each → 300 under
    # remaining = (1800*7 - 3000) / 5 = (12600-3000)/5 = 9600/5 = 1920
    r = _run("fat_loss", base=1800, logged_so_far=3000, days_remaining=5)
    assert r.adjustment_applied > 0, f"Under-budget should add back, got {r.adjustment_applied}"
    assert r.adjusted_calories > r.base_daily_target
    print(f"  ✓ fat_loss under-budget adds back: adj={r.adjusted_calories}")


def test_body_recomp_cap_150():
    """Body recomp: over-budget cut capped at 150/day."""
    # large overage, 2 days remaining
    r = _run("body_recomp", base=2200, logged_so_far=13000, days_remaining=2)
    assert r.adjustment_applied >= -150, f"Recomp cap is 150, got {r.adjustment_applied}"
    if r.at_cap:
        print(f"  ✓ body_recomp: at cap 150, adj={r.adjusted_calories}")
    else:
        print(f"  ✓ body_recomp: within cap, adj={r.adjusted_calories}")


def test_muscle_gain_no_downward_cut():
    """Muscle gain: over-budget → NO downward cut (cap_down=0)."""
    # Eating 500 over/day for 4 days, 3 days remaining
    base = 2500
    r = _run("muscle_gain", base=base, logged_so_far=base*4 + 2000, days_remaining=3)
    assert r.adjustment_applied >= 0, \
        f"Muscle gain must NEVER cut calories, got adjustment={r.adjustment_applied}"
    print(f"  ✓ muscle_gain no downward cut: adj={r.adjusted_calories}")


def test_strength_no_downward_cut():
    """Strength goal: over-budget → NO downward cut (cap_down=0)."""
    base = 2800
    r = _run("strength", base=base, logged_so_far=base*4 + 1500, days_remaining=3)
    assert r.adjustment_applied >= 0, \
        f"Strength must NEVER cut calories, got adjustment={r.adjustment_applied}"
    print(f"  ✓ strength no downward cut: adj={r.adjusted_calories}")


def test_zero_days_remaining():
    """Zero days remaining → base target unchanged."""
    r = _run("fat_loss", base=1800, logged_so_far=5000, days_remaining=0)
    assert r.adjusted_calories == 1800
    assert r.adjustment_applied == 0
    print("  ✓ zero days remaining → base target unchanged")


def test_one_day_remaining():
    """One day remaining — entire remaining budget goes on today."""
    # base 2000/day, logged 6 days at 1800 → under by 200/day → 1200 total under
    # remaining = (2000*7 - 10800) / 1 = (14000-10800)/1 = 3200
    # raw delta = +1200, cap_up for fat_loss is 150
    r = _run("fat_loss", base=2000, logged_so_far=10800, days_remaining=1)
    assert r.days_remaining == 1
    assert r.adjustment_applied <= 150, f"cap_up for fat_loss is 150, got {r.adjustment_applied}"
    print(f"  ✓ one day remaining, at_cap={r.at_cap}, adj={r.adjusted_calories}")


def test_formula_basic():
    """Basic formula check: weekly_budget_remaining = base*7 - logged_so_far."""
    base = 2000; logged = 4000; days = 3
    r = _run("general_health", base=base, logged_so_far=logged, days_remaining=days)
    expected_budget = base * 7 - logged   # 14000 - 4000 = 10000
    assert r.weekly_budget_remaining == expected_budget, \
        f"Budget remaining {r.weekly_budget_remaining} != {expected_budget}"
    print(f"  ✓ weekly_budget_remaining formula: {r.weekly_budget_remaining}")


def test_rounded_to_nearest_5():
    """adjusted_calories is rounded to the nearest 5."""
    r = _run("general_health", base=2000, logged_so_far=5983, days_remaining=4)
    assert r.adjusted_calories % 5 == 0, \
        f"adjusted_calories={r.adjusted_calories} is not divisible by 5"
    print(f"  ✓ rounded to nearest 5: {r.adjusted_calories}")


# ─── macro redistribution ─────────────────────────────────────────────────────

def test_adjusted_macros_protein_stable():
    """Protein must always stay stable when redistributing macros."""
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=200, base_fat_g=70,
        adjusted_calories=1800, base_calories=2000,
    )
    assert macros["protein_g"] == 180, \
        f"Protein changed from 180 → {macros['protein_g']}"
    print(f"  ✓ protein stable: protein={macros['protein_g']}")


def test_adjusted_macros_cut_reduces_carbs_and_fat():
    """When cutting calories, carbs and fat should both decrease."""
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=250, base_fat_g=80,
        adjusted_calories=1700, base_calories=2000,
    )
    assert macros["carbs_g"] < 250, f"Carbs should decrease on a cut"
    assert macros["fat_g"]   < 80,  f"Fat should decrease on a cut"
    assert macros["protein_g"] == 180
    print(f"  ✓ cut reduces carbs ({macros['carbs_g']}) and fat ({macros['fat_g']})")


def test_adjusted_macros_carb_floor_40g():
    """Carbs must never drop below 40 g even on aggressive cut."""
    macros = compute_adjusted_macros(
        base_protein_g=200, base_carbs_g=60, base_fat_g=50,
        adjusted_calories=1000, base_calories=2000,
    )
    assert macros["carbs_g"] >= 40, f"Carbs floor violated: {macros['carbs_g']}"
    print(f"  ✓ carb floor 40g: carbs={macros['carbs_g']}")


def test_adjusted_macros_fat_floor_30g():
    """Fat must never drop below 30 g even on aggressive cut."""
    macros = compute_adjusted_macros(
        base_protein_g=200, base_carbs_g=60, base_fat_g=35,
        adjusted_calories=1000, base_calories=2000,
    )
    assert macros["fat_g"] >= 30, f"Fat floor violated: {macros['fat_g']}"
    print(f"  ✓ fat floor 30g: fat={macros['fat_g']}")


def test_adjusted_macros_no_change_when_on_target():
    """Zero delta → macros unchanged."""
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=220, base_fat_g=70,
        adjusted_calories=2000, base_calories=2000,
    )
    assert macros["carbs_g"]   == 220
    assert macros["fat_g"]     == 70
    assert macros["protein_g"] == 180
    print("  ✓ zero delta → macros unchanged")


# ─── runner ──────────────────────────────────────────────────────────────────

TESTS = [
    test_fat_loss_over_budget_spread,
    test_fat_loss_small_over_no_cap,
    test_fat_loss_under_budget_adds_back,
    test_body_recomp_cap_150,
    test_muscle_gain_no_downward_cut,
    test_strength_no_downward_cut,
    test_zero_days_remaining,
    test_one_day_remaining,
    test_formula_basic,
    test_rounded_to_nearest_5,
    test_adjusted_macros_protein_stable,
    test_adjusted_macros_cut_reduces_carbs_and_fat,
    test_adjusted_macros_carb_floor_40g,
    test_adjusted_macros_fat_floor_30g,
    test_adjusted_macros_no_change_when_on_target,
]


def run_all():
    passed = failed = 0
    for test_fn in TESTS:
        try:
            print(f"[{test_fn.__name__}]")
            test_fn()
            passed += 1
        except Exception:
            print(f"  ✗ FAILED")
            traceback.print_exc()
            failed += 1
    print(f"\n{'='*55}")
    print(f"Weekly calorie budget tests: {passed} passed, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    run_all()
