from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from app.services.sun_exposure.types import (
    AREA_CONTEXT_SOURCES,
    AREA_TYPES,
    AreaContextSource,
    AreaSunContext,
    AreaType,
    ConfidenceLabel,
)


COEFFICIENT_TABLE: dict[AreaType, tuple[float, float]] = {
    "indoor": (0.02, 1.00),
    "vehicle": (0.10, 1.00),
    "dense_forest": (0.20, 1.00),
    "wooded_trail": (0.40, 1.00),
    "park_mixed": (0.65, 1.00),
    "open_grass": (0.95, 1.00),
    "sports_field": (0.95, 1.00),
    "beach": (1.00, 1.15),
    "snow": (1.00, 1.25),
    "water_edge": (0.95, 1.10),
    "urban_street": (0.60, 1.05),
    "unknown": (0.50, 1.00),
}


def clamp(value: float, low: float = 0.0, high: float = 1.5) -> float:
    return max(low, min(high, float(value)))


def canopyToSkyExposureCoefficient(treeCoverPercent: float) -> float:
    """Map tree-cover percent to a conservative open-sky coefficient.

    Kept camelCase because the product spec names this helper directly and
    tests may import it by name.
    """
    try:
        tree_cover = float(treeCoverPercent)
    except Exception:
        tree_cover = 0.0
    if tree_cover >= 80:
        return 0.15
    if tree_cover >= 60:
        return 0.25
    if tree_cover >= 40:
        return 0.40
    if tree_cover >= 20:
        return 0.65
    return 0.90


def coefficient_for_area_type(area_type: str | None) -> tuple[float, float]:
    normalized = normalize_area_type(area_type)
    return COEFFICIENT_TABLE[normalized]


def normalize_area_type(value: Any) -> AreaType:
    raw = str(value or "unknown").strip().lower()
    return raw if raw in AREA_TYPES else "unknown"  # type: ignore[return-value]


def _normalize_source(value: Any, fallback: AreaContextSource = "unknown") -> AreaContextSource:
    raw = str(value or fallback).strip().lower()
    return raw if raw in AREA_CONTEXT_SOURCES else fallback  # type: ignore[return-value]


def _text_tokens(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(str(v or "").lower() for v in value)
    if isinstance(value, Mapping):
        return " ".join(f"{k} {v}" for k, v in value.items()).lower()
    return str(value or "").lower()


def _context(
    area_type: AreaType,
    *,
    source: AreaContextSource,
    confidence: ConfidenceLabel,
    reason_codes: list[str],
) -> AreaSunContext:
    sky, reflection = COEFFICIENT_TABLE[area_type]
    return AreaSunContext(
        area_type=area_type,
        sky_exposure_coefficient=sky,
        reflection_coefficient=reflection,
        source=source,
        confidence=confidence,
        reason_codes=reason_codes,
    )


class AreaSunCoefficientService:
    """Classify a coarse area/location segment into sun-exposure coefficients.

    The service accepts already-derived context signals (OSM tags,
    landcover labels, tree canopy percent, building-polygon hit, manual user
    context). It does not fetch map data itself and never assumes an unknown
    place is full sun.
    """

    def classify(self, hints: Mapping[str, Any] | None = None) -> AreaSunContext:
        hints = hints or {}
        reason_codes: list[str] = []

        manual_area = hints.get("areaType") or hints.get("area_type") or hints.get("manualAreaType")
        if manual_area:
            area_type = normalize_area_type(manual_area)
            reason_codes.append("manual_area_type")
            return _context(
                area_type,
                source="manual",
                confidence="high" if area_type != "unknown" else "low",
                reason_codes=reason_codes,
            )

        if bool(hints.get("buildingPolygon") or hints.get("building_polygon") or hints.get("insideBuilding")):
            return _context(
                "indoor",
                source="building_polygon",
                confidence="high",
                reason_codes=["building_polygon_hit"],
            )

        if bool(hints.get("vehicle") or hints.get("vehicleActivity")):
            return _context(
                "vehicle",
                source=_normalize_source(hints.get("source"), "unknown"),
                confidence="medium",
                reason_codes=["vehicle_activity"],
            )

        tree_cover = hints.get("treeCoverPercent") or hints.get("tree_cover_percent") or hints.get("canopyPercent")
        has_tree_cover = tree_cover is not None
        try:
            tree_cover_float = float(tree_cover) if tree_cover is not None else None
        except Exception:
            tree_cover_float = None

        landcover = _text_tokens(hints.get("landcover") or hints.get("landCover") or hints.get("place") or hints)
        source = _normalize_source(hints.get("source"), "landcover")

        if "snow" in landcover or "ski" in landcover:
            return _context("snow", source=source, confidence="medium", reason_codes=["snow_or_ski_landcover"])
        if "beach" in landcover or "sand" in landcover:
            return _context("beach", source=source, confidence="high", reason_codes=["beach_landcover"])
        if "water" in landcover or "river" in landcover or "lake" in landcover or "shore" in landcover:
            return _context("water_edge", source=source, confidence="medium", reason_codes=["water_edge_landcover"])
        if "sports" in landcover or "pitch" in landcover or "field" in landcover or "track" in landcover:
            return _context("sports_field", source=source, confidence="medium", reason_codes=["sports_field_landcover"])
        if "grass" in landcover or "meadow" in landcover or "farmland" in landcover:
            return _context("open_grass", source=source, confidence="medium", reason_codes=["open_grass_landcover"])
        if "park" in landcover or "garden" in landcover:
            return _context("park_mixed", source=source, confidence="medium", reason_codes=["park_landcover"])
        if "urban" in landcover or "street" in landcover or "road" in landcover or "residential" in landcover:
            return _context("urban_street", source=source, confidence="medium", reason_codes=["urban_street_context"])

        if "forest" in landcover or "wood" in landcover or "trail" in landcover:
            base = _context(
                "dense_forest" if tree_cover_float is not None and tree_cover_float >= 70 else "wooded_trail",
                source="tree_canopy" if has_tree_cover else source,
                confidence="medium",
                reason_codes=["forest_or_wooded_landcover"],
            )
            if tree_cover_float is not None:
                reason_codes = [*base.reason_codes, "tree_cover_percent"]
                return replace(
                    base,
                    sky_exposure_coefficient=canopyToSkyExposureCoefficient(tree_cover_float),
                    confidence="high" if tree_cover_float >= 60 else "medium",
                    reason_codes=reason_codes,
                )
            return base

        if tree_cover_float is not None:
            coefficient = canopyToSkyExposureCoefficient(tree_cover_float)
            area_type: AreaType = "wooded_trail" if coefficient <= 0.65 else "park_mixed"
            sky, reflection = COEFFICIENT_TABLE[area_type]
            return AreaSunContext(
                area_type=area_type,
                sky_exposure_coefficient=min(coefficient, sky),
                reflection_coefficient=reflection,
                source="tree_canopy",
                confidence="medium",
                reason_codes=["tree_cover_percent"],
            )

        return _context(
            "unknown",
            source="unknown",
            confidence="low",
            reason_codes=["unknown_area_context", "unknown_not_full_sun"],
        )
