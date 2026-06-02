"""Context-aware health insight safety and behavior tests."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from app.services.context_insights.privacy import sanitize_context_segment
from app.services.context_insights.services import (
    BoneSupportInsightService,
    KeystoneHabitInsightService,
    NextBestActionService,
    OutdoorWorkoutPlannerService,
    RecoveryInsightService,
    RouteLoadInsightService,
    SocialWellnessInsightService,
    SunExposureInsightService,
    generate_context_insights,
)
from app.services.context_insights.types import DailyFeatureSet, Insight, OutdoorWindow, UserInsightPreferences


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _feature(offset: int, **overrides) -> DailyFeatureSet:
    base = {
        "user_id": 7,
        "date": date(2026, 5, 19) - timedelta(days=offset),
        "steps": 8000,
        "active_minutes": 35,
        "strength_workout_count": 0,
        "weight_bearing_minutes": 25,
        "mobility_minutes": 5,
        "elevation_gain_meters": 10,
        "outdoor_daylight_minutes": 20,
        "open_sky_equivalent_minutes": 10,
        "high_uv_minutes": 0,
        "sleep_duration_minutes": 430,
        "sleep_consistency_score": 80,
        "recovery_score": 75,
    }
    base.update(overrides)
    return DailyFeatureSet(**base)


def _insight_text(insight: Insight) -> str:
    return " ".join([
        insight.title,
        insight.summary,
        insight.recommended_action,
        insight.explanation,
        insight.safety_note or "",
    ]).lower()


def test_bone_support_copy_never_says_bone_density_score() -> None:
    features = [_feature(0, strength_workout_count=1), _feature(1), _feature(2)]
    insight = BoneSupportInsightService.build_insight(7, features, created_at=datetime(2026, 5, 19, tzinfo=timezone.utc))
    text = _insight_text(insight)
    assert "bone density score" not in text, text
    assert "bone-supporting behavior" in text, text
    assert "behavior patterns, not measured bone density" in text, text
    _ok("bone support copy avoids bone density score language")


def test_sun_exposure_does_not_calculate_vitamin_d_dose() -> None:
    insight = SunExposureInsightService.build_insight(
        7,
        [{
            "durationMinutes": 30,
            "outdoorConfidence": 0.8,
            "uvIndexMax": 2,
            "openSkyEquivalentMinutes": 15,
            "areaContext": {"skyExposureCoefficient": 0.5},
            "source": "coarse_location",
        }],
        created_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
    )
    text = _insight_text(insight)
    assert "vitamin d dose" not in text, text
    assert "vitamin d production" not in text, text
    assert "exact sun exposure" in text, text
    _ok("sun exposure insight avoids vitamin D dose claims")


def test_uv_three_creates_sun_protection_message() -> None:
    result = SunExposureInsightService.analyze(
        7,
        [{
            "durationMinutes": 20,
            "outdoorConfidence": 1,
            "uvIndexMax": 3,
            "openSkyEquivalentMinutes": 20,
            "areaContext": {"skyExposureCoefficient": 1},
            "source": "workout_route",
        }],
    )
    assert result["safetyMessage"] == "Sun protection would be recommended if you were outside.", result
    _ok("UV Index >= 3 creates sun protection messaging")


def test_sun_exposure_confidence_counts_unique_sources_and_days() -> None:
    rows = [
        {
            "durationMinutes": 10,
            "outdoorConfidence": 1,
            "uvIndexMax": 2,
            "openSkyEquivalentMinutes": 8,
            "areaContext": {"skyExposureCoefficient": 0.9},
            "source": "healthkit_daylight",
            "startTime": (datetime(2026, 5, 19, 9, tzinfo=timezone.utc) + timedelta(minutes=i * 15)).isoformat(),
        }
        for i in range(6)
    ]
    result = SunExposureInsightService.analyze(7, rows)
    assert result["confidence"] == "low", result
    _ok("sun exposure confidence is not inflated by many rows from one source/day")


def test_outdoor_planner_shifts_away_from_high_uv_aqi_and_heat() -> None:
    start = datetime(2026, 5, 19, 12, tzinfo=timezone.utc)
    result = OutdoorWorkoutPlannerService.plan([
        OutdoorWindow(
            start_time=start,
            end_time=start + timedelta(hours=1),
            uv_index=9,
            air_quality_index=140,
            temperature_f=96,
        ),
        OutdoorWindow(
            start_time=start - timedelta(hours=4),
            end_time=start - timedelta(hours=3),
            uv_index=2,
            air_quality_index=40,
            temperature_f=68,
        ),
    ], preferred_workout_type="run")
    assert result["recommendation"] == "shift_time", result
    assert result["bestWorkoutWindow"]["startTime"].startswith("2026-05-19T08:00:00"), result
    _ok("outdoor planner shifts away from high UV, poor AQI, and dangerous heat")


def test_recovery_lowers_intensity_after_poor_sleep_and_high_load() -> None:
    result = RecoveryInsightService.analyze(
        sleep_duration_minutes=300,
        workout_load=220,
        baseline_workout_load=120,
    )
    assert result["recoveryLabel"] == "low", result
    assert result["recommendedTrainingIntensity"] == "light", result
    _ok("recovery insight lowers training intensity after poor sleep and high load")


def test_generated_recovery_insight_uses_hrv_and_rhr_baselines() -> None:
    features = [
        _feature(i, hrv=62, resting_heart_rate=58, workout_load=90)
        for i in range(6, 0, -1)
    ]
    features.append(_feature(0, hrv=45, resting_heart_rate=66, workout_load=95, sleep_duration_minutes=430))
    insights = generate_context_insights(
        7,
        preferences=UserInsightPreferences(enable_recovery_insights=True),
        features=features,
        created_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
    )
    recovery = next(insight for insight in insights if insight.type == "recovery_context")
    text = _insight_text(recovery)
    assert "hrv" in text or "resting heart rate" in text, recovery
    assert recovery.confidence in {"medium", "high"}, recovery
    _ok("generated recovery insight compares latest vitals to recent baselines")


def test_route_load_increases_with_elevation_gain() -> None:
    flat = RouteLoadInsightService.analyze(distance_miles=3, elevation_gain_meters=0)
    hilly = RouteLoadInsightService.analyze(distance_miles=3, elevation_gain_meters=250)
    assert hilly["routeLoadScore"] > flat["routeLoadScore"], (flat, hilly)
    assert "bone-loading" in hilly["supports"], hilly
    _ok("route load score increases with elevation gain")


def test_social_insight_does_not_expose_exact_friend_location() -> None:
    result = SocialWellnessInsightService.analyze(
        opt_in=True,
        mutual_opt_in=True,
        group_workouts=1,
        social_activity_count=2,
        prior_social_activity_count=4,
        friend_locations=["123 Main St, Boston"],
    )
    text = str(result).lower()
    assert "123 main" not in text and "boston" not in text, result
    assert "social activity is lower than usual" in text, result
    _ok("social insight avoids exact friend locations and lonely labels")


def test_low_confidence_insight_displays_low_confidence() -> None:
    insight = Insight(
        id="test",
        user_id=7,
        type="test",
        category="move",
        title="Test",
        summary="A low-confidence pattern.",
        recommended_action="Keep logging.",
        confidence="low",
        data_sources=["activity"],
        explanation="Only one data source was available.",
    )
    assert insight.to_api()["confidence"] == "low", insight.to_api()
    _ok("low-confidence insight serializes low confidence")


def test_sensitive_places_do_not_create_location_insights() -> None:
    segment = sanitize_context_segment(
        {
            "id": "x",
            "startTime": "2026-05-19T10:00:00+00:00",
            "endTime": "2026-05-19T10:30:00+00:00",
            "placeCategory": "hospital",
            "coarseLocationHash": "dr5reg",
        },
        user_id=7,
    )
    assert segment is None, segment
    _ok("sensitive place categories do not create context segments")


def test_raw_passive_gps_is_not_stored_for_derived_insights() -> None:
    segment = sanitize_context_segment(
        {
            "id": "x",
            "startTime": "2026-05-19T10:00:00+00:00",
            "endTime": "2026-05-19T10:30:00+00:00",
            "placeCategory": "park_mixed",
            "coarseLocationHash": "dr5re",
            "lat": 42.3601,
            "lon": -71.0589,
            "routeCoords": [{"lat": 42.3601, "lon": -71.0589}],
        },
        user_id=7,
    )
    assert segment is not None
    dumped = str(segment.__dict__)
    assert "42.3601" not in dumped and "-71.0589" not in dumped, dumped
    assert "routeCoords" not in dumped and "route_coords" not in dumped, dumped
    _ok("derived context segment stores no raw passive GPS")


def test_next_best_action_returns_only_one_primary_action() -> None:
    insights = [
        Insight(
            id="a",
            user_id=7,
            type="move",
            category="move",
            title="Move",
            summary="Move summary",
            recommended_action="Take a 20-minute shaded walk before 10 AM.",
            confidence="high",
            data_sources=["steps"],
            explanation="High-confidence move pattern.",
            priority=80,
        ),
        Insight(
            id="b",
            user_id=7,
            type="recover",
            category="recover",
            title="Recover",
            summary="Recovery summary",
            recommended_action="Keep training light today.",
            confidence="medium",
            data_sources=["sleep"],
            explanation="Recovery is below baseline.",
            priority=70,
        ),
    ]
    action = NextBestActionService.pick(insights).to_api()
    assert action["primaryAction"] == "Take a 20-minute shaded walk before 10 AM.", action
    assert isinstance(action["primaryAction"], str) and not isinstance(action["primaryAction"], list), action
    _ok("next-best-action service returns one primary action")


def test_pattern_insights_use_correlation_not_causation_language() -> None:
    features = []
    for i in range(14):
        if i % 2 == 0:
            features.append(_feature(i, outdoor_daylight_minutes=25, steps=9200, sleep_duration_minutes=450))
        else:
            features.append(_feature(i, outdoor_daylight_minutes=0, steps=6500, sleep_duration_minutes=400))
    result = KeystoneHabitInsightService.detect(features)
    text = " ".join(str(value) for value in result.values()).lower()
    assert "appear linked" in text or "associated" in text, result
    assert "causes" not in text and "caused" not in text and "because of" not in text, result
    _ok("pattern insight uses correlation language, not causation language")


cases = [
    test_bone_support_copy_never_says_bone_density_score,
    test_sun_exposure_does_not_calculate_vitamin_d_dose,
    test_uv_three_creates_sun_protection_message,
    test_sun_exposure_confidence_counts_unique_sources_and_days,
    test_outdoor_planner_shifts_away_from_high_uv_aqi_and_heat,
    test_recovery_lowers_intensity_after_poor_sleep_and_high_load,
    test_generated_recovery_insight_uses_hrv_and_rhr_baselines,
    test_route_load_increases_with_elevation_gain,
    test_social_insight_does_not_expose_exact_friend_location,
    test_low_confidence_insight_displays_low_confidence,
    test_sensitive_places_do_not_create_location_insights,
    test_raw_passive_gps_is_not_stored_for_derived_insights,
    test_next_best_action_returns_only_one_primary_action,
    test_pattern_insights_use_correlation_not_causation_language,
]


if __name__ == "__main__":
    for case in cases:
        print(f"\n[test] {case.__name__}")
        case()
