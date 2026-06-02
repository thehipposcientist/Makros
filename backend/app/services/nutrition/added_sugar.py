"""Added-sugar normalization for provider gaps."""

from __future__ import annotations

import re
from typing import Any


_NO_ADDED_RE = re.compile(
    r"\b(unsweetened|no sugar added|without added sugar|sugar[- ]free|zero sugar|diet)\b",
    re.IGNORECASE,
)
_PLAIN_DAIRY_RE = re.compile(
    r"\b(plain|unsweetened)\b.*\b(milk|yogurt|yoghurt|kefir)\b|"
    r"\b(milk|yogurt|yoghurt|kefir)\b.*\b(plain|unsweetened)\b",
    re.IGNORECASE,
)
_MILKSHAKE_RE = re.compile(
    r"\b(milk\s*shake|milkshake|malted?|frappe|frappuccino|blizzard|mcflurry)\b",
    re.IGNORECASE,
)
_SWEETENED_DAIRY_RE = re.compile(
    r"\b(chocolate\s+milk|flavored\s+milk|ice\s*cream|gelato|frozen\s+yogurt|pudding|custard)\b|"
    r"\b(vanilla|chocolate|strawberry|blueberry|fruit)\b.*\b(milk|yogurt|yoghurt|kefir)\b|"
    r"\b(milk|yogurt|yoghurt|kefir)\b.*\b(vanilla|chocolate|strawberry|blueberry|fruit)\b",
    re.IGNORECASE,
)
_MOSTLY_ADDED_RE = re.compile(
    r"\b(soda|cola|soft drink|energy drink|sports drink|lemonade|sweet tea|"
    r"fruit punch|fruit drink|juice cocktail|candy|gummies|syrup|frosting|"
    r"cookie|brownie|cake|cupcake|donut|doughnut|pastry|pie|cheesecake|muffin|"
    r"sweet roll|cinnamon roll|pop tart|poptart|churro|cobbler|sorbet|sherbet|popsicle)\b",
    re.IGNORECASE,
)
_ADDED_SIGNAL_RE = re.compile(
    r"\b(sweetened|candied|glazed|caramel|chocolate|fudge|icing|sprinkles)\b",
    re.IGNORECASE,
)
_WHOLE_NATURAL_SUGAR_RE = re.compile(
    r"\b(apple|banana|orange|grape|grapes|berry|berries|strawberry|strawberries|"
    r"blueberry|blueberries|raspberry|raspberries|mango|pineapple|peach|pear|"
    r"melon|watermelon|cantaloupe|kiwi|date|dates|raisin|raisins|fig|figs|"
    r"prune|prunes|milk)\b",
    re.IGNORECASE,
)


def _to_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed:
        return None
    return parsed


def _round_g(value: float, total_sugar_g: float | None = None) -> float:
    value = max(0.0, value)
    if total_sugar_g is not None and total_sugar_g > 0:
        value = min(value, total_sugar_g)
    return round(value, 1)


def _dairy_natural_sugar_allowance(total_sugar_g: float, serving_grams: float | None) -> float:
    if serving_grams is not None and serving_grams > 0:
        return min(total_sugar_g * 0.55, serving_grams * 0.05)
    return min(total_sugar_g * 0.4, 12.0)


def estimate_added_sugar_g(
    name: str | None,
    *,
    sugar_g: Any,
    serving_grams: Any = None,
) -> float | None:
    """Estimate added sugar only when provider data is absent for clear cases.

    USDA nutrient #1235 wins whenever present. This fallback covers common
    provider/AI gaps where total sugar is known but added sugar is omitted,
    such as milkshakes and sweetened drinks/desserts.
    """
    sugar = _to_float(sugar_g)
    if sugar is None:
        return None
    if sugar <= 0:
        return 0.0

    text = str(name or "").strip().lower()
    if not text:
        return None
    grams = _to_float(serving_grams)

    if _NO_ADDED_RE.search(text) or _PLAIN_DAIRY_RE.search(text):
        return 0.0
    if _MILKSHAKE_RE.search(text) or _SWEETENED_DAIRY_RE.search(text):
        natural = _dairy_natural_sugar_allowance(sugar, grams)
        return _round_g(sugar - natural, sugar)
    if _MOSTLY_ADDED_RE.search(text):
        return _round_g(sugar, sugar)
    if _ADDED_SIGNAL_RE.search(text):
        return _round_g(sugar * 0.75, sugar)
    if _WHOLE_NATURAL_SUGAR_RE.search(text):
        return 0.0
    return None


def resolve_added_sugar_g(
    name: str | None,
    *,
    reported_added_sugar_g: Any = None,
    sugar_g: Any = None,
    serving_grams: Any = None,
) -> float | None:
    reported = _to_float(reported_added_sugar_g)
    sugar = _to_float(sugar_g)
    if reported is not None and reported > 0:
        return _round_g(reported, sugar)

    estimate = estimate_added_sugar_g(name, sugar_g=sugar, serving_grams=serving_grams)
    if estimate is not None:
        return estimate
    return reported
