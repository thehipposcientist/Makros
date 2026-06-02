from __future__ import annotations

import base64
import hashlib
import json
import os
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv


ENCRYPTED_JSON_MARKER = "__thallo_encrypted__"
ENCRYPTED_JSON_VERSION = 1
ENCRYPTED_TEXT_PREFIX = "__thallo_encrypted_text__:v1:"


class FieldEncryptionError(RuntimeError):
    pass


load_dotenv()


def _derive_fernet_key(secret: str) -> bytes:
    return base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())


@lru_cache(maxsize=1)
def _fernet() -> Fernet | None:
    raw_key = os.getenv("FIELD_ENCRYPTION_KEY")
    if raw_key:
        try:
            return Fernet(raw_key.encode("utf-8"))
        except (TypeError, ValueError) as exc:
            raise FieldEncryptionError(
                "FIELD_ENCRYPTION_KEY must be a Fernet key. Generate one with "
                "`python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\"`."
            ) from exc

    secret = os.getenv("SECRET_KEY")
    if secret and len(secret) >= 32:
        return Fernet(_derive_fernet_key(secret))

    if os.getenv("FIELD_ENCRYPTION_REQUIRED") == "1" or os.getenv("DATABASE_URL", "").startswith("postgres"):
        raise FieldEncryptionError("FIELD_ENCRYPTION_KEY or a >=32 character SECRET_KEY is required")

    return None


def is_encrypted_json(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get(ENCRYPTED_JSON_MARKER) == ENCRYPTED_JSON_VERSION
        and isinstance(value.get("ciphertext"), str)
    )


def encrypt_json(value: Any) -> Any:
    fernet = _fernet()
    if fernet is None:
        return value
    plaintext = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {
        ENCRYPTED_JSON_MARKER: ENCRYPTED_JSON_VERSION,
        "alg": "Fernet",
        "kid": os.getenv("FIELD_ENCRYPTION_KEY_ID", "default"),
        "ciphertext": fernet.encrypt(plaintext).decode("utf-8"),
    }


def decrypt_json(value: Any) -> Any:
    if not is_encrypted_json(value):
        return value
    fernet = _fernet()
    if fernet is None:
        raise FieldEncryptionError("Encrypted payload cannot be decrypted because field encryption is unavailable")
    try:
        plaintext = fernet.decrypt(value["ciphertext"].encode("utf-8"))
        return json.loads(plaintext.decode("utf-8"))
    except (InvalidToken, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise FieldEncryptionError("Encrypted payload could not be decrypted") from exc


def is_encrypted_text(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(ENCRYPTED_TEXT_PREFIX)


def encrypt_text(value: str | None) -> str | None:
    if value is None:
        return None
    fernet = _fernet()
    if fernet is None:
        return value
    ciphertext = fernet.encrypt(value.encode("utf-8")).decode("utf-8")
    return f"{ENCRYPTED_TEXT_PREFIX}{ciphertext}"


def decrypt_text(value: str | None) -> str | None:
    if value is None or not is_encrypted_text(value):
        return value
    fernet = _fernet()
    if fernet is None:
        raise FieldEncryptionError("Encrypted text cannot be decrypted because field encryption is unavailable")
    ciphertext = value[len(ENCRYPTED_TEXT_PREFIX):]
    try:
        return fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError) as exc:
        raise FieldEncryptionError("Encrypted text could not be decrypted") from exc
