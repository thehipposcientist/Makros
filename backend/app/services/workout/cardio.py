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

The seed can optionally carry an explicit `cardio_intensity` field for
ambiguous names. When present, that field wins; keyword inference is the
fallback for older rows and imported exercises.
"""
from __future__ import annotations

from typing import Literal


CardioIntensity = Literal["intervals", "steady", "easy", "not_cardio"]

_EXPLICIT_INTENSITIES: set[str] = {"intervals", "steady", "easy"}


# Keywords in exercise names that strongly signal intervals regardless
# of the `is_compound` flag. Used as a secondary check so something
# named "HIIT Circuit" classifies correctly even if the seed flag
# doesn't agree.
_INTERVAL_KEYWORDS = (
    "interval", "hiit", "sprint", "hill", "tabata",
    "battle rope", "burpee", "mountain climber", "assault",
    "jump rope",  # high-intensity, not suitable for zone 2
    "jumping jack", "high knee", "butt kick", "fast feet",
    "plank jack", "squat thrust", "skater", "line hop",
    "shuttle", "shuffle", "boxing",
)

_EASY_KEYWORDS = (
    "easy", "recovery", "jogging",
)

# Exercises suitable for steady-state / zone 2 work. If the exercise
# name matches none of these, it shouldn't be picked for a Zone 2 day.
_STEADY_KEYWORDS = (
    "treadmill", "bike", "stationary", "elliptical", "stair climber",
    "rowing", "run", "cycling", "swim", "jog", "walk", "incline",
    "zone 2", "zone2", "brisk", "hike", "hiking", "ruck", "aerobics",
    "low-impact", "low impact",
)


def classify_cardio(exercise: dict) -> CardioIntensity:
    """Return the cardio intensity bucket for one exercise.

    Decision order:
      1. If the exercise isn't cardio at all, return `"not_cardio"`.
      2. Explicit seed `cardio_intensity`, when present.
      3. Name pattern: "interval" / "hiit" / "sprint" / "hill" /
         "tabata" → `"intervals"`.
      4. Name pattern: "easy" / "recovery"
         → `"easy"`.
      5. Fallback: the seed's `is_compound` flag is used as the last
         resort — the seed uses it as an interval indicator
         (`treadmill_intervals=True`, `treadmill_run=False`). This
         stays inside this module so nothing else depends on it.
      6. Otherwise `"steady"`.

    This helper is intentionally small and keyword-driven. If the
    seed grows an explicit `cardio_intensity` field, replace this
    body and every call site keeps working."""
    if not _is_cardio_row(exercise):
        return "not_cardio"

    explicit = str(exercise.get("cardio_intensity") or "").lower().strip()
    if explicit in _EXPLICIT_INTENSITIES:
        return explicit  # type: ignore[return-value]

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


# ── Heart-rate zone constants ─────────────────────────────────────────────
#
# This block is the BACKEND HALF of a contract with the frontend canonical
# module at `src/utils/hrZones.ts`. The constants below — zone bands,
# fallback values, Tanaka coefficients — must stay byte-for-byte
# equivalent. A parity test on the frontend hardcodes representative
# inputs and verifies the resulting zones match these bands.
#
# Method: % of Maximum Heart Rate (MHR).
#   zoneBpm(p) = max_hr * p
#
# Zones (Z1..Z5):
#   Z1  50-60% MHR  Warm Up
#   Z2  60-70% MHR  Easy
#   Z3  70-80% MHR  Aerobic
#   Z4  80-90% MHR  Threshold
#   Z5  90-100% MHR Maximum
#
# %MHR matches what Apple Fitness, Garmin (default), Whoop, Strava, and
# Polar all show. Karvonen / %HRR was the previous method but produced
# zone numbers that disagreed with every consumer platform — a heart
# rate reading as Zone 3 on Apple Watch read as Zone 1 in this app.

HR_ZONE_BANDS = [
    {"zone": 1, "label": "Warm Up",   "low_pct": 0.50, "high_pct": 0.60},
    {"zone": 2, "label": "Easy",      "low_pct": 0.60, "high_pct": 0.70},
    {"zone": 3, "label": "Aerobic",   "low_pct": 0.70, "high_pct": 0.80},
    {"zone": 4, "label": "Threshold", "low_pct": 0.80, "high_pct": 0.90},
    {"zone": 5, "label": "Maximum",   "low_pct": 0.90, "high_pct": 1.00},
]
FALLBACK_RESTING_HR = 60
FALLBACK_MAX_HR = 190


def _js_round(x: float) -> int:
    """Round-half-up to match JavaScript's Math.round, which the
    canonical frontend module uses. Python's built-in round() does
    banker's rounding (round half to even), which would produce
    1-bpm divergences at boundaries like 142.5 (JS → 143, Python →
    142). Always positive in this module so the simple form is
    enough."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def _estimate_max_hr_tanaka(age: int) -> int:
    """Tanaka 2001: more accurate across age ranges than the legacy
    `220 - age`. Used when no user-entered or observed max HR is
    available."""
    return _js_round(208 - 0.7 * age)


def _resolve_max_hr(
    age: int | None,
    user_max_hr: int | None,
    observed_max_hr: int | None,
) -> tuple[int, str]:
    """Priority: user-entered → observed → Tanaka estimate → 190 fallback.
    Returns (max_hr, source) where source is one of:
    'user_entered', 'observed', 'estimated_tanaka'."""
    if user_max_hr and user_max_hr > 0:
        return _js_round(user_max_hr), "user_entered"
    if observed_max_hr and observed_max_hr > 0:
        return _js_round(observed_max_hr), "observed"
    if age and age > 0:
        return _estimate_max_hr_tanaka(age), "estimated_tanaka"
    return FALLBACK_MAX_HR, "estimated_tanaka"


def _resolve_resting_hr(
    rhr_7d: int | None,
    rhr_30d: int | None,
    profile_rhr: int | None,
) -> tuple[int, str]:
    """Priority: 7-day Apple Health avg → 30-day avg → profile → 60 fallback.
    Returns (resting_hr, source) where source is one of:
    'apple_health_7d', 'apple_health_30d', 'user_profile', 'fallback'."""
    if rhr_7d and rhr_7d > 0:
        return _js_round(rhr_7d), "apple_health_7d"
    if rhr_30d and rhr_30d > 0:
        return _js_round(rhr_30d), "apple_health_30d"
    if profile_rhr and profile_rhr > 0:
        return _js_round(profile_rhr), "user_profile"
    return FALLBACK_RESTING_HR, "fallback"


def compute_hr_zones(
    age: int,
    resting_hr: int | None = None,
    vo2_max: float | None = None,
    *,
    user_max_hr: int | None = None,
    observed_max_hr: int | None = None,
    rhr_7d: int | None = None,
    rhr_30d: int | None = None,
) -> dict:
    """Compute the 5-zone %MHR ladder.

    Backwards compatibility: callers may pass `resting_hr` positionally
    (used as the lowest-priority profile RHR fallback). New keyword
    arguments — `user_max_hr`, `observed_max_hr`, `rhr_7d`, `rhr_30d` —
    drive the priority chain documented in `_resolve_max_hr` /
    `_resolve_resting_hr`.

    Resting HR is no longer used by the zone math but is still resolved
    and surfaced for display (recovery score, HR summary cards).

    Returns a dict shape that mirrors the frontend `HRZonesResult` plus
    legacy `max_hr` / `resting_hr` / `vo2_max` keys for back-compat with
    pre-existing consumers."""
    max_hr, max_hr_source = _resolve_max_hr(age, user_max_hr, observed_max_hr)
    rhr, rhr_source = _resolve_resting_hr(rhr_7d, rhr_30d, resting_hr)

    def mhr_bpm(pct: float) -> int:
        return _js_round(max_hr * pct)

    zones = []
    for band in HR_ZONE_BANDS:
        z = band["zone"]
        # Z5 is closed at the actual max HR so a max-effort reading
        # still maps to Z5. Interior zones use the %MHR table directly.
        low = mhr_bpm(band["low_pct"])
        high = max_hr if z == 5 else mhr_bpm(band["high_pct"])
        zones.append({
            "zone": z,
            "label": band["label"],
            "low": low,
            "high": high,
        })

    return {
        "method": "pct_max_hr",
        "max_hr": max_hr,
        "resting_hr": rhr,
        "max_hr_source": max_hr_source,
        "resting_hr_source": rhr_source,
        "vo2_max": vo2_max,
        "zones": zones,
    }


def prescribe_cardio_zone(
    cardio_intensity: CardioIntensity,
    zones: list[dict],
) -> dict | None:
    """Given the classified intensity and computed zones, return the
    target zone dict the user should train in. `zones` is a 5-element
    list ordered Z1..Z5 (indices 0..4)."""
    if not zones:
        return None
    if cardio_intensity == "easy":
        return zones[1]      # Z2 "Easy" — 60-70% MHR
    if cardio_intensity == "steady":
        return zones[2]      # Z3 "Aerobic" — 70-80% MHR (classic zone-2 training band)
    if cardio_intensity == "intervals":
        return zones[3]      # Z4 "Threshold" — 80-90% MHR
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
    (MODALITY_BIKE,          "bike zone"),
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


def _baseline_value(raw: dict, *keys: str):
    for key in keys:
        if key in raw:
            return raw.get(key)
    return None


def _positive_float(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _clamp_float(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def apply_signup_cardio_baseline(
    guidance: dict,
    *,
    baseline: dict | None,
    modality: str | None,
    intensity: CardioIntensity,
) -> None:
    """Tune cardio guidance from optional signup baseline data.

    The weekly recipe remains deterministic and goal-driven. This only scales
    the first prescription's duration/cues so early cardio is plausible for a
    user who said they cannot jog yet or who supplied a recent mile/5K pace.
    """
    if not isinstance(baseline, dict):
        return
    is_intervals = bool(guidance.get("is_intervals")) or intensity == "intervals"
    can_jog = _baseline_value(baseline, "canJog10Min", "can_jog_10_min")
    comfortable = _positive_float(_baseline_value(
        baseline, "comfortableDurationMin", "comfortable_duration_min",
    ))
    if comfortable and not is_intervals:
        current = _positive_float(guidance.get("duration_min"))
        if current:
            cap = max(15.0, comfortable + 5.0)
            guidance["duration_min"] = int(round(min(current, cap)))
    elif comfortable and is_intervals:
        current = _positive_float(guidance.get("duration_min"))
        if current:
            cap = max(10.0, comfortable)
            guidance["duration_min"] = int(round(min(current, cap)))

    run_like = modality in {MODALITY_TREADMILL, MODALITY_OUTDOOR_RUN} or modality is None
    if can_jog is False and run_like:
        guidance["speed_range"] = "2.8-4.5 mph"
        guidance["incline_range"] = guidance.get("incline_range") or "0-2%"
        guidance["intensity_cue"] = "walk/jog intervals"
        guidance["rpe_range"] = "4-6/10"
        if not is_intervals:
            current = _positive_float(guidance.get("duration_min"))
            if current:
                guidance["duration_min"] = int(round(min(current, 20.0)))
        return

    if run_like and not is_intervals:
        mile_time = _positive_float(_baseline_value(
            baseline, "recentMileTimeMin", "recent_mile_time_min",
        ))
        five_k_time = _positive_float(_baseline_value(
            baseline, "recent5kTimeMin", "recent5KTimeMin", "recent_5k_time_min",
        ))
        pace_min_per_mile = mile_time or (five_k_time / 3.10686 if five_k_time else None)
        if pace_min_per_mile:
            signup_speed = 60.0 / pace_min_per_mile
            low = _clamp_float(signup_speed * 0.72, 3.0, 7.5)
            high = _clamp_float(signup_speed * 0.88, low + 0.2, 8.5)
            guidance["speed_range"] = f"{low:.1f}-{high:.1f} mph"
            guidance["intensity_cue"] = "easy pace from signup baseline"


def build_cardio_guidance(
    exercise: dict,
    *,
    archetype_name: str = "",
    session_minutes: int = 45,
    capabilities: list[str] | None = None,
    user_age: int | None = None,
    resting_hr: int | None = None,
    cardio_baseline: dict | None = None,
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

    # HR zone (computed when age is known, otherwise just zone number).
    # Mapping under %MHR: easy → Z2 "Easy" (60-70%), steady → Z3
    # "Aerobic" (70-80%, the classic zone-2 training band), intervals
    # → Z4 "Threshold" (80-90%).
    if user_age:
        zdata = compute_hr_zones(user_age, resting_hr)
        cardio_intensity_label = "intervals" if is_intervals else ("easy" if intensity == "easy" else "steady")
        target_zone = prescribe_cardio_zone(cardio_intensity_label, zdata["zones"])
        if target_zone:
            guidance["hr_zone"]        = target_zone["zone"]
            guidance["hr_zone_label"]  = target_zone["label"]
            guidance["hr_low_bpm"]     = target_zone["low"]
            guidance["hr_high_bpm"]    = target_zone["high"]
    else:
        if is_intervals:
            guidance["hr_zone"] = 4; guidance["hr_zone_label"] = "Threshold"
        elif intensity == "easy":
            guidance["hr_zone"] = 2; guidance["hr_zone_label"] = "Easy"
        else:
            guidance["hr_zone"] = 3; guidance["hr_zone_label"] = "Aerobic"

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
            if is_intervals:
                guidance["resistance_cue"] = "hard resistance on work, easy on recovery"
                guidance["rpm_range"] = "90–105 RPM on work"
                guidance["rpe_range"] = "8–9/10 work, 4–5/10 rest"
            else:
                guidance["resistance_cue"] = "medium resistance"
                guidance["rpm_range"] = "75–90 RPM"
                guidance["rpe_range"] = "5–6/10"
        elif CAP_RESISTANCE in caps:
            if is_intervals:
                guidance["resistance_cue"] = "hard resistance on work, easy on recovery"
                guidance["rpm_range"] = "90–105 RPM on work"
                guidance["rpe_range"] = "8–9/10 work, 4–5/10 rest"
            else:
                guidance["resistance_cue"] = "medium resistance"
                guidance["rpm_range"] = "75–90 RPM"
                guidance["rpe_range"] = "5–6/10"
        else:
            if is_intervals:
                guidance["resistance_cue"] = "hard resistance on work, easy on recovery"
                guidance["rpm_range"] = "90–105 RPM on work"
                guidance["rpe_range"] = "8–9/10 work, 4–5/10 rest"
            else:
                guidance["resistance_cue"] = "medium resistance"
                guidance["rpm_range"] = "75–90 RPM"
                guidance["rpe_range"] = "5–6/10"
                guidance["intensity_cue"] = "conversational pace"

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

    apply_signup_cardio_baseline(
        guidance,
        baseline=cardio_baseline,
        modality=modality,
        intensity=intensity,
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
