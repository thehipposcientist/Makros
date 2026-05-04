"""Payload assembler for AI check-ins.

Converts DB state into the compact JSON shape described in the AI check-in
design doc. Two entry points:

    build_micro_payload(db, user_id, feedback)   → dict (schema: micro.v1)
    build_weekly_payload(db, user_id, feedback)  → dict (schema: weekly.v1)

Key rules:
  - Never include meal items, set-by-set workout data, or free-form chat history.
  - Weight history is summarised (EMA + slope + last 3–5 points), never raw series.
  - Prior AI decisions are structured (rationale_key, delta), not prose.
  - Blocks are stable — add new fields, never rename.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from sqlmodel import Session, select

from app.models import (
    AIDecision,
    DailyRollup,
    User,
    UserFlag,
    UserGoal,
    UserProfile,
    UserRollup,
    WeeklyCheckIn,
)
from .plan import PlanSnapshot, get_plan_snapshot

MICRO_SCHEMA = "micro.v1"
WEEKLY_SCHEMA = "weekly.v1"
MICRO_RAW_DAYS = 4
WEEKLY_RAW_DAYS = 7
MICRO_RECENT_SESSIONS = 4
WEEKLY_RECENT_SESSIONS = 7
MICRO_DECISIONS = 1
WEEKLY_DECISIONS = 3


# ─── Block builders ───────────────────────────────────────────────────────────

def _profile_block(db: Session, user_id: int) -> dict[str, Any]:
    user = db.exec(
        select(User).where(User.id == user_id)
    ).first()
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()
    identity = {
        "user_id": user_id,
        "first_name": user.first_name if user else None,
        "username": user.username if user else None,
        "display_name": (user.first_name or user.username) if user else None,
    }
    if not profile:
        return identity
    gender = profile.gender.value if hasattr(profile.gender, "value") else str(profile.gender)
    return {
        **identity,
        "sex": gender,
        "age": profile.age,
        "height_in": profile.height_feet * 12 + profile.height_inches,
        "weight_lbs": profile.weight_lbs,
        "goal": goal.goal_type.value if goal else None,
        "goal_pace": goal.pace.value if goal else None,
        "target_weight_lbs": goal.target_weight_lbs if goal else None,
        "timeline_weeks": goal.timeline_weeks if goal else None,
    }


def _plan_block(plan: PlanSnapshot | None) -> dict[str, Any]:
    if not plan:
        return {}
    return {
        "kcal": plan.kcal,
        "protein_g": plan.protein_g,
        "carbs_g": plan.carbs_g,
        "fat_g": plan.fat_g,
        "days_per_week": plan.days_per_week,
        "goal_bucket": plan.goal_bucket,
        "coaching_kcal_adjustment": plan.coaching_kcal_adjustment,
    }


def _metrics_recent_block(db: Session, user_id: int, as_of: date, raw_days: int, recent_sessions: int) -> dict[str, Any]:
    start = as_of - timedelta(days=raw_days - 1)
    rows = db.exec(
        select(DailyRollup)
        .where(
            DailyRollup.user_id == user_id,
            DailyRollup.day >= start,
            DailyRollup.day <= as_of,
        )
        .order_by(DailyRollup.day.asc())
    ).all()
    days: list[dict[str, Any]] = []
    sessions: list[dict[str, Any]] = []
    for r in rows:
        if r.meals_logged or r.sleep_h is not None or r.weight_lbs is not None:
            day_dict: dict[str, Any] = {"d": r.day.isoformat()}
            if r.meals_logged:
                day_dict["kcal"] = round(r.kcal)
                day_dict["protein_g"] = round(r.protein_g)
            if r.sleep_h is not None:
                day_dict["sleep_h"] = r.sleep_h
            if r.weight_lbs is not None:
                day_dict["weight_lbs"] = r.weight_lbs
            if r.energy is not None:
                day_dict["energy"] = r.energy
            days.append(day_dict)
        if r.session_completed:
            sess = {
                "d": r.day.isoformat(),
                "focus": r.session_focus,
                "completion_pct": 100,
            }
            if r.session_rpe_avg is not None:
                sess["rpe_avg"] = r.session_rpe_avg
            if r.session_duration_min is not None:
                sess["duration_min"] = r.session_duration_min
            sessions.append(sess)
    return {
        "days": days,
        "sessions": sessions[-recent_sessions:],
    }


def _metrics_trends_block(db: Session, user_id: int, include_windows: tuple[int, ...]) -> dict[str, Any]:
    rows = db.exec(
        select(UserRollup).where(UserRollup.user_id == user_id)
    ).all()
    by_window = {r.window_days: r for r in rows}
    out: dict[str, Any] = {}
    for w in include_windows:
        r = by_window.get(w)
        if not r:
            continue
        out[f"w{w}"] = {
            "kcal_avg": r.kcal_avg,
            "kcal_target_delta_pct": r.kcal_target_delta_pct,
            "protein_adherence_pct": r.protein_adherence_pct,
            "adherence_pct": r.adherence_pct,
            "days_logged": r.days_logged,
            "session_completion_pct": r.session_completion_pct,
            "weight_ema_lbs": r.weight_ema_lbs,
            "weight_slope_lbs_per_wk": r.weight_slope_lbs_per_wk,
            "sleep_avg_h": r.sleep_avg_h,
        }
    return out


def _flags_block(db: Session, user_id: int, micro_only: bool) -> list[dict[str, Any]]:
    """Return active flags. Micro check-ins exclude slow-reacting flags (14d+)."""
    fast_keys = {
        "low_adherence_7d",
        "low_protein_7d",
        "calorie_drift_7d",
        "excessive_soreness",
        "sleep_deficit_5d",
        "missed_sessions_7d",
    }
    rows = db.exec(
        select(UserFlag).where(UserFlag.user_id == user_id)
    ).all()
    out: list[dict[str, Any]] = []
    for f in rows:
        if micro_only and f.key not in fast_keys:
            continue
        out.append({
            "key": f.key,
            "severity": f.severity,
            "value": f.value,
        })
    return out


def _decisions_block(db: Session, user_id: int, limit: int) -> list[dict[str, Any]]:
    rows = db.exec(
        select(AIDecision)
        .where(AIDecision.user_id == user_id)
        .order_by(AIDecision.created_at.desc())
    ).all()
    rows = rows[:limit]
    return [
        {
            "date": r.created_at.date().isoformat(),
            "type": r.response_type,
            "checkin_type": r.checkin_type,
            "delta": r.delta,
            "rationale_key": r.rationale_key,
        }
        for r in rows
    ]


def _weight_summary(db: Session, user_id: int, as_of: date, n_points: int) -> dict[str, Any]:
    """Return EMA + slope + last N weigh-in points (from WeeklyCheckIn)."""
    rows = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id, WeeklyCheckIn.checkin_date <= as_of)
        .order_by(WeeklyCheckIn.checkin_date.desc())
    ).all()
    rows = rows[:n_points]
    rows_asc = list(reversed(rows))
    return {
        "points": [
            {"d": r.checkin_date.isoformat(), "weight_lbs": r.weight_lbs}
            for r in rows_asc
        ],
    }


def _history_digest(db: Session, user_id: int, profile_block: dict, plan: PlanSnapshot | None) -> str:
    """One-sentence compressed long-term context for weekly payloads."""
    goal = profile_block.get("goal")
    target = profile_block.get("target_weight_lbs")
    weight = profile_block.get("weight_lbs")
    # First weigh-in on record
    first = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id)
        .order_by(WeeklyCheckIn.checkin_date.asc())
    ).first()
    decisions = db.exec(
        select(AIDecision).where(AIDecision.user_id == user_id)
    ).all()
    parts: list[str] = []
    if goal:
        parts.append(f"Goal: {goal}")
        if target and weight:
            parts.append(f"current {weight} lbs → target {target} lbs")
    if first and weight and first.weight_lbs != weight:
        delta = weight - first.weight_lbs
        span_days = (date.today() - first.checkin_date).days
        if span_days > 0:
            parts.append(f"{delta:+.1f} lbs over {span_days} days since {first.checkin_date.isoformat()}")
    if decisions:
        adj = [d for d in decisions if d.response_type in {"small_adjust", "deep_review"}]
        if adj:
            parts.append(f"{len(adj)} prior coach adjustments")
    return ". ".join(parts) + "." if parts else ""


# ─── Public builders ──────────────────────────────────────────────────────────

def build_micro_payload(
    db: Session,
    user_id: int,
    user_feedback: dict[str, Any],
    as_of: date | None = None,
) -> dict[str, Any]:
    as_of = as_of or date.today()
    plan = get_plan_snapshot(db, user_id)
    profile = _profile_block(db, user_id)
    return {
        "schema": MICRO_SCHEMA,
        "as_of": as_of.isoformat(),
        "profile": profile,
        "plan": _plan_block(plan),
        "metrics_recent": _metrics_recent_block(db, user_id, as_of, MICRO_RAW_DAYS, MICRO_RECENT_SESSIONS),
        "metrics_trends": _metrics_trends_block(db, user_id, (7,)),
        "weight_summary": _weight_summary(db, user_id, as_of, 3),
        "flags": _flags_block(db, user_id, micro_only=True),
        "last_decisions": _decisions_block(db, user_id, MICRO_DECISIONS),
        "user_feedback": user_feedback,
    }


def build_weekly_payload(
    db: Session,
    user_id: int,
    user_feedback: dict[str, Any],
    as_of: date | None = None,
) -> dict[str, Any]:
    as_of = as_of or date.today()
    plan = get_plan_snapshot(db, user_id)
    profile = _profile_block(db, user_id)
    return {
        "schema": WEEKLY_SCHEMA,
        "as_of": as_of.isoformat(),
        "profile": profile,
        "plan": _plan_block(plan),
        "metrics_recent": _metrics_recent_block(db, user_id, as_of, WEEKLY_RAW_DAYS, WEEKLY_RECENT_SESSIONS),
        "metrics_trends": _metrics_trends_block(db, user_id, (7, 14, 28)),
        "weight_summary": _weight_summary(db, user_id, as_of, 5),
        "flags": _flags_block(db, user_id, micro_only=False),
        "last_decisions": _decisions_block(db, user_id, WEEKLY_DECISIONS),
        "history_digest": _history_digest(db, user_id, profile, plan),
        "user_feedback": user_feedback,
    }
