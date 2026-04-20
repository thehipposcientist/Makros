import os
import re

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.limiter import limiter
from app.logging_setup import get_logger, set_request_context
from app.models import User, UserCreate, UserRead, LoginRequest, Token
from app.auth import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger("app.auth")


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Prefer the proxy-forwarded header when
    App Runner / ALB is in front; fall back to the socket peer."""
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "-"


def _validate_password(pwd: str) -> None:
    """Password policy: >=8 chars AND contains at least one digit."""
    if len(pwd) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    if not re.search(r"\d", pwd):
        raise HTTPException(status_code=422, detail="Password must include at least one number")


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/hour")
def register(body: UserCreate, request: Request, session: Session = Depends(get_session)):
    _validate_password(body.password)
    ip = _client_ip(request)
    # Check email not taken
    if session.exec(select(User).where(User.email == body.email)).first():
        logger.info("auth_register_rejected", extra={"email": body.email, "ip": ip, "reason": "email_taken"})
        raise HTTPException(status_code=400, detail="Email already registered")
    # Check username not taken
    if session.exec(select(User).where(User.username == body.username)).first():
        logger.info("auth_register_rejected", extra={"email": body.email, "ip": ip, "reason": "username_taken"})
        raise HTTPException(status_code=400, detail="Username already taken")

    user = User(
        email=body.email,
        username=body.username,
        hashed_password=hash_password(body.password),
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    set_request_context(user_id=user.id)
    logger.info("auth_register_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return user


@router.post("/login", response_model=Token)
@limiter.limit("10/minute;100/hour")
def login(body: LoginRequest, request: Request, session: Session = Depends(get_session)):
    ip = _client_ip(request)
    user = session.exec(select(User).where(User.email == body.email)).first()
    if not user or not verify_password(body.password, user.hashed_password):
        # Don't distinguish "no such user" from "wrong password" in the
        # client response — same log message in both cases lets us spot
        # credential-stuffing patterns later without leaking account
        # existence.
        logger.warning("auth_login_failed", extra={"email": body.email, "ip": ip})
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    if not user.is_active:
        logger.warning("auth_login_disabled", extra={"user_id": user.id, "email": body.email, "ip": ip})
        raise HTTPException(status_code=403, detail="Account disabled")

    token = create_access_token(user.id)
    set_request_context(user_id=user.id)
    logger.info("auth_login_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return Token(access_token=token)


@router.get("/me", response_model=UserRead)
def me(current_user: User = Depends(get_current_user)):
    return current_user


class PasswordResetRequest(BaseModel):
    email: str
    new_password: str


@router.post("/reset-password", response_model=Token)
@limiter.limit("3/hour")
def reset_password(
    body: PasswordResetRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Dev-only reset: email match alone is enough to set a new password.
    Gated behind `DEV_PASSWORD_RESET=1` so it's off by default in
    production. Anyone who knows a user's email could otherwise take over
    an account — a proper token-based flow is still a pre-launch item.
    When enabled, returns a fresh access token so the client logs
    straight in."""
    if os.getenv("DEV_PASSWORD_RESET") != "1":
        raise HTTPException(status_code=404, detail="Not Found")
    _validate_password(body.new_password)
    ip = _client_ip(request)
    user = session.exec(select(User).where(User.email == body.email)).first()
    if not user:
        logger.warning("auth_reset_unknown_email", extra={"email": body.email, "ip": ip})
        raise HTTPException(status_code=404, detail="No account found for that email")
    if not user.is_active:
        logger.warning("auth_reset_disabled", extra={"user_id": user.id, "email": body.email, "ip": ip})
        raise HTTPException(status_code=403, detail="Account disabled")

    user.hashed_password = hash_password(body.new_password)
    session.add(user)
    session.commit()

    token = create_access_token(user.id)
    set_request_context(user_id=user.id)
    logger.info("auth_reset_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return Token(access_token=token)
