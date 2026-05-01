"""Weekly plan endpoints.

New model: one committed 7-day plan per user, date-stamped days,
individually lockable. Replaces the cycling-array model for new clients.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.models import PlanWeek, PlanDay, User
from app.routers.auth import get_current_user
from app.services.workout.week_manager import (
    get_active_week,
    get_week_days,
    create_plan_week,
    lock_day,
    complete_day,
    skip_day,
    unskip_day,
    start_day,
    patch_day_workout,
    patch_day_nutrition,
    adapt_remaining_days,
    regenerate_remaining_days,
    lock_day_on_complete,
    week_needs_renewal,
    default_training_pattern,
    auto_renew_week,
)
from app.services.workout.goals import effective_goal_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/plans", tags=["plan-weeks"])


def _active_injury_tokens(profile: object | None, prefs: object | None) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    for source in (getattr(profile, "injuries", None), getattr(prefs, "injuries", None)):
        if isinstance(source, str):
            values = [source]
        elif isinstance(source, list):
            values = source
        else:
            values = []
        for raw in values:
            token = str(raw or "").strip()
            if not token:
                continue
            key = token.lower()
            if key in seen:
                continue
            seen.add(key)
            tokens.append(token)
    return tokens


# ─── Request / Response schemas ───────────────────────────────────────────────


class PlanDayResponse(BaseModel):
    day_date: str
    day_index: int
    status: str
    is_rest: bool
    locked: bool
    lock_reason: str | None = None
    skip_reason: str | None = None
    workout: dict | None = None
    nutrition: dict | None = None
    generation_source: str = "initial"


class PlanWeekResponse(BaseModel):
    id: int
    start_date: str
    end_date: str
    status: str
    needs_new_week: bool
    planner_version: str
    goal: str
    days_per_week: int
    preferred_split: str | None = None
    paused_until: str | None = None
    pause_reason: str | None = None
    days: list[PlanDayResponse]


class AutoRenewResponse(BaseModel):
    plan_week: PlanWeekResponse
    review_headline: str
    review_summary: dict
    auto_applied: list[dict]
    needs_review: list[dict]
    explanation: str


class CheckinRequiredResponse(BaseModel):
    """Returned by auto-renew when a check-in must be completed first."""
    checkin_required: bool = True
    plan_week_id: int
    week_start: str
    week_end: str


class PlanWeekCheckinSubmitRequest(BaseModel):
    energy: int | None = None
    hunger: int | None = None
    soreness: int | None = None
    motivation: int | None = None
    schedule_issue: bool = False
    note: str | None = None
    overall_difficulty: str | None = None
    biggest_blocker: str | None = None
    pain_area: str | None = None
    goal_q4: str | None = None


class StartNewWeekRequest(BaseModel):
    force: bool = False
    cycle_phase: str | None = None
    day_of_cycle: int | None = None


class WeekCheckinAnswersRequest(BaseModel):
    overall_difficulty: str | None = None
    biggest_blocker: str | None = None
    pain_area: str | None = None
    goal_q4: str | None = None
    user_decision: str = "apply_recommendations"
    # Optional health signals from the client
    weight_slope_lbs_per_week: float | None = None
    avg_sleep_hours: float | None = None
    avg_resting_hr: float | None = None
    avg_steps: float | None = None
    readiness_score: int | None = None


class PatchDayWorkoutRequest(BaseModel):
    workout_json: dict


class PatchDayNutritionRequest(BaseModel):
    nutrition_json: dict


class SkipDayRequest(BaseModel):
    reason: str | None = None


class AdaptRemainingRequest(BaseModel):
    reason: str = "fatigue_adapt"


class RegenerateRemainingRequest(BaseModel):
    new_days_per_week: int | None = None
    new_preferred_split: str | None = None
    reason: str = "settings_change"


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _plan_day_to_response(pd: PlanDay) -> PlanDayResponse:
    return PlanDayResponse(
        day_date=pd.day_date.isoformat(),
        day_index=pd.day_index,
        status=pd.status,
        is_rest=pd.is_rest,
        locked=pd.locked,
        lock_reason=pd.lock_reason,
        skip_reason=getattr(pd, "skip_reason", None),
        workout=pd.workout_json,
        nutrition=pd.nutrition_json,
        generation_source=pd.generation_source,
    )


def _plan_week_to_response(pw: PlanWeek, days: list[PlanDay]) -> PlanWeekResponse:
    paused_until = getattr(pw, "paused_until", None)
    # Past pauses auto-expire — don't surface a stale paused_until that's
    # already in the rear-view mirror.
    paused_until_str = paused_until.isoformat() if paused_until and paused_until >= date.today() else None
    return PlanWeekResponse(
        id=pw.id,
        start_date=pw.start_date.isoformat(),
        end_date=pw.end_date.isoformat(),
        status=pw.status,
        needs_new_week=False if paused_until_str else week_needs_renewal(pw),
        planner_version=pw.planner_version,
        goal=pw.goal,
        days_per_week=pw.days_per_week,
        preferred_split=pw.preferred_split,
        paused_until=paused_until_str,
        pause_reason=getattr(pw, "pause_reason", None) if paused_until_str else None,
        days=[_plan_day_to_response(d) for d in days],
    )


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/week/active")
def get_active_plan_week(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse | None:
    """Return the active PlanWeek with all 7 PlanDay rows.

    If no PlanWeek exists but a legacy WorkoutPlan does, returns None
    (client should call start-new-week or wait for the backfill).
    """
    pw = get_active_week(db, current_user.id)
    if not pw:
        return None
    days = get_week_days(db, pw.id)
    # Auto-skip past planned workouts that never got logged. Cheap sweep —
    # one IN-clause query for sessions, one UPDATE per stale day. Keeps
    # the UI honest (calendar dots, streak, weekly review) without
    # requiring the user to manually mark every missed day.
    # Suppressed while the plan is paused (travel / illness) — we don't
    # want the user's streak silently demolished by a known-off window.
    if not _is_plan_paused(pw) and _auto_skip_unlogged_past_days(db, current_user.id, days):
        days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)


def _is_plan_paused(pw: PlanWeek) -> bool:
    """True when `paused_until` is set to a future date. Past pauses are
    treated as expired automatically (no need to clear the column)."""
    pu = getattr(pw, "paused_until", None)
    return pu is not None and pu >= date.today()


def _auto_skip_unlogged_past_days(
    db: Session, user_id: int, days: list[PlanDay]
) -> bool:
    """Mark past planned workout days as skipped when no session was logged.

    Fires on every active-week fetch so users don't accumulate dangling
    'planned' rows once a day passes. Conservative — only touches days that
    are unambiguously "the user did nothing":

      - day_date strictly before today (today stays fresh until tomorrow)
      - status == 'planned' (already-locked / completed / started / edited
        / manually-skipped days are left alone)
      - is_rest == False (rest days don't need skipping — they're rest)
      - No WorkoutSession exists on that date (any session counts as
        engagement, even a started-but-not-completed one)

    Lock reason is 'auto_skip_unlogged' so we can distinguish from manual
    skips later (e.g. for an "undo auto-skip" CTA). Returns True if any row
    was updated, so the caller can re-read the days list.
    """
    from app.models import WorkoutSession
    from sqlmodel import col

    today = date.today()
    candidates = [
        d for d in days
        if d.day_date < today
        and d.status == "planned"
        and not d.is_rest
        and not d.locked
    ]
    if not candidates:
        return False

    candidate_dates = [d.day_date for d in candidates]
    logged_rows = db.exec(
        select(WorkoutSession.workout_date).where(
            WorkoutSession.user_id == user_id,
            col(WorkoutSession.workout_date).in_(candidate_dates),
        )
    ).all()
    logged_dates = {row for row in logged_rows}

    now = datetime.now(timezone.utc)
    changed = False
    for d in candidates:
        if d.day_date in logged_dates:
            continue
        d.status = "skipped"
        d.locked = True
        d.locked_at = now
        d.lock_reason = "auto_skip_unlogged"
        d.updated_at = now
        db.add(d)
        changed = True
    if changed:
        db.commit()
    return changed


# ─── Plan pause (travel / illness) ───────────────────────────────────────────


class PausePlanRequest(BaseModel):
    """Resume date — defaults to a 7-day pause if omitted. Reason is free-form
    but the UI typically sends one of: 'travel' / 'illness' / 'other'."""
    paused_until: date | None = None
    reason: str | None = None


@router.post("/week/pause")
def pause_active_week(
    body: PausePlanRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Pause the active plan until a future date.

    While paused, auto-renew, auto-skip-unlogged, and reminder scheduling
    all suspend so the user's streak + adherence metrics don't degrade
    over a known-off window. Resume is a separate endpoint so the user
    can come back early without arithmetic.
    """
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan to pause")
    target = body.paused_until or (date.today() + timedelta(days=7))
    if target <= date.today():
        raise HTTPException(status_code=400, detail="paused_until must be in the future")
    pw.paused_until = target
    pw.paused_at = datetime.now(timezone.utc)
    pw.pause_reason = (body.reason or "other").strip() or "other"
    db.add(pw)
    db.commit()
    db.refresh(pw)
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)


@router.post("/week/resume")
def resume_active_week(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """End the pause early. Auto-renew, auto-skip, and reminders resume on
    the next active-week fetch."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan")
    pw.paused_until = None
    pw.paused_at = None
    pw.pause_reason = None
    db.add(pw)
    db.commit()
    db.refresh(pw)
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)


@router.post("/start-new-week")
def start_new_week(
    body: StartNewWeekRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Explicit user action: generate a fresh 7-day plan starting today.

    Runs the existing deterministic planner + nutrition assembler, then
    stamps dates and persists into plan_weeks + plan_days.
    """
    from app.services.workout.weekly_recipe import PLANNER_VERSION
    from app.models import UserProfile, UserPreferences, NutritionPlan, WorkoutPlan
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        most_recent_completed_focus,
        build_history_familiarity,
        recent_exercise_slugs_by_muscle,
    )
    from app.services.workout.activity_impact import compute_rolling_fatigue
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.routers.ai.plans import _resolve_owned_equipment_slugs
    from app.seed_exercises_data import SEED_EXERCISES
    import json

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()

    if not profile:
        raise HTTPException(status_code=400, detail="No profile found — complete onboarding first")

    from app.models import UserGoal
    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == current_user.id,
            UserGoal.is_active == True,
        )
    ).first()
    goal = effective_goal_id(active_goal)
    goal_pace = active_goal.pace.value if active_goal and active_goal.pace else None
    days_per_week = int(getattr(prefs, "days_per_week", None) or getattr(profile, "days_per_week", 4) or 4)
    session_minutes = int(getattr(prefs, "workout_duration_minutes", None) or getattr(profile, "workout_duration_minutes", 45) or 45)
    experience = str(getattr(profile, "experience_level", "intermediate") or "intermediate")
    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    preferred_split = getattr(prefs, "preferred_split", None) or getattr(profile, "preferred_split", None)
    injuries = _active_injury_tokens(profile, prefs)
    disliked = list(getattr(prefs, "disliked_exercises", []) or [])

    owned_slugs = _resolve_owned_equipment_slugs(equipment)

    recent_focus_buckets: tuple = ()
    recent_focus_families: tuple = ()
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass

    muscle_fatigue = None
    try:
        completions = get_recent_completions_for_fatigue(current_user.id, db)
        if completions:
            snapshot = compute_rolling_fatigue(completions)
            muscle_fatigue = snapshot.muscle_fatigue.to_dict() if snapshot else None
    except Exception:
        pass

    try:
        history_familiarity = build_history_familiarity(current_user.id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(current_user.id, db)
    except Exception:
        recent_muscle_exercises = {}

    inputs = PlannerInputs(
        goal=goal,
        days_per_week=days_per_week,
        session_minutes=session_minutes,
        experience=experience.lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=preferred_split,
        injuries=tuple(injuries),
        disliked_exercises=tuple(disliked),
        rng_seed=current_user.id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=muscle_fatigue,
        cycle_phase=body.cycle_phase,
        day_of_cycle=body.day_of_cycle,
        load_equipment_settings=getattr(prefs, "equipment_settings", None),
    )

    plan = generate_workout_plan(
        inputs, SEED_EXERCISES,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )
    workout_days = plan.get("workout_plan", {}).get("days", [])
    if not workout_days:
        raise HTTPException(status_code=500, detail="Planner produced no days")

    # Load nutrition templates from active NutritionPlan
    nutrition_templates = []
    try:
        np_row = db.exec(
            select(NutritionPlan).where(
                NutritionPlan.user_id == current_user.id,
                NutritionPlan.is_active == True,
            )
        ).first()
        if np_row and np_row.plans_json:
            nutrition_templates = json.loads(np_row.plans_json) if isinstance(np_row.plans_json, str) else np_row.plans_json
    except Exception:
        pass

    today = date.today()
    # Anchor the week on the most recent Monday so the front-page schedule
    # is a stable Mon-Sun calendar week. This keeps yesterday's completed
    # workout visible (still inside the active week) and lines auto-renewal
    # up with the natural week boundary instead of a rolling 7-day window
    # that drifts every time the user reinstalls.
    weekday = today.weekday()  # Mon=0 .. Sun=6
    from datetime import timedelta
    week_start = today - timedelta(days=weekday)
    training_pattern = default_training_pattern(days_per_week)

    pw = create_plan_week(
        db,
        current_user.id,
        start_date=week_start,
        workout_days=workout_days,
        nutrition_templates=nutrition_templates,
        training_day_pattern=training_pattern,
        goal=goal,
        days_per_week=days_per_week,
        preferred_split=preferred_split,
        planner_version=PLANNER_VERSION,
        goal_pace=goal_pace,
        session_minutes=session_minutes,
    )

    days = get_week_days(db, pw.id)
    logger.info(f"[plan-week] started new week for user={current_user.id} start={week_start} (today={today}, weekday={weekday})")
    return _plan_week_to_response(pw, days)


@router.post("/week/auto-renew")
def auto_renew(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
    weight_slope_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_steps: float | None = None,
    readiness_score: int | None = None,
    cycle_phase: str | None = None,
    day_of_cycle: int | None = None,
) -> AutoRenewResponse | CheckinRequiredResponse:
    """Auto-generate a new week when the active plan has expired.

    If the expired week has no completed or skipped check-in, returns
    CheckinRequiredResponse instead of renewing. The client should surface
    the weekly check-in prompt before calling auto-renew again.
    """
    from app.models import PlanWeekCheckin

    pw = get_active_week(db, current_user.id)
    # Suspended pause window: auto-renew refuses to fire so the user's
    # streak isn't quietly closed out by a no-op week boundary.
    if pw and _is_plan_paused(pw):
        days = get_week_days(db, pw.id)
        return AutoRenewResponse(
            plan_week=_plan_week_to_response(pw, days),
            review_headline=f"Plan paused until {pw.paused_until.isoformat()}.",
            review_summary={},
            auto_applied=[],
            needs_review=[],
            explanation="Auto-renew is suspended while your plan is paused. Resume from Settings when you're ready.",
        )
    if pw and not week_needs_renewal(pw):
        days = get_week_days(db, pw.id)
        return AutoRenewResponse(
            plan_week=_plan_week_to_response(pw, days),
            review_headline="Week is still active — no renewal needed.",
            review_summary={},
            auto_applied=[],
            needs_review=[],
            explanation="Your current week is still active.",
        )

    # Gate renewal: if the expired week has no check-in (or a pending one),
    # prompt the user to complete or skip before generating the next week.
    if pw:
        checkin = db.exec(
            select(PlanWeekCheckin).where(
                PlanWeekCheckin.user_id == current_user.id,
                PlanWeekCheckin.plan_week_id == pw.id,
            )
        ).first()
        if not checkin or (not checkin.submitted_at and not checkin.skipped):
            return CheckinRequiredResponse(
                checkin_required=True,
                plan_week_id=pw.id,
                week_start=pw.start_date.isoformat(),
                week_end=pw.end_date.isoformat(),
            )

    result = auto_renew_week(
        db, current_user.id,
        weight_trend_lbs_per_week=weight_slope_lbs_per_week,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        avg_steps=avg_steps,
        readiness_score=readiness_score,
        cycle_phase=cycle_phase,
        day_of_cycle=day_of_cycle,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    new_pw = get_active_week(db, current_user.id)
    days = get_week_days(db, new_pw.id) if new_pw else []

    return AutoRenewResponse(
        plan_week=_plan_week_to_response(new_pw, days) if new_pw else None,
        review_headline=result.get("review_headline", ""),
        review_summary=result.get("review_summary", {}),
        auto_applied=result.get("auto_applied", []),
        needs_review=result.get("needs_review", []),
        explanation=result.get("explanation", ""),
    )


@router.get("/week/checkin-status")
def get_checkin_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return whether a coaching check-in is pending, completed, or not due.

    status:
      "pending"   — expired week exists, no check-in submitted or skipped
      "completed" — check-in was submitted for this week
      "skipped"   — user explicitly skipped
      "none"      — no expired week / week still active
    """
    from app.models import PlanWeekCheckin

    pw = get_active_week(db, current_user.id)
    if not pw or not week_needs_renewal(pw):
        return {"status": "none", "checkin": None, "week_start": None, "week_end": None, "plan_week_id": None}

    checkin = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == current_user.id,
            PlanWeekCheckin.plan_week_id == pw.id,
        )
    ).first()

    status = "pending"
    if checkin and checkin.skipped:
        status = "skipped"
    elif checkin and checkin.submitted_at:
        status = "completed"

    return {
        "status": status,
        "checkin": _checkin_to_dict(checkin) if checkin else None,
        "week_start": pw.start_date.isoformat(),
        "week_end": pw.end_date.isoformat(),
        "plan_week_id": pw.id,
    }


@router.get("/week/{plan_week_id}/checkin")
def get_plan_week_checkin(
    plan_week_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return the saved check-in record for a plan week (read-only recap)."""
    from app.models import PlanWeekCheckin

    checkin = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == current_user.id,
            PlanWeekCheckin.plan_week_id == plan_week_id,
        )
    ).first()
    if not checkin:
        raise HTTPException(status_code=404, detail="No check-in found for this plan week")
    return _checkin_to_dict(checkin)


@router.post("/week/{plan_week_id}/checkin")
def submit_plan_week_checkin(
    plan_week_id: int,
    body: PlanWeekCheckinSubmitRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Submit the one-time coaching check-in for a plan week.

    Calls the AI once, saves the result, and returns the full recap.
    Returns HTTP 409 if a completed check-in already exists.
    """
    from app.models import PlanWeekCheckin, AIDecision, CoachMemory, UserProfile
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.coach.checkin_ai import call_checkin_llm, CheckinAIError
    from app.services.coach.decision_rules import gate
    from app.services.coach.payload import build_weekly_payload
    from app.services.coach.checkin_evaluator import evaluate_week, recommend_from_evaluation
    import json

    # Idempotency guard — one submission per PlanWeek
    existing = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == current_user.id,
            PlanWeekCheckin.plan_week_id == plan_week_id,
            PlanWeekCheckin.submitted_at.isnot(None),
        )
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail="Check-in already submitted for this plan week")

    pw = db.exec(
        select(PlanWeek).where(
            PlanWeek.id == plan_week_id,
            PlanWeek.user_id == current_user.id,
        )
    ).first()
    if not pw:
        raise HTTPException(status_code=404, detail="Plan week not found")

    # Deterministic review
    try:
        review = compute_weekly_review(db, current_user.id)
    except Exception as e:
        logger.warning(f"[week-checkin] compute_weekly_review failed: {e}")
        raise HTTPException(status_code=500, detail="Could not compute weekly review")

    review_snapshot = {
        "headline": review.headline,
        "goal": review.goal,
        "sessions_completed": review.sessions_completed,
        "sessions_planned": review.sessions_planned,
        "adherence_pct": review.adherence_pct,
        "cardio_minutes": review.cardio_minutes,
        "zone2_minutes": review.zone2_minutes,
        "total_hard_sets": review.volume.total_hard_sets,
        "avg_protein_g": review.avg_protein_g,
        "days_logged": review.days_logged,
        "weight_trend_direction": review.weight_trend_direction,
    }

    # Build AI payload
    feedback_dict = {}
    if body.energy is not None:
        feedback_dict["energy"] = body.energy
    if body.hunger is not None:
        feedback_dict["hunger"] = body.hunger
    if body.soreness is not None:
        feedback_dict["soreness"] = body.soreness
    if body.motivation is not None:
        feedback_dict["motivation"] = body.motivation
    if body.schedule_issue:
        feedback_dict["schedule_issue"] = True
    if body.note:
        feedback_dict["note"] = body.note
    structured_feedback = {}
    if body.overall_difficulty:
        structured_feedback["overall_difficulty"] = body.overall_difficulty
    if body.biggest_blocker:
        structured_feedback["biggest_blocker"] = body.biggest_blocker
    if body.pain_area:
        structured_feedback["pain_area"] = body.pain_area
    if body.goal_q4:
        structured_feedback["goal_q4"] = body.goal_q4
    if structured_feedback:
        feedback_dict["structured_weekly_answers"] = structured_feedback

    structured_adjustment = None
    structured_applied: list[dict] = []
    if structured_feedback:
        try:
            from app.models import UserCoachingState, UserPreferences
            from app.services.coach.apply_action import apply_action
            from app.services.workout.week_checkin_logic import (
                WeeklyCheckinAnswers,
                compute_checkin_summary_from_review,
                compute_checkin_recommendations,
            )

            summary = compute_checkin_summary_from_review(review)
            answers = WeeklyCheckinAnswers(
                overall_difficulty=body.overall_difficulty,
                biggest_blocker=body.biggest_blocker,
                pain_area=body.pain_area,
                goal_q4=body.goal_q4,
                user_decision="apply_recommendations",
            )
            goal_for_adjustment = str(getattr(review, "goal", None) or pw.goal or "body_recomp")
            adj = compute_checkin_recommendations(summary, answers, goal_for_adjustment)
            structured_adjustment = adj.to_dict()

            if adj.volume_adjustment_pct != 0:
                coaching = db.exec(
                    select(UserCoachingState).where(UserCoachingState.user_id == current_user.id)
                ).first()
                if not coaching:
                    coaching = UserCoachingState(user_id=current_user.id)
                coaching.volume_adjustment_pct = max(-30, min(15, adj.volume_adjustment_pct))
                coaching.updated_at = datetime.now(timezone.utc)
                db.add(coaching)
                structured_applied.append({
                    "type": "volume_adjustment",
                    "summary": f"Volume {coaching.volume_adjustment_pct:+d}% next week",
                })

            for action in adj.action_list:
                if action.get("type") in ("noop", "descriptive_only"):
                    continue
                result = apply_action(db, current_user.id, action)
                if result.applied:
                    structured_applied.append({
                        "type": action.get("type"),
                        "summary": result.summary,
                        "needs_regen": result.needs_regen,
                    })

            if body.pain_area and body.pain_area != "none":
                prefs = db.exec(
                    select(UserPreferences).where(UserPreferences.user_id == current_user.id)
                ).first()
                if not prefs:
                    prefs = UserPreferences(user_id=current_user.id)
                existing = list(getattr(prefs, "injuries", []) or [])
                existing_keys = {str(x).lower() for x in existing}
                if body.pain_area.lower() not in existing_keys:
                    existing.append(body.pain_area)
                    prefs.injuries = existing
                    prefs.updated_at = datetime.now(timezone.utc)
                    db.add(prefs)
                    structured_applied.append({
                        "type": "injury_flag",
                        "summary": f"Flagged {body.pain_area} for next week's planner.",
                    })
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="injury_flag",
                    summary=f"Weekly check-in pain area: {body.pain_area}",
                    details={"plan_week_id": plan_week_id, "pain_area": body.pain_area},
                ))

            if adj.preferred_cardio_modes:
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="preferred_cardio_mode",
                    summary=f"User prefers: {', '.join(adj.preferred_cardio_modes)}",
                    details={"modes": adj.preferred_cardio_modes, "source": "plan_week_checkin"},
                ))
            if adj.muscle_priorities:
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="muscle_priority",
                    summary=f"Prioritize: {', '.join(adj.muscle_priorities)}",
                    details={"muscles": adj.muscle_priorities, "source": "plan_week_checkin"},
                ))
            db.commit()
        except Exception as e:
            logger.warning(f"[week-checkin] structured adjustment failed: {e}")

    if structured_feedback:
        review_snapshot["structured_checkin"] = structured_feedback
    if structured_adjustment:
        review_snapshot["structured_adjustment"] = structured_adjustment
    if structured_applied:
        review_snapshot["structured_applied"] = structured_applied

    try:
        payload = build_weekly_payload(db, current_user.id, feedback_dict)
    except Exception as e:
        logger.warning(f"[week-checkin] build_weekly_payload failed: {e}")
        payload = {"checkin_type": "weekly", "feedback": feedback_dict}

    # Attach deterministic review so AI responds to what user saw
    payload["weekly_review"] = {
        **review_snapshot,
        "muscles_low": review.volume.muscles_low() if hasattr(review.volume, "muscles_low") else [],
        "muscles_high": review.volume.muscles_high() if hasattr(review.volume, "muscles_high") else [],
        "recommendations": [
            {"key": r.key, "title": r.title, "priority": r.priority, "area": r.area, "detail": r.detail}
            for r in review.recommendations[:5]
        ],
    }

    # Deterministic evaluation of prior commitments
    try:
        prior = db.exec(
            select(CoachMemory)
            .where(
                CoachMemory.user_id == current_user.id,
                CoachMemory.event_type == "commitment",
            )
            .order_by(CoachMemory.created_at.desc())
            .limit(1)
        ).first()
        prior_commitments = []
        if prior and isinstance(prior.details, dict):
            items = prior.details.get("items") or []
            prior_commitments = [i for i in items if isinstance(i, dict)]
        evaluation = evaluate_week(db=db, user_id=current_user.id, prior_commitments=prior_commitments)
        recommendation = recommend_from_evaluation(evaluation)
        payload["evaluation"] = evaluation.to_dict()
        payload["recommendation"] = recommendation
    except Exception as e:
        logger.warning(f"[week-checkin] evaluation failed: {e}")

    # AI call (non-fatal — fall back to headline if it fails)
    ai_message = review.headline
    ai_delta = None
    ai_decision_id = None
    commitments = []

    try:
        raw = call_checkin_llm(payload)
        result = gate(raw, payload, db, current_user.id)
        ai_message = result.message or review.headline
        ai_delta = result.delta

        # Persist AIDecision
        decision = AIDecision(
            user_id=current_user.id,
            checkin_type="weekly",
            response_type=result.response_type,
            rationale_key=result.rationale_key,
            delta=result.delta,
            message=result.message,
            model=raw.get("_model"),
        )
        db.add(decision)
        db.flush()
        ai_decision_id = decision.id

        # Apply delta if warranted
        if result.response_type in ("small_adjust", "deep_review") and result.delta:
            from app.routers.coach import _apply_delta
            _apply_delta(db, current_user.id, result.delta)

        # Save commitments for next week's grading
        next_commitments = raw.get("next_commitments") if isinstance(raw, dict) else None
        if isinstance(next_commitments, list):
            commitments = [c for c in next_commitments if isinstance(c, dict)]
            if commitments:
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="commitment",
                    summary=f"{len(commitments)} commitments for next week",
                    details={"items": commitments, "source": "plan_week_checkin"},
                ))

        db.add(CoachMemory(
            user_id=current_user.id,
            event_type="ai_checkin",
            summary=f"weekly plan_week_id={plan_week_id}: {result.response_type}",
            details={"plan_week_id": plan_week_id, "delta": result.delta, "feedback": feedback_dict},
        ))

    except CheckinAIError as e:
        logger.warning(f"[week-checkin] AI call failed (using fallback): {e}")
    except Exception as e:
        logger.warning(f"[week-checkin] AI processing failed (using fallback): {e}")

    # Upsert the PlanWeekCheckin record
    checkin_row = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == current_user.id,
            PlanWeekCheckin.plan_week_id == plan_week_id,
        )
    ).first()
    if not checkin_row:
        checkin_row = PlanWeekCheckin(
            user_id=current_user.id,
            plan_week_id=plan_week_id,
            week_start_date=pw.start_date,
            week_end_date=pw.end_date,
        )
        db.add(checkin_row)

    checkin_row.submitted_at = datetime.now(timezone.utc)
    checkin_row.skipped = False
    checkin_row.energy = body.energy
    checkin_row.hunger = body.hunger
    checkin_row.soreness = body.soreness
    checkin_row.motivation = body.motivation
    checkin_row.schedule_issue = body.schedule_issue
    checkin_row.note = body.note
    checkin_row.review_snapshot_json = review_snapshot
    checkin_row.ai_decision_id = ai_decision_id
    checkin_row.ai_message = ai_message
    checkin_row.ai_delta = ai_delta
    checkin_row.commitments_json = commitments or None
    checkin_row.plan_goal = pw.goal

    db.commit()

    return {
        **_checkin_to_dict(checkin_row),
        "review_summary": review_snapshot,
    }


@router.post("/week/{plan_week_id}/checkin/skip")
def skip_plan_week_checkin(
    plan_week_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> AutoRenewResponse | dict:
    """Skip the check-in for a plan week and immediately auto-renew the next week."""
    from app.models import PlanWeekCheckin

    pw = db.exec(
        select(PlanWeek).where(
            PlanWeek.id == plan_week_id,
            PlanWeek.user_id == current_user.id,
        )
    ).first()
    if not pw:
        raise HTTPException(status_code=404, detail="Plan week not found")

    # Upsert the check-in row as skipped
    checkin_row = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == current_user.id,
            PlanWeekCheckin.plan_week_id == plan_week_id,
        )
    ).first()
    if not checkin_row:
        checkin_row = PlanWeekCheckin(
            user_id=current_user.id,
            plan_week_id=plan_week_id,
            week_start_date=pw.start_date,
            week_end_date=pw.end_date,
            plan_goal=pw.goal,
        )
        db.add(checkin_row)
    checkin_row.skipped = True
    checkin_row.submitted_at = None
    db.commit()

    # Now auto-renew — check-in is marked so gate won't block
    result = auto_renew_week(db, current_user.id)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    new_pw = get_active_week(db, current_user.id)
    days = get_week_days(db, new_pw.id) if new_pw else []
    return AutoRenewResponse(
        plan_week=_plan_week_to_response(new_pw, days) if new_pw else None,
        review_headline=result.get("review_headline", ""),
        review_summary=result.get("review_summary", {}),
        auto_applied=result.get("auto_applied", []),
        needs_review=result.get("needs_review", []),
        explanation=result.get("explanation", ""),
    )


def _checkin_to_dict(checkin) -> dict:
    return {
        "id": checkin.id,
        "user_id": checkin.user_id,
        "plan_week_id": checkin.plan_week_id,
        "week_start_date": checkin.week_start_date.isoformat() if checkin.week_start_date else None,
        "week_end_date": checkin.week_end_date.isoformat() if checkin.week_end_date else None,
        "submitted_at": checkin.submitted_at.isoformat() if checkin.submitted_at else None,
        "skipped": checkin.skipped,
        "energy": checkin.energy,
        "hunger": checkin.hunger,
        "soreness": checkin.soreness,
        "motivation": checkin.motivation,
        "schedule_issue": checkin.schedule_issue,
        "note": checkin.note,
        "review_snapshot_json": checkin.review_snapshot_json,
        "ai_decision_id": checkin.ai_decision_id,
        "ai_message": checkin.ai_message,
        "ai_delta": checkin.ai_delta,
        "commitments_json": checkin.commitments_json,
        "plan_goal": checkin.plan_goal,
        "created_at": checkin.created_at.isoformat() if checkin.created_at else None,
    }


class ReviewAndApplyRequest(BaseModel):
    actions: list[dict]


@router.post("/week/review-and-apply")
def review_and_apply(
    body: ReviewAndApplyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """User reviews recommendations and selects which to apply, then regenerates remaining days."""
    from app.services.coach.apply_action import apply_action

    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")

    for action_dict in body.actions:
        action_type = action_dict.get("type")
        if action_type:
            try:
                apply_action(db, current_user.id, action_dict)
            except Exception as e:
                logger.warning(f"[review-and-apply] action failed: {action_dict} — {e}")

    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        most_recent_completed_focus,
        build_history_familiarity,
        recent_exercise_slugs_by_muscle,
    )
    from app.services.workout.activity_impact import compute_rolling_fatigue
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.routers.ai.plans import _resolve_owned_equipment_slugs
    from app.seed_exercises_data import SEED_EXERCISES
    from app.models import UserProfile, UserPreferences, UserGoal

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=400, detail="No profile found")

    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == current_user.id,
            UserGoal.is_active == True,
        )
    ).first()
    current_goal = effective_goal_id(active_goal, fallback=pw.goal)

    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = _resolve_owned_equipment_slugs(equipment)
    injuries = _active_injury_tokens(profile, prefs)
    disliked = list(getattr(prefs, "disliked_exercises", []) or [])

    muscle_fatigue = None
    try:
        completions = get_recent_completions_for_fatigue(current_user.id, db)
        if completions:
            snapshot = compute_rolling_fatigue(completions)
            muscle_fatigue = snapshot.muscle_fatigue.to_dict() if snapshot else None
    except Exception:
        pass

    recent_focus_buckets: tuple = ()
    recent_focus_families: tuple = ()
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass

    try:
        history_familiarity = build_history_familiarity(current_user.id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(current_user.id, db)
    except Exception:
        recent_muscle_exercises = {}

    inputs = PlannerInputs(
        goal=current_goal,
        days_per_week=pw.days_per_week,
        session_minutes=int(getattr(prefs, "workout_duration_minutes", 45) or 45),
        experience=str(getattr(profile, "experience_level", "intermediate") or "intermediate").lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=pw.preferred_split,
        injuries=tuple(injuries),
        disliked_exercises=tuple(disliked),
        rng_seed=current_user.id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=muscle_fatigue,
        load_equipment_settings=getattr(prefs, "equipment_settings", None),
    )

    plan = generate_workout_plan(
        inputs, SEED_EXERCISES,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])
    training_pattern = default_training_pattern(pw.days_per_week)

    regenerate_remaining_days(db, pw, fresh_days, training_pattern)

    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)


@router.patch("/days/{day_date}/workout")
def patch_workout(
    day_date: date,
    body: PatchDayWorkoutRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Surgical single-day workout swap. Only works on unlocked days."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == day_date,
        )
    ).first()
    if not plan_day:
        raise HTTPException(status_code=404, detail=f"No plan day for {day_date}")
    if plan_day.locked:
        raise HTTPException(status_code=409, detail=f"Day {day_date} is locked ({plan_day.lock_reason})")

    result = patch_day_workout(db, plan_day, body.workout_json)
    return _plan_day_to_response(result)


@router.patch("/days/{day_date}/nutrition")
def patch_nutrition(
    day_date: date,
    body: PatchDayNutritionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Surgical single-day nutrition edit."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == day_date,
        )
    ).first()
    if not plan_day:
        raise HTTPException(status_code=404, detail=f"No plan day for {day_date}")
    if plan_day.locked:
        raise HTTPException(status_code=409, detail=f"Day {day_date} is locked ({plan_day.lock_reason})")

    result = patch_day_nutrition(db, plan_day, body.nutrition_json)
    return _plan_day_to_response(result)


@router.post("/days/{day_date}/complete")
def mark_day_complete(
    day_date: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Lock a day as completed."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == day_date,
        )
    ).first()
    if not plan_day:
        raise HTTPException(status_code=404, detail=f"No plan day for {day_date}")
    if plan_day.locked and plan_day.status == "completed":
        return _plan_day_to_response(plan_day)

    result = complete_day(db, plan_day)
    return _plan_day_to_response(result)


@router.post("/days/{day_date}/skip")
def mark_day_skipped(
    day_date: date,
    body: SkipDayRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Lock a day as skipped."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == day_date,
        )
    ).first()
    if not plan_day:
        raise HTTPException(status_code=404, detail=f"No plan day for {day_date}")
    if plan_day.locked:
        return _plan_day_to_response(plan_day)

    result = skip_day(db, plan_day, reason=body.reason if body else None)
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(current_user.id)
    except Exception:
        pass
    return _plan_day_to_response(result)


@router.post("/days/{day_date}/unskip")
def mark_day_unskipped(
    day_date: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Undo a manual skip, restoring the PlanDay to an unlocked planned state."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == day_date,
        )
    ).first()
    if not plan_day:
        raise HTTPException(status_code=404, detail=f"No plan day for {day_date}")

    result = unskip_day(db, plan_day)
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(current_user.id)
    except Exception:
        pass
    return _plan_day_to_response(result)


@router.post("/days/{day_date}/start")
def mark_day_started(
    day_date: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Lock a day as started (user began the workout)."""
    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == day_date,
        )
    ).first()
    if not plan_day:
        raise HTTPException(status_code=404, detail=f"No plan day for {day_date}")
    if plan_day.locked:
        return _plan_day_to_response(plan_day)

    result = start_day(db, plan_day)
    return _plan_day_to_response(result)


@router.post("/week/adapt-remaining")
def adapt_remaining(
    body: AdaptRemainingRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Re-fill exercises for all unlocked future days.

    Keeps the same split recipe, regenerates exercises using current fatigue.
    """
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        most_recent_completed_focus,
        build_history_familiarity,
        recent_exercise_slugs_by_muscle,
    )
    from app.services.workout.activity_impact import compute_rolling_fatigue
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.routers.ai.plans import _resolve_owned_equipment_slugs
    from app.seed_exercises_data import SEED_EXERCISES
    from app.models import UserProfile, UserPreferences, UserGoal

    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=400, detail="No profile found")

    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == current_user.id,
            UserGoal.is_active == True,
        )
    ).first()
    current_goal = effective_goal_id(active_goal, fallback=pw.goal)

    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = _resolve_owned_equipment_slugs(equipment)
    injuries = _active_injury_tokens(profile, prefs)
    disliked = list(getattr(prefs, "disliked_exercises", []) or [])

    muscle_fatigue = None
    try:
        completions = get_recent_completions_for_fatigue(current_user.id, db)
        if completions:
            snapshot = compute_rolling_fatigue(completions)
            muscle_fatigue = snapshot.muscle_fatigue.to_dict() if snapshot else None
    except Exception:
        pass

    recent_focus_buckets: tuple = ()
    recent_focus_families: tuple = ()
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass

    try:
        history_familiarity = build_history_familiarity(current_user.id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(current_user.id, db)
    except Exception:
        recent_muscle_exercises = {}

    inputs = PlannerInputs(
        goal=current_goal,
        days_per_week=pw.days_per_week,
        session_minutes=int(getattr(prefs, "workout_duration_minutes", 45) or 45),
        experience=str(getattr(profile, "experience_level", "intermediate") or "intermediate").lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=pw.preferred_split,
        injuries=tuple(injuries),
        disliked_exercises=tuple(disliked),
        rng_seed=current_user.id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=muscle_fatigue,
        load_equipment_settings=getattr(prefs, "equipment_settings", None),
    )

    plan = generate_workout_plan(
        inputs, SEED_EXERCISES,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])

    adapt_remaining_days(db, pw, fresh_days)
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)


@router.post("/week/regenerate-remaining")
def regenerate_remaining(
    body: RegenerateRemainingRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """New recipe for remaining unlocked days.

    Used when user changes days_per_week or preferred_split mid-week.
    """
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        most_recent_completed_focus,
        build_history_familiarity,
        recent_exercise_slugs_by_muscle,
    )
    from app.services.workout.activity_impact import compute_rolling_fatigue
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.routers.ai.plans import _resolve_owned_equipment_slugs
    from app.seed_exercises_data import SEED_EXERCISES
    from app.models import UserProfile, UserPreferences, UserGoal

    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=400, detail="No profile found")

    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == current_user.id,
            UserGoal.is_active == True,
        )
    ).first()
    current_goal = effective_goal_id(active_goal, fallback=pw.goal)

    new_dpw = body.new_days_per_week or pw.days_per_week
    new_split = body.new_preferred_split or pw.preferred_split
    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = _resolve_owned_equipment_slugs(equipment)
    injuries = _active_injury_tokens(profile, prefs)
    disliked = list(getattr(prefs, "disliked_exercises", []) or [])

    muscle_fatigue = None
    try:
        completions = get_recent_completions_for_fatigue(current_user.id, db)
        if completions:
            snapshot = compute_rolling_fatigue(completions)
            muscle_fatigue = snapshot.muscle_fatigue.to_dict() if snapshot else None
    except Exception:
        pass

    recent_focus_buckets: tuple = ()
    recent_focus_families: tuple = ()
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass

    try:
        history_familiarity = build_history_familiarity(current_user.id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(current_user.id, db)
    except Exception:
        recent_muscle_exercises = {}

    from app.models import UserGoal
    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == current_user.id,
            UserGoal.is_active == True,
        )
    ).first()
    current_goal = effective_goal_id(active_goal, fallback=pw.goal)

    inputs = PlannerInputs(
        goal=current_goal,
        days_per_week=new_dpw,
        session_minutes=int(getattr(prefs, "workout_duration_minutes", 45) or 45),
        experience=str(getattr(profile, "experience_level", "intermediate") or "intermediate").lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=new_split,
        injuries=tuple(injuries),
        disliked_exercises=tuple(disliked),
        rng_seed=current_user.id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=muscle_fatigue,
        load_equipment_settings=getattr(prefs, "equipment_settings", None),
    )

    plan = generate_workout_plan(
        inputs, SEED_EXERCISES,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])
    training_pattern = default_training_pattern(new_dpw)

    regenerate_remaining_days(
        db, pw, fresh_days, training_pattern,
        new_days_per_week=new_dpw,
    )

    dirty = False
    if new_split != pw.preferred_split:
        pw.preferred_split = new_split
        dirty = True
    if current_goal != pw.goal:
        pw.goal = current_goal
        dirty = True
    if new_dpw != pw.days_per_week:
        pw.days_per_week = new_dpw
        dirty = True
    if dirty:
        db.add(pw)
        db.commit()

    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)


# ── Weekly Coach Check-In ─────────────────────────────────────────────────────


@router.get("/week-summary")
def get_week_summary(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return structured weekly summary for the check-in modal.

    Computes adherence stats + coach findings from the most recent plan
    week. Purely deterministic — no AI calls.
    """
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.workout.week_checkin_logic import compute_checkin_summary_from_review

    pw = get_active_week(db, current_user.id)
    if not pw:
        from app.models import PlanWeek as _PW
        pw = db.exec(
            select(_PW)
            .where(_PW.user_id == current_user.id)
            .order_by(_PW.created_at.desc())
        ).first()
    if not pw:
        raise HTTPException(status_code=404, detail="No plan week found")

    try:
        review = compute_weekly_review(db, current_user.id)
    except Exception as e:
        logger.warning(f"[week-summary] compute_weekly_review failed: {e}")
        raise HTTPException(status_code=500, detail="Could not compute weekly review")

    summary = compute_checkin_summary_from_review(review)
    result = summary.to_dict()
    result["week_id"] = pw.id
    result["plan_status"] = pw.status
    return result


@router.post("/week-checkin")
def submit_week_checkin(
    body: WeekCheckinAnswersRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Accept structured check-in answers, return recommended adjustments,
    and optionally apply them to UserPreferences / UserCoachingState.

    user_decision options:
      apply_recommendations  — calls apply_action for each actionable item.
      customize              — returns recs but does NOT apply.
      keep_current_style     — records noop, no changes.
      make_easier / make_harder — override and apply.
    """
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.workout.week_checkin_logic import (
        WeeklyCheckinAnswers,
        compute_checkin_summary_from_review,
        compute_checkin_recommendations,
    )
    from app.services.coach.apply_action import apply_action
    from app.models import UserProfile

    try:
        review = compute_weekly_review(
            db, current_user.id,
            weight_trend_lbs_per_week=body.weight_slope_lbs_per_week,
            avg_sleep_hours=body.avg_sleep_hours,
            avg_resting_hr=body.avg_resting_hr,
            avg_steps=body.avg_steps,
            readiness_score=body.readiness_score,
        )
    except Exception as e:
        logger.warning(f"[week-checkin] compute_weekly_review failed: {e}")
        raise HTTPException(status_code=500, detail="Could not compute weekly review")

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    goal = str(getattr(profile, "goal", "body_recomp") or "body_recomp")

    summary = compute_checkin_summary_from_review(review)
    answers = WeeklyCheckinAnswers(
        overall_difficulty=body.overall_difficulty,
        biggest_blocker=body.biggest_blocker,
        pain_area=body.pain_area,
        goal_q4=body.goal_q4,
        user_decision=body.user_decision,
    )
    adj = compute_checkin_recommendations(summary, answers, goal)

    applied_results: list[dict] = []
    should_apply = body.user_decision in ("apply_recommendations", "make_easier", "make_harder")

    if should_apply:
        import datetime as _dt

        # Volume adjustment → UserCoachingState
        if adj.volume_adjustment_pct != 0:
            from app.models import UserCoachingState
            coaching = db.exec(
                select(UserCoachingState).where(UserCoachingState.user_id == current_user.id)
            ).first()
            if not coaching:
                coaching = UserCoachingState(user_id=current_user.id)
                db.add(coaching)
            coaching.volume_adjustment_pct = max(-30, min(15, adj.volume_adjustment_pct))
            coaching.updated_at = _dt.datetime.now(_dt.timezone.utc)
            db.add(coaching)
            applied_results.append({
                "type": "volume_adjustment",
                "summary": f"Volume {coaching.volume_adjustment_pct:+d}% next week",
            })

        # Actionable items via apply_action
        for action in adj.action_list:
            if action.get("type") in ("noop", "descriptive_only"):
                continue
            try:
                result = apply_action(db, current_user.id, action)
                if result.applied:
                    applied_results.append({"type": action.get("type"), "summary": result.summary})
            except Exception as e:
                logger.warning(f"[week-checkin] apply_action failed for {action}: {e}")

        # Pain area → append to UserPreferences.injuries
        if answers.pain_area and answers.pain_area != "none":
            from app.models import UserPreferences
            prefs = db.exec(
                select(UserPreferences).where(UserPreferences.user_id == current_user.id)
            ).first()
            if prefs:
                existing = list(getattr(prefs, "injuries", []) or [])
                if answers.pain_area not in existing:
                    existing.append(answers.pain_area)
                    prefs.injuries = existing
                    db.add(prefs)
                    applied_results.append({
                        "type": "injury_flag",
                        "summary": f"Flagged {answers.pain_area} — planner will avoid high-risk patterns.",
                    })

        # Preferred cardio / muscle priorities → CoachMemory
        from app.models import CoachMemory
        if adj.preferred_cardio_modes:
            db.add(CoachMemory(
                user_id=current_user.id,
                event_type="preferred_cardio_mode",
                summary=f"User prefers: {', '.join(adj.preferred_cardio_modes)}",
                details={"modes": adj.preferred_cardio_modes},
            ))
        if adj.muscle_priorities:
            db.add(CoachMemory(
                user_id=current_user.id,
                event_type="muscle_priority",
                summary=f"Prioritize: {', '.join(adj.muscle_priorities)}",
                details={"muscles": adj.muscle_priorities},
            ))

        db.commit()

    return {
        "summary": adj.to_dict(),
        "applied": applied_results,
        "coach_message": adj.summary,
    }
