"""Shared test data builders for the Thallo backend test suite.

Every builder returns plain dicts (not ORM models) so tests stay
pure-function and DB-free. Sensible defaults let tests override only
the fields they care about.

Usage:
    from tests.conftest import (
        make_planner_inputs, make_user_profile, make_exercise,
        make_exercises_for_focus, make_completion, make_completion_history,
        make_daily_nutrition_metrics, GOAL_MATRIX, SPLIT_MATRIX,
        DAYS_MATRIX, matrix_sweep,
    )
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterator


# ═══════════════════════════════════════════════════════════════════════
# 8. Matrix constants
# ═══════════════════════════════════════════════════════════════════════

GOAL_MATRIX: list[str] = [
    "fat_loss", "muscle_gain", "body_recomp", "strength", "endurance",
    "athletic_performance", "hyrox", "toning", "maintain",
    "general_health", "longevity", "flexibility", "stress_relief",
]

SPLIT_MATRIX: list[str] = [
    "ppl", "upper_lower", "full_body", "bro", "ppl_ul_hybrid",
]

DAYS_MATRIX: list[int] = [3, 4, 5, 6, 7]


# ═══════════════════════════════════════════════════════════════════════
# 9. matrix_sweep
# ═══════════════════════════════════════════════════════════════════════

def matrix_sweep(
    goals: list[str] | None = None,
    splits: list[str] | None = None,
    days: list[int] | None = None,
) -> Iterator[tuple[str, str, int]]:
    """Yield (goal, split, days) tuples for matrix-style testing.

    Defaults to the full cross-product of GOAL_MATRIX x SPLIT_MATRIX x
    DAYS_MATRIX. Pass subsets to narrow the sweep.
    """
    for goal in (goals or GOAL_MATRIX):
        for split in (splits or SPLIT_MATRIX):
            for d in (days or DAYS_MATRIX):
                yield (goal, split, d)


# ═══════════════════════════════════════════════════════════════════════
# 1. make_planner_inputs
# ═══════════════════════════════════════════════════════════════════════

_DEFAULT_EQUIPMENT = ("barbell", "dumbbell", "cables", "pull_up_bar", "bench")


def make_planner_inputs(**overrides) -> dict:
    """Build a dict matching the shape PlannerInputs / generate_weekly_recipe
    / generate_workout_plan expect.

    All fields overridable via kwargs. Tuple fields accept lists too (auto-
    converted).
    """
    defaults = {
        "goal": "muscle_gain",
        "days_per_week": 5,
        "session_minutes": 60,
        "experience": "intermediate",
        "equipment_slugs": _DEFAULT_EQUIPMENT,
        "preferred_split": "ppl",
        "focused_muscle": None,
        "priority_region": "balanced",
        "preferred_exercises": (),
        "disliked_exercises": (),
        "injuries": (),
        "rng_seed": 0,
        "recent_focus_buckets": [],
        "recent_focus_families": [],
        "muscle_fatigue": {},
        "completed_today_family": None,
        "user_age": None,
    }
    merged = {**defaults, **overrides}

    # Normalize list → tuple for fields PlannerInputs declares as tuple
    _TUPLE_FIELDS = (
        "equipment_slugs", "preferred_exercises",
        "disliked_exercises", "injuries",
        "recent_focus_buckets", "recent_focus_families",
    )
    for k in _TUPLE_FIELDS:
        v = merged.get(k)
        if isinstance(v, list):
            merged[k] = tuple(v)

    return merged


# ═══════════════════════════════════════════════════════════════════════
# 2. make_user_profile
# ═══════════════════════════════════════════════════════════════════════

def make_user_profile(**overrides) -> dict:
    """Simulate a user profile dict. No ORM, just plain data."""
    defaults = {
        "age": 28,
        "weight_lbs": 180,
        "height_inches": 70,
        "sex": "male",
        "experience": "intermediate",
        "goal": "muscle_gain",
        "days_per_week": 5,
        "session_minutes": 60,
        "allergies": [],
        "injuries": [],
        "equipment_slugs": list(_DEFAULT_EQUIPMENT),
        "preferred_split": "ppl",
        "body_fat_pct": None,
        "target_weight_lbs": None,
        "pace": "moderate",
        "meal_routine": "standard",
    }
    return {**defaults, **overrides}


# ═══════════════════════════════════════════════════════════════════════
# 3. make_exercise
# ═══════════════════════════════════════════════════════════════════════

# Reasonable secondary-muscle defaults keyed by primary muscle.
_DEFAULT_SECONDARIES: dict[str, list[str]] = {
    "chest":      ["triceps", "shoulders"],
    "back":       ["biceps"],
    "shoulders":  ["triceps"],
    "biceps":     [],
    "triceps":    [],
    "quads":      ["glutes", "hamstrings"],
    "hamstrings": ["glutes"],
    "glutes":     ["hamstrings"],
    "calves":     [],
    "core":       [],
    "cardio":     [],
}

# Whether exercises for this muscle are typically compound.
_DEFAULT_COMPOUND: dict[str, bool] = {
    "chest": True, "back": True, "shoulders": False,
    "biceps": False, "triceps": False, "quads": True,
    "hamstrings": False, "glutes": True, "calves": False,
    "core": False, "cardio": False,
}


def make_exercise(name: str, primary_muscle: str, **overrides) -> dict:
    """Build a single exercise dict matching the planner/seed shape.

    Defaults are chosen to be realistic for the given primary_muscle.
    """
    defaults = {
        "name": name,
        "slug": name.lower().replace(" ", "_").replace("-", "_"),
        "primary_muscle": primary_muscle,
        "secondary_muscles": _DEFAULT_SECONDARIES.get(primary_muscle, []),
        "is_compound": _DEFAULT_COMPOUND.get(primary_muscle, False),
        "equipment_bucket": "gym",
        "movement_pattern": "compound" if _DEFAULT_COMPOUND.get(primary_muscle) else "isolation",
        "exercise_type": "strength",
        "is_machine": False,
        "is_unilateral": False,
        "equipment": [{"slug": "barbell", "role": "primary", "required": True}],
        "description": f"Test exercise: {name}",
    }
    return {**defaults, **overrides}


# ═══════════════════════════════════════════════════════════════════════
# 4. make_exercises_for_focus
# ═══════════════════════════════════════════════════════════════════════

# Realistic exercise lists keyed by focus. Names drawn from SEED_EXERCISES
# where possible. Each entry: (name, primary_muscle, is_compound, sets_spec)
# sets_spec = list of (reps, weight_lbs, rir)

_FOCUS_EXERCISES: dict[str, list[tuple[str, str, bool, list[tuple[int, float, int]]]]] = {
    "push": [
        ("Barbell Bench Press", "chest", True,
         [(8, 185, 2), (8, 185, 2), (8, 185, 1)]),
        ("Overhead Press", "shoulders", True,
         [(10, 95, 2), (10, 95, 2), (10, 95, 2)]),
        ("Incline Dumbbell Press", "chest", True,
         [(10, 60, 2), (10, 60, 2), (10, 60, 2)]),
        ("Lateral Raise", "shoulders", False,
         [(12, 20, 2), (12, 20, 2), (12, 20, 2)]),
        ("Tricep Pushdown", "triceps", False,
         [(12, 50, 2), (12, 50, 2), (12, 50, 1)]),
    ],
    "pull": [
        ("Barbell Row", "back", True,
         [(8, 155, 2), (8, 155, 2), (8, 155, 1)]),
        ("Pull-ups", "back", True,
         [(8, 0, 2), (8, 0, 2), (8, 0, 2)]),
        ("Face Pull", "shoulders", False,
         [(15, 30, 2), (15, 30, 2), (15, 30, 2)]),
        ("Barbell Curl", "biceps", False,
         [(10, 65, 2), (10, 65, 2), (10, 65, 1)]),
    ],
    "legs": [
        ("Barbell Squat", "quads", True,
         [(6, 275, 2), (6, 275, 2), (6, 275, 1), (6, 275, 1)]),
        ("Romanian Deadlift", "hamstrings", True,
         [(10, 185, 2), (10, 185, 2), (10, 185, 2)]),
        ("Leg Press", "quads", True,
         [(12, 315, 2), (12, 315, 2), (12, 315, 2)]),
        ("Leg Curl", "hamstrings", False,
         [(12, 90, 2), (12, 90, 2), (12, 90, 2)]),
        ("Standing Calf Raise", "calves", False,
         [(15, 135, 2), (15, 135, 2), (15, 135, 2)]),
    ],
    "upper": [
        ("Barbell Bench Press", "chest", True,
         [(8, 185, 2), (8, 185, 2), (8, 185, 1)]),
        ("Barbell Row", "back", True,
         [(8, 155, 2), (8, 155, 2), (8, 155, 1)]),
        ("Overhead Press", "shoulders", True,
         [(10, 95, 2), (10, 95, 2), (10, 95, 2)]),
        ("Barbell Curl", "biceps", False,
         [(10, 65, 2), (10, 65, 1), (10, 65, 1)]),
        ("Tricep Pushdown", "triceps", False,
         [(12, 50, 2), (12, 50, 2), (12, 50, 1)]),
    ],
    "lower": [
        ("Barbell Squat", "quads", True,
         [(6, 275, 2), (6, 275, 2), (6, 275, 1), (6, 275, 1)]),
        ("Romanian Deadlift", "hamstrings", True,
         [(10, 185, 2), (10, 185, 2), (10, 185, 2)]),
        ("Bulgarian Split Squat", "quads", True,
         [(10, 50, 2), (10, 50, 2), (10, 50, 2)]),
        ("Leg Curl", "hamstrings", False,
         [(12, 90, 2), (12, 90, 2), (12, 90, 2)]),
        ("Standing Calf Raise", "calves", False,
         [(15, 135, 2), (15, 135, 2), (15, 135, 2)]),
    ],
    "full_body": [
        ("Barbell Squat", "quads", True,
         [(6, 225, 2), (6, 225, 2), (6, 225, 1)]),
        ("Barbell Bench Press", "chest", True,
         [(8, 165, 2), (8, 165, 2), (8, 165, 1)]),
        ("Barbell Row", "back", True,
         [(8, 155, 2), (8, 155, 2), (8, 155, 1)]),
        ("Overhead Press", "shoulders", True,
         [(10, 85, 2), (10, 85, 2), (10, 85, 2)]),
    ],
    "cardio": [
        ("Treadmill Running", "cardio", False,
         [(1, 0, 0)]),  # single "set" placeholder for cardio
    ],
    "recovery": [
        ("Foam Rolling", "core", False,
         [(1, 0, 0)]),
    ],
    "mobility": [
        ("Thoracic Rotation", "core", False,
         [(1, 0, 0)]),
    ],
}

# Aliases so callers can use capitalized or variant focus names
_FOCUS_ALIASES: dict[str, str] = {
    "Push": "push", "Pull": "pull", "Legs": "legs",
    "Upper": "upper", "Lower": "lower", "Full Body": "full_body",
    "full body": "full_body", "Cardio": "cardio",
    "Recovery": "recovery", "Mobility": "mobility",
    "chest": "push", "back": "pull",  # coarse mapping
    "shoulders": "push", "arms": "push",
}


def make_exercises_for_focus(focus: str) -> list[dict]:
    """Return 4-6 realistic exercise dicts for the given focus.

    Each exercise includes a `sets` list with realistic (reps, weight_lbs,
    rir) tuples so fatigue resolution and set programming tests get real data.
    """
    key = _FOCUS_ALIASES.get(focus, focus.lower())
    specs = _FOCUS_EXERCISES.get(key)
    if specs is None:
        raise ValueError(
            f"Unknown focus {focus!r}. Known: {sorted(_FOCUS_EXERCISES.keys())}"
        )
    exercises = []
    for name, primary, compound, sets_spec in specs:
        ex = make_exercise(name, primary, is_compound=compound)
        ex["sets"] = [
            {"reps": r, "weight_lbs": w, "rir": rir}
            for r, w, rir in sets_spec
        ]
        ex["sets_logged"] = len(ex["sets"])
        exercises.append(ex)
    return exercises


# ═══════════════════════════════════════════════════════════════════════
# 5. make_completion
# ═══════════════════════════════════════════════════════════════════════

def make_completion(focus: str, days_ago: int = 0, **overrides) -> dict:
    """Build a completion dict matching the shape compute_rolling_fatigue expects.

    workout_date is derived from days_ago relative to today (or the
    caller-supplied `today` override).
    """
    base_date = overrides.pop("today", None) or date.today()
    workout_date = base_date - timedelta(days=days_ago)

    defaults = {
        "workout_date": workout_date,
        "focus_label": focus,
        "duration_seconds": 3600,
        "stimulus": "hypertrophy",
        "resolved_muscle_fatigue": None,
        "activity_intensity": "moderate",
        "activity_category": "strength",
        "activity_subtype": None,
        "completed_at": None,
    }
    return {**defaults, **overrides}


# ═══════════════════════════════════════════════════════════════════════
# 6. make_completion_history
# ═══════════════════════════════════════════════════════════════════════

def make_completion_history(
    focuses: list[str],
    start_days_ago: int | None = None,
) -> list[dict]:
    """Build a multi-day completion history from a list of focus labels.

    Each entry in `focuses` maps to one day. "Rest" (case-insensitive) entries
    are skipped (no completion generated). Non-rest days get
    `resolved_muscle_fatigue` computed via `resolve_exercise_fatigue` using
    exercises from `make_exercises_for_focus`.

    `start_days_ago` defaults to `len(focuses) - 1` so the last entry is
    today. Pass explicitly to shift the window.

    Example:
        make_completion_history(["Push", "Pull", "Legs", "Rest", "Upper"])
        # → 4 completions spanning 5 days (rest day skipped)
    """
    from app.services.workout.activity_impact import resolve_exercise_fatigue

    n = len(focuses)
    if start_days_ago is None:
        start_days_ago = n - 1

    today = date.today()
    completions = []

    for i, focus in enumerate(focuses):
        days_ago = start_days_ago - i
        if focus.lower() == "rest":
            continue

        # Resolve fatigue from realistic exercises for this focus
        focus_key = _FOCUS_ALIASES.get(focus, focus.lower())
        try:
            exercises = make_exercises_for_focus(focus_key)
            muscle_fatigue = resolve_exercise_fatigue(exercises)
        except (ValueError, Exception):
            # Fallback: let compute_rolling_fatigue derive from focus label
            muscle_fatigue = None

        comp = make_completion(
            focus=focus,
            days_ago=days_ago,
            today=today,
            resolved_muscle_fatigue=muscle_fatigue,
        )
        completions.append(comp)

    return completions


# ═══════════════════════════════════════════════════════════════════════
# 7. make_daily_nutrition_metrics
# ═══════════════════════════════════════════════════════════════════════

def make_daily_nutrition_metrics(**overrides) -> dict:
    """Build a daily nutrition metrics dict. Realistic defaults for
    an active 180 lb male on a muscle-gain plan."""
    defaults = {
        "calories": 2200,
        "protein_g": 180,
        "carbs_g": 250,
        "fat_g": 70,
        "fiber_g": 30,
        "added_sugar_g": 15,
        "sodium_mg": 2200,
        "sat_fat_g": 18,
        "distinct_plant_foods": 8,
        "fermented_servings": 1,
        "probiotic_servings": 0.5,
        "omega3_servings": 0,
        "seafood_servings": 0,
        "fruit_servings": 2,
        "vegetable_servings": 3,
        "alcohol_servings": 0,
        "processed_meat_servings": 0,
        "refined_grain_servings": 1,
        "plant_protein_g": 40,
        "animal_protein_g": 140,
        "minimally_processed_count": 8,
        "processed_count": 3,
        "ultra_processed_count": 1,
        "max_meal_protein_pct": 0.35,
        "energy_availability": None,
        "recovery_flags": None,
    }
    return {**defaults, **overrides}
