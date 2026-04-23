"""Daily + weekly gut-health / longevity signal calculator.

Inputs: the user's MealItem rows for a date, plus FoodMetadata lookups.
Outputs: a DailyNutritionMetrics row with raw signals and derived scores.

Raw nutrition (MealItem.calories, protein_g, etc.) is untouched — we only
read from it. The FoodNutrition table provides `fiber` + `saturated_fat`
when available; when it isn't, fiber defaults to 0 and we note low coverage
in the metrics via `classified_item_count / item_count`.

Scores are 0-100 and documented at the bottom of this file. All scoring is
transparent — no composite "biological age" fantasies. If inputs are thin,
scores degrade gracefully instead of faking precision.

Bump METRICS_VERSION when scoring changes. The backfill job uses it to
decide which days need recompute.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from sqlmodel import select

from app.models import Meal, MealItem, Food, FoodNutrition, FoodMetadata, DailyNutritionMetrics
from app.services.nutrition.ai_classify import get_or_create_metadata
from app.services.nutrition.food_classifier import CLASSIFIER_VERSION, PLANT_CATEGORY

METRICS_VERSION = 1


# ── Targets / defaults ───────────────────────────────────────────────────────
FIBER_TARGET_G = 28.0         # general adult daily target (Institute of Medicine midpoint)
FIBER_TARGET_PER_1000 = 14.0  # clinical rule of thumb


# ── Public API ───────────────────────────────────────────────────────────────

@dataclass
class DailyRawSignals:
    calories_total: float
    fiber_total_g: float
    fiber_per_1000_kcal: float
    distinct_plant_foods: int
    fermented_servings: float
    omega3_servings: float
    processing_counts: dict[str, int]
    saturated_fat_g: float
    plant_slugs: list[str]
    item_count: int
    classified_item_count: int


def compute_daily_metrics(
    db: Any, user_id: int, metric_date: date, *, allow_ai: bool = False,
) -> DailyNutritionMetrics:
    """Compute (or recompute) one day's metrics. Idempotent: upserts by
    (user_id, metric_date). Returns the persisted row.

    `allow_ai` is False by default — backfill controls when AI is allowed to
    save cost. Live callers can pass True to classify on first sight.
    """
    raw = _gather_raw_signals(db, user_id, metric_date, allow_ai=allow_ai)
    scores = _compute_scores(raw)

    existing = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date == metric_date)
    ).first()

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)

    if existing:
        row = existing
    else:
        row = DailyNutritionMetrics(user_id=user_id, metric_date=metric_date)
        db.add(row)

    row.metrics_version = METRICS_VERSION
    row.classifier_version_used = CLASSIFIER_VERSION
    row.calories_total = raw.calories_total
    row.fiber_total_g = raw.fiber_total_g
    row.fiber_per_1000_kcal = raw.fiber_per_1000_kcal
    row.distinct_plant_foods = raw.distinct_plant_foods
    row.fermented_servings = raw.fermented_servings
    row.omega3_servings = raw.omega3_servings
    row.processing_counts = raw.processing_counts
    row.saturated_fat_g = raw.saturated_fat_g
    row.gut_support_score = scores["gut_support"]
    row.food_quality_score = scores["food_quality"]
    row.longevity_signals_score = scores["longevity_signals"]
    row.plant_slugs = raw.plant_slugs
    row.item_count = raw.item_count
    row.classified_item_count = raw.classified_item_count
    row.updated_at = now

    db.commit()
    db.refresh(row)
    return row


def compute_weekly_rollup(db: Any, user_id: int, end_date: date, *, days: int = 7) -> dict:
    """Return a 7-day summary derived from already-computed daily rows.
    Does NOT recompute days — callers should ensure backfill ran."""
    start = end_date - timedelta(days=days - 1)
    rows = db.exec(
        select(DailyNutritionMetrics)
        .where(DailyNutritionMetrics.user_id == user_id)
        .where(DailyNutritionMetrics.metric_date >= start)
        .where(DailyNutritionMetrics.metric_date <= end_date)
        .order_by(DailyNutritionMetrics.metric_date.asc())
    ).all()

    if not rows:
        return {
            "days_with_data": 0, "window_days": days,
            "avg_fiber_g": 0.0, "avg_fiber_per_1000_kcal": 0.0,
            "pct_days_fiber_target": 0.0,
            "distinct_plant_foods_week": 0,
            "fermented_servings": 0.0, "omega3_servings": 0.0,
            "processing_counts": {},
            "avg_gut_support_score": 0.0, "avg_food_quality_score": 0.0,
            "avg_longevity_signals_score": 0.0,
        }

    n = len(rows)
    weekly_slugs: set[str] = set()
    for r in rows:
        for s in (r.plant_slugs or []):
            weekly_slugs.add(s)

    days_hitting_fiber = sum(1 for r in rows if r.fiber_total_g >= FIBER_TARGET_G)

    proc_totals: dict[str, int] = {}
    for r in rows:
        for bucket, count in (r.processing_counts or {}).items():
            proc_totals[bucket] = proc_totals.get(bucket, 0) + int(count)

    def _avg(field: str) -> float:
        return round(sum(getattr(r, field) for r in rows) / n, 1)

    return {
        "days_with_data": n, "window_days": days,
        "avg_fiber_g": _avg("fiber_total_g"),
        "avg_fiber_per_1000_kcal": _avg("fiber_per_1000_kcal"),
        "pct_days_fiber_target": round(100 * days_hitting_fiber / n, 0),
        "distinct_plant_foods_week": len(weekly_slugs),
        "fermented_servings": round(sum(r.fermented_servings for r in rows), 1),
        "omega3_servings": round(sum(r.omega3_servings for r in rows), 1),
        "processing_counts": proc_totals,
        "avg_gut_support_score": _avg("gut_support_score"),
        "avg_food_quality_score": _avg("food_quality_score"),
        "avg_longevity_signals_score": _avg("longevity_signals_score"),
    }


# ── Internals ────────────────────────────────────────────────────────────────

def _gather_raw_signals(
    db: Any, user_id: int, metric_date: date, *, allow_ai: bool,
) -> DailyRawSignals:
    # Pull all meal items for this user+date.
    meal_ids = [
        m.id for m in db.exec(
            select(Meal).where(Meal.user_id == user_id).where(Meal.meal_date == metric_date)
        ).all()
    ]
    if not meal_ids:
        return DailyRawSignals(
            calories_total=0, fiber_total_g=0, fiber_per_1000_kcal=0,
            distinct_plant_foods=0, fermented_servings=0, omega3_servings=0,
            processing_counts={}, saturated_fat_g=0, plant_slugs=[],
            item_count=0, classified_item_count=0,
        )
    items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
    if not items:
        return DailyRawSignals(
            calories_total=0, fiber_total_g=0, fiber_per_1000_kcal=0,
            distinct_plant_foods=0, fermented_servings=0, omega3_servings=0,
            processing_counts={}, saturated_fat_g=0, plant_slugs=[],
            item_count=0, classified_item_count=0,
        )

    # Bulk-load FoodNutrition for items that link to a library food.
    food_ids = [i.food_id for i in items if i.food_id is not None]
    nut_by_food: dict[int, FoodNutrition] = {}
    if food_ids:
        for n in db.exec(select(FoodNutrition).where(FoodNutrition.food_id.in_(food_ids))).all():
            nut_by_food[n.food_id] = n

    calories_total = 0.0
    fiber_total_g = 0.0
    saturated_fat_g = 0.0
    fermented_servings = 0.0
    omega3_servings = 0.0
    processing_counts: dict[str, int] = {}
    plant_slugs: set[str] = set()
    classified_count = 0

    for item in items:
        calories_total += float(item.calories or 0)
        # Fiber + sat fat from FoodNutrition scaled to serving grams, if we have it.
        nut = nut_by_food.get(item.food_id) if item.food_id else None
        grams_consumed = float(item.serving_grams or 0)
        if nut and grams_consumed > 0 and nut.reference_grams > 0:
            scale = grams_consumed / float(nut.reference_grams)
            if nut.fiber is not None:
                fiber_total_g += float(nut.fiber) * scale
            extras = nut.extra_nutrients or {}
            sat = extras.get("saturated_fat")
            if sat is not None:
                try: saturated_fat_g += float(sat) * scale
                except Exception: pass

        # Classification (uses cache, may call AI when allowed).
        meta = get_or_create_metadata(item.food_name, db=db, allow_ai=allow_ai)
        if meta.source != "unknown" or meta.confidence > 0:
            classified_count += 1

        if meta.fermented_flag:
            fermented_servings += 1.0
        if meta.omega3_flag:
            omega3_servings += 1.0

        bucket = meta.processing_bucket or "unknown"
        processing_counts[bucket] = processing_counts.get(bucket, 0) + 1

        # Plants: only count confident hits so we don't inflate diversity.
        if meta.likely_plant_foods and meta.confidence >= 0.5:
            for slug in meta.likely_plant_foods:
                plant_slugs.add(slug)

    fiber_per_1000 = (fiber_total_g / calories_total * 1000.0) if calories_total > 0 else 0.0

    return DailyRawSignals(
        calories_total=round(calories_total, 1),
        fiber_total_g=round(fiber_total_g, 1),
        fiber_per_1000_kcal=round(fiber_per_1000, 1),
        distinct_plant_foods=len(plant_slugs),
        fermented_servings=fermented_servings,
        omega3_servings=omega3_servings,
        processing_counts=processing_counts,
        saturated_fat_g=round(saturated_fat_g, 1),
        plant_slugs=sorted(plant_slugs),
        item_count=len(items),
        classified_item_count=classified_count,
    )


# ── Scoring ──────────────────────────────────────────────────────────────────
#
# Each score is 0-100. Individual pillars are transparent with known max points.
# When data coverage is poor (classified_item_count / item_count < 0.5) we
# return a neutral-ish score instead of a confident one.

def _compute_scores(r: DailyRawSignals) -> dict[str, float]:
    if r.item_count == 0:
        return {"gut_support": 0.0, "food_quality": 0.0, "longevity_signals": 0.0}

    coverage = (r.classified_item_count / r.item_count) if r.item_count else 0.0
    # Gut Support: fiber (40), plant diversity (40), fermented (20).
    fiber_pts = _curve(r.fiber_total_g, low=10, mid=25, target=FIBER_TARGET_G, out_of=40)
    plant_pts = _plants_to_points(r.distinct_plant_foods, out_of=40)
    ferm_pts = min(20.0, r.fermented_servings * 10.0)   # 2 servings = full credit
    gut_support = fiber_pts + plant_pts + ferm_pts

    # Food Quality: processing mix (70), saturated-fat context (30).
    processed = sum(r.processing_counts.values()) or 1
    upf_ratio = r.processing_counts.get("ultra_processed", 0) / processed
    min_ratio = r.processing_counts.get("minimally_processed", 0) / processed
    quality_proc = max(0.0, 70.0 * (min_ratio - 0.6 * upf_ratio))  # minimally-processed good, UPF bad
    # Saturated fat: within ~10% of calories is fine; heavy excess hurts.
    sat_cal_ratio = (r.saturated_fat_g * 9.0) / r.calories_total if r.calories_total > 0 else 0.0
    if sat_cal_ratio <= 0.08: quality_sat = 30.0
    elif sat_cal_ratio <= 0.12: quality_sat = 22.0
    elif sat_cal_ratio <= 0.16: quality_sat = 14.0
    else: quality_sat = 6.0
    food_quality = quality_proc + quality_sat

    # Longevity signals: diversity (35), fiber/1000 (25), fermented (15),
    # omega-3 (15), low UPF (10).
    diversity_pts = _plants_to_points(r.distinct_plant_foods, out_of=35)
    fiber1k_pts = _curve(r.fiber_per_1000_kcal, low=6, mid=10, target=FIBER_TARGET_PER_1000, out_of=25)
    ferm_pts_l = min(15.0, r.fermented_servings * 7.5)
    omega_pts = min(15.0, r.omega3_servings * 7.5)
    upf_pts = max(0.0, 10.0 * (1.0 - upf_ratio))
    longevity = diversity_pts + fiber1k_pts + ferm_pts_l + omega_pts + upf_pts

    # Degrade scores when coverage is poor so we don't pretend to know.
    coverage_factor = 0.6 + 0.4 * min(1.0, coverage)
    return {
        "gut_support": round(min(100.0, gut_support * coverage_factor), 1),
        "food_quality": round(min(100.0, food_quality * coverage_factor), 1),
        "longevity_signals": round(min(100.0, longevity * coverage_factor), 1),
    }


def _curve(value: float, *, low: float, mid: float, target: float, out_of: float) -> float:
    """Piecewise linear: 0 at low, out_of*0.6 at mid, out_of at target, cap at out_of."""
    if value <= low: return 0.0
    if value >= target: return out_of
    if value <= mid:
        return out_of * 0.6 * (value - low) / (mid - low)
    return out_of * 0.6 + (out_of * 0.4) * (value - mid) / (target - mid)


def _plants_to_points(distinct: int, *, out_of: float) -> float:
    # 30 different plants / week is the "gold" target → daily equivalent ~4.
    # Daily bands: 0 = 0, 2 = 30%, 4 = 70%, 6+ = full.
    if distinct <= 0: return 0.0
    if distinct >= 6: return out_of
    if distinct <= 2: return out_of * 0.30 * (distinct / 2.0)
    if distinct <= 4: return out_of * 0.30 + out_of * 0.40 * ((distinct - 2) / 2.0)
    return out_of * 0.70 + out_of * 0.30 * ((distinct - 4) / 2.0)
