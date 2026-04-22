"""Tests for the ``detect_prs`` PR-detection service (Feature 2).

All tests run against an in-memory SQLite DB — no Docker required.

Coverage:
  - First-ever set for an exercise → heaviest_weight + estimated_1rm + volume PR
  - Exceeding last heaviest by 5lb → heaviest_weight PR
  - Same weight, more reps → estimated_1rm PR (not heaviest_weight)
  - Equal to prior best → no PR
  - Cross-user isolation: another user's big PR doesn't shadow this user's
"""
from __future__ import annotations

from datetime import date, datetime, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Shared in-memory DB helpers ─────────────────────────────────────


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from sqlalchemy.pool import StaticPool
    from app.models import (  # noqa: F401 — import forces metadata registration
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


def _insert_user(session, *, email: str = "pr_test@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _make_session(session, user_id: int, exercise_sets: list[tuple[str, list[tuple[float, int]]]], *, workout_date=None):
    """Create a WorkoutSession + WorkoutExercise + ExerciseSet rows.

    ``exercise_sets`` is a list of ``(exercise_name, [(weight_lbs, reps), ...])``.
    Every set is flagged completed.
    """
    from app.enums import WorkoutSource, EquipmentType
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet

    ws = WorkoutSession(
        user_id=user_id,
        name="Test",
        focus="test",
        workout_date=workout_date or date.today(),
        source=WorkoutSource.GENERATED,
        completed_at=datetime.now(timezone.utc),
    )
    session.add(ws)
    session.flush()

    for idx, (ex_name, sets) in enumerate(exercise_sets):
        we = WorkoutExercise(
            session_id=ws.id,
            name=ex_name,
            order_index=idx,
            equipment=EquipmentType.GYM,
        )
        session.add(we)
        session.flush()
        for i, (w, r) in enumerate(sets):
            session.add(ExerciseSet(
                workout_exercise_id=we.id,
                set_number=i + 1,
                actual_weight_lbs=w,
                actual_reps=r,
                completed=True,
                completed_at=datetime.now(timezone.utc),
            ))
    session.commit()
    session.refresh(ws)
    return ws


# ── Tests ───────────────────────────────────────────────────────────


def test_epley_1rm_formula() -> None:
    print("\n[test] epley_1rm matches formula + handles bad inputs")
    from app.services.workout.pr_detection import epley_1rm

    # 185 × 5 → 185 * (1 + 5/30) = 185 * 1.1667 ≈ 215.83
    assert abs(epley_1rm(185, 5) - 215.83) < 0.05
    # Single rep → equal to weight
    assert abs(epley_1rm(225, 1) - 232.5) < 0.01  # 225 * 31/30
    # Invalid: zero / None / negative → 0
    assert epley_1rm(0, 5) == 0.0
    assert epley_1rm(100, 0) == 0.0
    assert epley_1rm(None, 5) == 0.0
    assert epley_1rm(100, None) == 0.0
    _ok("epley_1rm formula and guards correct")


def test_first_ever_set_is_heaviest_weight_pr() -> None:
    print("\n[test] first-ever set on a new exercise emits heaviest_weight PR")
    from sqlmodel import Session
    from app.services.workout.pr_detection import detect_prs

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        ws = _make_session(s, user.id, [("Bench Press", [(135.0, 8)])])
        prs = detect_prs(user.id, ws.id, s)

    kinds = sorted({p["kind"] for p in prs})
    assert "heaviest_weight" in kinds, f"missing heaviest_weight: {prs}"
    assert "estimated_1rm" in kinds, f"missing estimated_1rm: {prs}"
    assert "volume_record" in kinds, f"missing volume_record: {prs}"

    heaviest = next(p for p in prs if p["kind"] == "heaviest_weight")
    assert heaviest["new_value"] == 135.0
    assert heaviest["old_value"] == 0.0
    assert heaviest["exercise_name"] == "Bench Press"
    _ok(f"first-ever set produces {len(prs)} PRs (heaviest+1rm+volume)")


def test_beats_prior_heaviest_by_five_lb() -> None:
    print("\n[test] beating prior heaviest weight by +5lb emits heaviest_weight PR")
    from sqlmodel import Session
    from datetime import timedelta
    from app.services.workout.pr_detection import detect_prs

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        # Prior session: Squat 225 × 5
        _make_session(
            s, user.id, [("Back Squat", [(225.0, 5), (225.0, 5), (225.0, 5)])],
            workout_date=date.today() - timedelta(days=2),
        )
        # New session: Squat 230 × 5
        ws2 = _make_session(
            s, user.id, [("Back Squat", [(230.0, 5), (230.0, 5)])],
        )
        prs = detect_prs(user.id, ws2.id, s)

    heaviest = [p for p in prs if p["kind"] == "heaviest_weight"]
    assert len(heaviest) == 1, f"expected exactly 1 heaviest_weight PR, got {heaviest}"
    assert heaviest[0]["new_value"] == 230.0, heaviest[0]
    assert heaviest[0]["old_value"] == 225.0, heaviest[0]
    _ok("+5lb over prior heaviest → PR with correct old/new values")


def test_same_weight_more_reps_emits_1rm_pr_only() -> None:
    print("\n[test] same weight + more reps emits estimated_1rm PR (not heaviest_weight)")
    from sqlmodel import Session
    from datetime import timedelta
    from app.services.workout.pr_detection import detect_prs

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        # Prior: OHP 135 × 5
        _make_session(
            s, user.id, [("Overhead Press", [(135.0, 5)])],
            workout_date=date.today() - timedelta(days=3),
        )
        # New: OHP 135 × 8 (same weight, more reps)
        ws2 = _make_session(
            s, user.id, [("Overhead Press", [(135.0, 8)])],
        )
        prs = detect_prs(user.id, ws2.id, s)

    kinds = {p["kind"] for p in prs}
    assert "estimated_1rm" in kinds, f"missing estimated_1rm: {prs}"
    assert "heaviest_weight" not in kinds, (
        f"heaviest_weight should NOT fire at equal weight: {prs}"
    )
    # Volume also improves (135*8 > 135*5) so that's expected
    assert "volume_record" in kinds
    _ok("same weight + more reps → 1rm PR only, heaviest silent")


def test_equal_to_best_no_pr() -> None:
    print("\n[test] no improvement over prior best → no PRs")
    from sqlmodel import Session
    from datetime import timedelta
    from app.services.workout.pr_detection import detect_prs

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        # Prior: Deadlift 315 × 3
        _make_session(
            s, user.id, [("Deadlift", [(315.0, 3)])],
            workout_date=date.today() - timedelta(days=4),
        )
        # New: Deadlift 315 × 3 (identical — no PR)
        ws2 = _make_session(
            s, user.id, [("Deadlift", [(315.0, 3)])],
        )
        prs = detect_prs(user.id, ws2.id, s)

    assert prs == [], f"expected no PRs, got {prs}"
    _ok("identical performance → empty PR list")


def test_cross_user_isolation() -> None:
    print("\n[test] another user's huge lifts don't shadow this user's first-ever PR")
    from sqlmodel import Session
    from datetime import timedelta
    from app.services.workout.pr_detection import detect_prs

    engine = _make_mem_engine()
    with Session(engine) as s:
        strong = _insert_user(s, email="strong@example.com")
        rookie = _insert_user(s, email="rookie@example.com")
        # Strong user: Bench 405 × 5
        _make_session(
            s, strong.id, [("Bench Press", [(405.0, 5)])],
            workout_date=date.today() - timedelta(days=1),
        )
        # Rookie user: Bench 95 × 8 (first-ever for THIS user)
        ws = _make_session(
            s, rookie.id, [("Bench Press", [(95.0, 8)])],
        )
        prs = detect_prs(rookie.id, ws.id, s)

    heaviest = [p for p in prs if p["kind"] == "heaviest_weight"]
    assert len(heaviest) == 1, heaviest
    assert heaviest[0]["new_value"] == 95.0
    assert heaviest[0]["old_value"] == 0.0, (
        f"rookie's 'old_value' must be 0 even though another user benches 405: {heaviest[0]}"
    )
    _ok("user-scoped history — other users' PRs don't leak")


def test_top_set_reported_once_per_kind() -> None:
    print("\n[test] multi-set session reports the TOP set per kind, not every set")
    from sqlmodel import Session
    from app.services.workout.pr_detection import detect_prs

    engine = _make_mem_engine()
    with Session(engine) as s:
        user = _insert_user(s)
        # First-ever exercise, three increasing sets
        ws = _make_session(
            s, user.id, [("Barbell Row", [(135.0, 5), (155.0, 5), (175.0, 5)])],
        )
        prs = detect_prs(user.id, ws.id, s)

    heaviest = [p for p in prs if p["kind"] == "heaviest_weight"]
    assert len(heaviest) == 1, f"expected one consolidated heaviest PR, got {heaviest}"
    assert heaviest[0]["new_value"] == 175.0, heaviest[0]
    _ok("deduplicated to top set within the session")


cases = [
    test_epley_1rm_formula,
    test_first_ever_set_is_heaviest_weight_pr,
    test_beats_prior_heaviest_by_five_lb,
    test_same_weight_more_reps_emits_1rm_pr_only,
    test_equal_to_best_no_pr,
    test_cross_user_isolation,
    test_top_set_reported_once_per_kind,
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
