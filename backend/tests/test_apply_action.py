"""Tests for `services.coach.apply_action.apply_action`.

Every supported action type, every guard rail, every error path. Catches
regressions where an action silently fails to mutate state, or worse,
mutates state outside its safety caps (e.g. a 500-kcal swing slipping
past `_MAX_KCAL_DELTA`).

Coverage:
  - change_days_per_week: success, day cap (>1), invalid value
  - raise_calories / lower_calories: success, kcal cap, accumulation
    across multiple applies, invalid kcal
  - hold_calorie_adjustment: writes memory, no state mutation
  - swap_to_recovery: creates UserDayState row tomorrow with skipped_focus
  - swap_to_recovery: updates existing UserDayState row in place
  - noop: ack only, no DB writes
  - descriptive-only actions: write memory, never mutate
  - unknown action type: graceful fallback
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


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


def _setup(days_per_week: int = 4):
    """Build an engine + session with a User + UserPreferences row."""
    from sqlmodel import Session
    from app.models import User, UserPreferences
    engine = _make_mem_engine()
    s = Session(engine)
    u = User(email="apply@example.com", username="apply", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    p = UserPreferences(user_id=u.id, days_per_week=days_per_week)
    s.add(p); s.commit()
    return engine, s, u


# ── change_days_per_week ───────────────────────────────────────────

def test_change_days_per_week_success():
    print("\n[test] change_days_per_week: 4 → 5 succeeds + needs_regen")
    from app.services.coach.apply_action import apply_action
    from app.models import UserPreferences
    from sqlmodel import select
    _, s, u = _setup(days_per_week=4)
    res = apply_action(s, u.id, {"type": "change_days_per_week", "value": 5})
    assert res.applied
    assert res.needs_regen
    assert res.changed_fields["days_per_week"] == 5
    p = s.exec(select(UserPreferences).where(UserPreferences.user_id == u.id)).first()
    assert p.days_per_week == 5
    _ok("days_per_week persisted to DB")


def test_change_days_per_week_capped_at_one_jump():
    """The user's contract: never jump >1 day at once."""
    print("\n[test] change_days_per_week: 4 → 6 capped (delta >1)")
    from app.services.coach.apply_action import apply_action
    from app.models import UserPreferences
    from sqlmodel import select
    _, s, u = _setup(days_per_week=4)
    res = apply_action(s, u.id, {"type": "change_days_per_week", "value": 6})
    assert not res.applied, "delta of 2 should be capped"
    assert res.descriptive_only
    p = s.exec(select(UserPreferences).where(UserPreferences.user_id == u.id)).first()
    assert p.days_per_week == 4, "DB should not be mutated when capped"


def test_change_days_per_week_rejects_out_of_range():
    print("\n[test] change_days_per_week: value=0 rejected")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "change_days_per_week", "value": 0})
    assert not res.applied
    assert res.error == "invalid_value"


def test_change_days_per_week_no_prefs_row():
    """User without a UserPreferences row should fail gracefully, not crash."""
    print("\n[test] change_days_per_week: missing prefs returns no_prefs error")
    from sqlmodel import Session
    from app.models import User
    from app.services.coach.apply_action import apply_action
    engine = _make_mem_engine()
    s = Session(engine)
    u = User(email="x@x.com", username="x", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    res = apply_action(s, u.id, {"type": "change_days_per_week", "value": 5})
    assert not res.applied
    assert res.error == "no_prefs"


# ── raise_calories / lower_calories ────────────────────────────────

def test_raise_calories_persists_positive_delta():
    print("\n[test] raise_calories: kcal=200 increments coaching state")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState
    from sqlmodel import select
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "raise_calories", "kcal": 200})
    assert res.applied
    state = s.exec(select(UserCoachingState).where(UserCoachingState.user_id == u.id)).first()
    assert state.calorie_adjustment == 200
    _ok("calorie_adjustment persisted to +200")


def test_lower_calories_persists_negative_delta():
    print("\n[test] lower_calories: kcal=150 decrements")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState
    from sqlmodel import select
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "lower_calories", "kcal": 150})
    assert res.applied
    state = s.exec(select(UserCoachingState).where(UserCoachingState.user_id == u.id)).first()
    assert state.calorie_adjustment == -150


def test_kcal_cap_prevents_dangerous_delta():
    """The hard cap _MAX_KCAL_DELTA=250 must clip a 500 request to 250."""
    print("\n[test] raise_calories: kcal=500 capped at 250 (safety)")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState
    from sqlmodel import select
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "raise_calories", "kcal": 500})
    assert res.applied
    state = s.exec(select(UserCoachingState).where(UserCoachingState.user_id == u.id)).first()
    assert state.calorie_adjustment == 250, \
        f"500 kcal request should be capped at 250, got {state.calorie_adjustment}"


def test_calorie_adjustments_accumulate():
    """Two consecutive raises stack on top of each other."""
    print("\n[test] calorie_adjustment accumulates across applies")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState
    from sqlmodel import select
    _, s, u = _setup()
    apply_action(s, u.id, {"type": "raise_calories", "kcal": 100})
    apply_action(s, u.id, {"type": "raise_calories", "kcal": 100})
    state = s.exec(select(UserCoachingState).where(UserCoachingState.user_id == u.id)).first()
    assert state.calorie_adjustment == 200


def test_calorie_apply_with_zero_kcal_rejected():
    print("\n[test] raise_calories: kcal=0 rejected")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "raise_calories", "kcal": 0})
    assert not res.applied
    assert res.error == "invalid_kcal"


# ── hold_calorie_adjustment ────────────────────────────────────────

def test_hold_calorie_adjustment_writes_memory_no_mutation():
    print("\n[test] hold_calorie_adjustment: ack only, no state change")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState, CoachMemory
    from sqlmodel import select
    _, s, u = _setup()
    # Pre-set a coaching adjustment we want preserved.
    state_pre = UserCoachingState(user_id=u.id, calorie_adjustment=-100)
    s.add(state_pre); s.commit()
    res = apply_action(s, u.id, {"type": "hold_calorie_adjustment"})
    assert res.applied
    state = s.exec(select(UserCoachingState).where(UserCoachingState.user_id == u.id)).first()
    assert state.calorie_adjustment == -100, "hold must not mutate adjustment"
    mem = s.exec(select(CoachMemory).where(CoachMemory.user_id == u.id)).all()
    assert any("hold" in (m.summary or "").lower() for m in mem)


# ── swap_to_recovery ───────────────────────────────────────────────

def test_swap_to_recovery_creates_tomorrow_day_state():
    print("\n[test] swap_to_recovery: tomorrow's UserDayState gets skipped_focus")
    from app.services.coach.apply_action import apply_action
    from app.models import UserDayState
    from sqlmodel import select
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "swap_to_recovery"})
    assert res.applied
    tomorrow = date.today() + timedelta(days=1)
    row = s.exec(
        select(UserDayState)
        .where(UserDayState.user_id == u.id, UserDayState.day_key == tomorrow)
    ).first()
    assert row is not None, "no UserDayState row created for tomorrow"
    assert row.skipped_focus == "recovery"


def test_swap_to_recovery_updates_existing_day_state():
    """Pre-existing UserDayState row for tomorrow should be UPDATED in
    place, not duplicated. Otherwise `select` returns multiple rows
    and `_persist_active` etc. break with .first() ambiguity."""
    print("\n[test] swap_to_recovery: existing row updated in place")
    from app.services.coach.apply_action import apply_action
    from app.models import UserDayState
    from sqlmodel import select
    _, s, u = _setup()
    tomorrow = date.today() + timedelta(days=1)
    pre = UserDayState(user_id=u.id, day_key=tomorrow, meal_checks={}, nutrition_plan=None)
    s.add(pre); s.commit()
    apply_action(s, u.id, {"type": "swap_to_recovery"})
    rows = s.exec(
        select(UserDayState)
        .where(UserDayState.user_id == u.id, UserDayState.day_key == tomorrow)
    ).all()
    assert len(rows) == 1, f"expected exactly 1 row, got {len(rows)}"
    assert rows[0].skipped_focus == "recovery"


# ── noop ───────────────────────────────────────────────────────────

def test_noop_returns_applied_with_no_changes():
    print("\n[test] noop: returns applied=True with empty changed_fields")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "noop"})
    assert res.applied
    assert res.changed_fields == {}
    assert not res.needs_regen


# ── Overlay-routed actions (the new contract) ─────────────────────
#
# Every action that used to be "descriptive-only" now routes through
# UserCoachingOverlay and writes durable state. Apply-button on these
# means "real change, plan refreshes" instead of "logged a placebo."

def _overlay_for(s, uid):
    from app.models import UserCoachingOverlay
    from sqlmodel import select
    return s.exec(
        select(UserCoachingOverlay).where(UserCoachingOverlay.user_id == uid)
    ).first()


def test_add_cardio_session_writes_overlay():
    print("\n[test] add_cardio_session: writes cardio_minutes_target to overlay")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "add_cardio_session"}, rec_key="r1")
    assert res.applied
    assert res.needs_regen
    assert "30" in res.summary, f"summary should mention the +30 min bump: {res.summary}"
    ov = _overlay_for(s, u.id)
    assert ov is not None
    assert ov.cardio_minutes_target == 30
    _ok("cardio_minutes_target persisted to 30")


def test_add_cardio_session_accumulates_with_cap():
    """Repeated add_cardio_session bumps the target by 30 each time
    until the 360-min weekly cap kicks in."""
    print("\n[test] add_cardio_session: accumulates across applies; clamped at 360")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    for _ in range(15):  # 15 × 30 = 450, over the 360 cap
        apply_action(s, u.id, {"type": "add_cardio_session"})
    ov = _overlay_for(s, u.id)
    assert ov.cardio_minutes_target == 360, \
        f"expected cardio cap at 360, got {ov.cardio_minutes_target}"


def test_add_muscle_volume_requires_muscle_payload():
    """Without a `muscle` field the call must reject — applying a bias
    to the wrong muscle would silently misshape the plan."""
    print("\n[test] add_muscle_volume: missing muscle → rejected")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "add_muscle_volume"})
    assert not res.applied
    assert res.error == "missing_muscle"
    ov = _overlay_for(s, u.id)
    assert (ov is None) or (not ov.muscle_volume_bias), \
        "no overlay mutation should occur when muscle missing"


def test_add_muscle_volume_steps_bias_per_apply():
    print("\n[test] add_muscle_volume quads: steps bias by 0.1 each apply")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    apply_action(s, u.id, {"type": "add_muscle_volume", "muscle": "quads"})
    apply_action(s, u.id, {"type": "add_muscle_volume", "muscle": "quads"})
    ov = _overlay_for(s, u.id)
    assert abs(ov.muscle_volume_bias["quads"] - 1.2) < 0.001, \
        f"expected quads=1.2 after two +10% applies, got {ov.muscle_volume_bias.get('quads')}"


def test_add_muscle_volume_caps_at_1_3():
    print("\n[test] add_muscle_volume: chain of applies caps at 1.3")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    for _ in range(10):
        apply_action(s, u.id, {"type": "add_muscle_volume", "muscle": "back"})
    ov = _overlay_for(s, u.id)
    assert abs(ov.muscle_volume_bias["back"] - 1.3) < 0.001, \
        f"expected back=1.3 cap, got {ov.muscle_volume_bias.get('back')}"


def test_reduce_muscle_volume_floors_at_0_7():
    print("\n[test] reduce_muscle_volume: chain of applies floors at 0.7")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    for _ in range(10):
        apply_action(s, u.id, {"type": "reduce_muscle_volume", "muscle": "chest"})
    ov = _overlay_for(s, u.id)
    assert abs(ov.muscle_volume_bias["chest"] - 0.7) < 0.001, \
        f"expected chest=0.7 floor, got {ov.muscle_volume_bias.get('chest')}"


def test_hold_muscle_volume_resets_to_neutral():
    """`hold_muscle_volume` clears any prior bias on that muscle —
    the spike rec should snap things back to baseline, not nudge."""
    print("\n[test] hold_muscle_volume: resets bias to 1.0 (drops from JSON)")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    apply_action(s, u.id, {"type": "add_muscle_volume", "muscle": "quads"})
    apply_action(s, u.id, {"type": "add_muscle_volume", "muscle": "quads"})
    apply_action(s, u.id, {"type": "hold_muscle_volume", "muscle": "quads"})
    ov = _overlay_for(s, u.id)
    # Neutral entries are dropped from the JSON to keep it clean.
    assert "quads" not in (ov.muscle_volume_bias or {}), \
        f"quads should be removed after hold, got {ov.muscle_volume_bias}"


def test_set_core_frequency_writes_target():
    print("\n[test] set_core_frequency: writes core_sessions_target=3")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "set_core_frequency", "sessions_per_week": 3})
    assert res.applied
    ov = _overlay_for(s, u.id)
    assert ov.core_sessions_target == 3


def test_schedule_deload_sets_until_date():
    print("\n[test] schedule_deload: sets deload_until_date to today + N days")
    from datetime import date, timedelta
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "schedule_deload"})
    assert res.applied
    ov = _overlay_for(s, u.id)
    assert ov.deload_until_date is not None
    # Default 7-day window, with a small tolerance for clock skew.
    days_out = (ov.deload_until_date - date.today()).days
    assert 6 <= days_out <= 8, f"expected ~7 days, got {days_out}"


def test_strength_preservation_sets_intensity_bias():
    print("\n[test] strength_preservation: writes intensity_bias='strength'")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "strength_preservation"})
    assert res.applied
    ov = _overlay_for(s, u.id)
    assert ov.intensity_bias == "strength"


def test_raise_protein_target_writes_nutrition_delta():
    print("\n[test] raise_protein_target: writes nutrition_adjustments.protein_delta_g=10")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "raise_protein_target"})
    assert res.applied
    ov = _overlay_for(s, u.id)
    assert ov.nutrition_adjustments.get("protein_delta_g") == 10


def test_raise_fiber_target_writes_nutrition_delta():
    print("\n[test] raise_fiber_target: writes nutrition_adjustments.fiber_delta_g=5")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "raise_fiber_target"})
    assert res.applied
    ov = _overlay_for(s, u.id)
    assert ov.nutrition_adjustments.get("fiber_delta_g") == 5


def test_unsupported_quick_intent_actions_rejected():
    """Quick-intent action types that no longer have a handler must
    return applied=False with a clear message — NEVER silently log a
    placebo CoachMemory like the old contract did."""
    print("\n[test] unsupported actions: rejected with unknown_action_type error")
    from app.services.coach.apply_action import apply_action
    unsupported = (
        "shorten_workout", "reduce_intensity", "carb_bump_today",
        "rebalance_week", "swap_to_recovery_or_reduce",
    )
    for atype in unsupported:
        _, s, u = _setup()
        res = apply_action(s, u.id, {"type": atype})
        assert not res.applied, f"{atype} should be rejected, not silently 'applied'"
        assert res.error == "unknown_action_type", \
            f"{atype} should error as unknown_action_type, got {res.error}"
        assert res.descriptive_only, \
            f"{atype} should mark descriptive_only so the UI hides Apply"


# ── Unknown action type ────────────────────────────────────────────

def test_unknown_action_type_graceful_fallback():
    print("\n[test] unknown action type: applied=False but no crash")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "make_user_a_pro_lifter"})
    assert not res.applied
    assert res.error == "unknown_action_type"
    assert res.descriptive_only


def test_invalid_action_dict_returns_error():
    print("\n[test] non-dict action: applied=False, no crash")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, "not a dict")  # noqa
    assert not res.applied
    assert res.error == "invalid_action"


def test_missing_action_type_returns_error():
    print("\n[test] action without type field: missing_type error")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"value": 5})
    assert not res.applied
    assert res.error == "missing_type"


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
    print(f"\nAll {len(test_fns)} apply_action tests passed")
