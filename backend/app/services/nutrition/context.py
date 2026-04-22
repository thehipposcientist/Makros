"""Shared nutrition context blob consumed by every nutrition AI surface.

Three callers generate nutrition plans or answer nutrition questions:
  1. meal_assembler.call_skeleton_ai  (plan generation)
  2. nutrition/plan_review            (QA pass after generation)
  3. chat.py trainer-question          (live nutritionist chat)

Previously each one assembled its own context independently, so
bodyweight, experience, weight trend, recent macro adherence, and
completed-workout data only reached SOME surfaces. This module
builds one canonical dict once and every caller can embed the
fields it cares about.

No LLM calls, no DB writes — pure reads.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Optional


def build_nutrition_context(
    *,
    # From the PlanRequest or profile — always available.
    goal: str | None = None,
    secondary_goal: str | None = None,
    experience: str | None = None,
    bodyweight_lbs: float | None = None,
    target_weight_lbs: float | None = None,
    pace: str | None = None,
    dietary_preference: str | None = None,
    allergies: list[str] | None = None,
    foods_available: list[str] | None = None,
    # From the DB — optional, enriches the context when available.
    db: Any = None,
    user_id: int | None = None,
) -> dict:
    """Return a flat dict of nutrition-relevant context fields.

    Callers cherry-pick what they need:
      - skeleton prompt:  bodyweight, experience, secondary_goal,
                          pace, recent_workouts, weight_trend
      - nutrition review: adherence, micro_gaps, recent_workouts
      - nutritionist chat: all of the above + foods_available
    """
    ctx: dict = {}

    # ── Static fields (always present) ────────────────────────────
    if goal:
        ctx["goal"] = goal
    if secondary_goal:
        ctx["secondary_goal"] = secondary_goal
    if experience:
        ctx["experience"] = experience
    if bodyweight_lbs and bodyweight_lbs > 0:
        ctx["bodyweight_lbs"] = round(bodyweight_lbs, 1)
    if target_weight_lbs and target_weight_lbs > 0:
        ctx["target_weight_lbs"] = round(target_weight_lbs, 1)
    if pace:
        ctx["pace"] = pace
    if dietary_preference:
        ctx["dietary_preference"] = dietary_preference
    if allergies:
        ctx["allergies"] = list(allergies)
    if foods_available:
        ctx["foods_count"] = len(foods_available)

    # ── DB-enriched fields (best-effort) ──────────────────────────
    if db is None or user_id is None:
        return ctx

    try:
        _enrich_from_db(ctx, db, user_id)
    except Exception as e:
        print(f"[nutrition_context] DB enrichment failed (non-fatal): {e}")

    return ctx


def _enrich_from_db(ctx: dict, db: Any, user_id: int) -> None:
    """Pull recent rollups + completed sessions to add trend data."""
    from sqlmodel import select
    from app.models import DailyRollup, UserRollup, WorkoutSession

    today = date.today()
    week_ago = today - timedelta(days=7)

    # ── 7-day rollup (pre-computed aggregates) ────────────────────
    rollup_7 = db.exec(
        select(UserRollup).where(
            UserRollup.user_id == user_id,
            UserRollup.window_days == 7,
        )
    ).first()
    if rollup_7:
        if rollup_7.kcal_avg:
            ctx["avg_daily_kcal_7d"] = round(rollup_7.kcal_avg)
        if rollup_7.kcal_target_delta_pct is not None:
            ctx["kcal_vs_target_pct_7d"] = round(rollup_7.kcal_target_delta_pct, 1)
        if rollup_7.protein_adherence_pct is not None:
            ctx["protein_adherence_pct_7d"] = round(rollup_7.protein_adherence_pct, 1)
        if rollup_7.adherence_pct is not None:
            ctx["overall_adherence_pct_7d"] = round(rollup_7.adherence_pct, 1)
        if rollup_7.weight_ema_lbs:
            ctx["weight_trend_ema_lbs"] = round(rollup_7.weight_ema_lbs, 1)
        if rollup_7.weight_slope_lbs_per_wk is not None:
            ctx["weight_change_lbs_per_week"] = round(rollup_7.weight_slope_lbs_per_wk, 2)
        if rollup_7.sessions_completed is not None:
            ctx["sessions_completed_7d"] = rollup_7.sessions_completed
        if rollup_7.sessions_planned is not None:
            ctx["sessions_planned_7d"] = rollup_7.sessions_planned

    # ── Daily rollups: last 7 days of macro logging ───────────────
    daily_rows = db.exec(
        select(DailyRollup).where(
            DailyRollup.user_id == user_id,
            DailyRollup.day >= week_ago,
        ).order_by(DailyRollup.day.desc())
    ).all()
    if daily_rows:
        logged_days = [r for r in daily_rows if r.meals_logged > 0]
        ctx["days_with_meals_logged_7d"] = len(logged_days)
        if logged_days:
            avg_protein = sum(r.protein_g for r in logged_days) / len(logged_days)
            avg_kcal = sum(r.kcal for r in logged_days) / len(logged_days)
            ctx["avg_logged_protein_g"] = round(avg_protein, 1)
            ctx["avg_logged_kcal"] = round(avg_kcal)

    # ── Recent completed workouts (last 3 days, focus only) ───────
    # So the meal AI can reason about training load / carb timing.
    three_days = today - timedelta(days=3)
    sessions = db.exec(
        select(WorkoutSession).where(
            WorkoutSession.user_id == user_id,
            WorkoutSession.workout_date >= three_days,
        ).order_by(WorkoutSession.workout_date.desc()).limit(4)
    ).all()
    if sessions:
        ctx["recent_workouts_3d"] = [
            {
                "focus": s.focus or "?",
                "date": str(s.workout_date),
                "duration_min": round(s.duration_seconds / 60) if s.duration_seconds else None,
            }
            for s in sessions[:4]
        ]

    # ── Meal history: 7-day rolling averages + common meals ───────
    # Unlocks "user eats chicken + rice 4 days a week — lean into that"
    # reasoning in the nutrition AI, plus detection of habits the AI
    # should AVOID recreating as generated meals. No DB writes.
    try:
        from app.services.nutrition.meal_history import (
            get_rolling_averages, get_common_meals,
        )
        rolling = get_rolling_averages(user_id, window=7, db=db)
        if rolling:
            if rolling.get("avg_calories"):
                ctx["meal_log_avg_kcal_7d"] = round(rolling["avg_calories"])
            if rolling.get("avg_protein_g"):
                ctx["meal_log_avg_protein_g_7d"] = round(rolling["avg_protein_g"], 1)
            if rolling.get("days_with_data"):
                ctx["meal_log_days_7d"] = rolling["days_with_data"]
        # `lookback_days=14` to cover two training weeks — long enough to
        # surface habits, short enough to stay relevant to current diet.
        common = get_common_meals(user_id, lookback_days=14, limit=5, db=db)
        if common:
            # Compact name-only list; the meal AI uses this to COMPLEMENT
            # the user's existing habits instead of duplicating them.
            ctx["common_meals_14d"] = [str(m.get("name", "")).strip() for m in common if m.get("name")]
    except Exception as exc:
        # Meal history is additive context — failure MUST NOT block
        # generation. Log verbosely so the wiring bug is visible.
        print(f"[nutrition_context] meal_history enrichment failed: {exc}")


def format_for_prompt(ctx: dict, max_lines: int = 22) -> str:
    """Render the context dict as a terse prompt block. Each field is
    one line of `KEY: VALUE`. Only non-empty fields are included.
    Keeps the prompt addition to ~200-400 chars so token cost is tiny.
    """
    lines: list[str] = []
    field_map = [
        ("bodyweight_lbs", "Bodyweight: {v} lb"),
        ("experience", "Experience: {v}"),
        ("secondary_goal", "Secondary goal: {v}"),
        ("pace", "Pace: {v}"),
        ("target_weight_lbs", "Target weight: {v} lb"),
        ("dietary_preference", "Diet: {v}"),
        ("allergies", "Allergies: {v}"),
        ("weight_trend_ema_lbs", "Weight trend (EMA): {v} lb"),
        ("weight_change_lbs_per_week", "Weight change: {v} lb/week"),
        ("avg_daily_kcal_7d", "Avg daily kcal (7d): {v}"),
        ("kcal_vs_target_pct_7d", "Kcal vs target (7d): {v}%"),
        ("protein_adherence_pct_7d", "Protein adherence (7d): {v}%"),
        ("overall_adherence_pct_7d", "Overall adherence (7d): {v}%"),
        ("avg_logged_protein_g", "Avg logged protein (7d): {v}g"),
        ("sessions_completed_7d", "Workouts completed (7d): {v}"),
        ("sessions_planned_7d", "Workouts planned (7d): {v}"),
        ("days_with_meals_logged_7d", "Days with meals logged (7d): {v}"),
        ("recent_workouts_3d", "Recent workouts (3d): {v}"),
        ("meal_log_avg_kcal_7d", "Actual logged kcal (7d avg): {v}"),
        ("meal_log_avg_protein_g_7d", "Actual logged protein (7d avg): {v}g"),
        ("meal_log_days_7d", "Days with meals logged via check-off (7d): {v}"),
        ("common_meals_14d", "User's frequent meals (14d): {v}"),
    ]
    for key, template in field_map:
        v = ctx.get(key)
        if v is None or v == "" or v == []:
            continue
        if isinstance(v, list) and key == "recent_workouts_3d":
            v = "; ".join(f"{w['focus']} on {w['date']}" for w in v)
        elif isinstance(v, list):
            v = ", ".join(str(x) for x in v)
        lines.append(template.format(v=v))
        if len(lines) >= max_lines:
            break
    return "\n".join(lines)
