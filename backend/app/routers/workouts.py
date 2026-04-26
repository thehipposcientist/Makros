from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select
from sqlalchemy import func
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
    comfort_rating: int | None = None    # 1-5 comfort for stretch/mobility
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
    calories_burned: int | None = None
    hr_summary: dict | None = None  # {avgBpm, maxBpm, zoneMinutes}
    # Post-workout feedback. Used by weekly_review's struggle metrics
    # (e.g. 3 of 4 sessions felt rough → trainer suggests pulling back).
    # All optional — silent log paths still work.
    feeling: str | None = None              # "great"|"good"|"okay"|"rough"
    intensity: int | None = None            # 1..5
    soreness_areas: list[str] | None = None  # ["lower_back", "knees"]
    feedback_notes: str | None = None

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
    try:
        from app.models import UserProfile as UserProfileModel
        prof_row = db.exec(
            select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
        ).first()
        user_age = prof_row.age if prof_row else None
    except Exception:
        user_age = None

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
    current_user: User = Depends(get_current_user),
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
    from app.routers.ai.plans import _resolve_owned_equipment_slugs

    owned_slugs = _resolve_owned_equipment_slugs(body.equipment)

    recent_focus_buckets: tuple[str, ...] = ()
    recent_focus_families: tuple[str, ...] = ()
    try:
        buckets, families = most_recent_completed_focus(current_user.id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        logger.exception("[generate-week] most_recent_completed_focus failed")

    # Pin injection: prepend the user's chosen focus so the rotator treats
    # it as if they just did that focus. The pinned day keeps its chosen
    # focus below; all other days rotate to avoid it.
    if body.pin_focus:
        try:
            from app.services.workout.focus_normalize import (
                normalize_focus_to_bucket, normalize_focus_to_family,
            )
            pb = normalize_focus_to_bucket(body.pin_focus)
            pf = normalize_focus_to_family(body.pin_focus)
            if pb:
                recent_focus_buckets = (pb,) + recent_focus_buckets
            if pf:
                recent_focus_families = (pf,) + recent_focus_families
        except Exception:
            logger.exception("[generate-week] pin focus normalize failed")

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
    try:
        from app.models import UserProfile as UserProfileModel
        prof_row = db.exec(
            select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
        ).first()
        user_age = prof_row.age if prof_row else None
    except Exception:
        user_age = None

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
        decision = decide_pin(
            days,
            pin_day_index=body.pin_day_index,
            pin_focus=body.pin_focus,
            preferred_split=body.preferred_split,
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
        existing.calories_burned    = body.calories_burned if body.calories_burned is not None else existing.calories_burned
        existing.hr_summary         = body.hr_summary if body.hr_summary is not None else existing.hr_summary
        existing.feeling            = body.feeling if body.feeling is not None else existing.feeling
        existing.intensity          = body.intensity if body.intensity is not None else existing.intensity
        existing.soreness_areas     = body.soreness_areas if body.soreness_areas is not None else existing.soreness_areas
        existing.feedback_notes     = body.feedback_notes if body.feedback_notes is not None else existing.feedback_notes
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
            calories_burned=body.calories_burned,
            hr_summary=body.hr_summary,
            feeling=body.feeling,
            intensity=body.intensity,
            soreness_areas=body.soreness_areas,
            feedback_notes=body.feedback_notes,
        ))

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
                        rir_target=set_payload.rir,
                        duration_seconds=set_payload.duration_seconds,
                        comfort_rating=set_payload.comfort_rating,
                        completed=True,
                        completed_at=datetime.now(timezone.utc),
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
        completion_row = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.workout_date == body.workout_date)
            .where(WorkoutCompletion.focus_label == body.focus_label)
        ).first()
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

            if body.exercises:
                from app.seed_exercises_data import SEED_EXERCISES
                seed_map = {e["name"].lower(): e for e in SEED_EXERCISES}
                ex_list = []
                for ep in body.exercises:
                    seed = seed_map.get(ep.name.lower(), {})
                    # Pass structured per-set data (reps, weight, RIR) so
                    # resolve_exercise_fatigue can compute volume-load and
                    # stimulus-specific fatigue (heavy vs hypertrophy vs volume
                    # produce different systemic/muscular ratios).
                    set_dicts = [
                        {"reps": s.reps, "weight_lbs": s.weight_lbs, "rir": s.rir}
                        for s in ep.sets
                    ]
                    ex_list.append({
                        "name": ep.name,
                        "primary_muscle": seed.get("primary_muscle", ""),
                        "secondary_muscles": seed.get("secondary_muscles", []),
                        "is_compound": seed.get("is_compound", False),
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
            if body.exercises and resolved:
                top_muscles = sorted(resolved.items(), key=lambda x: -x[1])
                top = [m for m, v in top_muscles if m != 'systemic' and v > 0.1]
                if top:
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
            db.add(completion_row)
    except Exception as e:
        logger.info(f"[workouts/complete] muscle fatigue resolution failed (non-fatal): {e}")

    try:
        from app.routers.social import write_activity
        write_activity(db, current_user.id, "workout_completed", {
            "focus": body.focus_label,
            "duration_seconds": body.duration_seconds,
            "date": str(body.workout_date),
            "exercise_count": len(body.exercises) if body.exercises else 0,
        })
    except Exception:
        pass

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

    return {
        "ok": True,
        "structured_persisted": bool(session_rows_created),
        "prs": prs,
    }


@router.delete("/completion", status_code=204)
def delete_workout_completion(
    workout_date: date = Query(..., description="YYYY-MM-DD"),
    focus_label: str | None = Query(None, description="Optional focus to delete a specific session instead of all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Delete `WorkoutCompletion` rows for the given date. When
    `focus_label` is provided, only the matching row is removed;
    otherwise ALL rows for the date are wiped (legacy behaviour).

    Also wipes any matching `WorkoutSession` rows so per-set detail
    + downstream PR / volume rollups don't keep referencing the
    deleted day. Per-set + per-exercise children are removed via
    cascade through the FK, but we don't define cascade on these
    tables — clean them up explicitly.
    """
    q = (
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date == workout_date)
    )
    if focus_label:
        q = q.where(WorkoutCompletion.focus_label == focus_label)
    rows = db.exec(q).all()
    for r in rows:
        db.delete(r)

    sq = (
        select(WorkoutSession)
        .where(WorkoutSession.user_id == current_user.id)
        .where(WorkoutSession.workout_date == workout_date)
    )
    if focus_label:
        sq = sq.where(WorkoutSession.focus == focus_label)
    sessions = db.exec(sq).all()
    for s in sessions:
        # Cascade: drop child exercise rows + set rows.
        exercises = db.exec(
            select(WorkoutExercise).where(WorkoutExercise.session_id == s.id)
        ).all()
        for e in exercises:
            sets_ = db.exec(
                select(ExerciseSet).where(ExerciseSet.workout_exercise_id == e.id)
            ).all()
            for st in sets_:
                db.delete(st)
            db.delete(e)
        db.delete(s)

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
            old_exs = db.exec(
                select(WorkoutExercise).where(WorkoutExercise.session_id == existing_session.id)
            ).all()
            for ox in old_exs:
                old_sets = db.exec(
                    select(ExerciseSet).where(ExerciseSet.workout_exercise_id == ox.id)
                ).all()
                for os in old_sets:
                    db.delete(os)
                db.delete(ox)
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
                    rir_target=set_payload.rir,
                    duration_seconds=set_payload.duration_seconds,
                    comfort_rating=set_payload.comfort_rating,
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
    weight_slope_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_steps: float | None = None,
    readiness_score: int | None = None,
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
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
    wipe). Completions carry date/focus/duration but NOT per-set detail —
    that only lives in `WorkoutSession` rows when the client sent exercises."""
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
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            "activity_category": r.activity_category,
            "activity_subtype": r.activity_subtype,
            "activity_intensity": r.activity_intensity,
        }
        for r in rows
    ]


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
