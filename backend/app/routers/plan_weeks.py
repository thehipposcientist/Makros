"""Weekly plan endpoints.

New model: one committed 7-day plan per user, date-stamped days,
individually lockable. Replaces the cycling-array model for new clients.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
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

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/plans", tags=["plan-weeks"])


# ─── Request / Response schemas ───────────────────────────────────────────────


class PlanDayResponse(BaseModel):
    day_date: str
    day_index: int
    status: str
    is_rest: bool
    locked: bool
    lock_reason: str | None = None
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
    days: list[PlanDayResponse]


class AutoRenewResponse(BaseModel):
    plan_week: PlanWeekResponse
    review_headline: str
    review_summary: dict
    auto_applied: list[dict]
    needs_review: list[dict]
    explanation: str


class StartNewWeekRequest(BaseModel):
    force: bool = False


class PatchDayWorkoutRequest(BaseModel):
    workout_json: dict


class PatchDayNutritionRequest(BaseModel):
    nutrition_json: dict


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
        workout=pd.workout_json,
        nutrition=pd.nutrition_json,
        generation_source=pd.generation_source,
    )


def _plan_week_to_response(pw: PlanWeek, days: list[PlanDay]) -> PlanWeekResponse:
    return PlanWeekResponse(
        id=pw.id,
        start_date=pw.start_date.isoformat(),
        end_date=pw.end_date.isoformat(),
        status=pw.status,
        needs_new_week=week_needs_renewal(pw),
        planner_version=pw.planner_version,
        goal=pw.goal,
        days_per_week=pw.days_per_week,
        preferred_split=pw.preferred_split,
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

    goal = str(getattr(profile, "goal", "body_recomp") or "body_recomp")
    days_per_week = int(getattr(prefs, "days_per_week", None) or getattr(profile, "days_per_week", 4) or 4)
    session_minutes = int(getattr(prefs, "workout_duration_minutes", None) or getattr(profile, "workout_duration_minutes", 45) or 45)
    experience = str(getattr(profile, "experience_level", "intermediate") or "intermediate")
    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    preferred_split = getattr(prefs, "preferred_split", None) or getattr(profile, "preferred_split", None)
    injuries = list(getattr(profile, "injuries", []) or [])
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
    training_pattern = default_training_pattern(days_per_week)

    pw = create_plan_week(
        db,
        current_user.id,
        start_date=today,
        workout_days=workout_days,
        nutrition_templates=nutrition_templates,
        training_day_pattern=training_pattern,
        goal=goal,
        days_per_week=days_per_week,
        preferred_split=preferred_split,
        planner_version=PLANNER_VERSION,
    )

    days = get_week_days(db, pw.id)
    logger.info(f"[plan-week] started new week for user={current_user.id} start={today}")
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
) -> AutoRenewResponse:
    """Auto-generate a new week when the active plan has expired.

    Called on app open when `needs_new_week === true`.
    """
    pw = get_active_week(db, current_user.id)
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

    result = auto_renew_week(
        db, current_user.id,
        weight_trend_lbs_per_week=weight_slope_lbs_per_week,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        avg_steps=avg_steps,
        readiness_score=readiness_score,
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
    from app.models import UserProfile, UserPreferences

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=400, detail="No profile found")

    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = _resolve_owned_equipment_slugs(equipment)
    injuries = list(getattr(profile, "injuries", []) or [])
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
        goal=pw.goal,
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

    result = skip_day(db, plan_day)
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
    from app.models import UserProfile, UserPreferences

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

    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = _resolve_owned_equipment_slugs(equipment)
    injuries = list(getattr(profile, "injuries", []) or [])
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
        goal=pw.goal,
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
    from app.models import UserProfile, UserPreferences

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

    new_dpw = body.new_days_per_week or pw.days_per_week
    new_split = body.new_preferred_split or pw.preferred_split
    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = _resolve_owned_equipment_slugs(equipment)
    injuries = list(getattr(profile, "injuries", []) or [])
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
        goal=pw.goal,
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

    if new_split != pw.preferred_split:
        pw.preferred_split = new_split
        db.add(pw)
        db.commit()

    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days)
