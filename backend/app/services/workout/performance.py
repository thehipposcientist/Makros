"""Per-user exercise performance profiles and plateau detection.

Reads completed workout history and produces a lightweight performance
profile for every canonical exercise the user has actually trained. The
profile is the shared input for both offline plan propagation
(`propagate_session_targets`) and the live `/recommend-weight`
endpoint — keeping both paths anchored on the same numbers.

Design notes
------------
- This module is deterministic. No LLM, no randomness, no network.
- "Recent" is a 28-day rolling window by default. Stale history is
  ignored so a user who took 6 weeks off doesn't start back at their
  all-time best.
- The profile captures enough detail that downstream code can
  reconstruct working-weight estimates (Epley 1RM → %1RM × target reps)
  without re-querying the DB.
- The plateau detector is intentionally simple and auditable: it
  compares top-set score across the last N sessions, and it returns
  one of four explicit actions. No regression models, no clustering.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
import re
from typing import Optional

from sqlalchemy import func


# How many days of history count as "recent". Longer windows drag stale
# numbers into the present; shorter windows throw away still-valid data.
# 28 days is one mesocycle.
DEFAULT_PERFORMANCE_WINDOW_DAYS = 28

# How many completed sessions we look at per exercise when scoring. Older
# sessions are still fetched for plateau detection but don't influence
# the top-set summary.
MAX_SESSIONS_PER_EXERCISE = 6


@dataclass
class ExercisePerformance:
    """Summary of a user's recent performance on one canonical exercise.

    All weights in lbs; dates in local date form. Every field is safe to
    serialize — this struct gets stamped onto plan exercises in some
    flows so the client can explain recommendations to the user."""
    slug: str
    name: str
    session_count: int              # completed sessions in window
    recent_top_weight_lbs: float    # heaviest working weight in window
    recent_top_reps: int            # reps achieved at that top weight
    estimated_1rm_lbs: float        # Epley 1RM from top set
    recent_volume_load: float       # Σ (weight × reps) across window
    last_performed_on: Optional[date]
    # 0–1 confidence that this profile is a good anchor. More sessions
    # = higher confidence, with a cap at MAX_SESSIONS_PER_EXERCISE.
    confidence: float
    source: str = "history"


def _epley_1rm(weight_lbs: float, reps: int) -> float:
    """Epley 1RM estimate. Cheap, stable, and the industry default.

    Formula: 1RM ≈ weight × (1 + reps/30). Accurate for reps ≤ 10;
    degrades above that (we still use it there as a best-effort anchor)."""
    if weight_lbs <= 0 or reps <= 0:
        return 0.0
    return round(weight_lbs * (1 + reps / 30.0), 1)


def _exercise_slug_fallback(name: str | None) -> str:
    if not name:
        return ""
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def _canonical_history_slug(
    *,
    canonical_slug: str | None,
    snapshot_slug: str | None,
    workout_name: str | None,
) -> str:
    if canonical_slug:
        return canonical_slug.strip()
    try:
        from app.services.workout.exercise_metadata import resolve_seed_exercise_slug
        resolved = resolve_seed_exercise_slug(workout_name, snapshot_slug)
        if resolved:
            return resolved
        resolved = resolve_seed_exercise_slug(workout_name, None)
        if resolved:
            return resolved
    except Exception:
        pass
    return (snapshot_slug or _exercise_slug_fallback(workout_name)).strip()


def build_performance_profile(
    user_id: int,
    db_session,
    *,
    window_days: int = DEFAULT_PERFORMANCE_WINDOW_DAYS,
    only_slugs: Optional[list[str]] = None,
) -> dict[str, ExercisePerformance]:
    """Return `{slug: ExercisePerformance}` for every exercise the user
    completed at least once in the last `window_days`.

    Joins `WorkoutSession` → `WorkoutExercise` → `ExerciseSet` and keys
    by `Exercise.slug`. Only completed sessions count
    (`WorkoutSession.completed_at is not None`) and only logged sets
    with `completed=True` and non-null reps/weight contribute to the
    numbers.

    Passing `only_slugs` narrows the result to a fixed list of canonical
    slugs — useful when a caller only cares about one or two exercises
    (e.g. the `/recommend-weight` endpoint).
    """
    from sqlmodel import select

    from app.models import Exercise, ExerciseSet, WorkoutExercise, WorkoutSession

    cutoff = date.today() - timedelta(days=window_days)

    query = (
        select(
            Exercise.slug,
            Exercise.name,
            WorkoutExercise.exercise_slug_snapshot,
            WorkoutExercise.name,
            WorkoutSession.workout_date,
            ExerciseSet.actual_weight_lbs,
            ExerciseSet.actual_reps,
        )
        .select_from(WorkoutExercise)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .outerjoin(Exercise, WorkoutExercise.exercise_id == Exercise.id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.completed_at.is_not(None))
        .where(WorkoutSession.workout_date >= cutoff)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(ExerciseSet.actual_weight_lbs.is_not(None))
        .where(ExerciseSet.actual_reps.is_not(None))
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    )
    if only_slugs:
        from sqlalchemy import or_

        query = query.where(or_(
            Exercise.slug.in_(only_slugs),
            WorkoutExercise.exercise_slug_snapshot.in_(only_slugs),
        ))

    rows = db_session.exec(query).all()

    # Aggregate per-slug. We track top set (max weight × reps, tie-break
    # by weight), total volume, session date set, and last-performed date.
    by_slug: dict[str, dict] = {}
    for canonical_slug, canonical_name, snapshot_slug, workout_name, workout_date, weight, reps in rows:
        slug = _canonical_history_slug(
            canonical_slug=canonical_slug,
            snapshot_slug=snapshot_slug,
            workout_name=workout_name,
        )
        name = canonical_name or workout_name or slug
        if not slug or weight is None or reps is None:
            continue
        w = float(weight)
        r = int(reps)
        bucket = by_slug.setdefault(slug, {
            "name": name or slug,
            "top_weight": 0.0,
            "top_reps": 0,
            "volume": 0.0,
            "session_dates": set(),
            "last_performed": None,
        })
        # Score the set by weight × reps so a PR at 5 reps beats a 3-rep
        # top set even if the 3-rep was heavier. Tie-break by weight.
        score = w * r
        top_score = bucket["top_weight"] * bucket["top_reps"]
        if score > top_score or (score == top_score and w > bucket["top_weight"]):
            bucket["top_weight"] = w
            bucket["top_reps"] = r
        bucket["volume"] += score
        bucket["session_dates"].add(workout_date)
        last = bucket["last_performed"]
        if last is None or workout_date > last:
            bucket["last_performed"] = workout_date

    profiles: dict[str, ExercisePerformance] = {}
    for slug, b in by_slug.items():
        session_count = min(len(b["session_dates"]), MAX_SESSIONS_PER_EXERCISE)
        # Confidence scales linearly to the cap then saturates. One
        # session → ~0.17, three → ~0.5, six+ → 1.0.
        confidence = round(session_count / MAX_SESSIONS_PER_EXERCISE, 2)
        profiles[slug] = ExercisePerformance(
            slug=slug,
            name=b["name"],
            session_count=session_count,
            recent_top_weight_lbs=round(b["top_weight"], 1),
            recent_top_reps=b["top_reps"],
            estimated_1rm_lbs=_epley_1rm(b["top_weight"], b["top_reps"]),
            recent_volume_load=round(b["volume"], 1),
            last_performed_on=b["last_performed"],
            confidence=confidence,
        )
    return profiles


_SIGNUP_BASELINE_SLUGS = {
    "bench_press": ("barbell_bench_press", "Barbell Bench Press"),
    "squat": ("barbell_squat", "Barbell Squat"),
    "deadlift": ("deadlift", "Deadlift"),
    "overhead_press": ("overhead_press", "Overhead Press"),
}


def _positive_float(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _positive_int(value) -> int | None:
    try:
        out = int(float(value))
    except (TypeError, ValueError):
        return None
    return out if out > 0 else None


def _baseline_lift_rows(raw: object) -> list[dict]:
    if isinstance(raw, dict):
        rows = raw.get("lifts") or []
    elif isinstance(raw, list):
        rows = raw
    else:
        rows = []
    return [r for r in rows if isinstance(r, dict)]


def build_strength_anchor_profiles_from_raw(
    raw: object,
    *,
    only_slugs: Optional[list[str]] = None,
) -> dict[str, ExercisePerformance]:
    """Return signup strength anchors from a raw preference payload."""
    rows = _baseline_lift_rows(raw)
    if not rows:
        return {}

    allowed = set(only_slugs or [])
    out: dict[str, ExercisePerformance] = {}
    for row in rows:
        key = str(row.get("key") or "").strip()
        slug = str(row.get("exercise_slug") or row.get("exerciseSlug") or "").strip()
        if not slug and key in _SIGNUP_BASELINE_SLUGS:
            slug = _SIGNUP_BASELINE_SLUGS[key][0]
        if not slug or (allowed and slug not in allowed):
            continue

        # Pull-ups/reps-only rows are useful profile context, but they do not
        # create a load anchor for the first-weight pipeline.
        weight = _positive_float(row.get("weight_lbs") or row.get("weightLbs"))
        reps = _positive_int(row.get("reps"))
        if weight is None or reps is None:
            continue

        default_name = _SIGNUP_BASELINE_SLUGS.get(key, (slug, slug))[1]
        name = str(row.get("name") or default_name)
        e1rm = _epley_1rm(weight, reps)
        if e1rm <= 0:
            continue
        out[slug] = ExercisePerformance(
            slug=slug,
            name=name,
            session_count=1,
            recent_top_weight_lbs=round(weight, 1),
            recent_top_reps=reps,
            estimated_1rm_lbs=e1rm,
            recent_volume_load=round(weight * reps, 1),
            last_performed_on=None,
            confidence=0.35,
            source="strength_anchor",
        )
    return out


def build_strength_anchor_profiles(
    user_id: int,
    db_session,
    *,
    only_slugs: Optional[list[str]] = None,
) -> dict[str, ExercisePerformance]:
    """Return signup strength anchors as ExercisePerformance objects.

    These are deliberately separate from `build_performance_profile` so
    progress charts and history-dependent features continue to represent
    real logged workouts only. Planning/live weight recommendation can merge
    these anchors when it wants better first-week loads.
    """
    from sqlmodel import select

    from app.models import UserPreferences

    prefs = db_session.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    raw = getattr(prefs, "strength_baselines", None) if prefs else None
    return build_strength_anchor_profiles_from_raw(raw, only_slugs=only_slugs)


def merge_strength_anchor_profiles(
    user_id: int,
    db_session,
    profiles: dict[str, ExercisePerformance] | None,
    strength_baselines: object | None = None,
) -> dict[str, ExercisePerformance]:
    """Return performance profiles with signup anchors filling gaps only."""
    merged = dict(profiles or {})
    try:
        anchors = build_strength_anchor_profiles_from_raw(strength_baselines) if strength_baselines is not None else {}
        if not anchors:
            anchors = build_strength_anchor_profiles(user_id, db_session)
    except Exception:
        return merged
    for slug, profile in anchors.items():
        merged.setdefault(slug, profile)
    return merged


# ─── Plateau detection ──────────────────────────────────────────────────────


@dataclass
class PlateauSignal:
    """Explicit plateau verdict for one exercise.

    `action` is one of:
      - "hold_chase_reps": keep load, push for more reps in the target range
      - "small_deload":    -10% load for one session, then rebuild
      - "swap_variation":  rotate to a close variation to break the rut
      - "reduce_volume":   drop one set so recovery catches up
      - None:              no plateau detected
    """
    is_plateau: bool
    sessions_stalled: int
    action: Optional[str]
    reason: str


def detect_plateau(
    user_id: int,
    db_session,
    slug: str,
    *,
    min_sessions: int = 3,
    window_days: int = DEFAULT_PERFORMANCE_WINDOW_DAYS * 2,
) -> PlateauSignal:
    """Return a plateau verdict for one canonical exercise.

    Plateau definition: the top-set score (weight × reps) in the most
    recent session is not strictly greater than the best top-set score
    from the previous `min_sessions - 1` sessions.

    Deliberately simple:
      - 3 stalled sessions → "hold_chase_reps" (rep progression first)
      - 4 stalled sessions → "swap_variation" (novelty stimulus)
      - 5+ stalled sessions → "small_deload" then rebuild
      - Always → "reduce_volume" fallback if the user has trained this
        exercise very frequently (high session count) without progress
    """
    from sqlmodel import select

    from app.models import Exercise, ExerciseSet, WorkoutExercise, WorkoutSession

    cutoff = date.today() - timedelta(days=window_days)

    rows = db_session.exec(
        select(
            WorkoutSession.workout_date,
            ExerciseSet.actual_weight_lbs,
            ExerciseSet.actual_reps,
        )
        .join(WorkoutExercise, WorkoutExercise.session_id == WorkoutSession.id)
        .join(Exercise, Exercise.id == WorkoutExercise.exercise_id)
        .join(ExerciseSet, ExerciseSet.workout_exercise_id == WorkoutExercise.id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.completed_at.is_not(None))
        .where(WorkoutSession.workout_date >= cutoff)
        .where(Exercise.slug == slug)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(ExerciseSet.actual_weight_lbs.is_not(None))
        .where(ExerciseSet.actual_reps.is_not(None))
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
        .order_by(WorkoutSession.workout_date.desc())
    ).all()

    # Collapse to (date, top_set_score). Multiple sets in one session
    # reduce to the best set.
    by_date: dict[date, float] = {}
    for d, w, r in rows:
        if w is None or r is None:
            continue
        score = float(w) * int(r)
        prev = by_date.get(d, 0.0)
        if score > prev:
            by_date[d] = score

    session_scores = sorted(by_date.items(), key=lambda kv: kv[0], reverse=True)
    if len(session_scores) < min_sessions:
        return PlateauSignal(
            is_plateau=False,
            sessions_stalled=0,
            action=None,
            reason="Not enough sessions to judge progress yet",
        )

    # Most recent session vs. best of the prior min_sessions-1 sessions.
    most_recent_score = session_scores[0][1]
    prior_window = session_scores[1:min_sessions]
    prior_best = max((s for _, s in prior_window), default=0.0)

    if most_recent_score > prior_best:
        return PlateauSignal(
            is_plateau=False,
            sessions_stalled=0,
            action=None,
            reason="Top-set score improved in the most recent session",
        )

    # Count how far back the stall goes — the current "top" score, walking
    # backward from the latest session, that's still equal or lower.
    stalled = 1
    anchor = session_scores[0][1]
    for _, s in session_scores[1:]:
        if s <= anchor:
            stalled += 1
            anchor = max(anchor, s)
        else:
            break

    if stalled >= 5:
        action = "small_deload"
        reason = f"{stalled} sessions without progress — reduce ~10% for one week, then rebuild"
    elif stalled >= 4:
        action = "swap_variation"
        reason = f"{stalled} sessions stalled — rotate to a close variation to break the rut"
    elif stalled >= 3:
        action = "hold_chase_reps"
        reason = f"Progress stalled for {stalled} sessions — hold the load and chase more reps in the target range"
    else:
        return PlateauSignal(
            is_plateau=False,
            sessions_stalled=stalled,
            action=None,
            reason="No plateau yet — keep going",
        )

    return PlateauSignal(
        is_plateau=True,
        sessions_stalled=stalled,
        action=action,
        reason=reason,
    )
