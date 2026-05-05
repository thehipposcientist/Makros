"""Sleep persistence endpoints.

Backs the per-night sleep history that previously lived only in
AsyncStorage on the client. Storing it server-side means:
  - new device sign-in retains history (was: lost),
  - personalized sleep score (needs 14+ nights) survives device wipes,
  - check-in / weekly-review coaches can reason about sleep.

The client (`src/services/appleHealth.ts::persistSleepHistory`) writes
the recent sleep-history window after every healthDataSummary refresh,
and the richer latest-night row separately. Endpoints are idempotent:
same night_date upserts.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import SleepLog, SleepLogUpsert, User

router = APIRouter(prefix="/sleep", tags=["sleep"])

_PATCH_FIELDS = (
    "total_hours", "in_bed_minutes", "deep_hours", "rem_hours",
    "core_hours", "awake_minutes", "hrv_ms", "resting_hr",
    "respiratory_rate", "spo2_percent", "bedtime_minutes_from_midnight",
    "score", "rating", "mode", "source",
)


def _upsert_sleep_log(
    session: Session,
    user_id: int,
    body: SleepLogUpsert,
    now: datetime,
) -> None:
    existing = session.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(SleepLog.night_date == body.night_date)
    ).first()
    if existing:
        for field in _PATCH_FIELDS:
            value = getattr(body, field)
            if value is not None:
                setattr(existing, field, value)
        existing.updated_at = now
        session.add(existing)
        return

    session.add(SleepLog(
        user_id=user_id,
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
    ))


def _refresh_sleep_dependents(user_id: int) -> None:
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(user_id)
    except Exception:
        pass


@router.post("/nightly")
def upsert_nightly_sleep(
    body: SleepLogUpsert,
    current_user: User = Depends(require_pro_feature("Sleep and recovery tracking")),
    session: Session = Depends(get_session),
):
    """Upsert one night's sleep snapshot. Patch semantics — fields the
    client doesn't have stay untouched on subsequent writes."""
    now = datetime.now(timezone.utc)
    _upsert_sleep_log(session, current_user.id, body, now)
    session.commit()
    _refresh_sleep_dependents(current_user.id)
    return {"status": "ok"}


@router.post("/nightly/batch")
def upsert_nightly_sleep_batch(
    body: List[SleepLogUpsert],
    current_user: User = Depends(require_pro_feature("Sleep and recovery tracking")),
    session: Session = Depends(get_session),
):
    """Backfill helper — phone can push the last N nights in one call
    when HealthKit permissions are granted. Upsert-by-night keeps it
    safe to retry on every refresh."""
    if len(body) > 90:
        raise HTTPException(status_code=400, detail="batch limited to 90 nights")
    now = datetime.now(timezone.utc)
    for item in body:
        _upsert_sleep_log(session, current_user.id, item, now)
    session.commit()
    if body:
        _refresh_sleep_dependents(current_user.id)
    return {"status": "ok", "count": len(body)}


@router.get("/history")
def list_sleep_history(
    days: int = 30,
    current_user: User = Depends(require_pro_feature("Sleep and recovery tracking")),
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
    current_user: User = Depends(require_pro_feature("Sleep and recovery tracking")),
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
