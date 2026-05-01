"""Readiness endpoint — server-side canonical compute.

  POST /readiness/today  → return the canonical readiness score +
                           factor breakdown for the authed user.

The phone displays this directly, then forwards the EXACT response
to the watch via WCSession. Watch never computes its own score.
`computed_at_ms` lets the watch reject stale pushes that arrive
out-of-order on Bluetooth.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session

from app.auth import get_current_user
from app.database import get_session
from app.models import User
from app.services.readiness.compute import compute_readiness

router = APIRouter(prefix="/readiness", tags=["readiness"])


class ReadinessTodayBody(BaseModel):
    """Optional client-passed Apple Health signals — preferred over
    server-side snapshot lookups when present so the response uses
    today's freshest HK data without round-tripping a snapshot push.

    All optional. Backend pulls from DailyHealthSnapshot + SleepLog
    when fields are missing.

    Cycle fields come from the phone's `getCycleStatus` (HealthKit
    menstrual flow). Backend never persists or queries cycle data —
    it's a transient input that contributes to readiness when present
    and is ignored for users without it (male / no HK grant)."""
    avg_sleep_hours: float | None = None
    avg_resting_hr: float | None = None
    avg_hrv_ms: float | None = None
    last_night_sleep_score: int | None = None
    nutrition_adherence_pct: float | None = None
    planned_focus: str | None = None
    cycle_phase: str | None = None       # "menses" | "follicular" | "ovulation" | "luteal"
    day_of_cycle: int | None = None


@router.post("/today")
def readiness_today(
    body: ReadinessTodayBody = ReadinessTodayBody(),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Compute today's canonical readiness for the authed user. Always
    returns 200 with whatever signals are available — partial responses
    are normal (a user with no Apple Health still gets a score from
    fatigue + nutrition + yesterday's strain)."""
    result = compute_readiness(
        db, current_user.id,
        avg_sleep_hours=body.avg_sleep_hours,
        avg_resting_hr=body.avg_resting_hr,
        avg_hrv_ms=body.avg_hrv_ms,
        last_night_sleep_score=body.last_night_sleep_score,
        nutrition_adherence_pct=body.nutrition_adherence_pct,
        planned_focus=body.planned_focus,
        cycle_phase=body.cycle_phase,
        day_of_cycle=body.day_of_cycle,
    )
    return result.to_dict()
