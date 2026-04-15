from __future__ import annotations

import json

import openai
from openai import OpenAI
from fastapi import HTTPException, Depends
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import Exercise, User

from .router import router
from .models import WeightRecommendRequest, WorkoutSummaryRequest, WarmupRequest
from .utils import (
    get_openai_api_key, model_chat,
    _build_chat_kwargs, _chat_create, _extract_json, _log_openai_error,
    progression_engine,
    map_goal_type, map_feedback, infer_exercise_category, parse_target_reps,
    map_progression_priority, map_workout_focus, map_phase,
    map_progression_pace, map_experience_level, map_recovery_level,
    SCHEMA_WORKOUT_SUMMARY,
)
from app.workout_progression import (
    ExerciseCategory, ExercisePrescription, PlannedSet, ReadinessInput,
    SetResult, SetType, UserTrainingProfile, WorkoutContext,
)
from app.services.workout.performance import build_performance_profile
from app.services.workout.recommendation import recommend_starting_weight
from app.seed_exercises_data import SEED_EXERCISES  # noqa: F401  (used inside handler)


def _resolve_exercise_slug(db: Session, exercise_name: str, exercise_slug: str | None) -> str | None:
    """Best-effort canonical slug resolution for the recommend-weight
    path. Prefers the client-provided slug, falls back to a
    case-insensitive `Exercise.name` lookup. Returns None when we can't
    find a seed match — downstream code falls back to legacy anchors."""
    if exercise_slug:
        return exercise_slug
    if not exercise_name:
        return None
    row = db.exec(select(Exercise).where(Exercise.name.ilike(exercise_name))).first()
    return row.slug if row else None


@router.post("/recommend-weight")
def recommend_weight(
    body: WeightRecommendRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Deterministic next-set recommendation based on recent performance and feedback.

    Anchor priority for the first-set weight (set 1 of the session, when
    no sets have been logged yet):

        1. Current-session completed sets (handled by the progression
           engine below — if `body.lastSets` is non-empty, that's the
           authoritative anchor).
        2. `plannedTargetWeightLbs` propagated by the deterministic
           planner from this user's history + goal-specific progression.
        3. Exact exercise performance profile (live query against the
           user's recent completed sessions in this DB).
        4. Transferred estimate from a similar exercise
           (substitution_group → movement_pattern → muscle_bucket).
        5. `lastSessionBestWeightLbs` (client-provided fallback).
        6. `allTimeBestWeightLbs` (client-provided fallback).
        7. Category default.

    Each step past (1) also populates a `recommendation` field on the
    response so the client can show the user *why* a weight was picked."""
    try:
        planned_set_count = body.targetSets if body.targetSets and body.targetSets > 0 else max(1, body.nextSetNumber)
        planned_sets = [
            PlannedSet(set_number=idx + 1, set_type=SetType.STRAIGHT)
            for idx in range(planned_set_count)
        ]

        sets_completed = [
            SetResult(
                set_number=s.setNumber,
                weight_lbs=s.weightLbs,
                reps=s.reps,
                rir=s.rir,
                feedback=map_feedback(s.feedback),
            )
            for s in body.lastSets
        ]
        last_weight = sets_completed[-1].weight_lbs if sets_completed else None

        goal_type  = map_goal_type(body.goal)
        profile    = UserTrainingProfile(
            primary_goal=goal_type,
            experience_level=map_experience_level(body.experienceLevel),
            recovery_level=map_recovery_level(body.recoveryLevel),
            progression_pace=map_progression_pace(body.progressionPace),
        )
        workout    = WorkoutContext(
            workout_name="Current Workout",
            focus=map_workout_focus(body.workoutFocus),
            phase=map_phase(body.phase),
            week_number=max(1, body.weekNumber or 1),
        )
        ex_category = infer_exercise_category(body.exerciseName)
        # Layered anchor pipeline for the first set of the session.
        # `recommendation_meta` carries the source + confidence + reason
        # back to the client so the UI can explain the pick.
        recommendation_meta: dict | None = None
        if last_weight is None:
            # Tier 2 — planner-propagated target (already history-aware
            # from the offline propagation step).
            if body.plannedTargetWeightLbs and body.plannedTargetWeightLbs > 0:
                last_weight = float(body.plannedTargetWeightLbs)
                recommendation_meta = {
                    "source": "planned_target",
                    "confidence": 0.90,
                    "reason": "Using the target your plan set for this session",
                }
            else:
                # Tiers 3 + 4 — live query against the user's DB profile
                # for this exact exercise; if no direct history, run the
                # layered transfer pipeline to borrow an estimate from a
                # similar exercise.
                slug = _resolve_exercise_slug(db, body.exerciseName, body.exerciseSlug)
                target_ex: dict | None = None
                profiles: dict = {}
                if slug is not None:
                    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
                    target_ex = by_slug.get(slug)
                    try:
                        profiles = build_performance_profile(current_user.id, db)
                    except Exception as e:
                        print(f"[recommend-weight] profile build failed (non-fatal): {e}")
                        profiles = {}

                    if target_ex is not None:
                        rec_anchor = recommend_starting_weight(
                            target_ex,
                            profiles=profiles,
                            all_exercises_by_slug=by_slug,
                            target_reps=body.targetReps,
                            experience=(body.experienceLevel or "intermediate"),
                        )
                        # Only accept the recommendation if it comes from
                        # real user data. `default` means we couldn't
                        # find anything — fall through to the
                        # client-provided anchors below.
                        if rec_anchor.source != "default" and rec_anchor.weight_lbs > 0:
                            last_weight = rec_anchor.weight_lbs
                            recommendation_meta = {
                                "source": rec_anchor.source,
                                "confidence": rec_anchor.confidence,
                                "reason": rec_anchor.reason,
                            }

            # Tier 5 — client-provided last-session best (oldest code path).
            if last_weight is None and body.lastSessionBestWeightLbs and body.lastSessionBestWeightLbs > 0:
                last_weight = float(body.lastSessionBestWeightLbs)
                recommendation_meta = {
                    "source": "last_session_best",
                    "confidence": 0.60,
                    "reason": "Based on your most recent session's top set",
                }
            # Tier 6 — all-time best.
            if last_weight is None and body.allTimeBestWeightLbs and body.allTimeBestWeightLbs > 0:
                last_weight = float(body.allTimeBestWeightLbs)
                recommendation_meta = {
                    "source": "all_time_best",
                    "confidence": 0.45,
                    "reason": "Based on your all-time best set for this exercise",
                }
            # Tier 7 — category default.
            if last_weight is None:
                last_weight = {
                    ExerciseCategory.COMPOUND: 65.0,
                    ExerciseCategory.ISOLATION: 20.0,
                    ExerciseCategory.MACHINE: 80.0,
                    ExerciseCategory.BODYWEIGHT: 0.0,
                }.get(ex_category, 45.0)
                recommendation_meta = {
                    "source": "default",
                    "confidence": 0.15,
                    "reason": "Starting weight for this movement — adjust after your first set",
                }
        prescription = ExercisePrescription(
            exercise_name=body.exerciseName,
            category=ex_category,
            planned_sets=planned_sets,
            increment_lbs=max(1.0, body.incrementLbs or 5.0),
            progression_priority=map_progression_priority(goal_type),
            default_start_weight_lbs=last_weight,
        )
        readiness  = ReadinessInput(
            sleep_hours=body.sleepHours,
            energy_1_to_5=body.energy1to5,
            soreness_1_to_5=body.soreness1to5,
            stress_1_to_5=body.stress1to5,
            calories_on_target_recently=body.caloriesOnTargetRecently,
        )
        rec = progression_engine.recommend_next_set(
            profile=profile,
            workout=workout,
            prescription=prescription,
            sets_completed_this_workout=sets_completed,
            readiness=readiness,
            target_rep_override=parse_target_reps(body.targetReps),
        )

        if rec.action.value == "end_exercise":
            return {
                "weightLbs": float(last_weight or 0),
                "reps": 0,
                "tip": f"{body.exerciseName} complete for today.",
                "action": rec.action.value,
                "debug": rec.debug,
                "recommendation": recommendation_meta,
            }

        rec_weight = float(rec.recommended_weight_lbs or last_weight or 0)
        rep_min    = int(rec.target_rep_min or 8)
        rep_max    = int(rec.target_rep_max or rep_min)
        rec_reps   = max(1, round((rep_min + rep_max) / 2))

        # ── Feel gating + AI review for intra-workout recs ──────────
        # Product rule: "the recommendation shouldn't say anything
        # until good/easy/etc is filled out as well". When the user
        # has logged a set this session but hasn't tapped a feel chip
        # yet, return a sentinel so the frontend hides the rec card.
        # The deterministic values are still included for logging /
        # debugging — the client keys off `awaitingFeel` to render.
        last_logged_feel: str | None = None
        last_logged = body.lastSets[-1] if body.lastSets else None
        if last_logged is not None:
            last_logged_feel = (getattr(last_logged, "feedback", None) or None)

        awaiting_feel = bool(body.lastSets and not last_logged_feel)

        # When feel IS filled, run the deterministic engine's result
        # through the AI-reviewed next-set wrapper. Suspicion rules
        # (feel-vs-reps conflict, big overshoot/undershoot, pain,
        # first session) trigger a compact AI call that can override
        # the recommendation; otherwise we ship the deterministic
        # result unchanged.
        reviewed_source = "deterministic"
        reviewed_reasons: list[str] = []
        if last_logged is not None and last_logged_feel and not awaiting_feel:
            try:
                from app.services.workout.in_workout_review import (
                    reviewed_next_set_recommendation,
                )
                from app.services.workout.set_programming import (
                    PlannedSet as SPPlannedSet,
                )
                # Build a minimal planned-set proxy for the reviewer.
                # `progression_mode` defaults to reps_first which is
                # the safest bias for volume work.
                spp = SPPlannedSet(
                    set_number=int(last_logged.setNumber or 1),
                    set_type="volume",
                    target_reps=body.targetReps or f"{rep_min}-{rep_max}",
                    target_rir=float(last_logged.rir if last_logged.rir is not None else 2.0),
                    target_weight_lbs=float(last_weight or 0.0) or None,
                    progression_mode="reps_first",
                )
                exercise_stub = {
                    "name": body.exerciseName,
                    "slug": body.exerciseSlug,
                    "equipment_bucket": "barbell" if ex_category == ExerciseCategory.COMPOUND else "dumbbell",
                    "is_compound": ex_category == ExerciseCategory.COMPOUND,
                    "movement_pattern": None,
                    "primary_muscle": None,
                }
                prev_sets_this = [
                    {"reps": s.reps, "weight_lbs": s.weightLbs, "rir": s.rir, "feel": s.feedback}
                    for s in body.lastSets[:-1]
                ]
                reviewed = reviewed_next_set_recommendation(
                    exercise=exercise_stub,
                    planned_set=spp,
                    actual_reps=int(last_logged.reps or 0),
                    actual_weight_lbs=float(last_logged.weightLbs or 0.0),
                    actual_rir=float(last_logged.rir) if last_logged.rir is not None else None,
                    feel=last_logged_feel,
                    previous_sets_this_session=prev_sets_this,
                    last_session_sets=[],  # live DB query skipped here — cheap path
                    require_feel=True,
                )
                if reviewed is not None:
                    reviewed_source = reviewed.source
                    reviewed_reasons = reviewed.suspicion_reasons
                    # AI can override weight / rep target / tip.
                    if reviewed.next_set_weight_lbs is not None and reviewed.source != "deterministic":
                        rec_weight = float(reviewed.next_set_weight_lbs)
                    if reviewed.next_set_rep_target and reviewed.source != "deterministic":
                        # Best-effort parse of "6-8" → rep_min / rep_max.
                        r = reviewed.next_set_rep_target
                        if "-" in r:
                            try:
                                lo, hi = r.split("-", 1)
                                rep_min = int(lo.strip())
                                rep_max = int(hi.strip())
                                rec_reps = max(1, round((rep_min + rep_max) / 2))
                            except (ValueError, TypeError):
                                pass
                    if reviewed.explanation and reviewed.source != "deterministic":
                        tip = reviewed.explanation
                    else:
                        tip = rec.coach_message
                else:
                    tip = rec.coach_message
            except Exception as e:
                print(f"[recommend-weight] in-workout review failed (non-fatal): {e}")
                tip = rec.coach_message
        else:
            tip = rec.coach_message

        return {
            "weightLbs": rec_weight,
            "reps": rec_reps,
            "tip": tip,
            "action": rec.action.value,
            "repRange": f"{rep_min}-{rep_max}",
            "debug": rec.debug,
            # Null when the anchor came from current-session sets — the
            # progression engine owns that message. Populated for first-set
            # anchors so the UI can show "Based on your last 3 sessions"
            # or "Estimated from similar horizontal pressing work".
            "recommendation": recommendation_meta,
            # New fields for the AI-reviewer pipeline:
            # `awaitingFeel`: frontend hides the rec card while True.
            # `source`: "deterministic" | "ai_override" | "ai_confirmed"
            #           — lets the UI tag an "AI" label on overrides.
            # `suspicionReasons`: debug list of why the reviewer fired.
            "awaitingFeel": awaiting_feel,
            "source": "awaiting_feel" if awaiting_feel else reviewed_source,
            "suspicionReasons": reviewed_reasons,
        }
    except Exception as e:
        print(f"[BACKEND] recommend-weight error: {e}")
        raise HTTPException(status_code=502, detail=f"Recommendation failed: {str(e)}")


# Canonical list of "showcase" compound lifts to surface on the
# Progress screen's 1RM card. Kept as a flat tuple (no config/env)
# so the Progress screen always renders the same set of lifts and
# users don't see the list flap between releases. Ordered by how
# commonly strength standards reference them.
_ONE_RM_SHOWCASE_SLUGS: tuple[str, ...] = (
    "barbell_back_squat",
    "barbell_bench_press",
    "barbell_deadlift",
    "overhead_press",
    "barbell_row",
    "pendlay_row",
    "barbell_front_squat",
    "romanian_deadlift",
)


@router.get("/strength/one-rep-max")
def one_rep_max_showcase(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return estimated 1RM for the user's showcase compound lifts.

    Pulls from `build_performance_profile` which already computes
    Epley 1RMs from recent logged sessions. Only lifts with at least
    one logged session in the performance window are returned — the
    Progress screen card renders those. Lifts with no history are
    skipped entirely (the UI shows its own empty-state when nothing
    comes back).

    Shape:
        {
          "lifts": [
            {
              "slug": "barbell_bench_press",
              "name": "Barbell Bench Press",
              "oneRepMaxLbs": 235.0,
              "topWeightLbs": 205.0,
              "topReps": 8,
              "sessionCount": 4,
              "confidence": 0.77,
              "lastPerformedOn": "2026-04-14"
            },
            ...
          ]
        }
    """
    try:
        profiles = build_performance_profile(current_user.id, db)
    except Exception as e:
        print(f"[one-rep-max] profile build failed: {e}")
        return {"lifts": []}

    # Preserve showcase order so the card always renders the same
    # sequence. Anything without a profile gets dropped silently.
    out: list[dict] = []
    for slug in _ONE_RM_SHOWCASE_SLUGS:
        p = profiles.get(slug)
        if p is None or p.estimated_1rm_lbs <= 0:
            continue
        out.append({
            "slug": p.slug,
            "name": p.name,
            "oneRepMaxLbs": round(p.estimated_1rm_lbs, 1),
            "topWeightLbs": round(p.recent_top_weight_lbs, 1),
            "topReps": int(p.recent_top_reps),
            "sessionCount": int(p.session_count),
            "confidence": round(p.confidence, 2),
            "lastPerformedOn": p.last_performed_on.isoformat() if p.last_performed_on else None,
        })
    return {"lifts": out}


@router.get("/fitness/composite-score")
def fitness_composite_score(
    days_per_week: int = 3,
    bodyweight_lbs: float | None = None,
    recent_sleep_hours: float | None = None,
    avg_session_rpe: float | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Compose the 4-pillar fitness score (Strength, Cardio,
    Consistency, Recovery). Each pillar is deterministic and returns
    a 0-100 subscore plus a one-line human reason string.

    Query params:
      - `days_per_week` — user's planned training frequency (powers Consistency pillar target)
      - `bodyweight_lbs` — current bodyweight (powers Strength pillar)
      - `recent_sleep_hours` — last night's sleep (Recovery signal)
      - `avg_session_rpe` — avg RPE across recent sessions (Recovery signal)

    Internal data sources:
      - `build_performance_profile` for Strength pillar (Epley 1RMs)
      - `WorkoutCompletion` last 14 days for Cardio + Consistency

    Returns:
        {
          "total": 70.1,
          "rating": "Strong",
          "pillars": [
            {"name": "Strength", "score": 97.9, "reason": "...", "dataQuality": "full"},
            {"name": "Cardio", "score": 19.0, "reason": "...", "dataQuality": "full"},
            {"name": "Consistency", "score": 80.0, "reason": "...", "dataQuality": "full"},
            {"name": "Recovery", "score": 100.0, "reason": "...", "dataQuality": "full"}
          ]
        }
    """
    from datetime import datetime, timedelta
    from app.services.workout.fitness_score import compute_fitness_score
    from app.models import (
        WorkoutCompletion,
        WorkoutSession,
        WorkoutExercise,
        ExerciseSet,
        Exercise as SeedExercise,
    )

    try:
        profiles = build_performance_profile(current_user.id, db)
    except Exception as e:
        print(f"[fitness-score] profile build failed: {e}")
        profiles = {}

    # Pull the last 14 days of lightweight completion rows for the
    # Cardio + Consistency pillars. Uses the same reliable source
    # the 36-hour continuity rotation already reads from.
    cutoff_14d = datetime.utcnow() - timedelta(days=14)
    cutoff_28d = datetime.utcnow() - timedelta(days=28)
    cutoff_56d = datetime.utcnow() - timedelta(days=56)
    try:
        rows = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.completed_at >= cutoff_14d)
            .order_by(WorkoutCompletion.completed_at.desc())
        ).all()
    except Exception as e:
        print(f"[fitness-score] recent completions query failed: {e}")
        rows = []

    recent_completions = [
        {
            "focus": r.focus_label,
            "duration_seconds": r.duration_seconds,
            "workout_date": r.workout_date.isoformat() if r.workout_date else None,
        }
        for r in rows
    ]
    session_count_14d = len(rows)

    # ── Strength pillar inputs ────────────────────────────────────
    # Walk the structured WorkoutSession + WorkoutExercise + ExerciseSet
    # tables to compute the four sub-component inputs:
    #   - patterns_hit: set of movement patterns trained in the last 28d
    #   - volume_load_lbs: total weight × reps across all sets in 28d
    #   - distinct_exercises: count of unique exercise names in 28d
    #   - progression_ratio: fraction of exercises whose top set
    #     improved from the prior 28-day window to the current one
    # All best-effort; failures degrade strength but don't crash.
    patterns_hit: set[str] = set()
    volume_load_lbs = 0.0
    distinct_exercise_names: set[str] = set()
    progression_ratio = 0.0
    try:
        # Build a slug → movement_pattern map from the seed catalog.
        seed_rows = db.exec(select(SeedExercise)).all()
        slug_to_pattern: dict[str, str] = {}
        name_to_pattern: dict[str, str] = {}
        for sx in seed_rows:
            pat = (getattr(sx, "movement_pattern", None) or "").strip().lower()
            if pat:
                if sx.slug:
                    slug_to_pattern[sx.slug] = pat
                if sx.name:
                    name_to_pattern[sx.name.strip().lower()] = pat

        # Pull all sessions from the last 28 days.
        recent_sessions_28d = db.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == current_user.id)
            .where(WorkoutSession.workout_date >= cutoff_28d.date())
        ).all()
        recent_session_ids = [s.id for s in recent_sessions_28d if s.id is not None]

        if recent_session_ids:
            recent_exs = db.exec(
                select(WorkoutExercise)
                .where(WorkoutExercise.session_id.in_(recent_session_ids))
            ).all()
            ex_id_to_name: dict[int, str] = {}
            for ex in recent_exs:
                if ex.id is None:
                    continue
                ex_id_to_name[ex.id] = (ex.name or "").strip()
                lname = (ex.name or "").strip().lower()
                if lname:
                    distinct_exercise_names.add(lname)
                    pat = name_to_pattern.get(lname)
                    if pat:
                        patterns_hit.add(pat)

            recent_sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.workout_exercise_id.in_(list(ex_id_to_name.keys())))
            ).all()
            # Volume load: sum of (actual_weight × actual_reps) across
            # every set in the window. Ignores zero-weight bodyweight
            # rows since they don't contribute to weight·reps load.
            for s in recent_sets:
                w = s.actual_weight_lbs or 0
                r = s.actual_reps or 0
                if w > 0 and r > 0:
                    volume_load_lbs += w * r

            # Progression ratio: for each exercise name, compute the
            # top-set "score" (weight × reps) in the current 28d window
            # vs the prior 28d window. Fraction of exercises whose
            # current top is >= prior top is the progression ratio.
            current_top: dict[str, float] = {}
            for ex_id, ex_name in ex_id_to_name.items():
                ex_sets = [s for s in recent_sets if s.workout_exercise_id == ex_id]
                if not ex_sets:
                    continue
                top = max(
                    ((s.actual_weight_lbs or 0) * (s.actual_reps or 0))
                    for s in ex_sets
                )
                key = ex_name.lower()
                if top > 0:
                    current_top[key] = max(current_top.get(key, 0.0), top)

            # Prior window: 28-56 days ago
            prior_sessions = db.exec(
                select(WorkoutSession)
                .where(WorkoutSession.user_id == current_user.id)
                .where(WorkoutSession.workout_date >= cutoff_56d.date())
                .where(WorkoutSession.workout_date < cutoff_28d.date())
            ).all()
            prior_session_ids = [s.id for s in prior_sessions if s.id is not None]
            prior_top: dict[str, float] = {}
            if prior_session_ids:
                prior_exs = db.exec(
                    select(WorkoutExercise)
                    .where(WorkoutExercise.session_id.in_(prior_session_ids))
                ).all()
                prior_ex_ids = [e.id for e in prior_exs if e.id is not None]
                prior_ex_id_to_name = {e.id: (e.name or "").strip().lower() for e in prior_exs if e.id}
                if prior_ex_ids:
                    prior_sets = db.exec(
                        select(ExerciseSet)
                        .where(ExerciseSet.workout_exercise_id.in_(prior_ex_ids))
                    ).all()
                    for s in prior_sets:
                        w = s.actual_weight_lbs or 0
                        r = s.actual_reps or 0
                        if w > 0 and r > 0:
                            key = prior_ex_id_to_name.get(s.workout_exercise_id, "")
                            if key:
                                prior_top[key] = max(prior_top.get(key, 0.0), w * r)

            # Compare per exercise. Exercises only in the current window
            # count as "new" — they're a positive signal so we credit them.
            if current_top:
                improved = 0
                for name, cur in current_top.items():
                    prev = prior_top.get(name, 0.0)
                    if prev <= 0 or cur >= prev:
                        improved += 1
                progression_ratio = improved / len(current_top)
    except Exception as e:
        print(f"[fitness-score] strength sub-component query failed (non-fatal): {e}")

    score = compute_fitness_score(
        profiles=profiles,
        bodyweight_lbs=bodyweight_lbs,
        recent_completions=recent_completions,
        session_count_14d=session_count_14d,
        days_per_week=int(days_per_week or 3),
        recent_sleep_hours=recent_sleep_hours,
        avg_session_rpe=avg_session_rpe,
        patterns_hit=patterns_hit,
        volume_load_lbs=volume_load_lbs,
        distinct_exercises=len(distinct_exercise_names),
        progression_ratio=progression_ratio,
    )
    return score.to_dict()


@router.post("/workout-summary")
def generate_workout_summary(
    body: WorkoutSummaryRequest,
    current_user: User = Depends(get_current_user),
):
    """AI post-workout summary: calories burned, achievements, and personalised recommendations."""
    weight_kg      = body.weightLbs / 2.205
    duration_hours = body.durationSeconds / 3600

    focus_lower = body.focus.lower()
    if any(kw in focus_lower for kw in ["cardio", "run", "cycle", "hiit", "conditioning"]):
        met = 8.0
    elif any(kw in focus_lower for kw in ["strength", "power", "heavy"]):
        met = 6.5
    else:
        met = 5.5

    calories_burned = max(1, round(met * weight_kg * duration_hours))

    total_sets     = sum(len(ex.get("sets", [])) for ex in body.exercises)
    exercises_done = sum(1 for ex in body.exercises if len(ex.get("sets", [])) > 0)
    achievements: list[str] = []
    for ex in body.exercises:
        sets = ex.get("sets", [])
        if sets:
            best   = max(sets, key=lambda s: s.get("weightLbs", 0) * s.get("reps", 0))
            weight = best.get("weightLbs", 0)
            reps   = best.get("reps", 0)
            if weight > 0:
                achievements.append(f"{ex['name']}: {weight} lbs × {reps} reps")

    api_key = get_openai_api_key()
    if not api_key:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Solid effort — every set counts toward your goal. Keep showing up!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours for optimal recovery.",
                "Hydrate well — aim for at least 16 oz of water post-workout.",
                "Sleep 7–9 hours tonight to lock in the gains from this session.",
            ],
        }

    client = OpenAI(api_key=api_key)
    try:
        prompt = (
            f"Post-workout summary request:\n"
            f"- Focus: {body.focus}\n"
            f"- Goal: {body.goal}\n"
            f"- Duration: {body.durationSeconds // 60} min\n"
            f"- Exercises completed: {exercises_done}\n"
            f"- Total sets logged: {total_sets}\n"
            f"- Estimated calories burned: {calories_burned}\n"
            f"- Best sets: {'; '.join(achievements[:4]) or 'none logged'}\n\n"
            "Write a short, energetic post-workout message and 3 concrete recovery/nutrition tips.\n"
            'Return JSON: {"motivationMessage": string, "recommendations": [string, string, string]}'
        )
        _ws_messages = [
            {"role": "system", "content": "You are an upbeat fitness coach. Give brief, practical post-workout feedback. Return JSON only."},
            {"role": "user", "content": prompt},
        ]
        kwargs = _build_chat_kwargs(model_chat(), _ws_messages, json_schema=SCHEMA_WORKOUT_SUMMARY, max_tokens=300, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        ai = _extract_json(response.choices[0].message.content)
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": ai.get("motivationMessage", "Great work today!"),
            "achievements": achievements[:4],
            "recommendations": ai.get("recommendations", []),
        }
    except Exception:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Strong session — consistency is the key to progress!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours.",
                "Hydrate well post-workout.",
                "Aim for 7–9 hours of sleep tonight.",
            ],
        }


# ── AI warm-up generator ────────────────────────────────────────────
# Returns 4-6 warm-up steps tailored to today's workout (focus +
# first couple of exercises) and the user's injuries. Frontend caches
# the result by workout day so repeated visits to the same day don't
# re-hit the API. Falls back to a deterministic 4-step template if the
# AI call fails or no API key is set — the active workout screen never
# blocks on this.
_WARMUP_SCHEMA = {
    "name": "warmup_steps",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["steps"],
        "properties": {
            "steps": {
                "type": "array",
                "minItems": 3,
                "maxItems": 6,
                "items": {"type": "string"},
            },
        },
    },
}


def _deterministic_warmup(focus: str, first: str | None, second: str | None) -> list[str]:
    focus_l = (focus or "").lower()
    if any(k in focus_l for k in ("leg", "lower", "squat")):
        primer = "3-5 minutes easy bike or treadmill, then ankle, hip, and squat-pattern mobility."
    elif any(k in focus_l for k in ("pull", "back", "row")):
        primer = "3-5 minutes light cardio, then band pull-aparts, scap retractions, and shoulder prep."
    elif any(k in focus_l for k in ("push", "chest", "shoulder", "upper")):
        primer = "3-5 minutes light cardio, then shoulder circles, band external rotations, and light pressing prep."
    else:
        primer = "3-5 minutes of light cardio followed by dynamic mobility for the joints you'll use most."
    ramp = (
        f"Do 2-3 lighter ramp-up sets for {first}" + (f", then one feeler set for {second}." if second else ".")
    ) if first else "Do 2-3 lighter ramp-up sets before your first working set."
    return [
        primer,
        "Keep warm-up reps smooth and stop well before fatigue.",
        ramp,
        "If a joint feels off, slow down and add one more lighter set before starting work sets.",
    ]


@router.post("/warmup")
def generate_warmup(
    body: WarmupRequest,
    current_user: User = Depends(get_current_user),
):
    """AI-generated warm-up tailored to today's workout + user injuries.
    Cheap call: ~300 input / ~200 output tokens on gpt-4o-mini.
    Falls back to a deterministic template on any failure."""
    first_ex = body.exercises[0].get("name") if body.exercises else None
    second_ex = body.exercises[1].get("name") if len(body.exercises) > 1 else None

    api_key = get_openai_api_key()
    if not api_key:
        return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex), "source": "fallback"}

    try:
        client = OpenAI(api_key=api_key)
        ex_lines = "\n".join(
            f"  - {e.get('name', '?')} ({e.get('equipment') or 'bodyweight'})"
            for e in body.exercises[:6]
        ) or "  (no exercises)"
        injuries_line = ", ".join(body.injuries) if body.injuries else "none"
        prompt = (
            "Write a tailored warm-up for the user's workout today. The warm-up "
            "should take ~5 minutes and prepare the specific joints/muscles used "
            "by the exercises below.\n\n"
            f"Focus: {body.focus}\n"
            f"Experience: {body.experience or 'intermediate'}\n"
            f"Session length: {body.durationMinutes or 60} min\n"
            f"Injuries / limitations to respect (avoid ranges that aggravate these): {injuries_line}\n"
            f"Today's exercises:\n{ex_lines}\n\n"
            "Return 4-6 warm-up steps as an ordered list in the `steps` array. "
            "Each step is ONE sentence of plain prose, no markdown, no bullets, "
            "no numbering inside the string (the UI adds its own numbers). Cover: "
            "(1) general primer (light cardio + mobility for the muscles hit), "
            "(2) joint-specific prep referencing the actual exercises above, "
            "(3) one or two ramp-up set cues naming the first exercise by name, "
            "(4) an injury-aware reminder if injuries are listed (else a form cue). "
            "If injuries include 'knee', avoid deep flexion in the primer. If "
            "'shoulder', avoid overhead cable movements. If 'lower back', avoid "
            "loaded spinal flexion.\n\n"
            'Return JSON: {"steps": ["...", "...", ...]}'
        )
        messages = [
            {"role": "system", "content": "You are a strength coach writing a tailored warm-up. Be concise, specific, and injury-aware. Return only the required JSON."},
            {"role": "user", "content": prompt},
        ]
        kwargs = _build_chat_kwargs(
            model_chat(),
            messages,
            json_schema=_WARMUP_SCHEMA,
            max_tokens=500,
            timeout_secs=20,
        )
        response = _chat_create(client, **kwargs)
        data = _extract_json(response.choices[0].message.content or "")
        steps = data.get("steps") if isinstance(data, dict) else None
        if not isinstance(steps, list) or not steps:
            return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex), "source": "fallback"}
        cleaned = [str(s).strip() for s in steps if str(s).strip()]
        return {"steps": cleaned[:6], "source": "ai"}
    except Exception as exc:
        print(f"[ai/warmup] failed (non-fatal): {exc}")
        return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex), "source": "fallback"}


