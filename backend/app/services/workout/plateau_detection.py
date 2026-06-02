"""Plateau detection — flag exercises whose peak estimated 1RM has been
flat for ``window_weeks`` weeks.

Algorithm:
  1. Read every completed ``ExerciseSet`` for the user across the
     ``window_weeks + 1`` calendar weeks (we need N complete weeks of
     data; a partial current week alone can't plateau).
  2. Group sets by exercise name (case-insensitive), then by ISO week.
     Per (exercise, week), compute the best Epley 1RM.
  3. An exercise plateaus when the last ``window_weeks`` weeks all
     have a peak 1RM AND the spread (max-min)/avg <= 2%.

Suggestion:
  - ``deload`` — all weeks inside the band AND the most recent week's
    volume (total sets with weight > 0) is at or above median → the user
    is pushing hard but not progressing, a deload is the standard answer.
  - ``add_volume`` — the user's weekly-peak volume is below the median
    → they aren't getting enough stimulus, ADD sets.
  - ``swap`` — the exercise has been flat for ``window_weeks + 2`` or
    more (i.e. it's been a while) → time to try a different movement.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import func
from sqlmodel import Session, select

from .pr_detection import epley_1rm


def _iso_week_key(d: date) -> str:
    """Return ``YYYY-Wxx`` for a date."""
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _weekly_peaks_for_user(
    user_id: int,
    db: Session,
    *,
    lookback_weeks: int,
    today: date | None = None,
) -> dict[str, dict[str, dict]]:
    """Return ``{exercise_name_lower: {iso_week: {peak_1rm, volume_sets}}}``
    for every completed set the user logged in the lookback window.

    ``today`` is honored so tests can pin a date — defaults to the real
    calendar today otherwise. Without this, tests with fixed historical
    dates fail once the test was authored long enough ago that the wall
    clock has moved past the cutoff.
    """
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet

    today = today or date.today()
    cutoff = today - timedelta(weeks=lookback_weeks + 1)  # +1 buffer for partial weeks
    rows = db.exec(
        select(
            WorkoutExercise.name,
            ExerciseSet.actual_weight_lbs,
            ExerciseSet.actual_reps,
            WorkoutSession.workout_date,
        )
        .join(WorkoutExercise, WorkoutExercise.id == ExerciseSet.workout_exercise_id)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= cutoff)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    ).all()

    result: dict[str, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"peak_1rm": 0.0, "volume_sets": 0, "display_name": None}))
    for name, weight, reps, wdate in rows:
        if not name or wdate is None:
            continue
        w = float(weight or 0)
        r = int(reps or 0)
        if w <= 0 or r <= 0:
            continue
        key = name.strip().lower()
        wk = _iso_week_key(wdate)
        bucket = result[key][wk]
        bucket["display_name"] = bucket["display_name"] or name
        est = epley_1rm(w, r)
        if est > bucket["peak_1rm"]:
            bucket["peak_1rm"] = est
        bucket["volume_sets"] += 1
    return result


def _recent_weeks(today: date, count: int) -> list[str]:
    """Return the last ``count`` ISO-week strings ending on the week of
    ``today`` (exclusive of the partial current week). Sorted oldest-first."""
    weeks: list[str] = []
    cur = today - timedelta(days=today.weekday() + 1)  # last Sunday
    for i in range(count):
        weeks.append(_iso_week_key(cur - timedelta(weeks=(count - 1 - i))))
    return weeks


def _is_flat(peaks: list[float], tolerance_pct: float = 2.0) -> bool:
    """True when every peak is within ``tolerance_pct`` of the series
    average. Empty / single-item series return False."""
    if len(peaks) < 2:
        return False
    avg = sum(peaks) / len(peaks)
    if avg <= 0:
        return False
    tol = avg * (tolerance_pct / 100.0)
    return (max(peaks) - min(peaks)) <= tol * 2  # total spread within ±tolerance


def detect_plateaus(
    user_id: int,
    *,
    db: Session,
    window_weeks: int = 4,
    today: date | None = None,
) -> list[dict]:
    """Return a list of exercises the user is plateaued on.

    Each entry shape:
        {
          "exercise_name": str,
          "current_1rm": float,
          "weeks_stuck": int,
          "suggestion": "deload" | "swap" | "add_volume",
          "peak_by_week": [float, ...],  # oldest → newest
        }

    Exercises with < ``window_weeks`` weeks of history are skipped
    (insufficient data → cannot plateau).
    """
    today = today or date.today()
    weekly = _weekly_peaks_for_user(user_id, db, lookback_weeks=window_weeks + 2, today=today)
    target_weeks = _recent_weeks(today, window_weeks)

    plateaued: list[dict] = []
    for name_key, by_week in weekly.items():
        peaks = [by_week.get(wk, {}).get("peak_1rm", 0.0) for wk in target_weeks]
        # Every target week needs data — a gap means we don't have enough
        # history to declare a plateau.
        if any(p <= 0 for p in peaks):
            continue
        if not _is_flat(peaks):
            continue
        # Suggestion policy
        # Compute weekly volume (set count with weight > 0) across the SAME
        # target weeks to decide deload vs add_volume.
        vols = [by_week.get(wk, {}).get("volume_sets", 0) for wk in target_weeks]
        sorted_v = sorted(vols)
        median_v = sorted_v[len(sorted_v) // 2]
        recent_v = vols[-1]
        suggestion = "deload" if recent_v >= median_v else "add_volume"
        # If this exercise has been flat for longer than window_weeks+2,
        # suggest swapping instead — a long plateau means the movement has
        # run its course.
        extended_weeks = _recent_weeks(today, window_weeks + 2)
        extended_peaks = [by_week.get(wk, {}).get("peak_1rm", 0.0) for wk in extended_weeks]
        if all(p > 0 for p in extended_peaks) and _is_flat(extended_peaks):
            suggestion = "swap"

        display_name = None
        for wk in target_weeks:
            dn = by_week.get(wk, {}).get("display_name")
            if dn:
                display_name = dn
        display_name = display_name or name_key.title()

        plateaued.append({
            "exercise_name": display_name,
            "current_1rm": round(peaks[-1], 2),
            "weeks_stuck": len(peaks),
            "suggestion": suggestion,
            "peak_by_week": [round(p, 2) for p in peaks],
        })
    # Sort by current 1RM descending so the biggest lifts surface first.
    plateaued.sort(key=lambda p: -p["current_1rm"])
    return plateaued
