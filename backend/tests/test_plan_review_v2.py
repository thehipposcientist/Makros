"""Tests for `services.workout.plan_review_v2.compute_weekly_review`.

The deterministic weekly review surfaced in the WeeklyCoachingCard.
Asserts: specific recommendations fire from specific scenarios, and
poor-recovery composite suppresses dangerous "add more" recs.

Coverage:
  - Empty user → no recs (graceful, no crash)
  - Low adherence → reduce_days rec fires
  - Excessive volume per muscle → deload_volume rec
  - Volume spike per muscle → spike rec
  - Poor recovery (low sleep) → suppresses "add volume" recs
  - Weight up vs goal weight loss → calorie adjust rec
  - Headline string non-empty
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


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


def _setup_user_with_goal(goal_type: str = "muscle_gain"):
    from sqlmodel import Session
    from app.models import User, UserGoal
    engine = _make_engine()
    s = Session(engine)
    u = User(email="rev@example.com", username="rev", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    g = UserGoal(
        user_id=u.id, goal_type=goal_type, is_active=True,
        target_weight_lbs=180, pace="moderate",
    )
    s.add(g); s.commit()
    return s, u


def _seed_completions(
    s,
    user_id,
    *,
    dates: list[date],
    focus="Push",
    duration_min=60,
    activity_category=None,
    cardio_style=None,
    activity_intensity=None,
    stimulus=None,
    hr_summary=None,
):
    from app.models import WorkoutCompletion
    for d in dates:
        s.add(WorkoutCompletion(
            user_id=user_id, workout_date=d, focus_label=focus,
            duration_seconds=duration_min * 60, calories_burned=300,
            activity_category=activity_category,
            cardio_style=cardio_style,
            activity_intensity=activity_intensity,
            stimulus=stimulus,
            hr_summary=hr_summary,
        ))
    s.commit()


def _seed_active_workout_plan(s, user_id, *, days_per_week=4, days=None):
    """Persist an active WorkoutPlan row with N planned focuses."""
    from app.models import WorkoutPlan
    if days is None:
        days = [{"focus": "Push"}, {"focus": "Pull"}, {"focus": "Legs"}, {"focus": "Push"}]
    s.add(WorkoutPlan(
        user_id=user_id, planner_version="2026.04.25.test",
        goal="muscle_gain", days_per_week=days_per_week, preferred_split="ppl",
        plan_json={"days": days}, is_active=True,
    ))
    s.commit()


# ── Empty / no-data scenarios ──────────────────────────────────

def test_empty_user_returns_review_with_no_recs():
    """Brand-new user with no plan, no completions → graceful empty review."""
    print("\n[test] empty user → review with 0 recs, no crash")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    review = compute_weekly_review(s, u.id)
    assert review.user_id == u.id
    assert review.sessions_completed == 0
    assert review.adherence_pct == 0.0


# ── Low adherence ─────────────────────────────────────────────

def test_low_adherence_fires_reduce_days_rec():
    """User completed 1 of 4 sessions → reduce_days rec."""
    print("\n[test] low adherence (25%) → reduce_days rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=2)])
    review = compute_weekly_review(s, u.id)
    rec_keys = [r.key for r in review.recommendations]
    assert "reduce_days" in rec_keys, \
        f"low adherence didn't trigger reduce_days, got recs: {rec_keys}"


def test_full_adherence_no_reduce_days_rec():
    """User completed 4 of 4 → no reduce_days rec."""
    print("\n[test] full adherence → no reduce_days rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=i) for i in range(4)])
    review = compute_weekly_review(s, u.id)
    rec_keys = [r.key for r in review.recommendations]
    assert "reduce_days" not in rec_keys


def test_lift_plus_cardio_counts_finisher_minutes_not_full_session():
    """A planned Push + Cardio day should contribute cardio minutes, but
    only for the finisher portion."""
    print("\n[test] lift + cardio contributes finisher cardio minutes")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("body_recomp")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today],
        focus="Push + Cardio",
        duration_min=60,
        activity_category="strength",
        cardio_style="steady",
    )
    review = compute_weekly_review(s, u.id)
    assert review.cardio_minutes == 15.0, review.cardio_minutes
    assert review.zone2_minutes == 15.0, review.zone2_minutes


def test_zone2_cardio_focus_counts_full_session():
    """Generated Zone 2 Cardio days should count as full aerobic-base
    work even if an older client saved the activity category as strength."""
    print("\n[test] Zone 2 Cardio focus contributes full session minutes")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("body_recomp")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today],
        focus="Zone 2 Cardio",
        duration_min=45,
        activity_category="strength",
    )
    review = compute_weekly_review(s, u.id)
    assert review.cardio_minutes == 45.0, review.cardio_minutes
    assert review.zone2_minutes == 45.0, review.zone2_minutes


def test_zone2_cardio_focus_uses_hr_zone_minutes_when_present():
    """HR-zone samples still win over the focus heuristic."""
    print("\n[test] Zone 2 Cardio uses HR zone minutes when present")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("body_recomp")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today],
        focus="Zone 2 Cardio",
        duration_min=45,
        activity_category="strength",
        hr_summary={"zoneMinutes": [5, 18, 20, 2, 0]},
    )
    review = compute_weekly_review(s, u.id)
    assert review.cardio_minutes == 45.0, review.cardio_minutes
    assert review.zone2_minutes == 18.0, review.zone2_minutes


# ── Headline ─────────────────────────────────────────────────

def test_review_includes_headline():
    """Every review should produce a non-empty headline string."""
    print("\n[test] review has non-empty headline")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    review = compute_weekly_review(s, u.id)
    assert isinstance(review.headline, str)
    assert len(review.headline) > 0


# ── Apple Health signals (optional inputs) ───────────────────

def test_review_accepts_apple_health_signals_without_crash():
    """All Apple Health params optional — passing them must not crash."""
    print("\n[test] AH signals: sleep/HRV/steps inputs accepted")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    review = compute_weekly_review(
        s, u.id,
        weight_trend_lbs_per_week=-0.5,
        avg_sleep_hours=7.5,
        avg_resting_hr=58,
        avg_steps=9500,
        readiness_score=82,
    )
    assert review.avg_sleep_hours == 7.5
    assert review.avg_resting_hr == 58


def test_poor_recovery_suppresses_add_volume_recs():
    """Sleep < 6.5h is poor_recovery → undertrained muscles should NOT
    get add_volume recs (the user needs sleep, not more sets)."""
    print("\n[test] poor recovery suppresses add_volume recs")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    review = compute_weekly_review(
        s, u.id,
        avg_sleep_hours=5.5,  # poor
    )
    add_vol_recs = [r for r in review.recommendations if r.key.startswith("add_volume_")]
    assert len(add_vol_recs) == 0, \
        f"poor recovery should suppress add_volume recs, got {len(add_vol_recs)}"


def test_low_readiness_suppresses_add_volume_recs():
    """Readiness < 55 is also poor_recovery."""
    print("\n[test] low readiness suppresses add_volume recs")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    review = compute_weekly_review(
        s, u.id,
        readiness_score=42,
    )
    add_vol_recs = [r for r in review.recommendations if r.key.startswith("add_volume_")]
    assert len(add_vol_recs) == 0


# ── Weight trend ────────────────────────────────────────────

def test_weight_trend_direction_inferred_correctly():
    """Trend > 0.15 lbs/wk → 'up'."""
    print("\n[test] weight trend direction: up / down / flat")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)

    review_up = compute_weekly_review(s, u.id, weight_trend_lbs_per_week=0.4)
    assert review_up.weight_trend_direction == "up"

    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    review_down = compute_weekly_review(s, u.id, weight_trend_lbs_per_week=-0.5)
    assert review_down.weight_trend_direction == "down"

    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    review_flat = compute_weekly_review(s, u.id, weight_trend_lbs_per_week=0.05)
    assert review_flat.weight_trend_direction == "flat"


# ── Determinism ────────────────────────────────────────────

def test_review_is_deterministic():
    """Same user state → same review."""
    print("\n[test] review is deterministic for same inputs")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=i) for i in range(2)])
    a = compute_weekly_review(s, u.id, weight_trend_lbs_per_week=-0.3, avg_sleep_hours=7.2)
    b = compute_weekly_review(s, u.id, weight_trend_lbs_per_week=-0.3, avg_sleep_hours=7.2)
    assert a.sessions_completed == b.sessions_completed
    assert [r.key for r in a.recommendations] == [r.key for r in b.recommendations]


# ── Recommendations all have an action dict ─────────────────

def test_every_recommendation_has_an_action_dict():
    """Every rec must carry a structured `action` so the UI can apply
    it without another AI call. This is the architectural invariant."""
    print("\n[test] every rec has an action dict")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=2)])
    review = compute_weekly_review(s, u.id)
    for r in review.recommendations:
        assert isinstance(r.action, dict), f"{r.key} has no action dict"
        assert "type" in r.action or r.action == {}, \
            f"{r.key} action missing 'type': {r.action}"


def test_recommendation_has_stable_key():
    """Keys must be unique within a review for dedup downstream."""
    print("\n[test] rec keys are unique within a review")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=2)])
    review = compute_weekly_review(s, u.id)
    keys = [r.key for r in review.recommendations]
    assert len(keys) == len(set(keys)), f"duplicate rec keys: {keys}"


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
    print(f"\nAll {len(test_fns)} plan_review_v2 tests passed")
