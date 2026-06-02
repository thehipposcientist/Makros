"""Meal-logging refactor: templates vs instances isolation + idempotency.

These tests pin the core write-safety guarantees of the favorites /
routines / daily-logs refactor. They call the router functions directly
against an in-memory SQLite DB (no HTTP, no Docker) and assert the
contracts the product spec requires:

  #1  editing a daily log changes only that log + its items
  #2  editing a daily log does not modify the favorite it came from
  #3  editing a daily log does not modify the routine it came from
  #4  logging a favorite creates exactly one meal_log
  #5  double "log favorite" with one idempotency_key creates one log
  #6  editing a favorite updates the favorite + creates zero logs
  #8  editing a routine updates the same routine id (no duplicate)
  #9  changing a routine time updates the schedule (no duplicate)
  #10 logging a routine occurrence creates exactly one meal_log
  #11 logging the same occurrence twice de-dupes to one
  #12 editing one day's occurrence affects only that date
  #13 historical logs do not change when a template is edited later
  #14 deleting a routine archives it and keeps historical logs traceable

(#7 "favorite time change" is intentionally moot — favorites are
time-less by product decision; time lives on routines / logs.)
"""
from __future__ import annotations

from datetime import date


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _engine():
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    import app.models  # noqa: F401 — registers every table on the shared metadata

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _user(session, email: str = "meal_iso@example.com", subscription_tier: str = "pro"):
    from app.models import User
    u = User(
        email=email,
        username=email.split("@")[0],
        hashed_password="x",
        subscription_tier=subscription_tier,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _food(session, user_id: int, name: str = "Eggs"):
    from app.enums import FoodCategory, FoodSource
    from app.models import Food
    f = Food(
        name=name, normalized_name=name.lower(), category=FoodCategory.PROTEINS,
        source=FoodSource.AI, owner_user_id=user_id, is_custom=True,
        unit="1 serving", serving_grams=100.0,
        calories=160.0, protein=12.0, carbs=2.0, fat=11.0,
    )
    session.add(f)
    session.commit()
    session.refresh(f)
    return f


def _favorite(session, user_id: int, name: str = "Chicken Bowl"):
    from app.models import SavedMeal
    items = [{"food_name": "Chicken", "quantity": 1, "unit": "serving",
              "calories": 200.0, "protein_g": 40.0, "carbs_g": 0.0, "fat_g": 4.0}]
    sm = SavedMeal(
        user_id=user_id, name=name, items=items,
        total_calories=200.0, total_protein_g=40.0, total_carbs_g=0.0, total_fat_g=4.0,
    )
    session.add(sm)
    session.commit()
    session.refresh(sm)
    return sm


def _count_meals(session, user_id: int) -> int:
    from sqlmodel import select
    from app.models import Meal
    return len(session.exec(select(Meal).where(Meal.user_id == user_id)).all())


def _items_for(session, meal_id: int):
    from sqlmodel import select
    from app.models import MealItem
    return session.exec(select(MealItem).where(MealItem.meal_id == meal_id)).all()


# ─── Favorites: log + isolation + idempotency ─────────────────────────────────

def test_log_favorite_creates_exactly_one_log():  # #4
    from sqlmodel import Session
    from app.routers.saved_meals import log_saved_meal
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        fav = _favorite(s, u.id)
        log_saved_meal(fav.id, {"meal_date": "2026-05-22", "meal_type": "lunch"}, u, s)
        assert _count_meals(s, u.id) == 1
    _ok("logging a favorite creates exactly one meal_log (#4)")


def test_double_log_favorite_same_idempotency_key_creates_one():  # #5
    from sqlmodel import Session
    from app.routers.saved_meals import log_saved_meal
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        fav = _favorite(s, u.id)
        body = {"meal_date": "2026-05-22", "meal_type": "lunch", "idempotency_key": "k-abc-1"}
        r1 = log_saved_meal(fav.id, dict(body), u, s)
        r2 = log_saved_meal(fav.id, dict(body), u, s)
        assert r1["meal_id"] == r2["meal_id"]
        assert _count_meals(s, u.id) == 1
    _ok("double log favorite w/ same idempotency_key creates one log (#5)")


def test_edit_favorite_creates_zero_logs_and_updates_template():  # #6
    from sqlmodel import Session
    from app.routers.saved_meals import update_saved_meal
    from app.models import SavedMeal
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        fav = _favorite(s, u.id)
        update_saved_meal(fav.id, {"name": "Chicken Bowl XL", "items": [
            {"food_name": "Chicken", "quantity": 2, "unit": "serving",
             "calories": 400.0, "protein_g": 80.0, "carbs_g": 0.0, "fat_g": 8.0}]}, u, s)
        s.refresh(fav)
        assert fav.name == "Chicken Bowl XL"
        assert fav.total_calories == 400.0
        assert _count_meals(s, u.id) == 0
    _ok("editing a favorite updates template + creates zero logs (#6)")


def test_edit_log_does_not_mutate_favorite():  # #1 + #2
    from sqlmodel import Session
    from app.routers.saved_meals import log_saved_meal
    from app.routers.meals import update_meal
    from app.models import SavedMeal
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        food = _food(s, u.id)
        fav = _favorite(s, u.id)
        res = log_saved_meal(fav.id, {"meal_date": "2026-05-22", "meal_type": "lunch"}, u, s)
        meal_id = res["meal_id"]
        update_meal(meal_id, {"name": "Chicken Bowl (edited)", "items": [
            {"food_name": "Eggs", "food_id": food.id, "quantity": 2, "unit": "piece",
             "calories": 160.0, "protein_g": 12.0, "carbs_g": 2.0, "fat_g": 11.0}]}, u, s)
        # The favorite template is untouched.
        s.refresh(fav)
        assert fav.name == "Chicken Bowl"
        assert fav.items[0]["food_name"] == "Chicken"
        assert fav.total_calories == 200.0
        # The log row + its items changed.
        items = _items_for(s, meal_id)
        assert len(items) == 1 and items[0].food_name == "Eggs"
        assert _count_meals(s, u.id) == 1
    _ok("editing a daily log changes only the log, not the favorite (#1,#2)")


# ─── Routines: log + isolation + idempotency ──────────────────────────────────

def _routine(session, user_id: int, name: str = "Morning Oats", time: str = "08:00"):
    from app.routers.meal_routines import create_routine, RoutineUpsert
    from app.models import User
    u = session.get(User, user_id)
    body = RoutineUpsert(name=name, default_time=time, meal_type="breakfast", items=[
        {"food_name": "Oats", "quantity": 1, "unit": "cup",
         "calories": 300.0, "protein_g": 10.0, "carbs_g": 54.0, "fat_g": 5.0}])
    return create_routine(body, u, session)


def test_log_routine_occurrence_creates_one():  # #10
    from sqlmodel import Session
    from app.routers.meal_routines import log_routine_occurrence, LogOccurrenceBody
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        out = log_routine_occurrence(
            r["id"], LogOccurrenceBody(occurrence_date="2026-05-22", occurrence_key="occ-1"), u, s)
        assert out["deduped"] is False
        assert _count_meals(s, u.id) == 1
    _ok("logging a routine occurrence creates exactly one meal_log (#10)")


def test_log_same_occurrence_twice_dedupes():  # #11
    from sqlmodel import Session
    from app.routers.meal_routines import log_routine_occurrence, LogOccurrenceBody
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        b = LogOccurrenceBody(occurrence_date="2026-05-22", occurrence_key="occ-1")
        o1 = log_routine_occurrence(r["id"], b, u, s)
        o2 = log_routine_occurrence(r["id"], b, u, s)
        assert o1["meal_id"] == o2["meal_id"]
        assert o2["deduped"] is True
        assert _count_meals(s, u.id) == 1
    _ok("logging same routine occurrence twice de-dupes to one (#11)")


def test_edit_routine_no_duplicate_and_keeps_logs():  # #8 + #9 + #3 + #13
    from sqlmodel import Session
    from sqlmodel import select
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine, LogOccurrenceBody, RoutinePatch)
    from app.models import MealRoutine
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        rid = r["id"]
        logged = log_routine_occurrence(
            rid, LogOccurrenceBody(occurrence_date="2026-05-22", occurrence_key="occ-1"), u, s)
        meal_id = logged["meal_id"]
        before = _items_for(s, meal_id)[0].calories
        # Change the routine's time + name + items.
        update_routine(rid, RoutinePatch(default_time="09:30", name="Oats Deluxe", items=[
            {"food_name": "Oats", "quantity": 2, "unit": "cup",
             "calories": 600.0, "protein_g": 20.0, "carbs_g": 108.0, "fat_g": 10.0}]), u, s)
        # Exactly one routine row still exists, updated in place.
        routines = s.exec(select(MealRoutine).where(MealRoutine.user_id == u.id)).all()
        assert len(routines) == 1
        assert routines[0].id == rid
        assert routines[0].default_time == "09:30"
        assert routines[0].name == "Oats Deluxe"
        # The already-logged occurrence is a frozen snapshot.
        after = _items_for(s, meal_id)[0].calories
        assert after == before == 300.0
        from app.models import Meal
        meal = s.get(Meal, meal_id)
        assert meal.name == "Morning Oats"
        assert _count_meals(s, u.id) == 1
    _ok("editing a routine updates same id, no dup, logs frozen (#8,#9,#3,#13)")


def test_delete_routine_archives_and_keeps_logs():  # #14
    from sqlmodel import Session
    from app.routers.meal_routines import delete_routine, log_routine_occurrence, LogOccurrenceBody
    from app.models import Meal, MealRoutine

    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        rid = r["id"]
        logged = log_routine_occurrence(
            rid,
            LogOccurrenceBody(occurrence_date="2026-05-22", occurrence_key="occ-1"),
            u,
            s,
        )

        out = delete_routine(rid, u, s)
        assert out == {"archived": rid}

        routine = s.get(MealRoutine, rid)
        assert routine is not None
        assert routine.active is False

        meal = s.get(Meal, logged["meal_id"])
        assert meal is not None
        assert meal.source_routine_id == rid
        assert meal.routine_occurrence_key == "occ-1"
        assert _count_meals(s, u.id) == 1
    _ok("deleting a routine archives it while historical logs survive (#14)")


def test_edit_routine_template_creates_zero_logs():  # #8 + template/log separation
    from sqlmodel import Session
    from sqlmodel import select
    from app.routers.meal_routines import update_routine, RoutinePatch
    from app.models import MealRoutine
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        rid = r["id"]
        update_routine(rid, RoutinePatch(name="Morning Oats Deluxe", items=[
            {"food_name": "Oats", "quantity": 2, "unit": "cup",
             "calories": 600.0, "protein_g": 20.0, "carbs_g": 108.0, "fat_g": 10.0}
        ]), u, s)

        routines = s.exec(select(MealRoutine).where(MealRoutine.user_id == u.id)).all()
        assert len(routines) == 1
        assert routines[0].id == rid
        assert routines[0].name == "Morning Oats Deluxe"
        assert routines[0].total_calories == 600.0
        assert _count_meals(s, u.id) == 0
    _ok("editing a routine template creates zero meal logs")


def test_routine_display_order_controls_list_order():
    from sqlmodel import Session
    from app.routers.meal_routines import list_routines, update_routine, RoutinePatch
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        first = _routine(s, u.id, name="First")
        second = _routine(s, u.id, name="Second")
        third = _routine(s, u.id, name="Third")

        initial = list_routines(False, u, s)
        assert [r["name"] for r in initial] == ["First", "Second", "Third"]
        assert [r["display_order"] for r in initial] == [0, 1, 2]

        update_routine(first["id"], RoutinePatch(display_order=2), u, s)
        update_routine(second["id"], RoutinePatch(display_order=0), u, s)
        update_routine(third["id"], RoutinePatch(display_order=1), u, s)

        ordered = list_routines(False, u, s)
        assert [r["name"] for r in ordered] == ["Second", "Third", "First"]
        assert [r["display_order"] for r in ordered] == [0, 1, 2]
    _ok("routine display_order controls list order")


def test_free_routine_limit_blocks_overflow_active_routine():
    from fastapi import HTTPException
    from sqlmodel import Session
    from app.entitlements import FREE_MEAL_ROUTINE_LIMIT
    from app.routers.meal_routines import (
        create_routine, update_routine, RoutinePatch, RoutineUpsert)
    eng = _engine()
    with Session(eng) as s:
        u = _user(s, "routine_free@example.com", "free")
        for i in range(FREE_MEAL_ROUTINE_LIMIT):
            _routine(s, u.id, name=f"Routine {i + 1}")

        try:
            _routine(s, u.id, name="Overflow Routine")
            raise AssertionError("expected overflow active routine to be blocked")
        except HTTPException as e:
            assert e.status_code == 403

        inactive = create_routine(
            RoutineUpsert(name="Paused Routine", active=False, meal_type="snack", items=[
                {"food_name": "Yogurt", "quantity": 1, "unit": "cup",
                 "calories": 140.0, "protein_g": 18.0, "carbs_g": 12.0, "fat_g": 2.0}
            ]),
            u,
            s,
        )
        assert inactive["active"] is False
        try:
            update_routine(inactive["id"], RoutinePatch(active=True), u, s)
            raise AssertionError("expected reactivation beyond cap to be blocked")
        except HTTPException as e:
            assert e.status_code == 403
    _ok(f"free users are capped at {FREE_MEAL_ROUTINE_LIMIT} active meal routines")


def test_pro_routine_limit_is_unlimited():
    from sqlmodel import Session
    from app.entitlements import FREE_MEAL_ROUTINE_LIMIT
    from app.routers.meal_routines import list_routines
    eng = _engine()
    with Session(eng) as s:
        u = _user(s, "routine_pro@example.com", "pro")
        for i in range(FREE_MEAL_ROUTINE_LIMIT + 1):
            _routine(s, u.id, name=f"Routine {i + 1}")
        assert len(list_routines(False, u, s)) == FREE_MEAL_ROUTINE_LIMIT + 1
    _ok("pro users can create more than the free meal-routine cap")


def test_edit_one_occurrence_affects_only_that_date():  # #12
    from sqlmodel import Session
    from sqlmodel import select
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine_occurrence, LogOccurrenceBody, OccurrencePatch)
    from app.models import Meal
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        rid = r["id"]
        # Log two days.
        d1 = log_routine_occurrence(rid, LogOccurrenceBody(occurrence_date="2026-05-22", occurrence_key="o-22"), u, s)
        d2 = log_routine_occurrence(rid, LogOccurrenceBody(occurrence_date="2026-05-23", occurrence_key="o-23"), u, s)
        # Edit only day 22.
        update_routine_occurrence(rid, OccurrencePatch(occurrence_date="2026-05-22", name="Oats (Sat only)"), u, s)
        m1 = s.get(Meal, d1["meal_id"])
        m2 = s.get(Meal, d2["meal_id"])
        assert m1.name == "Oats (Sat only)"
        assert m2.name == "Morning Oats"
        assert _count_meals(s, u.id) == 2
    _ok("editing one day's occurrence affects only that date (#12)")


def test_unlogged_occurrence_edit_writes_exception_not_routine():  # #12 (un-logged branch) + #F
    from sqlmodel import Session
    from sqlmodel import select
    from app.routers.meal_routines import update_routine_occurrence, OccurrencePatch
    from app.models import MealRoutine, RoutineOccurrenceException
    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        rid = r["id"]
        update_routine_occurrence(rid, OccurrencePatch(occurrence_date="2026-05-25", skipped=True), u, s)
        # No meal created, base routine untouched, one exception row written.
        assert _count_meals(s, u.id) == 0
        routine = s.get(MealRoutine, rid)
        assert routine.name == "Morning Oats" and routine.active is True
        excs = s.exec(select(RoutineOccurrenceException).where(
            RoutineOccurrenceException.routine_id == rid)).all()
        assert len(excs) == 1 and excs[0].skipped is True
    _ok("editing an un-logged occurrence writes an exception, not the routine (#F)")


def test_logged_occurrence_edit_updates_log_time_and_day_state_only():
    from sqlmodel import Session
    from sqlmodel import select
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine_occurrence, LogOccurrenceBody, OccurrencePatch)
    from app.models import Meal, MealRoutine, UserDayState

    eng = _engine()
    with Session(eng) as s:
        u = _user(s)
        r = _routine(s, u.id)
        rid = r["id"]
        logged = log_routine_occurrence(
            rid,
            LogOccurrenceBody(occurrence_date="2026-05-22"),
            u,
            s,
        )
        meal_id = logged["meal_id"]
        occurrence_key = logged["routine_occurrence_key"]
        row = s.get(Meal, meal_id)
        before_version = row.version
        state_key = "routine_oats"
        s.add(UserDayState(
            user_id=u.id,
            day_key=date(2026, 5, 22),
            meal_checks={state_key: True},
            nutrition_plan={
                "targets": {"calories": 2200, "protein": 160, "carbs": 240, "fat": 70},
                "meals": [{
                    "meal": "Morning Oats",
                    "foods": ["Oats"],
                    "items": [{
                        "name": "Oats",
                        "quantity": 1,
                        "unit": "cup",
                        "calories": 300,
                        "protein": 10,
                        "carbs": 54,
                        "fat": 5,
                    }],
                    "calories": 300,
                    "protein": 10,
                    "carbs": 54,
                    "fat": 5,
                    "_loggedMealId": meal_id,
                    "_clientMealKey": state_key,
                    "_routineId": f"routine_backend_{rid}",
                    "source_routine_id": rid,
                    "routine_occurrence_key": occurrence_key,
                }],
            },
        ))
        s.commit()

        update_routine_occurrence(
            rid,
            OccurrencePatch(
                occurrence_date="2026-05-22",
                name="Oats plus whey",
                override_time="10:15",
                items=[
                    {"food_name": "Oats", "quantity": 1, "unit": "cup",
                     "calories": 300.0, "protein_g": 10.0, "carbs_g": 54.0, "fat_g": 5.0},
                    {"food_name": "Whey", "quantity": 1, "unit": "scoop",
                     "calories": 120.0, "protein_g": 24.0, "carbs_g": 3.0, "fat_g": 2.0},
                ],
            ),
            u,
            s,
        )

        row = s.get(Meal, meal_id)
        assert row.name == "Oats plus whey"
        assert row.consumed_at.hour == 10 and row.consumed_at.minute == 15
        assert row.version == before_version + 1
        items = _items_for(s, meal_id)
        assert len(items) == 2
        assert sum(i.calories for i in items) == 420.0

        routine = s.get(MealRoutine, rid)
        assert routine.name == "Morning Oats"
        assert routine.total_calories == 300.0

        state = s.exec(select(UserDayState).where(UserDayState.user_id == u.id)).first()
        state_meal = state.nutrition_plan["meals"][0]
        assert state_meal["meal"] == "Oats plus whey"
        assert state_meal["calories"] == 420.0
        assert state_meal["_loggedMealId"] == meal_id
        assert state_meal["_clientMealKey"] == state_key
        assert state_meal["_routineId"] == f"routine_backend_{rid}"
        assert state_meal["source_routine_id"] == rid
        assert state_meal["routine_occurrence_key"] == occurrence_key
        assert state.meal_checks == {state_key: True}
    _ok("editing a logged routine occurrence updates only that log + day-state snapshot")


def test_unlog_duplicate_manual_meal_removes_only_latest_match():
    from datetime import datetime, timezone
    from sqlmodel import Session
    from sqlmodel import select
    from app.models import Meal
    from app.services.nutrition.meal_history import log_meal_from_plan, unlog_meal_from_plan

    eng = _engine()
    payload = {
        "meal": "Protein Shake",
        "items": [
            {"name": "Whey", "quantity": 1, "unit": "scoop",
             "calories": 120, "protein": 24, "carbs": 3, "fat": 2},
        ],
    }
    with Session(eng) as s:
        u = _user(s)
        first = log_meal_from_plan(
            user_id=u.id,
            meal_date=date(2026, 5, 22),
            meal_type="meal_3",
            meal_data=payload,
            source="manual_add",
            consumed_at=datetime(2026, 5, 22, 12, 0, tzinfo=timezone.utc),
            db=s,
        )
        second = log_meal_from_plan(
            user_id=u.id,
            meal_date=date(2026, 5, 22),
            meal_type="meal_3",
            meal_data=payload,
            source="manual_add",
            consumed_at=datetime(2026, 5, 22, 12, 5, tzinfo=timezone.utc),
            db=s,
        )

        assert first["id"] != second["id"]
        result = unlog_meal_from_plan(
            user_id=u.id,
            meal_date=date(2026, 5, 22),
            meal_type="meal_3",
            meal_data=payload,
            source="manual_add",
            db=s,
        )
        assert result["deleted"] == 1, result

        remaining = s.exec(select(Meal).where(Meal.user_id == u.id)).all()
        assert len(remaining) == 1
        assert remaining[0].id == first["id"]
    _ok("unlogging one duplicate manual meal removes only the latest match")


cases = [
    test_log_favorite_creates_exactly_one_log,
    test_double_log_favorite_same_idempotency_key_creates_one,
    test_edit_favorite_creates_zero_logs_and_updates_template,
    test_edit_log_does_not_mutate_favorite,
    test_log_routine_occurrence_creates_one,
    test_log_same_occurrence_twice_dedupes,
    test_edit_routine_no_duplicate_and_keeps_logs,
    test_delete_routine_archives_and_keeps_logs,
    test_edit_routine_template_creates_zero_logs,
    test_routine_display_order_controls_list_order,
    test_free_routine_limit_blocks_overflow_active_routine,
    test_pro_routine_limit_is_unlimited,
    test_edit_one_occurrence_affects_only_that_date,
    test_unlogged_occurrence_edit_writes_exception_not_routine,
    test_logged_occurrence_edit_updates_log_time_and_day_state_only,
    test_unlog_duplicate_manual_meal_removes_only_latest_match,
]


if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print(f"\n{len(cases) - failures}/{len(cases)} passed")
    sys.exit(1 if failures else 0)
