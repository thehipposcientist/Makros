from datetime import datetime, timedelta, timezone
from jose import JWTError, jwt
import bcrypt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlmodel import Session, select
from dotenv import load_dotenv
import os

from app.database import get_session
from app.models import User, TokenData

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", 129600))

# Fail fast on missing / weak key — a silent None would blow up every JWT
# operation at runtime instead of at boot. Allow short keys only when
# explicitly running in dev (no DATABASE_URL pointing at postgres).
if not SECRET_KEY or len(SECRET_KEY) < 32:
    _db = os.getenv("DATABASE_URL", "")
    if _db.startswith("postgres"):
        raise RuntimeError(
            "SECRET_KEY must be set and >=32 chars in production. "
            "Generate one with `openssl rand -hex 32` and inject via your secret store."
        )

bearer_scheme = HTTPBearer()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def create_access_token(
    user_id: int,
    *,
    token_version: int = 0,
    expires_delta: timedelta | None = None,
) -> str:
    """Issue a JWT for `user_id`. Always embed the user's current
    `token_version` as the `tv` claim so we can revoke every existing
    token by bumping `User.token_version` (logout, password change,
    password reset). Older tokens whose `tv` is below the user's current
    version are rejected by `get_current_user`.
    """
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    payload = {"sub": str(user_id), "exp": expire, "tv": int(token_version)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    session: Session = Depends(get_session),
) -> User:
    token = credentials.credentials
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub"))
        # `tv` was added 2026-04-29. Treat missing claim as 0 so every
        # JWT issued before this rollout still validates against the
        # default `User.token_version=0`. Once the user logs out / changes
        # password, any old tokens get rejected on next request.
        token_version = int(payload.get("tv", 0))
    except (JWTError, TypeError, ValueError):
        raise credentials_exception

    user = session.get(User, user_id)
    if not user or not user.is_active:
        raise credentials_exception
    if token_version < int(user.token_version or 0):
        raise credentials_exception
    return user
