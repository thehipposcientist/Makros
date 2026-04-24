"""YouTube form-video resolver — scrapes YouTube search for an exercise
name and returns the first embeddable video_id.

Shared by:
  • `/ai/exercise-video` — on-demand lookup when the user taps "Watch form
    video" for an exercise that has no stored video_id.
  • Server startup backfill — iterates every Exercise row with no
    video_id and populates it from the scraper so the library shows real
    YouTube thumbnails everywhere (not stick figures).

Keep this self-contained: no FastAPI deps, no DB imports. Callers wire
it up to their own persistence layer.
"""
from __future__ import annotations

import json as _json
import re as _re
import urllib.parse as _urlparse
import urllib.request as _urlreq
from concurrent.futures import ThreadPoolExecutor as _TPE


_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_HEADERS = {"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"}


def oembed_probe(vid: str, timeout: float = 4.0) -> dict | None:
    """Probe YouTube oEmbed. Returns `{video_id, title, thumbnail_url,
    author_name}` when embeddable, None otherwise. 200 = embed OK;
    401/403/404 = blocked/disabled/removed."""
    try:
        oembed = (
            "https://www.youtube.com/oembed?"
            f"url=https%3A//www.youtube.com/watch%3Fv%3D{vid}&format=json"
        )
        req = _urlreq.Request(oembed, headers={"User-Agent": "Mozilla/5.0"})
        with _urlreq.urlopen(req, timeout=timeout) as r:
            if r.status != 200:
                return None
            data = _json.loads(r.read().decode("utf-8", errors="ignore"))
            return {
                "video_id": vid,
                "title": str(data.get("title") or "").strip(),
                "thumbnail_url": str(data.get("thumbnail_url") or "").strip(),
                "author_name": str(data.get("author_name") or "").strip(),
            }
    except Exception:
        return None


def _fetch_html(url: str, timeout: float = 8.0) -> str:
    try:
        req = _urlreq.Request(url, headers=_HEADERS)
        with _urlreq.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="ignore")
    except Exception:
        return ""


def _extract_ids(html: str) -> list[str]:
    ids = _re.findall(
        r'"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"', html,
    )
    if not ids:
        ids = _re.findall(r'"videoId":"([a-zA-Z0-9_-]{11})"', html)
    return ids


def find_youtube_video_id(exercise_name: str, max_probes: int = 10) -> str | None:
    """Return the first embeddable YouTube video_id for
    `"{exercise_name} proper form tutorial"` — or None when nothing
    embeddable turns up. Blocking. ~3-8 seconds per call.
    """
    name = (exercise_name or "").strip()
    if not name:
        return None
    query = f"{name} proper form tutorial"
    search_url = (
        f"https://www.youtube.com/results?search_query={_urlparse.quote(query)}"
    )
    html = _fetch_html(search_url)
    if not html:
        return None
    ids = _extract_ids(html)
    if not ids:
        return None
    # Dedupe while preserving order, cap probes so a bad query doesn't
    # stall the backfill.
    seen: set[str] = set()
    candidates: list[str] = []
    for vid in ids:
        if vid in seen:
            continue
        seen.add(vid)
        candidates.append(vid)
        if len(candidates) >= max_probes:
            break
    with _TPE(max_workers=6) as pool:
        probes = list(pool.map(oembed_probe, candidates))
    for probe in probes:
        if probe and probe.get("video_id"):
            return probe["video_id"]
    return None


def scrape_embeddable_options(exercise_name: str, max_probes: int = 20) -> list[dict]:
    """Full version used by the `/ai/exercise-video` endpoint. Returns
    up to 10 embeddable options (video_id + title + thumbnail + author +
    is_short). Interleaves regular results with the YouTube Shorts feed
    so the grid mixes longer tutorials with quick-form refreshers."""
    name = (exercise_name or "").strip()
    if not name:
        return []
    query = f"{name} proper form tutorial"
    search_url = (
        f"https://www.youtube.com/results?search_query={_urlparse.quote(query)}"
    )
    shorts_url = f"{search_url}&sp=EgIYAQ%253D%253D"

    with _TPE(max_workers=2) as pool:
        regular_html, shorts_html = pool.map(_fetch_html, [search_url, shorts_url])

    regular_ids = _extract_ids(regular_html)
    shorts_ids = _extract_ids(shorts_html)
    shorts_set = set(shorts_ids)
    seen: set[str] = set()
    candidates: list[tuple[str, bool]] = []
    for vid in regular_ids[:20]:
        if vid in seen:
            continue
        seen.add(vid)
        candidates.append((vid, vid in shorts_set))
    for vid in shorts_ids[:10]:
        if vid in seen:
            continue
        seen.add(vid)
        candidates.append((vid, True))
    candidates = candidates[:max_probes]
    if not candidates:
        return []

    with _TPE(max_workers=8) as pool:
        probes = list(pool.map(lambda c: oembed_probe(c[0]), candidates))

    options: list[dict] = []
    for (vid, is_short), probe in zip(candidates, probes):
        if not probe:
            continue
        probe["is_short"] = bool(is_short)
        options.append(probe)
    return options[:10]
