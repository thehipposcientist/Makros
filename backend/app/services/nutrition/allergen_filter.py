"""Post-generation allergen filter for nutrition plans.

Runs AFTER AI meal generation to catch any allergen-containing items
that slipped through prompt-level instructions. This is a safety net,
not a replacement for the AI prompt — the prompt still tells the AI
to avoid allergens so the meal makes culinary sense.

Usage:
    from app.services.nutrition.allergen_filter import filter_allergens
    filter_allergens(plans_list, allergens=["dairy", "gluten"])
"""
from __future__ import annotations

import re


# Allergen category → food name keywords that indicate presence.
# Keys are the canonical allergen names the client sends.
ALLERGEN_KEYWORDS: dict[str, list[str]] = {
    "peanuts": ["peanut", "peanut butter"],
    "tree_nuts": [
        "almond", "walnut", "cashew", "pecan", "pistachio",
        "macadamia", "hazelnut", "brazil nut", "pine nut",
    ],
    "dairy": [
        "milk", "cheese", "yogurt", "cream", "butter", "whey",
        "casein", "ghee", "kefir", "skyr", "ricotta", "mozzarella",
        "cheddar", "parmesan", "feta", "cottage cheese",
    ],
    "gluten": [
        "wheat", "bread", "pasta", "flour", "tortilla", "bagel",
        "cereal", "cracker", "couscous", "barley", "rye",
        "croissant", "muffin", "pancake", "waffle", "naan",
    ],
    "soy": ["soy", "tofu", "tempeh", "edamame", "soybean"],
    "eggs": ["egg", "eggs", "omelette", "omelet", "frittata"],
    "shellfish": [
        "shrimp", "crab", "lobster", "mussel", "clam", "oyster",
        "scallop", "crawfish", "crayfish", "prawn",
    ],
    "fish": [
        "salmon", "tuna", "cod", "tilapia", "halibut", "sardine",
        "mackerel", "trout", "bass", "anchovy", "swordfish",
        "mahi", "snapper", "catfish", "haddock", "pollock",
    ],
}


def _item_matches_allergen(item_name: str, keywords: list[str]) -> bool:
    """Check if a food item name contains any allergen keyword.

    Uses a permissive word-boundary match that ALSO accepts a trailing
    plural 's' or 'es' so 'walnuts' matches 'walnut', 'almonds' matches
    'almond', 'eggs' matches 'egg'. Without this, the AI returning a
    plural form would slip the allergen past the filter — a real safety
    issue for users with declared allergies.

    Multi-word keywords ('peanut butter', 'cottage cheese', 'pine nut')
    are still anchored on word boundaries; the plural relaxation only
    applies at the END of the keyword.
    """
    name_lower = item_name.lower()
    for kw in keywords:
        # Anchor at word start; allow trailing 's' or 'es' for plural.
        pattern = r'\b' + re.escape(kw) + r'(?:es|s)?\b'
        if re.search(pattern, name_lower):
            return True
    return False


def filter_allergens(
    plans_list: list[dict],
    allergens: list[str] | None = None,
) -> int:
    """Remove allergen-matching items from nutrition plan meals in-place.

    Args:
        plans_list: list of nutrition plan dicts, each with a "meals" key.
        allergens: list of allergen category strings (e.g. ["dairy", "gluten"]).

    Returns:
        Number of items removed.
    """
    if not allergens or not plans_list:
        return 0

    # Build combined keyword list from all requested allergen categories
    blocked_keywords: list[str] = []
    for allergen in allergens:
        allergen_key = allergen.strip().lower().replace(" ", "_")
        keywords = ALLERGEN_KEYWORDS.get(allergen_key, [])
        if keywords:
            blocked_keywords.extend(keywords)
        else:
            # Treat the raw allergen string as a keyword itself
            blocked_keywords.append(allergen_key)

    if not blocked_keywords:
        return 0

    removed_count = 0
    for np_ in plans_list:
        if not isinstance(np_, dict):
            continue
        for meal in np_.get("meals") or []:
            if not isinstance(meal, dict):
                continue
            items = meal.get("items")
            if not items or not isinstance(items, list):
                continue
            filtered = []
            for it in items:
                if not isinstance(it, dict):
                    filtered.append(it)
                    continue
                name = it.get("name", "")
                if _item_matches_allergen(name, blocked_keywords):
                    print(f"[allergen-filter] removed '{name}' — matches allergen filter")
                    removed_count += 1
                else:
                    filtered.append(it)
            if len(filtered) != len(items):
                meal["items"] = filtered
                # Re-sum meal macros from remaining items. Skip non-dict
                # items (preserved earlier as-is) so the sum doesn't
                # crash on `.get` against a string.
                dict_items = [it for it in filtered if isinstance(it, dict)]
                meal["calories"] = sum(it.get("calories", 0) for it in dict_items)
                meal["protein"] = sum(it.get("protein", 0) for it in dict_items)
                meal["carbs"] = sum(it.get("carbs", 0) for it in dict_items)
                meal["fat"] = sum(it.get("fat", 0) for it in dict_items)
                if any(it.get("fiber") for it in dict_items):
                    meal["fiber"] = round(sum(it.get("fiber", 0) for it in dict_items), 1)

    if removed_count:
        print(f"[allergen-filter] total items removed: {removed_count}")
    return removed_count
