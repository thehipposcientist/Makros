"""Adaptive daily hydration target.

Pure function — no DB, no I/O. Mirrors the surgical pattern used elsewhere
in `services/nutrition/`: the caller sources signals from the request
context and feeds them in; this module decides how much fluid to recommend.

Inputs and weights are calibrated against ACSM / IOM guidance:

  - Baseline:       0.5 oz per lb of bodyweight (~30 ml/kg). Clamped
                    [55, 140] oz to avoid absurd recommendations at the
                    extremes (very small users get a usable floor; very
                    large users are protected from the linear scaling
                    pushing them into hyponatremia territory).
  - Training:       8–28 oz per 60 min of session, scaled by intensity
                    (light / moderate / heavy). Capped at +40 oz so a
                    very long session doesn't dominate the recommendation
                    without electrolytes.
  - Active energy:  +14 oz at 700 kcal active, +20 oz at 1000 kcal —
                    sweat proxy for high-output days that wouldn't
                    otherwise be flagged by duration alone.
  - Heat:           +14 oz over 85°F, +20 oz over 95°F. Skipped when
                    ambient temp isn't available (HealthKit doesn't
                    expose it on every device).

Protein-load, alcohol, sex-adjusted oz/lb, age, activity, and heat
adaptations all resolve here. Callers then expose the adapted midpoint
along with a daily range for `/meals/hydration` and
`/meals/adjusted-daily-target`.
"""
from __future__ import annotations

import math
from typing import Any


# Baseline clamp — IOM lower bound for healthy adults / ceiling against
# dilutional hyponatremia at very high bodyweight.
#
# oz/lb varies by sex to mirror IOM's adequate-intake reference (~3.7 L
# men / ~2.7 L women), proportional to typical bodyweight. The 0.50
# fallback covers nonbinary / unspecified / missing-sex profiles.
_BASELINE_OZ_PER_LB_MALE = 0.52
_BASELINE_OZ_PER_LB_FEMALE = 0.45
_BASELINE_OZ_PER_LB_DEFAULT = 0.50
_BASELINE_FLOOR_OZ = 55
_BASELINE_CEIL_OZ = 140
_BASELINE_FALLBACK_OZ = 80  # used when bodyweight is missing


def _baseline_oz_per_lb(sex: str | None) -> float:
    s = (sex or "").strip().lower()
    if s in {"male", "m"}:
        return _BASELINE_OZ_PER_LB_MALE
    if s in {"female", "f"}:
        return _BASELINE_OZ_PER_LB_FEMALE
    return _BASELINE_OZ_PER_LB_DEFAULT


def _age_baseline_bonus_oz(age: int | None) -> int:
    """Older adults have reduced thirst sensation and lower urine
    concentrating ability (ACSM/IOM aging hydration guidance). Small
    baseline bump from 65+. Floors when bodyweight clamps already
    cover the user."""
    if not age or age < 0:
        return 0
    if age >= 75:
        return 8
    if age >= 65:
        return 5
    return 0

# Training add-on per 60 min, by intensity bucket.
_TRAINING_OZ_PER_HOUR = {
    "light":    10,   # mobility, recovery walk, easy zone-1
    "moderate": 16,   # standard hypertrophy / zone-2
    "heavy":    24,   # heavy lift, HIIT, intervals, double session
}
_TRAINING_ADDON_CAP_OZ = 40

# Active energy (sweat proxy). Kicks in only when daily active calories
# are well above a typical NEAT-only day; layered on top of training so a
# session that BOTH ran long AND burned a ton gets credit for both.
_ACTIVE_ADDON_CAP_OZ = 24

# Heat add-on. Only applied when caller passes ambient temp.
_HEAT_TEMP_AMBER_F = 85.0
_HEAT_TEMP_RED_F = 95.0


def hydration_target_range_oz(target_oz: float | int | None) -> dict[str, int]:
    """Daily water is a range around the adapted midpoint.

    The midpoint still carries every adaptation input (body size, training,
    active energy, protein, alcohol, age, heat). The user-facing band avoids
    turning an estimated fluid need into a hard cliff.
    """
    try:
        target = float(target_oz or 0)
    except (TypeError, ValueError):
        target = 0.0
    if target <= 0:
        return {"target_min_oz": 0, "target_max_oz": 0}
    midpoint = int(round(target))
    lower = int(max(1, min(midpoint, math.floor(target * 0.90 / 4.0) * 4)))
    upper = int(max(midpoint, math.ceil(target * 1.10 / 4.0) * 4))
    return {"target_min_oz": lower, "target_max_oz": upper}


def _classify_intensity(
    intensity: str | None,
    *,
    duration_min: float,
    active_energy_kcal: float | None,
    cardio_style: str | None = None,
    activity_category: str | None = None,
    stimulus: str | None = None,
) -> str:
    """Normalize the intensity bucket. Priority order:
       1. Explicit `intensity` string (caller's override).
       2. Explicit `cardio_style` — "intervals" → heavy, "recovery"/"easy" → light.
       3. Explicit `activity_category` / `stimulus` — mobility & recovery → light.
       4. Fall back to the legacy kcal/duration heuristic.

    Previously we only consulted the explicit `intensity` string and
    then inferred from active energy + duration — which conflated a long
    Zone-2 walk with a Zone-4 HIIT block any time their kcal/duration
    landed in the same bin. Reading `cardio_style` / `activity_category`
    / `stimulus` directly resolves that ambiguity using fields the
    planner already writes onto every WorkoutCompletion.
    """
    if intensity:
        key = intensity.strip().lower()
        if key in _TRAINING_OZ_PER_HOUR:
            return key
        if key in {"hard", "high", "intense", "vigorous"}:
            return "heavy"
        if key in {"easy", "recovery", "mobility", "low"}:
            return "light"
        if key in {"medium", "normal", "standard"}:
            return "moderate"

    style = (cardio_style or "").strip().lower()
    if style == "intervals":
        return "heavy"
    if style in {"recovery", "easy"}:
        return "light"

    cat = (activity_category or "").strip().lower()
    if cat in {"recovery", "mobility", "active"}:
        return "light"

    stim = (stimulus or "").strip().lower()
    if stim in {"recovery", "mobility"}:
        return "light"
    if stim == "conditioning":
        return "heavy"

    # Last-resort heuristic — long sessions or very high active energy
    # imply heavy demand even when metadata is missing.
    if (active_energy_kcal or 0) >= 700 or duration_min >= 90:
        return "heavy"
    return "moderate"


def _training_addon_oz(
    *,
    duration_min: float,
    intensity_bucket: str,
) -> int:
    if duration_min <= 0:
        return 0
    per_hour = _TRAINING_OZ_PER_HOUR.get(intensity_bucket, _TRAINING_OZ_PER_HOUR["moderate"])
    raw = (duration_min / 60.0) * per_hour
    return int(round(min(_TRAINING_ADDON_CAP_OZ, max(0.0, raw))))


def _active_energy_addon_oz(active_energy_kcal: float | None) -> int:
    if active_energy_kcal is None:
        return 0
    kcal = float(active_energy_kcal)
    if kcal >= 1000:
        addon = 20
    elif kcal >= 700:
        addon = 14
    else:
        addon = 0
    return min(_ACTIVE_ADDON_CAP_OZ, addon)


def _protein_addon_oz(bodyweight_lb: float | None, protein_g_today: float | None) -> int:
    if not bodyweight_lb or bodyweight_lb <= 0 or not protein_g_today:
        return 0
    per_lb = float(protein_g_today) / float(bodyweight_lb)
    if per_lb >= 1.5:
        return 16
    if per_lb >= 1.0:
        return 8
    return 0


def _alcohol_addon_oz(alcohol_servings_today: float | None) -> int:
    if not alcohol_servings_today:
        return 0
    return int(round(min(36.0, max(0.0, float(alcohol_servings_today)) * 12.0)))


def _heat_addon_oz(ambient_temp_f: float | None) -> int:
    if ambient_temp_f is None:
        return 0
    t = float(ambient_temp_f)
    if t > _HEAT_TEMP_RED_F:
        return 20
    if t > _HEAT_TEMP_AMBER_F:
        return 14
    return 0


def _build_reason(
    *,
    intensity_bucket: str,
    duration_min: float,
    training_addon: int,
    active_addon: int,
    heat_addon: int,
    ambient_temp_f: float | None,
) -> str | None:
    """Single-sentence human explanation. Returned only when an add-on
    actually fired so the UI can decide whether to surface it."""
    parts: list[str] = []
    if training_addon > 0 and duration_min > 0:
        parts.append(
            f"{intensity_bucket} {int(round(duration_min))}-minute workout"
        )
    if active_addon > 0:
        parts.append("high active-calorie burn")
    if heat_addon > 0 and ambient_temp_f is not None:
        parts.append(f"warm conditions ({int(round(ambient_temp_f))}°F)")
    if not parts:
        return None
    if len(parts) == 1:
        body = parts[0]
    elif len(parts) == 2:
        body = f"{parts[0]} and {parts[1]}"
    else:
        body = ", ".join(parts[:-1]) + f", and {parts[-1]}"
    return f"Includes extra hydration for today's {body}."


def compute_hydration_target_oz(
    bodyweight_lb: float | None,
    workout_duration_min: float | None = None,
    workout_intensity: str | None = None,
    active_energy_kcal: float | None = None,
    ambient_temp_f: float | None = None,
    goal: str | None = None,
    protein_g_today: float | None = None,
    alcohol_servings_today: float | None = None,
    *,
    cardio_style: str | None = None,
    activity_category: str | None = None,
    stimulus: str | None = None,
    sex: str | None = None,
    age: int | None = None,
) -> dict[str, Any]:
    """Compute today's hydration target with a structured breakdown.

    Returns a dict with:
      - target_oz:               adapted midpoint for the day
      - target_min_oz/max_oz:    soft daily range around that midpoint
      - baseline_oz:             body-mass-driven floor (clamped)
      - training_addon_oz:       intensity × duration scaled bonus
      - active_energy_addon_oz:  sweat proxy from total active calories
      - heat_addon_oz:           ambient temperature add-on (0 when
                                 caller doesn't pass temp)
      - protein_addon_oz:        today's high-protein fluid support
      - alcohol_addon_oz:        today's alcohol fluid support
      - reason:                  optional human-readable one-liner used
                                 by the UI when any add-on is non-zero

    `goal` is accepted for forward compatibility (e.g. cuts may want a
    slightly higher floor for satiety) but currently does not bias the
    target — keeping today's calc transparent and easy to reason about.
    """
    duration = float(workout_duration_min or 0.0) if workout_duration_min else 0.0
    if duration < 0:
        duration = 0.0

    if bodyweight_lb and bodyweight_lb > 0:
        oz_per_lb = _baseline_oz_per_lb(sex)
        raw_baseline = float(bodyweight_lb) * oz_per_lb + _age_baseline_bonus_oz(age)
        baseline = int(round(max(_BASELINE_FLOOR_OZ, min(_BASELINE_CEIL_OZ, raw_baseline))))
    else:
        baseline = _BASELINE_FALLBACK_OZ + _age_baseline_bonus_oz(age)

    intensity_bucket = _classify_intensity(
        workout_intensity,
        duration_min=duration,
        active_energy_kcal=active_energy_kcal,
        cardio_style=cardio_style,
        activity_category=activity_category,
        stimulus=stimulus,
    )
    training_addon = _training_addon_oz(
        duration_min=duration,
        intensity_bucket=intensity_bucket,
    )
    active_addon = _active_energy_addon_oz(active_energy_kcal)
    heat_addon = _heat_addon_oz(ambient_temp_f)
    protein_addon = _protein_addon_oz(bodyweight_lb, protein_g_today)
    alcohol_addon = _alcohol_addon_oz(alcohol_servings_today)

    target = baseline + training_addon + active_addon + heat_addon + protein_addon + alcohol_addon
    target_range = hydration_target_range_oz(target)
    reason = _build_reason(
        intensity_bucket=intensity_bucket,
        duration_min=duration,
        training_addon=training_addon,
        active_addon=active_addon,
        heat_addon=heat_addon,
        ambient_temp_f=ambient_temp_f,
    )

    return {
        "target_oz": int(target),
        **target_range,
        "baseline_oz": int(baseline),
        "training_addon_oz": int(training_addon),
        "active_energy_addon_oz": int(active_addon),
        "heat_addon_oz": int(heat_addon),
        "protein_addon_oz": int(protein_addon),
        "alcohol_addon_oz": int(alcohol_addon),
        "intensity_bucket": intensity_bucket,
        "reason": reason,
    }
