"""Email signup registration behavior."""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-register-auth-123456")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import HTTPException
from sqlmodel import SQLModel, Session, create_engine, select

from app.auth import verify_password
from app.enums import Gender
from app.models import LegalAcceptanceEvent, User, UserCreate, UserProfile
from app.routers import auth as auth_router


class _Client:
    host = "127.0.0.1"


class _Request:
    headers = {"user-agent": "register-test-agent"}
    client = _Client()


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(
        engine,
        tables=[User.__table__, UserProfile.__table__, LegalAcceptanceEvent.__table__],
    )
    return engine


def _register(body: UserCreate, session: Session):
    handler = getattr(auth_router.register, "__wrapped__", auth_router.register)
    return handler(body, _Request(), session)


def _body(
    *,
    email: str = "unfinished@example.com",
    username: str | None = "freshname",
    password: str = "newpass123",
) -> UserCreate:
    return UserCreate(
        email=email,
        username=username,
        first_name="Fresh",
        last_name="Start",
        password=password,
        accepted_terms=True,
        accepted_privacy=True,
        accepted_health_disclaimer=True,
        accepted_ai_disclaimer=True,
        legal_version="2026-05-18.1",
    )


def test_register_recycles_unfinished_email_signup():
    engine = _engine()
    original_send = auth_router.send_verification_email
    auth_router.send_verification_email = lambda _email, _token: True
    try:
        with Session(engine) as session:
            abandoned = User(
                email="unfinished@example.com",
                username="oldname",
                hashed_password="old-hash",
                recovery_question="Pet?",
                recovery_answer_hash="old-answer",
                token_version=2,
            )
            session.add(abandoned)
            session.commit()
            session.refresh(abandoned)
            abandoned_id = abandoned.id

            resp = _register(_body(), session)
            recycled = session.exec(select(User).where(User.email == "unfinished@example.com")).first()
            events = session.exec(
                select(LegalAcceptanceEvent).where(LegalAcceptanceEvent.user_id == abandoned_id)
            ).all()

            assert recycled is not None
            assert resp.id == abandoned_id
            assert recycled.id == abandoned_id
            assert recycled.username == "freshname"
            assert recycled.first_name == "Fresh"
            assert recycled.recovery_question is None
            assert recycled.recovery_answer_hash is None
            assert recycled.token_version == 3
            assert recycled.email_verification_token_hash is not None
            assert verify_password("newpass123", recycled.hashed_password)
            assert len(session.exec(select(User)).all()) == 1
            assert len(events) == 1
            assert events[0].source == "email_signup"
    finally:
        auth_router.send_verification_email = original_send
        engine.dispose()
    print("PASS test_register_recycles_unfinished_email_signup")


def test_register_generates_unique_username_when_omitted():
    engine = _engine()
    original_send = auth_router.send_verification_email
    auth_router.send_verification_email = lambda _email, _token: True
    try:
        with Session(engine) as session:
            session.add(User(email="taken@example.com", username="freshnamecoach", hashed_password="x"))
            session.commit()

            resp = _register(_body(email="fresh.name+coach@example.com", username=None), session)
            created = session.exec(select(User).where(User.email == "fresh.name+coach@example.com")).first()

            assert created is not None
            assert resp.username == "freshnamecoach_1"
            assert created.username == "freshnamecoach_1"
            assert verify_password("newpass123", created.hashed_password)
            assert len(session.exec(select(User)).all()) == 2
    finally:
        auth_router.send_verification_email = original_send
        engine.dispose()
    print("PASS test_register_generates_unique_username_when_omitted")


def test_register_preserves_completed_account_email_lock():
    engine = _engine()
    original_send = auth_router.send_verification_email
    auth_router.send_verification_email = lambda _email, _token: True
    try:
        with Session(engine) as session:
            user = User(email="finished@example.com", username="finished", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)
            session.add(
                UserProfile(
                    user_id=user.id,
                    weight_lbs=180,
                    height_feet=5,
                    height_inches=11,
                    age=30,
                    gender=Gender.MALE,
                )
            )
            session.commit()

            try:
                _register(_body(email="finished@example.com", username="othername"), session)
            except HTTPException as exc:
                assert exc.status_code == 400
                assert exc.detail == "Email already registered"
            else:
                raise AssertionError("expected completed account email conflict")
    finally:
        auth_router.send_verification_email = original_send
        engine.dispose()
    print("PASS test_register_preserves_completed_account_email_lock")


cases = [
    test_register_recycles_unfinished_email_signup,
    test_register_generates_unique_username_when_omitted,
    test_register_preserves_completed_account_email_lock,
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
