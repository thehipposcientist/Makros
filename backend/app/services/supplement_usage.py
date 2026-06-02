"""Supplement usage guidance and history-aware insights.

The goal is educational guardrails, not schedule mutation. These helpers
identify supplements where cycling, short-term framing, or lab-guided use
matters enough to surface in the app.
"""
from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from datetime import date, datetime, timedelta
from typing import Any

from app.services.supplement_name_match import infer_slug_from_name


_GUIDANCE_BY_SLUG: dict[str, dict[str, Any]] = {
    "caffeine": {
        "key": "stimulant_tolerance",
        "title": "Use intentionally and protect sleep",
        "body": "Caffeine is best treated as a performance tool, not a daily requirement. If the same dose stops feeling useful, consider lower-stim days or stimulant-free training days instead of pushing the dose up.",
        "cadence": "Keep most doses early; review use if it is logged most days for 2+ weeks.",
        "cycle_candidate": True,
        "severity": "warning",
    },
    "pre_workout": {
        "key": "pre_workout_stimulants",
        "title": "Watch stimulant stacking",
        "body": "Pre-workouts often duplicate caffeine, beta-alanine, citrulline, and focus ingredients. Cycle high-stim formulas when tolerance creeps up, and avoid stacking with coffee or energy drinks unless the total dose is clear.",
        "cadence": "Use for key sessions; consider stimulant-free days between high-stim sessions.",
        "cycle_candidate": True,
        "severity": "warning",
    },
    "melatonin": {
        "key": "short_term_sleep_aid",
        "title": "Keep it occasional or short-term",
        "body": "Melatonin can help shift sleep timing, but it should not become the whole sleep strategy. If it is needed nightly, review light exposure, schedule, caffeine timing, and whether a clinician should weigh in.",
        "cadence": "Best for short blocks, travel, or schedule shifts rather than indefinite nightly use.",
        "cycle_candidate": True,
        "severity": "info",
    },
    "ashwagandha": {
        "key": "botanical_review",
        "title": "Review long-running use",
        "body": "Ashwagandha is a botanical with medication, thyroid, pregnancy, and rare liver-safety cautions. If it stays in the stack for months, treat that as a reason to reassess benefit and fit.",
        "cadence": "Reassess after a few months of continuous use.",
        "cycle_candidate": True,
        "severity": "warning",
    },
    "zinc": {
        "key": "high_dose_mineral",
        "title": "Avoid chronic high-dose zinc",
        "body": "Zinc is useful when intake is low, but chronic high supplemental doses can create copper issues and other side effects. Long runs at higher doses should be intentional, not automatic.",
        "cadence": "Review dose if taking 30-40mg+ daily for multiple weeks.",
        "cycle_candidate": True,
        "severity": "warning",
    },
    "green_tea_extract": {
        "key": "concentrated_extract",
        "title": "Use extract cautiously",
        "body": "Concentrated green tea extract is different from drinking tea. Avoid taking it on an empty stomach, and reassess long continuous runs or stacking with other stimulant or weight-loss products.",
        "cadence": "Review after several weeks of continuous extract use.",
        "cycle_candidate": True,
        "severity": "warning",
    },
}


def _field(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, dict):
        return source.get(name, default)
    return getattr(source, name, default)


def _float_value(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _canonical_slug(
    *,
    slug: str | None = None,
    name: str | None = None,
    category: str | None = None,
) -> str | None:
    raw = (slug or "").strip()
    if raw:
        return raw
    text = " ".join(part for part in [name, category] if part)
    return infer_slug_from_name(text)


def supplement_usage_guidance(
    *,
    slug: str | None = None,
    name: str | None = None,
    category: str | None = None,
    dose_amount: float | int | None = None,
    dose_unit: str | None = None,
) -> dict[str, Any] | None:
    canonical = _canonical_slug(slug=slug, name=name, category=category)
    if not canonical or canonical not in _GUIDANCE_BY_SLUG:
        return None
    guidance = deepcopy(_GUIDANCE_BY_SLUG[canonical])
    guidance["slug"] = canonical

    unit = (dose_unit or "").strip().lower()
    amount = _float_value(dose_amount)

    if canonical == "zinc" and amount is not None and unit == "mg" and amount >= 40:
        guidance["body"] = (
            "This zinc dose is at or above the common adult upper-limit range. "
            "Avoid making it a long-term default unless a clinician directed it, "
            "and watch for copper duplication or depletion issues."
        )
        guidance["severity"] = "warning"
    elif canonical in {"caffeine", "pre_workout"} and amount is not None and unit == "mg" and amount >= 300:
        guidance["body"] = (
            "This is a large stimulant dose for many people. Keep the total daily "
            "caffeine picture in view across coffee, energy drinks, and pre-workout, "
            "and cycle down when sleep or tolerance starts drifting."
        )
        guidance["severity"] = "warning"
    return guidance


def item_usage_guidance(item: Any, ingredient: Any | None = None) -> dict[str, Any] | None:
    return supplement_usage_guidance(
        slug=_field(ingredient, "slug"),
        name=_field(ingredient, "name") or _field(item, "custom_name") or _field(item, "ingredient_name"),
        category=_field(ingredient, "category") or _field(item, "category"),
        dose_amount=_field(item, "dose_amount"),
        dose_unit=_field(item, "dose_unit"),
    )


def build_usage_guidance_insights(
    *,
    stack: list[Any],
    ingredients_by_id: dict[int, Any],
    logs: list[Any],
    today: date | None = None,
) -> list[dict[str, Any]]:
    today = today or date.today()
    stack_by_id = {int(_field(item, "id")): item for item in stack if _field(item, "id") is not None}
    slug_by_stack_id: dict[int, str] = {}
    name_by_stack_id: dict[int, str] = {}

    for item_id, item in stack_by_id.items():
        ingredient = ingredients_by_id.get(_field(item, "supplement_ingredient_id"))
        guidance = item_usage_guidance(item, ingredient)
        if not guidance:
            continue
        slug_by_stack_id[item_id] = guidance["slug"]
        name_by_stack_id[item_id] = (
            _field(item, "custom_name")
            or _field(ingredient, "name")
            or "Supplement"
        )

    taken_by_slug: dict[str, set[date]] = defaultdict(set)
    caffeine_mg_by_date: dict[date, float] = defaultdict(float)
    for log in logs:
        if _field(log, "skipped"):
            continue
        stack_item_id = _field(log, "stack_item_id")
        if stack_item_id is None:
            continue
        slug = slug_by_stack_id.get(int(stack_item_id))
        if not slug:
            continue
        taken_at = _field(log, "taken_at")
        if not isinstance(taken_at, datetime):
            continue
        log_date = taken_at.date()
        if log_date < today - timedelta(days=30):
            continue
        taken_by_slug[slug].add(log_date)
        if slug in {"caffeine", "pre_workout"} and str(_field(log, "dose_unit") or "").lower() == "mg":
            try:
                caffeine_mg_by_date[log_date] += float(_field(log, "dose_amount") or 0)
            except (TypeError, ValueError):
                pass

    insights: list[dict[str, Any]] = []

    stimulant_days_14 = len({
        day
        for slug in ("caffeine", "pre_workout")
        for day in taken_by_slug.get(slug, set())
        if day >= today - timedelta(days=14)
    })
    if stimulant_days_14 >= 10:
        insights.append({
            "key": "usage_stimulant_frequency",
            "severity": "warning",
            "title": f"Stimulants logged {stimulant_days_14}/14 days",
            "body": "Frequent caffeine or pre-workout use can make the same dose feel less useful. Consider lower-stim or stimulant-free sessions before increasing dose.",
        })

    high_caffeine_days = [
        day for day, total in caffeine_mg_by_date.items()
        if day >= today - timedelta(days=30) and total >= 400
    ]
    if high_caffeine_days:
        insights.append({
            "key": "usage_high_caffeine_total",
            "severity": "warning",
            "title": f"High caffeine total on {len(high_caffeine_days)} day{'s' if len(high_caffeine_days) != 1 else ''}",
            "body": "Your logged stimulant supplements reached 400mg+ on at least one day. Include coffee and energy drinks when judging the real total.",
        })

    melatonin_days = len(taken_by_slug.get("melatonin", set()))
    if melatonin_days >= 14:
        insights.append({
            "key": "usage_melatonin_continuity",
            "severity": "info",
            "title": f"Melatonin logged {melatonin_days}/30 days",
            "body": "Melatonin is usually best as short-term timing support. If it is becoming nightly, review sleep routine, light exposure, and late caffeine.",
        })

    for slug in ("ashwagandha", "green_tea_extract"):
        days = len(taken_by_slug.get(slug, set()))
        if days >= 21:
            label = "Ashwagandha" if slug == "ashwagandha" else "Green tea extract"
            insights.append({
                "key": f"usage_{slug}_review",
                "severity": "warning",
                "title": f"{label} logged {days}/30 days",
                "body": "This is a long continuous run for a botanical or concentrated extract. Reassess benefit, dose, and interactions instead of leaving it on autopilot.",
            })

    zinc_items = [
        item for item_id, item in stack_by_id.items()
        if slug_by_stack_id.get(item_id) == "zinc"
    ]
    high_zinc = [
        item for item in zinc_items
        if str(_field(item, "dose_unit") or "").lower() == "mg"
        and (_float_value(_field(item, "dose_amount")) or 0) >= 30
    ]
    zinc_days = len(taken_by_slug.get("zinc", set()))
    if high_zinc and zinc_days >= 14:
        label = name_by_stack_id.get(int(_field(high_zinc[0], "id")), "Zinc")
        insights.append({
            "key": "usage_zinc_high_dose",
            "severity": "warning",
            "title": f"{label} logged {zinc_days}/30 days",
            "body": "High-dose zinc is worth reviewing after a few weeks because chronic use can affect copper balance and cause side effects.",
        })

    return insights
