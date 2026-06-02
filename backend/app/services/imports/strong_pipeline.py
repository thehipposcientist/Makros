"""End-to-end Strong import orchestrator.

Wires `strong_parser` + `strong_matcher` together with idempotent
WorkoutSession / WorkoutExercise / ExerciseSet / WorkoutCompletion
inserts.

Data flow per Strong session group (date, workout_name):
  1. WorkoutSession    — display name + focus
  2. WorkoutExercise   — one per unique exercise_name in the session
  3. ExerciseSet       — one per parsed set, with weight normalized to lbs
  4. WorkoutCompletion — one per session for fatigue + history

Idempotency hash is per-set (sha256 of user|date|workout_name|
exercise|set_order|weight|reps). Re-uploading the same export blocks
duplicate sets via the partial unique index on
(workout_completions.user_id, import_hash). The session/exercise rows
also get hashes so they're skippable on re-upload.

Pipeline returns the ImportBatch with final counters.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, time, timedelta, timezone

from sqlmodel import Session, col, select

from app.enums import EquipmentType, WorkoutSource
from app.models import (
    Exercise, ExerciseSet, ImportBatch,
    WorkoutCompletion, WorkoutExercise, WorkoutSession,
)
from .strong_matcher import (
    MatchedExercise, exercise_candidates_from_db, match_exercise_in_list,
)
from .strong_parser import (
    ParsedWorkoutSet, StrongParseResult,
    group_sets_by_session, parse_strong_csv,
)


# Strong exports weight in user-preference units. Pipeline normalizes
# to lbs since the rest of Thallo (e1rm, plate math, prescriptions)
# uses lbs throughout.
_KG_TO_LB = 2.2046226218


def _to_lbs(value: float | None, unit: str) -> float | None:
    if value is None:
        return None
    if unit == "kg":
        return round(value * _KG_TO_LB, 1)
    return value


def _session_hash(user_id: int, sets: list[ParsedWorkoutSet]) -> str:
    """Per-session hash. First set's (date, workout_name) is enough
    to identify it stably across uploads."""
    first = sets[0]
    parts = [
        str(user_id),
        "strong-session",
        first.workout_date.isoformat(),
        (first.workout_name or "").strip().lower(),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _set_hash(user_id: int, s: ParsedWorkoutSet) -> str:
    parts = [
        str(user_id),
        "strong-set",
        s.workout_date.isoformat(),
        (s.workout_name or "").strip().lower(),
        s.exercise_name.strip().lower(),
        str(s.set_order),
        f"{(s.weight_value or 0):.2f}",
        f"{s.weight_unit}",
        str(s.reps or 0),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _session_start_timestamp(
    sets_in_group: list[ParsedWorkoutSet],
    workout_date: date,
) -> datetime:
    """Build a tz-aware UTC start timestamp for the session. Prefers the
    full datetime parsed from the CSV's Date column (Strong's exports
    carry "YYYY-MM-DD HH:MM:SS"); falls back to noon UTC on workout_date
    for bare-date exports. Without this, every imported session would
    inherit the import moment via `datetime.now()` and show up under
    today on the workout-history surface."""
    raw = next(
        (s.workout_started_at for s in sets_in_group if s.workout_started_at is not None),
        None,
    )
    if raw is None:
        return datetime.combine(workout_date, time(12, 0), tzinfo=timezone.utc)
    return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)


def _session_end_timestamp(start_ts: datetime, duration_seconds: int) -> datetime:
    """Best-effort end timestamp = start + duration. Falls back to the
    start when duration is unknown so completed_at is never before
    started_at."""
    if duration_seconds and duration_seconds > 0:
        return start_ts + timedelta(seconds=duration_seconds)
    return start_ts


def _exercise_snapshots(
    session: Session,
    matched_ids: set[int],
) -> dict[int, Exercise]:
    """Batched Exercise fetch keyed by id. Pipeline uses this to copy
    slug / primary_muscle / secondary_muscles / is_compound / equipment
    onto WorkoutExercise snapshot fields so imported sessions render
    with the same fidelity as native ones."""
    if not matched_ids:
        return {}
    rows = session.exec(
        select(Exercise).where(col(Exercise.id).in_(matched_ids))
    ).all()
    return {e.id: e for e in rows if e.id is not None}


def _existing_import_hashes(session: Session, user_id: int) -> set[str]:
    rows = session.exec(
        select(WorkoutCompletion.import_hash).where(
            WorkoutCompletion.user_id == user_id,
            WorkoutCompletion.import_hash.is_not(None),
        )
    ).all()
    hashes: set[str] = set()
    for row in rows:
        if isinstance(row, str):
            h = row
        elif hasattr(row, "_mapping"):
            h = next(iter(row._mapping.values()), None)
        elif isinstance(row, (tuple, list)):
            h = row[0] if row else None
        else:
            h = row
        if h is not None:
            hashes.add(str(h))
    return hashes


def _backfill_pr_detection(session: Session, user_id: int, batch_id: int) -> int:
    """Run PR detection over every WorkoutSession written by this
    import batch. Returns the total count of PRs found (logged, not
    surfaced to social) so callers can include it in telemetry.

    Skipped during normal native completion: PRs are reported live in
    the workout-complete response there. Imports never hit that path,
    so this is the historical equivalent. No social writes — see the
    caller comment for why."""
    from app.services.workout.pr_detection import detect_prs

    completions = session.exec(
        select(WorkoutCompletion).where(
            WorkoutCompletion.user_id == user_id,
            WorkoutCompletion.import_batch_id == batch_id,
        )
    ).all()
    session_ids: list[int] = []
    for c in completions:
        if c.external_source_id:
            ws_rows = session.exec(
                select(WorkoutSession).where(
                    WorkoutSession.user_id == user_id,
                    WorkoutSession.external_source_id == c.external_source_id,
                )
            ).all()
        else:
            ws_rows = session.exec(
                select(WorkoutSession).where(
                    WorkoutSession.user_id == user_id,
                    WorkoutSession.workout_date == c.workout_date,
                    WorkoutSession.focus == c.focus_label,
                )
            ).all()
        session_ids.extend([ws.id for ws in ws_rows if ws.id is not None])

    pr_count = 0
    for sid in session_ids:
        try:
            prs = detect_prs(user_id, sid, session)
            pr_count += len(prs)
        except Exception:
            continue
    return pr_count


def _infer_focus(workout_name: str | None) -> str:
    """Best-effort focus label from the user-named session. We don't
    try too hard — the user can rename the session after import."""
    if not workout_name:
        return "Imported"
    n = workout_name.lower()
    if "push" in n or "chest" in n:
        return "Push"
    if "pull" in n or "back" in n:
        return "Pull"
    if "leg" in n or "quad" in n or "squat" in n:
        return "Legs"
    if "full" in n or "total" in n:
        return "Full Body"
    if "upper" in n:
        return "Upper"
    if "lower" in n:
        return "Lower"
    return workout_name.strip()[:50]


def run_strong_import(
    session: Session,
    user_id: int,
    file_bytes: bytes,
    filename: str | None = None,
) -> ImportBatch:
    now = datetime.now(timezone.utc)
    batch = ImportBatch(
        user_id=user_id,
        source="strong",
        data_type="workouts",
        filename=filename,
        status="processing",
        created_at=now,
        updated_at=now,
    )
    session.add(batch)
    session.commit()
    session.refresh(batch)

    try:
        parse_result: StrongParseResult = parse_strong_csv(file_bytes)
        batch.errors = [{"message": e} for e in parse_result.errors]
        batch.total_rows = len(parse_result.sets) + parse_result.skipped_count + len(parse_result.errors)
        batch.skipped_rows = parse_result.skipped_count
        batch.error_rows = len(parse_result.errors)

        if not parse_result.sets:
            batch.status = "failed" if parse_result.errors else "complete"
            batch.completed_at = datetime.now(timezone.utc)
            batch.updated_at = batch.completed_at
            session.add(batch)
            session.commit()
            session.refresh(batch)
            return batch

        candidates = exercise_candidates_from_db(session)
        existing_hashes = _existing_import_hashes(session, user_id)

        groups = group_sets_by_session(parse_result.sets)
        matched_count = 0
        fallback_count = 0

        # First pass: resolve every exercise name to a MatchedExercise so
        # we can batch-fetch the Exercise rows in one query before writing
        # any WorkoutExercise. Avoids N round trips for snapshot data.
        all_matches: dict[str, MatchedExercise] = {}
        for sets_in_group in groups.values():
            for s in sets_in_group:
                if s.exercise_name not in all_matches:
                    all_matches[s.exercise_name] = match_exercise_in_list(s.exercise_name, candidates)
        matched_ids = {m.exercise_id for m in all_matches.values() if m.exercise_id is not None}
        snapshots = _exercise_snapshots(session, matched_ids)

        for (workout_date, workout_name), sets_in_group in groups.items():
            session_hash = _session_hash(user_id, sets_in_group)
            if session_hash in existing_hashes:
                continue
            existing_hashes.add(session_hash)

            # Session timestamps come from the CSV, not `now`. Without
            # this, every imported workout would render under today on
            # the history surface (frontend uses completed_at as the
            # card's primary date).
            duration_seconds = (
                sets_in_group[0].workout_duration_seconds
                or sum(s.duration_seconds or 0 for s in sets_in_group)
                or 0
            )
            session_start = _session_start_timestamp(sets_in_group, workout_date)
            session_end = _session_end_timestamp(session_start, duration_seconds)
            external_source_id = f"strong:{batch.id}:{session_hash}"

            focus = _infer_focus(workout_name)
            session_row = WorkoutSession(
                user_id=user_id,
                name=workout_name or "Imported workout",
                focus=focus,
                workout_date=workout_date,
                source=WorkoutSource.GENERATED,
                notes=sets_in_group[0].workout_notes,
                completed_at=session_end,
                external_source_id=external_source_id,
                created_at=session_start,
            )
            session.add(session_row)
            session.flush()

            # Group sets by exercise within this session.
            by_exercise: dict[str, list[ParsedWorkoutSet]] = {}
            for s in sets_in_group:
                by_exercise.setdefault(s.exercise_name, []).append(s)

            for order_idx, (ex_name, sets_for_ex) in enumerate(by_exercise.items()):
                matched: MatchedExercise = all_matches[ex_name]
                if matched.exercise_id is not None and matched.confidence != "fallback":
                    matched_count += 1
                else:
                    fallback_count += 1

                snapshot = snapshots.get(matched.exercise_id) if matched.exercise_id else None
                # Equipment snapshot from the matched library row when
                # we have one; default to GYM only for fallback rows.
                equipment = snapshot.equipment if snapshot is not None else EquipmentType.GYM
                we = WorkoutExercise(
                    session_id=session_row.id,
                    exercise_id=matched.exercise_id,
                    name=matched.name,
                    order_index=order_idx,
                    equipment=equipment,
                    exercise_slug_snapshot=snapshot.slug if snapshot else None,
                    primary_muscle_snapshot=str(snapshot.primary_muscle) if snapshot else None,
                    secondary_muscles_snapshot=list(snapshot.secondary_muscles) if snapshot else None,
                    is_compound_snapshot=snapshot.is_compound if snapshot else None,
                )
                session.add(we)
                session.flush()

                # Strong's Set Order is not guaranteed unique inside an
                # exercise. Warmups use markers like "W", and interrupted
                # sessions can restart numbering at 1. Preserve CSV row
                # order but write contiguous per-exercise set numbers so
                # ExerciseSet's uniqueness constraint is always satisfied.
                for set_number, s in enumerate(sorted(sets_for_ex, key=lambda x: x.row_index), start=1):
                    # rolling_e1rm rejects sets where RIR is null, so
                    # imports must carry some RIR signal or the e1RM
                    # chart / working-weight recommender would silently
                    # ignore every imported set. Convert from RPE when
                    # Strong exported it (RIR = 10 - RPE, clamped to
                    # [0, 4]); otherwise default to 2, the conservative
                    # working-set assumption for hypertrophy training.
                    if s.rpe is not None:
                        rir_value = max(0.0, min(4.0, 10.0 - float(s.rpe)))
                    else:
                        rir_value = 2.0
                    session.add(ExerciseSet(
                        workout_exercise_id=we.id,
                        set_number=set_number,
                        set_type=s.set_type,
                        actual_weight_lbs=_to_lbs(s.weight_value, s.weight_unit),
                        actual_reps=s.reps,
                        rpe=int(s.rpe) if s.rpe is not None else None,
                        actual_rir=rir_value,
                        completed=True,
                        completed_at=session_end,
                        duration_seconds=s.duration_seconds,
                        actual_distance=s.distance_value,
                    ))

            # WorkoutCompletion — one per session. import_hash unique per
            # session-day-name combo so re-uploads skip cleanly.
            distance_total = sum((s.distance_value or 0.0) for s in sets_in_group)
            completion = WorkoutCompletion(
                user_id=user_id,
                workout_date=workout_date,
                focus_label=focus,
                duration_seconds=duration_seconds,
                source_context="import_strong",
                activity_category="strength" if not distance_total else "cardio",
                distance_miles=distance_total if distance_total > 0 else None,
                import_source="strong",
                import_batch_id=batch.id,
                import_hash=session_hash,
                external_source_id=external_source_id,
                started_at=session_start,
                ended_at=session_end,
                completed_at=session_end,
            )
            session.add(completion)

        batch.matched_rows = matched_count
        batch.fallback_rows = fallback_count
        batch.status = "complete"
        batch.completed_at = datetime.now(timezone.utc)
        batch.updated_at = batch.completed_at
        session.add(batch)
        session.commit()
        session.refresh(batch)

        # PR backfill — run detect_prs over every imported session so
        # the user's all-time PR list reflects their historical lifts.
        # detect_prs compares each session's sets to the user's all-
        # time best across every OTHER session, so the chronological
        # culmination naturally wins: a session that was later eclipsed
        # by a heavier lift won't get flagged as a PR. Deliberately
        # skips the social-feed write — replaying historic PRs would
        # spam the friends digest with months-old events. Best-effort:
        # failures here don't unwind the import.
        try:
            _backfill_pr_detection(session, user_id, batch.id)
        except Exception:
            session.rollback()

        return batch
    except Exception as exc:
        session.rollback()
        batch = session.exec(
            select(ImportBatch).where(ImportBatch.id == batch.id)
        ).first()
        if batch is not None:
            batch.status = "failed"
            batch.errors = [*(batch.errors or []), {"message": f"orchestrator: {exc!s}"}]
            batch.completed_at = datetime.now(timezone.utc)
            batch.updated_at = batch.completed_at
            session.add(batch)
            session.commit()
            session.refresh(batch)
        raise


def build_strong_preview(session: Session, user_id: int, file_bytes: bytes) -> dict:
    """Run parse + matcher with NO DB writes. Returns a JSON-able
    preview the client can show before the user confirms an import.

    Sessions are flagged `already_imported=True` when a prior batch
    already wrote the same (date, workout_name) — so re-uploading the
    same export shows what would actually be new vs. skipped."""
    parse_result: StrongParseResult = parse_strong_csv(file_bytes)

    existing_hashes: set[str] = set()
    if parse_result.sets:
        existing_hashes = _existing_import_hashes(session, user_id)

    candidates = exercise_candidates_from_db(session) if parse_result.sets else []
    groups = group_sets_by_session(parse_result.sets)

    preview_sessions: list[dict] = []
    new_session_count = 0
    new_matched_exercises = 0
    new_fallback_exercises = 0
    distinct_matches: dict[str, MatchedExercise] = {}

    for (workout_date, workout_name), sets_in_group in groups.items():
        session_hash = _session_hash(user_id, sets_in_group)
        already_imported = session_hash in existing_hashes

        by_exercise: dict[str, list[ParsedWorkoutSet]] = {}
        for s in sets_in_group:
            by_exercise.setdefault(s.exercise_name, []).append(s)

        exercises_out: list[dict] = []
        session_matched = 0
        session_fallback = 0
        for ex_name, sets_for_ex in by_exercise.items():
            if ex_name not in distinct_matches:
                distinct_matches[ex_name] = match_exercise_in_list(ex_name, candidates)
            matched = distinct_matches[ex_name]
            is_match = matched.exercise_id is not None and matched.confidence != "fallback"
            if is_match:
                session_matched += 1
            else:
                session_fallback += 1
            exercises_out.append({
                "raw_name": ex_name,
                "matched_name": matched.name if is_match else None,
                "confidence": matched.confidence,
                "set_count": len(sets_for_ex),
            })

        if not already_imported:
            new_session_count += 1
            new_matched_exercises += session_matched
            new_fallback_exercises += session_fallback

        duration_seconds = (
            sets_in_group[0].workout_duration_seconds
            or sum(s.duration_seconds or 0 for s in sets_in_group)
            or 0
        )
        preview_sessions.append({
            "workout_date": workout_date.isoformat(),
            "workout_name": workout_name,
            "exercise_count": len(by_exercise),
            "set_count": len(sets_in_group),
            "duration_seconds": duration_seconds,
            "matched_exercises": session_matched,
            "fallback_exercises": session_fallback,
            "already_imported": already_imported,
            "exercises": exercises_out,
        })

    preview_sessions.sort(key=lambda r: (r["workout_date"], r["workout_name"] or ""))

    return {
        "total_sessions": len(preview_sessions),
        "new_sessions": new_session_count,
        "skipped_sessions": len(preview_sessions) - new_session_count,
        "total_sets": len(parse_result.sets),
        "skipped_rows": parse_result.skipped_count,
        "matched_exercises": new_matched_exercises,
        "fallback_exercises": new_fallback_exercises,
        "errors": [{"message": e} for e in parse_result.errors],
        "sessions": preview_sessions,
    }


def rollback_strong_import(session: Session, user_id: int, batch_id: int) -> bool:
    """Strong rollback also needs to clean WorkoutSession + WorkoutExercise
    + ExerciseSet rows. We follow the chain through WorkoutCompletion's
    import_batch_id to identify all affected sessions.

    Strong-specific because the meal rollback path doesn't walk these
    tables — keeps the cleanup queries targeted."""
    batch = session.exec(
        select(ImportBatch).where(
            ImportBatch.id == batch_id,
            ImportBatch.user_id == user_id,
            ImportBatch.data_type == "workouts",
        )
    ).first()
    if not batch:
        return False

    completions = session.exec(
        select(WorkoutCompletion).where(
            WorkoutCompletion.user_id == user_id,
            WorkoutCompletion.import_batch_id == batch_id,
        )
    ).all()
    # Newer imports tag WorkoutSession + WorkoutCompletion with the same
    # external_source_id. Older Strong imports did not, so keep the
    # date/focus fallback for legacy rollback.
    for c in completions:
        if c.external_source_id:
            sessions = session.exec(
                select(WorkoutSession).where(
                    WorkoutSession.user_id == user_id,
                    WorkoutSession.external_source_id == c.external_source_id,
                )
            ).all()
        else:
            sessions = session.exec(
                select(WorkoutSession).where(
                    WorkoutSession.user_id == user_id,
                    WorkoutSession.workout_date == c.workout_date,
                    WorkoutSession.focus == c.focus_label,
                )
            ).all()
        for ws in sessions:
            workout_exercises = session.exec(
                select(WorkoutExercise).where(WorkoutExercise.session_id == ws.id)
            ).all()
            for we in workout_exercises:
                set_rows = session.exec(
                    select(ExerciseSet).where(ExerciseSet.workout_exercise_id == we.id)
                ).all()
                for sr in set_rows:
                    session.delete(sr)
                session.delete(we)
            session.delete(ws)
        session.delete(c)

    batch.status = "rolled_back"
    batch.updated_at = datetime.now(timezone.utc)
    session.add(batch)
    session.commit()
    return True
