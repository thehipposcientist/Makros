from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, status
import os

from app.auth import get_current_user
from app.enums import SubscriptionStatus, SubscriptionTier
from app.models import User

FREE_WORKOUT_TEMPLATE_LIMIT = 5
FREE_SAVED_MEAL_LIMIT: int | None = None
FREE_MEAL_ROUTINE_LIMIT = 7
REVENUECAT_APP_USER_PREFIX = "thallo:"
TRIAL_STATUSES = {
    SubscriptionStatus.TRIALING.value,
    SubscriptionStatus.TRIAL_CANCELLED.value,
}
EXPIRING_PRO_STATUSES = {
    SubscriptionStatus.ACTIVE.value,
    SubscriptionStatus.GRACE_PERIOD.value,
    SubscriptionStatus.CANCELLED.value,
    SubscriptionStatus.PROMOTIONAL.value,
    SubscriptionStatus.TEMPORARY.value,
}
INACTIVE_STATUSES = {
    SubscriptionStatus.FREE.value,
    SubscriptionStatus.EXPIRED.value,
    SubscriptionStatus.REVOKED.value,
    SubscriptionStatus.BILLING_ISSUE.value,
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def signup_trial_days() -> int:
    raw = os.getenv("SIGNUP_TRIAL_DAYS", "7").strip()
    try:
        days = int(raw)
    except ValueError:
        days = 7
    return max(0, min(days, 30))


def revenuecat_entitlement_id() -> str:
    return (os.getenv("REVENUECAT_PRO_ENTITLEMENT_ID") or "pro").strip() or "pro"


def revenuecat_app_user_id_for_user_id(user_id: int | None) -> str | None:
    if user_id is None:
        return None
    return f"{REVENUECAT_APP_USER_PREFIX}{user_id}"


def revenuecat_app_user_id(user: User | None) -> str | None:
    return revenuecat_app_user_id_for_user_id(getattr(user, "id", None))


def user_id_from_revenuecat_app_user_id(app_user_id: str | None) -> int | None:
    value = (app_user_id or "").strip()
    if not value:
        return None
    if value.startswith(REVENUECAT_APP_USER_PREFIX):
        value = value[len(REVENUECAT_APP_USER_PREFIX):]
    if not value.isdigit():
        return None
    return int(value)


def _active_until(expires_at: datetime | None, now: datetime) -> bool:
    expires = _as_utc(expires_at)
    return expires is None or expires > now


def _normalized_tier(user: User | None) -> str:
    tier = (getattr(user, "subscription_tier", None) or SubscriptionTier.FREE.value).strip().lower()
    return SubscriptionTier.PRO.value if tier == SubscriptionTier.PRO.value else SubscriptionTier.FREE.value


def _normalized_status(user: User | None) -> str:
    return (getattr(user, "subscription_status", None) or "").strip().lower()


def tier_of(user: User | None, *, now: datetime | None = None) -> str:
    if beta_full_access_enabled():
        return SubscriptionTier.PRO.value
    now = now or _now()
    tier = _normalized_tier(user)
    status_value = _normalized_status(user)
    if tier != SubscriptionTier.PRO.value:
        return SubscriptionTier.FREE.value
    if not status_value:
        return SubscriptionTier.PRO.value
    if status_value in TRIAL_STATUSES:
        trial_ends_at = _as_utc(getattr(user, "trial_ends_at", None))
        return SubscriptionTier.PRO.value if trial_ends_at is not None and trial_ends_at > now else SubscriptionTier.FREE.value
    if status_value in EXPIRING_PRO_STATUSES:
        return SubscriptionTier.PRO.value if _active_until(getattr(user, "subscription_expires_at", None), now) else SubscriptionTier.FREE.value
    if status_value in INACTIVE_STATUSES:
        return SubscriptionTier.FREE.value
    return SubscriptionTier.FREE.value


def subscription_status_of(user: User | None, *, now: datetime | None = None) -> str:
    if beta_full_access_enabled():
        return SubscriptionStatus.BETA.value
    now = now or _now()
    status_value = _normalized_status(user)
    effective_tier = tier_of(user, now=now)
    if effective_tier != SubscriptionTier.PRO.value:
        if status_value in TRIAL_STATUSES or status_value in EXPIRING_PRO_STATUSES:
            return SubscriptionStatus.EXPIRED.value
        if status_value in INACTIVE_STATUSES:
            return status_value
        return SubscriptionStatus.FREE.value
    if not status_value:
        return SubscriptionStatus.ACTIVE.value
    if status_value in TRIAL_STATUSES or status_value in EXPIRING_PRO_STATUSES:
        return status_value
    return SubscriptionStatus.ACTIVE.value


def beta_full_access_enabled() -> bool:
    return os.getenv("BETA_FULL_ACCESS_ENABLED", "0").strip() == "1"


def dummy_billing_enabled() -> bool:
    """Gates the mock checkout/downgrade endpoints (no real payment). Must be
    explicitly enabled per environment so it can never grant Pro for free in
    production, even if the endpoint is hit directly."""
    return os.getenv("DUMMY_BILLING_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}


def default_subscription_tier() -> str:
    return SubscriptionTier.PRO.value if beta_full_access_enabled() or signup_trial_days() > 0 else SubscriptionTier.FREE.value


def initialize_signup_entitlement(user: User, *, now: datetime | None = None) -> User:
    now = now or _now()
    if beta_full_access_enabled():
        user.subscription_tier = SubscriptionTier.PRO.value
        user.subscription_status = SubscriptionStatus.BETA.value
        user.subscription_source = SubscriptionStatus.BETA.value
        user.subscription_expires_at = None
        return user
    days = signup_trial_days()
    if days <= 0:
        user.subscription_tier = SubscriptionTier.FREE.value
        user.subscription_status = SubscriptionStatus.FREE.value
        user.subscription_source = None
        user.subscription_expires_at = None
        return user
    trial_ends = now + timedelta(days=days)
    user.subscription_tier = SubscriptionTier.PRO.value
    user.subscription_status = SubscriptionStatus.TRIALING.value
    user.subscription_source = "signup_trial"
    user.subscription_entitlement_id = revenuecat_entitlement_id()
    user.trial_started_at = now
    user.trial_ends_at = trial_ends
    user.subscription_expires_at = trial_ends
    return user


def refresh_user_entitlement(user: User, session) -> User:
    raw_tier = _normalized_tier(user)
    raw_status = _normalized_status(user)
    if beta_full_access_enabled():
        if raw_tier != SubscriptionTier.PRO.value or raw_status != SubscriptionStatus.BETA.value:
            user.subscription_tier = SubscriptionTier.PRO.value
            user.subscription_status = SubscriptionStatus.BETA.value
            user.subscription_source = SubscriptionStatus.BETA.value
            session.add(user)
            session.commit()
            session.refresh(user)
        return user
    effective_tier = tier_of(user)
    effective_status = subscription_status_of(user)
    if raw_tier != effective_tier or raw_status != effective_status:
        user.subscription_tier = effective_tier
        user.subscription_status = effective_status
        session.add(user)
        session.commit()
        session.refresh(user)
    return user


def entitlement_payload(user: User | None) -> dict:
    tier = tier_of(user)
    return {
        "subscription_tier": tier,
        "subscription_status": subscription_status_of(user),
        "subscription_source": getattr(user, "subscription_source", None),
        "subscription_product_id": getattr(user, "subscription_product_id", None),
        "subscription_entitlement_id": getattr(user, "subscription_entitlement_id", None),
        "subscription_store": getattr(user, "subscription_store", None),
        "subscription_environment": getattr(user, "subscription_environment", None),
        "subscription_expires_at": getattr(user, "subscription_expires_at", None),
        "trial_started_at": getattr(user, "trial_started_at", None),
        "trial_ends_at": getattr(user, "trial_ends_at", None),
        "revenuecat_app_user_id": revenuecat_app_user_id(user),
    }


def is_pro(user: User | None) -> bool:
    return tier_of(user) == SubscriptionTier.PRO.value


def pro_required_detail(feature: str) -> str:
    return f"{feature} is a Thallo Pro feature."


def require_pro_feature(feature: str):
    def _dependency(current_user: User = Depends(get_current_user)) -> User:
        if not is_pro(current_user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=pro_required_detail(feature),
            )
        return current_user

    return _dependency


def ensure_pro(user: User, feature: str) -> None:
    if not is_pro(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=pro_required_detail(feature),
        )
