"""Weekly plan lifecycle manager.

Owns creation, adaptation, and locking of PlanWeek + PlanDay rows.
All mutations go through this module so the lock invariant is enforced
in one place: locked days are NEVER overwritten by adapt/regenerate.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlmodel import Session, select, col

from app.models import PlanWeek, PlanDay, WorkoutPlan, NutritionPlan, WorkoutCompletion, UserProfile, UserPreferences
from app.services.nutrition.day_targets import adapt_template_targets_for_day
from app.services.workout.goals import effective_goal_id

AUTO_SKIP_UNLOGGED_REASON = "No workout logged"
AUTO_SKIP_UNRESOLVED_STATUSES = {"planned", "started", "edited"}
_NUTRITION_RETARGET_CALORIE_TOLERANCE = 25
_NUTRITION_RETARGET_MACRO_TOLERANCE = 5


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


def set_plan_cadence_anchor_if_unset(db: Session, user_id: int, anchor: date) -> None:
    """Stamp the user's `plan_cadence_anchor` on first PlanWeek creation.

    No-op when an anchor already exists (subsequent renewals must NOT
    overwrite it — the anchor's value comes from the user's first
    PlanWeek and never moves). Cheap query: WHERE clause skips updates
    when the anchor is already set.
    """
    from app.models import User
    user = db.get(User, user_id)
    if user is None:
        return
    if user.plan_cadence_anchor is None:
        user.plan_cadence_anchor = anchor
        db.add(user)
        db.flush()


def get_plan_cadence_anchor(db: Session, user_id: int) -> date | None:
    """Read the user's `plan_cadence_anchor` (None until first stamped)."""
    from app.models import User
    user = db.get(User, user_id)
    return user.plan_cadence_anchor if user else None


def next_plan_week_start(anchor: date, today: date | None = None) -> date:
    """Compute the start_date of the plan week that should contain
    `today`, given the user's cadence anchor.

    The anchor never moves; we just walk forward in 7-day increments
    until the resulting week contains today. This is a pure function so
    it's robust against PlanWeek wipes / multi-device clock skew /
    out-of-band creates: if you know `anchor`, you know exactly what
    `today`'s plan-week start_date should be.
    """
    if today is None:
        today = date.today()
    if today < anchor:
        # Edge case — clock skew or backdated test data. Anchor wins.
        return anchor
    days_since = (today - anchor).days
    weeks_since = days_since // 7
    return anchor + timedelta(days=weeks_since * 7)


def _preferred_split_for_next_week(
    prefs: object | None,
    profile: object | None,
    expiring_week: object | None,
) -> str | None:
    return (
        getattr(prefs, "preferred_split", None)
        or getattr(profile, "preferred_split", None)
        or getattr(expiring_week, "preferred_split", None)
    )


def create_empty_manual_plan_week(
    db: Session,
    user_id: int,
    *,
    start_date: date,
    goal: str | None,
    days_per_week: int | None,
    preferred_split: str | None,
    planner_version: str,
    goal_pace: str | None = None,
    session_minutes: int | None = None,
) -> PlanWeek:
    """Create a 7-day PlanWeek where every day is `status="unassigned"` —
    used when the user has flipped on workout_manual_mode and the regular
    auto-renew should NOT run the planner. The user assembles each day
    by calling /plan-weeks/{id}/days/{idx}/use-template (or mark-rest).
    """
    _abandon_active_week(db, user_id)
    set_plan_cadence_anchor_if_unset(db, user_id, start_date)

    existing = db.exec(
        select(PlanWeek).where(
            PlanWeek.user_id == user_id,
            PlanWeek.start_date == start_date,
        )
    ).all()
    for old_pw in existing:
        for od in db.exec(select(PlanDay).where(PlanDay.plan_week_id == old_pw.id)).all():
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
        goal=goal or "general_fitness",
        days_per_week=days_per_week or 0,
        preferred_split=preferred_split,
        goal_pace=goal_pace,
        session_minutes=session_minutes,
        status="active",
    )
    db.add(pw)
    db.flush()

    for i in range(7):
        d = start_date + timedelta(days=i)
        db.add(PlanDay(
            plan_week_id=pw.id,
            user_id=user_id,
            day_date=d,
            day_index=i,
            status="unassigned",
            is_rest=False,
            workout_json=None,
            nutrition_json=None,
            locked=False,
            generation_source="manual",
        ))

    db.commit()
    db.refresh(pw)
    return pw


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

    Stamps the user's `plan_cadence_anchor` on first creation so the
    week-start cadence is preserved across all future renewals.
    """
    _abandon_active_week(db, user_id)
    # Anchor lock-in: first PlanWeek stamps the cadence on User.
    set_plan_cadence_anchor_if_unset(db, user_id, start_date)

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

    week_nutrition_targets = _current_week_nutrition_targets(
        db,
        user_id,
        as_of=start_date,
    )
    training_dows = set(training_day_pattern)
    workout_idx = 0
    for i in range(7):
        d = start_date + timedelta(days=i)
        is_training = d.weekday() in training_dows
        is_rest = not is_training

        workout_payload = None
        if is_training and workout_days:
            workout_payload = workout_days[workout_idx % len(workout_days)]
            workout_idx += 1

        nutrition_payload = None
        if nutrition_templates:
            nutrition_payload = _nutrition_payload_for_day(
                nutrition_templates[i % len(nutrition_templates)],
                workout_payload=workout_payload,
                goal=goal,
                base_targets=week_nutrition_targets,
            )

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


def _nutrition_payload_for_day(
    template: dict | None,
    *,
    workout_payload: dict | None,
    goal: str | None,
    base_targets: dict[str, int] | None = None,
) -> dict | None:
    if base_targets:
        template = _retarget_nutrition_template(template, base_targets)
    return adapt_template_targets_for_day(
        template,
        workout_payload=workout_payload,
        goal_bucket=goal,
    )


def _current_week_nutrition_targets(
    db: Session,
    user_id: int,
    *,
    as_of: date,
) -> dict[str, int] | None:
    """Resolve the current goal's neutral daily targets for new weeks.

    Active NutritionPlan rows are templates: the foods can carry forward, but
    their target numbers must not stay pinned to a previous goal or pace.
    """
    try:
        from app.services.nutrition.targets import resolve_targets_for_user

        targets = resolve_targets_for_user(
            db,
            user_id,
            as_of=as_of,
            # New-week templates should be stable at creation time. Same-day
            # workout/NEAT refuel is layered by /meals/adjusted-daily-target.
            health_activity_as_of=as_of - timedelta(days=1),
        )
    except Exception:
        return None
    if not targets:
        return None
    return {
        "calories": int(targets.calories),
        "protein": int(targets.protein_g),
        "carbs": int(targets.carbs_g),
        "fat": int(targets.fat_g),
    }


def _template_target_value(targets: dict, *keys: str) -> int | None:
    for key in keys:
        value = targets.get(key)
        if value is None:
            continue
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            continue
    return None


def _template_targets_match(template_targets: dict, base_targets: dict[str, int]) -> bool:
    checks = (
        ("calories", ("calories",), _NUTRITION_RETARGET_CALORIE_TOLERANCE),
        ("protein", ("protein", "protein_g"), _NUTRITION_RETARGET_MACRO_TOLERANCE),
        ("carbs", ("carbs", "carbs_g"), _NUTRITION_RETARGET_MACRO_TOLERANCE),
        ("fat", ("fat", "fat_g"), _NUTRITION_RETARGET_MACRO_TOLERANCE),
    )
    for base_key, lookup_keys, tolerance in checks:
        current = _template_target_value(template_targets, *lookup_keys)
        if current is None:
            return False
        if abs(current - int(base_targets[base_key])) > tolerance:
            return False
    return True


def _iter_nutrition_meals(plan: dict) -> list[dict]:
    meals = plan.get("meals")
    if isinstance(meals, list):
        return [m for m in meals if isinstance(m, dict)]
    out: list[dict] = []
    for key in ("breakfast", "lunch", "dinner", "snack"):
        meal = plan.get(key)
        if isinstance(meal, dict):
            out.append(meal)
    return out


def _sum_nutrition_calories(plan: dict) -> int:
    total = 0.0
    for meal in _iter_nutrition_meals(plan):
        try:
            total += float(meal.get("calories", 0) or 0)
        except (TypeError, ValueError):
            pass
    return int(round(total))


def _scale_value(value, factor: float, *, integer: bool = False):
    if value is None:
        return value
    try:
        scaled = float(value) * factor
    except (TypeError, ValueError):
        return value
    return int(round(scaled)) if integer else round(scaled, 1)


def _scale_nutrition_meals(plan: dict, factor: float) -> None:
    for meal in _iter_nutrition_meals(plan):
        meal["calories"] = _scale_value(meal.get("calories"), factor, integer=True)
        meal["protein"] = _scale_value(meal.get("protein"), factor)
        meal["carbs"] = _scale_value(meal.get("carbs"), factor)
        meal["fat"] = _scale_value(meal.get("fat"), factor)
        if meal.get("fiber") is not None:
            meal["fiber"] = _scale_value(meal.get("fiber"), factor)
        micros = meal.get("micronutrients")
        if isinstance(micros, dict):
            for key, value in list(micros.items()):
                micros[key] = _scale_value(value, factor)

        items = meal.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            item["calories"] = _scale_value(item.get("calories"), factor, integer=True)
            item["protein"] = _scale_value(item.get("protein"), factor)
            item["carbs"] = _scale_value(item.get("carbs"), factor)
            item["fat"] = _scale_value(item.get("fat"), factor)
            quantity = item.get("quantity")
            if isinstance(quantity, (int, float)):
                item["quantity"] = round(float(quantity) * factor, 2)
            item_micros = item.get("micronutrients")
            if isinstance(item_micros, dict):
                for key, value in list(item_micros.items()):
                    item_micros[key] = _scale_value(value, factor)


def _retarget_nutrition_template(
    template: dict | None,
    base_targets: dict[str, int],
) -> dict | None:
    if not isinstance(template, dict):
        return template
    out = deepcopy(template)
    template_targets = out.get("targets")
    if not isinstance(template_targets, dict):
        out["targets"] = dict(base_targets)
        return out
    if _template_targets_match(template_targets, base_targets):
        return out

    previous_targets = dict(template_targets)
    actual_calories = _sum_nutrition_calories(out)
    target_calories = int(base_targets["calories"])
    scale = 1.0
    if actual_calories > 0 and target_calories > 0:
        scale = target_calories / actual_calories
        if 0.2 <= scale <= 5.0 and abs(scale - 1.0) >= 0.01:
            _scale_nutrition_meals(out, scale)

    out["targets"] = dict(base_targets)
    out["_targetRetargeting"] = {
        "source": "current_goal_targets",
        "previous": previous_targets,
        "base": dict(base_targets),
        "meal_scale": round(scale, 4),
    }
    return out


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


def auto_skip_unlogged_past_days(
    db: Session, user_id: int, days: list[PlanDay]
) -> bool:
    """Resolve past planned workout days once the calendar has moved on.

    Matching completions become completed PlanDays. Unresolved planned /
    started / edited days become skipped, while keeping the original workout
    payload in place for the user's history and weekly review.
    """
    from app.models import UserDayState

    today = date.today()
    candidates = [
        d for d in days
        if d.day_date < today
        and d.status in AUTO_SKIP_UNRESOLVED_STATUSES
        and not d.is_rest
        and d.lock_reason not in {"completed", "skipped", "auto_skip_unlogged"}
    ]
    if not candidates:
        return False

    candidate_dates = [d.day_date for d in candidates]
    completions = db.exec(
        select(WorkoutCompletion).where(
            WorkoutCompletion.user_id == user_id,
            col(WorkoutCompletion.workout_date).in_(candidate_dates),
        )
    ).all()
    completions_by_date: dict[date, list[WorkoutCompletion]] = {}
    for completion in completions:
        completion_date = getattr(completion, "workout_date", None)
        if completion_date is not None:
            completions_by_date.setdefault(completion_date, []).append(completion)

    states = db.exec(
        select(UserDayState).where(
            UserDayState.user_id == user_id,
            col(UserDayState.day_key).in_(candidate_dates),
        )
    ).all()
    states_by_date = {
        state.day_key: state
        for state in states
        if getattr(state, "day_key", None) is not None
    }

    now = datetime.now(timezone.utc)
    changed = False
    for d in candidates:
        matched_completion = next(
            (
                completion for completion in completions_by_date.get(d.day_date, [])
                if (d.id is not None and getattr(completion, "plan_day_id", None) == d.id)
                or _completion_matches_plan_day(d, getattr(completion, "focus_label", ""))
            ),
            None,
        )
        if matched_completion is not None:
            d.status = "completed"
            d.locked = True
            d.locked_at = now
            d.lock_reason = "completed"
            d.updated_at = now
            db.add(d)
            changed = True
            continue

        state = states_by_date.get(d.day_date)
        planned_focus = _plan_day_focus_label(d) or "Workout"
        explicit_skip = bool(getattr(state, "skipped_focus", None))
        if state is None:
            state = UserDayState(
                user_id=user_id,
                day_key=d.day_date,
                skipped_focus=planned_focus,
                skip_reason=AUTO_SKIP_UNLOGGED_REASON,
                updated_at=now,
            )
            states_by_date[d.day_date] = state
            db.add(state)
        elif not explicit_skip:
            state.skipped_focus = planned_focus
            if not getattr(state, "skip_reason", None):
                state.skip_reason = AUTO_SKIP_UNLOGGED_REASON
            state.updated_at = now
            db.add(state)

        d.status = "skipped"
        d.locked = True
        d.locked_at = now
        d.lock_reason = "skipped" if explicit_skip else "auto_skip_unlogged"
        d.skip_reason = getattr(state, "skip_reason", None) or AUTO_SKIP_UNLOGGED_REASON
        d.updated_at = now
        db.add(d)
        changed = True
    if changed:
        db.commit()
        try:
            from app.services.readiness.compute import invalidate_readiness_cache
            invalidate_readiness_cache(user_id)
        except Exception:
            pass
    return changed


def _plan_day_focus_label(plan_day: PlanDay) -> str | None:
    workout = getattr(plan_day, "workout_json", None)
    if not isinstance(workout, dict):
        return None
    focus = str(workout.get("focus") or "").strip()
    return focus or None


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
    if plan_day.locked and plan_day.lock_reason != "manual_edit":
        raise ValueError(f"Cannot edit locked day {plan_day.day_date} (reason={plan_day.lock_reason})")
    now = datetime.now(timezone.utc)
    if isinstance(workout_json, dict):
        plan_day.workout_json = {
            **workout_json,
            "plan_day_id": plan_day.id,
            "planDayId": plan_day.id,
        }
    else:
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


def _has_checked_meals(meal_checks: object) -> bool:
    if not isinstance(meal_checks, dict):
        return False
    return any(bool(v) for v in meal_checks.values())


def _remaining_nutrition_skip_reason(
    plan_day: PlanDay,
    day_state: object | None,
    *,
    today: date,
) -> str | None:
    if plan_day.day_date <= today:
        return "today_or_past"
    if plan_day.locked or plan_day.status in {"started", "completed", "skipped", "edited"}:
        return plan_day.lock_reason or plan_day.status or "locked"
    if day_state is not None:
        if getattr(day_state, "nutrition_plan", None):
            return "day_nutrition_override"
        if getattr(day_state, "macro_overrides", None):
            return "macro_override"
        if _has_checked_meals(getattr(day_state, "meal_checks", None)):
            return "meal_checks"
    return None


def refresh_remaining_week_nutrition(
    db: Session,
    plan_week: PlanWeek,
    nutrition_templates: list[dict],
) -> tuple[list[PlanDay], list[dict]]:
    """Apply fresh nutrition templates to future eligible days only.

    This is the meal-plan counterpart to the workout-week immutability rule:
    workouts never regenerate mid-week, while nutrition can be explicitly
    refreshed for future days that have no locks, checks, or day-level edits.
    """
    if not nutrition_templates:
        return [], []

    from app.models import UserDayState

    today = date.today()
    days = get_week_days(db, plan_week.id)
    day_keys = [d.day_date for d in days]
    states_by_date = {}
    if day_keys:
        states = db.exec(
            select(UserDayState).where(
                UserDayState.user_id == plan_week.user_id,
                UserDayState.day_key.in_(day_keys),
            )
        ).all()
        states_by_date = {s.day_key: s for s in states}

    updated: list[PlanDay] = []
    skipped: list[dict] = []
    now = datetime.now(timezone.utc)

    for plan_day in days:
        state = states_by_date.get(plan_day.day_date)
        reason = _remaining_nutrition_skip_reason(plan_day, state, today=today)
        if reason:
            skipped.append({"date": plan_day.day_date.isoformat(), "reason": reason})
            continue

        template = nutrition_templates[plan_day.day_index % len(nutrition_templates)]
        plan_day.nutrition_json = _nutrition_payload_for_day(
            template,
            workout_payload=plan_day.workout_json,
            goal=plan_week.goal,
        )
        plan_day.updated_at = now
        db.add(plan_day)
        updated.append(plan_day)

    db.commit()
    for plan_day in updated:
        db.refresh(plan_day)
    return updated, skipped


def _has_projected_nutrition(payload: object) -> bool:
    return (
        isinstance(payload, dict)
        and isinstance(payload.get("meals"), list)
        and len(payload.get("meals") or []) > 0
    )


def backfill_missing_week_nutrition(
    db: Session,
    plan_week: PlanWeek,
    nutrition_templates: list[dict],
) -> list[PlanDay]:
    """Fill PlanDay nutrition only where it is missing."""
    if not nutrition_templates:
        return []

    days = get_week_days(db, plan_week.id)
    updated: list[PlanDay] = []
    now = datetime.now(timezone.utc)

    for plan_day in days:
        if _has_projected_nutrition(plan_day.nutrition_json):
            continue
        template = nutrition_templates[plan_day.day_index % len(nutrition_templates)]
        if not _has_projected_nutrition(template):
            continue
        payload = _nutrition_payload_for_day(
            template,
            workout_payload=plan_day.workout_json,
            goal=plan_week.goal,
        )
        if not _has_projected_nutrition(payload):
            continue
        plan_day.nutrition_json = payload
        plan_day.updated_at = now
        db.add(plan_day)
        updated.append(plan_day)

    if updated:
        db.commit()
        for plan_day in updated:
            db.refresh(plan_day)
    return updated


def backfill_active_week_missing_nutrition(
    db: Session,
    user_id: int,
    nutrition_templates: list[dict],
) -> list[PlanDay]:
    plan_week = get_active_week(db, user_id)
    if not plan_week:
        return []
    return backfill_missing_week_nutrition(db, plan_week, nutrition_templates)


def _normalized_focus(value: object) -> str:
    return " ".join(str(value or "").lower().replace("_", " ").split())


def _focus_family_for_day_payload(payload: dict | None) -> str | None:
    if not isinstance(payload, dict):
        return None
    try:
        from app.services.workout.focus_normalize import normalize_focus_to_family
        return normalize_focus_to_family(str(payload.get("focus") or ""))
    except Exception:
        return None


def _pick_repair_candidate(
    original: dict | None,
    fresh_workout_days: list[dict],
    used_indexes: set[int],
) -> tuple[int | None, dict | None]:
    if not isinstance(original, dict) or not fresh_workout_days:
        return None, None

    original_focus = _normalized_focus(original.get("focus"))
    original_family = _focus_family_for_day_payload(original)

    for idx, candidate in enumerate(fresh_workout_days):
        if idx in used_indexes:
            continue
        if _normalized_focus(candidate.get("focus") if isinstance(candidate, dict) else None) == original_focus:
            return idx, candidate

    if original_family:
        for idx, candidate in enumerate(fresh_workout_days):
            if idx in used_indexes:
                continue
            if _focus_family_for_day_payload(candidate) == original_family:
                return idx, candidate

    for idx, candidate in enumerate(fresh_workout_days):
        if idx not in used_indexes:
            return idx, candidate

    return None, None


def _planned_exercise_key(exercise: dict | None) -> str | None:
    if not isinstance(exercise, dict):
        return None
    slug = str(exercise.get("_slug") or exercise.get("slug") or "").strip().lower()
    if slug:
        return f"slug:{slug}"
    name = str(exercise.get("name") or "").strip().lower()
    return f"name:{name}" if name else None


def _equipment_label_parts(value: object) -> list[str]:
    text = str(value or "").strip()
    if not text:
        return []
    parts = [
        p.strip()
        for chunk in text.replace("/", ",").replace("|", ",").split(",")
        for p in chunk.split(";")
    ]
    return [p for p in parts if p]


def _planned_exercise_equipment_satisfied(
    exercise: dict | None,
    owned_equipment_slugs: set[str],
    seed_by_slug: dict[str, dict],
) -> bool:
    if not isinstance(exercise, dict):
        return True

    slug = str(exercise.get("_slug") or exercise.get("slug") or "").strip()
    seed = seed_by_slug.get(slug)
    if seed:
        from app.services.workout.planner import _equipment_satisfied
        return _equipment_satisfied(seed, set(owned_equipment_slugs))

    label = str(exercise.get("equipment") or "").strip()
    if not label:
        return True
    if label.lower() in {"bodyweight", "bodyweight only", "none", "no equipment"}:
        return True

    from app.services.workout.equipment import (
        expand_owned_equipment_aliases,
        resolve_owned_equipment_slugs,
    )

    required = resolve_owned_equipment_slugs(_equipment_label_parts(label))
    required.discard("bodyweight")
    if not required:
        return True
    owned = expand_owned_equipment_aliases(set(owned_equipment_slugs))
    return required.issubset(owned)


def _equipment_replacement_score(original: dict, candidate: dict) -> int:
    score = 0
    if original.get("_slot") and original.get("_slot") == candidate.get("_slot"):
        score += 100
    if original.get("_role") and original.get("_role") == candidate.get("_role"):
        score += 50
    if original.get("_primary_muscle") and original.get("_primary_muscle") == candidate.get("_primary_muscle"):
        score += 30
    original_secondaries = set(original.get("_secondary_muscles") or [])
    candidate_secondaries = set(candidate.get("_secondary_muscles") or [])
    score += min(15, len(original_secondaries & candidate_secondaries) * 5)
    return score


def _pick_equipment_replacement(
    original: dict,
    candidate_exercises: list[dict],
    owned_equipment_slugs: set[str],
    seed_by_slug: dict[str, dict],
    used_keys: set[str],
) -> dict | None:
    best: tuple[int, int, dict] | None = None
    for idx, candidate in enumerate(candidate_exercises):
        if not isinstance(candidate, dict):
            continue
        key = _planned_exercise_key(candidate)
        if key and key in used_keys:
            continue
        if not _planned_exercise_equipment_satisfied(candidate, owned_equipment_slugs, seed_by_slug):
            continue
        score = _equipment_replacement_score(original, candidate)
        if best is None or (score, -idx) > (best[0], best[1]):
            best = (score, -idx, candidate)
    return deepcopy(best[2]) if best is not None else None


def _repair_equipment_day_workout(
    original: dict,
    candidate: dict | None,
    owned_equipment_slugs: set[str],
    seed_by_slug: dict[str, dict],
) -> tuple[dict, bool]:
    original_exercises = original.get("exercises") or []
    if not isinstance(original_exercises, list) or not original_exercises:
        return original, False

    candidate_exercises = []
    if isinstance(candidate, dict) and isinstance(candidate.get("exercises"), list):
        candidate_exercises = [ex for ex in candidate.get("exercises") or [] if isinstance(ex, dict)]

    repaired_exercises: list[dict] = []
    used_keys: set[str] = set()
    changed = False
    missing_replacement = False

    for exercise in original_exercises:
        if not isinstance(exercise, dict):
            repaired_exercises.append(exercise)
            continue
        if _planned_exercise_equipment_satisfied(exercise, owned_equipment_slugs, seed_by_slug):
            kept = deepcopy(exercise)
            repaired_exercises.append(kept)
            key = _planned_exercise_key(kept)
            if key:
                used_keys.add(key)
            continue

        replacement = _pick_equipment_replacement(
            exercise,
            candidate_exercises,
            owned_equipment_slugs,
            seed_by_slug,
            used_keys,
        )
        if replacement is None:
            missing_replacement = True
            changed = True
            continue

        repaired_exercises.append(replacement)
        key = _planned_exercise_key(replacement)
        if key:
            used_keys.add(key)
        changed = True

    if missing_replacement and candidate_exercises:
        fallback = deepcopy(candidate)
        if original.get("day"):
            fallback["day"] = original.get("day")
        if original.get("focus"):
            fallback["focus"] = original.get("focus")
        return fallback, True

    if not changed:
        return original, False

    repaired = deepcopy(original)
    repaired["exercises"] = repaired_exercises
    return repaired, True


def repair_remaining_workouts_for_equipment(
    db: Session,
    plan_week: PlanWeek,
    fresh_workout_days: list[dict],
    owned_equipment_slugs: set[str],
    *,
    seed_exercises: list[dict] | None = None,
) -> list[PlanDay]:
    """Swap only now-unavailable equipment exercises on current/future days.

    The dated week, training/rest pattern, focus labels, completed days, and
    compatible exercises stay intact. This is the equipment counterpart to
    injury repair: a user who removes a barbell should not wait for the next
    PlanWeek just to stop seeing barbell work.
    """
    if not fresh_workout_days:
        return []

    seed_by_slug = {
        str(ex.get("slug")): ex
        for ex in (seed_exercises or [])
        if isinstance(ex, dict) and ex.get("slug")
    }
    today = date.today()
    days = get_week_days(db, plan_week.id)
    now = datetime.now(timezone.utc)
    used_indexes: set[int] = set()
    updated: list[PlanDay] = []

    for plan_day in days:
        if plan_day.locked or plan_day.day_date < today or plan_day.is_rest:
            continue
        original = plan_day.workout_json
        if not isinstance(original, dict) or not original.get("exercises"):
            continue

        exercises = [ex for ex in original.get("exercises") or [] if isinstance(ex, dict)]
        has_conflict = any(
            not _planned_exercise_equipment_satisfied(ex, owned_equipment_slugs, seed_by_slug)
            for ex in exercises
        )
        if not has_conflict:
            continue

        picked_idx, candidate = _pick_repair_candidate(original, fresh_workout_days, used_indexes)
        if picked_idx is not None:
            used_indexes.add(picked_idx)

        repaired, changed = _repair_equipment_day_workout(
            original,
            candidate,
            owned_equipment_slugs,
            seed_by_slug,
        )
        if not changed:
            continue
        if original.get("day"):
            repaired["day"] = original.get("day")
        if original.get("focus"):
            repaired["focus"] = original.get("focus")

        plan_day.workout_json = repaired
        plan_day.generation_source = "equipment_repair"
        plan_day.status = "planned"
        plan_day.updated_at = now
        db.add(plan_day)
        updated.append(plan_day)

    if updated:
        db.commit()
        for plan_day in updated:
            db.refresh(plan_day)
    return updated


def repair_remaining_workouts_for_injuries(
    db: Session,
    plan_week: PlanWeek,
    fresh_workout_days: list[dict],
) -> list[PlanDay]:
    """Replace today/future unlocked workouts with injury-aware exercises.

    The week structure stays intact: rest days stay rest, locked days stay
    untouched, and each repaired workout keeps its original displayed focus.
    """
    if not fresh_workout_days:
        return []

    today = date.today()
    days = get_week_days(db, plan_week.id)
    now = datetime.now(timezone.utc)
    used_indexes: set[int] = set()
    updated: list[PlanDay] = []

    for plan_day in days:
        if plan_day.locked or plan_day.day_date < today or plan_day.is_rest:
            continue
        original = plan_day.workout_json
        if not isinstance(original, dict) or not original.get("exercises"):
            continue

        picked_idx, candidate = _pick_repair_candidate(original, fresh_workout_days, used_indexes)
        if picked_idx is not None:
            used_indexes.add(picked_idx)
        if not isinstance(candidate, dict) or not candidate.get("exercises"):
            continue

        repaired = deepcopy(candidate)
        if original.get("day"):
            repaired["day"] = original.get("day")
        if original.get("focus"):
            repaired["focus"] = original.get("focus")

        plan_day.workout_json = repaired
        plan_day.generation_source = "injury_repair"
        plan_day.status = "planned"
        plan_day.updated_at = now
        db.add(plan_day)
        updated.append(plan_day)

    db.commit()
    for plan_day in updated:
        db.refresh(plan_day)
    return updated


def update_remaining_workouts_for_duration(
    db: Session,
    plan_week: PlanWeek,
    fresh_workout_days: list[dict],
    new_session_minutes: int,
) -> list[PlanDay]:
    """Rebuild unlocked current/future workouts for a new session budget.

    Duration changes do not alter the week calendar, rest/training pattern, or
    completed/started days. They only replace upcoming workout payloads with
    freshly generated versions that fit the new minute budget.
    """
    today = date.today()
    days = get_week_days(db, plan_week.id)
    now = datetime.now(timezone.utc)
    used_indexes: set[int] = set()
    updated: list[PlanDay] = []

    for plan_day in days:
        if plan_day.locked or plan_day.day_date < today or plan_day.is_rest:
            continue
        original = plan_day.workout_json
        if not isinstance(original, dict) or not original.get("exercises"):
            continue

        picked_idx, candidate = _pick_repair_candidate(original, fresh_workout_days, used_indexes)
        if picked_idx is not None:
            used_indexes.add(picked_idx)
        if not isinstance(candidate, dict) or not candidate.get("exercises"):
            continue

        rebuilt = deepcopy(candidate)
        if original.get("day"):
            rebuilt["day"] = original.get("day")
        if original.get("focus"):
            rebuilt["focus"] = original.get("focus")

        plan_day.workout_json = rebuilt
        plan_day.generation_source = "duration_update"
        plan_day.status = "planned"
        plan_day.updated_at = now
        db.add(plan_day)
        updated.append(plan_day)

    plan_week.session_minutes = new_session_minutes
    db.add(plan_week)
    db.commit()
    for plan_day in updated:
        db.refresh(plan_day)
    try:
        db.refresh(plan_week)
    except Exception:
        pass
    return updated


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
                plan_day.nutrition_json = _nutrition_payload_for_day(
                    nutrition_templates[j % len(nutrition_templates)],
                    workout_payload=plan_day.workout_json,
                    goal=plan_week.goal,
                )
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
            plan_day.nutrition_json = _nutrition_payload_for_day(
                nutrition_templates[plan_day.day_index % len(nutrition_templates)],
                workout_payload=plan_day.workout_json,
                goal=plan_week.goal,
            )

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
    *,
    plan_day_id: int | None = None,
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
    if not plan_day:
        return plan_day
    if plan_day.lock_reason == "completed":
        return plan_day
    matched_by_id = plan_day_id is not None and plan_day.id == plan_day_id
    if plan_day.locked and plan_day.lock_reason not in {"manual_edit", "started"}:
        return plan_day
    if not matched_by_id and not _completion_matches_plan_day(plan_day, focus_label):
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


def training_pattern_from_preferences(prefs: object | None, days_per_week: int) -> list[int]:
    raw = getattr(prefs, "training_day_pattern", None)
    if isinstance(raw, list):
        pattern: list[int] = []
        seen: set[int] = set()
        for value in raw:
            try:
                dow = int(value)
            except (TypeError, ValueError):
                continue
            if dow < 0 or dow > 6 or dow in seen:
                continue
            seen.add(dow)
            pattern.append(dow)
        pattern.sort()
        if len(pattern) == days_per_week:
            return pattern
    return default_training_pattern(days_per_week)


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
    apply_coach_adjustments: bool = True,
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
    from app.services.workout.planner import generate_workout_plan
    from app.services.workout.planner_context import build_planweek_planner_context
    from app.services.workout.custom_catalog import planner_catalog_for_user, with_custom_catalog_inputs
    from app.services.workout.weekly_recipe import PLANNER_VERSION
    from app.seed_exercises_data import SEED_EXERCISES
    import json

    # Snapshot the goal the expiring week was generated with so the review
    # evaluates that week against its own goal, not whatever UserGoal is
    # active now (user may have changed goal mid-week).
    expiring_pw = get_active_week(db, user_id)
    expiring_goal = expiring_pw.goal if expiring_pw else None

    # Manual-mode short-circuit: when the user has opted out of
    # auto-generation, skip the planner entirely and spawn a fresh empty
    # week so they can assemble it from saved templates. Coaching
    # adjustments (deload, calorie deltas) are intentionally bypassed —
    # those mutate UserPreferences/CoachingState assuming a generated
    # plan is about to be built; in manual mode they'd silently change
    # state with no plan to apply them to. Re-enable when the user flips
    # workout_manual_mode back off.
    prefs_pre = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    if prefs_pre and getattr(prefs_pre, "workout_manual_mode", False):
        today = date.today()
        anchor = get_plan_cadence_anchor(db, user_id)
        if anchor is None:
            anchor = expiring_pw.start_date if expiring_pw else today
            set_plan_cadence_anchor_if_unset(db, user_id, anchor)
        week_start = next_plan_week_start(anchor, today)
        manual_goal = expiring_pw.goal if expiring_pw else None
        manual_days = expiring_pw.days_per_week if expiring_pw else None
        manual_split = expiring_pw.preferred_split if expiring_pw else None
        pw = create_empty_manual_plan_week(
            db, user_id,
            start_date=week_start,
            goal=manual_goal,
            days_per_week=manual_days,
            preferred_split=manual_split,
            planner_version=PLANNER_VERSION,
            goal_pace=expiring_pw.goal_pace if expiring_pw else None,
            session_minutes=expiring_pw.session_minutes if expiring_pw else None,
        )
        return {
            "plan_week_id": pw.id,
            "review_headline": "Manual mode — assemble your week from saved templates.",
            "auto_applied": [],
            "needs_review": [],
            "explanation": "Auto-generation is paused. Tap each day to assign a template or mark it as rest.",
            "manual_mode": True,
        }

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

    # Step 2a: Readiness-based auto-deload — if readiness is low (< 40),
    # immediately reduce volume for the new week so
    # the planner reads a lower adjustment before generating the plan.
    if apply_coach_adjustments and readiness_score is not None and readiness_score < 40:
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
    auto_applied, needs_review = (
        compute_auto_apply_defaults(rec_dicts)
        if apply_coach_adjustments
        else ([], [])
    )

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
    goal = effective_goal_id(active_goal)
    goal_pace = active_goal.pace.value if active_goal and active_goal.pace else None
    days_per_week = int(getattr(prefs, "days_per_week", None) or getattr(profile, "days_per_week", 4) or 4)
    session_minutes = int(getattr(prefs, "workout_duration_minutes", None) or getattr(profile, "workout_duration_minutes", 45) or 45)
    preferred_split = _preferred_split_for_next_week(prefs, profile, expiring_pw)
    today = date.today()
    anchor = get_plan_cadence_anchor(db, user_id)
    if anchor is None:
        anchor = expiring_pw.start_date if expiring_pw else today
        # Stamp the user so subsequent renewals stay on this rhythm.
        set_plan_cadence_anchor_if_unset(db, user_id, anchor)
    week_start = next_plan_week_start(anchor, today)

    planner_ctx = build_planweek_planner_context(
        db,
        user_id,
        profile,
        prefs,
        goal=goal,
        days_per_week=days_per_week,
        session_minutes=session_minutes,
        preferred_split=preferred_split,
        avg_resting_hr=avg_resting_hr,
        cycle_phase=cycle_phase,
        day_of_cycle=day_of_cycle,
    )

    exercise_catalog, custom_owned_slugs = planner_catalog_for_user(db, user_id, SEED_EXERCISES)
    plan = generate_workout_plan(
        with_custom_catalog_inputs(planner_ctx.inputs, custom_owned_slugs), exercise_catalog,
        history_familiarity=planner_ctx.history_familiarity,
        perf_profiles=planner_ctx.perf_profiles,
        recent_muscle_exercises=planner_ctx.recent_muscle_exercises,
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

    training_pattern = training_pattern_from_preferences(prefs, days_per_week)

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
    if not apply_coach_adjustments:
        explanation_parts.append("Generated the next week without coach check-in adjustments.")
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
            "week_start": review.week_start.isoformat(),
            "week_end": review.week_end.isoformat(),
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
