"""Shared recency rules for load recommendations.

Old performance data is useful, but it should not be treated like today's
capacity. These helpers keep the live recommender, plan target propagation,
and client fallback anchors on the same deterministic staleness curve.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any


@dataclass(frozen=True)
class RecencyAdjustment:
    days_since: int | None
    load_multiplier: float
    confidence_multiplier: float
    confidence_cap: float | None
    age_label: str | None
    reason: str | None

    @property
    def is_stale(self) -> bool:
        return self.load_multiplier < 1.0

    @property
    def discount_pct(self) -> int:
        return int(round((1.0 - self.load_multiplier) * 100))


def coerce_performed_on(value: Any) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None
    return None


def _age_label(days: int) -> str:
    if days < 14:
        return f"{days} day" + ("" if days == 1 else "s")
    weeks = max(2, round(days / 7))
    if weeks < 8:
        return f"{weeks} weeks"
    months = max(2, round(days / 30))
    return f"{months} months"


def recency_adjustment(performed_on: Any, *, today: date | None = None) -> RecencyAdjustment:
    performed = coerce_performed_on(performed_on)
    if performed is None:
        return RecencyAdjustment(None, 1.0, 1.0, None, None, None)

    today = today or date.today()
    days_since = max(0, (today - performed).days)
    if days_since <= 21:
        return RecencyAdjustment(days_since, 1.0, 1.0, None, _age_label(days_since), None)

    if days_since <= 42:
        multiplier = 0.95
        confidence_multiplier = 0.85
        confidence_cap = 0.70
    elif days_since <= 84:
        multiplier = 0.90
        confidence_multiplier = 0.70
        confidence_cap = 0.55
    else:
        multiplier = 0.85
        confidence_multiplier = 0.55
        confidence_cap = 0.40

    age = _age_label(days_since)
    discount = int(round((1.0 - multiplier) * 100))
    return RecencyAdjustment(
        days_since=days_since,
        load_multiplier=multiplier,
        confidence_multiplier=confidence_multiplier,
        confidence_cap=confidence_cap,
        age_label=age,
        reason=f"Last logged {age} ago, so using a {discount}% lighter reacclimation load",
    )


def adjust_confidence_for_recency(confidence: float, adjustment: RecencyAdjustment) -> float:
    if not adjustment.is_stale:
        return confidence
    capped = confidence * adjustment.confidence_multiplier
    if adjustment.confidence_cap is not None:
        capped = min(capped, adjustment.confidence_cap)
    return round(max(0.0, capped), 2)
