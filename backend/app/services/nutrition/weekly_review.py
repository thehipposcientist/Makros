"""Deterministic weekly nutrition review.

Mirrors plan_review_v2.compute_weekly_review but focused entirely on
nutrition:

  - Planned daily targets from CalorieTargets (+ UserCoachingState adjustment)
  - Actual intake from DailyRollup rows for the window
  - Meal-type breakdown from Meal rows (logged instances per slot)
  - Weight trend extracted from DailyRollup.weight_lbs when available
  - 3–5 deterministic coaching recommendations

No LLM calls. No punitive language — the review coaches patterns, not
outcomes. Every rule that fires attaches a structured `action` so the
UI can accept / dismiss without another AI round-trip.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from sqlmodel import select

from app.models import (
    DailyRollup, Meal, UserCoachingState, UserGoal, UserProfile,
)

Priority = Literal["info", "suggest", "warn"]
Area = Literal["workout", "nutrition", "recovery", "cardio"]


@dataclass
class NutritionRecommendation:
    """A single targeted coaching nudge. Identical shape to
    plan_review_v2.Recommendation so apply_action handles both."""
    key: str
    area: Area
    priority: Priority
    title: str
    detail: str
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
class WeeklyNutritionReview:
    """Full weekly nutrition picture + coaching recommendations."""
    user_id: int
    week_start: date
    week_end: date
    goal: str

    # Planned (computed from CalorieTargets for this user)
    planned_calories: int
    planned_protein_g: int
    planned_carbs_g: int
    planned_fat_g: int

    # Actuals (averaged over logged days from DailyRollup)
    days_logged: int
    avg_actual_calories: float
    avg_actual_protein_g: float
    avg_actual_carbs_g: float
    avg_actual_fat_g: float

    # Deltas (actual − planned, daily average; negative = under target)
    calorie_delta_daily_avg: float
    protein_delta_daily_avg: float

    # Adherence
    kcal_adherence_pct: float      # % of logged days within ±5% of kcal target
    protein_hit_pct: float         # % of logged days protein ≥95% of target

    # Meal type breakdown: {meal_type_str → {"days_logged": int, "avg_calories": float}}
    meal_type_breakdown: dict[str, dict]

    # Days in the window with no logged meals
    unlogged_days: int

    # Weight trend (None when no weight data in window)
    weight_trend_lbs_per_week: float | None
    weight_trend_direction: str    # "up" | "down" | "flat" | "unknown"

    # Coaching output
    headline: str
    recommendations: list[NutritionRecommendation] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "week_start": str(self.week_start),
            "week_end": str(self.week_end),
            "goal": self.goal,
            "planned_calories": self.planned_calories,
            "planned_protein_g": self.planned_protein_g,
            "planned_carbs_g": self.planned_carbs_g,
            "planned_fat_g": self.planned_fat_g,
            "days_logged": self.days_logged,
            "avg_actual_calories": round(self.avg_actual_calories, 1),
            "avg_actual_protein_g": round(self.avg_actual_protein_g, 1),
            "avg_actual_carbs_g": round(self.avg_actual_carbs_g, 1),
            "avg_actual_fat_g": round(self.avg_actual_fat_g, 1),
            "calorie_delta_daily_avg": round(self.calorie_delta_daily_avg, 1),
            "protein_delta_daily_avg": round(self.protein_delta_daily_avg, 1),
            "kcal_adherence_pct": round(self.kcal_adherence_pct, 1),
            "protein_hit_pct": round(self.protein_hit_pct, 1),
            "meal_type_breakdown": self.meal_type_breakdown,
            "unlogged_days": self.unlogged_days,
            "weight_trend_lbs_per_week": self.weight_trend_lbs_per_week,
            "weight_trend_direction": self.weight_trend_direction,
            "headline": self.headline,
            "recommendations": [r.to_dict() for r in self.recommendations],
        }


# ── Calorie adherence tolerance ────────────────────────────────────────────────
# A day is "on target" when actual kcal is within this band of the planned target.
_KCAL_ADHERENCE_BAND = 0.05   # ±5%; ±10% is close, not fully on target
_PROTEIN_HIT_FLOOR   = 0.95   # 95% of target counts as a protein hit

# Days with no logged meals are "unlogged" — not penalised, but counted.
_MIN_DAYS_FOR_COACHING = 3    # below this, only fire a logging nudge

# Weekend drift: flag when weekend avg exceeds weekday avg by this many kcal.
_WEEKEND_DRIFT_THRESHOLD = 400  # kcal


def _goal_str(goal_row: UserGoal | None) -> str:
    if goal_row is None:
        return "general_health"
    gt = goal_row.goal_type
    return gt.value if hasattr(gt, "value") else str(gt)


def _compute_planned_targets(
    db: Any,
    user_id: int,
) -> tuple[int, int, int, int]:
    """Return the same adaptive targets used by scoring and plan generation."""
    from app.services.nutrition.targets import resolve_targets_for_user

    targets = resolve_targets_for_user(db, user_id)
    if not targets:
        return 2000, 150, 200, 70   # safe fallback
    return targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g


def _weight_trend(rollups: list[DailyRollup]) -> float | None:
    """Compute lbs/week linear slope from DailyRollup.weight_lbs.
    Returns None when fewer than 3 weight readings exist."""
    pts = [(r.day.toordinal(), r.weight_lbs) for r in rollups if r.weight_lbs is not None]
    if len(pts) < 3:
        return None
    n = len(pts)
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return None
    slope_per_day = num / den
    return slope_per_day * 7   # convert to lbs/week


def _trend_direction(lbs_per_week: float | None) -> str:
    if lbs_per_week is None:
        return "unknown"
    if lbs_per_week > 0.15:
        return "up"
    if lbs_per_week < -0.15:
        return "down"
    return "flat"


def _meal_type_breakdown(db: Any, user_id: int, start: date, end: date) -> dict[str, dict]:
    """Count logged instances and average calories per meal_type slot."""
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(Meal.meal_date >= start)
        .where(Meal.meal_date <= end)
    ).all()

    slot_days: dict[str, set] = {}   # slot → set of dates logged
    slot_kcal: dict[str, list] = {}

    for m in meals:
        slot = m.meal_type.value if hasattr(m.meal_type, "value") else str(m.meal_type)
        slot_days.setdefault(slot, set()).add(m.meal_date)
        # We don't JOIN to MealItem here to keep this query cheap —
        # DailyRollup already has the total kcal per day for the macro view.
        # Meal-type breakdown is used for pattern coaching (e.g., "breakfast
        # only logged 2 days") not precise per-slot macro math.
        slot_kcal.setdefault(slot, [])

    return {
        slot: {"days_logged": len(dates)}
        for slot, dates in slot_days.items()
    }


def _build_headline(
    *,
    goal: str,
    days_logged: int,
    window: int,
    kcal_adherence_pct: float,
    protein_hit_pct: float,
    calorie_delta: float,
    weight_trend_direction: str,
) -> str:
    if days_logged == 0:
        return "Log your first meal this week to unlock nutrition coaching."
    if days_logged < _MIN_DAYS_FOR_COACHING:
        return (
            f"{days_logged} of {window} days logged. "
            "A few more days of logging unlocks full nutrition coaching."
        )
    if kcal_adherence_pct >= 80 and protein_hit_pct >= 70:
        if goal in ("muscle_gain", "body_recomp") and weight_trend_direction == "up":
            return "Solid week — calories on target and weight trending up. Keep it going."
        if goal == "fat_loss" and weight_trend_direction in ("down", "flat"):
            return "Good consistency this week. Calories tracked well."
        return "Consistent week on both calories and protein. Keep the pattern."
    if kcal_adherence_pct < 50:
        if calorie_delta < -300:
            return (
                f"Logged {days_logged}/{window} days — averaging well under target. "
                "Adding more to a few meals would close the gap."
            )
        return f"Logged {days_logged}/{window} days. Consistency builds momentum."
    if protein_hit_pct < 50:
        return (
            f"Calories looked reasonable on {days_logged} logged days. "
            "Protein was the main gap — a small shift there helps."
        )
    return f"{days_logged} of {window} days logged this week."


def compute_weekly_nutrition_review(
    db: Any,
    user_id: int,
    *,
    week_start: date | None = None,
) -> WeeklyNutritionReview:
    """Produce a full weekly nutrition review with structured recommendations.

    `week_start` defaults to the most recent Monday. Pass an explicit
    date to review a prior week.

    All computations are deterministic — same data, same review. No AI.
    Recommendations are pattern-based and never punitive.
    """
    today = date.today()
    if week_start is None:
        week_start = today - timedelta(days=today.weekday())   # most recent Monday
    week_end = week_start + timedelta(days=6)

    # Window is always 7 days; clamp end to today for current week.
    window_end = min(week_end, today)
    window_days = (window_end - week_start).days + 1

    goal_row = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()
    goal = _goal_str(goal_row)

    # Planned targets
    planned_cal, planned_prot, planned_carbs, planned_fat = _compute_planned_targets(db, user_id)

    # Actual intake from DailyRollup
    rollups: list[DailyRollup] = db.exec(
        select(DailyRollup)
        .where(DailyRollup.user_id == user_id)
        .where(DailyRollup.day >= week_start)
        .where(DailyRollup.day <= window_end)
    ).all()

    logged_rollups = [r for r in rollups if (r.meals_logged or 0) > 0]
    days_logged = len(logged_rollups)

    if days_logged > 0:
        avg_kcal   = sum(r.kcal or 0 for r in logged_rollups) / days_logged
        avg_prot   = sum(r.protein_g or 0 for r in logged_rollups) / days_logged
        avg_carbs  = sum(r.carbs_g or 0 for r in logged_rollups) / days_logged
        avg_fat    = sum(r.fat_g or 0 for r in logged_rollups) / days_logged
    else:
        avg_kcal = avg_prot = avg_carbs = avg_fat = 0.0

    cal_delta  = avg_kcal - planned_cal
    prot_delta = avg_prot - planned_prot

    # Adherence per logged day
    on_target_kcal = sum(
        1 for r in logged_rollups
        if abs((r.kcal or 0) - planned_cal) / max(planned_cal, 1) <= _KCAL_ADHERENCE_BAND
    )
    kcal_adherence_pct = 100.0 * on_target_kcal / days_logged if days_logged else 0.0

    protein_hits = sum(
        1 for r in logged_rollups
        if (r.protein_g or 0) >= planned_prot * _PROTEIN_HIT_FLOOR
    )
    protein_hit_pct = 100.0 * protein_hits / days_logged if days_logged else 0.0

    unlogged_days = window_days - days_logged

    # Weight trend
    trend_lbs = _weight_trend(rollups)
    trend_dir = _trend_direction(trend_lbs)

    # Meal type breakdown
    meal_breakdown = _meal_type_breakdown(db, user_id, week_start, window_end)

    # ── Build recommendations ────────────────────────────────────────────────
    recs: list[NutritionRecommendation] = []

    # Gate: not enough data — fire logging nudge only.
    if days_logged < _MIN_DAYS_FOR_COACHING:
        recs.append(NutritionRecommendation(
            key="log_more_meals",
            area="nutrition",
            priority="info",
            title="Log a few more days",
            detail=(
                f"You've logged {days_logged} of {window_days} days so far. "
                "Tracking 4+ days each week lets us give you accurate "
                "calorie and protein feedback."
            ),
            action={"type": "increase_meal_logging"},
        ))
        headline = _build_headline(
            goal=goal, days_logged=days_logged, window=window_days,
            kcal_adherence_pct=0.0, protein_hit_pct=0.0,
            calorie_delta=cal_delta, weight_trend_direction=trend_dir,
        )
        return WeeklyNutritionReview(
            user_id=user_id, week_start=week_start, week_end=week_end, goal=goal,
            planned_calories=planned_cal, planned_protein_g=planned_prot,
            planned_carbs_g=planned_carbs, planned_fat_g=planned_fat,
            days_logged=days_logged, avg_actual_calories=avg_kcal,
            avg_actual_protein_g=avg_prot, avg_actual_carbs_g=avg_carbs,
            avg_actual_fat_g=avg_fat, calorie_delta_daily_avg=cal_delta,
            protein_delta_daily_avg=prot_delta,
            kcal_adherence_pct=kcal_adherence_pct, protein_hit_pct=protein_hit_pct,
            meal_type_breakdown=meal_breakdown, unlogged_days=unlogged_days,
            weight_trend_lbs_per_week=trend_lbs, weight_trend_direction=trend_dir,
            headline=headline, recommendations=recs,
        )

    # 1. Protein consistently low
    if avg_prot > 0 and avg_prot < planned_prot * 0.75:
        recs.append(NutritionRecommendation(
            key="raise_protein",
            area="nutrition",
            priority="suggest",
            title="Protein has room to grow",
            detail=(
                f"You averaged {avg_prot:.0f}g protein/day vs your "
                f"{planned_prot}g target. Adding protein to one meal — "
                "Greek yogurt, eggs, or a shake — closes most of the gap."
            ),
            action={"type": "adjust_protein_target"},
            # TODO: persist protein preference once UserCoachingState
            # has a protein_adjustment field. Currently advisory only.
        ))

    # 2. Protein inconsistent (some good days, some low)
    elif avg_prot >= planned_prot * 0.75 and protein_hit_pct < 50:
        recs.append(NutritionRecommendation(
            key="improve_protein_consistency",
            area="nutrition",
            priority="info",
            title="Protein is inconsistent day to day",
            detail=(
                f"You hit your protein target on {protein_hit_pct:.0f}% of "
                "logged days. Front-loading protein at breakfast makes the "
                "rest of the day easier to hit."
            ),
            action={"type": "improve_protein_consistency"},
        ))

    # 3. Calorie underfeed — not aligned with goal
    if cal_delta < -250 and goal not in ("fat_loss", "body_recomp"):
        recs.append(NutritionRecommendation(
            key="undereating_for_goal",
            area="nutrition",
            priority="suggest",
            title="Calories are below your target",
            detail=(
                f"You averaged {avg_kcal:.0f} kcal/day vs your {planned_cal} "
                f"target — a {abs(cal_delta):.0f} kcal daily gap. For "
                f"{goal.replace('_', ' ')}, fuelling properly protects "
                "muscle and performance."
            ),
            action={"type": "adjust_calorie_target", "delta": min(150, int(abs(cal_delta) * 0.5))},
        ))

    # 4. Calorie overshoot — misaligned with fat-loss goal
    elif cal_delta > 300 and goal == "fat_loss":
        recs.append(NutritionRecommendation(
            key="overeating_for_goal",
            area="nutrition",
            priority="suggest",
            title="Calories are running over target",
            detail=(
                f"You averaged {avg_kcal:.0f} kcal/day vs your {planned_cal} "
                f"target. A {cal_delta:.0f} kcal surplus makes the fat-loss "
                "goal harder to reach. Trimming one high-calorie item per "
                "day is usually enough."
            ),
            action={"type": "adjust_calorie_target", "delta": -min(150, int(cal_delta * 0.5))},
        ))

    # 5. Weight trend vs goal
    if trend_lbs is not None:
        if goal == "fat_loss" and trend_lbs < -1.5:
            recs.append(NutritionRecommendation(
                key="weight_loss_too_fast",
                area="nutrition",
                priority="warn",
                title="Weight dropping faster than ideal",
                detail=(
                    f"You're losing ~{abs(trend_lbs):.1f} lb/week — above the "
                    "0.5–1 lb/week range that protects muscle. Adding ~150 kcal "
                    "slows the pace without stalling progress."
                ),
                action={"type": "adjust_calorie_target", "delta": 150},
            ))
        elif goal in ("muscle_gain",) and trend_lbs < -0.2:
            recs.append(NutritionRecommendation(
                key="losing_weight_while_bulking",
                area="nutrition",
                priority="warn",
                title="Weight is trending down in a muscle-gain phase",
                detail=(
                    f"Trending at {trend_lbs:.1f} lb/week while in a muscle-gain "
                    "phase means you're likely not eating enough to build. "
                    "Add ~200 kcal — an extra meal or larger portions."
                ),
                action={"type": "adjust_calorie_target", "delta": 200},
            ))
        elif goal in ("muscle_gain",) and trend_lbs > 1.2:
            recs.append(NutritionRecommendation(
                key="weight_gain_too_fast",
                area="nutrition",
                priority="suggest",
                title="Weight gaining quickly",
                detail=(
                    f"Gaining {trend_lbs:.1f} lb/week tilts the ratio toward "
                    "fat over muscle. Trimming ~150 kcal keeps the pace "
                    "closer to lean gains."
                ),
                action={"type": "adjust_calorie_target", "delta": -150},
            ))

    # 6. Weekend drift (only if >= 5 logged days — need enough data)
    if days_logged >= 5:
        weekday_rollups = [r for r in logged_rollups if r.day.weekday() < 5]
        weekend_rollups = [r for r in logged_rollups if r.day.weekday() >= 5]
        if weekday_rollups and weekend_rollups:
            wday_avg = sum(r.kcal or 0 for r in weekday_rollups) / len(weekday_rollups)
            wend_avg = sum(r.kcal or 0 for r in weekend_rollups) / len(weekend_rollups)
            if wend_avg - wday_avg > _WEEKEND_DRIFT_THRESHOLD:
                recs.append(NutritionRecommendation(
                    key="weekend_drift",
                    area="nutrition",
                    priority="info",
                    title="Weekend calories are noticeably higher",
                    detail=(
                        f"Weekdays averaged {wday_avg:.0f} kcal vs "
                        f"{wend_avg:.0f} kcal on weekends. A little drift is "
                        "normal — just worth knowing if the weekly total matters."
                    ),
                    action={"type": "adjust_meal_timing"},
                ))

    # 7. Incomplete logging reminder (softer than the gate above)
    if unlogged_days >= 3 and days_logged >= _MIN_DAYS_FOR_COACHING:
        recs.append(NutritionRecommendation(
            key="log_more_days",
            area="nutrition",
            priority="info",
            title="More logged days = better coaching",
            detail=(
                f"{unlogged_days} days this week were unlogged. Even a rough "
                "estimate is enough — it doesn't need to be perfect."
            ),
            action={"type": "increase_meal_logging"},
        ))

    # Cap at 5 recommendations — same convention as plan_review_v2.
    recs = recs[:5]

    headline = _build_headline(
        goal=goal, days_logged=days_logged, window=window_days,
        kcal_adherence_pct=kcal_adherence_pct, protein_hit_pct=protein_hit_pct,
        calorie_delta=cal_delta, weight_trend_direction=trend_dir,
    )

    return WeeklyNutritionReview(
        user_id=user_id, week_start=week_start, week_end=week_end, goal=goal,
        planned_calories=planned_cal, planned_protein_g=planned_prot,
        planned_carbs_g=planned_carbs, planned_fat_g=planned_fat,
        days_logged=days_logged, avg_actual_calories=avg_kcal,
        avg_actual_protein_g=avg_prot, avg_actual_carbs_g=avg_carbs,
        avg_actual_fat_g=avg_fat, calorie_delta_daily_avg=cal_delta,
        protein_delta_daily_avg=prot_delta,
        kcal_adherence_pct=kcal_adherence_pct, protein_hit_pct=protein_hit_pct,
        meal_type_breakdown=meal_breakdown, unlogged_days=unlogged_days,
        weight_trend_lbs_per_week=trend_lbs, weight_trend_direction=trend_dir,
        headline=headline, recommendations=recs,
    )
