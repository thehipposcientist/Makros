"""Food / meal image provider abstraction.

Meal and saved-meal rows can carry an optional meal-level image URL. The
client still owns the fallback path (category icon / bundled assets), so
provider failures must be silent and non-blocking.

When wiring a real provider, the call site is:
  • saved_meals.create_saved_meal — call resolve_food_image(name, items=...)
    and persist `image_url` + `image_source="recipe"|"product"|...`
  • meals.create_meal — same idea when the user did not upload a photo
  • a low-priority maintenance job that backfills NULL image_urls

User-uploaded photos always win and bypass this resolver entirely
(stored with image_source="user_photo").

Provider plug points:

  0. **Pexels** (optional, `PEXELS_API_KEY`) — broad stock coverage for
     generated/suggested meal cards. Set image_source="pexels". The client
     should render a fallback when a photo fails to load.

  1. **Open Food Facts** (free, no key) — best for packaged/branded items
     looked up by barcode or brand+name. Returns a CDN-hosted product
     image. Set image_source="product".
       https://world.openfoodfacts.org/api/v2/product/{barcode}.json

  2. **USDA FDC media endpoint** — for whole-foods category fallback
     when nothing else matches. Coverage is patchy; treat as a
     low-confidence "category" source.

  3. **Spoonacular / Edamam recipe APIs** (paid) — only worth wiring
     when generated AI meals start carrying a recipe-id from a real
     provider. Set image_source="recipe".

  4. **FatSecret** (paid, OAuth) — broadest food-photo coverage but
     gated by partner approval. Defer until we have business signoff.

The function returns a (url, source, confidence) triple so the client
resolver can decide whether to override with a category fallback.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from typing import Any, Iterable, Optional
import urllib.parse as _urlparse
import urllib.request as _urlreq


# image_source values the client resolver understands. Keep in sync
# with src/utils/foodImage.ts.
SOURCE_USER_PHOTO = "user_photo"
SOURCE_RECIPE = "recipe"
SOURCE_PEXELS = "pexels"
SOURCE_PRODUCT = "product"
SOURCE_CATEGORY = "category"

_PEXELS_SEARCH_URL = "https://api.pexels.com/v1/search"
_PEXELS_TIMEOUT_SECS = 3.0
_CACHE_TTL_SECS = 60 * 60 * 24
_CACHE: dict[str, tuple[float, tuple[Optional[str], Optional[str], Optional[float]]]] = {}


def _pexels_key() -> str | None:
    key = os.getenv("PEXELS_API_KEY", "").strip()
    if not key:
        return None
    if os.getenv("PEXELS_IMAGE_ENABLED", "1").strip().lower() in {"0", "false", "no", "off"}:
        return None
    return key


def _normalize_query_part(value: str) -> str:
    return " ".join(str(value or "").strip().lower().split())


def _query_for(name: str, items: Optional[Iterable[dict]]) -> str:
    parts = [_normalize_query_part(name)]
    if items:
        for item in items:
            food = _normalize_query_part(str(item.get("food_name") or item.get("name") or ""))
            if food:
                parts.append(food)
            if len(parts) >= 4:
                break
    base = " ".join(dict.fromkeys(part for part in parts if part))
    if not base:
        return ""
    return f"{base} healthy meal"


def _cached(cache_key: str) -> tuple[Optional[str], Optional[str], Optional[float]] | None:
    row = _CACHE.get(cache_key)
    if not row:
        return None
    expires_at, value = row
    if expires_at < time.time():
        _CACHE.pop(cache_key, None)
        return None
    return value


def _store_cache(
    cache_key: str,
    value: tuple[Optional[str], Optional[str], Optional[float]],
) -> tuple[Optional[str], Optional[str], Optional[float]]:
    _CACHE[cache_key] = (time.time() + _CACHE_TTL_SECS, value)
    return value


def _best_photo(photos: list[dict[str, Any]], query: str) -> dict[str, Any] | None:
    if not photos:
        return None
    # Rotate deterministically so similar app instances do not all choose
    # the same first result while still being stable for a given meal.
    digest = hashlib.sha256(query.encode("utf-8")).hexdigest()
    start = int(digest[:8], 16) % len(photos)
    rotated = photos[start:] + photos[:start]
    for photo in rotated:
        src = photo.get("src") if isinstance(photo, dict) else None
        if isinstance(src, dict) and any(src.get(k) for k in ("landscape", "large", "medium")):
            return photo
    return None


def _resolve_pexels_image(
    name: str,
    *,
    items: Optional[Iterable[dict]] = None,
) -> tuple[Optional[str], Optional[str], Optional[float]]:
    key = _pexels_key()
    if not key:
        return (None, None, None)
    query = _query_for(name, items)
    if not query:
        return (None, None, None)

    cache_key = f"pexels:{query}"
    cached = _cached(cache_key)
    if cached is not None:
        return cached

    try:
        params = _urlparse.urlencode({
            "query": query,
            "per_page": 12,
            "orientation": "landscape",
            "size": "medium",
        })
        req = _urlreq.Request(
            f"{_PEXELS_SEARCH_URL}?{params}",
            headers={"Authorization": key},
        )
        with _urlreq.urlopen(req, timeout=_PEXELS_TIMEOUT_SECS) as resp:
            status = getattr(resp, "status", None) or resp.getcode()
            if status != 200:
                return _store_cache(cache_key, (None, None, None))
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return (None, None, None)

    photos = payload.get("photos") if isinstance(payload, dict) else None
    if not isinstance(photos, list):
        return _store_cache(cache_key, (None, None, None))
    photo = _best_photo([p for p in photos if isinstance(p, dict)], query)
    src = photo.get("src") if photo else None
    if not isinstance(src, dict):
        return _store_cache(cache_key, (None, None, None))
    url = src.get("landscape") or src.get("large") or src.get("medium")
    if not isinstance(url, str) or not url.startswith("https://"):
        return _store_cache(cache_key, (None, None, None))
    return _store_cache(cache_key, (url, SOURCE_PEXELS, 0.72))


def resolve_food_image(
    name: str,
    *,
    items: Optional[Iterable[dict]] = None,
    barcode: Optional[str] = None,
    fdc_id: Optional[str] = None,
) -> tuple[Optional[str], Optional[str], Optional[float]]:
    """Resolve an image URL for a meal/food/recipe.

    Returns (image_url, image_source, confidence). `confidence` is a
    0..1 hint the client can use to decide whether to show the image
    or fall back to a category icon. `None` for all three means the
    caller should leave image_url NULL and let the client render a
    category fallback.

    Pexels is the only live provider today. It is intentionally optional:
    no key, quota errors, and network failures all fall back to NULL.
    """
    _ = (barcode, fdc_id)
    return _resolve_pexels_image(name, items=items)
