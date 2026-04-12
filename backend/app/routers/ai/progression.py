from __future__ import annotations

import json

import openai
from openai import OpenAI
from fastapi import HTTPException, Depends

from app.auth import get_current_user
from app.models import User

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


@router.post("/recommend-weight")
def recommend_weight(
    body: WeightRecommendRequest,
    current_user: User = Depends(get_current_user),
):
    """Deterministic next-set recommendation based on recent performance and feedback."""
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
        # Sensible default if no prior sets exist
        if last_weight is None:
            last_weight = {
                ExerciseCategory.COMPOUND: 65.0,
                ExerciseCategory.ISOLATION: 20.0,
                ExerciseCategory.MACHINE: 80.0,
                ExerciseCategory.BODYWEIGHT: 0.0,
            }.get(ex_category, 45.0)
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


