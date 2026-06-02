"""Nutrition day completeness classification.

The app can know two different things:
  - what the user logged
  - whether that log should be treated as a complete picture of the day

This module keeps that distinction explicit so sparse food logs don't get
mistaken for true low intake in readiness, recovery flags, and coach rollups.
"""
from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from typing import Any

from sqlmodel import select

from app.models import Meal, MealItem, PlanDay, PlanWeek, UserDayState

logger = logging.getLogger(__name__)


STATUS_UNKNOWN = "unknown"
STATUS_PARTIAL = "partial"
STATUS_ROUGH = "rough_estimate"
STATUS_COMPLETE = "complete"

VALID_NUTRITION_LOG_STATUSES = {
    STATUS_UNKNOWN,
    STATUS_PARTIAL,
    STATUS_ROUGH,
    STATUS_COMPLETE,
}
USABLE_NUTRITION_LOG_STATUSES = {STATUS_ROUGH, STATUS_COMPLETE}

# What the status (and any usable intake number) is grounded in. Lets callers
# tell a real logged calorie total apart from a complete-by-plan-check day that
# happens to carry zero logged calories.
INTAKE_BASIS_LOGGED = "logged_totals"  # inferred from logged meals/items
INTAKE_BASIS_EXPLICIT = "explicit"     # user-confirmed / manual status
INTAKE_BASIS_PLAN_CHECKS = "plan_checks"  # full set of planned meals checked off
INTAKE_BASIS_EMPTY = "empty"           # no usable data


@dataclass(frozen=True)
class NutritionDayCompleteness:
    status: str
    confidence: float
    source: str
    reason: str
    meals_logged: int = 0
    expected_meals: int = 0
    logged_calories: float = 0.0
    calorie_target: float | None = None
    intake_basis: str = INTAKE_BASIS_LOGGED

    @property
    def usable_for_recovery(self) -> bool:
        return self.status in USABLE_NUTRITION_LOG_STATUSES

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["usable_for_recovery"] = self.usable_for_recovery
        return data


def normalize_nutrition_log_status(value: Any) -> str | None:
    raw = str(value or "").strip().lower()
    if raw in {"rough", "estimate", "estimated", "rough-estimate"}:
        raw = STATUS_ROUGH
    if raw in VALID_NUTRITION_LOG_STATUSES:
        return raw
    return None


def nutrition_log_status_confidence(status: str | None) -> float:
    return {
        STATUS_COMPLETE: 1.0,
        STATUS_ROUGH: 0.7,
        STATUS_PARTIAL: 0.35,
        STATUS_UNKNOWN: 0.0,
    }.get(normalize_nutrition_log_status(status) or STATUS_UNKNOWN, 0.0)


def _meal_stable_ids(meal: dict) -> set[str]:
    """Stable identifiers a meal dict may carry, used to match removedMealIds."""
    ids: set[str] = set()
    for key in ("id", "meal_id", "mealId"):
        value = meal.get(key)
        if value is not None and str(value).strip():
            ids.add(str(value))
    return ids


def _active_plan_meals(plan: dict | None) -> list[dict]:
    if not isinstance(plan, dict):
        return []
    raw = plan.get("meals")
    if isinstance(raw, list):
        meals = [m for m in raw if isinstance(m, dict)]
    else:
        meals = [
            plan[k] for k in ("breakfast", "lunch", "dinner", "snack")
            if isinstance(plan.get(k), dict)
        ]
    removed = {str(v) for v in (plan.get("removedMealIds") or [])}
    if not removed:
        return meals
    kept: list[dict] = []
    for idx, meal in enumerate(meals):
        if str(idx) in removed or f"meal_{idx}" in removed:
            continue
        if _meal_stable_ids(meal) & removed:
            continue
        kept.append(meal)
    return kept


def _plan_has_meals(plan: dict | None) -> bool:
    return bool(_active_plan_meals(plan))


def _get_day_state(db: Any, user_id: int, target_date: date) -> UserDayState | None:
    try:
        return db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == user_id)
            .where(UserDayState.day_key == target_date)
        ).first()
    except Exception:
        logger.exception(
            "_get_day_state failed; treating day as having no state "
            "(user_id=%s, target_date=%s)",
            user_id, target_date,
        )
        return None


def _get_projected_plan(db: Any, user_id: int, target_date: date, state: UserDayState | None) -> dict | None:
    if state and _plan_has_meals(state.nutrition_plan):
        return state.nutrition_plan
    try:
        week = db.exec(
            select(PlanWeek)
            .where(PlanWeek.user_id == user_id)
            .where(PlanWeek.status == "active")
            .where(PlanWeek.start_date <= target_date)
            .where(PlanWeek.end_date >= target_date)
            .order_by(PlanWeek.created_at.desc())
        ).first()
        if week:
            day = db.exec(
                select(PlanDay)
                .where(PlanDay.plan_week_id == week.id)
                .where(PlanDay.day_date == target_date)
            ).first()
            if day and _plan_has_meals(day.nutrition_json):
                return day.nutrition_json
    except Exception:
        logger.exception(
            "_get_projected_plan failed; treating day as having no plan "
            "(user_id=%s, target_date=%s)",
            user_id, target_date,
        )
    return None


def _logged_totals(db: Any, user_id: int, target_date: date) -> tuple[float, int]:
    try:
        from app.services.nutrition.meal_history import dedupe_meals_for_aggregation
        meals = db.exec(
            select(Meal)
            .where(Meal.user_id == user_id)
            .where(Meal.meal_date == target_date)
        ).all()
        meal_ids = [m.id for m in meals]
        if not meal_ids:
            return 0.0, 0
        items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
        items_by_meal: dict[int, list[MealItem]] = {}
        for item in items:
            items_by_meal.setdefault(item.meal_id, []).append(item)
        meals = dedupe_meals_for_aggregation(meals, items_by_meal)
        kept_ids = {m.id for m in meals}
        calories = sum(float(i.calories or 0) for i in items if i.meal_id in kept_ids)
        return calories, len(meals)
    except Exception:
        logger.exception(
            "_logged_totals failed; treating day as having no logged intake "
            "(user_id=%s, target_date=%s)",
            user_id, target_date,
        )
        return 0.0, 0


def _target_from_plan(plan: dict | None) -> float | None:
    targets = plan.get("targets") if isinstance(plan, dict) and isinstance(plan.get("targets"), dict) else {}
    for key in ("calories", "calories_target", "calorie_target"):
        raw = targets.get(key)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            return value
    return None


def _checked_planned_meals(state: UserDayState | None, expected_meals: int) -> int:
    if not state or not isinstance(state.meal_checks, dict):
        return 0
    checked = 0
    for idx in range(expected_meals):
        if state.meal_checks.get(f"meal_{idx}") is True:
            checked += 1
    return checked


def _is_rough_log(
    logged_calories: float,
    meals_logged: int,
    expected_meals: int,
    calorie_ratio: float | None,
) -> bool:
    """Whether logged totals cover enough of the day to be a rough estimate."""
    if calorie_ratio is not None:
        # Strong signal: most of the calorie target across a couple of meals.
        if calorie_ratio >= 0.75 and meals_logged >= 2:
            return True
        # Full planned-meal coverage only counts when a real share of the target
        # was logged, so a few tiny meal records can't pass as good coverage.
        if expected_meals > 0 and meals_logged >= expected_meals and calorie_ratio >= 0.5:
            return True
        return False
    # No calorie target: lean on absolute calorie floors.
    if expected_meals > 0 and meals_logged >= expected_meals and logged_calories >= 900:
        return True
    if logged_calories >= 1200 and meals_logged >= 1:
        return True
    if logged_calories >= 1800 and meals_logged == 0:
        return True
    return False


def _logged_total_status(
    logged_calories: float,
    meals_logged: int,
    expected_meals: int,
    calorie_target: float | None,
) -> str:
    """Infer a status from logged meals/calories alone.

    Returns STATUS_UNKNOWN (no usable data), STATUS_ROUGH (good coverage), or
    STATUS_PARTIAL (some data but coverage looks incomplete).
    """
    if meals_logged <= 0 and logged_calories <= 0:
        return STATUS_UNKNOWN
    calorie_ratio = (
        logged_calories / calorie_target
        if calorie_target and calorie_target > 0
        else None
    )
    if _is_rough_log(logged_calories, meals_logged, expected_meals, calorie_ratio):
        return STATUS_ROUGH
    return STATUS_PARTIAL


def classify_nutrition_day_from_context(
    *,
    state: UserDayState | None = None,
    plan: dict | None = None,
    logged_calories: float | None = None,
    meals_logged: int | None = None,
    calorie_target: float | None = None,
) -> NutritionDayCompleteness:
    """Classify one day from already-loaded context.

    Used by batched rollup jobs so day completeness does not reintroduce
    day-by-day DB reads.
    """
    if state and _plan_has_meals(state.nutrition_plan):
        plan = state.nutrition_plan
    planned_meals = _active_plan_meals(plan)
    expected_meals = len(planned_meals)

    if calorie_target is None:
        calorie_target = _target_from_plan(plan)
    logged_calories = float(logged_calories or 0)
    meals_logged = int(meals_logged or 0)

    explicit = normalize_nutrition_log_status(getattr(state, "nutrition_log_status", None))
    if explicit and explicit != STATUS_UNKNOWN:
        return NutritionDayCompleteness(
            status=explicit,
            confidence=nutrition_log_status_confidence(explicit),
            source=getattr(state, "nutrition_log_status_source", None) or "explicit",
            reason="User-confirmed nutrition log status.",
            meals_logged=meals_logged,
            expected_meals=expected_meals,
            logged_calories=logged_calories,
            calorie_target=calorie_target,
            intake_basis=INTAKE_BASIS_EXPLICIT,
        )

    checked = _checked_planned_meals(state, len(planned_meals))
    full_plan_checks = bool(planned_meals) and checked >= len(planned_meals)
    some_plan_checks = bool(planned_meals) and 0 < checked < len(planned_meals)

    # Full plan checks may still imply a complete day. A real logged calorie
    # total grounds the intake number; an all-checked day with zero logged
    # calories must NOT pass that zero off as real intake, so its basis is
    # plan_checks and downstream code can treat the number as unknown.
    if full_plan_checks:
        return NutritionDayCompleteness(
            status=STATUS_COMPLETE,
            confidence=0.95,
            source="plan_checks",
            reason="Every planned meal was checked off.",
            meals_logged=meals_logged,
            expected_meals=len(planned_meals),
            logged_calories=logged_calories,
            calorie_target=calorie_target,
            intake_basis=(
                INTAKE_BASIS_LOGGED if logged_calories > 0 else INTAKE_BASIS_PLAN_CHECKS
            ),
        )

    inferred = _logged_total_status(
        logged_calories, meals_logged, expected_meals, calorie_target
    )

    if inferred == STATUS_ROUGH:
        return NutritionDayCompleteness(
            status=STATUS_ROUGH,
            confidence=0.7,
            source="logged_totals",
            reason="Logged intake covers most of the day, but was not explicitly marked complete.",
            meals_logged=meals_logged,
            expected_meals=expected_meals,
            logged_calories=logged_calories,
            calorie_target=calorie_target,
            intake_basis=INTAKE_BASIS_LOGGED,
        )

    # Partial plan checks are supporting evidence, not an automatic partial. We
    # only land here once logged totals failed to reach rough coverage, so the
    # day is genuinely incomplete despite some meals being checked off.
    if some_plan_checks:
        return NutritionDayCompleteness(
            status=STATUS_PARTIAL,
            confidence=0.35,
            source="plan_checks",
            reason="Some planned meals were checked off, but logged coverage still looks incomplete.",
            meals_logged=meals_logged,
            expected_meals=len(planned_meals),
            logged_calories=logged_calories,
            calorie_target=calorie_target,
            intake_basis=INTAKE_BASIS_LOGGED,
        )

    if inferred == STATUS_UNKNOWN:
        return NutritionDayCompleteness(
            status=STATUS_UNKNOWN,
            confidence=0.0,
            source="empty",
            reason="No meals logged for the day.",
            meals_logged=0,
            expected_meals=expected_meals,
            logged_calories=0.0,
            calorie_target=calorie_target,
            intake_basis=INTAKE_BASIS_EMPTY,
        )

    return NutritionDayCompleteness(
        status=STATUS_PARTIAL,
        confidence=0.35,
        source="logged_totals",
        reason="Some nutrition was logged, but coverage looks incomplete.",
        meals_logged=meals_logged,
        expected_meals=expected_meals,
        logged_calories=logged_calories,
        calorie_target=calorie_target,
        intake_basis=INTAKE_BASIS_LOGGED,
    )


def classify_nutrition_day(
    db: Any,
    user_id: int,
    target_date: date,
    *,
    logged_calories: float | None = None,
    meals_logged: int | None = None,
    calorie_target: float | None = None,
) -> NutritionDayCompleteness:
    """Return the explicit or inferred completeness state for one day."""
    state = _get_day_state(db, user_id, target_date)
    plan = _get_projected_plan(db, user_id, target_date, state)
    if logged_calories is None or meals_logged is None:
        inferred_calories, inferred_meals = _logged_totals(db, user_id, target_date)
        if logged_calories is None:
            logged_calories = inferred_calories
        if meals_logged is None:
            meals_logged = inferred_meals
    return classify_nutrition_day_from_context(
        state=state,
        plan=plan,
        logged_calories=logged_calories,
        meals_logged=meals_logged,
        calorie_target=calorie_target,
    )


def set_user_day_nutrition_status(
    state: UserDayState,
    status: str | None,
    *,
    source: str | None = None,
) -> None:
    normalized = normalize_nutrition_log_status(status) or STATUS_UNKNOWN
    if normalized == STATUS_UNKNOWN:
        state.nutrition_log_status = None
        state.nutrition_log_status_source = None
        state.nutrition_log_status_updated_at = None
        return
    state.nutrition_log_status = normalized
    state.nutrition_log_status_source = (source or "manual").strip() or "manual"
    state.nutrition_log_status_updated_at = datetime.now(timezone.utc)
