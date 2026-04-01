from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select
from datetime import datetime, timezone

from app.database import get_session
from app.models import (
    User, UserProfile, UserGoal, UserPreferences,
    ProfileUpsert, GoalUpsert, PreferencesUpsert, OnboardingSync,
)
from app.auth import get_current_user

router = APIRouter(prefix="/profile", tags=["profile"])


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

    return {
        "profile": profile,
        "goal": goal,
        "preferences": prefs,
    }
