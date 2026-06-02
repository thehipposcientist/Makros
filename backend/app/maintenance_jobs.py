"""Explicit maintenance jobs for data backfills and enrichment.

Run inside the backend container:

    python -m app.maintenance_jobs --all

Startup should stay focused on schema readiness. These jobs are
idempotent but can scan large tables or call external services, so they
belong behind an operator command / cron.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from sqlmodel import Session, select

from app.database import engine, run_data_maintenance_tasks
from app.logging_setup import configure_logging, get_logger

configure_logging()
logger = get_logger("app.maintenance_jobs")


def run_exercise_image_enrichment() -> None:
    from app.seed_exercise_images import clear_bad_images, seed_exercise_images

    clear_bad_images(engine)
    seeded = seed_exercise_images(engine)
    logger.info("exercise_image_enrichment_done", extra={"seeded": seeded})


def run_muscle_fatigue_backfill() -> None:
    from app.models import WorkoutCompletion, WorkoutExercise, ExerciseSet
    from app.models import WorkoutSession as WS
    from app.services.workout.activity_impact import resolve_exercise_fatigue, resolve_focus_fatigue, session_rpe_from_details
    from app.seed_exercises_data import SEED_EXERCISES

    seed_map = {e["name"].lower(): e for e in SEED_EXERCISES}
    with Session(engine) as db:
        rows = db.exec(
            select(WorkoutCompletion).where(WorkoutCompletion.resolved_muscle_fatigue == None)
        ).all()
        backfilled = 0
        for row in rows:
            session = db.exec(
                select(WS)
                .where(WS.user_id == row.user_id)
                .where(WS.workout_date == row.workout_date)
            ).first()

            if session:
                exercises = db.exec(
                    select(WorkoutExercise).where(WorkoutExercise.session_id == session.id)
                ).all()
                if exercises:
                    ex_list = []
                    for ex in exercises:
                        seed = seed_map.get(ex.name.lower(), {})
                        sets_count = db.exec(
                            select(ExerciseSet)
                            .where(ExerciseSet.workout_exercise_id == ex.id)
                            .where(ExerciseSet.completed == True)
                        ).all()
                        ex_list.append({
                            "name": ex.name,
                            "primary_muscle": seed.get("primary_muscle", ""),
                            "secondary_muscles": seed.get("secondary_muscles", []),
                            "is_compound": seed.get("is_compound", False),
                            "sets_logged": len(sets_count),
                        })
                    if ex_list:
                        row.resolved_muscle_fatigue = resolve_exercise_fatigue(
                            ex_list,
                            intensity=row.activity_intensity or row.stimulus or "moderate",
                            duration_minutes=max(1, row.duration_seconds // 60) if row.duration_seconds else 60,
                        )
                        db.add(row)
                        backfilled += 1
                        continue

            row.resolved_muscle_fatigue = resolve_focus_fatigue(
                row.focus_label,
                intensity=row.activity_intensity or "moderate",
                duration_minutes=max(1, row.duration_seconds // 60) if row.duration_seconds else 60,
                rpe=session_rpe_from_details(getattr(row, "activity_details", None)),
                activity_category=getattr(row, "activity_category", None),
                activity_subtype=getattr(row, "activity_subtype", None),
                cardio_style=getattr(row, "cardio_style", None),
                cardio_load=getattr(row, "cardio_load", None),
                hr_summary=getattr(row, "hr_summary", None),
            )
            db.add(row)
            backfilled += 1

        if backfilled:
            db.commit()
        logger.info("fatigue_backfill_done", extra={"backfilled": backfilled, "total": len(rows)})


def run_gut_health_backfill() -> None:
    from app.services.nutrition.gut_backfill import run_full_backfill

    stats = run_full_backfill()
    logger.info("gut_backfill_done", extra=stats)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run explicit Thallo maintenance jobs")
    parser.add_argument("--all", action="store_true", help="Run data, image, fatigue, and gut-health jobs")
    parser.add_argument("--data", action="store_true", help="Run database backfills/seeds")
    parser.add_argument("--skip-backfills", action="store_true", help="Skip data backfills when --data/--all is used")
    parser.add_argument("--skip-seeds", action="store_true", help="Skip seed inserts when --data/--all is used")
    parser.add_argument("--exercise-images", action="store_true", help="Refresh exercise images")
    parser.add_argument("--muscle-fatigue", action="store_true", help="Backfill resolved muscle fatigue")
    parser.add_argument("--gut-health", action="store_true", help="Backfill gut-health metrics")
    args = parser.parse_args()

    started = datetime.now(timezone.utc)
    if args.all or args.data:
        run_data_maintenance_tasks(
            include_backfills=not args.skip_backfills,
            include_seeds=not args.skip_seeds,
        )
    if args.all or args.exercise_images:
        run_exercise_image_enrichment()
    if args.all or args.muscle_fatigue:
        run_muscle_fatigue_backfill()
    if args.all or args.gut_health:
        run_gut_health_backfill()

    elapsed_ms = (datetime.now(timezone.utc) - started).total_seconds() * 1000
    logger.info("maintenance_jobs_done", extra={"elapsed_ms": round(elapsed_ms)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
