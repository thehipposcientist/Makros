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


class CompletedSetPayload(BaseModel):
    """One logged set from the mobile active-workout screen. Reps and
    weight are the actual values the user put in — not planned."""
    set_number: int
    reps: int = 0
    weight_lbs: float = 0.0
    duration_seconds: int | None = None  # for timed sets (plank, treadmill)
    feedback: str | None = None          # easy / good / hard / failure / pain
    rir: float | None = None


class CompletedExercisePayload(BaseModel):
    """One exercise from a finished mobile workout. `sets` is the list
    of sets the user actually logged — may be shorter than the planned
    target set count."""
    name: str
    target_sets: int | None = None
    target_reps: str | None = None
    equipment: str | None = None
    order_index: int = 0
    sets: list[CompletedSetPayload] = []


class WorkoutCompleteRequest(BaseModel):
    workout_date: date
    focus_label: str
    duration_seconds: int = 0
    stimulus: str | None = None  # strength/hypertrophy/volume/conditioning/etc.
    # ── NEW: optional per-exercise detail ─────────────────────────
    # When present, the completion path ALSO creates matching
    # WorkoutSession / WorkoutExercise / ExerciseSet rows so downstream
    # consumers (plan review, progression engine, analytics) can see
    # real per-set history instead of just the focus_label + duration.
    # Backward compatible — older mobile builds omit the field and
    # only the lightweight WorkoutCompletion row is written.
    exercises: list[CompletedExercisePayload] | None = None

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
            .where(ExerciseSet.workout_exercise_id == ex.id)
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
    # Only completed sessions contribute to progression history. Before
    # this filter an abandoned workout would show up as a "point" with
    # zeroed sets and break the plateau detector.
    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .where(WorkoutSession.completed_at.is_not(None))
        .order_by(WorkoutSession.workout_date.desc())
    ).all()

    points = []
    for s in sessions:
        ex_rows = db.exec(
            select(WorkoutExercise)
            .where(WorkoutExercise.session_id == s.id)
            # Case-insensitive exact match. `ilike(exercise_name)` without
            # wildcards was already case-insensitive by luck in Postgres
            # but required the exact name. Keep the same semantics but be
            # explicit so future devs don't "improve" it into a pattern.
            .where(WorkoutExercise.name.ilike(exercise_name))
        ).all()
        for ex in ex_rows:
            sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.workout_exercise_id == ex.id)
                .where(ExerciseSet.completed == True)  # noqa: E712
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


# ─── Workout start marker ─────────────────────────────────────────────────────


class WorkoutStartRequest(BaseModel):
    workout_date: date
    focus_label: str
    stimulus: str | None = None


@router.post("/start", status_code=201)
def mark_workout_started(
    body: WorkoutStartRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Mark a workout as started (in-progress). Creates a WorkoutCompletion
    row immediately so getWorkoutStatus returns done=true even if the
    finish call never arrives (app crash, phone dies, etc.).

    The finish endpoint upserts the same row with final duration."""
    existing = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == body.workout_date)
    ).first()
    if existing:
        return {"ok": True, "already_exists": True}
    db.add(WorkoutCompletion(
        user_id=current_user.id,
        workout_date=body.workout_date,
        focus_label=body.focus_label,
        duration_seconds=0,
        stimulus=body.stimulus,
        completed_at=datetime.now(timezone.utc),
    ))
    db.commit()
    return {"ok": True, "already_exists": False}


# ─── Workout completion ───────────────────────────────────────────────────────

@router.post("/complete", status_code=201)
def mark_workout_complete(
    body: WorkoutCompleteRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Record that the current user completed a workout on a given date.

    Two rows land in the DB on every completion:

      1. `WorkoutCompletion` — lightweight marker (date, focus, duration).
         Powers home screen + continuity rotation + calendar.
      2. `WorkoutSession` + `WorkoutExercise` + `ExerciseSet` rows, IF
         the mobile app included the optional `exercises` field. These
         give downstream systems (plan_review, progression engine,
         analytics) real per-set history instead of just a duration.
    """
    # Upsert the lightweight completion row.
    existing = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == body.workout_date)
    ).first()
    if existing:
        existing.focus_label      = body.focus_label
        existing.duration_seconds = body.duration_seconds
        existing.stimulus         = body.stimulus
        existing.completed_at     = datetime.now(timezone.utc)
        db.add(existing)
    else:
        db.add(WorkoutCompletion(
            user_id=current_user.id,
            workout_date=body.workout_date,
            focus_label=body.focus_label,
            duration_seconds=body.duration_seconds,
            stimulus=body.stimulus,
        ))

    # Also persist structured per-exercise data if the client sent it.
    # Best-effort: failures here must NOT block the lightweight
    # completion — the user has finished their workout and expects
    # the app to move on.
    session_rows_created = 0
    if body.exercises:
        try:
            from app.models import Exercise as _Exercise, WorkoutSource
            # Upsert WorkoutSession by (user, date, focus). If the same
            # (date, focus) pair already has a session, overwrite its
            # exercises so re-submitting a completion replaces rather
            # than duplicates — matches the lightweight-row upsert
            # above and protects against the user tapping Finish twice.
            existing_session = db.exec(
                select(WorkoutSession)
                .where(WorkoutSession.user_id == current_user.id)
                .where(WorkoutSession.workout_date == body.workout_date)
                .where(WorkoutSession.focus == body.focus_label)
            ).first()
            if existing_session:
                # Drop old exercises + sets so we can re-insert cleanly.
                old_exs = db.exec(
                    select(WorkoutExercise)
                    .where(WorkoutExercise.session_id == existing_session.id)
                ).all()
                for ox in old_exs:
                    old_sets = db.exec(
                        select(ExerciseSet)
                        .where(ExerciseSet.workout_exercise_id == ox.id)
                    ).all()
                    for os in old_sets:
                        db.delete(os)
                    db.delete(ox)
                existing_session.completed_at = datetime.now(timezone.utc)
                session_row = existing_session
                db.add(session_row)
                db.flush()
            else:
                session_row = WorkoutSession(
                    user_id=current_user.id,
                    name=body.focus_label or "Workout",
                    focus=body.focus_label or "",
                    workout_date=body.workout_date,
                    source=WorkoutSource.GENERATED,
                    completed_at=datetime.now(timezone.utc),
                )
                db.add(session_row)
                db.flush()

            for idx, ex_payload in enumerate(body.exercises):
                resolved_exercise_id = None
                if ex_payload.name:
                    seed = db.exec(
                        select(_Exercise).where(_Exercise.name.ilike(ex_payload.name))
                    ).first()
                    if seed is not None:
                        resolved_exercise_id = seed.id

                exercise = WorkoutExercise(
                    session_id=session_row.id,
                    exercise_id=resolved_exercise_id,
                    name=ex_payload.name,
                    order_index=ex_payload.order_index or idx,
                    equipment=ex_payload.equipment,
                    target_reps_text=ex_payload.target_reps,
                    rest_seconds=None,
                )
                db.add(exercise)
                db.flush()

                for set_payload in ex_payload.sets:
                    db.add(ExerciseSet(
                        workout_exercise_id=exercise.id,
                        set_number=set_payload.set_number,
                        actual_reps=set_payload.reps,
                        actual_weight_lbs=set_payload.weight_lbs,
                        rir_target=set_payload.rir,
                        completed=True,
                        completed_at=datetime.now(timezone.utc),
                    ))
            session_rows_created = 1
        except Exception as e:
            print(f"[workouts/complete] structured persistence failed (non-fatal): {e}")

    db.commit()
    return {"ok": True, "structured_persisted": bool(session_rows_created)}


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
        # Resolve canonical Exercise.id. Prefer the client-provided
        # `exercise_id` (set by plan-driven creates); fall back to a
        # case-insensitive name lookup so older plans and custom workouts
        # still end up linked to the seed row when possible. Rows that
        # don't match stay with `exercise_id=None` — history lookup falls
        # back to the free-text name path in that case.
        resolved_exercise_id = ex_body.exercise_id
        if resolved_exercise_id is None and ex_body.name:
            from app.models import Exercise as _Exercise  # local to avoid cycle
            seed = db.exec(
                select(_Exercise).where(_Exercise.name.ilike(ex_body.name))
            ).first()
            if seed is not None:
                resolved_exercise_id = seed.id

        exercise = WorkoutExercise(
            session_id=session_row.id,
            exercise_id=resolved_exercise_id,
            name=ex_body.name,
            order_index=ex_body.order_index,
            equipment=ex_body.equipment,
            notes=ex_body.notes,
            target_reps_text=ex_body.target_reps_text,
            rest_seconds=ex_body.rest_seconds,
        )
        db.add(exercise)
        db.flush()

        for set_body in ex_body.sets:
            db.add(ExerciseSet(
                workout_exercise_id=exercise.id,
                set_number=set_body.set_number,
                target_reps_min=set_body.target_reps_min,
                target_reps_max=set_body.target_reps_max,
                target_weight_lbs=set_body.target_weight_lbs,
                set_type=set_body.set_type,
                rpe_target=set_body.rpe_target,
                rir_target=set_body.rir_target,
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
