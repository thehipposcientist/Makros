"""Phase 1 perf bundle — unit tests for the three accepted items.

Covers:
  - #10  `_refresh_daily_metrics` debounce: burst calls within
         _REFRESH_DEBOUNCE_SECONDS coalesce to one recompute.
  - #11  `recompute_user` window batching: a 35-day backfill issues a
         small constant number of bulk queries instead of per-day round
         trips. Verified by query-counting the underlying engine.
  - #14  `compute_readiness` TTL cache: identical signatures within the
         TTL hit the cache; `invalidate_readiness_cache` drops entries.

These run against an in-memory SQLite the same way the rest of the
suite does (StaticPool, same_thread=False).
"""
from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import event
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import (
    DailyRollup, Meal, MealItem, User, UserGoal, UserProfile,
    WeeklyCheckIn, WorkoutSession,
)
from app.enums import GoalType, MealSource, MealType


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_basic_user(s: Session, *, user_id: int = 1) -> None:
    s.add(User(id=user_id, email=f"u{user_id}@t", username=f"u{user_id}", hashed_password="x"))
    s.add(UserProfile(
        user_id=user_id, age=30, height_feet=5, height_inches=10.0, weight_lbs=180.0,
        gender="male", days_per_week=4,
    ))
    s.add(UserGoal(
        user_id=user_id, goal_type=GoalType.MUSCLE_GAIN, pace="moderate",
        is_active=True,
    ))
    s.commit()


# ─── #10  _refresh_daily_metrics debounce ───────────────────────────────────

def test_refresh_daily_metrics_debounces_burst_saves():
    """Two refresh calls within _REFRESH_DEBOUNCE_SECONDS should collapse
    to a single underlying compute_daily_metrics call."""
    print("\n[test] meals: burst _refresh_daily_metrics calls coalesce")
    from app.routers import meals as meals_mod

    # Reset the per-process debounce dict so prior tests don't bleed.
    meals_mod._last_refresh_at.clear()

    calls: list[tuple[int, date]] = []

    def _fake_compute(db, *, user_id, metric_date, allow_ai):
        calls.append((user_id, metric_date))

    import app.services.nutrition.gut_health as gh
    real = gh.compute_daily_metrics
    gh.compute_daily_metrics = _fake_compute
    try:
        today = date.today()
        meals_mod._refresh_daily_metrics(db=None, user_id=42, meal_date=today)
        meals_mod._refresh_daily_metrics(db=None, user_id=42, meal_date=today)
        meals_mod._refresh_daily_metrics(db=None, user_id=42, meal_date=today)
    finally:
        gh.compute_daily_metrics = real

    assert len(calls) == 1, f"expected 1 compute, got {len(calls)} ({calls})"
    _ok("3 rapid refreshes for same (user, date) → 1 compute")


def test_refresh_daily_metrics_separate_users_not_debounced():
    """Debounce is per-(user, date), not global."""
    print("\n[test] meals: debounce isolates per user")
    from app.routers import meals as meals_mod
    meals_mod._last_refresh_at.clear()

    calls: list[tuple[int, date]] = []

    def _fake(db, *, user_id, metric_date, allow_ai):
        calls.append((user_id, metric_date))

    import app.services.nutrition.gut_health as gh
    real = gh.compute_daily_metrics
    gh.compute_daily_metrics = _fake
    try:
        today = date.today()
        meals_mod._refresh_daily_metrics(db=None, user_id=1, meal_date=today)
        meals_mod._refresh_daily_metrics(db=None, user_id=2, meal_date=today)
        meals_mod._refresh_daily_metrics(db=None, user_id=1, meal_date=today - timedelta(days=1))
    finally:
        gh.compute_daily_metrics = real

    assert len(calls) == 3, f"expected 3 distinct computes, got {len(calls)}"
    _ok("debounce keys correctly isolate (user, date)")


def test_refresh_daily_metrics_re_fires_after_window():
    """After _REFRESH_DEBOUNCE_SECONDS elapses, a refresh should run again."""
    print("\n[test] meals: refresh re-fires once debounce window expires")
    from app.routers import meals as meals_mod
    meals_mod._last_refresh_at.clear()

    calls: list[tuple[int, date]] = []

    def _fake(db, *, user_id, metric_date, allow_ai):
        calls.append((user_id, metric_date))

    import app.services.nutrition.gut_health as gh
    real = gh.compute_daily_metrics
    gh.compute_daily_metrics = _fake
    try:
        today = date.today()
        meals_mod._refresh_daily_metrics(db=None, user_id=7, meal_date=today)
        # Manually age the entry past the debounce window.
        meals_mod._last_refresh_at[(7, today)] = (
            time.time() - meals_mod._REFRESH_DEBOUNCE_SECONDS - 0.1
        )
        meals_mod._refresh_daily_metrics(db=None, user_id=7, meal_date=today)
    finally:
        gh.compute_daily_metrics = real

    assert len(calls) == 2, f"expected 2 computes after window expiry, got {len(calls)}"
    _ok("debounce re-fires after window expires")


# ─── #11  recompute_user query batching ─────────────────────────────────────

def test_recompute_user_batches_window_queries():
    """The 35-day backfill should issue a small constant number of
    queries (5 bulk fetches + 35 upsert flushes) instead of 5–7 per day.
    We assert the SELECT count stays under 15 — comfortable margin over
    the bulk path's actual count, but well below the per-day O(35×5+)
    pattern."""
    print("\n[test] rollups: recompute_user uses batched window load")
    from app.services.coach.rollups import recompute_user

    eng = _make_engine()
    with Session(eng) as s:
        _seed_basic_user(s, user_id=1)
        # Seed 7 days of meals, 3 sessions, 2 checkins so the loader has
        # actual data to coalesce. Counts don't need to be exhaustive —
        # the test is about query SHAPE, not aggregation correctness.
        today = date.today()
        for i in range(7):
            d = today - timedelta(days=i)
            m = Meal(
                user_id=1, meal_date=d, meal_type=MealType.LUNCH,
                name="Bowl", source=MealSource.LOGGED,
                consumed_at=datetime.now(timezone.utc),
            )
            s.add(m); s.flush()
            s.add(MealItem(
                meal_id=m.id, food_name="Chicken", quantity=1, unit="serving",
                calories=400, protein_g=40, carbs_g=10, fat_g=10,
            ))
        for i in (0, 2, 5):
            s.add(WorkoutSession(
                user_id=1, workout_date=today - timedelta(days=i),
                focus="upper", name="Upper",
                created_at=datetime.now(timezone.utc),
            ))
        for i in (0, 4):
            s.add(WeeklyCheckIn(
                user_id=1, checkin_date=today - timedelta(days=i),
                weight_lbs=180.0, sleep=4, energy=3, hunger=3,
            ))
        s.commit()

        select_count = 0

        @event.listens_for(eng, "before_cursor_execute")
        def _count_selects(conn, cursor, statement, params, context, executemany):
            nonlocal select_count
            if statement.lstrip().lower().startswith("select"):
                select_count += 1

        recompute_user(s, user_id=1, lookback_days=35)

    assert select_count <= 15, (
        f"recompute_user issued {select_count} SELECTs — expected ≤ 15. "
        f"Window batching is likely broken; check _preload_window."
    )
    _ok(f"recompute_user (lookback=35) ran in {select_count} SELECTs")


def test_recompute_user_writes_rollups():
    """Sanity: the batched path still writes the same rollup rows the
    per-day path used to produce."""
    print("\n[test] rollups: batched recompute_user writes daily + window rollups")
    from app.services.coach.rollups import recompute_user

    eng = _make_engine()
    with Session(eng) as s:
        _seed_basic_user(s, user_id=2)
        today = date.today()
        m = Meal(
            user_id=2, meal_date=today, meal_type=MealType.LUNCH,
            name="X", source=MealSource.LOGGED,
            consumed_at=datetime.now(timezone.utc),
        )
        s.add(m); s.flush()
        s.add(MealItem(
            meal_id=m.id, food_name="X", quantity=1, unit="serving",
            calories=500, protein_g=40, carbs_g=20, fat_g=15,
        ))
        s.commit()

        result = recompute_user(s, user_id=2, lookback_days=7)
        assert result["daily_rollups_written"] == 7, result
        # At least one daily row should reflect today's meal.
        today_row = s.exec(
            select(DailyRollup)
            .where(DailyRollup.user_id == 2, DailyRollup.day == today)
        ).first()
        assert today_row is not None
        assert today_row.kcal == 500, f"expected kcal=500, got {today_row.kcal}"
        assert today_row.meals_logged == 1
    _ok("batched recompute writes daily rollups with correct totals")


# ─── #14  readiness TTL cache ───────────────────────────────────────────────

def test_readiness_cache_hits_within_ttl():
    """Two identical-signature compute calls within the TTL should
    return the same object — proves the second call short-circuited."""
    print("\n[test] readiness: identical signatures within TTL hit the cache")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_basic_user(s, user_id=11)
        invalidate_readiness_cache(11)

        a = compute_readiness(
            s, 11,
            avg_sleep_hours=7.5, avg_resting_hr=58, avg_hrv_ms=72,
            last_night_sleep_score=85, nutrition_adherence_pct=80,
        )
        b = compute_readiness(
            s, 11,
            avg_sleep_hours=7.5, avg_resting_hr=58, avg_hrv_ms=72,
            last_night_sleep_score=85, nutrition_adherence_pct=80,
        )
    assert a is b, "expected cache hit (same object), got fresh compute"
    _ok("identical-signature calls within TTL return cached result")


def test_readiness_cache_separate_signatures_miss():
    """Different signal values → different cache key → fresh compute."""
    print("\n[test] readiness: different signatures bypass each other's cache entry")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_basic_user(s, user_id=12)
        invalidate_readiness_cache(12)

        a = compute_readiness(s, 12, avg_sleep_hours=7.5)
        b = compute_readiness(s, 12, avg_sleep_hours=6.0)
    assert a is not b, "different signatures should produce distinct results"
    _ok("distinct signatures produce distinct cached entries")


def test_readiness_invalidate_drops_user_entry():
    """invalidate_readiness_cache(user_id) clears that user's entries."""
    print("\n[test] readiness: invalidate_readiness_cache(user_id) drops cache")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_basic_user(s, user_id=13)
        invalidate_readiness_cache(13)

        a = compute_readiness(s, 13, avg_sleep_hours=7.0)
        invalidate_readiness_cache(13)
        b = compute_readiness(s, 13, avg_sleep_hours=7.0)
    assert a is not b, "expected fresh compute after invalidation, got cached object"
    _ok("invalidate drops cached entry; next call recomputes")


def test_readiness_use_cache_false_bypasses():
    """use_cache=False forces a recompute even if a cached entry exists."""
    print("\n[test] readiness: use_cache=False bypasses cache")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_basic_user(s, user_id=14)
        invalidate_readiness_cache(14)

        a = compute_readiness(s, 14, avg_sleep_hours=7.0)
        b = compute_readiness(s, 14, avg_sleep_hours=7.0, use_cache=False)
    assert a is not b, "use_cache=False should force a fresh compute"
    _ok("use_cache=False forces recompute")


cases = [
    test_refresh_daily_metrics_debounces_burst_saves,
    test_refresh_daily_metrics_separate_users_not_debounced,
    test_refresh_daily_metrics_re_fires_after_window,
    test_recompute_user_batches_window_queries,
    test_recompute_user_writes_rollups,
    test_readiness_cache_hits_within_ttl,
    test_readiness_cache_separate_signatures_miss,
    test_readiness_invalidate_drops_user_entry,
    test_readiness_use_cache_false_bypasses,
]


if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
