from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select
from datetime import datetime, timezone, date, timedelta

from app.database import get_session
from app.models import (
    User, UserProfile, UserGoal, UserPreferences,
    ProfileUpsert, GoalUpsert, PreferencesUpsert, OnboardingSync,
    UserDayState, DayStateUpsert, WeeklyCheckIn, WeeklyCheckInCreate,
    CoachMemory, UserCoachingState, WorkoutCompletion, UserState,
)
from app.auth import get_current_user


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


class UserStateBody(BaseModel):
    state: dict

    @field_validator('state')
    @classmethod
    def check_size(cls, v):
        import json
        if len(json.dumps(v)) > 5_000_000:  # 5MB limit
            raise ValueError('State blob too large (max 5MB)')
        return v

router = APIRouter(prefix="/profile", tags=["profile"])


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

    gender_value = profile.gender.value if hasattr(profile.gender, "value") else str(profile.gender)
    inputs = CalorieInputs(
        weight_lbs=profile.weight_lbs,
        height_feet=profile.height_feet,
        height_inches=profile.height_inches,
        age=profile.age,
        gender=gender_value,
        training_days_per_week=prefs.days_per_week if prefs else 3,
        session_minutes=60,
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


@router.post("/onboarding")
def sync_onboarding(
    body: OnboardingSync,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Called once at end of onboarding to save all data in one request."""
    now = datetime.now(timezone.utc)

    # Upsert physical profile
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()
    if profile:
        profile.weight_lbs    = body.profile.weight_lbs
        profile.height_feet   = body.profile.height_feet
        profile.height_inches = body.profile.height_inches
        profile.age           = body.profile.age
        profile.gender        = body.profile.gender
        profile.updated_at    = now
    else:
        profile = UserProfile(user_id=current_user.id, **body.profile.model_dump())
    session.add(profile)

    # Deactivate previous goals, insert new one
    prev_goals = session.exec(
        select(UserGoal).where(UserGoal.user_id == current_user.id, UserGoal.is_active == True)
    ).all()
    for g in prev_goals:
        g.is_active = False
        session.add(g)

    new_goal = UserGoal(user_id=current_user.id, **body.goal.model_dump())
    session.add(new_goal)

    # Upsert preferences
    prefs = session.exec(
        select(UserPreferences).where(UserPreferences.user_id == current_user.id)
    ).first()
    if prefs:
        prefs.days_per_week    = body.preferences.days_per_week
        prefs.equipment        = body.preferences.equipment
        prefs.foods_available  = body.preferences.foods_available
        prefs.updated_at       = now
    else:
        prefs = UserPreferences(user_id=current_user.id, **body.preferences.model_dump())
    session.add(prefs)

    session.commit()
    return {"status": "ok"}


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

    coaching = _coaching_state(session, current_user.id)
    session.add(coaching)
    session.commit()

    return {
        "profile": profile,
        "goal": goal,
        "preferences": prefs,
        "coaching": coaching,
    }


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
            "meal_checks": {},
            "nutrition_plan": None,
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
        state.skipped_focus = body.skipped_focus
        state.meal_checks = body.meal_checks
        state.nutrition_plan = body.nutrition_plan
        state.updated_at = now
    else:
        state = UserDayState(
            user_id=current_user.id,
            day_key=day_key,
            skipped_focus=body.skipped_focus,
            meal_checks=body.meal_checks,
            nutrition_plan=body.nutrition_plan,
            updated_at=now,
        )
    session.add(state)
    session.commit()
    return {"status": "ok"}


@router.post("/checkin")
def weekly_checkin(
    body: WeeklyCheckInCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if body.energy < 1 or body.energy > 5 or body.sleep < 1 or body.sleep > 5 or body.adherence < 1 or body.adherence > 5:
        raise HTTPException(status_code=400, detail="energy, sleep, and adherence must be 1-5")

    profile = session.exec(select(UserProfile).where(UserProfile.user_id == current_user.id)).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    previous = session.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == current_user.id)
        .order_by(WeeklyCheckIn.checkin_date.desc())
    ).first()

    # Save check-in and keep profile weight in sync
    entry = WeeklyCheckIn(user_id=current_user.id, **body.model_dump())
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
    current_user: User = Depends(get_current_user),
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
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Compute today's nutrition score from DailyRollup + food quality data."""
    from app.models import DailyRollup
    from app.services.nutrition.nutrition_score import (
        NutritionIndicators, compute_nutrition_score,
        compute_overall_health_score, compute_weekly_trend,
    )

    today = date.today()
    goal = "body_recomp"  # default
    try:
        active_goal = session.exec(
            select(UserGoal).where(UserGoal.user_id == current_user.id, UserGoal.is_active == True)
        ).first()
        if active_goal:
            goal = active_goal.goal_type.value
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
    session.commit()
    return {"ok": True, "updated_at": now.isoformat()}
