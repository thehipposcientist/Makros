"""Goal forecast estimates for Progress and weekly reviews.

Deterministic only. The forecast translates current execution signals into
a 6-week, goal-specific estimate and explains the main reason the estimate
moved. It never mutates plans or coaching state.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.services.workout.goals import goal_bucket

ForecastTone = Literal["success", "warning", "neutral"]
ForecastConfidence = Literal["low", "medium", "high"]

WINDOW_WEEKS = 6
EXECUTION_CAP = 1.08
FORECAST_MULTIPLIER_FLOOR = 0.35

_FAT_LOSS_LBS_PER_WEEK = {
    "conservative": 0.5,
    "moderate": 1.0,
    "aggressive": 1.5,
}
_MUSCLE_GAIN_LBS_PER_WEEK = {
    "conservative": 0.25,
    "moderate": 0.45,
    "aggressive": 0.65,
}
_RECOMP_FAT_LOSS_LBS_PER_WEEK = {
    "conservative": (0.15, 0.35),
    "moderate": (0.20, 0.50),
    "aggressive": (0.10, 0.30),
}
_STRENGTH_GAIN_PCT_6W = {
    "conservative": 2.0,
    "moderate": 3.5,
    "aggressive": 5.0,
}


@dataclass
class ForecastStat:
    label: str
    value: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"label": self.label, "value": self.value, "detail": self.detail}


@dataclass(frozen=True)
class ExecutionWeights:
    training: float
    nutrition: float
    recovery: float

    def to_dict(self) -> dict[str, float]:
        return {
            "training": self.training,
            "nutrition": self.nutrition,
            "recovery": self.recovery,
        }


@dataclass(frozen=True)
class ExecutionBreakdown:
    training: float
    nutrition: float
    recovery: float
    recovery_assumed_neutral: bool
    weights: ExecutionWeights

    def to_dict(self) -> dict[str, Any]:
        return {
            "training": self.training,
            "nutrition": self.nutrition,
            "recovery": self.recovery,
            "recovery_assumed_neutral": self.recovery_assumed_neutral,
            "weights": self.weights.to_dict(),
        }


@dataclass
class GoalForecast:
    bucket: str
    window_weeks: int
    headline: str
    subheadline: str
    metric_label: str
    metric_value: str
    metric_detail: str
    raw_execution: float
    execution_score: float
    execution_pct: int
    forecast_multiplier: float
    execution_breakdown: ExecutionBreakdown
    confidence: ForecastConfidence
    tone: ForecastTone
    assumption: str
    update_reason: str
    drivers: list[str] = field(default_factory=list)
    limiters: list[str] = field(default_factory=list)
    stats: list[ForecastStat] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "bucket": self.bucket,
            "window_weeks": self.window_weeks,
            "headline": self.headline,
            "subheadline": self.subheadline,
            "metric_label": self.metric_label,
            "metric_value": self.metric_value,
            "metric_detail": self.metric_detail,
            "raw_execution": self.raw_execution,
            "execution_score": self.execution_score,
            "execution_pct": self.execution_pct,
            "forecast_multiplier": self.forecast_multiplier,
            "execution_breakdown": self.execution_breakdown.to_dict(),
            "confidence": self.confidence,
            "tone": self.tone,
            "assumption": self.assumption,
            "update_reason": self.update_reason,
            "drivers": self.drivers,
            "limiters": self.limiters,
            "stats": [s.to_dict() for s in self.stats],
        }


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def _round1(value: float) -> float:
    return round(value * 10) / 10


def _pace_key(pace: str | None) -> str:
    raw = str(pace or "moderate").strip().lower()
    return raw if raw in {"conservative", "moderate", "aggressive"} else "moderate"


def _fmt_lbs(value: float, *, signed: bool = False, precision: int = 1) -> str:
    sign = ""
    if signed:
        sign = "+" if value > 0 else "-" if value < 0 else ""
    amount = abs(value) if signed else value
    text = f"{amount:.{precision}f}".rstrip("0").rstrip(".")
    return f"{sign}{text} lb"


def _fmt_pct(value: float, *, signed: bool = False, precision: int = 1) -> str:
    sign = ""
    if signed:
        sign = "+" if value > 0 else "-" if value < 0 else ""
    amount = abs(value) if signed else value
    text = f"{amount:.{precision}f}".rstrip("0").rstrip(".")
    return f"{sign}{text}%"


def _ratio(numerator: float | int | None, denominator: float | int | None, fallback: float) -> float:
    if denominator is None or denominator <= 0:
        return fallback
    return _clamp(float(numerator or 0) / float(denominator), 0.0, EXECUTION_CAP)


def _execution_weights(bucket: str) -> ExecutionWeights:
    if bucket in {"fat_loss", "toning"}:
        return ExecutionWeights(training=0.25, nutrition=0.60, recovery=0.15)
    if bucket == "muscle_gain":
        return ExecutionWeights(training=0.45, nutrition=0.40, recovery=0.15)
    if bucket == "strength":
        return ExecutionWeights(training=0.55, nutrition=0.25, recovery=0.20)
    return ExecutionWeights(training=0.40, nutrition=0.45, recovery=0.15)


def _training_execution(
    *,
    sessions_completed: int,
    sessions_planned: int,
    workout_adherence_pct: float,
    workout_minutes: float | None,
    cardio_minutes: float,
) -> float:
    attendance = _ratio(sessions_completed, sessions_planned, 0.75)
    if workout_adherence_pct > 0:
        attendance = max(attendance, _clamp(workout_adherence_pct / 100.0, 0.0, EXECUTION_CAP))

    total_training_minutes = workout_minutes if workout_minutes is not None and workout_minutes > 0 else cardio_minutes
    expected_minutes = max(60.0, float(max(1, sessions_planned)) * 45.0)
    activity_volume = _clamp(float(total_training_minutes or 0.0) / expected_minutes, 0.0, EXECUTION_CAP)

    # Attendance is the primary training signal. Extra logged activity can
    # lift execution, while lifting-only users are not penalized for no cardio.
    return _clamp(max(attendance, attendance * 0.6 + activity_volume * 0.4), 0.0, EXECUTION_CAP)


def _nutrition_execution(
    *,
    days_logged: int,
    days: int,
    nutrition_logging_pct: float,
    calorie_target_adherence_pct: float | None,
    protein_target_adherence_pct: float | None,
    avg_protein_g: float,
    protein_target_g: float | None,
    current_weight_lbs: float | None,
    weekly_nutrition_score: float | None,
) -> tuple[float, list[str], list[str]]:
    drivers: list[str] = []
    limiters: list[str] = []
    coverage = _clamp((nutrition_logging_pct or 0.0) / 100.0, 0.0, 1.0)
    if days > 0 and days_logged > 0:
        coverage = max(coverage, _clamp(days_logged / days, 0.0, 1.0))

    if weekly_nutrition_score is not None and weekly_nutrition_score > 0:
        score_component = _clamp(weekly_nutrition_score / 100.0, 0.0, EXECUTION_CAP)
    else:
        score_component = None

    protein_component = None
    if protein_target_adherence_pct is not None:
        protein_component = _clamp(protein_target_adherence_pct / 100.0, 0.0, EXECUTION_CAP)
    elif protein_target_g and protein_target_g > 0 and avg_protein_g > 0:
        protein_component = _clamp(avg_protein_g / protein_target_g, 0.0, EXECUTION_CAP)
    elif current_weight_lbs and avg_protein_g > 0:
        protein_target = max(90.0, current_weight_lbs * 0.8)
        protein_component = _clamp(avg_protein_g / protein_target, 0.0, EXECUTION_CAP)

    calorie_component = (
        _clamp(calorie_target_adherence_pct / 100.0, 0.0, EXECUTION_CAP)
        if calorie_target_adherence_pct is not None else None
    )

    components: list[tuple[float, float]] = []
    if score_component is not None:
        components.append((score_component, 0.50))
    if protein_component is not None:
        components.append((protein_component, 0.30))
    if calorie_component is not None:
        components.append((calorie_component, 0.20))

    if components:
        total_weight = sum(weight for _, weight in components)
        target_adherence = sum(value * weight for value, weight in components) / total_weight
        score = 0.30 * coverage + 0.70 * target_adherence
    else:
        # Coverage is useful behavior, but logging alone should not be shown
        # as near-perfect nutrition execution without target adherence.
        score = min(0.70, 0.30 * coverage + 0.40)
    score = _clamp(score, 0.0, EXECUTION_CAP)

    if coverage >= 0.70:
        drivers.append(f"{days_logged}/{days} nutrition days logged")
    elif days_logged > 0:
        limiters.append(f"only {days_logged}/{days} nutrition days logged")
    else:
        limiters.append("no nutrition logs")

    if protein_component is not None:
        if protein_component >= 0.85:
            drivers.append("protein is supporting the goal")
        elif days_logged >= 3:
            limiters.append("protein is below target")

    if calorie_component is not None:
        if calorie_component >= 0.70:
            drivers.append("calories are near target")
        else:
            limiters.append("calories missed target often")

    return score, drivers, limiters


def _recovery_execution(avg_sleep_hours: float | None) -> tuple[float, bool, str | None]:
    if avg_sleep_hours is None:
        # Recovery is neutral when sleep data is unavailable; the breakdown
        # marks this as assumed rather than confirmed performance.
        return 1.0, True, None
    if avg_sleep_hours >= 7.0:
        return 1.0, False, None
    if avg_sleep_hours >= 6.5:
        return 0.92, False, f"sleep averaged {avg_sleep_hours:.1f}h"
    if avg_sleep_hours >= 6.0:
        return 0.82, False, f"sleep averaged {avg_sleep_hours:.1f}h"
    return 0.70, False, f"sleep averaged {avg_sleep_hours:.1f}h"


def _execution_score(
    *,
    bucket: str,
    training_execution: float,
    nutrition_execution: float,
    recovery_execution: float,
) -> tuple[float, float, int, float, ExecutionWeights]:
    weights = _execution_weights(bucket)
    raw_execution = (
        _clamp(training_execution, 0.0, EXECUTION_CAP) * weights.training
        + _clamp(nutrition_execution, 0.0, EXECUTION_CAP) * weights.nutrition
        + _clamp(recovery_execution, 0.0, EXECUTION_CAP) * weights.recovery
    )
    # User-facing execution is adherence. The 35% floor only protects
    # projections from collapsing unrealistically low.
    execution_score = _clamp(raw_execution, 0.0, EXECUTION_CAP)
    forecast_multiplier = _clamp(raw_execution, FORECAST_MULTIPLIER_FLOOR, EXECUTION_CAP)
    return raw_execution, execution_score, int(round(execution_score * 100)), forecast_multiplier, weights


def _projected_fat_loss_weekly_rate(
    *,
    planned_weekly_loss: float,
    forecast_multiplier: float,
    weight_trend_lbs_per_week: float | None,
    observed_confidence: float | None = None,
) -> float:
    planned = planned_weekly_loss * forecast_multiplier
    if weight_trend_lbs_per_week is not None and weight_trend_lbs_per_week < 0:
        if observed_confidence is not None:
            confidence = _clamp(observed_confidence, 0.0, 1.0)
            observed = _clamp(abs(weight_trend_lbs_per_week), 0.1, planned_weekly_loss * 1.2)
            # Reliable observed trends already reflect adherence, so blend
            # instead of multiplying the observed trend by execution again.
            return max(0.1, observed * confidence + planned * (1.0 - confidence))
        observed = min(planned_weekly_loss, abs(weight_trend_lbs_per_week) * 0.55 + planned_weekly_loss * 0.45)
        return max(0.1, observed * forecast_multiplier)
    return max(0.1, planned)


def _confidence(*, days_logged: int, sessions_planned: int, body_signal: bool) -> ForecastConfidence:
    score = 0
    if sessions_planned > 0:
        score += 1
    if days_logged >= 4:
        score += 2
    elif days_logged >= 2:
        score += 1
    if body_signal:
        score += 1
    if score >= 4:
        return "high"
    if score >= 2:
        return "medium"
    return "low"


def build_goal_forecast(
    *,
    goal: str | None,
    pace: str | None = None,
    current_weight_lbs: float | None = None,
    target_weight_lbs: float | None = None,
    body_fat_pct: float | None = None,
    sessions_completed: int = 0,
    sessions_planned: int = 0,
    workout_adherence_pct: float = 0.0,
    workout_minutes: float | None = None,
    cardio_minutes: float = 0.0,
    zone2_minutes: float = 0.0,
    days_logged: int = 0,
    days: int = 7,
    nutrition_logging_pct: float = 0.0,
    avg_protein_g: float = 0.0,
    protein_target_g: float | None = None,
    calorie_target_adherence_pct: float | None = None,
    protein_target_adherence_pct: float | None = None,
    weekly_nutrition_score: float | None = None,
    weight_trend_lbs_per_week: float | None = None,
    weight_trend_confidence: float | None = None,
    avg_sleep_hours: float | None = None,
) -> GoalForecast:
    bucket = goal_bucket(goal)
    pace_key = _pace_key(pace)

    training_execution = _training_execution(
        sessions_completed=sessions_completed,
        sessions_planned=sessions_planned,
        workout_adherence_pct=workout_adherence_pct,
        workout_minutes=workout_minutes,
        cardio_minutes=cardio_minutes,
    )

    nutrition_execution, nutrition_drivers, nutrition_limiters = _nutrition_execution(
        days_logged=days_logged,
        days=days,
        nutrition_logging_pct=nutrition_logging_pct,
        calorie_target_adherence_pct=calorie_target_adherence_pct,
        protein_target_adherence_pct=protein_target_adherence_pct,
        avg_protein_g=avg_protein_g,
        protein_target_g=protein_target_g,
        current_weight_lbs=current_weight_lbs,
        weekly_nutrition_score=weekly_nutrition_score,
    )
    recovery_execution, recovery_assumed_neutral, recovery_limiter = _recovery_execution(avg_sleep_hours)

    raw_execution, execution_score, execution_pct, forecast_multiplier, execution_weights = _execution_score(
        bucket=bucket,
        training_execution=training_execution,
        nutrition_execution=nutrition_execution,
        recovery_execution=recovery_execution,
    )
    execution_breakdown = ExecutionBreakdown(
        training=training_execution,
        nutrition=nutrition_execution,
        recovery=recovery_execution,
        recovery_assumed_neutral=recovery_assumed_neutral,
        weights=execution_weights,
    )

    drivers: list[str] = []
    limiters: list[str] = []
    if training_execution >= 0.85:
        drivers.append(f"{sessions_completed}/{sessions_planned} planned sessions completed")
    elif sessions_planned > 0:
        limiters.append(f"{sessions_completed}/{sessions_planned} planned sessions completed")
    drivers.extend(nutrition_drivers)
    limiters.extend(nutrition_limiters)
    if recovery_limiter:
        limiters.append(recovery_limiter)

    body_signal = bool(
        body_fat_pct is not None
        or weight_trend_lbs_per_week is not None
        or (current_weight_lbs is not None and target_weight_lbs is not None)
    )
    confidence = _confidence(
        days_logged=days_logged,
        sessions_planned=sessions_planned,
        body_signal=body_signal,
    )
    tone: ForecastTone = "success" if execution_score >= 0.78 else "warning" if execution_score < 0.58 else "neutral"

    assumption = "Assumes the next 6 weeks look like this week."
    update_reason = (
        f"Estimate was reduced by {limiters[0]}."
        if limiters else
        "Estimate held because training and nutrition are supporting the goal."
    )

    stats = [
        ForecastStat("Training", f"{sessions_completed}/{sessions_planned}" if sessions_planned else "Need plan", "planned sessions"),
        ForecastStat("Nutrition", f"{days_logged}/{days}" if days else str(days_logged), "logged days"),
    ]
    if weight_trend_lbs_per_week is not None:
        stats.append(ForecastStat("Body trend", f"{_fmt_lbs(weight_trend_lbs_per_week, signed=True)}/wk", "observed scale"))
    elif body_fat_pct is not None:
        stats.append(ForecastStat("Body scan", _fmt_pct(body_fat_pct, precision=1), "latest estimate"))

    if bucket in {"fat_loss", "toning"}:
        base = _FAT_LOSS_LBS_PER_WEEK[pace_key]
        weekly_loss = _projected_fat_loss_weekly_rate(
            planned_weekly_loss=base,
            forecast_multiplier=forecast_multiplier,
            weight_trend_lbs_per_week=weight_trend_lbs_per_week,
            observed_confidence=weight_trend_confidence,
        )
        loss = _round1(weekly_loss * WINDOW_WEEKS)
        if target_weight_lbs and current_weight_lbs:
            remaining = max(0.0, current_weight_lbs - target_weight_lbs)
            loss = min(loss, remaining) if remaining > 0 else loss
        metric_value = _fmt_lbs(loss, signed=True)
        headline = f"Estimated {metric_value} in {WINDOW_WEEKS} weeks"
        subheadline = "Fat loss forecast from goal pace, meal execution, training adherence, and weight trend."
        metric_label = "Projected scale"
        metric_detail = f"{execution_pct}% current execution"
    elif bucket == "muscle_gain":
        gain = _round1(_MUSCLE_GAIN_LBS_PER_WEEK[pace_key] * WINDOW_WEEKS * forecast_multiplier)
        metric_value = _fmt_lbs(gain, signed=True)
        headline = f"Estimated {metric_value} lean-gain pace in {WINDOW_WEEKS} weeks"
        subheadline = "Lean gain estimate is capped by training consistency, protein, and calorie execution."
        metric_label = "Lean-mass pace"
        metric_detail = f"{execution_pct}% current execution"
    elif bucket == "body_recomp":
        low, high = _RECOMP_FAT_LOSS_LBS_PER_WEEK[pace_key]
        fat_low = _round1(low * WINDOW_WEEKS * forecast_multiplier)
        fat_high = _round1(high * WINDOW_WEEKS * forecast_multiplier)
        if current_weight_lbs and current_weight_lbs > 0:
            bf_low = _round1((fat_low / current_weight_lbs) * 100)
            bf_high = _round1((fat_high / current_weight_lbs) * 100)
            metric_value = f"-{bf_low}-{bf_high}%"
            headline = f"Estimated -{bf_low}-{bf_high} body-fat points in {WINDOW_WEEKS} weeks"
        else:
            metric_value = f"{_fmt_lbs(fat_low)}-{_fmt_lbs(fat_high)}"
            headline = f"Estimated {_fmt_lbs(fat_low)}-{_fmt_lbs(fat_high)} fat loss in {WINDOW_WEEKS} weeks"
        subheadline = "Recomp assumes scale stays mostly stable while strength and protein stay consistent."
        metric_label = "Body-fat estimate"
        metric_detail = f"{_fmt_lbs(fat_low)}-{_fmt_lbs(fat_high)} fat-loss equivalent"
    elif bucket == "strength":
        pct = _round1(_STRENGTH_GAIN_PCT_6W[pace_key] * forecast_multiplier)
        metric_value = _fmt_pct(pct, signed=True)
        headline = f"Estimated {metric_value} strength marker change in {WINDOW_WEEKS} weeks"
        subheadline = "Strength forecast uses lifting adherence, nutrition support, and recovery signal."
        metric_label = "Strength marker"
        metric_detail = f"{execution_pct}% current execution"
    elif bucket in {"endurance", "hyrox"}:
        projected = int(round(cardio_minutes * WINDOW_WEEKS * max(0.65, forecast_multiplier)))
        z2_projected = int(round(zone2_minutes * WINDOW_WEEKS * max(0.65, forecast_multiplier)))
        metric_value = f"{projected} min"
        headline = f"Estimated {projected} cardio minutes in {WINDOW_WEEKS} weeks"
        subheadline = f"At this pace, about {z2_projected} min would be Zone 2."
        metric_label = "Aerobic volume"
        metric_detail = f"{execution_pct}% current execution"
    else:
        projected_days = int(round(sessions_completed * WINDOW_WEEKS * max(0.65, forecast_multiplier)))
        metric_value = f"{projected_days} days"
        headline = f"Estimated {projected_days} training days in {WINDOW_WEEKS} weeks"
        subheadline = "General fitness estimate uses weekly training and nutrition consistency."
        metric_label = "Consistency"
        metric_detail = f"{execution_pct}% current execution"

    return GoalForecast(
        bucket=bucket,
        window_weeks=WINDOW_WEEKS,
        headline=headline,
        subheadline=subheadline,
        metric_label=metric_label,
        metric_value=metric_value,
        metric_detail=metric_detail,
        raw_execution=raw_execution,
        execution_score=execution_score,
        execution_pct=execution_pct,
        forecast_multiplier=forecast_multiplier,
        execution_breakdown=execution_breakdown,
        confidence=confidence,
        tone=tone,
        assumption=assumption,
        update_reason=update_reason,
        drivers=drivers[:3],
        limiters=limiters[:3],
        stats=stats[:3],
    )
