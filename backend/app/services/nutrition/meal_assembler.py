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
import os
from dataclasses import dataclass, field
from typing import Any, Iterable, TYPE_CHECKING

import openai
from openai import OpenAI


# ─── AI-free skeleton gate ────────────────────────────────────────────────────
# When true (the default and shipping path), the skeleton stage bypasses
# the OpenAI call entirely and uses `deterministic_skeleton.py` instead.
# Flipping the env var `USE_DETERMINISTIC_SKELETON=0` re-enables the AI
# path for side-by-side comparison / debugging — the rest of the pipeline
# (validate_and_repair_skeletons → enrich → solve_portions → assemble)
# is byte-for-byte identical in both modes.

def _deterministic_skeleton_enabled() -> bool:
    """Read the env flag every call so tests can flip it without reloads."""
    raw = os.environ.get("USE_DETERMINISTIC_SKELETON", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}

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


#: Canonical micronutrient field names the assembler will round-trip from
#: the food data into the meal output. Any subset may be present on a given
#: food — missing fields default to 0. Adding a new field here automatically
#: makes it flow through `build_food_lookup` → `assemble_meal` → the
#: meal["micronutrients"] dict the frontend displays. Source data backed
#: by the seed/USDA today: fiber, total sugar, added sugar, sodium. Everything
#: else is schema-supported via the FoodNutrition.extra_nutrients JSON column
#: and will populate as the seed gets enriched.
MICRONUTRIENT_FIELDS: tuple[str, ...] = (
    # Always-present in the legacy contract — seed data covers these.
    "fiber", "sugar", "added_sugar_g", "sodium",
    # Fats panel. trans_fat_g sits next to saturated/cholesterol because
    # health insights treat them as a related triad.
    "cholesterol",
    "saturated_fat", "trans_fat_g", "monounsaturated_fat", "polyunsaturated_fat",
    # Omega-3 total + subtypes (mg). Legacy `omega_3` (grams) preserved for
    # backward compat; new ALA/EPA/DHA give seafood/algae-aware insights.
    "omega_3", "omega_3_ala_mg", "omega_3_epa_mg", "omega_3_dha_mg",
    # Omega-6 keeps explicit unit so the AI/extractor cannot ambiguate.
    "omega_6_mg",
    # Vitamins.
    "vitamin_a", "vitamin_c", "vitamin_d", "vitamin_e", "vitamin_k",
    "thiamin_b1", "riboflavin_b2", "niacin_b3", "vitamin_b6",
    "folate_b9", "vitamin_b12", "biotin_b7", "pantothenic_acid_b5",
    "choline_mg",
    # Minerals.
    "calcium", "iron", "magnesium", "phosphorus", "potassium",
    "zinc", "selenium", "copper", "manganese", "iodine_mcg",
    # Sleep / recovery / next-day-readiness inputs.
    "caffeine_mg", "alcohol_g",
)

DEFAULT_NUTRITION_PANTRY: tuple[str, ...] = (
    "chicken breast",
    "salmon",
    "eggs",
    "greek yogurt",
    "cottage cheese",
    "tofu",
    "tempeh",
    "lentils",
    "chickpeas",
    "black beans",
    "brown rice",
    "quinoa",
    "oats",
    "sweet potato",
    "broccoli",
    "spinach",
    "kale",
    "olive oil",
    "avocado",
    "almonds",
    "peanut butter",
    "banana",
    "berries",
)


def default_foods_for_generation(req: "PlanRequest", allowed_foods: list[str] | None) -> list[str]:
    """Return the pantry the nutrition generator should use.

    An empty food list means the user skipped the optional foods step, not
    that they want zero meals. Keep selected-food validation strict, but give
    skipped-food users a broad default pantry that still respects diet and
    allergy filters.
    """
    explicit = [str(f).strip() for f in (allowed_foods or []) if str(f).strip()]
    if explicit:
        return explicit

    pantry = list(DEFAULT_NUTRITION_PANTRY)
    try:
        from .deterministic_skeleton import _filter_pantry
        pantry = _filter_pantry(
            pantry,
            getattr(req, "dietaryPreference", None),
            getattr(req, "allergies", None) or [],
        )
    except Exception:
        pass
    return pantry


def _unique_food_names(*groups: Iterable[str] | None) -> list[str]:
    """Merge food-name lists case-insensitively while preserving first spelling."""
    out: list[str] = []
    seen: set[str] = set()
    for group in groups:
        for raw in group or []:
            name = str(raw).strip()
            if not name:
                continue
            key = name.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(name)
    return out


def selected_food_names_for_generation(req: "PlanRequest", allowed_foods: list[str] | None) -> list[str]:
    """Foods the user explicitly selected or created for meal planning."""
    return _unique_food_names(allowed_foods, getattr(req, "customFoodNames", None) or [])


def food_names_for_generation(req: "PlanRequest", allowed_foods: list[str] | None) -> list[str]:
    """Full pantry for enrichment/skeleton generation, including custom foods."""
    base = default_foods_for_generation(req, allowed_foods)
    return _unique_food_names(base, getattr(req, "customFoodNames", None) or [])


@dataclass
class FoodMacros:
    """Per-serving macros + micronutrients for one food.

    `micros` carries every key in `MICRONUTRIENT_FIELDS`, defaulting to 0
    when the source data doesn't have a value. Keeping micros in a dict
    (rather than ~30 dataclass fields) means the assembler can iterate
    them generically and adding a new field is a one-line change to
    `MICRONUTRIENT_FIELDS`.
    """
    name: str
    serving_label: str        # human-readable: "6 oz (170g)"
    serving_quantity: float   # numeric: 6
    serving_unit: str         # "oz" / "g" / "piece" / ...
    calories: float
    protein: float
    carbs: float
    fat: float
    # Per-serving micronutrient values. Keys must come from
    # MICRONUTRIENT_FIELDS; missing keys are treated as 0 by the assembler.
    micros: dict = field(default_factory=dict)
    processing_bucket: str | None = None
    plant_count: int = 0
    omega3_flag: bool = False
    seafood_flag: bool = False
    # True when these macros are fabricated because enrichment didn't
    # know this food. Meals containing stubs are flagged `confidence:
    # "low"` on the output so callers don't treat the numbers as
    # trustworthy.
    is_stub: bool = False


@dataclass
class MealSkeleton:
    """The AI's creative contribution — a meal concept, no math.

    Meals are no longer tied to named slots (breakfast/lunch/dinner). Every
    meal is equal; the only positional info is `index` within the template.
    Keeping `index` around lets the validator dedupe and the solver split
    the daily target evenly. `target_fraction` is computed as 1/N.
    """
    name: str                 # "Grilled chicken rice bowl"
    index: int                # 0-based position in the template
    food_refs: list[str]      # ["chicken breast", "white rice", "broccoli"]
    target_fraction: float    # 1/N of daily calories


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
                                    "food_refs": {
                                        "type": "array",
                                        "items": {"type": "string"},
                                    },
                                },
                                "required": ["name", "food_refs"],
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


def build_skeleton_prompt(
    req: "PlanRequest",
    target_macros: tuple[int, int, int, int],
    variety_n: int,
    allowed_foods: list[str],
    *,
    db: Any = None,
    user_id: int | None = None,
) -> str:
    """The new skeleton-only prompt. ~80% smaller than the old nutrition prompt.

    We deliberately do NOT ask for macros or grams here — the algorithm
    computes those. The AI's only job is to pick meal concepts and food
    combinations from the user's allowed list.
    """
    t_cal, t_prot, t_carbs, t_fat = target_macros
    requested_variety_n = max(1, min(7, int(variety_n or 1)))
    variety_n = requested_variety_n
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

    # Routine awareness. Two possible sources:
    #   (a) `req.mealRoutine` — free-text the user typed during onboarding
    #   (b) `req.routineMacros` + `req.routineSlots` — structured pinned
    #       meals from the in-app routine UI. The macros are already
    #       SUBTRACTED from the target the AI sees.
    # Either way, the AI must NOT recreate the routine meals — they're
    # overlaid onto the plan by the client after generation. We pass the
    # info in purely as context so the AI picks complementary meals.
    routine_parts: list[str] = []
    structured_routine_count = len(getattr(req, "routineSlots", None) or [])
    structured_routine_macros = getattr(req, "routineMacros", None) or {}
    if structured_routine_count > 0 or structured_routine_macros:
        rc_cal  = int(structured_routine_macros.get("calories", 0) or 0)
        rc_prot = int(structured_routine_macros.get("protein", 0) or 0)
        rc_carb = int(structured_routine_macros.get("carbs", 0) or 0)
        rc_fat  = int(structured_routine_macros.get("fat", 0) or 0)
        routine_parts.append(
            f"\nPINNED ROUTINE MEALS (handled separately — do NOT recreate them):\n"
            f"- The user has {structured_routine_count} fixed meal(s) already pinned "
            f"that will be added to the final plan automatically.\n"
            f"- Those pinned meals account for {rc_cal} cal / {rc_prot}g P / "
            f"{rc_carb}g C / {rc_fat}g F already.\n"
            f"- The macro target shown below is ALREADY reduced to account for "
            f"these pinned meals. Your job is to generate meals that complement "
            f"them — no duplicates, no similar "
            f"concepts to fill the same role. If you see 'chicken rice bowl' as a "
            f"routine and you pick 'chicken rice plate', that's a duplicate; pick "
            f"a different protein/carb combination instead.\n"
        )
    if req.mealRoutine:
        routine_parts.append(
            f"\nUSER'S MEAL HABIT NOTES (context only, describe what they normally eat):\n"
            f"{req.mealRoutine}\n"
        )
    routine_block = "".join(routine_parts)

    # Shared nutrition context — adds bodyweight, experience, secondary
    # goal, weight trend, recent macro adherence, and last 3 days of
    # completed workouts so the meal AI can make smarter picks (e.g.
    # higher carbs on a day following a heavy legs session).
    from .context import build_nutrition_context, format_for_prompt
    # The active goal model: primaryGoal + targetFocus. Modifiers and
    # secondaryGoal are deprecated (always empty).
    _target_focus = getattr(req.goalSelection, "targetFocus", None) if req.goalSelection else getattr(req, "focusedMuscleGroup", None)
    _nctx = build_nutrition_context(
        goal=req.goalSelection.primaryGoal if req.goalSelection else req.goal,
        secondary_goal=_target_focus,
        experience=getattr(req, "experienceLevel", None),
        bodyweight_lbs=getattr(getattr(req, "physicalStats", None), "weightLbs", None) if hasattr(req, "physicalStats") else getattr(req, "weightLbs", None),
        target_weight_lbs=getattr(getattr(req, "goalDetails", None), "targetWeightLbs", None) if hasattr(req, "goalDetails") else None,
        pace=getattr(getattr(req, "goalDetails", None), "pace", None) if hasattr(req, "goalDetails") else None,
        dietary_preference=getattr(req, "dietaryPreference", None),
        allergies=getattr(req, "allergies", None),
        foods_available=allowed_foods,
        db=db,
        user_id=user_id,
    )
    user_context_block = format_for_prompt(_nctx)

    return f"""You are a registered dietitian. Pick meal concepts ONLY — no macros, no grams, no portions.

The app will compute portions and macros itself. Your job is purely creative:
choose meal names and which foods go in each meal.

USER:
- Goal: {req.goalSelection.primaryGoal if req.goalSelection else req.goal}
- Daily targets (for context only, do NOT compute macros): {t_cal} cal / {t_prot}g P / {t_carbs}g C / {t_fat}g F
{diet_context}
{user_context_block}
{routine_block}
AVAILABLE FOODS — use ONLY these names, no substitutions, no additions:
{foods_str}

Return a practical set of well-balanced meal concepts that together cover the day's macros.
Do not force a meal count, and do not add filler meals solely to satisfy a breakfast /
lunch / dinner pattern. Use time-of-day names only when they naturally fit the foods
or the user's routine.

{variety_line}

For every meal, return:
  - name: short recipe name (e.g. "Grilled chicken rice bowl")
  - food_refs: 2-4 food names copied EXACTLY from the available-foods list above.
               Every string in food_refs MUST match a name in that list.

IMPORTANT: There is NO minimum or maximum calorie limit per meal. Meals can be any size —
a 200-cal snack or a 900-cal feast are both fine. What matters is that all meals
together hit the daily target. Vary meal sizes naturally (a lighter breakfast and
a bigger dinner is fine, or equal-sized meals — whatever suits the foods).

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
        {{"name": "Grilled chicken rice bowl", "food_refs": ["chicken breast", "white rice", "broccoli"]}}
      ]
    }}
  ]
}}

Return {variety_n} template{'' if variety_n == 1 else 's'}.
Do NOT include calories, protein, carbs, fat, grams, or quantities anywhere.
"""


def call_skeleton_ai(
    client: OpenAI,
    req: "PlanRequest",
    target_macros: tuple[int, int, int, int],
    variety_n: int,
    allowed_foods: list[str],
    model: str | None = None,
    *,
    db: Any = None,
    user_id: int | None = None,
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
    prompt = build_skeleton_prompt(req, target_macros, variety_n, allowed_foods, db=db, user_id=user_id)
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
                ai_route="/nutrition/meal-skeleton",
                ai_user_id=user_id,
                ai_budget_bucket="meal_parsing",
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
            for tpl_raw in templates_raw:
                meals_raw = tpl_raw.get("meals") or []
                meals_raw = list(meals_raw)
                per_meal_fraction = 1.0 / len(meals_raw) if meals_raw else 1.0
                meals: list[MealSkeleton] = []
                for i, m in enumerate(meals_raw):
                    meals.append(MealSkeleton(
                        name=str(m.get("name", "Meal")).strip() or f"Meal {i+1}",
                        index=i,
                        food_refs=[str(f).strip() for f in (m.get("food_refs") or []) if f],
                        target_fraction=per_meal_fraction,
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


# ─── Food category heuristics (protein / carb / vegetable) ──────────────────
# Used only by the balanced-meal fallback when a skeleton meal loses all
# its food_refs after validation and we need to synthesize a replacement.

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

# Preferred carbs — picked first by the balanced fallback when available.
# Whole grains and high-fiber starches give meals real fiber numbers
# (3-10x what white rice / white pasta provide), which matches what
# users expect when they see "balanced meal" in their plan.
_CARB_KEYWORDS_PREFERRED = {
    "brown rice", "quinoa", "oats", "oatmeal", "whole wheat", "whole grain",
    "sweet potato", "barley", "bulgur", "farro", "buckwheat", "wild rice",
}

_VEG_KEYWORDS = {
    "broccoli", "spinach", "kale", "lettuce", "tomato", "cucumber", "carrot",
    "pepper", "onion", "zucchini", "asparagus", "green bean", "mushroom",
    "cauliflower", "cabbage", "salad",
}

# Fat sources — needed in the balanced fallback so the solver can hit
# real-world fat targets. Without one, the picker returns lean protein +
# carb + low-fat veg and the solver can't physically reach 50g+ fat
# regardless of multipliers, so it backs off everything else and the
# whole meal undershoots calories.
_FAT_KEYWORDS = {
    "olive oil", "oil", "butter", "ghee", "avocado", "almond", "almonds",
    "cashew", "cashews", "walnut", "walnuts", "peanut", "peanut butter",
    "almond butter", "cheese", "cheddar", "mozzarella", "parmesan",
    "feta", "cream cheese", "coconut", "tahini", "mayo", "mayonnaise",
}


def _food_matches_keywords(name: str, keywords: set[str]) -> bool:
    n = name.lower()
    return any(k in n for k in keywords)


def validate_and_repair_skeletons(
    templates: list[TemplateSkeleton],
    allowed_foods: list[str],
    *,
    required_count: int | None = None,
    food_quality_scores: dict[str, float] | None = None,
) -> list[TemplateSkeleton]:
    """Drop any food_ref not in the allowed list and repair empty meals.

    Meals are no longer slot-typed or count-targeted. If a template has
    no usable meals at all, we append one balanced fallback so generation
    still returns something actionable when compatible foods exist.
    `required_count` is accepted for legacy callers/tests; when supplied,
    templates are padded/truncated after repair.
    """
    if not allowed_foods:
        return templates

    allowed_token_map = {name: _tokens(name) for name in allowed_foods}

    for tpl in templates:
        used_in_template: set[str] = set()

        # 1. Clean every existing meal's food refs.
        for meal in tpl.meals:
            cleaned: list[str] = []
            seen: set[str] = set()
            for ref in meal.food_refs:
                match = _best_allowed_match(ref, allowed_token_map)
                if match and match.lower() not in seen:
                    cleaned.append(match)
                    seen.add(match.lower())
            if not cleaned:
                fallback = _balanced_meal_fallback(
                    allowed_foods,
                    used_in_template,
                    food_quality_scores=food_quality_scores,
                )
                print(
                    f"[meal_assembler] meal '{meal.name}' had no valid "
                    f"foods — balanced fallback: {fallback}"
                )
                cleaned = fallback
            meal.food_refs = cleaned
            used_in_template.update(f.lower() for f in cleaned)

        if not tpl.meals:
            fallback = _balanced_meal_fallback(
                allowed_foods,
                used_in_template,
                food_quality_scores=food_quality_scores,
            )
            if not fallback:
                print("[meal_assembler] cannot repair empty template — no allowed foods")
            else:
                idx = len(tpl.meals)
                tpl.meals.append(MealSkeleton(
                    name=f"Meal {idx+1}",
                    index=idx,
                    food_refs=fallback,
                    target_fraction=1.0,
                ))
                used_in_template.update(f.lower() for f in fallback)

        if required_count is not None:
            n_required = max(0, int(required_count or 0))
            while len(tpl.meals) < n_required:
                fallback = _balanced_meal_fallback(
                    allowed_foods,
                    used_in_template,
                    food_quality_scores=food_quality_scores,
                )
                if not fallback:
                    break
                idx = len(tpl.meals)
                tpl.meals.append(MealSkeleton(
                    name=f"Meal {idx+1}",
                    index=idx,
                    food_refs=fallback,
                    target_fraction=0.0,
                ))
                used_in_template.update(f.lower() for f in fallback)
            if len(tpl.meals) > n_required:
                tpl.meals = tpl.meals[:n_required]

        # 2. Reassign indices + fractions across the actual generated meals.
        n = len(tpl.meals)
        for i, m in enumerate(tpl.meals):
            m.index = i
            m.target_fraction = 1.0 / n if n > 0 else 0.0

    return templates

def _balanced_meal_fallback(
    allowed_foods: list[str],
    used: set[str] | None = None,
    food_quality_scores: dict[str, float] | None = None,
) -> list[str]:
    """Pick a protein + carb + vegetable + fat combo from allowed_foods.

    Including a fat source is critical for the portion solver: without one,
    the picker returns lean protein + carb + low-fat veg and the solver can
    never reach realistic fat targets (50–80 g for a 1500–2000 cal meal),
    which forces it to back off other macros and undershoot calories too.

    If a category isn't present in the allowed list we degrade to whatever
    is available, but we never return an empty list — the solver needs at
    least something to work on.
    """
    if not allowed_foods:
        return []
    used_lower = {str(f).lower() for f in (used or set())}
    available = [
        f for f in allowed_foods
        if str(f).lower() not in used_lower
    ] or list(allowed_foods)

    def _rank(candidates: list[str]) -> list[str]:
        if not food_quality_scores:
            return candidates
        return sorted(
            candidates,
            key=lambda f: (-float(food_quality_scores.get(f.lower(), 0.0)), f.lower()),
        )

    def pick(keywords: set[str], excluded: set[str] | None = None) -> str | None:
        excl = excluded or set()
        for f in _rank(available):
            if f in excl:
                continue
            if _food_matches_keywords(f, keywords):
                return f
        for f in _rank(allowed_foods):
            if f in excl:
                continue
            if _food_matches_keywords(f, keywords):
                return f
        return None

    prot = pick(_PROTEIN_KEYWORDS)
    chosen = {prot} if prot else set()
    # Prefer whole-grain / high-fiber carbs first (brown rice, oats,
    # quinoa, sweet potato), fall back to refined grains (white rice,
    # pasta, bread) only when none of the preferred ones are in the
    # allowed list. White rice + broccoli gives ~3g fiber; brown rice +
    # broccoli gives ~6g — same calorie cost, much better fiber profile.
    carb = pick(_CARB_KEYWORDS_PREFERRED, excluded=chosen)
    if not carb:
        carb = pick(_CARB_KEYWORDS, excluded=chosen)
    if carb:
        chosen.add(carb)
    veg = pick(_VEG_KEYWORDS, excluded=chosen)
    if veg:
        chosen.add(veg)
    fat = pick(_FAT_KEYWORDS, excluded=chosen)
    picks = [x for x in (prot, carb, veg, fat) if x]
    if picks:
        return picks
    return available[:2]


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

    if "serving" in raw:
        bare = _re.match(r"(\d+(?:\.\d+)?)", raw)
        if bare:
            try:
                return float(bare.group(1)), "serving"
            except ValueError:
                pass
        return 1.0, "serving"

    # Last resort: maybe there's a number with no unit ("2 large") — treat
    # as pieces, which is the right call for countable items.
    bare = _re.match(r"(\d+(?:\.\d+)?)", raw)
    if bare:
        try:
            return float(bare.group(1)), "piece"
        except ValueError:
            pass
    return 1.0, "serving"


_QUALITY_MICRO_TARGETS: dict[str, float] = {
    "calcium": 1000.0,
    "iron": 18.0,
    "potassium": 4700.0,
    "magnesium": 420.0,
    "vitamin_d": 20.0,
    "vitamin_b12": 2.4,
}


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value > 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return False


def _valid_processing_bucket(value: Any) -> str | None:
    bucket = str(value or "").strip().lower()
    if bucket in {"minimally_processed", "processed", "ultra_processed"}:
        return bucket
    quality = str(value or "").strip().lower()
    if quality in {"whole", "minimally_processed"}:
        return "minimally_processed"
    return None


def _quality_metadata_from_raw(raw: dict, *, db: Any = None) -> dict[str, Any]:
    """Read score-relevant food metadata without inventing classifications."""
    name = str(raw.get("name") or "").strip()
    bucket = (
        _valid_processing_bucket(raw.get("processing_bucket"))
        or _valid_processing_bucket(raw.get("food_quality"))
    )
    plant_count = int(max(0, _safe_float(
        raw.get("plant_count", raw.get("plant_count_value", 0)),
        0.0,
    )))
    likely_plants = raw.get("likely_plant_foods")
    if plant_count <= 0 and isinstance(likely_plants, list):
        plant_count = len([p for p in likely_plants if p])
    omega3_flag = (
        _safe_bool(raw.get("omega3_flag"))
        or _safe_bool(raw.get("omega3_rich"))
        or _safe_float(raw.get("omega_3"), 0.0) > 0
    )
    seafood_flag = _safe_bool(raw.get("seafood_flag")) or _safe_bool(raw.get("seafood"))

    if db is not None and name:
        try:
            from .ai_classify import lookup_classification
            meta = lookup_classification(name, db)
            if meta is not None:
                bucket = _valid_processing_bucket(getattr(meta, "processing_bucket", None)) or bucket
                plant_count = max(plant_count, int(getattr(meta, "plant_count_value", 0) or 0))
                omega3_flag = omega3_flag or bool(getattr(meta, "omega3_flag", False))
                seafood_flag = seafood_flag or bool(getattr(meta, "seafood_flag", False))
        except Exception:
            pass

    return {
        "processing_bucket": bucket,
        "plant_count": plant_count,
        "omega3_flag": omega3_flag,
        "seafood_flag": seafood_flag,
    }


def _quality_micro_value(raw: dict, key: str) -> float:
    aliases = {
        "calcium": ("calcium", "calcium_mg"),
        "iron": ("iron", "iron_mg"),
        "potassium": ("potassium", "potassium_mg"),
        "magnesium": ("magnesium", "magnesium_mg"),
        "vitamin_d": ("vitamin_d", "vitamin_d_mcg", "vitaminD"),
        "vitamin_b12": ("vitamin_b12", "vitamin_b12_mcg", "vitaminB12"),
    }.get(key, (key,))
    for alias in aliases:
        value = _safe_float(raw.get(alias), 0.0)
        if value > 0:
            return value
    return 0.0


def _food_quality_score(raw: dict, *, db: Any = None) -> float:
    """Approximate the server Nutrition Score inputs for food selection.

    This is deliberately not a replacement for `/meals/score`; it is a
    deterministic ranking signal so two foods with similar macro usefulness
    prefer the one that improves fiber, micros, plants, omega-3, and processing.
    """
    calories = max(1.0, _safe_float(raw.get("calories"), 0.0))
    fiber = _safe_float(raw.get("fiber", raw.get("fiber_g")), 0.0)
    added_sugar = _safe_float(
        raw.get("added_sugar_g", raw.get("added_sugar", raw.get("added_sugars_g"))),
        0.0,
    )
    saturated_fat = _safe_float(raw.get("saturated_fat", raw.get("saturated_fat_g")), 0.0)
    sodium = _safe_float(raw.get("sodium", raw.get("sodium_mg")), 0.0)
    omega3_g = _safe_float(raw.get("omega_3", raw.get("omega_3_g")), 0.0)
    meta = _quality_metadata_from_raw(raw, db=db)

    score = 45.0
    score += min(18.0, (fiber / calories * 1000.0) / 14.0 * 18.0)
    score += min(12.0, float(meta["plant_count"]) * 3.0)
    if meta["omega3_flag"] or omega3_g >= 0.25:
        score += 10.0
    elif omega3_g > 0:
        score += 5.0

    bucket = meta["processing_bucket"]
    if bucket == "minimally_processed":
        score += 8.0
    elif bucket == "processed":
        score += 2.0
    elif bucket == "ultra_processed":
        score -= 16.0

    for micro, target in _QUALITY_MICRO_TARGETS.items():
        amount = _quality_micro_value(raw, micro)
        if amount > 0:
            score += min(4.0, (amount / max(1.0, target * 0.25)) * 4.0)

    added_sugar_pct = (added_sugar * 4.0) / calories * 100.0
    sat_fat_pct = (saturated_fat * 9.0) / calories * 100.0
    sodium_density = sodium / calories * 1000.0
    score -= min(18.0, max(0.0, added_sugar_pct - 5.0) * 1.4)
    score -= min(14.0, max(0.0, sat_fat_pct - 10.0) * 1.0)
    score -= min(12.0, max(0.0, sodium_density - 1100.0) / 250.0)

    return round(max(0.0, min(100.0, score)), 2)


def build_food_quality_scores(enriched: dict | None, *, db: Any = None) -> dict[str, float]:
    """Return name -> quality score used to rank same-role generation foods."""
    scores: dict[str, float] = {}
    for f in (enriched or {}).get("foods", []) or []:
        if not isinstance(f, dict):
            continue
        name = str(f.get("name") or "").strip()
        if not name:
            continue
        scores[name.lower()] = _food_quality_score(f, db=db)
    return scores


def build_food_lookup(enriched: dict | None, *, db: Any = None) -> dict[str, FoodMacros]:
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
        # Never ship "serving" as a unit — it's meaningless to the user
        # and pre-empts macro scaling. Upgrade to a food-type-aware default
        # (cup for liquids, oz for meat, piece for whole items).
        if unit == "serving":
            serving_count = qty if qty > 0 else 1.0
            default_qty, unit = _guess_unit_for_food(name)
            qty = default_qty * serving_count
            label = f"{qty:g} {unit}"
        # Map every supported micronutrient field. Hydrate flattens both
        # legacy columns (fiber/sugar/sodium) and `extra_nutrients` into
        # the same dict, so a single loop captures everything.
        micros: dict[str, float] = {}
        for k in MICRONUTRIENT_FIELDS:
            v = f.get(k)
            if v is None:
                continue
            try:
                micros[k] = float(v)
            except (TypeError, ValueError):
                continue
        quality_meta = _quality_metadata_from_raw(f, db=db)
        lookup[name.lower()] = FoodMacros(
            name=name,
            serving_label=label,
            serving_quantity=qty,
            serving_unit=unit,
            calories=float(f.get("calories", 0) or 0),
            protein=float(f.get("protein", 0) or 0),
            carbs=float(f.get("carbs", 0) or 0),
            fat=float(f.get("fat", 0) or 0),
            micros=micros,
            processing_bucket=quality_meta["processing_bucket"],
            plant_count=int(quality_meta["plant_count"] or 0),
            omega3_flag=bool(quality_meta["omega3_flag"]),
            seafood_flag=bool(quality_meta["seafood_flag"]),
        )
    # Coverage warning — flag when most foods have only the basic 4 macros.
    # Helps spot a regression in the hydrate path or a thin seed file.
    if lookup:
        with_micros = sum(1 for fm in lookup.values() if any(v > 0 for v in fm.micros.values()))
        if with_micros < len(lookup) // 4:
            print(
                f"[meal_assembler] LOW MICRO COVERAGE — only {with_micros}/{len(lookup)} "
                f"foods carry any micronutrient data. Nutrition details will be sparse."
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
    cup_default_terms = (
        "oat", "rice", "pasta", "quinoa", "couscous", "barley", "noodle",
        "yogurt", "skyr", "cottage cheese", "ricotta", "sour cream", "kefir",
        "milk", "cereal", "granola", "bean", "lentil", "chickpea", "peas",
        "edamame", "vegetable", "broccoli", "spinach", "kale", "lettuce",
        "carrot", "potato", "sweet potato", "cauliflower", "berries", "berry",
        "fruit", "soup", "stew", "chili", "hummus", "salsa",
    )
    if any(k in n for k in cup_default_terms):
        return 1.0, "cup"
    if any(k in n for k in ("oil", "butter", "peanut butter", "almond butter", "dressing", "sauce", "honey", "maple syrup", "jam")):
        return 1.0, "tbsp"
    if "protein powder" in n or "whey" in n or "casein" in n:
        return 1.0, "scoop"
    # Default for meats, fish, tofu, nuts
    return 3.0, "oz"


_LOW_UTILITY_BEVERAGE_TERMS = (
    "coffee", "espresso", "latte", "cappuccino", "cold brew", "mocha",
    "tea", "matcha", "soda", "juice", "lemonade", "kombucha",
    "beer", "wine", "cocktail", "refresher", "frappe", "frappuccino",
    "energy drink", "drink", "beverage",
)
_CAFFEINE_BEVERAGE_TERMS = (
    "coffee", "espresso", "latte", "cappuccino", "cold brew", "mocha",
    "tea", "matcha", "energy drink",
)
_NUTRITIVE_BEVERAGE_EXCEPTIONS = (
    "protein", "whey", "casein", "meal replacement", "milk", "kefir",
    "smoothie", "shake",
)


def _is_low_utility_beverage(name: str) -> bool:
    n = str(name or "").lower()
    if not any(term in n for term in _LOW_UTILITY_BEVERAGE_TERMS):
        return False
    if any(term in n for term in _NUTRITIVE_BEVERAGE_EXCEPTIONS):
        return any(term in n for term in _CAFFEINE_BEVERAGE_TERMS)
    return True


def _planned_item_quantity_cap(name: str, unit: str) -> float | None:
    """Return a display-quantity cap for beverages that should not become
    macro filler. Non-beverages return None and keep the normal solver cap."""
    if not _is_low_utility_beverage(name):
        return None
    unit_norm = str(unit or "").lower()
    if unit_norm not in {"fl_oz", "oz", "cup", "ml", "l", "serving"}:
        return None
    is_caffeine = any(term in str(name or "").lower() for term in _CAFFEINE_BEVERAGE_TERMS)
    max_fl_oz = 16.0 if is_caffeine else 20.0
    if unit_norm in {"fl_oz", "oz"}:
        return max_fl_oz
    if unit_norm == "cup":
        return max_fl_oz / 8.0
    if unit_norm == "ml":
        return max_fl_oz * 29.5735
    if unit_norm == "l":
        return max_fl_oz / 33.814
    if unit_norm == "serving":
        return 1.0
    return None


def cap_planned_item_quantity(item: dict) -> bool:
    """Clamp an assembled item to a realistic beverage quantity.

    The macro fields are scaled by the same ratio so the displayed portion
    and calories stay physically consistent. Returns True when a cap applied.
    """
    if not isinstance(item, dict):
        return False
    q = item.get("quantity")
    if not isinstance(q, (int, float)) or q <= 0:
        return False
    cap = _planned_item_quantity_cap(str(item.get("name") or ""), str(item.get("unit") or ""))
    if cap is None or float(q) <= cap:
        return False
    ratio = cap / float(q)
    item["quantity"] = round(cap, 3)
    for macro_key in ("calories", "protein", "carbs", "fat", "fiber"):
        v = item.get(macro_key)
        if isinstance(v, (int, float)):
            item[macro_key] = int(round(float(v) * ratio)) if macro_key == "calories" else round(float(v) * ratio, 1)
    micros = item.get("micronutrients")
    if isinstance(micros, dict):
        for key, value in list(micros.items()):
            if isinstance(value, (int, float)):
                micros[key] = round(float(value) * ratio, 2)
    return True


def _max_multiplier_for_food(food: FoodMacros) -> float:
    cap = _planned_item_quantity_cap(food.name, food.serving_unit)
    if cap is None or food.serving_quantity <= 0:
        return 15.0
    return max(0.05, min(15.0, cap / food.serving_quantity))


def _cap_multiplier_for_food(food: FoodMacros, multiplier: float) -> float:
    return min(multiplier, _max_multiplier_for_food(food))


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
        micros={},
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
    [0.1, 12.0]. The wide upper bound is intentional — when only one or
    two foods cover a category (e.g. only one fat source on the user's
    list and a 1500-cal solo meal that needs 50g+ fat), the solver has
    to dial that food up significantly to satisfy the target. Capping at
    5x silently prevented the meal from reaching its calorie target and
    looked like a "max meal calories" bug.

    This is not globally optimal but it's transparent, dependency-free, and
    consistently lands within ~5% of target for realistic meals. The final
    plan-level normalizer (`_normalize_template_to_target` in plans.py)
    closes any residual drift to exactly the meal/day target.
    """
    if not foods:
        return []

    n = len(foods)
    # Seed with 1 serving each. This is the "1 serving of everything" baseline
    # the enrichment gives us, which is usually near-realistic already.
    m = [1.0] * n

    # Protein is the top priority — hitting the protein target is the primary
    # purpose of the plan. Calories are second (goal adherence). Carbs and
    # fat absorb the remaining slack. Protein outweighing calories means the
    # solver won't sacrifice protein just because a high-protein food is also
    # calorie-dense.
    weights = {
        "cal": 2.0,
        "prot": 3.0,
        "carb": 1.0,
        "fat": 1.0,
    }
    targets = {
        "cal": max(target_cal, 1.0),
        "prot": max(target_prot, 1.0),
        "carb": max(target_carb, 1.0),
        "fat": max(target_fat, 1.0),
    }

    # Two-phase descent: coarse alignment (lr=0.1) for 150 iterations, then a
    # fine-tuning pass (lr=0.03) for 100 more. The decay stops oscillation
    # that occurs in the last iterations of a fixed-rate schedule when the
    # solver is close to target and small gradient steps keep overshooting.
    lr = 0.1
    for iteration in range(250):
        if iteration == 150:
            lr = 0.03
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
            # Clamp: floor prevents a food from going to ~0 ("remove it"
            # which the user wouldn't expect); ceiling prevents the
            # solver from running away to absurd portions on a single food.
            # The ceiling is generous on purpose — see docstring.
            if m[j] < 0.05:
                m[j] = 0.05
            else:
                upper = _max_multiplier_for_food(foods[j])
                if m[j] > upper:
                    m[j] = upper
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
_SOLVER_ACCEPT_CAL  = 0.20   # ±20% of meal calorie target (was 25%)
_SOLVER_ACCEPT_PROT = 0.15   # ±15% of meal protein target (was 30%) — protein is top priority
_SOLVER_ACCEPT_CARB = 0.35   # ±35% (was 40%)
_SOLVER_ACCEPT_FAT  = 0.35   # ±35% (was 40%)


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

    multipliers = [
        _cap_multiplier_for_food(food, _round_to_nice_quantity(mult))
        for food, mult in zip(foods, raw_multipliers)
    ]
    post_round_residual = _solver_residual(
        foods, multipliers, target_cal, target_prot, target_carb, target_fat,
    )

    items: list[dict] = []
    total_cal = total_pro = total_cb = total_ft = 0.0
    # Aggregate every supported micronutrient field. Initialised to zero
    # for every key in MICRONUTRIENT_FIELDS so the output dict always has
    # the full schema (frontend can show "—" instead of missing keys).
    total_micros: dict[str, float] = {k: 0.0 for k in MICRONUTRIENT_FIELDS}
    for food, mult in zip(foods, multipliers):
        item_cal = food.calories * mult
        item_pro = food.protein * mult
        item_cb  = food.carbs   * mult
        item_ft  = food.fat     * mult
        item_micros = {}
        for k, v in (food.micros or {}).items():
            if k in total_micros:
                scaled = v * mult
                if scaled > 0:
                    item_micros[k] = round(scaled, 2)
        quality_fields: dict[str, Any] = {}
        if food.processing_bucket:
            quality_fields["processing_bucket"] = food.processing_bucket
            quality_fields["food_quality"] = (
                "whole" if food.processing_bucket == "minimally_processed"
                else food.processing_bucket
            )
        if food.plant_count > 0:
            quality_fields["plant_count"] = food.plant_count
        if food.omega3_flag:
            quality_fields["omega3_flag"] = True
            quality_fields["omega3_rich"] = True
        if food.seafood_flag:
            quality_fields["seafood_flag"] = True
            quality_fields["seafood"] = True
        items.append({
            "name": food.name,
            "quantity": round(food.serving_quantity * mult, 2),
            "unit": food.serving_unit,
            "calories": round(item_cal),
            "protein": round(item_pro, 1),
            "carbs": round(item_cb, 1),
            "fat": round(item_ft, 1),
            **quality_fields,
            **({"micronutrients": item_micros} if item_micros else {}),
        })
        total_cal += item_cal
        total_pro += item_pro
        total_cb  += item_cb
        total_ft  += item_ft
        for k, v in (food.micros or {}).items():
            if k in total_micros:
                total_micros[k] += v * mult

    # Quality flag: stubs or residual-out-of-bounds both degrade confidence.
    solver_ok = _solver_accepts(post_round_residual)
    confidence: str
    if stub_names or not solver_ok:
        confidence = "low"
        print(
            f"[meal_assembler] LOW-CONFIDENCE meal '{skeleton.name}' (#{skeleton.index+1}): "
            f"stubs={stub_names or '-'} "
            f"residual_cal={post_round_residual['cal']:+.2f} "
            f"residual_prot={post_round_residual['prot']:+.2f} "
            f"residual_carb={post_round_residual['carb']:+.2f} "
            f"residual_fat={post_round_residual['fat']:+.2f}"
        )
    else:
        confidence = "high"

    # Round every micronutrient to 2 dp for display. Fiber/sugar/added sugar
    # use 1 dp to match the legacy frontend display; sodium goes to whole mg.
    micros_out: dict[str, float] = {}
    for k, v in total_micros.items():
        if k in ("fiber", "sugar", "added_sugar_g"):
            micros_out[k] = round(v, 1)
        elif k == "sodium":
            micros_out[k] = round(v)
        else:
            micros_out[k] = round(v, 2)

    return {
        "meal": skeleton.name,
        "items": items,
        "calories": round(total_cal),
        "protein": round(total_pro, 1),
        "carbs": round(total_cb, 1),
        "fat": round(total_ft, 1),
        # Top-level fiber for the legacy display path that reads it
        # without going through `micronutrients`.
        "fiber": micros_out.get("fiber", 0),
        # Full micronutrient panel — every key in MICRONUTRIENT_FIELDS is
        # present, defaulting to 0 when the source food data didn't carry
        # a value. Frontend can render "—" for zero entries instead of
        # showing fabricated numbers.
        "micronutrients": micros_out,
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
    """Turn one template's worth of skeletons into the canonical plan dict.

    Output shape:
        {
          "targets": {calories, protein, carbs, fat},
          "meals": [ {name, items, calories, ...}, ... ]
        }
    No named slots — meals are just a flat list the client iterates.
    """
    meals_out: list[dict] = []
    for meal in skeleton.meals:
        frac = meal.target_fraction
        meals_out.append(assemble_meal(
            meal,
            food_lookup,
            target_cal  * frac,
            target_prot * frac,
            target_carb * frac,
            target_fat  * frac,
        ))
    return {
        "targets": {
            "calories": target_cal,
            "protein": target_prot,
            "carbs": target_carb,
            "fat": target_fat,
        },
        "meals": meals_out,
    }


def _estimated_template_nutrition_score(
    template_out: dict,
    *,
    goal: str | None = None,
    sex: str | None = None,
) -> dict[str, int]:
    """Score a generated template with the same projected-score machinery
    used by `/meals/score`, before the plan is persisted.

    This lets generation choose among deterministic candidate days by the
    headline Nutrition Score after macros, food quality, and micronutrient
    coverage have all been assembled.
    """
    try:
        from .nutrition_score import NutritionIndicators, compute_nutrition_score
        from .score_builder import _macro_from_meal, _projected_micros, _projected_quality_signals

        meals = [
            meal for meal in (template_out.get("meals") or [])
            if isinstance(meal, dict)
        ]
        targets = template_out.get("targets") if isinstance(template_out.get("targets"), dict) else {}
        calories_target = float(targets.get("calories") or 0)
        protein_target = float(targets.get("protein") or targets.get("protein_g") or 0)
        total_cal = sum(_macro_from_meal(meal, "calories") for meal in meals)
        total_pro = sum(_macro_from_meal(meal, "protein", "protein_g") for meal in meals)
        micros, food_count, foods_with_micros = _projected_micros(meals)
        quality = _projected_quality_signals(meals)
        score = compute_nutrition_score(
            NutritionIndicators(
                calories_logged=total_cal,
                calories_target=calories_target,
                protein_logged=total_pro,
                protein_target=protein_target,
                fiber_g=micros.get("fiber_g", 0.0),
                added_sugar_g=micros.get("added_sugar_g", 0.0),
                saturated_fat_g=micros.get("saturated_fat_g", 0.0),
                sodium_mg=micros.get("sodium_mg", 0.0),
                minimally_processed_pct=quality["minimally_processed_pct"],
                ultra_processed_pct=quality["ultra_processed_pct"],
                distinct_plant_foods=int(quality["distinct_plant_foods"]),
                omega3_servings=quality["omega3_servings"],
                seafood_servings_weekly=quality["seafood_servings"],
                meals_logged=len(meals),
                meals_expected=len(meals),
                micronutrients=micros,
                food_count=food_count,
                foods_with_micros=foods_with_micros,
            ),
            goal=str(goal or "body_recomp"),
            sex=sex,
        )
        return {
            "total": int(score.total),
            "adherence": int(score.adherence_score),
            "quality": int(score.quality_score),
            "micro": int(score.micro_score),
        }
    except Exception:
        return {"total": 0, "adherence": 0, "quality": 0, "micro": 0}


# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — Top-level entry
# ─────────────────────────────────────────────────────────────────────────────


def _build_deterministic_template(
    allowed_foods: list[str],
    *,
    food_quality_scores: dict[str, float] | None = None,
) -> TemplateSkeleton:
    """Build a deterministic balanced template without enforcing a meal count.

    Each meal is a deterministic balanced pick (protein + carb + veg)
    drawn from `_balanced_meal_fallback`. The default meal names are only
    presentation labels; they are not a user preference or a required
    meals-per-day target.
    """
    meal_types = ["Breakfast", "Lunch", "Dinner"]
    meals: list[MealSkeleton] = []
    used: set[str] = set()
    for i, meal_type in enumerate(meal_types):
        picks = _balanced_meal_fallback(
            allowed_foods,
            used,
            food_quality_scores=food_quality_scores,
        )
        if not picks:
            picks = list(allowed_foods[:2])
        used.update(p.lower() for p in picks)
        meals.append(MealSkeleton(
            name=meal_type,
            index=i,
            food_refs=picks,
            target_fraction=0.0,
        ))
    n = len(meals)
    for meal in meals:
        meal.target_fraction = 1.0 / n if n > 0 else 0.0
    return TemplateSkeleton(meals=meals)


def assemble_nutrition_response(
    client: OpenAI,
    req: "PlanRequest",
    target_macros: tuple[int, int, int, int],
    variety_n: int,
    allowed_foods: list[str],
    enriched: dict | None,
    *,
    db: Any = None,
    user_id: int | None = None,
) -> dict:
    """Build the full nutrition response using the hybrid pipeline.

    Returns:
        {
          "nutritionistNote": "...",
          "supplementStack": [...],
          "nutrition_plans": [
            {"targets": {...}, "meals": [ {...}, {...}, ... ]},
            ...
          ]
        }

    Meals are no longer slot-typed or count-targeted. The client receives
    a flat `meals[]` list and renders it uniformly. Routine meals reduce
    the macro target, but they no longer subtract from a meals-per-day
    budget because that preference has been removed.
    """
    t_cal, t_prot, t_carbs, t_fat = target_macros
    requested_variety_n = max(1, min(7, int(variety_n or 1)))
    variety_n = requested_variety_n

    # ── Routine accounting ────────────────────────────────────────────────
    # Pinned routines are overlaid on every day's plan by the client. Their
    # macros are subtracted from the daily target before we size generated
    # meals, but there is no target meal count to subtract from.
    routine_macros = getattr(req, "routineMacros", None) or {}
    routine_slots: list[str] = list(getattr(req, "routineSlots", None) or [])
    routine_count = len(routine_slots)
    r_cal  = int(routine_macros.get("calories", 0) or 0)
    r_prot = int(routine_macros.get("protein", 0) or 0)
    r_carb = int(routine_macros.get("carbs", 0) or 0)
    r_fat  = int(routine_macros.get("fat", 0) or 0)

    adj_cal  = max(0, t_cal  - r_cal)
    adj_prot = max(0, t_prot - r_prot)
    adj_carb = max(0, t_carbs - r_carb)
    adj_fat  = max(0, t_fat  - r_fat)
    adjusted = (adj_cal, adj_prot, adj_carb, adj_fat)

    nutrition_warnings: list[dict] = []
    raw_selected_foods = [str(f).strip() for f in (allowed_foods or []) if str(f).strip()]
    selected_foods = selected_food_names_for_generation(req, raw_selected_foods)
    used_default_pantry = not raw_selected_foods
    generation_foods = food_names_for_generation(req, raw_selected_foods)
    if used_default_pantry and generation_foods:
        nutrition_warnings.append({
            "severity": "info",
            "code": "default_pantry_used",
            "message": "No foods were selected during onboarding, so default meal suggestions were used.",
            "allowed_foods_count": 0,
            "compatible_foods_count": len(generation_foods),
        })
    try:
        from .deterministic_skeleton import _filter_pantry
        generation_foods = _filter_pantry(
            generation_foods,
            getattr(req, "dietaryPreference", None),
            getattr(req, "allergies", None) or [],
        )
    except Exception as exc:
        nutrition_warnings.append({
            "severity": "warning",
            "code": "pre_generation_food_filter_failed",
            "message": f"Could not pre-filter foods for diet/allergy constraints: {exc}",
        })
    if selected_foods and not generation_foods:
        nutrition_warnings.append({
            "severity": "error",
            "code": "no_compatible_foods",
            "message": (
                "All selected foods conflict with the current diet or allergy "
                "settings. Add compatible foods before external testing this plan."
            ),
            "allowed_foods_count": len(selected_foods),
        })
    elif len(generation_foods) < len(selected_foods):
        nutrition_warnings.append({
            "severity": "info",
            "code": "incompatible_foods_filtered",
            "message": "Some selected foods were removed before meal generation because of diet or allergy settings.",
            "allowed_foods_count": len(selected_foods),
            "compatible_foods_count": len(generation_foods),
        })

    food_quality_scores = build_food_quality_scores(enriched, db=db)

    # Always log the inputs the assembler saw so it's obvious from the
    # server log whether routines made it through the client → backend
    # → worker hand-off. Pairs with [plan-gen] routine inputs in plans.py.
    print(
        f"[meal_assembler] INPUTS — routineCount={routine_count} "
        f"routineMacros=(cal={r_cal},p={r_prot},c={r_carb},f={r_fat})"
    )

    if r_cal > 0 or routine_count > 0:
        print(
            f"[meal_assembler] routine offset: -{r_cal} cal / -{r_prot}P / "
            f"-{r_carb}C / -{r_fat}F → adjusted target {adjusted}"
        )
    elif getattr(req, "mealRoutine", None):
        # The user typed routine prose into the profile but no structured
        # routine macros / slots came through. Loud warning so the missing
        # client → backend wiring is easy to spot in logs.
        print(
            "[meal_assembler] WARNING: req.mealRoutine is set but routineMacros "
            "and routineSlots are empty — routine accounting WILL NOT happen. "
            "Check that buildRoutinePayload() is being called by the client."
        )

    # Prefer the deterministic skeleton generator. Toggle
    # `USE_DETERMINISTIC_SKELETON=0` to fall back to the AI path for
    # side-by-side comparison / debug; neither path enforces a meal count.
    if _deterministic_skeleton_enabled():
        from .deterministic_skeleton import generate_deterministic_skeleton
        candidate_variety_n = min(7, max(variety_n, variety_n * 2))
        _recent_names: list[str] = []
        if db and user_id:
            try:
                from datetime import date as _date, timedelta
                from sqlmodel import select, col
                from app.models import Meal
                _cutoff = _date.today() - timedelta(days=7)
                _recent_meals = db.exec(
                    select(Meal.name).where(Meal.user_id == user_id).where(col(Meal.meal_date) >= _cutoff)
                ).all()
                _recent_names = [n for n in _recent_meals if n]
            except Exception:
                pass
        templates, note, supps = generate_deterministic_skeleton(
            req, candidate_variety_n, generation_foods, db=db, user_id=user_id,
            preferred_foods=getattr(req, "customFoodNames", None) or [],
            recent_meal_names=_recent_names,
            food_quality_scores=food_quality_scores,
        )
        print(
            f"[meal_assembler] deterministic skeleton path — variety_n={variety_n}, "
            f"score_candidates={candidate_variety_n}, "
            f"generated_meals={sum(len(t.meals) for t in templates)}, "
            f"pantry={len(generation_foods)} "
            f"compatible foods ({len(selected_foods)} selected)"
        )
    else:
        templates, note, supps = call_skeleton_ai(
            client, req, adjusted, variety_n, generation_foods,
            db=db, user_id=user_id,
        )

    templates = validate_and_repair_skeletons(
        templates,
        generation_foods,
        food_quality_scores=food_quality_scores,
    )

    # Step 3 — food lookup
    food_lookup = build_food_lookup(enriched, db=db)

    # Step 4+5 — solve portions and assemble every template against
    # the ADJUSTED target so the math comes out right after overlay.
    candidate_plans = []
    for tpl in templates:
        candidate_plans.append(
            assemble_template(tpl, food_lookup, adj_cal, adj_prot, adj_carb, adj_fat)
        )

    if len(candidate_plans) > requested_variety_n:
        sex = None
        try:
            sex = getattr(getattr(req, "physicalStats", None), "gender", None)
        except Exception:
            sex = None
        scored_candidates: list[tuple[dict[str, int], int, dict]] = [
            (
                _estimated_template_nutrition_score(
                    plan,
                    goal=str(getattr(req, "goal", None) or "body_recomp"),
                    sex=str(sex) if sex else None,
                ),
                idx,
                plan,
            )
            for idx, plan in enumerate(candidate_plans)
        ]
        scored_candidates.sort(
            key=lambda row: (
                -row[0]["total"],
                -row[0]["quality"],
                -row[0]["micro"],
                -row[0]["adherence"],
                row[1],
            )
        )
        plans_list = [plan for _score, _idx, plan in scored_candidates[:requested_variety_n]]
    else:
        plans_list = candidate_plans

    # The output keeps the FULL target (not the adjusted one) so the
    # client's display of "X cal target" matches the user's actual goal.
    # The routine's macros plus the assembled-meal macros will sum to
    # roughly the full target after the client overlay runs.
    for tpl_out in plans_list:
        tpl_out["targets"] = {
            "calories": t_cal,
            "protein":  t_prot,
            "carbs":    t_carbs,
            "fat":      t_fat,
        }

    for idx, tpl_out in enumerate(plans_list):
        template_warnings = list(nutrition_warnings)
        actual = len(tpl_out.get("meals") or [])
        # Micronutrient coverage audit — count how many of the outgoing
        # meals actually carry non-zero micros, and which fields are
        # populated most/least. If coverage is low, the insight engine
        # on the client has nothing to work with.
        meals_with_micros = 0
        micro_field_fills: dict[str, int] = {}
        low_confidence_meals: list[str] = []
        for m in tpl_out.get("meals") or []:
            micros = m.get("micronutrients") if isinstance(m.get("micronutrients"), dict) else {}
            nonzero = {k: v for k, v in micros.items() if isinstance(v, (int, float)) and v > 0}
            if nonzero:
                meals_with_micros += 1
            for k in nonzero:
                micro_field_fills[k] = micro_field_fills.get(k, 0) + 1
            if m.get("confidence") == "low":
                low_confidence_meals.append(str(m.get("name") or f"Meal {len(low_confidence_meals) + 1}"))
        total_meals = len(tpl_out.get("meals") or [])
        top_fields = sorted(micro_field_fills.items(), key=lambda kv: -kv[1])[:6]
        print(
            f"[meal_assembler] OUT template {idx}: meals={actual} "
            f"(+{routine_count} routine overlay), "
            f"micro coverage={meals_with_micros}/{total_meals} meals, "
            f"top micros={[f'{k}:{v}' for k, v in top_fields]}"
        )
        if actual == 0 and generation_foods:
            template_warnings.append({
                "severity": "error",
                "code": "empty_generated_meals",
                "message": "No generated meals could be assembled from the compatible food list.",
            })
        if meals_with_micros == 0 and total_meals > 0:
            template_warnings.append({
                "severity": "warning",
                "code": "zero_micronutrient_coverage",
                "message": "Generated meals have no micronutrient data; score confidence may be low.",
            })
            print(
                f"[meal_assembler] WARN template {idx} has ZERO micronutrient data — "
                f"check enrichment path + DB seed (extra_nutrients JSON)"
            )
        if low_confidence_meals:
            template_warnings.append({
                "severity": "warning",
                "code": "low_confidence_meals",
                "message": "Some meals relied on stub foods or could not hit macro targets cleanly.",
                "meals": low_confidence_meals[:6],
            })
        tpl_out["nutrition_validation"] = {
            "ok": not any(w.get("severity") == "error" for w in template_warnings),
            "warnings": template_warnings,
            "allowed_foods_count": len(selected_foods),
            "compatible_foods_count": len(generation_foods),
            "meals_actual": actual,
            "micronutrient_meals": meals_with_micros,
            "total_meals": total_meals,
        }

    print(
        f"[meal_assembler] assembled {len(plans_list)} template(s) "
        f"(variety_n={variety_n}, foods={len(food_lookup)}, "
        f"allowed={len(selected_foods)}, routine_count={routine_count})"
    )

    return {
        "nutritionistNote": note,
        "supplementStack": supps,
        "nutrition_plans": plans_list,
    }
