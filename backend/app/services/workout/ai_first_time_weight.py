"""AI-assisted starting-weight recommendation for first-time exercises.

Fired by the `/ai/recommend-weight` endpoint when:
  1. The user has NO direct logged history for the target exercise.
  2. The layered transfer pipeline (substitution_group → movement_pattern
     → muscle_bucket) couldn't find a usable anchor either.
  3. BUT the user DOES have recent logged sessions for other exercises
     that share the same `primary_muscle`.

The AI is shown those recent sessions (exercise name, equipment, set/rep
profile, top weight) + the user's experience + bodyweight, and asked to
pick a sensible starting weight for the new exercise in the target rep
range. Output is rounded to 2.5 lb and stamped with
`weightRecommendationSource = 'ai_first_time'` so the UI can show the
user why the number appeared.

Fail-safe: any AI error (auth, timeout, malformed JSON) returns None so
the caller can fall through to the existing tier-6/7 deterministic
defaults. Never raises.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Literal, Optional


logger = logging.getLogger(__name__)


Confidence = Literal["low", "medium", "high"]


@dataclass
class AIFirstTimeRecommendation:
    """Structured AI recommendation for a first-time exercise.

    `weight_lbs` is already rounded to 2.5 lb. `confidence` is one of
    `low` / `medium` / `high` — mapped from the AI's own confidence
    tag, with a conservative fallback to "low" when the AI returns
    anything else.
    """
    weight_lbs: float
    reason: str
    confidence: Confidence


_PROMPT_TEMPLATE = (
    "User is about to do {exercise_name} for the first time "
    "(target: {target_reps}).\n"
    "Recent {primary_muscle} sessions:\n"
    "{session_lines}\n"
    "User experience: {experience}. Bodyweight: {weight_lbs} lb.\n"
    "Recommend a sensible starting weight (lb) for {exercise_name}.\n"
    "Consider:\n"
    "- Biomechanical similarity between the target exercise and recent "
    "exercises.\n"
    "- Target rep range suggests lower weight if higher reps, vice versa.\n"
    "- Be conservative — first-time rec, user can add weight next set.\n"
    'Respond as JSON: {{"weight_lbs": int, "reason": str, '
    '"confidence": "low"|"medium"|"high"}}.'
)


_SCHEMA = {
    "name": "ai_first_time_weight",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["weight_lbs", "reason", "confidence"],
        "properties": {
            "weight_lbs": {"type": "number"},
            "reason": {"type": "string", "maxLength": 300},
            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        },
    },
}


def _format_session_line(s: dict) -> str:
    name = s.get("exercise_name") or s.get("exercise_slug") or "?"
    equip = s.get("equipment") or "bodyweight"
    set_count = int(s.get("set_count") or 0)
    reps_logged = s.get("reps_logged") or ""
    top_weight = float(s.get("top_weight_lbs") or 0.0)
    # Prefer the per-set rep breakdown if present, otherwise the
    # aggregate "set_count × top_reps" line.
    rep_part = reps_logged or f"{set_count}x{int(s.get('top_reps') or 0)}"
    return (
        f"- {name} ({equip}) — {set_count} sets x {rep_part}, "
        f"top weight {top_weight:g} lb"
    )


def _round_to_plate(weight_lbs: float, increment: float = 2.5) -> float:
    if weight_lbs <= 0:
        return 0.0
    return round(round(weight_lbs / increment) * increment, 1)


def _coerce_confidence(raw: object) -> Confidence:
    """Normalize the AI's confidence tag. Unknown values collapse to
    "low" — better to underclaim confidence than overclaim it on a
    first-time recommendation."""
    try:
        v = str(raw or "").strip().lower()
    except Exception:
        v = ""
    if v in ("low", "medium", "high"):
        return v  # type: ignore[return-value]
    return "low"


def ai_first_time_weight_recommendation(
    *,
    exercise_name: str,
    primary_muscle: str,
    target_reps: str,
    experience: str,
    bodyweight_lbs: float,
    muscle_sessions: list[dict],
    openai_client: object,
    model: str,
    chat_kwargs_builder,
    chat_invoker,
    json_extractor,
    max_tokens: int = 250,
    timeout_secs: int = 15,
) -> Optional[AIFirstTimeRecommendation]:
    """Ask the AI to pick a starting weight for a first-time exercise.

    Dependencies are injected so this module stays testable without
    booting FastAPI / openai. The router wires in `_build_chat_kwargs`,
    `_chat_create`, and `_extract_json` from `ai.utils`.

    Returns None on ANY failure (no sessions, no client, AI error,
    malformed JSON) so the caller can fall through to the existing
    deterministic defaults. Never raises.
    """
    if not muscle_sessions:
        return None
    if openai_client is None:
        return None

    session_lines = "\n".join(_format_session_line(s) for s in muscle_sessions[:3])
    prompt = _PROMPT_TEMPLATE.format(
        exercise_name=exercise_name,
        target_reps=target_reps or "8-12",
        primary_muscle=primary_muscle,
        session_lines=session_lines,
        experience=experience or "intermediate",
        weight_lbs=int(round(bodyweight_lbs or 0)),
    )
    messages = [
        {
            "role": "system",
            "content": (
                "You are a strength coach. Pick a sensible, conservative "
                "starting weight (lb) for a first-time exercise based on "
                "the user's recent logged sessions for the same muscle. "
                "Return only the required JSON."
            ),
        },
        {"role": "user", "content": prompt},
    ]

    try:
        kwargs = chat_kwargs_builder(
            model,
            messages,
            json_schema=_SCHEMA,
            max_tokens=max_tokens,
            timeout_secs=timeout_secs,
        )
        response = chat_invoker(openai_client, **kwargs)
        content = response.choices[0].message.content or ""
    except Exception as exc:
        logger.exception(
            "[ai_first_time_weight] AI call failed for %s: %s", exercise_name, exc
        )
        return None

    try:
        data = json_extractor(content)
    except Exception as exc:
        logger.exception(
            "[ai_first_time_weight] JSON parse failed for %s: raw=%r err=%s",
            exercise_name, content[:200], exc,
        )
        return None

    if not isinstance(data, dict):
        logger.warning(
            "[ai_first_time_weight] AI returned non-object JSON for %s: %r",
            exercise_name, data,
        )
        return None

    raw_weight = data.get("weight_lbs")
    try:
        weight = float(raw_weight)
    except (TypeError, ValueError):
        logger.warning(
            "[ai_first_time_weight] AI returned invalid weight for %s: %r",
            exercise_name, raw_weight,
        )
        return None
    if weight <= 0:
        logger.warning(
            "[ai_first_time_weight] AI returned non-positive weight for %s: %r",
            exercise_name, weight,
        )
        return None

    reason = str(data.get("reason") or "").strip()
    if not reason:
        reason = (
            f"First-time recommendation — estimated from your recent "
            f"{primary_muscle} work."
        )
    confidence = _coerce_confidence(data.get("confidence"))

    return AIFirstTimeRecommendation(
        weight_lbs=_round_to_plate(weight, increment=2.5),
        reason=reason[:300],
        confidence=confidence,
    )
