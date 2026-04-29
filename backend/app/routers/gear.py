"""Gear / equipment mileage tracking.

Users register physical gear (running shoes, bikes, etc.). The app
auto-accumulates miles from workout completions based on keyword matching,
and surfaces retirement recommendations when thresholds approach.
"""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.database import get_session
from app.models import (
    GearItem, GearItemCreate, GearItemRead,
    GEAR_RETIREMENT_DEFAULTS, User,
)
from app.routers.auth import get_current_user

router = APIRouter(prefix="/gear", tags=["gear"])


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _compute_fields(item: GearItem) -> GearItemRead:
    total = item.starting_miles + item.accumulated_miles
    threshold = item.retirement_threshold_miles
    if threshold is None:
        threshold = GEAR_RETIREMENT_DEFAULTS.get(item.gear_type)

    pct: float | None = None
    recommendation: str | None = None
    if threshold and threshold > 0:
        pct = total / threshold
        remaining = threshold - total
        if pct >= 1.0:
            recommendation = f"Retire — {total:.0f} mi logged, threshold is {threshold:.0f} mi."
        elif pct >= 0.85:
            recommendation = f"Plan replacement soon — {remaining:.0f} mi remaining of {threshold:.0f} mi lifetime."
        elif pct >= 0.65:
            recommendation = f"Halfway through lifespan — {remaining:.0f} mi remaining."
        else:
            recommendation = f"Good — {total:.0f} mi logged, {remaining:.0f} mi remaining."
    else:
        recommendation = f"{total:.0f} mi logged across {item.accumulated_sessions} sessions."

    return GearItemRead(
        id=item.id,
        name=item.name,
        gear_type=item.gear_type,
        purchase_date=item.purchase_date,
        starting_miles=item.starting_miles,
        accumulated_miles=item.accumulated_miles,
        accumulated_sessions=item.accumulated_sessions,
        is_active=item.is_active,
        retirement_threshold_miles=item.retirement_threshold_miles,
        auto_track_keywords=item.auto_track_keywords or [],
        notes=item.notes,
        created_at=item.created_at,
        total_miles=total,
        pct_used=round(pct, 4) if pct is not None else None,
        recommendation=recommendation,
    )


# ─── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("", response_model=list[GearItemRead])
def list_gear(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    items = db.exec(
        select(GearItem)
        .where(GearItem.user_id == current_user.id)
        .order_by(GearItem.created_at.desc())
    ).all()
    return [_compute_fields(i) for i in items]


@router.post("", response_model=GearItemRead, status_code=201)
def add_gear(
    body: GearItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    item = GearItem(
        user_id=current_user.id,
        name=body.name,
        gear_type=body.gear_type,
        purchase_date=body.purchase_date,
        starting_miles=body.starting_miles,
        retirement_threshold_miles=body.retirement_threshold_miles,
        auto_track_keywords=[kw.lower().strip() for kw in (body.auto_track_keywords or [])],
        notes=body.notes,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return _compute_fields(item)


@router.put("/{gear_id}", response_model=GearItemRead)
def update_gear(
    gear_id: int,
    body: GearItemCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    item = db.exec(
        select(GearItem)
        .where(GearItem.id == gear_id)
        .where(GearItem.user_id == current_user.id)
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Gear item not found")
    item.name = body.name
    item.gear_type = body.gear_type
    item.purchase_date = body.purchase_date
    item.starting_miles = body.starting_miles
    item.retirement_threshold_miles = body.retirement_threshold_miles
    item.auto_track_keywords = [kw.lower().strip() for kw in (body.auto_track_keywords or [])]
    item.notes = body.notes
    item.updated_at = datetime.now(timezone.utc)
    db.add(item)
    db.commit()
    db.refresh(item)
    return _compute_fields(item)


@router.delete("/{gear_id}", status_code=204)
def delete_gear(
    gear_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    item = db.exec(
        select(GearItem)
        .where(GearItem.id == gear_id)
        .where(GearItem.user_id == current_user.id)
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Gear item not found")
    db.delete(item)
    db.commit()


# ─── Manual mileage log ───────────────────────────────────────────────────────

class MileageLogBody(GearItemCreate):
    miles: float
    sessions: int = 1

    class Config:
        # Override parent fields as optional
        pass


from pydantic import BaseModel

class LogMilesBody(BaseModel):
    miles: float = 0.0
    sessions: int = 1
    note: str | None = None


@router.post("/{gear_id}/log-miles", response_model=GearItemRead)
def log_miles(
    gear_id: int,
    body: LogMilesBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    item = db.exec(
        select(GearItem)
        .where(GearItem.id == gear_id)
        .where(GearItem.user_id == current_user.id)
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Gear item not found")
    item.accumulated_miles += max(0.0, body.miles)
    item.accumulated_sessions += max(0, body.sessions)
    item.updated_at = datetime.now(timezone.utc)
    db.add(item)
    db.commit()
    db.refresh(item)
    return _compute_fields(item)


# ─── Retirement recommendations ───────────────────────────────────────────────

@router.get("/recommendations", response_model=list[GearItemRead])
def get_recommendations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return active gear items that are ≥65% of their retirement threshold."""
    items = db.exec(
        select(GearItem)
        .where(GearItem.user_id == current_user.id)
        .where(GearItem.is_active == True)
    ).all()
    alerts = []
    for item in items:
        computed = _compute_fields(item)
        if computed.pct_used is not None and computed.pct_used >= 0.65:
            alerts.append(computed)
    alerts.sort(key=lambda x: -(x.pct_used or 0))
    return alerts
