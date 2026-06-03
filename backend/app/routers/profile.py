import json
import secrets
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field as PydanticField, field_validator
from sqlalchemy import delete, or_, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select
from datetime import datetime, timezone, date, timedelta

from app.database import get_session
from app.entitlements import entitlement_payload, refresh_user_entitlement, require_pro_feature, is_pro
from app.models import (
    User, LegalAcceptanceEvent, ClientTelemetryEvent, AIUsageEvent, BillingEvent, UserProfile, UserGoal, UserPreferences,
    ProfileUpsert, GoalUpsert, PreferencesUpsert, OnboardingSync,
    UserDayState, DayStateUpsert, WeeklyCheckIn, WeeklyCheckInCreate, HealthLabResult, CycleLog, FitnessScoreSnapshot,
    CoachMemory, UserCoachingState, WorkoutCompletion, UserState,
    RecoveryActivity, DailyRollup, UserRollup, UserFlag, PlanJob,
    WorkoutPlan, NutritionPlan,
    WeightEntry, UserCustomExercise, UserCustomExerciseCreate, UserCustomExerciseRead, UserEquipmentProfile,
    UserEquipmentProfileCreate, UserEquipmentProfileRead,
    WorkoutSession, WorkoutExercise, ExerciseSet, Meal, MealItem, BodyScan,
    SavedMeal, SleepLog, DailyHealthSnapshot, DailyStressSummary, DailyLifestyleLog, IntegrationCredential, HealthSourcePreference, ImportBatch, UserSupplementStack,
    SupplementLog, DailyNutritionMetrics, Food, FoodNutrition, FoodServing,
    FoodAlias, UserRecentFood, FoodSubmission, UserSocialProfile, Friendship, UserReport,
    WeeklyDigestCache, ActivityFeedItem, FeedLike, FeedComment, SocialNotification,
    TrainerProfile, TrainerClientRelationship, TrainerClientNote,
    PlanWeek, PlanDay, PlanWeekCheckin, AIDecision, GearItem,
    SunExposureSegment, SunExposureCorrection,
    UserInsightPreferences, ContextInsight, ContextSegment, DailyFeatureSet,
    WorkoutTemplate, WorkoutTemplateBundle, WorkoutTemplateBundleItem,
)
from app.auth import get_current_user, hash_password
from app.field_encryption import FieldEncryptionError, decrypt_json, encrypt_json


class NutritionScoreResponse(BaseModel):
    date: str
    score: float
    adherence: float
    quality: float
    micro: float
    confidence: str
    tags: list[str]
    wins: list[str]
    improvements: list[str]
    likely_gaps: list[str]
    indicators: dict


class NameUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None


class UserStateBody(BaseModel):
    state: dict

    @field_validator('state')
    @classmethod
    def check_size(cls, v):
        # Tightened from 5MB → 1MB. Realistic working blob is 100-500KB;
        # anything bigger usually means history or generated content is
        # leaking into state storage and belongs in its own table.
        import json
        if len(json.dumps(v)) > 1_000_000:  # 1MB hard cap
            raise ValueError('State blob too large (max 1MB)')
        return v


def _dump_model(row):
    return row.model_dump(mode="json")


def _dump_rows(rows):
    return [_dump_model(row) for row in rows]


def _field_was_set(model: object, field_name: str) -> bool:
    fields_set = getattr(model, "model_fields_set", None)
    if fields_set is None:
        fields_set = getattr(model, "__fields_set__", set())
    return field_name in (fields_set or set())


def _dump_user_state_rows(rows):
    dumped = []
    for row in rows:
        item = _dump_model(row)
        try:
            item["state_json"] = decrypt_json(row.state_json)
        except FieldEncryptionError as exc:
            raise HTTPException(status_code=500, detail="Stored state could not be decrypted") from exc
        dumped.append(item)
    return dumped


def _ids(rows) -> list[int]:
    return [r.id for r in rows if getattr(r, "id", None) is not None]


def _custom_exercise_name_key(value: str | None) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _string_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        text = str(item or "").strip()
        key = text.lower()
        if not text or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


CUSTOM_EXERCISE_PROGRAMMING_TAGS = {
    "favorite",
    "warmup",
    "finisher",
    "pump",
    "heavy_friendly",
    "volume_friendly",
    "joint_friendly",
    "unilateral",
    "machine",
}


def _custom_exercise_programming_tags(value) -> list[str]:
    tags: list[str] = []
    for item in _string_list(value):
        tag = item.strip().lower().replace("-", "_").replace(" ", "_")
        if tag not in CUSTOM_EXERCISE_PROGRAMMING_TAGS or tag in tags:
            continue
        tags.append(tag)
    return tags


def _bounded_int(value, fallback: int, *, min_value: int = 0, max_value: int = 9999) -> int:
    try:
        parsed = int(value)
    except Exception:
        return fallback
    return max(min_value, min(max_value, parsed))


def _apply_custom_exercise_body(row: UserCustomExercise, body: UserCustomExerciseCreate) -> UserCustomExercise:
    from app.services.workout.custom_catalog import (
        custom_exercise_equipment_bucket,
        custom_exercise_equipment_slugs,
        custom_exercise_plan_status,
        normalize_custom_muscle,
        normalize_custom_pattern,
    )

    name = str(body.name or "").strip()
    normalized_name = _custom_exercise_name_key(name)
    if not normalized_name:
        raise HTTPException(status_code=422, detail="Exercise name is required")

    row.name = name
    row.normalized_name = normalized_name
    row.primary_muscle = normalize_custom_muscle(body.primary_muscle)
    row.secondary_muscles = [
        m for m in (
            normalize_custom_muscle(item, "")
            for item in _string_list(body.secondary_muscles)
        )
        if m and m != row.primary_muscle
    ]
    row.equipment = str(body.equipment or "").strip()
    incoming_slugs = _string_list(getattr(body, "equipment_slugs", []) or [])
    row.equipment_slugs = incoming_slugs
    row.movement_pattern = normalize_custom_pattern(body.movement_pattern, name, row.primary_muscle)
    exercise_type = str(getattr(body, "exercise_type", None) or "").strip().lower()
    if exercise_type not in {"strength", "cardio", "mobility"}:
        exercise_type = "cardio" if row.movement_pattern == "cardio" else "mobility" if row.movement_pattern == "mobility" else "strength"
    row.exercise_type = exercise_type
    tracking = str(getattr(body, "default_tracking_mode", None) or "").strip().lower()
    row.default_tracking_mode = tracking if tracking in {"reps", "time", "distance", "calories"} else (
        "time" if exercise_type in {"cardio", "mobility"} else "reps"
    )
    row.is_compound = body.is_compound
    row.image_url = str(body.image_url).strip() if body.image_url else None
    row.video_id = str(body.video_id).strip() if body.video_id else None
    row.demo_exercise_db_id = str(body.demo_exercise_db_id).strip() if body.demo_exercise_db_id else None
    row.sets = _bounded_int(body.sets, 3, min_value=1, max_value=20)
    row.reps = str(body.reps or "8-12").strip()[:40] or "8-12"
    row.rest_seconds = _bounded_int(body.rest_seconds, 60, min_value=0, max_value=1200)
    row.description = str(body.description).strip() if body.description else None
    row.form_cues = _string_list(body.form_cues)[:8]
    row.aliases = _string_list(body.aliases)[:8]
    row.programming_tags = _custom_exercise_programming_tags(getattr(body, "programming_tags", []) or [])[:12]
    source = str(body.source or "manual").strip().lower()
    row.source = source if source in {"manual", "ai", "ai_photo", "scan"} else "manual"
    inferred_slugs = custom_exercise_equipment_slugs(row)
    row.equipment_slugs = inferred_slugs
    row.equipment_bucket = (
        str(getattr(body, "equipment_bucket", "") or "").strip().lower()
        or custom_exercise_equipment_bucket(inferred_slugs, row.equipment)
    )
    requested_plan_eligible = (
        bool(body.plan_eligible)
        if body.plan_eligible is not None
        else bool(row.movement_pattern and row.equipment and row.source in {"ai", "ai_photo", "scan"})
    )
    row.plan_eligible = requested_plan_eligible
    confidence = str(getattr(body, "ai_confidence", "") or "").strip().lower()
    if confidence not in {"high", "medium", "low"}:
        confidence = "medium" if row.source in {"ai", "ai_photo", "scan"} else "user_confirmed"
    row.ai_confidence = confidence
    ready, status, _reason = custom_exercise_plan_status(row)
    row.validation_status = status if requested_plan_eligible or ready else "needs_review"
    row.updated_at = datetime.now(timezone.utc)
    return row


class CustomExerciseSyncBody(BaseModel):
    exercises: list[UserCustomExerciseCreate] = PydanticField(default_factory=list)


def _delete_account_owned_rows(session: Session, user_id: int) -> None:
    workout_sessions = session.exec(select(WorkoutSession).where(WorkoutSession.user_id == user_id)).all()
    workout_session_ids = _ids(workout_sessions)
    workout_exercises = (
        session.exec(select(WorkoutExercise).where(WorkoutExercise.session_id.in_(workout_session_ids))).all()
        if workout_session_ids else []
    )
    workout_exercise_ids = _ids(workout_exercises)
    if workout_exercise_ids:
        session.exec(delete(ExerciseSet).where(ExerciseSet.workout_exercise_id.in_(workout_exercise_ids)))
    if workout_session_ids:
        session.exec(delete(WorkoutExercise).where(WorkoutExercise.session_id.in_(workout_session_ids)))
    session.exec(delete(WorkoutSession).where(WorkoutSession.user_id == user_id))

    meals = session.exec(select(Meal).where(Meal.user_id == user_id)).all()
    meal_ids = _ids(meals)
    if meal_ids:
        session.exec(delete(MealItem).where(MealItem.meal_id.in_(meal_ids)))
    session.exec(delete(Meal).where(Meal.user_id == user_id))

    private_foods = session.exec(select(Food).where(Food.owner_user_id == user_id)).all()
    private_food_ids = _ids(private_foods)
    session.exec(delete(FoodSubmission).where(FoodSubmission.user_id == user_id))
    session.exec(delete(UserRecentFood).where(UserRecentFood.user_id == user_id))
    if private_food_ids:
        session.exec(delete(UserRecentFood).where(UserRecentFood.food_id.in_(private_food_ids)))
        session.exec(delete(FoodAlias).where(FoodAlias.food_id.in_(private_food_ids)))
        session.exec(delete(FoodServing).where(FoodServing.food_id.in_(private_food_ids)))
        session.exec(delete(FoodNutrition).where(FoodNutrition.food_id.in_(private_food_ids)))
        session.exec(delete(Food).where(Food.id.in_(private_food_ids)))
    session.exec(delete(UserCustomExercise).where(UserCustomExercise.user_id == user_id))

    feed_items = session.exec(select(ActivityFeedItem).where(ActivityFeedItem.user_id == user_id)).all()
    feed_item_ids = _ids(feed_items)
    friendships = session.exec(
        select(Friendship).where(or_(Friendship.user_a_id == user_id, Friendship.user_b_id == user_id))
    ).all()
    friendship_ids = _ids(friendships)
    if feed_item_ids:
        session.exec(delete(FeedComment).where(FeedComment.feed_item_id.in_(feed_item_ids)))
        session.exec(delete(FeedLike).where(FeedLike.feed_item_id.in_(feed_item_ids)))
        session.exec(
            delete(SocialNotification)
            .where(SocialNotification.subject_type == "feed_item")
            .where(SocialNotification.subject_id.in_(feed_item_ids))
        )
    if friendship_ids:
        session.exec(
            delete(SocialNotification)
            .where(SocialNotification.subject_type == "friendship")
            .where(SocialNotification.subject_id.in_(friendship_ids))
        )
    session.exec(delete(FeedLike).where(FeedLike.user_id == user_id))
    session.exec(delete(FeedComment).where(FeedComment.user_id == user_id))
    session.exec(delete(ActivityFeedItem).where(ActivityFeedItem.user_id == user_id))
    session.exec(delete(SocialNotification).where(or_(SocialNotification.user_id == user_id, SocialNotification.actor_user_id == user_id)))
    session.exec(delete(Friendship).where(or_(Friendship.user_a_id == user_id, Friendship.user_b_id == user_id)))
    session.exec(delete(UserReport).where(or_(UserReport.reporter_id == user_id, UserReport.reported_user_id == user_id)))
    session.exec(delete(UserSocialProfile).where(UserSocialProfile.user_id == user_id))
    session.exec(delete(WeeklyDigestCache))
    trainer_relationships = session.exec(
        select(TrainerClientRelationship).where(
            or_(
                TrainerClientRelationship.trainer_user_id == user_id,
                TrainerClientRelationship.client_user_id == user_id,
            )
        )
    ).all()
    trainer_relationship_ids = _ids(trainer_relationships)
    if trainer_relationship_ids:
        session.exec(
            delete(TrainerClientNote).where(
                TrainerClientNote.relationship_id.in_(trainer_relationship_ids)
            )
        )
    session.exec(
        delete(TrainerClientNote).where(
            or_(
                TrainerClientNote.trainer_user_id == user_id,
                TrainerClientNote.client_user_id == user_id,
                TrainerClientNote.author_user_id == user_id,
            )
        )
    )
    session.exec(
        delete(TrainerClientRelationship).where(
            or_(
                TrainerClientRelationship.trainer_user_id == user_id,
                TrainerClientRelationship.client_user_id == user_id,
            )
        )
    )
    session.exec(delete(TrainerProfile).where(TrainerProfile.user_id == user_id))

    plan_weeks = session.exec(select(PlanWeek).where(PlanWeek.user_id == user_id)).all()
    plan_week_ids = _ids(plan_weeks)
    session.exec(delete(PlanWeekCheckin).where(PlanWeekCheckin.user_id == user_id))
    if plan_week_ids:
        session.exec(delete(PlanDay).where(PlanDay.plan_week_id.in_(plan_week_ids)))
    session.exec(delete(PlanDay).where(PlanDay.user_id == user_id))
    session.exec(delete(PlanWeek).where(PlanWeek.user_id == user_id))

    bundles = session.exec(select(WorkoutTemplateBundle).where(WorkoutTemplateBundle.user_id == user_id)).all()
    bundle_ids = _ids(bundles)
    if bundle_ids:
        session.exec(delete(WorkoutTemplateBundleItem).where(WorkoutTemplateBundleItem.bundle_id.in_(bundle_ids)))
    session.exec(delete(WorkoutTemplateBundle).where(WorkoutTemplateBundle.user_id == user_id))
    session.exec(delete(WorkoutTemplate).where(WorkoutTemplate.user_id == user_id))
    session.exec(
        update(FoodSubmission)
        .where(FoodSubmission.reviewed_by_user_id == user_id)
        .values(reviewed_by_user_id=None)
    )

    for model in (
        LegalAcceptanceEvent, ClientTelemetryEvent, AIUsageEvent, BillingEvent,
        UserProfile, UserGoal, UserPreferences,
        UserCoachingState, UserDayState, SleepLog, HealthLabResult, CycleLog,
        DailyHealthSnapshot, DailyStressSummary, DailyLifestyleLog, FitnessScoreSnapshot, WeeklyCheckIn, CoachMemory, RecoveryActivity,
        DailyRollup, UserRollup, UserFlag, UserState, PlanJob, WorkoutPlan,
        NutritionPlan, BodyScan, WeightEntry, AIDecision, WorkoutCompletion,
        SavedMeal, IntegrationCredential, HealthSourcePreference, ImportBatch, DailyNutritionMetrics, UserEquipmentProfile, GearItem,
        UserSupplementStack, SupplementLog, SunExposureSegment, SunExposureCorrection,
        UserInsightPreferences, ContextInsight, ContextSegment, DailyFeatureSet,
    ):
        session.exec(delete(model).where(model.user_id == user_id))

def _merge_day_nutrition_plan(existing: dict | None, incoming: dict) -> dict:
    merged = dict(incoming)
    if isinstance(existing, dict):
        for key in ("_hydration_oz",):
            if key not in merged and key in existing:
                merged[key] = existing[key]
    return merged

router = APIRouter(prefix="/profile", tags=["profile"])

VALID_PREFERRED_SPLITS = {
    "full_body",
    "upper_lower",
    "ppl",
    "ppl_upper_lower",
    "bro",
}


def _valid_preferred_split(value) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if normalized in VALID_PREFERRED_SPLITS else None


def _preferred_split_from_state(state: dict) -> str | None:
    profile = state.get("userProfile") if isinstance(state, dict) else None
    if isinstance(profile, str):
        try:
            profile = json.loads(profile)
        except Exception:
            return None
    if not isinstance(profile, dict):
        return None
    return _valid_preferred_split(
        profile.get("preferredSplit") or profile.get("preferred_split")
    )


def _backfill_preferred_split_from_state(
    session: Session,
    user_id: int,
    state: dict,
) -> None:
    split = _preferred_split_from_state(state)
    if not split:
        return
    prefs = session.exec(
        select(UserPreferences).where(UserPreferences.user_id == user_id)
    ).first()
    if not prefs:
        return
    existing = _valid_preferred_split(getattr(prefs, "preferred_split", None))
    if existing:
        return
    prefs.preferred_split = split
    prefs.updated_at = datetime.now(timezone.utc)
    session.add(prefs)


def _derive_age(birthdate: date | None, today: date | None = None) -> int | None:
    """Integer age from a birthdate. Returns None when birthdate is None.
    Uses a simple year-diff minus-one-if-birthday-hasn't-happened-yet.
    Centralised so every callsite agrees on the math."""
    if birthdate is None:
        return None
    today = today or date.today()
    years = today.year - birthdate.year
    if (today.month, today.day) < (birthdate.month, birthdate.day):
        years -= 1
    return max(0, years)


class BirthdateUpdate(BaseModel):
    """Soft-prompt backfill: existing users supply just their birthday
    without having to re-enter the rest of their physical stats."""
    birthdate: date


@router.get("/calorie-ranges")
def get_calorie_ranges(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return the cut / maintain / bulk calorie + protein reference targets for the
    signed-in user, calculated from their profile body stats and training
    volume. Used by the EditProfileScreen macros card to show users what
    their three reference targets look like at a glance.

    Returns 404 if the user hasn't completed onboarding yet (no profile).
    """
    from app.services.nutrition.calorie_calculator import (
        CalorieInputs,
        calculate_reference_ranges,
    )
    from app.services.nutrition.targets import resolve_targets_for_user

    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not set up yet")

    prefs = session.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    today = date.today()
    if profile.birthdate is not None:
        fresh_age = _derive_age(profile.birthdate, today)
        if fresh_age is not None and fresh_age != profile.age:
            profile.age = fresh_age
            profile.updated_at = datetime.now(timezone.utc)
            session.add(profile)
            session.commit()

    weight_candidates: list[tuple[date, int, float, str]] = []
    latest_weight = session.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == current_user.id)
        .where(WeightEntry.entry_date <= today)
        .order_by(WeightEntry.entry_date.desc(), WeightEntry.created_at.desc())
    ).first()
    if latest_weight and latest_weight.weight_lbs > 0:
        weight_candidates.append((
            latest_weight.entry_date,
            2,
            float(latest_weight.weight_lbs),
            latest_weight.source or "manual",
        ))
    health_weight = session.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == current_user.id)
        .where(DailyHealthSnapshot.snapshot_date <= today)
        .where(DailyHealthSnapshot.weight_lbs != None)  # noqa: E711
        .order_by(DailyHealthSnapshot.snapshot_date.desc())
    ).first()
    if health_weight and health_weight.weight_lbs and health_weight.weight_lbs > 0:
        weight_candidates.append((
            health_weight.snapshot_date,
            1,
            float(health_weight.weight_lbs),
            "apple_health",
        ))

    source_weight_lbs = float(profile.weight_lbs)
    source_weight_kind = "profile"
    if weight_candidates:
        weight_candidates.sort(key=lambda row: (row[0], row[1]), reverse=True)
        weight_date, _priority, weight_value, weight_source = weight_candidates[0]
        if (today - weight_date).days <= 30:
            source_weight_lbs = weight_value
            source_weight_kind = weight_source

    gender_value = profile.gender.value if hasattr(profile.gender, "value") else str(profile.gender)
    inputs = CalorieInputs(
        weight_lbs=source_weight_lbs,
        height_feet=profile.height_feet,
        height_inches=profile.height_inches,
        age=profile.age,
        gender=gender_value,
        training_days_per_week=prefs.days_per_week if prefs else 3,
        session_minutes=prefs.workout_duration_minutes if prefs else 60,
        lifestyle_activity=getattr(prefs, "lifestyle_activity", None) if prefs else None,
    )
    card = calculate_reference_ranges(inputs)
    formula_maintenance_calories = card.maintenance_calories
    maintenance_calories = card.maintenance_calories
    cut_calories = card.cut_calories
    bulk_calories = card.bulk_calories
    bmr = card.bmr
    activity_multiplier = card.activity_multiplier
    source_tdee_kind = "formula"
    source_tdee_kcal = None
    apple_tdee_kcal = None
    apple_valid_days = 0
    maintenance_blend = None
    health_energy_adjustment_kcal = 0
    health_basal_adjustment_kcal = 0
    resolved = resolve_targets_for_user(session, current_user.id, as_of=today, include_health=True)
    if resolved is not None:
        source_tdee_kind = getattr(resolved, "source_tdee_kind", "formula")
        source_tdee_kcal = getattr(resolved, "source_tdee_kcal", None)
        apple_tdee_kcal = getattr(resolved, "apple_tdee_kcal", None)
        apple_valid_days = int(getattr(resolved, "apple_valid_days", 0) or 0)
        maintenance_blend = getattr(resolved, "maintenance_blend", None)
        health_energy_adjustment_kcal = int(getattr(resolved, "health_energy_adjustment_kcal", 0) or 0)
        health_basal_adjustment_kcal = int(getattr(resolved, "health_basal_adjustment_kcal", 0) or 0)
        health_delta = int(resolved.tdee) - int(card.maintenance_calories)
        if health_delta != 0:
            maintenance_calories += health_delta
            cut_calories += health_delta
            bulk_calories += health_delta
            bmr = int(resolved.bmr)
            activity_multiplier = float(resolved.activity_multiplier)
    return {
        "bmr": bmr,
        "activity_multiplier": activity_multiplier,
        "maintenance_calories": maintenance_calories,
        "formula_maintenance_calories": formula_maintenance_calories,
        "cut_calories": cut_calories,
        "bulk_calories": bulk_calories,
        "cut_protein_g": card.cut_protein_g,
        "maintain_protein_g": card.maintain_protein_g,
        "bulk_protein_g": card.bulk_protein_g,
        "source_weight_lbs": card.weight_lbs,
        "source_weight_kind": source_weight_kind,
        "height_feet": card.height_feet,
        "height_inches": card.height_inches,
        "age": card.age,
        "gender": card.gender,
        "training_days_per_week": card.training_days_per_week,
        "session_minutes": card.session_minutes,
        "session_duration_label": card.session_duration_label,
        "formula": card.formula,
        "activity_level": card.activity_level,
        "cut_adjustment_kcal": card.cut_adjustment_kcal,
        "maintenance_adjustment_kcal": card.maintenance_adjustment_kcal,
        "bulk_adjustment_kcal": card.bulk_adjustment_kcal,
        "source_tdee_kind": source_tdee_kind,
        "source_tdee_kcal": source_tdee_kcal,
        "apple_tdee_kcal": apple_tdee_kcal,
        "apple_valid_days": apple_valid_days,
        "maintenance_blend": maintenance_blend,
        "health_energy_adjustment_kcal": health_energy_adjustment_kcal,
        "health_basal_adjustment_kcal": health_basal_adjustment_kcal,
    }


def _active_goal(session: Session, user_id: int) -> UserGoal | None:
    return session.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()


def _field_value(value):
    return value.value if hasattr(value, "value") else value


def _goal_matches(goal: UserGoal, incoming: GoalUpsert) -> bool:
    return (
        _field_value(goal.goal_type) == _field_value(incoming.goal_type)
        and goal.goal_track == incoming.goal_track
        and _field_value(goal.pace) == _field_value(incoming.pace)
        and goal.target_weight_lbs == incoming.target_weight_lbs
        and goal.timeline_weeks == incoming.timeline_weeks
    )


def _snapshot_goal_baselines(
    session: Session,
    goal: UserGoal,
    *,
    profile: UserProfile | None,
) -> None:
    """Populate start_weight_lbs / start_body_fat_pct / start_scan_id on
    a freshly-created UserGoal. Prefers a recent WeightEntry (≤14d) over
    the cached profile weight; pulls body-fat % only from a BodyScan
    within the last 30d so stale scans don't anchor a new goal."""
    today = date.today()

    latest_weight = session.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == goal.user_id)
        .where(WeightEntry.entry_date >= today - timedelta(days=14))
        .order_by(WeightEntry.entry_date.desc(), WeightEntry.created_at.desc())
    ).first()
    if latest_weight and latest_weight.weight_lbs and latest_weight.weight_lbs > 0:
        goal.start_weight_lbs = float(latest_weight.weight_lbs)
    elif profile and profile.weight_lbs and profile.weight_lbs > 0:
        goal.start_weight_lbs = float(profile.weight_lbs)

    latest_scan = session.exec(
        select(BodyScan)
        .where(BodyScan.user_id == goal.user_id)
        .where(BodyScan.body_fat_pct.is_not(None))
        .where(BodyScan.created_at >= datetime.now(timezone.utc) - timedelta(days=30))
        .order_by(BodyScan.created_at.desc())
    ).first()
    if latest_scan and latest_scan.body_fat_pct and latest_scan.body_fat_pct > 0:
        goal.start_body_fat_pct = float(latest_scan.body_fat_pct)
        goal.start_scan_id = latest_scan.id


def _coaching_state(session: Session, user_id: int) -> UserCoachingState:
    state = session.exec(select(UserCoachingState).where(UserCoachingState.user_id == user_id)).first()
    if state:
        return state
    state = UserCoachingState(user_id=user_id)
    session.add(state)
    session.flush()
    return state


def _write_memory(session: Session, user_id: int, event_type: str, summary: str, details: dict | None = None) -> None:
    session.add(CoachMemory(user_id=user_id, event_type=event_type, summary=summary, details=details))


def _weight_entry_payload(row: WeightEntry) -> dict:
    logged_at = row.logged_at or row.created_at
    return {
        "date": row.entry_date.isoformat(),
        "weight_lbs": row.weight_lbs,
        "source": row.source,
        "logged_at": logged_at.isoformat() if logged_at else None,
    }


def _recent_weight_entries(session: Session, user_id: int, limit: int = 365) -> list[dict]:
    rows = session.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == user_id)
        .order_by(WeightEntry.entry_date.desc(), WeightEntry.created_at.desc())
        .limit(limit)
    ).all()
    return [_weight_entry_payload(row) for row in reversed(rows)]


def _promote_latest_weight_entry_to_profile(
    session: Session,
    user_id: int,
    *,
    as_of: date | None = None,
) -> None:
    latest = session.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == user_id)
        .where(WeightEntry.entry_date <= (as_of or date.today()))
        .order_by(WeightEntry.entry_date.desc(), WeightEntry.created_at.desc())
    ).first()
    if not latest or latest.weight_lbs <= 0:
        return

    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == user_id)
    ).first()
    if not profile:
        return

    if profile.weight_lbs != latest.weight_lbs:
        profile.weight_lbs = latest.weight_lbs
        profile.updated_at = datetime.now(timezone.utc)
        session.add(profile)


@router.post("/onboarding")
def sync_onboarding(
    body: OnboardingSync,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Save the user's profile, goal, and preferences in one request.

    Clients also reuse this for profile sync. Keep goal writes idempotent so
    repeated syncs do not turn unchanged goals into fake history rows.
    """
    now = datetime.now(timezone.utc)

    # Upsert physical profile
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    # Age is derived from birthdate when present so it stays accurate
    # years later. If an older client/local cache syncs without birthdate,
    # preserve the existing DB birthday instead of wiping it.
    incoming_birthdate = (
        body.profile.birthdate
        if body.profile.birthdate is not None
        else (profile.birthdate if profile else None)
    )
    derived_age = _derive_age(incoming_birthdate) or body.profile.age
    if derived_age is None:
        raise HTTPException(status_code=422, detail="birthdate or age required")
    if profile:
        profile.weight_lbs    = body.profile.weight_lbs
        profile.height_feet   = body.profile.height_feet
        profile.height_inches = body.profile.height_inches
        profile.age           = derived_age
        profile.birthdate     = incoming_birthdate
        profile.gender        = body.profile.gender
        if body.profile.weight_unit is not None:
            profile.weight_unit = body.profile.weight_unit
        if body.profile.distance_unit is not None:
            profile.distance_unit = body.profile.distance_unit
        if body.profile.height_unit is not None:
            profile.height_unit = body.profile.height_unit
        profile.updated_at    = now
    else:
        profile = UserProfile(
            user_id=current_user.id,
            weight_lbs=body.profile.weight_lbs,
            height_feet=body.profile.height_feet,
            height_inches=body.profile.height_inches,
            age=derived_age,
            birthdate=incoming_birthdate,
            gender=body.profile.gender,
            weight_unit=body.profile.weight_unit,
            distance_unit=body.profile.distance_unit,
            height_unit=body.profile.height_unit,
        )
    session.add(profile)

    # Only create a new history row when the actual goal payload changes.
    prev_goals = session.exec(
        select(UserGoal).where(UserGoal.user_id == current_user.id, UserGoal.is_active == True)
    ).all()
    active_goal = prev_goals[0] if prev_goals else None
    if not active_goal or not _goal_matches(active_goal, body.goal):
        for g in prev_goals:
            g.is_active = False
            session.add(g)
        if prev_goals:
            session.flush()

        # Before creating a brand-new UserGoal row, see if the user has an
        # archived row that matches the incoming payload (goal_type +
        # goal_track). When they do, REACTIVATE it instead of creating a new
        # one — this preserves the original `created_at`, which the client
        # reads as `goalStartedAt` for the Day X/42 label. Without this, a
        # goal-change round-trip ("switch goal, then switch back") resets the
        # user's day count to Day 1 every time.
        archived = session.exec(
            select(UserGoal)
            .where(UserGoal.user_id == current_user.id)
            .where(UserGoal.is_active == False)  # noqa: E712
            .order_by(UserGoal.created_at.desc())
        ).all()
        matched = next((g for g in archived if _goal_matches(g, body.goal)), None)
        if matched is not None:
            matched.is_active = True
            # Allow pace / target / timeline updates without touching the
            # original created_at — _goal_matches only checks identity fields
            # (goal_type + goal_track), so these may legitimately differ.
            for attr in ('pace', 'target_weight_lbs', 'timeline_weeks'):
                incoming = getattr(body.goal, attr, None)
                if incoming is not None:
                    setattr(matched, attr, incoming)
            session.add(matched)
        else:
            new_goal = UserGoal(user_id=current_user.id, **body.goal.model_dump())
            _snapshot_goal_baselines(session, new_goal, profile=profile)
            session.add(new_goal)

    # Upsert preferences
    prefs = session.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if prefs:
        prefs.days_per_week    = body.preferences.days_per_week
        prefs.workout_duration_minutes = body.preferences.workout_duration_minutes
        prefs.core_frequency_per_week = body.preferences.core_frequency_per_week
        prefs.preferred_split  = body.preferences.preferred_split
        # Lifestyle activity — leave alone when the client omits it
        # (older app versions that don't send the field). Empty string
        # is treated as "unset" so a user can clear the value via
        # EditProfile without leaving an orphan empty string.
        incoming_lifestyle = getattr(body.preferences, "lifestyle_activity", None)
        if incoming_lifestyle is not None:
            normalized = str(incoming_lifestyle).strip().lower() or None
            prefs.lifestyle_activity = normalized
        prefs.equipment        = body.preferences.equipment
        prefs.equipment_settings = body.preferences.equipment_settings
        prefs.training_day_pattern = body.preferences.training_day_pattern
        prefs.experience_level = body.preferences.experience_level
        prefs.strength_baselines = body.preferences.strength_baselines
        prefs.cardio_baseline = body.preferences.cardio_baseline
        prefs.foods_available  = body.preferences.foods_available
        prefs.injuries         = body.preferences.injuries
        if body.preferences.workout_manual_mode is not None:
            prefs.workout_manual_mode = bool(body.preferences.workout_manual_mode) if is_pro(current_user) else False
        if body.preferences.meal_manual_mode is not None:
            prefs.meal_manual_mode = bool(body.preferences.meal_manual_mode) if is_pro(current_user) else False
        # Structured injury records — optional. Older clients that only
        # send `injuries` will pass an empty list here, leaving any
        # previously-stored structured data alone.
        if body.preferences.injuries_structured:
            prefs.injuries_structured = body.preferences.injuries_structured
        # Pending imports — same preserve-on-empty semantics. The
        # frontend manages this list (add on onboarding tap, set
        # completed_at when the import finishes, etc.) and may not echo
        # it back on every preferences sync. Empty payload means
        # "leave alone", not "clear."
        if body.preferences.pending_imports:
            prefs.pending_imports = body.preferences.pending_imports
        if body.preferences.kidney_stone_history is not None:
            prefs.kidney_stone_history = body.preferences.kidney_stone_history or "unknown"
            prefs.stone_history_updated_at = now
        if body.preferences.stone_type is not None:
            prefs.stone_type = body.preferences.stone_type or None
            prefs.stone_history_updated_at = now
        if body.preferences.stone_history_source is not None:
            prefs.stone_history_source = body.preferences.stone_history_source or None
            prefs.stone_history_updated_at = now
        for field_name in (
            "reproductive_health_opt_in",
            "cycle_tracking_enabled",
            "trying_to_conceive",
            "pregnancy_status",
            "known_pcos",
            "known_endometriosis",
            "gestational_diabetes_history",
            "glp1_support",
            "sun_exposure_preferences",
        ):
            value = getattr(body.preferences, field_name)
            if value is not None:
                setattr(prefs, field_name, value)
        if _field_was_set(body.preferences, "custom_macros"):
            prefs.custom_macros = body.preferences.custom_macros
        prefs.updated_at       = now
    else:
        preferences_data = body.preferences.model_dump(exclude_none=True)
        if not is_pro(current_user):
            preferences_data.pop("workout_manual_mode", None)
            preferences_data.pop("meal_manual_mode", None)
        if _field_was_set(body.preferences, "custom_macros"):
            preferences_data["custom_macros"] = body.preferences.custom_macros
        prefs = UserPreferences(user_id=current_user.id, **preferences_data)
    session.add(prefs)

    session.commit()
    return {"status": "ok"}


@router.put("/physical-stats")
def update_physical_stats(
    body: ProfileUpsert,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    now = datetime.now(timezone.utc)
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    derived_age = _derive_age(body.birthdate) or body.age
    if derived_age is None:
        raise HTTPException(status_code=422, detail="birthdate or age required")
    profile.weight_lbs    = body.weight_lbs
    profile.height_feet   = body.height_feet
    profile.height_inches = body.height_inches
    profile.age           = derived_age
    profile.birthdate     = body.birthdate if body.birthdate is not None else profile.birthdate
    profile.gender        = body.gender
    if body.weight_unit is not None:
        profile.weight_unit = body.weight_unit
    if body.distance_unit is not None:
        profile.distance_unit = body.distance_unit
    if body.height_unit is not None:
        profile.height_unit = body.height_unit
    profile.updated_at    = now
    session.add(profile)
    session.commit()
    return {"status": "ok"}


@router.put("/birthdate")
def update_birthdate(
    body: BirthdateUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """One-shot backfill: stores birthdate and re-derives the cached age
    so downstream consumers see the right number immediately. Used by the
    HomeScreen soft prompt for users who signed up before birthday
    collection existed."""
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    age = _derive_age(body.birthdate)
    if age is None:
        raise HTTPException(status_code=422, detail="invalid birthdate")
    profile.birthdate  = body.birthdate
    profile.age        = age
    profile.updated_at = datetime.now(timezone.utc)
    session.add(profile)
    session.commit()
    return {"status": "ok", "age": age}


@router.get("/me")
def get_my_profile(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    current_user = refresh_user_entitlement(current_user, session)
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    goal = session.exec(
        select(UserGoal).where(UserGoal.user_id == current_user.id, UserGoal.is_active == True)
    ).first()
    prefs = session.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()

    if not profile or not goal or not prefs:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Re-derive age from birthdate on every read. If the user had a
    # birthday since the last write, the cached int is stale — fix it
    # in place so downstream consumers (TDEE, HR zones, progression)
    # always see the accurate number without needing another write.
    if profile.birthdate is not None:
        fresh_age = _derive_age(profile.birthdate)
        if fresh_age is not None and fresh_age != profile.age:
            profile.age = fresh_age
            profile.updated_at = datetime.now(timezone.utc)
            session.add(profile)

    _promote_latest_weight_entry_to_profile(session, current_user.id)
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    coaching = _coaching_state(session, current_user.id)
    session.add(coaching)
    social_profile = session.exec(
        select(UserSocialProfile).where(UserSocialProfile.user_id == current_user.id)
    ).first()
    custom_exercises = session.exec(
        select(UserCustomExercise)
        .where(UserCustomExercise.user_id == current_user.id)
        .order_by(UserCustomExercise.created_at.desc())
    ).all()
    payload = {
        "profile": _dump_model(profile),
        "goal": _dump_model(goal),
        "preferences": _dump_model(prefs),
        "coaching": _dump_model(coaching),
        "first_name": current_user.first_name,
        "last_name": current_user.last_name,
        **entitlement_payload(current_user),
        "weight_entries": _recent_weight_entries(session, current_user.id),
        "custom_exercises": _dump_rows(custom_exercises),
        "social_profile": _dump_model(social_profile) if social_profile else None,
    }
    session.commit()
    return payload


@router.patch("/name")
def update_name(
    body: NameUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if body.first_name is not None:
        current_user.first_name = body.first_name.strip() or None
    if body.last_name is not None:
        current_user.last_name = body.last_name.strip() or None
    session.add(current_user)
    session.commit()
    return {"first_name": current_user.first_name, "last_name": current_user.last_name}


@router.get("/export")
def export_account_data(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return a JSON account export for the signed-in user.

    This intentionally includes the user's own account, health, workout,
    nutrition, supplement, and social metadata, but excludes password hashes
    and friends' private data.
    """
    uid = current_user.id
    if uid is None:
        raise HTTPException(status_code=401, detail="Invalid user")

    workout_sessions = session.exec(select(WorkoutSession).where(WorkoutSession.user_id == uid)).all()
    workout_session_ids = [w.id for w in workout_sessions if w.id is not None]
    workout_exercises = (
        session.exec(select(WorkoutExercise).where(WorkoutExercise.session_id.in_(workout_session_ids))).all()
        if workout_session_ids else []
    )
    workout_exercise_ids = [e.id for e in workout_exercises if e.id is not None]
    exercise_sets = (
        session.exec(select(ExerciseSet).where(ExerciseSet.workout_exercise_id.in_(workout_exercise_ids))).all()
        if workout_exercise_ids else []
    )

    meals = session.exec(select(Meal).where(Meal.user_id == uid)).all()
    meal_ids = [m.id for m in meals if m.id is not None]
    meal_items = (
        session.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
        if meal_ids else []
    )

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "user": {
            "id": current_user.id,
            "email": current_user.email,
            "username": current_user.username,
            "first_name": current_user.first_name,
            "last_name": current_user.last_name,
            "is_active": current_user.is_active,
            "created_at": current_user.created_at.isoformat(),
            "email_verified_at": current_user.email_verified_at.isoformat() if current_user.email_verified_at else None,
            "terms_accepted_at": current_user.terms_accepted_at.isoformat() if current_user.terms_accepted_at else None,
            "terms_version": current_user.terms_version,
            "privacy_accepted_at": current_user.privacy_accepted_at.isoformat() if current_user.privacy_accepted_at else None,
            "privacy_version": current_user.privacy_version,
            "health_disclaimer_accepted_at": current_user.health_disclaimer_accepted_at.isoformat() if current_user.health_disclaimer_accepted_at else None,
            "health_disclaimer_version": current_user.health_disclaimer_version,
            "ai_disclaimer_accepted_at": current_user.ai_disclaimer_accepted_at.isoformat() if current_user.ai_disclaimer_accepted_at else None,
            "ai_disclaimer_version": current_user.ai_disclaimer_version,
            **entitlement_payload(current_user),
        },
        "legal_acceptance_events": _dump_rows(
            session.exec(
                select(LegalAcceptanceEvent)
                .where(LegalAcceptanceEvent.user_id == uid)
                .order_by(LegalAcceptanceEvent.accepted_at)
            ).all()
        ),
        "profile": _dump_rows(session.exec(select(UserProfile).where(UserProfile.user_id == uid)).all()),
        "goals": _dump_rows(session.exec(select(UserGoal).where(UserGoal.user_id == uid)).all()),
        "preferences": _dump_rows(session.exec(select(UserPreferences).where(UserPreferences.user_id == uid)).all()),
        "custom_exercises": _dump_rows(session.exec(select(UserCustomExercise).where(UserCustomExercise.user_id == uid)).all()),
        "state": _dump_user_state_rows(session.exec(select(UserState).where(UserState.user_id == uid)).all()),
        "plan_weeks": _dump_rows(session.exec(select(PlanWeek).where(PlanWeek.user_id == uid)).all()),
        "plan_days": _dump_rows(session.exec(select(PlanDay).where(PlanDay.user_id == uid)).all()),
        "day_states": _dump_rows(session.exec(select(UserDayState).where(UserDayState.user_id == uid)).all()),
        "workouts": {
            "sessions": _dump_rows(workout_sessions),
            "exercises": _dump_rows(workout_exercises),
            "sets": _dump_rows(exercise_sets),
            "completions": _dump_rows(session.exec(select(WorkoutCompletion).where(WorkoutCompletion.user_id == uid)).all()),
        },
        "nutrition": {
            "meals": _dump_rows(meals),
            "meal_items": _dump_rows(meal_items),
            "saved_meals": _dump_rows(session.exec(select(SavedMeal).where(SavedMeal.user_id == uid)).all()),
        },
        "body": {
            "weight_entries": _dump_rows(session.exec(select(WeightEntry).where(WeightEntry.user_id == uid)).all()),
            "body_scans": _dump_rows(session.exec(select(BodyScan).where(BodyScan.user_id == uid)).all()),
        },
        "health": {
            "sleep_logs": _dump_rows(session.exec(select(SleepLog).where(SleepLog.user_id == uid)).all()),
            "daily_health_snapshots": _dump_rows(session.exec(select(DailyHealthSnapshot).where(DailyHealthSnapshot.user_id == uid)).all()),
            "health_source_preferences": _dump_rows(session.exec(select(HealthSourcePreference).where(HealthSourcePreference.user_id == uid)).all()),
            "daily_stress_summaries": _dump_rows(session.exec(select(DailyStressSummary).where(DailyStressSummary.user_id == uid)).all()),
            "daily_lifestyle_logs": _dump_rows(session.exec(select(DailyLifestyleLog).where(DailyLifestyleLog.user_id == uid)).all()),
            "context_insight_preferences": _dump_rows(session.exec(select(UserInsightPreferences).where(UserInsightPreferences.user_id == uid)).all()),
            "context_insights": _dump_rows(session.exec(select(ContextInsight).where(ContextInsight.user_id == uid)).all()),
            "context_segments": _dump_rows(session.exec(select(ContextSegment).where(ContextSegment.user_id == uid)).all()),
            "daily_feature_sets": _dump_rows(session.exec(select(DailyFeatureSet).where(DailyFeatureSet.user_id == uid)).all()),
        },
        "supplements": {
            "stack": _dump_rows(session.exec(select(UserSupplementStack).where(UserSupplementStack.user_id == uid)).all()),
            "logs": _dump_rows(session.exec(select(SupplementLog).where(SupplementLog.user_id == uid)).all()),
        },
        "coaching": {
            "state": _dump_rows(session.exec(select(UserCoachingState).where(UserCoachingState.user_id == uid)).all()),
            "memory": _dump_rows(session.exec(select(CoachMemory).where(CoachMemory.user_id == uid)).all()),
            "ai_decisions": _dump_rows(session.exec(select(AIDecision).where(AIDecision.user_id == uid)).all()),
            "weekly_checkins": _dump_rows(session.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == uid)).all()),
        },
        "equipment": _dump_rows(session.exec(select(UserEquipmentProfile).where(UserEquipmentProfile.user_id == uid)).all()),
        "gear": _dump_rows(session.exec(select(GearItem).where(GearItem.user_id == uid)).all()),
        "social": {
            "profile": _dump_rows(session.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == uid)).all()),
            "friendships": _dump_rows(session.exec(select(Friendship).where(or_(Friendship.user_a_id == uid, Friendship.user_b_id == uid))).all()),
            "activity_feed_items": _dump_rows(session.exec(select(ActivityFeedItem).where(ActivityFeedItem.user_id == uid)).all()),
            "feed_likes": _dump_rows(session.exec(select(FeedLike).where(FeedLike.user_id == uid)).all()),
        },
        "trainer": {
            "profile": _dump_rows(session.exec(select(TrainerProfile).where(TrainerProfile.user_id == uid)).all()),
            "relationships": _dump_rows(
                session.exec(
                    select(TrainerClientRelationship).where(
                        or_(
                            TrainerClientRelationship.trainer_user_id == uid,
                            TrainerClientRelationship.client_user_id == uid,
                        )
                    )
                ).all()
            ),
            "notes": _dump_rows(
                session.exec(
                    select(TrainerClientNote).where(
                        or_(
                            TrainerClientNote.trainer_user_id == uid,
                            TrainerClientNote.client_user_id == uid,
                            TrainerClientNote.author_user_id == uid,
                        )
                    )
                ).all()
            ),
        },
    }


@router.delete("/account")
def delete_account(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Delete user-created account data and anonymize login identifiers."""
    uid = current_user.id
    if uid is None:
        raise HTTPException(status_code=401, detail="Invalid user")

    now = datetime.now(timezone.utc)
    suffix = f"{uid}-{int(now.timestamp())}"
    _delete_account_owned_rows(session, uid)

    current_user.is_active = False
    current_user.account_deleted_at = now
    current_user.email = f"deleted+{suffix}@deleted.thallo.local"
    current_user.username = f"deleted_user_{suffix}"
    current_user.first_name = None
    current_user.last_name = None
    current_user.hashed_password = hash_password(secrets.token_urlsafe(32))
    current_user.recovery_question = None
    current_user.recovery_answer_hash = None
    current_user.apple_sub = None
    current_user.google_sub = None
    current_user.email_verified_at = None
    current_user.email_verification_token_hash = None
    current_user.email_verification_expires_at = None
    current_user.password_reset_token_hash = None
    current_user.password_reset_expires_at = None
    current_user.plan_cadence_anchor = None
    current_user.subscription_tier = "free"
    # NULL — not "deleted": the ck_user_subscription_status_values CHECK
    # constraint only permits the known lifecycle values (free/trialing/
    # active/cancelled/…) or NULL. A deleted account has no subscription
    # status, and every other subscription_* field is cleared below.
    current_user.subscription_status = None
    current_user.subscription_source = None
    current_user.subscription_product_id = None
    current_user.subscription_entitlement_id = None
    current_user.subscription_store = None
    current_user.subscription_environment = None
    current_user.subscription_expires_at = None
    current_user.trial_started_at = None
    current_user.trial_ends_at = None
    current_user.revenuecat_original_app_user_id = None
    current_user.revenuecat_original_transaction_id = None

    session.add(current_user)
    session.commit()
    return {"status": "deleted", "deleted_user_id": uid, "data_deleted": True}


@router.get("/day-state/{day_key}")
def get_day_state(
    day_key: date,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    state = session.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id, UserDayState.day_key == day_key)
    ).first()
    if not state:
        return {
            "day_key": day_key,
            "skipped_focus": None,
            "skip_reason": None,
            "meal_checks": {},
            "nutrition_plan": None,
            "nutrition_log_status": None,
            "nutrition_log_status_source": None,
            "nutrition_log_status_updated_at": None,
            "macro_overrides": None,
            "pain_present": None,
            "pain_body_part": None,
            "pain_side": None,
            "pain_severity_0_10": None,
            "soreness_body_part": None,
            "soreness_severity_0_10": None,
            "pain_note": None,
            "onset_context": None,
        }
    return state


@router.put("/day-state/{day_key}")
def upsert_day_state(
    day_key: date,
    body: DayStateUpsert,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    now = datetime.now(timezone.utc)
    state = session.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id, UserDayState.day_key == day_key)
        .with_for_update()
    ).first()
    if state:
        # Patch semantics — only update fields the caller actually passed.
        # `None` means "leave existing value alone". `clear_skipped_focus`
        # is the explicit way to null out skipped_focus (since `None` on
        # `skipped_focus` is otherwise indistinguishable from "no patch").
        if body.clear_skipped_focus:
            state.skipped_focus = None
        elif body.skipped_focus is not None:
            state.skipped_focus = body.skipped_focus
        if body.clear_skip_reason:
            state.skip_reason = None
        elif body.skip_reason is not None:
            state.skip_reason = body.skip_reason.strip() or None
        if body.meal_checks is not None:
            state.meal_checks = body.meal_checks
        if body.nutrition_plan is not None:
            state.nutrition_plan = _merge_day_nutrition_plan(state.nutrition_plan, body.nutrition_plan)
        if body.clear_nutrition_log_status:
            from app.services.nutrition.day_completeness import set_user_day_nutrition_status
            set_user_day_nutrition_status(state, None)
        elif body.nutrition_log_status is not None:
            from app.services.nutrition.day_completeness import (
                VALID_NUTRITION_LOG_STATUSES,
                normalize_nutrition_log_status,
                set_user_day_nutrition_status,
            )
            normalized = normalize_nutrition_log_status(body.nutrition_log_status)
            if normalized not in VALID_NUTRITION_LOG_STATUSES:
                raise HTTPException(status_code=422, detail="Invalid nutrition_log_status")
            set_user_day_nutrition_status(state, normalized, source=body.nutrition_log_status_source)
        if body.macro_overrides is not None:
            state.macro_overrides = body.macro_overrides
        for field_name in (
            "pain_present",
            "pain_body_part",
            "pain_side",
            "pain_severity_0_10",
            "soreness_body_part",
            "soreness_severity_0_10",
            "pain_note",
            "onset_context",
        ):
            value = getattr(body, field_name)
            if value is not None:
                setattr(state, field_name, value)
        state.updated_at = now
    else:
        state = UserDayState(
            user_id=current_user.id,
            day_key=day_key,
            skipped_focus=None if body.clear_skipped_focus else body.skipped_focus,
            skip_reason=None if body.clear_skip_reason else ((body.skip_reason or "").strip() or None),
            meal_checks=body.meal_checks or {},
            nutrition_plan=body.nutrition_plan,
            macro_overrides=body.macro_overrides,
            pain_present=body.pain_present,
            pain_body_part=body.pain_body_part,
            pain_side=body.pain_side,
            pain_severity_0_10=body.pain_severity_0_10,
            soreness_body_part=body.soreness_body_part,
            soreness_severity_0_10=body.soreness_severity_0_10,
            pain_note=body.pain_note,
            onset_context=body.onset_context,
            updated_at=now,
        )
        if not body.clear_nutrition_log_status and body.nutrition_log_status is not None:
            from app.services.nutrition.day_completeness import (
                VALID_NUTRITION_LOG_STATUSES,
                normalize_nutrition_log_status,
                set_user_day_nutrition_status,
            )
            normalized = normalize_nutrition_log_status(body.nutrition_log_status)
            if normalized not in VALID_NUTRITION_LOG_STATUSES:
                raise HTTPException(status_code=422, detail="Invalid nutrition_log_status")
            set_user_day_nutrition_status(state, normalized, source=body.nutrition_log_status_source)
    session.add(state)
    session.commit()
    try:
        from app.services.readiness.compute import invalidate_readiness_cache
        invalidate_readiness_cache(current_user.id)
    except Exception:
        pass
    return {"status": "ok"}


@router.post("/checkin")
def weekly_checkin(
    body: WeeklyCheckInCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if body.energy < 1 or body.energy > 5 or body.sleep < 1 or body.sleep > 5 or body.adherence < 1 or body.adherence > 5:
        raise HTTPException(status_code=400, detail="energy, sleep, and adherence must be 1-5")
    if body.weight_lbs <= 0:
        raise HTTPException(status_code=400, detail="weight_lbs must be positive")

    profile = session.exec(select(UserProfile).where(UserProfile.user_id == current_user.id)).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    previous = session.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == current_user.id)
        .order_by(WeeklyCheckIn.checkin_date.desc())
    ).first()

    # Save check-in. Measurement-only clients can attach the profile's
    # current weight for trend context without changing the profile itself.
    entry_payload = body.model_dump(exclude={"update_profile_weight"})
    entry = WeeklyCheckIn(user_id=current_user.id, **entry_payload)
    if body.update_profile_weight:
        profile.weight_lbs = body.weight_lbs
        profile.updated_at = datetime.now(timezone.utc)

    state = _coaching_state(session, current_user.id)
    cal_delta = 0
    vol_delta = 0

    if previous:
        weight_change = body.weight_lbs - previous.weight_lbs
        readiness = (body.energy + body.sleep + body.adherence) / 3
        if readiness <= 2.3:
            cal_delta += 100
            vol_delta -= 10
        elif readiness >= 4.3 and body.adherence >= 4:
            vol_delta += 5

        goal = _active_goal(session, current_user.id)
        if goal and goal.goal_type.value == "fat_loss":
            # If weight not dropping over a week, nudge deficit
            if weight_change >= -0.1:
                cal_delta -= 100
            # If dropping too fast, soften deficit
            if weight_change <= -2.0:
                cal_delta += 100

    state.calorie_adjustment = max(-400, min(400, state.calorie_adjustment + cal_delta))
    state.volume_adjustment_pct = max(-30, min(20, state.volume_adjustment_pct + vol_delta))
    state.updated_at = datetime.now(timezone.utc)

    _write_memory(
        session,
        current_user.id,
        "checkin_adjustment",
        f"Weekly check-in applied: calories {cal_delta:+d}, volume {vol_delta:+d}%",
        {
            "date": str(body.checkin_date),
            "weight_lbs": body.weight_lbs,
            "energy": body.energy,
            "sleep": body.sleep,
            "adherence": body.adherence,
            "calorie_adjustment_total": state.calorie_adjustment,
            "volume_adjustment_total": state.volume_adjustment_pct,
        },
    )

    session.add(entry)
    session.add(profile)
    session.add(state)
    session.commit()

    return {
        "status": "ok",
        "applied": {
            "calorie_adjustment": cal_delta,
            "volume_adjustment_pct": vol_delta,
        },
        "totals": {
            "calorie_adjustment": state.calorie_adjustment,
            "volume_adjustment_pct": state.volume_adjustment_pct,
        },
    }


@router.get("/insights")
def get_insights(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    today = date.today()
    start_7 = today - timedelta(days=6)

    completions = session.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == current_user.id)
        .where(WorkoutCompletion.workout_date >= start_7)
    ).all()
    done_days = len({c.workout_date for c in completions})

    day_states = session.exec(
        select(UserDayState)
        .where(UserDayState.user_id == current_user.id)
        .where(UserDayState.day_key >= start_7)
    ).all()
    total_checks = 0
    checked = 0
    for s in day_states:
        checks = s.meal_checks or {}
        total_checks += len(checks)
        checked += sum(1 for _, v in checks.items() if bool(v))

    checkins = session.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == current_user.id)
        .order_by(WeeklyCheckIn.checkin_date)
    ).all()
    weight_trend = []
    for c in checkins[-8:]:
        weight_trend.append({"date": str(c.checkin_date), "weight_lbs": c.weight_lbs})

    return {
        "adherence": {
            "workout_7d_pct": round((done_days / 7) * 100, 1),
            "meal_7d_pct": round((checked / total_checks) * 100, 1) if total_checks else None,
        },
        "weight_trend": weight_trend,
    }


@router.get("/guardrails")
def get_guardrails(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    profile = session.exec(select(UserProfile).where(UserProfile.user_id == current_user.id)).first()
    goal = _active_goal(session, current_user.id)
    prefs = session.exec(select(UserPreferences).where(UserPreferences.user_id == current_user.id)).first()
    coaching = _coaching_state(session, current_user.id)

    warnings: list[str] = []
    if prefs and (prefs.days_per_week < 1 or prefs.days_per_week > 7):
        warnings.append("Training days should be between 1 and 7.")
    if profile and profile.weight_lbs < 90:
        warnings.append("Current weight appears very low; double-check profile input.")
    if goal and goal.target_weight_lbs is not None and profile:
        if abs(goal.target_weight_lbs - profile.weight_lbs) > 80:
            warnings.append("Target weight is far from current weight. Consider a staged target.")
    if abs(coaching.calorie_adjustment) > 300:
        warnings.append("Calorie adjustment is high. Review recent check-ins for accuracy.")
    if goal and prefs:
        from app.services.workout.goals import effective_goal_id
        from app.services.workout.goal_equipment_guardrails import goal_equipment_warnings

        warnings.extend(goal_equipment_warnings(
            effective_goal_id(goal),
            getattr(prefs, "equipment", None),
        ))

    if warnings:
        _write_memory(
            session,
            current_user.id,
            "guardrail",
            "Guardrail warnings raised",
            {"warnings": warnings},
        )
        session.commit()

    return {"warnings": warnings}


@router.get("/coach-memory")
def get_coach_memory(
    limit: int = 10,
    current_user: User = Depends(require_pro_feature("Coach history")),
    session: Session = Depends(get_session),
):
    clamped = max(1, min(50, limit))
    entries = session.exec(
        select(CoachMemory)
        .where(CoachMemory.user_id == current_user.id)
        .order_by(CoachMemory.created_at.desc())
        .limit(clamped)
    ).all()
    return entries


# ──────────────────────────────────────────────────────────────────────────────
@router.get("/nutrition-score", response_model=NutritionScoreResponse)
def get_nutrition_score(
    current_user: User = Depends(require_pro_feature("Nutrition scoring")),
    session: Session = Depends(get_session),
):
    """Compute today's nutrition score from DailyRollup + food quality data."""
    from app.models import DailyRollup
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
        compute_overall_health_score, compute_weekly_trend,
    )
    from app.services.workout.goals import effective_goal_id

    today = date.today()
    goal = "body_recomp"  # default
    try:
        active_goal = session.exec(
            select(UserGoal).where(UserGoal.user_id == current_user.id, UserGoal.is_active == True)
        ).first()
        if active_goal:
            goal = effective_goal_id(active_goal)
    except Exception:
        pass

    # Get today's rollup
    rollup = session.exec(
        select(DailyRollup)
        .where(DailyRollup.user_id == current_user.id, DailyRollup.day == today)
    ).first()

    if not rollup:
        # No data today — return neutral score
        empty = compute_nutrition_score(NutritionIndicators(), goal=goal)
        return {
            "date": today.isoformat(),
            "score": empty.total,
            "adherence": empty.adherence_score,
            "quality": empty.quality_score,
            "micro": empty.micro_score,
            "confidence": "low",
            "tags": [],
            "wins": [],
            "improvements": ["Start logging meals to track your nutrition"],
            "likely_gaps": [],
            "indicators": empty.indicators,
        }

    # Build indicators from rollup
    indicators = NutritionIndicators(
        calories_logged=rollup.kcal or 0,
        calories_target=rollup.kcal_target or 0,
        protein_logged=rollup.protein_g or 0,
        protein_target=rollup.protein_target_g or 0,
        meals_logged=rollup.meals_logged or 0,
    )

    score = compute_nutrition_score(indicators, goal=goal)
    return {
        "date": today.isoformat(),
        "score": score.total,
        "adherence": score.adherence_score,
        "quality": score.quality_score,
        "micro": score.micro_score,
        "confidence": score.confidence,
        "tags": score.tags,
        "wins": score.wins,
        "improvements": score.improvements,
        "likely_gaps": score.likely_gaps,
        "indicators": score.indicators,
    }


# Client-state JSON blob — cross-device sync.
#
# Client pushes the union of its AsyncStorage keys as a single JSON dict;
# backend stores it opaquely. On sign-in or device switch the client pulls
# it back and re-hydrates AsyncStorage. Gives us cross-device state without
# modeling every client-side concept as a column.
# ──────────────────────────────────────────────────────────────────────────────


@router.get("/state")
def get_user_state(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(UserState).where(UserState.user_id == current_user.id)
    ).first()
    try:
        state = decrypt_json(row.state_json) if row else {}
    except FieldEncryptionError as exc:
        raise HTTPException(status_code=500, detail="Stored state could not be decrypted") from exc
    return {
        "state": state,
        "updated_at": (row.updated_at.isoformat() if row and row.updated_at else None),
    }


@router.put("/state")
def put_user_state(
    body: UserStateBody,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(UserState).where(UserState.user_id == current_user.id)
    ).first()
    now = datetime.now(timezone.utc)
    try:
        encrypted_state = encrypt_json(body.state)
    except FieldEncryptionError as exc:
        raise HTTPException(status_code=503, detail="State encryption is not configured") from exc
    if row:
        row.state_json = encrypted_state
        row.updated_at = now
    else:
        row = UserState(user_id=current_user.id, state_json=encrypted_state, updated_at=now)
    session.add(row)
    _backfill_preferred_split_from_state(session, current_user.id, body.state)
    try:
        session.commit()
    except IntegrityError:
        if row.id is not None:
            session.rollback()
            raise
        session.rollback()
        row = session.exec(
            select(UserState).where(UserState.user_id == current_user.id)
        ).first()
        if row is None:
            raise
        row.state_json = encrypted_state
        row.updated_at = now
        session.add(row)
        _backfill_preferred_split_from_state(session, current_user.id, body.state)
        session.commit()
    return {"ok": True, "updated_at": now.isoformat()}


# ─── Adaptive macro recommendations ──────────────────────────────────────────

class AdaptiveMacroRequest(BaseModel):
    """Client may send local weight history; the server also folds in
    persisted WeightEntry rows and Apple Health weight snapshots."""
    weight_entries: list[dict] = []   # [{date: "YYYY-MM-DD", weight_lbs: float}, ...]


@router.post("/adaptive-macros")
def adaptive_macros(
    body: AdaptiveMacroRequest,
    current_user: User = Depends(require_pro_feature("Nutrition insights")),
    session: Session = Depends(get_session),
):
    """Return the weekly-check-in payload: estimated maintenance, the
    user's current target, and the suggested new target with reasoning
    + confidence. Deterministic — no AI. Client decides whether to
    apply the suggested target."""
    from app.services.nutrition.adaptive_macros import (
        compute_adaptive_recommendation,
    )
    from app.services.nutrition.targets import resolve_targets_for_user

    goal = _active_goal(session, current_user.id)
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()

    # Parse dates coming in as ISO strings.
    from datetime import date as _d
    entries_parsed: list[dict] = []
    entries_by_date: dict[_d, float] = {}
    for e in body.weight_entries or []:
        try:
            d = _d.fromisoformat(str(e.get("date") or "").strip())
            w = float(e.get("weight_lbs") or 0)
            if w > 0:
                entries_by_date[d] = w
        except (ValueError, TypeError):
            continue

    cutoff = date.today() - timedelta(days=60)
    for row in session.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == current_user.id)
        .where(WeightEntry.entry_date >= cutoff)
    ).all():
        if row.weight_lbs and row.weight_lbs > 0:
            entries_by_date[row.entry_date] = float(row.weight_lbs)

    for row in session.exec(
        select(DailyHealthSnapshot)
        .where(DailyHealthSnapshot.user_id == current_user.id)
        .where(DailyHealthSnapshot.snapshot_date >= cutoff)
        .where(DailyHealthSnapshot.weight_lbs != None)  # noqa: E711
    ).all():
        if row.weight_lbs and row.weight_lbs > 0:
            entries_by_date.setdefault(row.snapshot_date, float(row.weight_lbs))

    entries_parsed = [
        {"date": d, "weight_lbs": w}
        for d, w in sorted(entries_by_date.items(), key=lambda item: item[0])
    ]

    resolved = resolve_targets_for_user(session, current_user.id) if profile else None
    current_target = resolved.calories if resolved else None
    goal_bucket = resolved.bucket_name if resolved else (
        goal.goal_type.value if goal and hasattr(goal.goal_type, "value") else str(goal.goal_type) if goal else None
    )

    rec = compute_adaptive_recommendation(
        session, current_user.id,
        profile_goal=goal_bucket,
        current_target_kcal=current_target,
        weight_entries=entries_parsed,
    )
    action = None
    if rec.status == "ok" and rec.delta is not None and abs(rec.delta) >= 25:
        action = {"type": "adjust_calorie_target", "delta": rec.delta}
    return {
        "status": rec.status,
        "estimated_tdee": rec.estimated_tdee,
        "current_target": rec.current_target,
        "suggested_target": rec.suggested_target,
        "delta": rec.delta,
        "avg_daily_calories": rec.avg_daily_calories,
        "weekly_weight_change_lbs": rec.weekly_weight_change_lbs,
        "days_logged": rec.days_logged,
        "weigh_ins": rec.weigh_ins,
        "confidence": rec.confidence,
        "reason": rec.reason,
        "goal_bucket": rec.goal_bucket,
        "action": action,
    }


# ─── Weight Entries ───────────────────────────────────────────────────────────

class WeightEntryBody(BaseModel):
    date: str
    weight_lbs: float
    source: str = "manual"
    logged_at: datetime | None = None


class CycleSymptomLogBody(BaseModel):
    date: str
    cycleStartDate: str | None = None
    phase: str = "unknown"
    dayOfCycle: int | None = None
    cycleLengthDays: int | None = None
    flow: str = "unspecified"
    cramps: str = "mild"
    energy: str = "normal"
    action: str | None = None
    updatedAt: datetime | None = None


_CYCLE_PHASES = {"menses", "follicular", "ovulation", "luteal", "unknown"}
_CYCLE_FLOWS = {"unspecified", "light", "moderate", "heavy"}
_CYCLE_CRAMPS = {"none", "mild", "moderate", "severe"}
_CYCLE_ENERGY = {"low", "normal", "high"}
_CYCLE_ACTIONS = {"keep", "lighter", "recovery"}


def _parse_cycle_date(value: str | None, field_name: str) -> date:
    if not value:
        raise HTTPException(status_code=400, detail=f"{field_name} is required")
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field_name} must be YYYY-MM-DD")


def _cycle_log_payload(row: CycleLog) -> dict:
    log_date = row.log_date or row.period_start_date
    return {
        "id": str(row.id),
        "date": log_date.isoformat(),
        "cycleStartDate": row.period_start_date.isoformat(),
        "phase": row.phase or "unknown",
        "dayOfCycle": row.cycle_day,
        "cycleLengthDays": row.cycle_length,
        "flow": row.flow_level or "unspecified",
        "cramps": row.cramps or "mild",
        "energy": row.energy or "normal",
        "action": row.training_action,
        "updatedAt": (row.updated_at or row.created_at or datetime.now(timezone.utc)).isoformat(),
    }


def _apply_cycle_symptom_body(row: CycleLog, body: CycleSymptomLogBody, log_date: date, cycle_start_date: date) -> CycleLog:
    phase = (body.phase or "unknown").strip().lower()
    flow = (body.flow or "unspecified").strip().lower()
    cramps = (body.cramps or "mild").strip().lower()
    energy = (body.energy or "normal").strip().lower()
    action = (body.action.strip().lower() if isinstance(body.action, str) and body.action.strip() else None)
    if phase not in _CYCLE_PHASES:
        raise HTTPException(status_code=422, detail="Invalid cycle phase")
    if flow not in _CYCLE_FLOWS:
        raise HTTPException(status_code=422, detail="Invalid cycle flow")
    if cramps not in _CYCLE_CRAMPS:
        raise HTTPException(status_code=422, detail="Invalid cycle cramps")
    if energy not in _CYCLE_ENERGY:
        raise HTTPException(status_code=422, detail="Invalid cycle energy")
    if action is not None and action not in _CYCLE_ACTIONS:
        raise HTTPException(status_code=422, detail="Invalid cycle action")
    if body.dayOfCycle is not None and body.dayOfCycle <= 0:
        raise HTTPException(status_code=422, detail="dayOfCycle must be positive")
    if body.cycleLengthDays is not None and body.cycleLengthDays <= 0:
        raise HTTPException(status_code=422, detail="cycleLengthDays must be positive")

    row.log_date = log_date
    row.period_start_date = cycle_start_date
    row.phase = phase
    row.cycle_day = body.dayOfCycle
    row.cycle_length = body.cycleLengthDays
    row.flow_level = flow
    row.cramps = cramps
    row.energy = energy
    row.training_action = action
    row.symptoms = [
        f"flow:{flow}",
        f"cramps:{cramps}",
        f"energy:{energy}",
        *( [f"action:{action}"] if action else [] ),
    ]
    row.updated_at = body.updatedAt or datetime.now(timezone.utc)
    return row


@router.get("/cycle-logs")
def list_cycle_symptom_logs(
    limit: int = Query(default=120, ge=1, le=500),
    since: date | None = Query(default=None),
    before: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    query = select(CycleLog).where(CycleLog.user_id == current_user.id)
    if since:
        query = query.where(CycleLog.log_date >= since)
    if before:
        query = query.where(CycleLog.log_date <= before)
    rows = db.exec(
        query
        .order_by(CycleLog.log_date.desc(), CycleLog.created_at.desc())
        .limit(limit)
    ).all()
    return [_cycle_log_payload(row) for row in reversed(rows)]


@router.post("/cycle-logs", status_code=201)
def save_cycle_symptom_log(
    body: CycleSymptomLogBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    log_date = _parse_cycle_date(body.date, "date")
    cycle_start_date = _parse_cycle_date(body.cycleStartDate or body.date, "cycleStartDate")
    existing = db.exec(
        select(CycleLog).where(
            CycleLog.user_id == current_user.id,
            CycleLog.log_date == log_date,
        )
    ).first()
    row = existing or CycleLog(
        user_id=current_user.id,
        log_date=log_date,
        period_start_date=cycle_start_date,
    )
    row = _apply_cycle_symptom_body(row, body, log_date, cycle_start_date)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = db.exec(
            select(CycleLog).where(
                CycleLog.user_id == current_user.id,
                CycleLog.log_date == log_date,
            )
        ).first()
        if row is None:
            raise
        row = _apply_cycle_symptom_body(row, body, log_date, cycle_start_date)
        db.add(row)
        db.commit()
    db.refresh(row)
    return _cycle_log_payload(row)


@router.get("/weight-entries")
def list_weight_entries(
    limit: int = Query(default=730, ge=1, le=5000),
    since: date | None = Query(default=None),
    before: date | None = Query(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    query = (
        select(WeightEntry)
        .where(WeightEntry.user_id == current_user.id)
    )
    if since:
        query = query.where(WeightEntry.entry_date >= since)
    if before:
        query = query.where(WeightEntry.entry_date <= before)
    rows = db.exec(
        query
        .order_by(WeightEntry.entry_date.desc(), WeightEntry.created_at.desc())
        .limit(limit)
    ).all()
    return [_weight_entry_payload(r) for r in reversed(rows)]


@router.post("/weight-entries", status_code=201)
def save_weight_entry(
    body: WeightEntryBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    from datetime import date as _d
    if body.weight_lbs <= 0:
        raise HTTPException(status_code=400, detail="weight_lbs must be positive")
    d = _d.fromisoformat(body.date)
    logged_at = body.logged_at or datetime.now(timezone.utc)
    existing = db.exec(
        select(WeightEntry).where(
            WeightEntry.user_id == current_user.id,
            WeightEntry.entry_date == d,
        )
    ).first()
    if existing:
        existing.weight_lbs = body.weight_lbs
        existing.source = body.source
        existing.logged_at = logged_at
        db.add(existing)
    else:
        db.add(WeightEntry(
            user_id=current_user.id,
            entry_date=d,
            weight_lbs=body.weight_lbs,
            source=body.source,
            logged_at=logged_at,
        ))
    db.flush()
    _promote_latest_weight_entry_to_profile(db, current_user.id)
    db.commit()
    return {"status": "ok"}


@router.delete("/weight-entries/{entry_date}", status_code=200)
def delete_weight_entry(
    entry_date: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    from datetime import date as _d
    try:
        d = _d.fromisoformat(entry_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    existing = db.exec(
        select(WeightEntry).where(
            WeightEntry.user_id == current_user.id,
            WeightEntry.entry_date == d,
        )
    ).first()
    if not existing:
        return {"deleted": 0, "date": d.isoformat()}

    db.delete(existing)
    db.flush()
    _promote_latest_weight_entry_to_profile(db, current_user.id)
    db.commit()
    return {"deleted": 1, "date": d.isoformat()}


@router.delete("/weight-entries", status_code=200)
def clear_weight_entries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(WeightEntry).where(WeightEntry.user_id == current_user.id)
    ).all()
    deleted = len(rows)
    for row in rows:
        db.delete(row)
    db.commit()
    return {"deleted": deleted}


@router.post("/weight-entries/sync", status_code=200)
def sync_weight_entries(
    entries: list[WeightEntryBody],
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Bulk upsert from client's local weight history."""
    from datetime import date as _d
    now = datetime.now(timezone.utc)
    for e in entries:
        if e.weight_lbs <= 0:
            raise HTTPException(status_code=400, detail="weight_lbs must be positive")
        d = _d.fromisoformat(e.date)
        existing = db.exec(
            select(WeightEntry).where(
                WeightEntry.user_id == current_user.id,
                WeightEntry.entry_date == d,
            )
        ).first()
        if existing:
            existing.weight_lbs = e.weight_lbs
            existing.source = e.source
            existing.logged_at = e.logged_at or existing.logged_at or now
            db.add(existing)
        else:
            db.add(WeightEntry(
                user_id=current_user.id,
                entry_date=d,
                weight_lbs=e.weight_lbs,
                source=e.source,
                logged_at=e.logged_at or now,
            ))
    db.flush()
    _promote_latest_weight_entry_to_profile(db, current_user.id)
    db.commit()
    return {"synced": len(entries)}


# ─── User custom exercises ─────────────────────────────────────────────────────

@router.get("/custom-exercises", response_model=list[UserCustomExerciseRead])
def list_custom_exercises(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return session.exec(
        select(UserCustomExercise)
        .where(UserCustomExercise.user_id == current_user.id)
        .order_by(UserCustomExercise.created_at.desc())
    ).all()


@router.post("/custom-exercises", response_model=UserCustomExerciseRead)
def upsert_custom_exercise(
    body: UserCustomExerciseCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    normalized_name = _custom_exercise_name_key(body.name)
    if not normalized_name:
        raise HTTPException(status_code=422, detail="Exercise name is required")
    row = session.exec(
        select(UserCustomExercise).where(
            UserCustomExercise.user_id == current_user.id,
            UserCustomExercise.normalized_name == normalized_name,
        )
    ).first()
    if row is None:
        row = UserCustomExercise(user_id=current_user.id, name=body.name.strip(), normalized_name=normalized_name)
    _apply_custom_exercise_body(row, body)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


@router.post("/custom-exercises/sync", response_model=list[UserCustomExerciseRead])
def sync_custom_exercises(
    body: CustomExerciseSyncBody,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    for item in body.exercises[:500]:
        normalized_name = _custom_exercise_name_key(item.name)
        if not normalized_name:
            continue
        row = session.exec(
            select(UserCustomExercise).where(
                UserCustomExercise.user_id == current_user.id,
                UserCustomExercise.normalized_name == normalized_name,
            )
        ).first()
        if row is None:
            row = UserCustomExercise(user_id=current_user.id, name=item.name.strip(), normalized_name=normalized_name)
        _apply_custom_exercise_body(row, item)
        session.add(row)
    session.commit()
    return session.exec(
        select(UserCustomExercise)
        .where(UserCustomExercise.user_id == current_user.id)
        .order_by(UserCustomExercise.created_at.desc())
    ).all()


@router.put("/custom-exercises/{exercise_id}", response_model=UserCustomExerciseRead)
def update_custom_exercise(
    exercise_id: int,
    body: UserCustomExerciseCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.get(UserCustomExercise, exercise_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Custom exercise not found")
    normalized_name = _custom_exercise_name_key(body.name)
    if not normalized_name:
        raise HTTPException(status_code=422, detail="Exercise name is required")
    duplicate = session.exec(
        select(UserCustomExercise).where(
            UserCustomExercise.user_id == current_user.id,
            UserCustomExercise.normalized_name == normalized_name,
            UserCustomExercise.id != exercise_id,
        )
    ).first()
    if duplicate:
        raise HTTPException(status_code=409, detail="A custom exercise with that name already exists")
    _apply_custom_exercise_body(row, body)
    session.add(row)
    session.commit()
    session.refresh(row)
    return row


@router.delete("/custom-exercises/{exercise_id}", status_code=204)
def delete_custom_exercise(
    exercise_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.get(UserCustomExercise, exercise_id)
    if not row or row.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Custom exercise not found")
    session.delete(row)
    session.commit()


# ─── User equipment profiles ───────────────────────────────────────────────────
#
# Lets users register their specific cardio/strength equipment so the
# prescription engine can use the right metric tier (e.g. watts+RPM for an
# IC6 bike, speed+incline for a treadmill). A simple capability-checkbox model
# instead of a long setup form.

@router.get("/cardio-equipment", response_model=list[UserEquipmentProfileRead])
def list_cardio_equipment(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return all equipment profiles registered by the current user."""
    rows = session.exec(
        select(UserEquipmentProfile).where(UserEquipmentProfile.user_id == current_user.id)
    ).all()
    return rows


@router.post("/cardio-equipment", response_model=UserEquipmentProfileRead, status_code=201)
def add_cardio_equipment(
    body: UserEquipmentProfileCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Register a new equipment profile."""
    profile = UserEquipmentProfile(
        user_id=current_user.id,
        category=body.category,
        equipment_type=body.equipment_type,
        display_name=body.display_name,
        brand=body.brand,
        model_name=body.model_name,
        location=body.location,
        capabilities=body.capabilities,
        notes=body.notes,
    )
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return profile


@router.put("/cardio-equipment/{profile_id}", response_model=UserEquipmentProfileRead)
def update_cardio_equipment(
    profile_id: int,
    body: UserEquipmentProfileCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Update an existing equipment profile."""
    profile = session.get(UserEquipmentProfile, profile_id)
    if not profile or profile.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Equipment profile not found")
    profile.category      = body.category
    profile.equipment_type = body.equipment_type
    profile.display_name  = body.display_name
    profile.brand         = body.brand
    profile.model_name    = body.model_name
    profile.location      = body.location
    profile.capabilities  = body.capabilities
    profile.notes         = body.notes
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return profile


@router.delete("/cardio-equipment/{profile_id}", status_code=204)
def delete_cardio_equipment(
    profile_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Remove an equipment profile."""
    profile = session.get(UserEquipmentProfile, profile_id)
    if not profile or profile.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Equipment profile not found")
    session.delete(profile)
    session.commit()


@router.get("/cardio-equipment/capabilities")
def list_cardio_capability_tokens():
    """Return the canonical list of equipment capability tokens with labels.
    Clients use this to render the capability-checkbox UI during equipment setup.
    """
    from app.services.workout.cardio import (
        CAP_TIME, CAP_DISTANCE, CAP_SPEED, CAP_INCLINE, CAP_WATTS,
        CAP_RPM, CAP_RESISTANCE, CAP_HEART_RATE, CAP_CALORIES,
        CAP_PACE, CAP_STROKE_RATE,
    )
    return [
        {"token": CAP_TIME,         "label": "Time",              "icon": "⏱"},
        {"token": CAP_DISTANCE,     "label": "Distance",          "icon": "📏"},
        {"token": CAP_SPEED,        "label": "Speed (mph/kph)",   "icon": "🏃"},
        {"token": CAP_INCLINE,      "label": "Incline (%)",       "icon": "⛰"},
        {"token": CAP_WATTS,        "label": "Watts / Power",     "icon": "⚡"},
        {"token": CAP_RPM,          "label": "RPM / Cadence",     "icon": "🔄"},
        {"token": CAP_RESISTANCE,   "label": "Resistance level",  "icon": "🎚"},
        {"token": CAP_HEART_RATE,   "label": "Heart rate",        "icon": "❤️"},
        {"token": CAP_CALORIES,     "label": "Calories",          "icon": "🔥"},
        {"token": CAP_PACE,         "label": "Pace (/500m, /mi)", "icon": "⏱"},
        {"token": CAP_STROKE_RATE,  "label": "Stroke rate (SPM)", "icon": "🚣"},
    ]
