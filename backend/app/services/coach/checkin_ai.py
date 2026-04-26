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
4. Keep it plain English, no emojis, no filler, no 'great job', no 'keep pushing'.
5. If the recommendation is `ask_more`, state what specific data you need (don't guess).
6. If the recommendation is `small_adjust`, include a structured `delta` object (e.g. {"kcal": -100, "protein_g": 0}).
7. Rationale key: short slug summarising WHY (e.g. 'strong_week_hold', 'cardio_gap_2wk', 'bench_plateau').

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


# ─── compose_weekly_narrative ──────────────────────────────────────
#
# Richer multi-section call used by the new weekly check-in flow. The
# deterministic `compute_weekly_review` already produces structured
# numbers + recommendations; this call wraps them in a personal
# narrative the user actually wants to read.
#
# Hard rule: the AI may not invent recommendations or change action
# types. It can only rewrite titles/details for personalization,
# reorder priority, or omit recs it judges low-signal. The applyable
# action layer downstream is the safety net.

WEEKLY_NARRATIVE_SYSTEM_PROMPT = """You are a personal fitness coach delivering a weekly check-in. The user is opening the app on Sunday/Monday and wants to know how last week went and what to change. Your job is to make a deterministic data dump feel personal, earned, and clear.

INPUTS (all from a deterministic rules engine — do NOT re-interpret the math):
- `goal`: user's goal (fat_loss / muscle_gain / etc) and pace
- `metrics`: sessions_completed/planned, cardio_minutes, zone2_minutes, total_hard_sets, weight_trend (slope_lbs_per_week, direction), avg_protein_g, avg_fiber_g, days_logged, adherence_pct
- `volume_by_muscle`: per-muscle hard-set totals + status (low/in_range/high/excessive/spike)
- `recommendations`: ordered list of {key, action, title, detail, priority, area} from the rules engine. NEVER add new ones. NEVER change `action.type`. You MAY rewrite `title` and `detail` for personal framing in `rec_overrides` (keyed by rec.key).

OUTPUT — single JSON object, no prose, no code fences:
{
  "hero_summary": "<2-3 sentences. Lead with how the week actually went. Reference at least TWO specific numbers (e.g. '4/5 sessions' AND 'protein avg 142g'). No generic openers like 'Great week!'>",
  "wins": [
    { "title": "<short, specific>", "detail": "<one sentence with a number from inputs>" },
    ...up to 3
  ],
  "needs_attention": [
    { "title": "<short, specific>", "detail": "<one sentence with a number from inputs + the FIX>" },
    ...up to 3
  ],
  "rec_overrides": {
    "<rec.key>": { "title": "<personalized rewrite>", "detail": "<personalized why-it-matters, 1-2 sentences>" },
    ...one entry per rec you want to rewrite. Omit recs you'd leave as-is.
  },
  "closer": "<one sentence calibrated to whether the week was a win or a slog. NOT motivational filler — just a forward-looking line.>",
  "rationale_key": "<short slug, e.g. 'strong_consistency_hold' / 'cardio_gap_2wk' / 'protein_drift'>"
}

VOICE:
- Warm but not chummy. Direct.
- No emojis. No exclamation marks.
- Banned phrases: "great job", "keep pushing", "crush it", "every rep counts", "stay consistent", "on the right track", "let's go", "amazing work".
- Reference user's actual numbers, not adjectives.

LENGTH: hero_summary 2-3 sentences. Each win/need: title 3-5 words, detail one sentence. Closer: one sentence.

If `recommendations` is empty, return wins/needs from the metrics and an empty rec_overrides — the modal will hide the recs section."""


def compose_weekly_narrative(
    payload: dict[str, Any], model: str | None = None,
) -> dict[str, Any]:
    """Build the rich multi-section narrative the new weekly check-in
    modal renders. Heavier model than the existing `call_checkin_llm`
    because the user only sees this once a week and the polish matters.

    `payload` should contain:
      • goal: {goal_type, pace}
      • metrics: from compute_weekly_review (sessions, cardio, weight, etc)
      • volume_by_muscle: dict of {muscle: {sets, status, range}}
      • recommendations: ordered list (each must carry `key`, `action`, `title`, `detail`, `priority`, `area`)

    Returns a dict the client can render directly. Keys always present
    even on error fallback so the UI doesn't have to null-check every
    field.
    """
    api_key = get_openai_api_key()
    if not api_key:
        raise CheckinAIError("OPENAI_API_KEY not configured")

    client = OpenAI(api_key=api_key)
    model_name = model or os.getenv("MODEL_WEEKLY_CHECKIN", "gpt-5-mini")

    user_content = json.dumps(payload, default=str, separators=(",", ":"))

    try:
        resp = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": WEEKLY_NARRATIVE_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.5,
            max_tokens=1200,
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

    # Defensive defaults so the client never gets a missing field.
    parsed.setdefault("hero_summary", "")
    parsed.setdefault("wins", [])
    parsed.setdefault("needs_attention", [])
    parsed.setdefault("rec_overrides", {})
    parsed.setdefault("closer", "")
    parsed.setdefault("rationale_key", "weekly_review")

    # Hard sanitize: rec_overrides keys MUST match a rec.key from the
    # input. Drop any hallucinated keys so the AI can't conjure up
    # recommendations the apply layer doesn't know about.
    valid_keys = {r.get("key") for r in (payload.get("recommendations") or []) if isinstance(r, dict)}
    if isinstance(parsed.get("rec_overrides"), dict):
        parsed["rec_overrides"] = {
            k: v for k, v in parsed["rec_overrides"].items()
            if k in valid_keys and isinstance(v, dict)
        }
    else:
        parsed["rec_overrides"] = {}

    # Cap section sizes so a chatty model can't blow up the UI.
    if isinstance(parsed.get("wins"), list):
        parsed["wins"] = parsed["wins"][:3]
    else:
        parsed["wins"] = []
    if isinstance(parsed.get("needs_attention"), list):
        parsed["needs_attention"] = parsed["needs_attention"][:3]
    else:
        parsed["needs_attention"] = []

    parsed["_model"] = model_name
    return parsed


def fallback_weekly_narrative(payload: dict[str, Any]) -> dict[str, Any]:
    """Deterministic fallback when the AI call fails or is disabled.
    Produces the SAME shape as `compose_weekly_narrative` so the modal
    renders identically. Less personal but still useful — prefers
    showing structured numbers over an error state."""
    metrics = payload.get("metrics") or {}
    sessions = metrics.get("sessions_completed", 0)
    planned = metrics.get("sessions_planned", 0)
    cardio = metrics.get("cardio_minutes", 0)
    protein = metrics.get("avg_protein_g", 0)
    days_logged = metrics.get("days_logged", 0)

    if planned > 0 and sessions >= planned:
        hero = (f"You hit {sessions} of {planned} planned sessions and averaged "
                f"{int(protein)}g protein across {days_logged} logged days. "
                "Plan stays the course this week.")
    elif sessions > 0:
        hero = (f"{sessions} of {planned} sessions logged with {int(protein)}g "
                f"average protein. A few small changes below — pick what fits.")
    else:
        hero = ("No sessions logged this week. The plan resets this week — "
                "hit it once and the coach has something to work with.")

    return {
        "hero_summary": hero,
        "wins": [],
        "needs_attention": [],
        "rec_overrides": {},
        "closer": "Open the plan — adjustments below are ready when you are.",
        "rationale_key": "fallback",
        "_model": "fallback",
    }
