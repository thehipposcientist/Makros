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

LOCAL_MUSCLES = tuple(m for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic"))
LOWER_BODY_MUSCLES = ("quads", "hamstrings", "glutes", "calves")

# The rolling model stores raw fatigue internally so an extreme session can
# remain distinguishable after decay. Public/readiness surfaces stay bounded.
DISPLAY_FATIGUE_MAX = 1.0

# Recovery timing assumptions. These are intentionally config-like constants
# so future calibration can tune the model without rewriting the algorithm.
ACUTE_HALF_LIFE_HOURS = 24.0
DEFAULT_LOCAL_HALF_LIFE_HOURS = 48.0
DAMAGE_PEAK_HOURS = 36.0
DAMAGE_HALF_LIFE_HOURS = 72.0
ROLLING_LOOKBACK_HOURS = 120.0

RECOVERY_HALF_LIFE_BY_PATTERN: dict[str, float] = {
    "upper_isolation": 30.0,
    "upper_compound": 42.0,
    "lower_isolation": 42.0,
    "lower_compound": 60.0,
    "heavy_squat_pattern": 72.0,
    "heavy_hinge_pattern": 72.0,
    "heavy_unilateral_lower": 72.0,
    "cardio": 36.0,
    "systemic": ACUTE_HALF_LIFE_HOURS,
}

# (acute/local share, delayed damage share). Heavy lower-body patterns keep
# more delayed signal because soreness and force loss often peak 24-72h later.
DAMAGE_PROFILE_BY_PATTERN: dict[str, tuple[float, float]] = {
    "upper_isolation": (0.94, 0.04),
    "upper_compound": (0.88, 0.09),
    "lower_isolation": (0.84, 0.12),
    "lower_compound": (0.78, 0.18),
    "heavy_squat_pattern": (0.68, 0.30),
    "heavy_hinge_pattern": (0.68, 0.30),
    "heavy_unilateral_lower": (0.70, 0.28),
    "cardio": (1.00, 0.00),
    "systemic": (1.00, 0.00),
}

PR_MULTIPLIER_CAP = 1.50
DAMAGE_MULTIPLIER_CAP = 1.60

RECOVERY_ACTIVITY_EFFECTS: dict[str, dict[str, Any]] = {
    "mobility": {"systemic_reduction": 0.03, "local_reduction": 0.04, "cap": 0.08},
    "stretching": {"systemic_reduction": 0.02, "local_reduction": 0.03, "cap": 0.06},
    "yoga": {"systemic_reduction": 0.02, "local_reduction": 0.03, "cap": 0.06},
    "easy_walk": {"systemic_reduction": 0.05, "local_reduction": 0.03, "cap": 0.08},
    "walking": {"systemic_reduction": 0.05, "local_reduction": 0.03, "cap": 0.08},
    "active_recovery": {"systemic_reduction": 0.05, "local_reduction": 0.04, "cap": 0.10},
    "sauna": {
        "systemic_reduction": 0.04,
        "local_reduction": 0.02,
        "cap": 0.06,
        "requires_hydration_check": True,
    },
    "massage": {"systemic_reduction": 0.03, "local_reduction": 0.04, "cap": 0.08},
    "foam_rolling": {"systemic_reduction": 0.02, "local_reduction": 0.03, "cap": 0.06},
    "foam": {"systemic_reduction": 0.02, "local_reduction": 0.03, "cap": 0.06},
    "cold_plunge": {"systemic_reduction": 0.03, "local_reduction": 0.02, "cap": 0.05},
    "contrast": {"systemic_reduction": 0.04, "local_reduction": 0.02, "cap": 0.06},
    "breathwork": {"systemic_reduction": 0.03, "local_reduction": 0.00, "cap": 0.04},
    "meditation": {"systemic_reduction": 0.03, "local_reduction": 0.00, "cap": 0.04},
    "sleep": {"systemic_reduction": 0.04, "local_reduction": 0.00, "cap": 0.05},
    # Unknown/"other" recovery — conservative floor. Must NOT out-credit named
    # modalities above (best active_recovery is 0.05/0.10); a vague log gets the
    # least benefit of the doubt, not the most.
    "generic": {"systemic_reduction": 0.03, "local_reduction": 0.02, "cap": 0.05},
}

RECOVERY_MODALITY_ALIASES: dict[str, str] = {
    "finnish_sauna": "sauna",
    "infrared_sauna": "sauna",
    "sauna": "sauna",
    "ice_bath": "cold_plunge",
    "cold_tub": "cold_plunge",
    "cold_water": "cold_plunge",
    "plunge": "cold_plunge",
    "walk": "easy_walk",
    "recovery_walk": "easy_walk",
    "foam_roll": "foam_rolling",
    "foam_roller": "foam_rolling",
    "mobility_flow": "mobility",
    "active": "active_recovery",
    "recovery": "generic",
    "rest": "generic",
    "general": "generic",
    "other": "generic",
}


def normalize_recovery_modality(value: Any) -> str:
    key = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not key:
        return ""
    return RECOVERY_MODALITY_ALIASES.get(key, key)


def squash_fatigue(raw_fatigue: float) -> float:
    """Map raw internal fatigue to bounded display/readiness fatigue [0, 1]."""
    try:
        raw = float(raw_fatigue)
    except (TypeError, ValueError):
        return 0.0
    raw = max(0.0, raw)
    return min(DISPLAY_FATIGUE_MAX, raw / (raw + 1.0))


def _decay_for_half_life(hours: float, half_life_hours: float) -> float:
    if hours < 0:
        return 1.0
    if hours >= ROLLING_LOOKBACK_HOURS:
        return 0.0
    return 0.5 ** (hours / max(1.0, half_life_hours))


def delayed_peak_curve(hours_since_completion: float) -> float:
    """Delayed damage activation, peaking around 24-48h."""
    if hours_since_completion <= 0:
        return 0.0
    return 1.0 - math.exp(-hours_since_completion / 18.0)

# ─── Muscle fatigue model ───────────��────────────────────────────────────────

@dataclass
class MuscleFatigue:
    """Per-muscle-group load state. Each is 0.0 (fresh) to 1.0+ (very high load)."""
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

    def get_display(self, muscle: str) -> float:
        return squash_fatigue(self.get(muscle))

    def add(self, muscle: str, value: float):
        current = getattr(self, muscle, None)
        if current is not None:
            setattr(self, muscle, max(0.0, current + value))

    def to_dict(self) -> dict[str, float]:
        return {m: round(squash_fatigue(getattr(self, m, 0.0)), 3) for m in FATIGUE_MUSCLES}

    def to_raw_dict(self) -> dict[str, float]:
        return {m: round(getattr(self, m, 0.0), 3) for m in FATIGUE_MUSCLES}

    def top_fatigued(self, n: int = 4, threshold: float = 0.12) -> list[tuple[str, float]]:
        # Threshold lowered from 0.3 → 0.12 when we moved to volume-load-
        # based fatigue (Apr 2026). The new formula intentionally produces
        # lower per-muscle values for heavy work (3-5 reps × 0.80 muscular
        # multiplier), which is physiologically correct but was pushing
        # real working muscles below the old 0.3 display floor.
        pairs = [(m, self.get_display(m)) for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")]
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
        weighted_fatigue += fatigue.get_display(muscle) * importance
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
    _vals = [mf.get_display(m) for m in _names]
    muscle_avg = sum(_vals) / len(_vals)
    muscle_peak = max(_vals) if _vals else 0.0
    muscle_blend = muscle_avg * 0.7 + muscle_peak * 0.3
    overall = max(0.0, 1.0 - (muscle_blend * 0.55 + mf.get_display("systemic") * 0.35))
    score = int(round(overall * 100))
    return score, focus_readiness


# ─── Exercise → muscle fatigue resolution ─────────────────────────────────────

_log = __import__("logging").getLogger(__name__)

# Names we've already logged as missing the rollup. Keeps the log volume
# bounded across a long-running process so a single bad AI output doesn't
# spam the journal — we want one warning per distinct unmapped string.
_unmapped_muscle_seen: set[str] = set()


def _rollup_muscle(raw: Any, *, source: str = "exercise") -> str:
    """Lookup `raw` in `_MUSCLE_ROLLUP`. Empty / unknown → "" (drops
    fatigue contribution silently, same as before). Unknown values get
    a single WARN log per distinct string so we can audit AI vision /
    wger imports for vague names ("upper body", "全身", etc) that miss
    the rollup table. Pure observability — no behavior change.
    """
    if raw is None:
        return ""
    key = str(raw).strip().lower()
    if not key:
        return ""
    rolled = _MUSCLE_ROLLUP.get(key, "")
    if not rolled and key not in _unmapped_muscle_seen:
        _unmapped_muscle_seen.add(key)
        _log.warning("muscle_rollup_miss source=%s raw=%r", source, raw)
    return rolled


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


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _text_blob(*values: Any) -> str:
    return " ".join(str(v or "").lower().replace("-", " ").replace("_", " ") for v in values)


def classify_exercise_recovery_pattern(exercise: dict) -> str:
    """Classify an exercise into a tunable recovery bucket."""
    primary = _rollup_muscle(exercise.get("primary_muscle"), source=f"pattern:{exercise.get('name', '')}")
    blob = _text_blob(
        exercise.get("name"),
        exercise.get("slug"),
        exercise.get("movement_pattern"),
        exercise.get("exercise_type"),
    )
    is_compound = bool(exercise.get("is_compound"))
    is_lower = primary in LOWER_BODY_MUSCLES or any(
        token in blob
        for token in ("squat", "deadlift", "rdl", "lunge", "leg press", "hinge", "hip thrust")
    )

    if is_lower:
        if any(token in blob for token in ("romanian deadlift", "rdl", "deadlift", "hinge")):
            return "heavy_hinge_pattern"
        if any(token in blob for token in ("split squat", "bulgarian", "lunge")):
            return "heavy_unilateral_lower"
        if any(token in blob for token in ("squat", "leg press", "hack squat", "front squat", "back squat", "hip thrust")):
            return "heavy_squat_pattern"
        return "lower_compound" if is_compound else "lower_isolation"

    if primary == "cardio":
        return "cardio"
    return "upper_compound" if is_compound else "upper_isolation"


def build_fatigue_context_from_exercises(exercises: list[dict]) -> dict[str, Any]:
    """Build schema-free context persisted under activity_details.fatigue_context.

    The numeric `resolved_muscle_fatigue` map stays backwards-compatible; this
    sidecar lets rolling recovery know whether the session was lower-body,
    damage-prone, or unusually hard when exercise detail existed.
    """
    muscle_patterns: dict[str, str] = {}
    pattern_counts: dict[str, int] = {}
    hard_sets = 0
    volume_load = 0.0
    total_sets = 0

    def _prefer_pattern(existing: str | None, candidate: str) -> str:
        if not existing:
            return candidate
        existing_hl = RECOVERY_HALF_LIFE_BY_PATTERN.get(existing, DEFAULT_LOCAL_HALF_LIFE_HOURS)
        candidate_hl = RECOVERY_HALF_LIFE_BY_PATTERN.get(candidate, DEFAULT_LOCAL_HALF_LIFE_HOURS)
        return candidate if candidate_hl > existing_hl else existing

    for ex in exercises or []:
        if not isinstance(ex, dict):
            continue
        pattern = classify_exercise_recovery_pattern(ex)
        pattern_counts[pattern] = pattern_counts.get(pattern, 0) + 1
        primary = _rollup_muscle(ex.get("primary_muscle"), source=f"context_primary:{ex.get('name', '')}")
        secondaries = [
            _rollup_muscle(m, source=f"context_secondary:{ex.get('name', '')}")
            for m in (ex.get("secondary_muscles") or [])
        ]
        for muscle in [primary, *[m for m in secondaries if m]]:
            if muscle in LOCAL_MUSCLES:
                muscle_patterns[muscle] = _prefer_pattern(muscle_patterns.get(muscle), pattern)

        raw_sets = ex.get("sets")
        structured_sets = raw_sets if isinstance(raw_sets, list) else []
        for s in structured_sets:
            if not isinstance(s, dict):
                continue
            reps = int(_as_float(s.get("reps"), 0))
            if reps <= 0:
                continue
            weight = _as_float(s.get("weight_lbs"), 0.0)
            rir = s.get("rir")
            total_sets += 1
            volume_load += max(0.0, weight) * reps
            if rir is not None and _as_float(rir, 3.0) <= 1.0:
                hard_sets += 1

    dominant_pattern = None
    if pattern_counts:
        dominant_pattern = max(pattern_counts.items(), key=lambda kv: kv[1])[0]

    return {
        "dominant_pattern": dominant_pattern,
        "muscle_patterns": muscle_patterns,
        "hard_set_count": hard_sets,
        "set_count": total_sets,
        "session_volume_load": round(volume_load, 1),
        "has_lower_body_compound": any(
            p in pattern_counts
            for p in ("lower_compound", "heavy_squat_pattern", "heavy_hinge_pattern", "heavy_unilateral_lower")
        ),
    }


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
        primary = _rollup_muscle(ex.get("primary_muscle"), source=f"primary:{ex.get('name', '')}")
        secondaries = [_rollup_muscle(m, source=f"secondary:{ex.get('name', '')}") for m in (ex.get("secondary_muscles") or [])]
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

    # Keep raw values. Display/readiness code bounds later, after decay and
    # delayed-damage math has had a chance to distinguish extreme sessions.
    return {k: round(max(0.0, v), 3) for k, v in fatigue.items()}


def rpe_to_intensity_mult(rpe: float | None) -> float | None:
    """Convert a session RPE (1-10 perceived effort) into a fatigue
    intensity multiplier.

    Anchored to the coarse easy/moderate/hard buckets the planner
    already uses: RPE 3 → ~easy (0.50), RPE 6 → ~moderate (0.95),
    RPE 9 → ~hard (1.40). Returns None when no usable RPE was supplied
    so callers fall back to the activity_intensity string.
    """
    if rpe is None:
        return None
    try:
        value = float(rpe)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return max(0.4, min(1.5, 0.5 + (value - 3.0) * 0.15))


def session_rpe_from_details(details: Any) -> float | None:
    """Pull a user-entered session RPE out of a completion's
    `activity_details` JSON blob. The LogActivityModal stores it under
    `sessionRpe` (1-10 scale). Returns None when absent or malformed.
    """
    if not isinstance(details, dict):
        return None
    raw = details.get("sessionRpe")
    if raw is None:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 < value <= 10 else None


def _activity_key(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _cardio_load_per_minute(
    *,
    cardio_load: float | None,
    hr_summary: dict | None,
    duration_minutes: int,
) -> float | None:
    load = _as_float(cardio_load, 0.0)
    if load <= 0 and isinstance(hr_summary, dict):
        try:
            from app.services.workout.activity_energy import cardio_load_from_hr_summary
            load = _as_float(cardio_load_from_hr_summary(hr_summary), 0.0)
        except Exception:
            load = 0.0
    if load <= 0 or duration_minutes <= 0:
        return None
    return load / max(1, duration_minutes)


def _activity_context_multiplier(
    *,
    cardio_style: str | None,
    cardio_load: float | None,
    hr_summary: dict | None,
    duration_minutes: int,
) -> float:
    style = _activity_key(cardio_style)
    mult = {
        "recovery": 0.75,
        "easy": 0.85,
        "steady": 1.00,
        "class": 1.12,
        "intervals": 1.25,
    }.get(style, 1.0)

    load_per_min = _cardio_load_per_minute(
        cardio_load=cardio_load,
        hr_summary=hr_summary,
        duration_minutes=duration_minutes,
    )
    if load_per_min is not None:
        if load_per_min >= 3.5:
            mult *= 1.25
        elif load_per_min >= 2.7:
            mult *= 1.20
        elif load_per_min <= 1.4:
            mult *= 0.90

    return max(0.65, min(1.55, mult))


def resolve_focus_fatigue(
    focus_label: str,
    intensity: str = "moderate",
    duration_minutes: int = 60,
    user_age: int | None = None,
    rpe: float | None = None,
    *,
    activity_category: str | None = None,
    activity_subtype: str | None = None,
    cardio_style: str | None = None,
    cardio_load: float | None = None,
    hr_summary: dict | None = None,
) -> dict[str, float]:
    """Estimate muscle fatigue from a focus label when no per-exercise data exists.

    When a session RPE is supplied it overrides the coarse `intensity`
    string — a user-reported 1-10 effort is a finer signal than the
    easy/moderate/hard bucket (which silently defaults to "moderate").
    """
    rpe_mult = rpe_to_intensity_mult(rpe)
    intensity_mult = rpe_mult if rpe_mult is not None else {"easy": 0.5, "moderate": 1.0, "hard": 1.4}.get(intensity, 1.0)
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
        "cardio":     {"cardio": 0.5, "quads": 0.18, "hamstrings": 0.12, "glutes": 0.10, "calves": 0.12, "systemic": 0.22},
        # Recovery and mobility REDUCE existing fatigue — active recovery
        # (foam rolling, stretching, light movement) increases blood flow
        # and accelerates recovery more than complete rest. Negative values
        # subtract from accumulated fatigue when processed by the rolling calc.
        "recovery":   {"chest": -0.08, "back": -0.08, "shoulders": -0.06, "quads": -0.08, "hamstrings": -0.08, "glutes": -0.06, "core": -0.05, "systemic": -0.10},
        "mobility":   {"chest": -0.05, "back": -0.05, "shoulders": -0.05, "quads": -0.05, "hamstrings": -0.05, "glutes": -0.05, "core": -0.05, "systemic": -0.08},
        "yoga":       {"chest": -0.05, "back": -0.05, "shoulders": -0.05, "quads": -0.05, "hamstrings": -0.05, "glutes": -0.05, "core": -0.05, "systemic": -0.08},
        "stretching": {"chest": -0.05, "back": -0.05, "shoulders": -0.05, "quads": -0.05, "hamstrings": -0.05, "glutes": -0.05, "core": -0.05, "systemic": -0.08},
        "pilates":    {"chest": -0.05, "back": -0.05, "shoulders": -0.05, "quads": -0.05, "hamstrings": -0.05, "glutes": -0.05, "core": -0.05, "systemic": -0.08},
        "walking":    {"cardio": 0.12, "quads": 0.04, "glutes": 0.03, "calves": 0.08, "systemic": 0.05},
        "running":    {"cardio": 0.55, "quads": 0.35, "hamstrings": 0.25, "glutes": 0.18, "calves": 0.35, "systemic": 0.28},
        "cycling":    {"cardio": 0.50, "quads": 0.80, "glutes": 0.45, "hamstrings": 0.22, "calves": 0.16, "systemic": 0.34},
        "spin":       {"cardio": 0.55, "quads": 0.85, "glutes": 0.45, "hamstrings": 0.20, "calves": 0.18, "systemic": 0.38},
        "hiking":     {"cardio": 0.40, "quads": 0.35, "glutes": 0.30, "hamstrings": 0.20, "calves": 0.25, "systemic": 0.25},
        "swimming":   {"cardio": 0.45, "back": 0.35, "shoulders": 0.30, "chest": 0.10, "triceps": 0.10, "core": 0.15, "systemic": 0.25},
        "rowing":     {"cardio": 0.45, "back": 0.45, "biceps": 0.18, "quads": 0.35, "glutes": 0.25, "hamstrings": 0.20, "core": 0.20, "systemic": 0.30},
        "stair":      {"cardio": 0.45, "quads": 0.55, "glutes": 0.45, "hamstrings": 0.15, "calves": 0.30, "systemic": 0.30},
        "elliptical": {"cardio": 0.35, "quads": 0.25, "glutes": 0.18, "hamstrings": 0.12, "calves": 0.12, "systemic": 0.18},
        "hiit":       {"cardio": 0.60, "quads": 0.35, "glutes": 0.25, "calves": 0.25, "shoulders": 0.25, "chest": 0.12, "back": 0.12, "core": 0.25, "systemic": 0.40},
        "bootcamp":   {"cardio": 0.60, "quads": 0.35, "glutes": 0.25, "calves": 0.25, "shoulders": 0.25, "chest": 0.12, "back": 0.12, "core": 0.25, "systemic": 0.40},
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
        "basketball":     {"cardio": 0.45, "quads": 0.35, "hamstrings": 0.25, "glutes": 0.25, "calves": 0.35, "core": 0.15, "shoulders": 0.10, "systemic": 0.30},
        "soccer":         {"cardio": 0.50, "quads": 0.30, "hamstrings": 0.30, "glutes": 0.25, "calves": 0.35, "core": 0.12, "systemic": 0.30},
        "tennis":         {"cardio": 0.35, "quads": 0.25, "hamstrings": 0.18, "glutes": 0.20, "calves": 0.25, "shoulders": 0.18, "core": 0.18, "systemic": 0.22},
        "pickleball":     {"cardio": 0.32, "shoulders": 0.22, "quads": 0.20, "glutes": 0.15, "calves": 0.18, "core": 0.12, "systemic": 0.18},
        "volleyball":     {"cardio": 0.38, "shoulders": 0.25, "quads": 0.30, "glutes": 0.25, "calves": 0.25, "core": 0.15, "systemic": 0.25},
        "beach_volleyball": {"cardio": 0.48, "shoulders": 0.25, "quads": 0.40, "glutes": 0.30, "calves": 0.35, "core": 0.18, "systemic": 0.30},
        "golf":           {"cardio": 0.12, "back": 0.12, "shoulders": 0.08, "core": 0.08, "calves": 0.08, "systemic": 0.08},
        "climbing":       {"cardio": 0.10, "back": 0.55, "biceps": 0.35, "shoulders": 0.30, "core": 0.25, "systemic": 0.25},
        "boxing":         {"cardio": 0.55, "shoulders": 0.65, "back": 0.50, "chest": 0.22, "biceps": 0.35, "triceps": 0.40, "core": 0.36, "calves": 0.20, "systemic": 0.45},
        "kickboxing":     {"cardio": 0.60, "shoulders": 0.40, "back": 0.25, "chest": 0.15, "biceps": 0.18, "triceps": 0.25, "core": 0.32, "quads": 0.45, "glutes": 0.35, "calves": 0.30, "systemic": 0.42},
        "martial_arts":   {"cardio": 0.56, "shoulders": 0.35, "back": 0.25, "biceps": 0.20, "triceps": 0.22, "core": 0.35, "quads": 0.35, "glutes": 0.28, "calves": 0.28, "systemic": 0.38},
        "surfing":        {"cardio": 0.20, "back": 0.40, "shoulders": 0.35, "chest": 0.12, "core": 0.30, "systemic": 0.25},
        "skiing":         {"cardio": 0.30, "quads": 0.55, "glutes": 0.35, "hamstrings": 0.30, "calves": 0.20, "core": 0.20, "systemic": 0.35},
    }

    subtype_key = _activity_key(activity_subtype)
    subtype_aliases = {
        "walk": "walking",
        "run": "running",
        "jog": "running",
        "ride": "cycling",
        "bike": "cycling",
        "cycling": "cycling",
        "spin": "spin",
        "swim": "swimming",
        "row": "rowing",
        "stair": "stair",
        "stairs": "stair",
        "stair_climber": "stair",
        "elliptical": "elliptical",
        "hike": "hiking",
        "boot_camp": "bootcamp",
    }
    activity_base_key = subtype_aliases.get(subtype_key, subtype_key)
    focus = _activity_key(focus_label).replace("body", "").strip("_")
    generic_focus = focus in {"cardio", "sport", "general", "activity", "workout", "other"}
    # Try exact match, then keyword search
    base = _FOCUS_FATIGUE.get(activity_base_key)
    if not base and not generic_focus:
        base = _FOCUS_FATIGUE.get(focus)
    if not base:
        fl = " ".join(str(v or "") for v in (activity_subtype, focus_label, activity_category)).lower()
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
        elif any(k in fl for k in ("run", "jog")):       base = _FOCUS_FATIGUE["running"]
        elif any(k in fl for k in ("hiit", "tabata", "bootcamp", "boot camp", "boot-camp")): base = _FOCUS_FATIGUE["hiit"]
        elif any(k in fl for k in ("spin", "peloton")): base = _FOCUS_FATIGUE["spin"]
        elif any(k in fl for k in ("cycling", "bike", "ride")): base = _FOCUS_FATIGUE["cycling"]
        elif any(k in fl for k in ("row", "rowing", "erg")): base = _FOCUS_FATIGUE["rowing"]
        elif any(k in fl for k in ("stair", "stepmill")): base = _FOCUS_FATIGUE["stair"]
        elif any(k in fl for k in ("elliptical",)): base = _FOCUS_FATIGUE["elliptical"]
        elif any(k in fl for k in ("cardio",)): base = _FOCUS_FATIGUE["cardio"]
        elif any(k in fl for k in ("yoga", "stretch", "mobil", "foam", "pilates")): base = _FOCUS_FATIGUE["mobility"]
        elif any(k in fl for k in ("chop", "wood", "shovel", "construct")): base = _FOCUS_FATIGUE["chopping_wood"]
        elif any(k in fl for k in ("yard", "garden", "mow")): base = _FOCUS_FATIGUE["yard_work"]
        elif any(k in fl for k in ("moving", "lifting", "haul")): base = _FOCUS_FATIGUE["moving"]
        elif any(k in fl for k in ("clean", "house")): base = _FOCUS_FATIGUE["cleaning"]
        elif any(k in fl for k in ("danc",)): base = _FOCUS_FATIGUE["dancing"]
        elif any(k in fl for k in ("play", "kid")): base = _FOCUS_FATIGUE["playing"]
        elif any(k in fl for k in ("basket",)): base = _FOCUS_FATIGUE["basketball"]
        elif any(k in fl for k in ("soccer", "futsal")): base = _FOCUS_FATIGUE["soccer"]
        elif any(k in fl for k in ("tennis",)): base = _FOCUS_FATIGUE["tennis"]
        elif any(k in fl for k in ("golf",)): base = _FOCUS_FATIGUE["golf"]
        elif any(k in fl for k in ("climb", "boulder")): base = _FOCUS_FATIGUE["climbing"]
        elif any(k in fl for k in ("ski",)): base = _FOCUS_FATIGUE["skiing"]
        elif any(k in fl for k in ("surf",)): base = _FOCUS_FATIGUE["surfing"]
        elif any(k in fl for k in ("kickbox",)): base = _FOCUS_FATIGUE["kickboxing"]
        elif any(k in fl for k in ("boxing", "boxer", "bag work", "heavy bag", "shadow box")): base = _FOCUS_FATIGUE["boxing"]
        elif any(k in fl for k in ("martial", "mma", "jiu", "judo", "karate", "taekwondo", "muay thai")): base = _FOCUS_FATIGUE["martial_arts"]
        elif any(k in fl for k in ("pickle",)): base = _FOCUS_FATIGUE["pickleball"]
        elif any(k in fl for k in ("beach volley", "beach_volley")): base = _FOCUS_FATIGUE["beach_volleyball"]
        elif any(k in fl for k in ("volley",)): base = _FOCUS_FATIGUE["volleyball"]
        elif any(k in fl for k in ("recovery", "rest", "sauna", "cold plunge", "cold_plunge", "massage", "breathwork", "meditation")): base = _FOCUS_FATIGUE["recovery"]
        else:                                            base = {"systemic": 0.3}

    # Don't scale recovery bonuses (negative values) by intensity/duration —
    # a recovery session helps the same whether it's "easy" or 30 vs 60 min.
    # Apply age multiplier to POSITIVE values only — recovery work helps
    # at the same rate regardless of age.
    age_mult = _age_fatigue_multiplier(user_age)
    context_mult = _activity_context_multiplier(
        cardio_style=cardio_style,
        cardio_load=cardio_load,
        hr_summary=hr_summary,
        duration_minutes=duration_minutes,
    )
    return {
        k: round(v if v < 0 else max(0.0, v * scale * context_mult * age_mult), 3)
        for k, v in base.items()
    }


def _fatigue_context(raw_completion: dict) -> dict[str, Any]:
    details = raw_completion.get("activity_details")
    ctx: dict[str, Any] = {}
    if isinstance(details, dict):
        nested = details.get("fatigue_context") or details.get("readiness_context")
        if isinstance(nested, dict):
            ctx.update(nested)
    direct_keys = (
        "pr_count", "prs", "pr_kinds", "load_spike_ratio", "volume_load_ratio",
        "dominant_pattern", "muscle_patterns", "hard_set_count",
        "readiness_feedback", "sleep", "nutrition", "hr", "hydration_low",
    )
    for key in direct_keys:
        if key in raw_completion:
            ctx[key] = raw_completion[key]
    return ctx


def _focus_text(raw_completion: dict) -> str:
    return _text_blob(
        raw_completion.get("focus_label"),
        raw_completion.get("stimulus"),
        raw_completion.get("activity_subtype"),
        raw_completion.get("activity_category"),
    )


def _is_lower_focus(raw_completion: dict) -> bool:
    text = _focus_text(raw_completion)
    return any(token in text for token in ("leg", "lower", "squat", "deadlift", "hinge", "lunge"))


def _pattern_for_completion_muscle(muscle: str, raw_completion: dict, ctx: dict[str, Any]) -> str:
    if muscle == "systemic":
        return "systemic"
    if muscle == "cardio":
        return "cardio"
    muscle_patterns = ctx.get("muscle_patterns")
    if isinstance(muscle_patterns, dict):
        pattern = muscle_patterns.get(muscle)
        if isinstance(pattern, str) and pattern in RECOVERY_HALF_LIFE_BY_PATTERN:
            return pattern

    text = _focus_text(raw_completion)
    if muscle in LOWER_BODY_MUSCLES:
        if any(token in text for token in ("deadlift", "rdl", "hinge")):
            return "heavy_hinge_pattern"
        if any(token in text for token in ("lunge", "split squat", "bulgarian")):
            return "heavy_unilateral_lower"
        if any(token in text for token in ("squat", "leg press", "hack squat", "hip thrust")):
            return "heavy_squat_pattern"
        if _is_lower_focus(raw_completion):
            stimulus = str(raw_completion.get("stimulus") or "").lower()
            intensity = str(raw_completion.get("activity_intensity") or "").lower()
            return "heavy_squat_pattern" if stimulus == "strength" or intensity == "hard" else "lower_compound"
        return "lower_isolation"

    if muscle in ("chest", "back", "shoulders"):
        return "upper_compound"
    return "upper_isolation"


def _sleep_modifiers(context: dict[str, Any] | None) -> tuple[float, float, float, list[dict]]:
    """Return local/damage/systemic half-life multipliers from sleep."""
    if not isinstance(context, dict):
        return 1.0, 1.0, 1.0, []
    sleep = context.get("sleep")
    if not isinstance(sleep, dict):
        sleep = context
    score = sleep.get("sleep_score", sleep.get("score")) if isinstance(sleep, dict) else None
    if score is None:
        return 1.0, 1.0, 1.0, []
    score_f = _as_float(score, -1.0)
    poor_nights = int(_as_float(sleep.get("consecutive_poor_sleep_nights"), 0)) if isinstance(sleep, dict) else 0
    reasons: list[dict] = []
    if score_f >= 85:
        reasons.append({"type": "good_sleep", "severity": "low", "message": "Good sleep is helping systemic recovery."})
        return 0.96, 0.98, 0.90, reasons
    if score_f >= 70:
        return 1.0, 1.0, 1.0, []
    if score_f >= 55:
        reasons.append({"type": "poor_sleep", "severity": "moderate", "message": "Sleep was a little low, so fatigue may linger."})
        return 1.04, 1.05, 1.10, reasons
    mult = 1.12 if poor_nights < 2 else 1.22
    reasons.append({"type": "poor_sleep", "severity": "high", "message": "Poor sleep is slowing recovery today."})
    return mult, 1.10 if poor_nights < 2 else 1.16, 1.25, reasons


def _nutrition_modifiers(context: dict[str, Any] | None) -> tuple[float, float, float, float, list[dict]]:
    """Return local/damage/systemic half-life multipliers plus systemic add."""
    if not isinstance(context, dict):
        return 1.0, 1.0, 1.0, 0.0, []
    nutrition = context.get("nutrition")
    if not isinstance(nutrition, dict):
        nutrition = context
    reasons: list[dict] = []
    local_mult = damage_mult = systemic_mult = 1.0
    systemic_add = 0.0

    protein_status = str(nutrition.get("protein_status") or "").lower()
    protein_ratio = nutrition.get("protein_ratio")
    if protein_status in ("excellent", "met", "on_target") or _as_float(protein_ratio, 0.0) >= 0.95:
        damage_mult *= 0.95
        reasons.append({"type": "protein_met", "severity": "low", "message": "Protein intake is supporting muscle repair."})
    elif protein_status in ("low", "very_low") or (protein_ratio is not None and _as_float(protein_ratio) < 0.8):
        damage_mult *= 1.10
        local_mult *= 1.04
        reasons.append({"type": "protein_low", "severity": "moderate", "message": "Low protein can slow local muscle recovery."})

    if nutrition.get("carbs_low_after_high_volume_session") or nutrition.get("carbs_low"):
        systemic_mult *= 1.12
        reasons.append({"type": "carbs_low", "severity": "moderate", "message": "Low carbs may slow glycogen and systemic recovery."})
    if nutrition.get("calories_very_low") or nutrition.get("large_energy_deficit"):
        systemic_mult *= 1.10
        damage_mult *= 1.08
        reasons.append({"type": "calorie_deficit", "severity": "moderate", "message": "A large energy deficit can make fatigue linger."})
    if nutrition.get("hydration_low") or context.get("hydration_low"):
        systemic_add += 0.05
        reasons.append({"type": "hydration_low", "severity": "moderate", "message": "Hydration looks low, so systemic readiness is slightly reduced."})
    if nutrition.get("alcohol_high"):
        systemic_mult *= 1.10
        systemic_add += 0.04
        reasons.append({"type": "alcohol_high", "severity": "moderate", "message": "Alcohol can reduce recovery quality."})
    return local_mult, damage_mult, systemic_mult, systemic_add, reasons


def _hr_systemic_adjustment(context: dict[str, Any] | None) -> tuple[float, list[dict]]:
    if not isinstance(context, dict):
        return 0.0, []
    hr = context.get("hr")
    if not isinstance(hr, dict):
        hr = context
    current_rhr = hr.get("current_rhr")
    baseline_rhr = hr.get("baseline_rhr")
    current_hrv = hr.get("current_hrv")
    baseline_hrv = hr.get("baseline_hrv")
    if None in (current_rhr, baseline_rhr, current_hrv, baseline_hrv):
        return 0.0, []
    rhr_delta = _as_float(current_rhr) - _as_float(baseline_rhr)
    baseline = max(1.0, _as_float(baseline_hrv))
    hrv_delta_pct = (_as_float(current_hrv) - baseline) / baseline
    if rhr_delta >= 5 and hrv_delta_pct <= -0.10:
        return 0.10, [{
            "type": "systemic_stress",
            "severity": "high",
            "message": "RHR is elevated and HRV is below baseline, suggesting systemic stress.",
        }]
    if rhr_delta >= 5:
        return 0.04, [{"type": "rhr_elevated", "severity": "moderate", "message": "Resting heart rate is elevated versus baseline."}]
    if hrv_delta_pct <= -0.10:
        return 0.04, [{"type": "hrv_suppressed", "severity": "moderate", "message": "HRV is below baseline today."}]
    return 0.0, [{"type": "systemic_recovery_good", "severity": "low", "message": "HRV/RHR are near baseline."}]


def _pr_load_multipliers(ctx: dict[str, Any], pattern: str) -> tuple[float, float, list[dict]]:
    pr_count = int(_as_float(ctx.get("pr_count"), 0))
    prs = ctx.get("prs")
    if isinstance(prs, list):
        pr_count = max(pr_count, len(prs))
    pr_kinds = set()
    if isinstance(prs, list):
        pr_kinds.update(str(p.get("kind") or "").lower() for p in prs if isinstance(p, dict))
    raw_kinds = ctx.get("pr_kinds")
    if isinstance(raw_kinds, list):
        pr_kinds.update(str(k).lower() for k in raw_kinds)

    local_mult = 1.0
    damage_mult = 1.0
    reasons: list[dict] = []
    if pr_count > 0:
        if "estimated_1rm" in pr_kinds:
            local_mult *= 1.15
            damage_mult *= 1.15
        if "heaviest_weight" in pr_kinds:
            local_mult *= 1.10
            damage_mult *= 1.10
        if "volume_record" in pr_kinds:
            local_mult *= 1.10
            damage_mult *= 1.10
        if not pr_kinds:
            local_mult *= 1.08
            damage_mult *= 1.10
        if pr_count >= 2:
            local_mult *= 1.20
            damage_mult *= 1.20
            reasons.append({"type": "multiple_prs", "severity": "high", "message": "Multiple PRs made that session unusually stressful."})
        else:
            reasons.append({"type": "recent_pr", "severity": "moderate", "message": "A recent PR increased recovery demand."})
        if pattern.startswith("heavy_") or pattern.startswith("lower_"):
            damage_mult *= 1.25

    ratio = ctx.get("load_spike_ratio", ctx.get("volume_load_ratio"))
    load_ratio = _as_float(ratio, 0.0)
    if load_ratio >= 1.50:
        local_mult *= 1.20
        damage_mult *= 1.25
        reasons.append({"type": "load_spike", "severity": "high", "message": "The session load was well above recent baseline."})
    elif load_ratio >= 1.25:
        local_mult *= 1.10
        damage_mult *= 1.12
        reasons.append({"type": "load_spike", "severity": "moderate", "message": "The session load was above recent baseline."})

    return (
        min(PR_MULTIPLIER_CAP, local_mult),
        min(DAMAGE_MULTIPLIER_CAP, damage_mult),
        reasons,
    )


def _fatigue_contribution(
    raw_value: float,
    muscle: str,
    hours_ago: float,
    raw_completion: dict,
    ctx: dict[str, Any],
    recovery_context: dict[str, Any],
) -> tuple[float, dict[str, float], list[dict]]:
    pattern = _pattern_for_completion_muscle(muscle, raw_completion, ctx)
    sleep_local, sleep_damage, sleep_systemic, sleep_reasons = _sleep_modifiers(recovery_context)
    nut_local, nut_damage, nut_systemic, systemic_add, nutrition_reasons = _nutrition_modifiers(recovery_context)
    local_mult, damage_mult, pr_reasons = _pr_load_multipliers(ctx, pattern)

    if muscle == "systemic":
        half_life = ACUTE_HALF_LIFE_HOURS * sleep_systemic * nut_systemic
        contribution = raw_value * local_mult * _decay_for_half_life(hours_ago, half_life)
        contribution += systemic_add
        return contribution, {"systemic": contribution, "damage": 0.0}, sleep_reasons + nutrition_reasons + pr_reasons
    if muscle == "cardio":
        half_life = RECOVERY_HALF_LIFE_BY_PATTERN["cardio"] * sleep_systemic * nut_systemic
        contribution = raw_value * _decay_for_half_life(hours_ago, half_life)
        return contribution, {"local": contribution, "damage": 0.0}, sleep_reasons + nutrition_reasons + pr_reasons

    base_half_life = RECOVERY_HALF_LIFE_BY_PATTERN.get(pattern, DEFAULT_LOCAL_HALF_LIFE_HOURS)
    local_share, damage_share = DAMAGE_PROFILE_BY_PATTERN.get(pattern, (0.86, 0.08))
    if int(_as_float(ctx.get("hard_set_count"), 0)) >= 6:
        damage_share += 0.04
        local_share = max(0.62, local_share - 0.03)

    local_half_life = base_half_life * sleep_local * nut_local
    damage_half_life = DAMAGE_HALF_LIFE_HOURS * sleep_damage * nut_damage
    local = raw_value * local_share * local_mult * _decay_for_half_life(hours_ago, local_half_life)
    damage_decay = _decay_for_half_life(max(0.0, hours_ago - DAMAGE_PEAK_HOURS), damage_half_life)
    damage = raw_value * damage_share * damage_mult * delayed_peak_curve(hours_ago) * damage_decay
    if hours_ago < 12 and not ctx and isinstance(raw_completion.get("completed_at"), datetime):
        # Legacy completion rows only have a numeric muscle map, not the
        # sidecar context that tells us how to split acute vs delayed load.
        # Keep those "just trained" rows meaningfully loaded for today's
        # focus while still letting new context-rich rows use delayed peaking.
        local += raw_value * 2.6 * (1.0 - (hours_ago / 12.0))
    reasons = sleep_reasons + nutrition_reasons + pr_reasons
    if damage >= 0.12 and 18 <= hours_ago <= 96:
        reasons.append({
            "type": "delayed_damage_window",
            "severity": "high" if damage >= 0.25 else "moderate",
            "message": "The delayed soreness window is still active.",
        })
    if pattern.startswith("heavy_") and hours_ago <= 96:
        reasons.append({
            "type": "recent_heavy_training",
            "severity": "high",
            "message": "Heavy lower-body loading is still affecting local readiness.",
        })
    return local + damage, {"local": local, "damage": damage}, reasons


def _recovery_effect_for_completion(raw_completion: dict, recovery_context: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    subtype = normalize_recovery_modality(raw_completion.get("activity_subtype"))
    focus = str(raw_completion.get("focus_label") or "").lower()
    details = raw_completion.get("activity_details") if isinstance(raw_completion.get("activity_details"), dict) else {}
    if not subtype:
        if "sauna" in focus:
            subtype = "sauna"
        elif "walk" in focus:
            subtype = "easy_walk"
        elif any(k in focus for k in ("mobil", "stretch", "yoga")):
            subtype = "mobility"
        elif any(k in focus for k in ("cold plunge", "cold_plunge", "ice bath")):
            subtype = "cold_plunge"
        elif "breath" in focus:
            subtype = "breathwork"
        elif "meditat" in focus:
            subtype = "meditation"
    effect = dict(RECOVERY_ACTIVITY_EFFECTS.get(subtype) or RECOVERY_ACTIVITY_EFFECTS.get("generic", {}))
    reasons: list[dict] = []
    if subtype == "sauna":
        hydration_low = bool(recovery_context.get("hydration_low"))
        if isinstance(details, dict):
            hydration_low = hydration_low or bool(details.get("hydration_low"))
        hr_add, _hr_reasons = _hr_systemic_adjustment(recovery_context)
        if hydration_low or hr_add >= 0.04:
            effect["systemic_reduction"] *= 0.25
            effect["local_reduction"] *= 0.50
            reasons.append({"type": "sauna_limited", "severity": "low", "message": "Sauna recovery credit was limited by hydration or stress signals."})
        else:
            reasons.append({"type": "sauna_helped", "severity": "low", "message": "Sauna helped slightly, but local fatigue still matters."})
    elif subtype and subtype != "generic":
        reasons.append({"type": "recovery_activity_helped", "severity": "low", "message": "Recovery activity modestly reduced fatigue."})
    return effect, reasons


def _feedback_muscles(body_part: str | None) -> dict[str, float]:
    if not body_part:
        return {}
    key = str(body_part).strip().lower().replace(" ", "_").replace("-", "_")
    if key in _SORENESS_FATIGUE:
        return _SORENESS_FATIGUE[key]
    if f"{key}s" in _SORENESS_FATIGUE:
        return _SORENESS_FATIGUE[f"{key}s"]
    return {}


def _apply_feedback_caps(mf: MuscleFatigue, feedback_items: list[dict]) -> tuple[list[dict], list[dict]]:
    reasons: list[dict] = []
    recommendations: list[dict] = []
    for fb in feedback_items:
        if not isinstance(fb, dict):
            continue
        soreness = fb.get("soreness")
        soreness_items = soreness if isinstance(soreness, list) else [soreness] if isinstance(soreness, dict) else []
        for item in soreness_items:
            body_part = str(item.get("body_part") or item.get("area") or "").strip()
            severity = int(_as_float(item.get("severity", item.get("severity_0_10")), 0))
            if not body_part or severity <= 0:
                continue
            if severity >= 7:
                readiness_cap = 45
            elif severity >= 5:
                readiness_cap = 60
            elif severity >= 3:
                readiness_cap = 75
            else:
                continue
            for muscle in _feedback_muscles(body_part):
                target_fatigue = 1.0 - (readiness_cap / 100.0)
                current_display = mf.get_display(muscle)
                if current_display < target_fatigue:
                    target_raw = target_fatigue / max(0.05, 1.0 - target_fatigue)
                    mf.add(muscle, target_raw - mf.get(muscle))
            reasons.append({
                "type": "soreness_reported",
                "severity": "high" if severity >= 7 else "moderate",
                "message": f"Reported soreness in {body_part.replace('_', ' ')} is capping local readiness.",
            })

        pain = fb.get("joint_pain") or fb.get("pain")
        pain_items = pain if isinstance(pain, list) else [pain] if isinstance(pain, dict) else []
        for item in pain_items:
            body_part = str(item.get("body_part") or item.get("area") or "").strip()
            severity = int(_as_float(item.get("severity", item.get("severity_0_10")), 0))
            if not body_part or severity < 4:
                continue
            for muscle in _feedback_muscles(body_part):
                current_display = mf.get_display(muscle)
                if current_display < 0.55:
                    target_raw = 0.55 / 0.45
                    mf.add(muscle, target_raw - mf.get(muscle))
            reasons.append({
                "type": "joint_pain_reported",
                "severity": "high",
                "message": f"Joint pain around {body_part.replace('_', ' ')} calls for caution.",
            })
            recommendations.append({
                "type": "avoid_heavy_loading",
                "severity": "high",
                "message": "Avoid heavy loading around the painful area today.",
                "alternatives": ["mobility", "light cardio", "upper body if pain-free", "easy technique work"],
            })

        if fb.get("range_of_motion_limited") or fb.get("limited_rom"):
            body_part = str(fb.get("body_part") or fb.get("area") or "").strip()
            for muscle in _feedback_muscles(body_part):
                current_display = mf.get_display(muscle)
                if current_display < 0.50:
                    mf.add(muscle, 1.0 - mf.get(muscle))
            reasons.append({
                "type": "limited_rom",
                "severity": "high",
                "message": "Limited range of motion is capping readiness for the affected area.",
            })
    return reasons, recommendations


def _dedupe_reasons(reasons: list[dict]) -> list[dict]:
    severity_rank = {"low": 0, "moderate": 1, "high": 2}
    by_type: dict[str, dict] = {}
    for reason in reasons:
        rtype = str(reason.get("type") or "")
        if not rtype:
            continue
        existing = by_type.get(rtype)
        if existing is None or severity_rank.get(str(reason.get("severity")), 0) > severity_rank.get(str(existing.get("severity")), 0):
            by_type[rtype] = reason
    return list(by_type.values())[:8]


def _build_recommendations(
    readiness_score: int,
    focus_readiness: dict[str, float],
    reasons: list[dict],
    existing: list[dict],
) -> list[dict]:
    recommendations = list(existing)
    lower_readiness = round((focus_readiness.get("lower") or focus_readiness.get("legs") or 1.0) * 100)
    has_joint_pain = any(r.get("type") == "joint_pain_reported" for r in reasons)
    if lower_readiness < 60 or has_joint_pain:
        if readiness_score >= 65 and lower_readiness < 60:
            message = "You may be generally ready, but avoid heavy lower-body loading today."
        else:
            message = "Avoid heavy lower-body loading today."
        recommendations.append({
            "type": "avoid_heavy_lower",
            "severity": "high" if lower_readiness < 50 or has_joint_pain else "moderate",
            "message": message,
            "lower_body_readiness": lower_readiness,
            "alternatives": ["upper body", "mobility", "light cardio", "active recovery", "easy technique work"],
        })
    return _dedupe_reasons(recommendations)


# ─── Rolling fatigue / recovery score ─────────��──────────────────────────────

@dataclass
class FatigueSnapshot:
    """Rolling muscle-load state across recent days."""
    muscle_fatigue: MuscleFatigue
    readiness_score: int          # 0-100 muscle recovery score (legacy field name)
    readiness_label: str          # Fresh/Ready/Moderate/High load/Recovery needed
    focus_readiness: dict[str, float]  # per-focus 0.0-1.0
    top_fatigued: list[tuple[str, float]]  # [(muscle, value), ...]
    blocked_focuses: list[str]    # backward compat: focuses below threshold
    days_analyzed: int
    activities: list[dict]
    explanations: list[dict] = field(default_factory=list)
    recommendations: list[dict] = field(default_factory=list)
    raw_muscle_fatigue: dict[str, float] = field(default_factory=dict)


def compute_rolling_fatigue(
    completions: list[dict],
    today: date | None = None,
    recovery_context: dict[str, Any] | None = None,
) -> FatigueSnapshot:
    """Compute muscle-group fatigue from recent workout completions.

    Each completion dict should have:
      - workout_date (date or str)
      - focus_label (str)
      - duration_seconds (int)
      - resolved_muscle_fatigue (dict | None) — pre-computed per-muscle
      - activity_intensity (str | None)
      - activity_details (dict | None) — carries session RPE when present
    """
    if today is None:
        today = date.today()

    mf = MuscleFatigue()
    activities: list[dict] = []
    explanations: list[dict] = []
    recommendations: list[dict] = []
    feedback_items: list[dict] = []
    context = recovery_context or {}

    # Daily self-report (soreness / joint pain from the check-in) arrives as a
    # top-level feedback item, distinct from per-completion soreness tags. Mirror
    # the per-completion handling below so the section-E caps apply either way.
    if isinstance(context.get("readiness_feedback"), dict):
        feedback_items.append(context["readiness_feedback"])

    # Two-pass approach:
    #   Pass 1: accumulate positive fatigue from workouts
    #   Pass 2: apply recovery bonus (negative values), capped at one per day
    # This prevents stacking 5 saunas to wipe out a heavy leg day.

    parsed: list[tuple[date, float, dict, dict, dict]] = []  # (wd, hours_ago, resolved, raw_completion, context)
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
        # Prefer wall-clock completion time. Older rows/tests without it use
        # date-level hours so delayed damage still behaves deterministically.
        completed_at = c.get("completed_at")
        if isinstance(completed_at, datetime):
            ts = completed_at if completed_at.tzinfo else completed_at.replace(tzinfo=timezone.utc)
            hours_ago = max(0.0, (now_utc - ts).total_seconds() / 3600.0)
        else:
            hours_ago = float(days_ago * 24)

        ctx = _fatigue_context(c)
        if isinstance(ctx.get("readiness_feedback"), dict):
            feedback_items.append(ctx["readiness_feedback"])

        is_feedback_only = str(c.get("activity_category") or "").lower() == "feedback"
        resolved = c.get("resolved_muscle_fatigue")
        if is_feedback_only:
            resolved = {}
        elif not resolved or not isinstance(resolved, dict):
            dur = max(1, (c.get("duration_seconds") or 0) // 60)
            resolved = resolve_focus_fatigue(
                c.get("focus_label", ""),
                intensity=c.get("activity_intensity") or "moderate",
                duration_minutes=dur,
                rpe=session_rpe_from_details(c.get("activity_details")),
                activity_category=c.get("activity_category"),
                activity_subtype=c.get("activity_subtype"),
                cardio_style=c.get("cardio_style"),
                cardio_load=c.get("cardio_load"),
                hr_summary=c.get("hr_summary"),
            )
        else:
            resolved = dict(resolved)
        soreness = _resolve_soreness_fatigue(c.get("soreness_areas"))
        if soreness:
            for muscle, value in soreness.items():
                if muscle in FATIGUE_MUSCLES:
                    resolved[muscle] = _as_float(resolved.get(muscle), 0.0) + value
        parsed.append((wd, hours_ago, resolved, c, ctx))

    # Pass 1: positive fatigue only (workouts, cardio, etc.)
    for wd, hours_ago, resolved, c, ctx in parsed:
        days_ago = (today - wd).days
        numeric_values = {k: _as_float(v) for k, v in resolved.items() if k in FATIGUE_MUSCLES}
        has_positive = any(v > 0 for v in numeric_values.values())
        has_negative = any(v < 0 for v in numeric_values.values())
        activity_muscles: dict[str, float] = {}
        if has_positive:
            for muscle, value in numeric_values.items():
                if muscle in FATIGUE_MUSCLES and value > 0:
                    contribution, _components, reasons = _fatigue_contribution(
                        value, muscle, hours_ago, c, ctx, context,
                    )
                    if contribution > 0:
                        mf.add(muscle, contribution)
                        activity_muscles[muscle] = round(squash_fatigue(contribution), 2)
                    explanations.extend(reasons)
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
            "muscles": activity_muscles,
            "soreness_areas": c.get("soreness_areas") or [],
        })

    # Pass 2: recovery bonus (negative values), max one per day.
    # Recovery only reduces EXISTING fatigue — can't recover below 0.
    # Benefits are modality-specific but capped so recovery work cannot erase
    # a heavy PR leg session.
    recovery_applied_dates: set[date] = set()
    for wd, hours_ago, resolved, c, _ctx in parsed:
        numeric_values = {k: _as_float(v) for k, v in resolved.items() if k in FATIGUE_MUSCLES}
        has_negative = any(v < 0 for v in numeric_values.values())
        is_recovery_activity = str(c.get("activity_category") or "").lower() == "recovery"
        if not has_negative and not is_recovery_activity:
            continue
        if wd in recovery_applied_dates:
            continue  # already applied one recovery session this day
        recovery_applied_dates.add(wd)
        effect, recovery_reasons = _recovery_effect_for_completion(c, context)
        recovery_decay = _decay_for_half_life(hours_ago, 48.0)
        for muscle in FATIGUE_MUSCLES:
            current = mf.get(muscle)
            if current <= 0:
                continue
            pct = effect.get("systemic_reduction") if muscle == "systemic" else effect.get("local_reduction")
            reduction = min(float(effect.get("cap", 0.15)), current * float(pct or 0.0)) * recovery_decay
            mf.add(muscle, -reduction)
        explanations.extend(recovery_reasons)

    feedback_reasons, feedback_recommendations = _apply_feedback_caps(mf, feedback_items)
    explanations.extend(feedback_reasons)
    recommendations.extend(feedback_recommendations)

    hr_add, hr_reasons = _hr_systemic_adjustment(context)
    if hr_add > 0:
        mf.add("systemic", hr_add)
    explanations.extend(hr_reasons)

    # Overall readiness: blend average + peak muscle fatigue + systemic.
    # Pure average dilutes concentrated fatigue (7 hard days across varied
    # focuses reads as "Moderate" because each muscle individually is okay).
    # Blending in peak catches the case where a few muscles are hammered.
    _muscle_names = [m for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")]
    _muscle_vals = [mf.get_display(m) for m in _muscle_names]
    muscle_avg = sum(_muscle_vals) / len(_muscle_vals)
    muscle_peak = max(_muscle_vals) if _muscle_vals else 0.0
    # Blend: 70% average + 30% peak — peak prevents dilution when
    # many muscle groups are moderately fatigued but avg stays low
    muscle_blend = muscle_avg * 0.7 + muscle_peak * 0.3

    # Training density penalty: many consecutive training days without rest
    # accumulate systemic stress the per-muscle model doesn't capture.
    training_days = sum(1 for a in activities if a["kind"] == "training" and a["muscles"])
    density_penalty = 0.0
    if training_days >= 5:
        density_penalty = 0.06 * (training_days - 4)

    overall = max(0.0, 1.0 - (muscle_blend * 0.55 + mf.get_display("systemic") * 0.35 + density_penalty))
    readiness_score = int(round(overall * 100))

    if readiness_score >= 85:   label = "Fresh"
    elif readiness_score >= 65: label = "Ready"
    elif readiness_score >= 40: label = "Moderate"
    elif readiness_score >= 20: label = "High load"
    else:                       label = "Recovery needed"

    focus_readiness = derive_all_readiness(mf)
    blocked = [f for f, r in focus_readiness.items() if r < 0.3 and f not in ("mobility", "recovery")]
    explanations = _dedupe_reasons(explanations)
    lower_pct = round((focus_readiness.get("lower") or focus_readiness.get("legs") or 1.0) * 100)
    if readiness_score >= 65 and lower_pct < 60:
        explanations.append({
            "type": "overall_ready_local_not_ready",
            "severity": "high",
            "message": f"Overall readiness is {readiness_score}%, but lower-body readiness is {lower_pct}%.",
        })
    recommendations = _build_recommendations(readiness_score, focus_readiness, explanations, recommendations)

    return FatigueSnapshot(
        muscle_fatigue=mf,
        readiness_score=readiness_score,
        readiness_label=label,
        focus_readiness=focus_readiness,
        top_fatigued=mf.top_fatigued(4),
        blocked_focuses=blocked,
        days_analyzed=len(activities),
        activities=activities,
        explanations=explanations,
        recommendations=recommendations,
        raw_muscle_fatigue=mf.to_raw_dict(),
    )
