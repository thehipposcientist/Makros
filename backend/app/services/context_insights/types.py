from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Literal


Confidence = Literal["low", "medium", "high"]
InsightCategory = Literal["move", "recover", "environment", "connect", "improve"]
SocialContext = Literal["alone", "with_friend", "group", "unknown"]


@dataclass(frozen=True)
class Insight:
    id: str
    user_id: int
    type: str
    category: InsightCategory
    title: str
    summary: str
    recommended_action: str
    confidence: Confidence
    data_sources: list[str]
    explanation: str
    safety_note: str | None = None
    created_at: datetime | None = None
    valid_until: datetime | None = None
    dismissed_at: datetime | None = None
    why: str | None = None
    priority: int = 50
    payload: dict = field(default_factory=dict)

    def to_api(self) -> dict:
        return {
            "id": self.id,
            "userId": self.user_id,
            "type": self.type,
            "category": self.category,
            "title": self.title,
            "summary": self.summary,
            "recommendedAction": self.recommended_action,
            "confidence": self.confidence,
            "dataSources": self.data_sources,
            "explanation": self.explanation,
            "safetyNote": self.safety_note,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "validUntil": self.valid_until.isoformat() if self.valid_until else None,
            "dismissedAt": self.dismissed_at.isoformat() if self.dismissed_at else None,
            "why": self.why or self.explanation,
            "priority": self.priority,
            "payload": self.payload,
        }


@dataclass(frozen=True)
class ContextSegment:
    id: str
    user_id: int
    start_time: datetime
    end_time: datetime
    coarse_location_hash: str | None = None
    place_category: str | None = None
    activity_type: str | None = None
    workout_id: int | None = None
    daylight: bool | None = None
    uv_index: float | None = None
    air_quality_index: int | None = None
    temperature: float | None = None
    humidity: float | None = None
    elevation_gain_meters: float | None = None
    steps: int | None = None
    heart_rate_avg: float | None = None
    social_context: SocialContext | None = None
    confidence: Confidence = "low"
    source: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DailyFeatureSet:
    user_id: int
    date: date
    steps: int = 0
    active_minutes: int = 0
    strength_workout_count: int = 0
    weight_bearing_minutes: int = 0
    mobility_minutes: int = 0
    elevation_gain_meters: float = 0.0
    outdoor_daylight_minutes: int = 0
    open_sky_equivalent_minutes: int = 0
    high_uv_minutes: int = 0
    sleep_duration_minutes: int | None = None
    sleep_consistency_score: float | None = None
    resting_heart_rate: float | None = None
    hrv: float | None = None
    workout_load: float | None = None
    recovery_score: float | None = None
    social_activity_count: int | None = None
    active_commute_minutes: int | None = None
    sedentary_block_minutes: int | None = None


@dataclass(frozen=True)
class UserInsightPreferences:
    enable_move_insights: bool = False
    enable_recovery_insights: bool = False
    enable_environment_insights: bool = False
    enable_social_insights: bool = False
    enable_pattern_insights: bool = False
    use_coarse_location: bool = False
    use_workout_routes: bool = False
    use_weather_environment_data: bool = False
    use_social_context: bool = False
    allow_notifications: bool = False
    allow_occasional_correction_prompts: bool = False


@dataclass(frozen=True)
class OutdoorWindow:
    start_time: datetime
    end_time: datetime
    uv_index: float | None = None
    air_quality_index: int | None = None
    temperature_f: float | None = None
    humidity: float | None = None
    precipitation_probability: float | None = None
    storm_risk: bool = False
    recovery_score: float | None = None


@dataclass(frozen=True)
class NextBestAction:
    primary_action: str
    reason: str
    expected_benefit: str
    insight_id: str | None = None
    secondary_action: str | None = None

    def to_api(self) -> dict:
        return {
            "primaryAction": self.primary_action,
            "reason": self.reason,
            "expectedBenefit": self.expected_benefit,
            "insightId": self.insight_id,
            "secondaryAction": self.secondary_action,
        }

