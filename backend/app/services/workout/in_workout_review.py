"""AI-reviewed in-workout next-set recommendation.

Wraps the deterministic `recommend_next_set` from set_programming.py
with a two-stage review:

    1. Run deterministic recommender (cheap, always).
    2. Run `is_suspicious()` — rule-based detector flags cases where
       the deterministic result is likely wrong (feel disagrees with
       reps, first session of exercise, big overshoot/undershoot, etc).
    3. If suspicious → AI call. Otherwise return deterministic as-is.

The AI receives the deterministic result as context so it can either
confirm, override, or soften it. The AI's response is validated and
falls back to the deterministic result on any failure.

Every response carries a `source` tag so the UI (and logs) can tell
whether the recommendation came from the deterministic path or the
LLM review. This module does NOT talk to the DB — the caller passes
in whatever history they have (typically the current session's
previous sets and the last-session results).
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from .set_programming import (
    NextSetRecommendation,
    PlannedSet,
    _bump_load,
    _drop_load,
    load_increment_for,
    parse_rep_range,
    recommend_next_set,
    round_to_increment,
)


# ── Types ────────────────────────────────────────────────────────────


RecommendationSource = Literal["deterministic", "ai_override", "ai_confirmed"]


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
    filter so we don't spend AI calls on routine sets. The user asked
    for "suspicious is a lot of the time," so the bar is intentionally
    low: any conflict between feel, reps, and planned load counts.
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
            # at the edge — deterministic would hold; AI should
            # consider whether to drop a rep target or deload.
            reasons.append("feel=failure even within rep range")

    # First session of the exercise — no longer auto-escalates.
    # The deterministic path returns `confidence=low` + `ask_for_feel=true`
    # via the enricher, which gives the client enough to handle it. AI
    # only fires on the first session IF the user's feel conflicts with
    # their reps (already caught by the rules above).
    # Old rule (always-escalate) removed per spec — was ~20% of prod fires.

    # Deterministic said reduce_load but user reports feel=easy —
    # that's a sign the load was fine and something else went wrong
    # (setup, form cue). AI should second-guess the deload.
    if deterministic.action == "reduce_load" and feel_b == "easy":
        reasons.append("deterministic says reduce_load but feel=easy")
    # Deterministic said increase_load but user reports feel=hard —
    # bumping load here risks form breakdown next set.
    if deterministic.action == "increase_load" and feel_b in ("hard", "failure"):
        reasons.append("deterministic says increase_load but feel=hard/failure")

    return reasons


# ── AI evaluator ────────────────────────────────────────────────────


_AI_SYSTEM_PROMPT = """You are a strength-training set reviewer. You receive ONE \
logged set plus a deterministic recommender's proposal for the next set. Your job \
is to either CONFIRM or OVERRIDE the proposal, with a short explanation.

You see:
- the exercise, target reps, target RIR, set role (heavy_top / backoff / volume / technique)
- what the user actually did (reps, weight)
- how the set felt (easy / good / hard / failure / pain)
- previous sets this session + last session's working sets (if any)
- the deterministic recommender's proposal (next_weight, next_reps, action, explanation)

Rules:
- If feel=pain, ALWAYS recommend stopping the exercise or dropping to a very light \
  load. Action should be "reduce_load" and explanation must flag safety.
- If feel=easy and they beat the top of the rep range, consider a bigger jump than \
  the deterministic +1 increment (up to +10 lb for upper compounds, +15 for lower).
- If feel=hard/failure even within the rep range, prefer holding load or dropping \
  one rep from the target, not increasing load.
- Never recommend increasing reps AND load at the same time.
- For the first session of a new exercise, be conservative — one increment up/down \
  at most, and say "calibrating" in the explanation.
- Keep the explanation to one or two sentences, plain English. The user will read \
  this between sets with sweat in their eyes.

Return ONLY valid JSON:
{"next_weight_lbs": number | null,
 "next_rep_target": string (e.g. "6-8"),
 "action": "increase_load" | "hold_load" | "reduce_load" | "keep_reps" | "add_rep",
 "explanation": string,
 "confirmed": boolean}

`confirmed` is true if you agree with the deterministic proposal, false if you \
overrode it.
"""


_AI_JSON_SCHEMA = {
    "name": "in_workout_review",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["next_weight_lbs", "next_rep_target", "action", "explanation", "confirmed"],
        "properties": {
            "next_weight_lbs": {"type": ["number", "null"]},
            "next_rep_target": {"type": "string"},
            "action": {
                "type": "string",
                "enum": ["increase_load", "hold_load", "reduce_load", "keep_reps", "add_rep"],
            },
            "explanation": {"type": "string"},
            "confirmed": {"type": "boolean"},
        },
    },
}


def _build_ai_context(
    *,
    exercise: dict,
    planned_set: PlannedSet,
    actual_reps: int,
    actual_weight_lbs: float,
    actual_rir: Optional[float],
    feel: Optional[str],
    previous_sets_this_session: list[dict],
    last_session_sets: list[dict],
    deterministic: NextSetRecommendation,
    suspicion_reasons: list[str],
) -> dict:
    return {
        "exercise": {
            "name": exercise.get("name"),
            "slug": exercise.get("slug"),
            "equipment_bucket": exercise.get("equipment_bucket"),
            "movement_pattern": exercise.get("movement_pattern"),
            "primary_muscle": exercise.get("primary_muscle"),
            "is_compound": bool(exercise.get("is_compound")),
            "load_increment_lbs": load_increment_for(exercise),
        },
        "planned_set": {
            "set_number": planned_set.set_number,
            "set_type": planned_set.set_type,
            "target_reps": planned_set.target_reps,
            "target_rir": planned_set.target_rir,
            "target_weight_lbs": planned_set.target_weight_lbs,
            "progression_mode": planned_set.progression_mode,
        },
        "logged": {
            "reps": actual_reps,
            "weight_lbs": actual_weight_lbs,
            "rir": actual_rir,
            "feel": feel,
        },
        "previous_sets_this_session": previous_sets_this_session,
        "last_session_sets": last_session_sets,
        "deterministic_proposal": {
            "next_weight_lbs": deterministic.next_set_weight_lbs,
            "next_rep_target": deterministic.next_set_rep_target,
            "action": deterministic.action,
            "explanation": deterministic.explanation,
        },
        "suspicion_reasons": suspicion_reasons,
    }


def _call_ai_reviewer(context: dict) -> Optional[dict]:
    """Fire the LLM review call. Returns parsed JSON or None on
    failure (caller treats None as "stick with deterministic")."""
    try:
        from openai import OpenAI
        from ...routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_chat,
        )
    except Exception as exc:
        print(f"[in_workout_review] import failed: {exc}")
        return None

    try:
        api_key = get_openai_api_key()
    except Exception:
        return None
    if not api_key:
        return None

    try:
        client = OpenAI(api_key=api_key)
        messages = [
            {"role": "system", "content": _AI_SYSTEM_PROMPT},
            {"role": "user", "content": (
                "Review this set. Respond with JSON only.\n\n"
                + json.dumps(context, indent=2)
            )},
        ]
        kwargs = _build_chat_kwargs(
            model_chat(),
            messages,
            json_schema=_AI_JSON_SCHEMA,
            max_tokens=400,
            timeout_secs=25,
        )
        response = _chat_create(client, **kwargs)
        raw = response.choices[0].message.content or ""
        return _extract_json(raw)
    except Exception as exc:
        print(f"[in_workout_review] AI call failed: {exc}")
        return None


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

    Otherwise: runs deterministic first, then checks suspicion. If
    suspicious, fires an AI review call. The result is returned with
    a `source` tag identifying which path produced it.
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

    # Suspicious — fire AI review.
    ctx = _build_ai_context(
        exercise=exercise,
        planned_set=planned_set,
        actual_reps=actual_reps,
        actual_weight_lbs=actual_weight_lbs,
        actual_rir=actual_rir,
        feel=feel,
        previous_sets_this_session=prev,
        last_session_sets=last,
        deterministic=det,
        suspicion_reasons=reasons,
    )
    ai = _call_ai_reviewer(ctx)
    if ai is None:
        # AI failed — fall back to deterministic, but surface the
        # reasons so logs make it clear we tried to escalate.
        return ReviewedRecommendation(
            next_set_weight_lbs=det.next_set_weight_lbs,
            next_set_rep_target=det.next_set_rep_target,
            action=det.action,
            explanation=det.explanation,
            source="deterministic",
            suspicion_reasons=reasons,
        )

    # Validate + round AI's weight against the exercise's real increment.
    inc = load_increment_for(exercise)
    ai_weight = ai.get("next_weight_lbs")
    if isinstance(ai_weight, (int, float)) and ai_weight > 0 and inc > 0:
        ai_weight = round_to_increment(float(ai_weight), inc)
    elif ai_weight is None:
        ai_weight = None
    else:
        ai_weight = det.next_set_weight_lbs  # unusable → deterministic

    action = ai.get("action") or det.action
    if action not in ("increase_load", "hold_load", "reduce_load", "keep_reps", "add_rep"):
        action = det.action

    # Forward/backward-progress guarantee on AI weights: rounding to the
    # grid can collapse "+5" into "+0" on off-grid anchors. If the
    # action says progress in a direction, enforce it. The user's
    # `actual_weight_lbs` is the reference (not det.next_set_weight_lbs,
    # which itself already passes through _bump_load/_drop_load).
    if (
        action == "increase_load"
        and ai_weight is not None
        and actual_weight_lbs > 0
        and ai_weight <= actual_weight_lbs
        and inc > 0
    ):
        ai_weight = _bump_load(actual_weight_lbs, inc)
    elif (
        action == "reduce_load"
        and ai_weight is not None
        and actual_weight_lbs > 0
        and ai_weight >= actual_weight_lbs
        and inc > 0
    ):
        ai_weight = _drop_load(actual_weight_lbs, inc)

    return ReviewedRecommendation(
        next_set_weight_lbs=ai_weight,
        next_set_rep_target=str(ai.get("next_rep_target") or det.next_set_rep_target),
        action=action,
        explanation=str(ai.get("explanation") or det.explanation),
        source="ai_confirmed" if bool(ai.get("confirmed")) else "ai_override",
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
    # reviewed result so the enricher can consume it uniformly. The
    # source tag tracks whether AI actually fired.
    from .set_programming import NextSetRecommendation as _NSR

    det_shaped = _NSR(
        next_set_weight_lbs=reviewed.next_set_weight_lbs,
        next_set_rep_target=reviewed.next_set_rep_target,
        action=reviewed.action,  # type: ignore[arg-type]
        explanation=reviewed.explanation,
    )

    is_first_session = not (last_session_sets or previous_sets_this_session)
    is_first_set = not (previous_sets_this_session or [])

    source = (
        "ai_review"
        if reviewed.source in ("ai_confirmed", "ai_override")
        else "deterministic"
    )

    return enrich_to_set_recommendation(
        det=det_shaped,
        planned=planned_set,
        actual_reps=actual_reps,
        actual_weight=actual_weight_lbs,
        feel=feel,
        is_first_session=is_first_session,
        is_first_set=is_first_set,
        rep_range=parse_rep_range(planned_set.target_reps),
        source=source,
    )
