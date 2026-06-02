"""Backfill + maintenance for gut-health metrics.

Two chunks of work:

1. `backfill_food_metadata` — walks every distinct food name that has ever
   appeared in a MealItem and writes non-AI FoodMetadata defaults keyed by
   (normalized_name, CLASSIFIER_VERSION). Rerunnable and idempotent.

2. `backfill_daily_metrics` — computes DailyNutritionMetrics for every
   (user, date) pair that has MealItems and is either missing a row OR has
   a row with an older version. Resumable by chunk_size.

Both functions log progress and return stats. They never raise on a single
row — failures are logged and the loop continues so one bad name doesn't
stall a large batch.

Invoke from explicit maintenance only. Not wired into startup or sync
user-facing code paths.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from sqlmodel import Session, select, func

from app.database import engine
from app.models import Food, MealItem, Meal, FoodMetadata, DailyNutritionMetrics
from app.services.nutrition.ai_classify import get_or_create_metadata
from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, normalize_name
from app.services.nutrition.gut_health import compute_daily_metrics, METRICS_VERSION

logger = logging.getLogger("app.nutrition.backfill")


def backfill_all_food_rows(*, chunk_size: int = 100, max_rows: int | None = None) -> dict:
    """Classify every Food row that lacks a FoodMetadata entry at the current
    classifier version — seeded, USDA-imported, and custom foods alike,
    regardless of whether they've ever been logged.

    Safe to rerun; idempotent per (normalized_name, classifier_version).
    """
    processed = 0
    created = 0
    ai_called = 0

    with Session(engine) as db:
        foods: list[Food] = db.exec(select(Food).where(Food.is_active == True)).all()

        existing = {
            r.normalized_name: r for r in db.exec(
                select(FoodMetadata)
                .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
            ).all()
            if r and r.normalized_name
        }

        logger.info("gut_backfill_all_foods_start", extra={
            "foods": len(foods), "already_classified": len(existing), "version": CLASSIFIER_VERSION,
        })

        for i, food in enumerate(foods):
            if max_rows and processed >= max_rows:
                break
            if not food.name:
                continue
            existing_row = existing.get(normalize_name(food.name))
            if existing_row is not None:
                continue
            try:
                source = food.source.value if hasattr(food.source, "value") else str(food.source or "")
                requires_bucket = bool(getattr(food, "barcode", None)) or source == "barcode"
                row = get_or_create_metadata(
                    food.name,
                    db=db,
                    allow_ai=False,
                    require_processing_bucket=requires_bucket,
                    default_processing_bucket="processed" if requires_bucket else None,
                )
                processed += 1
                created += 1
                if row.source == "ai":
                    ai_called += 1
            except Exception:
                logger.exception("gut_backfill_all_foods_row_failed", extra={"name": (food.name or "")[:80]})
                continue
            if (i + 1) % chunk_size == 0:
                logger.info("gut_backfill_all_foods_progress", extra={
                    "processed": processed, "created_count": created, "ai_called": ai_called,
                })

    logger.info("gut_backfill_all_foods_done", extra={
        "processed": processed, "created_count": created, "ai_called": ai_called,
    })
    return {"processed": processed, "created": created, "ai_called": ai_called}


def backfill_food_metadata(*, chunk_size: int = 200, max_rows: int | None = None) -> dict:
    """Ensure every distinct food_name across all MealItems has a FoodMetadata
    row for the current CLASSIFIER_VERSION.

    Skips names we've already classified at this version. Safe to re-run at
    any time. This backfill never calls AI.
    """
    processed = 0
    created = 0
    ai_called = 0

    with Session(engine) as db:
        # Distinct names from logged meals. Normalization happens inside the
        # classifier — we pass the raw display name so notes/display stay nice.
        # A single-column `select` yields scalar strings, not 1-tuples.
        names: list[str] = [
            name for name in db.exec(
                select(MealItem.food_name).distinct()
            ).all()
            if name
        ]
        logger.info("gut_backfill_metadata_start", extra={"names": len(names), "version": CLASSIFIER_VERSION})

        # Pre-load the set of normalized names we already have at this version
        # to avoid one SELECT per name.
        from app.services.nutrition.food_classifier import normalize_name
        existing = {
            r.normalized_name: r for r in db.exec(
                select(FoodMetadata)
                .where(FoodMetadata.classifier_version == CLASSIFIER_VERSION)
            ).all()
            if r and r.normalized_name
        }

        for i, raw in enumerate(names):
            if max_rows and processed >= max_rows:
                break
            existing_row = existing.get(normalize_name(raw))
            if existing_row is not None:
                continue
            try:
                row = get_or_create_metadata(
                    raw,
                    db=db,
                    allow_ai=False,
                )
                processed += 1
                if row.id is None:
                    # shouldn't happen post-commit, but guard anyway
                    continue
                created += 1
                if row.source == "ai":
                    ai_called += 1
            except Exception:
                logger.exception("gut_backfill_metadata_row_failed", extra={"name": raw[:80]})
                continue
            if (i + 1) % chunk_size == 0:
                logger.info(
                    "gut_backfill_metadata_progress",
                    extra={"processed": processed, "created_count": created, "ai_called": ai_called},
                )

    logger.info("gut_backfill_metadata_done", extra={
        "processed": processed, "created_count": created, "ai_called": ai_called,
    })
    return {"processed": processed, "created": created, "ai_called": ai_called}


def backfill_daily_metrics(*, chunk_size: int = 500, max_rows: int | None = None) -> dict:
    """Compute DailyNutritionMetrics for every (user, date) pair with meals
    whose row is either missing or out-of-version. Resumable, idempotent."""
    processed = 0
    updated = 0

    with Session(engine) as db:
        # All (user_id, meal_date) pairs that have at least one meal.
        pairs = db.exec(
            select(Meal.user_id, Meal.meal_date).distinct()
        ).all()
        logger.info("gut_backfill_daily_start", extra={"pairs": len(pairs), "version": METRICS_VERSION})

        for i, (user_id, d) in enumerate(pairs):
            if max_rows and processed >= max_rows:
                break
            try:
                existing = db.exec(
                    select(DailyNutritionMetrics)
                    .where(DailyNutritionMetrics.user_id == user_id)
                    .where(DailyNutritionMetrics.metric_date == d)
                ).first()
                needs_recompute = (
                    existing is None
                    or existing.metrics_version != METRICS_VERSION
                    or existing.classifier_version_used != CLASSIFIER_VERSION
                )
                if not needs_recompute:
                    continue
                compute_daily_metrics(db, user_id=user_id, metric_date=d, allow_ai=False)
                updated += 1
                processed += 1
            except Exception:
                logger.exception("gut_backfill_daily_row_failed", extra={"user_id": user_id, "date": str(d)})
                continue
            if (i + 1) % chunk_size == 0:
                logger.info("gut_backfill_daily_progress", extra={"processed": processed, "updated": updated})

    logger.info("gut_backfill_daily_done", extra={"processed": processed, "updated": updated})
    return {"processed": processed, "updated": updated}


def run_full_backfill() -> dict:
    food_row_stats = backfill_all_food_rows()
    meta_stats = backfill_food_metadata()
    daily_stats = backfill_daily_metrics()
    return {"food_rows": food_row_stats, "metadata": meta_stats, "daily": daily_stats}
