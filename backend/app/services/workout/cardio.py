"""Cardio classification — single source of truth for interval vs. steady.

The seed data doesn't carry an explicit `cardio_intensity` field. The
previous planner code inferred intervals-vs-steady from
`exercise.get("is_compound")` in multiple places (scoring, prescription,
recipe generation). That inference was quietly load-bearing AND
scattered across files, so a change to the seed's `is_compound`
semantics could regress cardio behavior in surprising ways.

This module isolates the inference in one place. Everywhere else in
the planner that needs to ask "is this a hard interval exercise?"
calls `classify_cardio()` instead of reading `is_compound` directly.

If and when the seed grows an explicit `cardio_intensity` field, the
only change needed is here — all call sites keep working unchanged.
"""
from __future__ import annotations

from typing import Literal


CardioIntensity = Literal["intervals", "steady", "easy", "not_cardio"]


# Keywords in exercise names that strongly signal intervals regardless
# of the `is_compound` flag. Used as a secondary check so something
# named "HIIT Circuit" classifies correctly even if the seed flag
# doesn't agree.
_INTERVAL_KEYWORDS = (
    "interval", "hiit", "sprint", "hill", "tabata",
    "battle rope", "burpee", "mountain climber", "assault",
    "jump rope",  # high-intensity, not suitable for zone 2
)

_EASY_KEYWORDS = (
    "walk", "jog", "easy", "zone 2", "zone2", "recovery",
)

# Exercises suitable for steady-state / zone 2 work. If the exercise
# name matches none of these, it shouldn't be picked for a Zone 2 day.
_STEADY_KEYWORDS = (
    "treadmill", "bike", "stationary", "elliptical", "stair climber",
    "rowing", "run", "cycling", "swim", "jog", "walk", "incline",
)


def classify_cardio(exercise: dict) -> CardioIntensity:
    """Return the cardio intensity bucket for one exercise.

    Decision order:
      1. If the exercise isn't cardio at all, return `"not_cardio"`.
      2. Name pattern: "interval" / "hiit" / "sprint" / "hill" /
         "tabata" → `"intervals"`.
      3. Name pattern: "walk" / "jog" / "easy" / "zone 2" / "recovery"
         → `"easy"`.
      4. Fallback: the seed's `is_compound` flag is used as the last
         resort — the seed uses it as an interval indicator
         (`treadmill_intervals=True`, `treadmill_run=False`). This
         stays inside this module so nothing else depends on it.
      5. Otherwise `"steady"`.

    This helper is intentionally small and keyword-driven. If the
    seed grows an explicit `cardio_intensity` field, replace this
    body and every call site keeps working."""
    if not _is_cardio_row(exercise):
        return "not_cardio"

    name = (exercise.get("name") or "").lower()

    # Explicit name signals win over the compound flag.
    for kw in _INTERVAL_KEYWORDS:
        if kw in name:
            return "intervals"
    for kw in _EASY_KEYWORDS:
        if kw in name:
            return "easy"

    # Check if the exercise is suitable for steady-state work
    for kw in _STEADY_KEYWORDS:
        if kw in name:
            return "steady"

    # Fallback to the seed's is_compound flag — but only for exercises
    # that aren't clearly steady-state.
    if exercise.get("is_compound"):
        return "intervals"
    return "steady"


def is_interval_cardio(exercise: dict) -> bool:
    """Convenience: `classify_cardio(ex) == 'intervals'`."""
    return classify_cardio(exercise) == "intervals"


def is_easy_cardio(exercise: dict) -> bool:
    """Convenience: easy-intensity cardio (jogging, walking, zone 2).
    Steady-state exercises don't count — only explicitly easy ones."""
    return classify_cardio(exercise) == "easy"


def compute_hr_zones(
    age: int,
    resting_hr: int | None = None,
    vo2_max: float | None = None,
) -> dict:
    """Compute 5 HR training zones using Karvonen formula when resting HR
    is available, or simple %MHR fallback. Returns zone boundaries + labels.

    Zone model:
      Z1  50-60% HRR  Recovery / Warm-up
      Z2  60-70% HRR  Aerobic base / Fat burn
      Z3  70-80% HRR  Tempo / Threshold
      Z4  80-90% HRR  Lactate threshold
      Z5  90-100% HRR Max effort / VO2 Max intervals
    """
    max_hr = 220 - age
    rhr = resting_hr or 60

    def hrr_pct(pct: float) -> int:
        return round(rhr + (max_hr - rhr) * pct)

    zones = [
        {"zone": 1, "label": "Recovery",  "low": hrr_pct(0.50), "high": hrr_pct(0.60)},
        {"zone": 2, "label": "Aerobic",   "low": hrr_pct(0.60), "high": hrr_pct(0.70)},
        {"zone": 3, "label": "Tempo",     "low": hrr_pct(0.70), "high": hrr_pct(0.80)},
        {"zone": 4, "label": "Threshold", "low": hrr_pct(0.80), "high": hrr_pct(0.90)},
        {"zone": 5, "label": "VO2 Max",   "low": hrr_pct(0.90), "high": max_hr},
    ]
    return {
        "max_hr": max_hr,
        "resting_hr": rhr,
        "vo2_max": vo2_max,
        "zones": zones,
    }


def prescribe_cardio_zone(
    cardio_intensity: CardioIntensity,
    zones: list[dict],
) -> dict | None:
    """Given the classified intensity and computed zones, return the
    target zone dict the user should train in."""
    if not zones:
        return None
    if cardio_intensity == "easy":
        return zones[0]  # Z1
    if cardio_intensity == "steady":
        return zones[1]  # Z2
    if cardio_intensity == "intervals":
        return zones[3]  # Z4
    return None


def _is_cardio_row(exercise: dict) -> bool:
    """A row is cardio if it declares cardio movement pattern OR
    exercise type. The planner uses this same check in a couple
    places (filter + score + prescription), so centralize it."""
    return (
        exercise.get("movement_pattern") == "cardio"
        or exercise.get("exercise_type") == "cardio"
    )


# ─── Cardio modality detection ────────────────────────────────────────────────
#
# Modalities are the specific machine / mode the user is on. They drive
# the capability-aware prescription hierarchy in build_cardio_guidance.

MODALITY_TREADMILL     = "treadmill"
MODALITY_BIKE          = "bike"
MODALITY_ROWER         = "rower"
MODALITY_ELLIPTICAL    = "elliptical"
MODALITY_STAIR_CLIMBER = "stair_climber"
MODALITY_OUTDOOR_RUN   = "outdoor_run"
MODALITY_ASSAULT_BIKE  = "assault_bike"
MODALITY_OUTDOOR_BIKE  = "outdoor_bike"
MODALITY_SKIERG        = "skierg"
MODALITY_VERSACLIMBER  = "versaclimber"

# Order matters: more specific phrases before generic ones
_MODALITY_KEYWORDS: list[tuple[str, str]] = [
    (MODALITY_ASSAULT_BIKE,  "assault bike"),
    (MODALITY_ASSAULT_BIKE,  "assault_bike"),
    (MODALITY_ASSAULT_BIKE,  "fan bike"),
    (MODALITY_ASSAULT_BIKE,  "airbike"),
    (MODALITY_SKIERG,        "skierg"),
    (MODALITY_SKIERG,        "ski erg"),
    (MODALITY_VERSACLIMBER,  "versaclimber"),
    (MODALITY_VERSACLIMBER,  "versa climber"),
    (MODALITY_TREADMILL,     "treadmill"),
    (MODALITY_TREADMILL,     "incline walk"),
    (MODALITY_TREADMILL,     "incline_walk"),
    (MODALITY_BIKE,          "stationary bike"),
    (MODALITY_BIKE,          "stationary_bike"),
    (MODALITY_BIKE,          "spin class"),
    (MODALITY_OUTDOOR_BIKE,  "outdoor bike"),
    (MODALITY_OUTDOOR_BIKE,  "outdoor cycling"),
    (MODALITY_OUTDOOR_BIKE,  "cycling (outdoor)"),
    (MODALITY_OUTDOOR_BIKE,  "cycling outdoor"),
    (MODALITY_OUTDOOR_BIKE,  "bike ride"),
    (MODALITY_BIKE,          "cycling"),
    (MODALITY_BIKE,          "cycle"),
    (MODALITY_ROWER,         "rowing machine"),
    (MODALITY_ROWER,         "rowing_machine"),
    (MODALITY_ROWER,         "concept2"),
    (MODALITY_ROWER,         "erg"),
    (MODALITY_ELLIPTICAL,    "elliptical"),
    (MODALITY_STAIR_CLIMBER, "stair climber"),
    (MODALITY_STAIR_CLIMBER, "stair_climber"),
    (MODALITY_STAIR_CLIMBER, "stairmaster"),
    (MODALITY_OUTDOOR_RUN,   "outdoor run"),
    (MODALITY_OUTDOOR_RUN,   "outdoor running"),
    (MODALITY_OUTDOOR_RUN,   "trail run"),
    (MODALITY_OUTDOOR_RUN,   "jogging"),
    (MODALITY_OUTDOOR_RUN,   "running (outdoor)"),
]

# ─── Equipment capability constants ──────────────────────────────────────────
#
# These are the string tokens stored in UserEquipmentProfile.capabilities.
# Prescription branches check membership in this set.

CAP_TIME         = "time"
CAP_DISTANCE     = "distance"
CAP_SPEED        = "speed"
CAP_INCLINE      = "incline"
CAP_WATTS        = "watts"
CAP_RPM          = "rpm"
CAP_RESISTANCE   = "resistance"
CAP_HEART_RATE   = "heart_rate"
CAP_CALORIES     = "calories"
CAP_PACE         = "pace"
CAP_STROKE_RATE  = "stroke_rate"


def detect_cardio_modality(exercise_name: str) -> str | None:
    """Return the cardio modality for an exercise name, or None if unrecognised."""
    name = (exercise_name or "").lower()
    for modality, keyword in _MODALITY_KEYWORDS:
        if keyword in name:
            return modality
    return None


def build_cardio_guidance(
    exercise: dict,
    *,
    archetype_name: str = "",
    session_minutes: int = 45,
    capabilities: list[str] | None = None,
    user_age: int | None = None,
    resting_hr: int | None = None,
) -> dict:
    """Build a modality-specific cardio prescription guidance dict.

    Uses a capability hierarchy per modality — the most specific prescription
    available for the user's equipment, falling back to RPE/duration when
    no structured metrics are known.

    ``capabilities`` is the list stored on the user's UserEquipmentProfile
    (e.g. ``["time", "watts", "rpm", "heart_rate"]`` for an IC6 bike).
    When ``None`` or empty, falls back to the lowest tier (RPE + duration).

    Returned dict shape varies by modality:
      treadmill / incline walk → duration_min, speed_range, incline_range, hr_zone*, rpe_range
      bike                    → duration_min, watts_range*, rpm_range*, hr_zone*, rpe_range
      rower                   → duration_min, pace_per_500m*, stroke_rate*, hr_zone*, rpe_range
      generic                 → duration_min, hr_zone*, rpe_range, intensity_cue

    Fields marked * are only present when the matching capability exists or
    user_age is provided for HR zone computation.
    """
    caps = set(capabilities or [])
    name = (exercise.get("name") or exercise.get("slug") or "").lower()
    modality = detect_cardio_modality(name) or exercise.get("cardio_modality")
    intensity = classify_cardio(exercise)
    is_intervals = intensity == "intervals"

    # Duration budget
    work_min = max(10, session_minutes - 10)
    if is_intervals:
        main_min = max(10, min(30, work_min - 10))
    else:
        main_min = max(15, min(60, work_min))

    guidance: dict = {"duration_min": main_min, "is_intervals": is_intervals}

    # HR zone (computed when age is known, otherwise just zone number)
    if user_age:
        zdata = compute_hr_zones(user_age, resting_hr)
        z = zdata["zones"]
        target_zone = z[3] if is_intervals else (z[0] if intensity == "easy" else z[1])
        guidance["hr_zone"]        = target_zone["zone"]
        guidance["hr_zone_label"]  = target_zone["label"]
        guidance["hr_low_bpm"]     = target_zone["low"]
        guidance["hr_high_bpm"]    = target_zone["high"]
    else:
        if is_intervals:
            guidance["hr_zone"] = 4; guidance["hr_zone_label"] = "Threshold"
        elif intensity == "easy":
            guidance["hr_zone"] = 1; guidance["hr_zone_label"] = "Recovery"
        else:
            guidance["hr_zone"] = 2; guidance["hr_zone_label"] = "Aerobic"

    # ── Modality-specific tiers ──────────────────────────────────────────────
    if modality == MODALITY_TREADMILL:
        is_walk = any(kw in name for kw in ("walk", "incline walk", "incline_walk"))
        if is_walk:
            guidance["speed_range"]   = "3.0–3.8 mph"
            guidance["incline_range"] = "5–8%"
            guidance["intensity_cue"] = "conversational pace"
            guidance["rpe_range"]     = "4–6/10"
        elif is_intervals:
            guidance["speed_high_mph"] = 7.5
            guidance["speed_low_mph"]  = 3.5
            guidance["incline_range"]  = "1–3%"
            guidance["rpe_range"]      = "8–9/10 work, 4–5/10 rest"
        else:
            guidance["speed_range"]   = "5.0–6.5 mph"
            guidance["incline_range"] = "1–2%"
            guidance["rpe_range"]     = "5–7/10"

    elif modality == MODALITY_BIKE:
        if CAP_WATTS in caps:
            if is_intervals:
                guidance["watts_high"] = 200
                guidance["watts_low"]  = 80
            else:
                guidance["watts_range"] = "110–150 W"
            if CAP_RPM in caps:
                guidance["rpm_range"] = "80–95 RPM"
            guidance["rpe_range"] = "8–9/10 work" if is_intervals else "5–6/10"
        elif CAP_HEART_RATE in caps:
            guidance["intensity_cue"] = f"HR Zone {guidance.get('hr_zone', 2)}"
            if CAP_RPM in caps:
                guidance["rpm_range"] = "80–95 RPM"
            guidance["rpe_range"] = "5–6/10"
        elif CAP_RESISTANCE in caps:
            guidance["resistance_cue"] = "moderate resistance"
            if CAP_RPM in caps:
                guidance["rpm_range"] = "80–95 RPM if available"
            guidance["rpe_range"] = "5–6/10"
        else:
            guidance["intensity_cue"] = "conversational pace"
            guidance["rpe_range"]     = "5–6/10"

    elif modality == MODALITY_ROWER:
        if CAP_PACE in caps:
            guidance["pace_per_500m"] = "sub-1:55 /500m" if is_intervals else "2:05–2:20 /500m"
            if CAP_STROKE_RATE in caps:
                guidance["stroke_rate"] = "28–32 s/min" if is_intervals else "22–26 s/min"
            guidance["rpe_range"] = "8–9/10 work" if is_intervals else "6–7/10"
        elif CAP_WATTS in caps:
            guidance["watts_range"] = "200+ W" if is_intervals else "150–200 W"
            guidance["rpe_range"]   = "8–9/10 work" if is_intervals else "6–7/10"
        else:
            guidance["intensity_cue"] = "strong steady pull"
            guidance["rpe_range"]     = "6–7/10"

    else:
        # Generic fallback — RPE + HR zone only
        guidance["rpe_range"]     = "8–9/10 work, 4–5/10 rest" if is_intervals else "5–6/10"
        guidance["intensity_cue"] = (
            "near-maximal effort during work" if is_intervals else "conversational pace"
        )

    guidance["modality"] = modality or "generic"
    return guidance


def render_cardio_prescription_text(guidance: dict, exercise_name: str = "") -> str:
    """Convert a cardio_guidance dict into a human-readable prescription string.

    Priority order for each modality:
      - Duration first
      - Equipment-specific metrics (watts, pace, speed, incline)
      - HR zone or RPE fallback

    Examples:
      Incline Walk →  "30 min, 3.0–3.8 mph, 5–8% incline, Zone 2 (Aerobic)"
      IC6 bike     →  "35 min, 110–150 W, 80–95 RPM, Zone 2 (Aerobic)"
      Basic bike   →  "35 min, moderate resistance, 80–95 RPM if available, RPE 5–6/10"
      No-display   →  "35 min, conversational pace, RPE 5–6/10"
    """
    parts: list[str] = []
    dur = guidance.get("duration_min")
    if dur:
        parts.append(f"{dur} min")

    modality = guidance.get("modality", "generic")

    if modality == MODALITY_TREADMILL:
        if speed := guidance.get("speed_range"):
            parts.append(speed)
        if incline := guidance.get("incline_range"):
            parts.append(f"{incline} incline")
    elif modality == MODALITY_BIKE:
        if watts := guidance.get("watts_range"):
            parts.append(watts)
        elif res := guidance.get("resistance_cue"):
            parts.append(res)
        elif cue := guidance.get("intensity_cue"):
            parts.append(cue)
        if rpm := guidance.get("rpm_range"):
            parts.append(rpm)
    elif modality == MODALITY_ROWER:
        if pace := guidance.get("pace_per_500m"):
            parts.append(pace)
        if sr := guidance.get("stroke_rate"):
            parts.append(sr)
        if watts := guidance.get("watts_range"):
            parts.append(watts)
        if not pace and not watts:
            if cue := guidance.get("intensity_cue"):
                parts.append(cue)
    else:
        if cue := guidance.get("intensity_cue"):
            parts.append(cue)

    zone = guidance.get("hr_zone")
    zone_label = guidance.get("hr_zone_label")
    if zone:
        label_str = f" ({zone_label})" if zone_label else ""
        parts.append(f"Zone {zone}{label_str}")
    elif rpe := guidance.get("rpe_range"):
        parts.append(f"RPE {rpe}")

    return ", ".join(p for p in parts if p)
