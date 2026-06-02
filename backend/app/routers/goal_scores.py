from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from app.auth import get_current_user
from app.database import get_session
from app.models import User
from app.services.goal_scoring import SUPPORTED_WINDOWS, calculate_goal_scores_for_user


router = APIRouter(prefix="/goals", tags=["goals"])


@router.get("/score")
def get_goal_score(
    window: str = Query(default="rolling_7d"),
    as_of: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Detailed active-goal execution, confidence, and projection payload.

    Defaults to rolling 7 days for execution feedback. The scoring service
    still loads goal-to-date progress measurements for projection calibration,
    so a single great day cannot dominate the projected outcome.
    """
    resolved_window = window if window in SUPPORTED_WINDOWS else "rolling_7d"
    return calculate_goal_scores_for_user(
        db,
        current_user.id,
        window=resolved_window,
        as_of=as_of,
    )

