"""
USDA FoodData Central API client.

Primary source for food nutrition data. Falls back to AI only when
USDA returns no results. Free API — requires an API key from
https://fdc.nal.usda.gov/api-key-signup

Set USDA_FDC_API_KEY in .env or environment.
"""
from __future__ import annotations

import os
import re
import copy
import time
import httpx
from typing import Any

_BASE = "https://api.nal.usda.gov/fdc/v1"
_TIMEOUT = 8.0


def _api_key() -> str | None:
    return os.getenv("USDA_FDC_API_KEY")


# Nutrient ID → our field name mapping (USDA nutrient numbers)
_NUTRIENT_MAP: dict[int, str] = {
    1008: "calories",      # Energy (kcal)
    1003: "protein",       # Protein
    1005: "carbs",         # Carbohydrate, by difference
    1004: "fat",           # Total lipid (fat)
    1079: "fiber",         # Fiber, total dietary
    2000: "sugar",         # Sugars, total
    1235: "added_sugar_g", # Added Sugars (FDA-required label field)
    1093: "sodium_mg",     # Sodium, Na
    1087: "calcium_mg",    # Calcium, Ca
    1089: "iron_mg",       # Iron, Fe
    1090: "magnesium_mg",  # Magnesium, Mg
    1092: "potassium_mg",  # Potassium, K
    1114: "vitamin_d_mcg", # Vitamin D
    1178: "vitamin_b12_mcg",  # Vitamin B-12
    1162: "vitamin_c_mg",  # Vitamin C
    1109: "vitamin_e_mg",  # Vitamin E
    1106: "vitamin_a_mcg", # Vitamin A, RAE
    1258: "saturated_fat", # Fatty acids, total saturated
    1292: "monounsaturated_fat", # Fatty acids, total monounsaturated
    1293: "polyunsaturated_fat", # Fatty acids, total polyunsaturated
    1253: "cholesterol_mg",  # Cholesterol
    1051: "water_g",       # Water
}

_OMEGA3_NUTRIENT_IDS = {
    851,  # PUFA 18:3 n-3 c,c,c (ALA)
    629,  # PUFA 20:5 n-3 (EPA)
    631,  # PUFA 22:5 n-3 (DPA)
    621,  # PUFA 22:6 n-3 (DHA)
}
_OMEGA6_NUTRIENT_IDS = {
    618,  # PUFA 18:2 n-6 c,c (linoleic acid)
}


def _extract_nutrients(food: dict) -> dict[str, float]:
    """Pull nutrient values from a USDA food object."""
    out: dict[str, float] = {}
    for nutrient in food.get("foodNutrients", []):
        nid = nutrient.get("nutrientId") or (nutrient.get("nutrient", {}).get("id"))
        val = nutrient.get("value") or nutrient.get("amount", 0)
        if not isinstance(val, (int, float)) or val <= 0:
            continue
        if nid and nid in _NUTRIENT_MAP:
            out[_NUTRIENT_MAP[nid]] = round(val, 2)
        if nid in _OMEGA3_NUTRIENT_IDS:
            out["omega_3"] = round(out.get("omega_3", 0) + val, 2)
        if nid in _OMEGA6_NUTRIENT_IDS:
            out["omega_6"] = round(out.get("omega_6", 0) + val, 2)
    return out


_SEARCH_CACHE: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}


def _search_cache_ttl_secs() -> int:
    try:
        return max(0, int(os.getenv("USDA_FDC_SEARCH_CACHE_TTL_SECS", "86400")))
    except ValueError:
        return 86400


def _search_cache_key(query: str, max_results: int) -> tuple[str, int]:
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    return normalized, max_results


def _get_cached_search(key: tuple[str, int]) -> list[dict[str, Any]] | None:
    cached = _SEARCH_CACHE.get(key)
    if not cached:
        return None
    expires_at, results = cached
    if expires_at <= time.time():
        _SEARCH_CACHE.pop(key, None)
        return None
    return copy.deepcopy(results)


def _store_cached_search(key: tuple[str, int], results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ttl = _search_cache_ttl_secs()
    if ttl > 0:
        _SEARCH_CACHE[key] = (time.time() + ttl, copy.deepcopy(results))
        # This is an in-process cache for typeahead/search repeats, not a
        # datastore. Keep it bounded even if users search a lot of prefixes.
        if len(_SEARCH_CACHE) > 512:
            for old_key in list(_SEARCH_CACHE.keys())[:128]:
                _SEARCH_CACHE.pop(old_key, None)
    return copy.deepcopy(results)


_HOUSEHOLD_UNIT_GRAMS: dict[str, float] = {
    "tbsp": 15.0,
    "tablespoon": 15.0,
    "tablespoons": 15.0,
    "tsp": 5.0,
    "teaspoon": 5.0,
    "teaspoons": 5.0,
    "cup": 240.0,
    "cups": 240.0,
    "oz": 28.0,
    "ounce": 28.0,
    "ounces": 28.0,
    "slice": 30.0,
    "slices": 30.0,
    "piece": 30.0,
    "pieces": 30.0,
    "fl oz": 30.0,
    "each": 50.0,
    "link": 45.0,
    "links": 45.0,
    "patty": 85.0,
    "strip": 10.0,
    "strips": 10.0,
}


def _parse_household_grams(text: str) -> float | None:
    """Estimate grams from household serving text like '1 cup' or '2 tbsp'.

    Returns estimated grams, or None if parsing fails.
    """
    if not text:
        return None
    text = text.strip().lower()
    # Try to match patterns like "1 cup", "2.5 tbsp", "1/2 cup"
    m = re.match(r"^(\d+(?:\.\d+)?(?:\s*/\s*\d+)?)\s+(.+)$", text)
    if not m:
        # Try without a leading number (assume 1)
        unit = text.strip()
        if unit in _HOUSEHOLD_UNIT_GRAMS:
            return _HOUSEHOLD_UNIT_GRAMS[unit]
        return None
    qty_str, unit = m.group(1).strip(), m.group(2).strip()
    # Handle fractions like "1/2"
    if "/" in qty_str:
        parts = qty_str.split("/")
        try:
            qty = float(parts[0]) / float(parts[1])
        except (ValueError, ZeroDivisionError):
            return None
    else:
        try:
            qty = float(qty_str)
        except ValueError:
            return None
    # Strip trailing description words: "1 cup chopped" → "cup"
    unit_first = unit.split()[0] if unit else ""
    grams_per = _HOUSEHOLD_UNIT_GRAMS.get(unit) or _HOUSEHOLD_UNIT_GRAMS.get(unit_first)
    if grams_per:
        return round(qty * grams_per, 1)
    return None


def _extract_serving(food: dict) -> tuple[str, float]:
    """Best-effort serving description + gram weight from USDA data.

    Returns (serving_label, grams_per_serving). Prefers household
    servings ("1 cup") over raw gram weights ("100 g") since users
    cook with cups/tbsp, not grams.
    """
    ss = food.get("servingSize")  # grams per serving
    hs = food.get("householdServingFullText")  # "1 cup", "2 tbsp"

    if hs and ss and ss > 0:
        return hs, ss
    if hs:
        # Try to estimate grams from household text instead of defaulting to 100g
        estimated = _parse_household_grams(hs)
        return hs, ss or estimated or 100.0
    if ss and ss > 0:
        ssu = food.get("servingSizeUnit", "g")
        return f"{round(ss)} {ssu}", ss
    return "100 g", 100.0


def search_foods(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """
    Search USDA FoodData Central for foods matching query.
    Returns list of dicts with: name, serving, calories, protein, carbs, fat,
    plus micronutrients when available.
    """
    key = _api_key()
    if not key:
        return []

    cache_key = _search_cache_key(query, max_results)
    cached = _get_cached_search(cache_key)
    if cached is not None:
        return cached

    try:
        resp = httpx.post(
            f"{_BASE}/foods/search",
            params={"api_key": key},
            json={
                "query": query,
                "pageSize": max_results * 4,
                "dataType": ["Foundation", "SR Legacy", "Survey (FNDDS)", "Branded"],
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[usda-fdc] search failed: {e}")
        return []

    results: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for food in data.get("foods", []):
        name = food.get("description", "").strip()
        if not name:
            continue
        norm = name.lower()
        if norm in seen_names:
            continue
        seen_names.add(norm)

        nutrients_per100g = _extract_nutrients(food)
        cal_per100g = nutrients_per100g.get("calories", 0)
        if cal_per100g <= 0:
            continue

        serving_label, serving_grams = _extract_serving(food)

        # Scale nutrients from per-100g to per-serving
        scale = serving_grams / 100.0 if serving_grams > 0 else 1.0
        nutrients = {k: round(v * scale, 1) for k, v in nutrients_per100g.items()}

        entry: dict[str, Any] = {
            "name": _clean_name(name),
            "serving": serving_label,
            "calories": round(nutrients.get("calories", 0)),
            "protein": round(nutrients.get("protein", 0)),
            "carbs": round(nutrients.get("carbs", 0)),
            "fat": round(nutrients.get("fat", 0)),
            "fdc_id": str(food.get("fdcId") or ""),
            "external_id": str(food.get("fdcId") or ""),
            "serving_grams": serving_grams,
            "brand": food.get("brandOwner") or food.get("brandName"),
            "source": "usda",
        }

        # Remap USDA internal keys to canonical names the meal assembler
        # and NutritionCard expect (no _mg / _mcg suffixes on micro fields).
        _USDA_KEY_MAP = {
            "fiber": "fiber",
            "sugar": "sugar",
            "added_sugar_g": "added_sugar",
            "sodium_mg": "sodium",
            "calcium_mg": "calcium",
            "iron_mg": "iron",
            "magnesium_mg": "magnesium",
            "potassium_mg": "potassium",
            "vitamin_d_mcg": "vitamin_d",
            "vitamin_b12_mcg": "vitamin_b12",
            "vitamin_c_mg": "vitamin_c",
            "vitamin_e_mg": "vitamin_e",
            "vitamin_a_mcg": "vitamin_a",
            "saturated_fat": "saturated_fat",
            "monounsaturated_fat": "monounsaturated_fat",
            "polyunsaturated_fat": "polyunsaturated_fat",
            "omega_3": "omega_3",
            "omega_6": "omega_6",
            "cholesterol_mg": "cholesterol",
        }
        micros = {}
        for usda_key, canonical_key in _USDA_KEY_MAP.items():
            if usda_key in nutrients:
                micros[canonical_key] = nutrients[usda_key]
        if micros:
            entry["micronutrients"] = micros

        results.append((food, entry))

    # Rerank: prefer whole foods over branded, and foods where query
    # words appear at start of the name.
    q_words = set(query.lower().split())
    def _relevance(item: tuple) -> tuple:
        food_obj, ent = item
        raw = food_obj.get("description", "").lower()
        clean = ent["name"].lower()
        starts = any(raw.startswith(w) or clean.startswith(w) for w in q_words)
        word_hits = sum(1 for w in q_words if w in raw)
        # Prefer Foundation > SR Legacy > Survey > Branded
        dt = food_obj.get("dataType", "")
        dt_rank = 0 if dt == "Foundation" else (1 if "Legacy" in dt else (2 if "Survey" in dt else 3))
        # Penalize items with absurd calorie values (likely bad data)
        cal = ent.get("calories", 0)
        cal_penalty = 1 if cal > 800 else 0
        return (cal_penalty, 0 if starts else 1, -word_hits, dt_rank)

    results.sort(key=_relevance)
    return _store_cached_search(cache_key, [entry for _, entry in results[:max_results]])


def get_food_by_fdc_id(fdc_id: int | str) -> dict[str, Any] | None:
    """Fetch a specific food by its FDC ID."""
    key = _api_key()
    if not key:
        return None
    try:
        resp = httpx.get(
            f"{_BASE}/food/{fdc_id}",
            params={"api_key": key},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        food = resp.json()
    except Exception:
        return None

    nutrients = _extract_nutrients(food)
    if not nutrients.get("calories"):
        return None

    serving_label, serving_grams = _extract_serving(food)
    return {
        "name": _clean_name(food.get("description", "")),
        "serving": serving_label,
        "serving_grams": serving_grams,
        "fdc_id": str(fdc_id),
        **nutrients,
    }


_NOISE_WORDS = re.compile(
    r'\b(broiler|fryers|or fryers|meat only|skinless|boneless|'
    r'unprepared|prepared|unenriched|enriched|glutinous|dehydrated|'
    r'NFS|ns as to|not further specified|commercial|industrial|'
    r'all purpose|as purchased)\b',
    re.IGNORECASE,
)

def _clean_name(s: str) -> str:
    """'Milk, whole, 3.25% milkfat, with added vitamin D' → 'Whole Milk'"""
    s = s.title() if s == s.upper() else s
    s = re.sub(r'\s*\(.*?\)', '', s)
    s = re.sub(r',?\s*with added.*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r',?\s*\d+(\.\d+)?%\s*\w+', '', s)
    parts = [p.strip() for p in s.split(',')]
    parts = [_NOISE_WORDS.sub('', p).strip() for p in parts]
    parts = [p for p in parts if p and len(p) > 1]
    if len(parts) >= 2:
        main = parts[0]
        quals = [p for p in parts[1:] if p.lower() != main.lower()]
        s = f"{main}, {' '.join(quals)}".strip().rstrip(',')
    else:
        s = parts[0] if parts else s
    s = re.sub(r'\s+', ' ', s).strip()
    if len(s) > 50:
        s = s[:50].rsplit(' ', 1)[0]
    return s
