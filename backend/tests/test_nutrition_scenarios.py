"""Realistic nutrition scoring scenario tests.

Covers end-to-end scoring through `compute_nutrition_score` and the
pure-function `_metabolic_support_flag` from `recovery_flags`, using
the shared `make_daily_nutrition_metrics` factory from conftest.

Every test is a pure function (no DB, no AI). The factory builds a
realistic baseline for an active 180 lb male; each scenario overrides
the fields that define the test.

Scenarios:
  1.  Perfect day — high score (>85)
  2.  Protein deficit — adherence drops
  3.  High added sugar — quality drops
  4.  Zero fiber — quality penalized
  5.  Ultra-processed diet — quality low
  6.  Recovery flags: under-fueling (metabolic_support proxy via rows)
  7.  Recovery flags: low fat (metabolic_support proxy via rows)
  8.  Recovery flags: all green
  9.  Goal weight affects scoring (fat_loss vs general_health)
  10. Not enough data — metabolic_support returns not_enough_data
  11. Plant diversity bonus — quality rewards diversity
  12. Sodium penalty — quality penalized
"""
from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

# ── Shim sqlmodel + app.models so recovery_flags can import outside Docker ──
# _metabolic_support_flag is a pure function that never touches the DB, but
# recovery_flags.py has top-level `from sqlmodel import select` and
# `from app.models import ...` that fail when sqlmodel isn't installed.
if "sqlmodel" not in sys.modules:
    _sm = MagicMock()
    sys.modules.setdefault("sqlmodel", _sm)
    sys.modules.setdefault("sqlmodel.main", _sm)
    sys.modules.setdefault("sqlalchemy", MagicMock())
    sys.modules.setdefault("sqlalchemy.pool", MagicMock())

from tests.conftest import make_daily_nutrition_metrics


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Helper: metrics dict -> NutritionIndicators ───────────────────────────

def _indicators_from_metrics(
    metrics: dict,
    *,
    calories_target: float = 2200,
    protein_target: float = 180,
    meals_logged: int = 3,
    meals_expected: int = 3,
    food_count: int = 12,
    foods_with_micros: int = 10,
    micronutrients: dict | None = None,
    omega3_servings: float | None = None,
    seafood_servings_weekly: float = 0,
):
    """Convert a make_daily_nutrition_metrics dict into NutritionIndicators."""
    from app.services.nutrition.nutrition_score import NutritionIndicators

    m = metrics
    total_items = (
        m.get("minimally_processed_count", 0)
        + m.get("processed_count", 0)
        + m.get("ultra_processed_count", 0)
    ) or 1

    return NutritionIndicators(
        calories_logged=m["calories"],
        calories_target=calories_target,
        protein_logged=m["protein_g"],
        protein_target=protein_target,
        fiber_g=m["fiber_g"],
        added_sugar_g=m["added_sugar_g"],
        saturated_fat_g=m["sat_fat_g"],
        sodium_mg=m["sodium_mg"],
        minimally_processed_pct=100.0 * m["minimally_processed_count"] / total_items,
        ultra_processed_pct=100.0 * m["ultra_processed_count"] / total_items,
        distinct_plant_foods=m["distinct_plant_foods"],
        omega3_servings=(
            omega3_servings if omega3_servings is not None
            else m.get("omega3_servings", 0)
        ),
        seafood_servings_weekly=seafood_servings_weekly,
        meals_logged=meals_logged,
        meals_expected=meals_expected,
        food_count=food_count,
        foods_with_micros=foods_with_micros,
        micronutrients=micronutrients or {
            "calcium_mg": 900,
            "iron_mg": 15,
            "potassium_mg": 4000,
            "magnesium_mg": 380,
            "vitamin_d_mcg": 18,
            "vitamin_b12_mcg": 3.0,
        },
    )


def _row(*, cals: float, added_sugar_g: float = 0, sat_fat_g: float = 0,
          fiber_g: float = 30):
    """Stub a DailyNutritionMetrics-shaped object for recovery_flags."""
    return SimpleNamespace(
        calories_total=cals,
        added_sugar_g=added_sugar_g,
        saturated_fat_g=sat_fat_g,
        fiber_total_g=fiber_g,
    )


# ═══════════════════════════════════════════════════════════════════════════
# 1. Perfect day — high score
# ═══════════════════════════════════════════════════════════════════════════

def test_perfect_day_high_score():
    """A day hitting all targets: calories on point, protein >=95%,
    good fiber, low sugar, low sat fat, diverse plants. Score >85."""
    print("\n[test] perfect day -> score > 85")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    m = make_daily_nutrition_metrics(
        calories=2200,
        protein_g=180,
        fiber_g=31,          # 14.1 g/1000kcal — above 14 target
        added_sugar_g=12,    # ~2.2% cals
        sat_fat_g=16,        # ~6.5% cals
        sodium_mg=2000,
        distinct_plant_foods=7,
        minimally_processed_count=10,
        processed_count=2,
        ultra_processed_count=0,
    )
    ind = _indicators_from_metrics(m, omega3_servings=1.0)
    score = compute_nutrition_score(ind, goal="muscle_gain", sex="male")

    assert score.total > 85, f"perfect day scored {score.total}, expected >85"
    assert score.adherence_score >= 90, f"adherence {score.adherence_score}, expected >=90"
    assert score.quality_score >= 70, f"quality {score.quality_score}, expected >=70"
    assert score.confidence == "high"
    _ok(f"perfect day -> {score.total}/100 (adh={score.adherence_score}, "
        f"qual={score.quality_score}, micro={score.micro_score})")


# ═══════════════════════════════════════════════════════════════════════════
# 2. Protein deficit lowers adherence
# ═══════════════════════════════════════════════════════════════════════════

def test_protein_deficit_lowers_adherence():
    """Same as perfect day but protein at 60% of target. Adherence
    sub-score should drop significantly compared to on-target."""
    print("\n[test] protein at 60% of target -> adherence drops")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    # Baseline: perfect
    m_good = make_daily_nutrition_metrics(calories=2200, protein_g=180)
    ind_good = _indicators_from_metrics(m_good, omega3_servings=1.0)
    score_good = compute_nutrition_score(ind_good, goal="muscle_gain", sex="male")

    # Deficit: protein at 60% (108g of 180g target)
    m_bad = make_daily_nutrition_metrics(calories=2200, protein_g=108)
    ind_bad = _indicators_from_metrics(m_bad, omega3_servings=1.0)
    score_bad = compute_nutrition_score(ind_bad, goal="muscle_gain", sex="male")

    assert score_bad.adherence_score < score_good.adherence_score, \
        f"deficit adherence ({score_bad.adherence_score}) should be < " \
        f"perfect adherence ({score_good.adherence_score})"
    # 60% protein -> protein_alignment = 0.6/0.95 ~= 0.63 -> pro_pts ~= 31.6
    # Cal is still perfect (50 pts) -> adherence ~= 82
    # Good adherence was 100 -> drop of ~18 pts
    drop = score_good.adherence_score - score_bad.adherence_score
    assert drop >= 10, f"adherence drop was only {drop} points, expected >= 10"
    _ok(f"adherence dropped {drop} pts ({score_good.adherence_score} -> "
        f"{score_bad.adherence_score})")


# ═══════════════════════════════════════════════════════════════════════════
# 3. High sugar lowers quality
# ═══════════════════════════════════════════════════════════════════════════

def test_high_sugar_lowers_quality():
    """Good macros but added_sugar_g=80 (way over). Quality sub-score
    should be lower than a clean day."""
    print("\n[test] high added sugar (80g) -> quality drops")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    # Clean baseline
    m_clean = make_daily_nutrition_metrics(added_sugar_g=12)
    ind_clean = _indicators_from_metrics(m_clean, omega3_servings=1.0)
    score_clean = compute_nutrition_score(ind_clean, goal="body_recomp")

    # High sugar: 80g on 2200 cals -> 80*4/2200*100 = 14.5% cals
    m_sugar = make_daily_nutrition_metrics(added_sugar_g=80)
    ind_sugar = _indicators_from_metrics(m_sugar, omega3_servings=1.0)
    score_sugar = compute_nutrition_score(ind_sugar, goal="body_recomp")

    assert score_sugar.quality_score < score_clean.quality_score, \
        f"sugar quality ({score_sugar.quality_score}) should be < " \
        f"clean quality ({score_clean.quality_score})"
    # 14.5% sugar -> near the >15% gap threshold, pts should be ~6-7 out of 15
    _ok(f"quality dropped: {score_clean.quality_score} -> {score_sugar.quality_score}")


# ═══════════════════════════════════════════════════════════════════════════
# 4. Zero fiber lowers quality
# ═══════════════════════════════════════════════════════════════════════════

def test_zero_fiber_lowers_quality():
    """Everything good but fiber_g=5 (very low). Quality should penalize
    and a score cap should fire (fiber density <8 -> cap at 80)."""
    print("\n[test] very low fiber (5g) -> quality drops + score capped")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    m = make_daily_nutrition_metrics(
        fiber_g=5,           # 5/2200*1000 = 2.3 g/1000kcal (terrible)
        added_sugar_g=10,
        sat_fat_g=15,
        sodium_mg=2000,
        distinct_plant_foods=6,
        minimally_processed_count=9,
        processed_count=2,
        ultra_processed_count=1,
    )
    ind = _indicators_from_metrics(m, omega3_servings=1.0)
    score = compute_nutrition_score(ind, goal="body_recomp")

    # Fiber density = 2.3 g/1000kcal -> fiber_pts = 0 (below low=6 threshold)
    # Plus the cap: fiber_density < 8 -> total capped at 80
    assert score.total <= 80, \
        f"low fiber should cap total at 80, got {score.total}"
    assert score.quality_score < 80, \
        f"quality should be significantly penalized, got {score.quality_score}"
    _ok(f"total={score.total} (capped at 80), quality={score.quality_score}")


# ═══════════════════════════════════════════════════════════════════════════
# 5. Ultra-processed diet
# ═══════════════════════════════════════════════════════════════════════════

def test_ultra_processed_diet():
    """Processing counts set to mostly ultra-processed. Quality should
    be low due to the processed_pts calculation and UPF gap."""
    print("\n[test] ultra-processed diet -> quality low")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    m = make_daily_nutrition_metrics(
        minimally_processed_count=1,
        processed_count=2,
        ultra_processed_count=10,
        fiber_g=10,         # low-ish
        added_sugar_g=50,   # elevated
        distinct_plant_foods=2,
    )
    ind = _indicators_from_metrics(m)
    score = compute_nutrition_score(ind, goal="body_recomp")

    # min_proc_pct = 1/13 * 100 = 7.7%, ultra_pct = 10/13 * 100 = 76.9%
    # processed_pts = 20 * (0.077 - 0.5 * 0.769) = 20 * (-0.307) = 0 (clamped)
    assert score.quality_score < 60, \
        f"ultra-processed diet quality should be <60, got {score.quality_score}"
    assert score.flags.get("high_upf") is True, \
        "high_upf flag should be set"
    _ok(f"quality={score.quality_score}, high_upf={score.flags.get('high_upf')}")


# ═══════════════════════════════════════════════════════════════════════════
# 6. Recovery flags: under-fueling proxy via metabolic_support
# ═══════════════════════════════════════════════════════════════════════════

def test_recovery_flags_underfueling_metabolic():
    """Simulate 7 days of very low calories + high sugar + low fiber.
    metabolic_support (pure function) should flag red with 3+ concerns.
    (True EA computation requires DB; this tests the pure-function path.)"""
    print("\n[test] metabolic_support: low cal + high sugar + low fiber -> red")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag

    # 1200 cals/day, high sugar (15% cals), low fiber density (<8g/1000kcal)
    # sugar: 45g * 4 / 1200 = 15% > 10% -> concern
    # sat fat: 25g * 9 / 1200 = 18.75% > 10% -> concern
    # fiber: 5g / 1200 * 1000 = 4.2 g/1000kcal < 8 -> concern
    rows = [_row(cals=1200, added_sugar_g=45, sat_fat_g=25, fiber_g=5)
            for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "red", \
        f"expected red with 3 concerns, got {flag.state}: {flag.detail}"
    _ok(f"metabolic_support -> {flag.state}")


# ═══════════════════════════════════════════════════════════════════════════
# 7. Recovery flags: low fat via metabolic_support proxy
# ═══════════════════════════════════════════════════════════════════════════

def test_recovery_flags_low_fat_metabolic():
    """Simulate rows where sat fat % is high AND sugar is high -> amber.
    (True low_fat flag requires DB for MealItem query. This tests the
    metabolic_support pure function with 2 concerns.)"""
    print("\n[test] metabolic_support: high sugar + high sat fat -> amber")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag

    # 2 concerns: added sugar + sat fat both >10% cals
    # sugar: 70g * 4 / 2200 = 12.7% > 10%
    # sat fat: 30g * 9 / 2200 = 12.3% > 10%
    # fiber: 30g / 2200 * 1000 = 13.6 g/1000kcal > 8 -> fine
    rows = [_row(cals=2200, added_sugar_g=70, sat_fat_g=30, fiber_g=30)
            for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "amber", \
        f"expected amber with 2 concerns, got {flag.state}"
    _ok(f"metabolic_support -> {flag.state}")


# ═══════════════════════════════════════════════════════════════════════════
# 8. Recovery flags: all green
# ═══════════════════════════════════════════════════════════════════════════

def test_recovery_flags_all_green():
    """7 days of good nutrition -> metabolic_support green."""
    print("\n[test] metabolic_support: clean diet 7 days -> green")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag

    # sugar: 15g * 4 / 2500 = 2.4% -> fine
    # sat fat: 18g * 9 / 2500 = 6.5% -> fine
    # fiber: 35g / 2500 * 1000 = 14 g/1000kcal -> fine
    # stable calories -> CV low
    rows = [_row(cals=2500, added_sugar_g=15, sat_fat_g=18, fiber_g=35)
            for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "green", \
        f"expected green, got {flag.state}: {flag.detail}"
    assert flag.numbers is not None
    assert flag.numbers["added_sugar_high_days"] == 0
    assert flag.numbers["sat_fat_high_days"] == 0
    assert flag.numbers["fiber_low_days"] == 0
    _ok(f"all green, CV={flag.numbers['calorie_stability_cv']}")


# ═══════════════════════════════════════════════════════════════════════════
# 9. Goal weight affects scoring
# ═══════════════════════════════════════════════════════════════════════════

def test_goal_weight_affects_scoring():
    """Fat loss goal weights adherence at 45% vs general_health which
    weights quality at 40%. Same nutrition data -> different scores."""
    print("\n[test] goal weighting: fat_loss vs general_health")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    # Scenario: perfect macros, mediocre quality (medium fiber, some sugar)
    m = make_daily_nutrition_metrics(
        calories=2200,
        protein_g=175,       # just under target for slight adherence gap
        fiber_g=18,          # 8.2 g/1000kcal (below 14 target)
        added_sugar_g=30,    # 5.5% cals (moderate)
        sat_fat_g=22,        # 9% cals (moderate)
        sodium_mg=2800,
        distinct_plant_foods=4,
        minimally_processed_count=6,
        processed_count=3,
        ultra_processed_count=3,
    )
    ind = _indicators_from_metrics(m)

    score_fl = compute_nutrition_score(ind, goal="fat_loss")
    score_gh = compute_nutrition_score(ind, goal="general_health")

    # Fat loss: (0.45, 0.35, 0.20) -> adherence matters more
    # General health: (0.30, 0.40, 0.30) -> quality matters more
    # With perfect-ish adherence and mediocre quality, fat_loss should
    # benefit from the high adherence weight.
    # The scores should differ because the weights differ.
    assert score_fl.total != score_gh.total, \
        f"expected different totals for fat_loss ({score_fl.total}) " \
        f"vs general_health ({score_gh.total})"
    _ok(f"fat_loss={score_fl.total}, general_health={score_gh.total} (differ)")


# ═══════════════════════════════════════════════════════════════════════════
# 10. Not enough data
# ═══════════════════════════════════════════════════════════════════════════

def test_not_enough_data():
    """Only 2 days of data -> metabolic_support should return
    not_enough_data instead of a real assessment."""
    print("\n[test] <5 days of data -> not_enough_data")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag

    rows = [_row(cals=2200, added_sugar_g=15, sat_fat_g=18, fiber_g=30)
            for _ in range(2)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "not_enough_data", \
        f"expected not_enough_data with 2 days, got {flag.state}"

    # Also test with exactly 4 days (still under 5)
    rows_4 = [_row(cals=2200) for _ in range(4)]
    flag_4 = _metabolic_support_flag(rows=rows_4)
    assert flag_4.state == "not_enough_data", \
        f"expected not_enough_data with 4 days, got {flag_4.state}"

    # 5 days should be enough
    rows_5 = [_row(cals=2200, added_sugar_g=10, sat_fat_g=15, fiber_g=30)
              for _ in range(5)]
    flag_5 = _metabolic_support_flag(rows=rows_5)
    assert flag_5.state != "not_enough_data", \
        f"5 days should be enough data, got {flag_5.state}"
    _ok("2 days -> not_enough_data, 4 -> not_enough_data, 5 -> real flag")


# ═══════════════════════════════════════════════════════════════════════════
# 11. Plant diversity bonus
# ═══════════════════════════════════════════════════════════════════════════

def test_plant_diversity_bonus():
    """Day with 12 distinct plant foods vs day with 2. Quality should
    reward diversity (plant_pts = 10 vs 4)."""
    print("\n[test] plant diversity: 12 plants vs 2 plants")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    base = make_daily_nutrition_metrics(
        added_sugar_g=10,
        sat_fat_g=15,
        sodium_mg=2000,
        fiber_g=28,
        minimally_processed_count=8,
        processed_count=2,
        ultra_processed_count=1,
    )

    # High diversity
    m_diverse = {**base, "distinct_plant_foods": 12}
    ind_diverse = _indicators_from_metrics(m_diverse, omega3_servings=1.0)
    score_diverse = compute_nutrition_score(ind_diverse, goal="general_health")

    # Low diversity
    m_low = {**base, "distinct_plant_foods": 2}
    ind_low = _indicators_from_metrics(m_low, omega3_servings=1.0)
    score_low = compute_nutrition_score(ind_low, goal="general_health")

    assert score_diverse.quality_score > score_low.quality_score, \
        f"diverse quality ({score_diverse.quality_score}) should > " \
        f"low diversity quality ({score_low.quality_score})"
    assert score_diverse.flags.get("plant_diverse") is True
    assert score_low.flags.get("plant_diverse") is False
    _ok(f"diverse quality={score_diverse.quality_score}, "
        f"low quality={score_low.quality_score}")


# ═══════════════════════════════════════════════════════════════════════════
# 12. Sodium penalty
# ═══════════════════════════════════════════════════════════════════════════

def test_sodium_penalty():
    """Day with sodium_mg=5000 (very high). Quality should penalize
    vs a day with normal sodium."""
    print("\n[test] sodium penalty: 5000mg vs 2000mg")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    base = make_daily_nutrition_metrics(
        added_sugar_g=10,
        sat_fat_g=15,
        fiber_g=28,
        distinct_plant_foods=5,
        minimally_processed_count=8,
        processed_count=2,
        ultra_processed_count=1,
    )

    # Normal sodium
    m_normal = {**base, "sodium_mg": 2000}
    ind_normal = _indicators_from_metrics(m_normal, omega3_servings=1.0)
    score_normal = compute_nutrition_score(ind_normal, goal="body_recomp")

    # Very high sodium
    m_high = {**base, "sodium_mg": 5000}
    ind_high = _indicators_from_metrics(m_high, omega3_servings=1.0)
    score_high = compute_nutrition_score(ind_high, goal="body_recomp")

    assert score_high.quality_score < score_normal.quality_score, \
        f"high sodium quality ({score_high.quality_score}) should be < " \
        f"normal sodium quality ({score_normal.quality_score})"
    # At 5000mg: sodium_pts = 0 (>=4500 threshold)
    # At 2000mg: sodium_pts = 10 (<=2300 full credit)
    # Difference should be meaningful (10 pts on quality scale)
    drop = score_normal.quality_score - score_high.quality_score
    assert drop >= 5, \
        f"sodium penalty only {drop} pts, expected >=5"
    _ok(f"normal quality={score_normal.quality_score}, "
        f"high sodium quality={score_high.quality_score}, drop={drop}")


# ═══════════════════════════════════════════════════════════════════════════
# 13. Confidence scaling — low logging completeness
# ═══════════════════════════════════════════════════════════════════════════

def test_low_confidence_reduces_total():
    """When only 1 of 4 expected meals is logged (25% completeness < 30%),
    confidence=low and the total score is scaled by 0.75."""
    print("\n[test] low logging completeness -> confidence=low, score reduced")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    m = make_daily_nutrition_metrics(calories=800, protein_g=60)
    # 1/4 = 0.25 completeness -> below the 0.3 threshold for "low"
    ind = _indicators_from_metrics(
        m,
        meals_logged=1,
        meals_expected=4,
        omega3_servings=1.0,
    )
    score = compute_nutrition_score(ind, goal="body_recomp")

    assert score.confidence == "low", \
        f"expected low confidence with 1/4 meals, got {score.confidence}"
    # A fully logged version of the same data would have confidence=high
    ind_full = _indicators_from_metrics(
        m,
        meals_logged=4,
        meals_expected=4,
        omega3_servings=1.0,
    )
    score_full = compute_nutrition_score(ind_full, goal="body_recomp")
    assert score.total < score_full.total, \
        f"low-confidence total ({score.total}) should be < " \
        f"full-confidence total ({score_full.total})"
    _ok(f"low confidence={score.total}, full={score_full.total}")


# ═══════════════════════════════════════════════════════════════════════════
# 14. Sugar + sat fat pair cap at 82
# ═══════════════════════════════════════════════════════════════════════════

def test_sugar_sat_fat_pair_cap():
    """High added sugar (>12% cals) AND high sat fat (>12% cals)
    simultaneously caps the total at 82."""
    print("\n[test] high sugar + high sat fat -> total capped at 82")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    m = make_daily_nutrition_metrics(
        calories=2200,
        protein_g=180,
        fiber_g=31,          # good fiber to avoid fiber cap
        added_sugar_g=80,    # 80*4/2200 = 14.5% > 12%
        sat_fat_g=40,        # 40*9/2200 = 16.4% > 12%
        sodium_mg=2000,
        distinct_plant_foods=6,
        minimally_processed_count=8,
        processed_count=2,
        ultra_processed_count=1,
    )
    ind = _indicators_from_metrics(m, omega3_servings=1.0)
    score = compute_nutrition_score(ind, goal="muscle_gain")

    assert score.total <= 82, \
        f"sugar+sat fat pair should cap at 82, got {score.total}"
    assert len(score.cap_reasons) > 0, "cap_reasons should be non-empty"
    _ok(f"total={score.total}, cap_reasons={score.cap_reasons}")


# ═══════════════════════════════════════════════════════════════════════════
# 15. Omega-3 presence rewards quality
# ═══════════════════════════════════════════════════════════════════════════

def test_omega3_presence_quality_bonus():
    """Day with omega3_servings=1 vs 0. Quality should reward omega-3."""
    print("\n[test] omega-3 presence: 1 serving vs 0")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    base = make_daily_nutrition_metrics(
        added_sugar_g=10,
        sat_fat_g=15,
        fiber_g=28,
        sodium_mg=2000,
        distinct_plant_foods=5,
        minimally_processed_count=8,
        processed_count=2,
        ultra_processed_count=1,
    )
    ind_with = _indicators_from_metrics(base, omega3_servings=1.0)
    ind_without = _indicators_from_metrics(base, omega3_servings=0.0)

    score_with = compute_nutrition_score(ind_with, goal="body_recomp")
    score_without = compute_nutrition_score(ind_without, goal="body_recomp")

    assert score_with.quality_score > score_without.quality_score, \
        f"omega-3 quality ({score_with.quality_score}) should > " \
        f"no omega-3 quality ({score_without.quality_score})"
    assert score_with.flags.get("omega3_present") is True
    _ok(f"with omega-3 quality={score_with.quality_score}, "
        f"without={score_without.quality_score}")


# ═══════════════════════════════════════════════════════════════════════════
# 16. Micro coverage: sex-aware RDA
# ═══════════════════════════════════════════════════════════════════════════

def test_micro_coverage_sex_aware():
    """Male iron RDA is 8mg (vs 18mg female). The same iron intake
    should produce different micro coverage for male vs female."""
    print("\n[test] micro coverage: male vs female iron RDA")
    from app.services.nutrition.nutrition_score import compute_nutrition_score

    m = make_daily_nutrition_metrics()
    micros = {
        "calcium_mg": 900,
        "iron_mg": 10,        # 10/8 = 125% male, 10/18 = 56% female
        "potassium_mg": 4000,
        "magnesium_mg": 380,
        "vitamin_d_mcg": 18,
        "vitamin_b12_mcg": 3.0,
    }
    ind = _indicators_from_metrics(m, micronutrients=micros, omega3_servings=1.0)

    score_male = compute_nutrition_score(ind, goal="body_recomp", sex="male")
    score_female = compute_nutrition_score(ind, goal="body_recomp", sex="female")

    # Male should have higher micro score because iron is easily hit
    assert score_male.micro_score >= score_female.micro_score, \
        f"male micro ({score_male.micro_score}) should be >= " \
        f"female micro ({score_female.micro_score})"
    _ok(f"male micro={score_male.micro_score}, female micro={score_female.micro_score}")


# ═══════════════════════════════════════════════════════════════════════════
# 17. Metabolic support: calorie swings count as concern
# ═══════════════════════════════════════════════════════════════════════════

def test_metabolic_support_calorie_swings():
    """Highly variable calorie intake (CV > 0.30) paired with another
    sustained concern should yield amber."""
    print("\n[test] metabolic_support: erratic cals + low fiber -> amber")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag

    # Erratic pattern: 1200, 3200, 1200, 3200, ... -> CV well above 0.30
    # Low fiber density on every day: 6g / 2200avg * 1000 = ~2.7 g/1000kcal
    cal_pattern = [1200, 3200, 1200, 3200, 1200, 3200, 1200]
    rows = [_row(cals=c, fiber_g=6) for c in cal_pattern]
    flag = _metabolic_support_flag(rows=rows)

    assert flag.state == "amber", \
        f"erratic cals + low fiber should be amber, got {flag.state}"
    assert flag.numbers is not None
    assert flag.numbers["calorie_stability_cv"] > 0.30, \
        f"CV should be > 0.30, got {flag.numbers['calorie_stability_cv']}"
    _ok(f"state={flag.state}, CV={flag.numbers['calorie_stability_cv']:.3f}")


# ═══════════════════════════════════════════════════════════════════════════
# 18. Weekly trend computation
# ═══════════════════════════════════════════════════════════════════════════

def test_weekly_trend_improving():
    """7 daily scores with an upward trend -> trend_direction='improving'."""
    print("\n[test] weekly trend: improving scores")
    from app.services.nutrition.nutrition_score import (
        NutritionScore, compute_weekly_trend,
    )

    # Build mock NutritionScore objects with an upward trend
    scores = []
    for i, total in enumerate([50, 55, 58, 65, 72, 78, 85]):
        scores.append(NutritionScore(
            total=total,
            adherence_score=total,
            quality_score=total,
            micro_score=50,
            confidence="high",
            tags=[],
            wins=[],
            improvements=[],
            likely_gaps=[],
            indicators={},
            flags={"protein_on_track": total > 70, "fiber_on_track": total > 60},
        ))

    trend = compute_weekly_trend(scores)
    assert trend.trend_direction == "improving", \
        f"expected improving, got {trend.trend_direction}"
    assert trend.day_count == 7
    assert trend.avg_score > 0
    _ok(f"trend={trend.trend_direction}, avg={trend.avg_score}")


def test_weekly_trend_empty():
    """No scores -> neutral defaults."""
    print("\n[test] weekly trend: empty input")
    from app.services.nutrition.nutrition_score import compute_weekly_trend

    trend = compute_weekly_trend([])
    assert trend.avg_score == 0
    assert trend.day_count == 0
    assert trend.trend_direction == "stable"
    _ok("empty input -> stable, avg=0")


# ═══════════════════════════════════════════════════════════════════════════
# Test list + runner
# ═══════════════════════════════════════════════════════════════════════════

cases = [
    test_perfect_day_high_score,
    test_protein_deficit_lowers_adherence,
    test_high_sugar_lowers_quality,
    test_zero_fiber_lowers_quality,
    test_ultra_processed_diet,
    test_recovery_flags_underfueling_metabolic,
    test_recovery_flags_low_fat_metabolic,
    test_recovery_flags_all_green,
    test_goal_weight_affects_scoring,
    test_not_enough_data,
    test_plant_diversity_bonus,
    test_sodium_penalty,
    test_low_confidence_reduces_total,
    test_sugar_sat_fat_pair_cap,
    test_omega3_presence_quality_bonus,
    test_micro_coverage_sex_aware,
    test_metabolic_support_calorie_swings,
    test_weekly_trend_improving,
    test_weekly_trend_empty,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Nutrition scenario tests (pure function, no DB)")
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
