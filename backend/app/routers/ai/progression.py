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
from .models import WeightRecommendRequest, WorkoutSummaryRequest
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

        return {
            "weightLbs": rec_weight,
            "reps": rec_reps,
            "tip": rec.coach_message,
            "action": rec.action.value,
            "repRange": f"{rep_min}-{rep_max}",
            "debug": rec.debug,
            # Null when the anchor came from current-session sets — the
            # progression engine owns that message. Populated for first-set
            # anchors so the UI can show "Based on your last 3 sessions"
            # or "Estimated from similar horizontal pressing work".
            "recommendation": recommendation_meta,
        }
    except Exception as e:
        print(f"[BACKEND] recommend-weight error: {e}")
        raise HTTPException(status_code=502, detail=f"Recommendation failed: {str(e)}")



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


