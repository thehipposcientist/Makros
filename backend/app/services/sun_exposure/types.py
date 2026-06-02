from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


AreaType = Literal[
    "indoor",
    "vehicle",
    "dense_forest",
    "wooded_trail",
    "park_mixed",
    "open_grass",
    "beach",
    "snow",
    "water_edge",
    "urban_street",
    "sports_field",
    "unknown",
]

AreaContextSource = Literal[
    "osm",
    "landcover",
    "tree_canopy",
    "building_polygon",
    "manual",
    "unknown",
]

ConfidenceLabel = Literal["low", "medium", "high"]

SunExposureSource = Literal[
    "healthkit_daylight",
    "workout_route",
    "activity_recognition",
    "coarse_location",
    "manual",
]

LikelyOutdoorValue = bool | Literal["unknown"]


@dataclass(frozen=True)
class AreaSunContext:
    area_type: AreaType
    sky_exposure_coefficient: float
    reflection_coefficient: float
    source: AreaContextSource = "unknown"
    confidence: ConfidenceLabel = "low"
    reason_codes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "areaType": self.area_type,
            "skyExposureCoefficient": round(float(self.sky_exposure_coefficient), 4),
            "reflectionCoefficient": round(float(self.reflection_coefficient), 4),
            "source": self.source,
            "confidence": self.confidence,
            "reasonCodes": list(self.reason_codes),
        }

    @classmethod
    def from_dict(cls, value: dict | None) -> "AreaSunContext":
        if not isinstance(value, dict):
            return cls(
                area_type="unknown",
                sky_exposure_coefficient=0.50,
                reflection_coefficient=1.00,
                source="unknown",
                confidence="low",
                reason_codes=["missing_area_context"],
            )
        area_type = str(value.get("areaType") or value.get("area_type") or "unknown").strip().lower()
        if area_type not in AREA_TYPES:
            area_type = "unknown"
        source = str(value.get("source") or "unknown").strip().lower()
        if source not in AREA_CONTEXT_SOURCES:
            source = "unknown"
        confidence = str(value.get("confidence") or "low").strip().lower()
        if confidence not in CONFIDENCE_LABELS:
            confidence = "low"
        reason_codes = value.get("reasonCodes") or value.get("reason_codes") or []
        if not isinstance(reason_codes, list):
            reason_codes = []
        return cls(
            area_type=area_type,  # type: ignore[arg-type]
            sky_exposure_coefficient=float(value.get("skyExposureCoefficient") or value.get("sky_exposure_coefficient") or 0.50),
            reflection_coefficient=float(value.get("reflectionCoefficient") or value.get("reflection_coefficient") or 1.00),
            source=source,  # type: ignore[arg-type]
            confidence=confidence,  # type: ignore[arg-type]
            reason_codes=[str(code) for code in reason_codes if str(code or "").strip()],
        )


@dataclass(frozen=True)
class OutdoorConfidenceEstimate:
    outdoor_confidence: float
    likely_outdoor: LikelyOutdoorValue
    reason_codes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "outdoorConfidence": round(float(self.outdoor_confidence), 4),
            "likelyOutdoor": self.likely_outdoor,
            "reasonCodes": list(self.reason_codes),
        }


AREA_TYPES = {
    "indoor",
    "vehicle",
    "dense_forest",
    "wooded_trail",
    "park_mixed",
    "open_grass",
    "beach",
    "snow",
    "water_edge",
    "urban_street",
    "sports_field",
    "unknown",
}

AREA_CONTEXT_SOURCES = {
    "osm",
    "landcover",
    "tree_canopy",
    "building_polygon",
    "manual",
    "unknown",
}

CONFIDENCE_LABELS = {"low", "medium", "high"}

SUN_EXPOSURE_SOURCES = {
    "healthkit_daylight",
    "workout_route",
    "activity_recognition",
    "coarse_location",
    "manual",
}

