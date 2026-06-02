"""Tests for weekly calorie behavior smoothing.

Covers:
  - Small under-target days disappear inside the calorie deadband
  - Fat loss lightly penalizes meaningful overages and does not bank deficits
  - Recomp / maintain clamps weekly behavior to +/-75 kcal/day
  - Muscle gain adds for meaningful under-budget behavior, capped at +150
  - Partial logging days below 50% of target are ignored
  - Weekly smoothing does not use prior weekly-smoothed targets
  - compute_adjusted_macros keeps protein stable while carbs/fat adjust
"""
from __future__ import annotations

import sys
import traceback

from app.services.nutrition.weekly_calorie_budget import (
    CalorieDay,
    compute_adjusted_daily_target,
    compute_adjusted_macros,
    compute_weekly_behavior_delta,
    effective_calorie_error,
    is_valid_calorie_day,
)


def _days(logged: list[int], target: int) -> list[CalorieDay]:
    return [CalorieDay(logged_calories=v, comparison_target=target) for v in logged]


def _run(goal: str, base: int, logged: list[int], days_remaining: int):
    return compute_adjusted_daily_target(
        base_daily_target=base,
        calories_logged_so_far=sum(logged),
        days_remaining=days_remaining,
        goal=goal,
        prior_days=_days(logged, base),
    )


def test_small_under_target_days_are_deadband_noise():
    """Four 2100 kcal days against a 2200 target should not raise targets."""
    r = _run("maintain", base=2200, logged=[2100, 2100, 2100, 2100], days_remaining=3)
    assert r.valid_days == 4
    assert r.under_budget == 0
    assert r.adjustment_applied == 0
    assert r.adjusted_calories == 2200
    assert effective_calorie_error(logged_calories=2100, comparison_target=2200) == 0
    print("  ✓ small under-target days stay at base target")


def test_fat_loss_over_budget_creates_small_capped_negative_delta():
    """Meaningful fat-loss overages trim target lightly and cap at -100."""
    r = _run("fat_loss", base=2000, logged=[2600, 2600, 2600, 2600], days_remaining=3)
    assert r.over_budget > 0
    assert r.adjustment_applied == -100
    assert r.adjusted_calories == 1900
    assert r.at_cap is True
    print("  ✓ fat-loss over-budget delta capped at -100")


def test_fat_loss_under_budget_does_not_add_without_recovery_flag():
    """Fat loss should not repay under-budget days as future calories."""
    r = _run("fat_loss", base=2000, logged=[1600, 1600, 1600, 1600], days_remaining=3)
    assert r.under_budget > 0
    assert r.adjustment_applied == 0
    assert r.adjusted_calories == 2000
    print("  ✓ fat-loss under-budget does not add calories by default")


def test_fat_loss_under_budget_can_add_when_recovery_flag_exists():
    """Explicit recovery risk allows a small positive correction, capped."""
    r = compute_adjusted_daily_target(
        base_daily_target=2000,
        calories_logged_so_far=6400,
        days_remaining=3,
        goal="fat_loss",
        prior_days=_days([1600, 1600, 1600, 1600], 2000),
        allow_fat_loss_under_budget_correction=True,
    )
    assert r.under_budget > 0
    assert 0 < r.adjustment_applied <= 100
    print("  ✓ fat-loss recovery risk can allow a small positive correction")


def test_recomp_maintain_clamps_under_and_over_budget():
    """Maintain/recomp use a conservative +/-75 kcal/day clamp."""
    under = _run("body_recomp", base=2200, logged=[1600, 1600, 1600, 1600], days_remaining=3)
    over = _run("maintain", base=2200, logged=[3000, 3000, 3000, 3000], days_remaining=3)
    assert under.adjustment_applied == 75
    assert under.at_cap is True
    assert over.adjustment_applied == -75
    assert over.at_cap is True
    print("  ✓ recomp/maintain clamp weekly deltas to +/-75")


def test_muscle_gain_under_budget_adds_capped_positive_delta():
    """Meaningful under-budget days matter for muscle gain, capped at +150."""
    r = _run("muscle_gain", base=2600, logged=[2100, 2100, 2100, 2100], days_remaining=3)
    assert r.under_budget > 0
    assert r.adjustment_applied == 150
    assert r.adjusted_calories == 2750
    assert r.at_cap is True
    print("  ✓ muscle gain under-budget delta capped at +150")


def test_muscle_gain_over_budget_does_not_cut():
    r = _run("muscle_gain", base=2600, logged=[3200, 3200, 3200, 3200], days_remaining=3)
    assert r.over_budget > 0
    assert r.adjustment_applied == 0
    assert r.adjusted_calories == 2600
    print("  ✓ muscle gain does not cut for over-budget days")


def test_invalid_partial_logging_days_are_ignored():
    """A day under 50% of target is treated as incomplete logging."""
    r = _run("maintain", base=2200, logged=[900], days_remaining=6)
    assert is_valid_calorie_day(logged_calories=900, comparison_target=2200) is False
    assert r.valid_days == 0
    assert r.adjustment_applied == 0
    print("  ✓ partial logging days below 50% are ignored")


def test_marked_complete_allows_low_logged_day_to_count():
    """Future explicit day-complete flag can opt a low-calorie day into smoothing."""
    delta = compute_weekly_behavior_delta(
        prior_days=[CalorieDay(logged_calories=900, comparison_target=2200, marked_complete=True)],
        days_remaining=6,
        goal="maintain",
    )
    assert delta.valid_days == 1
    assert delta.under_budget > 0
    assert delta.adjustment_applied > 0
    print("  ✓ marked-complete low day can count")


def test_days_remaining_zero_returns_no_weekly_delta():
    r = _run("fat_loss", base=1800, logged=[2600, 2600], days_remaining=0)
    assert r.adjusted_calories == 1800
    assert r.adjustment_applied == 0
    assert r.days_remaining == 0
    print("  ✓ zero days remaining returns base target")


def test_weekly_smoothing_excludes_prior_smoothed_targets():
    """Only comparison_target is used; prior weekly-smoothed target fields are ignored."""
    delta = compute_weekly_behavior_delta(
        prior_days=[{
            "logged_calories": 2550,
            "comparison_target": 2200,
            "target_with_weekly_smoothing": 2550,
        }],
        days_remaining=3,
        goal="body_recomp",
    )
    assert delta.over_budget == 240
    assert delta.adjustment_applied == -30
    print("  ✓ weekly smoothing excludes itself from comparison targets")


def test_unknown_goal_uses_conservative_caps():
    r = _run("general_health", base=2200, logged=[3000, 3000, 3000, 3000], days_remaining=3)
    assert r.adjustment_applied == -50
    assert r.at_cap is True
    print("  ✓ unknown/default goals use conservative +/-50 behavior")


def test_adjusted_macros_protein_stable():
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=200, base_fat_g=70,
        adjusted_calories=1800, base_calories=2000,
    )
    assert macros["protein_g"] == 180
    print("  ✓ protein stable")


def test_adjusted_macros_cut_reduces_carbs_and_fat():
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=250, base_fat_g=80,
        adjusted_calories=1700, base_calories=2000,
    )
    assert macros["carbs_g"] < 250
    assert macros["fat_g"] < 80
    assert macros["protein_g"] == 180
    print("  ✓ cut reduces carbs and fat")


def test_adjusted_macros_carb_floor_40g():
    macros = compute_adjusted_macros(
        base_protein_g=200, base_carbs_g=60, base_fat_g=50,
        adjusted_calories=1000, base_calories=2000,
    )
    assert macros["carbs_g"] >= 40
    print("  ✓ carb floor 40g")


def test_adjusted_macros_fat_floor_30g():
    macros = compute_adjusted_macros(
        base_protein_g=200, base_carbs_g=60, base_fat_g=35,
        adjusted_calories=1000, base_calories=2000,
    )
    assert macros["fat_g"] >= 30
    print("  ✓ fat floor 30g")


def test_adjusted_macros_custom_fat_floor():
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=220, base_fat_g=60,
        adjusted_calories=1900, base_calories=2300,
        fat_floor_g=54,
    )
    assert macros["fat_g"] >= 54
    total = macros["protein_g"] * 4 + macros["carbs_g"] * 4 + macros["fat_g"] * 9
    assert abs(total - macros["calories"]) <= 10
    print("  ✓ custom fat floor respected while calories stay close")


def test_adjusted_macros_no_change_when_on_target():
    macros = compute_adjusted_macros(
        base_protein_g=180, base_carbs_g=220, base_fat_g=70,
        adjusted_calories=2000, base_calories=2000,
    )
    assert macros["carbs_g"] == 220
    assert macros["fat_g"] == 70
    assert macros["protein_g"] == 180
    print("  ✓ zero delta leaves macros unchanged")


def test_adjusted_macros_carb_bias_skews_to_carbs_on_heavy_days():
    base = dict(base_protein_g=180, base_carbs_g=200, base_fat_g=70,
                base_calories=2000, adjusted_calories=2400)
    default_split = compute_adjusted_macros(**base)
    heavy_split = compute_adjusted_macros(**base, carb_bias_pct=0.80)
    assert heavy_split["carbs_g"] > default_split["carbs_g"]
    assert heavy_split["fat_g"] < default_split["fat_g"]
    assert heavy_split["protein_g"] == 180
    print("  ✓ heavy-day bias sends more calories to carbs")


TESTS = [
    test_small_under_target_days_are_deadband_noise,
    test_fat_loss_over_budget_creates_small_capped_negative_delta,
    test_fat_loss_under_budget_does_not_add_without_recovery_flag,
    test_fat_loss_under_budget_can_add_when_recovery_flag_exists,
    test_recomp_maintain_clamps_under_and_over_budget,
    test_muscle_gain_under_budget_adds_capped_positive_delta,
    test_muscle_gain_over_budget_does_not_cut,
    test_invalid_partial_logging_days_are_ignored,
    test_marked_complete_allows_low_logged_day_to_count,
    test_days_remaining_zero_returns_no_weekly_delta,
    test_weekly_smoothing_excludes_prior_smoothed_targets,
    test_unknown_goal_uses_conservative_caps,
    test_adjusted_macros_protein_stable,
    test_adjusted_macros_cut_reduces_carbs_and_fat,
    test_adjusted_macros_carb_floor_40g,
    test_adjusted_macros_fat_floor_30g,
    test_adjusted_macros_custom_fat_floor,
    test_adjusted_macros_no_change_when_on_target,
    test_adjusted_macros_carb_bias_skews_to_carbs_on_heavy_days,
]


def run_all():
    passed = failed = 0
    for test_fn in TESTS:
        try:
            print(f"[{test_fn.__name__}]")
            test_fn()
            passed += 1
        except Exception:
            print("  ✗ FAILED")
            traceback.print_exc()
            failed += 1
    print(f"\n{'='*55}")
    print(f"Weekly calorie budget tests: {passed} passed, {failed} failed")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    run_all()
