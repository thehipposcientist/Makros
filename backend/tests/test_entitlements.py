"""Subscription entitlement helpers."""
from __future__ import annotations

import os

from sqlmodel import SQLModel, Session, create_engine

from app.entitlements import default_subscription_tier, tier_of
from app.models import User
from app.routers import auth as auth_router


class _User:
    def __init__(self, subscription_tier=None):
        self.subscription_tier = subscription_tier


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


def test_default_subscription_tier_grants_beta_pro():
    previous = _set_beta(None)
    try:
        assert default_subscription_tier() == "pro"
    finally:
        _restore_beta(previous)
    print("PASS test_default_subscription_tier_grants_beta_pro")


def test_beta_flag_can_disable_signup_pro():
    previous = _set_beta("0")
    try:
        assert default_subscription_tier() == "free"
    finally:
        _restore_beta(previous)
    print("PASS test_beta_flag_can_disable_signup_pro")


def test_unknown_tier_normalizes_to_free():
    assert tier_of(_User(None)) == "free"
    assert tier_of(_User("paid")) == "free"
    assert tier_of(_User("pro")) == "pro"
    print("PASS test_unknown_tier_normalizes_to_free")


def test_auth_me_repairs_beta_free_user():
    previous = _set_beta(None)
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


cases = [
    test_default_subscription_tier_grants_beta_pro,
    test_beta_flag_can_disable_signup_pro,
    test_unknown_tier_normalizes_to_free,
    test_auth_me_repairs_beta_free_user,
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
