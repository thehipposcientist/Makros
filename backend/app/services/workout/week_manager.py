"""Weekly plan lifecycle manager.

Owns creation, adaptation, and locking of PlanWeek + PlanDay rows.
All mutations go through this module so the lock invariant is enforced
in one place: locked days are NEVER overwritten by adapt/regenerate.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select

from app.models import PlanWeek, PlanDay, WorkoutPlan, NutritionPlan, WorkoutCompletion, UserProfile, UserPreferences


# ─── Public API ───────────────────────────────────────────────────────────────


def get_active_week(db: Session, user_id: int) -> PlanWeek | None:
    return db.exec(
        select(PlanWeek).where(
            PlanWeek.user_id == user_id,
            PlanWeek.status == "active",
        )
    ).first()


def get_week_days(db: Session, plan_week_id: int) -> list[PlanDay]:
    return list(
        db.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == plan_week_id)
            .order_by(PlanDay.day_index)
        ).all()
    )


def create_plan_week(
    db: Session,
    user_id: int,
    start_date: date,
    workout_days: list[dict],
    nutrition_templates: list[dict],
    training_day_pattern: list[int],
    *,
    goal: str,
    days_per_week: int,
    preferred_split: str | None,
    planner_version: str,
    generation_source: str = "initial",
    goal_pace: str | None = None,
    session_minutes: int | None = None,
) -> PlanWeek:
    """Create a PlanWeek + 7 PlanDay rows.

    Abandons any existing active week for this user first.
    Maps workout_days (N-length recipe) to calendar dates using
    training_day_pattern (list of DOW indices 0=Mon that are training days).
    Rest days get workout_json=None. Nutrition templates rotate via index.
    """
    _abandon_active_week(db, user_id)

    # Delete any existing PlanWeek (and its PlanDays) for this start_date.
    # The unique constraint on (user_id, start_date) prevents inserting a
    # new row while an abandoned row still holds the slot.
    existing = db.exec(
        select(PlanWeek).where(
            PlanWeek.user_id == user_id,
            PlanWeek.start_date == start_date,
        )
    ).all()
    for old_pw in existing:
        old_days = db.exec(
            select(PlanDay).where(PlanDay.plan_week_id == old_pw.id)
        ).all()
        for od in old_days:
            db.delete(od)
        db.delete(old_pw)
    if existing:
        db.flush()

    end_date = start_date + timedelta(days=6)
    pw = PlanWeek(
        user_id=user_id,
        start_date=start_date,
        end_date=end_date,
        planner_version=planner_version,
        goal=goal,
        days_per_week=days_per_week,
        preferred_split=preferred_split,
        goal_pace=goal_pace,
        session_minutes=session_minutes,
        status="active",
    )
    db.add(pw)
    db.flush()

    workout_idx = 0
    for i in range(7):
        d = start_date + timedelta(days=i)
        is_training = i in training_day_pattern
        is_rest = not is_training

        workout_payload = None
        if is_training and workout_days:
            workout_payload = workout_days[workout_idx % len(workout_days)]
            workout_idx += 1

        nutrition_payload = None
        if nutrition_templates:
            nutrition_payload = nutrition_templates[i % len(nutrition_templates)]

        pd = PlanDay(
            plan_week_id=pw.id,
            user_id=user_id,
            day_date=d,
            day_index=i,
            status="planned",
            is_rest=is_rest,
            workout_json=workout_payload,
            nutrition_json=nutrition_payload,
            locked=False,
            generation_source=generation_source,
        )
        db.add(pd)

    db.commit()
    db.refresh(pw)
    return pw


def lock_day(
    db: Session,
    plan_day: PlanDay,
    reason: str,
    *,
    status: str | None = None,
) -> PlanDay:
    """Transition a day to locked state."""
    now = datetime.now(timezone.utc)
    plan_day.locked = True
    plan_day.locked_at = now
    plan_day.lock_reason = reason
    if status:
        plan_day.status = status
    plan_day.updated_at = now
    db.add(plan_day)
    db.commit()
    db.refresh(plan_day)
    return plan_day


def complete_day(db: Session, plan_day: PlanDay) -> PlanDay:
    return lock_day(db, plan_day, reason="completed", status="completed")


def skip_day(db: Session, plan_day: PlanDay, reason: str | None = None) -> PlanDay:
    plan_day.skip_reason = (reason or "").strip() or None
    return lock_day(db, plan_day, reason="skipped", status="skipped")


def unskip_day(db: Session, plan_day: PlanDay) -> PlanDay:
    if plan_day.status != "skipped" or plan_day.lock_reason != "skipped":
        return plan_day
    now = datetime.now(timezone.utc)
    plan_day.status = "planned"
    plan_day.locked = False
    plan_day.locked_at = None
    plan_day.lock_reason = None
    plan_day.skip_reason = None
    plan_day.updated_at = now
    db.add(plan_day)
    db.commit()
    db.refresh(plan_day)
    return plan_day


def start_day(db: Session, plan_day: PlanDay) -> PlanDay:
    return lock_day(db, plan_day, reason="started", status="started")


def _completion_matches_plan_day(plan_day: PlanDay, focus_label: str) -> bool:
    """Return true when a completion is plausibly the scheduled workout.

    Users can log extra activity on a planned day: a walk, sauna, sport, or
    imported Apple Health session should count for fatigue without marking
    the scheduled lift complete. Exact focus match wins; otherwise compare
    normalized focus families so "Chest" can satisfy "Push", "Running" can
    satisfy a cardio day, etc.
    """
    if plan_day.is_rest or not isinstance(plan_day.workout_json, dict):
        return False
    planned = str(plan_day.workout_json.get("focus") or "").strip()
    completed = str(focus_label or "").strip()
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


def patch_day_workout(
    db: Session,
    plan_day: PlanDay,
    workout_json: dict,
) -> PlanDay:
    """Surgical single-day workout swap. Locks the day as 'edited'."""
    if plan_day.locked:
        raise ValueError(f"Cannot edit locked day {plan_day.day_date} (reason={plan_day.lock_reason})")
    now = datetime.now(timezone.utc)
    plan_day.workout_json = workout_json
    plan_day.is_rest = False
    plan_day.status = "edited"
    plan_day.locked = True
    plan_day.locked_at = now
    plan_day.lock_reason = "manual_edit"
    plan_day.generation_source = "swap"
    plan_day.updated_at = now
    db.add(plan_day)
    db.commit()
    db.refresh(plan_day)
    return plan_day


def patch_day_nutrition(
    db: Session,
    plan_day: PlanDay,
    nutrition_json: dict,
) -> PlanDay:
    """Surgical single-day nutrition edit."""
    if plan_day.locked:
        raise ValueError(f"Cannot edit locked day {plan_day.day_date} (reason={plan_day.lock_reason})")
    now = datetime.now(timezone.utc)
    plan_day.nutrition_json = nutrition_json
    plan_day.updated_at = now
    db.add(plan_day)
    db.commit()
    db.refresh(plan_day)
    return plan_day


def adapt_remaining_days(
    db: Session,
    plan_week: PlanWeek,
    fresh_workout_days: list[dict],
    *,
    nutrition_templates: list[dict] | None = None,
) -> list[PlanDay]:
    """Re-fill exercises for all unlocked future days.

    Keeps the same focus/archetype recipe — replaces exercise lists with
    freshly generated ones that account for current fatigue. Caller is
    responsible for running the planner and passing the result.
    """
    today = date.today()
    days = get_week_days(db, plan_week.id)
    now = datetime.now(timezone.utc)

    remaining = [d for d in days if not d.locked and d.day_date >= today and not d.is_rest]
    updated = []

    for i, plan_day in enumerate(remaining):
        if i < len(fresh_workout_days):
            plan_day.workout_json = fresh_workout_days[i]
            plan_day.generation_source = "adapt"
            plan_day.updated_at = now
            db.add(plan_day)
            updated.append(plan_day)

    if nutrition_templates:
        remaining_all = [d for d in days if not d.locked and d.day_date >= today]
        for j, plan_day in enumerate(remaining_all):
            if nutrition_templates:
                plan_day.nutrition_json = nutrition_templates[j % len(nutrition_templates)]
                plan_day.updated_at = now
                db.add(plan_day)

    db.commit()
    return updated


def regenerate_remaining_days(
    db: Session,
    plan_week: PlanWeek,
    fresh_workout_days: list[dict],
    training_day_pattern: list[int],
    *,
    nutrition_templates: list[dict] | None = None,
    new_days_per_week: int | None = None,
) -> list[PlanDay]:
    """New recipe for remaining unlocked days.

    May change which days are rest vs training. Used when settings change
    mid-week (e.g., days_per_week bumped from 4 to 5).
    """
    today = date.today()
    days = get_week_days(db, plan_week.id)
    now = datetime.now(timezone.utc)

    workout_idx = 0
    updated = []
    for plan_day in days:
        if plan_day.locked or plan_day.day_date < today:
            if not plan_day.is_rest:
                workout_idx += 1
            continue

        dow = plan_day.day_date.weekday()
        is_training = dow in training_day_pattern
        plan_day.is_rest = not is_training

        if is_training and fresh_workout_days:
            plan_day.workout_json = fresh_workout_days[workout_idx % len(fresh_workout_days)]
            workout_idx += 1
        else:
            plan_day.workout_json = None

        if nutrition_templates:
            plan_day.nutrition_json = nutrition_templates[plan_day.day_index % len(nutrition_templates)]

        plan_day.generation_source = "adapt"
        plan_day.status = "planned"
        plan_day.updated_at = now
        db.add(plan_day)
        updated.append(plan_day)

    if new_days_per_week:
        plan_week.days_per_week = new_days_per_week
        db.add(plan_week)

    db.commit()
    return updated


def lock_day_on_complete(
    db: Session,
    user_id: int,
    workout_date: date,
    focus_label: str,
) -> PlanDay | None:
    """Called from workout completion flow. Locks the matching PlanDay."""
    active_week = get_active_week(db, user_id)
    if not active_week:
        return None
    plan_day = db.exec(
        select(PlanDay).where(
            PlanDay.plan_week_id == active_week.id,
            PlanDay.day_date == workout_date,
        )
    ).first()
    if not plan_day or plan_day.locked:
        return plan_day
    if not _completion_matches_plan_day(plan_day, focus_label):
        return plan_day
    return complete_day(db, plan_day)


def week_needs_renewal(plan_week: PlanWeek) -> bool:
    """True if the active week has expired (end_date < today)."""
    return plan_week.end_date < date.today()


def default_training_pattern(days_per_week: int) -> list[int]:
    """Default DOW indices (0=Mon) for N training days per week."""
    patterns = {
        1: [0],
        2: [0, 3],
        3: [0, 2, 4],
        4: [0, 1, 3, 4],
        5: [0, 1, 2, 3, 4],
        6: [0, 1, 2, 3, 4, 5],
        7: [0, 1, 2, 3, 4, 5, 6],
    }
    return patterns.get(days_per_week, list(range(min(days_per_week, 7))))


# ─── Safe Auto-Apply Defaults ─────────────────────────────────────────────────

# Actions that are safe to auto-apply without user confirmation.
# Principle: never auto-increase load, never auto-cut calories.
_SAFE_AUTO_ACTIONS = {
    "reduce_muscle_volume",   # reducing is always safe
    "hold_muscle_volume",     # holding is safe
    "hold_calorie_adjustment",
    "raise_fiber_target",     # more fiber is safe
    "noop",
}

# Actions that need user confirmation (never auto-applied)
_NEEDS_CONFIRMATION = {
    "raise_calories",
    "lower_calories",
    "change_days_per_week",
    "add_muscle_volume",
    "add_cardio_session",
    "add_zone2_session",
    "swap_to_recovery",
}


def compute_auto_apply_defaults(
    recommendations: list[dict],
) -> tuple[list[dict], list[dict]]:
    """Split recommendations into auto-apply (safe) vs needs-confirmation.

    Returns (auto_applied, needs_review) where each is a list of rec dicts.
    """
    auto_applied = []
    needs_review = []
    for rec in recommendations:
        action = rec.get("action", {})
        action_type = action.get("type", "")
        if action_type in _SAFE_AUTO_ACTIONS:
            auto_applied.append(rec)
        elif action_type in _NEEDS_CONFIRMATION:
            needs_review.append(rec)
        else:
            # Unknown action type — don't auto-apply
            needs_review.append(rec)
    return auto_applied, needs_review


def auto_renew_week(
    db: Session,
    user_id: int,
    *,
    weight_trend_lbs_per_week: float | None = None,
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_steps: float | None = None,
    readiness_score: int | None = None,
    cycle_phase: str | None = None,
    day_of_cycle: int | None = None,
) -> dict:
    """Auto-generate a new week when the user's plan has expired.

    Steps:
    1. Compute the weekly review for the expired week
    2. Auto-apply safe defaults (reduce volume, hold cals, etc.)
    3. Generate a new 7-day plan incorporating those decisions
    4. Return explanation of what was applied and why

    Returns a dict with:
    - plan_week_id: int
    - review_headline: str
    - auto_applied: list of applied recommendation summaries
    - needs_review: list of recommendations needing user action
    - explanation: str (human-readable summary of what changed)
    """
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.coach.apply_action import apply_action
    from app.models import UserProfile, UserPreferences, NutritionPlan
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.history import (
        most_recent_completed_focus,
        build_history_familiarity,
        recent_exercise_slugs_by_muscle,
    )
    from app.services.workout.activity_impact import compute_rolling_fatigue
    from app.services.workout.history import get_recent_completions_for_fatigue
    from app.services.workout.weekly_recipe import PLANNER_VERSION
    from app.seed_exercises_data import SEED_EXERCISES
    import json

    # Snapshot the goal the expiring week was generated with so the review
    # evaluates that week against its own goal, not whatever UserGoal is
    # active now (user may have changed goal mid-week).
    expiring_pw = get_active_week(db, user_id)
    expiring_goal = expiring_pw.goal if expiring_pw else None

    # Step 1: Compute the weekly review
    review = compute_weekly_review(
        db, user_id,
        weight_trend_lbs_per_week=weight_trend_lbs_per_week,
        avg_sleep_hours=avg_sleep_hours,
        avg_resting_hr=avg_resting_hr,
        avg_steps=avg_steps,
        readiness_score=readiness_score,
        goal_override=expiring_goal,
    )

    # Step 2a: Readiness-based auto-deload — if readiness is Fatigued or
    # Overtrained (< 40), immediately reduce volume for the new week so
    # the planner reads a lower adjustment before generating the plan.
    if readiness_score is not None and readiness_score < 40:
        from app.models import UserCoachingState
        coaching = db.exec(
            select(UserCoachingState).where(UserCoachingState.user_id == user_id)
        ).first()
        if coaching is None:
            coaching = UserCoachingState(user_id=user_id)
            db.add(coaching)
        existing_adj = getattr(coaching, "volume_adjustment_pct", 0) or 0
        coaching.volume_adjustment_pct = max(existing_adj - 20, -40)
        db.commit()

    # Step 2b: Auto-apply safe recommendations
    rec_dicts = [r.to_dict() for r in review.recommendations]
    auto_applied, needs_review = compute_auto_apply_defaults(rec_dicts)

    applied_summaries = []
    for rec in auto_applied:
        action = rec.get("action", {})
        if action.get("type") and action["type"] != "noop":
            result = apply_action(db, user_id, action, rec_key=rec.get("key"))
            if result.applied:
                applied_summaries.append({
                    "title": rec.get("title", ""),
                    "detail": rec.get("detail", ""),
                    "action_type": action.get("type"),
                })

    # Step 3: Generate a new plan (reads mutated UserPreferences/CoachingState)
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()

    if not profile:
        return {"error": "no_profile"}

    from app.models import UserGoal
    active_goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == user_id,
            UserGoal.is_active == True,
        )
    ).first()
    goal = active_goal.goal_type.value if active_goal else "body_recomp"
    goal_pace = active_goal.pace.value if active_goal and active_goal.pace else None
    days_per_week = int(getattr(prefs, "days_per_week", None) or getattr(profile, "days_per_week", 4) or 4)
    session_minutes = int(getattr(prefs, "workout_duration_minutes", None) or getattr(profile, "workout_duration_minutes", 45) or 45)
    experience = str(getattr(profile, "experience_level", "intermediate") or "intermediate")
    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    preferred_split = getattr(prefs, "preferred_split", None) or getattr(profile, "preferred_split", None)
    injuries = list(getattr(profile, "injuries", []) or [])
    disliked = list(getattr(prefs, "disliked_exercises", []) or [])

    from app.routers.ai.plans import _resolve_owned_equipment_slugs
    owned_slugs = _resolve_owned_equipment_slugs(equipment)

    recent_focus_buckets: tuple = ()
    recent_focus_families: tuple = ()
    try:
        buckets, families = most_recent_completed_focus(user_id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass

    muscle_fatigue = None
    try:
        completions = get_recent_completions_for_fatigue(user_id, db)
        if completions:
            snapshot = compute_rolling_fatigue(completions)
            muscle_fatigue = snapshot.muscle_fatigue.to_dict() if snapshot else None
    except Exception:
        pass

    try:
        history_familiarity = build_history_familiarity(user_id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(user_id, db)
    except Exception:
        recent_muscle_exercises = {}

    inputs = PlannerInputs(
        goal=goal,
        days_per_week=days_per_week,
        session_minutes=session_minutes,
        experience=experience.lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=preferred_split,
        injuries=tuple(injuries),
        disliked_exercises=tuple(disliked),
        rng_seed=user_id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=muscle_fatigue,
        cycle_phase=cycle_phase,
        day_of_cycle=day_of_cycle,
        load_equipment_settings=getattr(prefs, "equipment_settings", None),
    )

    plan = generate_workout_plan(
        inputs, SEED_EXERCISES,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )
    workout_days = plan.get("workout_plan", {}).get("days", [])
    if not workout_days:
        return {"error": "planner_empty"}

    # Load nutrition templates
    nutrition_templates = []
    try:
        np_row = db.exec(
            select(NutritionPlan).where(
                NutritionPlan.user_id == user_id,
                NutritionPlan.is_active == True,
            )
        ).first()
        if np_row and np_row.plans_json:
            nutrition_templates = json.loads(np_row.plans_json) if isinstance(np_row.plans_json, str) else np_row.plans_json
    except Exception:
        pass

    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    training_pattern = default_training_pattern(days_per_week)

    pw = create_plan_week(
        db, user_id,
        start_date=week_start,
        workout_days=workout_days,
        nutrition_templates=nutrition_templates,
        training_day_pattern=training_pattern,
        goal=goal,
        days_per_week=days_per_week,
        preferred_split=preferred_split,
        planner_version=PLANNER_VERSION,
        generation_source="auto_renew",
        goal_pace=goal_pace,
        session_minutes=session_minutes,
    )

    # Step 4: Build explanation
    explanation_parts = []
    if expiring_goal and expiring_goal != goal:
        explanation_parts.append(
            f"This week was built for {expiring_goal.replace('_', ' ')}. "
            f"Your next week will use your new {goal.replace('_', ' ')} goal."
        )
    if review.headline:
        explanation_parts.append(f"Last week: {review.headline}")
    if applied_summaries:
        for s in applied_summaries:
            explanation_parts.append(f"Applied: {s['title']} — {s['detail']}")
    if needs_review:
        explanation_parts.append(f"{len(needs_review)} recommendation(s) need your review.")
    if not explanation_parts:
        explanation_parts.append("New week generated based on your training history.")

    return {
        "plan_week_id": pw.id,
        "review_headline": review.headline,
        "review_summary": {
            "sessions_completed": review.sessions_completed,
            "sessions_planned": review.sessions_planned,
            "adherence_pct": round(review.adherence_pct, 1),
            "cardio_minutes": round(review.cardio_minutes, 0),
            "avg_protein_g": round(review.avg_protein_g, 1),
        },
        "auto_applied": applied_summaries,
        "needs_review": [
            {"title": r.get("title"), "detail": r.get("detail"), "action": r.get("action")}
            for r in needs_review
        ],
        "explanation": " ".join(explanation_parts),
    }


# ─── Internal ─────────────────────────────────────────────────────────────────


def _abandon_active_week(db: Session, user_id: int) -> None:
    """Mark any active PlanWeek as abandoned."""
    now = datetime.now(timezone.utc)
    active = db.exec(
        select(PlanWeek).where(
            PlanWeek.user_id == user_id,
            PlanWeek.status == "active",
        )
    ).all()
    for pw in active:
        pw.status = "abandoned"
        pw.abandoned_at = now
        db.add(pw)
