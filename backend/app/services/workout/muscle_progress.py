"""Muscle Progress / Hypertrophy Score — per-muscle improvement view.

Distinct from Fresh Strength Signal (`strength_signal.py`):

  - Fresh Strength asks "is my squat 1RM going up?" — a *load* signal
    that can stay flat for weeks while the user is still gaining
    muscle by adding sets / volume / variety.
  - Muscle Progress asks "are my quads (or chest, or back) actually
    improving overall?" — a *hypertrophy* signal that combines weekly
    hard-set count, volume trend, RIR quality, consistency of pattern
    coverage, and (when available) the supporting compound's strength
    trend.

Both numbers can disagree, and that's the point. Same lift run as a
fatigued backoff for 8 weeks shows flat strength but rising volume +
hard sets → muscle is still growing. The Strength tab keeps you honest
about max effort; the Muscle Progress tab keeps you honest about size.

Data sources (read directly from the DB by `build_muscle_progress_profile`):

  - `WorkoutSession.completed_at` — only completed sessions count.
  - `ExerciseSet.actual_weight_lbs` × `actual_reps` — volume load.
  - `ExerciseSet.actual_rir` — "hard set" eligibility (rir ≤ 4 or null
    with reasonable load).
  - `Exercise.primary_muscle` + `secondary_muscles` (or the
    `WorkoutExercise` snapshots when the canonical join misses) —
    where each set's load goes.
  - Optional `StrengthSignal` per slug (from `strength_signal.py`) —
    used to fold compound strength trends into the per-muscle score.

Pure aside from the DB query — every helper is unit-testable.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from statistics import mean
from typing import Iterable, Optional

from .activity_impact import FATIGUE_MUSCLES


# ── Tunables ────────────────────────────────────────────────────────


# Map exotic primary_muscle labels onto the 12 canonical fatigue
# muscles. Same conventions the planner uses (see
# `recommendation.py::_PRIMARY_MUSCLE_TO_FATIGUE_KEY`).
_PRIMARY_MUSCLE_ALIAS: dict[str, str] = {
    "traps": "back",
    "lats": "back",
    "upper_back": "back",
    "forearms": "biceps",
    "adductors": "quads",
    "abductors": "glutes",
    "obliques": "core",
    "abs": "core",
    "abdominals": "core",
}

# Secondary-muscle credit. A bench press hammers chest; triceps and
# shoulders get a smaller bump from the same set. Half-set credit
# is the conservative industry default.
_SECONDARY_MUSCLE_CREDIT = 0.5

# Hard-set eligibility: a working set with RIR ≤ HARD_SET_RIR_CEILING
# (or null RIR with reasonable load+reps) counts as a hypertrophy-
# stimulating set. Higher RIRs are pure pump volume, not hypertrophy
# stimulus, so they don't accrue.
HARD_SET_RIR_CEILING = 4.0

# Weekly hard-set targets per muscle. Maps to the conservative
# 10-20 sets/week range from the resistance training literature.
_WEEKLY_HARD_SET_FULL_CREDIT: dict[str, float] = {
    "chest": 14, "back": 16, "shoulders": 12, "biceps": 10,
    "triceps": 10, "quads": 16, "hamstrings": 12, "glutes": 12,
    "calves": 10, "core": 12, "cardio": 0, "systemic": 0,
}
_DEFAULT_WEEKLY_TARGET = 12.0

# Window defaults. We always compute a 28-day primary window and
# compare against the prior 28d for the volume trend.
DEFAULT_WINDOW_DAYS = 28

# Score weights — must sum to 100 per muscle. Documented in the
# pillar block.
_WEIGHT_HARD_SETS = 35
_WEIGHT_VOLUME_TREND = 25
_WEIGHT_CONSISTENCY = 20
_WEIGHT_STRENGTH_SUPPORT = 20

# Recovery adjustment. When the caller passes a recent-recovery score
# (0..100, lower = worse), we softly scale the muscle score by it so
# improvement claims back off when recovery is poor. Non-bypassing —
# clamps to [0.7, 1.0] so a single bad week can't tank the score.
_RECOVERY_ADJUST_MIN = 0.7
_RECOVERY_ADJUST_MAX = 1.0


# ── Types ───────────────────────────────────────────────────────────


@dataclass
class MuscleProgress:
    """Per-muscle hypertrophy/improvement signal. Stable shape — the
    API surface in `progression.py` reads these field names directly."""
    muscle: str
    weekly_hard_sets: float
    volume_trend_28d_pct: Optional[float]
    strength_support_trend_pct: Optional[float]
    consistency_score: float        # 0..100
    score: float                    # 0..100, before recovery adjust
    recovery_adjusted_score: Optional[float]   # None when no recovery input
    data_quality: str               # "full" | "partial" | "rough" | "missing"
    contributing_slugs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "muscle": self.muscle,
            "weeklyHardSets": round(self.weekly_hard_sets, 1),
            "volumeTrend28dPct": (
                round(self.volume_trend_28d_pct, 1)
                if self.volume_trend_28d_pct is not None else None
            ),
            "strengthSupportTrendPct": (
                round(self.strength_support_trend_pct, 1)
                if self.strength_support_trend_pct is not None else None
            ),
            "consistencyScore": round(self.consistency_score, 1),
            "score": round(self.score, 1),
            "recoveryAdjustedScore": (
                round(self.recovery_adjusted_score, 1)
                if self.recovery_adjusted_score is not None else None
            ),
            "dataQuality": self.data_quality,
            "contributingSlugs": list(self.contributing_slugs),
        }


@dataclass
class MuscleSet:
    """One DB row, normalized for the per-muscle aggregator. Carries
    both the muscle credit (full vs secondary) and the rir-aware
    hard-set flag so the math downstream is straight summation."""
    slug: str
    completed_at: date
    weight_lbs: float
    reps: int
    rir: Optional[float]
    muscle: str
    credit: float                # 1.0 primary, 0.5 secondary
    is_hard_set: bool


# ── Helpers ─────────────────────────────────────────────────────────


def _canonical_muscle(raw: Optional[str]) -> Optional[str]:
    """Normalize whatever the seed/snapshot has into one of the 12
    canonical fatigue muscles. Returns None for empty/unknown inputs
    so the caller can drop them. Cardio + systemic are valid muscles
    in the enum but they don't accrue hypertrophy credit, so they're
    deliberately not in `_WEEKLY_HARD_SET_FULL_CREDIT` with non-zero
    targets — they appear in output as `dataQuality: 'missing'`."""
    if not raw:
        return None
    text = str(raw).strip().lower()
    if not text:
        return None
    if text in FATIGUE_MUSCLES:
        return text
    return _PRIMARY_MUSCLE_ALIAS.get(text)


def is_hard_set(reps: int, weight_lbs: float, rir: Optional[float]) -> bool:
    """A set counts as 'hard' (hypertrophy stimulus) when:

      - reps × weight is meaningful (drops empty + warmup-grade rows), AND
      - logged RIR is ≤ HARD_SET_RIR_CEILING, OR
      - RIR is null but the load×reps is consistent with effort
        (≥ 5 reps and weight > 0 — protects users who don't log RIR).

    This is intentionally permissive on null RIR so a user who skips
    the RIR prompt isn't punished with a zero hypertrophy signal."""
    if reps <= 0 or weight_lbs <= 0:
        return False
    if rir is None:
        # Null RIR — count it if the set looks like a working set.
        return reps >= 5
    try:
        return float(rir) <= HARD_SET_RIR_CEILING
    except (TypeError, ValueError):
        return reps >= 5


def _muscle_target(muscle: str) -> float:
    return _WEEKLY_HARD_SET_FULL_CREDIT.get(muscle, _DEFAULT_WEEKLY_TARGET)


def _hard_set_subscore(weekly_hard_sets: float, target: float) -> float:
    """Up to `_WEIGHT_HARD_SETS` points. 100% target = full credit;
    >100% does not give bonus points (over-volume is its own problem,
    not a hypertrophy win)."""
    if target <= 0 or weekly_hard_sets <= 0:
        return 0.0
    ratio = min(1.0, weekly_hard_sets / target)
    return ratio * _WEIGHT_HARD_SETS


def _trend_subscore(trend_pct: Optional[float]) -> float:
    """Up to `_WEIGHT_VOLUME_TREND` points. 0% trend = half credit
    (maintenance is fine), positive trend earns up to full, negative
    trend loses ground. Caps at full / floor at 0."""
    if trend_pct is None:
        return _WEIGHT_VOLUME_TREND * 0.5  # treat "no prior data" as neutral
    # Map: -10% → 0pt, 0% → half, +10% → full.
    raw = 0.5 + (trend_pct / 20.0)
    return max(0.0, min(1.0, raw)) * _WEIGHT_VOLUME_TREND


def _consistency_subscore(weeks_with_any_set: int, window_days: int) -> float:
    """Up to `_WEIGHT_CONSISTENCY` points. A user training the muscle
    in every available week of the window earns full; missing weeks
    cost proportionally."""
    weeks_in_window = max(1, window_days // 7)
    ratio = min(1.0, weeks_with_any_set / weeks_in_window)
    return ratio * _WEIGHT_CONSISTENCY


def _strength_support_subscore(trend_pct: Optional[float]) -> float:
    """Up to `_WEIGHT_STRENGTH_SUPPORT` points. Mirrors the volume-
    trend scoring shape — same map of -10/0/+10 → 0/half/full."""
    if trend_pct is None:
        return _WEIGHT_STRENGTH_SUPPORT * 0.5
    raw = 0.5 + (trend_pct / 20.0)
    return max(0.0, min(1.0, raw)) * _WEIGHT_STRENGTH_SUPPORT


def _recovery_adjustment(score: float, recovery_score: Optional[float]) -> Optional[float]:
    """When the caller passes a recovery score, scale the muscle score
    by `[_RECOVERY_ADJUST_MIN, _RECOVERY_ADJUST_MAX]` so a poor
    recovery week softens the hypertrophy claim. Returns None to
    indicate "no recovery data" so the UI can hide the adjusted line."""
    if recovery_score is None:
        return None
    try:
        r = float(recovery_score)
    except (TypeError, ValueError):
        return None
    r = max(0.0, min(100.0, r))
    factor = _RECOVERY_ADJUST_MIN + (
        (_RECOVERY_ADJUST_MAX - _RECOVERY_ADJUST_MIN) * (r / 100.0)
    )
    return score * factor


def _trend_pct(current: float, prior: float) -> Optional[float]:
    if prior <= 0:
        return None
    pct = (current - prior) / prior * 100.0
    return max(-200.0, min(200.0, pct))


# ── Pure aggregator ────────────────────────────────────────────────


def build_progress_for_muscle(
    *,
    muscle: str,
    sets: list[MuscleSet],
    today: date,
    window_days: int = DEFAULT_WINDOW_DAYS,
    strength_support_trend_pct: Optional[float] = None,
    recovery_score: Optional[float] = None,
) -> MuscleProgress:
    """Compose a `MuscleProgress` from a muscle's contributing sets.
    Pure — drives the unit tests directly without a DB."""
    # No data → missing.
    if not sets:
        return MuscleProgress(
            muscle=muscle,
            weekly_hard_sets=0.0,
            volume_trend_28d_pct=None,
            strength_support_trend_pct=strength_support_trend_pct,
            consistency_score=0.0,
            score=0.0,
            recovery_adjusted_score=None,
            data_quality="missing",
        )

    cutoff_current = today - timedelta(days=window_days)
    cutoff_prior = today - timedelta(days=window_days * 2)

    in_window = [s for s in sets if s.completed_at >= cutoff_current]
    prior_window = [
        s for s in sets
        if cutoff_prior <= s.completed_at < cutoff_current
    ]

    # Hard-set count over the current window, scaled per week.
    hard_sets = [s for s in in_window if s.is_hard_set]
    hard_set_credit = sum(s.credit for s in hard_sets)
    weeks_in_window = max(1, window_days / 7.0)
    weekly_hard_sets = hard_set_credit / weeks_in_window

    # Volume trend — sum of weight×reps×credit, current vs prior window.
    current_volume = sum(s.weight_lbs * s.reps * s.credit for s in in_window)
    prior_volume = sum(s.weight_lbs * s.reps * s.credit for s in prior_window)
    volume_trend = _trend_pct(current_volume, prior_volume) if prior_window else None

    # Consistency — distinct ISO weeks the user trained this muscle in.
    weeks_trained = {
        s.completed_at.isocalendar()[:2]
        for s in in_window
    }
    consistency = _consistency_subscore(len(weeks_trained), window_days)

    target = _muscle_target(muscle)
    base = (
        _hard_set_subscore(weekly_hard_sets, target)
        + _trend_subscore(volume_trend)
        + consistency
        + _strength_support_subscore(strength_support_trend_pct)
    )
    base = max(0.0, min(100.0, base))

    contributing_slugs = sorted({s.slug for s in in_window})

    quality: str
    if len(in_window) == 0:
        quality = "missing"
    elif len(in_window) >= 8 and len(weeks_trained) >= 2:
        quality = "full"
    else:
        quality = "partial"

    return MuscleProgress(
        muscle=muscle,
        weekly_hard_sets=weekly_hard_sets,
        volume_trend_28d_pct=volume_trend,
        strength_support_trend_pct=strength_support_trend_pct,
        consistency_score=consistency / _WEIGHT_CONSISTENCY * 100.0,
        score=base,
        recovery_adjusted_score=_recovery_adjustment(base, recovery_score),
        data_quality=quality,
        contributing_slugs=contributing_slugs,
    )


# ── Compound → muscle map for strength-support trend wiring ────────


# Showcase compounds that are the canonical "strength support" lift
# for each muscle. Used to fold StrengthSignal trends into the
# per-muscle score so a rising squat shows up under quads/glutes.
_MUSCLE_TO_SUPPORT_SLUGS: dict[str, tuple[str, ...]] = {
    "chest":      ("barbell_bench_press", "dumbbell_bench_press", "overhead_press"),
    "back":       ("barbell_row", "pendlay_row", "barbell_deadlift"),
    "shoulders":  ("overhead_press", "barbell_bench_press"),
    "triceps":    ("barbell_bench_press", "overhead_press"),
    "biceps":     ("barbell_row", "pendlay_row"),
    "quads":      ("barbell_back_squat", "barbell_front_squat"),
    "hamstrings": ("barbell_deadlift", "romanian_deadlift"),
    "glutes":     ("barbell_back_squat", "barbell_deadlift", "romanian_deadlift"),
    "calves":     (),
    "core":       (),
}


def _support_trend_for_muscle(
    muscle: str,
    strength_signals: Optional[dict],
) -> Optional[float]:
    if not strength_signals:
        return None
    slugs = _MUSCLE_TO_SUPPORT_SLUGS.get(muscle, ())
    trends = []
    for slug in slugs:
        sig = strength_signals.get(slug)
        if sig is None:
            continue
        if sig.trend_28d_pct is not None:
            trends.append(sig.trend_28d_pct)
    if not trends:
        return None
    # Average across contributing compounds — a rising squat AND a
    # rising deadlift both vouch for the glutes.
    return mean(trends)


# ── DB-touching builder ─────────────────────────────────────────────


def build_muscle_progress_profile(
    user_id: int,
    db_session,
    *,
    today: Optional[date] = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
    strength_signals: Optional[dict] = None,
    recovery_score: Optional[float] = None,
) -> dict[str, MuscleProgress]:
    """Build `{muscle: MuscleProgress}` for every canonical muscle the
    user has trained at least once in the window. Muscles with no
    contributing sets are returned as `dataQuality: 'missing'` so the
    UI can render the full grid.

    Pass `strength_signals` (the output of
    `build_strength_signal_profile`) to fold compound strength trends
    into the per-muscle score. Pass `recovery_score` (0..100) to
    enable the soft recovery adjustment.
    """
    from sqlmodel import select

    from app.models import (
        Exercise, ExerciseSet, WorkoutExercise, WorkoutSession,
    )

    today = today or date.today()
    # Pull a 56-day span so the trend math has a prior 28-day window
    # to compare against.
    cutoff = today - timedelta(days=window_days * 2)

    rows = db_session.exec(
        select(
            Exercise.slug,
            Exercise.primary_muscle,
            Exercise.secondary_muscles,
            WorkoutExercise.exercise_slug_snapshot,
            WorkoutExercise.primary_muscle_snapshot,
            WorkoutExercise.secondary_muscles_snapshot,
            WorkoutSession.workout_date,
            ExerciseSet.actual_weight_lbs,
            ExerciseSet.actual_reps,
            ExerciseSet.actual_rir,
            ExerciseSet.completed_at,
        )
        .select_from(WorkoutExercise)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .outerjoin(Exercise, WorkoutExercise.exercise_id == Exercise.id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.completed_at.is_not(None))
        .where(WorkoutSession.workout_date >= cutoff)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(ExerciseSet.actual_weight_lbs.is_not(None))
        .where(ExerciseSet.actual_reps.is_not(None))
    ).all()

    sets_by_muscle: dict[str, list[MuscleSet]] = defaultdict(list)
    for (
        canonical_slug, primary_muscle, secondary_muscles,
        snapshot_slug, primary_snapshot, secondary_snapshot,
        workout_date, weight_lbs, reps, rir, completed_at,
    ) in rows:
        slug = (canonical_slug or snapshot_slug or "").strip() or "unknown"
        completed_date = (
            completed_at.date()
            if hasattr(completed_at, "date") and completed_at is not None
            else workout_date
        )
        # Prefer the canonical Exercise muscles; fall back to the
        # WorkoutExercise snapshot for rows where the join missed (legacy
        # custom exercises). `primary_muscle` from the enum needs `.value`
        # on the canonical row but the snapshot is already a string.
        primary_raw = primary_muscle.value if hasattr(primary_muscle, "value") else (
            primary_muscle if primary_muscle is not None else primary_snapshot
        )
        primary = _canonical_muscle(primary_raw)
        if primary and primary in _WEEKLY_HARD_SET_FULL_CREDIT and _WEEKLY_HARD_SET_FULL_CREDIT[primary] > 0:
            sets_by_muscle[primary].append(MuscleSet(
                slug=slug,
                completed_at=completed_date,
                weight_lbs=float(weight_lbs),
                reps=int(reps),
                rir=rir if rir is not None else None,
                muscle=primary,
                credit=1.0,
                is_hard_set=is_hard_set(int(reps), float(weight_lbs), rir),
            ))
        secondary_list = (
            list(secondary_muscles or [])
            if secondary_muscles
            else list(secondary_snapshot or [])
        )
        for sm_raw in secondary_list:
            sm_value = sm_raw.value if hasattr(sm_raw, "value") else sm_raw
            sm = _canonical_muscle(sm_value)
            if not sm or sm == primary:
                continue
            target = _WEEKLY_HARD_SET_FULL_CREDIT.get(sm, 0)
            if target <= 0:
                continue
            sets_by_muscle[sm].append(MuscleSet(
                slug=slug,
                completed_at=completed_date,
                weight_lbs=float(weight_lbs),
                reps=int(reps),
                rir=rir if rir is not None else None,
                muscle=sm,
                credit=_SECONDARY_MUSCLE_CREDIT,
                is_hard_set=is_hard_set(int(reps), float(weight_lbs), rir),
            ))

    out: dict[str, MuscleProgress] = {}
    # Iterate the canonical list so muscles with no data still render
    # as `missing` — useful for the UI grid.
    for muscle, target in _WEEKLY_HARD_SET_FULL_CREDIT.items():
        if target <= 0:
            continue
        sig_trend = _support_trend_for_muscle(muscle, strength_signals)
        out[muscle] = build_progress_for_muscle(
            muscle=muscle,
            sets=sets_by_muscle.get(muscle, []),
            today=today,
            window_days=window_days,
            strength_support_trend_pct=sig_trend,
            recovery_score=recovery_score,
        )
    return out
