"""Deterministic weekly plan review — v2.

Replaces the legacy AI plan_review (permanently disabled). Emits
structured, actionable recommendations from existing signals:

  - Weekly volume by muscle group  (weekly_volume.compute_weekly_volume)
  - Session adherence              (PlanDay-matched completions vs PlanWeek)
  - Weight-trend vs goal            (adaptive_macros recommendations)
  - Cardio minutes by style         (Zone 2 vs intervals)
  - Readiness / recovery flags      (recovery_flags, fatigue)
  - Strength trend / plateau        (plateau_detection)

Each recommendation is a small, targeted action (add one cardio session,
reduce chest volume 10%, etc.) rather than "regenerate the plan." The
client renders them as a bullet list with accept / dismiss actions; an
accepted recommendation is what eventually applies a deterministic
change (or hands off to the AI trainer for explanation only).

Pure function except for DB reads. No LLM calls. Callers decide
whether to surface to the user, schedule a check-in, or auto-apply.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from sqlalchemy import func
from sqlmodel import select

from app.models import (
    BodyScan, DailyNutritionMetrics, DailyRollup, Meal, MealItem, PlanDay, PlanWeek, UserGoal,
    UserProfile, UserRollup,
    WorkoutCompletion, WorkoutExercise, WorkoutPlan, WorkoutSession, ExerciseSet,
)
from app.services.workout.weekly_volume import (
    WeeklyVolumeSnapshot, compute_weekly_volume,
)
from app.services.workout.goals import effective_goal_id, goal_bucket as canonical_goal_bucket
from app.services.nutrition.meal_history import dedupe_meals_for_aggregation

Priority = Literal["info", "suggest", "warn"]
Area = Literal["workout", "nutrition", "recovery", "cardio"]


@dataclass
class Recommendation:
    """A single targeted change the user can accept. Each recommendation
    is expressed as both a short UI string (`title`) and a structured
    `action` dict downstream code can apply without another AI call."""
    key: str                     # stable id for dedup / analytics
    area: Area
    priority: Priority
    title: str                   # short — "Reduce chest volume"
    detail: str                  # one sentence of "why"
    action: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "area": self.area,
            "priority": self.priority,
            "title": self.title,
            "detail": self.detail,
            "action": self.action,
        }


@dataclass
class WeeklyReview:
    """Rolled-up weekly picture + recommendations the user can accept."""
    user_id: int
    week_start: date
    week_end: date
    goal: str
    sessions_completed: int
    sessions_planned: int
    adherence_pct: float
    workout_adherence_pct: float
    cardio_minutes: float
    zone2_minutes: float
    volume: WeeklyVolumeSnapshot
    # Nutrition signals — averaged over the window.
    nutrition_adherence_pct: float = 0.0  # Back-compat alias for nutrition_logging_pct.
    nutrition_logging_pct: float = 0.0
    days_logged: int = 0
    avg_calories: float = 0.0
    avg_protein_g: float = 0.0
    protein_target_g: float | None = None
    avg_fiber_g: float = 0.0
    calorie_target_adherence_pct: float | None = None
    protein_target_adherence_pct: float | None = None
    nutrition_summary: str = ""
    nutrition_notes: list[str] = field(default_factory=list)
    # Weight trend signals.
    weight_trend_lbs_per_week: float | None = None
    weight_trend_direction: str = "flat"    # "up" | "down" | "flat" | "unknown"
    # Smoothed weight (EMA) — cleaner trend display than raw slope alone,
    # which is noisy week to week. Surfaced in WeeklyCoachingCard.
    weight_ema_lbs: float | None = None
    # Recovery signals (averages; each card still owns the daily view).
    avg_sleep_hours: float | None = None
    avg_resting_hr: float | None = None
    avg_rir: float | None = None
    soreness_areas: list[dict[str, Any]] = field(default_factory=list)
    plateaus: list[dict[str, Any]] = field(default_factory=list)
    # One-sentence summary the UI can use as the card headline.
    headline: str = ""
    # Goal-specific 6-week forecast shown in Progress + weekly recap.
    goal_forecast: dict[str, Any] | None = None
    recommendations: list[Recommendation] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "week_start": str(self.week_start),
            "week_end": str(self.week_end),
            "goal": self.goal,
            "sessions_completed": self.sessions_completed,
            "sessions_planned": self.sessions_planned,
            "adherence_pct": round(self.adherence_pct, 1),
            "workout_adherence_pct": round(self.workout_adherence_pct or self.adherence_pct, 1),
            "cardio_minutes": round(self.cardio_minutes, 0),
            "zone2_minutes": round(self.zone2_minutes, 0),
            "volume": self.volume.to_dict(),
            "nutrition_adherence_pct": round(self.nutrition_adherence_pct, 1),
            "nutrition_logging_pct": round(self.nutrition_logging_pct, 1),
            "days_logged": self.days_logged,
            "avg_calories": round(self.avg_calories, 1),
            "avg_protein_g": round(self.avg_protein_g, 1),
            "protein_target_g": (
                round(self.protein_target_g, 1)
                if self.protein_target_g is not None else None
            ),
            "avg_fiber_g": round(self.avg_fiber_g, 1),
            "calorie_target_adherence_pct": (
                round(self.calorie_target_adherence_pct, 1)
                if self.calorie_target_adherence_pct is not None else None
            ),
            "protein_target_adherence_pct": (
                round(self.protein_target_adherence_pct, 1)
                if self.protein_target_adherence_pct is not None else None
            ),
            "nutrition_summary": self.nutrition_summary,
            "nutrition_notes": self.nutrition_notes,
            "weight_trend_lbs_per_week": self.weight_trend_lbs_per_week,
            "weight_trend_direction": self.weight_trend_direction,
            "weight_ema_lbs": self.weight_ema_lbs,
            "avg_sleep_hours": self.avg_sleep_hours,
            "avg_resting_hr": self.avg_resting_hr,
            "avg_rir": round(self.avg_rir, 1) if self.avg_rir is not None else None,
            "soreness_areas": self.soreness_areas,
            "plateaus": self.plateaus,
            "headline": self.headline,
            "goal_forecast": self.goal_forecast,
            "recommendations": [r.to_dict() for r in self.recommendations],
        }


# ── Cardio minute targets by goal (weekly, total cardio + zone-2 split)
# These are soft — falling below triggers a "suggest", not a "warn".
_CARDIO_TARGETS: dict[str, tuple[int, int]] = {
    # goal_bucket → (total_cardio_min, zone2_min)
    "muscle_gain":     (60, 40),    # just enough to maintain cardio base
    "strength":        (60, 40),
    "body_recomp":    (120, 80),
    "fat_loss":       (180, 120),
    "endurance":      (240, 150),
    "general_health": (150, 100),
    "longevity":      (150, 100),   # WHO guidelines
    "athletic_performance": (120, 80),
    "maintain":       (120, 80),
    "flexibility":      (60, 40),
    "stress_relief":    (90, 60),
}

# Goals where adding cardio is part of the goal contract. Strength and
# hypertrophy users can still receive recovery guidance when they are
# stacking hard lifting days, but the coach should not turn a muscle-gain
# week into a cardio-chasing week because of a generic Zone 2 target.
_CARDIO_RECOMMENDATION_GOALS = {
    "body_recomp",
    "fat_loss",
    "endurance",
    "general_health",
    "longevity",
    "athletic_performance",
    "maintain",
    "stress_relief",
}

# Adherence threshold below which we suggest reducing planned volume
# rather than trying to cram more in. "You're missing sessions — the
# plan is too ambitious" is often the right call for 3-week streaks.
_LOW_ADHERENCE_PCT = 65.0


@dataclass
class NutritionWindowFacts:
    days_logged: int = 0
    avg_calories: float = 0.0
    avg_protein_g: float = 0.0
    avg_fiber_g: float = 0.0


def _daily_metric_has_nutrition(row: DailyNutritionMetrics) -> bool:
    protein = (row.plant_protein_g or 0) + (row.animal_protein_g or 0)
    return any(float(v or 0) > 0 for v in (
        row.calories_total,
        protein,
        row.fiber_total_g,
        row.added_sugar_g,
        row.sodium_mg,
        row.micronutrient_item_count,
    ))


def _facts_from_daily_metrics(rows: list[DailyNutritionMetrics]) -> NutritionWindowFacts:
    active = [row for row in rows if _daily_metric_has_nutrition(row)]
    days_logged = len({row.metric_date for row in active})
    if days_logged <= 0:
        return NutritionWindowFacts()
    return NutritionWindowFacts(
        days_logged=days_logged,
        avg_calories=sum(row.calories_total or 0 for row in active) / days_logged,
        avg_protein_g=sum((row.plant_protein_g or 0) + (row.animal_protein_g or 0) for row in active) / days_logged,
        avg_fiber_g=sum(row.fiber_total_g or 0 for row in active) / days_logged,
    )


def _facts_from_daily_rollups(rows: list[DailyRollup]) -> NutritionWindowFacts:
    active = [
        row for row in rows
        if (row.meals_logged or 0) > 0
        or float(row.kcal or 0) > 0
        or float(row.protein_g or 0) > 0
    ]
    days_logged = len({row.day for row in active})
    if days_logged <= 0:
        return NutritionWindowFacts()
    return NutritionWindowFacts(
        days_logged=days_logged,
        avg_calories=sum(row.kcal or 0 for row in active) / days_logged,
        avg_protein_g=sum(row.protein_g or 0 for row in active) / days_logged,
        avg_fiber_g=0.0,
    )


def _facts_from_meal_history(db: Any, user_id: int, *, start: date, end_date: date) -> NutritionWindowFacts:
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(Meal.meal_date >= start)
        .where(Meal.meal_date <= end_date)
        .order_by(Meal.meal_date.asc(), Meal.created_at.asc())
    ).all()
    if not meals:
        return NutritionWindowFacts()

    meal_ids = [meal.id for meal in meals if meal.id is not None]
    all_items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all() if meal_ids else []
    items_by_meal: dict[int, list[MealItem]] = defaultdict(list)
    for item in all_items:
        items_by_meal[item.meal_id].append(item)

    meals = dedupe_meals_for_aggregation(meals, items_by_meal)

    daily: dict[date, dict[str, float]] = defaultdict(lambda: {
        "calories": 0.0,
        "protein_g": 0.0,
        "fiber_g": 0.0,
        "meal_count": 0.0,
    })
    for meal in meals:
        day_data = daily[meal.meal_date]
        day_data["meal_count"] += 1
        for item in items_by_meal.get(meal.id, []):
            day_data["calories"] += float(item.calories or 0)
            day_data["protein_g"] += float(item.protein_g or 0)
            day_data["fiber_g"] += float(item.fiber_g or 0)

    logged_days = [data for data in daily.values() if data["meal_count"] > 0]
    days_logged = len(logged_days)
    if days_logged <= 0:
        return NutritionWindowFacts()
    return NutritionWindowFacts(
        days_logged=days_logged,
        avg_calories=sum(data["calories"] for data in logged_days) / days_logged,
        avg_protein_g=sum(data["protein_g"] for data in logged_days) / days_logged,
        avg_fiber_g=sum(data["fiber_g"] for data in logged_days) / days_logged,
    )


def _sum_cardio_minutes(completions: list[WorkoutCompletion]) -> tuple[float, float]:
    """Total cardio minutes + zone-2 minutes in the window.

    Pure cardio activities count their full duration. Lift + Cardio and
    mixed sessions only count the finisher/conditioning portion so a
    60-minute push day with 10-15 minutes of cardio does not become a
    fake 60-minute Zone 2 session.

    Z2 inclusion: anything labeled steady/easy/recovery cardio counts.
    Intervals + sprints + HIIT do NOT count even if the user logged them
    under the cardio category — those are Z4/Z5 work, not aerobic base.
    HR-summary (zoneMinutes[]) is preferred when present so we read the
    actual time-in-zone instead of guessing from the style label.
    """
    total = 0.0
    zone2 = 0.0
    for c in completions:
        mins = (c.duration_seconds or 0) / 60.0
        if mins <= 0:
            continue

        category = (c.activity_category or "").lower()
        focus = (c.focus_label or "").lower()
        subtype = (c.activity_subtype or "").lower()
        style = (c.cardio_style or "").lower()
        intensity = (c.activity_intensity or "").lower()
        is_lift_plus_cardio = " + cardio" in focus or "+ cardio" in focus
        is_pure_cardio_focus = (
            not is_lift_plus_cardio
            and any(
                token in focus
                for token in (
                    "zone 2", "zone2", "z2", "cardio", "conditioning",
                    "hiit", "bootcamp", "tabata",
                    "tempo", "interval", "run", "bike", "cycle", "row",
                    "swim", "elliptical", "stair", "treadmill",
                )
            )
        )

        cardio_mins = 0.0
        if category == "cardio" or is_pure_cardio_focus:
            cardio_mins = mins
        elif category in {"sport", "active"} and (
            "cardio" in focus
            or subtype in {"soccer", "basketball", "tennis", "pickleball", "volleyball", "beach_volleyball", "boxing", "kickboxing", "martial_arts", "dancing"}
        ):
            cardio_mins = mins
        elif is_lift_plus_cardio or style in {"steady", "intervals", "easy", "recovery", "class"}:
            cardio_mins = min(20.0, max(10.0, mins * 0.25))
        elif (c.stimulus or "").lower() == "conditioning":
            cardio_mins = mins

        if cardio_mins <= 0:
            continue

        total += cardio_mins

        # Prefer HR-zone time when the user's watch / chest strap supplied
        # actual zone minutes. `zoneMinutes` is [z1, z2, z3, z4, z5] from
        # the workout's hr_summary blob. When present, this overrides the
        # style heuristic — actual data beats labels every time.
        hr = c.hr_summary or {}
        zm = hr.get("zoneMinutes") if isinstance(hr, dict) else None
        if isinstance(zm, list) and len(zm) >= 2 and any(isinstance(x, (int, float)) and x > 0 for x in zm):
            try:
                z2_min_actual = float(zm[1])
                if z2_min_actual > 0:
                    zone2 += min(z2_min_actual, cardio_mins)
                    continue
            except (TypeError, ValueError):
                pass

        # Otherwise infer from style/intensity labels. Adds `style == 'easy'`
        # and `style == 'recovery'` which were silently dropped before — an
        # easy walk IS Z2 cardio by definition.
        focus_is_zone2 = any(token in focus for token in ("zone 2", "zone2", "z2", "steady"))
        if style in {"steady", "easy", "recovery"} or intensity == "easy" or focus_is_zone2:
            zone2 += cardio_mins
        elif is_lift_plus_cardio and style not in {"intervals", "sprint"}:
            zone2 += cardio_mins
    return total, zone2


def _weekly_training_signals(
    db: Any,
    user_id: int,
    *,
    start: date,
    end_date: date,
    completions: list[WorkoutCompletion],
) -> tuple[float | None, list[dict[str, Any]]]:
    rir_rows = db.exec(
        select(ExerciseSet.actual_rir)
        .join(WorkoutExercise, WorkoutExercise.id == ExerciseSet.workout_exercise_id)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= start)
        .where(WorkoutSession.workout_date <= end_date)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(ExerciseSet.actual_rir != None)  # noqa: E711
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    ).all()
    rir_values = [float(v) for v in rir_rows if v is not None]
    avg_rir = sum(rir_values) / len(rir_values) if rir_values else None

    soreness_counts: dict[str, int] = {}
    for completion in completions:
        areas = completion.soreness_areas or []
        if not isinstance(areas, list):
            continue
        for raw in areas:
            key = str(raw or "").strip().lower()
            if not key:
                continue
            soreness_counts[key] = soreness_counts.get(key, 0) + 1
    soreness_areas = [
        {"area": area, "count": count}
        for area, count in sorted(soreness_counts.items(), key=lambda item: (-item[1], item[0]))
    ]
    return avg_rir, soreness_areas


def _planned_focus(plan_day: PlanDay) -> str:
    if not isinstance(plan_day.workout_json, dict):
        return ""
    return str(plan_day.workout_json.get("focus") or "").strip()


def _focuses_match(planned: str, completed: str) -> bool:
    if not planned or not completed:
        return False

    def _clean(value: str) -> str:
        return " ".join(value.lower().replace("_", " ").split())

    if _clean(planned) == _clean(completed):
        return True
    try:
        from app.services.workout.focus_normalize import normalize_focus_to_family
        planned_family = normalize_focus_to_family(planned)
        completed_family = normalize_focus_to_family(completed)
        return bool(planned_family and completed_family and planned_family == completed_family)
    except Exception:
        return False


def _plan_week_session_counts(
    db: Any,
    user_id: int,
    *,
    start: date,
    end_date: date,
    completions: list[WorkoutCompletion],
) -> tuple[int, int, bool]:
    """Return planned sessions + plan-matched completions from PlanWeek."""
    plan_week = db.exec(
        select(PlanWeek)
        .where(PlanWeek.user_id == user_id)
        .where(PlanWeek.start_date <= end_date)
        .where(PlanWeek.end_date >= start)
        .order_by(PlanWeek.start_date.desc(), PlanWeek.id.desc())
    ).first()
    if plan_week is None or plan_week.id is None:
        return 0, 0, False

    plan_days = db.exec(
        select(PlanDay)
        .where(PlanDay.plan_week_id == plan_week.id)
        .where(PlanDay.day_date >= start)
        .where(PlanDay.day_date <= end_date)
        .order_by(PlanDay.day_date)
    ).all()
    planned_days = [
        day for day in plan_days
        if not day.is_rest
        and _planned_focus(day)
        and _planned_focus(day).lower() != "rest"
    ]
    completed_count = 0
    for day in planned_days:
        if day.status == "completed":
            completed_count += 1
            continue
        planned = _planned_focus(day)
        matched = any(
            c.workout_date == day.day_date
            and (
                getattr(c, "plan_day_id", None) == day.id
                or _focuses_match(planned, c.focus_label or "")
            )
            for c in completions
        )
        if matched:
            completed_count += 1
    return len(planned_days), completed_count, True


def compute_weekly_review(
    db: Any,
    user_id: int,
    *,
    end_date: date | None = None,
    days: int = 7,
    # Optional pre-computed signals the caller already has. Injected
    # rather than re-fetched here because both adaptive_macros and
    # readiness already do some of this work upstream.
    weight_trend_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_steps: float | None = None,
    readiness_score: int | None = None,
    # When provided, evaluates the week against this goal instead of the
    # currently active UserGoal. Used by auto_renew_week to score the
    # expiring week against the goal it was actually generated with (the
    # user may have changed goal mid-week).
    goal_override: str | None = None,
) -> WeeklyReview:
    """Produce a full weekly review with structured recommendations.

    All recovery / health inputs are optional — the review gracefully
    degrades to "use completions only" when Apple Health isn't
    connected. No signal silently punishes the user. Every rule that
    fires attaches a concrete `action` so the UI can render an
    accept / dismiss button pair instead of free-text."""
    if end_date is None:
        end_date = date.today()
    start = end_date - timedelta(days=days - 1)

    # Active goal — drives targets. If the caller supplies a goal snapshot,
    # do not query UserGoal; completed-week reviews must stay tied to the
    # goal that generated that week.
    active_goal = None
    if not goal_override:
        active_goal = db.exec(
            select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
        ).first()
        goal_override = effective_goal_id(active_goal, fallback="general_health")
    goal_bucket = canonical_goal_bucket(goal_override)
    goal_pace = None
    if active_goal is not None and getattr(active_goal, "pace", None) is not None:
        raw_pace = getattr(active_goal, "pace")
        goal_pace = raw_pace.value if hasattr(raw_pace, "value") else str(raw_pace)
    target_weight_lbs = (
        float(active_goal.target_weight_lbs)
        if active_goal is not None and active_goal.target_weight_lbs is not None else None
    )
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    current_weight_lbs = float(profile.weight_lbs) if profile and profile.weight_lbs else None
    latest_body_scan = db.exec(
        select(BodyScan)
        .where(BodyScan.user_id == user_id)
        .where(BodyScan.body_fat_pct != None)  # noqa: E711
        .order_by(BodyScan.scan_date.desc(), BodyScan.created_at.desc())
    ).first()
    body_fat_pct = (
        float(latest_body_scan.body_fat_pct)
        if latest_body_scan and latest_body_scan.body_fat_pct is not None else None
    )

    # Completions in window.
    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= start)
        .where(WorkoutCompletion.workout_date <= end_date)
    ).all()

    planned, completed_for_adherence, used_plan_week = _plan_week_session_counts(
        db,
        user_id,
        start=start,
        end_date=end_date,
        completions=completions,
    )
    if not used_plan_week:
        # Fallback for very old accounts/tests that only have legacy WorkoutPlan.
        plan = db.exec(
            select(WorkoutPlan)
            .where(WorkoutPlan.user_id == user_id, WorkoutPlan.is_active == True)
        ).first()
        # NOTE: WorkoutPlan column is `plan_json` (singular). The plural
        # `plans_json` lives on NutritionPlan only — easy to mix up.
        if plan and plan.plan_json:
            try:
                days_list = plan.plan_json.get("days") or []
                planned = len([d for d in days_list if d.get("focus") and (d.get("focus") or "").lower() != "rest"])
            except Exception:
                planned = 0
        completed_for_adherence = len(completions)

    adherence_pct = (
        100.0 * completed_for_adherence / planned
        if planned > 0 else 0.0
    )
    workout_mins = sum((c.duration_seconds or 0) / 60.0 for c in completions)
    cardio_mins, zone2_mins = _sum_cardio_minutes(completions)
    volume = compute_weekly_volume(db, user_id, end_date=end_date, days=days)
    avg_rir, soreness_areas = _weekly_training_signals(
        db,
        user_id,
        start=start,
        end_date=end_date,
        completions=completions,
    )
    try:
        from app.services.workout.plateau_detection import detect_plateaus
        plateaus = detect_plateaus(user_id, db=db, window_weeks=4, today=end_date)
    except Exception:
        plateaus = []

    # Nutrition signals — meals are the source of truth; DailyNutritionMetrics
    # is a derived cache and may be missing/stale for older or burst-saved logs.
    nutrition_rows = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= start)
        .where(DailyNutritionMetrics.metric_date <= end_date)
    ).all()
    daily_rollups = db.exec(
        select(DailyRollup)
        .where(DailyRollup.user_id == user_id)
        .where(DailyRollup.day >= start)
        .where(DailyRollup.day <= end_date)
    ).all()
    metric_facts = _facts_from_daily_metrics(nutrition_rows)
    rollup_facts = _facts_from_daily_rollups(daily_rollups)
    meal_facts = _facts_from_meal_history(db, user_id, start=start, end_date=end_date)
    nutrition_facts = (
        meal_facts if meal_facts.days_logged > 0
        else rollup_facts if rollup_facts.days_logged > 0
        else metric_facts
    )
    days_logged = nutrition_facts.days_logged
    avg_calories = nutrition_facts.avg_calories
    avg_protein = nutrition_facts.avg_protein_g
    avg_fiber = nutrition_facts.avg_fiber_g or metric_facts.avg_fiber_g
    # Nutrition logging coverage = % of days with meal-derived metrics.
    # Keep the legacy `nutrition_adherence_pct` response field as an alias
    # for now, but UI should label this as logging coverage unless target
    # adherence fields below are populated.
    nutrition_logging_pct = 100.0 * days_logged / days if days > 0 else 0.0

    kcal_target_days = [
        r for r in daily_rollups
        if (r.kcal_target or 0) > 0 and (r.kcal or 0) > 0
    ]
    calorie_target_adherence_pct = None
    if kcal_target_days:
        hits = [
            r for r in kcal_target_days
            if abs(float(r.kcal or 0) - float(r.kcal_target or 0)) <= float(r.kcal_target or 0) * 0.15
        ]
        calorie_target_adherence_pct = 100.0 * len(hits) / len(kcal_target_days)
    protein_target_days = [
        r for r in daily_rollups
        if (r.protein_target_g or 0) > 0 and (r.protein_g or 0) > 0
    ]
    protein_target_adherence_pct = None
    protein_target_g = None
    if protein_target_days:
        protein_target_g = (
            sum(float(r.protein_target_g or 0) for r in protein_target_days)
            / len(protein_target_days)
        )
        hits = [
            r for r in protein_target_days
            if float(r.protein_g or 0) >= float(r.protein_target_g or 0) * 0.85
        ]
        protein_target_adherence_pct = 100.0 * len(hits) / len(protein_target_days)
    if protein_target_g is None:
        try:
            from app.services.nutrition.targets import resolve_targets_for_user
            resolved_targets = resolve_targets_for_user(
                db, user_id, as_of=end_date, include_health=False,
            )
            if resolved_targets and resolved_targets.protein_g > 0:
                protein_target_g = float(resolved_targets.protein_g)
        except Exception:
            protein_target_g = None

    nutrition_summary, nutrition_notes = _build_nutrition_summary(
        days=days,
        days_logged=days_logged,
        logging_pct=nutrition_logging_pct,
        avg_calories=avg_calories,
        avg_protein=avg_protein,
        protein_target_g=protein_target_g,
        avg_fiber=avg_fiber,
        calorie_target_adherence_pct=calorie_target_adherence_pct,
        protein_target_adherence_pct=protein_target_adherence_pct,
    )

    # Weight trend direction for headline + rec gating.
    weight_trend_direction = "unknown"
    if weight_trend_lbs_per_week is not None:
        if weight_trend_lbs_per_week > 0.15:
            weight_trend_direction = "up"
        elif weight_trend_lbs_per_week < -0.15:
            weight_trend_direction = "down"
        else:
            weight_trend_direction = "flat"

    # ── Build recommendations ──────────────────────────────────────────
    recs: list[Recommendation] = []

    # Poor-recovery composite flag — suppresses "cut harder" / "add
    # volume" recommendations because piling on with poor recovery is
    # the main failure mode of naive coaches.
    poor_recovery = False
    if avg_sleep_hours is not None and avg_sleep_hours < 6.5:
        poor_recovery = True
    if readiness_score is not None and readiness_score < 55:
        poor_recovery = True

    # Readiness-triggered deload: if the user is training through low
    # readiness, give them a one-tap durable deload action.
    if readiness_score is not None and readiness_score < 45 and completed_for_adherence >= 3:
        recs.append(Recommendation(
            key="readiness_deload",
            area="recovery",
            priority="warn",
            title="Schedule a deload",
            detail=(
                f"Readiness is {readiness_score} after {completed_for_adherence} logged sessions. "
                "Take a lower-volume week before pushing load again."
            ),
            action={"type": "schedule_deload", "days": 7, "volume_pct": -30},
        ))

    # RIR signal: consistently living near failure is useful briefly, but
    # across a week it raises fatigue without reliably improving progress.
    if avg_rir is not None and avg_rir <= 0.75 and completed_for_adherence >= 2:
        recs.append(Recommendation(
            key="low_rir_reduce_intensity",
            area="recovery",
            priority="suggest",
            title="Leave 1–2 reps in reserve",
            detail=(
                f"Logged sets averaged {avg_rir:.1f} RIR this week. Keep one or two reps in reserve "
                "on most working sets to recover better."
            ),
            action={"type": "reduce_intensity", "pct": 10},
        ))

    top_soreness = soreness_areas[0] if soreness_areas else None
    if top_soreness and int(top_soreness.get("count") or 0) >= 2:
        area = str(top_soreness.get("area") or "").replace("_", " ")
        recs.append(Recommendation(
            key=f"soreness_{top_soreness.get('area')}",
            area="recovery",
            priority="suggest",
            title=f"Ease up around {area}",
            detail=(
                f"{area.capitalize()} soreness showed up after {top_soreness.get('count')} sessions. "
                "Keep range of motion pain-free and trim one hard set if it persists."
            ),
            action={"type": "reduce_intensity", "area": top_soreness.get("area"), "pct": 10},
        ))

    plateau_deloads = [p for p in plateaus if p.get("suggestion") == "deload"]
    if plateau_deloads:
        first = plateau_deloads[0]
        recs.append(Recommendation(
            key="plateau_deload",
            area="workout",
            priority="suggest",
            title="Deload plateaued lifts",
            detail=(
                f"{first.get('exercise_name', 'A main lift')} has been flat for "
                f"{first.get('weeks_stuck', 4)} weeks. Deload, then rebuild."
            ),
            action={"type": "schedule_deload", "days": 7, "volume_pct": -30},
        ))
    else:
        plateau_swaps = [p for p in plateaus if p.get("suggestion") == "swap"]
        if plateau_swaps:
            first = plateau_swaps[0]
            recs.append(Recommendation(
                key="plateau_swap",
                area="workout",
                priority="info",
                title="Swap a stale lift",
                detail=(
                    f"{first.get('exercise_name', 'A lift')} has stayed flat. "
                    "Try a close variation for the next generated block."
                ),
                action={"type": "noop"},
            ))

    # 1. Adherence → reduce days if consistently missing.
    if planned >= 3 and adherence_pct < _LOW_ADHERENCE_PCT:
        recs.append(Recommendation(
            key="reduce_days",
            area="workout",
            priority="suggest",
            title=f"Drop to {max(2, planned - 1)} days / week",
            detail=(
                f"You completed {completed_for_adherence} of {planned} planned sessions "
                f"({adherence_pct:.0f}%). Dropping a day keeps consistency high."
            ),
            action={"type": "change_days_per_week", "value": max(2, planned - 1)},
        ))

    # 2. Per-muscle volume — undertrained / high / excessive / spike.
    for muscle in ("chest", "back", "shoulders", "quads", "hamstrings", "glutes"):
        mv = volume.by_muscle.get(muscle)
        if not mv:
            continue
        if mv.status == "excessive":
            recs.append(Recommendation(
                key=f"deload_volume_{muscle}",
                area="workout",
                priority="warn",
                title=f"Pull back {muscle} volume",
                detail=(
                    f"{mv.total_sets:.0f} hard sets this week is well above the "
                    f"{mv.range_min}–{mv.range_max} range — overreach risk. "
                    "Cut one accessory and one working set on that day."
                ),
                action={"type": "reduce_muscle_volume", "muscle": muscle, "pct": 25},
            ))
        elif mv.status == "spike":
            recs.append(Recommendation(
                key=f"spike_{muscle}",
                area="workout",
                priority="warn",
                title=f"{muscle.capitalize()} volume jumped fast",
                detail=(
                    f"{mv.total_sets:.0f} sets this week vs {mv.avg_sets_prior_weeks:.0f} "
                    "avg the prior 3 weeks. Ramp injury-free: hold this load one more "
                    "week before adding more."
                ),
                action={"type": "hold_muscle_volume", "muscle": muscle},
            ))
        elif mv.status == "high" and mv.range_max is not None and poor_recovery:
            recs.append(Recommendation(
                key=f"reduce_volume_{muscle}",
                area="workout",
                priority="suggest",
                title=f"Hold back {muscle} volume",
                detail=(
                    f"{mv.total_sets:.0f} hard sets this week is above the "
                    f"{mv.range_min}–{mv.range_max} range while recovery is strained. "
                    "Drop one accessory next week."
                ),
                action={"type": "reduce_muscle_volume", "muscle": muscle, "pct": 15},
            ))
        elif mv.status == "undertrained" and mv.range_min is not None and not poor_recovery:
            # Don't push volume increases on a tired user. They need
            # recovery first, not more sets.
            recs.append(Recommendation(
                key=f"add_volume_{muscle}",
                area="workout",
                priority="info",
                title=f"Add 2–3 {muscle} sets",
                detail=(
                    f"{mv.total_sets:.0f} hard sets this week is below the "
                    f"{mv.range_min}–{mv.range_max} range for balanced growth."
                ),
                action={"type": "add_muscle_volume", "muscle": muscle, "sets": 3},
            ))

    # 3. Cardio target vs goal.
    if goal_bucket in _CARDIO_RECOMMENDATION_GOALS:
        target = _CARDIO_TARGETS.get(goal_bucket) or _CARDIO_TARGETS["general_health"]
        t_total, t_z2 = target
        if cardio_mins + 15 < t_total:
            shortfall = int(t_total - cardio_mins)
            recs.append(Recommendation(
                key="add_cardio",
                area="cardio",
                priority="suggest",
                title=f"Add ~{shortfall} min cardio",
                detail=(
                    f"Cardio for your {goal_bucket.replace('_', ' ')} goal is about "
                    f"{t_total} min / week. You logged {int(cardio_mins)}."
                ),
                action={"type": "add_cardio_session", "minutes": min(45, shortfall)},
            ))
        if zone2_mins + 15 < t_z2:
            shortfall = int(t_z2 - zone2_mins)
            recs.append(Recommendation(
                key="add_zone2",
                area="cardio",
                priority="info",
                title=f"Add ~{shortfall} min easy cardio",
                detail=(
                    f"Zone 2 target is ~{t_z2} min / week. You're at {int(zone2_mins)}. "
                    "Long walks + easy bike rides count."
                ),
                action={"type": "add_zone2_session", "minutes": min(45, shortfall)},
            ))

    # 4. 7-day all-hard pattern → warn on 6+ strength days with no Z2.
    strength_days = sum(
        1 for c in completions
        if (c.activity_category or "").lower() == "strength"
    )
    if strength_days >= 6 and zone2_mins < 30:
        recs.append(Recommendation(
            key="add_recovery_day",
            area="recovery",
            priority="warn",
            title="Swap one strength day for recovery",
            detail=(
                f"{strength_days} strength sessions and under 30 min of easy "
                "cardio this week. One active-recovery day drops injury risk."
            ),
            action={"type": "swap_to_recovery", "count": 1},
        ))

    # 5. Poor recovery + fat-loss user trying to cut harder — HOLD.
    if poor_recovery and goal_bucket in ("fat_loss", "body_recomp"):
        recs.append(Recommendation(
            key="hold_calorie_cut",
            area="nutrition",
            priority="warn",
            title="Don't reduce calories this week",
            detail=(
                "Recovery signals are low " +
                (f"(sleep {avg_sleep_hours:.1f}h avg" if avg_sleep_hours else "") +
                (f", readiness {readiness_score}" if readiness_score is not None else "") +
                "). Hold calories until recovery improves — deeper cuts "
                "hurt strength + compliance."
            ),
            action={"type": "hold_calorie_adjustment"},
        ))

    # 6. Weight trend too fast for goal.
    if weight_trend_lbs_per_week is not None:
        # Flag >1 lb/week in either direction for sustained loss/gain.
        if goal_bucket in ("fat_loss",) and weight_trend_lbs_per_week < -1.5:
            recs.append(Recommendation(
                key="weight_loss_too_fast",
                area="nutrition",
                priority="warn",
                title="Weight dropping too fast",
                detail=(
                    f"Losing {abs(weight_trend_lbs_per_week):.1f} lb/week is "
                    "above the 0.5–1% of bodyweight ceiling. Add ~150 kcal "
                    "to protect muscle + recovery."
                ),
                action={"type": "raise_calories", "kcal": 150},
            ))
        elif goal_bucket in ("muscle_gain", "lean_bulk") and weight_trend_lbs_per_week > 1.0:
            recs.append(Recommendation(
                key="weight_gain_too_fast",
                area="nutrition",
                priority="suggest",
                title="Weight gaining too fast",
                detail=(
                    f"Gaining {weight_trend_lbs_per_week:.1f} lb/week tilts the "
                    "ratio toward fat over muscle. Trim ~150 kcal."
                ),
                action={"type": "lower_calories", "kcal": 150},
            ))

    # 7. Nutrition adherence low + protein / fiber low → focus nudge.
    if days_logged >= 3:
        # Only nag when there's enough data. Below 3 days logged this
        # week we trust nothing.
        protein_below_target = (
            avg_protein > 0
            and (
                (protein_target_g is not None and avg_protein < protein_target_g * 0.85)
                or (protein_target_g is None and avg_protein < 100)
            )
        )
        if protein_below_target:
            target_text = (
                f" vs your {protein_target_g:.0f}g target"
                if protein_target_g is not None else ""
            )
            aim_text = (
                "Aim for your plan target to protect muscle."
                if protein_target_g is not None
                else "Aim for 0.8-1g per lb of bodyweight to protect muscle."
            )
            recs.append(Recommendation(
                key="raise_protein",
                area="nutrition",
                priority="info",
                title="Protein below target",
                detail=(
                    f"Averaging {avg_protein:.0f}g protein/day{target_text} over "
                    f"{days_logged} logged days. {aim_text}"
                ),
                action={"type": "raise_protein_target"},
            ))
        if avg_fiber > 0 and avg_fiber < 20:
            recs.append(Recommendation(
                key="raise_fiber",
                area="nutrition",
                priority="info",
                title="Fiber below target",
                detail=(
                    f"Averaging {avg_fiber:.0f}g fiber/day. Target is 25–35g — "
                    "fiber drives satiety + gut health."
                ),
                action={"type": "raise_fiber_target"},
            ))
    elif nutrition_logging_pct < 50 and planned > 0:
        recs.append(Recommendation(
            key="log_more_meals",
            area="nutrition",
            priority="info",
            title="Log meals on more days",
            detail=(
                f"Only {days_logged} of {days} days logged. Nutrition coaching "
                "kicks in at 4+ days of data."
            ),
            action={"type": "noop"},
        ))

    # 8. No completions at all.
    if len(completions) == 0 and planned > 0:
        recs.append(Recommendation(
            key="log_first_workout",
            area="workout",
            priority="info",
            title="Log your first workout",
            detail=(
                "No sessions logged this week. Logging unlocks volume + "
                "readiness + plan adaptation."
            ),
            action={"type": "noop"},
        ))

    headline = _build_headline(
        goal_bucket=goal_bucket,
        sessions_completed=completed_for_adherence,
        sessions_planned=planned,
        adherence_pct=adherence_pct,
        volume=volume,
        weight_trend_direction=weight_trend_direction,
        poor_recovery=poor_recovery,
        avg_sleep_hours=avg_sleep_hours,
    )
    if planned > 0 and completed_for_adherence == 0 and len(completions) > 0:
        extra = len(completions)
        headline = (
            f"0/{planned} planned sessions, plus {extra} other logged "
            f"session{'s' if extra != 1 else ''}. Keep logging; align one with the plan to unlock adherence coaching."
        )

    # Keep weekly review read-only. The score API is still the nutrition
    # authority, but its weekly builder may materialize DailyNutritionMetrics
    # rows; this review should not change the data it is summarizing.
    weekly_nutrition_score = None

    try:
        from app.services.workout.goal_forecast import build_goal_forecast
        goal_forecast = build_goal_forecast(
            goal=goal_override,
            pace=goal_pace,
            current_weight_lbs=current_weight_lbs,
            target_weight_lbs=target_weight_lbs,
            body_fat_pct=body_fat_pct,
            sessions_completed=completed_for_adherence,
            sessions_planned=planned,
            workout_adherence_pct=adherence_pct,
            workout_minutes=workout_mins,
            cardio_minutes=cardio_mins,
            zone2_minutes=zone2_mins,
            days_logged=days_logged,
            days=days,
            nutrition_logging_pct=nutrition_logging_pct,
            avg_protein_g=avg_protein,
            protein_target_g=protein_target_g,
            calorie_target_adherence_pct=calorie_target_adherence_pct,
            protein_target_adherence_pct=protein_target_adherence_pct,
            weekly_nutrition_score=weekly_nutrition_score,
            weight_trend_lbs_per_week=weight_trend_lbs_per_week,
            avg_sleep_hours=avg_sleep_hours,
        ).to_dict()
    except Exception:
        goal_forecast = None

    # Smoothed weight (EMA) — pulled from the 7-day UserRollup. Cleaner
    # than the raw slope alone (which is noisy week-to-week) and gives
    # the UI a "current weight, smoothed: X lbs" line that doesn't
    # whiplash on a single bad weigh-in.
    weight_ema_lbs: float | None = None
    rollup_7d = db.exec(
        select(UserRollup).where(
            UserRollup.user_id == user_id,
            UserRollup.window_days == 7,
        )
    ).first()
    if rollup_7d and rollup_7d.weight_ema_lbs is not None:
        weight_ema_lbs = float(rollup_7d.weight_ema_lbs)

    return WeeklyReview(
        user_id=user_id,
        week_start=start,
        week_end=end_date,
        goal=goal_bucket,
        sessions_completed=completed_for_adherence,
        sessions_planned=planned,
        adherence_pct=adherence_pct,
        workout_adherence_pct=adherence_pct,
        cardio_minutes=cardio_mins,
        zone2_minutes=zone2_mins,
        volume=volume,
        nutrition_adherence_pct=nutrition_logging_pct,
        nutrition_logging_pct=nutrition_logging_pct,
        days_logged=days_logged,
        avg_calories=avg_calories,
        avg_protein_g=avg_protein,
        protein_target_g=protein_target_g,
        avg_fiber_g=avg_fiber,
        calorie_target_adherence_pct=calorie_target_adherence_pct,
        protein_target_adherence_pct=protein_target_adherence_pct,
        nutrition_summary=nutrition_summary,
        nutrition_notes=nutrition_notes,
        weight_trend_lbs_per_week=weight_trend_lbs_per_week,
        weight_trend_direction=weight_trend_direction,
        weight_ema_lbs=weight_ema_lbs,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        avg_rir=avg_rir,
        soreness_areas=soreness_areas,
        plateaus=plateaus,
        headline=headline,
        goal_forecast=goal_forecast,
        recommendations=recs,
    )


def _build_nutrition_summary(
    *,
    days: int,
    days_logged: int,
    logging_pct: float,
    avg_calories: float,
    avg_protein: float,
    protein_target_g: float | None,
    avg_fiber: float,
    calorie_target_adherence_pct: float | None,
    protein_target_adherence_pct: float | None,
) -> tuple[str, list[str]]:
    notes: list[str] = []

    if days_logged <= 0:
        return (
            "No meals logged this week, so nutrition changes are held until there is data.",
            ["No nutrition data this week — log a few meals before changing calories or macros."],
        )

    notes.append(f"{days_logged}/{days} days logged ({logging_pct:.0f}% coverage).")
    if avg_protein > 0:
        if protein_target_g:
            notes.append(f"Protein averaged {avg_protein:.0f}g/day vs {protein_target_g:.0f}g target.")
        else:
            notes.append(f"Protein averaged {avg_protein:.0f}g/day.")
    if avg_fiber > 0:
        notes.append(f"Fiber averaged {avg_fiber:.0f}g/day.")
    if calorie_target_adherence_pct is not None:
        notes.append(f"Calories were near target on {calorie_target_adherence_pct:.0f}% of logged target days.")
    if protein_target_adherence_pct is not None:
        notes.append(f"Protein target hit on {protein_target_adherence_pct:.0f}% of logged target days.")

    if logging_pct < 50:
        summary = (
            f"Nutrition logging was light ({days_logged}/{days} days), so this review should not change calories yet."
        )
    elif calorie_target_adherence_pct is not None or protein_target_adherence_pct is not None:
        parts = [f"{days_logged}/{days} days logged"]
        if calorie_target_adherence_pct is not None:
            parts.append(f"{calorie_target_adherence_pct:.0f}% calorie-target days")
        if protein_target_adherence_pct is not None:
            parts.append(f"{protein_target_adherence_pct:.0f}% protein-target days")
        summary = "Nutrition read: " + " · ".join(parts) + "."
    else:
        summary = (
            f"Nutrition read: {days_logged}/{days} days logged, "
            f"averaging {avg_calories:.0f} kcal, {avg_protein:.0f}g protein, and {avg_fiber:.0f}g fiber."
        )

    return summary, notes


def _build_headline(
    *,
    goal_bucket: str,
    sessions_completed: int,
    sessions_planned: int,
    adherence_pct: float,
    volume: WeeklyVolumeSnapshot,
    weight_trend_direction: str,
    poor_recovery: bool,
    avg_sleep_hours: float | None,
) -> str:
    """One-sentence summary for the top of the weekly card. Built
    deterministically so a tester can read the rules; AI takes it from
    here only for polish in the check-in coach."""
    if sessions_planned == 0 and sessions_completed == 0:
        return "Set up a workout plan to unlock weekly coaching."
    if sessions_completed == 0:
        return "No sessions logged this week — even one unlocks the coaching flow."
    if poor_recovery:
        return (
            f"You completed {sessions_completed}/{sessions_planned} sessions, but "
            + (f"sleep averaged {avg_sleep_hours:.1f}h" if avg_sleep_hours else "readiness is low")
            + ". Hold the plan — recover first."
        )
    severe_volume = _severe_volume_muscles(volume)
    if severe_volume:
        return (
            f"Strong week ({sessions_completed}/{sessions_planned}). "
            f"Volume for {', '.join(severe_volume)} needs a check — ease off one accessory."
        )
    if adherence_pct >= 85:
        if weight_trend_direction == "flat" and goal_bucket in ("muscle_gain", "body_recomp"):
            return f"Solid {sessions_completed}/{sessions_planned} week. Weight's stable — keep the plan."
        return f"Solid {sessions_completed}/{sessions_planned} week. Stay the course."
    if adherence_pct < 65:
        return (
            f"{sessions_completed}/{sessions_planned} sessions — life happens. "
            "Consider dropping one day so the plan fits your real week."
        )
    return f"{sessions_completed}/{sessions_planned} sessions this week."


def _severe_volume_muscles(volume: WeeklyVolumeSnapshot) -> list[str]:
    return [
        muscle
        for muscle, row in volume.by_muscle.items()
        if getattr(row, "status", "") in {"excessive", "spike"}
    ]
