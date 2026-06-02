from __future__ import annotations

from app.services.workout.cycling_power import estimate_cycling_power_watts


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_estimates_reasonable_outdoor_ride_power():
    print("\n[test] cycling power: outdoor ride estimate")
    watts = estimate_cycling_power_watts(
        distance_miles=20,
        duration_seconds=3600,
        rider_weight_lbs=180,
        elevation_gain_ft=900,
    )
    assert watts is not None
    assert 180 <= watts <= 360, watts
    _ok(f"20 mi / 1h / 900 ft -> {watts} W")


def test_rejects_unrealistic_speed():
    print("\n[test] cycling power: unrealistic speed rejected")
    watts = estimate_cycling_power_watts(
        distance_miles=80,
        duration_seconds=3600,
        rider_weight_lbs=180,
    )
    assert watts is None
    _ok("unrealistic ride skipped")


cases = [
    test_estimates_reasonable_outdoor_ride_power,
    test_rejects_unrealistic_speed,
]


if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
