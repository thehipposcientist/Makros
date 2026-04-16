"""Focus string → coarse training bucket.

Every place in the planner that needs to answer "what kind of day was
that?" goes through `normalize_focus_to_bucket`. Before this module,
the rotation code did exact-match lookups against a fixed table like
`{"Legs": "lower_body", ...}` which silently failed whenever the
stored focus string was anything other than the canonical label —
e.g. `"Lower 2 — Hinge Bias"`, `"Leg Day"`, `"Back & Biceps"`,
`"Legs 1"`, `"Legs — Squat + Hinge"`, or the parse-workouts variants
`"Upper Body"` / `"Lower Body"`. That was the root cause of the
"you just hit legs, here are legs tomorrow" regression.

This module normalizes any of those variants to one of:

    "lower_body"   — legs, hamstrings, glutes, hinge, squat, lower
    "upper_body"   — push, pull, chest, back, shoulders, arms, upper
    "full_body"    — full body, total body
    "cardio"       — cardio, conditioning, intervals, zone 2, run
    "mobility"     — mobility, stretch, yoga, flexibility
    "recovery"     — recovery, rest, easy, walk, restoration
    None           — unknown / empty string

The normalization is intentionally generous — we'd rather accept a
weird label and bucket it correctly than reject it and silently lose
the continuity signal. Order matters inside the function: more
specific patterns are checked first so "Leg Day" doesn't get captured
by the fallback, and so on.
"""
from __future__ import annotations

import re
from typing import Optional

# One of the six buckets, or None.
FocusBucket = Optional[str]


# Keyword → bucket maps. Longer / more specific keywords must come
# first within each list because we scan top-to-bottom and return on
# first match. Each entry is a regex word-boundary pattern.
_LOWER_BODY_KEYWORDS = [
    r"\blower body\b",
    r"\blower\b",
    r"\blegs?\b",
    r"\bleg day\b",
    r"\bglutes?\b",
    r"\bhamstrings?\b",
    r"\bquads?\b",
    r"\bsquat\b",
    r"\bhinge\b",
    r"\bposterior chain\b",
]

_UPPER_BODY_KEYWORDS = [
    r"\bupper body\b",
    r"\bupper\b",
    r"\bpush\b",
    r"\bpull\b",
    r"\bchest\b",
    r"\bback\b",
    r"\bshoulders?\b",
    r"\barms?\b",
    r"\bbiceps?\b",
    r"\btriceps?\b",
    r"\bdelts?\b",
    r"\blats?\b",
    r"\btraps?\b",
    r"\bpressing\b",
    r"\bpulling\b",
]

_FULL_BODY_KEYWORDS = [
    r"\bfull body\b",
    r"\btotal body\b",
    r"\bwhole body\b",
    # Intentionally NO bare `\bfull\b` — too risky. "Full Body" and
    # "Total Body" are the only unambiguous signals.
]

_CARDIO_KEYWORDS = [
    r"\bcardio\b",
    r"\bconditioning\b",
    r"\bintervals?\b",
    r"\bzone ?2\b",
    r"\bsteady[- ]?state\b",
    r"\btempo\b",
    r"\bhiit\b",
    r"\bsprints?\b",
    r"\brun(ning)?\b",
    r"\bjog(ging)?\b",
    r"\bwalking\b",
    r"\bbike\b",
    r"\bcycling\b",
    r"\bswim(ming)?\b",
    r"\brow(ing)?\b",
    r"\bmetcon\b",
    r"\bcircuit\b",
    r"\bendurance\b",
]

_MOBILITY_KEYWORDS = [
    r"\bmobility\b",
    r"\bstretch(ing)?\b",
    r"\byoga\b",
    r"\bflexibility\b",
    r"\bflow\b",
    r"\bfoam rolling?\b",
]

_RECOVERY_KEYWORDS = [
    r"\brecovery\b",
    r"\beasy movement\b",
    r"\brest(oration)?\b",
    r"\brestorative\b",
    r"\bactive recovery\b",
    r"\bdeload\b",
]


def normalize_focus_to_bucket(raw_focus: Optional[str]) -> FocusBucket:
    """Collapse any focus label to one of six coarse training buckets.

    Handles every variant the codebase has been observed to store:
      - canonical labels: "Legs", "Upper", "Full Body"
      - numbered variants: "Legs 1", "Upper 2", "Lower 3"
      - archetype emphasis subtitles: "Lower 2 — Hinge Bias",
        "Upper 1 — Horizontal Push/Pull", "Legs — Squat + Hinge"
      - parse-workouts labels: "Upper Body", "Leg Day", "Back & Biceps"
      - casing differences: "legs", "LEGS", "Legs"
      - composite focuses: "Back and Biceps", "Chest/Shoulders"

    Precedence: more specific buckets first (cardio before upper, so
    "Upper Intervals" buckets as cardio). Returns None for empty or
    unrecognizable input so callers can distinguish "no recent data"
    from "recent data, unknown bucket".
    """
    if not raw_focus or not isinstance(raw_focus, str):
        return None

    # Lowercase + strip accents/punctuation that shouldn't affect
    # matching. Keep `/`, `&`, `+`, `—`, `-` so composite focuses
    # still read naturally, but we scan with word boundaries anyway.
    text = raw_focus.strip().lower()
    if not text:
        return None

    # Drop numbering like " 1", " 2" at the end of the bare base
    # label — "Legs 1" → "legs". Without this, the word-boundary
    # regex for "legs" still matches, so it's cosmetic, but it keeps
    # downstream logs cleaner.
    text = re.sub(r"\s+\d+\s*$", "", text)

    # Check full-body FIRST so emphasis subtitles like
    # "Full Body A — Squat & Press" bucket as full_body instead of
    # getting captured by the lower-body `\bsquat\b` keyword in the
    # subtitle. "Full Body" is unambiguous and always wins.
    for pattern in _FULL_BODY_KEYWORDS:
        if re.search(pattern, text):
            return "full_body"

    # Cardio / mobility / recovery next — these are intent-specific
    # and override body-part keywords (e.g. "upper body intervals"
    # should bucket as cardio, not upper_body).
    for pattern in _CARDIO_KEYWORDS:
        if re.search(pattern, text):
            return "cardio"

    for pattern in _MOBILITY_KEYWORDS:
        if re.search(pattern, text):
            return "mobility"

    for pattern in _RECOVERY_KEYWORDS:
        if re.search(pattern, text):
            return "recovery"

    # Lower-body keywords before upper so "Legs & Back" → lower
    # (legs is more recent in the user's body). The user can always
    # clarify via explicit chat; this is a reasonable default.
    for pattern in _LOWER_BODY_KEYWORDS:
        if re.search(pattern, text):
            return "lower_body"

    for pattern in _UPPER_BODY_KEYWORDS:
        if re.search(pattern, text):
            return "upper_body"

    return None


def normalize_focus_to_family(raw_focus: Optional[str]) -> FocusBucket:
    """Collapse a focus label to a fine-grained focus family.

    Unlike `normalize_focus_to_bucket` (which maps Push and Pull both
    to "upper_body"), this function preserves split identity:

        "push"   — push, chest, pressing, bench
        "pull"   — pull, back, lats, pulling, row (non-cardio)
        "legs"   — legs, quads, hamstrings, glutes, squat, hinge, lower
        "upper"  — upper (when not specifically push or pull)
        "lower"  — lower (when not specifically legs)
        "full_body", "cardio", "mobility", "recovery" — same as bucket

    Returns None for empty or unrecognizable input.
    """
    if not raw_focus or not isinstance(raw_focus, str):
        return None

    text = raw_focus.strip().lower()
    if not text:
        return None

    # Drop trailing numbering
    text = re.sub(r"\s+\d+\s*$", "", text)

    # Full body first (unambiguous)
    for pattern in _FULL_BODY_KEYWORDS:
        if re.search(pattern, text):
            return "full_body"

    # Cardio / mobility / recovery override body-part keywords
    for pattern in _CARDIO_KEYWORDS:
        if re.search(pattern, text):
            return "cardio"
    for pattern in _MOBILITY_KEYWORDS:
        if re.search(pattern, text):
            return "mobility"
    for pattern in _RECOVERY_KEYWORDS:
        if re.search(pattern, text):
            return "recovery"

    # Fine-grained push/pull/legs detection BEFORE coarse upper/lower
    _PUSH_PATTERNS = [
        r"\bpush\b", r"\bchest\b", r"\bpressing\b",
        r"\bbench\b", r"\btriceps?\b",
    ]
    _PULL_PATTERNS = [
        r"\bpull\b", r"\bback\b", r"\blats?\b",
        r"\bpulling\b", r"\bbiceps?\b",
    ]
    _LEGS_PATTERNS = [
        r"\blegs?\b", r"\bleg day\b", r"\bquads?\b",
        r"\bhamstrings?\b", r"\bglutes?\b", r"\bsquat\b",
        r"\bhinge\b", r"\bcalves?\b",
    ]

    for pattern in _LEGS_PATTERNS:
        if re.search(pattern, text):
            return "legs"
    for pattern in _PUSH_PATTERNS:
        if re.search(pattern, text):
            return "push"
    for pattern in _PULL_PATTERNS:
        if re.search(pattern, text):
            return "pull"

    # Coarse upper/lower fallback
    for pattern in _LOWER_BODY_KEYWORDS:
        if re.search(pattern, text):
            return "lower"
    for pattern in _UPPER_BODY_KEYWORDS:
        if re.search(pattern, text):
            return "upper"

    return None


# Reverse mapping: given a coarse bucket, what focus families could
# it contain? Used when only a coarse bucket is available.
BUCKET_TO_FAMILIES: dict[str, tuple[str, ...]] = {
    "upper_body": ("push", "pull", "upper"),
    "lower_body": ("legs", "lower"),
    "full_body": ("full_body",),
    "cardio": ("cardio",),
    "mobility": ("mobility",),
    "recovery": ("recovery",),
}


def describe_bucket(bucket: FocusBucket) -> str:
    """Short human label for logs / audit — never user-facing."""
    return bucket or "unknown"
