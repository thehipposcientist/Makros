"""Username update behavior for account handles."""
from __future__ import annotations

import os
import sys

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-username-auth-123456")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import HTTPException
from sqlmodel import SQLModel, Session, create_engine

from app.models import User
from app.routers import auth as auth_router


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__])
    return engine


def test_update_username_normalizes_and_persists():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(email="user@example.com", username="oldname", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            resp = auth_router.update_username(
                auth_router.UpdateUsernameBody(username=" New_Name "),
                current_user=user,
                session=session,
            )
            session.refresh(user)

            assert resp.username == "new_name"
            assert user.username == "new_name"
    finally:
        engine.dispose()
    print("PASS test_update_username_normalizes_and_persists")


def test_update_username_rejects_case_insensitive_conflict():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(email="user@example.com", username="oldname", hashed_password="x")
            other = User(email="other@example.com", username="taken", hashed_password="x")
            session.add(user)
            session.add(other)
            session.commit()
            session.refresh(user)

            try:
                auth_router.update_username(
                    auth_router.UpdateUsernameBody(username="Taken"),
                    current_user=user,
                    session=session,
                )
            except HTTPException as exc:
                assert exc.status_code == 400
                assert exc.detail == "Username already taken"
            else:
                raise AssertionError("expected username conflict")
    finally:
        engine.dispose()
    print("PASS test_update_username_rejects_case_insensitive_conflict")


def test_update_username_validates_handle_shape():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(email="user@example.com", username="oldname", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            for raw in ("ab", "bad-name", "has space"):
                try:
                    auth_router.update_username(
                        auth_router.UpdateUsernameBody(username=raw),
                        current_user=user,
                        session=session,
                    )
                except HTTPException as exc:
                    assert exc.status_code == 422
                else:
                    raise AssertionError(f"expected validation failure for {raw!r}")
    finally:
        engine.dispose()
    print("PASS test_update_username_validates_handle_shape")

