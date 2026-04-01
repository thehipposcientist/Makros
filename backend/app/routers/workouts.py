from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select
from datetime import datetime, date, timezone
from pydantic import BaseModel

from app.database import get_session
from app.models import (
    User, WorkoutSession, WorkoutExercise, ExerciseSet,
    WorkoutSessionCreate, SetLog, WorkoutCompletion,
)
from app.auth import get_current_user


class WorkoutCompleteRequest(BaseModel):
    workout_date: date
    focus_label: str
    duration_seconds: int = 0

router = APIRouter(prefix="/workouts", tags=["workouts"])


def _build_session_response(session_row: WorkoutSession, db: Session) -> dict:
    """Assemble nested session → exercises → sets response."""
    exercises = db.exec(
        select(WorkoutExercise)
        .where(WorkoutExercise.session_id == session_row.id)
        .order_by(WorkoutExercise.order_index)
    ).all()

    exercise_data = []
    for ex in exercises:
        sets = db.exec(
            select(ExerciseSet)
            .where(ExerciseSet.exercise_id == ex.id)
            .order_by(ExerciseSet.set_number)
        ).all()
        exercise_data.append({**ex.model_dump(), "sets": [s.model_dump() for s in sets]})

    return {**session_row.model_dump(), "exercises": exercise_data}


@router.get("/progression/{exercise_name}")
def progression_insights(
    exercise_name: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Returns progression trend and plateau hint for a given exercise name."""
    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .order_by(WorkoutSession.workout_date.desc())
    ).all()

    points = []
    for s in sessions:
        ex_rows = db.exec(
            select(WorkoutExercise)
            .where(WorkoutExercise.session_id == s.id)
            .where(WorkoutExercise.name.ilike(exercise_name))
        ).all()
        for ex in ex_rows:
            sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.exercise_id == ex.id)
                .where(ExerciseSet.completed == True)
            ).all()
            if not sets:
                continue
            best = max(sets, key=lambda x: (x.actual_weight_lbs or 0) * (x.actual_reps or 0))
            score = (best.actual_weight_lbs or 0) * (best.actual_reps or 0)
            points.append({
                "date": str(s.workout_date),
                "weight_lbs": best.actual_weight_lbs or 0,
                "reps": best.actual_reps or 0,
                "score": round(score, 1),
            })

    points = sorted(points, key=lambda p: p["date"])
    recent = points[-6:]

    plateau = False
    suggestion = "Keep progressive overload with small weight or rep increases."
    if len(recent) >= 4:
        best_before_last3 = max((p["score"] for p in recent[:-3]), default=0)
        best_last3 = max((p["score"] for p in recent[-3:]), default=0)
        plateau = best_last3 <= best_before_last3
        if plateau:
            suggestion = "Plateau detected: reduce load by 5-10% for one week, then rebuild with +1 rep progression."

    return {
        "exercise": exercise_name,
        "recent": recent,
        "plateau": plateau,
        "suggestion": suggestion,
    }


# ─── Workout completion ───────────────────────────────────────────────────────

@router.post("/complete", status_code=201)
def mark_workout_complete(
    body: WorkoutCompleteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Record that the current user completed a workout on a given date."""
    # Upsert: remove any existing completion for this user+date, then insert fresh
    existing = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == body.workout_date)
    ).first()
    if existing:
        existing.focus_label      = body.focus_label
        existing.duration_seconds = body.duration_seconds
        existing.completed_at     = datetime.now(timezone.utc)
        db.add(existing)
    else:
        db.add(WorkoutCompletion(
            user_id=current_user.id,
            workout_date=body.workout_date,
            focus_label=body.focus_label,
            duration_seconds=body.duration_seconds,
        ))
    db.commit()
    return {"ok": True}


@router.get("/status")
def get_workout_status(
    workout_date: date = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Returns whether the user has a completed workout on the given date."""
    completion = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == workout_date)
    ).first()
    return {"done": completion is not None}


# ─── Create ───────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
def create_workout(
    body: WorkoutSessionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    session_row = WorkoutSession(
        user_id=current_user.id,
        name=body.name,
        focus=body.focus,
        workout_date=body.workout_date,
        source=body.source,
        notes=body.notes,
    )
    db.add(session_row)
    db.flush()  # get session_row.id before committing

    for ex_body in body.exercises:
        exercise = WorkoutExercise(
            session_id=session_row.id,
            name=ex_body.name,
            order_index=ex_body.order_index,
            equipment=ex_body.equipment,
            notes=ex_body.notes,
        )
        db.add(exercise)
        db.flush()

        for set_body in ex_body.sets:
            db.add(ExerciseSet(
                exercise_id=exercise.id,
                set_number=set_body.set_number,
                target_reps=set_body.target_reps,
                target_weight_lbs=set_body.target_weight_lbs,
            ))

    db.commit()
    db.refresh(session_row)
    return _build_session_response(session_row, db)


# ─── List ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_workouts(
    workout_date: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    query = select(WorkoutSession).where(WorkoutSession.user_id == current_user.id)
    if workout_date:
        query = query.where(WorkoutSession.workout_date == workout_date)
    sessions = db.exec(query.order_by(WorkoutSession.workout_date.desc())).all()
    return [_build_session_response(s, db) for s in sessions]


# ─── Get one ──────────────────────────────────────────────────────────────────

@router.get("/{session_id}")
def get_workout(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    session_row = db.get(WorkoutSession, session_id)
    if not session_row or session_row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Workout not found")
    return _build_session_response(session_row, db)


# ─── Log a completed set ──────────────────────────────────────────────────────

@router.patch("/{session_id}/sets/{set_id}")
def log_set(
    session_id: int,
    set_id: int,
    body: SetLog,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    # Verify the session belongs to this user
    session_row = db.get(WorkoutSession, session_id)
    if not session_row or session_row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Workout not found")

    exercise_set = db.get(ExerciseSet, set_id)
    if not exercise_set:
        raise HTTPException(status_code=404, detail="Set not found")

    exercise_set.actual_reps = body.actual_reps
    exercise_set.actual_weight_lbs = body.actual_weight_lbs
    exercise_set.rpe = body.rpe
    exercise_set.completed = True
    exercise_set.completed_at = datetime.now(timezone.utc)
    db.add(exercise_set)

    # Mark session complete if all sets are done
    all_sets = db.exec(
        select(ExerciseSet)
        .join(WorkoutExercise)
        .where(WorkoutExercise.session_id == session_id)
    ).all()
    if all(s.completed for s in all_sets):
        session_row.completed_at = datetime.now(timezone.utc)
        db.add(session_row)

    db.commit()
    db.refresh(exercise_set)
    return exercise_set


# ─── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/{session_id}", status_code=204)
def delete_workout(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    session_row = db.get(WorkoutSession, session_id)
    if not session_row or session_row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Workout not found")

    # Cascade delete sets → exercises → session
    exercises = db.exec(
        select(WorkoutExercise).where(WorkoutExercise.session_id == session_id)
    ).all()
    for ex in exercises:
        for s in db.exec(select(ExerciseSet).where(ExerciseSet.exercise_id == ex.id)).all():
            db.delete(s)
        db.delete(ex)
    db.delete(session_row)
    db.commit()
