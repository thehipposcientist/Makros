"""Regression: editing a logged meal must update it in place, never duplicate.

Reported bug: editing the *time* of a manually-added final meal created a
second copy on save. Cause — the edit re-logs as `plan_check` (source
GENERATED) while the original was `manual_add` (source LOGGED); the dedup was
source-filtered and missed the original, so it appended a duplicate. The fix
matches an existing row by its per-day slot key (`client_meal_key`) across
sources.

Run:
    docker exec thallo-backend python -m tests.test_meal_log_dedup
"""
from __future__ import annotations

from datetime import date, datetime, timezone

from sqlmodel import Session, select

from tests._seed_helpers import make_seed_test_engine


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _user(session: Session):
    from app.models import User
    u = User(email="meal-dedup@example.com", username="meal-dedup", hashed_password="x")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


MEAL_DATA = {
    "meal": "Late night yogurt bowl",
    "items": [
        {"name": "greek yogurt", "quantity": 1, "unit": "cup", "calories": 150, "protein": 22, "carbs": 9, "fat": 4},
        {"name": "blueberries", "quantity": 0.5, "unit": "cup", "calories": 40, "protein": 0, "carbs": 11, "fat": 0},
    ],
}


def test_editing_time_of_manual_meal_does_not_duplicate():
    """The exact reported bug: add a final meal, then edit its time."""
    from app.models import Meal
    from app.services.nutrition.meal_history import log_meal_from_plan
    engine = make_seed_test_engine()
    with Session(engine) as session:
        user = _user(session)
        d = date(2026, 5, 10)
        # 1) Add a final meal manually (source manual_add → LOGGED), slot meal_4.
        first = log_meal_from_plan(
            user_id=user.id, meal_date=d, meal_type="meal_4",
            meal_data=MEAL_DATA, source="manual_add",
            consumed_at=datetime(2026, 5, 10, 21, 30, tzinfo=timezone.utc), db=session,
        )
        # 2) Edit just the time — the app re-logs as plan_check, same slot/name/items.
        second = log_meal_from_plan(
            user_id=user.id, meal_date=d, meal_type="meal_4",
            meal_data=MEAL_DATA, source="plan_check",
            consumed_at=datetime(2026, 5, 10, 20, 15, tzinfo=timezone.utc), db=session,
        )
        rows = session.exec(
            select(Meal).where(Meal.user_id == user.id).where(Meal.meal_date == d)
        ).all()
        assert len(rows) == 1, f"expected 1 meal after time edit, got {len(rows)} (duplicate)"
        assert second["id"] == first["id"], "edit should replace the original row, not create a new one"
        assert rows[0].consumed_at.hour == 20 and rows[0].consumed_at.minute == 15, \
            "consumed_at should reflect the edited time"
        _ok("editing the time of a manual meal updates in place (no duplicate)")


def test_repeated_plan_check_same_slot_stays_single():
    """Sanity: re-checking the same plan slot still dedupes (unchanged behavior)."""
    from app.models import Meal
    from app.services.nutrition.meal_history import log_meal_from_plan
    engine = make_seed_test_engine()
    with Session(engine) as session:
        user = _user(session)
        d = date(2026, 5, 11)
        for _ in range(2):
            log_meal_from_plan(
                user_id=user.id, meal_date=d, meal_type="meal_0",
                meal_data=MEAL_DATA, source="plan_check", db=session,
            )
        rows = session.exec(
            select(Meal).where(Meal.user_id == user.id).where(Meal.meal_date == d)
        ).all()
        assert len(rows) == 1, f"expected 1 meal, got {len(rows)}"
        _ok("repeated plan_check of the same slot stays single")


def test_distinct_slots_are_not_merged():
    """Two different meals in different slots must remain two rows."""
    from app.models import Meal
    from app.services.nutrition.meal_history import log_meal_from_plan
    engine = make_seed_test_engine()
    with Session(engine) as session:
        user = _user(session)
        d = date(2026, 5, 12)
        log_meal_from_plan(user_id=user.id, meal_date=d, meal_type="meal_0",
                           meal_data={"meal": "Breakfast", "items": MEAL_DATA["items"]},
                           source="plan_check", db=session)
        log_meal_from_plan(user_id=user.id, meal_date=d, meal_type="meal_4",
                           meal_data={"meal": "Snack", "items": MEAL_DATA["items"]},
                           source="manual_add", db=session)
        rows = session.exec(
            select(Meal).where(Meal.user_id == user.id).where(Meal.meal_date == d)
        ).all()
        assert len(rows) == 2, f"distinct slots must stay separate, got {len(rows)}"
        _ok("distinct slots are not merged")


ALL_TESTS = [v for k, v in list(globals().items()) if k.startswith("test_")]


def run_all():
    passed = 0
    failed = 0
    for fn in ALL_TESTS:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
    total = passed + failed
    print(f"test_meal_log_dedup: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)
