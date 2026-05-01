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


# ── Runner ──────────────────────────────────────────────────────────

cases = [
    test_prev_focuses_normalize_to_buckets_and_families,
    test_prev_focuses_flow_changes_recipe_day0,
    test_build_nutrition_context_handles_missing_db,
    test_build_nutrition_context_calls_meal_history_with_db,
    test_format_for_prompt_includes_meal_history_lines,
    test_log_meal_from_plan_persists_consumed_at,
    test_log_meal_from_plan_replaces_edited_meal_items,
    test_log_meal_from_plan_collapses_existing_generated_duplicates,
    test_rolling_averages_ignore_duplicate_generated_plan_rows,
    test_rolling_averages_preserve_distinct_generic_meals,
    test_hydration_get_reads_requested_date,
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
