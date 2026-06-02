"""Deterministic Insight Engine for wellness-pattern cards.

This module intentionally does not diagnose, predict medical conditions,
or estimate biomarkers. It combines logged wellness signals into transparent
pattern cards with confidence and missing-data notes.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, time, timedelta, timezone
from math import sqrt
import os
from statistics import mean, median
from typing import Any

from sqlmodel import Session, col, select

from app.models import (
    DailyHealthSnapshot,
    DailyLifestyleLog,
    DailyNutritionMetrics,
    FoodMetadata,
    HealthLabResult,
    Meal,
    MealItem,
    PlanDay,
    RecoveryActivity,
    CycleLog,
    SleepLog,
    SupplementIngredient,
    SupplementLog,
    UserDayState,
    UserGoal,
    UserPreferences,
    UserProfile,
    UserSupplementStack,
    WeeklyCheckIn,
    WorkoutCompletion,
    WorkoutExercise,
    WorkoutSession,
)


CardStatus = str
Confidence = str
RiskDirection = str

DISCLAIMER = (
    "This is based on logged wellness data and does not diagnose or predict "
    "medical conditions. Talk to a clinician for persistent symptoms or medical concerns."
)

CARDIOMETABOLIC_RISK_DISCLAIMER = (
    "This is not a diagnosis. Only a clinician or lab test can confirm prediabetes or diabetes."
)

GRAMS_PER_OUNCE = 28.349523125
RED_MEAT_SERVING_G = 85.0
PROCESSED_MEAT_RISK_UNIT_G = 50.0
RED_MEAT_GUIDANCE_LOWER_OZ_14D = 24.0
RED_MEAT_GUIDANCE_UPPER_OZ_14D = 36.0
CARDIO_LOW_MINUTES_WEEK = 75.0
CARDIO_GUIDELINE_MINUTES_WEEK = 150.0

INSIGHT_TAG_ALIASES = {
    "caffeine_source": "caffeine",
    "calcium_source": "dairy_calcium",
    "potassium_source": "potassium_proxy",
    "citrus_or_citrate": "citrus",
    "fodmap_hint": "high_fodmap",
}


@dataclass(frozen=True)
class NutritionSummary:
    window_days: int
    days_with_data: int = 0
    avg_calories: float | None = None
    avg_calories_when_logged: float | None = None
    avg_protein_g: float | None = None
    avg_carbs_g: float | None = None
    avg_fat_g: float | None = None
    avg_fiber_g: float | None = None
    avg_fiber_per_1000_kcal: float | None = None
    avg_added_sugar_g: float | None = None
    avg_saturated_fat_g: float | None = None
    avg_sodium_mg: float | None = None
    avg_caffeine_mg: float | None = None
    avg_potassium_mg: float | None = None
    avg_calcium_mg: float | None = None
    avg_magnesium_mg: float | None = None
    avg_iron_mg: float | None = None
    avg_vitamin_d_mcg: float | None = None
    avg_vitamin_b12_mcg: float | None = None
    avg_folate_mcg: float | None = None
    avg_zinc_mg: float | None = None
    avg_omega_3_g: float | None = None
    micronutrient_logged_days: int = 0
    caffeine_logged_days: int = 0
    late_caffeine_mg: float = 0.0
    late_caffeine_structured_count: int = 0
    avg_alcohol_servings: float | None = None
    avg_animal_protein_g: float | None = None
    avg_plant_protein_g: float | None = None
    avg_energy_availability: float | None = None
    avg_max_meal_protein_pct: float | None = None
    calorie_target: float | None = None
    protein_target_g: float | None = None
    fat_target_g: float | None = None
    carb_target_g: float | None = None
    avg_water_oz: float | None = None
    hydration_logged_days: int = 0
    estimated_hydration_target_oz: float | None = None
    processed_meat_servings: float = 0
    red_meat_servings: float = 0
    refined_grain_servings: float = 0
    omega3_servings: float = 0
    seafood_servings: float = 0
    distinct_plant_foods_week: int = 0
    ultra_processed_pct: float | None = None
    item_count: int = 0
    classified_item_count: int = 0
    insight_enriched_item_count: int = 0
    late_meal_dates: set[date] = field(default_factory=set)
    alcohol_dates: set[date] = field(default_factory=set)
    fiber_spike_dates: set[date] = field(default_factory=set)
    digestion_food_dates: dict[str, set[date]] = field(default_factory=dict)
    daily_values: dict[str, dict[date, float]] = field(default_factory=dict)
    pattern_dates: dict[str, set[date]] = field(default_factory=dict)
    supplement_log_count: int = 0
    creatine_dates: set[date] = field(default_factory=set)
    electrolyte_dates: set[date] = field(default_factory=set)
    magnesium_evening_dates: set[date] = field(default_factory=set)
    high_vitamin_c_dates: set[date] = field(default_factory=set)
    vitamin_d_calcium_supplement_dates: set[date] = field(default_factory=set)
    post_workout_timing_sessions: int = 0
    first_meal_after_workout_minutes: float | None = None
    post_workout_protein_sessions: int = 0
    post_workout_carb_sessions: int = 0
    missed_post_workout_fueling_sessions: int = 0
    checkin_dates: set[date] = field(default_factory=set)


@dataclass(frozen=True)
class SleepSummary:
    window_days: int
    nights_with_data: int = 0
    avg_hours: float | None = None
    avg_score: float | None = None
    bedtime_std_minutes: float | None = None
    low_sleep_dates: set[date] = field(default_factory=set)
    hours_by_date: dict[date, float] = field(default_factory=dict)
    score_by_date: dict[date, float] = field(default_factory=dict)
    bedtime_minutes_by_date: dict[date, float] = field(default_factory=dict)


@dataclass(frozen=True)
class ActivitySummary:
    window_days: int
    days_with_data: int = 0
    avg_steps: float | None = None
    avg_active_energy_kcal: float | None = None
    avg_workout_minutes: float | None = None
    avg_cardio_minutes: float | None = None
    avg_zone2_minutes: float | None = None
    high_sweat_dates: set[date] = field(default_factory=set)
    daily_values: dict[str, dict[date, float]] = field(default_factory=dict)


@dataclass(frozen=True)
class WorkoutSummary:
    window_days: int
    completed_sessions: int = 0
    completed_dates: set[date] = field(default_factory=set)
    hard_sessions_7d: int = 0
    sessions_7d: int = 0
    sessions_28d: int = 0
    acute_load_7d: float | None = None
    baseline_load_per_week: float | None = None
    acute_load_ratio: float | None = None
    soreness_sessions_14d: int = 0
    max_muscle_fatigue: float | None = None
    late_workout_dates: set[date] = field(default_factory=set)
    planned_sessions_14d: int = 0
    today_planned_intensity: str | None = None
    hard_session_dates: set[date] = field(default_factory=set)
    loads_by_date: dict[date, float] = field(default_factory=dict)
    soreness_dates: set[date] = field(default_factory=set)
    pain_note_dates: set[date] = field(default_factory=set)
    soreness_by_muscle_group: dict[str, set[date]] = field(default_factory=dict)
    fatigue_by_muscle_group: dict[str, float] = field(default_factory=dict)
    load_delta_vs_prior_14: float | None = None
    deload_detected: bool = False
    rest_days_since_last_hard_session: int | None = None
    today_target_muscle_groups: set[str] = field(default_factory=set)
    recent_pain_body_parts: set[str] = field(default_factory=set)
    recent_soreness_body_parts: set[str] = field(default_factory=set)
    today_pain_body_part_overlap: set[str] = field(default_factory=set)
    movement_pattern_counts_14d: dict[str, int] = field(default_factory=dict)
    movement_pattern_counts_prior_14d: dict[str, int] = field(default_factory=dict)
    ramped_movement_patterns: set[str] = field(default_factory=set)
    today_target_movement_patterns: set[str] = field(default_factory=set)
    training_strain_points_14d: float = 0.0
    training_strain_confidence: float = 0.0
    easy_restorative_sessions_14d: int = 0
    moderate_sessions_14d: int = 0
    hard_resistance_sessions_14d: int = 0
    hard_endurance_sessions_14d: int = 0
    hard_glycolytic_sessions_14d: int = 0
    resistance_sessions_14d: int = 0
    long_endurance_or_two_a_day_sessions_14d: int = 0
    two_a_day_dates_14d: set[date] = field(default_factory=set)
    consecutive_hard_days_14d: int = 0
    novel_or_high_soreness_sessions_14d: int = 0


@dataclass(frozen=True)
class HealthSnapshotSummary:
    window_days: int
    days_with_data: int = 0
    hrv_latest: float | None = None
    hrv_baseline: float | None = None
    rhr_latest: float | None = None
    rhr_baseline: float | None = None
    vo2_latest: float | None = None
    vo2_trend_per_90d: float | None = None
    weight_trend_lbs_per_week: float | None = None
    bp_reading_count: int = 0
    latest_bp_systolic: int | None = None
    latest_bp_diastolic: int | None = None
    median_bp_systolic: float | None = None
    median_bp_diastolic: float | None = None
    bp_systolic_trend: float | None = None
    hrv_by_date: dict[date, float] = field(default_factory=dict)
    rhr_by_date: dict[date, float] = field(default_factory=dict)
    vo2_by_date: dict[date, float] = field(default_factory=dict)
    weight_by_date: dict[date, float] = field(default_factory=dict)
    bp_systolic_by_date: dict[date, float] = field(default_factory=dict)
    bp_diastolic_by_date: dict[date, float] = field(default_factory=dict)
    latest_labs: dict[str, dict[str, Any]] = field(default_factory=dict)
    lab_trends: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class CycleSummary:
    window_days: int
    opt_in: bool = False
    cycle_tracking_enabled: bool = False
    logs_count: int = 0
    recent_cycle_lengths: list[int] = field(default_factory=list)
    symptom_dates: set[date] = field(default_factory=set)
    flow_dates: set[date] = field(default_factory=set)
    latest_cycle_day: int | None = None
    ovulation_sources: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class RecoveryModalitySummary:
    window_days: int
    activity_count: int = 0
    dates: set[date] = field(default_factory=set)
    modality_dates: dict[str, set[date]] = field(default_factory=dict)
    modality_minutes: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class LifestyleSummary:
    window_days: int
    logs_count: int = 0
    dates: set[date] = field(default_factory=set)
    alcohol_dates: set[date] = field(default_factory=set)
    cannabis_dates: set[date] = field(default_factory=set)
    high_stress_dates: set[date] = field(default_factory=set)
    illness_dates: set[date] = field(default_factory=set)
    late_caffeine_dates: set[date] = field(default_factory=set)
    unusual_appetite_dates: set[date] = field(default_factory=set)
    digestion_issue_dates: set[date] = field(default_factory=set)


@dataclass(frozen=True)
class UserContext:
    goal: str | None = None
    goal_pace: str | None = None
    age: int | None = None
    sex: str | None = None
    weight_lbs: float | None = None
    height_inches: int | None = None
    training_level: str | None = None
    days_per_week: int | None = None
    kidney_stone_history: str = "unknown"
    stone_type: str | None = None
    stone_history_source: str | None = None
    reproductive_health_opt_in: bool = False
    cycle_tracking_enabled: bool = False
    trying_to_conceive: bool | None = None
    pregnancy_status: str | None = None
    known_pcos: bool | None = None
    known_endometriosis: bool | None = None
    gestational_diabetes_history: bool | None = None
    glp1_support_enabled: bool = False
    glp1_appetite: str | None = None
    glp1_side_effects: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class InsightContext:
    nutrition: NutritionSummary
    sleep: SleepSummary
    activity: ActivitySummary
    workouts: WorkoutSummary
    health: HealthSnapshotSummary
    user: UserContext
    generated_at: str
    cycle: CycleSummary = field(default_factory=lambda: CycleSummary(window_days=90))
    recovery_modalities: RecoveryModalitySummary = field(default_factory=lambda: RecoveryModalitySummary(window_days=28))
    lifestyle: LifestyleSummary = field(default_factory=lambda: LifestyleSummary(window_days=14))
    features: "InsightFeatures | None" = None


@dataclass(frozen=True)
class WindowMetric:
    key: str
    current_avg_14: float | None = None
    prior_avg_14: float | None = None
    delta_abs: float | None = None
    delta_pct: float | None = None
    trend_slope_14: float | None = None
    days_above_threshold: int = 0
    days_below_threshold: int = 0
    longest_bad_streak: int = 0
    longest_good_streak: int = 0
    last_3_day_avg: float | None = None
    current_days_with_data: int = 0
    prior_days_with_data: int = 0
    coverage_14: float = 0.0


@dataclass(frozen=True)
class MealPatternFeatures:
    red_meat_servings_14: float = 0.0
    processed_meat_servings_14: float = 0.0
    red_or_processed_days_14: int = 0
    breakfast_processed_meat_days: int = 0
    dinner_red_meat_days: int = 0
    saturated_fat_overlap_days: int = 0
    protein_source_diversity_score: float | None = None
    seafood_days: int = 0
    legume_days: int = 0
    nut_seed_days: int = 0
    whole_grain_days: int = 0
    refined_grain_meals: int = 0
    sugar_sweetened_beverage_count: int = 0
    high_oxalate_food_count: int = 0
    citrus_count: int = 0
    dairy_calcium_days: int = 0
    protein_powder_count: int = 0
    artificial_sweetener_count: int = 0
    high_fodmap_hint_count: int = 0
    late_meal_count: int = 0
    late_added_sugar_count: int = 0
    late_high_fat_count: int = 0
    late_large_meal_count: int = 0
    high_fat_large_meal_count: int = 0
    high_carb_low_protein_meals: int = 0
    fermented_food_days: int = 0
    unsaturated_fat_source_days: int = 0
    plant_protein_days: int = 0
    potassium_proxy_days: int = 0
    potassium_logged_days: int = 0
    calcium_logged_days: int = 0
    late_caffeine_count: int = 0
    inferred_late_caffeine_count: int = 0
    structured_late_caffeine_count: int = 0
    evening_alcohol_count: int = 0
    red_processed_day_delta: int | None = None


@dataclass(frozen=True)
class WorkoutContextFeatures:
    hard_sessions_7d: int = 0
    hard_sessions_14d: int = 0
    acute_load_7d: float | None = None
    chronic_load_28d: float | None = None
    acute_chronic_ratio: float | None = None
    load_delta_vs_prior_14: float | None = None
    deload_detected: bool = False
    rest_days_since_last_hard_session: int | None = None
    today_planned_intensity: str | None = None
    today_target_muscle_groups: set[str] = field(default_factory=set)
    today_is_demanding: bool = False
    today_sore_muscle_overlap: set[str] = field(default_factory=set)
    today_pain_body_part_overlap: set[str] = field(default_factory=set)
    ramped_movement_patterns: set[str] = field(default_factory=set)
    today_ramped_movement_overlap: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class RecoveryContextFeatures:
    sleep_debt_7d: float | None = None
    sleep_debt_14d: float | None = None
    bedtime_variance_minutes: float | None = None
    hrv_ratio_to_baseline: float | None = None
    rhr_delta_to_baseline: float | None = None
    soreness_days: int = 0
    pain_note_present: bool = False
    pain_body_part_days: int = 0
    soreness_body_part_days: int = 0
    max_muscle_fatigue: float | None = None
    stress_note_count: int = 0
    low_sleep_streak: int = 0
    sleep_last_night: float | None = None
    hrv_suppression_days: int = 0
    rhr_elevation_days: int = 0


@dataclass(frozen=True)
class FuelingContextFeatures:
    calorie_alignment_avg_14: float | None = None
    deficit_streak_days: int = 0
    large_deficit_days_14: int = 0
    protein_g_per_kg: float | None = None
    carb_g_per_kg: float | None = None
    carb_g_per_kg_on_hard_days: float | None = None
    low_fat_days_14: int = 0
    energy_availability_avg: float | None = None
    low_energy_availability_days: int = 0
    hard_day_deficit_days: int = 0
    post_workout_protein_present: bool | None = None
    post_workout_carbs_present: bool | None = None
    first_meal_after_workout_minutes: float | None = None
    missed_post_workout_fueling_sessions: int = 0


@dataclass(frozen=True)
class EvidenceSignal:
    key: str
    label: str
    direction: str
    magnitude: float
    confidence: float
    weight: float
    explanation: str


@dataclass(frozen=True)
class InsightFeatures:
    as_of: date
    metrics: dict[str, WindowMetric]
    meals: MealPatternFeatures
    workouts: WorkoutContextFeatures
    recovery: RecoveryContextFeatures
    fueling: FuelingContextFeatures
    overlaps: dict[str, int]
    coverage: dict[str, float]


@dataclass(frozen=True)
class InsightCard:
    id: str
    title: str
    category: str
    status: CardStatus
    score: int
    risk_direction: RiskDirection
    confidence: Confidence
    confidence_reasons: list[str]
    summary: str
    drivers: list[str]
    positive_factors: list[str]
    recommendations: list[str]
    disclaimer: str
    data_used: list[str]
    missing_data: list[str]
    generated_at: str
    data_quality_flags: list[str] = field(default_factory=list)
    display_score: int | None = None
    debug: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.display_score is None and self.status != "unknown":
            object.__setattr__(self, "display_score", self.score)
        debug = dict(self.debug or {})
        debug.setdefault("score_available", self.status != "unknown")
        if self.status == "unknown":
            debug.setdefault("score_unavailable_reason", "not_enough_recent_core_signals")
        object.__setattr__(self, "debug", debug)
        if self.data_quality_flags:
            return
        flags: list[str] = []
        if self.missing_data:
            flags.append("missing_data_present")
        if self.confidence == "low":
            flags.append("low_confidence")
        if any("proxy" in text.lower() or "hint" in text.lower() or "inferred" in text.lower() for text in self.drivers + self.positive_factors + self.confidence_reasons):
            flags.append("contains_inferred_or_proxy_data")
        if not flags:
            flags.append("structured_or_sufficient_logged_data")
        object.__setattr__(self, "data_quality_flags", flags)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> int:
    return int(round(max(low, min(high, value))))


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _avg(values: list[float | int | None]) -> float | None:
    clean = [float(v) for v in values if v is not None]
    return mean(clean) if clean else None


def _sum(values: list[float | int | None]) -> float:
    return sum(float(v or 0) for v in values)


def _std(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    m = mean(values)
    return sqrt(sum((v - m) ** 2 for v in values) / len(values))


def _enum_text(value: Any) -> str | None:
    if value is None:
        return None
    return str(getattr(value, "value", value))


def _status_from_score(
    score: int,
    *,
    risk_direction: RiskDirection,
    unknown: bool = False,
) -> CardStatus:
    if unknown:
        return "unknown"
    if risk_direction == "higher_is_worse":
        if score >= 70:
            return "high"
        if score >= 45:
            return "elevated"
        if score >= 25:
            return "moderate"
        return "low"
    if score < 40:
        return "high"
    if score < 60:
        return "elevated"
    if score < 75:
        return "moderate"
    return "low"


def _confidence(
    present: list[str],
    missing: list[str],
    *,
    coverage: float | None = None,
    corroborating_signals: int | None = None,
    penalties: list[str] | None = None,
) -> tuple[Confidence, list[str]]:
    total = len(present) + len(missing)
    ratio = (len(present) / total) if total else 0.0
    if len(present) >= 3 and ratio >= 0.75:
        label: Confidence = "high"
    elif len(present) >= 2 and ratio >= 0.45:
        label = "medium"
    else:
        label = "low"
    if coverage is not None:
        if coverage < 0.35 and label == "high":
            label = "medium"
        if coverage < 0.2:
            label = "low"
    if corroborating_signals is not None and corroborating_signals <= 0 and missing:
        if label == "high":
            label = "medium"
    reasons = [f"{len(present)} of {total} core signals present"]
    if coverage is not None:
        reasons.append(f"Recent coverage is {int(round(max(0.0, min(1.0, coverage)) * 100))}%")
    if corroborating_signals is not None:
        reasons.append(f"{corroborating_signals} corroborating pattern signals")
    for penalty in penalties or []:
        reasons.append(penalty)
    if missing:
        reasons.append("Missing: " + ", ".join(missing[:4]))
    return label, reasons


def _cap_confidence(
    label: Confidence,
    reasons: list[str],
    max_label: Confidence,
    reason: str,
) -> tuple[Confidence, list[str]]:
    rank = {"low": 1, "medium": 2, "high": 3}
    if rank[label] > rank[max_label]:
        label = max_label
    if reason:
        reasons = [*reasons, reason]
    return label, reasons


def _lab_value(h: HealthSnapshotSummary, *lab_types: str) -> float | None:
    for lab_type in lab_types:
        row = h.latest_labs.get(lab_type)
        if not row:
            continue
        try:
            return float(row.get("value"))
        except (TypeError, ValueError):
            continue
    return None


def health_risk_signals_enabled() -> bool:
    raw = os.getenv("HEALTH_INSIGHTS_RISK_SIGNALS", "1").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def _bmi(u: UserContext) -> float | None:
    if not u.weight_lbs or not u.height_inches or u.height_inches <= 0:
        return None
    return u.weight_lbs * 703.0 / float(u.height_inches ** 2)


def _active_days_per_week(ctx: InsightContext) -> float | None:
    today = _context_today(ctx)
    current = _current_dates(today)
    dates: set[date] = set()
    for d in current:
        steps = ctx.activity.daily_values.get("steps", {}).get(d)
        active_energy = ctx.activity.daily_values.get("active_energy_kcal", {}).get(d)
        workout_minutes = ctx.activity.daily_values.get("workout_minutes", {}).get(d)
        cardio_minutes = ctx.activity.daily_values.get("cardio_minutes", {}).get(d)
        if (
            (steps is not None and steps >= 5000)
            or (active_energy is not None and active_energy >= 250)
            or (workout_minutes is not None and workout_minutes >= 20)
            or (cardio_minutes is not None and cardio_minutes >= 20)
            or d in ctx.workouts.completed_dates
        ):
            dates.add(d)
    if not dates and ctx.activity.days_with_data == 0 and ctx.workouts.completed_sessions == 0:
        return None
    return len(dates) / 2.0


def _sedentary_days(ctx: InsightContext) -> int:
    today = _context_today(ctx)
    current = _current_dates(today)
    return sum(
        1
        for d, steps in ctx.activity.daily_values.get("steps", {}).items()
        if d in current and steps < 4000
    )


def _risk_signal_status(score: int) -> CardStatus:
    if score >= 60:
        return "elevated"
    if score >= 32:
        return "watch"
    return "low"


def _lab_value_with_unit(h: HealthSnapshotSummary, *lab_types: str) -> tuple[float, str] | None:
    for lab_type in lab_types:
        row = h.latest_labs.get(lab_type)
        if not row:
            continue
        try:
            value = float(row.get("value"))
        except (TypeError, ValueError):
            continue
        return value, str(row.get("unit") or "").strip()
    return None


def _domains(**flags: bool) -> list[str]:
    return [k for k, used in flags.items() if used]


def _missing(*items: tuple[str, bool]) -> list[str]:
    return [label for label, is_missing in items if is_missing]


def _positive_limit(items: list[str]) -> list[str]:
    return items[:5]


def _driver_limit(items: list[str]) -> list[str]:
    return items[:5]


def _recommendation_limit(items: list[str]) -> list[str]:
    return items[:3]


def _date_range(start: date, end: date) -> list[date]:
    if end < start:
        return []
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _sorted_context_dates(ctx: InsightContext) -> list[date]:
    dates: set[date] = set()
    for values in ctx.nutrition.daily_values.values():
        dates.update(values.keys())
    for dates_set in ctx.nutrition.pattern_dates.values():
        dates.update(dates_set)
    dates.update(ctx.nutrition.late_meal_dates)
    dates.update(ctx.nutrition.alcohol_dates)
    dates.update(ctx.nutrition.fiber_spike_dates)
    for dates_set in ctx.nutrition.digestion_food_dates.values():
        dates.update(dates_set)
    for dates_set in (
        ctx.nutrition.creatine_dates,
        ctx.nutrition.electrolyte_dates,
        ctx.nutrition.magnesium_evening_dates,
        ctx.nutrition.high_vitamin_c_dates,
        ctx.nutrition.vitamin_d_calcium_supplement_dates,
        ctx.nutrition.checkin_dates,
    ):
        dates.update(dates_set)
    dates.update(ctx.sleep.hours_by_date.keys())
    dates.update(ctx.sleep.score_by_date.keys())
    dates.update(ctx.sleep.bedtime_minutes_by_date.keys())
    dates.update(ctx.sleep.low_sleep_dates)
    for values in ctx.activity.daily_values.values():
        dates.update(values.keys())
    dates.update(ctx.activity.high_sweat_dates)
    dates.update(ctx.workouts.loads_by_date.keys())
    for dates_set in (
        ctx.workouts.completed_dates,
        ctx.workouts.late_workout_dates,
        ctx.workouts.hard_session_dates,
        ctx.workouts.soreness_dates,
        ctx.workouts.pain_note_dates,
        ctx.workouts.two_a_day_dates_14d,
    ):
        dates.update(dates_set)
    for dates_set in ctx.workouts.soreness_by_muscle_group.values():
        dates.update(dates_set)
    for values in (
        ctx.health.hrv_by_date,
        ctx.health.rhr_by_date,
        ctx.health.vo2_by_date,
        ctx.health.weight_by_date,
        ctx.health.bp_systolic_by_date,
        ctx.health.bp_diastolic_by_date,
    ):
        dates.update(values.keys())
    dates.update(ctx.cycle.symptom_dates)
    dates.update(ctx.cycle.flow_dates)
    dates.update(ctx.recovery_modalities.dates)
    for dates_set in ctx.recovery_modalities.modality_dates.values():
        dates.update(dates_set)
    dates.update(ctx.lifestyle.dates)
    for dates_set in (
        ctx.lifestyle.alcohol_dates,
        ctx.lifestyle.cannabis_dates,
        ctx.lifestyle.high_stress_dates,
        ctx.lifestyle.illness_dates,
        ctx.lifestyle.late_caffeine_dates,
        ctx.lifestyle.unusual_appetite_dates,
        ctx.lifestyle.digestion_issue_dates,
    ):
        dates.update(dates_set)
    return sorted(dates)


def _context_today(ctx: InsightContext) -> date:
    generated_date = None
    try:
        generated_date = datetime.fromisoformat(ctx.generated_at.replace("Z", "+00:00")).date()
    except (TypeError, ValueError):
        generated_date = None
    dates = _sorted_context_dates(ctx)
    if dates:
        return max(dates[-1], generated_date or dates[-1])
    return generated_date or date.today()


def _window_bounds(today: date, days: int = 14) -> tuple[date, date, date, date]:
    current_start = today - timedelta(days=days - 1)
    prior_end = current_start - timedelta(days=1)
    prior_start = prior_end - timedelta(days=days - 1)
    return current_start, today, prior_start, prior_end


def _current_dates(today: date, days: int = 14) -> set[date]:
    start, end, _, _ = _window_bounds(today, days)
    return set(_date_range(start, end))


def _prior_dates(today: date, days: int = 14) -> set[date]:
    _, _, start, end = _window_bounds(today, days)
    return set(_date_range(start, end))


def _values_between(series: dict[date, float], start: date, end: date) -> list[tuple[date, float]]:
    return sorted(
        (d, float(v)) for d, v in series.items()
        if start <= d <= end and v is not None
    )


def _slope(values: list[tuple[date, float]]) -> float | None:
    if len(values) < 3:
        return None
    start = values[0][0]
    xs = [(d - start).days for d, _ in values]
    ys = [v for _, v in values]
    x_avg = mean(xs)
    y_avg = mean(ys)
    denom = sum((x - x_avg) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - x_avg) * (y - y_avg) for x, y in zip(xs, ys)) / denom


def _longest_streak(dates: list[date], predicate: Any) -> int:
    longest = 0
    current = 0
    for day in dates:
        if predicate(day):
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def _window_metric(
    key: str,
    series: dict[date, float],
    today: date,
    *,
    days: int = 14,
    above_threshold: float | None = None,
    below_threshold: float | None = None,
    bad_when: str = "above",
) -> WindowMetric:
    current_start, current_end, prior_start, prior_end = _window_bounds(today, days)
    current_values = _values_between(series, current_start, current_end)
    prior_values = _values_between(series, prior_start, prior_end)
    current_nums = [v for _, v in current_values]
    prior_nums = [v for _, v in prior_values]
    current_avg = mean(current_nums) if current_nums else None
    prior_avg = mean(prior_nums) if prior_nums else None
    delta_abs = current_avg - prior_avg if current_avg is not None and prior_avg is not None else None
    delta_pct = None
    if delta_abs is not None and prior_avg not in (None, 0):
        delta_pct = delta_abs / abs(prior_avg) * 100.0
    current_days = _date_range(current_start, current_end)
    above_days = 0
    below_days = 0
    for day in current_days:
        value = series.get(day)
        if value is None:
            continue
        if above_threshold is not None and value > above_threshold:
            above_days += 1
        if below_threshold is not None and value < below_threshold:
            below_days += 1
    def is_bad(day: date) -> bool:
        value = series.get(day)
        if value is None:
            return False
        if bad_when == "below":
            return below_threshold is not None and value < below_threshold
        return above_threshold is not None and value > above_threshold

    def is_good(day: date) -> bool:
        value = series.get(day)
        if value is None:
            return False
        if bad_when == "below":
            return below_threshold is not None and value >= below_threshold
        return above_threshold is not None and value <= above_threshold

    last_3 = _values_between(series, today - timedelta(days=2), today)
    return WindowMetric(
        key=key,
        current_avg_14=current_avg,
        prior_avg_14=prior_avg,
        delta_abs=delta_abs,
        delta_pct=delta_pct,
        trend_slope_14=_slope(current_values),
        days_above_threshold=above_days,
        days_below_threshold=below_days,
        longest_bad_streak=_longest_streak(current_days, is_bad),
        longest_good_streak=_longest_streak(current_days, is_good),
        last_3_day_avg=mean([v for _, v in last_3]) if last_3 else None,
        current_days_with_data=len(current_values),
        prior_days_with_data=len(prior_values),
        coverage_14=len(current_values) / max(1, days),
    )


def _metric_with_fallback(
    metric: WindowMetric,
    *,
    current_avg: float | None = None,
    prior_avg: float | None = None,
    coverage_count: int | None = None,
    window_days: int = 14,
) -> WindowMetric:
    replacement = metric
    if replacement.current_avg_14 is None and current_avg is not None:
        replacement = replace(
            replacement,
            current_avg_14=current_avg,
            current_days_with_data=coverage_count or replacement.current_days_with_data,
            coverage_14=(coverage_count / max(1, window_days)) if coverage_count is not None else replacement.coverage_14,
        )
    if replacement.prior_avg_14 is None and prior_avg is not None:
        replacement = replace(replacement, prior_avg_14=prior_avg)
    if replacement.delta_abs is None and replacement.current_avg_14 is not None and replacement.prior_avg_14 is not None:
        delta = replacement.current_avg_14 - replacement.prior_avg_14
        delta_pct = None if replacement.prior_avg_14 == 0 else delta / abs(replacement.prior_avg_14) * 100.0
        replacement = replace(replacement, delta_abs=delta, delta_pct=delta_pct)
    return replacement


def _count_pattern(patterns: dict[str, set[date]], key: str, dates: set[date]) -> int:
    return len(patterns.get(key, set()) & dates)


def _sum_series_current(series: dict[date, float], dates: set[date]) -> float:
    return sum(float(v or 0) for d, v in series.items() if d in dates)


def _overlap_count(*date_sets: set[date]) -> int:
    if not date_sets:
        return 0
    common = set(date_sets[0])
    for dates in date_sets[1:]:
        common &= dates
    return len(common)


def _exposure_precedes_count(symptom_dates: set[date], exposure_dates: set[date]) -> int:
    return sum(
        1 for symptom_date in symptom_dates
        if symptom_date in exposure_dates or (symptom_date - timedelta(days=1)) in exposure_dates
    )


def _exposure_lift(symptom_dates: set[date], exposure_dates: set[date], observed_dates: set[date]) -> tuple[int, float | None]:
    if not symptom_dates or not exposure_dates or not observed_dates:
        return 0, None
    symptom_like_dates = {
        d for d in observed_dates
        if d in symptom_dates or (d + timedelta(days=1)) in symptom_dates
    }
    exposure_observed = exposure_dates & observed_dates
    no_exposure_observed = observed_dates - exposure_observed
    exposure_hits = len(exposure_observed & symptom_like_dates)
    no_exposure_hits = len(no_exposure_observed & symptom_like_dates)
    if len(exposure_observed) < 2 or len(no_exposure_observed) < 2:
        return exposure_hits, None
    p_exposure = exposure_hits / len(exposure_observed)
    p_no_exposure = no_exposure_hits / len(no_exposure_observed)
    if p_no_exposure == 0:
        lift = 3.0 if p_exposure > 0 else None
    else:
        lift = p_exposure / p_no_exposure
    return exposure_hits, lift


def _signal(
    key: str,
    label: str,
    direction: str,
    magnitude: float,
    confidence: float,
    weight: float,
    explanation: str,
) -> EvidenceSignal:
    return EvidenceSignal(
        key=key,
        label=label,
        direction=direction,
        magnitude=max(0.0, min(1.0, magnitude)),
        confidence=max(0.0, min(1.0, confidence)),
        weight=max(0.0, weight),
        explanation=explanation,
    )


def _apply_evidence(score: float, signals: list[EvidenceSignal], *, risk_direction: RiskDirection) -> float:
    adjusted = score
    for signal in signals:
        delta = signal.weight * signal.magnitude * signal.confidence
        if risk_direction == "higher_is_worse":
            adjusted += delta if signal.direction == "risk" else -delta
        else:
            adjusted -= delta if signal.direction == "risk" else -delta
    return adjusted


def _corroborating_count(signals: list[EvidenceSignal], *, direction: str = "risk") -> int:
    return sum(1 for signal in signals if signal.direction == direction and signal.magnitude >= 0.25 and signal.confidence >= 0.35)


def _features(ctx: InsightContext) -> InsightFeatures:
    return ctx.features or extract_insight_features(ctx)


def _unknown_card(
    *,
    card_id: str,
    title: str,
    category: str,
    risk_direction: RiskDirection,
    generated_at: str,
    missing_data: list[str],
    recommendation: str,
) -> InsightCard:
    confidence, reasons = _confidence([], missing_data[:5])
    return InsightCard(
        id=card_id,
        title=title,
        category=category,
        status="unknown",
        score=0,
        risk_direction=risk_direction,
        confidence=confidence,
        confidence_reasons=reasons,
        summary="Not enough recent logged data yet to make a useful pattern estimate.",
        drivers=[],
        positive_factors=[],
        recommendations=[recommendation],
        disclaimer=DISCLAIMER,
        data_used=[],
        missing_data=missing_data,
        generated_at=generated_at,
        display_score=None,
        debug={
            "score_available": False,
            "score_unavailable_reason": "not_enough_recent_core_signals",
            "compatibility_score": 0,
        },
    )


def _calorie_ratio(n: NutritionSummary) -> float | None:
    if not n.avg_calories_when_logged or not n.calorie_target:
        return None
    return n.avg_calories_when_logged / n.calorie_target


def _fat_percent(n: NutritionSummary) -> float | None:
    calories = n.avg_calories_when_logged or n.avg_calories
    if not calories or not n.avg_fat_g:
        return None
    return (n.avg_fat_g * 9.0) / calories


def _carbs_g_per_kg(n: NutritionSummary, u: UserContext) -> float | None:
    if not n.avg_carbs_g or not u.weight_lbs:
        return None
    return n.avg_carbs_g / (u.weight_lbs / 2.20462)


def _protein_g_per_lb(n: NutritionSummary, u: UserContext) -> float | None:
    if not n.avg_protein_g or not u.weight_lbs:
        return None
    return n.avg_protein_g / u.weight_lbs


def _added_sugar_pct_calories(n: NutritionSummary) -> float | None:
    calories = n.avg_calories_when_logged or n.avg_calories
    if not calories or n.avg_added_sugar_g is None:
        return None
    return (n.avg_added_sugar_g * 4.0) / calories * 100.0


def _saturated_fat_pct_calories(n: NutritionSummary) -> float | None:
    calories = n.avg_calories_when_logged or n.avg_calories
    if not calories or n.avg_saturated_fat_g is None:
        return None
    return (n.avg_saturated_fat_g * 9.0) / calories * 100.0


def _plant_protein_pct(n: NutritionSummary) -> float | None:
    plant = n.avg_plant_protein_g
    animal = n.avg_animal_protein_g
    if plant is None or animal is None or plant + animal <= 0:
        return None
    return plant / (plant + animal) * 100.0


def _rhr_delta(h: HealthSnapshotSummary) -> float | None:
    if h.rhr_latest is None or h.rhr_baseline is None:
        return None
    return h.rhr_latest - h.rhr_baseline


def _hrv_ratio(h: HealthSnapshotSummary) -> float | None:
    if h.hrv_latest is None or h.hrv_baseline in (None, 0):
        return None
    return h.hrv_latest / h.hrv_baseline


def _late_pattern_count(
    low_sleep_dates: set[date],
    prior_dates: set[date],
) -> int:
    return sum(1 for night in low_sleep_dates if (night - timedelta(days=1)) in prior_dates)


def _estimated_grams_from_item(item: MealItem) -> float:
    try:
        grams = float(item.serving_grams or 0)
    except (TypeError, ValueError):
        grams = 0.0
    if grams > 0:
        return grams
    try:
        qty = float(item.quantity or 0)
    except (TypeError, ValueError):
        qty = 0.0
    if qty <= 0:
        return 0.0
    unit = str(getattr(item, "unit", "") or "").strip().lower()
    if unit in {"g", "gram", "grams"}:
        return qty
    if unit in {"kg", "kilogram", "kilograms"}:
        return qty * 1000.0
    if unit in {"mg", "milligram", "milligrams"}:
        return qty / 1000.0
    if unit in {"oz", "ounce", "ounces"}:
        return qty * GRAMS_PER_OUNCE
    if unit in {"lb", "lbs", "pound", "pounds"}:
        return qty * 453.59237
    return 0.0


def _estimated_servings_from_item(item: MealItem, *, reference_grams: float = RED_MEAT_SERVING_G) -> float:
    grams = _estimated_grams_from_item(item)
    if grams > 0 and reference_grams > 0:
        return max(0.05, min(12.0, grams / reference_grams))
    try:
        qty = float(item.quantity or 0)
    except (TypeError, ValueError):
        qty = 0.0
    if 0 < qty <= 6:
        return qty
    return 1.0


def _normalized_body_part(value: Any) -> str | None:
    text = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    return text or None


def _is_late_caffeine_time(value: datetime | None) -> bool:
    if value is None:
        return False
    return value.time() >= time(14, 0)


def _as_aware_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _supplement_name_parts(log: SupplementLog, stack: UserSupplementStack | None, ingredient: SupplementIngredient | None) -> str:
    parts = [
        getattr(log, "name", None),
        getattr(log, "normalized_name", None),
        getattr(stack, "custom_name", None) if stack is not None else None,
        getattr(stack, "category", None) if stack is not None else None,
        getattr(stack, "goal", None) if stack is not None else None,
        getattr(stack, "notes", None) if stack is not None else None,
        getattr(ingredient, "slug", None) if ingredient is not None else None,
        getattr(ingredient, "name", None) if ingredient is not None else None,
        getattr(ingredient, "category", None) if ingredient is not None else None,
    ]
    return " ".join(str(part or "").lower().replace("_", " ") for part in parts)


def extract_insight_features(ctx: InsightContext) -> InsightFeatures:
    today = _context_today(ctx)
    current = _current_dates(today)
    prior = _prior_dates(today)
    n, s, a, w, h, u = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health, ctx.user
    metrics: dict[str, WindowMetric] = {}
    metric_specs = {
        "calories": (None, None, "below", n.avg_calories_when_logged),
        "protein_g": (None, None, "below", n.avg_protein_g),
        "carbs_g": (None, None, "below", n.avg_carbs_g),
        "fat_g": (None, None, "below", n.avg_fat_g),
        "fiber_g": (None, 18.0, "below", n.avg_fiber_g),
        "added_sugar_g": (50.0, None, "above", n.avg_added_sugar_g),
        "saturated_fat_g": (25.0, None, "above", n.avg_saturated_fat_g),
        "sodium_mg": (3500.0, None, "above", n.avg_sodium_mg),
        "potassium_mg": (None, 2600.0, "below", n.avg_potassium_mg),
        "calcium_mg": (None, 700.0, "below", n.avg_calcium_mg),
        "magnesium_mg": (None, 250.0, "below", n.avg_magnesium_mg),
        "iron_mg": (None, 8.0, "below", n.avg_iron_mg),
        "vitamin_d_mcg": (None, 10.0, "below", n.avg_vitamin_d_mcg),
        "alcohol_servings": (0.0, None, "above", n.avg_alcohol_servings),
        "energy_availability": (None, 30.0, "below", n.avg_energy_availability),
        "water_oz": (None, None, "below", n.avg_water_oz),
    }
    for key, (above, below, bad_when, avg_value) in metric_specs.items():
        coverage_count = n.days_with_data
        if key == "water_oz":
            coverage_count = n.hydration_logged_days
        elif key in {"potassium_mg", "calcium_mg", "magnesium_mg", "iron_mg", "vitamin_d_mcg"}:
            coverage_count = n.micronutrient_logged_days
        metrics[key] = _metric_with_fallback(
            _window_metric(
                key,
                n.daily_values.get(key, {}),
                today,
                above_threshold=above,
                below_threshold=below,
                bad_when=str(bad_when),
            ),
            current_avg=avg_value,
            coverage_count=coverage_count,
        )
    metrics["sleep_hours"] = _metric_with_fallback(
        _window_metric("sleep_hours", s.hours_by_date, today, below_threshold=6.5, bad_when="below"),
        current_avg=s.avg_hours,
        coverage_count=s.nights_with_data,
    )
    metrics["steps"] = _metric_with_fallback(
        _window_metric("steps", a.daily_values.get("steps", {}), today, below_threshold=5000, bad_when="below"),
        current_avg=a.avg_steps,
        coverage_count=a.days_with_data,
    )
    metrics["active_energy_kcal"] = _metric_with_fallback(
        _window_metric("active_energy_kcal", a.daily_values.get("active_energy_kcal", {}), today, above_threshold=700, bad_when="above"),
        current_avg=a.avg_active_energy_kcal,
        coverage_count=a.days_with_data,
    )
    metrics["cardio_minutes"] = _metric_with_fallback(
        _window_metric("cardio_minutes", a.daily_values.get("cardio_minutes", {}), today),
        current_avg=a.avg_cardio_minutes,
        coverage_count=a.days_with_data,
    )
    metrics["workout_load"] = _window_metric("workout_load", w.loads_by_date, today, above_threshold=90, bad_when="above")
    metrics["hrv_ms"] = _window_metric("hrv_ms", h.hrv_by_date, today, below_threshold=(h.hrv_baseline or 0) * 0.85 if h.hrv_baseline else None, bad_when="below")
    metrics["rhr"] = _window_metric("rhr", h.rhr_by_date, today, above_threshold=(h.rhr_baseline or 0) + 5 if h.rhr_baseline else None, bad_when="above")
    metrics["vo2_max"] = _window_metric("vo2_max", h.vo2_by_date, today)

    red_dates = n.pattern_dates.get("red_meat", set())
    processed_dates = n.pattern_dates.get("processed_meat", set())
    red_prior = len(red_dates & prior)
    processed_prior = len(processed_dates & prior)
    red_processed_current = (red_dates | processed_dates) & current
    red_processed_prior = (red_dates | processed_dates) & prior
    plant_diversity_days = len(
        (
            n.pattern_dates.get("seafood", set())
            | n.pattern_dates.get("legume", set())
            | n.pattern_dates.get("nut_seed", set())
            | n.pattern_dates.get("whole_grain", set())
            | n.pattern_dates.get("plant_protein", set())
        ) & current
    )
    protein_diversity = min(1.0, plant_diversity_days / 7.0) if n.insight_enriched_item_count or plant_diversity_days else None
    meals = MealPatternFeatures(
        red_meat_servings_14=_sum_series_current(n.daily_values.get("red_meat_servings", {}), current) or n.red_meat_servings,
        processed_meat_servings_14=_sum_series_current(n.daily_values.get("processed_meat_servings", {}), current) or n.processed_meat_servings,
        red_or_processed_days_14=len(red_processed_current) or int(min(14, (n.red_meat_servings or 0) + (n.processed_meat_servings or 0))),
        breakfast_processed_meat_days=_count_pattern(n.pattern_dates, "breakfast_processed_meat", current),
        dinner_red_meat_days=_count_pattern(n.pattern_dates, "dinner_red_meat", current),
        saturated_fat_overlap_days=_overlap_count(red_processed_current, n.pattern_dates.get("high_saturated_fat", set()) & current),
        protein_source_diversity_score=protein_diversity,
        seafood_days=_count_pattern(n.pattern_dates, "seafood", current),
        legume_days=_count_pattern(n.pattern_dates, "legume", current),
        nut_seed_days=_count_pattern(n.pattern_dates, "nut_seed", current),
        whole_grain_days=_count_pattern(n.pattern_dates, "whole_grain", current),
        refined_grain_meals=int(_sum_series_current(n.daily_values.get("refined_grain_meals", {}), current) or n.refined_grain_servings),
        sugar_sweetened_beverage_count=int(_sum_series_current(n.daily_values.get("sugar_sweetened_beverage", {}), current)),
        high_oxalate_food_count=int(_sum_series_current(n.daily_values.get("high_oxalate", {}), current)),
        citrus_count=int(_sum_series_current(n.daily_values.get("citrus", {}), current)),
        dairy_calcium_days=_count_pattern(n.pattern_dates, "dairy_calcium", current),
        protein_powder_count=int(_sum_series_current(n.daily_values.get("protein_powder", {}), current)),
        artificial_sweetener_count=int(_sum_series_current(n.daily_values.get("artificial_sweetener", {}), current)),
        high_fodmap_hint_count=int(_sum_series_current(n.daily_values.get("fodmap_hint", {}), current)),
        late_meal_count=len(n.late_meal_dates & current),
        late_added_sugar_count=int(_sum_series_current(n.daily_values.get("late_added_sugar", {}), current)),
        late_high_fat_count=int(_sum_series_current(n.daily_values.get("late_high_fat", {}), current)),
        late_large_meal_count=int(_sum_series_current(n.daily_values.get("late_large_meal", {}), current)),
        high_fat_large_meal_count=int(_sum_series_current(n.daily_values.get("high_fat_large_meal", {}), current)),
        high_carb_low_protein_meals=int(_sum_series_current(n.daily_values.get("high_carb_low_protein_meal", {}), current)),
        fermented_food_days=_count_pattern(n.pattern_dates, "fermented", current),
        unsaturated_fat_source_days=_count_pattern(n.pattern_dates, "unsaturated_fat", current),
        plant_protein_days=_count_pattern(n.pattern_dates, "plant_protein", current),
        potassium_proxy_days=_count_pattern(n.pattern_dates, "potassium_proxy", current),
        potassium_logged_days=len({d for d, v in n.daily_values.get("potassium_mg", {}).items() if d in current and v > 0}),
        calcium_logged_days=len({d for d, v in n.daily_values.get("calcium_mg", {}).items() if d in current and v > 0}),
        late_caffeine_count=int(
            _sum_series_current(n.daily_values.get("late_caffeine", {}), current)
            + _sum_series_current(n.daily_values.get("late_caffeine_structured", {}), current)
        ),
        inferred_late_caffeine_count=int(_sum_series_current(n.daily_values.get("late_caffeine", {}), current)),
        structured_late_caffeine_count=int(_sum_series_current(n.daily_values.get("late_caffeine_structured", {}), current)),
        evening_alcohol_count=int(_sum_series_current(n.daily_values.get("evening_alcohol", {}), current)),
        red_processed_day_delta=len(red_processed_current) - len(red_processed_prior) if red_processed_prior or red_processed_current else None,
    )

    sore_groups = {
        group for group, dates in w.soreness_by_muscle_group.items()
        if dates & current
    }
    today_sore_overlap = w.today_target_muscle_groups & sore_groups
    today_ramped_overlap = w.today_target_movement_patterns & w.ramped_movement_patterns
    workout_features = WorkoutContextFeatures(
        hard_sessions_7d=w.hard_sessions_7d,
        hard_sessions_14d=len(w.hard_session_dates & current) or sum(1 for d in w.completed_dates if d in current and d >= today - timedelta(days=13)),
        acute_load_7d=w.acute_load_7d,
        chronic_load_28d=sum(w.loads_by_date.values()) if w.loads_by_date else None,
        acute_chronic_ratio=w.acute_load_ratio,
        load_delta_vs_prior_14=w.load_delta_vs_prior_14,
        deload_detected=w.deload_detected,
        rest_days_since_last_hard_session=w.rest_days_since_last_hard_session,
        today_planned_intensity=w.today_planned_intensity,
        today_target_muscle_groups=set(w.today_target_muscle_groups),
        today_is_demanding=(w.today_planned_intensity or "").lower() in {"hard", "heavy", "conditioning"},
        today_sore_muscle_overlap=today_sore_overlap,
        today_pain_body_part_overlap=set(w.today_pain_body_part_overlap),
        ramped_movement_patterns=set(w.ramped_movement_patterns),
        today_ramped_movement_overlap=today_ramped_overlap,
    )

    sleep_series = s.hours_by_date
    sleep_debt_14 = sum(max(0.0, 7.0 - v) for d, v in sleep_series.items() if d in current)
    sleep_debt_7 = sum(max(0.0, 7.0 - v) for d, v in sleep_series.items() if today - timedelta(days=6) <= d <= today)
    low_sleep_streak = metrics["sleep_hours"].longest_bad_streak
    hrv_ratio = _hrv_ratio(h)
    rhr_delta = _rhr_delta(h)
    recovery = RecoveryContextFeatures(
        sleep_debt_7d=sleep_debt_7 if sleep_series else None,
        sleep_debt_14d=sleep_debt_14 if sleep_series else None,
        bedtime_variance_minutes=s.bedtime_std_minutes,
        hrv_ratio_to_baseline=hrv_ratio,
        rhr_delta_to_baseline=rhr_delta,
        soreness_days=len(w.soreness_dates & current) or w.soreness_sessions_14d,
        pain_note_present=bool(w.pain_note_dates & current),
        pain_body_part_days=len(w.recent_pain_body_parts),
        soreness_body_part_days=len(w.recent_soreness_body_parts),
        max_muscle_fatigue=w.max_muscle_fatigue,
        stress_note_count=int(_sum_series_current(n.daily_values.get("stress_note", {}), current)),
        low_sleep_streak=low_sleep_streak,
        sleep_last_night=sleep_series.get(today),
        hrv_suppression_days=metrics["hrv_ms"].days_below_threshold,
        rhr_elevation_days=metrics["rhr"].days_above_threshold,
    )

    ratio = _calorie_ratio(n)
    calorie_ratio_by_date: dict[date, float] = {}
    if n.calorie_target:
        calorie_ratio_by_date = {
            d: float(v) / n.calorie_target for d, v in n.daily_values.get("calories", {}).items()
            if v is not None
        }
    deficit_days = {d for d, v in calorie_ratio_by_date.items() if d in current and v < 0.85}
    large_deficit_days = {d for d, v in calorie_ratio_by_date.items() if d in current and v < 0.75}
    hard_days = w.hard_session_dates & current
    carbs_on_hard = [
        n.daily_values.get("carbs_g", {}).get(d)
        for d in hard_days
        if n.daily_values.get("carbs_g", {}).get(d) is not None
    ]
    weight_kg = (u.weight_lbs / 2.20462) if u.weight_lbs else None
    carb_on_hard = (mean([float(v) for v in carbs_on_hard]) / weight_kg) if carbs_on_hard and weight_kg else None
    fat_low_dates = set()
    for d in current:
        calories = n.daily_values.get("calories", {}).get(d)
        fat_g = n.daily_values.get("fat_g", {}).get(d)
        if calories and fat_g is not None and calories > 0 and (fat_g * 9.0 / calories) < 0.18:
            fat_low_dates.add(d)
    ea_low_dates = {
        d for d, v in n.daily_values.get("energy_availability", {}).items()
        if d in current and v > 0 and v < 30
    }
    fueling = FuelingContextFeatures(
        calorie_alignment_avg_14=ratio,
        deficit_streak_days=_longest_streak(_date_range(min(current), max(current)), lambda d: d in deficit_days) if current else 0,
        large_deficit_days_14=len(large_deficit_days),
        protein_g_per_kg=((n.avg_protein_g or 0) / weight_kg) if n.avg_protein_g and weight_kg else None,
        carb_g_per_kg=_carbs_g_per_kg(n, u),
        carb_g_per_kg_on_hard_days=carb_on_hard,
        low_fat_days_14=len(fat_low_dates),
        energy_availability_avg=n.avg_energy_availability,
        low_energy_availability_days=len(ea_low_dates),
        hard_day_deficit_days=len(hard_days & deficit_days),
        post_workout_protein_present=True if n.post_workout_protein_sessions > 0 else (False if n.post_workout_timing_sessions > 0 else None),
        post_workout_carbs_present=True if n.post_workout_carb_sessions > 0 else (False if n.post_workout_timing_sessions > 0 else None),
        first_meal_after_workout_minutes=n.first_meal_after_workout_minutes,
        missed_post_workout_fueling_sessions=n.missed_post_workout_fueling_sessions,
    )

    low_water_dates = set()
    if n.estimated_hydration_target_oz:
        low_water_dates = {
            d for d, v in n.daily_values.get("water_oz", {}).items()
            if d in current and v < n.estimated_hydration_target_oz * 0.75
        }
    high_sodium_dates = {
        d for d, v in n.daily_values.get("sodium_mg", {}).items()
        if d in current and v >= 3500
    }
    high_added_sugar_dates = {
        d for d, v in n.daily_values.get("added_sugar_g", {}).items()
        if d in current and v >= 50
    }
    low_activity_dates = {
        d for d, v in a.daily_values.get("steps", {}).items()
        if d in current and v < 5000
    }
    overlaps = {
        "red_processed_high_sat_fat": meals.saturated_fat_overlap_days,
        "high_sugar_low_activity": _overlap_count(high_added_sugar_dates, low_activity_dates),
        "low_water_high_sodium": _overlap_count(low_water_dates, high_sodium_dates),
        "sweat_low_water": _overlap_count(a.high_sweat_dates & current, low_water_dates),
        "hard_day_deficit": fueling.hard_day_deficit_days,
        "poor_sleep_hard_training": _overlap_count(s.low_sleep_dates & current, w.hard_session_dates & current),
        "sleep_debt_low_energy": _overlap_count(s.low_sleep_dates & current, deficit_days),
    }
    coverage = {
        "nutrition": n.days_with_data / 14.0,
        "sleep": s.nights_with_data / 14.0,
        "activity": a.days_with_data / 14.0,
        "hydration": n.hydration_logged_days / 14.0,
        "workouts": min(1.0, len(w.completed_dates & current) / 4.0) if w.completed_dates else min(1.0, w.completed_sessions / 8.0),
        "apple_health": h.days_with_data / max(1.0, float(h.window_days or 28)),
        "recovery_modalities": min(1.0, len(ctx.recovery_modalities.dates & current) / 4.0),
        "lifestyle": ctx.lifestyle.logs_count / max(1.0, float(ctx.lifestyle.window_days or 14)),
    }
    return InsightFeatures(
        as_of=today,
        metrics=metrics,
        meals=meals,
        workouts=workout_features,
        recovery=recovery,
        fueling=fueling,
        overlaps=overlaps,
        coverage={k: max(0.0, min(1.0, v)) for k, v in coverage.items()},
    )


def compute_red_processed_meat_pattern(ctx: InsightContext) -> InsightCard:
    n = ctx.nutrition
    f = _features(ctx)
    meals = f.meals
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("meal detail", n.days_with_data >= 2),
        ("food insight enrichment", n.item_count > 0 and n.insight_enriched_item_count > 0),
        ("red/processed meat tags", meals.red_or_processed_days_14 > 0 or n.insight_enriched_item_count > 0),
        ("saturated fat", n.avg_saturated_fat_g is not None),
    ):
        (present if ok else missing).append(label)
    if n.days_with_data < 2:
        return _unknown_card(
            card_id="red_processed_meat_pattern",
            title="Red & Processed Meat Pattern",
            category="diet_quality",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log a few more meals so this can compare red and processed meat amount plus repeat patterns.",
        )

    processed = float(meals.processed_meat_servings_14 or n.processed_meat_servings or 0)
    red = float(meals.red_meat_servings_14 or n.red_meat_servings or 0)
    processed_g = processed * PROCESSED_MEAT_RISK_UNIT_G
    red_oz = red * RED_MEAT_SERVING_G / GRAMS_PER_OUNCE
    sat_pct = _saturated_fat_pct_calories(n)
    risk = 12.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if processed >= 4:
        risk += 34
        drivers.append(f"Processed meat totaled about {processed_g:.0f}g across the last 14 days.")
        recs.append("Replace one processed-meat meal with poultry, fish, beans, lentils, tofu, or eggs.")
    elif processed >= 1:
        risk += 16
        drivers.append(f"Processed meat totaled about {processed_g:.0f}g in logged meals.")
    elif processed > 0:
        risk += 8
        drivers.append(f"Processed meat showed up in a small amount, about {processed_g:.0f}g.")
    else:
        positives.append("Processed meat was not detected in logged meals.")

    if red_oz > RED_MEAT_GUIDANCE_UPPER_OZ_14D:
        risk += 28
        drivers.append(f"Fresh red meat totaled about {red_oz:.0f} oz cooked-equivalent across the last 14 days.")
        recs.append("Make one red-meat meal a fish, poultry, or legume-based meal this week.")
    elif red_oz >= RED_MEAT_GUIDANCE_LOWER_OZ_14D:
        risk += 16
        drivers.append(f"Fresh red meat is near the evidence-based weekly limit at about {red_oz:.0f} oz over 14 days.")
    elif red > 0:
        positives.append(f"Fresh red meat amount is modest in the logged window, about {red_oz:.0f} oz over 14 days.")
    else:
        positives.append("Fresh red meat was not detected in logged meals.")

    if sat_pct is not None and sat_pct >= 10:
        risk += 8
        drivers.append(f"Saturated fat is about {sat_pct:.0f}% of logged calories, so meat choices may matter more.")
    signals: list[EvidenceSignal] = []
    if meals.red_or_processed_days_14 >= 5:
        signals.append(_signal(
            "red_processed_frequency",
            "Frequent red or processed meat days",
            "risk",
            min(1.0, meals.red_or_processed_days_14 / 8.0),
            f.coverage["nutrition"],
            10,
            f"Red or processed meat showed up on {meals.red_or_processed_days_14} of the last 14 days.",
        ))
    if red_oz >= RED_MEAT_GUIDANCE_LOWER_OZ_14D:
        signals.append(_signal(
            "red_meat_amount",
            "Fresh red meat amount",
            "risk",
            min(1.0, red_oz / RED_MEAT_GUIDANCE_UPPER_OZ_14D),
            f.coverage["nutrition"],
            9,
            f"Fresh red meat amount is about {red_oz:.0f} oz over 14 days.",
        ))
    if processed >= 4:
        signals.append(_signal(
            "processed_meat_amount",
            "Processed meat amount",
            "risk",
            min(1.0, processed / 8.0),
            f.coverage["nutrition"],
            8,
            f"Processed meat amount is about {processed_g:.0f}g over 14 days.",
        ))
    if meals.red_processed_day_delta is not None and meals.red_processed_day_delta >= 2:
        signals.append(_signal(
            "meat_frequency_increase",
            "Meat frequency increased",
            "risk",
            min(1.0, meals.red_processed_day_delta / 4.0),
            f.coverage["nutrition"],
            8,
            f"Red/processed meat days are up by {meals.red_processed_day_delta} versus the prior 14-day window.",
        ))
    if meals.breakfast_processed_meat_days >= 2:
        signals.append(_signal(
            "breakfast_processed_meat",
            "Repeat breakfast slot",
            "risk",
            min(1.0, meals.breakfast_processed_meat_days / 4.0),
            f.coverage["nutrition"],
            7,
            f"Processed meat repeated at breakfast on {meals.breakfast_processed_meat_days} days, making it a slot-specific pattern to test.",
        ))
    if meals.dinner_red_meat_days >= 3:
        signals.append(_signal(
            "dinner_red_meat",
            "Repeat dinner slot",
            "risk",
            min(1.0, meals.dinner_red_meat_days / 5.0),
            f.coverage["nutrition"],
            6,
            f"Red meat clustered at dinner on {meals.dinner_red_meat_days} days.",
        ))
    if meals.saturated_fat_overlap_days >= 2:
        signals.append(_signal(
            "sat_fat_overlap",
            "Saturated-fat overlap",
            "risk",
            min(1.0, meals.saturated_fat_overlap_days / 5.0),
            f.coverage["nutrition"],
            8,
            f"Red/processed meat overlapped high saturated fat on {meals.saturated_fat_overlap_days} days.",
        ))
    if meals.protein_source_diversity_score is not None and meals.protein_source_diversity_score >= 0.7:
        signals.append(_signal(
            "protein_diversity",
            "Protein diversity",
            "protective",
            meals.protein_source_diversity_score,
            f.coverage["nutrition"],
            12,
            "Seafood, legumes, nuts/seeds, or whole grains appeared often enough to soften the pattern.",
        ))
    if meals.seafood_days + meals.legume_days + meals.nut_seed_days >= 5:
        positives.append(f"Protein variety is broader: seafood/legume/nut-seed days totaled {meals.seafood_days + meals.legume_days + meals.nut_seed_days}.")
    risk = _apply_evidence(risk, signals, risk_direction="higher_is_worse")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep using varied proteins: seafood, poultry, dairy, beans, lentils, tofu, nuts, and seeds.")
    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=f.coverage["nutrition"],
        corroborating_signals=_corroborating_count(signals),
    )
    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="red_processed_meat_pattern",
        title="Red & Processed Meat Pattern",
        category="diet_quality",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This screens logged red/processed meat amount and repeat patterns. It does not estimate cancer risk.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            food_enrichment=n.insight_enriched_item_count > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_blood_sugar_support_pattern(ctx: InsightContext) -> InsightCard:
    n, a, h = ctx.nutrition, ctx.activity, ctx.health
    f = _features(ctx)
    meals = f.meals
    sugar_pct = _added_sugar_pct_calories(n)
    a1c = _lab_value(h, "a1c", "hba1c")
    fasting_glucose = _lab_value(h, "fasting_glucose", "glucose")
    fasting_insulin = _lab_value(h, "fasting_insulin", "insulin")
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("added sugar", n.avg_added_sugar_g is not None),
        ("fiber", n.avg_fiber_g is not None),
        ("refined grains", n.refined_grain_servings > 0 or n.insight_enriched_item_count > 0),
        ("activity", a.avg_steps is not None or a.avg_active_energy_kcal is not None),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
        ("A1C or fasting glucose labs", a1c is not None or fasting_glucose is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="blood_sugar_support_pattern",
            title="Blood Sugar Support Pattern",
            category="metabolic_health",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals with fiber and added-sugar data to unlock this pattern.",
        )

    score = 78.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if sugar_pct is not None:
        if sugar_pct >= 15:
            score -= 26
            drivers.append(f"Added sugar is about {sugar_pct:.0f}% of logged calories.")
            recs.append("Start with one recurring sweetened drink or snack and swap it for a lower-added-sugar option.")
        elif sugar_pct >= 10:
            score -= 14
            drivers.append(f"Added sugar is near {sugar_pct:.0f}% of logged calories.")
        else:
            positives.append("Added sugar is below the app's watch threshold on logged days.")
    elif n.avg_added_sugar_g is not None and n.avg_added_sugar_g >= 50:
        score -= 18
        drivers.append(f"Added sugar averages about {n.avg_added_sugar_g:.0f}g on logged days.")

    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 16:
            score -= 20
            drivers.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, leaving less blood-sugar support.")
            recs.append("Add one high-fiber anchor such as oats, beans, lentils, berries, chia, or vegetables.")
        elif n.avg_fiber_g < 22:
            score -= 10
            drivers.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, which is still on the low side.")
        elif n.avg_fiber_g >= 28:
            positives.append("Fiber intake is in a supportive range.")
    if n.avg_fiber_per_1000_kcal is not None and n.avg_fiber_per_1000_kcal < 8:
        score -= 8
        drivers.append("Fiber density is low relative to logged calories.")
    if n.refined_grain_servings >= 7:
        score -= 10
        drivers.append(f"Refined grains appeared about {n.refined_grain_servings:.0f} times.")
    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            score -= 6
            drivers.append("Average steps are low, so meals have less movement support.")
        elif a.avg_steps >= 7500:
            positives.append("Daily steps add supportive movement.")
    if h.weight_trend_lbs_per_week is not None and h.weight_trend_lbs_per_week > 1.5:
        score -= 6
        drivers.append("Recent weight trend is rising quickly.")
    if a1c is not None:
        if a1c >= 5.7:
            score -= 14
            drivers.append("Latest A1C is above the app's screening-support target; this is context, not a diagnosis.")
            recs.append("Bring this lab to a clinician if it was not already reviewed.")
        elif a1c < 5.4:
            positives.append("Latest A1C is within the app's screening-support target.")
    if fasting_glucose is not None:
        if fasting_glucose >= 100:
            score -= 10
            drivers.append("Latest fasting glucose is above the app's screening-support target; one lab is still context only.")
        elif fasting_glucose < 95:
            positives.append("Latest fasting glucose is within the app's screening-support target.")
    if fasting_insulin is not None:
        drivers.append("Fasting insulin is available, so the card has stronger lab context without diagnosing insulin resistance.")
    signals: list[EvidenceSignal] = []
    sugar_metric = f.metrics["added_sugar_g"]
    fiber_metric = f.metrics["fiber_g"]
    if sugar_metric.days_above_threshold >= 4:
        trend = " and is up versus the prior 14-day window" if (sugar_metric.delta_abs or 0) > 5 else ""
        signals.append(_signal(
            "added_sugar_persistence",
            "Persistent added sugar",
            "risk",
            min(1.0, sugar_metric.days_above_threshold / 7.0),
            sugar_metric.coverage_14,
            12,
            f"Added sugar was elevated on {sugar_metric.days_above_threshold} of the last 14 days{trend}.",
        ))
    if meals.late_added_sugar_count >= 2:
        signals.append(_signal(
            "late_added_sugar",
            "Late added sugar",
            "risk",
            min(1.0, meals.late_added_sugar_count / 4.0),
            f.coverage["nutrition"],
            8,
            f"Late added-sugar items appeared {meals.late_added_sugar_count} times, a timing pattern worth testing.",
        ))
    if meals.sugar_sweetened_beverage_count >= 2:
        signals.append(_signal(
            "sugar_sweetened_beverages",
            "Sweetened drinks",
            "risk",
            min(1.0, meals.sugar_sweetened_beverage_count / 5.0),
            f.coverage["nutrition"],
            8,
            f"Sugar-sweetened beverages appeared {meals.sugar_sweetened_beverage_count} times.",
        ))
    if meals.high_carb_low_protein_meals >= 3:
        signals.append(_signal(
            "high_carb_low_protein_meals",
            "Carb pairing",
            "risk",
            min(1.0, meals.high_carb_low_protein_meals / 6.0),
            f.coverage["nutrition"],
            7,
            f"{meals.high_carb_low_protein_meals} higher-carb meals had little protein pairing.",
        ))
    if f.overlaps["high_sugar_low_activity"] >= 2:
        signals.append(_signal(
            "high_sugar_low_activity",
            "Sugar and low activity overlap",
            "risk",
            min(1.0, f.overlaps["high_sugar_low_activity"] / 4.0),
            min(f.coverage["nutrition"], f.coverage["activity"]),
            9,
            f"High-sugar days overlapped low-step days {f.overlaps['high_sugar_low_activity']} times.",
        ))
    if meals.whole_grain_days >= 4 and meals.whole_grain_days >= meals.refined_grain_meals:
        signals.append(_signal(
            "whole_grain_support",
            "Whole-grain support",
            "protective",
            min(1.0, meals.whole_grain_days / 7.0),
            f.coverage["nutrition"],
            8,
            f"Whole grains showed up on {meals.whole_grain_days} days, which supports steadier carb patterns.",
        ))
    if fiber_metric.current_avg_14 is not None and fiber_metric.current_avg_14 >= 28:
        signals.append(_signal(
            "fiber_support",
            "Fiber density",
            "protective",
            0.8,
            fiber_metric.coverage_14,
            10,
            "Fiber intake is repeatedly in a supportive range.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep pairing carbs with fiber, protein, and regular movement.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(f.coverage["nutrition"], max(f.coverage["activity"], 0.35)),
        corroborating_signals=_corroborating_count(signals) + (1 if a1c is not None or fasting_glucose is not None else 0),
    )
    if a1c is None and fasting_glucose is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Clinical-risk confidence is capped without A1C or fasting glucose labs",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="blood_sugar_support_pattern",
        title="Blood Sugar Support Pattern",
        category="metabolic_health",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews diet and movement signals associated with steadier blood-sugar support. It does not diagnose diabetes or prediabetes.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            activity=a.days_with_data > 0,
            apple_health=h.weight_trend_lbs_per_week is not None,
            labs=a1c is not None or fasting_glucose is not None or fasting_insulin is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_cardiometabolic_risk_signals(ctx: InsightContext) -> InsightCard:
    n, s, a, w, h, u = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health, ctx.user
    f = _features(ctx)
    meals = f.meals
    bmi = _bmi(u)
    active_days = _active_days_per_week(ctx)
    sedentary_days = _sedentary_days(ctx)
    weekly_cardio = a.avg_cardio_minutes * 7 if a.avg_cardio_minutes is not None else None
    resistance_days = w.resistance_sessions_14d / 2.0 if w.resistance_sessions_14d else 0.0
    sugar_pct = _added_sugar_pct_calories(n)
    a1c = _lab_value_with_unit(h, "a1c", "hba1c")
    fasting_glucose = _lab_value_with_unit(h, "fasting_glucose", "glucose")
    triglycerides = _lab_value_with_unit(h, "triglycerides", "tg")
    hdl = _lab_value_with_unit(h, "hdl", "hdl_cholesterol")
    ldl = _lab_value_with_unit(h, "ldl", "ldl_cholesterol")
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("age/sex", u.age is not None or u.sex is not None),
        ("height/weight or BMI", bmi is not None),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
        ("activity frequency", active_days is not None or a.avg_steps is not None or w.completed_sessions > 0),
        ("cardio and resistance training", weekly_cardio is not None or w.resistance_sessions_14d > 0),
        ("nutrition quality", n.avg_added_sugar_g is not None or n.avg_fiber_g is not None or meals.sugar_sweetened_beverage_count > 0),
        ("sleep", s.avg_hours is not None),
        ("blood pressure", h.bp_reading_count > 0),
        ("A1C or fasting glucose labs", a1c is not None or fasting_glucose is not None),
        ("lipid labs", triglycerides is not None or hdl is not None or ldl is not None),
        ("PCOS or gestational diabetes history", u.known_pcos is not None or u.gestational_diabetes_history is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        confidence, reasons = _confidence(present, missing)
        return InsightCard(
            id="cardiometabolic_risk_signals",
            title="Cardiometabolic risk signals",
            category="health_risk_signals",
            status="unknown",
            score=0,
            risk_direction="higher_is_worse",
            confidence=confidence,
            confidence_reasons=reasons,
            summary=(
                "Cardiometabolic means heart-and-metabolism patterns: blood-sugar support, "
                "blood pressure, blood fats, body-weight trends, and daily movement. "
                "This card checks the available pieces without diagnosing a condition."
            ),
            drivers=[],
            positive_factors=[],
            recommendations=["Log activity, meals, weight trend, or optional labs to make this card more personal."],
            disclaimer=CARDIOMETABOLIC_RISK_DISCLAIMER,
            data_used=[],
            missing_data=missing,
            generated_at=ctx.generated_at,
            display_score=None,
        )

    risk = 14.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    lab_discussion = False
    activity_gap = False
    nutrition_gap = False

    if u.age is not None and u.age >= 45:
        risk += 8
        drivers.append(f"Age {u.age} is one cardiometabolic risk factor to keep in context.")
    if bmi is not None:
        if bmi >= 30:
            risk += 16
            drivers.append(f"BMI is about {bmi:.0f}, which is one cardiometabolic risk factor.")
        elif bmi >= 25:
            risk += 8
            drivers.append(f"BMI is about {bmi:.0f}, a body-size risk factor to watch alongside activity and labs.")
        elif 18.5 <= bmi < 25:
            positives.append("BMI is not adding a body-size risk signal right now.")
    if h.weight_trend_lbs_per_week is not None:
        if h.weight_trend_lbs_per_week >= 1.0:
            risk += 8
            drivers.append(f"Recent weight trend is rising about {h.weight_trend_lbs_per_week:.1f} lb/week.")
        elif -1.5 <= h.weight_trend_lbs_per_week <= -0.25:
            positives.append("Recent weight trend is moving down gradually, which can support cardiometabolic habits.")
    if u.known_pcos is True:
        risk += 10
        drivers.append("PCOS history is logged, so this card treats metabolic risk-factor checks as more relevant.")
    if u.gestational_diabetes_history is True:
        risk += 10
        drivers.append("Gestational diabetes history is logged, so A1C or fasting-glucose follow-up may be worth checking.")
        lab_discussion = True

    if active_days is not None:
        if active_days < 3:
            risk += 18
            activity_gap = True
            drivers.append(f"Active days are under 3/week from logged movement and workouts.")
            recs.append("Build toward at least 3 active days/week, even if the first step is brisk walks.")
        elif active_days >= 4:
            risk -= 12
            positives.append(f"Activity consistency is a protective signal: about {active_days:.0f} active days/week are showing up.")
    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            risk += 14
            activity_gap = True
            drivers.append(f"Average steps are about {a.avg_steps:.0f}/day, leaving less glucose-disposal support from movement.")
        elif a.avg_steps >= 7500:
            risk -= 8
            positives.append(f"Average steps are about {a.avg_steps:.0f}/day, a supportive movement signal.")
    if sedentary_days >= 5:
        risk += 8
        activity_gap = True
        drivers.append(f"Low-step days show up {sedentary_days} times in the recent window.")
    steps_metric = f.metrics["steps"]
    if steps_metric.delta_pct is not None and steps_metric.delta_pct <= -20:
        risk += 6
        activity_gap = True
        drivers.append("Step trend is down versus the prior window.")
    elif steps_metric.delta_pct is not None and steps_metric.delta_pct >= 15:
        risk -= 5
        positives.append("Step trend is improving versus the prior window.")
    if weekly_cardio is not None:
        if weekly_cardio < CARDIO_LOW_MINUTES_WEEK:
            risk += 8
            activity_gap = True
            drivers.append(f"Cardio is around {weekly_cardio:.0f} min/week, below a steady habit target.")
        elif weekly_cardio >= CARDIO_GUIDELINE_MINUTES_WEEK:
            risk -= 8
            positives.append(f"Cardio is around {weekly_cardio:.0f} min/week, a protective activity signal.")
    if resistance_days < 2 and w.completed_sessions > 0:
        risk += 6
        activity_gap = True
        drivers.append("Resistance training is below 2 days/week in recent completed workouts.")
    elif resistance_days >= 2:
        risk -= 7
        positives.append("Resistance training is consistent enough to support muscle and glucose uptake.")

    if sugar_pct is not None:
        if sugar_pct >= 15:
            risk += 14
            nutrition_gap = True
            drivers.append(f"Added sugar is about {sugar_pct:.0f}% of logged calories.")
        elif sugar_pct >= 10:
            risk += 8
            nutrition_gap = True
            drivers.append(f"Added sugar is near {sugar_pct:.0f}% of logged calories.")
    elif n.avg_added_sugar_g is not None and n.avg_added_sugar_g >= 50:
        risk += 10
        nutrition_gap = True
        drivers.append(f"Added sugar averages about {n.avg_added_sugar_g:.0f}g/day on logged days.")
    if meals.sugar_sweetened_beverage_count >= 2:
        risk += 8
        nutrition_gap = True
        drivers.append(f"Sugary drinks appeared {meals.sugar_sweetened_beverage_count} times in logged meals.")
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 16:
            risk += 12
            nutrition_gap = True
            drivers.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, leaving less support around carb quality.")
        elif n.avg_fiber_g >= 25:
            risk -= 7
            positives.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, a supportive nutrition signal.")
    if meals.high_carb_low_protein_meals >= 3:
        risk += 5
        nutrition_gap = True
        drivers.append(f"{meals.high_carb_low_protein_meals} higher-carb meals had little protein pairing.")
    if nutrition_gap:
        recs.append("Prioritize high-fiber carbs and replace one sugary drink or added-sugar snack if that pattern repeats.")
    if nutrition_gap and any("Activity consistency is a protective signal" in p for p in positives):
        risk -= 6
        positives.append("Activity consistency is a protective signal that helps offset some nutrition risk.")

    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            risk += 6
            drivers.append(f"Sleep averages {s.avg_hours:.1f} hours, which can make glucose regulation patterns harder to support.")
        elif s.avg_hours >= 7:
            risk -= 4
            positives.append(f"Sleep averages {s.avg_hours:.1f} hours, supporting recovery and appetite regulation.")

    if a1c is not None:
        value, unit = a1c
        if value >= 5.7:
            risk += 34
            lab_discussion = True
            drivers.insert(0, f"A1C is {value:g}{unit or '%'}, a lab value to discuss with a clinician.")
        elif value < 5.4:
            risk -= 8
            positives.append("A1C is within the app's lower watch band.")
    if fasting_glucose is not None:
        value, unit = fasting_glucose
        if value >= 100:
            risk += 28
            lab_discussion = True
            drivers.insert(0, f"Fasting glucose is {value:g}{unit or ' mg/dL'}, a lab value to discuss with a clinician.")
        elif value < 95:
            risk -= 6
            positives.append("Fasting glucose is within the app's lower watch band.")
    if h.bp_reading_count > 0 and h.latest_bp_systolic is not None and h.latest_bp_diastolic is not None:
        systolic = h.median_bp_systolic or h.latest_bp_systolic
        diastolic = h.median_bp_diastolic or h.latest_bp_diastolic
        if systolic >= 130 or diastolic >= 80:
            risk += 10
            lab_discussion = True
            drivers.insert(0, f"Recent blood-pressure readings center near {systolic:.0f}/{diastolic:.0f}, a value to discuss if it repeats.")
        else:
            positives.append("Recent blood-pressure reading is inside the app's wellness target.")
    if triglycerides is not None:
        value, unit = triglycerides
        if value >= 150:
            risk += 10
            lab_discussion = True
            drivers.insert(0, f"Triglycerides are {value:g}{unit or ' mg/dL'}, a lab value to discuss with a clinician.")
    if hdl is not None:
        value, unit = hdl
        low_threshold = 50 if (u.sex or "").lower() in {"female", "woman"} else 40
        if value < low_threshold:
            risk += 7
            lab_discussion = True
            drivers.insert(0, f"HDL is {value:g}{unit or ' mg/dL'}, a lipid value to discuss in context.")
    if ldl is not None:
        value, unit = ldl
        if value >= 160:
            risk += 7
            lab_discussion = True
            drivers.insert(0, f"LDL is {value:g}{unit or ' mg/dL'}, a lipid value to discuss in context.")
    if lab_discussion:
        recs.insert(0, "Bring recent lab values or repeated blood-pressure readings to a clinician for context.")
    elif a1c is None and fasting_glucose is None and (risk >= 32 or bmi is not None and bmi >= 25 or u.age is not None and u.age >= 45):
        recs.insert(0, "Consider asking your clinician about A1C or fasting glucose.")
    if activity_gap and not any("active days" in r.lower() for r in recs):
        recs.append("Use exercise as the main lever: add short walks after meals and keep resistance training in the week.")
    if not recs:
        recs.append("Keep cardio, resistance training, fiber, protein, and sleep consistent.")

    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(
            min(max(f.coverage["activity"], 0.2), max(f.coverage["nutrition"], 0.2)),
            0.35 if bmi is not None else 0.0,
        ),
        corroborating_signals=len(drivers),
    )
    if a1c is None and fasting_glucose is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Risk-signal confidence is capped without A1C or fasting glucose labs",
        )
    return InsightCard(
        id="cardiometabolic_risk_signals",
        title="Cardiometabolic risk signals",
        category="health_risk_signals",
        status=_risk_signal_status(final),
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary=(
            "Cardiometabolic means heart-and-metabolism patterns: blood-sugar support, "
            "blood pressure, blood fats, body-weight trends, and daily movement. "
            "This card checks age/sex context, body-size or weight trend, activity, "
            "cardio, resistance training, added sugar, fiber, sleep, blood pressure, "
            "and optional A1C, fasting-glucose, and lipid labs when available."
        ),
        drivers=drivers[:4],
        positive_factors=positives[:4],
        recommendations=_recommendation_limit(list(dict.fromkeys(recs))),
        disclaimer=CARDIOMETABOLIC_RISK_DISCLAIMER,
        data_used=_domains(
            body=bmi is not None or h.weight_trend_lbs_per_week is not None,
            profile=u.age is not None or u.sex is not None or u.known_pcos is not None or u.gestational_diabetes_history is not None,
            activity=active_days is not None or a.avg_steps is not None,
            workouts=w.completed_sessions > 0,
            nutrition=n.days_with_data > 0,
            sleep=s.avg_hours is not None,
            checkins=h.bp_reading_count > 0,
            labs=a1c is not None or fasting_glucose is not None or triglycerides is not None or hdl is not None or ldl is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_blood_pressure_sodium_risk_signal(ctx: InsightContext) -> InsightCard:
    n, a, h = ctx.nutrition, ctx.activity, ctx.health
    f = _features(ctx)
    meals = f.meals
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sodium logs", n.avg_sodium_mg is not None),
        ("potassium or potassium-rich food pattern", n.avg_potassium_mg is not None or meals.potassium_proxy_days > 0),
        ("fiber", n.avg_fiber_g is not None),
        ("activity", a.avg_steps is not None or a.avg_cardio_minutes is not None),
        ("blood pressure readings", h.bp_reading_count > 0),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        confidence, reasons = _confidence(present, missing)
        return InsightCard(
            id="blood_pressure_sodium_risk_signal",
            title="Blood pressure & sodium signals",
            category="health_risk_signals",
            status="unknown",
            score=0,
            risk_direction="higher_is_worse",
            confidence=confidence,
            confidence_reasons=reasons,
            summary="Recent data is too sparse to read blood-pressure and sodium-related patterns.",
            drivers=[],
            positive_factors=[],
            recommendations=["Log meals, activity, and optional blood-pressure readings to sharpen this signal."],
            disclaimer=DISCLAIMER,
            data_used=[],
            missing_data=missing,
            generated_at=ctx.generated_at,
            display_score=None,
        )

    risk = 16.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if n.avg_sodium_mg is not None:
        if n.avg_sodium_mg >= 3500:
            risk += 24
            drivers.append(f"Sodium averages about {n.avg_sodium_mg:.0f}mg/day on logged days.")
            recs.append("Choose a lower-sodium version of one recurring meal this week.")
        elif n.avg_sodium_mg <= 2600:
            risk -= 8
            positives.append("Sodium is closer to a moderate range in logged meals.")
    if n.avg_potassium_mg is not None:
        if n.avg_potassium_mg < 2500:
            risk += 10
            drivers.append(f"Potassium averages about {n.avg_potassium_mg:.0f}mg on micronutrient-logged days.")
        elif n.avg_potassium_mg >= 3000:
            risk -= 8
            positives.append("Structured potassium intake is present in logged micronutrients.")
    elif meals.potassium_proxy_days >= 5:
        risk -= 5
        positives.append(f"Potassium-proxy foods appeared on {meals.potassium_proxy_days} days.")
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 18:
            risk += 8
            drivers.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, so plant-food support is limited.")
        elif n.avg_fiber_g >= 25:
            risk -= 6
            positives.append("Fiber is in a supportive range.")
    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            risk += 8
            drivers.append(f"Average steps are about {a.avg_steps:.0f}/day.")
        elif a.avg_steps >= 7500:
            risk -= 6
            positives.append("Daily steps support blood-pressure habits.")
    if a.avg_cardio_minutes is not None and a.avg_cardio_minutes * 7 >= CARDIO_GUIDELINE_MINUTES_WEEK:
        risk -= 8
        positives.append("Cardio minutes are consistent enough to support blood-pressure habits.")
    if h.bp_reading_count > 0 and h.latest_bp_systolic is not None and h.latest_bp_diastolic is not None:
        systolic = h.median_bp_systolic or h.latest_bp_systolic
        diastolic = h.median_bp_diastolic or h.latest_bp_diastolic
        if systolic >= 130 or diastolic >= 80:
            risk += 26
            drivers.append(f"Recent blood-pressure readings center near {systolic:.0f}/{diastolic:.0f}; discuss repeated values with a clinician.")
            recs.append("If elevated readings repeat, ask a clinician how to interpret them.")
        else:
            positives.append("Recent blood-pressure reading is inside the app's wellness target.")
    if not recs:
        recs.append("Keep sodium moderate, include potassium-rich plants, and maintain cardio and steps.")
    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["activity"], 0.2)),
        corroborating_signals=len(drivers),
    )
    if n.avg_potassium_mg is None and meals.potassium_proxy_days:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Potassium support is inferred from food tags rather than structured potassium values",
        )
    return InsightCard(
        id="blood_pressure_sodium_risk_signal",
        title="Blood pressure & sodium signals",
        category="health_risk_signals",
        status=_risk_signal_status(final),
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews sodium, potassium/fiber support, activity, and optional blood-pressure readings as non-diagnostic risk signals.",
        drivers=drivers[:4],
        positive_factors=positives[:4],
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.avg_sodium_mg is not None or n.avg_fiber_g is not None,
            micronutrients=n.avg_potassium_mg is not None,
            activity=a.avg_steps is not None or a.avg_cardio_minutes is not None,
            checkins=h.bp_reading_count > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_glp1_muscle_preservation_signal(ctx: InsightContext) -> InsightCard:
    n, a, w, h, u = ctx.nutrition, ctx.activity, ctx.workouts, ctx.health, ctx.user
    f = _features(ctx)
    protein_lb = _protein_g_per_lb(n, u)
    calorie_ratio = _calorie_ratio(n)
    water_ratio = None
    if n.avg_water_oz is not None and n.estimated_hydration_target_oz:
        water_ratio = n.avg_water_oz / n.estimated_hydration_target_oz
    resistance_days = w.resistance_sessions_14d / 2.0 if w.resistance_sessions_14d else 0.0
    low_appetite = u.glp1_appetite in {"reduced", "very_low"} or "low_appetite" in set(u.glp1_side_effects)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("GLP-1 support setting", u.glp1_support_enabled),
        ("protein logs", n.avg_protein_g is not None),
        ("body weight", u.weight_lbs is not None),
        ("resistance training", w.completed_sessions > 0),
        ("fiber", n.avg_fiber_g is not None),
        ("hydration", n.avg_water_oz is not None),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
        ("calorie alignment", calorie_ratio is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        confidence, reasons = _confidence(present, missing)
        return InsightCard(
            id="glp1_muscle_preservation_signal",
            title="GLP-1 muscle-preservation signals",
            category="health_risk_signals",
            status="unknown",
            score=0,
            risk_direction="higher_is_worse",
            confidence=confidence,
            confidence_reasons=reasons,
            summary="GLP-1 support mode is enabled, but recent logs are too sparse to read muscle-preservation patterns.",
            drivers=[],
            positive_factors=[],
            recommendations=["Log protein, resistance training, hydration, and weight trend to make this signal useful."],
            disclaimer="This is lifestyle support only, not medication, dosing, or medical advice.",
            data_used=_domains(profile=u.glp1_support_enabled),
            missing_data=missing,
            generated_at=ctx.generated_at,
            display_score=None,
        )
    risk = 18.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if low_appetite:
        risk += 8
        drivers.append("Reduced appetite is logged, so protein and hydration consistency matter more.")
    if protein_lb is not None:
        if protein_lb < 0.6:
            risk += 26
            drivers.append(f"Protein is about {protein_lb:.2f} g/lb, below a muscle-preservation support band.")
            recs.append("Use smaller protein-first meals or shakes to close the protein gap.")
        elif protein_lb < 0.75:
            risk += 12
            drivers.append(f"Protein is about {protein_lb:.2f} g/lb, leaving room to strengthen lean-mass support.")
        else:
            risk -= 12
            positives.append("Protein per pound is in a supportive range.")
    elif n.avg_protein_g is not None and n.protein_target_g:
        if n.avg_protein_g < n.protein_target_g * 0.8:
            risk += 18
            drivers.append("Protein is below target on tracked days.")
    if resistance_days < 2:
        risk += 20
        drivers.append("Resistance training is below 2 days/week, which weakens muscle-preservation support.")
        recs.append("Keep at least 2 resistance sessions/week, even with reduced volume.")
    else:
        risk -= 14
        positives.append("Resistance training is consistent, a key muscle-preservation signal.")
    if h.weight_trend_lbs_per_week is not None:
        if h.weight_trend_lbs_per_week < -1.5:
            risk += 14
            drivers.append(f"Weight is trending down about {abs(h.weight_trend_lbs_per_week):.1f} lb/week, a faster-loss pattern to watch.")
        elif -1.5 <= h.weight_trend_lbs_per_week <= -0.25:
            positives.append("Weight trend is gradual rather than rapid.")
    if calorie_ratio is not None and calorie_ratio < 0.75:
        risk += 12
        drivers.append("Calories are far below target on logged days.")
        recs.append("Add an easy protein-and-fiber snack on low-appetite days.")
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 18:
            risk += 8
            drivers.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, so fullness and digestion support may be uneven.")
        elif n.avg_fiber_g >= 25:
            risk -= 5
            positives.append("Fiber is in a supportive range.")
    if water_ratio is not None:
        if water_ratio < 0.75:
            risk += 8
            drivers.append("Hydration logs are below the estimated target.")
        elif water_ratio >= 0.9:
            risk -= 5
            positives.append("Hydration logs are close to the estimated target.")
    if not recs:
        recs.append("Keep protein, resistance training, fiber, and hydration steady during weight changes.")
    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(f.coverage["nutrition"], f.coverage["workouts"], 0.2),
        corroborating_signals=len(drivers),
    )
    return InsightCard(
        id="glp1_muscle_preservation_signal",
        title="GLP-1 muscle-preservation signals",
        category="health_risk_signals",
        status=_risk_signal_status(final),
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews lifestyle patterns that support lean mass while GLP-1 support mode is enabled.",
        drivers=drivers[:4],
        positive_factors=positives[:4],
        recommendations=_recommendation_limit(recs),
        disclaimer="This is lifestyle support only, not medication, dosing, or medical advice.",
        data_used=_domains(
            profile=u.glp1_support_enabled,
            nutrition=n.days_with_data > 0,
            hydration=n.avg_water_oz is not None,
            workouts=w.completed_sessions > 0,
            apple_health=h.weight_trend_lbs_per_week is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_cholesterol_support_pattern(ctx: InsightContext) -> InsightCard:
    n = ctx.nutrition
    f = _features(ctx)
    meals = f.meals
    sat_pct = _saturated_fat_pct_calories(n)
    plant_pct = _plant_protein_pct(n)
    ldl = _lab_value(ctx.health, "ldl")
    hdl = _lab_value(ctx.health, "hdl")
    triglycerides = _lab_value(ctx.health, "triglycerides")
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("saturated fat", sat_pct is not None),
        ("fiber", n.avg_fiber_g is not None),
        ("protein-source split", plant_pct is not None),
        ("seafood/omega-3 pattern", n.omega3_servings > 0 or n.seafood_servings > 0 or n.insight_enriched_item_count > 0),
        ("processed meat", n.processed_meat_servings > 0 or n.insight_enriched_item_count > 0),
        ("cholesterol labs", ldl is not None or hdl is not None or triglycerides is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="cholesterol_support_pattern",
            title="Cholesterol Support Pattern",
            category="cholesterol",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals with saturated-fat, fiber, and protein-source detail to unlock this pattern.",
        )

    score = 78.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if sat_pct is not None:
        if sat_pct >= 12:
            score -= 28
            drivers.append(f"Saturated fat is about {sat_pct:.0f}% of logged calories.")
            recs.append("Swap one high-saturated-fat meal toward olive oil, fish, beans, lentils, nuts, or lean poultry.")
        elif sat_pct >= 8:
            score -= 15
            drivers.append(f"Saturated fat is above the heart-health support target at about {sat_pct:.0f}% of calories.")
        elif sat_pct <= 6:
            positives.append("Saturated fat is within the AHA-style support range.")
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 18:
            score -= 14
            drivers.append(f"Fiber averages {n.avg_fiber_g:.0f}g/day, so cholesterol support is thinner.")
        elif n.avg_fiber_g >= 28:
            positives.append("Fiber intake supports cholesterol-friendly eating.")
    if plant_pct is not None:
        if plant_pct < 25 and (n.avg_animal_protein_g or 0) >= 70:
            score -= 8
            drivers.append("Protein is mostly animal-sourced in the logged window.")
        elif plant_pct >= 35:
            positives.append("Plant protein is a meaningful share of logged protein.")
    if n.omega3_servings + n.seafood_servings < 1:
        score -= 8
        drivers.append("Seafood or omega-3-rich foods were not detected.")
    elif n.omega3_servings + n.seafood_servings >= 2:
        positives.append("Seafood or omega-3-rich foods showed up in the window.")
    if n.processed_meat_servings >= 1:
        score -= 6
        drivers.append("Processed meat adds saturated-fat and sodium pressure.")
    if ldl is not None:
        if ldl >= 130:
            score -= 12
            drivers.append("Latest LDL is above the app's screening-support target; this is context, not a diagnosis.")
        elif ldl < 100:
            positives.append("Latest LDL is within the app's screening-support target.")
    if triglycerides is not None and triglycerides >= 150:
        score -= 8
        drivers.append("Latest triglycerides are above the app's screening-support target.")
    signals: list[EvidenceSignal] = []
    sat_metric = f.metrics["saturated_fat_g"]
    fiber_metric = f.metrics["fiber_g"]
    if sat_metric.days_above_threshold >= 4:
        trend = " and increased versus the prior window" if (sat_metric.delta_abs or 0) > 3 else ""
        signals.append(_signal(
            "sat_fat_persistence",
            "Persistent saturated fat",
            "risk",
            min(1.0, sat_metric.days_above_threshold / 8.0),
            sat_metric.coverage_14,
            14,
            f"Saturated fat was high on {sat_metric.days_above_threshold} logged days{trend}.",
        ))
    if meals.processed_meat_servings_14 >= 2:
        signals.append(_signal(
            "processed_meat_cholesterol",
            "Processed meat pattern",
            "risk",
            min(1.0, meals.processed_meat_servings_14 / 5.0),
            f.coverage["nutrition"],
            6,
            f"Processed meat totaled about {meals.processed_meat_servings_14 * PROCESSED_MEAT_RISK_UNIT_G:.0f}g, adding saturated-fat and sodium pressure.",
        ))
    if fiber_metric.delta_abs is not None and fiber_metric.delta_abs <= -4:
        signals.append(_signal(
            "fiber_drop",
            "Fiber decreased",
            "risk",
            min(1.0, abs(fiber_metric.delta_abs) / 10.0),
            fiber_metric.coverage_14,
            7,
            f"Fiber is down about {abs(fiber_metric.delta_abs):.0f}g/day versus the prior 14 days.",
        ))
    soluble_proxy_days = meals.legume_days + meals.whole_grain_days + meals.citrus_count
    if soluble_proxy_days >= 5:
        signals.append(_signal(
            "soluble_fiber_proxy",
            "Soluble-fiber proxy foods",
            "protective",
            min(1.0, soluble_proxy_days / 8.0),
            f.coverage["nutrition"],
            10,
            f"Oats/whole grains, legumes, or citrus appeared on {soluble_proxy_days} occasions.",
        ))
    if meals.nut_seed_days + meals.unsaturated_fat_source_days >= 5:
        signals.append(_signal(
            "unsaturated_fat_sources",
            "Unsaturated fat sources",
            "protective",
            min(1.0, (meals.nut_seed_days + meals.unsaturated_fat_source_days) / 8.0),
            f.coverage["nutrition"],
            8,
            "Nuts/seeds, olive oil, avocado, or fatty fish appeared repeatedly.",
        ))
    if meals.seafood_days >= 2:
        signals.append(_signal(
            "seafood_support",
            "Seafood support",
            "protective",
            min(1.0, meals.seafood_days / 3.0),
            f.coverage["nutrition"],
            7,
            f"Seafood appeared on {meals.seafood_days} days.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep emphasizing fiber-rich plants and unsaturated fat sources.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=f.coverage["nutrition"],
        corroborating_signals=_corroborating_count(signals),
    )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="cholesterol_support_pattern",
        title="Cholesterol Support Pattern",
        category="cholesterol",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews diet signals associated with LDL/cholesterol support. It does not estimate cholesterol labs.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            food_enrichment=n.insight_enriched_item_count > 0,
            labs=ldl is not None or hdl is not None or triglycerides is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_recovery_strain(ctx: InsightContext) -> InsightCard:
    n, s, a, w, h = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health
    f = _features(ctx)
    recovery = f.recovery
    fueling = f.fueling
    workout_features = f.workouts
    meals = f.meals
    present: list[str] = []
    missing: list[str] = []
    if s.avg_hours is not None:
        present.append("sleep duration")
    else:
        missing.append("sleep duration")
    if h.rhr_latest is not None and h.rhr_baseline is not None:
        present.append("resting heart rate trend")
    else:
        missing.append("resting heart rate trend")
    if h.hrv_latest is not None and h.hrv_baseline is not None:
        present.append("HRV trend")
    else:
        missing.append("HRV trend")
    if w.completed_sessions > 0 or w.planned_sessions_14d > 0:
        present.append("training load")
    else:
        missing.append("recent workouts")
    if n.avg_calories_when_logged is not None and n.calorie_target is not None:
        present.append("calorie alignment")
    else:
        missing.append("calorie target and logs")
    if n.post_workout_timing_sessions > 0:
        present.append("post-workout meal timing")
    else:
        missing.append("post-workout meal timing")
    if not present:
        return _unknown_card(
            card_id="recovery_strain",
            title="Recovery Strain",
            category="recovery",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log sleep, workouts, and meals for a week to unlock recovery strain patterns.",
        )

    risk = 18.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if s.avg_hours is not None:
        if s.avg_hours < 6:
            risk += 25
            drivers.append(f"Average sleep is {s.avg_hours:.1f}h, which is a strong recovery strain signal.")
            recs.append("Protect a longer sleep window for the next two nights before adding intensity.")
        elif s.avg_hours < 7:
            risk += 12
            drivers.append(f"Average sleep is {s.avg_hours:.1f}h, below the usual recovery-support range.")
        else:
            positives.append(f"Sleep average is {s.avg_hours:.1f}h.")
    if s.bedtime_std_minutes is not None:
        if s.bedtime_std_minutes > 90:
            risk += 8
            drivers.append("Sleep timing has been inconsistent across the window.")
        elif s.bedtime_std_minutes < 45:
            positives.append("Bedtime timing looks fairly consistent.")

    rhr = _rhr_delta(h)
    if rhr is not None:
        if rhr >= 6:
            risk += 15
            drivers.append(f"Resting heart rate is about {rhr:.0f} bpm above recent baseline.")
        elif rhr <= 2:
            positives.append("Resting heart rate is close to baseline.")
    hrv = _hrv_ratio(h)
    if hrv is not None:
        if hrv <= 0.85:
            risk += 15
            drivers.append("HRV is below recent baseline.")
        elif hrv >= 0.95:
            positives.append("HRV is near recent baseline.")

    if w.acute_load_ratio is not None:
        if w.acute_load_ratio >= 1.5:
            risk += 18
            drivers.append("Recent workload is well above the prior four-week pace.")
            recs.append("Keep today's effort easy or trim volume until load normalizes.")
        elif w.acute_load_ratio >= 1.25:
            risk += 10
            drivers.append("Recent workload is above your recent baseline.")
        elif 0.75 <= w.acute_load_ratio <= 1.2:
            positives.append("Training load is close to the recent baseline.")
    if w.hard_sessions_7d >= 4:
        risk += 8
        drivers.append("Several hard sessions landed in the last week.")

    ratio = _calorie_ratio(n)
    if ratio is not None:
        if ratio < 0.82:
            risk += 12
            drivers.append("Logged intake is far below target on tracked days.")
            recs.append("Add a carb-forward meal around training if appetite allows.")
        elif ratio >= 0.95:
            positives.append("Calories look close to target on tracked days.")

    signals: list[EvidenceSignal] = []
    if s.avg_hours is not None and s.avg_hours < 6.5:
        signals.append(_signal(
            "short_sleep_average",
            "Short sleep average",
            "risk",
            min(1.0, (6.5 - s.avg_hours) / 1.5),
            f.coverage["sleep"],
            10,
            f"Average sleep is {s.avg_hours:.1f}h across logged nights.",
        ))
    if recovery.sleep_debt_7d is not None and recovery.sleep_debt_7d >= 5:
        signals.append(_signal(
            "sleep_debt_7d",
            "Sleep debt",
            "risk",
            min(1.0, recovery.sleep_debt_7d / 10.0),
            f.coverage["sleep"],
            10,
            f"Sleep debt is about {recovery.sleep_debt_7d:.1f} hours over the last 7 nights.",
        ))
    if recovery.hrv_suppression_days >= 2 or recovery.rhr_elevation_days >= 2:
        signals.append(_signal(
            "biomarker_strain_days",
            "HRV/RHR strain",
            "risk",
            min(1.0, (recovery.hrv_suppression_days + recovery.rhr_elevation_days) / 5.0),
            f.coverage["apple_health"],
            12,
            f"HRV/RHR strain appeared on {recovery.hrv_suppression_days + recovery.rhr_elevation_days} recent days.",
        ))
    elif (recovery.hrv_ratio_to_baseline is not None and recovery.hrv_ratio_to_baseline <= 0.85) or (
        recovery.rhr_delta_to_baseline is not None and recovery.rhr_delta_to_baseline >= 6
    ):
        signals.append(_signal(
            "latest_biomarker_strain",
            "Latest HRV/RHR strain",
            "risk",
            0.7,
            f.coverage["apple_health"],
            10,
            "Latest HRV/RHR is strained versus baseline.",
        ))
    if workout_features.hard_sessions_14d >= 4:
        signals.append(_signal(
            "hard_session_cluster",
            "Hard-session cluster",
            "risk",
            min(1.0, workout_features.hard_sessions_14d / 6.0),
            f.coverage["workouts"],
            8,
            f"Hard sessions clustered {workout_features.hard_sessions_14d} times in the last 14 days.",
        ))
    elif w.hard_sessions_7d >= 4:
        signals.append(_signal(
            "hard_sessions_7d",
            "Recent hard sessions",
            "risk",
            min(1.0, w.hard_sessions_7d / 6.0),
            f.coverage["workouts"],
            8,
            f"{w.hard_sessions_7d} hard sessions landed in the last week.",
        ))
    if fueling.hard_day_deficit_days >= 2:
        signals.append(_signal(
            "hard_day_deficit",
            "Under-fueled hard days",
            "risk",
            min(1.0, fueling.hard_day_deficit_days / 4.0),
            f.coverage["nutrition"],
            8,
            f"Calorie gaps overlapped hard training on {fueling.hard_day_deficit_days} days.",
        ))
    elif ratio is not None and ratio < 0.82 and w.hard_sessions_7d >= 2:
        signals.append(_signal(
            "aggregate_intake_gap_training",
            "Intake gap plus training",
            "risk",
            min(1.0, (0.82 - ratio) / 0.25),
            f.coverage["nutrition"],
            8,
            "Tracked intake is low while hard training is present.",
        ))
    if workout_features.today_is_demanding and (recovery.sleep_last_night or 8) < 6.5:
        signals.append(_signal(
            "today_demand_short_sleep",
            "Today-specific demand",
            "risk",
            0.7,
            min(f.coverage["sleep"], f.coverage["workouts"]),
            8,
            "Today's planned session is demanding and follows a short sleep night, so the strain is session-specific.",
        ))
    if fueling.missed_post_workout_fueling_sessions >= 2:
        signals.append(_signal(
            "missed_post_workout_fueling",
            "Post-workout fueling delay",
            "risk",
            min(1.0, fueling.missed_post_workout_fueling_sessions / 4.0),
            f.coverage["nutrition"],
            7,
            f"Post-workout meals were delayed or light on protein/carbs after {fueling.missed_post_workout_fueling_sessions} timestamped workouts.",
        ))
    if meals.structured_late_caffeine_count >= 2:
        signals.append(_signal(
            "structured_late_caffeine_recovery",
            "Late caffeine",
            "risk",
            min(1.0, meals.structured_late_caffeine_count / 4.0),
            f.coverage["nutrition"],
            5,
            "Structured caffeine timing shows repeated later-day caffeine, which can add sleep/recovery variability.",
        ))
    if workout_features.deload_detected:
        signals.append(_signal(
            "deload_detected",
            "Deload detected",
            "protective",
            0.8,
            f.coverage["workouts"],
            10,
            "Recent load looks like a deload, which softens recovery strain.",
        ))
    risk = _apply_evidence(risk, signals, risk_direction="higher_is_worse")
    risk_signal_count = _corroborating_count(signals)
    if risk_signal_count < 2 and risk > 64:
        risk = 64
        drivers.append("Severity is capped because the strain is not corroborated across multiple systems.")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Use the card as a trend check and keep today's warmup short and dynamic.")
    score = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["sleep"], 0.2), max(f.coverage["workouts"], 0.2), max(f.coverage["nutrition"], 0.2)),
        corroborating_signals=risk_signal_count,
    )
    status = _status_from_score(score, risk_direction="higher_is_worse")
    return InsightCard(
        id="recovery_strain",
        title="Recovery Strain",
        category="recovery",
        status=status,
        score=score,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary=f"Recovery strain reads {status} based on sleep, load, nutrition, and available Apple Health trends.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.avg_hours is not None,
            workouts=w.completed_sessions > 0 or w.planned_sessions_14d > 0,
            nutrition=ratio is not None,
            apple_health=rhr is not None or hrv is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


HORMONE_SUPPORT_BASE_SCORE = 76.0
HORMONE_SLEEP_PENALTY_MAX = 20.0
HORMONE_SLEEP_RAMP_START_HOURS = 6.75
HORMONE_SLEEP_RAMP_END_HOURS = 5.5
HORMONE_CALORIE_PENALTY_MAX = 22.0
HORMONE_CALORIE_RAMP_START_RATIO = 0.92
HORMONE_CALORIE_RAMP_END_RATIO = 0.72
HORMONE_FAT_PENALTY_MAX = 12.0
HORMONE_FAT_RAMP_START_PCT = 0.22
HORMONE_FAT_RAMP_END_PCT = 0.14
HORMONE_SAT_FAT_PENALTY_MAX = 4.0
HORMONE_SAT_FAT_TRIGGER_RATIO = 0.12
HORMONE_SAT_FAT_RAMP_START_RATIO = 0.10
HORMONE_SAT_FAT_RAMP_END_RATIO = 0.18
HORMONE_WEIGHT_LOSS_START_PCT = 0.010
HORMONE_WEIGHT_LOSS_MAX_PCT = 0.0175
HORMONE_DOMAIN_CAPS = {
    "sleep_recovery": 30.0,
    "energy_fueling": 38.0,
    "fat_adequacy": 18.0,
    "training_recovery_load": 28.0,
    "weight_trend": 14.0,
    "diet_quality": 6.0,
    "alcohol_recovery": 8.0,
    "macro_adequacy": 16.0,
}
HORMONE_BONUS_CAPS = {
    "deload_recovery": 6.0,
    "resistance_training": 4.0,
    "diet_quality": 4.0,
    "fat_quality": 3.0,
}


def _hormone_fueling_ratio(n: NutritionSummary) -> tuple[float | None, str | None, float | None]:
    if not n.avg_calories_when_logged:
        return None, None, None
    # The insight context currently exposes the user's current calorie target.
    # It does not expose a separate maintenance/TDEE or training-adjusted need.
    if n.calorie_target:
        return n.avg_calories_when_logged / n.calorie_target, "calorie_target", n.calorie_target
    return None, None, None


def compute_hormone_support(ctx: InsightContext) -> InsightCard:
    n, s, w, h, u = ctx.nutrition, ctx.sleep, ctx.workouts, ctx.health, ctx.user
    f = _features(ctx)
    fueling = f.fueling
    recovery = f.recovery
    fat_pct = _fat_percent(n)
    ratio, ratio_source, ratio_denominator = _hormone_fueling_ratio(n)
    rhr = _rhr_delta(h)
    hrv = _hrv_ratio(h)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sleep duration", s.avg_hours is not None),
        ("calorie alignment", ratio is not None),
        ("dietary fat intake", fat_pct is not None),
        ("training load", w.completed_sessions > 0 or w.planned_sessions_14d > 0),
        ("HRV/RHR trends", rhr is not None or hrv is not None),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="hormone_support",
            title="Hormone Support Environment",
            category="recovery",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Track sleep and meals for several days so this can assess the support environment more honestly.",
        )

    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    penalty_totals: dict[str, float] = defaultdict(float)
    bonus_totals: dict[str, float] = defaultdict(float)
    penalty_items: list[dict[str, Any]] = []
    bonus_items: list[dict[str, Any]] = []
    signals: list[EvidenceSignal] = []

    def add_penalty(domain: str, key: str, amount: float, reason: str, recommendation: str | None = None) -> None:
        if amount <= 0:
            return
        penalty = float(amount)
        penalty_totals[domain] += penalty
        penalty_items.append({
            "key": key,
            "domain": domain,
            "raw_points": round(penalty, 2),
            "reason": reason,
        })
        drivers.append(reason)
        if recommendation:
            recs.append(recommendation)

    def add_bonus(domain: str, key: str, amount: float, reason: str) -> None:
        if amount <= 0:
            return
        bonus = float(amount)
        bonus_totals[domain] += bonus
        bonus_items.append({
            "key": key,
            "domain": domain,
            "raw_points": round(bonus, 2),
            "reason": reason,
        })
        positives.append(reason)

    def add_signal(domain: str, signal: EvidenceSignal) -> None:
        signals.append(signal)
        amount = signal.weight * signal.magnitude * signal.confidence
        if signal.direction == "risk":
            add_penalty(domain, signal.key, amount, signal.explanation)
        else:
            bonus_domain = domain if domain in HORMONE_BONUS_CAPS else "diet_quality"
            add_bonus(bonus_domain, signal.key, amount, signal.explanation)

    nutrition_coverage = f.coverage["nutrition"]
    sleep_coverage = f.coverage["sleep"]
    workout_coverage = f.coverage["workouts"]
    moderate_underfueling = ratio is not None and ratio < 0.92
    low_sleep_context = s.avg_hours is not None and s.avg_hours < 6.75
    severe_sleep_debt = s.avg_hours is not None and s.avg_hours < 6.0
    recovery_vitals_strained = (rhr is not None and rhr >= 5) or (hrv is not None and hrv <= 0.88)
    training_type_available = w.training_strain_confidence > 0
    hard_training_count = (
        w.hard_resistance_sessions_14d
        + w.hard_endurance_sessions_14d
        + w.hard_glycolytic_sessions_14d
    )

    if s.avg_hours is not None:
        sleep_penalty = HORMONE_SLEEP_PENALTY_MAX * _clamp01(
            (HORMONE_SLEEP_RAMP_START_HOURS - s.avg_hours)
            / (HORMONE_SLEEP_RAMP_START_HOURS - HORMONE_SLEEP_RAMP_END_HOURS)
        )
        add_penalty(
            "sleep_recovery",
            "short_sleep",
            sleep_penalty,
            f"Average sleep is {s.avg_hours:.1f}h, below your usual recovery-supportive range.",
            "Make sleep the first lever before pushing extra training volume.",
        )
        if s.avg_hours >= 7.2:
            positives.append("Sleep duration is in a supportive range for recovery.")
    if ratio is not None:
        calorie_penalty = HORMONE_CALORIE_PENALTY_MAX * _clamp01(
            (HORMONE_CALORIE_RAMP_START_RATIO - ratio)
            / (HORMONE_CALORIE_RAMP_START_RATIO - HORMONE_CALORIE_RAMP_END_RATIO)
        )
        add_penalty(
            "energy_fueling",
            "calorie_alignment",
            calorie_penalty,
            f"Tracked intake averages about {int(round(ratio * 100))}% of target; a large calorie gap makes the support environment less steady.",
            "Bring calories closer to target on hard training days first.",
        )
        if ratio >= 0.95:
            positives.append("Calories are close to target on tracked days, which supports recovery demand.")
    if n.avg_energy_availability is not None and n.avg_energy_availability < 30:
        add_penalty(
            "energy_fueling",
            "low_energy_availability",
            8.0 * _clamp01((30.0 - n.avg_energy_availability) / 10.0),
            "Energy availability looks low after training demand is accounted for.",
            "Use hard training days as the first place to close the energy gap.",
        )
    if fat_pct is not None:
        fat_penalty = HORMONE_FAT_PENALTY_MAX * _clamp01(
            (HORMONE_FAT_RAMP_START_PCT - fat_pct)
            / (HORMONE_FAT_RAMP_START_PCT - HORMONE_FAT_RAMP_END_PCT)
        )
        add_penalty(
            "fat_adequacy",
            "dietary_fat",
            fat_penalty,
            f"Dietary fat is about {int(round(fat_pct * 100))}% of tracked calories; very low fat intake weakens this support score.",
            "Include a steady fat source such as olive oil, eggs, dairy, nuts, or fatty fish if it fits your preferences.",
        )
        if fat_pct >= 0.22:
            positives.append("Dietary fat intake is in a supportive range on tracked days.")
    if rhr is not None:
        add_penalty(
            "training_recovery_load",
            "resting_hr_elevation",
            8.0 * _clamp01((rhr - 4.0) / 4.0),
            f"Resting heart rate is about {rhr:.0f} bpm above baseline, so recovery demand may be higher than usual.",
        )
    if hrv is not None:
        add_penalty(
            "training_recovery_load",
            "hrv_suppression",
            8.0 * _clamp01((0.95 - hrv) / 0.15),
            f"HRV is about {int(round(hrv * 100))}% of baseline, so the support score is more cautious.",
        )
    if h.weight_trend_lbs_per_week is not None and h.weight_trend_lbs_per_week < 0:
        weekly_loss = abs(h.weight_trend_lbs_per_week)
        if u.weight_lbs and u.weight_lbs > 0:
            weekly_loss_pct = weekly_loss / u.weight_lbs
            add_penalty(
                "weight_trend",
                "weight_loss_pace_pct",
                14.0 * _clamp01((weekly_loss_pct - HORMONE_WEIGHT_LOSS_START_PCT) / (HORMONE_WEIGHT_LOSS_MAX_PCT - HORMONE_WEIGHT_LOSS_START_PCT)),
                f"Recent weight loss pace is aggressive relative to body weight at about {weekly_loss_pct * 100:.1f}% per week.",
            )
        elif h.weight_trend_lbs_per_week < -1.5:
            add_penalty(
                "weight_trend",
                "weight_loss_pace_lbs",
                10.0 * _clamp01((weekly_loss - 1.5) / 1.0),
                f"Weight is trending down about {weekly_loss:.1f} lb/week, which suggests the current deficit may be aggressive.",
            )

    if w.acute_load_ratio is not None and w.acute_load_ratio >= 1.4:
        acute_base = 5.0 * _clamp01((w.acute_load_ratio - 1.2) / 0.6)
        add_penalty(
            "training_recovery_load",
            "acute_load_ratio",
            acute_base,
            "Recent training load is above baseline, so recovery demand is higher than usual.",
        )
        poor_context_count = sum(bool(v) for v in (moderate_underfueling, low_sleep_context, recovery_vitals_strained))
        if poor_context_count:
            add_penalty(
                "training_recovery_load",
                "acute_load_with_limited_recovery",
                min(8.0, acute_base * 0.8 + poor_context_count * 2.0),
                "The training-load jump overlaps with lower fueling, shorter sleep, or strained recovery vitals.",
                "Keep the next hard session flexible until sleep and fueling look steadier.",
            )

    if fueling.deficit_streak_days >= 4:
        add_signal("energy_fueling", _signal(
            "deficit_streak",
            "Sustained calorie gap",
            "risk",
            min(1.0, fueling.deficit_streak_days / 8.0),
            f.coverage["nutrition"],
            12,
            f"Calorie gaps persisted for {fueling.deficit_streak_days} days in a row.",
        ))
    if fueling.large_deficit_days_14 >= 3:
        add_signal("energy_fueling", _signal(
            "large_deficit_days",
            "Large deficit days",
            "risk",
            min(1.0, fueling.large_deficit_days_14 / 6.0),
            f.coverage["nutrition"],
            10,
            f"Large calorie gaps appeared on {fueling.large_deficit_days_14} logged days.",
        ))
    if fueling.low_fat_days_14 >= 4:
        add_signal("fat_adequacy", _signal(
            "low_fat_persistence",
            "Low dietary fat persistence",
            "risk",
            min(1.0, fueling.low_fat_days_14 / 8.0),
            f.coverage["nutrition"],
            9,
            f"Dietary fat was very low on {fueling.low_fat_days_14} days, so this support score stays cautious.",
        ))
    if recovery.sleep_debt_14d is not None and recovery.sleep_debt_14d >= 8:
        add_signal("sleep_recovery", _signal(
            "sleep_debt_hormone_support",
            "Sleep debt",
            "risk",
            min(1.0, recovery.sleep_debt_14d / 16.0),
            f.coverage["sleep"],
            9,
            f"Sleep debt is about {recovery.sleep_debt_14d:.1f} hours over 14 days.",
        ))
    if f.workouts.hard_sessions_14d >= 5 and (ratio is None or ratio < 0.95):
        add_signal("training_recovery_load", _signal(
            "load_plus_intake_gap",
            "Training load plus intake gap",
            "risk",
            min(1.0, f.workouts.hard_sessions_14d / 7.0),
            min(f.coverage["workouts"], f.coverage["nutrition"]),
            8,
            "High training demand overlaps with an intake gap, which is a shared root cause for recovery cards.",
        ))

    carb_floor = None
    carb_floor_reason = ""
    if training_type_available:
        if w.long_endurance_or_two_a_day_sessions_14d > 0:
            carb_floor = 4.0
            carb_floor_reason = "long endurance or two-a-day training"
        elif w.hard_endurance_sessions_14d > 0 or w.hard_glycolytic_sessions_14d > 0:
            carb_floor = 3.0
            carb_floor_reason = "recent endurance, interval, or conditioning work"
        elif w.hard_resistance_sessions_14d > 0:
            carb_floor = 2.0
            carb_floor_reason = "recent hard resistance training"
    carb_g_per_kg = fueling.carb_g_per_kg_on_hard_days or fueling.carb_g_per_kg
    if carb_floor is not None and carb_g_per_kg is not None and carb_g_per_kg < carb_floor:
        carb_confidence = min(1.0, max(0.35, w.training_strain_confidence) * max(0.35, nutrition_coverage))
        add_penalty(
            "macro_adequacy",
            "carb_availability",
            10.0 * _clamp01((carb_floor - carb_g_per_kg) / carb_floor) * carb_confidence,
            f"Carbohydrate intake looks low for {carb_floor_reason}.",
            "Put most added carbs around the hardest sessions first.",
        )
    elif not training_type_available and fueling.carb_g_per_kg_on_hard_days is not None and fueling.carb_g_per_kg_on_hard_days < 2.0 and w.hard_sessions_7d >= 2:
        add_signal("macro_adequacy", _signal(
            "low_carbs_hard_days",
            "Low carbs on hard days",
            "risk",
            0.7,
            nutrition_coverage,
            8,
            "Carbohydrate intake on hard training days looks low for recovery support.",
        ))

    protein_g_per_kg = fueling.protein_g_per_kg
    protein_context_warrants = (
        moderate_underfueling
        or (h.weight_trend_lbs_per_week is not None and h.weight_trend_lbs_per_week < -0.75)
        or hard_training_count >= 2
        or w.training_strain_points_14d >= 2.4
    )
    if protein_g_per_kg is not None and protein_context_warrants:
        if protein_g_per_kg < 1.2:
            add_penalty(
                "macro_adequacy",
                "protein_adequacy",
                8.0 * _clamp01((1.2 - protein_g_per_kg) / 0.4),
                f"Protein averages about {protein_g_per_kg:.1f} g/kg during a period where training or deficit context makes adequacy more important.",
                "Anchor each meal with protein while the deficit or hard training block continues.",
            )
        elif protein_g_per_kg < 1.6:
            add_penalty(
                "macro_adequacy",
                "protein_adequacy_mild",
                4.0 * _clamp01((1.6 - protein_g_per_kg) / 0.4),
                f"Protein is moderate at about {protein_g_per_kg:.1f} g/kg while recovery demand is elevated.",
            )
    if (
        protein_g_per_kg is not None
        and protein_g_per_kg >= 1.6
        and ratio is not None
        and ratio >= 0.9
        and not severe_sleep_debt
        and not recovery_vitals_strained
    ):
        add_bonus(
            "resistance_training",
            "protein_adequacy",
            2.5,
            "Protein intake is adequate while calories and recovery markers look reasonably steady.",
        )

    if training_type_available:
        poor_context_count = sum(bool(v) for v in (moderate_underfueling, low_sleep_context, recovery_vitals_strained))
        if w.training_strain_points_14d >= 4.5 and poor_context_count:
            add_penalty(
                "training_recovery_load",
                "training_strain_context",
                min(10.0, (w.training_strain_points_14d - 3.5) * 1.8 + poor_context_count * 1.5),
                "Recent hard training becomes more demanding because it overlaps with limited sleep, fueling, or recovery-vital support.",
            )
        elif w.training_strain_points_14d >= 7.0:
            add_penalty(
                "training_recovery_load",
                "very_high_training_strain",
                min(4.0, (w.training_strain_points_14d - 6.5) * 1.2),
                "Recent training strain is very high, so the score stays slightly cautious even without clear recovery gaps.",
            )
    elif w.hard_sessions_7d >= 4 and (moderate_underfueling or low_sleep_context or recovery_vitals_strained):
        add_penalty(
            "training_recovery_load",
            "hard_sessions_fallback",
            min(8.0, w.hard_sessions_7d * 1.5),
            "Several recent hard sessions overlap with lower fueling, shorter sleep, or strained recovery vitals.",
        )

    fiber_supported = n.avg_fiber_g is not None or n.avg_fiber_per_1000_kcal is not None
    if fiber_supported:
        fiber_penalty = 0.0
        if n.avg_fiber_g is not None and n.avg_fiber_g < 18:
            fiber_penalty = max(fiber_penalty, 4.0 * _clamp01((18.0 - n.avg_fiber_g) / 8.0))
        if n.avg_fiber_per_1000_kcal is not None and n.avg_fiber_per_1000_kcal < 8:
            fiber_penalty = max(fiber_penalty, 3.0 * _clamp01((8.0 - n.avg_fiber_per_1000_kcal) / 4.0))
        add_penalty(
            "diet_quality",
            "fiber_adequacy",
            fiber_penalty,
            "Fiber intake looks low, so diet quality is a small limiting factor.",
        )
    if n.ultra_processed_pct is not None and n.ultra_processed_pct >= 60:
        add_penalty(
            "diet_quality",
            "ultra_processed_pattern",
            3.0 * _clamp01((n.ultra_processed_pct - 55.0) / 35.0),
            "A large share of classified logged foods appears highly processed, which lightly limits diet-quality support.",
        )
    if (
        n.avg_fiber_g is not None
        and n.avg_fiber_g >= 25
        and (n.distinct_plant_foods_week >= 8 or f.meals.whole_grain_days + f.meals.legume_days + f.meals.seafood_days >= 3)
    ):
        add_bonus(
            "diet_quality",
            "fiber_and_variety",
            3.0,
            "Fiber and food variety look supportive in recent logs.",
        )
    saturated_pct = _saturated_fat_pct_calories(n)
    saturated_ratio = saturated_pct / 100.0 if saturated_pct is not None else None
    if saturated_ratio is not None and saturated_ratio >= HORMONE_SAT_FAT_TRIGGER_RATIO and f.meals.unsaturated_fat_source_days <= 1:
        add_penalty(
            "fat_adequacy",
            "fat_quality",
            HORMONE_SAT_FAT_PENALTY_MAX * _clamp01(
                (saturated_ratio - HORMONE_SAT_FAT_RAMP_START_RATIO)
                / (HORMONE_SAT_FAT_RAMP_END_RATIO - HORMONE_SAT_FAT_RAMP_START_RATIO)
            ),
            "Fat quality looks less balanced because saturated fat is high while unsaturated-fat sources are sparse.",
        )
    if fat_pct is not None and 0.22 <= fat_pct <= 0.38 and f.meals.unsaturated_fat_source_days >= 2:
        add_bonus(
            "fat_quality",
            "unsaturated_fat_sources",
            3.0,
            "Dietary fat intake is in range and includes unsaturated-fat sources.",
        )

    alcohol_events = len(n.alcohol_dates)
    alcohol_avg = n.avg_alcohol_servings
    if (alcohol_events > 0 or (alcohol_avg is not None and alcohol_avg > 0)) and (
        bool(n.alcohol_dates & w.hard_session_dates)
        or bool(n.alcohol_dates & {d - timedelta(days=1) for d in w.hard_session_dates})
        or low_sleep_context
        or recovery_vitals_strained
        or w.training_strain_points_14d >= 4.5
    ):
        alcohol_amount = 2.0 + min(4.0, float(alcohol_events or 0))
        if alcohol_avg is not None:
            alcohol_amount += min(2.0, alcohol_avg * 2.0)
        add_penalty(
            "alcohol_recovery",
            "alcohol_recovery_overlap",
            min(8.0, alcohol_amount),
            "Alcohol appears near harder training or strained recovery signals, so recovery support is more cautious.",
        )

    resistance_count = w.resistance_sessions_14d or w.hard_resistance_sessions_14d
    if (
        3 <= resistance_count <= 8
        and protein_g_per_kg is not None
        and protein_g_per_kg >= 1.6
        and ratio is not None
        and ratio >= 0.9
        and not severe_sleep_debt
        and not recovery_vitals_strained
        and w.training_strain_points_14d < 8.0
    ):
        add_bonus(
            "resistance_training",
            "resistance_training_recovery",
            4.0,
            "A reasonable amount of resistance training plus adequate fueling supports the recovery environment.",
        )
    if f.workouts.deload_detected and ratio is not None and ratio >= 0.9:
        add_signal("deload_recovery", _signal(
            "deload_and_fueled",
            "Deload with adequate fueling",
            "protective",
            0.8,
            min(f.coverage["workouts"], f.coverage["nutrition"]),
            8,
            "A deload plus adequate fueling softens the support concern.",
        ))

    capped_penalties = {
        domain: min(total, HORMONE_DOMAIN_CAPS.get(domain, total))
        for domain, total in penalty_totals.items()
        if total > 0
    }
    capped_bonuses = {
        domain: min(total, HORMONE_BONUS_CAPS.get(domain, total))
        for domain, total in bonus_totals.items()
        if total > 0
    }
    score = HORMONE_SUPPORT_BASE_SCORE - sum(capped_penalties.values()) + sum(capped_bonuses.values())
    if not recs:
        recs.append("Keep the support levers steady: sleep, adequate calories, dietary fat, and manageable volume.")
    final = _clamp(score)
    risk_signal_count = sum(1 for item in penalty_items if float(item["raw_points"]) >= 2.0)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(nutrition_coverage, 0.2), max(sleep_coverage, 0.2), max(workout_coverage, 0.2)),
        corroborating_signals=max(risk_signal_count, _corroborating_count(signals)),
    )
    if ratio_source == "calorie_target":
        reasons = [
            *reasons,
            "Fueling uses the current calorie target; measured maintenance need or hormone labs are not inferred",
        ]
    status = _status_from_score(final, risk_direction="higher_is_better")
    debug = {
        "score_available": True,
        "base_score": HORMONE_SUPPORT_BASE_SCORE,
        "fueling_ratio": {
            "value": round(ratio, 3) if ratio is not None else None,
            "source": ratio_source or "unavailable",
            "denominator": round(ratio_denominator, 1) if ratio_denominator is not None else None,
            "limitation": "calorie_target reflects the current user goal target; maintenance or training-adjusted energy need is not available in this insight context",
        },
        "domain_penalties": {
            domain: {
                "raw_points": round(penalty_totals[domain], 2),
                "applied_points": round(applied, 2),
                "cap": HORMONE_DOMAIN_CAPS.get(domain),
            }
            for domain, applied in capped_penalties.items()
        },
        "domain_bonuses": {
            domain: {
                "raw_points": round(bonus_totals[domain], 2),
                "applied_points": round(applied, 2),
                "cap": HORMONE_BONUS_CAPS.get(domain),
            }
            for domain, applied in capped_bonuses.items()
        },
        "applied_penalties": penalty_items,
        "applied_bonuses": bonus_items,
        "training_strain": {
            "points_14d": round(w.training_strain_points_14d, 2),
            "confidence": round(w.training_strain_confidence, 2),
            "hard_resistance_sessions_14d": w.hard_resistance_sessions_14d,
            "hard_endurance_sessions_14d": w.hard_endurance_sessions_14d,
            "hard_glycolytic_sessions_14d": w.hard_glycolytic_sessions_14d,
            "resistance_sessions_14d": resistance_count,
            "fallback_used": not training_type_available,
        },
    }
    return InsightCard(
        id="hormone_support",
        title="Hormone Support Environment",
        category="recovery",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This is a support-environment score, not a hormone test: it checks whether sleep, fueling, dietary fat, training load, weight trend, and recovery vitals look supportive.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.avg_hours is not None,
            nutrition=ratio is not None or fat_pct is not None,
            workouts=w.completed_sessions > 0 or w.planned_sessions_14d > 0,
            apple_health=rhr is not None or hrv is not None or h.weight_trend_lbs_per_week is not None,
            user_context=u.weight_lbs is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
        debug=debug,
    )


def compute_menstrual_cycle_recovery_pattern(ctx: InsightContext) -> InsightCard:
    cycle = ctx.cycle
    n, s, w = ctx.nutrition, ctx.sleep, ctx.workouts
    if not ctx.user.reproductive_health_opt_in or not cycle.opt_in:
        return _unknown_card(
            card_id="menstrual_cycle_recovery_pattern",
            title="Menstrual Cycle & Recovery Pattern",
            category="reproductive_health",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=["cycle tracking opt-in"],
            recommendation="Cycle insights require opt-in cycle tracking.",
        )
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("cycle logs", cycle.logs_count >= 2),
        ("cycle length history", len(cycle.recent_cycle_lengths) >= 2),
        ("cycle symptoms", bool(cycle.symptom_dates)),
        ("sleep duration", s.avg_hours is not None),
        ("training load", w.completed_sessions > 0),
        ("energy availability", n.avg_energy_availability is not None or n.avg_calories_when_logged is not None),
    ):
        (present if ok else missing).append(label)
    if cycle.logs_count < 2:
        return _unknown_card(
            card_id="menstrual_cycle_recovery_pattern",
            title="Menstrual Cycle & Recovery Pattern",
            category="reproductive_health",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log at least two cycles before comparing cycle and recovery patterns.",
        )

    score = 74.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if len(cycle.recent_cycle_lengths) >= 2:
        spread = max(cycle.recent_cycle_lengths) - min(cycle.recent_cycle_lengths)
        if spread >= 10:
            score -= 12
            drivers.append("Cycle length has varied enough to treat recovery comparisons cautiously; this is a monitoring pattern, not a diagnosis.")
            recs.append("Keep cycle logs consistent before changing training based on a single cycle.")
        elif spread <= 6:
            positives.append("Recent cycle length is fairly consistent in the logs.")
    if cycle.symptom_dates and w.hard_session_dates:
        overlap = _overlap_count(cycle.symptom_dates, w.hard_session_dates)
        if overlap >= 1:
            score -= 8
            drivers.append("Cycle symptoms overlapped hard training at least once, so recovery planning can be more context-aware.")
    if n.avg_energy_availability is not None and 0 < n.avg_energy_availability < 30:
        score -= 12
        drivers.append("Energy availability is below the usual support range during an opted-in cycle-tracking window.")
    if s.avg_hours is not None and s.avg_hours < 6.5:
        score -= 8
        drivers.append("Short sleep reduces recovery margin in the cycle-tracking window.")
    if not drivers:
        positives.append("No cycle-linked recovery concern is clear from the current opted-in logs.")
    if not recs:
        recs.append("Use cycle tracking as context for training notes; do not infer fertility or hormone levels from this card.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(1.0, cycle.logs_count / 3.0),
        corroborating_signals=1 if drivers else 0,
    )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="menstrual_cycle_recovery_pattern",
        title="Menstrual Cycle & Recovery Pattern",
        category="reproductive_health",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This compares opted-in cycle logs with recovery context. It does not infer fertility, hormone levels, or diagnoses.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            cycle=cycle.logs_count > 0,
            sleep=s.avg_hours is not None,
            workouts=w.completed_sessions > 0,
            nutrition=n.avg_calories_when_logged is not None or n.avg_energy_availability is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_hydration_electrolyte_risk(ctx: InsightContext) -> InsightCard:
    n, a, w = ctx.nutrition, ctx.activity, ctx.workouts
    f = _features(ctx)
    meals = f.meals
    water_ratio = None
    if n.avg_water_oz is not None and n.estimated_hydration_target_oz:
        water_ratio = n.avg_water_oz / n.estimated_hydration_target_oz
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("hydration logs", n.hydration_logged_days > 0),
        ("hydration target", n.estimated_hydration_target_oz is not None),
        ("sodium logs", n.avg_sodium_mg is not None),
        ("activity demand", a.days_with_data > 0 or w.completed_sessions > 0),
        ("alcohol/caffeine signals", n.avg_alcohol_servings is not None),
        ("supplement timing", n.supplement_log_count > 0),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="hydration_electrolyte_risk",
            title="Hydration & Electrolyte Risk",
            category="hydration",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log water and workouts for several days to unlock hydration risk-factor patterns.",
        )

    risk = 22.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if water_ratio is not None:
        if water_ratio < 0.6:
            risk += 32
            drivers.append("Logged water is far below the estimated target.")
            recs.append("Start with one extra bottle earlier in the day rather than forcing fluids at night.")
        elif water_ratio < 0.8:
            risk += 16
            drivers.append("Logged water is below the estimated target.")
        elif water_ratio >= 0.9:
            positives.append("Hydration logs are near the estimated target.")
    if (a.avg_active_energy_kcal or 0) >= 700 or (a.avg_workout_minutes or 0) >= 60 or w.hard_sessions_7d >= 3:
        risk += 12
        drivers.append("Recent activity increases sweat-replacement demand.")
        recs.append("Pair fluids with sodium/electrolytes on longer or very sweaty sessions.")
    if n.avg_sodium_mg is not None:
        if n.avg_sodium_mg >= 3500 and (water_ratio is None or water_ratio < 0.9):
            risk += 16
            drivers.append("Sodium is high while logged hydration is not clearly covered.")
        elif 1500 <= n.avg_sodium_mg <= 3000:
            positives.append("Sodium intake is not reading unusually high from logged meals.")
    if (n.avg_alcohol_servings or 0) >= 1:
        risk += 8
        drivers.append("Alcohol servings add hydration variability.")
    if n.creatine_dates and (water_ratio is None or water_ratio < 0.9):
        drivers.append("Creatine is logged, so hydration context matters more on training days.")
    if n.electrolyte_dates:
        positives.append("Electrolyte supplements are logged in the window, which adds useful hydration context.")
    signals: list[EvidenceSignal] = []
    if f.overlaps["sweat_low_water"] >= 2:
        signals.append(_signal(
            "sweat_low_water_overlap",
            "Sweat demand and low water",
            "risk",
            min(1.0, f.overlaps["sweat_low_water"] / 4.0),
            min(f.coverage["hydration"], f.coverage["activity"]),
            14,
            f"Low-fluid days overlapped higher-sweat demand on {f.overlaps['sweat_low_water']} days.",
        ))
    if f.overlaps["low_water_high_sodium"] >= 2:
        signals.append(_signal(
            "high_sodium_low_water",
            "High sodium with low water",
            "risk",
            min(1.0, f.overlaps["low_water_high_sodium"] / 4.0),
            min(f.coverage["hydration"], f.coverage["nutrition"]),
            12,
            f"High sodium overlapped low logged water on {f.overlaps['low_water_high_sodium']} days.",
        ))
    sodium_metric = f.metrics["sodium_mg"]
    water_metric = f.metrics["water_oz"]
    if sodium_metric.days_below_threshold == 0 and n.avg_sodium_mg is not None and n.avg_sodium_mg < 1500 and ((a.avg_workout_minutes or 0) >= 45 or w.hard_sessions_7d >= 3):
        signals.append(_signal(
            "possible_under_replacement",
            "Possible under-replacement",
            "risk",
            0.5,
            min(f.coverage["nutrition"], f.coverage["activity"]),
            8,
            "Sodium looks very low while sweat demand is present; this is an electrolyte-replacement pattern, not a diagnosis.",
        ))
    if meals.late_caffeine_count >= 2:
        signals.append(_signal(
            "late_caffeine_hydration",
            "Caffeine timing",
            "risk",
            min(1.0, meals.late_caffeine_count / 4.0),
            f.coverage["nutrition"],
            5,
            f"Late caffeine appeared {meals.late_caffeine_count} times, adding hydration and sleep variability.",
        ))
    if n.electrolyte_dates and f.overlaps["sweat_low_water"] == 0:
        signals.append(_signal(
            "electrolyte_context",
            "Electrolyte supplement context",
            "protective",
            min(1.0, len(n.electrolyte_dates) / 4.0),
            0.65,
            5,
            "Electrolyte supplements are logged, supporting higher-sweat hydration context.",
        ))
    if water_metric.current_avg_14 is not None and water_ratio is not None and water_ratio >= 0.9 and f.overlaps["sweat_low_water"] == 0:
        signals.append(_signal(
            "hydration_consistency",
            "Hydration consistency",
            "protective",
            0.8,
            f.coverage["hydration"],
            10,
            "Water logs are close to target without repeated sweat-day gaps.",
        ))
    risk = _apply_evidence(risk, signals, risk_direction="higher_is_worse")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep hydration steady across the day and add electrolytes when sessions are long or sweaty.")
    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["hydration"], 0.15), max(f.coverage["activity"], 0.15)),
        corroborating_signals=_corroborating_count(signals),
    )
    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="hydration_electrolyte_risk",
        title="Hydration & Electrolyte Risk",
        category="hydration",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary=f"Hydration and electrolyte risk factors read {status} from logged water, sodium, and activity demand.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            hydration=n.hydration_logged_days > 0,
            nutrition=n.avg_sodium_mg is not None or n.avg_alcohol_servings is not None,
            activity=a.days_with_data > 0,
            workouts=w.completed_sessions > 0,
            supplements=n.supplement_log_count > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_kidney_stone_risk_factors(ctx: InsightContext) -> InsightCard:
    n, a, u = ctx.nutrition, ctx.activity, ctx.user
    f = _features(ctx)
    meals = f.meals
    water_ratio = None
    if n.avg_water_oz is not None and n.estimated_hydration_target_oz:
        water_ratio = n.avg_water_oz / n.estimated_hydration_target_oz
    protein_lb = _protein_g_per_lb(n, u)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("hydration logs", n.hydration_logged_days > 0),
        ("sodium logs", n.avg_sodium_mg is not None),
        ("protein-source pattern", n.avg_animal_protein_g is not None),
        ("sweat/activity days", a.days_with_data > 0),
        ("dietary calcium", n.avg_calcium_mg is not None),
        ("high-oxalate food frequency", meals.high_oxalate_food_count > 0),
        ("high vitamin C supplement use", bool(n.high_vitamin_c_dates)),
        ("stone history", (u.kidney_stone_history or "unknown") != "unknown"),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="kidney_stone_risk_factors",
            title="Kidney Stone Risk Factors",
            category="hydration",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log hydration and sodium-containing meals to make this risk-factor card useful.",
        )

    risk = 18.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if water_ratio is not None:
        if water_ratio < 0.7:
            risk += 30
            drivers.append("Hydration consistency is low compared with the estimated target.")
            recs.append("Make hydration the first lever: distribute fluids earlier and around sweaty sessions.")
        elif water_ratio >= 0.9:
            positives.append("Hydration consistency is close to the estimated target.")
    if n.avg_sodium_mg is not None:
        if n.avg_sodium_mg >= 3500:
            risk += 20
            drivers.append("Logged sodium is high across recent tracked days.")
            recs.append("Choose lower-sodium swaps for one recurring meal this week.")
        elif n.avg_sodium_mg <= 2600:
            positives.append("Sodium is closer to a moderate range in logged meals.")
    if protein_lb is not None and n.avg_animal_protein_g is not None:
        animal_ratio = n.avg_animal_protein_g / max(1.0, (n.avg_protein_g or n.avg_animal_protein_g))
        if protein_lb >= 1.1 and animal_ratio >= 0.7:
            risk += 14
            drivers.append("Animal-protein intake is high relative to body weight on tracked days.")
        elif animal_ratio < 0.65:
            positives.append("Protein sources are not dominated by animal protein.")
    if len(a.high_sweat_dates) >= 3 and (water_ratio is None or water_ratio < 0.9):
        risk += 10
        drivers.append("Several higher-sweat days are not clearly matched by hydration logs.")
    stone_history_known = (u.kidney_stone_history or "unknown").lower()
    if stone_history_known == "true":
        risk += 10
        drivers.append("Self-reported stone history increases sensitivity for this risk-factor screen.")
    elif stone_history_known == "false":
        positives.append("No stone history is currently logged.")
    signals: list[EvidenceSignal] = []
    if f.overlaps["low_water_high_sodium"] >= 2:
        signals.append(_signal(
            "low_water_high_sodium_stone",
            "Low water plus high sodium",
            "risk",
            min(1.0, f.overlaps["low_water_high_sodium"] / 4.0),
            min(f.coverage["hydration"], f.coverage["nutrition"]),
            12,
            f"Low water overlapped high sodium on {f.overlaps['low_water_high_sodium']} days.",
        ))
    if f.overlaps["sweat_low_water"] >= 2:
        signals.append(_signal(
            "sweat_low_fluid_stone",
            "Sweat days with low fluid",
            "risk",
            min(1.0, f.overlaps["sweat_low_water"] / 4.0),
            min(f.coverage["hydration"], f.coverage["activity"]),
            10,
            f"Higher-sweat days overlapped low fluid on {f.overlaps['sweat_low_water']} days.",
        ))
    if meals.high_oxalate_food_count >= 3:
        calcium_note = " without structured calcium data" if n.avg_calcium_mg is None else " with structured calcium data available"
        signals.append(_signal(
            "high_oxalate_pattern",
            "High-oxalate food hints",
            "risk",
            min(1.0, meals.high_oxalate_food_count / 6.0),
            f.coverage["nutrition"] * 0.65,
            8,
            f"High-oxalate food-name hints appeared {meals.high_oxalate_food_count} times{calcium_note}.",
        ))
    if meals.citrus_count >= 3:
        signals.append(_signal(
            "citrus_proxy",
            "Citrus/citrate proxy",
            "protective",
            min(1.0, meals.citrus_count / 5.0),
            f.coverage["nutrition"] * 0.7,
            6,
            f"Citrus appeared {meals.citrus_count} times, a supportive citrate proxy.",
        ))
    if meals.dairy_calcium_days >= 3:
        signals.append(_signal(
            "calcium_proxy",
            "Calcium proxy",
            "protective",
            min(1.0, meals.dairy_calcium_days / 5.0),
            f.coverage["nutrition"] * 0.7,
            6,
            f"Calcium-containing foods appeared on {meals.dairy_calcium_days} days.",
        ))
    if n.avg_calcium_mg is not None:
        if n.avg_calcium_mg < 600:
            signals.append(_signal(
                "low_structured_calcium",
                "Structured calcium",
                "risk",
                min(1.0, (600 - n.avg_calcium_mg) / 400.0),
                f.coverage["nutrition"],
                7,
                f"Structured calcium averages about {n.avg_calcium_mg:.0f}mg on days with micronutrient data.",
            ))
        elif n.avg_calcium_mg >= 800:
            signals.append(_signal(
                "structured_calcium_support",
                "Structured calcium",
                "protective",
                0.7,
                f.coverage["nutrition"],
                7,
                "Structured calcium intake is present in the logged micronutrient data.",
            ))
    if n.high_vitamin_c_dates:
        signals.append(_signal(
            "high_vitamin_c_supplement",
            "High-dose vitamin C supplement",
            "risk",
            min(1.0, len(n.high_vitamin_c_dates) / 3.0),
            0.8,
            7,
            "High-dose vitamin C supplements are logged, so this card includes that context.",
        ))
    risk = _apply_evidence(risk, signals, risk_direction="higher_is_worse")
    cluster_count = _corroborating_count(signals)
    if stone_history_known != "true" and cluster_count < 4 and risk > 68:
        risk = 68
        drivers.append("Severity is capped because no stone history is known and fewer than four risk factors cluster.")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep fluids steady, moderate sodium, and include calcium-containing foods when appropriate.")
    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["hydration"], 0.15), max(f.coverage["nutrition"], 0.15)),
        corroborating_signals=cluster_count,
    )
    if n.avg_calcium_mg is None and meals.dairy_calcium_days:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Dietary calcium is inferred from food tags rather than structured calcium values",
        )
    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="kidney_stone_risk_factors",
        title="Kidney Stone Risk Factors",
        category="hydration",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews nutrition and hydration risk factors only. It does not predict stones or assess kidney function.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            hydration=n.hydration_logged_days > 0,
            nutrition=n.avg_sodium_mg is not None or n.avg_animal_protein_g is not None,
            activity=a.days_with_data > 0,
            supplements=n.supplement_log_count > 0,
            user_context=stone_history_known != "unknown",
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_energy_availability(ctx: InsightContext) -> InsightCard:
    n, s, a, w, h = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health
    f = _features(ctx)
    fueling = f.fueling
    recovery = f.recovery
    ratio = _calorie_ratio(n)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("calorie target and logs", ratio is not None),
        ("training frequency", w.completed_sessions > 0 or w.planned_sessions_14d > 0),
        ("active energy", a.avg_active_energy_kcal is not None),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
        ("sleep duration", s.avg_hours is not None),
        ("energy availability estimate", n.avg_energy_availability is not None),
        ("post-workout meal timing", n.post_workout_timing_sessions > 0),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="energy_availability",
            title="Energy Availability",
            category="nutrition",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals and workouts for a week to compare intake against training demand.",
        )

    score = 76.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if ratio is not None:
        if ratio < 0.75:
            score -= 34
            drivers.append("Calories are far below target on tracked days.")
            recs.append("Add a simple carb-and-protein meal or snack around hard sessions.")
        elif ratio < 0.85:
            score -= 20
            drivers.append("Calories are below target while training demand is present.")
        elif 0.92 <= ratio <= 1.08:
            positives.append("Calories are aligned with target on tracked days.")
    if n.avg_energy_availability is not None and n.avg_energy_availability > 0:
        if n.avg_energy_availability < 25:
            score -= 28
            drivers.append("Energy availability estimate is very low from logged intake and activity.")
        elif n.avg_energy_availability < 30:
            score -= 14
            drivers.append("Energy availability estimate is below the usual support range.")
        else:
            positives.append("Energy availability estimate is in a more supportive range.")
    if w.sessions_7d >= 5 and ratio is not None and ratio < 0.9:
        score -= 12
        drivers.append("High training frequency is paired with an intake gap.")
    if (a.avg_active_energy_kcal or 0) >= 800 and ratio is not None and ratio < 0.9:
        score -= 8
        drivers.append("Active energy is high relative to tracked fueling.")
    if h.weight_trend_lbs_per_week is not None and h.weight_trend_lbs_per_week < -1.5:
        score -= 10
        drivers.append("Weight trend suggests rapid loss.")
    if s.avg_hours is not None and s.avg_hours < 6.5:
        score -= 8
        drivers.append("Short sleep adds recovery pressure.")
    if n.avg_protein_g is not None and n.protein_target_g and n.avg_protein_g >= n.protein_target_g * 0.9:
        positives.append("Protein is close to target.")
    signals: list[EvidenceSignal] = []
    if fueling.deficit_streak_days >= 3:
        signals.append(_signal(
            "deficit_streak_energy",
            "Deficit streak",
            "risk",
            min(1.0, fueling.deficit_streak_days / 7.0),
            f.coverage["nutrition"],
            12,
            f"Calorie gaps persisted for {fueling.deficit_streak_days} days in a row.",
        ))
    if fueling.hard_day_deficit_days >= 2:
        signals.append(_signal(
            "hard_day_fueling_gap",
            "Hard-day fueling gap",
            "risk",
            min(1.0, fueling.hard_day_deficit_days / 4.0),
            min(f.coverage["nutrition"], f.coverage["workouts"]),
            12,
            f"Low intake overlapped hard training on {fueling.hard_day_deficit_days} days.",
        ))
    if fueling.carb_g_per_kg_on_hard_days is not None and fueling.carb_g_per_kg_on_hard_days < 2.0:
        signals.append(_signal(
            "low_hard_day_carbs",
            "Low carbs on hard days",
            "risk",
            0.6,
            f.coverage["nutrition"],
            8,
            f"Carbs averaged {fueling.carb_g_per_kg_on_hard_days:.1f} g/kg on hard days.",
        ))
    if f.overlaps["sleep_debt_low_energy"] >= 2:
        signals.append(_signal(
            "sleep_low_energy_overlap",
            "Sleep debt overlap",
            "risk",
            min(1.0, f.overlaps["sleep_debt_low_energy"] / 4.0),
            min(f.coverage["sleep"], f.coverage["nutrition"]),
            8,
            f"Short-sleep nights overlapped low-energy days {f.overlaps['sleep_debt_low_energy']} times.",
        ))
    if recovery.hrv_suppression_days + recovery.rhr_elevation_days >= 2 and (ratio is None or ratio < 0.9):
        signals.append(_signal(
            "recovery_marker_fueling_gap",
            "Recovery marker overlap",
            "risk",
            0.7,
            min(f.coverage["apple_health"], f.coverage["nutrition"]),
            8,
            "HRV/RHR strain overlaps with an intake gap, so confidence in the fueling concern is higher.",
        ))
    if fueling.missed_post_workout_fueling_sessions >= 2:
        signals.append(_signal(
            "post_workout_fueling_gap_energy",
            "Post-workout fueling gap",
            "risk",
            min(1.0, fueling.missed_post_workout_fueling_sessions / 4.0),
            min(f.coverage["nutrition"], f.coverage["workouts"]),
            8,
            f"Timestamped logs show delayed or light post-workout fueling after {fueling.missed_post_workout_fueling_sessions} sessions.",
        ))
    if f.workouts.deload_detected or w.sessions_7d <= 2:
        signals.append(_signal(
            "low_training_demand",
            "Lower training demand",
            "protective",
            0.7,
            f.coverage["workouts"],
            8,
            "Training demand is lower right now, softening short-term energy-availability concern.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep calories and carbs closest to target on hard training days.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["workouts"], 0.2)),
        corroborating_signals=_corroborating_count(signals),
    )
    if n.avg_energy_availability is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No fat-free-mass energy-availability estimate is available, so this relies on calorie-target and training proxies",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="energy_availability",
        title="Energy Availability",
        category="nutrition",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This estimates whether recent intake appears aligned with training demand and recovery signals.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=ratio is not None or n.avg_energy_availability is not None,
            workouts=w.completed_sessions > 0,
            activity=a.avg_active_energy_kcal is not None,
            apple_health=h.weight_trend_lbs_per_week is not None,
            sleep=s.avg_hours is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_injury_risk(ctx: InsightContext) -> InsightCard:
    s, w = ctx.sleep, ctx.workouts
    f = _features(ctx)
    recovery = f.recovery
    workout_features = f.workouts
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("acute workload trend", w.acute_load_ratio is not None),
        ("recent hard sessions", w.completed_sessions > 0),
        ("sleep duration", s.avg_hours is not None),
        ("soreness check-ins", w.soreness_sessions_14d > 0),
        ("muscle fatigue", w.max_muscle_fatigue is not None),
        ("pain body-part detail", bool(w.recent_pain_body_parts)),
        ("movement-pattern history", bool(w.movement_pattern_counts_14d)),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="injury_risk",
            title="Injury Risk",
            category="activity",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log workouts and post-workout soreness so this can track load spikes.",
        )

    risk = 20.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if w.acute_load_ratio is not None:
        if w.acute_load_ratio >= 1.5:
            risk += 28
            drivers.append("Acute workload is sharply above the recent baseline.")
            recs.append("Avoid adding new volume this week; keep the next session technique-focused.")
        elif w.acute_load_ratio >= 1.25:
            risk += 14
            drivers.append("Workload has climbed faster than the recent baseline.")
        elif 0.8 <= w.acute_load_ratio <= 1.2:
            positives.append("Workload progression looks controlled.")
    if s.avg_hours is not None and s.avg_hours < 6.5:
        risk += 12
        drivers.append("Sleep is low, which can reduce coordination and recovery margin.")
    if w.hard_sessions_7d >= 4:
        risk += 12
        drivers.append("Repeated hard sessions are clustered in the last week.")
    if w.soreness_sessions_14d >= 2:
        risk += 15
        drivers.append("Soreness was reported after multiple recent sessions.")
        recs.append("Treat recurring soreness as a signal to reduce load or range of motion temporarily.")
    if w.max_muscle_fatigue is not None:
        if w.max_muscle_fatigue >= 0.8:
            risk += 15
            drivers.append("One muscle-group fatigue bucket is high.")
        elif w.max_muscle_fatigue <= 0.45:
            positives.append("Muscle fatigue buckets are not reading high.")
    if w.sessions_7d <= 4 and w.hard_sessions_7d <= 2:
        positives.append("Hard-session density is manageable.")
    signals: list[EvidenceSignal] = []
    if w.acute_load_ratio is not None and w.acute_load_ratio >= 1.25:
        signals.append(_signal(
            "load_ramp",
            "Load ramp",
            "risk",
            min(1.0, (w.acute_load_ratio - 1.0) / 0.8),
            f.coverage["workouts"],
            12,
            f"Acute/chronic load is {w.acute_load_ratio:.2f}, but this only becomes stronger when recovery or soreness also lines up.",
        ))
    if w.load_delta_vs_prior_14 is not None and w.load_delta_vs_prior_14 > 90:
        signals.append(_signal(
            "load_delta",
            "Load increased",
            "risk",
            min(1.0, w.load_delta_vs_prior_14 / 240.0),
            f.coverage["workouts"],
            8,
            f"Training load is up about {w.load_delta_vs_prior_14:.0f} load-minutes versus the prior 14 days.",
        ))
    if recovery.sleep_debt_7d is not None and recovery.sleep_debt_7d >= 4:
        signals.append(_signal(
            "sleep_debt_injury",
            "Sleep debt",
            "risk",
            min(1.0, recovery.sleep_debt_7d / 8.0),
            f.coverage["sleep"],
            8,
            f"Sleep debt is about {recovery.sleep_debt_7d:.1f} hours over 7 days.",
        ))
    elif s.avg_hours is not None and s.avg_hours < 6.5:
        signals.append(_signal(
            "short_sleep_injury",
            "Short sleep",
            "risk",
            min(1.0, (6.5 - s.avg_hours) / 1.5),
            f.coverage["sleep"],
            7,
            "Sleep is short enough to reduce recovery margin.",
        ))
    if recovery.soreness_days >= 2:
        signals.append(_signal(
            "same_window_soreness",
            "Recurring soreness",
            "risk",
            min(1.0, recovery.soreness_days / 4.0),
            f.coverage["workouts"],
            12,
            f"Soreness was reported on {recovery.soreness_days} recent days.",
        ))
    if recovery.pain_note_present:
        signals.append(_signal(
            "pain_note",
            "Pain note",
            "risk",
            0.8,
            f.coverage["workouts"],
            12,
            "A workout note mentions pain or irritation, so the card stays conservative.",
        ))
    if workout_features.today_pain_body_part_overlap:
        parts = ", ".join(sorted(workout_features.today_pain_body_part_overlap)[:3])
        signals.append(_signal(
            "today_pain_overlap",
            "Today pain overlap",
            "risk",
            0.95,
            f.coverage["workouts"],
            16,
            f"Today's plan overlaps a recently painful body part: {parts}.",
        ))
        recs.append("Make today's adjustment specific to the painful area; reduce load, range, or swap the pattern.")
    if workout_features.today_sore_muscle_overlap:
        groups = ", ".join(sorted(workout_features.today_sore_muscle_overlap)[:3])
        signals.append(_signal(
            "today_sore_overlap",
            "Today plan overlap",
            "risk",
            0.9,
            f.coverage["workouts"],
            14,
            f"Today's plan overlaps recently sore muscle groups: {groups}.",
        ))
        recs.append("Make today's session-specific adjustment: reduce load or range for the sore pattern.")
    if workout_features.ramped_movement_patterns:
        overlap = workout_features.today_ramped_movement_overlap
        corroborated = recovery.soreness_days >= 2 or recovery.pain_note_present or bool(workout_features.today_pain_body_part_overlap)
        if corroborated:
            patterns = ", ".join(sorted(overlap or workout_features.ramped_movement_patterns)[:3])
            signals.append(_signal(
                "movement_pattern_ramp",
                "Movement-pattern ramp",
                "risk",
                0.75,
                f.coverage["workouts"],
                10,
                f"Movement-pattern volume ramped for {patterns} and is corroborated by soreness or pain detail.",
            ))
        else:
            drivers.append("Movement-pattern volume ramped, but severity is capped without soreness, pain, or recovery corroboration.")
    if recovery.max_muscle_fatigue is not None and recovery.max_muscle_fatigue >= 0.75:
        signals.append(_signal(
            "muscle_fatigue",
            "Muscle fatigue",
            "risk",
            min(1.0, recovery.max_muscle_fatigue),
            f.coverage["workouts"],
            8,
            "A muscle fatigue bucket is high enough to make same-muscle loading more cautious.",
        ))
    if w.acute_load_ratio is not None and 0.8 <= w.acute_load_ratio <= 1.2 and recovery.soreness_days == 0:
        signals.append(_signal(
            "controlled_load",
            "Controlled progression",
            "protective",
            0.8,
            f.coverage["workouts"],
            10,
            "Load progression is controlled and soreness is not repeating.",
        ))
    risk = _apply_evidence(risk, signals, risk_direction="higher_is_worse")
    risk_signal_count = _corroborating_count(signals)
    if risk_signal_count < 2 and risk > 60:
        risk = 60
        drivers.append("Workload alone is not enough for a high injury-risk flag, so severity is capped.")
    risk_signals = sorted(
        (signal for signal in signals if signal.direction == "risk"),
        key=lambda signal: 0 if signal.key == "today_sore_overlap" else 1,
    )
    drivers.extend(signal.explanation for signal in risk_signals)
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep progressions gradual and use recovery or mobility days when sleep is low.")
    final = _clamp(risk)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["workouts"], 0.2), max(f.coverage["sleep"], 0.2)),
        corroborating_signals=risk_signal_count,
    )
    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="injury_risk",
        title="Injury Risk",
        category="activity",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary=f"Injury risk factors read {status} from workload changes, sleep, soreness, and fatigue signals.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            workouts=w.completed_sessions > 0,
            sleep=s.avg_hours is not None,
            pain_detail=bool(w.recent_pain_body_parts),
            movement_patterns=bool(w.movement_pattern_counts_14d),
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_sleep_disruptors(ctx: InsightContext) -> InsightCard:
    n, s, w = ctx.nutrition, ctx.sleep, ctx.workouts
    f = _features(ctx)
    meals = f.meals
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sleep nights", s.nights_with_data >= 5),
        ("meal timing", bool(n.late_meal_dates)),
        ("workout timing", bool(w.late_workout_dates)),
        ("alcohol timing", bool(n.alcohol_dates)),
        ("caffeine timing/dose", n.late_caffeine_structured_count > 0 or n.late_caffeine_mg > 0),
        ("bedtime consistency", s.bedtime_std_minutes is not None),
    ):
        (present if ok else missing).append(label)
    if s.nights_with_data < 5:
        return _unknown_card(
            card_id="sleep_disruptors",
            title="Sleep Disruptors",
            category="sleep",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Capture at least five nights of sleep to compare timing patterns.",
        )

    late_meal_pairs = _late_pattern_count(s.low_sleep_dates, n.late_meal_dates)
    late_workout_pairs = _late_pattern_count(s.low_sleep_dates, w.late_workout_dates)
    alcohol_pairs = _late_pattern_count(s.low_sleep_dates, n.alcohol_dates)
    observed_dates = _current_dates(f.as_of)
    late_meal_hits, late_meal_lift = _exposure_lift(s.low_sleep_dates, n.late_meal_dates, observed_dates)
    late_workout_hits, late_workout_lift = _exposure_lift(s.low_sleep_dates, w.late_workout_dates, observed_dates)
    alcohol_hits, alcohol_lift = _exposure_lift(s.low_sleep_dates, n.alcohol_dates, observed_dates)
    enough_low_sleep = len(s.low_sleep_dates) >= 3

    risk = 18.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if enough_low_sleep and late_workout_pairs >= 2 and (late_workout_lift is None or late_workout_lift >= 1.3):
        risk += 24
        comparison = f" lift {late_workout_lift:.1f}x versus non-late-workout days" if late_workout_lift is not None else ""
        drivers.append(f"Poorer sleep followed late workouts {late_workout_hits} times{comparison}.")
        recs.append("Move hard sessions earlier when possible for one week and compare sleep.")
    if enough_low_sleep and late_meal_pairs >= 2 and (late_meal_lift is None or late_meal_lift >= 1.3):
        risk += 18
        comparison = f" lift {late_meal_lift:.1f}x versus other days" if late_meal_lift is not None else ""
        drivers.append(f"Poorer sleep followed late meals {late_meal_hits} times{comparison}.")
        recs.append("Try shifting the largest meal earlier on training days.")
    if enough_low_sleep and alcohol_pairs >= 2 and (alcohol_lift is None or alcohol_lift >= 1.3):
        risk += 16
        comparison = f" lift {alcohol_lift:.1f}x versus non-alcohol days" if alcohol_lift is not None else ""
        drivers.append(f"Alcohol appeared before low-sleep nights {alcohol_hits} times{comparison}.")
    if enough_low_sleep and meals.late_high_fat_count >= 2:
        risk += 10
        drivers.append(f"Late high-fat meals appeared {meals.late_high_fat_count} times; test meal timing before changing multiple foods.")
        recs.append("Run a one-variable test: keep dinner lighter/earlier for 7 nights and compare sleep.")
    if enough_low_sleep and meals.late_added_sugar_count >= 2:
        risk += 8
        drivers.append(f"Late added-sugar items appeared {meals.late_added_sugar_count} times before the sleep window.")
    if enough_low_sleep and meals.structured_late_caffeine_count >= 1:
        risk += 14
        drivers.append(f"Structured caffeine timing shows {n.late_caffeine_mg:.0f}mg after the early-afternoon cutoff.")
        recs.append("Log caffeine timing for a week to test whether moving it earlier changes sleep.")
    elif enough_low_sleep and meals.inferred_late_caffeine_count >= 1:
        risk += 8
        drivers.append("Late caffeine is inferred from food tags near the sleep window; confidence is capped without exact dose.")
    if s.bedtime_std_minutes is not None:
        if s.bedtime_std_minutes > 90:
            risk += 15
            drivers.append("Bedtime variance is high.")
            recs.append("Anchor wake time and keep bedtime within a tighter window for several nights.")
        elif s.bedtime_std_minutes < 45:
            positives.append("Bedtime timing is fairly consistent.")
    if s.avg_hours is not None and s.avg_hours >= 7:
        positives.append("Average sleep duration is in a supportive range.")
    if not drivers:
        positives.append("No repeated disruptor pattern is clear yet.")
        recs.append("Keep logging sleep plus meal/workout timing so patterns can emerge.")
    final = _clamp(risk)
    corroborating = sum(1 for value in (late_meal_pairs, late_workout_pairs, alcohol_pairs, meals.late_high_fat_count, meals.late_added_sugar_count, meals.structured_late_caffeine_count) if value >= 2)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["sleep"], 0.2), max(f.coverage["nutrition"], 0.2)),
        corroborating_signals=corroborating,
    )
    if meals.inferred_late_caffeine_count and not meals.structured_late_caffeine_count:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Caffeine source is inferred from food tags, not a structured caffeine log",
        )
    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="sleep_disruptors",
        title="Sleep Disruptors",
        category="sleep",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This looks for repeated timing patterns before lower-sleep nights and only calls out patterns with enough observations.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.nights_with_data > 0,
            nutrition=bool(n.late_meal_dates) or bool(n.alcohol_dates),
            caffeine=n.late_caffeine_structured_count > 0,
            workouts=bool(w.late_workout_dates),
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_performance_readiness(ctx: InsightContext) -> InsightCard:
    n, s, w, h = ctx.nutrition, ctx.sleep, ctx.workouts, ctx.health
    f = _features(ctx)
    recovery = f.recovery
    fueling = f.fueling
    workout_features = f.workouts
    meals = f.meals
    carb_kg = _carbs_g_per_kg(n, ctx.user)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sleep duration", s.avg_hours is not None),
        ("HRV/RHR trends", _hrv_ratio(h) is not None or _rhr_delta(h) is not None),
        ("carbohydrate intake", carb_kg is not None),
        ("training fatigue", w.completed_sessions > 0 or w.max_muscle_fatigue is not None),
        ("today planned intensity", w.today_planned_intensity is not None),
        ("post-workout fueling timing", n.post_workout_timing_sessions > 0),
        ("pain body-part detail", bool(w.recent_pain_body_parts)),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="performance_readiness",
            title="Performance Readiness",
            category="recovery",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log sleep, meals, and workouts so this can guide today's session intensity.",
        )

    score = 74.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 18
            drivers.append("Sleep is short for performance readiness.")
            recs.append("Use a longer warmup and keep top sets submaximal today.")
        elif s.avg_hours >= 7.2:
            positives.append("Sleep duration supports readiness.")
    hrv = _hrv_ratio(h)
    rhr = _rhr_delta(h)
    if hrv is not None and hrv <= 0.85:
        score -= 14
        drivers.append("HRV is below recent baseline.")
    elif hrv is not None and hrv >= 0.95:
        positives.append("HRV is near baseline.")
    if rhr is not None and rhr >= 6:
        score -= 12
        drivers.append("Resting heart rate is above recent baseline.")
    elif rhr is not None and rhr <= 2:
        positives.append("Resting heart rate is close to baseline.")
    if carb_kg is not None:
        if carb_kg < 2.0 and (w.today_planned_intensity or "").lower() in {"hard", "heavy", "conditioning"}:
            score -= 12
            drivers.append("Carbohydrate intake is low for a harder planned session.")
            recs.append("Add easy-digesting carbs before the session if training hard.")
        elif carb_kg >= 2.5:
            positives.append("Carbohydrate intake supports training output.")
    if w.max_muscle_fatigue is not None and w.max_muscle_fatigue >= 0.75:
        score -= 12
        drivers.append("Recent muscle fatigue is elevated.")
    signals: list[EvidenceSignal] = []
    if recovery.sleep_last_night is not None and recovery.sleep_last_night < 6.5:
        signals.append(_signal(
            "last_night_sleep",
            "Last-night sleep",
            "risk",
            min(1.0, (6.5 - recovery.sleep_last_night) / 1.5),
            f.coverage["sleep"],
            10,
            f"Last night's sleep was {recovery.sleep_last_night:.1f}h, so readiness is more session-specific today.",
        ))
    elif s.avg_hours is not None and s.avg_hours < 6.5:
        signals.append(_signal(
            "sleep_average_readiness",
            "Sleep average",
            "risk",
            min(1.0, (6.5 - s.avg_hours) / 1.5),
            f.coverage["sleep"],
            8,
            "Recent sleep average is short for performance readiness.",
        ))
    if recovery.sleep_debt_7d is not None and recovery.sleep_debt_7d >= 4:
        signals.append(_signal(
            "sleep_debt_3_7",
            "Short-term sleep debt",
            "risk",
            min(1.0, recovery.sleep_debt_7d / 8.0),
            f.coverage["sleep"],
            8,
            f"Sleep debt is about {recovery.sleep_debt_7d:.1f} hours over the last week.",
        ))
    if fueling.carb_g_per_kg_on_hard_days is not None and workout_features.today_is_demanding and fueling.carb_g_per_kg_on_hard_days < 2.0:
        signals.append(_signal(
            "today_carbs_low",
            "Carbs for hard session",
            "risk",
            0.7,
            f.coverage["nutrition"],
            10,
            f"Carbs on hard days average {fueling.carb_g_per_kg_on_hard_days:.1f} g/kg, low for a demanding session.",
        ))
    if workout_features.today_sore_muscle_overlap:
        groups = ", ".join(sorted(workout_features.today_sore_muscle_overlap)[:3])
        signals.append(_signal(
            "readiness_muscle_overlap",
            "Soreness overlaps plan",
            "risk",
            0.9,
            f.coverage["workouts"],
            14,
            f"Readiness is lower for {groups} work because those groups overlap today's plan.",
        ))
        recs.append(f"Bias today toward technique or non-overlapping work for {groups}.")
    if workout_features.today_pain_body_part_overlap:
        parts = ", ".join(sorted(workout_features.today_pain_body_part_overlap)[:3])
        signals.append(_signal(
            "readiness_pain_overlap",
            "Pain overlaps plan",
            "risk",
            1.0,
            f.coverage["workouts"],
            16,
            f"Readiness is lower because today's plan overlaps recently painful areas: {parts}.",
        ))
        recs.append(f"Use a pain-free alternative for {parts} work today.")
    if workout_features.today_ramped_movement_overlap and (recovery.soreness_days >= 2 or workout_features.today_pain_body_part_overlap):
        patterns = ", ".join(sorted(workout_features.today_ramped_movement_overlap)[:3])
        signals.append(_signal(
            "readiness_movement_ramp",
            "Movement ramp overlap",
            "risk",
            0.7,
            f.coverage["workouts"],
            8,
            f"Today's plan repeats ramped movement patterns ({patterns}) with soreness or pain context.",
        ))
    if workout_features.rest_days_since_last_hard_session is not None and workout_features.rest_days_since_last_hard_session == 0 and workout_features.today_is_demanding:
        signals.append(_signal(
            "back_to_back_hard",
            "Back-to-back demand",
            "risk",
            0.6,
            f.coverage["workouts"],
            8,
            "A hard session occurred less than a day ago and today's plan is demanding.",
        ))
    if fueling.missed_post_workout_fueling_sessions >= 2 and workout_features.today_is_demanding:
        signals.append(_signal(
            "readiness_post_workout_delay",
            "Recent post-workout fueling gaps",
            "risk",
            min(1.0, fueling.missed_post_workout_fueling_sessions / 4.0),
            f.coverage["nutrition"],
            6,
            "Recent timestamped workouts had delayed or light post-workout meals, so readiness stays more cautious.",
        ))
    if meals.structured_late_caffeine_count >= 2 and (s.avg_hours is not None and s.avg_hours < 7):
        signals.append(_signal(
            "late_caffeine_readiness",
            "Late caffeine timing",
            "risk",
            min(1.0, meals.structured_late_caffeine_count / 4.0),
            f.coverage["nutrition"],
            5,
            "Later-day caffeine is structured in the logs and overlaps a shorter sleep pattern.",
        ))
    if n.avg_water_oz is not None and n.estimated_hydration_target_oz and n.avg_water_oz >= n.estimated_hydration_target_oz * 0.9:
        signals.append(_signal(
            "hydration_ready",
            "Hydration support",
            "protective",
            0.6,
            f.coverage["hydration"],
            6,
            "Hydration logs are close to target, supporting readiness.",
        ))
    if workout_features.today_planned_intensity == "easy" and score < 70:
        signals.append(_signal(
            "easy_plan_fit",
            "Easy plan fit",
            "protective",
            0.7,
            f.coverage["workouts"],
            8,
            "Today's easy plan fits the current readiness profile better than max-effort work.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if w.today_planned_intensity in {"hard", "heavy"} and score < 65:
        recs.append("Consider reducing volume or choosing technique work for the main lifts.")
    if not recs:
        recs.append("Proceed as planned, but keep an eye on warmup bar speed and breathing.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["sleep"], 0.2), max(f.coverage["nutrition"], 0.2), max(f.coverage["workouts"], 0.2)),
        corroborating_signals=_corroborating_count(signals),
    )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="performance_readiness",
        title="Performance Readiness",
        category="recovery",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="Readiness blends sleep, available vitals, carbs, fatigue, and today's planned demand.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.avg_hours is not None,
            apple_health=hrv is not None or rhr is not None,
            nutrition=carb_kg is not None,
            workouts=w.completed_sessions > 0 or w.today_planned_intensity is not None,
            pain_detail=bool(w.recent_pain_body_parts),
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_lifestyle_context_pattern(ctx: InsightContext) -> InsightCard:
    l = ctx.lifestyle
    if l.logs_count < 1:
        return _unknown_card(
            card_id="lifestyle_context",
            title="Lifestyle Context",
            category="recovery",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=["lifestyle logs"],
            recommendation="Log a few lifestyle factors so recovery and health insights can include stress, caffeine timing, appetite, digestion, and substance context.",
        )

    risk = 8.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if l.high_stress_dates:
        risk += min(24.0, len(l.high_stress_dates) * 8.0)
        drivers.append(f"High stress was logged on {len(l.high_stress_dates)} day(s) in the recent window.")
        recs.append("On high-stress days, bias training toward the planned work you can execute cleanly and keep recovery routines simple.")
    if l.late_caffeine_dates:
        risk += min(18.0, len(l.late_caffeine_dates) * 6.0)
        drivers.append(f"Late caffeine was logged on {len(l.late_caffeine_dates)} day(s).")
        recs.append("When sleep or readiness is trending down, move caffeine earlier or lower the late-day dose.")
    if l.alcohol_dates:
        risk += min(18.0, len(l.alcohol_dates) * 6.0)
        drivers.append(f"Alcohol was logged on {len(l.alcohol_dates)} day(s).")
        recs.append("After alcohol logs, watch next-day sleep/readiness and keep intensity flexible if recovery is lower.")
    if l.cannabis_dates:
        risk += min(12.0, len(l.cannabis_dates) * 4.0)
        drivers.append(f"Cannabis was logged on {len(l.cannabis_dates)} day(s).")
    if l.illness_dates:
        risk += min(28.0, len(l.illness_dates) * 14.0)
        drivers.append(f"Run-down or sick status was logged on {len(l.illness_dates)} day(s).")
        recs.append("When run-down or sick is logged, prioritize recovery, easy movement, or a conservative training day.")
    if l.unusual_appetite_dates:
        risk += min(10.0, len(l.unusual_appetite_dates) * 4.0)
        drivers.append(f"Low or high appetite was logged on {len(l.unusual_appetite_dates)} day(s).")
    if l.digestion_issue_dates:
        risk += min(12.0, len(l.digestion_issue_dates) * 4.0)
        drivers.append(f"Digestion changes were logged on {len(l.digestion_issue_dates)} day(s).")

    if not drivers:
        positives.append("Logged lifestyle context did not show high stress, illness, late caffeine, alcohol, cannabis, appetite swings, or digestion changes.")
        recs.append("Keep logging a few quick lifestyle factors so trends can be matched against sleep, readiness, nutrition, and training.")
    elif not recs:
        recs.append("Keep logging lifestyle context alongside sleep, meals, and training so repeated patterns become clearer.")

    if l.logs_count < 4:
        recs.append("Add a few more days of lifestyle logs to improve confidence.")

    missing = ["more lifestyle log days"] if l.logs_count < 4 else []
    present = ["lifestyle logs"]
    if ctx.sleep.nights_with_data:
        present.append("sleep")
    if ctx.health.days_with_data:
        present.append("Apple Health")
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(1.0, l.logs_count / max(1.0, float(l.window_days or 14))),
    )
    final = _clamp(risk)
    return InsightCard(
        id="lifestyle_context",
        title="Lifestyle Context",
        category="recovery",
        status=_status_from_score(final, risk_direction="higher_is_worse"),
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This uses private lifestyle logs as recovery context, then compares them with the rest of your logged wellness data.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            lifestyle=l.logs_count > 0,
            sleep=ctx.sleep.nights_with_data > 0,
            apple_health=ctx.health.days_with_data > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_digestion_patterns(ctx: InsightContext) -> InsightCard:
    n = ctx.nutrition
    f = _features(ctx)
    meals = f.meals
    symptom_dates = n.digestion_food_dates.get("_symptom_dates", set())
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("meal detail", n.days_with_data > 0),
        ("digestive symptom check-ins", bool(symptom_dates)),
        ("fiber trend", n.avg_fiber_g is not None),
        ("food pattern tags", any(k for k in n.digestion_food_dates if not k.startswith("_"))),
    ):
        (present if ok else missing).append(label)
    if not symptom_dates or n.days_with_data == 0:
        return _unknown_card(
            card_id="digestion_patterns",
            title="Digestion Pattern Signals",
            category="digestion",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals and use check-in notes when digestion feels off so patterns can be compared safely.",
        )

    risk = 18.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    observed_dates = _current_dates(f.as_of)
    fiber_hits, fiber_lift = _exposure_lift(symptom_dates, n.fiber_spike_dates, observed_dates)
    if len(n.fiber_spike_dates) >= 2 and fiber_hits >= 2 and (fiber_lift is None or fiber_lift >= 1.3):
        risk += 18
        comparison = f" ({fiber_lift:.1f}x lift versus non-spike days)" if fiber_lift is not None else ""
        drivers.append(f"Fiber spikes preceded digestion notes {fiber_hits} times{comparison}; this is hypothesis-level.")
        recs.append("Increase fiber gradually and spread it across meals.")
    for key, label in (
        ("dairy", "Dairy-containing meals"),
        ("protein_powder", "Protein powder"),
        ("artificial_sweetener", "Artificial sweeteners"),
        ("high_fat", "Very high-fat meals"),
        ("fodmap_hint", "FODMAP-heavy foods"),
    ):
        dates = n.digestion_food_dates.get(key, set())
        hits, lift = _exposure_lift(symptom_dates, dates, observed_dates)
        if len(dates) >= 2 and hits >= 2 and (lift is None or lift >= 1.3):
            risk += 14
            comparison = f" ({lift:.1f}x lift versus days without that exposure)" if lift is not None else ""
            drivers.append(f"{label} preceded digestion notes {hits} times{comparison}; treat this as a testable hypothesis.")
    if meals.protein_powder_count >= 2 and "Protein powder" not in " ".join(drivers):
        positives.append("Protein powder appears often enough to monitor, but symptoms do not repeatedly follow it yet.")
    if meals.fermented_food_days >= 3:
        positives.append(f"Fermented foods appeared on {meals.fermented_food_days} days.")
    if meals.high_fodmap_hint_count >= 3 and not any("FODMAP" in d for d in drivers):
        positives.append("FODMAP-heavy food hints are present, but repeated symptom timing is not clear yet.")
    if not drivers and n.avg_fiber_g is not None:
        positives.append("No repeated meal pattern is clearly tied to symptom notes yet.")
    if not recs:
        recs.append("Treat these as hypotheses: change one food pattern at a time and compare notes.")
    final = _clamp(risk)
    hypothesis_signal_count = sum(1 for d in drivers if "hypothesis" in d.lower())
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=f.coverage["nutrition"],
        corroborating_signals=hypothesis_signal_count,
        penalties=["Food-name exposure signals are heuristic, so certainty stays limited."],
    )
    if hypothesis_signal_count == 0:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No repeated exposure-to-symptom pattern is present yet",
        )
    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="digestion_patterns",
        title="Digestion Pattern Signals",
        category="digestion",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This looks for food-pattern signals that overlap with digestion-related check-ins. It does not diagnose digestive conditions.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(nutrition=n.days_with_data > 0, checkins=bool(symptom_dates)),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_heart_health_habits(ctx: InsightContext) -> InsightCard:
    n, s, a, h = ctx.nutrition, ctx.sleep, ctx.activity, ctx.health
    f = _features(ctx)
    meals = f.meals
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sodium logs", n.avg_sodium_mg is not None),
        ("potassium logs", n.avg_potassium_mg is not None),
        ("cardio minutes", a.avg_cardio_minutes is not None),
        ("steps", a.avg_steps is not None),
        ("sleep duration", s.avg_hours is not None),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
        ("blood pressure readings", h.bp_reading_count > 0),
        ("alcohol logs", n.avg_alcohol_servings is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="heart_health_habits",
            title="Heart Health Habits",
            category="heart_health",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals and activity, and optionally blood-pressure readings, to unlock habit patterns.",
        )

    score = 72.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if n.avg_sodium_mg is not None:
        if n.avg_sodium_mg >= 3500:
            score -= 16
            drivers.append("Logged sodium is high across recent tracked days.")
            recs.append("Swap one recurring high-sodium meal for a lower-sodium option.")
        elif n.avg_sodium_mg <= 2600:
            positives.append("Sodium is closer to a moderate range in logged meals.")
    if a.avg_cardio_minutes is not None:
        weekly_cardio = a.avg_cardio_minutes * 7
        if weekly_cardio < CARDIO_LOW_MINUTES_WEEK:
            score -= 14
            drivers.append("Cardio minutes are below the usual weekly habit target.")
            recs.append("Add two easy Zone 2 walks or rides this week.")
        elif weekly_cardio >= CARDIO_GUIDELINE_MINUTES_WEEK:
            positives.append("Cardio minutes support heart-health habits.")
    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            score -= 10
            drivers.append("Average steps are low.")
        elif a.avg_steps >= 7500:
            positives.append("Step count supports daily movement habits.")
    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 10
            drivers.append("Sleep is short for recovery and heart-health habit support.")
        elif s.avg_hours >= 7:
            positives.append("Sleep duration supports recovery habits.")
    if (n.avg_alcohol_servings or 0) >= 1:
        score -= 8
        drivers.append("Alcohol servings add variability to sleep and recovery habits.")
    if h.weight_trend_lbs_per_week is not None and h.weight_trend_lbs_per_week > 1.5:
        score -= 6
        drivers.append("Weight trend is rising quickly in the recent window.")
    if h.bp_reading_count > 0 and h.latest_bp_systolic is not None and h.latest_bp_diastolic is not None:
        if h.bp_reading_count >= 2 and h.median_bp_systolic is not None and h.median_bp_diastolic is not None and (h.median_bp_systolic >= 130 or h.median_bp_diastolic >= 80):
            score -= 14
            drivers.append("Median recent blood-pressure readings are above the app's wellness target.")
        elif h.bp_reading_count == 1 and (h.latest_bp_systolic >= 130 or h.latest_bp_diastolic >= 80):
            score -= 5
            drivers.append("One blood-pressure reading is above the app's wellness target; one reading is not a trend.")
        else:
            positives.append("Recent blood-pressure reading is within the app's wellness target.")
    signals: list[EvidenceSignal] = []
    sodium_metric = f.metrics["sodium_mg"]
    if sodium_metric.days_above_threshold >= 4:
        signals.append(_signal(
            "high_sodium_persistence_heart",
            "Persistent high sodium",
            "risk",
            min(1.0, sodium_metric.days_above_threshold / 8.0),
            sodium_metric.coverage_14,
            10,
            f"Sodium was high on {sodium_metric.days_above_threshold} logged days.",
        ))
    if f.overlaps["low_water_high_sodium"] >= 2:
        signals.append(_signal(
            "sodium_low_water_heart",
            "High sodium plus low water",
            "risk",
            min(1.0, f.overlaps["low_water_high_sodium"] / 4.0),
            min(f.coverage["nutrition"], f.coverage["hydration"]),
            6,
            "High sodium plus low water also shows up in the hydration card.",
        ))
    if meals.potassium_proxy_days >= 5:
        signals.append(_signal(
            "potassium_proxy",
            "Potassium proxy foods",
            "protective",
            min(1.0, meals.potassium_proxy_days / 7.0),
            f.coverage["nutrition"] * 0.7,
            8,
            f"Potassium-proxy foods appeared on {meals.potassium_proxy_days} days.",
        ))
    if n.avg_potassium_mg is not None:
        if n.avg_potassium_mg < 2500:
            signals.append(_signal(
                "structured_low_potassium",
                "Structured potassium",
                "risk",
                min(1.0, (2500 - n.avg_potassium_mg) / 1000.0),
                f.coverage["nutrition"],
                8,
                f"Structured potassium averages about {n.avg_potassium_mg:.0f}mg on micronutrient-logged days.",
            ))
        elif n.avg_potassium_mg >= 3000:
            signals.append(_signal(
                "structured_potassium_support",
                "Structured potassium",
                "protective",
                min(1.0, n.avg_potassium_mg / 4700.0),
                f.coverage["nutrition"],
                9,
                "Structured potassium intake is present in logged micronutrients.",
            ))
    dash_score = 0
    dash_score += 1 if n.avg_sodium_mg is not None and n.avg_sodium_mg <= 2600 else 0
    dash_score += 1 if n.avg_fiber_g is not None and n.avg_fiber_g >= 25 else 0
    dash_score += 1 if (n.avg_potassium_mg is not None and n.avg_potassium_mg >= 3000) or meals.potassium_proxy_days >= 5 else 0
    dash_score += 1 if (a.avg_cardio_minutes or 0) * 7 >= CARDIO_GUIDELINE_MINUTES_WEEK else 0
    dash_score += 1 if s.avg_hours is not None and s.avg_hours >= 7 else 0
    if dash_score >= 4:
        signals.append(_signal(
            "dash_like_pattern",
            "DASH-like habit pattern",
            "protective",
            dash_score / 5.0,
            min(f.coverage["nutrition"], max(f.coverage["activity"], 0.35), max(f.coverage["sleep"], 0.35)),
            10,
            "A DASH-like pattern is present across sodium, fiber/plants, cardio, and sleep.",
        ))
    if a.avg_zone2_minutes is not None and a.avg_zone2_minutes * 7 >= 90:
        signals.append(_signal(
            "zone2_consistency",
            "Zone 2 consistency",
            "protective",
            0.8,
            f.coverage["activity"],
            8,
            "Zone 2 minutes are consistent enough to support heart-health habits.",
        ))
    if h.bp_reading_count >= 2 and h.bp_systolic_trend is not None and h.bp_systolic_trend > 5:
        signals.append(_signal(
            "bp_trend",
            "BP trend",
            "risk",
            min(1.0, h.bp_systolic_trend / 12.0),
            0.65,
            8,
            f"Blood-pressure readings trend up about {h.bp_systolic_trend:.0f} systolic points per 14 days.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep the basics steady: moderate sodium, regular cardio, daily steps, and consistent sleep.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["activity"], 0.2)),
        corroborating_signals=_corroborating_count(signals),
    )
    if n.avg_potassium_mg is None and meals.potassium_proxy_days:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Potassium support is inferred from food tags rather than structured potassium values",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="heart_health_habits",
        title="Heart Health Habits",
        category="heart_health",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews heart-health habit signals from logged nutrition, movement, sleep, and optional blood-pressure readings.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.avg_sodium_mg is not None or n.avg_alcohol_servings is not None,
            micronutrients=n.avg_potassium_mg is not None,
            activity=a.avg_steps is not None or a.avg_cardio_minutes is not None,
            sleep=s.avg_hours is not None,
            apple_health=h.weight_trend_lbs_per_week is not None,
            checkins=h.bp_reading_count > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_inflammation_support(ctx: InsightContext) -> InsightCard:
    n, s, a, w, h = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health
    f = _features(ctx)
    meals = f.meals
    recovery = f.recovery
    hs_crp = _lab_value(h, "hs_crp", "hs-crp", "crp")
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("fiber logs", n.avg_fiber_g is not None),
        ("added sugar logs", n.avg_added_sugar_g is not None),
        ("saturated fat logs", n.avg_saturated_fat_g is not None),
        (
            "omega-3 or seafood pattern",
            n.avg_omega_3_g is not None or n.omega3_servings > 0 or n.seafood_servings > 0,
        ),
        ("sleep duration", s.avg_hours is not None),
        ("activity", a.avg_steps is not None or a.avg_cardio_minutes is not None),
        ("HRV/RHR trend", (h.hrv_latest is not None and h.hrv_baseline is not None) or (h.rhr_latest is not None and h.rhr_baseline is not None)),
        ("stress check-ins", recovery.stress_note_count > 0),
        ("inflammation lab", hs_crp is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="inflammation_support",
            title="Inflammation Support Environment",
            category="inflammation",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals, sleep, and activity for a week to unlock inflammation-support patterns.",
        )

    score = 74.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    sugar_pct = _added_sugar_pct_calories(n)
    sat_pct = _saturated_fat_pct_calories(n)
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 18:
            score -= 14
            drivers.append("Fiber is low across recent tracked days.")
            recs.append("Add one high-fiber plant food to a recurring meal.")
        elif n.avg_fiber_g >= 25:
            positives.append("Fiber intake supports an anti-inflammatory eating pattern.")
    if sugar_pct is not None:
        if sugar_pct >= 12:
            score -= 14
            drivers.append("Added sugar is high as a share of tracked calories.")
            recs.append("Reduce one recurring sugary drink or snack before changing everything else.")
        elif sugar_pct <= 6:
            positives.append("Added sugar is not dominating tracked calories.")
    elif n.avg_added_sugar_g is not None and n.avg_added_sugar_g >= 50:
        score -= 8
        drivers.append("Added sugar grams are high on tracked days.")
    if sat_pct is not None:
        if sat_pct >= 12:
            score -= 10
            drivers.append("Saturated fat is high as a share of tracked calories.")
        elif sat_pct <= 9:
            positives.append("Saturated fat is moderate in tracked meals.")
    if n.ultra_processed_pct is not None:
        if n.ultra_processed_pct >= 45:
            score -= 10
            drivers.append("Ultra-processed items make up a high share of classified foods.")
        elif n.ultra_processed_pct <= 25:
            positives.append("Classified foods skew toward less-processed choices.")
    if n.processed_meat_servings >= 3:
        score -= 6
        drivers.append("Processed meat appears repeatedly in the recent food pattern.")
    if n.avg_alcohol_servings is not None:
        if n.avg_alcohol_servings >= 2.0:
            score -= 10
            drivers.append("Alcohol is frequent in recent logs — a well-established pro-inflammatory dietary pattern.")
            recs.append("Aim for 2+ alcohol-free days per week to reduce cumulative inflammatory load.")
        elif n.avg_alcohol_servings >= 1.0:
            score -= 5
            drivers.append("Regular alcohol appears in recent logs — even moderate intake can sustain low-grade inflammatory signaling.")
    omega3_total = n.omega3_servings + n.seafood_servings
    if n.avg_omega_3_g is not None and n.avg_omega_3_g >= 1.0:
        positives.append("Structured omega-3 intake is present in logged micronutrients.")
    elif omega3_total >= 2:
        positives.append("Seafood or omega-3-rich foods appear in the recent pattern.")
    elif n.days_with_data >= 5:
        score -= 6
        drivers.append("Omega-3 or seafood signals are sparse in recent logs.")
    if n.distinct_plant_foods_week >= 10:
        positives.append("High plant variety this week — diverse phytonutrients and polyphenols support anti-inflammatory pathways.")
    elif n.distinct_plant_foods_week >= 6:
        positives.append("Moderate plant variety is present across the tracked week.")
    elif n.distinct_plant_foods_week > 0 and n.distinct_plant_foods_week <= 3 and n.days_with_data >= 5:
        score -= 4
        drivers.append("Plant variety is narrow this week — a wider range of vegetables, fruits, and legumes helps dampen inflammatory signaling.")
    if meals.fermented_food_days >= 4:
        positives.append("Fermented foods appear on multiple days — supporting gut barrier health and reducing systemic inflammatory load.")
    elif meals.fermented_food_days >= 2:
        positives.append("Some fermented food intake is present in recent logs.")
    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 12
            drivers.append("Sleep is short, which weakens recovery and inflammation-support habits.")
        elif s.avg_hours >= 7:
            positives.append("Sleep duration supports recovery regulation.")
    if recovery.stress_note_count >= 2:
        score -= 8
        drivers.append("Stress-related check-in notes appear repeatedly in this window.")
        recs.append("Use a short decompression block, walk, or breathing session on high-stress days.")
    if hs_crp is not None:
        if hs_crp >= 3:
            score -= 16
            drivers.append("A recent CRP/hs-CRP lab is above the app's wellness target; this is context, not a diagnosis.")
        elif hs_crp < 1:
            positives.append("A recent CRP/hs-CRP lab is within the app's low-support-gap range.")

    signals: list[EvidenceSignal] = []
    if f.metrics["added_sugar_g"].days_above_threshold >= 3 and f.metrics["fiber_g"].days_below_threshold >= 3:
        signals.append(_signal(
            "high_sugar_low_fiber",
            "High sugar plus low fiber",
            "risk",
            min(1.0, (f.metrics["added_sugar_g"].days_above_threshold + f.metrics["fiber_g"].days_below_threshold) / 10.0),
            f.coverage["nutrition"],
            10,
            "High added sugar and low fiber repeatedly show up together in recent logs.",
        ))
    if meals.refined_grain_meals >= 5 and meals.whole_grain_days <= 2:
        signals.append(_signal(
            "refined_grain_pattern",
            "Refined-grain pattern",
            "risk",
            min(1.0, meals.refined_grain_meals / 8.0),
            f.coverage["nutrition"] * 0.75,
            6,
            "Refined-grain frequency is high while whole-grain days are sparse.",
        ))
    if meals.fermented_food_days >= 3 or meals.unsaturated_fat_source_days >= 4 or meals.plant_protein_days >= 4:
        signals.append(_signal(
            "anti_inflammatory_food_pattern",
            "Supportive food pattern",
            "protective",
            min(1.0, (meals.fermented_food_days + meals.unsaturated_fat_source_days + meals.plant_protein_days) / 10.0),
            f.coverage["nutrition"] * 0.75,
            8,
            "Fermented foods, unsaturated-fat sources, or plant proteins appear repeatedly.",
        ))
    if (a.avg_steps is not None and a.avg_steps < 5000) and (a.avg_cardio_minutes is None or a.avg_cardio_minutes * 7 < CARDIO_LOW_MINUTES_WEEK):
        signals.append(_signal(
            "low_movement_inflammation",
            "Low movement",
            "risk",
            0.7,
            f.coverage["activity"],
            8,
            "Daily movement and cardio are low in the same window.",
        ))
    elif (a.avg_cardio_minutes or 0) * 7 >= CARDIO_GUIDELINE_MINUTES_WEEK or (a.avg_steps or 0) >= 7500:
        signals.append(_signal(
            "movement_support",
            "Movement support",
            "protective",
            0.8,
            f.coverage["activity"],
            8,
            "Cardio minutes or daily steps are supportive in the recent window.",
        ))
    if recovery.hrv_suppression_days + recovery.rhr_elevation_days >= 2:
        signals.append(_signal(
            "autonomic_recovery_pressure",
            "Autonomic recovery pressure",
            "risk",
            min(1.0, (recovery.hrv_suppression_days + recovery.rhr_elevation_days) / 5.0),
            f.coverage["apple_health"],
            8,
            "HRV/RHR recovery pressure appears on multiple days.",
        ))
    if w.consecutive_hard_days_14d >= 2 or w.long_endurance_or_two_a_day_sessions_14d >= 2:
        signals.append(_signal(
            "training_stress_cluster",
            "Training stress cluster",
            "risk",
            min(1.0, (w.consecutive_hard_days_14d + w.long_endurance_or_two_a_day_sessions_14d) / 5.0),
            f.coverage["workouts"],
            7,
            "Hard training is clustered enough to add short-term recovery pressure.",
        ))
    if n.avg_vitamin_d_mcg is not None and n.avg_vitamin_d_mcg < 10:
        signals.append(_signal(
            "low_vitamin_d_context",
            "Vitamin D context",
            "risk",
            min(1.0, (10 - n.avg_vitamin_d_mcg) / 10.0),
            f.coverage["nutrition"],
            5,
            "Structured vitamin D intake is low in micronutrient logs.",
        ))
    if n.avg_magnesium_mg is not None and n.avg_magnesium_mg >= 300 and n.avg_zinc_mg is not None and n.avg_zinc_mg >= 8:
        signals.append(_signal(
            "micronutrient_support",
            "Micronutrient support",
            "protective",
            0.7,
            f.coverage["nutrition"],
            6,
            "Magnesium and zinc logs look supportive in the micronutrient data.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Anchor the basics this week: plants/fiber, omega-3 sources, regular movement, and consistent sleep.")
    final = _clamp(score)
    risk_signal_count = _corroborating_count(signals)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["sleep"], 0.2), max(f.coverage["activity"], 0.2)),
        corroborating_signals=risk_signal_count,
    )
    if hs_crp is None and any("lab" in item for item in missing):
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No CRP/hs-CRP lab is available, so this remains a habit-support pattern",
        )
    if n.avg_omega_3_g is None and omega3_total:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Omega-3 support is inferred from food tags rather than structured omega-3 values",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="inflammation_support",
        title="Inflammation Support Environment",
        category="inflammation",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews nutrition, sleep, activity, recovery, and optional CRP context that can support a lower-inflammatory lifestyle pattern. It does not diagnose inflammation.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            micronutrients=n.micronutrient_logged_days > 0,
            sleep=s.avg_hours is not None,
            activity=a.days_with_data > 0,
            workouts=w.completed_sessions > 0,
            apple_health=h.hrv_latest is not None or h.rhr_latest is not None,
            labs=hs_crp is not None,
            checkins=recovery.stress_note_count > 0,
            alcohol=n.avg_alcohol_servings is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_brain_health_support(ctx: InsightContext) -> InsightCard:
    n, s, a, h = ctx.nutrition, ctx.sleep, ctx.activity, ctx.health
    f = _features(ctx)
    meals = f.meals
    recovery = f.recovery
    lifestyle = ctx.lifestyle
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sleep duration", s.avg_hours is not None),
        ("sleep timing", s.bedtime_std_minutes is not None),
        ("nutrition quality", n.days_with_data >= 3),
        ("omega-3 or seafood pattern", n.avg_omega_3_g is not None or n.omega3_servings > 0 or n.seafood_servings > 0),
        ("hydration logs", n.avg_water_oz is not None),
        ("activity", a.avg_steps is not None or a.avg_cardio_minutes is not None),
        (
            "caffeine timing",
            n.caffeine_logged_days > 0 or meals.late_caffeine_count > 0 or bool(lifestyle.late_caffeine_dates),
        ),
        ("alcohol logs", n.avg_alcohol_servings is not None or lifestyle.logs_count > 0),
        ("micronutrient logs", n.micronutrient_logged_days > 0),
        (
            "HRV/RHR trend",
            (h.hrv_latest is not None and h.hrv_baseline is not None)
            or (h.rhr_latest is not None and h.rhr_baseline is not None),
        ),
    ):
        (present if ok else missing).append(label)
    if len(present) < 3:
        return _unknown_card(
            card_id="brain_health_support",
            title="Brain Health Support",
            category="brain_health",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log sleep, meals, hydration, and activity for a week to unlock brain-health support patterns.",
        )

    score = 76.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    sugar_pct = _added_sugar_pct_calories(n)
    omega3_total = n.omega3_servings + n.seafood_servings
    weekly_cardio = a.avg_cardio_minutes * 7 if a.avg_cardio_minutes is not None else None

    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 16
            drivers.append(f"Average sleep is {s.avg_hours:.1f}h, which weakens cognitive-energy support.")
            recs.append("Protect a longer sleep window before changing multiple nutrition variables.")
        elif s.avg_hours >= 7.0:
            score += 5
            positives.append("Sleep duration is in a supportive range.")
    if s.bedtime_std_minutes is not None:
        if s.bedtime_std_minutes > 90:
            score -= 7
            drivers.append("Sleep timing is inconsistent across recent nights.")
            recs.append("Keep wake time and bedtime inside a tighter window for one week.")
        elif s.bedtime_std_minutes <= 45:
            positives.append("Sleep timing is fairly consistent.")
    late_caffeine_count = max(meals.late_caffeine_count, len(lifestyle.late_caffeine_dates))
    if meals.structured_late_caffeine_count >= 2 or n.late_caffeine_mg >= 200:
        score -= 10
        drivers.append(f"Structured caffeine timing shows {n.late_caffeine_mg:.0f}mg after the early-afternoon cutoff.")
        recs.append("Move caffeine earlier for seven days and compare sleep or focus notes.")
    elif late_caffeine_count >= 2:
        score -= 6
        drivers.append("Late caffeine appears repeatedly; exact dose would sharpen this read.")
    evening_alcohol_count = max(meals.evening_alcohol_count, len(lifestyle.alcohol_dates))
    if (n.avg_alcohol_servings or 0) >= 1 or evening_alcohol_count >= 2:
        score -= 8
        drivers.append("Alcohol appears often enough to add noise to sleep and next-day cognitive-energy support.")
    hydration_ratio = None
    if n.avg_water_oz is not None and n.estimated_hydration_target_oz:
        hydration_ratio = n.avg_water_oz / n.estimated_hydration_target_oz
        if hydration_ratio < 0.75:
            score -= 9
            drivers.append("Hydration is well below the estimated target on logged days.")
            recs.append("Bring water closer to target before adding new supplements.")
        elif hydration_ratio >= 0.9:
            positives.append("Hydration logs are close to target.")
    if n.avg_omega_3_g is not None:
        if n.avg_omega_3_g >= 1.0:
            score += 5
            positives.append("Structured omega-3 intake is present in micronutrient logs.")
        elif n.avg_omega_3_g < 0.25:
            score -= 8
            drivers.append("Structured omega-3 intake is low in micronutrient logs.")
            recs.append("Add a recurring omega-3 source, such as seafood or another preferred option.")
    elif omega3_total >= 2:
        positives.append("Seafood or omega-3-rich foods appear in the recent pattern.")
    elif n.days_with_data >= 5:
        score -= 6
        drivers.append("Omega-3 or seafood signals are sparse in recent logs.")
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 18:
            score -= 8
            drivers.append("Fiber is low across recent tracked days.")
            recs.append("Add one high-fiber plant food to a repeat meal.")
        elif n.avg_fiber_g >= 25:
            positives.append("Fiber intake supports the broader nutrition pattern.")
    if n.distinct_plant_foods_week:
        if n.distinct_plant_foods_week >= 20:
            positives.append("Plant-food variety is broad in recent logs.")
        elif n.distinct_plant_foods_week < 8 and n.days_with_data >= 5:
            score -= 4
            drivers.append("Plant-food variety is narrow in recent logs.")
    if sugar_pct is not None:
        if sugar_pct >= 12:
            score -= 7
            drivers.append("Added sugar is high as a share of tracked calories.")
        elif sugar_pct <= 6:
            positives.append("Added sugar is not dominating tracked calories.")
    elif n.avg_added_sugar_g is not None and n.avg_added_sugar_g >= 50:
        score -= 5
        drivers.append("Added sugar grams are high on tracked days.")
    if n.ultra_processed_pct is not None:
        if n.ultra_processed_pct >= 45:
            score -= 6
            drivers.append("Ultra-processed items make up a high share of classified foods.")
        elif n.ultra_processed_pct <= 25:
            positives.append("Classified foods skew toward less-processed choices.")
    if a.avg_steps is not None and a.avg_steps < 5000 and (weekly_cardio is None or weekly_cardio < CARDIO_LOW_MINUTES_WEEK):
        score -= 8
        drivers.append("Daily movement and cardio are both low in the recent window.")
        recs.append("Add two easy walks or Zone 2 sessions this week.")
    elif (weekly_cardio is not None and weekly_cardio >= CARDIO_GUIDELINE_MINUTES_WEEK) or (a.avg_steps or 0) >= 7500:
        positives.append("Movement volume supports brain-health habits.")
    stress_count = recovery.stress_note_count + len(lifestyle.high_stress_dates)
    if stress_count >= 2:
        score -= 6
        drivers.append("Stress-related logs appear repeatedly in this window.")
        recs.append("Use a short decompression walk or breathing block on high-stress days.")
    if recovery.hrv_suppression_days + recovery.rhr_elevation_days >= 2:
        score -= 6
        drivers.append("HRV/RHR recovery pressure appears on multiple days.")
    elif _hrv_ratio(h) is not None and _hrv_ratio(h) >= 0.95 and _rhr_delta(h) is not None and _rhr_delta(h) <= 2:
        positives.append("HRV/RHR markers are close to recent baseline.")

    low_micros: list[str] = []
    if n.avg_vitamin_b12_mcg is not None and n.avg_vitamin_b12_mcg < 2.4:
        low_micros.append("B12")
    if n.avg_folate_mcg is not None and n.avg_folate_mcg < 300:
        low_micros.append("folate")
    iron_floor = 12.0 if (ctx.user.sex or "").strip().lower() == "female" else 8.0
    if n.avg_iron_mg is not None and n.avg_iron_mg < iron_floor:
        low_micros.append("iron")
    if n.avg_magnesium_mg is not None and n.avg_magnesium_mg < 250:
        low_micros.append("magnesium")
    if n.avg_vitamin_d_mcg is not None and n.avg_vitamin_d_mcg < 10:
        low_micros.append("vitamin D")
    if low_micros:
        score -= min(10, len(low_micros) * 4)
        drivers.append(f"Micronutrient logs show low {', '.join(low_micros[:3])} support.")
    elif n.micronutrient_logged_days > 0 and any(
        value is not None for value in (n.avg_vitamin_b12_mcg, n.avg_folate_mcg, n.avg_iron_mg, n.avg_magnesium_mg, n.avg_vitamin_d_mcg)
    ):
        positives.append("Brain-relevant micronutrient logs do not show a clear gap.")

    signals: list[EvidenceSignal] = []
    if f.overlaps["high_sugar_low_activity"] >= 2:
        signals.append(_signal(
            "high_sugar_low_activity_brain",
            "High sugar plus low activity",
            "risk",
            min(1.0, f.overlaps["high_sugar_low_activity"] / 4.0),
            min(f.coverage["nutrition"], f.coverage["activity"]),
            6,
            "High added sugar and low activity overlap on multiple days.",
        ))
    omega3_fiber_present = (
        meals.seafood_days >= 2
        or (n.avg_omega_3_g is not None and n.avg_omega_3_g >= 1.0)
    )
    if omega3_fiber_present and (n.avg_fiber_g or 0) >= 25:
        signals.append(_signal(
            "omega3_fiber_pattern_brain",
            "Omega-3 plus fiber",
            "protective",
            0.8,
            f.coverage["nutrition"],
            7,
            "Omega-3 sources and fiber both support the recent food pattern.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    drivers.extend(signal.explanation for signal in signals if signal.direction == "risk")
    positives.extend(signal.explanation for signal in signals if signal.direction == "protective")
    if not recs:
        recs.append("Keep the basics steady: consistent sleep, omega-3 sources, hydration, movement, plants, and earlier caffeine.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["sleep"], 0.2), max(f.coverage["activity"], 0.2)),
        corroborating_signals=_corroborating_count(signals),
    )
    if n.avg_omega_3_g is None and omega3_total:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Omega-3 support is inferred from food tags rather than structured omega-3 values",
        )
    if n.micronutrient_logged_days == 0:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No structured micronutrient logs are available, so this remains a habit-support pattern",
        )
    if meals.inferred_late_caffeine_count and not meals.structured_late_caffeine_count:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Caffeine timing is inferred from food tags rather than structured caffeine dose",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="brain_health_support",
        title="Brain Health Support",
        category="brain_health",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews sleep, nutrition, hydration, activity, caffeine/alcohol timing, and optional micronutrients that can support cognitive energy and long-term brain-health habits. It is not a cognitive test or diagnosis.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.avg_hours is not None or s.bedtime_std_minutes is not None,
            nutrition=n.days_with_data > 0,
            micronutrients=n.micronutrient_logged_days > 0,
            hydration=n.avg_water_oz is not None,
            activity=a.days_with_data > 0,
            caffeine=n.caffeine_logged_days > 0 or late_caffeine_count > 0,
            lifestyle=lifestyle.logs_count > 0,
            apple_health=h.hrv_latest is not None or h.rhr_latest is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_protein_quality_pattern(ctx: InsightContext) -> InsightCard:
    n, u = ctx.nutrition, ctx.user
    f = _features(ctx)
    meals = f.meals
    plant_pct = _plant_protein_pct(n)
    protein_lb = _protein_g_per_lb(n, u)
    diversity = meals.protein_source_diversity_score
    max_meal_pct = _max_meal_protein_percent(n)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("protein totals", n.avg_protein_g is not None),
        ("plant vs animal protein split", n.avg_plant_protein_g is not None and n.avg_animal_protein_g is not None),
        ("body weight for per-lb adequacy", u.weight_lbs is not None),
        ("source diversity pattern", diversity is not None),
        ("largest-meal protein share", max_meal_pct is not None),
        ("post-workout protein timing", n.post_workout_timing_sessions > 0),
        ("meal protein balance", meals.high_carb_low_protein_meals > 0 or n.days_with_data >= 3),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2 or n.avg_protein_g is None:
        return _unknown_card(
            card_id="protein_quality_pattern",
            title="Protein Quality & Distribution",
            category="diet_quality",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals with protein details for a week to unlock protein quality, source mix, and distribution patterns.",
        )

    score = 72.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if protein_lb is not None:
        if protein_lb < 0.6:
            score -= 18
            drivers.append("Protein per pound of body weight is below a generally supportive range.")
            recs.append("Add a protein-dense item to one recurring meal to lift the daily total.")
        elif protein_lb < 0.8:
            score -= 8
            drivers.append("Protein per pound is modest; you can likely lift it without big changes.")
        else:
            positives.append("Protein per pound is in a generally supportive range.")
    if plant_pct is not None:
        if plant_pct < 15:
            score -= 12
            drivers.append("Plant protein is a small share of total protein in recent logs.")
            recs.append("Swap one animal-protein side for legumes, tofu, or tempeh a couple of times this week.")
        elif plant_pct < 30:
            score -= 4
            drivers.append("Plant protein share is on the low side; small shifts could broaden the mix.")
        elif plant_pct > 80:
            score -= 6
            drivers.append("Logged protein is almost entirely plant-sourced, so total protein and leucine-rich choices matter more per meal.")
            recs.append("Anchor at least one meal with soy foods, a pea/rice blend, whey, eggs, dairy, fish, or poultry if those fit your preferences.")
        else:
            positives.append("Protein mix balances plant and animal sources.")
    if diversity is not None:
        if diversity >= 0.7:
            positives.append("Protein sources rotate across multiple foods — broader amino-acid coverage.")
        elif diversity < 0.4:
            score -= 6
            drivers.append("Protein sources are concentrated in just a few foods.")
            recs.append("Rotate at least one new protein source (e.g., fish, eggs, lentils) into the week.")
    if meals.plant_protein_days >= 4:
        positives.append("Plant protein appears on most tracked days.")
    if n.avg_protein_g is not None and n.avg_protein_g < 60:
        score -= 6
        drivers.append("Total protein grams are low even before factoring body weight.")
    if max_meal_pct is not None:
        if max_meal_pct >= 70:
            score -= 12
            drivers.append(f"Protein is heavily concentrated in one meal on tracked days ({max_meal_pct:.0f}% at the largest meal).")
            recs.append("Move some protein into breakfast, lunch, or an earlier snack instead of relying on one large serving.")
        elif max_meal_pct >= 55:
            score -= 6
            drivers.append(f"The largest meal carries about {max_meal_pct:.0f}% of daily protein.")
            recs.append("Spread one protein anchor into another meal or snack.")
        elif 30 <= max_meal_pct <= 50:
            score += 4
            positives.append("Protein is not overly concentrated in a single meal.")
    if meals.high_carb_low_protein_meals >= 4:
        score -= 8
        drivers.append(f"High-carb, low-protein meals appeared {meals.high_carb_low_protein_meals} times.")
        recs.append("Add 20-30g protein to one recurring high-carb meal.")
    elif meals.high_carb_low_protein_meals >= 2:
        score -= 4
        drivers.append("A few meals are high-carb but light on protein.")
    if n.post_workout_timing_sessions > 0:
        coverage = n.post_workout_protein_sessions / max(1, n.post_workout_timing_sessions)
        if coverage >= 0.75:
            score += 4
            positives.append("Post-workout protein appears after most timestamped training sessions.")
        elif coverage < 0.5:
            score -= 6
            drivers.append("Post-workout protein is inconsistent after timestamped sessions.")
            recs.append("Pair training with a simple protein anchor within the next meal.")

    signals: list[EvidenceSignal] = []
    if protein_lb is not None and protein_lb < 0.6:
        signals.append(_signal(
            "protein_adequacy_gap",
            "Protein adequacy gap",
            "risk",
            min(1.0, (0.6 - protein_lb) / 0.4),
            f.coverage["nutrition"],
            10,
            "Protein-per-pound sits below a generally supportive band.",
        ))
    if plant_pct is not None and plant_pct < 15:
        signals.append(_signal(
            "plant_protein_underweight",
            "Plant protein underweight",
            "risk",
            min(1.0, (15 - plant_pct) / 15.0),
            f.coverage["nutrition"],
            6,
            "Plant protein contributes very little to the protein total.",
        ))
    if diversity is not None and diversity >= 0.7:
        signals.append(_signal(
            "protein_source_diversity",
            "Protein source diversity",
            "protective",
            min(1.0, diversity),
            f.coverage["nutrition"] * 0.9,
            8,
            "Logged protein sources rotate across several foods.",
        ))
    score = _apply_evidence(score, signals, risk_direction="higher_is_better")
    if not recs:
        recs.append("Keep protein varied and spread repeatable protein anchors across the day.")
    final = _clamp(score)
    distribution_signal_count = sum(1 for item in (
        max_meal_pct is not None and max_meal_pct >= 55,
        meals.high_carb_low_protein_meals >= 2,
        n.post_workout_timing_sessions > 0,
    ) if item)
    risk_signal_count = _corroborating_count(signals) + distribution_signal_count
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(f.coverage["nutrition"], 0.2),
        corroborating_signals=risk_signal_count,
    )
    if u.weight_lbs is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No body weight is recorded, so per-lb adequacy uses fallback ranges",
        )
    if max_meal_pct is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Largest-meal protein share is missing, so distribution is inferred from meal patterns",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="protein_quality_pattern",
        title="Protein Quality & Distribution",
        category="diet_quality",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews protein amount, source mix, variety, meal distribution, and post-workout timing. It is not a medical adequacy diagnosis.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            body=u.weight_lbs is not None,
            workouts=n.post_workout_timing_sessions > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def _max_meal_protein_percent(n: NutritionSummary) -> float | None:
    value = n.avg_max_meal_protein_pct
    if value is None or value <= 0:
        return None
    return value * 100.0 if value <= 1.5 else value


def _modality_label(value: str) -> str:
    return value.replace("_", " ").strip().title() or "Recovery"


def _next_day_delta(
    series: dict[date, float],
    exposure_dates: set[date],
    *,
    percent: bool = False,
) -> tuple[int, float | None]:
    next_dates = {d + timedelta(days=1) for d in exposure_dates}
    observed = [float(series[d]) for d in next_dates if d in series]
    if len(observed) < 2:
        return len(observed), None
    baseline_values = [
        float(v) for d, v in series.items()
        if d not in next_dates and v is not None
    ]
    if len(baseline_values) < 3:
        baseline_values = [float(v) for v in series.values() if v is not None]
    if len(baseline_values) < 3:
        return len(observed), None
    baseline = median(baseline_values)
    observed_avg = mean(observed)
    if percent:
        if baseline == 0:
            return len(observed), None
        return len(observed), (observed_avg - baseline) / baseline * 100.0
    return len(observed), observed_avg - baseline


def compute_healthspan_foundations(ctx: InsightContext) -> InsightCard:
    n, s, a, w, h = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health
    f = _features(ctx)
    present: list[str] = []
    missing: list[str] = []
    a1c = _lab_value(h, "a1c", "hba1c")
    fasting_glucose = _lab_value(h, "fasting_glucose", "glucose")
    ldl = _lab_value(h, "ldl", "ldl_cholesterol")
    triglycerides = _lab_value(h, "triglycerides", "tg")
    for label, ok in (
        ("sleep duration and timing", s.avg_hours is not None or s.bedtime_std_minutes is not None),
        ("daily movement", a.avg_steps is not None or _active_days_per_week(ctx) is not None),
        ("cardio fitness trend", a.avg_cardio_minutes is not None or h.vo2_latest is not None or _rhr_delta(h) is not None),
        ("nutrition quality", n.days_with_data >= 3),
        ("resistance training", w.resistance_sessions_14d > 0 or w.completed_sessions > 0),
        ("body trend or labs", h.weight_trend_lbs_per_week is not None or h.latest_labs or h.bp_reading_count > 0),
    ):
        (present if ok else missing).append(label)
    if len(present) < 3:
        return _unknown_card(
            card_id="healthspan_foundations",
            title="Healthspan Foundations",
            category="healthspan",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log sleep, meals, movement, and workouts for a week to unlock the healthspan foundations view.",
        )

    score = 72.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    active_days = _active_days_per_week(ctx)
    weekly_cardio = (a.avg_cardio_minutes or 0) * 7 if a.avg_cardio_minutes is not None else None
    sugar_pct = _added_sugar_pct_calories(n)
    sat_pct = _saturated_fat_pct_calories(n)

    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 14
            drivers.append(f"Average sleep is {s.avg_hours:.1f}h, which weakens the foundation score.")
            recs.append("Protect a longer sleep window before adding new training or diet complexity.")
        elif s.avg_hours >= 7.0:
            score += 5
            positives.append("Sleep duration is in a supportive range.")
    if s.bedtime_std_minutes is not None:
        if s.bedtime_std_minutes > 90:
            score -= 6
            drivers.append("Sleep timing is inconsistent across the recent window.")
        elif s.bedtime_std_minutes <= 45:
            positives.append("Sleep timing is consistent.")
    if active_days is not None:
        if active_days < 3:
            score -= 12
            drivers.append("Active days are sparse across the recent two-week window.")
            recs.append("Add two low-friction movement days before increasing intensity.")
        elif active_days >= 5:
            score += 6
            positives.append("Active days are frequent enough to support long-term consistency.")
    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            score -= 8
            drivers.append("Average steps are low.")
        elif a.avg_steps >= 8000:
            positives.append("Average steps support daily movement.")
    if weekly_cardio is not None:
        if weekly_cardio < CARDIO_LOW_MINUTES_WEEK:
            score -= 10
            drivers.append("Cardio minutes are below a strong weekly foundation.")
            recs.append("Add two easy Zone 2 sessions or brisk walks this week.")
        elif weekly_cardio >= CARDIO_GUIDELINE_MINUTES_WEEK:
            score += 5
            positives.append("Cardio volume supports the foundations score.")
    if w.resistance_sessions_14d > 0:
        if w.resistance_sessions_14d < 2:
            score -= 6
            drivers.append("Resistance training appears, but not often enough to strongly support muscle and bone maintenance.")
        elif w.resistance_sessions_14d >= 4:
            score += 5
            positives.append("Resistance training frequency supports muscle maintenance.")
    if n.avg_fiber_g is not None:
        if n.avg_fiber_g < 18:
            score -= 10
            drivers.append("Fiber is low across recent tracked days.")
            recs.append("Add one high-fiber plant food to a recurring meal.")
        elif n.avg_fiber_g >= 25:
            score += 5
            positives.append("Fiber intake supports metabolic and gut-health foundations.")
    if sugar_pct is not None and sugar_pct >= 12:
        score -= 7
        drivers.append("Added sugar is high as a share of tracked calories.")
    if sat_pct is not None and sat_pct >= 12:
        score -= 5
        drivers.append("Saturated fat is high as a share of tracked calories.")
    if n.ultra_processed_pct is not None:
        if n.ultra_processed_pct >= 45:
            score -= 7
            drivers.append("Ultra-processed items make up a high share of classified foods.")
        elif n.ultra_processed_pct <= 25:
            positives.append("Classified foods skew toward less-processed choices.")
    if n.distinct_plant_foods_week:
        if n.distinct_plant_foods_week >= 20:
            score += 5
            positives.append("Plant-food variety is broad in recent logs.")
        elif n.distinct_plant_foods_week < 8 and n.days_with_data >= 5:
            score -= 4
            drivers.append("Plant-food variety is narrow in recent logs.")
    if _rhr_delta(h) is not None and _rhr_delta(h) >= 6:
        score -= 6
        drivers.append("Resting heart rate is elevated versus recent baseline.")
    if _hrv_ratio(h) is not None and _hrv_ratio(h) <= 0.85:
        score -= 6
        drivers.append("HRV is suppressed versus recent baseline.")
    if h.weight_trend_lbs_per_week is not None and abs(h.weight_trend_lbs_per_week) <= 1.0:
        positives.append("Recent weight trend is not changing rapidly.")
    if h.bp_reading_count >= 2 and h.median_bp_systolic is not None and h.median_bp_diastolic is not None:
        if h.median_bp_systolic >= 130 or h.median_bp_diastolic >= 80:
            score -= 7
            drivers.append("Recent blood-pressure readings are above the app's wellness target.")
        else:
            positives.append("Recent blood-pressure readings are within the app's wellness target.")
    if a1c is not None and a1c >= 5.7:
        score -= 7
        drivers.append("A1C is above the app's screening-support target; this is context, not a diagnosis.")
    elif a1c is not None and a1c < 5.4:
        positives.append("A1C is within the app's low-support-gap range.")
    if fasting_glucose is not None and fasting_glucose >= 100:
        score -= 5
        drivers.append("Fasting glucose is above the app's screening-support target; this is context, not a diagnosis.")
    if ldl is not None and ldl >= 130:
        score -= 5
        drivers.append("LDL is above the app's wellness target.")
    if triglycerides is not None and triglycerides >= 150:
        score -= 5
        drivers.append("Triglycerides are above the app's wellness target.")
    if not recs:
        recs.append("Keep the foundations boring and repeatable: sleep, steps, cardio, resistance training, fiber, and mostly minimally processed meals.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["sleep"], 0.2), max(f.coverage["activity"], 0.2)),
        corroborating_signals=sum(1 for item in drivers if item),
    )
    if not h.latest_labs:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No recent labs are available, so this remains a behavior-and-trend foundations score",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="healthspan_foundations",
        title="Healthspan Foundations",
        category="healthspan",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This combines sleep, movement, cardio, resistance training, nutrition quality, and optional labs/BP into one non-diagnostic foundations view.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.avg_hours is not None or s.bedtime_std_minutes is not None,
            activity=a.days_with_data > 0,
            workouts=w.completed_sessions > 0,
            nutrition=n.days_with_data > 0,
            apple_health=h.days_with_data > 0,
            labs=bool(h.latest_labs),
            checkins=h.bp_reading_count > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_cardio_efficiency_trend(ctx: InsightContext) -> InsightCard:
    a, h, w = ctx.activity, ctx.health, ctx.workouts
    f = _features(ctx)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("cardio minutes", a.avg_cardio_minutes is not None),
        ("Zone 2 minutes", a.avg_zone2_minutes is not None),
        ("VO2 max trend", h.vo2_latest is not None),
        ("resting heart rate trend", _rhr_delta(h) is not None),
        ("daily steps", a.avg_steps is not None),
        ("workout history", w.completed_sessions > 0),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="cardio_efficiency_trend",
            title="Cardio Efficiency Trend",
            category="cardio",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Sync activity, resting heart rate, or VO2 max for a week so this can read the cardio trend.",
        )

    score = 68.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    weekly_cardio = a.avg_cardio_minutes * 7 if a.avg_cardio_minutes is not None else None
    weekly_zone2 = a.avg_zone2_minutes * 7 if a.avg_zone2_minutes is not None else None
    rhr = _rhr_delta(h)

    if weekly_cardio is not None:
        if weekly_cardio < 60:
            score -= 16
            drivers.append("Cardio volume is too low to build a strong efficiency trend.")
            recs.append("Start with two easy 20-30 minute Zone 2 sessions this week.")
        elif weekly_cardio < CARDIO_GUIDELINE_MINUTES_WEEK:
            score -= 8
            drivers.append("Cardio volume is present but still below a strong weekly base.")
        elif weekly_cardio >= CARDIO_GUIDELINE_MINUTES_WEEK:
            score += 10
            positives.append("Weekly cardio volume is in a strong support range.")
    if weekly_zone2 is not None:
        if weekly_zone2 < 45:
            score -= 6
            drivers.append("Zone 2 volume is light, so cardio work may not be building much aerobic base.")
        elif weekly_zone2 >= 90:
            score += 8
            positives.append("Zone 2 minutes are consistent enough to support aerobic efficiency.")
    if h.vo2_trend_per_90d is not None:
        if h.vo2_trend_per_90d <= -1.0:
            score -= 10
            drivers.append(f"VO2 max trend is down about {abs(h.vo2_trend_per_90d):.1f} points per 90 days.")
            recs.append("Keep intensity controlled and rebuild consistency before adding intervals.")
        elif h.vo2_trend_per_90d >= 1.0:
            score += 10
            positives.append(f"VO2 max trend is up about {h.vo2_trend_per_90d:.1f} points per 90 days.")
        else:
            positives.append("VO2 max is being tracked and looks fairly stable.")
    elif h.vo2_latest is not None:
        positives.append("VO2 max is being tracked, which will make the trend more useful over time.")
    if rhr is not None:
        if rhr >= 6:
            score -= 10
            drivers.append(f"Resting heart rate is about {rhr:.0f} bpm above recent baseline.")
        elif rhr <= 0:
            score += 5
            positives.append("Resting heart rate is at or below recent baseline.")
    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            score -= 8
            drivers.append("Low step count limits the aerobic base outside formal workouts.")
        elif a.avg_steps >= 8000:
            positives.append("Daily steps support aerobic base between workouts.")
    if w.hard_endurance_sessions_14d + w.hard_glycolytic_sessions_14d >= 3 and (weekly_zone2 or 0) < 60:
        score -= 6
        drivers.append("Hard endurance or interval work is showing up without much easy aerobic volume.")
        recs.append("Bias the next cardio sessions easier until easy volume catches up.")
    if not recs:
        recs.append("Keep most cardio easy enough to repeat, then use VO2/RHR trend to decide when to add intensity.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(f.coverage["activity"], f.coverage["apple_health"]),
        corroborating_signals=sum(1 for item in drivers if item),
    )
    if h.vo2_latest is None and rhr is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No VO2 or resting-heart-rate trend is available, so the card relies on activity volume",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="cardio_efficiency_trend",
        title="Cardio Efficiency Trend",
        category="cardio",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reads whether cardio volume, Zone 2 work, VO2 max, steps, and resting heart rate are moving in a supportive direction.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            activity=a.days_with_data > 0,
            workouts=w.completed_sessions > 0,
            apple_health=h.vo2_latest is not None or rhr is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_bone_density_support(ctx: InsightContext) -> InsightCard:
    n, s, a, w, h, u = ctx.nutrition, ctx.sleep, ctx.activity, ctx.workouts, ctx.health, ctx.user
    f = _features(ctx)
    bmd = _lab_value_with_unit(h, "bone_mineral_density", "bmd", "bone_density")
    t_score = _lab_value(h, "bone_density_t_score", "dexa_t_score", "t_score")
    z_score = _lab_value(h, "bone_density_z_score", "dexa_z_score", "z_score")
    has_measurement = bmd is not None or t_score is not None or z_score is not None
    has_resistance = w.resistance_sessions_14d > 0 or w.completed_sessions > 0
    active_days = _active_days_per_week(ctx)
    has_activity = a.avg_steps is not None or active_days is not None
    has_micros = (
        n.avg_calcium_mg is not None
        or n.avg_vitamin_d_mcg is not None
        or bool(n.vitamin_d_calcium_supplement_dates)
    )
    has_profile_context = u.age is not None or (u.sex or "").strip() != ""
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("DXA/BMD lab result", has_measurement),
        ("resistance training", has_resistance),
        ("weight-bearing activity proxy", has_activity),
        ("calcium or vitamin D logs", has_micros),
        ("age/sex context", has_profile_context),
    ):
        (present if ok else missing).append(label)
    if len(present) < 3 and not has_measurement:
        return _unknown_card(
            card_id="bone_density_support",
            title="Bone Density Context",
            category="healthspan",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Add a DXA/BMD result under Labs, or keep logging resistance training, steps, and calcium/vitamin D intake.",
        )

    score = 62.0 if not has_measurement else 68.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if t_score is not None:
        if t_score <= -2.5:
            score -= 30
            drivers.append("Saved bone-density T-score is very low for this wellness view.")
            recs.append("Use the saved DXA result as a cue to review training, nutrition, and follow-up timing with a clinician.")
        elif t_score <= -1.0:
            score -= 16
            drivers.append("Saved bone-density T-score is below this app's support target.")
            recs.append("Pair progressive resistance work with a clinician-reviewed DXA follow-up plan.")
        elif t_score >= 0:
            score += 8
            positives.append("Saved bone-density T-score is not showing a support gap in this view.")
        else:
            positives.append("Saved bone-density T-score is available and close to the app's support target.")
    if z_score is not None:
        if z_score <= -2.0:
            score -= 14
            drivers.append("Saved bone-density Z-score is low enough to make follow-up context important.")
            if not recs:
                recs.append("Bring the saved Z-score to a clinician if it has not already been reviewed.")
        elif z_score >= -1.0:
            score += 4
            positives.append("Saved bone-density Z-score is not showing a major support gap in this view.")
    if bmd is not None and t_score is None and z_score is None:
        value, unit = bmd
        positives.append(f"Saved BMD value is available ({value:g}{(' ' + unit) if unit else ''}), though site-specific reference context is not included.")

    if w.resistance_sessions_14d >= 4:
        score += 10
        positives.append("Resistance training frequency supports bone-loading behavior.")
    elif w.resistance_sessions_14d >= 2:
        score += 3
        positives.append("Some recent resistance training is present.")
        recs.append("Build toward two progressive resistance sessions per week as a repeatable baseline.")
    else:
        score -= 12
        drivers.append("Recent resistance training is sparse for a bone-support pattern.")
        recs.append("Schedule two progressive resistance sessions this week.")

    if a.avg_steps is not None:
        if a.avg_steps < 5000:
            score -= 8
            drivers.append("Average steps are low, so weight-bearing activity support is limited.")
            recs.append("Add a 20-minute walk or stair session on two low-training days.")
        elif a.avg_steps >= 8000:
            score += 6
            positives.append("Average steps support regular weight-bearing activity.")
    elif active_days is not None and active_days >= 4:
        score += 3
        positives.append("Active-day frequency supports regular loading.")

    if n.avg_calcium_mg is not None:
        if n.avg_calcium_mg < 700:
            score -= 6
            drivers.append("Tracked calcium is low for this support view.")
            recs.append("Anchor one calcium-rich food or reviewed supplement in a recurring meal.")
        elif n.avg_calcium_mg >= 1000:
            score += 4
            positives.append("Tracked calcium intake supports this pattern.")
    if n.avg_vitamin_d_mcg is not None:
        if n.avg_vitamin_d_mcg < 10:
            score -= 5
            drivers.append("Tracked vitamin D is low for this support view.")
        elif n.avg_vitamin_d_mcg >= 15:
            score += 3
            positives.append("Tracked vitamin D intake supports this pattern.")
    if n.vitamin_d_calcium_supplement_dates and not (n.avg_calcium_mg is not None or n.avg_vitamin_d_mcg is not None):
        positives.append("Recent calcium/vitamin D supplement logs add context.")

    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 3
            drivers.append("Short sleep can make progressive training harder to recover from.")
        elif s.avg_hours >= 7:
            positives.append("Sleep duration supports training recovery.")

    if not has_measurement:
        recs.insert(0, "If you have a recent DXA report, add the T-score or BMD value under Labs to anchor this pattern.")
    if not recs:
        recs.append("Keep repeating the basics: progressive resistance training, regular walking or stairs, calcium/vitamin D context, and enough recovery.")

    final = _clamp(score)
    coverage_values = [f.coverage.get("activity", 0.0)]
    if has_micros:
        coverage_values.append(f.coverage.get("nutrition", 0.0))
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(coverage_values) if coverage_values else None,
        corroborating_signals=sum(1 for item in drivers + positives if item),
    )
    if not has_measurement:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No saved DXA/BMD result is available, so this is behavior support rather than measured bone density.",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="bone_density_support",
        title="Bone Density Context",
        category="healthspan",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This combines saved DXA/BMD results when available with bone-supporting behaviors. It does not predict bone density or diagnose bone health.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            labs=has_measurement,
            workouts=has_resistance,
            activity=has_activity,
            nutrition=has_micros,
            sleep=s.avg_hours is not None,
            profile=has_profile_context,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_muscle_preservation_watch(ctx: InsightContext) -> InsightCard:
    n, s, w, h, u = ctx.nutrition, ctx.sleep, ctx.workouts, ctx.health, ctx.user
    f = _features(ctx)
    protein_lb = _protein_g_per_lb(n, u)
    ratio = _calorie_ratio(n)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("protein totals", n.avg_protein_g is not None),
        ("body weight for protein target", u.weight_lbs is not None),
        ("resistance training", w.resistance_sessions_14d > 0 or w.completed_sessions > 0),
        ("weight trend", h.weight_trend_lbs_per_week is not None),
        ("calorie alignment", ratio is not None),
        ("sleep duration", s.avg_hours is not None),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2:
        return _unknown_card(
            card_id="muscle_preservation_watch",
            title="Muscle Preservation Watch",
            category="body_composition",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log protein, body weight, and resistance sessions so this can watch muscle-preservation signals.",
        )

    score = 74.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if protein_lb is not None:
        if protein_lb < 0.6:
            score -= 18
            drivers.append("Protein per pound is below a generally supportive muscle-preservation range.")
            recs.append("Add a protein-dense item to one recurring meal first.")
        elif protein_lb < 0.8:
            score -= 8
            drivers.append("Protein per pound is modest for muscle retention.")
        else:
            score += 8
            positives.append("Protein per pound supports muscle retention.")
    if w.resistance_sessions_14d == 0 and w.completed_sessions > 0:
        score -= 16
        drivers.append("Recent workouts do not clearly include resistance training.")
        recs.append("Add two resistance sessions before adding more cardio volume.")
    elif w.resistance_sessions_14d < 2:
        score -= 12
        drivers.append("Resistance training frequency is low for preserving lean tissue.")
    elif w.resistance_sessions_14d >= 4:
        score += 8
        positives.append("Resistance training frequency supports lean-tissue maintenance.")
    if ratio is not None:
        if ratio < 0.75:
            score -= 14
            drivers.append("Tracked calories are far below target, increasing muscle-retention pressure.")
            recs.append("Close the biggest calorie gaps on hard training days first.")
        elif ratio < 0.85:
            score -= 8
            drivers.append("Tracked calories are below target while training demand is present.")
        elif ratio >= 0.95:
            positives.append("Calories are close to target on tracked days.")
    if n.avg_energy_availability is not None and n.avg_energy_availability < 30:
        score -= 8
        drivers.append("Energy availability is below a generally supportive range.")
    if h.weight_trend_lbs_per_week is not None and u.weight_lbs:
        weekly_loss_pct = -h.weight_trend_lbs_per_week / u.weight_lbs if h.weight_trend_lbs_per_week < 0 else 0
        if weekly_loss_pct >= 0.0125:
            score -= 12
            drivers.append("Weight is dropping quickly enough to make muscle preservation more fragile.")
            recs.append("Slow the loss pace or add a higher-calorie training day.")
        elif abs(h.weight_trend_lbs_per_week) <= 1.0:
            positives.append("Weight trend is not changing rapidly.")
    if s.avg_hours is not None and s.avg_hours < 6.5:
        score -= 6
        drivers.append("Short sleep makes strength and lean-tissue retention harder to support.")
    if n.post_workout_timing_sessions > 0:
        coverage = n.post_workout_protein_sessions / max(1, n.post_workout_timing_sessions)
        if coverage >= 0.7:
            positives.append("Post-workout protein shows up after most timestamped sessions.")
        elif coverage < 0.5:
            score -= 5
            drivers.append("Post-workout protein is inconsistent after timestamped sessions.")
    if ctx.user.glp1_support_enabled and (ctx.user.glp1_appetite or "").lower() in {"low", "very_low", "suppressed"}:
        score -= 5
        drivers.append("GLP-1 appetite context suggests protein and resistance consistency matter more right now.")
    if not recs:
        recs.append("Keep the muscle-preservation basics paired: protein target, resistance training, and a manageable loss pace.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["nutrition"], 0.2), max(f.coverage["workouts"], 0.2)),
        corroborating_signals=sum(1 for item in drivers if item),
    )
    if protein_lb is None and n.avg_protein_g is not None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "No body weight is recorded, so protein adequacy cannot be normalized per pound",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="muscle_preservation_watch",
        title="Muscle Preservation Watch",
        category="body_composition",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This watches whether protein, resistance training, calorie alignment, weight trend, and sleep support preserving lean tissue.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.avg_protein_g is not None or ratio is not None,
            workouts=w.completed_sessions > 0,
            body=u.weight_lbs is not None or h.weight_trend_lbs_per_week is not None,
            sleep=s.avg_hours is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_sleep_regularity_late_intake(ctx: InsightContext) -> InsightCard:
    n, s, w = ctx.nutrition, ctx.sleep, ctx.workouts
    f = _features(ctx)
    meals = f.meals
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("sleep duration", s.nights_with_data >= 3),
        ("bedtime consistency", s.bedtime_std_minutes is not None),
        ("late meal timing", bool(n.late_meal_dates) or n.days_with_data >= 3),
        ("late caffeine timing", meals.structured_late_caffeine_count > 0 or meals.inferred_late_caffeine_count > 0),
        ("evening alcohol", bool(n.alcohol_dates) or meals.evening_alcohol_count > 0),
        ("late workout timing", bool(w.late_workout_dates)),
    ):
        (present if ok else missing).append(label)
    if s.nights_with_data < 3 and len(present) < 2:
        return _unknown_card(
            card_id="sleep_regularity_late_intake",
            title="Sleep Regularity & Late Intake",
            category="sleep",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Capture sleep plus meal or caffeine timing for several nights to unlock this pattern.",
        )

    score = 78.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if s.avg_hours is not None:
        if s.avg_hours < 6.5:
            score -= 16
            drivers.append(f"Average sleep is {s.avg_hours:.1f}h.")
            recs.append("Protect the sleep window first, then test late-intake changes one at a time.")
        elif s.avg_hours >= 7.2:
            score += 5
            positives.append("Sleep duration is supportive.")
    if s.bedtime_std_minutes is not None:
        if s.bedtime_std_minutes > 90:
            score -= 16
            drivers.append("Bedtime timing varies widely.")
            recs.append("Anchor wake time and keep bedtime in a tighter window for one week.")
        elif s.bedtime_std_minutes > 60:
            score -= 8
            drivers.append("Bedtime timing is somewhat variable.")
        elif s.bedtime_std_minutes <= 45:
            score += 6
            positives.append("Bedtime timing is consistent.")
    late_meal_count = meals.late_meal_count
    late_food_count = meals.late_large_meal_count + meals.late_high_fat_count + meals.late_added_sugar_count
    if late_meal_count >= 4:
        score -= 9
        drivers.append(f"Late meals appeared on {late_meal_count} recent days.")
    if late_food_count >= 3:
        score -= 10
        drivers.append("Late large, high-fat, or added-sugar meals appear repeatedly.")
        recs.append("Try a lighter or earlier dinner for seven nights and compare sleep.")
    if meals.structured_late_caffeine_count >= 2:
        score -= 14
        drivers.append(f"Structured caffeine timing shows {n.late_caffeine_mg:.0f}mg after the early-afternoon cutoff.")
        recs.append("Move caffeine earlier for one week and compare sleep score or duration.")
    elif meals.inferred_late_caffeine_count >= 2:
        score -= 8
        drivers.append("Late caffeine is inferred from food tags; exact dose would sharpen this read.")
    if meals.evening_alcohol_count >= 2 or len(n.alcohol_dates) >= 2:
        score -= 10
        drivers.append("Evening alcohol appears repeatedly in the sleep window.")
    if len(w.late_workout_dates) >= 2:
        score -= 8
        drivers.append("Late workouts appear repeatedly before the sleep window.")
    low_sleep_late_meal_pairs = _late_pattern_count(s.low_sleep_dates, n.late_meal_dates)
    low_sleep_late_workout_pairs = _late_pattern_count(s.low_sleep_dates, w.late_workout_dates)
    low_sleep_alcohol_pairs = _late_pattern_count(s.low_sleep_dates, n.alcohol_dates)
    if low_sleep_late_meal_pairs + low_sleep_late_workout_pairs + low_sleep_alcohol_pairs >= 2:
        score -= 8
        drivers.append("Lower-sleep nights repeatedly follow late meals, late workouts, or alcohol.")
    if not drivers:
        positives.append("No repeated late-intake or sleep-regularity support gap is clear yet.")
    if not recs:
        recs.append("Keep logging sleep plus caffeine, dinner timing, alcohol, and late workouts so the pattern can get more personal.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=min(max(f.coverage["sleep"], 0.2), max(f.coverage["nutrition"], 0.2)),
        corroborating_signals=sum(1 for value in (late_meal_count, late_food_count, meals.structured_late_caffeine_count, meals.evening_alcohol_count, len(w.late_workout_dates)) if value >= 2),
    )
    if meals.inferred_late_caffeine_count and not meals.structured_late_caffeine_count:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Caffeine timing is inferred from food tags rather than structured caffeine dose",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="sleep_regularity_late_intake",
        title="Sleep Regularity & Late Intake",
        category="sleep",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This separates sleep regularity from possible late-intake disruptors like caffeine, late meals, alcohol, and late workouts.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            sleep=s.nights_with_data > 0,
            nutrition=n.days_with_data > 0,
            caffeine=meals.structured_late_caffeine_count > 0,
            workouts=bool(w.late_workout_dates),
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_recovery_modality_response(ctx: InsightContext) -> InsightCard:
    r, h, s = ctx.recovery_modalities, ctx.health, ctx.sleep
    f = _features(ctx)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("recovery modality logs", r.activity_count > 0),
        ("next-day HRV", bool(h.hrv_by_date)),
        ("next-day resting heart rate", bool(h.rhr_by_date)),
        ("next-day sleep score", bool(s.score_by_date)),
    ):
        (present if ok else missing).append(label)
    if r.activity_count == 0:
        return _unknown_card(
            card_id="recovery_modality_response",
            title="Recovery Modality Response",
            category="recovery",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log sauna, breathwork, stretching, cold plunge, or other recovery sessions to compare next-day response.",
        )

    modality_results: list[dict[str, Any]] = []
    for modality, dates in r.modality_dates.items():
        hrv_count, hrv_delta = _next_day_delta(h.hrv_by_date, dates, percent=True)
        rhr_count, rhr_delta = _next_day_delta(h.rhr_by_date, dates)
        sleep_count, sleep_delta = _next_day_delta(s.score_by_date, dates)
        signal_points = 0
        if hrv_delta is not None:
            signal_points += 1 if hrv_delta >= 5 else -1 if hrv_delta <= -5 else 0
        if rhr_delta is not None:
            signal_points += 1 if rhr_delta <= -2 else -1 if rhr_delta >= 3 else 0
        if sleep_delta is not None:
            signal_points += 1 if sleep_delta >= 5 else -1 if sleep_delta <= -5 else 0
        signal_count = sum(delta is not None for delta in (hrv_delta, rhr_delta, sleep_delta))
        observation_count = max(hrv_count, rhr_count, sleep_count)
        if signal_count == 0:
            continue
        modality_results.append({
            "modality": modality,
            "dates": len(dates),
            "minutes": r.modality_minutes.get(modality, 0),
            "signal_points": signal_points,
            "signal_count": signal_count,
            "observation_count": observation_count,
            "hrv_delta": hrv_delta,
            "rhr_delta": rhr_delta,
            "sleep_delta": sleep_delta,
        })
    if not modality_results:
        return _unknown_card(
            card_id="recovery_modality_response",
            title="Recovery Modality Response",
            category="recovery",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=[*missing, "at least two next-day observations after a modality"],
            recommendation="Keep logging recovery sessions and next-day HRV/RHR or sleep score so the app can run a simple N-of-1 comparison.",
        )

    modality_results.sort(key=lambda item: (item["signal_points"], item["observation_count"]), reverse=True)
    best = modality_results[0]
    worst = min(modality_results, key=lambda item: (item["signal_points"], -item["observation_count"]))
    score = 68.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if best["signal_points"] > 0:
        score += min(16, best["signal_points"] * 6 + best["observation_count"])
        label = _modality_label(best["modality"])
        positives.append(f"{label} has the most supportive next-day pattern so far.")
    if worst["signal_points"] < 0:
        score -= min(18, abs(worst["signal_points"]) * 7 + worst["observation_count"])
        label = _modality_label(worst["modality"])
        drivers.append(f"{label} has the least supportive next-day pattern so far.")
        recs.append(f"Run a cleaner one-week test before assuming {label.lower()} helps recovery.")
    for item in modality_results[:3]:
        label = _modality_label(item["modality"])
        details: list[str] = []
        if item["hrv_delta"] is not None:
            details.append(f"HRV {item['hrv_delta']:+.0f}%")
        if item["rhr_delta"] is not None:
            details.append(f"RHR {item['rhr_delta']:+.0f} bpm")
        if item["sleep_delta"] is not None:
            details.append(f"sleep score {item['sleep_delta']:+.0f}")
        if details:
            target = positives if item["signal_points"] >= 0 else drivers
            target.append(f"{label} next-day response: {', '.join(details)}.")
    if not recs:
        recs.append("Keep the next test boring: same modality, similar time of day, and compare next-morning HRV/RHR or sleep score.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(f.coverage["recovery_modalities"], f.coverage["apple_health"], f.coverage["sleep"]),
        corroborating_signals=sum(1 for item in modality_results if item["signal_count"] >= 2),
        penalties=["N-of-1 correlations are hypothesis-generating, not proof"],
    )
    if len(modality_results) < 2:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Only one recovery modality has enough next-day signal to compare",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="recovery_modality_response",
        title="Recovery Modality Response",
        category="recovery",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This compares logged recovery modalities against next-day HRV, resting heart rate, and sleep score as a personal experiment.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            recovery_modalities=r.activity_count > 0,
            apple_health=bool(h.hrv_by_date) or bool(h.rhr_by_date),
            sleep=bool(s.score_by_date),
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
        debug={"modality_results": modality_results[:5]},
    )


def compute_protein_distribution_quality(ctx: InsightContext) -> InsightCard:
    n, u = ctx.nutrition, ctx.user
    f = _features(ctx)
    meals = f.meals
    protein_lb = _protein_g_per_lb(n, u)
    max_meal_pct = _max_meal_protein_percent(n)
    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("protein totals", n.avg_protein_g is not None),
        ("body weight for protein target", u.weight_lbs is not None),
        ("largest-meal protein share", max_meal_pct is not None),
        ("post-workout protein timing", n.post_workout_timing_sessions > 0),
        ("meal protein balance", meals.high_carb_low_protein_meals > 0 or n.days_with_data >= 3),
    ):
        (present if ok else missing).append(label)
    if len(present) < 2 or n.avg_protein_g is None:
        return _unknown_card(
            card_id="protein_distribution_quality",
            title="Protein Distribution Quality",
            category="diet_quality",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals with protein detail for several days so this can assess protein timing and distribution.",
        )

    score = 72.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []
    if protein_lb is not None:
        if protein_lb < 0.6:
            score -= 16
            drivers.append("Daily protein is low before distribution even matters.")
            recs.append("Raise total protein first, then fine-tune timing.")
        elif protein_lb < 0.8:
            score -= 7
            drivers.append("Daily protein is modest, so distribution has less room to work.")
        else:
            score += 6
            positives.append("Total daily protein supports the distribution score.")
    if max_meal_pct is not None:
        if max_meal_pct >= 70:
            score -= 14
            drivers.append(f"Protein is heavily concentrated in one meal on tracked days ({max_meal_pct:.0f}% at the largest meal).")
            recs.append("Move some protein into breakfast, lunch, or an earlier snack instead of relying on one large serving.")
        elif max_meal_pct >= 55:
            score -= 8
            drivers.append(f"The largest meal carries about {max_meal_pct:.0f}% of daily protein.")
        elif 30 <= max_meal_pct <= 50:
            score += 6
            positives.append("Protein is not overly concentrated in a single meal.")
    if meals.high_carb_low_protein_meals >= 4:
        score -= 10
        drivers.append(f"High-carb, low-protein meals appeared {meals.high_carb_low_protein_meals} times.")
        recs.append("Add 20-30g protein to one recurring high-carb meal.")
    elif meals.high_carb_low_protein_meals >= 2:
        score -= 5
        drivers.append("A few meals are high-carb but light on protein.")
    if n.post_workout_timing_sessions > 0:
        coverage = n.post_workout_protein_sessions / max(1, n.post_workout_timing_sessions)
        if coverage >= 0.75:
            score += 5
            positives.append("Post-workout protein appears after most timestamped training sessions.")
        elif coverage < 0.5:
            score -= 8
            drivers.append("Post-workout protein is inconsistent after timestamped sessions.")
            recs.append("Pair training with a simple protein anchor within the next meal.")
    if meals.protein_source_diversity_score is not None and meals.protein_source_diversity_score >= 0.7:
        positives.append("Protein sources rotate across multiple foods.")
    if not recs:
        recs.append("Aim for repeatable protein anchors across the day instead of one heroic protein meal.")
    final = _clamp(score)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=max(f.coverage["nutrition"], 0.2),
        corroborating_signals=sum(1 for item in drivers if item),
    )
    if max_meal_pct is None:
        confidence, reasons = _cap_confidence(
            confidence,
            reasons,
            "medium",
            "Largest-meal protein share is missing, so distribution is inferred from meal patterns",
        )
    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="protein_distribution_quality",
        title="Protein Distribution Quality",
        category="diet_quality",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This checks whether protein is adequate and spread across meals, especially around training, instead of concentrated in one eating window.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.avg_protein_g is not None,
            body=u.weight_lbs is not None,
            workouts=n.post_workout_timing_sessions > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def collect_recent_nutrition(db: Session, user_id: int, days: int = 14) -> NutritionSummary:
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    lookback_cutoff = today - timedelta(days=max(28, days * 2) - 1)
    current_dates = set(_date_range(cutoff, today))
    from app.services.nutrition.ai_classify import insight_tags_from_metadata
    from app.services.nutrition.food_classifier import PLANT_CATEGORY, normalize_name
    from app.services.nutrition.meal_history import dedupe_meals_for_aggregation, get_rolling_averages
    from app.services.nutrition.targets import resolve_targets_for_user

    rolling = get_rolling_averages(user_id, window=days, db=db, end_date=today)
    metrics = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(col(DailyNutritionMetrics.metric_date) >= lookback_cutoff)
        .where(col(DailyNutritionMetrics.metric_date) <= today)
    ).all()
    metric_days = [m for m in metrics if float(m.calories_total or 0) > 0 or int(m.item_count or 0) > 0]
    metric_days_current = [m for m in metric_days if m.metric_date in current_dates]
    metric_denom = max(1, len(metric_days))
    current_metric_denom = max(1, len(metric_days_current))
    avg_fiber = _sum([m.fiber_total_g for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    avg_fiber_density = _sum([m.fiber_per_1000_kcal for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    avg_added_sugar = _sum([m.added_sugar_g for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    avg_saturated_fat = _sum([m.saturated_fat_g for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    avg_sodium = _sum([m.sodium_mg for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    micronutrient_days = [
        m for m in metric_days_current
        if int(getattr(m, "micronutrient_item_count", 0) or 0) > 0
    ]
    micronutrient_denom = max(1, len(micronutrient_days))
    def _avg_micro(field_name: str) -> float | None:
        if not micronutrient_days:
            return None
        return _sum([getattr(m, field_name, 0) for m in micronutrient_days]) / micronutrient_denom
    avg_caffeine = _avg_micro("caffeine_mg")
    avg_potassium = _avg_micro("potassium_mg")
    avg_calcium = _avg_micro("calcium_mg")
    avg_magnesium = _avg_micro("magnesium_mg")
    avg_iron = _avg_micro("iron_mg")
    avg_vitamin_d = _avg_micro("vitamin_d_mcg")
    avg_vitamin_b12 = _avg_micro("vitamin_b12_mcg")
    avg_folate = _avg_micro("folate_mcg")
    avg_zinc = _avg_micro("zinc_mg")
    avg_omega_3_g = _avg_micro("omega_3_g")
    avg_alcohol = _sum([m.alcohol_servings for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    avg_animal = _sum([m.animal_protein_g for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    avg_plant = _sum([m.plant_protein_g for m in metric_days_current]) / current_metric_denom if metric_days_current else None
    processed_meat_servings = 0.0
    refined_grain_servings = _sum([m.refined_grain_servings for m in metric_days_current])
    omega3_servings = _sum([m.omega3_servings for m in metric_days_current])
    seafood_servings = _sum([m.seafood_servings for m in metric_days_current])
    plant_slugs: set[str] = set()
    processing_counts: dict[str, int] = {}
    item_count = 0
    classified_item_count = 0
    daily_values: dict[str, dict[date, float]] = defaultdict(dict)
    pattern_dates: dict[str, set[date]] = defaultdict(set)
    metric_dates: set[date] = set()
    metric_processed_servings_by_date: dict[date, float] = {}
    metric_red_meat_counts_by_date: dict[date, float] = {}
    insight_enriched_item_count = 0
    for m in metric_days:
        metric_date = m.metric_date
        metric_dates.add(metric_date)
        daily_values["calories"][metric_date] = float(m.calories_total or 0)
        daily_values["fiber_g"][metric_date] = float(m.fiber_total_g or 0)
        daily_values["fiber_per_1000_kcal"][metric_date] = float(m.fiber_per_1000_kcal or 0)
        daily_values["added_sugar_g"][metric_date] = float(m.added_sugar_g or 0)
        daily_values["saturated_fat_g"][metric_date] = float(m.saturated_fat_g or 0)
        daily_values["sodium_mg"][metric_date] = float(m.sodium_mg or 0)
        for micro_key in (
            "caffeine_mg",
            "potassium_mg",
            "calcium_mg",
            "magnesium_mg",
            "iron_mg",
            "vitamin_d_mcg",
            "vitamin_b12_mcg",
            "folate_mcg",
            "zinc_mg",
            "omega_3_g",
        ):
            value = float(getattr(m, micro_key, 0) or 0)
            if value > 0:
                daily_values[micro_key][metric_date] = value
        daily_values["alcohol_servings"][metric_date] = float(m.alcohol_servings or 0)
        daily_values["animal_protein_g"][metric_date] = float(m.animal_protein_g or 0)
        daily_values["plant_protein_g"][metric_date] = float(m.plant_protein_g or 0)
        daily_values["energy_availability"][metric_date] = float(m.energy_availability or 0)
        daily_values["refined_grain_meals"][metric_date] = float(m.refined_grain_servings or 0)
        if float(m.processed_meat_servings or 0) > 0:
            pattern_dates["processed_meat"].add(metric_date)
            metric_processed_servings_by_date[metric_date] = float(m.processed_meat_servings or 0)
        if float(m.refined_grain_servings or 0) > 0:
            pattern_dates["refined_grain"].add(metric_date)
        if float(m.seafood_servings or 0) > 0 or float(m.omega3_servings or 0) > 0:
            pattern_dates["seafood"].add(metric_date)
        if float(m.fermented_servings or 0) > 0:
            pattern_dates["fermented"].add(metric_date)
        if float(m.added_sugar_g or 0) >= 50:
            pattern_dates["high_added_sugar"].add(metric_date)
        calories = float(m.calories_total or 0)
        if calories > 0 and float(m.saturated_fat_g or 0) * 9.0 / calories >= 0.10:
            pattern_dates["high_saturated_fat"].add(metric_date)
        if float(m.sodium_mg or 0) >= 3500:
            pattern_dates["high_sodium"].add(metric_date)
        if float(m.plant_protein_g or 0) >= 20:
            pattern_dates["plant_protein"].add(metric_date)
        if float(m.fruit_servings or 0) > 0 or float(m.vegetable_servings or 0) > 0:
            pattern_dates["potassium_proxy"].add(metric_date)
        for raw_tag, raw_count in (getattr(m, "insight_tag_counts", None) or {}).items():
            tag = INSIGHT_TAG_ALIASES.get(str(raw_tag or "").strip().lower(), str(raw_tag or "").strip().lower())
            try:
                count = float(raw_count or 0)
            except (TypeError, ValueError):
                count = 0.0
            if not tag or count <= 0:
                continue
            pattern_dates[tag].add(metric_date)
            daily_values[tag][metric_date] = daily_values[tag].get(metric_date, 0) + count
            if tag == "red_meat":
                metric_red_meat_counts_by_date[metric_date] = metric_red_meat_counts_by_date.get(metric_date, 0) + count
        for slug in (m.plant_slugs or []):
            category = PLANT_CATEGORY.get(str(slug))
            if category == "legume":
                pattern_dates["legume"].add(metric_date)
                pattern_dates["plant_protein"].add(metric_date)
                pattern_dates["potassium_proxy"].add(metric_date)
            elif category == "whole_grain":
                pattern_dates["whole_grain"].add(metric_date)
            elif category in {"nut", "seed"}:
                pattern_dates["nut_seed"].add(metric_date)
                pattern_dates["unsaturated_fat"].add(metric_date)
            if str(slug) in {"orange", "lemon", "lime"}:
                pattern_dates["citrus"].add(metric_date)
        if m not in metric_days_current:
            continue
        item_count += int(m.item_count or 0)
        classified_item_count += int(m.classified_item_count or 0)
        for slug in (m.plant_slugs or []):
            plant_slugs.add(str(slug))
        for bucket, count in (m.processing_counts or {}).items():
            processing_counts[str(bucket)] = processing_counts.get(str(bucket), 0) + int(count or 0)
    processing_total = sum(processing_counts.values())
    ultra_processed_pct = (100.0 * processing_counts.get("ultra_processed", 0) / processing_total) if processing_total else None
    ea_values = [float(m.energy_availability or 0) for m in metric_days_current if float(m.energy_availability or 0) > 0]
    avg_ea = mean(ea_values) if ea_values else None
    max_meal_protein_pct_values = [
        float(m.max_meal_protein_pct or 0)
        for m in metric_days_current
        if float(m.max_meal_protein_pct or 0) > 0
    ]
    avg_max_meal_protein_pct = mean(max_meal_protein_pct_values) if max_meal_protein_pct_values else None
    fiber_values = [float(m.fiber_total_g or 0) for m in metric_days_current]
    fiber_avg_for_spike = mean(fiber_values) if fiber_values else None
    fiber_spike_dates = {
        m.metric_date for m in metric_days_current
        if fiber_avg_for_spike is not None
        and float(m.fiber_total_g or 0) >= max(35.0, fiber_avg_for_spike * 1.7)
    }
    alcohol_dates = {m.metric_date for m in metric_days_current if float(m.alcohol_servings or 0) > 0}

    states = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == user_id)
        .where(col(UserDayState.day_key) >= lookback_cutoff)
        .where(col(UserDayState.day_key) <= today)
    ).all()
    water_values: list[float] = []
    for state in states:
        plan = state.nutrition_plan or {}
        try:
            water = float(plan.get("_hydration_oz", 0) or 0)
        except (TypeError, ValueError):
            water = 0.0
        if water > 0:
            daily_values["water_oz"][state.day_key] = water
            if state.day_key in current_dates:
                water_values.append(water)
    avg_water = mean(water_values) if water_values else None

    target = resolve_targets_for_user(db, user_id, as_of=today, include_health=True)
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    hydration_target = None
    if profile and profile.weight_lbs:
        hydration_target = max(64.0, min(140.0, float(profile.weight_lbs) * 0.5))

    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(col(Meal.meal_date) >= lookback_cutoff)
        .where(col(Meal.meal_date) <= today)
    ).all()
    meal_ids = [int(m.id) for m in meals if m.id is not None]
    items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list[MealItem]] = defaultdict(list)
    for item in items:
        items_by_meal[int(item.meal_id)].append(item)
    normalized_item_names = {
        normalize_name(str(item.food_name or ""))
        for item in items
        if str(item.food_name or "").strip()
    }
    metadata_rows = (
        db.exec(
            select(FoodMetadata)
            .where(FoodMetadata.classifier_version >= 1)
            .where(FoodMetadata.normalized_name.in_(list(normalized_item_names)))
        ).all()
        if normalized_item_names else []
    )
    metadata_by_name: dict[str, FoodMetadata] = {}
    for row in metadata_rows:
        existing = metadata_by_name.get(row.normalized_name)
        if existing is None or int(row.classifier_version or 0) > int(existing.classifier_version or 0):
            metadata_by_name[row.normalized_name] = row
    meals = dedupe_meals_for_aggregation(meals, items_by_meal)
    kept_ids = {int(m.id) for m in meals if m.id is not None}
    late_meal_dates: set[date] = set()
    digestion_dates: dict[str, set[date]] = defaultdict(set)
    red_meat_servings = 0.0
    item_red_meat_dates: set[date] = set()
    item_processed_meat_dates: set[date] = set()
    late_caffeine_mg = 0.0
    late_caffeine_structured_count = 0
    for meal in meals:
        meal_date = meal.meal_date
        consumed = meal.consumed_at
        meal_is_late = bool(consumed and consumed.time() >= time(20, 30))
        meal_type = (_enum_text(meal.meal_type) or "").lower()
        if meal_is_late:
            pattern_dates["late_meal"].add(meal_date)
            if meal_date in current_dates:
                late_meal_dates.add(meal_date)
        meal_items = items_by_meal.get(int(meal.id or 0), [])
        meal_cals = sum(float(i.calories or 0) for i in meal_items)
        meal_fat = sum(float(i.fat_g or 0) for i in meal_items)
        meal_carbs = sum(float(i.carbs_g or 0) for i in meal_items)
        meal_protein = sum(float(i.protein_g or 0) for i in meal_items)
        daily_values["protein_g"][meal_date] = daily_values["protein_g"].get(meal_date, 0) + meal_protein
        daily_values["carbs_g"][meal_date] = daily_values["carbs_g"].get(meal_date, 0) + meal_carbs
        daily_values["fat_g"][meal_date] = daily_values["fat_g"].get(meal_date, 0) + meal_fat
        if meal_date not in metric_dates:
            daily_values["calories"][meal_date] = daily_values["calories"].get(meal_date, 0) + meal_cals
        if meal_cals >= 750 and meal_fat * 9 >= meal_cals * 0.45:
            pattern_dates["high_fat_large_meal"].add(meal_date)
            daily_values["high_fat_large_meal"][meal_date] = daily_values["high_fat_large_meal"].get(meal_date, 0) + 1
            if meal_date in current_dates:
                digestion_dates["high_fat"].add(meal_date)
            if meal_is_late:
                daily_values["late_high_fat"][meal_date] = daily_values["late_high_fat"].get(meal_date, 0) + 1
                pattern_dates["late_high_fat"].add(meal_date)
        if meal_is_late and meal_cals >= 700:
            daily_values["late_large_meal"][meal_date] = daily_values["late_large_meal"].get(meal_date, 0) + 1
            pattern_dates["late_large_meal"].add(meal_date)
        if meal_carbs >= 60 and meal_protein < 20:
            daily_values["high_carb_low_protein_meal"][meal_date] = daily_values["high_carb_low_protein_meal"].get(meal_date, 0) + 1
            pattern_dates["high_carb_low_protein_meal"].add(meal_date)
        for item in meal_items:
            if int(item.meal_id) not in kept_ids:
                continue
            meta = metadata_by_name.get(normalize_name(str(item.food_name or "")))
            if meal_date in current_dates and meta is not None and getattr(meta, "insight_tags", None) is not None:
                insight_enriched_item_count += 1
            tags = insight_tags_from_metadata(meta) if meta is not None else set()
            tags = {INSIGHT_TAG_ALIASES.get(tag, tag) for tag in tags}
            for tag in tags:
                pattern_dates[tag].add(meal_date)
                daily_values[tag][meal_date] = daily_values[tag].get(meal_date, 0) + 1
            if "red_meat" in tags:
                servings = _estimated_servings_from_item(item, reference_grams=RED_MEAT_SERVING_G)
                daily_values["red_meat_servings"][meal_date] = daily_values["red_meat_servings"].get(meal_date, 0) + servings
                pattern_dates["red_meat"].add(meal_date)
                item_red_meat_dates.add(meal_date)
                if meal_type == "dinner":
                    pattern_dates["dinner_red_meat"].add(meal_date)
                if meal_date in current_dates:
                    red_meat_servings += servings
            if "processed_meat" in tags:
                pattern_dates["processed_meat"].add(meal_date)
                if meal_type == "breakfast":
                    pattern_dates["breakfast_processed_meat"].add(meal_date)
                servings = _estimated_servings_from_item(item, reference_grams=PROCESSED_MEAT_RISK_UNIT_G)
                daily_values["processed_meat_servings"][meal_date] = daily_values["processed_meat_servings"].get(meal_date, 0) + servings
                item_processed_meat_dates.add(meal_date)
                if meal_date in current_dates:
                    processed_meat_servings += servings
            if "legume" in tags:
                pattern_dates["plant_protein"].add(meal_date)
                pattern_dates["potassium_proxy"].add(meal_date)
            if "nut_seed" in tags:
                pattern_dates["unsaturated_fat"].add(meal_date)
            if "refined_grain" in tags:
                daily_values["refined_grain_meals"][meal_date] = daily_values["refined_grain_meals"].get(meal_date, 0) + 1
            if "sugar_sweetened_beverage" in tags:
                daily_values["sugar_sweetened_beverage"][meal_date] = daily_values["sugar_sweetened_beverage"].get(meal_date, 0) + 1
            if "high_oxalate" in tags:
                daily_values["high_oxalate"][meal_date] = daily_values["high_oxalate"].get(meal_date, 0) + 1
            if "citrus" in tags or "citrus_or_citrate" in tags:
                daily_values["citrus"][meal_date] = daily_values["citrus"].get(meal_date, 0) + 1
            if "dairy_calcium" in tags or "calcium_source" in tags:
                pattern_dates["dairy_calcium"].add(meal_date)
                if meal_date in current_dates:
                    digestion_dates["dairy"].add(meal_date)
            if "protein_powder" in tags:
                daily_values["protein_powder"][meal_date] = daily_values["protein_powder"].get(meal_date, 0) + 1
                if meal_date in current_dates:
                    digestion_dates["protein_powder"].add(meal_date)
            if "artificial_sweetener" in tags:
                daily_values["artificial_sweetener"][meal_date] = daily_values["artificial_sweetener"].get(meal_date, 0) + 1
                if meal_date in current_dates:
                    digestion_dates["artificial_sweetener"].add(meal_date)
            if "high_fodmap" in tags or "fodmap_hint" in tags:
                daily_values["fodmap_hint"][meal_date] = daily_values["fodmap_hint"].get(meal_date, 0) + 1
                if meal_date in current_dates:
                    digestion_dates["fodmap_hint"].add(meal_date)
            if meal_is_late and ("sugar_sweetened_beverage" in tags or float(item.added_sugar_g or 0) >= 10):
                daily_values["late_added_sugar"][meal_date] = daily_values["late_added_sugar"].get(meal_date, 0) + 1
                pattern_dates["late_added_sugar"].add(meal_date)
            if "potassium_source" in tags:
                pattern_dates["potassium_proxy"].add(meal_date)
            if meal_is_late and ("caffeine" in tags or "caffeine_source" in tags):
                daily_values["late_caffeine"][meal_date] = daily_values["late_caffeine"].get(meal_date, 0) + 1
                pattern_dates["late_caffeine"].add(meal_date)
            item_caffeine = float(getattr(item, "caffeine_mg", 0) or 0)
            if item_caffeine > 0 and consumed and _is_late_caffeine_time(consumed):
                late_caffeine_mg += item_caffeine
                late_caffeine_structured_count += 1
                daily_values["late_caffeine_structured"][meal_date] = daily_values["late_caffeine_structured"].get(meal_date, 0) + 1
                daily_values["late_caffeine_mg"][meal_date] = daily_values["late_caffeine_mg"].get(meal_date, 0) + item_caffeine
                pattern_dates["late_caffeine_structured"].add(meal_date)
            if meal_is_late and "alcohol" in tags:
                daily_values["evening_alcohol"][meal_date] = daily_values["evening_alcohol"].get(meal_date, 0) + 1
                pattern_dates["evening_alcohol"].add(meal_date)

    for metric_date, count in metric_red_meat_counts_by_date.items():
        if metric_date in item_red_meat_dates:
            continue
        daily_values["red_meat_servings"][metric_date] = daily_values["red_meat_servings"].get(metric_date, 0) + count
        if metric_date in current_dates:
            red_meat_servings += count

    for metric_date, servings in metric_processed_servings_by_date.items():
        if metric_date in item_processed_meat_dates:
            continue
        daily_values["processed_meat_servings"][metric_date] = daily_values["processed_meat_servings"].get(metric_date, 0) + servings
        if metric_date in current_dates:
            processed_meat_servings += servings

    checkins = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id)
        .where(col(WeeklyCheckIn.checkin_date) >= lookback_cutoff)
        .where(col(WeeklyCheckIn.checkin_date) <= today)
    ).all()
    symptom_tokens = ("bloat", "gas", "stomach", "digestion", "digestive", "cramp", "nausea", "constipat", "diarrhea")
    symptom_dates = {
        c.checkin_date for c in checkins
        if c.checkin_date in current_dates
        if any(token in str(c.notes or "").lower() for token in symptom_tokens)
    }
    stress_tokens = ("stress", "overwhelmed", "anxious", "deadline", "burned out", "burnout")
    for c in checkins:
        if c.checkin_date in current_dates and any(token in str(c.notes or "").lower() for token in stress_tokens):
            daily_values["stress_note"][c.checkin_date] = daily_values["stress_note"].get(c.checkin_date, 0) + 1
    if symptom_dates:
        digestion_dates["_symptom_dates"] = symptom_dates

    supplement_logs = db.exec(
        select(SupplementLog)
        .where(SupplementLog.user_id == user_id)
        .where(SupplementLog.taken_at >= datetime.combine(lookback_cutoff, time.min, tzinfo=timezone.utc))
        .where(SupplementLog.taken_at <= datetime.combine(today, time.max, tzinfo=timezone.utc))
        .where(SupplementLog.skipped == False)  # noqa: E712
    ).all()
    stack_ids = [log.stack_item_id for log in supplement_logs if getattr(log, "stack_item_id", None)]
    stacks = db.exec(select(UserSupplementStack).where(UserSupplementStack.id.in_(stack_ids))).all() if stack_ids else []
    stack_by_id = {s.id: s for s in stacks}
    ingredient_ids = [s.supplement_ingredient_id for s in stacks if s.supplement_ingredient_id]
    ingredients = db.exec(select(SupplementIngredient).where(SupplementIngredient.id.in_(ingredient_ids))).all() if ingredient_ids else []
    ingredient_by_id = {i.id: i for i in ingredients}
    creatine_dates: set[date] = set()
    electrolyte_dates: set[date] = set()
    magnesium_evening_dates: set[date] = set()
    high_vitamin_c_dates: set[date] = set()
    vitamin_d_calcium_supplement_dates: set[date] = set()
    for log in supplement_logs:
        taken = _as_aware_datetime(getattr(log, "taken_at", None))
        if not taken:
            continue
        taken_date = taken.date()
        stack = stack_by_id.get(log.stack_item_id)
        ingredient = ingredient_by_id.get(stack.supplement_ingredient_id) if stack and stack.supplement_ingredient_id else None
        haystack = _supplement_name_parts(log, stack, ingredient)
        timing = str(getattr(log, "timing_context", None) or getattr(stack, "timing", None) or "").lower()
        dose = float(getattr(log, "dose_amount", 0) or getattr(stack, "dose_amount", 0) or 0)
        unit = str(getattr(log, "dose_unit", None) or getattr(stack, "dose_unit", None) or "").lower()
        if "creatine" in haystack:
            creatine_dates.add(taken_date)
        if any(token in haystack for token in ("electrolyte", "sodium", "potassium", "hydration salt")):
            electrolyte_dates.add(taken_date)
        if "magnesium" in haystack and (timing in {"evening", "bedtime"} or taken.time() >= time(18, 0)):
            magnesium_evening_dates.add(taken_date)
        if ("vitamin c" in haystack or "ascorbic" in haystack) and unit in {"mg", "milligram", "milligrams"} and dose >= 1000:
            high_vitamin_c_dates.add(taken_date)
        if any(token in haystack for token in ("vitamin d", "d3", "calcium")):
            vitamin_d_calcium_supplement_dates.add(taken_date)
        if "caffeine" in haystack and unit in {"mg", "milligram", "milligrams"} and dose > 0:
            daily_values["caffeine_mg"][taken_date] = daily_values["caffeine_mg"].get(taken_date, 0) + dose
            if _is_late_caffeine_time(taken):
                late_caffeine_mg += dose
                late_caffeine_structured_count += 1
                daily_values["late_caffeine_structured"][taken_date] = daily_values["late_caffeine_structured"].get(taken_date, 0) + 1
                daily_values["late_caffeine_mg"][taken_date] = daily_values["late_caffeine_mg"].get(taken_date, 0) + dose
                pattern_dates["late_caffeine_structured"].add(taken_date)

    caffeine_values = [
        float(v) for d, v in daily_values.get("caffeine_mg", {}).items()
        if d in current_dates and float(v or 0) > 0
    ]
    if caffeine_values:
        avg_caffeine = mean(caffeine_values)

    workout_rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(col(WorkoutCompletion.workout_date) >= lookback_cutoff)
        .where(col(WorkoutCompletion.workout_date) <= today)
    ).all()
    meal_timeline = [
        (_as_aware_datetime(meal.consumed_at), meal, items_by_meal.get(int(meal.id or 0), []))
        for meal in meals
        if meal.consumed_at is not None
    ]
    meal_timeline.sort(key=lambda row: row[0])
    delays: list[float] = []
    protein_sessions = 0
    carb_sessions = 0
    missed_post_workout = 0
    timing_sessions = 0
    for workout in workout_rows:
        ended = _as_aware_datetime(workout.ended_at or workout.completed_at)
        if ended is None:
            continue
        after = [
            (consumed, meal, meal_items)
            for consumed, meal, meal_items in meal_timeline
            if consumed >= ended and consumed <= ended + timedelta(hours=8)
        ]
        if not after:
            continue
        consumed, _meal, meal_items = after[0]
        delay = (consumed - ended).total_seconds() / 60.0
        timing_sessions += 1
        delays.append(delay)
        protein_g = sum(float(i.protein_g or 0) for i in meal_items)
        carbs_g = sum(float(i.carbs_g or 0) for i in meal_items)
        if protein_g >= 20:
            protein_sessions += 1
        if carbs_g >= 30:
            carb_sessions += 1
        if delay > 180 or protein_g < 15 or carbs_g < 20:
            missed_post_workout += 1

    caffeine_logged_days = len({
        d for d, v in daily_values.get("caffeine_mg", {}).items()
        if d in current_dates and float(v or 0) > 0
    })

    return NutritionSummary(
        window_days=days,
        days_with_data=int(rolling.get("days_with_data") or 0),
        avg_calories=float(rolling.get("avg_calories") or 0) if rolling.get("days_with_data") else None,
        avg_calories_when_logged=float(rolling.get("avg_calories_when_logged") or 0) if rolling.get("days_with_data") else None,
        avg_protein_g=float(rolling.get("avg_protein_g_when_logged") or 0) if rolling.get("days_with_data") else None,
        avg_carbs_g=float(rolling.get("avg_carbs_g_when_logged") or 0) if rolling.get("days_with_data") else None,
        avg_fat_g=float(rolling.get("avg_fat_g_when_logged") or 0) if rolling.get("days_with_data") else None,
        avg_fiber_g=avg_fiber,
        avg_fiber_per_1000_kcal=avg_fiber_density,
        avg_added_sugar_g=avg_added_sugar,
        avg_saturated_fat_g=avg_saturated_fat,
        avg_sodium_mg=avg_sodium,
        avg_caffeine_mg=avg_caffeine,
        avg_potassium_mg=avg_potassium,
        avg_calcium_mg=avg_calcium,
        avg_magnesium_mg=avg_magnesium,
        avg_iron_mg=avg_iron,
        avg_vitamin_d_mcg=avg_vitamin_d,
        avg_vitamin_b12_mcg=avg_vitamin_b12,
        avg_folate_mcg=avg_folate,
        avg_zinc_mg=avg_zinc,
        avg_omega_3_g=avg_omega_3_g,
        micronutrient_logged_days=len(micronutrient_days),
        caffeine_logged_days=caffeine_logged_days,
        late_caffeine_mg=late_caffeine_mg,
        late_caffeine_structured_count=late_caffeine_structured_count,
        avg_alcohol_servings=avg_alcohol,
        avg_animal_protein_g=avg_animal,
        avg_plant_protein_g=avg_plant,
        avg_energy_availability=avg_ea,
        avg_max_meal_protein_pct=avg_max_meal_protein_pct,
        calorie_target=float(target.calories) if target else None,
        protein_target_g=float(target.protein_g) if target else None,
        fat_target_g=float(target.fat_g) if target else None,
        carb_target_g=float(target.carbs_g) if target else None,
        avg_water_oz=avg_water,
        hydration_logged_days=len(water_values),
        estimated_hydration_target_oz=hydration_target,
        processed_meat_servings=processed_meat_servings,
        red_meat_servings=red_meat_servings,
        refined_grain_servings=refined_grain_servings,
        omega3_servings=omega3_servings,
        seafood_servings=seafood_servings,
        distinct_plant_foods_week=len(plant_slugs),
        ultra_processed_pct=ultra_processed_pct,
        item_count=item_count,
        classified_item_count=classified_item_count,
        insight_enriched_item_count=insight_enriched_item_count,
        late_meal_dates=late_meal_dates,
        alcohol_dates=alcohol_dates,
        fiber_spike_dates=fiber_spike_dates,
        digestion_food_dates={k: set(v) for k, v in digestion_dates.items()},
        daily_values={k: dict(v) for k, v in daily_values.items()},
        pattern_dates={k: set(v) for k, v in pattern_dates.items()},
        supplement_log_count=len(supplement_logs),
        creatine_dates=creatine_dates & current_dates,
        electrolyte_dates=electrolyte_dates & current_dates,
        magnesium_evening_dates=magnesium_evening_dates & current_dates,
        high_vitamin_c_dates=high_vitamin_c_dates & current_dates,
        vitamin_d_calcium_supplement_dates=vitamin_d_calcium_supplement_dates & current_dates,
        post_workout_timing_sessions=timing_sessions,
        first_meal_after_workout_minutes=mean(delays) if delays else None,
        post_workout_protein_sessions=protein_sessions,
        post_workout_carb_sessions=carb_sessions,
        missed_post_workout_fueling_sessions=missed_post_workout,
        checkin_dates={c.checkin_date for c in checkins if c.checkin_date in current_dates},
    )


def collect_recent_sleep(db: Session, user_id: int, days: int = 14) -> SleepSummary:
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    lookback_cutoff = today - timedelta(days=max(28, days * 2) - 1)
    rows = db.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(col(SleepLog.night_date) >= lookback_cutoff)
        .where(col(SleepLog.night_date) <= today)
        .order_by(SleepLog.night_date.asc())
    ).all()
    current_rows = [r for r in rows if r.night_date >= cutoff]
    hours = [float(r.total_hours) for r in current_rows if r.total_hours is not None and r.total_hours > 0]
    scores = [float(r.score) for r in current_rows if r.score is not None]
    bedtimes = [float(r.bedtime_minutes_from_midnight) for r in current_rows if r.bedtime_minutes_from_midnight is not None]
    low_sleep_dates = {r.night_date for r in current_rows if r.total_hours is not None and r.total_hours < 6.5}
    return SleepSummary(
        window_days=days,
        nights_with_data=len(hours),
        avg_hours=mean(hours) if hours else None,
        avg_score=mean(scores) if scores else None,
        bedtime_std_minutes=_std(bedtimes),
        low_sleep_dates=low_sleep_dates,
        hours_by_date={r.night_date: float(r.total_hours) for r in rows if r.total_hours is not None and r.total_hours > 0},
        score_by_date={r.night_date: float(r.score) for r in rows if r.score is not None},
        bedtime_minutes_by_date={r.night_date: float(r.bedtime_minutes_from_midnight) for r in rows if r.bedtime_minutes_from_midnight is not None},
    )


def collect_recent_activity(db: Session, user_id: int, days: int = 14) -> ActivitySummary:
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    lookback_cutoff = today - timedelta(days=max(28, days * 2) - 1)
    rows = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(col(DailyHealthSnapshot.snapshot_date) >= lookback_cutoff)
        .where(col(DailyHealthSnapshot.snapshot_date) <= today)
        .order_by(DailyHealthSnapshot.snapshot_date.asc())
    ).all()
    current_rows = [r for r in rows if r.snapshot_date >= cutoff]
    high_sweat = {
        r.snapshot_date for r in rows
        if (r.active_energy_kcal is not None and r.active_energy_kcal >= 700)
        or (r.workout_minutes is not None and r.workout_minutes >= 60)
    }
    daily_values = {
        "steps": {r.snapshot_date: float(r.steps) for r in rows if r.steps is not None},
        "active_energy_kcal": {r.snapshot_date: float(r.active_energy_kcal) for r in rows if r.active_energy_kcal is not None},
        "workout_minutes": {r.snapshot_date: float(r.workout_minutes) for r in rows if r.workout_minutes is not None},
        "cardio_minutes": {r.snapshot_date: float(r.cardio_minutes) for r in rows if r.cardio_minutes is not None},
        "zone2_minutes": {r.snapshot_date: float(r.zone2_minutes) for r in rows if r.zone2_minutes is not None},
    }
    return ActivitySummary(
        window_days=days,
        days_with_data=len(current_rows),
        avg_steps=_avg([r.steps for r in current_rows]),
        avg_active_energy_kcal=_avg([r.active_energy_kcal for r in current_rows]),
        avg_workout_minutes=_avg([r.workout_minutes for r in current_rows]),
        avg_cardio_minutes=_avg([r.cardio_minutes for r in current_rows]),
        avg_zone2_minutes=_avg([r.zone2_minutes for r in current_rows]),
        high_sweat_dates=high_sweat & set(_date_range(cutoff, today)),
        daily_values=daily_values,
    )


@dataclass(frozen=True)
class WorkoutStrainInfo:
    category: str
    points: float
    has_modality: bool
    is_hard: bool = False
    is_resistance: bool = False
    is_long_endurance: bool = False
    novel_or_high_soreness: bool = False


def _workout_detail_text(value: Any) -> str:
    parts: list[str] = []

    def collect(item: Any) -> None:
        if item is None:
            return
        if isinstance(item, dict):
            for k, v in item.items():
                parts.append(str(k))
                collect(v)
        elif isinstance(item, (list, tuple, set)):
            for nested in item:
                collect(nested)
        else:
            parts.append(str(item))

    collect(value)
    return " ".join(parts).lower().replace("_", " ")


def _classify_workout_strain(row: WorkoutCompletion) -> WorkoutStrainInfo:
    duration_minutes = max(0.0, float(getattr(row, "duration_seconds", 0) or 0) / 60.0)
    text = " ".join(
        str(v or "")
        for v in (
            getattr(row, "activity_category", None),
            getattr(row, "activity_subtype", None),
            getattr(row, "activity_intensity", None),
            getattr(row, "stimulus", None),
            getattr(row, "cardio_style", None),
            getattr(row, "focus_label", None),
            getattr(row, "template_id", None),
            getattr(row, "feedback_notes", None),
            _workout_detail_text(getattr(row, "activity_details", None)),
        )
    ).lower().replace("_", " ")
    has_modality = bool(text.strip())
    easy_tokens = ("walk", "walking", "mobility", "recovery", "restorative", "stretch", "yoga", "zone 1", "zone1", "zone 2", "zone2", "easy")
    glycolytic_tokens = ("hiit", "interval", "sprint", "metcon", "crossfit", "circuit", "tabata")
    hard_tokens = ("hard", "heavy", "threshold", "tempo", "race", "max", "failure", "high intensity")
    endurance_tokens = ("run", "running", "ride", "cycling", "bike", "swim", "rower", "endurance", "cardio")
    resistance_tokens = (
        "strength", "lifting", "resistance", "hypertrophy", "compound", "barbell", "dumbbell",
        "free weight", "machine", "upper", "lower", "push", "pull", "legs", "full body",
    )
    novel_or_high_soreness = (
        bool(getattr(row, "soreness_areas", None))
        or int(getattr(row, "intensity", 0) or 0) >= 5
        or str(getattr(row, "feeling", "") or "").lower() in {"rough", "bad"}
        or any(token in text for token in ("novel", "new movement", "unusual"))
    )
    if any(token in text for token in easy_tokens):
        return WorkoutStrainInfo(
            category="easy_restorative",
            points=0.0,
            has_modality=has_modality,
            novel_or_high_soreness=novel_or_high_soreness,
        )
    if any(token in text for token in glycolytic_tokens) or "conditioning" in text:
        return WorkoutStrainInfo(
            category="hard_glycolytic",
            points=1.0,
            has_modality=has_modality,
            is_hard=True,
            novel_or_high_soreness=novel_or_high_soreness,
        )
    if any(token in text for token in endurance_tokens):
        hard_endurance = duration_minutes >= 75 or any(token in text for token in hard_tokens)
        return WorkoutStrainInfo(
            category="hard_endurance" if hard_endurance else "moderate",
            points=0.9 if hard_endurance else 0.4,
            has_modality=has_modality,
            is_hard=hard_endurance,
            is_long_endurance=duration_minutes >= 75,
            novel_or_high_soreness=novel_or_high_soreness,
        )
    if any(token in text for token in resistance_tokens):
        hard_resistance = any(token in text for token in hard_tokens) or "strength" in text
        return WorkoutStrainInfo(
            category="hard_resistance" if hard_resistance else "moderate",
            points=0.8 if hard_resistance else 0.4,
            has_modality=has_modality,
            is_hard=hard_resistance,
            is_resistance=True,
            novel_or_high_soreness=novel_or_high_soreness,
        )
    return WorkoutStrainInfo(
        category="moderate",
        points=0.4,
        has_modality=has_modality,
        novel_or_high_soreness=novel_or_high_soreness,
    )


def _workout_load(row: WorkoutCompletion) -> float:
    minutes = max(0.0, float(row.duration_seconds or 0) / 60.0)
    intensity = " ".join(
        str(v or "").lower()
        for v in (row.activity_intensity, row.stimulus, row.cardio_style, row.focus_label)
    )
    multiplier = 1.0
    if any(token in intensity for token in ("hard", "heavy", "strength", "conditioning", "interval")):
        multiplier = 1.25
    elif any(token in intensity for token in ("easy", "recovery", "mobility", "stretch")):
        multiplier = 0.55
    return minutes * multiplier


def _is_hard_workout(row: WorkoutCompletion) -> bool:
    text = " ".join(
        str(v or "").lower()
        for v in (row.activity_intensity, row.stimulus, row.cardio_style, row.focus_label)
    )
    return any(token in text for token in ("hard", "heavy", "strength", "conditioning", "interval"))


_MUSCLE_TEXT_MAP = {
    "chest": ("chest", "pec", "bench", "pushup", "push-up"),
    "back": ("back", "lat", "row", "pullup", "pull-up", "pulldown"),
    "shoulders": ("shoulder", "deltoid", "press"),
    "quads": ("quad", "squat", "lunge", "leg press"),
    "hamstrings": ("hamstring", "hinge", "deadlift", "rdl"),
    "glutes": ("glute", "hip thrust", "bridge"),
    "calves": ("calf", "calves"),
    "biceps": ("bicep", "curl"),
    "triceps": ("tricep", "dip", "extension"),
    "core": ("core", "abs", "plank"),
    "lower_back": ("lower back", "lumbar"),
    "cardio": ("cardio", "conditioning", "interval", "zone 2", "zone2", "run", "bike"),
}


def _extract_muscle_groups_from_text(text: str) -> set[str]:
    lowered = text.lower()
    return {
        group for group, tokens in _MUSCLE_TEXT_MAP.items()
        if any(token in lowered for token in tokens)
    }


def _extract_muscle_groups_from_plan(workout_json: dict | None) -> set[str]:
    if not workout_json:
        return set()
    parts: list[str] = []

    def collect(value: Any) -> None:
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, dict):
            for nested in value.values():
                collect(nested)
        elif isinstance(value, list):
            for nested in value:
                collect(nested)

    for key in ("focus", "focus_label", "stimulus", "archetype", "training_type", "target_muscle_groups", "muscle_groups", "exercises"):
        collect(workout_json.get(key))
    return _extract_muscle_groups_from_text(" ".join(parts))


_MOVEMENT_PATTERNS = {
    "squat", "hinge", "push", "pull", "carry", "lunge", "rotation",
    "gait", "run", "bike", "swim", "cardio", "mobility", "horizontal_press",
    "vertical_press", "horizontal_pull", "vertical_pull",
}


def _normalize_movement_pattern(value: Any) -> str | None:
    raw = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    if not raw:
        return None
    if raw in {"horizontal_press", "vertical_press"}:
        return "push"
    if raw in {"horizontal_pull", "vertical_pull"}:
        return "pull"
    if raw in {"running"}:
        return "run"
    if raw in {"cycling"}:
        return "bike"
    return raw if raw in _MOVEMENT_PATTERNS else raw[:40]


def _extract_movement_patterns_from_plan(workout_json: dict | None) -> set[str]:
    if not workout_json:
        return set()
    patterns: set[str] = set()

    def collect(value: Any, key_hint: str = "") -> None:
        if isinstance(value, dict):
            for k, v in value.items():
                collect(v, str(k).lower())
        elif isinstance(value, list):
            for nested in value:
                collect(nested, key_hint)
        elif isinstance(value, str):
            if "movement" in key_hint or key_hint in {"pattern", "_movement_pattern"}:
                normalized = _normalize_movement_pattern(value)
                if normalized:
                    patterns.add(normalized)
            else:
                text = value.lower()
                for pattern in _MOVEMENT_PATTERNS:
                    if pattern in text:
                        normalized = _normalize_movement_pattern(pattern)
                        if normalized:
                            patterns.add(normalized)

    collect(workout_json)
    return patterns


def collect_recent_workouts(db: Session, user_id: int, days: int = 28) -> WorkoutSummary:
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(col(WorkoutCompletion.workout_date) >= cutoff)
        .where(col(WorkoutCompletion.workout_date) <= today)
        .order_by(WorkoutCompletion.workout_date.asc())
    ).all()
    loads_by_date: dict[date, float] = defaultdict(float)
    late_dates: set[date] = set()
    hard_dates: set[date] = set()
    soreness_dates: set[date] = set()
    pain_note_dates: set[date] = set()
    soreness_by_group: dict[str, set[date]] = defaultdict(set)
    fatigue_by_group: dict[str, float] = {}
    max_fatigue: float | None = None
    recent_pain_body_parts: set[str] = set()
    recent_soreness_body_parts: set[str] = set()
    current14_start = today - timedelta(days=13)
    strain_points = 0.0
    strain_sessions_with_detail = 0
    strain_counts: dict[str, int] = defaultdict(int)
    strain_hard_dates: set[date] = set()
    two_a_day_counts: dict[date, int] = defaultdict(int)
    novel_or_high_soreness_sessions = 0
    resistance_sessions = 0
    long_endurance_sessions = 0
    for row in rows:
        load = _workout_load(row)
        loads_by_date[row.workout_date] += load
        if row.workout_date >= current14_start:
            strain = _classify_workout_strain(row)
            strain_points += strain.points
            strain_counts[strain.category] += 1
            two_a_day_counts[row.workout_date] += 1
            if strain.has_modality:
                strain_sessions_with_detail += 1
            if strain.is_hard:
                strain_hard_dates.add(row.workout_date)
            if strain.is_resistance:
                resistance_sessions += 1
            if strain.is_long_endurance:
                long_endurance_sessions += 1
            if strain.novel_or_high_soreness:
                novel_or_high_soreness_sessions += 1
        ended = row.ended_at or row.completed_at
        if ended and ended.time() >= time(19, 0):
            late_dates.add(row.workout_date)
        if _is_hard_workout(row):
            hard_dates.add(row.workout_date)
        if row.soreness_areas:
            soreness_dates.add(row.workout_date)
            for raw_area in row.soreness_areas:
                area = str(raw_area or "").strip().lower().replace(" ", "_")
                if area:
                    soreness_by_group[area].add(row.workout_date)
        if any(token in str(row.feedback_notes or "").lower() for token in ("pain", "ache", "sharp", "twinge", "irritat")):
            pain_note_dates.add(row.workout_date)
        if isinstance(row.resolved_muscle_fatigue, dict):
            vals = [
                float(v) for k, v in row.resolved_muscle_fatigue.items()
                if k != "systemic" and isinstance(v, (int, float))
            ]
            if vals:
                max_fatigue = max(max_fatigue or 0.0, max(vals))
            for k, v in row.resolved_muscle_fatigue.items():
                if k == "systemic" or not isinstance(v, (int, float)):
                    continue
                group = str(k).strip().lower()
                fatigue_by_group[group] = max(float(v), fatigue_by_group.get(group, 0.0))
    day_states = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == user_id)
        .where(col(UserDayState.day_key) >= today - timedelta(days=13))
        .where(col(UserDayState.day_key) <= today)
    ).all()
    for state in day_states:
        pain_part = _normalized_body_part(getattr(state, "pain_body_part", None))
        sore_part = _normalized_body_part(getattr(state, "soreness_body_part", None))
        if pain_part and (getattr(state, "pain_present", None) is not False):
            recent_pain_body_parts.add(pain_part)
            pain_note_dates.add(state.day_key)
        if sore_part:
            recent_soreness_body_parts.add(sore_part)
            soreness_dates.add(state.day_key)
            soreness_by_group[sore_part].add(state.day_key)
    acute_start = today - timedelta(days=6)
    baseline_start = today - timedelta(days=27)
    baseline_end = today - timedelta(days=7)
    prior14_start = today - timedelta(days=27)
    prior14_end = today - timedelta(days=14)
    two_a_day_dates = {d for d, count in two_a_day_counts.items() if count >= 2}
    strain_points += len(two_a_day_dates) * 0.5
    consecutive_hard_days = sum(
        1 for d in strain_hard_dates
        if (d - timedelta(days=1)) in strain_hard_dates
    )
    strain_points += consecutive_hard_days * 0.2
    strain_points += novel_or_high_soreness_sessions * 0.3
    long_endurance_or_two_a_day_sessions = long_endurance_sessions + sum(max(0, count - 1) for count in two_a_day_counts.values())
    current14_session_count = sum(1 for r in rows if r.workout_date >= current14_start)
    strain_confidence = strain_sessions_with_detail / max(1, current14_session_count) if current14_session_count else 0.0
    acute_load = sum(load for d, load in loads_by_date.items() if d >= acute_start)
    baseline_load = sum(load for d, load in loads_by_date.items() if baseline_start <= d <= baseline_end)
    baseline_per_week = baseline_load / 3.0 if baseline_load > 0 else None
    ratio = acute_load / baseline_per_week if baseline_per_week and baseline_per_week > 0 else None
    current14_load = sum(load for d, load in loads_by_date.items() if d >= current14_start)
    prior14_load = sum(load for d, load in loads_by_date.items() if prior14_start <= d <= prior14_end)
    load_delta = current14_load - prior14_load if prior14_load > 0 or current14_load > 0 else None
    deload_detected = bool(prior14_load > 0 and current14_load <= prior14_load * 0.65)
    last_hard_date = max((d for d in hard_dates if d <= today), default=None)
    rest_days_since_hard = (today - last_hard_date).days if last_hard_date else None
    planned_cutoff = today - timedelta(days=13)
    planned_days = db.exec(
        select(PlanDay)
        .where(PlanDay.user_id == user_id)
        .where(col(PlanDay.day_date) >= planned_cutoff)
        .where(col(PlanDay.day_date) <= today)
    ).all()
    today_plan = next((p for p in planned_days if p.day_date == today), None)
    planned_intensity = None
    if today_plan and today_plan.workout_json:
        text = " ".join(
            str(today_plan.workout_json.get(k, "") or "").lower()
            for k in ("focus", "stimulus", "archetype", "training_type")
        )
        if any(token in text for token in ("heavy", "strength", "power", "interval")):
            planned_intensity = "heavy"
        elif any(token in text for token in ("conditioning", "cardio", "hard")):
            planned_intensity = "hard"
        elif any(token in text for token in ("recovery", "mobility", "easy")):
            planned_intensity = "easy"
        else:
            planned_intensity = "moderate"
    today_target_groups = _extract_muscle_groups_from_plan(today_plan.workout_json if today_plan else None)
    today_target_patterns = _extract_movement_patterns_from_plan(today_plan.workout_json if today_plan else None)
    exercise_rows = db.exec(
        select(WorkoutExercise, WorkoutSession)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(col(WorkoutSession.workout_date) >= prior14_start)
        .where(col(WorkoutSession.workout_date) <= today)
    ).all()
    movement_current: dict[str, int] = defaultdict(int)
    movement_prior: dict[str, int] = defaultdict(int)
    for exercise, session_row in exercise_rows:
        pattern = _normalize_movement_pattern(getattr(exercise, "movement_pattern_snapshot", None))
        if pattern is None:
            text = " ".join(
                str(v or "")
                for v in (
                    getattr(exercise, "name", None),
                    getattr(exercise, "primary_muscle_snapshot", None),
                    getattr(exercise, "secondary_muscles_snapshot", None),
                )
            ).lower()
            if any(token in text for token in ("squat", "leg press")):
                pattern = "squat"
            elif any(token in text for token in ("deadlift", "hinge", "rdl")):
                pattern = "hinge"
            elif any(token in text for token in ("bench", "press", "push")):
                pattern = "push"
            elif any(token in text for token in ("row", "pull", "pulldown")):
                pattern = "pull"
            elif any(token in text for token in ("run", "treadmill")):
                pattern = "run"
            elif any(token in text for token in ("bike", "cycle")):
                pattern = "bike"
        if not pattern:
            continue
        if session_row.workout_date >= current14_start:
            movement_current[pattern] += 1
        elif prior14_start <= session_row.workout_date <= prior14_end:
            movement_prior[pattern] += 1
    ramped_patterns = {
        pattern for pattern, current_count in movement_current.items()
        if current_count >= max(3, movement_prior.get(pattern, 0) * 2 + 1)
    }
    today_pain_overlap = today_target_groups & recent_pain_body_parts
    return WorkoutSummary(
        window_days=days,
        completed_sessions=len(rows),
        completed_dates={r.workout_date for r in rows},
        hard_sessions_7d=sum(1 for r in rows if r.workout_date >= acute_start and _is_hard_workout(r)),
        sessions_7d=sum(1 for r in rows if r.workout_date >= acute_start),
        sessions_28d=len(rows),
        acute_load_7d=acute_load if rows else None,
        baseline_load_per_week=baseline_per_week,
        acute_load_ratio=ratio,
        soreness_sessions_14d=sum(
            1 for r in rows
            if r.workout_date >= planned_cutoff and bool(r.soreness_areas)
        ),
        max_muscle_fatigue=max_fatigue,
        late_workout_dates=late_dates,
        planned_sessions_14d=sum(1 for p in planned_days if not p.is_rest and p.workout_json),
        today_planned_intensity=planned_intensity,
        hard_session_dates=hard_dates,
        loads_by_date=dict(loads_by_date),
        soreness_dates=soreness_dates,
        pain_note_dates=pain_note_dates,
        soreness_by_muscle_group={k: set(v) for k, v in soreness_by_group.items()},
        fatigue_by_muscle_group=fatigue_by_group,
        load_delta_vs_prior_14=load_delta,
        deload_detected=deload_detected,
        rest_days_since_last_hard_session=rest_days_since_hard,
        today_target_muscle_groups=today_target_groups,
        recent_pain_body_parts=recent_pain_body_parts,
        recent_soreness_body_parts=recent_soreness_body_parts,
        today_pain_body_part_overlap=today_pain_overlap,
        movement_pattern_counts_14d=dict(movement_current),
        movement_pattern_counts_prior_14d=dict(movement_prior),
        ramped_movement_patterns=ramped_patterns,
        today_target_movement_patterns=today_target_patterns,
        training_strain_points_14d=strain_points,
        training_strain_confidence=strain_confidence,
        easy_restorative_sessions_14d=strain_counts.get("easy_restorative", 0),
        moderate_sessions_14d=strain_counts.get("moderate", 0),
        hard_resistance_sessions_14d=strain_counts.get("hard_resistance", 0),
        hard_endurance_sessions_14d=strain_counts.get("hard_endurance", 0),
        hard_glycolytic_sessions_14d=strain_counts.get("hard_glycolytic", 0),
        resistance_sessions_14d=resistance_sessions,
        long_endurance_or_two_a_day_sessions_14d=long_endurance_or_two_a_day_sessions,
        two_a_day_dates_14d=two_a_day_dates,
        consecutive_hard_days_14d=consecutive_hard_days,
        novel_or_high_soreness_sessions_14d=novel_or_high_soreness_sessions,
    )


def collect_health_snapshots(db: Session, user_id: int, days: int = 28) -> HealthSnapshotSummary:
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    rows = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(col(DailyHealthSnapshot.snapshot_date) >= cutoff)
        .where(col(DailyHealthSnapshot.snapshot_date) <= today)
        .order_by(DailyHealthSnapshot.snapshot_date.asc())
    ).all()
    hrv_rows = [r for r in rows if r.hrv_ms is not None and r.hrv_ms > 0]
    rhr_rows = [r for r in rows if r.resting_hr is not None and r.resting_hr > 0]
    vo2_rows = [r for r in rows if r.vo2_max is not None and r.vo2_max > 0]
    weight_rows = [r for r in rows if r.weight_lbs is not None and r.weight_lbs > 0]
    hrv_latest = float(hrv_rows[-1].hrv_ms) if hrv_rows else None
    hrv_baseline = mean([float(r.hrv_ms) for r in hrv_rows[:-1]]) if len(hrv_rows) >= 4 else None
    rhr_latest = float(rhr_rows[-1].resting_hr) if rhr_rows else None
    rhr_baseline = mean([float(r.resting_hr) for r in rhr_rows[:-1]]) if len(rhr_rows) >= 4 else None
    vo2_latest = float(vo2_rows[-1].vo2_max) if vo2_rows else None
    vo2_trend = None
    if len(vo2_rows) >= 2:
        first = vo2_rows[0]
        last = vo2_rows[-1]
        days_between = max(1, (last.snapshot_date - first.snapshot_date).days)
        vo2_trend = (float(last.vo2_max) - float(first.vo2_max)) / days_between * 90.0
    weight_trend = None
    if len(weight_rows) >= 2:
        first = weight_rows[0]
        last = weight_rows[-1]
        days_between = max(1, (last.snapshot_date - first.snapshot_date).days)
        weight_trend = (float(last.weight_lbs) - float(first.weight_lbs)) / days_between * 7.0
    checkins = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id)
        .where(col(WeeklyCheckIn.checkin_date) >= cutoff)
        .where(col(WeeklyCheckIn.checkin_date) <= today)
        .order_by(WeeklyCheckIn.checkin_date.asc())
    ).all()
    bp = [c for c in checkins if c.bp_systolic is not None and c.bp_diastolic is not None]
    bp_systolic_by_date = {c.checkin_date: float(c.bp_systolic) for c in bp}
    bp_diastolic_by_date = {c.checkin_date: float(c.bp_diastolic) for c in bp}
    bp_trend = None
    if len(bp) >= 2:
        first = bp[0]
        last = bp[-1]
        days_between = max(1, (last.checkin_date - first.checkin_date).days)
        bp_trend = (float(last.bp_systolic) - float(first.bp_systolic)) / days_between * 14.0
    lab_rows = db.exec(
        select(HealthLabResult)
        .where(HealthLabResult.user_id == user_id)
        .where(HealthLabResult.collected_at >= datetime.combine(cutoff, time.min, tzinfo=timezone.utc))
        .where(HealthLabResult.collected_at <= datetime.combine(today, time.max, tzinfo=timezone.utc))
        .order_by(HealthLabResult.collected_at.asc())
    ).all()
    labs_by_type: dict[str, list[HealthLabResult]] = defaultdict(list)
    for row in lab_rows:
        labs_by_type[str(row.lab_type or "").lower()].append(row)
    latest_labs: dict[str, dict[str, Any]] = {}
    lab_trends: dict[str, float] = {}
    for lab_type, rows_for_type in labs_by_type.items():
        latest = rows_for_type[-1]
        latest_labs[lab_type] = {
            "value": float(latest.value),
            "unit": latest.unit,
            "collected_at": latest.collected_at.isoformat(),
            "source": latest.source,
            "reference_range_low": latest.reference_range_low,
            "reference_range_high": latest.reference_range_high,
        }
        if len(rows_for_type) >= 2:
            first = rows_for_type[0]
            days_between = max(1, (latest.collected_at.date() - first.collected_at.date()).days)
            lab_trends[lab_type] = (float(latest.value) - float(first.value)) / days_between * 90.0
    return HealthSnapshotSummary(
        window_days=days,
        days_with_data=len(rows),
        hrv_latest=hrv_latest,
        hrv_baseline=hrv_baseline,
        rhr_latest=rhr_latest,
        rhr_baseline=rhr_baseline,
        vo2_latest=vo2_latest,
        vo2_trend_per_90d=vo2_trend,
        weight_trend_lbs_per_week=weight_trend,
        bp_reading_count=len(bp),
        latest_bp_systolic=int(bp[-1].bp_systolic) if bp else None,
        latest_bp_diastolic=int(bp[-1].bp_diastolic) if bp else None,
        median_bp_systolic=median([float(c.bp_systolic) for c in bp]) if bp else None,
        median_bp_diastolic=median([float(c.bp_diastolic) for c in bp]) if bp else None,
        bp_systolic_trend=bp_trend,
        hrv_by_date={r.snapshot_date: float(r.hrv_ms) for r in hrv_rows},
        rhr_by_date={r.snapshot_date: float(r.resting_hr) for r in rhr_rows},
        vo2_by_date={r.snapshot_date: float(r.vo2_max) for r in vo2_rows},
        weight_by_date={r.snapshot_date: float(r.weight_lbs) for r in weight_rows},
        bp_systolic_by_date=bp_systolic_by_date,
        bp_diastolic_by_date=bp_diastolic_by_date,
        latest_labs=latest_labs,
        lab_trends=lab_trends,
    )


def collect_cycle_summary(db: Session, user_id: int, days: int = 90) -> CycleSummary:
    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
    opt_in = bool(prefs and prefs.reproductive_health_opt_in)
    cycle_enabled = bool(prefs and prefs.cycle_tracking_enabled)
    if not opt_in or not cycle_enabled:
        return CycleSummary(window_days=days, opt_in=opt_in, cycle_tracking_enabled=cycle_enabled)
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    rows = db.exec(
        select(CycleLog)
        .where(CycleLog.user_id == user_id)
        .where(col(CycleLog.period_start_date) >= cutoff)
        .where(col(CycleLog.period_start_date) <= today)
        .order_by(CycleLog.period_start_date.asc())
    ).all()
    symptom_dates = {
        r.period_start_date for r in rows
        if r.symptoms
    }
    flow_dates = {
        r.period_start_date for r in rows
        if r.flow_level
    }
    cycle_lengths = [
        int(r.cycle_length) for r in rows
        if r.cycle_length is not None and r.cycle_length > 0
    ]
    latest = rows[-1] if rows else None
    return CycleSummary(
        window_days=days,
        opt_in=opt_in,
        cycle_tracking_enabled=cycle_enabled,
        logs_count=len(rows),
        recent_cycle_lengths=cycle_lengths[-6:],
        symptom_dates=symptom_dates,
        flow_dates=flow_dates,
        latest_cycle_day=latest.cycle_day if latest else None,
        ovulation_sources={str(r.ovulation_estimate_source or "unknown") for r in rows},
    )


def collect_recovery_modalities(db: Session, user_id: int, days: int = 28) -> RecoveryModalitySummary:
    from app.services.workout.activity_impact import normalize_recovery_modality

    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    activity_rows = db.exec(
        select(RecoveryActivity)
        .where(RecoveryActivity.user_id == user_id)
        .where(col(RecoveryActivity.activity_date) >= cutoff)
        .where(col(RecoveryActivity.activity_date) <= today)
        .order_by(RecoveryActivity.activity_date.asc())
    ).all()
    completion_rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= cutoff)
        .where(WorkoutCompletion.workout_date <= today)
        .where(WorkoutCompletion.activity_category == "recovery")
        .order_by(WorkoutCompletion.workout_date.asc())
    ).all()
    modality_dates: dict[str, set[date]] = defaultdict(set)
    modality_minutes: dict[str, int] = defaultdict(int)
    dates: set[date] = set()

    def add_observation(modality_value: str | None, day: date | None, minutes: int) -> None:
        if day is None:
            return
        modality = normalize_recovery_modality(modality_value) or "generic"
        dates.add(day)
        modality_dates[modality].add(day)
        modality_minutes[modality] += max(0, int(minutes or 0))

    for row in activity_rows:
        add_observation(row.modality, row.activity_date, int(row.duration_min or 0))
    for row in completion_rows:
        add_observation(
            row.activity_subtype or row.focus_label,
            row.workout_date,
            max(1, int(row.duration_seconds or 0) // 60),
        )
    return RecoveryModalitySummary(
        window_days=days,
        activity_count=len(activity_rows) + len(completion_rows),
        dates=dates,
        modality_dates={k: set(v) for k, v in modality_dates.items()},
        modality_minutes=dict(modality_minutes),
    )


def collect_recent_lifestyle(db: Session, user_id: int, days: int = 14) -> LifestyleSummary:
    today = date.today()
    cutoff = today - timedelta(days=days - 1)
    rows = db.exec(
        select(DailyLifestyleLog)
        .where(DailyLifestyleLog.user_id == user_id)
        .where(col(DailyLifestyleLog.local_date) >= cutoff)
        .where(col(DailyLifestyleLog.local_date) <= today)
        .order_by(DailyLifestyleLog.local_date.asc())
    ).all()
    dates: set[date] = set()
    alcohol_dates: set[date] = set()
    cannabis_dates: set[date] = set()
    high_stress_dates: set[date] = set()
    illness_dates: set[date] = set()
    late_caffeine_dates: set[date] = set()
    unusual_appetite_dates: set[date] = set()
    digestion_issue_dates: set[date] = set()

    for row in rows:
        d = row.local_date
        dates.add(d)
        alcohol = str(row.alcohol_level or "none").lower()
        cannabis = str(row.cannabis_level or "none").lower()
        if alcohol in {"light", "moderate", "heavy"} or float(row.alcohol_drinks or 0) > 0:
            alcohol_dates.add(d)
        if cannabis in {"light", "moderate", "heavy"}:
            cannabis_dates.add(d)
        if str(row.stress_level or "").lower() == "high":
            high_stress_dates.add(d)
        if str(row.illness_state or "").lower() in {"rundown", "sick"}:
            illness_dates.add(d)
        if bool(row.late_caffeine) or str(row.caffeine_timing or "").lower() in {"evening", "late"}:
            late_caffeine_dates.add(d)
        if str(row.appetite or "").lower() in {"low", "high"}:
            unusual_appetite_dates.add(d)
        bowel_count = row.bowel_movement_count
        bowel_consistency = str(row.bowel_consistency or "").lower()
        if bowel_count == 0 or bowel_consistency in {"loose", "hard", "mixed", "not_sure"}:
            digestion_issue_dates.add(d)

    return LifestyleSummary(
        window_days=days,
        logs_count=len(rows),
        dates=dates,
        alcohol_dates=alcohol_dates,
        cannabis_dates=cannabis_dates,
        high_stress_dates=high_stress_dates,
        illness_dates=illness_dates,
        late_caffeine_dates=late_caffeine_dates,
        unusual_appetite_dates=unusual_appetite_dates,
        digestion_issue_dates=digestion_issue_dates,
    )


def collect_user_context(db: Session, user_id: int) -> UserContext:
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    prefs = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
    goal = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    height_inches = None
    if profile:
        height_inches = int(profile.height_feet or 0) * 12 + int(profile.height_inches or 0)
    glp1_support = prefs.glp1_support if prefs and isinstance(getattr(prefs, "glp1_support", None), dict) else {}
    glp1_side_effects = tuple(
        str(item).strip()
        for item in (glp1_support.get("sideEffects") or glp1_support.get("side_effects") or [])
        if str(item).strip()
    )
    return UserContext(
        goal=_enum_text(goal.goal_type if goal else None),
        goal_pace=_enum_text(goal.pace if goal else None),
        age=int(profile.age) if profile and profile.age else None,
        sex=_enum_text(profile.gender if profile else None),
        weight_lbs=float(profile.weight_lbs) if profile and profile.weight_lbs else None,
        height_inches=height_inches,
        training_level=prefs.experience_level if prefs else None,
        days_per_week=int(prefs.days_per_week) if prefs else None,
        kidney_stone_history=(prefs.kidney_stone_history if prefs else None) or "unknown",
        stone_type=prefs.stone_type if prefs else None,
        stone_history_source=prefs.stone_history_source if prefs else None,
        reproductive_health_opt_in=bool(prefs.reproductive_health_opt_in) if prefs else False,
        cycle_tracking_enabled=bool(prefs.cycle_tracking_enabled) if prefs else False,
        trying_to_conceive=prefs.trying_to_conceive if prefs else None,
        pregnancy_status=prefs.pregnancy_status if prefs else None,
        known_pcos=prefs.known_pcos if prefs else None,
        known_endometriosis=prefs.known_endometriosis if prefs else None,
        gestational_diabetes_history=prefs.gestational_diabetes_history if prefs else None,
        glp1_support_enabled=bool(glp1_support.get("enabled")),
        glp1_appetite=str(glp1_support.get("appetite") or "").strip() or None,
        glp1_side_effects=glp1_side_effects,
    )


def build_insight_context(db: Session, user_id: int, days: int = 14) -> InsightContext:
    now = datetime.now(timezone.utc).isoformat()
    ctx = InsightContext(
        nutrition=collect_recent_nutrition(db, user_id, days=days),
        sleep=collect_recent_sleep(db, user_id, days=days),
        activity=collect_recent_activity(db, user_id, days=days),
        workouts=collect_recent_workouts(db, user_id, days=max(28, days)),
        health=collect_health_snapshots(db, user_id, days=max(28, days)),
        user=collect_user_context(db, user_id),
        generated_at=now,
        cycle=collect_cycle_summary(db, user_id, days=90),
        recovery_modalities=collect_recovery_modalities(db, user_id, days=max(28, days)),
        lifestyle=collect_recent_lifestyle(db, user_id, days=days),
    )
    return replace(ctx, features=extract_insight_features(ctx))


def compute_gut_microbiome_support(ctx: InsightContext) -> InsightCard:
    n, s = ctx.nutrition, ctx.sleep
    f = _features(ctx)
    meals = f.meals

    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("fiber logs", n.avg_fiber_g is not None),
        ("plant diversity data", n.distinct_plant_foods_week > 0),
        ("fermented food logs", meals.fermented_food_days > 0),
        ("meal pattern data", n.item_count > 0),
        ("sleep data", s.avg_hours is not None),
    ):
        (present if ok else missing).append(label)

    if len(present) < 2 or n.days_with_data < 4:
        return _unknown_card(
            card_id="gut_microbiome_support",
            title="Gut Microbiome Support",
            category="gut_microbiome",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals for at least 5 days to reveal your gut-support pattern.",
        )

    score = 60.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if n.avg_fiber_g is not None:
        if n.avg_fiber_g >= 28:
            score += 12
            positives.append("High fiber intake supports diverse gut bacteria populations.")
        elif n.avg_fiber_g >= 20:
            score += 6
            positives.append("Fiber intake is in a range that supports gut microbial diversity.")
        elif n.avg_fiber_g < 12:
            score -= 12
            drivers.append("Fiber is low — the gut microbiome's primary fuel source.")
            recs.append("Add one high-fiber whole food each day: lentils, oats, or a large portion of vegetables.")
        elif n.avg_fiber_g < 18:
            score -= 6
            drivers.append("Fiber intake is below what most gut bacteria need to thrive.")

    if meals.fermented_food_days >= 5:
        score += 12
        positives.append("Fermented foods appear on multiple days — directly introducing beneficial bacteria.")
    elif meals.fermented_food_days >= 3:
        score += 7
        positives.append("Fermented food intake is present across several days in the recent pattern.")
    elif meals.fermented_food_days >= 1:
        score += 3
        positives.append("Some fermented food intake is logged.")
    elif n.days_with_data >= 7:
        score -= 8
        drivers.append("No fermented foods detected in recent logs — a consistent gap in probiotic input.")
        recs.append("Add a daily fermented food: yogurt, kefir, kimchi, sauerkraut, or kombucha.")

    if n.distinct_plant_foods_week >= 12:
        score += 10
        positives.append("High plant variety is providing diverse prebiotic compounds across the week.")
    elif n.distinct_plant_foods_week >= 7:
        score += 5
        positives.append("Good plant variety supports a diverse microbiome.")
    elif n.distinct_plant_foods_week <= 3 and n.days_with_data >= 5:
        score -= 8
        drivers.append("Plant variety is narrow — the microbiome benefits from a wide range of plant foods.")
        recs.append("Rotate vegetables and fruits rather than eating the same ones each day.")
    elif n.distinct_plant_foods_week <= 5 and n.days_with_data >= 5:
        score -= 4
        drivers.append("Plant variety is below the range that supports a diverse microbiome.")

    prebiotic_score = meals.legume_days + meals.whole_grain_days
    if prebiotic_score >= 7:
        score += 6
        positives.append("Legumes and whole grains appear regularly — strong prebiotic fiber sources.")
    elif prebiotic_score >= 4:
        score += 3
        positives.append("Some legumes or whole grains are present, adding prebiotic fiber.")
    elif prebiotic_score <= 1 and n.days_with_data >= 7:
        score -= 5
        drivers.append("Legumes and whole grains — key prebiotic foods — are sparse in recent logs.")

    if n.ultra_processed_pct is not None:
        if n.ultra_processed_pct >= 50:
            score -= 10
            drivers.append("Ultra-processed foods dominate recent logs — they reduce microbial diversity and gut barrier integrity.")
        elif n.ultra_processed_pct >= 35:
            score -= 5
            drivers.append("Ultra-processed foods are frequent in recent logs, limiting diversity-supporting nutrients.")
        elif n.ultra_processed_pct <= 20:
            score += 4
            positives.append("Mostly whole and minimally processed foods support gut diversity.")

    omega3_total = n.omega3_servings + n.seafood_servings
    if (n.avg_omega_3_g or 0) >= 1.0 or omega3_total >= 2:
        score += 4
        positives.append("Omega-3 sources support gut barrier integrity and reduce intestinal inflammation.")

    if (n.avg_alcohol_servings or 0) >= 1.5:
        score -= 8
        drivers.append("Regular alcohol intake alters gut microbiome composition and weakens the gut barrier.")

    if s.avg_hours is not None and s.avg_hours < 6.5:
        score -= 5
        drivers.append("Short sleep is associated with reduced gut microbial diversity.")

    signals: list[EvidenceSignal] = []

    if meals.fermented_food_days >= 3 and n.distinct_plant_foods_week >= 6:
        signals.append(_signal(
            "fermented_plant_diversity",
            "Fermented + plant diversity",
            "protective",
            min(1.0, (meals.fermented_food_days / 7.0 + n.distinct_plant_foods_week / 14.0) / 2.0),
            f.coverage["nutrition"],
            8,
            "Fermented foods and plant variety appear together — a strong combination for microbial diversity.",
        ))

    if (n.avg_fiber_g or 999) < 15 and n.distinct_plant_foods_week <= 4 and n.days_with_data >= 5:
        signals.append(_signal(
            "low_fiber_low_diversity",
            "Low fiber + low plant diversity",
            "risk",
            0.8,
            f.coverage["nutrition"],
            10,
            "Low fiber and narrow plant variety together create a nutrient-poor environment for gut bacteria.",
        ))

    if (n.ultra_processed_pct or 0) >= 35 and meals.fermented_food_days == 0:
        signals.append(_signal(
            "high_upf_no_fermented",
            "High UPF + no fermented foods",
            "risk",
            min(1.0, (n.ultra_processed_pct or 0) / 60.0),
            f.coverage["nutrition"] * 0.8,
            8,
            "High ultra-processed food intake combined with no fermented foods creates a double gap in gut support.",
        ))

    score = _apply_evidence(score, signals, risk_direction="higher_is_better")

    if not recs:
        recs.append("Prioritize variety over perfection — rotate plant foods, add fermented foods, and limit ultra-processed items.")

    final = _clamp(score)
    risk_signal_count = _corroborating_count(signals)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=f.coverage["nutrition"],
        corroborating_signals=risk_signal_count,
    )
    if n.item_count < 20:
        confidence, reasons = _cap_confidence(
            confidence, reasons, "medium",
            "Limited meal item count — more logging improves gut pattern accuracy",
        )

    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="gut_microbiome_support",
        title="Gut Microbiome Support",
        category="gut_microbiome",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews fiber, fermented foods, plant diversity, and processing patterns that shape the gut microbiome environment. It does not assess individual bacterial strains or diagnose gut conditions.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            sleep=s.avg_hours is not None,
            alcohol=n.avg_alcohol_servings is not None,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_alcohol_pattern(ctx: InsightContext) -> InsightCard:
    n, s, h = ctx.nutrition, ctx.sleep, ctx.health
    f = _features(ctx)
    meals = f.meals

    alcohol_day_count = len(n.alcohol_dates)
    avg_servings = n.avg_alcohol_servings or 0.0

    if avg_servings < 0.1 and alcohol_day_count < 2:
        return _unknown_card(
            card_id="alcohol_pattern",
            title="Alcohol Pattern",
            category="alcohol_pattern",
            risk_direction="higher_is_worse",
            generated_at=ctx.generated_at,
            missing_data=["alcohol logs"],
            recommendation="Log alcoholic drinks to unlock an alcohol pattern read.",
        )

    present: list[str] = ["alcohol logs"]
    missing: list[str] = []
    for label, ok in (
        ("sleep data", s.avg_hours is not None),
        ("HRV/RHR data", h.hrv_latest is not None or h.rhr_latest is not None),
        ("nutrition logs", n.days_with_data > 0),
    ):
        (present if ok else missing).append(label)

    score = 0.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if avg_servings >= 3.0:
        score += 55
        drivers.append(f"Average alcohol consumption is high in the recent window (~{avg_servings:.1f} servings/day tracked).")
        recs.append("Consider alcohol-free days and consult a healthcare provider about your intake.")
    elif avg_servings >= 2.0:
        score += 35
        drivers.append(f"Alcohol consumption is above moderate levels in recent logs (~{avg_servings:.1f} servings/day tracked).")
        recs.append("Aim for 2+ alcohol-free days per week to reduce cumulative metabolic and sleep impact.")
    elif avg_servings >= 1.0:
        score += 18
        drivers.append("Regular alcohol appears in recent logs — even daily moderate intake adds up metabolically.")
    elif avg_servings >= 0.5:
        score += 8
    else:
        positives.append("Alcohol intake is very low or absent in recent logs.")

    if alcohol_day_count >= 10 and n.days_with_data > 0:
        freq_pct = int(round(100 * alcohol_day_count / max(1, n.days_with_data)))
        score += 8
        drivers.append(f"Alcohol was logged on {alcohol_day_count} of {n.days_with_data} tracked days ({freq_pct}%).")
    elif alcohol_day_count <= 2 and avg_servings < 0.5:
        positives.append("Alcohol frequency is low in the recent window.")

    if meals.evening_alcohol_count >= 3:
        score += 12
        drivers.append("Evening alcohol appears frequently — alcohol disrupts REM sleep even at moderate doses.")
        recs.append("Move alcohol consumption earlier in the evening (at least 3 hours before bed) or substitute a non-alcoholic drink.")
    elif meals.evening_alcohol_count >= 1:
        score += 5
        drivers.append("Evening alcohol is present on some logged days.")

    if s.avg_hours is not None and s.avg_hours < 6.5 and avg_servings >= 0.5:
        score += 8
        drivers.append("Short sleep and regular alcohol appear together — alcohol fragments sleep architecture even at low doses.")

    signals: list[EvidenceSignal] = []
    recovery = f.recovery

    if recovery.hrv_suppression_days >= 2 and alcohol_day_count >= 3:
        signals.append(_signal(
            "alcohol_hrv_suppression",
            "Alcohol + HRV suppression",
            "risk",
            min(1.0, recovery.hrv_suppression_days / 5.0),
            f.coverage["apple_health"],
            10,
            "HRV suppression days and alcohol intake appear together — consistent with autonomic recovery pressure.",
        ))

    if meals.evening_alcohol_count >= 2 and s.avg_hours is not None and s.avg_hours < 7.0:
        signals.append(_signal(
            "evening_alcohol_sleep_pattern",
            "Evening alcohol + short sleep",
            "risk",
            min(1.0, meals.evening_alcohol_count / 5.0),
            max(f.coverage["nutrition"], f.coverage["sleep"]),
            10,
            "Evening alcohol combined with short sleep is a compounding pattern — alcohol suppresses deep sleep.",
        ))

    if avg_servings <= 0.3 and alcohol_day_count <= 1:
        signals.append(_signal(
            "minimal_alcohol_pattern",
            "Minimal alcohol",
            "protective",
            0.8,
            f.coverage["nutrition"],
            8,
            "Alcohol is essentially absent in recent logs.",
        ))

    score = _apply_evidence(score, signals, risk_direction="higher_is_worse")

    if not recs and score > 10:
        recs.append("Even small reductions in alcohol frequency have measurable benefits for sleep, recovery, and cardiovascular health.")
    elif not recs:
        recs.append("Keep alcohol intake low or absent — this supports sleep quality, HRV, and metabolic health.")

    final = _clamp(score)
    risk_signal_count = _corroborating_count(signals)
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=f.coverage["nutrition"],
        corroborating_signals=risk_signal_count,
    )
    if s.avg_hours is None:
        confidence, reasons = _cap_confidence(
            confidence, reasons, "medium",
            "No sleep data available — sleep impact of alcohol cannot be assessed here",
        )

    status = _status_from_score(final, risk_direction="higher_is_worse")
    return InsightCard(
        id="alcohol_pattern",
        title="Alcohol Pattern",
        category="alcohol_pattern",
        status=status,
        score=final,
        risk_direction="higher_is_worse",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews how often and how much alcohol appears in recent logs and cross-references it with sleep and recovery data. It does not screen for alcohol use disorder — consult a healthcare provider if alcohol feels difficult to control.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            sleep=s.avg_hours is not None,
            apple_health=h.hrv_latest is not None or h.rhr_latest is not None,
            alcohol=True,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_circadian_nutrition_pattern(ctx: InsightContext) -> InsightCard:
    n, s, w = ctx.nutrition, ctx.sleep, ctx.workouts
    f = _features(ctx)
    meals = f.meals
    fueling = f.fueling

    present: list[str] = []
    missing: list[str] = []
    for label, ok in (
        ("meal pattern data", n.item_count > 0),
        ("sleep timing", s.bedtime_std_minutes is not None or s.avg_hours is not None),
        ("late meal logs", meals.late_meal_count > 0 or n.days_with_data >= 5),
        ("workout fueling data", n.post_workout_timing_sessions > 0 or w.completed_sessions > 0),
    ):
        (present if ok else missing).append(label)

    if len(present) < 2 or n.days_with_data < 4:
        return _unknown_card(
            card_id="circadian_nutrition_pattern",
            title="Circadian Nutrition Timing",
            category="circadian_nutrition",
            risk_direction="higher_is_better",
            generated_at=ctx.generated_at,
            missing_data=missing,
            recommendation="Log meals for at least 5 days to reveal your meal timing pattern.",
        )

    score = 70.0
    drivers: list[str] = []
    positives: list[str] = []
    recs: list[str] = []

    if meals.late_large_meal_count >= 4:
        score -= 14
        drivers.append("Large meals late at night appear frequently — this shifts digestion, blood sugar, and sleep quality adversely.")
        recs.append("Shift your largest meal earlier in the day and keep evening meals lighter.")
    elif meals.late_large_meal_count >= 2:
        score -= 7
        drivers.append("Late large meals appear repeatedly in the recent pattern.")

    if meals.late_meal_count >= 6:
        score -= 10
        drivers.append("Eating frequently late at night is a recurring pattern — consistent late intake disrupts the circadian rhythm of digestion.")
    elif meals.late_meal_count >= 3:
        score -= 5
        drivers.append("Late-night eating appears regularly in recent logs.")

    if meals.late_added_sugar_count >= 3:
        score -= 7
        drivers.append("Late-evening added sugar appears often — this elevates blood glucose near sleep and delays sleep onset.")
        recs.append("Move sugary snacks to the afternoon; substitute a small protein-fat snack if hungry in the evening.")

    if meals.late_high_fat_count >= 3:
        score -= 5
        drivers.append("Late high-fat meals appear repeatedly — fat-heavy meals slow gastric emptying and can fragment sleep.")

    if s.bedtime_std_minutes is not None:
        if s.bedtime_std_minutes < 20:
            score += 8
            positives.append("Very consistent sleep timing — a stable circadian anchor for digestion and appetite hormones.")
        elif s.bedtime_std_minutes < 40:
            score += 4
            positives.append("Reasonably consistent bedtime supports circadian rhythm regulation.")
        elif s.bedtime_std_minutes >= 60:
            score -= 8
            drivers.append("Highly irregular sleep timing disrupts the circadian rhythm that controls hunger, metabolism, and digestion.")
        elif s.bedtime_std_minutes >= 45:
            score -= 4
            drivers.append("Sleep timing is somewhat irregular, which can affect appetite regulation and meal timing.")

    if fueling.post_workout_protein_present and n.post_workout_timing_sessions >= 2:
        score += 6
        positives.append("Post-workout protein is present on workout days — supporting recovery and circadian fuel alignment.")
    elif n.missed_post_workout_fueling_sessions >= 3:
        score -= 6
        drivers.append("Post-workout fueling is frequently missed — the post-exercise window is a key circadian nutrition opportunity.")
        recs.append("Eat a protein-rich meal or snack within 2 hours of finishing each workout.")

    if s.avg_hours is not None and s.avg_hours < 6.5 and meals.late_large_meal_count >= 2:
        score -= 6
        drivers.append("Short sleep and late large meals appear together — a compounding circadian disruption.")
    elif s.avg_hours is not None and s.avg_hours >= 7.5:
        positives.append("Sleep duration is good — suggesting the meal timing pattern is not severely disrupting sleep.")

    signals: list[EvidenceSignal] = []

    if meals.late_large_meal_count >= 2 and s.avg_hours is not None and s.avg_hours < 7.0:
        signals.append(_signal(
            "late_meal_sleep_disruption",
            "Late meal + short sleep",
            "risk",
            min(1.0, meals.late_large_meal_count / 5.0),
            max(f.coverage["nutrition"], f.coverage["sleep"]),
            10,
            "Late large meals and short sleep appear together — timing and sleep quality are compounding each other.",
        ))

    if meals.late_added_sugar_count >= 2 and meals.late_large_meal_count >= 1:
        signals.append(_signal(
            "late_sugar_meal_cluster",
            "Late sugar + late large meal",
            "risk",
            min(1.0, (meals.late_added_sugar_count + meals.late_large_meal_count) / 8.0),
            f.coverage["nutrition"],
            8,
            "Late added sugar and large meals appear together — an unfavorable blood sugar pattern near sleep.",
        ))

    if s.bedtime_std_minutes is not None and s.bedtime_std_minutes < 25 and meals.late_meal_count <= 2:
        signals.append(_signal(
            "consistent_circadian_routine",
            "Consistent timing routine",
            "protective",
            0.8,
            max(f.coverage["sleep"], f.coverage["nutrition"]),
            8,
            "Consistent sleep timing and low late-night eating suggest a well-anchored circadian rhythm.",
        ))

    if n.post_workout_timing_sessions >= 3 and (fueling.post_workout_protein_present or fueling.post_workout_carbs_present):
        signals.append(_signal(
            "structured_post_workout_fueling",
            "Structured post-workout fueling",
            "protective",
            min(1.0, n.post_workout_timing_sessions / 6.0),
            f.coverage["workouts"],
            6,
            "Post-workout nutrition is structured on multiple sessions — supporting recovery and circadian fuel alignment.",
        ))

    score = _apply_evidence(score, signals, risk_direction="higher_is_better")

    if not recs:
        recs.append("Eat your largest meals earlier in the day, finish eating 2–3 hours before bed, and fuel promptly after workouts.")

    final = _clamp(score)
    risk_signal_count = _corroborating_count(signals)
    coverage_combined = min(
        max(f.coverage["nutrition"], 0.2),
        max(f.coverage["sleep"] if s.avg_hours is not None else 0.2, 0.2),
    )
    confidence, reasons = _confidence(
        present,
        missing,
        coverage=coverage_combined,
        corroborating_signals=risk_signal_count,
    )
    if s.bedtime_std_minutes is None:
        confidence, reasons = _cap_confidence(
            confidence, reasons, "medium",
            "No sleep timing variability data — circadian alignment cannot be fully measured",
        )

    status = _status_from_score(final, risk_direction="higher_is_better")
    return InsightCard(
        id="circadian_nutrition_pattern",
        title="Circadian Nutrition Timing",
        category="circadian_nutrition",
        status=status,
        score=final,
        risk_direction="higher_is_better",
        confidence=confidence,
        confidence_reasons=reasons,
        summary="This reviews when you eat — late meals, post-workout fueling, and bedtime consistency — relative to your sleep timing. It does not diagnose sleep disorders or metabolic conditions.",
        drivers=_driver_limit(drivers),
        positive_factors=_positive_limit(positives),
        recommendations=_recommendation_limit(recs),
        disclaimer=DISCLAIMER,
        data_used=_domains(
            nutrition=n.days_with_data > 0,
            sleep=s.avg_hours is not None,
            workouts=w.completed_sessions > 0,
        ),
        missing_data=missing,
        generated_at=ctx.generated_at,
    )


def compute_all_insight_cards(ctx: InsightContext, *, include_risk_signals: bool | None = None) -> list[InsightCard]:
    risk_signals_on = health_risk_signals_enabled() if include_risk_signals is None else bool(include_risk_signals)
    cards = [
        compute_healthspan_foundations(ctx),
        compute_bone_density_support(ctx),
        compute_muscle_preservation_watch(ctx),
        compute_red_processed_meat_pattern(ctx),
        compute_blood_sugar_support_pattern(ctx),
        compute_cholesterol_support_pattern(ctx),
        compute_hormone_support(ctx),
        compute_hydration_electrolyte_risk(ctx),
        compute_kidney_stone_risk_factors(ctx),
        compute_energy_availability(ctx),
        compute_recovery_modality_response(ctx),
        compute_lifestyle_context_pattern(ctx),
        compute_digestion_patterns(ctx),
        compute_gut_microbiome_support(ctx),
        compute_inflammation_support(ctx),
        compute_alcohol_pattern(ctx),
        compute_circadian_nutrition_pattern(ctx),
        compute_brain_health_support(ctx),
        compute_protein_quality_pattern(ctx),
        compute_heart_health_habits(ctx),
    ]
    if risk_signals_on:
        risk_cards = [
            compute_cardiometabolic_risk_signals(ctx),
            compute_blood_pressure_sodium_risk_signal(ctx),
        ]
        if ctx.user.glp1_support_enabled:
            risk_cards.append(compute_glp1_muscle_preservation_signal(ctx))
        cards = [*risk_cards, *cards]
    if _supports_menstrual_cycle_insights(ctx.user):
        cards.append(compute_menstrual_cycle_recovery_pattern(ctx))
    return cards


def _supports_menstrual_cycle_insights(user: UserContext) -> bool:
    return (user.sex or "").strip().lower() != "male"


def _quality(days_present: int, window_days: int) -> str:
    ratio = days_present / max(1, window_days)
    if ratio >= 0.7:
        return "high"
    if ratio >= 0.35:
        return "medium"
    return "low"


def _coverage_entry(
    label: str,
    days_with_data: int,
    window_days: int,
    *,
    unit: str = "days",
) -> dict[str, Any]:
    days_with_data = max(0, int(days_with_data or 0))
    window_days = max(1, int(window_days or 1))
    return {
        "label": label,
        "days_with_data": days_with_data,
        "window_days": window_days,
        "unit": unit,
        "quality": _quality(days_with_data, window_days),
        "display": f"{days_with_data} of {window_days} {unit}",
    }


def _event_coverage_entry(
    label: str,
    records: int,
    window_days: int,
    *,
    unit: str,
    days_with_data: int | None = None,
) -> dict[str, Any]:
    records = max(0, int(records or 0))
    window_days = max(1, int(window_days or 1))
    unit_label = unit[:-1] if records == 1 and unit.endswith("s") else unit
    payload: dict[str, Any] = {
        "label": label,
        "records": records,
        "window_days": window_days,
        "unit": unit,
        "display": f"{records} {unit_label} in {window_days} days",
    }
    if days_with_data is not None:
        days_with_data = max(0, int(days_with_data or 0))
        payload["days_with_data"] = days_with_data
        payload["quality"] = _quality(days_with_data, window_days)
        payload["display"] = f"{records} {unit_label} across {days_with_data} of {window_days} days"
    return payload


def _profile_coverage_entry(user: UserContext) -> dict[str, Any]:
    present = sum(
        1
        for value in (user.age, user.sex, user.weight_lbs, user.height_inches, user.goal)
        if value not in (None, "")
    )
    return {
        "label": "Profile",
        "records": present,
        "unit": "fields",
        "quality": "high" if present >= 4 else "medium" if present >= 2 else "low",
        "display": "Profile basics on file" if present else "No profile basics on file",
    }


def _insight_data_coverage(ctx: InsightContext, days: int) -> dict[str, dict[str, Any]]:
    coverage = {
        "nutrition": _coverage_entry("Nutrition", ctx.nutrition.days_with_data, days),
        "sleep": _coverage_entry("Sleep", ctx.sleep.nights_with_data, days, unit="nights"),
        "activity": _coverage_entry("Activity", ctx.activity.days_with_data, days),
        "hydration": _coverage_entry("Hydration", ctx.nutrition.hydration_logged_days, days),
        "micronutrients": _coverage_entry("Micronutrients", ctx.nutrition.micronutrient_logged_days, days),
        "apple_health": _coverage_entry("Apple Health", ctx.health.days_with_data, ctx.health.window_days),
        "workouts": _event_coverage_entry(
            "Workouts",
            ctx.workouts.completed_sessions,
            ctx.workouts.window_days,
            unit="sessions",
            days_with_data=len(ctx.workouts.completed_dates),
        ),
        "checkins": _event_coverage_entry(
            "Check-ins",
            len(ctx.nutrition.checkin_dates),
            days,
            unit="check-ins",
        ),
        "recovery_modalities": _event_coverage_entry(
            "Recovery modalities",
            ctx.recovery_modalities.activity_count,
            ctx.recovery_modalities.window_days,
            unit="sessions",
            days_with_data=len(ctx.recovery_modalities.dates),
        ),
        "lifestyle": _event_coverage_entry(
            "Lifestyle",
            ctx.lifestyle.logs_count,
            ctx.lifestyle.window_days,
            unit="logs",
            days_with_data=len(ctx.lifestyle.dates),
        ),
        "cycle": _event_coverage_entry("Cycle", ctx.cycle.logs_count, ctx.cycle.window_days, unit="logs")
        if ctx.cycle.opt_in else {
            "label": "Cycle",
            "records": 0,
            "window_days": ctx.cycle.window_days,
            "unit": "logs",
            "quality": "not_opted_in",
            "display": "Cycle tracking not opted in",
        },
        "labs": {
            "label": "Labs",
            "records": len(ctx.health.latest_labs),
            "window_days": ctx.health.window_days,
            "unit": "markers",
            "quality": "high" if ctx.health.latest_labs else "missing",
            "display": (
                f"{len(ctx.health.latest_labs)} lab {'marker' if len(ctx.health.latest_labs) == 1 else 'markers'} in {ctx.health.window_days} days"
                if ctx.health.latest_labs
                else f"No recent labs in {ctx.health.window_days} days"
            ),
        },
        "profile": _profile_coverage_entry(ctx.user),
    }
    return coverage


def _priority(card: InsightCard) -> tuple[int, int, int]:
    status_weight = {"high": 4, "elevated": 3, "watch": 2, "moderate": 2, "low": 1, "unknown": 0}
    confidence_weight = {"high": 3, "medium": 2, "low": 1}
    score = card.display_score if card.display_score is not None else card.score
    risk_score = 0 if score is None else (score if card.risk_direction == "higher_is_worse" else 100 - score)
    return (
        status_weight.get(card.status, 0),
        confidence_weight.get(card.confidence, 0),
        risk_score,
    )


def overall_summary(cards: list[InsightCard]) -> str:
    actionable = [
        c for c in cards
        if c.status in {"elevated", "high"} and c.confidence in {"medium", "high"}
    ]
    if not actionable:
        known = [c for c in cards if c.status != "unknown"]
        if not known:
            return "More recent logs are needed before the Insight Engine can summarize reliable patterns."
        return "No high-confidence elevated patterns stand out right now. Keep logging to improve confidence."
    top = sorted(actionable, key=_priority, reverse=True)[:2]
    titles = ", ".join(c.title for c in top)
    return f"Top current patterns to watch: {titles}. These are wellness estimates, not medical diagnosis."


def build_health_insights_response(
    db: Session,
    user_id: int,
    *,
    days: int = 14,
    include_unknown: bool = False,
    categories: list[str] | None = None,
    include_risk_signals: bool | None = None,
) -> dict[str, Any]:
    days = max(1, min(30, int(days or 14)))
    risk_signals_on = health_risk_signals_enabled() if include_risk_signals is None else bool(include_risk_signals) and health_risk_signals_enabled()
    ctx = build_insight_context(db, user_id, days=days)
    cards = compute_all_insight_cards(ctx, include_risk_signals=risk_signals_on)
    if categories:
        wanted = {c.strip().lower() for c in categories if c.strip()}
        cards = [
            card for card in cards
            if card.category.lower() in wanted or card.id.lower() in wanted
        ]
    if not include_unknown:
        cards = [card for card in cards if card.status != "unknown"]
    cards = sorted(cards, key=_priority, reverse=True)
    return {
        "user_id": str(user_id),
        "window_days": days,
        "generated_at": ctx.generated_at,
        "cards": [card.to_dict() for card in cards],
        "overall_summary": overall_summary(cards),
        "feature_flags": {
            "healthInsights.riskSignals": risk_signals_on,
        },
        "data_coverage": _insight_data_coverage(ctx, days),
        "data_quality": {
            "nutrition": _quality(ctx.nutrition.days_with_data, days),
            "sleep": _quality(ctx.sleep.nights_with_data, days),
            "activity": _quality(ctx.activity.days_with_data, days),
            "apple_health": _quality(ctx.health.days_with_data, max(28, days)),
            "hydration": _quality(ctx.nutrition.hydration_logged_days, days),
            "micronutrients": _quality(ctx.nutrition.micronutrient_logged_days, days),
            "lifestyle": _quality(ctx.lifestyle.logs_count, days),
            "cycle": _quality(ctx.cycle.logs_count, 3) if ctx.cycle.opt_in else "not_opted_in",
            "labs": "high" if ctx.health.latest_labs else "missing",
            "recovery_modalities": _quality(len(ctx.recovery_modalities.dates), ctx.recovery_modalities.window_days),
        },
    }
