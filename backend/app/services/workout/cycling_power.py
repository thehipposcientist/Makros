from __future__ import annotations


def estimate_cycling_power_watts(
    *,
    distance_miles: float | None,
    duration_seconds: int | float | None,
    rider_weight_lbs: float | None,
    elevation_gain_ft: float | None = None,
    indoor: bool = False,
) -> int | None:
    try:
        distance = float(distance_miles or 0)
        duration = float(duration_seconds or 0)
        weight_lbs = float(rider_weight_lbs or 0)
        gain_ft = float(elevation_gain_ft or 0)
    except (TypeError, ValueError):
        return None
    if distance <= 0 or duration <= 0 or weight_lbs <= 0:
        return None

    mph = distance / (duration / 3600)
    if mph < 3 or mph > 45:
        return None

    distance_m = distance * 1609.344
    speed_mps = distance_m / duration
    rider_kg = weight_lbs * 0.45359237
    bike_kg = 10.0 if indoor else 12.0
    total_mass_kg = rider_kg + bike_kg
    gain_m = max(0.0, gain_ft * 0.3048)
    grade = min(0.18, gain_m / max(1.0, distance_m))

    gravity = 9.80665
    rolling_resistance = 0.004 if indoor else 0.005
    air_density = 1.225
    drag_area = 0.30 if indoor else 0.40
    drivetrain_efficiency = 0.95

    rolling_watts = total_mass_kg * gravity * rolling_resistance * speed_mps
    climbing_watts = total_mass_kg * gravity * grade * speed_mps
    aero_watts = 0.5 * air_density * drag_area * (speed_mps ** 3)
    watts = (rolling_watts + climbing_watts + aero_watts) / drivetrain_efficiency
    if not (25 <= watts <= 650):
        return None
    return int(round(watts))
