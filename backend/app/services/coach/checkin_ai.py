"""LLM call for the AI coach check-in.

Takes an assembled payload dict and returns a raw AI response dict:
    {
        "response_type": "coach_only" | "small_adjust" | "deep_review" | "leave_alone" | "ask_more",
        "message": str,             # 2–4 sentence coaching message
        "delta": {"kcal": int, "protein_g": int, ...} | None,
        "rationale_key": str | None,
    }

Deliberately dumb: this module just talks to OpenAI and parses JSON. All
safety / decision rules happen in `decision_rules.gate()` on the response.
"""
from __future__ import annotations

import json
import os
from typing import Any

from openai import OpenAI

from app.routers.ai.utils import get_openai_api_key, model_chat


SYSTEM_PROMPT = """You are a fitness check-in coach. You receive a STRUCTURED weekly evaluation from a deterministic rules engine, plus the user's self-reported state. You do NOT re-interpret the numbers — you only phrase the verdict in plain language.

Inputs you will see:
- `evaluation.adherencePct`: weighted hit-rate from the rules engine (0-100)
- `evaluation.counts`: {hit, partial, missed}
- `evaluation.commitments[]`: each with {kind, bucket, promised, actual, note}
- `evaluation.biggestWin` and `evaluation.biggestGap` (if any)
- `recommendation`: the response_type ALREADY chosen by the rules engine. Use this as-is. Do NOT override.
- `summary_history`: whether this is the user's first weekly summary and up to 3 compact prior summaries.
- `weekly_review`: deterministic trainer's read the user JUST SAW on the check-in modal. Includes:
    - `headline`: one-sentence summary already shown to the user
    - `sessions_completed / sessions_planned / cardio_minutes / zone2_minutes / total_hard_sets`
    - `muscles_low[]` and `muscles_high[]`: per-muscle volume flags
    - `weight_trend_direction`: "up" / "down" / "flat" / "unknown"
    - `avg_protein_g`, `avg_fiber_g`, `days_logged`
    - `recommendations[]`: top 5 with {key, title, priority, area, detail}

CRITICAL: the user has already seen the `weekly_review`. Do NOT re-summarise the numbers from scratch — the modal already showed them. Your job is to react to the user's self-rating in the CONTEXT of those numbers and recommendations. Reference at least one specific number from the review and at least one recommendation by short name.

Your job:
1. Write a ONE-sentence weekly summary that cites the adherence % and total hit/partial/missed counts.
2. Reinforce the biggestWin by name with its actual number.
3. Name the biggestGap with its actual number and propose one concrete adjustment.
4. If `summary_history.is_first_summary` is true, frame this as the baseline week; otherwise reference the direction versus prior summaries without over-explaining.
5. Keep it plain English, no emojis, no filler, no 'great job', no 'keep pushing'.
6. If the recommendation is `ask_more`, state what specific data you need (don't guess).
7. If the recommendation is `small_adjust`, include a structured `delta` object (e.g. {"kcal": -100, "protein_g": 0}).
8. Rationale key: short slug summarising WHY (e.g. 'strong_week_hold', 'cardio_gap_2wk', 'bench_plateau').

Rules for the adjustment delta:
- coach_only / leave_alone / ask_more → delta = null
- small_adjust → delta capped at ±100 kcal, ±20g protein
- deep_review → delta capped at ±250 kcal, ±40g protein

FORBIDDEN phrases: 'great job', 'keep pushing', 'crush it', 'every rep counts', 'stay consistent', 'on the right track' (too generic).

Also propose 1-3 concrete commitments for the next week. Each commitment is a structured goal the evaluator can grade next week. Shapes:
- Exercise load: {"kind": "<exercise>_load", "label": "bench +5 lb to 190", "target_exercise": "Barbell Bench Press", "target_weight_lbs": 190, "target_reps": 8}
- Focus count:  {"kind": "cardio_count", "label": "2 Z2 cardio sessions", "target_count": 2, "focus_contains": "cardio"}

Pick commitments that reinforce the biggestWin or close the biggestGap. Never invent exercises or focuses not already in the user's plan.

Output format: ONLY a single JSON object, no prose, no code fences. Fields:
{
  "response_type": "<the recommendation from input>",
  "message": "<3-4 sentence phrasing of the verdict — one sentence per rule above>",
  "delta": null | { "kcal": int, "protein_g": int },
  "rationale_key": "...",
  "next_commitments": [ ... 1-3 commitment objects ... ]
}
"""


class CheckinAIError(Exception):
    pass


def call_checkin_llm(payload: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    api_key = get_openai_api_key()
    if not api_key:
        raise CheckinAIError("OPENAI_API_KEY not configured")

    client = OpenAI(api_key=api_key)
    model_name = model or os.getenv("MODEL_CHECKIN", model_chat())

    user_content = json.dumps(payload, default=str, separators=(",", ":"))

    try:
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=500,
        )
    except Exception as e:
        raise CheckinAIError(f"OpenAI call failed: {e}") from e

    content = (resp.choices[0].message.content or "").strip()
    if not content:
        raise CheckinAIError("empty LLM response")
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        raise CheckinAIError(f"LLM returned non-JSON: {e}") from e

    if not isinstance(parsed, dict):
        raise CheckinAIError(f"LLM returned non-object: {type(parsed).__name__}")
    parsed.setdefault("response_type", "coach_only")
    parsed.setdefault("message", "Keep going — trends look fine.")
    parsed.setdefault("delta", None)
    parsed.setdefault("rationale_key", None)
    parsed["_model"] = model_name
    return parsed
