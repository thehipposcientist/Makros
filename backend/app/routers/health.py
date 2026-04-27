"""Daily Apple Health snapshot persistence.

Per-user per-day rollup of HealthKit + Apple Watch numbers (steps,
active energy, workout/cardio/Z2 minutes, RHR, HRV, VO2 max, weight,
optional readiness composite). The phone aggregator
(`src/services/healthDataSummary.ts`) only knows about today + a
30-min stale window; persisting daily lets `weekly_review`,
`recovery_flags`, and the check-in coach reason about real history
instead of asking HealthKit again on every backend request.

Patch semantics — fields the client doesn't have stay untouched on
subsequent writes (a partial-permissions user still gets meaningful
rows, and a later push can fill gaps without clobbering).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import DailyHealthSnapshot, DailyHealthSnapshotUpsert, User

router = APIRouter(prefix="/health", tags=["health"])


_PATCH_FIELDS = (
    "steps", "active_energy_kcal", "workout_minutes", "cardio_minutes",
    "zone2_minutes", "resting_hr", "hrv_ms", "vo2_max", "weight_lbs",
    "readiness_score",
)


def _row_to_dict(r: DailyHealthSnapshot) -> dict:
    return {
        "snapshot_date": str(r.snapshot_date),
        "steps": r.steps,
        "active_energy_kcal": r.active_energy_kcal,
        "workout_minutes": r.workout_minutes,
        "cardio_minutes": r.cardio_minutes,
        "zone2_minutes": r.zone2_minutes,
        "resting_hr": r.resting_hr,
        "hrv_ms": r.hrv_ms,
        "vo2_max": r.vo2_max,
        "weight_lbs": r.weight_lbs,
        "readiness_score": r.readiness_score,
        "source": r.source,
    }


@router.post("/snapshot")
def upsert_snapshot(
    body: DailyHealthSnapshotUpsert,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Upsert a single day's HealthKit snapshot. Patch semantics — only
    non-null fields overwrite stored values."""
    now = datetime.now(timezone.utc)
    existing = session.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == current_user.id)
        .where(DailyHealthSnapshot.snapshot_date == body.snapshot_date)
    ).first()
    if existing:
        for field in _PATCH_FIELDS:
            value = getattr(body, field)
            if value is not None:
                setattr(existing, field, value)
        if body.source:
            existing.source = body.source
        existing.updated_at = now
        session.add(existing)
    else:
        row = DailyHealthSnapshot(
            user_id=current_user.id,
            snapshot_date=body.snapshot_date,
            steps=body.steps,
            active_energy_kcal=body.active_energy_kcal,
            workout_minutes=body.workout_minutes,
            cardio_minutes=body.cardio_minutes,
            zone2_minutes=body.zone2_minutes,
            resting_hr=body.resting_hr,
            hrv_ms=body.hrv_ms,
            vo2_max=body.vo2_max,
            weight_lbs=body.weight_lbs,
            readiness_score=body.readiness_score,
            source=body.source or "apple_health",
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    session.commit()
    # Sleep / HRV / RHR are readiness pillars — drop the cache so the
    # next /readiness/today reflects the freshly pushed snapshot.
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(current_user.id)
    except Exception:
        pass
    return {"status": "ok"}


@router.post("/snapshot/batch")
def upsert_snapshot_batch(
    body: List[DailyHealthSnapshotUpsert],
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Backfill helper — phone can push the last N days in one call when
    HealthKit permissions are first granted."""
    if len(body) > 90:
        raise HTTPException(status_code=400, detail="batch limited to 90 days")
    now = datetime.now(timezone.utc)
    for snap in body:
        existing = session.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == current_user.id)
            .where(DailyHealthSnapshot.snapshot_date == snap.snapshot_date)
        ).first()
        if existing:
            for field in _PATCH_FIELDS:
                value = getattr(snap, field)
                if value is not None:
                    setattr(existing, field, value)
            if snap.source:
                existing.source = snap.source
            existing.updated_at = now
            session.add(existing)
        else:
            session.add(DailyHealthSnapshot(
                user_id=current_user.id,
                snapshot_date=snap.snapshot_date,
                steps=snap.steps,
                active_energy_kcal=snap.active_energy_kcal,
                workout_minutes=snap.workout_minutes,
                cardio_minutes=snap.cardio_minutes,
                zone2_minutes=snap.zone2_minutes,
                resting_hr=snap.resting_hr,
                hrv_ms=snap.hrv_ms,
                vo2_max=snap.vo2_max,
                weight_lbs=snap.weight_lbs,
                readiness_score=snap.readiness_score,
                source=snap.source or "apple_health",
                created_at=now,
                updated_at=now,
            ))
    session.commit()
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(current_user.id)
    except Exception:
        pass
    return {"status": "ok", "count": len(body)}


@router.get("/history")
def list_snapshot_history(
    days: int = 30,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> List[dict]:
    """Returns the last `days` daily snapshots, oldest-first. Used by
    weekly_review + recovery_flags for trend signals."""
    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="days must be 1-365")
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=days)
    rows = session.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == current_user.id)
        .where(DailyHealthSnapshot.snapshot_date >= cutoff)
        .order_by(DailyHealthSnapshot.snapshot_date.asc())
    ).all()
    return [_row_to_dict(r) for r in rows]


@router.get("/today")
def get_today_snapshot(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Single-day fetch for today. Returns null if not yet logged."""
    today = datetime.now(timezone.utc).date()
    r = session.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == current_user.id)
        .where(DailyHealthSnapshot.snapshot_date == today)
    ).first()
    if not r:
        return None
    return _row_to_dict(r)
