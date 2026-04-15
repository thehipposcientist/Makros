"""Cardio classification — single source of truth for interval vs. steady.

The seed data doesn't carry an explicit `cardio_intensity` field. The
previous planner code inferred intervals-vs-steady from
`exercise.get("is_compound")` in multiple places (scoring, prescription,
recipe generation). That inference was quietly load-bearing AND
scattered across files, so a change to the seed's `is_compound`
semantics could regress cardio behavior in surprising ways.

This module isolates the inference in one place. Everywhere else in
the planner that needs to ask "is this a hard interval exercise?"
calls `classify_cardio()` instead of reading `is_compound` directly.

If and when the seed grows an explicit `cardio_intensity` field, the
only change needed is here — all call sites keep working unchanged.
"""
from __future__ import annotations

from typing import Literal


CardioIntensity = Literal["intervals", "steady", "easy", "not_cardio"]


# Keywords in exercise names that strongly signal intervals regardless
# of the `is_compound` flag. Used as a secondary check so something
# named "HIIT Circuit" classifies correctly even if the seed flag
# doesn't agree.
_INTERVAL_KEYWORDS = (
    "interval", "hiit", "sprint", "hill", "tabata",
)

# Keywords that signal explicitly easy / conversational cardio.
_EASY_KEYWORDS = (
    "walk", "jog", "easy", "zone 2", "zone2", "recovery",
)


def classify_cardio(exercise: dict) -> CardioIntensity:
    """Return the cardio intensity bucket for one exercise.

    Decision order:
      1. If the exercise isn't cardio at all, return `"not_cardio"`.
      2. Name pattern: "interval" / "hiit" / "sprint" / "hill" /
         "tabata" → `"intervals"`.
      3. Name pattern: "walk" / "jog" / "easy" / "zone 2" / "recovery"
         → `"easy"`.
      4. Fallback: the seed's `is_compound` flag is used as the last
         resort — the seed uses it as an interval indicator
         (`treadmill_intervals=True`, `treadmill_run=False`). This
         stays inside this module so nothing else depends on it.
      5. Otherwise `"steady"`.

    This helper is intentionally small and keyword-driven. If the
    seed grows an explicit `cardio_intensity` field, replace this
    body and every call site keeps working."""
    if not _is_cardio_row(exercise):
        return "not_cardio"

    name = (exercise.get("name") or "").lower()

    # Explicit name signals win over the compound flag.
    for kw in _INTERVAL_KEYWORDS:
        if kw in name:
            return "intervals"
    for kw in _EASY_KEYWORDS:
        if kw in name:
            return "easy"

    # Fallback to the seed's is_compound flag.
    if exercise.get("is_compound"):
        return "intervals"
    return "steady"


def is_interval_cardio(exercise: dict) -> bool:
    """Convenience: `classify_cardio(ex) == 'intervals'`."""
    return classify_cardio(exercise) == "intervals"


def is_easy_cardio(exercise: dict) -> bool:
    """Convenience: easy-intensity cardio (jogging, walking, zone 2).
    Steady-state exercises don't count — only explicitly easy ones."""
    return classify_cardio(exercise) == "easy"


def _is_cardio_row(exercise: dict) -> bool:
    """A row is cardio if it declares cardio movement pattern OR
    exercise type. The planner uses this same check in a couple
    places (filter + score + prescription), so centralize it."""
    return (
        exercise.get("movement_pattern") == "cardio"
        or exercise.get("exercise_type") == "cardio"
    )
