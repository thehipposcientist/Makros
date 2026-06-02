"""Resolves seed exercises to free-exercise-db identifiers.

The free-exercise-db dataset (yuhonas/free-exercise-db) ships ~870
exercises, each with two photo frames showing the start and end
position of the lift. The frames double as a quick form preview
(static thumbnail) and a 2-frame "GIF" inside FormVideoModal.

Resolution runs at seed time, never at request time. The resolved id
is stored on Exercise.demo_exercise_db_id and read by the client to
build image URLs of the form

    https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/<id>/<n>.jpg

Strategy (in priority order):
  1. Exact normalized name match (handles ~70% of seeds in practice)
  2. Hand-curated overrides for common naming differences
  3. Match after stripping a trailing "- Medium Grip" / "- Wide Grip"
     style suffix from the dataset side
  4. Token-set Jaccard match above 0.85 — covers "Romanian Deadlift"
     vs "Barbell Romanian Deadlift" style mismatches

Returns None when no high-confidence match exists. The client falls
back to the YouTube thumbnail in that case, so a missing match is
graceful, not a hard error.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Iterable

_DATA_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "free_exercise_db.json"

# Hand-curated overrides where simple normalization fails. Keys are
# normalized seed exercise names; values are free-exercise-db ids.
# Add to this list as coverage gaps surface.
_OVERRIDES: dict[str, str] = {
    "deadlift": "Barbell_Deadlift",
    "squat": "Barbell_Squat",
    "barbell bench press": "Barbell_Bench_Press_-_Medium_Grip",
    # 2026-05 audit: pulled the missing `Wide-Grip_Barbell_Bench_Press`
    # asset from upstream (yuhonas/free-exercise-db) so we now have the
    # exact-grip demo.
    "wide grip bench press": "Wide-Grip_Barbell_Bench_Press",
    "close grip bench press": "Close-Grip_Barbell_Bench_Press",
    "incline barbell press": "Barbell_Incline_Bench_Press_-_Medium_Grip",
    "decline bench press": "Decline_Barbell_Bench_Press",
    "dumbbell bench press": "Dumbbell_Bench_Press",
    "incline dumbbell press": "Incline_Dumbbell_Press",
    "decline dumbbell press": "Decline_Dumbbell_Bench_Press",
    "pushups": "Pushups",
    "push ups": "Pushups",
    # 2026-05 audit: `Wide_Hand_Push_Up` folder missing AND diamond
    # push-ups are NARROW-grip, not wide — the prior mapping was both
    # broken and semantically wrong. Pushups is the closest bundled.
    "wide pushups": "Pushups",
    "diamond pushups": "Pushups",
    "decline push ups": "Decline_Push-Up",
    "pull ups": "Pullups",
    "pullups": "Pullups",
    "chin ups": "Chin-Up",
    "barbell back squat": "Barbell_Squat",
    "back squat": "Barbell_Squat",
    "front squat": "Front_Barbell_Squat",
    "goblet squat": "Goblet_Squat",
    # 2026-05 audit: was "Dumbbell_Bench_Step" — that asset folder
    # doesn't exist AND the bench-step demo would have shown the wrong
    # movement (ascent on a bench, not a split squat). `Split_Squat_with_
    # Dumbbells` is the same lower-body pattern and the folder is on disk.
    "bulgarian split squat": "Split_Squat_with_Dumbbells",
    "romanian deadlift": "Romanian_Deadlift",
    "barbell romanian deadlift": "Romanian_Deadlift",
    # 2026-05 audit: `Romanian_Deadlift_with_Dumbbells` is missing from
    # the bundled assets. `Stiff-Legged_Dumbbell_Deadlift` is the same
    # hinge with dumbbells (the dataset's name for the DB RDL pattern)
    # and is bundled.
    "dumbbell romanian deadlift": "Stiff-Legged_Dumbbell_Deadlift",
    "conventional deadlift": "Barbell_Deadlift",
    "barbell deadlift": "Barbell_Deadlift",
    # 2026-05 audit: pulled the missing `Sumo_Deadlift` asset from
    # upstream so we now have the exact stance-specific demo.
    "sumo deadlift": "Sumo_Deadlift",
    "trap bar deadlift": "Trap_Bar_Deadlift",
    "overhead press": "Standing_Military_Press",
    "barbell overhead press": "Standing_Military_Press",
    "military press": "Standing_Military_Press",
    "dumbbell shoulder press": "Seated_Dumbbell_Press",
    "seated dumbbell press": "Seated_Dumbbell_Press",
    "lateral raise": "Side_Lateral_Raise",
    "lateral raises": "Side_Lateral_Raise",
    "front raise": "Front_Dumbbell_Raise",
    "rear delt fly": "Reverse_Flyes",
    "barbell row": "Bent_Over_Barbell_Row",
    "bent over row": "Bent_Over_Barbell_Row",
    # 2026-05 audit: `Pendlay_Row` folder missing — `Bent_Over_Barbell_
    # Row` is the same movement (Pendlay is a strict from-the-floor BOR).
    "pendlay row": "Bent_Over_Barbell_Row",
    # 2026-05 audit: `Dumbbell_Bent_Over_Row` folder missing — the
    # one-arm row demo shows the same movement / cues / pattern.
    "dumbbell row": "One-Arm_Dumbbell_Row",
    "single arm dumbbell row": "One-Arm_Dumbbell_Row",
    "lat pulldown": "Wide-Grip_Lat_Pulldown",
    "seated cable row": "Seated_Cable_Rows",
    "tricep pushdown": "Triceps_Pushdown",
    "rope pushdown": "Tricep_Dumbbell_Kickback",
    "skull crushers": "Lying_Triceps_Press",
    "barbell curl": "Barbell_Curl",
    "dumbbell curl": "Dumbbell_Bicep_Curl",
    "hammer curl": "Hammer_Curls",
    "preacher curl": "Preacher_Curl",
    "leg press": "Leg_Press",
    "leg extension": "Leg_Extensions",
    "leg curl": "Lying_Leg_Curls",
    # 2026-05 audit: pulled the missing `Seated_Leg_Curl` asset from
    # upstream so the seated-machine variant uses its own demo.
    "seated leg curl": "Seated_Leg_Curl",
    "calf raise": "Standing_Barbell_Calf_Raise",
    "standing calf raise": "Standing_Barbell_Calf_Raise",
    "seated calf raise": "Seated_Calf_Raise",
    "hip thrust": "Barbell_Hip_Thrust",
    "barbell hip thrust": "Barbell_Hip_Thrust",
    # 2026-05 audit: `Glute_Bridge` folder missing — Single_Leg_Glute_
    # Bridge is a different movement (unilateral, harder cue), so we
    # remap to `Barbell_Hip_Thrust` which is the same posterior-chain
    # extension pattern just with load.
    "glute bridge": "Barbell_Hip_Thrust",
    "plank": "Plank",
    "side plank": "Side_Bridge",
    "russian twist": "Russian_Twist",
    "hanging leg raise": "Hanging_Leg_Raise",
    "ab wheel rollout": "Ab_Roller",
    "dumbbell fly": "Dumbbell_Flyes",
    "incline dumbbell fly": "Incline_Dumbbell_Flyes",
    "cable fly": "Cable_Crossover",
    "cable crossover": "Cable_Crossover",
    "face pull": "Face_Pull",
    "shrugs": "Barbell_Shrug",
    "barbell shrugs": "Barbell_Shrug",
    "dumbbell shrugs": "Dumbbell_Shrug",
    "good mornings": "Good_Morning",
    "lunges": "Dumbbell_Lunges",
    "walking lunges": "Dumbbell_Lunges",
    "step ups": "Dumbbell_Step_Ups",
    # 2026-05 audit: pulled the missing `Cable_One_Arm_Tricep_Extension`
    # asset from upstream — restoring the exact cable single-arm
    # extension demo instead of the generic pushdown stand-in.
    "tricep extension": "Cable_One_Arm_Tricep_Extension",
    "overhead tricep extension": "Standing_Dumbbell_Triceps_Extension",
    "dumbbell tricep kickbacks": "Tricep_Dumbbell_Kickback",
    "tricep kickback": "Tricep_Dumbbell_Kickback",
    "hip abduction machine": "Cable_Hip_Adduction",
    "hip adduction machine": "Cable_Hip_Adduction",
    "cable adduction": "Cable_Hip_Adduction",
    # No "tibialis raise" override on purpose — free-exercise-db only has
    # "Anterior Tibialis-SMR" (foam rolling the shin), which is the wrong
    # movement. Falling back to the YouTube demo beats a misleading photo.
    "back extension back focused": "Hyperextensions_Back_Extensions",
    "back extension glute focused": "Hyperextensions_Back_Extensions",
    "back extension": "Hyperextensions_Back_Extensions",
    "hyperextension": "Hyperextensions_Back_Extensions",
    "wide pushups": "Pushups",
    "wide push ups": "Pushups",
    "diamond push ups": "Pushups",
    "diamond pushups override": "Pushups",
    "pike push ups": "Pushups",
    "pike pushups": "Pushups",
    "scap pushup": "Pushups",
    "scap push up": "Pushups",
    "machine chest press": "Dumbbell_Bench_Press",
    "chest supported row": "Bent_Over_Barbell_Row",
    "machine shoulder press": "Seated_Dumbbell_Press",
    "arnold press": "Arnold_Dumbbell_Press",
    "upright row": "Upright_Barbell_Row",
    "barbell upright row": "Upright_Barbell_Row",
    "landmine press": "Landmine_Linear_Jammer",
    "landmine squat": "Front_Barbell_Squat",
    "wall sit": "Bodyweight_Squat",
    "wall slide": "Standing_Military_Press",
    "concentration curl": "Concentration_Curls",
    "cable curl": "Standing_Biceps_Cable_Curl",
    "skull crusher": "Lying_Triceps_Press",
    "skull crushers override": "Lying_Triceps_Press",
    "rope pushdown override": "Triceps_Pushdown",
    "rack pull": "Rack_Pulls",
    "rack pulls": "Rack_Pulls",
    "t bar row": "Lying_T-Bar_Row",
    "tbar row": "Lying_T-Bar_Row",
    # 2026-05 audit: `Thoracic_Rotation` folder missing and no good
    # bundled substitute. Falling back to the YouTube demo (no override)
    # beats a misleading photo, so we remove the override here. The
    # exact-match resolver also won't find it because the dataset entry
    # is "Spinal Stretch" which is a different movement.
    # "thoracic rotation": REMOVED — use YouTube demo
    "scapular pullup": "Scapular_Pull-Up",
    "scapular pull up": "Scapular_Pull-Up",
    "assisted pull up": "Band_Assisted_Pull-Up",
    "assisted pullup": "Band_Assisted_Pull-Up",
    # 2026-05 audit: `Sumo_Squat_With_Dumbbell` folder missing — the
    # `Goblet_Squat` demo shows the same wide-stance squat pattern,
    # close enough for cue/form reference until the sumo demo is added.
    "sumo squat": "Goblet_Squat",
    "goblet sumo squat": "Goblet_Squat",
    "superman hold": "Superman",
    "supermans": "Superman",
    "kettlebell swing": "One-Arm_Kettlebell_Swings",
    "kb swing": "One-Arm_Kettlebell_Swings",
    "thrusters": "Kettlebell_Thruster",
    "thruster": "Kettlebell_Thruster",
    "farmer carry": "Farmers_Walk",
    "farmer walk": "Farmers_Walk",
    "farmers walk": "Farmers_Walk",
    "suitcase carry": "Farmers_Walk",
    "med ball slam": "Overhead_Slam",
    "medicine ball slam": "Overhead_Slam",
    "ball slam": "Overhead_Slam",
    "jump squats": "Freehand_Jump_Squat",
    "jump squat": "Freehand_Jump_Squat",
    "weighted jump squat": "Weighted_Jump_Squat",
    "box jump": "Front_Box_Jump",
    "box jumps": "Front_Box_Jump",
    "broad jump": "Freehand_Jump_Squat",
    "trap bar jump": "Weighted_Jump_Squat",
    "reverse lunge": "Dumbbell_Lunges",
    "reverse lunges": "Dumbbell_Lunges",
    "side lunge": "Dumbbell_Lunges",
    "lateral lunge": "Dumbbell_Lunges",
    "cossack squat": "Bodyweight_Squat",
    "single leg deadlift": "Stiff-Legged_Dumbbell_Deadlift",
    "single leg romanian deadlift": "Stiff-Legged_Dumbbell_Deadlift",
    # 2026-05 audit: same Romanian_Deadlift_with_Dumbbells fix as above —
    # the bundled `Stiff-Legged_Dumbbell_Deadlift` is the closest in-frame
    # match for the B-stance RDL pattern.
    "b stance rdl": "Stiff-Legged_Dumbbell_Deadlift",
    "b stance squat": "Goblet_Squat",
    "push press": "Push_Press",
    "power clean": "Power_Clean",
    "hang clean": "Hang_Clean",
    # 2026-05 audit: pulled the missing `Clean_and_Press` asset from
    # upstream so the full clean → overhead press is shown.
    "clean and press": "Clean_and_Press",
    # 2026-05 audit: pulled the missing `Muscle_Snatch` asset from
    # upstream so muscle-snatch ≠ power-snatch can be distinguished.
    "snatch": "Power_Snatch",
    "muscle snatch": "Muscle_Snatch",
    # 2026-05 audit: pulled the missing `Clean_Pull` asset from upstream
    # so we now show the dedicated pull (no catch) demo.
    "high pull": "Clean_Pull",
    "clean pull": "Clean_Pull",
    "low to high cable fly": "Low_Cable_Crossover",
    "high to low cable fly": "Cable_Crossover",
    "single arm cable fly": "Single-Arm_Cable_Crossover",
    "neutral grip lat pulldown": "Close-Grip_Front_Lat_Pulldown",
    "iso lateral row": "One-Arm_Dumbbell_Row",
    "reverse pec deck": "Reverse_Flyes",
    "pec deck": "Cable_Crossover",
    "pectoral fly": "Cable_Crossover",
    "machine lateral raise": "Side_Lateral_Raise",
    "cable overhead tricep extension": "Cable_Rope_Overhead_Triceps_Extension",
    "single arm cable pushdown": "Triceps_Pushdown",
    "curtsy lunge": "Dumbbell_Lunges",
    # 2026-05 audit: `Step_ups_With_Bands` folder missing — the bundled
    # `Dumbbell_Step_Ups` shows the same lateral-step ascent pattern.
    "lateral step up": "Dumbbell_Step_Ups",
    "calf raise on leg press": "Calf_Press",
    "single leg box jump": "Front_Box_Jump",
    "med ball rotational throw": "Russian_Twist",
    "med ball chest pass": "Overhead_Slam",
    # 2026-05 audit: was `One-Arm_Side_Deadlift` — that's a side
    # deadlift (lateral spine flexion), not a snatch (explosive
    # hip-extension → overhead). Remap to `Power_Snatch`, the closest
    # bundled match for the snatch movement pattern.
    "dumbbell snatch": "Power_Snatch",
    "hanging knee raise": "Hanging_Leg_Raise",
    "toes to bar": "Hanging_Leg_Raise",
    "weighted plank": "Plank",
    "hollow body hold": "Plank",
    "hollow hold": "Plank",
    "weighted push up": "Pushups",
    "weighted pushups": "Pushups",
    # 2026-05 audit: pulled the missing `Zottman_Curl` asset from
    # upstream so the rotation-on-descent cue has its dedicated demo.
    "zottman curl": "Zottman_Curl",
    "zottman curls": "Zottman_Curl",
}

# Words that don't carry exercise identity. Stripped before matching so
# "Single-Arm Dumbbell Row" reduces to {"dumbbell", "row"} which actually
# matches dataset entries.
_NOISE_TOKENS = {
    "the", "a", "an",
    "single", "one", "two",
    "left", "right",
    "with", "for", "and",
    "exercise", "version",
    "alternating",
    "hold",  # "Superman Hold" → "Superman"
}

# Token canonicalization — folds equivalent forms together.
_TOKEN_ALIASES: dict[str, str] = {
    "skullcrusher": "skullcrushers",
    "skullcrushers": "skullcrushers",
    "crusher": "skullcrushers",
    "crushers": "skullcrushers",
    "pushup": "pushups",
    "pushups": "pushups",
    "pullup": "pullups",
    "pullups": "pullups",
    "chinup": "chinups",
    "chinups": "chinups",
    "situp": "situps",
    "situps": "situps",
    "fly": "flies",
    "flys": "flies",
    "flyes": "flies",
    "flies": "flies",
    "raise": "raises",
    "raises": "raises",
    "row": "rows",
    "rows": "rows",
    "press": "press",
    "lunge": "lunges",
    "lunges": "lunges",
    "extension": "extensions",
    "extensions": "extensions",
    "curl": "curls",
    "curls": "curls",
    "shrug": "shrugs",
    "shrugs": "shrugs",
}


def _normalize(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _canonical_token(t: str) -> str:
    if t in _TOKEN_ALIASES:
        return _TOKEN_ALIASES[t]
    # Generic plural strip (only for tokens >3 chars, doesn't hit "press").
    if len(t) > 3 and t.endswith("s") and not t.endswith("ss"):
        stem = t[:-1]
        if stem in _TOKEN_ALIASES:
            return _TOKEN_ALIASES[stem]
    return t


def _tokens(s: str) -> set[str]:
    raw = [t for t in _normalize(s).split() if t and len(t) > 1]
    out: set[str] = set()
    for t in raw:
        if t in _NOISE_TOKENS:
            continue
        out.add(_canonical_token(t))
    return out


@lru_cache(maxsize=1)
def _index() -> tuple[dict[str, str], list[tuple[str, set[str]]]]:
    """Returns (normalized_name → id, [(id, token_set), ...]).

    The first map handles exact matches; the second list backs the
    fuzzy fallback. We cache once per process — the manifest is ~1MB
    and parsing it on every call would dominate seed time."""
    if not _DATA_PATH.exists():
        return {}, []
    with _DATA_PATH.open() as f:
        data = json.load(f)
    by_name: dict[str, str] = {}
    tokens_list: list[tuple[str, set[str]]] = []
    for entry in data:
        ex_id = entry.get("id")
        name = entry.get("name") or ""
        if not ex_id or not name:
            continue
        norm = _normalize(name)
        by_name[norm] = ex_id
        tokens_list.append((ex_id, _tokens(name)))
    return by_name, tokens_list


_GRIP_SUFFIX_RE = re.compile(r"\s*-\s*(medium|wide|narrow|close|reverse)\s*grip\s*$", re.IGNORECASE)


def resolve_demo_db_id(seed_name: str) -> str | None:
    """Best-effort match for a seed exercise name → free-exercise-db id.

    Strategy in priority order: exact normalized match → override
    table → seed tokens contained in dataset entry (preferring the
    entry with fewest extra tokens) → dataset tokens contained in
    seed (for "Single-Arm Dumbbell Row" → "Dumbbell Row" cases).
    Anything below the containment threshold returns None — better
    no demo than a wrong-exercise demo."""
    if not seed_name:
        return None
    norm = _normalize(seed_name)

    if norm in _OVERRIDES:
        return _OVERRIDES[norm]

    by_name, tokens_list = _index()
    if not by_name:
        return None

    if norm in by_name:
        return by_name[norm]

    # Strip grip suffix from dataset side and re-check exact.
    for ds_norm, ex_id in by_name.items():
        if _GRIP_SUFFIX_RE.search(ds_norm.replace("_", " ")):
            stripped = _normalize(_GRIP_SUFFIX_RE.sub("", ds_norm))
            if stripped == norm:
                return ex_id

    seed_toks = _tokens(seed_name)
    if not seed_toks:
        return None

    # Containment match: seed_toks ⊆ ds_toks. Pick the dataset entry
    # with the fewest extra tokens (the most specific generic).
    # Require at least 2 seed tokens or an exact 1-token unique match
    # to avoid collapsing every "Squat" exercise onto a single demo.
    best_subset: tuple[int, str | None] = (10**6, None)
    for ex_id, ds_toks in tokens_list:
        if seed_toks and seed_toks.issubset(ds_toks):
            extras = len(ds_toks) - len(seed_toks)
            if extras < best_subset[0]:
                best_subset = (extras, ex_id)
    if best_subset[1] and (len(seed_toks) >= 2 or best_subset[0] == 0):
        return best_subset[1]

    # Reverse containment: ds_toks ⊆ seed_toks. Useful when seed name
    # is more specific than the dataset (e.g. "Single-Arm Dumbbell Row"
    # → "Dumbbell Row"). Same fewest-extras tie-break.
    best_super: tuple[int, str | None] = (10**6, None)
    for ex_id, ds_toks in tokens_list:
        if ds_toks and len(ds_toks) >= 2 and ds_toks.issubset(seed_toks):
            extras = len(seed_toks) - len(ds_toks)
            if extras < best_super[0]:
                best_super = (extras, ex_id)
    if best_super[1] and best_super[0] <= 2:
        return best_super[1]

    # Last-ditch Jaccard fallback for partial overlaps. Keeping the
    # threshold high — false positives are worse than no match here,
    # since a wrong-exercise demo actively misleads the user.
    best_jacc: tuple[float, str | None] = (0.0, None)
    for ex_id, ds_toks in tokens_list:
        union = len(seed_toks | ds_toks)
        if not union:
            continue
        score = len(seed_toks & ds_toks) / union
        if score > best_jacc[0]:
            best_jacc = (score, ex_id)
    if best_jacc[0] >= 0.75:
        return best_jacc[1]
    return None


def coverage_report(seed_names: Iterable[str]) -> dict:
    """Run resolve_demo_db_id over a list of seed names and return a
    summary. Useful as a smoke test before committing the resolver."""
    matched: list[tuple[str, str]] = []
    missed: list[str] = []
    for name in seed_names:
        m = resolve_demo_db_id(name)
        if m:
            matched.append((name, m))
        else:
            missed.append(name)
    total = len(matched) + len(missed)
    return {
        "total": total,
        "matched": len(matched),
        "missed": len(missed),
        "coverage_pct": round(100 * len(matched) / total, 1) if total else 0.0,
        "missed_names": missed,
        "matched_pairs": matched,
    }
