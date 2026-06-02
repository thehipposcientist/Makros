"""Supplement usage guidance tests.

Pure helper coverage for cycle/short-term guidance and history-aware
insight triggers. No DB, network, or AI.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace as NS


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_usage_guidance_only_for_relevant_supplements() -> None:
    print("\n[test] usage guidance: relevant supplements only")
    from app.services.supplement_usage import supplement_usage_guidance

    assert supplement_usage_guidance(name="Creatine monohydrate") is None
    assert supplement_usage_guidance(name="Whey protein") is None

    caffeine = supplement_usage_guidance(name="Caffeine", dose_amount=300, dose_unit="mg")
    assert caffeine is not None
    assert caffeine["slug"] == "caffeine"
    assert caffeine["cycle_candidate"] is True
    assert caffeine["severity"] == "warning"
    assert "large stimulant dose" in caffeine["body"]

    melatonin = supplement_usage_guidance(name="Melatonin 1mg")
    assert melatonin is not None
    assert melatonin["slug"] == "melatonin"
    assert "short" in melatonin["cadence"].lower()
    _ok("guidance is scoped and dose-aware")


def test_usage_guidance_high_zinc_copy() -> None:
    print("\n[test] usage guidance: high zinc dose copy")
    from app.services.supplement_usage import supplement_usage_guidance

    zinc = supplement_usage_guidance(name="Zinc", dose_amount=50, dose_unit="mg")
    assert zinc is not None
    assert zinc["slug"] == "zinc"
    assert "upper-limit" in zinc["body"]
    assert zinc["severity"] == "warning"
    _ok("high-dose zinc gets stronger guidance")


def test_usage_insights_from_history() -> None:
    print("\n[test] usage insights: history-aware triggers")
    from app.services.supplement_usage import build_usage_guidance_insights

    today = date(2026, 5, 21)
    stack = [
        NS(id=1, custom_name="Caffeine", supplement_ingredient_id=None, dose_amount=200, dose_unit="mg", category="performance"),
        NS(id=2, custom_name="Melatonin", supplement_ingredient_id=None, dose_amount=1, dose_unit="mg", category="sleep"),
        NS(id=3, custom_name="Zinc", supplement_ingredient_id=None, dose_amount=30, dose_unit="mg", category="mineral"),
    ]
    logs = []
    base = datetime(2026, 5, 21, 13, 0, tzinfo=timezone.utc)
    for i in range(10):
        logs.append(NS(stack_item_id=1, skipped=False, taken_at=base - timedelta(days=i), dose_amount=200, dose_unit="mg"))
    logs.append(NS(stack_item_id=1, skipped=False, taken_at=base, dose_amount=250, dose_unit="mg"))
    for i in range(14):
        logs.append(NS(stack_item_id=2, skipped=False, taken_at=base - timedelta(days=i), dose_amount=1, dose_unit="mg"))
        logs.append(NS(stack_item_id=3, skipped=False, taken_at=base - timedelta(days=i), dose_amount=30, dose_unit="mg"))

    insights = build_usage_guidance_insights(
        stack=stack,
        ingredients_by_id={},
        logs=logs,
        today=today,
    )
    keys = {i["key"] for i in insights}
    assert "usage_stimulant_frequency" in keys
    assert "usage_high_caffeine_total" in keys
    assert "usage_melatonin_continuity" in keys
    assert "usage_zinc_high_dose" in keys
    _ok("history triggers stimulant, melatonin, and zinc guidance")


cases = [
    test_usage_guidance_only_for_relevant_supplements,
    test_usage_guidance_high_zinc_copy,
    test_usage_insights_from_history,
]


if __name__ == "__main__":
    for case in cases:
        case()
