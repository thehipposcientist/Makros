"""Sleep persistence endpoints.

Backs the per-night sleep history that previously lived only in
AsyncStorage on the client. Storing it server-side means:
  - new device sign-in retains history (was: lost),
  - personalized sleep score (needs 14+ nights) survives device wipes,
  - check-in / weekly-review coaches can reason about sleep.

The client (`src/services/appleHealth.ts::persistSleepHistory` →
new `pushNightlySleepToBackend`) writes the latest night after every
healthDataSummary refresh. Endpoint is idempotent: same night_date
upserts.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import SleepLog, SleepLogUpsert, User

router = APIRouter(prefix="/sleep", tags=["sleep"])


@router.post("/nightly")
def upsert_nightly_sleep(
    body: SleepLogUpsert,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Upsert one night's sleep snapshot. Patch semantics — fields the
    client doesn't have stay untouched on subsequent writes."""
    now = datetime.now(timezone.utc)
    existing = session.exec(
        select(SleepLog)
        .where(SleepLog.user_id == current_user.id)
        .where(SleepLog.night_date == body.night_date)
    ).first()
    if existing:
        for field in (
            "total_hours", "in_bed_minutes", "deep_hours", "rem_hours",
            "core_hours", "awake_minutes", "hrv_ms", "resting_hr",
            "respiratory_rate", "spo2_percent", "bedtime_minutes_from_midnight",
            "score", "rating", "mode", "source",
        ):
            value = getattr(body, field)
            if value is not None:
                setattr(existing, field, value)
        existing.updated_at = now
        session.add(existing)
    else:
        row = SleepLog(
            user_id=current_user.id,
            night_date=body.night_date,
            total_hours=body.total_hours,
            in_bed_minutes=body.in_bed_minutes,
            deep_hours=body.deep_hours,
            rem_hours=body.rem_hours,
            core_hours=body.core_hours,
            awake_minutes=body.awake_minutes,
            hrv_ms=body.hrv_ms,
            resting_hr=body.resting_hr,
            respiratory_rate=body.respiratory_rate,
            spo2_percent=body.spo2_percent,
            bedtime_minutes_from_midnight=body.bedtime_minutes_from_midnight,
            score=body.score,
            rating=body.rating,
            mode=body.mode,
            source=body.source or "apple_health",
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    session.commit()
    return {"status": "ok"}


@router.get("/history")
def list_sleep_history(
    days: int = 30,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> List[dict]:
    """Returns the last `days` nights of sleep, oldest-first. Powers
    the personalized score baseline (HRV history + bedtime regularity)."""
    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="days must be 1-365")
    cutoff = (datetime.now(timezone.utc).date()) - timedelta(days=days)
    rows = session.exec(
        select(SleepLog)
        .where(SleepLog.user_id == current_user.id)
        .where(SleepLog.night_date >= cutoff)
        .order_by(SleepLog.night_date.asc())
    ).all()
    return [
        {
            "night_date": str(r.night_date),
            "total_hours": r.total_hours,
            "in_bed_minutes": r.in_bed_minutes,
            "deep_hours": r.deep_hours,
            "rem_hours": r.rem_hours,
            "core_hours": r.core_hours,
            "awake_minutes": r.awake_minutes,
            "hrv_ms": r.hrv_ms,
            "resting_hr": r.resting_hr,
            "respiratory_rate": r.respiratory_rate,
            "spo2_percent": r.spo2_percent,
            "bedtime_minutes_from_midnight": r.bedtime_minutes_from_midnight,
            "score": r.score,
            "rating": r.rating,
            "mode": r.mode,
            "source": r.source,
        }
        for r in rows
    ]


@router.get("/today")
def get_today_sleep(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Single-night fetch for today (the row whose night_date is today's
    waking date). Returns null if not yet logged."""
    today = datetime.now(timezone.utc).date()
    r = session.exec(
        select(SleepLog)
        .where(SleepLog.user_id == current_user.id)
        .where(SleepLog.night_date == today)
    ).first()
    if not r:
        return None
    return {
        "night_date": str(r.night_date),
        "total_hours": r.total_hours,
        "score": r.score,
        "rating": r.rating,
        "mode": r.mode,
        "hrv_ms": r.hrv_ms,
        "resting_hr": r.resting_hr,
    }
