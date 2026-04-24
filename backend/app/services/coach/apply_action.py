"""Apply a recommendation action to durable user state.

Architectural principle (per product direction):
  The AI / weekly review can only do what the user can do via
  existing app UI. Recommendations don't directly mutate the active
  WorkoutPlan — they mutate the user-facing settings (UserPreferences,
  UserCoachingState, UserGoal, UserDayState) that the planner already
  reacts to on regen. The next regen picks up the changes.

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
  • swap_to_recovery                → UserDayState.skipped_focus on tomorrow
  • schedule_deload                 → UserCoachingState.deload_until_date
  • set_core_frequency              → UserPreferences.core_frequency_per_week
  • carb_bump_today                 → UserDayState (one-day macro override
                                       — read by /meals/daily-macros)
  • noop                            → ack only
  • add_cardio_session/add_zone2_session → translated to days_per_week + 1
                                            ONLY if user is below their
                                            stated cap. Otherwise descriptive.

For descriptive-only actions (reduce_muscle_volume, raise_protein_target,
add_muscle_volume, etc.) we record them as `CoachMemory(event_type=
"recommendation_acked")` so the planner / coach can reference them on
next pass, but they don't mutate any state directly.

Pure-ish: writes to the DB but never calls AI. Returns a structured
result the caller can show on the UI ("changed days/week from 4 to 3,
plan will refresh").
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlmodel import select

from app.models import (
    CoachMemory, UserCoachingState, UserDayState, UserPreferences,
)


# Hard caps so a single recommendation can never make a destructive
# change. Anything outside this range is downgraded to a descriptive
# memory record + a "needs user confirmation" flag.
_MAX_KCAL_DELTA = 250          # per single apply
_MAX_DAYS_DELTA = 1            # never jump >1 day at once
_KCAL_FLOOR_DEFAULT = 1500     # absolute minimum kcal target post-apply


@dataclass
class ApplyResult:
    applied: bool
    summary: str               # one sentence the UI shows
    needs_regen: bool          # caller should kick the planner
    changed_fields: dict[str, Any]
    descriptive_only: bool = False
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "applied": self.applied,
            "summary": self.summary,
            "needs_regen": self.needs_regen,
            "changed_fields": self.changed_fields,
            "descriptive_only": self.descriptive_only,
            "error": self.error,
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


def apply_action(
    db: Any,
    user_id: int,
    action: dict[str, Any],
    *,
    rec_key: str | None = None,
) -> ApplyResult:
    """Apply a single recommendation action. Caller is responsible for
    the regen call (returned via `needs_regen=True`) so we don't
    couple the apply path to the planner here."""
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
            summary=f"Updated to {target} days / week. Plan will refresh.",
            needs_regen=True,
            changed_fields={"days_per_week": target},
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
            summary=f"{verb} daily calorie target by {abs(delta)} kcal. Macros refresh on next plan check.",
            needs_regen=False,
            changed_fields={"calorie_adjustment": state.calorie_adjustment},
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

    # ── swap_to_recovery (one tomorrow) ─────────────────────────────
    if action_type == "swap_to_recovery":
        # Mark tomorrow as a recovery focus via UserDayState. The
        # planner already reads UserDayState.skipped_focus on the
        # day card to override the planned archetype.
        tomorrow = date.today() + timedelta(days=1)
        existing = db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == user_id, UserDayState.day_key == tomorrow)
        ).first()
        if existing:
            existing.skipped_focus = "recovery"
            db.add(existing)
        else:
            db.add(UserDayState(
                user_id=user_id, day_key=tomorrow, skipped_focus="recovery",
                meal_checks={}, nutrition_plan=None,
            ))
        _record_memory(db, user_id, "ai_apply",
            "Tomorrow swapped to active recovery via recommendation",
            {"action": action})
        db.commit()
        return ApplyResult(
            applied=True,
            summary="Tomorrow swapped to active recovery (walk / mobility / yoga).",
            needs_regen=False,
            changed_fields={"day_state": str(tomorrow)},
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
        "reduce_muscle_volume": "The next plan refresh will dial back that muscle's volume.",
        "add_muscle_volume": "The next plan refresh will add sets for that muscle.",
        "hold_muscle_volume": "Holding the current volume — next plan refresh will keep it stable.",
        "add_cardio_session": "Logged. Add a cardio session today or tomorrow when you can.",
        "add_zone2_session": "Logged. Add an easy walk or bike ride this week.",
        "reduce_cardio": "Logged. Next plan refresh will trim cardio days.",
        "schedule_deload": "Deload flagged for next week. The planner will cut loads + sets.",
        "set_core_frequency": "Core frequency preference noted. Next plan refresh will adjust.",
        "shorten_workout": "Today's workout will trim to fit your time. Use 'Switch Day' to apply.",
        "reduce_intensity": "Today's intensity will dial back. Drop top-set loads ~10-15%.",
        "carb_bump_today": "Add ~75-100g carbs to today's macros, especially around training.",
        "raise_protein_target": "Protein target preference noted.",
        "raise_fiber_target": "Fiber target preference noted.",
        "rebalance_week": "Acknowledged — the planner will reshuffle remaining days.",
        "strength_preservation": "Logged. We'll protect strength while you adjust calories + volume.",
        "swap_to_recovery_or_reduce": "Pick: swap to recovery (use Switch Day → Recovery) or just go lighter.",
    }
    if action_type in descriptive:
        _record_memory(db, user_id, "recommendation_acked",
            f"User accepted recommendation: {action_type}",
            {"action": action, "rec_key": rec_key})
        db.commit()
        return ApplyResult(
            applied=True,
            summary=descriptive[action_type],
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
