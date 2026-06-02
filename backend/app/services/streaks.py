"""Streak service — server-authoritative streak counts.

Three streaks at launch:
  * `workout`   — consecutive days with at least one logged WorkoutCompletion
  * `meal`      — consecutive days with at least one logged Meal
  * `readiness` — consecutive days with a coach check-in (WeeklyCheckIn or
                  the daily micro-checkin signal — whichever is present)

Design choices:
  * **Computed from existing rows, no new table.** Streaks are derivable
    from WorkoutCompletion / Meal / WeeklyCheckIn. Persisting them would
    double-write and create reconciliation pain. We cache the computed
    result in `/streaks` callers via the existing read-cache layer.
  * **One grace day per streak** ("streak freeze"). Skipping a single
    day doesn't reset — at most one missed day in the consecutive
    window is forgiven. Two consecutive misses = broken. This matches
    the Duolingo / Strong / Strava pattern users already understand.
  * **`current`** = active streak ending today/yesterday. **`best`** =
    longest streak we can observe in the last 365 days. We don't store
    all-time best because streak-rotting users get nothing from "your
    best was 240 days, 5 years ago" — it's demotivating.
  * **Timezone**: we resolve "today" via the user's stored timezone if
    set, else fall back to UTC. A late-night log in PST shouldn't break
    your streak just because the server thinks it's tomorrow.

Pure function — no AI, no writes. Computed lazily on `/streaks` reads.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlmodel import select

from app.models import Meal, WorkoutCompletion, WeeklyCheckIn


# How far back to scan. 365 days is the upper bound on "best streak in
# the last year"; in practice loop exits long before that on any user
# with normal log gaps.
SCAN_WINDOW_DAYS = 365
# One grace day per streak — see module docstring.
GRACE_DAYS = 1


@dataclass(frozen=True)
class StreakState:
    kind: str            # "workout" | "meal" | "readiness"
    current: int         # current consecutive days
    best: int            # longest streak in the scan window
    last_logged: date | None
    today_logged: bool   # did today's signal already arrive?

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "current": self.current,
            "best": self.best,
            "last_logged": self.last_logged.isoformat() if self.last_logged else None,
            "today_logged": self.today_logged,
        }


def _user_today(user_tz: str | None) -> date:
    """Resolve "today" in the user's local timezone when known."""
    if user_tz:
        try:
            from zoneinfo import ZoneInfo
            return datetime.now(ZoneInfo(user_tz)).date()
        except Exception:
            pass
    return datetime.now(timezone.utc).date()


def _streak_from_dates(active_dates: set[date], today: date) -> tuple[int, int, bool]:
    """Given a set of dates with the activity and a 'today' anchor,
    compute (current_streak, best_streak_in_window, today_logged).

    `current` allows up to `GRACE_DAYS` total misses within the streak
    so a single missed day doesn't reset.
    """
    if not active_dates:
        return 0, 0, False

    today_logged = today in active_dates

    # Current streak — walk backwards from today (or yesterday if today
    # not yet logged), allowing GRACE_DAYS missed days inside the run.
    current = 0
    cursor = today if today_logged else today - timedelta(days=1)
    misses_used = 0
    while (today - cursor).days < SCAN_WINDOW_DAYS:
        if cursor in active_dates:
            current += 1
        else:
            if misses_used < GRACE_DAYS:
                misses_used += 1
            else:
                break
        cursor -= timedelta(days=1)

    # Best streak in the window — same grace rule, sliding scan.
    best = 0
    run = 0
    misses_used = 0
    sorted_window: list[date] = []
    start = today - timedelta(days=SCAN_WINDOW_DAYS - 1)
    d = start
    while d <= today:
        sorted_window.append(d)
        d += timedelta(days=1)

    # Reset miss tracking per consecutive block. A block boundary is two
    # adjacent missed days. (We can be cleverer — but 365 iterations × O(1)
    # is fine.)
    for day_ in sorted_window:
        if day_ in active_dates:
            run += 1
        else:
            # Allow one grace miss before breaking the run.
            if run > 0 and misses_used < GRACE_DAYS:
                misses_used += 1
            else:
                if run > best:
                    best = run
                run = 0
                misses_used = 0
    if run > best:
        best = run
    best = max(best, current)

    return current, best, today_logged


def _workout_dates(db: Any, user_id: int, since: date) -> set[date]:
    rows = db.exec(
        select(WorkoutCompletion.workout_date)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= since)
    ).all()
    out: set[date] = set()
    for r in rows:
        # `db.exec(select(scalar))` returns tuples on some sqlmodel versions.
        d = r if isinstance(r, date) else getattr(r, "workout_date", None)
        if d is not None:
            out.add(d)
    return out


def _meal_dates(db: Any, user_id: int, since: date) -> set[date]:
    rows = db.exec(
        select(Meal.meal_date)
        .where(Meal.user_id == user_id)
        .where(Meal.meal_date >= since)
    ).all()
    out: set[date] = set()
    for r in rows:
        d = r if isinstance(r, date) else getattr(r, "meal_date", None)
        if d is not None:
            out.add(d)
    return out


def _readiness_dates(db: Any, user_id: int, since: date) -> set[date]:
    """Treat a check-in as anything that touched WeeklyCheckIn in the
    window. The daily micro-checkin signal lives in UserCoachingState
    when shipped; once that's reliably written per-day, add it here.
    """
    try:
        rows = db.exec(
            select(WeeklyCheckIn.checkin_date)
            .where(WeeklyCheckIn.user_id == user_id)
            .where(WeeklyCheckIn.checkin_date >= since)
        ).all()
    except Exception:
        return set()
    out: set[date] = set()
    for r in rows:
        d = r if isinstance(r, date) else getattr(r, "checkin_date", None)
        if d is not None:
            out.add(d)
    return out


def compute_streaks(db: Any, user_id: int, *, user_tz: str | None = None) -> list[StreakState]:
    today = _user_today(user_tz)
    since = today - timedelta(days=SCAN_WINDOW_DAYS - 1)

    workout = _workout_dates(db, user_id, since)
    meal = _meal_dates(db, user_id, since)
    readiness = _readiness_dates(db, user_id, since)

    def _build(kind: str, dates: set[date]) -> StreakState:
        current, best, today_logged = _streak_from_dates(dates, today)
        last_logged = max(dates) if dates else None
        return StreakState(
            kind=kind,
            current=current,
            best=best,
            last_logged=last_logged,
            today_logged=today_logged,
        )

    return [
        _build("workout", workout),
        _build("meal", meal),
        _build("readiness", readiness),
    ]
