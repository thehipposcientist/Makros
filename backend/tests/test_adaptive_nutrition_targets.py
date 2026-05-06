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
from sqlmodel import Session, SQLModel, create_engine

from app.enums import Gender, GoalPace, GoalType
from app.models import (
    DailyHealthSnapshot,
    User,
    UserCoachingState,
    UserGoal,
    UserPreferences,
    UserProfile,
    WeightEntry,
)


def _ok(label: str) -> None:
    print(f"  PASS {label}")


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_user(s: Session, *, user_id: int = 1, weight_lbs: float = 180.0) -> None:
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
        days_per_week=4,
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
    capped = compute_activity_target_adjustment(
        [Completion(900, 5400)],
        goal_bucket="fat_loss",
    )

    assert moderate.exercise_kcal == 420
    assert moderate.adjustment_kcal == 150
    assert capped.adjustment_kcal == 125 and capped.at_cap
    _ok(f"body_recomp +{moderate.adjustment_kcal} kcal, fat_loss capped +{capped.adjustment_kcal} kcal")


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


TESTS = [
    test_coaching_and_apple_health_activity_adjust_targets,
    test_recent_apple_health_weight_replaces_profile_weight,
    test_recent_manual_weight_entry_drives_macro_targets,
    test_plan_day_targets_shift_with_day_type_without_mutating_template,
    test_same_day_activity_adjustment_is_partial_and_capped,
    test_manual_activity_calorie_estimator_is_conservative,
    test_health_activity_window_can_exclude_today_for_live_activity_bump,
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
