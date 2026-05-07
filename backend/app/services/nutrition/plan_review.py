"""AI nutrition-plan review layer.

Mirrors `app.services.workout.plan_review` but for a single nutrition
template (one daily meal plan). After the assembler + solver produce
meals, this module asks an LLM to sanity-check:

- macro totals vs. the deterministic target (are the meals actually
  going to hit the daily goal?)
- per-item realism (a "50 cal ribeye 8oz" is wrong — the item should
  be ~550 cal; surface these via adjust_item_macros so the numbers
  the user sees aren't absurd)
- variety / allergen conflicts (food list respects `allowed_foods`,
  no repeated protein across every meal)
- per-meal totals consistent with their items (meal.calories should
  match sum(items.calories))

The reviewer proposes a short list of surgical patches. Patch actions:

    adjust_meal_macros   — rewrite one meal's top-level macros
    adjust_item_macros   — rewrite one item's per-serving macros
    swap_food            — replace an item's name (keeps macros)
    remove_item          — drop one item from a meal

Anything outside this vocabulary is ignored. Callers run this BEFORE
the deterministic macro normalizer so any fixes propagate through the
final scale-to-target pass.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

logger = logging.getLogger(__name__)


ReviewStatus = Literal["ok", "modify"]

PatchAction = Literal[
    "adjust_meal_macros",
    "adjust_item_macros",
    "adjust_item_micros",   # NEW — rewrites per-item micronutrients (fiber, sodium, etc.)
    "swap_food",
    "remove_item",
]


# Canonical micronutrient field names the reviewer can patch. Must
# match the backend's `MICRONUTRIENT_FIELDS` (snake_case) so patches
# land on the same keys the rest of the pipeline uses.
MICRO_FIELDS_PATCHABLE: tuple[str, ...] = (
    "fiber", "sugar", "sodium", "cholesterol",
    "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
    "omega_3", "omega_6",
    "potassium", "calcium", "iron", "magnesium",
    "vitamin_c", "vitamin_d", "vitamin_b12",
)


@dataclass
class NutritionPatch:
    action: PatchAction
    meal_index: int
    item_index: Optional[int] = None
    new_name: Optional[str] = None
    new_calories: Optional[int] = None
    new_protein: Optional[int] = None
    new_carbs: Optional[int] = None
    new_fat: Optional[int] = None
    # Micronutrient patch payload — dict of canonical field name → value.
    # Only keys present are written; unknown keys are ignored. Populated
    # only for `adjust_item_micros`.
    new_micros: dict[str, float] = field(default_factory=dict)
    reason: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> Optional["NutritionPatch"]:
        if not isinstance(raw, dict):
            return None
        action = raw.get("action")
        if action not in (
            "adjust_meal_macros", "adjust_item_macros", "adjust_item_micros",
            "swap_food", "remove_item",
        ):
            return None
        try:
            meal_index = int(raw.get("meal_index"))
        except (TypeError, ValueError):
            return None
        item_idx_raw = raw.get("item_index")
        item_index: Optional[int] = None
        if item_idx_raw is not None:
            try:
                item_index = int(item_idx_raw)
            except (TypeError, ValueError):
                item_index = None
        # Parse the micros sub-dict if present. Accept both snake_case
        # (canonical) and camelCase keys, normalizing to canonical.
        raw_micros = raw.get("new_micros") or {}
        micros_clean: dict[str, float] = {}
        if isinstance(raw_micros, dict):
            key_map = {
                "saturatedFat": "saturated_fat",
                "monounsaturatedFat": "monounsaturated_fat",
                "polyunsaturatedFat": "polyunsaturated_fat",
                "omega3": "omega_3",
                "omega6": "omega_6",
                "vitaminC": "vitamin_c",
                "vitaminD": "vitamin_d",
                "vitaminB12": "vitamin_b12",
            }
            for k, v in raw_micros.items():
                canonical = key_map.get(k, k)
                if canonical not in MICRO_FIELDS_PATCHABLE:
                    continue
                try:
                    micros_clean[canonical] = float(v)
                except (TypeError, ValueError):
                    continue
        return cls(
            action=action,
            meal_index=meal_index,
            item_index=item_index,
            new_name=raw.get("new_name"),
            new_calories=_maybe_int(raw.get("new_calories")),
            new_protein=_maybe_int(raw.get("new_protein")),
            new_carbs=_maybe_int(raw.get("new_carbs")),
            new_fat=_maybe_int(raw.get("new_fat")),
            new_micros=micros_clean,
            reason=str(raw.get("reason") or ""),
        )


@dataclass
class NutritionReview:
    status: ReviewStatus
    notes: str
    patches: list[NutritionPatch] = field(default_factory=list)
    error: Optional[str] = None


def _maybe_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


# ── Brief builder ────────────────────────────────────────────────────


BRIEF_MAX_ITEMS_PER_MEAL = 8


def _iter_meals(nutrition_plan: dict) -> list[dict]:
    meals = nutrition_plan.get("meals")
    if isinstance(meals, list):
        return [m for m in meals if isinstance(m, dict)]
    out: list[dict] = []
    for k in ("breakfast", "lunch", "dinner", "snack"):
        m = nutrition_plan.get(k)
        if isinstance(m, dict):
            out.append(m)
    return out


def build_nutrition_brief(
    nutrition_plan: dict,
    *,
    goal: str,
    target_calories: int,
    target_protein: int,
    target_carbs: int,
    target_fat: int,
    allowed_foods: list[str] | None = None,
    allergens: list[str] | None = None,
    diet_preference: Optional[str] = None,
    nutrition_context: Optional[str] = None,
) -> dict:
    """Compact brief the reviewer reads. One template at a time."""
    meals_brief: list[dict] = []
    for mi, m in enumerate(_iter_meals(nutrition_plan)):
        items_in = m.get("items") or []
        items_brief: list[dict] = []
        if isinstance(items_in, list):
            for ii, it in enumerate(items_in[:BRIEF_MAX_ITEMS_PER_MEAL]):
                if not isinstance(it, dict):
                    continue
                # Surface the item's micronutrients (when present)
                # so the reviewer can audit them. Pull from either the
                # item-level keys or a nested `micronutrients` dict.
                item_micros: dict[str, Any] = {}
                raw_micros = it.get("micronutrients") if isinstance(it.get("micronutrients"), dict) else {}
                for mk in MICRO_FIELDS_PATCHABLE:
                    v = it.get(mk)
                    if v is None and isinstance(raw_micros, dict):
                        v = raw_micros.get(mk)
                    if v is not None:
                        try:
                            item_micros[mk] = round(float(v), 2)
                        except (TypeError, ValueError):
                            continue
                items_brief.append({
                    "index": ii,
                    "name": it.get("name"),
                    "qty": it.get("qty") or it.get("quantity"),
                    "unit": it.get("unit"),
                    "calories": _maybe_int(it.get("calories")),
                    "protein":  _maybe_int(it.get("protein")),
                    "carbs":    _maybe_int(it.get("carbs")),
                    "fat":      _maybe_int(it.get("fat")),
                    "micros":   item_micros,
                })
        meals_brief.append({
            "index": mi,
            "name": m.get("name") or m.get("label") or f"meal_{mi}",
            "calories": _maybe_int(m.get("calories")),
            "protein":  _maybe_int(m.get("protein")),
            "carbs":    _maybe_int(m.get("carbs")),
            "fat":      _maybe_int(m.get("fat")),
            "items": items_brief,
        })

    brief: dict = {
        "goal": goal,
        "diet_preference": diet_preference,
        "targets": {
            "calories": int(target_calories),
            "protein":  int(target_protein),
            "carbs":    int(target_carbs),
            "fat":      int(target_fat),
        },
        "allowed_foods": list(allowed_foods or []),
        "allergens": list(allergens or []),
        "meals": meals_brief,
    }
    if nutrition_context:
        brief["user_context"] = nutrition_context
    return brief


# ── AI reviewer ──────────────────────────────────────────────────────


_SYSTEM_PROMPT = """You are a registered-dietitian reviewer auditing a single daily meal plan. \
You do NOT rewrite the plan. You only flag issues and propose small, surgical patches.

You will receive a compact JSON brief with:
- `goal`: the user's primary nutrition goal (fat_loss, muscle_gain, maintenance, recomp, etc.)
- `diet_preference`: optional (vegan, vegetarian, keto, etc.) — respect it absolutely
- `targets`: the deterministic daily macro target (calories/protein/carbs/fat). The meals \
  will be proportionally scaled AFTER your review to hit this target exactly, so do NOT \
  patch macros just because the total is slightly off — focus on per-item realism.
- `allowed_foods`: foods the user said they want to eat. Everything in the plan SHOULD \
  come from this list (the assembler tries hard to honor it). Minor deviations are okay.
- `allergens`: hard-blocked foods. Any item containing an allergen is a MUST-patch.
- `meals`: every meal with top-level macros + an `items[]` list. Each item has a name, \
  qty/unit, and per-serving macros.

Look for:
- **Per-item macros that are numerically implausible.** This is the #1 reason you exist. \
  Examples: "ribeye 8 oz: 50 cal" (should be ~550 cal), "1 cup rice: 800 cal" (should \
  be ~200), "1 egg: 200 cal" (should be ~70). Use real-world nutrition knowledge to \
  spot impossible values and emit an `adjust_item_macros` patch with corrected numbers.
- **Missing or clearly-wrong micronutrients.** Every item has a `micros` dict. If a \
  food that's known to be high in a nutrient shows zero or an absurdly low number, \
  emit an `adjust_item_micros` patch with the corrected value. Red flags: \
  salmon with `omega_3: 0`, spinach with `iron: 0`, milk with `calcium: 0`, \
  eggs with `vitamin_d: 0` or `vitamin_b12: 0`, black beans with `fiber: 0`. \
  Also flag impossibly-high values (e.g. `sodium: 9000 mg` for plain chicken). \
  Use USDA values for the corrected numbers, scaled to the item's qty/unit. \
  Micro units: grams for fiber/sugar/saturated_fat/mono/poly fat/omega_3/omega_6, \
  milligrams for sodium/cholesterol/potassium/calcium/iron/magnesium/vitamin_c, \
  micrograms for vitamin_d and vitamin_b12.
- **Meal totals that don't match their items.** If a meal claims 600 cal but its items \
  sum to 300, patch the meal-level totals via `adjust_meal_macros` to match the items.
- **Allergen violations.** Patch via `remove_item` or `swap_food` to a safe alternative.
- **Diet-preference violations.** Vegan plan with chicken? Patch via `swap_food`.
- **Catastrophic variety failures.** Same protein in every meal when allowed_foods has \
  variety? One `swap_food` patch on the worst offender, not a wholesale rewrite.

Do NOT patch:
- Small macro deltas (±10%) — normalization will fix these.
- Food choices that differ from allowed_foods when they're reasonable substitutes.
- Rep-style complaints in prose form without a patch. If you identify an issue, you \
  MUST emit a patch for it.

CRITICAL RULES for `status`:
- If you emit ANY patch → status MUST be "modify".
- If the plan has no real issues → status="ok" with empty patches and a one-line notes.
- It is INVALID to return status="ok" while describing problems in notes. When in doubt, \
  pick modify and emit one conservative patch.

Patch actions and their fields:
- adjust_meal_macros: meal_index, new_calories?, new_protein?, new_carbs?, new_fat?, reason
- adjust_item_macros: meal_index, item_index, new_calories?, new_protein?, new_carbs?, new_fat?, reason
- adjust_item_micros: meal_index, item_index, new_micros (dict of snake_case nutrient names → values), reason
- swap_food: meal_index, item_index, new_name, reason
- remove_item: meal_index, item_index, reason

Valid new_micros keys (snake_case only): fiber, sugar, sodium, cholesterol, saturated_fat, monounsaturated_fat, polyunsaturated_fat, omega_3, omega_6, potassium, calcium, iron, magnesium, vitamin_c, vitamin_d, vitamin_b12

Return ONLY valid JSON:
{"status": "ok" | "modify", "notes": "one-paragraph summary", "patches": [...]}

Be conservative. Prefer 0-3 patches over a wholesale rewrite. Every patch needs a \
one-sentence reason. Patches outside the five actions above are ignored.
"""


_REVIEW_JSON_SCHEMA = {
    "name": "nutrition_plan_review",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["status", "notes", "patches"],
        "properties": {
            "status": {"type": "string", "enum": ["ok", "modify"]},
            "notes":  {"type": "string"},
            "patches": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": True,
                    "required": ["action", "meal_index", "reason"],
                    "properties": {
                        "action":       {"type": "string"},
                        "meal_index":   {"type": "integer"},
                        "item_index":   {"type": ["integer", "null"]},
                        "new_name":     {"type": ["string", "null"]},
                        "new_calories": {"type": ["integer", "null"]},
                        "new_protein":  {"type": ["integer", "null"]},
                        "new_carbs":    {"type": ["integer", "null"]},
                        "new_fat":      {"type": ["integer", "null"]},
                        "new_micros":   {"type": ["object", "null"]},
                        "reason":       {"type": "string"},
                    },
                },
            },
        },
    },
}


def review_nutrition_plan(brief: dict) -> NutritionReview:
    """One AI call to review a meal-plan brief. Returns a NutritionReview.

    On any exception returns a status="ok" review with `error` set so a
    reviewer outage never blocks plan generation.
    """
    try:
        from openai import OpenAI
        from ...routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_plan_update,
        )
    except Exception as exc:
        return NutritionReview(status="ok", notes="reviewer unavailable", error=f"import: {exc}")

    try:
        api_key = get_openai_api_key()
    except Exception as exc:
        return NutritionReview(status="ok", notes="reviewer unavailable", error=f"api key: {exc}")
    if not api_key:
        return NutritionReview(status="ok", notes="reviewer unavailable", error="no api key")

    try:
        client = OpenAI(api_key=api_key)
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Review this nutrition plan brief and decide whether it needs fixes.\n\n"
                    + json.dumps(brief, indent=2)
                ),
            },
        ]
        kwargs = _build_chat_kwargs(
            model_plan_update(),
            messages,
            json_schema=_REVIEW_JSON_SCHEMA,
            max_tokens=1200,
            timeout_secs=35,
        )
        response = _chat_create(client, **kwargs)
        raw = response.choices[0].message.content or ""
        parsed = _extract_json(raw)
    except Exception as exc:
        logger.warning("[nutrition_plan_review] AI call failed error_type=%s", type(exc).__name__)
        return NutritionReview(status="ok", notes="review call failed", error=str(exc))

    status = parsed.get("status")
    if status not in ("ok", "modify"):
        return NutritionReview(status="ok", notes=str(parsed.get("notes") or ""), error=f"bad status: {status}")
    notes = str(parsed.get("notes") or "")
    raw_patches = parsed.get("patches") or []
    patches: list[NutritionPatch] = []
    if isinstance(raw_patches, list):
        for rp in raw_patches:
            p = NutritionPatch.from_dict(rp)
            if p is not None:
                patches.append(p)
    if status == "modify" and not patches:
        status = "ok"
    return NutritionReview(status=status, notes=notes, patches=patches)


# ── Patch application ───────────────────────────────────────────────


def apply_nutrition_patches(
    nutrition_plan: dict, patches: list[NutritionPatch]
) -> tuple[dict, list[str]]:
    """Mutate a single nutrition template in place. Returns (plan, messages).

    Out-of-range indices are skipped (logged) so a buggy AI can't corrupt
    the plan. After patches land, the caller should re-sum meal totals if
    they applied item-level changes — we do a minimal best-effort re-sum
    here as a courtesy so the subsequent normalizer starts from a
    consistent state.
    """
    applied: list[str] = []
    meals = _iter_meals(nutrition_plan)
    if not meals:
        return nutrition_plan, ["no meals in nutrition plan"]

    touched_meal_idxs: set[int] = set()
    for p in patches:
        msg = _apply_one(meals, p)
        applied.append(msg)
        if p.action in ("adjust_item_macros", "remove_item"):
            touched_meal_idxs.add(p.meal_index)

    for mi in touched_meal_idxs:
        if 0 <= mi < len(meals):
            _resum_meal_totals(meals[mi])

    return nutrition_plan, applied


def _apply_one(meals: list[dict], p: NutritionPatch) -> str:
    if not (0 <= p.meal_index < len(meals)):
        return f"skip {p.action}: meal_index {p.meal_index} out of range"
    meal = meals[p.meal_index]

    if p.action == "adjust_meal_macros":
        changed = []
        if p.new_calories is not None:
            changed.append(f"cal {meal.get('calories')}→{p.new_calories}")
            meal["calories"] = p.new_calories
        if p.new_protein is not None:
            changed.append(f"p {meal.get('protein')}→{p.new_protein}")
            meal["protein"] = p.new_protein
        if p.new_carbs is not None:
            changed.append(f"c {meal.get('carbs')}→{p.new_carbs}")
            meal["carbs"] = p.new_carbs
        if p.new_fat is not None:
            changed.append(f"f {meal.get('fat')}→{p.new_fat}")
            meal["fat"] = p.new_fat
        if not changed:
            return "skip adjust_meal_macros: no macro fields provided"
        meal["_review_patched"] = True
        return f"adjust_meal meal={p.meal_index} " + ", ".join(changed) + f" ({p.reason})"

    items = meal.get("items")
    if not isinstance(items, list):
        return f"skip {p.action}: meal {p.meal_index} has no items[]"

    if p.action == "adjust_item_macros":
        if p.item_index is None or not (0 <= p.item_index < len(items)):
            return f"skip adjust_item_macros: bad item_index {p.item_index}"
        it = items[p.item_index]
        if not isinstance(it, dict):
            return f"skip adjust_item_macros: item {p.item_index} not a dict"
        changed = []
        if p.new_calories is not None:
            changed.append(f"cal {it.get('calories')}→{p.new_calories}")
            it["calories"] = p.new_calories
        if p.new_protein is not None:
            changed.append(f"p {it.get('protein')}→{p.new_protein}")
            it["protein"] = p.new_protein
        if p.new_carbs is not None:
            changed.append(f"c {it.get('carbs')}→{p.new_carbs}")
            it["carbs"] = p.new_carbs
        if p.new_fat is not None:
            changed.append(f"f {it.get('fat')}→{p.new_fat}")
            it["fat"] = p.new_fat
        if not changed:
            return "skip adjust_item_macros: no macro fields provided"
        it["_review_patched"] = True
        return (
            f"adjust_item meal={p.meal_index} item={p.item_index} "
            f"{it.get('name')!r} " + ", ".join(changed) + f" ({p.reason})"
        )

    if p.action == "adjust_item_micros":
        if p.item_index is None or not (0 <= p.item_index < len(items)):
            return f"skip adjust_item_micros: bad item_index {p.item_index}"
        it = items[p.item_index]
        if not isinstance(it, dict):
            return f"skip adjust_item_micros: item {p.item_index} not a dict"
        if not p.new_micros:
            return "skip adjust_item_micros: no micros provided"
        # Write to both the top-level keys (where fiber/sugar/sodium
        # traditionally live) AND the nested `micronutrients` dict (where
        # the full panel lives). Items from the assembler carry both
        # paths, so writing to both keeps readers consistent.
        nested = it.get("micronutrients")
        if not isinstance(nested, dict):
            nested = {}
            it["micronutrients"] = nested
        changed: list[str] = []
        for key, val in p.new_micros.items():
            if key not in MICRO_FIELDS_PATCHABLE:
                continue
            old = it.get(key)
            if old is None:
                old = nested.get(key)
            it[key] = val
            nested[key] = val
            changed.append(f"{key} {old}→{val}")
        if not changed:
            return "skip adjust_item_micros: no valid fields"
        it["_review_patched"] = True
        return (
            f"adjust_micros meal={p.meal_index} item={p.item_index} "
            f"{it.get('name')!r} " + ", ".join(changed) + f" ({p.reason})"
        )

    if p.action == "swap_food":
        if p.item_index is None or not (0 <= p.item_index < len(items)):
            return f"skip swap_food: bad item_index {p.item_index}"
        if not p.new_name:
            return "skip swap_food: no new_name provided"
        it = items[p.item_index]
        if not isinstance(it, dict):
            return f"skip swap_food: item {p.item_index} not a dict"
        old = it.get("name")
        it["name"] = p.new_name
        it["_review_patched"] = True
        # Also update the legacy parallel `foods[]` list if present so
        # older clients that still read it stay consistent.
        foods_list = meal.get("foods")
        if isinstance(foods_list, list) and p.item_index < len(foods_list):
            foods_list[p.item_index] = p.new_name
        return f"swap_food meal={p.meal_index} item={p.item_index} {old!r}→{p.new_name!r} ({p.reason})"

    if p.action == "remove_item":
        if p.item_index is None or not (0 <= p.item_index < len(items)):
            return f"skip remove_item: bad item_index {p.item_index}"
        removed = items.pop(p.item_index)
        foods_list = meal.get("foods")
        if isinstance(foods_list, list) and p.item_index < len(foods_list):
            foods_list.pop(p.item_index)
        name = removed.get("name") if isinstance(removed, dict) else str(removed)
        return f"remove_item meal={p.meal_index} item={p.item_index} {name!r} ({p.reason})"

    return f"skip unknown action {p.action}"


def _resum_meal_totals(meal: dict) -> None:
    """Re-sum meal-level cal/protein/carbs/fat from items[] after edits.
    Only runs on meals the reviewer touched, so unreviewed meals keep
    whatever totals the assembler computed."""
    items = meal.get("items")
    if not isinstance(items, list) or not items:
        return
    cal = prot = carbs = fat = 0.0
    for it in items:
        if not isinstance(it, dict):
            continue
        cal   += float(it.get("calories") or 0)
        prot  += float(it.get("protein")  or 0)
        carbs += float(it.get("carbs")    or 0)
        fat   += float(it.get("fat")      or 0)
    meal["calories"] = int(round(cal))
    meal["protein"]  = int(round(prot))
    meal["carbs"]    = int(round(carbs))
    meal["fat"]      = int(round(fat))
