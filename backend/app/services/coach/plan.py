"""Active-plan snapshot helper.

Given a user_id, returns the *currently effective* calorie / macro targets and
a compact plan dict that goes into the AI check-in payload. Mirrors the math
in `app/routers/ai/utils.compute_tdee_and_targets` but reads from DB state
instead of a PlanRequest, and layers in `UserCoachingState.calorie_adjustment`.

We deliberately keep this self-contained instead of refactoring the existing
plan-generation helper — that function is a big switch over the full goal
taxonomy and is called at different points in the lifecycle. Duplicating the
small slice we need here is safer than coupling check-ins to plan generation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from sqlmodel import Session, select

from app.models import (
    UserCoachingState,
    UserGoal,
    UserPreferences,
    UserProfile,
)

_MIN_CALORIES = 1200

_DEFICIT_GOALS = {"fat_loss", "toning", "lose_fat", "get_lean", "cut", "preserve_muscle_cutting"}
_SURPLUS_GOALS = {
    "muscle_gain", "build_muscle", "lean_bulk", "gain_weight", "improve_aesthetics",
    "build_glutes", "build_upper_body", "build_lower_body", "build_arms", "build_shoulders",
}
_RECOMP_GOALS = {"body_recomp", "maintain", "maintain_physique"}
_STRENGTH_GOALS = {"strength", "build_strength", "powerlifting"}
_ENDURANCE_GOALS = {"endurance", "improve_cardio", "aerobic_base"}

# Pace-based daily calorie adjustment (kept in sync with routers/ai/utils.py).
_PACE_ADJUSTMENTS: dict[str, dict[str, int]] = {
    "fat_loss":    {"conservative": -250, "moderate": -500, "aggressive": -750},
    "muscle_gain": {"conservative":  150, "moderate":  300, "aggressive":  500},
    "body_recomp": {"conservative": -100, "moderate":    0, "aggressive":  100},
    "strength":    {"conservative":  200, "moderate":  350, "aggressive":  500},
    "endurance":   {"conservative":  100, "moderate":  200, "aggressive":  300},
}


@dataclass
class PlanSnapshot:
    kcal: int
    protein_g: int
    carbs_g: int
    fat_g: int
    goal_type: str | None
    goal_pace: str | None
    days_per_week: int
    tdee: int
    coaching_kcal_adjustment: int
    goal_bucket: str


def _goal_bucket(goal_type: str | None) -> str:
    if not goal_type:
        return "body_recomp"
    if goal_type in _DEFICIT_GOALS:
        return "fat_loss"
    if goal_type in _SURPLUS_GOALS:
        return "muscle_gain"
    if goal_type in _RECOMP_GOALS:
        return "body_recomp"
    if goal_type in _STRENGTH_GOALS:
        return "strength"
    if goal_type in _ENDURANCE_GOALS:
        return "endurance"
    return "body_recomp"


def _protein_per_lb(bucket: str) -> float:
    if bucket in {"muscle_gain", "body_recomp", "strength"}:
        return 1.0
    if bucket == "fat_loss":
        return 0.9
    if bucket == "endurance":
        return 0.8
    return 0.85


def get_plan_snapshot(db: Session, user_id: int) -> PlanSnapshot | None:
    """Return the current effective plan, or None if the user hasn't onboarded."""
    profile = db.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    if not profile:
        return None
    goal = db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()
    prefs = db.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    coaching = db.exec(
        select(UserCoachingState).where(UserCoachingState.user_id == user_id)
    ).first()

    weight_kg = profile.weight_lbs / 2.205
    height_cm = (profile.height_feet * 12 + profile.height_inches) * 2.54
    base = 10 * weight_kg + 6.25 * height_cm - 5 * profile.age
    gender_value = profile.gender.value if hasattr(profile.gender, "value") else str(profile.gender)
    if gender_value == "male":
        bmr = base + 5
    elif gender_value == "female":
        bmr = base - 161
    else:
        bmr = base - 78

    days_per_week = prefs.days_per_week if prefs else 3
    if days_per_week <= 1:
        activity = 1.2
    elif days_per_week <= 3:
        activity = 1.375
    elif days_per_week <= 5:
        activity = 1.55
    else:
        activity = 1.725
    tdee = round(bmr * activity)

    goal_type = goal.goal_type.value if goal else None
    pace_value = goal.pace.value if goal else None
    bucket = _goal_bucket(goal_type)
    pace_adj = _PACE_ADJUSTMENTS.get(bucket, {}).get(pace_value or "moderate", 0)

    coaching_adj = coaching.calorie_adjustment if coaching else 0
    kcal = max(_MIN_CALORIES, tdee + pace_adj + coaching_adj)

    protein_g = round(profile.weight_lbs * _protein_per_lb(bucket))
    protein_cals = protein_g * 4
    fat_floor_g = math.ceil(profile.weight_lbs * 0.3)
    fat_target_cal = max(fat_floor_g * 9, round(kcal * 0.30))
    fat_g = round(fat_target_cal / 9)
    carb_cals = kcal - protein_cals - (fat_g * 9)
    carbs_g = max(0, round(carb_cals / 4))

    return PlanSnapshot(
        kcal=int(kcal),
        protein_g=int(protein_g),
        carbs_g=int(carbs_g),
        fat_g=int(fat_g),
        goal_type=goal_type,
        goal_pace=pace_value,
        days_per_week=days_per_week,
        tdee=int(tdee),
        coaching_kcal_adjustment=int(coaching_adj),
        goal_bucket=bucket,
    )
