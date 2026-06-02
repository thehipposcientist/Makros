"""Strava API client.

Owns the OAuth handshake + activity backfill. Token refresh happens
transparently on every authenticated request (Strava access tokens
last 6 hours; we refresh on demand rather than scheduling).

This module reads two environment variables at runtime:
  STRAVA_CLIENT_ID      — issued when you register an app at
                          https://www.strava.com/settings/api
  STRAVA_CLIENT_SECRET  — same place
  STRAVA_REDIRECT_URI   — optional override; defaults to
                          {BASE_URL}/imports/strava/callback

Without those env vars, the authorize URL still generates so the
frontend can show users the connect button — but the backend will
500 on the callback. That's the intended dev affordance until
secrets are wired.

The router (`routers/imports.py`) exposes:
  GET  /imports/strava/authorize     → redirect URL with state nonce
  GET  /imports/strava/callback      → token exchange + persist
  POST /imports/strava/backfill      → kick off activity import
"""

from __future__ import annotations

import os
import secrets
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from sqlmodel import Session, select

from app.field_encryption import decrypt_text, encrypt_text
from app.models import IntegrationCredential


_AUTH_URL = "https://www.strava.com/oauth/authorize"
_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token"
_API_BASE = "https://www.strava.com/api/v3"
# Strava requires "activity:read_all" to read historical private
# activities. "read" is for non-activity profile data. We ask for both
# upfront so a single grant covers everything.
_SCOPES = "read,activity:read_all"


def _env_creds() -> tuple[str | None, str | None, str]:
    client_id = os.environ.get("STRAVA_CLIENT_ID")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    # Redirect URI must match what's registered at strava.com/settings/api.
    redirect_uri = os.environ.get(
        "STRAVA_REDIRECT_URI",
        "https://api.thallo.app/imports/strava/callback",
    )
    return client_id, client_secret, redirect_uri


def build_authorize_url(state: str) -> str | None:
    """Return the URL the frontend should open to start the OAuth
    grant. Returns `None` when STRAVA_CLIENT_ID isn't configured, so
    the router can return a clean 503."""
    client_id, _, redirect_uri = _env_creds()
    if not client_id:
        return None
    params = {
        "client_id": client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "approval_prompt": "auto",
        "scope": _SCOPES,
        "state": state,
    }
    return f"{_AUTH_URL}?{urlencode(params)}"


def generate_state_nonce() -> str:
    """CSRF protection — the router stashes this in a short-TTL store
    keyed by user, then verifies it matches when Strava redirects back."""
    return secrets.token_urlsafe(24)


def exchange_code_for_tokens(code: str) -> dict[str, Any]:
    """POST /oauth/token with grant_type=authorization_code. Returns
    the full Strava response (includes athlete + tokens + expires_at)."""
    client_id, client_secret, _ = _env_creds()
    if not client_id or not client_secret:
        raise RuntimeError("STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not configured")
    resp = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    """POST /oauth/token with grant_type=refresh_token. Strava
    rotates the refresh token on every refresh — the response
    contains a new one that must be persisted."""
    client_id, client_secret, _ = _env_creds()
    if not client_id or not client_secret:
        raise RuntimeError("STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET not configured")
    resp = httpx.post(
        _TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def ensure_valid_token(session: Session, cred: IntegrationCredential) -> str:
    """Returns a valid access token. Refreshes in-place + persists the
    new tokens when the stored one is within 60s of expiry."""
    now = datetime.now(timezone.utc)
    access_token = decrypt_text(cred.access_token)
    refresh_token = decrypt_text(cred.refresh_token)
    expires_at = cred.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    needs_refresh = (
        access_token is None
        or expires_at is None
        or (expires_at - now).total_seconds() < 60
    )
    if not needs_refresh:
        return access_token

    if not refresh_token:
        raise RuntimeError("no refresh token stored — user must reconnect")

    refreshed = refresh_access_token(refresh_token)
    next_refresh_token = refreshed.get("refresh_token", refresh_token)
    access_token = refreshed["access_token"]
    cred.access_token = encrypt_text(access_token)
    cred.refresh_token = encrypt_text(next_refresh_token)
    cred.expires_at = datetime.fromtimestamp(refreshed["expires_at"], tz=timezone.utc)
    cred.updated_at = now
    session.add(cred)
    session.commit()
    return access_token


def fetch_activities_page(
    access_token: str,
    page: int,
    per_page: int = 100,
    after_ts: int | None = None,
) -> list[dict[str, Any]]:
    """GET /athlete/activities. Strava paginates with `page` (1-indexed)
    + `per_page` (max 200, but 100 keeps each request fast)."""
    params: dict[str, Any] = {"page": page, "per_page": per_page}
    if after_ts is not None:
        params["after"] = after_ts
    resp = httpx.get(
        f"{_API_BASE}/athlete/activities",
        headers={"Authorization": f"Bearer {access_token}"},
        params=params,
        timeout=20.0,
    )
    resp.raise_for_status()
    return resp.json()


def get_user_credential(
    session: Session,
    user_id: int,
    provider: str = "strava",
) -> IntegrationCredential | None:
    return session.exec(
        select(IntegrationCredential).where(
            IntegrationCredential.user_id == user_id,
            IntegrationCredential.provider == provider,
        )
    ).first()


def save_tokens_after_exchange(
    session: Session,
    user_id: int,
    token_response: dict[str, Any],
) -> IntegrationCredential:
    """Persist the result of `exchange_code_for_tokens` as a new (or
    updated) IntegrationCredential row."""
    now = datetime.now(timezone.utc)
    athlete = token_response.get("athlete") or {}
    expires_at = datetime.fromtimestamp(token_response["expires_at"], tz=timezone.utc)
    cred = get_user_credential(session, user_id, "strava")
    if cred is None:
        cred = IntegrationCredential(
            user_id=user_id,
            provider="strava",
            access_token=encrypt_text(token_response["access_token"]),
            refresh_token=encrypt_text(token_response["refresh_token"]),
            expires_at=expires_at,
            external_user_id=str(athlete.get("id")) if athlete.get("id") else None,
            extras={"scope": token_response.get("scope")} if token_response.get("scope") else None,
            status="active",
            created_at=now,
            updated_at=now,
        )
    else:
        cred.access_token = encrypt_text(token_response["access_token"])
        cred.refresh_token = encrypt_text(token_response["refresh_token"])
        cred.expires_at = expires_at
        cred.external_user_id = str(athlete.get("id")) if athlete.get("id") else cred.external_user_id
        cred.status = "active"
        cred.updated_at = now
    session.add(cred)
    session.commit()
    session.refresh(cred)
    return cred
