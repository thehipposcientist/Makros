from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field as PydanticField
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import DailyLifestyleLog, User
from app.services.readiness.compute import invalidate_readiness_cache


router = APIRouter(prefix="/lifestyle", tags=["lifestyle"])


ALCOHOL_LEVELS = {"none", "light", "moderate", "heavy"}
CANNABIS_LEVELS = {"none", "light", "moderate", "heavy"}
TIMINGS = {"morning", "afternoon", "evening", "late", "unknown"}
BOWEL_CONSISTENCY = {"normal", "loose", "hard", "mixed", "not_sure"}
STRESS_LEVELS = {"low", "moderate", "high"}
ILLNESS_STATES = {"healthy", "rundown", "sick"}
APPETITE_LEVELS = {"low", "normal", "high"}
SOURCES = {"manual", "offline_draft", "watch"}


class DailyLifestyleLogPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    alcohol_level: str | None = PydanticField(default=None, alias="alcoholLevel")
    alcohol_drinks: float | None = PydanticField(default=None, alias="alcoholDrinks")
    alcohol_timing: str | None = PydanticField(default=None, alias="alcoholTiming")
    cannabis_level: str | None = PydanticField(default=None, alias="cannabisLevel")
    cannabis_timing: str | None = PydanticField(default=None, alias="cannabisTiming")
    bowel_movement_count: int | None = PydanticField(default=None, alias="bowelMovementCount")
    bowel_consistency: str | None = PydanticField(default=None, alias="bowelConsistency")
    stress_level: str | None = PydanticField(default=None, alias="stressLevel")
    illness_state: str | None = PydanticField(default=None, alias="illnessState")
    caffeine_mg: float | None = PydanticField(default=None, alias="caffeineMg")
    caffeine_timing: str | None = PydanticField(default=None, alias="caffeineTiming")
    late_caffeine: bool | None = PydanticField(default=None, alias="lateCaffeine")
    appetite: str | None = None
    notes: str | None = None
    source: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_enum(value: Any, allowed: set[str], field_name: str) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip().lower()
    if not cleaned:
        return None
    if cleaned not in allowed:
        raise HTTPException(status_code=400, detail=f"invalid {field_name}")
    return cleaned


def _clean_float(value: Any, field_name: str, *, max_value: float) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid {field_name}") from exc
    if parsed < 0 or parsed > max_value:
        raise HTTPException(status_code=400, detail=f"invalid {field_name}")
    return round(parsed, 2)


def _clean_int(value: Any, field_name: str, *, max_value: int) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid {field_name}") from exc
    if parsed < 0 or parsed > max_value:
        raise HTTPException(status_code=400, detail=f"invalid {field_name}")
    return parsed


def _clean_notes(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    if not cleaned:
        return None
    return cleaned[:500]


def _clean_payload(body: DailyLifestyleLogPayload) -> dict[str, Any]:
    incoming = body.model_dump(exclude_unset=True)
    cleaned: dict[str, Any] = {}
    enum_fields = {
        "alcohol_level": (ALCOHOL_LEVELS, "alcohol_level"),
        "alcohol_timing": (TIMINGS, "alcohol_timing"),
        "cannabis_level": (CANNABIS_LEVELS, "cannabis_level"),
        "cannabis_timing": (TIMINGS, "cannabis_timing"),
        "bowel_consistency": (BOWEL_CONSISTENCY, "bowel_consistency"),
        "stress_level": (STRESS_LEVELS, "stress_level"),
        "illness_state": (ILLNESS_STATES, "illness_state"),
        "caffeine_timing": (TIMINGS, "caffeine_timing"),
        "appetite": (APPETITE_LEVELS, "appetite"),
        "source": (SOURCES, "source"),
    }
    for key, (allowed, field_name) in enum_fields.items():
        if key in incoming:
            value = _clean_enum(incoming[key], allowed, field_name)
            cleaned[key] = (value or "manual") if key == "source" else value
    if "alcohol_drinks" in incoming:
        cleaned["alcohol_drinks"] = _clean_float(incoming["alcohol_drinks"], "alcohol_drinks", max_value=30)
    if "caffeine_mg" in incoming:
        cleaned["caffeine_mg"] = _clean_float(incoming["caffeine_mg"], "caffeine_mg", max_value=1200)
    if "bowel_movement_count" in incoming:
        cleaned["bowel_movement_count"] = _clean_int(incoming["bowel_movement_count"], "bowel_movement_count", max_value=10)
    if "late_caffeine" in incoming:
        cleaned["late_caffeine"] = None if incoming["late_caffeine"] is None else bool(incoming["late_caffeine"])
    elif cleaned.get("caffeine_timing") in {"evening", "late"}:
        cleaned["late_caffeine"] = True
    if "notes" in incoming:
        cleaned["notes"] = _clean_notes(incoming["notes"])
    return cleaned


def _empty_log(user_id: int, local_date: date) -> dict:
    return {
        "id": None,
        "userId": user_id,
        "localDate": local_date.isoformat(),
        "hasLog": False,
        "alcoholLevel": None,
        "alcoholDrinks": None,
        "alcoholTiming": None,
        "cannabisLevel": None,
        "cannabisTiming": None,
        "bowelMovementCount": None,
        "bowelConsistency": None,
        "stressLevel": None,
        "illnessState": None,
        "caffeineMg": None,
        "caffeineTiming": None,
        "lateCaffeine": None,
        "appetite": None,
        "notes": None,
        "source": None,
        "createdAt": None,
        "updatedAt": None,
    }


def _row_to_dict(row: DailyLifestyleLog) -> dict:
    return {
        "id": row.id,
        "userId": row.user_id,
        "localDate": row.local_date.isoformat(),
        "hasLog": True,
        "alcoholLevel": row.alcohol_level,
        "alcoholDrinks": row.alcohol_drinks,
        "alcoholTiming": row.alcohol_timing,
        "cannabisLevel": row.cannabis_level,
        "cannabisTiming": row.cannabis_timing,
        "bowelMovementCount": row.bowel_movement_count,
        "bowelConsistency": row.bowel_consistency,
        "stressLevel": row.stress_level,
        "illnessState": row.illness_state,
        "caffeineMg": row.caffeine_mg,
        "caffeineTiming": row.caffeine_timing,
        "lateCaffeine": row.late_caffeine,
        "appetite": row.appetite,
        "notes": row.notes,
        "source": row.source,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


@router.get("/daily")
def list_daily_lifestyle_logs(
    startDate: date = Query(...),
    endDate: date = Query(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if endDate < startDate:
        raise HTTPException(status_code=400, detail="endDate must be on or after startDate")
    if (endDate - startDate).days > 90:
        raise HTTPException(status_code=400, detail="date range is too large")
    rows = session.exec(
        select(DailyLifestyleLog)
        .where(DailyLifestyleLog.user_id == current_user.id)
        .where(DailyLifestyleLog.local_date >= startDate)
        .where(DailyLifestyleLog.local_date <= endDate)
        .order_by(DailyLifestyleLog.local_date.asc())
    ).all()
    return {
        "userId": current_user.id,
        "startDate": startDate.isoformat(),
        "endDate": endDate.isoformat(),
        "logs": [_row_to_dict(row) for row in rows],
    }


@router.get("/daily/{local_date}")
def get_daily_lifestyle_log(
    local_date: date,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(DailyLifestyleLog)
        .where(DailyLifestyleLog.user_id == current_user.id)
        .where(DailyLifestyleLog.local_date == local_date)
    ).first()
    return _row_to_dict(row) if row else _empty_log(current_user.id, local_date)


@router.put("/daily/{local_date}")
def upsert_daily_lifestyle_log(
    local_date: date,
    body: DailyLifestyleLogPayload,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(DailyLifestyleLog)
        .where(DailyLifestyleLog.user_id == current_user.id)
        .where(DailyLifestyleLog.local_date == local_date)
    ).first()
    now = _now()
    if row is None:
        row = DailyLifestyleLog(user_id=current_user.id, local_date=local_date, created_at=now)
    for key, value in _clean_payload(body).items():
        setattr(row, key, value)
    row.updated_at = now
    session.add(row)
    session.commit()
    session.refresh(row)
    invalidate_readiness_cache(current_user.id)
    return _row_to_dict(row)
