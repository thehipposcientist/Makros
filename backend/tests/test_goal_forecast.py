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


cases = [
    test_recomp_forecast_uses_body_fat_points,
    test_sparse_nutrition_explains_downshift,
    test_strength_forecast_uses_strength_marker_language,
]


if __name__ == "__main__":
    for case in cases:
        print(f"\n[test] {case.__name__}")
        case()
