"""Daily Apple Health snapshot persistence.

Per-user per-day rollup of HealthKit + Apple Watch numbers (steps,
active/basal energy, workout/cardio/Z2 minutes, RHR, HRV, VO2 max,
weight, optional readiness composite). The phone aggregator
(`src/services/healthDataSummary.ts`) only knows about today + a
30-min stale window; persisting daily lets `weekly_review`,
`recovery_flags`, and the check-in coach reason about real history
instead of asking HealthKit again on every backend request.

Patch semantics — fields the client doesn't have stay untouched on
subsequent writes (a partial-permissions user still gets meaningful
rows, and a later push can fill gaps without clobbering).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import (
    DailyHealthSnapshot,
    DailyHealthSnapshotUpsert,
    DailyStressSummary,
    DailyStressSummaryUpsert,
    HealthLabResult,
    User,
)
from app.services.health.stress_history import build_stress_history_response, stress_row_to_dict
from app.services.labs import (
    default_lab_unit,
    lab_label,
    list_lab_markers,
    normalize_lab_type,
    normalize_lab_value,
)

router = APIRouter(prefix="/health", tags=["health"])


_PATCH_FIELDS = (
    "steps", "active_energy_kcal", "basal_energy_kcal", "workout_minutes",
    "cardio_minutes", "zone2_minutes", "resting_hr", "hrv_ms", "vo2_max",
    "respiratory_rate", "oxygen_saturation", "wrist_temperature_c",
    "sleep_breathing_disturbances", "sleep_breathing_disturbances_elevated",
    "weight_lbs", "readiness_score",
)

_STRESS_SOURCES = {
    "thallo_estimate",
    "logs_estimate",
    "hr_logs_estimate",
    "manual",
    "imported",
    "unknown",
}


def _row_to_dict(r: DailyHealthSnapshot) -> dict:
    return {
        "snapshot_date": str(r.snapshot_date),
        "steps": r.steps,
        "active_energy_kcal": r.active_energy_kcal,
        "basal_energy_kcal": r.basal_energy_kcal,
        "workout_minutes": r.workout_minutes,
        "cardio_minutes": r.cardio_minutes,
        "zone2_minutes": r.zone2_minutes,
        "resting_hr": r.resting_hr,
        "hrv_ms": r.hrv_ms,
        "vo2_max": r.vo2_max,
        "respiratory_rate": r.respiratory_rate,
        "oxygen_saturation": r.oxygen_saturation,
        "wrist_temperature_c": r.wrist_temperature_c,
        "sleep_breathing_disturbances": r.sleep_breathing_disturbances,
        "sleep_breathing_disturbances_elevated": r.sleep_breathing_disturbances_elevated,
        "weight_lbs": r.weight_lbs,
        "readiness_score": r.readiness_score,
        "source": r.source,
        "source_details": r.source_details,
    }


def _stress_score(value: float | int | None, field: str) -> float | None:
    if value is None:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be numeric")
    if numeric < 0 or numeric > 100:
        raise HTTPException(status_code=400, detail=f"{field} must be between 0 and 100")
    return round(numeric, 1)


def _stress_count(value: int | None, field: str) -> int:
    if value is None:
        return 0
    try:
        numeric = int(value)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=f"{field} must be an integer")
    return max(0, min(numeric, 10000))


def _stress_source(value: str | None) -> str:
    source = str(value or "thallo_estimate").strip().lower()
    return source if source in _STRESS_SOURCES else "unknown"


def _refresh_health_dependents(session: Session, user_id: int, as_of: date) -> None:
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(user_id)
    except Exception:
        pass
    try:
        from app.services.coach.rollups import recompute_user
        recompute_user(session, user_id=user_id, as_of=as_of, lookback_days=35)
    except Exception:
        pass


def _merged_source_details(
    current: dict | None,
    incoming: dict | None,
    fallback_source: str | None,
) -> dict | None:
    """Merge sparse per-field provenance without losing older providers."""
    merged: dict = dict(current) if isinstance(current, dict) else {}
    if fallback_source:
        providers = set(merged.get("providers") or [])
        providers.add(fallback_source)
        merged["providers"] = sorted(providers)
        merged["last_source"] = fallback_source
    if isinstance(incoming, dict):
        incoming_providers = incoming.get("providers")
        if isinstance(incoming_providers, list):
            providers = set(merged.get("providers") or [])
            providers.update(str(p) for p in incoming_providers if p)
            merged["providers"] = sorted(providers)
        incoming_fields = incoming.get("fields")
        if isinstance(incoming_fields, dict):
            fields = dict(merged.get("fields") or {})
            fields.update({str(k): str(v) for k, v in incoming_fields.items() if v is not None})
            merged["fields"] = fields
        for key, value in incoming.items():
            if key not in {"providers", "fields"} and value is not None:
                merged[key] = value
    return merged or None


class HealthLabResultPayload(BaseModel):
    lab_type: str
    value: float
    unit: str | None = None
    collected_at: str | None = None
    source: str | None = None
    reference_range_low: float | None = None
    reference_range_high: float | None = None


def _parse_lab_collected_at(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    raw = str(value).strip()
    if not raw:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:
        parsed_date = date.fromisoformat(raw[:10])
        return datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(status_code=400, detail="collected_at must be an ISO date or datetime")


def _clean_lab_source(value: str | None, default: str = "manual") -> str:
    raw = str(value or default).strip().lower()
    if raw not in {"manual", "imported", "scan", "clinician", "unknown"}:
        return default
    return raw


def _lab_row_to_dict(row: HealthLabResult) -> dict:
    return {
        "id": row.id,
        "lab_type": row.lab_type,
        "lab_label": lab_label(row.lab_type),
        "value": row.value,
        "unit": row.unit or default_lab_unit(row.lab_type),
        "collected_at": row.collected_at.isoformat(),
        "source": row.source,
        "reference_range_low": row.reference_range_low,
        "reference_range_high": row.reference_range_high,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _build_lab_row(payload: HealthLabResultPayload, user_id: int) -> HealthLabResult:
    lab_type = normalize_lab_type(payload.lab_type)
    if not lab_type:
        raise HTTPException(status_code=400, detail="lab_type is required")
    try:
        value, unit = normalize_lab_value(lab_type, payload.value, payload.unit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if abs(value) > 1_000_000:
        raise HTTPException(status_code=400, detail="value is outside the accepted range")
    unit = unit[:40]
    return HealthLabResult(
        user_id=user_id,
        lab_type=lab_type,
        value=value,
        unit=unit,
        collected_at=_parse_lab_collected_at(payload.collected_at),
        source=_clean_lab_source(payload.source),
        reference_range_low=payload.reference_range_low,
        reference_range_high=payload.reference_range_high,
    )


@router.get("/labs/markers")
def get_lab_markers(
    current_user: User = Depends(require_pro_feature("Lab tracking")),
):
    """Return canonical lab marker metadata used by manual entry UIs."""
    return {"markers": list_lab_markers()}


@router.get("/labs")
def list_lab_results(
    days: int = 365,
    current_user: User = Depends(require_pro_feature("Lab tracking")),
    session: Session = Depends(get_session),
) -> List[dict]:
    """List user-confirmed lab rows. Labs are optional wellness context;
    the API stores normalized marker rows, never raw reports."""
    if days < 1 or days > 3650:
        raise HTTPException(status_code=400, detail="days must be 1-3650")
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    rows = session.exec(
        select(HealthLabResult)
        .where(HealthLabResult.user_id == current_user.id)
        .where(HealthLabResult.collected_at >= cutoff)
        .order_by(HealthLabResult.collected_at.desc(), HealthLabResult.id.desc())
    ).all()
    return [_lab_row_to_dict(row) for row in rows]


@router.post("/labs")
def create_lab_result(
    body: HealthLabResultPayload,
    current_user: User = Depends(require_pro_feature("Lab tracking")),
    session: Session = Depends(get_session),
):
    row = _build_lab_row(body, current_user.id)
    session.add(row)
    session.commit()
    session.refresh(row)
    _refresh_health_dependents(session, current_user.id, row.collected_at.date())
    return _lab_row_to_dict(row)


@router.post("/labs/batch")
def create_lab_results_batch(
    body: List[HealthLabResultPayload],
    current_user: User = Depends(require_pro_feature("Lab tracking")),
    session: Session = Depends(get_session),
):
    if len(body) > 80:
        raise HTTPException(status_code=400, detail="batch limited to 80 lab rows")
    rows = [_build_lab_row(payload, current_user.id) for payload in body]
    for row in rows:
        session.add(row)
    session.commit()
    for row in rows:
        session.refresh(row)
    if rows:
        _refresh_health_dependents(
            session,
            current_user.id,
            max(row.collected_at.date() for row in rows),
        )
    return {"status": "ok", "count": len(rows), "labs": [_lab_row_to_dict(row) for row in rows]}


@router.delete("/labs/{lab_id}")
def delete_lab_result(
    lab_id: int,
    current_user: User = Depends(require_pro_feature("Lab tracking")),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(HealthLabResult)
        .where(HealthLabResult.id == lab_id)
        .where(HealthLabResult.user_id == current_user.id)
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="lab result not found")
    as_of = row.collected_at.date()
    session.delete(row)
    session.commit()
    _refresh_health_dependents(session, current_user.id, as_of)
    return {"status": "ok", "deleted": lab_id}


@router.post("/snapshot")
def upsert_snapshot(
    body: DailyHealthSnapshotUpsert,
    current_user: User = Depends(require_pro_feature("Apple Health sync")),
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
        existing.source_details = _merged_source_details(
            existing.source_details,
            body.source_details,
            body.source,
        )
        existing.updated_at = now
        session.add(existing)
    else:
        row = DailyHealthSnapshot(
            user_id=current_user.id,
            snapshot_date=body.snapshot_date,
            steps=body.steps,
            active_energy_kcal=body.active_energy_kcal,
            basal_energy_kcal=body.basal_energy_kcal,
            workout_minutes=body.workout_minutes,
            cardio_minutes=body.cardio_minutes,
            zone2_minutes=body.zone2_minutes,
            resting_hr=body.resting_hr,
            hrv_ms=body.hrv_ms,
            vo2_max=body.vo2_max,
            respiratory_rate=body.respiratory_rate,
            oxygen_saturation=body.oxygen_saturation,
            wrist_temperature_c=body.wrist_temperature_c,
            sleep_breathing_disturbances=body.sleep_breathing_disturbances,
            sleep_breathing_disturbances_elevated=body.sleep_breathing_disturbances_elevated,
            weight_lbs=body.weight_lbs,
            readiness_score=body.readiness_score,
            source=body.source or "apple_health",
            source_details=_merged_source_details(None, body.source_details, body.source or "apple_health"),
            created_at=now,
            updated_at=now,
        )
        session.add(row)
    session.commit()
    _refresh_health_dependents(session, current_user.id, body.snapshot_date)
    return {"status": "ok"}


@router.post("/snapshot/batch")
def upsert_snapshot_batch(
    body: List[DailyHealthSnapshotUpsert],
    current_user: User = Depends(require_pro_feature("Apple Health sync")),
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
            existing.source_details = _merged_source_details(
                existing.source_details,
                snap.source_details,
                snap.source,
            )
            existing.updated_at = now
            session.add(existing)
        else:
            session.add(DailyHealthSnapshot(
                user_id=current_user.id,
                snapshot_date=snap.snapshot_date,
                steps=snap.steps,
                active_energy_kcal=snap.active_energy_kcal,
                basal_energy_kcal=snap.basal_energy_kcal,
                workout_minutes=snap.workout_minutes,
                cardio_minutes=snap.cardio_minutes,
                zone2_minutes=snap.zone2_minutes,
                resting_hr=snap.resting_hr,
                hrv_ms=snap.hrv_ms,
                vo2_max=snap.vo2_max,
                respiratory_rate=snap.respiratory_rate,
                oxygen_saturation=snap.oxygen_saturation,
                wrist_temperature_c=snap.wrist_temperature_c,
                sleep_breathing_disturbances=snap.sleep_breathing_disturbances,
                sleep_breathing_disturbances_elevated=snap.sleep_breathing_disturbances_elevated,
                weight_lbs=snap.weight_lbs,
                readiness_score=snap.readiness_score,
                source=snap.source or "apple_health",
                source_details=_merged_source_details(None, snap.source_details, snap.source or "apple_health"),
                created_at=now,
                updated_at=now,
            ))
    session.commit()
    if body:
        _refresh_health_dependents(
            session,
            current_user.id,
            max(snap.snapshot_date for snap in body),
        )
    return {"status": "ok", "count": len(body)}


@router.get("/history")
def list_snapshot_history(
    days: int = 30,
    current_user: User = Depends(require_pro_feature("Apple Health sync")),
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


@router.post("/stress-summary")
def upsert_stress_summary(
    body: DailyStressSummaryUpsert,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Persist the Daily Stress timeline's per-day aggregate.

    This is recovery context only. It records the user's daily average
    and baseline history; it never mutates the active PlanWeek.
    """
    today = datetime.now(timezone.utc).date()
    if body.summary_date > today + timedelta(days=1):
        raise HTTPException(status_code=400, detail="summary_date cannot be in the future")
    now = datetime.now(timezone.utc)
    avg_stress = _stress_score(body.avg_stress, "avg_stress")
    if avg_stress is None:
        raise HTTPException(status_code=400, detail="avg_stress is required")
    max_stress = _stress_score(body.max_stress, "max_stress")
    latest_stress = _stress_score(body.latest_stress, "latest_stress")
    existing = session.exec(
        select(DailyStressSummary)
        .where(DailyStressSummary.user_id == current_user.id)
        .where(DailyStressSummary.summary_date == body.summary_date)
    ).first()
    fields = {
        "avg_stress": avg_stress,
        "max_stress": max_stress,
        "latest_stress": latest_stress,
        "sample_count": _stress_count(body.sample_count, "sample_count"),
        "source_count": _stress_count(body.source_count, "source_count"),
        "source": _stress_source(body.source),
        "source_details": body.source_details if isinstance(body.source_details, dict) else None,
        "computed_at": body.computed_at or now,
        "updated_at": now,
    }
    if existing:
        for field, value in fields.items():
            setattr(existing, field, value)
        session.add(existing)
        row = existing
    else:
        row = DailyStressSummary(
            user_id=current_user.id,
            summary_date=body.summary_date,
            created_at=now,
            **fields,
        )
        session.add(row)
    session.commit()
    session.refresh(row)
    return {"status": "ok", "summary": stress_row_to_dict(row)}


@router.get("/stress-history")
def list_stress_history(
    days: int = 30,
    baseline_days: int = 14,
    as_of: date | None = None,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return daily stress summaries with a personal baseline.

    Baseline excludes today so the comparison can answer "more stressed
    than usual" from prior days only.
    """
    if days < 1 or days > 365:
        raise HTTPException(status_code=400, detail="days must be 1-365")
    if baseline_days < 3 or baseline_days > 90:
        raise HTTPException(status_code=400, detail="baseline_days must be 3-90")
    today = datetime.now(timezone.utc).date()
    effective_as_of = as_of or today
    if effective_as_of > today + timedelta(days=1):
        raise HTTPException(status_code=400, detail="as_of cannot be in the future")
    cutoff = effective_as_of - timedelta(days=max(days - 1, baseline_days))
    rows = session.exec(
        select(DailyStressSummary)
        .where(DailyStressSummary.user_id == current_user.id)
        .where(DailyStressSummary.summary_date >= cutoff)
        .where(DailyStressSummary.summary_date <= effective_as_of)
        .order_by(DailyStressSummary.summary_date.asc())
    ).all()
    visible_cutoff = effective_as_of - timedelta(days=days - 1)
    visible_rows = [row for row in rows if row.summary_date >= visible_cutoff]
    return build_stress_history_response(
        rows,
        as_of=effective_as_of,
        days=days,
        baseline_days=baseline_days,
        visible_rows=visible_rows,
    )


@router.get("/today")
def get_today_snapshot(
    current_user: User = Depends(require_pro_feature("Apple Health sync")),
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


@router.get("/metabolic-signals")
def get_metabolic_signals(
    days: int = 30,
    current_user: User = Depends(require_pro_feature("Metabolic signals")),
    session: Session = Depends(get_session),
):
    """Rolling hormone-support and cellular-cleanup estimates.

    This endpoint is deterministic and confidence-gated. It does not measure
    hormone levels or autophagy directly; it estimates whether the user's
    recent sleep, nutrition, activity, body trend, and wearable signals are
    supportive or strained.
    """
    from app.services.health.metabolic_signals import build_metabolic_signals_response

    return build_metabolic_signals_response(session, current_user.id, days=days)
