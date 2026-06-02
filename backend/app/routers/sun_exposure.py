from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import SunExposureCorrection, SunExposureSegment, User, UserPreferences, WorkoutCompletion
from app.services.sun_exposure.area_coefficients import AreaSunCoefficientService
from app.services.sun_exposure.calculation import (
    build_daily_summary,
    calculate_segment_values,
    segment_confidence_label,
)
from app.services.sun_exposure.corrections import (
    adjusted_context_for_correction,
    future_adjusted_context,
    normalize_correction,
)
from app.services.sun_exposure.geo import coarse_hash_from_route
from app.services.sun_exposure.outdoor_confidence import estimate_outdoor_confidence
from app.services.sun_exposure.types import AreaSunContext, SUN_EXPOSURE_SOURCES


router = APIRouter(prefix="/sun-exposure", tags=["sun-exposure"])


DEFAULT_PREFERENCES = {
    "enabled": False,
    "useWorkoutRoutes": True,
    "useCoarseLocation": False,
    "useHealthDaylightData": True,
    "useAreaCoefficients": True,
    "allowCorrectionPrompts": True,
    "highUvRemindersEnabled": True,
    "locationMode": "workout_routes_only",
}

LOCATION_MODES = {
    "off",
    "workout_routes_only",
    "coarse_location",
    "precise_during_active_workout",
}


class SunExposurePreferencesPayload(BaseModel):
    enabled: bool | None = None
    useWorkoutRoutes: bool | None = None
    useCoarseLocation: bool | None = None
    useHealthDaylightData: bool | None = None
    useAreaCoefficients: bool | None = None
    allowCorrectionPrompts: bool | None = None
    highUvRemindersEnabled: bool | None = None
    locationMode: str | None = None


class SunExposureSegmentCreate(BaseModel):
    startTime: datetime
    endTime: datetime
    durationMinutes: float | None = None
    coarseLocationHash: str | None = None
    activityId: int | None = None
    routeCoords: list[dict] | None = None
    uvIndexAverage: float = Field(default=0.0, ge=0)
    uvIndexMax: float | None = Field(default=None, ge=0)
    lightIntensityLux: float | None = Field(default=None, ge=0)
    localStartMinute: int | None = Field(default=None, ge=0, lt=1440)
    localEndMinute: int | None = Field(default=None, ge=0, lt=1440)
    timezoneOffsetMinutes: int | None = Field(default=None, ge=-840, le=840)
    daylight: bool = True
    outdoorConfidence: float | None = Field(default=None, ge=0, le=1)
    areaContext: dict | None = None
    areaHints: dict | None = None
    activityCategory: str | None = None
    activitySubtype: str | None = None
    activitySource: str | None = None
    source: str = "coarse_location"
    userCorrection: str | None = None


class SunExposureCorrectionCreate(BaseModel):
    segmentId: int | None = None
    correctionType: str
    contextKey: str | None = None
    notes: str | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _clean_source(value: str | None) -> str:
    source = str(value or "coarse_location").strip().lower()
    return source if source in SUN_EXPOSURE_SOURCES else "coarse_location"


def _preferences_row(session: Session, user_id: int) -> UserPreferences:
    prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == user_id)).first()
    if prefs:
        return prefs
    prefs = UserPreferences(user_id=user_id, equipment=[], foods_available=[])
    session.add(prefs)
    session.flush()
    return prefs


def _normalize_preferences(value: dict | None) -> dict:
    incoming = value if isinstance(value, dict) else {}
    out = {**DEFAULT_PREFERENCES}
    for key in DEFAULT_PREFERENCES:
        if key in incoming:
            out[key] = incoming[key]
    if out["locationMode"] not in LOCATION_MODES:
        out["locationMode"] = "workout_routes_only"
    if out["locationMode"] == "off":
        out["useWorkoutRoutes"] = False
        out["useCoarseLocation"] = False
    return out


def _segment_context_key(coarse_hash: str | None, area_type: str | None) -> str | None:
    if not coarse_hash and not area_type:
        return None
    return f"{coarse_hash or 'unknown'}:{area_type or 'unknown'}"


def _segment_to_dict(row: SunExposureSegment) -> dict:
    return {
        "id": row.id,
        "userId": row.user_id,
        "startTime": row.start_time.isoformat(),
        "endTime": row.end_time.isoformat(),
        "durationMinutes": round(row.duration_minutes, 2),
        "coarseLocationHash": row.coarse_location_hash,
        "activityId": row.activity_id,
        "uvIndexAverage": row.uv_index_average,
        "uvIndexMax": row.uv_index_max,
        "lightIntensityLux": row.light_intensity_lux,
        "localStartMinute": row.local_start_minute,
        "localEndMinute": row.local_end_minute,
        "timezoneOffsetMinutes": row.timezone_offset_minutes,
        "daylight": row.daylight,
        "outdoorConfidence": row.outdoor_confidence,
        "areaContext": row.area_context,
        "effectiveUvMinutes": round(row.effective_uv_minutes, 2),
        "openSkyEquivalentMinutes": round(row.open_sky_equivalent_minutes, 2),
        "confidence": row.confidence,
        "source": row.source,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


def _correction_to_dict(row: SunExposureCorrection) -> dict:
    return {
        "id": row.id,
        "userId": row.user_id,
        "segmentId": row.segment_id,
        "correctionType": row.correction_type,
        "contextKey": row.context_key,
        "areaType": row.area_type,
        "adjustedSkyExposureCoefficient": row.adjusted_sky_exposure_coefficient,
        "adjustedOutdoorConfidence": row.adjusted_outdoor_confidence,
        "notes": row.notes,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
    }


def _duration_minutes(body: SunExposureSegmentCreate) -> float:
    if body.durationMinutes is not None:
        return max(0.0, float(body.durationMinutes))
    return max(0.0, (body.endTime - body.startTime).total_seconds() / 60)


def _ensure_activity_owner(session: Session, user_id: int, activity_id: int | None) -> WorkoutCompletion | None:
    if activity_id is None:
        return None
    activity = session.get(WorkoutCompletion, activity_id)
    if not activity or activity.user_id != user_id:
        raise HTTPException(status_code=404, detail="activity not found")
    return activity


def _recent_context_corrections(
    session: Session,
    user_id: int,
    context_key: str | None,
) -> list[SunExposureCorrection]:
    if not context_key:
        return []
    return session.exec(
        select(SunExposureCorrection)
        .where(SunExposureCorrection.user_id == user_id)
        .where(SunExposureCorrection.context_key == context_key)
        .order_by(SunExposureCorrection.created_at.desc())
        .limit(10)
    ).all()


@router.get("/preferences")
def get_preferences(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    prefs = _preferences_row(session, current_user.id)
    session.commit()
    return _normalize_preferences(prefs.sun_exposure_preferences)


@router.put("/preferences")
def update_preferences(
    body: SunExposurePreferencesPayload,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    prefs = _preferences_row(session, current_user.id)
    current = _normalize_preferences(prefs.sun_exposure_preferences)
    incoming = body.model_dump(exclude_none=True)
    current.update(incoming)
    prefs.sun_exposure_preferences = _normalize_preferences(current)
    prefs.updated_at = _now()
    session.add(prefs)
    session.commit()
    return prefs.sun_exposure_preferences


@router.post("/segments", status_code=201)
def create_segment(
    body: SunExposureSegmentCreate,
    current_user: User = Depends(require_pro_feature("Sun exposure insights")),
    session: Session = Depends(get_session),
):
    prefs = _normalize_preferences(_preferences_row(session, current_user.id).sun_exposure_preferences)
    if not prefs["enabled"]:
        raise HTTPException(status_code=403, detail="sun exposure estimates are disabled")

    activity = _ensure_activity_owner(session, current_user.id, body.activityId)
    source = _clean_source(body.source)
    route_coords = body.routeCoords
    if route_coords is None and activity and activity.route_coords:
        route_coords = activity.route_coords
    if source == "workout_route" and not prefs["useWorkoutRoutes"]:
        raise HTTPException(status_code=403, detail="workout route estimates are disabled")
    if source == "healthkit_daylight" and not prefs["useHealthDaylightData"]:
        raise HTTPException(status_code=403, detail="HealthKit daylight estimates are disabled")

    coarse_hash = body.coarseLocationHash
    if not coarse_hash and prefs["useWorkoutRoutes"] and route_coords:
        coarse_hash = coarse_hash_from_route(route_coords)
    if not coarse_hash and not prefs["useCoarseLocation"]:
        coarse_hash = None

    area_context = (
        AreaSunContext.from_dict(body.areaContext)
        if body.areaContext
        else AreaSunCoefficientService().classify(body.areaHints or {})
    )
    context_key = _segment_context_key(coarse_hash, area_context.area_type)
    corrections = _recent_context_corrections(session, current_user.id, context_key)
    if corrections:
        area_context = future_adjusted_context(
            area_context,
            [_correction_to_dict(row) for row in corrections],
        )

    duration_minutes = _duration_minutes(body)
    signals = {
        "activityCategory": body.activityCategory or (activity.activity_category if activity else None),
        "activitySubtype": body.activitySubtype or (activity.activity_subtype if activity else None),
        "activitySource": body.activitySource or (activity.activity_source if activity else None),
        "hasWorkoutRoute": bool(route_coords),
        "healthkitDaylightMinutes": duration_minutes if source == "healthkit_daylight" else None,
        "userCorrection": body.userCorrection,
        **(body.areaHints or {}),
    }
    outdoor_confidence = (
        float(body.outdoorConfidence)
        if body.outdoorConfidence is not None
        else estimate_outdoor_confidence(source=source, area_context=area_context, signals=signals).outdoor_confidence
    )
    if body.userCorrection:
        area_context = adjusted_context_for_correction(area_context, body.userCorrection)
        if normalize_correction(body.userCorrection) in {"indoors", "wrong_activity"}:
            outdoor_confidence = 0.0
        elif normalize_correction(body.userCorrection) in {"mostly_sunny", "mixed", "mostly_shaded"}:
            outdoor_confidence = max(outdoor_confidence, 0.90)

    uv_max = body.uvIndexMax if body.uvIndexMax is not None else body.uvIndexAverage
    values = calculate_segment_values(
        duration_minutes=duration_minutes,
        uv_index_average=body.uvIndexAverage,
        outdoor_confidence=outdoor_confidence,
        area_context=area_context,
    )
    confidence = segment_confidence_label(
        outdoor_confidence=outdoor_confidence,
        area_context=area_context,
        source=source,
    )
    row = None
    if source == "healthkit_daylight":
        row = session.exec(
            select(SunExposureSegment)
            .where(SunExposureSegment.user_id == current_user.id)
            .where(SunExposureSegment.source == "healthkit_daylight")
            .where(SunExposureSegment.start_time == body.startTime)
            .where(SunExposureSegment.end_time == body.endTime)
        ).first()
    if row is None:
        row = SunExposureSegment(user_id=current_user.id)
    row.start_time = body.startTime
    row.end_time = body.endTime
    row.duration_minutes = duration_minutes
    row.coarse_location_hash = coarse_hash
    row.activity_id = body.activityId
    row.uv_index_average = float(body.uvIndexAverage)
    row.uv_index_max = float(uv_max)
    row.light_intensity_lux = float(body.lightIntensityLux) if body.lightIntensityLux is not None else None
    row.local_start_minute = body.localStartMinute
    row.local_end_minute = body.localEndMinute
    row.timezone_offset_minutes = body.timezoneOffsetMinutes
    row.daylight = body.daylight
    row.outdoor_confidence = max(0.0, min(1.0, outdoor_confidence))
    row.area_context = area_context.to_dict()
    row.effective_uv_minutes = values["effective_uv_minutes"]
    row.open_sky_equivalent_minutes = values["open_sky_equivalent_minutes"]
    row.confidence = confidence
    row.source = source
    row.updated_at = _now()
    session.add(row)
    session.commit()
    session.refresh(row)
    return _segment_to_dict(row)


@router.get("/segments")
def list_segments(
    day: date | None = Query(default=None),
    current_user: User = Depends(require_pro_feature("Sun exposure insights")),
    session: Session = Depends(get_session),
):
    day = day or date.today()
    start = datetime.combine(day, time.min, tzinfo=timezone.utc)
    end = datetime.combine(day, time.max, tzinfo=timezone.utc)
    rows = session.exec(
        select(SunExposureSegment)
        .where(SunExposureSegment.user_id == current_user.id)
        .where(SunExposureSegment.start_time >= start)
        .where(SunExposureSegment.start_time <= end)
        .order_by(SunExposureSegment.start_time.asc())
    ).all()
    return [_segment_to_dict(row) for row in rows]


@router.get("/summary")
def get_summary(
    day: date | None = Query(default=None),
    current_user: User = Depends(require_pro_feature("Sun exposure insights")),
    session: Session = Depends(get_session),
):
    day = day or date.today()
    segments = list_segments(day=day, current_user=current_user, session=session)
    summary = build_daily_summary(
        user_id=current_user.id,
        summary_date=day,
        segments=segments,
    )
    return summary.to_dict()


@router.get("/history")
def get_history(
    days: int = Query(default=30, ge=1, le=365),
    current_user: User = Depends(require_pro_feature("Sun exposure insights")),
    session: Session = Depends(get_session),
):
    today = _now().date()
    start_day = today - timedelta(days=days - 1)
    start = datetime.combine(start_day, time.min, tzinfo=timezone.utc)
    end = datetime.combine(today, time.max, tzinfo=timezone.utc)
    rows = session.exec(
        select(SunExposureSegment)
        .where(SunExposureSegment.user_id == current_user.id)
        .where(SunExposureSegment.start_time >= start)
        .where(SunExposureSegment.start_time <= end)
        .order_by(SunExposureSegment.start_time.asc())
    ).all()
    by_day: dict[date, list[dict]] = {}
    for row in rows:
        dt = row.start_time
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc)
        day_key = dt.date()
        by_day.setdefault(day_key, []).append(_segment_to_dict(row))

    summaries = []
    for offset in range(days):
        day = start_day + timedelta(days=offset)
        summaries.append(
            build_daily_summary(
                user_id=current_user.id,
                summary_date=day,
                segments=by_day.get(day, []),
            ).to_dict()
        )
    return summaries


@router.post("/corrections", status_code=201)
def create_correction(
    body: SunExposureCorrectionCreate,
    current_user: User = Depends(require_pro_feature("Sun exposure insights")),
    session: Session = Depends(get_session),
):
    correction_type = normalize_correction(body.correctionType)
    segment = None
    if body.segmentId is not None:
        segment = session.get(SunExposureSegment, body.segmentId)
        if not segment or segment.user_id != current_user.id:
            raise HTTPException(status_code=404, detail="segment not found")

    context_key = body.contextKey
    area_type = None
    adjusted_context = None
    adjusted_outdoor_confidence = None
    if segment is not None:
        context = AreaSunContext.from_dict(segment.area_context)
        context_key = context_key or _segment_context_key(segment.coarse_location_hash, context.area_type)
        adjusted_context = adjusted_context_for_correction(context, correction_type)
        area_type = adjusted_context.area_type
        adjusted_outdoor_confidence = segment.outdoor_confidence
        if correction_type in {"indoors", "wrong_activity"}:
            adjusted_outdoor_confidence = 0.0
        elif correction_type in {"mostly_sunny", "mixed", "mostly_shaded"}:
            adjusted_outdoor_confidence = max(segment.outdoor_confidence, 0.90)
        values = calculate_segment_values(
            duration_minutes=segment.duration_minutes,
            uv_index_average=segment.uv_index_average,
            outdoor_confidence=adjusted_outdoor_confidence,
            area_context=adjusted_context,
        )
        segment.area_context = adjusted_context.to_dict()
        segment.outdoor_confidence = adjusted_outdoor_confidence
        segment.effective_uv_minutes = values["effective_uv_minutes"]
        segment.open_sky_equivalent_minutes = values["open_sky_equivalent_minutes"]
        segment.confidence = segment_confidence_label(
            outdoor_confidence=adjusted_outdoor_confidence,
            area_context=adjusted_context,
            source=segment.source,
        )
        segment.updated_at = _now()
        session.add(segment)

    row = SunExposureCorrection(
        user_id=current_user.id,
        segment_id=body.segmentId,
        correction_type=correction_type,
        context_key=context_key,
        area_type=area_type,
        adjusted_sky_exposure_coefficient=adjusted_context.sky_exposure_coefficient if adjusted_context else None,
        adjusted_outdoor_confidence=adjusted_outdoor_confidence,
        notes=body.notes,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return {
        "correction": _correction_to_dict(row),
        "segment": _segment_to_dict(segment) if segment else None,
    }


@router.delete("/derived-data", status_code=204)
def delete_derived_data(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    session.exec(delete(SunExposureCorrection).where(SunExposureCorrection.user_id == current_user.id))
    session.exec(delete(SunExposureSegment).where(SunExposureSegment.user_id == current_user.id))
    session.commit()
