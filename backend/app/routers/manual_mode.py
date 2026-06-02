"""Manual mode (Pro-only) — let users opt out of the deterministic
planner and assemble their own week from saved WorkoutTemplate rows.

Manual-mode endpoints:

  POST /profile/preferences/manual-mode
      Toggle workout_manual_mode and/or meal_manual_mode. Pro-only.
      Workout flip-on wipes future un-done days in the active week.

  POST /plan-weeks/{plan_week_id}/days/{day_index}/use-template
      Snapshot a WorkoutTemplate's workout_json into the target PlanDay.
      Marks status="edited", generation_source="manual", lock_reason="manual_edit".

  POST /plan-weeks/{plan_week_id}/days/{day_index}/generate-workout
      Generate a deterministic one-off workout (focus + stimulus) and
      snapshot it into the target PlanDay. Does not mutate any other day.

  POST /plan-weeks/{plan_week_id}/days/{day_index}/clear
      Revert a PlanDay back to status="unassigned" so the user can swap
      to a different template or set is_rest=True.

Done days (status="completed") are never touched by any of these — done
work stays done regardless of mode flips or clears.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import is_pro
from app.models import (
    PlanDay,
    PlanWeek,
    User,
    UserGoal,
    UserPreferences,
    WorkoutTemplate,
)


router = APIRouter(tags=["manual-mode"])


# ─── Toggle endpoint ─────────────────────────────────────────────────────────

class ManualModeBody(BaseModel):
    workout_manual_mode: Optional[bool] = None
    meal_manual_mode: Optional[bool] = None


def _wipe_future_undone_days(db: Session, user_id: int) -> int:
    """Reset future un-done days in the active week to status="unassigned"
    so the user can drop templates onto them. Returns count cleared.

    Done/started days are preserved verbatim — the rule is "don't touch
    work the user already started or finished." Today itself counts as
    future when not yet completed; flipping mid-day clears today too if
    the user hasn't started it.
    """
    today = date.today()
    active = db.exec(
        select(PlanWeek)
        .where(PlanWeek.user_id == user_id)
        .where(PlanWeek.status == "active")
    ).first()
    if active is None:
        return 0
    days = db.exec(
        select(PlanDay)
        .where(PlanDay.plan_week_id == active.id)
        .where(PlanDay.day_date >= today)
    ).all()
    cleared = 0
    for d in days:
        if d.status in ("completed", "started"):
            continue
        d.status = "unassigned"
        d.workout_json = None
        d.is_rest = False
        d.locked = False
        d.lock_reason = None
        d.generation_source = "manual"
        d.updated_at = datetime.now(timezone.utc)
        db.add(d)
        cleared += 1
    return cleared


@router.post("/profile/preferences/manual-mode")
def set_manual_mode(
    body: ManualModeBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if body.workout_manual_mode is None and body.meal_manual_mode is None:
        raise HTTPException(status_code=400, detail="Pass at least one flag")
    # Pro-only — gating both writes consistently. Free users who hit this
    # endpoint via curl get a clear 403 instead of a silent no-op.
    if not is_pro(current_user):
        raise HTTPException(
            status_code=403,
            detail="Manual mode is a Thallo Pro feature.",
        )

    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if prefs is None:
        prefs = UserPreferences(user_id=current_user.id)
        db.add(prefs)
        db.flush()

    cleared = 0
    workout_was_off = not bool(prefs.workout_manual_mode)
    if body.workout_manual_mode is not None:
        prefs.workout_manual_mode = bool(body.workout_manual_mode)
        if prefs.workout_manual_mode and workout_was_off:
            cleared = _wipe_future_undone_days(db, current_user.id)
    if body.meal_manual_mode is not None:
        prefs.meal_manual_mode = bool(body.meal_manual_mode)

    prefs.updated_at = datetime.now(timezone.utc)
    db.add(prefs)
    db.commit()
    db.refresh(prefs)
    return {
        "workout_manual_mode": bool(prefs.workout_manual_mode),
        "meal_manual_mode": bool(prefs.meal_manual_mode),
        "future_days_cleared": cleared,
    }


# ─── Per-day assign / clear ──────────────────────────────────────────────────

class UseTemplateBody(BaseModel):
    # Client-side uuid of the WorkoutTemplate to drop into this day.
    template_id: str


class GenerateWorkoutBody(BaseModel):
    focus: Literal[
        "push", "pull", "legs", "upper", "lower", "full_body",
        "cardio", "mobility", "recovery",
    ]
    stimulus: Literal["balanced", "heavy", "pump"] = "balanced"
    session_minutes: int | None = None


def _get_owned_day(
    db: Session, user_id: int, plan_week_id: int, day_index: int
) -> PlanDay:
    pw = db.get(PlanWeek, plan_week_id)
    if pw is None or pw.user_id != user_id:
        raise HTTPException(status_code=404, detail="Plan week not found")
    pd = db.exec(
        select(PlanDay)
        .where(PlanDay.plan_week_id == plan_week_id)
        .where(PlanDay.day_index == day_index)
    ).first()
    if pd is None:
        raise HTTPException(status_code=404, detail="Plan day not found")
    return pd


@router.post("/plan-weeks/{plan_week_id}/days/{day_index}/use-template")
def use_template_for_day(
    plan_week_id: int,
    day_index: int,
    body: UseTemplateBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not is_pro(current_user):
        raise HTTPException(
            status_code=403,
            detail="Assigning templates to days is a Thallo Pro feature.",
        )
    pd = _get_owned_day(db, current_user.id, plan_week_id, day_index)
    if pd.status in ("completed", "started"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot assign a template — this day is {pd.status}.",
        )
    template = db.exec(
        select(WorkoutTemplate)
        .where(WorkoutTemplate.user_id == current_user.id)
        .where(WorkoutTemplate.client_id == body.template_id)
    ).first()
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")

    # Snapshot — copy the dict so future template edits don't retroactively
    # change a day the user already assembled.
    pd.workout_json = dict(template.workout_json or {})
    pd.is_rest = False
    pd.status = "edited"
    pd.locked = True
    pd.lock_reason = "manual_edit"
    pd.generation_source = "manual"
    pd.updated_at = datetime.now(timezone.utc)
    db.add(pd)
    db.commit()
    db.refresh(pd)
    return _serialize_day(pd, source_template_id=template.client_id, source_template_name=template.name)


def _active_goal_for_user(db: Session, user_id: int, fallback: str | None = None) -> str:
    goal = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    if goal is not None and getattr(goal, "goal_type", None):
        return str(goal.goal_type.value if hasattr(goal.goal_type, "value") else goal.goal_type)
    return fallback or "body_recomp"


def _generation_goal(base_goal: str, stimulus: str) -> str:
    if stimulus == "heavy":
        return "strength"
    # Volume/pump variants are a hypertrophy feature in the deterministic
    # recipe. Use muscle_gain unless the user's own goal already carries
    # volume-friendly lifting archetypes.
    if stimulus == "pump" and base_goal not in {"muscle_gain", "body_recomp", "fat_loss", "toning"}:
        return "muscle_gain"
    return base_goal


def _preferred_split_for_focus(focus: str, fallback: str | None) -> str | None:
    if focus in {"push", "pull", "legs"}:
        return "ppl"
    if focus in {"upper", "lower"}:
        return "upper_lower"
    if focus == "full_body":
        return "full_body"
    return fallback


def _stimulus_override(stimulus: str) -> str | None:
    if stimulus == "heavy":
        return "strength"
    if stimulus == "pump":
        return "volume"
    if stimulus == "balanced":
        return "hypertrophy"
    return None


def _generation_days_per_week(focus: str, stimulus: str, prefs: UserPreferences | None, week: PlanWeek | None) -> int:
    base = int(
        getattr(week, "days_per_week", None)
        or getattr(prefs, "days_per_week", None)
        or 4
    )
    if stimulus == "pump" and focus in {"push", "pull", "legs"}:
        return max(base, 6)
    if focus in {"push", "pull", "legs"}:
        return max(base, 3)
    if focus in {"upper", "lower"}:
        return max(base, 2)
    return max(base, 1)


def _previous_manual_focuses(db: Session, plan_week_id: int, day_index: int) -> list[str]:
    rows = db.exec(
        select(PlanDay)
        .where(PlanDay.plan_week_id == plan_week_id)
        .where(PlanDay.day_index < day_index)
        .order_by(PlanDay.day_index)
    ).all()
    out: list[str] = []
    for row in rows:
        workout = row.workout_json
        if isinstance(workout, dict):
            focus = str(workout.get("focus") or "").strip()
            if focus:
                out.append(focus)
    return out


@router.post("/plan-weeks/{plan_week_id}/days/{day_index}/generate-workout")
def generate_workout_for_day(
    plan_week_id: int,
    day_index: int,
    body: GenerateWorkoutBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not is_pro(current_user):
        raise HTTPException(
            status_code=403,
            detail="Generated manual workouts are a Thallo Pro feature.",
        )

    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if prefs is None or not bool(prefs.workout_manual_mode):
        raise HTTPException(
            status_code=409,
            detail="Turn on manual workout planning before generating a manual day.",
        )

    pd = _get_owned_day(db, current_user.id, plan_week_id, day_index)
    if pd.status in ("completed", "started"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot generate a workout — this day is {pd.status}.",
        )
    week = db.get(PlanWeek, plan_week_id)
    base_goal = _active_goal_for_user(db, current_user.id, getattr(week, "goal", None))
    focus_label = body.focus.replace("_", " ").title()
    session_minutes = int(
        body.session_minutes
        or getattr(week, "session_minutes", None)
        or getattr(prefs, "workout_duration_minutes", None)
        or 60
    )
    session_minutes = max(20, min(session_minutes, 120))

    from app.routers.workouts import GenerateDayRequest, generate_single_day

    generated = generate_single_day(
        GenerateDayRequest(
            goal=_generation_goal(base_goal, body.stimulus),
            day_index=day_index,
            days_per_week=_generation_days_per_week(body.focus, body.stimulus, prefs, week),
            session_minutes=session_minutes,
            experience=str(getattr(prefs, "experience_level", None) or "intermediate"),
            equipment=list(getattr(prefs, "equipment", None) or []),
            preferred_split=_preferred_split_for_focus(body.focus, getattr(prefs, "preferred_split", None)),
            priority_region="balanced",
            injuries=list(getattr(prefs, "injuries", None) or []),
            injuries_structured=list(getattr(prefs, "injuries_structured", None) or []),
            focus_override=focus_label,
            stimulus_override=_stimulus_override(body.stimulus),
            prev_focuses=_previous_manual_focuses(db, plan_week_id, day_index),
        ),
        current_user=current_user,
        db=db,
    )
    day = dict(generated.get("day") or {})
    if not day.get("exercises"):
        raise HTTPException(status_code=500, detail="Planner produced no exercises")

    day["_source_context"] = "planned"
    pd.workout_json = day
    pd.is_rest = False
    pd.status = "edited"
    pd.locked = True
    pd.lock_reason = "manual_edit"
    pd.generation_source = "manual_generated"
    pd.updated_at = datetime.now(timezone.utc)
    db.add(pd)
    db.commit()
    db.refresh(pd)
    return _serialize_day(pd)


class MarkRestBody(BaseModel):
    is_rest: bool = True


@router.post("/plan-weeks/{plan_week_id}/days/{day_index}/mark-rest")
def mark_rest(
    plan_week_id: int,
    day_index: int,
    body: MarkRestBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not is_pro(current_user):
        raise HTTPException(
            status_code=403,
            detail="Manual mode is a Thallo Pro feature.",
        )
    pd = _get_owned_day(db, current_user.id, plan_week_id, day_index)
    if pd.status in ("completed", "started"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot change rest state — this day is {pd.status}.",
        )
    pd.is_rest = bool(body.is_rest)
    pd.workout_json = None
    pd.status = "edited" if body.is_rest else "unassigned"
    pd.locked = bool(body.is_rest)
    pd.lock_reason = "manual_edit" if body.is_rest else None
    pd.generation_source = "manual"
    pd.updated_at = datetime.now(timezone.utc)
    db.add(pd)
    db.commit()
    db.refresh(pd)
    return _serialize_day(pd)


@router.post("/plan-weeks/{plan_week_id}/days/{day_index}/clear")
def clear_day(
    plan_week_id: int,
    day_index: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not is_pro(current_user):
        raise HTTPException(
            status_code=403,
            detail="Manual mode is a Thallo Pro feature.",
        )
    pd = _get_owned_day(db, current_user.id, plan_week_id, day_index)
    if pd.status in ("completed", "started"):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot clear — this day is {pd.status}.",
        )
    pd.workout_json = None
    pd.is_rest = False
    pd.status = "unassigned"
    pd.locked = False
    pd.lock_reason = None
    pd.generation_source = "manual"
    pd.updated_at = datetime.now(timezone.utc)
    db.add(pd)
    db.commit()
    db.refresh(pd)
    return _serialize_day(pd)


def _serialize_day(
    pd: PlanDay,
    *,
    source_template_id: str | None = None,
    source_template_name: str | None = None,
) -> dict:
    return {
        "plan_week_id": pd.plan_week_id,
        "day_index": pd.day_index,
        "day_date": pd.day_date.isoformat(),
        "status": pd.status,
        "is_rest": pd.is_rest,
        "workout_json": pd.workout_json,
        "locked": pd.locked,
        "lock_reason": pd.lock_reason,
        "generation_source": pd.generation_source,
        "source_template_id": source_template_id,
        "source_template_name": source_template_name,
    }
