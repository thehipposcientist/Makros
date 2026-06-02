from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from statistics import fmean
from typing import Any

from app.models import DailyStressSummary


@dataclass(frozen=True)
class StressBaseline:
    window_days: int
    avg_stress: float
    days_with_data: int
    min_stress: float
    max_stress: float


def stress_comparison(today_avg: float | None, baseline_avg: float | None) -> dict[str, Any] | None:
    if today_avg is None or baseline_avg is None:
        return None
    delta = round(float(today_avg) - float(baseline_avg), 1)
    abs_delta = abs(delta)
    if abs_delta <= 5:
        label = "about_usual"
        copy = "about your usual"
        severity = "neutral"
    elif delta > 0:
        label = "much_higher_than_usual" if delta >= 12 else "higher_than_usual"
        copy = "much higher than your usual" if delta >= 12 else "a little higher than your usual"
        severity = "high" if delta >= 12 else "watch"
    else:
        label = "much_lower_than_usual" if delta <= -12 else "lower_than_usual"
        copy = "much lower than your usual" if delta <= -12 else "lower than your usual"
        severity = "low"
    return {
        "delta": delta,
        "label": label,
        "copy": copy,
        "severity": severity,
    }


def stress_row_to_dict(row: DailyStressSummary, *, baseline_avg: float | None = None) -> dict[str, Any]:
    avg = round(float(row.avg_stress), 1)
    return {
        "summary_date": row.summary_date.isoformat(),
        "avg_stress": avg,
        "max_stress": round(float(row.max_stress), 1) if row.max_stress is not None else None,
        "latest_stress": round(float(row.latest_stress), 1) if row.latest_stress is not None else None,
        "sample_count": int(row.sample_count or 0),
        "source_count": int(row.source_count or 0),
        "source": row.source,
        "source_details": row.source_details,
        "computed_at": row.computed_at.isoformat() if row.computed_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "comparison": stress_comparison(avg, baseline_avg),
    }


def baseline_from_rows(
    rows: list[DailyStressSummary],
    *,
    as_of: date,
    baseline_days: int,
) -> StressBaseline | None:
    values = [
        float(row.avg_stress)
        for row in rows
        if row.summary_date < as_of and (as_of - row.summary_date).days <= baseline_days
    ]
    if not values:
        return None
    return StressBaseline(
        window_days=baseline_days,
        avg_stress=round(float(fmean(values)), 1),
        days_with_data=len(values),
        min_stress=round(min(values), 1),
        max_stress=round(max(values), 1),
    )


def baseline_to_dict(baseline: StressBaseline | None) -> dict[str, Any] | None:
    if baseline is None:
        return None
    return {
        "window_days": baseline.window_days,
        "avg_stress": baseline.avg_stress,
        "days_with_data": baseline.days_with_data,
        "min_stress": baseline.min_stress,
        "max_stress": baseline.max_stress,
    }


def build_stress_history_response(
    rows: list[DailyStressSummary],
    *,
    as_of: date,
    days: int,
    baseline_days: int,
    visible_rows: list[DailyStressSummary] | None = None,
) -> dict[str, Any]:
    baseline = baseline_from_rows(rows, as_of=as_of, baseline_days=baseline_days)
    baseline_avg = baseline.avg_stress if baseline else None
    today = next((row for row in rows if row.summary_date == as_of), None)
    out_rows = visible_rows if visible_rows is not None else rows
    return {
        "as_of": as_of.isoformat(),
        "days": days,
        "baseline_days": baseline_days,
        "baseline": baseline_to_dict(baseline),
        "today": stress_row_to_dict(today, baseline_avg=baseline_avg) if today else None,
        "rows": [stress_row_to_dict(row, baseline_avg=baseline_avg) for row in out_rows],
    }
