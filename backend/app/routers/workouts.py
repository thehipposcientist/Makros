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

import logging
logger = logging.getLogger(__name__)


def _infer_focus_from_muscles(top_muscles: list[str]) -> str | None:
    """Infer a focus label from the top worked muscle groups."""
    s = set(top_muscles[:4])
    if s & {'quads', 'hamstrings', 'glutes', 'calves'}:
        if not (s & {'chest', 'back', 'shoulders'}):
            return 'Legs'
        return 'Full Body'
    if s & {'chest', 'triceps'} and not (s & {'back', 'biceps'}):
        return 'Push'
    if s & {'back', 'biceps'} and not (s & {'chest', 'triceps'}):
        return 'Pull'
    if s & {'chest', 'back', 'shoulders'}:
        return 'Upper Body'
    return None


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
    activity_category: str | None = None
    activity_subtype: str | None = None
    activity_intensity: str | None = None
    activity_source: str | None = None
    cardio_style: str | None = None

# ─── Response models ──────────────────────────────────────────────────────────

class WorkoutStatusResponse(BaseModel):
    done: bool


class MuscleFatigueEntry(BaseModel):
    muscle: str
    value: float


class NutritionContext(BaseModel):
    protein_avg: float = 0
    protein_status: str = "unknown"
    message: str | None = None
    recovery_bonus_applied: bool = False
    calories_avg: float | None = None


class FatigueScoreResponse(BaseModel):
    readiness_score: int
    readiness_label: str
    muscle_fatigue: dict[str, float]
    focus_readiness: dict[str, float]
    top_fatigued: list[MuscleFatigueEntry]
    blocked_focuses: list[str]
    days_analyzed: int
    activities: list[dict]
    nutrition_context: NutritionContext


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
        activity_category=body.activity_category,
        activity_subtype=body.activity_subtype,
        activity_intensity=body.activity_intensity,
        activity_source=body.activity_source,
        cardio_style=body.cardio_style,
        completed_at=datetime.now(timezone.utc),
    ))
    db.commit()
    return {"ok": True, "already_exists": False}


# ─── Per-day workout generation ───────────────────────────────────────────────


class GenerateDayRequest(BaseModel):
    """Generate one day's workout exercises using the planner with history."""
    goal: str
    day_index: int = 0                     # position in the recipe rotation
    days_per_week: int = 4
    session_minutes: int = 60
    experience: str = "intermediate"
    equipment: list[str] = []
    preferred_split: str | None = None
    priority_region: str = "balanced"
    focused_muscle: str | None = None
    injuries: list[str] = []
    disliked_exercises: list[str] = []     # exercises to exclude from selection
    focus_override: str | None = None      # force a specific focus (e.g. "Legs")


@router.post("/generate-day")
def generate_single_day(
    body: GenerateDayRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    print(f"[generate-day] ENTRY: session_minutes={body.session_minutes} focus_override={body.focus_override!r} goal={body.goal}")
    """Generate exercises for ONE day using the full deterministic planner
    pipeline with the user's recent history. The recipe (split structure)
    is computed fresh each time so the day type matches the rotation, and
    exercise selection uses the last 14 days of history to avoid repeats.

    This replaces the old "rotate through cached 7-day plan" approach
    with fresh per-day generation that varies exercises across sessions."""
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        build_history_familiarity, most_recent_completed_focus,
        recent_exercise_slugs_by_muscle,
    )

    # Resolve equipment slugs
    from app.routers.ai.plans import _resolve_owned_equipment_slugs
    owned_slugs = _resolve_owned_equipment_slugs(body.equipment)

    # Get recent history for rotation + exercise variation
    recent_focus_buckets: tuple[str, ...] = ()
    recent_focus_families: tuple[str, ...] = ()
    history_familiarity: dict[str, int] = {}
    recent_muscle_exercises: dict[str, set[str]] = {}
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass
    try:
        history_familiarity = build_history_familiarity(current_user.id, db)
    except Exception:
        pass
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(current_user.id, db)
    except Exception:
        pass

    # Get muscle-group fatigue to influence day selection
    fatigue_snapshot = None
    fatigue_readiness = 100
    try:
        from app.services.workout.history import get_recent_completions_for_fatigue
        from app.services.workout.activity_impact import compute_rolling_fatigue
        completions = get_recent_completions_for_fatigue(current_user.id, db)
        if completions:
            fatigue_snapshot = compute_rolling_fatigue(completions)
            # Apply injury-based fatigue boosts so readiness reflects injured muscles
            from app.services.workout.planner import injury_muscle_fatigue_boost
            injury_boosts = injury_muscle_fatigue_boost(tuple(body.injuries))
            for muscle, boost in injury_boosts.items():
                current = fatigue_snapshot.muscle_fatigue.get(muscle)
                fatigue_snapshot.muscle_fatigue.add(muscle, boost)
            if injury_boosts:
                # Recompute readiness and focus readiness after applying boosts
                from app.services.workout.activity_impact import derive_all_readiness
                fatigue_snapshot.focus_readiness = derive_all_readiness(fatigue_snapshot.muscle_fatigue)
                avg_fatigue = sum(fatigue_snapshot.muscle_fatigue.get(m) for m in ("chest", "back", "shoulders", "quads", "hamstrings", "glutes", "core")) / 7
                fatigue_snapshot.readiness_score = round(max(0, (1 - avg_fatigue) * 100))
                logger.debug(f"[generate-day] injury fatigue boost applied: {injury_boosts}")
            fatigue_readiness = fatigue_snapshot.readiness_score
            logger.debug(f"[generate-day] fatigue: readiness={fatigue_readiness} focus_readiness={fatigue_snapshot.focus_readiness}")
    except Exception as e:
        logger.debug(f"[generate-day] fatigue check failed: {e}")

    # Build planner inputs
    inputs = PlannerInputs(
        goal=body.goal,
        days_per_week=body.days_per_week,
        session_minutes=body.session_minutes,
        experience=body.experience.lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=body.preferred_split,
        focused_muscle=body.focused_muscle,
        priority_region=body.priority_region,
        injuries=tuple(body.injuries),
        disliked_exercises=tuple(body.disliked_exercises),
        rng_seed=current_user.id + body.day_index,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=fatigue_snapshot.muscle_fatigue.to_dict() if fatigue_snapshot else None,
    )

    # Generate full plan (fast — deterministic, no AI)
    plan = generate_workout_plan(
        inputs, SEED_EXERCISES,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )

    days = plan.get("workout_plan", {}).get("days", [])
    if not days:
        raise HTTPException(status_code=500, detail="Planner produced no days")

    # Enrich exercises with image URLs from the DB
    try:
        from app.models import Exercise as ExModel
        ex_names = set()
        for d in days:
            for ex in d.get("exercises", []):
                ex_names.add(ex.get("name", ""))
        if ex_names:
            img_rows = db.exec(
                select(ExModel.name, ExModel.image_url)
                .where(ExModel.name.in_(ex_names))
                .where(ExModel.image_url != None)
            ).all()
            img_map = {r[0]: r[1] for r in img_rows}
            for d in days:
                for ex in d.get("exercises", []):
                    url = img_map.get(ex.get("name"))
                    if url:
                        ex["image_url"] = url
    except Exception:
        pass

    # Pick the requested day from the generated plan.
    idx = body.day_index % len(days)
    day = days[idx]

    # Focus override: user explicitly chose a focus (e.g. tapped "Legs").
    # Find the recipe day that matches, so exercises are correct for that focus.
    if body.focus_override:
        override_lower = body.focus_override.lower().strip()

        # Special focus types that need a generated day, not a recipe match
        if override_lower in ("recovery", "active recovery"):
            from app.services.workout.planner import generate_recovery_day, _est_exercise_time
            day = generate_recovery_day(body.session_minutes or 45)
            est = sum(_est_exercise_time(ex) for ex in day.get("exercises", []))
            print(f"[generate-day] Recovery: session_minutes={body.session_minutes} exercises={len(day.get('exercises',[]))} est_time={est:.0f}min")
        elif override_lower in ("mobility", "stretching"):
            from app.services.workout.planner import generate_mobility_day, _est_exercise_time
            day = generate_mobility_day(body.session_minutes or 45)
            est = sum(_est_exercise_time(ex) for ex in day.get("exercises", []))
            print(f"[generate-day] Mobility: session_minutes={body.session_minutes} exercises={len(day.get('exercises',[]))} est_time={est:.0f}min")
        elif override_lower == "cardio":
            from app.services.workout.planner import generate_cardio_day
            day = generate_cardio_day(body.session_minutes or 45, body.goal or "body_recomp")
            logger.debug("[generate-day] focus override → generated Cardio day")
        else:
            for alt_idx, alt_day in enumerate(days):
                if alt_day.get("focus", "").lower().strip() == override_lower:
                    day = alt_day
                    idx = alt_idx
                    logger.debug(f"[generate-day] focus override '{body.focus_override}' → day {alt_idx}")
                    break
            else:
                day = {**day, "focus": body.focus_override}
                logger.debug(f"[generate-day] focus override '{body.focus_override}' — no matching recipe day, relabeled day {idx}")

    # Graduated fatigue response — 5 tiers from force-recovery to proceed
    if fatigue_snapshot and not body.focus_override:
        from app.services.workout.focus_normalize import normalize_focus_to_family
        day_family = normalize_focus_to_family(day.get("focus", ""))
        day_readiness = fatigue_snapshot.focus_readiness.get(day_family, 1.0) if day_family else 1.0
        systemic = fatigue_snapshot.muscle_fatigue.systemic

        # TIER 0: Force recovery when systemically overtrained
        if fatigue_snapshot.readiness_score < 20 or systemic > 0.8:
            day = {
                "day": day.get("day", "Day 1"),
                "focus": "Recovery",
                "stimulus": "recovery",
                "exercises": [],
                "_forced_recovery": True,
            }
            logger.debug(f"[generate-day] FORCE RECOVERY: readiness={fatigue_snapshot.readiness_score}% systemic={systemic:.2f}")

        elif day_readiness < 0.2:
            # TIER 1: swap to most ready alternative
            best_alt, best_readiness = None, -1.0
            for alt_idx, alt_day in enumerate(days):
                alt_fam = normalize_focus_to_family(alt_day.get("focus", ""))
                alt_r = fatigue_snapshot.focus_readiness.get(alt_fam, 1.0) if alt_fam else 1.0
                if alt_r > best_readiness:
                    best_readiness = alt_r
                    best_alt = (alt_idx, alt_day)
            if best_alt and best_readiness > day_readiness + 0.2:
                logger.debug(f"[generate-day] fatigue swap: {day_family}({day_readiness:.0%}) → {normalize_focus_to_family(best_alt[1].get('focus',''))}({best_readiness:.0%})")
                idx, day = best_alt

        elif day_readiness < 0.4:
            # TIER 2: downgrade stimulus aggressively
            if day.get("stimulus") in ("strength", "power"):
                day = {**day, "stimulus": "hypertrophy"}
                logger.debug(f"[generate-day] fatigue downgrade: {day_family} readiness={day_readiness:.0%} → hypertrophy")
            elif day.get("stimulus") == "hypertrophy":
                day = {**day, "stimulus": "volume"}
                logger.debug(f"[generate-day] fatigue downgrade: {day_family} readiness={day_readiness:.0%} → volume")

        elif day_readiness < 0.6:
            # TIER 3: heavy → hypertrophy only
            if day.get("stimulus") in ("strength", "power"):
                day = {**day, "stimulus": "hypertrophy"}
                logger.debug(f"[generate-day] fatigue downgrade: {day_family} readiness={day_readiness:.0%} → hypertrophy")

        # TIER 4 (≥0.6): proceed as planned — no changes

    # Mixed-day partial adaptation: reduce volume for fatigued muscles
    # within a day while preserving fresh muscles
    if fatigue_snapshot and day.get("exercises") and not day.get("_forced_recovery"):
        mf_dict = fatigue_snapshot.muscle_fatigue.to_dict()
        adapted = []
        for ex in day["exercises"]:
            primary = ex.get("_primary_muscle", "")
            fl = mf_dict.get(primary, 0.0)
            role = ex.get("_role", "")
            if role in ("warmup", "core"):
                adapted.append(ex)
            elif fl > 0.8:
                adapted.append({**ex, "sets": max(1, ex.get("sets", 3) - 2)})
            elif fl > 0.6:
                adapted.append({**ex, "sets": max(2, ex.get("sets", 3) - 1)})
            else:
                adapted.append(ex)
        day = {**day, "exercises": adapted}

    return {
        "day": day,
        "total_days_in_recipe": len(days),
        "day_index": idx,
        "plan_name": plan.get("workout_plan", {}).get("name", ""),
        "readiness_score": fatigue_readiness,
        "focus_readiness": fatigue_snapshot.focus_readiness if fatigue_snapshot else {},
    }


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
    # Upsert by (user, date, focus). Multiple activities per day are allowed
    # (e.g. legs workout in the morning + sauna recovery in the evening).
    # Each gets its own completion row so fatigue accumulates correctly.
    existing = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == body.workout_date)
        .where(WorkoutCompletion.focus_label == body.focus_label)
    ).first()
    if existing:
        existing.duration_seconds   = body.duration_seconds
        existing.stimulus           = body.stimulus
        existing.activity_category  = body.activity_category or existing.activity_category
        existing.activity_subtype   = body.activity_subtype or existing.activity_subtype
        existing.activity_intensity = body.activity_intensity or existing.activity_intensity
        existing.activity_source    = body.activity_source or existing.activity_source
        existing.cardio_style       = body.cardio_style or existing.cardio_style
        existing.completed_at       = datetime.now(timezone.utc)
        db.add(existing)
    else:
        db.add(WorkoutCompletion(
            user_id=current_user.id,
            workout_date=body.workout_date,
            focus_label=body.focus_label,
            duration_seconds=body.duration_seconds,
            stimulus=body.stimulus,
            activity_category=body.activity_category,
            activity_subtype=body.activity_subtype,
            activity_intensity=body.activity_intensity,
            activity_source=body.activity_source,
            cardio_style=body.cardio_style,
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
            logger.info(f"[workouts/complete] structured persistence error: {type(e).__name__}: {e}")
            db.rollback()
            from sqlalchemy.exc import IntegrityError
            if isinstance(e, IntegrityError):
                raise

    # Resolve per-muscle fatigue and store on the completion row.
    # Uses per-exercise data when available, falls back to focus-label estimate.
    try:
        from app.services.workout.activity_impact import resolve_exercise_fatigue, resolve_focus_fatigue
        completion_row = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.workout_date == body.workout_date)
            .where(WorkoutCompletion.focus_label == body.focus_label)
        ).first()
        if completion_row:
            if body.exercises:
                from app.seed_exercises_data import SEED_EXERCISES
                seed_map = {e["name"].lower(): e for e in SEED_EXERCISES}
                ex_list = []
                for ep in body.exercises:
                    seed = seed_map.get(ep.name.lower(), {})
                    ex_list.append({
                        "name": ep.name,
                        "primary_muscle": seed.get("primary_muscle", ""),
                        "secondary_muscles": seed.get("secondary_muscles", []),
                        "is_compound": seed.get("is_compound", False),
                        "sets_logged": len(ep.sets),
                    })
                resolved = resolve_exercise_fatigue(
                    ex_list,
                    intensity=body.activity_intensity or "moderate",
                    duration_minutes=body.duration_seconds // 60 if body.duration_seconds > 0 else 60,
                )
            else:
                resolved = resolve_focus_fatigue(
                    body.focus_label,
                    intensity=body.activity_intensity or "moderate",
                    duration_minutes=body.duration_seconds // 60 if body.duration_seconds > 0 else 60,
                )
            completion_row.resolved_muscle_fatigue = resolved
            # If exercises were provided, infer the correct focus from the
            # primary muscles worked. The client may send a stale focus_label
            # (e.g. "Recovery" from the plan day) even though the user did
            # actual lifting exercises.
            if body.exercises and resolved:
                top_muscles = sorted(resolved.items(), key=lambda x: -x[1])
                top = [m for m, v in top_muscles if m != 'systemic' and v > 0.1]
                if top:
                    inferred = _infer_focus_from_muscles(top)
                    if inferred and inferred != completion_row.focus_label:
                        logger.info(f"[workouts/complete] focus corrected: {completion_row.focus_label!r} → {inferred!r} (from exercises)")
                        completion_row.focus_label = inferred
            db.add(completion_row)
    except Exception as e:
        logger.info(f"[workouts/complete] muscle fatigue resolution failed (non-fatal): {e}")

    db.commit()
    logger.info(f"[workouts/complete] COMMITTED user={current_user.id} date={body.workout_date} focus={body.focus_label} dur={body.duration_seconds}s exercises={len(body.exercises) if body.exercises else 0}")
    # Verify the row exists
    verify = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == body.workout_date)
        .where(WorkoutCompletion.focus_label == body.focus_label)
    ).first()
    logger.info(f"[workouts/complete] VERIFY: row={'FOUND' if verify else 'MISSING'} resolved_fatigue={bool(verify.resolved_muscle_fatigue) if verify else 'N/A'}")
    return {"ok": True, "structured_persisted": bool(session_rows_created)}


@router.get("/status", response_model=WorkoutStatusResponse)
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


@router.get("/fatigue", response_model=FatigueScoreResponse)
def get_fatigue_score(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Returns the user's current fatigue/recovery score based on recent activity."""
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.services.workout.activity_impact import compute_rolling_fatigue

    completions = get_recent_completions_for_fatigue(current_user.id, db)
    logger.debug(f"[fatigue] user={current_user.id} completions={len(completions)} dates={[c.get('workout_date') for c in completions]}")
    snapshot = compute_rolling_fatigue(completions)
    logger.debug(f"[fatigue] readiness={snapshot.readiness_score}% muscles={snapshot.muscle_fatigue.to_dict()}")

    # Nutrition recovery bonus: good protein intake accelerates recovery
    nutrition_context = {"protein_avg": 0, "protein_status": "unknown", "message": None, "recovery_bonus_applied": False}
    try:
        from app.services.nutrition.meal_history import get_rolling_averages
        avg = get_rolling_averages(current_user.id, window=3, db=db)
        if avg and avg.get("days_with_data", 0) > 0:
            protein = avg.get("avg_protein_g", 0)
            calories = avg.get("avg_calories", 0)
            nutrition_context["protein_avg"] = round(protein)
            nutrition_context["calories_avg"] = round(calories)

            if protein >= 130:
                nutrition_context["protein_status"] = "excellent"
                nutrition_context["message"] = f"Protein intake strong ({round(protein)}g avg) — accelerating recovery"
            elif protein >= 100:
                nutrition_context["protein_status"] = "good"
                nutrition_context["message"] = f"Protein adequate ({round(protein)}g avg) — supporting recovery"
            elif protein >= 50:
                nutrition_context["protein_status"] = "low"
                nutrition_context["message"] = f"Protein low ({round(protein)}g avg) — recovery is slower. Aim for 130g+"
            elif protein > 0:
                nutrition_context["protein_status"] = "very_low"
                nutrition_context["message"] = f"Protein very low ({round(protein)}g avg) — significantly slowing recovery"
            else:
                nutrition_context["protein_status"] = "no_data"
                nutrition_context["message"] = "Log meals to unlock nutrition-powered recovery insights"

            if protein >= 100:
                protein_factor = min(1.0, protein / 150)
                recovery_bonus = 0.05 * protein_factor
                for muscle in ("chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "core"):
                    current = snapshot.muscle_fatigue.get(muscle)
                    if current > 0:
                        snapshot.muscle_fatigue.add(muscle, -current * recovery_bonus)
                from app.services.workout.activity_impact import derive_all_readiness, FATIGUE_MUSCLES
                snapshot.focus_readiness = derive_all_readiness(snapshot.muscle_fatigue)
                muscle_avg = sum(snapshot.muscle_fatigue.get(m) for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")) / 10.0
                snapshot.readiness_score = int(round(max(0, (1 - (muscle_avg * 0.6 + snapshot.muscle_fatigue.systemic * 0.4)) * 100)))
                nutrition_context["recovery_bonus_applied"] = True
                logger.debug(f"[fatigue] nutrition bonus: protein={protein:.0f}g bonus={recovery_bonus:.3f} readiness={snapshot.readiness_score}%")
            elif protein >= 50:
                # Low protein: apply a small PENALTY (slower recovery)
                penalty = 0.03
                for muscle in ("chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "core"):
                    current = snapshot.muscle_fatigue.get(muscle)
                    if current > 0:
                        snapshot.muscle_fatigue.add(muscle, current * penalty)
                from app.services.workout.activity_impact import derive_all_readiness, FATIGUE_MUSCLES
                snapshot.focus_readiness = derive_all_readiness(snapshot.muscle_fatigue)
                muscle_avg = sum(snapshot.muscle_fatigue.get(m) for m in FATIGUE_MUSCLES if m not in ("cardio", "systemic")) / 10.0
                snapshot.readiness_score = int(round(max(0, (1 - (muscle_avg * 0.6 + snapshot.muscle_fatigue.systemic * 0.4)) * 100)))
                logger.debug(f"[fatigue] low protein penalty: protein={protein:.0f}g readiness={snapshot.readiness_score}%")
    except Exception as e:
        logger.debug(f"[fatigue] nutrition recovery check failed (non-fatal): {e}")

    return {
        "readiness_score": snapshot.readiness_score,
        "readiness_label": snapshot.readiness_label,
        "muscle_fatigue": snapshot.muscle_fatigue.to_dict(),
        "focus_readiness": snapshot.focus_readiness,
        "top_fatigued": [{"muscle": m, "value": round(v, 2)} for m, v in snapshot.top_fatigued],
        "blocked_focuses": snapshot.blocked_focuses,
        "days_analyzed": snapshot.days_analyzed,
        "activities": snapshot.activities,
        "nutrition_context": nutrition_context,
    }


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
        for s in db.exec(select(ExerciseSet).where(ExerciseSet.workout_exercise_id == ex.id)).all():
            db.delete(s)
        db.delete(ex)
    db.delete(session_row)
    db.commit()
