"""Integration-ish tests for the Strong import pipeline.

Run from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_imports_strong_pipeline
"""
from __future__ import annotations

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import ExerciseSet, User, WorkoutExercise
from app.services.imports.strong_pipeline import run_strong_import


def _engine():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        echo=False,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _user(session: Session) -> User:
    user = User(email="strong-pipeline@example.com", username="strongpipeline", hashed_password="x")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _csv(text: str) -> bytes:
    return text.encode("utf-8")


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_duplicate_set_orders_and_warmups_import_without_constraint_error() -> None:
    print("\n[test] Strong duplicate Set Order values import cleanly")
    engine = _engine()
    with Session(engine) as session:
        user = _user(session)
        batch = run_strong_import(
            session,
            user.id,
            _csv(
                "Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE\n"
                "2026-05-08 09:00:00,Hotel WO,39m,Squat (Barbell),W,45,12,0,0,,,\n"
                "2026-05-08 09:00:00,Hotel WO,39m,Squat (Barbell),1,135,8,0,0,,,\n"
                "2026-05-08 09:00:00,Hotel WO,39m,Crunch (Stability Ball),1,0,15,0,0,,,\n"
                "2026-05-08 09:00:00,Hotel WO,39m,Crunch (Stability Ball),1,0,12,0,0,,,\n"
            ),
            "strong.csv",
        )

        assert batch.status == "complete", batch
        assert batch.total_rows == 4, batch
        assert batch.skipped_rows == 0, batch

        crunch = session.exec(
            select(WorkoutExercise).where(WorkoutExercise.name == "Crunch (Stability Ball)")
        ).first()
        assert crunch is not None, "crunch exercise inserted"
        crunch_sets = session.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id == crunch.id)
            .order_by(ExerciseSet.set_number)
        ).all()
        assert [s.set_number for s in crunch_sets] == [1, 2], crunch_sets
        assert [s.actual_reps for s in crunch_sets] == [15, 12], crunch_sets

        squat = session.exec(
            select(WorkoutExercise).where(WorkoutExercise.name == "Squat (Barbell)")
        ).first()
        assert squat is not None, "squat exercise inserted"
        squat_sets = session.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id == squat.id)
            .order_by(ExerciseSet.set_number)
        ).all()
        assert [s.set_number for s in squat_sets] == [1, 2], squat_sets
        assert squat_sets[0].set_type == "warmup", squat_sets
        assert squat_sets[0].actual_weight_lbs == 45.0, squat_sets
    _ok("duplicate Strong set orders are renumbered per exercise")


if __name__ == "__main__":
    test_duplicate_set_orders_and_warmups_import_without_constraint_error()
    print("\n✅ test_imports_strong_pipeline.py PASSED")
