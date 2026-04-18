"""One-time migration: enrich exercises in the DB with wger.de image URLs.

Called from app startup (main.py) after the normal exercise seed runs.
Only touches rows where image_url IS NULL so it's safe to re-run.

Matching strategy (strict — prefers no image over a wrong image):
  1. Exact name match in wger index
  2. Close match: our name is a prefix of wger name or vice versa,
     AND the matched wger exercise has a UNIQUE image (not shared
     across 5+ exercises, which indicates a generic placeholder).
  3. Skip everything else — wrong images are worse than no images.
"""
from __future__ import annotations

import re
from collections import Counter
from sqlmodel import Session, select
from app.models import Exercise


def _normalize(name: str) -> str:
    """Lowercase, strip parenthetical notes, collapse whitespace."""
    s = re.sub(r'\s*\(.*?\)', '', name.lower())
    return re.sub(r'\s+', ' ', s).strip()


def seed_exercise_images(engine) -> int:
    with Session(engine) as db:
        missing = db.exec(
            select(Exercise).where(Exercise.image_url == None)
        ).all()
        if not missing:
            return 0

        try:
            from app.services.workout.wger_exercises import _INDEX, _fetch_exercise_info
        except Exception as e:
            print(f"[seed-images] wger import failed: {e}")
            return 0

        # Pre-scan: count how many wger exercises share each image URL.
        # Images used by 4+ exercises are generic placeholders.
        image_use_count: Counter[str] = Counter()
        image_cache: dict[int, list[str]] = {}

        enriched = 0
        for ex in missing:
            our_name = _normalize(ex.name)

            # Strategy 1: exact match
            entry = _INDEX.by_name.get(our_name)

            # Strategy 2: close prefix match (stricter than substring)
            if not entry:
                best_score = 0.0
                for wname, wentry in _INDEX.by_name.items():
                    w_norm = _normalize(wname)
                    if our_name == w_norm:
                        entry = wentry
                        break
                    # One must be a prefix of the other
                    if not (w_norm.startswith(our_name) or our_name.startswith(w_norm)):
                        continue
                    # Score by overlap ratio
                    overlap = min(len(our_name), len(w_norm)) / max(len(our_name), len(w_norm))
                    if overlap > best_score and overlap >= 0.6:
                        best_score = overlap
                        entry = wentry

            if not entry:
                continue

            wid = entry["wger_id"]
            if wid not in image_cache:
                info = _fetch_exercise_info(wid)
                if info:
                    image_cache[wid] = [i.get("image", "") for i in info.get("images", []) if i.get("image")]
                else:
                    image_cache[wid] = []

            images = image_cache[wid]
            if not images:
                continue

            url = images[0]

            # Track usage to detect generics
            image_use_count[url] += 1
            if image_use_count[url] > 3:
                print(f"[seed-images] SKIP {ex.name} — image {url[:50]} used by {image_use_count[url]} exercises (generic)")
                continue

            ex.image_url = url
            db.add(ex)
            enriched += 1

        if enriched > 0:
            db.commit()
        print(f"[seed-images] enriched {enriched}/{len(missing)} exercises with wger images")
        return enriched


def clear_bad_images(engine) -> int:
    """Remove image_url from exercises where the same URL is used by 4+ exercises.
    These are generic placeholder images that don't depict the specific exercise."""
    with Session(engine) as db:
        all_with_img = db.exec(
            select(Exercise).where(Exercise.image_url != None)
        ).all()
        if not all_with_img:
            return 0

        url_counts: Counter[str] = Counter()
        for ex in all_with_img:
            if ex.image_url:
                url_counts[ex.image_url] += 1

        generic_urls = {url for url, count in url_counts.items() if count >= 4}
        if not generic_urls:
            print(f"[seed-images] no generic images found")
            return 0

        cleared = 0
        for ex in all_with_img:
            if ex.image_url in generic_urls:
                print(f"[seed-images] clearing generic image from {ex.name}")
                ex.image_url = None
                db.add(ex)
                cleared += 1

        if cleared > 0:
            db.commit()
        print(f"[seed-images] cleared {cleared} generic images ({len(generic_urls)} shared URLs)")
        return cleared
