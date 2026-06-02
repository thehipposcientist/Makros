"""Tests for detailed per-goal execution and projection scoring.

Run directly:
    python3 -m tests.test_goal_scoring
"""
from __future__ import annotations

from datetime import date, timedelta

from app.services.goal_scoring import (
    ProjectionInputs,
    _project_outcome,
    calculate_goal_score,
)


START = date(2026, 5, 20)
END = date(2026, 5, 26)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _range():
    return {"start": START, "end": END}


def _days(n: int = 7):
    return [START + timedelta(days=i) for i in range(n)]


def _planned_day(idx: int, exercises: list[dict] | None = None, *, cardio: bool = False) -> dict:
    d = START + timedelta(days=idx)
    if exercises is None:
        exercises = [
            {
                "name": "Back Squat",
                "sets": 4,
                "reps": "5-5",
                "target_weight_lbs": 200,
                "_role": "primary",
                "movement_pattern": "squat",
                "is_compound": True,
                "_rir_target": 2,
            },
            {
                "name": "Bench Press",
                "sets": 3,
                "reps": "6-8",
                "target_weight_lbs": 155,
                "_role": "secondary",
                "movement_pattern": "horizontal_press",
                "is_compound": True,
                "_rir_target": 2,
            },
            {
                "name": "Cable Curl",
                "sets": 2,
                "reps": "10-12",
                "_role": "isolation",
                "movement_pattern": "isolation",
            },
        ]
    if cardio:
        exercises = [
            {
                "name": "Zone 2 Run",
                "sets": 1,
                "reps": "40 min",
                "exercise_type": "cardio",
                "movement_pattern": "cardio",
                "target_zone": "zone2",
            }
        ]
    return {
        "id": idx + 1,
        "plan_day_id": idx + 1,
        "date": d,
        "is_rest": False,
        "workout_json": {"focus": "Strength" if not cardio else "Cardio", "exercises": exercises},
    }


def _actual_sets(count: int, reps: int, weight: float, *, rir: float = 2.0, completed: bool = True):
    return [
        {
            "set_number": i + 1,
            "reps": reps,
            "weight_lbs": weight,
            "actual_rir": rir,
            "completed": completed,
            "set_type": "working",
        }
        for i in range(count)
    ]


def _perfect_log(idx: int, *, plan_day_id: int | None = None, weight_scale: float = 1.0, progression: bool = True) -> dict:
    d = START + timedelta(days=idx)
    return {
        "id": f"log-{idx}",
        "date": d,
        "plan_day_id": plan_day_id or idx + 1,
        "focus": "Strength",
        "completed": True,
        "feeling": "good",
        "intensity": 4,
        "progressionAchieved": progression,
        "exercises": [
            {"name": "Back Squat", "sets": _actual_sets(4, 5, 200 * weight_scale, rir=2)},
            {"name": "Bench Press", "sets": _actual_sets(3, 7, 155 * weight_scale, rir=2)},
            {"name": "Cable Curl", "sets": _actual_sets(2, 11, 35, rir=2)},
        ],
    }


def _nutrition(days: int = 7, *, calories: float = 2000, protein: float = 170, target: float = 2000):
    return [
        {
            "date": START + timedelta(days=i),
            "calories": calories,
            "protein_g": protein,
            "carbs_g": 220,
            "fiber_g": 32,
            "meals_logged": 3,
            "target_calories": target,
            "target_protein_g": 170,
            "target_carbs_g": 220,
            "hydration_oz": 80,
        }
        for i in range(days)
    ]


def _sleep(hours: float = 7.5, days: int = 7):
    return [{"date": START + timedelta(days=i), "total_hours": hours, "readiness_score": 82} for i in range(days)]


def _steps(steps: int = 8500, days: int = 7):
    return [{"date": START + timedelta(days=i), "steps": steps} for i in range(days)]


def _base_payload(goal_type: str = "fat_loss") -> dict:
    return {
        "goal": {
            "id": "goal-1",
            "goal_type": goal_type,
            "target_metric": "body_fat_pct",
            "target_change": -1.8,
            "timeframe_days": 42,
            "created_at": START - timedelta(days=14),
            "start_body_fat_pct": 25.0,
        },
        "plan": {"days": [_planned_day(i) for i in range(5)]},
        "workoutLogs": [_perfect_log(i) for i in range(5)],
        "nutritionLogs": _nutrition(),
        "sleepLogs": _sleep(),
        "stepLogs": _steps(),
        "bodyMetrics": [
            {"date": START - timedelta(days=14), "body_fat_pct": 25.0, "method": "calipers"},
            {"date": END, "body_fat_pct": 24.4, "method": "calipers"},
        ],
        "dateRange": _range(),
        "asOfDate": END,
    }


def _driver(result: dict, driver_id: str) -> dict:
    for item in result["executionBreakdown"]:
        if item["driverId"] == driver_id:
            return item
    raise AssertionError(f"missing driver {driver_id}: {result['executionBreakdown']}")


def _confidence(result: dict, component: str) -> dict:
    for item in result["confidenceBreakdown"]:
        if item["component"] == component:
            return item
    raise AssertionError(f"missing confidence component {component}: {result['confidenceBreakdown']}")


def test_training_is_not_shallow() -> None:
    payload = _base_payload("fat_loss")
    payload["plan"] = {"days": [_planned_day(i) for i in range(5)]}
    payload["workoutLogs"] = []
    for i in range(5):
        payload["workoutLogs"].append({
            "id": f"shallow-{i}",
            "date": START + timedelta(days=i),
            "plan_day_id": i + 1,
            "focus": "Strength",
            "completed": True,
            "exercises": [
                {"name": "Bench Press", "sets": _actual_sets(1, 6, 155)},
                {"name": "Cable Curl", "sets": _actual_sets(1, 10, 35)},
            ],
        })

    result = calculate_goal_score(payload)
    training = _driver(result, "strengthTrainingQuality")
    assert training["score"] < 70, training
    _ok("completed sessions with missed key lifts/sets do not score as 100")


def test_good_training_quality_scores_high() -> None:
    payload = _base_payload("muscle_gain")
    payload["plan"] = {"days": [_planned_day(i) for i in range(4)]}
    payload["workoutLogs"] = [_perfect_log(i) for i in range(4)]

    result = calculate_goal_score(payload)
    training = _driver(result, "trainingQuality")
    assert training["score"] >= 90, training
    _ok("complete exercises, sets, reps, load, and effort scores near perfect")


def test_fat_loss_calorie_penalty() -> None:
    payload = _base_payload("fat_loss")
    payload["nutritionLogs"] = _nutrition(calories=2300, protein=170, target=2000)

    result = calculate_goal_score(payload)
    calories = _driver(result, "calories")
    assert calories["score"] == 70, calories
    assert result["executionScore"] < 91, result
    _ok("15% over calorie target drags fat-loss execution")


def test_recomp_calorie_target_falls_back_to_resolved_targets() -> None:
    payload = _base_payload("body_recomp")
    payload["nutritionTargets"] = {"calories": 2500, "protein_g": 170, "carbs_g": 250}
    payload["nutritionLogs"] = _nutrition(calories=2350, protein=170, target=2500)
    for row in payload["nutritionLogs"]:
        row.pop("target_calories", None)

    result = calculate_goal_score(payload)
    calories = _driver(result, "calorieConsistency")
    assert calories["score"] == 85, calories
    _ok("recomp logged days without row targets fall back to resolved targets")


def test_recomp_calorie_score_uses_adjusted_day_targets() -> None:
    payload = _base_payload("body_recomp")
    payload["nutritionTargets"] = {"calories": 2500, "protein_g": 170, "carbs_g": 250}
    payload["nutritionLogs"] = _nutrition(calories=2350, protein=170, target=2350)

    result = calculate_goal_score(payload)
    calories = _driver(result, "calorieConsistency")
    assert calories["score"] == 100, calories
    _ok("recomp calorie consistency uses per-day adjusted targets when present")


def test_missing_nutrition_logs_reduce_score_and_confidence() -> None:
    payload = _base_payload("fat_loss")
    payload["nutritionLogs"] = _nutrition(days=3)

    result = calculate_goal_score(payload)
    calories = _driver(result, "calories")
    assert calories["score"] < 65, calories
    assert result["projectionConfidence"] < 75, result["confidenceBreakdown"]
    _ok("3/7 nutrition logs reduce nutrition execution and projection confidence")


def test_high_execution_but_poor_response() -> None:
    payload = _base_payload("fat_loss")
    payload["bodyMetrics"] = [
        {"date": START - timedelta(days=14), "body_fat_pct": 25.0, "method": "calipers"},
        {"date": END, "body_fat_pct": 24.9, "method": "calipers"},
    ]

    result = calculate_goal_score(payload)
    assert result["executionScore"] >= 85, result
    assert result["responseFactor"] < 0.8, result
    assert _confidence(result, "modelFit")["score"] < 70, result["confidenceBreakdown"]
    _ok("execution stays high while poor response lowers projection and model fit")


def test_low_confidence_smart_scale_body_fat() -> None:
    payload = _base_payload("fat_loss")
    payload["bodyMetrics"] = [
        {"date": START - timedelta(days=14), "body_fat_pct": 25.0, "method": "smart_scale"},
        {"date": START - timedelta(days=10), "body_fat_pct": 27.2, "method": "smart_scale"},
        {"date": START - timedelta(days=5), "body_fat_pct": 24.1, "method": "smart_scale"},
        {"date": END, "body_fat_pct": 26.4, "method": "smart_scale"},
    ]

    result = calculate_goal_score(payload)
    assert _confidence(result, "measurementReliability")["score"] <= 55, result["confidenceBreakdown"]
    assert _confidence(result, "signalQuality")["score"] <= 55, result["confidenceBreakdown"]
    _ok("noisy smart-scale body-fat readings stay low confidence")


def test_sleep_recovery_impact() -> None:
    payload = _base_payload("body_recomp")
    payload["sleepLogs"] = _sleep(hours=5.8)

    result = calculate_goal_score(payload)
    sleep = _driver(result, "sleepRecovery")
    assert sleep["score"] < 65, sleep
    assert any("Sleep" in f["driverName"] for f in result["limitingFactors"]), result["limitingFactors"]
    _ok("less than 6h sleep lowers sleep/recovery and can surface as limiter")


def test_strength_goal_missed_intensity() -> None:
    payload = _base_payload("strength")
    payload["goal"].update({"target_metric": "estimated_1rm_pct", "target_change": 3.5})
    payload["plan"] = {"days": [_planned_day(i) for i in range(3)]}
    payload["workoutLogs"] = [_perfect_log(i, weight_scale=0.72, progression=False) for i in range(3)]

    result = calculate_goal_score(payload)
    intensity = _driver(result, "intensityLoadAdherence")
    assert intensity["score"] < 65, intensity
    assert result["executionScore"] < 85, result
    _ok("strength execution drops when main-lift load/intensity is missed")


def test_endurance_zone_mismatch() -> None:
    payload = _base_payload("endurance")
    payload["goal"].update({"target_metric": "cardio_volume_min", "target_change": 150})
    payload["plan"] = {"days": [_planned_day(i, cardio=True) for i in range(4)]}
    payload["workoutLogs"] = [
        {
            "id": f"run-{i}",
            "date": START + timedelta(days=i),
            "plan_day_id": i + 1,
            "focus": "Cardio",
            "completed": True,
            "activity_category": "cardio",
            "cardio_style": "zone2",
            "duration_minutes": 40,
            "target_zone": "zone2",
            "hr_summary": {"zoneMinutes": {"zone2": 5, "zone3": 20, "zone4": 15}},
            "exercises": [{"name": "Zone 2 Run", "exercise_type": "cardio", "sets": [{"duration_seconds": 2400, "completed": True}]}],
        }
        for i in range(4)
    ]

    result = calculate_goal_score(payload)
    zone = _driver(result, "zoneIntensityAdherence")
    assert zone["score"] < 50, zone
    assert result["executionScore"] < 85, result
    _ok("runs outside prescribed zones reduce endurance execution")


def test_projection_example_midpoint() -> None:
    outcome = _project_outcome(
        projection=ProjectionInputs(
            metric="body_fat_pct",
            unit="percentage_points",
            target_change=-1.8,
            timeframe_days=42,
            actual_progress=-0.6,
            expected_progress_to_date=-0.6,
            source="example",
            reliability=80,
            signal_quality=80,
            sample_count=4,
        ),
        execution_score=85,
        response_factor=0.95,
        confidence=80,
    )

    assert outcome["expectedMidpoint"] == -1.5, outcome
    assert "body-fat percentage points" in outcome["displayText"], outcome
    _ok("projection midpoint matches -1.8 * .85 * .95 ~= -1.5 pp")


cases = [
    test_training_is_not_shallow,
    test_good_training_quality_scores_high,
    test_fat_loss_calorie_penalty,
    test_recomp_calorie_target_falls_back_to_resolved_targets,
    test_recomp_calorie_score_uses_adjusted_day_targets,
    test_missing_nutrition_logs_reduce_score_and_confidence,
    test_high_execution_but_poor_response,
    test_low_confidence_smart_scale_body_fat,
    test_sleep_recovery_impact,
    test_strength_goal_missed_intensity,
    test_endurance_zone_mismatch,
    test_projection_example_midpoint,
]


if __name__ == "__main__":
    for case in cases:
        print(f"\n[test] {case.__name__}")
        case()
