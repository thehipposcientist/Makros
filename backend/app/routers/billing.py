import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlmodel import Session

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import dummy_billing_enabled, entitlement_payload, refresh_user_entitlement
from app.enums import SubscriptionStatus, SubscriptionTier
from app.models import User
from app.services.billing import apply_revenuecat_event, cancel_signup_trial, sync_user_from_revenuecat

router = APIRouter(prefix="/billing", tags=["billing"])


def _verify_revenuecat_webhook_authorization(authorization: str | None) -> None:
    expected = (os.getenv("REVENUECAT_WEBHOOK_AUTH_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RevenueCat webhook auth is not configured",
        )
    supplied = (authorization or "").strip()
    if supplied.lower().startswith("bearer "):
        supplied = supplied[7:].strip()
    if not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid webhook authorization")


@router.get("/entitlement")
def get_entitlement(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return entitlement_payload(refresh_user_entitlement(current_user, session))


@router.post("/revenuecat/sync")
def sync_revenuecat_entitlement(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = sync_user_from_revenuecat(session, current_user)
    user = refresh_user_entitlement(user, session)
    return entitlement_payload(user)


@router.post("/signup-trial/cancel")
def cancel_signup_trial_entitlement(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    user = refresh_user_entitlement(current_user, session)
    user = cancel_signup_trial(session, user)
    return entitlement_payload(user)


def _require_dummy_billing() -> None:
    if not dummy_billing_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Dummy billing is not enabled in this environment.",
        )


@router.post("/mock-checkout")
def mock_checkout(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """DUMMY upgrade for testing — no real payment is processed and any card
    details from the client are ignored. Grants Pro for 30 days. Gated by
    DUMMY_BILLING_ENABLED so it can never run in production."""
    _require_dummy_billing()
    current_user.subscription_tier = SubscriptionTier.PRO.value
    current_user.subscription_status = SubscriptionStatus.ACTIVE.value
    current_user.subscription_source = "mock"
    current_user.subscription_expires_at = datetime.now(timezone.utc) + timedelta(days=30)
    current_user.trial_started_at = None
    current_user.trial_ends_at = None
    current_user.revenuecat_original_app_user_id = None
    current_user.revenuecat_original_transaction_id = None
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    return entitlement_payload(current_user)


@router.post("/mock-downgrade")
def mock_downgrade(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """DUMMY downgrade for testing — drops the user back to Free. Gated by
    DUMMY_BILLING_ENABLED."""
    _require_dummy_billing()
    current_user.subscription_tier = SubscriptionTier.FREE.value
    current_user.subscription_status = SubscriptionStatus.FREE.value
    current_user.subscription_source = "mock"
    current_user.subscription_product_id = None
    current_user.subscription_entitlement_id = None
    current_user.subscription_store = None
    current_user.subscription_environment = None
    current_user.subscription_expires_at = None
    current_user.trial_started_at = None
    current_user.trial_ends_at = None
    current_user.revenuecat_original_app_user_id = None
    current_user.revenuecat_original_transaction_id = None
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    return entitlement_payload(current_user)


@router.post("/revenuecat/webhook")
async def revenuecat_webhook(
    request: Request,
    authorization: str | None = Header(default=None),
    session: Session = Depends(get_session),
):
    _verify_revenuecat_webhook_authorization(authorization)
    payload: dict[str, Any] = await request.json()
    return apply_revenuecat_event(session, payload)
