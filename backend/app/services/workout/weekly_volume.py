"""Weekly volume-by-muscle-group tracker.

Counts hard sets per muscle group per week from completed `ExerciseSet`
rows, joined through `WorkoutExercise` and `Exercise` for the muscle
tag. Secondary-muscle contributions are weighted at 0.5x since a
primary-muscle set is a stronger stimulus than being a synergist.

Used by:
  - `plan_review_v2.py` — decide whether volume is high/low/balanced per
    muscle and suggest targeted plan changes.
  - Weekly digest — "This week: chest 14, back 18, legs 9".
  - Coach context — feeds AI prompts without needing a live AI call.

Pure function — no AI, no side effects. Just reads the tables. Callers
decide how to render or act on the result.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.enums import MuscleGroup
from app.models import Exercise, ExerciseSet, WorkoutExercise, WorkoutSession


# Evidence-based "healthy" weekly hard-set ranges per muscle group.
# Pulled from hypertrophy research (Schoenfeld et al.) + strength-
# training consensus; middle of the range targets 10-15 hard sets for
# major muscles. These are ADVISORY — downstream code shouldn't treat
# them as hard limits, just as "low" / "in range" / "high" thresholds
# for recommendations. Skipped muscles (systemic, cardio) omitted.
WEEKLY_RANGES: dict[str, tuple[int, int]] = {
    "chest":       (8, 18),
    "back":        (10, 20),
    "shoulders":   (8, 16),
    "biceps":      (6, 14),
    "triceps":     (6, 14),
    "quads":       (8, 18),
    "hamstrings":  (6, 14),
    "glutes":      (6, 14),
    "calves":      (4, 12),
    "core":        (4, 12),
}


@dataclass
class MuscleVolume:
    """Hard-set count summary for a single muscle group."""
    muscle: str
    primary_sets: float
    secondary_sets: float
    total_sets: float          # primary + 0.5 * secondary
    # "undertrained" | "in_range" | "high" | "excessive" | "spike" | "unknown"
    # "spike" is a 28d-vs-prior-7d detector — separate flag layered on
    # top so UIs can show a warning even when absolute volume is fine.
    status: str
    range_min: int | None
    range_max: int | None
    # 28-day context so the UI can show "this week vs your baseline".
    avg_sets_prior_weeks: float = 0.0
    spike_ratio: float = 1.0     # this-week-sets / avg-prior-weeks-sets

    def to_dict(self) -> dict:
        return {
            "muscle": self.muscle,
            "primary_sets": round(self.primary_sets, 1),
            "secondary_sets": round(self.secondary_sets, 1),
            "total_sets": round(self.total_sets, 1),
            "status": self.status,
            "range_min": self.range_min,
            "range_max": self.range_max,
            "avg_sets_prior_weeks": round(self.avg_sets_prior_weeks, 1),
            "spike_ratio": round(self.spike_ratio, 2),
        }


@dataclass
class WeeklyVolumeSnapshot:
    """Full week-window rollup of per-muscle hard-set counts."""
    user_id: int
    window_start: date
    window_end: date
    total_hard_sets: float
    sessions_counted: int
    by_muscle: dict[str, MuscleVolume] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "window_start": str(self.window_start),
            "window_end": str(self.window_end),
            "total_hard_sets": round(self.total_hard_sets, 1),
            "sessions_counted": self.sessions_counted,
            "by_muscle": {k: v.to_dict() for k, v in self.by_muscle.items()},
        }

    def muscles_low(self) -> list[str]:
        return [m for m, v in self.by_muscle.items() if v.status == "low"]

    def muscles_high(self) -> list[str]:
        return [m for m, v in self.by_muscle.items() if v.status == "high"]


def _classify(muscle: str, total_sets: float, spike_ratio: float = 1.0) -> tuple[str, int | None, int | None]:
    """Classify a set count against evidence-based ranges + recent-week
    comparison. "unknown" for muscles we don't range (systemic, cardio).

    Status tiers:
      - undertrained: below the lower bound.
      - in_range:     between lo and hi.
      - high:         above hi but within 1.5x of it.
      - excessive:    above 1.5x hi — real injury + overreach risk.
      - spike:        1.5x+ jump from 28d baseline, regardless of absolute.
                      Takes precedence over `high` for recent increases so
                      users see the right framing (ramp too fast).
    """
    rng = WEEKLY_RANGES.get(muscle)
    if rng is None:
        return "unknown", None, None
    lo, hi = rng
    # Spike check first — big week-over-week jumps are the strongest
    # early signal of overreach, even when absolute volume is OK.
    # Only flag as spike when baseline is non-trivial (avoid noise on
    # muscles that went from 2→4 sets, which is just "ramping in").
    if spike_ratio >= 1.5 and total_sets >= lo:
        return "spike", lo, hi
    if total_sets < lo:
        return "undertrained", lo, hi
    if total_sets > hi * 1.5:
        return "excessive", lo, hi
    if total_sets > hi:
        return "high", lo, hi
    return "in_range", lo, hi


def compute_weekly_volume(
    db: Any,
    user_id: int,
    *,
    end_date: date | None = None,
    days: int = 7,
) -> WeeklyVolumeSnapshot:
    """Compute hard-set counts per muscle group over the last `days`
    days ending on `end_date` (default today).

    Only counts sets where `completed=True` AND `set_type != 'warmup'`.
    Missing set_type is treated as a working set (historically most
    rows don't stamp it).
    """
    if end_date is None:
        end_date = date.today()
    start = end_date - timedelta(days=days - 1)

    # Pull completed sessions in the window. Using WorkoutSession (the
    # authoritative record of a Thallo-logged session) rather than
    # WorkoutCompletion (coarser upsert row) because we need to join
    # through to the granular set rows.
    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= start)
        .where(WorkoutSession.workout_date <= end_date)
    ).all()

    if not sessions:
        return WeeklyVolumeSnapshot(
            user_id=user_id,
            window_start=start,
            window_end=end_date,
            total_hard_sets=0,
            sessions_counted=0,
            by_muscle={},
        )

    session_ids = [s.id for s in sessions if s.id is not None]
    if not session_ids:
        return WeeklyVolumeSnapshot(
            user_id=user_id, window_start=start, window_end=end_date,
            total_hard_sets=0, sessions_counted=len(sessions), by_muscle={},
        )

    # Single JOIN: WorkoutExercise + Exercise + ExerciseSet — collapses three
    # round-trips into one query. Rows are (we_id, primary_muscle,
    # secondary_muscles, set.completed, set.set_type).
    joined_rows = db.exec(
        select(
            WorkoutExercise.id,
            Exercise.primary_muscle,
            Exercise.secondary_muscles,
            ExerciseSet.completed,
            ExerciseSet.set_type,
        )
        .join(Exercise, WorkoutExercise.exercise_id == Exercise.id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .where(WorkoutExercise.session_id.in_(session_ids))
    ).all()

    # Build we_muscle map and accumulate counts in a single pass.
    we_muscle: dict[int, tuple[str, list[str]]] = {}
    primary_counts: dict[str, float] = defaultdict(float)
    secondary_counts: dict[str, float] = defaultdict(float)
    total_hard_sets = 0.0

    for we_id, pm, sm, completed, set_type in joined_rows:
        # Build muscle map lazily on first encounter for this workout_exercise.
        if we_id not in we_muscle:
            prim_str = (pm.value if hasattr(pm, "value") else str(pm)).lower()
            sec_list: list[str] = []
            for s in (sm or []):
                sec_list.append((str(s.value) if hasattr(s, "value") else str(s)).lower())
            we_muscle[we_id] = (prim_str, sec_list)

        if not completed:
            continue
        st = (set_type or "working").lower()
        if st in ("warmup", "warm_up", "mobility", "recovery"):
            continue

        prim_str, sec_list = we_muscle[we_id]
        primary_counts[prim_str] += 1.0
        total_hard_sets += 1.0
        for sec in sec_list:
            secondary_counts[sec] += 0.5

    if not we_muscle:
        return WeeklyVolumeSnapshot(
            user_id=user_id, window_start=start, window_end=end_date,
            total_hard_sets=0, sessions_counted=len(sessions), by_muscle={},
        )

    # 28-day baseline lookup for spike detection. We average the prior
    # 3 weeks (days -28 to -7) and compare this week against that. If
    # this week is 1.5x+ the average, flag `spike`.
    baseline_by_muscle = _compute_prior_weeks_avg(
        db, user_id, end_date=start - timedelta(days=1), weeks=3,
    )

    # Build per-muscle MuscleVolume objects for every muscle that has
    # either primary or secondary contribution. Classify against the
    # evidence-based range + spike ratio.
    all_muscles = set(primary_counts.keys()) | set(secondary_counts.keys())
    by_muscle: dict[str, MuscleVolume] = {}
    for m in all_muscles:
        primary = primary_counts.get(m, 0.0)
        secondary = secondary_counts.get(m, 0.0)
        total = primary + secondary
        baseline = baseline_by_muscle.get(m, 0.0)
        # Guard against div-by-zero; if baseline is zero (first time
        # training this muscle) we treat spike ratio as 1.0 to avoid
        # flagging genuine ramp-ins as overreach.
        ratio = (total / baseline) if baseline >= 2.0 else 1.0
        status, lo, hi = _classify(m, total, spike_ratio=ratio)
        by_muscle[m] = MuscleVolume(
            muscle=m,
            primary_sets=primary,
            secondary_sets=secondary,
            total_sets=total,
            status=status,
            range_min=lo,
            range_max=hi,
            avg_sets_prior_weeks=baseline,
            spike_ratio=ratio,
        )

    return WeeklyVolumeSnapshot(
        user_id=user_id,
        window_start=start,
        window_end=end_date,
        total_hard_sets=total_hard_sets,
        sessions_counted=len(sessions),
        by_muscle=by_muscle,
    )


def _compute_prior_weeks_avg(
    db: Any,
    user_id: int,
    *,
    end_date: date,
    weeks: int = 3,
) -> dict[str, float]:
    """Average weekly primary-set count per muscle over the prior N
    weeks. Used only for spike detection — secondary sets excluded to
    keep the baseline comparable to the current-week primary focus.

    Intentionally a simple mean, not a trend or EMA — this is a
    baseline, not a forecast."""
    start = end_date - timedelta(days=weeks * 7 - 1)
    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= start)
        .where(WorkoutSession.workout_date <= end_date)
    ).all()
    if not sessions:
        return {}
    session_ids = [s.id for s in sessions if s.id is not None]
    if not session_ids:
        return {}
    # Single JOIN: replaces 3 round-trips
    rows = db.exec(
        select(
            WorkoutExercise.id,
            Exercise.primary_muscle,
            ExerciseSet.completed,
            ExerciseSet.set_type,
        )
        .join(Exercise, WorkoutExercise.exercise_id == Exercise.id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .where(WorkoutExercise.session_id.in_(session_ids))
    ).all()
    we_muscle: dict[int, str] = {}
    totals: dict[str, float] = {}
    for we_id, pm, completed, set_type in rows:
        if we_id not in we_muscle:
            we_muscle[we_id] = (pm.value if hasattr(pm, "value") else str(pm)).lower()
        if not completed:
            continue
        st = (set_type or "working").lower()
        if st in ("warmup", "warm_up", "mobility", "recovery"):
            continue
        m = we_muscle[we_id]
        totals[m] = totals.get(m, 0.0) + 1.0
    return {m: v / weeks for m, v in totals.items()}


def compute_multi_window_volume(
    db: Any,
    user_id: int,
    *,
    end_date: date | None = None,
) -> dict[str, Any]:
    """Convenience: 7-day + 14-day + 28-day snapshots in one call.

    Useful for the weekly coaching card which shows "this week vs
    last 2 weeks vs last month" trend badges."""
    return {
        "last_7d": compute_weekly_volume(db, user_id, end_date=end_date, days=7).to_dict(),
        "last_14d": compute_weekly_volume(db, user_id, end_date=end_date, days=14).to_dict(),
        "last_28d": compute_weekly_volume(db, user_id, end_date=end_date, days=28).to_dict(),
    }
