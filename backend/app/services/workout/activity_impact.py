"""Muscle-group fatigue system v1.5.

Source of truth: per-muscle-group fatigue buckets (12 dimensions).
Derived readiness: computed per focus-type from the muscle buckets.

Architecture:
  1. Exercises contribute fatigue to specific muscles via primary/secondary
  2. Fatigue decays over time (50% at 24h, 25% at 48h, 10% at 72h,
     5% at 96h, 2% at 120h — days 4-5 apply to systemic only)
  3. The planner derives readiness for any focus type from the muscle state
  4. Decisions are graduated (proceed / downgrade / swap / recover), not binary
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

_DECAY = {0: 1.0, 1: 0.50, 2: 0.25, 3: 0.10, 4: 0.05, 5: 0.02}

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

    def top_fatigued(self, n: int = 4, threshold: float = 0.3) -> list[tuple[str, float]]:
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
    """Recompute readiness score and focus readiness from current fatigue state."""
    focus_readiness = derive_all_readiness(mf)
    muscle_avg = sum(getattr(mf, m) for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")) / 10.0
    overall = max(0.0, 1.0 - (muscle_avg * 0.6 + mf.systemic * 0.4))
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


def resolve_exercise_fatigue(
    exercises: list[dict],
    intensity: str = "moderate",
    duration_minutes: int = 60,
) -> dict[str, float]:
    """Resolve a list of completed exercises into per-muscle fatigue scores.

    Each exercise dict should have:
      - name (str)
      - primary_muscle (str)
      - secondary_muscles (list[str])
      - is_compound (bool)
      - sets logged or target_sets (int)
    """
    intensity_mult = {"easy": 0.5, "moderate": 1.0, "hard": 1.4}.get(intensity, 1.0)
    fatigue: dict[str, float] = {}

    for ex in exercises:
        primary = _MUSCLE_ROLLUP.get(ex.get("primary_muscle", ""), "")
        secondaries = [_MUSCLE_ROLLUP.get(m, "") for m in (ex.get("secondary_muscles") or [])]
        secondaries = [s for s in secondaries if s and s != primary]
        is_compound = ex.get("is_compound", False)
        sets = ex.get("sets_logged") or ex.get("target_sets") or ex.get("sets") or 3

        # Per-exercise fatigue: ~0.08 per set for primary, scaled by intensity
        base_per_set = 0.08 * intensity_mult
        if primary:
            fatigue[primary] = fatigue.get(primary, 0.0) + base_per_set * sets
        for sec in secondaries:
            fatigue[sec] = fatigue.get(sec, 0.0) + base_per_set * 0.3 * sets

        # Systemic contribution
        sys_mult = 0.4 if is_compound else 0.15
        fatigue["systemic"] = fatigue.get("systemic", 0.0) + base_per_set * sys_mult * sets

    # Cap individual muscles at 1.0
    return {k: round(min(1.0, v), 3) for k, v in fatigue.items()}


def resolve_focus_fatigue(focus_label: str, intensity: str = "moderate", duration_minutes: int = 60) -> dict[str, float]:
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
        if any(k in fl for k in ("push", "chest")):     base = _FOCUS_FATIGUE["push"]
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
    return {k: round(v if v < 0 else min(1.0, v * scale), 3) for k, v in base.items()}


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
        decay = _DECAY.get(days_ago, 0.0)
        resolved = c.get("resolved_muscle_fatigue")
        if not resolved or not isinstance(resolved, dict):
            dur = max(1, (c.get("duration_seconds") or 0) // 60)
            resolved = resolve_focus_fatigue(
                c.get("focus_label", ""),
                intensity=c.get("activity_intensity") or "moderate",
                duration_minutes=dur,
            )
        parsed.append((wd, decay, resolved, c))

    # Pass 1: positive fatigue only (workouts, cardio, etc.)
    for wd, decay, resolved, c in parsed:
        days_ago = (today - wd).days
        has_positive = any(v > 0 for v in resolved.values())
        has_negative = any(v < 0 for v in resolved.values())
        if has_positive:
            for muscle, value in resolved.items():
                if muscle in FATIGUE_MUSCLES and value > 0:
                    # Days 4-5: only systemic fatigue lingers; local
                    # muscle fatigue has fully recovered by then.
                    if days_ago >= 4 and muscle != "systemic":
                        continue
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

    # Overall readiness from systemic + average muscle fatigue
    muscle_avg = sum(getattr(mf, m) for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")) / 10.0
    overall = max(0.0, 1.0 - (muscle_avg * 0.6 + mf.systemic * 0.4))
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
