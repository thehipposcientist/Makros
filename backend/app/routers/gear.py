"""Gear / equipment mileage tracking.

Users register physical gear (running shoes, bikes, etc.). The app
auto-accumulates miles from workout completions based on keyword matching,
and surfaces retirement recommendations when thresholds approach.
"""

import base64
import os
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
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


# ─── AI gear identification ──────────────────────────────────────────────────

class GearIdentifyBody(BaseModel):
    image_base64: str  # data URI or raw base64 JPEG/PNG

class GearIdentifyResult(BaseModel):
    name: str
    gear_type: str
    estimated_miles: float | None = None
    retirement_threshold_miles: float | None = None
    confidence: str  # "high" | "medium" | "low"
    notes: str | None = None


@router.post("/identify", response_model=GearIdentifyResult)
def identify_gear(
    body: GearIdentifyBody,
    current_user: User = Depends(get_current_user),
):
    """Use GPT-4o vision to identify gear from a photo and estimate mileage."""
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="AI identification unavailable")

    # Strip data URI prefix if present
    img_data = body.image_base64
    if "," in img_data:
        img_data = img_data.split(",", 1)[1]

    # Validate it's real base64
    try:
        base64.b64decode(img_data, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image")

    import json
    from openai import OpenAI

    client = OpenAI(api_key=api_key)

    system = (
        "You are a fitness gear expert. The user will show you a photo of their "
        "athletic gear (running shoes, trail shoes, road bike, mountain bike, "
        "gym shoes, weightlifting shoes, etc.). Identify it and estimate its "
        "current mileage and remaining lifespan based on visible wear. "
        "Respond ONLY with a JSON object — no markdown, no commentary.\n"
        "JSON shape:\n"
        "{\n"
        '  "name": "Brand Model Name (e.g. Nike Pegasus 40)",\n'
        '  "gear_type": one of ["running_shoe","trail_shoe","road_bike",'
        '"mountain_bike","gym_shoe","weightlifting_shoe","other"],\n'
        '  "estimated_miles": float or null (miles already on the gear based on wear),\n'
        '  "retirement_threshold_miles": float or null (expected total lifespan),\n'
        '  "confidence": "high"|"medium"|"low",\n'
        '  "notes": "Short note about visible wear or identification confidence"\n'
        "}"
    )

    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{img_data}",
                            "detail": "low",
                        },
                    },
                    {"type": "text", "text": "Identify this gear and estimate its mileage."},
                ],
            },
        ],
        max_tokens=300,
    )

    raw = resp.choices[0].message.content or "{}"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Strip markdown fences if present
        clean = raw.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
        try:
            parsed = json.loads(clean)
        except json.JSONDecodeError:
            raise HTTPException(status_code=502, detail="AI returned unparseable response")

    return GearIdentifyResult(
        name=str(parsed.get("name", "Unknown gear")),
        gear_type=str(parsed.get("gear_type", "other")),
        estimated_miles=parsed.get("estimated_miles"),
        retirement_threshold_miles=parsed.get("retirement_threshold_miles"),
        confidence=str(parsed.get("confidence", "low")),
        notes=parsed.get("notes"),
    )


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
