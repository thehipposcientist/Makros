"""Recovery activities — cold plunge / sauna / breathwork / meditation.

Logs parasympathetic-recovery modalities as a separate stream from
WorkoutCompletion so they don't pollute training-volume analytics. The
purpose is to let users correlate "logged ice bath last night → next
morning HRV" so they can see whether their $2k cold plunge is doing
anything for their recovery.

Routes:
  POST /recovery/activities          → log one
  GET  /recovery/activities          → list recent (bounded)
  DELETE /recovery/activities/{id}   → remove a mistaken entry
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, col, select

from app.auth import get_current_user
from app.database import get_session
from app.models import (
    RecoveryActivity,
    RecoveryActivityCreate,
    User,
)

router = APIRouter(prefix="/recovery", tags=["recovery"])


_KNOWN_MODALITIES = {
    "cold_plunge", "sauna", "breathwork", "meditation",
    "stretching", "yoga", "massage", "other",
}


@router.post("/activities", status_code=201)
def log_activity(
    body: RecoveryActivityCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Log a recovery activity. Free-form `intensity` is intentional —
    "10 min @ 50°F", "4-7-8 breathing", "sauna 12 min" all flex into
    one optional field."""
    if body.duration_min <= 0 or body.duration_min > 240:
        raise HTTPException(status_code=422, detail="duration_min must be 1–240")
    modality = (body.modality or "").strip().lower()
    if not modality:
        raise HTTPException(status_code=422, detail="modality is required")
    if modality not in _KNOWN_MODALITIES:
        # Accept unknowns under "other" rather than 422 — the modality
        # taxonomy will grow and we don't want to reject early adopters.
        modality = "other"
    row = RecoveryActivity(
        user_id=current_user.id,
        activity_date=body.activity_date,
        modality=modality,
        duration_min=int(body.duration_min),
        intensity=body.intensity,
        notes=body.notes,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_dict(row)


@router.get("/activities")
def list_activities(
    days: int = Query(default=30, ge=1, le=180),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    modality: Optional[str] = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Recent recovery activities, newest first. Default is the last
    30 days — enough to spot a trend on a per-modality basis."""
    cutoff = date.today() - timedelta(days=days)
    q = (
        select(RecoveryActivity)
        .where(RecoveryActivity.user_id == current_user.id)
        .where(col(RecoveryActivity.activity_date) >= cutoff)
        .order_by(col(RecoveryActivity.activity_date).desc(),
                  col(RecoveryActivity.created_at).desc())
        .offset(skip)
        .limit(limit)
    )
    if modality:
        q = q.where(RecoveryActivity.modality == modality.lower())
    rows = db.exec(q).all()
    return [_to_dict(r) for r in rows]


@router.delete("/activities/{activity_id}", status_code=204)
def delete_activity(
    activity_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = db.get(RecoveryActivity, activity_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="not found")
    db.delete(row)
    db.commit()


def _to_dict(r: RecoveryActivity) -> dict:
    return {
        "id": r.id,
        "activity_date": r.activity_date.isoformat() if r.activity_date else None,
        "modality": r.modality,
        "duration_min": r.duration_min,
        "intensity": r.intensity,
        "notes": r.notes,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }
