"""Profile weight sync regression tests.

Covers the Body Measurements path that stores a WeeklyCheckIn for trend
context while leaving UserProfile.weight_lbs as the source-of-truth Body
weight unless the caller explicitly opts into promotion.
"""
from __future__ import annotations

from datetime import date

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.enums import Gender, GoalPace, GoalType
from app.models import (
    User,
    UserGoal,
    UserPreferences,
    UserProfile,
    WeeklyCheckIn,
    WeeklyCheckInCreate,
)
from app.routers import profile as profile_router


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_user_profile(session: Session, user_id: int = 1, weight_lbs: float = 180.0) -> User:
    user = User(
        id=user_id,
        email=f"profile-weight-{user_id}@test.thallo",
        username=f"profile_weight_{user_id}",
        hashed_password="x",
        first_name="Profile",
        last_name="Weight",
    )
    session.add(user)
    session.add(UserProfile(
        user_id=user_id,
        weight_lbs=weight_lbs,
        height_feet=5,
        height_inches=10,
        age=30,
        gender=Gender.MALE,
    ))
    session.add(UserGoal(
        user_id=user_id,
        goal_type=GoalType.BODY_RECOMP,
        goal_track="body_recomp",
        pace=GoalPace.MODERATE,
        is_active=True,
    ))
    session.add(UserPreferences(
        user_id=user_id,
        days_per_week=4,
        workout_duration_minutes=60,
        equipment=["Dumbbells"],
        foods_available=["chicken breast"],
    ))
    session.commit()
    seeded = session.get(User, user_id)
    assert seeded is not None
    return seeded


def _profile_weight(session: Session, user_id: int) -> float:
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    assert profile is not None
    return profile.weight_lbs


def test_profile_me_returns_dumped_profile_payload():
    """Regression guard for SQLAlchemy expiration after commit.

    /profile/me must return concrete JSON fields, not empty dicts.
    """
    print("\n[test] profile/me: dumped payload survives commit")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=10, weight_lbs=181.5)
        payload = profile_router.get_my_profile(current_user=user, session=session)

    assert payload["profile"]["weight_lbs"] == 181.5
    assert payload["goal"]["goal_track"] == "body_recomp"
    assert payload["preferences"]["days_per_week"] == 4
    assert payload["coaching"]["calorie_adjustment"] == 0
    _ok("profile/me returns concrete profile, goal, preferences, and coaching fields")


def test_measurement_checkin_does_not_update_profile_weight_when_flag_false():
    """Measurement-only clients can attach profile weight without promoting it."""
    print("\n[test] profile/checkin: measurement-only save does not promote weight")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=20, weight_lbs=180.0)
        body = WeeklyCheckInCreate(
            checkin_date=date(2026, 5, 2),
            weight_lbs=150.0,
            update_profile_weight=False,
            waist_in=32.5,
            body_fat_pct=17.0,
            energy=3,
            sleep=3,
            adherence=3,
        )

        result = profile_router.weekly_checkin(body, current_user=user, session=session)
        row = session.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 20)).first()

        assert result["status"] == "ok"
        assert _profile_weight(session, 20) == 180.0
        assert row is not None
        assert row.weight_lbs == 150.0
        assert row.waist_in == 32.5
        assert row.body_fat_pct == 17.0
    _ok("update_profile_weight=False leaves UserProfile.weight_lbs unchanged")


def test_checkin_defaults_to_updating_profile_weight():
    """Existing weekly-checkin callers keep the historical promotion behavior."""
    print("\n[test] profile/checkin: default save promotes profile weight")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=30, weight_lbs=180.0)
        body = WeeklyCheckInCreate(
            checkin_date=date(2026, 5, 2),
            weight_lbs=176.25,
            energy=4,
            sleep=4,
            adherence=4,
        )

        assert body.update_profile_weight is True
        profile_router.weekly_checkin(body, current_user=user, session=session)
        assert _profile_weight(session, 30) == 176.25
    _ok("omitting update_profile_weight preserves weekly check-in promotion")


def test_checkin_rejects_non_positive_weight():
    """Do not let zero/negative cached values enter profile or check-in storage."""
    print("\n[test] profile/checkin: non-positive weight rejected")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=40, weight_lbs=180.0)
        body = WeeklyCheckInCreate(
            checkin_date=date(2026, 5, 2),
            weight_lbs=0,
            update_profile_weight=False,
            energy=3,
            sleep=3,
            adherence=3,
        )

        try:
            profile_router.weekly_checkin(body, current_user=user, session=session)
            raise AssertionError("expected HTTPException for weight_lbs=0")
        except HTTPException as exc:
            assert exc.status_code == 400
            assert "weight_lbs" in str(exc.detail)

        assert _profile_weight(session, 40) == 180.0
        rows = session.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 40)).all()
        assert rows == []
    _ok("weight_lbs <= 0 is rejected without touching profile/check-ins")


cases = [
    test_profile_me_returns_dumped_profile_payload,
    test_measurement_checkin_does_not_update_profile_weight_when_flag_false,
    test_checkin_defaults_to_updating_profile_weight,
    test_checkin_rejects_non_positive_weight,
]


if __name__ == "__main__":
    import sys

    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
