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
    import re
    from sqlmodel import select
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet, Exercise

    cutoff = date_type.today() - timedelta(days=days)

    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .where(WorkoutSession.workout_date >= cutoff)
        .where(WorkoutSession.completed_at.is_not(None))
    ).all()
    def _is_non_strength_focus(focus: str | None) -> bool:
        value = (focus or "").strip().lower()
        if not value or "+" in value:
            return False
        return value in {
            "cardio",
            "zone 2 cardio",
            "conditioning",
            "endurance",
            "mobility",
            "mobility day",
            "recovery",
            "recovery day",
            "rest",
            "stretch",
        }

    session_ids = [
        s.id for s in sessions
        if s.id is not None and not _is_non_strength_focus(s.focus)
    ]

    if not session_ids:
        return {
            "muscles": {},
            "period_days": days,
            "total_sets": 0,
            "balance_score": 0,
        }

    def _muscle_to_str(value) -> str:
        if value is None:
            return ""
        if hasattr(value, "value"):
            return str(value.value).strip().lower()
        return str(value).strip().lower()

    def _muscles_to_list(value) -> list[str]:
        if not value:
            return []
        if isinstance(value, list):
            return [_muscle_to_str(v) for v in value if _muscle_to_str(v)]
        return [_muscle_to_str(value)]

    EXCLUDED_BUCKETS = {"", "full_body", "cardio", "mobility", "recovery", "stretch", "systemic"}
    SKIPPED_SET_TYPES = {"warmup", "warm_up", "mobility", "recovery"}
    SKIPPED_ACTIVITY_TYPES = {"cardio", "conditioning", "mobility", "recovery", "stretch"}
    skipped_exercise_re = re.compile(
        r"treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|"
        r"battle rope|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|"
        r"cardio|zone.?2|tempo (run|ride|bike|row|swim)|boxing|kickboxing|bag.?work|"
        r"shadow.?box|yoga|vinyasa|pilates|mobility|stretch|foam.?roll|recovery flow|"
        r"child.?s pose|seated forward fold|spinal twist|couch stretch|deep squat hold|"
        r"90/90|cat.?cow|thread.?the.?needle|dead hang|wall sit|hollow.?hold|plank|burpee",
        re.I,
    )

    rows = db.exec(
        select(
            WorkoutExercise.id,
            WorkoutExercise.name,
            Exercise.primary_muscle,
            Exercise.secondary_muscles,
            Exercise.exercise_type,
            Exercise.movement_pattern,
            WorkoutExercise.primary_muscle_snapshot,
            WorkoutExercise.secondary_muscles_snapshot,
            ExerciseSet.set_type,
        )
        .outerjoin(Exercise, WorkoutExercise.exercise_id == Exercise.id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .where(WorkoutExercise.session_id.in_(session_ids))
        .where(ExerciseSet.completed == True)  # noqa: E712
    ).all()

    muscle_sets: dict[str, float] = {}
    for _we_id, name, pm, sm, exercise_type, movement_pattern, pm_snapshot, sm_snapshot, set_type in rows:
        if (set_type or "working").lower() in SKIPPED_SET_TYPES:
            continue
        if _muscle_to_str(exercise_type) in SKIPPED_ACTIVITY_TYPES:
            continue
        if _muscle_to_str(movement_pattern) in SKIPPED_ACTIVITY_TYPES:
            continue
        if skipped_exercise_re.search(name or ""):
            continue
        primary = _muscle_to_str(pm_snapshot) or _muscle_to_str(pm)
        secondaries = _muscles_to_list(sm_snapshot) or _muscles_to_list(sm)
        if primary not in EXCLUDED_BUCKETS:
            muscle_sets[primary] = muscle_sets.get(primary, 0) + 1.0
        for secondary in secondaries:
            if secondary in EXCLUDED_BUCKETS:
                continue
            muscle_sets[secondary] = muscle_sets.get(secondary, 0) + 0.5

    if not muscle_sets:
        return {
            "muscles": {},
            "period_days": days,
            "total_sets": 0,
            "balance_score": 0,
        }

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
