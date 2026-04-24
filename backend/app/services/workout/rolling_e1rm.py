"""Rolling e1RM — recency-weighted estimate of working 1RM per
exercise based on actual logged sets.

Used by `recommendation.py` as the primary daily-rec source. Best-
ever 1RM (the previous default) gets locked in by a single great set
and is too sticky for daily prescriptions. A weighted median over the
last N usable sets is more honest about today's working capacity.

Formula:
    set_e1rm = weight * (1 + (reps + actual_rir) / 30)         # Epley with RIR
    weight   = exp(-days_since / 14)                            # 14-day half-life-ish
    rolling  = weighted median of set_e1rm values

Why median not mean: medians shrug off outlier "felt great today"
sessions without dragging the estimate down. Why exp decay over a 14-
day half-life: matches mesocycle length — older data still informs
but recent performance dominates.

Filters applied to "usable" sets:
    - completed = True
    - set_type != "warmup"
    - reps in {compound: 3-10, isolation: 6-15}
    - actual_rir in [0, 4]
    - actual_weight_lbs > 0

Pure function. No DB writes. Caller passes in a list of sets.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable


@dataclass
class UsableSet:
    """Subset of ExerciseSet fields rolling_e1rm cares about."""
    completed_at: datetime | date
    actual_weight_lbs: float
    actual_reps: int
    actual_rir: float | None       # null → use target_rir as a fallback
    target_rir: float | None
    set_type: str | None           # "warmup" / "working" / null


@dataclass
class E1RMEstimate:
    e1rm_lbs: float
    sample_count: int
    confidence: str       # "low" | "med" | "high"

    def to_dict(self) -> dict:
        return {
            "e1rm_lbs": round(self.e1rm_lbs, 1),
            "sample_count": self.sample_count,
            "confidence": self.confidence,
        }


def _as_date(d: datetime | date) -> date:
    return d.date() if isinstance(d, datetime) else d


def _rir_for(s: UsableSet) -> float | None:
    """Prefer actual RIR (logged truth). Fall back to target RIR if
    actual is null — better than nothing for legacy rows."""
    if s.actual_rir is not None:
        return float(s.actual_rir)
    if s.target_rir is not None:
        return float(s.target_rir)
    return None


def _is_usable(s: UsableSet, role: str) -> bool:
    if (s.set_type or "").lower() in ("warmup", "warm_up"):
        return False
    if not s.actual_weight_lbs or s.actual_weight_lbs <= 0:
        return False
    if not s.actual_reps or s.actual_reps <= 0:
        return False
    rir = _rir_for(s)
    if rir is None or rir < 0 or rir > 4:
        return False
    # Role-aware rep band — heavy singles + 25-rep finishers get
    # excluded as outliers regardless of how much they're trying.
    is_iso = role in ("isolation", "finisher")
    rep_min, rep_max = (6, 15) if is_iso else (3, 10)
    if not (rep_min <= s.actual_reps <= rep_max):
        return False
    return True


def _weighted_median(values: list[tuple[float, float]]) -> float:
    """`values` is a list of (sample, weight). Returns the value at
    which cumulative weight crosses 50%. Stable + outlier-resistant —
    a single hot session can't pull the estimate up the way a mean
    would. Returns 0.0 on empty list."""
    if not values:
        return 0.0
    sorted_vals = sorted(values, key=lambda x: x[0])
    total = sum(w for _, w in sorted_vals)
    if total <= 0:
        return sorted_vals[len(sorted_vals) // 2][0]
    cum = 0.0
    half = total / 2.0
    for v, w in sorted_vals:
        cum += w
        if cum >= half:
            return v
    return sorted_vals[-1][0]


def compute_rolling_e1rm(
    sets: Iterable[UsableSet],
    *,
    role: str = "primary",
    today: date | None = None,
    half_life_days: float = 14.0,
    max_samples: int = 10,
) -> E1RMEstimate | None:
    """Weighted-median rolling e1RM over usable sets. Returns None when
    fewer than 3 usable sets exist (caller falls back to best-ever 1RM
    or AI starting weight)."""
    today = today or date.today()
    usable = [s for s in sets if _is_usable(s, role)]
    if len(usable) < 3:
        return None
    # Sort newest first so we can cap to `max_samples` and weight by
    # recency consistently.
    usable.sort(key=lambda s: _as_date(s.completed_at), reverse=True)
    usable = usable[:max_samples]

    weighted: list[tuple[float, float]] = []
    for s in usable:
        rir = _rir_for(s)
        if rir is None:
            continue
        reps_to_failure = float(s.actual_reps) + rir
        # Epley w/ RIR adjustment.
        set_e1rm = float(s.actual_weight_lbs) * (1.0 + reps_to_failure / 30.0)
        days_since = max(0, (today - _as_date(s.completed_at)).days)
        # Exponential decay by half-life — exp(-days * ln(2) / hl).
        weight = math.exp(-days_since * math.log(2) / half_life_days)
        weighted.append((set_e1rm, weight))

    if not weighted:
        return None
    e1rm = _weighted_median(weighted)
    if e1rm <= 0:
        return None

    # Confidence: more recent + more samples + tighter spread = high.
    n = len(weighted)
    spread = max(v for v, _ in weighted) - min(v for v, _ in weighted)
    spread_pct = (spread / e1rm) if e1rm > 0 else 1.0
    if n >= 7 and spread_pct < 0.15:
        confidence = "high"
    elif n >= 4 and spread_pct < 0.25:
        confidence = "med"
    else:
        confidence = "low"

    return E1RMEstimate(e1rm_lbs=e1rm, sample_count=n, confidence=confidence)
