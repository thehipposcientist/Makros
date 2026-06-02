"""Integration-ish tests for the FitNotes import pipeline.

Run from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_imports_fitnotes_pipeline
"""
from __future__ import annotations

from datetime import date

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import ExerciseSet, User, WorkoutCompletion, WorkoutExercise, WorkoutSession
from app.services.imports.fitnotes_pipeline import build_fitnotes_preview, run_fitnotes_import


def _engine():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        echo=False,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _user(session: Session) -> User:
    user = User(email="fitnotes-pipeline@example.com", username="fitnotespipeline", hashed_password="x")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _csv(text: str) -> bytes:
    return text.encode("utf-8")


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_fitnotes_import_groups_by_date_and_writes_sets() -> None:
    print("\n[test] FitNotes CSV imports sessions, sets, and distances")
    engine = _engine()
    with Session(engine) as session:
        user = _user(session)
        file_bytes = _csv(
            "Date,Exercise,Category,Weight (kg),Weight (lbs),Reps,Distance,Distance Unit,Time,Notes,Kind\n"
            "2026-05-08,Bench Press,Chest,,135,10,,,,top set,wr\n"
            "2026-05-08,Bench Press,Chest,,155,8,,,,,wr\n"
            "2026-05-08,Plank,Abs,,,,,,01:30,hard,t\n"
            "2026-05-09,Treadmill,Cardio,,,,3.2,km,20:00,easy,dt\n"
        )

        preview = build_fitnotes_preview(session, user.id, file_bytes)
        assert preview["total_sessions"] == 2, preview
        assert preview["new_sessions"] == 2, preview
        assert preview["total_sets"] == 4, preview

        batch = run_fitnotes_import(session, user.id, file_bytes, "fitnotes.csv")
        assert batch.status == "complete", batch
        assert batch.source == "fitnotes", batch
        assert batch.total_rows == 4, batch
        assert batch.fallback_rows == 3, batch

        sessions = session.exec(
            select(WorkoutSession).where(WorkoutSession.user_id == user.id).order_by(WorkoutSession.workout_date)
        ).all()
        assert len(sessions) == 2, sessions
        assert [s.workout_date for s in sessions] == [date(2026, 5, 8), date(2026, 5, 9)], sessions
        assert sessions[0].name == "FitNotes", sessions
        assert sessions[1].focus == "Cardio", sessions

        bench = session.exec(
            select(WorkoutExercise).where(WorkoutExercise.name == "Bench Press")
        ).first()
        assert bench is not None, "bench exercise inserted"
        bench_sets = session.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id == bench.id)
            .order_by(ExerciseSet.set_number)
        ).all()
        assert [s.set_number for s in bench_sets] == [1, 2], bench_sets
        assert [s.actual_weight_lbs for s in bench_sets] == [135.0, 155.0], bench_sets
        assert bench_sets[0].notes == "top set", bench_sets

        treadmill = session.exec(
            select(WorkoutExercise).where(WorkoutExercise.name == "Treadmill")
        ).first()
        assert treadmill is not None, "treadmill exercise inserted"
        treadmill_set = session.exec(
            select(ExerciseSet).where(ExerciseSet.workout_exercise_id == treadmill.id)
        ).first()
        assert treadmill_set is not None, "treadmill set inserted"
        assert treadmill_set.duration_seconds == 1200, treadmill_set
        assert treadmill_set.actual_distance == 1.9884, treadmill_set

        cardio_completion = session.exec(
            select(WorkoutCompletion).where(
                WorkoutCompletion.user_id == user.id,
                WorkoutCompletion.workout_date == date(2026, 5, 9),
            )
        ).first()
        assert cardio_completion is not None, "cardio completion inserted"
        assert cardio_completion.import_source == "fitnotes", cardio_completion
        assert cardio_completion.source_context == "import_fitnotes", cardio_completion
        assert cardio_completion.distance_miles == 1.9884, cardio_completion
        assert cardio_completion.duration_seconds == 1200, cardio_completion

        post_preview = build_fitnotes_preview(session, user.id, file_bytes)
        assert post_preview["new_sessions"] == 0, post_preview
        assert post_preview["skipped_sessions"] == 2, post_preview
    _ok("FitNotes import writes first-class workout history")


if __name__ == "__main__":
    test_fitnotes_import_groups_by_date_and_writes_sets()
    print("\n✅ test_imports_fitnotes_pipeline.py PASSED")
