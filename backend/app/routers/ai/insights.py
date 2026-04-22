"""Progress-insight endpoints — weekly digest + plateau detection.

Deterministic, no AI. The router is registered on the shared ``/ai``
prefix because the client already points its coaching UI there; these
endpoints are conceptually the same family (coaching insights derived
from workout/nutrition history) even though no LLM is invoked.
"""
from __future__ import annotations

from fastapi import Depends
from sqlmodel import Session

from app.auth import get_current_user
from app.database import get_session
from app.models import User

from .router import router


@router.get("/weekly-digest")
def weekly_digest(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the Sunday-style weekly review payload.

    Backed by ``build_weekly_digest``. See that service for shape + field
    semantics. Response is always 200; empty weeks return zeroed counts.
    """
    from app.services.workout.weekly_digest import build_weekly_digest
    return build_weekly_digest(current_user.id, db=db)


@router.get("/plateaus")
def plateaus(
    window_weeks: int = 4,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return exercises where the user's estimated 1RM has stalled.

    Query params:
      - window_weeks (default 4) — how many weeks' peaks must be within
        the tolerance band to be flagged as a plateau.
    """
    from app.services.workout.plateau_detection import detect_plateaus
    return {"plateaus": detect_plateaus(current_user.id, db=db, window_weeks=window_weeks)}
