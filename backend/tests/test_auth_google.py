"""Google account auth and linking."""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-google-auth-123456")
os.environ.setdefault("GOOGLE_CLIENT_IDS", "google-client-id.apps.googleusercontent.com")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import LegalAcceptanceEvent, User
from app.routers import auth as auth_router


class _Client:
    host = "testclient"


class _Request:
    headers = {}
    client = _Client()


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__, LegalAcceptanceEvent.__table__])
    return engine


def _with_google_claims(claims: dict):
    original = auth_router._verify_google_identity_token
    auth_router._verify_google_identity_token = lambda _token: claims
    return original


def _login_with_google(body: auth_router.GoogleAuthRequest, session: Session):
    handler = getattr(auth_router.login_with_google, "__wrapped__", auth_router.login_with_google)
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


def _set_signup_trial_days(value: str | None):
    previous = os.environ.get("SIGNUP_TRIAL_DAYS")
    if value is None:
        os.environ.pop("SIGNUP_TRIAL_DAYS", None)
    else:
        os.environ["SIGNUP_TRIAL_DAYS"] = value
    return previous


def _restore_signup_trial_days(previous: str | None) -> None:
    if previous is None:
        os.environ.pop("SIGNUP_TRIAL_DAYS", None)
    else:
        os.environ["SIGNUP_TRIAL_DAYS"] = previous


def test_google_login_creates_new_user():
    engine = _engine()
    previous_beta = _set_beta_full_access(None)
    original = _with_google_claims({
        "sub": "google-sub-new",
        "email": "new-google@example.com",
        "email_verified": True,
        "given_name": "Grace",
        "family_name": "Hopper",
    })
    try:
        with Session(engine) as session:
            resp = _login_with_google(
                auth_router.GoogleAuthRequest(
                    identity_token="signed.google.jwt",
                    legal_version="2026-04-29.2",
                    accepted_terms=True,
                    accepted_privacy=True,
                    accepted_health_disclaimer=True,
                    accepted_ai_disclaimer=True,
                ),
                session,
            )
            user = session.exec(select(User).where(User.google_sub == "google-sub-new")).first()
            assert resp.is_new_user is True
            assert resp.access_token
            assert user is not None
            assert user.email == "new-google@example.com"
            assert user.first_name == "Grace"
            assert user.last_name == "Hopper"
            assert user.email_verified_at is not None
            assert user.terms_version == "2026-04-29.2"
            assert user.subscription_tier == "pro"
            assert user.subscription_status == "trialing"
            assert user.trial_ends_at is not None
            event = session.exec(select(LegalAcceptanceEvent).where(LegalAcceptanceEvent.user_id == user.id)).first()
            assert event is not None
            assert event.legal_version == "2026-04-29.2"
            assert event.source == "google_signup"
    finally:
        auth_router._verify_google_identity_token = original
        _restore_beta_full_access(previous_beta)
        engine.dispose()
    print("PASS test_google_login_creates_new_user")


def test_google_login_beta_opt_out_creates_free_user():
    engine = _engine()
    previous_beta = _set_beta_full_access("0")
    previous_trial = _set_signup_trial_days("0")
    original = _with_google_claims({
        "sub": "google-sub-beta",
        "email": "beta-google@example.com",
        "email_verified": True,
    })
    try:
        with Session(engine) as session:
            _login_with_google(
                auth_router.GoogleAuthRequest(
                    identity_token="signed.google.jwt",
                    legal_version="2026-04-29.2",
                    accepted_terms=True,
                    accepted_privacy=True,
                    accepted_health_disclaimer=True,
                    accepted_ai_disclaimer=True,
                ),
                session,
            )
            user = session.exec(select(User).where(User.google_sub == "google-sub-beta")).first()
            assert user is not None
            assert user.subscription_tier == "free"
    finally:
        auth_router._verify_google_identity_token = original
        _restore_signup_trial_days(previous_trial)
        _restore_beta_full_access(previous_beta)
        engine.dispose()
    print("PASS test_google_login_beta_opt_out_creates_free_user")


def test_google_login_rejects_new_user_without_legal_acceptance():
    engine = _engine()
    original = _with_google_claims({
        "sub": "google-sub-no-legal",
        "email": "no-legal-google@example.com",
        "email_verified": True,
    })
    try:
        with Session(engine) as session:
            try:
                _login_with_google(
                    auth_router.GoogleAuthRequest(
                        identity_token="signed.google.jwt",
                        legal_version="2026-04-29.2",
                    ),
                    session,
                )
            except Exception as exc:
                assert getattr(exc, "status_code", None) == 422
            else:
                raise AssertionError("expected missing OAuth legal acceptance to be rejected")
            assert session.exec(select(User).where(User.google_sub == "google-sub-no-legal")).first() is None
    finally:
        auth_router._verify_google_identity_token = original
        engine.dispose()
    print("PASS test_google_login_rejects_new_user_without_legal_acceptance")


def test_google_login_links_existing_email_user():
    engine = _engine()
    original = _with_google_claims({
        "sub": "google-sub-link",
        "email": "pilot@example.com",
        "email_verified": "true",
    })
    try:
        with Session(engine) as session:
            session.add(User(email="pilot@example.com", username="pilot", hashed_password="x"))
            session.commit()
            resp = _login_with_google(
                auth_router.GoogleAuthRequest(identity_token="signed.google.jwt", first_name="Pilot"),
                session,
            )
            user = session.exec(select(User).where(User.email == "pilot@example.com")).first()
            assert resp.is_new_user is False
            assert resp.access_token
            assert user is not None
            assert user.google_sub == "google-sub-link"
            assert user.email_verified_at is not None
            assert user.first_name == "Pilot"
    finally:
        auth_router._verify_google_identity_token = original
        engine.dispose()
    print("PASS test_google_login_links_existing_email_user")


def test_google_login_returns_existing_link_without_email_claim():
    engine = _engine()
    original = _with_google_claims({"sub": "google-sub-returning"})
    try:
        with Session(engine) as session:
            session.add(User(
                email="returning@example.com",
                username="returning",
                hashed_password="x",
                google_sub="google-sub-returning",
            ))
            session.commit()
            resp = _login_with_google(
                auth_router.GoogleAuthRequest(identity_token="signed.google.jwt"),
                session,
            )
            user_count = len(session.exec(select(User)).all())
            assert resp.is_new_user is False
            assert resp.access_token
            assert user_count == 1
    finally:
        auth_router._verify_google_identity_token = original
        engine.dispose()
    print("PASS test_google_login_returns_existing_link_without_email_claim")


def test_google_audience_claim_matching():
    audiences = [
        "web-client.apps.googleusercontent.com",
        "ios-client.apps.googleusercontent.com",
    ]
    assert auth_router._claim_matches_audience("ios-client.apps.googleusercontent.com", audiences)
    assert auth_router._claim_matches_audience(["other", "web-client.apps.googleusercontent.com"], audiences)
    assert not auth_router._claim_matches_audience("other", audiences)
    assert not auth_router._claim_matches_audience(["other"], audiences)
    assert not auth_router._claim_matches_audience(None, audiences)
    print("PASS test_google_audience_claim_matching")
