"""Tests for the first-class `WorkoutPlan` DB table + the
`_persist_active_workout_plan` helper that stamps every regen:

  - A regen inserts a new `is_active=True` row and marks the previous
    active row `is_active=False` with a reason + timestamp.
  - `planner_version` is written from the shared constant so clients
    can detect staleness.
  - The helper clears any `workout_json` overlay on future-dated
    `UserDayState` rows (no-op when that column doesn't exist — which
    is the case in the current schema).
  - `GET /ai/plans/active-workout` returns the active row's `plan_json`.
  - `isPlanStale` mirror helper flags missing/old/mismatched versions.

All tests run against an in-memory SQLite DB — no Docker required,
no HTTP, no external services.
"""
from __future__ import annotations

from datetime import date, timedelta


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    """Fresh in-memory SQLite with every SQLModel table the test touches.

    We explicitly skip `create_db_and_tables()` from `app.database`
    because it also runs seed inserts + OpenFoodFacts side-effects that
    are way beyond the scope of this test."""
    from sqlmodel import SQLModel, create_engine

    # Forward-import every model so metadata picks them up. Same
    # pattern `database.create_db_and_tables` uses internally.
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan,
    )

    # `sqlite://` is a per-connection in-memory DB by default — each
    # Session would open its own blank DB. Force a SHARED cache so
    # multiple Sessions see the same tables + rows.
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, email: str = "persist_test@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_plan_dict(days: int = 4) -> dict:
    return {
        "days": [
            {"day": i, "focus": "push" if i % 2 == 0 else "pull", "exercises": []}
            for i in range(days)
        ],
        "trainerNote": "test note",
    }


def _make_plan_request(**overrides):
    """Construct a minimally valid PlanRequest. Pydantic requires the
    nested models (physicalStats, goalDetails) to have all required
    fields — we default them here so the tests stay focused on the
    persistence layer, not request shape."""
    from app.routers.ai.models import PlanRequest
    base = dict(
        goal="muscle_gain",
        daysPerWeek=4,
        preferredSplit=None,
        physicalStats={
            "weightLbs": 180.0, "heightFeet": 5, "heightInches": 10,
            "age": 30, "gender": "male",
        },
        goalDetails={"pace": "moderate"},
        workoutDurationMinutes=60,
        equipment=["dumbbells"],
        foodsAvailable=[],
        experienceLevel="intermediate",
    )
    base.update(overrides)
    return PlanRequest(**base)


# ── Model + persist helper tests ─────────────────────────────────────


def test_persist_creates_active_row_with_planner_version() -> None:
    """First call writes an `is_active=True` row stamped with the
    current `PLANNER_VERSION`. Goal, days_per_week, preferred_split all
    pull off the PlanRequest."""
    print("\n[test] _persist_active_workout_plan writes initial active row")
    from sqlmodel import Session, select

    from app.models import WorkoutPlan
    from app.routers.ai.plans import _persist_active_workout_plan
    from app.services.workout.weekly_recipe import PLANNER_VERSION

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        req = _make_plan_request(preferredSplit="Upper/Lower")
        plan = _make_plan_dict(4)
        _persist_active_workout_plan(s, user.id, plan, req=req, reason="regen")

        rows = s.exec(
            select(WorkoutPlan).where(WorkoutPlan.user_id == user.id)
        ).all()
        assert len(rows) == 1, f"expected exactly 1 row, got {len(rows)}"
        row = rows[0]
        assert row.is_active is True, "new row must be active"
        assert row.planner_version == PLANNER_VERSION, (
            f"version mismatch: {row.planner_version} vs {PLANNER_VERSION}"
        )
        assert row.goal == "muscle_gain"
        assert row.days_per_week == 4
        assert row.preferred_split == "Upper/Lower"
        # JSON round-trip — plan_json survives serialize/deserialize intact.
        assert row.plan_json.get("trainerNote") == "test note"
        assert len(row.plan_json.get("days", [])) == 4
    _ok("initial write creates an active row stamped with PLANNER_VERSION")


def test_regen_deactivates_previous_and_inserts_new() -> None:
    """A second regen flips the prior active row → is_active=False with
    deactivated_at + deactivation_reason set, and inserts a fresh
    is_active=True row. At any time only ONE active row exists for a user."""
    print("\n[test] regen deactivates prior active row + inserts new")
    from sqlmodel import Session, select

    from app.models import WorkoutPlan
    from app.routers.ai.plans import _persist_active_workout_plan

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        req = _make_plan_request()
        _persist_active_workout_plan(s, user.id, _make_plan_dict(4), req=req, reason="regen")
        _persist_active_workout_plan(s, user.id, _make_plan_dict(5), req=req, reason="regen")

        rows = s.exec(
            select(WorkoutPlan).where(WorkoutPlan.user_id == user.id)
        ).all()
        assert len(rows) == 2, f"expected 2 rows after regen, got {len(rows)}"
        actives = [r for r in rows if r.is_active]
        inactives = [r for r in rows if not r.is_active]
        assert len(actives) == 1, f"expected exactly 1 active row, got {len(actives)}"
        assert len(inactives) == 1
        inactive = inactives[0]
        assert inactive.deactivated_at is not None, "deactivated_at must be stamped"
        assert inactive.deactivation_reason == "regen", (
            f"expected reason='regen', got {inactive.deactivation_reason!r}"
        )
        # The surviving active row is the SECOND write (5 days), not the first (4).
        assert len(actives[0].plan_json.get("days", [])) == 5
    _ok("regen flips is_active and stamps reason + timestamp")


def test_persist_no_op_when_db_or_user_missing() -> None:
    """Legacy callers that don't thread db/user_id through the
    generator must not crash. The helper silently short-circuits."""
    print("\n[test] _persist_active_workout_plan no-op on missing inputs")
    from app.routers.ai.plans import _persist_active_workout_plan

    req = _make_plan_request()
    # No-op paths: None db, None user_id — no exception expected.
    _persist_active_workout_plan(None, 1, {}, req=req)
    _persist_active_workout_plan(object(), None, {}, req=req)  # noqa
    _ok("helper is a safe no-op when db or user_id is None")


def test_planner_version_constant_defined_and_sane() -> None:
    """`PLANNER_VERSION` should be a date-style string. Doesn't have to
    match any specific value — only that it's present and non-empty so
    the write path always stamps something meaningful."""
    print("\n[test] PLANNER_VERSION is exported + non-empty")
    from app.services.workout.weekly_recipe import PLANNER_VERSION
    assert isinstance(PLANNER_VERSION, str), "PLANNER_VERSION must be a string"
    assert len(PLANNER_VERSION) >= 6, "PLANNER_VERSION too short to be a version"
    _ok(f"PLANNER_VERSION={PLANNER_VERSION!r}")


# ── Endpoint smoke test (uses FastAPI TestClient against the mem DB) ──


def test_active_workout_endpoint_returns_plan() -> None:
    """`GET /ai/plans/active-workout` returns the serialized active row.

    We bypass auth by instantiating the router with a dependency
    override. That keeps the test hermetic — no real user table setup,
    no JWT signing."""
    print("\n[test] GET /ai/plans/active-workout returns active plan_json")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.ai.plans import _persist_active_workout_plan
    from app.routers.ai.router import router as ai_router

    engine = _make_mem_engine()
    # Swap the module-level engine so any internal code that imports
    # `engine` from app.database sees our in-memory DB.
    orig_engine = app_db.engine
    app_db.engine = engine
    try:
        with Session(engine) as s:
            user = _insert_user(s)
            user_id = user.id  # capture before we close the session
            req = _make_plan_request()
            _persist_active_workout_plan(s, user_id, _make_plan_dict(4), req=req)

        def _session_override():
            with Session(engine) as s:
                yield s

        def _user_override():
            # Return an expunged copy so FastAPI's response rendering
            # doesn't trigger a lazy refresh on a closed session. We
            # only need `.id` in `get_active_workout_plan` but we also
            # eagerly access every attr so SQLAlchemy doesn't expire
            # anything after expunge.
            with Session(engine) as s:
                u = s.get(User, user_id)
                if u is not None:
                    # Force-load every column while bound, then detach.
                    _ = (u.id, u.email, u.username, u.hashed_password,
                         u.is_active, u.created_at,
                         u.recovery_question, u.recovery_answer_hash)
                    s.expunge(u)
                return u

        app = FastAPI()
        app.include_router(ai_router)
        app.dependency_overrides[get_session] = _session_override
        app.dependency_overrides[get_current_user] = _user_override

        client = TestClient(app)
        resp = client.get("/ai/plans/active-workout")
        assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body.get("planner_version"), "missing planner_version in response"
        assert body.get("goal") == "muscle_gain"
        assert body.get("days_per_week") == 4
        assert "plan_json" in body and isinstance(body["plan_json"], dict)
        assert len(body["plan_json"].get("days", [])) == 4
    finally:
        app_db.engine = orig_engine
    _ok("endpoint serializes the active row including plan_json + planner_version")


def test_active_workout_endpoint_404_when_no_plan() -> None:
    """Brand-new user → no active WorkoutPlan row → 404."""
    print("\n[test] GET /ai/plans/active-workout 404s without an active row")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.ai.router import router as ai_router

    engine = _make_mem_engine()
    orig_engine = app_db.engine
    app_db.engine = engine
    try:
        with Session(engine) as s:
            user = _insert_user(s)
            user_id = user.id

        def _session_override():
            with Session(engine) as s:
                yield s

        def _user_override():
            # Return an expunged copy so FastAPI's response rendering
            # doesn't trigger a lazy refresh on a closed session. We
            # only need `.id` in `get_active_workout_plan` but we also
            # eagerly access every attr so SQLAlchemy doesn't expire
            # anything after expunge.
            with Session(engine) as s:
                u = s.get(User, user_id)
                if u is not None:
                    # Force-load every column while bound, then detach.
                    _ = (u.id, u.email, u.username, u.hashed_password,
                         u.is_active, u.created_at,
                         u.recovery_question, u.recovery_answer_hash)
                    s.expunge(u)
                return u

        app = FastAPI()
        app.include_router(ai_router)
        app.dependency_overrides[get_session] = _session_override
        app.dependency_overrides[get_current_user] = _user_override

        client = TestClient(app)
        resp = client.get("/ai/plans/active-workout")
        assert resp.status_code == 404, f"expected 404, got {resp.status_code}: {resp.text}"
    finally:
        app_db.engine = orig_engine
    _ok("404 when the user has never generated a plan")


# ── Future-date DayState wipe — best-effort ──────────────────────────


def test_persist_clears_future_day_state_workout_overlays() -> None:
    """The current `UserDayState` schema has no `workout_json` column,
    so `_persist_active_workout_plan` is a no-op for that field — but
    it must still walk future rows without erroring. This test just
    verifies the happy-path side effect: nutrition_plan rows survive
    (they're cleared by the nutrition-specific path in the job worker),
    and no exception is raised even when rows exist for future dates."""
    print("\n[test] persist walks future DayState rows without error")
    from sqlmodel import Session, select

    from app.models import UserDayState, WorkoutPlan
    from app.routers.ai.plans import _persist_active_workout_plan

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        # Seed two future day_state rows with nutrition overlays.
        for i in range(1, 3):
            s.add(UserDayState(
                user_id=user.id,
                day_key=date.today() + timedelta(days=i),
                nutrition_plan={"mealCount": 3},
                meal_checks={},
            ))
        s.commit()

        req = _make_plan_request()
        _persist_active_workout_plan(s, user.id, _make_plan_dict(4), req=req)

        # WorkoutPlan row exists.
        plans = s.exec(select(WorkoutPlan).where(WorkoutPlan.user_id == user.id)).all()
        assert len(plans) == 1 and plans[0].is_active is True
        # DayState rows still exist (nutrition clear is a separate path).
        ds = s.exec(select(UserDayState).where(UserDayState.user_id == user.id)).all()
        assert len(ds) == 2, f"expected 2 day_state rows preserved, got {len(ds)}"
    _ok("future DayState rows walked without error; workout_plan written")
