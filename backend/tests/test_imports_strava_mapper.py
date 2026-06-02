"""Pure-function tests for the Strava activity mapper.

No network. Synthetic activity dicts mirror the schema returned by
Strava's GET /api/v3/athlete/activities. The orchestrator that
actually calls Strava is intentionally not under test here — that
needs real OAuth + network and is verified through manual smoke
test once the dev app is registered.

Run:
    docker exec -it thallo-backend python -m tests.test_imports_strava_mapper
"""
from __future__ import annotations

from datetime import datetime, timezone

from app.services.imports.strava_mapper import (
    map_strava_activity,
    map_strava_activities,
)


def assert_eq(actual, expected, label: str) -> None:
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def _activity(**overrides):
    """Builder for synthetic Strava activity dicts."""
    base = {
        "id": 12345,
        "name": "Morning Run",
        "type": "Run",
        "sport_type": "Run",
        "start_date": "2026-05-10T07:00:00Z",
        "distance": 5234.5,        # 3.25 miles
        "moving_time": 1820,        # 30 min 20s
        "elapsed_time": 1980,
        "average_heartrate": 152,
        "max_heartrate": 178,
        "calories": 412,
    }
    base.update(overrides)
    return base


def test_basic_run():
    print("[test] basic run maps to focus=Run, cardio, miles")
    m = map_strava_activity(_activity())
    assert_eq(m.external_id, "strava:12345", "external_id prefix")
    assert_eq(m.focus_label, "Run", "Strava Run → Run")
    assert_eq(m.activity_category, "cardio", "categorized as cardio")
    assert_eq(m.distance_miles, 3.25, "5234.5m → 3.25 mi")
    assert_eq(m.duration_seconds, 1820, "moving_time used")
    assert_eq(m.calories_burned, 412, "calories")
    assert_eq(m.avg_hr_bpm, 152, "avg HR")
    assert_eq(m.max_hr_bpm, 178, "max HR")
    assert_eq(m.activity_details["movingSeconds"], 1820, "moving seconds retained")
    assert_eq(m.activity_details["elapsedSeconds"], 1980, "elapsed seconds retained")
    assert_eq(m.activity_details["durationSource"], "moving_time", "duration source retained")


def test_ride_to_cycling():
    print("[test] Strava Ride → focus_label Cycling")
    m = map_strava_activity(_activity(sport_type="Ride", distance=20000.0))
    assert_eq(m.focus_label, "Cycling", "Ride mapped to Cycling")
    assert_eq(m.distance_miles, 12.43, "20000m → 12.43 mi")


def test_preserves_strava_endurance_metrics():
    print("[test] Strava endurance metrics land in activity_details + route")
    m = map_strava_activity(_activity(
        sport_type="Ride",
        distance=20000.0,
        total_elevation_gain=45.2,
        average_speed=5.5,
        max_speed=12.0,
        average_cadence=82.4,
        average_watts=175.2,
        weighted_average_watts=190.6,
        max_watts=530,
        kilojoules=350.4,
        device_watts=True,
        has_heartrate=True,
        gear_id="bike-1",
        map={"id": "route-1", "summary_polyline": "_p~iF~ps|U_ulLnnqC_mqNvxq`@"},
    ))
    details = m.activity_details or {}
    assert_eq(details["elevationGainFt"], 148, "elevation gain meters → feet")
    assert_eq(details["avgSpeedMph"], 12.3, "average speed m/s → mph")
    assert_eq(details["maxSpeedMph"], 26.8, "max speed m/s → mph")
    assert_eq(details["avgCadence"], 82.4, "cadence retained")
    assert_eq(details["avgWatts"], 175, "average watts retained")
    assert_eq(details["avgWattsSource"], "strava_device", "device watts source")
    assert_eq(details["weightedAvgWatts"], 191, "weighted watts retained")
    assert_eq(details["maxWatts"], 530, "max watts retained")
    assert_eq(details["kilojoules"], 350, "kilojoules retained")
    assert_eq(details["stravaGearId"], "bike-1", "gear id retained")
    assert_eq(details["stravaMapId"], "route-1", "map id retained")
    assert_eq("avgPaceSecPerMi" in details, False, "cycling keeps speed, not run pace")
    assert_eq(len(m.route_coords or []), 3, "summary polyline decoded")


def test_virtual_ride_subtype_preserved():
    print("[test] VirtualRide carries subtype + maps to Cycling")
    m = map_strava_activity(_activity(sport_type="VirtualRide"))
    assert_eq(m.focus_label, "Cycling", "VirtualRide → Cycling focus")
    assert_eq(m.activity_subtype, "VirtualRide", "subtype preserved for analytics")


def test_unknown_activity_type_falls_back():
    print("[test] unknown activity type → focus=Cardio")
    m = map_strava_activity(_activity(sport_type="Kitesurf"))
    assert_eq(m.focus_label, "Cardio", "unknown type → Cardio")
    assert_eq(m.activity_subtype, "Kitesurf", "subtype preserved verbatim")


def test_weight_training_is_strength():
    print("[test] WeightTraining → strength category")
    m = map_strava_activity(_activity(sport_type="WeightTraining", distance=0))
    assert_eq(m.focus_label, "Strength", "Strength focus")
    assert_eq(m.activity_category, "strength", "category strength")
    assert_eq(m.distance_miles, None, "no distance for strength")


def test_yoga_is_mobility():
    print("[test] Yoga → mobility category")
    m = map_strava_activity(_activity(sport_type="Yoga", distance=0))
    assert_eq(m.activity_category, "mobility", "mobility category")
    assert_eq(m.focus_label, "Mobility", "Mobility focus")
    assert_eq(m.cardio_style, None, "no cardio_style for non-cardio")


def test_interval_classification_via_hr_ratio():
    print("[test] high max/avg HR ratio → intervals")
    m = map_strava_activity(_activity(
        average_heartrate=140, max_heartrate=185,
    ))
    # 185 / 140 = 1.32 > 1.25 → intervals
    assert_eq(m.cardio_style, "intervals", "HR variance → intervals")


def test_steady_when_modest_variance():
    print("[test] modest HR variance → steady")
    m = map_strava_activity(_activity(
        average_heartrate=145, max_heartrate=160,
    ))
    # 160 / 145 = 1.10 < 1.25 → steady
    assert_eq(m.cardio_style, "steady", "modest variance → steady")


def test_easy_classification_with_age():
    print("[test] avg HR < 65% of estimated MaxHR → easy")
    # age 30 → MaxHR 190 → 65% = 123.5
    m = map_strava_activity(_activity(
        average_heartrate=110, max_heartrate=125,
    ), age=30)
    # max/avg = 1.14 (not intervals), avg < 0.65 * 190 → easy
    assert_eq(m.cardio_style, "easy", "low HR → easy")


def test_no_hr_data_leaves_style_null():
    print("[test] missing HR → cardio_style None")
    activity = _activity()
    del activity["average_heartrate"]
    del activity["max_heartrate"]
    m = map_strava_activity(activity)
    assert_eq(m.cardio_style, None, "no HR → can't classify")


def test_uses_elapsed_when_moving_missing():
    print("[test] moving_time absent → falls back to elapsed_time")
    activity = _activity()
    del activity["moving_time"]
    m = map_strava_activity(activity)
    assert_eq(m.duration_seconds, 1980, "elapsed_time used as fallback")


def test_invalid_activity_returns_none():
    print("[test] missing id → None")
    activity = _activity()
    del activity["id"]
    assert map_strava_activity(activity) is None, "no id → None"
    print("  ✓ missing id rejected")

    print("[test] missing start_date → None")
    activity = _activity()
    del activity["start_date"]
    assert map_strava_activity(activity) is None, "no start_date → None"
    print("  ✓ missing start_date rejected")

    print("[test] zero duration → None")
    assert map_strava_activity(_activity(moving_time=0, elapsed_time=0)) is None, "zero duration"
    print("  ✓ zero duration rejected")


def test_ended_at_derived_from_start_plus_duration():
    print("[test] ended_at = start + duration")
    m = map_strava_activity(_activity())
    expected_end = datetime(2026, 5, 10, 7, 0, 0, tzinfo=timezone.utc).timestamp() + 1820
    assert_eq(m.ended_at.timestamp(), expected_end, "end timestamp")


def test_map_list_drops_unparseable_silently():
    print("[test] map list — unparseable activities dropped, valid kept")
    activities = [
        _activity(id=1),
        {"name": "broken"},                      # no id, no start_date
        _activity(id=2, sport_type="Ride"),
    ]
    out = map_strava_activities(activities)
    assert_eq(len(out), 2, "2 of 3 mapped")
    assert_eq(out[0].external_id, "strava:1", "first kept")
    assert_eq(out[1].external_id, "strava:2", "second kept")


def test_external_id_prefix_namespaces_strava():
    print("[test] external_id prefix prevents collision with HK")
    m = map_strava_activity(_activity(id=99999999))
    assert m.external_id.startswith("strava:"), f"prefix missing: {m.external_id}"
    print("  ✓ strava: prefix present")


if __name__ == "__main__":
    test_basic_run()
    test_ride_to_cycling()
    test_preserves_strava_endurance_metrics()
    test_virtual_ride_subtype_preserved()
    test_unknown_activity_type_falls_back()
    test_weight_training_is_strength()
    test_yoga_is_mobility()
    test_interval_classification_via_hr_ratio()
    test_steady_when_modest_variance()
    test_easy_classification_with_age()
    test_no_hr_data_leaves_style_null()
    test_uses_elapsed_when_moving_missing()
    test_invalid_activity_returns_none()
    test_ended_at_derived_from_start_plus_duration()
    test_map_list_drops_unparseable_silently()
    test_external_id_prefix_namespaces_strava()
    print("\n✅ test_imports_strava_mapper.py PASSED")
