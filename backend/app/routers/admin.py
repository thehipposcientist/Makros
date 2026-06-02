"""Admin-only operational endpoints.

Gated by a static token in the ADMIN_API_TOKEN env var. When that var is
unset the routes 404 — the surface stays invisible anywhere it was never
configured. This is deliberately not account-based: there is no admin flag
on User, and AI-cost data should not ride on ordinary user auth.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import func
from sqlmodel import Session, select

from app.database import get_session
from app.models import AIUsageEvent

router = APIRouter(prefix="/admin", tags=["admin"])


def require_admin_token(x_admin_token: str | None = Header(default=None)) -> None:
    """Reject anything without the configured admin token. 404 (not 403)
    when ADMIN_API_TOKEN is unset, so the route is indistinguishable from a
    non-existent path in environments that never opted in."""
    expected = (os.getenv("ADMIN_API_TOKEN") or "").strip()
    if not expected:
        raise HTTPException(status_code=404, detail="Not Found")
    if not x_admin_token or x_admin_token.strip() != expected:
        raise HTTPException(status_code=403, detail="Admin token required")


def _usd(value: object) -> float:
    return round(float(value or 0.0), 4)


def _int(value: object) -> int:
    return int(value or 0)


@router.get("/ai-cost", dependencies=[Depends(require_admin_token)])
def ai_cost_summary(
    days: int = Query(default=30, ge=1, le=365),
    db: Session = Depends(get_session),
):
    """Aggregate OpenAI spend from ai_usage_events over a trailing window.

    Read-only. The numbers come from `AIUsageEvent.estimated_cost_usd`, a
    best-effort estimate (see the model docstring) — signal for spotting
    runaway routes and model-routing mistakes, not invoice-grade billing.
    """
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=days)

    calls = func.count(AIUsageEvent.id).label("calls")
    cost = func.coalesce(func.sum(AIUsageEvent.estimated_cost_usd), 0.0).label("cost")
    prompt_tok = func.coalesce(func.sum(AIUsageEvent.prompt_tokens), 0).label("prompt_tokens")
    completion_tok = func.coalesce(func.sum(AIUsageEvent.completion_tokens), 0).label("completion_tokens")
    images = func.coalesce(func.sum(AIUsageEvent.image_count), 0).label("images")

    window = AIUsageEvent.created_at >= since

    totals = db.exec(
        select(calls, cost, prompt_tok, completion_tok, images).where(window)
    ).one()
    error_calls = db.exec(
        select(func.count(AIUsageEvent.id)).where(window, AIUsageEvent.success.is_(False))
    ).one()

    by_model = db.exec(
        select(AIUsageEvent.model, calls, cost, prompt_tok, completion_tok, images)
        .where(window)
        .group_by(AIUsageEvent.model)
        .order_by(cost.desc())
    ).all()

    by_route = db.exec(
        select(AIUsageEvent.route, AIUsageEvent.model, calls, cost)
        .where(window)
        .group_by(AIUsageEvent.route, AIUsageEvent.model)
        .order_by(cost.desc())
    ).all()

    by_bucket = db.exec(
        select(AIUsageEvent.budget_bucket, calls, cost)
        .where(window)
        .group_by(AIUsageEvent.budget_bucket)
        .order_by(cost.desc())
    ).all()

    top_users = db.exec(
        select(AIUsageEvent.user_id, calls, cost, images)
        .where(window)
        .group_by(AIUsageEvent.user_id)
        .order_by(cost.desc())
        .limit(10)
    ).all()

    return {
        "window_days": days,
        "since": since.isoformat() + "Z",
        "totals": {
            "calls": _int(totals.calls),
            "error_calls": _int(error_calls),
            "cost_usd": _usd(totals.cost),
            "prompt_tokens": _int(totals.prompt_tokens),
            "completion_tokens": _int(totals.completion_tokens),
            "images": _int(totals.images),
        },
        "by_model": [
            {
                "model": r.model,
                "calls": _int(r.calls),
                "cost_usd": _usd(r.cost),
                "prompt_tokens": _int(r.prompt_tokens),
                "completion_tokens": _int(r.completion_tokens),
                "images": _int(r.images),
            }
            for r in by_model
        ],
        "by_route": [
            {
                "route": r.route,
                "model": r.model,
                "calls": _int(r.calls),
                "cost_usd": _usd(r.cost),
            }
            for r in by_route
        ],
        "by_bucket": [
            {
                "budget_bucket": r.budget_bucket or "(none)",
                "calls": _int(r.calls),
                "cost_usd": _usd(r.cost),
            }
            for r in by_bucket
        ],
        "top_users": [
            {
                "user_id": r.user_id,
                "calls": _int(r.calls),
                "cost_usd": _usd(r.cost),
                "images": _int(r.images),
            }
            for r in top_users
        ],
    }


@router.get("/food-providers", dependencies=[Depends(require_admin_token)])
def food_provider_status(
    fatsecret_query: str = Query(default="mcdonalds cheeseburger", min_length=3, max_length=80),
    max_results: int = Query(default=3, ge=1, le=5),
):
    """Probe remote food-provider wiring without exposing credentials."""
    from app.services.fatsecret import provider_status as fatsecret_status

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "providers": {
            "fatsecret": fatsecret_status(fatsecret_query, max_results=max_results),
        },
    }
