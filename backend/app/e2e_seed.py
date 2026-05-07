"""Deterministic E2E seed data for local and staging smoke tests."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import or_
from sqlmodel import Session, col, select

from app.auth import hash_password
from app.enums import EquipmentType, Gender, GoalPace, GoalType, MealSource, MealType, WorkoutSource
from app.models import (
    AIDecision,
    ActivityFeedItem,
    BodyScan,
    ClientTelemetryEvent,
    CoachMemory,
    DailyHealthSnapshot,
    DailyNutritionMetrics,
    DailyRollup,
    ExerciseSet,
    FeedLike,
    Friendship,
    GearItem,
    Meal,
    MealItem,
    NutritionPlan,
    PlanDay,
    PlanJob,
    PlanWeek,
    PlanWeekCheckin,
    RecoveryActivity,
    SavedMeal,
    SleepLog,
    SupplementLog,
    User,
    UserCoachingState,
    UserDayState,
    UserEquipmentProfile,
    UserFlag,
    UserGoal,
    UserPreferences,
    UserProfile,
    UserRecentFood,
    UserRollup,
    UserSocialProfile,
    UserState,
    UserSupplementStack,
    WeeklyCheckIn,
    WeeklyDigestCache,
    WeightEntry,
    WorkoutCompletion,
    WorkoutExercise,
    WorkoutPlan,
    WorkoutSession,
)
from app.seed import seed_equipment, seed_exercises, seed_foods, seed_goals
from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.equipment import resolve_owned_equipment_slugs
from app.services.workout.planner import PlannerInputs, generate_workout_plan
from app.services.workout.week_manager import create_plan_week, default_training_pattern
from app.services.workout.weekly_recipe import PLANNER_VERSION


DEFAULT_E2E_PASSWORD = "SeedTest1234"
E2E_LEGAL_VERSION = os.getenv("E2E_LEGAL_VERSION", "2026-05-06.2")


@dataclass(frozen=True)
class PersonaSpec:
    key: str
    email: str
    username: str
    first_name: str
    last_name: str
    subscription_tier: str
    goal_type: GoalType
    goal_track: str | None
    pace: GoalPace
    target_weight_lbs: float | None
    timeline_weeks: int | None
    birthdate: date
    gender: Gender
    weight_lbs: float
    height_feet: int
    height_inches: int
    days_per_week: int
    session_minutes: int
    preferred_split: str | None
    experience: str
    priority_region: str
    equipment: tuple[str, ...]
    foods_available: tuple[str, ...]
    injuries: tuple[str, ...] = ()
    social_display_name: str | None = None
    share_activity: bool = True
    seed_plan: bool = True

    @property
    def planner_goal(self) -> str:
        return self.goal_track or self.goal_type.value


def e2e_personas() -> tuple[PersonaSpec, ...]:
    return (
        PersonaSpec(
            key="returning",
            email="e2e_returning@test.thallo",
            username="e2e_returning",
            first_name="Riley",
            last_name="Return",
            subscription_tier="pro",
            goal_type=GoalType.FAT_LOSS,
            goal_track="fat_loss",
            pace=GoalPace.MODERATE,
            target_weight_lbs=168,
            timeline_weeks=16,
            birthdate=date(1992, 5, 14),
            gender=Gender.MALE,
            weight_lbs=181,
            height_feet=5,
            height_inches=10,
            days_per_week=4,
            session_minutes=60,
            preferred_split="upper_lower",
            experience="intermediate",
            priority_region="balanced",
            equipment=(
                "Dumbbells",
                "Adjustable bench",
                "Pull-up bar",
                "Resistance bands",
                "Treadmill",
            ),
            foods_available=(
                "Greek yogurt",
                "Chicken breast",
                "Brown rice",
                "Salmon",
                "Sweet potato",
                "Blueberries",
                "Spinach",
                "Protein Powder (Whey)",
            ),
            social_display_name="Riley E2E",
        ),
        PersonaSpec(
            key="live_swap",
            email="e2e_live_swap@test.thallo",
            username="e2e_live_swap",
            first_name="Sam",
            last_name="Swap",
            subscription_tier="pro",
            goal_type=GoalType.MUSCLE_GAIN,
            goal_track="muscle_gain",
            pace=GoalPace.MODERATE,
            target_weight_lbs=188,
            timeline_weeks=20,
            birthdate=date(1991, 8, 22),
            gender=Gender.MALE,
            weight_lbs=180,
            height_feet=5,
            height_inches=11,
            days_per_week=1,
            session_minutes=45,
            preferred_split="upper_lower",
            experience="intermediate",
            priority_region="upper_body",
            equipment=(
                "Dumbbells",
                "Adjustable bench",
                "Pull-up bar",
            ),
            foods_available=(
                "Greek yogurt",
                "Chicken breast",
                "Brown rice",
                "Salmon",
                "Sweet potato",
                "Blueberries",
                "Spinach",
                "Protein Powder (Whey)",
            ),
            social_display_name="Sam Swap E2E",
            share_activity=False,
        ),
        PersonaSpec(
            key="long_session",
            email="e2e_long@test.thallo",
            username="e2e_long",
            first_name="Jordan",
            last_name="Long",
            subscription_tier="pro",
            goal_type=GoalType.MUSCLE_GAIN,
            goal_track="muscle_gain",
            pace=GoalPace.MODERATE,
            target_weight_lbs=192,
            timeline_weeks=20,
            birthdate=date(1989, 9, 3),
            gender=Gender.FEMALE,
            weight_lbs=172,
            height_feet=5,
            height_inches=7,
            days_per_week=5,
            session_minutes=90,
            preferred_split="ppl",
            experience="advanced",
            priority_region="upper_body",
            equipment=(
                "Barbell",
                "Dumbbells",
                "Cable machine",
                "Squat rack",
                "Adjustable bench",
                "Lat pulldown",
                "Leg press",
                "Treadmill",
            ),
            foods_available=(
                "Oats",
                "Eggs",
                "Chicken breast",
                "Ground turkey",
                "Rice",
                "Greek yogurt",
                "Avocado",
                "Banana",
            ),
            social_display_name="Jordan 90",
        ),
        PersonaSpec(
            key="social_a",
            email="e2e_social_a@test.thallo",
            username="e2e_social_a",
            first_name="Casey",
            last_name="Share",
            subscription_tier="pro",
            goal_type=GoalType.STRENGTH,
            goal_track="strength",
            pace=GoalPace.CONSERVATIVE,
            target_weight_lbs=None,
            timeline_weeks=None,
            birthdate=date(1995, 2, 20),
            gender=Gender.NONBINARY,
            weight_lbs=158,
            height_feet=5,
            height_inches=8,
            days_per_week=3,
            session_minutes=45,
            preferred_split="full_body",
            experience="intermediate",
            priority_region="balanced",
            equipment=("Dumbbells", "Pull-up bar", "Yoga mat", "Resistance bands"),
            foods_available=("Tofu", "Lentils", "Rice", "Spinach", "Blueberries"),
            social_display_name="Casey Shares",
        ),
        PersonaSpec(
            key="social_b",
            email="e2e_social_b@test.thallo",
            username="e2e_social_b",
            first_name="Morgan",
            last_name="Friend",
            subscription_tier="pro",
            goal_type=GoalType.ENDURANCE,
            goal_track="endurance",
            pace=GoalPace.MODERATE,
            target_weight_lbs=None,
            timeline_weeks=None,
            birthdate=date(1990, 11, 7),
            gender=Gender.FEMALE,
            weight_lbs=143,
            height_feet=5,
            height_inches=6,
            days_per_week=4,
            session_minutes=50,
            preferred_split="full_body",
            experience="beginner",
            priority_region="lower_body",
            equipment=("Bodyweight / no equipment", "Treadmill", "Dumbbells"),
            foods_available=("Eggs", "Oats", "Salmon", "Sweet potato", "Kale"),
            social_display_name="Morgan Friend",
            share_activity=False,
        ),
        PersonaSpec(
            key="ppl_open",
            email="e2e_ppl_open@test.thallo",
            username="e2e_ppl_open",
            first_name="Parker",
            last_name="Open",
            subscription_tier="pro",
            goal_type=GoalType.MUSCLE_GAIN,
            goal_track="muscle_gain",
            pace=GoalPace.MODERATE,
            target_weight_lbs=185,
            timeline_weeks=18,
            birthdate=date(1991, 4, 9),
            gender=Gender.MALE,
            weight_lbs=176,
            height_feet=5,
            height_inches=11,
            days_per_week=5,
            session_minutes=60,
            preferred_split="ppl",
            experience="intermediate",
            priority_region="balanced",
            equipment=(
                "Barbell",
                "Dumbbells",
                "Squat rack",
                "Adjustable bench",
                "Lat pulldown",
                "Leg press",
            ),
            foods_available=(
                "Oats",
                "Eggs",
                "Chicken breast",
                "Rice",
                "Greek yogurt",
                "Banana",
            ),
            social_display_name="Parker PPL",
            share_activity=False,
        ),
        PersonaSpec(
            key="recovery_apply",
            email="e2e_recovery_apply@test.thallo",
            username="e2e_recovery_apply",
            first_name="Reese",
            last_name="Recover",
            subscription_tier="pro",
            goal_type=GoalType.MUSCLE_GAIN,
            goal_track="muscle_gain",
            pace=GoalPace.MODERATE,
            target_weight_lbs=170,
            timeline_weeks=16,
            birthdate=date(1988, 7, 22),
            gender=Gender.FEMALE,
            weight_lbs=162,
            height_feet=5,
            height_inches=6,
            days_per_week=5,
            session_minutes=60,
            preferred_split="ppl",
            experience="intermediate",
            priority_region="balanced",
            equipment=(
                "Dumbbells",
                "Adjustable bench",
                "Resistance bands",
                "Treadmill",
            ),
            foods_available=(
                "Greek yogurt",
                "Chicken breast",
                "Rice",
                "Sweet potato",
                "Spinach",
            ),
            social_display_name="Reese Recovery",
            share_activity=False,
        ),
        PersonaSpec(
            key="activity_nutrition",
            email="e2e_activity_nutrition@test.thallo",
            username="e2e_activity_nutrition",
            first_name="Avery",
            last_name="Fuel",
            subscription_tier="pro",
            goal_type=GoalType.MUSCLE_GAIN,
            goal_track="muscle_gain",
            pace=GoalPace.MODERATE,
            target_weight_lbs=182,
            timeline_weeks=18,
            birthdate=date(1993, 1, 11),
            gender=Gender.MALE,
            weight_lbs=174,
            height_feet=5,
            height_inches=11,
            days_per_week=3,
            session_minutes=45,
            preferred_split="full_body",
            experience="intermediate",
            priority_region="balanced",
            equipment=(
                "Dumbbells",
                "Adjustable bench",
                "Treadmill",
                "Yoga mat",
            ),
            foods_available=(
                "Oats",
                "Eggs",
                "Chicken breast",
                "Rice",
                "Greek yogurt",
                "Banana",
            ),
            social_display_name="Avery Fuel",
            share_activity=False,
        ),
        PersonaSpec(
            key="free_gate",
            email="e2e_free@test.thallo",
            username="e2e_free",
            first_name="Free",
            last_name="Gate",
            subscription_tier="free",
            goal_type=GoalType.MAINTAIN,
            goal_track="maintain",
            pace=GoalPace.CONSERVATIVE,
            target_weight_lbs=None,
            timeline_weeks=None,
            birthdate=date(1994, 8, 18),
            gender=Gender.PREFER_NOT_TO_SAY,
            weight_lbs=166,
            height_feet=5,
            height_inches=9,
            days_per_week=3,
            session_minutes=45,
            preferred_split="full_body",
            experience="beginner",
            priority_region="balanced",
            equipment=("Bodyweight / no equipment", "Dumbbells"),
            foods_available=("Chicken breast", "Rice", "Broccoli"),
            social_display_name="Free Gate",
            share_activity=False,
            seed_plan=False,
        ),
    )


def seed_reference_data(session: Session) -> None:
    for seed_fn in (seed_equipment, seed_exercises, seed_foods, seed_goals):
        seed_fn(session)


def seed_e2e_data(
    session: Session,
    *,
    password: str | None = None,
    today: date | None = None,
    include_reference_seeds: bool = False,
) -> dict[str, Any]:
    """Create stable local E2E personas and return their credentials."""
    if include_reference_seeds:
        seed_reference_data(session)

    run_today = today or date.today()
    seed_password = password or os.getenv("E2E_SEED_PASSWORD") or DEFAULT_E2E_PASSWORD
    specs = e2e_personas()

    users_by_key: dict[str, User] = {}
    for spec in specs:
        users_by_key[spec.key] = _upsert_user(session, spec, seed_password)
    session.commit()

    user_ids = [int(user.id) for user in users_by_key.values() if user.id is not None]
    _reset_seed_user_data(session, user_ids)
    session.commit()

    for spec in specs:
        _seed_persona(session, users_by_key[spec.key], spec, run_today)
    _seed_social_graph(session, users_by_key, run_today)
    session.commit()

    return {
        "password": seed_password,
        "users": [
            {
                "key": spec.key,
                "email": spec.email,
                "username": spec.username,
                "subscription_tier": spec.subscription_tier,
            }
            for spec in specs
        ],
    }


def _upsert_user(session: Session, spec: PersonaSpec, password: str) -> User:
    now = datetime.now(timezone.utc)
    user = session.exec(select(User).where(User.email == spec.email)).first()
    if user is None:
        user = User(
            email=spec.email,
            username=spec.username,
            hashed_password=hash_password(password),
            created_at=now - timedelta(days=45),
        )
    user.email = spec.email
    user.username = spec.username
    user.first_name = spec.first_name
    user.last_name = spec.last_name
    user.hashed_password = hash_password(password)
    user.is_active = True
    user.account_deleted_at = None
    user.subscription_tier = spec.subscription_tier
    user.terms_accepted_at = user.terms_accepted_at or now
    user.privacy_accepted_at = user.privacy_accepted_at or now
    user.health_disclaimer_accepted_at = user.health_disclaimer_accepted_at or now
    user.ai_disclaimer_accepted_at = user.ai_disclaimer_accepted_at or now
    user.terms_version = E2E_LEGAL_VERSION
    user.privacy_version = E2E_LEGAL_VERSION
    user.health_disclaimer_version = E2E_LEGAL_VERSION
    user.ai_disclaimer_version = E2E_LEGAL_VERSION
    user.email_verified_at = user.email_verified_at or now
    user.recovery_question = "What is your favorite color?"
    user.recovery_answer_hash = hash_password("blue")
    user.plan_cadence_anchor = None
    session.add(user)
    session.flush()
    return user


def _reset_seed_user_data(session: Session, user_ids: list[int]) -> None:
    if not user_ids:
        return

    plan_weeks = session.exec(select(PlanWeek).where(col(PlanWeek.user_id).in_(user_ids))).all()
    plan_week_ids = [row.id for row in plan_weeks if row.id is not None]
    if plan_week_ids:
        _delete_where(session, PlanWeekCheckin, col(PlanWeekCheckin.plan_week_id).in_(plan_week_ids))
        _delete_where(session, PlanDay, col(PlanDay.plan_week_id).in_(plan_week_ids))

    meals = session.exec(select(Meal).where(col(Meal.user_id).in_(user_ids))).all()
    meal_ids = [row.id for row in meals if row.id is not None]
    if meal_ids:
        _delete_where(session, MealItem, col(MealItem.meal_id).in_(meal_ids))

    sessions = session.exec(select(WorkoutSession).where(col(WorkoutSession.user_id).in_(user_ids))).all()
    session_ids = [row.id for row in sessions if row.id is not None]
    if session_ids:
        workout_exercises = session.exec(
            select(WorkoutExercise).where(col(WorkoutExercise.session_id).in_(session_ids))
        ).all()
        workout_exercise_ids = [row.id for row in workout_exercises if row.id is not None]
        if workout_exercise_ids:
            _delete_where(session, ExerciseSet, col(ExerciseSet.workout_exercise_id).in_(workout_exercise_ids))
        for row in workout_exercises:
            session.delete(row)

    stack_rows = session.exec(
        select(UserSupplementStack).where(col(UserSupplementStack.user_id).in_(user_ids))
    ).all()
    stack_ids = [row.id for row in stack_rows if row.id is not None]
    if stack_ids:
        _delete_where(session, SupplementLog, col(SupplementLog.stack_item_id).in_(stack_ids))

    feed_items = session.exec(select(ActivityFeedItem).where(col(ActivityFeedItem.user_id).in_(user_ids))).all()
    feed_item_ids = [row.id for row in feed_items if row.id is not None]
    _delete_where(session, FeedLike, col(FeedLike.user_id).in_(user_ids))
    if feed_item_ids:
        _delete_where(session, FeedLike, col(FeedLike.feed_item_id).in_(feed_item_ids))

    _delete_where(
        session,
        Friendship,
        or_(col(Friendship.user_a_id).in_(user_ids), col(Friendship.user_b_id).in_(user_ids)),
    )

    for model in (
        AIDecision,
        BodyScan,
        ClientTelemetryEvent,
        CoachMemory,
        DailyHealthSnapshot,
        DailyNutritionMetrics,
        DailyRollup,
        GearItem,
        Meal,
        NutritionPlan,
        PlanJob,
        PlanWeekCheckin,
        PlanWeek,
        RecoveryActivity,
        SavedMeal,
        SleepLog,
        SupplementLog,
        UserCoachingState,
        UserDayState,
        UserEquipmentProfile,
        UserFlag,
        UserGoal,
        UserPreferences,
        UserProfile,
        UserRecentFood,
        UserRollup,
        UserSocialProfile,
        UserState,
        UserSupplementStack,
        WeeklyCheckIn,
        WeeklyDigestCache,
        WeightEntry,
        WorkoutCompletion,
        WorkoutPlan,
        WorkoutSession,
    ):
        _delete_where(session, model, col(model.user_id).in_(user_ids))

    for row in feed_items:
        session.delete(row)


def _delete_where(session: Session, model: type, criterion: Any) -> None:
    for row in session.exec(select(model).where(criterion)).all():
        session.delete(row)


def _seed_persona(session: Session, user: User, spec: PersonaSpec, today: date) -> None:
    if user.id is None:
        raise ValueError(f"Seed user has no id: {spec.email}")
    user_id = int(user.id)
    now = datetime.now(timezone.utc)

    session.add(UserProfile(
        user_id=user_id,
        weight_lbs=spec.weight_lbs,
        height_feet=spec.height_feet,
        height_inches=spec.height_inches,
        age=_age_on(spec.birthdate, today),
        birthdate=spec.birthdate,
        gender=spec.gender,
        updated_at=now,
    ))
    session.add(UserGoal(
        user_id=user_id,
        goal_type=spec.goal_type,
        goal_track=spec.goal_track,
        pace=spec.pace,
        target_weight_lbs=spec.target_weight_lbs,
        timeline_weeks=spec.timeline_weeks,
        is_active=True,
        created_at=now - timedelta(days=35),
    ))
    session.add(UserPreferences(
        user_id=user_id,
        days_per_week=spec.days_per_week,
        workout_duration_minutes=spec.session_minutes,
        core_frequency_per_week=2,
        preferred_split=spec.preferred_split,
        equipment=list(spec.equipment),
        equipment_settings={
            "load_unit": "lb",
            "has_adjustable_dumbbells": "Adjustable bench" in spec.equipment,
        },
        foods_available=list(spec.foods_available),
        injuries=list(spec.injuries),
        updated_at=now,
    ))
    session.add(UserCoachingState(
        user_id=user_id,
        calorie_adjustment=-100 if spec.goal_type == GoalType.FAT_LOSS else 0,
        volume_adjustment_pct=0,
        updated_at=now,
    ))
    session.add(UserSocialProfile(
        user_id=user_id,
        display_name=spec.social_display_name,
        share_activity_enabled=spec.share_activity,
        created_at=now - timedelta(days=35),
        updated_at=now,
    ))
    session.add(UserState(
        user_id=user_id,
        state_json={
            "seeded": True,
            "persona": spec.key,
            "lastSeededAt": now.isoformat(),
        },
        updated_at=now,
    ))
    session.flush()

    if spec.seed_plan:
        plan = _seed_plans(session, user, spec, today)
        _seed_day_states(session, user_id, plan["plan_week"], today)
    else:
        _seed_minimal_day_states(session, user_id, today)

    _seed_body_and_health(session, user_id, spec, today)
    _seed_meal_history(session, user_id, today)
    _seed_saved_meals(session, user_id)
    _seed_supplements(session, user_id, today)
    _seed_workout_history(session, user_id, spec, today)
    _seed_gear(session, user_id, today)
    _seed_coaching_rows(session, user_id, spec, today)


def _seed_plans(session: Session, user: User, spec: PersonaSpec, today: date) -> dict[str, Any]:
    user_id = int(user.id)
    equipment_slugs = tuple(sorted(resolve_owned_equipment_slugs(list(spec.equipment))))
    recent_focus_families: tuple[str, ...] = ()
    recent_focus_buckets: tuple[str, ...] = ()
    if spec.key == "ppl_open":
        recent_focus_families = ("push", "pull")
        recent_focus_buckets = ("upper_body", "upper_body")
    inputs = PlannerInputs(
        goal=spec.planner_goal,
        days_per_week=spec.days_per_week,
        session_minutes=spec.session_minutes,
        experience=spec.experience,
        equipment_slugs=equipment_slugs,
        preferred_split=spec.preferred_split,
        priority_region=spec.priority_region,
        injuries=spec.injuries,
        rng_seed=user_id,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        user_age=_age_on(spec.birthdate, today),
    )
    if spec.key == "live_swap":
        workout_days = _live_swap_workout_days()
        workout_plan_json = {"days": workout_days}
    else:
        workout_plan = generate_workout_plan(inputs, SEED_EXERCISES)
        workout_plan_json = workout_plan.get("workout_plan", workout_plan)
        workout_days = workout_plan.get("workout_plan", {}).get("days", [])
    if not workout_days:
        raise RuntimeError(f"Planner produced no days for {spec.email}")

    nutrition_templates = _make_nutrition_templates(spec)
    session.add(WorkoutPlan(
        user_id=user_id,
        planner_version=PLANNER_VERSION,
        goal=spec.planner_goal,
        days_per_week=spec.days_per_week,
        preferred_split=spec.preferred_split,
        plan_json=workout_plan_json,
        is_active=True,
    ))
    session.add(NutritionPlan(
        user_id=user_id,
        planner_version=PLANNER_VERSION,
        goal=spec.planner_goal,
        days_per_week=spec.days_per_week,
        plans_json=json.dumps(nutrition_templates),
        trainer_note="Seeded E2E nutrition plan for returning-user smoke coverage.",
        is_active=True,
    ))
    session.flush()

    if spec.key == "live_swap":
        training_day_pattern = [today.weekday()]
    elif spec.key == "activity_nutrition":
        training_day_pattern = [(today + timedelta(days=offset)).weekday() for offset in (1, 3, 5)]
    elif spec.key == "returning":
        training_day_pattern = [(today + timedelta(days=offset)).weekday() for offset in (0, 1, 3, 4)]
    else:
        training_day_pattern = default_training_pattern(spec.days_per_week)
    plan_week = create_plan_week(
        session,
        user_id,
        start_date=today,
        workout_days=workout_days,
        nutrition_templates=nutrition_templates,
        training_day_pattern=training_day_pattern,
        goal=spec.planner_goal,
        days_per_week=spec.days_per_week,
        preferred_split=spec.preferred_split,
        planner_version=PLANNER_VERSION,
        generation_source="e2e_seed",
        goal_pace=spec.pace.value,
        session_minutes=spec.session_minutes,
    )
    return {"workout_days": workout_days, "plan_week": plan_week}


def _live_swap_workout_days() -> list[dict[str, Any]]:
    return [
        {
            "day": "Live Swap Upper",
            "focus": "Upper",
            "stimulus": "strength",
            "_source_context": "e2e_live_swap",
            "exercises": [
                {
                    "name": "Dumbbell Bench Press",
                    "sets": 3,
                    "reps": "8-12",
                    "restSeconds": 90,
                    "equipment": "dumbbells",
                    "slug": "dumbbell_bench_press",
                    "primary_muscle": "chest",
                    "secondary_muscles": ["triceps", "shoulders"],
                    "is_compound": True,
                    "targetWeightLbs": 120,
                    "weightRecommendationSource": "exact_history",
                    "setScheme": [
                        {
                            "setNumber": 1,
                            "setType": "working",
                            "targetReps": "8-12",
                            "targetRir": 2,
                            "targetWeightLbs": 120,
                            "progressionMode": "load_first",
                        },
                        {
                            "setNumber": 2,
                            "setType": "working",
                            "targetReps": "8-12",
                            "targetRir": 2,
                            "targetWeightLbs": 120,
                            "progressionMode": "load_first",
                        },
                        {
                            "setNumber": 3,
                            "setType": "working",
                            "targetReps": "8-12",
                            "targetRir": 2,
                            "targetWeightLbs": 120,
                            "progressionMode": "load_first",
                        },
                    ],
                },
            ],
        },
    ]


def _seed_day_states(session: Session, user_id: int, plan_week: PlanWeek, today: date) -> None:
    days = session.exec(
        select(PlanDay)
        .where(PlanDay.plan_week_id == plan_week.id)
        .order_by(PlanDay.day_index)
    ).all()
    for day in days:
        checks = {"meal_0": True, "meal_1": True} if day.day_date <= today else {}
        plan = dict(day.nutrition_json or {})
        if day.day_date == today:
            plan["_hydration_oz"] = 48
        session.add(UserDayState(
            user_id=user_id,
            day_key=day.day_date,
            meal_checks=checks,
            nutrition_plan=plan,
            macro_overrides=None,
            updated_at=datetime.now(timezone.utc),
        ))


def _seed_minimal_day_states(session: Session, user_id: int, today: date) -> None:
    for offset in range(3):
        session.add(UserDayState(
            user_id=user_id,
            day_key=today + timedelta(days=offset),
            meal_checks={},
            nutrition_plan=None,
            updated_at=datetime.now(timezone.utc),
        ))


def _seed_body_and_health(session: Session, user_id: int, spec: PersonaSpec, today: date) -> None:
    now = datetime.now(timezone.utc)
    weights = [
        spec.weight_lbs + 2.0,
        spec.weight_lbs + 1.2,
        spec.weight_lbs + 0.6,
        spec.weight_lbs,
    ]
    for idx, weight in enumerate(weights):
        d = today - timedelta(days=(len(weights) - idx - 1) * 7)
        session.add(WeightEntry(
            user_id=user_id,
            entry_date=d,
            weight_lbs=round(weight, 1),
            source="e2e_seed",
            created_at=datetime.combine(d, time(8, 0), timezone.utc),
        ))
        session.add(WeeklyCheckIn(
            user_id=user_id,
            checkin_date=d,
            weight_lbs=round(weight, 1),
            waist_in=33.5 - idx * 0.2,
            body_fat_pct=18.0 - idx * 0.3,
            energy=4,
            sleep=4,
            adherence=4,
            notes="Seeded weekly check-in",
            created_at=datetime.combine(d, time(8, 5), timezone.utc),
        ))

    for offset in range(10):
        d = today - timedelta(days=offset)
        session.add(DailyHealthSnapshot(
            user_id=user_id,
            snapshot_date=d,
            steps=7800 + offset * 120,
            active_energy_kcal=420 + offset * 4,
            workout_minutes=45 if offset in (1, 3, 5) else 0,
            cardio_minutes=22 if offset in (2, 6) else 0,
            zone2_minutes=18 if offset in (2, 6) else 0,
            resting_hr=58 + (offset % 3),
            hrv_ms=62 - (offset % 4),
            vo2_max=43.2,
            weight_lbs=round(spec.weight_lbs + offset * 0.05, 1),
            readiness_score=78 - (offset % 5),
            source="e2e_seed",
            created_at=now - timedelta(days=offset),
            updated_at=now - timedelta(days=offset),
        ))
        session.add(SleepLog(
            user_id=user_id,
            night_date=d,
            total_hours=7.3 - (offset % 3) * 0.2,
            in_bed_minutes=470,
            deep_hours=1.3,
            rem_hours=1.6,
            awake_minutes=18,
            hrv_ms=62 - (offset % 4),
            resting_hr=58 + (offset % 3),
            score=82 - (offset % 6),
            rating="Good",
            mode="personalized",
            source="e2e_seed",
            created_at=now - timedelta(days=offset),
            updated_at=now - timedelta(days=offset),
        ))

    session.add(BodyScan(
        user_id=user_id,
        scan_date=today - timedelta(days=14),
        body_fat_pct=18.4,
        body_fat_range="17-20%",
        muscle_mass="average",
        category="Lean",
        strengths=["Consistent training history", "Balanced upper/lower development"],
        improvements=["Keep protein consistent", "Add zone 2 on rest days"],
        assessment="Seeded scan for E2E progress surfaces.",
        disclaimer="Seeded demo data only.",
        weight_lbs=spec.weight_lbs + 0.8,
        created_at=now - timedelta(days=14),
    ))


def _seed_meal_history(session: Session, user_id: int, today: date) -> None:
    meal_specs = [
        (MealType.BREAKFAST, "Greek yogurt protein bowl", [
            _item("Greek yogurt", 1.5, "cup", 210, 32, 12, 0),
            _item("Blueberries", 0.75, "cup", 63, 1, 16, 0),
            _item("Oats", 0.5, "cup", 150, 5, 27, 3),
        ]),
        (MealType.LUNCH, "Chicken rice bowl", [
            _item("Chicken breast", 6, "oz", 280, 52, 0, 6),
            _item("Brown rice", 1, "cup", 216, 5, 45, 2),
            _item("Spinach", 2, "cup", 14, 2, 2, 0),
        ]),
        (MealType.DINNER, "Salmon sweet potato plate", [
            _item("Salmon", 5, "oz", 300, 34, 0, 18),
            _item("Sweet potato", 1, "medium", 112, 2, 26, 0),
            _item("Broccoli", 1.5, "cup", 82, 6, 16, 1),
        ]),
    ]
    for day_offset in range(7):
        meal_date = today - timedelta(days=day_offset)
        for index, (meal_type, name, items) in enumerate(meal_specs[: 2 + (day_offset % 2)]):
            consumed_at = datetime.combine(meal_date, time(8 + index * 5, 30), timezone.utc)
            meal = Meal(
                user_id=user_id,
                meal_date=meal_date,
                meal_type=meal_type,
                name=name,
                source=MealSource.GENERATED,
                consumed_at=consumed_at,
                created_at=consumed_at,
            )
            session.add(meal)
            session.flush()
            for item in items:
                session.add(MealItem(meal_id=meal.id, **_meal_item_kwargs(item)))
        totals = _sum_items([it for _, _, items in meal_specs for it in items])
        session.add(DailyRollup(
            user_id=user_id,
            day=meal_date,
            kcal=totals["calories"] * 0.8,
            protein_g=totals["protein"] * 0.8,
            carbs_g=totals["carbs"] * 0.8,
            fat_g=totals["fat"] * 0.8,
            meals_logged=2 + (day_offset % 2),
            kcal_target=2200,
            protein_target_g=165,
            session_planned=day_offset in (0, 2, 4),
            session_completed=day_offset in (1, 3, 5),
            session_focus="Upper" if day_offset % 2 else "Lower",
            session_duration_min=52,
            weight_lbs=180 - day_offset * 0.1,
            sleep_h=7.2,
            steps=8500,
            energy=4,
            soreness=2,
            computed_at=datetime.now(timezone.utc),
        ))

    session.add(UserRollup(
        user_id=user_id,
        window_days=7,
        as_of=today,
        kcal_avg=2180,
        kcal_target_delta_pct=-3.5,
        protein_adherence_pct=91,
        days_logged=7,
        adherence_pct=86,
        sessions_planned=4,
        sessions_completed=3,
        session_completion_pct=75,
        weight_ema_lbs=180.6,
        weight_slope_lbs_per_wk=-0.6,
        sleep_avg_h=7.1,
        steps_avg=8350,
        computed_at=datetime.now(timezone.utc),
    ))


def _seed_saved_meals(session: Session, user_id: int) -> None:
    items = [
        _item("Protein Powder (Whey)", 1, "scoop", 120, 25, 3, 2),
        _item("Banana", 1, "medium", 105, 1, 27, 0),
        _item("Greek yogurt", 1, "cup", 140, 20, 8, 0),
    ]
    totals = _sum_items(items)
    session.add(SavedMeal(
        user_id=user_id,
        name="E2E post-workout shake",
        notes="Seeded saved meal",
        total_calories=totals["calories"],
        total_protein_g=totals["protein"],
        total_carbs_g=totals["carbs"],
        total_fat_g=totals["fat"],
        items=[_saved_item_payload(item) for item in items],
        times_logged=3,
        last_logged_at=datetime.now(timezone.utc) - timedelta(days=1),
    ))


def _seed_supplements(session: Session, user_id: int, today: date) -> None:
    stack = [
        UserSupplementStack(
            user_id=user_id,
            custom_name="Creatine monohydrate",
            category="performance",
            goal="strength and lean mass",
            dose_amount=5,
            dose_unit="g",
            frequency="daily",
            timing="morning",
            taken_with_food=True,
            evidence_tier="strong",
            risk_tier="low",
            timing_notes="Any time daily works; consistency matters most.",
        ),
        UserSupplementStack(
            user_id=user_id,
            custom_name="Vitamin D3",
            category="vitamin",
            goal="general health",
            dose_amount=2000,
            dose_unit="IU",
            frequency="daily",
            timing="with_meal",
            taken_with_food=True,
            evidence_tier="moderate",
            risk_tier="low",
        ),
    ]
    for row in stack:
        session.add(row)
        session.flush()
        for offset in range(3):
            session.add(SupplementLog(
                user_id=user_id,
                stack_item_id=row.id,
                taken_at=datetime.combine(today - timedelta(days=offset), time(9, 0), timezone.utc),
                dose_amount=row.dose_amount,
                dose_unit=row.dose_unit,
                skipped=False,
            ))


def _seed_workout_history(session: Session, user_id: int, spec: PersonaSpec, today: date) -> None:
    focus_cycle = ["Upper", "Lower", "Push", "Pull", "Legs", "Full Body"]
    for idx, offset in enumerate((1, 3, 5, 8, 10, 13)):
        d = today - timedelta(days=offset)
        focus = focus_cycle[idx % len(focus_cycle)]
        session_row = WorkoutSession(
            user_id=user_id,
            name=f"{focus} seeded session",
            focus=focus,
            workout_date=d,
            source=WorkoutSource.GENERATED,
            notes="Seeded E2E workout history",
            completed_at=datetime.combine(d, time(18, 0), timezone.utc),
            created_at=datetime.combine(d, time(17, 0), timezone.utc),
        )
        session.add(session_row)
        session.flush()
        exercises_payload = []
        for ex_index, ex_name in enumerate(_history_exercises_for_focus(focus)):
            workout_ex = WorkoutExercise(
                session_id=session_row.id,
                exercise_id=None,
                name=ex_name,
                order_index=ex_index,
                equipment=_equipment_type_for_name(ex_name),
                exercise_slug_snapshot=ex_name.lower().replace(" ", "_"),
                primary_muscle_snapshot="chest" if focus in ("Upper", "Push") else "legs",
                secondary_muscles_snapshot=["triceps", "shoulders"] if focus in ("Upper", "Push") else ["glutes"],
                is_compound_snapshot=ex_index == 0,
                target_reps_text="8-12",
                rest_seconds=90,
            )
            session.add(workout_ex)
            session.flush()
            sets_payload = []
            for set_number in range(1, 4):
                reps = 8 + ((idx + set_number) % 4)
                weight = 45 + ex_index * 20 + idx * 2
                session.add(ExerciseSet(
                    workout_exercise_id=workout_ex.id,
                    set_number=set_number,
                    target_reps_min=8,
                    target_reps_max=12,
                    target_weight_lbs=weight,
                    set_type="working",
                    rpe_target=8,
                    actual_reps=reps,
                    actual_weight_lbs=weight,
                    rpe=8,
                    actual_rir=2,
                    completed=True,
                    completed_at=datetime.combine(d, time(18, set_number * 5), timezone.utc),
                ))
                sets_payload.append({"reps": reps, "weight": weight})
            exercises_payload.append({"name": ex_name, "sets": sets_payload})

        completion = WorkoutCompletion(
            user_id=user_id,
            workout_date=d,
            focus_label=focus,
            duration_seconds=spec.session_minutes * 60,
            stimulus="strength" if focus != "Full Body" else "hypertrophy",
            source_context="e2e_seed",
            activity_category="strength",
            activity_intensity="moderate",
            calories_burned=320,
            resolved_muscle_fatigue={"chest": 0.22, "quads": 0.18, "back": 0.2},
            feeling="good",
            intensity=4,
            soreness_areas=["quads"] if focus in ("Lower", "Legs") else [],
            feedback_notes="Seeded post-workout feedback",
            completed_at=datetime.combine(d, time(18, 50), timezone.utc),
        )
        session.add(completion)
        session.add(ActivityFeedItem(
            user_id=user_id,
            event_type="workout_completed",
            payload={
                "focus": focus,
                "duration_seconds": spec.session_minutes * 60,
                "date": d.isoformat(),
                "exercise_count": len(exercises_payload),
                "exercises": exercises_payload,
            },
            created_at=datetime.combine(d, time(19, 0), timezone.utc),
        ))


def _seed_gear(session: Session, user_id: int, today: date) -> None:
    session.add(GearItem(
        user_id=user_id,
        name="E2E running shoes",
        gear_type="running_shoe",
        purchase_date=today - timedelta(days=75),
        starting_miles=42,
        accumulated_miles=118,
        accumulated_sessions=21,
        is_active=True,
        retirement_threshold_miles=350,
        last_used_at=datetime.now(timezone.utc) - timedelta(days=2),
        auto_track_keywords=["run", "treadmill", "incline walk"],
        notes="Seeded gear item",
    ))
    session.add(GearItem(
        user_id=user_id,
        name="E2E lifting belt",
        gear_type="lifting_belt",
        purchase_date=today - timedelta(days=120),
        starting_miles=0,
        accumulated_miles=0,
        accumulated_sessions=18,
        is_active=True,
        retirement_threshold_sessions=250,
        last_used_at=datetime.now(timezone.utc) - timedelta(days=1),
        auto_track_keywords=["squat", "deadlift"],
        notes="Seeded session-tracked gear",
    ))


def _seed_coaching_rows(session: Session, user_id: int, spec: PersonaSpec, today: date) -> None:
    session.add(UserFlag(
        user_id=user_id,
        key="protein_consistency",
        severity="low",
        value="91% adherence",
        details={"source": "e2e_seed"},
        active_since=today - timedelta(days=7),
        last_evaluated=today,
    ))
    session.add(CoachMemory(
        user_id=user_id,
        event_type="checkin_adjustment",
        summary="Seeded coach memory: user prefers concise strength cues.",
        details={"persona": spec.key},
    ))
    session.add(AIDecision(
        user_id=user_id,
        checkin_type="weekly",
        response_type="small_adjust",
        rationale_key="e2e_seed",
        delta={"volume_adjustment_pct": 0},
        flags_snapshot=[{"key": "protein_consistency", "severity": "low"}],
        message="Keep protein steady and hold training volume this week.",
        accepted=True,
        model="seed",
    ))
    session.add(RecoveryActivity(
        user_id=user_id,
        activity_date=today - timedelta(days=1),
        modality="stretching",
        duration_min=12,
        intensity="easy",
        notes="Seeded recovery log",
    ))


def _seed_social_graph(session: Session, users_by_key: dict[str, User], today: date) -> None:
    returning = users_by_key["returning"]
    social_a = users_by_key["social_a"]
    social_b = users_by_key["social_b"]
    for other in (social_a, social_b):
        a, b = sorted((int(returning.id), int(other.id)))
        session.add(Friendship(
            user_a_id=a,
            user_b_id=b,
            status="accepted",
            requested_by=int(returning.id),
            requested_at=datetime.combine(today - timedelta(days=20), time(12, 0), timezone.utc),
            accepted_at=datetime.combine(today - timedelta(days=19), time(12, 0), timezone.utc),
        ))
    first_feed = session.exec(
        select(ActivityFeedItem)
        .where(ActivityFeedItem.user_id == int(social_a.id))
        .order_by(ActivityFeedItem.created_at.desc())
    ).first()
    if first_feed and first_feed.id is not None:
        session.add(FeedLike(user_id=int(returning.id), feed_item_id=first_feed.id))


def _make_nutrition_templates(spec: PersonaSpec) -> list[dict[str, Any]]:
    base = _targets_for_spec(spec)
    variants = [
        [
            _meal("Greek yogurt power bowl", [
                _item("Greek yogurt", 1.5, "cup", 210, 32, 12, 0),
                _item("Blueberries", 0.75, "cup", 63, 1, 16, 0),
                _item("Oats", 0.5, "cup", 150, 5, 27, 3),
            ]),
            _meal("Chicken rice bowl", [
                _item("Chicken breast", 6, "oz", 280, 52, 0, 6),
                _item("Brown rice", 1, "cup", 216, 5, 45, 2),
                _item("Spinach", 2, "cup", 14, 2, 2, 0),
            ]),
            _meal("Salmon sweet potato plate", [
                _item("Salmon", 5, "oz", 300, 34, 0, 18),
                _item("Sweet potato", 1, "medium", 112, 2, 26, 0),
                _item("Broccoli", 1.5, "cup", 82, 6, 16, 1),
            ]),
        ],
        [
            _meal("Egg and avocado toast", [
                _item("Eggs", 3, "large", 210, 18, 1, 15),
                _item("Whole grain toast", 2, "slice", 220, 9, 38, 4),
                _item("Avocado", 0.5, "whole", 120, 2, 6, 11),
            ]),
            _meal("Turkey quinoa bowl", [
                _item("Ground turkey", 5, "oz", 250, 35, 0, 12),
                _item("Quinoa", 1, "cup", 222, 8, 39, 4),
                _item("Kale", 2, "cup", 66, 5, 13, 1),
            ]),
            _meal("Protein smoothie", [
                _item("Protein Powder (Whey)", 1, "scoop", 120, 25, 3, 2),
                _item("Banana", 1, "medium", 105, 1, 27, 0),
                _item("Greek yogurt", 1, "cup", 140, 20, 8, 0),
            ]),
        ],
        [
            _meal("Oats and whey", [
                _item("Oats", 0.75, "cup", 225, 8, 41, 5),
                _item("Protein Powder (Whey)", 1, "scoop", 120, 25, 3, 2),
                _item("Blueberries", 0.5, "cup", 42, 1, 11, 0),
            ]),
            _meal("Tofu rice plate", [
                _item("Tofu", 6, "oz", 180, 20, 6, 10),
                _item("Rice", 1, "cup", 205, 4, 45, 0),
                _item("Broccoli", 1, "cup", 55, 4, 11, 1),
            ]),
            _meal("Chicken potato dinner", [
                _item("Chicken breast", 6, "oz", 280, 52, 0, 6),
                _item("Sweet potato", 1, "medium", 112, 2, 26, 0),
                _item("Spinach", 2, "cup", 14, 2, 2, 0),
            ]),
        ],
    ]
    templates = []
    for meals in variants:
        templates.append({
            "meals": meals,
            "targets": dict(base),
            "nutritionistNote": "Seeded E2E template with whole-food protein and carbs around training.",
            "supplementStack": [
                {"name": "Creatine monohydrate", "dose": "5 g", "timing": "daily"},
                {"name": "Vitamin D3", "dose": "2000 IU", "timing": "with meal"},
            ],
        })
    return templates


def _targets_for_spec(spec: PersonaSpec) -> dict[str, int]:
    if spec.session_minutes >= 90:
        return {"calories": 2950, "protein": 185, "carbs": 355, "fat": 82}
    if spec.goal_type == GoalType.FAT_LOSS:
        return {"calories": 2150, "protein": 175, "carbs": 215, "fat": 62}
    if spec.goal_type == GoalType.ENDURANCE:
        return {"calories": 2450, "protein": 145, "carbs": 330, "fat": 68}
    return {"calories": 2500, "protein": 165, "carbs": 285, "fat": 78}


def _meal(name: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    totals = _sum_items(items)
    return {
        "meal": name,
        "name": name,
        "items": items,
        "foods": [item["name"] for item in items],
        "amounts": [f'{item["quantity"]} {item["unit"]}' for item in items],
        "calories": totals["calories"],
        "protein": totals["protein"],
        "carbs": totals["carbs"],
        "fat": totals["fat"],
        "fiber": totals["fiber"],
        "instructions": "Prep components ahead and assemble when ready.",
    }


def _item(
    name: str,
    quantity: float,
    unit: str,
    calories: float,
    protein: float,
    carbs: float,
    fat: float,
) -> dict[str, Any]:
    return {
        "name": name,
        "quantity": quantity,
        "unit": unit,
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fat": fat,
        "serving_grams": _serving_grams(quantity, unit),
        "micronutrients": {},
    }


def _sum_items(items: list[dict[str, Any]]) -> dict[str, float]:
    return {
        "calories": round(sum(float(item.get("calories", 0) or 0) for item in items), 1),
        "protein": round(sum(float(item.get("protein", 0) or 0) for item in items), 1),
        "carbs": round(sum(float(item.get("carbs", 0) or 0) for item in items), 1),
        "fat": round(sum(float(item.get("fat", 0) or 0) for item in items), 1),
        "fiber": round(sum(3.0 for _ in items), 1),
    }


def _meal_item_kwargs(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "food_name": item["name"],
        "food_id": item.get("food_id"),
        "serving_id": item.get("serving_id"),
        "quantity": item["quantity"],
        "unit": item["unit"],
        "serving_grams": item.get("serving_grams"),
        "calories": item["calories"],
        "protein_g": item["protein"],
        "carbs_g": item["carbs"],
        "fat_g": item["fat"],
    }


def _saved_item_payload(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "food_name": item["name"],
        "food_id": item.get("food_id"),
        "serving_id": item.get("serving_id"),
        "quantity": item["quantity"],
        "unit": item["unit"],
        "serving_grams": item.get("serving_grams"),
        "calories": item["calories"],
        "protein_g": item["protein"],
        "carbs_g": item["carbs"],
        "fat_g": item["fat"],
    }


def _serving_grams(quantity: float, unit: str) -> float | None:
    unit_l = unit.lower()
    if unit_l in ("g", "gram", "grams"):
        return quantity
    if unit_l == "oz":
        return round(quantity * 28.35, 1)
    if unit_l in ("cup", "cups"):
        return round(quantity * 140, 1)
    if unit_l in ("scoop", "scoops"):
        return round(quantity * 32, 1)
    if unit_l in ("large", "medium", "slice", "whole"):
        return round(quantity * 50, 1)
    return None


def _history_exercises_for_focus(focus: str) -> list[str]:
    lookup = {
        "Upper": ["Dumbbell Bench Press", "One-Arm Dumbbell Row", "Dumbbell Shoulder Press"],
        "Lower": ["Goblet Squat", "Romanian Deadlift", "Walking Lunge"],
        "Push": ["Dumbbell Bench Press", "Dumbbell Shoulder Press", "Triceps Pushdown"],
        "Pull": ["Pull-ups", "Seated Cable Row", "Dumbbell Curl"],
        "Legs": ["Back Squat", "Romanian Deadlift", "Calf Raise"],
        "Full Body": ["Goblet Squat", "Push-up", "One-Arm Dumbbell Row"],
    }
    return lookup.get(focus, lookup["Full Body"])


def _equipment_type_for_name(name: str) -> EquipmentType:
    lower = name.lower()
    if "dumbbell" in lower or "goblet" in lower:
        return EquipmentType.DUMBBELLS
    if "push-up" in lower or "pull-up" in lower or "pull-ups" in lower:
        return EquipmentType.BODYWEIGHT
    if "cable" in lower or "squat" in lower or "deadlift" in lower:
        return EquipmentType.GYM
    return EquipmentType.OTHER


def _age_on(birthdate: date, today: date) -> int:
    years = today.year - birthdate.year
    if (today.month, today.day) < (birthdate.month, birthdate.day):
        years -= 1
    return max(years, 0)
