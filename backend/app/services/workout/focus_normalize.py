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


def _strip_plus_cardio_suffix(text: str) -> str:
    """Remove a trailing "+ cardio" / "+ finisher" / "with cardio" so
    PLUS_CARDIO hybrid days ("Push + Cardio") resolve to the LIFT
    family (push/pull/upper/full_body) instead of being swallowed by
    the cardio keyword. The appended cardio on these hybrids is a
    finisher — the primary stimulus is the lift, so the day should
    count as the lift family for split + history purposes.
    """
    if re.search(r"(\+|and|with|&)\s*cardio\b", text) or text.endswith(" cardio"):
        lift_seen = bool(re.search(r"\b(push|pull|upper|lower|legs?|full[- ]?body|chest|back|shoulders?|arms?)\b", text))
        if lift_seen:
            text = re.sub(r"\s*(\+|and|with|&)\s*cardio\b.*$", "", text)
            text = re.sub(r"\s+cardio\b.*$", "", text)
    return text


def normalize_focus_to_bucket(raw_focus: Optional[str]) -> FocusBucket:
    """Collapse any focus label to one of six coarse training buckets.

    Handles every variant the codebase has been observed to store:
      - canonical labels: "Legs", "Upper", "Full Body"
      - numbered variants: "Legs 1", "Upper 2", "Lower 3"
      - archetype emphasis subtitles: "Lower 2 — Hinge Bias",
        "Upper 1 — Horizontal Push/Pull", "Legs — Squat + Hinge"
      - PLUS_CARDIO hybrids: "Push + Cardio", "Upper + Cardio"
        (these bucket as the LIFT family — the cardio is a finisher)
      - parse-workouts labels: "Upper Body", "Leg Day", "Back & Biceps"
      - casing differences: "legs", "LEGS", "Legs"
      - composite focuses: "Back and Biceps", "Chest/Shoulders"

    Precedence: PLUS_CARDIO suffix is stripped FIRST, then full_body,
    then cardio/mobility/recovery, then body parts. Returns None for
    empty or unrecognizable input so callers can distinguish "no recent
    data" from "recent data, unknown bucket".
    """
    if not raw_focus or not isinstance(raw_focus, str):
        return None

    # Lowercase + strip accents/punctuation that shouldn't affect
    # matching. Keep `/`, `&`, `+`, `—`, `-` so composite focuses
    # still read naturally, but we scan with word boundaries anyway.
    text = raw_focus.strip().lower()
    if not text:
        return None

    # Normalize underscore-delimited archetype names ("lift_push_plus_cardio"
    # → "lift push plus cardio") so keyword matching works on both
    # human labels and raw enum values.
    text = text.replace("_", " ")
    # "plus cardio" → "+ cardio" so the strip function catches it.
    text = text.replace("plus cardio", "+ cardio")
    # Drop numbering like " 1", " 2" at the end of the bare base
    # label — "Legs 1" → "legs". Without this, the word-boundary
    # regex for "legs" still matches, so it's cosmetic, but it keeps
    # downstream logs cleaner.
    text = re.sub(r"\s+\d+\s*$", "", text)
    # Strip trailing "+ cardio" so PLUS_CARDIO hybrids resolve to
    # their lift family (the primary stimulus).
    text = _strip_plus_cardio_suffix(text)

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

    # Normalize underscore-delimited archetype names.
    text = text.replace("_", " ")
    text = text.replace("plus cardio", "+ cardio")
    # Drop trailing numbering
    text = re.sub(r"\s+\d+\s*$", "", text)
    # PLUS_CARDIO hybrids count as their lift family — see the
    # matching strip in normalize_focus_to_bucket for rationale.
    text = _strip_plus_cardio_suffix(text)

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
    # Shoulders mapped to push to match `archetype_to_focus_family`'s
    # mapping for `LIFT_BRO_SHOULDERS` — without this, pinning Shoulders
    # on a bro plan and family-based rotation logic disagree.
    _PUSH_PATTERNS = [
        r"\bpush\b", r"\bchest\b", r"\bpressing\b",
        r"\bbench\b", r"\btriceps?\b", r"\bshoulders?\b", r"\bdelts?\b",
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


def infer_family_from_muscles(muscle_fatigue: dict | None) -> Optional[str]:
    """Back-infer the training family from a per-muscle fatigue dict.

    Used when `focus_label` is ambiguous/generic (e.g. "Hypertrophy",
    AI-generated names) but the session's muscle distribution tells us
    what it actually was. Contracts:

      - `muscle_fatigue` is the dict-shape from `MuscleFatigue.to_dict()`
        or `WorkoutCompletion.resolved_muscle_fatigue`:
        `{"chest": 0.6, "back": 0.1, "biceps": 0.05, ...}`
      - Returns "push" / "pull" / "legs" / "full_body" / "cardio" / None.
      - Requires at least 60% of non-systemic fatigue to fall in one
        family. Below that threshold, returns "full_body" if spread
        across 3+ families, else None.

    Threshold is deliberately loose (60%) so a Pull day that includes
    some overhead press still buckets correctly as pull. Raise if false
    positives show up in practice.
    """
    if not muscle_fatigue or not isinstance(muscle_fatigue, dict):
        return None

    # Family → set of muscles that contribute to it. Systemic + cardio
    # don't count as "body region" — they're session-wide stress.
    push_muscles = ("chest", "shoulders", "triceps")
    pull_muscles = ("back", "biceps", "lats", "traps", "rear_delts")
    legs_muscles = ("quads", "hamstrings", "glutes", "calves")

    def _sum(keys):
        return sum(float(muscle_fatigue.get(k, 0) or 0) for k in keys)

    push = _sum(push_muscles)
    pull = _sum(pull_muscles)
    legs = _sum(legs_muscles)
    cardio = float(muscle_fatigue.get("cardio", 0) or 0)
    total = push + pull + legs

    if total <= 0 and cardio > 0:
        return "cardio"
    if total <= 0:
        return None

    # Find dominant family. Require >=60% share to claim the day.
    shares = {"push": push / total, "pull": pull / total, "legs": legs / total}
    dominant, share = max(shares.items(), key=lambda kv: kv[1])
    if share >= 0.60:
        return dominant

    # No single dominant family — if the work is spread across 3+
    # families reasonably evenly, call it full body. Otherwise, unknown.
    nonzero_families = sum(1 for v in shares.values() if v >= 0.15)
    if nonzero_families >= 3:
        return "full_body"
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
