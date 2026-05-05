"""Sign in with Apple account linking.

These tests stub Apple's token verifier so the auth route can be exercised
without a network call while still covering user creation and account linking.
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-apple-auth-123456")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import User
from app.routers import auth as auth_router


class _Client:
    host = "testclient"


class _Request:
    headers = {}
    client = _Client()


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__])
    return engine


def _with_apple_claims(claims: dict):
    original = auth_router._verify_apple_identity_token
    auth_router._verify_apple_identity_token = lambda _token: claims
    return original


def _login_with_apple(body: auth_router.AppleAuthRequest, session: Session):
    handler = getattr(auth_router.login_with_apple, "__wrapped__", auth_router.login_with_apple)
    return handler(body, _Request(), session)


def _set_beta_full_access(value: str | None):
    previous = os.environ.get("BETA_FULL_ACCESS_ENABLED")
    if value is None:
        os.environ.pop("BETA_FULL_ACCESS_ENABLED", None)
    else:
        os.environ["BETA_FULL_ACCESS_ENABLED"] = value
    return previous


def _restore_beta_full_access(previous: str | None) -> None:
    if previous is None:
        os.environ.pop("BETA_FULL_ACCESS_ENABLED", None)
    else:
        os.environ["BETA_FULL_ACCESS_ENABLED"] = previous


def test_apple_login_creates_new_user():
    engine = _engine()
    previous_beta = _set_beta_full_access(None)
    original = _with_apple_claims({
        "sub": "apple-sub-new",
        "email": "new-user@privaterelay.appleid.com",
        "email_verified": "true",
    })
    try:
        with Session(engine) as session:
            resp = _login_with_apple(
                auth_router.AppleAuthRequest(
                    identity_token="signed.apple.jwt",
                    first_name="Ada",
                    last_name="Lovelace",
                    legal_version="2026-04-29.2",
                ),
                session,
            )
            user = session.exec(select(User).where(User.apple_sub == "apple-sub-new")).first()
            assert resp.is_new_user is True
            assert resp.access_token
            assert user is not None
            assert user.email == "new-user@privaterelay.appleid.com"
            assert user.first_name == "Ada"
            assert user.last_name == "Lovelace"
            assert user.email_verified_at is not None
            assert user.terms_version == "2026-04-29.2"
            assert user.subscription_tier == "pro"
    finally:
        auth_router._verify_apple_identity_token = original
        _restore_beta_full_access(previous_beta)
        engine.dispose()
    print("PASS test_apple_login_creates_new_user")


def test_apple_login_beta_opt_out_creates_free_user():
    engine = _engine()
    previous_beta = _set_beta_full_access("0")
    original = _with_apple_claims({
        "sub": "apple-sub-beta",
        "email": "beta-user@privaterelay.appleid.com",
        "email_verified": "true",
    })
    try:
        with Session(engine) as session:
            _login_with_apple(
                auth_router.AppleAuthRequest(
                    identity_token="signed.apple.jwt",
                    legal_version="2026-04-29.2",
                ),
                session,
            )
            user = session.exec(select(User).where(User.apple_sub == "apple-sub-beta")).first()
            assert user is not None
            assert user.subscription_tier == "free"
    finally:
        auth_router._verify_apple_identity_token = original
        _restore_beta_full_access(previous_beta)
        engine.dispose()
    print("PASS test_apple_login_beta_opt_out_creates_free_user")


def test_apple_login_links_existing_email_user():
    engine = _engine()
    original = _with_apple_claims({
        "sub": "apple-sub-link",
        "email": "pilot@example.com",
        "email_verified": True,
    })
    try:
        with Session(engine) as session:
            session.add(User(email="pilot@example.com", username="pilot", hashed_password="x"))
            session.commit()
            resp = _login_with_apple(
                auth_router.AppleAuthRequest(identity_token="signed.apple.jwt", first_name="Pilot"),
                session,
            )
            user = session.exec(select(User).where(User.email == "pilot@example.com")).first()
            assert resp.is_new_user is False
            assert resp.access_token
            assert user is not None
            assert user.apple_sub == "apple-sub-link"
            assert user.email_verified_at is not None
            assert user.first_name == "Pilot"
    finally:
        auth_router._verify_apple_identity_token = original
        engine.dispose()
    print("PASS test_apple_login_links_existing_email_user")


def test_apple_login_returns_existing_link_without_email_claim():
    engine = _engine()
    original = _with_apple_claims({"sub": "apple-sub-returning"})
    try:
        with Session(engine) as session:
            session.add(User(
                email="returning@example.com",
                username="returning",
                hashed_password="x",
                apple_sub="apple-sub-returning",
            ))
            session.commit()
            resp = _login_with_apple(
                auth_router.AppleAuthRequest(identity_token="signed.apple.jwt"),
                session,
            )
            user_count = len(session.exec(select(User)).all())
            assert resp.is_new_user is False
            assert resp.access_token
            assert user_count == 1
    finally:
        auth_router._verify_apple_identity_token = original
        engine.dispose()
    print("PASS test_apple_login_returns_existing_link_without_email_claim")
