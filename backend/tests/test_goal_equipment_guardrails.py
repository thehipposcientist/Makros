"""Goal/equipment compatibility guardrail tests."""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _warnings(goal: str, equipment: list[str]) -> list[str]:
    from app.services.workout.goal_equipment_guardrails import goal_equipment_warnings

    return goal_equipment_warnings(goal, equipment)


def test_strength_bike_only_warns_but_dumbbells_do_not():
    print("\n[test] guardrails: strength with bike-only equipment warns")
    bike_only = _warnings("build_strength", ["Stationary bike"])
    assert bike_only, "expected a warning for strength with only cardio equipment"
    assert any("progressive resistance" in w for w in bike_only), bike_only

    dumbbells = _warnings("build_strength", ["Dumbbells", "Adjustable bench"])
    assert not dumbbells, f"dumbbell strength setup should not warn: {dumbbells}"
    _ok("strength bike-only warning is specific; dumbbell setup is allowed")


def test_strength_bands_warn_as_light_resistance():
    print("\n[test] guardrails: bands-only strength is light-resistance warning")
    warnings = _warnings("build_strength", ["Resistance bands (tube)"])
    assert warnings, "expected bands-only strength warning"
    assert any("light-resistance" in w for w in warnings), warnings
    _ok("bands-only strength gets limited-progression warning")


def test_barbell_specific_goals_require_complete_setup():
    print("\n[test] guardrails: barbell-specific goals require relevant setup")
    bench_only = _warnings("powerlifting", ["Flat bench"])
    assert bench_only and any("barbell-specific" in w for w in bench_only), bench_only

    full_powerlifting = _warnings("powerlifting", ["Barbell", "Weight plates", "Power rack", "Flat bench"])
    assert not any("barbell-specific" in w for w in full_powerlifting), full_powerlifting

    deadlift = _warnings("improve_deadlift", ["Barbell", "Weight plates"])
    assert not any("barbell-specific" in w for w in deadlift), deadlift
    _ok("bench-only warns; complete barbell setup clears the warning")


def test_muscle_gain_bike_only_warns_about_progressive_overload():
    print("\n[test] guardrails: muscle gain with bike-only equipment warns")
    warnings = _warnings("build_muscle", ["Stationary bike"])
    assert warnings, "expected muscle gain warning with only cardio equipment"
    assert any("muscle-building" in w for w in warnings), warnings
    _ok("muscle gain bike-only warning mentions progressive overload")


def test_goal_focus_specific_muscle_warnings():
    print("\n[test] guardrails: focused muscle goals need matching resistance")
    glutes = _warnings("build_glutes", ["Pull-up bar"])
    assert glutes and any("lower-body resistance" in w for w in glutes), glutes

    upper = _warnings("build_upper_body", ["Leg press"])
    assert upper and any("upper-body focus" in w for w in upper), upper

    glutes_ok = _warnings("build_glutes", ["Dumbbells"])
    assert not any("lower-body resistance" in w for w in glutes_ok), glutes_ok
    _ok("body-part goals warn when equipment supports the wrong region")


def test_preserve_muscle_cutting_warns_without_resistance():
    print("\n[test] guardrails: preserve-muscle fat loss needs resistance")
    warnings = _warnings("preserve_muscle_cutting", ["Stationary bike"])
    assert warnings and any("Preserving muscle" in w for w in warnings), warnings
    assert not _warnings("preserve_muscle_cutting", ["Dumbbells"])
    _ok("preserve-muscle cutting warns without resistance")


def test_specific_endurance_modality_warnings():
    print("\n[test] guardrails: modality-specific endurance warnings")
    assert not _warnings("cycling_endurance", ["Stationary bike"])

    rowing = _warnings("rowing_endurance", ["Stationary bike"])
    assert rowing and any("rowing machine" in w.lower() for w in rowing), rowing

    swimming = _warnings("swimming_endurance", ["Stationary bike"])
    assert swimming and any("pool" in w.lower() for w in swimming), swimming

    running = _warnings("train_5k", ["Stationary bike"])
    assert running and any("running" in w.lower() for w in running), running
    assert not _warnings("train_5k", ["Bodyweight / no equipment"])
    _ok("specific endurance goals warn when selected equipment is cross-training")


def test_speed_power_and_hyrox_warnings():
    print("\n[test] guardrails: speed, power, and HYROX need specific tools")
    speed = _warnings("improve_speed", ["Stationary bike"])
    assert speed and any("Speed and agility" in w for w in speed), speed
    assert not any("Speed and agility" in w for w in _warnings("improve_speed", ["Bodyweight / no equipment"]))

    power = _warnings("improve_vertical", ["Stationary bike"])
    assert power and any("Power and jump" in w for w in power), power

    hyrox_bike = _warnings("hyrox", ["Stationary bike"])
    assert any("Hybrid performance" in w for w in hyrox_bike), hyrox_bike
    assert any("HYROX-style goals include running" in w for w in hyrox_bike), hyrox_bike

    hyrox_ok = _warnings("hyrox", ["Treadmill", "Rowing machine", "Sled", "Dumbbells"])
    assert not any("Hybrid performance" in w for w in hyrox_ok), hyrox_ok
    assert not any("HYROX-style goals include running" in w for w in hyrox_ok), hyrox_ok
    _ok("speed/power/HYROX warnings match equipment specificity")


def test_health_longevity_specific_warnings():
    print("\n[test] guardrails: health/longevity goals warn only when a pillar is missing")
    heart = _warnings("heart_health", ["Dumbbells"])
    assert heart and any("Heart-health" in w for w in heart), heart
    assert not _warnings("heart_health", ["Stationary bike"])

    bone = _warnings("bone_health", ["Stationary bike"])
    assert bone and any("Bone-health" in w for w in bone), bone
    assert not any("Bone-health" in w for w in _warnings("bone_health", ["Bodyweight / no equipment"]))

    metabolic = _warnings("metabolic_health", ["Stationary bike"])
    assert metabolic and any("Metabolic-health" in w for w in metabolic), metabolic

    posture = _warnings("improve_posture", ["Stationary bike"])
    assert posture and any("Posture goals" in w for w in posture), posture
    _ok("health-specific warnings cover cardio, bone, metabolic, and posture promises")


def test_good_goal_equipment_matches_stay_quiet():
    print("\n[test] guardrails: good goal/equipment matches stay quiet")
    quiet_cases = [
        ("build_muscle", ["Dumbbells"]),
        ("build_strength", ["Dumbbells", "Adjustable bench"]),
        ("powerlifting", ["Barbell", "Weight plates", "Power rack", "Flat bench"]),
        ("train_5k", ["Bodyweight / no equipment"]),
        ("cycling_endurance", ["Stationary bike"]),
        ("heart_health", ["Stationary bike"]),
        ("bone_health", ["Bodyweight / no equipment"]),
        ("hyrox", ["Treadmill", "Rowing machine", "Sled", "Dumbbells"]),
    ]
    for goal, equipment in quiet_cases:
        warnings = _warnings(goal, equipment)
        assert not warnings, f"{goal} with {equipment} should not warn: {warnings}"
    _ok(f"{len(quiet_cases)} positive matches verified")


def test_warning_text_is_deduplicated_for_overlapping_rules():
    print("\n[test] guardrails: overlapping rules do not duplicate warning text")
    for goal in ("powerlifting", "hyrox", "metabolic_health", "build_glutes"):
        warnings = _warnings(goal, ["Stationary bike"])
        assert len(warnings) == len(set(warnings)), f"{goal} emitted duplicate warnings: {warnings}"
    _ok("overlapping goal rules emit unique warnings")


def test_profile_guardrails_uses_specific_goal_track_and_saved_equipment():
    print("\n[test] /profile/guardrails: goal_track + UserPreferences equipment feed warnings")
    try:
        from sqlalchemy.pool import StaticPool
        from sqlmodel import Session, SQLModel, create_engine, select

        from app.enums import Gender, GoalPace, GoalType
        from app.models import CoachMemory, User, UserGoal, UserPreferences, UserProfile
        from app.routers import profile as profile_router
    except ModuleNotFoundError as exc:
        if exc.name in {"sqlalchemy", "sqlmodel", "fastapi"}:
            print(f"  ~ skipped profile route integration ({exc.name} unavailable in host env)")
            return
        raise

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP INDEX IF EXISTS ix_user_goal_active_unique")
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX ix_user_goal_active_unique "
            "ON user_goals (user_id) WHERE is_active = 1"
        )

    with Session(engine) as session:
        user = User(
            id=901,
            email="guardrail-track@test.thallo",
            username="guardrail_track",
            hashed_password="x",
        )
        session.add(user)
        session.add(UserProfile(
            user_id=901,
            weight_lbs=180,
            height_feet=5,
            height_inches=10,
            age=31,
            gender=Gender.MALE,
        ))
        session.add(UserGoal(
            user_id=901,
            goal_type=GoalType.ENDURANCE,
            goal_track="train_5k",
            pace=GoalPace.MODERATE,
            is_active=True,
        ))
        session.add(UserPreferences(
            user_id=901,
            days_per_week=4,
            workout_duration_minutes=60,
            equipment=["Stationary bike"],
            foods_available=["chicken breast"],
        ))
        session.commit()

        response = profile_router.get_guardrails(current_user=user, session=session)
        warnings = response["warnings"]
        assert any("Running goals need running exposure" in w for w in warnings), warnings

        memory = session.exec(
            select(CoachMemory).where(CoachMemory.user_id == 901)
        ).all()
        assert memory, "warning response should write guardrail memory"
        assert any(
            "Running goals need running exposure" in w
            for row in memory
            for w in (row.details or {}).get("warnings", [])
        ), "guardrail memory should include the same warning"
    _ok("profile guardrails use goal_track and saved equipment")


def test_guardrails_cover_known_goal_ids_without_crashing():
    print("\n[test] guardrails: all known frontend goals produce deterministic warnings")
    known_goals = [
        "build_muscle", "lean_bulk", "gain_weight", "improve_aesthetics",
        "build_glutes", "build_upper_body", "build_lower_body", "build_arms",
        "build_shoulders", "body_recomp", "maintain_physique", "lose_fat",
        "get_lean", "cut", "preserve_muscle_cutting", "build_strength",
        "increase_overall", "improve_1rm", "powerlifting", "improve_squat",
        "improve_bench", "improve_deadlift", "improve_ohp", "improve_pullups",
        "improve_grip", "functional_strength", "explosive_strength",
        "relative_strength", "improve_cardio", "improve_conditioning",
        "aerobic_base", "improve_vo2", "increase_stamina", "running_fitness",
        "train_5k", "train_10k", "train_half", "train_marathon", "sprint_speed",
        "interval_perf", "hiking_endurance", "cycling_endurance", "rowing_endurance",
        "swimming_endurance", "work_capacity", "improve_athleticism",
        "improve_speed", "improve_agility", "improve_power", "improve_vertical",
        "improve_acceleration", "improve_cod", "improve_coordination",
        "improve_balance", "sport_performance", "offseason_training",
        "inseason_maintenance", "return_to_sport", "hyrox", "general_health",
        "longevity", "healthy_aging", "heart_health", "metabolic_health",
        "improve_energy", "daily_function", "stay_active", "maintain_mobility",
        "improve_mobility", "improve_flexibility", "improve_posture", "bone_health",
        "joint_health", "stress_exercise", "build_consistency", "beginner_fitness",
        "get_back_in_shape", "quick_workouts", "busy_schedule", "home_fitness",
        "travel_training", "minimal_equipment", "habit_building", "sustainable_routine",
    ]
    snapshots = {
        goal: _warnings(goal, ["Stationary bike"])
        for goal in known_goals
    }
    assert set(snapshots) == set(known_goals)
    for goal, warnings in snapshots.items():
        assert isinstance(warnings, list), f"{goal} returned non-list warnings"
        assert all(isinstance(w, str) and w for w in warnings), f"{goal} emitted an invalid warning: {warnings}"
    _ok(f"{len(known_goals)} known goal ids checked")


cases = [
    test_strength_bike_only_warns_but_dumbbells_do_not,
    test_strength_bands_warn_as_light_resistance,
    test_barbell_specific_goals_require_complete_setup,
    test_muscle_gain_bike_only_warns_about_progressive_overload,
    test_goal_focus_specific_muscle_warnings,
    test_preserve_muscle_cutting_warns_without_resistance,
    test_specific_endurance_modality_warnings,
    test_speed_power_and_hyrox_warnings,
    test_health_longevity_specific_warnings,
    test_good_goal_equipment_matches_stay_quiet,
    test_warning_text_is_deduplicated_for_overlapping_rules,
    test_profile_guardrails_uses_specific_goal_track_and_saved_equipment,
    test_guardrails_cover_known_goal_ids_without_crashing,
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
