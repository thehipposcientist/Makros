"""UserCoachingOverlay — durable per-user planner/nutrition biases the
weekly coach mutates so accepted recommendations actually change the
next plan.

Design contract (per the architectural rule "AI can only do what the
user can do"):

  1. Every applyable recommendation maps to one bounded write here OR to
     UserPreferences / UserCoachingState / UserDayState. Nothing else
     gets an Apply button.
  2. Every write is clamped (volume biases [0.7, 1.3], cardio targets
     [0, 360], etc.) so a single accept can never blow up the plan.
  3. Every write extends `expires_at` 4 weeks forward. On every plan
     regen we run `decay_if_expired` which steps every field one tick
     toward neutral if `expires_at` has passed — so overlays don't
     accumulate forever for a user who taps Apply once and never logs
     a follow-up signal.
  4. Every write also records a `CoachMemory(event_type="ai_apply")`
     row capturing the previous + new value so an "undo last rec" UI
     is one query later, and the trainer chat can reference the
     history.

Pure function-style: writes to the DB but never calls AI. All callers
(routers/coach.py, plan_review_v2 acceptance, quick_intents apply,
check-in coach apply) route through `apply_overlay_action`.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlmodel import select

from app.models import CoachMemory, UserCoachingOverlay


# ── Bounds ──────────────────────────────────────────────────────────────
# These are the hard caps for the entire overlay layer. A single apply
# can never push past them. Keep tight — wider ranges come from durable
# user-profile changes (UserPreferences.days_per_week, etc.), not the
# overlay.

VOLUME_BIAS_MIN = 0.7
VOLUME_BIAS_MAX = 1.3
VOLUME_BIAS_STEP = 0.1               # per single rec accept
VOLUME_BIAS_NEUTRAL = 1.0

CARDIO_MIN_MINUTES = 0
CARDIO_MAX_MINUTES = 360             # 6 hours/wk hard ceiling
CARDIO_STEP_MINUTES = 30
ZONE2_STEP_MINUTES = 45              # zone 2 sessions are typically longer

CORE_MIN_SESSIONS = 0
CORE_MAX_SESSIONS = 5

PROTEIN_DELTA_MIN_G = -30
PROTEIN_DELTA_MAX_G = 60             # asymmetric — easier to add than cut
PROTEIN_STEP_G = 10

FIBER_DELTA_MIN_G = -10
FIBER_DELTA_MAX_G = 25
FIBER_STEP_G = 5

DELOAD_DEFAULT_DAYS = 7
OVERLAY_TTL_WEEKS = 4

VALID_INTENSITY_BIASES = {"strength", "hypertrophy", "endurance", "balanced"}


# ── Result shape (matches apply_action.ApplyResult) ─────────────────────

@dataclass
class OverlayApplyResult:
    applied: bool
    summary: str                      # one sentence the UI shows
    needs_regen: bool                 # caller should kick the planner
    changed_fields: dict[str, Any]
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "applied": self.applied,
            "summary": self.summary,
            "needs_regen": self.needs_regen,
            "changed_fields": self.changed_fields,
            "error": self.error,
        }


# ── Helpers ─────────────────────────────────────────────────────────────

def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _record_memory(db: Any, user_id: int, summary: str, details: dict) -> None:
    db.add(CoachMemory(
        user_id=user_id,
        event_type="ai_apply",
        summary=summary,
        details=details,
    ))


def _now_naive_utc() -> datetime:
    """Return the current UTC time as a tz-NAIVE datetime so it matches
    what Postgres returns from TIMESTAMPTZ columns through SQLAlchemy
    (which strips tz info on read by default). Fixes the TypeError
    you'd otherwise get when comparing `overlay.expires_at` (naive)
    with `datetime.now(timezone.utc)` (aware)."""
    return datetime.utcnow()


def _as_naive(dt: datetime | None) -> datetime | None:
    """Normalize a possibly-aware datetime to naive UTC for comparison
    with values read from the DB."""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _bump_expiry(overlay: UserCoachingOverlay) -> None:
    now = _now_naive_utc()
    overlay.last_refreshed_at = now
    overlay.expires_at = now + timedelta(weeks=OVERLAY_TTL_WEEKS)
    overlay.updated_at = now


def _normalize_muscle(muscle: str | None) -> str | None:
    if not muscle:
        return None
    return str(muscle).strip().lower().replace(" ", "_") or None


def snapshot_for_planner(db: Any, user_id: int, *, run_decay: bool = True) -> dict:
    """Return a frozen-ish snapshot of this user's overlay shaped for
    `PlannerInputs.coaching_overlay`. Routers call this when building
    planner inputs.

    `run_decay=True` (default) sweeps the decay step before snapshotting
    so accepted recs that have aged past their TTL have their effect
    halved automatically — keeps the planner honest without requiring a
    background job.

    Snapshot keys (all optional):
      • muscle_volume_bias: dict[str, float]
      • cardio_minutes_target: int | None
      • zone2_minutes_target: int | None
      • core_sessions_target: int | None
      • intensity_bias: str | None
      • deload_active: bool          (derived: today() <= deload_until_date)
      • nutrition_adjustments: dict[str, int]
    """
    overlay = get_or_create_overlay(db, user_id)
    if run_decay:
        if decay_if_expired(db, overlay):
            db.commit()
    today = date.today()
    return {
        "muscle_volume_bias": dict(overlay.muscle_volume_bias or {}),
        "cardio_minutes_target": overlay.cardio_minutes_target,
        "zone2_minutes_target": overlay.zone2_minutes_target,
        "core_sessions_target": overlay.core_sessions_target,
        "intensity_bias": overlay.intensity_bias,
        "deload_active": bool(overlay.deload_until_date and overlay.deload_until_date >= today),
        "deload_until_date": overlay.deload_until_date.isoformat() if overlay.deload_until_date else None,
        "nutrition_adjustments": dict(overlay.nutrition_adjustments or {}),
    }


def get_or_create_overlay(db: Any, user_id: int) -> UserCoachingOverlay:
    """Fetch this user's overlay row, creating a neutral one if missing.
    Caller is responsible for the commit when mutations follow."""
    overlay = db.exec(
        select(UserCoachingOverlay).where(UserCoachingOverlay.user_id == user_id)
    ).first()
    if overlay:
        return overlay
    now = _now_naive_utc()
    overlay = UserCoachingOverlay(
        user_id=user_id,
        muscle_volume_bias={},
        nutrition_adjustments={},
        last_refreshed_at=now,
        expires_at=now + timedelta(weeks=OVERLAY_TTL_WEEKS),
        updated_at=now,
    )
    db.add(overlay)
    db.flush()
    return overlay


def decay_if_expired(db: Any, overlay: UserCoachingOverlay) -> bool:
    """If `expires_at` has passed, step every field one tick toward
    neutral. Returns True when anything changed (caller may want to
    commit). Idempotent: calling repeatedly without further accepts
    keeps decaying until everything is neutral, then becomes a no-op.

    The decay window resets on the next apply — so an active user who
    keeps accepting recs never sees their overlay decay. A user who
    accepts once and goes silent has the bias fully neutralized over
    ~6 weeks of weekly regens.
    """
    now = _now_naive_utc()
    expires = _as_naive(overlay.expires_at)
    if expires and expires > now:
        return False

    changed = False

    # Volume biases — step toward 1.0 by VOLUME_BIAS_STEP / 2.
    if overlay.muscle_volume_bias:
        new_bias: dict[str, float] = {}
        for muscle, val in overlay.muscle_volume_bias.items():
            try:
                v = float(val)
            except (TypeError, ValueError):
                continue
            if v > VOLUME_BIAS_NEUTRAL:
                v = max(VOLUME_BIAS_NEUTRAL, v - VOLUME_BIAS_STEP / 2)
            elif v < VOLUME_BIAS_NEUTRAL:
                v = min(VOLUME_BIAS_NEUTRAL, v + VOLUME_BIAS_STEP / 2)
            # Drop entries that fully decayed back to neutral so the
            # JSON stays clean.
            if abs(v - VOLUME_BIAS_NEUTRAL) > 0.01:
                new_bias[muscle] = round(v, 2)
            changed = changed or new_bias.get(muscle) != val
        overlay.muscle_volume_bias = new_bias

    # Cardio targets — step down toward None / 0 by half a step.
    if overlay.cardio_minutes_target is not None:
        new_val = max(0, overlay.cardio_minutes_target - CARDIO_STEP_MINUTES // 2)
        if new_val == 0:
            overlay.cardio_minutes_target = None
        else:
            overlay.cardio_minutes_target = new_val
        changed = True
    if overlay.zone2_minutes_target is not None:
        new_val = max(0, overlay.zone2_minutes_target - ZONE2_STEP_MINUTES // 2)
        if new_val == 0:
            overlay.zone2_minutes_target = None
        else:
            overlay.zone2_minutes_target = new_val
        changed = True

    # Nutrition deltas — half-step toward zero.
    if overlay.nutrition_adjustments:
        new_nut: dict[str, int] = {}
        for k, v in overlay.nutrition_adjustments.items():
            try:
                iv = int(v)
            except (TypeError, ValueError):
                continue
            step = max(1, abs(iv) // 2)
            if iv > 0:
                iv = max(0, iv - step)
            elif iv < 0:
                iv = min(0, iv + step)
            if iv != 0:
                new_nut[k] = iv
            changed = True
        overlay.nutrition_adjustments = new_nut

    # Intensity bias auto-clears.
    if overlay.intensity_bias is not None:
        overlay.intensity_bias = None
        changed = True

    # Deload date — only clears once it's already in the past.
    if overlay.deload_until_date is not None and overlay.deload_until_date < date.today():
        overlay.deload_until_date = None
        changed = True

    if changed:
        # Push expiry out one more cycle so we don't decay again next
        # regen — gives the user a chance to either keep things neutral
        # or accept a fresh rec.
        now = _now_naive_utc()
        overlay.last_refreshed_at = now
        overlay.expires_at = now + timedelta(weeks=OVERLAY_TTL_WEEKS)
        overlay.updated_at = now
        db.add(overlay)

    return changed


# ── apply_overlay_action ───────────────────────────────────────────────
#
# Single entry point. Returns OverlayApplyResult OR None when the action
# isn't an overlay-targeted action (caller should fall through to the
# legacy apply_action path for raise_calories / change_days_per_week /
# swap_to_recovery, which still target their own tables).

def apply_overlay_action(
    db: Any,
    user_id: int,
    action_type: str,
    payload: dict[str, Any],
    *,
    rec_key: str | None = None,
) -> OverlayApplyResult | None:
    overlay = get_or_create_overlay(db, user_id)

    # ── Cardio ──────────────────────────────────────────────────────
    if action_type == "add_cardio_session":
        old = overlay.cardio_minutes_target or 0
        bump = int(payload.get("minutes") or CARDIO_STEP_MINUTES)
        new = int(_clamp(old + bump, CARDIO_MIN_MINUTES, CARDIO_MAX_MINUTES))
        if new == old:
            return OverlayApplyResult(
                applied=True,
                summary=f"Already at the cardio ceiling ({CARDIO_MAX_MINUTES} min/wk). Nothing to add.",
                needs_regen=False,
                changed_fields={},
            )
        overlay.cardio_minutes_target = new
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Cardio target {old} → {new} min/wk via {rec_key or 'rec'}",
            {"action": action_type, "from": old, "to": new, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: weekly cardio target raised from {old} to {new} minutes.",
            needs_regen=True,
            changed_fields={"cardio_minutes_target": new},
        )

    if action_type == "add_zone2_session":
        old_z2 = overlay.zone2_minutes_target or 0
        old_total = overlay.cardio_minutes_target or 0
        bump = int(payload.get("minutes") or ZONE2_STEP_MINUTES)
        new_z2 = int(_clamp(old_z2 + bump, CARDIO_MIN_MINUTES, CARDIO_MAX_MINUTES))
        # Zone 2 is a SUBSET of total cardio — also lift total to at
        # least the zone 2 amount so the planner has room to schedule
        # it without conflicting with intervals.
        new_total = max(old_total, new_z2)
        new_total = int(_clamp(new_total, CARDIO_MIN_MINUTES, CARDIO_MAX_MINUTES))
        if new_z2 == old_z2 and new_total == old_total:
            return OverlayApplyResult(
                applied=True,
                summary="Already at the zone 2 ceiling. Nothing to add.",
                needs_regen=False,
                changed_fields={},
            )
        overlay.zone2_minutes_target = new_z2
        overlay.cardio_minutes_target = new_total
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Zone 2 target {old_z2} → {new_z2} min/wk (total {old_total} → {new_total})",
            {"action": action_type, "from_z2": old_z2, "to_z2": new_z2,
             "from_total": old_total, "to_total": new_total, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: zone 2 target raised to {new_z2} minutes (weekly cardio {new_total} min).",
            needs_regen=True,
            changed_fields={
                "zone2_minutes_target": new_z2,
                "cardio_minutes_target": new_total,
            },
        )

    if action_type == "reduce_cardio":
        old = overlay.cardio_minutes_target
        if old is None or old <= 0:
            return OverlayApplyResult(
                applied=True,
                summary="No cardio override to trim — already on the deterministic baseline.",
                needs_regen=False,
                changed_fields={},
            )
        bump = int(payload.get("minutes") or CARDIO_STEP_MINUTES)
        new = int(_clamp(old - bump, CARDIO_MIN_MINUTES, CARDIO_MAX_MINUTES))
        overlay.cardio_minutes_target = new if new > 0 else None
        # If we're below the zone 2 floor now, trim zone 2 too.
        if overlay.zone2_minutes_target is not None and overlay.zone2_minutes_target > new:
            overlay.zone2_minutes_target = new if new > 0 else None
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Cardio target {old} → {new} min/wk (reduced)",
            {"action": action_type, "from": old, "to": new, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: weekly cardio target trimmed from {old} to {new} minutes.",
            needs_regen=True,
            changed_fields={"cardio_minutes_target": new},
        )

    # ── Muscle volume ───────────────────────────────────────────────
    if action_type in ("add_muscle_volume", "reduce_muscle_volume", "hold_muscle_volume"):
        muscle = _normalize_muscle(payload.get("muscle"))
        if not muscle:
            return OverlayApplyResult(
                applied=False, summary="No muscle specified.", needs_regen=False,
                changed_fields={}, error="missing_muscle")
        bias_map = dict(overlay.muscle_volume_bias or {})
        old = float(bias_map.get(muscle, VOLUME_BIAS_NEUTRAL))
        if action_type == "add_muscle_volume":
            new = round(_clamp(old + VOLUME_BIAS_STEP, VOLUME_BIAS_MIN, VOLUME_BIAS_MAX), 2)
        elif action_type == "reduce_muscle_volume":
            new = round(_clamp(old - VOLUME_BIAS_STEP, VOLUME_BIAS_MIN, VOLUME_BIAS_MAX), 2)
        else:  # hold_muscle_volume → snap to neutral so spike clears
            new = VOLUME_BIAS_NEUTRAL
        if abs(new - old) < 0.01:
            return OverlayApplyResult(
                applied=True,
                summary=f"{muscle.capitalize()} volume bias already at the cap ({old}). Nothing to change.",
                needs_regen=False,
                changed_fields={},
            )
        # Drop neutral entries so the JSON stays clean.
        if abs(new - VOLUME_BIAS_NEUTRAL) < 0.01:
            bias_map.pop(muscle, None)
        else:
            bias_map[muscle] = new
        overlay.muscle_volume_bias = bias_map
        _bump_expiry(overlay)
        db.add(overlay)
        delta_pct = round((new - VOLUME_BIAS_NEUTRAL) * 100)
        verb = {"add_muscle_volume": "raised", "reduce_muscle_volume": "lowered", "hold_muscle_volume": "reset"}[action_type]
        _record_memory(db, user_id,
            f"{muscle} volume bias {old} → {new} ({verb})",
            {"action": action_type, "muscle": muscle, "from": old, "to": new, "rec_key": rec_key})
        db.commit()
        if action_type == "hold_muscle_volume":
            summary = f"Applied: {muscle} volume reset to neutral. Next plan stops trending up."
        else:
            sign = "+" if delta_pct >= 0 else ""
            summary = f"Applied: {muscle} volume bias {sign}{delta_pct}%. Next plan adjusts {muscle} sets accordingly."
        return OverlayApplyResult(
            applied=True,
            summary=summary,
            needs_regen=True,
            changed_fields={"muscle_volume_bias": bias_map},
        )

    # ── Core ────────────────────────────────────────────────────────
    if action_type == "set_core_frequency":
        target = payload.get("sessions_per_week")
        if target is None:
            target = payload.get("value")
        try:
            target = int(target)
        except (TypeError, ValueError):
            return OverlayApplyResult(
                applied=False, summary="No core frequency provided.", needs_regen=False,
                changed_fields={}, error="missing_value")
        target = int(_clamp(target, CORE_MIN_SESSIONS, CORE_MAX_SESSIONS))
        old = overlay.core_sessions_target
        if old == target:
            return OverlayApplyResult(
                applied=True,
                summary=f"Core target already at {target}/wk. Nothing to change.",
                needs_regen=False,
                changed_fields={},
            )
        overlay.core_sessions_target = target
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Core frequency {old} → {target} sessions/wk",
            {"action": action_type, "from": old, "to": target, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: core frequency set to {target} session{'s' if target != 1 else ''}/week.",
            needs_regen=True,
            changed_fields={"core_sessions_target": target},
        )

    # ── Intensity bias ──────────────────────────────────────────────
    if action_type in ("strength_preservation", "hypertrophy_focus", "endurance_focus", "balanced_focus"):
        bias_map = {
            "strength_preservation": "strength",
            "hypertrophy_focus": "hypertrophy",
            "endurance_focus": "endurance",
            "balanced_focus": "balanced",
        }
        new = bias_map[action_type]
        old = overlay.intensity_bias
        if old == new:
            return OverlayApplyResult(
                applied=True,
                summary=f"Intensity bias already on '{new}'.",
                needs_regen=False,
                changed_fields={},
            )
        overlay.intensity_bias = new
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Intensity bias {old} → {new}",
            {"action": action_type, "from": old, "to": new, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: training emphasis set to {new}. Next plan picks {new}-leaning archetype variants.",
            needs_regen=True,
            changed_fields={"intensity_bias": new},
        )

    # ── Deload ──────────────────────────────────────────────────────
    if action_type == "schedule_deload":
        days = int(payload.get("days") or DELOAD_DEFAULT_DAYS)
        days = max(3, min(14, days))
        target = date.today() + timedelta(days=days)
        old = overlay.deload_until_date
        overlay.deload_until_date = target
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Deload window {old} → {target} ({days} days)",
            {"action": action_type, "from": str(old) if old else None,
             "to": str(target), "days": days, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: deload through {target.isoformat()}. Loads + sets cut, no failure work.",
            needs_regen=True,
            changed_fields={"deload_until_date": target.isoformat()},
        )

    # ── Nutrition deltas ────────────────────────────────────────────
    if action_type == "raise_protein_target":
        adj = dict(overlay.nutrition_adjustments or {})
        old = int(adj.get("protein_delta_g") or 0)
        bump = int(payload.get("grams") or PROTEIN_STEP_G)
        new = int(_clamp(old + bump, PROTEIN_DELTA_MIN_G, PROTEIN_DELTA_MAX_G))
        if new == old:
            return OverlayApplyResult(
                applied=True,
                summary=f"Protein delta already at the cap (+{old}g). Nothing to add.",
                needs_regen=False,
                changed_fields={},
            )
        adj["protein_delta_g"] = new
        overlay.nutrition_adjustments = adj
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Protein delta {old:+d} → {new:+d} g/day",
            {"action": action_type, "from": old, "to": new, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: protein target raised by {bump}g/day (total override {new:+d}g).",
            needs_regen=False,  # macros refresh on next /meals/score
            changed_fields={"nutrition_adjustments": adj},
        )

    if action_type == "raise_fiber_target":
        adj = dict(overlay.nutrition_adjustments or {})
        old = int(adj.get("fiber_delta_g") or 0)
        bump = int(payload.get("grams") or FIBER_STEP_G)
        new = int(_clamp(old + bump, FIBER_DELTA_MIN_G, FIBER_DELTA_MAX_G))
        if new == old:
            return OverlayApplyResult(
                applied=True,
                summary=f"Fiber delta already at the cap (+{old}g). Nothing to add.",
                needs_regen=False,
                changed_fields={},
            )
        adj["fiber_delta_g"] = new
        overlay.nutrition_adjustments = adj
        _bump_expiry(overlay)
        db.add(overlay)
        _record_memory(db, user_id,
            f"Fiber delta {old:+d} → {new:+d} g/day",
            {"action": action_type, "from": old, "to": new, "rec_key": rec_key})
        db.commit()
        return OverlayApplyResult(
            applied=True,
            summary=f"Applied: fiber target raised by {bump}g/day (total override {new:+d}g).",
            needs_regen=False,
            changed_fields={"nutrition_adjustments": adj},
        )

    # Not an overlay-targeted action — caller (apply_action.apply_action)
    # falls through to UserPreferences / UserCoachingState / UserDayState
    # writes for raise_calories / change_days_per_week / swap_to_recovery.
    return None
