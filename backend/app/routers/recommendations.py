"""Deterministic live-workout recommendation routes.

These routes are the canonical namespace for load/reps execution guidance.
They intentionally delegate to the existing `/ai/...` handlers so old mobile
clients keep working while new clients stop implying an LLM chooses weights.
"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlmodel import Session

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import User
from app.routers.ai.models import PreSetRecommendRequest, WeightRecommendRequest
from app.routers.ai.progression import pre_set_recommendation, recommend_weight
from app.services.workout.recommendation_ai_safety import get_ai_safety_status

router = APIRouter(prefix="/recommendations", tags=["recommendations"])


@router.post("/next-set")
def next_set_recommendation(
    body: WeightRecommendRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_pro_feature("Advanced in-workout progression guidance")),
    db: Session = Depends(get_session),
):
    return recommend_weight(body, current_user=current_user, db=db, background_tasks=background_tasks)


@router.post("/pre-set")
def pre_set(
    body: PreSetRecommendRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_pro_feature("Advanced in-workout progression guidance")),
    db: Session = Depends(get_session),
):
    return pre_set_recommendation(body, current_user=current_user, db=db, background_tasks=background_tasks)


@router.get("/ai-safety/{cache_key}")
def ai_safety_status(
    cache_key: str,
    current_user: User = Depends(require_pro_feature("Advanced in-workout progression guidance")),
):
    return get_ai_safety_status(cache_key)
