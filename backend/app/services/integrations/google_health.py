"""Google Health API provider.

Google Health is the successor path for Fitbit Web API data. OAuth can be
wired once the Google Cloud project has approved Health API scopes; sync stays
guarded until those scopes and data-bundle endpoints are confirmed for Thallo.
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from urllib.parse import urlencode

import httpx

from app.services.integrations.base import SyncResult, TokenSet, WearableProvider
from app.services.integrations.sync_helpers import token_expires_at


_GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"


def _env() -> tuple[str, str, str, str]:
    return (
        os.getenv("GOOGLE_HEALTH_CLIENT_ID", ""),
        os.getenv("GOOGLE_HEALTH_CLIENT_SECRET", ""),
        os.getenv("GOOGLE_HEALTH_REDIRECT_URI", ""),
        os.getenv("GOOGLE_HEALTH_SCOPES", ""),
    )


def _request_token(data: dict[str, str]) -> dict[str, Any]:
    client_id, client_secret, _redirect, _scopes = _env()
    resp = httpx.post(
        _GOOGLE_TOKEN_URL,
        data={**data, "client_id": client_id, "client_secret": client_secret},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=20.0,
    )
    resp.raise_for_status()
    return resp.json()


class GoogleHealthProvider(WearableProvider):
    slug = "google_health"
    display_name = "Google Health"
    capabilities = ("activities", "heart_rate", "sleep", "vo2_max", "body_weight")

    @property
    def is_configured(self) -> bool:
        client_id, client_secret, redirect_uri, scopes = _env()
        return bool(client_id and client_secret and redirect_uri and scopes)

    def authorize_url(self, state: str) -> str:
        client_id, _client_secret, redirect_uri, scopes = _env()
        return f"{_GOOGLE_AUTHORIZE_URL}?" + urlencode({
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scopes,
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        })

    def exchange_code(self, code: str) -> TokenSet:
        _client_id, _client_secret, redirect_uri, _scopes = _env()
        raw = _request_token({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        })
        return TokenSet(
            access_token=raw.get("access_token") or "",
            refresh_token=raw.get("refresh_token"),
            expires_at=token_expires_at(raw.get("expires_in")),
            extras={"scope": raw.get("scope"), "token_type": raw.get("token_type")},
        )

    def refresh(self, refresh_token: str) -> TokenSet:
        raw = _request_token({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        })
        return TokenSet(
            access_token=raw.get("access_token") or "",
            refresh_token=raw.get("refresh_token") or refresh_token,
            expires_at=token_expires_at(raw.get("expires_in")),
            extras={"scope": raw.get("scope"), "token_type": raw.get("token_type")},
        )

    def sync(self, db: Any, user_id: int, *, credential: Any, since: datetime) -> SyncResult:
        raise NotImplementedError(
            "Google Health OAuth is scaffolded, but sync needs approved Google Health API scopes and data-bundle endpoints."
        )
