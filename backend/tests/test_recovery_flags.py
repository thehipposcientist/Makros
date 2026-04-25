"""Tests for `services.nutrition.recovery_flags`.

The flag-based "Fueling & Recovery Signals" surface — tri-state
(green/amber/red/not_enough_data). A miscalibration here either
silently ignores under-fueling (real safety risk) or false-alarms
a healthy user.

Coverage:
  - `_metabolic_support_flag` (pure function on rows)
    - 0 concerns → green
    - 1 concern → green with mild detail
    - 2 concerns → amber
    - 3+ concerns → red
    - <5 days of data → not_enough_data
  - `compute_energy_availability` (DB-backed)
    - returns None when profile missing
    - returns proper avg + days_with_data
  - `compute_flags` end-to-end with seeded data
    - all 4 flags returned in order
    - thyroid_opt_in=True adds 5th flag
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Meal, MealItem, ExerciseSet,
        WorkoutSession, WorkoutExercise, WorkoutCompletion,
        DailyNutritionMetrics, FoodMetadata, FoodNutrition, Food,
        FoodAlias, FoodServing, UserRecentFood,
        Exercise, ExerciseEquipment, Equipment, GoalOption, PaceOption,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _row(*, cals: float, added_sugar_g: float = 0, sat_fat_g: float = 0,
          fiber_g: float = 30):
    """Stub a DailyNutritionMetrics-shaped object for the pure function."""
    return SimpleNamespace(
        calories_total=cals,
        added_sugar_g=added_sugar_g,
        saturated_fat_g=sat_fat_g,
        fiber_total_g=fiber_g,
    )


# ── _metabolic_support_flag (pure) ───────────────────────────────

def test_metabolic_support_clean_diet_is_green():
    """Low sugar, low sat fat, high fiber, stable calories → green."""
    print("\n[test] metabolic_support: clean diet → green")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    rows = [_row(cals=2500, added_sugar_g=20, sat_fat_g=15, fiber_g=35) for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "green", f"expected green, got {flag.state}: {flag.detail}"


def test_metabolic_support_high_added_sugar_alone_is_green_or_one_concern():
    """One concern (high added sugar) → green with mild detail (per implementation)."""
    print("\n[test] metabolic_support: only sugar high → green")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    # Added sugar > 10% cals: 80g * 4 / 2500 = 12.8% → triggers high-sugar
    rows = [_row(cals=2500, added_sugar_g=80, sat_fat_g=15, fiber_g=35) for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "green"
    assert "added sugar" in (flag.detail or "").lower()


def test_metabolic_support_two_concerns_is_amber():
    """High sugar AND high saturated fat → amber."""
    print("\n[test] metabolic_support: 2 concerns → amber")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    # Sugar 13% cals + sat fat 13% cals.
    # 80g sugar * 4 / 2500 = 12.8% (>10)
    # 36g sat * 9 / 2500 = 13% (>10)
    rows = [_row(cals=2500, added_sugar_g=80, sat_fat_g=36, fiber_g=35) for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "amber", f"expected amber, got {flag.state}"


def test_metabolic_support_three_concerns_is_red():
    """High sugar + high sat fat + low fiber density → red."""
    print("\n[test] metabolic_support: 3 concerns → red")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    # Sugar 12.8%, sat fat 13%, fiber density 5g/1000kcal (<8 → low)
    rows = [_row(cals=2500, added_sugar_g=80, sat_fat_g=36, fiber_g=12) for _ in range(7)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "red", f"expected red, got {flag.state}"
    detail = (flag.detail or "").lower()
    assert "added sugar" in detail
    assert "saturated fat" in detail
    assert "fiber" in detail


def test_metabolic_support_under_five_days_is_not_enough_data():
    print("\n[test] metabolic_support: <5 days → not_enough_data")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    rows = [_row(cals=2500) for _ in range(3)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "not_enough_data"


def test_metabolic_support_zero_calorie_rows_skipped():
    """Days with calories_total=0 (placeholder rows) shouldn't count."""
    print("\n[test] metabolic_support: zero-cal rows ignored")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    rows = [_row(cals=0) for _ in range(10)]
    flag = _metabolic_support_flag(rows=rows)
    assert flag.state == "not_enough_data"


def test_metabolic_support_calorie_swings_count_as_concern():
    """High calorie variability (CV>0.30) is its own concern. To get
    amber/red we also need a sustained issue (≥5 days). Pair the swings
    with sustained low fiber on every day so we have 2 concerns total
    (CV + fiber)."""
    print("\n[test] metabolic_support: erratic calories + low fiber → amber")
    from app.services.nutrition.recovery_flags import _metabolic_support_flag
    # All 7 days have low fiber density (8g / 1500-3500 cals, < 8/1000kcal).
    # Calorie pattern is erratic enough that CV > 0.30.
    cal_pattern = [1500, 3500, 1500, 3500, 1500, 3500, 1500]
    rows = [_row(cals=c, fiber_g=8) for c in cal_pattern]
    flag = _metabolic_support_flag(rows=rows)
    # 2 concerns (CV + fiber) → amber.
    assert flag.state == "amber", \
        f"erratic calories + sustained low fiber should be amber, got {flag.state}"


# ── compute_energy_availability (DB-backed) ──────────────────────

def test_compute_energy_availability_returns_none_when_no_profile():
    """No UserProfile → can't compute FFM → returns None safely."""
    print("\n[test] compute_energy_availability: no profile → None")
    from sqlmodel import Session
    from app.models import User
    from app.services.nutrition.recovery_flags import compute_energy_availability
    engine = _make_engine()
    s = Session(engine)
    u = User(email="ea@example.com", username="ea", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    res = compute_energy_availability(s, u.id, end_date=date.today())
    assert res is None


def test_compute_energy_availability_with_seeded_data():
    """Profile + 7 days of intake rows → returns avg EA."""
    print("\n[test] compute_energy_availability: 7d seeded → avg EA")
    from sqlmodel import Session
    from app.models import User, UserProfile, DailyNutritionMetrics
    from app.services.nutrition.recovery_flags import compute_energy_availability
    engine = _make_engine()
    s = Session(engine)
    u = User(email="ea@example.com", username="ea", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    # 180 lb male → ~82 kg, 18% bf → ~67 kg FFM
    s.add(UserProfile(
        user_id=u.id, weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
    ))
    end = date.today()
    for i in range(7):
        d = end - timedelta(days=i)
        s.add(DailyNutritionMetrics(
            user_id=u.id, metric_date=d, calories_total=2500.0,
            fiber_total_g=30.0, plant_protein_g=20.0, animal_protein_g=80.0,
        ))
    s.commit()
    res = compute_energy_availability(s, u.id, end_date=end)
    assert res is not None
    assert res["days_with_data"] == 7
    # ~2500 / 67 ≈ 37 kcal/kg FFM
    assert 30 < res["avg_ea_kcal_per_kg_ffm"] < 45


# ── compute_flags end-to-end ─────────────────────────────────────

def test_compute_flags_returns_four_flags_default():
    """Default flags: under_fueling, low_fat, recovery_nutrients, metabolic_support."""
    print("\n[test] compute_flags: returns 4 ordered flags")
    from sqlmodel import Session
    from app.models import User, UserProfile
    from app.services.nutrition.recovery_flags import compute_flags
    engine = _make_engine()
    s = Session(engine)
    u = User(email="flags@example.com", username="flags", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    s.add(UserProfile(
        user_id=u.id, weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
    ))
    s.commit()
    flags = compute_flags(s, u.id)
    keys = [f.key for f in flags]
    assert keys == [
        "under_fueling", "low_fat", "recovery_nutrients", "metabolic_support",
    ], f"got {keys}"


def test_compute_flags_with_thyroid_opt_in_returns_five():
    print("\n[test] compute_flags: thyroid_opt_in=True adds 5th flag")
    from sqlmodel import Session
    from app.models import User, UserProfile
    from app.services.nutrition.recovery_flags import compute_flags
    engine = _make_engine()
    s = Session(engine)
    u = User(email="ty@example.com", username="ty", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    s.add(UserProfile(
        user_id=u.id, weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
    ))
    s.commit()
    flags = compute_flags(s, u.id, thyroid_opt_in=True)
    keys = [f.key for f in flags]
    assert "thyroid_support" in keys, f"thyroid flag missing: {keys}"


def test_compute_flags_no_data_user_gets_not_enough_data_states():
    """Brand-new user → all flags should be not_enough_data, never red."""
    print("\n[test] compute_flags: empty user → not_enough_data, never red")
    from sqlmodel import Session
    from app.models import User, UserProfile
    from app.services.nutrition.recovery_flags import compute_flags
    engine = _make_engine()
    s = Session(engine)
    u = User(email="x@x.com", username="x", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    s.add(UserProfile(
        user_id=u.id, weight_lbs=180, height_feet=5, height_inches=10,
        age=30, gender="male",
    ))
    s.commit()
    flags = compute_flags(s, u.id)
    states = {f.key: f.state for f in flags}
    # Every flag should be not_enough_data when user has 0 days of data.
    for key, state in states.items():
        assert state == "not_enough_data", \
            f"{key} should be not_enough_data with no logged days, got {state}"


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} recovery_flags tests passed")
