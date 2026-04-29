"""Muscle-group fatigue system v1.5.

Source of truth: per-muscle-group fatigue buckets (12 dimensions).
Derived readiness: computed per focus-type from the muscle buckets.

Architecture:
  1. Exercises contribute fatigue to specific muscles via primary/secondary
  2. Fatigue decays over time. Hour-based with a 48 h half-life — a
     workout finished last night still reads ~71% fatigued the next
     morning, not 50%. See `_decay_for_hours` below.
  3. The planner derives readiness for any focus type from the muscle state
  4. Decisions are graduated (proceed / downgrade / swap / recover), not binary
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

# Legacy daily decay — kept as a fallback when a completion row lacks
# `completed_at` (old records written before we stored wall-clock time).
_DECAY = {0: 1.0, 1: 0.50, 2: 0.25, 3: 0.10}

# Hour-based decay. Half-life of 48 h so the next-day-morning read still
# respects how sore the user actually feels; approaches the legacy curve
# by day 3. Bounded below 120 h (5 days) — anything older rolls off.
def _decay_for_hours(hours: float) -> float:
    if hours < 0:
        return 1.0
    if hours >= 120:
        return 0.0
    return 0.5 ** (hours / 48.0)

# The 12 fatigue dimensions. Matches MuscleGroup enum minus the
# ultra-granular ones (traps→back, forearms→biceps, adductors→quads).
FATIGUE_MUSCLES = (
    "chest", "back", "shoulders", "biceps", "triceps",
    "quads", "hamstrings", "glutes", "calves", "core",
    "cardio", "systemic",
)

# ─── Muscle fatigue model ───────────��────────────────────────────────────────

@dataclass
class MuscleFatigue:
    """Per-muscle-group fatigue state. Each is 0.0 (fresh) to 1.0+ (overtrained)."""
    chest: float = 0.0
    back: float = 0.0
    shoulders: float = 0.0
    biceps: float = 0.0
    triceps: float = 0.0
    quads: float = 0.0
    hamstrings: float = 0.0
    glutes: float = 0.0
    calves: float = 0.0
    core: float = 0.0
    cardio: float = 0.0
    systemic: float = 0.0

    def get(self, muscle: str) -> float:
        return getattr(self, muscle, 0.0)

    def add(self, muscle: str, value: float):
        current = getattr(self, muscle, None)
        if current is not None:
            setattr(self, muscle, max(0.0, current + value))

    def to_dict(self) -> dict[str, float]:
        return {m: round(getattr(self, m, 0.0), 3) for m in FATIGUE_MUSCLES}

    def top_fatigued(self, n: int = 4, threshold: float = 0.12) -> list[tuple[str, float]]:
        # Threshold lowered from 0.3 → 0.12 when we moved to volume-load-
        # based fatigue (Apr 2026). The new formula intentionally produces
        # lower per-muscle values for heavy work (3-5 reps × 0.80 muscular
        # multiplier), which is physiologically correct but was pushing
        # real working muscles below the old 0.3 display floor.
        pairs = [(m, getattr(self, m, 0.0)) for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")]
        return sorted([(m, v) for m, v in pairs if v >= threshold], key=lambda x: -x[1])[:n]


# ─── Focus-type readiness derivation ─────────────────────────────────────────

# Maps focus types to the muscles that determine readiness.
# Weights: how much each muscle matters for that focus type.
_FOCUS_MUSCLES: dict[str, dict[str, float]] = {
    "push":       {"chest": 1.0, "shoulders": 0.8, "triceps": 0.6},
    "pull":       {"back": 1.0, "biceps": 0.7, "shoulders": 0.3},
    "legs":       {"quads": 1.0, "glutes": 0.8, "hamstrings": 0.8, "calves": 0.3},
    "upper":      {"chest": 0.8, "back": 0.8, "shoulders": 0.7, "biceps": 0.5, "triceps": 0.5},
    "lower":      {"quads": 1.0, "glutes": 0.9, "hamstrings": 0.9, "calves": 0.4},
    "full_body":  {"chest": 0.5, "back": 0.5, "shoulders": 0.4, "quads": 0.5, "glutes": 0.4, "hamstrings": 0.4, "systemic": 0.8},
    "chest_back": {"chest": 1.0, "back": 1.0},
    "arms":       {"biceps": 1.0, "triceps": 1.0},
    "shoulders":  {"shoulders": 1.0},
    "glute_focus": {"glutes": 1.0, "hamstrings": 0.4, "quads": 0.3},
    "cardio":     {"cardio": 1.0, "systemic": 0.3},
    "mobility":   {},
    "recovery":   {},
}


def derive_focus_readiness(fatigue: MuscleFatigue, focus: str) -> float:
    """Compute 0.0 (blocked) to 1.0 (fully fresh) readiness for a focus type."""
    muscles = _FOCUS_MUSCLES.get(focus.lower().replace(" ", "_"), {})
    if not muscles:
        return 1.0  # mobility/recovery always ready

    weighted_fatigue = 0.0
    total_weight = 0.0
    for muscle, importance in muscles.items():
        weighted_fatigue += fatigue.get(muscle) * importance
        total_weight += importance

    avg = weighted_fatigue / total_weight if total_weight > 0 else 0.0
    return max(0.0, min(1.0, 1.0 - avg))


def derive_all_readiness(fatigue: MuscleFatigue) -> dict[str, float]:
    """Compute readiness for all focus types at once."""
    return {focus: round(derive_focus_readiness(fatigue, focus), 2) for focus in _FOCUS_MUSCLES}


def recompute_readiness(mf: MuscleFatigue) -> tuple[int, dict[str, float]]:
    """Recompute readiness score and focus readiness from current fatigue state.

    Same blend formula as compute_rolling_fatigue minus the density penalty
    (which requires full training history context).
    """
    focus_readiness = derive_all_readiness(mf)
    _names = [m for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")]
    _vals = [getattr(mf, m) for m in _names]
    muscle_avg = sum(_vals) / len(_vals)
    muscle_peak = max(_vals) if _vals else 0.0
    muscle_blend = muscle_avg * 0.7 + muscle_peak * 0.3
    overall = max(0.0, 1.0 - (muscle_blend * 0.55 + mf.systemic * 0.35))
    score = int(round(overall * 100))
    return score, focus_readiness


# ─── Exercise → muscle fatigue resolution ─────────────────────────────────────

# Granular muscles that roll up into our 12 buckets
_MUSCLE_ROLLUP: dict[str, str] = {
    "traps": "back",
    "forearms": "biceps",
    "adductors": "quads",
    "hip_flexors": "quads",
    "full_body": "systemic",
    "cardio": "cardio",
    # Direct mappings
    "chest": "chest", "back": "back", "shoulders": "shoulders",
    "biceps": "biceps", "triceps": "triceps",
    "quads": "quads", "hamstrings": "hamstrings", "glutes": "glutes",
    "calves": "calves", "core": "core",
    "lats": "back", "rear_delt": "shoulders",
}

_SORENESS_FATIGUE: dict[str, dict[str, float]] = {
    "neck": {"shoulders": 0.08, "back": 0.05},
    "shoulders": {"shoulders": 0.12},
    "chest": {"chest": 0.12},
    "upper_back": {"back": 0.12},
    "lower_back": {"back": 0.10, "core": 0.08},
    "elbows": {"biceps": 0.06, "triceps": 0.06},
    "wrists": {"biceps": 0.05},
    "hips": {"glutes": 0.08, "quads": 0.05, "hamstrings": 0.05},
    "knees": {"quads": 0.10, "hamstrings": 0.05, "calves": 0.04},
    "ankles": {"calves": 0.10},
    "quads": {"quads": 0.12},
    "hamstrings": {"hamstrings": 0.12},
    "glutes": {"glutes": 0.12},
    "calves": {"calves": 0.12},
    "core": {"core": 0.10},
}


def _resolve_soreness_fatigue(areas: object) -> dict[str, float]:
    """Convert post-workout soreness tags into a small next-day fatigue bump."""
    if not isinstance(areas, list):
        return {}
    out: dict[str, float] = {}
    for raw in areas:
        if not isinstance(raw, str):
            continue
        key = raw.strip().lower().replace(" ", "_").replace("-", "_")
        for muscle, value in _SORENESS_FATIGUE.get(key, {}).items():
            out[muscle] = min(0.2, out.get(muscle, 0.0) + value)
    return out


def _age_fatigue_multiplier(age: int | None) -> float:
    """Older lifters accumulate fatigue faster and recover slower from the
    same work. Research on masters athletes shows ~30–50% slower recovery
    from heavy eccentric work at 50+. We scale fatigue OUTPUT (not input)
    so the user's next-day readiness reflects their biology.

    Bands:
      <35     → 1.00× (baseline)
      35–49   → 1.10×
      50–59   → 1.20×
      60–69   → 1.30×
      70+     → 1.40×

    Missing age defaults to baseline so anonymous/legacy calls don't skew.
    """
    if age is None or age < 35:
        return 1.00
    if age < 50:
        return 1.10
    if age < 60:
        return 1.20
    if age < 70:
        return 1.30
    return 1.40


def _set_stimulus_multipliers(avg_reps: float, avg_rir: float | None) -> tuple[float, float]:
    """Given average reps-per-set (and optional RIR), return (systemic_mult,
    muscular_mult) that reflect how heavy vs volume work differ in their
    fatigue fingerprint.

    Heavy work (low reps, near failure): taxes the CNS harder per unit
    of muscular damage. Volume work (high reps): more time-under-tension
    and more mechanical damage, less CNS cost. Hypertrophy lives in the
    middle and is the baseline (1.0 / 1.0).

    Multipliers:
      heavy (avg ≤ 6 reps)             — systemic 1.30, muscular 0.80
      hypertrophy (7–11 reps)          — systemic 1.00, muscular 1.00
      volume (12+ reps)                — systemic 0.75, muscular 1.20

    RIR adjustment (when provided):
      RIR 0 (failure)    — systemic × 1.15 (CNS cost higher at failure)
      RIR ≥ 3            — systemic × 0.90, muscular × 0.95 (sub-max)
    """
    if avg_reps <= 6:
        sys_m, mus_m = 1.30, 0.80
    elif avg_reps <= 11:
        sys_m, mus_m = 1.00, 1.00
    else:
        sys_m, mus_m = 0.75, 1.20

    if avg_rir is not None:
        if avg_rir <= 0.5:
            sys_m *= 1.15
        elif avg_rir >= 3.0:
            sys_m *= 0.90
            mus_m *= 0.95
    return sys_m, mus_m


def _hr_intensity_factor(avg_hr: float, user_age: int | None) -> float:
    """Convert average heart rate into an intensity multiplier (0.9–1.3).

    Uses HR as % of estimated max (220 − age). When HR data is available,
    it modulates fatigue so a high-effort set (near-max HR) costs more
    than a casual set at the same reps/weight.

    Zones (% max HR):
      <55%  → 0.90 (very easy — barely taxing)
      55-70 → 1.00 (baseline — moderate cardio / light lifting)
      70-80 → 1.10 (tempo work / moderately hard lifting)
      80-90 → 1.20 (threshold / hard lifting)
      >90%  → 1.30 (near max — sprints, failure sets, heavy singles)

    Returns 1.0 when HR data is unavailable (no change to existing calc).
    """
    if not avg_hr or avg_hr <= 0:
        return 1.0
    max_hr = 220 - (user_age or 30)
    pct = avg_hr / max_hr
    if pct < 0.55:
        return 0.90
    if pct < 0.70:
        return 1.00
    if pct < 0.80:
        return 1.10
    if pct < 0.90:
        return 1.20
    return 1.30


def resolve_exercise_fatigue(
    exercises: list[dict],
    intensity: str = "moderate",
    duration_minutes: int = 60,
    user_age: int | None = None,
) -> dict[str, float]:
    """Resolve a list of completed exercises into per-muscle fatigue scores.

    Reads actual per-set `reps` + `weight_lbs` + `rir` when provided and
    scales fatigue by:
      - total reps (not just set count — 4×12 = more damage than 4×5)
      - stimulus bracket (heavy vs hypertrophy vs volume produces different
        ratios of systemic to muscular fatigue — see `_set_stimulus_multipliers`)
      - RIR proximity to failure when available

    Each exercise dict should have:
      - name (str)
      - primary_muscle (str)
      - secondary_muscles (list[str])
      - is_compound (bool)
      - sets: list[dict] with {reps, weight_lbs, rir} per set (preferred)
      - OR sets_logged / target_sets as a count fallback
    """
    intensity_mult = {"easy": 0.5, "moderate": 1.0, "hard": 1.4}.get(intensity, 1.0)
    fatigue: dict[str, float] = {}

    # Baseline: ~0.10 per set for a "typical" 10-rep working set. Convert
    # to a per-rep coefficient so total-rep count drives fatigue. Slightly
    # higher than the old 0.08/set anchor (now 0.010/rep) so heavy work
    # — which gets multiplied by a 0.80 muscular-stimulus mult — still
    # lands above the display threshold.
    base_per_rep = 0.010 * intensity_mult

    for ex in exercises:
        primary = _MUSCLE_ROLLUP.get(ex.get("primary_muscle", ""), "")
        secondaries = [_MUSCLE_ROLLUP.get(m, "") for m in (ex.get("secondary_muscles") or [])]
        secondaries = [s for s in secondaries if s and s != primary]
        is_compound = ex.get("is_compound", False)

        # Prefer structured per-set data when present so we can read
        # actual reps + RIR. Fall back to set count with assumed 10 reps.
        raw_sets = ex.get("sets")
        structured_sets: list[dict] = raw_sets if isinstance(raw_sets, list) else []
        has_structured = structured_sets and any(isinstance(s, dict) for s in structured_sets)
        if has_structured:
            # Only count sets with actual reps > 0 (skip failed/abandoned)
            set_reps = [int(s.get("reps") or 0) for s in structured_sets if isinstance(s, dict) and int(s.get("reps") or 0) > 0]
            if not set_reps:
                continue
            set_rirs = [float(s["rir"]) for s in structured_sets if isinstance(s, dict) and s.get("rir") is not None]
            total_reps = sum(set_reps)
            avg_reps = total_reps / max(1, len(set_reps))
            avg_rir = (sum(set_rirs) / len(set_rirs)) if set_rirs else None
        else:
            # If the exercise was sent with an explicit empty sets list or
            # sets_logged=0, the user skipped it entirely — no fatigue.
            if isinstance(raw_sets, list) and len(raw_sets) == 0:
                continue
            sets_logged = ex.get("sets_logged")
            if isinstance(sets_logged, int) and sets_logged == 0:
                continue
            sets_count = sets_logged or ex.get("target_sets") or 3
            if isinstance(sets_count, list):
                sets_count = len(sets_count) or 3
            if int(sets_count) <= 0:
                continue
            total_reps = int(sets_count) * 10   # assume 10 reps/set when we don't know
            avg_reps = 10.0
            avg_rir = None

        sys_mult, mus_mult = _set_stimulus_multipliers(avg_reps, avg_rir)
        per_rep = base_per_rep

        # Load factor: heavier weight = more mechanical tension per rep.
        # Bodyweight (0 lbs) → 1.0×; loaded work scales gently via log so
        # that 315 lbs produces ~1.4× vs 135 lbs ~1.2×. Prevents squats at
        # 315×5 from having identical fatigue to goblet squats at 35×5.
        avg_weight = 0.0
        if has_structured:
            weights = [float(s.get("weight_lbs") or 0) for s in structured_sets if isinstance(s, dict) and int(s.get("reps") or 0) > 0]
            avg_weight = sum(weights) / max(1, len(weights)) if weights else 0.0
        load_factor = 1.0 + 0.12 * math.log2(max(1.0, avg_weight / 50.0)) if avg_weight > 0 else 1.0

        # HR intensity factor: when per-set heart rate is available,
        # high HR during an exercise signals genuine cardiovascular stress
        # that reps/weight alone can't capture (e.g. supersets, short rest).
        hr_factor = 1.0
        if has_structured:
            hr_vals = [float(s.get("heart_rate_avg") or 0) for s in structured_sets if isinstance(s, dict) and s.get("heart_rate_avg")]
            if hr_vals:
                hr_factor = _hr_intensity_factor(sum(hr_vals) / len(hr_vals), user_age)

        effort = load_factor * hr_factor

        if primary:
            fatigue[primary] = fatigue.get(primary, 0.0) + per_rep * total_reps * mus_mult * effort
        for sec in secondaries:
            fatigue[sec] = fatigue.get(sec, 0.0) + per_rep * total_reps * 0.3 * mus_mult * effort

        # Systemic: compound lifts cost more CNS than isolation, but also
        # scale by the heavy/volume stimulus multiplier. HR factor has
        # outsized impact on systemic cost — high HR = high cardio demand.
        sys_base = 0.4 if is_compound else 0.15
        fatigue["systemic"] = fatigue.get("systemic", 0.0) + per_rep * total_reps * sys_base * sys_mult * effort

    # Apply age multiplier to ALL accumulated fatigue (muscular + systemic).
    # Older athletes recover slower, so a 10-set session fatigues them more
    # in forward-looking calculations.
    age_mult = _age_fatigue_multiplier(user_age)
    if age_mult != 1.0:
        fatigue = {k: v * age_mult for k, v in fatigue.items()}

    # Cap individual muscles at 1.0
    return {k: round(min(1.0, v), 3) for k, v in fatigue.items()}


def resolve_focus_fatigue(focus_label: str, intensity: str = "moderate", duration_minutes: int = 60, user_age: int | None = None) -> dict[str, float]:
    """Estimate muscle fatigue from a focus label when no per-exercise data exists."""
    intensity_mult = {"easy": 0.5, "moderate": 1.0, "hard": 1.4}.get(intensity, 1.0)
    dur_mult = max(0.5, min(1.5, duration_minutes / 60.0))
    scale = intensity_mult * dur_mult

    _FOCUS_FATIGUE: dict[str, dict[str, float]] = {
        "push":       {"chest": 0.6, "shoulders": 0.4, "triceps": 0.35, "systemic": 0.25},
        "pull":       {"back": 0.6, "biceps": 0.35, "shoulders": 0.15, "systemic": 0.25},
        "legs":       {"quads": 0.6, "glutes": 0.5, "hamstrings": 0.45, "calves": 0.2, "systemic": 0.35},
        "upper":      {"chest": 0.45, "back": 0.45, "shoulders": 0.35, "biceps": 0.25, "triceps": 0.25, "systemic": 0.25},
        "lower":      {"quads": 0.55, "glutes": 0.5, "hamstrings": 0.45, "calves": 0.2, "systemic": 0.3},
        "full_body":  {"chest": 0.3, "back": 0.3, "shoulders": 0.25, "quads": 0.3, "glutes": 0.25, "hamstrings": 0.25, "systemic": 0.35},
        "chest":      {"chest": 0.65, "triceps": 0.3, "shoulders": 0.2, "systemic": 0.2},
        "back":       {"back": 0.65, "biceps": 0.3, "systemic": 0.2},
        "shoulders":  {"shoulders": 0.6, "triceps": 0.2, "systemic": 0.15},
        "arms":       {"biceps": 0.5, "triceps": 0.5, "systemic": 0.1},
        "cardio":     {"cardio": 0.5, "quads": 0.15, "hamstrings": 0.1, "calves": 0.1, "systemic": 0.2},
        # Recovery and mobility REDUCE existing fatigue — active recovery
        # (foam rolling, stretching, light movement) increases blood flow
        # and accelerates recovery more than complete rest. Negative values
        # subtract from accumulated fatigue when processed by the rolling calc.
        "recovery":   {"chest": -0.08, "back": -0.08, "shoulders": -0.06, "quads": -0.08, "hamstrings": -0.08, "glutes": -0.06, "core": -0.05, "systemic": -0.10},
        "mobility":   {"chest": -0.05, "back": -0.05, "shoulders": -0.05, "quads": -0.05, "hamstrings": -0.05, "glutes": -0.05, "core": -0.05, "systemic": -0.08},
        "yoga":       {"core": 0.1, "systemic": 0.05},
        "walking":    {"cardio": 0.1, "systemic": 0.05},
        "running":    {"cardio": 0.5, "quads": 0.2, "hamstrings": 0.15, "calves": 0.15, "systemic": 0.25},
        "cycling":    {"cardio": 0.45, "quads": 0.25, "glutes": 0.15, "systemic": 0.2},
        "hiking":     {"cardio": 0.35, "quads": 0.2, "glutes": 0.15, "calves": 0.15, "systemic": 0.2},
        "swimming":   {"cardio": 0.4, "back": 0.2, "shoulders": 0.15, "systemic": 0.2},
        # Active / labor — physical work that creates real fatigue
        "yard_work":      {"back": 0.25, "shoulders": 0.2, "core": 0.15, "quads": 0.15, "systemic": 0.2},
        "chopping_wood":  {"back": 0.35, "shoulders": 0.3, "core": 0.25, "biceps": 0.15, "systemic": 0.3},
        "moving":         {"back": 0.3, "quads": 0.25, "glutes": 0.2, "shoulders": 0.2, "core": 0.2, "systemic": 0.35},
        "gardening":      {"back": 0.15, "quads": 0.1, "core": 0.1, "systemic": 0.1},
        "cleaning":       {"cardio": 0.15, "core": 0.1, "systemic": 0.1},
        "construction":   {"back": 0.3, "shoulders": 0.25, "core": 0.2, "quads": 0.15, "systemic": 0.3},
        "shoveling":      {"back": 0.35, "shoulders": 0.25, "core": 0.2, "quads": 0.15, "systemic": 0.3},
        "playing":        {"cardio": 0.25, "quads": 0.15, "systemic": 0.15},
        "dancing":        {"cardio": 0.3, "quads": 0.15, "calves": 0.1, "core": 0.1, "systemic": 0.15},
        # Sports
        "pickleball":     {"cardio": 0.3, "shoulders": 0.2, "quads": 0.15, "calves": 0.1, "systemic": 0.15},
        "surfing":        {"back": 0.3, "shoulders": 0.25, "core": 0.2, "systemic": 0.2},
        "skiing":         {"quads": 0.4, "glutes": 0.25, "hamstrings": 0.2, "core": 0.15, "systemic": 0.25},
    }

    focus = focus_label.lower().replace(" ", "_").replace("body", "").strip("_")
    # Try exact match, then keyword search
    base = _FOCUS_FATIGUE.get(focus)
    if not base:
        fl = focus_label.lower()
        # PLUS_CARDIO hybrid: merge lift + cardio fatigue (take max per muscle)
        if "cardio" in fl and any(k in fl for k in ("push", "pull", "upper", "full", "leg", "lower", "chest", "back")):
            lift_base: dict[str, float] = {}
            if any(k in fl for k in ("push", "chest")):    lift_base = _FOCUS_FATIGUE["push"]
            elif any(k in fl for k in ("pull", "back")):   lift_base = _FOCUS_FATIGUE["pull"]
            elif any(k in fl for k in ("leg", "lower")):   lift_base = _FOCUS_FATIGUE["legs"]
            elif any(k in fl for k in ("upper",)):         lift_base = _FOCUS_FATIGUE["upper"]
            elif any(k in fl for k in ("full",)):          lift_base = _FOCUS_FATIGUE["full_body"]
            cardio_base = _FOCUS_FATIGUE["cardio"]
            base = dict(lift_base)
            for k, v in cardio_base.items():
                base[k] = max(base.get(k, 0.0), v)
        elif any(k in fl for k in ("push", "chest")):     base = _FOCUS_FATIGUE["push"]
        elif any(k in fl for k in ("pull", "back")):     base = _FOCUS_FATIGUE["pull"]
        elif any(k in fl for k in ("leg", "lower")):     base = _FOCUS_FATIGUE["legs"]
        elif any(k in fl for k in ("upper",)):           base = _FOCUS_FATIGUE["upper"]
        elif any(k in fl for k in ("full",)):            base = _FOCUS_FATIGUE["full_body"]
        elif any(k in fl for k in ("run",)):             base = _FOCUS_FATIGUE["running"]
        elif any(k in fl for k in ("cardio", "cycling", "bike")): base = _FOCUS_FATIGUE["cardio"]
        elif any(k in fl for k in ("yoga", "stretch", "mobil")): base = _FOCUS_FATIGUE["yoga"]
        elif any(k in fl for k in ("chop", "wood", "shovel", "construct")): base = _FOCUS_FATIGUE["chopping_wood"]
        elif any(k in fl for k in ("yard", "garden", "mow")): base = _FOCUS_FATIGUE["yard_work"]
        elif any(k in fl for k in ("moving", "lifting", "haul")): base = _FOCUS_FATIGUE["moving"]
        elif any(k in fl for k in ("clean", "house")): base = _FOCUS_FATIGUE["cleaning"]
        elif any(k in fl for k in ("danc",)): base = _FOCUS_FATIGUE["dancing"]
        elif any(k in fl for k in ("play", "kid")): base = _FOCUS_FATIGUE["playing"]
        elif any(k in fl for k in ("ski",)): base = _FOCUS_FATIGUE["skiing"]
        elif any(k in fl for k in ("surf",)): base = _FOCUS_FATIGUE["surfing"]
        elif any(k in fl for k in ("pickle",)): base = _FOCUS_FATIGUE["pickleball"]
        elif any(k in fl for k in ("recovery", "rest")): base = _FOCUS_FATIGUE["recovery"]
        else:                                            base = {"systemic": 0.3}

    # Don't scale recovery bonuses (negative values) by intensity/duration —
    # a recovery session helps the same whether it's "easy" or 30 vs 60 min.
    # Apply age multiplier to POSITIVE values only — recovery work helps
    # at the same rate regardless of age.
    age_mult = _age_fatigue_multiplier(user_age)
    return {
        k: round(v if v < 0 else min(1.0, v * scale * age_mult), 3)
        for k, v in base.items()
    }


# ─── Rolling fatigue / recovery score ─────────��──────────────────────────────

@dataclass
class FatigueSnapshot:
    """Rolling fatigue state across recent days."""
    muscle_fatigue: MuscleFatigue
    readiness_score: int          # 0-100 overall
    readiness_label: str          # Fresh/Ready/Moderate/Fatigued/Overtrained
    focus_readiness: dict[str, float]  # per-focus 0.0-1.0
    top_fatigued: list[tuple[str, float]]  # [(muscle, value), ...]
    blocked_focuses: list[str]    # backward compat: focuses below threshold
    days_analyzed: int
    activities: list[dict]


def compute_rolling_fatigue(
    completions: list[dict],
    today: date | None = None,
) -> FatigueSnapshot:
    """Compute muscle-group fatigue from recent workout completions.

    Each completion dict should have:
      - workout_date (date or str)
      - focus_label (str)
      - duration_seconds (int)
      - resolved_muscle_fatigue (dict | None) — pre-computed per-muscle
      - activity_intensity (str | None)
    """
    if today is None:
        today = date.today()

    mf = MuscleFatigue()
    activities: list[dict] = []

    # Two-pass approach:
    #   Pass 1: accumulate positive fatigue from workouts
    #   Pass 2: apply recovery bonus (negative values), capped at one per day
    # This prevents stacking 5 saunas to wipe out a heavy leg day.

    parsed: list[tuple[date, float, dict, dict]] = []  # (wd, decay, resolved, raw_completion)
    # Anchor "now" to local end-of-day so decay is stable across a single
    # read (not ticking mid-request). If the caller passed a `today` date,
    # anchor the hour computation to that day's 11:59 local.
    now_utc = datetime.now(timezone.utc)
    for c in completions:
        wd = c.get("workout_date")
        if isinstance(wd, str):
            try:
                wd = date.fromisoformat(wd)
            except ValueError:
                continue
        if not isinstance(wd, date):
            continue
        days_ago = (today - wd).days
        if days_ago < 0 or days_ago > 5:
            continue
        # Prefer hour-based decay via completed_at. Fall back to legacy
        # day-based decay when the completion row predates the new column.
        completed_at = c.get("completed_at")
        if isinstance(completed_at, datetime):
            # Normalize to UTC so the delta math is timezone-safe.
            ts = completed_at if completed_at.tzinfo else completed_at.replace(tzinfo=timezone.utc)
            hours_ago = max(0.0, (now_utc - ts).total_seconds() / 3600.0)
            decay = _decay_for_hours(hours_ago)
        else:
            decay = _DECAY.get(days_ago, 0.0)
        resolved = c.get("resolved_muscle_fatigue")
        if not resolved or not isinstance(resolved, dict):
            dur = max(1, (c.get("duration_seconds") or 0) // 60)
            resolved = resolve_focus_fatigue(
                c.get("focus_label", ""),
                intensity=c.get("activity_intensity") or "moderate",
                duration_minutes=dur,
            )
        else:
            resolved = dict(resolved)
        soreness = _resolve_soreness_fatigue(c.get("soreness_areas"))
        if soreness:
            for muscle, value in soreness.items():
                if muscle in FATIGUE_MUSCLES:
                    resolved[muscle] = min(1.0, float(resolved.get(muscle, 0.0) or 0.0) + value)
        parsed.append((wd, decay, resolved, c))

    # Pass 1: positive fatigue only (workouts, cardio, etc.)
    for wd, decay, resolved, c in parsed:
        days_ago = (today - wd).days
        has_positive = any(v > 0 for v in resolved.values())
        has_negative = any(v < 0 for v in resolved.values())
        if has_positive:
            for muscle, value in resolved.items():
                if muscle in FATIGUE_MUSCLES and value > 0:
                    mf.add(muscle, value * decay)
        # Every parsed completion becomes an activity entry so the client
        # can render BOTH "what fatigued me" and "what helped me recover".
        # `kind` flags recovery vs training; `subtype` surfaces the specific
        # modality ("sauna", "yoga", "walk", etc.) for display.
        activities.append({
            "date": wd.isoformat(),
            "days_ago": days_ago,
            "focus": c.get("focus_label", ""),
            "category": c.get("activity_category") or "",
            "subtype": c.get("activity_subtype") or "",
            "intensity": c.get("activity_intensity", ""),
            "duration_minutes": max(1, (c.get("duration_seconds") or 0) // 60),
            "kind": "recovery" if (has_negative and not has_positive) else "training",
            "muscles": {k: round(v * decay, 2) for k, v in resolved.items() if v > 0},
            "soreness_areas": c.get("soreness_areas") or [],
        })

    # Pass 2: recovery bonus (negative values), max one per day.
    # Recovery only reduces EXISTING fatigue — can't recover below 0.
    # Benefit is proportional: 15% of current fatigue removed, not a flat amount.
    recovery_applied_dates: set[date] = set()
    for wd, decay, resolved, c in parsed:
        has_negative = any(v < 0 for v in resolved.values())
        if not has_negative:
            continue
        if wd in recovery_applied_dates:
            continue  # already applied one recovery session this day
        recovery_applied_dates.add(wd)
        for muscle in FATIGUE_MUSCLES:
            current = mf.get(muscle)
            if current <= 0:
                continue
            # Recovery removes ~15% of current fatigue (diminishing returns)
            # Capped so it never removes more than 0.15 per session
            reduction = min(0.15, current * 0.15) * decay
            mf.add(muscle, -reduction)

    # Overall readiness: blend average + peak muscle fatigue + systemic.
    # Pure average dilutes concentrated fatigue (7 hard days across varied
    # focuses reads as "Moderate" because each muscle individually is okay).
    # Blending in peak catches the case where a few muscles are hammered.
    _muscle_names = [m for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")]
    _muscle_vals = [getattr(mf, m) for m in _muscle_names]
    muscle_avg = sum(_muscle_vals) / len(_muscle_vals)
    muscle_peak = max(_muscle_vals) if _muscle_vals else 0.0
    # Blend: 70% average + 30% peak — peak prevents dilution when
    # many muscle groups are moderately fatigued but avg stays low
    muscle_blend = muscle_avg * 0.7 + muscle_peak * 0.3

    # Training density penalty: many consecutive training days without rest
    # accumulate systemic stress the per-muscle model doesn't capture.
    training_days = sum(1 for a in activities if a["kind"] == "training")
    density_penalty = 0.0
    if training_days >= 5:
        density_penalty = 0.06 * (training_days - 4)

    overall = max(0.0, 1.0 - (muscle_blend * 0.55 + mf.systemic * 0.35 + density_penalty))
    readiness_score = int(round(overall * 100))

    if readiness_score >= 85:   label = "Fresh"
    elif readiness_score >= 65: label = "Ready"
    elif readiness_score >= 40: label = "Moderate"
    elif readiness_score >= 20: label = "Fatigued"
    else:                       label = "Overtrained"

    focus_readiness = derive_all_readiness(mf)
    blocked = [f for f, r in focus_readiness.items() if r < 0.3 and f not in ("mobility", "recovery")]

    return FatigueSnapshot(
        muscle_fatigue=mf,
        readiness_score=readiness_score,
        readiness_label=label,
        focus_readiness=focus_readiness,
        top_fatigued=mf.top_fatigued(4),
        blocked_focuses=blocked,
        days_analyzed=len(activities),
        activities=activities,
    )
