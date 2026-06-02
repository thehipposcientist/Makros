"""Rolling sleep gap signal.

This is deliberately a recovery-context signal, not a medical sleep
diagnosis and not a literal "debt ledger." It looks at recent sleep
duration against a conservative personal sleep-need estimate, lets
small catch-up nights help, and caps the practical impact so the app
never gives users an impossible number to "repay."
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date, timedelta
from math import exp, log
from statistics import fmean
from typing import Iterable, Protocol


DEFAULT_SLEEP_NEED_HOURS = 7.75
MIN_SLEEP_NEED_HOURS = 7.25
MAX_SLEEP_NEED_HOURS = 9.0
MIN_NIGHTS_FOR_PRESSURE = 5
WINDOW_DAYS = 14
NEED_LOOKBACK_DAYS = 30
RECENCY_HALF_LIFE_DAYS = 5.0
MAX_DISPLAY_PRESSURE_HOURS = 8.0
MAX_SLEEP_SCORE_PENALTY = 18


class SleepPressureRow(Protocol):
    night_date: date
    total_hours: float | None
    score: int | None


@dataclass(frozen=True)
class SleepPressureResult:
    status: str
    pressure_hours: float
    display_hours: float
    is_capped: bool
    sleep_need_hours: float
    recent_average_hours: float | None
    nights_count: int
    window_days: int
    confidence: str
    sleep_score_penalty: int
    headline: str
    detail: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class _Night:
    night_date: date
    total_hours: float
    score: int | None = None


def compute_sleep_pressure(
    rows: Iterable[SleepPressureRow],
    *,
    as_of: date | None = None,
    window_days: int = WINDOW_DAYS,
) -> SleepPressureResult:
    today = as_of or date.today()
    window_days = max(7, min(30, int(window_days or WINDOW_DAYS)))
    clean = _clean_rows(rows, today)
    need = _estimate_sleep_need(clean, today)
    window_start = today - timedelta(days=window_days - 1)
    recent = [n for n in clean if n.night_date >= window_start]

    if len(recent) < MIN_NIGHTS_FOR_PRESSURE:
        return SleepPressureResult(
            status="not_enough_data",
            pressure_hours=0.0,
            display_hours=0.0,
            is_capped=False,
            sleep_need_hours=need,
            recent_average_hours=_round_or_none(fmean(n.total_hours for n in recent)) if recent else None,
            nights_count=len(recent),
            window_days=window_days,
            confidence="low",
            sleep_score_penalty=0,
            headline="Sleep gap is calibrating",
            detail="A few more nights will make the rolling read useful.",
        )

    weighted_balance = 0.0
    total_weight = 0.0
    for night in recent:
        age_days = max(0, (today - night.night_date).days)
        weight = exp(-log(2) * age_days / RECENCY_HALF_LIFE_DAYS)
        deficit = max(0.0, need - night.total_hours)
        catchup_credit = min(max(0.0, night.total_hours - need), 1.0) * 0.5
        weighted_balance += weight * (deficit - catchup_credit)
        total_weight += weight

    avg_balance = weighted_balance / total_weight if total_weight > 0 else 0.0
    pressure = max(0.0, avg_balance * len(recent))
    display = min(MAX_DISPLAY_PRESSURE_HOURS, pressure)
    penalty = _score_penalty(pressure)
    status = _status_for(pressure)
    confidence = "high" if len(recent) >= 10 else "medium" if len(recent) >= 7 else "low"

    return SleepPressureResult(
        status=status,
        pressure_hours=round(pressure, 2),
        display_hours=round(display, 2),
        is_capped=pressure > MAX_DISPLAY_PRESSURE_HOURS,
        sleep_need_hours=need,
        recent_average_hours=_round_or_none(fmean(n.total_hours for n in recent)),
        nights_count=len(recent),
        window_days=window_days,
        confidence=confidence,
        sleep_score_penalty=penalty,
        headline=_headline_for(status),
        detail=_detail_for(status),
    )


def _clean_rows(rows: Iterable[SleepPressureRow], today: date) -> list[_Night]:
    cutoff = today - timedelta(days=NEED_LOOKBACK_DAYS - 1)
    by_night: dict[date, _Night] = {}
    for row in rows:
        night_date = getattr(row, "night_date", None)
        hours = getattr(row, "total_hours", None)
        if not isinstance(night_date, date):
            continue
        if night_date < cutoff or night_date > today:
            continue
        if hours is None:
            continue
        try:
            total_hours = float(hours)
        except (TypeError, ValueError):
            continue
        if total_hours < 0.5 or total_hours > 16:
            continue
        by_night[night_date] = _Night(
            night_date=night_date,
            total_hours=total_hours,
            score=getattr(row, "score", None),
        )
    return sorted(by_night.values(), key=lambda n: n.night_date)


def _estimate_sleep_need(rows: list[_Night], today: date) -> float:
    lookback_start = today - timedelta(days=NEED_LOOKBACK_DAYS - 1)
    recent = [n for n in rows if n.night_date >= lookback_start]
    scored_good = [
        n.total_hours for n in recent
        if n.score is not None and n.score >= 75 and 5.5 <= n.total_hours <= 10.5
    ]
    durations = [n.total_hours for n in recent if 5.5 <= n.total_hours <= 10.5]
    sample = scored_good if len(scored_good) >= 5 else durations if len(durations) >= 10 else []
    if not sample:
        return DEFAULT_SLEEP_NEED_HOURS
    need = _percentile(sample, 0.75)
    need = max(MIN_SLEEP_NEED_HOURS, min(MAX_SLEEP_NEED_HOURS, need))
    return round(need * 4) / 4


def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return DEFAULT_SLEEP_NEED_HOURS
    if len(ordered) == 1:
        return ordered[0]
    pos = (len(ordered) - 1) * max(0.0, min(1.0, q))
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    frac = pos - lo
    return ordered[lo] * (1 - frac) + ordered[hi] * frac


def _status_for(pressure_hours: float) -> str:
    if pressure_hours < 0.5:
        return "clear"
    if pressure_hours < 2.0:
        return "low"
    if pressure_hours < 5.0:
        return "moderate"
    return "high"


def _score_penalty(pressure_hours: float) -> int:
    if pressure_hours < 1.0:
        return 0
    if pressure_hours < 2.0:
        return min(MAX_SLEEP_SCORE_PENALTY, int(round(pressure_hours * 3)))
    if pressure_hours < 5.0:
        return min(MAX_SLEEP_SCORE_PENALTY, int(round(6 + (pressure_hours - 2.0) * 2)))
    return min(MAX_SLEEP_SCORE_PENALTY, int(round(12 + (pressure_hours - 5.0) * 1.5)))


def _headline_for(status: str) -> str:
    return {
        "clear": "Sleep gap is clear",
        "low": "Small sleep gap",
        "moderate": "Sleep gap is building",
        "high": "High sleep gap",
    }.get(status, "Sleep gap is calibrating")


def _detail_for(status: str) -> str:
    return {
        "clear": "Recent sleep is covering recovery needs.",
        "low": "Keep bedtime steady and avoid letting a short night stack.",
        "moderate": "Several shorter nights are adding up; cap intensity if HRV or resting HR also look off.",
        "high": "Recent sleep is well below your estimated need; lighter training or an earlier night is the better default.",
    }.get(status, "A few more nights will make the rolling read useful.")


def _round_or_none(value: float | None) -> float | None:
    if value is None:
        return None
    return round(float(value), 2)
