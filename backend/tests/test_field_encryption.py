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


cases = [
    test_encrypt_json_round_trips_without_cleartext,
    test_decrypt_json_accepts_legacy_plaintext,
    test_encrypt_json_derives_from_secret_when_no_field_key,
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
