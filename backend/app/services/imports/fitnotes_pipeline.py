"""End-to-end FitNotes import orchestrator."""

from __future__ import annotations

import hashlib
from datetime import date, datetime, time, timedelta, timezone

from sqlmodel import Session, col, select

from app.enums import EquipmentType, WorkoutSource
from app.models import (
    Exercise, ExerciseSet, ImportBatch,
    WorkoutCompletion, WorkoutExercise, WorkoutSession,
)
from .fitnotes_parser import (
    FitNotesParseResult,
    ParsedFitNotesSet,
    group_sets_by_session,
    parse_fitnotes_csv,
)
from .strong_matcher import (
    MatchedExercise, exercise_candidates_from_db, match_exercise_in_list,
)


_KG_TO_LB = 2.2046226218
_DISTANCE_TO_MILES = {
    "mi": 1.0,
    "km": 0.6213711922,
    "m": 0.0006213711922,
    "cm": 0.000006213711922,
    "in": 1.0 / 63360.0,
    "ft": 1.0 / 5280.0,
    "yd": 1.0 / 1760.0,
}


def _to_lbs(value: float | None, unit: str) -> float | None:
    if value is None:
        return None
    if unit == "kg":
        return round(value * _KG_TO_LB, 1)
    return value


def _to_miles(value: float | None, unit: str | None) -> float | None:
    if value is None:
        return None
    factor = _DISTANCE_TO_MILES.get((unit or "mi").lower(), 1.0)
    return round(value * factor, 4)


def _session_hash(user_id: int, sets: list[ParsedFitNotesSet]) -> str:
    first = sets[0]
    parts = [
        str(user_id),
        "fitnotes-session",
        first.workout_date.isoformat(),
        (first.workout_name or "").strip().lower(),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _session_start_timestamp(
    sets_in_group: list[ParsedFitNotesSet],
    workout_date: date,
) -> datetime:
    raw = next(
        (s.workout_started_at for s in sets_in_group if s.workout_started_at is not None),
        None,
    )
    if raw is None:
        return datetime.combine(workout_date, time(12, 0), tzinfo=timezone.utc)
    return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)


def _session_end_timestamp(start_ts: datetime, duration_seconds: int) -> datetime:
    if duration_seconds and duration_seconds > 0:
        return start_ts + timedelta(seconds=duration_seconds)
    return start_ts


def _exercise_snapshots(
    session: Session,
    matched_ids: set[int],
) -> dict[int, Exercise]:
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


def _infer_focus(workout_name: str | None, sets_in_group: list[ParsedFitNotesSet]) -> str:
    if workout_name and workout_name.strip().lower() not in {"fitnotes", "imported workout"}:
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

    text_parts: list[str] = []
    for s in sets_in_group:
        text_parts.append(s.category or "")
        text_parts.append(s.exercise_name or "")
    text = " ".join(text_parts).lower()
    buckets = {
        "Push": ("chest", "triceps", "shoulder", "push", "bench", "press", "dip"),
        "Pull": ("back", "biceps", "pull", "row", "pulldown", "chin", "curl"),
        "Legs": ("legs", "leg", "quads", "quad", "hamstring", "glute", "calf", "squat", "lunge"),
        "Core": ("abs", "abdominals", "core", "plank", "crunch"),
        "Cardio": ("cardio", "run", "treadmill", "bike", "cycle", "rower", "rowing", "walk"),
    }
    hits = [label for label, terms in buckets.items() if any(term in text for term in terms)]
    strength_hits = [h for h in hits if h != "Cardio"]
    if len(strength_hits) > 1:
        return "Full Body"
    if strength_hits:
        return strength_hits[0]
    if "Cardio" in hits:
        return "Cardio"
    return "Imported"


def run_fitnotes_import(
    session: Session,
    user_id: int,
    file_bytes: bytes,
    filename: str | None = None,
) -> ImportBatch:
    now = datetime.now(timezone.utc)
    batch = ImportBatch(
        user_id=user_id,
        source="fitnotes",
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
        parse_result: FitNotesParseResult = parse_fitnotes_csv(file_bytes)
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

            duration_seconds = (
                sets_in_group[0].workout_duration_seconds
                or sum(s.duration_seconds or 0 for s in sets_in_group)
                or 0
            )
            session_start = _session_start_timestamp(sets_in_group, workout_date)
            session_end = _session_end_timestamp(session_start, duration_seconds)
            external_source_id = f"fitnotes:{batch.id}:{session_hash}"

            focus = _infer_focus(workout_name, sets_in_group)
            session_row = WorkoutSession(
                user_id=user_id,
                name=workout_name or "FitNotes import",
                focus=focus,
                workout_date=workout_date,
                source=WorkoutSource.GENERATED,
                notes=None,
                completed_at=session_end,
                external_source_id=external_source_id,
                created_at=session_start,
            )
            session.add(session_row)
            session.flush()

            by_exercise: dict[str, list[ParsedFitNotesSet]] = {}
            for s in sets_in_group:
                by_exercise.setdefault(s.exercise_name, []).append(s)

            for order_idx, (ex_name, sets_for_ex) in enumerate(by_exercise.items()):
                matched: MatchedExercise = all_matches[ex_name]
                if matched.exercise_id is not None and matched.confidence != "fallback":
                    matched_count += 1
                else:
                    fallback_count += 1

                snapshot = snapshots.get(matched.exercise_id) if matched.exercise_id else None
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

                for set_number, s in enumerate(sorted(sets_for_ex, key=lambda x: x.row_index), start=1):
                    session.add(ExerciseSet(
                        workout_exercise_id=we.id,
                        set_number=set_number,
                        set_type=s.set_type,
                        actual_weight_lbs=_to_lbs(s.weight_value, s.weight_unit),
                        actual_reps=s.reps,
                        actual_rir=2.0,
                        completed=True,
                        completed_at=session_end,
                        duration_seconds=s.duration_seconds,
                        actual_distance=_to_miles(s.distance_value, s.distance_unit),
                        notes=s.notes,
                    ))

            distance_total_miles = sum(
                (_to_miles(s.distance_value, s.distance_unit) or 0.0)
                for s in sets_in_group
            )
            has_strength = any(
                (s.weight_value not in (None, 0)) or (s.reps not in (None, 0))
                for s in sets_in_group
            )
            completion = WorkoutCompletion(
                user_id=user_id,
                workout_date=workout_date,
                focus_label=focus,
                duration_seconds=duration_seconds,
                source_context="import_fitnotes",
                activity_category="cardio" if distance_total_miles > 0 and not has_strength else "strength",
                distance_miles=distance_total_miles if distance_total_miles > 0 else None,
                import_source="fitnotes",
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


def build_fitnotes_preview(session: Session, user_id: int, file_bytes: bytes) -> dict:
    parse_result: FitNotesParseResult = parse_fitnotes_csv(file_bytes)

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

        by_exercise: dict[str, list[ParsedFitNotesSet]] = {}
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
