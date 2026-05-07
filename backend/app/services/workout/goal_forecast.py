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


@dataclass
class GoalForecast:
    bucket: str
    window_weeks: int
    headline: str
    subheadline: str
    metric_label: str
    metric_value: str
    metric_detail: str
    execution_pct: int
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
            "execution_pct": self.execution_pct,
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
    return _clamp(float(numerator or 0) / float(denominator), 0.0, 1.15)


def _nutrition_execution(
    *,
    days_logged: int,
    days: int,
    nutrition_logging_pct: float,
    calorie_target_adherence_pct: float | None,
    protein_target_adherence_pct: float | None,
    avg_protein_g: float,
    current_weight_lbs: float | None,
    weekly_nutrition_score: float | None,
) -> tuple[float, list[str], list[str]]:
    drivers: list[str] = []
    limiters: list[str] = []
    coverage = _clamp((nutrition_logging_pct or 0.0) / 100.0, 0.0, 1.0)
    if days > 0 and days_logged > 0:
        coverage = max(coverage, _clamp(days_logged / days, 0.0, 1.0))

    if weekly_nutrition_score is not None and weekly_nutrition_score > 0:
        score_component = _clamp(weekly_nutrition_score / 100.0, 0.35, 1.05)
    else:
        score_component = None

    protein_component = None
    if protein_target_adherence_pct is not None:
        protein_component = _clamp(protein_target_adherence_pct / 100.0, 0.25, 1.05)
    elif current_weight_lbs and avg_protein_g > 0:
        protein_target = max(90.0, current_weight_lbs * 0.8)
        protein_component = _clamp(avg_protein_g / protein_target, 0.25, 1.05)

    calorie_component = (
        _clamp(calorie_target_adherence_pct / 100.0, 0.25, 1.05)
        if calorie_target_adherence_pct is not None else None
    )

    score = 0.45 * coverage
    remaining_weight = 0.55
    if score_component is not None:
        score += 0.25 * score_component
        remaining_weight -= 0.25
    if protein_component is not None:
        score += 0.20 * protein_component
        remaining_weight -= 0.20
    if calorie_component is not None:
        score += 0.10 * calorie_component
        remaining_weight -= 0.10
    score += max(0.0, remaining_weight) * max(coverage, protein_component or 0.55)
    score = _clamp(score, 0.35, 1.05)

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
    cardio_minutes: float = 0.0,
    zone2_minutes: float = 0.0,
    days_logged: int = 0,
    days: int = 7,
    nutrition_logging_pct: float = 0.0,
    avg_protein_g: float = 0.0,
    calorie_target_adherence_pct: float | None = None,
    protein_target_adherence_pct: float | None = None,
    weekly_nutrition_score: float | None = None,
    weight_trend_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
) -> GoalForecast:
    bucket = goal_bucket(goal)
    pace_key = _pace_key(pace)

    training_execution = _ratio(sessions_completed, sessions_planned, 0.75)
    if workout_adherence_pct > 0:
        training_execution = max(training_execution, _clamp(workout_adherence_pct / 100.0, 0.0, 1.15))

    nutrition_execution, nutrition_drivers, nutrition_limiters = _nutrition_execution(
        days_logged=days_logged,
        days=days,
        nutrition_logging_pct=nutrition_logging_pct,
        calorie_target_adherence_pct=calorie_target_adherence_pct,
        protein_target_adherence_pct=protein_target_adherence_pct,
        avg_protein_g=avg_protein_g,
        current_weight_lbs=current_weight_lbs,
        weekly_nutrition_score=weekly_nutrition_score,
    )
    recovery_execution = 1.0
    recovery_limiter = None
    if avg_sleep_hours is not None and avg_sleep_hours < 6.5:
        recovery_execution = 0.82
        recovery_limiter = f"sleep averaged {avg_sleep_hours:.1f}h"

    execution = _clamp(
        training_execution * 0.40
        + nutrition_execution * 0.45
        + recovery_execution * 0.15,
        0.35,
        1.08,
    )
    execution_pct = int(round(execution * 100))

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
    tone: ForecastTone = "success" if execution >= 0.78 else "warning" if execution < 0.58 else "neutral"

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
        if weight_trend_lbs_per_week is not None and weight_trend_lbs_per_week < 0:
            weekly_loss = min(base, abs(weight_trend_lbs_per_week) * 0.55 + base * 0.45)
        else:
            weekly_loss = base
        loss = _round1(weekly_loss * WINDOW_WEEKS * execution)
        if target_weight_lbs and current_weight_lbs:
            remaining = max(0.0, current_weight_lbs - target_weight_lbs)
            loss = min(loss, remaining) if remaining > 0 else loss
        metric_value = _fmt_lbs(loss, signed=True)
        headline = f"Estimated {metric_value} in {WINDOW_WEEKS} weeks"
        subheadline = "Fat loss forecast from goal pace, meal execution, training adherence, and weight trend."
        metric_label = "Projected scale"
        metric_detail = f"{execution_pct}% current execution"
    elif bucket == "muscle_gain":
        gain = _round1(_MUSCLE_GAIN_LBS_PER_WEEK[pace_key] * WINDOW_WEEKS * execution)
        metric_value = _fmt_lbs(gain, signed=True)
        headline = f"Estimated {metric_value} lean-gain pace in {WINDOW_WEEKS} weeks"
        subheadline = "Lean gain estimate is capped by training consistency, protein, and calorie execution."
        metric_label = "Lean-mass pace"
        metric_detail = f"{execution_pct}% current execution"
    elif bucket == "body_recomp":
        low, high = _RECOMP_FAT_LOSS_LBS_PER_WEEK[pace_key]
        fat_low = _round1(low * WINDOW_WEEKS * execution)
        fat_high = _round1(high * WINDOW_WEEKS * execution)
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
        pct = _round1(_STRENGTH_GAIN_PCT_6W[pace_key] * execution)
        metric_value = _fmt_pct(pct, signed=True)
        headline = f"Estimated {metric_value} strength marker change in {WINDOW_WEEKS} weeks"
        subheadline = "Strength forecast uses lifting adherence, nutrition support, and recovery signal."
        metric_label = "Strength marker"
        metric_detail = f"{execution_pct}% current execution"
    elif bucket in {"endurance", "hyrox"}:
        projected = int(round(cardio_minutes * WINDOW_WEEKS * max(0.65, execution)))
        z2_projected = int(round(zone2_minutes * WINDOW_WEEKS * max(0.65, execution)))
        metric_value = f"{projected} min"
        headline = f"Estimated {projected} cardio minutes in {WINDOW_WEEKS} weeks"
        subheadline = f"At this pace, about {z2_projected} min would be Zone 2."
        metric_label = "Aerobic volume"
        metric_detail = f"{execution_pct}% current execution"
    else:
        projected_days = int(round(sessions_completed * WINDOW_WEEKS * max(0.65, execution)))
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
        execution_pct=execution_pct,
        confidence=confidence,
        tone=tone,
        assumption=assumption,
        update_reason=update_reason,
        drivers=drivers[:3],
        limiters=limiters[:3],
        stats=stats[:3],
    )
