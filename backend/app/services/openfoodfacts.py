"""OpenFoodFacts barcode lookup for packaged food products.

Complements USDA (which has whole foods but few branded products).
Free API, no key needed. Returns nutrition per 100g or per serving.
"""
from __future__ import annotations

import httpx
from typing import Any

_BASE = "https://world.openfoodfacts.org/api/v2"
_TIMEOUT = 8.0


def lookup_barcode(barcode: str) -> dict[str, Any] | None:
    """Look up a food product by barcode. Returns structured nutrition or None."""
    try:
        resp = httpx.get(
            f"{_BASE}/product/{barcode}",
            params={"fields": "product_name,brands,nutriments,serving_size,serving_quantity"},
            headers={"User-Agent": "Thallo/1.0 (fitness app)"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[openfoodfacts] lookup failed for {barcode}: {e}")
        return None

    if data.get("status") != 1:
        return None

    product = data.get("product", {})
    nuts = product.get("nutriments", {})
    name = product.get("product_name", "")
    brand = product.get("brands", "")

    if not name:
        return None

    serving = product.get("serving_size", "100 g")
    serving_g = product.get("serving_quantity") or 100

    # Prefer per-serving values, fall back to per-100g
    cal = nuts.get("energy-kcal_serving") or (nuts.get("energy-kcal_100g", 0) * serving_g / 100)
    pro = nuts.get("proteins_serving") or (nuts.get("proteins_100g", 0) * serving_g / 100)
    carb = nuts.get("carbohydrates_serving") or (nuts.get("carbohydrates_100g", 0) * serving_g / 100)
    fat = nuts.get("fat_serving") or (nuts.get("fat_100g", 0) * serving_g / 100)

    return {
        "name": f"{name} ({brand})" if brand else name,
        "barcode": barcode,
        "serving": serving,
        "calories": round(cal),
        "protein": round(pro, 1),
        "carbs": round(carb, 1),
        "fat": round(fat, 1),
        "fiber": round(nuts.get("fiber_serving") or nuts.get("fiber_100g", 0) * serving_g / 100, 1),
        "sugar": round(nuts.get("sugars_serving") or nuts.get("sugars_100g", 0) * serving_g / 100, 1),
        "sodium_mg": round((nuts.get("sodium_serving") or nuts.get("sodium_100g", 0) * serving_g / 100) * 1000, 1),
        "source": "openfoodfacts",
    }
