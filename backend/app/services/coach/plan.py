"""Active-plan snapshot helper.

Given a user_id, returns the currently effective calorie / macro targets and
a compact plan dict that goes into the AI check-in payload.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlmodel import Session

from app.services.nutrition.targets import resolve_targets_for_user


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


def get_plan_snapshot(db: Session, user_id: int) -> PlanSnapshot | None:
    """Return the current effective plan, or None if the user hasn't onboarded."""
    targets = resolve_targets_for_user(db, user_id, include_health=False)
    if not targets:
        return None

    return PlanSnapshot(
        kcal=int(targets.calories),
        protein_g=int(targets.protein_g),
        carbs_g=int(targets.carbs_g),
        fat_g=int(targets.fat_g),
        goal_type=targets.goal_type,
        goal_pace=targets.goal_pace,
        days_per_week=targets.days_per_week,
        tdee=int(targets.tdee),
        coaching_kcal_adjustment=int(targets.coaching_adjustment_kcal),
        goal_bucket=targets.bucket_name,
    )
