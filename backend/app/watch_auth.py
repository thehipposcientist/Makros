from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session, select

from app.database import get_session
from app.models import User, WatchDevice

watch_bearer_scheme = HTTPBearer()


def hash_watch_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _as_aware_utc(ts: datetime | None) -> datetime | None:
    if ts is None:
        return None
    if ts.tzinfo is None:
        return ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


@dataclass(frozen=True)
class WatchAuthContext:
    user: User
    device: WatchDevice


def get_current_watch_context(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(watch_bearer_scheme),
    session: Session = Depends(get_session),
) -> WatchAuthContext:
    token = (credentials.credentials or "").strip()
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired watch token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_exception

    device = session.exec(
        select(WatchDevice).where(WatchDevice.token_hash == hash_watch_token(token))
    ).first()
    if device is None:
        raise credentials_exception

    now = datetime.now(timezone.utc)
    if _as_aware_utc(device.revoked_at) is not None or (_as_aware_utc(device.expires_at) or now) < now:
        raise credentials_exception

    user = session.get(User, device.user_id)
    if not user or not user.is_active:
        raise credentials_exception
    if int(device.issued_token_version or 0) < int(user.token_version or 0):
        raise credentials_exception

    device.last_seen_at = now
    forwarded = request.headers.get("X-Forwarded-For")
    device.last_seen_ip = (forwarded.split(",")[0].strip() if forwarded else request.client.host if request.client else None)
    session.add(device)
    session.commit()
    session.refresh(device)
    return WatchAuthContext(user=user, device=device)
