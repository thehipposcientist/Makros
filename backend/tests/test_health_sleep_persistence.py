from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import (
    DailyHealthSnapshotUpsert,
    SleepLogUpsert,
    User,
)
from app.routers import health as health_router
from app.routers import sleep as sleep_router


def _session_with_user() -> tuple[Session, User]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    user = User(
        email="health@example.com",
        username="healthuser",
        hashed_password="x",
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return session, user


def test_sleep_batch_upsert_preserves_existing_fields() -> None:
    session, user = _session_with_user()
    original_refresh = sleep_router._refresh_sleep_dependents
    sleep_router._refresh_sleep_dependents = lambda *_args, **_kwargs: None
    try:
        night = date.today() - timedelta(days=1)
        sleep_router.upsert_nightly_sleep_batch(
            [
                SleepLogUpsert(
                    night_date=night,
                    total_hours=7.25,
                    hrv_ms=51,
                    source="apple_health",
                ),
            ],
            current_user=user,
            session=session,
        )
        sleep_router.upsert_nightly_sleep_batch(
            [
                SleepLogUpsert(
                    night_date=night,
                    resting_hr=54,
                    source="apple_health",
                ),
            ],
            current_user=user,
            session=session,
        )

        rows = sleep_router.list_sleep_history(days=7, current_user=user, session=session)
        row = next(r for r in rows if r["night_date"] == str(night))
        assert row["total_hours"] == 7.25
        assert row["hrv_ms"] == 51
        assert row["resting_hr"] == 54
    finally:
        sleep_router._refresh_sleep_dependents = original_refresh
        session.close()


def test_health_batch_upsert_preserves_existing_fields() -> None:
    session, user = _session_with_user()
    original_refresh = health_router._refresh_health_dependents
    health_router._refresh_health_dependents = lambda *_args, **_kwargs: None
    try:
        day = date.today() - timedelta(days=1)
        health_router.upsert_snapshot_batch(
            [
                DailyHealthSnapshotUpsert(
                    snapshot_date=day,
                    steps=9200,
                    zone2_minutes=28,
                    source="apple_health",
                ),
            ],
            current_user=user,
            session=session,
        )
        health_router.upsert_snapshot_batch(
            [
                DailyHealthSnapshotUpsert(
                    snapshot_date=day,
                    hrv_ms=62,
                    resting_hr=49,
                    source="apple_health",
                ),
            ],
            current_user=user,
            session=session,
        )

        rows = health_router.list_snapshot_history(days=7, current_user=user, session=session)
        row = next(r for r in rows if r["snapshot_date"] == str(day))
        assert row["steps"] == 9200
        assert row["zone2_minutes"] == 28
        assert row["hrv_ms"] == 62
        assert row["resting_hr"] == 49
    finally:
        health_router._refresh_health_dependents = original_refresh
        session.close()


cases = [
    test_sleep_batch_upsert_preserves_existing_fields,
    test_health_batch_upsert_preserves_existing_fields,
]
