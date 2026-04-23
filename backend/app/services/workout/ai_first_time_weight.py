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
    "Recent sessions that hit {primary_muscle} — each tagged with how "
    "strong a calibration signal it is:\n"
    "{session_lines}\n"
    "User experience: {experience}. Bodyweight: {weight_lbs} lb.\n"
    "Recommend a sensible starting weight (lb) for {exercise_name}.\n"
    "Signal-weighting rules (apply in order):\n"
    "1. `[primary compound]` lifts are the strongest anchor — e.g. a user\n"
    "   bench-pressing 225 for 5 should NOT start skull crushers at 30 lb.\n"
    "2. `[secondary compound]` lifts still carry real load-capacity info —\n"
    "   bench press numbers are meaningful for a first-time skull crusher.\n"
    "3. `[primary isolation]` lifts give you the most-direct movement\n"
    "   analog when compounds aren't available.\n"
    "4. `[secondary isolation]` lifts are the weakest — use only to set\n"
    "   a floor, not a target.\n"
    "Further considerations:\n"
    "- Biomechanical similarity between target and reference exercises.\n"
    "- Target rep range → lower weight at higher reps and vice versa.\n"
    "- Isolation lifts need ~30–50% of the compound's load at same reps.\n"
    "- Be conservative — the user can add weight next set.\n"
    'Respond as JSON: {{"weight_lbs": int}}.'
)

# Brand-new user — no training history at all for this muscle group.
# The AI recommends off bodyweight + age + sex + experience using
# standard strength-ratio norms.
_PROMPT_TEMPLATE_NO_HISTORY = (
    "User is about to do {exercise_name} for the first time.\n"
    "Target rep range: {target_reps}. Primary muscle: {primary_muscle}.\n"
    "They have NO prior logged sessions for this muscle group — so infer "
    "a reasonable starting weight from their profile using strength "
    "standards for their demographics.\n"
    "User profile:\n"
    "- Sex: {sex}\n"
    "- Age: {age}\n"
    "- Bodyweight: {weight_lbs} lb\n"
    "- Experience: {experience}\n"
    "Rules:\n"
    "- Use bodyweight ratios for the exercise + muscle (e.g. bench ≈ "
    "0.35–0.5× BW novice male, 0.2–0.33× BW novice female; squat "
    "≈ 0.5–0.75× BW novice; deadlift ≈ 0.75–1× BW novice).\n"
    "- Age > 50 → reduce by ~15%.\n"
    "- Beginner → lower end of the range; intermediate → middle; "
    "advanced → upper end.\n"
    "- Bodyweight-only / mobility exercises → return 0 lb.\n"
    "- Be conservative — the user can add weight next set.\n"
    'Respond as JSON: {{"weight_lbs": int}}.'
)


_SCHEMA = {
    "name": "ai_first_time_weight",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["weight_lbs"],
        "properties": {
            "weight_lbs": {"type": "number"},
        },
    },
}


_RELATION_LABEL = {
    "primary_compound":   "[primary compound — strongest signal]",
    "secondary_compound": "[secondary muscle, compound lift — good proxy]",
    "primary_isolation":  "[primary muscle, isolation]",
    "secondary_isolation":"[secondary muscle, isolation — weakest signal]",
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
    relation = _RELATION_LABEL.get(str(s.get("relation") or ""), "")
    return (
        f"- {name} ({equip}) — {set_count} sets x {rep_part}, "
        f"top weight {top_weight:g} lb {relation}".rstrip()
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
    age: int | None = None,
    sex: str | None = None,
    max_tokens: int = 250,
    timeout_secs: int = 15,
) -> Optional[AIFirstTimeRecommendation]:
    """Ask the AI to pick a starting weight for a first-time exercise.

    TWO modes:
    - If `muscle_sessions` is non-empty → use the user's recent logged
      sessions for the same primary muscle as anchors (high signal).
    - If `muscle_sessions` is empty → use profile data only
      (bodyweight / age / sex / experience) against strength-standard
      ratios. Lower confidence, more conservative.

    Returns None on ANY failure (no client, AI error, malformed JSON)
    so the caller can fall through to the deterministic default.
    """
    if openai_client is None:
        return None

    if muscle_sessions:
        session_lines = "\n".join(_format_session_line(s) for s in muscle_sessions[:3])
        prompt = _PROMPT_TEMPLATE.format(
            exercise_name=exercise_name,
            target_reps=target_reps or "8-12",
            primary_muscle=primary_muscle,
            session_lines=session_lines,
            experience=experience or "intermediate",
            weight_lbs=int(round(bodyweight_lbs or 0)),
        )
        system_msg = (
            "You are a strength coach. Pick a sensible, conservative "
            "starting weight (lb) for a first-time exercise based on "
            "the user's recent logged sessions for the same muscle. "
            "Return only the required JSON."
        )
    else:
        # No history path — brand-new user or first session on this
        # muscle group. Anchor the estimate on profile + bodyweight
        # ratios. If bodyweight is missing we can't estimate
        # meaningfully, so bail and let the deterministic default
        # take over.
        if not bodyweight_lbs or bodyweight_lbs <= 0:
            return None
        prompt = _PROMPT_TEMPLATE_NO_HISTORY.format(
            exercise_name=exercise_name,
            target_reps=target_reps or "8-12",
            primary_muscle=primary_muscle,
            sex=(sex or "unspecified"),
            age=(age if age else "unspecified"),
            weight_lbs=int(round(bodyweight_lbs)),
            experience=experience or "intermediate",
        )
        system_msg = (
            "You are a strength coach. The user has no training history "
            "for this muscle group. Use standard strength ratios by "
            "bodyweight / age / sex / experience to pick a conservative "
            "starting weight. Return only the required JSON."
        )

    messages = [
        {"role": "system", "content": system_msg},
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

    # Reason + confidence no longer requested from the AI — we return
    # just the weight. Fixed stamps are used downstream so the client
    # can still distinguish this path if it wants to style differently.
    return AIFirstTimeRecommendation(
        weight_lbs=_round_to_plate(weight, increment=2.5),
        reason="",
        confidence="low",
    )
