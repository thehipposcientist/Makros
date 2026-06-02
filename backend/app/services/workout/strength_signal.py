"""Fresh Strength Signal — fatigue-aware estimate of working 1RM.

The "raw top set" approach (see `performance.py::build_performance_profile`
+ `rolling_e1rm.py`) treats every logged set as equally informative
about real strength. That breaks when the same lift shows up in
different positions across workouts: a 225x8 done as the first working
set is a much truer strength signal than a 225x8 done as set 4 of
exercise 6 in the same session.

This module produces a separate, fatigue-weighted strength signal
without altering the load-recommendation pipeline (which still wants
the raw top-set ceiling — see the architecture note in `__init__.py`
of this package). Two key differences from `rolling_e1rm`:

  1. **Position-in-session weighting.** Each set carries a
     freshness multiplier built from its exercise's `order_index`
     and its own `set_number`. Late-session sets contribute, but at
     a discount.
  2. **RIR confidence weighting (not hard rejection).** RIR 1-4 are
     high-confidence; RIR 0 is included at medium confidence (it's
     valid data, just noisier near failure); null RIR falls back to
     plain Epley at medium-low confidence; very-high RIR reads as
     low confidence for *strength* (it's a hypertrophy/volume signal,
     not a max signal). `rolling_e1rm` rejects everything outside
     [0, 4]; we don't, because dropping them would silently zero out
     the signal for users who don't log RIR religiously.

Per slug we return:

    estimated_one_rep_max  — trimmed weighted mean of best-fresh-eRM
                             per session over the window
    trend_28d / trend_56d  — % change vs prior window of equal length
    fresh_set_count        — count of eligible sets in window
    confidence             — "high" / "med" / "low" derived from the
                             freshness + RIR weights of contributing sets
    data_quality           — "full" | "partial" | "rough" | "missing"

Pure module — `build_strength_signal_profile` is the only function that
touches the DB; everything else is pure and unit-testable.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean
from typing import Iterable, Optional

from .rolling_e1rm import set_e1rm


# ── Tunable weights ─────────────────────────────────────────────────
#
# Documented in the user-facing spec. Centralized as constants so
# `test_strength_signal.py` can pin the math against the same values
# the production module uses.

# Exercise-position multiplier (1-indexed `order_index`, but we accept
# either 0- or 1-indexed and normalize internally — see `_slot_weight`).
_SLOT_WEIGHTS: dict[int, float] = {
    1: 1.00,
    2: 0.95,
    3: 0.90,
    4: 0.75,
    5: 0.75,
    # 6+ → 0.55 via fallback
}
_SLOT_WEIGHT_FALLBACK = 0.55

# Set-position multiplier inside the exercise (1-indexed).
_SET_WEIGHTS: dict[int, float] = {
    1: 1.00,
    2: 0.95,
    3: 0.90,
    4: 0.75,
    5: 0.75,
    # 6+ → 0.60 via fallback
}
_SET_WEIGHT_FALLBACK = 0.60

# Confidence weight by RIR. RIR 1-4 are full strength signal;
# RIR 0 is included at half weight (true grinder; eRM tends to
# overshoot but the data is real); null RIR gets 0.6 (we still trust
# the load×reps but lose the reserve information); RIR > 5 is
# discounted hard (it's a volume set, not a max signal).
_RIR_CONFIDENCE_HIGH = 1.00      # rir 1..4
_RIR_CONFIDENCE_FAILURE = 0.50   # rir == 0
_RIR_CONFIDENCE_NULL = 0.60      # rir is None
_RIR_CONFIDENCE_VOLUME = 0.30    # rir > 5

# Window defaults. 28d is the primary window; 56d is consulted when
# the 28d sample is too thin for a stable trimmed mean.
DEFAULT_WINDOW_DAYS = 28
EXTENDED_WINDOW_DAYS = 56

# Sample-size thresholds for confidence + data_quality buckets.
_FULL_QUALITY_MIN_SETS = 6
_FULL_QUALITY_MIN_SESSIONS = 3
_PARTIAL_QUALITY_MIN_SETS = 2
_HIGH_CONFIDENCE_AVG_WEIGHT = 0.85
_MED_CONFIDENCE_AVG_WEIGHT = 0.65


# ── Types ───────────────────────────────────────────────────────────


@dataclass
class FreshSet:
    """One set the gate accepted, with its computed weights. Keeping
    this as a dataclass (instead of inlining the math) makes the
    test suite able to assert against the per-set weights directly."""
    slug: str
    completed_at: date
    weight_lbs: float
    reps: int
    rir: Optional[float]
    order_index: int
    set_number: int
    e1rm_lbs: float
    slot_weight: float
    set_weight: float
    rir_weight: float

    @property
    def freshness_weight(self) -> float:
        """Combined position weight (slot × set), in [0, 1]."""
        return self.slot_weight * self.set_weight

    @property
    def total_weight(self) -> float:
        """Final weight applied to this set's eRM in the trimmed mean."""
        return self.freshness_weight * self.rir_weight


@dataclass
class StrengthSignal:
    """Per-slug strength signal. Stable shape — the API serializer
    in `progression.py::_build_showcase_lifts` reads these fields
    directly, so any rename is a wire-format change."""
    slug: str
    name: str
    estimated_one_rep_max: float
    trend_28d_pct: Optional[float]
    trend_56d_pct: Optional[float]
    fresh_set_count: int
    session_count: int
    last_performed_on: Optional[date]
    confidence: str          # "high" | "med" | "low"
    data_quality: str        # "full" | "partial" | "rough" | "missing"

    def to_dict(self) -> dict:
        return {
            "slug": self.slug,
            "name": self.name,
            "estimatedOneRepMax": round(self.estimated_one_rep_max, 1),
            "trend28dPct": (
                round(self.trend_28d_pct, 2)
                if self.trend_28d_pct is not None else None
            ),
            "trend56dPct": (
                round(self.trend_56d_pct, 2)
                if self.trend_56d_pct is not None else None
            ),
            "freshSetCount": int(self.fresh_set_count),
            "sessionCount": int(self.session_count),
            "lastPerformedOn": (
                self.last_performed_on.isoformat()
                if self.last_performed_on else None
            ),
            "confidence": self.confidence,
            "dataQuality": self.data_quality,
        }


# ── Pure helpers (small enough to inline-test) ──────────────────────


def _slot_weight(order_index: int) -> float:
    """Map a 1-indexed exercise position to its freshness multiplier.
    `order_index` of 0 is treated as 1 (some legacy rows are 0-indexed).
    Negative values clamp to the floor."""
    if order_index <= 0:
        order_index = 1
    return _SLOT_WEIGHTS.get(order_index, _SLOT_WEIGHT_FALLBACK)


def _set_position_weight(set_number: int) -> float:
    """Map a 1-indexed set number to its multiplier. Same clamp rule
    as `_slot_weight` for defensive handling of bad rows."""
    if set_number <= 0:
        set_number = 1
    return _SET_WEIGHTS.get(set_number, _SET_WEIGHT_FALLBACK)


def _rir_confidence_weight(rir: Optional[float]) -> float:
    """Map a logged RIR to its confidence weight for the strength
    signal. See the constant block above for the rationale per band."""
    if rir is None:
        return _RIR_CONFIDENCE_NULL
    try:
        r = float(rir)
    except (TypeError, ValueError):
        return _RIR_CONFIDENCE_NULL
    if r <= 0:
        return _RIR_CONFIDENCE_FAILURE
    if r >= 5:
        return _RIR_CONFIDENCE_VOLUME
    if 1 <= r <= 4:
        return _RIR_CONFIDENCE_HIGH
    # Fractional RIR (0 < r < 1, e.g. 0.5) — between failure and high.
    return (_RIR_CONFIDENCE_FAILURE + _RIR_CONFIDENCE_HIGH) / 2.0


def _trimmed_weighted_mean(values: list[tuple[float, float]]) -> float:
    """Trim the highest and lowest sample (by value, not weight) when
    we have ≥4 samples, then compute the weighted mean. This kills
    PR-day spikes and bad-day dips while still tracking real progress.

    `values` is `[(sample, weight), ...]`. Returns 0.0 on empty input."""
    if not values:
        return 0.0
    if len(values) >= 4:
        sorted_vals = sorted(values, key=lambda x: x[0])
        # Drop one off each end.
        trimmed = sorted_vals[1:-1]
    else:
        trimmed = values
    total_w = sum(w for _, w in trimmed)
    if total_w <= 0:
        # Defensive — fall back to plain mean if all weights are 0.
        return mean(v for v, _ in trimmed) if trimmed else 0.0
    return sum(v * w for v, w in trimmed) / total_w


def _classify_confidence(fresh_sets: list[FreshSet]) -> str:
    """Bucket the strength signal's confidence based on the average
    total weight across contributing sets and the raw count. Tracks
    `_HIGH_CONFIDENCE_AVG_WEIGHT` and `_MED_CONFIDENCE_AVG_WEIGHT`."""
    if not fresh_sets:
        return "low"
    avg_w = mean(s.total_weight for s in fresh_sets)
    n = len(fresh_sets)
    if n >= _FULL_QUALITY_MIN_SETS and avg_w >= _HIGH_CONFIDENCE_AVG_WEIGHT:
        return "high"
    if n >= _PARTIAL_QUALITY_MIN_SETS and avg_w >= _MED_CONFIDENCE_AVG_WEIGHT:
        return "med"
    return "low"


def _classify_data_quality(fresh_sets: list[FreshSet], session_count: int) -> str:
    """Map raw counts to a UI-facing `data_quality` bucket. The
    `rough` bucket is reserved for the explicit "fall back to raw
    top-set" path the caller can opt into; this function only ever
    returns full/partial/missing."""
    if not fresh_sets:
        return "missing"
    if (
        len(fresh_sets) >= _FULL_QUALITY_MIN_SETS
        and session_count >= _FULL_QUALITY_MIN_SESSIONS
    ):
        return "full"
    return "partial"


# ── Set-level eligibility + signal construction ─────────────────────


def build_fresh_set(
    *,
    slug: str,
    completed_at: date,
    weight_lbs: float,
    reps: int,
    rir: Optional[float],
    order_index: int,
    set_number: int,
    set_type: Optional[str] = None,
) -> Optional[FreshSet]:
    """Validate one logged set and compute its weights. Returns None
    when the set is structurally unusable (warmup, missing weight or
    reps, non-positive numbers). Position weight + RIR confidence are
    already applied — the caller does not need to reapply them."""
    if (set_type or "").lower() in ("warmup", "warm_up"):
        return None
    if not weight_lbs or weight_lbs <= 0:
        return None
    if not reps or reps <= 0:
        return None
    e1rm = set_e1rm(weight_lbs, reps, rir if rir is not None else 0)
    if e1rm is None or e1rm <= 0:
        return None
    return FreshSet(
        slug=slug,
        completed_at=completed_at,
        weight_lbs=float(weight_lbs),
        reps=int(reps),
        rir=float(rir) if rir is not None else None,
        order_index=int(order_index),
        set_number=int(set_number),
        e1rm_lbs=float(e1rm),
        slot_weight=_slot_weight(int(order_index)),
        set_weight=_set_position_weight(int(set_number)),
        rir_weight=_rir_confidence_weight(rir),
    )


def _trend_pct(current_value: float, prior_value: float) -> Optional[float]:
    """Percent change of `current_value` vs `prior_value`. Returns
    None when prior is non-positive (can't divide), and clamps to a
    sane ±200% so a tiny prior baseline can't blow up the trend."""
    if prior_value <= 0:
        return None
    pct = (current_value - prior_value) / prior_value * 100.0
    return max(-200.0, min(200.0, pct))


def _best_fresh_per_session(sets: Iterable[FreshSet]) -> dict[date, FreshSet]:
    """Pick the highest weighted eRM per session for the slug. Ties
    break by raw eRM — so two equally-fresh sets prefer the heavier
    one. Returns `{session_date: FreshSet}`."""
    best: dict[date, FreshSet] = {}
    for s in sets:
        cur = best.get(s.completed_at)
        if cur is None:
            best[s.completed_at] = s
            continue
        s_score = (s.e1rm_lbs * s.total_weight, s.e1rm_lbs)
        c_score = (cur.e1rm_lbs * cur.total_weight, cur.e1rm_lbs)
        if s_score > c_score:
            best[s.completed_at] = s
    return best


def build_signal_for_slug(
    *,
    slug: str,
    name: str,
    fresh_sets: list[FreshSet],
    today: date,
    window_days: int = DEFAULT_WINDOW_DAYS,
    extended_window_days: int = EXTENDED_WINDOW_DAYS,
) -> StrengthSignal:
    """Compose a `StrengthSignal` from a slug's fresh sets. Pure
    function — caller is responsible for fetching + filtering. Tests
    drive this directly without touching a DB."""
    if not fresh_sets:
        return StrengthSignal(
            slug=slug,
            name=name,
            estimated_one_rep_max=0.0,
            trend_28d_pct=None,
            trend_56d_pct=None,
            fresh_set_count=0,
            session_count=0,
            last_performed_on=None,
            confidence="low",
            data_quality="missing",
        )

    cutoff_28 = today - timedelta(days=window_days)
    cutoff_56 = today - timedelta(days=extended_window_days)
    cutoff_28_prior = today - timedelta(days=window_days * 2)
    cutoff_56_prior = today - timedelta(days=extended_window_days * 2)

    in_28 = [s for s in fresh_sets if s.completed_at >= cutoff_28]
    in_56 = [s for s in fresh_sets if s.completed_at >= cutoff_56]
    prior_28 = [
        s for s in fresh_sets
        if cutoff_28_prior <= s.completed_at < cutoff_28
    ]
    prior_56 = [
        s for s in fresh_sets
        if cutoff_56_prior <= s.completed_at < cutoff_56
    ]

    # Use the 28-day window when it has enough signal; otherwise widen
    # to 56 so a once-a-week lifter still gets a number.
    primary_sets = in_28
    using_extended = False
    if len(_best_fresh_per_session(in_28)) < _FULL_QUALITY_MIN_SESSIONS:
        if len(_best_fresh_per_session(in_56)) > len(_best_fresh_per_session(in_28)):
            primary_sets = in_56
            using_extended = True

    best_per_session = _best_fresh_per_session(primary_sets)
    samples = [
        (s.e1rm_lbs, s.total_weight)
        for s in best_per_session.values()
    ]
    estimated_1rm = _trimmed_weighted_mean(samples)
    if estimated_1rm <= 0 and primary_sets:
        # All weights collapsed to 0 (extreme RIR-only data). Fall back
        # to plain mean so we don't return 0 for a user who DID lift.
        estimated_1rm = mean(s.e1rm_lbs for s in best_per_session.values())

    # Trend math — current window vs prior equal-length window.
    current_28_avg = (
        mean(s.e1rm_lbs for s in _best_fresh_per_session(in_28).values())
        if in_28 else 0.0
    )
    prior_28_avg = (
        mean(s.e1rm_lbs for s in _best_fresh_per_session(prior_28).values())
        if prior_28 else 0.0
    )
    trend_28 = _trend_pct(current_28_avg, prior_28_avg) if prior_28 else None

    current_56_avg = (
        mean(s.e1rm_lbs for s in _best_fresh_per_session(in_56).values())
        if in_56 else 0.0
    )
    prior_56_avg = (
        mean(s.e1rm_lbs for s in _best_fresh_per_session(prior_56).values())
        if prior_56 else 0.0
    )
    trend_56 = _trend_pct(current_56_avg, prior_56_avg) if prior_56 else None

    confidence = _classify_confidence(primary_sets)
    data_quality = _classify_data_quality(
        primary_sets,
        session_count=len(best_per_session),
    )
    if using_extended and data_quality == "full":
        # Widening to 56 days means we don't really have 28-day-full
        # data — degrade to partial so the UI doesn't oversell.
        data_quality = "partial"

    last_performed = max((s.completed_at for s in primary_sets), default=None)

    return StrengthSignal(
        slug=slug,
        name=name,
        estimated_one_rep_max=estimated_1rm,
        trend_28d_pct=trend_28,
        trend_56d_pct=trend_56,
        fresh_set_count=len(primary_sets),
        session_count=len(best_per_session),
        last_performed_on=last_performed,
        confidence=confidence,
        data_quality=data_quality,
    )


# ── DB-touching builder ─────────────────────────────────────────────


def build_strength_signal_profile(
    user_id: int,
    db_session,
    *,
    today: Optional[date] = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
    extended_window_days: int = EXTENDED_WINDOW_DAYS,
    only_slugs: Optional[Iterable[str]] = None,
) -> dict[str, StrengthSignal]:
    """Build `{slug: StrengthSignal}` from the user's logged sets.

    Pulls the same join `build_performance_profile` uses but reads
    `WorkoutExercise.order_index` and `ExerciseSet.set_number` so the
    freshness gate has the data it needs. Only completed sessions
    + completed sets contribute. Pass `only_slugs` to narrow the
    query (e.g. for the showcase endpoint).
    """
    from sqlmodel import select

    from app.models import (
        Exercise, ExerciseSet, WorkoutExercise, WorkoutSession,
    )

    today = today or date.today()
    cutoff = today - timedelta(days=extended_window_days * 2)

    query = (
        select(
            Exercise.slug,
            Exercise.name,
            WorkoutExercise.exercise_slug_snapshot,
            WorkoutExercise.name,
            WorkoutExercise.order_index,
            WorkoutSession.workout_date,
            ExerciseSet.set_number,
            ExerciseSet.set_type,
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
    )
    if only_slugs:
        from sqlalchemy import or_

        slugs_list = list(only_slugs)
        query = query.where(or_(
            Exercise.slug.in_(slugs_list),
            WorkoutExercise.exercise_slug_snapshot.in_(slugs_list),
        ))

    rows = db_session.exec(query).all()

    # Bucket sets per slug. Resolve slug from canonical → snapshot →
    # name-slug-fallback so a workout where the canonical join missed
    # still groups correctly. Same lookup `build_performance_profile`
    # does, kept identical to avoid divergence between the two surfaces.
    sets_by_slug: dict[str, list[FreshSet]] = {}
    name_by_slug: dict[str, str] = {}
    for (
        canonical_slug, canonical_name, snapshot_slug, workout_name,
        order_index, workout_date, set_number, set_type,
        weight_lbs, reps, rir, completed_at,
    ) in rows:
        slug = (canonical_slug or snapshot_slug or "").strip()
        if not slug:
            # Fallback: derive from workout_name. Same helper
            # build_performance_profile uses.
            from .performance import _exercise_slug_fallback
            slug = _exercise_slug_fallback(workout_name)
        if not slug:
            continue
        name = canonical_name or workout_name or slug
        completed_date = (
            completed_at.date()
            if hasattr(completed_at, "date") and completed_at is not None
            else workout_date
        )
        fresh = build_fresh_set(
            slug=slug,
            completed_at=completed_date,
            weight_lbs=float(weight_lbs),
            reps=int(reps),
            rir=rir if rir is not None else None,
            order_index=int(order_index or 0),
            set_number=int(set_number or 0),
            set_type=set_type,
        )
        if fresh is None:
            continue
        sets_by_slug.setdefault(slug, []).append(fresh)
        name_by_slug.setdefault(slug, name)

    return {
        slug: build_signal_for_slug(
            slug=slug,
            name=name_by_slug.get(slug, slug),
            fresh_sets=sets,
            today=today,
            window_days=window_days,
            extended_window_days=extended_window_days,
        )
        for slug, sets in sets_by_slug.items()
    }
