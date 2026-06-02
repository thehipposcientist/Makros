from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import os
import requests
from fastapi import HTTPException, status
from sqlmodel import Session, select

from app.entitlements import (
    entitlement_payload,
    revenuecat_app_user_id,
    revenuecat_entitlement_id,
    user_id_from_revenuecat_app_user_id,
)
from app.enums import SubscriptionStatus, SubscriptionTier
from app.models import BillingEvent, User

REVENUECAT_API_BASE = "https://api.revenuecat.com/v1"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def _ms_to_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None


def _iso_to_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _event_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    event = payload.get("event")
    return event if isinstance(event, dict) else payload


def _event_id(event: dict[str, Any]) -> str:
    explicit = str(event.get("id") or "").strip()
    if explicit:
        return explicit
    parts = [
        str(event.get("type") or "UNKNOWN"),
        str(event.get("transaction_id") or event.get("original_transaction_id") or ""),
        str(event.get("event_timestamp_ms") or ""),
    ]
    return ":".join(parts)


def _entitlement_ids(event: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    raw_ids = event.get("entitlement_ids")
    if isinstance(raw_ids, list):
        ids.update(str(item).strip() for item in raw_ids if str(item or "").strip())
    raw_id = str(event.get("entitlement_id") or "").strip()
    if raw_id:
        ids.add(raw_id)
    return ids


def _has_pro_entitlement(event: dict[str, Any]) -> bool:
    ids = _entitlement_ids(event)
    return not ids or revenuecat_entitlement_id() in ids


def _candidate_user_ids(event: dict[str, Any]) -> list[int]:
    candidates: list[int] = []
    for value in [event.get("app_user_id"), event.get("original_app_user_id")]:
        user_id = user_id_from_revenuecat_app_user_id(str(value or ""))
        if user_id is not None and user_id not in candidates:
            candidates.append(user_id)
    aliases = event.get("aliases")
    if isinstance(aliases, list):
        for alias in aliases:
            user_id = user_id_from_revenuecat_app_user_id(str(alias or ""))
            if user_id is not None and user_id not in candidates:
                candidates.append(user_id)
    return candidates


def _find_revenuecat_user(session: Session, event: dict[str, Any]) -> User | None:
    for user_id in _candidate_user_ids(event):
        user = session.get(User, user_id)
        if user is not None:
            return user
    return None


def _set_revenuecat_fields(
    user: User,
    event: dict[str, Any],
    *,
    tier: str,
    status: str,
    expires_at: datetime | None,
) -> None:
    user.subscription_tier = tier
    user.subscription_status = status
    user.subscription_source = "revenuecat"
    user.subscription_product_id = str(event.get("product_id") or event.get("new_product_id") or "") or None
    user.subscription_entitlement_id = revenuecat_entitlement_id()
    user.subscription_store = str(event.get("store") or "") or None
    user.subscription_environment = str(event.get("environment") or "") or None
    user.subscription_expires_at = expires_at
    user.revenuecat_original_app_user_id = str(event.get("original_app_user_id") or "") or None
    user.revenuecat_original_transaction_id = str(event.get("original_transaction_id") or "") or None


def cancel_signup_trial(session: Session, user: User) -> User:
    now = _now()
    source = (user.subscription_source or "").strip().lower()
    status_value = (user.subscription_status or "").strip().lower()
    trial_ends_at = _as_utc(user.trial_ends_at)

    if source == "revenuecat":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Store-managed trials must be changed in the App Store or Google Play.",
        )
    if status_value not in {SubscriptionStatus.TRIALING.value, SubscriptionStatus.TRIAL_CANCELLED.value} or trial_ends_at is None or trial_ends_at <= now:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No active signup trial to cancel.",
        )

    user.subscription_tier = SubscriptionTier.FREE.value
    user.subscription_status = SubscriptionStatus.FREE.value
    user.subscription_source = "signup_trial"
    user.subscription_product_id = None
    user.subscription_entitlement_id = None
    user.subscription_store = None
    user.subscription_environment = None
    user.subscription_expires_at = None
    user.trial_started_at = None
    user.trial_ends_at = None
    user.revenuecat_original_app_user_id = None
    user.revenuecat_original_transaction_id = None
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def apply_revenuecat_event(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    event = _event_from_payload(payload)
    event_type = str(event.get("type") or "UNKNOWN").strip().upper()
    event_id = _event_id(event)
    existing = session.exec(
        select(BillingEvent).where(
            BillingEvent.provider == "revenuecat",
            BillingEvent.event_id == event_id,
        )
    ).first()
    if existing is not None:
        return {"status": "duplicate", "event_type": event_type}

    user = _find_revenuecat_user(session, event)
    app_user_id = str(event.get("app_user_id") or event.get("original_app_user_id") or "") or None
    session.add(BillingEvent(
        provider="revenuecat",
        event_id=event_id,
        event_type=event_type,
        app_user_id=app_user_id,
        user_id=user.id if user else None,
        payload=payload,
    ))

    if user is None or event_type == "TEST" or not _has_pro_entitlement(event):
        session.commit()
        return {"status": "ignored", "event_type": event_type, "user_id": user.id if user else None}

    expires_at = _ms_to_datetime(
        event.get("grace_period_expiration_at_ms")
        if event_type == "BILLING_ISSUE" and event.get("grace_period_expiration_at_ms") is not None
        else event.get("expiration_at_ms")
    )
    now = _now()

    if event_type == "EXPIRATION":
        _set_revenuecat_fields(user, event, tier=SubscriptionTier.FREE.value, status=SubscriptionStatus.EXPIRED.value, expires_at=expires_at)
    elif event_type == "BILLING_ISSUE" and expires_at is not None and expires_at > now:
        _set_revenuecat_fields(user, event, tier=SubscriptionTier.PRO.value, status=SubscriptionStatus.GRACE_PERIOD.value, expires_at=expires_at)
    elif event_type == "CANCELLATION":
        active = expires_at is None or expires_at > now
        _set_revenuecat_fields(
            user,
            event,
            tier=SubscriptionTier.PRO.value if active else SubscriptionTier.FREE.value,
            status=SubscriptionStatus.CANCELLED.value if active else SubscriptionStatus.EXPIRED.value,
            expires_at=expires_at,
        )
    elif event_type in {
        "INITIAL_PURCHASE",
        "RENEWAL",
        "NON_RENEWING_PURCHASE",
        "PRODUCT_CHANGE",
        "UNCANCELLATION",
        "SUBSCRIPTION_EXTENDED",
        "TEMPORARY_ENTITLEMENT_GRANT",
        "REFUND_REVERSED",
    }:
        status = SubscriptionStatus.TRIALING.value if str(event.get("period_type") or "").upper() == "TRIAL" else SubscriptionStatus.ACTIVE.value
        if status == SubscriptionStatus.TRIALING.value:
            user.trial_started_at = _ms_to_datetime(event.get("purchased_at_ms")) or user.trial_started_at
            user.trial_ends_at = expires_at
        _set_revenuecat_fields(user, event, tier=SubscriptionTier.PRO.value, status=status, expires_at=expires_at)
    elif event_type == "SUBSCRIPTION_PAUSED":
        active = expires_at is None or expires_at > now
        if active:
            _set_revenuecat_fields(user, event, tier=SubscriptionTier.PRO.value, status=SubscriptionStatus.CANCELLED.value, expires_at=expires_at)

    session.add(user)
    session.commit()
    session.refresh(user)
    if _revenuecat_secret_api_key():
        user = sync_user_from_revenuecat(session, user)
    return {"status": "processed", "event_type": event_type, "user_id": user.id, **entitlement_payload(user)}


def _revenuecat_secret_api_key() -> str | None:
    return (os.getenv("REVENUECAT_SECRET_API_KEY") or "").strip() or None


def fetch_revenuecat_subscriber(app_user_id: str) -> dict[str, Any] | None:
    api_key = _revenuecat_secret_api_key()
    if not api_key:
        return None
    url = f"{REVENUECAT_API_BASE}/subscribers/{quote(app_user_id, safe='')}"
    resp = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=8)
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, dict) else None


def sync_user_from_revenuecat(session: Session, user: User) -> User:
    app_user_id = revenuecat_app_user_id(user)
    if not app_user_id:
        return user
    data = fetch_revenuecat_subscriber(app_user_id)
    if not data:
        return user
    subscriber = data.get("subscriber")
    entitlements = subscriber.get("entitlements") if isinstance(subscriber, dict) else None
    entitlement = entitlements.get(revenuecat_entitlement_id()) if isinstance(entitlements, dict) else None
    if not isinstance(entitlement, dict):
        if (user.subscription_source or "").strip().lower() == "revenuecat":
            user.subscription_tier = SubscriptionTier.FREE.value
            user.subscription_status = SubscriptionStatus.EXPIRED.value
            session.add(user)
            session.commit()
            session.refresh(user)
        return user

    expires_at = _iso_to_datetime(entitlement.get("expires_date"))
    grace_expires_at = _iso_to_datetime(entitlement.get("grace_period_expires_date"))
    now = _now()
    active_expires_at = grace_expires_at if grace_expires_at and grace_expires_at > now else expires_at
    active = active_expires_at is None or active_expires_at > now
    user.subscription_source = "revenuecat"
    user.subscription_product_id = str(entitlement.get("product_identifier") or "") or None
    user.subscription_entitlement_id = revenuecat_entitlement_id()
    user.subscription_expires_at = active_expires_at
    user.subscription_tier = SubscriptionTier.PRO.value if active else SubscriptionTier.FREE.value
    user.subscription_status = (
        SubscriptionStatus.GRACE_PERIOD.value
        if grace_expires_at and grace_expires_at > now
        else (SubscriptionStatus.ACTIVE.value if active else SubscriptionStatus.EXPIRED.value)
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user
