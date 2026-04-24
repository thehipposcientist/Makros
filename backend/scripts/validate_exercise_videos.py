"""Validate curated YouTube video IDs against the YouTube oembed endpoint.

Dead / private / unlisted / region-locked IDs return 404 or 401 from
oembed even though `img.youtube.com/vi/{id}/hqdefault.jpg` returns a
gray "Video unavailable" placeholder with HTTP 200. This script catches
the dead ones at build time so they can be removed from EXERCISE_VIDEOS
before shipping.

Usage:
    docker exec thallo-backend python -m backend.scripts.validate_exercise_videos
    # or from host:
    python3 backend/scripts/validate_exercise_videos.py

Exits 0 when every ID is reachable; exits 1 and prints the broken slugs
when any are dead, so CI can gate on it.
"""
from __future__ import annotations

import sys
import time
from typing import Iterable

import httpx

# Allow running both as a module (-m) and as a script from repo root.
try:
    from app.seed_exercise_videos import EXERCISE_VIDEOS  # type: ignore
except Exception:
    import os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
    from seed_exercise_videos import EXERCISE_VIDEOS  # type: ignore


OEMBED = "https://www.youtube.com/oembed"
TIMEOUT = 6.0
SLEEP_BETWEEN = 0.06   # be polite — YouTube rate-limits rapid scrapers


def _check(video_id: str) -> tuple[bool, int | str]:
    """Returns (ok, status). `ok=True` means the video exists and is
    publicly embeddable."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        r = httpx.get(OEMBED, params={"url": url, "format": "json"}, timeout=TIMEOUT)
        return (r.status_code == 200, r.status_code)
    except httpx.HTTPError as e:
        return (False, f"err:{type(e).__name__}")


def main(targets: Iterable[tuple[str, str]] = None) -> int:
    items = list(targets) if targets is not None else sorted(EXERCISE_VIDEOS.items())
    total = len(items)
    broken: list[tuple[str, str, int | str]] = []
    ok_count = 0
    for i, (slug, vid) in enumerate(items, 1):
        ok, status = _check(vid)
        flag = "OK " if ok else "BAD"
        print(f"[{i:3d}/{total}] {flag} {slug:40s} → {vid}  ({status})")
        if ok:
            ok_count += 1
        else:
            broken.append((slug, vid, status))
        time.sleep(SLEEP_BETWEEN)

    print()
    print(f"Summary: {ok_count}/{total} OK, {len(broken)} broken")
    if broken:
        print()
        print("Broken entries (remove from EXERCISE_VIDEOS):")
        for slug, vid, status in broken:
            print(f"  '{slug}': '{vid}'  # {status}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
