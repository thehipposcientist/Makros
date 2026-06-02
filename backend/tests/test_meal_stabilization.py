"""Backend meal stabilization regression matrix.

Pins the contracts from the meal-system stabilization pass — idempotency,
routine occurrence identity + exceptions, favorite/copy/split provenance,
delete semantics by source_type, backlog timestamps, and food-ownership
isolation. All tests run against in-memory SQLite via direct router/service
calls (no HTTP, no Docker).

Run:
    docker exec thallo-backend python -m tests.test_meal_stabilization
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _engine(with_unique_indexes: bool = False):
    from sqlalchemy.pool import StaticPool
    from sqlalchemy import text
    from sqlmodel import SQLModel, create_engine
    import app.models  # noqa: F401 — registers every table on the shared metadata

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    if with_unique_indexes:
        # Mirror the production partial unique indexes (database.py runs these
        # as raw SQL on Postgres startup; metadata.create_all does not include
        # them). SQLite supports partial indexes.
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meals_user_idempotency_key "
                "ON meals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meals_user_routine_occurrence "
                "ON meals(user_id, source_routine_id, routine_occurrence_key) "
                "WHERE source_routine_id IS NOT NULL AND routine_occurrence_key IS NOT NULL"
            ))
    return engine


def _user(session, email: str = "stab@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x", subscription_tier="pro")
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def _food(session, user_id: int | None, name: str):
    from app.enums import FoodCategory, FoodSource
    from app.models import Food
    f = Food(
        name=name, normalized_name=name.lower(), category=FoodCategory.PROTEINS,
        source=FoodSource.AI, owner_user_id=user_id, is_custom=user_id is not None,
        unit="1 serving", serving_grams=100.0,
        calories=100.0, protein=10.0, carbs=5.0, fat=3.0,
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


def _routine(session, user_id: int, name: str = "Morning Oats", time: str = "08:00", items=None):
    from app.routers.meal_routines import create_routine, RoutineUpsert
    from app.models import User
    u = session.get(User, user_id)
    body = RoutineUpsert(
        name=name, default_time=time, meal_type="breakfast",
        items=items or [{"food_name": "Oats", "quantity": 1, "unit": "cup",
                         "calories": 300.0, "protein_g": 10.0, "carbs_g": 54.0, "fat_g": 5.0}],
    )
    return create_routine(body, u, session)


def _count(session, user_id: int) -> int:
    from sqlmodel import select
    from app.models import Meal
    return len(session.exec(select(Meal).where(Meal.user_id == user_id)).all())


def _meal_item_create(**over):
    from app.models import MealItemCreate
    base = dict(food_name="Item", quantity=1, unit="serving",
                calories=100.0, protein_g=8.0, carbs_g=5.0, fat_g=3.0)
    base.update(over)
    return MealItemCreate(**base)


# ─── A. Idempotency / duplicate safety ────────────────────────────────────────

def test_manual_double_tap_same_idempotency_key_one_meal():  # #1
    from sqlmodel import Session
    from app.models import MealCreate, MealType, MealSource
    from app.routers.meals import create_meal
    with Session(_engine()) as s:
        u = _user(s)
        food = _food(s, u.id, "Banana")
        body = MealCreate(
            meal_date=date.today(), meal_type=MealType.SNACK, name="Banana",
            source=MealSource.LOGGED, items=[_meal_item_create(food_name="Banana", food_id=food.id)],
            idempotency_key="dup-key-1",
        )
        r1 = create_meal(body, u, s)
        r2 = create_meal(body, u, s)
        assert r1["id"] == r2["id"], "same idempotency_key must collapse to one row"
        assert _count(s, u.id) == 1, f"expected 1 meal, got {_count(s, u.id)}"
    _ok("#1 manual double-tap (same idempotency_key) → exactly one Meal")


def test_idempotency_unique_constraint_enforced():  # #2 (DB guard the recovery relies on)
    from sqlmodel import Session
    from sqlalchemy.exc import IntegrityError
    from app.models import Meal, MealType, MealSource
    with Session(_engine(with_unique_indexes=True)) as s:
        u = _user(s)
        s.add(Meal(user_id=u.id, meal_date=date.today(), meal_type=MealType.SNACK,
                   name="A", source=MealSource.LOGGED, idempotency_key="race-k"))
        s.commit()
        s.add(Meal(user_id=u.id, meal_date=date.today(), meal_type=MealType.SNACK,
                   name="B", source=MealSource.LOGGED, idempotency_key="race-k"))
        raised = False
        try:
            s.commit()
        except IntegrityError:
            raised = True
            s.rollback()
        assert raised, "DB must reject a duplicate (user_id, idempotency_key) — the winner-recovery depends on it"
    _ok("#2 duplicate (user, idempotency_key) is rejected by the unique index")


def test_plan_check_double_tap_one_meal_with_idem_on_row():  # #3
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.meal_history import log_meal_from_plan
    with Session(_engine()) as s:
        u = _user(s)
        d = date.today()
        meal = {"meal": "Plan Lunch", "items": [
            {"name": "rice", "quantity": 1, "unit": "cup", "calories": 200, "protein": 4, "carbs": 44, "fat": 0}]}
        r1 = log_meal_from_plan(user_id=u.id, meal_date=d, meal_type="meal_0", meal_data=meal,
                                source="plan_check", idempotency_key="plan-k", db=s)
        r2 = log_meal_from_plan(user_id=u.id, meal_date=d, meal_type="meal_0", meal_data=meal,
                                source="plan_check", idempotency_key="plan-k", db=s)
        assert r1["id"] == r2["id"]
        assert _count(s, u.id) == 1, f"expected 1, got {_count(s, u.id)}"
        row = s.get(Meal, r1["id"])
        assert row.idempotency_key == "plan-k", "idempotency key must be written ON the created row (not post-hoc)"
    _ok("#3 plan-check double-tap → one Meal, idempotency key present on the row")


# ─── E. Favorites / SavedMeal separation ──────────────────────────────────────

def test_log_favorite_sets_favorite_provenance():  # #4
    from sqlmodel import Session
    from app.models import Meal
    from app.routers.saved_meals import log_saved_meal
    with Session(_engine()) as s:
        u = _user(s)
        fav = _favorite(s, u.id)
        res = log_saved_meal(fav.id, {"meal_date": "2026-05-22", "meal_type": "lunch"}, u, s)
        row = s.get(Meal, res["meal_id"])
        assert row.source_type == "favorite", f"got {row.source_type!r}"
        assert row.saved_meal_id == fav.id
    _ok("#4 logging a favorite → source_type='favorite', saved_meal_id set")


def test_edit_favorite_log_becomes_manual():  # #5
    from sqlmodel import Session
    from app.models import Meal
    from app.routers.saved_meals import log_saved_meal
    from app.routers.meals import update_meal
    with Session(_engine()) as s:
        u = _user(s)
        food = _food(s, u.id, "Eggs")
        fav = _favorite(s, u.id)
        res = log_saved_meal(fav.id, {"meal_date": "2026-05-22", "meal_type": "lunch"}, u, s)
        update_meal(res["meal_id"], {"items": [
            {"food_name": "Eggs", "food_id": food.id, "quantity": 2, "unit": "piece",
             "calories": 160.0, "protein_g": 12.0, "carbs_g": 2.0, "fat_g": 11.0}]}, u, s)
        row = s.get(Meal, res["meal_id"])
        assert row.saved_meal_id is None and row.source_type == "manual", \
            f"got saved_meal_id={row.saved_meal_id} source_type={row.source_type!r}"
    _ok("#5 editing a favorite-derived log items → saved_meal_id=None, source_type='manual'")


def test_copy_favorite_log_is_manual():  # #6
    from sqlmodel import Session
    from app.models import Meal
    from app.routers.saved_meals import log_saved_meal
    from app.routers.meals import copy_meal, CopyMealBody
    with Session(_engine()) as s:
        u = _user(s)
        fav = _favorite(s, u.id)
        res = log_saved_meal(fav.id, {"meal_date": "2026-05-22", "meal_type": "lunch"}, u, s)
        clone = copy_meal(res["meal_id"], CopyMealBody(meal_date="2026-05-23"), u, s)
        row = s.get(Meal, clone["id"])
        assert row.source_type == "manual" and row.saved_meal_id is None
    _ok("#6 copying a favorite-derived log → source_type='manual', saved_meal_id=None")


def test_split_favorite_log_both_manual():  # #7
    from sqlmodel import Session
    from app.models import Meal
    from app.routers.saved_meals import log_saved_meal
    from app.routers.meals import split_meal, SplitMealBody
    with Session(_engine()) as s:
        u = _user(s)
        fav = _favorite(s, u.id)
        res = log_saved_meal(fav.id, {"meal_date": "2026-05-22", "meal_type": "lunch"}, u, s)
        out = split_meal(res["meal_id"], SplitMealBody(keep_fraction=0.5), u, s)
        kept = s.get(Meal, out["kept"]["id"])
        rem = s.get(Meal, out["remainder"]["id"])
        for row in (kept, rem):
            assert row.source_type == "manual" and row.saved_meal_id is None, \
                f"split half not manual: source_type={row.source_type!r} saved_meal_id={row.saved_meal_id}"
    _ok("#7 splitting a favorite-derived log → both halves manual / unlinked")


# ─── B/C/D. Routine occurrence identity + exceptions ──────────────────────────

def test_routine_occurrence_key_independent_of_meal_type():  # #8
    from sqlmodel import Session
    from app.routers.meal_routines import log_routine_occurrence, LogOccurrenceBody
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id)
        log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20", meal_type="breakfast"), u, s)
        log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20", meal_type="lunch"), u, s)
        assert _count(s, u.id) == 1, f"meal_type must not change occurrence identity; got {_count(s, u.id)} rows"
    _ok("#8 routine log with/without differing meal_type → one Meal (stable key)")


def test_routine_one_day_edit_applied_on_log():  # #9
    from sqlmodel import Session, select
    from app.models import Meal, MealItem
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine_occurrence, LogOccurrenceBody, OccurrencePatch,
    )
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id)
        update_routine_occurrence(r["id"], OccurrencePatch(
            occurrence_date="2026-05-20", name="Special Oats",
            items=[{"food_name": "Special Oats", "quantity": 1, "unit": "bowl",
                    "calories": 350.0, "protein_g": 12.0, "carbs_g": 60.0, "fat_g": 6.0}]), u, s)
        res = log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20"), u, s)
        row = s.get(Meal, res["meal_id"])
        assert row.name == "Special Oats", f"log should use the edited payload, got {row.name!r}"
        items = s.exec(select(MealItem).where(MealItem.meal_id == row.id)).all()
        assert any(abs(i.calories - 350.0) < 0.01 for i in items), "edited items not applied"
    _ok("#9 one-day routine edit before logging → log uses the edited payload")


def test_routine_skipped_day_blocks_log():  # #10
    from sqlmodel import Session
    from fastapi import HTTPException
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine_occurrence, LogOccurrenceBody, OccurrencePatch,
    )
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id)
        update_routine_occurrence(r["id"], OccurrencePatch(occurrence_date="2026-05-20", skipped=True), u, s)
        blocked = False
        try:
            log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20"), u, s)
        except HTTPException as e:
            blocked = e.status_code in (409, 422)
        assert blocked, "logging a skipped occurrence must be blocked"
        assert _count(s, u.id) == 0
    _ok("#10 skipped routine day before logging → log blocked (409)")


def test_routine_logged_skip_deletes_and_marks_exception():  # #11
    from sqlmodel import Session, select
    from fastapi import HTTPException
    from app.models import RoutineOccurrenceException
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine_occurrence, LogOccurrenceBody, OccurrencePatch,
    )
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id)
        log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20"), u, s)
        assert _count(s, u.id) == 1
        update_routine_occurrence(r["id"], OccurrencePatch(occurrence_date="2026-05-20", skipped=True), u, s)
        assert _count(s, u.id) == 0, "skipping a logged occurrence must delete the Meal"
        exc = s.exec(select(RoutineOccurrenceException)
                     .where(RoutineOccurrenceException.routine_id == r["id"])).first()
        assert exc is not None and exc.skipped is True, "skip must be recorded as an exception"
        # And it stays skipped — a later log is blocked.
        blocked = False
        try:
            log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20"), u, s)
        except HTTPException as e:
            blocked = e.status_code in (409, 422)
        assert blocked, "skipped occurrence must not be re-loggable"
    _ok("#11 skipping a logged occurrence → Meal deleted + skip exception, not re-loggable")


def test_occurrence_edit_targets_key_not_latest():  # #12
    from sqlmodel import Session
    from app.models import Meal
    from app.routers.meal_routines import (
        log_routine_occurrence, update_routine_occurrence, LogOccurrenceBody, OccurrencePatch,
    )
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id)
        m1 = log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20", occurrence_key="k1"), u, s)
        m2 = log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20", occurrence_key="k2"), u, s)
        assert m1["meal_id"] != m2["meal_id"] and _count(s, u.id) == 2
        update_routine_occurrence(r["id"], OccurrencePatch(
            occurrence_date="2026-05-20", occurrence_key="k1", name="Edited K1"), u, s)
        assert s.get(Meal, m1["meal_id"]).name == "Edited K1"
        assert s.get(Meal, m2["meal_id"]).name == "Morning Oats", "must not edit the other occurrence"
    _ok("#12 occurrence edit targets routine_occurrence_key, not the latest meal")


# ─── F. Delete semantics by source_type ───────────────────────────────────────

def _day_state_with_plan(session, user_id: int, d: date, meals: list[dict]):
    from app.models import UserDayState
    st = UserDayState(user_id=user_id, day_key=d, nutrition_plan={"meals": meals}, meal_checks={})
    session.add(st)
    session.commit()
    return st


def _plan_meal_names(session, user_id: int, d: date) -> list[str]:
    from sqlmodel import select
    from app.models import UserDayState
    st = session.exec(select(UserDayState).where(
        UserDayState.user_id == user_id, UserDayState.day_key == d)).first()
    return [str(m.get("meal") or m.get("name") or "") for m in (st.nutrition_plan or {}).get("meals", [])]


def _make_meal(session, user_id: int, d: date, *, name, source_type, client_meal_key=None,
               source_routine_id=None, routine_occurrence_key=None):
    from app.models import Meal, MealItem, MealType, MealSource
    m = Meal(user_id=user_id, meal_date=d, meal_type=MealType.SNACK, name=name,
             source=MealSource.LOGGED, source_type=source_type, client_meal_key=client_meal_key,
             source_routine_id=source_routine_id, routine_occurrence_key=routine_occurrence_key)
    session.add(m)
    session.commit()
    session.refresh(m)
    session.add(MealItem(meal_id=m.id, food_name=name, quantity=1, unit="serving",
                         calories=100.0, protein_g=5.0, carbs_g=5.0, fat_g=5.0))
    session.commit()
    return m


def test_delete_manual_meal_does_not_mutate_plan():  # #13
    from sqlmodel import Session
    from app.routers.meals import delete_meal
    with Session(_engine()) as s:
        u = _user(s)
        d = date.today()
        _day_state_with_plan(s, u.id, d, [{"meal": "Oatmeal", "_clientMealKey": "meal_0"}])
        m = _make_meal(s, u.id, d, name="Oatmeal", source_type="manual")  # same name as plan meal
        delete_meal(m.id, u, s)
        assert _plan_meal_names(s, u.id, d) == ["Oatmeal"], "deleting a manual meal must not remove the plan slot"
    _ok("#13 delete manual meal → nutrition plan untouched")


def test_delete_favorite_meal_does_not_mutate_plan():  # #14
    from sqlmodel import Session
    from app.routers.meals import delete_meal
    with Session(_engine()) as s:
        u = _user(s)
        d = date.today()
        _day_state_with_plan(s, u.id, d, [{"meal": "Oatmeal", "_clientMealKey": "meal_0"}])
        m = _make_meal(s, u.id, d, name="Oatmeal", source_type="favorite")
        delete_meal(m.id, u, s)
        assert _plan_meal_names(s, u.id, d) == ["Oatmeal"], "deleting a favorite meal must not remove the plan slot"
    _ok("#14 delete favorite meal → nutrition plan untouched")


def test_delete_plan_meal_syncs_plan():  # #15
    from sqlmodel import Session
    from app.routers.meals import delete_meal
    with Session(_engine()) as s:
        u = _user(s)
        d = date.today()
        _day_state_with_plan(s, u.id, d, [{"meal": "Oatmeal", "_clientMealKey": "meal_0"}])
        m = _make_meal(s, u.id, d, name="Oatmeal", source_type="plan", client_meal_key="meal_0")
        delete_meal(m.id, u, s)
        assert _plan_meal_names(s, u.id, d) == [], "deleting a plan meal must remove its slot from the plan"
    _ok("#15 delete plan meal → plan slot removed/synced")


def test_delete_routine_meal_marks_occurrence_skipped():  # #16
    from sqlmodel import Session, select
    from app.models import RoutineOccurrenceException
    from app.routers.meals import delete_meal
    from app.routers.meal_routines import log_routine_occurrence, LogOccurrenceBody
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id)
        res = log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20"), u, s)
        delete_meal(res["meal_id"], u, s)
        assert _count(s, u.id) == 0
        exc = s.exec(select(RoutineOccurrenceException)
                     .where(RoutineOccurrenceException.routine_id == r["id"])).first()
        assert exc is not None and exc.skipped is True, "deleting a routine occurrence must mark it skipped"
    _ok("#16 delete routine meal → occurrence marked skipped")


# ─── G. consumed_at / meal_date consistency ───────────────────────────────────

def test_backlog_without_consumed_at_is_not_today():  # #17
    from sqlmodel import Session
    from app.models import Meal, MealCreate, MealType, MealSource
    from app.routers.meals import create_meal
    with Session(_engine()) as s:
        u = _user(s)
        food = _food(s, u.id, "Soup")
        yesterday = date.today() - timedelta(days=1)
        res = create_meal(
            MealCreate(meal_date=yesterday, meal_type=MealType.DINNER, name="Soup",
                       source=MealSource.LOGGED, items=[_meal_item_create(food_name="Soup", food_id=food.id)]),
            u, s)
        row = s.get(Meal, res["id"])
        assert row.consumed_at is None, \
            f"back-logged meal must not get today's timestamp; got {row.consumed_at}"
        # Today with no consumed_at still stamps now.
        res2 = create_meal(
            MealCreate(meal_date=date.today(), meal_type=MealType.LUNCH, name="Soup2",
                       source=MealSource.LOGGED, items=[_meal_item_create(food_name="Soup", food_id=food.id)]),
            u, s)
        assert s.get(Meal, res2["id"]).consumed_at is not None
    _ok("#17 backlog without consumed_at → NULL (not today); today → now")


# ─── H. Food ownership in routine cloning ─────────────────────────────────────

def test_routine_clone_does_not_attach_other_users_food():  # #18
    from sqlmodel import Session, select
    from app.models import Meal, MealItem
    from app.routers.meal_routines import log_routine_occurrence, LogOccurrenceBody
    with Session(_engine()) as s:
        owner = _user(s, "owner@example.com")
        other = _user(s, "other@example.com")
        # `other` owns a private custom food whose name collides with a routine item.
        private = _food(s, other.id, "Special Sauce")
        r = _routine(s, owner.id, name="Sauce Plate",
                     items=[{"food_name": "Special Sauce", "quantity": 1, "unit": "serving",
                             "calories": 90.0, "protein_g": 1.0, "carbs_g": 4.0, "fat_g": 8.0}])
        res = log_routine_occurrence(r["id"], LogOccurrenceBody(occurrence_date="2026-05-20"), owner, s)
        items = s.exec(select(MealItem).where(MealItem.meal_id == res["meal_id"])).all()
        assert items, "routine occurrence should have items"
        assert all(i.food_id != private.id for i in items), \
            "must not attach another user's private custom food by name collision"
    _ok("#18 routine clone does not attach another user's custom Food by name")


# ─── I. Day-state nutrition_plan persistence (past dates) ─────────────────────
# The client treats a past day as a historical record: opening the app must
# restore yesterday's full plan, and adding a meal to yesterday must not drop
# the meals already there. The backend contract those rely on is that
# upsert→get round-trips the nutrition_plan faithfully and that a plan upsert
# REPLACES (not partially-merges-away) the meal list.

def _day_state_body(**over):
    from app.models import DayStateUpsert
    return DayStateUpsert(**over)


def test_day_state_nutrition_plan_round_trips_for_past_date():  # #19
    from sqlmodel import Session
    from app.routers.profile import get_day_state, upsert_day_state
    with Session(_engine()) as s:
        u = _user(s, "daystate@example.com")
        yesterday = "2026-05-20"
        plan = {
            "_userEdited": True,
            "meals": [
                {"meal": "Oatmeal", "calories": 300, "_clientMealKey": "routine_r1", "_routineId": "r1"},
                {"meal": "Chicken Bowl", "calories": 500, "_clientMealKey": "log_1", "_loggedMealId": 1},
                {"meal": "Yogurt", "calories": 150, "_clientMealKey": "local_2", "_localId": "2"},
            ],
            "targets": {"calories": 2000, "protein": 150, "carbs": 200, "fat": 60},
        }
        upsert_day_state(date.fromisoformat(yesterday), _day_state_body(nutrition_plan=plan), u, s)
        got = get_day_state(date.fromisoformat(yesterday), u, s)
        np = got.nutrition_plan if hasattr(got, "nutrition_plan") else got["nutrition_plan"]
        assert np is not None, "past-date nutrition_plan must persist"
        assert len(np["meals"]) == 3, f"expected 3 meals round-tripped, got {len(np['meals'])}"
        assert np.get("_userEdited") is True, "_userEdited flag must survive so the client reloads it"
    _ok("#19 past-date nutrition_plan round-trips with all meals + _userEdited flag")


def test_add_meal_to_yesterday_keeps_existing_meals():  # #20
    from sqlmodel import Session
    from app.routers.profile import get_day_state, upsert_day_state
    with Session(_engine()) as s:
        u = _user(s, "addyday@example.com")
        yesterday = date.fromisoformat("2026-05-20")
        base = {
            "_userEdited": True,
            "meals": [{"meal": "Oatmeal", "calories": 300}, {"meal": "Chicken", "calories": 500}],
            "targets": {"calories": 2000, "protein": 150, "carbs": 200, "fat": 60},
        }
        upsert_day_state(yesterday, _day_state_body(nutrition_plan=base), u, s)
        # Client re-sends the full plan with one meal appended (its add-to-day flow).
        added = dict(base)
        added["meals"] = base["meals"] + [{"meal": "Apple", "calories": 95}]
        upsert_day_state(yesterday, _day_state_body(nutrition_plan=added), u, s)
        got = get_day_state(yesterday, u, s)
        np = got.nutrition_plan if hasattr(got, "nutrition_plan") else got["nutrition_plan"]
        names = [m["meal"] for m in np["meals"]]
        assert names == ["Oatmeal", "Chicken", "Apple"], f"adding to yesterday must keep prior meals; got {names}"
    _ok("#20 adding a meal to yesterday persists without dropping existing meals")


def test_day_state_plan_patch_preserves_hydration():  # #21
    from sqlmodel import Session
    from app.routers.profile import get_day_state, upsert_day_state
    with Session(_engine()) as s:
        u = _user(s, "hydra@example.com")
        day = date.fromisoformat("2026-05-20")
        upsert_day_state(day, _day_state_body(nutrition_plan={"meals": [], "_hydration_oz": 32}), u, s)
        # A later plan-only save (no hydration field) must not wipe logged water.
        upsert_day_state(day, _day_state_body(nutrition_plan={"meals": [{"meal": "Eggs"}]}), u, s)
        got = get_day_state(day, u, s)
        np = got.nutrition_plan if hasattr(got, "nutrition_plan") else got["nutrition_plan"]
        assert np.get("_hydration_oz") == 32, "hydration must survive a plan-only patch"
    _ok("#21 plan-only day-state patch preserves _hydration_oz")


ALL_TESTS = [v for k, v in list(globals().items()) if k.startswith("test_")]


def run_all():
    passed = failed = 0
    for fn in ALL_TESTS:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            import traceback
            print(f"  FAIL {fn.__name__}: {e}")
            traceback.print_exc()
    total = passed + failed
    print(f"\ntest_meal_stabilization: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)
