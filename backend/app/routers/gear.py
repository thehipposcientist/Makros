"""Gear / equipment mileage tracking.

Users register physical gear (running shoes, bikes, etc.). The app
auto-accumulates miles from workout completions based on keyword matching,
and surfaces retirement recommendations when thresholds approach.
"""

import base64
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import (
    GearItem, GearItemCreate, GearItemRead,
    GEAR_RETIREMENT_DEFAULTS, User,
)
from app.routers.auth import get_current_user
from app.routers.ai.utils import (
    _build_chat_kwargs,
    _chat_create,
    _extract_json,
    get_openai_api_key,
    model_image,
)

router = APIRouter(prefix="/gear", tags=["gear"])


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _compute_fields(item: GearItem) -> GearItemRead:
    total = item.starting_miles + item.accumulated_miles
    threshold = item.retirement_threshold_miles
    if threshold is None:
        threshold = GEAR_RETIREMENT_DEFAULTS.get(item.gear_type)
    sessions = item.accumulated_sessions
    session_threshold = item.retirement_threshold_sessions

    pct: float | None = None
    recommendation: str | None = None
    if threshold and threshold > 0:
        # Mileage-tracked gear (running shoes, bikes, treadmill belts).
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
    elif session_threshold and session_threshold > 0:
        # Session-tracked gear with a wear threshold (e.g. boxing gloves
        # at ~150 sessions). Same retire-soon ladder, different unit.
        pct = sessions / session_threshold
        remaining = max(0, session_threshold - sessions)
        if pct >= 1.0:
            recommendation = f"Retire — {sessions} sessions logged, threshold is {session_threshold}."
        elif pct >= 0.85:
            recommendation = f"Plan replacement soon — {remaining} sessions remaining of {session_threshold} lifetime."
        elif pct >= 0.65:
            recommendation = f"Halfway through lifespan — {remaining} sessions remaining."
        else:
            recommendation = f"Good — {sessions} sessions logged, {remaining} remaining."
    else:
        # Session-only gear without a wear threshold — surface usage rather
        # than leaving the card empty. Combines total sessions with a
        # last-used hint when available so the user sees the gear is alive.
        if sessions == 0:
            recommendation = "No sessions logged yet — log a matching workout to start tracking."
        else:
            base = f"{sessions} session{'s' if sessions != 1 else ''} logged"
            if total > 0:
                base += f" ({total:.0f} mi)"
            if item.last_used_at:
                base += f" · last used {_friendly_ago(item.last_used_at)}"
            recommendation = base + "."

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
        retirement_threshold_sessions=item.retirement_threshold_sessions,
        last_used_at=item.last_used_at,
        auto_track_keywords=item.auto_track_keywords or [],
        notes=item.notes,
        created_at=item.created_at,
        photos=item.photos or [],
        total_miles=total,
        pct_used=round(pct, 4) if pct is not None else None,
        recommendation=recommendation,
    )


def _friendly_ago(ts: datetime) -> str:
    """Human-readable 'last used' delta. Backend formats this so the
    recommendation string ships ready-to-render (the frontend also does
    its own formatting from `last_used_at` for the dedicated badge)."""
    now = datetime.now(timezone.utc)
    # Naive datetimes from older rows — assume UTC.
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    delta = now - ts
    days = delta.days
    if days < 0:
        return "today"
    if days == 0:
        return "today"
    if days == 1:
        return "yesterday"
    if days < 7:
        return f"{days} days ago"
    if days < 30:
        weeks = days // 7
        return f"{weeks} week{'s' if weeks != 1 else ''} ago"
    if days < 365:
        months = days // 30
        return f"{months} month{'s' if months != 1 else ''} ago"
    years = days // 365
    return f"{years} year{'s' if years != 1 else ''} ago"


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
        retirement_threshold_sessions=body.retirement_threshold_sessions,
        auto_track_keywords=[kw.lower().strip() for kw in (body.auto_track_keywords or [])],
        photos=body.photos or [],
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
    item.retirement_threshold_sessions = body.retirement_threshold_sessions
    item.auto_track_keywords = [kw.lower().strip() for kw in (body.auto_track_keywords or [])]
    item.notes = body.notes
    item.photos = body.photos or []
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
    miles_added = max(0.0, body.miles)
    sessions_added = max(0, body.sessions)
    item.accumulated_miles += miles_added
    item.accumulated_sessions += sessions_added
    now = datetime.now(timezone.utc)
    item.updated_at = now
    if miles_added > 0 or sessions_added > 0:
        item.last_used_at = now
    db.add(item)
    db.commit()
    db.refresh(item)
    return _compute_fields(item)


# ─── AI gear identification ──────────────────────────────────────────────────

class GearIdentifyBody(BaseModel):
    images: list[str]  # one or more data URIs / raw base64 JPEG/PNG

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
    current_user: User = Depends(require_pro_feature("Gear photo identification")),
):
    """Use the configured vision model to identify gear and estimate wear from photos."""
    api_key = get_openai_api_key() or ""
    if not api_key:
        raise HTTPException(status_code=503, detail="AI identification unavailable")
    if not body.images:
        raise HTTPException(status_code=400, detail="At least one image required")

    # Strip data URI prefix and validate each image
    validated: list[str] = []
    for raw in body.images[:4]:  # cap at 4 to control token cost
        img_data = raw.split(",", 1)[1] if "," in raw else raw
        try:
            base64.b64decode(img_data, validate=True)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid base64 image")
        validated.append(img_data)

    from openai import OpenAI

    client = OpenAI(api_key=api_key)

    system = (
        "You are a fitness gear expert. The user will show you one or more photos of "
        "the same piece of athletic gear from different angles — running shoes, trail "
        "shoes, road/mountain bikes, gym shoes, weightlifting shoes, lifting belts, "
        "knee sleeves, wrist wraps, chest straps, yoga mats, climbing shoes, "
        "resistance bands, foam rollers, massage guns, boxing gloves, etc. "
        "Use all photos together to identify the item, estimate its current mileage / "
        "session count, and the expected total lifespan based on visible wear. For "
        "items where mileage doesn't apply (lifting accessories, yoga mats, recovery "
        "tools), set estimated_miles and retirement_threshold_miles to null — those "
        "items track by session count, not distance. "
        "Respond ONLY with a JSON object — no markdown, no commentary.\n"
        "JSON shape:\n"
        "{\n"
        '  "name": "Brand Model Name (e.g. Nike Pegasus 40)",\n'
        '  "gear_type": one of ["running_shoe","trail_shoe","cycling_shoe","bike",'
        '"bike_tire","bike_chain","treadmill_belt","jump_rope",'
        '"lifting_shoe","lifting_belt","knee_sleeves","wrist_wraps","lifting_straps",'
        '"chest_strap","yoga_mat","climbing_shoe","resistance_band","foam_roller",'
        '"massage_gun","boxing_gloves","other"],\n'
        '  "estimated_miles": float or null (miles already on the gear based on wear, '
        'null for non-distance items),\n'
        '  "retirement_threshold_miles": float or null (expected total lifespan in '
        'miles, null when the item tracks sessions instead),\n'
        '  "confidence": "high"|"medium"|"low",\n'
        '  "notes": "Short note about visible wear or identification confidence"\n'
        "}"
    )

    photo_count = len(validated)
    user_content: list[dict] = []
    for img_data in validated:
        user_content.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{img_data}",
                "detail": "low",
            },
        })
    user_content.append({
        "type": "text",
        "text": (
            f"These are {photo_count} photo(s) of the same gear item. "
            "Identify it and estimate its mileage."
        ),
    })

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]
    kwargs = _build_chat_kwargs(
        model_image(),
        messages,
        max_tokens=300,
        timeout_secs=30,
    )
    resp = _chat_create(
        client,
        **kwargs,
    )

    raw = resp.choices[0].message.content or "{}"
    try:
        parsed = _extract_json(raw)
    except Exception:
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
