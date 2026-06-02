"""Tests for the first-class `NutritionPlan` DB table + the
`_persist_active_nutrition_plan` helper. Mirror of
`test_workout_plan_persistence.py` — same shape, same guarantees:

  - A regen inserts a new `is_active=True` row and marks the previous
    active row `is_active=False` with a reason + timestamp.
  - `planner_version` is written from the shared constant so clients
    can detect staleness.
  - `plans_json` round-trips through JSON text cleanly (list of
    daily template dicts).
  - `GET /ai/plans/active-nutrition` returns the parsed plans + note.
  - Helper is a safe no-op when `db` or `user_id` is missing.

All tests run against an in-memory SQLite DB — no Docker required,
no HTTP, no external services.
"""
from __future__ import annotations

import json


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    """Fresh in-memory SQLite with every SQLModel table the test touches.

    Same shape as `test_workout_plan_persistence._make_mem_engine` — we
    explicitly skip `create_db_and_tables()` because it runs seed
    inserts + side-effects unrelated to this test."""
    from sqlmodel import SQLModel, create_engine

    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, NutritionPlan, PlanWeek, PlanDay,
    )

    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(
    session,
    *,
    email: str = "nutrition_persist@example.com",
    subscription_tier: str = "pro",
):
    from app.models import User
    u = User(
        email=email,
        username=email.split("@")[0],
        hashed_password="x",
        subscription_tier=subscription_tier,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_template(idx: int, calories: int = 2200) -> dict:
    """Minimal but realistic daily nutrition template shape."""
    return {
        "targets": {"calories": calories, "protein": 160, "carbs": 240, "fat": 65},
        "meals": [
            {"meal": "Breakfast", "calories": calories // 3, "protein": 50, "carbs": 80, "fat": 20},
            {"meal": "Lunch",     "calories": calories // 3, "protein": 55, "carbs": 80, "fat": 22},
            {"meal": "Dinner",    "calories": calories // 3, "protein": 55, "carbs": 80, "fat": 23},
        ],
        "template_index": idx,
    }


def _make_plan_request(**overrides):
    """Mirror `test_workout_plan_persistence._make_plan_request` so the
    tests stay focused on the persistence layer."""
    from app.routers.ai.models import PlanRequest
    base = dict(
        goal="muscle_gain",
        daysPerWeek=4,
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
    current `PLANNER_VERSION`. Goal + days_per_week come off the
    PlanRequest; `plans_json` is JSON-serialized text."""
    print("\n[test] _persist_active_nutrition_plan writes initial active row")
    from sqlmodel import Session, select

    from app.models import NutritionPlan
    from app.routers.ai.plans import _persist_active_nutrition_plan
    from app.services.workout.weekly_recipe import PLANNER_VERSION

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        req = _make_plan_request()
        templates = [_make_template(0), _make_template(1)]
        _persist_active_nutrition_plan(
            s, user.id, templates, req=req, trainer_note="test note", reason="regen",
        )

        rows = s.exec(
            select(NutritionPlan).where(NutritionPlan.user_id == user.id)
        ).all()
        assert len(rows) == 1, f"expected exactly 1 row, got {len(rows)}"
        row = rows[0]
        assert row.is_active is True
        assert row.planner_version == PLANNER_VERSION
        assert row.goal == "muscle_gain"
        assert row.days_per_week == 4
        assert row.trainer_note == "test note"
        # Round-trip through JSON text — templates survive intact.
        parsed = json.loads(row.plans_json)
        assert isinstance(parsed, list) and len(parsed) == 2
        assert parsed[0]["targets"]["calories"] == 2200
    _ok("initial write creates an active row stamped with PLANNER_VERSION")


def test_regen_deactivates_previous_and_inserts_new() -> None:
    """A second regen flips the prior active row → is_active=False with
    deactivated_at + deactivation_reason set, and inserts a fresh
    is_active=True row. At any time only ONE active row exists."""
    print("\n[test] regen deactivates prior active nutrition row + inserts new")
    from sqlmodel import Session, select

    from app.models import NutritionPlan
    from app.routers.ai.plans import _persist_active_nutrition_plan

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        req = _make_plan_request()
        _persist_active_nutrition_plan(
            s, user.id, [_make_template(0, 2000)], req=req, reason="regen",
        )
        _persist_active_nutrition_plan(
            s, user.id, [_make_template(0, 2800), _make_template(1, 2800)],
            req=req, reason="regen",
        )

        rows = s.exec(
            select(NutritionPlan).where(NutritionPlan.user_id == user.id)
        ).all()
        assert len(rows) == 2, f"expected 2 rows after regen, got {len(rows)}"
        actives = [r for r in rows if r.is_active]
        inactives = [r for r in rows if not r.is_active]
        assert len(actives) == 1, f"expected exactly 1 active row, got {len(actives)}"
        assert len(inactives) == 1
        inactive = inactives[0]
        assert inactive.deactivated_at is not None
        assert inactive.deactivation_reason == "regen"
        # The surviving active row is the SECOND write (2800 cal, 2 templates).
        parsed = json.loads(actives[0].plans_json)
        assert len(parsed) == 2
        assert parsed[0]["targets"]["calories"] == 2800
    _ok("regen flips is_active and stamps reason + timestamp")


def test_persist_no_op_when_db_or_user_missing() -> None:
    """Legacy callers that don't thread db/user_id through the
    generator must not crash. Same contract as the workout helper."""
    print("\n[test] _persist_active_nutrition_plan no-op on missing inputs")
    from app.routers.ai.plans import _persist_active_nutrition_plan

    req = _make_plan_request()
    _persist_active_nutrition_plan(None, 1, [_make_template(0)], req=req)
    _persist_active_nutrition_plan(object(), None, [_make_template(0)], req=req)  # noqa
    _ok("helper is a safe no-op when db or user_id is None")


def test_food_quality_hydration_fills_generated_items() -> None:
    """Generated meal items should carry the same metadata fields the
    NutritionCard uses for whole/processed labels and protein tiles."""
    print("\n[test] generated nutrition items get food-quality metadata")
    from app.routers.ai import plans as plans_mod
    from app.services.nutrition import ai_classify as ai_mod

    class _Meta:
        def __init__(self, bucket: str, protein: str, plant_count: int) -> None:
            self.processing_bucket = bucket
            self.protein_source = protein
            self.plant_count_value = plant_count
            self.fermented_flag = False
            self.probiotic_flag = False
            self.omega3_flag = False
            self.seafood_flag = False
            self.fruit_flag = False
            self.vegetable_flag = False
            self.alcohol_flag = False
            self.processed_meat_flag = False
            self.refined_grain_flag = False

    calls: list[tuple[str, bool]] = []

    def _fake_get_or_create_metadata(raw_name, db, *, allow_ai=True, **kwargs):
        calls.append((raw_name, allow_ai))
        if "oat" in raw_name.lower():
            return _Meta("minimally_processed", "plant", 1)
        return _Meta("processed", "animal", 0)

    orig = ai_mod.get_or_create_metadata
    ai_mod.get_or_create_metadata = _fake_get_or_create_metadata
    try:
        templates = [{
            "meals": [{
                "meal": "Breakfast",
                "items": [
                    {"name": "Plain oats"},
                    {"name": "Chicken breast", "protein_source": "animal"},
                ],
            }],
        }]
        changed = plans_mod._hydrate_food_quality_fields(templates, object(), allow_ai=True)
        assert changed is True
        oats = templates[0]["meals"][0]["items"][0]
        chicken = templates[0]["meals"][0]["items"][1]
        assert oats["processing_bucket"] == "minimally_processed"
        assert oats["food_quality"] == "whole"
        assert oats["protein_source"] == "plant"
        assert oats["plant_count"] == 1
        assert chicken["processing_bucket"] == "processed"
        assert chicken["food_quality"] == "processed"
        assert ("Plain oats", True) in calls
        assert ("Chicken breast", True) in calls
    finally:
        ai_mod.get_or_create_metadata = orig
    _ok("hydration adds whole/processed labels to generated items")


def test_active_week_nutrition_quality_hydration_updates_plan_days() -> None:
    """Existing PlanDay nutrition copies can be lazily filled without
    regenerating the active week."""
    print("\n[test] active PlanDay nutrition gets food-quality metadata")
    from datetime import date, timedelta
    from sqlmodel import Session, select

    from app.models import PlanDay, PlanWeek
    from app.routers.ai import plans as plans_mod
    from app.services.nutrition import ai_classify as ai_mod
    from app.services.workout.weekly_recipe import PLANNER_VERSION

    class _Meta:
        processing_bucket = "minimally_processed"
        protein_source = "plant"
        plant_count_value = 1
        fermented_flag = False
        probiotic_flag = False
        omega3_flag = False
        seafood_flag = False
        fruit_flag = False
        vegetable_flag = False
        alcohol_flag = False
        processed_meat_flag = False
        refined_grain_flag = False

    calls: list[tuple[str, bool]] = []

    def _fake_get_or_create_metadata(raw_name, db, *, allow_ai=True, **kwargs):
        calls.append((raw_name, allow_ai))
        return _Meta()

    orig = ai_mod.get_or_create_metadata
    ai_mod.get_or_create_metadata = _fake_get_or_create_metadata
    try:
        engine = _make_mem_engine()
        with Session(engine) as s:
            user = _insert_user(s)
            start = date.today()
            week = PlanWeek(
                user_id=user.id,
                start_date=start,
                end_date=start + timedelta(days=6),
                planner_version=PLANNER_VERSION,
                goal="recomp",
                days_per_week=4,
                status="active",
            )
            s.add(week)
            s.commit()
            s.refresh(week)
            day = PlanDay(
                plan_week_id=week.id,
                user_id=user.id,
                day_date=start,
                day_index=0,
                status="planned",
                nutrition_json={
                    "meals": [{
                        "meal": "Breakfast",
                        "items": [{"name": "Plain oats"}],
                    }],
                },
            )
            s.add(day)
            s.commit()

            updated = plans_mod._hydrate_active_week_nutrition_quality_fields(
                s, user.id, allow_ai=False,
            )
            assert updated == 1
            saved = s.exec(select(PlanDay).where(PlanDay.id == day.id)).first()
            item = saved.nutrition_json["meals"][0]["items"][0]
            assert item["processing_bucket"] == "minimally_processed"
            assert item["food_quality"] == "whole"
            assert item["plant_count"] == 1
            assert ("Plain oats", False) in calls
    finally:
        ai_mod.get_or_create_metadata = orig
    _ok("active week day copies are filled from cached metadata")


# ── Endpoint smoke test (uses FastAPI TestClient against the mem DB) ──


def test_active_nutrition_endpoint_returns_plan() -> None:
    """`GET /ai/plans/active-nutrition` returns the serialized active
    row with `plans_json` parsed back into a list."""
    print("\n[test] GET /ai/plans/active-nutrition returns active plans_json")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.ai.plans import _persist_active_nutrition_plan
    from app.routers.ai.router import router as ai_router

    engine = _make_mem_engine()
    orig_engine = app_db.engine
    app_db.engine = engine
    try:
        with Session(engine) as s:
            user = _insert_user(s)
            user_id = user.id
            req = _make_plan_request()
            templates = [_make_template(0, 2400), _make_template(1, 2400)]
            _persist_active_nutrition_plan(
                s, user_id, templates, req=req, trainer_note="ate clean"
            )

        def _session_override():
            with Session(engine) as s:
                yield s

        def _user_override():
            with Session(engine) as s:
                u = s.get(User, user_id)
                if u is not None:
                    _ = (u.id, u.email, u.username, u.hashed_password,
                         u.subscription_tier,
                         u.is_active, u.created_at,
                         u.recovery_question, u.recovery_answer_hash)
                    s.expunge(u)
                return u

        app = FastAPI()
        app.include_router(ai_router)
        app.dependency_overrides[get_session] = _session_override
        app.dependency_overrides[get_current_user] = _user_override

        client = TestClient(app)
        resp = client.get("/ai/plans/active-nutrition")
        assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body.get("planner_version"), "missing planner_version"
        assert body.get("goal") == "muscle_gain"
        assert body.get("days_per_week") == 4
        assert body.get("trainer_note") == "ate clean"
        assert isinstance(body.get("plans_json"), list)
        assert len(body["plans_json"]) == 2
        assert body["plans_json"][0]["targets"]["calories"] == 2400
    finally:
        app_db.engine = orig_engine
    _ok("endpoint serializes the active row with parsed plans_json")


def test_active_nutrition_endpoint_404_when_no_plan() -> None:
    """Brand-new user → no active NutritionPlan row → 404."""
    print("\n[test] GET /ai/plans/active-nutrition 404s without an active row")
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
            with Session(engine) as s:
                u = s.get(User, user_id)
                if u is not None:
                    _ = (u.id, u.email, u.username, u.hashed_password,
                         u.subscription_tier,
                         u.is_active, u.created_at,
                         u.recovery_question, u.recovery_answer_hash)
                    s.expunge(u)
                return u

        app = FastAPI()
        app.include_router(ai_router)
        app.dependency_overrides[get_session] = _session_override
        app.dependency_overrides[get_current_user] = _user_override

        client = TestClient(app)
        resp = client.get("/ai/plans/active-nutrition")
        assert resp.status_code == 404, f"expected 404, got {resp.status_code}: {resp.text}"
    finally:
        app_db.engine = orig_engine
    _ok("404 when the user has never generated a nutrition plan")


def test_active_nutrition_endpoint_403_for_free_user() -> None:
    """Free users cannot read generated nutrition-plan artifacts."""
    print("\n[test] GET /ai/plans/active-nutrition 403s for free users")
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
            user = _insert_user(s, subscription_tier="free")
            user_id = user.id

        def _session_override():
            with Session(engine) as s:
                yield s

        def _user_override():
            with Session(engine) as s:
                u = s.get(User, user_id)
                if u is not None:
                    _ = (u.id, u.email, u.username, u.hashed_password,
                         u.subscription_tier,
                         u.is_active, u.created_at,
                         u.recovery_question, u.recovery_answer_hash)
                    s.expunge(u)
                return u

        app = FastAPI()
        app.include_router(ai_router)
        app.dependency_overrides[get_session] = _session_override
        app.dependency_overrides[get_current_user] = _user_override

        client = TestClient(app)
        resp = client.get("/ai/plans/active-nutrition")
        assert resp.status_code == 403, f"expected 403, got {resp.status_code}: {resp.text}"
        assert "Thallo Pro" in resp.json().get("detail", "")
    finally:
        app_db.engine = orig_engine
    _ok("free users are blocked before active nutrition lookup")


def test_planner_version_stamped_on_new_templates_matches_active_row() -> None:
    """The write path stamps every template dict with the current
    `PLANNER_VERSION` so clients can version-check without a round trip
    to the DB. Here we just verify that stamping the templates before
    persisting preserves the value through JSON round-trip, and that
    the row's `planner_version` matches the constant."""
    print("\n[test] nutrition planner_version round-trips through JSON + row")
    from sqlmodel import Session, select

    from app.models import NutritionPlan
    from app.routers.ai.plans import _persist_active_nutrition_plan
    from app.services.workout.weekly_recipe import PLANNER_VERSION

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        req = _make_plan_request()
        t0 = _make_template(0)
        t1 = _make_template(1)
        # Stamp templates the way the real write path does.
        t0["_plannerVersion"] = PLANNER_VERSION
        t1["_plannerVersion"] = PLANNER_VERSION
        _persist_active_nutrition_plan(s, user.id, [t0, t1], req=req)

        row = s.exec(
            select(NutritionPlan)
            .where(NutritionPlan.user_id == user.id)
            .where(NutritionPlan.is_active == True)  # noqa: E712
        ).first()
        assert row is not None
        assert row.planner_version == PLANNER_VERSION
        parsed = json.loads(row.plans_json)
        assert all(t.get("_plannerVersion") == PLANNER_VERSION for t in parsed)
    _ok("planner_version stamped on templates + row")
