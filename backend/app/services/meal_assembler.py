"""
Hybrid meal plan assembler.

The old pipeline asked the AI to do everything: pick foods, name recipes,
compute per-item grams, and sum meal macros to hit a calorie target. The AI
was bad at the math parts — it routinely hallucinated foods outside the
user's list, got macro sums wrong, and returned 2 templates when asked for 1.

This module splits the work so each half does what it's actually good at:

    ┌───────────────┐  skeletons only  ┌──────────────────────┐
    │      AI       │ ───────────────> │   Python algorithm   │
    │  (creative)   │   name + refs    │   (deterministic)    │
    └───────────────┘                  └──────────────────────┘
       picks meal names,                  validates foods,
       food combinations,                 solves portions,
       and flavor copy                    hits macro targets exactly


Pipeline:

    Step 1  call_skeleton_ai()
            └─ tiny prompt, tiny response. AI returns N templates of
               meal skeletons: {name, slot, food_refs, target_fraction}.
               No grams, no macros. ~80% smaller than the old prompt.

    Step 2  validate_and_repair_skeletons()
            └─ strict filter: any food_ref not in the user's allowed list
               is dropped. If a meal loses all its foods, fall back to
               picking 2-3 foods from the allowed list that match its slot.
               No retries, no LLM round-trips.

    Step 3  build_food_lookup()
            └─ turn the enrichment output into a quick name → FoodMacros
               map. FoodMacros stores per-serving calories/P/C/F.

    Step 4  solve_portions() per meal
            └─ gradient descent on serving multipliers so the weighted sum
               of food macros hits the meal's target. Pure python, no deps.

    Step 5  assemble_template() per template
            └─ wraps each solved meal into the canonical dict shape the
               frontend already understands (items[], calories, protein,
               ..., micronutrients).

    Step 6  assemble_nutrition_response()
            └─ top-level entry. Bundles N templates + nutritionistNote +
               supplementStack into the exact same dict shape the old
               _call_nutrition_ai() returned, so plans.py sees no diff.

Everything below is plain math + dict munging. The only AI call is step 1.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable, TYPE_CHECKING

import openai
from openai import OpenAI

# Imports from `app.routers.ai` are lazy because that package's __init__
# loads the full router chain, which itself imports this file — a direct
# eager import deadlocks. Test files and other service modules that pull
# in `meal_assembler` hit the cycle immediately. `TYPE_CHECKING` keeps the
# type hint for editors without touching the runtime, and the AI-specific
# helpers are imported inside `call_skeleton_ai` where they're actually
# needed.
if TYPE_CHECKING:
    from app.routers.ai.models import PlanRequest


# ─────────────────────────────────────────────────────────────────────────────
# Data types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class FoodMacros:
    """Per-serving macros for one food, looked up from enrichment."""
    name: str
    serving_label: str        # human-readable: "6 oz (170g)"
    serving_quantity: float   # numeric: 6
    serving_unit: str         # "oz" / "g" / "piece" / ...
    calories: float
    protein: float
    carbs: float
    fat: float
    # True when these macros are fabricated because enrichment didn't
    # know this food. Meals containing stubs are flagged `confidence:
    # "low"` on the output so callers don't treat the numbers as
    # trustworthy. Defaults to False so existing callers don't break.
    is_stub: bool = False


@dataclass
class MealSkeleton:
    """The AI's creative contribution — a meal concept, no math."""
    name: str                 # "Grilled chicken rice bowl"
    slot: str                 # "breakfast" | "lunch" | "dinner" | "snack"
    food_refs: list[str]      # ["chicken breast", "white rice", "broccoli"]
    target_fraction: float    # 0.25 = this meal gets 25% of daily calories


@dataclass
class TemplateSkeleton:
    """One day's worth of meal skeletons."""
    meals: list[MealSkeleton] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Skeleton AI call
# ─────────────────────────────────────────────────────────────────────────────


_SKELETON_SCHEMA = {
    "name": "skeleton_response",
    "strict": False,
    "schema": {
        "type": "object",
        "properties": {
            "nutritionistNote": {"type": "string"},
            "supplementStack": {
                "type": "array",
                "items": {"type": "object"},
            },
            "templates": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "meals": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "slot": {"type": "string"},
                                    "food_refs": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["name", "slot", "food_refs"],
                            },
                        },
                    },
                    "required": ["meals"],
                },
            },
        },
        "required": ["templates"],
    },
}


def _slot_order(meals_per_day: int) -> list[str]:
    """Which slots are active for this user's meal count."""
    if meals_per_day == 2:
        return ["lunch", "dinner"]
    if meals_per_day == 4:
        return ["breakfast", "lunch", "dinner", "snack"]
    return ["breakfast", "lunch", "dinner"]


def _slot_fractions(meals_per_day: int) -> dict[str, float]:
    """Fraction of daily calories each slot gets. Mirrors compute_tdee_and_targets."""
    if meals_per_day == 2:
        return {"lunch": 0.45, "dinner": 0.55}
    if meals_per_day == 4:
        return {"breakfast": 0.25, "lunch": 0.30, "dinner": 0.35, "snack": 0.10}
    return {"breakfast": 0.25, "lunch": 0.35, "dinner": 0.40}


def build_skeleton_prompt(
    req: "PlanRequest",
    target_macros: tuple[int, int, int, int],
    variety_n: int,
    allowed_foods: list[str],
) -> str:
    """The new skeleton-only prompt. ~80% smaller than the old nutrition prompt.

    We deliberately do NOT ask for macros or grams here — the algorithm
    computes those. The AI's only job is to pick meal concepts and food
    combinations from the user's allowed list.
    """
    t_cal, t_prot, t_carbs, t_fat = target_macros
    slots = _slot_order(req.mealsPerDay if req.mealsPerDay in {2, 3, 4} else 3)
    foods_str = ", ".join(allowed_foods) if allowed_foods else "general healthy foods"

    diet_lines: list[str] = []
    if req.dietaryPreference:
        diet_lines.append(f"Dietary preference: {req.dietaryPreference}")
    if req.allergies:
        diet_lines.append(f"Allergies (NEVER include): {', '.join(req.allergies)}")
    if req.cookingSkill:
        diet_lines.append(f"Cooking skill: {req.cookingSkill}")
    diet_context = "\n".join(f"- {l}" for l in diet_lines) if diet_lines else "- No restrictions"

    variety_line = (
        f"Generate exactly {variety_n} distinct meal template"
        f"{'' if variety_n == 1 else 's'}."
    )
    if variety_n == 1:
        variety_line += " The user wants the same plan every day. Return ONE template only."
    else:
        variety_line += (
            f" Each template should use different recipes so the user has rotation "
            f"across {variety_n} days."
        )

    routine_block = ""
    if req.mealRoutine:
        routine_block = (
            f"\nUSER'S FIXED MEAL ROUTINE (must appear verbatim in every template):\n"
            f"{req.mealRoutine}\n"
        )

    return f"""You are a registered dietitian. Pick meal concepts ONLY — no macros, no grams, no portions.

The app will compute portions and macros itself. Your job is purely creative:
choose meal names and which foods go in each meal.

USER:
- Goal: {req.goalSelection.primaryGoal if req.goalSelection else req.goal}
- Daily targets (for context only, do NOT compute macros): {t_cal} cal / {t_prot}g P / {t_carbs}g C / {t_fat}g F
{diet_context}
{routine_block}
AVAILABLE FOODS — use ONLY these names, no substitutions, no additions:
{foods_str}

MEALS PER DAY: {slots}

{variety_line}

For every meal, return:
  - name: short recipe name (e.g. "Grilled chicken rice bowl")
  - slot: one of {slots}
  - food_refs: 2-4 food names copied EXACTLY from the available-foods list above.
               Every string in food_refs MUST match a name in that list.

Also return:
  - nutritionistNote: 120-180 words, spoken directly to the user. Cover
    why the calorie target fits their goal, why the protein is set where it
    is, and how to adjust if hungry/flat. No generic advice.
  - supplementStack: 2-4 evidence-based supplements for this goal.

Return JSON shaped like:
{{
  "nutritionistNote": "...",
  "supplementStack": [{{"name": "...", "dose": "...", "timing": "...", "purpose": "..."}}],
  "templates": [
    {{
      "meals": [
        {{"name": "Grilled chicken rice bowl", "slot": "lunch", "food_refs": ["chicken breast", "white rice", "broccoli"]}}
      ]
    }}
  ]
}}

Return {variety_n} template{'' if variety_n == 1 else 's'}. Each template must cover every slot: {slots}.
Do NOT include calories, protein, carbs, fat, grams, or quantities anywhere.
"""


def call_skeleton_ai(
    client: OpenAI,
    req: "PlanRequest",
    target_macros: tuple[int, int, int, int],
    variety_n: int,
    allowed_foods: list[str],
    model: str | None = None,
) -> tuple[list[TemplateSkeleton], str, list[dict]]:
    """Call the AI once for skeletons + note + supps. Parses and validates.

    Returns (templates, nutritionistNote, supplementStack). Raises ValueError
    on repeated AI failures — the caller can decide whether to fall back.
    """
    # Lazy imports to break the circular dependency with app.routers.ai.
    from app.routers.ai.utils import (
        _build_chat_kwargs, _chat_create, _extract_json, _log_openai_error,
        _looks_truncated, model_plan_generation,
    )
    prompt = build_skeleton_prompt(req, target_macros, variety_n, allowed_foods)
    _model = model or model_plan_generation()
    last_error: Exception | None = None

    for attempt in range(1, 3):
        try:
            kwargs = _build_chat_kwargs(
                _model,
                [
                    {
                        "role": "system",
                        "content": (
                            "You return meal skeletons only — names and food references. "
                            "Never include macros, grams, or quantities. Return JSON only."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                json_schema=_SKELETON_SCHEMA,
                max_tokens=1200,
                timeout_secs=60,
            )
            response = _chat_create(client, **kwargs)
            raw = response.choices[0].message.content
            if _looks_truncated(raw):
                last_error = ValueError(f"skeleton response truncated on attempt {attempt}")
                continue
            data = _extract_json(raw)
            templates_raw = data.get("templates") or []
            if not isinstance(templates_raw, list) or not templates_raw:
                raise ValueError("skeleton response missing 'templates' array")

            # Truncate / pad to the exact variety the user asked for.
            if len(templates_raw) > variety_n:
                templates_raw = templates_raw[:variety_n]
            while len(templates_raw) < variety_n and templates_raw:
                templates_raw.append(templates_raw[-1])

            templates: list[TemplateSkeleton] = []
            slot_fracs = _slot_fractions(
                req.mealsPerDay if req.mealsPerDay in {2, 3, 4} else 3
            )
            for tpl_raw in templates_raw:
                meals_raw = tpl_raw.get("meals") or []
                meals: list[MealSkeleton] = []
                for m in meals_raw:
                    slot = str(m.get("slot", "")).lower().strip()
                    if slot not in slot_fracs:
                        continue
                    meals.append(MealSkeleton(
                        name=str(m.get("name", "Meal")).strip() or "Meal",
                        slot=slot,
                        food_refs=[str(f).strip() for f in (m.get("food_refs") or []) if f],
                        target_fraction=slot_fracs[slot],
                    ))
                templates.append(TemplateSkeleton(meals=meals))

            note = str(data.get("nutritionistNote") or "").strip()
            supps = data.get("supplementStack") or []
            if not isinstance(supps, list):
                supps = []

            print(
                f"[meal_assembler] skeleton attempt {attempt} OK — "
                f"{len(templates)} templates, "
                f"{sum(len(t.meals) for t in templates)} meals total"
            )
            return templates, note, supps
        except json.JSONDecodeError as e:
            last_error = ValueError(f"skeleton JSON decode attempt {attempt}: {e}")
            print(f"[meal_assembler] skeleton attempt {attempt} JSON error: {e}")
        except ValueError as e:
            last_error = e
            print(f"[meal_assembler] skeleton attempt {attempt} value error: {e}")
        except (openai.APIStatusError, openai.APIConnectionError, openai.APITimeoutError) as e:
            diag = _log_openai_error("meal_assembler skeleton", attempt, _model, e)
            raise ValueError(diag) from e

    raise ValueError(f"skeleton AI failed: {last_error}")


# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Skeleton validation (strict food filter)
# ─────────────────────────────────────────────────────────────────────────────


_FOOD_STOPWORDS = {"and", "or", "the", "with", "of", "in", "a", "an", "raw", "cooked", "fresh", "plain"}


def _tokens(s: str) -> list[str]:
    """Tokenize a food name into stemmed, plural-normalized words."""
    out: list[str] = []
    for w in s.lower().replace("-", " ").replace(",", " ").split():
        if not w.isalpha() or w in _FOOD_STOPWORDS or len(w) <= 2:
            continue
        if len(w) > 3 and w.endswith("s"):
            w = w[:-1]
        out.append(w)
    return out


def _best_allowed_match(ref: str, allowed_token_map: dict[str, list[str]]) -> str | None:
    """Return the allowed food name that best matches `ref`, or None.

    Ranking (in order):
      1. Exact normalized name match.
      2. Among token-subset hits (every significant token of the allowed
         food appears in the ref's tokens), pick the MOST SPECIFIC one —
         i.e. the allowed name with the highest token count. This makes
         "white rice" beat "rice" and "chicken breast" beat "chicken"
         when both exist in the allowed list.
      3. Tie-break on the longest lowercased name string.
    """
    ref_lower = ref.lower().strip()
    ref_tokens = set(_tokens(ref))
    if not ref_tokens:
        return None

    # 1. Exact match against any allowed food's lowercased name.
    for allowed_name in allowed_token_map.keys():
        if allowed_name.lower().strip() == ref_lower:
            return allowed_name

    # 2. Token-subset candidates, ranked by specificity.
    candidates: list[tuple[int, int, str]] = []   # (token_count, name_len, name)
    for allowed_name, a_tokens in allowed_token_map.items():
        if not a_tokens:
            continue
        if all(tok in ref_tokens for tok in a_tokens):
            candidates.append((len(a_tokens), len(allowed_name), allowed_name))
    if not candidates:
        return None
    # More tokens = more specific. On ties, longer name wins. Sort
    # descending and return the winner.
    candidates.sort(reverse=True)
    return candidates[0][2]


# ─── Slot-aware food classification ──────────────────────────────────────────
#
# No real tag system yet (Phase 2 of the bigger refactor adds that). Until
# then we use keyword heuristics on food names to pick slot-appropriate
# fallback items. The keyword lists are intentionally conservative — we'd
# rather miss a valid breakfast food than accidentally stick oatmeal on a
# dinner card.

_BREAKFAST_KEYWORDS = {
    "oat", "oats", "oatmeal", "egg", "eggs", "yogurt", "granola", "cereal",
    "pancake", "waffle", "bagel", "toast", "muffin", "banana", "berry",
    "berries", "blueberry", "strawberry", "milk", "butter", "peanut",
    "almond butter", "cottage cheese",
}

_PROTEIN_KEYWORDS = {
    "chicken", "beef", "steak", "turkey", "pork", "fish", "salmon", "tuna",
    "shrimp", "tilapia", "cod", "tofu", "tempeh", "seitan", "eggs", "egg",
    "greek yogurt", "cottage cheese", "protein powder", "whey", "lentil",
    "lentils", "chickpea", "chickpeas", "black bean", "edamame",
}

_CARB_KEYWORDS = {
    "rice", "pasta", "noodle", "potato", "sweet potato", "quinoa", "oats",
    "oatmeal", "bread", "tortilla", "wrap", "bagel", "couscous", "barley",
    "bulgur",
}

_VEG_KEYWORDS = {
    "broccoli", "spinach", "kale", "lettuce", "tomato", "cucumber", "carrot",
    "pepper", "onion", "zucchini", "asparagus", "green bean", "mushroom",
    "cauliflower", "cabbage", "salad",
}

_SNACK_KEYWORDS = {
    "apple", "banana", "orange", "grape", "berry", "berries", "nut", "nuts",
    "almond", "cashew", "walnut", "peanut", "jerky", "protein bar",
    "greek yogurt", "cottage cheese", "cheese", "rice cake", "hummus",
    "carrot", "celery",
}


def _food_matches_keywords(name: str, keywords: set[str]) -> bool:
    n = name.lower()
    return any(k in n for k in keywords)


def _slot_aware_fallback(
    slot: str,
    allowed_foods: list[str],
    used: set[str] | None = None,
) -> list[str]:
    """Pick a small realistic food combination for `slot` from `allowed_foods`.

    Rules:
      - breakfast: prefer 2-3 breakfast-tagged foods (e.g. oats + eggs +
        berries). If none match, fall through to generic protein + carb.
      - lunch/dinner: require at least one protein, prefer protein + carb
        + vegetable.
      - snack: prefer protein + fruit, or protein + fat.
      - If there aren't enough slot-specific candidates, degrade to the
        first 2-3 allowed foods not already in `used`. We still never
        return an empty list — the solver must have something to work on.

    `used` is an optional set of already-chosen foods from other meals in
    the same template; we try to avoid them so templates feel varied.
    """
    if not allowed_foods:
        return []
    used = used or set()
    available = [f for f in allowed_foods if f not in used] or list(allowed_foods)

    def pick_one(keywords: set[str], pool: list[str]) -> str | None:
        for f in pool:
            if _food_matches_keywords(f, keywords):
                return f
        return None

    def pick_many(keywords: set[str], pool: list[str], n: int) -> list[str]:
        out: list[str] = []
        for f in pool:
            if len(out) >= n:
                break
            if _food_matches_keywords(f, keywords):
                out.append(f)
        return out

    slot = (slot or "").lower()

    if slot == "breakfast":
        picks = pick_many(_BREAKFAST_KEYWORDS, available, 3)
        if len(picks) >= 2:
            return picks
        # Degrade: protein + carb.
        prot = pick_one(_PROTEIN_KEYWORDS, available)
        carb = pick_one(_CARB_KEYWORDS, available)
        picks = [x for x in (prot, carb) if x]
        if picks:
            return picks

    if slot in ("lunch", "dinner"):
        prot = pick_one(_PROTEIN_KEYWORDS, available)
        # Lunch/dinner REQUIRES a protein source. If the unused pool has
        # none, re-pick from the full allowed list — repeating a food
        # across meals is better than shipping a proteinless dinner.
        if not prot:
            prot = pick_one(_PROTEIN_KEYWORDS, list(allowed_foods))
        carb = pick_one(_CARB_KEYWORDS, available)
        veg  = pick_one(_VEG_KEYWORDS,  available)
        picks = [x for x in (prot, carb, veg) if x]
        if picks:
            return picks

    if slot == "snack":
        prot = pick_one(_PROTEIN_KEYWORDS, available)
        other = pick_one(_SNACK_KEYWORDS, [f for f in available if f != prot])
        picks = [x for x in (prot, other) if x]
        if picks:
            return picks

    # Last resort: first two available foods.
    return available[:2]


def validate_and_repair_skeletons(
    templates: list[TemplateSkeleton],
    allowed_foods: list[str],
    required_slots: list[str] | None = None,
) -> list[TemplateSkeleton]:
    """Drop any food_ref not in the allowed list; pick a slot-aware
    fallback when a meal ends up empty; guarantee every required slot
    exists on every template.

    `required_slots` comes from `_slot_order(mealsPerDay)` and is the set
    of slot names the user's plan must cover (e.g. `["breakfast", "lunch",
    "dinner"]` for 3 meals). Any template missing a required slot gets a
    repaired meal appended using `_slot_aware_fallback`. This enforces the
    prompt's "every template covers every slot" instruction that used to
    be advisory.
    """
    if not allowed_foods:
        return templates

    allowed_token_map = {name: _tokens(name) for name in allowed_foods}

    for tpl in templates:
        # Track which foods this template already uses so fallback picks
        # can bias away from repetition when possible.
        used_in_template: set[str] = set()

        # 1. Clean every existing meal.
        for meal in tpl.meals:
            cleaned: list[str] = []
            seen: set[str] = set()
            for ref in meal.food_refs:
                match = _best_allowed_match(ref, allowed_token_map)
                if match and match.lower() not in seen:
                    cleaned.append(match)
                    seen.add(match.lower())
            if not cleaned:
                fallback = _slot_aware_fallback(meal.slot, allowed_foods, used_in_template)
                print(
                    f"[meal_assembler] meal '{meal.name}' ({meal.slot}) had no "
                    f"valid foods — slot-aware fallback: {fallback}"
                )
                cleaned = fallback
            meal.food_refs = cleaned
            used_in_template.update(f.lower() for f in cleaned)

        # 2. Guarantee every required slot exists on this template.
        if required_slots:
            present_slots = {m.slot for m in tpl.meals}
            fractions = _slot_fractions(len(required_slots) if len(required_slots) in (2, 3, 4) else 3)
            for slot in required_slots:
                if slot in present_slots:
                    continue
                fallback = _slot_aware_fallback(slot, allowed_foods, used_in_template)
                if not fallback:
                    # Nothing to build a meal from — skip silently rather
                    # than appending a ghost meal. Downstream will treat
                    # the template as slot-deficient.
                    print(f"[meal_assembler] could not repair missing slot '{slot}' — no allowed foods")
                    continue
                print(f"[meal_assembler] template missing '{slot}' slot — repaired with {fallback}")
                tpl.meals.append(MealSkeleton(
                    name=_slot_default_name(slot),
                    slot=slot,
                    food_refs=fallback,
                    target_fraction=fractions.get(slot, 0.0),
                ))
                used_in_template.update(f.lower() for f in fallback)
    return templates


def _slot_default_name(slot: str) -> str:
    """Human-readable default name when we auto-repair a missing slot."""
    return {
        "breakfast": "Morning plate",
        "lunch":     "Midday plate",
        "dinner":    "Evening plate",
        "snack":     "Snack plate",
    }.get(slot, slot.capitalize())


# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — Food lookup from enrichment
# ─────────────────────────────────────────────────────────────────────────────


_REAL_UNITS = {
    "g": "g", "gram": "g", "grams": "g",
    "kg": "kg",
    "oz": "oz", "ounce": "oz", "ounces": "oz",
    "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "ml": "ml", "milliliter": "ml", "milliliters": "ml",
    "l": "l", "liter": "l", "liters": "l",
    "fl_oz": "fl_oz", "floz": "fl_oz",
    "cup": "cup", "cups": "cup",
    "tbsp": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp",
    "tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp",
    "piece": "piece", "pieces": "piece",
    "slice": "slice", "slices": "slice",
    "scoop": "scoop", "scoops": "scoop",
    "egg": "piece", "eggs": "piece",
}

import re as _re


def _parse_serving(label: str) -> tuple[float, str]:
    """Extract a numeric quantity and canonical unit from an enrichment label.

    Enrichment returns strings like:
        "6 oz (170g)"         → (6, "oz")
        "1 cup cooked (240g)" → (1, "cup")
        "2 large"             → (2, "piece")
        "100g"                → (100, "g")
        "1 serving"           → (170, "g") if '(170g)' is present, else (1, "serving")
        "1 medium (150g)"     → (1, "piece")

    Rule: prefer the *first real food unit* (g, oz, cup, piece, ...).
    If the only real unit is in parentheses, use that. If none is present,
    fall back to '1 serving'.
    """
    raw = label.strip().lower()
    if not raw:
        return 1.0, "serving"

    # Break into (number, word) pairs. Regex finds all "<num> <word>" occurrences.
    pairs = _re.findall(r"(\d+(?:\.\d+)?)\s*([a-z_]+)", raw)
    # Canonicalize each word; drop any that aren't a real unit.
    candidates: list[tuple[float, str]] = []
    for num_str, word in pairs:
        w = _REAL_UNITS.get(word)
        if w:
            try:
                candidates.append((float(num_str), w))
            except ValueError:
                continue

    if candidates:
        # Prefer non-gram units first (they're more human — "6 oz" beats "170 g"),
        # unless the only option is grams.
        non_g = [c for c in candidates if c[1] not in {"g", "kg", "ml", "l"}]
        return (non_g[0] if non_g else candidates[0])

    # Last resort: maybe there's a number with no unit ("2 large") — treat
    # as pieces, which is the right call for countable items.
    bare = _re.match(r"(\d+(?:\.\d+)?)", raw)
    if bare:
        try:
            return float(bare.group(1)), "piece"
        except ValueError:
            pass
    return 1.0, "serving"


def build_food_lookup(enriched: dict | None) -> dict[str, FoodMacros]:
    """Turn the enrichment payload into a name → FoodMacros dict.

    Enrichment gives us per-serving macros the calorie calculator trusts.
    We use that as the unit cost when solving portions.
    """
    lookup: dict[str, FoodMacros] = {}
    if not enriched:
        return lookup
    for f in enriched.get("foods", []) or []:
        name = str(f.get("name", "")).strip()
        if not name:
            continue
        # Prefer explicit quantity/unit fields (new enrichment shape).
        # Fall back to parsing the legacy free-form `serving` string.
        explicit_qty = f.get("quantity")
        explicit_unit = f.get("unit")
        if isinstance(explicit_qty, (int, float)) and explicit_unit:
            unit_str = str(explicit_unit).lower().strip()
            qty = float(explicit_qty)
            unit = _REAL_UNITS.get(unit_str, unit_str if unit_str else "serving")
            label = f"{qty:g} {unit}"
        else:
            label = str(f.get("serving", "1 serving"))
            qty, unit = _parse_serving(label)
        lookup[name.lower()] = FoodMacros(
            name=name,
            serving_label=label,
            serving_quantity=qty,
            serving_unit=unit,
            calories=float(f.get("calories", 0) or 0),
            protein=float(f.get("protein", 0) or 0),
            carbs=float(f.get("carbs", 0) or 0),
            fat=float(f.get("fat", 0) or 0),
        )
    return lookup


def _guess_unit_for_food(name: str) -> tuple[float, str]:
    """Pick a sensible (quantity, unit) default for a food when enrichment
    missed it. Keeps stub items readable instead of showing '1 serving'."""
    n = name.lower()
    if any(k in n for k in ("egg", "apple", "banana", "orange", "peach", "pear", "plum", "kiwi")):
        return 1.0, "piece"
    if any(k in n for k in ("bread", "toast", "bacon", "cheese slice", "deli", "turkey slice", "ham slice")):
        return 1.0, "slice"
    if any(k in n for k in ("oat", "rice", "pasta", "quinoa", "couscous", "barley", "noodle", "yogurt", "milk", "bean", "lentil", "vegetable", "broccoli", "spinach", "kale", "lettuce", "carrot", "potato", "sweet potato", "cauliflower", "berries", "berry")):
        return 1.0, "cup"
    if any(k in n for k in ("oil", "butter", "peanut butter", "almond butter", "dressing", "sauce", "honey", "maple syrup", "jam")):
        return 1.0, "tbsp"
    if "protein powder" in n or "whey" in n or "casein" in n:
        return 1.0, "scoop"
    # Default for meats, fish, tofu, nuts
    return 3.0, "oz"


def _get_macros(name: str, lookup: dict[str, FoodMacros]) -> FoodMacros:
    """Look up a food's per-serving macros. Three-tier match:

      1. Exact lowercased name (enrichment hit).
      2. Token match: every significant token of `name` appears in an
         enriched food's tokens (handles plural/singular and minor wording
         drift between the skeleton AI's `food_refs` and enrichment).
      3. Stub with a food-specific guessed unit so we never display "serving".
    """
    lower = name.lower()
    m = lookup.get(lower)
    if m:
        return m

    # Token fallback — find the first enriched food whose tokens are a subset
    # of the skeleton ref's tokens, OR vice-versa. Subset-either-way catches
    # "chicken" vs "chicken breast" in both directions.
    ref_toks = set(_tokens(name))
    if ref_toks:
        for food in lookup.values():
            f_toks = set(_tokens(food.name))
            if not f_toks:
                continue
            if f_toks.issubset(ref_toks) or ref_toks.issubset(f_toks):
                return food

    qty, unit = _guess_unit_for_food(name)
    print(
        f"[meal_assembler] LOW-CONFIDENCE STUB for food '{name}' — not found "
        f"in enrichment; fabricating macros (150 cal / 10P / 15C / 5F). This "
        f"should be rare; loud log so callers can spot degraded quality."
    )
    return FoodMacros(
        name=name, serving_label=f"{qty:g} {unit}", serving_quantity=qty,
        serving_unit=unit, calories=150, protein=10, carbs=15, fat=5,
        is_stub=True,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — Portion solver
# ─────────────────────────────────────────────────────────────────────────────


def solve_portions(
    foods: list[FoodMacros],
    target_cal: float,
    target_prot: float,
    target_carb: float,
    target_fat: float,
) -> list[float]:
    """Find serving multipliers for `foods` that get close to the meal target.

    Approach: gradient descent on squared relative error across all four
    macros. 100 iterations, learning rate 0.1, multipliers clamped to
    [0.25, 5.0] so we can't ask the user to eat 0.02 eggs or 12 cups of oats.

    This is not globally optimal but it's transparent, dependency-free, and
    consistently lands within ~5% of target for realistic meals. The final
    plan-level normalizer (`_normalize_template_to_target` in plans.py)
    closes any residual drift to exactly the daily target.
    """
    if not foods:
        return []

    n = len(foods)
    # Seed with 1 serving each. This is the "1 serving of everything" baseline
    # the enrichment gives us, which is usually near-realistic already.
    m = [1.0] * n

    # Weights make sure calories and protein pull harder than carbs/fat.
    # Calories are the anchor (the user's goal); protein is the next-hardest
    # constraint. Carbs and fat are allowed to drift a bit more.
    weights = {
        "cal": 2.0,
        "prot": 1.5,
        "carb": 1.0,
        "fat": 1.0,
    }
    targets = {
        "cal": max(target_cal, 1.0),
        "prot": max(target_prot, 1.0),
        "carb": max(target_carb, 1.0),
        "fat": max(target_fat, 1.0),
    }

    lr = 0.1
    for _ in range(100):
        # Compute current totals under the current multipliers.
        cur_cal = sum(m[i] * foods[i].calories for i in range(n))
        cur_pro = sum(m[i] * foods[i].protein for i in range(n))
        cur_cb  = sum(m[i] * foods[i].carbs for i in range(n))
        cur_ft  = sum(m[i] * foods[i].fat for i in range(n))

        # Relative errors — a 10% drift on calories matters the same as
        # 10% drift on protein, regardless of absolute value.
        err = {
            "cal":  (cur_cal - targets["cal"])  / targets["cal"],
            "prot": (cur_pro - targets["prot"]) / targets["prot"],
            "carb": (cur_cb  - targets["carb"]) / targets["carb"],
            "fat":  (cur_ft  - targets["fat"])  / targets["fat"],
        }

        # Gradient wrt each multiplier m_j:
        #   d(weighted sq err)/d m_j
        #     = sum_k 2 * w_k * err_k * (food_j macro_k / target_k)
        for j in range(n):
            g = (
                weights["cal"]  * err["cal"]  * (foods[j].calories / targets["cal"])
              + weights["prot"] * err["prot"] * (foods[j].protein  / targets["prot"])
              + weights["carb"] * err["carb"] * (foods[j].carbs    / targets["carb"])
              + weights["fat"]  * err["fat"]  * (foods[j].fat      / targets["fat"])
            )
            m[j] -= lr * g
            # Clamp so no food goes to zero (= "remove it") or explodes.
            if m[j] < 0.25:
                m[j] = 0.25
            elif m[j] > 5.0:
                m[j] = 5.0
    return m


# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Assemble meals and templates into the canonical shape
# ─────────────────────────────────────────────────────────────────────────────


def _round_to_nice_quantity(q: float) -> float:
    """Round a solved multiplier to a user-friendly number of servings."""
    # Under 0.5 → round to nearest 0.25. Otherwise nearest 0.5.
    if q < 0.5:
        return round(q * 4) / 4
    return round(q * 2) / 2


# Residual tolerance thresholds for solver quality checks. Anything past
# these is considered a meal that the food list can't physically hit —
# we log and mark the meal `confidence: low` rather than silently pass a
# bad result to the client.
#
# Calories are the anchor and get the tightest threshold. Protein is
# muscle-preserving and gets the next-tightest. Carbs and fat are allowed
# more slack because they absorb drift from the solver's compromise.
_SOLVER_ACCEPT_CAL  = 0.25   # ±25% of meal calorie target
_SOLVER_ACCEPT_PROT = 0.30   # ±30% of meal protein target
_SOLVER_ACCEPT_CARB = 0.40
_SOLVER_ACCEPT_FAT  = 0.40


def _solver_residual(
    foods: list[FoodMacros],
    multipliers: list[float],
    target_cal: float,
    target_prot: float,
    target_carb: float,
    target_fat: float,
) -> dict[str, float]:
    """Compute the relative residual of the solver result vs meal target.

    Returned as a dict of relative errors (current - target) / target for
    each macro. Used both for accept/reject decisions and for the debug
    line that gets logged on low-confidence meals.
    """
    cur_cal = sum(m * f.calories for f, m in zip(foods, multipliers))
    cur_pro = sum(m * f.protein  for f, m in zip(foods, multipliers))
    cur_cb  = sum(m * f.carbs    for f, m in zip(foods, multipliers))
    cur_ft  = sum(m * f.fat      for f, m in zip(foods, multipliers))
    return {
        "cal":  (cur_cal - target_cal)  / max(target_cal, 1.0),
        "prot": (cur_pro - target_prot) / max(target_prot, 1.0),
        "carb": (cur_cb  - target_carb) / max(target_carb, 1.0),
        "fat":  (cur_ft  - target_fat)  / max(target_fat, 1.0),
    }


def _solver_accepts(residual: dict[str, float]) -> bool:
    """True if residuals fall within tolerance — meal is good enough to ship."""
    return (
        abs(residual["cal"])  <= _SOLVER_ACCEPT_CAL
        and abs(residual["prot"]) <= _SOLVER_ACCEPT_PROT
        and abs(residual["carb"]) <= _SOLVER_ACCEPT_CARB
        and abs(residual["fat"])  <= _SOLVER_ACCEPT_FAT
    )


def assemble_meal(
    skeleton: MealSkeleton,
    food_lookup: dict[str, FoodMacros],
    target_cal: float,
    target_prot: float,
    target_carb: float,
    target_fat: float,
) -> dict:
    """Turn one skeleton meal into the canonical meal dict the frontend reads.

    Adds two quality gates on top of the old solver→assemble flow:
      * Stub detection — any food whose macros were fabricated marks the
        meal as low-confidence.
      * Residual checks — before and after rounding, we compute the
        relative error vs target. If either breaches the thresholds, the
        meal is still returned (we never ship an empty slot) but flagged
        `confidence: "low"` with the residual in `quality_debug` so the
        caller can show a warning or attempt repair.
    """
    foods = [_get_macros(r, food_lookup) for r in skeleton.food_refs]
    stub_names = [f.name for f in foods if f.is_stub]

    raw_multipliers = solve_portions(foods, target_cal, target_prot, target_carb, target_fat)
    pre_round_residual = _solver_residual(
        foods, raw_multipliers, target_cal, target_prot, target_carb, target_fat,
    )

    multipliers = [_round_to_nice_quantity(m) for m in raw_multipliers]
    post_round_residual = _solver_residual(
        foods, multipliers, target_cal, target_prot, target_carb, target_fat,
    )

    items: list[dict] = []
    total_cal = total_pro = total_cb = total_ft = 0.0
    for food, mult in zip(foods, multipliers):
        item_cal = food.calories * mult
        item_pro = food.protein * mult
        item_cb  = food.carbs   * mult
        item_ft  = food.fat     * mult
        items.append({
            "name": food.name,
            "quantity": round(food.serving_quantity * mult, 2),
            "unit": food.serving_unit,
            "calories": round(item_cal),
            "protein": round(item_pro, 1),
            "carbs": round(item_cb, 1),
            "fat": round(item_ft, 1),
        })
        total_cal += item_cal
        total_pro += item_pro
        total_cb  += item_cb
        total_ft  += item_ft

    # Quality flag: stubs or residual-out-of-bounds both degrade confidence.
    solver_ok = _solver_accepts(post_round_residual)
    confidence: str
    if stub_names or not solver_ok:
        confidence = "low"
        print(
            f"[meal_assembler] LOW-CONFIDENCE meal '{skeleton.name}' ({skeleton.slot}): "
            f"stubs={stub_names or '-'} "
            f"residual_cal={post_round_residual['cal']:+.2f} "
            f"residual_prot={post_round_residual['prot']:+.2f} "
            f"residual_carb={post_round_residual['carb']:+.2f} "
            f"residual_fat={post_round_residual['fat']:+.2f}"
        )
    else:
        confidence = "high"

    return {
        "meal": skeleton.name,
        "items": items,
        "calories": round(total_cal),
        "protein": round(total_pro, 1),
        "carbs": round(total_cb, 1),
        "fat": round(total_ft, 1),
        "fiber": 0,
        "micronutrients": {
            "fiber": 0, "sugar": 0, "sodium": 0, "cholesterol": 0,
            "vitaminA": 0, "vitaminC": 0, "vitaminD": 0, "calcium": 0,
            "iron": 0, "potassium": 0,
        },
        "estimated_alignment": "balanced",
        "isRoutine": False,
        "confidence": confidence,
        "quality_debug": {
            "stub_foods": stub_names,
            "pre_round_residual": {k: round(v, 3) for k, v in pre_round_residual.items()},
            "post_round_residual": {k: round(v, 3) for k, v in post_round_residual.items()},
        },
    }


def assemble_template(
    skeleton: TemplateSkeleton,
    food_lookup: dict[str, FoodMacros],
    target_cal: int,
    target_prot: int,
    target_carb: int,
    target_fat: int,
) -> dict:
    """Turn one template's worth of skeletons into the canonical plan dict."""
    plan: dict = {
        "targets": {
            "calories": target_cal,
            "protein": target_prot,
            "carbs": target_carb,
            "fat": target_fat,
        },
    }
    for meal in skeleton.meals:
        frac = meal.target_fraction
        plan[meal.slot] = assemble_meal(
            meal,
            food_lookup,
            target_cal  * frac,
            target_prot * frac,
            target_carb * frac,
            target_fat  * frac,
        )
    return plan


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — Top-level entry
# ─────────────────────────────────────────────────────────────────────────────


def assemble_nutrition_response(
    client: OpenAI,
    req: "PlanRequest",
    target_macros: tuple[int, int, int, int],
    variety_n: int,
    allowed_foods: list[str],
    enriched: dict | None,
) -> dict:
    """Build the full nutrition response using the hybrid pipeline.

    Returns a dict in the same shape _call_nutrition_ai used to produce, so
    plans.py doesn't need to care which pipeline ran:

        {
          "nutritionistNote": "...",
          "supplementStack": [...],
          "nutrition_plans": [
            {"targets": {...}, "breakfast": {...}, "lunch": {...}, ...},
            ...
          ]
        }
    """
    t_cal, t_prot, t_carbs, t_fat = target_macros

    # Step 1 — skeleton AI call
    templates, note, supps = call_skeleton_ai(
        client, req, target_macros, variety_n, allowed_foods
    )

    # Step 2 — strict food validation + slot completeness repair.
    # `required_slots` forces every template to cover every slot the
    # user's mealsPerDay dictates, even if the AI dropped one.
    required_slots = _slot_order(
        req.mealsPerDay if req.mealsPerDay in {2, 3, 4} else 3
    )
    templates = validate_and_repair_skeletons(templates, allowed_foods, required_slots)

    # Step 3 — food lookup
    food_lookup = build_food_lookup(enriched)

    # Step 4+5 — solve portions and assemble every template
    plans_list: list[dict] = []
    for tpl in templates:
        plans_list.append(
            assemble_template(tpl, food_lookup, t_cal, t_prot, t_carbs, t_fat)
        )

    print(
        f"[meal_assembler] assembled {len(plans_list)} template(s) "
        f"(variety_n={variety_n}, foods={len(food_lookup)}, "
        f"allowed={len(allowed_foods)})"
    )

    return {
        "nutritionistNote": note,
        "supplementStack": supps,
        "nutrition_plans": plans_list,
    }
