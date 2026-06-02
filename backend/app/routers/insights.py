from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlmodel import Session

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import User
from app.services.insights.insight_engine import build_health_insights_response

router = APIRouter(prefix="/insights", tags=["insights"])


@router.get("/health")
def health_insights(
    days: int = Query(default=14, ge=1, le=30),
    include_unknown: bool = Query(default=False),
    risk_signals: bool | None = Query(default=None),
    categories: str | None = Query(default=None, description="Comma-separated category or card ids"),
    current_user: User = Depends(require_pro_feature("Health insights")),
    db: Session = Depends(get_session),
):
    selected = [c.strip() for c in (categories or "").split(",") if c.strip()] or None
    return build_health_insights_response(
        db,
        current_user.id,
        days=days,
        include_unknown=include_unknown,
        include_risk_signals=risk_signals,
        categories=selected,
    )
