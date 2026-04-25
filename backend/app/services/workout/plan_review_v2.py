"""Deterministic weekly plan review — v2.

Replaces the legacy AI plan_review (permanently disabled). Emits
structured, actionable recommendations from existing signals:

  - Weekly volume by muscle group  (weekly_volume.compute_weekly_volume)
  - Session adherence              (completed vs planned)
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

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

from sqlmodel import select

from app.models import (
    DailyNutritionMetrics, UserGoal, WorkoutCompletion, WorkoutPlan,
)
from app.services.workout.weekly_volume import (
    WeeklyVolumeSnapshot, compute_weekly_volume,
)

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
    cardio_minutes: float
    zone2_minutes: float
    volume: WeeklyVolumeSnapshot
    # Nutrition signals — averaged over the window.
    nutrition_adherence_pct: float = 0.0
    days_logged: int = 0
    avg_protein_g: float = 0.0
    avg_fiber_g: float = 0.0
    # Weight trend signals.
    weight_trend_lbs_per_week: float | None = None
    weight_trend_direction: str = "flat"    # "up" | "down" | "flat" | "unknown"
    # Recovery signals (averages; each card still owns the daily view).
    avg_sleep_hours: float | None = None
    avg_resting_hr: float | None = None
    # One-sentence summary the UI can use as the card headline.
    headline: str = ""
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
            "cardio_minutes": round(self.cardio_minutes, 0),
            "zone2_minutes": round(self.zone2_minutes, 0),
            "volume": self.volume.to_dict(),
            "nutrition_adherence_pct": round(self.nutrition_adherence_pct, 1),
            "days_logged": self.days_logged,
            "avg_protein_g": round(self.avg_protein_g, 1),
            "avg_fiber_g": round(self.avg_fiber_g, 1),
            "weight_trend_lbs_per_week": self.weight_trend_lbs_per_week,
            "weight_trend_direction": self.weight_trend_direction,
            "avg_sleep_hours": self.avg_sleep_hours,
            "avg_resting_hr": self.avg_resting_hr,
            "headline": self.headline,
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

# Adherence threshold below which we suggest reducing planned volume
# rather than trying to cram more in. "You're missing sessions — the
# plan is too ambitious" is often the right call for 3-week streaks.
_LOW_ADHERENCE_PCT = 65.0


def _sum_cardio_minutes(completions: list[WorkoutCompletion]) -> tuple[float, float]:
    """Total cardio minutes + zone-2 minutes in the window. Zone 2 is
    identified by cardio_style="steady" OR activity_intensity="easy"."""
    total = 0.0
    zone2 = 0.0
    for c in completions:
        if c.activity_category != "cardio":
            continue
        mins = (c.duration_seconds or 0) / 60.0
        total += mins
        style = (c.cardio_style or "").lower()
        intensity = (c.activity_intensity or "").lower()
        if style == "steady" or intensity == "easy":
            zone2 += mins
    return total, zone2


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

    # Active goal — drives targets.
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()
    goal_bucket = (goal.goal_type.value if goal and hasattr(goal.goal_type, "value") else None) or "general_health"

    # Completions in window.
    completions = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= start)
        .where(WorkoutCompletion.workout_date <= end_date)
    ).all()

    # Planned sessions.
    plan = db.exec(
        select(WorkoutPlan)
        .where(WorkoutPlan.user_id == user_id, WorkoutPlan.is_active == True)
    ).first()
    planned = 0
    # NOTE: WorkoutPlan column is `plan_json` (singular). The plural
    # `plans_json` lives on NutritionPlan only — easy to mix up.
    if plan and plan.plan_json:
        try:
            days_list = plan.plan_json.get("days") or []
            planned = len([d for d in days_list if d.get("focus") and (d.get("focus") or "").lower() != "rest"])
        except Exception:
            planned = 0

    adherence_pct = (
        100.0 * len(completions) / planned
        if planned > 0 else 0.0
    )
    cardio_mins, zone2_mins = _sum_cardio_minutes(completions)
    volume = compute_weekly_volume(db, user_id, end_date=end_date, days=days)

    # Nutrition signals — averaged over the window from DailyNutritionMetrics.
    nutrition_rows = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= start)
        .where(DailyNutritionMetrics.metric_date <= end_date)
    ).all()
    days_logged = len(nutrition_rows)
    avg_protein = (
        sum((r.plant_protein_g or 0) + (r.animal_protein_g or 0) for r in nutrition_rows) / days_logged
        if days_logged > 0 else 0.0
    )
    avg_fiber = (
        sum(r.fiber_total_g or 0 for r in nutrition_rows) / days_logged
        if days_logged > 0 else 0.0
    )
    # Nutrition adherence proxy = % of days with at least 50% of target kcal
    # logged. Conservative — cheaper than the full adherence engine and
    # still catches "user forgot to log half the week".
    nutrition_adherence_pct = 100.0 * days_logged / days if days > 0 else 0.0

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

    # 1. Adherence → reduce days if consistently missing.
    if planned >= 3 and adherence_pct < _LOW_ADHERENCE_PCT:
        recs.append(Recommendation(
            key="reduce_days",
            area="workout",
            priority="suggest",
            title=f"Drop to {max(2, planned - 1)} days / week",
            detail=(
                f"You completed {len(completions)} of {planned} planned sessions "
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
        elif mv.status == "high" and mv.range_max is not None:
            recs.append(Recommendation(
                key=f"reduce_volume_{muscle}",
                area="workout",
                priority="suggest",
                title=f"Reduce {muscle} volume",
                detail=(
                    f"{mv.total_sets:.0f} hard sets this week is above the "
                    f"{mv.range_min}–{mv.range_max} range. Drop one accessory."
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
        if avg_protein > 0 and avg_protein < 100:
            recs.append(Recommendation(
                key="raise_protein",
                area="nutrition",
                priority="info",
                title="Protein below target",
                detail=(
                    f"Averaging {avg_protein:.0f}g protein/day over "
                    f"{days_logged} logged days. Aim for 0.8–1g per lb of "
                    "bodyweight to protect muscle."
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
    elif nutrition_adherence_pct < 50 and planned > 0:
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
        sessions_completed=len(completions),
        sessions_planned=planned,
        adherence_pct=adherence_pct,
        volume=volume,
        weight_trend_direction=weight_trend_direction,
        poor_recovery=poor_recovery,
        avg_sleep_hours=avg_sleep_hours,
    )

    return WeeklyReview(
        user_id=user_id,
        week_start=start,
        week_end=end_date,
        goal=goal_bucket,
        sessions_completed=len(completions),
        sessions_planned=planned,
        adherence_pct=adherence_pct,
        cardio_minutes=cardio_mins,
        zone2_minutes=zone2_mins,
        volume=volume,
        nutrition_adherence_pct=nutrition_adherence_pct,
        days_logged=days_logged,
        avg_protein_g=avg_protein,
        avg_fiber_g=avg_fiber,
        weight_trend_lbs_per_week=weight_trend_lbs_per_week,
        weight_trend_direction=weight_trend_direction,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        headline=headline,
        recommendations=recs,
    )


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
    if volume.muscles_high():
        return (
            f"Strong week ({sessions_completed}/{sessions_planned}). "
            f"Volume for {', '.join(volume.muscles_high())} is running high — ease off one accessory."
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
