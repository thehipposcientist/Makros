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
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import HealthSourcePreference, IntegrationCredential, User
from app.services.integrations import (
    get_provider,
    list_providers,
)
from app.services.integrations.base import ProviderNotConfiguredError
from app.services.integrations.sync_helpers import encrypted_token_set
from app.services.imports.strava_client import generate_state_nonce


router = APIRouter(prefix="/integrations", tags=["integrations"])

# State nonce store. In-process map: fine for single-replica dev/staging.
# Move to Redis when we scale horizontally — the nonce TTL is short
# enough that the migration is a one-line swap.
_PENDING_OAUTH_STATES: dict[str, tuple[int, str, float]] = {}
_STATE_TTL_SECONDS = 600
_ALLOWED_SOURCE_PREFS = {
    "auto",
    "apple_health",
    "health_connect",
    "oura",
    "whoop",
    "google_health",
    "fitbit",
    "strava",
    "manual",
    "watch",
}
_PREFERENCE_FIELDS = (
    "sleep_source",
    "readiness_source",
    "hrv_source",
    "resting_hr_source",
    "activity_source",
    "workout_source",
    "body_weight_source",
)


class HealthSourcePreferencePatch(BaseModel):
    sleep_source: str | None = None
    readiness_source: str | None = None
    hrv_source: str | None = None
    resting_hr_source: str | None = None
    activity_source: str | None = None
    workout_source: str | None = None
    body_weight_source: str | None = None


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


def _preference_to_dict(pref: HealthSourcePreference) -> dict:
    return {field: getattr(pref, field) for field in _PREFERENCE_FIELDS}


def _get_or_create_preference(
    db: Session,
    user_id: int,
) -> HealthSourcePreference:
    pref = db.exec(
        select(HealthSourcePreference).where(HealthSourcePreference.user_id == user_id)
    ).first()
    if pref is not None:
        return pref
    pref = HealthSourcePreference(user_id=user_id)
    db.add(pref)
    db.commit()
    db.refresh(pref)
    return pref


@router.get("/preferences")
def get_health_source_preferences(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    pref = _get_or_create_preference(db, current_user.id)
    return {"preferences": _preference_to_dict(pref), "allowed_sources": sorted(_ALLOWED_SOURCE_PREFS)}


@router.patch("/preferences")
def update_health_source_preferences(
    body: HealthSourcePreferencePatch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    pref = _get_or_create_preference(db, current_user.id)
    updates = body.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if field not in _PREFERENCE_FIELDS:
            continue
        normalized = str(value or "auto").strip().lower()
        if normalized not in _ALLOWED_SOURCE_PREFS:
            raise HTTPException(status_code=400, detail=f"{field} source is not supported")
        setattr(pref, field, normalized)
    pref.updated_at = datetime.now(timezone.utc)
    db.add(pref)
    db.commit()
    db.refresh(pref)
    return {"preferences": _preference_to_dict(pref), "allowed_sources": sorted(_ALLOWED_SOURCE_PREFS)}


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
        tokens = encrypted_token_set(prov.exchange_code(code))
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
