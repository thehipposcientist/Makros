"""Unit tests for the deterministic Insight Engine.

Run:
    docker exec thallo-backend python -m tests.test_insight_engine
"""
from __future__ import annotations

import inspect
from datetime import date, timedelta

from app.models import MealItem
from app.services.nutrition.ai_classify import insight_tags_from_metadata
from app.services.insights.insight_engine import (
    ActivitySummary,
    CARDIOMETABOLIC_RISK_DISCLAIMER,
    CycleSummary,
    HealthSnapshotSummary,
    InsightContext,
    NutritionSummary,
    RecoveryModalitySummary,
    SleepSummary,
    UserContext,
    WorkoutSummary,
    compute_cardiometabolic_risk_signals,
    compute_blood_sugar_support_pattern,
    compute_blood_pressure_sodium_risk_signal,
    compute_bone_density_support,
    compute_brain_health_support,
    compute_cholesterol_support_pattern,
    compute_cardio_efficiency_trend,
    compute_digestion_patterns,
    compute_energy_availability,
    compute_heart_health_habits,
    compute_healthspan_foundations,
    compute_hormone_support,
    compute_hydration_electrolyte_risk,
    compute_inflammation_support,
    compute_injury_risk,
    compute_muscle_preservation_watch,
    compute_protein_distribution_quality,
    compute_protein_quality_pattern,
    compute_kidney_stone_risk_factors,
    compute_glp1_muscle_preservation_signal,
    compute_all_insight_cards,
    compute_menstrual_cycle_recovery_pattern,
    compute_performance_readiness,
    compute_red_processed_meat_pattern,
    compute_recovery_modality_response,
    compute_recovery_strain,
    compute_sleep_regularity_late_intake,
    compute_sleep_disruptors,
    collect_recent_nutrition,
    extract_insight_features,
    _estimated_servings_from_item,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _ctx(
    *,
    nutrition: NutritionSummary | None = None,
    sleep: SleepSummary | None = None,
    activity: ActivitySummary | None = None,
    workouts: WorkoutSummary | None = None,
    health: HealthSnapshotSummary | None = None,
    user: UserContext | None = None,
    cycle: CycleSummary | None = None,
    recovery_modalities: RecoveryModalitySummary | None = None,
) -> InsightContext:
    today = date.today()
    return InsightContext(
        nutrition=nutrition or NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories=2100,
            avg_calories_when_logged=2150,
            avg_protein_g=155,
            avg_carbs_g=230,
            avg_fat_g=75,
            avg_fiber_g=28,
            avg_sodium_mg=2400,
            avg_alcohol_servings=0,
            avg_animal_protein_g=90,
            avg_plant_protein_g=45,
            avg_energy_availability=35,
            calorie_target=2200,
            protein_target_g=150,
            fat_target_g=70,
            carb_target_g=240,
            avg_water_oz=86,
            hydration_logged_days=9,
            estimated_hydration_target_oz=90,
        ),
        sleep=sleep or SleepSummary(
            window_days=14,
            nights_with_data=11,
            avg_hours=7.4,
            avg_score=82,
            bedtime_std_minutes=35,
            low_sleep_dates=set(),
        ),
        activity=activity or ActivitySummary(
            window_days=14,
            days_with_data=11,
            avg_steps=8200,
            avg_active_energy_kcal=520,
            avg_workout_minutes=38,
            avg_cardio_minutes=24,
            avg_zone2_minutes=16,
            high_sweat_dates={today - timedelta(days=2)},
        ),
        workouts=workouts or WorkoutSummary(
            window_days=28,
            completed_sessions=9,
            completed_dates={today - timedelta(days=i) for i in (1, 3, 5, 8, 11, 15, 19, 23, 27)},
            hard_sessions_7d=2,
            sessions_7d=3,
            sessions_28d=9,
            acute_load_7d=150,
            baseline_load_per_week=145,
            acute_load_ratio=1.03,
            soreness_sessions_14d=0,
            max_muscle_fatigue=0.42,
            late_workout_dates=set(),
            planned_sessions_14d=5,
            today_planned_intensity="moderate",
        ),
        health=health or HealthSnapshotSummary(
            window_days=28,
            days_with_data=20,
            hrv_latest=58,
            hrv_baseline=60,
            rhr_latest=59,
            rhr_baseline=58,
            weight_trend_lbs_per_week=-0.3,
            bp_reading_count=1,
            latest_bp_systolic=118,
            latest_bp_diastolic=74,
        ),
        user=user or UserContext(
            goal="body_recomp",
            goal_pace="moderate",
            age=34,
            sex="male",
            weight_lbs=180,
            height_inches=70,
            training_level="intermediate",
            days_per_week=4,
        ),
        generated_at="2026-05-14T12:00:00+00:00",
        cycle=cycle or CycleSummary(window_days=90),
        recovery_modalities=recovery_modalities or RecoveryModalitySummary(window_days=28),
    )


def _text(card) -> str:
    parts = [
        card.title,
        card.summary,
        *card.drivers,
        *card.positive_factors,
        *card.recommendations,
        card.disclaimer,
    ]
    return " ".join(parts).lower()


def _confidence_rank(value: str) -> int:
    return {"low": 1, "medium": 2, "high": 3}[value]


def _by_offset(values: dict[int, float]) -> dict[date, float]:
    today = date.today()
    return {today - timedelta(days=offset): value for offset, value in values.items()}


def test_feature_extraction_compares_current_and_prior_windows() -> None:
    print("\n[test] features: current vs prior window comparison")
    added_sugar = {offset: 65 for offset in range(0, 6)}
    added_sugar.update({offset: 18 for offset in range(6, 14)})
    added_sugar.update({offset: 20 for offset in range(14, 28)})
    sleep_hours = {offset: 6.0 for offset in range(0, 4)}
    sleep_hours.update({offset: 7.4 for offset in range(4, 14)})
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=14,
            avg_added_sugar_g=39,
            daily_values={"added_sugar_g": _by_offset(added_sugar)},
        ),
        sleep=SleepSummary(
            window_days=14,
            nights_with_data=14,
            avg_hours=7.0,
            hours_by_date=_by_offset(sleep_hours),
        ),
    )
    features = extract_insight_features(ctx)
    sugar = features.metrics["added_sugar_g"]
    sleep = features.metrics["sleep_hours"]
    assert sugar.current_avg_14 is not None and sugar.prior_avg_14 is not None
    assert sugar.current_avg_14 > sugar.prior_avg_14
    assert sugar.days_above_threshold == 6
    assert sugar.longest_bad_streak == 6
    assert sleep.days_below_threshold == 4
    assert sleep.longest_bad_streak == 4
    _ok("feature layer computes deltas, thresholds, and streaks")


def test_isolated_bad_day_does_not_create_high_blood_sugar_severity() -> None:
    print("\n[test] blood sugar support: one isolated high-sugar day stays cautious")
    today = date.today()
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2150,
            avg_added_sugar_g=22,
            avg_fiber_g=30,
            avg_fiber_per_1000_kcal=13,
            refined_grain_servings=1,
            item_count=40,
            classified_item_count=36,
            daily_values={
                "added_sugar_g": _by_offset({0: 70, **{i: 15 for i in range(1, 14)}}),
            },
            pattern_dates={"whole_grain": {today - timedelta(days=i) for i in range(0, 6)}},
        ),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=8500),
    )
    card = compute_blood_sugar_support_pattern(ctx)
    assert card.status in {"low", "moderate"}, card
    assert card.score >= 65, card
    _ok("single-day sugar spike is not treated like a persistent pattern")


def test_protective_factors_soften_red_meat_score() -> None:
    print("\n[test] red meat: protein diversity and low sat fat soften score")
    today = date.today()
    meat_dates = {today - timedelta(days=i) for i in range(0, 5)}
    base = NutritionSummary(
        window_days=14,
        days_with_data=12,
        avg_calories_when_logged=2200,
        avg_saturated_fat_g=30,
        processed_meat_servings=2,
        red_meat_servings=5,
        item_count=48,
        classified_item_count=44,
        pattern_dates={"red_meat": meat_dates, "processed_meat": {today - timedelta(days=0), today - timedelta(days=2)}},
        daily_values={"red_meat_servings": {d: 1 for d in meat_dates}},
    )
    softened = NutritionSummary(
        window_days=14,
        days_with_data=12,
        avg_calories_when_logged=2200,
        avg_saturated_fat_g=14,
        processed_meat_servings=2,
        red_meat_servings=5,
        item_count=48,
        classified_item_count=44,
        pattern_dates={
            "red_meat": meat_dates,
            "processed_meat": {today - timedelta(days=0), today - timedelta(days=2)},
            "seafood": {today - timedelta(days=1), today - timedelta(days=8)},
            "legume": {today - timedelta(days=3), today - timedelta(days=5), today - timedelta(days=9)},
            "nut_seed": {today - timedelta(days=4), today - timedelta(days=6)},
            "whole_grain": {today - timedelta(days=0), today - timedelta(days=7)},
        },
        daily_values={"red_meat_servings": {d: 1 for d in meat_dates}},
    )
    high = compute_red_processed_meat_pattern(_ctx(nutrition=base))
    lower = compute_red_processed_meat_pattern(_ctx(nutrition=softened))
    assert lower.score < high.score, (high, lower)
    assert any("soften" in p.lower() or "variety" in p.lower() for p in lower.positive_factors), lower.positive_factors
    _ok("protective pattern reduces meat concern without hiding the exposure")


def test_insight_engine_does_not_infer_food_patterns_from_names() -> None:
    print("\n[test] food enrichment: insight engine does not scan food names")
    source = inspect.getsource(collect_recent_nutrition)
    forbidden_tokens = (
        "_is_red_meat_name",
        "_is_processed_meat_name",
        "_contains_any",
        "_RED_MEAT_TERMS",
        "_SSB_TERMS",
        "food_name or \"\").lower()",
    )
    for token in forbidden_tokens:
        assert token not in source, token

    class LegacyFlagsOnly:
        insight_tags = None
        processed_meat_flag = True
        refined_grain_flag = True
        likely_plant_foods = ["lentils"]

    class ExplicitTags:
        insight_tags = ["processed_meat", "legume"]
        processed_meat_flag = False
        likely_plant_foods = []

    assert insight_tags_from_metadata(LegacyFlagsOnly()) == set()
    assert insight_tags_from_metadata(ExplicitTags()) == {"processed_meat", "legume"}
    _ok("only explicit enrichment tags become Health Insight evidence")


def test_meat_serving_estimator_uses_logged_ounces() -> None:
    print("\n[test] red/processed meat: quantity estimator reads oz units")
    steak = MealItem(
        meal_id=1,
        food_name="sirloin steak",
        quantity=12,
        unit="oz",
        calories=720,
        protein_g=70,
        carbs_g=0,
        fat_g=48,
    )
    beef_stick = MealItem(
        meal_id=1,
        food_name="beef stick",
        quantity=2,
        unit="oz",
        calories=180,
        protein_g=12,
        carbs_g=2,
        fat_g=14,
    )
    assert 3.9 <= _estimated_servings_from_item(steak) <= 4.1
    assert 1.1 <= _estimated_servings_from_item(beef_stick, reference_grams=50.0) <= 1.2
    _ok("12 oz steak and 2 oz processed meat no longer collapse to one frequency hit")


def test_red_meat_amount_uses_weekly_guidance_not_meal_count() -> None:
    print("\n[test] red meat: amount is judged against weekly guidance")
    moderate = compute_red_processed_meat_pattern(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2200,
            avg_saturated_fat_g=12,
            red_meat_servings=4,
            item_count=42,
            classified_item_count=38,
        )
    ))
    high = compute_red_processed_meat_pattern(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2200,
            avg_saturated_fat_g=12,
            red_meat_servings=13,
            item_count=42,
            classified_item_count=38,
        )
    ))
    assert moderate.status == "low", moderate
    assert any("12 oz" in text for text in moderate.positive_factors), moderate.positive_factors
    assert high.score > moderate.score, (moderate, high)
    assert "oz" in _text(high)
    _ok("one 12 oz steak is treated differently from a high 14-day amount")


def test_red_processed_meat_pattern_surfaces_amount_without_prediction() -> None:
    print("\n[test] red/processed meat: amount screen, no cancer prediction")
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            avg_calories_when_logged=2200,
            avg_saturated_fat_g=34,
            processed_meat_servings=4,
            red_meat_servings=5,
            item_count=42,
            classified_item_count=38,
        )
    )
    card = compute_red_processed_meat_pattern(ctx)
    text = _text(card)
    assert card.status in {"elevated", "high"}, card
    assert "processed meat totaled" in text
    assert "does not estimate cancer risk" in text
    assert "you will get cancer" not in text
    _ok("red/processed meat card stays as a pattern screen")


def test_blood_sugar_support_uses_added_sugar_fiber_and_refined_grains() -> None:
    print("\n[test] blood sugar support: added sugar + low fiber")
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_calories_when_logged=2050,
            avg_added_sugar_g=82,
            avg_fiber_g=12,
            avg_fiber_per_1000_kcal=5,
            refined_grain_servings=9,
            item_count=36,
            classified_item_count=32,
        ),
        activity=ActivitySummary(window_days=14, days_with_data=8, avg_steps=4300),
    )
    card = compute_blood_sugar_support_pattern(ctx)
    text = _text(card)
    assert card.risk_direction == "higher_is_better"
    assert card.status in {"elevated", "high"}, card
    assert "added sugar" in text
    assert "fiber" in text
    assert "does not diagnose diabetes" in text
    _ok("blood sugar support reacts to sugar/fiber pattern")


def test_cholesterol_support_uses_sat_fat_fiber_and_protein_sources() -> None:
    print("\n[test] cholesterol support: saturated fat + low fiber")
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=2200,
            avg_saturated_fat_g=34,
            avg_fiber_g=13,
            avg_animal_protein_g=125,
            avg_plant_protein_g=12,
            processed_meat_servings=2,
            omega3_servings=0,
            seafood_servings=0,
            item_count=44,
            classified_item_count=40,
        )
    )
    card = compute_cholesterol_support_pattern(ctx)
    text = _text(card)
    assert card.risk_direction == "higher_is_better"
    assert card.status in {"elevated", "high"}, card
    assert "saturated fat" in text
    assert "does not estimate cholesterol labs" in text
    _ok("cholesterol support highlights diet signals without lab claims")


def test_recovery_strain_responds_to_sleep_load_and_deficit() -> None:
    print("\n[test] recovery strain: poor sleep + workload spike + deficit")
    ctx = _ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=5.8, bedtime_std_minutes=110),
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=12,
            hard_sessions_7d=5,
            sessions_7d=6,
            sessions_28d=12,
            acute_load_7d=360,
            baseline_load_per_week=180,
            acute_load_ratio=2.0,
            planned_sessions_14d=6,
        ),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            avg_calories_when_logged=1500,
            avg_protein_g=140,
            avg_carbs_g=120,
            avg_fat_g=50,
            calorie_target=2200,
        ),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=20,
            hrv_latest=42,
            hrv_baseline=60,
            rhr_latest=66,
            rhr_baseline=58,
        ),
    )
    card = compute_recovery_strain(ctx)
    assert card.status in {"elevated", "high"}, card
    assert card.risk_direction == "higher_is_worse"
    assert card.score >= 70, card
    assert len(card.drivers) >= 3
    _ok("recovery strain rises with combined stressors")


def test_hormone_support_uses_support_environment_language() -> None:
    print("\n[test] hormone support: support environment, no biomarker claims")
    ctx = _ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.0),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=1550,
            avg_fat_g=22,
            avg_protein_g=130,
            calorie_target=2300,
        ),
        health=HealthSnapshotSummary(window_days=28, days_with_data=8, weight_trend_lbs_per_week=-2.0),
    )
    card = compute_hormone_support(ctx)
    assert card.status == "high", card
    assert card.score < 40, card
    assert "support environment" in _text(card)
    assert "not a hormone test" in _text(card)
    assert any("support score" in d or "support environment" in d for d in card.drivers)
    assert "testosterone" not in _text(card)
    assert "cortisol" not in _text(card)
    _ok("card avoids actual hormone estimates")


def test_hormone_support_unknown_has_no_display_score() -> None:
    print("\n[test] hormone support: unknown does not expose display score")
    card = compute_hormone_support(_ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=1, avg_hours=7.0),
        nutrition=NutritionSummary(window_days=14),
        workouts=WorkoutSummary(window_days=28),
        health=HealthSnapshotSummary(window_days=28),
    ))
    payload = card.to_dict()
    assert card.status == "unknown", card
    assert payload["display_score"] is None, payload
    assert payload["debug"]["score_available"] is False, payload
    assert "high concern" not in _text(card)
    _ok("unknown score is marked unavailable")


def test_hormone_support_good_when_core_signals_supportive() -> None:
    print("\n[test] hormone support: supportive baseline scores good")
    card = compute_hormone_support(_ctx())
    assert card.status == "low", card
    assert card.score >= 75, card
    assert card.risk_direction == "higher_is_better"
    assert any("sleep" in p.lower() or "calories" in p.lower() for p in card.positive_factors), card.positive_factors
    _ok("adequate sleep/fueling/fat/vitals produce supportive read")


def test_hormone_support_hard_training_with_support_is_not_over_penalized() -> None:
    print("\n[test] hormone support: hard training with support stays reasonable")
    today = date.today()
    card = compute_hormone_support(_ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=12, avg_hours=7.5),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2350,
            avg_protein_g=170,
            avg_carbs_g=330,
            avg_fat_g=80,
            avg_fiber_g=28,
            calorie_target=2350,
            pattern_dates={"unsaturated_fat": {today - timedelta(days=i) for i in range(4)}},
        ),
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=7,
            hard_sessions_7d=3,
            sessions_7d=4,
            acute_load_ratio=1.45,
            training_strain_points_14d=5.0,
            training_strain_confidence=1.0,
            hard_resistance_sessions_14d=4,
            resistance_sessions_14d=4,
        ),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=18,
            hrv_latest=60,
            hrv_baseline=60,
            rhr_latest=58,
            rhr_baseline=58,
            weight_trend_lbs_per_week=-0.2,
        ),
    ))
    assert card.score >= 70, card
    assert card.status in {"low", "moderate"}, card
    assert "training_recovery_load" in card.debug["domain_penalties"], card.debug
    assert card.debug["domain_penalties"]["training_recovery_load"]["applied_points"] <= 6, card.debug
    _ok("hard training alone is not treated as a major support gap")


def test_hormone_support_hard_training_with_low_fueling_sleep_is_penalized() -> None:
    print("\n[test] hormone support: hard training plus low fueling/sleep drops score")
    card = compute_hormone_support(_ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.0),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=1700,
            avg_protein_g=90,
            avg_carbs_g=110,
            avg_fat_g=50,
            calorie_target=2300,
        ),
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=8,
            hard_sessions_7d=4,
            sessions_7d=5,
            acute_load_ratio=1.55,
            training_strain_points_14d=6.0,
            training_strain_confidence=1.0,
            hard_glycolytic_sessions_14d=3,
            hard_resistance_sessions_14d=2,
            resistance_sessions_14d=2,
        ),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=18,
            hrv_latest=48,
            hrv_baseline=60,
            rhr_latest=65,
            rhr_baseline=58,
            weight_trend_lbs_per_week=-1.0,
        ),
    ))
    assert card.score < 55, card
    assert card.status in {"elevated", "high"}, card
    assert any("carbohydrate" in d.lower() for d in card.drivers + [p["reason"] for p in card.debug["applied_penalties"]]), card
    assert "macro_adequacy" in card.debug["domain_penalties"], card.debug
    _ok("hard training becomes a concern when recovery inputs are weak")


def test_hormone_support_low_fat_respects_domain_cap() -> None:
    print("\n[test] hormone support: low fat penalty is capped")
    today = date.today()
    low_fat_daily = {today - timedelta(days=i): 20 for i in range(14)}
    calories_daily = {today - timedelta(days=i): 2000 for i in range(14)}
    card = compute_hormone_support(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=14,
            avg_calories_when_logged=2000,
            avg_protein_g=150,
            avg_carbs_g=260,
            avg_fat_g=20,
            calorie_target=2000,
            daily_values={"fat_g": low_fat_daily, "calories": calories_daily},
        ),
        sleep=SleepSummary(window_days=14, nights_with_data=12, avg_hours=7.4),
        health=HealthSnapshotSummary(window_days=28, days_with_data=12, hrv_latest=60, hrv_baseline=60, rhr_latest=58, rhr_baseline=58, weight_trend_lbs_per_week=0.0),
    ))
    fat_domain = card.debug["domain_penalties"]["fat_adequacy"]
    assert fat_domain["raw_points"] > fat_domain["applied_points"], card.debug
    assert fat_domain["applied_points"] == 18.0, card.debug
    assert card.score >= 58, card
    _ok("low-fat signals do not stack beyond the fat domain cap")


def test_hormone_support_fat_quality_is_light_modifier() -> None:
    print("\n[test] hormone support: fat quality stays light")
    balanced = compute_hormone_support(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=2200,
            avg_protein_g=155,
            avg_carbs_g=240,
            avg_fat_g=75,
            avg_saturated_fat_g=24,
            calorie_target=2200,
        ),
    ))
    higher_sat = compute_hormone_support(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=2200,
            avg_protein_g=155,
            avg_carbs_g=240,
            avg_fat_g=75,
            avg_saturated_fat_g=36,
            calorie_target=2200,
        ),
    ))
    balanced_keys = {p["key"] for p in balanced.debug["applied_penalties"]}
    higher_fat_quality = [p for p in higher_sat.debug["applied_penalties"] if p["key"] == "fat_quality"]
    assert "fat_quality" not in balanced_keys, balanced.debug
    assert higher_fat_quality, higher_sat.debug
    assert higher_fat_quality[0]["raw_points"] <= 4.0, higher_sat.debug
    assert higher_sat.debug["domain_penalties"]["fat_adequacy"]["applied_points"] <= 4.0, higher_sat.debug
    _ok("saturated-fat quality signal is unit-correct and capped")


def test_hormone_support_weight_loss_uses_percent_when_body_weight_available() -> None:
    print("\n[test] hormone support: weight loss percent-based penalty")
    stable = compute_hormone_support(_ctx(
        user=UserContext(weight_lbs=200),
        health=HealthSnapshotSummary(window_days=28, days_with_data=12, hrv_latest=60, hrv_baseline=60, rhr_latest=58, rhr_baseline=58, weight_trend_lbs_per_week=0.0),
    ))
    losing = compute_hormone_support(_ctx(
        user=UserContext(weight_lbs=200),
        health=HealthSnapshotSummary(window_days=28, days_with_data=12, hrv_latest=60, hrv_baseline=60, rhr_latest=58, rhr_baseline=58, weight_trend_lbs_per_week=-3.0),
    ))
    assert losing.score < stable.score, (stable, losing)
    assert any(p["key"] == "weight_loss_pace_pct" for p in losing.debug["applied_penalties"]), losing.debug
    assert any("relative to body weight" in p["reason"].lower() for p in losing.debug["applied_penalties"]), losing.debug
    _ok("body-weight-aware loss rate is used when possible")


def test_hormone_support_weight_loss_lbs_fallback_without_body_weight() -> None:
    print("\n[test] hormone support: weight loss lb/week fallback")
    card = compute_hormone_support(_ctx(
        user=UserContext(weight_lbs=None),
        health=HealthSnapshotSummary(window_days=28, days_with_data=12, hrv_latest=60, hrv_baseline=60, rhr_latest=58, rhr_baseline=58, weight_trend_lbs_per_week=-2.2),
    ))
    assert any(p["key"] == "weight_loss_pace_lbs" for p in card.debug["applied_penalties"]), card.debug
    assert any("lb/week" in p["reason"] for p in card.debug["applied_penalties"]), card.debug
    _ok("legacy lb/week threshold remains available")


def test_hormone_support_protein_penalty_requires_body_weight_and_context() -> None:
    print("\n[test] hormone support: protein adequacy is contextual")
    with_weight = compute_hormone_support(_ctx(
        user=UserContext(weight_lbs=180),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=2050,
            avg_protein_g=70,
            avg_carbs_g=240,
            avg_fat_g=70,
            calorie_target=2300,
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=5, hard_sessions_7d=2, training_strain_points_14d=2.8, training_strain_confidence=1.0, hard_resistance_sessions_14d=3),
    ))
    without_weight = compute_hormone_support(_ctx(
        user=UserContext(weight_lbs=None),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=2050,
            avg_protein_g=70,
            avg_carbs_g=240,
            avg_fat_g=70,
            calorie_target=2300,
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=5, hard_sessions_7d=2, training_strain_points_14d=2.8, training_strain_confidence=1.0, hard_resistance_sessions_14d=3),
    ))
    assert any(p["key"] == "protein_adequacy" for p in with_weight.debug["applied_penalties"]), with_weight.debug
    assert not any(p["key"].startswith("protein_adequacy") for p in without_weight.debug["applied_penalties"]), without_weight.debug
    assert with_weight.score < without_weight.score, (with_weight, without_weight)
    _ok("protein signal waits for body weight and relevant recovery context")


def test_hormone_support_missing_optional_data_does_not_create_false_penalties() -> None:
    print("\n[test] hormone support: missing optional data is safe")
    card = compute_hormone_support(_ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=8, avg_hours=7.1),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_calories_when_logged=2100,
            avg_fat_g=70,
            calorie_target=2150,
        ),
        workouts=WorkoutSummary(window_days=28),
        health=HealthSnapshotSummary(window_days=28),
        user=UserContext(weight_lbs=None),
    ))
    assert card.status != "unknown", card
    assert card.score >= 70, card
    assert not any(p["domain"] in {"alcohol_recovery", "macro_adequacy"} for p in card.debug["applied_penalties"]), card.debug
    _ok("optional signals stay neutral when absent")


def test_hydration_risk_handles_low_water_and_activity() -> None:
    print("\n[test] hydration risk: low water + high activity")
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_water_oz=38,
            hydration_logged_days=8,
            estimated_hydration_target_oz=92,
            avg_sodium_mg=3900,
            avg_alcohol_servings=0.5,
        ),
        activity=ActivitySummary(window_days=14, days_with_data=9, avg_active_energy_kcal=820, avg_workout_minutes=66),
    )
    card = compute_hydration_electrolyte_risk(ctx)
    assert card.status in {"elevated", "high"}, card
    assert "hydration" in card.data_used
    assert any("water" in d.lower() for d in card.drivers), card.drivers
    _ok("hydration/electrolyte risk elevates without fake precision")


def test_kidney_stone_confidence_drops_without_sodium() -> None:
    print("\n[test] kidney stone risk factors: missing sodium lowers confidence")
    full = compute_kidney_stone_risk_factors(_ctx())
    missing_sodium = compute_kidney_stone_risk_factors(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_water_oz=80,
            hydration_logged_days=8,
            estimated_hydration_target_oz=90,
            avg_animal_protein_g=90,
            avg_protein_g=145,
        )
    ))
    assert _confidence_rank(missing_sodium.confidence) <= _confidence_rank(full.confidence), (full, missing_sodium)
    assert "sodium logs" in missing_sodium.missing_data
    assert "predict stones" in missing_sodium.summary
    _ok("missing sodium changes confidence, not fabricated claims")


def test_energy_availability_detects_deficit_plus_training() -> None:
    print("\n[test] energy availability: deficit plus high training")
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calories_when_logged=1450,
            calorie_target=2300,
            avg_protein_g=130,
            protein_target_g=150,
            avg_energy_availability=22,
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=12, sessions_7d=6, hard_sessions_7d=4, planned_sessions_14d=6),
        activity=ActivitySummary(window_days=14, days_with_data=10, avg_active_energy_kcal=850),
    )
    card = compute_energy_availability(ctx)
    assert card.score < 50, card
    assert card.status in {"elevated", "high"}
    assert any("calories" in d.lower() for d in card.drivers), card.drivers
    _ok("energy availability drops with low intake and high demand")


def test_injury_risk_detects_workload_spike_and_soreness() -> None:
    print("\n[test] injury risk: workload spike + soreness")
    ctx = _ctx(
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=10,
            hard_sessions_7d=5,
            sessions_7d=6,
            sessions_28d=10,
            acute_load_7d=400,
            baseline_load_per_week=180,
            acute_load_ratio=2.2,
            soreness_sessions_14d=3,
            max_muscle_fatigue=0.85,
        ),
        sleep=SleepSummary(window_days=14, nights_with_data=9, avg_hours=6.1),
    )
    card = compute_injury_risk(ctx)
    assert card.status == "high", card
    assert any("workload" in d.lower() for d in card.drivers), card.drivers
    assert any("soreness" in d.lower() for d in card.drivers), card.drivers
    _ok("injury risk rises with load spike and soreness signals")


def test_sleep_disruptors_requires_enough_observations() -> None:
    print("\n[test] sleep disruptors: enough observations gate")
    today = date.today()
    sparse = compute_sleep_disruptors(_ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=4, avg_hours=6.0, low_sleep_dates={today})
    ))
    assert sparse.status == "unknown", sparse

    richer = compute_sleep_disruptors(_ctx(
        sleep=SleepSummary(
            window_days=14,
            nights_with_data=8,
            avg_hours=6.3,
            bedtime_std_minutes=105,
            low_sleep_dates={today - timedelta(days=1), today - timedelta(days=3), today - timedelta(days=5)},
        ),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            late_meal_dates={today - timedelta(days=2), today - timedelta(days=4)},
            alcohol_dates=set(),
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=6, late_workout_dates={today - timedelta(days=2), today - timedelta(days=4)}),
    ))
    assert richer.status in {"elevated", "high"}, richer
    assert any("late" in d.lower() for d in richer.drivers), richer.drivers
    _ok("sleep disruptors waits for enough sleep observations")


def test_sleep_disruptors_requires_repeated_pre_sleep_cluster() -> None:
    print("\n[test] sleep disruptors: one late meal is not a disruptor pattern")
    today = date.today()
    card = compute_sleep_disruptors(_ctx(
        sleep=SleepSummary(
            window_days=14,
            nights_with_data=9,
            avg_hours=6.4,
            bedtime_std_minutes=40,
            low_sleep_dates={today - timedelta(days=1), today - timedelta(days=3), today - timedelta(days=5)},
        ),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            late_meal_dates={today - timedelta(days=2)},
            alcohol_dates=set(),
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=5, late_workout_dates=set()),
    ))
    assert card.status in {"low", "moderate"}, card
    assert not any("late meals" in d.lower() and "times" in d.lower() for d in card.drivers), card.drivers
    _ok("sleep disruptors needs repeated pre-sleep exposure")


def test_inferred_caffeine_does_not_create_high_confidence_sleep_disruptor() -> None:
    print("\n[test] caffeine: inferred late caffeine caps sleep confidence")
    today = date.today()
    card = compute_sleep_disruptors(_ctx(
        sleep=SleepSummary(
            window_days=14,
            nights_with_data=9,
            avg_hours=6.2,
            bedtime_std_minutes=55,
            low_sleep_dates={today - timedelta(days=1), today - timedelta(days=3), today - timedelta(days=5)},
        ),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            daily_values={"late_caffeine": {today - timedelta(days=2): 1, today - timedelta(days=4): 1}},
        ),
    ))
    assert card.confidence != "high", card
    assert any("inferred" in r.lower() for r in card.confidence_reasons + card.drivers), (card.confidence_reasons, card.drivers)
    _ok("food-tag caffeine remains capped instead of certain")


def test_structured_caffeine_timing_raises_sleep_confidence() -> None:
    print("\n[test] caffeine: structured timing improves sleep confidence")
    today = date.today()
    inferred = compute_sleep_disruptors(_ctx(
        sleep=SleepSummary(
            window_days=14,
            nights_with_data=9,
            avg_hours=6.2,
            bedtime_std_minutes=55,
            low_sleep_dates={today - timedelta(days=1), today - timedelta(days=3), today - timedelta(days=5)},
        ),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            daily_values={"late_caffeine": {today - timedelta(days=2): 1, today - timedelta(days=4): 1}},
        ),
    ))
    structured = compute_sleep_disruptors(_ctx(
        sleep=SleepSummary(
            window_days=14,
            nights_with_data=9,
            avg_hours=6.2,
            bedtime_std_minutes=55,
            low_sleep_dates={today - timedelta(days=1), today - timedelta(days=3), today - timedelta(days=5)},
        ),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            avg_caffeine_mg=180,
            caffeine_logged_days=2,
            late_caffeine_mg=260,
            late_caffeine_structured_count=2,
            daily_values={"late_caffeine_structured": {today - timedelta(days=2): 1, today - timedelta(days=4): 1}},
        ),
    ))
    assert _confidence_rank(structured.confidence) > _confidence_rank(inferred.confidence), (inferred, structured)
    assert any("structured caffeine" in d.lower() for d in structured.drivers), structured.drivers
    _ok("first-class caffeine timing carries stronger evidence")


def test_performance_readiness_combines_fueling_vitals_and_plan() -> None:
    print("\n[test] performance readiness: low carbs + poor vitals + hard plan")
    ctx = _ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.0),
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=9,
            avg_carbs_g=100,
            avg_calories_when_logged=1900,
            calorie_target=2200,
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=9, max_muscle_fatigue=0.8, today_planned_intensity="hard"),
        health=HealthSnapshotSummary(window_days=28, days_with_data=18, hrv_latest=42, hrv_baseline=60, rhr_latest=66, rhr_baseline=58),
    )
    card = compute_performance_readiness(ctx)
    assert card.score < 60, card
    assert any("carbohydrate" in d.lower() for d in card.drivers), card.drivers
    assert card.recommendations
    _ok("performance readiness gives today-oriented guidance")


def test_injury_and_readiness_use_today_plan_overlap() -> None:
    print("\n[test] session specificity: sore muscles overlap today's plan")
    today = date.today()
    workouts = WorkoutSummary(
        window_days=28,
        completed_sessions=8,
        hard_sessions_7d=3,
        sessions_7d=4,
        sessions_28d=8,
        acute_load_7d=260,
        baseline_load_per_week=180,
        acute_load_ratio=1.44,
        soreness_sessions_14d=2,
        max_muscle_fatigue=0.78,
        completed_dates={today - timedelta(days=i) for i in (1, 3, 5, 8, 12, 16, 20, 24)},
        hard_session_dates={today - timedelta(days=i) for i in (1, 3, 5)},
        soreness_dates={today - timedelta(days=1), today - timedelta(days=3)},
        soreness_by_muscle_group={"quads": {today - timedelta(days=1), today - timedelta(days=3)}},
        today_planned_intensity="heavy",
        today_target_muscle_groups={"quads", "glutes"},
    )
    injury = compute_injury_risk(_ctx(
        workouts=workouts,
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.3),
    ))
    readiness = compute_performance_readiness(_ctx(
        workouts=workouts,
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.3),
        nutrition=NutritionSummary(window_days=14, days_with_data=9, avg_carbs_g=160, avg_water_oz=80, estimated_hydration_target_oz=90),
    ))
    assert any("today" in d.lower() and "quads" in d.lower() for d in injury.drivers), injury.drivers
    assert any("quads" in d.lower() for d in readiness.drivers + readiness.recommendations), (readiness.drivers, readiness.recommendations)
    assert readiness.score < 70, readiness
    _ok("injury and readiness cards become session-specific")


def test_feature_extraction_uses_dated_workout_context_for_today_overlap() -> None:
    print("\n[test] features: dated workout context anchors today-plan overlap")
    today = date.today()
    features = extract_insight_features(_ctx(
        nutrition=NutritionSummary(window_days=14),
        sleep=SleepSummary(window_days=14),
        activity=ActivitySummary(window_days=14),
        health=HealthSnapshotSummary(window_days=28),
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=2,
            completed_dates={today - timedelta(days=1), today - timedelta(days=3)},
            soreness_dates={today - timedelta(days=1), today - timedelta(days=3)},
            soreness_by_muscle_group={"quads": {today - timedelta(days=1), today - timedelta(days=3)}},
            today_target_muscle_groups={"quads", "glutes"},
            today_planned_intensity="heavy",
        ),
    ))
    assert "quads" in features.workouts.today_sore_muscle_overlap, features.workouts
    _ok("feature layer uses workout/check-in dates instead of stale generated_at only")


def test_pain_body_part_overlap_affects_injury_and_readiness() -> None:
    print("\n[test] pain detail: body-part overlap affects session cards")
    workouts = WorkoutSummary(
        window_days=28,
        completed_sessions=6,
        sessions_7d=3,
        hard_sessions_7d=2,
        recent_pain_body_parts={"quads"},
        today_pain_body_part_overlap={"quads"},
        today_target_muscle_groups={"quads", "glutes"},
        today_planned_intensity="heavy",
    )
    injury = compute_injury_risk(_ctx(workouts=workouts))
    readiness = compute_performance_readiness(_ctx(workouts=workouts))
    assert any("painful" in d.lower() and "quads" in d.lower() for d in injury.drivers), injury.drivers
    assert any("painful" in d.lower() and "quads" in d.lower() for d in readiness.drivers), readiness.drivers
    _ok("pain body-part detail makes cards session-specific")


def test_movement_pattern_ramp_needs_corroboration() -> None:
    print("\n[test] movement ramp: corroboration required")
    ramp_only = WorkoutSummary(
        window_days=28,
        completed_sessions=6,
        sessions_7d=3,
        hard_sessions_7d=1,
        movement_pattern_counts_14d={"squat": 5},
        movement_pattern_counts_prior_14d={"squat": 1},
        ramped_movement_patterns={"squat"},
        today_target_movement_patterns={"squat"},
        today_planned_intensity="moderate",
    )
    with_soreness = WorkoutSummary(
        window_days=28,
        completed_sessions=6,
        sessions_7d=3,
        hard_sessions_7d=1,
        soreness_sessions_14d=2,
        soreness_dates={date.today() - timedelta(days=1), date.today() - timedelta(days=3)},
        movement_pattern_counts_14d={"squat": 5},
        movement_pattern_counts_prior_14d={"squat": 1},
        ramped_movement_patterns={"squat"},
        today_target_movement_patterns={"squat"},
        today_planned_intensity="moderate",
    )
    card_ramp_only = compute_injury_risk(_ctx(workouts=ramp_only))
    card_with_soreness = compute_injury_risk(_ctx(workouts=with_soreness))
    assert card_ramp_only.status != "high", card_ramp_only
    assert card_with_soreness.score > card_ramp_only.score, (card_ramp_only, card_with_soreness)
    assert any("movement-pattern" in d.lower() for d in card_with_soreness.drivers), card_with_soreness.drivers
    _ok("movement ramp is stronger only with soreness/pain context")


def test_digestion_patterns_requires_symptom_checkin() -> None:
    print("\n[test] digestion patterns: requires symptoms/check-ins")
    today = date.today()
    no_symptom = compute_digestion_patterns(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=8, avg_fiber_g=30)
    ))
    assert no_symptom.status == "unknown", no_symptom

    with_symptom = compute_digestion_patterns(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_fiber_g=34,
            fiber_spike_dates={today - timedelta(days=1), today - timedelta(days=3)},
            digestion_food_dates={
                "_symptom_dates": {today - timedelta(days=1), today - timedelta(days=3)},
                "dairy": {today - timedelta(days=1), today - timedelta(days=3)},
            },
        )
    ))
    assert with_symptom.status in {"moderate", "elevated", "high"}, with_symptom
    assert any("hypothesis" in d.lower() for d in with_symptom.drivers), with_symptom.drivers
    _ok("digestion card avoids diagnosis and requires repeated hypothesis signals")


def test_digestion_trigger_requires_repeated_exposure() -> None:
    print("\n[test] digestion patterns: one exposure does not surface trigger")
    today = date.today()
    card = compute_digestion_patterns(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_fiber_g=26,
            digestion_food_dates={
                "_symptom_dates": {today - timedelta(days=1), today - timedelta(days=3)},
                "dairy": {today - timedelta(days=1)},
            },
        )
    ))
    assert card.status in {"low", "moderate"}, card
    assert not any("dairy-containing meals preceded" in d.lower() for d in card.drivers), card.drivers
    assert any("no repeated" in p.lower() for p in card.positive_factors), card.positive_factors
    assert card.confidence != "high", card
    assert any("no repeated" in r.lower() for r in card.confidence_reasons), card.confidence_reasons
    _ok("single digestion overlap remains hypothesis-limited")


def test_heart_health_habits_uses_bp_without_diagnosis() -> None:
    print("\n[test] heart health habits: BP wording stays non-diagnostic")
    ctx = _ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=10, avg_sodium_mg=3900, avg_alcohol_servings=1.2),
        activity=ActivitySummary(window_days=14, days_with_data=10, avg_steps=4200, avg_cardio_minutes=5),
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.1),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=12,
            weight_trend_lbs_per_week=1.8,
            bp_reading_count=2,
            latest_bp_systolic=132,
            latest_bp_diastolic=82,
        ),
    )
    card = compute_heart_health_habits(ctx)
    text = _text(card)
    assert card.score < 60, card
    assert "blood-pressure reading" in text
    assert "hypertension" not in text
    _ok("heart health habit card avoids diagnosis language")


def test_inferred_potassium_and_calcium_are_confidence_capped() -> None:
    print("\n[test] micronutrients: proxies stay capped")
    today = date.today()
    inferred = compute_heart_health_habits(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_sodium_mg=2300,
            avg_fiber_g=30,
            avg_alcohol_servings=0,
            pattern_dates={"potassium_proxy": {today - timedelta(days=i) for i in range(6)}},
        ),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=8500, avg_cardio_minutes=25, avg_zone2_minutes=20),
        sleep=SleepSummary(window_days=14, nights_with_data=12, avg_hours=7.4),
        health=HealthSnapshotSummary(window_days=28, days_with_data=12, weight_trend_lbs_per_week=0.0, bp_reading_count=2, latest_bp_systolic=116, latest_bp_diastolic=72),
    ))
    structured = compute_heart_health_habits(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_sodium_mg=2300,
            avg_fiber_g=30,
            avg_potassium_mg=3600,
            avg_alcohol_servings=0,
            micronutrient_logged_days=8,
        ),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=8500, avg_cardio_minutes=25, avg_zone2_minutes=20),
        sleep=SleepSummary(window_days=14, nights_with_data=12, avg_hours=7.4),
        health=HealthSnapshotSummary(window_days=28, days_with_data=12, weight_trend_lbs_per_week=0.0, bp_reading_count=2, latest_bp_systolic=116, latest_bp_diastolic=72),
    ))
    assert inferred.confidence != "high", inferred
    assert _confidence_rank(structured.confidence) >= _confidence_rank(inferred.confidence), (inferred, structured)
    _ok("food proxies do not become structured micronutrient certainty")


def test_missing_stone_history_caps_kidney_stone_severity() -> None:
    print("\n[test] kidney stone: unknown history caps severity")
    today = date.today()
    card = compute_kidney_stone_risk_factors(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_water_oz=40,
            hydration_logged_days=10,
            estimated_hydration_target_oz=95,
            avg_sodium_mg=4200,
            avg_animal_protein_g=140,
            avg_protein_g=170,
            daily_values={
                "high_oxalate": {today - timedelta(days=i): 1 for i in range(5)},
                "water_oz": {today - timedelta(days=i): 40 for i in range(5)},
                "sodium_mg": {today - timedelta(days=i): 4200 for i in range(5)},
            },
        ),
        activity=ActivitySummary(window_days=14, days_with_data=10, high_sweat_dates={today - timedelta(days=i) for i in range(4)}),
    ))
    assert card.score <= 68, card
    assert "stone history" in card.missing_data, card.missing_data
    _ok("unknown stone history keeps severity bounded")


def test_stone_history_increases_kidney_stone_sensitivity() -> None:
    print("\n[test] kidney stone: history increases sensitivity")
    today = date.today()
    nutrition = NutritionSummary(
        window_days=14,
        days_with_data=10,
        avg_water_oz=40,
        hydration_logged_days=10,
        estimated_hydration_target_oz=95,
        avg_sodium_mg=4200,
        avg_animal_protein_g=140,
        avg_protein_g=170,
        daily_values={
            "high_oxalate": {today - timedelta(days=i): 1 for i in range(5)},
            "water_oz": {today - timedelta(days=i): 40 for i in range(5)},
            "sodium_mg": {today - timedelta(days=i): 4200 for i in range(5)},
        },
    )
    unknown = compute_kidney_stone_risk_factors(_ctx(nutrition=nutrition, user=UserContext(weight_lbs=180, kidney_stone_history="unknown")))
    known = compute_kidney_stone_risk_factors(_ctx(nutrition=nutrition, user=UserContext(weight_lbs=180, kidney_stone_history="true", stone_type="calcium_oxalate")))
    assert known.score > unknown.score, (unknown, known)
    assert any("history" in d.lower() for d in known.drivers), known.drivers
    _ok("reported history raises sensitivity without prediction language")


def test_cycle_cards_do_not_generate_without_opt_in() -> None:
    print("\n[test] cycle: no visible card without opt-in")
    cards = [
        card for card in compute_all_insight_cards(_ctx())
        if card.status != "unknown"
    ]
    assert not any(card.id == "menstrual_cycle_recovery_pattern" for card in cards), cards
    _ok("cycle card stays hidden until opt-in")


def test_male_users_do_not_receive_cycle_card_even_with_opt_in() -> None:
    print("\n[test] cycle: male users do not receive cycle card")
    today = date.today()
    cards = compute_all_insight_cards(_ctx(
        user=UserContext(sex="male", reproductive_health_opt_in=True, cycle_tracking_enabled=True),
        cycle=CycleSummary(
            window_days=90,
            opt_in=True,
            cycle_tracking_enabled=True,
            logs_count=3,
            recent_cycle_lengths=[28, 29, 30],
            symptom_dates={today - timedelta(days=2)},
            latest_cycle_day=4,
        ),
    ))
    assert not any(card.id == "menstrual_cycle_recovery_pattern" for card in cards), cards
    _ok("male profile suppresses menstrual-cycle Health Insight")


def test_default_health_insights_exclude_injury_keep_kidney() -> None:
    print("\n[test] health insights: injury and overlapping cards hidden, kidney stone kept")
    ids = {card.id for card in compute_all_insight_cards(_ctx())}
    assert "injury_risk" not in ids, ids
    assert "kidney_stone_risk_factors" in ids, ids
    assert "brain_health_support" in ids, ids
    retired = {
        "cardio_efficiency_trend",
        "recovery_strain",
        "sleep_regularity_late_intake",
        "sleep_disruptors",
        "performance_readiness",
    }
    assert ids.isdisjoint(retired), ids
    _ok("overlapping health insight cards are excluded while kidney stone risk stays published")


def test_requested_top_insights_are_published() -> None:
    print("\n[test] health insights: requested top cards are published")
    ids = {card.id for card in compute_all_insight_cards(_ctx())}
    requested = {
        "healthspan_foundations",
        "brain_health_support",
        "muscle_preservation_watch",
        "recovery_modality_response",
        "protein_quality_pattern",
    }
    assert requested <= ids, ids
    assert "protein_distribution_quality" not in ids, ids
    _ok("requested healthspan/muscle/recovery/protein cards are in the default set")


def test_bone_density_support_uses_dxa_without_diagnostic_language() -> None:
    print("\n[test] bone density support: DXA rows inform safe copy")
    ctx = _ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_calcium_mg=620,
            avg_vitamin_d_mcg=8,
            micronutrient_logged_days=7,
        ),
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=1,
            resistance_sessions_14d=1,
        ),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=10,
            latest_labs={
                "bone_density_t_score": {
                    "value": -1.4,
                    "unit": "T-score",
                    "collected_at": "2026-05-01T00:00:00+00:00",
                    "source": "manual",
                },
            },
        ),
    )
    card = compute_bone_density_support(ctx)
    text = _text(card)
    assert card.id == "bone_density_support", card
    assert "labs" in card.data_used, card.data_used
    assert "saved bone-density t-score" in text, text
    assert "bone density score" not in text, text
    assert "osteopenia" not in text and "osteoporosis" not in text, text
    _ok("DXA/T-score data is used without diagnostic labels")


def test_bone_density_support_without_dxa_is_behavior_capped() -> None:
    print("\n[test] bone density support: no DXA caps confidence")
    card = compute_bone_density_support(_ctx(
        health=HealthSnapshotSummary(window_days=28, days_with_data=10),
    ))
    text = _text(card)
    assert card.confidence in {"low", "medium"}, card.confidence
    assert "labs" not in card.data_used, card.data_used
    assert "behavior support rather than measured bone density" in " ".join(card.confidence_reasons), card.confidence_reasons
    assert "bone density score" not in text, text
    _ok("behavior-only read stays capped and explicit")


def test_cardio_efficiency_uses_vo2_and_rhr_trend() -> None:
    print("\n[test] cardio efficiency: VO2 and RHR improve score")
    card = compute_cardio_efficiency_trend(_ctx(
        activity=ActivitySummary(
            window_days=14,
            days_with_data=12,
            avg_steps=8400,
            avg_cardio_minutes=24,
            avg_zone2_minutes=16,
        ),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=20,
            rhr_latest=55,
            rhr_baseline=60,
            vo2_latest=43,
            vo2_trend_per_90d=2.0,
        ),
    ))
    assert card.score >= 85, card
    assert any("VO2 max trend is up" in p for p in card.positive_factors), card.positive_factors
    _ok("cardio score rewards VO2 improvement and lower resting heart rate")


def test_recovery_modality_response_reads_next_day_signals() -> None:
    print("\n[test] recovery modality response: next-day signals")
    today = date.today()
    exposure_dates = {today - timedelta(days=6), today - timedelta(days=3)}
    hrv = {today - timedelta(days=i): 50 for i in range(10)}
    rhr = {today - timedelta(days=i): 60 for i in range(10)}
    sleep_scores = {today - timedelta(days=i): 80 for i in range(10)}
    for exposure in exposure_dates:
        next_day = exposure + timedelta(days=1)
        hrv[next_day] = 60
        rhr[next_day] = 56
        sleep_scores[next_day] = 88
    card = compute_recovery_modality_response(_ctx(
        sleep=SleepSummary(window_days=14, nights_with_data=10, score_by_date=sleep_scores),
        health=HealthSnapshotSummary(window_days=28, days_with_data=10, hrv_by_date=hrv, rhr_by_date=rhr),
        recovery_modalities=RecoveryModalitySummary(
            window_days=28,
            activity_count=2,
            dates=exposure_dates,
            modality_dates={"breathwork": exposure_dates},
            modality_minutes={"breathwork": 20},
        ),
    ))
    assert card.score >= 80, card
    assert any("Breathwork" in p for p in card.positive_factors), card.positive_factors
    _ok("recovery modality card rewards supportive next-day HRV/RHR/sleep response")


def test_protein_distribution_flags_single_meal_concentration() -> None:
    print("\n[test] protein distribution: concentrated protein")
    card = compute_protein_distribution_quality(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_protein_g=140,
            avg_max_meal_protein_pct=0.78,
            daily_values={
                "high_carb_low_protein_meal": {
                    date.today() - timedelta(days=i): 1 for i in range(4)
                }
            },
        ),
        user=UserContext(weight_lbs=180),
    ))
    assert card.score < 60, card
    assert any("heavily concentrated" in d for d in card.drivers), card.drivers
    _ok("protein distribution card flags one-meal concentration")


def test_protein_quality_combines_distribution_flags() -> None:
    print("\n[test] protein quality: includes distribution flags")
    card = compute_protein_quality_pattern(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_protein_g=140,
            avg_animal_protein_g=100,
            avg_plant_protein_g=40,
            avg_max_meal_protein_pct=0.78,
            daily_values={
                "high_carb_low_protein_meal": {
                    date.today() - timedelta(days=i): 1 for i in range(4)
                }
            },
        ),
        user=UserContext(weight_lbs=180),
    ))
    assert card.id == "protein_quality_pattern", card
    assert "Distribution" in card.title, card.title
    assert card.score < 65, card
    assert any("heavily concentrated" in d for d in card.drivers), card.drivers
    _ok("protein quality card now carries meal-distribution warnings")


def test_inflammation_support_combines_nutrition_sleep_activity_and_stress() -> None:
    print("\n[test] inflammation support: multi-domain support gaps")
    today = date.today()
    card = compute_inflammation_support(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2200,
            avg_added_sugar_g=80,
            avg_saturated_fat_g=34,
            avg_fiber_g=12,
            avg_omega_3_g=0.2,
            micronutrient_logged_days=8,
            ultra_processed_pct=55,
            processed_meat_servings=4,
            daily_values={
                "added_sugar_g": {today - timedelta(days=i): 70 for i in range(5)},
                "fiber_g": {today - timedelta(days=i): 12 for i in range(5)},
                "stress_note": {today - timedelta(days=i): 1 for i in range(2)},
            },
        ),
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=6.0),
        activity=ActivitySummary(window_days=14, days_with_data=10, avg_steps=3600, avg_cardio_minutes=4),
        health=HealthSnapshotSummary(window_days=28, days_with_data=14, hrv_latest=42, hrv_baseline=60, rhr_latest=67, rhr_baseline=59),
    ))
    assert card.score < 50, card
    assert card.status in {"elevated", "high"}, card
    joined = _text(card)
    assert "added sugar" in joined
    assert "fiber" in joined
    assert "stress" in joined
    assert "does not diagnose inflammation" in joined
    _ok("inflammation support drops only with combined lifestyle/recovery signals")


def test_protein_quality_flags_low_per_lb_and_low_plant_share() -> None:
    print("\n[test] protein quality: low adequacy + low plant share")
    card = compute_protein_quality_pattern(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=10,
            avg_protein_g=80,
            avg_animal_protein_g=72,
            avg_plant_protein_g=8,
        ),
        user=UserContext(goal="body_recomp", sex="male", weight_lbs=180),
    ))
    assert card.score < 60, card
    joined = _text(card)
    assert "protein" in joined
    assert "plant" in joined
    _ok("low protein/lb and low plant share both register as drivers")


def test_protein_quality_good_when_balanced_and_adequate() -> None:
    print("\n[test] protein quality: balanced mix + adequate per lb")
    card = compute_protein_quality_pattern(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_protein_g=170,
            avg_animal_protein_g=100,
            avg_plant_protein_g=70,
        ),
        user=UserContext(goal="body_recomp", sex="male", weight_lbs=180),
    ))
    assert card.score >= 65, card
    assert card.status in {"low", "moderate"}, card
    _ok("balanced protein mix with good per-lb adequacy lands in supportive band")


def test_protein_quality_unknown_without_protein_data() -> None:
    print("\n[test] protein quality: unknown when protein logs missing")
    card = compute_protein_quality_pattern(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=2, avg_protein_g=None),
    ))
    assert card.status == "unknown", card
    _ok("missing protein logs short-circuit to unknown card")


def test_inflammation_support_uses_crp_as_context_not_diagnosis() -> None:
    print("\n[test] inflammation support: CRP context wording")
    card = compute_inflammation_support(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=10, avg_fiber_g=28, avg_added_sugar_g=18, avg_saturated_fat_g=16, avg_omega_3_g=1.2, micronutrient_logged_days=8),
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=7.3),
        activity=ActivitySummary(window_days=14, days_with_data=10, avg_steps=8500, avg_cardio_minutes=25),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=14,
            latest_labs={"hs_crp": {"value": 3.4, "unit": "mg/L", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"}},
        ),
    ))
    assert any("CRP/hs-CRP" in d for d in card.drivers), card.drivers
    assert "diagnosis" in _text(card)
    assert "you have inflammation" not in _text(card)
    _ok("CRP/hs-CRP is treated as context, not a diagnosis")


def test_brain_health_support_detects_sleep_caffeine_and_omega3_gaps() -> None:
    print("\n[test] brain health support: sleep, caffeine, omega-3, hydration gaps")
    today = date.today()
    card = compute_brain_health_support(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2200,
            avg_fiber_g=12,
            avg_added_sugar_g=78,
            avg_omega_3_g=0.1,
            avg_water_oz=42,
            estimated_hydration_target_oz=90,
            micronutrient_logged_days=8,
            avg_vitamin_b12_mcg=1.2,
            avg_folate_mcg=220,
            daily_values={
                "late_caffeine_structured": {today - timedelta(days=i): 1 for i in range(3)},
                "late_caffeine_mg": {today - timedelta(days=i): 90 for i in range(3)},
                "added_sugar_g": {today - timedelta(days=i): 70 for i in range(4)},
            },
            late_caffeine_mg=270,
            late_caffeine_structured_count=3,
        ),
        sleep=SleepSummary(window_days=14, nights_with_data=10, avg_hours=5.9, bedtime_std_minutes=110),
        activity=ActivitySummary(
            window_days=14,
            days_with_data=10,
            avg_steps=3600,
            avg_cardio_minutes=4,
            daily_values={"steps": {today - timedelta(days=i): 3500 for i in range(4)}},
        ),
    ))
    text = _text(card)
    assert card.score < 50, card
    assert card.status in {"elevated", "high"}, card
    assert "sleep" in text
    assert "caffeine" in text
    assert "omega-3" in text
    assert "not a cognitive test or diagnosis" in text
    _ok("brain health card flags behavior support gaps without diagnosis language")


def test_brain_health_support_good_when_foundations_are_supportive() -> None:
    print("\n[test] brain health support: supportive foundations")
    card = compute_brain_health_support(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2200,
            avg_fiber_g=31,
            avg_added_sugar_g=16,
            avg_omega_3_g=1.2,
            avg_water_oz=92,
            estimated_hydration_target_oz=90,
            micronutrient_logged_days=8,
            avg_vitamin_b12_mcg=3.4,
            avg_folate_mcg=420,
            avg_iron_mg=12,
            avg_magnesium_mg=330,
            avg_vitamin_d_mcg=16,
            distinct_plant_foods_week=22,
            ultra_processed_pct=18,
        ),
        sleep=SleepSummary(window_days=14, nights_with_data=12, avg_hours=7.5, bedtime_std_minutes=32),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=8900, avg_cardio_minutes=28),
        health=HealthSnapshotSummary(window_days=28, days_with_data=14, hrv_latest=62, hrv_baseline=60, rhr_latest=58, rhr_baseline=58),
    ))
    assert card.score >= 75, card
    assert card.status in {"low", "moderate"}, card
    assert any("Sleep duration" in p or "omega-3" in p for p in card.positive_factors), card.positive_factors
    _ok("supportive brain health basics land in a good support band")


def test_cycle_data_generates_recovery_pattern_after_opt_in() -> None:
    print("\n[test] cycle: opted-in logs generate recovery pattern")
    today = date.today()
    card = compute_menstrual_cycle_recovery_pattern(_ctx(
        user=UserContext(reproductive_health_opt_in=True, cycle_tracking_enabled=True),
        cycle=CycleSummary(
            window_days=90,
            opt_in=True,
            cycle_tracking_enabled=True,
            logs_count=3,
            recent_cycle_lengths=[28, 30, 29],
            symptom_dates={today - timedelta(days=2)},
            latest_cycle_day=4,
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=5, hard_session_dates={today - timedelta(days=2)}),
    ))
    assert card.status != "unknown", card
    assert "does not infer fertility" in _text(card), _text(card)
    _ok("opted-in cycle logs can drive recovery context")


def test_post_workout_meal_delay_requires_timestamps() -> None:
    print("\n[test] post-workout fueling: missing timestamps stay missing")
    no_timing = compute_energy_availability(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=8, avg_calories_when_logged=2000, calorie_target=2200),
        workouts=WorkoutSummary(window_days=28, completed_sessions=5),
    ))
    with_timing = compute_energy_availability(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=8,
            avg_calories_when_logged=2000,
            calorie_target=2200,
            post_workout_timing_sessions=3,
            first_meal_after_workout_minutes=220,
            missed_post_workout_fueling_sessions=2,
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=5),
    ))
    assert "post-workout meal timing" in no_timing.missing_data, no_timing.missing_data
    assert any("post-workout" in d.lower() for d in with_timing.drivers), with_timing.drivers
    _ok("delay is used only when timestamp-derived timing exists")


def test_lab_backed_blood_sugar_confidence_exceeds_habit_only() -> None:
    print("\n[test] labs: blood sugar support confidence improves with labs")
    habit_only = compute_blood_sugar_support_pattern(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=12, avg_calories_when_logged=2200, avg_added_sugar_g=70, avg_fiber_g=14, avg_fiber_per_1000_kcal=6),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=4200),
    ))
    lab_backed = compute_blood_sugar_support_pattern(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=12, avg_calories_when_logged=2200, avg_added_sugar_g=70, avg_fiber_g=14, avg_fiber_per_1000_kcal=6),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=4200),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=12,
            weight_trend_lbs_per_week=0.4,
            latest_labs={"a1c": {"value": 5.8, "unit": "%", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"}},
        ),
    ))
    assert _confidence_rank(lab_backed.confidence) > _confidence_rank(habit_only.confidence), (habit_only, lab_backed)
    assert any("a1c" in d.lower() for d in lab_backed.drivers), lab_backed.drivers
    _ok("lab-backed pattern carries stronger confidence")


def test_missing_labs_cap_blood_sugar_confidence() -> None:
    print("\n[test] labs: missing labs cap clinical-risk confidence")
    card = compute_blood_sugar_support_pattern(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=14, avg_calories_when_logged=2200, avg_added_sugar_g=65, avg_fiber_g=12, avg_fiber_per_1000_kcal=6),
        activity=ActivitySummary(window_days=14, days_with_data=14, avg_steps=4300),
        health=HealthSnapshotSummary(window_days=28, days_with_data=14, weight_trend_lbs_per_week=0.3),
    ))
    assert card.confidence != "high", card
    assert any("labs" in r.lower() for r in card.confidence_reasons), card.confidence_reasons
    _ok("missing labs keep diabetes/prediabetes support card cautious")


def test_cardiometabolic_risk_signals_elevated_pattern() -> None:
    print("\n[test] cardiometabolic risk signals: elevated multi-factor pattern")
    today = date.today()
    card = compute_cardiometabolic_risk_signals(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=12,
            avg_calories_when_logged=2350,
            avg_added_sugar_g=92,
            avg_fiber_g=11,
            avg_fiber_per_1000_kcal=5,
            daily_values={
                "added_sugar_g": _by_offset({i: 75 for i in range(0, 6)}),
            },
            pattern_dates={"sugar_sweetened_beverage": {today - timedelta(days=i) for i in range(0, 4)}},
        ),
        activity=ActivitySummary(
            window_days=14,
            days_with_data=14,
            avg_steps=3200,
            avg_cardio_minutes=6,
            daily_values={"steps": _by_offset({i: 3200 for i in range(0, 14)})},
        ),
        workouts=WorkoutSummary(window_days=28, completed_sessions=1, resistance_sessions_14d=0),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=14,
            weight_trend_lbs_per_week=1.4,
            bp_reading_count=2,
            latest_bp_systolic=136,
            latest_bp_diastolic=84,
            median_bp_systolic=134,
            median_bp_diastolic=82,
            latest_labs={
                "a1c": {"value": 5.9, "unit": "%", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"},
            },
        ),
        user=UserContext(age=52, sex="male", weight_lbs=214, height_inches=70, days_per_week=2),
    ))
    text = _text(card)
    assert card.title == "Cardiometabolic risk signals"
    assert card.status == "elevated", card
    assert 2 <= len(card.drivers) <= 4, card.drivers
    assert 1 <= len(card.recommendations) <= 3, card.recommendations
    assert "risk factor" in text or "risk factors" in text
    assert "heart-and-metabolism patterns" in text
    assert "a1c" in text and "fasting-glucose" in text and "blood pressure" in text
    assert CARDIOMETABOLIC_RISK_DISCLAIMER.lower() in text
    assert "you have diabetes" not in text
    _ok("elevated card stays behavior-based and non-diagnostic")


def test_cardiometabolic_risk_signals_low_risk_active_user() -> None:
    print("\n[test] cardiometabolic risk signals: active low-risk pattern")
    today = date.today()
    card = compute_cardiometabolic_risk_signals(_ctx(
        nutrition=NutritionSummary(
            window_days=14,
            days_with_data=14,
            avg_calories_when_logged=2200,
            avg_added_sugar_g=18,
            avg_fiber_g=34,
            avg_protein_g=160,
            daily_values={"fiber_g": _by_offset({i: 34 for i in range(0, 14)})},
        ),
        activity=ActivitySummary(
            window_days=14,
            days_with_data=14,
            avg_steps=9200,
            avg_cardio_minutes=26,
            daily_values={
                "steps": _by_offset({i: 9200 for i in range(0, 14)}),
                "cardio_minutes": _by_offset({i: 26 for i in range(0, 14)}),
            },
        ),
        workouts=WorkoutSummary(
            window_days=28,
            completed_sessions=8,
            completed_dates={today - timedelta(days=i) for i in (1, 3, 5, 8, 10, 12, 16, 20)},
            resistance_sessions_14d=4,
        ),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=14,
            weight_trend_lbs_per_week=-0.4,
            bp_reading_count=1,
            latest_bp_systolic=116,
            latest_bp_diastolic=72,
            latest_labs={
                "a1c": {"value": 5.2, "unit": "%", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"},
                "fasting_glucose": {"value": 88, "unit": "mg/dL", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"},
            },
        ),
        user=UserContext(age=33, sex="female", weight_lbs=145, height_inches=66, days_per_week=4),
    ))
    assert card.status == "low", card
    assert any("protective signal" in p.lower() for p in card.positive_factors), card.positive_factors
    assert not card.drivers, card.drivers
    _ok("consistent cardio/resistance activity is rewarded")


def test_cardiometabolic_risk_signals_missing_data_fallback() -> None:
    print("\n[test] cardiometabolic risk signals: missing data fallback")
    card = compute_cardiometabolic_risk_signals(_ctx(
        nutrition=NutritionSummary(window_days=14),
        sleep=SleepSummary(window_days=14),
        activity=ActivitySummary(window_days=14),
        workouts=WorkoutSummary(window_days=28),
        health=HealthSnapshotSummary(window_days=28),
        user=UserContext(),
    ))
    assert card.status == "unknown", card
    assert card.display_score is None, card
    assert card.missing_data, card
    assert "not a diagnosis" in _text(card)
    _ok("sparse data returns a non-diagnostic needs-data card")


def test_cardiometabolic_risk_signals_lab_present_scenario() -> None:
    print("\n[test] cardiometabolic risk signals: lab values are discussion context")
    card = compute_cardiometabolic_risk_signals(_ctx(
        nutrition=NutritionSummary(window_days=14, days_with_data=12, avg_calories_when_logged=2200, avg_added_sugar_g=18, avg_fiber_g=28),
        activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=8500, avg_cardio_minutes=24),
        workouts=WorkoutSummary(window_days=28, completed_sessions=6, resistance_sessions_14d=4),
        health=HealthSnapshotSummary(
            window_days=28,
            days_with_data=12,
            weight_trend_lbs_per_week=-0.2,
            latest_labs={
                "a1c": {"value": 5.8, "unit": "%", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"},
                "fasting_glucose": {"value": 103, "unit": "mg/dL", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"},
            },
        ),
        user=UserContext(age=38, sex="male", weight_lbs=174, height_inches=70),
    ))
    text = _text(card)
    assert card.status in {"watch", "elevated"}, card
    assert "lab value to discuss with a clinician" in text
    assert "diagnosis" in text
    assert "diagnosed" not in text
    _ok("lab-backed risk signal never interprets labs as diagnosis")


def test_cardiometabolic_risk_signals_no_diagnostic_wording() -> None:
    print("\n[test] cardiometabolic risk signals: forbidden diagnostic wording absent")
    cards = [
        compute_cardiometabolic_risk_signals(_ctx(
            nutrition=NutritionSummary(window_days=14, days_with_data=12, avg_calories_when_logged=2300, avg_added_sugar_g=88, avg_fiber_g=12),
            activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=3600),
            health=HealthSnapshotSummary(
                window_days=28,
                days_with_data=12,
                latest_labs={"a1c": {"value": 6.0, "unit": "%", "collected_at": "2026-05-01T00:00:00+00:00", "source": "manual"}},
            ),
            user=UserContext(age=50, sex="male", weight_lbs=210, height_inches=69),
        )),
        compute_blood_pressure_sodium_risk_signal(_ctx(
            nutrition=NutritionSummary(window_days=14, days_with_data=12, avg_sodium_mg=4200, avg_fiber_g=12),
            activity=ActivitySummary(window_days=14, days_with_data=12, avg_steps=3800),
            health=HealthSnapshotSummary(window_days=28, days_with_data=12, bp_reading_count=2, latest_bp_systolic=138, latest_bp_diastolic=86, median_bp_systolic=136, median_bp_diastolic=84),
        )),
        compute_glp1_muscle_preservation_signal(_ctx(
            nutrition=NutritionSummary(window_days=14, days_with_data=12, avg_calories_when_logged=1400, calorie_target=2200, avg_protein_g=80, avg_fiber_g=12, avg_water_oz=50, estimated_hydration_target_oz=90),
            workouts=WorkoutSummary(window_days=28, completed_sessions=1, resistance_sessions_14d=0),
            health=HealthSnapshotSummary(window_days=28, days_with_data=12, weight_trend_lbs_per_week=-2.0),
            user=UserContext(weight_lbs=190, height_inches=70, glp1_support_enabled=True, glp1_appetite="very_low"),
        )),
    ]
    forbidden = [
        "you have diabetes",
        "you likely have diabetes",
        "diagnosed",
        "you have hypertension",
        "you have kidney disease",
    ]
    joined = "\n".join(_text(card) for card in cards)
    for phrase in forbidden:
        assert phrase not in joined, phrase
    _ok("risk-signal cards avoid diagnostic wording")


def test_unsafe_phrases_never_generated() -> None:
    print("\n[test] insight cards: unsafe phrases absent")
    cards = [
        compute_cardiometabolic_risk_signals(_ctx()),
        compute_blood_pressure_sodium_risk_signal(_ctx()),
        compute_healthspan_foundations(_ctx()),
        compute_bone_density_support(_ctx()),
        compute_cardio_efficiency_trend(_ctx()),
        compute_muscle_preservation_watch(_ctx()),
        compute_red_processed_meat_pattern(_ctx()),
        compute_blood_sugar_support_pattern(_ctx()),
        compute_cholesterol_support_pattern(_ctx()),
        compute_recovery_strain(_ctx()),
        compute_hormone_support(_ctx()),
        compute_hydration_electrolyte_risk(_ctx()),
        compute_kidney_stone_risk_factors(_ctx()),
        compute_energy_availability(_ctx()),
        compute_sleep_regularity_late_intake(_ctx()),
        compute_injury_risk(_ctx()),
        compute_sleep_disruptors(_ctx()),
        compute_recovery_modality_response(_ctx()),
        compute_performance_readiness(_ctx()),
        compute_digestion_patterns(_ctx(nutrition=NutritionSummary(window_days=14))),
        compute_inflammation_support(_ctx()),
        compute_brain_health_support(_ctx()),
        compute_protein_distribution_quality(_ctx()),
        compute_heart_health_habits(_ctx()),
        compute_glp1_muscle_preservation_signal(_ctx(user=UserContext(weight_lbs=180, glp1_support_enabled=True))),
    ]
    forbidden = [
        "you have low testosterone",
        "you have high cortisol",
        "you will get kidney stones",
        "you have kidney disease",
        "you are insulin resistant",
        "you have diabetes",
        "you likely have diabetes",
        "diagnosed",
        "you have hypertension",
        "you will get cancer",
        "you have cognitive decline",
        "you will get dementia",
        "alzheimer",
        "bone density score",
        "osteopenia",
        "osteoporosis",
    ]
    joined = "\n".join(_text(card) for card in cards)
    for phrase in forbidden:
        assert phrase not in joined, phrase
    _ok("unsafe medical-prediction phrases are absent")


def test_recovery_confidence_drops_without_hrv_rhr() -> None:
    print("\n[test] confidence: missing HRV/RHR drops recovery confidence")
    full = compute_recovery_strain(_ctx())
    partial = compute_recovery_strain(_ctx(
        health=HealthSnapshotSummary(window_days=28, days_with_data=0)
    ))
    assert _confidence_rank(partial.confidence) < _confidence_rank(full.confidence), (full.confidence, partial.confidence)
    assert "HRV trend" in partial.missing_data
    assert "resting heart rate trend" in partial.missing_data
    _ok("confidence falls when key Apple Health data is missing")


cases = [
    test_feature_extraction_compares_current_and_prior_windows,
    test_isolated_bad_day_does_not_create_high_blood_sugar_severity,
    test_protective_factors_soften_red_meat_score,
    test_insight_engine_does_not_infer_food_patterns_from_names,
    test_meat_serving_estimator_uses_logged_ounces,
    test_red_meat_amount_uses_weekly_guidance_not_meal_count,
    test_red_processed_meat_pattern_surfaces_amount_without_prediction,
    test_blood_sugar_support_uses_added_sugar_fiber_and_refined_grains,
    test_cholesterol_support_uses_sat_fat_fiber_and_protein_sources,
    test_recovery_strain_responds_to_sleep_load_and_deficit,
    test_hormone_support_uses_support_environment_language,
    test_hormone_support_unknown_has_no_display_score,
    test_hormone_support_good_when_core_signals_supportive,
    test_hormone_support_hard_training_with_support_is_not_over_penalized,
    test_hormone_support_hard_training_with_low_fueling_sleep_is_penalized,
    test_hormone_support_low_fat_respects_domain_cap,
    test_hormone_support_fat_quality_is_light_modifier,
    test_hormone_support_weight_loss_uses_percent_when_body_weight_available,
    test_hormone_support_weight_loss_lbs_fallback_without_body_weight,
    test_hormone_support_protein_penalty_requires_body_weight_and_context,
    test_hormone_support_missing_optional_data_does_not_create_false_penalties,
    test_hydration_risk_handles_low_water_and_activity,
    test_kidney_stone_confidence_drops_without_sodium,
    test_energy_availability_detects_deficit_plus_training,
    test_injury_risk_detects_workload_spike_and_soreness,
    test_sleep_disruptors_requires_enough_observations,
    test_sleep_disruptors_requires_repeated_pre_sleep_cluster,
    test_inferred_caffeine_does_not_create_high_confidence_sleep_disruptor,
    test_structured_caffeine_timing_raises_sleep_confidence,
    test_performance_readiness_combines_fueling_vitals_and_plan,
    test_injury_and_readiness_use_today_plan_overlap,
    test_feature_extraction_uses_dated_workout_context_for_today_overlap,
    test_pain_body_part_overlap_affects_injury_and_readiness,
    test_movement_pattern_ramp_needs_corroboration,
    test_digestion_patterns_requires_symptom_checkin,
    test_digestion_trigger_requires_repeated_exposure,
    test_heart_health_habits_uses_bp_without_diagnosis,
    test_inferred_potassium_and_calcium_are_confidence_capped,
    test_missing_stone_history_caps_kidney_stone_severity,
    test_stone_history_increases_kidney_stone_sensitivity,
    test_cycle_cards_do_not_generate_without_opt_in,
    test_male_users_do_not_receive_cycle_card_even_with_opt_in,
    test_default_health_insights_exclude_injury_keep_kidney,
    test_requested_top_insights_are_published,
    test_bone_density_support_uses_dxa_without_diagnostic_language,
    test_bone_density_support_without_dxa_is_behavior_capped,
    test_cardio_efficiency_uses_vo2_and_rhr_trend,
    test_recovery_modality_response_reads_next_day_signals,
    test_protein_distribution_flags_single_meal_concentration,
    test_protein_quality_combines_distribution_flags,
    test_inflammation_support_combines_nutrition_sleep_activity_and_stress,
    test_inflammation_support_uses_crp_as_context_not_diagnosis,
    test_brain_health_support_detects_sleep_caffeine_and_omega3_gaps,
    test_brain_health_support_good_when_foundations_are_supportive,
    test_cycle_data_generates_recovery_pattern_after_opt_in,
    test_post_workout_meal_delay_requires_timestamps,
    test_lab_backed_blood_sugar_confidence_exceeds_habit_only,
    test_missing_labs_cap_blood_sugar_confidence,
    test_cardiometabolic_risk_signals_elevated_pattern,
    test_cardiometabolic_risk_signals_low_risk_active_user,
    test_cardiometabolic_risk_signals_missing_data_fallback,
    test_cardiometabolic_risk_signals_lab_present_scenario,
    test_cardiometabolic_risk_signals_no_diagnostic_wording,
    test_unsafe_phrases_never_generated,
    test_recovery_confidence_drops_without_hrv_rhr,
]


if __name__ == "__main__":
    for case in cases:
        case()
