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
        # Tightened from 5MB → 1MB. Realistic working blob is 100-500KB;
        # anything bigger usually means history or generated content is
        # leaking into state storage and belongs in its own table.
        import json
        if len(json.dumps(v)) > 1_000_000:  # 1MB hard cap
            raise ValueError('State blob too large (max 1MB)')
        return v

router = APIRouter(prefix="/profile", tags=["profile"])


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
    # Age is derived from birthdate when present so it stays accurate
    # years later. Fall back to the explicit `age` int only when the
    # client couldn't collect a birthday (older onboarding flow).
    derived_age = _derive_age(body.profile.birthdate) or body.profile.age
    if derived_age is None:
        raise HTTPException(status_code=422, detail="birthdate or age required")
    if profile:
        profile.weight_lbs    = body.profile.weight_lbs
        profile.height_feet   = body.profile.height_feet
        profile.height_inches = body.profile.height_inches
        profile.age           = derived_age
        profile.birthdate     = body.profile.birthdate
        profile.gender        = body.profile.gender
        profile.updated_at    = now
    else:
        profile = UserProfile(
            user_id=current_user.id,
            weight_lbs=body.profile.weight_lbs,
            height_feet=body.profile.height_feet,
            height_inches=body.profile.height_inches,
            age=derived_age,
            birthdate=body.profile.birthdate,
            gender=body.profile.gender,
        )
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
        # Patch semantics — only update fields the caller actually passed.
        # `None` means "leave existing value alone". `clear_skipped_focus`
        # is the explicit way to null out skipped_focus (since `None` on
        # `skipped_focus` is otherwise indistinguishable from "no patch").
        if body.clear_skipped_focus:
            state.skipped_focus = None
        elif body.skipped_focus is not None:
            state.skipped_focus = body.skipped_focus
        if body.meal_checks is not None:
            state.meal_checks = body.meal_checks
        if body.nutrition_plan is not None:
            state.nutrition_plan = body.nutrition_plan
        state.updated_at = now
    else:
        state = UserDayState(
            user_id=current_user.id,
            day_key=day_key,
            skipped_focus=None if body.clear_skipped_focus else body.skipped_focus,
            meal_checks=body.meal_checks or {},
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


# ─── Account: export + delete ────────────────────────────────────────────────

def _model_dump_row(row) -> dict:
    """Serialize a SQLModel row to a JSON-safe dict. Handles date/datetime
    and any JSON columns that come back as dicts already."""
    import json as _json
    from datetime import date as _date, datetime as _dt
    data = row.model_dump() if hasattr(row, "model_dump") else dict(row.__dict__)
    out: dict = {}
    for k, v in data.items():
        if k.startswith("_"):
            continue
        if isinstance(v, (_date, _dt)):
            out[k] = v.isoformat()
        else:
            try:
                _json.dumps(v)
                out[k] = v
            except TypeError:
                out[k] = str(v)
    return out


@router.get("/export")
def export_user_data(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return every user-scoped row as a single JSON blob. Good enough for
    the TestFlight pilot's data-export obligation; a zipped archive with a
    per-category file split is a later polish pass.

    Intentionally omits hashed_password on the User row."""
    from app.models import (
        WorkoutCompletion, WorkoutSession, WorkoutExercise, ExerciseSet,
        Meal, MealItem, UserGoal, UserPreferences, UserProfile as UserProfileModel,
        WeeklyCheckIn, UserDayState, CoachMemory, UserCoachingState,
        UserRecentFood, UserFlag, AIDecision, PlanJob, UserState as UserStateModel,
    )

    uid = current_user.id

    def _rows(model, where=None):
        q = select(model).where(model.user_id == uid)
        if where is not None:
            q = q.where(where)
        return [_model_dump_row(r) for r in session.exec(q).all()]

    # Workout sessions pull their exercises + sets inline so the export
    # preserves the hierarchy without requiring the client to re-join.
    sessions = session.exec(
        select(WorkoutSession).where(WorkoutSession.user_id == uid)
    ).all()
    session_ids = [s.id for s in sessions]
    ex_rows = session.exec(
        select(WorkoutExercise).where(WorkoutExercise.session_id.in_(session_ids))
    ).all() if session_ids else []
    exercise_ids = [e.id for e in ex_rows]
    set_rows = session.exec(
        select(ExerciseSet).where(ExerciseSet.workout_exercise_id.in_(exercise_ids))
    ).all() if exercise_ids else []
    sets_by_ex: dict = {}
    for s in set_rows:
        sets_by_ex.setdefault(s.workout_exercise_id, []).append(_model_dump_row(s))
    ex_by_session: dict = {}
    for e in ex_rows:
        ex_by_session.setdefault(e.session_id, []).append({
            **_model_dump_row(e),
            "sets": sets_by_ex.get(e.id, []),
        })
    sessions_out = [
        {**_model_dump_row(s), "exercises": ex_by_session.get(s.id, [])}
        for s in sessions
    ]

    # Meals + items similarly nested.
    meals = session.exec(select(Meal).where(Meal.user_id == uid)).all()
    meal_ids = [m.id for m in meals]
    items = session.exec(
        select(MealItem).where(MealItem.meal_id.in_(meal_ids))
    ).all() if meal_ids else []
    items_by_meal: dict = {}
    for it in items:
        items_by_meal.setdefault(it.meal_id, []).append(_model_dump_row(it))
    meals_out = [{**_model_dump_row(m), "items": items_by_meal.get(m.id, [])} for m in meals]

    user_row = _model_dump_row(current_user)
    user_row.pop("hashed_password", None)

    return {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "user": user_row,
        "profile": _rows(UserProfileModel),
        "goal": _rows(UserGoal),
        "preferences": _rows(UserPreferences),
        "workout_completions": _rows(WorkoutCompletion),
        "workout_sessions": sessions_out,
        "meals": meals_out,
        "weekly_checkins": _rows(WeeklyCheckIn),
        "day_states": _rows(UserDayState),
        "coach_memory": _rows(CoachMemory),
        "coaching_state": _rows(UserCoachingState),
        "recent_foods": _rows(UserRecentFood),
        "flags": _rows(UserFlag),
        "ai_decisions": _rows(AIDecision),
        "plan_jobs": _rows(PlanJob),
        "user_state": _rows(UserStateModel),
    }


class DeleteAccountBody(BaseModel):
    confirmation: str  # must equal "DELETE" — belt + suspenders


@router.delete("/account")
def delete_account(
    body: DeleteAccountBody,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Soft-delete the account: mark `is_active=False` and scramble the
    email so the user can re-register if they change their mind. Real
    row deletion is a manual / scheduled job for later — this endpoint
    only needs to kill the user's ability to log in RIGHT NOW."""
    if body.confirmation != "DELETE":
        raise HTTPException(status_code=422, detail='Confirmation must equal "DELETE"')

    current_user.is_active = False
    # Free up the email for a potential re-signup; prefix with a marker so
    # we can distinguish deleted-account rows from active ones during cleanup.
    if current_user.email and not current_user.email.startswith("deleted__"):
        current_user.email = f"deleted__{current_user.id}__{current_user.email}"
    session.add(current_user)
    session.commit()
    return {"ok": True, "deleted_user_id": current_user.id}


# ─── Adaptive macro recommendations ──────────────────────────────────────────

class AdaptiveMacroRequest(BaseModel):
    """Client sends its local weight history so we can run the TDEE
    estimator without needing a separate WeightEntry table. V1 keeps
    weight storage on the client (AsyncStorage) — this endpoint just
    consumes the data."""
    weight_entries: list[dict] = []   # [{date: "YYYY-MM-DD", weight_lbs: float}, ...]


@router.post("/adaptive-macros")
def adaptive_macros(
    body: AdaptiveMacroRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return the weekly-check-in payload: estimated maintenance, the
    user's current target, and the suggested new target with reasoning
    + confidence. Deterministic — no AI. Client decides whether to
    apply the suggested target."""
    from app.services.nutrition.adaptive_macros import (
        compute_adaptive_recommendation,
    )

    goal = session.exec(
        select(UserGoal).where(UserGoal.user_id == current_user.id)
    ).first()
    profile = session.exec(
        select(UserProfile).where(UserProfile.user_id == current_user.id)
    ).first()

    # Parse dates coming in as ISO strings.
    from datetime import date as _d
    entries_parsed: list[dict] = []
    for e in body.weight_entries or []:
        try:
            d = _d.fromisoformat(str(e.get("date") or "").strip())
            w = float(e.get("weight_lbs") or 0)
            if w > 0:
                entries_parsed.append({"date": d, "weight_lbs": w})
        except (ValueError, TypeError):
            continue

    current_target = None
    if profile:
        # UserProfile doesn't currently store a computed calorie target
        # in a uniform field. Pull it from the latest nutrition plan if
        # available, else leave None and the UI will just show the
        # suggested target on its own.
        from app.models import NutritionPlan
        np_row = session.exec(
            select(NutritionPlan)
            .where(NutritionPlan.user_id == current_user.id)
            .where(NutritionPlan.is_active == True)  # noqa: E712
            .order_by(NutritionPlan.created_at.desc())
        ).first()
        if np_row and np_row.plan_json:
            try:
                current_target = int(
                    (np_row.plan_json.get("targets") or {}).get("calories")
                    or (np_row.plan_json.get("macros") or {}).get("calories")
                    or 0
                ) or None
            except Exception:
                current_target = None

    rec = compute_adaptive_recommendation(
        session, current_user.id,
        profile_goal=(goal.goal_type if goal else None),
        current_target_kcal=current_target,
        weight_entries=entries_parsed,
    )
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
    }
