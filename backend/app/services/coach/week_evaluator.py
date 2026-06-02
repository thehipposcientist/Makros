"""AI evaluation of a workout week.

Used by `POST /coach/evaluate-week` — a Pro user taps "Evaluate this
week" on the weekly digest and gets an AI critique that compares
prescribed (or self-assembled) volume + adherence against their goal.

Reuses the deterministic `compute_weekly_review` (plan_review_v2) for
the heavy lifting — we never re-interpret raw completion data in the
LLM. The model only phrases the verdict, picks a few items to call
out, and proposes 1-3 concrete next-week commitments.

Output is read-only — any state mutation routes through
/coach/apply-action like every other coach action.
"""
from __future__ import annotations

import json
import os
from datetime import date as DateType, timedelta
from typing import Any

from openai import OpenAI
from sqlmodel import Session, select

from app.models import PlanDay, PlanWeek, UserPreferences
from app.routers.ai.utils import (
    _build_chat_kwargs,
    _chat_create,
    _extract_json,
    get_openai_api_key,
    model_chat,
)
from app.services.workout.plan_review_v2 import compute_weekly_review


SYSTEM_PROMPT = """You are a strength + conditioning coach evaluating ONE WEEK of a user's workouts.

You receive a deterministic structured review from the rules engine, so you do NOT re-interpret the raw numbers — your job is to phrase the verdict in plain language and pick 1-3 specific takeaways.

Inputs you will see:
- `goal`: the user's training goal (muscle_gain | fat_loss | recomp | strength | endurance | general_health | ...)
- `mode`: "auto" (planner-built week) or "manual" (user assembled the week from saved templates).
- `review`: the rolled-up structured review with sessions_completed/planned, adherence_pct, total_hard_sets, per-muscle volume, soreness, sleep, recommendations[] etc. The user has ALREADY seen most of these numbers.
- `manual_meta` (only when mode == "manual"): { assigned_days, completed_days, unassigned_days, rest_days } — manual-mode users build their own schedule, so "planned" really means "assigned".

Your job:
1. ONE-sentence headline (max 90 chars) — the verdict for the week.
2. 2-3 sentence summary citing at least one specific number (e.g. "5/6 sessions") and one structural observation (e.g. "back volume came in below target").
3. 1-3 observations: each labeled "win" / "gap" / "note", max 120 chars each. Pick the most consequential — never list everything.
4. 1-3 concrete suggestions for next week, max 100 chars each. Reference real exercises or muscle groups when the review names them.

Mode-specific rules:
- mode = "auto": you can suggest planner-level changes (add a day, drop a day, change split). Don't suggest specific template edits — those are user-only.
- mode = "manual": NEVER suggest the planner. Phrase suggestions in terms of the user's own templates ("assign your push template twice next week instead of once"). Use the existing template names if the review provides them; otherwise use focus families (Push/Pull/Legs/etc.).

Goal alignment:
- muscle_gain / strength: never push cardio as the primary lever. Frame cardio as optional recovery support.
- fat_loss / endurance: cardio + activity are real levers; can suggest adding a Z2 session if review indicates a gap.

Forbidden phrases: "great job", "keep crushing it", "you got this", "stay consistent", "on the right track" (too generic).

Output ONLY a single JSON object (no prose, no code fences):
{
  "headline": "<one-sentence verdict>",
  "summary": "<2-3 sentences>",
  "observations": [
    { "kind": "win" | "gap" | "note", "text": "<obs>" },
    ...
  ],
  "suggestions": [ "<next-week action>", ... ]
}
"""


class WeekEvaluatorError(Exception):
    pass


def _configured_week_evaluator_model(model: str | None = None) -> str:
    return model or os.getenv("MODEL_WEEK_EVALUATE") or os.getenv("MODEL_WEEKLY_CHECKIN") or model_chat()


def _manual_meta(
    db: Session, user_id: int, week_start: DateType, week_end: DateType
) -> dict[str, Any] | None:
    """Manual-mode-specific counts. Returns None when the user is on the
    auto planner (so the LLM payload omits the field entirely)."""
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    if not prefs or not getattr(prefs, "workout_manual_mode", False):
        return None
    pw = db.exec(
        select(PlanWeek)
        .where(PlanWeek.user_id == user_id)
        .where(PlanWeek.start_date <= week_end)
        .where(PlanWeek.end_date >= week_start)
        .order_by(PlanWeek.start_date.desc(), PlanWeek.id.desc())
    ).first()
    if pw is None:
        return {
            "assigned_days": 0,
            "completed_days": 0,
            "unassigned_days": 0,
            "rest_days": 0,
        }
    days = db.exec(
        select(PlanDay).where(PlanDay.plan_week_id == pw.id)
    ).all()
    counts = {
        "assigned_days": 0,
        "completed_days": 0,
        "unassigned_days": 0,
        "rest_days": 0,
    }
    for d in days:
        if d.status == "completed":
            counts["completed_days"] += 1
        if d.status == "unassigned":
            counts["unassigned_days"] += 1
        if d.is_rest:
            counts["rest_days"] += 1
        if d.workout_json and d.status not in ("unassigned",):
            counts["assigned_days"] += 1
    return counts


def build_week_payload(
    db: Session,
    user_id: int,
    *,
    end_date: DateType | None = None,
    days: int = 7,
) -> dict[str, Any]:
    """Assemble the structured input the LLM sees for one week.

    Pulls the deterministic weekly review (same one shown on the
    digest card), trims it to the fields the AI actually needs, and
    appends manual-mode metadata when applicable.
    """
    review = compute_weekly_review(db, user_id, end_date=end_date, days=days)
    review_dict = review.to_dict()
    week_start = end_date - timedelta(days=days - 1) if end_date else (date.today() - timedelta(days=days - 1))  # type: ignore  # noqa
    # Trim — the LLM doesn't need every field. Less context = faster +
    # cheaper + less drift. Volume snapshot stays flat, recommendations
    # capped to top 5 by priority.
    trimmed_recs = []
    priority_rank = {
        "warn": 0,
        "high": 0,
        "suggest": 1,
        "medium": 1,
        "info": 2,
        "low": 3,
    }
    for r in sorted(review_dict.get("recommendations", []) or [], key=lambda x: priority_rank.get(x.get("priority", "low"), 9)):
        trimmed_recs.append({
            "key": r.get("key"),
            "title": r.get("title"),
            "priority": r.get("priority"),
            "area": r.get("area"),
            "detail": (r.get("detail") or "")[:240],
        })
        if len(trimmed_recs) == 5:
            break
    trimmed_review = {
        "week_start": review_dict.get("week_start"),
        "week_end": review_dict.get("week_end"),
        "sessions_completed": review_dict.get("sessions_completed"),
        "sessions_planned": review_dict.get("sessions_planned"),
        "adherence_pct": review_dict.get("adherence_pct"),
        "cardio_minutes": review_dict.get("cardio_minutes"),
        "zone2_minutes": review_dict.get("zone2_minutes"),
        "volume": review_dict.get("volume"),
        "weight_trend_direction": review_dict.get("weight_trend_direction"),
        "avg_sleep_hours": review_dict.get("avg_sleep_hours"),
        "soreness_areas": review_dict.get("soreness_areas"),
        "plateaus": review_dict.get("plateaus"),
        "headline": review_dict.get("headline"),
        "recommendations": trimmed_recs,
    }
    manual_meta = _manual_meta(db, user_id, review.week_start, review.week_end)
    payload: dict[str, Any] = {
        "goal": review_dict.get("goal"),
        "mode": "manual" if manual_meta is not None else "auto",
        "review": trimmed_review,
    }
    if manual_meta is not None:
        payload["manual_meta"] = manual_meta
    return payload


def call_week_llm(payload: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    """Format payload, call the LLM, parse + minimally validate."""
    api_key = get_openai_api_key()
    if not api_key:
        raise WeekEvaluatorError("OPENAI_API_KEY not configured")

    client = OpenAI(api_key=api_key)
    model_name = _configured_week_evaluator_model(model)
    user_content = json.dumps(payload, default=str, separators=(",", ":"))

    try:
        kwargs = _build_chat_kwargs(
            model=model_name,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            max_tokens=450,
            timeout_secs=30,
            ai_route="/coach/evaluate-week",
            ai_budget_bucket="coach_chat",
        )
        resp = _chat_create(client, **kwargs)
    except Exception as e:
        raise WeekEvaluatorError(f"OpenAI call failed: {e}") from e

    content = (resp.choices[0].message.content or "").strip()
    if not content:
        raise WeekEvaluatorError("empty LLM response")
    try:
        parsed = _extract_json(content)
    except json.JSONDecodeError as e:
        raise WeekEvaluatorError(f"LLM returned non-JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise WeekEvaluatorError(f"LLM returned non-object: {type(parsed).__name__}")

    parsed.setdefault("headline", "Week reviewed.")
    parsed.setdefault("summary", "")
    parsed.setdefault("observations", [])
    parsed.setdefault("suggestions", [])
    if not isinstance(parsed["observations"], list):
        parsed["observations"] = []
    if not isinstance(parsed["suggestions"], list):
        parsed["suggestions"] = []
    parsed["observations"] = [o for o in parsed["observations"][:3] if isinstance(o, dict) and o.get("text")]
    parsed["suggestions"] = [s for s in parsed["suggestions"][:3] if isinstance(s, str) and s.strip()]
    parsed["_model"] = model_name
    return parsed


def evaluate_week(
    db: Session,
    user_id: int,
    *,
    end_date: DateType | None = None,
    days: int = 7,
) -> dict[str, Any]:
    """Public entry: build payload + call LLM. Empty-week short-circuit
    returns a deterministic response so we don't burn tokens on weeks
    with zero data."""
    payload = build_week_payload(db, user_id, end_date=end_date, days=days)
    review = payload.get("review", {})
    sessions_completed = int(review.get("sessions_completed") or 0)
    sessions_planned = int(review.get("sessions_planned") or 0)
    if sessions_completed == 0 and sessions_planned == 0:
        manual = payload.get("mode") == "manual"
        return {
            "headline": "Nothing to evaluate yet",
            "summary": (
                "No sessions logged or assigned this week."
                + (" Assign templates to days to see real coaching feedback." if manual else "")
            ),
            "observations": [],
            "suggestions": [
                "Assign at least 2 days this week" if manual
                else "Log your first workout — coaching kicks in once you have data.",
            ],
            "_payload": payload,
        }
    result = call_week_llm(payload)
    result["_payload"] = payload
    return result


# Late import to avoid circular import at module load (date used inside fn).
from datetime import date  # noqa: E402
