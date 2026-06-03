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
from app.services.health.sleep_pressure import compute_sleep_pressure
from app.services.integrations.sync_helpers import upsert_sleep_log as upsert_sleep_log_with_source

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
    values = {field: getattr(body, field) for field in _PATCH_FIELDS}
    upsert_sleep_log_with_source(
        session,
        user_id,
        body.night_date,
        body.source or "apple_health",
        values,
    )


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


@router.get("/pressure")
def get_sleep_pressure(
    days: int = 14,
    current_user: User = Depends(require_pro_feature("Sleep and recovery tracking")),
    session: Session = Depends(get_session),
):
    """Rolling sleep-pressure read for recovery context.

    The signal is capped and qualitative on purpose: it should help the
    user decide whether to protect recovery, not create an impossible
    "hours owed" chore list.
    """
    if days < 7 or days > 30:
        raise HTTPException(status_code=400, detail="days must be 7-30")
    today = datetime.now(timezone.utc).date()
    cutoff = today - timedelta(days=30)
    rows = session.exec(
        select(SleepLog)
        .where(SleepLog.user_id == current_user.id)
        .where(SleepLog.night_date >= cutoff)
        .where(SleepLog.night_date <= today)
        .order_by(SleepLog.night_date.asc())
    ).all()
    return compute_sleep_pressure(rows, as_of=today, window_days=days).to_dict()


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
