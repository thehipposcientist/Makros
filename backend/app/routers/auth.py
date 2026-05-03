import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.request import urlopen

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from jose import JWTError, jwt
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.limiter import limiter
from app.logging_setup import get_logger, set_request_context
from app.models import User, UserCreate, UserRead, LoginRequest, Token
from app.auth import hash_password, verify_password, create_access_token, get_current_user
from app.services.email_delivery import send_password_reset_email, send_verification_email

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger("app.auth")
LEGAL_VERSION = "2026-04-29"
TOKEN_TTL_MINUTES = 30
APPLE_ISSUER = "https://appleid.apple.com"
APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
APPLE_JWKS_TTL_SECONDS = 6 * 60 * 60
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_JWKS_TTL_SECONDS = 6 * 60 * 60
_apple_jwks_cache: dict[str, Any] | None = None
_google_jwks_cache: dict[str, Any] | None = None


def _user_read(user: User) -> UserRead:
    return UserRead(
        id=user.id,
        email=user.email,
        username=user.username,
        first_name=user.first_name,
        last_name=user.last_name,
        is_active=user.is_active,
        created_at=user.created_at,
        has_recovery_question=bool(user.recovery_question and user.recovery_answer_hash),
        email_verified=bool(user.email_verified_at),
        legal_accepted=bool(
            user.terms_accepted_at
            and user.privacy_accepted_at
            and user.health_disclaimer_accepted_at
            and user.ai_disclaimer_accepted_at
        ),
        terms_version=user.terms_version,
        privacy_version=user.privacy_version,
        health_disclaimer_version=user.health_disclaimer_version,
        ai_disclaimer_version=user.ai_disclaimer_version,
        subscription_tier=user.subscription_tier or "free",
    )


def _normalize_answer(ans: str) -> str:
    """Case/whitespace-insensitive match. Users will capitalize
    inconsistently between setup and reset; normalizing here avoids
    false lockouts."""
    return " ".join(ans.strip().lower().split())


def _client_ip(request: Request) -> str:
    """Best-effort client IP. Prefer the proxy-forwarded header when
    App Runner / ALB is in front; fall back to the socket peer."""
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "-"


_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


def _validate_email(email: str) -> None:
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Enter a valid email address")


def _validate_password(pwd: str) -> None:
    """Password policy: >=8 chars AND contains at least one digit."""
    if len(pwd) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    if not re.search(r"\d", pwd):
        raise HTTPException(status_code=422, detail="Password must include at least one number")


def _validate_name(label: str, value: str | None) -> str:
    cleaned = (value or "").strip()
    if len(cleaned) < 1:
        raise HTTPException(status_code=422, detail=f"{label} is required")
    if len(cleaned) > 80:
        raise HTTPException(status_code=422, detail=f"{label} is too long")
    return cleaned


def _require_legal_acceptance(body: UserCreate) -> None:
    if not (
        body.accepted_terms
        and body.accepted_privacy
        and body.accepted_health_disclaimer
        and body.accepted_ai_disclaimer
    ):
        raise HTTPException(
            status_code=422,
            detail="Terms, Privacy Policy, health disclaimer, and AI disclaimer must be accepted",
        )


def _new_token() -> str:
    return secrets.token_urlsafe(32)


def _token_expiry() -> datetime:
    return datetime.now(timezone.utc) + timedelta(minutes=TOKEN_TTL_MINUTES)


def _is_expired(ts: datetime | None) -> bool:
    if ts is None:
        return False
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts < datetime.now(timezone.utc)


def _apple_audiences() -> list[str]:
    values = [
        os.getenv("APPLE_CLIENT_IDS"),
        os.getenv("APPLE_CLIENT_ID"),
        os.getenv("APPLE_BUNDLE_ID"),
        os.getenv("IOS_BUNDLE_IDENTIFIER"),
        "com.thallo.app",
    ]
    audiences: list[str] = []
    for raw in values:
        for item in (raw or "").split(","):
            audience = item.strip()
            if audience and audience not in audiences:
                audiences.append(audience)
    return audiences


def _google_audiences() -> list[str]:
    values = [
        os.getenv("GOOGLE_CLIENT_IDS"),
        os.getenv("GOOGLE_CLIENT_ID"),
        os.getenv("GOOGLE_WEB_CLIENT_ID"),
        os.getenv("GOOGLE_IOS_CLIENT_ID"),
        os.getenv("GOOGLE_ANDROID_CLIENT_ID"),
    ]
    audiences: list[str] = []
    for raw in values:
        for item in (raw or "").split(","):
            audience = item.strip()
            if audience and audience not in audiences:
                audiences.append(audience)
    return audiences


def _apple_jwks(force_refresh: bool = False) -> list[dict[str, Any]]:
    global _apple_jwks_cache
    now = time.time()
    if (
        not force_refresh
        and _apple_jwks_cache
        and _apple_jwks_cache.get("expires_at", 0) > now
    ):
        return list(_apple_jwks_cache.get("keys", []))
    try:
        with urlopen(APPLE_JWKS_URL, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logger.warning("auth_apple_jwks_failed", extra={"error": str(e)})
        raise HTTPException(status_code=503, detail="Unable to verify Apple sign-in right now")
    keys = payload.get("keys") or []
    if not keys:
        raise HTTPException(status_code=503, detail="Unable to verify Apple sign-in right now")
    _apple_jwks_cache = {"keys": keys, "expires_at": now + APPLE_JWKS_TTL_SECONDS}
    return keys


def _google_jwks(force_refresh: bool = False) -> list[dict[str, Any]]:
    global _google_jwks_cache
    now = time.time()
    if (
        not force_refresh
        and _google_jwks_cache
        and _google_jwks_cache.get("expires_at", 0) > now
    ):
        return list(_google_jwks_cache.get("keys", []))
    try:
        with urlopen(GOOGLE_JWKS_URL, timeout=5) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logger.warning("auth_google_jwks_failed", extra={"error": str(e)})
        raise HTTPException(status_code=503, detail="Unable to verify Google sign-in right now")
    keys = payload.get("keys") or []
    if not keys:
        raise HTTPException(status_code=503, detail="Unable to verify Google sign-in right now")
    _google_jwks_cache = {"keys": keys, "expires_at": now + GOOGLE_JWKS_TTL_SECONDS}
    return keys


def _verify_apple_identity_token(identity_token: str) -> dict[str, Any]:
    token = (identity_token or "").strip()
    if not token:
        raise HTTPException(status_code=422, detail="Apple identity token is required")
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(status_code=401, detail="Apple sign-in token is invalid")
    kid = header.get("kid")
    if not kid:
        raise HTTPException(status_code=401, detail="Apple sign-in token is invalid")

    key = next((k for k in _apple_jwks() if k.get("kid") == kid), None)
    if key is None:
        key = next((k for k in _apple_jwks(force_refresh=True) if k.get("kid") == kid), None)
    if key is None:
        raise HTTPException(status_code=401, detail="Apple sign-in token is invalid")

    last_error: Exception | None = None
    for audience in _apple_audiences():
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=audience,
                issuer=APPLE_ISSUER,
            )
            if claims.get("sub"):
                return claims
        except JWTError as e:
            last_error = e
    logger.warning("auth_apple_token_failed", extra={"error": str(last_error or "missing_sub")})
    raise HTTPException(status_code=401, detail="Apple sign-in token is invalid")


def _verify_google_identity_token(identity_token: str) -> dict[str, Any]:
    token = (identity_token or "").strip()
    if not token:
        raise HTTPException(status_code=422, detail="Google identity token is required")
    audiences = _google_audiences()
    if not audiences:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(status_code=401, detail="Google sign-in token is invalid")
    kid = header.get("kid")
    if not kid:
        raise HTTPException(status_code=401, detail="Google sign-in token is invalid")

    key = next((k for k in _google_jwks() if k.get("kid") == kid), None)
    if key is None:
        key = next((k for k in _google_jwks(force_refresh=True) if k.get("kid") == kid), None)
    if key is None:
        raise HTTPException(status_code=401, detail="Google sign-in token is invalid")

    last_error: Exception | None = None
    for issuer in GOOGLE_ISSUERS:
        for audience in audiences:
            try:
                claims = jwt.decode(
                    token,
                    key,
                    algorithms=["RS256"],
                    audience=audience,
                    issuer=issuer,
                )
                if claims.get("sub"):
                    return claims
            except JWTError as e:
                last_error = e
    logger.warning("auth_google_token_failed", extra={"error": str(last_error or "missing_sub")})
    raise HTTPException(status_code=401, detail="Google sign-in token is invalid")


def _apple_email_verified(claims: dict[str, Any]) -> bool:
    value = claims.get("email_verified")
    return value is True or str(value).lower() == "true"


def _google_email_verified(claims: dict[str, Any]) -> bool:
    value = claims.get("email_verified")
    return value is True or str(value).lower() == "true"


def _clean_optional_name(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    if not cleaned:
        return None
    return cleaned[:80]


def _oauth_username_seed(email: str) -> str:
    local = email.split("@", 1)[0]
    seed = re.sub(r"[^a-zA-Z0-9_]+", "", local).lower()
    return (seed or "apple")[:24]


def _unique_oauth_username(session: Session, email: str) -> str:
    base = _oauth_username_seed(email)
    candidate = base
    suffix = 1
    while session.exec(select(User).where(User.username == candidate)).first():
        tail = f"_{suffix}"
        candidate = f"{base[: max(1, 32 - len(tail))]}{tail}"
        suffix += 1
    return candidate


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
@limiter.limit("30/hour;100/day")
def register(body: UserCreate, request: Request, session: Session = Depends(get_session)):
    email = body.email.strip().lower()
    username = body.username.strip()
    first_name = _validate_name("First name", body.first_name)
    last_name = _validate_name("Last name", body.last_name)
    _validate_email(email)
    _validate_password(body.password)
    _require_legal_acceptance(body)
    ip = _client_ip(request)
    # Check email not taken
    if session.exec(select(User).where(User.email == email)).first():
        logger.info("auth_register_rejected", extra={"email": email, "ip": ip, "reason": "email_taken"})
        raise HTTPException(status_code=400, detail="Email already registered")
    # Check username not taken
    if session.exec(select(User).where(User.username == username)).first():
        logger.info("auth_register_rejected", extra={"email": email, "ip": ip, "reason": "username_taken"})
        raise HTTPException(status_code=400, detail="Username already taken")

    now = datetime.now(timezone.utc)
    email_token = _new_token()
    legal_version = (body.legal_version or LEGAL_VERSION).strip() or LEGAL_VERSION
    user = User(
        email=email,
        username=username,
        hashed_password=hash_password(body.password),
        first_name=first_name,
        last_name=last_name,
        terms_accepted_at=now,
        terms_version=legal_version,
        privacy_accepted_at=now,
        privacy_version=legal_version,
        health_disclaimer_accepted_at=now,
        health_disclaimer_version=legal_version,
        ai_disclaimer_accepted_at=now,
        ai_disclaimer_version=legal_version,
        email_verification_token_hash=hash_password(email_token),
        email_verification_expires_at=_token_expiry(),
        # Beta default: every new sign-up starts on Pro so plan
        # generation, AI features, and coach chat work out of the box.
        # The frontend `freeBetaFullAccess` flag handles client-side
        # gates; this aligns the BACKEND so `require_pro_feature`
        # endpoints (plan_weeks, /ai/*, /coach/*) don't 403 fresh users.
        # Flip back to "free" once paid tiers ship.
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    set_request_context(user_id=user.id)
    logger.info("auth_register_ok", extra={"user_id": user.id, "email": email, "ip": ip})
    send_verification_email(email, email_token)
    return _user_read(user)


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

    token = create_access_token(user.id, token_version=user.token_version)
    set_request_context(user_id=user.id)
    logger.info("auth_login_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return Token(access_token=token)


class AppleAuthRequest(BaseModel):
    identity_token: str
    first_name: str | None = None
    last_name: str | None = None
    legal_version: str | None = None
    accepted_terms: bool = True
    accepted_privacy: bool = True
    accepted_health_disclaimer: bool = True
    accepted_ai_disclaimer: bool = True


class GoogleAuthRequest(BaseModel):
    identity_token: str
    first_name: str | None = None
    last_name: str | None = None
    legal_version: str | None = None
    accepted_terms: bool = True
    accepted_privacy: bool = True
    accepted_health_disclaimer: bool = True
    accepted_ai_disclaimer: bool = True


class OAuthToken(Token):
    is_new_user: bool = False


def _require_oauth_legal_acceptance(body: AppleAuthRequest | GoogleAuthRequest) -> None:
    if not (
        body.accepted_terms
        and body.accepted_privacy
        and body.accepted_health_disclaimer
        and body.accepted_ai_disclaimer
    ):
        raise HTTPException(
            status_code=422,
            detail="Terms, Privacy Policy, health disclaimer, and AI disclaimer must be accepted",
        )


def _name_from_google_claim(claims: dict[str, Any], key: str) -> str | None:
    return _clean_optional_name(str(claims.get(key) or ""))


@router.post("/apple", response_model=OAuthToken)
@limiter.limit("10/minute;100/hour")
def login_with_apple(
    body: AppleAuthRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    ip = _client_ip(request)
    claims = _verify_apple_identity_token(body.identity_token)
    apple_sub = str(claims.get("sub") or "").strip()
    if not apple_sub:
        raise HTTPException(status_code=401, detail="Apple sign-in token is invalid")

    user = session.exec(select(User).where(User.apple_sub == apple_sub)).first()
    if user:
        if not user.is_active:
            logger.warning("auth_apple_disabled", extra={"user_id": user.id, "ip": ip})
            raise HTTPException(status_code=403, detail="Account disabled")
        token = create_access_token(user.id, token_version=user.token_version)
        set_request_context(user_id=user.id)
        logger.info("auth_apple_ok", extra={"user_id": user.id, "ip": ip, "is_new": False})
        return OAuthToken(access_token=token, is_new_user=False)

    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(
            status_code=422,
            detail="Apple did not provide an email address. Try again after sharing your email with Thallo.",
        )
    _validate_email(email)
    if not _apple_email_verified(claims):
        raise HTTPException(status_code=401, detail="Apple email is not verified")

    now = datetime.now(timezone.utc)
    first_name = _clean_optional_name(body.first_name)
    last_name = _clean_optional_name(body.last_name)
    existing = session.exec(select(User).where(User.email == email)).first()
    if existing:
        if not existing.is_active:
            logger.warning("auth_apple_disabled", extra={"user_id": existing.id, "email": email, "ip": ip})
            raise HTTPException(status_code=403, detail="Account disabled")
        if existing.apple_sub and existing.apple_sub != apple_sub:
            raise HTTPException(status_code=409, detail="This email is already linked to a different Apple account")
        existing.apple_sub = apple_sub
        existing.email_verified_at = existing.email_verified_at or now
        if first_name and not existing.first_name:
            existing.first_name = first_name
        if last_name and not existing.last_name:
            existing.last_name = last_name
        session.add(existing)
        session.commit()
        session.refresh(existing)
        token = create_access_token(existing.id, token_version=existing.token_version)
        set_request_context(user_id=existing.id)
        logger.info("auth_apple_linked", extra={"user_id": existing.id, "email": email, "ip": ip})
        return OAuthToken(access_token=token, is_new_user=False)

    _require_oauth_legal_acceptance(body)
    legal_version = (body.legal_version or LEGAL_VERSION).strip() or LEGAL_VERSION
    user = User(
        email=email,
        username=_unique_oauth_username(session, email),
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        first_name=first_name,
        last_name=last_name,
        apple_sub=apple_sub,
        terms_accepted_at=now,
        terms_version=legal_version,
        privacy_accepted_at=now,
        privacy_version=legal_version,
        health_disclaimer_accepted_at=now,
        health_disclaimer_version=legal_version,
        ai_disclaimer_accepted_at=now,
        ai_disclaimer_version=legal_version,
        email_verified_at=now,
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token(user.id, token_version=user.token_version)
    set_request_context(user_id=user.id)
    logger.info("auth_apple_created", extra={"user_id": user.id, "email": email, "ip": ip})
    return OAuthToken(access_token=token, is_new_user=True)


@router.post("/google", response_model=OAuthToken)
@limiter.limit("10/minute;100/hour")
def login_with_google(
    body: GoogleAuthRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    ip = _client_ip(request)
    claims = _verify_google_identity_token(body.identity_token)
    google_sub = str(claims.get("sub") or "").strip()
    if not google_sub:
        raise HTTPException(status_code=401, detail="Google sign-in token is invalid")

    user = session.exec(select(User).where(User.google_sub == google_sub)).first()
    if user:
        if not user.is_active:
            logger.warning("auth_google_disabled", extra={"user_id": user.id, "ip": ip})
            raise HTTPException(status_code=403, detail="Account disabled")
        token = create_access_token(user.id, token_version=user.token_version)
        set_request_context(user_id=user.id)
        logger.info("auth_google_ok", extra={"user_id": user.id, "ip": ip, "is_new": False})
        return OAuthToken(access_token=token, is_new_user=False)

    email = str(claims.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=422, detail="Google did not provide an email address")
    _validate_email(email)
    if not _google_email_verified(claims):
        raise HTTPException(status_code=401, detail="Google email is not verified")

    now = datetime.now(timezone.utc)
    first_name = _clean_optional_name(body.first_name) or _name_from_google_claim(claims, "given_name")
    last_name = _clean_optional_name(body.last_name) or _name_from_google_claim(claims, "family_name")
    existing = session.exec(select(User).where(User.email == email)).first()
    if existing:
        if not existing.is_active:
            logger.warning("auth_google_disabled", extra={"user_id": existing.id, "email": email, "ip": ip})
            raise HTTPException(status_code=403, detail="Account disabled")
        if existing.google_sub and existing.google_sub != google_sub:
            raise HTTPException(status_code=409, detail="This email is already linked to a different Google account")
        existing.google_sub = google_sub
        existing.email_verified_at = existing.email_verified_at or now
        if first_name and not existing.first_name:
            existing.first_name = first_name
        if last_name and not existing.last_name:
            existing.last_name = last_name
        session.add(existing)
        session.commit()
        session.refresh(existing)
        token = create_access_token(existing.id, token_version=existing.token_version)
        set_request_context(user_id=existing.id)
        logger.info("auth_google_linked", extra={"user_id": existing.id, "email": email, "ip": ip})
        return OAuthToken(access_token=token, is_new_user=False)

    _require_oauth_legal_acceptance(body)
    legal_version = (body.legal_version or LEGAL_VERSION).strip() or LEGAL_VERSION
    user = User(
        email=email,
        username=_unique_oauth_username(session, email),
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        first_name=first_name,
        last_name=last_name,
        google_sub=google_sub,
        terms_accepted_at=now,
        terms_version=legal_version,
        privacy_accepted_at=now,
        privacy_version=legal_version,
        health_disclaimer_accepted_at=now,
        health_disclaimer_version=legal_version,
        ai_disclaimer_accepted_at=now,
        ai_disclaimer_version=legal_version,
        email_verified_at=now,
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token(user.id, token_version=user.token_version)
    set_request_context(user_id=user.id)
    logger.info("auth_google_created", extra={"user_id": user.id, "email": email, "ip": ip})
    return OAuthToken(access_token=token, is_new_user=True)


@router.get("/me", response_model=UserRead)
def me(current_user: User = Depends(get_current_user)):
    return _user_read(current_user)


class UpdateEmailBody(BaseModel):
    email: str


@router.put("/update-email", response_model=UserRead)
def update_email(
    body: UpdateEmailBody,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    new_email = body.email.strip().lower()
    _validate_email(new_email)
    if new_email == current_user.email:
        return _user_read(current_user)
    if session.exec(select(User).where(User.email == new_email)).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    current_user.email = new_email
    current_user.email_verified_at = None
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    logger.info("auth_email_updated", extra={"user_id": current_user.id, "new_email": new_email})
    return _user_read(current_user)


class EmailTokenRequestBody(BaseModel):
    email: str


class EmailTokenConfirmBody(BaseModel):
    email: str
    token: str


@router.post("/email-verification/request")
@limiter.limit("3/hour")
def request_email_verification(
    body: EmailTokenRequestBody,
    request: Request,
    session: Session = Depends(get_session),
):
    """Create and send an email-verification token.

    Response stays generic so account existence is not leaked. In local/dev,
    set DEV_EMAIL_TOKENS=1 to get the token in the response for manual testing.
    """
    email = body.email.strip().lower()
    ip = _client_ip(request)
    user = session.exec(select(User).where(User.email == email)).first()
    dev_token: str | None = None
    if user and user.is_active:
        token = _new_token()
        user.email_verification_token_hash = hash_password(token)
        user.email_verification_expires_at = _token_expiry()
        session.add(user)
        session.commit()
        dev_token = token
        send_verification_email(email, token)
        logger.info("auth_email_verification_requested", extra={"user_id": user.id, "email": email, "ip": ip})
    response = {"status": "ok", "message": "If that email belongs to an account, a verification link will be sent."}
    if os.getenv("DEV_EMAIL_TOKENS") == "1" and dev_token:
        response["dev_token"] = dev_token
    return response


@router.post("/email-verification/confirm", response_model=UserRead)
@limiter.limit("10/hour")
def confirm_email_verification(
    body: EmailTokenConfirmBody,
    request: Request,
    session: Session = Depends(get_session),
):
    email = body.email.strip().lower()
    token = body.token.strip()
    user = session.exec(select(User).where(User.email == email)).first()
    generic = HTTPException(status_code=401, detail="Verification link is invalid or expired")
    if not user or not user.email_verification_token_hash:
        raise generic
    if _is_expired(user.email_verification_expires_at):
        raise generic
    if not verify_password(token, user.email_verification_token_hash):
        logger.warning("auth_email_verification_failed", extra={"email": email, "ip": _client_ip(request)})
        raise generic
    user.email_verified_at = datetime.now(timezone.utc)
    user.email_verification_token_hash = None
    user.email_verification_expires_at = None
    session.add(user)
    session.commit()
    session.refresh(user)
    logger.info("auth_email_verified", extra={"user_id": user.id, "email": email})
    return _user_read(user)


# ── Recovery question flow ───────────────────────────────────────────────────
# Pilot-grade account recovery. Each user sets one question + answer at
# signup or on first login post-migration. Reset requires email + correct
# answer + new password — no email delivery needed.

class RecoveryQuestionSetBody(BaseModel):
    question: str
    answer: str


@router.get("/recovery-question")
@limiter.limit("10/hour")
def get_recovery_question(
    request: Request,
    email: str = Query(..., description="Account email"),
    session: Session = Depends(get_session),
):
    """Return the recovery question for an email (not the answer).
    Responds identically for unknown emails and accounts with no question
    set — leaking either would let attackers enumerate users."""
    user = session.exec(select(User).where(User.email == email)).first()
    if not user or not user.recovery_question:
        # Generic response — avoid confirming account existence.
        raise HTTPException(status_code=404, detail="No recovery question available")
    return {"question": user.recovery_question}


@router.post("/set-recovery-question", response_model=UserRead)
def set_recovery_question(
    body: RecoveryQuestionSetBody,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    q = body.question.strip()
    a = body.answer.strip()
    if len(q) < 5:
        raise HTTPException(status_code=422, detail="Question must be at least 5 characters")
    if len(a) < 2:
        raise HTTPException(status_code=422, detail="Answer must be at least 2 characters")

    current_user.recovery_question = q
    current_user.recovery_answer_hash = hash_password(_normalize_answer(a))
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    logger.info("auth_recovery_set", extra={"user_id": current_user.id})
    return _user_read(current_user)


class PasswordResetRequest(BaseModel):
    email: str
    answer: str
    new_password: str


@router.post("/reset-password", response_model=Token)
@limiter.limit("5/hour")
def reset_password(
    body: PasswordResetRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Recover an account via the security question. Requires the correct
    answer — a wrong answer responds identically to an unknown email so
    attackers can't tell which accounts exist."""
    _validate_password(body.new_password)
    ip = _client_ip(request)
    user = session.exec(select(User).where(User.email == body.email)).first()

    # Generic "bad credentials" response for every failure mode below so we
    # don't leak whether the email is registered or whether the user has
    # set a recovery question.
    generic = HTTPException(status_code=401, detail="Email or recovery answer is incorrect")

    if not user or not user.recovery_answer_hash:
        logger.warning("auth_reset_failed", extra={"email": body.email, "ip": ip, "reason": "no_user_or_question"})
        raise generic
    if not user.is_active:
        logger.warning("auth_reset_disabled", extra={"user_id": user.id, "email": body.email, "ip": ip})
        raise HTTPException(status_code=403, detail="Account disabled")
    if not verify_password(_normalize_answer(body.answer), user.recovery_answer_hash):
        logger.warning("auth_reset_failed", extra={"user_id": user.id, "email": body.email, "ip": ip, "reason": "wrong_answer"})
        raise generic

    user.hashed_password = hash_password(body.new_password)
    user.token_version = int(user.token_version or 0) + 1
    session.add(user)
    session.commit()

    token = create_access_token(user.id, token_version=user.token_version)
    set_request_context(user_id=user.id)
    logger.info("auth_reset_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return Token(access_token=token)


class PasswordResetEmailRequest(BaseModel):
    email: str


class PasswordResetConfirmRequest(BaseModel):
    email: str
    token: str
    new_password: str


@router.post("/password-reset/request")
@limiter.limit("5/hour")
def request_password_reset_email(
    body: PasswordResetEmailRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    """Start email-token password reset.

    Safely stores a short-lived token, sends it through the configured email
    provider, and returns a generic response. Set DEV_EMAIL_TOKENS=1 locally to
    see the token in the response.
    """
    email = body.email.strip().lower()
    ip = _client_ip(request)
    user = session.exec(select(User).where(User.email == email)).first()
    dev_token: str | None = None
    if user and user.is_active:
        token = _new_token()
        user.password_reset_token_hash = hash_password(token)
        user.password_reset_expires_at = _token_expiry()
        session.add(user)
        session.commit()
        dev_token = token
        send_password_reset_email(email, token)
        logger.info("auth_password_reset_email_requested", extra={"user_id": user.id, "email": email, "ip": ip})
    response = {"status": "ok", "message": "If that email belongs to an account, a reset link will be sent."}
    if os.getenv("DEV_EMAIL_TOKENS") == "1" and dev_token:
        response["dev_token"] = dev_token
    return response


@router.post("/password-reset/confirm", response_model=Token)
@limiter.limit("10/hour")
def confirm_password_reset_email(
    body: PasswordResetConfirmRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    _validate_password(body.new_password)
    email = body.email.strip().lower()
    token = body.token.strip()
    user = session.exec(select(User).where(User.email == email)).first()
    generic = HTTPException(status_code=401, detail="Reset link is invalid or expired")
    if not user or not user.password_reset_token_hash:
        raise generic
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")
    if _is_expired(user.password_reset_expires_at):
        raise generic
    if not verify_password(token, user.password_reset_token_hash):
        logger.warning("auth_password_reset_email_failed", extra={"email": email, "ip": _client_ip(request)})
        raise generic

    user.hashed_password = hash_password(body.new_password)
    user.password_reset_token_hash = None
    user.password_reset_expires_at = None
    user.token_version = int(user.token_version or 0) + 1
    session.add(user)
    session.commit()

    access_token = create_access_token(user.id, token_version=user.token_version)
    set_request_context(user_id=user.id)
    logger.info("auth_password_reset_email_ok", extra={"user_id": user.id, "email": email})
    return Token(access_token=access_token)


# ── Authenticated password change ────────────────────────────────────────────
# Lets a logged-in user rotate their password without going through the full
# reset flow (which terminates session + asks for security question / email
# token). Required `current_password` so a stolen device session can't silently
# rotate the password and lock out the real user. Bumps `token_version` so
# every other device with an existing JWT is forced to re-login on next call.

class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password", response_model=Token)
@limiter.limit("10/hour")
def change_password(
    body: PasswordChangeRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ip = _client_ip(request)
    if not verify_password(body.current_password, current_user.hashed_password):
        logger.warning("auth_change_password_failed", extra={"user_id": current_user.id, "ip": ip})
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    _validate_password(body.new_password)
    if verify_password(body.new_password, current_user.hashed_password):
        raise HTTPException(status_code=422, detail="New password must be different from the current password")

    current_user.hashed_password = hash_password(body.new_password)
    current_user.token_version = int(current_user.token_version or 0) + 1
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    # Issue a fresh token at the new version so the client doesn't get
    # immediately logged out by its own change.
    new_token = create_access_token(current_user.id, token_version=current_user.token_version)
    logger.info("auth_change_password_ok", extra={"user_id": current_user.id, "ip": ip})
    return Token(access_token=new_token)


# ── Session revocation / logout ──────────────────────────────────────────────
# Bumps `token_version`, which invalidates every existing JWT for this user.
# Idempotent. Useful for the user-visible "log out" affordance and for
# "log out everywhere" recovery flows. Each subsequent login mints a token at
# the new version.

@router.post("/logout")
def logout(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    current_user.token_version = int(current_user.token_version or 0) + 1
    session.add(current_user)
    session.commit()
    logger.info("auth_logout", extra={"user_id": current_user.id})
    return {"status": "ok", "message": "Signed out everywhere."}


# ── Re-accept legal versions ─────────────────────────────────────────────────
# Frontend compares the user's per-section accepted_version against the
# active LEGAL_VERSION constant. When they differ (a section's body was
# updated), the LegalDisclosureModal is presented again and POSTs here to
# stamp fresh acceptance timestamps + versions. The original signup
# acceptance is not erased — only the current fields are re-stamped.

class AcceptLegalRequest(BaseModel):
    legal_version: str
    accepted_terms: bool = True
    accepted_privacy: bool = True
    accepted_health_disclaimer: bool = True
    accepted_ai_disclaimer: bool = True


@router.post("/accept-legal", response_model=UserRead)
def accept_legal(
    body: AcceptLegalRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not (
        body.accepted_terms
        and body.accepted_privacy
        and body.accepted_health_disclaimer
        and body.accepted_ai_disclaimer
    ):
        raise HTTPException(
            status_code=422,
            detail="All four sections must be accepted to use Thallo.",
        )
    version = (body.legal_version or "").strip() or LEGAL_VERSION
    now = datetime.now(timezone.utc)
    current_user.terms_accepted_at = now
    current_user.terms_version = version
    current_user.privacy_accepted_at = now
    current_user.privacy_version = version
    current_user.health_disclaimer_accepted_at = now
    current_user.health_disclaimer_version = version
    current_user.ai_disclaimer_accepted_at = now
    current_user.ai_disclaimer_version = version
    session.add(current_user)
    session.commit()
    session.refresh(current_user)
    logger.info("auth_legal_re_accepted", extra={"user_id": current_user.id, "version": version})
    return _user_read(current_user)
