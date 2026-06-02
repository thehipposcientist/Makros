from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import (
    ContextInsight,
    ContextSegment,
    DailyFeatureSet as DailyFeatureSetRow,
    DailyHealthSnapshot,
    DailyLifestyleLog,
    SleepLog,
    SunExposureSegment,
    User,
    UserInsightPreferences,
    UserSocialProfile,
    WorkoutCompletion,
)
from app.services.context_insights.services import (
    NextBestActionService,
    generate_context_insights,
    rollup_daily_features,
)
from app.services.context_insights.types import (
    Insight,
    UserInsightPreferences as ServiceInsightPreferences,
)


router = APIRouter(prefix="/context-insights", tags=["context-insights"])


class InsightPreferencesPayload(BaseModel):
    enableMoveInsights: bool | None = None
    enableRecoveryInsights: bool | None = None
    enableEnvironmentInsights: bool | None = None
    enableSocialInsights: bool | None = None
    enablePatternInsights: bool | None = None
    useCoarseLocation: bool | None = None
    useWorkoutRoutes: bool | None = None
    useWeatherEnvironmentData: bool | None = None
    useSocialContext: bool | None = None
    allowNotifications: bool | None = None
    allowOccasionalCorrectionPrompts: bool | None = None


PREFERENCE_FIELDS = {
    "enableMoveInsights": "enable_move_insights",
    "enableRecoveryInsights": "enable_recovery_insights",
    "enableEnvironmentInsights": "enable_environment_insights",
    "enableSocialInsights": "enable_social_insights",
    "enablePatternInsights": "enable_pattern_insights",
    "useCoarseLocation": "use_coarse_location",
    "useWorkoutRoutes": "use_workout_routes",
    "useWeatherEnvironmentData": "use_weather_environment_data",
    "useSocialContext": "use_social_context",
    "allowNotifications": "allow_notifications",
    "allowOccasionalCorrectionPrompts": "allow_occasional_correction_prompts",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _preferences_row(session: Session, user_id: int) -> UserInsightPreferences:
    row = session.exec(select(UserInsightPreferences).where(UserInsightPreferences.user_id == user_id)).first()
    if row:
        return row
    row = UserInsightPreferences(user_id=user_id)
    session.add(row)
    session.flush()
    return row


def _preferences_to_api(row: UserInsightPreferences) -> dict:
    return {
        "enableMoveInsights": row.enable_move_insights,
        "enableRecoveryInsights": row.enable_recovery_insights,
        "enableEnvironmentInsights": row.enable_environment_insights,
        "enableSocialInsights": row.enable_social_insights,
        "enablePatternInsights": row.enable_pattern_insights,
        "useCoarseLocation": row.use_coarse_location,
        "useWorkoutRoutes": row.use_workout_routes,
        "useWeatherEnvironmentData": row.use_weather_environment_data,
        "useSocialContext": row.use_social_context,
        "allowNotifications": row.allow_notifications,
        "allowOccasionalCorrectionPrompts": row.allow_occasional_correction_prompts,
    }


def _preferences_to_service(row: UserInsightPreferences) -> ServiceInsightPreferences:
    return ServiceInsightPreferences(
        enable_move_insights=row.enable_move_insights,
        enable_recovery_insights=row.enable_recovery_insights,
        enable_environment_insights=row.enable_environment_insights,
        enable_social_insights=row.enable_social_insights,
        enable_pattern_insights=row.enable_pattern_insights,
        use_coarse_location=row.use_coarse_location,
        use_workout_routes=row.use_workout_routes,
        use_weather_environment_data=row.use_weather_environment_data,
        use_social_context=row.use_social_context,
        allow_notifications=row.allow_notifications,
        allow_occasional_correction_prompts=row.allow_occasional_correction_prompts,
    )


@router.get("/preferences")
def get_preferences(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = _preferences_row(session, current_user.id)
    session.commit()
    return _preferences_to_api(row)


@router.put("/preferences")
def update_preferences(
    body: InsightPreferencesPayload,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = _preferences_row(session, current_user.id)
    incoming = body.model_dump(exclude_none=True)
    for api_key, db_key in PREFERENCE_FIELDS.items():
        if api_key in incoming:
            setattr(row, db_key, bool(incoming[api_key]))
    if not row.use_coarse_location and not row.use_workout_routes:
        row.use_weather_environment_data = False
    if not row.enable_social_insights:
        row.use_social_context = False
    row.updated_at = _now()
    session.add(row)
    session.commit()
    session.refresh(row)
    return _preferences_to_api(row)


@router.get("")
def list_context_insights(
    days: int = Query(default=14, ge=1, le=60),
    include_dismissed: bool = Query(default=False),
    current_user: User = Depends(require_pro_feature("Context insights")),
    session: Session = Depends(get_session),
):
    prefs_row = _preferences_row(session, current_user.id)
    today = date.today()
    start = today if days == 1 else today - timedelta(days=days - 1)
    features = _collect_feature_sets(session, current_user.id, start, today)
    _upsert_feature_sets(session, current_user.id, features)
    insights = generate_context_insights(
        current_user.id,
        preferences=_preferences_to_service(prefs_row),
        features=features,
        sun_segments=_sun_segment_dicts(session, current_user.id, start, today),
        lifestyle_logs=_lifestyle_logs(session, current_user.id, start, today),
        social_summary=_social_summary(session, current_user.id, prefs_row),
        created_at=_now(),
    )
    rows = _upsert_insights(session, current_user.id, insights)
    session.commit()
    payload = [_context_insight_to_api(row) for row in rows if include_dismissed or row.dismissed_at is None]
    return {
        "userId": current_user.id,
        "generatedAt": _now().isoformat(),
        "preferences": _preferences_to_api(prefs_row),
        "insights": payload,
        "nextBestAction": NextBestActionService.pick(
            [_row_to_service(row) for row in rows if row.dismissed_at is None]
        ).to_api(),
    }


@router.get("/next-action")
def get_next_action(
    days: int = Query(default=14, ge=1, le=60),
    current_user: User = Depends(require_pro_feature("Context insights")),
    session: Session = Depends(get_session),
):
    response = list_context_insights(days=days, include_dismissed=False, current_user=current_user, session=session)
    return response["nextBestAction"]


@router.post("/{insight_id}/dismiss")
def dismiss_context_insight(
    insight_id: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(ContextInsight)
        .where(ContextInsight.user_id == current_user.id)
        .where(ContextInsight.insight_key == insight_id)
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="insight not found")
    row.dismissed_at = _now()
    session.add(row)
    session.commit()
    return _context_insight_to_api(row)


@router.delete("/derived-data", status_code=204)
def delete_derived_insight_data(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    session.exec(delete(ContextInsight).where(ContextInsight.user_id == current_user.id))
    session.exec(delete(ContextSegment).where(ContextSegment.user_id == current_user.id))
    session.exec(delete(DailyFeatureSetRow).where(DailyFeatureSetRow.user_id == current_user.id))
    session.commit()


def _collect_feature_sets(session: Session, user_id: int, start: date, end: date):
    health_rows = session.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == user_id)
        .where(DailyHealthSnapshot.snapshot_date >= start)
        .where(DailyHealthSnapshot.snapshot_date <= end)
    ).all()
    sleep_rows = session.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(SleepLog.night_date >= start)
        .where(SleepLog.night_date <= end)
    ).all()
    workout_rows = session.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= start)
        .where(WorkoutCompletion.workout_date <= end)
    ).all()
    start_dt = datetime.combine(start, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(end, time.max, tzinfo=timezone.utc)
    sun_rows = session.exec(
        select(SunExposureSegment)
        .where(SunExposureSegment.user_id == user_id)
        .where(SunExposureSegment.start_time >= start_dt)
        .where(SunExposureSegment.start_time <= end_dt)
    ).all()
    return rollup_daily_features(
        user_id=user_id,
        start_date=start,
        end_date=end,
        health_rows=health_rows,
        sleep_rows=sleep_rows,
        workout_rows=workout_rows,
        sun_rows=sun_rows,
    )


def _upsert_feature_sets(session: Session, user_id: int, features) -> None:
    existing = {
        row.date: row
        for row in session.exec(select(DailyFeatureSetRow).where(DailyFeatureSetRow.user_id == user_id)).all()
    }
    now = _now()
    for feature in features:
        row = existing.get(feature.date)
        if row is None:
            row = DailyFeatureSetRow(user_id=user_id, date=feature.date)
        for key, value in feature.__dict__.items():
            if key in {"user_id", "date"}:
                continue
            setattr(row, key, value)
        row.source = ["health", "sleep", "workouts", "sun_exposure"]
        row.updated_at = now
        session.add(row)


def _sun_segment_dicts(session: Session, user_id: int, start: date, end: date) -> list[dict]:
    start_dt = datetime.combine(start, time.min, tzinfo=timezone.utc)
    end_dt = datetime.combine(end, time.max, tzinfo=timezone.utc)
    rows = session.exec(
        select(SunExposureSegment)
        .where(SunExposureSegment.user_id == user_id)
        .where(SunExposureSegment.start_time >= start_dt)
        .where(SunExposureSegment.start_time <= end_dt)
    ).all()
    return [
        {
            "id": row.id,
            "durationMinutes": row.duration_minutes,
            "outdoorConfidence": row.outdoor_confidence,
            "uvIndexAverage": row.uv_index_average,
            "uvIndexMax": row.uv_index_max,
            "openSkyEquivalentMinutes": row.open_sky_equivalent_minutes,
            "areaContext": row.area_context,
            "confidence": row.confidence,
            "source": row.source,
        }
        for row in rows
    ]


def _lifestyle_logs(session: Session, user_id: int, start: date, end: date) -> list[DailyLifestyleLog]:
    return session.exec(
        select(DailyLifestyleLog)
        .where(DailyLifestyleLog.user_id == user_id)
        .where(DailyLifestyleLog.local_date >= start)
        .where(DailyLifestyleLog.local_date <= end)
        .order_by(DailyLifestyleLog.local_date.asc())
    ).all()


def _social_summary(session: Session, user_id: int, prefs: UserInsightPreferences) -> dict | None:
    if not prefs.enable_social_insights or not prefs.use_social_context:
        return None
    profile = session.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == user_id)).first()
    if not profile or not profile.share_activity_enabled:
        return {"mutualOptIn": False}
    return {
        "mutualOptIn": True,
        "groupWorkouts": 0,
        "socialActivityCount": 0,
        "priorSocialActivityCount": None,
    }


def _upsert_insights(session: Session, user_id: int, insights: list[Insight]) -> list[ContextInsight]:
    if not insights:
        return []
    existing = {
        row.insight_key: row
        for row in session.exec(select(ContextInsight).where(ContextInsight.user_id == user_id)).all()
    }
    rows: list[ContextInsight] = []
    for insight in insights:
        row = existing.get(insight.id)
        if row is None:
            row = ContextInsight(user_id=user_id, insight_key=insight.id, type=insight.type, category=insight.category, title=insight.title, summary=insight.summary, recommended_action=insight.recommended_action, explanation=insight.explanation)
        row.type = insight.type
        row.category = insight.category
        row.title = insight.title
        row.summary = insight.summary
        row.recommended_action = insight.recommended_action
        row.confidence = insight.confidence
        row.data_sources = insight.data_sources
        row.explanation = insight.explanation
        row.safety_note = insight.safety_note
        row.payload = {**(insight.payload or {}), "why": insight.why, "priority": insight.priority}
        row.created_at = insight.created_at or _now()
        row.valid_until = insight.valid_until
        session.add(row)
        rows.append(row)
    return rows


def _context_insight_to_api(row: ContextInsight) -> dict:
    return {
        "id": row.insight_key,
        "userId": row.user_id,
        "type": row.type,
        "category": row.category,
        "title": row.title,
        "summary": row.summary,
        "recommendedAction": row.recommended_action,
        "confidence": row.confidence,
        "dataSources": row.data_sources or [],
        "explanation": row.explanation,
        "safetyNote": row.safety_note,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "validUntil": row.valid_until.isoformat() if row.valid_until else None,
        "dismissedAt": row.dismissed_at.isoformat() if row.dismissed_at else None,
        "why": row.payload.get("why") if isinstance(row.payload, dict) else None,
        "payload": row.payload or {},
    }


def _row_to_service(row: ContextInsight) -> Insight:
    return Insight(
        id=row.insight_key,
        user_id=row.user_id,
        type=row.type,
        category=row.category,  # type: ignore[arg-type]
        title=row.title,
        summary=row.summary,
        recommended_action=row.recommended_action,
        confidence=row.confidence,  # type: ignore[arg-type]
        data_sources=list(row.data_sources or []),
        explanation=row.explanation,
        safety_note=row.safety_note,
        created_at=row.created_at,
        valid_until=row.valid_until,
        dismissed_at=row.dismissed_at,
        priority=int((row.payload or {}).get("priority", 50)) if isinstance(row.payload, dict) else 50,
        payload=row.payload or {},
    )
