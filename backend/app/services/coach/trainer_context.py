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

from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.models import (
    User, UserProfile, UserGoal, UserFlag, AIDecision, CoachMemory,
    Meal, MealItem, WeeklyCheckIn, WorkoutCompletion,
)


def enrich(user_id: int, db: Session) -> dict[str, Any]:
    """Return the set of optional server-computed context blocks the
    trainer coach should see. Keys are only present when data exists.

    Blocks:
      readiness           — {score, top_fatigued, blocked_focuses}
      weight_trend        — {slope_lbs_per_wk, ema, last_5}
      active_flags        — list of {key, severity, value}
      coach_memory        — {last_decisions: [...], open_commitments: [...]}
      nutrition_signals   — {score, top_gaps, recovery_flags}
      logged_today        — {calories, protein_g, meal_count}
      timeline_progress   — {pct_timeline_elapsed, pct_weight_delta_achieved, weeks_elapsed}
    """
    out: dict[str, Any] = {}

    _try(lambda: _readiness(user_id, db), out, "readiness")
    _try(lambda: _weight_trend(user_id, db), out, "weight_trend")
    _try(lambda: _active_flags(user_id, db), out, "active_flags")
    _try(lambda: _coach_memory(user_id, db), out, "coach_memory")
    _try(lambda: _nutrition_signals(user_id, db), out, "nutrition_signals")
    _try(lambda: _logged_today(user_id, db), out, "logged_today")
    _try(lambda: _timeline_progress(user_id, db), out, "timeline_progress")

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
