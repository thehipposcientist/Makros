from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.enums import Gender, MealSource, MealType
from app.models import (
    DailyHealthSnapshot,
    DailyNutritionMetrics,
    Meal,
    MealItem,
    SleepLog,
    User,
    UserPreferences,
    UserProfile,
    WorkoutCompletion,
)
from app.services.health.metabolic_signals import (
    MacroDay,
    MealTimeEvent,
    WindowMetrics,
    _autophagy_opportunity,
    _clamp,
    _fasting_metrics,
    build_metabolic_signals_response,
)


def _make_session() -> tuple[Session, User]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    user = User(
        email="signals@example.com",
        username="signals",
        hashed_password="x",
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(UserProfile(
        user_id=user.id,
        weight_lbs=180,
        height_feet=5,
        height_inches=10,
        age=32,
        gender=Gender.MALE,
    ))
    session.add(UserPreferences(user_id=user.id, days_per_week=4))
    session.commit()
    return session, user


def _empty_window(days: int = 14, *, workouts: int = 2) -> WindowMetrics:
    today = date.today()
    return WindowMetrics(
        today=today,
        start=today - timedelta(days=days - 1),
        days=days,
        profile=None,
        preferences=None,
        goal=None,
        health_rows=[],
        sleep_rows=[],
        nutrition_rows=[],
        workouts=[object()] * workouts,  # only len() is used by autophagy confidence scoring
        labs=[],
        macros_by_day={},
        data_coverage={},
        data_used=[],
        missing_data=[],
    )


def _ctx_with_calorie_events(events: list[tuple[datetime, bool]]) -> WindowMetrics:
    today = date.today()
    macros_by_day: dict[date, MacroDay] = {}
    for at, inferred in events:
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        day = macros_by_day.setdefault(at.date(), MacroDay())
        day.calories += 100
        day.meal_times.append(at)
        day.meal_time_events.append(MealTimeEvent(at=at, inferred=inferred))
    for day in macros_by_day.values():
        day.meal_times.sort()
        day.meal_time_events.sort(key=lambda event: event.at)
    return WindowMetrics(
        today=today,
        start=today - timedelta(days=13),
        days=14,
        profile=None,
        preferences=None,
        goal=None,
        health_rows=[],
        sleep_rows=[],
        nutrition_rows=[],
        workouts=[],
        labs=[],
        macros_by_day=macros_by_day,
        data_coverage={},
        data_used=[],
        missing_data=[],
    )


def _base_autophagy_metrics(**overrides) -> dict:
    metrics = {
        "avg_sleep_hours": None,
        "avg_energy_availability": None,
        "avg_carbs_per_lb": None,
        "zone2_min_per_week": None,
        "strength_per_week": 0.0,
        "sleep_nights": 5,
        "health_days": 7,
        "nutrition_days": 5,
        "hormone_lab_count": 0,
        "activity_mix": {
            "heavy_strength_sessions_per_week": 0.0,
            "steady_cardio_sessions_per_week": 0.0,
            "intense_cardio_sessions_per_week": 0.0,
            "recovery_sessions_per_week": 0.0,
        },
        "fasting": {
            "days_with_timing": 3,
            "avg_longest_daily_fast_hours": None,
            "max_gap_hours": None,
            "current_fast_hours": None,
            "current_fast_stale": False,
            "exact_timestamp_count": 6,
            "inferred_timestamp_count": 0,
            "inferred_timestamp_ratio": 0.0,
        },
    }
    for key, value in overrides.items():
        if key == "activity_mix":
            metrics["activity_mix"].update(value)
        elif key == "fasting":
            metrics["fasting"].update(value)
        else:
            metrics[key] = value
    return metrics


def _score_autophagy(metrics: dict, *, cortisol_score: int = 50, workouts: int = 2) -> dict:
    return _autophagy_opportunity(_empty_window(workouts=workouts), metrics, {"score": cortisol_score})


def _add_macro_day(
    session: Session,
    user_id: int,
    day: date,
    *,
    calories: float,
    protein_g: float,
    carbs_g: float,
    fat_g: float,
    first_meal_hour: int = 13,
    last_meal_hour: int = 18,
    energy_availability: float = 36,
    inferred_times: bool = False,
) -> None:
    session.add(DailyNutritionMetrics(
        user_id=user_id,
        metric_date=day,
        calories_total=calories,
        fiber_total_g=32,
        added_sugar_g=18,
        saturated_fat_g=18,
        micronutrient_item_count=4,
        energy_availability=energy_availability,
        alcohol_servings=0,
    ))
    for hour, meal_type, ratio in (
        (first_meal_hour, MealType.LUNCH, 0.48),
        (last_meal_hour, MealType.DINNER, 0.52),
    ):
        meal = Meal(
            user_id=user_id,
            meal_date=day,
            meal_type=meal_type,
            name="Signal meal",
            source=MealSource.LOGGED,
            consumed_at=None if inferred_times else datetime.combine(day, time(hour=hour), tzinfo=timezone.utc),
        )
        session.add(meal)
        session.flush()
        session.add(MealItem(
            meal_id=meal.id,
            food_name="macro plate",
            quantity=1,
            unit="serving",
            calories=calories * ratio,
            protein_g=protein_g * ratio,
            carbs_g=carbs_g * ratio,
            fat_g=fat_g * ratio,
        ))


def _add_supportive_window(session: Session, user_id: int, *, inferred_meal_times: bool = False) -> None:
    today = date.today()
    for i in range(14):
        day = today - timedelta(days=13 - i)
        session.add(DailyHealthSnapshot(
            user_id=user_id,
            snapshot_date=day,
            steps=9500,
            active_energy_kcal=720,
            basal_energy_kcal=1850,
            workout_minutes=45 if i % 2 == 0 else 20,
            cardio_minutes=30,
            zone2_minutes=24,
            resting_hr=52,
            hrv_ms=62 + (i * 0.3),
            vo2_max=45,
            respiratory_rate=15,
            oxygen_saturation=97,
            weight_lbs=180,
        ))
        session.add(SleepLog(
            user_id=user_id,
            night_date=day,
            total_hours=7.65,
            hrv_ms=62,
            resting_hr=52,
            respiratory_rate=15,
            spo2_percent=97,
            bedtime_minutes_from_midnight=23 * 60,
            score=84,
            rating="Good",
        ))
        _add_macro_day(
            session,
            user_id,
            day,
            calories=2600,
            protein_g=170,
            carbs_g=250,
            fat_g=82,
            first_meal_hour=14,
            energy_availability=37,
            inferred_times=inferred_meal_times,
        )
    for i in range(6):
        day = today - timedelta(days=i * 2)
        session.add(WorkoutCompletion(
            user_id=user_id,
            workout_date=day,
            focus_label="Strength",
            stimulus="strength",
            duration_seconds=2700,
            ended_at=datetime.combine(day, time(hour=17), tzinfo=timezone.utc),
        ))
    session.commit()


def _add_strained_window(session: Session, user_id: int) -> None:
    today = date.today()
    for i in range(14):
        day = today - timedelta(days=13 - i)
        session.add(DailyHealthSnapshot(
            user_id=user_id,
            snapshot_date=day,
            steps=12500,
            active_energy_kcal=1050,
            basal_energy_kcal=1850,
            workout_minutes=80,
            cardio_minutes=35,
            zone2_minutes=0,
            resting_hr=52 + i,
            hrv_ms=66 - i * 1.8,
            respiratory_rate=18,
            oxygen_saturation=96,
            sleep_breathing_disturbances=1.8,
            sleep_breathing_disturbances_elevated=i >= 10,
            weight_lbs=186 - i,
        ))
        session.add(SleepLog(
            user_id=user_id,
            night_date=day,
            total_hours=5.55,
            hrv_ms=58 - i,
            resting_hr=54 + i,
            respiratory_rate=18,
            spo2_percent=96,
            bedtime_minutes_from_midnight=(23 * 60 + i * 20) % (24 * 60),
            score=48,
            rating="Poor",
        ))
        _add_macro_day(
            session,
            user_id,
            day,
            calories=1600,
            protein_g=100,
            carbs_g=75,
            fat_g=17,
            first_meal_hour=10,
            last_meal_hour=22,
            energy_availability=22,
        )
    for i in range(11):
        day = today - timedelta(days=i)
        session.add(WorkoutCompletion(
            user_id=user_id,
            workout_date=day,
            focus_label="HIIT strength",
            stimulus="conditioning",
            activity_intensity="hard",
            duration_seconds=4800,
            ended_at=datetime.combine(day, time(hour=21), tzinfo=timezone.utc),
        ))
    session.commit()


def test_autophagy_current_fast_thresholds_are_mutually_exclusive() -> None:
    expected = {
        10: 16,
        11: 30,
        13: 37,
        16: 45,
        24: 34,
    }
    for hours, score in expected.items():
        metrics = _base_autophagy_metrics(fasting={"current_fast_hours": float(hours)})
        result = _score_autophagy(metrics)
        assert result["score"] == score


def test_autophagy_twenty_four_hour_fast_gets_less_credit_than_moderate_extended_fast() -> None:
    moderate = _score_autophagy(_base_autophagy_metrics(fasting={"current_fast_hours": 16.0}))
    long_fast = _score_autophagy(_base_autophagy_metrics(fasting={"current_fast_hours": 24.0}))

    assert long_fast["score"] < moderate["score"]
    assert "long fast" in " ".join(long_fast["drivers"]).lower()


def test_fasting_metrics_count_overnight_gaps_across_midnight() -> None:
    today = date.today()
    metrics = _fasting_metrics(_ctx_with_calorie_events([
        (datetime.combine(today - timedelta(days=1), time(hour=19), tzinfo=timezone.utc), False),
        (datetime.combine(today, time(hour=9), tzinfo=timezone.utc), False),
    ]))

    assert round(metrics["avg_longest_daily_fast_hours"], 1) == 14.0


def test_fasting_metrics_count_shorter_overnight_gap_across_midnight() -> None:
    today = date.today()
    metrics = _fasting_metrics(_ctx_with_calorie_events([
        (datetime.combine(today - timedelta(days=1), time(hour=22), tzinfo=timezone.utc), False),
        (datetime.combine(today, time(hour=8), tzinfo=timezone.utc), False),
    ]))

    assert round(metrics["avg_longest_daily_fast_hours"], 1) == 10.0


def test_fasting_metrics_use_longest_gap_ending_that_day_with_multiple_meals() -> None:
    today = date.today()
    metrics = _fasting_metrics(_ctx_with_calorie_events([
        (datetime.combine(today - timedelta(days=1), time(hour=19), tzinfo=timezone.utc), False),
        (datetime.combine(today, time(hour=9), tzinfo=timezone.utc), False),
        (datetime.combine(today, time(hour=12), tzinfo=timezone.utc), False),
        (datetime.combine(today, time(hour=20), tzinfo=timezone.utc), False),
    ]))

    assert round(metrics["avg_longest_daily_fast_hours"], 1) == 14.0


def test_autophagy_inferred_meal_timestamps_reduce_confidence_and_override_label() -> None:
    metrics = _base_autophagy_metrics(
        avg_sleep_hours=7.5,
        avg_energy_availability=36,
        avg_carbs_per_lb=0.7,
        zone2_min_per_week=90,
        activity_mix={"heavy_strength_sessions_per_week": 2.0, "recovery_sessions_per_week": 2.0},
        fasting={
            "current_fast_hours": 16.0,
            "avg_longest_daily_fast_hours": 14.0,
            "exact_timestamp_count": 0,
            "inferred_timestamp_count": 8,
            "inferred_timestamp_ratio": 1.0,
        },
    )

    result = _score_autophagy(metrics)

    assert result["score"] >= 76
    assert result["confidence"] == "low"
    assert result["label"] == "Building baseline"


def test_autophagy_stale_meal_logs_do_not_create_false_current_fast_credit() -> None:
    metrics = _base_autophagy_metrics(
        avg_sleep_hours=7.5,
        avg_energy_availability=36,
        zone2_min_per_week=90,
        activity_mix={"heavy_strength_sessions_per_week": 2.0, "recovery_sessions_per_week": 2.0},
        fasting={
            "current_fast_hours": None,
            "current_fast_stale": True,
            "avg_longest_daily_fast_hours": 14.0,
        },
    )

    result = _score_autophagy(metrics)

    assert result["score"] < 76
    assert result["label"] != "High opportunity"
    assert "missing logs are not treated as fasting" in " ".join(result["limiting_factors"]).lower()


def test_autophagy_recovery_and_underfueling_caps_use_strictest_cap() -> None:
    high_opportunity = dict(
        avg_carbs_per_lb=1.0,
        zone2_min_per_week=90,
        activity_mix={"heavy_strength_sessions_per_week": 2.0, "recovery_sessions_per_week": 2.0},
        fasting={"current_fast_hours": 16.0, "avg_longest_daily_fast_hours": 14.0},
    )
    assert _score_autophagy(_base_autophagy_metrics(
        **high_opportunity,
        avg_sleep_hours=5.8,
        avg_energy_availability=36,
    ))["score"] == 68
    assert _score_autophagy(_base_autophagy_metrics(
        **high_opportunity,
        avg_sleep_hours=5.4,
        avg_energy_availability=36,
    ))["score"] == 55
    assert _score_autophagy(_base_autophagy_metrics(
        **high_opportunity,
        avg_sleep_hours=7.5,
        avg_energy_availability=28,
    ))["score"] == 60
    assert _score_autophagy(_base_autophagy_metrics(
        **high_opportunity,
        avg_sleep_hours=7.5,
        avg_energy_availability=24,
    ))["score"] == 50
    assert _score_autophagy(_base_autophagy_metrics(
        **high_opportunity,
        avg_sleep_hours=7.5,
        avg_energy_availability=36,
    ), cortisol_score=70)["score"] == 57
    assert _score_autophagy(_base_autophagy_metrics(
        **high_opportunity,
        avg_sleep_hours=5.4,
        avg_energy_availability=24,
    ), cortisol_score=70)["score"] == 50


def test_autophagy_low_carb_bonus_requires_sleep_and_energy_availability() -> None:
    good = _score_autophagy(_base_autophagy_metrics(
        avg_carbs_per_lb=0.7,
        avg_sleep_hours=7.0,
        avg_energy_availability=36,
    ))
    low_sleep = _score_autophagy(_base_autophagy_metrics(
        avg_carbs_per_lb=0.7,
        avg_sleep_hours=6.0,
        avg_energy_availability=36,
    ))
    low_energy = _score_autophagy(_base_autophagy_metrics(
        avg_carbs_per_lb=0.7,
        avg_sleep_hours=7.0,
        avg_energy_availability=28,
    ))

    assert good["score"] == 32
    assert low_sleep["score"] == 27
    assert low_energy["score"] == 16


def test_autophagy_final_score_is_clamped() -> None:
    result = _score_autophagy(_base_autophagy_metrics(
        avg_sleep_hours=5.4,
        avg_energy_availability=24,
        avg_carbs_per_lb=2.0,
        activity_mix={"intense_cardio_sessions_per_week": 3.0},
        fasting={"current_fast_hours": 10.0, "avg_longest_daily_fast_hours": 9.0},
    ))

    assert result["score"] == 0
    assert _clamp(125) == 100


def test_autophagy_low_confidence_label_overrides_high_numeric_score_from_inferred_times() -> None:
    metrics = _base_autophagy_metrics(
        avg_sleep_hours=7.5,
        avg_energy_availability=36,
        avg_carbs_per_lb=0.7,
        zone2_min_per_week=90,
        activity_mix={"heavy_strength_sessions_per_week": 2.0, "recovery_sessions_per_week": 2.0},
        fasting={
            "current_fast_hours": 16.0,
            "avg_longest_daily_fast_hours": 14.0,
            "exact_timestamp_count": 1,
            "inferred_timestamp_count": 7,
            "inferred_timestamp_ratio": 0.875,
        },
    )

    result = _score_autophagy(metrics)

    assert result["score"] >= 76
    assert result["label"] == "Building baseline"


def test_supportive_window_publishes_specific_hormone_and_autophagy_estimates() -> None:
    session, user = _make_session()
    try:
        _add_supportive_window(session, user.id)
        result = build_metabolic_signals_response(session, user.id, days=30)
        estimates = {row["key"]: row for row in result["hormone_support"]["estimates"]}

        assert result["hormone_support"]["confidence"] in {"medium", "high"}
        assert result["hormone_support"]["score"] >= 60
        assert estimates["testosterone_support"]["score"] >= 70
        assert estimates["cortisol_load"]["score"] < 50
        supportive_text = " ".join(estimates["testosterone_support"]["positive_factors"]).lower()
        assert "7.7h sleep" in supportive_text
        assert "0.94 g/lb protein" in supportive_text
        assert "28% of calories from fat" in supportive_text
        rhythm = result["stress_rhythm"]
        segments = {row["key"]: row for row in rhythm["segments"]}
        assert rhythm["confidence"] in {"medium", "high"}
        assert segments["wake_morning"]["score"] >= 58
        assert segments["evening_downshift"]["score"] < 45
        assert result["autophagy"]["confidence"] in {"medium", "high"}
        assert result["autophagy"]["score"] >= 40
    finally:
        session.close()


def test_missing_consumed_at_fallback_reduces_autophagy_confidence() -> None:
    session, user = _make_session()
    try:
        _add_supportive_window(session, user.id, inferred_meal_times=True)
        result = build_metabolic_signals_response(session, user.id, days=30)

        assert result["source_metrics"]["meal_timing_exact_timestamps"] == 0
        assert result["source_metrics"]["meal_timing_inferred_timestamps"] > 0
        assert result["autophagy"]["confidence"] == "low"
        assert result["autophagy"]["label"] == "Building baseline"
    finally:
        session.close()


def test_strained_window_flags_suppression_risk_and_cortisol_load() -> None:
    session, user = _make_session()
    try:
        _add_strained_window(session, user.id)
        result = build_metabolic_signals_response(session, user.id, days=30)
        estimates = {row["key"]: row for row in result["hormone_support"]["estimates"]}

        assert estimates["testosterone_support"]["score"] < 45
        assert estimates["thyroid_metabolic_support"]["score"] < 45
        assert estimates["cortisol_load"]["score"] >= 70
        segments = {row["key"]: row for row in result["stress_rhythm"]["segments"]}
        assert segments["daytime_load"]["score"] >= 70
        assert segments["evening_downshift"]["score"] >= 70
        strained_text = " ".join(estimates["testosterone_support"]["limiting_factors"]).lower()
        assert "low energy availability" in strained_text
        assert "22 kcal/kg ffm" in strained_text
        assert "%/week" in strained_text
        assert any("300-500 kcal" in item or "7.5-9h" in item for item in estimates["testosterone_support"]["recommendations"])
        assert any("48" in item or "hiit" in item.lower() for item in estimates["cortisol_load"]["recommendations"])
        assert result["autophagy"]["score"] <= 62
    finally:
        session.close()


def test_evening_recovery_activity_does_not_count_as_late_stressor() -> None:
    session, user = _make_session()
    try:
        _add_supportive_window(session, user.id)
        today = date.today()
        for i in range(5):
            day = today - timedelta(days=i)
            session.add(WorkoutCompletion(
                user_id=user.id,
                workout_date=day,
                focus_label="Recovery",
                stimulus="recovery",
                activity_category="recovery",
                activity_subtype="breathwork",
                activity_intensity="easy",
                duration_seconds=900,
                ended_at=datetime.combine(day, time(hour=21, minute=30), tzinfo=timezone.utc),
            ))
        session.commit()

        result = build_metabolic_signals_response(session, user.id, days=30)
        segments = {row["key"]: row for row in result["stress_rhythm"]["segments"]}

        assert result["source_metrics"]["late_recovery_activities"] == 5
        assert result["source_metrics"]["late_stressor_workouts"] == 0
        assert segments["evening_downshift"]["score"] < 40
        evening_text = " ".join(segments["evening_downshift"]["drivers"]).lower()
        assert "evening recovery activities" in evening_text
        assert "support the downshift" in evening_text
    finally:
        session.close()


def test_hiit_activity_has_different_stress_effect_than_steady_recovery() -> None:
    session, user = _make_session()
    try:
        _add_supportive_window(session, user.id)
        today = date.today()
        for i in range(6):
            day = today - timedelta(days=i * 2)
            session.add(WorkoutCompletion(
                user_id=user.id,
                workout_date=day,
                focus_label="HIIT",
                stimulus="conditioning",
                activity_category="cardio",
                activity_subtype="hiit",
                activity_intensity="hard",
                cardio_style="intervals",
                duration_seconds=1800,
                ended_at=datetime.combine(day, time(hour=16), tzinfo=timezone.utc),
            ))
        session.commit()

        result = build_metabolic_signals_response(session, user.id, days=14)
        estimates = {row["key"]: row for row in result["hormone_support"]["estimates"]}
        daytime = next(row for row in result["stress_rhythm"]["segments"] if row["key"] == "daytime_load")

        assert result["source_metrics"]["intense_cardio_sessions_per_week"] >= 3
        assert "hiit/interval" in " ".join(estimates["cortisol_load"]["limiting_factors"]).lower()
        assert "hiit/interval" in " ".join(daytime["drivers"]).lower()
    finally:
        session.close()


cases = [
    test_autophagy_current_fast_thresholds_are_mutually_exclusive,
    test_autophagy_twenty_four_hour_fast_gets_less_credit_than_moderate_extended_fast,
    test_fasting_metrics_count_overnight_gaps_across_midnight,
    test_fasting_metrics_count_shorter_overnight_gap_across_midnight,
    test_fasting_metrics_use_longest_gap_ending_that_day_with_multiple_meals,
    test_autophagy_inferred_meal_timestamps_reduce_confidence_and_override_label,
    test_autophagy_stale_meal_logs_do_not_create_false_current_fast_credit,
    test_autophagy_recovery_and_underfueling_caps_use_strictest_cap,
    test_autophagy_low_carb_bonus_requires_sleep_and_energy_availability,
    test_autophagy_final_score_is_clamped,
    test_autophagy_low_confidence_label_overrides_high_numeric_score_from_inferred_times,
    test_supportive_window_publishes_specific_hormone_and_autophagy_estimates,
    test_missing_consumed_at_fallback_reduces_autophagy_confidence,
    test_strained_window_flags_suppression_risk_and_cortisol_load,
    test_evening_recovery_activity_does_not_count_as_late_stressor,
    test_hiit_activity_has_different_stress_effect_than_steady_recovery,
]
