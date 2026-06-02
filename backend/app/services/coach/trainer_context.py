"""Trainer-question context enrichment.

The Home Trainer (POST /ai/trainer-question) historically received only
client-supplied context (profile, workout plan, meal plan, activity log).
The per-coach audit flagged that multiple server-side signals — readiness,
weight trend, active flags, coach memory, nutrition score, logged meals,
goal-timeline progress — were already computed but never passed to the
LLM, so answers were blinder than they had to be.

This module assembles those server-side signals into a compact dict
that gets merged onto the client-sent context blob before the LLM call.
Every block is defensive: if a dependency fails we simply omit the
block rather than failing the whole request.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.models import (
    User, UserProfile, UserGoal, UserFlag, AIDecision, CoachMemory,
    DailyHealthSnapshot, DailyNutritionMetrics, DailyStressSummary,
    Meal, MealItem, SleepLog, WeeklyCheckIn, WorkoutCompletion,
)
from app.services.health.stress_history import baseline_from_rows, stress_comparison


_GI_FOOD_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("beans_lentils_legumes", ("bean", "lentil", "chickpea", "hummus", "edamame", "legume", "pea protein")),
    ("cruciferous_veg", ("broccoli", "cauliflower", "brussels", "cabbage", "kale")),
    ("alliums", ("onion", "garlic", "shallot", "leek")),
    ("dairy_or_whey", ("milk", "cheese", "yogurt", "kefir", "whey", "casein", "cream")),
    ("sugar_alcohols_or_bars", ("sorbitol", "xylitol", "erythritol", "maltitol", "protein bar", "quest bar", "fiber bar")),
    ("carbonated_or_fermented_drink", ("sparkling", "seltzer", "soda", "kombucha")),
    ("high_fiber_grains", ("oats", "bran", "whole wheat", "fiber cereal")),
)


def enrich(
    user_id: int,
    db: Session,
    *,
    include_recent_meals: bool = False,
    include_caffeine_alcohol: bool = False,
    include_fiber_micros: bool = False,
) -> dict[str, Any]:
    """Return the set of optional server-computed context blocks the
    trainer coach should see. Keys are only present when data exists.

    Blocks (always attempted — small + broadly useful):
      readiness                — {score, top_fatigued, blocked_focuses}
      weight_trend             — {slope_lbs_per_wk, ema, last_5}
      active_flags             — list of {key, severity, value}
      coach_memory             — {last_decisions: [...], open_commitments: [...]}
      nutrition_signals        — {score, top_gaps, recovery_flags}
      logged_today             — {calories, protein_g, meal_count}
      stress_baseline          — {today_avg, usual_avg, delta, label}
      timeline_progress        — {pct_timeline_elapsed, pct_weight_delta_achieved, weeks_elapsed}
      heart_rate_recovery      — {hrv_today, hrv_7d_avg, rhr_today, rhr_7d_avg, trend}
      sleep_last_night         — {hours, deep_h, rem_h, score, rating, bedtime}
      cardio_load_recent       — {yesterday_trimp, last_7d_trimp, trend}

    Verbose blocks (intent-gated to keep prompts small):
      recent_meals             — opt-in via include_recent_meals
      caffeine_alcohol_recent  — opt-in via include_caffeine_alcohol; uses
                                 the trans-fat / alcohol / caffeine MealItem
                                 columns added in the 2026-05 nutrient expansion
      fiber_micros_7d          — opt-in via include_fiber_micros; 7-day
                                 fiber + sodium + omega-3 + key vitamins
                                 with a sudden-spike flag
    """
    out: dict[str, Any] = {}

    # Always-on fast signals.
    _try(lambda: _readiness(user_id, db), out, "readiness")
    _try(lambda: _weight_trend(user_id, db), out, "weight_trend")
    _try(lambda: _active_flags(user_id, db), out, "active_flags")
    _try(lambda: _coach_memory(user_id, db), out, "coach_memory")
    _try(lambda: _nutrition_signals(user_id, db), out, "nutrition_signals")
    _try(lambda: _logged_today(user_id, db), out, "logged_today")
    _try(lambda: _stress_baseline(user_id, db), out, "stress_baseline")
    _try(lambda: _timeline_progress(user_id, db), out, "timeline_progress")
    _try(lambda: _heart_rate_recovery(user_id, db), out, "heart_rate_recovery")
    _try(lambda: _sleep_last_night(user_id, db), out, "sleep_last_night")
    _try(lambda: _cardio_load_recent(user_id, db), out, "cardio_load_recent")

    # Intent-gated verbose blocks.
    if include_recent_meals:
        _try(lambda: _recent_meals_for_symptom_context(user_id, db), out, "recent_meals")
    if include_caffeine_alcohol:
        _try(lambda: _caffeine_alcohol_recent(user_id, db), out, "caffeine_alcohol_recent")
    if include_fiber_micros:
        _try(lambda: _fiber_micros_7d(user_id, db), out, "fiber_micros_7d")

    return out


def _try(fn, out: dict, key: str) -> None:
    """Run a block-builder; silently drop the block if it raises. Keeps
    enrichment strictly additive — the trainer request never fails
    because of a computed-context issue."""
    try:
        v = fn()
        if v:
            out[key] = v
    except Exception:
        pass


def _readiness(user_id: int, db: Session) -> dict | None:
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.services.workout.activity_impact import compute_rolling_fatigue
    completions = get_recent_completions_for_fatigue(user_id, db)
    if not completions:
        return None
    snap = compute_rolling_fatigue(completions)
    return {
        "score": snap.readiness_score,
        "label": snap.readiness_label,
        "top_fatigued": [{"muscle": m, "value": round(v, 2)} for m, v in (snap.top_fatigued or [])[:3]],
        "blocked_focuses": list(snap.blocked_focuses or []),
    }


def _weight_trend(user_id: int, db: Session) -> dict | None:
    rows = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id)
        .order_by(WeeklyCheckIn.checkin_date.desc())
        .limit(10)
    ).all()
    if len(rows) < 2:
        return None
    weights = [(r.checkin_date, float(r.weight_lbs)) for r in rows][::-1]  # oldest first
    # Simple slope: (latest − earliest) / weeks span.
    (d0, w0), (d1, w1) = weights[0], weights[-1]
    weeks = max(1.0, (d1 - d0).days / 7.0)
    slope = (w1 - w0) / weeks
    # EMA across the window, alpha=0.4 so recent weeks weight more.
    ema = w0
    for _, w in weights[1:]:
        ema = 0.4 * w + 0.6 * ema
    return {
        "slope_lbs_per_wk": round(slope, 2),
        "ema_lbs": round(ema, 1),
        "last_5": [{"date": str(d), "weight_lbs": w} for d, w in weights[-5:]],
    }


def _active_flags(user_id: int, db: Session) -> list[dict]:
    rows = db.exec(
        select(UserFlag).where(UserFlag.user_id == user_id)
    ).all()
    if not rows:
        return []
    return [
        {"key": f.key, "severity": f.severity, "value": f.value}
        for f in rows
        if f.severity in ("med", "high")
    ][:8]


def _coach_memory(user_id: int, db: Session) -> dict | None:
    dec_rows = db.exec(
        select(AIDecision)
        .where(AIDecision.user_id == user_id)
        .order_by(AIDecision.created_at.desc())
        .limit(3)
    ).all()
    mem_rows = db.exec(
        select(CoachMemory)
        .where(CoachMemory.user_id == user_id)
        .where(CoachMemory.event_type == "commitment")
        .order_by(CoachMemory.created_at.desc())
        .limit(3)
    ).all()
    if not dec_rows and not mem_rows:
        return None
    return {
        "last_decisions": [
            {
                "date": d.created_at.date().isoformat() if d.created_at else None,
                "type": d.response_type,
                "rationale": d.rationale_key,
                "delta": d.delta,
                "message": (d.message or "")[:180],
            }
            for d in dec_rows
        ],
        "open_commitments": [
            {
                "date": m.created_at.date().isoformat() if m.created_at else None,
                "summary": (m.summary or "")[:160],
            }
            for m in mem_rows
        ],
    }


def _nutrition_signals(user_id: int, db: Session) -> dict | None:
    try:
        from app.services.nutrition.score_builder import compute_today_score
        from app.services.nutrition.recovery_flags import compute_flags
    except Exception:
        return None
    try:
        today = compute_today_score(db, user_id)
    except Exception:
        today = None
    try:
        flags = compute_flags(db, user_id=user_id)
        flags_map = {f.key: f.state for f in flags if f.state in ("amber", "red")}
    except Exception:
        flags_map = {}
    if not today and not flags_map:
        return None
    block: dict[str, Any] = {}
    if today:
        block["score"] = today.get("score")
        block["confidence"] = today.get("confidence")
        # Top 2 improvements = biggest gaps.
        improvements = today.get("improvements") or []
        block["top_gaps"] = improvements[:2]
        wins = today.get("wins") or []
        block["wins"] = wins[:2]
    if flags_map:
        block["recovery_flags"] = flags_map
    return block


def _logged_today(user_id: int, db: Session) -> dict | None:
    today = date.today()
    meals = db.exec(
        select(Meal).where(Meal.user_id == user_id).where(Meal.meal_date == today)
    ).all()
    if not meals:
        return None
    meal_ids = [m.id for m in meals]
    items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
    cal = sum(float(i.calories or 0) for i in items)
    pro = sum(float(i.protein_g or 0) for i in items)
    return {
        "meal_count": len(meals),
        "item_count": len(items),
        "calories": round(cal),
        "protein_g": round(pro, 1),
    }


def _stress_baseline(user_id: int, db: Session) -> dict | None:
    today = date.today()
    rows = db.exec(
        select(DailyStressSummary)
        .where(DailyStressSummary.user_id == user_id)
        .where(DailyStressSummary.summary_date >= today - timedelta(days=14))
        .where(DailyStressSummary.summary_date <= today)
        .order_by(DailyStressSummary.summary_date.asc())
    ).all()
    today_row = next((row for row in rows if row.summary_date == today), None)
    baseline = baseline_from_rows(rows, as_of=today, baseline_days=14)
    if not today_row and not baseline:
        return None
    comparison = stress_comparison(
        float(today_row.avg_stress) if today_row else None,
        baseline.avg_stress if baseline else None,
    )
    out: dict[str, Any] = {
        "today_avg": round(float(today_row.avg_stress), 1) if today_row else None,
        "usual_avg": baseline.avg_stress if baseline else None,
        "days_with_data": baseline.days_with_data if baseline else 0,
    }
    if comparison:
        out.update({
            "delta": comparison["delta"],
            "label": comparison["label"],
            "summary": comparison["copy"],
        })
    return out


def _num(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _round_optional(value: float | None, digits: int = 1) -> float | None:
    if value is None:
        return None
    return round(value, digits)


def _time_bucket_for_meal(consumed_at: Any, meal_type: Any) -> str | None:
    """Tag a meal by local-time bucket so the LLM can reason about
    "pre-workout fueling" / "late-night eating" without parsing ISO
    strings. Buckets:
      early_morning  (04:00-08:59)
      mid_morning    (09:00-10:59)
      midday         (11:00-14:59)
      afternoon      (15:00-17:59)
      evening        (18:00-20:59)
      late_night     (21:00-03:59)
    Falls back to meal_type when consumed_at is null (back-logged meals).
    """
    try:
        from datetime import datetime as _dt
        if isinstance(consumed_at, str) and consumed_at.strip():
            ts = _dt.fromisoformat(consumed_at.replace("Z", "+00:00"))
            hour = ts.hour
            if 4 <= hour < 9: return "early_morning"
            if 9 <= hour < 11: return "mid_morning"
            if 11 <= hour < 15: return "midday"
            if 15 <= hour < 18: return "afternoon"
            if 18 <= hour < 21: return "evening"
            return "late_night"
    except Exception:
        pass
    # Fallback from meal_type when we have no timestamp.
    mt = str(meal_type or "").lower()
    if mt in ("breakfast", "pre_breakfast"): return "mid_morning"
    if mt in ("lunch",): return "midday"
    if mt in ("dinner",): return "evening"
    if mt in ("snack", "pre_workout"): return None  # too ambiguous
    return None


def _gi_hints_for_items(items: list[dict], fiber_g: float | None) -> list[str]:
    text = " ".join(str(i.get("food_name") or "").lower() for i in items)
    hints: list[str] = []
    for label, needles in _GI_FOOD_HINTS:
        if any(needle in text for needle in needles):
            hints.append(label)
    if fiber_g is not None and fiber_g >= 12:
        hints.append("high_fiber_meal")
    return hints[:5]


def _recent_meals_for_symptom_context(user_id: int, db: Session, *, days: int = 2, limit: int = 8) -> dict | None:
    """Compact today/yesterday meal details for digestive symptom questions.

    This is intentionally opt-in from the chat route: itemized food logs are
    useful for "why am I bloated/gassy?" but too verbose for ordinary coach
    questions. The hints are food-pattern clues, not medical conclusions.
    """
    from app.services.nutrition.meal_history import get_meal_history

    meals = get_meal_history(user_id, days=days, limit=limit, db=db)
    today_iso = date.today().isoformat()
    if not meals:
        return {
            "as_of": today_iso,
            "window_days": days,
            "meals": [],
            "data_note": "No logged meals found for today or yesterday.",
        }

    out_meals: list[dict[str, Any]] = []
    daily: dict[str, dict[str, float]] = defaultdict(lambda: {
        "calories": 0.0,
        "protein_g": 0.0,
        "carbs_g": 0.0,
        "fat_g": 0.0,
        "fiber_g": 0.0,
        "meals": 0.0,
    })

    for meal in meals[:limit]:
        items = [i for i in (meal.get("items") or []) if isinstance(i, dict)]
        totals = meal.get("totals") or {}
        fiber_values = [_num(i.get("fiber_g")) for i in items]
        known_fiber = [v for v in fiber_values if v is not None]
        fiber_g = sum(known_fiber) if known_fiber else None
        food_names = [str(i.get("food_name") or "").strip() for i in items if i.get("food_name")]
        compact_totals = {
            "calories": _round_optional(_num(totals.get("calories")), 0),
            "protein_g": _round_optional(_num(totals.get("protein_g")), 1),
            "carbs_g": _round_optional(_num(totals.get("carbs_g")), 1),
            "fat_g": _round_optional(_num(totals.get("fat_g")), 1),
        }
        if fiber_g is not None:
            compact_totals["fiber_g"] = round(fiber_g, 1)

        meal_date = str(meal.get("meal_date") or "")
        if meal_date:
            day = daily[meal_date]
            day["meals"] += 1
            for key in ("calories", "protein_g", "carbs_g", "fat_g"):
                value = compact_totals.get(key)
                if value is not None:
                    day[key] += float(value)
            if fiber_g is not None:
                day["fiber_g"] += fiber_g

        # Tag each meal with a time-of-day bucket so the LLM can reason
        # about "pre-workout" / "evening eating" / "late night" without
        # parsing timestamps itself. Falls back to meal_type when
        # consumed_at is null (back-logged meals).
        time_bucket = _time_bucket_for_meal(meal.get("consumed_at"), meal.get("meal_type"))
        out_meals.append({
            "meal_date": meal_date or None,
            "meal_type": meal.get("meal_type"),
            "name": meal.get("name"),
            "consumed_at": meal.get("consumed_at"),
            "time_bucket": time_bucket,
            "foods": food_names[:8],
            "totals": compact_totals,
            "possible_gi_trigger_hints": _gi_hints_for_items(items, fiber_g),
        })

    daily_totals = []
    for day_key in sorted(daily.keys(), reverse=True):
        values = daily[day_key]
        daily_totals.append({
            "date": day_key,
            "meal_count": int(values["meals"]),
            "calories": round(values["calories"]),
            "protein_g": round(values["protein_g"], 1),
            "carbs_g": round(values["carbs_g"], 1),
            "fat_g": round(values["fat_g"], 1),
            "fiber_g": round(values["fiber_g"], 1) if values["fiber_g"] > 0 else None,
        })

    return {
        "as_of": today_iso,
        "window_days": days,
        "meals": out_meals,
        "daily_totals": daily_totals,
        "data_note": "Food-pattern hints are not diagnoses; use them as hypotheses to compare against symptoms.",
    }


def _timeline_progress(user_id: int, db: Session) -> dict | None:
    goal = db.exec(
        select(UserGoal)
        .where(UserGoal.user_id == user_id)
        .where(UserGoal.is_active == True)  # noqa: E712
    ).first()
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    if not goal or not profile:
        return None
    if not goal.target_weight_lbs or not goal.timeline_weeks:
        return None
    weeks_elapsed = max(0.0, (date.today() - goal.created_at.date()).days / 7.0)
    pct_timeline = min(100.0, 100.0 * weeks_elapsed / max(1, goal.timeline_weeks))
    # Weight delta vs target.
    latest = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id)
        .order_by(WeeklyCheckIn.checkin_date.desc())
        .limit(1)
    ).first()
    current_w = float(latest.weight_lbs) if latest else float(profile.weight_lbs)
    start_w = float(profile.weight_lbs)  # best available baseline
    total_delta = float(goal.target_weight_lbs) - start_w
    actual_delta = current_w - start_w
    pct_delta = 0.0
    if total_delta != 0:
        pct_delta = min(200.0, max(-50.0, 100.0 * actual_delta / total_delta))
    return {
        "weeks_elapsed": round(weeks_elapsed, 1),
        "weeks_total": goal.timeline_weeks,
        "pct_timeline_elapsed": round(pct_timeline, 1),
        "pct_weight_delta_achieved": round(pct_delta, 1),
        "start_weight_lbs": round(start_w, 1),
        "current_weight_lbs": round(current_w, 1),
        "target_weight_lbs": round(float(goal.target_weight_lbs), 1),
    }


# ─── 2026-05: extended context for energy / recovery / nutrient questions ──
#
# Everything below was added so the trainer coach can answer specific
# questions that previously only got hedged "general advice" responses:
#
#   "Am I recovering well?"           → heart_rate_recovery + sleep_last_night
#   "Why am I tired today?"           → heart_rate_recovery + sleep_last_night
#                                       + cardio_load_recent + caffeine_alcohol
#   "Is my pre-workout sufficient?"   → recent_meals (with timing tags)
#   "Why do I have gas in the morning?" → recent_meals + caffeine_alcohol
#   "Is my fiber too high/spiking?"   → fiber_micros_7d
#
# Each helper is defensive (returns None on missing data) so the LLM
# never sees a fabricated zero. Same `unknown ≠ zero` invariant the
# nutrition layer uses.


def _heart_rate_recovery(user_id: int, db: Session) -> dict | None:
    """HRV + RHR today / yesterday / 7d average — the single most useful
    signal for "Am I recovering?" / "Why am I tired?" questions. Sourced
    from DailyHealthSnapshot (Apple Health / watch / Oura when wired).
    """
    today = date.today()
    rows = db.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date >= today - timedelta(days=7))
        .where(DailyHealthSnapshot.snapshot_date <= today)
        .order_by(DailyHealthSnapshot.snapshot_date.asc())
    ).all()
    if not rows:
        return None
    by_date = {r.snapshot_date: r for r in rows}
    today_row = by_date.get(today)
    yesterday_row = by_date.get(today - timedelta(days=1))

    hrv_values = [r.hrv_ms for r in rows if r.hrv_ms is not None]
    rhr_values = [r.resting_hr for r in rows if r.resting_hr is not None]
    hrv_7d_avg = sum(hrv_values) / len(hrv_values) if hrv_values else None
    rhr_7d_avg = sum(rhr_values) / len(rhr_values) if rhr_values else None

    # Trend label: HRV up vs 7d baseline = recovering well; HRV down >
    # 10% = under-recovered. RHR up vs baseline reinforces the signal.
    trend_label = None
    if today_row and hrv_7d_avg and today_row.hrv_ms is not None and hrv_7d_avg > 0:
        delta_pct = (today_row.hrv_ms - hrv_7d_avg) / hrv_7d_avg * 100.0
        if delta_pct >= 8:
            trend_label = "hrv_above_baseline"
        elif delta_pct <= -10:
            trend_label = "hrv_below_baseline"
        else:
            trend_label = "hrv_near_baseline"

    out = {
        "hrv_today_ms": round(today_row.hrv_ms, 1) if today_row and today_row.hrv_ms is not None else None,
        "hrv_yesterday_ms": round(yesterday_row.hrv_ms, 1) if yesterday_row and yesterday_row.hrv_ms is not None else None,
        "hrv_7d_avg_ms": round(hrv_7d_avg, 1) if hrv_7d_avg is not None else None,
        "rhr_today_bpm": round(today_row.resting_hr, 1) if today_row and today_row.resting_hr is not None else None,
        "rhr_7d_avg_bpm": round(rhr_7d_avg, 1) if rhr_7d_avg is not None else None,
        "trend": trend_label,
        "days_with_data": len(rows),
    }
    # If every field is None, drop the block entirely.
    if all(v is None for k, v in out.items() if k not in ("days_with_data", "trend")):
        return None
    return out


def _sleep_last_night(user_id: int, db: Session) -> dict | None:
    """Last night's specific sleep numbers — total, deep, REM, score.
    Separate from the 7d sleep average so the coach can distinguish
    "tired today because of one bad night" from "chronically under-slept".
    """
    today = date.today()
    row = db.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(SleepLog.night_date == today)
        .limit(1)
    ).first()
    # Fall back to yesterday's night row when today's hasn't synced yet
    # (early-morning fetch before watch sleep data lands).
    if row is None:
        row = db.exec(
            select(SleepLog)
            .where(SleepLog.user_id == user_id)
            .where(SleepLog.night_date == today - timedelta(days=1))
            .limit(1)
        ).first()
    if row is None:
        return None
    return {
        "night_date": row.night_date.isoformat(),
        "total_hours": round(row.total_hours, 2) if row.total_hours is not None else None,
        "deep_hours": round(row.deep_hours, 2) if row.deep_hours is not None else None,
        "rem_hours": round(row.rem_hours, 2) if row.rem_hours is not None else None,
        "awake_minutes": row.awake_minutes,
        "score": row.score,
        "rating": row.rating,
        "bedtime_minutes_from_midnight": row.bedtime_minutes_from_midnight,
    }


def _cardio_load_recent(user_id: int, db: Session) -> dict | None:
    """Yesterday's Edwards' TRIMP + 7-day total. Lets the coach answer
    "Am I overtraining?" / "Was yesterday's session hard enough?". Reads
    `WorkoutCompletion.cardio_load` which is populated at write-time from
    HR zone minutes (real wearable or synthesized for manual cardio).
    """
    today = date.today()
    rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= today - timedelta(days=7))
        .where(WorkoutCompletion.workout_date <= today)
    ).all()
    yesterday = today - timedelta(days=1)
    yesterday_total = 0.0
    yesterday_sessions = 0
    week_total = 0.0
    week_sessions = 0
    for r in rows:
        load = getattr(r, "cardio_load", None)
        if load is None or load <= 0:
            continue
        week_total += float(load)
        week_sessions += 1
        if r.workout_date == yesterday:
            yesterday_total += float(load)
            yesterday_sessions += 1
    if week_sessions == 0:
        return None
    return {
        "yesterday_trimp": round(yesterday_total, 1),
        "yesterday_sessions": yesterday_sessions,
        "last_7d_trimp": round(week_total, 1),
        "last_7d_sessions": week_sessions,
    }


def _caffeine_alcohol_recent(user_id: int, db: Session) -> dict | None:
    """Last 48h caffeine + alcohol totals from MealItem. Wired to the
    2026-05 nutrient expansion (caffeine_mg / alcohol_g per-item columns).
    Lets the coach answer "Why am I tired?" / "Why poor sleep?" with
    specifics instead of generic advice.
    """
    today = date.today()
    since = today - timedelta(days=2)
    meals = db.exec(
        select(Meal)
        .where(Meal.user_id == user_id)
        .where(Meal.meal_date >= since)
        .where(Meal.meal_date <= today)
    ).all()
    if not meals:
        return None
    meal_ids = [m.id for m in meals if m.id is not None]
    if not meal_ids:
        return None
    items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
    # Meal date → totals.
    by_date: dict[date, dict[str, float | None]] = {}
    meal_date_by_id = {m.id: m.meal_date for m in meals}
    for it in items:
        d = meal_date_by_id.get(it.meal_id)
        if d is None:
            continue
        slot = by_date.setdefault(d, {"caffeine_mg": None, "alcohol_g": None})
        if it.caffeine_mg is not None:
            slot["caffeine_mg"] = (slot["caffeine_mg"] or 0.0) + float(it.caffeine_mg)
        if it.alcohol_g is not None:
            slot["alcohol_g"] = (slot["alcohol_g"] or 0.0) + float(it.alcohol_g)
    if not by_date:
        return None
    def _fmt(d: date) -> dict:
        slot = by_date.get(d) or {}
        return {
            "date": d.isoformat(),
            "caffeine_mg": round(slot.get("caffeine_mg"), 1) if slot.get("caffeine_mg") is not None else None,
            "alcohol_g": round(slot.get("alcohol_g"), 1) if slot.get("alcohol_g") is not None else None,
        }
    out = [_fmt(today), _fmt(today - timedelta(days=1))]
    # Drop the block entirely if both days have neither field populated —
    # an unlogged-caffeine user shouldn't see "0mg" implied.
    if all(d["caffeine_mg"] is None and d["alcohol_g"] is None for d in out):
        return None
    return {"by_day": out, "data_note": "Null fields mean the source didn't report; not zero."}


def _fiber_micros_7d(user_id: int, db: Session) -> dict | None:
    """7-day rolling totals for fiber + key micros + spike detection.
    Used for "Is my fiber too high?" / "Am I low on omega-3?" etc.
    Reads DailyNutritionMetrics so we don't recompute on every coach call.
    """
    today = date.today()
    rows = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= today - timedelta(days=7))
        .where(DailyNutritionMetrics.metric_date <= today)
        .order_by(DailyNutritionMetrics.metric_date.asc())
    ).all()
    if not rows:
        return None

    def _avg(field: str) -> float | None:
        values = [getattr(r, field, None) for r in rows]
        values = [float(v) for v in values if v is not None and v > 0]
        return (sum(values) / len(values)) if values else None

    fiber_avg = _avg("fiber_total_g")
    fiber_yesterday = None
    yesterday_row = next((r for r in rows if r.metric_date == today - timedelta(days=1)), None)
    if yesterday_row and yesterday_row.fiber_total_g:
        fiber_yesterday = float(yesterday_row.fiber_total_g)

    # Spike: yesterday > 1.6× the 5-day baseline preceding it. Conservative
    # threshold — single high-fiber day shouldn't always trip the flag, but
    # 50g vs a 25g 5-day baseline almost certainly explains bloating.
    spike = False
    prior_5d = [r.fiber_total_g for r in rows if r.metric_date < (today - timedelta(days=1)) and r.fiber_total_g]
    if fiber_yesterday and prior_5d:
        baseline = sum(prior_5d) / len(prior_5d)
        if baseline > 0 and fiber_yesterday / baseline >= 1.6:
            spike = True

    out: dict[str, Any] = {
        "days_with_data": len(rows),
        "fiber_7d_avg_g": round(fiber_avg, 1) if fiber_avg is not None else None,
        "fiber_yesterday_g": round(fiber_yesterday, 1) if fiber_yesterday is not None else None,
        "fiber_yesterday_spike": spike,
    }
    # Add a handful of other micros where the column exists.
    for field, label in (
        ("added_sugar_g", "added_sugar_7d_avg_g"),
        ("sodium_mg", "sodium_7d_avg_mg"),
        ("potassium_mg", "potassium_7d_avg_mg"),
        ("calcium_mg", "calcium_7d_avg_mg"),
        ("magnesium_mg", "magnesium_7d_avg_mg"),
        ("iron_mg", "iron_7d_avg_mg"),
        ("zinc_mg", "zinc_7d_avg_mg"),
        ("vitamin_d_mcg", "vitamin_d_7d_avg_mcg"),
        ("vitamin_b12_mcg", "vitamin_b12_7d_avg_mcg"),
        ("folate_mcg", "folate_7d_avg_mcg"),
        ("omega_3_g", "omega_3_7d_avg_g"),
        ("caffeine_mg", "caffeine_7d_avg_mg"),
        ("saturated_fat_g", "saturated_fat_7d_avg_g"),
    ):
        avg = _avg(field)
        if avg is not None:
            out[label] = round(avg, 1)
    out["data_note"] = "Null fields mean unknown; non-null fields are 7-day averages over days with logged data."
    return out
