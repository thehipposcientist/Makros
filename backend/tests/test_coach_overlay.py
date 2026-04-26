"""Unit tests for `services.coach.overlay`.

Covers every action the overlay service handles, plus the decay sweep
and snapshot shape. The contract tested:

  • Every clamping bound holds even when called at the edge.
  • Repeat applies accumulate correctly until the cap is reached.
  • Reset/hold operations clean stale entries out of the JSON map.
  • Unknown action types return None (caller falls through to legacy
    apply_action paths — they don't accidentally swallow misroutes).
  • Decay-on-expiry steps every field one tick toward neutral and
    extends the TTL so we don't double-decay next regen.
  • snapshot_for_planner shape matches what PlannerInputs reads.

In-memory SQLite fixture mirrors test_apply_action.py — no Postgres
needed for a unit test pass.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        UserCoachingOverlay,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _setup():
    """Engine + session + a fresh User row. No overlay yet — tests
    exercise both the create path and existing-row paths."""
    from sqlmodel import Session
    from app.models import User
    engine = _make_mem_engine()
    s = Session(engine)
    u = User(email="overlay@example.com", username="overlay", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    return engine, s, u


def _overlay(s, uid):
    from app.models import UserCoachingOverlay
    from sqlmodel import select
    return s.exec(
        select(UserCoachingOverlay).where(UserCoachingOverlay.user_id == uid)
    ).first()


# ── get_or_create_overlay ───────────────────────────────────────────

def test_get_or_create_overlay_creates_new_row_with_defaults():
    print("\n[test] get_or_create_overlay: fresh user gets neutral overlay")
    from app.services.coach.overlay import get_or_create_overlay
    _, s, u = _setup()
    ov = get_or_create_overlay(s, u.id)
    s.commit()
    assert ov.user_id == u.id
    assert ov.muscle_volume_bias == {}
    assert ov.cardio_minutes_target is None
    assert ov.zone2_minutes_target is None
    assert ov.core_sessions_target is None
    assert ov.intensity_bias is None
    assert ov.deload_until_date is None
    assert ov.nutrition_adjustments == {}
    assert ov.expires_at is not None
    _ok("defaults set, expires_at populated")


def test_get_or_create_overlay_idempotent():
    """Calling twice returns the same row, doesn't duplicate."""
    print("\n[test] get_or_create_overlay: idempotent — single row per user")
    from app.services.coach.overlay import get_or_create_overlay
    from app.models import UserCoachingOverlay
    from sqlmodel import select
    _, s, u = _setup()
    ov1 = get_or_create_overlay(s, u.id); s.commit()
    ov2 = get_or_create_overlay(s, u.id); s.commit()
    assert ov1.id == ov2.id
    rows = s.exec(select(UserCoachingOverlay).where(UserCoachingOverlay.user_id == u.id)).all()
    assert len(rows) == 1


# ── Cardio actions ────────────────────────────────────────────────

def test_add_cardio_session_first_apply_sets_30():
    print("\n[test] add_cardio_session: first apply sets target to 30 min")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    res = apply_overlay_action(s, u.id, "add_cardio_session", {})
    assert res is not None
    assert res.applied
    assert res.needs_regen
    assert _overlay(s, u.id).cardio_minutes_target == 30


def test_add_cardio_session_respects_payload_minutes():
    """When the rec carries explicit `minutes`, use that instead of
    the default 30 step."""
    print("\n[test] add_cardio_session: payload minutes=45 used over default 30")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    res = apply_overlay_action(s, u.id, "add_cardio_session", {"minutes": 45})
    assert res.applied
    assert _overlay(s, u.id).cardio_minutes_target == 45


def test_add_cardio_session_clamps_at_360():
    print("\n[test] add_cardio_session: clamps at 360 min/wk hard ceiling")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    for _ in range(20):
        apply_overlay_action(s, u.id, "add_cardio_session", {})
    assert _overlay(s, u.id).cardio_minutes_target == 360


def test_add_cardio_session_at_cap_returns_no_change():
    print("\n[test] add_cardio_session: at cap returns applied but no change")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_cardio_session", {"minutes": 360})
    res = apply_overlay_action(s, u.id, "add_cardio_session", {})
    assert res.applied
    assert not res.needs_regen
    assert "ceiling" in res.summary.lower() or "nothing" in res.summary.lower()


def test_add_zone2_session_lifts_total_cardio_to_match():
    """Zone 2 is a SUBSET of total cardio — adding zone 2 must also
    raise the total target so the planner has room to schedule it."""
    print("\n[test] add_zone2_session: cardio total floors at zone 2 amount")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_zone2_session", {})
    ov = _overlay(s, u.id)
    assert ov.zone2_minutes_target == 45
    assert ov.cardio_minutes_target == 45, \
        "cardio_minutes_target should be lifted to match the zone 2 floor"


def test_reduce_cardio_floors_zone2_too():
    """If we trim total cardio below the zone 2 target, zone 2 must
    drop too — can't have 60 min Z2 inside a 30 min cardio budget."""
    print("\n[test] reduce_cardio: trims zone2 when it exceeds the new total")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_cardio_session", {"minutes": 90})
    apply_overlay_action(s, u.id, "add_zone2_session", {"minutes": 90})
    apply_overlay_action(s, u.id, "reduce_cardio", {"minutes": 60})
    ov = _overlay(s, u.id)
    assert ov.cardio_minutes_target == 30
    assert ov.zone2_minutes_target == 30


def test_reduce_cardio_with_no_override_is_noop():
    """User on baseline (no cardio override) tapping reduce should not
    crash and should not set cardio to a negative number."""
    print("\n[test] reduce_cardio: no-op when no cardio override exists")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    res = apply_overlay_action(s, u.id, "reduce_cardio", {})
    assert res.applied
    assert not res.needs_regen
    assert _overlay(s, u.id).cardio_minutes_target is None


# ── Muscle volume bias ────────────────────────────────────────────

def test_add_muscle_volume_normalizes_muscle_name():
    """'Quads' / 'QUADS' / 'quads' / 'lower back ' all collapse to the
    same key so chains of recs don't fragment the bias map."""
    print("\n[test] add_muscle_volume: muscle name normalization")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "Quads"})
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "QUADS"})
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "lower back"})
    bias = _overlay(s, u.id).muscle_volume_bias
    assert "quads" in bias
    assert abs(bias["quads"] - 1.2) < 0.001, "two 'quads' applies should stack"
    assert "lower_back" in bias, "spaces normalized to underscores"


def test_reduce_muscle_volume_floor_check():
    print("\n[test] reduce_muscle_volume: chain floors at 0.7")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    for _ in range(10):
        apply_overlay_action(s, u.id, "reduce_muscle_volume", {"muscle": "chest"})
    bias = _overlay(s, u.id).muscle_volume_bias
    assert abs(bias["chest"] - 0.7) < 0.001


def test_hold_muscle_volume_drops_neutral_entries():
    """Bias = 1.0 means 'no override' — keep the JSON clean by removing
    those entries instead of letting them accumulate."""
    print("\n[test] hold_muscle_volume: removes muscle from bias map (clean JSON)")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "back"})
    apply_overlay_action(s, u.id, "hold_muscle_volume", {"muscle": "back"})
    bias = _overlay(s, u.id).muscle_volume_bias
    assert "back" not in bias, "neutral bias should be dropped from JSON"


def test_muscle_volume_at_cap_returns_no_change():
    print("\n[test] add_muscle_volume: at cap returns applied + no change")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    for _ in range(5):
        apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})
    res = apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})
    assert res.applied
    assert not res.needs_regen
    assert "cap" in res.summary.lower()


def test_muscle_volume_missing_payload_rejected():
    print("\n[test] add_muscle_volume: missing muscle field rejected")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    res = apply_overlay_action(s, u.id, "add_muscle_volume", {})
    assert not res.applied
    assert res.error == "missing_muscle"


# ── Core / intensity / deload ────────────────────────────────────

def test_set_core_frequency_value_alias():
    """Accept either `sessions_per_week` (canonical) OR `value`
    (legacy alias) so older clients still work."""
    print("\n[test] set_core_frequency: accepts both sessions_per_week and value")
    from app.services.coach.overlay import apply_overlay_action
    for key in ("sessions_per_week", "value"):
        _, s, u = _setup()
        res = apply_overlay_action(s, u.id, "set_core_frequency", {key: 3})
        assert res.applied
        assert _overlay(s, u.id).core_sessions_target == 3


def test_set_core_frequency_clamps_negative_and_huge():
    print("\n[test] set_core_frequency: clamps to [0, 5]")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "set_core_frequency", {"sessions_per_week": 99})
    assert _overlay(s, u.id).core_sessions_target == 5
    apply_overlay_action(s, u.id, "set_core_frequency", {"sessions_per_week": -3})
    assert _overlay(s, u.id).core_sessions_target == 0


def test_set_core_frequency_missing_value_rejected():
    print("\n[test] set_core_frequency: missing value rejected")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    res = apply_overlay_action(s, u.id, "set_core_frequency", {})
    assert not res.applied
    assert res.error == "missing_value"


def test_intensity_bias_actions_set_correct_value():
    print("\n[test] intensity bias actions: each maps to the right enum value")
    from app.services.coach.overlay import apply_overlay_action
    cases = (
        ("strength_preservation", "strength"),
        ("hypertrophy_focus", "hypertrophy"),
        ("endurance_focus", "endurance"),
        ("balanced_focus", "balanced"),
    )
    for action_type, expected in cases:
        _, s, u = _setup()
        res = apply_overlay_action(s, u.id, action_type, {})
        assert res.applied
        assert _overlay(s, u.id).intensity_bias == expected, \
            f"{action_type} should set intensity_bias={expected}"


def test_intensity_bias_already_set_returns_no_change():
    print("\n[test] strength_preservation: applying twice returns no_change")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "strength_preservation", {})
    res = apply_overlay_action(s, u.id, "strength_preservation", {})
    assert res.applied
    assert not res.needs_regen


def test_schedule_deload_clamps_days():
    """Deload window is hard-capped to [3, 14] days. Anything else is
    a typo we shouldn't honor."""
    print("\n[test] schedule_deload: clamps days to [3, 14]")
    from datetime import date
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "schedule_deload", {"days": 90})
    days_out = (_overlay(s, u.id).deload_until_date - date.today()).days
    assert days_out == 14
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "schedule_deload", {"days": 1})
    days_out = (_overlay(s, u.id).deload_until_date - date.today()).days
    assert days_out == 3


# ── Nutrition deltas ─────────────────────────────────────────────

def test_raise_protein_target_clamps_at_60():
    print("\n[test] raise_protein_target: chain caps at +60g")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    for _ in range(10):
        apply_overlay_action(s, u.id, "raise_protein_target", {})
    assert _overlay(s, u.id).nutrition_adjustments["protein_delta_g"] == 60


def test_raise_fiber_target_clamps_at_25():
    print("\n[test] raise_fiber_target: chain caps at +25g")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    for _ in range(10):
        apply_overlay_action(s, u.id, "raise_fiber_target", {})
    assert _overlay(s, u.id).nutrition_adjustments["fiber_delta_g"] == 25


# ── Routing: unknown actions return None (fall-through) ──────────

def test_unknown_action_returns_none_for_fallthrough():
    """The overlay service is one layer in the apply pipeline. When it
    doesn't handle an action it MUST return None so apply_action can
    fall through to its legacy paths or reject. Returning anything
    truthy would silently swallow misrouted actions."""
    print("\n[test] unknown action: returns None (caller routes fallback)")
    from app.services.coach.overlay import apply_overlay_action
    _, s, u = _setup()
    res = apply_overlay_action(s, u.id, "make_user_a_pro_lifter", {})
    assert res is None


def test_legacy_apply_action_types_return_none():
    """change_days_per_week / raise_calories / swap_to_recovery are
    NOT overlay-targeted — they have their own tables. The overlay
    service must return None for these so apply_action.py keeps
    handling them via its original code paths."""
    print("\n[test] legacy apply types: overlay returns None (no swallow)")
    from app.services.coach.overlay import apply_overlay_action
    legacy_types = ("change_days_per_week", "raise_calories", "lower_calories",
                    "swap_to_recovery", "hold_calorie_adjustment", "noop")
    for atype in legacy_types:
        _, s, u = _setup()
        res = apply_overlay_action(s, u.id, atype, {"value": 4, "kcal": 100})
        assert res is None, f"overlay must not handle {atype} — returned {res}"


# ── Decay sweep ──────────────────────────────────────────────────

def test_decay_no_op_when_not_expired():
    print("\n[test] decay_if_expired: no-op when expires_at is in the future")
    from app.services.coach.overlay import (
        apply_overlay_action, decay_if_expired, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})
    ov = get_or_create_overlay(s, u.id)
    bias_before = dict(ov.muscle_volume_bias)
    changed = decay_if_expired(s, ov)
    assert not changed
    assert ov.muscle_volume_bias == bias_before


def test_decay_steps_volume_bias_toward_neutral():
    """When the overlay TTL has passed, every bias should step half
    a stride toward 1.0. Tests both directions (above + below)."""
    print("\n[test] decay_if_expired: bias steps toward 1.0 in both directions")
    from app.services.coach.overlay import (
        apply_overlay_action, decay_if_expired, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})    # 1.1
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})    # 1.2
    apply_overlay_action(s, u.id, "reduce_muscle_volume", {"muscle": "chest"}) # 0.9
    ov = get_or_create_overlay(s, u.id)
    # Force expiry so decay fires.
    ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
    s.add(ov); s.commit()
    decay_if_expired(s, ov)
    s.commit()
    bias = ov.muscle_volume_bias
    assert abs(bias["quads"] - 1.15) < 0.001, f"expected 1.15 after half-step decay, got {bias.get('quads')}"
    assert abs(bias["chest"] - 0.95) < 0.001, f"expected 0.95 after half-step decay, got {bias.get('chest')}"


def test_decay_drops_fully_neutralized_entries():
    """A muscle that decayed all the way back to 1.0 should be removed
    from the JSON map so it doesn't bloat over time."""
    print("\n[test] decay_if_expired: muscles that hit 1.0 are dropped from JSON")
    from app.services.coach.overlay import (
        apply_overlay_action, decay_if_expired, get_or_create_overlay,
    )
    _, s, u = _setup()
    # Single +0.1 apply → bias=1.1. Two half-step decays → 1.05, 1.0.
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})
    ov = get_or_create_overlay(s, u.id)
    for _ in range(2):
        ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
        s.add(ov); s.commit()
        decay_if_expired(s, ov)
        s.commit()
    assert "quads" not in ov.muscle_volume_bias, \
        f"fully decayed muscle should be dropped; got {ov.muscle_volume_bias}"


def test_decay_clears_intensity_bias_immediately():
    """intensity_bias is binary — there's no half-step. When TTL
    expires it clears in one pass."""
    print("\n[test] decay_if_expired: intensity_bias clears in one expiry cycle")
    from app.services.coach.overlay import (
        apply_overlay_action, decay_if_expired, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "strength_preservation", {})
    ov = get_or_create_overlay(s, u.id)
    ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
    s.add(ov); s.commit()
    decay_if_expired(s, ov); s.commit()
    assert ov.intensity_bias is None


def test_decay_clears_past_deload_date_only():
    """A deload window in the future must NOT be cleared early. A past
    one must be cleared even before TTL."""
    print("\n[test] decay_if_expired: deload date cleared only after it passes")
    from datetime import date, timedelta as td
    from app.services.coach.overlay import (
        apply_overlay_action, decay_if_expired, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "schedule_deload", {"days": 7})
    ov = get_or_create_overlay(s, u.id)
    # Force TTL expiry but leave deload_until_date in the future.
    future_date = ov.deload_until_date
    ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
    s.add(ov); s.commit()
    decay_if_expired(s, ov); s.commit()
    assert ov.deload_until_date == future_date, \
        "future deload window must not be cleared by decay"

    # Now manually set deload to yesterday + force expiry: should clear.
    ov.deload_until_date = date.today() - td(days=1)
    ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
    s.add(ov); s.commit()
    decay_if_expired(s, ov); s.commit()
    assert ov.deload_until_date is None, "past deload date must be cleared"


def test_decay_extends_expires_at_after_running():
    """Running decay shouldn't allow it to fire again on the very next
    regen — that would chain decays unfairly fast. The decay sweep
    pushes expires_at forward by another TTL."""
    print("\n[test] decay_if_expired: extends expires_at to prevent chain-decays")
    from app.services.coach.overlay import (
        apply_overlay_action, decay_if_expired, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_cardio_session", {})
    ov = get_or_create_overlay(s, u.id)
    ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
    s.add(ov); s.commit()
    decay_if_expired(s, ov); s.commit()
    assert ov.expires_at > datetime.utcnow(), \
        "expires_at must be pushed forward after decay runs"


# ── snapshot_for_planner ─────────────────────────────────────────

def test_snapshot_shape_matches_planner_contract():
    """PlannerInputs.coaching_overlay reads these exact keys —
    snapshot must always emit them all (even when overlay is empty)
    so the planner can use simple dict.get() lookups."""
    print("\n[test] snapshot_for_planner: emits expected keys for empty overlay")
    from app.services.coach.overlay import snapshot_for_planner
    _, s, u = _setup()
    snap = snapshot_for_planner(s, u.id, run_decay=False)
    expected_keys = {
        "muscle_volume_bias", "cardio_minutes_target", "zone2_minutes_target",
        "core_sessions_target", "intensity_bias", "deload_active",
        "deload_until_date", "nutrition_adjustments",
    }
    assert set(snap.keys()) >= expected_keys, \
        f"snapshot missing keys: expected {expected_keys}, got {set(snap.keys())}"
    assert snap["muscle_volume_bias"] == {}
    assert snap["nutrition_adjustments"] == {}
    assert snap["deload_active"] is False


def test_snapshot_round_trips_applied_values():
    """Apply a handful of actions, snapshot, verify every value is
    reflected exactly. Catches mismatches between the apply layer
    and what the planner reads."""
    print("\n[test] snapshot_for_planner: round-trips every applied value")
    from app.services.coach.overlay import apply_overlay_action, snapshot_for_planner
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_cardio_session", {"minutes": 60})
    apply_overlay_action(s, u.id, "add_zone2_session", {"minutes": 45})
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})
    apply_overlay_action(s, u.id, "set_core_frequency", {"sessions_per_week": 3})
    apply_overlay_action(s, u.id, "schedule_deload", {})
    apply_overlay_action(s, u.id, "strength_preservation", {})
    apply_overlay_action(s, u.id, "raise_protein_target", {})
    snap = snapshot_for_planner(s, u.id, run_decay=False)
    assert snap["cardio_minutes_target"] == 60
    assert snap["zone2_minutes_target"] == 45
    assert snap["muscle_volume_bias"]["quads"] == 1.1
    assert snap["core_sessions_target"] == 3
    assert snap["intensity_bias"] == "strength"
    assert snap["deload_active"] is True
    assert snap["nutrition_adjustments"]["protein_delta_g"] == 10


def test_snapshot_with_decay_applies_when_expired():
    """run_decay=True (the default) sweeps decay before snapshotting.
    Verifies the integration of the two helpers."""
    print("\n[test] snapshot_for_planner: run_decay=True applies decay before reading")
    from app.services.coach.overlay import (
        apply_overlay_action, snapshot_for_planner, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"})  # 1.2
    ov = get_or_create_overlay(s, u.id)
    ov.expires_at = datetime.utcnow() - timedelta(seconds=1)
    s.add(ov); s.commit()
    snap = snapshot_for_planner(s, u.id, run_decay=True)
    assert abs(snap["muscle_volume_bias"]["quads"] - 1.15) < 0.001, \
        f"expected decayed value 1.15, got {snap['muscle_volume_bias']}"


def test_deload_active_flag_only_true_today_or_earlier_through_window():
    """deload_active must be True when today() <= deload_until_date,
    False when window has passed, regardless of whether the row still
    holds the date."""
    print("\n[test] snapshot deload_active: only True while window is current")
    from datetime import date, timedelta as td
    from app.services.coach.overlay import (
        apply_overlay_action, snapshot_for_planner, get_or_create_overlay,
    )
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "schedule_deload", {"days": 3})
    snap = snapshot_for_planner(s, u.id, run_decay=False)
    assert snap["deload_active"] is True

    # Backdate to yesterday — window has passed.
    ov = get_or_create_overlay(s, u.id)
    ov.deload_until_date = date.today() - td(days=1)
    s.add(ov); s.commit()
    snap = snapshot_for_planner(s, u.id, run_decay=False)
    assert snap["deload_active"] is False


# ── Audit trail ──────────────────────────────────────────────────

def test_every_apply_writes_coach_memory():
    """Every successful apply must record a CoachMemory row so we can
    show 'undo last rec' / 'why did the plan change?' later."""
    print("\n[test] every overlay apply writes CoachMemory(event_type='ai_apply')")
    from app.services.coach.overlay import apply_overlay_action
    from app.models import CoachMemory
    from sqlmodel import select
    _, s, u = _setup()
    apply_overlay_action(s, u.id, "add_cardio_session", {}, rec_key="rec_a")
    apply_overlay_action(s, u.id, "add_muscle_volume", {"muscle": "quads"}, rec_key="rec_b")
    rows = s.exec(
        select(CoachMemory)
        .where(CoachMemory.user_id == u.id, CoachMemory.event_type == "ai_apply")
    ).all()
    assert len(rows) == 2, f"expected 2 audit rows, got {len(rows)}"
    rec_keys = {(r.details or {}).get("rec_key") for r in rows}
    assert rec_keys == {"rec_a", "rec_b"}


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} coach overlay tests passed")
