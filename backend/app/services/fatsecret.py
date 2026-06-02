"""
FatSecret Platform API client.

Setup:
  FATSECRET_CLIENT_ID=...
  FATSECRET_CLIENT_SECRET=...
  FATSECRET_SCOPE=basic
  FATSECRET_SEARCH_VERSION=v1

Set FATSECRET_SEARCH_VERSION=v5 and FATSECRET_SCOPE=premier when the app has
Premier/Premier Free access. Search is intentionally read-through; FatSecret's
terms only mark food_id and serving_id as indefinitely storable.
"""
from __future__ import annotations

import copy
import os
import re
import time
from typing import Any

import httpx

_BASE = "https://platform.fatsecret.com/rest"
_TOKEN_URL = "https://oauth.fatsecret.com/connect/token"
_TIMEOUT = 8.0
_MAX_CACHE_ENTRIES = 512

_TOKEN_CACHE: dict[str, Any] = {"access_token": None, "expires_at": 0.0}
_SEARCH_CACHE: dict[tuple[str, int, str, str], tuple[float, list[dict[str, Any]]]] = {}


def _enabled() -> bool:
    return os.getenv("FATSECRET_ENABLED", "1") != "0"


def _credentials() -> tuple[str, str] | None:
    client_id = os.getenv("FATSECRET_CLIENT_ID", "").strip()
    client_secret = os.getenv("FATSECRET_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None
    return client_id, client_secret


def _scope() -> str:
    return os.getenv("FATSECRET_SCOPE", "basic").strip() or "basic"


def _search_version() -> str:
    raw = os.getenv("FATSECRET_SEARCH_VERSION", "v1").strip().lower()
    if raw in {"5", "v5", "foods.search.v5"}:
        return "v5"
    return "v1"


def _region_for(version: str) -> str | None:
    region = os.getenv("FATSECRET_REGION", "").strip().upper()
    if not region:
        return None
    if version == "v1" and "premier" not in _scope().lower():
        return None
    return region


def _cache_ttl_secs() -> int:
    try:
        requested = int(os.getenv("FATSECRET_SEARCH_CACHE_TTL_SECS", "3600"))
    except ValueError:
        requested = 3600
    return max(0, min(requested, 86400))


def _cache_key(query: str, max_results: int, version: str, region: str | None) -> tuple[str, int, str, str]:
    normalized = re.sub(r"\s+", " ", query.lower()).strip()
    return normalized, max_results, version, region or ""


def _get_cached_search(key: tuple[str, int, str, str]) -> list[dict[str, Any]] | None:
    cached = _SEARCH_CACHE.get(key)
    if not cached:
        return None
    expires_at, results = cached
    if expires_at <= time.time():
        _SEARCH_CACHE.pop(key, None)
        return None
    return copy.deepcopy(results)


def _store_cached_search(key: tuple[str, int, str, str], results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ttl = _cache_ttl_secs()
    if ttl > 0:
        _SEARCH_CACHE[key] = (time.time() + ttl, copy.deepcopy(results))
        if len(_SEARCH_CACHE) > _MAX_CACHE_ENTRIES:
            for old_key in list(_SEARCH_CACHE.keys())[:128]:
                _SEARCH_CACHE.pop(old_key, None)
    return copy.deepcopy(results)


def _access_token() -> str | None:
    creds = _credentials()
    if not creds:
        return None
    now = time.time()
    cached = _TOKEN_CACHE.get("access_token")
    if cached and float(_TOKEN_CACHE.get("expires_at") or 0) > now + 60:
        return str(cached)

    client_id, client_secret = creds
    resp = httpx.post(
        _TOKEN_URL,
        auth=(client_id, client_secret),
        data={"grant_type": "client_credentials", "scope": _scope()},
        headers={"content-type": "application/x-www-form-urlencoded"},
        timeout=_TIMEOUT,
    )
    resp.raise_for_status()
    data = resp.json()
    token = str(data.get("access_token") or "")
    if not token:
        return None
    try:
        expires_in = max(60, int(data.get("expires_in") or 86400))
    except (TypeError, ValueError):
        expires_in = 86400
    _TOKEN_CACHE["access_token"] = token
    _TOKEN_CACHE["expires_at"] = now + expires_in
    return token


def _as_list(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _float(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


_DESCRIPTION_RE = re.compile(
    r"Per\s+(?P<serving>.+?)\s+-\s+Calories:\s*(?P<calories>[\d.]+)kcal"
    r"\s*\|\s*Fat:\s*(?P<fat>[\d.]+)g"
    r"\s*\|\s*Carbs:\s*(?P<carbs>[\d.]+)g"
    r"\s*\|\s*Protein:\s*(?P<protein>[\d.]+)g",
    re.IGNORECASE,
)


def _parse_food_description(description: str) -> dict[str, float | str] | None:
    match = _DESCRIPTION_RE.search(description or "")
    if not match:
        return None
    values: dict[str, float | str] = {"serving": match.group("serving").strip()}
    for key in ("calories", "protein", "carbs", "fat"):
        parsed = _float(match.group(key))
        if parsed is None:
            return None
        values[key] = parsed
    return values


def _display_name(food_name: str, brand: str | None) -> str:
    name = re.sub(r"\s+", " ", food_name or "").strip()
    brand = re.sub(r"\s+", " ", brand or "").strip()
    if brand and brand.lower() not in name.lower():
        return f"{brand} {name}".strip()
    return name


def _round_macro(value: Any) -> float:
    parsed = _float(value)
    if parsed is None:
        return 0.0
    return round(parsed, 1)


def _serving_grams(serving: dict[str, Any]) -> float | None:
    amount = _float(serving.get("metric_serving_amount"))
    unit = str(serving.get("metric_serving_unit") or "").strip().lower()
    if amount is None:
        return None
    if unit in {"g", "gram", "grams", "ml", "milliliter", "milliliters"}:
        return round(amount, 1)
    if unit in {"oz", "ounce", "ounces"}:
        return round(amount * 28.3495, 1)
    return None


def _micronutrients_from_serving(serving: dict[str, Any]) -> dict[str, float]:
    key_map = {
        "fiber": "fiber",
        "sugar": "sugar",
        "sodium": "sodium",
        "potassium": "potassium",
        "calcium": "calcium",
        "iron": "iron",
        "vitamin_a": "vitamin_a",
        "vitamin_c": "vitamin_c",
        "vitamin_d": "vitamin_d",
        "cholesterol": "cholesterol",
        "saturated_fat": "saturated_fat",
        "polyunsaturated_fat": "polyunsaturated_fat",
        "monounsaturated_fat": "monounsaturated_fat",
        "trans_fat": "trans_fat",
        "added_sugars": "added_sugar",
    }
    out: dict[str, float] = {}
    for src, dest in key_map.items():
        parsed = _float(serving.get(src))
        if parsed is not None:
            out[dest] = round(parsed, 2)
    return out


def _base_result(food: dict[str, Any], serving_id: str | None = None) -> dict[str, Any] | None:
    food_id = str(food.get("food_id") or "").strip()
    food_name = str(food.get("food_name") or "").strip()
    if not food_id or not food_name:
        return None
    brand = str(food.get("brand_name") or "").strip() or None
    external_id = f"fatsecret:{food_id}" + (f":{serving_id}" if serving_id else "")
    return {
        "name": _display_name(food_name, brand),
        "source": "fatsecret",
        "external_id": external_id,
        "fdc_id": None,
        "food_id": None,
        "serving_id": None,
        "brand": brand,
        "is_verified": True,
        "trust_badge": "verified",
        "nutrition_confidence": "high",
        "fatsecret_food_id": food_id,
        "fatsecret_serving_id": serving_id,
    }


def _result_from_v1_food(food: dict[str, Any]) -> dict[str, Any] | None:
    parsed = _parse_food_description(str(food.get("food_description") or ""))
    base = _base_result(food)
    if not parsed or not base:
        return None
    return {
        **base,
        "serving": parsed["serving"],
        "serving_grams": None,
        "calories": round(float(parsed["calories"])),
        "protein": _round_macro(parsed["protein"]),
        "carbs": _round_macro(parsed["carbs"]),
        "fat": _round_macro(parsed["fat"]),
    }


def _choose_serving(servings: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not servings:
        return None
    default = next((s for s in servings if str(s.get("is_default") or "") == "1"), None)
    if default:
        return default
    non_derived = next((s for s in servings if str(s.get("serving_id") or "") != "0"), None)
    return non_derived or servings[0]


def _result_from_v5_food(food: dict[str, Any]) -> dict[str, Any] | None:
    servings = _as_list((food.get("servings") or {}).get("serving") if isinstance(food.get("servings"), dict) else None)
    serving = _choose_serving(servings)
    if not serving:
        return None
    serving_id = str(serving.get("serving_id") or "").strip() or None
    base = _base_result(food, serving_id=serving_id)
    if not base:
        return None
    calories = _float(serving.get("calories"))
    if calories is None or calories <= 0:
        return None
    micros = _micronutrients_from_serving(serving)
    result = {
        **base,
        "serving": str(serving.get("serving_description") or "1 serving").strip() or "1 serving",
        "serving_grams": _serving_grams(serving),
        "calories": round(calories),
        "protein": _round_macro(serving.get("protein")),
        "carbs": _round_macro(serving.get("carbohydrate")),
        "fat": _round_macro(serving.get("fat")),
    }
    if "fiber" in micros:
        result["fiber"] = micros["fiber"]
    if micros:
        result["micronutrients"] = micros
    return result


def _parse_search_response(data: dict[str, Any], version: str, max_results: int) -> list[dict[str, Any]]:
    if version == "v5":
        foods = _as_list(
            ((data.get("foods_search") or {}).get("results") or {}).get("food")
            if isinstance(data.get("foods_search"), dict)
            else None
        )
        parsed = [_result_from_v5_food(food) for food in foods]
    else:
        foods = _as_list((data.get("foods") or {}).get("food") if isinstance(data.get("foods"), dict) else None)
        parsed = [_result_from_v1_food(food) for food in foods]
    return [item for item in parsed if item][:max_results]


def search_foods(query: str, max_results: int = 8) -> list[dict[str, Any]]:
    """
    Search FatSecret for branded/restaurant foods.

    Missing credentials, disabled integration, network failures, and missing
    scopes all degrade to an empty result set so USDA/AI fallback can continue.
    """
    query = query.strip()
    if not query or not _enabled() or not _credentials():
        return []
    max_results = min(50, max(1, int(max_results or 8)))
    version = _search_version()
    region = _region_for(version)
    cache_key = _cache_key(query, max_results, version, region)
    cached = _get_cached_search(cache_key)
    if cached is not None:
        return cached

    try:
        token = _access_token()
        if not token:
            return []
        params: dict[str, Any] = {
            "search_expression": query,
            "max_results": max_results,
            "format": "json",
        }
        if version == "v5":
            params["flag_default_serving"] = "true"
            params["food_type"] = "none"
        if region:
            params["region"] = region

        if version == "v1":
            resp = httpx.post(
                f"{_BASE}/server.api",
                data={**params, "method": "foods.search"},
                headers={"Authorization": f"Bearer {token}"},
                timeout=_TIMEOUT,
            )
        else:
            resp = httpx.get(
                f"{_BASE}/foods/search/{version}",
                params=params,
                headers={"Authorization": f"Bearer {token}"},
                timeout=_TIMEOUT,
            )
        resp.raise_for_status()
        data = resp.json()
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict):
            print(f"[fatsecret] API error {error.get('code')}: {error.get('message')}")
            return []
        results = _parse_search_response(data, version, max_results)
        return _store_cached_search(cache_key, results)
    except Exception as exc:
        print(f"[fatsecret] search failed: {exc}")
        return []


def provider_status(query: str = "mcdonalds cheeseburger", max_results: int = 3) -> dict[str, Any]:
    enabled = _enabled()
    configured = _credentials() is not None
    version = _search_version()
    region = _region_for(version)
    status = "disabled" if not enabled else "missing_credentials" if not configured else "empty_or_failed"
    results: list[dict[str, Any]] = []
    if enabled and configured:
        results = search_foods(query, max_results=max_results)
        if results:
            status = "ok"
    first = results[0] if results else {}
    hint = None
    if status == "empty_or_failed":
        hint = "Check backend logs for [fatsecret] errors and confirm scope/search_version match the FatSecret account access."
    return {
        "provider": "fatsecret",
        "status": status,
        "enabled": enabled,
        "configured": configured,
        "scope": _scope(),
        "search_version": version,
        "region": region,
        "probe_query": query,
        "result_count": len(results),
        "first_result_name": first.get("name"),
        "first_result_source": first.get("source"),
        "hint": hint,
    }
