"""
Algorithmic workout planner — replaces AI-driven plan generation for the
common case with deterministic, history-aware Python logic.

Read this file in order. Each layer is its own named section so you can
audit the math top-to-bottom without jumping around:

    Layer 1 — Input normalization        (PlannerInputs)
    Layer 2 — Split selection            (pick_split)
    Layer 3 — Weekly volume targets      (weekly_set_targets)
    Layer 4 — Day templates              (build_day_templates)
    Layer 5 — Exercise selection engine  (filter_candidates, score_candidate,
                                          pick_for_slot)
    Layer 6 — Prescription assembler     (prescribe_sets_reps)
    Layer 7 — Top-level orchestrator     (generate_workout_plan)

The orchestrator returns a dict in the SAME shape `_call_workout_ai` used
to produce, so plans.py can swap one call for the other without touching
downstream consumers.

What this file is NOT:
- It is not the in-workout set-by-set progression engine. That lives in
  `app/workout_progression.py` and handles "you just hit 8/8/8 — add load
  next set". The planner here decides what exercises and what targets
  the next session should have; the progression engine handles execution.
- It is not the session-to-session adaptation layer. That's Phase 2 —
  see `propose_session_targets_from_history` placeholder at the bottom.

What stays AI in the new world:
- The `trainerNote` (cheap, high value, one paragraph)
- Trainer chat ("make Wednesday harder")
- Anything outside this planner's structured output

What is now algorithmic:
- Split selection
- Weekly volume targets per muscle / goal / experience
- Day-level slot templates
- Exercise selection per slot (filtered + scored, never random)
- Sets / reps / rest / RIR prescriptions
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Iterable

# ─── Layer 1 — Inputs ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlannerInputs:
    """Everything the planner needs to produce a plan.

    Designed so callers can either build it from a `PlanRequest` (the
    existing API model) or construct it directly in tests.
    """
    goal: str                              # "muscle_gain" | "fat_loss" | "strength" | "body_recomp" | ...
    days_per_week: int                     # 1..7
    session_minutes: int = 60              # rough budget per session
    experience: str = "intermediate"       # "beginner" | "intermediate" | "advanced"
    equipment_slugs: tuple[str, ...] = ()  # owned Equipment slugs
    preferred_split: str | None = None     # "auto" | "full_body" | "upper_lower" | "ppl" | "bro"
    focused_muscle: str | None = None      # optional emphasis (e.g. "glutes")
    preferred_exercises: tuple[str, ...] = ()
    disliked_exercises: tuple[str, ...] = ()
    injuries: tuple[str, ...] = ()
    # Seed for deterministic tie-breaking on candidate selection. Pass a
    # stable per-user value (e.g. user_id) to keep plans consistent across
    # regenerations when nothing else has changed.
    rng_seed: int = 0


# ─── Layer 2 — Split selection ───────────────────────────────────────────────


# Available splits in the planner's vocabulary. Keep this short — every
# split needs a corresponding day-template definition in Layer 4.
SPLIT_FULL_BODY = "full_body"
SPLIT_UPPER_LOWER = "upper_lower"
SPLIT_PPL = "ppl"                  # push / pull / legs
SPLIT_BRO = "bro"                  # chest / back / shoulders / arms / legs
SPLIT_PPL_UL = "ppl_upper_lower"   # 5-day hybrid

# Goal-specific split preferences. Each list is ordered by preference.
# When days_per_week constrains the choice we walk the list and pick the
# first one that has enough days.
_GOAL_SPLIT_PRIORITY = {
    "strength":     [SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL_UL, SPLIT_PPL],
    "muscle_gain":  [SPLIT_PPL, SPLIT_BRO, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY],
    "body_recomp":  [SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_FULL_BODY],
    "fat_loss":     [SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL],
    "athletic_performance": [SPLIT_UPPER_LOWER, SPLIT_FULL_BODY, SPLIT_PPL],
    "general_health": [SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL],
}

# Minimum days a split needs to make sense.
_SPLIT_MIN_DAYS = {
    SPLIT_FULL_BODY:   1,
    SPLIT_UPPER_LOWER: 2,
    SPLIT_PPL:         3,
    SPLIT_BRO:         5,
    SPLIT_PPL_UL:      5,
}


def _goal_bucket(goal: str) -> str:
    """Map any goal id to one of the planner's known buckets. Falls back
    to general_health for unknown goals so the planner always has a valid
    preference list."""
    g = (goal or "").lower()
    fat_loss_ids = {"fat_loss", "lose_fat", "cut", "get_lean", "toning"}
    muscle_ids = {"muscle_gain", "build_muscle", "lean_bulk", "improve_aesthetics", "build_glutes"}
    strength_ids = {"strength", "build_strength", "powerlifting", "improve_1rm"}
    if g in fat_loss_ids: return "fat_loss"
    if g in muscle_ids: return "muscle_gain"
    if g in strength_ids: return "strength"
    if g == "body_recomp": return "body_recomp"
    if "athletic" in g or "sport" in g: return "athletic_performance"
    return "general_health"


def pick_split(inputs: PlannerInputs) -> str:
    """Choose a training split.

    Beginners and 1-2 day weeks always full-body regardless of goal. From
    3 days up we walk the goal-specific preference list and pick the first
    split that fits the day count.
    """
    if inputs.preferred_split and inputs.preferred_split != "auto":
        if _SPLIT_MIN_DAYS.get(inputs.preferred_split, 99) <= inputs.days_per_week:
            return inputs.preferred_split

    if inputs.experience == "beginner" or inputs.days_per_week <= 2:
        return SPLIT_FULL_BODY if inputs.days_per_week <= 2 else SPLIT_FULL_BODY

    bucket = _goal_bucket(inputs.goal)
    priority = _GOAL_SPLIT_PRIORITY.get(bucket, _GOAL_SPLIT_PRIORITY["general_health"])
    for split in priority:
        if _SPLIT_MIN_DAYS[split] <= inputs.days_per_week:
            return split
    return SPLIT_FULL_BODY


# ─── Layer 3 — Weekly volume targets ─────────────────────────────────────────


# Sets per muscle group per week. Chosen to land in the "MEV+" range from
# Renaissance Periodization volume landmarks — enough to drive growth
# without leaving beginners or fat-loss users buried in junk volume.
#
# Indexed by (goal_bucket, experience). Numbers are TARGET working sets
# per week for the listed muscle. Slot-based selection in Layer 4-5 will
# distribute these across days; the volume target acts as a sanity bound.
_WEEKLY_VOLUME: dict[tuple[str, str], dict[str, int]] = {
    ("muscle_gain", "beginner"): {
        "chest": 10, "back": 12, "shoulders": 8, "biceps": 6, "triceps": 6,
        "quads": 10, "hamstrings": 8, "glutes": 8, "calves": 6, "core": 6,
    },
    ("muscle_gain", "intermediate"): {
        "chest": 14, "back": 16, "shoulders": 12, "biceps": 10, "triceps": 10,
        "quads": 14, "hamstrings": 12, "glutes": 12, "calves": 8, "core": 6,
    },
    ("muscle_gain", "advanced"): {
        "chest": 18, "back": 20, "shoulders": 14, "biceps": 12, "triceps": 12,
        "quads": 16, "hamstrings": 14, "glutes": 14, "calves": 10, "core": 6,
    },
    ("strength", "beginner"): {
        "chest": 8, "back": 10, "shoulders": 6, "biceps": 4, "triceps": 6,
        "quads": 10, "hamstrings": 8, "glutes": 8, "calves": 4, "core": 6,
    },
    ("strength", "intermediate"): {
        "chest": 10, "back": 12, "shoulders": 8, "biceps": 6, "triceps": 8,
        "quads": 12, "hamstrings": 10, "glutes": 10, "calves": 6, "core": 8,
    },
    ("strength", "advanced"): {
        "chest": 12, "back": 14, "shoulders": 10, "biceps": 8, "triceps": 10,
        "quads": 14, "hamstrings": 12, "glutes": 12, "calves": 6, "core": 8,
    },
    ("fat_loss", "beginner"): {
        "chest": 8, "back": 10, "shoulders": 6, "biceps": 4, "triceps": 4,
        "quads": 10, "hamstrings": 8, "glutes": 8, "calves": 4, "core": 8,
    },
    ("fat_loss", "intermediate"): {
        "chest": 10, "back": 12, "shoulders": 8, "biceps": 6, "triceps": 6,
        "quads": 12, "hamstrings": 10, "glutes": 10, "calves": 6, "core": 8,
    },
    ("fat_loss", "advanced"): {
        "chest": 12, "back": 14, "shoulders": 10, "biceps": 8, "triceps": 8,
        "quads": 14, "hamstrings": 12, "glutes": 12, "calves": 6, "core": 8,
    },
    ("body_recomp", "beginner"): {
        "chest": 10, "back": 12, "shoulders": 8, "biceps": 6, "triceps": 6,
        "quads": 12, "hamstrings": 10, "glutes": 10, "calves": 6, "core": 6,
    },
    ("body_recomp", "intermediate"): {
        "chest": 12, "back": 14, "shoulders": 10, "biceps": 8, "triceps": 8,
        "quads": 14, "hamstrings": 12, "glutes": 12, "calves": 8, "core": 6,
    },
    ("body_recomp", "advanced"): {
        "chest": 14, "back": 16, "shoulders": 12, "biceps": 10, "triceps": 10,
        "quads": 14, "hamstrings": 12, "glutes": 12, "calves": 8, "core": 6,
    },
}

# Default fallback for any (bucket, experience) combo not explicitly
# tabulated above. Mirrors the "general_health" intermediate band.
_DEFAULT_VOLUME = {
    "chest": 12, "back": 14, "shoulders": 10, "biceps": 8, "triceps": 8,
    "quads": 12, "hamstrings": 10, "glutes": 10, "calves": 6, "core": 6,
}


def weekly_set_targets(inputs: PlannerInputs) -> dict[str, int]:
    """Return a {muscle: target_working_sets_per_week} dict for this user.

    Adds a +30% bonus to the user's `focused_muscle` if set, capped at the
    next-experience-level value to avoid runaway volume.
    """
    bucket = _goal_bucket(inputs.goal)
    base = _WEEKLY_VOLUME.get((bucket, inputs.experience), _DEFAULT_VOLUME).copy()
    if inputs.focused_muscle and inputs.focused_muscle in base:
        base[inputs.focused_muscle] = round(base[inputs.focused_muscle] * 1.3)
    return base


# ─── Layer 4 — Day templates ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Slot:
    """One slot in a day template — a movement pattern + role + muscle hint.

    The selection engine in Layer 5 fills each slot from the user's
    eligible exercise pool by matching `movement_pattern` and using
    `primary_muscle_hint` to break ties.
    """
    label: str                           # human-readable, e.g. "Primary Press"
    movement_pattern: str                # matches Exercise.movement_pattern
    primary_muscle_hint: str | None      # preferred primary_muscle for tie-break
    role: str                            # "primary" | "secondary" | "isolation" | "core"


def _full_body_day(day_name: str, day_index: int) -> tuple[str, list[Slot]]:
    """Full-body day. Slight rotation across days so consecutive sessions
    don't hit the exact same exercises."""
    if day_index % 3 == 0:
        return day_name, [
            Slot("Squat Pattern",     "squat",            "quads",       "primary"),
            Slot("Horizontal Press",  "horizontal_press", "chest",       "primary"),
            Slot("Horizontal Pull",   "horizontal_pull",  "back",        "primary"),
            Slot("Hinge Accessory",   "hinge",            "hamstrings",  "secondary"),
            Slot("Core",              "anti_extension",   "core",        "core"),
        ]
    if day_index % 3 == 1:
        return day_name, [
            Slot("Hinge Pattern",     "hinge",            "hamstrings",  "primary"),
            Slot("Vertical Press",    "vertical_press",   "shoulders",   "primary"),
            Slot("Vertical Pull",     "vertical_pull",    "back",        "primary"),
            Slot("Lunge / Single-leg","lunge",            "quads",       "secondary"),
            Slot("Core",              "anti_extension",   "core",        "core"),
        ]
    return day_name, [
        Slot("Squat Pattern",     "squat",            "quads",       "primary"),
        Slot("Horizontal Press",  "horizontal_press", "chest",       "secondary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",        "primary"),
        Slot("Hinge",             "hinge",            "glutes",      "secondary"),
        Slot("Core",              "anti_extension",   "core",        "core"),
    ]


def _upper_day(day_name: str) -> tuple[str, list[Slot]]:
    return day_name, [
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Primary Pull",      "horizontal_pull",  "back",      "primary"),
        Slot("Vertical Press",    "vertical_press",   "shoulders", "secondary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",      "secondary"),
        Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
        Slot("Biceps",            "isolation",        "biceps",    "isolation"),
        Slot("Triceps",           "isolation",        "triceps",   "isolation"),
    ]


def _lower_day(day_name: str) -> tuple[str, list[Slot]]:
    return day_name, [
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Single-leg",        "lunge",            "quads",      "secondary"),
        Slot("Hamstring Accessory","isolation",       "hamstrings", "isolation"),
        Slot("Calves",            "isolation",        "calves",     "isolation"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


def _push_day(day_name: str) -> tuple[str, list[Slot]]:
    return day_name, [
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Vertical Press",    "vertical_press",   "shoulders", "primary"),
        Slot("Secondary Press",   "horizontal_press", "chest",     "secondary"),
        Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
        Slot("Triceps Compound",  "isolation",        "triceps",   "isolation"),
        Slot("Triceps Isolation", "isolation",        "triceps",   "isolation"),
    ]


def _pull_day(day_name: str) -> tuple[str, list[Slot]]:
    return day_name, [
        Slot("Vertical Pull",     "vertical_pull",    "back",   "primary"),
        Slot("Horizontal Pull",   "horizontal_pull",  "back",   "primary"),
        Slot("Secondary Pull",    "horizontal_pull",  "back",   "secondary"),
        Slot("Rear Delt",         "isolation",        "shoulders", "isolation"),
        Slot("Bicep Curl",        "isolation",        "biceps", "isolation"),
        Slot("Bicep Variation",   "isolation",        "biceps", "isolation"),
    ]


def _legs_day(day_name: str) -> tuple[str, list[Slot]]:
    return day_name, [
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Single-leg",        "lunge",            "quads",      "secondary"),
        Slot("Hamstring Accessory","isolation",       "hamstrings", "isolation"),
        Slot("Calves",            "isolation",        "calves",     "isolation"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


def build_day_templates(split: str, days_per_week: int) -> list[tuple[str, list[Slot]]]:
    """Return a list of (day_name, slots) for the chosen split.

    Day count is exactly `days_per_week`. Splits with cycle lengths that
    don't divide evenly into `days_per_week` repeat from the start (e.g.
    PPL on 4 days = Push, Pull, Legs, Push).
    """
    if split == SPLIT_FULL_BODY:
        return [_full_body_day(f"Day {i+1}", i) for i in range(days_per_week)]

    if split == SPLIT_UPPER_LOWER:
        cycle = [_upper_day("Upper"), _lower_day("Lower")]
        return [
            (f"{cycle[i % 2][0]} {1 + i // 2}", cycle[i % 2][1])
            for i in range(days_per_week)
        ]

    if split == SPLIT_PPL:
        cycle = [_push_day("Push"), _pull_day("Pull"), _legs_day("Legs")]
        return [
            (f"{cycle[i % 3][0]} {1 + i // 3}", cycle[i % 3][1])
            for i in range(days_per_week)
        ]

    if split == SPLIT_PPL_UL:
        # 5-day hybrid — PPL then upper/lower
        days = [
            _push_day("Push"),
            _pull_day("Pull"),
            _legs_day("Legs"),
            _upper_day("Upper"),
            _lower_day("Lower"),
        ]
        return days[:days_per_week]

    if split == SPLIT_BRO:
        # Chest / Back / Shoulders / Arms / Legs
        days = [
            ("Chest", [
                Slot("Primary Press",    "horizontal_press", "chest", "primary"),
                Slot("Incline Press",    "horizontal_press", "chest", "secondary"),
                Slot("Chest Fly",        "isolation",        "chest", "isolation"),
                Slot("Tricep Compound",  "isolation",        "triceps", "isolation"),
                Slot("Tricep Isolation", "isolation",        "triceps", "isolation"),
            ]),
            ("Back", [
                Slot("Vertical Pull",    "vertical_pull",   "back",  "primary"),
                Slot("Horizontal Pull",  "horizontal_pull", "back",  "primary"),
                Slot("Secondary Row",    "horizontal_pull", "back",  "secondary"),
                Slot("Rear Delt",        "isolation",       "shoulders", "isolation"),
                Slot("Bicep Curl",       "isolation",       "biceps", "isolation"),
            ]),
            ("Shoulders", [
                Slot("Vertical Press",   "vertical_press",  "shoulders", "primary"),
                Slot("Lateral Raise",    "isolation",       "shoulders", "isolation"),
                Slot("Rear Delt Fly",    "isolation",       "shoulders", "isolation"),
                Slot("Upright Row",      "vertical_pull",   "shoulders", "secondary"),
                Slot("Shrug",            "isolation",       "traps",     "isolation"),
            ]),
            ("Arms", [
                Slot("Bicep Curl",       "isolation", "biceps", "primary"),
                Slot("Tricep Press",     "isolation", "triceps", "primary"),
                Slot("Hammer Curl",      "isolation", "biceps", "secondary"),
                Slot("Overhead Tri",     "isolation", "triceps", "secondary"),
            ]),
            ("Legs", _legs_day("Legs")[1]),
        ]
        return days[:days_per_week]

    return [_full_body_day(f"Day {i+1}", i) for i in range(days_per_week)]


# ─── Layer 5 — Exercise selection engine ─────────────────────────────────────


def _equipment_satisfied(exercise: dict, owned: set[str]) -> bool:
    """True if the user can actually do this exercise with what they own.

    Two modes:
      - Bodyweight bucket: always allowed (push-ups need nothing).
      - Anything else: every `required=True` equipment slug must be owned
        AND at least one of the exercise's primary equipment slugs must
        be owned (so a "dumbbells" bucket exercise where the dumbbell is
        `required=False` doesn't sneak through for an empty-equipment user).
    """
    eq_entries = exercise.get("equipment") or []
    bucket = exercise.get("equipment_bucket")

    # Bodyweight bucket is always eligible regardless of what the user owns.
    if bucket == "bodyweight":
        # Still respect any required support equipment if present
        # (e.g. decline_pushups requires plyo_box). Required gates win.
        required = [e["slug"] for e in eq_entries if e.get("required")]
        return all(s in owned for s in required)

    # Non-bodyweight bucket: every required slug must be owned AND the
    # user must own SOMETHING from the primary slugs so we don't
    # recommend a "Dumbbell Squat" to a user with zero dumbbells.
    # Also: if the user owns no equipment AT ALL, no non-bodyweight
    # bucket exercise is eligible — even ones with empty equipment lists
    # like "Chair Step-up" (bucket=home), because the bucket itself
    # signals the user needs something we don't model as a slug.
    if not owned:
        return False
    required = [e["slug"] for e in eq_entries if e.get("required")]
    primary_slugs = [e["slug"] for e in eq_entries if e.get("role") == "primary"]
    if required and not all(s in owned for s in required):
        return False
    if primary_slugs and not any(s in owned for s in primary_slugs):
        return False
    return True


def filter_candidates(
    all_exercises: list[dict],
    slot: Slot,
    owned_equipment: set[str],
    disliked_set: set[str],
) -> list[dict]:
    """Return every exercise eligible for this slot.

    Filters:
      1. Equipment satisfied
      2. Movement pattern matches the slot
      3. Primary muscle compatible with slot hint (when slot specifies
         a hint AND the slot is an isolation slot — compounds get to
         bleed across muscles)
      4. Not in the user's disliked set
      5. Not a mobility-only or low-power-type exercise (we don't put
         a rotator-cuff prehab move in a strength slot)
    """
    out: list[dict] = []
    for ex in all_exercises:
        if (ex.get("name") or "").lower() in disliked_set:
            continue
        if ex.get("exercise_type") in ("mobility",):
            continue
        if ex.get("power_type") in ("mobility",):
            continue
        if not _equipment_satisfied(ex, owned_equipment):
            continue
        mp = ex.get("movement_pattern")
        if mp != slot.movement_pattern:
            continue
        # For isolation slots with a muscle hint, also require the
        # primary muscle to match. Compounds skip this — a horizontal
        # press slot accepts bench press even though its primary is chest
        # but the slot hint is also chest.
        if slot.role == "isolation" and slot.primary_muscle_hint:
            if ex.get("primary_muscle") != slot.primary_muscle_hint:
                continue
        out.append(ex)
    return out


# Goal buckets that should feel "lift-focused". For these, bodyweight is
# a fallback, not a default — the scorer and pick_for_slot both collapse
# bodyweight picks below loaded picks on primary/secondary slots.
_LIFT_FOCUSED_BUCKETS = {"body_recomp", "muscle_gain", "strength"}

# Ordered primary-load preference. Barbell beats dumbbell beats machine
# beats cable beats bodyweight when all are otherwise equal. Used as a
# small tie-breaker INSIDE the loaded pool; the hard gate between loaded
# and bodyweight lives in `pick_for_slot`.
_PRIMARY_LOAD_TIER = {
    "barbell": 4,
    "ez_curl_bar": 4,
    "trap_bar": 4,
    "dumbbells": 3,
    "kettlebell": 3,
    # Machines / cable
    "leg_press_machine": 2,
    "chest_press_machine": 2,
    "lat_pulldown_machine": 2,
    "seated_row_machine": 2,
    "smith_machine": 2,
    "hack_squat_machine": 2,
    "machine_row_station": 2,
    "pec_deck_machine": 2,
    "leg_extension_machine": 2,
    "leg_curl_machine": 2,
    "shoulder_press_machine": 2,
    "cable_machine": 1,
}


def _exercise_load_tier(exercise: dict) -> int:
    """Return 0 for bodyweight-bucket exercises, or the best
    `_PRIMARY_LOAD_TIER` value found among the exercise's equipment
    entries. Used both for the tier-split in `pick_for_slot` and for
    scoring's load-preference term."""
    if exercise.get("equipment_bucket") == "bodyweight":
        return 0
    best = 0
    for e in exercise.get("equipment") or []:
        if e.get("role") != "primary":
            continue
        t = _PRIMARY_LOAD_TIER.get(e.get("slug", ""), 0)
        if t > best:
            best = t
    return best


def score_candidate(
    exercise: dict,
    slot: Slot,
    inputs: PlannerInputs,
    used_substitution_groups: set[str],
    used_exercise_slugs: set[str],
    history_familiarity: dict[str, int] | None = None,
) -> float:
    """Score one candidate for one slot. Higher is better.

    The scoring is intentionally simple and additive so it stays
    debuggable. Each component is documented.
    """
    score = 0.0
    name_lower = (exercise.get("name") or "").lower()
    bucket = _goal_bucket(inputs.goal)
    is_lift_focused = bucket in _LIFT_FOCUSED_BUCKETS
    is_bodyweight = exercise.get("equipment_bucket") == "bodyweight"

    # 1. Preference bonus — preferred exercises get a strong push.
    if name_lower in {p.lower() for p in inputs.preferred_exercises}:
        score += 5.0

    # 2. Slot-role match.
    role = slot.role
    is_compound = exercise.get("is_compound", False)
    if role == "primary" and is_compound:
        score += 3.0
    elif role == "secondary" and is_compound:
        score += 1.5
    elif role == "isolation" and not is_compound:
        score += 2.0
    elif role == "core":
        # Core slot is fine with whatever the slot's pattern accepts.
        score += 1.0

    # 3. Difficulty match against experience.
    diff = exercise.get("difficulty", "intermediate")
    exp = inputs.experience
    if exp == "beginner":
        if diff == "beginner":
            score += 2.0
        elif diff == "advanced":
            score -= 3.0
    elif exp == "advanced":
        if diff == "advanced":
            score += 1.0
        elif diff == "beginner":
            score -= 0.5
    else:
        if diff == "intermediate":
            score += 1.0

    # 4. Primary muscle hint match (light bonus, even for compounds).
    if slot.primary_muscle_hint and exercise.get("primary_muscle") == slot.primary_muscle_hint:
        score += 1.0

    # 5. Variety / continuity within the same plan. Penalize repeating
    # the same substitution group within one week (variety) and the same
    # exact exercise slug across days (no carbon copies).
    sub_group = exercise.get("substitution_group")
    if sub_group and sub_group in used_substitution_groups:
        score -= 1.5
    if exercise.get("slug") in used_exercise_slugs:
        score -= 4.0

    # 6. Load-preference for lift-focused goals. This replaces the old
    # "free-weight primary bonus" with something explicit and larger so
    # that a Barbell Squat can't lose to a Bodyweight Squat by random
    # jitter on a recomp / muscle-gain / strength plan.
    #
    #   is_lift_focused AND primary/secondary slot:
    #     +3.0 loaded      (enough to clear compound-tie margin)
    #     -4.0 bodyweight  (pushes BW below any loaded candidate)
    #     tier bonus 0.1 × tier for fine-grained barbell > DB > cable
    #   is_lift_focused AND isolation slot:
    #     +1.5 loaded / -1.5 bodyweight
    #     (smaller, because isolation bodyweight can still be valid —
    #      e.g. bodyweight calf raise — but loaded still wins ties)
    #   not lift-focused (fat_loss / general_health / minimal equipment):
    #     no penalty — bodyweight is fine when it fits the goal
    if is_lift_focused and role in ("primary", "secondary"):
        if is_bodyweight:
            score -= 4.0
        else:
            score += 3.0
            score += 0.1 * _exercise_load_tier(exercise)
    elif is_lift_focused and role == "isolation":
        if is_bodyweight:
            score -= 1.5
        else:
            score += 1.5
            score += 0.05 * _exercise_load_tier(exercise)
    else:
        # Preserve the old light "free-weight primary" bonus for the
        # non-lift-focused goals so behavior there is unchanged.
        if role == "primary" and not exercise.get("is_machine", False):
            score += 0.5

    # 7. Familiarity bonus from history. A user who has logged this
    # exercise recently gets continuity — we don't shuffle their plan
    # for novelty's sake. Capped so unfamiliar exercises can still win
    # on other criteria.
    if history_familiarity:
        familiar = history_familiarity.get(exercise.get("slug", ""), 0)
        if familiar > 0:
            score += min(2.0, 0.5 * familiar)

    # 8. Tiny deterministic jitter so ties between two equivalent
    # candidates don't always pick the alphabetically-first one. Seeded
    # by the user so the same user gets the same plan on repeat
    # generations when nothing else has changed.
    rng = random.Random(inputs.rng_seed + hash(exercise.get("slug", "")))
    score += rng.random() * 0.1

    return score


def pick_for_slot(
    all_exercises: list[dict],
    slot: Slot,
    inputs: PlannerInputs,
    used_substitution_groups: set[str],
    used_exercise_slugs: set[str],
    history_familiarity: dict[str, int] | None = None,
) -> dict | None:
    """Pick the best exercise for one slot. Returns None if no candidate
    survives the filter.

    Tier-split rule:
      For lift-focused goals (body_recomp, muscle_gain, strength) on
      primary/secondary slots, loaded candidates and bodyweight
      candidates are scored separately. The loaded pool is tried first.
      Bodyweight only wins when the loaded pool is empty (e.g. the user
      legitimately has no equipment). This guarantees a recomp user with
      a full gym never gets "Bodyweight Squat" on their primary slot
      just because the scoring margin was a jitter coin-flip.

    For isolation/core slots — and for non-lift-focused goals like
    fat_loss / general_health — the pool is NOT split; bodyweight and
    loaded compete on score alone, because those contexts legitimately
    allow bodyweight picks (bodyweight calf raise, planks, etc.).
    """
    owned = set(inputs.equipment_slugs)
    disliked = {d.lower() for d in inputs.disliked_exercises}
    candidates = filter_candidates(all_exercises, slot, owned, disliked)
    if not candidates:
        return None

    def _best_of(pool: list[dict]) -> dict | None:
        if not pool:
            return None
        scored = [
            (score_candidate(c, slot, inputs, used_substitution_groups, used_exercise_slugs, history_familiarity), c)
            for c in pool
        ]
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return scored[0][1]

    bucket = _goal_bucket(inputs.goal)
    is_lift_focused = bucket in _LIFT_FOCUSED_BUCKETS
    split_pools = is_lift_focused and slot.role in ("primary", "secondary")

    if split_pools:
        loaded = [c for c in candidates if c.get("equipment_bucket") != "bodyweight"]
        bodyweight = [c for c in candidates if c.get("equipment_bucket") == "bodyweight"]
        return _best_of(loaded) or _best_of(bodyweight)

    return _best_of(candidates)


# ─── Layer 6 — Prescription assembler ────────────────────────────────────────


@dataclass
class Prescription:
    sets: int
    reps: str            # "6-8" / "10-15" / "30s" — free text for UI
    rest_seconds: int
    rir_target: float    # reps-in-reserve guidance


def prescribe_sets_reps(
    exercise: dict,
    slot: Slot,
    inputs: PlannerInputs,
) -> Prescription:
    """Assign sets, reps, rest, RIR for an exercise.

    Reuses the rep-range logic from `WorkoutProgressionEngine._base_rep_range`
    by re-implementing it inline so this module stays standalone. Numbers
    chosen to match the engine exactly so live progression doesn't fight
    the planner.
    """
    bucket = _goal_bucket(inputs.goal)
    is_compound = exercise.get("is_compound", False)
    is_isolation = not is_compound
    role = slot.role

    # ── Sets ───────────────────────────────────────────────────────────
    if role == "primary" and is_compound:
        sets = 4 if inputs.experience != "beginner" else 3
    elif role == "primary":
        sets = 3
    elif role == "secondary":
        sets = 3
    elif role == "core":
        sets = 3
    else:  # isolation
        sets = 3

    # ── Reps ───────────────────────────────────────────────────────────
    if bucket == "strength":
        if is_compound and role == "primary":
            reps = "4-6"
            rest = 180
            rir = 1.5
        elif is_compound:
            reps = "5-8"
            rest = 150
            rir = 2.0
        else:
            reps = "8-12"
            rest = 90
            rir = 2.0
    elif bucket == "muscle_gain":
        if is_compound and role == "primary":
            reps = "6-8"
            rest = 150
            rir = 1.5
        elif is_compound:
            reps = "8-10"
            rest = 120
            rir = 2.0
        else:
            reps = "10-15"
            rest = 75
            rir = 1.5
    elif bucket == "fat_loss":
        if is_compound and role == "primary":
            reps = "6-10"
            rest = 120
            rir = 2.0
        elif is_compound:
            reps = "8-12"
            rest = 90
            rir = 2.0
        else:
            reps = "12-15"
            rest = 60
            rir = 1.5
    else:  # body_recomp / general / athletic
        if is_compound and role == "primary":
            reps = "6-8"
            rest = 150
            rir = 2.0
        elif is_compound:
            reps = "8-12"
            rest = 90
            rir = 2.0
        else:
            reps = "10-15"
            rest = 60
            rir = 1.5

    # ── Override for time-based exercises ─────────────────────────────
    if exercise.get("default_tracking_mode") == "time":
        reps = "30-45s"
    elif exercise.get("default_tracking_mode") == "distance":
        reps = "20-30 yds"

    # ── Beginner cap: never more than 3 working sets per exercise ─────
    if inputs.experience == "beginner":
        sets = min(sets, 3)

    return Prescription(sets=sets, reps=reps, rest_seconds=rest, rir_target=rir)


# ─── Layer 7 — Top-level orchestrator ────────────────────────────────────────


def _equipment_label(exercise: dict) -> str:
    """Build a human-readable equipment label for the planner output.

    Old logic: `", ".join(slug for required) or "bodyweight"`.
    Problem: many seed entries list dumbbells / barbell as `required:
    False` (because the user could in theory go bodyweight), which made
    Goblet Squat / Sumo Squat / Walking Lunges all label as "bodyweight"
    in the output even though they're loaded movements.

    New logic, in priority order:
      1. Required primary or support slugs (the canonical needs)
      2. Any primary slugs (even if `required=False`) — handles "Goblet
         Squat → dumbbells" where the load is technically optional
      3. Literal "bodyweight" only when the bucket is actually bodyweight
      4. First slug in the equipment list as a last-resort fallback
    """
    eq = exercise.get("equipment") or []
    required_named = [
        e["slug"] for e in eq
        if e.get("required") and e.get("role") in ("primary", "support")
    ]
    if required_named:
        return ", ".join(required_named)
    primary_named = [e["slug"] for e in eq if e.get("role") == "primary"]
    if primary_named:
        return ", ".join(primary_named)
    if exercise.get("equipment_bucket") == "bodyweight":
        return "bodyweight"
    if eq:
        return eq[0].get("slug", "bodyweight")
    return "bodyweight"


def generate_workout_plan(
    inputs: PlannerInputs,
    all_exercises: list[dict],
    history_familiarity: dict[str, int] | None = None,
) -> dict:
    """Build a complete plan dict in the same shape `_call_workout_ai` returns:

        {
          "trainerNote": "",   # planner doesn't write copy — caller can fill
          "workout_plan": {
            "name": "...",
            "totalDays": int,
            "days": [
              {
                "day": "Day 1",
                "focus": "Push",
                "exercises": [
                  {"name": ..., "sets": int, "reps": str, "restSeconds": int, "equipment": str},
                  ...
                ],
              },
              ...
            ],
          },
        }

    The caller (plans.py) can wrap the result in `canonicalize_workout_exercises`
    if it wants the same equipment-string normalization the AI path uses,
    though for this planner's output it's a no-op since names come straight
    from the seed.
    """
    split = pick_split(inputs)
    templates = build_day_templates(split, inputs.days_per_week)
    targets = weekly_set_targets(inputs)  # noqa: F841 — used by Phase 2 volume balancer

    used_substitution_groups: set[str] = set()
    used_exercise_slugs: set[str] = set()

    days_out: list[dict] = []
    for day_name, slots in templates:
        focus = day_name.split(" ")[0]  # "Push 1" → "Push"
        exercises_out: list[dict] = []
        for slot in slots:
            ex = pick_for_slot(
                all_exercises, slot, inputs,
                used_substitution_groups, used_exercise_slugs,
                history_familiarity,
            )
            if ex is None:
                # No candidate survived the filter — slot dropped.
                # Logged so we can spot equipment gaps in production.
                print(f"[workout_planner] slot '{slot.label}' had no eligible exercise")
                continue
            prescription = prescribe_sets_reps(ex, slot, inputs)
            equipment_label = _equipment_label(ex)
            exercises_out.append({
                "name": ex["name"],
                "sets": prescription.sets,
                "reps": prescription.reps,
                "restSeconds": prescription.rest_seconds,
                "equipment": equipment_label,
                # Internal metadata the canonicalizer + progression engine
                # can read. Frontend ignores unknown keys.
                "_slug": ex.get("slug"),
                "_slot": slot.label,
                "_role": slot.role,
                "_rir_target": prescription.rir_target,
                "_primary_muscle": ex.get("primary_muscle"),
            })
            sub = ex.get("substitution_group")
            if sub:
                used_substitution_groups.add(sub)
            if ex.get("slug"):
                used_exercise_slugs.add(ex["slug"])
        days_out.append({
            "day": day_name,
            "focus": focus,
            "exercises": exercises_out,
        })

    return {
        "trainerNote": "",  # left empty so the caller can fill via AI if desired
        "workout_plan": {
            "name": f"{_goal_bucket(inputs.goal).replace('_', ' ').title()} — {split.replace('_', ' ').title()}",
            "totalDays": inputs.days_per_week,
            "days": days_out,
        },
    }


# ─── Phase 2 placeholder — session-to-session progression ───────────────────


def propose_session_targets_from_history(
    next_plan: dict,
    history: list[dict],
) -> dict:
    """Adjust the next plan's `target_weight` and `target_reps_*` based on
    the user's last completed sets for each exercise.

    Phase 2 — not implemented in this pass. The hook is here so plans.py
    can wire it up in the next round. The eventual implementation will:

      1. For every exercise in `next_plan`, find the most recent matching
         logged exercise in `history`.
      2. Read its actual sets/reps/weight.
      3. Apply double-progression rules (top-of-range → +load, partial
         → hold, miss → -load) using the existing
         `WorkoutProgressionEngine` for the math.
      4. Set `_target_weight_lbs` and adjust the rep range on the next
         plan's exercise dict.
    """
    return next_plan
