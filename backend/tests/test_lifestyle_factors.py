"""Optional lifestyle-factor context tests."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import DailyHealthSnapshot, DailyLifestyleLog, SleepLog, User
from app.services.context_insights.services import SunExposureInsightService, generate_context_insights
from app.services.context_insights.types import DailyFeatureSet, UserInsightPreferences
from app.services.insights.insight_engine import build_health_insights_response
from app.services.readiness.compute import compute_readiness


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _engine():
    return create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def _session():
    engine = _engine()
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_readiness_explains_optional_lifestyle_factors() -> None:
    today = date.today()
    with _session() as session:
        user = User(email="life@example.com", username="life", hashed_password="x")
        session.add(user)
        session.commit()
        session.refresh(user)
        session.add(SleepLog(user_id=user.id, night_date=today, total_hours=6.2, score=60))
        session.add(DailyHealthSnapshot(user_id=user.id, snapshot_date=today - timedelta(days=1), hrv_ms=55, resting_hr=58))
        session.add(DailyHealthSnapshot(user_id=user.id, snapshot_date=today, hrv_ms=42, resting_hr=68))
        session.add(DailyLifestyleLog(
            user_id=user.id,
            local_date=today - timedelta(days=1),
            alcohol_level="moderate",
            alcohol_drinks=2,
            cannabis_level="light",
            cannabis_timing="late",
            caffeine_timing="late",
            late_caffeine=True,
        ))
        session.add(DailyLifestyleLog(
            user_id=user.id,
            local_date=today,
            stress_level="high",
            illness_state="rundown",
            appetite="high",
        ))
        session.commit()

        result = compute_readiness(
            session,
            user.id,
            avg_sleep_hours=6.2,
            avg_resting_hr=68,
            avg_hrv_ms=42,
            last_night_sleep_score=60,
            nutrition_adherence_pct=85,
            use_cache=False,
        )

    messages = [item["message"] for item in result.explanations if item.get("type") == "lifestyle_context"]
    joined = " ".join(messages).lower()
    assert messages, result.explanations
    assert "may be contributing" in joined, joined
    assert "alcohol" in joined and "cannabis" in joined, joined
    _ok("readiness surfaces optional lifestyle factors as explanatory context")


def test_context_insights_add_private_lifestyle_context_without_medical_claims() -> None:
    today = date(2026, 5, 25)
    features = [
        DailyFeatureSet(user_id=7, date=today - timedelta(days=2), sleep_duration_minutes=430, hrv=60, resting_heart_rate=56, active_minutes=30, recovery_score=78),
        DailyFeatureSet(user_id=7, date=today - timedelta(days=1), sleep_duration_minutes=420, hrv=58, resting_heart_rate=57, active_minutes=30, recovery_score=74),
        DailyFeatureSet(user_id=7, date=today, sleep_duration_minutes=340, hrv=44, resting_heart_rate=66, active_minutes=20, recovery_score=52),
    ]
    logs = [
        DailyLifestyleLog(user_id=7, local_date=today, stress_level="high", illness_state="rundown", bowel_movement_count=0)
    ]
    insights = generate_context_insights(
        7,
        preferences=UserInsightPreferences(enable_recovery_insights=True),
        features=features,
        lifestyle_logs=logs,
        created_at=datetime(2026, 5, 25, tzinfo=timezone.utc),
    )
    lifestyle = [insight for insight in insights if insight.type == "lifestyle_context"]
    assert lifestyle, [insight.type for insight in insights]
    text = " ".join([
        lifestyle[0].summary,
        lifestyle[0].explanation,
        lifestyle[0].safety_note or "",
    ]).lower()
    assert "may be contributing" in text, text
    assert "diagnos" not in text and "cause" not in text, text
    _ok("context insights keep lifestyle factors private, optional, and non-diagnostic")


def test_health_insights_use_lifestyle_logs() -> None:
    today = date.today()
    with _session() as session:
        user = User(email="health-life@example.com", username="healthlife", hashed_password="x")
        session.add(user)
        session.commit()
        session.refresh(user)
        session.add(SleepLog(user_id=user.id, night_date=today, total_hours=6.1, score=58))
        session.add(DailyHealthSnapshot(user_id=user.id, snapshot_date=today, hrv_ms=42, resting_hr=68))
        session.add(DailyLifestyleLog(
            user_id=user.id,
            local_date=today,
            stress_level="high",
            illness_state="rundown",
            caffeine_timing="late",
            late_caffeine=True,
            appetite="high",
            bowel_movement_count=0,
            source="watch",
        ))
        session.commit()

        result = build_health_insights_response(session, user.id, days=14, include_unknown=False)

    cards = result["cards"]
    lifestyle = [card for card in cards if card["id"] == "lifestyle_context"]
    assert lifestyle, [card["id"] for card in cards]
    card = lifestyle[0]
    assert "lifestyle" in card["data_used"], card
    assert result["data_coverage"]["lifestyle"]["records"] == 1, result["data_coverage"]
    text = " ".join(card["drivers"] + card["recommendations"]).lower()
    assert "stress" in text and "late caffeine" in text, text
    assert "cause" not in text, text
    _ok("health insights consume lifestyle logs as private recovery context")


def test_sun_exposure_source_labels_are_explicit() -> None:
    result = SunExposureInsightService.analyze(
        7,
        [
            {
                "durationMinutes": 24,
                "outdoorConfidence": 1,
                "uvIndexMax": 2,
                "openSkyEquivalentMinutes": 18,
                "areaContext": {"skyExposureCoefficient": 0.7},
                "source": "healthkit_daylight",
                "startTime": datetime(2026, 5, 25, 13, tzinfo=timezone.utc),
            },
            {
                "durationMinutes": 12,
                "outdoorConfidence": 0.5,
                "uvIndexMax": 1,
                "openSkyEquivalentMinutes": 5,
                "areaContext": {"skyExposureCoefficient": 0.5},
                "source": "coarse_location",
                "startTime": datetime(2026, 5, 25, 19, tzinfo=timezone.utc),
            },
        ],
    )
    assert "Apple Watch / HealthKit" in result["sourceLabels"], result
    assert "Phone coarse location fallback" in result["sourceLabels"], result
    _ok("sun exposure insight labels HealthKit and fallback sources")


cases = [
    test_readiness_explains_optional_lifestyle_factors,
    test_context_insights_add_private_lifestyle_context_without_medical_claims,
    test_health_insights_use_lifestyle_logs,
    test_sun_exposure_source_labels_are_explicit,
]


if __name__ == "__main__":
    for case in cases:
        print(f"\n[test] {case.__name__}")
        case()
