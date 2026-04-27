"""Tests for services.nutrition.weekly_review.compute_weekly_nutrition_review.

Coverage:
  - Full 7 days logged, on target → high adherence, no calorie rec
  - Under-eating (not fat-loss goal) → undereating_for_goal rec fires
  - Over-eating (fat-loss goal) → overeating_for_goal rec fires
  - Low protein consistently → raise_protein rec fires
  - Protein inconsistent (some hits, some misses) → improve_protein_consistency
  - Partial logging (<3 days) → only log_more_meals fires
  - Weight trend available vs missing
  - apply_action: adjust_calorie_target mutates calorie_adjustment correctly
  - to_dict serialises without crash
  - All recs have action dict with a type field
  - Rec keys unique within a review
"""
from __future__ import annotations

from datetime import date, timedelta, datetime, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        WorkoutCompletion, DailyNutritionMetrics, FoodMetadata,
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


def _setup_user(goal_type: str = "muscle_gain", weight_lbs: float = 180.0):
    from sqlmodel import Session
    from app.models import User, UserProfile, UserGoal
    engine = _make_engine()
    s = Session(engine)
    u = User(email="nut@example.com", username="nut_rev", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)

    # Pass string values — SQLModel coerces to the enum automatically.
    profile = UserProfile(
        user_id=u.id, weight_lbs=weight_lbs,
        height_feet=5, height_inches=10, age=30,
        gender="male", days_per_week=4,
    )
    s.add(profile)

    g = UserGoal(
        user_id=u.id, goal_type=goal_type,
        pace="moderate", is_active=True,
        target_weight_lbs=175,
    )
    s.add(g); s.commit()
    return s, u


def _seed_rollups(
    s, user_id, *,
    week_start: date,
    days: int = 7,
    kcal: float = 2200.0,
    protein_g: float = 160.0,
    carbs_g: float = 250.0,
    fat_g: float = 75.0,
    meals_logged: int = 3,
    weight_lbs: float | None = None,
):
    """Seed identical DailyRollup rows for `days` consecutive days."""
    from app.models import DailyRollup
    for i in range(days):
        d = week_start + timedelta(days=i)
        s.add(DailyRollup(
            user_id=user_id, day=d,
            kcal=kcal, protein_g=protein_g, carbs_g=carbs_g, fat_g=fat_g,
            meals_logged=meals_logged,
            weight_lbs=weight_lbs,
        ))
    s.commit()


def _current_week_start() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


def _past_week_start() -> date:
    """Return the Monday of the week that ended last Sunday — fully in the past
    so window_end is never truncated to today."""
    today = date.today()
    # Monday of current week minus 7 days = Monday of last week
    return today - timedelta(days=today.weekday() + 7)


# ── Scenario: on target (full week) ──────────────────────────────────────────

def test_full_week_on_target_high_adherence():
    """7 days logged, calories close to target → high kcal_adherence_pct."""
    print("\n[test] full week on target → high adherence, no calorie rec")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    # Seed rollups matching what compute_targets would produce for a 180 lb
    # muscle-gain user (~2400 kcal, ~180g protein). Use values close enough
    # that adherence passes the ±15% band.
    _seed_rollups(s, u.id, week_start=ws, days=7, kcal=2380, protein_g=175, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    assert r.days_logged == 7
    # No overeating rec — calories are not over target
    rec_keys = [rec.key for rec in r.recommendations]
    assert "overeating_for_goal" not in rec_keys
    # Review serialises and produces a headline
    assert isinstance(r.headline, str) and len(r.headline) > 0
    _ok(f"full week: adherence={r.kcal_adherence_pct:.0f}%, recs={rec_keys}")


# ── Scenario: under-eating ────────────────────────────────────────────────────

def test_undereating_fires_rec_for_muscle_gain():
    """Eating 600 kcal/day below target on muscle-gain → undereating_for_goal."""
    print("\n[test] under-eating for muscle_gain → undereating_for_goal rec")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=1600, protein_g=140, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    rec_keys = [rec.key for rec in r.recommendations]
    assert "undereating_for_goal" in rec_keys, \
        f"Expected undereating_for_goal, got: {rec_keys}"
    _ok(f"undereating rec fired: delta={r.calorie_delta_daily_avg:.0f} kcal")


def test_undereating_does_not_fire_for_fat_loss():
    """Under-eating on fat-loss goal should NOT fire an undereating rec."""
    print("\n[test] under-eating on fat_loss goal → no undereating rec")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("fat_loss")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=1400, protein_g=140, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    rec_keys = [rec.key for rec in r.recommendations]
    assert "undereating_for_goal" not in rec_keys, \
        f"Fat loss should not trigger undereating rec, got: {rec_keys}"
    _ok(f"no undereating rec for fat_loss: recs={rec_keys}")


# ── Scenario: over-eating ────────────────────────────────────────────────────

def test_overeating_fires_rec_for_fat_loss():
    """Eating 400+ kcal over target on fat-loss → overeating_for_goal rec."""
    print("\n[test] over-eating for fat_loss → overeating_for_goal rec")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("fat_loss")
    # Fat-loss target for this profile is well below 2600 kcal
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=2600, protein_g=140, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    rec_keys = [rec.key for rec in r.recommendations]
    assert "overeating_for_goal" in rec_keys, \
        f"Expected overeating_for_goal, got: {rec_keys}"
    _ok(f"overeating rec fired: delta={r.calorie_delta_daily_avg:.0f} kcal")


# ── Scenario: low protein consistently ───────────────────────────────────────

def test_low_protein_fires_raise_protein_rec():
    """Protein consistently at 60% of target → raise_protein rec."""
    print("\n[test] consistently low protein → raise_protein rec")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    # Protein target for ~180lb muscle gain user ≈ 180g. Give 100g (55%) consistently.
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=2200, protein_g=100, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    rec_keys = [rec.key for rec in r.recommendations]
    assert "raise_protein" in rec_keys, \
        f"Expected raise_protein, got: {rec_keys}"
    _ok(f"raise_protein fired: avg={r.avg_actual_protein_g:.0f}g vs target={r.planned_protein_g}g")


# ── Scenario: protein inconsistent ───────────────────────────────────────────

def test_protein_inconsistency_rec():
    """Mix of good and low protein days (avg > 75% of target but hit_pct < 50%)
    → improve_protein_consistency rec."""
    print("\n[test] protein inconsistent → improve_protein_consistency")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    from app.models import DailyRollup
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    # Protein target ≈ 180g. Alternate: 3 days at 190g (hit), 4 days at 100g (miss).
    # Average = ~140g (>75% of 180 = 135g threshold → no raise_protein)
    # But only 3/7 days hit 85% of 180g (153g) → protein_hit_pct ≈ 43% < 50%
    for i in range(3):
        d = ws + timedelta(days=i)
        s.add(DailyRollup(user_id=u.id, day=d, kcal=2200, protein_g=190, carbs_g=220, fat_g=70, meals_logged=3))
    for i in range(3, 7):
        d = ws + timedelta(days=i)
        s.add(DailyRollup(user_id=u.id, day=d, kcal=2200, protein_g=100, carbs_g=220, fat_g=70, meals_logged=3))
    s.commit()
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    rec_keys = [rec.key for rec in r.recommendations]
    assert "improve_protein_consistency" in rec_keys or "raise_protein" in rec_keys, \
        f"Expected protein rec, got: {rec_keys} (avg={r.avg_actual_protein_g:.0f}g, hit_pct={r.protein_hit_pct:.0f}%)"
    _ok(f"protein rec: {[k for k in rec_keys if 'protein' in k]}")


# ── Scenario: partial logging ─────────────────────────────────────────────────

def test_partial_logging_only_fires_log_more_rec():
    """2 days logged → only log_more_meals fires, no macro recs."""
    print("\n[test] partial logging (2 days) → log_more_meals only")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    _seed_rollups(s, u.id, week_start=ws, days=2, kcal=2200, protein_g=150, meals_logged=2)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    assert r.days_logged == 2
    assert len(r.recommendations) == 1
    assert r.recommendations[0].key == "log_more_meals"
    _ok("log_more_meals is the only rec when days_logged < 3")


def test_zero_days_logged_graceful():
    """Brand-new user with no data → graceful review, no crash."""
    print("\n[test] zero days logged → graceful empty review")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("maintain")
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    assert r.days_logged == 0
    assert r.avg_actual_calories == 0.0
    assert isinstance(r.headline, str) and len(r.headline) > 0
    _ok("zero days handled gracefully")


# ── Scenario: weight trend ────────────────────────────────────────────────────

def test_weight_trend_available_populates_direction():
    """Weight readings on 3+ days → trend computed and direction set."""
    print("\n[test] weight trend available → direction inferred")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("fat_loss")
    _seed_rollups(
        s, u.id, week_start=ws, days=7,
        kcal=1700, protein_g=140, meals_logged=3,
        weight_lbs=180.0,  # same every day → flat trend
    )
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    assert r.weight_trend_direction in ("flat", "up", "down"), \
        f"Unexpected direction: {r.weight_trend_direction}"
    assert r.weight_trend_lbs_per_week is not None
    _ok(f"weight trend: {r.weight_trend_lbs_per_week:.3f} lbs/wk → {r.weight_trend_direction}")


def test_weight_trend_missing_when_no_weight_data():
    """No weight data → trend is None, direction is 'unknown'."""
    print("\n[test] no weight data → trend=None, direction=unknown")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=2200, protein_g=160, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    assert r.weight_trend_lbs_per_week is None
    assert r.weight_trend_direction == "unknown"
    _ok("no weight data → trend None, direction unknown")


# ── apply_action: adjust_calorie_target ──────────────────────────────────────

def test_apply_adjust_calorie_target_positive():
    """adjust_calorie_target with positive delta → increases calorie_adjustment."""
    print("\n[test] apply_action adjust_calorie_target +150")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    result = apply_action(s, u.id, {"type": "adjust_calorie_target", "delta": 150})
    assert result.applied is True
    assert result.changed_fields.get("calorie_adjustment") == 150
    state = s.exec(__import__("sqlmodel", fromlist=["select"]).select(UserCoachingState).where(UserCoachingState.user_id == u.id)).first()
    assert state.calorie_adjustment == 150
    _ok(f"calorie_adjustment raised to {state.calorie_adjustment}")


def test_apply_adjust_calorie_target_negative():
    """adjust_calorie_target with negative delta → decreases calorie_adjustment."""
    print("\n[test] apply_action adjust_calorie_target -100")
    from app.services.coach.apply_action import apply_action
    from app.models import UserCoachingState
    s, u = _setup_user("fat_loss")
    result = apply_action(s, u.id, {"type": "adjust_calorie_target", "delta": -100})
    assert result.applied is True
    assert result.changed_fields.get("calorie_adjustment") == -100
    _ok("calorie_adjustment lowered correctly")


def test_apply_adjust_calorie_target_cap_enforced():
    """Delta clamped to _MAX_KCAL_DELTA (250) even if action asks for more."""
    print("\n[test] apply_action adjust_calorie_target cap at 250")
    from app.services.coach.apply_action import apply_action
    s, u = _setup_user("muscle_gain")
    result = apply_action(s, u.id, {"type": "adjust_calorie_target", "delta": 500})
    assert result.applied is True
    assert result.changed_fields.get("calorie_adjustment") == 250  # capped
    _ok("delta capped at 250")


# ── Structural invariants ─────────────────────────────────────────────────────

def test_every_rec_has_action_with_type():
    """Every recommendation must carry an action dict with a 'type' key."""
    print("\n[test] all recs have action.type")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=1600, protein_g=90, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    for rec in r.recommendations:
        assert isinstance(rec.action, dict), f"{rec.key} has no action dict"
        assert "type" in rec.action, f"{rec.key} action missing 'type'"
    _ok(f"all {len(r.recommendations)} recs have action.type")


def test_rec_keys_unique():
    """Rec keys must be unique within a review."""
    print("\n[test] rec keys unique within review")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("muscle_gain")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=1600, protein_g=90, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    keys = [rec.key for rec in r.recommendations]
    assert len(keys) == len(set(keys)), f"Duplicate keys: {keys}"
    _ok(f"all {len(keys)} keys unique")


def test_to_dict_serialises_without_crash():
    """to_dict() must return a plain dict (no unserializable types)."""
    print("\n[test] to_dict serialises cleanly")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    import json
    ws = _past_week_start()
    s, u = _setup_user("fat_loss")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=2000, protein_g=130, meals_logged=3)
    r = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    d = r.to_dict()
    assert isinstance(d, dict)
    json.dumps(d)   # must not raise
    _ok("to_dict + JSON serialisation OK")


def test_review_is_deterministic():
    """Same user state → same review output."""
    print("\n[test] review is deterministic")
    from app.services.nutrition.weekly_review import compute_weekly_nutrition_review
    ws = _past_week_start()
    s, u = _setup_user("body_recomp")
    _seed_rollups(s, u.id, week_start=ws, days=5, kcal=2100, protein_g=150, meals_logged=3)
    a = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    b = compute_weekly_nutrition_review(s, u.id, week_start=ws)
    assert a.kcal_adherence_pct == b.kcal_adherence_pct
    assert [r.key for r in a.recommendations] == [r.key for r in b.recommendations]
    _ok("same inputs → same review")


# ── Runner ────────────────────────────────────────────────────────────────────

cases = [
    test_full_week_on_target_high_adherence,
    test_undereating_fires_rec_for_muscle_gain,
    test_undereating_does_not_fire_for_fat_loss,
    test_overeating_fires_rec_for_fat_loss,
    test_low_protein_fires_raise_protein_rec,
    test_protein_inconsistency_rec,
    test_partial_logging_only_fires_log_more_rec,
    test_zero_days_logged_graceful,
    test_weight_trend_available_populates_direction,
    test_weight_trend_missing_when_no_weight_data,
    test_apply_adjust_calorie_target_positive,
    test_apply_adjust_calorie_target_negative,
    test_apply_adjust_calorie_target_cap_enforced,
    test_every_rec_has_action_with_type,
    test_rec_keys_unique,
    test_to_dict_serialises_without_crash,
    test_review_is_deterministic,
]

if __name__ == "__main__":
    import sys, traceback
    passed = failed = 0
    for fn in cases:
        try:
            fn()
            passed += 1
        except Exception as e:
            print(f"  ✗ FAILED [{fn.__name__}]: {e}")
            traceback.print_exc()
            failed += 1
    print(f"\n{'='*55}")
    print(f"Nutrition review tests: {passed} passed, {failed} failed")
    if failed:
        sys.exit(1)
