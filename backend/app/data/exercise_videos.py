"""Curated YouTube video IDs for common exercises.

YouTube's oEmbed API reports embeddability inconsistently — many videos
return 200 from oEmbed but still throw player error 152/153 inside a
WebView iframe. The only reliable path is manual curation: picking videos
from fitness channels whose uploaders allow embedding.

To add a curated entry:
  1. Find a form video on YouTube that plays cleanly in an iframe preview
     (test at https://www.youtube.com/embed/<ID> in a browser).
  2. Copy the 11-character video ID from the URL
     (https://www.youtube.com/watch?v=<ID> or https://youtu.be/<ID>).
  3. Add a line below keyed by the lower-cased exercise name.
     Include common aliases as separate keys pointing at the same ID.

Channels known to generally allow embedding:
  - Jeff Nippard
  - AthleanX
  - Scott Herman Fitness
  - StrongLifts
  - Squat University
  - Jeremy Ethier
  - Calisthenicmovement

Keys should be lowercased, with spaces preserved. The lookup helper
normalizes the input and checks aliases too.
"""


# Map of exercise name (lowercase) → YouTube video ID.
# Add entries as you verify embeddability. Starts empty — the endpoint
# falls back to search-based resolution for anything not in this map.
CURATED_VIDEOS: dict[str, str] = {
    # ── Examples (commented — uncomment and verify before enabling) ──────
    # "barbell back squat":      "ultWZbUMPL8",   # Jeff Nippard — 2020 squat guide
    # "barbell bench press":     "rxD321l2svE",   # AthleanX — perfect bench
    # "conventional deadlift":   "op9kVnSso6Q",   # Squat University — deadlift setup
    # "overhead press":          "2yjwXTZQDDI",   # Jeff Nippard — OHP form
    # "barbell row":             "vT2GjY_Umpw",   # AthleanX — barbell row
    # "pull-up":                 "eGo4IYlbE5g",   # AthleanX — pull-ups
    # "romanian deadlift":       "JCXUYuzwNrM",   # Jeff Nippard — RDL
    # "bulgarian split squat":   "2C-uNgKwPLE",   # Jeff Nippard — BSS
}


# Aliases map alternate names to a canonical key in CURATED_VIDEOS. Lets
# us cover "Squat", "Back Squat", "Barbell Squat" without duplicating IDs.
ALIASES: dict[str, str] = {
    "squat":                   "barbell back squat",
    "back squat":              "barbell back squat",
    "barbell squat":           "barbell back squat",
    "bench press":             "barbell bench press",
    "flat bench press":        "barbell bench press",
    "deadlift":                "conventional deadlift",
    "standing overhead press": "overhead press",
    "military press":          "overhead press",
    "shoulder press":          "overhead press",
    "bent over row":           "barbell row",
    "bent-over row":           "barbell row",
    "pullup":                  "pull-up",
    "pull up":                 "pull-up",
    "rdl":                     "romanian deadlift",
    "bss":                     "bulgarian split squat",
    "rear foot elevated split squat": "bulgarian split squat",
}


def lookup_curated(exercise_name: str) -> str | None:
    """Return a curated video ID for `exercise_name` or None if not mapped."""
    key = exercise_name.strip().lower()
    if key in CURATED_VIDEOS:
        return CURATED_VIDEOS[key]
    alias = ALIASES.get(key)
    if alias and alias in CURATED_VIDEOS:
        return CURATED_VIDEOS[alias]
    return None
