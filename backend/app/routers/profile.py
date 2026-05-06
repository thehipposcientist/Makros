import json
import secrets
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import or_
from sqlmodel import Session, select
from datetime import datetime, timezone, date, timedelta

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import (
    User, UserProfile, UserGoal, UserPreferences,
    ProfileUpsert, GoalUpsert, PreferencesUpsert, OnboardingSync,
    UserDayState, DayStateUpsert, WeeklyCheckIn, WeeklyCheckInCreate,
    CoachMemory, UserCoachingState, WorkoutCompletion, UserState,
    WeightEntry, UserEquipmentProfile,
    UserEquipmentProfileCreate, UserEquipmentProfileRead,
    WorkoutSession, WorkoutExercise, ExerciseSet, Meal, MealItem, BodyScan,
    SavedMeal, SleepLog, DailyHealthSnapshot, UserSupplementStack,
    SupplementLog, UserSocialProfile, Friendship, ActivityFeedItem,
    FeedLike, PlanWeek, PlanDay, AIDecision, GearItem,
)
from app.auth import get_current_user, hash_password


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
    """Return the cut / maintain / bulk calorie + protein ranges for the
    signed-in user, calculated from their profile body stats and training
    volume. Used by the EditProfileScreen macros card to show users what
    their three reference ranges look like at a glance.

    Returns 404 if the user hasn't completed onboarding yet (no profile).
    """
    from app.services.nutrition.calorie_calculator import (
        CalorieInputs,
        calculate_reference_ranges,
    )

    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not set up yet")

    prefs = session.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    latest_weight = session.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == current_user.id)
        .where(WeightEntry.entry_date <= date.today())
        .order_by(WeightEntry.entry_date.desc(), WeightEntry.created_at.desc())
    ).first()

    gender_value = profile.gender.value if hasattr(profile.gender, "value") else str(profile.gender)
    inputs = CalorieInputs(
        weight_lbs=latest_weight.weight_lbs if latest_weight else profile.weight_lbs,
        height_feet=profile.height_feet,
        height_inches=profile.height_inches,
        age=profile.age,
        gender=gender_value,
        training_days_per_week=prefs.days_per_week if prefs else 3,
        session_minutes=prefs.workout_duration_minutes if prefs else 60,
    )
    card = calculate_reference_ranges(inputs)
    return {
        "bmr": card.bmr,
        "activity_multiplier": card.activity_multiplier,
        "maintenance_calories": card.maintenance_calories,
        "cut_calories": card.cut_calories,
        "bulk_calories": card.bulk_calories,
        "cut_protein_g": card.cut_protein_g,
        "maintain_protein_g": card.maintain_protein_g,
        "bulk_protein_g": card.bulk_protein_g,
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

        new_goal = UserGoal(user_id=current_user.id, **body.goal.model_dump())
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
        prefs.equipment        = body.preferences.equipment
        prefs.equipment_settings = body.preferences.equipment_settings
        prefs.experience_level = body.preferences.experience_level
        prefs.strength_baselines = body.preferences.strength_baselines
        prefs.cardio_baseline = body.preferences.cardio_baseline
        prefs.foods_available  = body.preferences.foods_available
        prefs.injuries         = body.preferences.injuries
        prefs.updated_at       = now
    else:
        prefs = UserPreferences(user_id=current_user.id, **body.preferences.model_dump())
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
    payload = {
        "profile": _dump_model(profile),
        "goal": _dump_model(goal),
        "preferences": _dump_model(prefs),
        "coaching": _dump_model(coaching),
        "first_name": current_user.first_name,
        "last_name": current_user.last_name,
        "subscription_tier": current_user.subscription_tier or "free",
        "weight_entries": _recent_weight_entries(session, current_user.id),
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
            "subscription_tier": current_user.subscription_tier or "free",
        },
        "profile": _dump_rows(session.exec(select(UserProfile).where(UserProfile.user_id == uid)).all()),
        "goals": _dump_rows(session.exec(select(UserGoal).where(UserGoal.user_id == uid)).all()),
        "preferences": _dump_rows(session.exec(select(UserPreferences).where(UserPreferences.user_id == uid)).all()),
        "state": _dump_rows(session.exec(select(UserState).where(UserState.user_id == uid)).all()),
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
    }


@router.delete("/account")
def delete_account(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Soft-delete the signed-in account and anonymize login identifiers."""
    uid = current_user.id
    if uid is None:
        raise HTTPException(status_code=401, detail="Invalid user")

    now = datetime.now(timezone.utc)
    suffix = f"{uid}-{int(now.timestamp())}"
    current_user.is_active = False
    current_user.account_deleted_at = now
    current_user.email = f"deleted+{suffix}@deleted.thallo.local"
    current_user.username = f"deleted_user_{suffix}"
    current_user.first_name = None
    current_user.last_name = None
    current_user.hashed_password = hash_password(secrets.token_urlsafe(32))
    current_user.recovery_question = None
    current_user.recovery_answer_hash = None
    current_user.email_verification_token_hash = None
    current_user.email_verification_expires_at = None
    current_user.password_reset_token_hash = None
    current_user.password_reset_expires_at = None

    social = session.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == uid)).first()
    if social:
        social.display_name = "Deleted user"
        social.share_activity_enabled = False
        social.updated_at = now
        session.add(social)

    session.add(current_user)
    session.commit()
    return {"status": "deleted", "deleted_user_id": uid}


@router.get("/day-state/{day_key}")
def get_day_state(
    day_key: date,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    state = session.exec(
        select(UserDayState).where(UserDayState.user_id == current_user.id, UserDayState.day_key == day_key)
    ).first()
    if not state:
        return {
            "day_key": day_key,
            "skipped_focus": None,
            "skip_reason": None,
            "meal_checks": {},
            "nutrition_plan": None,
            "macro_overrides": None,
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
        select(UserDayState).where(UserDayState.user_id == current_user.id, UserDayState.day_key == day_key)
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
            state.nutrition_plan = body.nutrition_plan
        if body.macro_overrides is not None:
            state.macro_overrides = body.macro_overrides
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
            updated_at=now,
        )
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
    return {
        "state": (row.state_json if row else {}),
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
    if row:
        row.state_json = body.state
        row.updated_at = now
    else:
        row = UserState(user_id=current_user.id, state_json=body.state, updated_at=now)
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


@router.get("/weight-entries")
def list_weight_entries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == current_user.id)
        .order_by(WeightEntry.entry_date)
    ).all()
    return [_weight_entry_payload(r) for r in rows]


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
