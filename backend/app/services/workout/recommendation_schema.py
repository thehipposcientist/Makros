"""Structured recommendation contract shared by every set-recommendation
surface (active-workout next-set review, pre-set recommendation, weekly
check-in judgements).

Pure types + a single enricher that takes a deterministic
`NextSetRecommendation` and a `PlannedSet` and wraps them into the richer
`SetRecommendation` the client consumes. No LLM calls live here.

Design goal: the client should never have to guess whether a recommended
drop is a deload, a backoff transition, or a "you overshot and I'm being
conservative" — the `set_type`, `intensity_label`, `change_direction`,
and `reason_tags` fields make intent explicit.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .set_programming import NextSetRecommendation, PlannedSet


# ── Enums ──────────────────────────────────────────────────────────

SetType = Literal[
    "warmup",       # ramp-up, not graded
    "heavy_top",    # highest-load set of the exercise
    "backoff",      # moderate-load after a heavy top, same rep range
    "volume",       # hypertrophy bias, moderate load + higher reps
    "technique",    # skill/priming, fixed reps, light load
    "working",      # generic working set — used when set-type isn't known
]

IntensityLabel = Literal[
    "ramp", "top_effort", "working", "backoff", "volume", "technique",
]

ChangeDirection = Literal["increase", "hold", "decrease"]
Confidence = Literal["high", "medium", "low"]

# Every deterministic reason the client might want to surface. Keep these
# stable because mobile/watch surfaces use them for badges and copy.
ReasonTag = Literal[
    # Rep-range outcomes
    "overshot_reps", "undershot_reps", "hit_range",
    # Feel signals
    "feel_easy", "feel_hard", "feel_failure", "feel_pain",
    # Session state
    "high_fatigue", "first_session", "first_set", "no_history", "anchor_only",
    # Intent tags
    "backoff_transition", "volume_target", "technique_priority",
    "top_set_priority", "warmup_ramp",
    # History signals
    "last_session_lighter", "last_session_heavier",
    # Progression decisions
    "progressive_overload", "deload_trigger", "rir_in_tank",
]

Source = Literal["deterministic", "ai_review", "fallback"]
AlgorithmSource = Literal["deterministic_progression"]
DataSource = Literal[
    "exact_exercise_history",
    "substitution_group",
    "movement_pattern",
    "muscle_equipment_bucket",
    "default",
    "session_state",
    "plan_snapshot",
]

RECOMMENDATION_VERSION = "live_recommendation.v1"


@dataclass
class SetRecommendation:
    """Wire-facing structured recommendation. camelCase on serialization
    via `to_dict` so the mobile client can type-match without a mapper."""
    recommended_weight_lbs: Optional[float]
    recommended_reps: str
    set_type: SetType
    intensity_label: IntensityLabel
    change_direction: ChangeDirection
    confidence: Confidence
    rationale_short: str
    reason_tags: list[str] = field(default_factory=list)
    ask_for_feel_after_set: bool = False
    source: Source = "deterministic"
    algorithm_source: AlgorithmSource = "deterministic_progression"
    data_source: DataSource = "session_state"
    trace: dict[str, Any] | None = None

    def to_dict(self) -> dict:
        return {
            "recommendedWeightLbs": self.recommended_weight_lbs,
            "recommendedReps": self.recommended_reps,
            "setType": self.set_type,
            "intensityLabel": self.intensity_label,
            "changeDirection": self.change_direction,
            "confidence": self.confidence,
            "rationaleShort": self.rationale_short,
            "reasonTags": list(self.reason_tags),
            "askForFeelAfterSet": self.ask_for_feel_after_set,
            "source": self.source,
            "algorithmSource": self.algorithm_source,
            "dataSource": self.data_source,
            "trace": self.trace,
        }


# ── Mapping helpers ────────────────────────────────────────────────


def _set_type_to_intensity(set_type: str) -> IntensityLabel:
    """Map the planner's SetType to the user-facing intensity label."""
    if set_type == "warmup":
        return "ramp"
    if set_type == "heavy_top":
        return "top_effort"
    if set_type == "backoff":
        return "backoff"
    if set_type == "volume":
        return "volume"
    if set_type == "technique":
        return "technique"
    return "working"


def _action_to_direction(action: str) -> ChangeDirection:
    if action in ("increase_load", "add_rep"):
        return "increase"
    if action in ("reduce_load",):
        return "decrease"
    return "hold"


def _intent_tags_for_set_type(set_type: str) -> list[str]:
    if set_type == "heavy_top":
        return ["top_set_priority"]
    if set_type == "backoff":
        return ["backoff_transition"]
    if set_type == "volume":
        return ["volume_target"]
    if set_type == "technique":
        return ["technique_priority"]
    if set_type == "warmup":
        return ["warmup_ramp"]
    return []


def enrich_to_set_recommendation(
    *,
    det: "NextSetRecommendation",
    planned: "PlannedSet",
    actual_reps: Optional[int] = None,
    actual_weight: Optional[float] = None,
    actual_rir: Optional[float] = None,
    feel: Optional[str] = None,
    is_first_session: bool = False,
    is_first_set: bool = False,
    rep_range: Optional[tuple[int, int]] = None,
    source: Source = "deterministic",
    algorithm_source: AlgorithmSource = "deterministic_progression",
    data_source: DataSource = "session_state",
    fallback_used: bool = False,
) -> SetRecommendation:
    """Wrap a deterministic `NextSetRecommendation` with the structured
    metadata the client wants. Pure function — no I/O, no LLM.

    Callers pass in what they know; unknown fields are safe to omit.
    Reason tags are accumulated from:
      * the set-type intent
      * feel bucket
      * overshoot/undershoot vs rep range
      * first-session / first-set signals
      * the deterministic action
    """
    set_type = planned.set_type if planned else "working"
    intensity = _set_type_to_intensity(set_type)
    direction = _action_to_direction(det.action)

    tags: list[str] = list(_intent_tags_for_set_type(set_type))

    if is_first_session:
        tags += ["first_session", "no_history", "anchor_only"]
    if is_first_set and not is_first_session:
        tags.append("first_set")

    # Rep-range outcomes
    if rep_range is not None and actual_reps is not None:
        lo, hi = rep_range
        if actual_reps > hi:
            tags.append("overshot_reps")
        elif actual_reps < lo:
            tags.append("undershot_reps")
        else:
            tags.append("hit_range")

    # Feel mapping
    if feel:
        f = feel.lower()
        if f in ("easy", "good") and actual_reps is not None and rep_range is not None:
            if actual_reps >= rep_range[1]:
                tags.append("rir_in_tank")
        if f == "easy":
            tags.append("feel_easy")
        elif f == "hard":
            tags.append("feel_hard")
        elif f == "failure":
            tags.append("feel_failure")
        elif f == "pain":
            tags.append("feel_pain")

    # Progression signals
    if det.action == "increase_load":
        tags.append("progressive_overload")
    elif det.action == "reduce_load":
        tags.append("deload_trigger")

    # Confidence heuristic — drop a level per uncertainty source
    conf_score = 3
    if is_first_session:
        conf_score -= 2
    if not actual_reps and not actual_weight:
        conf_score -= 1
    if feel == "pain":
        conf_score = min(conf_score, 1)  # low confidence on pain
    confidence: Confidence = (
        "high" if conf_score >= 3 else "medium" if conf_score == 2 else "low"
    )

    # First session → ask for feel so the next set can calibrate
    ask_feel = is_first_session or is_first_set or feel == "pain"

    previous_classification = None
    if rep_range is not None and actual_reps is not None:
        lo, hi = rep_range
        if actual_reps > hi:
            previous_classification = "overshot_target"
        elif actual_reps < lo:
            previous_classification = "undershot_target"
        else:
            previous_classification = "hit_target"

    # Dedupe tags while preserving order
    seen: set[str] = set()
    unique_tags: list[str] = []
    for t in tags:
        if t not in seen:
            seen.add(t)
            unique_tags.append(t)

    trace = {
        "recommendationVersion": RECOMMENDATION_VERSION,
        "setIntent": set_type,
        "previousSetClassification": previous_classification,
        "targetRepRange": planned.target_reps if planned else det.next_set_rep_target,
        "priorWeight": actual_weight,
        "recommendedWeight": det.next_set_weight_lbs,
        "recommendedReps": det.next_set_rep_target,
        "adjustmentReason": det.action,
        "fatigueApplied": "high_fatigue" in unique_tags,
        "rirUsed": actual_rir,
        "fallbackUsed": fallback_used,
    }

    return SetRecommendation(
        recommended_weight_lbs=det.next_set_weight_lbs,
        recommended_reps=det.next_set_rep_target,
        set_type=set_type,  # type: ignore[arg-type]
        intensity_label=intensity,
        change_direction=direction,
        confidence=confidence,
        rationale_short=det.explanation[:140],
        reason_tags=unique_tags,
        ask_for_feel_after_set=ask_feel,
        source=source,
        algorithm_source=algorithm_source,
        data_source=data_source,
        trace=trace,
    )
