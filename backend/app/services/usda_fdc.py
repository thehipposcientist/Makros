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
    1292: "omega_3_mg",    # Fatty acids, total omega-3 (approximation)
    1253: "cholesterol_mg",  # Cholesterol
    1051: "water_g",       # Water
}


def _extract_nutrients(food: dict) -> dict[str, float]:
    """Pull nutrient values from a USDA food object."""
    out: dict[str, float] = {}
    for nutrient in food.get("foodNutrients", []):
        nid = nutrient.get("nutrientId") or (nutrient.get("nutrient", {}).get("id"))
        if nid and nid in _NUTRIENT_MAP:
            val = nutrient.get("value") or nutrient.get("amount", 0)
            if isinstance(val, (int, float)) and val > 0:
                out[_NUTRIENT_MAP[nid]] = round(val, 2)
    return out


def _extract_serving(food: dict) -> str:
    """Best-effort serving description from USDA data."""
    # servingSize + servingSizeUnit (e.g., 244.0 + "g")
    ss = food.get("servingSize")
    ssu = food.get("servingSizeUnit", "g")
    if ss:
        return f"{round(ss)} {ssu}"
    # householdServingFullText (e.g., "1 cup")
    hs = food.get("householdServingFullText")
    if hs:
        return hs
    return "100 g"


def search_foods(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """
    Search USDA FoodData Central for foods matching query.
    Returns list of dicts with: name, serving, calories, protein, carbs, fat,
    plus micronutrients when available.
    """
    key = _api_key()
    if not key:
        return []

    try:
        resp = httpx.post(
            f"{_BASE}/foods/search",
            params={"api_key": key},
            json={
                "query": query,
                "pageSize": max_results * 4,
                "dataType": ["Foundation", "SR Legacy", "Survey (FNDDS)"],
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

        nutrients = _extract_nutrients(food)
        cal = nutrients.get("calories", 0)
        if cal <= 0:
            continue

        serving = _extract_serving(food)

        entry: dict[str, Any] = {
            "name": _clean_name(name),
            "serving": serving,
            "calories": round(nutrients.get("calories", 0)),
            "protein": round(nutrients.get("protein", 0)),
            "carbs": round(nutrients.get("carbs", 0)),
            "fat": round(nutrients.get("fat", 0)),
            "source": "usda",
        }

        micros = {}
        for nid_key in ("fiber", "sugar", "sodium_mg", "calcium_mg", "iron_mg",
                         "magnesium_mg", "potassium_mg", "vitamin_d_mcg",
                         "vitamin_b12_mcg", "vitamin_c_mg", "vitamin_e_mg",
                         "vitamin_a_mcg", "saturated_fat", "cholesterol_mg"):
            if nid_key in nutrients:
                micros[nid_key] = nutrients[nid_key]
        if micros:
            entry["micronutrients"] = micros

        results.append((food, entry))

    # Rerank: prefer foods where query words appear at start of name
    q_words = set(query.lower().split())
    def _relevance(item: tuple) -> tuple:
        food_obj, ent = item
        raw = food_obj.get("description", "").lower()
        clean = ent["name"].lower()
        # Score: starts with query word → 0, contains → 1, else → 2
        starts = any(raw.startswith(w) or clean.startswith(w) for w in q_words)
        word_hits = sum(1 for w in q_words if w in raw)
        # Prefer Foundation > SR Legacy > Survey
        dt = food_obj.get("dataType", "")
        dt_rank = 0 if dt == "Foundation" else (1 if "Legacy" in dt else 2)
        return (0 if starts else 1, -word_hits, dt_rank)

    results.sort(key=_relevance)
    return [entry for _, entry in results[:max_results]]


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

    return {
        "name": _clean_name(food.get("description", "")),
        "serving": _extract_serving(food),
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
