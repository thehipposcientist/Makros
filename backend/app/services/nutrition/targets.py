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
    step_6_calculate_fat_g,
    step_7_calculate_carbs_g,
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
class HealthEnergySignal:
    days_with_data: int
    avg_basal_energy_kcal: int
    avg_active_energy_kcal: int
    avg_total_energy_kcal: int
    source: str = "apple_health_total_energy"


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
    source_bmr_kind: str = "formula"
    source_bmr_kcal: int | None = None
    source_tdee_kind: str = "formula"
    source_tdee_kcal: int | None = None
    health_basal_adjustment_kcal: int = 0
    health_energy_adjustment_kcal: int = 0
    health_energy_signal: HealthEnergySignal | None = None
    formula_tdee_kcal: int | None = None
    apple_tdee_kcal: int | None = None
    apple_valid_days: int = 0
    maintenance_source: str = "formula"
    maintenance_blend: dict[str, Any] | None = None
    goal_adjustment_pct: float | None = None
    goal_pace_label: str | None = None
    protein_basis_lbs: float | None = None
    protein_basis_kind: str | None = None
    protein_factor: float | None = None
    fat_percent: float | None = None
    fat_floor_g: int | None = None
    min_carbs_g: int | None = None
    warnings: list[str] | None = None
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


def _custom_macro_overrides_from_raw(raw: Any) -> CustomMacroOverrides | None:
    if not raw:
        return None

    def _get(key: str) -> Any:
        if isinstance(raw, dict):
            return raw.get(key)
        return getattr(raw, key, None)

    def _clean(value: Any) -> int | None:
        if value is None:
            return None
        try:
            n = int(round(float(value)))
        except (TypeError, ValueError):
            return None
        return n if n > 0 else None

    overrides = CustomMacroOverrides(
        calories=_clean(_get("calories")),
        protein=_clean(_get("protein")),
        carbs=_clean(_get("carbs")),
        fat=_clean(_get("fat")),
    )
    if not any((overrides.calories, overrides.protein, overrides.carbs, overrides.fat)):
        return None
    return overrides


def _round_to_25(value: float) -> int:
    return int(round(value / 25.0) * 25)


def _gender_floor(gender: str | None) -> int:
    return 1500 if (gender or "").lower() == "male" else 1200


def _apple_tdee_blend_weight(valid_days: int) -> float:
    """Trust Apple total energy gradually.

    Planned activity already lives in formula TDEE. Apple basal+active becomes
    a stronger maintenance signal only after repeated full days; this prevents
    a few partial HealthKit rows from replacing the formula estimate.
    """
    if valid_days <= 2:
        return 0.0
    if valid_days <= 6:
        return 0.20
    if valid_days <= 13:
        return 0.40
    return 0.60


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


def _recent_basal_energy_kcal(
    db: Session,
    user_id: int,
    *,
    as_of: date,
) -> int | None:
    """Return a recent Apple basal-energy average when enough full days exist."""
    usable_as_of = min(as_of, date.today() - timedelta(days=1)) if as_of >= date.today() else as_of
    since = usable_as_of - timedelta(days=13)
    rows = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date >= since)
        .where(DailyHealthSnapshot.snapshot_date <= usable_as_of)
    ).all()
    vals = [
        float(r.basal_energy_kcal)
        for r in rows
        if r.basal_energy_kcal is not None and 900 <= float(r.basal_energy_kcal) <= 3200
    ]
    if len(vals) < 3:
        return None
    return int(round(sum(vals) / len(vals)))


def _recent_total_energy_signal(
    db: Session,
    user_id: int,
    *,
    as_of: date,
) -> HealthEnergySignal | None:
    """Return recent Apple total energy when basal and active are both present.

    Apple active energy is already the movement side of the equation, so when
    both signals exist we should use basal + active directly as maintenance
    evidence instead of multiplying basal by a generic activity bucket.
    """
    usable_as_of = min(as_of, date.today() - timedelta(days=1)) if as_of >= date.today() else as_of
    since = usable_as_of - timedelta(days=13)
    rows = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date >= since)
        .where(DailyHealthSnapshot.snapshot_date <= usable_as_of)
    ).all()
    vals: list[tuple[float, float]] = []
    for row in rows:
        if row.basal_energy_kcal is None or row.active_energy_kcal is None:
            continue
        basal = float(row.basal_energy_kcal)
        active = float(row.active_energy_kcal)
        if 900 <= basal <= 3200 and 0 <= active <= 3000:
            vals.append((basal, active))
    if len(vals) < 3:
        return None

    avg_basal = sum(v[0] for v in vals) / len(vals)
    avg_active = sum(v[1] for v in vals) / len(vals)
    avg_total = avg_basal + avg_active
    return HealthEnergySignal(
        days_with_data=len(vals),
        avg_basal_energy_kcal=int(round(avg_basal)),
        avg_active_energy_kcal=int(round(avg_active)),
        avg_total_energy_kcal=int(round(avg_total)),
    )


def _apply_basal_energy_to_targets(
    targets: CalorieTargets,
    *,
    basal_energy_kcal: int | None,
    weight_lbs: float,
    gender: str | None,
    pace: str | None,
) -> tuple[CalorieTargets, int]:
    if basal_energy_kcal is None:
        return targets, 0

    # Apple basal energy can be more user-specific than Mifflin-St Jeor, but
    # it is still an estimate and can be partial if HealthKit has sparse data.
    # Use the recent average, bounded, so one bad day cannot swing the plan.
    delta_bmr = int(basal_energy_kcal) - int(targets.bmr)
    bounded_delta = max(-250, min(250, delta_bmr))
    if bounded_delta == 0:
        return targets, 0

    adjusted_bmr = int(targets.bmr + bounded_delta)
    adjusted_tdee = int(round(adjusted_bmr * targets.activity_multiplier))
    adjusted_calories = max(_gender_floor(gender), adjusted_tdee + targets.goal_adjustment_kcal)

    bucket = get_bucket_for_goal(targets.bucket_name)
    fat_g = step_6_calculate_fat_g(
        adjusted_calories,
        weight_lbs,
        bucket,
        pace=pace,
        protein_basis_lbs=targets.protein_basis_lbs,
    )
    carbs_g, fat_g = step_7_calculate_carbs_g(
        adjusted_calories,
        targets.protein_g,
        fat_g,
        weight_lbs,
        bucket,
        protein_basis_lbs=targets.protein_basis_lbs,
    )
    return CalorieTargets(
        calories=int(adjusted_calories),
        protein_g=int(targets.protein_g),
        carbs_g=int(carbs_g),
        fat_g=int(fat_g),
        bmr=adjusted_bmr,
        activity_multiplier=targets.activity_multiplier,
        tdee=adjusted_tdee,
        goal_adjustment_kcal=targets.goal_adjustment_kcal,
        bucket_name=targets.bucket_name,
        rate_summary=targets.rate_summary,
        override_applied=targets.override_applied,
        min_calories_enforced=(
            targets.min_calories_enforced
            or adjusted_calories != adjusted_tdee + targets.goal_adjustment_kcal
        ),
        goal_adjustment_pct=targets.goal_adjustment_pct,
        goal_pace_label=targets.goal_pace_label,
        protein_basis_lbs=targets.protein_basis_lbs,
        protein_basis_kind=targets.protein_basis_kind,
        protein_factor=targets.protein_factor,
        fat_percent=targets.fat_percent,
        fat_floor_g=targets.fat_floor_g,
        min_carbs_g=targets.min_carbs_g,
        warnings=list(targets.warnings),
        consistency_kcal_delta=0,
        calculated_calories=targets.calculated_calories,
        calculated_protein_g=targets.calculated_protein_g,
        calculated_carbs_g=targets.calculated_carbs_g,
        calculated_fat_g=targets.calculated_fat_g,
    ), bounded_delta


def _apply_total_energy_to_targets(
    targets: CalorieTargets,
    *,
    signal: HealthEnergySignal,
    weight_lbs: float,
    gender: str | None,
    pace: str | None,
) -> tuple[CalorieTargets, int, int]:
    """Blend Apple basal + active energy into measured maintenance.

    The correction is bounded because wearable energy estimates are still
    estimates. Apple never fully replaces the formula from a few days of data;
    the blend weight ramps from 20% to 60% as full-day coverage improves.
    """
    blend_weight = _apple_tdee_blend_weight(signal.days_with_data)
    if blend_weight <= 0:
        return targets, 0, 0

    basal_delta = int(round((int(signal.avg_basal_energy_kcal) - int(targets.bmr)) * blend_weight))
    basal_delta = max(-250, min(250, basal_delta))
    adjusted_bmr = int(targets.bmr + basal_delta)

    raw_tdee_delta = (int(signal.avg_total_energy_kcal) - int(targets.tdee)) * blend_weight
    tdee_delta = max(-400, min(400, raw_tdee_delta))
    adjusted_tdee = int(round(targets.tdee + tdee_delta))
    adjusted_calories = max(_gender_floor(gender), adjusted_tdee + targets.goal_adjustment_kcal)

    bucket = get_bucket_for_goal(targets.bucket_name)
    fat_g = step_6_calculate_fat_g(
        adjusted_calories,
        weight_lbs,
        bucket,
        pace=pace,
        protein_basis_lbs=targets.protein_basis_lbs,
    )
    carbs_g, fat_g = step_7_calculate_carbs_g(
        adjusted_calories,
        targets.protein_g,
        fat_g,
        weight_lbs,
        bucket,
        protein_basis_lbs=targets.protein_basis_lbs,
    )
    activity_multiplier = round(adjusted_tdee / adjusted_bmr, 3) if adjusted_bmr > 0 else targets.activity_multiplier
    return CalorieTargets(
        calories=int(adjusted_calories),
        protein_g=int(targets.protein_g),
        carbs_g=int(carbs_g),
        fat_g=int(fat_g),
        bmr=adjusted_bmr,
        activity_multiplier=activity_multiplier,
        tdee=adjusted_tdee,
        goal_adjustment_kcal=targets.goal_adjustment_kcal,
        bucket_name=targets.bucket_name,
        rate_summary=targets.rate_summary,
        override_applied=targets.override_applied,
        min_calories_enforced=(
            targets.min_calories_enforced
            or adjusted_calories != adjusted_tdee + targets.goal_adjustment_kcal
        ),
        goal_adjustment_pct=targets.goal_adjustment_pct,
        goal_pace_label=targets.goal_pace_label,
        protein_basis_lbs=targets.protein_basis_lbs,
        protein_basis_kind=targets.protein_basis_kind,
        protein_factor=targets.protein_factor,
        fat_percent=targets.fat_percent,
        fat_floor_g=targets.fat_floor_g,
        min_carbs_g=targets.min_carbs_g,
        warnings=list(targets.warnings),
        consistency_kcal_delta=0,
        calculated_calories=targets.calculated_calories,
        calculated_protein_g=targets.calculated_protein_g,
        calculated_carbs_g=targets.calculated_carbs_g,
        calculated_fat_g=targets.calculated_fat_g,
    ), basal_delta, int(round(tdee_delta))


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
        fat_floor_g=targets.fat_floor_g or 30,
        min_carbs_g=targets.min_carbs_g or 40,
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
        goal_adjustment_pct=targets.goal_adjustment_pct,
        goal_pace_label=targets.goal_pace_label,
        protein_basis_lbs=targets.protein_basis_lbs,
        protein_basis_kind=targets.protein_basis_kind,
        protein_factor=targets.protein_factor,
        fat_percent=targets.fat_percent,
        fat_floor_g=targets.fat_floor_g,
        min_carbs_g=targets.min_carbs_g,
        warnings=list(targets.warnings),
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
    health_activity_as_of: date | None = None,
) -> ResolvedNutritionTargets:
    base = compute_targets(CalorieInputs(
        weight_lbs=inputs.weight_lbs,
        height_feet=inputs.height_feet,
        height_inches=inputs.height_inches,
        age=inputs.age,
        gender=inputs.gender,
        training_days_per_week=inputs.training_days_per_week,
        session_minutes=inputs.session_minutes,
        lifestyle_activity=getattr(inputs, "lifestyle_activity", None),
        goal_id=inputs.goal_id,
        pace=inputs.pace,
        target_weight_lbs=inputs.target_weight_lbs,
        timeline_weeks=inputs.timeline_weeks,
        body_fat_pct=inputs.body_fat_pct,
        custom_overrides=None,
    ))

    formula_tdee_kcal = int(base.tdee)
    source_bmr_kind = "formula"
    source_bmr_kcal: int | None = None
    source_tdee_kind = "formula"
    source_tdee_kcal: int | None = None
    health_basal_adjustment = 0
    health_energy_signal = None
    health_energy_adjustment = 0
    if include_health and db is not None and user_id is not None:
        health_energy_signal = _recent_total_energy_signal(
            db,
            user_id,
            as_of=health_activity_as_of or as_of,
        )
        if health_energy_signal is not None:
            source_bmr_kcal = health_energy_signal.avg_basal_energy_kcal
            source_tdee_kcal = health_energy_signal.avg_total_energy_kcal
            base, health_basal_adjustment, health_energy_adjustment = _apply_total_energy_to_targets(
                base,
                signal=health_energy_signal,
                weight_lbs=float(inputs.weight_lbs),
                gender=inputs.gender,
                pace=inputs.pace,
            )
            source_tdee_kind = "apple_health_blend"
            if health_basal_adjustment != 0:
                source_bmr_kind = "apple_health"
        else:
            source_bmr_kcal = _recent_basal_energy_kcal(
                db,
                user_id,
                as_of=health_activity_as_of or as_of,
            )
            base, health_basal_adjustment = _apply_basal_energy_to_targets(
                base,
                basal_energy_kcal=source_bmr_kcal,
                weight_lbs=float(inputs.weight_lbs),
                gender=inputs.gender,
                pace=inputs.pace,
            )
            if source_bmr_kcal is not None and health_basal_adjustment != 0:
                source_bmr_kind = "apple_health"

    coaching_delta = 0
    if db is not None and user_id is not None:
        state = db.exec(
            select(UserCoachingState).where(UserCoachingState.user_id == user_id)
        ).first()
        coaching_delta = int(state.calorie_adjustment or 0) if state else 0

    health_signal = None
    health_delta = 0
    if include_health and db is not None and user_id is not None:
        if health_energy_signal is not None:
            health_signal = HealthActivitySignal(
                adjustment_kcal=0,
                days_with_data=health_energy_signal.days_with_data,
                avg_active_energy_kcal=health_energy_signal.avg_active_energy_kcal,
                avg_steps=None,
                completed_workouts_7d=0,
                expected_active_energy_kcal=health_energy_signal.avg_active_energy_kcal,
                expected_steps=None,
                source="apple_health_total_energy",
            )
        else:
            health_signal = _health_activity_signal(
                db,
                user_id,
                as_of=health_activity_as_of or as_of,
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
            pace=inputs.pace,
            protein_basis_lbs=adjusted.protein_basis_lbs,
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
        source_bmr_kind=source_bmr_kind,
        source_bmr_kcal=source_bmr_kcal,
        source_tdee_kind=source_tdee_kind,
        source_tdee_kcal=source_tdee_kcal,
        health_basal_adjustment_kcal=health_basal_adjustment,
        health_energy_adjustment_kcal=health_energy_adjustment,
        health_energy_signal=health_energy_signal,
        formula_tdee_kcal=formula_tdee_kcal,
        apple_tdee_kcal=health_energy_signal.avg_total_energy_kcal if health_energy_signal else None,
        apple_valid_days=health_energy_signal.days_with_data if health_energy_signal else 0,
        maintenance_source=source_tdee_kind,
        maintenance_blend=(
            {
                "formula_tdee": formula_tdee_kcal,
                "apple_tdee": health_energy_signal.avg_total_energy_kcal,
                "apple_valid_days": health_energy_signal.days_with_data,
                "apple_weight": _apple_tdee_blend_weight(health_energy_signal.days_with_data),
                "guardrail_kcal": 400,
                "applied_delta_kcal": health_energy_adjustment,
            }
            if health_energy_signal else None
        ),
        goal_adjustment_pct=adjusted.goal_adjustment_pct,
        goal_pace_label=adjusted.goal_pace_label,
        protein_basis_lbs=adjusted.protein_basis_lbs,
        protein_basis_kind=adjusted.protein_basis_kind,
        protein_factor=adjusted.protein_factor,
        fat_percent=adjusted.fat_percent,
        fat_floor_g=adjusted.fat_floor_g,
        min_carbs_g=adjusted.min_carbs_g,
        warnings=list(adjusted.warnings),
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
    health_activity_as_of: date | None = None,
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
    resolved_overrides = custom_overrides or _custom_macro_overrides_from_raw(
        getattr(prefs, "custom_macros", None) if prefs else None
    )
    inputs = CalorieInputs(
        weight_lbs=weight_lbs,
        height_feet=int(profile.height_feet or 5),
        height_inches=int(profile.height_inches or 7),
        age=int(profile.age or 30),
        gender=gender,
        training_days_per_week=int(prefs.days_per_week if prefs else 3),
        session_minutes=int((prefs.workout_duration_minutes if prefs else None) or 60),
        lifestyle_activity=getattr(prefs, "lifestyle_activity", None) if prefs else None,
        goal_id=goal_id,
        pace=pace,
        target_weight_lbs=goal.target_weight_lbs if goal else None,
        timeline_weeks=goal.timeline_weeks if goal else None,
        custom_overrides=resolved_overrides,
    )
    resolved = _resolve_from_inputs(
        db,
        user_id,
        inputs,
        as_of=as_of,
        include_health=include_health,
        health_activity_as_of=health_activity_as_of,
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
    health_activity_as_of: date | None = None,
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

    overrides = _custom_macro_overrides_from_raw(getattr(req, "customMacros", None))
    if overrides is None and db is not None and user_id is not None:
        prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
        overrides = _custom_macro_overrides_from_raw(
            getattr(prefs, "custom_macros", None) if prefs else None
        )

    inputs = CalorieInputs(
        weight_lbs=weight_lbs,
        height_feet=int(ps.heightFeet or 5),
        height_inches=int(ps.heightInches or 7),
        age=int(ps.age or 30),
        gender=str(ps.gender or "male"),
        training_days_per_week=int(getattr(req, "daysPerWeek", 3) or 3),
        session_minutes=int(getattr(req, "workoutDurationMinutes", 60) or 60),
        # Onboarding hard-codes None until the user answers the new
        # question; the EditProfile/onboarding payload starts populating
        # this once the field lands on the client.
        lifestyle_activity=getattr(req, "lifestyleActivity", None) or getattr(req, "lifestyle_activity", None),
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
        health_activity_as_of=health_activity_as_of,
    )
    return ResolvedNutritionTargets(
        **{
            **resolved.__dict__,
            "source_weight_lbs": weight_lbs,
            "source_weight_kind": weight_source,
        }
    )
