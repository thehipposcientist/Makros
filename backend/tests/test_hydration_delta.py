"""Tests for atomic hydration delta semantics on POST /meals/hydration.

The frontend used to compute `next = current + delta` and POST an
absolute value. Rapid taps lost increments because each tap read the
same stale React state. We added `delta_oz` so the server reads-and-
adds in one transaction — concurrent +8oz taps now sum to +24oz.

Coverage:
  - delta_oz on a fresh day starts at 0 and adds correctly
  - delta_oz on a populated day adds onto the prior value
  - sequential deltas compose (simulates rapid taps)
  - negative delta clamps to 0 (can't go below empty)
  - absolute `ounces` still works (set semantics for explicit UI)
  - delta_oz wins when both fields are set (additive is the safer
    default — explicit user intent is harder to reconstruct)
  - 422 when neither field is set

Run manually:
    docker exec -it thallo-backend python -m tests.test_hydration_delta
"""
from __future__ import annotations

from datetime import date


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from sqlalchemy.pool import StaticPool
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, WorkoutCompletion,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, email: str = "hydration_delta@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _post_hydration(db, user, *, delta_oz=None, ounces=None, log_date=None):
    """Direct call to the route function — bypasses FastAPI auth wiring."""
    from app.routers.meals import HydrationLogBody, log_hydration
    body = HydrationLogBody(delta_oz=delta_oz, ounces=ounces, log_date=log_date)
    return log_hydration(body=body, current_user=user, db=db)


def _read_hydration(db, user, log_date: date) -> float:
    from sqlmodel import select
    from app.models import UserDayState
    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == user.id)
        .where(UserDayState.day_key == log_date)
    ).first()
    if state is None:
        return 0.0
    return float((state.nutrition_plan or {}).get("_hydration_oz", 0) or 0)


# ── Tests ───────────────────────────────────────────────────────────


def test_delta_on_fresh_day_starts_at_zero() -> None:
    print("\n[test] delta_oz on a day with no row → starts from 0")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        result = _post_hydration(s, user, delta_oz=8.0, log_date=str(date.today()))
    assert result["ounces"] == 8.0, result
    _ok("0 + 8 = 8 (row created on demand)")


def test_delta_adds_onto_prior_value() -> None:
    print("\n[test] delta_oz on a populated day → adds onto prior")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        _post_hydration(s, user, ounces=24.0, log_date=str(date.today()))
        result = _post_hydration(s, user, delta_oz=16.0, log_date=str(date.today()))
    assert result["ounces"] == 40.0, result
    _ok("24 + 16 = 40")


def test_sequential_deltas_compose() -> None:
    print("\n[test] three rapid +8oz deltas compose to +24 (the bug we are fixing)")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        _post_hydration(s, user, delta_oz=8.0, log_date=d)
        _post_hydration(s, user, delta_oz=8.0, log_date=d)
        result = _post_hydration(s, user, delta_oz=8.0, log_date=d)
        final = _read_hydration(s, user, date.today())
    assert result["ounces"] == 24.0, result
    assert final == 24.0, final
    _ok("3× +8 → 24 (DB persisted)")


def test_negative_delta_clamps_to_zero() -> None:
    print("\n[test] negative delta clamps at 0 — can't go below empty")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        _post_hydration(s, user, delta_oz=8.0, log_date=d)
        result = _post_hydration(s, user, delta_oz=-50.0, log_date=d)
    assert result["ounces"] == 0.0, result
    _ok("8 + (-50) clamps to 0 (no negative hydration)")


def test_negative_delta_partial_decrement() -> None:
    print("\n[test] negative delta within range decrements normally")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        _post_hydration(s, user, delta_oz=24.0, log_date=d)
        result = _post_hydration(s, user, delta_oz=-8.0, log_date=d)
    assert result["ounces"] == 16.0, result
    _ok("24 + (-8) = 16 (undo a quick-add tap)")


def test_absolute_ounces_still_works() -> None:
    print("\n[test] absolute `ounces` field overwrites — set semantics intact")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        _post_hydration(s, user, delta_oz=24.0, log_date=d)
        result = _post_hydration(s, user, ounces=64.0, log_date=d)
    assert result["ounces"] == 64.0, result
    _ok("absolute set replaces the running total — explicit UI semantics")


def test_delta_wins_when_both_set() -> None:
    print("\n[test] delta_oz takes precedence when both fields are set")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        _post_hydration(s, user, delta_oz=8.0, log_date=d)
        # If a buggy client sends both, prefer delta — additive op is
        # the safer default; an absolute value would clobber other taps.
        result = _post_hydration(s, user, delta_oz=4.0, ounces=999.0, log_date=d)
    assert result["ounces"] == 12.0, result
    _ok("delta_oz wins — additive op is preferred")


def test_missing_both_returns_422() -> None:
    print("\n[test] neither delta_oz nor ounces set → 422")
    from sqlmodel import Session
    from fastapi import HTTPException
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        try:
            _post_hydration(s, user, log_date=str(date.today()))
            raise AssertionError("expected HTTPException")
        except HTTPException as e:
            assert e.status_code == 422, e.status_code
    _ok("HTTPException(422) raised")


def test_delta_persists_to_db() -> None:
    print("\n[test] delta writes through to UserDayState.nutrition_plan")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        _post_hydration(s, user, delta_oz=12.5, log_date=d)
        # Open a fresh-style read to mimic a separate request.
        persisted = _read_hydration(s, user, date.today())
    assert persisted == 12.5, persisted
    _ok("12.5 oz persisted to UserDayState (not just an in-memory cache)")


def test_decimal_rounding_to_one_place() -> None:
    print("\n[test] result is rounded to 1 decimal place")
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = str(date.today())
        # Three weird floats that would otherwise leave float dust.
        _post_hydration(s, user, delta_oz=0.1, log_date=d)
        _post_hydration(s, user, delta_oz=0.2, log_date=d)
        result = _post_hydration(s, user, delta_oz=0.3, log_date=d)
    # 0.1 + 0.2 + 0.3 in float is 0.6000000000000001 — rounded → 0.6.
    assert result["ounces"] == 0.6, result
    _ok("0.1 + 0.2 + 0.3 = 0.6 (no float dust in the DB)")


def test_day_state_nutrition_patch_preserves_hydration() -> None:
    print("\n[test] day-state nutrition patch preserves logged hydration")
    from sqlmodel import Session
    from app.models import DayStateUpsert
    from app.routers.profile import upsert_day_state

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        d = date.today()
        _post_hydration(s, user, ounces=32.0, log_date=str(d))
        upsert_day_state(
            d,
            DayStateUpsert(nutrition_plan={
                "targets": {"calories": 2200, "protein": 160, "carbs": 240, "fat": 70},
                "meals": [{"meal": "Breakfast", "calories": 500, "protein": 35, "carbs": 55, "fat": 16}],
            }),
            current_user=user,
            session=s,
        )
        final = _read_hydration(s, user, d)
    assert final == 32.0, final
    _ok("meal-plan save did not wipe _hydration_oz")


cases = [
    test_delta_on_fresh_day_starts_at_zero,
    test_delta_adds_onto_prior_value,
    test_sequential_deltas_compose,
    test_negative_delta_clamps_to_zero,
    test_negative_delta_partial_decrement,
    test_absolute_ounces_still_works,
    test_delta_wins_when_both_set,
    test_missing_both_returns_422,
    test_delta_persists_to_db,
    test_decimal_rounding_to_one_place,
    test_day_state_nutrition_patch_preserves_hydration,
]


if __name__ == "__main__":
    import traceback
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            traceback.print_exc()
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    if failures:
        raise SystemExit(1)
    print(f"\n  All {len(cases)} tests passed.")
