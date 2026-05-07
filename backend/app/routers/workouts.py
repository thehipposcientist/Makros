from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select
from sqlalchemy import func
from datetime import datetime, date, timezone, timedelta
from typing import Literal
from pydantic import BaseModel

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import (
    User, WorkoutSession, WorkoutExercise, ExerciseSet,
    WorkoutSessionCreate, SetLog, WorkoutCompletion, UserProfile,
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
    comfort_rating: int | None = None    # 1-5 comfort for stretch/mobility
    feedback: str | None = None          # easy / good / hard / failure / pain
    rir: float | None = None
    actual_distance: float | None = None
    actual_pace: str | None = None
    heart_rate_avg: int | None = None
    cardio_metrics: dict | None = None


class CompletedExercisePayload(BaseModel):
    """One exercise from a finished mobile workout. `sets` is the list
    of sets the user actually logged — may be shorter than the planned
    target set count."""
    name: str
    slug: str | None = None
    target_sets: int | None = None
    target_reps: str | None = None
    equipment: str | None = None
    primary_muscle: str | None = None
    secondary_muscles: list[str] | None = None
    is_compound: bool | None = None
    order_index: int = 0
    sets: list[CompletedSetPayload] = []


class WorkoutCompleteRequest(BaseModel):
    workout_date: date
    focus_label: str
    duration_seconds: int = 0
    stimulus: str | None = None  # strength/hypertrophy/volume/conditioning/etc.
    source_context: str | None = None
    template_id: str | None = None
    plan_day_id: int | None = None
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
    distance_miles: float | None = None
    calories_burned: int | None = None
    hr_summary: dict | None = None  # {avgBpm, maxBpm, zoneMinutes}
    started_at: datetime | None = None
    ended_at: datetime | None = None
    external_source_id: str | None = None
    # Post-workout feedback. Used by weekly_review's struggle metrics
    # (e.g. 3 of 4 sessions felt rough → trainer suggests pulling back).
    # All optional — silent log paths still work.
    feeling: str | None = None              # "great"|"good"|"okay"|"rough"
    intensity: int | None = None            # 1..5
    soreness_areas: list[str] | None = None  # ["lower_back", "knees"]
    feedback_notes: str | None = None
    # Per-session gear attribution. None = legacy keyword auto-match,
    # [] = explicit "no gear used today", [ids] = only credit these.
    gear_ids: list[int] | None = None


def _has_exercise_detail(body: WorkoutCompleteRequest) -> bool:
    return bool(body.exercises and len(body.exercises) > 0)


def _has_activity_detail(body: WorkoutCompleteRequest) -> bool:
    return any((
        body.activity_category,
        body.activity_subtype,
        body.activity_intensity,
        body.activity_source,
        body.cardio_style,
        body.distance_miles is not None,
        body.calories_burned is not None,
        body.hr_summary is not None,
    ))


def _has_feedback_detail(body: WorkoutCompleteRequest) -> bool:
    return any((
        body.feeling is not None,
        body.intensity is not None,
        body.soreness_areas is not None,
        body.feedback_notes is not None,
    ))


def _is_feedback_only_patch(body: WorkoutCompleteRequest) -> bool:
    return (
        _has_feedback_detail(body)
        and not _has_exercise_detail(body)
        and not _has_activity_detail(body)
    )


_MANUAL_COMPLETION_CONTEXTS = {"manual_activity", "apple_health", "watch", "coach_log"}


def _as_aware_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _activity_time_bounds(body: WorkoutCompleteRequest) -> tuple[datetime | None, datetime]:
    started_at = _as_aware_utc(body.started_at)
    ended_at = _as_aware_utc(body.ended_at)
    duration = int(body.duration_seconds or 0)
    if ended_at is None and started_at is not None and duration > 0:
        ended_at = started_at + timedelta(seconds=duration)
    if started_at is None and ended_at is not None and duration > 0:
        started_at = ended_at - timedelta(seconds=duration)
    return started_at, ended_at or datetime.now(timezone.utc)


def _estimated_activity_calories(
    body: WorkoutCompleteRequest,
    *,
    db: Session,
    user_id: int,
) -> int | None:
    if body.calories_burned is not None or not body.activity_category:
        return body.calories_burned
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if not profile or not profile.weight_lbs:
        return None
    from app.services.workout.activity_energy import estimate_activity_calories
    return estimate_activity_calories(
        duration_seconds=body.duration_seconds,
        weight_lbs=float(profile.weight_lbs),
        category=body.activity_category,
        subtype=body.activity_subtype,
        intensity=body.activity_intensity,
        cardio_style=body.cardio_style,
    )

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
    return _build_session_responses_batch([session_row], db)[0]


def _build_session_responses_batch(
    session_rows: list[WorkoutSession], db: Session
) -> list[dict]:
    """Batched variant for list endpoints. Was an N+1 before — `list_workouts`
    fetches up to 50 sessions, and each session triggered (1 + N exercises) set
    queries. For a typical user that's ~300 round trips per request. This
    collapses it to 3: 1 for sessions (caller), 1 for all exercises, 1 for all
    sets, then groups in-memory."""
    if not session_rows:
        return []

    from sqlmodel import col
    session_ids = [s.id for s in session_rows]

    exercises = db.exec(
        select(WorkoutExercise)
        .where(col(WorkoutExercise.session_id).in_(session_ids))
        .order_by(WorkoutExercise.session_id, WorkoutExercise.order_index)
    ).all()
    exercises_by_session: dict[int, list[WorkoutExercise]] = {}
    for ex in exercises:
        exercises_by_session.setdefault(ex.session_id, []).append(ex)

    exercise_ids = [ex.id for ex in exercises]
    sets_by_exercise: dict[int, list[ExerciseSet]] = {}
    if exercise_ids:
        all_sets = db.exec(
            select(ExerciseSet)
            .where(col(ExerciseSet.workout_exercise_id).in_(exercise_ids))
            .order_by(ExerciseSet.workout_exercise_id, ExerciseSet.set_number)
        ).all()
        for s in all_sets:
            sets_by_exercise.setdefault(s.workout_exercise_id, []).append(s)

    out: list[dict] = []
    for session_row in session_rows:
        session_exercises = exercises_by_session.get(session_row.id, [])
        exercise_data = [
            {**ex.model_dump(), "sets": [s.model_dump() for s in sets_by_exercise.get(ex.id, [])]}
            for ex in session_exercises
        ]
        out.append({**session_row.model_dump(), "exercises": exercise_data})
    return out


@router.get("/progression/{exercise_name}")
def progression_insights(
    exercise_name: str,
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Returns progression trend and plateau hint for a given exercise name."""
    # Only completed sessions contribute to progression history. Before
    # this filter an abandoned workout would show up as a "point" with
    # zeroed sets and break the plateau detector.
    # Cap to the last 90 days so this scales regardless of history length;
    # plateau detection already only looks at the most recent 6 points.
    from datetime import timedelta
    cutoff = date.today() - timedelta(days=90)
    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .where(WorkoutSession.completed_at.is_not(None))
        .where(WorkoutSession.workout_date >= cutoff)
        .order_by(WorkoutSession.workout_date.desc())
    ).all()

    # Batched fetch — was a nested N+1 (per-session exercise query, then
    # per-exercise set query). For 90 days of sessions that's hundreds of
    # round trips. Collapsed to 2 queries: all matching exercises across
    # the window, then all completed sets for those exercises.
    from sqlmodel import col
    session_ids = [s.id for s in sessions]
    sessions_by_id = {s.id: s for s in sessions}

    matching_exercises: list[WorkoutExercise] = []
    if session_ids:
        matching_exercises = db.exec(
            select(WorkoutExercise)
            .where(col(WorkoutExercise.session_id).in_(session_ids))
            # Case-insensitive exact match. `ilike(exercise_name)` without
            # wildcards was already case-insensitive by luck in Postgres
            # but required the exact name. Keep the same semantics but be
            # explicit so future devs don't "improve" it into a pattern.
            .where(WorkoutExercise.name.ilike(exercise_name))
        ).all()

    sets_by_exercise: dict[int, list[ExerciseSet]] = {}
    if matching_exercises:
        ex_ids = [ex.id for ex in matching_exercises]
        all_sets = db.exec(
            select(ExerciseSet)
            .where(col(ExerciseSet.workout_exercise_id).in_(ex_ids))
            .where(ExerciseSet.completed == True)  # noqa: E712
        ).all()
        for st in all_sets:
            sets_by_exercise.setdefault(st.workout_exercise_id, []).append(st)

    points = []
    for ex in matching_exercises:
        sets = sets_by_exercise.get(ex.id, [])
        if not sets:
            continue
        best = max(sets, key=lambda x: (x.actual_weight_lbs or 0) * (x.actual_reps or 0))
        score = (best.actual_weight_lbs or 0) * (best.actual_reps or 0)
        s = sessions_by_id.get(ex.session_id)
        if not s:
            continue
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
    source_context: str | None = None
    plan_day_id: int | None = None


def _start_focus_matches_plan_day(plan_day, focus_label: str) -> bool:
    if getattr(plan_day, "is_rest", False):
        return False
    workout_json = getattr(plan_day, "workout_json", None)
    if not isinstance(workout_json, dict):
        return False
    planned = str(workout_json.get("focus") or "").strip()
    completed = str(focus_label or "").strip()
    if not planned or not completed:
        return False
    clean = lambda value: " ".join(value.lower().replace("_", " ").split())
    if clean(planned) == clean(completed):
        return True
    try:
        from app.services.workout.focus_normalize import normalize_focus_to_family
        return normalize_focus_to_family(planned) == normalize_focus_to_family(completed)
    except Exception:
        return False


@router.post("/start", status_code=201)
def mark_workout_started(
    body: WorkoutStartRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Mark a workout as started without creating a completion marker.

    A start is an in-progress signal only. Real completion stays owned by
    POST /workouts/complete so crashed/abandoned workouts never look done.
    """
    from app.models import PlanDay, PlanWeek, WorkoutSource

    existing_session = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .where(WorkoutSession.workout_date == body.workout_date)
        .where(WorkoutSession.focus == body.focus_label)
    ).first()
    already_exists = existing_session is not None

    plan_day_started = False
    plan_day = None
    try:
        if body.plan_day_id is not None:
            plan_day = db.get(PlanDay, body.plan_day_id)
            if plan_day and plan_day.user_id != current_user.id:
                plan_day = None
        if plan_day is None:
            active_week = db.exec(
                select(PlanWeek).where(
                    PlanWeek.user_id == current_user.id,
                    PlanWeek.status == "active",
                )
            ).first()
            if active_week:
                plan_day = db.exec(
                    select(PlanDay).where(
                        PlanDay.plan_week_id == active_week.id,
                        PlanDay.day_date == body.workout_date,
                    )
                ).first()
        if (
            plan_day
            and not plan_day.locked
            and (body.plan_day_id is not None or _start_focus_matches_plan_day(plan_day, body.focus_label))
        ):
            from app.services.workout.week_manager import start_day
            start_day(db, plan_day)
            plan_day_started = True
    except Exception as e:
        logger.info(f"[workouts/start] plan day start failed (non-fatal): {type(e).__name__}: {e}")
        db.rollback()

    if existing_session is None:
        source = WorkoutSource.GENERATED
        if (body.source_context or "").lower() in {"manual_activity", "apple_health", "watch", "coach_log"}:
            source = WorkoutSource.LOGGED
        existing_session = WorkoutSession(
            user_id=current_user.id,
            name=body.focus_label or "Workout",
            focus=body.focus_label or "",
            workout_date=body.workout_date,
            source=source,
            completed_at=None,
        )
        db.add(existing_session)
    elif existing_session.completed_at is not None:
        return {
            "ok": True,
            "already_exists": True,
            "session_id": existing_session.id,
            "plan_day_started": plan_day_started,
            "completion_created": False,
        }

    db.commit()
    db.refresh(existing_session)
    return {
        "ok": True,
        "already_exists": already_exists,
        "session_id": existing_session.id,
        "plan_day_started": plan_day_started,
        "completion_created": False,
    }


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
    injuries: list[str] = []
    disliked_exercises: list[str] = []     # exercises to exclude from selection
    focus_override: str | None = None      # force a specific focus (e.g. "Legs")
    # Optional: focus labels the client already has queued up in the
    # preceding days of the plan (e.g. user tapped Switch Day on day 2
    # → they've now fixed day 2's focus to "Pull", but that pick won't
    # be in WorkoutCompletion until the user finishes it). Pass them
    # here so single-day generation for day 3 still sees "Pull" as a
    # recent focus and avoids picking Pull again. Most-recent LAST
    # (natural plan order). Coarse bucket strings and/or fine-family
    # strings both accepted — everything is normalized downstream.
    prev_focuses: list[str] = []


class GenerateWeekRequest(BaseModel):
    """Build / pin a workout week.

    Two modes:

      A) `current_days` is None → fresh full-week regen. Used for the
         "regenerate plan" button in Settings or for cold starts.

      B) `current_days` is provided → Switch-Day single-day swap. The
         caller sends their EXISTING week; the router applies the pin
         against it (decide_pin → swap) and returns the modified week.
         Only the pinned day + swap partner change. This matches the
         user's mental model: tap day X → only day X changes.

         Without this mode the router regenerated a fresh week before
         pinning, which (a) changed every day on the schedule and
         (b) made the pin land on a different visual day than the
         user tapped because the fresh plan re-anchored from today.
    """
    goal: str
    days_per_week: int = 4
    session_minutes: int = 60
    experience: str = "intermediate"
    equipment: list[str] = []
    preferred_split: str | None = None
    priority_region: str = "balanced"
    injuries: list[str] = []
    disliked_exercises: list[str] = []
    # Switch-Day pin.
    pin_day_index: int | None = None
    pin_focus: str | None = None
    # User's current plan in visual order. When set, the pin is applied
    # to THIS week (single-day swap) instead of a freshly generated one.
    current_days: list[dict] | None = None
    # Change-day-type mode: "single" or "smart". When set (along with
    # pin_day_index, pin_focus, current_days), routes through the
    # change_day_type service instead of the legacy switch-day pin.
    change_mode: Literal["single", "smart"] | None = None
    # Per-day statuses: "completed", "started", "pending", "locked", "skipped".
    day_statuses: list[str] | None = None


@router.post("/generate-day")
def generate_single_day(
    body: GenerateDayRequest,
    current_user: User = Depends(require_pro_feature("Generated workout plans")),
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
    from app.services.workout.equipment import resolve_owned_equipment_slugs
    owned_slugs = resolve_owned_equipment_slugs(body.equipment)

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
        logger.exception("[generate-day] most_recent_completed_focus failed")

    # Merge in any client-supplied prev_focuses (user forced focuses on
    # preceding days of the plan that haven't been completed yet). We
    # normalize each label the same way history does — to a bucket and
    # family — and PREPEND so they count as the most-recent entries for
    # rotation purposes (history tuples are newest-first).
    if body.prev_focuses:
        try:
            from app.services.workout.focus_normalize import (
                normalize_focus_to_bucket, normalize_focus_to_family,
            )
            extra_buckets: list[str] = []
            extra_families: list[str] = []
            # Iterate newest-last → newest-first. The client sends the
            # plan's natural order (day 1, day 2, ...) so reverse for
            # history semantics.
            for raw in reversed(body.prev_focuses):
                if not raw:
                    continue
                b = normalize_focus_to_bucket(raw)
                f = normalize_focus_to_family(raw)
                if b:
                    extra_buckets.append(b)
                if f:
                    extra_families.append(f)
            if extra_buckets:
                recent_focus_buckets = tuple(extra_buckets) + recent_focus_buckets
            if extra_families:
                recent_focus_families = tuple(extra_families) + recent_focus_families
            logger.debug(
                f"[generate-day] prev_focuses merged: {body.prev_focuses} → "
                f"buckets_prepended={extra_buckets} families_prepended={extra_families}"
            )
        except Exception:
            logger.exception("[generate-day] prev_focuses merge failed")
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
                if current < boost:  # only boost up to the injury level, don't stack
                    fatigue_snapshot.muscle_fatigue.add(muscle, boost - current)
            if injury_boosts:
                from app.services.workout.activity_impact import recompute_readiness
                fatigue_snapshot.readiness_score, fatigue_snapshot.focus_readiness = recompute_readiness(fatigue_snapshot.muscle_fatigue)
                logger.debug(f"[generate-day] injury fatigue boost applied: {injury_boosts}")
            fatigue_readiness = fatigue_snapshot.readiness_score
            logger.debug(f"[generate-day] fatigue: readiness={fatigue_readiness} focus_readiness={fatigue_snapshot.focus_readiness}")
    except Exception as e:
        logger.debug(f"[generate-day] fatigue check failed: {e}")

    # Look up user's age from profile for age-adjusted planning.
    user_age: int | None = None
    load_equipment_settings: dict | None = None
    try:
        from app.models import UserProfile as UserProfileModel, UserPreferences as UserPreferencesModel
        prof_row = db.exec(
            select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
        ).first()
        user_age = prof_row.age if prof_row else None
        prefs_row = db.exec(
            select(UserPreferencesModel).where(UserPreferencesModel.user_id == current_user.id)
        ).first()
        load_equipment_settings = getattr(prefs_row, "equipment_settings", None) if prefs_row else None
    except Exception:
        user_age = None
        load_equipment_settings = None

    # Build planner inputs
    inputs = PlannerInputs(
        goal=body.goal,
        days_per_week=body.days_per_week,
        session_minutes=body.session_minutes,
        experience=body.experience.lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=body.preferred_split,
        priority_region=body.priority_region,
        injuries=tuple(body.injuries),
        disliked_exercises=tuple(body.disliked_exercises),
        rng_seed=current_user.id + body.day_index,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=fatigue_snapshot.muscle_fatigue.to_dict() if fatigue_snapshot else None,
        user_age=user_age,
        load_equipment_settings=load_equipment_settings,
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
            day = generate_cardio_day(
                body.session_minutes or 45,
                body.goal or "body_recomp",
                equipment_owned=body.equipment,
            )
            logger.debug("[generate-day] focus override → generated Cardio day")
        else:
            matched = False
            for alt_idx, alt_day in enumerate(days):
                if alt_day.get("focus", "").lower().strip() == override_lower:
                    day = alt_day
                    idx = alt_idx
                    logger.debug(f"[generate-day] focus override '{body.focus_override}' → day {alt_idx}")
                    matched = True
                    break
            if not matched:
                # Same fix as switch-day: regenerate with the split that
                # contains the requested focus, then lift that day's
                # exercises. Avoids the "Push label on Lower exercises"
                # mislabel bug.
                _SPLIT_FOR_FOCUS_DAY = {
                    "push": "ppl", "pull": "ppl", "legs": "ppl",
                    "upper": "upper_lower", "lower": "upper_lower",
                    "full body": "full_body", "full_body": "full_body",
                    "chest": "bro", "back": "bro", "shoulders": "bro", "arms": "bro",
                }
                forced_split = _SPLIT_FOR_FOCUS_DAY.get(override_lower)
                substituted = False
                if forced_split and forced_split != (body.preferred_split or "auto"):
                    try:
                        from dataclasses import replace as _dc_replace
                        alt_inputs = _dc_replace(inputs, preferred_split=forced_split)
                        alt_plan = generate_workout_plan(
                            alt_inputs, SEED_EXERCISES,
                            history_familiarity=history_familiarity,
                            recent_muscle_exercises=recent_muscle_exercises,
                        )
                        for ad in alt_plan.get("workout_plan", {}).get("days", []):
                            if (ad.get("focus") or "").lower().strip() == override_lower:
                                day = ad
                                substituted = True
                                logger.debug(f"[generate-day] focus override '{body.focus_override}' → split substitution (split={forced_split})")
                                break
                    except Exception as e:
                        logger.warning(f"[generate-day] focus override substitution failed: {e}")
                if not substituted:
                    day = {**day, "focus": body.focus_override}
                    logger.warning(f"[generate-day] focus override '{body.focus_override}' — relabel-only fallback (no matching day)")

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
    # within a day while preserving fresh muscles. SKIPPED when the user
    # explicitly overrode the focus — their choice wins over the
    # auto-adapter. Emit a `fatigue_notice` with affected muscles so the
    # client can surface why sets shrunk instead of it happening silently.
    fatigue_notice = None
    if (
        fatigue_snapshot
        and day.get("exercises")
        and not day.get("_forced_recovery")
        and not body.focus_override
    ):
        mf_dict = fatigue_snapshot.muscle_fatigue.to_dict()
        adapted = []
        reduced_muscles: list[str] = []
        for ex in day["exercises"]:
            primary = ex.get("_primary_muscle", "")
            fl = mf_dict.get(primary, 0.0)
            role = ex.get("_role", "")
            if role in ("warmup", "core"):
                adapted.append(ex)
            elif fl > 0.8:
                adapted.append({**ex, "sets": max(1, ex.get("sets", 3) - 2)})
                if primary and primary not in reduced_muscles:
                    reduced_muscles.append(primary)
            elif fl > 0.6:
                adapted.append({**ex, "sets": max(2, ex.get("sets", 3) - 1)})
                if primary and primary not in reduced_muscles:
                    reduced_muscles.append(primary)
            else:
                adapted.append(ex)
        day = {**day, "exercises": adapted}
        if reduced_muscles:
            human = ", ".join(m.replace("_", " ").title() for m in reduced_muscles[:3])
            fatigue_notice = (
                f"Reduced sets on {human} — those muscles are still recovering. "
                f"You can always do full volume anyway."
            )

    return {
        "day": day,
        "total_days_in_recipe": len(days),
        "day_index": idx,
        "plan_name": plan.get("workout_plan", {}).get("name", ""),
        "readiness_score": fatigue_readiness,
        "focus_readiness": fatigue_snapshot.focus_readiness if fatigue_snapshot else {},
        "fatigue_notice": fatigue_notice,
    }


# ─── Per-week workout generation (Switch-Day flow) ────────────────────────────

@router.post("/generate-week")
def generate_full_week(
    body: GenerateWeekRequest,
    current_user: User = Depends(require_pro_feature("Generated workout plans")),
    db: Session = Depends(get_session),
):
    """Build the full N-day rotation in a single coherent recipe. Used by
    Switch-Day — the client pins one day and every other day rotates around
    it. Respects split / session_minutes / recent completions / muscle
    fatigue / injuries / dislikes — same rules as any fresh plan gen."""
    logger.info(
        f"[generate-week] ENTRY: goal={body.goal} days={body.days_per_week} "
        f"pin_idx={body.pin_day_index} pin_focus={body.pin_focus} "
        f"split={body.preferred_split}"
    )
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        build_history_familiarity, most_recent_completed_focus,
        recent_exercise_slugs_by_muscle,
    )
    from app.services.workout.equipment import resolve_owned_equipment_slugs

    owned_slugs = resolve_owned_equipment_slugs(body.equipment)

    recent_focus_buckets: tuple[str, ...] = ()
    recent_focus_families: tuple[str, ...] = ()
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        logger.exception("[generate-week] most_recent_completed_focus failed")

    try:
        history_familiarity = build_history_familiarity(current_user.id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(current_user.id, db)
    except Exception:
        recent_muscle_exercises = {}

    fatigue_snapshot = None
    try:
        from app.services.workout.history import get_recent_completions_for_fatigue
        from app.services.workout.activity_impact import compute_rolling_fatigue
        completions = get_recent_completions_for_fatigue(current_user.id, db)
        if completions:
            fatigue_snapshot = compute_rolling_fatigue(completions)
            from app.services.workout.planner import injury_muscle_fatigue_boost
            injury_boosts = injury_muscle_fatigue_boost(tuple(body.injuries))
            for muscle, boost in injury_boosts.items():
                current = fatigue_snapshot.muscle_fatigue.get(muscle)
                if current < boost:
                    fatigue_snapshot.muscle_fatigue.add(muscle, boost - current)
            if injury_boosts:
                from app.services.workout.activity_impact import recompute_readiness
                fatigue_snapshot.readiness_score, fatigue_snapshot.focus_readiness = recompute_readiness(fatigue_snapshot.muscle_fatigue)
    except Exception as e:
        logger.debug(f"[generate-week] fatigue check failed: {e}")

    user_age: int | None = None
    load_equipment_settings: dict | None = None
    try:
        from app.models import UserProfile as UserProfileModel, UserPreferences as UserPreferencesModel
        prof_row = db.exec(
            select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
        ).first()
        user_age = prof_row.age if prof_row else None
        prefs_row = db.exec(
            select(UserPreferencesModel).where(UserPreferencesModel.user_id == current_user.id)
        ).first()
        load_equipment_settings = getattr(prefs_row, "equipment_settings", None) if prefs_row else None
    except Exception:
        user_age = None
        load_equipment_settings = None

    inputs = PlannerInputs(
        goal=body.goal,
        days_per_week=body.days_per_week,
        session_minutes=body.session_minutes,
        experience=body.experience.lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=body.preferred_split,
        priority_region=body.priority_region,
        injuries=tuple(body.injuries),
        disliked_exercises=tuple(body.disliked_exercises),
        rng_seed=current_user.id,  # stable across the week (not per-day)
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=fatigue_snapshot.muscle_fatigue.to_dict() if fatigue_snapshot else None,
        user_age=user_age,
        load_equipment_settings=load_equipment_settings,
    )

    # Single-day swap mode: caller sent their current week. Skip the
    # full regen — pin against the user's existing plan so only the
    # tapped day + its swap partner change. Without this, the visual
    # plan would be replaced with a freshly generated week and the
    # pin would land at a different visual position than the user
    # selected (the user-reported bug: "tap day 4, it updates day 1").
    if (
        body.current_days
        and len(body.current_days) >= body.days_per_week
        and body.pin_day_index is not None
        and body.pin_focus
    ):
        days = list(body.current_days)
        plan = {"workout_plan": {"name": "", "days": days}}
        logger.info(
            f"[generate-week] using current_days for pin (skip full regen) "
            f"pin_idx={body.pin_day_index} pin_focus={body.pin_focus}"
        )
    else:
        plan = generate_workout_plan(
            inputs, SEED_EXERCISES,
            history_familiarity=history_familiarity,
            recent_muscle_exercises=recent_muscle_exercises,
        )
        days = plan.get("workout_plan", {}).get("days", [])
        if not days:
            raise HTTPException(status_code=500, detail="Planner produced no days")

    # ── Change-day-type path ──────────────────────────────────────
    # When the client sends change_mode, route through the new
    # change_day_type service and return early. This replaces the
    # old pin logic for the "Change Focus" UI.
    if (
        body.change_mode
        and body.current_days
        and body.pin_day_index is not None
        and body.pin_focus
    ):
        from app.services.workout.change_day_type import change_day_type as _cdt
        day_statuses = body.day_statuses or ["pending"] * len(body.current_days)
        cdt_result = _cdt(
            current_days=list(body.current_days),
            day_index=body.pin_day_index,
            new_focus=body.pin_focus,
            day_statuses=day_statuses,
            mode=body.change_mode,
            split=body.preferred_split,
            days_per_week=body.days_per_week,
            focus_readiness=fatigue_snapshot.focus_readiness if fatigue_snapshot else None,
        )
        logger.info(
            f"[generate-week] change_day_type mode={body.change_mode} "
            f"idx={body.pin_day_index} focus={body.pin_focus} "
            f"changed={cdt_result.changed_indices} "
            f"conflicts={len(cdt_result.conflicts)}"
        )

        # For each day that needs new exercises, regenerate via planner.
        # Non-lifting days get dedicated generators. Lifting days pull
        # exercises from a single plan regen (one regen, multiple days).
        from app.services.workout.switch_day import (
            _focus_family, _canonical_cycle_for_split, SPLIT_FOR_FOCUS,
        )
        from app.services.workout.change_day_type import (
            pick_generated_lift_day_for_change,
        )
        lift_needed: list[tuple[int, str, str]] = []  # (idx, proposed_focus, base_focus)
        for ex_idx in cdt_result.exercises_needed:
            proposed_focus = cdt_result.proposed_days[ex_idx].get("focus", "")
            nf_lower = proposed_focus.lower().strip()
            if nf_lower in ("recovery", "active recovery"):
                from app.services.workout.planner import generate_recovery_day
                cdt_result.proposed_days[ex_idx] = generate_recovery_day(
                    body.session_minutes or 45
                )
            elif nf_lower in ("mobility", "stretching"):
                from app.services.workout.planner import generate_mobility_day
                cdt_result.proposed_days[ex_idx] = generate_mobility_day(
                    body.session_minutes or 45
                )
            elif nf_lower in ("cardio", "conditioning"):
                from app.services.workout.planner import generate_cardio_day
                cdt_result.proposed_days[ex_idx] = generate_cardio_day(
                    body.session_minutes or 45,
                    body.goal or "body_recomp",
                    equipment_owned=body.equipment,
                )
            elif nf_lower == "empty":
                cdt_result.proposed_days[ex_idx] = {
                    **cdt_result.proposed_days[ex_idx],
                    "focus": "Empty",
                    "exercises": [],
                    "stimulus": None,
                }
            else:
                base = nf_lower.replace(" + cardio", "").strip()
                lift_needed.append((ex_idx, proposed_focus, base))

        if lift_needed:
            from dataclasses import replace as _dc_replace
            # Only override split if the focus doesn't belong to the
            # user's current split cycle.
            target_split = body.preferred_split
            cycle = _canonical_cycle_for_split(target_split)
            sample_base = lift_needed[0][2]
            if cycle and _focus_family(sample_base) not in [_focus_family(c) for c in cycle]:
                if sample_base in SPLIT_FOR_FOCUS:
                    target_split = SPLIT_FOR_FOCUS[sample_base]
            alt_inputs = _dc_replace(inputs, preferred_split=target_split)
            alt_plan = generate_workout_plan(
                alt_inputs, SEED_EXERCISES,
                history_familiarity=history_familiarity,
                recent_muscle_exercises=recent_muscle_exercises,
            )
            alt_days = alt_plan.get("workout_plan", {}).get("days", [])
            used_alt_indexes: set[int] = set()

            for ex_idx, proposed_focus, base in lift_needed:
                picked_idx, picked_day = pick_generated_lift_day_for_change(
                    cdt_result.proposed_days,
                    alt_days,
                    used_alt_indexes,
                    ex_idx,
                    proposed_focus,
                    focus_readiness=(
                        fatigue_snapshot.focus_readiness
                        if fatigue_snapshot else None
                    ),
                )
                if picked_day is not None:
                    if picked_idx is not None:
                        used_alt_indexes.add(picked_idx)
                    cdt_result.proposed_days[ex_idx] = {
                        **picked_day,
                        "focus": proposed_focus,
                    }
                else:
                    cdt_result.proposed_days[ex_idx]["focus"] = proposed_focus

        result_days = cdt_result.proposed_days
        result_plan = {"days": result_days, "name": ""}

        try:
            from app.models import WorkoutPlan
            from app.services.workout.weekly_recipe import PLANNER_VERSION
            now = datetime.now(timezone.utc)
            active_rows = db.exec(
                select(WorkoutPlan).where(
                    WorkoutPlan.user_id == current_user.id,
                    WorkoutPlan.is_active == True,
                )
            ).all()
            for row in active_rows:
                row.is_active = False
                row.deactivated_at = now
                row.deactivation_reason = "change_day_type"
                db.add(row)
            new_row = WorkoutPlan(
                user_id=current_user.id,
                planner_version=PLANNER_VERSION,
                goal=body.goal,
                days_per_week=body.days_per_week,
                preferred_split=body.preferred_split,
                plan_json=result_plan,
                is_active=True,
            )
            db.add(new_row)
            db.commit()
            logger.info(
                f"[generate-week] persisted plan user={current_user.id} "
                f"reason=change_day_type"
            )
        except Exception as e:
            logger.warning(f"[generate-week] plan persistence failed: {e}")

        # Also patch the active PlanWeek's PlanDay rows so the schedule
        # (which is driven by PlanWeek, not WorkoutPlan) reflects the change.
        try:
            from app.models import PlanWeek, PlanDay
            pw = db.exec(
                select(PlanWeek).where(
                    PlanWeek.user_id == current_user.id,
                    PlanWeek.status == "active",
                )
            ).first()
            if pw:
                plan_days = sorted(
                    db.exec(
                        select(PlanDay).where(PlanDay.plan_week_id == pw.id)
                    ).all(),
                    key=lambda pd: pd.day_index,
                )
                # Current PlanWeek callers send all 7 calendar rows, so
                # changed_indices are PlanDay.day_index values. Legacy callers
                # send only training recipe days, so keep the old training-day
                # mapping as a fallback.
                calendar_index_mode = (
                    bool(body.current_days)
                    and len(body.current_days) == len(plan_days)
                )
                training_days = [pd for pd in plan_days if not pd.is_rest]
                now2 = datetime.now(timezone.utc)
                for recipe_idx in cdt_result.changed_indices:
                    if recipe_idx >= len(result_days):
                        continue
                    if calendar_index_mode:
                        pd_row = next(
                            (pd for pd in plan_days if pd.day_index == recipe_idx),
                            None,
                        )
                    elif recipe_idx < len(training_days):
                        pd_row = training_days[recipe_idx]
                    else:
                        pd_row = None
                    is_target_day = recipe_idx == body.pin_day_index
                    if not pd_row or pd_row.day_date < date.today():
                        continue
                    if (
                        pd_row.locked
                        and not (
                            is_target_day
                            and pd_row.lock_reason == "manual_edit"
                        )
                    ):
                        continue
                    day_json = result_days[recipe_idx]
                    focus_norm = (day_json.get("focus") or "").lower().strip()
                    pd_row.workout_json = day_json
                    pd_row.is_rest = (
                        focus_norm in ("rest", "")
                        or (not day_json.get("exercises") and focus_norm != "empty")
                    )
                    pd_row.generation_source = "change_focus"
                    pd_row.updated_at = now2
                    db.add(pd_row)
                db.commit()
                logger.info(
                    f"[generate-week] patched PlanDay rows user={current_user.id} "
                    f"changed={cdt_result.changed_indices} "
                    f"calendar_index_mode={calendar_index_mode}"
                )
        except Exception as e:
            logger.warning(f"[generate-week] PlanDay patch failed (non-fatal): {e}")

        return {
            "days": result_days,
            "total_days_in_recipe": len(result_days),
            "plan_name": "",
            "focus_readiness": fatigue_snapshot.focus_readiness if fatigue_snapshot else {},
            "change_result": {
                "mode": cdt_result.mode,
                "changed_indices": cdt_result.changed_indices,
                "exercises_needed": cdt_result.exercises_needed,
                "conflicts": [
                    {
                        "kind": c.kind,
                        "severity": c.severity,
                        "message": c.message,
                        "affected_days": c.affected_days,
                        "suggestion": c.suggestion,
                    }
                    for c in cdt_result.conflicts
                ],
            },
        }

    # Image enrichment — mirrors generate-day.
    try:
        from app.models import Exercise as ExModel
        ex_names: set[str] = set()
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

    # Pin resolution — delegate to the pure `switch_day` helper so the
    # algorithm is unit-tested in isolation. The router still owns the
    # IO callbacks (regen-with-forced-split, generate-cardio-finisher).
    if body.pin_day_index is not None and body.pin_focus:
        from app.services.workout.switch_day import (
            decide_pin, apply_swap, apply_rotate, apply_bro_canonical_swap,
        )
        using_current_days = bool(
            body.current_days
            and len(body.current_days) >= body.days_per_week
        )
        decision = decide_pin(
            days,
            pin_day_index=body.pin_day_index,
            pin_focus=body.pin_focus,
            preferred_split=body.preferred_split,
            prefer_swap=using_current_days
            and (body.preferred_split or "").lower().strip() != "bro",
        )
        target_idx = decision.target_idx

        if decision.action == "replace_day":
            from app.services.workout.planner import (
                generate_recovery_day, generate_mobility_day, generate_cardio_day,
            )
            mins = body.session_minutes or 45
            if decision.day_kind == "recovery":
                days[target_idx] = generate_recovery_day(mins)
            elif decision.day_kind == "mobility":
                days[target_idx] = generate_mobility_day(mins)
            else:  # cardio
                days[target_idx] = generate_cardio_day(
                    mins, body.goal or "body_recomp",
                    equipment_owned=body.equipment,
                )
        elif decision.action == "noop":
            logger.info(
                f"[generate-week] pin no-op: target day {target_idx} already "
                f"matches focus '{body.pin_focus}'"
            )
        elif decision.action == "swap":
            apply_swap(days, decision)
            logger.info(
                f"[generate-week] pin swap: target {target_idx} swapped with "
                f"day {decision.swap_with_idx}, focuses now "
                f"{[d.get('focus') for d in days]}"
            )
        elif decision.action == "rotate":
            apply_rotate(days, decision, session_minutes=inputs.session_minutes)
            logger.info(
                f"[generate-week] pin canonical-rebuild: target {target_idx} "
                f"got '{body.pin_focus}', cycle restored, focuses now "
                f"{[d.get('focus') for d in days]}"
            )
        elif decision.action == "bro_canonical_swap":
            apply_bro_canonical_swap(days, decision, session_minutes=inputs.session_minutes)
            logger.info(
                f"[generate-week] pin canonical-swap (non-lifting target): "
                f"focuses now {[d.get('focus') for d in days]}"
            )
        elif decision.action == "regen":
            substituted = False
            try:
                from dataclasses import replace as _dc_replace
                alt_inputs = _dc_replace(inputs, preferred_split=decision.regen_split)
                alt_plan = generate_workout_plan(
                    alt_inputs, SEED_EXERCISES,
                    history_familiarity=history_familiarity,
                    recent_muscle_exercises=recent_muscle_exercises,
                )
                alt_days = alt_plan.get("workout_plan", {}).get("days", [])
                for ad in alt_days:
                    af = (ad.get("focus") or "").lower().strip()
                    if af == decision.regen_match_focus or af == decision.full_focus:
                        days[target_idx] = ad
                        substituted = True
                        logger.info(
                            f"[generate-week] pin substitution: regen with split="
                            f"{decision.regen_split} → using day '{ad.get('focus')}'"
                        )
                        break
            except Exception as e:
                logger.warning(f"[generate-week] pin substitution failed: {e}")
            if not substituted:
                days[target_idx] = {**days[target_idx], "focus": body.pin_focus}
                logger.warning(
                    f"[generate-week] pin fallback: label-only for {body.pin_focus} "
                    f"(no matching day after split substitution)"
                )
        elif decision.action == "label_only":
            days[target_idx] = {**days[target_idx], "focus": body.pin_focus}
            logger.warning(
                f"[generate-week] pin fallback: label-only for {body.pin_focus}"
            )

        # Cardio-finisher promotion — applies after the primary action
        # for any lifting pin where the user requested "X + Cardio".
        if decision.wants_cardio_finisher and decision.action != "replace_day":
            target_day = days[target_idx]
            current_focus = (target_day.get("focus") or "").lower()
            if " + cardio" not in current_focus:
                from app.services.workout.planner import generate_cardio_day
                finisher_day = generate_cardio_day(
                    min(25, max(15, (body.session_minutes or 45) // 3)),
                    "body_recomp",
                    equipment_owned=body.equipment,
                )
                finisher_exs = [
                    ex for ex in finisher_day.get("exercises", [])
                    if ex.get("slot_role") != "warmup"
                ]
                if finisher_exs:
                    pick = finisher_exs[0].copy()
                    pick["slot_role"] = "isolation"
                    pick["name"] = f"{pick.get('name', 'Cardio')} (Finisher)"
                    if "rest_seconds" in pick and "restSeconds" not in pick:
                        pick["restSeconds"] = pick.pop("rest_seconds")
                    else:
                        pick.pop("rest_seconds", None)
                    updated = {**target_day}
                    updated["exercises"] = [*(target_day.get("exercises") or []), pick]
                    updated["focus"] = body.pin_focus
                    days[target_idx] = updated
                    logger.info(
                        f"[generate-week] pin promote: appended cardio finisher "
                        f"'{pick.get('name')}' to target day"
                    )

    result_plan = {
        "days": days,
        "name": plan.get("workout_plan", {}).get("name", ""),
    }

    # Persist to WorkoutPlan DB table so re-login sees the switched plan.
    try:
        from app.models import WorkoutPlan
        from app.services.workout.weekly_recipe import PLANNER_VERSION
        now = datetime.now(timezone.utc)
        active_rows = db.exec(
            select(WorkoutPlan).where(
                WorkoutPlan.user_id == current_user.id,
                WorkoutPlan.is_active == True,  # noqa: E712
            )
        ).all()
        for row in active_rows:
            row.is_active = False
            row.deactivated_at = now
            row.deactivation_reason = "switch_day"
            db.add(row)
        new_row = WorkoutPlan(
            user_id=current_user.id,
            planner_version=PLANNER_VERSION,
            goal=body.goal,
            days_per_week=body.days_per_week,
            preferred_split=body.preferred_split,
            plan_json=result_plan,
            is_active=True,
        )
        db.add(new_row)
        db.commit()
        logger.info(
            f"[generate-week] persisted active plan for user={current_user.id} "
            f"version={PLANNER_VERSION} reason=switch_day"
        )
    except Exception as e:
        logger.warning(f"[generate-week] plan persistence failed (non-fatal): {e}")

    return {
        "days": days,
        "total_days_in_recipe": len(days),
        "plan_name": result_plan.get("name", ""),
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
    plan_lock_focus_label = body.focus_label
    feedback_only_patch = _is_feedback_only_patch(body)
    source_context = (body.source_context or "").strip().lower()
    external_source_id = (body.external_source_id or "").strip() or None
    activity_started_at, activity_ended_at = _activity_time_bounds(body)
    calories_burned = _estimated_activity_calories(
        body,
        db=db,
        user_id=current_user.id,
    )

    # Defensive guard: reject completions that have NO sets logged AND
    # no duration AND aren't a manual activity (cardio / sport / etc).
    # This blocks phantom completions from a stray watch end-workout
    # signal that wasn't backed by a real session — exactly the bug the
    # user hit waking up to a "done" day with nothing in history.
    has_real_data = (
        (body.duration_seconds and body.duration_seconds > 30) or
        bool(body.activity_category) or
        bool(body.exercises and len(body.exercises) > 0)
    )
    if not has_real_data:
        raise HTTPException(
            status_code=400,
            detail="Empty completion rejected — log sets, duration, or pick an activity first.",
        )

    existing = None
    if external_source_id:
        existing = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.external_source_id == external_source_id)
        ).first()
    allow_date_focus_upsert = (
        feedback_only_patch
        or source_context not in _MANUAL_COMPLETION_CONTEXTS
    )
    if existing is None and allow_date_focus_upsert:
        existing = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.workout_date == body.workout_date)
            .where(WorkoutCompletion.focus_label == body.focus_label)
        ).first()
    if existing is None and feedback_only_patch:
        existing = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.workout_date == body.workout_date)
            .order_by(WorkoutCompletion.completed_at.desc(), WorkoutCompletion.id.desc())
        ).first()

    completion_row_for_request: WorkoutCompletion | None = None
    if existing:
        if not feedback_only_patch or body.duration_seconds > 0:
            existing.duration_seconds = body.duration_seconds
        existing.stimulus           = body.stimulus if body.stimulus is not None else existing.stimulus
        existing.source_context     = body.source_context or existing.source_context
        existing.template_id        = body.template_id or existing.template_id
        existing.plan_day_id        = body.plan_day_id if body.plan_day_id is not None else existing.plan_day_id
        existing.activity_category  = body.activity_category or existing.activity_category
        existing.activity_subtype   = body.activity_subtype or existing.activity_subtype
        existing.activity_intensity = body.activity_intensity or existing.activity_intensity
        existing.activity_source    = body.activity_source or existing.activity_source
        existing.cardio_style       = body.cardio_style or existing.cardio_style
        existing.distance_miles     = body.distance_miles if body.distance_miles is not None else existing.distance_miles
        existing.calories_burned    = calories_burned if calories_burned is not None else existing.calories_burned
        existing.hr_summary         = body.hr_summary if body.hr_summary is not None else existing.hr_summary
        existing.feeling            = body.feeling if body.feeling is not None else existing.feeling
        existing.intensity          = body.intensity if body.intensity is not None else existing.intensity
        existing.soreness_areas     = body.soreness_areas if body.soreness_areas is not None else existing.soreness_areas
        existing.feedback_notes     = body.feedback_notes if body.feedback_notes is not None else existing.feedback_notes
        existing.started_at         = activity_started_at if activity_started_at is not None else existing.started_at
        existing.ended_at           = activity_ended_at if body.ended_at is not None or body.started_at is not None else existing.ended_at
        existing.external_source_id = external_source_id or existing.external_source_id
        if not feedback_only_patch:
            existing.completed_at = activity_ended_at
        db.add(existing)
        completion_row_for_request = existing
    else:
        completion_row_for_request = WorkoutCompletion(
            user_id=current_user.id,
            workout_date=body.workout_date,
            focus_label=body.focus_label,
            duration_seconds=body.duration_seconds,
            stimulus=body.stimulus,
            source_context=body.source_context,
            template_id=body.template_id,
            plan_day_id=body.plan_day_id,
            activity_category=body.activity_category,
            activity_subtype=body.activity_subtype,
            activity_intensity=body.activity_intensity,
            activity_source=body.activity_source,
            cardio_style=body.cardio_style,
            distance_miles=body.distance_miles,
            calories_burned=calories_burned,
            hr_summary=body.hr_summary,
            started_at=activity_started_at,
            ended_at=activity_ended_at,
            external_source_id=external_source_id,
            feeling=body.feeling,
            intensity=body.intensity,
            soreness_areas=body.soreness_areas,
            feedback_notes=body.feedback_notes,
            completed_at=activity_ended_at,
        )
        db.add(completion_row_for_request)

    # Commit the lightweight completion row immediately so that a rollback
    # in the structured-persistence block below cannot undo it.
    db.commit()
    completion_row_id = getattr(completion_row_for_request, "id", None)
    if completion_row_for_request is not None and completion_row_id is None:
        try:
            db.refresh(completion_row_for_request)
            completion_row_id = completion_row_for_request.id
        except Exception:
            completion_row_id = None

    # Also persist structured per-exercise data if the client sent it.
    # Best-effort: failures here must NOT block the lightweight
    # completion — the user has finished their workout and expects
    # the app to move on.
    session_rows_created = 0
    if body.exercises:
        try:
            from app.models import Exercise as _Exercise, WorkoutSource, EquipmentType

            def _coerce_equipment(raw: str | None) -> EquipmentType:
                if not raw:
                    return EquipmentType.OTHER
                r = raw.strip().lower()
                if r in ('barbell', 'machine', 'cable', 'gym', 'smith', 'leg_press', 'leg press'):
                    return EquipmentType.GYM
                if r in ('dumbbell', 'dumbbells', 'kettlebell', 'kb'):
                    return EquipmentType.DUMBBELLS
                if r in ('bodyweight', 'bw', 'none', ''):
                    return EquipmentType.BODYWEIGHT
                if r in ('home', 'band', 'bands', 'resistance_band'):
                    return EquipmentType.HOME
                if r in ('cardio', 'treadmill', 'bike', 'rower', 'elliptical'):
                    return EquipmentType.CARDIO
                try:
                    return EquipmentType[raw.upper()]
                except Exception:
                    return EquipmentType.OTHER

            def _muscle_value(raw) -> str | None:
                if raw is None:
                    return None
                return (raw.value if hasattr(raw, "value") else str(raw)).lower()

            def _muscle_list(raw) -> list[str]:
                if not raw:
                    return []
                return [
                    v
                    for v in (_muscle_value(item) for item in raw)
                    if v
                ]

            def _session_source(raw: str | None) -> WorkoutSource:
                normalized = (raw or "planned").strip().lower()
                if normalized in ("planned", "plan", "generated"):
                    return WorkoutSource.GENERATED
                if normalized in ("manual_activity", "apple_health", "watch", "coach_log"):
                    return WorkoutSource.LOGGED
                return WorkoutSource.CUSTOM

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
                # Was N+1: one SELECT per session for exercises, then one
                # SELECT per exercise for its sets, then per-row deletes.
                # On a 6-exercise session that's ~14 round trips just to
                # clear old rows. Now: one IN-set fetch for exercise ids,
                # one bulk DELETE for sets, one bulk DELETE for exercises.
                from sqlmodel import col, delete as sql_delete
                old_ex_ids = list(db.exec(
                    select(WorkoutExercise.id)
                    .where(WorkoutExercise.session_id == existing_session.id)
                ).all())
                if old_ex_ids:
                    db.exec(sql_delete(ExerciseSet).where(col(ExerciseSet.workout_exercise_id).in_(old_ex_ids)))
                    db.exec(sql_delete(WorkoutExercise).where(col(WorkoutExercise.id).in_(old_ex_ids)))
                existing_session.completed_at = activity_ended_at
                existing_session.source = _session_source(body.source_context)
                session_row = existing_session
                db.add(session_row)
                db.flush()
            else:
                session_row = WorkoutSession(
                    user_id=current_user.id,
                    name=body.focus_label or "Workout",
                    focus=body.focus_label or "",
                    workout_date=body.workout_date,
                    source=_session_source(body.source_context),
                    completed_at=activity_ended_at,
                )
                db.add(session_row)
                db.flush()

            for idx, ex_payload in enumerate(body.exercises):
                resolved_exercise_id = None
                seed = None
                if ex_payload.slug:
                    seed = db.exec(
                        select(_Exercise).where(_Exercise.slug == ex_payload.slug)
                    ).first()
                if seed is None and ex_payload.name:
                    seed = db.exec(
                        select(_Exercise).where(_Exercise.name.ilike(ex_payload.name))
                    ).first()
                if seed is not None:
                    resolved_exercise_id = seed.id

                primary_snapshot = (
                    (ex_payload.primary_muscle or "").strip().lower()
                    or _muscle_value(getattr(seed, "primary_muscle", None))
                )
                secondary_snapshot = (
                    [str(m).lower() for m in ex_payload.secondary_muscles]
                    if ex_payload.secondary_muscles is not None
                    else _muscle_list(getattr(seed, "secondary_muscles", None))
                )
                slug_snapshot = (
                    (ex_payload.slug or "").strip()
                    or getattr(seed, "slug", None)
                    or None
                )
                is_compound_snapshot = (
                    ex_payload.is_compound
                    if ex_payload.is_compound is not None
                    else getattr(seed, "is_compound", None)
                )

                exercise = WorkoutExercise(
                    session_id=session_row.id,
                    exercise_id=resolved_exercise_id,
                    name=ex_payload.name,
                    order_index=ex_payload.order_index or idx,
                    equipment=_coerce_equipment(ex_payload.equipment),
                    exercise_slug_snapshot=slug_snapshot,
                    primary_muscle_snapshot=primary_snapshot,
                    secondary_muscles_snapshot=secondary_snapshot,
                    is_compound_snapshot=is_compound_snapshot,
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
                        actual_rir=set_payload.rir,
                        duration_seconds=set_payload.duration_seconds,
                        comfort_rating=set_payload.comfort_rating,
                        actual_distance=set_payload.actual_distance,
                        actual_pace=set_payload.actual_pace,
                        heart_rate_avg=set_payload.heart_rate_avg,
                        cardio_metrics=set_payload.cardio_metrics,
                        completed=True,
                        completed_at=activity_ended_at,
                    ))
            session_rows_created = 1
        except Exception as e:
            logger.warning(
                f"[workouts/complete] structured persistence FAILED "
                f"user={current_user.id} date={body.workout_date} focus={body.focus_label} "
                f"exercises={len(body.exercises)}: {type(e).__name__}: {e}"
            )
            db.rollback()
            from sqlalchemy.exc import IntegrityError
            if isinstance(e, IntegrityError):
                raise

    # Resolve per-muscle fatigue and store on the completion row.
    # Uses per-exercise data when available, falls back to focus-label estimate.
    try:
        from app.services.workout.activity_impact import resolve_exercise_fatigue, resolve_focus_fatigue
        completion_row = (
            db.get(WorkoutCompletion, completion_row_id)
            if completion_row_id is not None
            else None
        )
        if completion_row is None:
            fallback_q = select(WorkoutCompletion).where(WorkoutCompletion.user_id == current_user.id)
            if external_source_id:
                fallback_q = fallback_q.where(WorkoutCompletion.external_source_id == external_source_id)
            else:
                fallback_q = (
                    fallback_q
                    .where(WorkoutCompletion.workout_date == body.workout_date)
                    .where(WorkoutCompletion.focus_label == body.focus_label)
                    .order_by(WorkoutCompletion.completed_at.desc(), WorkoutCompletion.id.desc())
                )
            completion_row = db.exec(fallback_q).first()
        if completion_row:
            # Lookup user's age so fatigue scales correctly with biology.
            # Missing age defaults to baseline (no scaling) inside the resolver.
            from app.models import UserProfile as UserProfileModel
            user_age: int | None = None
            try:
                profile_row = db.exec(
                    select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
                ).first()
                user_age = profile_row.age if profile_row else None
            except Exception:
                user_age = None

            should_keep_existing_fatigue = (
                feedback_only_patch
                and isinstance(completion_row.resolved_muscle_fatigue, dict)
                and bool(completion_row.resolved_muscle_fatigue)
            )
            if should_keep_existing_fatigue:
                resolved = dict(completion_row.resolved_muscle_fatigue)
            elif body.exercises:
                from app.seed_exercises_data import SEED_EXERCISES
                seed_map = {e["name"].lower(): e for e in SEED_EXERCISES}
                seed_slug_map = {e.get("slug", "").lower(): e for e in SEED_EXERCISES if e.get("slug")}
                ex_list = []
                for ep in body.exercises:
                    seed = seed_slug_map.get((ep.slug or "").lower()) or seed_map.get(ep.name.lower(), {})
                    secondary_muscles = (
                        ep.secondary_muscles
                        if ep.secondary_muscles is not None
                        else seed.get("secondary_muscles", [])
                    )
                    # Pass structured per-set data (reps, weight, RIR, HR) so
                    # resolve_exercise_fatigue can compute volume-load and
                    # stimulus-specific fatigue (heavy vs hypertrophy vs volume
                    # produce different systemic/muscular ratios). HR enables
                    # cardiovascular intensity estimation per exercise.
                    set_dicts = [
                        {"reps": s.reps, "weight_lbs": s.weight_lbs, "rir": s.rir, "heart_rate_avg": s.heart_rate_avg}
                        for s in ep.sets
                    ]
                    ex_list.append({
                        "name": ep.name,
                        "slug": ep.slug or seed.get("slug"),
                        "primary_muscle": ep.primary_muscle or seed.get("primary_muscle", ""),
                        "secondary_muscles": secondary_muscles or [],
                        "is_compound": ep.is_compound if ep.is_compound is not None else seed.get("is_compound", False),
                        "sets_logged": len(ep.sets),
                        "sets": set_dicts,
                    })
                resolved = resolve_exercise_fatigue(
                    ex_list,
                    intensity=body.activity_intensity or "moderate",
                    duration_minutes=body.duration_seconds // 60 if body.duration_seconds > 0 else 60,
                    user_age=user_age,
                )
            else:
                resolved = resolve_focus_fatigue(
                    body.focus_label,
                    intensity=body.activity_intensity or "moderate",
                    duration_minutes=body.duration_seconds // 60 if body.duration_seconds > 0 else 60,
                    user_age=user_age,
                )
            completion_row.resolved_muscle_fatigue = resolved
            # If exercises were provided, infer the correct focus from the
            # primary muscles worked. The client may send a stale focus_label
            # (e.g. "Recovery" from the plan day) even though the user did
            # actual lifting exercises.
            completion_context = (completion_row.source_context or body.source_context or "").lower()
            is_planned_completion = body.plan_day_id is not None or completion_context == "planned"
            if body.exercises and resolved:
                top_muscles = sorted(resolved.items(), key=lambda x: -x[1])
                top = [m for m, v in top_muscles if m != 'systemic' and v > 0.1]
                if top and not is_planned_completion:
                    inferred = _infer_focus_from_muscles(top)
                    # Never rename PLUS_CARDIO labels — the client sent
                    # "Push + Cardio" intentionally and both WorkoutSession
                    # and local history keep the original. Renaming only
                    # the completion row breaks the upsert key and causes
                    # double entries.
                    is_plus_cardio = "+ cardio" in (completion_row.focus_label or "").lower()
                    if inferred and inferred != completion_row.focus_label and not is_plus_cardio:
                        logger.info(f"[workouts/complete] focus corrected: {completion_row.focus_label!r} → {inferred!r} (from exercises)")
                        completion_row.focus_label = inferred
                # Re-derive stimulus from what the user ACTUALLY did, not
                # what the plan said to do. A planned "heavy" day done at
                # 12+ rep sets is really a volume day; the planner's
                # intensity-spacing rules should react to reality.
                all_reps: list[int] = []
                for ep in body.exercises:
                    for s in ep.sets:
                        if s.reps and s.reps > 0:
                            all_reps.append(s.reps)
                if all_reps:
                    avg_reps = sum(all_reps) / len(all_reps)
                    if avg_reps <= 6:
                        derived_stimulus = "strength"
                    elif avg_reps <= 11:
                        derived_stimulus = "hypertrophy"
                    else:
                        derived_stimulus = "volume"
                    if completion_row.stimulus != derived_stimulus:
                        logger.info(
                            f"[workouts/complete] stimulus re-derived: "
                            f"{completion_row.stimulus!r} → {derived_stimulus!r} "
                            f"(avg_reps={avg_reps:.1f})"
                        )
                        completion_row.stimulus = derived_stimulus
            plan_lock_focus_label = completion_row.focus_label or plan_lock_focus_label
            db.add(completion_row)
    except Exception as e:
        logger.info(f"[workouts/complete] muscle fatigue resolution failed (non-fatal): {e}")

    if not feedback_only_patch:
        try:
            from app.routers.social import write_activity
            write_activity(db, current_user.id, "workout_completed", {
                "focus": body.focus_label,
                "duration_seconds": body.duration_seconds,
                "date": str(body.workout_date),
                "exercise_count": len(body.exercises) if body.exercises else 0,
                "activity_category": body.activity_category,
                "activity_subtype": body.activity_subtype,
                "cardio_style": body.cardio_style,
                "distance_miles": body.distance_miles,
                "hr_summary": body.hr_summary,
                "exercises": [
                    {
                        "name": ex.name,
                        "equipment": ex.equipment,
                        "sets": [
                            {
                                "reps": s.reps,
                                "weight_lbs": s.weight_lbs,
                                "duration_seconds": s.duration_seconds,
                                "actual_distance": s.actual_distance,
                                "actual_pace": s.actual_pace,
                                "heart_rate_avg": s.heart_rate_avg,
                                "cardio_metrics": s.cardio_metrics,
                            }
                            for s in ex.sets
                        ],
                    }
                    for ex in (body.exercises or [])
                ],
            })
        except Exception:
            pass

    db.commit()
    logger.info(f"[workouts/complete] COMMITTED user={current_user.id} date={body.workout_date} focus={body.focus_label} dur={body.duration_seconds}s exercises={len(body.exercises) if body.exercises else 0}")

    # Auto-lock the corresponding PlanDay if the weekly model is active.
    try:
        from app.services.workout.week_manager import lock_day_on_complete
        lock_day_on_complete(
            db,
            current_user.id,
            body.workout_date,
            plan_lock_focus_label,
            plan_day_id=body.plan_day_id,
        )
    except Exception as e:
        logger.debug(f"[workouts/complete] plan_day lock failed (non-fatal): {e}")

    # Yesterday-strain pillar in readiness changes the moment a workout
    # lands. Drop the cache so the next /readiness/today recomputes.
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(current_user.id)
    except Exception:
        pass

    # Verify the row exists
    verify = (
        db.get(WorkoutCompletion, completion_row_id)
        if completion_row_id is not None
        else None
    )
    if verify is None:
        verify = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.workout_date == body.workout_date)
            .where(WorkoutCompletion.focus_label == body.focus_label)
        ).first()
    logger.info(f"[workouts/complete] VERIFY: row={'FOUND' if verify else 'MISSING'} resolved_fatigue={bool(verify.resolved_muscle_fatigue) if verify else 'N/A'}")

    # ── PR detection ──
    # After the session row is committed, compare each logged set to the
    # user's all-time best for the same exercise. Best-effort: a failure
    # here must never block a successful workout completion.
    prs: list[dict] = []
    if body.exercises and session_rows_created:
        try:
            from app.services.workout.pr_detection import detect_prs
            session_row = db.exec(
                select(WorkoutSession)
                .where(WorkoutSession.user_id == current_user.id)
                .where(WorkoutSession.workout_date == body.workout_date)
                .where(WorkoutSession.focus == body.focus_label)
            ).first()
            if session_row is not None:
                prs = detect_prs(current_user.id, session_row.id, db)
                if prs:
                    logger.info(
                        f"[workouts/complete] PRs detected user={current_user.id} "
                        f"session={session_row.id} count={len(prs)}"
                    )
                    try:
                        from app.routers.social import write_activity
                        for pr in prs:
                            write_activity(db, current_user.id, "pr_achieved", {
                                "exercise": pr.get("exercise_name", ""),
                                "pr_type": pr.get("pr_type", ""),
                                "value": pr.get("value"),
                                "unit": pr.get("unit", "lbs"),
                                "date": str(body.workout_date),
                            })
                        db.commit()
                    except Exception:
                        pass
        except Exception as e:
            logger.info(f"[workouts/complete] PR detection failed (non-fatal): {e}")
            prs = []

    # ── Gear mileage / session accumulation ──
    # Three modes, in priority order:
    #   1. body.gear_ids = []         → user explicitly said "no gear today",
    #                                    skip both modes — credit nothing
    #   2. body.gear_ids = [1,3,...]  → user picked specific gear (per-session
    #                                    disambiguation prompt). Credit ONLY
    #                                    these IDs. Bypasses keyword match
    #                                    entirely so two pairs of running
    #                                    shoes both keyworded with "run"
    #                                    don't double-count
    #   3. body.gear_ids = None        → legacy keyword auto-match (default)
    # Best-effort: never blocks a successful completion.
    try:
        from app.models import GearItem
        from sqlmodel import col

        explicit_ids = body.gear_ids
        if explicit_ids is not None and len(explicit_ids) == 0:
            gear_items = []
        elif explicit_ids:
            gear_items = db.exec(
                select(GearItem)
                .where(GearItem.user_id == current_user.id)
                .where(GearItem.is_active == True)
                .where(col(GearItem.id).in_(explicit_ids))
            ).all()
        else:
            gear_items = db.exec(
                select(GearItem)
                .where(GearItem.user_id == current_user.id)
                .where(GearItem.is_active == True)
            ).all()
        if gear_items:
            focus_lower = (body.focus_label or "").lower()
            exercise_names_lower = [ep.name.lower() for ep in (body.exercises or [])]
            total_set_distance_miles = 0.0
            for ep in (body.exercises or []):
                for s in ep.sets:
                    if hasattr(s, "actual_distance") and s.actual_distance:
                        total_set_distance_miles += s.actual_distance
            total_distance_miles = (
                total_set_distance_miles
                if total_set_distance_miles > 0
                else float(body.distance_miles or 0.0)
            )
            now = datetime.now(timezone.utc)
            for gear in gear_items:
                # Explicit-pick path: skip the keyword guard entirely. The
                # user told us this gear was used; trust them.
                if explicit_ids:
                    matched = True
                else:
                    keywords = [kw.lower() for kw in (gear.auto_track_keywords or [])]
                    if not keywords:
                        continue
                    matched = any(
                        kw in focus_lower or any(kw in en for en in exercise_names_lower)
                        for kw in keywords
                    )
                if matched:
                    gear.accumulated_miles += total_distance_miles
                    gear.accumulated_sessions += 1
                    gear.updated_at = now
                    gear.last_used_at = now
                    db.add(gear)
            if gear_items:
                db.commit()
    except Exception as e:
        logger.debug(f"[workouts/complete] gear accumulation failed (non-fatal): {e}")

    return {
        "ok": True,
        "structured_persisted": bool(session_rows_created),
        "prs": prs,
    }


@router.delete("/completion", status_code=204)
def delete_workout_completion(
    workout_date: date = Query(..., description="YYYY-MM-DD"),
    focus_label: str | None = Query(None, description="Optional focus to delete a specific session instead of all"),
    completion_id: int | None = Query(None, description="Optional WorkoutCompletion id to delete one exact row"),
    external_source_id: str | None = Query(None, description="Optional client/HealthKit id to delete one exact row"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Delete `WorkoutCompletion` rows for the given date. Exact ids
    remove one row; focus-only/date-only preserves legacy behavior.

    Also wipes any matching `WorkoutSession` rows so per-set detail
    + downstream PR / volume rollups don't keep referencing the
    deleted day. Per-set + per-exercise children are removed via
    cascade through the FK, but we don't define cascade on these
    tables — clean them up explicitly.
    """
    focus_label = focus_label if isinstance(focus_label, str) else None
    completion_id = completion_id if isinstance(completion_id, int) else None
    external_source_id = external_source_id if isinstance(external_source_id, str) else None

    q = (
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == workout_date)
    )
    if completion_id is not None:
        q = q.where(WorkoutCompletion.id == completion_id)
    elif external_source_id:
        q = q.where(WorkoutCompletion.external_source_id == external_source_id)
    elif focus_label:
        q = q.where(WorkoutCompletion.focus_label == focus_label)
    rows = db.exec(q).all()
    for r in rows:
        db.delete(r)

    sessions = []
    if completion_id is None and not external_source_id:
        sq = (
            select(WorkoutSession)
            .where(WorkoutSession.user_id == current_user.id)
            .where(WorkoutSession.workout_date == workout_date)
        )
        if focus_label:
            sq = sq.where(WorkoutSession.focus == focus_label)
        sessions = db.exec(sq).all()
    if sessions:
        # Cascade: drop child exercise rows + set rows. Was a 3-level
        # nested per-row delete; now three bulk DELETEs total (sets,
        # exercises, sessions) regardless of how many rows match.
        from sqlmodel import col, delete as sql_delete
        session_ids = [s.id for s in sessions]
        ex_ids = list(db.exec(
            select(WorkoutExercise.id).where(col(WorkoutExercise.session_id).in_(session_ids))
        ).all())
        if ex_ids:
            db.exec(sql_delete(ExerciseSet).where(col(ExerciseSet.workout_exercise_id).in_(ex_ids)))
            db.exec(sql_delete(WorkoutExercise).where(col(WorkoutExercise.id).in_(ex_ids)))
        db.exec(sql_delete(WorkoutSession).where(col(WorkoutSession.id).in_(session_ids)))

    db.commit()


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


class WorkoutSyncRequest(BaseModel):
    """Partial / in-progress workout snapshot. Written to WorkoutSession +
    WorkoutExercise + ExerciseSet so per-set detail survives app kills and
    cross-device use. Does NOT write WorkoutCompletion — the workout isn't
    done yet. /workouts/complete remains the "I'm finished" signal."""
    workout_date: date
    focus_label: str
    exercises: list[CompletedExercisePayload]


@router.post("/sync")
def sync_in_progress_workout(
    body: WorkoutSyncRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Save a mid-workout snapshot of logged exercises/sets. Called after
    every set so we don't rely solely on client local storage."""
    if not body.exercises:
        return {"ok": True, "session_id": None, "exercises": 0, "sets": 0}
    try:
        from app.models import Exercise as _Exercise, WorkoutSource, EquipmentType

        def _coerce_equipment(raw: str | None) -> EquipmentType:
            """Client sends free-text equipment ('barbell', 'dumbbells', etc.).
            Map to the EquipmentType enum or fall back to OTHER so the insert
            never fails on an enum mismatch."""
            if not raw:
                return EquipmentType.OTHER
            r = raw.strip().lower()
            if r in ('barbell', 'machine', 'cable', 'gym', 'smith', 'leg_press', 'leg press'):
                return EquipmentType.GYM
            if r in ('dumbbell', 'dumbbells', 'kettlebell', 'kb'):
                return EquipmentType.DUMBBELLS
            if r in ('bodyweight', 'bw', 'none', ''):
                return EquipmentType.BODYWEIGHT
            if r in ('home', 'band', 'bands', 'resistance_band'):
                return EquipmentType.HOME
            if r in ('cardio', 'treadmill', 'bike', 'rower', 'elliptical'):
                return EquipmentType.CARDIO
            try:
                return EquipmentType[raw.upper()]
            except Exception:
                return EquipmentType.OTHER

        existing_session = db.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == current_user.id)
            .where(WorkoutSession.workout_date == body.workout_date)
            .where(WorkoutSession.focus == body.focus_label)
        ).first()
        if existing_session:
            # Bulk delete child rows — same N+1 elimination as the
            # /complete path (ExerciseSet + WorkoutExercise via IN-set
            # DELETEs). Hot path: this fires after every set in the
            # active workout, so per-set latency matters.
            from sqlmodel import col, delete as sql_delete
            old_ex_ids = list(db.exec(
                select(WorkoutExercise.id).where(WorkoutExercise.session_id == existing_session.id)
            ).all())
            if old_ex_ids:
                db.exec(sql_delete(ExerciseSet).where(col(ExerciseSet.workout_exercise_id).in_(old_ex_ids)))
                db.exec(sql_delete(WorkoutExercise).where(col(WorkoutExercise.id).in_(old_ex_ids)))
            session_row = existing_session
        else:
            session_row = WorkoutSession(
                user_id=current_user.id,
                name=body.focus_label or "Workout",
                focus=body.focus_label or "",
                workout_date=body.workout_date,
                source=WorkoutSource.GENERATED,
            )
            db.add(session_row)
        db.flush()

        total_sets = 0
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
                equipment=_coerce_equipment(ex_payload.equipment),
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
                    actual_rir=set_payload.rir,
                    duration_seconds=set_payload.duration_seconds,
                    comfort_rating=set_payload.comfort_rating,
                    actual_distance=set_payload.actual_distance,
                    actual_pace=set_payload.actual_pace,
                    heart_rate_avg=set_payload.heart_rate_avg,
                    cardio_metrics=set_payload.cardio_metrics,
                    completed=True,
                    completed_at=datetime.now(timezone.utc),
                ))
                total_sets += 1
        db.commit()
        logger.info(f"[workouts/sync] user={current_user.id} date={body.workout_date} focus={body.focus_label} exercises={len(body.exercises)} sets={total_sets}")

        # PR detection on mid-workout sync. Fire-and-forget from the
        # client's POV — we still return the payload so a client that
        # wants to show a toast right after a heavy set can.
        prs: list[dict] = []
        try:
            from app.services.workout.pr_detection import detect_prs
            prs = detect_prs(current_user.id, session_row.id, db)
        except Exception as e:
            logger.info(f"[workouts/sync] PR detection failed (non-fatal): {e}")
            prs = []

        return {
            "ok": True,
            "session_id": session_row.id,
            "exercises": len(body.exercises),
            "sets": total_sets,
            "prs": prs,
        }
    except Exception as e:
        db.rollback()
        logger.warning(f"[workouts/sync] FAILED user={current_user.id} date={body.workout_date} focus={body.focus_label}: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"Sync failed: {type(e).__name__}")


@router.get("/streak")
def get_streak(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the user's training streak + compliance summary (Feature 8).

    Deterministic — reads ``WorkoutCompletion`` + ``UserDayState`` and
    rolls up current/longest streak plus 7/30-day compliance.
    """
    from app.services.workout.streak import compute_streak_summary
    return compute_streak_summary(current_user.id, db=db)


@router.get("/weekly-review")
def get_weekly_review(
    days: int = 7,
    end_date: date | None = None,
    weight_slope_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_steps: float | None = None,
    readiness_score: int | None = None,
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Deterministic weekly plan review with full signal integration.

    Caller (phone) passes Apple Health-derived signals it already
    computed (weight slope, sleep, RHR, steps, readiness) so the
    review can factor them in without double-fetching. All optional —
    the review degrades gracefully when AH isn't connected.

    No AI. Everything is rules on existing completion + nutrition +
    plan + (optional) health data. The response is structured
    recommendations the client renders as accept/dismiss cards."""
    from app.services.workout.plan_review_v2 import compute_weekly_review
    review = compute_weekly_review(
        db, current_user.id,
        end_date=end_date,
        days=max(3, min(28, days)),
        weight_trend_lbs_per_week=weight_slope_lbs_per_week,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        avg_steps=avg_steps,
        readiness_score=readiness_score,
    )
    return review.to_dict()


@router.get("/weekly-volume")
def get_weekly_volume(
    days: int = 7,
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Per-muscle hard-set counts for the last `days` days.

    Returned separately from the full review so clients that only need
    the volume chart (analytics / progress tab) don't have to pay for
    the recommendation pass."""
    from app.services.workout.weekly_volume import compute_weekly_volume
    snap = compute_weekly_volume(db, current_user.id, days=max(3, min(28, days)))
    return snap.to_dict()


@router.get("/e1rm")
def get_estimated_1rm(
    exercise_name: str = Query(..., description="Exercise name to compute e1RM for"),
    role: str = Query("primary", description="Exercise role (primary/isolation)"),
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Rolling estimated 1RM for a specific exercise based on logged sets."""
    from app.services.workout.rolling_e1rm import UsableSet, compute_rolling_e1rm

    rows = db.exec(
        select(ExerciseSet, WorkoutExercise, WorkoutSession)
        .join(WorkoutExercise, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .join(WorkoutSession, WorkoutExercise.session_id == WorkoutSession.id)
        .where(
            WorkoutSession.user_id == current_user.id,
            func.lower(WorkoutExercise.name) == exercise_name.lower(),
            ExerciseSet.completed == True,
        )
    ).all()

    usable_sets = [
        UsableSet(
            completed_at=es.completed_at or ws.workout_date,
            actual_weight_lbs=es.actual_weight_lbs or 0,
            actual_reps=es.actual_reps or 0,
            actual_rir=es.actual_rir,
            target_rir=es.rir_target,
            set_type=es.set_type,
        )
        for es, _we, ws in rows
    ]

    estimate = compute_rolling_e1rm(usable_sets, role=role)
    if estimate is None:
        return {"e1rm": None, "reason": "not_enough_data"}
    return {"e1rm": estimate.to_dict()}


@router.get("/e1rm/history")
def get_e1rm_history(
    exercise_name: str = Query(..., description="Exercise name"),
    role: str = Query("primary", description="Exercise role"),
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Rolling e1RM over time for chart display. Computes e1RM at each
    session date using only data available up to that point."""
    from app.services.workout.rolling_e1rm import UsableSet, compute_rolling_e1rm

    rows = db.exec(
        select(ExerciseSet, WorkoutExercise, WorkoutSession)
        .join(WorkoutExercise, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .join(WorkoutSession, WorkoutExercise.session_id == WorkoutSession.id)
        .where(
            WorkoutSession.user_id == current_user.id,
            func.lower(WorkoutExercise.name) == exercise_name.lower(),
            ExerciseSet.completed == True,
        )
    ).all()

    all_sets = [
        (
            ws.workout_date,
            UsableSet(
                completed_at=es.completed_at or ws.workout_date,
                actual_weight_lbs=es.actual_weight_lbs or 0,
                actual_reps=es.actual_reps or 0,
                actual_rir=es.actual_rir,
                target_rir=es.rir_target,
                set_type=es.set_type,
            ),
        )
        for es, _we, ws in rows
    ]
    all_sets.sort(key=lambda x: x[0])

    session_dates = sorted(set(d for d, _ in all_sets))
    points = []
    for target_date in session_dates:
        subset = [s for d, s in all_sets if d <= target_date]
        est = compute_rolling_e1rm(subset, role=role, today=target_date)
        if est:
            points.append({
                "date": target_date.isoformat(),
                "e1rm_lbs": round(est.e1rm_lbs, 1),
                "confidence": est.confidence,
                "sample_count": est.sample_count,
            })

    return {"exercise": exercise_name, "history": points}


@router.get("/e1rm/all")
def get_all_e1rm(
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Bulk rolling-e1RM map for every exercise the user has logged sets
    for. One round-trip instead of N (one per exercise). Used by the
    Progress History screen to show consistent 1RM values across the
    chart, the showcase tile, and per-PR cards — same compute path
    everywhere so the user never sees three different numbers for the
    same lift.

    Returns: `{exercises: {<name_lower>: <e1rm_lbs>}}`.

    Names with fewer than 3 usable sets are omitted (rolling-e1RM
    refuses to estimate from too little data — see
    `compute_rolling_e1rm` source). The frontend falls back to its
    per-set helper for those exercises and notes the lower confidence.
    """
    from app.services.workout.rolling_e1rm import UsableSet, compute_rolling_e1rm

    rows = db.exec(
        select(ExerciseSet, WorkoutExercise, WorkoutSession)
        .join(WorkoutExercise, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .join(WorkoutSession, WorkoutExercise.session_id == WorkoutSession.id)
        .where(
            WorkoutSession.user_id == current_user.id,
            ExerciseSet.completed == True,  # noqa: E712
        )
    ).all()

    by_name: dict[str, list[UsableSet]] = {}
    for es, we, ws in rows:
        name_key = (we.name or "").strip().lower()
        if not name_key:
            continue
        by_name.setdefault(name_key, []).append(UsableSet(
            completed_at=es.completed_at or ws.workout_date,
            actual_weight_lbs=es.actual_weight_lbs or 0,
            actual_reps=es.actual_reps or 0,
            actual_rir=es.actual_rir,
            target_rir=es.rir_target,
            set_type=es.set_type,
        ))

    out: dict[str, float] = {}
    for name_key, sets in by_name.items():
        # Role defaults to "primary" for the bulk path. The per-exercise
        # endpoint accepts a role override; we keep that for callers
        # that already know the role of the exercise they care about.
        est = compute_rolling_e1rm(sets, role="primary")
        if est is not None and est.e1rm_lbs > 0:
            out[name_key] = round(est.e1rm_lbs, 1)
    return {"exercises": out}


@router.get("/completions")
def list_completions(
    limit: int = Query(default=100, ge=1, le=500),
    skip: int = Query(default=0, ge=0),
    since: date | None = Query(default=None),
    before: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Paginated workout-completion list. Used by the mobile app as a
    fallback when local `workoutHistory` is missing (fresh install, state
    wipe). Completions carry date/focus/duration and summary health metrics
    but NOT per-set detail — that only lives in `WorkoutSession` rows when
    the client sent exercises."""
    query = (
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
    )
    if since:
        query = query.where(WorkoutCompletion.workout_date >= since)
    if before:
        query = query.where(WorkoutCompletion.workout_date <= before)
    rows = db.exec(
        query.order_by(WorkoutCompletion.workout_date.desc(), WorkoutCompletion.completed_at.desc())
        .offset(skip)
        .limit(limit)
    ).all()
    return [
        {
            "id": r.id,
            "workout_date": r.workout_date.isoformat(),
            "focus_label": r.focus_label,
            "duration_seconds": r.duration_seconds,
            "stimulus": r.stimulus,
            "source_context": r.source_context,
            "template_id": r.template_id,
            "plan_day_id": r.plan_day_id,
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "ended_at": r.ended_at.isoformat() if r.ended_at else None,
            "external_source_id": r.external_source_id,
            "activity_category": r.activity_category,
            "activity_subtype": r.activity_subtype,
            "activity_intensity": r.activity_intensity,
            "activity_source": r.activity_source,
            "cardio_style": r.cardio_style,
            "distance_miles": r.distance_miles,
            "calories_burned": r.calories_burned,
            "hr_summary": r.hr_summary,
        }
        for r in rows
    ]


@router.get("/hr-zones")
def get_hr_zones(
    resting_hr: int | None = Query(default=None),
    vo2_max: float | None = Query(default=None),
    current_user: User = Depends(require_pro_feature("Health-powered training zones")),
    db: Session = Depends(get_session),
):
    """Compute personalized HR training zones from age + optional Apple Health data."""
    from app.models import UserProfile
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    age = None
    if profile and profile.birthdate:
        from datetime import date as _date
        today = _date.today()
        age = today.year - profile.birthdate.year - (
            (today.month, today.day) < (profile.birthdate.month, profile.birthdate.day)
        )
    if not age and profile and profile.age:
        age = profile.age
    if not age:
        age = 30

    from app.services.workout.cardio import compute_hr_zones
    return compute_hr_zones(age, resting_hr, vo2_max)


@router.get("/pace-history")
def get_pace_history(
    exercise: str | None = Query(default=None, description="Filter by exercise name (case-insensitive)"),
    days: int = Query(default=90, ge=7, le=365),
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Return pace/distance data points for cardio exercises over time.
    Used by the frontend Charts tab for pace progression tracking."""
    from datetime import timedelta
    cutoff = date.today() - timedelta(days=days)
    query = (
        select(
            WorkoutExercise.name,
            ExerciseSet.actual_distance,
            ExerciseSet.actual_pace,
            ExerciseSet.duration_seconds,
            ExerciseSet.cardio_metrics,
            WorkoutSession.workout_date,
        )
        .join(WorkoutExercise, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .join(WorkoutSession, WorkoutExercise.session_id == WorkoutSession.id)
        .where(
            WorkoutSession.user_id == current_user.id,
            WorkoutSession.workout_date >= cutoff,
            ExerciseSet.actual_distance.isnot(None),
        )
    )
    if exercise:
        query = query.where(WorkoutExercise.name.ilike(f"%{exercise}%"))
    query = query.order_by(WorkoutSession.workout_date.asc())
    rows = db.exec(query).all()
    points = []
    for name, dist, pace, dur, metrics, wdate in rows:
        points.append({
            "exercise": name,
            "date": wdate.isoformat(),
            "distance": dist,
            "pace": pace,
            "duration_seconds": dur,
            "metrics": metrics,
        })

    completion_rows = db.exec(
        select(WorkoutCompletion)
        .where(
            WorkoutCompletion.user_id == current_user.id,
            WorkoutCompletion.workout_date >= cutoff,
            WorkoutCompletion.distance_miles.isnot(None),
        )
        .order_by(WorkoutCompletion.workout_date.asc())
    ).all()

    def _pace_from_duration(distance_miles: float | None, duration_seconds: int | None) -> str | None:
        if not distance_miles or distance_miles <= 0 or not duration_seconds or duration_seconds <= 0:
            return None
        pace_min = (duration_seconds / 60.0) / distance_miles
        mins = int(pace_min)
        secs = int(round((pace_min - mins) * 60))
        if secs == 60:
            mins += 1
            secs = 0
        return f"{mins}:{secs:02d}/mi"

    for row in completion_rows:
        if exercise and exercise.lower() not in (row.activity_subtype or row.focus_label or "").lower():
            continue
        distance_miles = float(row.distance_miles or 0.0)
        if distance_miles <= 0:
            continue
        points.append({
            "exercise": row.activity_subtype or row.focus_label,
            "date": row.workout_date.isoformat(),
            "distance": distance_miles,
            "pace": _pace_from_duration(distance_miles, row.duration_seconds),
            "duration_seconds": row.duration_seconds,
            "metrics": {
                "source": row.activity_source,
                "category": row.activity_category,
                "cardio_style": row.cardio_style,
            },
        })
    points.sort(key=lambda p: p["date"])
    return {"points": points}


@router.get("/fatigue", response_model=FatigueScoreResponse)
def get_fatigue_score(
    current_user: User = Depends(require_pro_feature("Recovery tracking")),
    db: Session = Depends(get_session),
):
    """Returns the user's current fatigue/recovery score based on recent activity."""
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.services.workout.activity_impact import compute_rolling_fatigue

    completions = get_recent_completions_for_fatigue(current_user.id, db)
    logger.debug(f"[fatigue] user={current_user.id} completions={len(completions)} dates={[c.get('workout_date') for c in completions]}")
    snapshot = compute_rolling_fatigue(completions)
    logger.debug(f"[fatigue] readiness={snapshot.readiness_score}% muscles={snapshot.muscle_fatigue.to_dict()}")

    # Nutrition recovery bonus — scales to % of user's protein target instead
    # of absolute grams so users at every bodyweight are evaluated fairly.
    nutrition_context = {"protein_avg": 0, "protein_status": "unknown", "message": None, "recovery_bonus_applied": False}
    try:
        from app.services.nutrition.meal_history import get_rolling_averages
        from app.services.nutrition.score_builder import _get_profile_and_goal, _compute_targets
        avg = get_rolling_averages(current_user.id, window=3, db=db)
        profile, goal = _get_profile_and_goal(db, current_user.id)
        _cal_target, pro_target, _goal_id, _sex = _compute_targets(profile, goal)
        pro_target = max(1, pro_target)

        if avg and avg.get("days_with_data", 0) > 0:
            protein = avg.get("avg_protein_g", 0)
            calories = avg.get("avg_calories", 0)
            nutrition_context["protein_avg"] = round(protein)
            nutrition_context["calories_avg"] = round(calories)

            ratio = protein / pro_target if pro_target else 0
            if ratio >= 0.95:
                nutrition_context["protein_status"] = "excellent"
                nutrition_context["message"] = f"Protein on target ({round(protein)}g avg) — supporting recovery"
            elif ratio >= 0.80:
                nutrition_context["protein_status"] = "good"
                nutrition_context["message"] = f"Protein adequate ({round(protein)}g avg) — near target of {pro_target}g"
            elif ratio >= 0.60:
                nutrition_context["protein_status"] = "low"
                nutrition_context["message"] = f"Protein low ({round(protein)}g avg of {pro_target}g target) — recovery is slower"
            elif protein > 0:
                nutrition_context["protein_status"] = "very_low"
                nutrition_context["message"] = f"Protein very low ({round(protein)}g avg of {pro_target}g target)"
            else:
                nutrition_context["protein_status"] = "no_data"
                nutrition_context["message"] = "Log meals to unlock nutrition-powered recovery insights"

            if ratio >= 0.95:
                bonus_factor = min(1.0, (ratio - 0.80) / 0.40)
                recovery_bonus = 0.05 * bonus_factor
                for muscle in ("chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "core"):
                    current = snapshot.muscle_fatigue.get(muscle)
                    if current > 0:
                        snapshot.muscle_fatigue.add(muscle, -current * recovery_bonus)
                from app.services.workout.activity_impact import recompute_readiness
                snapshot.readiness_score, snapshot.focus_readiness = recompute_readiness(snapshot.muscle_fatigue)
                nutrition_context["recovery_bonus_applied"] = True
                logger.debug(f"[fatigue] nutrition bonus: protein_ratio={ratio:.2f} bonus={recovery_bonus:.3f} readiness={snapshot.readiness_score}%")
            elif ratio >= 0.60 and ratio < 0.80:
                penalty = 0.03
                for muscle in ("chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings", "glutes", "calves", "core"):
                    current = snapshot.muscle_fatigue.get(muscle)
                    if current > 0:
                        snapshot.muscle_fatigue.add(muscle, current * penalty)
                from app.services.workout.activity_impact import recompute_readiness as _recompute
                snapshot.readiness_score, snapshot.focus_readiness = _recompute(snapshot.muscle_fatigue)
                logger.debug(f"[fatigue] low protein penalty: protein_ratio={ratio:.2f} readiness={snapshot.readiness_score}%")
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
                duration_seconds=set_body.duration_seconds,
                comfort_rating=set_body.comfort_rating,
                actual_distance=set_body.actual_distance,
                actual_pace=set_body.actual_pace,
                heart_rate_avg=set_body.heart_rate_avg,
                cardio_metrics=set_body.cardio_metrics,
            ))

    db.commit()
    db.refresh(session_row)
    return _build_session_response(session_row, db)


# ─── List ─────────────────────────────────────────────────────────────────────

@router.get("")
def list_workouts(
    workout_date: date | None = Query(default=None),
    since: date | None = Query(default=None, description="Inclusive lower-bound workout_date"),
    before: date | None = Query(default=None, description="Inclusive upper-bound workout_date"),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Paginated workout-session list. Default returns the 50 most recent.
    `skip` + `limit` for cursor-less pagination; `since` / `before` to
    narrow by date. `workout_date` still supported for single-day lookups."""
    query = select(WorkoutSession).where(WorkoutSession.user_id == current_user.id)
    if workout_date:
        query = query.where(WorkoutSession.workout_date == workout_date)
    if since:
        query = query.where(WorkoutSession.workout_date >= since)
    if before:
        query = query.where(WorkoutSession.workout_date <= before)
    sessions = db.exec(
        query.order_by(WorkoutSession.workout_date.desc()).offset(skip).limit(limit)
    ).all()
    # Batched assembly — collapses ~3N+1 queries into 3 total. See
    # `_build_session_responses_batch` for the in-memory grouping.
    return _build_session_responses_batch(sessions, db)


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

    # Cascade delete sets → exercises → session. Was per-row: N exercise
    # queries × M set queries × deletes. Now batched into two bulk DELETEs
    # via SQLAlchemy core, then the session row.
    from sqlmodel import col, delete as _sm_delete
    exercise_ids = [
        ex.id for ex in db.exec(
            select(WorkoutExercise.id).where(WorkoutExercise.session_id == session_id)
        ).all()
    ]
    if exercise_ids:
        db.exec(_sm_delete(ExerciseSet).where(col(ExerciseSet.workout_exercise_id).in_(exercise_ids)))
        db.exec(_sm_delete(WorkoutExercise).where(col(WorkoutExercise.id).in_(exercise_ids)))
    db.delete(session_row)
    db.commit()
