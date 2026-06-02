from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import ensure_pro
from app.models import PlanDay, PlanWeek, UserDayState, WatchCommandEvent
from app.services.readiness.compute import compute_readiness
from app.watch_auth import WatchAuthContext, get_current_watch_context

router = APIRouter(prefix="/watch", tags=["watch"])


def _today() -> date:
    return date.today()


def _parse_day(raw: Any) -> date:
    if isinstance(raw, str) and raw.strip():
        try:
            return date.fromisoformat(raw.strip()[:10])
        except ValueError:
            raise HTTPException(status_code=422, detail="Invalid date")
    return _today()


def _finite_float(raw: Any) -> float | None:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def _finite_int(raw: Any) -> int | None:
    value = _finite_float(raw)
    if value is None:
        return None
    return int(round(value))


def _watch_completion_payload(payload: dict[str, Any], command_id: str) -> dict[str, Any]:
    raw = payload.get("completion")
    if isinstance(raw, dict):
        completion = dict(raw)
    else:
        target_day = _parse_day(payload.get("dateISO") or payload.get("workout_date"))
        focus = str(payload.get("focusLabel") or payload.get("focus_label") or "Workout").strip() or "Workout"
        duration_seconds = (
            _finite_int(payload.get("durationSeconds"))
            or _finite_int(payload.get("duration_seconds"))
            or _finite_int(payload.get("elapsedSeconds"))
            or 0
        )
        completion = {
            "workout_date": target_day.isoformat(),
            "focus_label": focus,
            "duration_seconds": max(0, duration_seconds),
            "source_context": str(payload.get("sourceContext") or payload.get("source_context") or "watch"),
        }
        distance_meters = _finite_float(payload.get("distanceMeters"))
        if distance_meters and distance_meters > 0:
            completion["distance_miles"] = distance_meters / 1000.0 * 0.6213711922
            completion["activity_category"] = "cardio"
            completion["activity_source"] = "watch"
        calories = _finite_float(payload.get("activeCalories"))
        if calories and calories > 0:
            completion["calories_burned"] = int(round(calories))
        bpm = _finite_int(payload.get("heartRate"))
        if bpm and bpm > 0:
            completion["hr_summary"] = {"avgBpm": bpm, "maxBpm": bpm, "zoneMinutes": []}

    source_id = str(
        completion.get("external_source_id")
        or completion.get("idempotency_key")
        or payload.get("completionId")
        or payload.get("sessionId")
        or command_id
    ).strip()
    if not source_id.startswith("watch:"):
        source_id = f"watch:{source_id}"
    completion["external_source_id"] = str(completion.get("external_source_id") or source_id)
    completion["idempotency_key"] = str(completion.get("idempotency_key") or source_id)
    completion["source_context"] = str(completion.get("source_context") or "watch")
    return completion


def _apply_end_workout_command(
    db: Session,
    ctx: WatchAuthContext,
    command_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete

    completion = _watch_completion_payload(payload, command_id)
    request = WorkoutCompleteRequest(**completion)
    result = mark_workout_complete(request, ctx.user, db)
    return dict(result or {"ok": True})


def _apply_hydration_command(
    db: Session,
    user_id: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    target_day = _parse_day(payload.get("dateISO") or payload.get("log_date"))
    delta_oz = _finite_float(payload.get("deltaOz", payload.get("delta_oz")))
    ounces = _finite_float(payload.get("ounces"))
    if delta_oz is None and ounces is None:
        raise HTTPException(status_code=422, detail="Provide either delta_oz or ounces")
    if delta_oz is not None and (delta_oz < -400 or delta_oz > 400):
        raise HTTPException(status_code=422, detail="Invalid hydration delta")
    if delta_oz is None and (ounces is None or ounces < 0 or ounces > 400):
        raise HTTPException(status_code=422, detail="Invalid hydration total")

    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == user_id)
        .where(UserDayState.day_key == target_day)
        .with_for_update()
    ).first()
    if state is None:
        state = UserDayState(user_id=user_id, day_key=target_day)
        db.add(state)
        db.flush()

    plan = dict(state.nutrition_plan or {})
    prior = _finite_float(plan.get("_hydration_oz")) or 0.0
    if delta_oz is not None:
        next_total = max(0.0, round((prior + delta_oz) * 10) / 10)
    else:
        next_total = max(0.0, round(float(ounces or 0) * 10) / 10)
    plan["_hydration_oz"] = next_total
    state.nutrition_plan = plan
    db.add(state)
    return {"date": target_day.isoformat(), "ounces": next_total}


@router.get("/session")
def watch_session(ctx: WatchAuthContext = Depends(get_current_watch_context)):
    return {
        "ok": True,
        "user_id": ctx.user.id,
        "device_id": ctx.device.device_id,
        "expires_at": ctx.device.expires_at,
        "server_time": datetime.now(timezone.utc),
    }


@router.get("/snapshot")
def watch_snapshot(
    ctx: WatchAuthContext = Depends(get_current_watch_context),
    db: Session = Depends(get_session),
):
    today = _today()
    week = db.exec(
        select(PlanWeek)
        .where(PlanWeek.user_id == ctx.user.id)
        .where(PlanWeek.status == "active")
        .where(PlanWeek.start_date <= today)
        .where(PlanWeek.end_date >= today)
        .order_by(PlanWeek.start_date.desc(), PlanWeek.id.desc())
    ).first()
    days: list[PlanDay] = []
    today_day: PlanDay | None = None
    if week is not None and week.id is not None:
        days = list(db.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == week.id)
            .order_by(PlanDay.day_index)
        ).all())
        today_day = next((day for day in days if day.day_date == today), None)
    day_state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == ctx.user.id)
        .where(UserDayState.day_key == today)
    ).first()
    hydration_oz = 0.0
    if day_state and day_state.nutrition_plan:
        hydration_oz = _finite_float(day_state.nutrition_plan.get("_hydration_oz")) or 0.0
    return {
        "schemaVersion": 1,
        "serverTime": datetime.now(timezone.utc),
        "userId": ctx.user.id,
        "planWeek": None if week is None else {
            "id": week.id,
            "startDate": week.start_date,
            "endDate": week.end_date,
            "status": week.status,
        },
        "today": None if today_day is None else {
            "dateISO": today_day.day_date.isoformat(),
            "dayIndex": today_day.day_index,
            "status": today_day.status,
            "isRest": today_day.is_rest,
            "workout": today_day.workout_json,
            "nutrition": today_day.nutrition_json,
        },
        "hydration": {
            "dateISO": today.isoformat(),
            "ounces": hydration_oz,
        },
    }


@router.get("/readiness")
def watch_readiness(
    ctx: WatchAuthContext = Depends(get_current_watch_context),
    db: Session = Depends(get_session),
):
    ensure_pro(ctx.user, "Readiness tracking")
    return compute_readiness(db, ctx.user.id).to_dict()


@router.post("/commands")
def apply_watch_command(
    body: dict[str, Any] = Body(...),
    ctx: WatchAuthContext = Depends(get_current_watch_context),
    db: Session = Depends(get_session),
):
    command = str(body.get("command") or "").strip()
    command_id = str(body.get("commandId") or body.get("command_id") or "").strip()
    if not command:
        raise HTTPException(status_code=422, detail="Missing command")
    if not command_id:
        raise HTTPException(status_code=422, detail="Missing commandId")

    existing = db.exec(
        select(WatchCommandEvent)
        .where(WatchCommandEvent.user_id == ctx.user.id)
        .where(WatchCommandEvent.command_id == command_id)
    ).first()
    if existing is not None:
        return {
            "ok": existing.status == "applied",
            "duplicate": True,
            "command": command,
            "result": existing.result_json,
        }

    event = WatchCommandEvent(
        user_id=ctx.user.id,
        watch_device_id=ctx.device.id,
        command_id=command_id,
        command=command,
        payload=body,
    )
    db.add(event)
    db.flush()

    if command == "log_hydration":
        result = _apply_hydration_command(db, ctx.user.id, body)
    elif command == "end_workout":
        result = _apply_end_workout_command(db, ctx, command_id, body)
    else:
        event.status = "unsupported"
        event.error = f"Unsupported watch cellular command: {command}"
        db.add(event)
        db.commit()
        raise HTTPException(status_code=422, detail=event.error)

    event.status = "applied"
    event.result_json = result
    event.applied_at = datetime.now(timezone.utc)
    db.add(event)
    db.commit()
    return {
        "ok": True,
        "duplicate": False,
        "command": command,
        "result": result,
    }
