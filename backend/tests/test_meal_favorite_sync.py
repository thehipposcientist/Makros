"""Regression tests for favorite/unfavorite day-state sync + future-day
dedup backfill. The sync gap caused the plan-card bookmark icon to lag
behind the favorite state (client `isSavedFavoriteMeal` falls back to
name-signature matching when `_savedMealId` is missing, lighting up
unrelated rows). The dedup backfill cleans up legacy duplicates that
existed before the meal-stabilization idempotency was deployed.

Run:
    docker exec thallo-backend python -m tests.test_meal_favorite_sync
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _engine(*, with_unique_indexes: bool = False):
    from sqlalchemy.pool import StaticPool
    from sqlalchemy import text
    from sqlmodel import SQLModel, create_engine
    import app.models  # noqa: F401 — register tables

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    if with_unique_indexes:
        # Mirror production's partial unique indexes (the SQL migrations
        # in database.py only run on Postgres). SQLite supports partial
        # indexes too, which is enough for these dedup contracts.
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_meals_user_idempotency_key "
                "ON meals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_meals_user_idempotency_key "
                "ON saved_meals(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
            ))
    return engine


def _user(session, email: str = "fav@example.com"):
    from app.models import User
    u = User(email=email, username=email.split("@")[0], hashed_password="x", subscription_tier="pro")
    session.add(u); session.commit(); session.refresh(u)
    return u


def _logged_meal(session, user_id: int, *, name: str, meal_date: date, items: list[dict] | None = None):
    """Insert a logged Meal + its MealItem rows. UserDayState is UPSERTED
    per (user, day) — adding a second meal on the same date appends to
    the existing snapshot's `meals` list instead of inserting a second
    UserDayState row (which would violate the unique constraint and is
    not how production builds the snapshot)."""
    from sqlmodel import select
    from app.models import Meal, MealItem, MealType, MealSource, UserDayState
    items = items or [{"food_name": "Chicken", "quantity": 1, "unit": "serving",
                       "calories": 200.0, "protein_g": 40.0, "carbs_g": 0.0, "fat_g": 4.0}]
    meal = Meal(
        user_id=user_id, meal_date=meal_date, meal_type=MealType.LUNCH,
        name=name, source=MealSource.LOGGED, source_type="manual",
        client_meal_key=f"meal_{meal_date.isoformat()}_{name.lower()}",
        version=1,
    )
    session.add(meal); session.flush()
    for it in items:
        session.add(MealItem(
            meal_id=meal.id,
            food_name=it["food_name"],
            quantity=it["quantity"],
            unit=it["unit"],
            calories=it["calories"],
            protein_g=it["protein_g"],
            carbs_g=it["carbs_g"],
            fat_g=it["fat_g"],
        ))
    snapshot_meal = {
        "meal": name,
        "_loggedMealId": meal.id,
        "_clientMealKey": meal.client_meal_key,
        "items": items,
        "calories": sum(i["calories"] for i in items),
        "protein": sum(i["protein_g"] for i in items),
        "carbs": sum(i["carbs_g"] for i in items),
        "fat": sum(i["fat_g"] for i in items),
    }
    state = session.exec(
        select(UserDayState).where(
            UserDayState.user_id == user_id, UserDayState.day_key == meal_date,
        )
    ).first()
    if state is None:
        state = UserDayState(
            user_id=user_id, day_key=meal_date,
            nutrition_plan={"meals": [snapshot_meal]},
        )
        session.add(state)
    else:
        plan = dict(state.nutrition_plan or {})
        meals_list = list(plan.get("meals") or [])
        meals_list.append(snapshot_meal)
        plan["meals"] = meals_list
        state.nutrition_plan = plan
        session.add(state)
    session.commit(); session.refresh(meal)
    return meal


# ─── Favorite/unfavorite day-state sync ───────────────────────────────────────


def test_favorite_writes_saved_meal_id_to_day_state():  # H#3
    from sqlmodel import Session, select
    from app.models import UserDayState
    from app.routers.meals import favorite_meal
    with Session(_engine()) as s:
        u = _user(s)
        meal = _logged_meal(s, u.id, name="Test Bowl", meal_date=date.today())
        favorite_meal(meal.id, u, s)
        state = s.exec(select(UserDayState).where(
            UserDayState.user_id == u.id, UserDayState.day_key == meal.meal_date,
        )).first()
        snapshot_meal = (state.nutrition_plan or {}).get("meals", [])[0]
        assert snapshot_meal.get("_savedMealId"), \
            f"_savedMealId must land in day-state snapshot after PUT favorite, got: {snapshot_meal}"
    _ok("#H3 PUT /meals/{id}/favorite → day-state snapshot has _savedMealId")


def test_unfavorite_clears_saved_meal_id_in_all_linked_day_states():  # H#4
    from sqlmodel import Session, select
    from app.models import UserDayState
    from app.routers.meals import favorite_meal, unfavorite_meal, copy_meal, CopyMealBody
    with Session(_engine()) as s:
        u = _user(s)
        meal_a = _logged_meal(s, u.id, name="Shared Bowl", meal_date=date.today())
        favorite_meal(meal_a.id, u, s)
        # Copy the favorite-linked meal onto another date. The copy
        # itself is marked `manual` (rule E from bbf852a9), so favorite
        # linkage stays only on the source row. Still — we want
        # unfavorite to leave neither row pointing at the deleted SavedMeal.
        copy_meal(
            meal_a.id,
            CopyMealBody(meal_date=(date.today() + timedelta(days=2)).isoformat()),
            u, s,
        )
        unfavorite_meal(meal_a.id, u, s)
        state = s.exec(select(UserDayState).where(
            UserDayState.user_id == u.id, UserDayState.day_key == meal_a.meal_date,
        )).first()
        snapshot_meal = (state.nutrition_plan or {}).get("meals", [])[0]
        assert not snapshot_meal.get("_savedMealId"), \
            f"_savedMealId must be cleared in day-state snapshot after unfavorite, got: {snapshot_meal}"
    _ok("#H4 DELETE /meals/{id}/favorite → day-state snapshot cleared")


def test_unrelated_meal_day_state_untouched_by_favorite():  # H#5
    """Favoriting meal X on date A must not rewrite a different meal's
    snapshot on date B. The sync helper finds by `_loggedMealId` so it
    only touches the exact row that changed."""
    from sqlmodel import Session, select
    from app.models import UserDayState
    from app.routers.meals import favorite_meal
    with Session(_engine()) as s:
        u = _user(s)
        meal_a = _logged_meal(s, u.id, name="Bowl A", meal_date=date.today())
        meal_b = _logged_meal(s, u.id, name="Bowl B",
                              meal_date=date.today() + timedelta(days=1))
        favorite_meal(meal_a.id, u, s)
        state_b = s.exec(select(UserDayState).where(
            UserDayState.user_id == u.id, UserDayState.day_key == meal_b.meal_date,
        )).first()
        snapshot_b = (state_b.nutrition_plan or {}).get("meals", [])[0]
        assert not snapshot_b.get("_savedMealId"), \
            f"unrelated day-state snapshot should not have _savedMealId, got: {snapshot_b}"
    _ok("#H5 favoriting meal A does not stamp _savedMealId on meal B's day-state")


# ─── Future-day dedup backfill ────────────────────────────────────────────────


def test_dedup_future_meals_collapses_duplicate_group():  # Backfill#1
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.dedupe_future_meals import dedupe_future_meals
    with Session(_engine()) as s:
        u = _user(s)
        future = date.today() + timedelta(days=2)
        # Three rows with identical (name, type, items) on a future date.
        first = _logged_meal(s, u.id, name="Dup Bowl", meal_date=future)
        second = _logged_meal(s, u.id, name="Dup Bowl", meal_date=future)
        third = _logged_meal(s, u.id, name="Dup Bowl", meal_date=future)
        summary = dedupe_future_meals(s, cutoff=future, apply=True)
        assert summary["duplicate_groups"] == 1, summary
        assert summary["rows_to_delete"] == 2, summary
        assert summary["rows_deleted"] == 2, summary
        rows = s.exec(select(Meal).where(Meal.user_id == u.id, Meal.meal_date == future)).all()
        assert len(rows) == 1, f"only one survivor expected, got {[m.id for m in rows]}"
        # Kept the OLDEST row (lowest id).
        assert rows[0].id == first.id, \
            f"expected oldest meal {first.id} kept, got {rows[0].id} (others: {second.id}, {third.id})"
    _ok("#Backfill1 dedupe collapses duplicate group on a future date, keeps oldest")


def test_dedup_future_meals_dry_run_does_not_delete():  # Backfill#2
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.dedupe_future_meals import dedupe_future_meals
    with Session(_engine()) as s:
        u = _user(s)
        future = date.today() + timedelta(days=3)
        _logged_meal(s, u.id, name="Dup", meal_date=future)
        _logged_meal(s, u.id, name="Dup", meal_date=future)
        summary = dedupe_future_meals(s, cutoff=future, apply=False)
        assert summary["rows_to_delete"] == 1
        assert summary["rows_deleted"] == 0
        assert len(s.exec(select(Meal).where(Meal.user_id == u.id)).all()) == 2
    _ok("#Backfill2 dry-run reports but does not delete")


def test_dedup_future_meals_does_not_touch_past_dates():  # Backfill#3
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.dedupe_future_meals import dedupe_future_meals
    with Session(_engine()) as s:
        u = _user(s)
        past = date.today() - timedelta(days=5)
        future = date.today() + timedelta(days=5)
        _logged_meal(s, u.id, name="Old Dup", meal_date=past)
        _logged_meal(s, u.id, name="Old Dup", meal_date=past)
        _logged_meal(s, u.id, name="New Dup", meal_date=future)
        _logged_meal(s, u.id, name="New Dup", meal_date=future)
        # Cutoff = today + 1 → only future dup counted.
        summary = dedupe_future_meals(s, cutoff=date.today() + timedelta(days=1), apply=True)
        assert summary["duplicate_groups"] == 1, summary
        assert summary["rows_deleted"] == 1, summary
        past_rows = s.exec(select(Meal).where(Meal.user_id == u.id, Meal.meal_date == past)).all()
        assert len(past_rows) == 2, "past-date duplicates must NOT be touched"
    _ok("#Backfill3 past-dated meals are never touched, history stays frozen")


def test_dedup_future_meals_keeps_distinct_meals_distinct():  # Backfill#4
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.dedupe_future_meals import dedupe_future_meals
    with Session(_engine()) as s:
        u = _user(s)
        future = date.today() + timedelta(days=1)
        _logged_meal(s, u.id, name="Bowl X", meal_date=future)
        _logged_meal(s, u.id, name="Bowl Y", meal_date=future,
                     items=[{"food_name": "Rice", "quantity": 2, "unit": "cup",
                             "calories": 400.0, "protein_g": 8.0, "carbs_g": 80.0, "fat_g": 3.0}])
        summary = dedupe_future_meals(s, cutoff=future, apply=True)
        assert summary["duplicate_groups"] == 0
        assert summary["rows_deleted"] == 0
        assert len(s.exec(select(Meal).where(Meal.user_id == u.id)).all()) == 2
    _ok("#Backfill4 distinct meals on the same future date stay distinct")


def test_dedup_future_meals_scopes_to_user_id():  # Backfill#5
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.dedupe_future_meals import dedupe_future_meals
    with Session(_engine()) as s:
        u1 = _user(s, "u1@example.com")
        u2 = _user(s, "u2@example.com")
        future = date.today() + timedelta(days=1)
        _logged_meal(s, u1.id, name="Shared", meal_date=future)
        _logged_meal(s, u1.id, name="Shared", meal_date=future)
        _logged_meal(s, u2.id, name="Shared", meal_date=future)
        _logged_meal(s, u2.id, name="Shared", meal_date=future)
        summary = dedupe_future_meals(s, cutoff=future, user_id=u1.id, apply=True)
        assert summary["rows_deleted"] == 1
        assert len(s.exec(select(Meal).where(Meal.user_id == u2.id)).all()) == 2, \
            "scoped to u1, must not touch u2's meals"
    _ok("#Backfill5 --user-id scopes the dedupe to one user")


# ─── Idempotency: createSavedMeal + copyMeal ─────────────────────────────────


def test_create_saved_meal_idempotent_with_key():  # Idem#1
    """Two POSTs to /meals/saved with the same `idempotency_key` collapse
    to one SavedMeal row — even when the (user_id, source_meal_id) unique
    index doesn't catch it (freeform items, no from_meal_id)."""
    from sqlmodel import Session, select
    from app.models import SavedMeal, User
    from app.routers.saved_meals import create_saved_meal
    with Session(_engine(with_unique_indexes=True)) as s:
        u = _user(s)
        u_db = s.get(User, u.id)
        body = {
            "name": "Idem Bowl",
            "items": [{"food_name": "Chicken", "quantity": 1, "unit": "serving",
                       "calories": 200.0, "protein_g": 40.0, "carbs_g": 0.0, "fat_g": 4.0}],
            "idempotency_key": "fav_dup_1",
        }
        r1 = create_saved_meal(body, u_db, s)
        r2 = create_saved_meal(body, u_db, s)
        assert r1["id"] == r2["id"], "same idempotency_key must collapse to one SavedMeal"
        rows = s.exec(select(SavedMeal).where(SavedMeal.user_id == u.id)).all()
        assert len(rows) == 1, f"expected 1 SavedMeal, got {len(rows)}"
    _ok("#Idem1 createSavedMeal with same idempotency_key → one row")


def test_create_saved_meal_distinct_keys_create_distinct_rows():  # Idem#2
    from sqlmodel import Session, select
    from app.models import SavedMeal, User
    from app.routers.saved_meals import create_saved_meal
    with Session(_engine(with_unique_indexes=True)) as s:
        u = _user(s)
        u_db = s.get(User, u.id)
        item = {"food_name": "Chicken", "quantity": 1, "unit": "serving",
                "calories": 200.0, "protein_g": 40.0, "carbs_g": 0.0, "fat_g": 4.0}
        r1 = create_saved_meal({"name": "A", "items": [item], "idempotency_key": "k1"}, u_db, s)
        r2 = create_saved_meal({"name": "B", "items": [item], "idempotency_key": "k2"}, u_db, s)
        assert r1["id"] != r2["id"], "different idempotency_keys must create distinct rows"
        rows = s.exec(select(SavedMeal).where(SavedMeal.user_id == u.id)).all()
        assert len(rows) == 2
    _ok("#Idem2 createSavedMeal with distinct keys → distinct rows")


def test_create_saved_meal_without_key_remains_unguarded():  # Idem#3
    """Idempotency MUST be opt-in. Legacy clients that don't send a
    key (or send empty/null) keep the prior behavior — same shape can
    insert twice, since the partial unique index only applies WHERE
    idempotency_key IS NOT NULL."""
    from sqlmodel import Session, select
    from app.models import SavedMeal, User
    from app.routers.saved_meals import create_saved_meal
    with Session(_engine(with_unique_indexes=True)) as s:
        u = _user(s)
        u_db = s.get(User, u.id)
        body = {
            "name": "Legacy",
            "items": [{"food_name": "Chicken", "quantity": 1, "unit": "serving",
                       "calories": 200.0, "protein_g": 40.0, "carbs_g": 0.0, "fat_g": 4.0}],
        }
        create_saved_meal(body, u_db, s)
        create_saved_meal(body, u_db, s)
        rows = s.exec(select(SavedMeal).where(SavedMeal.user_id == u.id)).all()
        assert len(rows) == 2
    _ok("#Idem3 createSavedMeal without idempotency_key keeps legacy behavior")


def test_create_saved_meal_idempotency_is_per_user():  # Idem#4
    """Two different users using the SAME idempotency_key must each get
    their own row — the partial unique index is on (user_id, key)."""
    from sqlmodel import Session, select
    from app.models import SavedMeal, User
    from app.routers.saved_meals import create_saved_meal
    with Session(_engine(with_unique_indexes=True)) as s:
        u1 = _user(s, "u1@example.com"); u2 = _user(s, "u2@example.com")
        u1_db = s.get(User, u1.id); u2_db = s.get(User, u2.id)
        body = {
            "name": "Shared",
            "items": [{"food_name": "Apple", "quantity": 1, "unit": "serving",
                       "calories": 95.0, "protein_g": 0.5, "carbs_g": 25.0, "fat_g": 0.3}],
            "idempotency_key": "collision",
        }
        r1 = create_saved_meal(body, u1_db, s)
        r2 = create_saved_meal(body, u2_db, s)
        assert r1["id"] != r2["id"], "same key across different users must NOT collide"
        assert len(s.exec(select(SavedMeal)).all()) == 2
    _ok("#Idem4 createSavedMeal idempotency is scoped per user")


def test_copy_meal_idempotent_with_key():  # Idem#5
    """Two POSTs to /meals/{id}/copy with the same idempotency_key
    collapse to one clone via the existing (user_id, idempotency_key)
    partial unique index on `meals`."""
    from sqlmodel import Session, select
    from app.models import Meal, User
    from app.routers.meals import copy_meal, CopyMealBody
    with Session(_engine(with_unique_indexes=True)) as s:
        u = _user(s)
        u_db = s.get(User, u.id)
        source = _logged_meal(s, u.id, name="Source Bowl", meal_date=date.today())
        body = CopyMealBody(meal_date=(date.today() + timedelta(days=1)).isoformat(),
                            idempotency_key="copy_dup_1")
        r1 = copy_meal(source.id, body, u_db, s)
        r2 = copy_meal(source.id, body, u_db, s)
        assert r1["id"] == r2["id"], "same idempotency_key must collapse to one clone"
        future_meals = s.exec(
            select(Meal).where(Meal.user_id == u.id, Meal.meal_date == (date.today() + timedelta(days=1)))
        ).all()
        assert len(future_meals) == 1, f"expected 1 clone, got {len(future_meals)}"
    _ok("#Idem5 copy_meal with same idempotency_key → one clone")


def test_copy_meal_distinct_keys_create_distinct_clones():  # Idem#6
    from sqlmodel import Session, select
    from app.models import Meal, User
    from app.routers.meals import copy_meal, CopyMealBody
    with Session(_engine(with_unique_indexes=True)) as s:
        u = _user(s)
        u_db = s.get(User, u.id)
        source = _logged_meal(s, u.id, name="Source", meal_date=date.today())
        target = (date.today() + timedelta(days=1)).isoformat()
        r1 = copy_meal(source.id, CopyMealBody(meal_date=target, idempotency_key="k1"), u_db, s)
        r2 = copy_meal(source.id, CopyMealBody(meal_date=target, idempotency_key="k2"), u_db, s)
        assert r1["id"] != r2["id"]
        clones = s.exec(
            select(Meal).where(Meal.user_id == u.id, Meal.meal_date == (date.today() + timedelta(days=1)))
        ).all()
        assert len(clones) == 2
    _ok("#Idem6 copy_meal with distinct keys → distinct clones")


# ─── Future-routine reconcile ────────────────────────────────────────────────


def _routine(session, user_id: int, *, name: str, days_of_week: list[int] | None = None,
             active: bool = True, start_date: date | None = None, end_date: date | None = None):
    from app.models import MealRoutine
    r = MealRoutine(
        user_id=user_id, name=name,
        days_of_week=days_of_week or [], active=active,
        start_date=start_date, end_date=end_date,
        items=[{"food_name": "Oats", "quantity": 1, "unit": "cup",
                "calories": 300.0, "protein_g": 10.0, "carbs_g": 54.0, "fat_g": 5.0}],
        total_calories=300.0, total_protein_g=10.0, total_carbs_g=54.0, total_fat_g=5.0,
    )
    session.add(r); session.commit(); session.refresh(r)
    return r


def _routine_logged_meal(session, user_id: int, *, name: str, meal_date: date, routine_id: int):
    from app.models import Meal, MealItem, MealType, MealSource
    meal = Meal(
        user_id=user_id, meal_date=meal_date, meal_type=MealType.BREAKFAST,
        name=name, source=MealSource.GENERATED, source_type="routine",
        source_routine_id=routine_id,
        routine_occurrence_key=f"routine:{routine_id}:{meal_date.isoformat()}:",
        client_meal_key=None, version=1,
    )
    session.add(meal); session.flush()
    session.add(MealItem(
        meal_id=meal.id, food_name="Oats", quantity=1, unit="cup",
        calories=300.0, protein_g=10.0, carbs_g=54.0, fat_g=5.0,
    ))
    session.commit(); session.refresh(meal)
    return meal


def test_reconcile_deletes_meals_whose_routine_is_archived():  # Reconcile#1
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id, name="Oats", active=False)  # archived
        future = date.today() + timedelta(days=2)
        meal = _routine_logged_meal(s, u.id, name="Oats", meal_date=future, routine_id=r.id)
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["orphan_meals_deleted"] == 1, summary
        assert s.get(Meal, meal.id) is None, "archived-routine meal must be deleted"
    _ok("#Reconcile1 forward meals from archived routine → deleted")


def test_reconcile_deletes_meals_whose_routine_doesnt_cover_weekday():  # Reconcile#2
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        # Find a future date that is NOT a Monday — pick Tuesday + 7 days out.
        future = date.today() + timedelta(days=7)
        while future.weekday() != 1:  # Tuesday
            future += timedelta(days=1)
        # Routine only fires on Monday (0).
        r = _routine(s, u.id, name="Mon-only", days_of_week=[0])
        meal = _routine_logged_meal(s, u.id, name="Mon-only", meal_date=future, routine_id=r.id)
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["orphan_meals_deleted"] == 1, summary
        assert s.get(Meal, meal.id) is None
    _ok("#Reconcile2 forward meals on weekdays routine no longer covers → deleted")


def test_reconcile_leaves_matching_routine_meal_alone():  # Reconcile#3
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        future = date.today() + timedelta(days=3)
        r = _routine(s, u.id, name="Every-day", days_of_week=[])  # empty = every day
        meal = _routine_logged_meal(s, u.id, name="Every-day", meal_date=future, routine_id=r.id)
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["orphan_meals_deleted"] == 0
        assert s.get(Meal, meal.id) is not None, "matching routine meal must NOT be deleted"
    _ok("#Reconcile3 matching routine meal stays intact")


def test_reconcile_does_not_touch_past_routine_meals():  # Reconcile#4
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        past = date.today() - timedelta(days=4)
        r = _routine(s, u.id, name="Archived", active=False)
        past_meal = _routine_logged_meal(s, u.id, name="Archived", meal_date=past, routine_id=r.id)
        summary = reconcile_future_routines(
            s, cutoff=date.today() + timedelta(days=1), apply=True,
        )
        assert summary["orphan_meals_deleted"] == 0
        assert s.get(Meal, past_meal.id) is not None, "past meals must never be touched"
    _ok("#Reconcile4 past-dated routine meals are never touched, history stays frozen")


def test_reconcile_strips_snapshot_meals_with_orphaned_routineId():  # Reconcile#5
    from sqlmodel import Session, select
    from app.models import UserDayState
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        future = date.today() + timedelta(days=2)
        # routine that exists but is inactive
        r_inactive = _routine(s, u.id, name="Old", active=False)
        # Stand up a UserDayState snapshot that references the inactive routine
        # plus an unrelated meal that should stay.
        state = UserDayState(
            user_id=u.id, day_key=future,
            nutrition_plan={
                "meals": [
                    {"meal": "Old Routine", "_routineId": r_inactive.id, "items": []},
                    {"meal": "Manual", "items": []},
                ],
            },
        )
        s.add(state); s.commit()
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["snapshot_meals_stripped"] == 1, summary
        s.refresh(state)
        names = [m.get("meal") for m in (state.nutrition_plan.get("meals") or [])]
        assert names == ["Manual"], f"only the manual meal should remain, got {names}"
    _ok("#Reconcile5 UserDayState snapshot meals tied to dead routine → stripped")


def test_reconcile_dry_run_does_not_delete_or_strip():  # Reconcile#6
    from sqlmodel import Session, select
    from app.models import Meal, UserDayState
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        future = date.today() + timedelta(days=2)
        r = _routine(s, u.id, name="Old", active=False)
        meal = _routine_logged_meal(s, u.id, name="Old", meal_date=future, routine_id=r.id)
        state = UserDayState(
            user_id=u.id, day_key=future,
            nutrition_plan={"meals": [{"meal": "Old", "_routineId": r.id, "items": []}]},
        )
        s.add(state); s.commit()
        summary = reconcile_future_routines(s, cutoff=future, apply=False)
        assert summary["orphan_meals_found"] == 1
        assert summary["orphan_meals_deleted"] == 0
        assert s.get(Meal, meal.id) is not None
    _ok("#Reconcile6 dry-run reports counts but does not delete or strip")


def test_reconcile_dedupes_routine_meals_on_same_future_day():  # Reconcile#8
    """Two Meal rows on the same future date that share the SAME live
    routine collapse to one (the oldest). Catches the case the user
    actually reported: "i still see these again on future days."""
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id, name="Daily")  # every-day, active
        future = date.today() + timedelta(days=2)
        first = _routine_logged_meal(s, u.id, name="Daily", meal_date=future, routine_id=r.id)
        second = _routine_logged_meal(s, u.id, name="Daily", meal_date=future, routine_id=r.id)
        third = _routine_logged_meal(s, u.id, name="Daily", meal_date=future, routine_id=r.id)
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["duplicate_meals_deleted"] == 2, summary
        rows = s.exec(
            select(Meal).where(Meal.user_id == u.id, Meal.meal_date == future)
        ).all()
        assert len(rows) == 1
        assert rows[0].id == first.id, "oldest meal must be kept (lowest id), got %s vs first=%s" % (rows[0].id, first.id)
    _ok("#Reconcile8 dedupes same-routine Meal rows on a future day, keeps oldest")


def test_reconcile_rewrites_snapshot_to_match_current_routine_content():  # Reconcile#9
    """Edited routines must propagate forward: a snapshot meal carrying
    stale name/items/macros from an older routine version is rewritten
    in place to match the live routine. Preserves _loggedMealId."""
    from sqlmodel import Session
    from app.models import UserDayState
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id, name="Live Oats", days_of_week=[])
        future = date.today() + timedelta(days=2)
        # Snapshot has the OLD content + a _loggedMealId we want preserved.
        state = UserDayState(
            user_id=u.id, day_key=future,
            nutrition_plan={
                "meals": [
                    {
                        "meal": "Old Name",
                        "_routineId": r.id,
                        "items": [{"name": "Stale", "quantity": 1, "unit": "serving",
                                   "calories": 50, "protein": 1, "carbs": 1, "fat": 1}],
                        "calories": 50, "protein": 1, "carbs": 1, "fat": 1,
                        "_loggedMealId": 999,
                    },
                ],
            },
        )
        s.add(state); s.commit()
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["snapshot_meals_resynced"] == 1, summary
        s.refresh(state)
        meal = (state.nutrition_plan.get("meals") or [])[0]
        assert meal["meal"] == "Live Oats", f"name must match live routine, got {meal['meal']!r}"
        assert meal["calories"] == 300.0, f"macros must match live routine, got {meal['calories']}"
        assert meal["_loggedMealId"] == 999, "must preserve per-instance _loggedMealId"
        # Items reflect the live routine's items, not the stale snapshot.
        item_names = [it["name"] for it in meal["items"]]
        assert item_names == ["Oats"], f"items must come from live routine, got {item_names}"
    _ok("#Reconcile9 snapshot content resynced to live routine, _loggedMealId preserved")


def test_reconcile_dedupes_snapshot_meals_with_same_routineId():  # Reconcile#10
    from sqlmodel import Session
    from app.models import UserDayState
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u = _user(s)
        r = _routine(s, u.id, name="Dup", days_of_week=[])
        future = date.today() + timedelta(days=2)
        state = UserDayState(
            user_id=u.id, day_key=future,
            nutrition_plan={
                "meals": [
                    {"meal": "Dup", "_routineId": r.id, "items": []},
                    {"meal": "Dup", "_routineId": r.id, "items": []},
                    {"meal": "Dup", "_routineId": r.id, "items": []},
                ],
            },
        )
        s.add(state); s.commit()
        summary = reconcile_future_routines(s, cutoff=future, apply=True)
        assert summary["snapshot_meals_duplicate_stripped"] == 2, summary
        s.refresh(state)
        meals_after = state.nutrition_plan.get("meals") or []
        routine_entries = [m for m in meals_after if (m.get("_routineId") == r.id)]
        assert len(routine_entries) == 1, f"only one entry per routine per day, got {len(routine_entries)}"
    _ok("#Reconcile10 dedupes snapshot meals sharing the same _routineId on one day")


def test_reconcile_scopes_to_user_id():  # Reconcile#7
    from sqlmodel import Session, select
    from app.models import Meal
    from app.services.nutrition.reconcile_future_routines import reconcile_future_routines
    with Session(_engine()) as s:
        u1 = _user(s, "u1@example.com"); u2 = _user(s, "u2@example.com")
        future = date.today() + timedelta(days=2)
        r1 = _routine(s, u1.id, name="A", active=False)
        r2 = _routine(s, u2.id, name="B", active=False)
        m1 = _routine_logged_meal(s, u1.id, name="A", meal_date=future, routine_id=r1.id)
        m2 = _routine_logged_meal(s, u2.id, name="B", meal_date=future, routine_id=r2.id)
        summary = reconcile_future_routines(s, cutoff=future, user_id=u1.id, apply=True)
        assert summary["orphan_meals_deleted"] == 1
        assert s.get(Meal, m1.id) is None
        assert s.get(Meal, m2.id) is not None, "u2's meals must not be touched when scoped to u1"
    _ok("#Reconcile7 --user-id scopes the reconcile to one user")


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
    print(f"\ntest_meal_favorite_sync: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)
