"""Profile weight sync regression tests.

Covers the Body Measurements path that stores a WeeklyCheckIn for trend
context while leaving UserProfile.weight_lbs as the source-of-truth Body
weight unless the caller explicitly opts into promotion.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.enums import Gender, GoalPace, GoalType
from app.models import (
    DailyHealthSnapshot,
    CycleLog,
    GoalUpsert,
    OnboardingSync,
    PreferencesUpsert,
    ProfileUpsert,
    User,
    UserGoal,
    UserPreferences,
    UserProfile,
    UserState,
    WeightEntry,
    WeeklyCheckIn,
    WeeklyCheckInCreate,
)
from app.routers import profile as profile_router


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


_UNSET = object()


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.exec_driver_sql("DROP INDEX IF EXISTS ix_user_goal_active_unique")
        conn.exec_driver_sql(
            "CREATE UNIQUE INDEX ix_user_goal_active_unique "
            "ON user_goals (user_id) WHERE is_active = 1"
        )
    return eng


def _seed_user_profile(session: Session, user_id: int = 1, weight_lbs: float = 180.0) -> User:
    user = User(
        id=user_id,
        email=f"profile-weight-{user_id}@test.thallo",
        username=f"profile_weight_{user_id}",
        hashed_password="x",
        first_name="Profile",
        last_name="Weight",
    )
    session.add(user)
    session.add(UserProfile(
        user_id=user_id,
        weight_lbs=weight_lbs,
        height_feet=5,
        height_inches=10,
        age=30,
        gender=Gender.MALE,
    ))
    session.add(UserGoal(
        user_id=user_id,
        goal_type=GoalType.BODY_RECOMP,
        goal_track="body_recomp",
        pace=GoalPace.MODERATE,
        is_active=True,
    ))
    session.add(UserPreferences(
        user_id=user_id,
        days_per_week=4,
        workout_duration_minutes=60,
        equipment=["Dumbbells"],
        foods_available=["chicken breast"],
    ))
    session.commit()
    seeded = session.get(User, user_id)
    assert seeded is not None
    return seeded


def _profile_weight(session: Session, user_id: int) -> float:
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
    assert profile is not None
    return profile.weight_lbs


def _onboarding_body(
    *,
    goal_type: GoalType = GoalType.BODY_RECOMP,
    goal_track: str = "body_recomp",
    pace: GoalPace = GoalPace.MODERATE,
    weight_lbs: float = 180.0,
    injuries: list[str] | None = None,
    preferred_split: str | None = None,
    experience_level: str | None = None,
    strength_baselines: dict | None = None,
    cardio_baseline: dict | None = None,
    training_day_pattern: list[int] | None = None,
    workout_manual_mode: bool | None = None,
    meal_manual_mode: bool | None = None,
    custom_macros: dict | None | object = _UNSET,
) -> OnboardingSync:
    preferences = {
        "days_per_week": 4,
        "workout_duration_minutes": 60,
        "preferred_split": preferred_split,
        "equipment": ["Dumbbells"],
        "training_day_pattern": training_day_pattern,
        "foods_available": ["chicken breast"],
        "injuries": injuries or [],
        "experience_level": experience_level,
        "strength_baselines": strength_baselines,
        "cardio_baseline": cardio_baseline,
        "workout_manual_mode": workout_manual_mode,
        "meal_manual_mode": meal_manual_mode,
    }
    if custom_macros is not _UNSET:
        preferences["custom_macros"] = custom_macros
    return OnboardingSync(
        profile=ProfileUpsert(
            weight_lbs=weight_lbs,
            height_feet=5,
            height_inches=10,
            age=30,
            gender=Gender.MALE,
        ),
        goal=GoalUpsert(
            goal_type=goal_type,
            goal_track=goal_track,
            pace=pace,
            target_weight_lbs=None,
            timeline_weeks=None,
        ),
        preferences=PreferencesUpsert(**preferences),
    )


def test_profile_me_returns_dumped_profile_payload():
    """Regression guard for SQLAlchemy expiration after commit.

    /profile/me must return concrete JSON fields, not empty dicts.
    """
    print("\n[test] profile/me: dumped payload survives commit")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=10, weight_lbs=181.5)
        payload = profile_router.get_my_profile(current_user=user, session=session)

    assert payload["profile"]["weight_lbs"] == 181.5
    assert payload["goal"]["goal_track"] == "body_recomp"
    assert payload["preferences"]["days_per_week"] == 4
    assert payload["coaching"]["calorie_adjustment"] == 0
    _ok("profile/me returns concrete profile, goal, preferences, and coaching fields")


def test_profile_me_promotes_latest_weight_entry_before_payload():
    """Profile reads should self-heal if a weight entry is newer than profile.weight_lbs."""
    print("\n[test] profile/me: latest weight entry is promoted before payload")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=11, weight_lbs=181.5)
        session.add(WeightEntry(
            user_id=11,
            entry_date=date.today(),
            weight_lbs=174.2,
            source="manual",
            logged_at=datetime(2026, 5, 5, 9, 15, tzinfo=timezone.utc),
        ))
        session.commit()

        payload = profile_router.get_my_profile(current_user=user, session=session)

        assert payload["profile"]["weight_lbs"] == 174.2
        assert _profile_weight(session, 11) == 174.2
        assert payload["weight_entries"][-1]["weight_lbs"] == 174.2
    _ok("profile/me self-heals profile weight from latest weight log")


def test_onboarding_sync_keeps_unchanged_goal_idempotent():
    """Repeated profile syncs must not create fake UserGoal history rows."""
    print("\n[test] profile/onboarding: unchanged goal is idempotent")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=15, weight_lbs=180.0)

        result = profile_router.sync_onboarding(
            _onboarding_body(weight_lbs=178.5),
            current_user=user,
            session=session,
        )
        goals = session.exec(select(UserGoal).where(UserGoal.user_id == 15)).all()
        active_goals = [g for g in goals if g.is_active]

        assert result["status"] == "ok"
        assert _profile_weight(session, 15) == 178.5
        assert len(goals) == 1, f"unchanged sync inserted duplicate goals: {goals}"
        assert len(active_goals) == 1
    _ok("unchanged sync updates profile without inserting another UserGoal")


def test_onboarding_sync_records_goal_history_only_on_change():
    """A real goal change still creates history and leaves one active row."""
    print("\n[test] profile/onboarding: changed goal records history")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=16, weight_lbs=180.0)

        profile_router.sync_onboarding(
            _onboarding_body(
                goal_type=GoalType.FAT_LOSS,
                goal_track="fat_loss",
                pace=GoalPace.AGGRESSIVE,
            ),
            current_user=user,
            session=session,
        )
        goals = session.exec(select(UserGoal).where(UserGoal.user_id == 16)).all()
        active_goals = [g for g in goals if g.is_active]

        assert len(goals) == 2
        assert len(active_goals) == 1
        assert active_goals[0].goal_type == GoalType.FAT_LOSS
        assert active_goals[0].goal_track == "fat_loss"
        assert any(not g.is_active and g.goal_type == GoalType.BODY_RECOMP for g in goals)
    _ok("changed sync deactivates old goal and inserts exactly one new active goal")


def test_onboarding_sync_updates_planner_preferences():
    """Profile saves must persist planner-visible preferences."""
    print("\n[test] profile/onboarding: split + injuries sync into preferences")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=17, weight_lbs=180.0)
        strength_baselines = {
            "version": 1,
            "lifts": [
                {
                    "key": "bench_press",
                    "exerciseSlug": "barbell_bench_press",
                    "name": "Barbell Bench Press",
                    "weightLbs": 185,
                    "reps": 8,
                }
            ],
        }
        cardio_baseline = {
            "canJog10Min": True,
            "comfortableDurationMin": 25,
            "preferredModes": ["Run", "Bike"],
        }

        profile_router.sync_onboarding(
            _onboarding_body(
                injuries=["knee pain", "shoulder impingement"],
                preferred_split="ppl",
                experience_level="intermediate",
                strength_baselines=strength_baselines,
                cardio_baseline=cardio_baseline,
                training_day_pattern=[1, 3, 5, 6],
            ),
            current_user=user,
            session=session,
        )
        prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 17)).first()

        assert prefs is not None
        assert prefs.injuries == ["knee pain", "shoulder impingement"]
        assert prefs.preferred_split == "ppl"
        assert prefs.experience_level == "intermediate"
        assert prefs.strength_baselines == strength_baselines
        assert prefs.cardio_baseline == cardio_baseline
        assert prefs.training_day_pattern == [1, 3, 5, 6]
    _ok("onboarding sync persists planner-visible split, injuries, baselines, and weekdays")


def test_onboarding_sync_persists_and_clears_custom_macros():
    """Custom macro targets belong in user_preferences, not AsyncStorage."""
    print("\n[test] profile/onboarding: custom macros persist and clear")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=171, weight_lbs=180.0)
        macros = {"calories": 2400, "protein": 180, "carbs": 250, "fat": 70}

        profile_router.sync_onboarding(
            _onboarding_body(custom_macros=macros),
            current_user=user,
            session=session,
        )
        prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 171)).first()
        payload = profile_router.get_my_profile(current_user=user, session=session)
        assert prefs is not None
        assert prefs.custom_macros == macros
        assert payload["preferences"]["custom_macros"] == macros

        profile_router.sync_onboarding(
            _onboarding_body(custom_macros=None),
            current_user=user,
            session=session,
        )
        session.refresh(prefs)
        cleared_payload = profile_router.get_my_profile(current_user=user, session=session)
        assert prefs.custom_macros is None
        assert cleared_payload["preferences"]["custom_macros"] is None
    _ok("custom macro targets are durable profile preferences and can be cleared")


def test_onboarding_sync_manual_mode_respects_tier():
    """Onboarding can seed Pro manual mode without bypassing Free gates."""
    print("\n[test] profile/onboarding: manual mode follows subscription tier")
    eng = _make_engine()
    with Session(eng) as session:
        free_user = _seed_user_profile(session, user_id=18, weight_lbs=180.0)
        profile_router.sync_onboarding(
            _onboarding_body(workout_manual_mode=True, meal_manual_mode=True),
            current_user=free_user,
            session=session,
        )
        free_prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 18)).first()
        assert free_prefs is not None
        assert free_prefs.workout_manual_mode is False
        assert free_prefs.meal_manual_mode is False

        pro_user = _seed_user_profile(session, user_id=19, weight_lbs=181.0)
        pro_user.subscription_tier = "pro"
        session.add(pro_user)
        session.commit()
        profile_router.sync_onboarding(
            _onboarding_body(workout_manual_mode=True, meal_manual_mode=True),
            current_user=pro_user,
            session=session,
        )
        pro_prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 19)).first()
        assert pro_prefs is not None
        assert pro_prefs.workout_manual_mode is True
        assert pro_prefs.meal_manual_mode is True
    _ok("onboarding sync stores manual mode only for Pro users")


def test_user_state_backfills_missing_preferred_split():
    """A returning client can heal missing DB split from cached userProfile."""
    print("\n[test] profile/state: backfills missing preferred split")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=18, weight_lbs=180.0)
        prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 18)).first()
        assert prefs is not None
        prefs.preferred_split = None
        session.add(prefs)
        session.commit()

        profile_router.put_user_state(
            profile_router.UserStateBody(state={
                "userProfile": {
                    "goal": "body_recomp",
                    "preferredSplit": "ppl",
                }
            }),
            current_user=user,
            session=session,
        )

        state = session.exec(select(UserState).where(UserState.user_id == 18)).first()
        refreshed = session.exec(select(UserPreferences).where(UserPreferences.user_id == 18)).first()
        assert state is not None
        assert refreshed is not None
        assert refreshed.preferred_split == "ppl"
    _ok("state sync fills missing split from cached userProfile")


def test_measurement_checkin_does_not_update_profile_weight_when_flag_false():
    """Measurement-only clients can attach profile weight without promoting it."""
    print("\n[test] profile/checkin: measurement-only save does not promote weight")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=20, weight_lbs=180.0)
        body = WeeklyCheckInCreate(
            checkin_date=date(2026, 5, 2),
            weight_lbs=150.0,
            update_profile_weight=False,
            waist_in=32.5,
            body_fat_pct=17.0,
            energy=3,
            sleep=3,
            adherence=3,
        )

        result = profile_router.weekly_checkin(body, current_user=user, session=session)
        row = session.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 20)).first()

        assert result["status"] == "ok"
        assert _profile_weight(session, 20) == 180.0
        assert row is not None
        assert row.weight_lbs == 150.0
        assert row.waist_in == 32.5
        assert row.body_fat_pct == 17.0
    _ok("update_profile_weight=False leaves UserProfile.weight_lbs unchanged")


def test_checkin_defaults_to_updating_profile_weight():
    """Existing weekly-checkin callers keep the historical promotion behavior."""
    print("\n[test] profile/checkin: default save promotes profile weight")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=30, weight_lbs=180.0)
        body = WeeklyCheckInCreate(
            checkin_date=date(2026, 5, 2),
            weight_lbs=176.25,
            energy=4,
            sleep=4,
            adherence=4,
        )

        assert body.update_profile_weight is True
        profile_router.weekly_checkin(body, current_user=user, session=session)
        assert _profile_weight(session, 30) == 176.25
    _ok("omitting update_profile_weight preserves weekly check-in promotion")


def test_checkin_rejects_non_positive_weight():
    """Do not let zero/negative cached values enter profile or check-in storage."""
    print("\n[test] profile/checkin: non-positive weight rejected")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=40, weight_lbs=180.0)
        body = WeeklyCheckInCreate(
            checkin_date=date(2026, 5, 2),
            weight_lbs=0,
            update_profile_weight=False,
            energy=3,
            sleep=3,
            adherence=3,
        )

        try:
            profile_router.weekly_checkin(body, current_user=user, session=session)
            raise AssertionError("expected HTTPException for weight_lbs=0")
        except HTTPException as exc:
            assert exc.status_code == 400
            assert "weight_lbs" in str(exc.detail)

        assert _profile_weight(session, 40) == 180.0
        rows = session.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 40)).all()
        assert rows == []
    _ok("weight_lbs <= 0 is rejected without touching profile/check-ins")


def test_weight_entry_promotes_latest_profile_weight_and_profile_payload():
    """Explicit weight logs update the profile and hydrate /profile/me trend data."""
    print("\n[test] profile/weight-entries: latest log promotes profile + profile/me")
    eng = _make_engine()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=50, weight_lbs=180.0)

        result = profile_router.save_weight_entry(
            profile_router.WeightEntryBody(
                date=date.today().isoformat(),
                weight_lbs=177.4,
                source="manual",
                logged_at=datetime(2026, 5, 5, 14, 35, tzinfo=timezone.utc),
            ),
            current_user=user,
            db=session,
        )
        payload = profile_router.get_my_profile(current_user=user, session=session)

        assert result["status"] == "ok"
        assert _profile_weight(session, 50) == 177.4
        assert payload["profile"]["weight_lbs"] == 177.4
        assert payload["weight_entries"][-1]["weight_lbs"] == 177.4
        assert payload["weight_entries"][-1]["logged_at"].startswith("2026-05-05T14:35:00")
    _ok("manual weight log updates profile and profile payload")


def test_weight_entry_sync_promotes_newest_entry_only():
    """Bulk sync should not let an older history row replace a newer profile weight."""
    print("\n[test] profile/weight-entries/sync: newest entry wins profile weight")
    eng = _make_engine()
    today = date.today()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=51, weight_lbs=180.0)

        profile_router.sync_weight_entries(
            [
                profile_router.WeightEntryBody(
                    date=(today - timedelta(days=1)).isoformat(),
                    weight_lbs=178.0,
                    source="manual",
                    logged_at=datetime(2026, 5, 4, 7, 10, tzinfo=timezone.utc),
                ),
                profile_router.WeightEntryBody(
                    date=today.isoformat(),
                    weight_lbs=176.8,
                    source="watch",
                    logged_at=datetime(2026, 5, 5, 8, 25, tzinfo=timezone.utc),
                ),
            ],
            current_user=user,
            db=session,
        )
        rows = session.exec(select(WeightEntry).where(WeightEntry.user_id == 51)).all()

        assert len(rows) == 2
        assert _profile_weight(session, 51) == 176.8
        assert {r.logged_at.strftime("%Y-%m-%dT%H:%M") for r in rows} == {
            "2026-05-04T07:10",
            "2026-05-05T08:25",
        }
    _ok("bulk weight sync promotes the newest dated entry")


def test_weight_entry_delete_removes_db_row_and_promotes_remaining_latest():
    """Deleting a weight row must persist server-side so login cannot resurrect it."""
    print("\n[test] profile/weight-entries delete: removes row and promotes remaining latest")
    eng = _make_engine()
    today = date.today()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=53, weight_lbs=180.0)
        session.add(WeightEntry(
            user_id=53,
            entry_date=today - timedelta(days=1),
            weight_lbs=178.2,
            source="manual",
            logged_at=datetime(2026, 5, 4, 7, 10, tzinfo=timezone.utc),
        ))
        session.add(WeightEntry(
            user_id=53,
            entry_date=today,
            weight_lbs=176.8,
            source="manual",
            logged_at=datetime(2026, 5, 5, 8, 25, tzinfo=timezone.utc),
        ))
        session.commit()

        result = profile_router.delete_weight_entry(today.isoformat(), current_user=user, db=session)
        rows = session.exec(select(WeightEntry).where(WeightEntry.user_id == 53)).all()

        assert result["deleted"] == 1
        assert len(rows) == 1
        assert rows[0].entry_date == today - timedelta(days=1)
        assert _profile_weight(session, 53) == 178.2
    _ok("delete removes DB weight entry and profile follows remaining latest")


def test_weight_entry_clear_removes_all_rows_without_readding_cache_payloads():
    """Reset history should clear persisted rows; profile weight remains as a standalone current value."""
    print("\n[test] profile/weight-entries clear: removes all persisted rows")
    eng = _make_engine()
    today = date.today()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=54, weight_lbs=180.0)
        session.add(WeightEntry(
            user_id=54,
            entry_date=today - timedelta(days=1),
            weight_lbs=178.2,
            source="manual",
            logged_at=datetime(2026, 5, 4, 7, 10, tzinfo=timezone.utc),
        ))
        session.add(WeightEntry(
            user_id=54,
            entry_date=today,
            weight_lbs=176.8,
            source="manual",
            logged_at=datetime(2026, 5, 5, 8, 25, tzinfo=timezone.utc),
        ))
        session.commit()

        result = profile_router.clear_weight_entries(current_user=user, db=session)
        rows = session.exec(select(WeightEntry).where(WeightEntry.user_id == 54)).all()

        assert result["deleted"] == 2
        assert rows == []
        assert _profile_weight(session, 54) == 180.0
    _ok("clear removes all DB weight entries and leaves profile weight alone")


def test_weight_entry_list_defaults_to_bounded_recent_window():
    """Progress should not hydrate years of weight rows on every entry."""
    print("\n[test] profile/weight-entries: list defaults to bounded recent rows")
    eng = _make_engine()
    today = date.today()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=55, weight_lbs=180.0)
        for i in range(735):
            entry_date = today - timedelta(days=i)
            session.add(WeightEntry(
                user_id=55,
                entry_date=entry_date,
                weight_lbs=180.0 - (i * 0.01),
                source="manual",
                logged_at=datetime.combine(entry_date, datetime.min.time(), tzinfo=timezone.utc),
            ))
        session.commit()

        rows = profile_router.list_weight_entries(
            limit=730,
            since=None,
            before=None,
            current_user=user,
            db=session,
        )
        window = profile_router.list_weight_entries(
            limit=10,
            since=today - timedelta(days=4),
            before=today - timedelta(days=2),
            current_user=user,
            db=session,
        )

    assert len(rows) == 730
    assert rows[0]["date"] == (today - timedelta(days=729)).isoformat()
    assert rows[-1]["date"] == today.isoformat()
    assert [r["date"] for r in window] == [
        (today - timedelta(days=4)).isoformat(),
        (today - timedelta(days=3)).isoformat(),
        (today - timedelta(days=2)).isoformat(),
    ]
    _ok("default limit returns recent chronological rows; since/before narrows window")


def test_cycle_symptom_logs_upsert_by_owner_and_log_date():
    """Period symptom check-ins are DB-canonical and idempotent per user/day."""
    print("\n[test] profile/cycle-logs: upsert is user-scoped and duplicate-safe")
    eng = _make_engine()
    with Session(eng) as session:
        user_one = _seed_user_profile(session, user_id=56, weight_lbs=180.0)
        user_two = _seed_user_profile(session, user_id=57, weight_lbs=150.0)
        log_date = date(2026, 5, 23)

        first = profile_router.save_cycle_symptom_log(
            profile_router.CycleSymptomLogBody(
                date=log_date.isoformat(),
                cycleStartDate="2026-05-21",
                phase="menses",
                dayOfCycle=3,
                cycleLengthDays=28,
                flow="moderate",
                cramps="mild",
                energy="normal",
                action="keep",
                updatedAt=datetime(2026, 5, 23, 9, 0, tzinfo=timezone.utc),
            ),
            current_user=user_one,
            db=session,
        )
        second = profile_router.save_cycle_symptom_log(
            profile_router.CycleSymptomLogBody(
                date=log_date.isoformat(),
                cycleStartDate="2026-05-21",
                phase="menses",
                dayOfCycle=3,
                cycleLengthDays=28,
                flow="heavy",
                cramps="moderate",
                energy="low",
                action="lighter",
                updatedAt=datetime(2026, 5, 23, 10, 0, tzinfo=timezone.utc),
            ),
            current_user=user_one,
            db=session,
        )
        other = profile_router.save_cycle_symptom_log(
            profile_router.CycleSymptomLogBody(
                date=log_date.isoformat(),
                cycleStartDate="2026-05-23",
                phase="menses",
                dayOfCycle=1,
                cycleLengthDays=30,
                flow="light",
                cramps="none",
                energy="high",
                action="keep",
            ),
            current_user=user_two,
            db=session,
        )

        user_one_rows = session.exec(select(CycleLog).where(CycleLog.user_id == user_one.id)).all()
        user_two_rows = session.exec(select(CycleLog).where(CycleLog.user_id == user_two.id)).all()
        listed = profile_router.list_cycle_symptom_logs(
            limit=120,
            since=None,
            before=None,
            current_user=user_one,
            db=session,
        )

        assert first["id"] == second["id"]
        assert other["id"] != second["id"]
        assert len(user_one_rows) == 1
        assert len(user_two_rows) == 1
        assert user_one_rows[0].flow_level == "heavy"
        assert user_one_rows[0].training_action == "lighter"
        assert listed == [second]
    _ok("cycle logs update in place per user/date and do not leak across users")


def test_calorie_ranges_use_latest_weight_and_session_duration():
    """Cut/maintain/bulk card should reflect the newest weigh-in and saved duration."""
    print("\n[test] profile/calorie-ranges: latest weight + session duration")
    from app.services.nutrition.calorie_calculator import CalorieInputs, calculate_reference_ranges

    eng = _make_engine()
    today = date.today()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=52, weight_lbs=180.0)
        prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 52)).first()
        assert prefs is not None
        prefs.workout_duration_minutes = 90
        session.add(prefs)
        session.add(WeightEntry(
            user_id=52,
            entry_date=today,
            weight_lbs=171.2,
            source="manual",
            logged_at=datetime(2026, 5, 5, 9, 15, tzinfo=timezone.utc),
        ))
        session.commit()

        payload = profile_router.get_calorie_ranges(current_user=user, session=session)

    expected = calculate_reference_ranges(CalorieInputs(
        weight_lbs=171.2,
        height_feet=5,
        height_inches=10,
        age=30,
        gender="male",
        training_days_per_week=4,
        session_minutes=90,
    ))
    stale = calculate_reference_ranges(CalorieInputs(
        weight_lbs=180.0,
        height_feet=5,
        height_inches=10,
        age=30,
        gender="male",
        training_days_per_week=4,
        session_minutes=60,
    ))

    assert payload["maintenance_calories"] == expected.maintenance_calories
    assert payload["cut_calories"] == expected.cut_calories
    assert payload["bulk_protein_g"] == expected.bulk_protein_g
    assert payload["maintenance_calories"] != stale.maintenance_calories
    assert payload["source_weight_lbs"] == 171.2
    assert payload["source_weight_kind"] == "manual"
    assert payload["training_days_per_week"] == 4
    assert payload["session_minutes"] == 90
    assert payload["session_duration_label"] == "75-90 min"
    _ok("calorie ranges use latest WeightEntry and persisted workout duration")


def test_calorie_ranges_use_apple_total_energy_maintenance():
    """Reference ranges should match live targets when Apple has basal + active energy."""
    print("\n[test] profile/calorie-ranges: Apple total energy blends into maintenance")

    eng = _make_engine()
    today = date.today()
    with Session(eng) as session:
        user = _seed_user_profile(session, user_id=53, weight_lbs=180.0)
        prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == 53)).first()
        assert prefs is not None
        prefs.days_per_week = 7
        session.add(prefs)
        for i in range(1, 8):
            session.add(DailyHealthSnapshot(
                user_id=53,
                snapshot_date=today - timedelta(days=i),
                basal_energy_kcal=2065,
                active_energy_kcal=717,
                source="apple_health",
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            ))
        session.commit()

        payload = profile_router.get_calorie_ranges(current_user=user, session=session)

    assert payload["formula_maintenance_calories"] > 3000
    assert payload["maintenance_calories"] == 2958
    assert payload["source_tdee_kind"] == "apple_health_blend"
    assert payload["source_tdee_kcal"] == 2782
    assert payload["apple_tdee_kcal"] == 2782
    assert payload["apple_valid_days"] == 7
    assert payload["maintenance_blend"]["apple_weight"] == 0.4
    assert payload["maintenance_blend"]["applied_delta_kcal"] == -118
    assert payload["health_energy_adjustment_kcal"] < 0
    assert payload["bulk_calories"] - payload["maintenance_calories"] == payload["bulk_adjustment_kcal"]
    assert payload["maintenance_calories"] - payload["cut_calories"] == abs(payload["cut_adjustment_kcal"])
    _ok("calorie ranges blend Apple basal + active total instead of replacing formula")


cases = [
    test_profile_me_returns_dumped_profile_payload,
    test_profile_me_promotes_latest_weight_entry_before_payload,
    test_onboarding_sync_keeps_unchanged_goal_idempotent,
    test_onboarding_sync_records_goal_history_only_on_change,
    test_onboarding_sync_updates_planner_preferences,
    test_onboarding_sync_persists_and_clears_custom_macros,
    test_onboarding_sync_manual_mode_respects_tier,
    test_user_state_backfills_missing_preferred_split,
    test_measurement_checkin_does_not_update_profile_weight_when_flag_false,
    test_checkin_defaults_to_updating_profile_weight,
    test_checkin_rejects_non_positive_weight,
    test_weight_entry_promotes_latest_profile_weight_and_profile_payload,
    test_weight_entry_sync_promotes_newest_entry_only,
    test_weight_entry_delete_removes_db_row_and_promotes_remaining_latest,
    test_weight_entry_clear_removes_all_rows_without_readding_cache_payloads,
    test_weight_entry_list_defaults_to_bounded_recent_window,
    test_cycle_symptom_logs_upsert_by_owner_and_log_date,
    test_calorie_ranges_use_latest_weight_and_session_duration,
    test_calorie_ranges_use_apple_total_energy_maintenance,
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
