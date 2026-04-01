# app/services/workout_planner.py

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from statistics import mean
from typing import Iterable

from sqlmodel import Session, select

from app.enums import GoalType, EquipmentType, MuscleGroup, WorkoutSource
from app.models import (
    UserGoal,
    UserPreferences,
    Exercise,
    WorkoutSession,
    WorkoutExercise,
    ExerciseSet,
)


# -------------------------------------------------------------------
# CONFIG
# -------------------------------------------------------------------

GOAL_REP_RANGES: dict[GoalType, tuple[int, int]] = {
    GoalType.STRENGTH: (3, 6),
    GoalType.MUSCLE_GAIN: (6, 12),
    GoalType.BODY_RECOMP: (6, 12),
    GoalType.TONING: (10, 15),
    GoalType.FAT_LOSS: (8, 15),
    GoalType.ENDURANCE: (12, 20),
    GoalType.ATHLETIC_PERFORMANCE: (5, 8),
    GoalType.MAINTAIN: (6, 12),
    GoalType.FLEXIBILITY: (8, 15),
    GoalType.STRESS_RELIEF: (8, 15),
}

GOAL_SET_RANGES: dict[GoalType, tuple[int, int]] = {
    GoalType.STRENGTH: (3, 5),
    GoalType.MUSCLE_GAIN: (3, 4),
    GoalType.BODY_RECOMP: (3, 4),
    GoalType.TONING: (2, 4),
    GoalType.FAT_LOSS: (2, 4),
    GoalType.ENDURANCE: (2, 4),
    GoalType.ATHLETIC_PERFORMANCE: (3, 5),
    GoalType.MAINTAIN: (2, 4),
    GoalType.FLEXIBILITY: (2, 3),
    GoalType.STRESS_RELIEF: (2, 3),
}

GOAL_REST_SECONDS: dict[GoalType, int] = {
    GoalType.STRENGTH: 150,
    GoalType.MUSCLE_GAIN: 90,
    GoalType.BODY_RECOMP: 75,
    GoalType.TONING: 60,
    GoalType.FAT_LOSS: 45,
    GoalType.ENDURANCE: 45,
    GoalType.ATHLETIC_PERFORMANCE: 120,
    GoalType.MAINTAIN: 75,
    GoalType.FLEXIBILITY: 45,
    GoalType.STRESS_RELIEF: 45,
}

# muscle templates by available days
SPLIT_BY_DAYS: dict[int, list[list[MuscleGroup]]] = {
    2: [
        [MuscleGroup.FULL_BODY],
        [MuscleGroup.FULL_BODY],
    ],
    3: [
        [MuscleGroup.CHEST, MuscleGroup.SHOULDERS, MuscleGroup.TRICEPS],
        [MuscleGroup.BACK, MuscleGroup.BICEPS],
        [MuscleGroup.QUADS, MuscleGroup.HAMSTRINGS, MuscleGroup.GLUTES, MuscleGroup.CORE],
    ],
    4: [
        [MuscleGroup.CHEST, MuscleGroup.TRICEPS],
        [MuscleGroup.BACK, MuscleGroup.BICEPS],
        [MuscleGroup.QUADS, MuscleGroup.HAMSTRINGS, MuscleGroup.GLUTES],
        [MuscleGroup.SHOULDERS, MuscleGroup.CORE],
    ],
    5: [
        [MuscleGroup.CHEST],
        [MuscleGroup.BACK],
        [MuscleGroup.QUADS, MuscleGroup.HAMSTRINGS, MuscleGroup.GLUTES],
        [MuscleGroup.SHOULDERS],
        [MuscleGroup.BICEPS, MuscleGroup.TRICEPS, MuscleGroup.CORE],
    ],
    6: [
        [MuscleGroup.CHEST, MuscleGroup.TRICEPS],
        [MuscleGroup.BACK, MuscleGroup.BICEPS],
        [MuscleGroup.QUADS, MuscleGroup.HAMSTRINGS, MuscleGroup.GLUTES],
        [MuscleGroup.CHEST, MuscleGroup.SHOULDERS],
        [MuscleGroup.BACK, MuscleGroup.BICEPS],
        [MuscleGroup.QUADS, MuscleGroup.CORE],
    ],
    7: [
        [MuscleGroup.CHEST],
        [MuscleGroup.BACK],
        [MuscleGroup.QUADS],
        [MuscleGroup.SHOULDERS],
        [MuscleGroup.HAMSTRINGS, MuscleGroup.GLUTES],
        [MuscleGroup.ARMS if hasattr(MuscleGroup, "ARMS") else MuscleGroup.BICEPS],
        [MuscleGroup.CORE],
    ],
}

DEFAULT_DAYS = 3


# -------------------------------------------------------------------
# DTOs
# -------------------------------------------------------------------

@dataclass
class ExercisePrescription:
    exercise_id: int | None
    name: str
    equipment: EquipmentType
    order_index: int
    sets: int
    target_reps: int
    target_weight_lbs: float | None
    notes: str | None = None


@dataclass
class PlannedDay:
    name: str
    focus: MuscleGroup
    exercises: list[ExercisePrescription]


# -------------------------------------------------------------------
# PUBLIC API
# -------------------------------------------------------------------

def generate_or_refresh_workout_plan(
    db: Session,
    user_id: int,
    start_date: date | None = None,
    days_to_generate: int | None = None,
) -> list[WorkoutSession]:
    """
    Generate upcoming workout sessions based on:
    - active goal
    - preferences / equipment / days per week
    - exercise history
    - progressive overload
    - recent fatigue / completion trends

    Safe to call repeatedly. It creates future sessions only if they don't exist.
    """
    start_date = start_date or date.today()

    goal = _get_active_goal(db, user_id)
    prefs = _get_preferences(db, user_id)
    training_days = max(2, min(6, prefs.days_per_week if prefs else DEFAULT_DAYS))
    equipment_names = set((prefs.equipment or [])) if prefs else set()

    split = _build_split(training_days)
    horizon = days_to_generate or training_days

    existing_dates = {
        row[0]
        for row in db.exec(
            select(WorkoutSession.workout_date).where(
                WorkoutSession.user_id == user_id,
                WorkoutSession.workout_date >= start_date,
            )
        ).all()
    }

    generated_sessions: list[WorkoutSession] = []
    cursor = start_date

    split_index = 0
    while len(generated_sessions) < horizon:
        if cursor not in existing_dates:
            focus_groups = split[split_index % len(split)]
            planned_day = _build_day_plan(
                db=db,
                user_id=user_id,
                goal=goal.goal_type,
                equipment_names=equipment_names,
                focus_groups=focus_groups,
                day_number=split_index + 1,
            )
            session = _persist_planned_day(db, user_id, cursor, planned_day)
            generated_sessions.append(session)
            split_index += 1
        cursor += timedelta(days=1)

    db.commit()
    return generated_sessions


def recommend_next_set_from_history(
    db: Session,
    user_id: int,
    workout_exercise_id: int,
) -> dict:
    """
    Deterministic next-set recommendation for the CURRENT workout exercise,
    based on the sets already logged in this movement and prior sessions.
    """
    current_sets = db.exec(
        select(ExerciseSet)
        .where(ExerciseSet.exercise_id == workout_exercise_id)
        .order_by(ExerciseSet.set_number)
    ).all()

    if not current_sets:
        raise ValueError("No sets found for workout exercise")

    work_ex = db.exec(
        select(WorkoutExercise).where(WorkoutExercise.id == workout_exercise_id)
    ).first()
    if not work_ex:
        raise ValueError("Workout exercise not found")

    session = db.exec(
        select(WorkoutSession).where(WorkoutSession.id == work_ex.session_id)
    ).first()
    if not session:
        raise ValueError("Workout session not found")

    goal = _get_active_goal(db, user_id).goal_type

    completed_sets = [s for s in current_sets if s.completed]
    next_set_number = len(completed_sets) + 1

    # all planned sets completed
    if next_set_number > len(current_sets):
        return {
            "done": True,
            "tip": "All planned sets are complete. Log the session and progress next workout if it felt good.",
        }

    target_set = current_sets[next_set_number - 1]
    history = _get_recent_exercise_history(db, user_id, work_ex.name, limit_sessions=6)

    recommended_weight = _recommend_weight(
        goal=goal,
        current_completed_sets=completed_sets,
        target_reps=target_set.target_reps,
        history=history,
    )

    return {
        "done": False,
        "nextSetNumber": next_set_number,
        "weightLbs": recommended_weight,
        "reps": target_set.target_reps,
        "tip": _build_set_tip(goal, completed_sets, target_set.target_reps, recommended_weight),
    }


def update_future_progression_after_completion(
    db: Session,
    user_id: int,
    completed_session_id: int,
) -> None:
    """
    After a workout is completed, look at performance and adjust future
    sessions of the same exercises.
    """
    session = db.exec(
        select(WorkoutSession).where(WorkoutSession.id == completed_session_id)
    ).first()
    if not session:
        raise ValueError("Workout session not found")

    goal = _get_active_goal(db, user_id).goal_type

    workout_exercises = db.exec(
        select(WorkoutExercise)
        .where(WorkoutExercise.session_id == completed_session_id)
        .order_by(WorkoutExercise.order_index)
    ).all()

    for work_ex in workout_exercises:
        sets = db.exec(
            select(ExerciseSet)
            .where(ExerciseSet.exercise_id == work_ex.id)
            .order_by(ExerciseSet.set_number)
        ).all()

        performance = _score_exercise_performance(sets)
        delta = _progression_delta(goal, performance)

        if delta == 0:
            continue

        future_same = db.exec(
            select(WorkoutExercise)
            .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
            .where(
                WorkoutSession.user_id == user_id,
                WorkoutSession.workout_date > session.workout_date,
                WorkoutExercise.name == work_ex.name,
                WorkoutSession.completed_at.is_(None),
            )
        ).all()

        for future_ex in future_same:
            future_sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.exercise_id == future_ex.id)
            ).all()

            for s in future_sets:
                if s.target_weight_lbs is not None:
                    s.target_weight_lbs = max(0, round(s.target_weight_lbs + delta, 2))
                    db.add(s)

    db.commit()


# -------------------------------------------------------------------
# PLAN BUILDING
# -------------------------------------------------------------------

def _build_day_plan(
    db: Session,
    user_id: int,
    goal: GoalType,
    equipment_names: set[str],
    focus_groups: list[MuscleGroup],
    day_number: int,
) -> PlannedDay:
    exercises: list[ExercisePrescription] = []
    used_names: set[str] = set()
    order_index = 1

    # rough volume per muscle group
    for muscle in focus_groups:
        exercise_count = _exercise_count_for_muscle(goal, muscle)

        candidates = _pick_candidate_exercises(
            db=db,
            muscle=muscle,
            equipment_names=equipment_names,
            user_id=user_id,
        )

        # prefer movements not used too recently
        candidates = sorted(
            candidates,
            key=lambda ex: (
                _recent_usage_penalty(db, user_id, ex.name),
                0 if ex.is_compound else 1,
            ),
        )

        selected = 0
        for ex in candidates:
            if ex.name in used_names:
                continue

            history = _get_recent_exercise_history(db, user_id, ex.name, limit_sessions=6)
            sets, reps = _prescribe_sets_and_reps(goal, ex.is_compound, history)
            weight = _recommend_starting_weight(goal, history, reps)

            exercises.append(
                ExercisePrescription(
                    exercise_id=ex.id,
                    name=ex.name,
                    equipment=ex.equipment,
                    order_index=order_index,
                    sets=sets,
                    target_reps=reps,
                    target_weight_lbs=weight,
                    notes=_prescription_note(goal, ex.is_compound),
                )
            )
            used_names.add(ex.name)
            order_index += 1
            selected += 1

            if selected >= exercise_count:
                break

    day_focus = focus_groups[0] if len(focus_groups) == 1 else MuscleGroup.FULL_BODY

    return PlannedDay(
        name=f"Workout Day {day_number}",
        focus=day_focus,
        exercises=exercises,
    )


def _persist_planned_day(
    db: Session,
    user_id: int,
    workout_date: date,
    planned_day: PlannedDay,
) -> WorkoutSession:
    session = WorkoutSession(
        user_id=user_id,
        name=planned_day.name,
        focus=planned_day.focus,
        workout_date=workout_date,
        source=WorkoutSource.GENERATED,
    )
    db.add(session)
    db.flush()

    for ex in planned_day.exercises:
        work_ex = WorkoutExercise(
            session_id=session.id,
            exercise_id=ex.exercise_id,
            name=ex.name,
            order_index=ex.order_index,
            equipment=ex.equipment,
            notes=ex.notes,
        )
        db.add(work_ex)
        db.flush()

        for set_number in range(1, ex.sets + 1):
            set_row = ExerciseSet(
                exercise_id=work_ex.id,
                set_number=set_number,
                target_reps=ex.target_reps,
                target_weight_lbs=ex.target_weight_lbs,
            )
            db.add(set_row)

    return session


# -------------------------------------------------------------------
# SCORING / PROGRESSION
# -------------------------------------------------------------------

def _score_exercise_performance(sets: list[ExerciseSet]) -> float:
    """
    Returns:
    > 0.85 = clearly exceeded prescription
    0.65-0.85 = solid
    0.45-0.65 = barely met
    < 0.45 = underperformed
    """
    completed = [s for s in sets if s.completed]
    if not completed:
        return 0.0

    scores: list[float] = []
    for s in completed:
        rep_score = min(1.0, (s.actual_reps or 0) / max(1, s.target_reps))
        rpe_penalty = 0.0
        if s.rpe is not None:
            if s.rpe >= 10:
                rpe_penalty = 0.20
            elif s.rpe >= 9:
                rpe_penalty = 0.10
        scores.append(max(0.0, rep_score - rpe_penalty))

    return mean(scores)


def _progression_delta(goal: GoalType, performance_score: float) -> float:
    """
    Small lb jump. Keep it simple.
    """
    if performance_score >= 0.90:
        return 10.0 if goal == GoalType.STRENGTH else 5.0
    if performance_score >= 0.75:
        return 5.0 if goal == GoalType.STRENGTH else 2.5
    if performance_score >= 0.55:
        return 0.0
    if performance_score >= 0.35:
        return -2.5
    return -5.0


def _recommend_weight(
    goal: GoalType,
    current_completed_sets: list[ExerciseSet],
    target_reps: int,
    history: list[dict],
) -> float | None:
    """
    Order of preference:
    1. Use last completed set today, reduce a bit if fatigue shows up
    2. Use recent historical working weight
    3. None if bodyweight / no history
    """
    if current_completed_sets:
        last = current_completed_sets[-1]
        if last.actual_weight_lbs is None:
            return None

        drop = 0.0
        if (last.actual_reps or 0) < target_reps:
            drop = 5.0
        elif last.rpe is not None and last.rpe >= 9:
            drop = 2.5

        return max(0, round(last.actual_weight_lbs - drop, 2))

    hist_weights = [h["avg_weight"] for h in history if h["avg_weight"] is not None]
    if hist_weights:
        baseline = hist_weights[0]
        return round(baseline, 2)

    return None


def _recommend_starting_weight(
    goal: GoalType,
    history: list[dict],
    target_reps: int,
) -> float | None:
    if not history:
        return None

    last = history[0]
    avg_weight = last["avg_weight"]
    avg_reps = last["avg_reps"]

    if avg_weight is None:
        return None

    # crude rep-to-load adjustment
    if avg_reps >= target_reps + 3:
        return round(avg_weight + (5.0 if goal == GoalType.STRENGTH else 2.5), 2)
    if avg_reps < target_reps:
        return round(max(0, avg_weight - 2.5), 2)

    return round(avg_weight, 2)


# -------------------------------------------------------------------
# EXERCISE SELECTION
# -------------------------------------------------------------------

def _pick_candidate_exercises(
    db: Session,
    muscle: MuscleGroup,
    equipment_names: set[str],
    user_id: int,
) -> list[Exercise]:
    allowed_types = _map_equipment_names_to_types(equipment_names)

    rows = db.exec(
        select(Exercise).where(
            Exercise.primary_muscle == muscle,
            Exercise.equipment.in_(allowed_types) if allowed_types else True,
        )
    ).all()

    # if nothing matched, allow full-body/bodyweight fallback
    if not rows:
        rows = db.exec(
            select(Exercise).where(
                Exercise.primary_muscle.in_([muscle, MuscleGroup.FULL_BODY]),
            )
        ).all()

    return rows


def _map_equipment_names_to_types(equipment_names: set[str]) -> list[EquipmentType]:
    names = {x.strip().lower() for x in equipment_names}
    out: set[EquipmentType] = {EquipmentType.BODYWEIGHT}

    gym_indicators = {
        "barbell", "squat rack", "power rack", "smith machine", "cable machine",
        "leg press", "lat pulldown", "chest press machine", "seated row machine",
        "leg extension", "leg curl"
    }
    home_indicators = {"bench", "bands", "pull-up bar"}
    dumbbell_indicators = {"dumbbells", "kettlebell"}

    if names & gym_indicators:
        out.add(EquipmentType.GYM)
    if names & dumbbell_indicators:
        out.add(EquipmentType.DUMBBELLS)
    if names & home_indicators:
        out.add(EquipmentType.HOME)

    return list(out)


def _recent_usage_penalty(db: Session, user_id: int, exercise_name: str) -> int:
    recent = db.exec(
        select(WorkoutSession.workout_date)
        .join(WorkoutExercise, WorkoutExercise.session_id == WorkoutSession.id)
        .where(
            WorkoutSession.user_id == user_id,
            WorkoutExercise.name == exercise_name,
        )
        .order_by(WorkoutSession.workout_date.desc())
    ).all()

    if not recent:
        return 999

    days_ago = (date.today() - recent[0]).days
    return days_ago


def _exercise_count_for_muscle(goal: GoalType, muscle: MuscleGroup) -> int:
    if muscle in {MuscleGroup.CHEST, MuscleGroup.BACK, MuscleGroup.QUADS}:
        return 2 if goal in {GoalType.MUSCLE_GAIN, GoalType.STRENGTH, GoalType.BODY_RECOMP} else 1
    if muscle in {MuscleGroup.BICEPS, MuscleGroup.TRICEPS, MuscleGroup.CALVES, MuscleGroup.CORE}:
        return 1
    return 1


def _prescribe_sets_and_reps(
    goal: GoalType,
    is_compound: bool,
    history: list[dict],
) -> tuple[int, int]:
    set_low, set_high = GOAL_SET_RANGES[goal]
    rep_low, rep_high = GOAL_REP_RANGES[goal]

    sets = set_high if is_compound else set_low
    reps = rep_low if goal == GoalType.STRENGTH else round((rep_low + rep_high) / 2)

    # slight downshift if recent compliance is poor
    if history:
        recent_compliance = mean(h["completion_rate"] for h in history)
        if recent_compliance < 0.6:
            sets = max(2, sets - 1)

    return sets, reps


def _prescription_note(goal: GoalType, is_compound: bool) -> str:
    rest = GOAL_REST_SECONDS[goal]
    style = "compound focus" if is_compound else "accessory focus"
    return f"{style}; rest about {rest}s between sets"


def _build_set_tip(
    goal: GoalType,
    completed_sets: list[ExerciseSet],
    target_reps: int,
    weight: float | None,
) -> str:
    if weight is None:
        return "Use a load that leaves about 1–3 reps in reserve with clean form."

    if not completed_sets:
        return f"Start at {weight} lb and keep the first set controlled."

    last = completed_sets[-1]
    if (last.actual_reps or 0) < target_reps:
        return "You faded on the last set, so pull back slightly and keep form tight."
    if last.rpe is not None and last.rpe >= 9:
        return "Stay smooth here. Match reps without grinding."
    return "Good pace so far. Keep the same quality on this set."


# -------------------------------------------------------------------
# HISTORY HELPERS
# -------------------------------------------------------------------

def _get_recent_exercise_history(
    db: Session,
    user_id: int,
    exercise_name: str,
    limit_sessions: int = 6,
) -> list[dict]:
    rows = db.exec(
        select(WorkoutSession, WorkoutExercise, ExerciseSet)
        .join(WorkoutExercise, WorkoutExercise.session_id == WorkoutSession.id)
        .join(ExerciseSet, ExerciseSet.exercise_id == WorkoutExercise.id)
        .where(
            WorkoutSession.user_id == user_id,
            WorkoutExercise.name == exercise_name,
            WorkoutSession.completed_at.is_not(None),
        )
        .order_by(WorkoutSession.workout_date.desc(), ExerciseSet.set_number.asc())
    ).all()

    grouped: dict[int, list[ExerciseSet]] = defaultdict(list)
    session_dates: dict[int, date] = {}

    for sess, _, ex_set in rows:
        grouped[sess.id].append(ex_set)
        session_dates[sess.id] = sess.workout_date

    history = []
    for sess_id, sets in grouped.items():
        completed = [s for s in sets if s.completed]
        if not completed:
            continue

        weights = [s.actual_weight_lbs for s in completed if s.actual_weight_lbs is not None]
        reps = [s.actual_reps for s in completed if s.actual_reps is not None]
        completion_rate = len(completed) / max(1, len(sets))

        history.append(
            {
                "session_id": sess_id,
                "date": session_dates[sess_id],
                "avg_weight": round(mean(weights), 2) if weights else None,
                "avg_reps": round(mean(reps), 1) if reps else 0,
                "completion_rate": round(completion_rate, 2),
            }
        )

    history.sort(key=lambda x: x["date"], reverse=True)
    return history[:limit_sessions]


def _get_active_goal(db: Session, user_id: int) -> UserGoal:
    goal = db.exec(
        select(UserGoal).where(
            UserGoal.user_id == user_id,
            UserGoal.is_active == True,
        )
    ).first()
    if not goal:
        raise ValueError("User has no active goal")
    return goal


def _get_preferences(db: Session, user_id: int) -> UserPreferences | None:
    return db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()


def _build_split(days_per_week: int) -> list[list[MuscleGroup]]:
    return SPLIT_BY_DAYS.get(days_per_week, SPLIT_BY_DAYS[DEFAULT_DAYS])