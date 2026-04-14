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


SYSTEM_PROMPT = """You are a fitness check-in coach. You receive a compact JSON payload summarizing a user's recent adherence, training, recovery, and self-reported state, plus prior coaching decisions.

Your job:
1. Pick exactly ONE response_type from: coach_only, small_adjust, deep_review, leave_alone, ask_more.
2. Write a short, practical coaching message (2–4 sentences, plain English, no emojis).
3. If proposing an adjustment, include a structured `delta` (e.g. {"kcal": -100}).
4. Classify your reasoning with a short `rationale_key` slug (e.g. "stall_2wk_cut", "low_protein_adherence", "on_track_encourage").

Rules of thumb:
- Default to coach_only. Most check-ins should not change the plan.
- Only propose small_adjust if there is a clear, sustained flag (>=7 days of signal).
- Only propose deep_review if multiple flags fire OR trends have been off for 2+ weeks.
- Never react to 1–2 bad days. Trust the trend data, not single-day fluctuations.
- Respect recent coaching decisions — do not contradict or immediately reverse them.
- If data is missing or contradictory, choose ask_more and say what you need.
- kcal deltas are capped to ±100 (small_adjust) or ±250 (deep_review) — don't exceed.

Output format: ONLY a single JSON object, no prose, no code fences. Fields:
{
  "response_type": "...",
  "message": "...",
  "delta": null | { "kcal": int, "protein_g": int, ... },
  "rationale_key": "..."
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
