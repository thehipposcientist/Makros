"""Weekly plan endpoints.

New model: one committed 7-day plan per user, date-stamped days,
individually lockable. Replaces the cycling-array model for new clients.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import PlanWeek, PlanDay, User
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
    repair_remaining_workouts_for_equipment,
    repair_remaining_workouts_for_injuries,
    update_remaining_workouts_for_duration,
    lock_day_on_complete,
    week_needs_renewal,
    default_training_pattern,
    auto_renew_week,
    auto_skip_unlogged_past_days,
)
from app.services.workout.goals import effective_goal_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/plans", tags=["plan-weeks"])

# Day 8 generates immediately. The week can become promptable on day 7 once
# the final scheduled workout is complete; otherwise the expired week stays
# promptable for one day after the end date so the user can review coach
# feedback and save durable changes for future generated weeks. After that it
# becomes a saved recap.
CHECKIN_PROMPT_DAYS_AFTER_END = 1
CHECKIN_RECAP_DAYS_AFTER_END = 7
CHECKIN_SETTINGS_SPLITS = {
    "full_body",
    "upper_lower",
    "ppl",
    "ppl_upper_lower",
    "bro",
}


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
    session_minutes: int | None = None
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
    """Legacy response from the old hold-renewal flow. Kept for clients."""
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
    user_decision: str = "apply_recommendations"


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


class UpdateSessionDurationRequest(BaseModel):
    new_session_minutes: int | None = None


class CheckinPlanSettingsRequest(BaseModel):
    goal: str | None = None
    days_per_week: int | None = None
    preferred_split: str | None = None
    session_minutes: int | None = None
    apply_to_current_week: bool = False
    reason: str = "weekly_checkin"


class CheckinPlanSettingsResponse(BaseModel):
    plan_week: PlanWeekResponse
    changed_fields: dict
    applied_to_current_week: bool
    explanation: str


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _enrich_persisted_days(db: Session, days: list[PlanDay]) -> None:
    """Patch image_url + demo_exercise_db_id onto persisted workout_json
    snapshots before they go out the door. Snapshots taken before the
    free-exercise-db migration have NULL demo ids in their JSON; this
    fills them in at read time without rewriting the row.

    Mutates each PlanDay.workout_json["exercises"] dict in-place. Safe
    to call repeatedly — only fills missing fields."""
    from app.services.workout.exercise_enrichment import enrich_exercises_with_demo_ids
    exercise_lists: list[list[dict]] = []
    for pd in days:
        workout = pd.workout_json
        if isinstance(workout, dict):
            ex_list = workout.get("exercises")
            if isinstance(ex_list, list):
                exercise_lists.append(ex_list)
    if exercise_lists:
        enrich_exercises_with_demo_ids(db, exercise_lists)


def _plan_day_to_response(pd: PlanDay) -> PlanDayResponse:
    workout = pd.workout_json
    if isinstance(workout, dict):
        workout = {
            **workout,
            "plan_day_id": pd.id,
            "planDayId": pd.id,
        }
    return PlanDayResponse(
        day_date=pd.day_date.isoformat(),
        day_index=pd.day_index,
        status=pd.status,
        is_rest=pd.is_rest,
        locked=pd.locked,
        lock_reason=pd.lock_reason,
        skip_reason=getattr(pd, "skip_reason", None),
        workout=workout,
        nutrition=pd.nutrition_json,
        generation_source=pd.generation_source,
    )


def _plan_week_to_response(pw: PlanWeek, days: list[PlanDay], db: Session | None = None) -> PlanWeekResponse:
    # Backfill image_url + demo_exercise_db_id onto persisted snapshots
    # so plans generated before those fields existed still render demos.
    if db is not None:
        _enrich_persisted_days(db, days)
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
        session_minutes=getattr(pw, "session_minutes", None),
        preferred_split=pw.preferred_split,
        paused_until=paused_until_str,
        pause_reason=getattr(pw, "pause_reason", None) if paused_until_str else None,
        days=[_plan_day_to_response(d) for d in days],
    )


def _human_label(value: object, *, lower: bool = False) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"[_\-]+", " ", text)
    text = " ".join(text.split())
    return text.lower() if lower else text.title()


def _normalize_checkin_split(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text or text == "auto":
        return None
    if text not in CHECKIN_SETTINGS_SPLITS:
        raise HTTPException(status_code=422, detail="Unsupported preferred_split")
    return text


def _goal_type_for_checkin_track(goal_track: str):
    from app.enums import GoalType
    from app.services.workout.goals import resolve_goal

    bucket = resolve_goal(goal_track).bucket
    value = {
        "general_health": GoalType.MAINTAIN.value,
        "hyrox": GoalType.ATHLETIC_PERFORMANCE.value,
    }.get(bucket, bucket)
    try:
        return GoalType(value)
    except Exception:
        return GoalType.MAINTAIN


def _checkin_prompt_active(pw: PlanWeek, *, today: date | None = None) -> bool:
    """True while the expired week should still show the check-in prompt."""
    today = today or date.today()
    return today <= pw.end_date + timedelta(days=CHECKIN_PROMPT_DAYS_AFTER_END)


def _checkin_prompt_active_for_dates(week_end: date, *, today: date | None = None) -> bool:
    today = today or date.today()
    return today <= week_end + timedelta(days=CHECKIN_PROMPT_DAYS_AFTER_END)


def _checkin_recap_active_for_dates(week_end: date, *, today: date | None = None) -> bool:
    today = today or date.today()
    return today <= week_end + timedelta(days=CHECKIN_RECAP_DAYS_AFTER_END)


def _plan_day_allows_week_end_checkin(
    plan_day: PlanDay | None,
    completions: list | None = None,
) -> bool:
    if not plan_day or plan_day.is_rest:
        return False
    if plan_day.status == "completed" or (
        bool(plan_day.locked) and plan_day.lock_reason == "completed"
    ):
        return True
    real_completions = [
        c for c in (completions or [])
        if (getattr(c, "duration_seconds", 0) or 0) > 30
    ]
    if not real_completions:
        return False
    try:
        from app.services.workout.week_manager import _completion_matches_plan_day
        return any(
            _completion_matches_plan_day(plan_day, getattr(c, "focus_label", "") or "")
            for c in real_completions
        )
    except Exception:
        return False


def _week_end_workout_checkin_available(
    db: Session,
    pw: PlanWeek,
    *,
    today: date | None = None,
) -> bool:
    """True on day 7 after the week's final scheduled workout is complete."""
    today = today or date.today()
    if pw.end_date != today:
        return False
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == pw.id,
            PlanDay.day_date == pw.end_date,
        )
    ).first()
    if _plan_day_allows_week_end_checkin(plan_day):
        return True

    from app.models import WorkoutCompletion
    completions = list(
        db.exec(
            select(WorkoutCompletion).where(
                WorkoutCompletion.user_id == pw.user_id,
                WorkoutCompletion.workout_date == pw.end_date,
            )
        ).all()
    )
    return _plan_day_allows_week_end_checkin(plan_day, completions)


def _review_snapshot_from_review(review, *, history_context: dict | None = None) -> dict:
    snapshot = {
        "headline": review.headline,
        "goal": review.goal,
        "week_start": review.week_start.isoformat(),
        "week_end": review.week_end.isoformat(),
        "sessions_completed": review.sessions_completed,
        "sessions_planned": review.sessions_planned,
        "adherence_pct": review.adherence_pct,
        "workout_adherence_pct": getattr(review, "workout_adherence_pct", review.adherence_pct),
        "cardio_minutes": review.cardio_minutes,
        "zone2_minutes": review.zone2_minutes,
        "total_hard_sets": review.volume.total_hard_sets,
        "nutrition_logging_pct": getattr(review, "nutrition_logging_pct", review.nutrition_adherence_pct),
        "nutrition_adherence_pct": review.nutrition_adherence_pct,
        "avg_calories": getattr(review, "avg_calories", 0.0),
        "avg_protein_g": review.avg_protein_g,
        "avg_fiber_g": review.avg_fiber_g,
        "days_logged": review.days_logged,
        "calorie_target_adherence_pct": getattr(review, "calorie_target_adherence_pct", None),
        "protein_target_adherence_pct": getattr(review, "protein_target_adherence_pct", None),
        "nutrition_summary": getattr(review, "nutrition_summary", ""),
        "nutrition_notes": getattr(review, "nutrition_notes", []),
        "weight_trend_direction": review.weight_trend_direction,
        "goal_forecast": getattr(review, "goal_forecast", None),
        "recommendations": [
            {
                "key": r.key,
                "title": r.title,
                "priority": r.priority,
                "area": r.area,
                "detail": r.detail,
                "action": r.action,
            }
            for r in review.recommendations[:5]
        ],
    }
    if history_context:
        snapshot["summary_history"] = {
            "is_first_summary": history_context.get("is_first_summary", True),
            "previous_summary_count": history_context.get("previous_summary_count", 0),
        }
    return snapshot


def _checkin_history_context(db: Session, user_id: int, current_plan_week_id: int | None) -> dict:
    """Compact prior summary context for weekly recap generation."""
    from app.models import PlanWeekCheckin

    rows = list(
        db.exec(
            select(PlanWeekCheckin)
            .where(PlanWeekCheckin.user_id == user_id)
            .order_by(PlanWeekCheckin.week_end_date.desc())
        ).all()
    )
    previous = []
    previous_count = 0
    for row in rows:
        if current_plan_week_id is not None and row.plan_week_id == current_plan_week_id:
            continue
        snap = row.review_snapshot_json if isinstance(row.review_snapshot_json, dict) else {}
        if not snap and not row.ai_message:
            continue
        previous_count += 1
        if len(previous) >= 3:
            continue
        previous.append({
            "week_start": row.week_start_date.isoformat() if row.week_start_date else snap.get("week_start"),
            "week_end": row.week_end_date.isoformat() if row.week_end_date else snap.get("week_end"),
            "submitted": bool(row.submitted_at),
            "skipped": bool(row.skipped),
            "headline": snap.get("headline") or row.ai_message,
            "adherence_pct": snap.get("adherence_pct"),
            "sessions_completed": snap.get("sessions_completed"),
            "sessions_planned": snap.get("sessions_planned"),
            "cardio_minutes": snap.get("cardio_minutes"),
            "avg_protein_g": snap.get("avg_protein_g"),
        })
    return {
        "is_first_summary": previous_count == 0,
        "previous_summary_count": previous_count,
        "previous_summaries": previous,
    }


def _build_plan_week_review_snapshot(db: Session, user_id: int, pw: PlanWeek) -> dict:
    from app.services.workout.plan_review_v2 import compute_weekly_review

    history_context = _checkin_history_context(db, user_id, pw.id)
    try:
        review = compute_weekly_review(
            db,
            user_id,
            end_date=pw.end_date,
            days=7,
            goal_override=pw.goal,
        )
        return _review_snapshot_from_review(review, history_context=history_context)
    except Exception as e:
        logger.warning(f"[week-checkin] review snapshot failed for plan_week_id={pw.id}: {e}")
        return {
            "headline": f"Week of {pw.start_date.isoformat()} to {pw.end_date.isoformat()} is ready to review.",
            "goal": pw.goal,
            "week_start": pw.start_date.isoformat(),
            "week_end": pw.end_date.isoformat(),
            "summary_history": {
                "is_first_summary": history_context.get("is_first_summary", True),
                "previous_summary_count": history_context.get("previous_summary_count", 0),
            },
        }


def _plan_week_review_snapshot_needs_backfill(snapshot: dict | None) -> bool:
    if not isinstance(snapshot, dict):
        return True
    required_keys = (
        "workout_adherence_pct",
        "nutrition_logging_pct",
        "avg_calories",
        "calorie_target_adherence_pct",
        "protein_target_adherence_pct",
        "nutrition_summary",
        "nutrition_notes",
        "goal_forecast",
    )
    if any(key not in snapshot for key in required_keys):
        return True
    recommendations = snapshot.get("recommendations")
    if isinstance(recommendations, list):
        return any(isinstance(rec, dict) and "action" not in rec for rec in recommendations)
    return False


def _backfill_plan_week_checkin_review_snapshot(
    db: Session,
    user_id: int,
    checkin,
):
    if not checkin:
        return checkin
    refresh_recent_recap = (
        checkin.week_end_date is not None
        and _checkin_recap_active_for_dates(checkin.week_end_date)
    )
    if (
        not refresh_recent_recap
        and not _plan_week_review_snapshot_needs_backfill(checkin.review_snapshot_json)
    ):
        return checkin

    pw = db.exec(
        select(PlanWeek).where(
            PlanWeek.id == checkin.plan_week_id,
            PlanWeek.user_id == user_id,
        )
    ).first()
    if not pw:
        return checkin

    old_snapshot = checkin.review_snapshot_json if isinstance(checkin.review_snapshot_json, dict) else {}
    new_snapshot = _build_plan_week_review_snapshot(db, user_id, pw)
    merged_snapshot = {**old_snapshot, **new_snapshot}
    for key in ("structured_checkin", "structured_adjustment", "structured_applied"):
        if key in old_snapshot:
            merged_snapshot[key] = old_snapshot[key]
    checkin.review_snapshot_json = merged_snapshot
    checkin.plan_goal = checkin.plan_goal or pw.goal
    db.add(checkin)
    db.commit()
    db.refresh(checkin)
    return checkin


def _ensure_plan_week_checkin_pending(
    db: Session,
    user_id: int,
    pw: PlanWeek,
):
    """Create the durable previous-week recap row before auto-renewing."""
    from app.models import PlanWeekCheckin

    checkin = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == user_id,
            PlanWeekCheckin.plan_week_id == pw.id,
        )
    ).first()
    if not checkin:
        checkin = PlanWeekCheckin(
            user_id=user_id,
            plan_week_id=pw.id,
            week_start_date=pw.start_date,
            week_end_date=pw.end_date,
            plan_goal=pw.goal,
        )
        db.add(checkin)
    if not checkin.review_snapshot_json:
        checkin.review_snapshot_json = _build_plan_week_review_snapshot(db, user_id, pw)
    checkin.plan_goal = checkin.plan_goal or pw.goal
    db.commit()
    return checkin


def _mark_plan_week_checkin_skipped(
    db: Session,
    user_id: int,
    pw: PlanWeek,
    *,
    note: str | None = None,
):
    """Upsert a skipped PlanWeekCheckin so renewal can proceed normally."""
    from app.models import PlanWeekCheckin

    checkin = db.exec(
        select(PlanWeekCheckin).where(
            PlanWeekCheckin.user_id == user_id,
            PlanWeekCheckin.plan_week_id == pw.id,
        )
    ).first()
    if not checkin:
        checkin = PlanWeekCheckin(
            user_id=user_id,
            plan_week_id=pw.id,
            week_start_date=pw.start_date,
            week_end_date=pw.end_date,
            plan_goal=pw.goal,
        )
        db.add(checkin)
    if not checkin.review_snapshot_json:
        checkin.review_snapshot_json = _build_plan_week_review_snapshot(db, user_id, pw)
    checkin.skipped = True
    checkin.submitted_at = None
    if note and not checkin.note:
        checkin.note = note
    db.commit()
    return checkin


def _auto_skip_and_refresh_week_days(db: Session, user_id: int, pw: PlanWeek | None) -> list[PlanDay]:
    if not pw:
        return []
    days = get_week_days(db, pw.id)
    if not _is_plan_paused(pw) and auto_skip_unlogged_past_days(db, user_id, days):
        days = get_week_days(db, pw.id)
    return days


# ─── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/week/active")
def get_active_plan_week(
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse | None:
    """Return the active PlanWeek with all 7 PlanDay rows.

    If no PlanWeek exists but a legacy WorkoutPlan does, returns None
    (client should call start-new-week or wait for the backfill).
    """
    pw = get_active_week(db, current_user.id)
    if not pw:
        return None
    days = _auto_skip_and_refresh_week_days(db, current_user.id, pw)
    return _plan_week_to_response(pw, days, db)


def _is_plan_paused(pw: PlanWeek) -> bool:
    """True when `paused_until` is set to a future date. Past pauses are
    treated as expired automatically (no need to clear the column)."""
    pu = getattr(pw, "paused_until", None)
    return pu is not None and pu >= date.today()


# ─── Plan pause (travel / illness) ───────────────────────────────────────────


class PausePlanRequest(BaseModel):
    """Resume date — defaults to a 7-day pause if omitted. Reason is free-form
    but the UI typically sends one of: 'travel' / 'illness' / 'other'."""
    paused_until: date | None = None
    reason: str | None = None


@router.post("/week/pause")
def pause_active_week(
    body: PausePlanRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    return _plan_week_to_response(pw, days, db)


@router.post("/week/resume")
def resume_active_week(
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    return _plan_week_to_response(pw, days, db)


@router.post("/start-new-week")
def start_new_week(
    body: StartNewWeekRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Explicit user action: generate a fresh 7-day plan starting today.

    Runs the existing deterministic planner + nutrition assembler, then
    stamps dates and persists into plan_weeks + plan_days.
    """
    from app.services.workout.weekly_recipe import PLANNER_VERSION
    from app.models import UserProfile, UserPreferences, NutritionPlan, WorkoutPlan
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
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
    preferred_split = getattr(prefs, "preferred_split", None) or getattr(profile, "preferred_split", None)
    today = date.today()
    week_start = today

    planner_ctx = build_planweek_planner_context(
        db,
        current_user.id,
        profile,
        prefs,
        goal=goal,
        days_per_week=days_per_week,
        session_minutes=session_minutes,
        preferred_split=preferred_split,
        cycle_phase=body.cycle_phase,
        day_of_cycle=body.day_of_cycle,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, current_user.id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
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

    # Anchor the FIRST plan week to the user's sign-up / start day rather
    # than a calendar Monday. Two reasons:
    #   1. UX — a user who signs up Friday wants their plan + check-in
    #      cadence to feel personal ("my week ends next Thursday"), not
    #      jammed into a Sunday-night calendar boundary.
    #   2. Engagement — anchoring to sign-up day means the weekly review
    #      always lands on the day they originally engaged, which tends
    #      to be a high-intent day for them.
    # Auto-renewal uses prev.end_date + 1 so this anchor sticks across
    # week boundaries (Friday-Thursday cycle persists every week).
    from app.services.workout.week_manager import training_pattern_from_preferences
    training_pattern = training_pattern_from_preferences(prefs, days_per_week)

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
    logger.info(f"[plan-week] started new week for user={current_user.id} start={week_start} (today={today}, weekday={today.weekday()})")
    return _plan_week_to_response(pw, days, db)


@router.post("/week/auto-renew")
def auto_renew(
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
    weight_slope_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_steps: float | None = None,
    readiness_score: int | None = None,
    cycle_phase: str | None = None,
    day_of_cycle: int | None = None,
) -> AutoRenewResponse:
    """Auto-generate a new week when the active plan has expired.

    Day 8 generation is immediate. A durable check-in row is created for the
    expired week, but coach adjustments only affect the new week if the user
    submits/applies them during the one-day review window.
    """
    pw = get_active_week(db, current_user.id)
    apply_coach_adjustments = False
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
        days = _auto_skip_and_refresh_week_days(db, current_user.id, pw)
        return AutoRenewResponse(
            plan_week=_plan_week_to_response(pw, days),
            review_headline="Week is still active — no renewal needed.",
            review_summary={},
            auto_applied=[],
            needs_review=[],
            explanation="Your current week is still active.",
        )

    # Snapshot the expired week before creating the next active PlanWeek.
    # The snapshot powers the day-8 prompt and the Progress recap. Renewal
    # still proceeds immediately so the user always has a current week.
    if pw:
        _auto_skip_and_refresh_week_days(db, current_user.id, pw)
        checkin = _ensure_plan_week_checkin_pending(db, current_user.id, pw)
        if not checkin or (not checkin.submitted_at and not checkin.skipped):
            if not _checkin_prompt_active(pw):
                checkin = _mark_plan_week_checkin_skipped(
                    db,
                    current_user.id,
                    pw,
                    note="Auto-skipped after the weekly check-in prompt window.",
                )
        apply_coach_adjustments = bool(checkin and checkin.submitted_at and not checkin.skipped)

    result = auto_renew_week(
        db, current_user.id,
        weight_trend_lbs_per_week=weight_slope_lbs_per_week,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        avg_steps=avg_steps,
        readiness_score=readiness_score,
        cycle_phase=cycle_phase,
        day_of_cycle=day_of_cycle,
        apply_coach_adjustments=apply_coach_adjustments,
    )

    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    new_pw = get_active_week(db, current_user.id)
    days = _auto_skip_and_refresh_week_days(db, current_user.id, new_pw)

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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> dict:
    """Return whether a coaching check-in is pending, completed, or not due.

    status:
      "pending"   — prior expired week is inside its one-day prompt window, or
                    the active week ended today and the final workout is done
      "completed" — check-in was submitted for this week
      "skipped"   — user explicitly skipped
      "none"      — no prompt or recent recap to show
    """
    from app.models import PlanWeekCheckin

    today = date.today()
    pw = get_active_week(db, current_user.id)
    checkin = None

    if pw and (
        week_needs_renewal(pw)
        or _week_end_workout_checkin_available(db, pw, today=today)
    ):
        checkin = _ensure_plan_week_checkin_pending(db, current_user.id, pw)
    if not checkin:
        checkin = db.exec(
            select(PlanWeekCheckin)
            .where(
                PlanWeekCheckin.user_id == current_user.id,
                PlanWeekCheckin.week_end_date < today,
            )
            .order_by(PlanWeekCheckin.week_end_date.desc())
        ).first()

    if not checkin:
        return {"status": "none", "checkin": None, "week_start": None, "week_end": None, "plan_week_id": None}

    if not checkin.submitted_at and not checkin.skipped and not _checkin_prompt_active_for_dates(checkin.week_end_date, today=today):
        checkin.skipped = True
        checkin.submitted_at = None
        if not checkin.note:
            checkin.note = "Auto-skipped after the weekly check-in prompt window."
        db.add(checkin)
        db.commit()
        db.refresh(checkin)

    if (
        checkin.submitted_at or checkin.skipped
    ) and not _checkin_recap_active_for_dates(checkin.week_end_date, today=today):
        return {"status": "none", "checkin": None, "week_start": None, "week_end": None, "plan_week_id": None}

    checkin = _backfill_plan_week_checkin_review_snapshot(db, current_user.id, checkin)

    status = "pending"
    if checkin and checkin.skipped:
        status = "skipped"
    elif checkin and checkin.submitted_at:
        status = "completed"

    return {
        "status": status,
        "checkin": _checkin_to_dict(checkin) if checkin else None,
        "week_start": checkin.week_start_date.isoformat() if checkin.week_start_date else None,
        "week_end": checkin.week_end_date.isoformat() if checkin.week_end_date else None,
        "plan_week_id": checkin.plan_week_id,
    }


@router.get("/week/{plan_week_id}/checkin")
def get_plan_week_checkin(
    plan_week_id: int,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    checkin = _backfill_plan_week_checkin_review_snapshot(db, current_user.id, checkin)
    return _checkin_to_dict(checkin)


@router.post("/week/{plan_week_id}/checkin")
def submit_plan_week_checkin(
    plan_week_id: int,
    body: PlanWeekCheckinSubmitRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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

    # Deterministic review for the exact PlanWeek being checked in. When the
    # user submits on day 8, the active week may already be the next one.
    try:
        review = compute_weekly_review(
            db,
            current_user.id,
            end_date=pw.end_date,
            days=7,
            goal_override=pw.goal,
        )
    except Exception as e:
        logger.warning(f"[week-checkin] compute_weekly_review failed: {e}")
        raise HTTPException(status_code=500, detail="Could not compute weekly review")

    history_context = _checkin_history_context(db, current_user.id, plan_week_id)
    review_snapshot = _review_snapshot_from_review(review, history_context=history_context)

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
    if body.user_decision:
        structured_feedback["user_decision"] = body.user_decision
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
                user_decision=body.user_decision or "apply_recommendations",
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
                    "changed_fields": {
                        "volume_adjustment_pct": coaching.volume_adjustment_pct,
                    },
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
                        "changed_fields": result.changed_fields,
                        "descriptive_only": result.descriptive_only,
                        "verified": bool(result.changed_fields) or result.descriptive_only,
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
                        "summary": f"Flagged {_human_label(body.pain_area)} for next week's planner.",
                        "changed_fields": {"injuries": existing},
                    })
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="injury_flag",
                    summary=f"Weekly check-in pain area: {body.pain_area}",
                    details={"plan_week_id": plan_week_id, "pain_area": body.pain_area},
                ))

            if adj.preferred_cardio_modes:
                mode_labels = [_human_label(m, lower=True) for m in adj.preferred_cardio_modes]
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="preferred_cardio_mode",
                    summary=f"Preferred cardio saved: {', '.join(mode_labels)}",
                    details={"modes": adj.preferred_cardio_modes, "source": "plan_week_checkin"},
                ))
                structured_applied.append({
                    "type": "preferred_cardio_mode",
                    "summary": f"Saved preferred cardio modes: {', '.join(mode_labels)}.",
                    "changed_fields": {"preferred_cardio_modes": adj.preferred_cardio_modes},
                    "descriptive_only": True,
                    "verified": True,
                })
            if adj.muscle_priorities:
                muscle_labels = [_human_label(m, lower=True) for m in adj.muscle_priorities]
                db.add(CoachMemory(
                    user_id=current_user.id,
                    event_type="muscle_priority",
                    summary=f"Priority muscle saved: {', '.join(muscle_labels)}",
                    details={"muscles": adj.muscle_priorities, "source": "plan_week_checkin"},
                ))
                structured_applied.append({
                    "type": "muscle_priority",
                    "summary": f"Prioritized {', '.join(muscle_labels)} for next week's planner.",
                    "changed_fields": {"muscle_priorities": adj.muscle_priorities},
                    "descriptive_only": True,
                    "verified": True,
                })
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
    }
    payload["summary_history"] = history_context

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

        # LLM deltas are saved for display only. User-confirmed state
        # changes route through /coach/apply-action or deterministic
        # check-in logic; this endpoint never rewrites the active PlanWeek.

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
        "regenerated_current_week": False,
    }


@router.post("/week/{plan_week_id}/checkin/skip")
def skip_plan_week_checkin(
    plan_week_id: int,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> AutoRenewResponse | dict:
    """Skip the check-in for a plan week.

    If day-8 auto-renew already created the next active week, that week stays
    exactly as generated. If this is an older client still sitting on the
    expired week, skipping falls through to normal renewal.
    """
    pw = db.exec(
        select(PlanWeek).where(
            PlanWeek.id == plan_week_id,
            PlanWeek.user_id == current_user.id,
        )
    ).first()
    if not pw:
        raise HTTPException(status_code=404, detail="Plan week not found")

    _mark_plan_week_checkin_skipped(db, current_user.id, pw)

    active_pw = get_active_week(db, current_user.id)
    if active_pw and active_pw.id != pw.id and not week_needs_renewal(active_pw):
        days = _auto_skip_and_refresh_week_days(db, current_user.id, active_pw)
        return AutoRenewResponse(
            plan_week=_plan_week_to_response(active_pw, days),
            review_headline="Weekly check-in skipped.",
            review_summary={},
            auto_applied=[],
            needs_review=[],
            explanation="Check-in skipped; your current week stays as generated.",
        )

    if active_pw and active_pw.id == pw.id and not week_needs_renewal(active_pw):
        days = _auto_skip_and_refresh_week_days(db, current_user.id, active_pw)
        return AutoRenewResponse(
            plan_week=_plan_week_to_response(active_pw, days),
            review_headline="Weekly check-in skipped.",
            review_summary={},
            auto_applied=[],
            needs_review=[],
            explanation="Check-in skipped; your current week stays as generated.",
        )

    # Older client / edge case: no new week exists yet, so skipping now allows
    # a normal generation without coach adjustments.
    result = auto_renew_week(db, current_user.id, apply_coach_adjustments=False)
    if "error" in result:
        raise HTTPException(status_code=400, detail=result["error"])

    new_pw = get_active_week(db, current_user.id)
    days = _auto_skip_and_refresh_week_days(db, current_user.id, new_pw)
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Apply selected recommendations to durable state only.

    The active PlanWeek is fixed for its 7-day window. Weekly review
    recommendations may update user-facing settings or coach/day state via
    apply_action, but they must not regenerate or rewrite PlanDay rows.
    """
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

    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days, db)


@router.patch("/days/{day_date}/workout")
def patch_workout(
    day_date: date,
    body: PatchDayWorkoutRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanDayResponse:
    """Surgical single-day workout swap.

    Completed/skipped/started days stay protected. A manual-edit lock is
    re-editable because it represents the user's own prior patch.
    """
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
    if plan_day.locked and plan_day.lock_reason != "manual_edit":
        raise HTTPException(status_code=409, detail=f"Day {day_date} is locked ({plan_day.lock_reason})")

    result = patch_day_workout(db, plan_day, body.workout_json)
    return _plan_day_to_response(result)


@router.patch("/days/{day_date}/nutrition")
def patch_nutrition(
    day_date: date,
    body: PatchDayNutritionRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Re-fill exercises for all unlocked future days.

    Keeps the same split recipe, regenerates exercises using current fatigue.
    """
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
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

    planner_ctx = build_planweek_planner_context(
        db,
        current_user.id,
        profile,
        prefs,
        goal=current_goal,
        days_per_week=pw.days_per_week,
        session_minutes=int(getattr(prefs, "workout_duration_minutes", 45) or 45),
        preferred_split=pw.preferred_split,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, current_user.id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])

    adapt_remaining_days(db, pw, fresh_days)
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days, db)


@router.post("/week/repair-injury-conflicts")
def repair_injury_conflicts(
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Immediately make unlocked current-week workouts injury-aware.

    This is a safety exception to the normal "settings apply next week"
    rule. It preserves the active week's structure and only rewrites
    today/future unlocked workout exercise lists using the user's active
    injury flags.
    """
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
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

    planner_ctx = build_planweek_planner_context(
        db,
        current_user.id,
        profile,
        prefs,
        goal=current_goal,
        days_per_week=pw.days_per_week,
        session_minutes=(
            int(getattr(prefs, "workout_duration_minutes", None) or 0)
            or getattr(pw, "session_minutes", None)
            or 45
        ),
        preferred_split=pw.preferred_split,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, current_user.id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])
    repair_remaining_workouts_for_injuries(db, pw, fresh_days)
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days, db)


@router.post("/week/repair-equipment-conflicts")
def repair_equipment_conflicts(
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Immediately repair active-week exercises that need removed equipment.

    This preserves the PlanWeek's dated structure and only swaps exercises on
    today/future unlocked workouts when the existing exercise is no longer
    compatible with the user's saved equipment list.
    """
    from app.services.workout.equipment import resolve_owned_equipment_slugs
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
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

    planner_ctx = build_planweek_planner_context(
        db,
        current_user.id,
        profile,
        prefs,
        goal=current_goal,
        days_per_week=pw.days_per_week,
        session_minutes=(
            int(getattr(prefs, "workout_duration_minutes", None) or 0)
            or getattr(pw, "session_minutes", None)
            or 45
        ),
        preferred_split=pw.preferred_split,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, current_user.id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])
    owned_slugs = resolve_owned_equipment_slugs(
        list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    )
    repair_remaining_workouts_for_equipment(
        db,
        pw,
        fresh_days,
        owned_slugs,
        seed_exercises=exercise_catalog,
    )
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days, db)


@router.post("/week/update-session-duration")
def update_session_duration(
    body: UpdateSessionDurationRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """Immediately rebuild unlocked workouts for a new session duration.

    This is a narrow exception to the next-week settings rule: changing the
    time budget does not change the active week's dates, rest/training days,
    goal, or split. Completed/started days stay untouched.
    """
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
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

    raw_minutes = body.new_session_minutes
    if raw_minutes is None:
        raw_minutes = (
            getattr(prefs, "workout_duration_minutes", None)
            or getattr(pw, "session_minutes", None)
            or 45
        )
    try:
        new_minutes = int(raw_minutes)
    except Exception:
        raise HTTPException(status_code=422, detail="new_session_minutes must be an integer")
    new_minutes = max(20, min(120, new_minutes))

    planner_ctx = build_planweek_planner_context(
        db,
        current_user.id,
        profile,
        prefs,
        goal=pw.goal,
        days_per_week=pw.days_per_week,
        session_minutes=new_minutes,
        preferred_split=pw.preferred_split,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, current_user.id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])
    update_remaining_workouts_for_duration(db, pw, fresh_days, new_minutes)
    days = get_week_days(db, pw.id)
    return _plan_week_to_response(pw, days, db)


@router.post("/week/regenerate-remaining")
def regenerate_remaining(
    body: RegenerateRemainingRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> PlanWeekResponse:
    """New recipe for remaining unlocked days.

    Used when user changes days_per_week or preferred_split mid-week.
    """
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
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
    new_split = (
        _normalize_checkin_split(body.new_preferred_split)
        if body.new_preferred_split is not None
        else pw.preferred_split
    )

    planner_ctx = build_planweek_planner_context(
        db,
        current_user.id,
        profile,
        prefs,
        goal=current_goal,
        days_per_week=new_dpw,
        session_minutes=int(getattr(prefs, "workout_duration_minutes", 45) or 45),
        preferred_split=new_split,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, current_user.id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
    )
    fresh_days = plan.get("workout_plan", {}).get("days", [])
    from app.services.workout.week_manager import training_pattern_from_preferences
    training_pattern = training_pattern_from_preferences(prefs, new_dpw)

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
    return _plan_week_to_response(pw, days, db)


@router.post("/week/checkin-settings")
def apply_checkin_plan_settings(
    body: CheckinPlanSettingsRequest,
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> CheckinPlanSettingsResponse:
    """Save explicit setup changes from the weekly check-in.

    Durable settings always update future generated weeks. When requested,
    only unlocked current/future PlanDay rows are regenerated through the
    deterministic remaining-week path; completed/skipped/started days stay
    protected.
    """
    from app.enums import GoalPace
    from app.models import UserGoal, UserPreferences, UserProfile

    pw = get_active_week(db, current_user.id)
    if not pw:
        raise HTTPException(status_code=404, detail="No active plan week")

    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=400, detail="No profile found")

    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if not prefs:
        prefs = UserPreferences(user_id=current_user.id)
        db.add(prefs)
        db.flush()

    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == current_user.id,
            UserGoal.is_active == True,
        )
    ).first()
    current_goal_track = effective_goal_id(active_goal, fallback=pw.goal)
    changed_fields: dict[str, dict[str, object]] = {}

    requested_goal = (body.goal or "").strip().lower()
    if requested_goal and requested_goal != current_goal_track:
        new_goal_type = _goal_type_for_checkin_track(requested_goal)
        for old_goal in db.exec(
            select(UserGoal).where(
                UserGoal.user_id == current_user.id,
                UserGoal.is_active == True,
            )
        ).all():
            old_goal.is_active = False
            db.add(old_goal)
        active_goal_type = getattr(active_goal, "goal_type", None) if active_goal else None
        same_goal_type = (
            active_goal is not None
            and getattr(active_goal_type, "value", active_goal_type) == new_goal_type.value
        )
        new_goal = UserGoal(
            user_id=current_user.id,
            goal_type=new_goal_type,
            goal_track=requested_goal,
            pace=(active_goal.pace if active_goal and active_goal.pace else GoalPace.MODERATE),
            target_weight_lbs=(
                active_goal.target_weight_lbs
                if same_goal_type and active_goal
                else None
            ),
            timeline_weeks=(
                active_goal.timeline_weeks
                if same_goal_type and active_goal
                else None
            ),
            start_weight_lbs=float(profile.weight_lbs) if profile.weight_lbs else None,
        )
        db.add(new_goal)
        changed_fields["goal"] = {"from": current_goal_track, "to": requested_goal}

    if body.days_per_week is not None:
        try:
            new_days = int(body.days_per_week)
        except Exception:
            raise HTTPException(status_code=422, detail="days_per_week must be an integer")
        new_days = max(1, min(7, new_days))
        old_days = int(getattr(prefs, "days_per_week", None) or pw.days_per_week or 3)
        if new_days != old_days:
            prefs.days_per_week = new_days
            current_pattern = getattr(prefs, "training_day_pattern", None)
            if not isinstance(current_pattern, list) or len(current_pattern) != new_days:
                prefs.training_day_pattern = None
            changed_fields["days_per_week"] = {"from": old_days, "to": new_days}

    if body.preferred_split is not None:
        new_split = _normalize_checkin_split(body.preferred_split)
        old_split = _normalize_checkin_split(getattr(prefs, "preferred_split", None))
        if new_split != old_split:
            prefs.preferred_split = new_split
            changed_fields["preferred_split"] = {"from": old_split or "auto", "to": new_split or "auto"}

    if body.session_minutes is not None:
        try:
            new_minutes = int(body.session_minutes)
        except Exception:
            raise HTTPException(status_code=422, detail="session_minutes must be an integer")
        new_minutes = max(20, min(120, new_minutes))
        old_minutes = int(
            getattr(prefs, "workout_duration_minutes", None)
            or getattr(pw, "session_minutes", None)
            or 45
        )
        if new_minutes != old_minutes:
            prefs.workout_duration_minutes = new_minutes
            changed_fields["session_minutes"] = {"from": old_minutes, "to": new_minutes}

    if changed_fields:
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        db.commit()
    else:
        db.rollback()

    applied_to_current = False
    plan_response: PlanWeekResponse
    if changed_fields and body.apply_to_current_week:
        recipe_changed = any(k in changed_fields for k in ("goal", "days_per_week", "preferred_split"))
        duration_changed = "session_minutes" in changed_fields
        if recipe_changed:
            plan_response = regenerate_remaining(
                RegenerateRemainingRequest(
                    new_days_per_week=int(
                        getattr(prefs, "days_per_week", None)
                        or pw.days_per_week
                        or 3
                    ),
                    new_preferred_split=getattr(prefs, "preferred_split", None) or "auto",
                    reason=body.reason or "weekly_checkin",
                ),
                current_user=current_user,
                db=db,
            )
            if duration_changed:
                refreshed = get_active_week(db, current_user.id)
                if refreshed:
                    refreshed.session_minutes = int(
                        getattr(prefs, "workout_duration_minutes", None)
                        or refreshed.session_minutes
                        or 45
                    )
                    db.add(refreshed)
                    db.commit()
                    plan_response = _plan_week_to_response(refreshed, get_week_days(db, refreshed.id), db)
            applied_to_current = True
        elif duration_changed:
            plan_response = update_session_duration(
                UpdateSessionDurationRequest(
                    new_session_minutes=int(
                        getattr(prefs, "workout_duration_minutes", None) or 45
                    )
                ),
                current_user=current_user,
                db=db,
            )
            applied_to_current = True
        else:
            refreshed = get_active_week(db, current_user.id)
            plan_response = _plan_week_to_response(refreshed, get_week_days(db, refreshed.id), db)
    else:
        refreshed = get_active_week(db, current_user.id)
        days = get_week_days(db, refreshed.id)
        plan_response = _plan_week_to_response(refreshed, days, db)

    if not changed_fields:
        explanation = "No plan setup changes were saved."
    elif applied_to_current:
        explanation = "Saved settings and rebuilt remaining unlocked days in your current week."
    else:
        explanation = "Saved settings for future generated weeks. Your current week stays unchanged."

    return CheckinPlanSettingsResponse(
        plan_week=plan_response,
        changed_fields=changed_fields,
        applied_to_current_week=applied_to_current,
        explanation=explanation,
    )


# ── Weekly Coach Check-In ─────────────────────────────────────────────────────


@router.get("/week-summary")
def get_week_summary(
    plan_week_id: int | None = Query(default=None),
    end_date: date | None = Query(default=None),
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> dict:
    """Return structured weekly summary for the check-in modal.

    Computes adherence stats + coach findings from the most recent plan
    week. Purely deterministic — no AI calls.
    """
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.workout.week_checkin_logic import compute_checkin_summary_from_review

    pw = None
    if plan_week_id is not None:
        pw = db.exec(
            select(PlanWeek).where(
                PlanWeek.id == plan_week_id,
                PlanWeek.user_id == current_user.id,
            )
        ).first()
        if not pw:
            raise HTTPException(status_code=404, detail="Plan week not found")
    if pw is None:
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
        review = compute_weekly_review(
            db,
            current_user.id,
            end_date=end_date or pw.end_date,
            days=7,
            goal_override=pw.goal,
        )
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
    current_user: User = Depends(require_pro_feature("Generated PlanWeeks")),
    db: Session = Depends(get_session),
) -> dict:
    """Accept structured check-in answers, return recommended adjustments,
    and optionally apply them to UserPreferences / UserCoachingState.
    The active PlanWeek remains fixed; applied settings affect future
    generated weeks or day-state overlays only.

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

    summary = compute_checkin_summary_from_review(review)
    goal = str(getattr(review, "goal", None) or "body_recomp")
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
                        "summary": f"Flagged {_human_label(answers.pain_area)}. The planner will avoid high-risk patterns.",
                    })

        # Preferred cardio / muscle priorities → CoachMemory
        from app.models import CoachMemory
        if adj.preferred_cardio_modes:
            mode_labels = [_human_label(m, lower=True) for m in adj.preferred_cardio_modes]
            db.add(CoachMemory(
                user_id=current_user.id,
                event_type="preferred_cardio_mode",
                summary=f"Preferred cardio saved: {', '.join(mode_labels)}",
                details={"modes": adj.preferred_cardio_modes},
            ))
            applied_results.append({
                "type": "preferred_cardio_mode",
                "summary": f"Saved preferred cardio modes: {', '.join(mode_labels)}.",
            })
        if adj.muscle_priorities:
            muscle_labels = [_human_label(m, lower=True) for m in adj.muscle_priorities]
            db.add(CoachMemory(
                user_id=current_user.id,
                event_type="muscle_priority",
                summary=f"Priority muscle saved: {', '.join(muscle_labels)}",
                details={"muscles": adj.muscle_priorities},
            ))
            applied_results.append({
                "type": "muscle_priority",
                "summary": f"Prioritized {', '.join(muscle_labels)} for next week's planner.",
            })

        db.commit()

    return {
        "summary": adj.to_dict(),
        "applied": applied_results,
        "coach_message": adj.summary,
    }
