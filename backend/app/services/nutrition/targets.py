"""Canonical nutrition target resolution.

The calorie calculator is intentionally pure: profile + goal + training
volume in, macros out. This module is the DB-aware adapter around it. It
adds the pieces that only exist after onboarding: accepted coach deltas,
recent HealthKit movement, recent HealthKit/manual weight, and custom macro
overrides.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.models import (
    DailyHealthSnapshot,
    UserCoachingState,
    UserGoal,
    UserPreferences,
    UserProfile,
    WeightEntry,
    WorkoutCompletion,
)
from app.services.nutrition.calorie_calculator import (
    CalorieInputs,
    CalorieTargets,
    CustomMacroOverrides,
    compute_targets,
    step_8_apply_custom_overrides,
)
from app.services.nutrition.goal_params import get_bucket_for_goal
from app.services.nutrition.weekly_calorie_budget import compute_adjusted_macros


@dataclass(frozen=True)
class HealthActivitySignal:
    adjustment_kcal: int
    days_with_data: int
    avg_active_energy_kcal: int | None
    avg_steps: int | None
    completed_workouts_7d: int
    expected_active_energy_kcal: int | None
    expected_steps: int | None
    source: str


@dataclass(frozen=True)
class ResolvedNutritionTargets:
    calories: int
    protein_g: int
    carbs_g: int
    fat_g: int
    bmr: int
    activity_multiplier: float
    tdee: int
    goal_adjustment_kcal: int
    bucket_name: str
    rate_summary: str
    override_applied: bool
    min_calories_enforced: bool
    coaching_adjustment_kcal: int
    health_activity_adjustment_kcal: int
    source_weight_lbs: float
    source_weight_kind: str
    goal_type: str | None
    goal_pace: str | None
    days_per_week: int
    session_minutes: int
    health_signal: HealthActivitySignal | None = None
    calculated_calories: int | None = None
    calculated_protein_g: int | None = None
    calculated_carbs_g: int | None = None
    calculated_fat_g: int | None = None

    def macros_dict(self) -> dict[str, int]:
        return {
            "calories": self.calories,
            "protein_g": self.protein_g,
            "carbs_g": self.carbs_g,
            "fat_g": self.fat_g,
        }


def _enum_value(value: Any, default: str | None = None) -> str | None:
    if value is None:
        return default
    if hasattr(value, "value"):
        return str(value.value)
    return str(value)


def _round_to_25(value: float) -> int:
    return int(round(value / 25.0) * 25)


def _gender_floor(gender: str | None) -> int:
    return 1500 if (gender or "").lower() == "male" else 1200


def _active_energy_adjustment(
    *,
    avg_active_energy_kcal: float | None,
    avg_steps: float | None,
    expected_active_energy_kcal: float | None,
    expected_steps: int | None,
    completed_workouts_7d: int,
    planned_training_days: int,
    goal_bucket: str | None,
) -> int:
    """Bounded daily kcal correction from observed activity.

    Apple active energy is the strongest signal when present; steps are a
    fallback/corroborator. We only apply part of the observed difference
    because calorie burn devices are noisy and because the base calculator's
    activity multiplier already includes expected movement.
    """
    active_adj: float | None = None
    if avg_active_energy_kcal is not None and expected_active_energy_kcal is not None:
        active_adj = (avg_active_energy_kcal - expected_active_energy_kcal) * 0.35

    step_adj: float | None = None
    if avg_steps is not None and expected_steps is not None:
        step_adj = ((avg_steps - expected_steps) / 1000.0) * 20.0

    if active_adj is not None and step_adj is not None:
        raw = active_adj + (step_adj * 0.25)
    elif active_adj is not None:
        raw = active_adj
    elif step_adj is not None:
        raw = step_adj
    else:
        raw = 0.0

    # Recorded app usage can reveal extra unplanned sessions even when
    # HealthKit active energy is unavailable. Keep this small so it does
    # not double-count Apple Watch workouts when active energy is present.
    if active_adj is None and completed_workouts_7d > planned_training_days:
        raw += min(75, (completed_workouts_7d - planned_training_days) * 25)

    bucket = (goal_bucket or "").lower()
    if bucket == "fat_loss":
        low, high = -100, 125
    elif bucket in {"muscle_gain", "strength", "endurance", "athletic_performance", "hyrox"}:
        low, high = -75, 200
    else:
        low, high = -100, 150

    return max(low, min(high, _round_to_25(raw)))


def _expected_steps(training_days: int) -> int:
    if training_days <= 1:
        return 4000
    if training_days <= 3:
        return 5500
    if training_days <= 5:
        return 7000
    return 8500


def _health_activity_signal(
    db: Session,
    user_id: int,
    *,
    as_of: date,
    bmr: int,
    tdee: int,
    planned_training_days: int,
    goal_bucket: str | None,
) -> HealthActivitySignal:
    since = as_of - timedelta(days=6)
    rows = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date >= since)
        .where(DailyHealthSnapshot.snapshot_date <= as_of)
    ).all()

    active_vals = [
        float(r.active_energy_kcal)
        for r in rows
        if r.active_energy_kcal is not None and r.active_energy_kcal >= 0
    ]
    step_vals = [
        float(r.steps)
        for r in rows
        if r.steps is not None and r.steps >= 0
    ]
    days_with_data = max(len(active_vals), len(step_vals))

    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= since)
        .where(WorkoutCompletion.workout_date <= as_of)
    ).all()
    completed_workouts_7d = len(completions)

    if days_with_data < 3:
        return HealthActivitySignal(
            adjustment_kcal=0,
            days_with_data=days_with_data,
            avg_active_energy_kcal=None,
            avg_steps=None,
            completed_workouts_7d=completed_workouts_7d,
            expected_active_energy_kcal=None,
            expected_steps=None,
            source="insufficient_health_data",
        )

    avg_active = sum(active_vals) / len(active_vals) if active_vals else None
    avg_steps = sum(step_vals) / len(step_vals) if step_vals else None
    expected_active = max(150, int(round(tdee - (bmr * 1.2)))) if active_vals else None
    expected_steps = _expected_steps(planned_training_days) if step_vals else None

    adj = _active_energy_adjustment(
        avg_active_energy_kcal=avg_active,
        avg_steps=avg_steps,
        expected_active_energy_kcal=expected_active,
        expected_steps=expected_steps,
        completed_workouts_7d=completed_workouts_7d,
        planned_training_days=planned_training_days,
        goal_bucket=goal_bucket,
    )
    return HealthActivitySignal(
        adjustment_kcal=adj,
        days_with_data=days_with_data,
        avg_active_energy_kcal=int(round(avg_active)) if avg_active is not None else None,
        avg_steps=int(round(avg_steps)) if avg_steps is not None else None,
        completed_workouts_7d=completed_workouts_7d,
        expected_active_energy_kcal=expected_active,
        expected_steps=expected_steps,
        source="apple_health",
    )


def _latest_weight_lbs(
    db: Session,
    user_id: int,
    *,
    as_of: date,
    fallback_weight_lbs: float,
) -> tuple[float, str]:
    candidates: list[tuple[date, int, float, str]] = []
    manual = db.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == user_id)
        .where(WeightEntry.entry_date <= as_of)
        .order_by(WeightEntry.entry_date.desc())
    ).first()
    if manual and manual.weight_lbs > 0:
        candidates.append((manual.entry_date, 2, float(manual.weight_lbs), manual.source or "manual"))

    health = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date <= as_of)
        .where(DailyHealthSnapshot.weight_lbs != None)  # noqa: E711
        .order_by(DailyHealthSnapshot.snapshot_date.desc())
    ).first()
    if health and health.weight_lbs and health.weight_lbs > 0:
        candidates.append((health.snapshot_date, 1, float(health.weight_lbs), "apple_health"))

    if not candidates:
        return float(fallback_weight_lbs), "profile"

    candidates.sort(key=lambda row: (row[0], row[1]), reverse=True)
    d, _priority, weight, source = candidates[0]
    if (as_of - d).days > 30:
        return float(fallback_weight_lbs), "profile"
    return weight, source


def _apply_delta_to_targets(
    targets: CalorieTargets,
    *,
    delta_kcal: int,
    gender: str | None,
) -> CalorieTargets:
    if delta_kcal == 0:
        return targets

    adjusted_calories = max(_gender_floor(gender), int(targets.calories + delta_kcal))
    adjusted_macros = compute_adjusted_macros(
        base_protein_g=targets.protein_g,
        base_carbs_g=targets.carbs_g,
        base_fat_g=targets.fat_g,
        adjusted_calories=adjusted_calories,
        base_calories=targets.calories,
    )
    return CalorieTargets(
        calories=int(adjusted_macros["calories"]),
        protein_g=int(adjusted_macros["protein_g"]),
        carbs_g=int(adjusted_macros["carbs_g"]),
        fat_g=int(adjusted_macros["fat_g"]),
        bmr=targets.bmr,
        activity_multiplier=targets.activity_multiplier,
        tdee=targets.tdee,
        goal_adjustment_kcal=targets.goal_adjustment_kcal,
        bucket_name=targets.bucket_name,
        rate_summary=targets.rate_summary,
        override_applied=targets.override_applied,
        min_calories_enforced=targets.min_calories_enforced or adjusted_calories != targets.calories + delta_kcal,
        consistency_kcal_delta=0,
        calculated_calories=targets.calculated_calories,
        calculated_protein_g=targets.calculated_protein_g,
        calculated_carbs_g=targets.calculated_carbs_g,
        calculated_fat_g=targets.calculated_fat_g,
    )


def _resolve_from_inputs(
    db: Session | None,
    user_id: int | None,
    inputs: CalorieInputs,
    *,
    as_of: date,
    include_health: bool,
) -> ResolvedNutritionTargets:
    base = compute_targets(CalorieInputs(
        weight_lbs=inputs.weight_lbs,
        height_feet=inputs.height_feet,
        height_inches=inputs.height_inches,
        age=inputs.age,
        gender=inputs.gender,
        training_days_per_week=inputs.training_days_per_week,
        session_minutes=inputs.session_minutes,
        goal_id=inputs.goal_id,
        pace=inputs.pace,
        target_weight_lbs=inputs.target_weight_lbs,
        timeline_weeks=inputs.timeline_weeks,
        custom_overrides=None,
    ))

    coaching_delta = 0
    if db is not None and user_id is not None:
        state = db.exec(
            select(UserCoachingState).where(UserCoachingState.user_id == user_id)
        ).first()
        coaching_delta = int(state.calorie_adjustment or 0) if state else 0

    health_signal = None
    health_delta = 0
    if include_health and db is not None and user_id is not None:
        health_signal = _health_activity_signal(
            db,
            user_id,
            as_of=as_of,
            bmr=base.bmr,
            tdee=base.tdee,
            planned_training_days=int(inputs.training_days_per_week or 0),
            goal_bucket=base.bucket_name,
        )
        health_delta = int(health_signal.adjustment_kcal)

    adjusted = _apply_delta_to_targets(
        base,
        delta_kcal=coaching_delta + health_delta,
        gender=inputs.gender,
    )

    if inputs.custom_overrides:
        adjusted = step_8_apply_custom_overrides(
            adjusted,
            inputs.custom_overrides,
            bucket=get_bucket_for_goal(inputs.goal_id),
            weight_lbs=inputs.weight_lbs,
        )

    return ResolvedNutritionTargets(
        calories=int(adjusted.calories),
        protein_g=int(adjusted.protein_g),
        carbs_g=int(adjusted.carbs_g),
        fat_g=int(adjusted.fat_g),
        bmr=int(adjusted.bmr),
        activity_multiplier=float(adjusted.activity_multiplier),
        tdee=int(adjusted.tdee),
        goal_adjustment_kcal=int(adjusted.goal_adjustment_kcal),
        bucket_name=adjusted.bucket_name,
        rate_summary=adjusted.rate_summary,
        override_applied=bool(adjusted.override_applied),
        min_calories_enforced=bool(adjusted.min_calories_enforced),
        coaching_adjustment_kcal=coaching_delta,
        health_activity_adjustment_kcal=health_delta,
        source_weight_lbs=float(inputs.weight_lbs),
        source_weight_kind="resolved",
        goal_type=inputs.goal_id,
        goal_pace=inputs.pace,
        days_per_week=int(inputs.training_days_per_week or 0),
        session_minutes=int(inputs.session_minutes or 0),
        health_signal=health_signal,
        calculated_calories=adjusted.calculated_calories,
        calculated_protein_g=adjusted.calculated_protein_g,
        calculated_carbs_g=adjusted.calculated_carbs_g,
        calculated_fat_g=adjusted.calculated_fat_g,
    )


def resolve_targets_for_user(
    db: Session,
    user_id: int,
    *,
    as_of: date | None = None,
    custom_overrides: CustomMacroOverrides | None = None,
    include_health: bool = True,
) -> ResolvedNutritionTargets | None:
    as_of = as_of or date.today()
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    if not profile:
        return None
    goal = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()

    weight_lbs, weight_source = _latest_weight_lbs(
        db,
        user_id,
        as_of=as_of,
        fallback_weight_lbs=float(profile.weight_lbs or 150),
    )
    goal_id = _enum_value(goal.goal_type if goal else None, "body_recomp") or "body_recomp"
    pace = _enum_value(goal.pace if goal else None, "moderate") or "moderate"
    gender = _enum_value(profile.gender, "male") or "male"
    inputs = CalorieInputs(
        weight_lbs=weight_lbs,
        height_feet=int(profile.height_feet or 5),
        height_inches=int(profile.height_inches or 7),
        age=int(profile.age or 30),
        gender=gender,
        training_days_per_week=int(prefs.days_per_week if prefs else 3),
        session_minutes=int((prefs.workout_duration_minutes if prefs else None) or 60),
        goal_id=goal_id,
        pace=pace,
        target_weight_lbs=goal.target_weight_lbs if goal else None,
        timeline_weeks=goal.timeline_weeks if goal else None,
        custom_overrides=custom_overrides,
    )
    resolved = _resolve_from_inputs(
        db,
        user_id,
        inputs,
        as_of=as_of,
        include_health=include_health,
    )
    return ResolvedNutritionTargets(
        **{
            **resolved.__dict__,
            "source_weight_lbs": weight_lbs,
            "source_weight_kind": weight_source,
        }
    )


def resolve_targets_for_request(
    req: Any,
    *,
    db: Session | None = None,
    user_id: int | None = None,
    as_of: date | None = None,
    include_health: bool = True,
) -> ResolvedNutritionTargets:
    as_of = as_of or date.today()
    ps = req.physicalStats

    weight_lbs = float(ps.weightLbs or 150)
    weight_source = "request"
    if db is not None and user_id is not None:
        weight_lbs, weight_source = _latest_weight_lbs(
            db,
            user_id,
            as_of=as_of,
            fallback_weight_lbs=weight_lbs,
        )

    overrides = None
    if getattr(req, "customMacros", None):
        cm = req.customMacros
        overrides = CustomMacroOverrides(
            calories=cm.calories,
            protein=cm.protein,
            carbs=cm.carbs,
            fat=cm.fat,
        )

    inputs = CalorieInputs(
        weight_lbs=weight_lbs,
        height_feet=int(ps.heightFeet or 5),
        height_inches=int(ps.heightInches or 7),
        age=int(ps.age or 30),
        gender=str(ps.gender or "male"),
        training_days_per_week=int(getattr(req, "daysPerWeek", 3) or 3),
        session_minutes=int(getattr(req, "workoutDurationMinutes", 60) or 60),
        goal_id=str(getattr(req, "goal", None) or "body_recomp"),
        pace=str(req.goalDetails.pace or "moderate"),
        target_weight_lbs=req.goalDetails.targetWeightLbs,
        timeline_weeks=req.goalDetails.timelineWeeks,
        custom_overrides=overrides,
    )
    resolved = _resolve_from_inputs(
        db,
        user_id,
        inputs,
        as_of=as_of,
        include_health=include_health,
    )
    return ResolvedNutritionTargets(
        **{
            **resolved.__dict__,
            "source_weight_lbs": weight_lbs,
            "source_weight_kind": weight_source,
        }
    )
