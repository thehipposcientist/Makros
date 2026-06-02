"""Weekly cardio training-load rollup (Edwards' TRIMP).

Parallels `weekly_volume.py` for strength: each row aggregates one ISO
week of cardio TRIMP so the UI can render a trend chart and the cardio
pillar can read "load trending up / flat / down" without recomputing
per request.

Reads `WorkoutCompletion.cardio_load`, which is populated at write-time
from `hr_summary.zoneMinutes` (real wearable data or the manual-cardio
zone synthesizer). Sessions with no cardio_load contribute 0 to the
session count too — we only count sessions that actually produced
aerobic load.

Pure function — no AI, no writes. The only inputs are the user_id, the
DB session, and how many weeks back to read.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.models import WorkoutCompletion


# Default rolling window for the trend chart. 8 weeks ≈ 2 months —
# enough to spot a real trend without overfitting to a single hard week.
DEFAULT_WEEKS = 8
# Comparison baseline for "trending up vs flat vs down" — the 4 weeks
# preceding the current week. Used both by the cardio progression
# sub-pillar (fitness_score.py) and by the trend label in the chart card.
TREND_BASELINE_WEEKS = 4


@dataclass
class WeekRollup:
    week_start: date          # Monday of the ISO week (inclusive)
    week_end: date            # Sunday of the ISO week (inclusive)
    load: float               # Sum of cardio_load across the week
    session_count: int        # Cardio sessions with non-null load

    def to_dict(self) -> dict:
        return {
            "week_start": self.week_start.isoformat(),
            "week_end": self.week_end.isoformat(),
            "load": round(self.load, 1),
            "session_count": self.session_count,
        }


@dataclass
class WeeklyCardioLoadSnapshot:
    weeks: list[WeekRollup]
    rolling_baseline_load: float     # avg load over TREND_BASELINE_WEEKS prior weeks
    current_week_load: float
    trend_ratio: float | None        # current / baseline (None when baseline = 0)
    trend_label: str                 # "trending_up" | "flat" | "trending_down" | "no_baseline"

    def to_dict(self) -> dict:
        return {
            "weeks": [w.to_dict() for w in self.weeks],
            "rolling_baseline_load": round(self.rolling_baseline_load, 1),
            "current_week_load": round(self.current_week_load, 1),
            "trend_ratio": round(self.trend_ratio, 2) if self.trend_ratio is not None else None,
            "trend_label": self.trend_label,
        }


def _iso_week_start(d: date) -> date:
    """Monday of the ISO week containing `d`."""
    return d - timedelta(days=d.weekday())


def compute_weekly_cardio_load(
    db: Any,
    user_id: int,
    *,
    weeks: int = DEFAULT_WEEKS,
    end_date: date | None = None,
) -> WeeklyCardioLoadSnapshot:
    """Roll up cardio_load by ISO week ending at `end_date` (default today).

    Returns `weeks` consecutive WeekRollup entries, oldest first. Missing
    weeks are filled with zero-load placeholders so the chart shows the
    gap honestly. The trend label compares the most recent week against
    the mean of the prior `TREND_BASELINE_WEEKS` weeks.
    """
    if end_date is None:
        end_date = date.today()
    if weeks < 1:
        weeks = 1

    current_week_start = _iso_week_start(end_date)
    # Build the list of ISO-week buckets we want, oldest first.
    week_starts: list[date] = [
        current_week_start - timedelta(weeks=offset)
        for offset in range(weeks - 1, -1, -1)
    ]
    window_start = week_starts[0]
    window_end = current_week_start + timedelta(days=6)

    rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= window_start)
        .where(WorkoutCompletion.workout_date <= window_end)
    ).all()

    # Bucket by ISO week start.
    by_week: dict[date, list[float]] = {ws: [] for ws in week_starts}
    for row in rows:
        # Null cardio_load = strength session or cardio without HR data.
        # Either way, don't count it as a cardio session here — load
        # chart should only reflect actual aerobic stimulus.
        load = getattr(row, "cardio_load", None)
        if load is None:
            continue
        ws = _iso_week_start(row.workout_date)
        if ws in by_week:
            by_week[ws].append(float(load))

    week_rollups: list[WeekRollup] = []
    for ws in week_starts:
        loads = by_week[ws]
        week_rollups.append(WeekRollup(
            week_start=ws,
            week_end=ws + timedelta(days=6),
            load=sum(loads),
            session_count=len(loads),
        ))

    current = week_rollups[-1].load if week_rollups else 0.0
    baseline_weeks = week_rollups[-(TREND_BASELINE_WEEKS + 1):-1] if len(week_rollups) >= 2 else []
    baseline_avg = (
        sum(w.load for w in baseline_weeks) / len(baseline_weeks)
        if baseline_weeks else 0.0
    )

    if baseline_avg <= 0:
        trend_ratio: float | None = None
        trend_label = "no_baseline"
    else:
        trend_ratio = current / baseline_avg
        # Tight bands so the label doesn't flip on noise.
        if trend_ratio >= 1.10:
            trend_label = "trending_up"
        elif trend_ratio <= 0.85:
            trend_label = "trending_down"
        else:
            trend_label = "flat"

    return WeeklyCardioLoadSnapshot(
        weeks=week_rollups,
        rolling_baseline_load=baseline_avg,
        current_week_load=current,
        trend_ratio=trend_ratio,
        trend_label=trend_label,
    )
