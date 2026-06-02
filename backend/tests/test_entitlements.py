"""Subscription entitlement helpers."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from sqlmodel import SQLModel, Session, create_engine

from app.entitlements import (
    default_subscription_tier,
    initialize_signup_entitlement,
    refresh_user_entitlement,
    tier_of,
)
from app.models import User
from app.routers import auth as auth_router


class _User:
    def __init__(
        self,
        subscription_tier=None,
        subscription_status=None,
        trial_ends_at=None,
        subscription_expires_at=None,
    ):
        self.subscription_tier = subscription_tier
        self.subscription_status = subscription_status
        self.trial_ends_at = trial_ends_at
        self.subscription_expires_at = subscription_expires_at


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__])
    return engine


def _set_beta(value: str | None):
    previous = os.environ.get("BETA_FULL_ACCESS_ENABLED")
    if value is None:
        os.environ.pop("BETA_FULL_ACCESS_ENABLED", None)
    else:
        os.environ["BETA_FULL_ACCESS_ENABLED"] = value
    return previous


def _restore_beta(previous: str | None) -> None:
    if previous is None:
        os.environ.pop("BETA_FULL_ACCESS_ENABLED", None)
    else:
        os.environ["BETA_FULL_ACCESS_ENABLED"] = previous


def _set_trial_days(value: str | None):
    previous = os.environ.get("SIGNUP_TRIAL_DAYS")
    if value is None:
        os.environ.pop("SIGNUP_TRIAL_DAYS", None)
    else:
        os.environ["SIGNUP_TRIAL_DAYS"] = value
    return previous


def _restore_trial_days(previous: str | None) -> None:
    if previous is None:
        os.environ.pop("SIGNUP_TRIAL_DAYS", None)
    else:
        os.environ["SIGNUP_TRIAL_DAYS"] = previous


def test_default_subscription_tier_grants_beta_pro():
    previous = _set_beta("1")
    try:
        assert default_subscription_tier() == "pro"
    finally:
        _restore_beta(previous)
    print("PASS test_default_subscription_tier_grants_beta_pro")


def test_beta_flag_can_disable_signup_pro():
    previous = _set_beta("0")
    previous_trial = _set_trial_days("0")
    try:
        assert default_subscription_tier() == "free"
    finally:
        _restore_trial_days(previous_trial)
        _restore_beta(previous)
    print("PASS test_beta_flag_can_disable_signup_pro")


def test_signup_trial_grants_temporary_pro():
    previous_beta = _set_beta("0")
    previous_trial = _set_trial_days("7")
    now = datetime(2026, 5, 18, tzinfo=timezone.utc)
    try:
        user = User(email="trial@example.com", username="trial", hashed_password="x")
        initialize_signup_entitlement(user, now=now)
        assert user.subscription_tier == "pro"
        assert user.subscription_status == "trialing"
        assert user.trial_ends_at == now + timedelta(days=7)
        assert tier_of(user, now=now + timedelta(days=6, hours=23)) == "pro"
        assert tier_of(user, now=now + timedelta(days=8)) == "free"
    finally:
        _restore_trial_days(previous_trial)
        _restore_beta(previous_beta)
    print("PASS test_signup_trial_grants_temporary_pro")


def test_cancelled_signup_trial_keeps_pro_until_trial_end():
    now = datetime(2026, 5, 18, tzinfo=timezone.utc)
    user = User(
        email="trial-cancelled@example.com",
        username="trial_cancelled",
        hashed_password="x",
        subscription_tier="pro",
        subscription_status="trial_cancelled",
        subscription_source="signup_trial",
        trial_started_at=now - timedelta(days=2),
        trial_ends_at=now + timedelta(days=5),
        subscription_expires_at=now + timedelta(days=5),
    )
    assert tier_of(user, now=now) == "pro"
    assert tier_of(user, now=now + timedelta(days=6)) == "free"
    print("PASS test_cancelled_signup_trial_keeps_pro_until_trial_end")


def test_unknown_tier_normalizes_to_free():
    assert tier_of(_User(None)) == "free"
    assert tier_of(_User("paid")) == "free"
    assert tier_of(_User("pro")) == "pro"
    print("PASS test_unknown_tier_normalizes_to_free")


def test_unknown_status_fails_closed():
    assert tier_of(_User("pro", "typo_active")) == "free"
    assert tier_of(_User("pro", "free")) == "free"
    print("PASS test_unknown_status_fails_closed")


def test_trial_requires_future_end_date():
    now = datetime(2026, 5, 18, tzinfo=timezone.utc)
    assert tier_of(_User("pro", "trialing"), now=now) == "free"
    assert tier_of(
        _User("pro", "trialing", trial_ends_at=now + timedelta(days=1)),
        now=now,
    ) == "pro"
    print("PASS test_trial_requires_future_end_date")


def test_expiring_pro_statuses_honor_expiry():
    now = datetime(2026, 5, 18, tzinfo=timezone.utc)
    assert tier_of(
        _User("pro", "temporary", subscription_expires_at=now + timedelta(days=1)),
        now=now,
    ) == "pro"
    assert tier_of(
        _User("pro", "promotional", subscription_expires_at=now - timedelta(seconds=1)),
        now=now,
    ) == "free"
    print("PASS test_expiring_pro_statuses_honor_expiry")


def test_auth_me_repairs_beta_free_user():
    previous = _set_beta("1")
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(
                email="beta-repair@example.com",
                username="beta_repair",
                hashed_password="x",
                subscription_tier="free",
            )
            session.add(user)
            session.commit()
            session.refresh(user)
            resp = auth_router.me(user, session)
            refreshed = session.get(User, user.id)
            assert resp.subscription_tier == "pro"
            assert refreshed is not None
            assert refreshed.subscription_tier == "pro"
    finally:
        engine.dispose()
        _restore_beta(previous)
    print("PASS test_auth_me_repairs_beta_free_user")


def test_auth_me_expires_elapsed_trial():
    previous_beta = _set_beta("0")
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(
                email="expired-trial@example.com",
                username="expired_trial",
                hashed_password="x",
                subscription_tier="pro",
                subscription_status="trialing",
                trial_started_at=datetime.now(timezone.utc) - timedelta(days=9),
                trial_ends_at=datetime.now(timezone.utc) - timedelta(days=2),
                subscription_expires_at=datetime.now(timezone.utc) - timedelta(days=2),
            )
            session.add(user)
            session.commit()
            session.refresh(user)
            refreshed = refresh_user_entitlement(user, session)
            assert refreshed.subscription_tier == "free"
            assert refreshed.subscription_status == "expired"
    finally:
        engine.dispose()
        _restore_beta(previous_beta)
    print("PASS test_auth_me_expires_elapsed_trial")


cases = [
    test_default_subscription_tier_grants_beta_pro,
    test_beta_flag_can_disable_signup_pro,
    test_signup_trial_grants_temporary_pro,
    test_cancelled_signup_trial_keeps_pro_until_trial_end,
    test_unknown_tier_normalizes_to_free,
    test_unknown_status_fails_closed,
    test_trial_requires_future_end_date,
    test_expiring_pro_statuses_honor_expiry,
    test_auth_me_repairs_beta_free_user,
    test_auth_me_expires_elapsed_trial,
]


if __name__ == "__main__":
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as exc:
            failures += 1
            print(f"FAIL {case.__name__}: {exc}")
    raise SystemExit(0 if failures == 0 else 1)
