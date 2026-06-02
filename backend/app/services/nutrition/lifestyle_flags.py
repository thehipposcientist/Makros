"""Lifestyle-pattern flags for trans fat, alcohol, and caffeine timing.

These complement `recovery_flags.py` but stay pure-function so callers
can use them at meal-log time, daily-rollup time, or in tests without
booting a DB session. Each helper:

  * Reads from a list of `MealItem`-shaped objects (or dicts) — never
    requires a session or queries.
  * Returns `None` when there is not enough data (unknown ≠ zero) —
    the caller is responsible for surfacing or hiding the message.
  * Returns a dict `{state, message, numbers}` when something is worth
    saying. The language is intentionally constructive, not alarmist.

The trans-fat flag fires only on values explicitly > 0. The alcohol
and caffeine helpers fire only when the data is actually present, so
a user who hasn't logged a stimulant column doesn't see a misleading
"caffeine looks low" message.

Used by:
  * `/meals/score` to attach a "lifestyle_notes" array (future wiring).
  * Insight services that want to surface a gentle nudge without
    promoting it to a full FlagState in the recovery pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from typing import Any, Iterable


@dataclass(frozen=True)
class LifestyleNote:
    """Lightweight insight payload — green/amber/info only."""
    key: str
    state: str            # "info" | "amber"
    message: str
    numbers: dict | None = None


# Caffeine cutoff: caffeine consumed after this hour (local time) is flagged
# as potentially affecting sleep. 14:00 local is the conservative cutoff
# used in most sleep-hygiene guidance — caffeine has a ~5–6 hour half-life.
LATE_DAY_CAFFEINE_CUTOFF_HOUR = 14


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f


def _safe_attr(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _parse_consumed_at(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def trans_fat_note(items: Iterable[Any]) -> LifestyleNote | None:
    """Sum trans-fat across items. Unknown is preserved as unknown — a meal
    log with all nulls returns None (we don't claim 0g unless source said so).

    Fires when total > 0. Language stays neutral per spec — trans fat is
    a "keep close to zero" target, not a hard alarm.
    """
    total = 0.0
    had_any_reported = False
    for it in items:
        v = _coerce_float(_safe_attr(it, "trans_fat_g"))
        if v is None:
            continue
        had_any_reported = True
        if v > 0:
            total += v
    if not had_any_reported:
        return None
    if total <= 0:
        return None
    return LifestyleNote(
        key="trans_fat",
        state="amber",
        message=(
            "This includes trans fat; keeping trans fat close to zero is "
            "generally a good target."
        ),
        numbers={"trans_fat_g_total": round(total, 2)},
    )


def alcohol_note(items: Iterable[Any]) -> LifestyleNote | None:
    """Surface a recovery-leaning note when alcohol is present. Avoids
    moralizing language per spec — frames it around sleep/recovery quality.
    """
    total = 0.0
    had_any_reported = False
    for it in items:
        v = _coerce_float(_safe_attr(it, "alcohol_g"))
        if v is None:
            continue
        had_any_reported = True
        if v > 0:
            total += v
    if not had_any_reported or total <= 0:
        return None
    return LifestyleNote(
        key="alcohol",
        state="info",
        message=(
            "Alcohol can reduce sleep quality and recovery even when "
            "calories fit your target."
        ),
        numbers={
            "alcohol_g_total": round(total, 2),
            # Standard drink ≈ 14 g pure ethanol (US definition).
            "standard_drinks": round(total / 14.0, 2),
        },
    )


def late_caffeine_note(
    items: Iterable[Any],
    *,
    cutoff_hour: int = LATE_DAY_CAFFEINE_CUTOFF_HOUR,
) -> LifestyleNote | None:
    """Flag caffeine consumed after `cutoff_hour` local time. Reads
    `caffeine_mg` and `consumed_at` from each item; meal-level
    `consumed_at` should be propagated down before calling.
    """
    late_total = 0.0
    saw_any_caffeine_with_time = False
    for it in items:
        mg = _coerce_float(_safe_attr(it, "caffeine_mg"))
        if mg is None or mg <= 0:
            continue
        when = _parse_consumed_at(_safe_attr(it, "consumed_at"))
        if when is None:
            continue
        saw_any_caffeine_with_time = True
        if when.hour >= cutoff_hour:
            late_total += mg
    if not saw_any_caffeine_with_time or late_total <= 0:
        return None
    return LifestyleNote(
        key="late_caffeine",
        state="info",
        message=(
            "Caffeine later in the day may affect sleep quality and "
            "next-day recovery."
        ),
        numbers={
            "late_caffeine_mg": round(late_total, 1),
            "cutoff_local_hour": cutoff_hour,
        },
    )


def collect_notes(items: Iterable[Any]) -> list[LifestyleNote]:
    """Run all three checks. Items can be passed once and consumed multiple
    times because we materialize the iterable here.
    """
    materialized = list(items)
    notes: list[LifestyleNote] = []
    for fn in (trans_fat_note, alcohol_note, late_caffeine_note):
        note = fn(materialized)
        if note is not None:
            notes.append(note)
    return notes


# Vitamin K + medication interaction caveat. Per spec we never recommend
# "increase vitamin K" without this caveat — services that produce
# vitamin-K guidance can append this string to their action text.
VITAMIN_K_MEDICATION_CAVEAT = (
    "If you take blood thinners, keep vitamin K intake consistent and "
    "discuss major diet changes with a clinician."
)


# Omega-3 phrasing per spec. Avoid the omega-6:3 ratio framing — push
# constructive food guidance instead.
OMEGA_3_LOW_INTAKE_NUDGE = (
    "Omega-3 intake looks low relative to overall unsaturated fat intake. "
    "Consider fatty fish, chia/flax, walnuts, or algae-based DHA/EPA."
)
