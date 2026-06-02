from __future__ import annotations

import json
import os
import sys
from contextlib import contextmanager

from cryptography.fernet import Fernet

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import field_encryption


@contextmanager
def _env(**values: str | None):
    old = {key: os.environ.get(key) for key in values}
    try:
        for key, value in values.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        field_encryption._fernet.cache_clear()
        yield
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        field_encryption._fernet.cache_clear()


def test_encrypt_json_round_trips_without_cleartext():
    payload = {
        "userProfile": {"weightLbs": 181, "goal": "build_muscle"},
        "healthSummary": {"sleepHours": 6.7},
    }
    with _env(
        FIELD_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        SECRET_KEY=None,
        DATABASE_URL=None,
    ):
        encrypted = field_encryption.encrypt_json(payload)
        assert field_encryption.is_encrypted_json(encrypted), encrypted
        assert field_encryption.decrypt_json(encrypted) == payload
        serialized = json.dumps(encrypted)
        assert "weightLbs" not in serialized
        assert "sleepHours" not in serialized
    print("PASS test_encrypt_json_round_trips_without_cleartext")


def test_decrypt_json_accepts_legacy_plaintext():
    payload = {"userProfile": {"goal": "strength"}}
    with _env(FIELD_ENCRYPTION_KEY=Fernet.generate_key().decode()):
        assert field_encryption.decrypt_json(payload) == payload
    print("PASS test_decrypt_json_accepts_legacy_plaintext")


def test_encrypt_json_derives_from_secret_when_no_field_key():
    payload = {"mealEdits": {"today": [{"food": "oats"}]}}
    with _env(
        FIELD_ENCRYPTION_KEY=None,
        SECRET_KEY="x" * 64,
        DATABASE_URL=None,
    ):
        encrypted = field_encryption.encrypt_json(payload)
        assert field_encryption.is_encrypted_json(encrypted), encrypted
        assert field_encryption.decrypt_json(encrypted) == payload
    print("PASS test_encrypt_json_derives_from_secret_when_no_field_key")


def test_encrypt_text_round_trips_without_cleartext():
    token = "strava-refresh-token-secret"
    with _env(
        FIELD_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        SECRET_KEY=None,
        DATABASE_URL=None,
    ):
        encrypted = field_encryption.encrypt_text(token)
        assert encrypted != token
        assert field_encryption.is_encrypted_text(encrypted)
        assert "strava" not in encrypted
        assert field_encryption.decrypt_text(encrypted) == token
    print("PASS test_encrypt_text_round_trips_without_cleartext")


def test_strava_token_storage_uses_encrypted_text():
    from datetime import datetime, timedelta, timezone

    from sqlmodel import SQLModel, Session, create_engine, select

    from app.models import IntegrationCredential, User
    from app.services.imports.strava_client import ensure_valid_token, save_tokens_after_exchange

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__, IntegrationCredential.__table__])
    with _env(
        FIELD_ENCRYPTION_KEY=Fernet.generate_key().decode(),
        SECRET_KEY=None,
        DATABASE_URL=None,
    ):
        with Session(engine) as session:
            user = User(email="strava-token@example.com", username="stravatoken", hashed_password="x")
            session.add(user)
            session.commit()
            session.refresh(user)

            cred = save_tokens_after_exchange(
                session,
                user.id,
                {
                    "access_token": "strava-access-clear",
                    "refresh_token": "strava-refresh-clear",
                    "expires_at": int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp()),
                    "athlete": {"id": 123},
                    "scope": "read,activity:read_all",
                },
            )
            assert field_encryption.is_encrypted_text(cred.access_token)
            assert field_encryption.is_encrypted_text(cred.refresh_token)
            assert "strava-access-clear" not in cred.access_token
            assert "strava-refresh-clear" not in cred.refresh_token
            assert ensure_valid_token(session, cred) == "strava-access-clear"

            stored = session.exec(select(IntegrationCredential)).first()
            assert stored is not None
            assert field_encryption.decrypt_text(stored.access_token) == "strava-access-clear"
            assert field_encryption.decrypt_text(stored.refresh_token) == "strava-refresh-clear"
    print("PASS test_strava_token_storage_uses_encrypted_text")


cases = [
    test_encrypt_json_round_trips_without_cleartext,
    test_decrypt_json_accepts_legacy_plaintext,
    test_encrypt_json_derives_from_secret_when_no_field_key,
    test_encrypt_text_round_trips_without_cleartext,
    test_strava_token_storage_uses_encrypted_text,
]


if __name__ == "__main__":
    failed = 0
    for fn in cases:
        try:
            fn()
        except Exception as exc:
            import traceback
            print(f"FAIL {fn.__name__}: {exc}")
            traceback.print_exc()
            failed += 1
    sys.exit(1 if failed else 0)
