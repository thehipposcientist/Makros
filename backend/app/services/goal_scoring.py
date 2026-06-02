"""Goal execution, projection confidence, and outcome scoring.

This module is deterministic and read-only. It deliberately separates:

* execution: did the user do the goal-relevant behaviors?
* confidence: how reliable is the estimate?
* projection: what outcome are they currently on pace for?

The weights below are goal-specific by design. A fat-loss goal should not
score like a strength goal, and a completed workout should not count as a
perfect training signal unless the logged exercises, sets, reps, and
intensity support that claim.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import math
import re
from statistics import mean, pstdev
from typing import Any, Mapping


SUPPORTED_WINDOWS = {
    "current_week",
    "rolling_7d",
    "rolling_14d",
    "rolling_28d",
    "goal_to_date",
}


@dataclass(frozen=True)
class GoalScoringConfig:
    goal_type: str
    drivers: tuple[tuple[str, str, str, float], ...]
    nutrition_day_weights: dict[str, float]


# These comments are intentionally near the numbers: changing a weight changes
# product semantics, so future edits should explain why a driver moved.
GOAL_SCORING_CONFIGS: dict[str, GoalScoringConfig] = {
    "fat_loss": GoalScoringConfig(
        goal_type="fat_loss",
        drivers=(
            # Fat loss is mostly a calorie-target execution problem, with
            # protein, lifting quality, and movement protecting lean mass.
            ("calories", "Calories", "nutrition", 0.35),
            ("protein", "Protein", "nutrition", 0.20),
            ("strengthTrainingQuality", "Strength training", "training", 0.15),
            ("stepsOrCardio", "Steps/cardio", "cardio", 0.15),
            ("sleepRecovery", "Sleep/recovery", "recovery", 0.10),
            ("loggingCompleteness", "Logging completeness", "measurement", 0.05),
        ),
        nutrition_day_weights={
            "calorieTargetAdherence": 0.50,
            "proteinTargetAdherence": 0.25,
            "fiberOrFoodQuality": 0.10,
            "mealConsistency": 0.05,
            "hydrationOrAlcoholControl": 0.05,
            "loggingCompleteness": 0.05,
        },
    ),
    "muscle_gain": GoalScoringConfig(
        goal_type="muscle_gain",
        drivers=(
            # Hypertrophy is training-quality led; calories and protein only
            # help when the stimulus is present and progressing.
            ("trainingQuality", "Training quality", "training", 0.35),
            ("progressiveOverload", "Progressive overload", "training", 0.20),
            ("protein", "Protein", "nutrition", 0.20),
            ("calorieSurplusConsistency", "Calorie surplus", "nutrition", 0.15),
            ("sleepRecovery", "Sleep/recovery", "recovery", 0.10),
        ),
        nutrition_day_weights={
            "calorieSurplusAdherence": 0.35,
            "proteinTargetAdherence": 0.30,
            "carbFueling": 0.10,
            "mealConsistency": 0.10,
            "hydration": 0.05,
            "loggingCompleteness": 0.10,
        },
    ),
    "strength": GoalScoringConfig(
        goal_type="strength",
        drivers=(
            # Strength depends heavily on the main lifts and prescribed load.
            # Accessory volume matters, but it cannot rescue missed intensity.
            ("keyLiftCompletion", "Key lift completion", "training", 0.25),
            ("intensityLoadAdherence", "Load/intensity adherence", "training", 0.25),
            ("accessoryVolume", "Accessory volume", "training", 0.15),
            ("progressiveOverload", "Progressive overload", "training", 0.15),
            ("recoveryReadiness", "Recovery/readiness", "recovery", 0.10),
            ("nutritionSupport", "Nutrition support", "nutrition", 0.10),
        ),
        nutrition_day_weights={
            "caloriesMaintenanceOrSurplus": 0.30,
            "proteinTargetAdherence": 0.25,
            "prePostWorkoutFueling": 0.15,
            "hydration": 0.10,
            "mealConsistency": 0.10,
            "loggingCompleteness": 0.10,
        },
    ),
    "endurance": GoalScoringConfig(
        goal_type="endurance",
        drivers=(
            # Endurance cannot be judged by attendance alone: volume, key
            # sessions, and zone discipline carry the estimate.
            ("weeklyVolume", "Weekly volume", "cardio", 0.30),
            ("keySessionCompletion", "Key sessions", "cardio", 0.25),
            ("zoneIntensityAdherence", "Zone/intensity adherence", "cardio", 0.20),
            ("recovery", "Recovery", "recovery", 0.15),
            ("fuelingHydration", "Fueling/hydration", "nutrition", 0.10),
        ),
        nutrition_day_weights={
            "calorieAdequacy": 0.25,
            "carbFueling": 0.25,
            "hydration": 0.20,
            "protein": 0.15,
            "loggingCompleteness": 0.15,
        },
    ),
    "body_recomp": GoalScoringConfig(
        goal_type="body_recomp",
        drivers=(
            # Recomp needs enough training signal and enough nutrition control;
            # neither side should dominate the other.
            ("trainingQuality", "Training quality", "training", 0.25),
            ("calorieConsistency", "Calorie consistency", "nutrition", 0.25),
            ("protein", "Protein", "nutrition", 0.20),
            ("stepsOrCardio", "Steps/cardio", "cardio", 0.10),
            ("sleepRecovery", "Sleep/recovery", "recovery", 0.10),
            ("measurementConsistency", "Measurement consistency", "measurement", 0.10),
        ),
        nutrition_day_weights={
            "calorieTargetAdherence": 0.40,
            "proteinTargetAdherence": 0.25,
            "fiberOrFoodQuality": 0.10,
            "mealConsistency": 0.10,
            "hydrationOrAlcoholControl": 0.05,
            "loggingCompleteness": 0.10,
        },
    ),
    "general_consistency": GoalScoringConfig(
        goal_type="general_consistency",
        drivers=(
            # General consistency still uses workout quality, but the goal is
            # habit breadth rather than maximizing one training adaptation.
            ("plannedWorkoutCompletion", "Planned workouts", "training", 0.35),
            ("nutritionConsistency", "Nutrition consistency", "nutrition", 0.25),
            ("dailyMovement", "Daily movement", "cardio", 0.15),
            ("sleepRecovery", "Sleep/recovery", "recovery", 0.15),
            ("checkInCompleteness", "Check-ins", "measurement", 0.10),
        ),
        nutrition_day_weights={
            "calorieTargetAdherence": 0.30,
            "proteinTargetAdherence": 0.25,
            "fiberOrFoodQuality": 0.15,
            "mealConsistency": 0.15,
            "hydrationOrAlcoholControl": 0.05,
            "loggingCompleteness": 0.10,
        },
    ),
}


@dataclass
class DomainScore:
    overall: float
    scores: dict[str, float] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    target_summary: str = ""
    actual_summary: str = ""
    coverage: float = 0.0


@dataclass
class ProjectionInputs:
    metric: str
    unit: str
    target_change: float
    timeframe_days: int
    actual_progress: float | None
    expected_progress_to_date: float | None
    source: str
    reliability: float
    signal_quality: float
    sample_count: int


def calculate_goal_score(payload: Mapping[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    """Calculate the detailed score for one goal.

    Accepts either a dict shaped like the user-provided pseudocode or keyword
    arguments. All input lists can contain ORM rows, dataclasses, or dicts.
    """
    data: dict[str, Any] = dict(payload or {})
    data.update(kwargs)

    today = _as_date(data.get("asOfDate")) or date.today()
    goal = data.get("goal") or {}
    goal_type = _goal_type(goal)
    config = GOAL_SCORING_CONFIGS[goal_type]
    period_start, period_end = _resolve_date_range(
        data.get("dateRange"),
        window=str(data.get("window") or "rolling_7d"),
        today=today,
        goal=goal,
    )
    days = _date_span(period_start, period_end)

    training = _score_training(
        goal_type=goal_type,
        plan=data.get("plan"),
        workouts=_ensure_list(data.get("workouts")),
        workout_logs=_ensure_list(data.get("workoutLogs")),
        date_range=(period_start, period_end),
    )
    nutrition = _score_nutrition(
        goal_type=goal_type,
        config=config,
        nutrition_logs=_ensure_list(data.get("nutritionLogs")),
        date_range=(period_start, period_end),
        targets=data.get("nutritionTargets") or data.get("targets") or {},
    )
    sleep_recovery = _score_sleep_recovery(
        sleep_logs=_ensure_list(data.get("sleepLogs")),
        recovery_logs=_ensure_list(data.get("recoveryLogs")),
        checkins=_ensure_list(data.get("checkIns")),
        date_range=(period_start, period_end),
    )
    cardio_steps = _score_cardio_steps(
        goal_type=goal_type,
        plan=data.get("plan"),
        step_logs=_ensure_list(data.get("stepLogs")),
        cardio_logs=_ensure_list(data.get("cardioLogs")),
        workout_logs=_ensure_list(data.get("workoutLogs")),
        date_range=(period_start, period_end),
        user=data.get("user") or {},
    )
    measurement = _score_measurement(
        goal_type=goal_type,
        body_metrics=_ensure_list(data.get("bodyMetrics")),
        checkins=_ensure_list(data.get("checkIns")),
        date_range=(period_start, period_end),
    )
    checkins = _score_checkins(_ensure_list(data.get("checkIns")), (period_start, period_end))
    logging = _score_logging_completeness(training, nutrition, measurement)

    domain = {
        "training": training,
        "nutrition": nutrition,
        "sleepRecovery": sleep_recovery,
        "cardioSteps": cardio_steps,
        "measurement": measurement,
        "checkins": checkins,
        "logging": logging,
    }

    breakdown = _build_execution_breakdown(config, domain)
    execution_score = _round_score(
        sum(item["score"] * item["weight"] for item in breakdown)
        / max(0.0001, sum(item["weight"] for item in breakdown))
    )

    projection = _build_projection_inputs(
        goal=goal,
        goal_type=goal_type,
        user=data.get("user") or {},
        body_metrics=_ensure_list(data.get("bodyMetrics")),
        workout_logs=_ensure_list(data.get("workoutLogs")),
        cardio_logs=_ensure_list(data.get("cardioLogs")),
        date_range=(period_start, period_end),
        as_of=today,
    )
    confidence_breakdown, projection_confidence = _score_projection_confidence(
        goal_type=goal_type,
        days=days,
        goal=goal,
        training=training,
        nutrition=nutrition,
        sleep_recovery=sleep_recovery,
        cardio_steps=cardio_steps,
        measurement=measurement,
        projection=projection,
    )
    response_factor = _response_factor(projection, projection_confidence)
    projected_outcome = _project_outcome(
        projection=projection,
        execution_score=execution_score,
        response_factor=response_factor,
        confidence=projection_confidence,
    )

    limiting_factors = _limiting_factors(breakdown, projection_confidence)
    next_actions = _next_best_actions(limiting_factors, breakdown)

    return {
        "goalId": _id_for(goal),
        "goalType": goal_type,
        "periodStart": period_start.isoformat(),
        "periodEnd": period_end.isoformat(),
        "executionScore": execution_score,
        "executionLabel": _score_label(execution_score),
        "executionBreakdown": breakdown,
        "projectionConfidence": projection_confidence,
        "confidenceLabel": _confidence_label(projection_confidence),
        "confidenceBreakdown": confidence_breakdown,
        "responseFactor": round(response_factor, 2),
        "projectedOutcome": projected_outcome,
        "limitingFactors": limiting_factors,
        "nextBestActions": next_actions,
    }


def _goal_type(goal: Any) -> str:
    raw = _text(_get(goal, "goal_type") or _get(goal, "type") or _get(goal, "goal") or goal).lower()
    raw = raw.replace("-", "_").replace(" ", "_")
    aliases = {
        "lose_fat": "fat_loss",
        "weight_loss": "fat_loss",
        "body_fat_reduction": "fat_loss",
        "toning": "fat_loss",
        "build_muscle": "muscle_gain",
        "hypertrophy": "muscle_gain",
        "build_strength": "strength",
        "cardio": "endurance",
        "improve_cardio": "endurance",
        "conditioning": "endurance",
        "athletic_performance": "endurance",
        "hyrox": "endurance",
        "recomp": "body_recomp",
        "maintain": "general_consistency",
        "general_health": "general_consistency",
        "habit": "general_consistency",
        "consistency": "general_consistency",
    }
    return aliases.get(raw, raw if raw in GOAL_SCORING_CONFIGS else "general_consistency")


def _resolve_date_range(
    raw: Any,
    *,
    window: str,
    today: date,
    goal: Any,
) -> tuple[date, date]:
    if isinstance(raw, Mapping):
        start = _as_date(raw.get("start") or raw.get("periodStart") or raw.get("from"))
        end = _as_date(raw.get("end") or raw.get("periodEnd") or raw.get("to"))
        if start and end:
            return (min(start, end), max(start, end))
        window = str(raw.get("window") or window)

    window = window if window in SUPPORTED_WINDOWS else "rolling_7d"
    if window == "current_week":
        start = today - timedelta(days=today.weekday())
        return start, min(today, start + timedelta(days=6))
    if window == "rolling_14d":
        return today - timedelta(days=13), today
    if window == "rolling_28d":
        return today - timedelta(days=27), today
    if window == "goal_to_date":
        start = _as_date(_get(goal, "created_at") or _get(goal, "start_date") or _get(goal, "goalStartedAt")) or today
        return min(start, today), today
    return today - timedelta(days=6), today


def _score_training(
    *,
    goal_type: str,
    plan: Any,
    workouts: list[Any],
    workout_logs: list[Any],
    date_range: tuple[date, date],
) -> DomainScore:
    start, end = date_range
    planned = _planned_workouts(plan, workouts, date_range)
    logs = [_normalize_workout_log(row) for row in workout_logs]
    logs = [row for row in logs if row and _in_range(row.get("date"), start, end)]
    completions = [row for row in logs if row.get("completed", True)]

    if not planned:
        if completions:
            fallback = min(100.0, len(completions) / max(1.0, _expected_sessions_from_logs(logs)) * 100.0)
            return DomainScore(
                overall=fallback,
                scores={
                    "attendance": fallback,
                    "quality": fallback * 0.8,
                    "keyLiftCompletion": fallback * 0.8,
                    "intensity": fallback * 0.75,
                    "accessory": fallback * 0.8,
                    "progression": 70.0,
                    "weeklyVolume": fallback,
                    "zoneAdherence": _avg([_num(r.get("zoneAdherence"), None) for r in logs], 70.0),
                },
                evidence=[f"{len(completions)} logged session(s), no matched plan"],
                missing=["planned workout schedule"],
                target_summary="No planned sessions found in this window",
                actual_summary=f"{len(completions)} logged session(s)",
                coverage=0.55,
            )
        return DomainScore(
            overall=70.0,
            scores={
                "attendance": 70.0,
                "quality": 70.0,
                "keyLiftCompletion": 70.0,
                "intensity": 60.0 if goal_type == "strength" else 70.0,
                "accessory": 70.0,
                "progression": 65.0,
                "weeklyVolume": 70.0,
                "zoneAdherence": 70.0,
            },
            evidence=["No planned training due in this window"],
            missing=["training plan/logs"],
            target_summary="No planned sessions found",
            actual_summary="No training logs found",
            coverage=0.20,
        )

    session_scores = []
    used_log_ids: set[str] = set()
    for planned_session in planned:
        log = _match_workout_log(planned_session, logs, used_log_ids)
        if log:
            used_log_ids.add(str(log.get("_id") or id(log)))
        session_scores.append(_score_planned_session(planned_session, log, goal_type))

    attendance = _avg([s["attendance"] for s in session_scores], 0.0)
    quality = _avg([s["overall"] for s in session_scores], 0.0)
    key = _avg([s["keyExerciseCompletion"] for s in session_scores], quality)
    intensity = _avg([s["loadOrIntensityAdherence"] for s in session_scores], quality)
    accessory = _avg([s["accessoryVolume"] for s in session_scores], quality)
    progression = _avg([s["progressiveOverloadOrPlanProgression"] for s in session_scores], 70.0)
    zone = _avg([s["zoneAdherence"] for s in session_scores if s.get("hasCardio")], 70.0)
    set_completion = _avg([s["setCompletion"] for s in session_scores], quality)

    detail_sessions = sum(1 for s in session_scores if s["hasDetailedSets"])
    coverage = 0.25 + 0.75 * (detail_sessions / max(1, len(planned)))
    evidence = [
        f"{sum(1 for s in session_scores if s['attendance'] > 0)}/{len(planned)} planned sessions logged",
        f"{set_completion:.0f}% prescribed working sets completed",
    ]
    missing: list[str] = []
    if detail_sessions < len(planned):
        missing.append("set/rep/load detail for some completed sessions")
    if any(s["missingEffort"] for s in session_scores):
        missing.append("RPE/RIR or effort rating")

    return DomainScore(
        overall=quality,
        scores={
            "attendance": attendance,
            "quality": quality,
            "strengthQuality": quality,
            "keyLiftCompletion": key,
            "intensity": intensity,
            "accessory": accessory,
            "progression": progression,
            "weeklyVolume": set_completion,
            "zoneAdherence": zone,
            "setCompletion": set_completion,
        },
        evidence=evidence,
        missing=missing,
        target_summary=f"{len(planned)} planned session(s)",
        actual_summary=f"{sum(1 for s in session_scores if s['attendance'] > 0)} completed; {set_completion:.0f}% working sets",
        coverage=coverage,
    )


def _score_planned_session(planned: dict[str, Any], log: dict[str, Any] | None, goal_type: str) -> dict[str, Any]:
    if not log:
        return {
            "overall": 0.0,
            "attendance": 0.0,
            "exerciseCompletion": 0.0,
            "keyExerciseCompletion": 0.0,
            "accessoryVolume": 0.0,
            "setCompletion": 0.0,
            "repCompletion": 0.0,
            "loadOrIntensityAdherence": 0.0,
            "effortQuality": 0.0,
            "progressiveOverloadOrPlanProgression": 0.0,
            "zoneAdherence": 0.0,
            "hasCardio": _session_has_cardio(planned),
            "hasDetailedSets": False,
            "missingEffort": True,
        }

    planned_exercises = [_normalize_exercise(e) for e in _exercise_list(planned) if not _is_warmup(e)]
    actual_exercises = [_normalize_exercise(e) for e in _exercise_list(log)]
    has_details = any(_set_list(e) for e in actual_exercises)

    attendance = 100.0 if log.get("completed", True) else 50.0
    if not planned_exercises:
        fallback = _num(log.get("trainingScore") or log.get("training_score"), None)
        if fallback is None:
            fallback = 65.0 if has_details else 45.0
        return {
            "overall": _clamp(fallback, 0, 100),
            "attendance": attendance,
            "exerciseCompletion": fallback,
            "keyExerciseCompletion": fallback,
            "accessoryVolume": fallback,
            "setCompletion": fallback,
            "repCompletion": fallback,
            "loadOrIntensityAdherence": fallback,
            "effortQuality": 70.0,
            "progressiveOverloadOrPlanProgression": 70.0,
            "zoneAdherence": _zone_score_for_log(log, planned),
            "hasCardio": _session_has_cardio(planned) or _session_has_cardio(log),
            "hasDetailedSets": has_details,
            "missingEffort": True,
        }

    exercise_scores = []
    set_scores = []
    rep_scores = []
    intensity_scores = []
    effort_scores = []
    progression_scores = []
    key_scores = []
    accessory_scores = []
    missing_effort = False

    for p_ex in planned_exercises:
        importance = _exercise_importance(p_ex, goal_type)
        match, match_score = _match_exercise(p_ex, actual_exercises)
        exercise_scores.append((match_score, importance))
        if importance >= 1.4:
            key_scores.append(match_score)

        if match is None:
            set_scores.append((0.0, importance))
            rep_scores.append((0.0, importance))
            intensity_scores.append((_missing_intensity_score(goal_type), importance))
            effort_scores.append((0.0, importance))
            progression_scores.append((0.0, importance))
            if importance < 1.2:
                accessory_scores.append(0.0)
            continue

        prescribed_sets = _prescribed_working_sets(p_ex)
        actual_sets = [s for s in _set_list(match) if not _set_is_warmup(s)]
        completed_sets = [s for s in actual_sets if _set_completed(s)]
        set_score = _ratio_score(len(completed_sets), prescribed_sets)
        set_scores.append((set_score, importance))
        if importance < 1.2:
            accessory_scores.append(set_score)

        rep_scores.append((_rep_completion_score(p_ex, completed_sets), importance))
        intensity_scores.append((_intensity_score(p_ex, completed_sets, goal_type, log), importance))
        effort, missing = _effort_score(p_ex, completed_sets, log)
        effort_scores.append((effort, importance))
        missing_effort = missing_effort or missing
        progression_scores.append((_progression_score(p_ex, completed_sets, log, goal_type), importance))

    exercise_completion = _weighted_avg(exercise_scores, 0.0)
    set_completion = _weighted_avg(set_scores, 0.0)
    rep_completion = _weighted_avg(rep_scores, 0.0)
    intensity = _weighted_avg(intensity_scores, _missing_intensity_score(goal_type))
    effort = _weighted_avg(effort_scores, 70.0)
    progression = _weighted_avg(progression_scores, 70.0)
    key_completion = _avg(key_scores, exercise_completion)
    accessory = _avg(accessory_scores, set_completion)

    if not has_details and attendance > 0:
        exercise_completion = min(exercise_completion, 45.0)
        set_completion = min(set_completion, 25.0)
        rep_completion = min(rep_completion, 25.0)
        intensity = min(intensity, _missing_intensity_score(goal_type))
        effort = min(effort, 60.0)
        progression = min(progression, 60.0)

    weights = {
        "attendance": 0.15,
        "exerciseCompletion": 0.20,
        "setCompletion": 0.15,
        "repCompletion": 0.15,
        "loadOrIntensityAdherence": 0.15,
        "effortQuality": 0.10,
        "progressiveOverloadOrPlanProgression": 0.10,
    }
    overall = (
        attendance * weights["attendance"]
        + exercise_completion * weights["exerciseCompletion"]
        + set_completion * weights["setCompletion"]
        + rep_completion * weights["repCompletion"]
        + intensity * weights["loadOrIntensityAdherence"]
        + effort * weights["effortQuality"]
        + progression * weights["progressiveOverloadOrPlanProgression"]
    )
    return {
        "overall": _clamp(overall, 0, 100),
        "attendance": attendance,
        "exerciseCompletion": exercise_completion,
        "keyExerciseCompletion": key_completion,
        "accessoryVolume": accessory,
        "setCompletion": set_completion,
        "repCompletion": rep_completion,
        "loadOrIntensityAdherence": intensity,
        "effortQuality": effort,
        "progressiveOverloadOrPlanProgression": progression,
        "zoneAdherence": _zone_score_for_log(log, planned),
        "hasCardio": _session_has_cardio(planned) or _session_has_cardio(log),
        "hasDetailedSets": has_details,
        "missingEffort": missing_effort,
    }


def _score_nutrition(
    *,
    goal_type: str,
    config: GoalScoringConfig,
    nutrition_logs: list[Any],
    date_range: tuple[date, date],
    targets: Any,
) -> DomainScore:
    start, end = date_range
    days = _date_span(start, end)
    by_day = _daily_nutrition_by_date(nutrition_logs, date_range)
    target_calories = _num(_get(targets, "calories") or _get(targets, "calorieTarget") or _get(targets, "targetCalories"), 0.0)
    target_protein = _num(_get(targets, "protein_g") or _get(targets, "protein") or _get(targets, "proteinTarget"), 0.0)
    target_carbs = _num(_get(targets, "carbs_g") or _get(targets, "carbs") or _get(targets, "carbTarget"), 0.0)

    component_totals: dict[str, list[float]] = {key: [] for key in config.nutrition_day_weights}
    overall_days: list[float] = []
    logged_days = 0
    missing_days = 0
    avg_calories_values: list[float] = []
    avg_protein_values: list[float] = []
    missing_required = goal_type in {"fat_loss", "muscle_gain", "strength", "endurance", "body_recomp"}

    for d in days:
        row = by_day.get(d)
        if row:
            logged_days += 1
            calories = _num(row.get("calories"), 0.0)
            protein = _num(row.get("protein_g") or row.get("protein"), 0.0)
            if 350 <= calories <= 7000:
                avg_calories_values.append(calories)
            if 0 <= protein <= 400:
                avg_protein_values.append(protein)
        else:
            missing_days += 1
            calories = 0.0
            protein = 0.0

        day_scores = _nutrition_day_components(
            goal_type=goal_type,
            row=row,
            calories=calories,
            protein=protein,
            target_calories=_target_value(row, ("target_calories", "calorie_target", "calorieTarget"), target_calories),
            target_protein=_target_value(row, ("target_protein_g", "protein_target_g", "proteinTarget"), target_protein),
            target_carbs=_target_value(row, ("target_carbs_g", "carbs_target_g", "carbTarget"), target_carbs),
            missing_required=missing_required,
        )
        for key in config.nutrition_day_weights:
            component_totals[key].append(day_scores.get(key, day_scores.get(_fallback_component_key(key), 0.0)))
        overall_days.append(sum(
            day_scores.get(key, day_scores.get(_fallback_component_key(key), 0.0)) * weight
            for key, weight in config.nutrition_day_weights.items()
        ))

    component_scores = {key: _avg(values, 0.0) for key, values in component_totals.items()}
    calorie_score = (
        component_scores.get("calorieTargetAdherence")
        or component_scores.get("calorieSurplusAdherence")
        or component_scores.get("caloriesMaintenanceOrSurplus")
        or component_scores.get("calorieAdequacy")
        or 0.0
    )
    protein_score = (
        component_scores.get("proteinTargetAdherence")
        or component_scores.get("protein")
        or 0.0
    )
    logging_score = component_scores.get("loggingCompleteness", (logged_days / max(1, len(days))) * 100.0)
    carb_score = component_scores.get("carbFueling", 70.0)
    hydration_score = (
        component_scores.get("hydration")
        or component_scores.get("hydrationOrAlcoholControl")
        or 70.0
    )

    missing = []
    if missing_days:
        missing.append(f"{missing_days}/{len(days)} nutrition days")
    if target_calories <= 0:
        missing.append("calorie target")
    if target_protein <= 0:
        missing.append("protein target")

    avg_cal = _avg(avg_calories_values, 0.0)
    avg_pro = _avg(avg_protein_values, 0.0)
    return DomainScore(
        overall=_avg(overall_days, 0.0),
        scores={
            "calories": calorie_score,
            "protein": protein_score,
            "overall": _avg(overall_days, 0.0),
            "logging": logging_score,
            "carbs": carb_score,
            "hydration": hydration_score,
            "fueling": _clamp((calorie_score * 0.35 + carb_score * 0.35 + hydration_score * 0.30), 0, 100),
            "support": _clamp((calorie_score * 0.45 + protein_score * 0.40 + hydration_score * 0.15), 0, 100),
        },
        evidence=[
            f"{logged_days}/{len(days)} nutrition days logged",
            f"{avg_cal:.0f} kcal/day, {avg_pro:.0f}g protein/day on logged days" if logged_days else "No logged nutrition days",
        ],
        missing=missing,
        target_summary=_nutrition_target_summary(target_calories, target_protein),
        actual_summary=f"{logged_days}/{len(days)} days logged; {avg_cal:.0f} kcal avg; {avg_pro:.0f}g protein avg",
        coverage=logged_days / max(1, len(days)),
    )


def _target_value(row: dict[str, Any] | None, aliases: tuple[str, ...], fallback: float) -> float:
    if row is not None:
        for key in aliases:
            value = _num(row.get(key), None)
            if value is not None and value > 0:
                return value
    return fallback


def _nutrition_day_components(
    *,
    goal_type: str,
    row: dict[str, Any] | None,
    calories: float,
    protein: float,
    target_calories: float,
    target_protein: float,
    target_carbs: float,
    missing_required: bool,
) -> dict[str, float]:
    if row is None:
        missing_score = 25.0 if missing_required else 35.0
        return {
            "calorieTargetAdherence": missing_score,
            "calorieSurplusAdherence": missing_score,
            "caloriesMaintenanceOrSurplus": missing_score,
            "calorieAdequacy": missing_score,
            "proteinTargetAdherence": missing_score,
            "protein": missing_score,
            "fiberOrFoodQuality": 45.0,
            "mealConsistency": 0.0,
            "hydrationOrAlcoholControl": 60.0,
            "hydration": 60.0,
            "loggingCompleteness": 0.0,
            "carbFueling": missing_score,
            "prePostWorkoutFueling": 50.0,
        }

    if goal_type == "fat_loss":
        calorie_score = score_fat_loss_calories(calories, target_calories)
    elif goal_type == "muscle_gain":
        calorie_score = score_muscle_gain_calories(calories, target_calories)
    elif goal_type in {"strength", "body_recomp", "general_consistency"}:
        calorie_score = score_calorie_consistency(calories, target_calories)
    else:
        calorie_score = score_calorie_adequacy(calories, target_calories)

    protein_score = _protein_score(protein, target_protein)
    food_quality = _food_quality_score(row, calories)
    meals = _num(row.get("meals_logged") or row.get("meal_count"), 0.0)
    expected_meals = _num(row.get("expected_meals"), meals)
    meal_consistency = _ratio_score(meals, expected_meals) if expected_meals > 0 else 0.0
    hydration = _hydration_score(row)
    carb = _protein_score(_num(row.get("carbs_g") or row.get("carbs"), 0.0), target_carbs) if target_carbs > 0 else 70.0
    logging = _clamp(_num(row.get("logging_completeness"), None) or (100.0 if calories > 0 or protein > 0 or meals > 0 else 0.0), 0, 100)
    prepost = 100.0 if bool(row.get("pre_workout_logged") or row.get("post_workout_logged")) else 65.0

    return {
        "calorieTargetAdherence": calorie_score,
        "calorieSurplusAdherence": calorie_score,
        "caloriesMaintenanceOrSurplus": calorie_score,
        "calorieAdequacy": calorie_score,
        "proteinTargetAdherence": protein_score,
        "protein": protein_score,
        "fiberOrFoodQuality": food_quality,
        "mealConsistency": meal_consistency,
        "hydrationOrAlcoholControl": hydration,
        "hydration": hydration,
        "loggingCompleteness": logging,
        "carbFueling": carb,
        "prePostWorkoutFueling": prepost,
    }


def score_fat_loss_calories(actual_calories: float, target_calories: float) -> float:
    if target_calories <= 0 or actual_calories <= 0:
        return 25.0
    deviation = (actual_calories - target_calories) / target_calories
    if -0.05 <= deviation <= 0.05:
        return 100.0
    if deviation > 0:
        if deviation <= 0.10:
            return 85.0
        if deviation <= 0.15:
            return 70.0
        if deviation <= 0.20:
            return 50.0
        return 25.0
    if deviation >= -0.10:
        return 90.0
    if deviation >= -0.15:
        return 75.0
    if deviation >= -0.20:
        return 55.0
    return 30.0


def score_muscle_gain_calories(actual_calories: float, target_calories: float) -> float:
    if target_calories <= 0 or actual_calories <= 0:
        return 25.0
    deviation = (actual_calories - target_calories) / target_calories
    if -0.05 <= deviation <= 0.05:
        return 100.0
    if deviation < 0:
        if deviation >= -0.10:
            return 80.0
        if deviation >= -0.15:
            return 60.0
        if deviation >= -0.20:
            return 40.0
        return 25.0
    if deviation <= 0.10:
        return 90.0
    if deviation <= 0.15:
        return 80.0
    if deviation <= 0.20:
        return 60.0
    return 35.0


def score_calorie_consistency(actual_calories: float, target_calories: float) -> float:
    if target_calories <= 0 or actual_calories <= 0:
        return 30.0
    deviation = abs(actual_calories - target_calories) / target_calories
    if deviation <= 0.05:
        return 100.0
    if deviation <= 0.10:
        return 85.0
    if deviation <= 0.15:
        return 70.0
    if deviation <= 0.20:
        return 50.0
    return 30.0


def score_calorie_adequacy(actual_calories: float, target_calories: float) -> float:
    if target_calories <= 0 or actual_calories <= 0:
        return 30.0
    ratio = actual_calories / target_calories
    if 0.95 <= ratio <= 1.10:
        return 100.0
    if 0.85 <= ratio < 0.95:
        return 80.0
    if 1.10 < ratio <= 1.20:
        return 80.0
    if 0.75 <= ratio < 0.85:
        return 60.0
    return 35.0


def _score_sleep_recovery(
    *,
    sleep_logs: list[Any],
    recovery_logs: list[Any],
    checkins: list[Any],
    date_range: tuple[date, date],
) -> DomainScore:
    start, end = date_range
    days = _date_span(start, end)
    sleep_by_day = {
        _as_date(_get(row, "date") or _get(row, "night_date") or _get(row, "snapshot_date")): row
        for row in sleep_logs
        if _as_date(_get(row, "date") or _get(row, "night_date") or _get(row, "snapshot_date"))
    }
    recovery_rows = [row for row in recovery_logs if _in_range(_as_date(_get(row, "date") or _get(row, "activity_date") or _get(row, "day_key") or _get(row, "summary_date")), start, end)]
    checkin_rows = [row for row in checkins if _in_range(_as_date(_get(row, "date") or _get(row, "checkin_date") or _get(row, "submitted_at")), start, end)]

    duration_scores: list[float] = []
    hours: list[float] = []
    bedtime_values: list[float] = []
    readiness_scores: list[float] = []
    pain_penalties: list[float] = []

    for d in days:
        row = sleep_by_day.get(d)
        if not row:
            continue
        h = _num(_get(row, "total_hours") or _get(row, "sleep_h") or _get(row, "sleepHours"), None)
        if h is not None and 0 < h <= 16:
            hours.append(h)
            duration_scores.append(_sleep_duration_score(h))
        bedtime = _num(_get(row, "bedtime_minutes_from_midnight"), None)
        if bedtime is not None:
            bedtime_values.append(bedtime)
        ready = _num(_get(row, "readiness_score") or _get(row, "recovery_score"), None)
        if ready is not None:
            readiness_scores.append(_clamp(ready, 0, 100))

    for row in recovery_rows + checkin_rows:
        ready = _num(_get(row, "readiness_score") or _get(row, "energy"), None)
        if ready is not None:
            readiness_scores.append(_clamp(ready * 20 if ready <= 5 else ready, 0, 100))
        soreness = _num(_get(row, "soreness_severity_0_10") or _get(row, "soreness"), None)
        pain = _get(row, "pain_present")
        if soreness is not None:
            pain_penalties.append(max(0.0, 100.0 - soreness * 7.0))
        if pain is True:
            severity = _num(_get(row, "pain_severity_0_10"), 5.0)
            pain_penalties.append(max(20.0, 100.0 - severity * 10.0))

    if not duration_scores and not readiness_scores and not pain_penalties:
        return DomainScore(
            overall=65.0,
            scores={"sleep": 65.0, "recovery": 65.0, "readiness": 65.0},
            evidence=["No sleep or recovery data in this window"],
            missing=["sleep duration", "readiness/recovery check-in"],
            target_summary="7-9h sleep and stable recovery markers",
            actual_summary="No recovery data",
            coverage=0.0,
        )

    duration = _avg(duration_scores, 70.0)
    consistency = _sleep_consistency_score(bedtime_values)
    readiness = _avg(readiness_scores + pain_penalties, 72.0)
    overall = duration * 0.60 + consistency * 0.15 + readiness * 0.25
    avg_hours = _avg(hours, 0.0)
    missing = []
    if len(duration_scores) < len(days):
        missing.append(f"{len(days) - len(duration_scores)}/{len(days)} sleep nights")
    if not readiness_scores and not pain_penalties:
        missing.append("readiness/soreness")
    return DomainScore(
        overall=overall,
        scores={"sleep": duration, "recovery": overall, "readiness": readiness, "consistency": consistency},
        evidence=[f"{len(duration_scores)}/{len(days)} sleep nights", f"{avg_hours:.1f}h average sleep" if avg_hours else "No sleep duration average"],
        missing=missing,
        target_summary="7-9h sleep, consistent schedule, low soreness/pain",
        actual_summary=f"{avg_hours:.1f}h average sleep" if avg_hours else "Recovery data only",
        coverage=max(len(duration_scores) / max(1, len(days)), len(readiness_scores) / max(1, len(days))),
    )


def _score_cardio_steps(
    *,
    goal_type: str,
    plan: Any,
    step_logs: list[Any],
    cardio_logs: list[Any],
    workout_logs: list[Any],
    date_range: tuple[date, date],
    user: Any,
) -> DomainScore:
    start, end = date_range
    days = _date_span(start, end)
    target_steps = _num(_get(user, "target_steps") or _get(user, "targetSteps"), None)
    if target_steps is None:
        target_steps = 8000.0 if goal_type in {"fat_loss", "body_recomp"} else 7000.0

    steps = []
    for row in step_logs:
        d = _as_date(_get(row, "date") or _get(row, "snapshot_date"))
        if not _in_range(d, start, end):
            continue
        val = _num(_get(row, "steps"), None)
        if val is not None and 0 <= val <= 60000:
            steps.append(val)
    avg_steps = _avg(steps, 0.0)
    step_score = _ratio_score(avg_steps, target_steps) if steps else 65.0

    cardio_rows = []
    for row in list(cardio_logs) + list(workout_logs):
        d = _as_date(_get(row, "date") or _get(row, "workout_date") or _get(row, "completed_at"))
        if not _in_range(d, start, end):
            continue
        if _looks_cardio(row):
            cardio_rows.append(row)

    actual_minutes = sum(_cardio_minutes(row) for row in cardio_rows)
    target_minutes = _planned_cardio_minutes(plan, date_range)
    if target_minutes <= 0:
        target_minutes = 150.0 * (len(days) / 7.0) if goal_type == "endurance" else 75.0 * (len(days) / 7.0)
    weekly_volume = _ratio_score(actual_minutes, target_minutes)
    key_sessions = _key_cardio_session_score(cardio_rows, plan, date_range)
    zone = _zone_adherence_score(cardio_rows)
    steps_or_cardio = max(step_score, step_score * 0.55 + weekly_volume * 0.45)
    daily_movement = step_score if steps else max(weekly_volume * 0.75, 60.0 if cardio_rows else 45.0)

    missing = []
    if not steps:
        missing.append("step data")
    if goal_type == "endurance" and not cardio_rows:
        missing.append("cardio session detail")
    if goal_type == "endurance" and zone < 70:
        missing.append("heart-rate zone/intensity detail")

    return DomainScore(
        overall=steps_or_cardio if goal_type != "endurance" else (weekly_volume * 0.35 + key_sessions * 0.30 + zone * 0.35),
        scores={
            "steps": step_score,
            "stepsOrCardio": steps_or_cardio,
            "dailyMovement": daily_movement,
            "weeklyVolume": weekly_volume,
            "keySessionCompletion": key_sessions,
            "zoneIntensityAdherence": zone,
            "cardio": weekly_volume,
        },
        evidence=[f"{avg_steps:.0f} avg steps" if steps else "No step data", f"{actual_minutes:.0f}/{target_minutes:.0f} cardio minutes"],
        missing=missing,
        target_summary=f"{target_steps:.0f} steps/day; {target_minutes:.0f} cardio min/window",
        actual_summary=f"{avg_steps:.0f} avg steps; {actual_minutes:.0f} cardio min",
        coverage=max(len(steps) / max(1, len(days)), min(1.0, len(cardio_rows) / max(1, len(days) / 3))),
    )


def _score_measurement(
    *,
    goal_type: str,
    body_metrics: list[Any],
    checkins: list[Any],
    date_range: tuple[date, date],
) -> DomainScore:
    start, end = date_range
    rows = [row for row in body_metrics if _in_range(_metric_date(row), start, end)]
    rows.extend(row for row in checkins if _in_range(_as_date(_get(row, "checkin_date") or _get(row, "date")), start, end))
    sample_count = len(rows)
    if sample_count <= 0:
        return DomainScore(
            overall=45.0 if goal_type in {"fat_loss", "body_recomp", "muscle_gain"} else 60.0,
            scores={"measurementConsistency": 45.0, "bodyMetrics": 45.0},
            evidence=["No body/progress measurements in this window"],
            missing=["body metrics"],
            target_summary="2+ reliable progress measurements",
            actual_summary="No measurements",
            coverage=0.0,
        )
    score = 100.0 if sample_count >= 3 else 80.0 if sample_count == 2 else 55.0
    reliability = _measurement_reliability(rows)
    overall = score * 0.65 + reliability * 0.35
    return DomainScore(
        overall=overall,
        scores={"measurementConsistency": overall, "bodyMetrics": overall, "reliability": reliability},
        evidence=[f"{sample_count} progress measurement(s)", f"{reliability:.0f}% measurement reliability"],
        missing=[] if sample_count >= 2 else ["repeat measurement"],
        target_summary="2+ reliable progress measurements",
        actual_summary=f"{sample_count} measurement(s)",
        coverage=min(1.0, sample_count / 3.0),
    )


def _score_checkins(checkins: list[Any], date_range: tuple[date, date]) -> DomainScore:
    start, end = date_range
    rows = [row for row in checkins if _in_range(_as_date(_get(row, "checkin_date") or _get(row, "date") or _get(row, "submitted_at")), start, end)]
    weeks = max(1, math.ceil(len(_date_span(start, end)) / 7))
    score = _ratio_score(len(rows), weeks)
    return DomainScore(
        overall=score,
        scores={"checkins": score},
        evidence=[f"{len(rows)}/{weeks} check-in(s)"],
        missing=[] if len(rows) >= weeks else ["weekly check-in"],
        target_summary=f"{weeks} check-in(s)",
        actual_summary=f"{len(rows)} check-in(s)",
        coverage=min(1.0, len(rows) / weeks),
    )


def _score_logging_completeness(training: DomainScore, nutrition: DomainScore, measurement: DomainScore) -> DomainScore:
    score = training.coverage * 25.0 + nutrition.coverage * 55.0 + measurement.coverage * 20.0
    missing = [*training.missing, *nutrition.missing, *measurement.missing]
    return DomainScore(
        overall=score,
        scores={"loggingCompleteness": score},
        evidence=[
            f"{nutrition.coverage * 100:.0f}% nutrition coverage",
            f"{training.coverage * 100:.0f}% training-detail coverage",
        ],
        missing=missing,
        target_summary="Complete training, nutrition, and measurement logs",
        actual_summary=f"{score:.0f}% composite logging completeness",
        coverage=score / 100.0,
    )


def _build_execution_breakdown(config: GoalScoringConfig, domain: dict[str, DomainScore]) -> list[dict[str, Any]]:
    out = []
    for driver_id, name, category, weight in config.drivers:
        score, source = _driver_score(driver_id, domain)
        limiter = _limiter_severity(score, source.missing)
        out.append({
            "driverId": driver_id,
            "driverName": name,
            "category": category,
            "weight": weight,
            "score": _round_score(score),
            "weightedContribution": round(score * weight, 1),
            "targetSummary": source.target_summary,
            "actualSummary": source.actual_summary,
            "evidence": source.evidence[:4],
            "missingData": bool(source.missing),
            "limiterSeverity": limiter,
        })
    return out


def _driver_score(driver_id: str, domain: dict[str, DomainScore]) -> tuple[float, DomainScore]:
    training = domain["training"]
    nutrition = domain["nutrition"]
    sleep = domain["sleepRecovery"]
    cardio = domain["cardioSteps"]
    measurement = domain["measurement"]
    checkins = domain["checkins"]
    logging = domain["logging"]
    mapping = {
        "calories": (nutrition.scores.get("calories", nutrition.overall), nutrition),
        "protein": (nutrition.scores.get("protein", nutrition.overall), nutrition),
        "strengthTrainingQuality": (training.scores.get("strengthQuality", training.overall), training),
        "stepsOrCardio": (cardio.scores.get("stepsOrCardio", cardio.overall), cardio),
        "sleepRecovery": (sleep.scores.get("recovery", sleep.overall), sleep),
        "loggingCompleteness": (logging.overall, logging),
        "trainingQuality": (training.scores.get("quality", training.overall), training),
        "progressiveOverload": (training.scores.get("progression", training.overall), training),
        "calorieSurplusConsistency": (nutrition.scores.get("calories", nutrition.overall), nutrition),
        "keyLiftCompletion": (training.scores.get("keyLiftCompletion", training.overall), training),
        "intensityLoadAdherence": (training.scores.get("intensity", training.overall), training),
        "accessoryVolume": (training.scores.get("accessory", training.overall), training),
        "recoveryReadiness": (sleep.scores.get("readiness", sleep.overall), sleep),
        "nutritionSupport": (nutrition.scores.get("support", nutrition.overall), nutrition),
        "weeklyVolume": (cardio.scores.get("weeklyVolume", cardio.overall), cardio),
        "keySessionCompletion": (cardio.scores.get("keySessionCompletion", cardio.overall), cardio),
        "zoneIntensityAdherence": (cardio.scores.get("zoneIntensityAdherence", cardio.overall), cardio),
        "recovery": (sleep.overall, sleep),
        "fuelingHydration": (nutrition.scores.get("fueling", nutrition.overall), nutrition),
        "calorieConsistency": (nutrition.scores.get("calories", nutrition.overall), nutrition),
        "measurementConsistency": (measurement.overall, measurement),
        "plannedWorkoutCompletion": (training.scores.get("quality", training.overall), training),
        "nutritionConsistency": (nutrition.overall, nutrition),
        "dailyMovement": (cardio.scores.get("dailyMovement", cardio.overall), cardio),
        "checkInCompleteness": (checkins.overall, checkins),
    }
    return mapping.get(driver_id, (50.0, logging))


def _build_projection_inputs(
    *,
    goal: Any,
    goal_type: str,
    user: Any,
    body_metrics: list[Any],
    workout_logs: list[Any],
    cardio_logs: list[Any],
    date_range: tuple[date, date],
    as_of: date,
) -> ProjectionInputs:
    metric, unit, target_change, timeframe_days = _target_change(goal, goal_type, user)
    goal_start = _as_date(_get(goal, "created_at") or _get(goal, "start_date") or _get(goal, "goalStartedAt")) or date_range[0]
    elapsed_days = max(1, min(timeframe_days, (as_of - goal_start).days + 1))
    expected_to_date = target_change * (elapsed_days / max(1, timeframe_days))

    actual_progress = None
    source = "none"
    reliability = 45.0
    signal_quality = 45.0
    sample_count = 0
    if metric == "body_fat_pct":
        actual_progress, source, reliability, signal_quality, sample_count = _body_fat_progress(body_metrics, goal)
        if actual_progress is None:
            actual_progress, source, reliability, signal_quality, sample_count = _weight_progress(body_metrics, goal, as_body_fat_proxy=True)
    elif metric == "weight_lbs":
        actual_progress, source, reliability, signal_quality, sample_count = _weight_progress(body_metrics, goal)
    elif metric == "estimated_1rm_pct":
        actual_progress, source, reliability, signal_quality, sample_count = _strength_progress(workout_logs)
    elif metric == "cardio_volume_min":
        actual_progress, source, reliability, signal_quality, sample_count = _endurance_progress(cardio_logs + workout_logs)
    else:
        actual_progress = None
        source = "execution-only"
        reliability = 55.0
        signal_quality = 55.0
        sample_count = 0

    return ProjectionInputs(
        metric=metric,
        unit=unit,
        target_change=target_change,
        timeframe_days=timeframe_days,
        actual_progress=actual_progress,
        expected_progress_to_date=expected_to_date,
        source=source,
        reliability=reliability,
        signal_quality=signal_quality,
        sample_count=sample_count,
    )


def _score_projection_confidence(
    *,
    goal_type: str,
    days: list[date],
    goal: Any,
    training: DomainScore,
    nutrition: DomainScore,
    sleep_recovery: DomainScore,
    cardio_steps: DomainScore,
    measurement: DomainScore,
    projection: ProjectionInputs,
) -> tuple[list[dict[str, Any]], int]:
    required_coverages = [
        training.coverage,
        measurement.coverage,
    ]
    if goal_type in {"fat_loss", "muscle_gain", "strength", "endurance", "body_recomp"}:
        required_coverages.append(nutrition.coverage)
    if goal_type in {"fat_loss", "endurance", "body_recomp", "general_consistency"}:
        required_coverages.append(cardio_steps.coverage)
    if goal_type in {"muscle_gain", "strength", "endurance", "body_recomp"}:
        required_coverages.append(sleep_recovery.coverage)
    completeness = _clamp(_avg([c * 100 for c in required_coverages], 0.0), 0, 100)

    signal_quality = projection.signal_quality
    raw_rf = _raw_response_factor(projection)
    if raw_rf is None:
        model_fit = 55.0
        model_reason = "No reliable progress trend yet"
    else:
        model_fit = _clamp(100.0 - abs(raw_rf - 1.0) * 90.0, 25.0, 100.0)
        model_reason = f"Observed response is {raw_rf:.2f}x expected pace"

    reliability = projection.reliability
    goal_start = _as_date(_get(goal, "created_at") or _get(goal, "start_date") or _get(goal, "goalStartedAt")) or days[0]
    elapsed = max(1, (days[-1] - goal_start).days + 1)
    sample_size = min(100.0, (elapsed / 28.0) * 70.0 + min(30.0, projection.sample_count * 6.0))

    components = [
        ("dataCompleteness", 0.30, completeness, "Required training, nutrition, movement, recovery, and measurement coverage"),
        ("signalQuality", 0.25, signal_quality, f"Progress signal from {projection.source} with {projection.sample_count} sample(s)"),
        ("modelFit", 0.25, model_fit, model_reason),
        ("measurementReliability", 0.10, reliability, f"Measurement reliability from {projection.source}"),
        ("sampleSize", 0.10, sample_size, f"{elapsed} day(s) since goal start, {projection.sample_count} progress sample(s)"),
    ]
    breakdown = [
        {
            "component": component,
            "weight": weight,
            "score": _round_score(score),
            "reason": reason,
        }
        for component, weight, score, reason in components
    ]
    confidence = _round_score(sum(score * weight for _, weight, score, _ in components))
    return breakdown, confidence


def _response_factor(projection: ProjectionInputs, confidence: int) -> float:
    raw = _raw_response_factor(projection)
    if raw is None:
        return 1.0
    bounded = _clamp(raw, 0.50, 1.25)
    if confidence < 40:
        return 1.0 + (bounded - 1.0) * 0.25
    if confidence < 60:
        return 1.0 + (bounded - 1.0) * 0.50
    return bounded


def _project_outcome(
    *,
    projection: ProjectionInputs,
    execution_score: int,
    response_factor: float,
    confidence: int,
) -> dict[str, Any]:
    midpoint = projection.target_change * (execution_score / 100.0) * response_factor
    band = 0.18 if confidence >= 80 else 0.28 if confidence >= 60 else 0.42 if confidence >= 40 else 0.60
    expected_low = midpoint * (1.0 - band)
    expected_high = midpoint * (1.0 + band)
    if projection.unit == "percentage_points":
        rounder = _round1
    elif projection.unit in {"lb", "kg"}:
        rounder = _round1
    else:
        rounder = lambda v: round(v, 1)
    range_low, range_high = sorted((expected_low, expected_high))
    mid = rounder(midpoint)
    low = rounder(range_low)
    high = rounder(range_high)
    return {
        "metric": projection.metric,
        "unit": projection.unit,
        "targetChange": rounder(projection.target_change),
        "expectedMidpoint": mid,
        "expectedLow": low,
        "expectedHigh": high,
        "timeframeDays": projection.timeframe_days,
        "displayText": _projection_display_text(projection.metric, projection.unit, mid, low, high, projection.timeframe_days, confidence),
    }


def _limiting_factors(breakdown: list[dict[str, Any]], confidence: int) -> list[dict[str, str]]:
    candidates = [
        (item["weight"] * (100 - item["score"]), item)
        for item in breakdown
        if item["score"] < 85 or item.get("missingData")
    ]
    candidates.sort(key=lambda x: x[0], reverse=True)
    out = []
    for impact, item in candidates[:3]:
        out.append({
            "driverName": item["driverName"],
            "reason": _limiter_reason(item),
            "impact": "high" if impact >= 10 else "moderate" if impact >= 5 else "low",
            "suggestedFix": _suggested_fix(item["driverId"], item["actualSummary"]),
        })
    if confidence < 45 and len(out) < 3:
        out.append({
            "driverName": "Projection confidence",
            "reason": "The estimate is limited by sparse or noisy progress data.",
            "impact": "moderate",
            "suggestedFix": "Add repeat body/progress measurements and complete core logs for the next 7 days.",
        })
    return out


def _next_best_actions(limiting_factors: list[dict[str, str]], breakdown: list[dict[str, Any]]) -> list[dict[str, str]]:
    actions = []
    by_name = {item["driverName"]: item for item in breakdown}
    for factor in limiting_factors[:3]:
        item = by_name.get(factor["driverName"], {})
        title, description = _action_for_driver(item.get("driverId"), factor)
        actions.append({
            "title": title,
            "description": description,
            "expectedImpact": "Improves the largest current limiter in this scoring window.",
        })
    return actions[:3]


# ─── DB adapter ──────────────────────────────────────────────────────────────

def calculate_goal_scores_for_user(
    db: Any,
    user_id: int,
    *,
    window: str = "rolling_7d",
    as_of: date | None = None,
) -> dict[str, Any]:
    """Load persisted rows and score every active goal for a user."""
    from sqlmodel import select
    from app.models import (
        DailyHealthSnapshot,
        DailyNutritionMetrics,
        DailyStressSummary,
        ExerciseSet,
        Meal,
        MealItem,
        PlanDay,
        PlanWeek,
        RecoveryActivity,
        SleepLog,
        User,
        UserDayState,
        UserGoal,
        UserPreferences,
        UserProfile,
        WeeklyCheckIn,
        WeightEntry,
        BodyScan,
        WorkoutCompletion,
        WorkoutExercise,
        WorkoutSession,
    )
    from app.services.nutrition.meal_history import dedupe_meals_for_aggregation
    from app.services.nutrition.targets import resolve_targets_for_user

    today = as_of or date.today()
    user = db.exec(select(User).where(User.id == user_id)).first()
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
    goals = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
        .order_by(UserGoal.created_at.desc())
    ).all()
    if not goals:
        return {"scores": [], "window": window, "asOfDate": today.isoformat()}

    scores = []
    for goal in goals:
        period_start, period_end = _resolve_date_range(None, window=window, today=today, goal=goal)
        calibration_start = _as_date(goal.created_at) or period_start

        plan_days = db.exec(
            select(PlanDay)
            .where(PlanDay.user_id == user_id)
            .where(PlanDay.day_date >= period_start)
            .where(PlanDay.day_date <= period_end)
            .order_by(PlanDay.day_date.asc())
        ).all()
        plan = {
            "days": [_plan_day_to_dict(row) for row in plan_days],
        }

        completions = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == user_id)
            .where(WorkoutCompletion.workout_date >= period_start)
            .where(WorkoutCompletion.workout_date <= period_end)
            .order_by(WorkoutCompletion.completed_at.asc())
        ).all()
        sessions = db.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == user_id)
            .where(WorkoutSession.workout_date >= period_start)
            .where(WorkoutSession.workout_date <= period_end)
        ).all()
        session_ids = [s.id for s in sessions if s.id is not None]
        exercises = db.exec(select(WorkoutExercise).where(WorkoutExercise.session_id.in_(session_ids))).all() if session_ids else []
        exercise_ids = [e.id for e in exercises if e.id is not None]
        sets = db.exec(select(ExerciseSet).where(ExerciseSet.workout_exercise_id.in_(exercise_ids))).all() if exercise_ids else []
        workout_logs = _workout_logs_from_rows(completions, sessions, exercises, sets)

        meals = db.exec(
            select(Meal)
            .where(Meal.user_id == user_id)
            .where(Meal.meal_date >= period_start)
            .where(Meal.meal_date <= period_end)
        ).all()
        meal_ids = [m.id for m in meals if m.id is not None]
        meal_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
        metrics = db.exec(
            select(DailyNutritionMetrics)
            .where(DailyNutritionMetrics.user_id == user_id)
            .where(DailyNutritionMetrics.metric_date >= period_start)
            .where(DailyNutritionMetrics.metric_date <= period_end)
        ).all()
        items_by_meal: dict[int, list[Any]] = {}
        for item in meal_items:
            items_by_meal.setdefault(item.meal_id, []).append(item)
        deduped_meals = dedupe_meals_for_aggregation(meals, items_by_meal) if meals else []
        nutrition_logs = _nutrition_logs_from_rows(deduped_meals, meal_items, metrics)

        sleep_logs = db.exec(
            select(SleepLog)
            .where(SleepLog.user_id == user_id)
            .where(SleepLog.night_date >= period_start)
            .where(SleepLog.night_date <= period_end)
        ).all()
        health_rows = db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == user_id)
            .where(DailyHealthSnapshot.snapshot_date >= period_start)
            .where(DailyHealthSnapshot.snapshot_date <= period_end)
        ).all()
        stress_rows = db.exec(
            select(DailyStressSummary)
            .where(DailyStressSummary.user_id == user_id)
            .where(DailyStressSummary.summary_date >= period_start)
            .where(DailyStressSummary.summary_date <= period_end)
        ).all()
        recovery_rows = db.exec(
            select(RecoveryActivity)
            .where(RecoveryActivity.user_id == user_id)
            .where(RecoveryActivity.activity_date >= period_start)
            .where(RecoveryActivity.activity_date <= period_end)
        ).all()
        day_states = db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == user_id)
            .where(UserDayState.day_key >= period_start)
            .where(UserDayState.day_key <= period_end)
        ).all()
        daily_targets = _daily_adjusted_nutrition_targets(
            db,
            user_id,
            period_start,
            period_end,
            plan_days=plan_days,
            day_states=day_states,
            completions=completions,
            health_rows=health_rows,
            resolve_targets_for_user=resolve_targets_for_user,
        )
        nutrition_logs = _with_daily_nutrition_targets(nutrition_logs, daily_targets)
        try:
            targets = daily_targets.get(period_end) or resolve_targets_for_user(db, user_id, as_of=period_end).macros_dict()
        except Exception:
            targets = {}

        checkins = db.exec(
            select(WeeklyCheckIn)
            .where(WeeklyCheckIn.user_id == user_id)
            .where(WeeklyCheckIn.checkin_date >= calibration_start)
            .where(WeeklyCheckIn.checkin_date <= period_end)
        ).all()
        weights = db.exec(
            select(WeightEntry)
            .where(WeightEntry.user_id == user_id)
            .where(WeightEntry.entry_date >= calibration_start)
            .where(WeightEntry.entry_date <= period_end)
            .order_by(WeightEntry.entry_date.asc())
        ).all()
        scans = db.exec(
            select(BodyScan)
            .where(BodyScan.user_id == user_id)
            .where(BodyScan.scan_date >= calibration_start)
            .where(BodyScan.scan_date <= period_end)
            .order_by(BodyScan.scan_date.asc())
        ).all()
        health_body = db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == user_id)
            .where(DailyHealthSnapshot.snapshot_date >= calibration_start)
            .where(DailyHealthSnapshot.snapshot_date <= period_end)
            .where(DailyHealthSnapshot.weight_lbs != None)  # noqa: E711
        ).all()

        body_metrics = _body_metrics_from_rows(weights, scans, checkins, health_body)
        step_logs = [_health_snapshot_to_dict(row) for row in health_rows]
        sleep_input = [_sleep_log_to_dict(row) for row in sleep_logs] + step_logs
        recovery_input = [_generic_row_dict(row) for row in recovery_rows + day_states + stress_rows]
        cardio_logs = [_completion_to_cardio_dict(row) for row in completions] + step_logs

        scores.append(calculate_goal_score({
            "goal": goal,
            "user": _user_context(user, profile, prefs),
            "plan": plan,
            "workouts": [],
            "workoutLogs": workout_logs,
            "nutritionLogs": nutrition_logs,
            "bodyMetrics": body_metrics,
            "sleepLogs": sleep_input,
            "recoveryLogs": recovery_input,
            "stepLogs": step_logs,
            "cardioLogs": cardio_logs,
            "checkIns": [_weekly_checkin_to_dict(row) for row in checkins],
            "dateRange": {"start": period_start, "end": period_end},
            "nutritionTargets": targets,
            "asOfDate": today,
        }))

    return {"scores": scores, "window": window, "asOfDate": today.isoformat()}


def _with_daily_nutrition_targets(
    nutrition_logs: list[dict[str, Any]],
    daily_targets: dict[date, dict[str, Any]],
) -> list[dict[str, Any]]:
    if not daily_targets:
        return nutrition_logs
    out = []
    for row in nutrition_logs:
        d = _as_date(_get(row, "date") or _get(row, "meal_date") or _get(row, "metric_date"))
        target = daily_targets.get(d) if d else None
        if not target:
            out.append(row)
            continue
        merged = dict(row)
        for key in (
            "target_calories",
            "target_protein_g",
            "target_carbs_g",
            "target_fat_g",
            "activity_adjustment_kcal",
        ):
            if target.get(key) is not None:
                merged[key] = target[key]
        out.append(merged)
    return out


def _daily_adjusted_nutrition_targets(
    db: Any,
    user_id: int,
    start: date,
    end: date,
    *,
    plan_days: list[Any],
    day_states: list[Any],
    completions: list[Any],
    health_rows: list[Any],
    resolve_targets_for_user: Any,
) -> dict[date, dict[str, Any]]:
    """Mirror the nutrition target path used by /meals/adjusted-daily-target.

    Execution scoring compares logged calories to the target that actually
    applied that day: resolved macro targets, plan-day carb redistribution,
    coach carb bumps, logged workout add-backs, and Apple Health active-energy
    excess. Weekly smoothing is intentionally not replayed for historical
    days; this score judges execution against the day's own target.
    """
    from app.services.nutrition.activity_adjustment import (
        DEFAULT_PLANNED_WORKOUT_KCAL_ALLOWANCE,
        compute_activity_target_adjustment,
    )
    from app.services.nutrition.carb_distribution import MacroSet, redistribute_for_day
    from app.services.nutrition.weekly_calorie_budget import compute_adjusted_macros

    plan_by_date: dict[date, Any] = {}
    for row in plan_days:
        d = _as_date(_get(row, "day_date") or _get(row, "date"))
        if d is None:
            continue
        existing = plan_by_date.get(d)
        if existing is None or int(_num(_get(row, "id"), 0) or 0) >= int(_num(_get(existing, "id"), 0) or 0):
            plan_by_date[d] = row

    state_by_date = {
        d: row
        for row in day_states
        if (d := _as_date(_get(row, "day_key") or _get(row, "date"))) is not None
    }
    health_by_date = {
        d: row
        for row in health_rows
        if (d := _as_date(_get(row, "snapshot_date") or _get(row, "date"))) is not None
    }
    completions_by_date: dict[date, list[Any]] = {}
    for row in completions:
        d = _as_date(_get(row, "workout_date") or _get(row, "date"))
        if d is not None:
            completions_by_date.setdefault(d, []).append(row)

    out: dict[date, dict[str, Any]] = {}
    for d in _date_span(start, end):
        try:
            resolved = resolve_targets_for_user(
                db,
                user_id,
                as_of=d,
                health_activity_as_of=d - timedelta(days=1),
            )
        except Exception:
            continue
        if not resolved:
            continue

        base = MacroSet(
            calories=int(round(float(getattr(resolved, "calories", 0) or 0))),
            protein_g=int(round(float(getattr(resolved, "protein_g", 0) or 0))),
            carbs_g=int(round(float(getattr(resolved, "carbs_g", 0) or 0))),
            fat_g=int(round(float(getattr(resolved, "fat_g", 0) or 0))),
            fat_floor_g=int(round(float(getattr(resolved, "fat_floor_g", 30) or 30))),
            min_carbs_g=int(round(float(getattr(resolved, "min_carbs_g", 40) or 40))),
        )
        if base.calories <= 0 or base.protein_g <= 0:
            continue

        plan_day = plan_by_date.get(d)
        day_state = state_by_date.get(d)
        skipped = bool(_get(day_state, "skipped_focus")) or _text(_get(plan_day, "status")).lower() == "skipped"
        workout = _get(plan_day, "workout_json") if plan_day is not None else None
        goal_bucket = getattr(resolved, "bucket_name", None)

        if skipped:
            macros, _day_type = redistribute_for_day(
                base,
                focus="Rest",
                activity_category="recovery",
                stimulus="recovery",
                goal_bucket=goal_bucket,
            )
        elif plan_day is not None:
            if isinstance(workout, Mapping) and workout and not bool(_get(plan_day, "is_rest")):
                macros, _day_type = redistribute_for_day(
                    base,
                    archetype=workout.get("archetype"),
                    focus=workout.get("focus") or workout.get("day"),
                    activity_category=workout.get("activity_category"),
                    cardio_style=workout.get("cardio_style"),
                    stimulus=workout.get("stimulus"),
                    goal_bucket=goal_bucket,
                )
            else:
                macros, _day_type = redistribute_for_day(
                    base,
                    focus="Rest",
                    activity_category="recovery",
                    stimulus="recovery",
                    goal_bucket=goal_bucket,
                )
        else:
            macros = base

        overrides = _get(day_state, "macro_overrides")
        if isinstance(overrides, Mapping):
            extra_carbs = int(_num(overrides.get("carb_bump_g"), 0) or 0)
            if extra_carbs > 0:
                macros = MacroSet(
                    calories=macros.calories + extra_carbs * 4,
                    protein_g=macros.protein_g,
                    carbs_g=macros.carbs_g + extra_carbs,
                    fat_g=macros.fat_g,
                    fat_floor_g=macros.fat_floor_g,
                    min_carbs_g=macros.min_carbs_g,
                )

        snapshot = health_by_date.get(d)
        signal = getattr(resolved, "health_signal", None)
        signal_expected = getattr(signal, "expected_active_energy_kcal", None) if signal is not None else None
        expected_active = (
            float(signal_expected)
            if signal_expected is not None
            else float(max(150, int(round(float(getattr(resolved, "tdee", 0) or 0) - (float(getattr(resolved, "bmr", 0) or 0) * 1.2)))))
        )
        same_day_active = None
        same_day_expected = None
        active_energy = _num(_get(snapshot, "active_energy_kcal"), None)
        if active_energy is not None and active_energy > 0:
            same_day_active = active_energy
            same_day_expected = expected_active

        planned_allowance = None
        if (
            plan_day is not None
            and isinstance(workout, Mapping)
            and workout
            and not bool(_get(plan_day, "is_rest"))
            and not skipped
        ):
            planned_allowance = int(round(max(DEFAULT_PLANNED_WORKOUT_KCAL_ALLOWANCE, expected_active)))

        activity_adj = compute_activity_target_adjustment(
            completions_by_date.get(d, []),
            goal_bucket=goal_bucket,
            same_day_active_energy_kcal=same_day_active,
            same_day_expected_active_energy_kcal=same_day_expected,
            planned_workout_kcal_allowance=planned_allowance,
        )
        adjusted_calories = int(round(macros.calories + activity_adj.adjustment_kcal))
        adjusted_macros = compute_adjusted_macros(
            base_protein_g=int(macros.protein_g),
            base_carbs_g=int(macros.carbs_g),
            base_fat_g=int(macros.fat_g),
            adjusted_calories=adjusted_calories,
            base_calories=int(macros.calories),
            carb_bias_pct=float(activity_adj.recommended_carb_bias),
            fat_floor_g=int(macros.fat_floor_g or 30),
            min_carbs_g=int(macros.min_carbs_g or 40),
        )

        out[d] = {
            "calories": adjusted_calories,
            "protein_g": adjusted_macros["protein_g"],
            "carbs_g": adjusted_macros["carbs_g"],
            "fat_g": adjusted_macros["fat_g"],
            "target_calories": adjusted_calories,
            "target_protein_g": adjusted_macros["protein_g"],
            "target_carbs_g": adjusted_macros["carbs_g"],
            "target_fat_g": adjusted_macros["fat_g"],
            "activity_adjustment_kcal": activity_adj.adjustment_kcal,
        }
    return out


# ─── Normalizers and low-level scoring helpers ───────────────────────────────

def _planned_workouts(plan: Any, workouts: list[Any], date_range: tuple[date, date]) -> list[dict[str, Any]]:
    start, end = date_range
    rows: list[Any] = []
    if isinstance(plan, Mapping):
        rows.extend(_ensure_list(plan.get("days") or plan.get("planDays") or plan.get("workouts")))
    elif plan:
        rows.extend(_ensure_list(_get(plan, "days") or _get(plan, "planDays") or _get(plan, "workouts")))
    rows.extend(row for row in workouts if _get(row, "planned") is not False)

    planned = []
    for row in rows:
        d = _as_date(_get(row, "date") or _get(row, "day_date") or _get(row, "workout_date"))
        if not _in_range(d, start, end):
            continue
        if _truthy(_get(row, "is_rest") or _get(row, "isRest")):
            continue
        skip_reason = _text(_get(row, "skip_reason") or _get(row, "skipReason")).lower()
        if _text(_get(row, "status")).lower() == "skipped" and _valid_skip_reason(skip_reason):
            continue
        workout = _get(row, "workout_json") or _get(row, "workout") or row
        if not _exercise_list(workout):
            continue
        planned.append({
            "_id": _get(row, "id") or _get(row, "plan_day_id") or _get(row, "planDayId"),
            "planDayId": _get(row, "plan_day_id") or _get(row, "planDayId") or _get(row, "id"),
            "date": d,
            "focus": _get(workout, "focus") or _get(row, "focus") or _get(row, "focus_label"),
            "exercises": _exercise_list(workout),
            "raw": row,
        })
    planned.sort(key=lambda item: item["date"])
    return planned


def _normalize_workout_log(row: Any) -> dict[str, Any] | None:
    d = _as_date(_get(row, "date") or _get(row, "workout_date") or _get(row, "completed_at") or _get(row, "ended_at"))
    if not d:
        return None
    return {
        "_id": _get(row, "id") or _get(row, "external_source_id") or f"{d}:{_get(row, 'focus') or _get(row, 'focus_label')}",
        "date": d,
        "planDayId": _get(row, "plan_day_id") or _get(row, "planDayId"),
        "focus": _get(row, "focus") or _get(row, "focus_label") or _get(row, "name"),
        "completed": _get(row, "completed", True),
        "durationSeconds": _num(_get(row, "duration_seconds") or _get(row, "durationSeconds"), 0.0),
        "trainingScore": _get(row, "training_score") or _get(row, "trainingScore"),
        "feeling": _get(row, "feeling"),
        "intensity": _get(row, "intensity"),
        "activity_category": _get(row, "activity_category") or _get(row, "activityCategory"),
        "activity_subtype": _get(row, "activity_subtype") or _get(row, "activitySubtype"),
        "activity_intensity": _get(row, "activity_intensity") or _get(row, "activityIntensity"),
        "cardio_style": _get(row, "cardio_style") or _get(row, "cardioStyle"),
        "distance_miles": _get(row, "distance_miles") or _get(row, "distanceMiles"),
        "hr_summary": _get(row, "hr_summary") or _get(row, "hrSummary"),
        "zoneAdherence": _get(row, "zoneAdherence") or _get(row, "zone_adherence"),
        "exercises": _exercise_list(row),
        "raw": row,
    }


def _match_workout_log(planned: dict[str, Any], logs: list[dict[str, Any]], used: set[str]) -> dict[str, Any] | None:
    plan_id = planned.get("planDayId")
    for log in logs:
        if str(log.get("_id") or id(log)) in used:
            continue
        if plan_id is not None and str(log.get("planDayId")) == str(plan_id):
            return log
    planned_date = planned.get("date")
    planned_focus = _norm_name(planned.get("focus"))
    same_day = [
        log for log in logs
        if str(log.get("_id") or id(log)) not in used and log.get("date") == planned_date
    ]
    if not same_day:
        return None
    if planned_focus:
        same_day.sort(key=lambda log: _focus_similarity(planned_focus, _norm_name(log.get("focus"))), reverse=True)
    else:
        same_day.sort(key=lambda log: len(_exercise_list(log)), reverse=True)
    return same_day[0]


def _normalize_exercise(row: Any) -> dict[str, Any]:
    return {
        "name": _get(row, "name") or "",
        "slug": _get(row, "slug") or _get(row, "exercise_slug_snapshot") or _get(row, "exerciseSlug"),
        "sets": _get(row, "sets"),
        "target_sets": _get(row, "target_sets") or _get(row, "targetSets"),
        "reps": _get(row, "reps") or _get(row, "target_reps") or _get(row, "targetReps") or _get(row, "target_reps_text"),
        "target_weight_lbs": _get(row, "target_weight_lbs") or _get(row, "targetWeightLbs"),
        "rir_target": _get(row, "rir_target") or _get(row, "_rir_target") or _get(row, "target_rir") or _get(row, "targetRir"),
        "rpe_target": _get(row, "rpe_target") or _get(row, "target_rpe") or _get(row, "targetRpe"),
        "role": _get(row, "slot_role") or _get(row, "_role") or _get(row, "role"),
        "primary_muscle": _get(row, "primary_muscle") or _get(row, "_primary_muscle") or _get(row, "primaryMuscle"),
        "secondary_muscles": _get(row, "secondary_muscles") or _get(row, "_secondary_muscles") or _get(row, "secondaryMuscles") or [],
        "movement_pattern": _get(row, "movement_pattern") or _get(row, "movementPattern"),
        "exercise_type": _get(row, "exercise_type") or _get(row, "exerciseType"),
        "is_compound": _get(row, "is_compound") or _get(row, "isCompound"),
        "target_zone": _get(row, "target_zone") or _get(row, "targetZone"),
        "duration_seconds": _get(row, "duration_seconds") or _get(row, "durationSeconds"),
        "actual_duration_seconds": _get(row, "actual_duration_seconds") or _get(row, "actualDurationSeconds"),
        "actual_distance": _get(row, "actual_distance") or _get(row, "actualDistance"),
        "sets_detail": _set_list(row),
        "raw": row,
    }


def _match_exercise(planned: dict[str, Any], actuals: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, float]:
    p_name = _norm_name(planned.get("name"))
    p_slug = _norm_name(planned.get("slug"))
    best: tuple[dict[str, Any] | None, float] = (None, 0.0)
    for actual in actuals:
        a_name = _norm_name(actual.get("name"))
        a_slug = _norm_name(actual.get("slug"))
        score = 0.0
        if p_slug and a_slug and p_slug == a_slug:
            score = 100.0
        elif p_name and a_name and p_name == a_name:
            score = 100.0
        elif p_name and a_name and (p_name in a_name or a_name in p_name):
            score = 85.0
        elif _same_movement_family(planned, actual):
            score = 65.0
        if score > best[1]:
            best = (actual, score)
    return best


def _exercise_importance(ex: dict[str, Any], goal_type: str) -> float:
    role = _text(ex.get("role")).lower()
    movement = _text(ex.get("movement_pattern")).lower()
    name = _text(ex.get("name")).lower()
    if role in {"primary", "main", "heavy_top"}:
        return 1.8 if goal_type == "strength" else 1.6
    if ex.get("is_compound") or movement in {"squat", "hinge", "horizontal_press", "vertical_press", "horizontal_pull", "vertical_pull"}:
        return 1.6 if goal_type == "strength" else 1.4
    if any(k in name for k in ("squat", "deadlift", "bench", "press", "pull-up", "pullup", "row")):
        return 1.6 if goal_type == "strength" else 1.4
    if role in {"secondary", "accessory"}:
        return 1.0
    if role in {"isolation", "core", "finisher"}:
        return 0.7 if goal_type in {"fat_loss", "general_consistency"} else 0.8
    return 1.0


def _prescribed_working_sets(ex: dict[str, Any]) -> int:
    raw = ex.get("target_sets") or ex.get("sets")
    if isinstance(raw, list):
        return max(1, len([s for s in raw if not _set_is_warmup(s)]))
    n = _num(raw, None)
    if n is not None and n > 0:
        return int(round(n))
    return 1 if _looks_cardio(ex) else 3


def _rep_completion_score(ex: dict[str, Any], sets: list[Any]) -> float:
    if not sets:
        return 0.0
    target_range = _rep_range(ex.get("reps"))
    if target_range is None:
        target_duration = _duration_target_seconds(ex)
        if target_duration:
            actual = sum(_num(_get(s, "duration_seconds") or _get(s, "durationSeconds"), 0.0) for s in sets)
            return _ratio_score(actual, target_duration * max(1, len(sets)))
        return 75.0
    lo, hi = target_range
    scores = []
    for s in sets:
        reps = _num(_get(s, "actual_reps") or _get(s, "reps") or _get(s, "actualReps"), None)
        if reps is None:
            scores.append(35.0)
        elif lo <= reps <= hi:
            scores.append(100.0)
        elif reps < lo:
            scores.append(_clamp((reps / max(1.0, lo)) * 100.0, 0, 90))
        else:
            over = (reps - hi) / max(1.0, hi)
            scores.append(95.0 if over <= 0.15 else 80.0 if over <= 0.30 else 60.0)
    return _avg(scores, 0.0)


def _intensity_score(ex: dict[str, Any], sets: list[Any], goal_type: str, log: dict[str, Any]) -> float:
    if _looks_cardio(ex) or _looks_cardio(log):
        return _zone_score_for_log(log, ex)
    if not sets:
        return _missing_intensity_score(goal_type)
    target_weight = _num(ex.get("target_weight_lbs"), None)
    load_scores = []
    effort_target_scores = []
    if target_weight and target_weight > 0:
        for s in sets:
            actual = _num(_get(s, "actual_weight_lbs") or _get(s, "weight_lbs") or _get(s, "weightLbs"), None)
            if actual is None:
                continue
            deviation = (actual - target_weight) / target_weight
            if -0.05 <= deviation <= 0.05:
                load_scores.append(100.0)
            elif deviation < -0.05:
                load_scores.append(_clamp(100.0 + deviation * 220.0, 35.0, 90.0))
            else:
                load_scores.append(_clamp(95.0 - max(0.0, deviation - 0.05) * 120.0, 55.0, 95.0))
    target_rir = _num(ex.get("rir_target"), None)
    target_rpe = _num(ex.get("rpe_target"), None)
    if target_rir is not None:
        for s in sets:
            actual = _num(_get(s, "actual_rir") or _get(s, "rir") or _get(s, "actualRir"), None)
            if actual is not None:
                effort_target_scores.append(_closeness_score(actual, target_rir, full=1.0, poor=3.0))
    if target_rpe is not None:
        for s in sets:
            actual = _num(_get(s, "rpe"), None)
            if actual is not None:
                effort_target_scores.append(_closeness_score(actual, target_rpe, full=1.0, poor=3.0))
    if load_scores and effort_target_scores:
        load = _avg(load_scores, _missing_intensity_score(goal_type))
        effort_target = _avg(effort_target_scores, 70.0)
        if goal_type == "strength":
            return load * 0.75 + effort_target * 0.25
        if goal_type == "muscle_gain":
            return load * 0.55 + effort_target * 0.45
        return load * 0.45 + effort_target * 0.55
    if load_scores:
        return _avg(load_scores, _missing_intensity_score(goal_type))
    if effort_target_scores:
        return _avg(effort_target_scores, _missing_intensity_score(goal_type))
    return _missing_intensity_score(goal_type)


def _effort_score(ex: dict[str, Any], sets: list[Any], log: dict[str, Any]) -> tuple[float, bool]:
    scores = []
    target_rir = _num(ex.get("rir_target"), None)
    for s in sets:
        actual_rir = _num(_get(s, "actual_rir") or _get(s, "rir") or _get(s, "actualRir"), None)
        rpe = _num(_get(s, "rpe"), None)
        if actual_rir is not None:
            if target_rir is not None:
                scores.append(_closeness_score(actual_rir, target_rir, full=1.0, poor=3.0))
            elif 0 <= actual_rir <= 4:
                scores.append(95.0 if 1 <= actual_rir <= 3 else 75.0)
        elif rpe is not None:
            scores.append(95.0 if 6 <= rpe <= 9 else 70.0 if rpe <= 10 else 40.0)
    feeling = _text(log.get("feeling")).lower()
    if feeling in {"great", "good"}:
        scores.append(90.0)
    elif feeling in {"okay", "ok"}:
        scores.append(75.0)
    elif feeling in {"rough", "bad"}:
        scores.append(55.0)
    intensity = _num(log.get("intensity"), None)
    if intensity is not None:
        scores.append(90.0 if 3 <= intensity <= 4 else 70.0 if intensity == 2 else 50.0)
    pain_note = any("pain" in _text(_get(s, "notes") or _get(s, "feedback")).lower() for s in sets)
    if pain_note:
        scores.append(35.0)
    if not scores:
        return 70.0, True
    return _avg(scores, 70.0), False


def _progression_score(ex: dict[str, Any], sets: list[Any], log: dict[str, Any], goal_type: str) -> float:
    raw = _get(log, "progressionAchieved") or _get(log, "progression_achieved") or _get(ex.get("raw"), "progressionAchieved")
    if raw is True:
        return 100.0
    if raw is False:
        return 45.0
    if goal_type in {"fat_loss", "general_consistency"}:
        return 80.0 if sets else 0.0
    reps = [_num(_get(s, "actual_reps") or _get(s, "reps"), None) for s in sets]
    weights = [_num(_get(s, "actual_weight_lbs") or _get(s, "weight_lbs") or _get(s, "weightLbs"), None) for s in sets]
    if any(w and w > 0 for w in weights) and any(r and r > 0 for r in reps):
        return 80.0
    return 65.0 if sets else 0.0


def _zone_score_for_log(log: Any, planned: Any) -> float:
    explicit = _num(_get(log, "zoneAdherence") or _get(log, "zone_adherence"), None)
    if explicit is not None:
        return _clamp(explicit, 0, 100)
    hr = _get(log, "hr_summary") or _get(log, "hrSummary") or {}
    details = _get(log, "activity_details") or _get(log, "activityDetails") or {}
    zone_minutes = _get(hr, "zoneMinutes") or _get(details, "zoneMinutes") or _get(log, "zone_minutes") or {}
    if isinstance(zone_minutes, Mapping):
        total = sum(_num(v, 0.0) for v in zone_minutes.values())
        if total > 0:
            target = _text(_get(planned, "target_zone") or _get(planned, "targetZone") or _get(log, "target_zone") or _get(log, "targetZone")).lower()
            if "2" in target or "zone2" in target:
                z2 = _num(zone_minutes.get("2") or zone_minutes.get("zone2") or zone_minutes.get("z2"), 0.0)
                return _ratio_score(z2, total * 0.75)
            hard = sum(_num(zone_minutes.get(k), 0.0) for k in ("3", "4", "5", "zone3", "zone4", "zone5", "z3", "z4", "z5"))
            if target and any(k in target for k in ("interval", "hiit", "hard", "tempo", "threshold")):
                return _ratio_score(hard, total * 0.45)
    return 70.0 if _looks_cardio(log) or _looks_cardio(planned) else _missing_intensity_score("general_consistency")


def _daily_nutrition_by_date(nutrition_logs: list[Any], date_range: tuple[date, date]) -> dict[date, dict[str, Any]]:
    start, end = date_range
    grouped: dict[date, dict[str, Any]] = {}
    for row in nutrition_logs:
        d = _as_date(_get(row, "date") or _get(row, "meal_date") or _get(row, "metric_date"))
        if not _in_range(d, start, end):
            continue
        calories = _num(_get(row, "calories") or _get(row, "calories_total") or _get(row, "kcal"), 0.0)
        if calories < 0 or calories > 9000:
            continue
        g = grouped.setdefault(d, {"date": d, "meals_logged": 0})
        for key, aliases in {
            "calories": ("calories", "calories_total", "kcal"),
            "protein_g": ("protein_g", "protein"),
            "carbs_g": ("carbs_g", "carbs"),
            "fat_g": ("fat_g", "fat"),
            "fiber_g": ("fiber_g", "fiber_total_g", "fiber"),
            "added_sugar_g": ("added_sugar_g", "addedSugarG"),
            "saturated_fat_g": ("saturated_fat_g", "sat_fat_g"),
            "sodium_mg": ("sodium_mg",),
            "hydration_oz": ("hydration_oz", "water_oz"),
            "alcohol_drinks": ("alcohol_drinks",),
            "meals_logged": ("meals_logged", "meal_count"),
        }.items():
            value = None
            for alias in aliases:
                if _get(row, alias) is not None:
                    value = _num(_get(row, alias), 0.0)
                    break
            if value is not None:
                if key == "meals_logged":
                    g[key] = max(_num(g.get(key), 0.0), value)
                else:
                    g[key] = _num(g.get(key), 0.0) + value
        for key in ("target_calories", "target_protein_g", "target_carbs_g", "expected_meals", "logging_completeness", "pre_workout_logged", "post_workout_logged"):
            if _get(row, key) is not None:
                g[key] = _get(row, key)
    return grouped


def _protein_score(actual: float, target: float) -> float:
    if target <= 0:
        return 55.0 if actual <= 0 else 75.0
    return _clamp((actual / target) * 100.0, 0.0, 100.0)


def _food_quality_score(row: dict[str, Any], calories: float) -> float:
    scores = []
    fiber = _num(row.get("fiber_g"), None)
    if fiber is not None and calories > 0:
        scores.append(_ratio_score((fiber / calories) * 1000.0, 14.0))
    added = _num(row.get("added_sugar_g"), None)
    if added is not None and calories > 0:
        pct = added * 4.0 / calories * 100.0
        scores.append(100.0 if pct <= 5 else 80.0 if pct <= 10 else 55.0 if pct <= 15 else 30.0)
    sat = _num(row.get("saturated_fat_g"), None)
    if sat is not None and calories > 0:
        pct = sat * 9.0 / calories * 100.0
        scores.append(100.0 if pct <= 7 else 85.0 if pct <= 10 else 60.0 if pct <= 14 else 35.0)
    alcohol = _num(row.get("alcohol_drinks"), None)
    if alcohol is not None:
        scores.append(100.0 if alcohol <= 0 else 75.0 if alcohol <= 1 else 45.0)
    if not scores:
        return 70.0
    return _avg(scores, 70.0)


def _hydration_score(row: dict[str, Any]) -> float:
    oz = _num(row.get("hydration_oz"), None)
    if oz is not None:
        return 100.0 if oz >= 64 else _ratio_score(oz, 64.0)
    alcohol = _num(row.get("alcohol_drinks"), None)
    if alcohol is not None:
        return 100.0 if alcohol <= 0 else 75.0 if alcohol <= 1 else 45.0
    return 70.0


def _sleep_duration_score(hours: float) -> float:
    if 7.0 <= hours <= 9.0:
        return 100.0
    if 6.5 <= hours < 7.0:
        return 85.0
    if 6.0 <= hours < 6.5:
        return 70.0
    if 5.0 <= hours < 6.0:
        return 50.0
    if hours < 5.0:
        return 25.0
    if hours <= 9.5:
        return 90.0
    if hours <= 10.5:
        return 78.0
    return 60.0


def _sleep_consistency_score(values: list[float]) -> float:
    if len(values) < 3:
        return 70.0
    sd = pstdev(values)
    # Bedtime wraps around midnight; this still works for the common case.
    if sd <= 45:
        return 100.0
    if sd <= 75:
        return 85.0
    if sd <= 120:
        return 65.0
    return 45.0


def _target_change(goal: Any, goal_type: str, user: Any) -> tuple[str, str, float, int]:
    timeframe_days = int(_num(_get(goal, "timeframe_days") or _get(goal, "timeframeDays"), 0) or (_num(_get(goal, "timeline_weeks") or _get(goal, "timelineWeeks"), 6) * 7))
    timeframe_days = max(7, timeframe_days)
    metric = _text(_get(goal, "target_metric") or _get(goal, "targetMetric")).lower()
    explicit_change = _num(_get(goal, "target_change") or _get(goal, "targetChange"), None)
    if explicit_change is not None:
        if "body" in metric and "fat" in metric:
            return "body_fat_pct", "percentage_points", explicit_change, timeframe_days
        unit = _text(_get(goal, "unit") or _get(goal, "target_unit") or _get(goal, "targetUnit")) or _default_unit(goal_type)
        return metric or _default_metric(goal_type), unit, explicit_change, timeframe_days

    target_weight = _num(_get(goal, "target_weight_lbs") or _get(goal, "targetWeightLbs"), None)
    start_weight = _num(_get(goal, "start_weight_lbs") or _get(goal, "startWeightLbs") or _get(user, "weight_lbs") or _get(user, "weightLbs"), None)
    if target_weight is not None and start_weight is not None and target_weight > 0:
        return "weight_lbs", "lb", target_weight - start_weight, timeframe_days

    start_bf = _num(_get(goal, "start_body_fat_pct") or _get(goal, "startBodyFatPct"), None)
    target_bf = _num(_get(goal, "target_body_fat_pct") or _get(goal, "targetBodyFatPct"), None)
    if start_bf is not None and target_bf is not None:
        return "body_fat_pct", "percentage_points", target_bf - start_bf, timeframe_days

    if goal_type in {"fat_loss", "body_recomp"}:
        return "body_fat_pct", "percentage_points", -1.8, timeframe_days
    if goal_type == "muscle_gain":
        return "weight_lbs", "lb", 2.5, timeframe_days
    if goal_type == "strength":
        return "estimated_1rm_pct", "percent", 3.5, timeframe_days
    if goal_type == "endurance":
        return "cardio_volume_min", "minutes", 150.0, timeframe_days
    return "consistency", "percent", 100.0, timeframe_days


def _body_fat_progress(rows: list[Any], goal: Any) -> tuple[float | None, str, float, float, int]:
    bf_rows = []
    for row in rows:
        bf = _num(_get(row, "body_fat_pct") or _get(row, "bodyFatPct"), None)
        d = _metric_date(row)
        if bf is not None and d is not None and 3 <= bf <= 70:
            bf_rows.append((d, bf, _text(_get(row, "method") or _get(row, "source") or _get(row, "confidence"))))
    bf_rows.sort(key=lambda item: item[0])
    if len(bf_rows) < 2:
        return None, "body-fat readings", _measurement_reliability(rows), 35.0, len(bf_rows)
    start = _num(_get(goal, "start_body_fat_pct") or _get(goal, "startBodyFatPct"), None)
    if start is None:
        start = mean(v for _, v, _ in bf_rows[:min(3, len(bf_rows))])
    recent = mean(v for _, v, _ in bf_rows[-min(3, len(bf_rows)):])
    values = [v for _, v, _ in bf_rows]
    sd = pstdev(values) if len(values) > 1 else 0.0
    source = "smart_scale_body_fat" if any("smart" in src or "scale" in src for _, _, src in bf_rows) else "body_fat_measurement"
    reliability = 45.0 if source == "smart_scale_body_fat" else _measurement_reliability(rows)
    signal = _clamp(90.0 - sd * 18.0, 25.0, 90.0)
    if source == "smart_scale_body_fat":
        signal = min(signal, 55.0)
    return recent - start, source, reliability, signal, len(bf_rows)


def _weight_progress(rows: list[Any], goal: Any, *, as_body_fat_proxy: bool = False) -> tuple[float | None, str, float, float, int]:
    weight_rows = []
    for row in rows:
        wt = _num(_get(row, "weight_lbs") or _get(row, "weightLbs"), None)
        d = _metric_date(row)
        if wt is not None and d is not None and 50 <= wt <= 700:
            weight_rows.append((d, wt))
    weight_rows.sort(key=lambda item: item[0])
    if len(weight_rows) < 2:
        return None, "scale trend", 60.0, 35.0, len(weight_rows)
    start = _num(_get(goal, "start_weight_lbs") or _get(goal, "startWeightLbs"), None)
    if start is None:
        start = mean(v for _, v in weight_rows[:min(3, len(weight_rows))])
    recent = mean(v for _, v in weight_rows[-min(3, len(weight_rows)):])
    values = [v for _, v in weight_rows]
    sd = pstdev(values) if len(values) > 1 else 0.0
    reliability = 70.0
    signal = _clamp(85.0 - (sd / max(1.0, mean(values))) * 600.0, 35.0, 85.0)
    progress = recent - start
    if as_body_fat_proxy and start > 0:
        progress = (progress / start) * 100.0
        reliability = 60.0
    return progress, "scale trend", reliability, signal, len(weight_rows)


def _strength_progress(workout_logs: list[Any]) -> tuple[float | None, str, float, float, int]:
    e1rms = []
    for row in workout_logs:
        d = _as_date(_get(row, "date") or _get(row, "workout_date") or _get(row, "completed_at"))
        for ex in _exercise_list(row):
            for s in _set_list(ex):
                reps = _num(_get(s, "actual_reps") or _get(s, "reps"), None)
                wt = _num(_get(s, "actual_weight_lbs") or _get(s, "weight_lbs") or _get(s, "weightLbs"), None)
                rir = _num(_get(s, "actual_rir") or _get(s, "rir"), 0.0)
                if d and reps and wt and wt > 0:
                    e1rms.append((d, wt * (1.0 + (reps + max(0.0, rir)) / 30.0)))
    e1rms.sort(key=lambda item: item[0])
    if len(e1rms) < 4:
        return None, "estimated 1RM trend", 65.0, 45.0, len(e1rms)
    first = mean(v for _, v in e1rms[:min(4, len(e1rms))])
    last = mean(v for _, v in e1rms[-min(4, len(e1rms)):])
    return ((last - first) / max(1.0, first)) * 100.0, "estimated 1RM trend", 75.0, 70.0, len(e1rms)


def _endurance_progress(rows: list[Any]) -> tuple[float | None, str, float, float, int]:
    dated = []
    for row in rows:
        d = _as_date(_get(row, "date") or _get(row, "workout_date") or _get(row, "completed_at"))
        minutes = _cardio_minutes(row)
        if d and minutes > 0:
            dated.append((d, minutes))
    dated.sort(key=lambda item: item[0])
    if len(dated) < 3:
        return None, "cardio volume trend", 60.0, 45.0, len(dated)
    midpoint = len(dated) // 2
    first = sum(v for _, v in dated[:midpoint])
    last = sum(v for _, v in dated[midpoint:])
    return last - first, "cardio volume trend", 70.0, 70.0, len(dated)


def _raw_response_factor(projection: ProjectionInputs) -> float | None:
    if projection.actual_progress is None or projection.expected_progress_to_date in (None, 0):
        return None
    expected = projection.expected_progress_to_date
    actual = projection.actual_progress
    if abs(expected) < 0.001:
        return None
    return actual / expected


def _measurement_reliability(rows: list[Any]) -> float:
    if not rows:
        return 40.0
    best = 45.0
    for row in rows:
        source = _text(_get(row, "method") or _get(row, "source") or _get(row, "confidence")).lower()
        if "dexa" in source:
            best = max(best, 95.0)
        elif "caliper" in source or "coach" in source:
            best = max(best, 80.0)
        elif "waist" in source or "manual" in source:
            best = max(best, 70.0)
        elif "scale" in source or "smart" in source:
            best = max(best, 45.0)
        elif "visual" in source or "scan" in source:
            best = max(best, 50.0)
    if len(rows) < 2:
        best = min(best, 55.0)
    return best


def _projection_display_text(metric: str, unit: str, midpoint: float, low: float, high: float, days: int, confidence: int) -> str:
    prefix = "Low-confidence estimate: " if confidence < 40 else "You're currently on pace for "
    if unit == "percentage_points":
        return f"{prefix}about {_fmt_signed(midpoint)} body-fat percentage points over {days} days. Expected range: {_fmt_signed(low)} to {_fmt_signed(high)} percentage points."
    if unit == "lb":
        return f"{prefix}about {_fmt_signed(midpoint)} lb over {days} days. Expected range: {_fmt_signed(low)} to {_fmt_signed(high)} lb."
    if metric == "estimated_1rm_pct":
        return f"{prefix}about {_fmt_signed(midpoint)}% strength-marker change over {days} days. Expected range: {_fmt_signed(low)}% to {_fmt_signed(high)}%."
    if metric == "cardio_volume_min":
        return f"{prefix}about {_fmt_signed(midpoint)} cardio minutes over {days} days. Expected range: {_fmt_signed(low)} to {_fmt_signed(high)} minutes."
    return f"{prefix}about {midpoint:.1f} {unit} over {days} days. Expected range: {low:.1f} to {high:.1f}."


def _score_label(score: int) -> str:
    if score >= 90:
        return "Excellent"
    if score >= 80:
        return "Strong"
    if score >= 70:
        return "Good"
    if score >= 50:
        return "Needs work"
    return "Poor"


def _confidence_label(score: int) -> str:
    if score >= 80:
        return "High"
    if score >= 60:
        return "Moderate"
    if score >= 40:
        return "Low"
    return "Very low"


def _limiter_severity(score: float, missing: list[str]) -> str:
    if score < 50:
        return "high"
    if score < 70 or missing:
        return "medium"
    if score < 85:
        return "low"
    return "none"


def _limiter_reason(item: dict[str, Any]) -> str:
    if item.get("missingData"):
        return f"{item['driverName']} is limited by missing data. {item['actualSummary']}"
    return f"{item['driverName']} scored {item['score']}/100. {item['actualSummary']}"


def _suggested_fix(driver_id: str, actual: str) -> str:
    if driver_id in {"calories", "calorieConsistency", "calorieSurplusConsistency"}:
        return "Hit the calorie target range on at least 5 of the next 7 days."
    if driver_id in {"protein", "nutritionSupport", "fuelingHydration"}:
        return "Log protein daily and reach the protein target on the next 7 days."
    if driver_id in {"trainingQuality", "strengthTrainingQuality", "keyLiftCompletion", "plannedWorkoutCompletion"}:
        return "Complete the prescribed key exercises and working sets in the next two planned sessions."
    if driver_id in {"intensityLoadAdherence", "progressiveOverload"}:
        return "Use the prescribed load/RPE target on the main lifts this week."
    if driver_id in {"weeklyVolume", "keySessionCompletion", "zoneIntensityAdherence", "stepsOrCardio", "dailyMovement"}:
        return "Keep daily steps/cardio inside the prescribed target for the next week."
    if driver_id in {"sleepRecovery", "recoveryReadiness", "recovery"}:
        return "Raise average sleep toward at least 6.75 hours this week."
    if driver_id in {"loggingCompleteness", "measurementConsistency", "checkInCompleteness"}:
        return "Fill the missing logs so the next projection has a stronger signal."
    return "Focus on this driver for the next 7 days."


def _action_for_driver(driver_id: str | None, factor: dict[str, str]) -> tuple[str, str]:
    if driver_id in {"calories", "calorieConsistency", "calorieSurplusConsistency"}:
        return "Hit calories 5 of 7 days", "Keep logged calories inside the target range on at least five of the next seven days."
    if driver_id in {"protein", "nutritionSupport", "fuelingHydration"}:
        return "Log protein daily", "Log protein every day this week and aim for the daily target before dinner."
    if driver_id in {"trainingQuality", "strengthTrainingQuality", "keyLiftCompletion", "plannedWorkoutCompletion"}:
        return "Finish prescribed working sets", "Complete all working sets for the main lifts in the next two planned workouts."
    if driver_id in {"intensityLoadAdherence", "progressiveOverload"}:
        return "Match main-lift intensity", "Use the prescribed load, RPE, or RIR target on the key lift in your next session."
    if driver_id in {"weeklyVolume", "keySessionCompletion", "zoneIntensityAdherence", "stepsOrCardio", "dailyMovement"}:
        return "Nail movement targets", "Keep steps/cardio aligned with the plan for the next seven days."
    if driver_id in {"sleepRecovery", "recoveryReadiness", "recovery"}:
        return "Raise sleep floor", "Push average sleep to at least 6.75 hours over the next week."
    return "Improve data completeness", factor.get("suggestedFix") or "Complete the missing logs this week."


# ─── Row serialization helpers for the DB adapter ───────────────────────────

def _plan_day_to_dict(row: Any) -> dict[str, Any]:
    return {
        "id": _get(row, "id"),
        "plan_day_id": _get(row, "id"),
        "date": _get(row, "day_date"),
        "day_date": _get(row, "day_date"),
        "status": _get(row, "status"),
        "is_rest": _get(row, "is_rest"),
        "skip_reason": _get(row, "skip_reason"),
        "workout_json": _get(row, "workout_json"),
    }


def _workout_logs_from_rows(completions: list[Any], sessions: list[Any], exercises: list[Any], sets: list[Any]) -> list[dict[str, Any]]:
    exercises_by_session: dict[Any, list[Any]] = {}
    for ex in exercises:
        exercises_by_session.setdefault(_get(ex, "session_id"), []).append(ex)
    sets_by_exercise: dict[Any, list[Any]] = {}
    for s in sets:
        sets_by_exercise.setdefault(_get(s, "workout_exercise_id"), []).append(s)

    session_logs = []
    for session in sessions:
        ex_payload = []
        for ex in sorted(exercises_by_session.get(_get(session, "id"), []), key=lambda row: _get(row, "order_index") or 0):
            ex_payload.append({
                "name": _get(ex, "name"),
                "slug": _get(ex, "exercise_slug_snapshot"),
                "target_reps": _get(ex, "target_reps_text"),
                "primary_muscle": _get(ex, "primary_muscle_snapshot"),
                "secondary_muscles": _get(ex, "secondary_muscles_snapshot") or [],
                "is_compound": _get(ex, "is_compound_snapshot"),
                "movement_pattern": _get(ex, "movement_pattern_snapshot"),
                "exercise_type": "cardio" if _text(_get(ex, "movement_pattern_snapshot")).lower() == "cardio" else "strength",
                "sets": [_set_row_to_dict(s) for s in sorted(sets_by_exercise.get(_get(ex, "id"), []), key=lambda row: _get(row, "set_number") or 0)],
            })
        session_logs.append({
            "id": f"session:{_get(session, 'id')}",
            "date": _get(session, "workout_date"),
            "focus": _get(session, "focus"),
            "completed": _get(session, "completed_at") is not None,
            "exercises": ex_payload,
        })

    logs = []
    for completion in completions:
        cdate = _get(completion, "workout_date")
        matching_session = next((s for s in session_logs if s["date"] == cdate and _focus_similarity(_norm_name(s.get("focus")), _norm_name(_get(completion, "focus_label"))) > 0), None)
        logs.append({
            "id": _get(completion, "id"),
            "date": cdate,
            "plan_day_id": _get(completion, "plan_day_id"),
            "focus": _get(completion, "focus_label"),
            "completed": True,
            "duration_seconds": _get(completion, "duration_seconds"),
            "training_score": _get(completion, "training_score"),
            "feeling": _get(completion, "feeling"),
            "intensity": _get(completion, "intensity"),
            "activity_category": _get(completion, "activity_category"),
            "activity_subtype": _get(completion, "activity_subtype"),
            "activity_intensity": _get(completion, "activity_intensity"),
            "cardio_style": _get(completion, "cardio_style"),
            "distance_miles": _get(completion, "distance_miles"),
            "hr_summary": _get(completion, "hr_summary"),
            "activity_details": _get(completion, "activity_details"),
            "exercises": matching_session["exercises"] if matching_session else [],
        })
    return logs or session_logs


def _set_row_to_dict(row: Any) -> dict[str, Any]:
    return {
        "set_number": _get(row, "set_number"),
        "target_reps_min": _get(row, "target_reps_min"),
        "target_reps_max": _get(row, "target_reps_max"),
        "target_weight_lbs": _get(row, "target_weight_lbs"),
        "set_type": _get(row, "set_type"),
        "rpe_target": _get(row, "rpe_target"),
        "rir_target": _get(row, "rir_target"),
        "actual_reps": _get(row, "actual_reps"),
        "actual_weight_lbs": _get(row, "actual_weight_lbs"),
        "rpe": _get(row, "rpe"),
        "actual_rir": _get(row, "actual_rir"),
        "completed": _get(row, "completed"),
        "duration_seconds": _get(row, "duration_seconds"),
        "actual_distance": _get(row, "actual_distance"),
        "heart_rate_avg": _get(row, "heart_rate_avg"),
        "cardio_metrics": _get(row, "cardio_metrics"),
        "notes": _get(row, "notes"),
    }


def _nutrition_logs_from_rows(meals: list[Any], items: list[Any], metrics: list[Any]) -> list[dict[str, Any]]:
    meal_ids = {m.id for m in meals if _get(m, "id") is not None}
    by_date: dict[date, dict[str, Any]] = {}
    for meal in meals:
        d = _get(meal, "meal_date")
        row = by_date.setdefault(d, {"date": d, "meals_logged": 0})
        row["meals_logged"] += 1
    for item in items:
        if _get(item, "meal_id") not in meal_ids:
            continue
        meal = next((m for m in meals if _get(m, "id") == _get(item, "meal_id")), None)
        if not meal:
            continue
        d = _get(meal, "meal_date")
        row = by_date.setdefault(d, {"date": d, "meals_logged": 0})
        for key, attr in (
            ("calories", "calories"),
            ("protein_g", "protein_g"),
            ("carbs_g", "carbs_g"),
            ("fat_g", "fat_g"),
            ("fiber_g", "fiber_g"),
            ("added_sugar_g", "added_sugar_g"),
            ("saturated_fat_g", "saturated_fat_g"),
            ("sodium_mg", "sodium_mg"),
        ):
            row[key] = _num(row.get(key), 0.0) + _num(_get(item, attr), 0.0)
    for metric in metrics:
        d = _get(metric, "metric_date")
        row = by_date.setdefault(d, {"date": d, "meals_logged": 0})
        for key, attr in (
            ("fiber_g", "fiber_total_g"),
            ("added_sugar_g", "added_sugar_g"),
            ("saturated_fat_g", "saturated_fat_g"),
            ("sodium_mg", "sodium_mg"),
        ):
            val = _num(_get(metric, attr), None)
            if val is not None and val > 0:
                row[key] = val
    return list(by_date.values())


def _sleep_log_to_dict(row: Any) -> dict[str, Any]:
    return {
        "date": _get(row, "night_date"),
        "night_date": _get(row, "night_date"),
        "total_hours": _get(row, "total_hours"),
        "hrv_ms": _get(row, "hrv_ms"),
        "resting_hr": _get(row, "resting_hr"),
        "bedtime_minutes_from_midnight": _get(row, "bedtime_minutes_from_midnight"),
        "score": _get(row, "score"),
        "source": _get(row, "source"),
    }


def _health_snapshot_to_dict(row: Any) -> dict[str, Any]:
    return {
        "date": _get(row, "snapshot_date"),
        "snapshot_date": _get(row, "snapshot_date"),
        "steps": _get(row, "steps"),
        "cardio_minutes": _get(row, "cardio_minutes"),
        "zone2_minutes": _get(row, "zone2_minutes"),
        "readiness_score": _get(row, "readiness_score"),
        "total_hours": None,
        "weight_lbs": _get(row, "weight_lbs"),
        "source": _get(row, "source"),
    }


def _body_metrics_from_rows(weights: list[Any], scans: list[Any], checkins: list[Any], health_rows: list[Any]) -> list[dict[str, Any]]:
    rows = []
    for row in weights:
        rows.append({"date": _get(row, "entry_date"), "weight_lbs": _get(row, "weight_lbs"), "source": _get(row, "source") or "manual_scale"})
    for row in scans:
        rows.append({
            "date": _get(row, "scan_date"),
            "weight_lbs": _get(row, "weight_lbs"),
            "body_fat_pct": _get(row, "body_fat_pct"),
            "method": _get(row, "method") or "body_scan",
            "confidence": _get(row, "confidence"),
        })
    for row in checkins:
        rows.append({
            "date": _get(row, "checkin_date"),
            "weight_lbs": _get(row, "weight_lbs"),
            "body_fat_pct": _get(row, "body_fat_pct"),
            "waist_in": _get(row, "waist_in"),
            "source": "weekly_checkin",
        })
    for row in health_rows:
        rows.append({"date": _get(row, "snapshot_date"), "weight_lbs": _get(row, "weight_lbs"), "source": _get(row, "source") or "apple_health"})
    return rows


def _completion_to_cardio_dict(row: Any) -> dict[str, Any]:
    return {
        "date": _get(row, "workout_date"),
        "activity_category": _get(row, "activity_category"),
        "activity_subtype": _get(row, "activity_subtype"),
        "activity_intensity": _get(row, "activity_intensity"),
        "cardio_style": _get(row, "cardio_style"),
        "duration_seconds": _get(row, "duration_seconds"),
        "distance_miles": _get(row, "distance_miles"),
        "hr_summary": _get(row, "hr_summary"),
        "activity_details": _get(row, "activity_details"),
    }


def _weekly_checkin_to_dict(row: Any) -> dict[str, Any]:
    return {
        "date": _get(row, "checkin_date"),
        "checkin_date": _get(row, "checkin_date"),
        "weight_lbs": _get(row, "weight_lbs"),
        "waist_in": _get(row, "waist_in"),
        "body_fat_pct": _get(row, "body_fat_pct"),
        "energy": _get(row, "energy"),
        "sleep": _get(row, "sleep"),
        "adherence": _get(row, "adherence"),
    }


def _user_context(user: Any, profile: Any, prefs: Any) -> dict[str, Any]:
    return {
        "id": _get(user, "id"),
        "weight_lbs": _get(profile, "weight_lbs"),
        "target_steps": _get(prefs, "target_steps") or None,
        "days_per_week": _get(prefs, "days_per_week") or 3,
    }


def _generic_row_dict(row: Any) -> dict[str, Any]:
    if isinstance(row, Mapping):
        return dict(row)
    keys = [
        "date", "activity_date", "day_key", "summary_date", "avg_stress",
        "modality", "duration_min", "pain_present", "pain_severity_0_10",
        "soreness_severity_0_10", "energy", "soreness", "readiness_score",
    ]
    return {key: _get(row, key) for key in keys if _get(row, key) is not None}


# ─── Generic helpers ────────────────────────────────────────────────────────

def _get(obj: Any, key: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, Mapping):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _id_for(goal: Any) -> Any:
    return _get(goal, "id") or _get(goal, "goalId") or _get(goal, "goal_id") or _goal_type(goal)


def _as_date(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    text = str(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None


def _metric_date(row: Any) -> date | None:
    return _as_date(_get(row, "date") or _get(row, "entry_date") or _get(row, "scan_date") or _get(row, "checkin_date") or _get(row, "snapshot_date"))


def _in_range(d: date | None, start: date, end: date) -> bool:
    return d is not None and start <= d <= end


def _date_span(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _ensure_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _num(value: Any, default: float | None = 0.0) -> float | None:
    try:
        if value is None:
            return default
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        parsed = float(value)
        if math.isnan(parsed) or math.isinf(parsed):
            return default
        return parsed
    except (TypeError, ValueError):
        return default


def _text(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "value"):
        return str(value.value)
    return str(value)


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y"}
    return bool(value)


def _clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def _round_score(value: float) -> int:
    return int(round(_clamp(value, 0, 100)))


def _round1(value: float) -> float:
    return round(value * 10.0) / 10.0


def _avg(values: list[float | None], default: float) -> float:
    clean = [float(v) for v in values if v is not None]
    return sum(clean) / len(clean) if clean else default


def _weighted_avg(values: list[tuple[float, float]], default: float) -> float:
    total_weight = sum(w for _, w in values if w > 0)
    if total_weight <= 0:
        return default
    return sum(v * w for v, w in values if w > 0) / total_weight


def _ratio_score(actual: float, target: float) -> float:
    if target <= 0:
        return 0.0
    return _clamp((actual / target) * 100.0, 0.0, 100.0)


def _closeness_score(actual: float, target: float, *, full: float, poor: float) -> float:
    diff = abs(actual - target)
    if diff <= full:
        return 100.0
    if diff >= poor:
        return 45.0
    return 100.0 - ((diff - full) / (poor - full)) * 55.0


def _norm_name(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _text(value).lower()).strip()


def _focus_similarity(a: str, b: str) -> int:
    if not a or not b:
        return 0
    if a == b:
        return 3
    a_tokens = set(a.split())
    b_tokens = set(b.split())
    return len(a_tokens & b_tokens)


def _exercise_list(obj: Any) -> list[Any]:
    exercises = _get(obj, "exercises")
    if exercises is None:
        workout = _get(obj, "workout") or _get(obj, "workout_json")
        exercises = _get(workout, "exercises") if workout is not None else None
    return _ensure_list(exercises) if exercises else []


def _set_list(ex: Any) -> list[Any]:
    for key in ("sets", "sets_detail", "setLogs"):
        value = _get(ex, key)
        if isinstance(value, list):
            return value
    return []


def _set_completed(s: Any) -> bool:
    raw = _get(s, "completed")
    if raw is None:
        return any(_get(s, key) is not None for key in ("actual_reps", "actual_weight_lbs", "reps", "weight_lbs", "duration_seconds", "actual_distance"))
    return bool(raw)


def _set_is_warmup(s: Any) -> bool:
    return _text(_get(s, "set_type") or _get(s, "setType")).lower().replace("-", "_") in {"warmup", "warm_up"}


def _is_warmup(ex: Any) -> bool:
    return _text(_get(ex, "slot_role") or _get(ex, "_role") or _get(ex, "role")).lower() == "warmup"


def _looks_cardio(row: Any) -> bool:
    haystack = " ".join([
        _text(_get(row, "activity_category")),
        _text(_get(row, "activity_subtype")),
        _text(_get(row, "cardio_style")),
        _text(_get(row, "exercise_type")),
        _text(_get(row, "movement_pattern")),
        _text(_get(row, "primary_muscle")),
        _text(_get(row, "focus")),
        _text(_get(row, "name")),
    ]).lower()
    return any(k in haystack for k in ("cardio", "run", "bike", "cycle", "row", "swim", "zone", "hiit", "conditioning", "treadmill", "elliptical"))


def _session_has_cardio(row: Any) -> bool:
    return _looks_cardio(row) or any(_looks_cardio(ex) for ex in _exercise_list(row))


def _cardio_minutes(row: Any) -> float:
    minutes = _num(_get(row, "cardio_minutes") or _get(row, "duration_minutes") or _get(row, "durationMinutes"), None)
    if minutes is not None:
        return max(0.0, minutes)
    seconds = _num(_get(row, "duration_seconds") or _get(row, "durationSeconds"), None)
    if seconds is not None:
        return max(0.0, seconds / 60.0)
    return 0.0


def _planned_cardio_minutes(plan: Any, date_range: tuple[date, date]) -> float:
    minutes = 0.0
    for day in _planned_workouts(plan, [], date_range):
        for ex in _exercise_list(day):
            if _looks_cardio(ex):
                duration = _duration_target_seconds(ex)
                minutes += (duration / 60.0) if duration else 25.0
    return minutes


def _key_cardio_session_score(rows: list[Any], plan: Any, date_range: tuple[date, date]) -> float:
    planned_count = 0
    for day in _planned_workouts(plan, [], date_range):
        if any(_looks_cardio(ex) for ex in _exercise_list(day)):
            planned_count += 1
    if planned_count <= 0:
        planned_count = max(1, math.ceil(len(_date_span(*date_range)) / 7))
    return _ratio_score(len(rows), planned_count)


def _zone_adherence_score(rows: list[Any]) -> float:
    if not rows:
        return 45.0
    return _avg([_zone_score_for_log(row, row) for row in rows], 70.0)


def _rep_range(raw: Any) -> tuple[int, int] | None:
    text = _text(raw).lower().replace("–", "-").replace("—", "-")
    if not text or "sec" in text or "min" in text or "amrap" in text:
        return None
    nums = [int(n) for n in re.findall(r"\d+", text)]
    if not nums:
        return None
    if len(nums) == 1:
        return nums[0], nums[0]
    return min(nums[0], nums[1]), max(nums[0], nums[1])


def _duration_target_seconds(ex: Any) -> float | None:
    direct = _num(_get(ex, "duration_seconds") or _get(ex, "durationSeconds"), None)
    if direct:
        return direct
    text = _text(_get(ex, "reps") or _get(ex, "target_reps") or _get(ex, "targetReps")).lower()
    nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)]
    if not nums:
        return None
    value = max(nums)
    return value * 60.0 if "min" in text else value if "s" in text or "sec" in text else None


def _same_movement_family(a: dict[str, Any], b: dict[str, Any]) -> bool:
    for key in ("movement_pattern", "primary_muscle", "exercise_type"):
        av = _norm_name(a.get(key))
        bv = _norm_name(b.get(key))
        if av and bv and av == bv:
            return True
    a_muscles = {_norm_name(v) for v in _ensure_list(a.get("secondary_muscles"))}
    b_muscles = {_norm_name(v) for v in _ensure_list(b.get("secondary_muscles"))}
    return bool(a_muscles & b_muscles)


def _valid_skip_reason(reason: str) -> bool:
    return any(k in reason for k in ("injury", "deload", "coach", "approved", "travel", "illness", "sick", "planned rest"))


def _missing_intensity_score(goal_type: str) -> float:
    return 50.0 if goal_type == "strength" else 60.0 if goal_type == "muscle_gain" else 70.0


def _expected_sessions_from_logs(logs: list[dict[str, Any]]) -> int:
    if not logs:
        return 1
    dates = {row.get("date") for row in logs}
    return max(1, min(6, len(dates)))


def _fallback_component_key(key: str) -> str:
    if "protein" in key.lower():
        return "proteinTargetAdherence"
    if "hydration" in key.lower():
        return "hydration"
    if "carb" in key.lower():
        return "carbFueling"
    if "logging" in key.lower():
        return "loggingCompleteness"
    return "calorieTargetAdherence"


def _nutrition_target_summary(calories: float, protein: float) -> str:
    parts = []
    if calories > 0:
        parts.append(f"{calories:.0f} kcal/day")
    if protein > 0:
        parts.append(f"{protein:.0f}g protein/day")
    return "; ".join(parts) if parts else "No nutrition targets available"


def _default_metric(goal_type: str) -> str:
    return {
        "fat_loss": "body_fat_pct",
        "body_recomp": "body_fat_pct",
        "muscle_gain": "weight_lbs",
        "strength": "estimated_1rm_pct",
        "endurance": "cardio_volume_min",
    }.get(goal_type, "consistency")


def _default_unit(goal_type: str) -> str:
    return {
        "fat_loss": "percentage_points",
        "body_recomp": "percentage_points",
        "muscle_gain": "lb",
        "strength": "percent",
        "endurance": "minutes",
    }.get(goal_type, "percent")


def _fmt_signed(value: float) -> str:
    return f"{value:+.1f}"
