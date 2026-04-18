"""
History-aware helpers for the workout planner.

Two responsibilities, both intentionally small:

  1. CONTINUITY  — `build_history_familiarity` reads the user's recent
     completed sessions and returns a `{slug: appearances}` map. The
     planner's `score_candidate` already accepts this dict and adds a
     small bonus to candidates the user has done recently, so successful
     plans keep their core exercises across regenerations.

  2. SESSION-TO-SESSION TARGETS  — `propagate_session_targets` walks a
     freshly generated plan, finds the user's most recent completed
     performance for each exercise, and uses the existing
     `WorkoutProgressionEngine` math to set the next session's
     `target_weight_lbs` / progression action / reason.

The data access layer is a `HistoryLookup` callable so tests can inject
fake history and so `workout_planner.py` itself doesn't need to import
anything DB-related. Production callers pass `db_history_lookup(user_id,
db_session)` from this module.

Where historical workout data is read:
    - `WorkoutSession`   (table `workout_sessions`)  — gives `user_id`,
      `completed_at`, `workout_date`
    - `WorkoutExercise`  (table `workout_exercises`) — joins session →
      exercise via `exercise_id`
    - `ExerciseSet`      (table `exercise_sets`)     — `set_number`,
      `actual_reps`, `actual_weight_lbs`, `rpe`, `completed`
    - `Exercise`         (table `exercises`)         — joins on `slug`
      so the planner's `_slug` field can resolve to a `WorkoutExercise`.

Where it influences the new targets:
    - `recommend_next_session_load` reads the prior session's working
      sets, classifies each via `engine.score_set_against_target`, and
      applies a session-level double-progression rule (all sets at top
      of range → +increment, majority missed → −increment, otherwise
      hold). The output is mutated onto each exercise dict in the plan
      under `target_weight_lbs`, `progression_action`, `progression_reason`,
      plus `recommendation_source` / `recommendation_confidence` /
      `recommendation_reason` for transferred estimates.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Callable, Optional

from app.workout_progression import (
    EffortFeedback,
    ExerciseCategory,
    ExercisePrescription,
    PhaseType,
    PlannedSet,
    ProgressionPace,
    ProgressionPriority,
    SetResult,
    SetTarget,
    SetType,
    UserTrainingProfile,
    WorkoutContext,
    WorkoutFocus,
    WorkoutProgressionEngine,
)


# ─── Type aliases ────────────────────────────────────────────────────────────


# A function that returns the prior session's working sets for one
# exercise. Production passes `db_history_lookup(user_id, db_session)`;
# tests pass an in-memory dict-backed callable. Returning an empty list
# means "no history" and the propagator leaves the exercise untouched.
HistoryLookup = Callable[[str], list[SetResult]]


# ─── Layer 1 — Continuity (history familiarity) ──────────────────────────────


def build_history_familiarity(
    user_id: int,
    db_session,
    days: int = 21,
) -> dict[str, int]:
    """Return `{exercise_slug: appearances}` for the user's recent completed
    workouts. Used by `workout_planner.score_candidate` to bias selection
    toward continuity.

    A 21-day window covers ~3 weeks of training, which is the sweet spot
    for "recent enough that the user expects to keep doing this exercise"
    without locking in a long-stale plan forever.

    Reads from `WorkoutSession` joined to `WorkoutExercise` joined to
    `Exercise.slug`. Sessions without `completed_at` are excluded so an
    abandoned workout doesn't bias future plans.
    """
    # Lazy imports so this module can be imported by tests without
    # spinning up the SQLModel metadata.
    from sqlmodel import select

    from app.models import Exercise, WorkoutExercise, WorkoutSession

    cutoff = date.today() - timedelta(days=days)
    rows = db_session.exec(
        select(Exercise.slug)
        .join(WorkoutExercise, WorkoutExercise.exercise_id == Exercise.id)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.completed_at.is_not(None))
        .where(WorkoutSession.workout_date >= cutoff)
    ).all()

    counts: dict[str, int] = {}
    for slug in rows:
        if slug:
            counts[slug] = counts.get(slug, 0) + 1
    return counts


def recent_exercise_slugs_by_muscle(
    user_id: int,
    db_session,
    days: int = 14,
) -> dict[str, set[str]]:
    """Return {primary_muscle: {exercise_slugs}} from recent completed
    sessions. Used by the planner to vary exercises across same-muscle
    days — if the user did back squats (quads) last session, the next
    quad-dominant day picks front squats instead.

    This is split-agnostic: it tracks by MUSCLE, not by focus family.
    A user who switches from PPL to Upper/Lower still gets proper
    variation because "quads" is "quads" regardless of the split.
    """
    from sqlmodel import select
    from app.models import WorkoutSession, WorkoutExercise, Exercise as ExModel

    cutoff = date.today() - timedelta(days=days)
    rows = db_session.exec(
        select(ExModel.slug, ExModel.primary_muscle)
        .join(WorkoutExercise, WorkoutExercise.exercise_id == ExModel.id)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.completed_at.is_not(None))
        .where(WorkoutSession.workout_date >= cutoff)
    ).all()

    result: dict[str, set[str]] = {}
    for slug, muscle in rows:
        if slug and muscle:
            if muscle not in result:
                result[muscle] = set()
            result[muscle].add(slug)
    return result


def most_recent_completed_focus(
    user_id: int,
    db_session,
    *,
    hours: int = 36,
    limit: int = 2,
) -> tuple[list[str], list[str]]:
    """Return normalized focus buckets for the user's most-recent
    completed workouts within the last `hours` hours, newest first.

    **Important: reads from `WorkoutCompletion`, not `WorkoutSession`.**
    The mobile "Finish Workout" button posts to `/workouts/complete`,
    which writes to `WorkoutCompletion` (a lightweight completion
    marker with `workout_date` + `focus_label` + `completed_at`).
    `WorkoutSession.completed_at` only gets populated when the user
    logs every individual set via the structured-log endpoint, which
    is a niche path most users never hit. Querying `WorkoutSession`
    was the root cause of the rotation silently failing in production
    — it always returned `None` because that table was almost always
    empty for the current user.

    Behavior:
      - Returns up to `limit` buckets (default 2) so the planner can
        avoid repeating the last TWO focuses, not just the last one.
      - Each entry is one of `{"lower_body", "upper_body", "full_body",
        "cardio", "mobility", "recovery"}`. Raw `focus_label` strings
        are piped through `normalize_focus_to_bucket` so variants
        like "Lower 2 — Hinge Bias", "Leg Day", "Back & Biceps",
        "Upper Body", "Legs 1" all resolve correctly.
      - Completions whose raw focus doesn't normalize are silently
        skipped so we don't return garbage buckets to the rotation.
      - Uses a naive `datetime.utcnow()` cutoff to match the
        `TIMESTAMP WITHOUT TIME ZONE` column storage. Mixing
        tz-aware and naive was the other silent-failure mode.
      - `WorkoutCompletion` also tracks `workout_date` as a bare
        `DATE` column — we additionally accept anything whose date
        is today or yesterday, so a user who completed a workout
        earlier today but whose `completed_at` somehow drifted still
        shows up. (Belt-and-suspenders against timezone weirdness.)

    Returns an empty list when no recent completions exist.
    """
    from datetime import date, datetime, timedelta
    from sqlmodel import select, or_
    from app.models import WorkoutCompletion
    from .focus_normalize import normalize_focus_to_bucket, normalize_focus_to_family

    now_naive = datetime.utcnow()
    cutoff_dt = now_naive - timedelta(hours=hours)
    # Accept anything completed within the time window OR whose
    # workout_date is today or yesterday (date-level fallback).
    today = date.today()
    yesterday = today - timedelta(days=1)

    rows = db_session.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(
            or_(
                WorkoutCompletion.completed_at >= cutoff_dt,
                WorkoutCompletion.workout_date >= yesterday,
            )
        )
        .order_by(WorkoutCompletion.completed_at.desc())
        .limit(max(limit, 5))  # over-fetch a bit so we can drop unnormalizable rows
    ).all()

    buckets: list[str] = []
    families: list[str] = []
    for row in rows:
        raw_focus = (row.focus_label or "").strip()
        bucket = normalize_focus_to_bucket(raw_focus)
        family = normalize_focus_to_family(raw_focus)
        inside_cutoff = (
            row.completed_at is not None and row.completed_at >= cutoff_dt
        ) or (
            row.workout_date is not None and row.workout_date >= yesterday
        )
        print(
            f"[history] recent completion: workout_date={row.workout_date} "
            f"completed_at={row.completed_at} raw_focus={raw_focus!r} "
            f"bucket={bucket!r} family={family!r} inside_cutoff={inside_cutoff}"
        )
        if bucket and len(buckets) < limit:
            buckets.append(bucket)
        if family and len(families) < limit:
            families.append(family)
    print(
        f"[history] recent focus buckets (last {hours}h, up to {limit}): {buckets} "
        f"families: {families}"
    )
    return buckets, families


def get_recent_completions_for_fatigue(
    user_id: int,
    db_session,
    *,
    days: int = 4,
) -> list[dict]:
    """Fetch recent workout completions as dicts for fatigue scoring.

    Returns the last `days` worth of completions with all structured
    activity fields. Used by `compute_rolling_fatigue` in activity_impact.py.
    """
    cutoff = date.today() - timedelta(days=days)
    rows = db_session.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= cutoff)
        .order_by(WorkoutCompletion.workout_date.desc())
        .limit(20)
    ).all()
    return [
        {
            "workout_date": row.workout_date,
            "focus_label": row.focus_label,
            "duration_seconds": row.duration_seconds,
            "stimulus": row.stimulus,
            "activity_category": getattr(row, "activity_category", None),
            "activity_subtype": getattr(row, "activity_subtype", None),
            "activity_intensity": getattr(row, "activity_intensity", None),
            "cardio_style": getattr(row, "cardio_style", None),
            "resolved_muscle_fatigue": getattr(row, "resolved_muscle_fatigue", None),
        }
        for row in rows
    ]


# ─── Layer 2 — Last session lookup ───────────────────────────────────────────


def db_history_lookup(user_id: int, db_session) -> HistoryLookup:
    """Return a `HistoryLookup` callable that pulls from the live DB.

    The returned closure caches per-user state (the user's most-recent
    completed `WorkoutSession.completed_at` cutoff) and looks up each
    exercise lazily.
    """
    from sqlmodel import select

    from app.models import Exercise, ExerciseSet, WorkoutExercise, WorkoutSession

    def lookup(slug: str) -> list[SetResult]:
        if not slug:
            return []
        # 1. Resolve slug → Exercise.id
        exercise = db_session.exec(
            select(Exercise).where(Exercise.slug == slug)
        ).first()
        if exercise is None or exercise.id is None:
            return []
        # 2. Most-recent completed WorkoutExercise for this user + exercise
        last_we = db_session.exec(
            select(WorkoutExercise)
            .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
            .where(WorkoutSession.user_id == user_id)
            .where(WorkoutSession.completed_at.is_not(None))
            .where(WorkoutExercise.exercise_id == exercise.id)
            .order_by(WorkoutSession.completed_at.desc())
        ).first()
        if last_we is None:
            return []
        # 3. Read its completed sets in order
        sets = db_session.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id == last_we.id)
            .where(ExerciseSet.completed == True)  # noqa: E712
            .order_by(ExerciseSet.set_number)
        ).all()
        results: list[SetResult] = []
        for s in sets:
            if s.actual_reps is None or s.actual_weight_lbs is None:
                continue
            results.append(SetResult(
                set_number=s.set_number,
                weight_lbs=float(s.actual_weight_lbs),
                reps=int(s.actual_reps),
                rir=s.rir_target,        # planned RIR — best signal we have
                feedback=None,           # not persisted yet (Phase 2+ field)
            ))
        return results

    return lookup


# ─── Layer 3 — Session-to-session double progression ────────────────────────


def _build_synthetic_prescription(plan_exercise: dict) -> ExercisePrescription:
    """Translate one exercise dict from the planner output into the
    `ExercisePrescription` shape the existing progression engine expects.

    The planner's output already carries `_role`, `_rir_target`, `sets`,
    and `reps`. We rebuild `planned_sets` from the set count and infer
    `category` / `progression_priority` / `increment_lbs` from the role
    and whether the underlying movement is a compound.

    This keeps the same numbers across the live in-workout engine and the
    between-session propagator — they share the helper.
    """
    role = plan_exercise.get("_role", "secondary")
    is_compound = role in ("primary", "secondary")
    is_machine = "machine" in (plan_exercise.get("equipment") or "").lower()

    if is_machine:
        category = ExerciseCategory.MACHINE
    elif is_compound:
        category = ExerciseCategory.COMPOUND
    else:
        category = ExerciseCategory.ISOLATION

    sets_n = int(plan_exercise.get("sets", 3) or 3)
    planned_sets = [
        PlannedSet(set_number=i + 1, set_type=SetType.STRAIGHT)
        for i in range(sets_n)
    ]

    if category == ExerciseCategory.COMPOUND:
        increment_lbs = 5.0
        priority = ProgressionPriority.LOAD_FIRST
    elif category == ExerciseCategory.MACHINE:
        increment_lbs = 5.0
        priority = ProgressionPriority.HYBRID
    else:
        increment_lbs = 2.5
        priority = ProgressionPriority.REPS_FIRST

    return ExercisePrescription(
        exercise_name=plan_exercise.get("name", ""),
        category=category,
        planned_sets=planned_sets,
        increment_lbs=increment_lbs,
        progression_priority=priority,
        default_start_weight_lbs=None,
    )


def _focus_to_enum(focus: str) -> WorkoutFocus:
    """Best-effort string → WorkoutFocus. Falls back to FULL_BODY."""
    f = (focus or "").lower().split()[0]
    table = {
        "push": WorkoutFocus.PUSH,
        "pull": WorkoutFocus.PULL,
        "legs": WorkoutFocus.LEGS,
        "upper": WorkoutFocus.UPPER,
        "lower": WorkoutFocus.LOWER,
    }
    return table.get(f, WorkoutFocus.FULL_BODY)


def parse_rep_range(reps_str: str) -> Optional[tuple[int, int]]:
    """Parse the planner's `reps` string into an integer range.

    Examples:
        "6-8"   → (6, 8)
        "10-15" → (10, 15)
        "30-45s" → None    (time-based)
        "5"     → (5, 5)
        ""      → None
    """
    if not reps_str:
        return None
    s = reps_str.strip()
    if s.endswith("s") or "yds" in s:
        return None  # time- or distance-based
    if "-" in s:
        try:
            lo_s, hi_s = s.split("-", 1)
            return int(lo_s.strip()), int(hi_s.strip())
        except (ValueError, TypeError):
            return None
    try:
        n = int(s)
        return n, n
    except ValueError:
        return None


def recommend_next_session_load(
    engine: WorkoutProgressionEngine,
    profile: UserTrainingProfile,
    workout_context: WorkoutContext,
    prescription: ExercisePrescription,
    last_session_working_sets: list[SetResult],
    prescribed_rep_range: Optional[tuple[int, int]] = None,
) -> tuple[Optional[float], str, str]:
    """Apply session-level double progression to recommend next-session load.

    Returns `(weight_lbs, action, reason)`. `weight_lbs` may be None when
    we have no usable history.

    `prescribed_rep_range` is the rep range the planner ACTUALLY assigned
    for this exercise (parsed from the planner's `reps` string). When
    present, it overrides the engine's default range so the classification
    matches what the user was actually told to do. Without it the engine
    derives its own range from goal/category/set_type which may not match
    the planner's prescription, causing legitimate top-of-range sets to
    read as mid-range.

    Decision logic (kept simple and auditable):
      1. Any set with PAIN / FORM_BREAKDOWN feedback  → -10% (safety override)
      2. ALL working sets classified `top_of_range` or `underloaded_or_strong`
         → INCREASE by `prescription.increment_lbs * pace_multiplier`
      3. Majority of sets classified `too_heavy_or_fatigued`
         → DECREASE by `prescription.increment_lbs`
      4. Otherwise → HOLD

    Pace multipliers match `WorkoutProgressionEngine`:
      conservative 0.5x, moderate 1.0x, aggressive 1.5x.

    The classifications come from `engine.score_set_against_target` so the
    live in-workout logic and the between-session logic agree on what
    counts as "top of range" vs "missed".
    """
    if not last_session_working_sets:
        return None, "hold", "no history"

    # Filter to working sets only (strip warmups). We didn't persist
    # set_type to ExerciseSet in the data layer, so we use what we have:
    # the prior session's `set_number` order. Warmups are typically logged
    # as separate exercises in our flow today.
    working_sets = list(last_session_working_sets)

    # Build the rep-range target. Prefer the planner's explicitly-assigned
    # range (so the user's "all sets at 8 on 6-8" reads as top-of-range),
    # fall back to the engine's default goal/category/set_type derivation.
    if prescribed_rep_range is not None:
        target = SetTarget(
            set_number=1,
            set_type=SetType.STRAIGHT,
            rep_min=prescribed_rep_range[0],
            rep_max=prescribed_rep_range[1],
            rir_min=1.0,
            rir_max=2.5,
        )
    else:
        target = engine.build_set_target(profile, workout_context, prescription, set_number=1)

    # 1. Safety override
    for s in working_sets:
        if s.feedback in (EffortFeedback.PAIN, EffortFeedback.FORM_BREAKDOWN):
            new_weight = round(s.weight_lbs * 0.9, 1)
            return new_weight, "decrease", "Pain or form breakdown last session — reducing 10%"

    # 2. Classify each working set
    classifications: list[str] = []
    for s in working_sets:
        _score, classification = engine.score_set_against_target(s, target)
        classifications.append(classification)

    # Anchor next session on the TOP working weight, not the last set.
    # Reasoning: if the user's protocol includes back-off or cluster
    # sets (e.g. 3×5 @ 225 + 2×8 @ 185), using `working_sets[-1]`
    # anchors progression on the 185 back-off set, which is wrong —
    # the user's actual training stimulus is 225, and next session
    # should progress from there. Using `max(weight)` handles:
    #   - ramp-up protocols (last set is heaviest → same as before)
    #   - straight sets (all equal → same as before)
    #   - back-off / cluster protocols (first sets heaviest → fixed)
    #   - drop sets (drops are lighter → anchor stays on the top)
    # The classification loop above still reads every set, so an
    # all-miss session still triggers the decrease branch regardless
    # of which set holds the top weight.
    working_weights = [
        s.weight_lbs for s in working_sets
        if s.weight_lbs is not None and s.weight_lbs > 0
    ]
    anchor_weight = max(working_weights) if working_weights else working_sets[-1].weight_lbs
    pace_mult = {
        ProgressionPace.CONSERVATIVE: 0.5,
        ProgressionPace.MODERATE: 1.0,
        ProgressionPace.AGGRESSIVE: 1.5,
    }.get(profile.progression_pace, 1.0)
    increment = prescription.increment_lbs * pace_mult

    top_set_count = sum(
        1 for c in classifications if c in ("top_of_range", "underloaded_or_strong")
    )
    miss_count = sum(1 for c in classifications if c == "too_heavy_or_fatigued")

    # 3. All sets at top of range → increase
    if top_set_count == len(classifications):
        new_weight = engine.round_to_increment(
            anchor_weight + increment, prescription.increment_lbs,
        )
        reason = (
            f"All {len(classifications)} sets hit top of range — adding "
            f"{increment:g} lb over top working weight of {anchor_weight:g} lb"
        )
        return new_weight, "increase", reason

    # 4. Majority missed → decrease
    if miss_count >= (len(classifications) + 1) // 2:
        new_weight = engine.round_to_increment(
            anchor_weight - prescription.increment_lbs,
            prescription.increment_lbs,
        )
        reason = (
            f"{miss_count}/{len(classifications)} sets below target — reducing "
            f"{prescription.increment_lbs:g} lb from top working weight"
        )
        return new_weight, "decrease", reason

    # 5. Otherwise hold at the top working weight and chase more reps.
    reason = "Performance was on target — hold top working weight and try for more reps"
    return anchor_weight, "hold", reason


# ─── Layer 4 — Walk the plan and propagate ──────────────────────────────────


def propagate_session_targets(
    plan: dict,
    profile: UserTrainingProfile,
    history_lookup: HistoryLookup,
    engine: Optional[WorkoutProgressionEngine] = None,
    phase: PhaseType = PhaseType.ACCUMULATION,
    week_number: int = 1,
    *,
    perf_profiles: Optional[dict] = None,
    all_exercises_by_slug: Optional[dict] = None,
    experience: str = "intermediate",
) -> dict:
    """Mutate every exercise in the plan in place to add session-level
    progression targets based on the user's prior performance.

    Sets the following additive keys on each exercise dict (all
    non-underscored so they're safe to serialize to the client and show
    in the UI):

      * `target_weight_lbs` — recommended next-session starting load
      * `progression_action` — "increase" | "hold" | "decrease"
      * `progression_reason` — human-readable explanation
      * `recommendation_source` — one of {"exact_history",
        "substitution_group", "movement_pattern", "muscle_bucket",
        "default"}
      * `recommendation_confidence` — 0–1 confidence score
      * `recommendation_reason` — source-aware explanation that the UI
        can show beside the weight ("Based on your last 3 bench press
        sessions", "Estimated from similar horizontal pressing work")

    Priority:
      1. If the user has logged sets for this exact exercise, use the
         progression engine on the most recent session to compute the
         next-session target. `recommendation_source` = "exact_history".
      2. Otherwise, if `perf_profiles` and `all_exercises_by_slug` are
         provided, run the layered recommendation pipeline to transfer
         an estimate from a similar exercise. `progression_action` is
         set to "hold" (first session on this lift → establish a
         baseline, no progression signal yet).
      3. Otherwise the exercise is left without a target and the
         in-session `/recommend-weight` endpoint handles fallback.
    """
    from .recommendation import recommend_starting_weight

    engine = engine or WorkoutProgressionEngine()
    perf_profiles = perf_profiles or {}
    all_by_slug = all_exercises_by_slug or {}

    for day in plan.get("workout_plan", {}).get("days", []) or []:
        focus = _focus_to_enum(day.get("focus", "Full Body"))
        ctx = WorkoutContext(
            workout_name=day.get("day", "Day"),
            focus=focus,
            phase=phase,
            week_number=week_number,
        )
        for ex in day.get("exercises", []) or []:
            slug = ex.get("_slug")
            if not slug:
                continue
            history = history_lookup(slug)
            if history:
                # Tier 1 — exact exercise history. Run the progression
                # engine to decide increase/hold/decrease from the most
                # recent session's sets.
                prescription = _build_synthetic_prescription(ex)
                rep_range = parse_rep_range(ex.get("reps", ""))
                weight, action, reason = recommend_next_session_load(
                    engine, profile, ctx, prescription, history,
                    prescribed_rep_range=rep_range,
                )
                if weight is not None:
                    ex["target_weight_lbs"] = round(weight, 1)
                ex["progression_action"] = action
                ex["progression_reason"] = reason
                p = perf_profiles.get(slug)
                ex["recommendation_source"] = "exact_history"
                ex["recommendation_confidence"] = (
                    round(p.confidence, 2) if p is not None else 0.85
                )
                ex["recommendation_reason"] = (
                    f"Based on your last {p.session_count} "
                    f"{ex.get('name', slug)} session"
                    + ("s" if p is not None and p.session_count != 1 else "")
                    if p is not None
                    else "Based on your most recent session"
                )
                continue

            # Tier 2+ — no exact history. Try the layered transfer
            # pipeline if the caller passed the profile map + seed
            # lookup. Skip silently when the caller didn't pass them
            # (e.g. tests that only want tier-1 behavior).
            if not perf_profiles or not all_by_slug:
                continue
            target_ex = all_by_slug.get(slug)
            if target_ex is None:
                continue
            rec = recommend_starting_weight(
                target_ex,
                profiles=perf_profiles,
                all_exercises_by_slug=all_by_slug,
                target_reps=ex.get("reps"),
                experience=experience,
            )
            if rec.source == "default":
                # Default baselines aren't confident enough to stamp as
                # a target — let the in-session recommender handle set
                # one when it has the full user context.
                ex["recommendation_source"] = rec.source
                ex["recommendation_confidence"] = rec.confidence
                ex["recommendation_reason"] = rec.reason
                continue
            if rec.weight_lbs > 0:
                ex["target_weight_lbs"] = round(rec.weight_lbs, 1)
            ex["progression_action"] = "hold"
            ex["progression_reason"] = (
                "First session on this lift — establish a baseline before progressing"
            )
            ex["recommendation_source"] = rec.source
            ex["recommendation_confidence"] = rec.confidence
            ex["recommendation_reason"] = rec.reason
    return plan


# ─── Convenience: in-memory history lookup for tests ────────────────────────


def make_dict_history_lookup(history: dict[str, list[SetResult]]) -> HistoryLookup:
    """Wrap a dict in a `HistoryLookup` callable. Tests pass a fixed map
    of `{slug: list[SetResult]}` so they don't need a real database."""
    def lookup(slug: str) -> list[SetResult]:
        return list(history.get(slug, []))
    return lookup
