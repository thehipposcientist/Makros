"""wger.de exercise database integration.

Two capabilities:
  1. search_exercises(query) — searches our cached wger exercise index
     for exercises matching the query. Returns structured results with
     images, muscles, and equipment. Used as primary search before AI fallback.

  2. enrich_with_images(exercises) — matches a list of exercise names
     against wger and returns image URLs for any matches found.

The wger.de API doesn't support efficient text search, so we download
the full English exercise catalog once and cache it in memory. The cache
is refreshed at most once per process (lazy singleton). ~2000 exercises,
<1MB — negligible memory cost.
"""
from __future__ import annotations

import re
import httpx
from typing import Any
from functools import lru_cache

_BASE = "https://wger.de/api/v2"
_TIMEOUT = 12.0
_ENGLISH_LANG_ID = 2


# ─── Cached exercise index ───────────────────────────────────────────────────

class _WgerIndex:
    """Lazy-loaded, process-lifetime cache of the wger exercise catalog."""

    def __init__(self):
        self._exercises: list[dict] | None = None
        self._by_name: dict[str, dict] | None = None

    def _load(self):
        if self._exercises is not None:
            return

        print("[wger] Loading exercise index from wger.de...")
        all_translations: list[dict] = []
        offset = 0
        limit = 200
        while True:
            try:
                resp = httpx.get(f"{_BASE}/exercise-translation/", params={
                    "language": _ENGLISH_LANG_ID,
                    "format": "json",
                    "limit": limit,
                    "offset": offset,
                }, timeout=_TIMEOUT)
                resp.raise_for_status()
                data = resp.json()
                results = data.get("results", [])
                all_translations.extend(results)
                if not data.get("next"):
                    break
                offset += limit
            except Exception as e:
                print(f"[wger] Failed to load at offset {offset}: {e}")
                break

        # Build index: exercise_id → {name, wger_id}
        exercises = []
        seen_ids = set()
        for t in all_translations:
            eid = t.get("exercise")
            name = (t.get("name") or "").strip()
            if not name or eid in seen_ids:
                continue
            seen_ids.add(eid)
            exercises.append({
                "wger_id": eid,
                "name": name,
                "name_lower": name.lower(),
            })

        self._exercises = exercises
        self._by_name = {e["name_lower"]: e for e in exercises}
        print(f"[wger] Indexed {len(exercises)} exercises")

    @property
    def exercises(self) -> list[dict]:
        self._load()
        return self._exercises or []

    @property
    def by_name(self) -> dict[str, dict]:
        self._load()
        return self._by_name or {}


_INDEX = _WgerIndex()


# ─── Exercise info fetcher ────────────────────────────────────────────────────

def _fetch_exercise_info(wger_id: int) -> dict | None:
    """Fetch full exercise info including images and muscles."""
    try:
        resp = httpx.get(f"{_BASE}/exerciseinfo/{wger_id}/", params={"format": "json"}, timeout=_TIMEOUT)
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:
        return None


def _extract_info(info: dict, name_override: str | None = None) -> dict[str, Any]:
    """Extract structured data from exerciseinfo response."""
    en_name = name_override
    if not en_name:
        for t in info.get("translations", []):
            if t.get("language") == _ENGLISH_LANG_ID:
                en_name = t.get("name", "")
                break
    en_desc = ""
    for t in info.get("translations", []):
        if t.get("language") == _ENGLISH_LANG_ID:
            raw = t.get("description", "")
            en_desc = re.sub(r"<[^>]+>", "", raw).strip()
            break

    muscles = [m.get("name_en", "") for m in info.get("muscles", []) if m.get("name_en")]
    muscles_secondary = [m.get("name_en", "") for m in info.get("muscles_secondary", []) if m.get("name_en")]
    equipment = [e.get("name", "") for e in info.get("equipment", []) if e.get("name")]
    images = [i.get("image", "") for i in info.get("images", []) if i.get("image")]

    return {
        "name": en_name or "",
        "wger_id": info.get("id"),
        "description": en_desc[:200] if en_desc else "",
        "muscles": muscles,
        "muscles_secondary": muscles_secondary,
        "equipment": equipment,
        "image_url": images[0] if images else None,
        "all_images": images[:4],
        "source": "wger",
    }


# ─── Public API ───────────────────────────────────────────────────────────────

def search_exercises(query: str, max_results: int = 8) -> list[dict[str, Any]]:
    """Search the wger exercise database by name.

    Uses fuzzy substring matching against the cached exercise index.
    Returns structured results with images, muscles, and equipment.
    Results that need image/muscle data trigger a per-exercise API call
    (only for the top results, not the full index).
    """
    q = query.lower().strip()
    if not q:
        return []

    words = q.split()

    scored: list[tuple[float, dict]] = []
    for ex in _INDEX.exercises:
        name = ex["name_lower"]
        # Exact match
        if name == q:
            scored.append((0.0, ex))
            continue
        # Starts with query
        if name.startswith(q):
            scored.append((0.5, ex))
            continue
        # All query words present
        if all(w in name for w in words):
            scored.append((1.0, ex))
            continue
        # Any query word present
        hits = sum(1 for w in words if w in name)
        if hits > 0:
            scored.append((2.0 - hits / len(words), ex))

    scored.sort(key=lambda x: x[0])
    candidates = scored[:max_results]

    results: list[dict[str, Any]] = []
    for _, ex in candidates:
        info = _fetch_exercise_info(ex["wger_id"])
        if info:
            results.append(_extract_info(info, name_override=ex["name"]))
        else:
            results.append({
                "name": ex["name"],
                "wger_id": ex["wger_id"],
                "muscles": [],
                "equipment": [],
                "image_url": None,
                "source": "wger",
            })

    return results


def get_image_for_exercise(name: str) -> str | None:
    """Look up a single exercise by exact name and return its image URL."""
    entry = _INDEX.by_name.get(name.lower().strip())
    if not entry:
        return None
    info = _fetch_exercise_info(entry["wger_id"])
    if not info:
        return None
    images = [i.get("image", "") for i in info.get("images", []) if i.get("image")]
    return images[0] if images else None


def enrich_with_images(exercise_names: list[str]) -> dict[str, str]:
    """Batch-match exercise names to wger and return {name: image_url} for matches."""
    result: dict[str, str] = {}
    for name in exercise_names:
        entry = _INDEX.by_name.get(name.lower().strip())
        if not entry:
            continue
        info = _fetch_exercise_info(entry["wger_id"])
        if not info:
            continue
        images = [i.get("image", "") for i in info.get("images", []) if i.get("image")]
        if images:
            result[name] = images[0]
    return result
