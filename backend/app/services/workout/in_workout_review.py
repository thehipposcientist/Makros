"""Deterministic in-workout next-set recommendation.

Wraps the deterministic `recommend_next_set` from set_programming.py
with a two-stage rule review:

    1. Run deterministic recommender (cheap, always).
    2. Run `is_suspicious()` — rule-based detector flags cases where
       the deterministic result is likely wrong (feel disagrees with
       reps, first session of exercise, big overshoot/undershoot, etc).
    3. Return the deterministic result with suspicion reasons attached.

This module never calls an LLM and never persists a load/reps choice. AI can
explain, coach, or answer form/pain/substitution questions in the separate
in-workout coach surface, but live load/reps remain deterministic and
auditable. This module also does NOT talk to the DB — the caller passes in
whatever history they have, typically the current session's previous sets and
last-session results.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from .set_programming import (
    NextSetRecommendation,
    PlannedSet,
    parse_rep_range,
    recommend_next_set,
)


# ── Types ────────────────────────────────────────────────────────────


RecommendationSource = Literal["deterministic"]


@dataclass
class ReviewedRecommendation:
    """Intra-workout recommendation enriched with review metadata."""
    next_set_weight_lbs: Optional[float]
    next_set_rep_target: str
    action: str
    explanation: str
    source: RecommendationSource
    suspicion_reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "nextSetWeightLbs": self.next_set_weight_lbs,
            "nextSetRepTarget": self.next_set_rep_target,
            "action": self.action,
            "explanation": self.explanation,
            "source": self.source,
            "suspicionReasons": list(self.suspicion_reasons),
        }


# ── Suspicion detector ─────────────────────────────────────────────


# Normalization of the frontend's `SetFeedback` values into a coarse
# "perceived effort" bucket the suspicion rules use.
_FEEL_EASY = {"easy"}
_FEEL_GOOD = {"good"}
_FEEL_HARD = {"hard", "grind"}
_FEEL_FAILURE = {"failure", "form_breakdown"}
_FEEL_PAIN = {"pain"}


def _feel_bucket(feel: Optional[str]) -> Optional[str]:
    if not feel:
        return None
    f = feel.strip().lower()
    if f in _FEEL_EASY:
        return "easy"
    if f in _FEEL_GOOD:
        return "good"
    if f in _FEEL_HARD:
        return "hard"
    if f in _FEEL_FAILURE:
        return "failure"
    if f in _FEEL_PAIN:
        return "pain"
    return None


def is_suspicious(
    *,
    planned_set: PlannedSet,
    actual_reps: int,
    actual_weight_lbs: float,
    feel: Optional[str],
    previous_sets_this_session: list[dict],
    last_session_sets: list[dict],
    deterministic: NextSetRecommendation,
) -> list[str]:
    """Return a list of reasons the deterministic recommendation might
    be wrong. Empty list → safe to return deterministic result as-is.

    Rules are deterministic and cheap — they're meant to be a coarse
    filter. The user asked for "suspicious is a lot of the time," so the
    bar is intentionally low: any conflict between feel, reps, and planned
    load counts.
    """
    reasons: list[str] = []
    rng = parse_rep_range(planned_set.target_reps)
    feel_b = _feel_bucket(feel)
    no_history = not last_session_sets and not previous_sets_this_session

    # Pain always triggers review — this is a safety issue, never
    # something the deterministic recommender should ship silently.
    if feel_b == "pain":
        reasons.append("feel=pain (safety review required)")

    if rng is not None:
        lo, hi = rng
        # Big overshoot — beat top by ≥3 reps AND feel isn't "hard".
        # If user felt it was hard even after overshooting, the det
        # +1 increment is already the right call.
        if actual_reps >= hi + 3 and feel_b not in ("hard", "failure"):
            reasons.append(f"big overshoot: {actual_reps} vs top {hi}")
        # Big undershoot — missed bottom by ≥2 reps.
        if actual_reps <= max(0, lo - 2):
            reasons.append(f"big undershoot: {actual_reps} vs bottom {lo}")

        # Feel conflicts with performance:
        if feel_b == "easy" and actual_reps < lo:
            reasons.append("feel=easy but missed bottom of rep range")
        if feel_b in ("hard", "failure") and actual_reps > hi:
            reasons.append(f"feel={feel_b} but beat top of rep range")
        if feel_b == "easy" and actual_reps >= hi:
            # Genuinely-easy top-of-range sets are the most common case
            # where the deterministic +1-increment is too conservative.
            reasons.append("feel=easy and hit top — may warrant larger jump")
        if feel_b == "failure" and actual_reps >= lo:
            # Hitting failure on a set in-range means the load is right
            # at the edge; the next-set rules should consider whether to
            # drop a rep target or deload.
            reasons.append("feel=failure even within rep range")

    # First session of the exercise — no longer auto-escalates.
    # The deterministic path returns `confidence=low` + `ask_for_feel=true`
    # via the enricher, which gives the client enough to handle it.
    # Old rule (always-escalate) removed per spec — was ~20% of prod fires.

    # Deterministic said reduce_load but user reports feel=easy —
    # that's a sign the load was fine and something else went wrong
    # (setup, form cue). The deterministic review should second-guess the deload.
    if deterministic.action == "reduce_load" and feel_b == "easy":
        reasons.append("deterministic says reduce_load but feel=easy")
    # Deterministic said increase_load but user reports feel=hard —
    # bumping load here risks form breakdown next set.
    if deterministic.action == "increase_load" and feel_b in ("hard", "failure"):
        reasons.append("deterministic says increase_load but feel=hard/failure")

    return reasons


# ── Public entry point ─────────────────────────────────────────────


def reviewed_next_set_recommendation(
    *,
    exercise: dict,
    planned_set: PlannedSet,
    actual_reps: int,
    actual_weight_lbs: float,
    actual_rir: Optional[float] = None,
    feel: Optional[str] = None,
    previous_sets_this_session: Optional[list[dict]] = None,
    last_session_sets: Optional[list[dict]] = None,
    require_feel: bool = True,
) -> Optional[ReviewedRecommendation]:
    """Top-level: returns a recommendation for the user's next set.

    If `require_feel=True` (the default — matches the product
    requirement that "recommendation shouldn't say anything until
    good/easy/etc is filled out") and `feel` is empty, returns None.
    The caller should suppress the UI card.

    Otherwise: runs deterministic first, then checks suspicion. Suspicious
    sets still return the deterministic recommendation plus reasons so the
    caller can log/debug.
    """
    if require_feel and not feel:
        return None

    prev = previous_sets_this_session or []
    last = last_session_sets or []

    det = recommend_next_set(
        exercise=exercise,
        planned_set=planned_set,
        actual_reps=actual_reps,
        actual_weight_lbs=actual_weight_lbs,
        actual_rir=actual_rir,
    )

    reasons = is_suspicious(
        planned_set=planned_set,
        actual_reps=actual_reps,
        actual_weight_lbs=actual_weight_lbs,
        feel=feel,
        previous_sets_this_session=prev,
        last_session_sets=last,
        deterministic=det,
    )

    if not reasons:
        return ReviewedRecommendation(
            next_set_weight_lbs=det.next_set_weight_lbs,
            next_set_rep_target=det.next_set_rep_target,
            action=det.action,
            explanation=det.explanation,
            source="deterministic",
            suspicion_reasons=[],
        )

    # Suspicious — keep the number deterministic. The rule engine is now the
    # authority for live load/reps.
    return ReviewedRecommendation(
        next_set_weight_lbs=det.next_set_weight_lbs,
        next_set_rep_target=det.next_set_rep_target,
        action=det.action,
        explanation=det.explanation,
        source="deterministic",
        suspicion_reasons=reasons,
    )

# ── Structured recommendation wrapper ─────────────────────────────


def reviewed_set_recommendation_structured(
    *,
    exercise: dict,
    planned_set: PlannedSet,
    actual_reps: int,
    actual_weight_lbs: float,
    actual_rir: Optional[float] = None,
    feel: Optional[str] = None,
    previous_sets_this_session: Optional[list[dict]] = None,
    last_session_sets: Optional[list[dict]] = None,
    require_feel: bool = True,
):
    """Structured variant — wraps `reviewed_next_set_recommendation` and
    returns a `SetRecommendation` (camelCase on serialization). This is
    the new contract the client will consume going forward.

    Returns None when `require_feel=True` and `feel` is empty, matching
    the suppression behavior of the legacy entry point."""
    from .recommendation_schema import (
        SetRecommendation,
        enrich_to_set_recommendation,
    )
    from .set_programming import parse_rep_range

    reviewed = reviewed_next_set_recommendation(
        exercise=exercise,
        planned_set=planned_set,
        actual_reps=actual_reps,
        actual_weight_lbs=actual_weight_lbs,
        actual_rir=actual_rir,
        feel=feel,
        previous_sets_this_session=previous_sets_this_session,
        last_session_sets=last_session_sets,
        require_feel=require_feel,
    )
    if reviewed is None:
        return None

    # Rebuild a transient NextSetRecommendation-shaped object from the
    # reviewed result so the enricher can consume it uniformly.
    from .set_programming import NextSetRecommendation as _NSR

    det_shaped = _NSR(
        next_set_weight_lbs=reviewed.next_set_weight_lbs,
        next_set_rep_target=reviewed.next_set_rep_target,
        action=reviewed.action,  # type: ignore[arg-type]
        explanation=reviewed.explanation,
    )

    is_first_session = not (last_session_sets or previous_sets_this_session)
    is_first_set = not (previous_sets_this_session or [])

    return enrich_to_set_recommendation(
        det=det_shaped,
        planned=planned_set,
        actual_reps=actual_reps,
        actual_weight=actual_weight_lbs,
        actual_rir=actual_rir,
        feel=feel,
        is_first_session=is_first_session,
        is_first_set=is_first_set,
        rep_range=parse_rep_range(planned_set.target_reps),
        source="deterministic",
        data_source="session_state",
    )
