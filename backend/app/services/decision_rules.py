"""Decision-rule gate — section 11 of the AI check-in design.

The LLM **suggests** a response; the server **decides** whether to honor it.
This module enforces anti-overreaction rules so a hallucinated or aggressive
LLM response can never rewrite a plan without meeting structural preconditions.

Contract: `gate(ai_response, payload, db, user_id)` returns a `GateResult`
with the final `response_type`, `delta`, `rationale_key`, and a list of
`overrides` explaining any downgrades. The caller persists the final result.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.models import AIDecision


ALLOWED_RESPONSE_TYPES = {
    "coach_only",
    "small_adjust",
    "deep_review",
    "leave_alone",
    "ask_more",
}

# Hard caps — no single check-in can move these more than this at once.
MAX_SMALL_KCAL_DELTA = 100
MAX_DEEP_KCAL_DELTA = 250

# Cooldowns (days) between meaningful plan changes.
MIN_DAYS_BETWEEN_CAL_CHANGES = 14
MIN_DAYS_BETWEEN_PROGRAM_CHANGES = 21


@dataclass
class GateResult:
    response_type: str
    delta: dict[str, Any] | None
    rationale_key: str | None
    message: str
    overrides: list[str] = field(default_factory=list)


def _days_since_last_change(db: Session, user_id: int) -> int | None:
    last = db.exec(
        select(AIDecision)
        .where(
            AIDecision.user_id == user_id,
            AIDecision.response_type.in_(["small_adjust", "deep_review"]),
        )
        .order_by(AIDecision.created_at.desc())
    ).first()
    if not last:
        return None
    return (date.today() - last.created_at.date()).days


def _data_sufficiency(payload: dict[str, Any]) -> tuple[bool, str]:
    """Do we have enough data to justify ANY plan change?"""
    trends = payload.get("metrics_trends", {})
    w7 = trends.get("w7") or {}
    days_logged = w7.get("days_logged") or 0
    if days_logged < 4:
        return False, f"only {days_logged} days logged in the last week"
    return True, ""


def _clamp_delta(delta: dict[str, Any] | None, cap_kcal: int) -> tuple[dict[str, Any] | None, list[str]]:
    if not delta:
        return delta, []
    out = dict(delta)
    notes: list[str] = []
    if "kcal" in out and isinstance(out["kcal"], (int, float)):
        original = int(out["kcal"])
        clamped = max(-cap_kcal, min(cap_kcal, original))
        if clamped != original:
            notes.append(f"kcal delta clamped {original:+d} → {clamped:+d}")
            out["kcal"] = clamped
    return out, notes


def gate(
    ai_response: dict[str, Any],
    payload: dict[str, Any],
    db: Session,
    user_id: int,
) -> GateResult:
    """Validate and possibly downgrade an AI response.

    `ai_response` must have:
        response_type, message, delta (optional), rationale_key (optional)
    """
    overrides: list[str] = []
    proposed = ai_response.get("response_type", "coach_only")
    if proposed not in ALLOWED_RESPONSE_TYPES:
        overrides.append(f"unknown response_type '{proposed}' → coach_only")
        proposed = "coach_only"

    delta = ai_response.get("delta")
    rationale_key = ai_response.get("rationale_key")
    message = (ai_response.get("message") or "").strip() or "Keep going."

    flags = payload.get("flags") or []
    severities = [f.get("severity") for f in flags]
    has_med_or_high = any(s in {"med", "high"} for s in severities)
    high_count = sum(1 for s in severities if s == "high")
    med_or_high_count = sum(1 for s in severities if s in {"med", "high"})

    # Rule: ask_more / coach_only / leave_alone — no delta, passes through.
    if proposed in {"coach_only", "leave_alone", "ask_more"}:
        return GateResult(
            response_type=proposed,
            delta=None,
            rationale_key=rationale_key,
            message=message,
            overrides=overrides,
        )

    # For adjustments, we need enough data.
    ok, reason = _data_sufficiency(payload)
    if not ok:
        overrides.append(f"insufficient data ({reason}) → coach_only")
        return GateResult(
            response_type="coach_only",
            delta=None,
            rationale_key=rationale_key,
            message=message,
            overrides=overrides,
        )

    # Cooldown check.
    days_since = _days_since_last_change(db, user_id)
    if days_since is not None:
        if proposed == "small_adjust" and days_since < MIN_DAYS_BETWEEN_CAL_CHANGES and high_count == 0:
            overrides.append(
                f"cooldown: last adjust {days_since}d ago (<{MIN_DAYS_BETWEEN_CAL_CHANGES}d) → leave_alone"
            )
            return GateResult(
                response_type="leave_alone",
                delta=None,
                rationale_key=rationale_key,
                message=message,
                overrides=overrides,
            )
        if proposed == "deep_review" and days_since < MIN_DAYS_BETWEEN_PROGRAM_CHANGES and high_count == 0:
            overrides.append(
                f"cooldown: last adjust {days_since}d ago (<{MIN_DAYS_BETWEEN_PROGRAM_CHANGES}d) → small_adjust"
            )
            proposed = "small_adjust"

    # deep_review requires 2+ med/high flags unless user explicitly asked (ask_more path).
    if proposed == "deep_review" and med_or_high_count < 2 and high_count == 0:
        overrides.append(
            f"only {med_or_high_count} med/high flag(s) → downgraded to small_adjust"
        )
        proposed = "small_adjust"

    # small_adjust requires at least one med/high flag.
    if proposed == "small_adjust" and not has_med_or_high:
        overrides.append("no med/high flags → downgraded to coach_only")
        return GateResult(
            response_type="coach_only",
            delta=None,
            rationale_key=rationale_key,
            message=message,
            overrides=overrides,
        )

    # Clamp delta magnitudes.
    cap = MAX_DEEP_KCAL_DELTA if proposed == "deep_review" else MAX_SMALL_KCAL_DELTA
    delta, clamp_notes = _clamp_delta(delta, cap)
    overrides.extend(clamp_notes)

    return GateResult(
        response_type=proposed,
        delta=delta,
        rationale_key=rationale_key,
        message=message,
        overrides=overrides,
    )
