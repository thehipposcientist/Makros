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
    """Subset of ExerciseSet fields rolling_e1rm cares about.

    `workout_id` is optional — when present it's the most reliable
    grouping key for the "distinct sessions" confidence check; when
    absent we fall back to completed_at date. Older callers that
    weren't updated to populate the field default to None and the
    distinct-session count falls back to date grouping."""
    completed_at: datetime | date
    actual_weight_lbs: float
    actual_reps: int
    actual_rir: float | None       # null → use target_rir as a fallback
    target_rir: float | None
    set_type: str | None           # "warmup" / "working" / null
    workout_id: int | None = None


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

# Cap on `reps + rir` per category. Without this, a set like 225 × 10 @
# 4 RIR would Epley out to a 14-rep equivalent (≈ 330 lb) — physically
# inappropriate for prescription math because reps that far from
# failure aren't actually informative about today's true 1RM.
# Matches the upper end of `_REP_WINDOW` so capping is conservative:
# the e1RM never speaks above the range the role is allowed to score.
_MAX_EFFECTIVE_REPS: dict[str, Optional[int]] = {
    "main_compound": 10,
    "machine_compound": 12,
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


def _max_effective_reps(role: str | None) -> int | None:
    """Cap on `reps + rir` for the category resolved from `role`.

    Returns None for `isolation` (which doesn't score at all upstream)
    so callers can short-circuit. Public-ish — `set_e1rm` and any
    upstream rep validators should read from here so the cap stays a
    single source of truth."""
    return _MAX_EFFECTIVE_REPS.get(_category_for_role(role or ""))


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


# Source labels for the RIR value used on a given set. The rolling
# estimator tracks these so confidence can be downgraded when the
# fallback path dominated the sample.
RirSource = str  # Literal["actual", "target"] — string for backward compat


def _rir_with_source(s: UsableSet) -> tuple[float | None, RirSource | None]:
    """Same fallback chain as `_rir_for` but also reports which source
    won. The estimator aggregates the `actual` share to decide whether
    high confidence is allowed."""
    if s.actual_rir is not None:
        return float(s.actual_rir), "actual"
    if s.target_rir is not None:
        return float(s.target_rir), "target"
    return None, None


def _distinct_session_count(sets: Iterable[UsableSet]) -> int:
    """Best-effort count of independent workouts in the sample.

    `workout_id` is the most reliable key. When all sets have None
    for `workout_id` we fall back to the completed_at *date* — two
    sets on the same day are treated as one session, which biases
    toward "low confidence" rather than overstating session diversity.

    Returns at least 1 so the confidence math has something to divide
    against; the calling logic interprets `<2` as "no high/med."""
    by_id: set[int] = set()
    by_date: set[date] = set()
    any_id_set = False
    for s in sets:
        if s.workout_id is not None:
            by_id.add(int(s.workout_id))
            any_id_set = True
        by_date.add(_as_date(s.completed_at))
    if any_id_set:
        return max(1, len(by_id))
    return max(1, len(by_date))


def _adjust_confidence_for_rir_source(confidence: str, actual_ratio: float) -> str:
    """Downgrade confidence when `target_rir` was the dominant source.

    Rules:
      - ratio >= 0.70 → unchanged (high allowed)
      - 0.50 <= ratio < 0.70 → cap at "med"
      - ratio < 0.50 → cap at "low"

    Target RIR is a prescription intent, not observed truth — letting
    a sample full of intent-based RIR claim "high confidence" would
    propagate guessed numbers into prescription math."""
    if actual_ratio >= 0.70:
        return confidence
    if actual_ratio >= 0.50:
        return "med" if confidence == "high" else confidence
    # < 50% actual_rir — anything above "low" is dishonest.
    return "low"


# ── Single source of truth for set-level e1RM ───────────────────────

def set_e1rm(
    weight_lbs: float | int | None,
    reps: float | int | None,
    rir: float | int | None,
    *,
    role: str | None = None,
) -> float | None:
    """Pure Epley with RIR adjustment.

        e1rm = weight × (1 + min(reps + rir, cap) / 30)

    Where `cap` comes from the category resolved from `role`:
        - main_compound → 10
        - machine_compound → 12
        - isolation → returns None (caller should not score)

    Without the cap, 225 × 10 @ 4 RIR would behave like a 14-rep
    Epley estimate (≈ 330 lb), which is too aggressive for daily
    prescription math. Capping at the category's rep-window upper
    bound keeps the estimate honest about what we've actually
    observed.

    Backward compat: `role` defaults to None which resolves to
    `main_compound` (the strictest cap), so existing call sites
    that don't yet pass `role` get the safe behaviour. Negative RIR
    clamps to 0. Returns None on invalid inputs; this function does
    NOT enforce category rep windows for the input reps — that's
    `_is_usable`'s job — but it does cap the *effective* reps after
    adding RIR."""
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

    cap = _max_effective_reps(role)
    if cap is None:
        # Isolation — refuse. Matches `compute_rolling_e1rm`'s isolation
        # short-circuit so PR cards, strength score, and rolling all
        # agree.
        if _category_for_role(role or "") == "isolation":
            return None
        cap = 10  # belt-and-suspenders for unknown roles

    rir_raw = 0.0
    if rir is not None:
        try:
            rir_val = float(rir)
            if math.isfinite(rir_val) and rir_val > 0:
                rir_raw = rir_val
        except (TypeError, ValueError):
            rir_raw = 0.0
    eff_reps = min(r + rir_raw, float(cap))
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
    sets_contributing: list[UsableSet] = []
    actual_count = 0
    for s in usable:
        rir, rir_src = _rir_with_source(s)
        if rir is None:
            continue
        e1rm = set_e1rm(s.actual_weight_lbs, s.actual_reps, rir, role=role)
        if e1rm is None or e1rm <= 0:
            continue
        days_since = max(0, (today - _as_date(s.completed_at)).days)
        # Exponential decay by half-life — exp(-days * ln(2) / hl).
        weight = math.exp(-days_since * math.log(2) / half_life_days)
        weighted.append((e1rm, weight))
        sets_contributing.append(s)
        if rir_src == "actual":
            actual_count += 1

    if not weighted:
        return None
    final = _weighted_median(weighted)
    if final <= 0:
        return None

    # Confidence: more recent + more samples + tighter spread + multiple
    # distinct sessions + actual_rir-dominated = high.
    n = len(weighted)
    spread = max(v for v, _ in weighted) - min(v for v, _ in weighted)
    spread_pct = (spread / final) if final > 0 else 1.0
    distinct_sessions = _distinct_session_count(sets_contributing)
    actual_ratio = actual_count / n if n else 0.0

    if n >= 7 and distinct_sessions >= 3 and spread_pct < 0.15:
        confidence = "high"
    elif n >= 4 and distinct_sessions >= 2 and spread_pct < 0.25:
        confidence = "med"
    else:
        confidence = "low"

    # Downgrade after the base tier so a target_rir-heavy sample can't
    # claim high confidence even when n / spread look good.
    confidence = _adjust_confidence_for_rir_source(confidence, actual_ratio)

    return E1RMEstimate(e1rm_lbs=final, sample_count=n, confidence=confidence)
