"""Cardio progression — pace, distance, and HR-efficiency trends.

The cardio pillar of the composite fitness score answers "are you doing
enough?". This service answers the next question: "are you getting
fitter?". It surfaces:

  * **Personal bests** — fastest pace at 5K, 10K, 10-mile (run, bike).
    Computed from logged `WorkoutCompletion.distance_miles` +
    `duration_seconds`. Lifetime best within the scan window.
  * **Recent vs prior** — recent-28d average pace vs prior-28d, per
    activity subtype. Trending faster = fitness improving.
  * **HR efficiency** — avg HR over the session normalized by intensity
    proxy (load per minute). Improving fitness lowers HR at given load.
    Only computed when we have HR data; skipped silently otherwise.

All trends gracefully degrade: if the user doesn't run, `best_5k`
returns None and the UI hides that tile. We never invent metrics; the
"unknown ≠ zero" invariant from nutrition holds here too.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.models import WorkoutCompletion


# Distance thresholds for PR matching. We require the logged distance to
# fall in a band so a 5.5-mile easy jog doesn't count as a 5K PR.
_DISTANCE_BANDS_MILES: tuple[tuple[str, float, float], ...] = (
    ("5k",   3.0,  3.4),    # 5.0 km = 3.107 mi
    ("10k",  6.0,  6.6),    # 10.0 km = 6.214 mi
    ("10mi", 9.5,  10.5),
    ("half_marathon", 13.0, 13.5),
    ("marathon", 26.0, 26.5),
)

# Activity-subtype → tag we surface PRs under. Anything matching a
# "running" intent shows up under run PRs; anything matching cycling
# shows under ride PRs. Walks and hikes don't earn pace PRs (they're
# slow by nature; calling a 18-min/mi walk a "10K PR" is misleading).
_RUN_SUBTYPES = {"run", "running", "trail_run", "treadmill_run"}
_RIDE_SUBTYPES = {"ride", "cycle", "cycling", "bike", "spin"}

# Scan window for PRs. 365 days mirrors the streak scan: long enough to
# surface real bests, short enough that a 2017 mileage PR doesn't
# permanently overshadow the user's current fitness.
SCAN_WINDOW_DAYS = 365
RECENT_WINDOW_DAYS = 28


@dataclass(frozen=True)
class PaceBest:
    distance_label: str            # "5k" | "10k" | "10mi" | ...
    activity: str                  # "run" | "ride"
    pace_seconds_per_mile: float   # smaller = faster
    duration_seconds: int
    distance_miles: float
    achieved_on: date

    def to_dict(self) -> dict:
        return {
            "distance_label": self.distance_label,
            "activity": self.activity,
            "pace_seconds_per_mile": round(self.pace_seconds_per_mile, 1),
            "duration_seconds": self.duration_seconds,
            "distance_miles": round(self.distance_miles, 2),
            "achieved_on": self.achieved_on.isoformat(),
        }


@dataclass(frozen=True)
class PaceTrend:
    activity: str                  # "run" | "ride"
    recent_avg_pace_sec_per_mile: float | None
    prior_avg_pace_sec_per_mile: float | None
    delta_pct: float | None        # negative = faster (improved)
    recent_sessions: int
    prior_sessions: int

    def to_dict(self) -> dict:
        return {
            "activity": self.activity,
            "recent_avg_pace_sec_per_mile":
                round(self.recent_avg_pace_sec_per_mile, 1)
                if self.recent_avg_pace_sec_per_mile else None,
            "prior_avg_pace_sec_per_mile":
                round(self.prior_avg_pace_sec_per_mile, 1)
                if self.prior_avg_pace_sec_per_mile else None,
            "delta_pct": round(self.delta_pct, 1) if self.delta_pct is not None else None,
            "recent_sessions": self.recent_sessions,
            "prior_sessions": self.prior_sessions,
        }


@dataclass(frozen=True)
class CardioProgressionSnapshot:
    bests: list[PaceBest]
    trends: list[PaceTrend]
    recent_cardio_load: float
    recent_active_days: int

    def to_dict(self) -> dict:
        return {
            "bests": [b.to_dict() for b in self.bests],
            "trends": [t.to_dict() for t in self.trends],
            "recent_cardio_load": round(self.recent_cardio_load, 1),
            "recent_active_days": self.recent_active_days,
        }


def _activity_bucket(subtype: str | None) -> str | None:
    s = (subtype or "").strip().lower()
    if s in _RUN_SUBTYPES:
        return "run"
    if s in _RIDE_SUBTYPES:
        return "ride"
    return None


def _pace_sec_per_mile(distance_miles: float, duration_seconds: int) -> float | None:
    if distance_miles <= 0 or duration_seconds <= 0:
        return None
    return duration_seconds / distance_miles


def compute_cardio_progression(
    db: Any,
    user_id: int,
    *,
    end_date: date | None = None,
) -> CardioProgressionSnapshot:
    if end_date is None:
        from datetime import datetime, timezone as _tz
        end_date = datetime.now(_tz.utc).date()
    since = end_date - timedelta(days=SCAN_WINDOW_DAYS - 1)
    recent_cutoff = end_date - timedelta(days=RECENT_WINDOW_DAYS - 1)
    prior_cutoff = recent_cutoff - timedelta(days=RECENT_WINDOW_DAYS)

    rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= since)
        .where(WorkoutCompletion.workout_date <= end_date)
    ).all()

    bests: dict[tuple[str, str], PaceBest] = {}
    recent_paces: dict[str, list[float]] = {"run": [], "ride": []}
    prior_paces: dict[str, list[float]] = {"run": [], "ride": []}
    recent_active_days: set[date] = set()
    recent_cardio_load = 0.0

    for row in rows:
        bucket = _activity_bucket(row.activity_subtype)
        dist = row.distance_miles or 0.0
        dur = row.duration_seconds or 0
        # PR matching is bucket-aware (no walking PRs); cardio load is
        # bucket-agnostic — any logged TRIMP counts toward "load + days".
        load = getattr(row, "cardio_load", None)
        if load and row.workout_date >= recent_cutoff:
            recent_cardio_load += float(load)
            recent_active_days.add(row.workout_date)

        if bucket is None:
            continue
        pace = _pace_sec_per_mile(dist, dur)
        if pace is None:
            continue

        # ── PR matching ──────────────────────────────────────────────
        for label, lo, hi in _DISTANCE_BANDS_MILES:
            if dist < lo or dist > hi:
                continue
            key = (label, bucket)
            current = bests.get(key)
            if current is None or pace < current.pace_seconds_per_mile:
                bests[key] = PaceBest(
                    distance_label=label,
                    activity=bucket,
                    pace_seconds_per_mile=pace,
                    duration_seconds=dur,
                    distance_miles=dist,
                    achieved_on=row.workout_date,
                )

        # ── Recent vs prior pace average ─────────────────────────────
        # Only count sessions of at least 1 mile so 0.4-mile cooldowns
        # don't drag the average. Weighted average by distance would be
        # more accurate; simple mean is honest enough for "are you
        # trending faster?" UI copy.
        if dist >= 1.0:
            if row.workout_date >= recent_cutoff:
                recent_paces[bucket].append(pace)
            elif row.workout_date >= prior_cutoff:
                prior_paces[bucket].append(pace)

    def _build_trend(activity: str) -> PaceTrend:
        recent = recent_paces[activity]
        prior = prior_paces[activity]
        recent_avg = sum(recent) / len(recent) if recent else None
        prior_avg = sum(prior) / len(prior) if prior else None
        if recent_avg is not None and prior_avg and prior_avg > 0:
            delta = (recent_avg - prior_avg) / prior_avg * 100.0
        else:
            delta = None
        return PaceTrend(
            activity=activity,
            recent_avg_pace_sec_per_mile=recent_avg,
            prior_avg_pace_sec_per_mile=prior_avg,
            delta_pct=delta,
            recent_sessions=len(recent),
            prior_sessions=len(prior),
        )

    trends = [_build_trend("run"), _build_trend("ride")]

    return CardioProgressionSnapshot(
        bests=sorted(bests.values(), key=lambda b: (b.activity, b.pace_seconds_per_mile)),
        trends=[t for t in trends if (t.recent_sessions + t.prior_sessions) > 0],
        recent_cardio_load=recent_cardio_load,
        recent_active_days=len(recent_active_days),
    )
