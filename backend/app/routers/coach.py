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

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import (
    AIDecision,
    CoachMemory,
    DailyRollup,
    User,
    UserFlag,
    UserRollup,
)
from app.routers.ai.models import WorkoutCoachQuestionRequest
from app.services.coach.checkin_ai import CheckinAIError, call_checkin_llm
from app.services.coach.meal_day_evaluator import (
    MealDayEvaluatorError,
    evaluate_meal_day,
)
from app.services.coach.week_evaluator import (
    WeekEvaluatorError,
    evaluate_week as evaluate_week_service,
)
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
    current_user: User = Depends(require_pro_feature("Coach actions")),
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


@router.post("/workout-question")
def ask_workout_question(
    body: WorkoutCoachQuestionRequest,
    current_user: User = Depends(require_pro_feature("In-workout coach")),
    db: Session = Depends(get_session),
):
    """Canonical namespace for the true AI in-workout coach/chat surface.

    Display-only: it may explain load/form/pain/substitution choices, but it
    never writes to the active PlanWeek. `/ai/workout-question` remains as a
    compatibility alias for already-shipped clients.
    """
    from app.routers.ai.chat import ask_workout_question as _legacy_ask_workout_question

    return _legacy_ask_workout_question(body, current_user=current_user, db=db)


@router.post("/recompute")
def recompute(
    as_of: date | None = Query(default=None, description="Defaults to today"),
    current_user: User = Depends(require_pro_feature("Coach insights")),
    db: Session = Depends(get_session),
):
    summary = recompute_user(db, current_user.id, as_of=as_of)
    flags = evaluate_flags(db, current_user.id, as_of=as_of)
    summary["active_flags"] = len(flags)
    return summary


@router.get("/rollups")
def get_rollups(
    days: int = Query(default=7, ge=1, le=35),
    current_user: User = Depends(require_pro_feature("Coach insights")),
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
                "nutrition_log_status": getattr(r, "nutrition_log_status", "unknown"),
                "nutrition_log_confidence": getattr(r, "nutrition_log_confidence", 0),
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
    current_user: User = Depends(require_pro_feature("Coach insights")),
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


@router.post("/checkin")
def post_checkin(
    body: CheckinRequest,
    current_user: User = Depends(require_pro_feature("Coach chat")),
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
                    "action": r.action,
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

    # 5. Persist only. LLM deltas are recommendations for display; user-
    # confirmed state changes route through /coach/apply-action.
    applied_adjustment: int | None = None
    decision_id: int | None = None
    if not body.dry_run:
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


@router.get("/nutrition-review")
def get_nutrition_review(
    week_start: date | None = Query(default=None, description="Monday of the week to review (defaults to current week)"),
    current_user: User = Depends(require_pro_feature("Nutrition review")),
    db: Session = Depends(get_session),
):
    """Deterministic weekly nutrition review.

    Returns planned targets vs actual intake, adherence metrics,
    meal-type breakdown, weight trend, and 3–5 coaching recommendations.

    Parallel to the workout review embedded in /coach/checkin — exposed
    as a standalone GET so the weekly nutrition card can render it
    without triggering an AI check-in."""
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    review = compute_weekly_nutrition_review(db, current_user.id, week_start=week_start)
    return review.to_dict()


@router.get("/history")
def get_history(
    limit: int = Query(default=10, ge=1, le=50),
    current_user: User = Depends(require_pro_feature("Coach history")),
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


# ─── AI evaluate-meal-day ────────────────────────────────────────────────────

class EvaluateMealDayBody(BaseModel):
    """Optional client-supplied targets — when present, the AI evaluator
    sees exactly what the user sees on /meals/adjusted-daily-target so
    coach feedback can't drift from the visible targets. When absent we
    fall back to the user's profile targets."""
    target_date: date
    targets: dict | None = None


@router.post("/evaluate-meal-day")
def evaluate_meal_day_endpoint(
    body: EvaluateMealDayBody,
    current_user: User = Depends(require_pro_feature("AI meal-day evaluation")),
    db: Session = Depends(get_session),
):
    """Pro-only AI critique of one day of logged meals. Returns a
    headline, summary, observations, and actionable suggestions. The
    response is read-only — no targets, plans, or coaching state are
    mutated. State changes still flow through /coach/apply-action."""
    try:
        result = evaluate_meal_day(
            db, current_user.id, body.target_date, targets=body.targets,
        )
    except MealDayEvaluatorError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return result


# ─── AI evaluate-week ────────────────────────────────────────────────────────

class EvaluateWeekBody(BaseModel):
    end_date: date | None = None
    days: int = Field(default=7, ge=1, le=14)


@router.post("/evaluate-week")
def evaluate_week_endpoint(
    body: EvaluateWeekBody,
    current_user: User = Depends(require_pro_feature("AI week evaluation")),
    db: Session = Depends(get_session),
):
    """Pro-only AI critique of one workout week. Reuses the deterministic
    weekly review (compute_weekly_review) for the numbers; the AI only
    phrases the verdict and picks 1-3 takeaways. Read-only — state
    changes still flow through /coach/apply-action."""
    try:
        result = evaluate_week_service(
            db, current_user.id, end_date=body.end_date, days=body.days,
        )
    except WeekEvaluatorError as e:
        raise HTTPException(status_code=502, detail=str(e))
    return result
