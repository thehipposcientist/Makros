"""Region priority — the user's training emphasis preference.

Replaces the old `focused_muscle` system with a simpler 3-option model:
  - balanced    — neutral weighting, standard split logic
  - lower_body  — biases toward lower-body frequency and volume
  - upper_body  — biases toward upper-body frequency and volume

This module is the SINGLE source of truth for:
  - split preference scoring per region
  - manual split compatibility warnings
  - region-biased weekly skeleton patterns
  - internal muscle-group weighting derived from region

The deterministic planner reads this; AI chat does not override it.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

RegionPriority = Literal["balanced", "lower_body", "upper_body"]

VALID_REGIONS: set[str] = {"balanced", "lower_body", "upper_body"}


def normalize_region(raw: str | None) -> RegionPriority:
    """Normalize any input to a valid region priority."""
    if not raw:
        return "balanced"
    r = raw.strip().lower().replace("-", "_").replace(" ", "_")
    if r in VALID_REGIONS:
        return r  # type: ignore
    # Legacy focused_muscle → region mapping
    _LOWER = {"glutes", "quads", "hamstrings", "calves", "hips", "legs"}
    _UPPER = {"chest", "back", "shoulders", "biceps", "triceps", "lats", "arms"}
    if r in _LOWER:
        return "lower_body"
    if r in _UPPER:
        return "upper_body"
    return "balanced"


# ── Split preference scoring ──────────────────────────────────────

@dataclass(frozen=True)
class SplitRegionScore:
    """Score adjustment for a split based on region priority."""
    bias: int
    warning: str | None = None


# {region: {split_id: SplitRegionScore}}
# Positive bias = better fit, negative = worse fit.
# Warning text is shown when the user manually picks a clashing split.
_SPLIT_REGION_SCORES: dict[str, dict[str, SplitRegionScore]] = {
    "balanced": {},  # no bias — standard logic applies
    "lower_body": {
        "full_body":      SplitRegionScore(bias=12),
        "upper_lower":    SplitRegionScore(bias=15),
        "ppl":            SplitRegionScore(bias=-8, warning=(
            "PPL at this frequency only gives {legs_days} leg day(s) per week. "
            "Upper/Lower or Full Body would give more lower-body exposure for your priority."
        )),
        "ppl_upper_lower": SplitRegionScore(bias=5),
        "bro":            SplitRegionScore(bias=-12, warning=(
            "Body part split only trains legs once per week, which conflicts with "
            "your lower-body priority. Upper/Lower would give better lower-body frequency."
        )),
    },
    "upper_body": {
        "full_body":      SplitRegionScore(bias=5),
        "upper_lower":    SplitRegionScore(bias=10),
        "ppl":            SplitRegionScore(bias=10),
        "ppl_upper_lower": SplitRegionScore(bias=8),
        "bro":            SplitRegionScore(bias=5),
    },
}


def split_region_bias(region: RegionPriority, split_id: str) -> int:
    """Score adjustment for a split given the user's region priority."""
    scores = _SPLIT_REGION_SCORES.get(region, {})
    entry = scores.get(split_id)
    return entry.bias if entry else 0


def split_region_warning(
    region: RegionPriority,
    split_id: str,
    days_per_week: int,
) -> str | None:
    """Return a warning string if the manual split clashes with the
    region priority, or None if the split is compatible.

    The warning educates — it explains the tradeoff but doesn't block."""
    if region == "balanced":
        return None
    scores = _SPLIT_REGION_SCORES.get(region, {})
    entry = scores.get(split_id)
    if not entry or not entry.warning:
        return None
    # Only warn when the bias is actually negative (real conflict)
    if entry.bias >= 0:
        return None
    # Calculate legs days for the warning message
    legs_days = 1 if split_id == "ppl" and days_per_week <= 5 else (2 if split_id == "ppl" else 1)
    return entry.warning.format(legs_days=legs_days)


# ── Region-biased weekly skeleton patterns ────────────────────────

def region_biased_ul_pattern(
    region: RegionPriority,
    days: int,
) -> list[str] | None:
    """Return a region-biased Upper/Lower pattern, or None if the
    region is balanced (use standard logic).

    For lower_body: start and end with Lower (L/U/L, L/U/L/U/L, etc.)
    For upper_body: start and end with Upper (U/L/U, U/L/U/L/U, etc.)
    For balanced: return None → caller uses standard alternation."""
    if region == "balanced" or days < 2:
        return None

    if region == "lower_body":
        # Odd days: more Lower (L/U/L at 3, L/U/L/U/L at 5)
        # Even days: equal (L/U/L/U at 4)
        return ["lower" if i % 2 == 0 else "upper" for i in range(days)]

    if region == "upper_body":
        return ["upper" if i % 2 == 0 else "lower" for i in range(days)]

    return None


# ── Internal muscle-group weighting ───────────────────────────────

def region_volume_multipliers(region: RegionPriority) -> dict[str, float]:
    """Return per-muscle volume multipliers for the region.

    Applied to weekly_set_targets in the planner so the region priority
    shifts volume without the user picking a specific muscle.

    balanced → all 1.0 (no change)
    lower_body → lower muscles get 1.2x, upper get 0.9x
    upper_body → upper muscles get 1.2x, lower get 0.9x
    """
    if region == "balanced":
        return {}

    _LOWER_MUSCLES = {"quads", "hamstrings", "glutes", "calves"}
    _UPPER_MUSCLES = {"chest", "back", "shoulders", "biceps", "triceps"}

    if region == "lower_body":
        mults = {m: 1.2 for m in _LOWER_MUSCLES}
        mults.update({m: 0.9 for m in _UPPER_MUSCLES})
        return mults

    if region == "upper_body":
        mults = {m: 1.2 for m in _UPPER_MUSCLES}
        mults.update({m: 0.9 for m in _LOWER_MUSCLES})
        return mults

    return {}


# ── Validation helpers ────────────────────────────────────────────

def validate_region_exposure(
    region: RegionPriority,
    days: list[dict],
) -> dict:
    """Check whether the generated plan matches the region priority.

    Returns an audit dict with lower/upper day counts and a pass/fail
    flag. The planner attaches this to the plan output."""
    lower_days = 0
    upper_days = 0
    for day in days:
        arch = (day.get("archetype") or "").lower()
        focus = (day.get("focus") or "").lower()
        if any(k in arch or k in focus for k in ("lower", "legs", "leg", "glute", "hamstring", "quad")):
            lower_days += 1
        elif any(k in arch or k in focus for k in ("upper", "push", "pull", "chest", "back", "shoulder", "arm")):
            upper_days += 1

    ok = True
    message = ""
    if region == "lower_body" and lower_days <= upper_days and len(days) >= 3:
        ok = False
        message = f"Lower-body priority but only {lower_days} lower vs {upper_days} upper days"
    elif region == "upper_body" and upper_days <= lower_days and len(days) >= 3:
        ok = False
        message = f"Upper-body priority but only {upper_days} upper vs {lower_days} lower days"

    return {
        "region": region,
        "lower_days": lower_days,
        "upper_days": upper_days,
        "ok": ok,
        "message": message,
    }
