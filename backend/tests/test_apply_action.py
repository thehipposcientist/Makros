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
  - swap_to_recovery: creates UserDayState row tomorrow with skipped_focus + reason
  - swap_to_recovery: updates existing UserDayState row in place
  - swap_to_recovery: does not rewrite the active PlanWeek row
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
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, PlanWeek, PlanDay,
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
    print("\n[test] swap_to_recovery: tomorrow's UserDayState gets recovery override")
    from app.services.coach.apply_action import apply_action
    from app.models import UserDayState
    from sqlmodel import select
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "swap_to_recovery"})
    assert res.applied
    assert res.summary == "Tomorrow is set as a recovery day."
    tomorrow = date.today() + timedelta(days=1)
    row = s.exec(
        select(UserDayState)
        .where(UserDayState.user_id == u.id, UserDayState.day_key == tomorrow)
    ).first()
    assert row is not None, "no UserDayState row created for tomorrow"
    assert row.skipped_focus == "recovery"
    assert row.skip_reason == "Coach swapped to recovery"
    assert res.changed_fields["skipped_focus"]["to"] == "recovery"
    assert res.changed_fields["skip_reason"]["to"] == "Coach swapped to recovery"


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
    assert rows[0].skip_reason == "Coach swapped to recovery"


def test_swap_to_recovery_keeps_active_plan_week_fixed():
    """Applying a recovery recommendation is a UserDayState overlay, not
    a PlanDay rewrite. This preserves the fixed-week invariant while
    still giving the UI a visible recovery state to render."""
    print("\n[test] swap_to_recovery: active PlanDay remains fixed")
    from app.services.coach.apply_action import apply_action
    from app.models import PlanWeek, PlanDay, UserDayState
    from sqlmodel import select
    _, s, u = _setup()
    today = date.today()
    tomorrow = today + timedelta(days=1)
    pw = PlanWeek(
        user_id=u.id,
        start_date=today,
        end_date=today + timedelta(days=6),
        planner_version="test",
        goal="muscle_gain",
        days_per_week=4,
        preferred_split="ppl",
        status="active",
    )
    s.add(pw)
    s.flush()
    workout = {"day": "Day 2", "focus": "Legs", "stimulus": "hypertrophy", "exercises": [{"name": "Squat"}]}
    pd = PlanDay(
        plan_week_id=pw.id,
        user_id=u.id,
        day_date=tomorrow,
        day_index=1,
        status="planned",
        is_rest=False,
        workout_json=workout,
        nutrition_json={"targets": {"calories": 2200}},
        locked=False,
        generation_source="initial",
    )
    s.add(pd)
    s.commit()

    res = apply_action(s, u.id, {"type": "swap_to_recovery"})
    assert res.applied
    s.refresh(pd)
    assert pd.status == "planned"
    assert pd.locked is False
    assert pd.lock_reason is None
    assert pd.is_rest is False
    assert pd.workout_json == workout
    row = s.exec(
        select(UserDayState)
        .where(UserDayState.user_id == u.id, UserDayState.day_key == tomorrow)
    ).first()
    assert row is not None
    assert row.skipped_focus == "recovery"
    assert row.skip_reason == "Coach swapped to recovery"


# ── noop ───────────────────────────────────────────────────────────

def test_noop_returns_applied_with_no_changes():
    print("\n[test] noop: returns applied=True with empty changed_fields")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    res = apply_action(s, u.id, {"type": "noop"})
    assert res.applied
    assert res.changed_fields == {}
    assert not res.needs_regen


# ── add_cardio_session / add_zone2_session ────────────────────────

def test_add_cardio_session_with_minutes_increments_future_day_count():
    print("\n[test] add_cardio_session: actionable minutes bumps days/week")
    from app.services.coach.apply_action import apply_action
    from app.models import UserPreferences
    from sqlmodel import select
    _, s, u = _setup(days_per_week=4)
    res = apply_action(s, u.id, {"type": "add_cardio_session", "minutes": 30, "style": "zone2"})
    assert res.applied
    assert res.needs_regen
    assert not res.descriptive_only
    assert res.changed_fields["days_per_week"] == {"from": 4, "to": 5}
    p = s.exec(select(UserPreferences).where(UserPreferences.user_id == u.id)).first()
    assert p.days_per_week == 5


def test_add_zone2_session_at_seven_days_is_descriptive_only():
    print("\n[test] add_zone2_session: 7-day cap becomes descriptive")
    from app.services.coach.apply_action import apply_action
    from app.models import CoachMemory, UserPreferences
    from sqlmodel import select
    _, s, u = _setup(days_per_week=7)
    res = apply_action(s, u.id, {"type": "add_zone2_session", "minutes": 45})
    assert res.applied
    assert res.descriptive_only
    assert not res.needs_regen
    assert res.changed_fields == {}
    p = s.exec(select(UserPreferences).where(UserPreferences.user_id == u.id)).first()
    assert p.days_per_week == 7
    mem = s.exec(select(CoachMemory).where(CoachMemory.user_id == u.id)).all()
    assert any("already at 7" in (m.summary or "") for m in mem)


# ── descriptive-only actions ───────────────────────────────────────

def test_descriptive_actions_write_memory_no_state_mutation():
    """Every descriptive action records a CoachMemory row + does NOT
    touch UserPreferences/UserCoachingState/UserDayState."""
    print("\n[test] descriptive actions: memory row only, no state mutation")
    from app.services.coach.apply_action import apply_action
    from app.models import UserPreferences, UserCoachingState, CoachMemory
    from sqlmodel import select
    descriptive_types = (
        "reduce_muscle_volume", "add_muscle_volume", "hold_muscle_volume",
        "add_cardio_session", "add_zone2_session", "reduce_cardio",
        "schedule_deload", "set_core_frequency", "shorten_workout",
        "reduce_intensity", "carb_bump_today", "raise_protein_target",
        "raise_fiber_target", "rebalance_week", "strength_preservation",
        "swap_to_recovery_or_reduce",
    )
    for atype in descriptive_types:
        _, s, u = _setup()
        prefs_before = s.exec(select(UserPreferences).where(UserPreferences.user_id == u.id)).first()
        days_before = prefs_before.days_per_week
        res = apply_action(s, u.id, {"type": atype}, rec_key=f"rec_{atype}")
        assert res.applied, f"{atype} should be applied (descriptive ack)"
        assert res.descriptive_only
        # Prefs unchanged.
        prefs_after = s.exec(select(UserPreferences).where(UserPreferences.user_id == u.id)).first()
        assert prefs_after.days_per_week == days_before, f"{atype} mutated days_per_week"
        # Memory row recorded.
        mem = s.exec(select(CoachMemory).where(CoachMemory.user_id == u.id)).all()
        assert any((m.details or {}).get("action", {}).get("type") == atype for m in mem), \
            f"{atype} did not record a CoachMemory action detail"


def test_descriptive_muscle_action_names_target_in_summary():
    print("\n[test] descriptive muscle action names muscle and set count")
    from app.services.coach.apply_action import apply_action
    from app.models import CoachMemory
    from sqlmodel import select
    _, s, u = _setup()
    res = apply_action(
        s,
        u.id,
        {"type": "add_muscle_volume", "muscle": "chest", "sets": 3},
        rec_key="add_volume_chest",
    )
    assert res.applied
    assert res.descriptive_only
    assert "chest" in res.summary.lower()
    assert "3" in res.summary
    mem = s.exec(select(CoachMemory).where(CoachMemory.user_id == u.id)).all()
    assert any("chest" in (m.summary or "").lower() for m in mem)
    assert not any("add_muscle_volume" in (m.summary or "") for m in mem)


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
