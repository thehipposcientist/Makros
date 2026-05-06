"""Build PlannerInputs plus history sidecars for PlanWeek flows."""
from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session

from app.services.workout.equipment import resolve_owned_equipment_slugs
from app.services.workout.planner import PlannerInputs


@dataclass(frozen=True)
class PlannerBuildContext:
    inputs: PlannerInputs
    history_familiarity: dict[str, int]
    recent_muscle_exercises: dict[str, set[str]]


def active_injury_tokens(profile: object | None, prefs: object | None) -> list[str]:
    tokens: list[str] = []
    seen: set[str] = set()
    for source in (getattr(profile, "injuries", None), getattr(prefs, "injuries", None)):
        if isinstance(source, str):
            values = [source]
        elif isinstance(source, list):
            values = source
        else:
            values = []
        for raw in values:
            token = str(raw or "").strip()
            if not token:
                continue
            key = token.lower()
            if key in seen:
                continue
            seen.add(key)
            tokens.append(token)
    return tokens


def _resting_hr_int(value: float | int | None) -> int | None:
    if value is None:
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return None


def build_planweek_planner_context(
    db: Session,
    user_id: int,
    profile: object,
    prefs: object | None,
    *,
    goal: str,
    days_per_week: int,
    preferred_split: str | None,
    session_minutes: int | None = None,
    cycle_phase: str | None = None,
    day_of_cycle: int | None = None,
    avg_resting_hr: float | int | None = None,
) -> PlannerBuildContext:
    from app.services.workout.activity_impact import compute_rolling_fatigue
    from app.services.workout.history import (
        build_history_familiarity,
        get_recent_completions_for_fatigue,
        most_recent_completed_focus,
        recent_exercise_slugs_by_muscle,
    )

    resolved_session_minutes = int(
        session_minutes
        or getattr(prefs, "workout_duration_minutes", None)
        or getattr(profile, "workout_duration_minutes", 45)
        or 45
    )
    equipment = list(getattr(prefs, "equipment", None) or getattr(profile, "equipment", []) or [])
    owned_slugs = resolve_owned_equipment_slugs(equipment)
    injuries = active_injury_tokens(profile, prefs)
    disliked = list(getattr(prefs, "disliked_exercises", []) or [])

    recent_focus_buckets: tuple[str, ...] = ()
    recent_focus_families: tuple[str, ...] = ()
    try:
        buckets, families = most_recent_completed_focus(user_id, db, hours=240, limit=10)
        recent_focus_buckets = tuple(buckets)
        recent_focus_families = tuple(families)
    except Exception:
        pass

    muscle_fatigue = None
    try:
        completions = get_recent_completions_for_fatigue(user_id, db)
        if completions:
            snapshot = compute_rolling_fatigue(completions)
            muscle_fatigue = snapshot.muscle_fatigue.to_dict() if snapshot else None
    except Exception:
        pass

    try:
        history_familiarity = build_history_familiarity(user_id, db)
    except Exception:
        history_familiarity = {}
    try:
        recent_muscle_exercises = recent_exercise_slugs_by_muscle(user_id, db)
    except Exception:
        recent_muscle_exercises = {}

    inputs = PlannerInputs(
        goal=goal,
        days_per_week=int(days_per_week),
        session_minutes=resolved_session_minutes,
        experience=str(getattr(profile, "experience_level", "intermediate") or "intermediate").lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=preferred_split,
        injuries=tuple(injuries),
        disliked_exercises=tuple(disliked),
        rng_seed=user_id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=muscle_fatigue,
        resting_hr=_resting_hr_int(avg_resting_hr),
        cycle_phase=cycle_phase,
        day_of_cycle=day_of_cycle,
        cardio_baseline=getattr(prefs, "cardio_baseline", None),
        load_equipment_settings=getattr(prefs, "equipment_settings", None),
    )
    return PlannerBuildContext(
        inputs=inputs,
        history_familiarity=history_familiarity,
        recent_muscle_exercises=recent_muscle_exercises,
    )
