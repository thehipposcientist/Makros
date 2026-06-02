from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from app.services.sun_exposure.types import AreaSunContext, ConfidenceLabel


CONFIRMED_SOURCES = {"healthkit_daylight", "manual"}


def _clamp(value: float, low: float = 0.0, high: float = 999_999.0) -> float:
    return max(low, min(high, float(value)))


def _label_from_score(score: float) -> ConfidenceLabel:
    if score >= 0.75:
        return "high"
    if score >= 0.45:
        return "medium"
    return "low"


def _area_confidence_score(confidence: str | None) -> float:
    if confidence == "high":
        return 0.85
    if confidence == "medium":
        return 0.60
    return 0.35


def segment_confidence_label(
    *,
    outdoor_confidence: float,
    area_context: AreaSunContext,
    source: str | None,
) -> ConfidenceLabel:
    source_score = 0.85 if source in CONFIRMED_SOURCES or source == "workout_route" else 0.55
    score = (
        _clamp(outdoor_confidence, 0.0, 1.0) * 0.45
        + _area_confidence_score(area_context.confidence) * 0.35
        + source_score * 0.20
    )
    return _label_from_score(score)


def calculate_segment_values(
    *,
    duration_minutes: float,
    uv_index_average: float,
    outdoor_confidence: float,
    area_context: AreaSunContext,
) -> dict[str, float]:
    duration = _clamp(duration_minutes)
    uv_average = _clamp(uv_index_average, 0.0, 20.0)
    outdoor = _clamp(outdoor_confidence, 0.0, 1.0)
    sky = _clamp(area_context.sky_exposure_coefficient, 0.0, 1.25)
    reflection = _clamp(area_context.reflection_coefficient, 0.0, 1.5)
    open_sky_equivalent = duration * outdoor * sky * reflection
    return {
        "effective_uv_minutes": duration * uv_average * outdoor * sky * reflection,
        "open_sky_equivalent_minutes": open_sky_equivalent,
    }


@dataclass(frozen=True)
class SunExposureDailySummary:
    user_id: int
    date: date
    likely_outdoor_daylight_minutes: float
    confirmed_outdoor_daylight_minutes: float
    possible_outdoor_daylight_minutes: float
    mostly_shaded_minutes: float
    mostly_open_sky_minutes: float
    high_uv_minutes: float
    very_high_uv_minutes: float
    effective_uv_minutes: float
    open_sky_equivalent_minutes: float
    daylight_minutes: float
    apple_health_daylight_minutes: float
    light_intensity_lux_average: float | None
    light_intensity_lux_max: float | None
    uv_index_average: float
    uv_index_max: float
    morning_daylight_minutes: float
    midday_daylight_minutes: float
    afternoon_daylight_minutes: float
    uv_risk_score: int
    uv_risk_label: str
    sun_score: int
    sun_score_label: str
    confidence: ConfidenceLabel
    explanation: str
    safety_message: str | None = None

    def to_dict(self) -> dict:
        return {
            "userId": self.user_id,
            "date": self.date.isoformat(),
            "likelyOutdoorDaylightMinutes": round(self.likely_outdoor_daylight_minutes, 1),
            "confirmedOutdoorDaylightMinutes": round(self.confirmed_outdoor_daylight_minutes, 1),
            "possibleOutdoorDaylightMinutes": round(self.possible_outdoor_daylight_minutes, 1),
            "mostlyShadedMinutes": round(self.mostly_shaded_minutes, 1),
            "mostlyOpenSkyMinutes": round(self.mostly_open_sky_minutes, 1),
            "highUvMinutes": round(self.high_uv_minutes, 1),
            "veryHighUvMinutes": round(self.very_high_uv_minutes, 1),
            "effectiveUvMinutes": round(self.effective_uv_minutes, 1),
            "openSkyEquivalentMinutes": round(self.open_sky_equivalent_minutes, 1),
            "daylightMinutes": round(self.daylight_minutes, 1),
            "appleHealthDaylightMinutes": round(self.apple_health_daylight_minutes, 1),
            "lightIntensityLuxAverage": round(self.light_intensity_lux_average, 1) if self.light_intensity_lux_average is not None else None,
            "lightIntensityLuxMax": round(self.light_intensity_lux_max, 1) if self.light_intensity_lux_max is not None else None,
            "uvIndexAverage": round(self.uv_index_average, 1),
            "uvIndexMax": round(self.uv_index_max, 1),
            "morningDaylightMinutes": round(self.morning_daylight_minutes, 1),
            "middayDaylightMinutes": round(self.midday_daylight_minutes, 1),
            "afternoonDaylightMinutes": round(self.afternoon_daylight_minutes, 1),
            "uvRiskScore": int(self.uv_risk_score),
            "uvRiskLabel": self.uv_risk_label,
            "sunScore": int(self.sun_score),
            "sunScoreLabel": self.sun_score_label,
            "confidence": self.confidence,
            "explanation": self.explanation,
            "safetyMessage": self.safety_message,
        }


def _get(segment: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in segment:
            return segment[key]
    return default


def _duration(segment: Mapping[str, Any]) -> float:
    return _clamp(float(_get(segment, "durationMinutes", "duration_minutes", default=0) or 0))


def _outdoor_confidence(segment: Mapping[str, Any]) -> float:
    return _clamp(float(_get(segment, "outdoorConfidence", "outdoor_confidence", default=0) or 0), 0.0, 1.0)


def _uv_average(segment: Mapping[str, Any]) -> float:
    return _clamp(float(_get(segment, "uvIndexAverage", "uv_index_average", default=0) or 0), 0.0, 20.0)


def _uv_max(segment: Mapping[str, Any]) -> float:
    return _clamp(float(_get(segment, "uvIndexMax", "uv_index_max", default=_uv_average(segment)) or 0), 0.0, 20.0)


def _light_intensity_lux(segment: Mapping[str, Any]) -> float | None:
    raw = _get(segment, "lightIntensityLux", "light_intensity_lux", default=None)
    if raw is None:
        return None
    try:
        lux = float(raw)
    except Exception:
        return None
    return _clamp(lux) if lux > 0 else None


def _local_minute(segment: Mapping[str, Any], *keys: str) -> int | None:
    for key in keys:
        raw = _get(segment, key, default=None)
        if raw is None:
            continue
        try:
            minute = int(round(float(raw)))
        except Exception:
            continue
        if 0 <= minute < 1440:
            return minute
    return None


def _timestamp_minute(segment: Mapping[str, Any]) -> int | None:
    raw = _get(segment, "startTime", "start_time", default=None)
    if raw is None:
        return None
    try:
        value = str(raw).replace("Z", "+00:00")
        dt = datetime.fromisoformat(value)
    except Exception:
        return None
    return dt.hour * 60 + dt.minute


def _source(segment: Mapping[str, Any]) -> str:
    return str(_get(segment, "source", default="") or "").strip().lower()


def _confidence_score(segment: Mapping[str, Any]) -> float:
    confidence = str(_get(segment, "confidence", default="low") or "low").lower()
    if confidence == "high":
        return 0.85
    if confidence == "medium":
        return 0.60
    return 0.35


def _area_context(segment: Mapping[str, Any]) -> AreaSunContext:
    return AreaSunContext.from_dict(_get(segment, "areaContext", "area_context", default=None))


def safety_message_for_uv(max_uv_index: float) -> str | None:
    if max_uv_index >= 3:
        return "Sun protection would be recommended if you were outside."
    return None


def _interval_overlap(start: float, end: float, bucket_start: int, bucket_end: int) -> float:
    return max(0.0, min(end, bucket_end) - max(start, bucket_start))


def _bucket_minutes(start_minute: int | None, duration_minutes: float, bucket_start: int, bucket_end: int) -> float:
    if start_minute is None:
        return 0.0
    duration = _clamp(duration_minutes, 0.0, 1440.0)
    if duration <= 0:
        return 0.0
    start = float(start_minute)
    end = start + duration
    if end <= 1440:
        return _interval_overlap(start, end, bucket_start, bucket_end)
    return (
        _interval_overlap(start, 1440.0, bucket_start, bucket_end)
        + _interval_overlap(0.0, end - 1440.0, bucket_start, bucket_end)
    )


def uv_risk_score(
    *,
    effective_uv_minutes: float,
    uv_index_max: float,
    high_uv_minutes: float,
    very_high_uv_minutes: float,
) -> tuple[int, str]:
    effective_uv = _clamp(effective_uv_minutes)
    max_uv = _clamp(uv_index_max, 0.0, 20.0)
    high_uv = _clamp(high_uv_minutes)
    very_high_uv = _clamp(very_high_uv_minutes)
    if effective_uv <= 0 and max_uv < 3 and high_uv <= 0:
        return 0, "Low"

    uv_dose_points = min(70.0, (effective_uv / 180.0) * 70.0)
    peak_points = min(20.0, max(0.0, max_uv - 3.0) / 8.0 * 20.0)
    duration_points = min(10.0, high_uv / 60.0 * 6.0 + very_high_uv / 30.0 * 4.0)
    score = int(round(_clamp(uv_dose_points + peak_points + duration_points, 0.0, 100.0)))

    if score >= 75:
        label = "Very high"
    elif score >= 50:
        label = "High"
    elif score >= 25:
        label = "Moderate"
    else:
        label = "Low"
    return score, label


def sun_balance_score(
    *,
    daylight_minutes: float,
    light_intensity_lux_average: float | None,
    uv_index_average: float,
    uv_index_max: float,
    high_uv_minutes: float,
    very_high_uv_minutes: float,
    morning_daylight_minutes: float,
    midday_daylight_minutes: float,
    afternoon_daylight_minutes: float,
) -> tuple[int, str]:
    daylight = _clamp(daylight_minutes)
    lux = _clamp(light_intensity_lux_average or 0.0)
    avg_uv = _clamp(uv_index_average, 0.0, 20.0)
    max_uv = _clamp(uv_index_max, 0.0, 20.0)
    high_uv = _clamp(high_uv_minutes)
    very_high_uv = _clamp(very_high_uv_minutes)
    morning = _clamp(morning_daylight_minutes)
    midday = _clamp(midday_daylight_minutes)
    afternoon = _clamp(afternoon_daylight_minutes)
    if daylight <= 0:
        return 0, "No daylight"

    daylight_points = min(50.0, daylight / 30.0 * 50.0)
    timing_points = min(30.0, morning / 20.0 * 30.0 + midday / 30.0 * 22.0 + afternoon / 30.0 * 16.0)
    if timing_points <= 0:
        timing_points = min(22.0, daylight / 30.0 * 22.0)
    lux_points = min(15.0, max(0.0, lux - 1_000.0) / 9_000.0 * 15.0) if lux > 0 else 0.0
    uv_context_points = min(10.0, avg_uv / 3.0 * 10.0)
    uv_penalty = min(50.0, max(0.0, high_uv - 30.0) * 0.45 + very_high_uv * 0.70 + max(0.0, max_uv - 8.0) * 4.0)
    score = int(round(_clamp(daylight_points + timing_points + lux_points + uv_context_points - uv_penalty, 0.0, 100.0)))

    if (very_high_uv >= 10 or high_uv >= 45) and uv_penalty >= 15:
        label = "High UV lowered score"
    elif high_uv >= 20 and uv_penalty >= 8:
        label = "Moderate UV lowered score"
    elif morning >= 10 and score >= 70:
        label = "Morning daylight"
    elif score >= 85:
        label = "Strong daylight"
    elif score >= 70:
        label = "Balanced"
    elif score >= 45:
        label = "Some daylight"
    else:
        label = "Low daylight"
    return score, label


def build_daily_summary(
    *,
    user_id: int,
    summary_date: date,
    segments: Iterable[Mapping[str, Any]],
) -> SunExposureDailySummary:
    rows = list(segments)
    likely = confirmed = possible = 0.0
    apple_health_daylight = 0.0
    shaded = open_sky = high_uv = very_high_uv = 0.0
    morning_daylight = midday_daylight = afternoon_daylight = 0.0
    effective_uv = open_sky_equiv = 0.0
    max_uv = 0.0
    uv_weighted = uv_weight = 0.0
    health_uv_weighted = health_uv_weight = 0.0
    lux_weighted = lux_weight = 0.0
    max_lux: float | None = None
    confidence_scores: list[float] = []
    sources: set[str] = set()

    for row in rows:
        duration = _duration(row)
        daylight = bool(_get(row, "daylight", default=True))
        outdoor = _outdoor_confidence(row)
        uv_average = _uv_average(row)
        uv_max = _uv_max(row)
        lux = _light_intensity_lux(row)
        max_uv = max(max_uv, uv_max, uv_average)
        area = _area_context(row)
        source = _source(row)
        sources.add(source or "unknown")
        confidence_scores.append(_confidence_score(row))

        values = calculate_segment_values(
            duration_minutes=duration,
            uv_index_average=uv_average,
            outdoor_confidence=outdoor,
            area_context=area,
        )
        effective_uv += values["effective_uv_minutes"]
        open_sky_equiv += values["open_sky_equivalent_minutes"]

        if not daylight:
            continue
        weighted_minutes = duration * outdoor
        start_minute = _local_minute(row, "localStartMinute", "local_start_minute")
        if start_minute is None:
            start_minute = _timestamp_minute(row)
        morning_daylight += _bucket_minutes(start_minute, duration, 5 * 60, 10 * 60) * outdoor
        midday_daylight += _bucket_minutes(start_minute, duration, 10 * 60, 16 * 60) * outdoor
        afternoon_daylight += _bucket_minutes(start_minute, duration, 16 * 60, 20 * 60) * outdoor
        if source in CONFIRMED_SOURCES:
            confirmed += weighted_minutes
        elif outdoor >= 0.55:
            likely += weighted_minutes
        else:
            possible += weighted_minutes

        if source == "healthkit_daylight":
            apple_health_daylight += weighted_minutes
            health_uv_weighted += uv_average * weighted_minutes
            health_uv_weight += weighted_minutes
            if lux is not None:
                lux_weighted += lux * weighted_minutes
                lux_weight += weighted_minutes
                max_lux = lux if max_lux is None else max(max_lux, lux)

        uv_weighted += uv_average * weighted_minutes
        uv_weight += weighted_minutes

        if area.sky_exposure_coefficient < 0.50:
            shaded += weighted_minutes
        if area.sky_exposure_coefficient >= 0.75:
            open_sky += weighted_minutes
        if uv_max >= 3:
            high_uv += weighted_minutes
        if uv_max >= 8:
            very_high_uv += weighted_minutes

    avg_confidence = sum(confidence_scores) / len(confidence_scores) if confidence_scores else 0.0
    confidence = _label_from_score(avg_confidence)
    estimated_daylight = likely + confirmed
    daylight_minutes = apple_health_daylight if apple_health_daylight > 0 else estimated_daylight
    light_intensity_lux_average = lux_weighted / lux_weight if lux_weight > 0 else None
    uv_index_average = (
        health_uv_weighted / health_uv_weight
        if health_uv_weight > 0
        else uv_weighted / uv_weight
        if uv_weight > 0
        else effective_uv / open_sky_equiv
        if open_sky_equiv > 0
        else 0.0
    )
    score, score_label = sun_balance_score(
        daylight_minutes=daylight_minutes,
        light_intensity_lux_average=light_intensity_lux_average,
        uv_index_average=uv_index_average,
        uv_index_max=max_uv,
        high_uv_minutes=high_uv,
        very_high_uv_minutes=very_high_uv,
        morning_daylight_minutes=morning_daylight,
        midday_daylight_minutes=midday_daylight,
        afternoon_daylight_minutes=afternoon_daylight,
    )
    risk_score, risk_label = uv_risk_score(
        effective_uv_minutes=effective_uv,
        uv_index_max=max_uv,
        high_uv_minutes=high_uv,
        very_high_uv_minutes=very_high_uv,
    )
    source_phrase = ", ".join(sorted(s for s in sources if s and s != "unknown")) or "available activity context"
    explanation = (
        "This is an estimate based on "
        f"{source_phrase}, Apple Health daylight when available, light intensity, and UV Index. "
        "It does not confirm exact sun exposure or vitamin D production."
    )
    return SunExposureDailySummary(
        user_id=user_id,
        date=summary_date,
        likely_outdoor_daylight_minutes=likely,
        confirmed_outdoor_daylight_minutes=confirmed,
        possible_outdoor_daylight_minutes=possible,
        mostly_shaded_minutes=shaded,
        mostly_open_sky_minutes=open_sky,
        high_uv_minutes=high_uv,
        very_high_uv_minutes=very_high_uv,
        effective_uv_minutes=effective_uv,
        open_sky_equivalent_minutes=open_sky_equiv,
        daylight_minutes=daylight_minutes,
        apple_health_daylight_minutes=apple_health_daylight,
        light_intensity_lux_average=light_intensity_lux_average,
        light_intensity_lux_max=max_lux,
        uv_index_average=uv_index_average,
        uv_index_max=max_uv,
        morning_daylight_minutes=morning_daylight,
        midday_daylight_minutes=midday_daylight,
        afternoon_daylight_minutes=afternoon_daylight,
        uv_risk_score=risk_score,
        uv_risk_label=risk_label,
        sun_score=score,
        sun_score_label=score_label,
        confidence=confidence,
        explanation=explanation,
        safety_message=safety_message_for_uv(max_uv),
    )
