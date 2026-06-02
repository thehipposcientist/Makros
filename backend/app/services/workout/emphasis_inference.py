"""Fine-grained muscle-emphasis inference for the exercise library.

Purpose: surface the heads / regions an exercise actually trains
("front delt, side delt, triceps") in the library detail card and
filter UI. **Does not feed the fatigue model** — that still runs on
the 12-bucket `primary_muscle` + `secondary_muscles`.

The taxonomy is intentionally pragmatic — values users actually
recognize and bodybuilders care about, not anatomical correctness.
Splitting biceps into long/short head, or quads into
vastus-this-and-that, was deliberately skipped: most lifters don't
distinguish them and no exercise meaningfully targets one over the
other within the same compound family.

Inference strategy:
  1. `_OVERRIDES` lookup against the normalized seed name. Covers the
     exercises where rules alone would mis-tag (e.g. "Lateral Raise"
     must map to side_delt, not just "shoulders").
  2. Rule-based augmentation from name tokens (incline/decline,
     wide/close grip, etc.) combined with the existing
     `primary_muscle` + `secondary_muscles`.
  3. If nothing matches, return [] — the UI gracefully omits the
     emphasis chip row when the list is empty.

Pure-function — no DB, no network. Tested via
`tests/test_emphasis_inference.py`.
"""

from __future__ import annotations

import re
from typing import Iterable


# ─── Public taxonomy ─────────────────────────────────────────────────────────

# Canonical emphasis tags. Frontend renders each in a chip with the
# `humanizeToken` helper, so spaces/underscores are interchangeable.
EMPHASIS_TAGS: frozenset[str] = frozenset({
    # Chest
    "upper_chest", "mid_chest", "lower_chest",
    # Shoulders
    "front_delt", "side_delt", "rear_delt",
    # Upper back
    "lats", "upper_back", "traps", "lower_back",
    # Arms
    "brachialis", "forearms",
    # Lower body — most lifts don't differentiate further than
    # "quads" / "hamstrings" / "glutes," which are already in
    # primary_muscle. Only callouts that matter are these:
    "adductors", "abductors", "vmo",  # quad inner-knee specifically
    # Core
    "obliques", "abs", "lower_abs",
    # Calves
    "gastrocnemius", "soleus",
})


def _normalize_name(name: str) -> str:
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ─── Hand-curated overrides ──────────────────────────────────────────────────
#
# Keys are normalized exercise names (lowercased, punctuation stripped,
# whitespace collapsed). Values are the full emphasis list — these
# REPLACE rule output for the matching exercise, not merge with it,
# so they're the ground truth where rule output would be wrong.

_OVERRIDES: dict[str, list[str]] = {
    # Lateral raise variants — pure side delt
    "lateral raise": ["side_delt"],
    "lateral raises": ["side_delt"],
    "side lateral raise": ["side_delt"],
    "dumbbell lateral raise": ["side_delt"],
    "cable lateral raise": ["side_delt"],
    "cable seated lateral raise": ["side_delt"],
    "machine lateral raise": ["side_delt"],

    # Front raise variants — pure front delt
    "front raise": ["front_delt"],
    "front raises": ["front_delt"],
    "dumbbell front raise": ["front_delt"],
    "front dumbbell raise": ["front_delt"],
    "barbell front raise": ["front_delt"],
    "front cable raise": ["front_delt"],
    "plate front raise": ["front_delt"],

    # Rear delt isolation
    "rear delt fly": ["rear_delt"],
    "rear delt flyes": ["rear_delt"],
    "reverse fly": ["rear_delt"],
    "reverse flyes": ["rear_delt"],
    "rear delt raise": ["rear_delt"],
    "cable rear delt fly": ["rear_delt"],
    "bent over rear delt raise": ["rear_delt"],
    "face pull": ["rear_delt", "upper_back"],
    "face pulls": ["rear_delt", "upper_back"],
    "barbell rear delt row": ["rear_delt", "upper_back"],
    "band pull apart": ["rear_delt", "upper_back"],

    # Trap-dominant
    "shrug": ["traps"],
    "shrugs": ["traps"],
    "dumbbell shrug": ["traps"],
    "barbell shrug": ["traps"],
    "trap bar shrug": ["traps"],
    "cable shrug": ["traps"],
    "upright row": ["traps", "side_delt"],
    "barbell upright row": ["traps", "side_delt"],
    "upright barbell row": ["traps", "side_delt"],
    "cable upright row": ["traps", "side_delt"],
    "dumbbell upright row": ["traps", "side_delt"],
    "farmers walk": ["traps", "forearms"],
    "farmer s walk": ["traps", "forearms"],
    "farmers carry": ["traps", "forearms"],

    # Press variants where the rule would miss the front-delt tag
    "overhead press": ["front_delt", "side_delt"],
    "barbell overhead press": ["front_delt", "side_delt"],
    "military press": ["front_delt"],
    "standing military press": ["front_delt"],
    "seated barbell press": ["front_delt", "side_delt"],
    "dumbbell shoulder press": ["front_delt", "side_delt"],
    "seated dumbbell press": ["front_delt", "side_delt"],
    "arnold press": ["front_delt", "side_delt"],
    "arnold dumbbell press": ["front_delt", "side_delt"],
    "push press": ["front_delt", "side_delt"],
    "z press": ["front_delt"],
    "landmine press": ["front_delt"],
    "barbell shoulder press": ["front_delt", "side_delt"],

    # Forearm + grip
    "wrist curl": ["forearms"],
    "wrist curls": ["forearms"],
    "cable wrist curl": ["forearms"],
    "reverse wrist curl": ["forearms"],
    "wrist roller": ["forearms"],
    "plate pinch": ["forearms"],
    "hammer curl": ["brachialis", "forearms"],
    "hammer curls": ["brachialis", "forearms"],
    "cross body hammer curl": ["brachialis", "forearms"],
    "incline hammer curl": ["brachialis", "forearms"],
    "incline hammer curls": ["brachialis", "forearms"],
    "cable hammer curls rope attachment": ["brachialis", "forearms"],
    "zottman curl": ["brachialis", "forearms"],

    # Calves — soleus vs gastrocnemius. Seated → soleus, standing → gastroc.
    "standing calf raise": ["gastrocnemius"],
    "standing barbell calf raise": ["gastrocnemius"],
    "standing dumbbell calf raise": ["gastrocnemius"],
    "donkey calf raise": ["gastrocnemius"],
    "donkey calf raises": ["gastrocnemius"],
    "smith machine calf raise": ["gastrocnemius"],
    "calf press": ["gastrocnemius"],
    "seated calf raise": ["soleus"],
    "dumbbell seated one leg calf raise": ["soleus"],

    # Lats-specific
    "pullover": ["lats"],
    "bent arm dumbbell pullover": ["lats"],
    "dumbbell pullover": ["lats"],
    "straight arm pulldown": ["lats"],
    "straight arm pull down": ["lats"],
    "lat pullover": ["lats"],

    # Lower-back / posterior chain — fine-grained call-outs only;
    # hamstrings/glutes already live in primary/secondary_muscles.
    "good morning": ["lower_back"],
    "back extension": ["lower_back"],
    "hyperextension": ["lower_back"],
    "hyperextensions back extensions": ["lower_back"],
    "superman": ["lower_back"],

    # Core
    "russian twist": ["obliques"],
    "russian twists": ["obliques"],
    "side bridge": ["obliques"],
    "side plank": ["obliques"],
    "cross body crunch": ["obliques", "abs"],
    "wood chop": ["obliques"],
    "cable wood chop": ["obliques"],
    "pallof press": ["obliques"],
    "hanging leg raise": ["lower_abs"],
    "hanging leg raises": ["lower_abs"],
    "flat bench lying leg raise": ["lower_abs"],
    "reverse crunch": ["lower_abs"],
    "reverse crunches": ["lower_abs"],
    "flutter kicks": ["lower_abs"],
    "dead bug": ["abs", "lower_abs"],
    "ab roller": ["abs"],
    "ab crunch machine": ["abs"],
    "decline crunch": ["abs"],

    # Adductor / abductor isolation
    "cable hip adduction": ["adductors"],
    "adductor machine": ["adductors"],
    "abductor machine": ["abductors"],
    "monster walk": ["abductors"],
    "lateral bound": ["abductors"],
}


# ─── Rule-based augmentation ─────────────────────────────────────────────────

_INCLINE_RE = re.compile(r"\b(incline|high)\b", re.IGNORECASE)
_DECLINE_RE = re.compile(r"\b(decline|low cable crossover)\b", re.IGNORECASE)
_FLAT_RE = re.compile(r"\b(flat|bench press)\b", re.IGNORECASE)
_ROW_RE = re.compile(
    r"\b(row|rows|pulldown|pull[- ]?down|pullups?|pull[- ]?ups?|chinups?|chin[- ]?ups?)\b",
    re.IGNORECASE,
)
_DEADLIFT_RE = re.compile(r"\bdead.?lift\b", re.IGNORECASE)
_RDL_RE = re.compile(r"romanian|stiff.?leg|rdl", re.IGNORECASE)
_HIP_HINGE_RE = re.compile(r"hip.?thrust|glute.?bridge|kickback", re.IGNORECASE)
_SQUAT_RE = re.compile(r"\bsquat\b", re.IGNORECASE)


def _add_unique(out: list[str], *items: str) -> None:
    for it in items:
        if it and it not in out and it in EMPHASIS_TAGS:
            out.append(it)


def _rule_emphasis(name: str, primary: str, secondaries: Iterable[str]) -> list[str]:
    """Rule-based inference. Returns a list that may be empty.

    Each chunk is independent so the order of rule blocks doesn't
    matter — we just keep accumulating tags."""
    n = name.lower()
    sec_set = {s.lower() for s in secondaries}
    out: list[str] = []

    # ── Chest region splits ────────────────────────────────────────
    if primary == "chest" or "chest" in sec_set:
        if _INCLINE_RE.search(n):
            _add_unique(out, "upper_chest")
            # Most incline presses also recruit front delt heavily.
            if "shoulders" in sec_set or "press" in n or "fly" in n or "flyes" in n:
                _add_unique(out, "front_delt")
        elif _DECLINE_RE.search(n):
            _add_unique(out, "lower_chest")
        else:
            _add_unique(out, "mid_chest")
            if "press" in n and ("shoulders" in sec_set or "barbell" in n or "dumbbell" in n):
                _add_unique(out, "front_delt")

    # ── Back region splits ─────────────────────────────────────────
    if primary == "back" or "back" in sec_set:
        if _ROW_RE.search(n):
            _add_unique(out, "lats", "upper_back")
        elif "deadlift" in n or _DEADLIFT_RE.search(n):
            _add_unique(out, "lower_back")
        elif "pulldown" in n or "pull down" in n:
            _add_unique(out, "lats")
        # "Wide grip" variants emphasize lats more; "close grip" emphasizes
        # mid-back / biceps. Not perfect, but a reasonable default.
        if "wide grip" in n and ("pulldown" in n or "row" in n):
            _add_unique(out, "lats")

    # ── Shoulder region — overhead pressing patterns ───────────────
    if primary == "shoulders":
        if "press" in n:
            _add_unique(out, "front_delt", "side_delt")
        elif "raise" in n and "lateral" not in n and "rear" not in n and "front" not in n:
            # Ambiguous raise — leave to override.
            pass
        elif "shrug" in n:
            _add_unique(out, "traps")

    # ── Lower body ─────────────────────────────────────────────────
    if _RDL_RE.search(n) or "romanian" in n:
        _add_unique(out, "lower_back")
    if _HIP_HINGE_RE.search(n):
        # Glute-dominant hinges — primary_muscle should already say
        # glutes, but flag the lower-back co-engagement.
        if "thrust" in n or "bridge" in n:
            _add_unique(out, "lower_back")
    if "lunge" in n and "side" in n:
        _add_unique(out, "adductors")

    # ── Arms — brachialis triggers ─────────────────────────────────
    if "hammer" in n or "reverse curl" in n:
        _add_unique(out, "brachialis", "forearms")

    # ── Forearm-implicit work ──────────────────────────────────────
    # "carry" and "farmer's walk" are real grip-loaded movements.
    # Bare "grip" tokens ("close-grip bench", "wide-grip pulldown") are
    # describing hand position, not implying forearm work — overrides
    # handle the actual grip-emphasis exercises (wrist curl, pinch, etc).
    if "farmer" in n or "carry" in n:
        _add_unique(out, "forearms")

    # ── Pike / handstand push-ups — overhead-press kinematics ──────
    # Front delt + side delt dominant despite "push-up" wording.
    if "handstand" in n or "pike" in n:
        _add_unique(out, "front_delt", "side_delt")

    # ── Generic calf-raise fallback (catches Dumbbell Standing/Seated
    # Calf Raise variants not in the override table). Default to
    # gastrocnemius; explicit "seated" → soleus.
    if "calf raise" in n and not out:
        if "seated" in n:
            _add_unique(out, "soleus")
        else:
            _add_unique(out, "gastrocnemius")

    return out


# ─── Public entry point ──────────────────────────────────────────────────────

def infer_emphasis(
    name: str,
    primary_muscle: str | None,
    secondary_muscles: Iterable[str] | None = None,
) -> list[str]:
    """Return the fine-grained emphasis list for an exercise.

    Override > rule > empty list. The result preserves insertion
    order so the chip row reads consistently across runs."""
    if not name:
        return []
    secs = list(secondary_muscles or [])

    norm = _normalize_name(name)
    if norm in _OVERRIDES:
        return list(_OVERRIDES[norm])

    return _rule_emphasis(name, (primary_muscle or "").lower(), secs)
