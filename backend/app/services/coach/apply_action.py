"""Apply a recommendation action to durable user state.

Architectural rule (per product direction):
  AI / weekly review can only do what the user can do via existing app
  UI. Recommendations don't directly mutate the active WorkoutPlan —
  they mutate user-facing settings the planner re-reads on every regen:

    1. UserPreferences        — days_per_week
    2. UserCoachingState      — calorie_adjustment
    3. UserDayState           — skipped_focus (per-day overrides)
    4. UserCoachingOverlay    — per-muscle volume bias, cardio targets,
                                core frequency, intensity bias, deload
                                window, nutrition deltas (NEW)

  The next regen picks up the changes. NO recommendation should ever
  reach `Apply` unless it maps to one of these four surfaces.

The split:
  • `services/coach/overlay.py::apply_overlay_action` handles every
    overlay-targeted action and returns a structured result.
  • This module handles the original four (days_per_week, calories,
    swap_to_recovery, hold/noop) and dispatches everything else to
    the overlay service.
  • If neither matches, the request is rejected (no silent
    "Acknowledged" fallback). Recommendations producing no real
    state change must omit the `action` field entirely so the UI
    renders them as advice without an Apply button.

Pure-ish: writes to the DB but never calls AI. Returns a structured
result the caller shows on the UI ("changed days/week from 4 to 3,
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
from app.services.coach.overlay import apply_overlay_action


# Hard caps so a single recommendation can never make a destructive
# change. Anything outside this range is downgraded to a descriptive
# memory record + a "needs user confirmation" flag.
_MAX_KCAL_DELTA = 250          # per single apply
_MAX_DAYS_DELTA = 1            # never jump >1 day at once


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
            summary=f"Applied: training days changed from {old} to {target} per week. Plan refreshes on next open.",
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
        verb = "raised" if delta > 0 else "lowered"
        return ApplyResult(
            applied=True,
            summary=f"Applied: daily calorie target {verb} by {abs(delta)} kcal (total adjustment now {state.calorie_adjustment:+d}).",
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
            summary="Applied: holding calories at the current target until recovery signals improve.",
            needs_regen=False,
            changed_fields={"calorie_adjustment_hold": True},
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
            summary=f"Applied: tomorrow ({tomorrow.isoformat()}) swapped to active recovery.",
            needs_regen=False,
            changed_fields={"day_state": str(tomorrow)},
        )

    # ── noop ─────────────────────────────────────────────────────────
    if action_type == "noop":
        return ApplyResult(applied=True, summary="Acknowledged.", needs_regen=False, changed_fields={})

    # ── Overlay-targeted actions ─────────────────────────────────────
    # Everything else routes through the coaching overlay. If the
    # overlay service handles this action_type it returns an
    # OverlayApplyResult; we adapt to ApplyResult and return.
    overlay_result = apply_overlay_action(
        db, user_id, action_type,
        action,                       # full action dict carries muscle / minutes / etc.
        rec_key=rec_key,
    )
    if overlay_result is not None:
        return ApplyResult(
            applied=overlay_result.applied,
            summary=overlay_result.summary,
            needs_regen=overlay_result.needs_regen,
            changed_fields=overlay_result.changed_fields,
            error=overlay_result.error,
        )

    # ── Unknown action ──────────────────────────────────────────────
    # No silent "Acknowledged" — the rule is that anything reaching
    # apply_action MUST mutate state. If we hit this branch, plan_review
    # / quick_intents emitted an action.type that no apply path knows.
    # Reject explicitly so we catch the gap in QA instead of silently
    # logging a placebo CoachMemory.
    _record_memory(db, user_id, "recommendation_unknown",
        f"Unknown action type: {action_type}",
        {"action": action, "rec_key": rec_key})
    db.commit()
    return ApplyResult(
        applied=False,
        summary=f"That recommendation can't be auto-applied (action '{action_type}' is unknown). Adjust it manually in Settings.",
        needs_regen=False,
        changed_fields={},
        descriptive_only=True,
        error="unknown_action_type",
    )
