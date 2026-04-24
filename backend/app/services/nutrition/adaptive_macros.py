"""Adaptive calorie / macro recommendations — deterministic (no AI).

Uses logged intake + weight-trend slope to estimate actual maintenance
calories (TDEE) over the last 14 days. When confidence is too low, the
function returns a "need_more_data" result and the UI explains why
rather than silently adjusting targets.

Math:
    avg_daily_calories    = mean of last 14 days' logged calories
    weekly_weight_change  = trend_today - trend_7_days_ago (EMA)
    daily_energy_delta    = weekly_weight_change * 3500 / 7
    estimated_tdee        = avg_daily_calories - daily_energy_delta

Smoothing: target adjustments capped at ±150 kcal/week unless the
current target is clearly wrong (estimate differs by >500 kcal).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.models import DailyNutritionMetrics, UserProfile, WorkoutCompletion


# Minimum confidence thresholds — below these, do not adjust.
MIN_LOGGED_DAYS = 10             # out of last 14
MIN_WEIGH_INS_7D = 3
MAX_WEEKLY_TARGET_DELTA = 150    # kcal
# When the estimated TDEE diverges from current target by this much we
# allow a bigger one-shot adjustment (the target was clearly wrong).
CLEARLY_WRONG_THRESHOLD = 500


@dataclass
class AdaptiveRecommendation:
    status: str                           # "ok" | "need_more_data"
    estimated_tdee: int | None = None
    current_target: int | None = None
    suggested_target: int | None = None
    delta: int | None = None
    avg_daily_calories: int | None = None
    weekly_weight_change_lbs: float | None = None
    days_logged: int = 0
    weigh_ins: int = 0
    confidence: str = "low"
    reason: str = ""
    # Goal-driven framing the card uses for the "Why" line.
    goal_bucket: str | None = None


def _get_trend_weight(weight_entries: list[dict], target_date: date) -> float | None:
    """Return the EMA-smoothed weight at `target_date` from a list of
    {date, weight_lbs} entries. Falls back to raw value if fewer than
    3 points. Mirrors the client's trend logic in weightTrend.ts.
    """
    # Use only entries on or before target_date, sorted.
    rows = [
        (e["date"], float(e["weight_lbs"]))
        for e in weight_entries
        if e.get("date") and e.get("weight_lbs") is not None
    ]
    rows = [(d, w) for d, w in rows if d <= target_date]
    if not rows:
        return None
    rows.sort(key=lambda t: t[0])
    if len(rows) < 3:
        return rows[-1][1]
    # EMA with alpha 0.1 — slow, matches client trend.
    ema = rows[0][1]
    alpha = 0.1
    for _, w in rows[1:]:
        ema = alpha * w + (1 - alpha) * ema
    return ema


def _goal_target_range(goal_bucket: str | None, tdee: float) -> tuple[int, int, str]:
    """Return (min, max, rationale) bracket for a given goal. Defaults
    to maintenance when the goal is unknown."""
    bucket = (goal_bucket or "").lower()
    if bucket == "fat_loss":
        return int(tdee - 600), int(tdee - 300), "Deficit for fat loss (~300-600 kcal below maintenance)"
    if bucket == "body_recomp":
        return int(tdee - 250), int(tdee - 100), "Slight deficit for body recomposition"
    if bucket == "muscle_gain":
        return int(tdee + 150), int(tdee + 300), "Surplus for lean muscle gain (~150-300 kcal above maintenance)"
    if bucket == "strength":
        return int(tdee), int(tdee + 250), "Maintenance to slight surplus for strength work"
    if bucket == "endurance":
        return int(tdee), int(tdee + 200), "Maintenance-plus for training fuel (carbs take priority on hard days)"
    # general_health / longevity / maintain
    return int(tdee - 100), int(tdee + 50), "Maintenance"


def compute_adaptive_recommendation(
    db: Session,
    user_id: int,
    profile_goal: str | None = None,
    current_target_kcal: int | None = None,
    weight_entries: list[dict] | None = None,
) -> AdaptiveRecommendation:
    """Entry point — computes the rec for one user.
    `weight_entries` expected as [{date, weight_lbs}, ...]. Client-side
    weight tracking feeds this through the POST endpoint.
    """
    today = date.today()
    since = today - timedelta(days=13)   # inclusive 14-day window

    rows = db.exec(
        select(DailyNutritionMetrics).where(
            DailyNutritionMetrics.user_id == user_id,
            DailyNutritionMetrics.metric_date >= since,
        )
    ).all()
    # Only count days with enough food logged (>= 500 kcal) to avoid
    # blank / partial days dragging the average down.
    valid_rows = [r for r in rows if (r.calories_total or 0) >= 500]
    days_logged = len(valid_rows)
    avg_daily_cals = int(sum((r.calories_total or 0) for r in valid_rows) / days_logged) if days_logged > 0 else 0

    entries = weight_entries or []
    weigh_ins_7d = sum(
        1 for e in entries
        if e.get("date") and (today - e["date"]).days <= 7
    )

    if days_logged < MIN_LOGGED_DAYS:
        return AdaptiveRecommendation(
            status="need_more_data",
            days_logged=days_logged, weigh_ins=weigh_ins_7d,
            confidence="low",
            reason=f"Need {MIN_LOGGED_DAYS}+ logged days in the last 14 for accurate estimates (you have {days_logged}).",
            goal_bucket=profile_goal,
            current_target=current_target_kcal,
        )

    trend_today = _get_trend_weight(entries, today)
    trend_week_ago = _get_trend_weight(entries, today - timedelta(days=7))

    if trend_today is None or trend_week_ago is None or weigh_ins_7d < MIN_WEIGH_INS_7D:
        # Fall back to food-only estimate: assume current intake IS
        # maintenance (user is presumably weight-stable if they're not
        # weighing regularly).
        return AdaptiveRecommendation(
            status="need_more_data",
            avg_daily_calories=avg_daily_cals,
            days_logged=days_logged, weigh_ins=weigh_ins_7d,
            confidence="low",
            reason=f"Need {MIN_WEIGH_INS_7D}+ weigh-ins in the last 7 days to detect weight trend (you have {weigh_ins_7d}).",
            goal_bucket=profile_goal,
            current_target=current_target_kcal,
        )

    weekly_change = round(trend_today - trend_week_ago, 2)
    daily_energy_delta = weekly_change * 3500.0 / 7.0
    tdee = avg_daily_cals - daily_energy_delta
    # Sanity clamp — extreme TDEEs usually mean a logging glitch, not
    # genuine metabolic variance. Cap at ±600 kcal from intake.
    tdee = max(avg_daily_cals - 600, min(avg_daily_cals + 600, tdee))

    # Confidence: high if we have full logging + 5+ weigh-ins; medium
    # otherwise (but still above the hard floor).
    if days_logged >= 12 and weigh_ins_7d >= 5:
        confidence = "high"
    else:
        confidence = "medium"

    # Goal-driven target range.
    lo, hi, rationale = _goal_target_range(profile_goal, tdee)
    # Suggested target: midpoint of the range, unless current_target is
    # already inside the range (then keep it — don't move for no reason).
    if current_target_kcal and lo <= current_target_kcal <= hi:
        suggested = current_target_kcal
        reason = f"Your current target is already in the right range for {profile_goal or 'your goal'}."
    else:
        suggested = int((lo + hi) / 2)
        reason = rationale

    # Smoothing: cap delta at MAX_WEEKLY_TARGET_DELTA unless the current
    # target is clearly wrong.
    if current_target_kcal is not None:
        raw_delta = suggested - current_target_kcal
        if abs(raw_delta) > CLEARLY_WRONG_THRESHOLD:
            # Clearly wrong — allow a bigger jump but still cap at 400.
            if raw_delta > 0:
                suggested = current_target_kcal + min(raw_delta, 400)
            else:
                suggested = current_target_kcal + max(raw_delta, -400)
        elif abs(raw_delta) > MAX_WEEKLY_TARGET_DELTA:
            if raw_delta > 0:
                suggested = current_target_kcal + MAX_WEEKLY_TARGET_DELTA
            else:
                suggested = current_target_kcal - MAX_WEEKLY_TARGET_DELTA
        delta = suggested - current_target_kcal
    else:
        delta = None

    return AdaptiveRecommendation(
        status="ok",
        estimated_tdee=int(tdee),
        current_target=current_target_kcal,
        suggested_target=int(suggested),
        delta=int(delta) if delta is not None else None,
        avg_daily_calories=avg_daily_cals,
        weekly_weight_change_lbs=weekly_change,
        days_logged=days_logged,
        weigh_ins=weigh_ins_7d,
        confidence=confidence,
        reason=reason,
        goal_bucket=profile_goal,
    )
