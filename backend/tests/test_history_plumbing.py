"""Tests for the Part 2/Part 3 history-plumbing audit:

  Part 2 — the single-day workout generator honors both the user's
    focus picks AND the split rotation. When the client passes the
    preceding days' focuses via `prev_focuses`, they must land in the
    planner's recent_focus_families/buckets tuples (prepended, since
    tuples are newest-first).

  Part 3 — the nutrition skeleton prompt sees the user's real meal
    history when db/user_id are supplied. The context dict carries
    rolling averages and common meals that aren't there otherwise.

Both are unit tests — no HTTP, no DB. We stub/mock just enough to
verify the plumbing routes values through the call graph.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Part 2: prev_focuses → planner rotation ────────────────────────


def test_prev_focuses_normalize_to_buckets_and_families() -> None:
    """`normalize_focus_to_bucket` + `normalize_focus_to_family` must
    accept the raw labels a client would send via `prev_focuses`
    (e.g. "Upper", "Legs 1 — Squat Bias", "Pull") and return the
    canonical strings the planner's rotation code compares against.
    Regression: if anyone swaps `normalize_focus_to_*` for a stricter
    parser that only accepts canonical inputs, the merge in the
    generate-day endpoint silently drops everything."""
    print("\n[test] prev_focuses raw labels normalize to buckets + families")
    from app.services.workout.focus_normalize import (
        normalize_focus_to_bucket,
        normalize_focus_to_family,
    )

    # Note on family: the family normalizer sees "hinge"/"squat" as
    # leg-specific keywords, so "Lower 2 — Hinge Bias" maps to
    # family='legs' even though its bucket is 'lower_body'. The
    # planner uses both — bucket for coarse rotation, family for
    # fine split identity — so the mismatch is intended.
    cases = [
        # (raw, expected_bucket, expected_family)
        ("Upper",                   "upper_body", "upper"),
        ("Lower 2 — Hinge Bias",    "lower_body", "legs"),
        ("Legs",                    "lower_body", "legs"),
        ("Pull",                    "upper_body", "pull"),
        ("Push Day",                "upper_body", "push"),
        ("Full Body A",             "full_body",  "full_body"),
        ("Cardio — Zone 2",         "cardio",     "cardio"),
        ("Recovery",                "recovery",   "recovery"),
    ]
    for raw, expected_bucket, expected_family in cases:
        b = normalize_focus_to_bucket(raw)
        f = normalize_focus_to_family(raw)
        assert b == expected_bucket, f"bucket: {raw!r} → {b!r}, want {expected_bucket!r}"
        assert f == expected_family, f"family: {raw!r} → {f!r}, want {expected_family!r}"
    _ok(f"{len(cases)} raw focus labels normalize correctly")


def test_prev_focuses_flow_changes_recipe_day0() -> None:
    """When `recent_focus_families` carries a recent-family string,
    the recipe shouldn't open with the same family. This is the
    downstream behavior that Part 2 is wiring up — if `prev_focuses`
    were silently dropped, the planner would not see the user's
    forced-focus choice and could pick the same family again.

    We test the underlying planner path directly: pass a non-empty
    `recent_focus_families` and verify day 0 is NOT the same family."""
    print("\n[test] recent_focus_families steers recipe day 0 away from the last family")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.services.workout.focus_normalize import normalize_focus_to_family
    from app.seed_exercises_data import SEED_EXERCISES

    # Two separate runs: one with no recent focus, one with a
    # forced-upper recent focus. Day 0 of the second should not be
    # the same family as day 0 of the first if the rotation is active.
    inputs_no_history = PlannerInputs(
        goal="muscle_gain", days_per_week=4,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
        rng_seed=42,
    )
    plan0 = generate_workout_plan(inputs_no_history, SEED_EXERCISES)
    day0_family = normalize_focus_to_family(plan0["workout_plan"]["days"][0].get("focus", ""))

    # Now "pretend" the user forced an upper-body day right before
    # this generation window (or the client passed prev_focuses).
    inputs_with_prev = PlannerInputs(
        goal="muscle_gain", days_per_week=4,
        experience="intermediate",
        equipment_slugs=("barbell", "dumbbells", "flat_bench", "squat_rack"),
        rng_seed=42,
        recent_focus_families=("upper",),
    )
    plan1 = generate_workout_plan(inputs_with_prev, SEED_EXERCISES)
    day0_family_with_history = normalize_focus_to_family(
        plan1["workout_plan"]["days"][0].get("focus", "")
    )
    # Core assertion: the recent-history run should NOT emit upper
    # as day 0. (If it does, the rotation is silently broken.)
    assert day0_family_with_history != "upper", (
        f"day 0 family should not match recent 'upper' focus; "
        f"got {day0_family_with_history!r} (no-history baseline = {day0_family!r})"
    )
    _ok(f"recent upper → day 0 family = {day0_family_with_history!r} (not 'upper')")


# ── Part 3: meal-history wiring ────────────────────────────────────


def test_build_nutrition_context_handles_missing_db() -> None:
    """`build_nutrition_context` must remain pure when db/user_id
    are None — no DB calls, no crashes, no meal-history keys.
    Regression for the meal_history integration: if someone later
    unconditionally calls `get_rolling_averages` without a None
    guard, static callers (tests, the review path without db) break."""
    print("\n[test] build_nutrition_context returns static ctx when db=None")
    from app.services.nutrition.context import build_nutrition_context

    ctx = build_nutrition_context(
        goal="muscle_gain",
        bodyweight_lbs=180,
        dietary_preference="omnivore",
    )
    assert ctx.get("goal") == "muscle_gain"
    assert ctx.get("bodyweight_lbs") == 180.0
    # No DB-derived keys should leak in.
    assert "meal_log_avg_kcal_7d" not in ctx
    assert "meal_log_days_7d" not in ctx
    assert "common_meals_14d" not in ctx
    _ok("no meal-history keys when db=None")


def test_build_nutrition_context_calls_meal_history_with_db() -> None:
    """When db+user_id are supplied, meal_history enrichment should
    attempt to read rolling averages + common meals and merge the
    fields into the context dict. We stub the meal_history module
    so the test doesn't need a DB."""
    print("\n[test] build_nutrition_context pulls meal_history when db+user_id supplied")
    from app.services.nutrition import context as ctx_mod
    from app.services.nutrition import meal_history as mh_mod

    # Save & patch the two meal_history functions with stubs.
    orig_rolling = mh_mod.get_rolling_averages
    orig_common  = mh_mod.get_common_meals

    def _stub_rolling(user_id, window=7, *, db):
        assert user_id == 99, f"user_id routed wrong: {user_id}"
        return {
            "avg_calories": 2150.0,
            "avg_protein_g": 155.0,
            "days_with_data": 5,
        }

    def _stub_common(user_id, min_count=2, lookback_days=14, limit=5, *, db):
        return [
            {"name": "Chicken & Rice Bowl", "count": 4},
            {"name": "Greek Yogurt + Berries", "count": 3},
        ]

    class _StubDB:
        """Minimal stub — `_enrich_from_db` runs its own rollup/session
        queries first. Those return nothing on this stub; we only
        care that `get_rolling_averages` + `get_common_meals` fire."""
        def exec(self, stmt):
            class _R:
                def all(self): return []
                def first(self): return None
            return _R()

    mh_mod.get_rolling_averages = _stub_rolling
    mh_mod.get_common_meals = _stub_common
    try:
        ctx = ctx_mod.build_nutrition_context(
            goal="muscle_gain",
            bodyweight_lbs=180,
            db=_StubDB(),
            user_id=99,
        )
    finally:
        mh_mod.get_rolling_averages = orig_rolling
        mh_mod.get_common_meals = orig_common

    # Rolling-average fields land in context.
    assert ctx.get("meal_log_avg_kcal_7d") == 2150, ctx
    assert ctx.get("meal_log_avg_protein_g_7d") == 155.0, ctx
    assert ctx.get("meal_log_days_7d") == 5, ctx
    # Common meals land as a flat list of names.
    common = ctx.get("common_meals_14d") or []
    assert "Chicken & Rice Bowl" in common, common
    _ok("meal_history plumbed into nutrition context")


def test_format_for_prompt_includes_meal_history_lines() -> None:
    """`format_for_prompt` must emit the new meal_history keys when
    present — otherwise the skeleton prompt never sees them even
    though the context dict carries them."""
    print("\n[test] format_for_prompt renders meal_history context lines")
    from app.services.nutrition.context import format_for_prompt

    ctx = {
        "goal": "muscle_gain",
        "meal_log_avg_kcal_7d": 2150,
        "meal_log_avg_protein_g_7d": 155.0,
        "common_meals_14d": ["Chicken & Rice Bowl", "Greek Yogurt"],
    }
    out = format_for_prompt(ctx)
    assert "Actual logged kcal (7d avg): 2150" in out, out
    assert "Actual logged protein (7d avg): 155.0g" in out, out
    assert "Chicken & Rice Bowl" in out, out
    _ok("meal_history context lines render in the skeleton prompt")


def test_log_meal_from_plan_persists_consumed_at() -> None:
    """Checked-off plan meals should preserve eaten time separately
    from logged/created time."""
    print("\n[test] log_meal_from_plan persists consumed_at")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import User, Meal  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    consumed_at = datetime(2026, 4, 29, 12, 45, tzinfo=timezone.utc)
    with Session(engine) as s:
        u = User(email="meal-time@example.com", username="mealtime", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        result = log_meal_from_plan(
            user_id=u.id,
            meal_date=date(2026, 4, 29),
            meal_type="meal_0",
            meal_data={
                "meal": "Greek Yogurt Bowl",
                "items": [
                    {"name": "Greek Yogurt", "quantity": 1, "unit": "cup", "calories": 180, "protein": 20, "carbs": 8, "fat": 4},
                ],
            },
            consumed_at=consumed_at,
            db=s,
        )
        meal = s.get(Meal, result["id"])
        assert meal is not None
        assert meal.consumed_at is not None
        assert meal.consumed_at.isoformat().startswith("2026-04-29T12:45:00"), meal.consumed_at
        assert result["consumed_at"].startswith("2026-04-29T12:45:00"), result
        updated_at = datetime(2026, 4, 29, 14, 5, tzinfo=timezone.utc)
        updated = log_meal_from_plan(
            user_id=u.id,
            meal_date=date(2026, 4, 29),
            meal_type="meal_0",
            meal_data={
                "meal": "Greek Yogurt Bowl",
                "items": [
                    {"name": "Greek Yogurt", "quantity": 1, "unit": "cup", "calories": 180, "protein": 20, "carbs": 8, "fat": 4},
                ],
            },
            consumed_at=updated_at,
            db=s,
        )
        s.refresh(meal)
        assert updated["id"] == meal.id, updated
        assert meal.consumed_at.isoformat().startswith("2026-04-29T14:05:00"), meal.consumed_at
        assert updated["consumed_at"].startswith("2026-04-29T14:05:00"), updated
    _ok("consumed_at is stored and returned")


def test_log_meal_from_plan_replaces_edited_meal_items() -> None:
    """Editing a checked meal should update its nutrition row instead of
    inserting a second same-slot meal that inflates rolling averages."""
    print("\n[test] log_meal_from_plan replaces edited meal items")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.enums import MealType
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 4, 29)
    with Session(engine) as s:
        u = User(email="meal-edit@example.com", username="mealedit", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        initial = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            meal_data={
                "meal": "Greek Yogurt Bowl",
                "items": [
                    {"name": "Greek Yogurt", "quantity": 1, "unit": "cup", "calories": 180, "protein": 20, "carbs": 8, "fat": 4},
                ],
            },
            consumed_at=datetime(2026, 4, 29, 12, 45, tzinfo=timezone.utc),
            db=s,
        )
        edited = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            meal_data={
                "meal": "Greek Yogurt Bowl",
                "items": [
                    {"name": "Greek Yogurt", "quantity": 1.5, "unit": "cup", "calories": 270, "protein": 30, "carbs": 12, "fat": 6},
                ],
            },
            consumed_at=datetime(2026, 4, 29, 13, 30, tzinfo=timezone.utc),
            db=s,
        )

        meals = s.exec(
            select(Meal)
            .where(Meal.user_id == u.id)
            .where(Meal.meal_date == meal_date)
            .where(Meal.meal_type == MealType.BREAKFAST)
        ).all()
        assert edited["id"] == initial["id"], edited
        assert len(meals) == 1, meals
        items = s.exec(select(MealItem).where(MealItem.meal_id == meals[0].id)).all()
        assert len(items) == 1, items
        assert items[0].calories == 270, items[0].calories
        assert items[0].protein_g == 30, items[0].protein_g
    _ok("edited meal replaces prior items without duplicate meal rows")


def test_plan_check_extra_snack_slots_do_not_replace_each_other() -> None:
    """meal_4+ all persist as MealType.SNACK, but they are distinct plan
    slots. Logging meal_5 must not overwrite meal_4."""
    print("\n[test] plan_check extra snack slots stay distinct")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, Meal  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_meal_history, log_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 5, 15)
    with Session(engine) as s:
        u = User(email="extra-slots@example.com", username="extraslots", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        first = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_4",
            meal_data={
                "meal": "Afternoon Shake",
                "items": [
                    {"name": "Whey", "quantity": 1, "unit": "scoop", "calories": 180, "protein": 24, "carbs": 4, "fat": 3},
                ],
            },
            consumed_at=datetime(2026, 5, 15, 15, 0, tzinfo=timezone.utc),
            db=s,
        )
        second = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_5",
            meal_data={
                "meal": "Evening Bowl",
                "items": [
                    {"name": "Rice", "quantity": 1, "unit": "cup", "calories": 240, "protein": 5, "carbs": 52, "fat": 1},
                ],
            },
            consumed_at=datetime(2026, 5, 15, 19, 0, tzinfo=timezone.utc),
            db=s,
        )

        assert first["id"] != second["id"], (first, second)
        rows = s.exec(
            select(Meal)
            .where(Meal.user_id == u.id)
            .where(Meal.meal_date == meal_date)
            .where(Meal.meal_type == MealType.SNACK)
            .where(Meal.source == MealSource.GENERATED)
        ).all()
        assert len(rows) == 2, rows
        assert sorted(r.client_meal_key for r in rows) == ["meal_4", "meal_5"], rows
        history = get_meal_history(u.id, days=1, limit=10, db=s, end_date=meal_date)
        assert len(history) == 2, history
    _ok("meal_4 and meal_5 both remain in generated history")


def test_plan_check_does_not_overwrite_manual_logged_same_name() -> None:
    """A plan check-off that matches an existing manual log in the SAME slot
    (identical name + items) is the same eating event re-saved, so it merges
    into the one row instead of creating a duplicate — this is the fix for the
    "editing a logged meal duplicated it" bug. The merge preserves the manual
    row's id and its LOGGED identity (a plan check-off must never silently
    reclassify a manually logged meal as a generated plan meal)."""
    print("\n[test] plan_check merges into manual same-slot meal, preserving identity")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource
    from app.models import User, Meal  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 5, 15)
    payload = {
        "meal": "Chicken Rice Bowl",
        "items": [
            {"name": "Chicken", "quantity": 1, "unit": "serving", "calories": 220, "protein": 38, "carbs": 0, "fat": 6},
        ],
    }
    with Session(engine) as s:
        u = User(email="same-name@example.com", username="samename", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        manual = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_3",
            meal_data=payload,
            source="manual_add",
            consumed_at=datetime(2026, 5, 15, 12, 0, tzinfo=timezone.utc),
            db=s,
        )
        plan = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_3",
            meal_data=payload,
            source="plan_check",
            consumed_at=datetime(2026, 5, 15, 18, 0, tzinfo=timezone.utc),
            db=s,
        )

        assert manual["id"] == plan["id"], (manual, plan)
        rows = s.exec(select(Meal).where(Meal.user_id == u.id).where(Meal.meal_date == meal_date)).all()
        assert len(rows) == 1, rows
        # Merged in place — the manual row keeps its LOGGED identity.
        assert rows[0].source == MealSource.LOGGED, rows[0].source
        # The check-off time replaces the original (same meal, edited time).
        assert rows[0].consumed_at.hour == 18, rows[0].consumed_at
    _ok("plan check-off merges into the manual row, preserving its LOGGED identity")


def test_unlog_meal_from_plan_removes_checked_row_from_rollups() -> None:
    """Unchecking a meal should remove its persisted backend log so
    Progress nutrition/gut facts cannot drift from meal history."""
    print("\n[test] unlog_meal_from_plan removes checked row from rollups")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import User  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import (
        get_meal_history,
        get_rolling_averages,
        log_meal_from_plan,
        unlog_meal_from_plan,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date.today()
    meal_data = {
        "meal": "Greek Yogurt Bowl",
        "items": [
            {"name": "Greek Yogurt", "quantity": 1, "unit": "cup", "calories": 180, "protein": 20, "carbs": 8, "fat": 4},
        ],
    }
    with Session(engine) as s:
        u = User(email="meal-unlog@example.com", username="mealunlog", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            meal_data=meal_data,
            consumed_at=datetime.now(timezone.utc),
            db=s,
        )
        before = get_rolling_averages(u.id, window=1, db=s)
        assert before["total_meals_logged"] == 1, before

        result = unlog_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            meal_data=meal_data,
            db=s,
        )
        assert result["deleted"] == 1, result
        assert get_meal_history(u.id, days=1, db=s) == []
        after = get_rolling_averages(u.id, window=1, db=s)
        assert after["total_meals_logged"] == 0, after
        assert after["avg_calories_when_logged"] == 0, after
    _ok("unchecked meal no longer appears in history or averages")


def test_unlog_meal_clears_day_state_without_removing_plan_meal() -> None:
    """Unchecking a visible meal removes the log row, not the plan row.

    The mobile app may keep a favorite/manual copy in UserDayState so it can
    still be edited or checked later. The server must clear log provenance from
    that copy; otherwise a reinstall/refetch can make the meal look logged
    again or make the next edit recreate the deleted log.
    """
    print("\n[test] unlog_meal_from_plan clears day-state log stamp without removing meal")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import User, UserDayState  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import log_meal_from_plan, unlog_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 5, 22)
    meal_data = {
        "meal": "Chicken Bowl",
        "items": [
            {"name": "Chicken", "quantity": 1, "unit": "serving", "calories": 300, "protein": 40, "carbs": 10, "fat": 8},
        ],
    }
    client_key = "local_chicken_bowl"
    with Session(engine) as s:
        u = User(email="meal-unlog-state@example.com", username="mealunlogstate", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        logged = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            client_meal_key=client_key,
            meal_data=meal_data,
            source="manual_add",
            consumed_at=datetime(2026, 5, 22, 12, 0, tzinfo=timezone.utc),
            db=s,
        )
        state = UserDayState(
            user_id=u.id,
            day_key=meal_date,
            meal_checks={client_key: True},
            nutrition_plan={
                "meals": [{
                    **meal_data,
                    "_clientMealKey": client_key,
                    "_loggedMealId": logged["id"],
                    "_consumedAt": "2026-05-22T12:00:00+00:00",
                    "_localId": "saved_log_1",
                    "_savedMealId": 7,
                }],
                "targets": {"calories": 2000, "protein": 150, "carbs": 200, "fat": 60},
            },
        )
        s.add(state); s.commit()

        result = unlog_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            client_meal_key=client_key,
            meal_data={**meal_data, "_loggedMealId": logged["id"]},
            source="plan_check",
            db=s,
        )
        assert result["deleted"] == 1, result
        s.refresh(state)
        meals = state.nutrition_plan["meals"]
        assert len(meals) == 1, meals
        assert meals[0]["meal"] == "Chicken Bowl"
        assert "_loggedMealId" not in meals[0], meals[0]
        assert "_consumedAt" not in meals[0], meals[0]
        assert meals[0]["_savedMealId"] == 7, meals[0]
        assert state.meal_checks == {client_key: False}, state.meal_checks
    _ok("unchecking clears log stamp but keeps the visible meal")


def test_delete_logged_meal_clears_user_day_state_copy() -> None:
    """Hard-deleting a logged meal must clear the persisted day-state copy
    too, or the mobile app can replay it on cold start."""
    print("\n[test] delete_logged_meal clears UserDayState nutrition copy")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem, UserDayState  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.meals import delete_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 5, 18)
    with Session(engine) as s:
        u = User(email="meal-delete-state@example.com", username="mealdelete", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        meal = Meal(
            user_id=u.id,
            meal_date=meal_date,
            meal_type=MealType.SNACK,
            name="Protein bar",
            source=MealSource.LOGGED,
            client_meal_key="meal_3",
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Protein bar",
            quantity=1,
            unit="bar",
            calories=210,
            protein_g=20,
            carbs_g=22,
            fat_g=6,
        ))
        s.add(UserDayState(
            user_id=u.id,
            day_key=meal_date,
            meal_checks={"meal_0": True, "meal_1": True, "meal_2": True, "meal_3": True, "meal_4": True},
            nutrition_plan={
                "meals": [
                    {"meal": "Breakfast", "calories": 300},
                    {"meal": "Lunch", "calories": 500},
                    {"meal": "Snack", "calories": 150},
                    {"meal": "Protein bar", "calories": 210, "_loggedMealId": meal.id},
                    {"meal": "Dinner", "calories": 600},
                ],
                "targets": {"calories": 2200, "protein": 160, "carbs": 240, "fat": 70},
            },
        ))
        s.commit(); s.refresh(meal)

        delete_meal(meal.id, current_user=u, db=s)

        state = s.exec(
            select(UserDayState).where(UserDayState.user_id == u.id, UserDayState.day_key == meal_date)
        ).first()
        assert state is not None
        assert [m["meal"] for m in state.nutrition_plan["meals"]] == ["Breakfast", "Lunch", "Snack", "Dinner"]
        assert state.meal_checks == {"meal_0": True, "meal_1": True, "meal_2": True, "meal_3": True}
        assert s.get(Meal, meal.id) is None
        assert s.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all() == []
    _ok("hard delete removes day-state meal and shifts following checks")


def test_delete_logged_meal_uses_stable_client_key_without_shifting_checks() -> None:
    """Stable client meal keys are row identity; deleting one row must not
    reinterpret the remaining stable checks by array position."""
    print("\n[test] delete_logged_meal uses stable client key without shifting checks")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem, UserDayState  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.meals import delete_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 5, 19)
    deleted_key = "log_901"
    kept_key = "local_dinner_1"
    with Session(engine) as s:
        u = User(email="meal-delete-stable@example.com", username="mealdeletestable", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        meal = Meal(
            user_id=u.id,
            meal_date=meal_date,
            meal_type=MealType.BREAKFAST,
            name="Egg Breakfast",
            source=MealSource.LOGGED,
            client_meal_key=deleted_key,
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Eggs",
            quantity=2,
            unit="piece",
            calories=180,
            protein_g=14,
            carbs_g=1,
            fat_g=12,
        ))
        s.add(UserDayState(
            user_id=u.id,
            day_key=meal_date,
            meal_checks={deleted_key: True, kept_key: True},
            nutrition_plan={
                "meals": [
                    {"meal": "Egg Breakfast", "calories": 180, "_loggedMealId": meal.id, "_clientMealKey": deleted_key},
                    {"meal": "Dinner", "calories": 600, "_clientMealKey": kept_key},
                ],
                "targets": {"calories": 2200, "protein": 160, "carbs": 240, "fat": 70},
            },
        ))
        s.commit(); s.refresh(meal)

        delete_meal(meal.id, current_user=u, db=s)

        state = s.exec(
            select(UserDayState).where(UserDayState.user_id == u.id, UserDayState.day_key == meal_date)
        ).first()
        assert state is not None
        assert [m["meal"] for m in state.nutrition_plan["meals"]] == ["Dinner"]
        assert state.meal_checks == {kept_key: True}, state.meal_checks
    _ok("hard delete removes stable-key row without reindexing remaining checks")


def test_log_meal_from_plan_collapses_existing_generated_duplicates() -> None:
    """Existing duplicate generated rows for one checked plan meal should
    be collapsed when the meal is logged again."""
    print("\n[test] log_meal_from_plan collapses existing generated duplicates")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import log_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date(2026, 4, 29)
    with Session(engine) as s:
        u = User(email="meal-dupe@example.com", username="mealdupe", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        for calories in (180, 210):
            meal = Meal(
                user_id=u.id,
                meal_date=meal_date,
                meal_type=MealType.BREAKFAST,
                name="Greek Yogurt Bowl",
                source=MealSource.GENERATED,
                consumed_at=datetime(2026, 4, 29, 12, 0, tzinfo=timezone.utc),
            )
            s.add(meal); s.flush()
            s.add(MealItem(
                meal_id=meal.id,
                food_name="Greek Yogurt",
                quantity=1,
                unit="cup",
                calories=calories,
                protein_g=20,
                carbs_g=8,
                fat_g=4,
            ))
        s.commit()

        updated = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_0",
            meal_data={
                "meal": "Greek Yogurt Bowl",
                "items": [
                    {"name": "Greek Yogurt", "quantity": 1.5, "unit": "cup", "calories": 270, "protein": 30, "carbs": 12, "fat": 6},
                ],
            },
            consumed_at=datetime(2026, 4, 29, 13, 30, tzinfo=timezone.utc),
            db=s,
        )

        meals = s.exec(
            select(Meal)
            .where(Meal.user_id == u.id)
            .where(Meal.meal_date == meal_date)
            .where(Meal.name == "Greek Yogurt Bowl")
        ).all()
        assert len(meals) == 1, meals
        assert updated["id"] == meals[0].id, updated
        items = s.exec(select(MealItem).where(MealItem.meal_id == meals[0].id)).all()
        assert len(items) == 1, items
        assert items[0].calories == 270, items[0].calories
    _ok("existing generated duplicates are collapsed to one updated row")


def test_manual_add_same_meal_twice_creates_two_history_rows() -> None:
    """Manual meal adds are user intent, not plan-check retries. Logging
    the same payload twice should keep both rows in history and rollups."""
    print("\n[test] manual_add same meal twice creates two history rows")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, Meal  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_meal_history, log_meal_from_plan

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date.today()
    payload = {
        "meal": "Protein Shake",
        "items": [
            {"name": "Whey", "quantity": 1, "unit": "scoop", "calories": 120, "protein": 24, "carbs": 3, "fat": 2},
        ],
    }
    with Session(engine) as s:
        u = User(email="manual-repeat@example.com", username="manualrepeat", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        first = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_3",
            meal_data=payload,
            source="manual_add",
            consumed_at=datetime(2026, 5, 3, 12, 0, tzinfo=timezone.utc),
            db=s,
        )
        second = log_meal_from_plan(
            user_id=u.id,
            meal_date=meal_date,
            meal_type="meal_3",
            meal_data=payload,
            source="manual_add",
            consumed_at=datetime(2026, 5, 3, 12, 1, tzinfo=timezone.utc),
            db=s,
        )

        assert first["id"] != second["id"], (first, second)
        rows = s.exec(
            select(Meal)
            .where(Meal.user_id == u.id)
            .where(Meal.meal_date == meal_date)
            .where(Meal.meal_type == MealType.SNACK)
            .where(Meal.source == MealSource.LOGGED)
        ).all()
        assert len(rows) == 2, rows
        history = get_meal_history(u.id, days=1, limit=10, db=s)
        assert len(history) == 2, history
    _ok("manual repeated meals are preserved as separate logs")


def test_rolling_averages_ignore_duplicate_generated_plan_rows() -> None:
    """Rolling averages should not multiply calories from repeated plan
    check-off rows with the same generated meal name."""
    print("\n[test] rolling averages ignore duplicate generated plan rows")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_rolling_averages

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date.today()
    with Session(engine) as s:
        u = User(email="meal-average-dupe@example.com", username="mealavgdupe", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        for calories in (900, 1100):
            meal = Meal(
                user_id=u.id,
                meal_date=meal_date,
                meal_type=MealType.BREAKFAST,
                name="Balanced meal 1",
                source=MealSource.GENERATED,
            )
            s.add(meal); s.flush()
            s.add(MealItem(
                meal_id=meal.id,
                food_name="Chicken Breast",
                quantity=1,
                unit="serving",
                calories=calories,
                protein_g=60,
                carbs_g=80,
                fat_g=25,
            ))
        s.commit()

        averages = get_rolling_averages(u.id, window=1, db=s)
        assert averages["total_meals_logged"] == 1, averages
        assert averages["avg_calories"] == 1100.0, averages
        assert averages["avg_calories_when_logged"] == 1100.0, averages
    _ok("generated duplicate rows do not inflate calorie averages")


def test_rolling_averages_preserve_distinct_generic_meals() -> None:
    """Generic generated names can represent multiple user-added meals;
    different item signatures should still count separately."""
    print("\n[test] rolling averages preserve distinct generic generated meals")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_rolling_averages

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date.today()
    with Session(engine) as s:
        u = User(email="generic-meals@example.com", username="genericmeals", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        for food_name, calories in (("Snack A", 100), ("Snack B", 200)):
            meal = Meal(
                user_id=u.id,
                meal_date=meal_date,
                meal_type=MealType.SNACK,
                name="New Meal",
                source=MealSource.GENERATED,
            )
            s.add(meal); s.flush()
            s.add(MealItem(
                meal_id=meal.id,
                food_name=food_name,
                quantity=1,
                unit="serving",
                calories=calories,
                protein_g=10,
                carbs_g=10,
                fat_g=5,
            ))
        s.commit()

        averages = get_rolling_averages(u.id, window=1, db=s)
        assert averages["total_meals_logged"] == 2, averages
        assert averages["avg_calories"] == 300.0, averages
    _ok("distinct generic generated meals remain separate")


def test_meal_history_limits_after_deduping_generated_rows() -> None:
    """Duplicate generated rows should not consume the whole history limit
    before older real meal days can be returned."""
    print("\n[test] meal history applies limit after generated de-dupe")
    from datetime import date, timedelta
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_meal_history

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    today = date.today()
    older = today - timedelta(days=1)
    with Session(engine) as s:
        u = User(email="meal-history-limit@example.com", username="meallimit", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        for calories in (500, 550, 600, 650, 700):
            meal = Meal(
                user_id=u.id,
                meal_date=today,
                meal_type=MealType.BREAKFAST,
                name="Balanced meal 1",
                source=MealSource.GENERATED,
            )
            s.add(meal); s.flush()
            s.add(MealItem(
                meal_id=meal.id,
                food_name="Oats",
                quantity=1,
                unit="bowl",
                calories=calories,
                protein_g=20,
                carbs_g=80,
                fat_g=12,
            ))
        old_meal = Meal(
            user_id=u.id,
            meal_date=older,
            meal_type=MealType.LUNCH,
            name="Older lunch",
            source=MealSource.GENERATED,
        )
        s.add(old_meal); s.flush()
        s.add(MealItem(
            meal_id=old_meal.id,
            food_name="Chicken",
            quantity=1,
            unit="serving",
            calories=400,
            protein_g=40,
            carbs_g=20,
            fat_g=10,
        ))
        s.commit()

        history = get_meal_history(u.id, days=7, limit=2, db=s)
        assert len(history) == 2, history
        assert [row["meal_date"] for row in history] == [str(today), str(older)], history
        assert history[0]["totals"]["calories"] == 700, history
    _ok("history limit is applied after duplicate collapse")


def test_meal_history_window_matches_rolling_average_window() -> None:
    """History should use the same inclusive window as rolling averages:
    days=1 means today only, never yesterday or future-dated rows."""
    print("\n[test] meal history window matches rolling averages")
    from datetime import date, timedelta
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import User, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_meal_history

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    today = date.today()
    with Session(engine) as s:
        u = User(email="meal-history-window@example.com", username="mealwindow", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        for meal_date, name, calories in (
            (today - timedelta(days=1), "Yesterday", 400),
            (today, "Today", 700),
            (today + timedelta(days=1), "Tomorrow", 900),
        ):
            meal = Meal(
                user_id=u.id,
                meal_date=meal_date,
                meal_type=MealType.LUNCH,
                name=name,
                source=MealSource.LOGGED,
            )
            s.add(meal); s.flush()
            s.add(MealItem(
                meal_id=meal.id,
                food_name=name,
                quantity=1,
                unit="serving",
                calories=calories,
                protein_g=20,
                carbs_g=50,
                fat_g=10,
            ))
        s.commit()

        one_day = get_meal_history(u.id, days=1, limit=10, db=s)
        assert [row["meal_date"] for row in one_day] == [str(today)], one_day
        assert one_day[0]["totals"]["calories"] == 700, one_day

        two_days = get_meal_history(u.id, days=2, limit=10, db=s)
        assert [row["meal_date"] for row in two_days] == [str(today), str(today - timedelta(days=1))], two_days
    _ok("history days window is today-capped and off-by-one free")


def test_saved_meal_log_retry_is_idempotent() -> None:
    """A retry of the same saved-meal log should return the existing row
    instead of inflating nutrition totals."""
    print("\n[test] saved meal log retry is idempotent")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, SavedMeal, Meal  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.saved_meals import log_saved_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="saved-retry@example.com", username="savedretry", hashed_password="x")
        saved = SavedMeal(
            user_id=1,
            name="Veggie shake",
            total_calories=211,
            total_protein_g=6.5,
            total_carbs_g=30,
            total_fat_g=5,
            items=[{
                "food_name": "Veggie shake",
                "quantity": 1,
                "unit": "serving",
                "calories": 211,
                "protein_g": 6.5,
                "carbs_g": 30,
                "fat_g": 5,
            }],
        )
        s.add(u); s.commit(); s.refresh(u)
        saved.user_id = u.id
        s.add(saved); s.commit(); s.refresh(saved)

        consumed_at = datetime(2026, 4, 24, 14, 16, tzinfo=timezone.utc).isoformat()
        body = {"meal_date": str(date(2026, 4, 24)), "meal_type": "lunch", "consumed_at": consumed_at}
        first = log_saved_meal(saved.id, body, current_user=u, db=s)
        second = log_saved_meal(saved.id, body, current_user=u, db=s)

        rows = s.exec(select(Meal).where(Meal.user_id == u.id)).all()
        assert first["meal_id"] == second["meal_id"], (first, second)
        assert len(rows) == 1, rows
        assert rows[0].saved_meal_id == saved.id, rows[0]
        assert second["times_logged"] == 1, second
    _ok("saved meal retry returns existing log row")


def test_create_saved_meal_from_logged_history_links_source_meal() -> None:
    """Saving a previous-day logged meal as a favorite should clone its
    backend item snapshots and link the source row without letting later
    favorite edits rewrite that history meal."""
    print("\n[test] create saved meal from logged history links source meal")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import User, SavedMeal, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.saved_meals import create_saved_meal, update_saved_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="saved-from-history@example.com", username="savedfromhistory", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        meal = Meal(
            user_id=u.id,
            meal_date=date(2026, 4, 24),
            meal_type=MealType.LUNCH,
            name="Turkey bowl",
            source=MealSource.LOGGED,
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Turkey",
            quantity=1,
            unit="serving",
            calories=240,
            protein_g=42,
            carbs_g=0,
            fat_g=8,
            calcium_mg=22,
            potassium_mg=315,
            vitamin_b12_mcg=1.1,
        ))
        s.commit(); s.refresh(meal)

        created = create_saved_meal({"from_meal_id": meal.id}, current_user=u, db=s)
        favorite = s.get(SavedMeal, created["id"])
        source = s.get(Meal, meal.id)
        assert favorite is not None, created
        assert favorite.name == "Turkey bowl", favorite
        assert favorite.items[0]["food_name"] == "Turkey", favorite.items
        assert favorite.items[0]["potassium_mg"] == 315, favorite.items
        assert favorite.items[0]["micronutrients"]["calcium"] == 22, favorite.items
        assert favorite.items[0]["micronutrients"]["vitamin_b12"] == 1.1, favorite.items
        assert source.saved_meal_id == favorite.id, source

        update_saved_meal(favorite.id, {"name": "Turkey rice bowl"}, current_user=u, db=s)
        s.refresh(source)
        assert source.name == "Turkey bowl", source
        assert source.saved_meal_id == favorite.id, source
    _ok("favorite created from history row links source meal")


def test_saved_meal_rename_keeps_logged_rows_snapshotted() -> None:
    """Renaming a favorite should not rewrite logged meal history, even
    when a meal is linked by saved_meal_id or legacy name/signature."""
    print("\n[test] saved meal rename keeps logged rows snapshotted")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, SavedMeal, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.saved_meals import log_saved_meal, update_saved_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="saved-rename@example.com", username="savedrename", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        saved = SavedMeal(
            user_id=u.id,
            name="Veggie shake",
            total_calories=211,
            total_protein_g=6.5,
            total_carbs_g=30,
            total_fat_g=5,
            items=[{
                "food_name": "Veggie shake",
                "quantity": 1,
                "unit": "serving",
                "calories": 211,
                "protein_g": 6.5,
                "carbs_g": 30,
                "fat_g": 5,
            }],
        )
        s.add(saved); s.commit(); s.refresh(saved)

        logged = log_saved_meal(
            saved.id,
            {"meal_date": str(date(2026, 4, 24)), "meal_type": "lunch"},
            current_user=u,
            db=s,
        )
        legacy = Meal(
            user_id=u.id,
            meal_date=date(2026, 4, 23),
            meal_type=MealType.LUNCH,
            name="Veggie shake",
            source=MealSource.LOGGED,
        )
        unrelated = Meal(
            user_id=u.id,
            meal_date=date(2026, 4, 22),
            meal_type=MealType.LUNCH,
            name="Veggie shake",
            source=MealSource.LOGGED,
        )
        s.add(legacy); s.add(unrelated); s.flush()
        s.add(MealItem(
            meal_id=legacy.id,
            food_name="Veggie shake",
            quantity=1,
            unit="serving",
            calories=211,
            protein_g=6.5,
            carbs_g=30,
            fat_g=5,
        ))
        s.add(MealItem(
            meal_id=unrelated.id,
            food_name="Veggie shake",
            quantity=2,
            unit="serving",
            calories=422,
            protein_g=13,
            carbs_g=60,
            fat_g=10,
        ))
        s.commit()

        update_saved_meal(saved.id, {"name": "Green shake"}, current_user=u, db=s)

        linked_row = s.get(Meal, logged["meal_id"])
        legacy_row = s.get(Meal, legacy.id)
        unrelated_row = s.get(Meal, unrelated.id)
        assert linked_row.name == "Veggie shake", linked_row
        assert legacy_row.name == "Veggie shake", legacy_row
        assert linked_row.saved_meal_id == saved.id, linked_row
        assert legacy_row.saved_meal_id is None, legacy_row
        assert unrelated_row.name == "Veggie shake", unrelated_row
        assert unrelated_row.saved_meal_id is None, unrelated_row
    _ok("saved meal rename leaves linked and legacy logs unchanged")


def test_saved_meal_delete_detaches_logged_meals() -> None:
    """Unfavoriting/deleting a saved meal should not delete or block the
    real meal-history rows that were logged from it."""
    print("\n[test] saved meal delete detaches logged meals")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import User, SavedMeal, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.saved_meals import delete_saved_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="saved-delete@example.com", username="saveddelete", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        saved = SavedMeal(
            user_id=u.id,
            name="Chicken bowl",
            total_calories=500,
            total_protein_g=42,
            total_carbs_g=50,
            total_fat_g=14,
            items=[],
        )
        s.add(saved); s.commit(); s.refresh(saved)
        meal = Meal(
            user_id=u.id,
            meal_date=date(2026, 4, 24),
            meal_type=MealType.LUNCH,
            name="Chicken bowl",
            source=MealSource.LOGGED,
            saved_meal_id=saved.id,
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Chicken",
            quantity=1,
            unit="serving",
            calories=220,
            protein_g=40,
            carbs_g=0,
            fat_g=6,
        ))
        s.commit(); s.refresh(meal)

        delete_saved_meal(saved.id, current_user=u, db=s)

        kept_meal = s.get(Meal, meal.id)
        assert kept_meal is not None
        assert kept_meal.saved_meal_id is None, kept_meal
        assert s.get(SavedMeal, saved.id) is None
    _ok("deleting saved meal leaves logged meal editable/deletable")


def test_patch_saved_meal_log_detaches_and_replaces_items() -> None:
    """Editing a meal that came from a favorite should turn it back into
    an independent history row and replace item snapshots cleanly."""
    print("\n[test] patch saved-meal log detaches and replaces items")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import MealSource, MealType
    from app.models import User, SavedMeal, Meal, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.meals import update_meal

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="saved-edit@example.com", username="savededit", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        saved = SavedMeal(
            user_id=u.id,
            name="Protein bowl",
            total_calories=400,
            total_protein_g=35,
            total_carbs_g=35,
            total_fat_g=12,
            items=[],
        )
        s.add(saved); s.commit(); s.refresh(saved)
        meal = Meal(
            user_id=u.id,
            meal_date=date(2026, 4, 24),
            meal_type=MealType.LUNCH,
            name="Protein bowl",
            source=MealSource.LOGGED,
            saved_meal_id=saved.id,
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Chicken",
            quantity=1,
            unit="serving",
            calories=220,
            protein_g=40,
            carbs_g=0,
            fat_g=6,
        ))
        s.commit(); s.refresh(meal)

        updated = update_meal(
            meal.id,
            {
                "name": "Edited protein bowl",
                "items": [{
                    "name": "Greek yogurt",
                    "quantity": 1,
                    "unit": "cup",
                    "calories": 180,
                    "protein": 20,
                    "carbs": 8,
                    "fat": 4,
                }],
            },
            current_user=u,
            db=s,
        )

        s.refresh(meal)
        items = s.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
        assert updated.meal["name"] == "Edited protein bowl", updated
        assert meal.saved_meal_id is None, meal
        assert len(items) == 1, items
        assert items[0].food_name == "Greek yogurt", items[0]
        assert items[0].calories == 180, items[0]
    _ok("editing saved-meal log detaches provenance and replaces items")


def test_logged_ai_food_micros_are_persisted_for_gut_metrics() -> None:
    """AI/USDA food-search results arrive with per-item micronutrients.
    Logging an unmatched custom item should turn those into a FoodNutrition
    row so gut facts and the Nutrition Score can read them historically."""
    print("\n[test] logged custom food micros persist into FoodNutrition")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, FoodNutrition, MealItem  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import log_meal_from_plan
    from app.services.nutrition.gut_health import compute_daily_metrics

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="custom-micros@example.com", username="custommicros", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        d = date.today()
        log_meal_from_plan(
            user_id=u.id,
            meal_date=d,
            meal_type="snack",
            source="manual_add",
            db=s,
            meal_data={
                "meal": "AI berry bowl",
                "items": [{
                    "name": "AI Berry Fiber Bowl",
                    "quantity": 1,
                    "unit": "bowl",
                    "calories": 420,
                    "protein": 24,
                    "carbs": 58,
                    "fat": 12,
                    "micronutrients": {
                        "fiber": 14,
                        "added_sugar": 3,
                        "sodium": 180,
                        "saturated_fat": 2,
                        "calcium": 220,
                    },
                }],
            },
        )
        item = s.exec(select(MealItem)).first()
        assert item and item.food_id is not None, item
        nutrition = s.exec(select(FoodNutrition).where(FoodNutrition.food_id == item.food_id)).first()
        assert nutrition is not None
        assert nutrition.fiber == 14
        assert nutrition.added_sugar_g == 3
        assert (nutrition.extra_nutrients or {}).get("calcium") == 220

        row = compute_daily_metrics(s, user_id=u.id, metric_date=d, allow_ai=False)
        assert row.fiber_total_g == 14, row.model_dump()
        assert row.added_sugar_g == 3, row.model_dump()
        assert row.saturated_fat_g == 2, row.model_dump()
    _ok("unmatched AI food micros feed daily gut metrics")


def test_patch_meal_items_refreshes_history_averages_and_gut_metrics() -> None:
    """Editing a backend meal-history row should replace MealItem rows and
    immediately refresh the facts surfaces that read meal history, rolling
    averages, and DailyNutritionMetrics."""
    print("\n[test] meal patch refreshes history averages and gut metrics")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.enums import FoodCategory, FoodSource, MealSource, MealType
    from app.models import Food, FoodNutrition, Meal, MealItem, User  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.meals import update_meal
    from app.services.nutrition.gut_health import compute_daily_metrics, compute_weekly_rollup
    from app.services.nutrition.meal_history import get_meal_history, get_rolling_averages

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    meal_date = date.today()
    with Session(engine) as s:
        u = User(email="meal-patch@example.com", username="mealpatch", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        food = Food(
            name="Fiber oats",
            normalized_name="fiber oats",
            category=FoodCategory.GRAINS_CARBS,
            source=FoodSource.SEED,
            is_verified=True,
        )
        s.add(food); s.flush()
        s.add(FoodNutrition(
            food_id=food.id,
            reference_grams=100,
            calories=100,
            protein=8,
            carbs=18,
            fat=2,
            fiber=10,
            added_sugar_g=1,
        ))
        meal = Meal(
            user_id=u.id,
            meal_date=meal_date,
            meal_type=MealType.BREAKFAST,
            name="Old oats",
            source=MealSource.LOGGED,
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Fiber oats",
            food_id=food.id,
            quantity=1,
            unit="serving",
            serving_grams=100,
            calories=100,
            protein_g=8,
            carbs_g=18,
            fat_g=2,
        ))
        s.commit(); s.refresh(meal)
        before = compute_daily_metrics(s, user_id=u.id, metric_date=meal_date, allow_ai=False)
        assert before.fiber_total_g == 10, before.model_dump()

        update_meal(
            meal.id,
            {
                "name": "Edited oats",
                "items": [{
                    "food_name": "Fiber oats",
                    "food_id": food.id,
                    "quantity": 2,
                    "unit": "serving",
                    "serving_grams": 200,
                    "calories": 200,
                    "protein_g": 16,
                    "carbs_g": 36,
                    "fat_g": 4,
                    "micronutrients": {"potassium": 400, "calcium": 80},
                }],
            },
            current_user=u,
            db=s,
        )

        rows = s.exec(select(MealItem).where(MealItem.meal_id == meal.id)).all()
        assert len(rows) == 1, rows
        assert rows[0].calories == 200, rows[0].model_dump()
        assert rows[0].potassium_mg == 400, rows[0].model_dump()
        assert rows[0].calcium_mg == 80, rows[0].model_dump()

        history = get_meal_history(u.id, days=1, db=s)
        assert history[0]["name"] == "Edited oats", history
        assert history[0]["items"][0]["micronutrients"]["potassium"] == 400, history
        assert history[0]["totals"]["calories"] == 200, history
        averages = get_rolling_averages(u.id, window=1, db=s)
        assert averages["avg_calories"] == 200.0, averages

        rollup = compute_weekly_rollup(s, user_id=u.id, end_date=meal_date, days=1)
        assert rollup["avg_calories"] == 200.0, rollup
        assert rollup["avg_fiber_g"] == 20.0, rollup
        assert rollup["avg_added_sugar_g"] == 2.0, rollup
    _ok("meal edit updates history, averages, and gut facts")


def test_score_micros_read_unsuffixed_aliases_and_calorie_fallback() -> None:
    """FoodNutrition.extra_nutrients historically stores both suffixed
    keys (`calcium_mg`) and plan/search keys (`calcium`). The score builder
    must read both, even when older MealItems lack serving_grams."""
    print("\n[test] score micros read alias keys + derive grams from calories")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import FoodCategory, FoodSource, MealSource, MealType
    from app.models import Food, FoodNutrition, Meal, MealItem, User  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.score_builder import _aggregate_micros

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="micro-alias@example.com", username="microalias", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        food = Food(
            name="Alias Yogurt",
            normalized_name="alias yogurt",
            category=FoodCategory.DAIRY,
            source=FoodSource.AI,
        )
        s.add(food); s.flush()
        s.add(FoodNutrition(
            food_id=food.id,
            reference_grams=100,
            calories=200,
            protein=20,
            carbs=20,
            fat=5,
            fiber=8,
            extra_nutrients={"calcium": 300, "vitamin_d": 4, "vitamin_b12": 1.2},
        ))
        meal = Meal(
            user_id=u.id,
            meal_date=date.today(),
            meal_type=MealType.SNACK,
            name="Alias Yogurt",
            source=MealSource.LOGGED,
        )
        s.add(meal); s.flush()
        item = MealItem(
            meal_id=meal.id,
            food_name="Alias Yogurt",
            food_id=food.id,
            quantity=1,
            unit="serving",
            serving_grams=None,
            calories=100,
            protein_g=10,
            carbs_g=10,
            fat_g=2.5,
        )
        s.add(item); s.commit()

        micros, food_count, with_micros = _aggregate_micros(s, [item])
        assert food_count == 1
        assert with_micros == 1
        assert micros["fiber_g"] == 4
        assert micros["calcium_mg"] == 150
        assert micros["vitamin_d_mcg"] == 2
        assert micros["vitamin_b12_mcg"] == 0.6
    _ok("score micronutrients survive alias keys and missing serving_grams")


def test_meal_history_rehydrates_food_nutrition_micros() -> None:
    """History payloads must expose DB FoodNutrition micros for sparse item rows."""
    print("\n[test] meal history rehydrates FoodNutrition micronutrients")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import FoodCategory, FoodSource, MealSource, MealType
    from app.models import Food, FoodNutrition, Meal, MealItem, User  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.meal_history import get_meal_history

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="history-micros@example.com", username="historymicros", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        food = Food(
            name="Micronutrient Yogurt",
            normalized_name="micronutrient yogurt",
            category=FoodCategory.DAIRY,
            source=FoodSource.AI,
        )
        s.add(food); s.flush()
        s.add(FoodNutrition(
            food_id=food.id,
            reference_grams=100,
            calories=200,
            protein=20,
            carbs=20,
            fat=5,
            fiber=8,
            sodium_mg=120,
            extra_nutrients={"calcium": 300, "vitamin_d": 4, "zinc": 2},
        ))
        meal = Meal(
            user_id=u.id,
            meal_date=date.today(),
            meal_type=MealType.SNACK,
            name="Micronutrient Yogurt",
            source=MealSource.LOGGED,
        )
        s.add(meal); s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Micronutrient Yogurt",
            food_id=food.id,
            quantity=1,
            unit="serving",
            serving_grams=None,
            calories=100,
            protein_g=10,
            carbs_g=10,
            fat_g=2.5,
        ))
        s.commit()

        history = get_meal_history(u.id, days=1, db=s)
        micros = history[0]["items"][0]["micronutrients"]
        assert micros["fiber"] == 4, history
        assert micros["sodium"] == 60, history
        assert micros["calcium"] == 150, history
        assert micros["vitamin_d"] == 2, history
        assert micros["zinc"] == 1, history
    _ok("meal history exposes DB-derived item micronutrients")


def test_gut_rollup_uses_logged_days_not_empty_metric_placeholders() -> None:
    """Reading /gut-health creates an empty row for today. That row should
    not dilute historical averages when no meals were logged today."""
    print("\n[test] gut rollup ignores empty metric placeholders")
    from datetime import date, timedelta
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import DailyNutritionMetrics, User  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.gut_health import compute_weekly_rollup

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    today = date.today()
    with Session(engine) as s:
        u = User(email="gut-rollup@example.com", username="gutrollup", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today - timedelta(days=1),
            calories_total=2000,
            fiber_total_g=28,
            fiber_per_1000_kcal=14,
            added_sugar_g=10,
            plant_protein_g=30,
            animal_protein_g=90,
            item_count=4,
            plant_slugs=["oat", "blueberry"],
            processing_counts={"minimally_processed": 4},
        ))
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today,
            calories_total=0,
            fiber_total_g=0,
            item_count=0,
            processing_counts={},
        ))
        s.commit()

        rollup = compute_weekly_rollup(s, user_id=u.id, end_date=today, days=2)
        assert rollup["days_with_data"] == 1, rollup
        assert rollup["avg_fiber_g"] == 28, rollup
        assert rollup["avg_calories"] == 2000, rollup
        assert rollup["avg_plant_protein_g"] == 30, rollup
    _ok("empty today row no longer dilutes gut averages")


def test_gut_rollup_serving_averages_include_omega3_supplements() -> None:
    """Gut facts keep raw totals for compatibility, expose daily averages
    for the UI, and count logged omega-3 supplements in the omega signal."""
    print("\n[test] gut rollup serving averages include omega-3 supplements")
    from datetime import date, datetime, time, timedelta, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import (
        DailyNutritionMetrics, SupplementIngredient, SupplementLog,
        User, UserSupplementStack,
    )  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.gut_health import compute_weekly_rollup

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    today = date.today()
    with Session(engine) as s:
        u = User(email="gut-supp@example.com", username="gutsupp", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        omega = SupplementIngredient(
            slug="omega_3",
            name="Omega-3 (EPA/DHA)",
            category="fatty_acid",
            default_unit="mg",
        )
        s.add(omega); s.flush()
        stack = UserSupplementStack(
            user_id=u.id,
            supplement_ingredient_id=omega.id,
            custom_name=omega.name,
            category="fatty_acid",
            dose_amount=1000,
            dose_unit="mg",
        )
        s.add(stack); s.flush()
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today - timedelta(days=1),
            calories_total=1900,
            item_count=4,
            fermented_servings=2,
            probiotic_servings=0.5,
            omega3_servings=0.5,
            plant_slugs=["oat"],
            processing_counts={"minimally_processed": 4},
        ))
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today,
            calories_total=2100,
            item_count=4,
            fermented_servings=1,
            probiotic_servings=0.5,
            omega3_servings=0,
            plant_slugs=["blueberry"],
            processing_counts={"minimally_processed": 4},
        ))
        s.add(SupplementLog(
            user_id=u.id,
            stack_item_id=stack.id,
            taken_at=datetime.combine(today, time(hour=8), tzinfo=timezone.utc),
            dose_amount=1000,
            dose_unit="mg",
            skipped=False,
        ))
        s.commit()

        rollup = compute_weekly_rollup(s, user_id=u.id, end_date=today, days=2)
        assert rollup["fermented_servings"] == 3, rollup
        assert rollup["avg_fermented_servings"] == 1.5, rollup
        assert rollup["probiotic_servings"] == 1, rollup
        assert rollup["avg_probiotic_servings"] == 0.5, rollup
        assert rollup["omega3_food_servings"] == 0.5, rollup
        assert rollup["omega3_supplement_servings"] == 1, rollup
        assert rollup["omega3_servings"] == 1.5, rollup
        assert rollup["avg_omega3_servings"] == 0.8, rollup
    _ok("gut serving averages and omega-3 supplement rollup are stable")


def test_gut_empty_rollup_exposes_prebiotic_and_fiber_density_fields() -> None:
    """The empty rollup must carry the same keys as a populated one so the
    UI never KeyErrors on a no-data week."""
    print("\n[test] empty gut rollup exposes prebiotic + fiber-density fields")
    from app.services.nutrition.gut_health import _empty_rollup

    empty = _empty_rollup(7)
    assert empty["prebiotic_g"] == 0.0, empty
    assert empty["avg_prebiotic_g"] == 0.0, empty
    assert empty["pct_days_fiber_density_target"] == 0.0, empty
    _ok("empty rollup carries prebiotic_g, avg_prebiotic_g, pct_days_fiber_density_target")


def test_gut_rollup_reports_fiber_density_target_days() -> None:
    """pct_days_fiber_density_target counts logged days at/above
    FIBER_TARGET_PER_1000 fiber per 1000 kcal, separate from the absolute
    fiber-gram target."""
    print("\n[test] gut rollup reports fiber-density target days")
    from datetime import date, timedelta
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import DailyNutritionMetrics, User  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.gut_health import compute_weekly_rollup, FIBER_TARGET_PER_1000

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    today = date.today()
    with Session(engine) as s:
        u = User(email="gut-density@example.com", username="gutdensity", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        # Day 1: high density (>= target). Day 2: low density (< target).
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today - timedelta(days=1),
            calories_total=2000,
            fiber_total_g=40,
            fiber_per_1000_kcal=FIBER_TARGET_PER_1000 + 6,
            item_count=4,
            processing_counts={},
        ))
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today,
            calories_total=2000,
            fiber_total_g=16,
            fiber_per_1000_kcal=FIBER_TARGET_PER_1000 - 6,
            item_count=4,
            processing_counts={},
        ))
        s.commit()
        rollup = compute_weekly_rollup(s, user_id=u.id, end_date=today, days=2)

    assert rollup["days_with_data"] == 2, rollup
    assert "pct_days_fiber_density_target" in rollup, rollup
    assert rollup["pct_days_fiber_density_target"] == 50.0, rollup
    _ok("fiber-density target reported as % of logged days above the per-1000 threshold")


def test_gut_probiotic_aggregation_scales_servings_without_inventing_cfus() -> None:
    """Probiotic servings scale by servings_consumed. CFUs are only counted
    when probiotic_cfu_billions_per_serving is explicitly present — the
    flag and the per-serving-servings fallbacks must never fabricate CFUs."""
    print("\n[test] probiotic aggregation scales servings and never fakes CFUs")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.enums import MealSource, MealType
    from app.models import (  # noqa: F401
        DailyNutritionMetrics, FoodMetadata, FoodNutrition, Meal, MealItem, User,
    )
    import app.models  # noqa: F401
    import app.services.nutrition.gut_health as gh

    today = date.today()
    FOOD_ID = 90001

    def _signals_for_meta(**meta_kwargs):
        # serving_grams (200) / reference_grams (100) => servings_consumed = 2.0
        engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        SQLModel.metadata.create_all(engine)
        original = gh.get_or_create_metadata
        gh.get_or_create_metadata = lambda *a, **k: FoodMetadata(
            normalized_name="kefir",
            processing_bucket="minimally_processed",
            confidence=0.9,
            source="curated",
            protein_source="unknown",
            likely_plant_foods=[],
            **meta_kwargs,
        )
        try:
            with Session(engine) as s:
                u = User(email="pb@example.com", username="pbuser", hashed_password="x")
                s.add(u); s.commit(); s.refresh(u)
                s.add(FoodNutrition(food_id=FOOD_ID, reference_grams=100, calories=60))
                m = Meal(
                    user_id=u.id,
                    meal_date=today,
                    meal_type=MealType.BREAKFAST,
                    name="Probiotic test",
                    source=MealSource.LOGGED,
                )
                s.add(m); s.commit(); s.refresh(m)
                s.add(MealItem(
                    meal_id=m.id,
                    food_name="kefir",
                    food_id=FOOD_ID,
                    quantity=1,
                    unit="serving",
                    serving_grams=200,
                    calories=150,
                    protein_g=8,
                    carbs_g=12,
                    fat_g=8,
                ))
                s.commit()
                return gh._gather_raw_signals(s, u.id, today, allow_ai=False)
        finally:
            gh.get_or_create_metadata = original

    # probiotic_flag fallback: servings scale by servings_consumed, no CFUs.
    flag_only = _signals_for_meta(probiotic_flag=True)
    assert flag_only.probiotic_servings == 2.0, flag_only
    assert flag_only.probiotic_cfu_billions == 0.0, flag_only

    # probiotic_servings_per_serving fallback: scales, still no CFUs.
    pb_per_serving = _signals_for_meta(probiotic_servings_per_serving=0.5)
    assert pb_per_serving.probiotic_servings == 1.0, pb_per_serving
    assert pb_per_serving.probiotic_cfu_billions == 0.0, pb_per_serving

    # Explicit CFU per serving: counted and scaled; servings tracked too.
    with_cfu = _signals_for_meta(probiotic_cfu_billions_per_serving=10.0)
    assert with_cfu.probiotic_cfu_billions == 20.0, with_cfu
    assert with_cfu.probiotic_servings == 2.0, with_cfu

    _ok("probiotic_flag/servings scale by servings_consumed; CFUs only from explicit per-serving value")


def test_compute_daily_metrics_recovers_from_duplicate_insert_race() -> None:
    """Two home-screen reads can race to create today's metrics row. The
    loser should rollback, fetch the winner, and return one clean row."""
    print("\n[test] daily metrics recovers from duplicate insert race")
    from datetime import date
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import DailyNutritionMetrics, User  # noqa: F401
    import app.models  # noqa: F401
    from app.services.nutrition.gut_health import compute_daily_metrics

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    today = date.today()

    class RacingSession:
        def __init__(self, inner: Session, user_id: int):
            self.inner = inner
            self.user_id = user_id
            self.raised = False

        def exec(self, *args, **kwargs):
            return self.inner.exec(*args, **kwargs)

        def add(self, *args, **kwargs):
            return self.inner.add(*args, **kwargs)

        def refresh(self, *args, **kwargs):
            return self.inner.refresh(*args, **kwargs)

        def rollback(self):
            return self.inner.rollback()

        def commit(self):
            if not self.raised:
                self.raised = True
                self.inner.rollback()
                with Session(engine) as other:
                    other.add(DailyNutritionMetrics(
                        user_id=self.user_id,
                        metric_date=today,
                        calories_total=123,
                    ))
                    other.commit()
                raise IntegrityError("insert", {}, Exception("duplicate"))
            return self.inner.commit()

    with Session(engine) as s:
        u = User(email="metrics-race@example.com", username="metricsrace", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        row = compute_daily_metrics(RacingSession(s, u.id), user_id=u.id, metric_date=today, allow_ai=False)
        rows = s.exec(
            select(DailyNutritionMetrics)
            .where(DailyNutritionMetrics.user_id == u.id)
            .where(DailyNutritionMetrics.metric_date == today)
        ).all()
        assert len(rows) == 1, rows
        assert row.id == rows[0].id, (row, rows)
        assert row.calories_total == 0, row.model_dump()
        assert row.item_count == 0, row.model_dump()
    _ok("duplicate insert loser rewrites and returns winner row")


def test_hydration_get_reads_requested_date() -> None:
    """Past-day hydration should be readable by explicit log_date, not
    hard-wired to today's row."""
    print("\n[test] hydration GET reads the requested date")
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import User  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.meals import HydrationLogBody, get_hydration, log_hydration

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="hydration-date@example.com", username="hydrationdate", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        log_hydration(
            HydrationLogBody(ounces=42, log_date="2026-04-27"),
            current_user=u,
            db=s,
        )
        today = get_hydration(log_date=None, current_user=u, db=s)
        past = get_hydration(log_date="2026-04-27", current_user=u, db=s)

        assert today["date"] != "2026-04-27", today
        assert today["ounces"] == 0, today
        assert past["date"] == "2026-04-27", past
        assert past["ounces"] == 42, past
    _ok("requested date returns its own hydration row")


def test_hydration_guidance_flags_low_sodium_long_session() -> None:
    """Sodium should produce guidance for long/sweaty sessions, not a hidden
    water-ounce bonus."""
    print("\n[test] hydration guidance flags low sodium on long sessions")
    from app.routers.meals import _build_hydration_guidance

    guidance = _build_hydration_guidance(
        workout_minutes_today=75,
        sodium_mg_today=900,
        supplement_flags={
            "electrolytes_in_stack": False,
            "electrolytes_logged": False,
            "creatine_in_stack": False,
            "creatine_logged": False,
            "caffeine_in_stack": False,
            "caffeine_logged": False,
        },
    )

    assert guidance["electrolytes"]["status"] == "consider", guidance
    assert "900 mg" in guidance["electrolytes"]["message"], guidance
    assert guidance["sodium_mg"] == 900, guidance
    _ok("long low-sodium session asks for electrolytes instead of more water")


def test_hydration_guidance_recognizes_logged_electrolytes_and_creatine() -> None:
    """Logged electrolytes cover the long-session sodium note. Creatine is a
    note only; it must not be treated as an automatic water-target bump."""
    print("\n[test] hydration guidance recognizes electrolytes and creatine")
    from app.routers.meals import _build_hydration_guidance, _compute_hydration_target_oz

    target_before, breakdown_before = _compute_hydration_target_oz(
        weight_lbs=180,
        gender=None,
        workout_minutes_today=75,
        protein_g_today=0,
        alcohol_servings_today=0,
    )
    target_after, breakdown_after = _compute_hydration_target_oz(
        weight_lbs=180,
        gender=None,
        workout_minutes_today=75,
        protein_g_today=0,
        alcohol_servings_today=0,
    )
    guidance = _build_hydration_guidance(
        workout_minutes_today=75,
        sodium_mg_today=900,
        supplement_flags={
            "electrolytes_in_stack": True,
            "electrolytes_logged": True,
            "creatine_in_stack": True,
            "creatine_logged": False,
            "caffeine_in_stack": False,
            "caffeine_logged": False,
        },
    )

    assert target_before == target_after, (target_before, target_after)
    assert breakdown_before == breakdown_after, (breakdown_before, breakdown_after)
    assert guidance["electrolytes"]["status"] == "covered", guidance
    assert any(note["key"] == "creatine" for note in guidance["notes"]), guidance
    _ok("electrolytes/creatine surface as guidance without changing ounces")


# ── Part 4: workout completion feedback patches ─────────────────────


def test_feedback_patch_preserves_exercise_based_fatigue_same_focus() -> None:
    """Post-workout feedback reuses /workouts/complete without exercises.
    That should patch the existing completion row without downgrading the
    per-exercise fatigue map back to a generic focus estimate."""
    print("\n[test] workout feedback patch preserves exercise-based fatigue")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import ActivityFeedItem, User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 1)
    with Session(engine) as s:
        u = User(email="workout-feedback@example.com", username="workoutfeedback", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Legs",
                duration_seconds=3600,
                exercises=[
                    CompletedExercisePayload(
                        name="Barbell Squat",
                        equipment="barbell",
                        order_index=0,
                        sets=[
                            CompletedSetPayload(set_number=1, reps=5, weight_lbs=225, rir=2),
                            CompletedSetPayload(set_number=2, reps=5, weight_lbs=225, rir=2),
                            CompletedSetPayload(set_number=3, reps=5, weight_lbs=225, rir=1),
                        ],
                    )
                ],
            ),
            current_user=u,
            db=s,
        )
        row = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).first()
        assert row is not None
        before = dict(row.resolved_muscle_fatigue or {})
        assert before.get("quads", 0) > 0, before
        feed_rows = s.exec(select(ActivityFeedItem).where(ActivityFeedItem.user_id == u.id)).all()
        workout_feed_rows = [r for r in feed_rows if r.event_type == "workout_completed"]
        assert len(workout_feed_rows) == 1, feed_rows
        assert workout_feed_rows[0].payload["exercises"][0]["sets"][0]["weight_lbs"] == 225.0

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Legs",
                duration_seconds=3600,
                feeling="rough",
                intensity=4,
                soreness_areas=["quads"],
            ),
            current_user=u,
            db=s,
        )
        rows = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(rows) == 1, rows
        s.refresh(rows[0])
        assert rows[0].resolved_muscle_fatigue == before, rows[0].resolved_muscle_fatigue
        assert rows[0].feeling == "rough", rows[0].feeling
        assert rows[0].intensity == 4, rows[0].intensity
        feed_rows = s.exec(select(ActivityFeedItem).where(ActivityFeedItem.user_id == u.id)).all()
        workout_feed_rows = [r for r in feed_rows if r.event_type == "workout_completed"]
        assert len(workout_feed_rows) == 1, feed_rows
    _ok("feedback updates row without replacing actual muscle fatigue")


def test_training_score_patch_persists_without_duplicate_completion() -> None:
    """Training-score patch reuses /workouts/complete after PR detection.
    It should update the existing completion row without creating another
    completion or another social feed event."""
    print("\n[test] workout training-score patch persists on completion")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import ActivityFeedItem, User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 2)
    with Session(engine) as s:
        u = User(email="workout-score@example.com", username="workoutscore", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Push",
                duration_seconds=3000,
                exercises=[
                    CompletedExercisePayload(
                        name="Barbell Bench Press",
                        equipment="barbell",
                        order_index=0,
                        sets=[
                            CompletedSetPayload(set_number=1, reps=5, weight_lbs=185, rir=2),
                            CompletedSetPayload(set_number=2, reps=5, weight_lbs=185, rir=1),
                        ],
                    )
                ],
            ),
            current_user=u,
            db=s,
        )
        row = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).first()
        assert row is not None
        before_fatigue = dict(row.resolved_muscle_fatigue or {})

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Push",
                duration_seconds=3000,
                training_score=88,
                training_rating="Crushed",
                training_pillars={"effort": 30, "volume": 25, "duration": 15, "consistency": 13},
                training_pillar_breakdown=[
                    {"key": "stimulus", "label": "Stimulus", "value": 30, "max": 30, "present": True}
                ],
            ),
            current_user=u,
            db=s,
        )

        rows = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(rows) == 1, rows
        s.refresh(rows[0])
        assert rows[0].training_score == 88
        assert rows[0].training_rating == "Crushed"
        assert rows[0].training_pillars["effort"] == 30
        assert rows[0].training_pillar_breakdown[0]["key"] == "stimulus"
        assert rows[0].resolved_muscle_fatigue == before_fatigue
        feed_rows = s.exec(select(ActivityFeedItem).where(ActivityFeedItem.user_id == u.id)).all()
        workout_feed_rows = [r for r in feed_rows if r.event_type == "workout_completed"]
        assert len(workout_feed_rows) == 1, feed_rows
    _ok("training score patches existing completion without duplicate history")


def test_feedback_patch_targets_focus_corrected_completion() -> None:
    """If the user starts from a stale focus label but logs different
    exercises, the backend may correct the completion focus from muscles.
    The later feedback patch still arrives with the original client focus,
    so it must find the corrected completion instead of creating a second
    generic row."""
    print("\n[test] workout feedback patch targets focus-corrected completion")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 1)
    with Session(engine) as s:
        u = User(email="workout-focus-patch@example.com", username="workoutfocuspatch", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Recovery",
                duration_seconds=3000,
                exercises=[
                    CompletedExercisePayload(
                        name="Barbell Squat",
                        equipment="barbell",
                        order_index=0,
                        sets=[
                            CompletedSetPayload(set_number=1, reps=8, weight_lbs=185, rir=2),
                            CompletedSetPayload(set_number=2, reps=8, weight_lbs=185, rir=2),
                        ],
                    )
                ],
            ),
            current_user=u,
            db=s,
        )
        row = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).first()
        assert row is not None
        assert row.focus_label == "Legs", row.focus_label
        before = dict(row.resolved_muscle_fatigue or {})
        assert before.get("quads", 0) > 0, before

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Recovery",
                duration_seconds=3000,
                feeling="good",
                intensity=3,
            ),
            current_user=u,
            db=s,
        )
        rows = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(rows) == 1, [(r.focus_label, r.resolved_muscle_fatigue) for r in rows]
        s.refresh(rows[0])
        assert rows[0].focus_label == "Legs", rows[0].focus_label
        assert rows[0].resolved_muscle_fatigue == before, rows[0].resolved_muscle_fatigue
        assert rows[0].feeling == "good", rows[0].feeling
    _ok("feedback patches corrected completion without duplicate generic row")


def test_planned_completion_keeps_plan_focus_after_partial_exercise_log() -> None:
    """A planned Upper day may only have one chest exercise logged when the
    user finishes early. The completion row must keep the planned focus so
    client history hydration can match it back to the real local session."""
    print("\n[test] planned completion keeps plan focus after partial exercise log")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="planned-partial@example.com", username="plannedpartial", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=date(2026, 5, 4),
                focus_label="Upper",
                duration_seconds=90,
                source_context="planned",
                exercises=[
                    CompletedExercisePayload(
                        name="Band Chest Press",
                        equipment="resistance_bands",
                        primary_muscle="chest",
                        secondary_muscles=["triceps", "shoulders"],
                        is_compound=True,
                        order_index=0,
                        sets=[
                            CompletedSetPayload(set_number=1, reps=99, weight_lbs=1, rir=4),
                        ],
                    )
                ],
            ),
            current_user=u,
            db=s,
        )
        row = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).first()
        assert row is not None
        assert row.focus_label == "Upper", row.focus_label
        fatigue = row.resolved_muscle_fatigue or {}
        assert fatigue.get("chest", 0) > 0, fatigue
    _ok("planned partial completion preserves scheduled focus key")


def test_custom_exercise_muscles_feed_completion_fatigue() -> None:
    """Exercises that are not in the seed library should still affect
    recovery/generation when the client sends their muscle metadata."""
    print("\n[test] custom exercise muscle metadata feeds completion fatigue")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        u = User(email="custom-ex-fatigue@example.com", username="customexfatigue", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=date(2026, 5, 1),
                focus_label="Custom",
                duration_seconds=2400,
                exercises=[
                    CompletedExercisePayload(
                        name="Garage Cable Row",
                        equipment="cable",
                        primary_muscle="back",
                        secondary_muscles=["biceps"],
                        is_compound=True,
                        order_index=0,
                        sets=[
                            CompletedSetPayload(set_number=1, reps=10, weight_lbs=90, rir=2),
                            CompletedSetPayload(set_number=2, reps=10, weight_lbs=90, rir=2),
                            CompletedSetPayload(set_number=3, reps=9, weight_lbs=90, rir=1),
                        ],
                    )
                ],
            ),
            current_user=u,
            db=s,
        )
        row = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).first()
        assert row is not None
        fatigue = row.resolved_muscle_fatigue or {}
        assert fatigue.get("back", 0) > 0, fatigue
        assert fatigue.get("biceps", 0) > 0, fatigue
        assert row.focus_label == "Pull", row.focus_label
    _ok("custom exercise metadata produces specific muscle fatigue")


def test_manual_activity_identity_preserves_same_focus_rows_and_time() -> None:
    """Manual/Apple-style completions should use the activity's real
    end time for fatigue decay and external ids for idempotent updates."""
    print("\n[test] manual activity identity preserves same-focus rows and end time")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete

    def _utc(dt):
        return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 4)
    first_start = datetime(2026, 5, 4, 7, 0, tzinfo=timezone.utc)
    first_end = datetime(2026, 5, 4, 7, 30, tzinfo=timezone.utc)
    second_start = datetime(2026, 5, 4, 18, 0, tzinfo=timezone.utc)
    second_end = datetime(2026, 5, 4, 18, 25, tzinfo=timezone.utc)
    with Session(engine) as s:
        u = User(email="manual-identity@example.com", username="manualidentity", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        for external_id, start, end, calories in (
            ("manual-run-1", first_start, first_end, 240),
            ("manual-run-2", second_start, second_end, 210),
        ):
            mark_workout_complete(
                WorkoutCompleteRequest(
                    workout_date=workout_date,
                    focus_label="Running",
                    duration_seconds=int((end - start).total_seconds()),
                    source_context="manual_activity",
                    activity_category="cardio",
                    activity_subtype="run",
                    activity_intensity="moderate",
                    activity_source="manual",
                    started_at=start,
                    ended_at=end,
                    external_source_id=external_id,
                    calories_burned=calories,
                ),
                current_user=u,
                db=s,
            )

        rows = s.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == u.id)
            .order_by(WorkoutCompletion.external_source_id)
        ).all()
        assert len(rows) == 2, rows
        assert rows[0].external_source_id == "manual-run-1", rows[0].external_source_id
        assert abs((_utc(rows[0].completed_at) - first_end).total_seconds()) < 1, rows[0].completed_at
        assert rows[1].external_source_id == "manual-run-2", rows[1].external_source_id
        assert abs((_utc(rows[1].completed_at) - second_end).total_seconds()) < 1, rows[1].completed_at

        updated_end = datetime(2026, 5, 4, 7, 35, tzinfo=timezone.utc)
        resp = mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Running",
                duration_seconds=2100,
                source_context="manual_activity",
                activity_category="cardio",
                activity_subtype="run",
                activity_intensity="moderate",
                activity_source="manual",
                started_at=first_start,
                ended_at=updated_end,
                external_source_id="manual-run-1",
                calories_burned=275,
            ),
            current_user=u,
            db=s,
        )
        rows = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(rows) == 2, rows
        updated = [r for r in rows if r.external_source_id == "manual-run-1"][0]
        assert updated.duration_seconds == 2100, updated.duration_seconds
        assert updated.calories_burned == 275, updated.calories_burned
        assert abs((_utc(updated.completed_at) - updated_end).total_seconds()) < 1, updated.completed_at
    _ok("same-focus manual rows stay distinct and decay from activity end")


def test_custom_cardio_identity_preserves_same_focus_rows() -> None:
    """Custom live-tracked cardio uses the same external-id identity rules
    as manual imports, so two same-day runs do not overwrite each other."""
    print("\n[test] custom cardio identity preserves same-focus rows")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 4)
    first_start = datetime(2026, 5, 4, 7, 0, tzinfo=timezone.utc)
    second_start = datetime(2026, 5, 4, 18, 0, tzinfo=timezone.utc)
    with Session(engine) as s:
        u = User(email="custom-cardio@example.com", username="customcardio", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        for external_id, start, miles in (
            ("custom-run-1", first_start, 3.1),
            ("custom-run-2", second_start, 2.4),
        ):
            mark_workout_complete(
                WorkoutCompleteRequest(
                    workout_date=workout_date,
                    focus_label="Run",
                    duration_seconds=1800,
                    source_context="custom_cardio",
                    activity_category="cardio",
                    activity_subtype="run",
                    activity_intensity="moderate",
                    activity_source="live_tracker",
                    distance_miles=miles,
                    started_at=start,
                    ended_at=start.replace(minute=start.minute + 30),
                    external_source_id=external_id,
                    calories_burned=250,
                ),
                current_user=u,
                db=s,
            )

        rows = s.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == u.id)
            .order_by(WorkoutCompletion.external_source_id)
        ).all()
        assert len(rows) == 2, rows
        assert rows[0].external_source_id == "custom-run-1", rows[0].external_source_id
        assert rows[0].distance_miles == 3.1, rows[0].distance_miles
        assert rows[1].external_source_id == "custom-run-2", rows[1].external_source_id
        assert rows[1].distance_miles == 2.4, rows[1].distance_miles
    _ok("same-focus custom cardio rows stay distinct")


def test_custom_strength_structured_history_preserves_same_focus_rows() -> None:
    """Custom strength sessions must preserve both completion identity and
    structured set rows so e1RM, PRs, weekly volume, and coach rollups see
    every custom workout instead of only the last same-focus session."""
    print("\n[test] custom strength structured history preserves same-focus rows")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion, WorkoutSession, WorkoutExercise, ExerciseSet  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        WorkoutSyncRequest,
        mark_workout_complete,
        sync_in_progress_workout,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 4)

    def _bench_request(external_id: str, hour: int, weight: float) -> WorkoutCompleteRequest:
        start = datetime(2026, 5, 4, hour, 0, tzinfo=timezone.utc)
        return WorkoutCompleteRequest(
            workout_date=workout_date,
            focus_label="Strength",
            duration_seconds=2700,
            source_context="custom_strength",
            activity_category="strength",
            activity_subtype="strength",
            activity_intensity="hard",
            activity_source="live_tracker",
            started_at=start,
            ended_at=start.replace(minute=45),
            external_source_id=external_id,
            exercises=[
                CompletedExercisePayload(
                    name="Bench Press",
                    slug="barbell_bench_press",
                    equipment="barbell",
                    primary_muscle="chest",
                    secondary_muscles=["triceps", "shoulders"],
                    is_compound=True,
                    order_index=0,
                    sets=[
                        CompletedSetPayload(
                            set_number=1,
                            reps=5,
                            weight_lbs=weight,
                            rir=2,
                        ),
                    ],
                ),
            ],
        )

    with Session(engine) as s:
        u = User(email="custom-strength@example.com", username="customstrength", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        first_request = _bench_request("custom-lift-1", 7, 185)
        sync_in_progress_workout(
            WorkoutSyncRequest(
                workout_date=first_request.workout_date,
                focus_label=first_request.focus_label,
                source_context=first_request.source_context,
                exercises=first_request.exercises or [],
            ),
            current_user=u,
            db=s,
        )
        mark_workout_complete(first_request, current_user=u, db=s)
        mark_workout_complete(_bench_request("custom-lift-2", 18, 135), current_user=u, db=s)

        completions = s.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == u.id)
            .order_by(WorkoutCompletion.external_source_id)
        ).all()
        sessions = s.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == u.id)
            .order_by(WorkoutSession.external_source_id)
        ).all()
        assert [c.external_source_id for c in completions] == ["custom-lift-1", "custom-lift-2"]
        assert [row.external_source_id for row in sessions] == ["custom-lift-1", "custom-lift-2"]

        exercise_rows = s.exec(
            select(WorkoutExercise)
            .where(WorkoutExercise.session_id.in_([row.id for row in sessions]))
        ).all()
        set_rows = s.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id.in_([row.id for row in exercise_rows]))
        ).all()
        assert len(set_rows) == 2, set_rows
        assert sorted(round(row.actual_weight_lbs or 0) for row in set_rows) == [135, 185]

        # Retry/update of the same external id replaces that session's sets
        # instead of creating a third structured session.
        mark_workout_complete(_bench_request("custom-lift-1", 7, 195), current_user=u, db=s)
        sessions = s.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == u.id)
            .order_by(WorkoutSession.external_source_id)
        ).all()
        assert len(sessions) == 2, sessions
        first_session = [row for row in sessions if row.external_source_id == "custom-lift-1"][0]
        first_exercises = s.exec(
            select(WorkoutExercise).where(WorkoutExercise.session_id == first_session.id)
        ).all()
        first_sets = s.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id.in_([row.id for row in first_exercises]))
        ).all()
        assert len(first_sets) == 1, first_sets
        assert round(first_sets[0].actual_weight_lbs or 0) == 195, first_sets[0].actual_weight_lbs
    _ok("same-focus custom strength rows preserve structured set history")


def test_warmup_sets_persist_without_counting_as_prs() -> None:
    """Warm-up sets are stored for history detail, but progression/PR logic
    should treat only working sets as performance signal."""
    print("\n[test] warm-up sets persist without counting as PRs")
    from datetime import date
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutSession, WorkoutExercise, ExerciseSet  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        CompletedExercisePayload,
        CompletedSetPayload,
        WorkoutCompleteRequest,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _request(day: date, external_id: str, warmup_weight: float | None = None) -> WorkoutCompleteRequest:
        sets = []
        if warmup_weight is not None:
            sets.append(CompletedSetPayload(
                set_number=-1,
                reps=3,
                weight_lbs=warmup_weight,
                set_type="warmup",
            ))
        sets.append(CompletedSetPayload(
            set_number=1,
            reps=5,
            weight_lbs=185,
            set_type="working",
        ))
        return WorkoutCompleteRequest(
            workout_date=day,
            focus_label="Push",
            duration_seconds=2400,
            source_context="planned",
            activity_category="strength",
            external_source_id=external_id,
            exercises=[
                CompletedExercisePayload(
                    name="Bench Press",
                    slug="barbell_bench_press",
                    equipment="barbell",
                    primary_muscle="chest",
                    secondary_muscles=["triceps", "shoulders"],
                    is_compound=True,
                    order_index=0,
                    sets=sets,
                )
            ],
        )

    with Session(engine) as s:
        u = User(email="warmups@example.com", username="warmups", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        mark_workout_complete(_request(date(2026, 5, 1), "warmup-pr-baseline"), current_user=u, db=s)
        second = mark_workout_complete(_request(date(2026, 5, 8), "warmup-pr-repeat", 315), current_user=u, db=s)

        assert second["prs"] == [], second["prs"]
        session = s.exec(
            select(WorkoutSession)
            .where(WorkoutSession.external_source_id == "warmup-pr-repeat")
        ).one()
        exercise = s.exec(
            select(WorkoutExercise)
            .where(WorkoutExercise.session_id == session.id)
        ).one()
        rows = s.exec(
            select(ExerciseSet)
            .where(ExerciseSet.workout_exercise_id == exercise.id)
            .order_by(ExerciseSet.set_number)
        ).all()
        assert [(row.set_number, row.set_type, row.actual_weight_lbs) for row in rows] == [
            (-1, "warmup", 315),
            (1, "working", 185),
        ]
    _ok("warm-up sets persist and stay out of PR detection")


def test_manual_activity_completion_estimates_missing_calories() -> None:
    """A manually logged run without wearable calories should still feed
    same-day nutrition and recovery through WorkoutCompletion.calories_burned."""
    print("\n[test] manual activity completion estimates missing calories")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, UserProfile, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import WorkoutCompleteRequest, mark_workout_complete

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 4)
    start = datetime(2026, 5, 4, 7, 0, tzinfo=timezone.utc)
    end = datetime(2026, 5, 4, 7, 45, tzinfo=timezone.utc)
    with Session(engine) as s:
        u = User(email="manual-estimate@example.com", username="manualestimate", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        s.add(UserProfile(
            user_id=u.id,
            weight_lbs=180,
            height_feet=5,
            height_inches=10,
            age=30,
            gender="male",
        ))
        s.commit()

        resp = mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Running",
                duration_seconds=int((end - start).total_seconds()),
                source_context="manual_activity",
                activity_category="cardio",
                activity_subtype="run",
                activity_intensity="moderate",
                activity_source="manual",
                cardio_style="steady",
                started_at=start,
                ended_at=end,
                external_source_id="manual-run-estimate",
            ),
            current_user=u,
            db=s,
        )

        row = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).first()
        assert row is not None
        assert row.calories_burned is not None
        assert 450 <= row.calories_burned <= 650, row.calories_burned
        assert resp["calories_burned"] == row.calories_burned
    _ok(f"manual run stored estimated {row.calories_burned} kcal")


def test_delete_completion_by_external_source_id_keeps_same_day_rows() -> None:
    """Deleting one local/HK row should not wipe every completion for the day."""
    print("\n[test] delete completion by external source id keeps same-day rows")
    from datetime import date, datetime, timezone
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine, select
    from app.models import User, WorkoutCompletion  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        WorkoutCompleteRequest,
        delete_workout_completion,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 4)
    with Session(engine) as s:
        u = User(email="manual-delete@example.com", username="manualdelete", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)

        for idx in (1, 2):
            start = datetime(2026, 5, 4, 7 + idx, 0, tzinfo=timezone.utc)
            mark_workout_complete(
                WorkoutCompleteRequest(
                    workout_date=workout_date,
                    focus_label="Running",
                    duration_seconds=1200,
                    source_context="manual_activity",
                    activity_category="cardio",
                    activity_subtype="run",
                    activity_intensity="moderate",
                    started_at=start,
                    ended_at=start.replace(minute=20),
                    external_source_id=f"manual-run-{idx}",
                ),
                current_user=u,
                db=s,
            )

        delete_workout_completion(
            workout_date=workout_date,
            external_source_id="manual-run-1",
            current_user=u,
            db=s,
        )
        rows = s.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == u.id)).all()
        assert len(rows) == 1, rows
        assert rows[0].external_source_id == "manual-run-2", rows[0].external_source_id
    _ok("exact completion delete leaves sibling activity intact")


def test_custom_activity_does_not_complete_active_plan_day() -> None:
    """A custom ride on a planned lift day should remain extra activity."""
    print("\n[test] custom activity does not complete active plan day")
    from datetime import date, timedelta
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, Session, create_engine
    from app.models import User, PlanWeek, PlanDay  # noqa: F401
    import app.models  # noqa: F401
    from app.routers.workouts import (
        WorkoutCompleteRequest,
        get_workout_status,
        mark_workout_complete,
    )

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    workout_date = date(2026, 5, 4)
    with Session(engine) as s:
        u = User(email="extra-ride@example.com", username="extraride", hashed_password="x")
        s.add(u); s.commit(); s.refresh(u)
        week = PlanWeek(
            user_id=u.id,
            start_date=workout_date,
            end_date=workout_date + timedelta(days=6),
            planner_version="test",
            goal="general_fitness",
            days_per_week=4,
            status="active",
        )
        s.add(week); s.commit(); s.refresh(week)
        day = PlanDay(
            plan_week_id=week.id,
            user_id=u.id,
            day_date=workout_date,
            day_index=0,
            status="planned",
            is_rest=False,
            workout_json={"focus": "Push + Core", "exercises": [{"name": "Bench Press"}]},
        )
        s.add(day); s.commit(); s.refresh(day)

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Ride",
                duration_seconds=1800,
                source_context="custom_cardio",
                activity_category="cardio",
                activity_subtype="ride",
                activity_intensity="moderate",
                activity_source="live_tracker",
                distance_miles=6.2,
                external_source_id="custom-ride-1",
            ),
            current_user=u,
            db=s,
        )
        s.refresh(day)
        assert day.status == "planned", day.status
        assert get_workout_status(workout_date=workout_date, current_user=u, db=s)["done"] is False

        mark_workout_complete(
            WorkoutCompleteRequest(
                workout_date=workout_date,
                focus_label="Push + Core",
                duration_seconds=3600,
                source_context="planned",
                plan_day_id=day.id,
                external_source_id="planned-push-1",
            ),
            current_user=u,
            db=s,
        )
        s.refresh(day)
        assert day.status == "completed", day.status
        assert get_workout_status(workout_date=workout_date, current_user=u, db=s)["done"] is True
    _ok("custom activity stays extra while planned completion closes PlanDay")


# ── Runner ──────────────────────────────────────────────────────────

cases = [
    test_prev_focuses_normalize_to_buckets_and_families,
    test_prev_focuses_flow_changes_recipe_day0,
    test_build_nutrition_context_handles_missing_db,
    test_build_nutrition_context_calls_meal_history_with_db,
    test_format_for_prompt_includes_meal_history_lines,
    test_log_meal_from_plan_persists_consumed_at,
    test_log_meal_from_plan_replaces_edited_meal_items,
    test_plan_check_extra_snack_slots_do_not_replace_each_other,
    test_plan_check_does_not_overwrite_manual_logged_same_name,
    test_unlog_meal_from_plan_removes_checked_row_from_rollups,
    test_unlog_meal_clears_day_state_without_removing_plan_meal,
    test_delete_logged_meal_clears_user_day_state_copy,
    test_delete_logged_meal_uses_stable_client_key_without_shifting_checks,
    test_log_meal_from_plan_collapses_existing_generated_duplicates,
    test_manual_add_same_meal_twice_creates_two_history_rows,
    test_rolling_averages_ignore_duplicate_generated_plan_rows,
    test_rolling_averages_preserve_distinct_generic_meals,
    test_meal_history_limits_after_deduping_generated_rows,
    test_meal_history_window_matches_rolling_average_window,
    test_saved_meal_log_retry_is_idempotent,
    test_create_saved_meal_from_logged_history_links_source_meal,
    test_saved_meal_rename_keeps_logged_rows_snapshotted,
    test_saved_meal_delete_detaches_logged_meals,
    test_patch_saved_meal_log_detaches_and_replaces_items,
    test_logged_ai_food_micros_are_persisted_for_gut_metrics,
    test_patch_meal_items_refreshes_history_averages_and_gut_metrics,
    test_score_micros_read_unsuffixed_aliases_and_calorie_fallback,
    test_meal_history_rehydrates_food_nutrition_micros,
    test_gut_rollup_uses_logged_days_not_empty_metric_placeholders,
    test_gut_rollup_serving_averages_include_omega3_supplements,
    test_gut_empty_rollup_exposes_prebiotic_and_fiber_density_fields,
    test_gut_rollup_reports_fiber_density_target_days,
    test_gut_probiotic_aggregation_scales_servings_without_inventing_cfus,
    test_compute_daily_metrics_recovers_from_duplicate_insert_race,
    test_hydration_get_reads_requested_date,
    test_hydration_guidance_flags_low_sodium_long_session,
    test_hydration_guidance_recognizes_logged_electrolytes_and_creatine,
    test_feedback_patch_preserves_exercise_based_fatigue_same_focus,
    test_training_score_patch_persists_without_duplicate_completion,
    test_feedback_patch_targets_focus_corrected_completion,
    test_planned_completion_keeps_plan_focus_after_partial_exercise_log,
    test_custom_exercise_muscles_feed_completion_fatigue,
    test_manual_activity_identity_preserves_same_focus_rows_and_time,
    test_custom_cardio_identity_preserves_same_focus_rows,
    test_custom_strength_structured_history_preserves_same_focus_rows,
    test_warmup_sets_persist_without_counting_as_prs,
    test_manual_activity_completion_estimates_missing_calories,
    test_delete_completion_by_external_source_id_keeps_same_day_rows,
    test_custom_activity_does_not_complete_active_plan_day,
]


if __name__ == "__main__":
    import traceback
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            traceback.print_exc()
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    if failures:
        raise SystemExit(1)
    print(f"\n  All {len(cases)} tests passed.")
