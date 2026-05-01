"""Progress-insight endpoints — weekly digest + plateau detection.

Deterministic, no AI. The router is registered on the shared ``/ai``
prefix because the client already points its coaching UI there; these
endpoints are conceptually the same family (coaching insights derived
from workout/nutrition history) even though no LLM is invoked.
"""
from __future__ import annotations

from fastapi import Depends
from sqlmodel import Session

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import User

from .router import router


@router.get("/weekly-digest")
def weekly_digest(
    current_user: User = Depends(require_pro_feature("Weekly progress digest")),
    db: Session = Depends(get_session),
):
    """Return the Sunday-style weekly review payload.

    Backed by ``build_weekly_digest``. See that service for shape + field
    semantics. Response is always 200; empty weeks return zeroed counts.
    """
    from app.services.workout.weekly_digest import build_weekly_digest
    return build_weekly_digest(current_user.id, db=db)


@router.get("/adherence-trend")
def adherence_trend(
    weeks: int = 8,
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Per-week adherence data for the last N weeks (default 8).

    Each entry: {week_start, week_end, planned, completed, compliance_pct, total_volume}.
    Sorted oldest-first.
    """
    from app.services.workout.streak import build_adherence_trend
    return {"weeks": build_adherence_trend(current_user.id, db=db, weeks=max(1, min(weeks, 52)))}


@router.get("/plateaus")
def plateaus(
    window_weeks: int = 4,
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Return exercises where the user's estimated 1RM has stalled.

    Query params:
      - window_weeks (default 4) — how many weeks' peaks must be within
        the tolerance band to be flagged as a plateau.
    """
    from app.services.workout.plateau_detection import detect_plateaus
    return {"plateaus": detect_plateaus(current_user.id, db=db, window_weeks=window_weeks)}


@router.get("/muscle-balance")
def muscle_balance(
    days: int = 14,
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Per-muscle set volume distribution over the last N days.

    Counts completed sets per primary_muscle (full credit) and
    secondary_muscles (half credit). Returns percentage breakdown
    and a 0-100 balance score measuring evenness across the 8 main
    lifting muscles (chest, back, shoulders, biceps, triceps, quads,
    hamstrings, glutes).
    """
    from datetime import date as date_type, timedelta
    from sqlmodel import select
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet, Exercise

    cutoff = date_type.today() - timedelta(days=days)

    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .where(WorkoutSession.workout_date >= cutoff)
    ).all()
    session_ids = [s.id for s in sessions]

    if not session_ids:
        return {
            "muscles": {},
            "period_days": days,
            "total_sets": 0,
            "balance_score": 0,
        }

    exercises = db.exec(
        select(WorkoutExercise).where(WorkoutExercise.session_id.in_(session_ids))
    ).all()
    we_ids = [we.id for we in exercises]

    completed_sets: dict[int, int] = {}
    if we_ids:
        sets_rows = db.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id.in_(we_ids))
            .where(ExerciseSet.completed == True)  # noqa: E712
        ).all()
        for s in sets_rows:
            completed_sets[s.workout_exercise_id] = completed_sets.get(s.workout_exercise_id, 0) + 1

    ex_cache: dict[str, Exercise | None] = {}
    def _lookup(name: str) -> Exercise | None:
        if name not in ex_cache:
            ex_cache[name] = db.exec(
                select(Exercise).where(Exercise.name == name)
            ).first()
        return ex_cache[name]

    muscle_sets: dict[str, float] = {}
    for we in exercises:
        n = completed_sets.get(we.id, 0)
        if n == 0:
            continue
        ex = _lookup(we.name)
        if not ex:
            continue
        pm = ex.primary_muscle.value if hasattr(ex.primary_muscle, "value") else str(ex.primary_muscle)
        muscle_sets[pm] = muscle_sets.get(pm, 0) + n
        for sm in (ex.secondary_muscles or []):
            key = sm.value if hasattr(sm, "value") else str(sm)
            muscle_sets[key] = muscle_sets.get(key, 0) + n * 0.5

    total = sum(muscle_sets.values()) or 1
    muscles = {
        m: {"sets": round(v, 1), "pct": round(v / total * 100, 1)}
        for m, v in sorted(muscle_sets.items(), key=lambda x: -x[1])
    }

    BALANCE_MUSCLES = {"chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings", "glutes"}
    bal_vals = [muscle_sets.get(m, 0) for m in BALANCE_MUSCLES]
    bal_total = sum(bal_vals) or 1
    ideal = bal_total / len(BALANCE_MUSCLES)
    deviation = sum(abs(v - ideal) for v in bal_vals) / bal_total
    balance_score = max(0, min(100, round(100 * (1 - deviation))))

    return {
        "muscles": muscles,
        "period_days": days,
        "total_sets": round(total, 1),
        "balance_score": balance_score,
    }
