from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

from app.models import (
    DailyHealthSnapshot,
    DailyNutritionMetrics,
    HealthLabResult,
    Meal,
    MealItem,
    SleepLog,
    UserGoal,
    UserPreferences,
    UserProfile,
    WorkoutCompletion,
)


DISCLAIMER = (
    "Lifestyle-support estimate only. Thallo is not measuring hormone levels, "
    "autophagic flux, or diagnosing medical conditions."
)


@dataclass
class MealTimeEvent:
    at: datetime
    inferred: bool = False


@dataclass
class MacroDay:
    calories: float = 0.0
    protein_g: float = 0.0
    carbs_g: float = 0.0
    fat_g: float = 0.0
    meal_times: list[datetime] = field(default_factory=list)
    meal_time_events: list[MealTimeEvent] = field(default_factory=list)


@dataclass(frozen=True)
class WindowMetrics:
    today: date
    start: date
    days: int
    profile: UserProfile | None
    preferences: UserPreferences | None
    goal: UserGoal | None
    health_rows: list[DailyHealthSnapshot]
    sleep_rows: list[SleepLog]
    nutrition_rows: list[DailyNutritionMetrics]
    workouts: list[WorkoutCompletion]
    labs: list[HealthLabResult]
    macros_by_day: dict[date, MacroDay]
    data_coverage: dict[str, dict[str, Any]]
    data_used: list[str]
    missing_data: list[str]


def _finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _positive(value: Any) -> float | None:
    parsed = _finite(value)
    return parsed if parsed is not None and parsed > 0 else None


def _avg(values: list[float | int | None]) -> float | None:
    valid = [float(v) for v in values if _positive(v) is not None]
    return sum(valid) / len(valid) if valid else None


def _median(values: list[float | int | None]) -> float | None:
    valid = sorted(float(v) for v in values if _positive(v) is not None)
    if not valid:
        return None
    mid = len(valid) // 2
    return (valid[mid - 1] + valid[mid]) / 2 if len(valid) % 2 == 0 else valid[mid]


def _stddev(values: list[float | int | None]) -> float | None:
    valid = [float(v) for v in values if _positive(v) is not None]
    if len(valid) < 2:
        return None
    mean = sum(valid) / len(valid)
    return math.sqrt(sum((v - mean) ** 2 for v in valid) / len(valid))


def _clamp(value: float, low: float = 0, high: float = 100) -> int:
    return int(round(max(low, min(high, value))))


def _enum_value(value: Any) -> str:
    raw = getattr(value, "value", value)
    return str(raw or "").strip().lower()


def _quality(present: int, target: int) -> str:
    if present <= 0:
        return "missing"
    ratio = present / max(1, target)
    if ratio >= 0.75:
        return "high"
    if ratio >= 0.45:
        return "medium"
    return "low"


def _confidence_from_signal_count(count: int) -> str:
    if count >= 7:
        return "high"
    if count >= 4:
        return "medium"
    return "low"


def _support_label(score: int, confidence: str) -> str:
    if confidence == "low":
        return "Building baseline"
    if score >= 76:
        return "High support"
    if score >= 61:
        return "Supportive"
    if score >= 45:
        return "Neutral"
    return "Strained"


def _cortisol_label(score: int, confidence: str) -> str:
    if confidence == "low":
        return "Building baseline"
    if score >= 76:
        return "High load"
    if score >= 58:
        return "Elevated"
    if score >= 38:
        return "Moderate"
    return "Low load"


def _evening_stress_label(score: int, confidence: str) -> str:
    if confidence == "low":
        return "Building baseline"
    if score >= 76:
        return "High evening load"
    if score >= 58:
        return "Elevated evening load"
    if score >= 38:
        return "Moderate evening load"
    return "Downshift supported"


def _wake_peak_label(score: int, confidence: str) -> str:
    if confidence == "low":
        return "Building baseline"
    if score >= 76:
        return "Strong wake support"
    if score >= 58:
        return "Supported wake peak"
    if score >= 40:
        return "Neutral wake support"
    return "Blunted-risk"


def _autophagy_label(score: int, confidence: str) -> str:
    if confidence == "low":
        return "Building baseline"
    if score >= 76:
        return "High opportunity"
    if score >= 58:
        return "Elevated"
    if score >= 38:
        return "Transition"
    return "Low opportunity"


def _status_from_support(score: int, confidence: str) -> str:
    if confidence == "low":
        return "unknown"
    if score >= 76:
        return "high"
    if score >= 61:
        return "moderate"
    if score >= 45:
        return "watch"
    return "low"


def _status_from_load(score: int, confidence: str) -> str:
    if confidence == "low":
        return "unknown"
    if score >= 76:
        return "high"
    if score >= 58:
        return "elevated"
    if score >= 38:
        return "moderate"
    return "low"


def _pct(value: float | None) -> str:
    if value is None:
        return ""
    return f"{int(round(value))}%"


def _trend_pct(value: float | None) -> str:
    if value is None:
        return ""
    return f"{abs(value) * 100:.0f}%"


def _signed_trend_pct(value: float | None) -> str:
    if value is None:
        return ""
    return f"{value * 100:+.0f}%"


def _hour_label(hour: float | None) -> str:
    if hour is None:
        return ""
    safe_hour = max(0.0, min(23.99, float(hour)))
    whole = int(safe_hour)
    minute = int(round((safe_hour - whole) * 60))
    if minute == 60:
        whole = (whole + 1) % 24
        minute = 0
    suffix = "AM" if whole < 12 else "PM"
    display_hour = whole % 12 or 12
    return f"{display_hour}:{minute:02d} {suffix}"


def _meal_time_fallback(meal: Meal) -> datetime:
    hour = {
        "breakfast": 8,
        "lunch": 12,
        "snack": 15,
        "pre_workout": 16,
        "post_workout": 19,
        "dinner": 18,
    }.get(_enum_value(meal.meal_type), 12)
    return datetime.combine(meal.meal_date, time(hour=hour), tzinfo=timezone.utc)


def _lab_keys(rows: list[HealthLabResult]) -> set[str]:
    return {str(row.lab_type or "").lower() for row in rows}


def _latest_labs(rows: list[HealthLabResult]) -> dict[str, HealthLabResult]:
    out: dict[str, HealthLabResult] = {}
    for row in sorted(rows, key=lambda r: r.collected_at, reverse=True):
        key = str(row.lab_type or "").lower()
        if key and key not in out:
            out[key] = row
    return out


def _query_window(db: Session, user_id: int, days: int) -> WindowMetrics:
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)
    profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    preferences = db.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
    goal = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
        .order_by(UserGoal.created_at.desc())
    ).first()
    health_rows = list(db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date >= start)
        .where(DailyHealthSnapshot.snapshot_date <= today)
        .order_by(DailyHealthSnapshot.snapshot_date.asc())
    ).all())
    sleep_rows = list(db.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(SleepLog.night_date >= start)
        .where(SleepLog.night_date <= today)
        .order_by(SleepLog.night_date.asc())
    ).all())
    nutrition_rows = list(db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= start)
        .where(DailyNutritionMetrics.metric_date <= today)
        .order_by(DailyNutritionMetrics.metric_date.asc())
    ).all())
    workouts = list(db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= start)
        .where(WorkoutCompletion.workout_date <= today)
        .order_by(WorkoutCompletion.workout_date.asc(), WorkoutCompletion.id.asc())
    ).all())
    labs = list(db.exec(
        select(HealthLabResult)
        .where(HealthLabResult.user_id == user_id)
        .where(HealthLabResult.collected_at >= datetime.combine(start - timedelta(days=365), time.min, tzinfo=timezone.utc))
        .order_by(HealthLabResult.collected_at.desc())
    ).all())

    macros_by_day: dict[date, MacroDay] = defaultdict(MacroDay)
    meal_rows = db.exec(
        select(Meal, MealItem)
        .join(MealItem, MealItem.meal_id == Meal.id)
        .where(Meal.user_id == user_id)
        .where(Meal.meal_date >= start)
        .where(Meal.meal_date <= today)
    ).all()
    meal_events: dict[int, Meal] = {}
    meal_event_calories: dict[int, float] = defaultdict(float)
    for meal, item in meal_rows:
        day = macros_by_day[meal.meal_date]
        item_calories = float(item.calories or 0)
        day.calories += item_calories
        day.protein_g += float(item.protein_g or 0)
        day.carbs_g += float(item.carbs_g or 0)
        day.fat_g += float(item.fat_g or 0)
        if meal.id is not None:
            meal_id = int(meal.id)
            meal_events[meal_id] = meal
            meal_event_calories[meal_id] += item_calories
    for meal_id, meal in meal_events.items():
        if meal_event_calories[meal_id] <= 0:
            continue
        consumed_at = meal.consumed_at
        inferred = consumed_at is None
        if consumed_at is None:
            consumed_at = _meal_time_fallback(meal)
        elif consumed_at.tzinfo is None:
            consumed_at = consumed_at.replace(tzinfo=timezone.utc)
        macros_by_day[meal.meal_date].meal_times.append(consumed_at)
        macros_by_day[meal.meal_date].meal_time_events.append(MealTimeEvent(consumed_at, inferred))
    for day in macros_by_day.values():
        day.meal_times.sort()
        day.meal_time_events.sort(key=lambda event: event.at)

    days_with_meal_timing = len([d for d in macros_by_day.values() if d.meal_times])
    exact_meal_timestamps = sum(1 for d in macros_by_day.values() for event in d.meal_time_events if not event.inferred)
    inferred_meal_timestamps = sum(1 for d in macros_by_day.values() for event in d.meal_time_events if event.inferred)
    meal_timing_quality = _quality(days_with_meal_timing, max(5, min(days, 10)))
    meal_timestamp_total = exact_meal_timestamps + inferred_meal_timestamps
    if meal_timestamp_total and exact_meal_timestamps == 0:
        meal_timing_quality = "low"
    elif meal_timestamp_total and inferred_meal_timestamps / meal_timestamp_total > 0.5 and meal_timing_quality == "high":
        meal_timing_quality = "medium"

    data_used: list[str] = []
    missing_data: list[str] = []
    if profile:
        data_used.append("age/sex/body size")
    else:
        missing_data.append("profile body stats")
    if health_rows:
        data_used.append("Apple Health daily vitals/activity")
    else:
        missing_data.append("Apple Health vitals/history")
    if sleep_rows:
        data_used.append("sleep history")
    else:
        missing_data.append("sleep history")
    if nutrition_rows or macros_by_day:
        data_used.append("logged nutrition")
    else:
        missing_data.append("logged nutrition")
    if workouts:
        data_used.append("workout history")
    else:
        missing_data.append("workout history")
    if labs:
        data_used.append("optional labs")
    else:
        missing_data.append("optional labs")

    data_coverage = {
        "nutrition": {
            "label": "Nutrition",
            "window_days": days,
            "days_with_data": len([d for d in macros_by_day.values() if d.calories > 0]) or len(nutrition_rows),
            "quality": _quality(len([d for d in macros_by_day.values() if d.calories > 0]) or len(nutrition_rows), max(7, min(days, 14))),
        },
        "sleep": {
            "label": "Sleep",
            "window_days": days,
            "days_with_data": len([r for r in sleep_rows if _positive(r.total_hours) is not None or r.score is not None]),
            "quality": _quality(len([r for r in sleep_rows if _positive(r.total_hours) is not None or r.score is not None]), max(7, min(days, 14))),
        },
        "health": {
            "label": "Wearable vitals",
            "window_days": days,
            "days_with_data": len(health_rows),
            "quality": _quality(len(health_rows), max(10, min(days, 21))),
        },
        "activity": {
            "label": "Activity",
            "window_days": days,
            "records": len(workouts),
            "quality": _quality(len(workouts), max(3, round(days / 7) * 3)),
        },
        "meal_timing": {
            "label": "Meal timing",
            "window_days": days,
            "days_with_data": days_with_meal_timing,
            "exact_timestamps": exact_meal_timestamps,
            "inferred_timestamps": inferred_meal_timestamps,
            "quality": meal_timing_quality,
        },
        "labs": {
            "label": "Labs",
            "records": len(labs),
            "quality": "high" if labs else "missing",
        },
    }

    return WindowMetrics(
        today=today,
        start=start,
        days=days,
        profile=profile,
        preferences=preferences,
        goal=goal,
        health_rows=health_rows,
        sleep_rows=sleep_rows,
        nutrition_rows=nutrition_rows,
        workouts=workouts,
        labs=labs,
        macros_by_day=dict(macros_by_day),
        data_coverage=data_coverage,
        data_used=data_used,
        missing_data=missing_data,
    )


def _health_values(ctx: WindowMetrics, field: str) -> list[float]:
    return [
        float(v)
        for row in ctx.health_rows
        if (v := _positive(getattr(row, field, None))) is not None
    ]


def _sleep_values(ctx: WindowMetrics, field: str) -> list[float]:
    return [
        float(v)
        for row in ctx.sleep_rows
        if (v := _positive(getattr(row, field, None))) is not None
    ]


def _macro_values(ctx: WindowMetrics, field: str) -> list[float]:
    return [
        float(v)
        for day in ctx.macros_by_day.values()
        if (v := _positive(getattr(day, field, None))) is not None
    ]


def _recent_trend(values: list[float]) -> float | None:
    if len(values) < 6:
        return None
    split = max(3, len(values) // 2)
    early = _avg(values[:split])
    late = _avg(values[split:])
    if early is None or late is None or early <= 0:
        return None
    return (late - early) / early


def _weight_slope_lbs_per_week(ctx: WindowMetrics) -> float | None:
    rows = [row for row in ctx.health_rows if _positive(row.weight_lbs) is not None]
    if len(rows) < 2:
        return None
    first = rows[0]
    last = rows[-1]
    span = max(1, (last.snapshot_date - first.snapshot_date).days)
    return ((float(last.weight_lbs or 0) - float(first.weight_lbs or 0)) / span) * 7


def _body_weight_lbs(ctx: WindowMetrics) -> float | None:
    latest = next((row.weight_lbs for row in reversed(ctx.health_rows) if _positive(row.weight_lbs) is not None), None)
    return _positive(latest) or _positive(getattr(ctx.profile, "weight_lbs", None))


def _daily_fat_pct(ctx: WindowMetrics) -> list[float]:
    values: list[float] = []
    for day in ctx.macros_by_day.values():
        if day.calories > 0:
            values.append((day.fat_g * 9 / day.calories) * 100)
    return values


def _daily_carbs_per_lb(ctx: WindowMetrics) -> list[float]:
    weight = _body_weight_lbs(ctx)
    if not weight:
        return []
    return [day.carbs_g / weight for day in ctx.macros_by_day.values() if day.carbs_g > 0]


def _daily_protein_per_lb(ctx: WindowMetrics) -> list[float]:
    weight = _body_weight_lbs(ctx)
    if not weight:
        return []
    return [day.protein_g / weight for day in ctx.macros_by_day.values() if day.protein_g > 0]


def _energy_availability(ctx: WindowMetrics) -> list[float]:
    return [
        float(row.energy_availability)
        for row in ctx.nutrition_rows
        if _positive(row.energy_availability) is not None
    ]


def _calorie_cv(ctx: WindowMetrics) -> float | None:
    calories = _macro_values(ctx, "calories")
    if len(calories) < 5:
        return None
    avg = _avg(calories)
    sd = _stddev(calories)
    if avg is None or sd is None or avg <= 0:
        return None
    return sd / avg


def _strength_workout_count(ctx: WindowMetrics) -> int:
    return len([workout for workout in ctx.workouts if _is_strength_activity(workout)])


def _hard_workout_count(ctx: WindowMetrics) -> int:
    return len([workout for workout in ctx.workouts if _is_stressful_activity(workout)])


def _activity_text(workout: WorkoutCompletion) -> str:
    return " ".join(str(v or "").lower() for v in (
        workout.focus_label,
        workout.stimulus,
        workout.activity_category,
        workout.activity_subtype,
        workout.activity_intensity,
        workout.cardio_style,
    ))


def _is_strength_activity(workout: WorkoutCompletion) -> bool:
    category = str(workout.activity_category or "").lower()
    subtype = str(workout.activity_subtype or "").lower()
    text = _activity_text(workout)
    if category == "strength":
        return True
    return any(token in text for token in (
        "strength", "hypertrophy", "push", "pull", "legs", "upper",
        "lower", "full_body", "lift", "barbell", "dumbbell",
    )) or subtype in {"push", "pull", "legs", "upper_body", "lower_body", "full_body"}


def _is_intense_cardio_activity(workout: WorkoutCompletion) -> bool:
    category = str(workout.activity_category or "").lower()
    subtype = str(workout.activity_subtype or "").lower()
    intensity = str(workout.activity_intensity or "").lower()
    cardio_style = str(workout.cardio_style or "").lower()
    text = _activity_text(workout)
    if category != "cardio" and not any(token in text for token in ("hiit", "interval", "conditioning", "bootcamp")):
        return False
    return (
        intensity == "hard"
        or cardio_style == "intervals"
        or subtype in {"hiit", "bootcamp", "stair"}
        or any(token in text for token in ("hiit", "interval", "conditioning", "threshold"))
    )


def _is_steady_cardio_activity(workout: WorkoutCompletion) -> bool:
    category = str(workout.activity_category or "").lower()
    subtype = str(workout.activity_subtype or "").lower()
    intensity = str(workout.activity_intensity or "").lower()
    cardio_style = str(workout.cardio_style or "").lower()
    if _is_recovery_activity(workout) or _is_intense_cardio_activity(workout):
        return False
    if category != "cardio" and subtype not in {"walk", "run", "ride", "hike", "swim", "row", "elliptical", "spin"}:
        return False
    return cardio_style in {"", "steady", "recovery"} or intensity in {"", "easy", "moderate"}


def _is_active_or_sport_stressor(workout: WorkoutCompletion) -> bool:
    category = str(workout.activity_category or "").lower()
    intensity = str(workout.activity_intensity or "").lower()
    subtype = str(workout.activity_subtype or "").lower()
    if _is_recovery_activity(workout):
        return False
    if category not in {"sport", "active"}:
        return False
    if category == "sport" and subtype == "golf" and intensity in {"", "easy"}:
        return False
    return intensity != "easy" or (workout.duration_seconds or 0) >= 3600


def _is_recovery_activity(workout: WorkoutCompletion) -> bool:
    category = str(workout.activity_category or "").lower()
    subtype = str(workout.activity_subtype or "").lower()
    intensity = str(workout.activity_intensity or "").lower()
    cardio_style = str(workout.cardio_style or "").lower()
    text = _activity_text(workout)
    if category == "recovery":
        return True
    if category == "mobility" and intensity != "hard":
        return True
    if category == "cardio" and subtype == "walk" and intensity in {"", "easy"}:
        return True
    if cardio_style == "recovery":
        return True
    return any(token in text for token in (
        "recovery", "recover", "mobility", "stretch", "foam", "yoga",
        "pilates", "breathwork", "meditation", "sauna", "cold_plunge",
        "contrast", "sleep", "restorative",
    ))


def _is_stressful_activity(workout: WorkoutCompletion) -> bool:
    if _is_recovery_activity(workout):
        return False
    category = str(workout.activity_category or "").lower()
    subtype = str(workout.activity_subtype or "").lower()
    intensity = str(workout.activity_intensity or "").lower()
    cardio_style = str(workout.cardio_style or "").lower()
    text = _activity_text(workout)
    if intensity == "hard":
        return True
    if _is_intense_cardio_activity(workout):
        return True
    if any(token in text for token in ("strength", "hypertrophy", "conditioning", "hard", "hiit", "interval")):
        return True
    if category in {"strength", "sport", "active"} and intensity != "easy":
        return True
    return (workout.duration_seconds or 0) >= 3600 and intensity != "easy"


def _activity_mix(ctx: WindowMetrics) -> dict[str, float]:
    counts = {
        "heavy_strength_sessions": 0,
        "steady_cardio_sessions": 0,
        "intense_cardio_sessions": 0,
        "recovery_sessions": 0,
        "active_sport_stress_sessions": 0,
        "easy_walk_sessions": 0,
    }
    minutes = {
        "heavy_strength_minutes": 0.0,
        "steady_cardio_minutes": 0.0,
        "intense_cardio_minutes": 0.0,
        "recovery_minutes": 0.0,
        "active_sport_stress_minutes": 0.0,
    }
    for workout in ctx.workouts:
        duration_min = max(0.0, float(workout.duration_seconds or 0) / 60)
        category = str(workout.activity_category or "").lower()
        subtype = str(workout.activity_subtype or "").lower()
        intensity = str(workout.activity_intensity or "").lower()
        if _is_recovery_activity(workout):
            counts["recovery_sessions"] += 1
            minutes["recovery_minutes"] += duration_min
            if category == "cardio" and subtype == "walk" and intensity in {"", "easy"}:
                counts["easy_walk_sessions"] += 1
            continue
        if _is_intense_cardio_activity(workout):
            counts["intense_cardio_sessions"] += 1
            minutes["intense_cardio_minutes"] += duration_min
            continue
        if _is_strength_activity(workout):
            counts["heavy_strength_sessions"] += 1
            minutes["heavy_strength_minutes"] += duration_min
            continue
        if _is_steady_cardio_activity(workout):
            counts["steady_cardio_sessions"] += 1
            minutes["steady_cardio_minutes"] += duration_min
            continue
        if _is_active_or_sport_stressor(workout):
            counts["active_sport_stress_sessions"] += 1
            minutes["active_sport_stress_minutes"] += duration_min

    week_multiplier = 7 / max(1, ctx.days)
    return {
        **{f"{key}_per_week": value * week_multiplier for key, value in counts.items()},
        **{f"{key}_per_week": value * week_multiplier for key, value in minutes.items()},
    }


def _is_late_activity(workout: WorkoutCompletion) -> bool:
    ended = workout.ended_at or workout.completed_at or workout.started_at
    if not ended:
        return False
    if ended.tzinfo is None:
        ended = ended.replace(tzinfo=timezone.utc)
    return ended.hour >= 20 or ended.hour <= 3


def _late_stressor_workout_count(ctx: WindowMetrics) -> int:
    count = 0
    for workout in ctx.workouts:
        if _is_late_activity(workout) and _is_stressful_activity(workout):
            count += 1
    return count


def _late_recovery_activity_count(ctx: WindowMetrics) -> int:
    count = 0
    for workout in ctx.workouts:
        if _is_late_activity(workout) and _is_recovery_activity(workout):
            count += 1
    return count


def _morning_workout_count(ctx: WindowMetrics) -> int:
    count = 0
    for workout in ctx.workouts:
        started = workout.started_at or workout.completed_at
        if not started:
            continue
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if 4 <= started.hour <= 10:
            count += 1
    return count


def _hour_float(value: datetime) -> float:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.hour + value.minute / 60


def _meal_timing_metrics(ctx: WindowMetrics) -> dict[str, Any]:
    first_hours: list[float] = []
    last_hours: list[float] = []
    late_days = 0
    early_days = 0
    for day in ctx.macros_by_day.values():
        if not day.meal_times:
            continue
        first = _hour_float(day.meal_times[0])
        last = _hour_float(day.meal_times[-1])
        first_hours.append(first)
        last_hours.append(last)
        if first <= 9.5:
            early_days += 1
        if last >= 21:
            late_days += 1
    return {
        "avg_first_calorie_hour": _avg(first_hours),
        "avg_last_calorie_hour": _avg(last_hours),
        "late_calorie_days": late_days,
        "early_calorie_days": early_days,
    }


def _meal_time_events(ctx: WindowMetrics) -> list[MealTimeEvent]:
    events: list[MealTimeEvent] = []
    for day in ctx.macros_by_day.values():
        if day.meal_time_events:
            events.extend(day.meal_time_events)
        else:
            events.extend(MealTimeEvent(at=t, inferred=False) for t in day.meal_times)
    return sorted(events, key=lambda event: event.at)


def _fasting_metrics(ctx: WindowMetrics) -> dict[str, Any]:
    events = _meal_time_events(ctx)
    daily_gap_by_end_day: dict[date, list[float]] = defaultdict(list)
    for prev, nxt in zip(events, events[1:]):
        gap_hours = max(0.0, (nxt.at - prev.at).total_seconds() / 3600)
        end_day = nxt.at.date()
        if ctx.start <= end_day <= ctx.today:
            daily_gap_by_end_day[end_day].append(gap_hours)
    daily_gaps = [max(gaps) for gaps in daily_gap_by_end_day.values() if gaps]

    current_fast_hours = None
    current_fast_stale = False
    latest_calorie_at = events[-1].at if events else None
    if latest_calorie_at is not None:
        now = datetime.now(timezone.utc)
        raw_current_fast_hours = max(0.0, (now - latest_calorie_at).total_seconds() / 3600)
        if raw_current_fast_hours <= 36:
            current_fast_hours = raw_current_fast_hours
        else:
            current_fast_stale = True
    all_gaps = [
        max(0.0, (nxt.at - prev.at).total_seconds() / 3600)
        for prev, nxt in zip(events, events[1:])
    ]
    inferred_count = len([event for event in events if event.inferred])
    exact_count = len(events) - inferred_count
    return {
        "days_with_timing": len({event.at.date() for event in events}),
        "avg_longest_daily_fast_hours": _avg(daily_gaps),
        "max_gap_hours": max(all_gaps) if all_gaps else None,
        "current_fast_hours": current_fast_hours,
        "current_fast_stale": current_fast_stale,
        "exact_timestamp_count": exact_count,
        "inferred_timestamp_count": inferred_count,
        "inferred_timestamp_ratio": (inferred_count / len(events)) if events else 0.0,
    }


def _estimate(
    *,
    key: str,
    title: str,
    score: int,
    label: str,
    status: str,
    risk_direction: str,
    confidence: str,
    summary: str,
    drivers: list[str],
    positive_factors: list[str],
    limiting_factors: list[str],
    recommendations: list[str],
    data_used: list[str],
    missing_data: list[str],
    window_days: int,
) -> dict[str, Any]:
    return {
        "key": key,
        "title": title,
        "score": score,
        "label": label,
        "status": status,
        "risk_direction": risk_direction,
        "confidence": confidence,
        "summary": summary,
        "drivers": drivers[:5],
        "positive_factors": positive_factors[:5],
        "limiting_factors": limiting_factors[:5],
        "recommendations": recommendations[:4],
        "data_used": data_used,
        "missing_data": missing_data[:6],
        "window_days": window_days,
        "disclaimer": DISCLAIMER,
    }


def _shared_metrics(ctx: WindowMetrics) -> dict[str, Any]:
    sleep_hours = _sleep_values(ctx, "total_hours")
    sleep_scores = [float(row.score) for row in ctx.sleep_rows if row.score is not None]
    hrv_values = _health_values(ctx, "hrv_ms") or _sleep_values(ctx, "hrv_ms")
    rhr_values = _health_values(ctx, "resting_hr") or _sleep_values(ctx, "resting_hr")
    resp_values = _health_values(ctx, "respiratory_rate") or _sleep_values(ctx, "respiratory_rate")
    spo2_values = _health_values(ctx, "oxygen_saturation") or _sleep_values(ctx, "spo2_percent")
    breathing_elevated = len([
        row for row in ctx.health_rows
        if bool(getattr(row, "sleep_breathing_disturbances_elevated", False))
    ])
    active_energy = _health_values(ctx, "active_energy_kcal")
    steps = _health_values(ctx, "steps")
    zone2 = _health_values(ctx, "zone2_minutes")
    cardio = _health_values(ctx, "cardio_minutes")
    workout_minutes = _health_values(ctx, "workout_minutes")
    macros_days = [day for day in ctx.macros_by_day.values() if day.calories > 0]
    nutrition_days = len(macros_days) or len(ctx.nutrition_rows)
    avg_calories = _avg([day.calories for day in macros_days])
    avg_fat_pct = _avg(_daily_fat_pct(ctx))
    avg_protein_per_lb = _avg(_daily_protein_per_lb(ctx))
    avg_carbs_per_lb = _avg(_daily_carbs_per_lb(ctx))
    ea_values = _energy_availability(ctx)
    avg_ea = _avg(ea_values)
    alcohol_days = len([row for row in ctx.nutrition_rows if _positive(row.alcohol_servings) is not None])
    micronutrient_days = len([row for row in ctx.nutrition_rows if (row.micronutrient_item_count or 0) > 0])
    weight_slope = _weight_slope_lbs_per_week(ctx)
    weight = _body_weight_lbs(ctx)
    pct_weight_change_per_week = (weight_slope / weight * 100) if weight and weight_slope is not None else None
    fast = _fasting_metrics(ctx)
    lab_keys = _lab_keys(ctx.labs)
    hormone_lab_keys = {
        "total_testosterone", "free_testosterone", "shbg", "estradiol",
        "progesterone", "lh", "fsh", "prolactin", "cortisol", "dhea_s",
        "tsh", "free_t3", "free_t4",
    }
    meal_timing = _meal_timing_metrics(ctx)
    bedtime_sd = _stddev([row.bedtime_minutes_from_midnight for row in ctx.sleep_rows])
    strength_count = _strength_workout_count(ctx)
    hard_count = _hard_workout_count(ctx)
    activity_mix = _activity_mix(ctx)
    week_multiplier = 7 / max(1, ctx.days)
    return {
        "avg_sleep_hours": _avg(sleep_hours),
        "avg_sleep_score": _avg(sleep_scores),
        "sleep_nights": len(sleep_hours) or len(sleep_scores),
        "bedtime_sd_min": bedtime_sd,
        "avg_hrv": _avg(hrv_values),
        "hrv_trend": _recent_trend(hrv_values),
        "avg_rhr": _avg(rhr_values),
        "rhr_trend": _recent_trend(rhr_values),
        "avg_resp": _avg(resp_values),
        "avg_spo2": _avg(spo2_values),
        "breathing_elevated_days": breathing_elevated,
        "health_days": len(ctx.health_rows),
        "avg_steps": _avg(steps),
        "avg_active_energy": _avg(active_energy),
        "zone2_min_per_week": (sum(zone2) * week_multiplier) if zone2 else None,
        "cardio_min_per_week": (sum(cardio) * week_multiplier) if cardio else None,
        "workout_min_per_week": (sum(workout_minutes) * week_multiplier) if workout_minutes else None,
        "strength_per_week": strength_count * week_multiplier,
        "hard_per_week": hard_count * week_multiplier,
        "late_stressor_workouts": _late_stressor_workout_count(ctx),
        "late_recovery_activities": _late_recovery_activity_count(ctx),
        "morning_workouts": _morning_workout_count(ctx),
        "nutrition_days": nutrition_days,
        "avg_calories": avg_calories,
        "avg_fat_pct": avg_fat_pct,
        "avg_protein_per_lb": avg_protein_per_lb,
        "avg_carbs_per_lb": avg_carbs_per_lb,
        "avg_energy_availability": avg_ea,
        "calorie_cv": _calorie_cv(ctx),
        "alcohol_days": alcohol_days,
        "micronutrient_days": micronutrient_days,
        "weight_slope_lbs_per_week": weight_slope,
        "pct_weight_change_per_week": pct_weight_change_per_week,
        "fasting": fast,
        "meal_timing": meal_timing,
        "activity_mix": activity_mix,
        "hormone_lab_count": len(lab_keys.intersection(hormone_lab_keys)),
        "latest_labs": _latest_labs(ctx.labs),
    }


def _confidence_for(ctx: WindowMetrics, metrics: dict[str, Any], required: list[str]) -> str:
    count = 0
    if "sleep" in required and metrics["sleep_nights"] >= 5:
        count += 2
    if "health" in required and metrics["health_days"] >= 7:
        count += 2
    if "nutrition" in required and metrics["nutrition_days"] >= 5:
        count += 2
    if "activity" in required and len(ctx.workouts) >= 2:
        count += 1
    if "profile" in required and ctx.profile is not None:
        count += 1
    if "meal_timing" in required and metrics["fasting"]["days_with_timing"] >= 3:
        count += 1
    if metrics["hormone_lab_count"] > 0:
        count += 1
    return _confidence_from_signal_count(count)


def _testosterone_support(ctx: WindowMetrics, metrics: dict[str, Any]) -> dict[str, Any]:
    score = 50.0
    pos: list[str] = []
    lim: list[str] = []
    recs: list[str] = []
    used: list[str] = []
    missing: list[str] = []

    sleep = metrics["avg_sleep_hours"]
    if sleep is not None:
        used.append("sleep duration")
        if sleep >= 7.25:
            score += 15; pos.append(f"You're averaging {sleep:.1f}h sleep, which clears the 7.25h support threshold.")
        elif sleep >= 6.5:
            score += 7; pos.append(f"You're averaging {sleep:.1f}h sleep, which is workable but below the stronger 7.25h support mark.")
        else:
            score -= 15; lim.append(f"You're averaging {sleep:.1f}h sleep; this hurts support because it's below 6.5h.")
            recs.append("Set a 7.5-9h sleep opportunity for the next 7 nights; keep wake time within 60 min.")
    else:
        missing.append("sleep duration")

    bedtime_sd = metrics["bedtime_sd_min"]
    if bedtime_sd is not None:
        used.append("sleep timing consistency")
        if bedtime_sd <= 75:
            score += 5; pos.append(f"Your bedtime timing varies about {bedtime_sd:.0f} min, inside the <=75 min consistency target.")
        elif bedtime_sd >= 150:
            score -= 4; lim.append(f"Your bedtime timing varies about {bedtime_sd:.0f} min, which is well above the 150 min strain threshold.")

    mix = metrics["activity_mix"]
    strength_per_week = mix["heavy_strength_sessions_per_week"] or metrics["strength_per_week"]
    used.append("strength training frequency")
    if 2 <= strength_per_week <= 5:
        score += 12; pos.append(f"You're logging {strength_per_week:.1f} heavy strength sessions/week, inside the 2-5/week support range.")
    elif strength_per_week > 5:
        score -= 3; lim.append(f"You're logging {strength_per_week:.1f} heavy strength sessions/week; above 5/week adds recovery demand.")
    elif strength_per_week > 0:
        score += 3; lim.append(f"You're logging {strength_per_week:.1f} heavy strength sessions/week, below the 2/week support target.")
    else:
        score -= 8; lim.append("You have 0 recent heavy strength sessions logged, so this signal misses the lifting support input.")
        recs.append("Schedule 2-4 progressive strength sessions/week, with at least 1 lower-load day after hard lower-body work.")

    if mix["intense_cardio_sessions_per_week"] >= 3:
        used.append("HIIT / interval frequency")
        score -= 4
        lim.append(f"You're doing {mix['intense_cardio_sessions_per_week']:.1f} HIIT/interval sessions/week; >=3/week raises recovery demand.")
        recs.append("Cap HIIT/interval work at 1-2 sessions/week and separate hard days by at least 48h.")
    if mix["recovery_sessions_per_week"] >= 2:
        used.append("recovery activity frequency")
        score += 2
        pos.append(f"You're logging {mix['recovery_sessions_per_week']:.1f} recovery sessions/week alongside training.")

    protein = metrics["avg_protein_per_lb"]
    if protein is not None:
        used.append("protein per bodyweight")
        if protein >= 0.70:
            score += 8; pos.append(f"You're averaging {protein:.2f} g/lb protein, clearing the 0.70 g/lb recovery threshold.")
        elif protein >= 0.55:
            score += 3; pos.append(f"You're averaging {protein:.2f} g/lb protein; adequate, but below the stronger 0.70 g/lb support mark.")
        else:
            score -= 8; lim.append(f"You're averaging {protein:.2f} g/lb protein, below the 0.55 g/lb recovery floor.")
            recs.append("Hit the plan protein target; if no target is available, use about 0.7-1.0 g/lb/day.")
    else:
        missing.append("protein/bodyweight")

    fat_pct = metrics["avg_fat_pct"]
    if fat_pct is not None:
        used.append("dietary fat percentage")
        if fat_pct >= 20:
            score += 8; pos.append(f"You're getting {_pct(fat_pct)} of calories from fat, above the 20% support floor.")
        elif fat_pct >= 15:
            score -= 4; lim.append(f"You're getting {_pct(fat_pct)} of calories from fat; that's below the 20% support floor.")
        else:
            score -= 12; lim.append(f"You're getting {_pct(fat_pct)} of calories from fat, below the 15% low-fat threshold.")
            recs.append("Raise dietary fat to at least 20% of calories with whole-food fats across a couple of meals.")
    else:
        missing.append("dietary fat trend")

    ea = metrics["avg_energy_availability"]
    if ea is not None:
        used.append("energy availability")
        if ea >= 35:
            score += 10; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, above the 35 robust-support mark.")
        elif ea >= 30:
            score += 4; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, above the 30 minimum support mark.")
        elif ea >= 25:
            score -= 8; lim.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM; that's borderline because it's below 30.")
            recs.append("On hard days, add 200-300 kcal or swap one hard session to Zone 2/recovery until energy availability is >=30.")
        else:
            score -= 18; lim.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, below the 25 high-strain line.")
            recs.append("For 7 days, pause aggressive deficit: add 300-500 kcal/day or reduce training until energy availability is >=30.")
    else:
        missing.append("energy availability")

    pct_weight = metrics["pct_weight_change_per_week"]
    if pct_weight is not None:
        used.append("weight trend")
        if pct_weight < -1.0:
            score -= 12; lim.append(f"Your weight is falling about {abs(pct_weight):.1f}%/week, above the 1%/week rapid-loss strain line.")
            recs.append("Slow weight loss to <=1% body weight/week by adding calories or reducing extra cardio.")
        elif pct_weight < -0.5:
            score -= 5; lim.append(f"Your weight is falling about {abs(pct_weight):.1f}%/week, which adds mild endocrine strain.")
            recs.append("Keep the deficit modest enough that weekly loss stays near 0.5-1.0% of body weight.")
        elif -0.25 <= pct_weight <= 0.75:
            score += 4; pos.append(f"Your weight trend is stable at about {pct_weight:+.1f}%/week.")

    hrv_trend = metrics["hrv_trend"]
    rhr_trend = metrics["rhr_trend"]
    if hrv_trend is not None:
        used.append("HRV trend")
        if hrv_trend >= -0.05:
            score += 4; pos.append(f"Your HRV trend is stable at {_signed_trend_pct(hrv_trend)} vs baseline.")
        elif hrv_trend <= -0.12:
            score -= 7; lim.append(f"Your HRV is trending down about {_trend_pct(hrv_trend)}, which points to recovery strain.")
    if rhr_trend is not None:
        used.append("resting HR trend")
        if rhr_trend <= 0.03:
            score += 3; pos.append(f"Your resting HR trend is steady at {_signed_trend_pct(rhr_trend)} vs baseline.")
        elif rhr_trend >= 0.08:
            score -= 7; lim.append(f"Your resting HR is trending up about {_trend_pct(rhr_trend)}, which points to recovery strain.")

    if metrics["breathing_elevated_days"] > 0:
        used.append("sleep breathing disturbance flags")
        score -= min(10, 4 + metrics["breathing_elevated_days"] * 2)
        lim.append(f"You have {metrics['breathing_elevated_days']} elevated sleep-breathing disturbance day(s) in this window.")
        recs.append("Sleep-breathing flags should be reviewed in Apple Health and with a clinician if persistent.")
    elif metrics["avg_spo2"] is not None and metrics["avg_spo2"] < 94:
        used.append("sleep oxygen saturation")
        score -= 6
        lim.append(f"Your average sleep SpO2 is {metrics['avg_spo2']:.1f}%, below the 94% watch line.")

    if metrics["alcohol_days"] >= max(2, round(ctx.days / 7)):
        used.append("alcohol servings")
        score -= 5
        lim.append(f"You logged alcohol on {metrics['alcohol_days']} day(s) in this nutrition window.")
        recs.append("Keep alcohol to 0-1 servings on training nights and avoid it inside the 3h pre-bed window.")

    confidence = _confidence_for(ctx, metrics, ["profile", "sleep", "health", "nutrition", "activity"])
    score_i = _clamp(score)
    label = _support_label(score_i, confidence)
    summary = (
        "Conditions look supportive for normal testosterone signaling."
        if score_i >= 61 else
        "Recovery, fueling, or stress signals are limiting the testosterone-support environment."
    )
    if confidence == "low":
        summary = "More sleep, nutrition, and wearable history is needed before Thallo can make this estimate specific."
    return _estimate(
        key="testosterone_support",
        title="Testosterone support",
        score=score_i,
        label=label,
        status=_status_from_support(score_i, confidence),
        risk_direction="higher_is_better",
        confidence=confidence,
        summary=summary,
        drivers=(pos + lim),
        positive_factors=pos,
        limiting_factors=lim,
        recommendations=recs or [
            "Hold 7.5-9h sleep, 2-4 strength days/week, protein ~0.7-1.0 g/lb/day, fat >=20%, and weight loss <=1%/week."
        ],
        data_used=used,
        missing_data=missing,
        window_days=ctx.days,
    )


def _estrogen_support(ctx: WindowMetrics, metrics: dict[str, Any]) -> dict[str, Any]:
    score = 50.0
    pos: list[str] = []
    lim: list[str] = []
    recs: list[str] = []
    used: list[str] = []
    missing: list[str] = []
    gender = _enum_value(getattr(ctx.profile, "gender", None))

    ea = metrics["avg_energy_availability"]
    if ea is not None:
        used.append("energy availability")
        if ea >= 35:
            score += 16; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, above the 35 robust-support mark.")
        elif ea >= 30:
            score += 6; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, above the 30 minimum support mark.")
        elif ea >= 25:
            score -= 12; lim.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM; that's borderline because it's below 30.")
            recs.append("Add 200-300 kcal on hard-training days or reduce one hard session until energy availability is >=30.")
        else:
            score -= 22; lim.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, below the 25 high-strain line.")
            recs.append("For 7-14 days, stop pushing the deficit: add 300-500 kcal/day or reduce training until energy availability is >=30.")
    else:
        missing.append("energy availability")

    fat_pct = metrics["avg_fat_pct"]
    if fat_pct is not None:
        used.append("dietary fat")
        if fat_pct >= 22:
            score += 10; pos.append(f"You're getting {_pct(fat_pct)} of calories from fat, above the 22% stronger-support mark.")
        elif fat_pct < 15:
            score -= 12; lim.append(f"You're getting {_pct(fat_pct)} of calories from fat, below the 15% low-fat threshold.")
            recs.append("Raise dietary fat to at least 20% of calories; 25-35% is often a steadier target if the plan allows it.")
        elif fat_pct < 20:
            score -= 5; lim.append(f"You're getting {_pct(fat_pct)} of calories from fat, near the lower edge and below the 20% floor.")
            recs.append("Add one fat source to a couple of meals until fat intake is back above 20% of calories.")
    else:
        missing.append("dietary fat trend")

    carbs = metrics["avg_carbs_per_lb"]
    mix = metrics["activity_mix"]
    if carbs is not None:
        used.append("carbohydrate intake")
        if carbs >= 1.2:
            score += 7; pos.append(f"You're averaging {carbs:.2f} g/lb carbs, above the 1.2 g/lb training-support mark.")
        elif carbs < 0.6 and metrics["hard_per_week"] >= 2:
            score -= 7; lim.append(f"You're averaging {carbs:.2f} g/lb carbs while doing {metrics['hard_per_week']:.1f} hard sessions/week; that's low for recent training.")
            recs.append("Put 30-60g carbs in the pre- or post-workout window on hard days if the goal allows it.")
        elif carbs < 0.8 and mix["intense_cardio_sessions_per_week"] >= 2:
            score -= 5; lim.append(f"You're averaging {carbs:.2f} g/lb carbs with {mix['intense_cardio_sessions_per_week']:.1f} HIIT/interval sessions/week.")
            recs.append("Fuel interval or sport days with 30-60g carbs near training instead of saving most carbs for rest days.")
    else:
        missing.append("carb/bodyweight trend")

    sleep = metrics["avg_sleep_hours"]
    if sleep is not None:
        used.append("sleep duration")
        if sleep >= 7:
            score += 8; pos.append(f"You're averaging {sleep:.1f}h sleep, which clears the 7h support line.")
        elif sleep < 6.25:
            score -= 10; lim.append(f"You're averaging {sleep:.1f}h sleep, which is short for this support signal.")
            recs.append("Set a 7.5-9h sleep opportunity before adding more deficit or training stress.")
    else:
        missing.append("sleep duration")

    pct_weight = metrics["pct_weight_change_per_week"]
    if pct_weight is not None:
        used.append("weight trend")
        if pct_weight < -1:
            score -= 14; lim.append(f"Your weight is falling about {abs(pct_weight):.1f}%/week, above the 1%/week rapid-loss strain line.")
            recs.append("Slow weight loss to <=1% body weight/week; consider a maintenance week if this has persisted.")
        elif pct_weight < -0.5:
            score -= 6; lim.append(f"Your weight is falling about {abs(pct_weight):.1f}%/week, a mild strain signal.")
            recs.append("Keep weekly loss near 0.5-1.0% of body weight and avoid stacking extra cardio on low-calorie days.")
        elif abs(pct_weight) <= 0.5:
            score += 4; pos.append(f"Your weight trend is stable at about {pct_weight:+.1f}%/week.")

    if gender == "female" and ctx.preferences and ctx.preferences.reproductive_health_opt_in:
        used.append("reproductive health opt-in")
        score += 3
        pos.append("You've enabled reproductive-health context, so cycle data can add context instead of being guessed.")
    elif gender == "female":
        missing.append("cycle/reproductive health opt-in")

    lab_keys = _lab_keys(ctx.labs)
    if lab_keys.intersection({"estradiol", "progesterone", "lh", "fsh"}):
        used.append("sex-hormone labs")
        score += 3
        pos.append("You have sex-hormone labs saved, which improves context for this estimate.")
    else:
        missing.append("sex-hormone labs")

    confidence = _confidence_for(ctx, metrics, ["profile", "sleep", "nutrition", "health"])
    score_i = _clamp(score)
    label = _support_label(score_i, confidence)
    summary = (
        "Fueling and recovery look supportive for estrogen/reproductive-axis signaling."
        if score_i >= 61 else
        "Energy availability, fat intake, sleep, or weight trend may be limiting reproductive-hormone support."
    )
    if confidence == "low":
        summary = "This is a broad reproductive-axis support read until Thallo has more nutrition, sleep, and wearable history."
    return _estimate(
        key="estrogen_support",
        title="Estrogen / reproductive-axis support",
        score=score_i,
        label=label,
        status=_status_from_support(score_i, confidence),
        risk_direction="higher_is_better",
        confidence=confidence,
        summary=summary,
        drivers=(pos + lim),
        positive_factors=pos,
        limiting_factors=lim,
        recommendations=recs or [
            "Keep calories steady, fat >=20% of calories, carbs around hard sessions, 7+ hours sleep, and weight changes gradual."
        ],
        data_used=used,
        missing_data=missing,
        window_days=ctx.days,
    )


def _thyroid_metabolic_support(ctx: WindowMetrics, metrics: dict[str, Any]) -> dict[str, Any]:
    score = 50.0
    pos: list[str] = []
    lim: list[str] = []
    recs: list[str] = []
    used: list[str] = []
    missing: list[str] = []

    ea = metrics["avg_energy_availability"]
    if ea is not None:
        used.append("energy availability")
        if ea >= 35:
            score += 16; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, above the 35 strong-support mark.")
        elif ea >= 30:
            score += 6; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, above the 30 adequate-support mark.")
        elif ea < 25:
            score -= 20; lim.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, below the 25 high-strain line.")
            recs.append("For 7 days, bring intake up or training down until energy availability is >=30; avoid extra fasting during this stretch.")
        else:
            score -= 10; lim.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM; that's borderline because it's below 30.")
            recs.append("Add 200-300 kcal on training days or remove one hard session until energy availability is consistently >=30.")
    else:
        missing.append("energy availability")

    carbs = metrics["avg_carbs_per_lb"]
    mix = metrics["activity_mix"]
    if carbs is not None:
        used.append("carbs/bodyweight")
        if carbs >= 1.0:
            score += 10; pos.append(f"You're averaging {carbs:.2f} g/lb carbs, above the 1.0 g/lb activity-support mark.")
        elif carbs < 0.5 and metrics["workout_min_per_week"]:
            score -= 10; lim.append(f"You're averaging {carbs:.2f} g/lb carbs with {metrics['workout_min_per_week']:.0f} workout min/week, which is low relative to activity.")
            recs.append("Add 25-50g carbs to the meal before or after workouts until carbs match the training block better.")
        elif carbs < 0.8 and mix["intense_cardio_sessions_per_week"] >= 2:
            score -= 6; lim.append(f"You're averaging {carbs:.2f} g/lb carbs with {mix['intense_cardio_sessions_per_week']:.1f} HIIT/interval sessions/week.")
            recs.append("On interval/cardio days, move 30-60g carbs into the training window instead of keeping them for rest days.")
    else:
        missing.append("carb trend")

    calorie_cv = metrics["calorie_cv"]
    if calorie_cv is not None:
        used.append("calorie consistency")
        if calorie_cv <= 0.22:
            score += 6; pos.append(f"Your calorie intake variability is about {_pct(calorie_cv * 100)}, inside the <=22% steady range.")
        elif calorie_cv > 0.35:
            score -= 7; lim.append(f"Your calorie intake variability is about {_pct(calorie_cv * 100)}, above the 35% wide-swing threshold.")
            recs.append("Keep daily calories within about 15-20% of target on at least 5 days/week.")

    sleep = metrics["avg_sleep_hours"]
    if sleep is not None:
        used.append("sleep duration")
        if sleep >= 7:
            score += 8; pos.append(f"You're averaging {sleep:.1f}h sleep, which supports metabolic recovery.")
        elif sleep < 6:
            score -= 8; lim.append(f"You're averaging {sleep:.1f}h sleep; below 6h adds metabolic strain.")
            recs.append("Set a 7.5-9h sleep opportunity for the next week before tightening calories further.")
    else:
        missing.append("sleep duration")

    micro_days = metrics["micronutrient_days"]
    if micro_days >= max(5, min(ctx.days, 14) // 2):
        used.append("micronutrient coverage")
        score += 4; pos.append(f"You have micronutrient detail on {micro_days} day(s), enough to use food-quality context.")
    else:
        missing.append("micronutrient detail")

    lab_keys = _lab_keys(ctx.labs)
    if lab_keys.intersection({"tsh", "free_t3", "free_t4"}):
        used.append("thyroid labs")
        score += 4
        pos.append("You have thyroid labs saved, which improves context for this estimate.")
    else:
        missing.append("thyroid labs")

    confidence = _confidence_for(ctx, metrics, ["profile", "sleep", "nutrition", "health"])
    score_i = _clamp(score)
    label = _support_label(score_i, confidence)
    summary = (
        "Energy, carbohydrate, and recovery signals look supportive for metabolic hormone signaling."
        if score_i >= 61 else
        "Fueling consistency, carbs, sleep, or energy availability may be limiting thyroid/metabolic support."
    )
    if confidence == "low":
        summary = "More complete food logs and wearable history are needed for a specific thyroid/metabolic support read."
    return _estimate(
        key="thyroid_metabolic_support",
        title="Thyroid / metabolic support",
        score=score_i,
        label=label,
        status=_status_from_support(score_i, confidence),
        risk_direction="higher_is_better",
        confidence=confidence,
        summary=summary,
        drivers=(pos + lim),
        positive_factors=pos,
        limiting_factors=lim,
        recommendations=recs or [
            "Keep energy availability >=30, put carbs near hard training, hold calories steady, and cover iodine/selenium from food unless a clinician says otherwise."
        ],
        data_used=used,
        missing_data=missing,
        window_days=ctx.days,
    )


def _cortisol_load(ctx: WindowMetrics, metrics: dict[str, Any]) -> dict[str, Any]:
    score = 40.0
    pos: list[str] = []
    lim: list[str] = []
    recs: list[str] = []
    used: list[str] = []
    missing: list[str] = []

    sleep = metrics["avg_sleep_hours"]
    if sleep is not None:
        used.append("sleep duration")
        if sleep >= 7.25:
            score -= 10; pos.append(f"You're averaging {sleep:.1f}h sleep, which lowers estimated stress load.")
        elif sleep < 6:
            score += 18; lim.append(f"You're averaging {sleep:.1f}h sleep; below 6h raises estimated stress load.")
            recs.append("Set a 7.5-9h sleep opportunity for the next 7 nights and keep caffeine out of the afternoon/evening.")
    else:
        missing.append("sleep duration")

    sleep_score = metrics["avg_sleep_score"]
    if sleep_score is not None:
        used.append("sleep score")
        if sleep_score >= 78:
            score -= 8; pos.append(f"Your average sleep score is {sleep_score:.0f}, above the 78 solid-sleep threshold.")
        elif sleep_score < 55:
            score += 10; lim.append(f"Your average sleep score is {sleep_score:.0f}, below the 55 low-sleep threshold.")

    hrv_trend = metrics["hrv_trend"]
    if hrv_trend is not None:
        used.append("HRV trend")
        if hrv_trend < -0.12:
            score += 14; lim.append(f"Your HRV is trending down about {_trend_pct(hrv_trend)}, which raises stress-load risk.")
            recs.append("For 48-72h, keep training to Zone 2, mobility, or one lighter lift until HRV rebounds.")
        elif hrv_trend >= -0.03:
            score -= 6; pos.append(f"Your HRV trend is stable at {_signed_trend_pct(hrv_trend)} vs baseline.")
    else:
        missing.append("HRV trend")

    rhr_trend = metrics["rhr_trend"]
    if rhr_trend is not None:
        used.append("resting HR trend")
        if rhr_trend > 0.08:
            score += 12; lim.append(f"Your resting HR is rising about {_trend_pct(rhr_trend)}, which raises stress-load risk.")
            recs.append("Use a 48h deload if resting HR keeps rising: no HIIT, no max-effort lifting, and earlier bedtime.")
        elif rhr_trend <= 0.03:
            score -= 5; pos.append(f"Your resting HR trend is steady at {_signed_trend_pct(rhr_trend)} vs baseline.")
    else:
        missing.append("resting HR trend")

    hard = metrics["hard_per_week"]
    workout_min = metrics["workout_min_per_week"]
    mix = metrics["activity_mix"]
    if workout_min is not None:
        used.append("training load")
        if workout_min >= 420 or hard >= 5:
            score += 12; lim.append(f"You're logging about {workout_min:.0f} workout min/week and {hard:.1f} hard sessions/week, a high-load pattern.")
            recs.append("Add 1 low-load recovery day this week and keep hard sessions to 3-4 until sleep/HRV/RHR stabilize.")
        elif 120 <= workout_min <= 330:
            score -= 4; pos.append(f"You're logging about {workout_min:.0f} workout min/week, inside the moderate-load range.")
    elif ctx.workouts:
        used.append("workout count")

    if mix["heavy_strength_sessions_per_week"] >= 2:
        used.append("heavy strength frequency")
        if mix["heavy_strength_sessions_per_week"] <= 4:
            score -= 3; pos.append(f"You're logging {mix['heavy_strength_sessions_per_week']:.1f} heavy strength sessions/week, present without looking excessive.")
        elif mix["heavy_strength_sessions_per_week"] > 5:
            score += 5; lim.append(f"You're logging {mix['heavy_strength_sessions_per_week']:.1f} heavy strength sessions/week, above the 5/week recovery-demand line.")
    if mix["intense_cardio_sessions_per_week"] >= 2:
        used.append("HIIT / interval frequency")
        score += min(10, 3 + mix["intense_cardio_sessions_per_week"] * 2)
        lim.append(f"You're doing {mix['intense_cardio_sessions_per_week']:.1f} HIIT/interval sessions/week, which raises stress load.")
        recs.append("Limit HIIT to 1-2 sessions/week, separated by at least 48h and fueled with carbs.")
    if mix["active_sport_stress_sessions_per_week"] >= 3:
        used.append("sport / active-labor load")
        score += 5
        lim.append(f"You're logging {mix['active_sport_stress_sessions_per_week']:.1f} sport/active-labor sessions/week outside the gym.")
    if mix["steady_cardio_sessions_per_week"] >= 2 or (metrics["zone2_min_per_week"] or 0) >= 90:
        used.append("steady cardio / Zone 2")
        score -= 5
        pos.append(f"You're logging {mix['steady_cardio_sessions_per_week']:.1f} steady-cardio sessions/week and {round(metrics['zone2_min_per_week'] or 0)} Zone 2 min/week.")
    if mix["recovery_sessions_per_week"] >= 2:
        used.append("recovery activity frequency")
        score -= min(8, 2 + mix["recovery_sessions_per_week"] * 1.5)
        pos.append(f"You're logging {mix['recovery_sessions_per_week']:.1f} recovery activities/week, which lowers load.")

    if metrics["late_stressor_workouts"] >= max(2, round(ctx.days / 14)):
        used.append("workout timing")
        score += 6; lim.append(f"You have {metrics['late_stressor_workouts']} late hard workout(s), enough to add nighttime stress.")
        recs.append("Finish hard training at least 3h before bed; use mobility or walking if training must be late.")

    ea = metrics["avg_energy_availability"]
    if ea is not None:
        used.append("energy availability")
        if ea < 25:
            score += 16; lim.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, below the 25 high-stress line.")
            recs.append("Add 300-500 kcal/day or reduce hard training until energy availability is >=30.")
        elif ea < 30:
            score += 8; lim.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM; below 30 adds stress.")
            recs.append("Add 200-300 kcal on hard days and avoid pairing low-calorie days with intervals.")
        elif ea >= 35:
            score -= 5; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, which suggests fueling is sufficient.")

    if metrics["breathing_elevated_days"] > 0:
        used.append("sleep breathing disturbance flags")
        score += min(10, 4 + metrics["breathing_elevated_days"] * 2)
        lim.append(f"You have {metrics['breathing_elevated_days']} elevated sleep-breathing disturbance day(s), which can raise recovery stress.")
        recs.append("Review persistent sleep-breathing flags with Apple Health data and a clinician.")

    confidence = _confidence_for(ctx, metrics, ["sleep", "health", "nutrition", "activity"])
    score_i = _clamp(score)
    label = _cortisol_label(score_i, confidence)
    summary = (
        "Stress-load proxies are elevated across the rolling window."
        if score_i >= 58 else
        "Stress-load proxies look manageable."
    )
    if confidence == "low":
        summary = "Thallo needs more sleep, HRV/RHR, nutrition, and activity history before making this stress-load estimate specific."
    return _estimate(
        key="cortisol_load",
        title="Cortisol load",
        score=score_i,
        label=label,
        status=_status_from_load(score_i, confidence),
        risk_direction="higher_is_worse",
        confidence=confidence,
        summary=summary,
        drivers=(lim + pos),
        positive_factors=pos,
        limiting_factors=lim,
        recommendations=recs or [
            "Keep 7.5-9h sleep, separate hard days by 24-48h, cap HIIT at 1-2/week, and use 1-2 lower-load days/week."
        ],
        data_used=used,
        missing_data=missing,
        window_days=ctx.days,
    )


def _stress_segment(
    *,
    key: str,
    title: str,
    window_label: str,
    expected_pattern: str,
    score: int,
    label: str,
    status: str,
    risk_direction: str,
    confidence: str,
    summary: str,
    drivers: list[str],
    data_used: list[str],
    missing_data: list[str],
) -> dict[str, Any]:
    return {
        "key": key,
        "title": title,
        "window_label": window_label,
        "expected_pattern": expected_pattern,
        "score": score,
        "label": label,
        "status": status,
        "risk_direction": risk_direction,
        "confidence": confidence,
        "summary": summary,
        "drivers": drivers[:5],
        "data_used": data_used,
        "missing_data": missing_data[:5],
    }


def _daypart_confidence(ctx: WindowMetrics, metrics: dict[str, Any], required: list[str]) -> str:
    base = _confidence_for(ctx, metrics, required)
    if "meal_timing" in required and metrics["meal_timing"]["avg_last_calorie_hour"] is None:
        return "low" if base == "medium" else base
    return base


def _stress_cortisol_rhythm(ctx: WindowMetrics, metrics: dict[str, Any], cortisol: dict[str, Any]) -> dict[str, Any]:
    sleep = metrics["avg_sleep_hours"]
    sleep_score = metrics["avg_sleep_score"]
    bedtime_sd = metrics["bedtime_sd_min"]
    hrv_trend = metrics["hrv_trend"]
    rhr_trend = metrics["rhr_trend"]
    ea = metrics["avg_energy_availability"]
    mix = metrics["activity_mix"]
    meal_timing = metrics["meal_timing"]
    late_meals = int(meal_timing["late_calorie_days"] or 0)
    late_stressors = int(metrics["late_stressor_workouts"] or 0)
    late_recovery = int(metrics["late_recovery_activities"] or 0)
    elevated_breathing = int(metrics["breathing_elevated_days"] or 0)
    cutoff = max(2, round(ctx.days / 14))

    wake_score = 50.0
    wake_drivers: list[str] = []
    wake_used: list[str] = []
    wake_missing: list[str] = []
    if sleep is not None:
        wake_used.append("sleep duration")
        if sleep >= 7.25:
            wake_score += 14; wake_drivers.append(f"You're averaging {sleep:.1f}h sleep, which supports the morning rise.")
        elif sleep < 6:
            wake_score -= 18; wake_drivers.append(f"You're averaging {sleep:.1f}h sleep; below 6h can blunt the wake pattern.")
    else:
        wake_missing.append("sleep duration")
    if sleep_score is not None:
        wake_used.append("sleep score")
        if sleep_score >= 78:
            wake_score += 8; wake_drivers.append(f"Your average sleep score is {sleep_score:.0f}, above the 78 solid-sleep threshold.")
        elif sleep_score < 55:
            wake_score -= 8; wake_drivers.append(f"Your average sleep score is {sleep_score:.0f}, below the 55 recovery-drag threshold.")
    if bedtime_sd is not None:
        wake_used.append("bedtime consistency")
        if bedtime_sd <= 75:
            wake_score += 6; wake_drivers.append(f"Your bedtime varies about {bedtime_sd:.0f} min, inside the <=75 min consistency target.")
        elif bedtime_sd >= 150:
            wake_score -= 6; wake_drivers.append(f"Your bedtime varies about {bedtime_sd:.0f} min, above the 150 min rhythm-strain line.")
    else:
        wake_missing.append("bedtime consistency")
    if elevated_breathing > 0:
        wake_used.append("sleep breathing disturbance flags")
        wake_score -= min(12, 5 + elevated_breathing * 2)
        wake_drivers.append(f"You have {elevated_breathing} elevated sleep-breathing disturbance day(s), which may strain the morning pattern.")
    if ea is not None and ea < 25:
        wake_used.append("energy availability")
        wake_score -= 6
        wake_drivers.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, which adds HPA-axis strain.")
    wake_confidence = _confidence_for(ctx, metrics, ["sleep", "health"])
    wake_score_i = _clamp(wake_score)
    wake_segment = _stress_segment(
        key="wake_morning",
        title="Wake + morning",
        window_label="Wake to late morning",
        expected_pattern="Cortisol is normally higher after waking, then begins declining.",
        score=wake_score_i,
        label=_wake_peak_label(wake_score_i, wake_confidence),
        status=_status_from_support(wake_score_i, wake_confidence),
        risk_direction="higher_is_better",
        confidence=wake_confidence,
        summary=(
            "Sleep and recovery data support a cleaner morning cortisol rise."
            if wake_score_i >= 58 else
            "Sleep or recovery strain may make the morning cortisol pattern less clean."
        ) if wake_confidence != "low" else "More sleep and wearable history is needed to estimate the wake pattern.",
        drivers=wake_drivers,
        data_used=wake_used,
        missing_data=wake_missing,
    )

    day_score = float(cortisol.get("score", 50))
    day_drivers = list(cortisol.get("drivers") or [])
    day_used = list(cortisol.get("data_used") or [])
    day_missing = list(cortisol.get("missing_data") or [])
    if metrics["morning_workouts"] > 0:
        day_used.append("morning workout timing")
        day_score += 2
        day_drivers.append(f"You logged {metrics['morning_workouts']} morning workout(s), creating a normal daytime stress pulse.")
    if mix["heavy_strength_sessions_per_week"] >= 2:
        day_used.append("heavy strength frequency")
        day_score += 2
        day_drivers.append(f"You're logging {mix['heavy_strength_sessions_per_week']:.1f} heavy strength sessions/week, useful stress that needs recovery.")
    if mix["intense_cardio_sessions_per_week"] >= 2:
        day_used.append("HIIT / interval frequency")
        day_score += min(8, 2 + mix["intense_cardio_sessions_per_week"] * 2)
        day_drivers.append(f"You're doing {mix['intense_cardio_sessions_per_week']:.1f} HIIT/interval sessions/week, which raises daytime load more than Zone 2.")
    if mix["steady_cardio_sessions_per_week"] >= 2:
        day_used.append("steady cardio frequency")
        day_score -= 3
        day_drivers.append(f"You're logging {mix['steady_cardio_sessions_per_week']:.1f} steady-cardio sessions/week, a lower-stress pattern.")
    if mix["recovery_sessions_per_week"] >= 2:
        day_used.append("recovery activity frequency")
        day_score -= 4
        day_drivers.append(f"You're logging {mix['recovery_sessions_per_week']:.1f} recovery sessions/week, offsetting some training stress.")
    if metrics["avg_steps"] is not None:
        day_used.append("daily movement")
        if metrics["avg_steps"] >= 12000 and metrics["hard_per_week"] >= 4:
            day_score += 5; day_drivers.append(f"You're averaging {metrics['avg_steps']:.0f} steps with {metrics['hard_per_week']:.1f} hard sessions/week, raising daytime load.")
        elif 6000 <= metrics["avg_steps"] <= 11000:
            day_score -= 3; day_drivers.append(f"You're averaging {metrics['avg_steps']:.0f} steps/day, a steady movement range.")
    day_confidence = _confidence_for(ctx, metrics, ["sleep", "health", "activity"])
    day_score_i = _clamp(day_score)
    day_segment = _stress_segment(
        key="daytime_load",
        title="Daytime load",
        window_label="Late morning to afternoon",
        expected_pattern="The curve should trend downward unless training, under-fueling, or stress keeps load elevated.",
        score=day_score_i,
        label=_cortisol_label(day_score_i, day_confidence),
        status=_status_from_load(day_score_i, day_confidence),
        risk_direction="higher_is_worse",
        confidence=day_confidence,
        summary=(
            "Daytime stress-load proxies are elevated."
            if day_score_i >= 58 else
            "Daytime stress-load proxies look manageable."
        ) if day_confidence != "low" else "More HRV/RHR, sleep, and activity history is needed for a daytime estimate.",
        drivers=day_drivers,
        data_used=day_used,
        missing_data=day_missing,
    )

    evening_score = 28.0
    evening_drivers: list[str] = []
    evening_used: list[str] = []
    evening_missing: list[str] = []
    if late_stressors:
        evening_used.append("late workout timing")
        evening_score += min(18, 6 + late_stressors * 4)
        evening_drivers.append(f"You logged {late_stressors} late hard session(s), which can keep evening stress load elevated.")
    elif late_recovery:
        evening_used.append("late recovery activity timing")
        evening_score -= min(8, 3 + late_recovery * 2)
        evening_drivers.append(f"You logged {late_recovery} evening recovery activities, which support the downshift.")
    elif ctx.workouts:
        evening_used.append("workout timing")
        evening_score -= 3
        evening_drivers.append("Your hard workout timing is not clustered late in the evening.")
    else:
        evening_missing.append("workout timing")
    if late_meals:
        evening_used.append("late meal timing")
        evening_score += min(14, 4 + late_meals * 2)
        evening_drivers.append(f"You logged late calories on {late_meals} day(s), which can blur the evening downshift.")
    elif meal_timing["avg_last_calorie_hour"] is not None:
        evening_used.append("meal timing")
        evening_score -= 3
        evening_drivers.append(f"Your logged calories usually stop around {_hour_label(meal_timing['avg_last_calorie_hour'])}, before late evening.")
    else:
        evening_missing.append("meal timing")
    if sleep is not None:
        evening_used.append("sleep duration")
        if sleep < 6:
            evening_score += 12; evening_drivers.append(f"You're averaging {sleep:.1f}h sleep, suggesting poor evening recovery.")
        elif sleep >= 7.25:
            evening_score -= 6; evening_drivers.append(f"You're averaging {sleep:.1f}h sleep, supporting evening recovery.")
    else:
        evening_missing.append("sleep duration")
    if bedtime_sd is not None:
        evening_used.append("bedtime consistency")
        if bedtime_sd >= 150:
            evening_score += 8; evening_drivers.append(f"Your bedtime varies about {bedtime_sd:.0f} min, which can flatten the rhythm.")
        elif bedtime_sd <= 75:
            evening_score -= 4; evening_drivers.append(f"Your bedtime varies about {bedtime_sd:.0f} min, supporting the downshift.")
    if hrv_trend is not None:
        evening_used.append("HRV trend")
        if hrv_trend < -0.12:
            evening_score += 8; evening_drivers.append(f"Your HRV is trending down about {_trend_pct(hrv_trend)}, which can keep evening load elevated.")
        elif hrv_trend >= -0.03:
            evening_score -= 4; evening_drivers.append(f"Your HRV trend is stable at {_signed_trend_pct(hrv_trend)} vs baseline.")
    if rhr_trend is not None:
        evening_used.append("resting HR trend")
        if rhr_trend > 0.08:
            evening_score += 8; evening_drivers.append(f"Your resting HR is rising about {_trend_pct(rhr_trend)}, which can keep evening load elevated.")
        elif rhr_trend <= 0.03:
            evening_score -= 3; evening_drivers.append(f"Your resting HR trend is steady at {_signed_trend_pct(rhr_trend)} vs baseline.")
    if ea is not None and ea < 25:
        evening_used.append("energy availability")
        evening_score += 8
        evening_drivers.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, so under-fueling can keep stress load elevated.")
    if int(cortisol.get("score", 50)) >= 70:
        evening_score += 6
        evening_drivers.append(f"Your overall stress-load estimate is {int(cortisol.get('score', 50))}, high enough to lift evening risk.")
    evening_confidence = _daypart_confidence(ctx, metrics, ["sleep", "health", "activity", "meal_timing"])
    evening_score_i = _clamp(evening_score)
    evening_segment = _stress_segment(
        key="evening_downshift",
        title="Evening downshift",
        window_label="Evening to bedtime",
        expected_pattern="Cortisol should be low before sleep; elevated load here is the main watch item.",
        score=evening_score_i,
        label=_evening_stress_label(evening_score_i, evening_confidence),
        status=_status_from_load(evening_score_i, evening_confidence),
        risk_direction="higher_is_worse",
        confidence=evening_confidence,
        summary=(
            "Evening signals suggest the stress system is not fully downshifting."
            if evening_score_i >= 58 else
            "Evening signals support a lower-stress downshift before sleep."
        ) if evening_confidence != "low" else "More meal timing, workout timing, sleep, and wearable history is needed for the evening estimate.",
        drivers=evening_drivers,
        data_used=evening_used,
        missing_data=evening_missing,
    )

    segments = [wake_segment, day_segment, evening_segment]
    confidence_rank = {"low": 0, "medium": 1, "high": 2}
    confidence = min([s["confidence"] for s in segments], key=lambda c: confidence_rank.get(c, 0))
    flattened_risk = wake_score_i < 45 or evening_score_i >= 58
    summary = (
        "Pattern risk: the day may be flatter than ideal, usually from a weak morning signal or elevated evening load."
        if flattened_risk else
        "Pattern support: the data fits the expected high-morning, lower-evening cortisol rhythm."
    )
    if confidence == "low":
        summary = "Building a daypart stress-rhythm baseline; Thallo needs more time-stamped sleep, wearable, food, and workout data."
    return {
        "key": "diurnal_stress_cortisol_pattern",
        "title": "Estimated stress / cortisol rhythm",
        "confidence": confidence,
        "summary": summary,
        "segments": segments,
        "data_used": sorted({item for segment in segments for item in segment["data_used"]}),
        "missing_data": sorted({item for segment in segments for item in segment["missing_data"]}),
        "disclaimer": DISCLAIMER,
    }


def _autophagy_opportunity(ctx: WindowMetrics, metrics: dict[str, Any], cortisol: dict[str, Any]) -> dict[str, Any]:
    score = 22.0
    pos: list[str] = []
    lim: list[str] = []
    cap_limits: list[str] = []
    recs: list[str] = []
    used: list[str] = []
    missing: list[str] = []
    fast = metrics["fasting"]
    mix = metrics["activity_mix"]
    sleep = metrics["avg_sleep_hours"]
    ea = metrics["avg_energy_availability"]
    score_caps: list[tuple[int, str]] = []

    current_fast = fast["current_fast_hours"]
    avg_fast = fast["avg_longest_daily_fast_hours"]
    if current_fast is not None:
        used.append("current fasting window")
        if current_fast >= 24:
            # Intentional non-monotonic scoring: this estimates cellular-cleanup
            # opportunity and must not incentivize longer or extreme fasting.
            score += 12; pos.append(f"Long fast: opportunity present at {current_fast:.0f}h, but not additionally rewarded.")
            lim.append(f"Your current fast is {current_fast:.0f}h; extended fasting is capped so recovery is not rewarded as a contest.")
            recs.append("Break extended fasts with protein and fluids, especially before training.")
        elif current_fast >= 16:
            score += 23; pos.append(f"Moderate extended fast: {current_fast:.0f}h since last logged calories is inside the higher-opportunity window.")
        elif current_fast >= 13:
            score += 15; pos.append(f"You're at a {current_fast:.0f}h fasting window, clearing the 13h opportunity mark.")
        elif current_fast >= 11:
            score += 8; pos.append(f"You're at an {current_fast:.0f}h overnight gap, so the fasting window is building.")
        else:
            score -= 6; lim.append(f"You're only {current_fast:.0f}h since last logged calories, keeping the current window low.")
            recs.append("Start with a 12h overnight eating gap 3-5 days/week before trying longer windows.")
    elif fast.get("current_fast_stale"):
        missing.append("recent meal timing")
        lim.append("Last logged calories are too old to count as an active fast, so missing logs are not treated as fasting.")
    else:
        missing.append("meal timing")

    if avg_fast is not None:
        used.append("average longest daily fast")
        if avg_fast >= 14:
            score += 14; pos.append(f"Your average longest daily gap is {avg_fast:.1f}h, above the 14h opportunity mark.")
        elif avg_fast >= 12:
            score += 8; pos.append(f"Your average longest daily gap is {avg_fast:.1f}h, a moderate fasting window.")
        elif avg_fast < 10:
            score -= 5; lim.append(f"Your average longest daily gap is {avg_fast:.1f}h, below the 10h short-window threshold.")
            recs.append("Move late snacks earlier until the longest daily gap is usually 12-14h.")
    else:
        missing.append("fasting-window history")

    zone2 = metrics["zone2_min_per_week"]
    if zone2 is not None:
        used.append("Zone 2 minutes")
        if zone2 >= 90:
            score += 10; pos.append(f"You're logging {round(zone2)} min/week Zone 2.")
        elif zone2 >= 30:
            score += 5; pos.append(f"You're logging {round(zone2)} min/week Zone 2, enough for some metabolic-flexibility support.")
    elif mix["steady_cardio_sessions_per_week"] >= 2:
        used.append("steady cardio frequency")
        score += 6; pos.append(f"You're logging {mix['steady_cardio_sessions_per_week']:.1f} steady-cardio sessions/week, supporting metabolic flexibility.")
    else:
        missing.append("Zone 2 minutes")

    strength = mix["heavy_strength_sessions_per_week"] or metrics["strength_per_week"]
    if strength >= 2:
        used.append("strength training frequency")
        score += 6; pos.append(f"You're logging {strength:.1f} heavy strength sessions/week, supporting tissue turnover.")
    elif len(ctx.workouts) == 0:
        missing.append("workout history")

    if mix["recovery_sessions_per_week"] >= 2:
        used.append("recovery activity frequency")
        score += 3; pos.append(f"You're logging {mix['recovery_sessions_per_week']:.1f} recovery sessions/week, supporting a lower-stress cleanup window.")
    if mix["intense_cardio_sessions_per_week"] >= 3 and (sleep or 8) < 6.5:
        used.append("HIIT / interval frequency")
        score -= 5; lim.append(f"You're pairing {mix['intense_cardio_sessions_per_week']:.1f} HIIT/interval sessions/week with {(sleep or 0):.1f}h sleep, limiting the cleanup estimate.")

    carbs = metrics["avg_carbs_per_lb"]
    if carbs is not None:
        used.append("carbohydrate intake")
        if carbs < 0.8:
            if ea is not None and ea >= 30 and sleep is not None and sleep >= 6.5:
                score += 5; pos.append(f"You're averaging {carbs:.2f} g/lb carbs with adequate sleep and fueling context.")
            else:
                lim.append("Low carbs are not credited because sleep or energy availability is not adequate enough.")
        elif carbs > 1.8:
            score -= 4; lim.append(f"You're averaging {carbs:.2f} g/lb carbs, which makes fasting-time inference less specific.")

    if ea is not None:
        used.append("energy availability")
        if 30 <= ea <= 38:
            score += 5; pos.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM, suggesting mild rather than extreme stress.")
        elif ea < 25:
            score -= 14; lim.append(f"Your low energy availability is about {ea:.0f} kcal/kg FFM, which caps the cleanup estimate.")
            score_caps.append((50, "Low energy availability capped score: under-fueling keeps this opportunity estimate at or below 50."))
            recs.append("Do not extend fasting while under-fueled; add 300-500 kcal/day or reduce training until energy availability is >=30.")
        elif ea < 30:
            score -= 6; lim.append(f"Your energy availability is about {ea:.0f} kcal/kg FFM; below 30 limits safe fasting pressure.")
            score_caps.append((60, "Low energy availability capped score: under-fueling keeps this opportunity estimate at or below 60."))
            recs.append("Hold fasting at 12h and fix fueling first; extend only after energy availability is >=30.")

    if sleep is not None and sleep < 6:
        score -= 8
        lim.append(f"You're averaging {sleep:.1f}h sleep, so extra fasting pressure is less useful right now.")
        if sleep < 5.5:
            score_caps.append((55, "Low sleep capped score: recovery-limited days keep this estimate at or below 55."))
        else:
            score_caps.append((68, "Low sleep capped score: recovery-limited days keep this estimate at or below 68."))
        recs.append("Do not lengthen fasts after <6h sleep; eat normally and prioritize a 7.5-9h sleep window.")

    cortisol_score = int(cortisol.get("score", 50))
    if cortisol_score >= 70:
        score_caps.append((57, "High stress load capped score: recovery-limited stress load keeps this below Elevated."))
        lim.append(f"Your cortisol-load score is {cortisol_score}, so high stress load caps the estimate.")
        recs.append("Hold fasting at 12-14h and use 48h lower-load training before extending the window.")

    if score_caps:
        strictest_cap, _ = min(score_caps, key=lambda item: item[0])
        score = min(score, strictest_cap)
        cap_limits = [message for cap, message in score_caps if cap == strictest_cap]

    confidence = _confidence_for(ctx, metrics, ["meal_timing", "nutrition", "activity", "sleep"])
    exact_count = int(fast.get("exact_timestamp_count") or 0)
    inferred_count = int(fast.get("inferred_timestamp_count") or 0)
    timestamp_count = exact_count + inferred_count
    inferred_ratio = float(fast.get("inferred_timestamp_ratio") or 0)
    if timestamp_count == 0:
        confidence = "low"
    elif exact_count < 2:
        confidence = "low"
        missing.append("exact meal timestamps")
    elif inferred_ratio > 0.5:
        confidence = "medium" if confidence == "high" else confidence
        lim.append("More than half of meal times are inferred, so confidence is capped below high.")
    if fast.get("current_fast_stale") and confidence == "high":
        confidence = "medium"
    score_i = _clamp(score)
    label = _autophagy_label(score_i, confidence)
    summary = (
        "Conditions are favorable for a cellular-cleanup window."
        if score_i >= 58 else
        "Conditions are not especially favorable for a cellular-cleanup window right now."
    )
    if confidence == "low":
        summary = "Thallo needs more meal timing, food, activity, and recovery history before estimating this specifically."
    return _estimate(
        key="autophagy_opportunity",
        title="Cellular Cleanup Opportunity",
        score=score_i,
        label=label,
        status=_status_from_support(score_i, confidence),
        risk_direction="higher_is_better",
        confidence=confidence,
        summary=summary,
        drivers=(pos + cap_limits + lim),
        positive_factors=pos,
        limiting_factors=(cap_limits + lim),
        recommendations=recs or [
            "Use a 12-14h overnight gap 3-5 days/week, eat protein with the first meal, and skip longer fasts after hard training or poor sleep."
        ],
        data_used=used,
        missing_data=missing,
        window_days=ctx.days,
    )


def build_metabolic_signals_response(db: Session, user_id: int, *, days: int = 30) -> dict[str, Any]:
    days = max(14, min(30, int(days or 30)))
    ctx = _query_window(db, user_id, days)
    metrics = _shared_metrics(ctx)

    testosterone = _testosterone_support(ctx, metrics)
    estrogen = _estrogen_support(ctx, metrics)
    thyroid = _thyroid_metabolic_support(ctx, metrics)
    cortisol = _cortisol_load(ctx, metrics)
    stress_rhythm = _stress_cortisol_rhythm(ctx, metrics, cortisol)
    autophagy = _autophagy_opportunity(ctx, metrics, cortisol)

    hormone_score = _clamp(
        (
            testosterone["score"] +
            estrogen["score"] +
            thyroid["score"] +
            (100 - cortisol["score"])
        ) / 4
    )
    confidence_values = [testosterone["confidence"], estrogen["confidence"], thyroid["confidence"], cortisol["confidence"]]
    confidence_rank = {"low": 0, "medium": 1, "high": 2}
    hormone_confidence = min(confidence_values, key=lambda c: confidence_rank.get(c, 0))
    hormone_label = _support_label(hormone_score, hormone_confidence)
    hormone_summary = (
        "The rolling lifestyle pattern is supportive for normal hormone signaling."
        if hormone_score >= 61 else
        "The rolling lifestyle pattern has strain signals that may limit hormone support."
    )
    if hormone_confidence == "low":
        hormone_summary = "Building a hormone-support baseline from food, sleep, activity, and wearable data."

    source_metrics = {
        "avg_sleep_hours": round(metrics["avg_sleep_hours"], 2) if metrics["avg_sleep_hours"] is not None else None,
        "avg_sleep_score": round(metrics["avg_sleep_score"], 1) if metrics["avg_sleep_score"] is not None else None,
        "avg_hrv_ms": round(metrics["avg_hrv"], 1) if metrics["avg_hrv"] is not None else None,
        "avg_resting_hr": round(metrics["avg_rhr"], 1) if metrics["avg_rhr"] is not None else None,
        "avg_spo2": round(metrics["avg_spo2"], 1) if metrics["avg_spo2"] is not None else None,
        "breathing_elevated_days": metrics["breathing_elevated_days"],
        "nutrition_days": metrics["nutrition_days"],
        "avg_fat_pct": round(metrics["avg_fat_pct"], 1) if metrics["avg_fat_pct"] is not None else None,
        "avg_protein_per_lb": round(metrics["avg_protein_per_lb"], 2) if metrics["avg_protein_per_lb"] is not None else None,
        "avg_carbs_per_lb": round(metrics["avg_carbs_per_lb"], 2) if metrics["avg_carbs_per_lb"] is not None else None,
        "avg_energy_availability": round(metrics["avg_energy_availability"], 1) if metrics["avg_energy_availability"] is not None else None,
        "strength_sessions_per_week": round(metrics["strength_per_week"], 1),
        "hard_sessions_per_week": round(metrics["hard_per_week"], 1),
        "zone2_minutes_per_week": round(metrics["zone2_min_per_week"]) if metrics["zone2_min_per_week"] is not None else None,
        "heavy_strength_sessions_per_week": round(metrics["activity_mix"]["heavy_strength_sessions_per_week"], 1),
        "steady_cardio_sessions_per_week": round(metrics["activity_mix"]["steady_cardio_sessions_per_week"], 1),
        "intense_cardio_sessions_per_week": round(metrics["activity_mix"]["intense_cardio_sessions_per_week"], 1),
        "recovery_sessions_per_week": round(metrics["activity_mix"]["recovery_sessions_per_week"], 1),
        "active_sport_stress_sessions_per_week": round(metrics["activity_mix"]["active_sport_stress_sessions_per_week"], 1),
        "late_stressor_workouts": metrics["late_stressor_workouts"],
        "late_recovery_activities": metrics["late_recovery_activities"],
        "late_calorie_days": metrics["meal_timing"]["late_calorie_days"],
        "avg_last_calorie_hour": round(metrics["meal_timing"]["avg_last_calorie_hour"], 1) if metrics["meal_timing"]["avg_last_calorie_hour"] is not None else None,
        "current_fast_hours": round(metrics["fasting"]["current_fast_hours"], 1) if metrics["fasting"]["current_fast_hours"] is not None else None,
        "current_fast_stale": bool(metrics["fasting"]["current_fast_stale"]),
        "avg_longest_daily_fast_hours": round(metrics["fasting"]["avg_longest_daily_fast_hours"], 1) if metrics["fasting"]["avg_longest_daily_fast_hours"] is not None else None,
        "meal_timing_exact_timestamps": metrics["fasting"]["exact_timestamp_count"],
        "meal_timing_inferred_timestamps": metrics["fasting"]["inferred_timestamp_count"],
        "meal_timing_inferred_ratio": round(metrics["fasting"]["inferred_timestamp_ratio"], 2),
        "hormone_lab_count": metrics["hormone_lab_count"],
    }

    return {
        "user_id": str(user_id),
        "window_days": ctx.days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "confidence": hormone_confidence,
        "disclaimer": DISCLAIMER,
        "data_coverage": ctx.data_coverage,
        "data_used": ctx.data_used,
        "missing_data": ctx.missing_data,
        "hormone_support": {
            "score": hormone_score,
            "label": hormone_label,
            "confidence": hormone_confidence,
            "summary": hormone_summary,
            "estimates": [testosterone, estrogen, thyroid, cortisol],
        },
        "stress_rhythm": stress_rhythm,
        "autophagy": autophagy,
        "source_metrics": source_metrics,
    }
