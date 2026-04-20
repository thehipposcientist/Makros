import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.limiter import limiter
from app.logging_setup import get_logger, set_request_context
from app.models import User, UserCreate, UserRead, LoginRequest, Token
from app.auth import hash_password, verify_password, create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])
logger = get_logger("app.auth")


def _user_read(user: User) -> UserRead:
    return UserRead(
        id=user.id,
        email=user.email,
        username=user.username,
        is_active=user.is_active,
        created_at=user.created_at,
        has_recovery_question=bool(user.recovery_question and user.recovery_answer_hash),
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

    token = create_access_token(user.id)
    set_request_context(user_id=user.id)
    logger.info("auth_login_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return Token(access_token=token)


@router.get("/me", response_model=UserRead)
def me(current_user: User = Depends(get_current_user)):
    return _user_read(current_user)


# ── Recovery question flow ───────────────────────────────────────────────────
# Pilot-grade account recovery. Each user sets one question + answer at
# signup or on first login post-migration. Reset requires email + correct
# answer + new password — no email delivery needed.

class RecoveryQuestionSetBody(BaseModel):
    question: str
    answer: str


@router.get("/recovery-question")
@limiter.limit("20/hour")
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
    session.add(user)
    session.commit()

    token = create_access_token(user.id)
    set_request_context(user_id=user.id)
    logger.info("auth_reset_ok", extra={"user_id": user.id, "email": body.email, "ip": ip})
    return Token(access_token=token)
