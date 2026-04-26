"""Coach router — AI check-in endpoints.

  POST /coach/recompute    → recompute rollups + flags for the authed user
  GET  /coach/rollups      → return DailyRollup (short window) + UserRollup (all windows)
  GET  /coach/flags        → return currently active UserFlag rows
  POST /coach/checkin      → submit a micro/weekly check-in, run LLM, persist AIDecision
  GET  /coach/history      → return recent AIDecisions
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import (
    AIDecision,
    CoachMemory,
    DailyRollup,
    User,
    UserCoachingState,
    UserFlag,
    UserRollup,
)
from app.services.coach.checkin_ai import CheckinAIError, call_checkin_llm
from app.services.coach.checkin_evaluator import (
    evaluate_week,
    recommend_from_evaluation,
)
from app.services.coach.decision_rules import gate
from app.services.coach.flags import evaluate_flags
from app.services.coach.payload import build_micro_payload, build_weekly_payload
from app.services.coach.rollups import recompute_user

router = APIRouter(prefix="/coach", tags=["coach"])


class CheckinFeedback(BaseModel):
    """User-reported state submitted with a check-in. All fields optional so
    the fastest possible path is 'just tap submit'."""
    energy: int | None = Field(default=None, ge=1, le=5)
    hunger: int | None = Field(default=None, ge=1, le=5)
    soreness: int | None = Field(default=None, ge=1, le=5)
    motivation: int | None = Field(default=None, ge=1, le=5)
    stress: int | None = Field(default=None, ge=1, le=5)
    sleep_self: int | None = Field(default=None, ge=1, le=5)
    schedule_issue: bool | None = None
    adherence_self: str | None = Field(default=None, pattern="^(on|mostly|off)$")
    note: str | None = Field(default=None, max_length=500)


class CheckinRequest(BaseModel):
    checkin_type: str = Field(default="micro", pattern="^(micro|weekly|manual|event)$")
    feedback: CheckinFeedback = Field(default_factory=CheckinFeedback)
    dry_run: bool = False   # if true, don't persist AIDecision or apply delta


class ApplyActionBody(BaseModel):
    """Apply a single recommendation action returned by the weekly
    review or quick-intent router. Maps to durable user state
    (UserPreferences / UserCoachingState / UserDayState) — same path
    a manual settings change would take. No ad-hoc plan mutation."""
    action: dict
    rec_key: str | None = None


@router.post("/apply-action")
def apply_recommendation_action(
    body: ApplyActionBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Translate a recommendation action into durable user state.

    Architectural rule: AI / weekly review can only do what the user
    can do via existing app UI. Applying a rec mutates the same
    settings (days/week, calorie adjustment, day-state, etc.) that the
    user can change manually — the next plan regen picks them up via
    the normal pipeline. We never mutate the active plan_json directly.
    """
    from app.services.coach.apply_action import apply_action
    result = apply_action(db, current_user.id, body.action, rec_key=body.rec_key)
    return result.to_dict()


class WeeklyCheckinNarrativeBody(BaseModel):
    """Optional Apple Health signals the client already computed.
    Forwarded to compute_weekly_review AND included in the AI payload
    so the narrative can reference RHR / HRV / sleep / weight slope
    by name instead of generic "trends look fine."""
    days: int = 7
    weight_slope_lbs_per_week: float | None = None
    avg_sleep_hours: float | None = None
    avg_resting_hr: float | None = None
    avg_steps: int | None = None
    readiness_score: int | None = None
    avg_hrv_ms: float | None = None
    vo2_max: float | None = None


@router.post("/weekly-checkin-narrative")
def get_weekly_checkin_narrative(
    body: WeeklyCheckinNarrativeBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """The big once-a-week check-in payload. Combines:

      • Deterministic weekly review (sessions, volume, weight, recs)
      • Apple Health signals (passed by the client to avoid double-fetch)
      • AI-composed narrative (gpt-5-mini): hero summary, wins, gaps,
        per-rec personalization, closer

    Hard contract: the AI may rewrite rec titles/details for personal
    framing but cannot invent recs or change action types. The
    `recommendations` field returned to the client comes from the
    deterministic engine — overrides are merged in at the title/detail
    level only. Falls back to `fallback_weekly_narrative` (deterministic
    safety net, identical shape) when the AI call fails."""
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.coach.checkin_ai import (
        compose_weekly_narrative, fallback_weekly_narrative, CheckinAIError,
    )

    review = compute_weekly_review(
        db, current_user.id,
        days=max(3, min(28, body.days)),
        weight_trend_lbs_per_week=body.weight_slope_lbs_per_week,
        avg_sleep_hours=body.avg_sleep_hours,
        avg_resting_hr=body.avg_resting_hr,
        avg_steps=body.avg_steps,
        readiness_score=body.readiness_score,
    )
    review_dict = review.to_dict()

    # Build the AI payload — review numbers + accepted-rec set + AH
    # signals the client passed. The AI sees ALL of this; the planner
    # sees a separate snapshot path.
    ai_payload = {
        "goal": review_dict.get("goal_bucket"),
        "metrics": {
            "sessions_completed": review_dict.get("sessions_completed"),
            "sessions_planned": review_dict.get("sessions_planned"),
            "cardio_minutes": review_dict.get("cardio_minutes"),
            "zone2_minutes": review_dict.get("zone2_minutes"),
            "total_hard_sets": (review_dict.get("volume") or {}).get("total_hard_sets"),
            "weight_trend": {
                "slope_lbs_per_week": body.weight_slope_lbs_per_week,
                "direction": review_dict.get("weight_trend_direction"),
            },
            "avg_protein_g": review_dict.get("avg_protein_g"),
            "avg_fiber_g": review_dict.get("avg_fiber_g"),
            "days_logged": review_dict.get("days_logged"),
            "adherence_pct": review_dict.get("adherence_pct"),
            # Apple Health signals — optional per-call.
            "avg_sleep_hours": body.avg_sleep_hours,
            "avg_resting_hr": body.avg_resting_hr,
            "avg_hrv_ms": body.avg_hrv_ms,
            "avg_steps": body.avg_steps,
            "vo2_max": body.vo2_max,
            "readiness_score": body.readiness_score,
        },
        "volume_by_muscle": (review_dict.get("volume") or {}).get("by_muscle", {}),
        "recommendations": review_dict.get("recommendations") or [],
    }

    try:
        narrative = compose_weekly_narrative(ai_payload)
        narrative_source = "ai"
    except CheckinAIError as e:
        # Network / quota / parse error — fall back to the deterministic
        # narrative so the modal always renders something useful. Log
        # the error for telemetry but never bubble it up.
        import logging
        logging.getLogger(__name__).warning(
            "weekly narrative AI fell back to deterministic: %s", e,
        )
        narrative = fallback_weekly_narrative(ai_payload)
        narrative_source = "fallback"

    # Merge AI rec_overrides into the deterministic recommendation list
    # so the client gets one unified rec array. Keys not in overrides
    # keep their deterministic title/detail.
    overrides = narrative.get("rec_overrides") or {}
    merged_recs: list[dict] = []
    for r in (review_dict.get("recommendations") or []):
        rec_copy = dict(r) if isinstance(r, dict) else r
        if isinstance(rec_copy, dict) and rec_copy.get("key") in overrides:
            ov = overrides[rec_copy["key"]]
            if isinstance(ov, dict):
                if ov.get("title"):
                    rec_copy["title"] = ov["title"]
                if ov.get("detail"):
                    rec_copy["detail"] = ov["detail"]
                rec_copy["personalized"] = True
        merged_recs.append(rec_copy)

    return {
        "headline": review_dict.get("headline"),
        "hero_summary": narrative.get("hero_summary"),
        "wins": narrative.get("wins") or [],
        "needs_attention": narrative.get("needs_attention") or [],
        "closer": narrative.get("closer"),
        "recommendations": merged_recs,
        "metrics": ai_payload["metrics"],
        "volume_by_muscle": ai_payload["volume_by_muscle"],
        "rationale_key": narrative.get("rationale_key"),
        "narrative_source": narrative_source,
    }


class _BulkActionItem(BaseModel):
    action: dict
    rec_key: str | None = None


class ApplyBulkBody(BaseModel):
    """Apply N recommendations in one call. Used by the weekly check-in
    flow so the user makes ONE decision (Apply Plan) instead of tapping
    Apply per rec. Each item runs through the same `apply_action` path,
    so all clamping + audit guarantees still hold. The aggregate
    response carries one `needs_regen` flag (true if ANY item asked for
    regen) so the caller kicks the planner exactly once."""
    items: list[_BulkActionItem]


@router.post("/apply-bulk")
def apply_bulk_recommendations(
    body: ApplyBulkBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Run multiple `apply_action` calls in sequence and aggregate
    results. Each item is independent — a single failure does not
    abort the rest, but its summary is included so the UI can surface
    partial outcomes. The bulk response is shaped for the weekly
    check-in modal:

      {
        "applied_count":   N successful applies,
        "skipped_count":   N rejected (already at cap, missing payload, etc),
        "failed_count":    N errors,
        "needs_regen":     bool (true if ANY item asked for regen),
        "results":         [ ApplyResult.to_dict() per item ],
        "summary":         "Applied N changes — plan refreshes on next open."
      }
    """
    from app.services.coach.apply_action import apply_action
    results: list[dict] = []
    applied = 0
    skipped = 0
    failed = 0
    needs_regen = False
    for item in body.items:
        try:
            r = apply_action(db, current_user.id, item.action, rec_key=item.rec_key)
            results.append(r.to_dict())
            if r.applied and r.changed_fields:
                applied += 1
                if r.needs_regen:
                    needs_regen = True
            elif r.applied:
                # applied=True but no changed_fields = no-op (already
                # at cap, snap to neutral, etc). Treat as skipped from
                # the user's POV — nothing to report as a "change."
                skipped += 1
            else:
                failed += 1
        except Exception as e:
            failed += 1
            results.append({
                "applied": False, "summary": f"Error: {e}",
                "needs_regen": False, "changed_fields": {},
                "descriptive_only": False, "error": "internal_error",
            })

    if applied == 0 and failed == 0:
        summary = f"Nothing to change — {skipped} item{'s' if skipped != 1 else ''} already at the planner's deterministic baseline."
    elif failed == 0:
        regen_msg = " Plan refreshes on next open." if needs_regen else ""
        summary = f"Applied {applied} change{'s' if applied != 1 else ''}.{regen_msg}"
    else:
        summary = f"Applied {applied}, skipped {skipped}, {failed} failed. See results."

    return {
        "applied_count": applied,
        "skipped_count": skipped,
        "failed_count": failed,
        "needs_regen": needs_regen,
        "results": results,
        "summary": summary,
    }


@router.post("/recompute")
def recompute(
    as_of: date | None = Query(default=None, description="Defaults to today"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    summary = recompute_user(db, current_user.id, as_of=as_of)
    flags = evaluate_flags(db, current_user.id, as_of=as_of)
    summary["active_flags"] = len(flags)
    return summary


@router.get("/rollups")
def get_rollups(
    days: int = Query(default=7, ge=1, le=35),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    today = date.today()
    start = today - timedelta(days=days - 1)
    daily = db.exec(
        select(DailyRollup)
        .where(
            DailyRollup.user_id == current_user.id,
            DailyRollup.day >= start,
            DailyRollup.day <= today,
        )
        .order_by(DailyRollup.day.asc())
    ).all()
    windows = db.exec(
        select(UserRollup).where(UserRollup.user_id == current_user.id)
    ).all()
    return {
        "as_of": today.isoformat(),
        "daily": [
            {
                "day": r.day.isoformat(),
                "kcal": r.kcal,
                "protein_g": r.protein_g,
                "carbs_g": r.carbs_g,
                "fat_g": r.fat_g,
                "meals_logged": r.meals_logged,
                "session_planned": r.session_planned,
                "session_completed": r.session_completed,
                "session_focus": r.session_focus,
                "session_rpe_avg": r.session_rpe_avg,
                "weight_lbs": r.weight_lbs,
                "sleep_h": r.sleep_h,
                "energy": r.energy,
            }
            for r in daily
        ],
        "windows": [
            {
                "window_days": w.window_days,
                "as_of": w.as_of.isoformat(),
                "kcal_avg": w.kcal_avg,
                "kcal_target_delta_pct": w.kcal_target_delta_pct,
                "protein_adherence_pct": w.protein_adherence_pct,
                "adherence_pct": w.adherence_pct,
                "days_logged": w.days_logged,
                "sessions_planned": w.sessions_planned,
                "sessions_completed": w.sessions_completed,
                "session_completion_pct": w.session_completion_pct,
                "weight_ema_lbs": w.weight_ema_lbs,
                "weight_slope_lbs_per_wk": w.weight_slope_lbs_per_wk,
                "sleep_avg_h": w.sleep_avg_h,
                "steps_avg": w.steps_avg,
            }
            for w in windows
        ],
    }


@router.get("/flags")
def get_flags(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    flags = db.exec(
        select(UserFlag).where(UserFlag.user_id == current_user.id)
    ).all()
    return {
        "flags": [
            {
                "key": f.key,
                "severity": f.severity,
                "value": f.value,
                "details": f.details,
                "active_since": f.active_since.isoformat(),
                "last_evaluated": f.last_evaluated.isoformat(),
            }
            for f in flags
        ]
    }


def _apply_delta(db: Session, user_id: int, delta: dict[str, Any] | None) -> int | None:
    """Apply an accepted calorie delta to UserCoachingState.

    Returns the new total coaching kcal adjustment, or None if nothing applied.
    Macro deltas aren't applied to coaching state (which only tracks kcal +
    volume); they show up via a plan regeneration downstream.
    """
    if not delta or "kcal" not in delta:
        return None
    try:
        kcal_delta = int(delta["kcal"])
    except (TypeError, ValueError):
        return None
    if kcal_delta == 0:
        return None
    state = db.exec(
        select(UserCoachingState).where(UserCoachingState.user_id == user_id)
    ).first()
    if not state:
        state = UserCoachingState(user_id=user_id)
    state.calorie_adjustment = int(state.calorie_adjustment) + kcal_delta
    state.updated_at = datetime.now(timezone.utc)
    db.add(state)
    return state.calorie_adjustment


@router.post("/checkin")
def post_checkin(
    body: CheckinRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Run a full AI check-in cycle and return the coach's response."""
    # 1. Refresh rollups + flags so the payload is current.
    recompute_user(db, current_user.id)
    evaluate_flags(db, current_user.id)

    # 2. Build payload based on check-in type.
    feedback_dict = body.feedback.model_dump(exclude_none=True)
    if body.checkin_type == "weekly":
        payload = build_weekly_payload(db, current_user.id, feedback_dict)
    else:
        payload = build_micro_payload(db, current_user.id, feedback_dict)

    # 2a. Pull the deterministic weekly review into the payload so the
    # AI sees the same data the user just saw on the modal's "Trainer's
    # Read" block. Without this the AI was flying blind to the volume,
    # cardio, and recommendations the user is reacting to. Now the
    # response can explicitly accept / soften / defer specific recs by
    # name instead of generic "great week!" filler.
    try:
        from app.services.workout.plan_review_v2 import compute_weekly_review
        review = compute_weekly_review(db, current_user.id, days=7)
        # Trim down to what the AI actually needs — full volume.by_muscle
        # is verbose and the headline + recs are the high-signal bits.
        payload["weekly_review"] = {
            "headline": review.headline,
            "goal": review.goal,
            "sessions_completed": review.sessions_completed,
            "sessions_planned": review.sessions_planned,
            "adherence_pct": review.adherence_pct,
            "cardio_minutes": review.cardio_minutes,
            "zone2_minutes": review.zone2_minutes,
            "total_hard_sets": review.volume.total_hard_sets,
            "muscles_low": review.volume.muscles_low(),
            "muscles_high": review.volume.muscles_high(),
            "weight_trend_direction": review.weight_trend_direction,
            "avg_protein_g": review.avg_protein_g,
            "avg_fiber_g": review.avg_fiber_g,
            "days_logged": review.days_logged,
            "recommendations": [
                {
                    "key": r.key,
                    "title": r.title,
                    "priority": r.priority,
                    "area": r.area,
                    "detail": r.detail,
                }
                for r in review.recommendations[:5]  # cap so prompt stays small
            ],
        }
    except Exception as e:
        # Non-fatal — checkin still works without the review payload.
        print(f"[coach/checkin] weekly_review attach failed: {e}")

    # 2b. Deterministic weekly evaluation — pulls prior commitments from
    # CoachMemory (event_type="commitment") and grades them against actual
    # logged sessions + sets this week. The AI prompt consumes this as
    # ground truth so it phrases a verdict instead of re-interpreting data.
    if body.checkin_type == "weekly":
        prior = db.exec(
            select(CoachMemory)
            .where(
                CoachMemory.user_id == current_user.id,
                CoachMemory.event_type == "commitment",
            )
            .order_by(CoachMemory.created_at.desc())
            .limit(1)
        ).first()
        prior_commitments: list[dict] = []
        if prior and isinstance(prior.details, dict):
            items = prior.details.get("items") or []
            if isinstance(items, list):
                prior_commitments = [i for i in items if isinstance(i, dict)]
        evaluation = evaluate_week(
            db=db,
            user_id=current_user.id,
            prior_commitments=prior_commitments,
        )
        recommendation = recommend_from_evaluation(evaluation)
        payload["evaluation"] = evaluation.to_dict()
        payload["recommendation"] = recommendation
        print(
            f"[coach/checkin] weekly eval: adherence={evaluation.adherence_pct:.0f}% "
            f"counts={evaluation.counts()} → recommendation={recommendation}"
        )

    # 3. Call LLM.
    try:
        ai_response = call_checkin_llm(payload)
    except CheckinAIError as e:
        raise HTTPException(status_code=503, detail=f"AI coach unavailable: {e}")

    # 4. Gate the response against decision rules.
    result = gate(ai_response, payload, db, current_user.id)

    # 5. Persist + optionally apply.
    applied_adjustment: int | None = None
    decision_id: int | None = None
    if not body.dry_run:
        if result.response_type in {"small_adjust", "deep_review"}:
            applied_adjustment = _apply_delta(db, current_user.id, result.delta)

        decision = AIDecision(
            user_id=current_user.id,
            checkin_type=body.checkin_type,
            response_type=result.response_type,
            rationale_key=result.rationale_key,
            delta=result.delta,
            flags_snapshot=payload.get("flags"),
            message=result.message,
            model=ai_response.get("_model"),
        )
        db.add(decision)
        db.add(CoachMemory(
            user_id=current_user.id,
            event_type="ai_checkin",
            summary=f"{result.response_type}: {result.rationale_key or 'n/a'}",
            details={
                "checkin_type": body.checkin_type,
                "delta": result.delta,
                "overrides": result.overrides,
                "flags": payload.get("flags"),
                "feedback": feedback_dict,
            },
        ))
        # Persist next-week commitments if the AI proposed any. The
        # evaluator will pick these up on next week's check-in. Shape:
        #   details = {"items": [{"kind": "...", "label": "...", ...}, ...]}
        if body.checkin_type == "weekly":
            next_commitments = ai_response.get("next_commitments") if isinstance(ai_response, dict) else None
            if isinstance(next_commitments, list) and next_commitments:
                clean = [c for c in next_commitments if isinstance(c, dict)]
                if clean:
                    db.add(CoachMemory(
                        user_id=current_user.id,
                        event_type="commitment",
                        summary=f"{len(clean)} commitments for week starting today",
                        details={"items": clean, "source": "ai_checkin"},
                    ))
                    print(f"[coach/checkin] persisted {len(clean)} commitments for next week")
        db.commit()
        db.refresh(decision)
        decision_id = decision.id

    return {
        "decision_id": decision_id,
        "response_type": result.response_type,
        "message": result.message,
        "delta": result.delta,
        "rationale_key": result.rationale_key,
        "overrides": result.overrides,
        "applied_kcal_adjustment_total": applied_adjustment,
        "flags": payload.get("flags"),
        "schema": payload.get("schema"),
    }


@router.get("/history")
def get_history(
    limit: int = Query(default=10, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(AIDecision)
        .where(AIDecision.user_id == current_user.id)
        .order_by(AIDecision.created_at.desc())
    ).all()
    rows = rows[:limit]
    return {
        "decisions": [
            {
                "id": r.id,
                "created_at": r.created_at.isoformat(),
                "checkin_type": r.checkin_type,
                "response_type": r.response_type,
                "rationale_key": r.rationale_key,
                "delta": r.delta,
                "message": r.message,
                "flags_snapshot": r.flags_snapshot,
                "model": r.model,
            }
            for r in rows
        ]
    }
