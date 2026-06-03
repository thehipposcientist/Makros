"""Apply a recommendation action to durable user state.

Architectural principle (per product direction):
  The AI / weekly review can only do what the user can do via
  existing app UI. Recommendations don't directly mutate the active
  WorkoutPlan — they mutate the user-facing settings (UserPreferences,
  UserCoachingState, UserGoal, UserDayState) that the planner already
  reacts to when a future PlanWeek is generated. The active PlanWeek
  is not regenerated or rewritten by this service.

This means: every applyable action maps to ONE of these existing
user-touchable surfaces. Anything else is descriptive guidance, not
something we silently apply.

Supported action types (matches `plan_review_v2.Recommendation.action.type`
and `quick_intents.IntentResponse.action.type`):
  • change_days_per_week           → UserPreferences.days_per_week
  • raise_calories / lower_calories → UserCoachingState.calorie_adjustment
  • hold_calorie_adjustment         → no-op + log (signals to next
                                       adaptive_macros pass: don't move)
  • shorten_workout                 → UserPreferences.workout_duration_minutes
                                       (one new column — see migration)
  • swap_to_recovery                → UserDayState recovery override on target date
                                       (defaults to tomorrow)
  • schedule_deload                 → UserCoachingState.deload_until_date
                                       + volume_adjustment_pct
  • reduce_muscle_volume /
    add_muscle_volume /
    hold_muscle_volume              → UserCoachingState.muscle_volume_adjustments
  • reduce_intensity                → UserCoachingState.intensity_adjustment_pct
  • set_core_frequency              → UserPreferences.core_frequency_per_week
  • carb_bump_today                 → UserDayState (one-day macro override
                                       — read by /meals/daily-macros)
  • noop                            → ack only
  • add_cardio_session/add_zone2_session → translated to days_per_week + 1
                                            ONLY if user is below their
                                            stated cap. Otherwise descriptive.

For descriptive-only actions (raise_protein_target, rebalance_week, etc.)
we record them as `CoachMemory(event_type="recommendation_acked")` so
the coach can reference them later, but they don't claim to rewrite the
plan.

Pure-ish: writes to the DB but never calls AI. Returns a structured
result the caller can show on the UI ("changed days/week from 4 to 3;
future weeks will use it").
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import re
from typing import Any

from sqlmodel import select

from app.models import (
    CoachMemory, UserCoachingState, UserDayState, UserPreferences, UserProfile,
)


# Hard caps so a single recommendation can never make a destructive
# change. Anything outside this range is downgraded to a descriptive
# memory record + a "needs user confirmation" flag.
_MAX_KCAL_DELTA = 250          # per single apply
_MAX_DAYS_DELTA = 1            # never jump >1 day at once
_KCAL_FLOOR_DEFAULT = 1500     # absolute minimum kcal target post-apply
_MAX_GLOBAL_VOLUME_PCT = 40
_MAX_MUSCLE_VOLUME_PCT = 40
_MAX_INTENSITY_PCT = 20


def _human_label(value: Any, *, lower: bool = True) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    text = re.sub(r"[_\-]+", " ", text)
    text = " ".join(text.split())
    return text.lower() if lower else text.title()


def _clamp_int(value: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, value))


def _normalize_muscle(value: Any) -> str | None:
    muscle = str(value or "").strip().lower()
    muscle = re.sub(r"[\s\-]+", "_", muscle)
    return muscle or None


def _numeric_action_value(action: dict[str, Any], *keys: str, default: int = 0) -> int:
    for key in keys:
        value = action.get(key)
        if isinstance(value, (int, float)):
            return int(round(value))
        if isinstance(value, str) and value.strip():
            try:
                return int(round(float(value)))
            except ValueError:
                continue
    return default


def _profile_duration_minutes(db: Any, user_id: int) -> int | None:
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    if not profile:
        return None
    value = getattr(profile, "workout_duration_minutes", None)
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def _muscle_adjustments(state: UserCoachingState) -> dict[str, dict[str, Any]]:
    raw = state.muscle_volume_adjustments or {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for muscle, data in raw.items():
        key = _normalize_muscle(muscle)
        if not key:
            continue
        if isinstance(data, dict):
            pct = _numeric_action_value(data, "pct", default=0)
            mode = str(data.get("mode") or "").strip().lower() or "adjust"
        elif isinstance(data, (int, float)):
            pct = int(round(data))
            mode = "adjust"
        else:
            continue
        out[key] = {
            "pct": _clamp_int(pct, -_MAX_MUSCLE_VOLUME_PCT, _MAX_MUSCLE_VOLUME_PCT),
            "mode": mode,
        }
    return out


def _descriptive_summary(action_type: str, action: dict[str, Any]) -> str:
    muscle = _human_label(action.get("muscle"))
    muscle_prefix = f"{muscle} " if muscle else ""

    if action_type == "reduce_muscle_volume":
        pct = action.get("pct")
        pct_text = f" by about {int(pct)}%" if isinstance(pct, (int, float)) and pct > 0 else ""
        return f"The next generated week will reduce {muscle_prefix}volume{pct_text}."

    if action_type == "add_muscle_volume":
        sets = action.get("sets")
        sets_text = f"{int(sets)} " if isinstance(sets, (int, float)) and sets > 0 else ""
        return f"The next generated week will add {sets_text}{muscle_prefix}sets."

    if action_type == "hold_muscle_volume":
        return f"The next generated week will hold {muscle_prefix}volume steady."

    if action_type == "reduce_cardio":
        minutes = action.get("minutes")
        minutes_text = f" by about {int(minutes)} min" if isinstance(minutes, (int, float)) and minutes > 0 else ""
        return f"The next generated week will trim cardio{minutes_text}."

    if action_type == "reduce_intensity":
        return "Intensity reduction noted. Drop top-set loads about 10-15% today."

    if action_type == "raise_protein_target":
        grams = action.get("grams") or action.get("protein_g")
        grams_text = f" around {int(grams)}g/day" if isinstance(grams, (int, float)) and grams > 0 else ""
        return f"Protein target preference noted{grams_text}."

    if action_type == "raise_fiber_target":
        grams = action.get("grams") or action.get("fiber_g")
        grams_text = f" around {int(grams)}g/day" if isinstance(grams, (int, float)) and grams > 0 else ""
        return f"Fiber target preference noted{grams_text}."

    if action_type == "rebalance_week":
        return "Week rebalance noted. Your active week stays fixed; this will inform the next review."

    if action_type == "strength_preservation":
        return "Strength-preservation priority noted while calories or volume change."

    if action_type == "swap_to_recovery_or_reduce":
        return "Recovery option noted. Use Workout > Plan > Change Focus for this week, or go lighter today."

    if action_type == "increase_meal_logging":
        return "Meal-logging target noted. Aim for 4+ logged days next week."

    if action_type == "adjust_meal_timing":
        return "Meal-timing target noted for steadier energy and satiety."

    if action_type == "improve_protein_consistency":
        return "Protein consistency noted. Anchor protein earlier in the day."

    if action_type == "adjust_protein_target":
        return "Protein target preference noted for next week's plan."

    return f"{_human_label(action_type, lower=False)} recommendation noted."


def _accepted_memory_summary(action_type: str, action: dict[str, Any], fallback_summary: str | None = None) -> str:
    summary = (fallback_summary or _descriptive_summary(action_type, action)).strip().rstrip(".")
    if summary.startswith("The next generated week will "):
        summary = summary.replace("The next generated week will ", "", 1)
        return f"Accepted recommendation: {summary} next generated week."
    return f"Accepted recommendation: {summary[0].lower() + summary[1:] if summary else _human_label(action_type)}."


@dataclass
class ApplyResult:
    applied: bool
    summary: str               # one sentence the UI shows
    needs_regen: bool          # caller should kick the planner
    changed_fields: dict[str, Any]
    descriptive_only: bool = False
    error: str | None = None
    undo_action: dict[str, Any] | None = None

    def to_dict(self) -> dict:
        return {
            "applied": self.applied,
            "summary": self.summary,
            "needs_regen": self.needs_regen,
            "changed_fields": self.changed_fields,
            "descriptive_only": self.descriptive_only,
            "error": self.error,
            "undo_action": self.undo_action,
        }


def _coaching_state(db: Any, user_id: int) -> UserCoachingState:
    state = db.exec(
        select(UserCoachingState).where(UserCoachingState.user_id == user_id)
    ).first()
    if state:
        return state
    state = UserCoachingState(user_id=user_id)
    db.add(state)
    db.flush()
    return state


def _preferences(db: Any, user_id: int) -> UserPreferences | None:
    return db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()


def _record_memory(db: Any, user_id: int, event_type: str, summary: str, details: dict | None = None) -> None:
    """Record a coach memory row so the next AI prompt sees the
    recommendation was acknowledged + can reference it later."""
    db.add(CoachMemory(
        user_id=user_id,
        event_type=event_type,
        summary=summary,
        details=details or {},
    ))


def _descriptive_ack(
    db: Any,
    user_id: int,
    action_type: str,
    action: dict[str, Any],
    rec_key: str | None,
    summary: str,
) -> ApplyResult:
    _record_memory(db, user_id, "recommendation_acked",
        _accepted_memory_summary(action_type, action, summary),
        {"action": action, "rec_key": rec_key})
    db.commit()
    return ApplyResult(
        applied=True,
        summary=summary,
        needs_regen=False,
        changed_fields={},
        descriptive_only=True,
    )


def _parse_date(value: Any, fallback: date) -> date:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return fallback
    return fallback


def _day_state(db: Any, user_id: int, day_key: date) -> UserDayState:
    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == user_id, UserDayState.day_key == day_key)
    ).first()
    if state:
        return state
    state = UserDayState(
        user_id=user_id,
        day_key=day_key,
        meal_checks={},
        nutrition_plan=None,
    )
    db.add(state)
    db.flush()
    return state


def apply_action(
    db: Any,
    user_id: int,
    action: dict[str, Any],
    *,
    rec_key: str | None = None,
) -> ApplyResult:
    """Apply a single recommendation action. Caller is responsible for
    any follow-up refresh. This service never calls the planner or
    rewrites the active PlanWeek."""
    if not isinstance(action, dict):
        return ApplyResult(applied=False, summary="No action provided", needs_regen=False, changed_fields={}, error="invalid_action")
    action_type = str(action.get("type") or "").strip()
    if not action_type:
        return ApplyResult(applied=False, summary="No action type", needs_regen=False, changed_fields={}, error="missing_type")

    # ── change_days_per_week ────────────────────────────────────────
    if action_type == "change_days_per_week":
        prefs = _preferences(db, user_id)
        if not prefs:
            return ApplyResult(applied=False, summary="No preferences row", needs_regen=False, changed_fields={}, error="no_prefs")
        target = int(action.get("value") or 0)
        if not (1 <= target <= 7):
            return ApplyResult(applied=False, summary="Invalid day count", needs_regen=False, changed_fields={}, error="invalid_value")
        if abs(target - prefs.days_per_week) > _MAX_DAYS_DELTA:
            return ApplyResult(
                applied=False,
                summary=f"Day change capped — going from {prefs.days_per_week} → {target} would jump too fast.",
                needs_regen=False,
                changed_fields={},
                descriptive_only=True,
                error="delta_capped",
            )
        old = prefs.days_per_week
        prefs.days_per_week = target
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        _record_memory(db, user_id, "ai_apply",
            f"Days/week changed from {old} → {target} via recommendation {rec_key or 'unknown'}",
            {"action": action, "from": old, "to": target})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Updated to {target} days / week. Future generated weeks will use it.",
            needs_regen=True,
            changed_fields={
                "days_per_week": target,
                "days_per_week_change": {"from": old, "to": target},
            },
            undo_action={"type": "change_days_per_week", "value": old},
        )

    # ── raise_calories / lower_calories ─────────────────────────────
    if action_type in ("raise_calories", "lower_calories"):
        kcal = int(action.get("kcal") or 0)
        if kcal <= 0:
            return ApplyResult(applied=False, summary="No kcal delta", needs_regen=False, changed_fields={}, error="invalid_kcal")
        kcal = min(kcal, _MAX_KCAL_DELTA)
        sign = 1 if action_type == "raise_calories" else -1
        delta = sign * kcal
        state = _coaching_state(db, user_id)
        old = state.calorie_adjustment
        state.calorie_adjustment = old + delta
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply",
            f"Calorie adjustment {old:+d} → {state.calorie_adjustment:+d}",
            {"action": action, "delta": delta})
        db.commit()
        verb = "Raised" if delta > 0 else "Lowered"
        return ApplyResult(
            applied=True,
            summary=f"{verb} daily calorie target by {abs(delta)} kcal. Daily macro targets will use it on the next check.",
            needs_regen=False,
            changed_fields={
                "calorie_adjustment": state.calorie_adjustment,
                "calorie_adjustment_change": {"from": old, "to": state.calorie_adjustment},
            },
            undo_action={"type": "adjust_calorie_target", "delta": -delta},
        )

    # ── adjust_calorie_target (signed delta — nutrition review path) ──
    # Unified alternative to raise_calories / lower_calories: takes a
    # signed `delta` field so callers don't need to pick the verb.
    if action_type == "adjust_calorie_target":
        delta = int(action.get("delta") or 0)
        if delta == 0:
            return ApplyResult(applied=True, summary="No calorie change needed.", needs_regen=False, changed_fields={})
        delta = max(-_MAX_KCAL_DELTA, min(_MAX_KCAL_DELTA, delta))
        state = _coaching_state(db, user_id)
        old = state.calorie_adjustment
        state.calorie_adjustment = old + delta
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply",
            f"Calorie adjustment {old:+d} → {state.calorie_adjustment:+d} via nutrition review",
            {"action": action, "delta": delta})
        db.commit()
        verb = "Raised" if delta > 0 else "Lowered"
        return ApplyResult(
            applied=True,
            summary=f"{verb} daily calorie target by {abs(delta)} kcal. Takes effect on next plan check.",
            needs_regen=False,
            changed_fields={
                "calorie_adjustment": state.calorie_adjustment,
                "calorie_adjustment_change": {"from": old, "to": state.calorie_adjustment},
            },
            undo_action={"type": "adjust_calorie_target", "delta": -delta},
        )

    # ── hold_calorie_adjustment ─────────────────────────────────────
    if action_type == "hold_calorie_adjustment":
        # No state mutation — the adaptive_macros pass already respects
        # `MIN_LOGGED_DAYS` etc. We just record the explicit "hold" so
        # if the user asks "should I cut more?" the trainer sees this.
        _record_memory(db, user_id, "ai_apply",
            "User confirmed: hold calorie adjustment until recovery improves",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Holding calories at the current target until recovery signals improve.",
            needs_regen=False,
            changed_fields={},
        )

    # ── swap_to_recovery (defaults to tomorrow, can target a date) ───
    if action_type == "swap_to_recovery":
        # Mark the target date as a recovery focus via UserDayState.
        # The active PlanWeek stays fixed; the app reads this day-state
        # overlay the same way it reads a user-initiated skip.
        today = date.today()
        default_day = today + timedelta(days=1)
        target_day = _parse_date(
            action.get("date") or action.get("day_key") or action.get("target_date"),
            default_day,
        )
        if target_day < today:
            target_day = today
        day_label = (
            "Today" if target_day == today
            else "Tomorrow" if target_day == default_day
            else str(target_day)
        )
        reason = str(action.get("reason") or "Coach swapped to recovery").strip() or "Coach swapped to recovery"
        reason = reason[:160]
        state = _day_state(db, user_id, target_day)
        old = state.skipped_focus
        old_reason = state.skip_reason
        state.skipped_focus = "recovery"
        state.skip_reason = reason
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply",
            f"{day_label} swapped to active recovery via recommendation",
            {"action": action, "date": str(target_day)})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"{day_label} is set as a recovery day.",
            needs_regen=False,
            changed_fields={
                "skipped_focus": {"date": str(target_day), "from": old, "to": "recovery"},
                "skip_reason": {"date": str(target_day), "from": old_reason, "to": state.skip_reason},
            },
            undo_action={
                "type": "set_day_focus",
                "date": str(target_day),
                "skipped_focus": old,
                "skip_reason": old_reason,
            },
        )

    # ── set_day_focus / clear_day_state_focuses (undo helpers) ───────
    if action_type == "set_day_focus":
        target_date = _parse_date(action.get("date"), date.today())
        state = _day_state(db, user_id, target_date)
        old = state.skipped_focus
        old_reason = state.skip_reason
        state.skipped_focus = action.get("skipped_focus")
        if "skip_reason" in action:
            state.skip_reason = action.get("skip_reason")
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply_undo",
            f"Day focus override restored for {target_date}",
            {"action": action, "from": old, "to": state.skipped_focus})
        db.commit()
        changed_fields = {
            "skipped_focus": {"date": str(target_date), "from": old, "to": state.skipped_focus},
        }
        if "skip_reason" in action:
            changed_fields["skip_reason"] = {
                "date": str(target_date),
                "from": old_reason,
                "to": state.skip_reason,
            }
        return ApplyResult(
            applied=True,
            summary=f"Restored day override for {target_date}.",
            needs_regen=False,
            changed_fields=changed_fields,
        )

    if action_type == "clear_day_state_focuses":
        raw_dates = action.get("dates") or []
        dates = [
            _parse_date(d, date.today())
            for d in raw_dates
            if isinstance(d, (str, date))
        ][:14]
        changed: list[str] = []
        for target_date in dates:
            state = db.exec(
                select(UserDayState)
                .where(UserDayState.user_id == user_id, UserDayState.day_key == target_date)
            ).first()
            if state and state.skipped_focus is not None:
                state.skipped_focus = None
                state.updated_at = datetime.now(timezone.utc)
                db.add(state)
                changed.append(str(target_date))
        _record_memory(db, user_id, "ai_apply_undo",
            f"Cleared {len(changed)} paused/travel day override(s)",
            {"action": action, "dates": changed})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Cleared {len(changed)} paused day{'' if len(changed) == 1 else 's'}.",
            needs_regen=False,
            changed_fields={"cleared_dates": changed},
        )

    # ── shorten_workout / set_workout_duration ──────────────────────
    if action_type in ("shorten_workout", "set_workout_duration"):
        has_absolute_minutes = action.get("minutes") or action.get("value")
        has_delta_minutes = action.get("target_minutes_delta") or action.get("delta_minutes")
        if action_type == "shorten_workout" and not (has_absolute_minutes or has_delta_minutes):
            return _descriptive_ack(
                db, user_id, action_type, action, rec_key,
                "Workout duration preference noted for the next plan review.",
            )
        prefs = _preferences(db, user_id)
        if not prefs:
            return ApplyResult(applied=False, summary="No preferences row", needs_regen=False, changed_fields={}, error="no_prefs")
        if has_delta_minutes:
            base_minutes = (
                getattr(prefs, "workout_duration_minutes", None)
                or _profile_duration_minutes(db, user_id)
                or 45
            )
            minutes = int(base_minutes) + _numeric_action_value(action, "target_minutes_delta", "delta_minutes")
        else:
            minutes = int(action.get("minutes") or action.get("value") or 0)
        if minutes <= 0:
            return ApplyResult(applied=False, summary="No duration provided", needs_regen=False, changed_fields={}, error="invalid_minutes")
        minutes = max(20, min(90, minutes))
        old = prefs.workout_duration_minutes
        prefs.workout_duration_minutes = minutes
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        _record_memory(db, user_id, "ai_apply",
            f"Workout duration changed from {old or 'default'} → {minutes} minutes",
            {"action": action, "from": old, "to": minutes})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Workout duration preference set to {minutes} minutes. New weeks will use it.",
            needs_regen=True,
            changed_fields={"workout_duration_minutes": {"from": old, "to": minutes}},
            undo_action=(
                {"type": "clear_workout_duration"}
                if old is None else {"type": "set_workout_duration", "minutes": old}
            ),
        )

    if action_type == "clear_workout_duration":
        prefs = _preferences(db, user_id)
        if not prefs:
            return ApplyResult(applied=False, summary="No preferences row", needs_regen=False, changed_fields={}, error="no_prefs")
        old = prefs.workout_duration_minutes
        prefs.workout_duration_minutes = None
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        _record_memory(db, user_id, "ai_apply_undo",
            "Workout duration preference restored to profile default",
            {"action": action, "from": old, "to": None})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Workout duration preference restored to your profile default.",
            needs_regen=True,
            changed_fields={"workout_duration_minutes": {"from": old, "to": None}},
        )

    # ── schedule_deload ─────────────────────────────────────────────
    if action_type == "schedule_deload":
        if not any(k in action for k in ("duration_days", "days", "end_date")):
            return _descriptive_ack(
                db, user_id, action_type, action, rec_key,
                "Deload recommendation noted for the next plan review.",
            )
        duration_days = int(action.get("duration_days") or 7)
        duration_days = max(3, min(14, duration_days))
        until = date.today() + timedelta(days=duration_days)
        state = _coaching_state(db, user_id)
        old_until = state.deload_until_date
        old_volume = state.volume_adjustment_pct
        state.deload_until_date = until
        state.volume_adjustment_pct = min(old_volume, -30)
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply",
            f"Deload scheduled through {until}",
            {"action": action, "from": str(old_until) if old_until else None, "to": str(until)})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Deload scheduled through {until}. New weeks will reduce volume.",
            needs_regen=True,
            changed_fields={
                "deload_until_date": {"from": str(old_until) if old_until else None, "to": str(until)},
                "volume_adjustment_pct": {"from": old_volume, "to": state.volume_adjustment_pct},
            },
            undo_action={
                "type": "restore_deload",
                "deload_until_date": str(old_until) if old_until else None,
                "volume_adjustment_pct": old_volume,
            },
        )

    if action_type == "restore_deload":
        state = _coaching_state(db, user_id)
        old_until = state.deload_until_date
        old_volume = state.volume_adjustment_pct
        target_until = action.get("deload_until_date")
        state.deload_until_date = _parse_date(target_until, date.today()) if target_until else None
        state.volume_adjustment_pct = int(action.get("volume_adjustment_pct") or 0)
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply_undo",
            "Deload settings restored",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Deload settings restored.",
            needs_regen=True,
            changed_fields={
                "deload_until_date": {
                    "from": str(old_until) if old_until else None,
                    "to": str(state.deload_until_date) if state.deload_until_date else None,
                },
                "volume_adjustment_pct": {"from": old_volume, "to": state.volume_adjustment_pct},
            },
        )

    # ── muscle volume / intensity preferences for future weeks ───────
    if action_type in ("reduce_muscle_volume", "add_muscle_volume", "hold_muscle_volume"):
        state = _coaching_state(db, user_id)
        muscle = _normalize_muscle(action.get("muscle"))
        if not muscle:
            if action_type == "reduce_muscle_volume":
                pct = _clamp_int(_numeric_action_value(action, "pct", default=15), 5, 35)
                old = state.volume_adjustment_pct
                state.volume_adjustment_pct = _clamp_int(old - pct, -_MAX_GLOBAL_VOLUME_PCT, _MAX_GLOBAL_VOLUME_PCT)
                state.updated_at = datetime.now(timezone.utc)
                db.add(state)
                _record_memory(db, user_id, "ai_apply",
                    f"Global workout volume adjustment {old:+d}% → {state.volume_adjustment_pct:+d}%",
                    {"action": action, "from": old, "to": state.volume_adjustment_pct})
                db.commit()
                return ApplyResult(
                    applied=True,
                    summary=f"Reduced next generated week's lifting volume by about {pct}%.",
                    needs_regen=True,
                    changed_fields={
                        "volume_adjustment_pct": {"from": old, "to": state.volume_adjustment_pct},
                    },
                    undo_action={"type": "restore_volume_adjustment", "volume_adjustment_pct": old},
                )
            return _descriptive_ack(
                db, user_id, action_type, action, rec_key,
                "Muscle-volume preference noted, but no target muscle was provided.",
            )

        adjustments = _muscle_adjustments(state)
        previous = adjustments.get(muscle, {"pct": 0, "mode": "adjust"}).copy()
        if action_type == "reduce_muscle_volume":
            pct = _clamp_int(_numeric_action_value(action, "pct", default=15), 5, 35)
            next_pct = _clamp_int(int(previous.get("pct") or 0) - pct, -_MAX_MUSCLE_VOLUME_PCT, _MAX_MUSCLE_VOLUME_PCT)
            mode = "reduce"
        elif action_type == "add_muscle_volume":
            sets = _numeric_action_value(action, "sets", "value", default=3)
            pct = _clamp_int(_numeric_action_value(action, "pct", default=max(10, sets * 5)), 5, 30)
            next_pct = _clamp_int(int(previous.get("pct") or 0) + pct, -_MAX_MUSCLE_VOLUME_PCT, _MAX_MUSCLE_VOLUME_PCT)
            mode = "add"
        else:
            next_pct = min(int(previous.get("pct") or 0), 0)
            mode = "hold"

        adjustments[muscle] = {
            "pct": next_pct,
            "mode": mode,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "rec_key": rec_key,
        }
        old_payload = state.muscle_volume_adjustments
        state.muscle_volume_adjustments = adjustments
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        summary = _descriptive_summary(action_type, action)
        _record_memory(db, user_id, "ai_apply",
            _accepted_memory_summary(action_type, action, summary),
            {"action": action, "rec_key": rec_key, "from": previous, "to": adjustments[muscle]})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=summary,
            needs_regen=True,
            changed_fields={
                "muscle_volume_adjustments": {
                    "muscle": muscle,
                    "from": previous,
                    "to": adjustments[muscle],
                },
            },
            undo_action={
                "type": "restore_muscle_volume_adjustments",
                "muscle_volume_adjustments": old_payload,
            },
        )

    if action_type == "restore_volume_adjustment":
        state = _coaching_state(db, user_id)
        old = state.volume_adjustment_pct
        state.volume_adjustment_pct = _clamp_int(
            _numeric_action_value(action, "volume_adjustment_pct", default=0),
            -_MAX_GLOBAL_VOLUME_PCT,
            _MAX_GLOBAL_VOLUME_PCT,
        )
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply_undo",
            "Global volume adjustment restored",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Volume adjustment restored.",
            needs_regen=True,
            changed_fields={"volume_adjustment_pct": {"from": old, "to": state.volume_adjustment_pct}},
        )

    if action_type == "restore_muscle_volume_adjustments":
        state = _coaching_state(db, user_id)
        old = state.muscle_volume_adjustments
        payload = action.get("muscle_volume_adjustments")
        state.muscle_volume_adjustments = payload if isinstance(payload, dict) else None
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply_undo",
            "Muscle volume adjustments restored",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Muscle volume adjustment restored.",
            needs_regen=True,
            changed_fields={"muscle_volume_adjustments": {"from": old, "to": state.muscle_volume_adjustments}},
        )

    if action_type == "reduce_intensity":
        pct = _clamp_int(_numeric_action_value(action, "pct", "value", default=10), 5, _MAX_INTENSITY_PCT)
        state = _coaching_state(db, user_id)
        old = state.intensity_adjustment_pct
        state.intensity_adjustment_pct = _clamp_int(old - pct, -_MAX_INTENSITY_PCT, _MAX_INTENSITY_PCT)
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply",
            f"Intensity adjustment {old:+d}% → {state.intensity_adjustment_pct:+d}%",
            {"action": action, "from": old, "to": state.intensity_adjustment_pct})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Next generated week will use easier lifting intensity targets.",
            needs_regen=True,
            changed_fields={
                "intensity_adjustment_pct": {"from": old, "to": state.intensity_adjustment_pct},
            },
            undo_action={"type": "restore_intensity_adjustment", "intensity_adjustment_pct": old},
        )

    if action_type == "restore_intensity_adjustment":
        state = _coaching_state(db, user_id)
        old = state.intensity_adjustment_pct
        state.intensity_adjustment_pct = _clamp_int(
            _numeric_action_value(action, "intensity_adjustment_pct", default=0),
            -_MAX_INTENSITY_PCT,
            _MAX_INTENSITY_PCT,
        )
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply_undo",
            "Intensity adjustment restored",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Intensity adjustment restored.",
            needs_regen=True,
            changed_fields={"intensity_adjustment_pct": {"from": old, "to": state.intensity_adjustment_pct}},
        )

    # ── set_core_frequency ──────────────────────────────────────────
    if action_type == "set_core_frequency":
        if not (action.get("days_per_week") is not None or action.get("value") is not None):
            return _descriptive_ack(
                db, user_id, action_type, action, rec_key,
                "Core frequency preference noted for the next plan review.",
            )
        prefs = _preferences(db, user_id)
        if not prefs:
            return ApplyResult(applied=False, summary="No preferences row", needs_regen=False, changed_fields={}, error="no_prefs")
        days = int(action.get("days_per_week") or action.get("value") or 0)
        if not (0 <= days <= 7):
            return ApplyResult(applied=False, summary="Invalid core frequency", needs_regen=False, changed_fields={}, error="invalid_value")
        old = prefs.core_frequency_per_week
        prefs.core_frequency_per_week = days
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        _record_memory(db, user_id, "ai_apply",
            f"Core frequency changed from {old if old is not None else 'default'} → {days} days/week",
            {"action": action, "from": old, "to": days})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Core preference set to {days} days / week for future plans.",
            needs_regen=True,
            changed_fields={"core_frequency_per_week": {"from": old, "to": days}},
            undo_action=(
                {"type": "clear_core_frequency"}
                if old is None else {"type": "set_core_frequency", "days_per_week": old}
            ),
        )

    if action_type == "clear_core_frequency":
        prefs = _preferences(db, user_id)
        if not prefs:
            return ApplyResult(applied=False, summary="No preferences row", needs_regen=False, changed_fields={}, error="no_prefs")
        old = prefs.core_frequency_per_week
        prefs.core_frequency_per_week = None
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        _record_memory(db, user_id, "ai_apply_undo",
            "Core frequency restored to planner default",
            {"action": action, "from": old, "to": None})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Core frequency restored to planner default.",
            needs_regen=True,
            changed_fields={"core_frequency_per_week": {"from": old, "to": None}},
        )

    # ── carb_bump_today ─────────────────────────────────────────────
    if action_type == "carb_bump_today":
        if not (action.get("extra_g") or action.get("carbs_g")):
            return _descriptive_ack(
                db, user_id, action_type, action, rec_key,
                "Carb timing recommendation noted for today.",
            )
        extra_g = int(action.get("extra_g") or action.get("carbs_g") or 0)
        if extra_g <= 0:
            return ApplyResult(applied=False, summary="No carb bump provided", needs_regen=False, changed_fields={}, error="invalid_value")
        extra_g = max(20, min(125, extra_g))
        target_date = _parse_date(action.get("date"), date.today())
        state = _day_state(db, user_id, target_date)
        old = state.macro_overrides
        state.macro_overrides = {
            **(old or {}),
            "carb_bump_g": extra_g,
            "source": "coach",
        }
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply",
            f"Carb bump added for {target_date}: +{extra_g}g carbs",
            {"action": action, "date": str(target_date), "from": old, "to": state.macro_overrides})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Added +{extra_g}g carbs to {target_date}'s macro adjustment.",
            needs_regen=False,
            changed_fields={"macro_overrides": {"date": str(target_date), "from": old, "to": state.macro_overrides}},
            undo_action={"type": "restore_macro_override", "date": str(target_date), "macro_overrides": old},
        )

    if action_type == "restore_macro_override":
        target_date = _parse_date(action.get("date"), date.today())
        state = _day_state(db, user_id, target_date)
        old = state.macro_overrides
        state.macro_overrides = action.get("macro_overrides")
        state.updated_at = datetime.now(timezone.utc)
        db.add(state)
        _record_memory(db, user_id, "ai_apply_undo",
            f"Macro override restored for {target_date}",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Macro override restored for {target_date}.",
            needs_regen=False,
            changed_fields={"macro_overrides": {"date": str(target_date), "from": old, "to": state.macro_overrides}},
        )

    # ── add_cardio_session / add_zone2_session ──────────────────────
    if action_type in ("add_cardio_session", "add_zone2_session"):
        if not any(k in action for k in ("minutes", "style", "count", "value", "days_per_week")):
            return _descriptive_ack(
                db, user_id, action_type, action, rec_key,
                "Cardio recommendation noted for the next plan review.",
            )
        prefs = _preferences(db, user_id)
        if not prefs:
            return ApplyResult(applied=False, summary="No preferences row", needs_regen=False, changed_fields={}, error="no_prefs")
        old = prefs.days_per_week
        if old >= 7:
            _record_memory(db, user_id, "recommendation_acked",
                "User accepted more cardio, but days/week is already at 7",
                {"action": action, "rec_key": rec_key})
            db.commit()
            return ApplyResult(
                applied=True,
                summary="Cardio preference noted. You're already at 7 days/week, so the plan won't add another day.",
                needs_regen=False,
                changed_fields={},
                descriptive_only=True,
            )
        target = min(7, old + 1)
        prefs.days_per_week = target
        prefs.updated_at = datetime.now(timezone.utc)
        db.add(prefs)
        style = str(action.get("style") or "zone2")
        _record_memory(db, user_id, "ai_apply",
            f"Added one weekly training day for {style} cardio",
            {"action": action, "from": old, "to": target})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"Added one weekly training day for {style} cardio. New weeks will use {target} days/week.",
            needs_regen=True,
            changed_fields={"days_per_week": {"from": old, "to": target}, "cardio_style": style},
            undo_action={"type": "change_days_per_week", "value": old},
        )

    # ── travel_mode / pause_week ────────────────────────────────────
    if action_type in ("travel_mode", "pause_week"):
        today = date.today()
        start = max(_parse_date(action.get("start_date"), today), today)
        if action.get("end_date"):
            end = _parse_date(action.get("end_date"), start)
            duration_days = max(1, min(14, (end - start).days + 1))
        else:
            duration_days = int(action.get("days") or action.get("duration_days") or 7)
            duration_days = max(1, min(14, duration_days))
        label = "travel" if action_type == "travel_mode" else "pause"
        dates: list[str] = []
        old_values: dict[str, Any] = {}
        for offset in range(duration_days):
            target_date = start + timedelta(days=offset)
            state = _day_state(db, user_id, target_date)
            old_values[str(target_date)] = state.skipped_focus
            state.skipped_focus = label
            state.updated_at = datetime.now(timezone.utc)
            db.add(state)
            dates.append(str(target_date))
        _record_memory(db, user_id, "ai_apply",
            f"{label.title()} mode applied for {duration_days} day(s)",
            {"action": action, "dates": dates, "previous": old_values})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=f"{label.title()} mode applied for {duration_days} day{'' if duration_days == 1 else 's'}. Your week stays fixed; those days are marked skipped.",
            needs_regen=False,
            changed_fields={"paused_dates": dates, "skipped_focus": label},
            undo_action={"type": "clear_day_state_focuses", "dates": dates},
        )

    # ── noop ─────────────────────────────────────────────────────────
    if action_type == "noop":
        return ApplyResult(applied=True, summary="Acknowledged.", needs_regen=False, changed_fields={})

    # ── Descriptive-only actions ────────────────────────────────────
    # These don't have a direct user-facing settings analogue — the
    # planner factors them in implicitly on next regen via the
    # existing volume / focus rotation logic. We log them so the
    # coach AI can reference them and the user gets a confirmation.
    descriptive = {
        "reduce_cardio", "raise_protein_target",
        "raise_fiber_target", "rebalance_week", "strength_preservation",
        "swap_to_recovery_or_reduce",
        # Nutrition review advisory actions - no persistent state yet.
        "increase_meal_logging", "adjust_meal_timing",
        "improve_protein_consistency", "adjust_protein_target",
    }
    if action_type in descriptive:
        summary = _descriptive_summary(action_type, action)
        _record_memory(db, user_id, "recommendation_acked",
            _accepted_memory_summary(action_type, action, summary),
            {"action": action, "rec_key": rec_key})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=summary,
            needs_regen=False,
            changed_fields={},
            descriptive_only=True,
        )

    # Unknown — record but don't fail.
    _record_memory(db, user_id, "recommendation_unknown",
        f"Unknown action type: {action_type}",
        {"action": action})
    db.commit()
    return ApplyResult(
        applied=False,
        summary="Recorded — this action type isn't auto-applyable yet.",
        needs_regen=False,
        changed_fields={},
        descriptive_only=True,
        error="unknown_action_type",
    )
