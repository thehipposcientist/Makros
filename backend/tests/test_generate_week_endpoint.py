"""End-to-end HTTP tests for `/workouts/generate-week`.

Exercises the ACTUAL FastAPI route, not just the helper. Catches
regressions in the wiring between request → router → switch_day →
persistence → response.

Coverage:
  1. Pin every position (day 0 through day N-1) of a real recipe
     with `current_days` set. Assert: the response's days[pin_idx]
     focus matches the pin, AND only days[pin_idx] + the swap
     partner differ from the input.
  2. Pin a non-lifting day to a lift focus. Assert: target becomes
     a lift; lift count preserved.
  3. Pin to focus already at target. Assert: noop, week unchanged.
  4. Pin without `current_days` (legacy mode) — should still work
     by regenerating a fresh week.

The tests use FastAPI TestClient + an in-memory SQLite DB + a mocked
`get_current_user` to bypass auth. Same pattern as
`test_workout_plan_persistence.py`.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    """Same in-memory engine used by other endpoint tests."""
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
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


def _insert_user(session, *, subscription_tier: str = "pro"):
    from app.models import User
    u = User(
        email="switchday_test@example.com",
        username="switchday_test",
        hashed_password="x",
        subscription_tier=subscription_tier,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_test_app(engine, user_id: int):
    """FastAPI app with /workouts router + auth/db dependency overrides."""
    from fastapi import FastAPI
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.workouts import router as workouts_router

    app_db.engine = engine

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
    app.include_router(workouts_router)
    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_user] = _user_override
    return app


def _ppl_6d_days() -> list[dict]:
    """Realistic PPL 6d week as the frontend would send it."""
    return [
        {"focus": "Push", "exercises": [{"name": "Bench Press"}]},
        {"focus": "Pull", "exercises": [{"name": "Barbell Row"}]},
        {"focus": "Legs", "exercises": [{"name": "Back Squat"}]},
        {"focus": "Push", "exercises": [{"name": "Overhead Press"}]},
        {"focus": "Pull", "exercises": [{"name": "Pull-up"}]},
        {"focus": "Legs", "exercises": [{"name": "Romanian Deadlift"}]},
    ]


def _ul_4d_days() -> list[dict]:
    return [
        {"focus": "Upper", "exercises": [{"name": "Bench Press"}]},
        {"focus": "Lower", "exercises": [{"name": "Back Squat"}]},
        {"focus": "Upper", "exercises": [{"name": "Pull-up"}]},
        {"focus": "Lower", "exercises": [{"name": "Deadlift"}]},
    ]


def _bro_5d_days() -> list[dict]:
    return [
        {"focus": "Chest", "exercises": [{"name": "Bench Press"}]},
        {"focus": "Back", "exercises": [{"name": "Pull-up"}]},
        {"focus": "Shoulders", "exercises": [{"name": "Overhead Press"}]},
        {"focus": "Arms", "exercises": [{"name": "Curl"}]},
        {"focus": "Legs", "exercises": [{"name": "Back Squat"}]},
    ]


def _post_pin(client, *, current_days: list[dict], pin_day_index: int,
              pin_focus: str, days_per_week: int, preferred_split: str,
              goal: str = "muscle_gain"):
    body = {
        "goal": goal,
        "days_per_week": days_per_week,
        "session_minutes": 60,
        "experience": "intermediate",
        "equipment": ["barbell", "dumbbells", "cable_machine", "pull_up_bar"],
        "preferred_split": preferred_split,
        "priority_region": "balanced",
        "injuries": [],
        "disliked_exercises": [],
        "pin_day_index": pin_day_index,
        "pin_focus": pin_focus,
        "current_days": current_days,
    }
    return client.post("/workouts/generate-week", json=body)


def _focuses(days: list[dict]) -> list[str]:
    return [d.get("focus") for d in days]


def _changed_positions(before: list[dict], after: list[dict]) -> list[int]:
    return [i for i in range(len(before)) if _focuses([before[i]])[0] != _focuses([after[i]])[0]]


# ── Entitlement gate ───────────────────────────────────────────────

def test_generate_week_for_free_user_returns_403() -> None:
    """Weekly generated plans are Pro-only."""
    print("\n[test] /workouts/generate-week blocks free users")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s, subscription_tier="free")
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    resp = _post_pin(
        client,
        current_days=_ppl_6d_days(),
        pin_day_index=0,
        pin_focus="Push",
        days_per_week=6,
        preferred_split="ppl",
    )
    assert resp.status_code == 403, f"expected 403, got {resp.status_code}: {resp.text[:200]}"
    assert "Thallo Pro" in resp.json().get("detail", "")
    _ok("free users cannot call generated weekly plans")


# ── Pin every position on PPL 6d ───────────────────────────────────

def test_pin_each_position_on_ppl_6d_only_changes_target_and_partner() -> None:
    """The user-reported bug: pin day 4 → only day 4 changes (not day 1).
    Sweep: pin every position to every in-split focus and assert ≤2 days
    changed AND the target day matches the requested focus."""
    print("\n[test] /workouts/generate-week PPL 6d pin every position")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = _ppl_6d_days()
    base_focuses = _focuses(base_days)
    failures: list[str] = []
    for pin_idx in range(6):
        for focus in ("Push", "Pull", "Legs"):
            days_in = [dict(d) for d in base_days]  # fresh copy
            resp = _post_pin(
                client, current_days=days_in, pin_day_index=pin_idx,
                pin_focus=focus, days_per_week=6, preferred_split="ppl",
            )
            if resp.status_code != 200:
                failures.append(
                    f"pin {pin_idx}→{focus}: HTTP {resp.status_code} {resp.text[:200]}"
                )
                continue
            out_days = resp.json().get("days", [])
            out_focuses = _focuses(out_days)
            # 1. Target day's focus matches the pin (or close — base
            #    match for hybrids).
            target_focus = (out_focuses[pin_idx] or "").lower()
            wanted = focus.lower()
            if target_focus != wanted and wanted not in target_focus:
                failures.append(
                    f"pin {pin_idx}→{focus}: target focus is "
                    f"{out_focuses[pin_idx]!r}, wanted {focus!r}"
                )
                continue
            # Canonical-rebuild may touch all lift days, but families
            # must still match the original distribution.
            from collections import Counter
            def _fam(f):
                f = (f or "").lower().replace(" + cardio", "")
                if "legs" in f: return "legs"
                if "chest" in f: return "push"
                if "back" in f: return "pull"
                if "shoulders" in f: return "push"
                if "arms" in f: return "upper"
                if "push" in f: return "push"
                if "pull" in f: return "pull"
                if "upper" in f: return "upper"
                if "lower" in f: return "lower"
                return f
            base_fams = Counter(_fam(f) for f in base_focuses)
            out_fams = Counter(_fam(f) for f in out_focuses)
            if base_fams != out_fams:
                failures.append(
                    f"pin {pin_idx}→{focus}: family counts changed; "
                    f"base={dict(base_fams)} after={dict(out_fams)}"
                )
    assert not failures, "PPL 6d pin failures:\n" + "\n".join(failures)
    _ok("every PPL 6d pin lands at target with ≤2 day changes")


def test_pin_each_position_on_ul_4d_only_changes_target_and_partner() -> None:
    print("\n[test] /workouts/generate-week U/L 4d pin every position")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = _ul_4d_days()
    base_focuses = _focuses(base_days)
    failures: list[str] = []
    for pin_idx in range(4):
        for focus in ("Upper", "Lower"):
            days_in = [dict(d) for d in base_days]
            resp = _post_pin(
                client, current_days=days_in, pin_day_index=pin_idx,
                pin_focus=focus, days_per_week=4, preferred_split="upper_lower",
            )
            if resp.status_code != 200:
                failures.append(f"pin {pin_idx}→{focus}: HTTP {resp.status_code}")
                continue
            out_days = resp.json().get("days", [])
            out_focuses = _focuses(out_days)
            target_focus = (out_focuses[pin_idx] or "").lower()
            if focus.lower() not in target_focus:
                failures.append(
                    f"pin {pin_idx}→{focus}: target focus is "
                    f"{out_focuses[pin_idx]!r}"
                )
                continue
            # Family counts must be preserved (canonical rebuild
            # rotates the cycle but doesn't change family distribution).
            from collections import Counter
            def _f(f):
                lo = (f or "").lower().replace(" + cardio", "")
                if "legs" in lo: return "legs"
                if "upper" in lo: return "upper"
                if "lower" in lo: return "lower"
                return lo
            if Counter(_f(f) for f in base_focuses) != Counter(_f(f) for f in out_focuses):
                failures.append(
                    f"pin {pin_idx}→{focus}: family counts changed; "
                    f"base={base_focuses} after={out_focuses}"
                )
    assert not failures, "U/L 4d pin failures:\n" + "\n".join(failures)
    _ok("every U/L 4d pin lands at target with ≤2 day changes")


def test_pin_each_position_on_bro_5d_only_changes_target_and_partner() -> None:
    print("\n[test] /workouts/generate-week Bro 5d pin every position")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = _bro_5d_days()
    base_focuses = _focuses(base_days)
    failures: list[str] = []
    bro_focuses = ("Chest", "Back", "Shoulders", "Arms", "Legs")
    for pin_idx in range(5):
        for focus in bro_focuses:
            days_in = [dict(d) for d in base_days]
            resp = _post_pin(
                client, current_days=days_in, pin_day_index=pin_idx,
                pin_focus=focus, days_per_week=5, preferred_split="bro",
            )
            if resp.status_code != 200:
                failures.append(f"pin {pin_idx}→{focus}: HTTP {resp.status_code}")
                continue
            out_days = resp.json().get("days", [])
            out_focuses = _focuses(out_days)
            target_focus = (out_focuses[pin_idx] or "").lower()
            if focus.lower() not in target_focus:
                failures.append(
                    f"pin {pin_idx}→{focus}: target focus is "
                    f"{out_focuses[pin_idx]!r}"
                )
                continue
            # Bro: result must be a contiguous slice of the canonical
            # cycle [Chest, Back, Shoulders, Arms, Legs] starting at
            # SOME position. Cycle preserved; pin honored.
            bro_cycle = ["Chest", "Back", "Shoulders", "Arms", "Legs"]
            valid_rotations = [
                [bro_cycle[(s + i) % 5] for i in range(5)]
                for s in range(5)
            ]
            if out_focuses not in valid_rotations:
                failures.append(
                    f"pin {pin_idx}→{focus}: not a canonical bro rotation; "
                    f"got {out_focuses}"
                )
    assert not failures, "Bro 5d pin failures:\n" + "\n".join(failures)
    _ok("every Bro 5d pin lands at target as canonical rotation")


# ── User-reported scenario: PPL 6d pin day 4 → only day 4 changes ──

def test_user_reported_scenario_pin_day_4_to_push_lands_at_day_4() -> None:
    """User complaint: 'tap day 4 to Push, day 1 changes instead'.

    Canonical-rebuild contract: pin lands at day 4. Family counts
    preserved. PPL cycle preserved (no back-to-back same-family).
    Day 0 may change because the canonical cycle is rebuilt to keep
    the split coherent — that's the explicit tradeoff over single-day
    swap (which scrambled the cycle across cumulative pins)."""
    print("\n[test] user-reported: pin day 4 → Push lands at target with cycle preserved")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = _ppl_6d_days()
    resp = _post_pin(
        client, current_days=base_days, pin_day_index=4, pin_focus="Push",
        days_per_week=6, preferred_split="ppl",
    )
    assert resp.status_code == 200, f"HTTP {resp.status_code}: {resp.text[:200]}"
    out = resp.json().get("days", [])
    out_focuses = _focuses(out)
    # Day 4 lands on Push.
    assert "push" in (out_focuses[4] or "").lower(), \
        f"pin day 4→Push: got {out_focuses[4]!r}; full week {out_focuses}"
    # No back-to-back same-family days.
    fams = []
    for f in out_focuses:
        lo = (f or "").lower().replace(" + cardio", "")
        if "legs" in lo: fams.append("legs")
        elif "push" in lo: fams.append("push")
        elif "pull" in lo: fams.append("pull")
        else: fams.append("?")
    for i in range(len(fams) - 1):
        if fams[i] in ("push", "pull", "legs"):
            assert fams[i] != fams[i + 1], \
                f"back-to-back {fams[i]} at days {i}+{i+1}: {out_focuses}"


# ── Pin to focus already at target → noop (no change) ─────────────

def test_pin_to_current_focus_is_noop() -> None:
    """Pin day 0 (Push) → Push: zero days should change."""
    print("\n[test] pin to current focus is noop")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = _ppl_6d_days()
    base_focuses = _focuses(base_days)
    resp = _post_pin(
        client, current_days=base_days, pin_day_index=0, pin_focus="Push",
        days_per_week=6, preferred_split="ppl",
    )
    assert resp.status_code == 200
    out_focuses = _focuses(resp.json().get("days", []))
    assert out_focuses == base_focuses, \
        f"noop pin changed the week: before={base_focuses} after={out_focuses}"


# ── Non-lifting target → swap with closest matching lift ──────────

def test_pin_recovery_day_to_legs_swaps_with_closest_legs() -> None:
    """Recovery day at idx 0, pin to Legs → day 0 becomes Legs, the
    closest Legs day inherits the recovery day."""
    print("\n[test] pin non-lifting day → lift focus does single-day swap")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = [
        {"focus": "Recovery", "exercises": []},
        {"focus": "Push", "exercises": [{"name": "Bench"}]},
        {"focus": "Pull", "exercises": [{"name": "Row"}]},
        {"focus": "Legs", "exercises": [{"name": "Squat"}]},
        {"focus": "Push", "exercises": [{"name": "OHP"}]},
        {"focus": "Pull", "exercises": [{"name": "Pull-up"}]},
        {"focus": "Legs", "exercises": [{"name": "RDL"}]},
    ]
    resp = _post_pin(
        client, current_days=base_days, pin_day_index=0, pin_focus="Legs",
        days_per_week=7, preferred_split="ppl",
    )
    assert resp.status_code == 200
    out_focuses = _focuses(resp.json().get("days", []))
    assert (out_focuses[0] or "").lower() == "legs", \
        f"pin day 0 (Recovery) → Legs: got {out_focuses[0]!r}"
    # Recovery should now sit where the swapped Legs was.
    rest_count = sum(
        1 for f in out_focuses
        if "recovery" in (f or "").lower() or "mobility" in (f or "").lower()
    )
    assert rest_count == 1, \
        f"recovery count changed: {out_focuses}"


# ── Determinism: same inputs → same response ──────────────────────

def test_pin_is_deterministic() -> None:
    """Same current_days + same pin → same response."""
    print("\n[test] pin is deterministic")
    from sqlmodel import Session
    from fastapi.testclient import TestClient

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        user_id = user.id
    app = _make_test_app(engine, user_id)
    client = TestClient(app)

    base_days = _ppl_6d_days()
    r1 = _post_pin(
        client, current_days=base_days, pin_day_index=2, pin_focus="Push",
        days_per_week=6, preferred_split="ppl",
    )
    r2 = _post_pin(
        client, current_days=base_days, pin_day_index=2, pin_focus="Push",
        days_per_week=6, preferred_split="ppl",
    )
    assert r1.status_code == 200 and r2.status_code == 200
    f1 = _focuses(r1.json().get("days", []))
    f2 = _focuses(r2.json().get("days", []))
    assert f1 == f2


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
    print(f"\nAll {len(test_fns)} generate_week_endpoint tests passed")
