"""PR (personal record) detection service.

Called from the completion path after a WorkoutSession + ExerciseSet rows
are written. Walks the just-saved sets and compares each to the user's
historical best for the same exercise name (case-insensitive).

Three classes of PR are tracked, each surfaced separately:

  1. ``heaviest_weight`` — new max `actual_weight_lbs` for any completed
     set of that exercise (reps ≥ 1).
  2. ``estimated_1rm`` — new max Epley 1RM estimate
     (``weight * (1 + reps/30)``), so hitting the same weight for more
     reps still earns a PR.
  3. ``volume_record`` — new max single-set volume (``weight * reps``),
     which rewards beating the best one-set tonnage.

Each achievement carries the old value so the client can render deltas.
The helper is pure / side-effect-free apart from the DB reads it needs
for historical comparison. It does NOT write anything — the caller is
responsible for stamping the session / returning the payload.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Iterable

from sqlalchemy import func
from sqlmodel import Session, select


def epley_1rm(weight_lbs: float, reps: int) -> float:
    """Epley 1RM estimate. Returns 0 for invalid inputs.

    Intentionally does NOT take RIR — PR detection is "did this raw set
    exceed the prior best raw set?" Reading RIR here would make a 2-RIR
    set with the same weight+reps appear to PR over a true-failure set,
    which is the opposite of what users mean by a PR. The
    rolling-e1RM / prescription path uses RIR (and now caps effective
    reps + tracks RIR source); this function stays a clean raw-Epley
    so PR celebrations remain conservative."""
    if weight_lbs is None or reps is None:
        return 0.0
    try:
        w = float(weight_lbs)
        r = int(reps)
    except (TypeError, ValueError):
        return 0.0
    if w <= 0 or r <= 0:
        return 0.0
    return round(w * (1 + r / 30.0), 2)


@dataclass
class PRAchievement:
    exercise_name: str
    kind: str  # "heaviest_weight" | "estimated_1rm" | "volume_record"
    new_value: float
    old_value: float
    set_id: int | None = None
    reps: int | None = None
    weight_lbs: float | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _iter_user_sets(user_id: int, db: Session, *, exclude_session_id: int | None = None):
    """Yield every completed set for this user across all prior sessions.

    Returns tuples of (exercise_name_lower, actual_weight_lbs, actual_reps).
    We read straight off `ExerciseSet` → `WorkoutExercise` → `WorkoutSession`
    so the name match is case-insensitive and robust to equipment variants
    (same exercise name = same PR bucket).
    """
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet

    stmt = (
        select(WorkoutExercise.name, ExerciseSet.actual_weight_lbs, ExerciseSet.actual_reps)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .where(WorkoutSession.user_id == user_id)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    )
    if exclude_session_id is not None:
        stmt = stmt.where(WorkoutSession.id != exclude_session_id)
    return db.exec(stmt).all()


def _best_historical_metrics(
    user_id: int,
    exercise_names: set[str],
    db: Session,
    *,
    exclude_session_id: int | None = None,
) -> dict[str, dict[str, float]]:
    """Return ``{lower_name: {heaviest, best_1rm, best_volume}}`` from
    every prior completed set across the user's history, EXCLUDING the
    current session so the just-saved sets can't count as their own
    "historical best".
    """
    wanted = {n.strip().lower() for n in exercise_names if n and n.strip()}
    if not wanted:
        return {}

    result: dict[str, dict[str, float]] = {}
    for name, weight, reps in _iter_user_sets(user_id, db, exclude_session_id=exclude_session_id):
        key = (name or "").strip().lower()
        if key not in wanted:
            continue
        bucket = result.setdefault(key, {"heaviest": 0.0, "best_1rm": 0.0, "best_volume": 0.0})
        w = float(weight or 0)
        r = int(reps or 0)
        if r < 1:
            continue
        if w > bucket["heaviest"]:
            bucket["heaviest"] = w
        one_rm = epley_1rm(w, r)
        if one_rm > bucket["best_1rm"]:
            bucket["best_1rm"] = one_rm
        vol = w * r
        if vol > bucket["best_volume"]:
            bucket["best_volume"] = vol
    return result


def detect_prs(user_id: int, session_id: int, db: Session) -> list[dict]:
    """Compare every completed set in ``session_id`` to the user's
    all-time best for the same exercise and return a list of PR dicts.

    Emits at most ONE PR per (exercise, kind) pair per call — if the
    user set a new heaviest weight across three sets of bench, only the
    top set is reported.

    Returns a list of ``PRAchievement.to_dict()`` payloads. Empty list
    when nothing improved (common path — most sessions are not PRs).
    """
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet

    session_row = db.get(WorkoutSession, session_id)
    if session_row is None or session_row.user_id != user_id:
        return []

    # Collect every completed set from the session along with its
    # canonical exercise name.
    rows = db.exec(
        select(
            ExerciseSet.id,
            ExerciseSet.actual_weight_lbs,
            ExerciseSet.actual_reps,
            WorkoutExercise.name,
        )
        .join(WorkoutExercise, WorkoutExercise.id == ExerciseSet.workout_exercise_id)
        .where(WorkoutExercise.session_id == session_id)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    ).all()

    if not rows:
        return []

    exercise_names = {r[3] for r in rows if r[3]}
    history_best = _best_historical_metrics(
        user_id, exercise_names, db, exclude_session_id=session_id,
    )

    # Track per-exercise per-kind best within this session so we report
    # the top set, not every incremental set that happened to beat the
    # prior-history baseline.
    best_per_exercise: dict[str, dict[str, dict]] = {}
    for set_id, weight, reps, ex_name in rows:
        if not ex_name:
            continue
        key = ex_name.strip().lower()
        w = float(weight or 0)
        r = int(reps or 0)
        if r < 1 or w <= 0:
            continue
        hist = history_best.get(key, {"heaviest": 0.0, "best_1rm": 0.0, "best_volume": 0.0})
        prev_heaviest = hist["heaviest"]
        prev_1rm = hist["best_1rm"]
        prev_volume = hist["best_volume"]
        one_rm = epley_1rm(w, r)
        volume = w * r

        bucket = best_per_exercise.setdefault(key, {})
        ex_display = ex_name  # keep original casing from the WorkoutExercise.name column

        if w > prev_heaviest:
            current = bucket.get("heaviest_weight")
            if current is None or w > current["new_value"]:
                bucket["heaviest_weight"] = PRAchievement(
                    exercise_name=ex_display,
                    kind="heaviest_weight",
                    new_value=round(w, 2),
                    old_value=round(prev_heaviest, 2),
                    set_id=int(set_id),
                    reps=r,
                    weight_lbs=round(w, 2),
                ).to_dict()

        if one_rm > prev_1rm:
            current = bucket.get("estimated_1rm")
            if current is None or one_rm > current["new_value"]:
                bucket["estimated_1rm"] = PRAchievement(
                    exercise_name=ex_display,
                    kind="estimated_1rm",
                    new_value=round(one_rm, 2),
                    old_value=round(prev_1rm, 2),
                    set_id=int(set_id),
                    reps=r,
                    weight_lbs=round(w, 2),
                ).to_dict()

        if volume > prev_volume:
            current = bucket.get("volume_record")
            if current is None or volume > current["new_value"]:
                bucket["volume_record"] = PRAchievement(
                    exercise_name=ex_display,
                    kind="volume_record",
                    new_value=round(volume, 2),
                    old_value=round(prev_volume, 2),
                    set_id=int(set_id),
                    reps=r,
                    weight_lbs=round(w, 2),
                ).to_dict()

    prs: list[dict] = []
    for bucket in best_per_exercise.values():
        for pr in bucket.values():
            prs.append(pr)
    return prs
