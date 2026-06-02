from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import replace
from typing import Any, Literal

from app.services.sun_exposure.area_coefficients import COEFFICIENT_TABLE
from app.services.sun_exposure.calculation import calculate_segment_values, segment_confidence_label
from app.services.sun_exposure.types import AreaSunContext


CorrectionOption = Literal[
    "mostly_sunny",
    "mixed",
    "mostly_shaded",
    "indoors",
    "wrong_activity",
    "dismiss",
]


CORRECTION_OPTIONS = {
    "mostly_sunny",
    "mixed",
    "mostly_shaded",
    "indoors",
    "wrong_activity",
    "dismiss",
}


def normalize_correction(value: str | None) -> CorrectionOption:
    normalized = str(value or "dismiss").strip().lower()
    if normalized not in CORRECTION_OPTIONS:
        normalized = "dismiss"
    return normalized  # type: ignore[return-value]


def should_prompt_for_correction(
    *,
    confidence: str | None,
    uv_index_max: float,
    high_uv_minutes: float = 0.0,
    opened_summary_adjust: bool = False,
    repeated_unknown_area_count: int = 0,
) -> bool:
    if opened_summary_adjust:
        return True
    if repeated_unknown_area_count >= 3:
        return True
    if str(confidence or "").lower() == "low" and uv_index_max >= 3:
        return True
    return uv_index_max >= 3 and high_uv_minutes >= 20


def _correction_sky_coefficient(correction: CorrectionOption, current: float) -> float:
    if correction == "mostly_sunny":
        return max(current, 0.85)
    if correction == "mixed":
        return min(max(current, 0.45), 0.70)
    if correction == "mostly_shaded":
        return min(current, 0.35)
    if correction in {"indoors", "wrong_activity"}:
        return 0.02
    return current


def adjusted_context_for_correction(
    area_context: AreaSunContext,
    correction: str | None,
) -> AreaSunContext:
    normalized = normalize_correction(correction)
    if normalized == "indoors":
        return AreaSunContext(
            area_type="indoor",
            sky_exposure_coefficient=COEFFICIENT_TABLE["indoor"][0],
            reflection_coefficient=COEFFICIENT_TABLE["indoor"][1],
            source="manual",
            confidence="high",
            reason_codes=[*area_context.reason_codes, "user_correction_indoors"],
        )
    if normalized == "wrong_activity":
        return replace(
            area_context,
            sky_exposure_coefficient=0.02,
            source="manual",
            confidence="low",
            reason_codes=[*area_context.reason_codes, "user_correction_wrong_activity"],
        )
    if normalized in {"mostly_sunny", "mixed", "mostly_shaded"}:
        return replace(
            area_context,
            sky_exposure_coefficient=_correction_sky_coefficient(normalized, area_context.sky_exposure_coefficient),
            source="manual",
            confidence="high",
            reason_codes=[*area_context.reason_codes, f"user_correction_{normalized}"],
        )
    return area_context


def future_adjusted_context(
    area_context: AreaSunContext,
    corrections: Iterable[Mapping[str, Any]],
) -> AreaSunContext:
    relevant = [normalize_correction(str(row.get("correction_type") or row.get("correctionType") or "")) for row in corrections]
    if not relevant:
        return area_context
    if "indoors" in relevant:
        return adjusted_context_for_correction(area_context, "indoors")
    if "mostly_shaded" in relevant:
        return adjusted_context_for_correction(area_context, "mostly_shaded")
    if "mixed" in relevant:
        return adjusted_context_for_correction(area_context, "mixed")
    if "mostly_sunny" in relevant:
        return adjusted_context_for_correction(area_context, "mostly_sunny")
    return area_context


def apply_correction_to_segment_dict(segment: Mapping[str, Any], correction: str | None) -> dict:
    normalized = normalize_correction(correction)
    area_context = AreaSunContext.from_dict(segment.get("areaContext") or segment.get("area_context"))
    adjusted = adjusted_context_for_correction(area_context, normalized)
    outdoor_confidence = float(segment.get("outdoorConfidence") or segment.get("outdoor_confidence") or 0)
    if normalized in {"indoors", "wrong_activity"}:
        outdoor_confidence = 0.0
    elif normalized in {"mostly_sunny", "mixed", "mostly_shaded"}:
        outdoor_confidence = max(outdoor_confidence, 0.90)

    duration = float(segment.get("durationMinutes") or segment.get("duration_minutes") or 0)
    uv_average = float(segment.get("uvIndexAverage") or segment.get("uv_index_average") or 0)
    values = calculate_segment_values(
        duration_minutes=duration,
        uv_index_average=uv_average,
        outdoor_confidence=outdoor_confidence,
        area_context=adjusted,
    )
    source = str(segment.get("source") or "")
    confidence = segment_confidence_label(
        outdoor_confidence=outdoor_confidence,
        area_context=adjusted,
        source=source,
    )
    next_segment = dict(segment)
    next_segment["areaContext"] = adjusted.to_dict()
    next_segment["outdoorConfidence"] = outdoor_confidence
    next_segment["effectiveUvMinutes"] = values["effective_uv_minutes"]
    next_segment["openSkyEquivalentMinutes"] = values["open_sky_equivalent_minutes"]
    next_segment["confidence"] = confidence
    return next_segment

