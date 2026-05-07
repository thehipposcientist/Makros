from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.auth import ALGORITHM, SECRET_KEY
from app.database import get_session
from app.logging_setup import get_logger, redact_for_logs, set_request_context
from app.models import ClientTelemetryEvent, User

router = APIRouter(prefix="/telemetry", tags=["telemetry"])
optional_bearer = HTTPBearer(auto_error=False)
logger = get_logger("app.telemetry")


class TelemetryEventCreate(BaseModel):
    event_name: str = Field(min_length=1, max_length=80)
    anonymous_id: str | None = Field(default=None, max_length=120)
    platform: str | None = Field(default=None, max_length=40)
    app_version: str | None = Field(default=None, max_length=40)
    payload: dict = Field(default_factory=dict)

    @field_validator("event_name")
    @classmethod
    def _clean_name(cls, value: str) -> str:
        return "_".join(value.strip().lower().replace("-", "_").split())[:80]


def _optional_user(
    credentials: HTTPAuthorizationCredentials | None,
    db: Session,
) -> User | None:
    if not credentials:
        return None
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub"))
        token_version = int(payload.get("tv", 0))
    except (JWTError, TypeError, ValueError):
        return None
    user = db.get(User, user_id)
    if not user or not user.is_active:
        return None
    if token_version < int(user.token_version or 0):
        return None
    return user


@router.post("/events", status_code=202)
def create_telemetry_event(
    body: TelemetryEventCreate,
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_bearer),
    db: Session = Depends(get_session),
):
    user = _optional_user(credentials, db)
    if user and user.id is not None:
        set_request_context(user_id=user.id)
    payload = redact_for_logs(body.payload or {})
    event = ClientTelemetryEvent(
        user_id=user.id if user else None,
        anonymous_id=body.anonymous_id,
        event_name=body.event_name,
        platform=body.platform,
        app_version=body.app_version,
        payload=payload,
    )
    db.add(event)
    db.commit()
    logger.info(
        "client_event",
        extra={
            "event_name": body.event_name,
            "user_id": user.id if user else None,
            "anonymous_id": body.anonymous_id,
        },
    )
    return {"ok": True}
