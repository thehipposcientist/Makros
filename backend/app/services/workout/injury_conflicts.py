"""Detect injury conflicts in an existing PlanWeek.

Used after a user adds a NEW active injury (from Edit Profile or chat
confirmation): the active 7-day plan was generated before the injury
was known, so upcoming days may still contain exercises whose movement
pattern is now blocked. This module finds those exercises so the UI
can warn and offer one-tap swaps. It never mutates state — purely a
detector.

Scope:
  • Only forward-looking days (today + future). Already-completed
    workouts are immutable history; we don't rewrite them.
  • Reads the same `_INJURY_MAP` the planner uses, via the
    structured-record path so severity matters: a `mild` shoulder
    injury only flags its direct aggravators, while a `severe` knee
    injury flags squat AND lunge AND adjacent family.
  • Each conflicting exercise is reported individually so the UI can
    swap them one at a time.
"""
from __future__ import annotations

from typing import Iterable

from app.services.workout.planner import (
    _injury_blocked_patterns,
    _blocked_patterns_from_structured,
)


def _extract_movement_pattern(exercise: dict) -> str:
    """The planner persists movement_pattern under several keys depending
    on which write path produced the row (planner, AI regenerate, hand-
    edit). Try them in order — the first non-empty wins."""
    for key in ("movement_pattern", "_movement_pattern", "pattern"):
        val = exercise.get(key)
        if val:
            return str(val)
    return ""


def detect_active_week_conflicts(
    plan_days: list[dict],
    *,
    structured_injuries: list[dict] | None = None,
    legacy_injuries: list[str] | None = None,
    today_index: int = 0,
) -> list[dict]:
    """Return one entry per exercise that conflicts with an injury.

    Each entry: {
        day_index: int,            # position in plan_days
        focus: str,                # day focus label (e.g. "Push")
        exercise_name: str,
        slug: str | None,
        movement_pattern: str,
        reason: str,               # short label, e.g. "vertical_press"
    }

    `today_index` lets the caller restrict the search to today + future
    days; days before that are skipped so a Wednesday injury doesn't
    flag Monday's already-completed bench press. Pass 0 to scan the
    whole week.

    The structured path is preferred when present (severity-aware).
    Legacy strings are unioned in for half-migrated profiles.
    """
    blocked: set[str] = set()
    if structured_injuries:
        blocked |= _blocked_patterns_from_structured(tuple(structured_injuries))
    if legacy_injuries:
        blocked |= _injury_blocked_patterns(tuple(legacy_injuries))
    if not blocked:
        return []

    out: list[dict] = []
    for idx, day in enumerate(plan_days):
        if idx < max(0, today_index):
            continue
        # plan_days items can be either {"workout": {...}} (PlanDay) or
        # {"focus": "...", "exercises": [...]} (planner output). Handle
        # both because both flow through the same conflict detector.
        workout = day.get("workout") if isinstance(day.get("workout"), dict) else day
        if not isinstance(workout, dict):
            continue
        focus = str(workout.get("focus") or "")
        for ex in (workout.get("exercises") or []):
            if not isinstance(ex, dict):
                continue
            mp = _extract_movement_pattern(ex)
            if not mp or mp not in blocked:
                continue
            out.append({
                "day_index": idx,
                "focus": focus,
                "exercise_name": str(ex.get("name") or ex.get("_slug") or "exercise"),
                "slug": ex.get("_slug") or ex.get("slug"),
                "movement_pattern": mp,
                "reason": mp,
            })
    return out


def summarize_conflicts(conflicts: Iterable[dict]) -> str:
    """Human-readable one-liner for use in client warnings."""
    items = list(conflicts)
    if not items:
        return ""
    if len(items) == 1:
        return f"{items[0]['exercise_name']} on day {items[0]['day_index'] + 1} conflicts with your injury."
    by_day: dict[int, list[str]] = {}
    for c in items:
        by_day.setdefault(c["day_index"], []).append(c["exercise_name"])
    parts = [f"day {idx + 1}: {', '.join(names)}" for idx, names in sorted(by_day.items())]
    return "Conflicts found — " + "; ".join(parts)
