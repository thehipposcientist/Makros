from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import (
    DailyHealthSnapshotUpsert,
    DailyStressSummaryUpsert,
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
                    basal_energy_kcal=1860,
                    zone2_minutes=28,
                    respiratory_rate=15.5,
                    oxygen_saturation=97.2,
                    sleep_breathing_disturbances_elevated=False,
                    source="apple_health",
                    source_details={
                        "providers": ["apple_health"],
                        "fields": {"steps": "apple_health", "zone2_minutes": "apple_health"},
                    },
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
                    wrist_temperature_c=35.8,
                    sleep_breathing_disturbances=1.2,
                    sleep_breathing_disturbances_elevated=True,
                    source="oura",
                    source_details={
                        "providers": ["oura"],
                        "fields": {"hrv_ms": "oura", "resting_hr": "oura"},
                    },
                ),
            ],
            current_user=user,
            session=session,
        )

        rows = health_router.list_snapshot_history(days=7, current_user=user, session=session)
        row = next(r for r in rows if r["snapshot_date"] == str(day))
        assert row["steps"] == 9200
        assert row["basal_energy_kcal"] == 1860
        assert row["zone2_minutes"] == 28
        assert row["hrv_ms"] == 62
        assert row["resting_hr"] == 49
        assert row["respiratory_rate"] == 15.5
        assert row["oxygen_saturation"] == 97.2
        assert row["wrist_temperature_c"] == 35.8
        assert row["sleep_breathing_disturbances"] == 1.2
        assert row["sleep_breathing_disturbances_elevated"] is True
        assert row["source"] == "oura"
        assert row["source_details"]["providers"] == ["apple_health", "oura"]
        assert row["source_details"]["fields"]["steps"] == "apple_health"
        assert row["source_details"]["fields"]["hrv_ms"] == "oura"
    finally:
        health_router._refresh_health_dependents = original_refresh
        session.close()


def test_stress_summary_history_compares_against_prior_baseline() -> None:
    session, user = _session_with_user()
    try:
        today = date.today()
        for offset, value in ((3, 42), (2, 44), (1, 43)):
            health_router.upsert_stress_summary(
                DailyStressSummaryUpsert(
                    summary_date=today - timedelta(days=offset),
                    avg_stress=value,
                    max_stress=value + 8,
                    latest_stress=value + 2,
                    sample_count=12,
                    source_count=2,
                    source="logs_estimate",
                ),
                current_user=user,
                session=session,
            )
        health_router.upsert_stress_summary(
            DailyStressSummaryUpsert(
                summary_date=today,
                avg_stress=58,
                max_stress=76,
                latest_stress=61,
                sample_count=18,
                source_count=3,
                source="hr_logs_estimate",
            ),
            current_user=user,
            session=session,
        )

        history = health_router.list_stress_history(
            days=7,
            baseline_days=14,
            current_user=user,
            session=session,
        )
        assert history["baseline"]["avg_stress"] == 43
        assert history["baseline"]["days_with_data"] == 3
        assert history["today"]["avg_stress"] == 58
        assert history["today"]["comparison"]["label"] == "much_higher_than_usual"
        assert history["today"]["comparison"]["delta"] == 15
    finally:
        session.close()


cases = [
    test_sleep_batch_upsert_preserves_existing_fields,
    test_health_batch_upsert_preserves_existing_fields,
    test_stress_summary_history_compares_against_prior_baseline,
]
