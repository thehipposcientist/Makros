"""OpenFoodFacts barcode lookup for packaged food products.

Complements USDA (which has whole foods but few branded products).
Free API, no key needed. Returns nutrition per 100g or per serving.
"""
from __future__ import annotations

import httpx
from typing import Any

from app.services.nutrition.added_sugar import resolve_added_sugar_g

_BASE = "https://world.openfoodfacts.org/api/v2"
_TIMEOUT = 8.0


def _float(value: Any, default: float = 0.0) -> float:
    try:
        if value in (None, ""):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def lookup_barcode(barcode: str) -> dict[str, Any] | None:
    """Look up a food product by barcode. Returns structured nutrition or None."""
    try:
        resp = httpx.get(
            f"{_BASE}/product/{barcode}",
            params={
                # `nova_group` is OFF's authoritative processing tier
                # (1=unprocessed, 2/3=processed, 4=ultra-processed).
                # Pulling it lets the classifier short-circuit the
                # name-based heuristic for products OFF has graded.
                "fields": "product_name,brands,nutriments,serving_size,serving_quantity,nova_group",
            },
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
    nova_group_raw = product.get("nova_group")

    if not name:
        return None

    serving = product.get("serving_size", "100 g")
    serving_g = _float(product.get("serving_quantity"), 0.0) or 100.0

    # Prefer per-serving values, fall back to per-100g
    cal = _float(nuts.get("energy-kcal_serving")) or (_float(nuts.get("energy-kcal_100g")) * serving_g / 100)
    pro = _float(nuts.get("proteins_serving")) or (_float(nuts.get("proteins_100g")) * serving_g / 100)
    carb = _float(nuts.get("carbohydrates_serving")) or (_float(nuts.get("carbohydrates_100g")) * serving_g / 100)
    fat = _float(nuts.get("fat_serving")) or (_float(nuts.get("fat_100g")) * serving_g / 100)

    # Coerce nova_group → our 3-tier bucket. OFF returns the int as a
    # number or a stringified number; both are safe to int(). Missing /
    # ungraded products (~30% of OFF entries) leave the bucket null so
    # the downstream heuristic still runs.
    nova_bucket: str | None = None
    try:
        nova_int = int(nova_group_raw) if nova_group_raw is not None else None
    except (TypeError, ValueError):
        nova_int = None
    if nova_int == 1:
        nova_bucket = "minimally_processed"
    elif nova_int in (2, 3):
        nova_bucket = "processed"
    elif nova_int == 4:
        nova_bucket = "ultra_processed"

    sugar = round(_float(nuts.get("sugars_serving")) or _float(nuts.get("sugars_100g")) * serving_g / 100, 1)
    added_sugar = resolve_added_sugar_g(
        name,
        reported_added_sugar_g=(
            _float(nuts.get("added-sugars_serving"), None)
            if nuts.get("added-sugars_serving") not in (None, "")
            else (
                _float(nuts.get("added-sugars_100g"), None) * serving_g / 100
                if nuts.get("added-sugars_100g") not in (None, "") else None
            )
        ),
        sugar_g=sugar,
        serving_grams=serving_g,
    )
    result = {
        "name": f"{name} ({brand})" if brand else name,
        "barcode": barcode,
        "serving": serving,
        "serving_grams": serving_g,
        "calories": round(cal),
        "protein": round(pro, 1),
        "carbs": round(carb, 1),
        "fat": round(fat, 1),
        "fiber": round(_float(nuts.get("fiber_serving")) or _float(nuts.get("fiber_100g")) * serving_g / 100, 1),
        "sugar": sugar,
        "sodium_mg": round((_float(nuts.get("sodium_serving")) or _float(nuts.get("sodium_100g")) * serving_g / 100) * 1000, 1),
        "source": "barcode",
        "nutrition_source": "openfoodfacts",
        "nutrition_confidence": "medium",
        # Authoritative processing classification when OFF has graded
        # the product. Consumed by `_attach_food_classification` to
        # skip the name-based heuristic.
        "nova_bucket": nova_bucket,
    }
    if added_sugar is not None:
        result["added_sugar_g"] = added_sugar
        result["micronutrients"] = {"sugar": sugar, "added_sugar_g": added_sugar}
    return result
