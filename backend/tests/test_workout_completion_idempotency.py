"""Workout completion idempotency.

The mobile client may retry a completion after a timeout/offline queue flush.
The same idempotency key must update one DB row rather than creating two
workout-completion markers or two structured sessions.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _engine():
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    import app.models  # noqa: F401

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _user(session):
    from app.models import User

    u = User(email="workout_idem@example.com", username="workout_idem", hashed_password="x", subscription_tier="pro")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def test_same_workout_idempotency_key_creates_one_completion():
    from sqlmodel import Session, select
    from app.models import ExerciseSet, WorkoutCompletion, WorkoutSession
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete

    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        body = WorkoutCompleteRequest(
            workout_date=date(2026, 5, 22),
            focus_label="Push",
            duration_seconds=1800,
            idempotency_key="workout-complete-abc",
            exercises=[
                {
                    "name": "Bench Press",
                    "equipment": "barbell",
                    "sets": [{"set_number": 1, "reps": 5, "weight_lbs": 185}],
                }
            ],
        )
        mark_workout_complete(body, u, s)
        mark_workout_complete(body, u, s)

        rows = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(rows) == 1
        assert rows[0].idempotency_key == "workout-complete-abc"
        sessions = s.exec(select(WorkoutSession).where(WorkoutSession.user_id == u.id)).all()
        assert len(sessions) == 1
        sets = s.exec(select(ExerciseSet)).all()
        assert len(sets) == 1

    _ok("same workout idempotency key creates one completion and one structured session")


def test_watch_cellular_end_workout_is_idempotent():
    from sqlmodel import Session, select
    from app.models import ExerciseSet, WatchCommandEvent, WatchDevice, WorkoutCompletion, WorkoutSession
    from app.routers.watch import apply_watch_command
    from app.watch_auth import WatchAuthContext, hash_watch_token

    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        device = WatchDevice(
            user_id=u.id,
            device_id="watch-test",
            token_hash=hash_watch_token("watch-token"),
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        s.add(device)
        s.commit()
        s.refresh(device)

        body = {
            "command": "end_workout",
            "commandId": "watch-end-abc",
            "completion": {
                "workout_date": "2026-05-31",
                "focus_label": "Push",
                "duration_seconds": 1800,
                "source_context": "planned",
                "external_source_id": "watch:test-session",
                "idempotency_key": "watch:test-session",
                "exercises": [
                    {
                        "name": "Bench Press",
                        "slug": "bench-press",
                        "equipment": "barbell",
                        "primary_muscle": "chest",
                        "order_index": 0,
                        "sets": [{"set_number": 1, "reps": 5, "weight_lbs": 185}],
                    }
                ],
            },
        }
        ctx = WatchAuthContext(user=u, device=device)

        first = apply_watch_command(body, ctx, s)
        duplicate = apply_watch_command(body, ctx, s)

        assert first["ok"] is True
        assert first["duplicate"] is False
        assert duplicate["ok"] is True
        assert duplicate["duplicate"] is True

        completions = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(completions) == 1
        assert completions[0].external_source_id == "watch:test-session"
        assert completions[0].source_context == "planned"
        sessions = s.exec(select(WorkoutSession).where(WorkoutSession.user_id == u.id)).all()
        assert len(sessions) == 1
        assert sessions[0].external_source_id == "watch:test-session"
        sets = s.exec(select(ExerciseSet)).all()
        assert len(sets) == 1
        assert sets[0].actual_weight_lbs == 185
        events = s.exec(select(WatchCommandEvent).where(WatchCommandEvent.user_id == u.id)).all()
        assert len(events) == 1
        assert events[0].status == "applied"

    _ok("watch cellular end_workout creates one completion, session, set, and command event")


def test_watch_readiness_uses_watch_auth_context():
    from sqlmodel import Session
    from app.models import DailyHealthSnapshot, SleepLog, WatchDevice
    from app.routers.watch import watch_readiness
    from app.watch_auth import WatchAuthContext, hash_watch_token

    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        today = date.today()
        device = WatchDevice(
            user_id=u.id,
            device_id="watch-readiness-test",
            token_hash=hash_watch_token("watch-readiness-token"),
            expires_at=datetime.now(timezone.utc) + timedelta(days=1),
        )
        s.add(device)
        s.add(SleepLog(user_id=u.id, night_date=today, total_hours=7.5, score=86))
        s.add(DailyHealthSnapshot(
            user_id=u.id,
            snapshot_date=today,
            resting_hr=57,
            hrv_ms=64,
            source="apple_health",
        ))
        s.commit()
        s.refresh(device)

        payload = watch_readiness(WatchAuthContext(user=u, device=device), s)

        assert payload["computed_at_ms"] > 0
        assert isinstance(payload["factors"], list)
        labels = {factor["label"] for factor in payload["factors"]}
        assert "Sleep" in labels
        assert "RHR" in labels
        assert "HRV" in labels

    _ok("watch readiness route returns canonical readiness for watch token users")


cases = [
    test_same_workout_idempotency_key_creates_one_completion,
    test_watch_cellular_end_workout_is_idempotent,
    test_watch_readiness_uses_watch_auth_context,
]


if __name__ == "__main__":
    import sys
    import traceback

    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            traceback.print_exc()
    print(f"\n{len(cases) - failures}/{len(cases)} passed")
    sys.exit(1 if failures else 0)
