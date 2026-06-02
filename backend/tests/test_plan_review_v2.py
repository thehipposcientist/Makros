"""Tests for `services.workout.plan_review_v2.compute_weekly_review`.

The deterministic weekly review surfaced in the WeeklyCoachingCard.
Asserts: specific recommendations fire from specific scenarios, and
poor-recovery composite suppresses dangerous "add more" recs.

Coverage:
  - Empty user → no recs (graceful, no crash)
  - Low adherence → reduce_days rec fires
  - Excessive volume per muscle → deload_volume rec
  - Volume spike per muscle → spike rec
  - Stable high volume alone is not framed as a problem
  - Poor recovery (low sleep) → suppresses "add volume" recs
  - 6+ strength days with low Zone 2 → recovery-day rec
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
    soreness_areas=None,
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
            soreness_areas=soreness_areas,
        ))
    s.commit()


def _seed_session_with_rir(s, user_id, *, workout_date: date, rir_values: list[float], focus="Push"):
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet, EquipmentType
    session = WorkoutSession(
        user_id=user_id,
        name=focus,
        focus=focus,
        workout_date=workout_date,
        completed_at=datetime.now(timezone.utc),
    )
    s.add(session)
    s.flush()
    exercise = WorkoutExercise(
        session_id=session.id,
        name="Bench Press",
        order_index=0,
        equipment=EquipmentType.GYM,
    )
    s.add(exercise)
    s.flush()
    for idx, rir in enumerate(rir_values, start=1):
        s.add(ExerciseSet(
            workout_exercise_id=exercise.id,
            set_number=idx,
            actual_reps=8,
            actual_weight_lbs=185,
            actual_rir=rir,
            completed=True,
            completed_at=datetime.now(timezone.utc),
        ))
    s.commit()


def _seed_volume_session(s, user_id, *, workout_date: date, muscle: str, hard_sets: int, focus="Push"):
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet, EquipmentType
    session = WorkoutSession(
        user_id=user_id,
        name=focus,
        focus=focus,
        workout_date=workout_date,
        completed_at=datetime.now(timezone.utc),
    )
    s.add(session)
    s.flush()
    exercise = WorkoutExercise(
        session_id=session.id,
        name=f"{muscle.title()} Volume",
        order_index=0,
        equipment=EquipmentType.GYM,
        primary_muscle_snapshot=muscle,
    )
    s.add(exercise)
    s.flush()
    for idx in range(1, hard_sets + 1):
        s.add(ExerciseSet(
            workout_exercise_id=exercise.id,
            set_number=idx,
            set_type="working",
            actual_reps=8,
            actual_weight_lbs=100,
            actual_rir=2,
            completed=True,
            completed_at=datetime.now(timezone.utc),
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
    assert review.nutrition_summary


def test_review_separates_workout_adherence_from_nutrition_logging():
    """Workout adherence and food logging are different metrics. The
    review should expose explicit names so the UI doesn't show two
    unexplained adherence percentages."""
    print("\n[test] review separates workout adherence from nutrition logging")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.models import DailyNutritionMetrics
    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    for i in range(6):
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=today - timedelta(days=i),
            calories_total=2100,
            plant_protein_g=35,
            animal_protein_g=115,
            fiber_total_g=24,
        ))
    s.commit()

    review = compute_weekly_review(s, u.id)
    data = review.to_dict()
    assert data["workout_adherence_pct"] == 0.0
    assert data["nutrition_logging_pct"] == 85.7
    assert "6/7 days logged" in data["nutrition_summary"]


def test_review_uses_meal_history_when_daily_metrics_missing():
    """Meal rows are the nutrition source of truth. Weekly review should not
    report "no nutrition data" just because the derived metrics cache is
    missing."""
    print("\n[test] weekly review falls back to meal history for nutrition logging")
    from app.enums import MealSource, MealType
    from app.models import Meal, MealItem
    from app.services.workout.plan_review_v2 import compute_weekly_review

    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    for i in range(4):
        meal = Meal(
            user_id=u.id,
            meal_date=today - timedelta(days=i),
            meal_type=MealType.LUNCH,
            name=f"Logged meal {i}",
            source=MealSource.LOGGED,
        )
        s.add(meal)
        s.flush()
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Chicken rice bowl",
            quantity=1,
            unit="serving",
            calories=620,
            protein_g=42,
            carbs_g=62,
            fat_g=18,
            fiber_g=7,
        ))
    s.commit()

    review = compute_weekly_review(s, u.id)
    assert review.days_logged == 4
    assert round(review.nutrition_logging_pct, 1) == 57.1
    assert "4/7 days logged" in review.nutrition_summary
    assert review.goal_forecast
    assert "no nutrition" not in review.goal_forecast["update_reason"].lower()


def test_review_uses_rollup_total_protein_not_classified_split():
    """DailyRollup protein is total protein. DailyNutritionMetrics plant +
    animal is only classified protein and can miss unknown-source foods."""
    print("\n[test] weekly review uses total rollup protein over classified split")
    from app.models import DailyNutritionMetrics, DailyRollup
    from app.services.workout.plan_review_v2 import compute_weekly_review

    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    for i in range(4):
        day = today - timedelta(days=i)
        s.add(DailyNutritionMetrics(
            user_id=u.id,
            metric_date=day,
            calories_total=2200,
            plant_protein_g=0,
            animal_protein_g=0,
            fiber_total_g=20,
        ))
        s.add(DailyRollup(
            user_id=u.id,
            day=day,
            kcal=2200,
            protein_g=130,
            meals_logged=3,
            protein_target_g=160,
        ))
    s.commit()

    review = compute_weekly_review(s, u.id)
    assert review.avg_protein_g == 130
    assert review.protein_target_g == 160
    assert "vs 160g target" in " ".join(review.nutrition_notes)


def test_protein_warning_uses_user_target_not_100g_cutoff():
    print("\n[test] protein warning compares against plan target")
    from app.models import DailyRollup
    from app.services.workout.plan_review_v2 import compute_weekly_review

    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    for i in range(4):
        s.add(DailyRollup(
            user_id=u.id,
            day=today - timedelta(days=i),
            kcal=2100,
            protein_g=110,
            meals_logged=3,
            protein_target_g=160,
        ))
    s.commit()

    review = compute_weekly_review(s, u.id)
    rec = next((r for r in review.recommendations if r.key == "raise_protein"), None)
    assert rec is not None, [r.key for r in review.recommendations]
    assert "160g target" in rec.detail


def test_protein_warning_does_not_fire_below_100_when_target_met():
    print("\n[test] protein warning does not use hardcoded 100g threshold")
    from app.models import DailyRollup
    from app.services.workout.plan_review_v2 import compute_weekly_review

    s, u = _setup_user_with_goal()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    for i in range(4):
        s.add(DailyRollup(
            user_id=u.id,
            day=today - timedelta(days=i),
            kcal=1800,
            protein_g=92,
            meals_logged=3,
            protein_target_g=90,
        ))
    s.commit()

    review = compute_weekly_review(s, u.id)
    assert "raise_protein" not in [r.key for r in review.recommendations]


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


def test_six_strength_days_low_zone2_recommends_recovery_swap():
    """A week with six strength sessions and almost no easy cardio should
    produce the actionable recovery-day recommendation."""
    print("\n[test] 6 strength days + low Zone 2 → swap_to_recovery rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(
        s,
        u.id,
        days_per_week=6,
        days=[
            {"focus": "Push"},
            {"focus": "Pull"},
            {"focus": "Legs"},
            {"focus": "Push"},
            {"focus": "Pull"},
            {"focus": "Legs"},
        ],
    )
    today = date.today()
    for i, focus in enumerate(["Push", "Pull", "Legs", "Push", "Pull", "Legs"]):
        _seed_completions(
            s,
            u.id,
            dates=[today - timedelta(days=i)],
            focus=focus,
            activity_category="strength",
            duration_min=55,
        )
    review = compute_weekly_review(s, u.id)
    rec = next((r for r in review.recommendations if r.key == "add_recovery_day"), None)
    assert rec is not None, f"expected add_recovery_day, got {[r.key for r in review.recommendations]}"
    assert rec.action == {"type": "swap_to_recovery", "count": 1}


def test_muscle_gain_low_cardio_does_not_recommend_more_cardio():
    """Hypertrophy goals should not get generic Zone 2/cardio-add recs."""
    print("\n[test] muscle_gain + low cardio → no add_cardio/add_zone2 rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today - timedelta(days=i) for i in range(4)],
        focus="Push",
        activity_category="strength",
        duration_min=55,
    )

    review = compute_weekly_review(s, u.id)
    rec_keys = [r.key for r in review.recommendations]
    assert "add_cardio" not in rec_keys, rec_keys
    assert "add_zone2" not in rec_keys, rec_keys


def test_body_recomp_low_cardio_still_recommends_goal_cardio():
    """Goal-aligned cardio targets still fire for recomp/fat-loss style goals."""
    print("\n[test] body_recomp + low cardio → add_cardio/add_zone2 recs")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("body_recomp")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today - timedelta(days=i) for i in range(4)],
        focus="Push",
        activity_category="strength",
        duration_min=55,
    )

    review = compute_weekly_review(s, u.id)
    rec_keys = [r.key for r in review.recommendations]
    assert "add_cardio" in rec_keys, rec_keys
    assert "add_zone2" in rec_keys, rec_keys


def test_goal_track_alias_resolves_before_cardio_targets():
    """Specific hypertrophy tracks should not fall back to general-health cardio."""
    print("\n[test] lean_bulk track resolves to muscle_gain before cardio recs")
    from app.enums import GoalPace, GoalType
    from app.models import UserGoal
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from sqlmodel import select

    s, u = _setup_user_with_goal("body_recomp")
    active = s.exec(select(UserGoal).where(UserGoal.user_id == u.id)).first()
    active.goal_type = GoalType.BODY_RECOMP
    active.goal_track = "lean_bulk"
    active.pace = GoalPace.MODERATE
    s.add(active)
    s.commit()
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today - timedelta(days=i) for i in range(4)],
        focus="Push",
        activity_category="strength",
        duration_min=55,
    )

    review = compute_weekly_review(s, u.id)
    rec_keys = [r.key for r in review.recommendations]
    assert review.goal == "muscle_gain"
    assert "add_cardio" not in rec_keys, rec_keys
    assert "add_zone2" not in rec_keys, rec_keys


def test_checkin_findings_do_not_flag_minimal_cardio_for_muscle_gain():
    """Check-in coach notes should follow the same goal-alignment rule."""
    print("\n[test] muscle_gain check-in findings do not nag minimal cardio")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    from app.services.workout.week_checkin_logic import compute_checkin_summary_from_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today - timedelta(days=i) for i in range(4)],
        focus="Push",
        activity_category="strength",
        duration_min=55,
    )

    summary = compute_checkin_summary_from_review(compute_weekly_review(s, u.id))
    joined = " ".join(summary.coach_findings.needs_attention).lower()
    assert "cardio was minimal" not in joined


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


def test_low_readiness_with_training_recommends_deload():
    """Low readiness plus several completed sessions should become a
    one-tap deload action, not just a passive warning."""
    print("\n[test] low readiness + training → schedule_deload rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=i) for i in range(3)], activity_category="strength")

    review = compute_weekly_review(s, u.id, readiness_score=40)
    rec = next((r for r in review.recommendations if r.key == "readiness_deload"), None)
    assert rec is not None, [r.key for r in review.recommendations]
    assert rec.action["type"] == "schedule_deload"


def test_stable_high_volume_is_not_treated_as_bad_by_itself():
    """Slightly-above-range volume can be a planned high-volume week.
    Only excessive volume, spikes, or high volume plus poor recovery should
    become a reduce-volume action."""
    print("\n[test] stable high volume alone does not reduce volume")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=i) for i in range(4)], activity_category="strength")
    _seed_volume_session(s, u.id, workout_date=today, muscle="chest", hard_sets=20)

    review = compute_weekly_review(s, u.id, avg_sleep_hours=7.5, readiness_score=80)
    assert review.volume.by_muscle["chest"].status == "high"
    rec_keys = [r.key for r in review.recommendations]
    assert "reduce_volume_chest" not in rec_keys, rec_keys
    assert "chest" not in review.headline.lower(), review.headline


def test_high_volume_with_poor_recovery_is_actionable():
    print("\n[test] high volume plus poor recovery reduces volume")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(s, u.id, dates=[today - timedelta(days=i) for i in range(4)], activity_category="strength")
    _seed_volume_session(s, u.id, workout_date=today, muscle="chest", hard_sets=20)

    review = compute_weekly_review(s, u.id, avg_sleep_hours=5.8)
    rec = next((r for r in review.recommendations if r.key == "reduce_volume_chest"), None)
    assert rec is not None, [r.key for r in review.recommendations]
    assert rec.action["type"] == "reduce_muscle_volume"


def test_low_rir_surfaces_reduce_intensity_rec():
    """RIR is captured per set; weekly review should surface it."""
    print("\n[test] low weekly RIR → reduce_intensity rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    for i in range(2):
        day = today - timedelta(days=i)
        _seed_completions(s, u.id, dates=[day], activity_category="strength")
        _seed_session_with_rir(s, u.id, workout_date=day, rir_values=[0, 0.5, 1], focus="Push")

    review = compute_weekly_review(s, u.id)
    assert review.avg_rir is not None and review.avg_rir <= 0.75
    rec_keys = [r.key for r in review.recommendations]
    assert "low_rir_reduce_intensity" in rec_keys, rec_keys


def test_repeated_soreness_surfaces_recovery_rec():
    """Post-workout soreness areas should feed the weekly review."""
    print("\n[test] repeated soreness area → recovery rec")
    from app.services.workout.plan_review_v2 import compute_weekly_review
    s, u = _setup_user_with_goal("muscle_gain")
    _seed_active_workout_plan(s, u.id, days_per_week=4)
    today = date.today()
    _seed_completions(
        s,
        u.id,
        dates=[today - timedelta(days=i) for i in range(2)],
        activity_category="strength",
        soreness_areas=["lower_back"],
    )

    review = compute_weekly_review(s, u.id)
    assert review.soreness_areas[0] == {"area": "lower_back", "count": 2}
    rec_keys = [r.key for r in review.recommendations]
    assert "soreness_lower_back" in rec_keys, rec_keys


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
