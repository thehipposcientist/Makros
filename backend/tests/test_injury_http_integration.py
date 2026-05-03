"""HTTP integration tests for injury-aware workout generation.

These tests exercise the real FastAPI routes with TestClient, then verify
both the response payload and persisted DB rows do not include movements that
should be blocked by the user's active injuries.
"""
from __future__ import annotations


_FULL_GYM = [
    "barbell", "dumbbells", "weight_plates", "power_rack", "squat_rack",
    "flat_bench", "adjustable_bench", "cable_machine", "lat_pulldown",
    "pull_up_bar", "dip_bars", "leg_press", "smith_machine",
    "kettlebell", "trap_bar", "rowing_machine", "treadmill",
    "stationary_bike", "stair_climber", "assault_bike",
    "leg_curl_machine", "leg_extension_machine", "calf_raise_machine",
    "seated_row_machine", "chest_press_machine", "shoulder_press_machine",
    "ez_curl_bar",
]


_INJURY_CASES = [
    (
        "shoulder",
        ["shoulder"],
        {"horizontal_press", "vertical_press"},
    ),
    (
        "phone-style knee phrase",
        ["left knee pain (knee, status: active) muscles: quads severity: moderate"],
        {"squat", "lunge"},
    ),
    (
        "lower back phrase",
        ["tweaked lower back (lower_back, status: active) severity: moderate"],
        {"hinge"},
    ),
    (
        "combined upper/lower/back injuries",
        [
            "shoulder",
            "left knee pain (knee, status: active) muscles: quads severity: moderate",
            "tweaked lower back (lower_back, status: active) severity: moderate",
        ],
        {"horizontal_press", "vertical_press", "squat", "lunge", "hinge"},
    ),
]


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    import app.models  # noqa: F401 - register all SQLModel tables

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, email: str = "injury_http@example.com"):
    from app.models import User

    user = User(
        email=email,
        username=email.split("@")[0],
        hashed_password="x",
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _make_test_app(engine, user_id: int):
    from fastapi import FastAPI
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.plan_weeks import router as plan_weeks_router
    from app.routers.workouts import router as workouts_router

    app_db.engine = engine

    def _session_override():
        with Session(engine) as s:
            yield s

    def _user_override():
        with Session(engine) as s:
            user = s.get(User, user_id)
            if user is not None:
                _ = (
                    user.id, user.email, user.username, user.hashed_password,
                    user.subscription_tier, user.is_active, user.created_at,
                    user.recovery_question, user.recovery_answer_hash,
                )
                s.expunge(user)
            return user

    app = FastAPI()
    app.include_router(workouts_router)
    app.include_router(plan_weeks_router)
    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_user] = _user_override
    return app


def _seed_movement_by_slug() -> dict[str, str]:
    from app.seed_exercises_data import SEED_EXERCISES

    return {
        str(ex.get("slug")): str(ex.get("movement_pattern") or "")
        for ex in SEED_EXERCISES
        if ex.get("slug")
    }


def _iter_exercises(days: list[dict]):
    for day in days:
        workout = day.get("workout") if "workout" in day else day
        if not workout:
            continue
        for ex in workout.get("exercises") or []:
            yield day, ex


def _blocked_movement_leaks(days: list[dict], blocked: set[str]) -> list[str]:
    movement_by_slug = _seed_movement_by_slug()
    leaks: list[str] = []
    for day, ex in _iter_exercises(days):
        slug = ex.get("_slug")
        movement = (
            ex.get("movement_pattern")
            or ex.get("_movement_pattern")
            or movement_by_slug.get(slug)
        )
        if movement in blocked:
            focus = (day.get("workout") or day).get("focus")
            leaks.append(f"{focus}: {ex.get('name')} ({movement})")
    return leaks


def _exercise_count(days: list[dict]) -> int:
    return sum(1 for _day, _ex in _iter_exercises(days))


def _generate_week_body(injuries: list[str]) -> dict:
    return {
        "goal": "muscle_gain",
        "days_per_week": 5,
        "session_minutes": 60,
        "experience": "intermediate",
        "equipment": list(_FULL_GYM),
        "preferred_split": "ppl",
        "priority_region": "balanced",
        "injuries": injuries,
        "disliked_exercises": [],
    }


def _active_workout_plan_days(engine, user_id: int) -> list[dict]:
    from sqlmodel import Session, select

    from app.models import WorkoutPlan

    with Session(engine) as session:
        rows = session.exec(
            select(WorkoutPlan).where(
                WorkoutPlan.user_id == user_id,
                WorkoutPlan.is_active == True,  # noqa: E712
            )
        ).all()
    assert len(rows) == 1, f"expected one active WorkoutPlan, got {len(rows)}"
    return rows[0].plan_json.get("days") or []


def _active_plan_day_payloads(engine, user_id: int) -> list[dict]:
    from sqlmodel import Session, select

    from app.models import PlanDay, PlanWeek

    with Session(engine) as session:
        week = session.exec(
            select(PlanWeek).where(
                PlanWeek.user_id == user_id,
                PlanWeek.status == "active",
            )
        ).first()
        assert week is not None, "expected active PlanWeek"
        rows = session.exec(
            select(PlanDay).where(PlanDay.plan_week_id == week.id)
        ).all()
    rows = sorted(rows, key=lambda row: row.day_index)
    return [
        {"workout": row.workout_json, "day_index": row.day_index}
        for row in rows
    ]


def _insert_onboarding(session, user_id: int, injuries: list[str]) -> None:
    from app.enums import Gender, GoalPace, GoalType
    from app.models import UserGoal, UserPreferences, UserProfile

    session.add(UserProfile(
        user_id=user_id,
        weight_lbs=185,
        height_feet=5,
        height_inches=11,
        age=32,
        gender=Gender.MALE,
    ))
    session.add(UserGoal(
        user_id=user_id,
        goal_type=GoalType.MUSCLE_GAIN,
        goal_track="muscle_gain",
        pace=GoalPace.MODERATE,
        is_active=True,
    ))
    session.add(UserPreferences(
        user_id=user_id,
        days_per_week=5,
        workout_duration_minutes=60,
        equipment=list(_FULL_GYM),
        injuries=list(injuries),
    ))
    session.commit()


def test_generate_week_http_blocks_multiple_injury_patterns_and_persists() -> None:
    print("\n[test] HTTP /workouts/generate-week blocks multiple injury patterns")
    from fastapi.testclient import TestClient
    from sqlmodel import Session

    engine = _make_mem_engine()
    with Session(engine) as session:
        user = _insert_user(session)
        user_id = user.id
    client = TestClient(_make_test_app(engine, user_id))

    for label, injuries, blocked in _INJURY_CASES:
        response = client.post("/workouts/generate-week", json=_generate_week_body(injuries))
        assert response.status_code == 200, (
            f"{label}: HTTP {response.status_code}: {response.text[:300]}"
        )
        days = response.json().get("days") or []
        assert len(days) == 5, f"{label}: expected 5 generated days, got {len(days)}"
        assert _exercise_count(days) > 0, f"{label}: generated no exercises"

        leaks = _blocked_movement_leaks(days, blocked)
        assert not leaks, f"{label}: blocked movements leaked in response: {leaks}"

        persisted_days = _active_workout_plan_days(engine, user_id)
        persisted_leaks = _blocked_movement_leaks(persisted_days, blocked)
        assert not persisted_leaks, (
            f"{label}: blocked movements leaked in persisted WorkoutPlan: {persisted_leaks}"
        )

    _ok("generate-week HTTP response + WorkoutPlan persistence honor injuries")


def test_start_new_week_http_uses_stored_injuries_for_plan_days() -> None:
    print("\n[test] HTTP /plans/start-new-week uses stored injuries for PlanDay rows")
    from fastapi.testclient import TestClient
    from sqlmodel import Session

    _, injuries, blocked = _INJURY_CASES[-1]
    engine = _make_mem_engine()
    with Session(engine) as session:
        user = _insert_user(session, email="injury_planweek@example.com")
        user_id = user.id
        _insert_onboarding(session, user_id, injuries)

    client = TestClient(_make_test_app(engine, user_id))
    response = client.post("/plans/start-new-week", json={"force": True})
    assert response.status_code == 200, (
        f"HTTP {response.status_code}: {response.text[:300]}"
    )
    response_days = response.json().get("days") or []
    assert len(response_days) == 7, f"expected 7 PlanDay responses, got {len(response_days)}"
    assert _exercise_count(response_days) > 0, "generated PlanWeek has no planned exercises"

    response_leaks = _blocked_movement_leaks(response_days, blocked)
    assert not response_leaks, (
        f"blocked movements leaked in PlanWeek response: {response_leaks}"
    )

    persisted_days = _active_plan_day_payloads(engine, user_id)
    persisted_leaks = _blocked_movement_leaks(persisted_days, blocked)
    assert not persisted_leaks, (
        f"blocked movements leaked in persisted PlanDay rows: {persisted_leaks}"
    )

    _ok("stored injuries flow into PlanWeek generation and persisted PlanDays")


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
    print(f"\nAll {len(test_fns)} injury_http_integration tests passed")
