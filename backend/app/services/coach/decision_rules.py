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
MAX_SMALL_PROTEIN_DELTA = 20
MAX_DEEP_PROTEIN_DELTA = 40

_NUTRITION_DELTA_KEYS = {"kcal", "protein_g"}
_NUTRITION_FLAG_KEYS = {
    "low_adherence_7d",
    "low_protein_7d",
    "calorie_drift_7d",
    "stalled_weight_14d",
}

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


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _nutrition_days_logged(payload: dict[str, Any]) -> int:
    trends = payload.get("metrics_trends", {})
    w7 = trends.get("w7") or {}
    return _as_int(w7.get("days_logged"), 0)


def _deterministic_recommendation(payload: dict[str, Any]) -> str | None:
    recommendation = payload.get("recommendation")
    return recommendation if recommendation in ALLOWED_RESPONSE_TYPES else None


def _weekly_review_recommendations(payload: dict[str, Any]) -> list[dict[str, Any]]:
    weekly_review = payload.get("weekly_review")
    if not isinstance(weekly_review, dict):
        return []
    recs = weekly_review.get("recommendations")
    if not isinstance(recs, list):
        return []
    return [r for r in recs if isinstance(r, dict)]


def _has_workout_review_evidence(payload: dict[str, Any]) -> bool:
    evaluation = payload.get("evaluation")
    if isinstance(evaluation, dict):
        commitments = evaluation.get("commitments")
        if isinstance(commitments, list) and commitments:
            return True
        if (
            _as_int(evaluation.get("sessionsLogged") or evaluation.get("sessions_logged")) > 0
            or _as_int(evaluation.get("sessionsPlanned") or evaluation.get("sessions_planned")) > 0
        ):
            return True

    weekly_review = payload.get("weekly_review")
    if isinstance(weekly_review, dict):
        if (
            _as_int(weekly_review.get("sessions_planned")) > 0
            or _as_int(weekly_review.get("sessions_completed")) > 0
        ):
            return True
        for rec in _weekly_review_recommendations(payload):
            if rec.get("area") in {"workout", "recovery", "cardio"}:
                return True

    return False


def _deterministic_adjustment_supported(payload: dict[str, Any]) -> bool:
    return (
        _deterministic_recommendation(payload) in {"small_adjust", "deep_review"}
        and _has_workout_review_evidence(payload)
    )


def _deep_review_supported_by_deterministic_evidence(payload: dict[str, Any]) -> bool:
    if _deterministic_recommendation(payload) != "deep_review":
        return False
    if not _has_workout_review_evidence(payload):
        return False

    evaluation = payload.get("evaluation")
    if isinstance(evaluation, dict):
        counts = evaluation.get("counts") or {}
        missed = _as_int(counts.get("missed") if isinstance(counts, dict) else 0)
        adherence = _as_float(
            evaluation.get("adherencePct")
            if evaluation.get("adherencePct") is not None
            else evaluation.get("adherence_pct"),
            100.0,
        )
        if missed >= 2 or adherence < 40.0:
            return True

    weekly_review = payload.get("weekly_review")
    if isinstance(weekly_review, dict):
        adherence = _as_float(weekly_review.get("adherence_pct"), 100.0)
        if adherence < 40.0:
            return True
        if any(
            rec.get("area") in {"workout", "recovery", "cardio"}
            and rec.get("priority") == "warn"
            for rec in _weekly_review_recommendations(payload)
        ):
            return True

    return False


def _data_sufficiency(payload: dict[str, Any]) -> tuple[bool, str]:
    """Do we have enough data to justify any adjustment response?

    Nutrition days are not the only valid evidence source: weekly
    check-ins also carry deterministic workout evaluations and plan-review
    recommendations. Those should be allowed to shape program coaching even
    when the user has not logged enough meals for a macro change.
    """
    days_logged = _nutrition_days_logged(payload)
    if days_logged >= 4:
        return True, ""
    if _has_workout_review_evidence(payload):
        return True, ""
    return False, f"only {days_logged} nutrition day(s) logged and no weekly workout evidence"


def _nutrition_delta_supported(payload: dict[str, Any]) -> bool:
    if _nutrition_days_logged(payload) >= 4:
        return True

    flags = payload.get("flags") or []
    for flag in flags:
        if not isinstance(flag, dict):
            continue
        if flag.get("key") in _NUTRITION_FLAG_KEYS and flag.get("severity") in {"med", "high"}:
            return True

    weekly_review = payload.get("weekly_review")
    if isinstance(weekly_review, dict):
        if _as_int(weekly_review.get("days_logged")) >= 3:
            return True
        for rec in _weekly_review_recommendations(payload):
            if rec.get("area") == "nutrition" and rec.get("priority") in {"suggest", "warn"}:
                return True

    return False


def _strip_unsupported_nutrition_delta(
    delta: dict[str, Any] | None,
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str]]:
    if not delta or _nutrition_delta_supported(payload):
        return delta, []

    out = dict(delta)
    stripped = [key for key in _NUTRITION_DELTA_KEYS if key in out]
    for key in stripped:
        out.pop(key, None)
    if not stripped:
        return delta, []
    return (
        out or None,
        [f"nutrition delta removed; only {_nutrition_days_logged(payload)} nutrition day(s) logged"],
    )


def _clamp_delta(
    delta: dict[str, Any] | None,
    *,
    cap_kcal: int,
    cap_protein_g: int,
) -> tuple[dict[str, Any] | None, list[str]]:
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
    if "protein_g" in out and isinstance(out["protein_g"], (int, float)):
        original = int(out["protein_g"])
        clamped = max(-cap_protein_g, min(cap_protein_g, original))
        if clamped != original:
            notes.append(f"protein delta clamped {original:+d}g → {clamped:+d}g")
            out["protein_g"] = clamped
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

    deterministic = _deterministic_recommendation(payload)
    if deterministic and deterministic != proposed:
        overrides.append(f"deterministic recommendation '{deterministic}' overrode AI response_type '{proposed}'")
        proposed = deterministic

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

    deterministic_adjustment = _deterministic_adjustment_supported(payload)

    # deep_review requires 2+ med/high flags unless deterministic weekly
    # review evidence already supports the same response.
    if proposed == "deep_review" and med_or_high_count < 2 and high_count == 0:
        if _deep_review_supported_by_deterministic_evidence(payload):
            overrides.append("deep_review allowed by deterministic weekly evaluation")
        else:
            overrides.append(
                f"only {med_or_high_count} med/high flag(s) → downgraded to small_adjust"
            )
            proposed = "small_adjust"

    # small_adjust requires at least one med/high flag.
    if proposed == "small_adjust" and not has_med_or_high:
        if deterministic_adjustment:
            overrides.append("small_adjust allowed by deterministic weekly evaluation")
        else:
            overrides.append("no med/high flags → downgraded to coach_only")
            return GateResult(
                response_type="coach_only",
                delta=None,
                rationale_key=rationale_key,
                message=message,
                overrides=overrides,
            )

    delta, strip_notes = _strip_unsupported_nutrition_delta(delta, payload)
    overrides.extend(strip_notes)

    # Clamp delta magnitudes.
    cap_kcal = MAX_DEEP_KCAL_DELTA if proposed == "deep_review" else MAX_SMALL_KCAL_DELTA
    cap_protein = MAX_DEEP_PROTEIN_DELTA if proposed == "deep_review" else MAX_SMALL_PROTEIN_DELTA
    delta, clamp_notes = _clamp_delta(delta, cap_kcal=cap_kcal, cap_protein_g=cap_protein)
    overrides.extend(clamp_notes)

    return GateResult(
        response_type=proposed,
        delta=delta,
        rationale_key=rationale_key,
        message=message,
        overrides=overrides,
    )
