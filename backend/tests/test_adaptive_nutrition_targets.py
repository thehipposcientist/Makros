"""Adaptive nutrition target regression tests.

Covers the DB-aware layer around the pure calorie calculator:
  - accepted coach calorie deltas are included
  - recent Apple Health activity can move targets up/down within caps
  - recent Apple Health weight can replace stale profile weight
  - plan-day targets redistribute carbs/fat by actual workout day type
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.enums import Gender, GoalPace, GoalType, MealSource, MealType
from app.models import (
    DailyHealthSnapshot,
    Meal,
    MealItem,
    PlanDay,
    PlanWeek,
    User,
    UserCoachingState,
    UserDayState,
    UserGoal,
    UserPreferences,
    UserProfile,
    WeightEntry,
    WorkoutCompletion,
)


def _ok(label: str) -> None:
    print(f"  PASS {label}")


class _ActivityRow:
    """Lightweight stand-in for a WorkoutCompletion row for the pure
    activity-adjustment unit tests (no DB needed). Metadata fields default
    to None so a bare `_ActivityRow(kcal, seconds)` is an *untyped* row."""

    def __init__(
        self,
        calories_burned: int,
        duration_seconds: int,
        *,
        activity_category: str | None = None,
        cardio_style: str | None = None,
        activity_intensity: str | None = None,
        stimulus: str | None = None,
        plan_day_id: int | None = None,
        source_context: str | None = None,
    ):
        self.calories_burned = calories_burned
        self.duration_seconds = duration_seconds
        self.activity_category = activity_category
        self.cardio_style = cardio_style
        self.activity_intensity = activity_intensity
        self.stimulus = stimulus
        self.plan_day_id = plan_day_id
        self.source_context = source_context


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_user(
    s: Session,
    *,
    user_id: int = 1,
    weight_lbs: float = 180.0,
    days_per_week: int = 4,
) -> None:
    s.add(User(id=user_id, email=f"adaptive{user_id}@t", username=f"adaptive{user_id}", hashed_password="x"))
    s.add(UserProfile(
        user_id=user_id,
        weight_lbs=weight_lbs,
        height_feet=5,
        height_inches=10,
        age=30,
        gender=Gender.MALE,
    ))
    s.add(UserGoal(
        user_id=user_id,
        goal_type=GoalType.BODY_RECOMP,
        pace=GoalPace.MODERATE,
        is_active=True,
    ))
    s.add(UserPreferences(
        user_id=user_id,
        days_per_week=days_per_week,
        workout_duration_minutes=60,
        equipment=[],
        foods_available=[],
    ))
    s.commit()


def test_coaching_and_apple_health_activity_adjust_targets():
    print("\n[test] nutrition targets adapt to accepted coach delta + Apple Health movement")
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s)
        s.add(UserCoachingState(user_id=1, calorie_adjustment=100))
        for i in range(7):
            d = today - timedelta(days=i)
            s.add(DailyHealthSnapshot(
                user_id=1,
                snapshot_date=d,
                steps=12000,
                active_energy_kcal=900,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        s.commit()

        no_health = resolve_targets_for_user(s, 1, as_of=today, include_health=False)
        with_health = resolve_targets_for_user(s, 1, as_of=today, include_health=True)

    assert no_health is not None and with_health is not None
    assert no_health.coaching_adjustment_kcal == 100
    assert with_health.health_activity_adjustment_kcal > 0, with_health.health_signal
    assert with_health.calories > no_health.calories
    _ok(
        f"coach={with_health.coaching_adjustment_kcal:+d}, "
        f"health={with_health.health_activity_adjustment_kcal:+d}, "
        f"{no_health.calories}->{with_health.calories} kcal"
    )


def test_recent_apple_health_weight_replaces_profile_weight():
    print("\n[test] nutrition targets use recent Apple Health weight")
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s, weight_lbs=180)
        s.add(DailyHealthSnapshot(
            user_id=1,
            snapshot_date=today,
            weight_lbs=170,
            source="apple_health",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        ))
        s.commit()
        targets = resolve_targets_for_user(s, 1, as_of=today, include_health=False)

    assert targets is not None
    assert targets.source_weight_lbs == 170
    assert targets.source_weight_kind == "apple_health"
    assert targets.protein_g == 170
    _ok("recent HealthKit weight drives bodyweight-based protein")


def test_saved_custom_macros_drive_user_and_request_targets():
    print("\n[test] saved custom macros drive DB-aware target resolution")
    from app.routers.ai.models import PlanRequest
    from app.services.nutrition.targets import (
        resolve_targets_for_request,
        resolve_targets_for_user,
    )

    eng = _make_engine()
    today = date.today()
    custom = {
        "calories": 2100,
        "protein": 180,
        "carbs": 225,
        "fat": 53,
        "proteinPct": 34,
    }
    with Session(eng) as s:
        _seed_user(s)
        prefs = s.exec(select(UserPreferences).where(UserPreferences.user_id == 1)).first()
        assert prefs is not None
        prefs.custom_macros = custom
        s.add(prefs)
        s.commit()

        user_targets = resolve_targets_for_user(s, 1, as_of=today, include_health=False)
        req = PlanRequest(
            goal="body_recomp",
            goalDetails={"pace": "moderate"},
            physicalStats={
                "weightLbs": 180,
                "heightFeet": 5,
                "heightInches": 10,
                "age": 30,
                "gender": "male",
            },
            daysPerWeek=4,
            workoutDurationMinutes=60,
            equipment=[],
            foodsAvailable=[],
        )
        request_targets = resolve_targets_for_request(
            req, db=s, user_id=1, as_of=today, include_health=False,
        )

    assert user_targets is not None
    for targets in (user_targets, request_targets):
        assert targets.calories == custom["calories"], targets
        assert targets.protein_g == custom["protein"], targets
        assert targets.carbs_g == custom["carbs"], targets
        assert targets.fat_g == custom["fat"], targets
        assert targets.override_applied, targets
    _ok("saved custom macros apply to user and generation request targets")


def test_recent_apple_basal_energy_adjusts_formula_bmr():
    print("\n[test] nutrition targets can use recent Apple Health basal energy")
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s, weight_lbs=180)
        for i in range(1, 8):
            s.add(DailyHealthSnapshot(
                user_id=1,
                snapshot_date=today - timedelta(days=i),
                basal_energy_kcal=1950,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        s.commit()
        formula = resolve_targets_for_user(s, 1, as_of=today, include_health=False)
        with_basal = resolve_targets_for_user(s, 1, as_of=today, include_health=True)

    assert formula is not None and with_basal is not None
    assert with_basal.source_bmr_kind == "apple_health"
    assert with_basal.source_bmr_kcal == 1950
    assert with_basal.bmr == 1950
    assert with_basal.calories > formula.calories
    _ok(f"formula BMR={formula.bmr}, HealthKit basal={with_basal.bmr}, calories {formula.calories}->{with_basal.calories}")


def test_apple_total_energy_prevents_basal_multiplier_overshoot():
    print("\n[test] Apple basal + active energy blends into maintenance when enough data exists")
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s, weight_lbs=180, days_per_week=7)
        for i in range(1, 8):
            s.add(DailyHealthSnapshot(
                user_id=1,
                snapshot_date=today - timedelta(days=i),
                basal_energy_kcal=2065,
                active_energy_kcal=717,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        s.commit()
        formula = resolve_targets_for_user(s, 1, as_of=today, include_health=False)
        with_energy = resolve_targets_for_user(s, 1, as_of=today, include_health=True)

    assert formula is not None and with_energy is not None
    assert formula.calories > 3000
    assert with_energy.source_tdee_kind == "apple_health_blend"
    assert with_energy.source_tdee_kcal == 2782
    assert with_energy.apple_tdee_kcal == 2782
    assert with_energy.apple_valid_days == 7
    assert with_energy.maintenance_blend is not None
    assert with_energy.maintenance_blend["apple_weight"] == 0.4
    assert with_energy.tdee == 2958
    assert with_energy.calories == 2958
    assert with_energy.calories < formula.calories
    assert with_energy.health_activity_adjustment_kcal == 0
    assert with_energy.health_signal is not None
    assert with_energy.health_signal.expected_active_energy_kcal == 717
    _ok(f"formula={formula.calories} kcal, Apple blend target={with_energy.calories} kcal")


def test_apple_total_energy_blend_tiers_and_guardrail():
    print("\n[test] Apple total-energy blend ramps with valid days and stays guarded")
    from app.services.nutrition.targets import resolve_targets_for_user

    today = date.today()

    def _target_for_days(valid_days: int, *, basal: int = 2065, active: int = 717):
        eng = _make_engine()
        with Session(eng) as s:
            _seed_user(s, weight_lbs=180, days_per_week=7)
            for i in range(1, valid_days + 1):
                s.add(DailyHealthSnapshot(
                    user_id=1,
                    snapshot_date=today - timedelta(days=i),
                    basal_energy_kcal=basal,
                    active_energy_kcal=active,
                    source="apple_health",
                    created_at=datetime.now(timezone.utc),
                    updated_at=datetime.now(timezone.utc),
                ))
            s.commit()
            return (
                resolve_targets_for_user(s, 1, as_of=today, include_health=False),
                resolve_targets_for_user(s, 1, as_of=today, include_health=True),
            )

    formula_2, two_days = _target_for_days(2)
    formula_3, three_days = _target_for_days(3)
    formula_7, seven_days = _target_for_days(7)
    formula_14, fourteen_days = _target_for_days(14)
    _formula_huge, huge = _target_for_days(14, basal=2800, active=1800)

    assert formula_2 is not None and two_days is not None
    assert three_days is not None and seven_days is not None and fourteen_days is not None and huge is not None
    assert two_days.tdee == formula_2.tdee
    assert two_days.maintenance_blend is None
    assert three_days.maintenance_blend["apple_weight"] == 0.2
    assert seven_days.maintenance_blend["apple_weight"] == 0.4
    assert fourteen_days.maintenance_blend["apple_weight"] == 0.6
    assert abs(huge.health_energy_adjustment_kcal) <= 400
    _ok(
        f"2d={two_days.tdee}, 3d={three_days.tdee}, "
        f"7d={seven_days.tdee}, 14d={fourteen_days.tdee}, "
        f"huge_delta={huge.health_energy_adjustment_kcal:+d}"
    )


def test_recent_manual_weight_entry_drives_macro_targets():
    print("\n[test] nutrition targets use recent manual weight entry")
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s, weight_lbs=180)
        s.add(WeightEntry(
            user_id=1,
            entry_date=today,
            weight_lbs=172.5,
            source="manual",
        ))
        s.commit()
        targets = resolve_targets_for_user(s, 1, as_of=today, include_health=False)

    assert targets is not None
    assert targets.source_weight_lbs == 172.5
    assert targets.source_weight_kind == "manual"
    assert targets.protein_g == 172
    _ok("manual weight entry drives bodyweight-based macro targets")


def test_plan_day_targets_shift_with_day_type_without_mutating_template():
    print("\n[test] plan-day nutrition targets follow workout day type")
    from app.services.nutrition.day_targets import adapt_template_targets_for_day

    template = {
        "targets": {"calories": 2400, "protein": 180, "carbs": 250, "fat": 80},
        "meals": [{"meal": "Bowl", "calories": 800, "protein": 60, "carbs": 80, "fat": 25}],
    }
    heavy = adapt_template_targets_for_day(
        template,
        workout_payload={"archetype": "full_body_strength", "focus": "Full Body", "stimulus": "strength"},
        goal_bucket="muscle_gain",
    )
    rest = adapt_template_targets_for_day(
        template,
        workout_payload=None,
        goal_bucket="muscle_gain",
    )

    assert heavy is not None and rest is not None
    assert heavy["targets"]["carbs"] > template["targets"]["carbs"]
    assert rest["targets"]["carbs"] < template["targets"]["carbs"]
    assert template["targets"]["carbs"] == 250
    assert heavy["_adaptiveTargets"]["day_type"] == "heavy"
    assert rest["_adaptiveTargets"]["day_type"] == "rest"
    _ok(f"carbs rest={rest['targets']['carbs']} base=250 heavy={heavy['targets']['carbs']}")


def test_new_plan_week_retargets_stale_nutrition_templates():
    print("\n[test] new PlanWeek nutrition retargets stale active templates")
    from app.services.nutrition.targets import resolve_targets_for_user
    from app.services.workout.week_manager import create_plan_week, get_week_days

    eng = _make_engine()
    today = date(2026, 5, 18)  # Monday
    stale_template = {
        "targets": {"calories": 3400, "protein": 185, "carbs": 450, "fat": 95},
        "meals": [{
            "meal": "Old bulk day",
            "calories": 3400,
            "protein": 185,
            "carbs": 450,
            "fat": 95,
            "items": [{
                "name": "Bowl",
                "quantity": 1,
                "unit": "serving",
                "calories": 3400,
                "protein": 185,
                "carbs": 450,
                "fat": 95,
            }],
        }],
    }
    with Session(eng) as s:
        _seed_user(s)
        expected = resolve_targets_for_user(s, 1, as_of=today, include_health=False)
        assert expected is not None
        pw = create_plan_week(
            s,
            1,
            start_date=today,
            workout_days=[{"focus": "Upper", "activity_category": "strength", "stimulus": "strength"}],
            nutrition_templates=[stale_template],
            training_day_pattern=[0],
            goal="body_recomp",
            days_per_week=1,
            preferred_split=None,
            planner_version="test",
        )
        days = get_week_days(s, pw.id)

    first = days[0].nutrition_json
    assert first is not None
    assert abs(first["targets"]["calories"] - expected.calories) <= 10
    assert first["targets"]["calories"] != 3400
    assert first["_targetRetargeting"]["previous"]["calories"] == 3400
    assert first["meals"][0]["calories"] < 3400
    _ok(f"stale 3400 kcal template retargeted to {first['targets']['calories']} kcal")


def test_adjusted_daily_target_exposes_target_basis():
    print("\n[test] adjusted daily target explains base-layer target math")
    from app.routers.meals import adjusted_daily_target

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s)
        for i in range(1, 8):
            s.add(DailyHealthSnapshot(
                user_id=1,
                snapshot_date=today - timedelta(days=i),
                basal_energy_kcal=1950,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        s.commit()
        user = s.get(User, 1)
        payload = adjusted_daily_target(target_date=today, current_user=user, db=s)

    basis = payload["target_basis"]
    assert basis["source_bmr_kind"] == "apple_health"
    assert payload["health_basal_target_adjustment_kcal"] > 0
    assert basis["formula_daily_target"] < basis["resolved_daily_target"]
    _ok(
        f"formula={basis['formula_daily_target']} resolved={basis['resolved_daily_target']} "
        f"health_basis={payload['health_basal_target_adjustment_kcal']:+d}"
    )


def test_adjusted_daily_target_exposes_total_energy_basis():
    print("\n[test] adjusted daily target explains Apple total-energy maintenance")
    from app.routers.meals import adjusted_daily_target

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s, days_per_week=7)
        for i in range(1, 8):
            s.add(DailyHealthSnapshot(
                user_id=1,
                snapshot_date=today - timedelta(days=i),
                basal_energy_kcal=2065,
                active_energy_kcal=717,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        s.commit()
        user = s.get(User, 1)
        payload = adjusted_daily_target(target_date=today, current_user=user, db=s)

    basis = payload["target_basis"]
    assert basis["source_tdee_kind"] == "apple_health_blend"
    assert basis["source_tdee_kcal"] == 2782
    assert basis["apple_tdee_kcal"] == 2782
    assert basis["apple_valid_days"] == 7
    assert basis["maintenance_blend"]["apple_weight"] == 0.4
    assert payload["maintenance_calories"] == 2958
    assert abs(payload["adjusted_calories"] - 2958) <= 5
    assert payload["health_energy_adjustment_kcal"] < 0
    assert payload["health_basal_target_adjustment_kcal"] == 0
    assert basis["formula_daily_target"] > payload["adjusted_calories"]
    _ok(
        f"formula={basis['formula_daily_target']} Apple total={payload['maintenance_calories']} "
        f"target={payload['adjusted_calories']}"
    )


def test_same_day_activity_adjustment_is_partial_and_capped():
    print("\n[test] same-day activity calories partially adjust nutrition target")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    class Completion:
        def __init__(self, calories_burned: int, duration_seconds: int):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds

    moderate = compute_activity_target_adjustment(
        [Completion(420, 3600)],
        goal_bucket="body_recomp",
    )
    fat_loss_single = compute_activity_target_adjustment(
        [Completion(420, 3600)],
        goal_bucket="fat_loss",
    )

    assert moderate.exercise_kcal == 420
    # body_recomp standard cap = 250 → 35% of 420 = 147 rounds to 150 (well under cap).
    assert moderate.adjustment_kcal == 150
    assert moderate.is_heavy_training_day is False
    assert moderate.reason == "workout"
    # fat_loss standard cap = 175. Single 420 kcal session is not heavy
    # (count<2, kcal<700, duration<90 min) so the standard cap applies.
    assert fat_loss_single.adjustment_kcal == 150
    assert fat_loss_single.is_heavy_training_day is False
    _ok(f"body_recomp +{moderate.adjustment_kcal} kcal, fat_loss +{fat_loss_single.adjustment_kcal} kcal")


def test_planned_workout_spends_expected_training_allowance_before_refuel():
    print("\n[test] planned workouts do not stack calories unless they exceed expectation")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    class Completion:
        def __init__(
            self,
            calories_burned: int,
            duration_seconds: int,
            *,
            plan_day_id: int | None = None,
            source_context: str | None = None,
        ):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds
            self.plan_day_id = plan_day_id
            self.source_context = source_context
            self.activity_category = "strength"
            self.activity_intensity = None
            self.cardio_style = None
            self.stimulus = "strength"

    planned_normal = compute_activity_target_adjustment(
        [Completion(420, 3600, plan_day_id=123)],
        goal_bucket="body_recomp",
        planned_workout_kcal_allowance=500,
    )
    planned_context = compute_activity_target_adjustment(
        [Completion(420, 3600, source_context="planned")],
        goal_bucket="body_recomp",
        planned_workout_kcal_allowance=500,
    )
    planned_big = compute_activity_target_adjustment(
        [Completion(900, 5400, plan_day_id=123)],
        goal_bucket="body_recomp",
        planned_workout_kcal_allowance=500,
    )
    extra_same_burn = compute_activity_target_adjustment(
        [Completion(420, 3600)],
        goal_bucket="body_recomp",
        planned_workout_kcal_allowance=500,
    )

    assert planned_normal.exercise_kcal == 420
    assert planned_normal.adjustment_kcal == 0, planned_normal
    assert planned_normal.reason == "none", planned_normal
    assert planned_context.adjustment_kcal == 0, planned_context
    assert planned_big.adjustment_kcal == 150, planned_big
    assert extra_same_burn.adjustment_kcal == 150, extra_same_burn
    _ok(
        f"planned normal=+{planned_normal.adjustment_kcal}, "
        f"planned excess=+{planned_big.adjustment_kcal}, "
        f"extra=+{extra_same_burn.adjustment_kcal}"
    )


def test_activity_metadata_changes_same_calorie_addback():
    print("\n[test] same calories can refuel differently by activity metadata")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    class Completion:
        def __init__(
            self,
            calories_burned: int,
            duration_seconds: int,
            *,
            activity_category: str,
            cardio_style: str | None = None,
            activity_intensity: str | None = None,
            stimulus: str | None = None,
        ):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds
            self.activity_category = activity_category
            self.cardio_style = cardio_style
            self.activity_intensity = activity_intensity
            self.stimulus = stimulus

    mobility = compute_activity_target_adjustment(
        [Completion(400, 3600, activity_category="mobility", stimulus="mobility")],
        goal_bucket="body_recomp",
    )
    intervals = compute_activity_target_adjustment(
        [Completion(400, 3600, activity_category="cardio", cardio_style="intervals", stimulus="conditioning")],
        goal_bucket="body_recomp",
    )

    assert mobility.adjustment_kcal == 75, mobility
    assert intervals.adjustment_kcal == 200, intervals
    assert intervals.recommended_carb_bias > mobility.recommended_carb_bias
    _ok(f"mobility=+{mobility.adjustment_kcal}, intervals=+{intervals.adjustment_kcal}")


def test_heavy_training_day_widens_cap():
    print("\n[test] heavy-day cap widens for double sessions and long/heavy efforts")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    class Completion:
        # Typed as strength so the rows count as *demanding* under the
        # intensity-aware heavy-day rule (untyped rows no longer do). The
        # strength factor with no intensity/stimulus is still 0.35, so the
        # add-back numbers below are unchanged from before the rule tightened.
        def __init__(self, calories_burned: int, duration_seconds: int):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds
            self.activity_category = "strength"

    # Two 500 kcal sessions = 1000 kcal total → 35% = 350. Heavy by count>=2.
    double = compute_activity_target_adjustment(
        [Completion(500, 3600), Completion(500, 3600)],
        goal_bucket="muscle_gain",
    )
    # Heavy cap for muscle_gain = 350 * 1.5 = 525.
    assert double.is_heavy_training_day, double
    assert double.adjustment_kcal == 350, double
    assert double.reason == "workout_heavy"

    # Single 1200 kcal session is heavy by burn>=700. fat_loss base cap=150,
    # heavy cap = round(150 * 1.5 / 25) * 25 = 225.
    big_burn_cut = compute_activity_target_adjustment(
        [Completion(1200, 7200)],
        goal_bucket="fat_loss",
    )
    assert big_burn_cut.is_heavy_training_day
    # 35% of 1200 = 420 → capped at 225.
    assert big_burn_cut.adjustment_kcal == 225, big_burn_cut.adjustment_kcal
    assert big_burn_cut.at_cap
    # Heavy-day cap is meaningfully larger than the standard fat_loss cap.
    assert big_burn_cut.adjustment_kcal > 150

    # 95 min light session (300 kcal) → heavy by duration only.
    long_session = compute_activity_target_adjustment(
        [Completion(300, 95 * 60)],
        goal_bucket="endurance",
    )
    assert long_session.is_heavy_training_day
    _ok(
        f"double=+{double.adjustment_kcal} (heavy cap), "
        f"big_burn_cut=+{big_burn_cut.adjustment_kcal} (capped), "
        f"long_session heavy={long_session.is_heavy_training_day}"
    )


def test_long_mobility_does_not_trigger_heavy_day():
    print("\n[test] 90 min mobility does not trip the heavy-day flag")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    res = compute_activity_target_adjustment(
        [_ActivityRow(350, 90 * 60, activity_category="mobility", stimulus="mobility")],
        goal_bucket="body_recomp",
    )
    assert res.is_heavy_training_day is False, res
    _ok(f"90 min mobility heavy={res.is_heavy_training_day}")


def test_long_unknown_row_does_not_trigger_heavy_day():
    print("\n[test] 90 min untyped row does not trip the heavy-day flag")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    res = compute_activity_target_adjustment(
        [_ActivityRow(500, 90 * 60)],  # no activity metadata at all
        goal_bucket="body_recomp",
    )
    assert res.is_heavy_training_day is False, res
    _ok(f"90 min untyped heavy={res.is_heavy_training_day}")


def test_strength_and_cardio_intervals_can_trigger_heavy_day():
    print("\n[test] strength volume and cardio intervals still trip heavy day")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    # Two strength sessions → heavy by demanding count >= 2.
    strength_double = compute_activity_target_adjustment(
        [_ActivityRow(400, 3600, activity_category="strength"),
         _ActivityRow(400, 3600, activity_category="strength")],
        goal_bucket="muscle_gain",
    )
    # One big cardio-intervals session → heavy by demanding kcal >= 700.
    intervals_big = compute_activity_target_adjustment(
        [_ActivityRow(800, 3600, activity_category="cardio",
                      cardio_style="intervals", stimulus="conditioning")],
        goal_bucket="endurance",
    )
    assert strength_double.is_heavy_training_day is True, strength_double
    assert intervals_big.is_heavy_training_day is True, intervals_big
    _ok("strength double + cardio-intervals both heavy")


def test_mixed_walk_plus_small_workout_not_heavy_from_total_kcal():
    print("\n[test] casual walk + small workout: total kcal alone does not = heavy")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    # 600 kcal casual walk (not demanding) + 200 kcal strength (demanding).
    # Total burn = 800 (>=700) but DEMANDING burn = 200, so not heavy.
    res = compute_activity_target_adjustment(
        [_ActivityRow(600, 60 * 60, activity_category="active"),
         _ActivityRow(200, 30 * 60, activity_category="strength")],
        goal_bucket="body_recomp",
    )
    assert res.exercise_kcal == 800, res
    assert res.is_heavy_training_day is False, res
    _ok(f"total={res.exercise_kcal} kcal, demanding burn < 700 → heavy={res.is_heavy_training_day}")


def test_carb_bias_stays_legacy_when_no_adjustment():
    print("\n[test] carb bias stays 0.60 when adjustment_kcal is 0")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    # Planned strength workout under the allowance → zero adjustment. Even
    # though the row is strength (tier 2 → 0.65), no adjustment means the
    # carb bias must fall back to the legacy default.
    res = compute_activity_target_adjustment(
        [_ActivityRow(300, 3600, activity_category="strength", stimulus="strength", plan_day_id=1)],
        goal_bucket="body_recomp",
        planned_workout_kcal_allowance=500,
    )
    assert res.adjustment_kcal == 0, res
    assert res.recommended_carb_bias == 0.60, res.recommended_carb_bias
    _ok(f"no adjustment → carb bias={res.recommended_carb_bias}")


def test_round_to_25_is_half_up():
    print("\n[test] _round_to_25 rounds 12.5 kcal to 25, not 0 (half-up)")
    from app.services.nutrition.activity_adjustment import _round_to_25

    assert _round_to_25(12.5) == 25, _round_to_25(12.5)
    assert _round_to_25(37.5) == 50, _round_to_25(37.5)
    assert _round_to_25(12.4) == 0, _round_to_25(12.4)
    _ok("12.5→25, 37.5→50, 12.4→0")


def test_same_day_neat_excess_adds_without_double_counting_workouts():
    print("\n[test] same-day NEAT excess contributes without re-counting workout calories")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    class Completion:
        def __init__(self, calories_burned: int, duration_seconds: int):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds

    # User logged a 400 kcal workout but Apple shows 1300 kcal active energy
    # for today vs an expected 500 kcal baseline. excess = 800; subtract the
    # 400 kcal workout = 400 kcal NEAT excess; 25% = 100 kcal NEAT add-back.
    with_neat = compute_activity_target_adjustment(
        [Completion(400, 3600)],
        goal_bucket="body_recomp",
        same_day_active_energy_kcal=1300,
        same_day_expected_active_energy_kcal=500,
    )
    workout_only = compute_activity_target_adjustment(
        [Completion(400, 3600)],
        goal_bucket="body_recomp",
    )
    assert workout_only.adjustment_kcal == 150  # 35% of 400 ≈ 140 → 150
    assert with_neat.workout_adjustment_kcal == 150
    assert with_neat.neat_adjustment_kcal == 100
    assert with_neat.adjustment_kcal == 250
    assert with_neat.reason == "workout_neat"

    # When today's active energy is barely above expected and is fully
    # explained by the workout, NEAT contribution must be zero (no double count).
    no_neat = compute_activity_target_adjustment(
        [Completion(400, 3600)],
        goal_bucket="body_recomp",
        same_day_active_energy_kcal=600,
        same_day_expected_active_energy_kcal=500,
    )
    assert no_neat.neat_adjustment_kcal == 0
    assert no_neat.adjustment_kcal == 150
    _ok(
        f"workout-only=+{workout_only.adjustment_kcal}, "
        f"workout+neat=+{with_neat.adjustment_kcal} (workout {with_neat.workout_adjustment_kcal} + NEAT {with_neat.neat_adjustment_kcal}), "
        f"no_neat=+{no_neat.adjustment_kcal}"
    )


def test_short_test_completions_do_not_move_calorie_target():
    """Sub-5-minute completions (created by users to test the share-to-Instagram
    flow / template path) used to bump the day's calorie target like a real
    session. Deleting them then read as the app "resetting your goals." Floor
    is MIN_ACTIVITY_BONUS_DURATION_SECONDS (300s); rows under that stay in
    history but contribute zero kcal + zero minutes to the bonus."""
    print("\n[test] sub-5-minute completions don't bump the calorie target")
    from app.services.nutrition.activity_adjustment import (
        compute_activity_target_adjustment,
        MIN_ACTIVITY_BONUS_DURATION_SECONDS,
    )

    class Completion:
        def __init__(self, calories_burned: int, duration_seconds: int):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds

    # 30-second test completion with a wildly inflated kcal value (could
    # come from an AH import that mismeasured a tap-through). Should be
    # filtered entirely.
    only_test = compute_activity_target_adjustment(
        [Completion(800, 30)],
        goal_bucket="body_recomp",
    )
    assert only_test.adjustment_kcal == 0, only_test
    assert only_test.exercise_kcal == 0
    assert only_test.duration_minutes == 0
    assert only_test.workout_count == 0
    assert only_test.reason == "none"

    # Real 60-min workout + a 1-min test completion. Adjustment should
    # match the real-only case — the test row contributes nothing.
    real_only = compute_activity_target_adjustment(
        [Completion(420, 3600)],
        goal_bucket="body_recomp",
    )
    real_plus_test = compute_activity_target_adjustment(
        [Completion(420, 3600), Completion(800, 60)],
        goal_bucket="body_recomp",
    )
    assert real_plus_test.adjustment_kcal == real_only.adjustment_kcal, (
        f"test completion changed adjustment: {real_plus_test.adjustment_kcal} vs {real_only.adjustment_kcal}"
    )
    assert real_plus_test.exercise_kcal == real_only.exercise_kcal
    assert real_plus_test.workout_count == 1  # only the real one counted

    # Boundary: exactly the threshold counts.
    at_threshold = compute_activity_target_adjustment(
        [Completion(150, MIN_ACTIVITY_BONUS_DURATION_SECONDS)],
        goal_bucket="body_recomp",
    )
    assert at_threshold.workout_count == 1
    assert at_threshold.exercise_kcal == 150
    _ok(
        f"only_test=+{only_test.adjustment_kcal}, "
        f"real_only=+{real_only.adjustment_kcal}, real+test=+{real_plus_test.adjustment_kcal}, "
        f"at_threshold workouts={at_threshold.workout_count}"
    )


def test_neat_only_day_still_produces_adjustment():
    print("\n[test] NEAT-only day (no logged workouts) produces a small bump")
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment

    bump = compute_activity_target_adjustment(
        [],
        goal_bucket="body_recomp",
        same_day_active_energy_kcal=900,
        same_day_expected_active_energy_kcal=500,
    )
    # excess = 400 → NEAT-only = 400 → 25% = 100 kcal.
    assert bump.workout_adjustment_kcal == 0
    assert bump.neat_adjustment_kcal == 100
    assert bump.adjustment_kcal == 100
    assert bump.reason == "neat"
    assert bump.is_heavy_training_day is False
    _ok(f"NEAT-only bump=+{bump.adjustment_kcal} (reason={bump.reason})")


def test_manual_activity_calorie_estimator_is_conservative():
    print("\n[test] manual activity calories estimate when no wearable value exists")
    from app.services.workout.activity_energy import estimate_activity_calories

    run = estimate_activity_calories(
        duration_seconds=3600,
        weight_lbs=180,
        category="cardio",
        subtype="run",
        intensity="moderate",
        cardio_style="steady",
    )
    yoga = estimate_activity_calories(
        duration_seconds=3600,
        weight_lbs=180,
        category="mobility",
        subtype="yoga",
        intensity="easy",
    )
    sauna = estimate_activity_calories(
        duration_seconds=1200,
        weight_lbs=180,
        category="recovery",
        subtype="sauna",
        intensity="easy",
    )

    assert run is not None and 650 <= run <= 850, run
    assert yoga is not None and 150 <= yoga <= 250, yoga
    assert sauna is None, sauna
    _ok(f"run={run} kcal, yoga={yoga} kcal, sauna ignored")


def test_health_activity_window_can_exclude_today_for_live_activity_bump():
    print("\n[test] live daily target can use prior HealthKit activity baseline")
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    today = date.today()
    with Session(eng) as s:
        _seed_user(s)
        for i in range(1, 7):
            d = today - timedelta(days=i)
            s.add(DailyHealthSnapshot(
                user_id=1,
                snapshot_date=d,
                steps=7000,
                active_energy_kcal=650,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        s.add(DailyHealthSnapshot(
            user_id=1,
            snapshot_date=today,
            steps=17000,
            active_energy_kcal=2200,
            source="apple_health",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        ))
        s.commit()

        through_today = resolve_targets_for_user(s, 1, as_of=today, include_health=True)
        through_yesterday = resolve_targets_for_user(
            s,
            1,
            as_of=today,
            include_health=True,
            health_activity_as_of=today - timedelta(days=1),
        )

    assert through_today is not None and through_yesterday is not None
    assert through_today.health_activity_adjustment_kcal > through_yesterday.health_activity_adjustment_kcal, (
        through_today.health_signal,
        through_yesterday.health_signal,
    )
    _ok(
        f"today-inclusive={through_today.health_activity_adjustment_kcal:+d}, "
        f"prior-baseline={through_yesterday.health_activity_adjustment_kcal:+d}"
    )


def test_adjusted_daily_target_weekly_smoothing_ignores_target_day_meals():
    print("\n[test] weekly smoothing is stable during the selected day")
    from app.routers.meals import adjusted_daily_target

    eng = _make_engine()
    target_day = date(2026, 5, 13)  # Wednesday
    prior_day = target_day - timedelta(days=1)
    with Session(eng) as s:
        _seed_user(s)
        prior_meal = Meal(
            user_id=1,
            meal_date=prior_day,
            meal_type=MealType.BREAKFAST,
            name="Prior day meal",
            source=MealSource.LOGGED,
        )
        target_day_meal = Meal(
            user_id=1,
            meal_date=target_day,
            meal_type=MealType.LUNCH,
            name="Target day meal",
            source=MealSource.LOGGED,
        )
        s.add(prior_meal)
        s.add(target_day_meal)
        s.commit()
        s.refresh(prior_meal)
        s.refresh(target_day_meal)
        s.add(MealItem(
            meal_id=prior_meal.id,
            food_name="Prior calories",
            quantity=1,
            unit="serving",
            calories=1000,
            protein_g=40,
            carbs_g=100,
            fat_g=25,
        ))
        s.add(MealItem(
            meal_id=target_day_meal.id,
            food_name="Today calories",
            quantity=1,
            unit="serving",
            calories=3000,
            protein_g=120,
            carbs_g=300,
            fat_g=90,
        ))
        s.commit()

        user = s.get(User, 1)
        assert user is not None
        result = adjusted_daily_target(target_date=target_day, current_user=user, db=s)

    assert result["calories_logged_so_far"] == 1000, result
    assert result["calories_logged_before_date"] == 1000, result
    assert result["weekly_smoothing_basis"] == "prior_days", result
    assert result["weekly_smoothing_locked_for_date"] is True, result
    _ok("target-day meals are excluded from weekly smoothing")


def test_meal_logging_does_not_recalculate_daily_target():
    print("\n[test] meal logging changes consumed totals, not target macros")
    from app.routers.meals import adjusted_daily_target, daily_summary

    eng = _make_engine()
    target_day = date(2026, 5, 13)  # Wednesday
    with Session(eng) as s:
        _seed_user(s)
        user = s.get(User, 1)
        assert user is not None
        before = adjusted_daily_target(target_date=target_day, current_user=user, db=s)

        meal = Meal(
            user_id=1,
            meal_date=target_day,
            meal_type=MealType.LUNCH,
            name="Logged lunch",
            source=MealSource.LOGGED,
        )
        s.add(meal)
        s.commit()
        s.refresh(meal)
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Lunch",
            quantity=1,
            unit="serving",
            calories=650,
            protein_g=45,
            carbs_g=70,
            fat_g=18,
        ))
        s.commit()

        after = adjusted_daily_target(target_date=target_day, current_user=user, db=s)
        summary = daily_summary(summary_date=target_day, current_user=user, db=s)

    assert after["adjusted_calories"] == before["adjusted_calories"], (before, after)
    assert after["adjusted_macros"] == before["adjusted_macros"], (before, after)
    assert summary["totals"]["calories"] == 650, summary
    assert summary["totals"]["protein_g"] == 45, summary
    assert summary["totals"]["carbs_g"] == 70, summary
    assert summary["totals"]["fat_g"] == 18, summary
    _ok("target stayed fixed while consumed totals changed")


def test_adjusted_daily_target_compares_prior_days_to_activity_adjusted_targets():
    print("\n[test] weekly smoothing compares prior days to their activity-adjusted targets")
    from app.routers.meals import adjusted_daily_target
    from app.services.nutrition.activity_adjustment import compute_activity_target_adjustment
    from app.services.nutrition.targets import resolve_targets_for_user

    class Completion:
        def __init__(self, calories_burned: int, duration_seconds: int):
            self.calories_burned = calories_burned
            self.duration_seconds = duration_seconds
            self.activity_category = "strength"
            self.activity_intensity = None
            self.cardio_style = None
            self.stimulus = "strength"

    eng = _make_engine()
    target_day = date(2026, 5, 15)  # Friday
    week_start = target_day - timedelta(days=target_day.weekday())
    with Session(eng) as s:
        _seed_user(s)
        base_targets = resolve_targets_for_user(s, 1, as_of=target_day, include_health=False)
        assert base_targets is not None
        activity_bump = compute_activity_target_adjustment(
            [Completion(800, 3600)],
            goal_bucket=base_targets.bucket_name,
        ).adjustment_kcal

        for offset in range(4):
            d = week_start + timedelta(days=offset)
            meal = Meal(
                user_id=1,
                meal_date=d,
                meal_type=MealType.DINNER,
                name=f"Fueled day {offset}",
                source=MealSource.LOGGED,
            )
            s.add(meal)
            s.commit()
            s.refresh(meal)
            s.add(MealItem(
                meal_id=meal.id,
                food_name="Activity adjusted intake",
                quantity=1,
                unit="day",
                calories=base_targets.calories + activity_bump,
                protein_g=base_targets.protein_g,
                carbs_g=base_targets.carbs_g,
                fat_g=base_targets.fat_g,
            ))
            s.add(WorkoutCompletion(
                user_id=1,
                workout_date=d,
                focus_label="Strength",
                duration_seconds=3600,
                calories_burned=800,
                activity_category="strength",
                stimulus="strength",
            ))
        s.commit()

        user = s.get(User, 1)
        assert user is not None
        result = adjusted_daily_target(target_date=target_day, current_user=user, db=s)

    assert activity_bump > 0
    assert result["calories_logged_so_far"] == 4 * (base_targets.calories + activity_bump), result
    assert result["weekly_adjustment_applied"] == 0, result
    _ok(f"prior workout refuels (+{activity_bump} kcal/day) do not create a false weekly trim")


def test_adjusted_daily_target_trims_after_skipped_workout_overage():
    print("\n[test] skipped workout day does not keep workout refuel credit")
    from app.routers.meals import adjusted_daily_target
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    target_day = date(2026, 5, 15)  # Friday
    week_start = target_day - timedelta(days=target_day.weekday())
    skipped_day = week_start
    with Session(eng) as s:
        _seed_user(s)
        week = PlanWeek(
            user_id=1,
            start_date=week_start,
            end_date=week_start + timedelta(days=6),
            planner_version="test",
            goal="body_recomp",
            days_per_week=4,
            status="active",
        )
        s.add(week)
        s.commit()
        s.refresh(week)
        s.add(PlanDay(
            plan_week_id=week.id,
            user_id=1,
            day_date=skipped_day,
            day_index=0,
            status="skipped",
            is_rest=False,
            workout_json={
                "archetype": "full_body_strength",
                "focus": "Full Body",
                "stimulus": "strength",
            },
            nutrition_json=None,
        ))
        s.add(UserDayState(
            user_id=1,
            day_key=skipped_day,
            skipped_focus="Full Body",
        ))
        base_targets = resolve_targets_for_user(s, 1, as_of=skipped_day, include_health=False)
        assert base_targets is not None

        meal = Meal(
            user_id=1,
            meal_date=skipped_day,
            meal_type=MealType.DINNER,
            name="Skipped day overage",
            source=MealSource.LOGGED,
        )
        s.add(meal)
        s.commit()
        s.refresh(meal)
        s.add(MealItem(
            meal_id=meal.id,
            food_name="Unmatched refuel",
            quantity=1,
            unit="day",
            calories=base_targets.calories + 600,
            protein_g=base_targets.protein_g,
            carbs_g=base_targets.carbs_g,
            fat_g=base_targets.fat_g,
        ))
        s.commit()

        user = s.get(User, 1)
        assert user is not None
        result = adjusted_daily_target(target_date=target_day, current_user=user, db=s)

    assert result["activity_workout_adjustment_kcal"] == 0, result
    assert result["weekly_adjustment_applied"] < 0, result
    _ok(f"unearned +600 kcal overage trims remaining days by {result['weekly_adjustment_applied']} kcal")


def test_adjusted_daily_target_preserves_plan_day_macros_and_day_override():
    print("\n[test] live daily target preserves planned-day macro shape and carb bump")
    from app.routers.meals import adjusted_daily_target
    from app.services.nutrition.carb_distribution import MacroSet, redistribute_for_day
    from app.services.nutrition.targets import resolve_targets_for_user

    eng = _make_engine()
    target_day = date(2026, 5, 13)  # Wednesday
    week_start = target_day - timedelta(days=target_day.weekday())
    workout_json = {
        "archetype": "full_body_strength",
        "focus": "Full Body",
        "stimulus": "strength",
    }
    with Session(eng) as s:
        _seed_user(s)
        week = PlanWeek(
            user_id=1,
            start_date=week_start,
            end_date=week_start + timedelta(days=6),
            planner_version="test",
            goal="body_recomp",
            days_per_week=4,
            status="active",
        )
        s.add(week)
        s.commit()
        s.refresh(week)
        s.add(PlanDay(
            plan_week_id=week.id,
            user_id=1,
            day_date=target_day,
            day_index=2,
            status="planned",
            is_rest=False,
            workout_json=workout_json,
            nutrition_json=None,
        ))
        s.add(UserDayState(
            user_id=1,
            day_key=target_day,
            macro_overrides={"carb_bump_g": 20, "source": "coach"},
        ))
        s.commit()

        base_targets = resolve_targets_for_user(s, 1, as_of=target_day, include_health=False)
        assert base_targets is not None
        expected_day, expected_type = redistribute_for_day(
            MacroSet(
                calories=base_targets.calories,
                protein_g=base_targets.protein_g,
                carbs_g=base_targets.carbs_g,
                fat_g=base_targets.fat_g,
            ),
            archetype=workout_json["archetype"],
            focus=workout_json["focus"],
            stimulus=workout_json["stimulus"],
            goal_bucket=base_targets.bucket_name,
        )

        user = s.get(User, 1)
        assert user is not None
        result = adjusted_daily_target(target_date=target_day, current_user=user, db=s)

    assert expected_type == "heavy"
    assert result["target_day_type"] == "heavy", result
    assert result["base_daily_target"] == expected_day.calories + 80, result
    assert abs(result["adjusted_calories"] - result["base_daily_target"]) <= 5, result
    assert result["adjusted_macros"]["protein_g"] == expected_day.protein_g, result
    assert result["adjusted_macros"]["carbs_g"] == expected_day.carbs_g + 20, result
    assert result["adjusted_macros"]["fat_g"] == expected_day.fat_g, result
    _ok("heavy-day carbs plus one-day carb bump survive the live target endpoint")


TESTS = [
    test_coaching_and_apple_health_activity_adjust_targets,
    test_recent_apple_health_weight_replaces_profile_weight,
    test_saved_custom_macros_drive_user_and_request_targets,
    test_recent_apple_basal_energy_adjusts_formula_bmr,
    test_apple_total_energy_prevents_basal_multiplier_overshoot,
    test_apple_total_energy_blend_tiers_and_guardrail,
    test_recent_manual_weight_entry_drives_macro_targets,
    test_plan_day_targets_shift_with_day_type_without_mutating_template,
    test_new_plan_week_retargets_stale_nutrition_templates,
    test_adjusted_daily_target_exposes_target_basis,
    test_adjusted_daily_target_exposes_total_energy_basis,
    test_same_day_activity_adjustment_is_partial_and_capped,
    test_planned_workout_spends_expected_training_allowance_before_refuel,
    test_activity_metadata_changes_same_calorie_addback,
    test_heavy_training_day_widens_cap,
    test_long_mobility_does_not_trigger_heavy_day,
    test_long_unknown_row_does_not_trigger_heavy_day,
    test_strength_and_cardio_intervals_can_trigger_heavy_day,
    test_mixed_walk_plus_small_workout_not_heavy_from_total_kcal,
    test_carb_bias_stays_legacy_when_no_adjustment,
    test_round_to_25_is_half_up,
    test_same_day_neat_excess_adds_without_double_counting_workouts,
    test_neat_only_day_still_produces_adjustment,
    test_manual_activity_calorie_estimator_is_conservative,
    test_health_activity_window_can_exclude_today_for_live_activity_bump,
    test_adjusted_daily_target_weekly_smoothing_ignores_target_day_meals,
    test_meal_logging_does_not_recalculate_daily_target,
    test_adjusted_daily_target_compares_prior_days_to_activity_adjusted_targets,
    test_adjusted_daily_target_trims_after_skipped_workout_overage,
    test_adjusted_daily_target_preserves_plan_day_macros_and_day_override,
]


def run_all():
    passed = failed = 0
    for test_fn in TESTS:
        try:
            test_fn()
            passed += 1
        except Exception as exc:
            failed += 1
            print(f"  FAIL {test_fn.__name__}: {exc}")
            import traceback
            traceback.print_exc()
    print(f"\nAdaptive nutrition targets: {passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    raise SystemExit(0 if run_all() else 1)
