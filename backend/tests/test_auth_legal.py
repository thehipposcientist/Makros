"""Legal acceptance audit trail."""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-legal-auth-123456")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import LegalAcceptanceEvent, User
from app.routers import auth as auth_router


class _Client:
    host = "127.0.0.1"


class _Request:
    headers = {"user-agent": "legal-test-agent"}
    client = _Client()


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__, LegalAcceptanceEvent.__table__])
    return engine


def test_accept_legal_stamps_current_fields_and_history():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(email="legal@example.com", username="legaluser", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            version = auth_router.LEGAL_VERSION
            resp = auth_router.accept_legal(
                auth_router.AcceptLegalRequest(
                    legal_version=version,
                    accepted_terms=True,
                    accepted_privacy=True,
                    accepted_health_disclaimer=True,
                    accepted_ai_disclaimer=True,
                ),
                _Request(),
                current_user=user,
                session=session,
            )
            session.refresh(user)
            events = session.exec(
                select(LegalAcceptanceEvent).where(LegalAcceptanceEvent.user_id == user.id)
            ).all()

            assert resp.legal_accepted is True
            assert user.terms_version == version
            assert user.privacy_version == version
            assert user.health_disclaimer_version == version
            assert user.ai_disclaimer_version == version
            assert len(events) == 1
            assert events[0].source == "re_acceptance"
            assert events[0].legal_version == version
            assert events[0].client_ip == "127.0.0.1"
            assert events[0].user_agent == "legal-test-agent"
    finally:
        engine.dispose()
    print("PASS test_accept_legal_stamps_current_fields_and_history")


def test_accept_legal_rejects_partial_acceptance():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(email="legal2@example.com", username="legaluser2", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            try:
                auth_router.accept_legal(
                    auth_router.AcceptLegalRequest(
                        legal_version=auth_router.LEGAL_VERSION,
                        accepted_terms=True,
                        accepted_privacy=True,
                        accepted_health_disclaimer=True,
                        accepted_ai_disclaimer=False,
                    ),
                    _Request(),
                    current_user=user,
                    session=session,
                )
            except Exception as exc:
                assert getattr(exc, "status_code", None) == 422
            else:
                raise AssertionError("expected partial legal acceptance rejection")

            events = session.exec(
                select(LegalAcceptanceEvent).where(LegalAcceptanceEvent.user_id == user.id)
            ).all()
            assert events == []
    finally:
        engine.dispose()
    print("PASS test_accept_legal_rejects_partial_acceptance")


def test_accept_legal_rejects_omitted_acceptance_flags():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(email="legal3@example.com", username="legaluser3", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            try:
                auth_router.accept_legal(
                    auth_router.AcceptLegalRequest(legal_version=auth_router.LEGAL_VERSION),
                    _Request(),
                    current_user=user,
                    session=session,
                )
            except Exception as exc:
                assert getattr(exc, "status_code", None) == 422
            else:
                raise AssertionError("expected omitted legal flags to be rejected")
    finally:
        engine.dispose()
    print("PASS test_accept_legal_rejects_omitted_acceptance_flags")


cases = [
    test_accept_legal_stamps_current_fields_and_history,
    test_accept_legal_rejects_partial_acceptance,
    test_accept_legal_rejects_omitted_acceptance_flags,
]
