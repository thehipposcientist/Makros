"""
Deterministic meal-skeleton generator.

Replaces `meal_assembler.call_skeleton_ai` — the last AI surface on plan
generation — with a pure-python implementation that produces the exact
same output shape (a list of `TemplateSkeleton`s plus note + supps) from
the user's profile + allowed-foods list.

Pipeline
========

    PlanRequest ── archetype rotation ── pantry resolver ── MealSkeleton[]

    1. Clamp mealsPerDay, variety_n.
    2. For each day 0..variety_n-1:
         for each meal slot 0..mealsPerDay-1:
             a. pick an archetype row (rotated by day_index, offset by slot).
             b. for every role in that archetype (protein/carb/veg/fat):
                  pick the best pantry food matching the role keywords that
                  is ALSO compatible with the user's dietary_preference and
                  not blocked by their allergen list.
             c. emit a MealSkeleton with the chosen food_refs.
         If any slot lands with zero foods → deterministic fallback meal
         (whey + banana, or equivalent within the pantry) so we never emit
         an empty skeleton.

Why archetype rotation over "pick N random meals"
-------------------------------------------------
  * Reproducible — identical inputs produce identical output, so regen
    with the same pantry lands on the same plan. No temperature, no RNG.
  * Variety — rotating the archetype index by day_index (and by slot)
    guarantees that day N and day N+1 hit different combinations while
    still visiting every archetype row across 7 days.
  * Maintenance — adding a new breakfast archetype is a one-line append.

The archetype lists deliberately overlap with `_PROTEIN_KEYWORDS` /
`_CARB_KEYWORDS` / `_VEG_KEYWORDS` / `_FAT_KEYWORDS` in `meal_assembler.py`
— we re-use those keyword sets rather than re-declaring them so future
additions propagate automatically.

The downstream pipeline (validate_and_repair_skeletons → enrich_items →
solve_portions → assemble_template) is unchanged. This module produces
the SAME `TemplateSkeleton` shape the AI call produced, so callers don't
notice the swap.
"""
from __future__ import annotations

from typing import Any, TYPE_CHECKING

from .allergen_filter import ALLERGEN_KEYWORDS
from .meal_assembler import (
    MealSkeleton,
    TemplateSkeleton,
    _CARB_KEYWORDS,
    _CARB_KEYWORDS_PREFERRED,
    _FAT_KEYWORDS,
    _PROTEIN_KEYWORDS,
    _VEG_KEYWORDS,
    _clamp_meals_per_day,
    _food_matches_keywords,
)

if TYPE_CHECKING:
    from app.routers.ai.models import PlanRequest


# ─────────────────────────────────────────────────────────────────────────────
# Archetypes
# ─────────────────────────────────────────────────────────────────────────────
#
# Each archetype is a small dict describing which category to fill for
# every role. The `role_sets` field is a list of role names in the order
# they should be picked. Role names map to keyword sets via `_ROLE_KEYWORDS`
# below — that indirection means adding "whole_grain" or "dairy" roles
# later is a single-line change, not a fork of every archetype.
#
# The archetypes are tuned so that across 7 days each slot visits a mix
# of protein sources, carb types, and fat sources. Index 0 is the most
# "defaultive" meal (eggs + oats + fruit for breakfast, chicken + rice +
# broccoli for lunch/dinner) — if the pantry only supports archetype 0
# everyone still gets a real meal.

# Role → keyword set. Re-uses the existing `meal_assembler` constants so
# we only have one source of truth for what counts as a protein / carb /
# vegetable / fat source. `carb_whole` is the preferred-carb subset
# (brown rice, quinoa, oats) that we try BEFORE falling back to the
# broader _CARB_KEYWORDS list.
_ROLE_KEYWORDS: dict[str, set[str]] = {
    "protein": _PROTEIN_KEYWORDS,
    "carb": _CARB_KEYWORDS,
    "carb_whole": _CARB_KEYWORDS_PREFERRED,
    "veg": _VEG_KEYWORDS,
    "fat": _FAT_KEYWORDS,
}

# Archetype shape: list of roles that the pantry resolver will fill.
# The resolver walks roles in order and returns as many filled picks as
# it can — missing roles degrade gracefully instead of failing the meal.
#
# Breakfast leans fruit-and-oats / eggs-and-toast shaped.
# Lunch + dinner lean lean-protein + starch + veg.
# Snacks are small: protein + carb OR protein + fat, never full plates.
#
# Having more archetypes than the user will see in a week means we never
# repeat the same pattern on consecutive days even for variety=7.

_BREAKFAST_ARCHETYPES: list[list[str]] = [
    ["protein", "carb_whole", "fat"],        # eggs + oats + nut butter
    ["protein", "carb", "fat"],              # eggs + toast + avocado
    ["protein", "carb_whole", "veg"],        # eggs + oats + spinach scramble
    ["protein", "carb_whole", "fat", "veg"], # yogurt + oats + nuts + berries
    ["protein", "fat", "carb"],              # cottage cheese + almonds + bagel
    ["protein", "carb_whole"],               # yogurt parfait + oats (light)
    ["protein", "carb", "fat", "veg"],       # omelette + toast + avo + greens
]

_LUNCH_ARCHETYPES: list[list[str]] = [
    ["protein", "carb_whole", "veg", "fat"], # chicken + brown rice + broccoli + olive oil
    ["protein", "carb", "veg", "fat"],       # turkey + rice + spinach + oil
    ["protein", "carb_whole", "veg"],        # lean fish + quinoa + greens
    ["protein", "veg", "fat"],               # chicken salad + avocado (low carb)
    ["protein", "carb", "fat"],              # tuna + pasta + olive oil
    ["protein", "carb_whole", "fat"],        # chicken + sweet potato + nuts
    ["protein", "carb", "veg", "fat"],       # beef bowl
]

_DINNER_ARCHETYPES: list[list[str]] = [
    ["protein", "carb_whole", "veg", "fat"], # steak + sweet potato + asparagus + butter
    ["protein", "carb", "veg", "fat"],       # salmon + rice + greens + oil
    ["protein", "carb_whole", "veg"],        # chicken + quinoa + veg
    ["protein", "veg", "fat"],               # chicken thighs + veg + olive oil
    ["protein", "carb", "fat"],              # pork + pasta + parmesan
    ["protein", "carb_whole", "fat"],        # fish + sweet potato + butter
    ["protein", "carb", "veg", "fat"],       # stir fry (chicken + rice + veg + oil)
]

_SNACK_ARCHETYPES: list[list[str]] = [
    ["protein", "carb"],                     # whey + fruit
    ["protein", "fat"],                      # jerky + nuts
    ["protein", "carb_whole"],               # yogurt + oats
    ["protein", "veg"],                      # cottage cheese + cucumbers
    ["protein", "carb", "fat"],              # protein shake + banana + pb
    ["protein", "carb_whole", "fat"],        # greek yogurt + oats + almonds
]

# Meal-slot type by position — breakfast always first, snack pattern for
# meals beyond 3, dinner always last. For mealsPerDay=1 we default to a
# "dinner" archetype (most likely to be a full plate).
#
# Returned list length always equals `meals_per_day`.
_SLOT_TYPE_BY_POSITION: dict[int, list[str]] = {
    1: ["dinner"],
    2: ["breakfast", "dinner"],
    3: ["breakfast", "lunch", "dinner"],
    4: ["breakfast", "lunch", "snack", "dinner"],
    5: ["breakfast", "snack", "lunch", "snack", "dinner"],
    6: ["breakfast", "snack", "lunch", "snack", "dinner", "snack"],
    7: ["breakfast", "snack", "lunch", "snack", "dinner", "snack", "snack"],
    8: ["breakfast", "snack", "snack", "lunch", "snack", "dinner", "snack", "snack"],
    9: ["breakfast", "snack", "snack", "lunch", "snack", "snack", "dinner", "snack", "snack"],
    10: ["breakfast", "snack", "snack", "lunch", "snack", "snack", "dinner", "snack", "snack", "snack"],
}

_ARCHETYPES_BY_SLOT: dict[str, list[list[str]]] = {
    "breakfast": _BREAKFAST_ARCHETYPES,
    "lunch": _LUNCH_ARCHETYPES,
    "dinner": _DINNER_ARCHETYPES,
    "snack": _SNACK_ARCHETYPES,
}


# ─────────────────────────────────────────────────────────────────────────────
# Dietary preference + allergen gating
# ─────────────────────────────────────────────────────────────────────────────


# Keywords that indicate a food contains animal products. Used by the
# `vegan` / `vegetarian` dietary preferences.
_ANIMAL_MEAT_KEYWORDS: set[str] = {
    "chicken", "beef", "steak", "turkey", "pork", "bacon", "ham",
    "fish", "salmon", "tuna", "shrimp", "tilapia", "cod", "sardine",
    "mackerel", "trout", "bass", "anchovy", "jerky", "lamb", "duck",
    "veal", "liver", "crab", "lobster", "scallop", "prawn", "oyster",
    "mussel", "clam", "squid", "octopus",
}

_ANIMAL_DAIRY_EGGS_KEYWORDS: set[str] = {
    "milk", "cheese", "yogurt", "cream", "butter", "whey", "casein",
    "ghee", "kefir", "skyr", "ricotta", "mozzarella", "cheddar",
    "parmesan", "feta", "cottage cheese", "egg", "eggs", "honey",
}


def _diet_disallows(name: str, dietary_preference: str | None) -> bool:
    """True if a food is incompatible with the user's dietary preference.

    Only `vegan` and `vegetarian` actively filter foods here — everything
    else (pescatarian, keto, etc.) is handled by the user's pantry
    selection during onboarding, which is the upstream filter.
    """
    if not dietary_preference:
        return False
    pref = dietary_preference.strip().lower()
    n = name.lower()
    if pref == "vegan":
        if _food_matches_keywords(n, _ANIMAL_MEAT_KEYWORDS):
            return True
        if _food_matches_keywords(n, _ANIMAL_DAIRY_EGGS_KEYWORDS):
            return True
        return False
    if pref == "vegetarian":
        return _food_matches_keywords(n, _ANIMAL_MEAT_KEYWORDS)
    return False


def _food_is_allergen(name: str, allergens: list[str] | None) -> bool:
    """True if a food triggers one of the user's declared allergies.

    Re-uses `ALLERGEN_KEYWORDS` from `allergen_filter.py` so a single
    declaration covers both pre-generation gating (here) and post-
    generation filtering (the safety net that runs after the AI path).
    """
    if not allergens:
        return False
    lname = name.lower()
    for allergen in allergens:
        key = allergen.strip().lower().replace(" ", "_")
        keywords = ALLERGEN_KEYWORDS.get(key)
        if not keywords:
            # Unknown allergen string — treat it as its own keyword.
            if key and key in lname:
                return True
            continue
        for kw in keywords:
            if kw in lname:
                return True
    return False


def _filter_pantry(
    allowed_foods: list[str],
    dietary_preference: str | None,
    allergies: list[str] | None,
) -> list[str]:
    """Produce the subset of `allowed_foods` compatible with diet + allergies."""
    out: list[str] = []
    for f in allowed_foods:
        if _diet_disallows(f, dietary_preference):
            continue
        if _food_is_allergen(f, allergies):
            continue
        out.append(f)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Pantry resolver
# ─────────────────────────────────────────────────────────────────────────────


def _pick_role(
    role: str,
    pantry: list[str],
    used_in_template: set[str],
    rotation_offset: int,
    preferred_foods: set[str] | None = None,
) -> str | None:
    """Return a food from `pantry` matching `role`, biased away from
    `used_in_template`. `rotation_offset` shifts the starting scan index
    so consecutive calls with the same pantry don't land on the same pick.

    `preferred_foods` — lower-cased names the caller wants biased up.
    Currently used to give user-added custom foods priority over seed
    foods for the same role ("I took the time to add this — use it").
    Custom foods float to the top of the rotation list while still
    respecting density rank among themselves for the protein role.

    Deterministic: identical (role, pantry, used, offset, preferred)
    always returns the same food.
    """
    keywords = _ROLE_KEYWORDS.get(role)
    if not keywords or not pantry:
        return None

    matches = [f for f in pantry if _food_matches_keywords(f, keywords)]
    if not matches:
        return None

    if role == "protein":
        matches = sorted(
            matches,
            key=lambda name: _PROTEIN_DENSITY_RANK.get(
                _canonical_protein_key(name), 99,
            ),
        )

    # Custom-food bias: stable-partition so preferred foods come first
    # while preserving the role-specific order (protein-density, etc)
    # within each partition. Users who add "Kirkland pea protein" get
    # it picked over generic seed "Whey Protein" for the same slot.
    if preferred_foods:
        prefs = {p.lower() for p in preferred_foods}
        preferred_match = [m for m in matches if m.lower() in prefs]
        other_match = [m for m in matches if m.lower() not in prefs]
        matches = preferred_match + other_match

    # Rotate the match list so day_index / slot_index pick different items.
    start = rotation_offset % len(matches)
    rotated = matches[start:] + matches[:start]

    # Prefer a food that hasn't been used yet in this template.
    for f in rotated:
        if f.lower() not in used_in_template:
            return f
    return rotated[0]


# Hard-coded rank table for protein density (higher protein-per-serving
# comes first). Values are just sort keys — only ordering matters, not
# magnitude. Keeping it here (rather than computing from the enrichment
# table) lets the skeleton stage run without a food lookup.
_PROTEIN_DENSITY_RANK: dict[str, int] = {
    "chicken":   1,
    "turkey":    2,
    "tuna":      3,
    "whey":      4,
    "salmon":    5,
    "cottage cheese": 6,
    "tempeh":    7,
    "tofu":      8,
    "beef":      9,
    "pork":     10,
    "greek yogurt": 11,
    "lentils":  12,
    "chickpeas": 13,
    "black bean": 14,
    "edamame":  15,
    "eggs":     16,   # deliberately ranked low for muscle-gain meals
    "jerky":    17,
    "protein powder": 18,
}


def _canonical_protein_key(name: str) -> str:
    """Map a pantry entry like 'chicken breast' → 'chicken' so the density
    rank table stays small. Returns the first matching prefix key or the
    lowercased name."""
    ln = name.lower()
    for key in _PROTEIN_DENSITY_RANK:
        if key in ln:
            return key
    return ln


def _fallback_meal(pantry: list[str], used: set[str]) -> list[str]:
    """Last-resort pick when archetype roles all failed (pantry is too
    sparse). Returns up to two items from the pantry, biased toward unused
    foods. Never returns empty unless the pantry itself is empty.
    """
    if not pantry:
        return []
    fresh = [f for f in pantry if f.lower() not in used]
    pick_from = fresh or list(pantry)
    # Take the first two as the "protein-ish + carb-ish" fallback. If only
    # one food exists, that's what we return.
    return pick_from[:2]


def _build_meal(
    archetype: list[str],
    pantry: list[str],
    used_in_template: set[str],
    rotation_offset: int,
    meal_index: int,
    slot_type: str,
    preferred_foods: set[str] | None = None,
) -> MealSkeleton:
    """Turn one archetype row into one `MealSkeleton`.

    Fills roles in order, skips any role that the pantry can't satisfy,
    and falls back to `_fallback_meal` if the whole archetype came up
    empty.
    """
    picks: list[str] = []
    meal_used: set[str] = set()  # dedupe within the meal itself
    for slot_i, role in enumerate(archetype):
        food = _pick_role(
            role,
            pantry,
            # Bias picks away from both template-wide and meal-local
            # duplicates so a single meal doesn't list chicken twice.
            used_in_template | meal_used,
            rotation_offset + slot_i,
            preferred_foods=preferred_foods,
        )
        if food and food.lower() not in meal_used:
            picks.append(food)
            meal_used.add(food.lower())

    if not picks:
        picks = _fallback_meal(pantry, used_in_template)

    # Human-readable name built from the slot type + meal index. Downstream
    # formatting / display reuses `skeleton.name` verbatim, so keep it
    # short and title-cased.
    name_prefix = {
        "breakfast": "Breakfast",
        "lunch":     "Lunch",
        "dinner":    "Dinner",
        "snack":     "Snack",
    }.get(slot_type, "Meal")
    name = f"{name_prefix} {meal_index + 1}"

    return MealSkeleton(
        name=name,
        index=meal_index,
        food_refs=picks,
        target_fraction=0.0,  # filled in by the caller once total count is known
    )


def _slot_types_for(meals_per_day: int) -> list[str]:
    """Return the sequence of slot types for a given mealsPerDay.

    For values outside the pre-computed table we synthesize a sequence
    that still respects breakfast-first / dinner-last. `_clamp_meals_per_day`
    already keeps the input in 1-10.
    """
    fixed = _SLOT_TYPE_BY_POSITION.get(meals_per_day)
    if fixed is not None:
        return list(fixed)
    # Synthesised path — sandwich breakfast/dinner around lunch + snacks.
    if meals_per_day <= 0:
        return []
    if meals_per_day == 1:
        return ["dinner"]
    out = ["breakfast"] + ["snack"] * (meals_per_day - 2) + ["dinner"]
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Top-level entry — matches `call_skeleton_ai`'s return contract
# ─────────────────────────────────────────────────────────────────────────────


def generate_deterministic_skeleton(
    req: "PlanRequest",
    variety_n: int,
    allowed_foods: list[str],
    *,
    db: Any = None,
    user_id: int | None = None,
    preferred_foods: list[str] | None = None,
    recent_meal_names: list[str] | None = None,
) -> tuple[list[TemplateSkeleton], str, list[dict]]:
    """Deterministic drop-in for `call_skeleton_ai`.

    Returns the same `(templates, nutritionistNote, supplementStack)` tuple
    shape. `nutritionistNote` is empty and `supplementStack` is empty — the
    nutritionist note is generated separately elsewhere if at all; callers
    that need one can synthesize it from the profile without another AI
    round-trip.

    Parameters
    ----------
    req
        The PlanRequest — only `mealsPerDay`, `dietaryPreference`, and
        `allergies` are consulted. Everything else (goal, macros) is the
        caller's concern because the SKELETON is just names + food_refs;
        macros are calculated later in the pipeline.
    variety_n
        Number of daily templates to emit (1-7 typical).
    allowed_foods
        Full pantry of foods the user has said they have access to. We
        filter this down by diet + allergies before running the resolver.
    db, user_id
        Unused today — accepted for parity with `call_skeleton_ai`'s
        signature so the caller can swap implementations without changing
        its call site.
    recent_meal_names
        Food names from the last 3-5 days of plans. These are seeded into
        the per-template `used_in_template` set so the resolver biases away
        from them, improving day-to-day variety.
    """
    # Unused kwargs — declared for signature parity with call_skeleton_ai.
    _ = (db, user_id)

    meals_per_day = _clamp_meals_per_day(req.mealsPerDay)
    variety_n = max(1, min(7, int(variety_n or 1)))
    if meals_per_day <= 0 or not allowed_foods:
        return [TemplateSkeleton(meals=[]) for _ in range(variety_n)], "", []

    # Build the preferred-food bias set once per call so _build_meal /
    # _pick_role can short-circuit on a set membership check. Users who
    # added custom foods (AI-scanned or typed) get those favored over
    # generic seed foods for the same role.
    _preferred_set: set[str] = {
        (n or "").strip().lower()
        for n in (preferred_foods or [])
        if (n or "").strip()
    }

    # Pantry filtering: drop anything incompatible with diet/allergens up
    # front so the role resolver never even considers those foods.
    pantry = _filter_pantry(
        allowed_foods,
        getattr(req, "dietaryPreference", None),
        getattr(req, "allergies", None) or [],
    )
    slot_types = _slot_types_for(meals_per_day)

    _recent_set: set[str] = {
        n.lower().strip() for n in (recent_meal_names or []) if n
    }

    templates: list[TemplateSkeleton] = []
    for day_idx in range(variety_n):
        used_in_template: set[str] = set(_recent_set)
        meals: list[MealSkeleton] = []
        for slot_idx, slot_type in enumerate(slot_types):
            archetypes = _ARCHETYPES_BY_SLOT.get(slot_type) or _DINNER_ARCHETYPES
            # Rotation: which archetype row to use for this (day, slot)
            # pair. Adding slot_idx avoids every slot on the same day
            # picking archetype[day_idx] — consecutive slots land on
            # different rows, and consecutive days on a given slot also
            # step forward.
            archetype_idx = (day_idx + slot_idx) % len(archetypes)
            archetype = archetypes[archetype_idx]

            # Offset used for the per-role pantry rotation. Making it a
            # function of day_idx + slot_idx means the same archetype on
            # different days still picks different concrete foods when
            # the pantry has multiple matches per role.
            rotation_offset = day_idx * 3 + slot_idx

            meal = _build_meal(
                archetype,
                pantry,
                used_in_template,
                rotation_offset,
                slot_idx,
                slot_type,
                preferred_foods=_preferred_set,
            )
            meals.append(meal)
            used_in_template.update(f.lower() for f in meal.food_refs)

        # Assign target_fraction uniformly — the solver / assembler will
        # re-normalize if routine overlays adjust it.
        frac = 1.0 / meals_per_day if meals_per_day > 0 else 0.0
        for i, m in enumerate(meals):
            m.index = i
            m.target_fraction = frac
        templates.append(TemplateSkeleton(meals=meals))

    # Deterministic generator does not emit a nutritionist note or
    # supplement stack. Both are cosmetic for the skeleton path — the
    # downstream AI-free pipeline doesn't rely on them, and the client
    # gracefully handles empty values.
    return templates, "", []
