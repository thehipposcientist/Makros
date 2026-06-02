"""Pure-function tests for passive sun exposure estimation."""
from __future__ import annotations

from datetime import date, datetime, timezone

from app.models import SunExposureSegment
from app.services.sun_exposure.area_coefficients import (
    AreaSunCoefficientService,
    canopyToSkyExposureCoefficient,
)
from app.services.sun_exposure.calculation import build_daily_summary, calculate_segment_values, safety_message_for_uv, uv_risk_score
from app.services.sun_exposure.corrections import apply_correction_to_segment_dict, future_adjusted_context
from app.services.sun_exposure.geo import coarse_hash_from_route
from app.services.sun_exposure.outdoor_confidence import estimate_outdoor_confidence
from app.services.sun_exposure.summary import assert_sun_copy_is_safe, build_summary_copy
from app.services.sun_exposure.types import AreaSunContext


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _segment(area: AreaSunContext, **overrides) -> dict:
    base = {
        "id": 1,
        "userId": 7,
        "startTime": "2026-05-19T12:00:00+00:00",
        "endTime": "2026-05-19T13:00:00+00:00",
        "durationMinutes": 60,
        "uvIndexAverage": 6,
        "uvIndexMax": 6,
        "daylight": True,
        "outdoorConfidence": 0.9,
        "areaContext": area.to_dict(),
        "effectiveUvMinutes": 0,
        "openSkyEquivalentMinutes": 0,
        "confidence": "high",
        "source": "workout_route",
    }
    base.update(overrides)
    return base


def test_dense_forest_lower_than_open_grass() -> None:
    svc = AreaSunCoefficientService()
    forest = svc.classify({"landcover": "forest trail", "treeCoverPercent": 85})
    grass = svc.classify({"landcover": "open grass"})
    forest_values = calculate_segment_values(
        duration_minutes=60,
        uv_index_average=5,
        outdoor_confidence=1,
        area_context=forest,
    )
    grass_values = calculate_segment_values(
        duration_minutes=60,
        uv_index_average=5,
        outdoor_confidence=1,
        area_context=grass,
    )
    assert forest.sky_exposure_coefficient == canopyToSkyExposureCoefficient(85), forest
    assert forest_values["open_sky_equivalent_minutes"] < grass_values["open_sky_equivalent_minutes"], (forest_values, grass_values)
    _ok("dense tree cover produces fewer open-sky equivalent minutes than open grass")


def test_reflection_coefficients_increase_uv_weighted_exposure() -> None:
    svc = AreaSunCoefficientService()
    open_grass = svc.classify({"landcover": "open grass"})
    beach = svc.classify({"landcover": "beach sand"})
    snow = svc.classify({"landcover": "snow ski"})
    grass = calculate_segment_values(duration_minutes=30, uv_index_average=7, outdoor_confidence=1, area_context=open_grass)
    beach_values = calculate_segment_values(duration_minutes=30, uv_index_average=7, outdoor_confidence=1, area_context=beach)
    snow_values = calculate_segment_values(duration_minutes=30, uv_index_average=7, outdoor_confidence=1, area_context=snow)
    assert beach_values["effective_uv_minutes"] > grass["effective_uv_minutes"], beach_values
    assert snow_values["effective_uv_minutes"] > beach_values["effective_uv_minutes"], snow_values
    _ok("beach and snow reflection increase UV-weighted exposure estimates")


def test_unknown_area_is_not_full_sun() -> None:
    unknown = AreaSunCoefficientService().classify({})
    assert unknown.area_type == "unknown", unknown
    assert unknown.sky_exposure_coefficient == 0.50, unknown
    assert unknown.sky_exposure_coefficient < 1.0, unknown
    assert "unknown_not_full_sun" in unknown.reason_codes, unknown
    _ok("unknown area stays partial sun, not full sun")


def test_indoor_building_polygon_near_zero() -> None:
    indoor = AreaSunCoefficientService().classify({"buildingPolygon": True})
    assert indoor.area_type == "indoor", indoor
    assert indoor.sky_exposure_coefficient <= 0.02, indoor
    _ok("building polygon classifies near-zero sky exposure")


def test_workout_route_high_outdoor_confidence() -> None:
    estimate = estimate_outdoor_confidence(source="workout_route", signals={"hasWorkoutRoute": True})
    assert estimate.outdoor_confidence >= 0.9, estimate
    assert estimate.likely_outdoor is True, estimate
    _ok("workout route is a high-confidence outdoor signal")


def test_healthkit_daylight_high_outdoor_confidence() -> None:
    estimate = estimate_outdoor_confidence(source="healthkit_daylight", signals={"healthkitDaylightMinutes": 20})
    assert estimate.outdoor_confidence >= 0.9, estimate
    assert estimate.likely_outdoor is True, estimate
    _ok("HealthKit daylight data is high-confidence")


def test_explicit_indoor_venue_overrides_outdoor_subtype() -> None:
    # An indoor (treadmill) run must NOT be credited as outdoor just because
    # "run" is usually outdoors — the explicit venue wins over the subtype prior.
    estimate = estimate_outdoor_confidence(signals={"activitySubtype": "run", "venue": "indoor"})
    assert estimate.outdoor_confidence <= 0.1, estimate
    assert estimate.likely_outdoor is False, estimate
    # `terrain: treadmill` is treated the same way.
    treadmill = estimate_outdoor_confidence(signals={"activitySubtype": "run", "terrain": "treadmill"})
    assert treadmill.outdoor_confidence <= 0.1, treadmill
    _ok("explicit indoor venue overrides an outdoor-by-default subtype")


def test_explicit_outdoor_venue_high_confidence() -> None:
    estimate = estimate_outdoor_confidence(signals={"activitySubtype": "ride", "venue": "outdoor"})
    assert estimate.outdoor_confidence >= 0.85, estimate
    assert estimate.likely_outdoor is True, estimate
    _ok("explicit outdoor venue is high-confidence")


def test_subtype_prior_alone_is_weak_when_venue_unknown() -> None:
    # No venue, no GPS, no daylight — the activity type alone is only a weak
    # leaning-outdoor guess, not a confident outdoor credit.
    estimate = estimate_outdoor_confidence(signals={"activitySubtype": "run"})
    assert 0.4 <= estimate.outdoor_confidence <= 0.6, estimate
    assert estimate.likely_outdoor == "unknown", estimate
    _ok("subtype prior alone is a weak unknown-confidence signal")


def test_uv_three_creates_protection_message() -> None:
    assert safety_message_for_uv(3) == "Sun protection would be recommended if you were outside."
    _ok("UV Index >= 3 creates protection language")


def test_summary_separates_likely_from_open_sky_equivalent() -> None:
    wooded = AreaSunCoefficientService().classify({"landcover": "wooded trail"})
    summary = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(wooded)],
    )
    assert summary.likely_outdoor_daylight_minutes > summary.open_sky_equivalent_minutes, summary
    assert summary.likely_outdoor_daylight_minutes == 54, summary
    assert summary.open_sky_equivalent_minutes < 54, summary
    _ok("summary keeps likely outdoor minutes separate from open-sky equivalent minutes")


def test_summary_includes_daily_uv_and_sun_score() -> None:
    open_sky = AreaSunContext(
        area_type="open_grass",
        sky_exposure_coefficient=1.0,
        reflection_coefficient=1.0,
        source="manual",
        confidence="high",
    )
    summary = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(open_sky, durationMinutes=25, uvIndexAverage=4, uvIndexMax=4, outdoorConfidence=1.0)],
    )
    dumped = summary.to_dict()
    assert dumped["uvIndexAverage"] == 4.0, dumped
    assert dumped["uvIndexMax"] == 4.0, dumped
    assert 25 <= dumped["uvRiskScore"] <= 49, dumped
    assert dumped["uvRiskLabel"] == "Moderate", dumped
    assert 70 <= dumped["sunScore"] <= 100, dumped
    assert dumped["sunScoreLabel"] == "Balanced", dumped
    _ok("daily summary separates UV risk from the daylight balance score")


def test_healthkit_lux_metadata_feeds_daylight_score() -> None:
    unknown = AreaSunCoefficientService().classify({})
    summary = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(
            unknown,
            durationMinutes=30,
            uvIndexAverage=3,
            uvIndexMax=3,
            outdoorConfidence=0.95,
            source="healthkit_daylight",
            lightIntensityLux=12000,
        )],
    )
    dumped = summary.to_dict()
    assert dumped["daylightMinutes"] == dumped["appleHealthDaylightMinutes"], dumped
    assert dumped["lightIntensityLuxAverage"] == 12000, dumped
    assert dumped["uvIndexAverage"] == 3.0, dumped
    assert dumped["sunScore"] >= 70, dumped
    _ok("HealthKit daylight, lux, and UV feed the daily sun score")


def test_sun_score_penalizes_long_very_high_uv_windows() -> None:
    open_sky = AreaSunContext(
        area_type="open_grass",
        sky_exposure_coefficient=1.0,
        reflection_coefficient=1.0,
        source="manual",
        confidence="high",
    )
    moderate = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(open_sky, durationMinutes=25, uvIndexAverage=4, uvIndexMax=4, outdoorConfidence=1.0)],
    )
    intense = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 20),
        segments=[_segment(open_sky, durationMinutes=70, uvIndexAverage=9, uvIndexMax=9, outdoorConfidence=1.0)],
    )
    assert intense.sun_score < moderate.sun_score, (moderate, intense)
    assert intense.sun_score_label == "High UV lowered score", intense
    _ok("sun score rewards daylight while flagging long very-high-UV windows")


def test_daylight_timing_feeds_user_specific_score() -> None:
    open_sky = AreaSunContext(
        area_type="open_grass",
        sky_exposure_coefficient=1.0,
        reflection_coefficient=1.0,
        source="manual",
        confidence="high",
    )
    morning = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(
            open_sky,
            durationMinutes=25,
            uvIndexAverage=2.5,
            uvIndexMax=2.5,
            outdoorConfidence=1.0,
            localStartMinute=7 * 60,
            lightIntensityLux=4000,
            source="healthkit_daylight",
        )],
    )
    midday = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(
            open_sky,
            durationMinutes=25,
            uvIndexAverage=2.5,
            uvIndexMax=2.5,
            outdoorConfidence=1.0,
            localStartMinute=12 * 60,
            lightIntensityLux=4000,
            source="healthkit_daylight",
        )],
    )
    assert morning.morning_daylight_minutes == 25, morning
    assert midday.midday_daylight_minutes == 25, midday
    assert morning.sun_score > midday.sun_score, (morning, midday)
    assert morning.sun_score_label == "Morning daylight", morning
    _ok("local daylight timing contributes to the daily user score")


def test_uv_risk_score_uses_uv_weighted_exposure_and_peak_uv() -> None:
    low_score, low_label = uv_risk_score(
        effective_uv_minutes=0,
        uv_index_max=1,
        high_uv_minutes=0,
        very_high_uv_minutes=0,
    )
    high_score, high_label = uv_risk_score(
        effective_uv_minutes=320,
        uv_index_max=9,
        high_uv_minutes=70,
        very_high_uv_minutes=30,
    )
    assert low_score == 0 and low_label == "Low", (low_score, low_label)
    assert high_score > low_score, (low_score, high_score)
    assert high_label in {"High", "Very high"}, (high_score, high_label)
    _ok("UV risk score rises with UV-weighted exposure and peak UV")


def test_mostly_shaded_correction_reduces_future_coefficient() -> None:
    open_grass = AreaSunCoefficientService().classify({"landcover": "open grass"})
    adjusted = future_adjusted_context(open_grass, [{"correctionType": "mostly_shaded"}])
    assert adjusted.sky_exposure_coefficient < open_grass.sky_exposure_coefficient, adjusted
    assert adjusted.sky_exposure_coefficient <= 0.35, adjusted
    _ok("mostly shaded correction lowers future coefficient for similar context")


def test_indoors_correction_prevents_sun_logging() -> None:
    open_grass = AreaSunCoefficientService().classify({"landcover": "open grass"})
    corrected = apply_correction_to_segment_dict(_segment(open_grass), "indoors")
    assert corrected["outdoorConfidence"] == 0.0, corrected
    assert corrected["effectiveUvMinutes"] == 0.0, corrected
    assert corrected["openSkyEquivalentMinutes"] == 0.0, corrected
    _ok("indoors correction zeros outdoor sun estimate for the segment")


def test_copy_never_says_app_knows_user_was_outside() -> None:
    open_grass = AreaSunCoefficientService().classify({"landcover": "open grass"})
    summary = build_daily_summary(
        user_id=7,
        summary_date=date(2026, 5, 19),
        segments=[_segment(open_grass)],
    )
    copy = " ".join(build_summary_copy(summary) + [summary.explanation, summary.safety_message or ""])
    assert_sun_copy_is_safe(copy)
    assert "we know you were outside" not in copy.lower(), copy
    assert "vitamin d dose" not in copy.lower(), copy
    assert "safe sun exposure" not in copy.lower(), copy
    _ok("summary copy avoids certainty and medical-dose language")


def test_raw_gps_not_stored_for_passive_records() -> None:
    route = [
        {"lat": 42.3601, "lon": -71.0589, "t_ms": 1},
        {"lat": 42.3610, "lon": -71.0595, "t_ms": 2},
    ]
    coarse = coarse_hash_from_route(route)
    assert coarse and "42.3601" not in coarse and "-71.0589" not in coarse, coarse
    context = AreaSunCoefficientService().classify({"landcover": "urban street"})
    row = SunExposureSegment(
        user_id=7,
        start_time=datetime(2026, 5, 19, 12, tzinfo=timezone.utc),
        end_time=datetime(2026, 5, 19, 13, tzinfo=timezone.utc),
        duration_minutes=60,
        coarse_location_hash=coarse,
        uv_index_average=5,
        uv_index_max=5,
        daylight=True,
        outdoor_confidence=0.9,
        area_context=context.to_dict(),
        effective_uv_minutes=162,
        open_sky_equivalent_minutes=32.4,
        confidence="medium",
        source="workout_route",
    )
    dumped = row.model_dump(mode="json")
    text = str(dumped)
    assert "route_coords" not in dumped, dumped
    assert "42.3601" not in text and "-71.0589" not in text, dumped
    _ok("derived sun exposure record stores coarse hash/context, not raw GPS")


cases = [
    test_dense_forest_lower_than_open_grass,
    test_reflection_coefficients_increase_uv_weighted_exposure,
    test_unknown_area_is_not_full_sun,
    test_indoor_building_polygon_near_zero,
    test_workout_route_high_outdoor_confidence,
    test_healthkit_daylight_high_outdoor_confidence,
    test_explicit_indoor_venue_overrides_outdoor_subtype,
    test_explicit_outdoor_venue_high_confidence,
    test_subtype_prior_alone_is_weak_when_venue_unknown,
    test_uv_three_creates_protection_message,
    test_summary_separates_likely_from_open_sky_equivalent,
    test_summary_includes_daily_uv_and_sun_score,
    test_healthkit_lux_metadata_feeds_daylight_score,
    test_sun_score_penalizes_long_very_high_uv_windows,
    test_daylight_timing_feeds_user_specific_score,
    test_uv_risk_score_uses_uv_weighted_exposure_and_peak_uv,
    test_mostly_shaded_correction_reduces_future_coefficient,
    test_indoors_correction_prevents_sun_logging,
    test_copy_never_says_app_knows_user_was_outside,
    test_raw_gps_not_stored_for_passive_records,
]


if __name__ == "__main__":
    for case in cases:
        print(f"\n[test] {case.__name__}")
        case()
