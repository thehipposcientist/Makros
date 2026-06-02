"""Streak endpoints — workout / meal / readiness streaks.

Pure read, computed lazily from existing rows. See `services/streaks.py`
for the grace-day rules and timezone handling.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.auth import get_current_user
from app.database import get_session
from app.models import User
from app.services.streaks import compute_streaks

router = APIRouter(prefix="/streaks", tags=["streaks"])


@router.get("")
def get_streaks(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
) -> dict:
    """Return the user's current workout / meal / readiness streaks.

    Each entry includes `current`, `best` (within the last 365 days),
    `last_logged`, and `today_logged` so the client can render a
    "1 more meal to keep your 12-day streak" nudge without re-fetching.
    """
    # User timezone, when stored on the profile, drives "today" so a
    # late-night log doesn't break the streak on a server-tz mismatch.
    user_tz = getattr(current_user, "timezone", None)
    states = compute_streaks(db, current_user.id, user_tz=user_tz)
    return {"streaks": [s.to_dict() for s in states]}
