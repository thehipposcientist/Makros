from fastapi import Depends, HTTPException, status
import os

from app.auth import get_current_user
from app.models import User

FREE_SAVED_MEAL_LIMIT = 5


def tier_of(user: User | None) -> str:
    tier = (getattr(user, "subscription_tier", None) or "free").strip().lower()
    return "pro" if tier == "pro" else "free"


def beta_full_access_enabled() -> bool:
    return os.getenv("BETA_FULL_ACCESS_ENABLED", "1").strip() == "1"


def default_subscription_tier() -> str:
    """Give beta signups Pro unless the backend explicitly opts out."""
    return "pro" if beta_full_access_enabled() else "free"


def is_pro(user: User | None) -> bool:
    return tier_of(user) == "pro"


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
