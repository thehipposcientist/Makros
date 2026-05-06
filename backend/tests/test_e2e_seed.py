"""E2E seed data contract tests."""
from __future__ import annotations

from datetime import date, timedelta

from sqlmodel import Session, col, select

from tests._seed_helpers import make_seed_test_engine


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _approx_minutes_for_day(day: dict) -> float:
    import re

    total = 0.0
    for ex in day.get("exercises", []):
        sets = int(ex.get("sets", 0) or 0)
        reps = str(ex.get("reps", "") or "")
        rest = int(ex.get("rest_seconds", ex.get("restSeconds", 60)) or 60)
        if "min" in reps:
            match = re.search(r"(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*min", reps)
            if match:
                total += float(match.group(2) or match.group(1))
                continue
        try:
            rep_count = int(reps.split("-")[-1].split(" ")[0].strip())
            total += (rep_count * 3 * sets + rest * max(0, sets - 1)) / 60
        except (ValueError, IndexError):
            total += 2.0
    return total


def test_e2e_seed_creates_full_idempotent_personas() -> None:
    print("\n[test] E2E seed: full personas are idempotent and app-ready")
    from app.auth import verify_password
    from app.e2e_seed import E2E_LEGAL_VERSION, seed_e2e_data
    from app.models import (
        ActivityFeedItem,
        DailyRollup,
        Friendship,
        GearItem,
        Meal,
        NutritionPlan,
        PlanDay,
        PlanWeek,
        SavedMeal,
        User,
        UserDayState,
        UserGoal,
        UserPreferences,
        UserProfile,
        UserRollup,
        UserSocialProfile,
        UserSupplementStack,
        WeightEntry,
        WeeklyCheckIn,
        WorkoutCompletion,
        WorkoutPlan,
        WorkoutSession,
    )
    from app.services.workout.focus_normalize import normalize_focus_to_family
    from app.services.workout.weekly_digest import build_weekly_digest

    engine = make_seed_test_engine()
    today = date(2026, 5, 2)
    password = "SeedTest1234"

    with Session(engine) as session:
        first = seed_e2e_data(
            session,
            password=password,
            today=today,
            include_reference_seeds=True,
        )
        seed_e2e_data(
            session,
            password=password,
            today=today,
            include_reference_seeds=True,
        )

        emails = [row["email"] for row in first["users"]]
        users = session.exec(select(User).where(col(User.email).in_(emails))).all()
        assert len(users) == len(emails)
        users_by_email = {user.email: user for user in users}
        user_ids = [int(user.id) for user in users]

        returning = users_by_email["e2e_returning@test.thallo"]
        live_swap_user = users_by_email["e2e_live_swap@test.thallo"]
        long_user = users_by_email["e2e_long@test.thallo"]
        ppl_open_user = users_by_email["e2e_ppl_open@test.thallo"]
        recovery_apply_user = users_by_email["e2e_recovery_apply@test.thallo"]
        activity_nutrition_user = users_by_email["e2e_activity_nutrition@test.thallo"]
        free_user = users_by_email["e2e_free@test.thallo"]
        assert verify_password(password, returning.hashed_password)
        assert returning.subscription_tier == "pro"
        assert returning.terms_version == E2E_LEGAL_VERSION
        assert returning.privacy_version == E2E_LEGAL_VERSION
        assert returning.health_disclaimer_version == E2E_LEGAL_VERSION
        assert returning.ai_disclaimer_version == E2E_LEGAL_VERSION
        assert free_user.subscription_tier == "free"

        for model in (UserProfile, UserGoal, UserPreferences, UserSocialProfile):
            rows = session.exec(select(model).where(col(model.user_id).in_(user_ids))).all()
            assert len(rows) == len(users), f"{model.__name__} rows did not match users"

        active_weeks = session.exec(
            select(PlanWeek).where(col(PlanWeek.user_id).in_([
                returning.id,
                long_user.id,
            ]))
        ).all()
        assert all(row.status == "active" for row in active_weeks)

        returning_week = session.exec(
            select(PlanWeek).where(PlanWeek.user_id == returning.id)
        ).first()
        returning_prefs = session.exec(
            select(UserPreferences).where(UserPreferences.user_id == returning.id)
        ).first()
        assert returning_prefs is not None
        assert returning_prefs.preferred_split == "upper_lower"
        assert returning_week is not None
        assert returning_week.start_date == today
        assert returning_week.end_date == today + timedelta(days=6)
        assert returning_week.days_per_week == 4
        assert returning_week.session_minutes == 60
        assert returning_week.preferred_split == "upper_lower"
        returning_days = session.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == returning_week.id)
            .order_by(PlanDay.day_index)
        ).all()
        assert len(returning_days) == 7
        expected_training_indices = {0, 1, 3, 4}
        for idx, day in enumerate(returning_days):
            assert day.day_index == idx
            assert day.day_date == today + timedelta(days=idx)
            assert day.nutrition_json, f"day {idx} is missing nutrition"
            assert day.is_rest == (idx not in expected_training_indices)
            if idx in expected_training_indices:
                assert day.workout_json, f"training day {idx} is missing workout"
                assert day.workout_json.get("focus"), f"training day {idx} is missing focus"
                assert day.workout_json.get("exercises"), f"training day {idx} is missing exercises"
            else:
                assert day.workout_json is None

        live_swap_week = session.exec(
            select(PlanWeek).where(PlanWeek.user_id == live_swap_user.id)
        ).first()
        assert live_swap_week is not None
        live_swap_today = session.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == live_swap_week.id)
            .where(PlanDay.day_index == 0)
        ).first()
        assert live_swap_today is not None
        assert live_swap_today.workout_json is not None
        live_swap_exercises = live_swap_today.workout_json.get("exercises") or []
        assert live_swap_exercises[0]["name"] == "Dumbbell Bench Press"
        assert live_swap_exercises[0]["targetWeightLbs"] == 120

        long_week = session.exec(
            select(PlanWeek).where(PlanWeek.user_id == long_user.id)
        ).first()
        assert long_week is not None
        assert long_week.session_minutes == 90
        long_days = session.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == long_week.id)
            .where(PlanDay.is_rest == False)  # noqa: E712
        ).all()
        assert long_days
        assert max(_approx_minutes_for_day(day.workout_json or {}) for day in long_days) >= 60

        assert session.exec(select(WorkoutPlan).where(WorkoutPlan.user_id == returning.id)).first()
        assert session.exec(select(NutritionPlan).where(NutritionPlan.user_id == returning.id)).first()
        assert len(session.exec(select(UserDayState).where(UserDayState.user_id == returning.id)).all()) >= 7
        assert len(session.exec(select(Meal).where(Meal.user_id == returning.id)).all()) >= 17
        assert len(session.exec(select(DailyRollup).where(DailyRollup.user_id == returning.id)).all()) == 7
        returning_rollup = session.exec(select(UserRollup).where(UserRollup.user_id == returning.id)).first()
        assert returning_rollup is not None
        assert returning_rollup.days_logged == 7
        assert returning_rollup.sessions_planned == 4
        assert returning_rollup.sessions_completed == 3
        assert len(session.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == returning.id)).all()) >= 6
        assert len(session.exec(select(WorkoutSession).where(WorkoutSession.user_id == returning.id)).all()) >= 6
        assert len(session.exec(select(WeightEntry).where(WeightEntry.user_id == returning.id)).all()) >= 4
        assert len(session.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == returning.id)).all()) >= 4
        assert len(session.exec(select(SavedMeal).where(SavedMeal.user_id == returning.id)).all()) >= 1
        assert len(session.exec(select(UserSupplementStack).where(UserSupplementStack.user_id == returning.id)).all()) >= 2
        assert len(session.exec(select(GearItem).where(GearItem.user_id == returning.id)).all()) >= 2

        digest = build_weekly_digest(int(returning.id), today=today, db=session)
        assert digest["week_start"] == (today - timedelta(days=6)).isoformat()
        assert digest["week_end"] == today.isoformat()
        assert digest["sessions"]["completed"] == 3
        assert digest["sessions"]["distinct_days"] == 3
        assert digest["sessions"]["planned"] == 4
        assert digest["sessions"]["adherence_pct"] == 75.0
        assert digest["sessions"]["duration_seconds"] == 3 * 60 * 60
        assert digest["sessions"]["focus_distribution"] == {"Upper": 1, "Lower": 1, "Push": 1}
        assert digest["volume"]["total_sets"] == 27
        assert digest["volume"]["volume_load_lbs"] > 0
        assert digest["pr_count"] > 0
        assert digest["nutrition"]["days_logged"] == 7
        assert digest["nutrition"]["avg_calories"] > 1100
        assert digest["nutrition"]["avg_protein_g"] > 110

        from app.services.workout.performance import build_performance_profile
        returning_profiles = build_performance_profile(int(returning.id), session)
        assert "romanian_deadlift" in returning_profiles
        assert returning_profiles["romanian_deadlift"].estimated_1rm_lbs > 0

        assert not session.exec(select(PlanWeek).where(PlanWeek.user_id == free_user.id)).first()
        assert session.exec(select(PlanWeek).where(PlanWeek.user_id == recovery_apply_user.id)).first()

        activity_week = session.exec(
            select(PlanWeek).where(PlanWeek.user_id == activity_nutrition_user.id)
        ).first()
        assert activity_week is not None
        activity_today = session.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == activity_week.id)
            .where(PlanDay.day_index == 0)
        ).first()
        assert activity_today is not None
        assert activity_today.is_rest is True
        assert activity_today.workout_json is None

        ppl_open_week = session.exec(
            select(PlanWeek).where(PlanWeek.user_id == ppl_open_user.id)
        ).first()
        assert ppl_open_week is not None
        ppl_open_days = session.exec(
            select(PlanDay)
            .where(PlanDay.plan_week_id == ppl_open_week.id)
            .where(PlanDay.is_rest == False)  # noqa: E712
            .order_by(PlanDay.day_index)
        ).all()
        ppl_open_families = [
            normalize_focus_to_family(day.workout_json.get("focus") if day.workout_json else None)
            for day in ppl_open_days[:3]
        ]
        assert ppl_open_families == ["legs", "pull", "push"]

        friendships = session.exec(
            select(Friendship).where(
                (Friendship.user_a_id == returning.id) | (Friendship.user_b_id == returning.id)
            )
        ).all()
        assert len(friendships) == 2
        assert all(row.status == "accepted" for row in friendships)

        feed_items = session.exec(
            select(ActivityFeedItem).where(col(ActivityFeedItem.user_id).in_(user_ids))
        ).all()
        assert feed_items

    _ok("stable users, plans, nutrition, history, progress, social, and gate data reseed cleanly")


cases = [test_e2e_seed_creates_full_idempotent_personas]


if __name__ == "__main__":
    failed = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {case.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {case.__name__} ({type(e).__name__}): {e}")
    raise SystemExit(1 if failed else 0)
