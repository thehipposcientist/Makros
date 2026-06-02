"""Tests for Pro-only manual mode (workout_manual_mode + meal_manual_mode).

Covers:
  - Toggle endpoint Pro-gating (free → 403, pro → 200).
  - Mid-week flip wipes future un-done days only; done days untouched.
  - use-template snapshots a WorkoutTemplate's workout_json into a PlanDay.
  - generate-workout snapshots a deterministic focus/stimulus day into a PlanDay.
  - clear endpoint reverts a day back to status='unassigned'.
  - mark-rest sets is_rest=True without a workout payload.
  - auto_renew_week creates an empty week (status='unassigned' x7) when
    the user is in workout_manual_mode.

Same in-memory SQLite + TestClient pattern as test_workout_templates.py.
"""
from __future__ import annotations

from datetime import date, timedelta


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401  — register tables
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutCompletion, WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, WorkoutTemplate, PlanWeek, PlanDay,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, username: str, tier: str = "pro") -> int:
    from app.models import User
    u = User(
        email=f"{username}@example.com",
        username=username,
        hashed_password="x",
        subscription_tier=tier,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return int(u.id)


def _make_test_app(engine, user_id_holder: dict):
    from fastapi import FastAPI
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.manual_mode import router as mm_router
    from app.routers.workout_templates import router as templates_router

    app_db.engine = engine

    def _session_override():
        with Session(engine) as s:
            yield s

    def _user_override():
        with Session(engine) as s:
            u = s.get(User, user_id_holder["id"])
            if u is not None:
                _ = (u.id, u.email, u.username, u.hashed_password,
                     u.subscription_tier, u.is_active, u.created_at)
                s.expunge(u)
            return u

    app = FastAPI()
    app.include_router(mm_router)
    app.include_router(templates_router)
    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_user] = _user_override
    return app


def _client(engine, holder):
    from fastapi.testclient import TestClient
    return TestClient(_make_test_app(engine, holder))


def _seed_active_week(session, user_id: int, *, today: date | None = None):
    """Create an active PlanWeek with 7 PlanDays — day 0 = today, days
    -2 and -1 already 'completed' (in the past), days 1..4 still planned.
    Returns (plan_week_id, day_dates list)."""
    from app.models import PlanDay, PlanWeek
    today = today or date.today()
    start = today - timedelta(days=2)
    pw = PlanWeek(
        user_id=user_id,
        start_date=start,
        end_date=start + timedelta(days=6),
        planner_version="test",
        goal="general_fitness",
        days_per_week=4,
        preferred_split="full_body",
        status="active",
    )
    session.add(pw)
    session.commit()
    session.refresh(pw)
    dates = []
    for i in range(7):
        d = start + timedelta(days=i)
        dates.append(d)
        # Past two days: completed and locked. Day 0 (today): planned.
        # Future days: planned.
        if i < 2:
            status = "completed"
            locked = True
            lock_reason = "completed"
        else:
            status = "planned"
            locked = False
            lock_reason = None
        session.add(PlanDay(
            plan_week_id=pw.id,
            user_id=user_id,
            day_date=d,
            day_index=i,
            status=status,
            is_rest=False,
            workout_json={"focus": "Day", "exercises": [{"name": "Bench"}]},
            locked=locked,
            lock_reason=lock_reason,
            generation_source="initial",
        ))
    session.commit()
    return pw.id, dates


def _create_template(client, *, tpl_id: str, name: str = "Push") -> str:
    r = client.post("/workouts/templates", json={
        "id": tpl_id, "name": name,
        "workout": {"focus": "Push", "exercises": [{"name": "Bench Press"}]},
    })
    assert r.status_code == 201, r.text
    return tpl_id


# ─── Tests ───────────────────────────────────────────────────────────────────

def test_toggle_requires_pro():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        free_id = _insert_user(s, username="free", tier="free")
    client = _client(engine, {"id": free_id})

    r = client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})
    assert r.status_code == 403, r.text
    assert "Pro" in r.json()["detail"]
    _ok("free user gets 403 from manual-mode toggle")


def test_toggle_accepts_pro_and_sets_flag():
    from sqlmodel import Session
    from app.models import UserPreferences
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="pro1", tier="pro")
    client = _client(engine, {"id": pro_id})

    r = client.post("/profile/preferences/manual-mode",
                    json={"workout_manual_mode": True, "meal_manual_mode": True})
    assert r.status_code == 200, r.text
    assert r.json()["workout_manual_mode"] is True
    assert r.json()["meal_manual_mode"] is True

    with Session(engine) as s:
        prefs = s.exec(
            __import__("sqlmodel").select(UserPreferences)
            .where(UserPreferences.user_id == pro_id)
        ).first()
        assert prefs and prefs.workout_manual_mode is True
        assert prefs.meal_manual_mode is True
    _ok("pro toggle persists both flags")


def test_workout_flip_on_wipes_future_undone_days_only():
    from sqlmodel import Session, select
    from app.models import PlanDay
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="pro2", tier="pro")
        pw_id, dates = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})

    r = client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})
    assert r.status_code == 200, r.text
    # 5 future un-done days (today + 4) cleared; 2 completed past days untouched.
    assert r.json()["future_days_cleared"] == 5

    with Session(engine) as s:
        days = s.exec(
            select(PlanDay).where(PlanDay.plan_week_id == pw_id)
            .order_by(PlanDay.day_index)
        ).all()
        assert [d.status for d in days[:2]] == ["completed", "completed"], "past days untouched"
        assert all(d.workout_json is not None for d in days[:2]), "past workout payloads preserved"
        assert all(d.status == "unassigned" for d in days[2:]), "future days cleared"
        assert all(d.workout_json is None for d in days[2:]), "future payloads wiped"
        assert all(d.is_rest is False for d in days[2:]), "future not auto-rest"

    # Idempotent — second flip-on doesn't re-clear (already on).
    r2 = client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})
    assert r2.json()["future_days_cleared"] == 0, "re-flip is a no-op"
    _ok("flip-on wipes future un-done days; past days preserved; idempotent")


def test_use_template_snapshots_workout_into_day():
    from sqlmodel import Session, select
    from app.models import PlanDay
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="pro3", tier="pro")
        pw_id, dates = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})
    client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})
    _create_template(client, tpl_id="tpl-push")

    r = client.post(
        f"/plan-weeks/{pw_id}/days/3/use-template",
        json={"template_id": "tpl-push"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "edited"
    assert body["locked"] is True
    assert body["lock_reason"] == "manual_edit"
    assert body["generation_source"] == "manual"
    assert body["workout_json"]["focus"] == "Push"

    # Editing the source template should NOT mutate the snapshotted day
    # (this is the "copy on assign" guarantee).
    client.put("/workouts/templates/tpl-push", json={
        "id": "tpl-push", "name": "Renamed",
        "workout": {"focus": "TOTALLY DIFFERENT", "exercises": []},
    })
    with Session(engine) as s:
        pd = s.exec(
            select(PlanDay).where(PlanDay.plan_week_id == pw_id, PlanDay.day_index == 3)
        ).first()
        assert pd.workout_json["focus"] == "Push", "snapshot not mutated by template edit"
    _ok("use-template snapshots payload + copy-on-assign holds")


def test_use_template_blocked_on_completed_day():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="pro4", tier="pro")
        pw_id, _ = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})
    client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})
    _create_template(client, tpl_id="tpl-x")

    r = client.post(f"/plan-weeks/{pw_id}/days/0/use-template",
                    json={"template_id": "tpl-x"})
    # Day 0 is "completed" in the seed.
    assert r.status_code == 409, r.text
    assert "completed" in r.json()["detail"]
    _ok("can't reassign a completed day")


def test_generate_workout_snapshots_generated_day():
    from sqlmodel import Session, select
    from app.models import PlanDay, UserPreferences
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="progen", tier="pro")
        pw_id, _ = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})
    client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})

    with Session(engine) as s:
        prefs = s.exec(select(UserPreferences).where(UserPreferences.user_id == pro_id)).first()
        assert prefs is not None
        prefs.days_per_week = 4
        prefs.workout_duration_minutes = 45
        prefs.preferred_split = "ppl"
        prefs.experience_level = "intermediate"
        prefs.equipment = [
            "dumbbells", "barbell", "flat_bench", "pull_up_bar",
            "cable_machine", "lat_pulldown_machine", "seated_row_machine",
        ]
        s.add(prefs)
        s.commit()

    r = client.post(
        f"/plan-weeks/{pw_id}/days/3/generate-workout",
        json={"focus": "pull", "stimulus": "heavy", "session_minutes": 45},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "edited"
    assert body["locked"] is True
    assert body["lock_reason"] == "manual_edit"
    assert body["generation_source"] == "manual_generated"
    assert body["workout_json"]["focus"] == "Pull"
    assert body["workout_json"]["stimulus"] == "strength"
    assert len(body["workout_json"]["exercises"]) > 0

    with Session(engine) as s:
        pd = s.exec(
            select(PlanDay).where(PlanDay.plan_week_id == pw_id, PlanDay.day_index == 3)
        ).first()
        assert pd.workout_json["focus"] == "Pull"
        assert pd.generation_source == "manual_generated"
    _ok("generate-workout snapshots focused deterministic day")


def test_clear_day_reverts_to_unassigned():
    from sqlmodel import Session, select
    from app.models import PlanDay
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="pro5", tier="pro")
        pw_id, _ = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})
    client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})
    _create_template(client, tpl_id="tpl-clear")
    client.post(f"/plan-weeks/{pw_id}/days/4/use-template",
                json={"template_id": "tpl-clear"})

    r = client.post(f"/plan-weeks/{pw_id}/days/4/clear")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "unassigned"
    assert r.json()["workout_json"] is None
    assert r.json()["locked"] is False
    _ok("clear reverts assigned day to unassigned")


def test_mark_rest_locks_day_without_workout():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="pro6", tier="pro")
        pw_id, _ = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})
    client.post("/profile/preferences/manual-mode", json={"workout_manual_mode": True})

    r = client.post(f"/plan-weeks/{pw_id}/days/5/mark-rest", json={"is_rest": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_rest"] is True
    assert body["workout_json"] is None
    assert body["locked"] is True
    assert body["lock_reason"] == "manual_edit"
    _ok("mark-rest locks day without workout payload")


def test_auto_renew_in_manual_mode_creates_empty_week():
    """When the active week expires and the user is in manual mode,
    auto_renew_week should NOT run the planner — instead spawn a fresh
    week with 7 unassigned days the user will assemble."""
    from sqlmodel import Session, select
    from app.models import PlanDay, PlanWeek, UserPreferences
    from app.services.workout.week_manager import auto_renew_week
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="renew", tier="pro")
        # Active week that EXPIRED yesterday
        from app.models import PlanDay as PD
        from app.models import PlanWeek as PW
        old_start = date.today() - timedelta(days=10)
        old_pw = PW(
            user_id=pro_id,
            start_date=old_start,
            end_date=old_start + timedelta(days=6),
            planner_version="test",
            goal="general_fitness",
            days_per_week=4,
            preferred_split="full_body",
            status="active",
        )
        s.add(old_pw)
        s.commit()
        s.refresh(old_pw)
        for i in range(7):
            d = old_start + timedelta(days=i)
            s.add(PD(
                plan_week_id=old_pw.id,
                user_id=pro_id,
                day_date=d, day_index=i,
                status="completed", is_rest=False,
                workout_json={"focus": "X"}, locked=True,
                generation_source="initial",
            ))
        # Mark the user as manual mode
        prefs = UserPreferences(user_id=pro_id, workout_manual_mode=True)
        s.add(prefs)
        s.commit()

    with Session(engine) as s:
        result = auto_renew_week(s, pro_id)

    assert result.get("manual_mode") is True, result
    assert "Manual mode" in result["review_headline"]

    with Session(engine) as s:
        active = s.exec(
            select(PlanWeek)
            .where(PlanWeek.user_id == pro_id)
            .where(PlanWeek.status == "active")
        ).first()
        assert active is not None
        days = s.exec(
            select(PlanDay).where(PlanDay.plan_week_id == active.id)
            .order_by(PlanDay.day_index)
        ).all()
        assert len(days) == 7
        assert all(d.status == "unassigned" for d in days)
        assert all(d.workout_json is None for d in days)
        assert all(d.is_rest is False for d in days)
        assert all(d.generation_source == "manual" for d in days)
    _ok("auto_renew_week in manual mode spawns 7 unassigned days")


def test_direct_saved_template_completion_fills_unassigned_manual_day():
    from sqlmodel import Session, select
    from app.models import PlanDay, User, UserPreferences, WorkoutCompletion
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete
    from app.services.workout.plan_review_v2 import compute_weekly_review
    engine = _make_mem_engine()
    today = date.today()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="directtpl", tier="pro")
        pw_id, dates = _seed_active_week(s, pro_id, today=today)
        target_date = dates[2]
        day = s.exec(
            select(PlanDay).where(
                PlanDay.plan_week_id == pw_id,
                PlanDay.day_date == target_date,
            )
        ).first()
        assert day is not None
        day.status = "unassigned"
        day.workout_json = None
        day.locked = False
        day.lock_reason = None
        day.generation_source = "manual"
        s.add(day)
        s.add(UserPreferences(user_id=pro_id, workout_manual_mode=True))
        s.commit()

        user = s.get(User, pro_id)
        assert user is not None
        body = WorkoutCompleteRequest(
            workout_date=target_date,
            focus_label="Push",
            duration_seconds=1800,
            stimulus="hypertrophy",
            source_context="saved_template",
            template_id="tpl-push",
            exercises=[{
                "name": "Barbell Bench Press",
                "slug": "barbell-bench-press",
                "target_sets": 3,
                "target_reps": "8-10",
                "equipment": "barbell",
                "primary_muscle": "chest",
                "secondary_muscles": ["triceps", "shoulders"],
                "is_compound": True,
                "movement_pattern": "horizontal_push",
                "sets": [{"set_number": 1, "reps": 8, "weight_lbs": 135}],
            }],
        )
        mark_workout_complete(body, current_user=user, db=s)
        s.expire_all()

        day = s.exec(
            select(PlanDay).where(
                PlanDay.plan_week_id == pw_id,
                PlanDay.day_date == target_date,
            )
        ).first()
        assert day is not None
        assert day.status == "completed"
        assert day.lock_reason == "completed"
        assert day.workout_json["focus"] == "Push"
        assert day.workout_json["plan_day_id"] == day.id
        assert day.workout_json["planDayId"] == day.id
        assert day.workout_json["_source_context"] == "saved_template"
        assert day.workout_json["_template_id"] == "tpl-push"
        assert day.workout_json["exercises"][0]["targetSets"] == 3

        completion = s.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == pro_id)
            .where(WorkoutCompletion.workout_date == target_date)
        ).first()
        assert completion is not None
        assert completion.plan_day_id == day.id

        review = compute_weekly_review(s, pro_id, end_date=target_date, days=1)
        assert review.sessions_planned == 1
        assert review.sessions_completed == 1
    _ok("direct saved-template completion fills the unassigned manual day")


def test_imported_activity_does_not_fill_unassigned_manual_day():
    from sqlmodel import Session, select
    from app.models import PlanDay, User, UserPreferences, WorkoutCompletion
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete
    from app.services.workout.plan_review_v2 import compute_weekly_review
    engine = _make_mem_engine()
    today = date.today()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="directimport", tier="pro")
        pw_id, dates = _seed_active_week(s, pro_id, today=today)
        target_date = dates[2]
        day = s.exec(
            select(PlanDay).where(
                PlanDay.plan_week_id == pw_id,
                PlanDay.day_date == target_date,
            )
        ).first()
        assert day is not None
        day.status = "unassigned"
        day.workout_json = None
        day.locked = False
        day.lock_reason = None
        day.generation_source = "manual"
        s.add(day)
        s.add(UserPreferences(user_id=pro_id, workout_manual_mode=True))
        s.commit()

        user = s.get(User, pro_id)
        assert user is not None
        body = WorkoutCompleteRequest(
            workout_date=target_date,
            focus_label="Outdoor Walk",
            duration_seconds=1800,
            source_context="apple_health",
            activity_category="cardio",
            activity_subtype="walk",
            activity_source="apple_health",
        )
        mark_workout_complete(body, current_user=user, db=s)
        s.expire_all()

        day = s.exec(
            select(PlanDay).where(
                PlanDay.plan_week_id == pw_id,
                PlanDay.day_date == target_date,
            )
        ).first()
        assert day is not None
        assert day.status == "unassigned"
        assert day.workout_json is None
        assert day.locked is False

        completion = s.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == pro_id)
            .where(WorkoutCompletion.workout_date == target_date)
        ).first()
        assert completion is not None
        assert completion.plan_day_id is None

        review = compute_weekly_review(s, pro_id, end_date=target_date, days=1)
        assert review.sessions_planned == 0
        assert review.sessions_completed == 0
    _ok("imported activity remains extra history in manual mode")


def test_meal_flag_does_not_wipe_workout_days():
    """Toggling meal_manual_mode alone must not touch workout PlanDays."""
    from sqlmodel import Session, select
    from app.models import PlanDay
    engine = _make_mem_engine()
    with Session(engine) as s:
        pro_id = _insert_user(s, username="meals", tier="pro")
        pw_id, _ = _seed_active_week(s, pro_id)
    client = _client(engine, {"id": pro_id})

    r = client.post("/profile/preferences/manual-mode", json={"meal_manual_mode": True})
    assert r.status_code == 200, r.text
    assert r.json()["meal_manual_mode"] is True
    assert r.json()["future_days_cleared"] == 0

    with Session(engine) as s:
        days = s.exec(
            select(PlanDay).where(PlanDay.plan_week_id == pw_id)
        ).all()
        assert all(d.status in ("planned", "completed") for d in days), \
            "meal flip must not touch workout days"
    _ok("meal flag is independent — doesn't touch workout days")


cases = [
    test_toggle_requires_pro,
    test_toggle_accepts_pro_and_sets_flag,
    test_workout_flip_on_wipes_future_undone_days_only,
    test_use_template_snapshots_workout_into_day,
    test_use_template_blocked_on_completed_day,
    test_generate_workout_snapshots_generated_day,
    test_clear_day_reverts_to_unassigned,
    test_mark_rest_locks_day_without_workout,
    test_auto_renew_in_manual_mode_creates_empty_week,
    test_direct_saved_template_completion_fills_unassigned_manual_day,
    test_imported_activity_does_not_fill_unassigned_manual_day,
    test_meal_flag_does_not_wipe_workout_days,
]
