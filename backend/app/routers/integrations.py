"""Generic wearable integration router.

One set of endpoints — `/integrations/{provider}/...` — that delegates
to the right `WearableProvider` instance from the registry. Adding a
new provider doesn't add routes; it adds one class.

Strava continues to use `/imports/strava/...` for back-compat. Once new
clients adopt this generic surface we can deprecate the strava-specific
routes.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import IntegrationCredential, User
from app.services.integrations import (
    get_provider,
    list_providers,
)
from app.services.integrations.base import ProviderNotConfiguredError
from app.services.imports.strava_client import generate_state_nonce


router = APIRouter(prefix="/integrations", tags=["integrations"])

# State nonce store. In-process map: fine for single-replica dev/staging.
# Move to Redis when we scale horizontally — the nonce TTL is short
# enough that the migration is a one-line swap.
_PENDING_OAUTH_STATES: dict[str, tuple[int, str, float]] = {}
_STATE_TTL_SECONDS = 600


def _purge_expired_states() -> None:
    now = time.time()
    expired = [k for k, (_, _, ts) in _PENDING_OAUTH_STATES.items() if now - ts > _STATE_TTL_SECONDS]
    for k in expired:
        _PENDING_OAUTH_STATES.pop(k, None)


@router.get("")
def list_integrations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """List every supported provider with config + connection status.

    Drives the "Connect" / "Connected" / "Coming soon" tile grid on the
    Settings → Integrations screen. The presence of a token row is the
    source of truth for "connected" — we don't trust the provider's
    revocation webhook to update us synchronously.
    """
    providers = list_providers()
    rows = db.exec(
        select(IntegrationCredential).where(
            IntegrationCredential.user_id == current_user.id,
        )
    ).all()
    connected: dict[str, IntegrationCredential] = {r.provider: r for r in rows}
    for p in providers:
        cred = connected.get(p["slug"])
        p["connected"] = cred is not None and cred.status == "active"
        p["last_synced_at"] = cred.last_synced_at.isoformat() if (cred and cred.last_synced_at) else None
    return {"providers": providers}


@router.get("/{provider}/authorize")
def integration_authorize(
    provider: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    """Return the URL the client should open to start the OAuth grant
    for the given provider. The state nonce protects against CSRF."""
    try:
        prov = get_provider(provider)
    except ProviderNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    state = generate_state_nonce()
    _purge_expired_states()
    _PENDING_OAUTH_STATES[state] = (current_user.id, provider, time.time())
    try:
        url = prov.authorize_url(state)
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    return {"authorize_url": url, "state": state}


@router.get("/{provider}/callback")
def integration_callback(
    provider: str,
    code: str = Query(...),
    state: str = Query(...),
    db: Session = Depends(get_session),
):
    """Provider redirects here after the user grants access. We
    verify the state, exchange the code, and persist the credential."""
    _purge_expired_states()
    pending = _PENDING_OAUTH_STATES.pop(state, None)
    if pending is None:
        raise HTTPException(status_code=400, detail="invalid or expired state")
    user_id, expected_provider, _ts = pending
    if expected_provider != provider:
        raise HTTPException(status_code=400, detail="provider mismatch on callback")

    try:
        prov = get_provider(provider)
    except ProviderNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    try:
        tokens = prov.exchange_code(code)
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"token exchange failed: {e}")

    existing = db.exec(
        select(IntegrationCredential).where(
            IntegrationCredential.user_id == user_id,
            IntegrationCredential.provider == provider,
        )
    ).first()
    now = datetime.now(timezone.utc)
    if existing is None:
        existing = IntegrationCredential(
            user_id=user_id,
            provider=provider,
            access_token=tokens.access_token,
            refresh_token=tokens.refresh_token,
            expires_at=tokens.expires_at,
            external_user_id=tokens.external_user_id,
            extras=tokens.extras,
            status="active",
            created_at=now,
            updated_at=now,
        )
        db.add(existing)
    else:
        existing.access_token = tokens.access_token
        existing.refresh_token = tokens.refresh_token or existing.refresh_token
        existing.expires_at = tokens.expires_at or existing.expires_at
        existing.external_user_id = tokens.external_user_id or existing.external_user_id
        if tokens.extras:
            existing.extras = tokens.extras
        existing.status = "active"
        existing.updated_at = now
    db.commit()

    # Deep-link back into the app's Settings → Integrations screen.
    return RedirectResponse(
        url=f"thallo://integrations/{provider}?connected=1",
        status_code=302,
    )


@router.post("/{provider}/sync")
def integration_sync(
    provider: str,
    days: int = Query(30, ge=1, le=365),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Pull the user's last N days of data from the provider. Idempotent
    — re-running with the same window doesn't duplicate rows."""
    try:
        prov = get_provider(provider)
    except ProviderNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))

    cred = db.exec(
        select(IntegrationCredential).where(
            IntegrationCredential.user_id == current_user.id,
            IntegrationCredential.provider == provider,
        )
    ).first()
    if cred is None or cred.status != "active":
        raise HTTPException(
            status_code=409,
            detail=f"{provider} not connected. Run /integrations/{provider}/authorize first.",
        )

    since = datetime.now(timezone.utc) - timedelta(days=days)
    try:
        result = prov.sync(db, current_user.id, credential=cred, since=since)
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    cred.last_synced_at = datetime.now(timezone.utc)
    db.add(cred)
    db.commit()
    return result.to_dict()


@router.delete("/{provider}")
def integration_disconnect(
    provider: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Disconnect a wearable. Marks the credential row inactive — we
    keep the row so previously-imported activities retain their source
    attribution. To fully delete, the user can request account export +
    deletion via /profile."""
    cred = db.exec(
        select(IntegrationCredential).where(
            IntegrationCredential.user_id == current_user.id,
            IntegrationCredential.provider == provider,
        )
    ).first()
    if cred is None:
        return {"status": "not_connected"}
    cred.status = "revoked"
    cred.updated_at = datetime.now(timezone.utc)
    db.add(cred)
    db.commit()
    return {"status": "disconnected"}
