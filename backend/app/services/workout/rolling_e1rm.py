"""Rolling e1RM — recency-weighted estimate of working 1RM per
exercise based on actual logged sets.

Used by `recommendation.py` as the primary daily-rec source. Best-
ever 1RM (the previous default) gets locked in by a single great set
and is too sticky for daily prescriptions. A weighted median over the
last N usable sets is more honest about today's working capacity.

Architecture (keep this short — it's the part that drifts):

    set_e1rm(weight, reps, rir)              ← single source of truth
    └─ used by compute_rolling_e1rm
    └─ also used by frontend `oneRepMax.ts` (mirror in TS, same math)

`set_e1rm` is pure Epley with RIR adjustment:

    e1rm = weight * (1 + (reps + rir) / 30)

Why Epley alone (and not the older Brzycki blend):
  - Brzycki diverges near r=10 and noisily disagrees with Epley above
    that. Mixing them only made surfaces drift apart.
  - The frontend now uses the same Epley formula on every per-set
    display so the rolling chart, the prescribed-weight engine, and
    the PR card all read off one set of physics.

Filters applied to "usable" sets (all category-aware now):

    - completed = True
    - set_type != "warmup"
    - actual_weight_lbs > 0, actual_reps > 0
    - actual_rir in [0, 4]
    - reps in the rep window for the role:
        primary / main_compound  → 1–10
        machine_compound         → 3–12
        accessory                → 3–12   (alias for machine_compound)
        isolation / finisher     → REFUSED (returns None)

Why isolation refuses: Epley overshoots wildly on tendon-bound lifts
(lateral raise, cable curl, rear delt fly). The recommender + the
Strength Score would both lie if these counted. Isolation tracking
goes through best-set / volume-trend surfaces in the UI instead.

Pure function. No DB writes. Caller passes in a list of sets.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, datetime
from typing import Iterable, Optional


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


# ── Category / rep windows ──────────────────────────────────────────

# The role string the recommendation engine + endpoints already pass
# in is the source of truth. We treat several aliases as synonyms so
# call sites don't have to spell things one specific way.
_MAIN_ROLES = frozenset({"primary", "main", "main_compound", "compound"})
_MACHINE_ROLES = frozenset({"machine", "machine_compound", "accessory"})
_ISOLATION_ROLES = frozenset({"isolation", "finisher"})

# (min, max) inclusive. None → category refuses to estimate.
_REP_WINDOW: dict[str, Optional[tuple[int, int]]] = {
    "main_compound": (1, 10),
    "machine_compound": (3, 12),
    "isolation": None,
}


def _category_for_role(role: str) -> str:
    """Normalize the role string into one of the three canonical
    categories. Unknown roles default to `main_compound` — the strict
    end of the validity window, so unknown lifts can't sneak past the
    rep filter without being noticed."""
    r = (role or "").strip().lower()
    if r in _ISOLATION_ROLES: return "isolation"
    if r in _MACHINE_ROLES: return "machine_compound"
    if r in _MAIN_ROLES: return "main_compound"
    return "main_compound"


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


# ── Single source of truth for set-level e1RM ───────────────────────

def set_e1rm(
    weight_lbs: float | int | None,
    reps: float | int | None,
    rir: float | int | None,
) -> float | None:
    """Pure Epley with RIR adjustment.

        e1rm = weight × (1 + (reps + rir) / 30)

    Negative RIR clamps to 0 (logging "negative reps in reserve" isn't
    a thing the equation can handle gracefully). Returns None on
    invalid inputs; this function does NOT enforce category rep
    windows — that's the caller's responsibility (see `_is_usable`)."""
    if weight_lbs is None or reps is None:
        return None
    try:
        w = float(weight_lbs)
        r = float(reps)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(w) or not math.isfinite(r):
        return None
    if w <= 0 or r <= 0:
        return None
    rir_raw = 0.0
    if rir is not None:
        try:
            rir_val = float(rir)
            if math.isfinite(rir_val) and rir_val > 0:
                rir_raw = rir_val
        except (TypeError, ValueError):
            rir_raw = 0.0
    eff_reps = r + rir_raw
    return w * (1.0 + eff_reps / 30.0)


def _is_usable(s: UsableSet, role: str) -> bool:
    """Eligibility filter for the rolling estimator. Drops warmups,
    invalid RIR, and reps outside the category-specific window. Note
    that `category == isolation` shortcuts to False — isolations don't
    feed the rolling estimator at all."""
    if (s.set_type or "").lower() in ("warmup", "warm_up"):
        return False
    if not s.actual_weight_lbs or s.actual_weight_lbs <= 0:
        return False
    if not s.actual_reps or s.actual_reps <= 0:
        return False
    rir = _rir_for(s)
    if rir is None or rir < 0 or rir > 4:
        return False

    category = _category_for_role(role)
    window = _REP_WINDOW.get(category)
    if window is None:
        return False
    rep_min, rep_max = window
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
    """Weighted-median rolling e1RM over usable sets. Returns None
    when fewer than 3 usable sets exist (caller falls back to best-
    ever 1RM or AI starting weight) OR when the role resolves to
    `isolation` (we don't trust Epley for tendon-bound lifts)."""
    today = today or date.today()
    category = _category_for_role(role)
    if category == "isolation":
        return None

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
        e1rm = set_e1rm(s.actual_weight_lbs, s.actual_reps, rir)
        if e1rm is None or e1rm <= 0:
            continue
        days_since = max(0, (today - _as_date(s.completed_at)).days)
        # Exponential decay by half-life — exp(-days * ln(2) / hl).
        weight = math.exp(-days_since * math.log(2) / half_life_days)
        weighted.append((e1rm, weight))

    if not weighted:
        return None
    final = _weighted_median(weighted)
    if final <= 0:
        return None

    # Confidence: more recent + more samples + tighter spread = high.
    n = len(weighted)
    spread = max(v for v, _ in weighted) - min(v for v, _ in weighted)
    spread_pct = (spread / final) if final > 0 else 1.0
    if n >= 7 and spread_pct < 0.15:
        confidence = "high"
    elif n >= 4 and spread_pct < 0.25:
        confidence = "med"
    else:
        confidence = "low"

    return E1RMEstimate(e1rm_lbs=final, sample_count=n, confidence=confidence)
