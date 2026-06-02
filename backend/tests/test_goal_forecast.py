"""Pure tests for deterministic goal forecasts."""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_recomp_forecast_uses_body_fat_points() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="body_recomp",
        pace="moderate",
        current_weight_lbs=180,
        body_fat_pct=22.5,
        sessions_completed=4,
        sessions_planned=4,
        workout_adherence_pct=100,
        days_logged=6,
        days=7,
        nutrition_logging_pct=86,
        avg_protein_g=165,
        calorie_target_adherence_pct=80,
        protein_target_adherence_pct=85,
        weekly_nutrition_score=84,
    ).to_dict()

    assert "body-fat points" in forecast["headline"], forecast
    assert forecast["tone"] == "success"
    assert forecast["execution_pct"] >= 80
    _ok("body recomp returns body-fat-point projection")


def test_sparse_nutrition_explains_downshift() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="fat_loss",
        pace="moderate",
        current_weight_lbs=195,
        target_weight_lbs=180,
        sessions_completed=2,
        sessions_planned=4,
        workout_adherence_pct=50,
        days_logged=1,
        days=7,
        nutrition_logging_pct=14,
        avg_protein_g=80,
    ).to_dict()

    assert forecast["execution_pct"] < 75
    assert forecast["limiters"], forecast
    assert "Estimate was reduced" in forecast["update_reason"]
    _ok("low nutrition/training adherence reduces and explains forecast")


def test_strength_forecast_uses_strength_marker_language() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="strength",
        pace="aggressive",
        current_weight_lbs=185,
        sessions_completed=3,
        sessions_planned=3,
        workout_adherence_pct=100,
        days_logged=4,
        days=7,
        nutrition_logging_pct=57,
        avg_protein_g=150,
        protein_target_adherence_pct=75,
    ).to_dict()

    assert forecast["metric_label"] == "Strength marker"
    assert "strength marker" in forecast["headline"]
    _ok("strength goal gets strength-marker forecast")


def test_forecast_uses_resolved_protein_target_when_available() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="strength",
        pace="moderate",
        current_weight_lbs=185,
        sessions_completed=4,
        sessions_planned=4,
        workout_adherence_pct=100,
        days_logged=5,
        days=7,
        nutrition_logging_pct=71,
        avg_protein_g=150,
        protein_target_g=190,
        protein_target_adherence_pct=None,
    ).to_dict()

    assert "protein is below target" in forecast["limiters"], forecast
    _ok("resolved protein target overrides generic 0.8g/lb fallback")


def test_display_execution_can_fall_below_forecast_floor() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="strength",
        sessions_completed=0,
        sessions_planned=3,
        workout_adherence_pct=0,
        days_logged=0,
        days=7,
        nutrition_logging_pct=0,
        avg_sleep_hours=5.0,
    ).to_dict()

    assert forecast["execution_pct"] < 35, forecast
    assert round(forecast["forecast_multiplier"] * 100) == 35, forecast
    assert forecast["execution_pct"] != round(forecast["forecast_multiplier"] * 100), forecast
    _ok("display execution is separate from the forecast floor")


def test_execution_uses_unified_weighted_semantics() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="muscle_gain",
        sessions_completed=2,
        sessions_planned=4,
        workout_adherence_pct=50,
        workout_minutes=90,
        days_logged=7,
        days=7,
        nutrition_logging_pct=100,
        calorie_target_adherence_pct=60,
        protein_target_adherence_pct=80,
        weekly_nutrition_score=80,
        avg_sleep_hours=6.7,
    ).to_dict()

    expected_nutrition = 0.30 * 1.0 + 0.70 * ((0.80 * 0.50 + 0.80 * 0.30 + 0.60 * 0.20) / 1.0)
    expected_raw = 0.50 * 0.45 + expected_nutrition * 0.40 + 0.92 * 0.15
    assert abs(forecast["raw_execution"] - expected_raw) < 0.001, forecast
    assert forecast["execution_pct"] == round(expected_raw * 100), forecast
    _ok("backend execution uses the shared weighted formula")


def test_recovery_sleep_curve_affects_execution() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    rested = build_goal_forecast(
        goal="body_recomp",
        sessions_completed=4,
        sessions_planned=4,
        workout_adherence_pct=100,
        days_logged=7,
        days=7,
        nutrition_logging_pct=100,
        weekly_nutrition_score=85,
        avg_sleep_hours=7.2,
    ).to_dict()
    poor_sleep = build_goal_forecast(
        goal="body_recomp",
        sessions_completed=4,
        sessions_planned=4,
        workout_adherence_pct=100,
        days_logged=7,
        days=7,
        nutrition_logging_pct=100,
        weekly_nutrition_score=85,
        avg_sleep_hours=5.8,
    ).to_dict()

    assert poor_sleep["execution_pct"] < rested["execution_pct"], (rested, poor_sleep)
    assert poor_sleep["execution_breakdown"]["recovery"] == 0.70, poor_sleep
    assert poor_sleep["forecast_multiplier"] >= 0.35, poor_sleep
    _ok("poor sleep reduces recovery execution without breaking clamping")


def test_tracking_alone_does_not_create_perfect_nutrition() -> None:
    from app.services.workout.goal_forecast import build_goal_forecast

    forecast = build_goal_forecast(
        goal="body_recomp",
        sessions_completed=4,
        sessions_planned=4,
        workout_adherence_pct=100,
        days_logged=7,
        days=7,
        nutrition_logging_pct=100,
    ).to_dict()

    assert forecast["execution_breakdown"]["nutrition"] <= 0.70, forecast
    assert forecast["execution_pct"] < 95, forecast
    _ok("nutrition coverage alone is capped below near-perfect execution")


cases = [
    test_recomp_forecast_uses_body_fat_points,
    test_sparse_nutrition_explains_downshift,
    test_strength_forecast_uses_strength_marker_language,
    test_forecast_uses_resolved_protein_target_when_available,
    test_display_execution_can_fall_below_forecast_floor,
    test_execution_uses_unified_weighted_semantics,
    test_recovery_sleep_curve_affects_execution,
    test_tracking_alone_does_not_create_perfect_nutrition,
]


if __name__ == "__main__":
    for case in cases:
        print(f"\n[test] {case.__name__}")
        case()
