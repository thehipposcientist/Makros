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
SPLIT_ENDURANCE = "endurance"      # cardio-focused, 1 strength maintenance day
SPLIT_HYBRID = "hybrid"            # athletic mix — strength + conditioning

# Minimum days a split needs to make sense. Used by the preferred-split
# override in pick_split and by test helpers.
_SPLIT_MIN_DAYS = {
    SPLIT_FULL_BODY:   1,
    SPLIT_UPPER_LOWER: 2,
    SPLIT_PPL:         3,
    SPLIT_BRO:         5,
    SPLIT_PPL_UL:      5,
    SPLIT_ENDURANCE:   1,
    SPLIT_HYBRID:      3,
}


def _goal_bucket(goal: str) -> str:
    """Thin shim over `goals.goal_bucket`. Kept so existing call sites
    inside this module don't have to change; new code should import
    `goal_bucket` directly from `app.services.workout.goals`."""
    from .goals import goal_bucket as _registry_bucket
    return _registry_bucket(goal)


def pick_split(inputs: PlannerInputs) -> str:
    """Choose a training split from (days_per_week, goal_bucket, experience).

    This is a hand-written decision matrix — NOT a priority list walk.
    The old implementation walked a goal-keyed priority list and
    returned the first split whose minimum-day requirement fit. That
    quietly broke at higher day counts: fat loss listed
    `full_body` first, `full_body` has `min_days=1`, so a 5-day fat-loss
    user still got 5 days of full-body. Fixed by being explicit per cell
    of the matrix.

    Rules (in order of evaluation):

    1. **Explicit preferred_split override.** Honor it if it's a valid
       split and has enough days. Anything else falls through.
    2. **1-2 days/week: always full body.** Not enough sessions to
       split productively.
    3. **Beginners bias toward simpler splits.** Full-body through 3
       days, upper/lower at 4+. Beginners don't need PPL complexity.
    4. **3 days, intermediate+:**
         - muscle_gain / strength: PPL (one dedicated day per function)
         - body_recomp: PPL (same reasoning — moderate frequency helps)
         - fat_loss / athletic / general_health: full body (higher
           frequency per muscle helps these goals more than isolation)
    5. **4 days, intermediate+:** upper/lower for everyone. The
       workhorse 4-day split. Covers every muscle twice a week with
       enough recovery between matched sessions.
    6. **5 days, intermediate+:**
         - muscle_gain / body_recomp: ppl_upper_lower (5-day hybrid)
           gives 6 muscle exposures per week without over-specialization.
         - fat_loss / strength / athletic / general_health: upper/lower
           cycle — still a 2-day rotation, just repeated 2.5×. Avoids
           the "5x full body" default that over-compounds recovery.
    7. **6+ days, intermediate+:**
         - muscle_gain + advanced: bro split (dedicated day per muscle)
         - everything else: PPL run twice weekly

    All decisions are deterministic — same (days, goal, experience)
    always returns the same split.
    """
    if inputs.preferred_split and inputs.preferred_split != "auto":
        if _SPLIT_MIN_DAYS.get(inputs.preferred_split, 99) <= inputs.days_per_week:
            return inputs.preferred_split

    days = max(1, min(7, inputs.days_per_week or 3))
    bucket = _goal_bucket(inputs.goal)
    experience = (inputs.experience or "intermediate").lower()

    # Rule 0 — goal-first routing. Endurance and athletic_performance
    # use dedicated splits at every day count because their templates
    # (cardio days, hybrid strength+conditioning days) don't fit the
    # standard upper/lower/PPL matrix. This MUST come before the "1-2
    # days = full body" rule so a 2-day endurance user still gets
    # cardio, not a full-body lifting day.
    if bucket == "endurance":
        return SPLIT_ENDURANCE
    if bucket == "athletic_performance" and days >= 3:
        return SPLIT_HYBRID

    # Rule 2 — 1-2 day weeks always full body.
    if days <= 2:
        return SPLIT_FULL_BODY

    # Rule 3 — beginners stay simple. Full body up to 3 days, upper/lower
    # above that. A 5-day beginner still gets upper/lower repeated rather
    # than PPL complexity they don't need yet.
    if experience == "beginner":
        if days <= 3:
            return SPLIT_FULL_BODY
        return SPLIT_UPPER_LOWER

    # Intermediate / advanced path from here down.

    if days == 3:
        if bucket in ("muscle_gain", "strength", "body_recomp"):
            return SPLIT_PPL
        # fat_loss / athletic_performance / general_health — higher
        # frequency per muscle group matters more than specialization
        # at 3 days for these goals.
        return SPLIT_FULL_BODY

    if days == 4:
        # 4-day upper/lower is the workhorse. Every muscle hits 2× per
        # week with one full day between matched sessions.
        return SPLIT_UPPER_LOWER

    if days == 5:
        if bucket in ("muscle_gain", "body_recomp"):
            return SPLIT_PPL_UL
        # fat_loss / strength / athletic / general_health: upper/lower
        # cycle repeats 2.5× — gives every muscle 2-3× frequency
        # without the 5-day full-body recovery problem.
        return SPLIT_UPPER_LOWER

    # days >= 6
    if bucket == "muscle_gain" and experience == "advanced":
        return SPLIT_BRO
    return SPLIT_PPL


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
    # Endurance users train lifting for maintenance only. Volume is
    # deliberately LOW per muscle so cardio recovery isn't compromised.
    # Focused muscles still get the +30% bonus via `weekly_set_targets`.
    ("endurance", "beginner"): {
        "chest": 4, "back": 5, "shoulders": 3, "biceps": 3, "triceps": 3,
        "quads": 5, "hamstrings": 4, "glutes": 4, "calves": 3, "core": 6,
    },
    ("endurance", "intermediate"): {
        "chest": 6, "back": 8, "shoulders": 4, "biceps": 4, "triceps": 4,
        "quads": 6, "hamstrings": 5, "glutes": 5, "calves": 4, "core": 6,
    },
    ("endurance", "advanced"): {
        "chest": 6, "back": 8, "shoulders": 4, "biceps": 4, "triceps": 4,
        "quads": 6, "hamstrings": 5, "glutes": 5, "calves": 4, "core": 6,
    },
    # Athletic performance — moderate strength volume plus conditioning
    # days. Prescription is driven by the hybrid split, not this table;
    # the numbers here are used only for the volume-deficit scoring bias.
    ("athletic_performance", "beginner"): {
        "chest": 8, "back": 10, "shoulders": 6, "biceps": 5, "triceps": 6,
        "quads": 10, "hamstrings": 8, "glutes": 8, "calves": 5, "core": 8,
    },
    ("athletic_performance", "intermediate"): {
        "chest": 10, "back": 12, "shoulders": 8, "biceps": 6, "triceps": 8,
        "quads": 12, "hamstrings": 10, "glutes": 10, "calves": 6, "core": 8,
    },
    ("athletic_performance", "advanced"): {
        "chest": 12, "back": 14, "shoulders": 10, "biceps": 8, "triceps": 10,
        "quads": 14, "hamstrings": 12, "glutes": 12, "calves": 8, "core": 10,
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

    Adds a +30% bonus to the user's `focused_muscle` if set, clamped at
    the advanced-tier volume for the same (bucket, muscle). Without the
    clamp an advanced muscle-gain user could request "chest focus" and
    blow through 23 sets/week (18 × 1.3), which is beyond MRV for most
    intermediates. The cap enforces the docstring promise that the
    bonus never escapes the next-experience-level ceiling.
    """
    bucket = _goal_bucket(inputs.goal)
    base = _WEEKLY_VOLUME.get((bucket, inputs.experience), _DEFAULT_VOLUME).copy()
    if inputs.focused_muscle and inputs.focused_muscle in base:
        boosted = round(base[inputs.focused_muscle] * 1.3)
        # Cap at the same-bucket advanced-tier value. For advanced users,
        # the cap becomes their own tier — effectively no ceiling past
        # that, which is the right behavior because they already sit at
        # the top of the volume landscape.
        cap_source = _WEEKLY_VOLUME.get((bucket, "advanced"), _DEFAULT_VOLUME)
        cap = cap_source.get(inputs.focused_muscle, boosted)
        base[inputs.focused_muscle] = min(boosted, cap)
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


# ─── Slot templates (pure slot lists — no names) ─────────────────────────────


def _full_body_slots(day_index: int) -> list[Slot]:
    """Slot list for one full-body day, rotated across three themes so
    consecutive sessions don't repeat the exact same exercises. The
    caller gets the trainer-style display name from `_day_meta`."""
    if day_index % 3 == 0:
        return [
            Slot("Squat Pattern",     "squat",            "quads",       "primary"),
            Slot("Horizontal Press",  "horizontal_press", "chest",       "primary"),
            Slot("Horizontal Pull",   "horizontal_pull",  "back",        "primary"),
            Slot("Hinge Accessory",   "hinge",            "hamstrings",  "secondary"),
            Slot("Core",              "anti_extension",   "core",        "core"),
        ]
    if day_index % 3 == 1:
        return [
            Slot("Hinge Pattern",     "hinge",            "hamstrings",  "primary"),
            Slot("Vertical Press",    "vertical_press",   "shoulders",   "primary"),
            Slot("Vertical Pull",     "vertical_pull",    "back",        "primary"),
            Slot("Lunge / Single-leg","lunge",            "quads",       "secondary"),
            Slot("Core",              "anti_extension",   "core",        "core"),
        ]
    return [
        Slot("Squat Pattern",     "squat",            "quads",       "primary"),
        Slot("Horizontal Press",  "horizontal_press", "chest",       "secondary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",        "primary"),
        Slot("Hinge",             "hinge",            "glutes",      "secondary"),
        Slot("Core",              "anti_extension",   "core",        "core"),
    ]


def _upper_slots(cycle_index: int) -> list[Slot]:
    """Upper-body day. Rotates emphasis across cycles so Upper 1 vs
    Upper 2 feel different: horizontal push/pull → vertical push/pull
    → balanced. The cycle index is (day_index // 2) for pure upper/lower
    splits."""
    if cycle_index % 3 == 0:
        # Horizontal push/pull emphasis
        return [
            Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
            Slot("Primary Pull",      "horizontal_pull",  "back",      "primary"),
            Slot("Secondary Press",   "horizontal_press", "chest",     "secondary"),
            Slot("Secondary Pull",    "horizontal_pull",  "back",      "secondary"),
            Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
            Slot("Biceps",            "isolation",        "biceps",    "isolation"),
            Slot("Triceps",           "isolation",        "triceps",   "isolation"),
        ]
    if cycle_index % 3 == 1:
        # Vertical push/pull emphasis
        return [
            Slot("Vertical Press",    "vertical_press",   "shoulders", "primary"),
            Slot("Vertical Pull",     "vertical_pull",    "back",      "primary"),
            Slot("Horizontal Press",  "horizontal_press", "chest",     "secondary"),
            Slot("Horizontal Pull",   "horizontal_pull",  "back",      "secondary"),
            Slot("Rear Delt",         "isolation",        "shoulders", "isolation"),
            Slot("Biceps",            "isolation",        "biceps",    "isolation"),
            Slot("Triceps",           "isolation",        "triceps",   "isolation"),
        ]
    # Balanced
    return [
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Primary Pull",      "horizontal_pull",  "back",      "primary"),
        Slot("Vertical Press",    "vertical_press",   "shoulders", "secondary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",      "secondary"),
        Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
        Slot("Biceps",            "isolation",        "biceps",    "isolation"),
        Slot("Triceps",           "isolation",        "triceps",   "isolation"),
    ]


def _lower_slots(cycle_index: int) -> list[Slot]:
    """Lower-body day. Rotates emphasis between squat bias, hinge bias,
    and balanced across cycles."""
    if cycle_index % 3 == 0:
        # Squat bias
        return [
            Slot("Squat Pattern",     "squat",            "quads",      "primary"),
            Slot("Single-leg",        "lunge",            "quads",      "secondary"),
            Slot("Hinge Pattern",     "hinge",            "hamstrings", "secondary"),
            Slot("Quad Isolation",    "isolation",        "quads",      "isolation"),
            Slot("Calves",            "isolation",        "calves",     "isolation"),
            Slot("Core",              "anti_extension",   "core",       "core"),
        ]
    if cycle_index % 3 == 1:
        # Hinge bias
        return [
            Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
            Slot("Squat Pattern",     "squat",            "quads",      "secondary"),
            Slot("Single-leg",        "lunge",            "glutes",     "secondary"),
            Slot("Hamstring Isolation","isolation",       "hamstrings", "isolation"),
            Slot("Calves",            "isolation",        "calves",     "isolation"),
            Slot("Core",              "anti_extension",   "core",       "core"),
        ]
    # Balanced
    return [
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Single-leg",        "lunge",            "quads",      "secondary"),
        Slot("Hamstring Accessory","isolation",       "hamstrings", "isolation"),
        Slot("Calves",            "isolation",        "calves",     "isolation"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


def _push_slots() -> list[Slot]:
    return [
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Vertical Press",    "vertical_press",   "shoulders", "primary"),
        Slot("Secondary Press",   "horizontal_press", "chest",     "secondary"),
        Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
        Slot("Triceps Compound",  "isolation",        "triceps",   "isolation"),
        Slot("Triceps Isolation", "isolation",        "triceps",   "isolation"),
    ]


def _pull_slots() -> list[Slot]:
    return [
        Slot("Vertical Pull",     "vertical_pull",    "back",   "primary"),
        Slot("Horizontal Pull",   "horizontal_pull",  "back",   "primary"),
        Slot("Secondary Pull",    "horizontal_pull",  "back",   "secondary"),
        Slot("Rear Delt",         "isolation",        "shoulders", "isolation"),
        Slot("Bicep Curl",        "isolation",        "biceps", "isolation"),
        Slot("Bicep Variation",   "isolation",        "biceps", "isolation"),
    ]


def _legs_slots() -> list[Slot]:
    return [
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Single-leg",        "lunge",            "quads",      "secondary"),
        Slot("Hamstring Accessory","isolation",       "hamstrings", "isolation"),
        Slot("Calves",            "isolation",        "calves",     "isolation"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


# ─── Mobility / recovery / circuit slot builders ─────────────────────────────


def _mobility_flow_slots() -> list[Slot]:
    """Full-body mobility flow. Every slot uses `movement_pattern="mobility"`
    which matches the ~13 mobility-bucket exercises in the seed
    (cat_cow, world's greatest stretch, thoracic rotation, etc.)."""
    return [
        Slot("Spine Mobility",    "mobility", None, "primary"),
        Slot("Hip Mobility",      "mobility", None, "primary"),
        Slot("Shoulder Mobility", "mobility", None, "secondary"),
        Slot("Ankle Mobility",    "mobility", None, "secondary"),
        Slot("Flow Finisher",     "mobility", None, "isolation"),
    ]


def _stretch_block_slots() -> list[Slot]:
    """Focused static stretch session. Fewer slots than a flow — the
    prescription here uses longer holds."""
    return [
        Slot("Lower Body Stretch", "mobility", None, "primary"),
        Slot("Upper Body Stretch", "mobility", None, "primary"),
        Slot("Spine Stretch",      "mobility", None, "secondary"),
        Slot("Final Stretch",      "mobility", None, "isolation"),
    ]


def _recovery_easy_slots() -> list[Slot]:
    """Easy recovery cardio — single block, low intensity. Primary
    muscle hint is `None` so any cardio row qualifies."""
    return [
        Slot("Easy Cardio", "cardio", None, "primary"),
    ]


def _stress_relief_slots() -> list[Slot]:
    """Stress-relief session — one easy cardio block plus one gentle
    mobility finisher. Accepts both cardio and mobility exercise
    types via the archetype's accepts_types set."""
    return [
        Slot("Easy Movement", "cardio",   None, "primary"),
        Slot("Gentle Mobility","mobility", None, "isolation"),
    ]


def _circuit_slots() -> list[Slot]:
    """Metabolic circuit — mixes compound pushes, pulls, and squats
    at circuit tempo. Slots are strength-typed; the prescription
    branch for COND_CIRCUIT rewrites them to round-based formatting."""
    return [
        Slot("Circuit Press",   "horizontal_press", "chest",      "secondary"),
        Slot("Circuit Row",     "horizontal_pull",  "back",       "secondary"),
        Slot("Circuit Squat",   "squat",            "quads",      "secondary"),
        Slot("Circuit Core",    "anti_extension",   "core",       "core"),
        Slot("Circuit Finisher","cardio",           None,         "isolation"),
    ]


def _hybrid_lower_power_slots() -> list[Slot]:
    """Athletic lower-body power day. Heavy compound lower + plyometric
    + sprint finisher. Matches the HYBRID_LOWER_POWER archetype."""
    return [
        Slot("Main Lower Lift", "squat",      "quads",      "primary"),
        Slot("Hinge Pattern",   "hinge",      "hamstrings", "secondary"),
        Slot("Plyometric",      "plyometric", "quads",      "secondary"),
        Slot("Sprint Finisher", "cardio",     None,         "isolation"),
    ]


def _hybrid_upper_intervals_slots() -> list[Slot]:
    """Athletic upper-body + interval finisher day."""
    return [
        Slot("Horizontal Press", "horizontal_press", "chest", "primary"),
        Slot("Horizontal Pull",  "horizontal_pull",  "back",  "primary"),
        Slot("Vertical Press",   "vertical_press",   "shoulders", "secondary"),
        Slot("Interval Finisher","cardio",           None,     "isolation"),
    ]


def _hybrid_strength_intervals_slots() -> list[Slot]:
    """Combined strength + intervals session. Full-body strength block
    followed by short intervals."""
    return [
        Slot("Main Lift",        "squat",      "quads",   "primary"),
        Slot("Press",            "horizontal_press", "chest", "primary"),
        Slot("Pull",             "horizontal_pull",  "back",  "secondary"),
        Slot("Interval Finisher","cardio",     None,     "isolation"),
    ]


def _hybrid_full_body_circuit_slots() -> list[Slot]:
    """Full-body circuit — mixes compounds with a cardio finisher."""
    return [
        Slot("Squat",         "squat",            "quads", "primary"),
        Slot("Press",         "horizontal_press", "chest", "primary"),
        Slot("Pull",          "horizontal_pull",  "back",  "primary"),
        Slot("Hinge",         "hinge",            "hamstrings", "secondary"),
        Slot("Cardio Burst",  "cardio",           None,    "isolation"),
    ]


# ─── Conditioning / cardio slot builders ─────────────────────────────────────
#
# Cardio slots all share `movement_pattern="cardio"` and leave
# `primary_muscle_hint=None` so the filter doesn't constrain to a
# specific muscle — cardio picks are categorized by `primary_muscle`
# values of "cardio" or "full_body" in the seed, and we want both.


def _cardio_intervals_slots() -> list[Slot]:
    """High-intensity interval day. Warmup, intervals, cooldown.

    The warmup and cooldown slots are marked `secondary`/`isolation` so
    `_density_adjust_slots` trims them first when the user has a short
    session budget — leaving the intervals as the irreducible core."""
    return [
        Slot("Cardio Warmup",   "cardio", None, "secondary"),
        Slot("Main Intervals",  "cardio", None, "primary"),
        Slot("Cardio Cooldown", "cardio", None, "isolation"),
    ]


def _cardio_steady_slots() -> list[Slot]:
    """Steady-state cardio day. One primary block plus a short cooldown."""
    return [
        Slot("Steady-State Cardio", "cardio", None, "primary"),
        Slot("Cardio Cooldown",     "cardio", None, "isolation"),
    ]


def _cardio_mixed_slots() -> list[Slot]:
    """Mixed day — intervals on one modality followed by an easy spin on
    another. Good middle-ground cardio session when the user has time."""
    return [
        Slot("Cardio Warmup",   "cardio", None, "secondary"),
        Slot("Main Intervals",  "cardio", None, "primary"),
        Slot("Easy Spin",       "cardio", None, "secondary"),
        Slot("Cardio Cooldown", "cardio", None, "isolation"),
    ]


def _strength_maintenance_slots() -> list[Slot]:
    """Compact full-body strength day used inside endurance plans. Keeps
    muscle mass and connective tissue tolerance while the user chases
    a cardio goal. Intentionally shorter than a normal full-body day —
    5 compound slots, no isolation."""
    return [
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Horizontal Press",  "horizontal_press", "chest",      "primary"),
        Slot("Horizontal Pull",   "horizontal_pull",  "back",       "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "secondary"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


# Endurance split rotation: for N days/week we walk this sequence and
# cycle when we run out. Steady / intervals / steady gives the most
# realistic easy-hard-easy pattern; strength maintenance always lands
# on the last day of the week so cardio days are spaced out.
_ENDURANCE_DAY_KINDS = [
    "intervals",        # day 1
    "steady",           # day 2
    "intervals",        # day 3
    "steady",           # day 4
    "mixed",            # day 5
    "steady",           # day 6
    "steady",           # day 7 — rest-day alternative
]


# Hybrid (athletic_performance) rotation: balances strength and
# conditioning. At low day counts the user gets one of each; at higher
# counts we alternate upper/lower strength with intervals/steady so no
# muscle group is hammered two days in a row.
_HYBRID_DAY_KINDS = [
    "upper_strength",   # day 1
    "intervals",        # day 2
    "lower_strength",   # day 3
    "steady",           # day 4
    "full_body",        # day 5
    "intervals",        # day 6
    "steady",           # day 7
]


# Bro-split day slot lists keyed by position in the weekly rotation.
_BRO_SLOT_SEQUENCE: list[list[Slot]] = [
    # Chest
    [
        Slot("Primary Press",    "horizontal_press", "chest", "primary"),
        Slot("Incline Press",    "horizontal_press", "chest", "secondary"),
        Slot("Chest Fly",        "isolation",        "chest", "isolation"),
        Slot("Tricep Compound",  "isolation",        "triceps", "isolation"),
        Slot("Tricep Isolation", "isolation",        "triceps", "isolation"),
    ],
    # Back
    [
        Slot("Vertical Pull",    "vertical_pull",   "back",  "primary"),
        Slot("Horizontal Pull",  "horizontal_pull", "back",  "primary"),
        Slot("Secondary Row",    "horizontal_pull", "back",  "secondary"),
        Slot("Rear Delt",        "isolation",       "shoulders", "isolation"),
        Slot("Bicep Curl",       "isolation",       "biceps", "isolation"),
    ],
    # Shoulders
    [
        Slot("Vertical Press",   "vertical_press",  "shoulders", "primary"),
        Slot("Lateral Raise",    "isolation",       "shoulders", "isolation"),
        Slot("Rear Delt Fly",    "isolation",       "shoulders", "isolation"),
        Slot("Upright Row",      "vertical_pull",   "shoulders", "secondary"),
        Slot("Shrug",            "isolation",       "traps",     "isolation"),
    ],
    # Arms
    [
        Slot("Bicep Curl",       "isolation", "biceps", "primary"),
        Slot("Tricep Press",     "isolation", "triceps", "primary"),
        Slot("Hammer Curl",      "isolation", "biceps", "secondary"),
        Slot("Overhead Tri",     "isolation", "triceps", "secondary"),
    ],
    # Legs
    _legs_slots(),
]


# ─── Naming layer ────────────────────────────────────────────────────────────


def _day_meta(split: str, day_index: int, days_per_week: int = 0) -> tuple[str, str]:
    """Centralized day naming. Returns `(display_name, focus_label)`.

    `display_name` is the trainer-style two-part label the user sees:
    a short base (Upper / Lower / Push / Pull / Legs / Full Body / one
    of the bro muscle days) followed by an em-dash and a short emphasis
    subtitle derived from the template's slot composition.

    `focus_label` is the semantic focus used internally for UI grouping
    and muscle-tag coloring. It is NOT derived by splitting the display
    name on whitespace — that produced `Full` for `Full Body A — …`,
    which was the old focus-extraction bug.

    Supported splits: full_body, upper_lower, ppl, ppl_upper_lower, bro.
    Unknown splits fall back to `("Day N", "Full Body")`.
    """
    if split == SPLIT_FULL_BODY:
        letters = ["A", "B", "C"]
        emphases = ["Squat & Press", "Hinge & Vertical", "Mixed Power"]
        i = day_index % 3
        return f"Full Body {letters[i]} — {emphases[i]}", "Full Body"

    if split == SPLIT_UPPER_LOWER:
        is_upper = (day_index % 2) == 0
        cycle_n = (day_index // 2) + 1
        if is_upper:
            upper_emph = [
                "Horizontal Push/Pull",
                "Vertical Push/Pull",
                "Balanced Push/Pull",
            ]
            return f"Upper {cycle_n} — {upper_emph[(cycle_n - 1) % 3]}", "Upper"
        lower_emph = [
            "Squat Bias",
            "Hinge Bias",
            "Balanced Squat/Hinge",
        ]
        return f"Lower {cycle_n} — {lower_emph[(cycle_n - 1) % 3]}", "Lower"

    if split == SPLIT_PPL:
        pos = day_index % 3
        cycle_n = (day_index // 3) + 1
        if pos == 0:
            return f"Push {cycle_n} — Chest/Shoulder Focus", "Push"
        if pos == 1:
            return f"Pull {cycle_n} — Lats/Upper Back Focus", "Pull"
        return f"Legs {cycle_n} — Squat + Hinge", "Legs"

    if split == SPLIT_PPL_UL:
        # 5-day hybrid. Each day label baked into a stable sequence.
        seq = [
            ("Push — Chest/Shoulder Focus", "Push"),
            ("Pull — Lats/Upper Back Focus", "Pull"),
            ("Legs — Squat + Hinge", "Legs"),
            ("Upper — Accessory & Arms", "Upper"),
            ("Lower — Hinge & Glute Focus", "Lower"),
        ]
        return seq[day_index % 5]

    if split == SPLIT_BRO:
        seq = [
            ("Chest — Press + Fly Emphasis", "Chest"),
            ("Back — Width + Row Focus", "Back"),
            ("Shoulders — Lateral + Overhead", "Shoulders"),
            ("Arms — Biceps + Triceps", "Arms"),
            ("Legs — Quad + Hamstring", "Legs"),
        ]
        return seq[day_index % 5]

    if split == SPLIT_ENDURANCE:
        kind = _endurance_day_kind(day_index, days_per_week or (day_index + 1))
        if kind == "strength":
            return "Strength Maintenance — Full Body", "Strength"
        if kind == "intervals":
            return "Cardio — Intervals", "Cardio"
        if kind == "mixed":
            return "Cardio — Mixed Intervals + Spin", "Cardio"
        return "Cardio — Steady State", "Cardio"

    if split == SPLIT_HYBRID:
        kind = _HYBRID_DAY_KINDS[day_index % len(_HYBRID_DAY_KINDS)]
        if kind == "upper_strength":
            return "Upper Strength — Power Bias", "Upper"
        if kind == "lower_strength":
            return "Lower Strength — Squat + Hinge", "Lower"
        if kind == "full_body":
            return "Full Body — Power + Carry", "Full Body"
        if kind == "intervals":
            return "Conditioning — Intervals", "Cardio"
        return "Conditioning — Steady State", "Cardio"

    return f"Day {day_index + 1}", "Full Body"


def _endurance_day_kind(day_index: int, total_days: int) -> str:
    """Endurance plans always include exactly ONE strength maintenance
    day per week (at 3+ days/week) — placed at the END of the week so
    cardio days stay spaced out. Days 1..N-1 cycle through the cardio
    rotation in `_ENDURANCE_DAY_KINDS`."""
    if total_days >= 3 and day_index == total_days - 1:
        return "strength"
    return _ENDURANCE_DAY_KINDS[day_index % len(_ENDURANCE_DAY_KINDS)]


def _slots_for_day(split: str, day_index: int, days_per_week: int = 0) -> list[Slot]:
    """Return the slot list for one day. Mirrors `_day_meta`'s dispatch
    so the two stay in lockstep.

    `days_per_week` is only used by `SPLIT_ENDURANCE` to decide where
    the weekly strength maintenance day falls. For every other split
    it's ignored."""
    if split == SPLIT_FULL_BODY:
        return _full_body_slots(day_index)
    if split == SPLIT_UPPER_LOWER:
        is_upper = (day_index % 2) == 0
        cycle_index = day_index // 2
        return _upper_slots(cycle_index) if is_upper else _lower_slots(cycle_index)
    if split == SPLIT_PPL:
        pos = day_index % 3
        if pos == 0:
            return _push_slots()
        if pos == 1:
            return _pull_slots()
        return _legs_slots()
    if split == SPLIT_PPL_UL:
        pos = day_index % 5
        if pos == 0:
            return _push_slots()
        if pos == 1:
            return _pull_slots()
        if pos == 2:
            return _legs_slots()
        if pos == 3:
            return _upper_slots(0)  # balanced upper accessory day
        return _lower_slots(1)  # hinge-bias lower accessory day
    if split == SPLIT_BRO:
        return _BRO_SLOT_SEQUENCE[day_index % 5]
    if split == SPLIT_ENDURANCE:
        kind = _endurance_day_kind(day_index, days_per_week or (day_index + 1))
        if kind == "strength":
            return _strength_maintenance_slots()
        if kind == "intervals":
            return _cardio_intervals_slots()
        if kind == "mixed":
            return _cardio_mixed_slots()
        return _cardio_steady_slots()
    if split == SPLIT_HYBRID:
        kind = _HYBRID_DAY_KINDS[day_index % len(_HYBRID_DAY_KINDS)]
        if kind == "upper_strength":
            return _upper_slots(0)
        if kind == "lower_strength":
            return _lower_slots(0)
        if kind == "full_body":
            return _full_body_slots(0)
        if kind == "intervals":
            return _cardio_intervals_slots()
        return _cardio_steady_slots()
    return _full_body_slots(day_index)


def build_day_templates(split: str, days_per_week: int) -> list[tuple[str, list[Slot]]]:
    """Return a list of `(day_name, slots)` for the chosen split.

    Day count is exactly `days_per_week`. Splits with cycle lengths
    that don't divide evenly into `days_per_week` repeat from the start
    (e.g. PPL on 4 days = Push, Pull, Legs, Push). Naming and emphasis
    rotation are centralized in `_day_meta` / `_slots_for_day` so every
    split uses the same trainer-style format."""
    out: list[tuple[str, list[Slot]]] = []
    for i in range(days_per_week):
        name, _focus = _day_meta(split, i, days_per_week)
        slots = _slots_for_day(split, i, days_per_week)
        out.append((name, slots))
    return out


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
    *,
    injury_blocked_patterns: set[str] | None = None,
    accepts_types: frozenset[str] | None = None,
) -> list[dict]:
    """Return every exercise eligible for this slot.

    Filters:
      1. Equipment satisfied
      2. Exercise type is in the slot's `accepts_types` set (driven
         by the archetype — lifting slots accept `{"strength"}`,
         cardio slots accept `{"cardio"}`, mobility slots accept
         `{"mobility"}`). Default is `{"strength"}` so every existing
         lifting-slot caller keeps its old behavior.
      3. Movement pattern matches the slot
      4. Movement pattern is not in `injury_blocked_patterns` (which
         the caller builds from `PlannerInputs.injuries`)
      5. Primary muscle compatible with slot hint (when slot specifies
         a hint AND the slot is an isolation slot — compounds get to
         bleed across muscles)
      6. Not in the user's disliked set
    """
    blocked = injury_blocked_patterns or set()
    accepts = accepts_types or frozenset({"strength"})
    out: list[dict] = []
    for ex in all_exercises:
        if (ex.get("name") or "").lower() in disliked_set:
            continue
        ex_type = ex.get("exercise_type") or "strength"
        if ex_type not in accepts:
            continue
        if ex.get("power_type") in ("mobility",) and "mobility" not in accepts:
            continue
        if not _equipment_satisfied(ex, owned_equipment):
            continue
        mp = ex.get("movement_pattern")
        if mp != slot.movement_pattern:
            continue
        if mp in blocked:
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
    *,
    volume_targets: dict[str, int] | None = None,
    volume_assigned: dict[str, float] | None = None,
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

    # 7. Familiarity bonus from history, scaled by slot role so
    # continuity feels intentional:
    #   - Primary lifts are very sticky (1.3×) — once bench press is in
    #     the plan it stays for a while, because users track strength
    #     progress on those and hate seeing them rotate out.
    #   - Secondary lifts use the base 1.0× bonus.
    #   - Isolation / core slots get a reduced 0.6× bonus so variety
    #     naturally rotates lateral raises, face pulls, curls, etc.
    #     across regenerations instead of locking in the first pick.
    if history_familiarity:
        familiar = history_familiarity.get(exercise.get("slug", ""), 0)
        if familiar > 0:
            role_multiplier = {
                "primary": 1.3,
                "secondary": 1.0,
                "isolation": 0.6,
                "core": 0.6,
            }.get(role, 1.0)
            score += min(2.0, 0.5 * familiar) * role_multiplier

    # 7b. Weekly-volume deficit bias. When we have a running tally of
    # sets already assigned per muscle, nudge selection toward exercises
    # that hit UNDER-allocated muscles and away from OVER-allocated ones.
    # The ratio is computed as assigned/target on the exercise's primary
    # muscle; scores are shifted ±1.5 max so it can tip ties without
    # overriding goal/role match.
    #
    # Focused muscles benefit twice: their target gets a +30% bump from
    # weekly_set_targets() AND any exercise hitting them wins more ties
    # until the elevated target is satisfied.
    if volume_targets and volume_assigned is not None:
        primary_muscle = exercise.get("primary_muscle") or ""
        target = volume_targets.get(primary_muscle, 0)
        if target > 0:
            assigned = volume_assigned.get(primary_muscle, 0.0)
            ratio = assigned / target
            if ratio < 0.6:
                score += 1.5
            elif ratio < 0.9:
                score += 0.6
            elif ratio > 1.4:
                score -= 1.5
            elif ratio > 1.1:
                score -= 0.6

    # 7c. Cardio intensity match — slot labels encode whether the day
    # wants intervals (hard) or steady-state (easy). The exercise's
    # `is_compound` flag is used on cardio rows as the intervals
    # indicator (see seed_exercises_data.py — `treadmill_intervals` is
    # compound=True, `treadmill_run` is compound=False). Without this
    # term the intervals slot could pull a steady-state jog and a
    # warmup slot could pull sprint intervals — both wrong.
    if exercise.get("movement_pattern") == "cardio":
        label_lower = (slot.label or "").lower()
        is_interval_ex = bool(exercise.get("is_compound"))
        wants_intervals = (
            "interval" in label_lower
            or "sprint" in label_lower
            or "main" in label_lower
        )
        wants_steady = (
            "steady" in label_lower
            or "warmup" in label_lower
            or "cooldown" in label_lower
            or "spin" in label_lower
            or "zone 2" in label_lower
            or "tempo" in label_lower
        )
        # Recovery / stress-relief labels push HARD against any
        # interval-style cardio. "Easy Movement" must not be HIIT.
        wants_easy = (
            "easy" in label_lower
            or "recovery" in label_lower
            or "gentle" in label_lower
        )
        if wants_easy:
            if is_interval_ex:
                score -= 5.0   # hard ban
            else:
                score += 2.0
        elif wants_intervals and is_interval_ex:
            score += 2.5
        elif wants_intervals and not is_interval_ex:
            score -= 2.5
        elif wants_steady and not is_interval_ex:
            score += 2.5
        elif wants_steady and is_interval_ex:
            score -= 2.5

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
    *,
    volume_targets: dict[str, int] | None = None,
    volume_assigned: dict[str, float] | None = None,
    injury_blocked_patterns: set[str] | None = None,
    accepts_types: frozenset[str] | None = None,
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
    candidates = filter_candidates(
        all_exercises, slot, owned, disliked,
        injury_blocked_patterns=injury_blocked_patterns,
        accepts_types=accepts_types,
    )
    if not candidates:
        return None

    def _best_of(pool: list[dict]) -> dict | None:
        if not pool:
            return None
        scored = [
            (
                score_candidate(
                    c, slot, inputs,
                    used_substitution_groups, used_exercise_slugs,
                    history_familiarity,
                    volume_targets=volume_targets,
                    volume_assigned=volume_assigned,
                ),
                c,
            )
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

    # ── Cardio short-circuit ──────────────────────────────────────────
    # Cardio exercises live in a different units system (minutes/distance,
    # not sets × reps × load). Emit a duration-shaped prescription that
    # the frontend already renders via the time/distance code paths and
    # skip the strength rep tables below. The `is_compound` flag on the
    # seed row distinguishes intervals (compound=True) from steady-state
    # (compound=False) so we can key off that.
    if (exercise.get("movement_pattern") == "cardio"
            or exercise.get("exercise_type") == "cardio"):
        if is_compound:
            # Intervals — e.g. sprint intervals, treadmill intervals.
            # One "set" = one interval block.
            if role == "primary":
                sets, reps, rest = 6, "30-45s", 90
            elif role == "secondary":
                sets, reps, rest = 3, "5 min", 60
            else:  # cooldown
                sets, reps, rest = 1, "3-5 min", 0
            return Prescription(sets=sets, reps=reps, rest_seconds=rest, rir_target=1.0)
        # Steady-state — e.g. jog, easy bike.
        if role == "primary":
            sets, reps, rest = 1, "25-40 min", 0
        elif role == "secondary":
            sets, reps, rest = 1, "5-10 min", 0
        else:  # cooldown / isolation slot
            sets, reps, rest = 1, "3-5 min", 0
        return Prescription(sets=sets, reps=reps, rest_seconds=rest, rir_target=1.0)

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
    elif bucket == "endurance":
        # Endurance strength-maintenance days — enough load to keep
        # muscle mass without fighting recovery from cardio. Low sets,
        # mid-rep hypertrophy range, short rest.
        if is_compound and role == "primary":
            reps = "6-10"
            rest = 120
            rir = 2.5
        elif is_compound:
            reps = "8-12"
            rest = 90
            rir = 2.5
        else:
            reps = "12-15"
            rest = 60
            rir = 2.0
    elif bucket == "athletic_performance":
        # Hybrid strength days inside an athletic plan lean on power
        # and explosive compound work: low reps, longer rest, higher
        # RIR buffer so quality stays high through the week's cardio
        # and conditioning days.
        if is_compound and role == "primary":
            reps = "3-5"
            rest = 180
            rir = 2.0
        elif is_compound:
            reps = "5-8"
            rest = 150
            rir = 2.0
        else:
            reps = "8-12"
            rest = 75
            rir = 2.0
    else:  # body_recomp / general_health / maintain
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


# ─── Archetype → slot dispatch ──────────────────────────────────────────────


def _archetype_to_slots(archetype, day_index: int, days_per_week: int) -> list[Slot]:
    """Turn a `DayArchetype` into a concrete slot list.

    This is the single dispatch point between archetype and slot-level
    structure. Lifting archetypes delegate to the existing split slot
    builders (full body / upper / lower / push / pull / legs / bro);
    cardio archetypes use the conditioning builders; mobility and
    recovery use the new mobility/stretch builders; hybrid archetypes
    compose two builders.

    `day_index` and `days_per_week` are forwarded to builders that
    rotate emphasis across cycles (upper/lower/full-body each have
    their own rotation — endurance/mobility don't)."""
    from .archetypes import DayArchetype as _DA
    if archetype == _DA.LIFT_FULL_BODY:
        return _full_body_slots(day_index)
    if archetype == _DA.LIFT_UPPER:
        return _upper_slots(day_index // 2)
    if archetype == _DA.LIFT_LOWER:
        return _lower_slots(day_index // 2)
    if archetype == _DA.LIFT_PUSH:
        return _push_slots()
    if archetype == _DA.LIFT_PULL:
        return _pull_slots()
    if archetype == _DA.LIFT_LEGS:
        return _legs_slots()
    if archetype == _DA.LIFT_BRO_CHEST:
        return _BRO_SLOT_SEQUENCE[0]
    if archetype == _DA.LIFT_BRO_BACK:
        return _BRO_SLOT_SEQUENCE[1]
    if archetype == _DA.LIFT_BRO_SHOULDERS:
        return _BRO_SLOT_SEQUENCE[2]
    if archetype == _DA.LIFT_BRO_ARMS:
        return _BRO_SLOT_SEQUENCE[3]
    if archetype == _DA.LIFT_BRO_LEGS:
        return _BRO_SLOT_SEQUENCE[4]
    if archetype == _DA.LIFT_STRENGTH_MAINTENANCE:
        return _strength_maintenance_slots()

    # Conditioning
    if archetype == _DA.COND_ZONE2:
        return _cardio_steady_slots()
    if archetype == _DA.COND_INTERVALS_SHORT:
        return _cardio_intervals_slots()
    if archetype == _DA.COND_INTERVALS_LONG:
        return _cardio_intervals_slots()  # shares layout; prescription differs
    if archetype == _DA.COND_TEMPO:
        return [
            Slot("Cardio Warmup",       "cardio", None, "secondary"),
            Slot("Tempo Block",         "cardio", None, "primary"),
            Slot("Cardio Cooldown",     "cardio", None, "isolation"),
        ]
    if archetype == _DA.COND_MIXED:
        return _cardio_mixed_slots()
    if archetype == _DA.COND_SPRINT_POWER:
        return [
            Slot("Cardio Warmup",  "cardio",     None,    "secondary"),
            Slot("Main Sprints",   "cardio",     None,    "primary"),
            Slot("Plyometric",     "plyometric", "quads", "secondary"),
            Slot("Cardio Cooldown","cardio",     None,    "isolation"),
        ]
    if archetype == _DA.COND_CIRCUIT:
        return _circuit_slots()

    # Mobility / recovery
    if archetype == _DA.MOBILITY_FLOW:
        return _mobility_flow_slots()
    if archetype == _DA.STRETCH_BLOCK:
        return _stretch_block_slots()
    if archetype == _DA.RECOVERY_EASY:
        return _recovery_easy_slots()
    if archetype == _DA.STRESS_RELIEF_EASY:
        return _stress_relief_slots()

    # Hybrid
    if archetype == _DA.HYBRID_STRENGTH_INTERVALS:
        return _hybrid_strength_intervals_slots()
    if archetype == _DA.HYBRID_UPPER_INTERVALS:
        return _hybrid_upper_intervals_slots()
    if archetype == _DA.HYBRID_LOWER_POWER:
        return _hybrid_lower_power_slots()
    if archetype == _DA.HYBRID_FULL_BODY_CIRCUIT:
        return _hybrid_full_body_circuit_slots()

    # Unknown archetype — safe fallback to full body.
    return _full_body_slots(day_index)


def _archetype_day_name(archetype, day_index: int, recipe: list) -> str:
    """Build the user-facing day name from an archetype and its
    position in the recipe. When the same archetype appears multiple
    times in the recipe we number it (Upper 1, Upper 2, …)."""
    from .archetypes import ARCHETYPE_META
    base = ARCHETYPE_META[archetype].default_name
    # How many times has this archetype appeared up to this index?
    seen_before = sum(1 for a in recipe[:day_index] if a == archetype)
    total = sum(1 for a in recipe if a == archetype)
    if total > 1:
        return f"{base} {seen_before + 1}"
    return base


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
    # ── Multi-goal planning pipeline ──────────────────────────────
    # 1. Resolve a GoalProfile from the user's goal id.
    # 2. Generate a weekly DayArchetype recipe from (profile, days).
    # 3. For each archetype, get its slot list via the archetype
    #    dispatch table (which reuses the lifting / cardio / mobility
    #    slot builders below).
    # 4. Prescription dispatch happens per slot via `prescribe_for_slot`
    #    so cardio slots get duration-shaped reps, mobility slots get
    #    holds/flows, lifting slots get sets × reps × rest.
    # Everything else (history, volume audit, focused-muscle deficit
    # pass, injury filtering) runs on top of this new structure.
    from .goal_profiles import goal_profile_for
    from .weekly_recipe import generate_weekly_recipe
    from .prescriptions import prescribe_for_slot
    from .archetypes import ARCHETYPE_META, DayArchetype

    profile = goal_profile_for(
        inputs.goal,
        experience=inputs.experience,
        days_per_week=inputs.days_per_week,
        session_minutes=inputs.session_minutes,
    )
    # Lifting-based profiles still go through `pick_split` so the
    # existing split matrix owns "which lifting split fits the user
    # today". Non-lifting modes don't use a split at all. `fat_loss_mix`
    # is lifting-adjacent — it needs a split for its lifting days.
    lifting_split = (
        pick_split(inputs)
        if profile.planner_mode in ("lifting", "fat_loss_mix")
        else None
    )
    recipe = generate_weekly_recipe(
        profile,
        inputs.days_per_week,
        lifting_split=lifting_split,
    )
    print(
        f"[workout_planner] mode={profile.planner_mode} "
        f"days={inputs.days_per_week} recipe=[" +
        ", ".join(a.value for a in recipe) + "]"
    )
    # Build a concrete (name, slots, archetype) sequence from the recipe.
    templates = []
    for idx, archetype in enumerate(recipe):
        slots = _archetype_to_slots(archetype, idx, inputs.days_per_week)
        name = _archetype_day_name(archetype, idx, recipe)
        # Time budget shapes slot density for every archetype, not just
        # lifting. Short sessions drop trailing low-priority slots.
        slots = _density_adjust_slots(slots, inputs.session_minutes)
        templates.append((name, slots, archetype))
    targets = weekly_set_targets(inputs)
    # Injury-aware movement-pattern blocklist. Built once from the
    # user's injury tags and passed into every slot pick.
    blocked_patterns = _injury_blocked_patterns(inputs.injuries)
    if blocked_patterns:
        print(f"[workout_planner] injury-blocked patterns: {sorted(blocked_patterns)}")
    # Running tally of assigned working sets per primary muscle. The
    # scorer reads this every pick and nudges selection toward muscles
    # under target and away from muscles over target. Primary muscles
    # count at 1.0, secondary muscles at 0.5 — standard practice since
    # they receive real stimulus but less than the primary mover.
    assigned: dict[str, float] = {}

    def _credit(ex: dict, sets: int) -> None:
        pm = ex.get("primary_muscle") or ""
        if pm:
            assigned[pm] = assigned.get(pm, 0.0) + float(sets)
        for sm in ex.get("secondary_muscles") or []:
            if not sm:
                continue
            assigned[sm] = assigned.get(sm, 0.0) + float(sets) * 0.5

    used_substitution_groups: set[str] = set()
    used_exercise_slugs: set[str] = set()

    days_out: list[dict] = []
    for day_idx, (day_name, slots, archetype) in enumerate(templates):
        # Focus label comes from the archetype metadata, not from
        # splitting the display name.
        meta = ARCHETYPE_META[archetype]
        focus = meta.default_name
        accepts_types = meta.accepts_types
        exercises_out: list[dict] = []
        for slot in slots:
            # Per-slot type override: strength-slot inside a hybrid
            # circuit day still wants `{"strength"}`; a cardio
            # finisher inside the same day wants `{"cardio"}`. The
            # slot's movement_pattern tells us which one.
            slot_accepts = (
                frozenset({"cardio"}) if slot.movement_pattern == "cardio"
                else frozenset({"mobility"}) if slot.movement_pattern == "mobility"
                else frozenset({"strength"}) if "strength" in accepts_types
                else accepts_types
            )
            ex = pick_for_slot(
                all_exercises, slot, inputs,
                used_substitution_groups, used_exercise_slugs,
                history_familiarity,
                volume_targets=targets,
                volume_assigned=assigned,
                injury_blocked_patterns=blocked_patterns,
                accepts_types=slot_accepts,
            )
            if ex is None:
                print(f"[workout_planner] slot '{slot.label}' had no eligible exercise")
                continue
            prescription = prescribe_for_slot(archetype, slot, ex, inputs)
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
                "_secondary_muscles": list(ex.get("secondary_muscles") or []),
                "_archetype": archetype.value,
                "_training_type": meta.training_type,
            })
            _credit(ex, prescription.sets)
            sub = ex.get("substitution_group")
            if sub:
                used_substitution_groups.add(sub)
            if ex.get("slug"):
                used_exercise_slugs.add(ex["slug"])
        days_out.append({
            "day": day_name,
            "focus": focus,
            "archetype": archetype.value,
            "category": meta.category,
            "exercises": exercises_out,
        })

    # ── Focused-muscle deficit pass ───────────────────────────────────
    # If the user specified a focused muscle but after the template
    # sweep they're still ≥1 full set below target, append one isolation
    # accessory for that muscle to whichever day already hits it (so
    # recovery isn't orphaned). This is the only place we add exercises
    # beyond the template; it only fires when a deficit actually exists.
    fm = inputs.focused_muscle
    if fm and targets.get(fm, 0) > 0:
        deficit = targets[fm] - assigned.get(fm, 0.0)
        if deficit >= 1.0:
            host_day_idx = _find_best_accessory_host_day(days_out, fm)
            if host_day_idx is not None:
                slot = Slot("Focus Accessory", "isolation", fm, "isolation")
                ex = pick_for_slot(
                    all_exercises, slot, inputs,
                    used_substitution_groups, used_exercise_slugs,
                    history_familiarity,
                    volume_targets=targets,
                    volume_assigned=assigned,
                    injury_blocked_patterns=blocked_patterns,
                    accepts_types=frozenset({"strength"}),
                )
                if ex is not None:
                    pres = prescribe_sets_reps(ex, slot, inputs)
                    days_out[host_day_idx]["exercises"].append({
                        "name": ex["name"],
                        "sets": pres.sets,
                        "reps": pres.reps,
                        "restSeconds": pres.rest_seconds,
                        "equipment": _equipment_label(ex),
                        "_slug": ex.get("slug"),
                        "_slot": slot.label,
                        "_role": slot.role,
                        "_rir_target": pres.rir_target,
                        "_primary_muscle": ex.get("primary_muscle"),
                        "_secondary_muscles": list(ex.get("secondary_muscles") or []),
                    })
                    _credit(ex, pres.sets)

    # Volume audit attached to the plan for transparency. Clients that
    # don't read it ignore it; the test suite uses it to assert the
    # volume balancer actually shifted something.
    volume_audit = {
        "targets": targets,
        "assigned": {k: round(v, 1) for k, v in assigned.items()},
        "focused_muscle": fm,
    }

    plan_name_suffix = (
        lifting_split.replace("_", " ").title()
        if lifting_split
        else profile.planner_mode.replace("_", " ").title()
    )
    return {
        "trainerNote": "",  # left empty so the caller can fill via AI if desired
        "workout_plan": {
            "name": f"{profile.label} — {plan_name_suffix}",
            "totalDays": inputs.days_per_week,
            "days": days_out,
            "volume_audit": volume_audit,
            "planner_mode": profile.planner_mode,
            "goal_bucket": profile.bucket,
        },
    }


def _find_best_accessory_host_day(days_out: list[dict], muscle: str) -> int | None:
    """Pick which day should host an extra accessory set for `muscle`.

    Preference ladder (lower priority number = preferred):

      0. A day that hits the muscle as a SECONDARY mover (and not
         primary). These days touch the muscle without being near MRV,
         so adding an accessory distributes volume without stacking on
         an already-heavy primary day.
      1. A day that hits the muscle as a PRIMARY mover. Grouped
         recovery, but closer to MRV — second choice.
      2. A day that doesn't train the muscle at all. Last resort — we
         still pick the least-loaded one to distribute session length.

    Within each priority band, ties break on fewest total exercises so
    we don't pile onto an already-full session. The old implementation
    only checked `_primary_muscle` even though the docstring promised
    primary-OR-secondary detection — that's the bug this fixes."""
    if not days_out:
        return None
    scored: list[tuple[int, int, int]] = []  # (priority, ex_count, idx)
    for idx, day in enumerate(days_out):
        exs = day.get("exercises") or []
        hits_primary = any(ex.get("_primary_muscle") == muscle for ex in exs)
        hits_secondary = any(
            muscle in (ex.get("_secondary_muscles") or []) for ex in exs
        )
        if hits_secondary and not hits_primary:
            priority = 0
        elif hits_primary:
            priority = 1
        else:
            priority = 2
        scored.append((priority, len(exs), idx))
    scored.sort()
    return scored[0][2]


# ─── Session density + injury filter helpers ────────────────────────────────


# Rough minutes budget per slot role. Used by `_density_adjust_slots` to
# trim templates that don't fit the user's configured session time.
# Numbers cover warmup + working sets + inter-set rest for each role.
_ROLE_MINUTES = {
    "primary":    12,
    "secondary":   8,
    "isolation":   6,
    "core":        4,
}


def _density_adjust_slots(slots: list[Slot], session_minutes: int | None) -> list[Slot]:
    """Trim trailing low-priority slots until the remaining set fits the
    user's `session_minutes` budget.

    Rules:
      - If `session_minutes` is missing or 0, keep the whole template.
      - Compute the template's estimated minutes from `_ROLE_MINUTES`.
      - If we fit, return as-is.
      - Otherwise drop the highest-indexed `core` slot, then highest
        `isolation`, then highest `secondary`. Never drop `primary`
        slots — compounds are the anchor of the session.
      - Minimum output is the full set of primary+secondary slots;
        if even those don't fit, return them anyway (the user gave us
        a budget that's too short for their split — a trainer would
        still prioritize compounds over skipping them).

    Short sessions therefore stay compound-heavy; long sessions keep
    every accessory the template defines. This is the deterministic
    counterpart to the focused-muscle accessory pass below.
    """
    if not session_minutes or session_minutes <= 0:
        return list(slots)
    budget = max(20, min(180, int(session_minutes)))
    total = sum(_ROLE_MINUTES.get(s.role, 6) for s in slots)
    if total <= budget:
        return list(slots)

    kept = list(slots)
    drop_order = ("core", "isolation", "secondary")
    for role in drop_order:
        while total > budget:
            # Find the last slot of this role
            drop_idx: int | None = None
            for i in range(len(kept) - 1, -1, -1):
                if kept[i].role == role:
                    drop_idx = i
                    break
            if drop_idx is None:
                break
            total -= _ROLE_MINUTES.get(role, 6)
            kept.pop(drop_idx)
        if total <= budget:
            break
    return kept


# Injury tags → movement patterns to exclude. Keys are lower-cased and
# whitespace/punctuation is stripped before lookup. Prefix match is
# also attempted so "left_knee" resolves via the "knee" entry.
#
# These are conservative defaults a real trainer would apply — not a
# medical recommendation. Users can always override by toggling the
# specific exercise off in their disliked list.
_INJURY_BLOCKED_PATTERNS: dict[str, set[str]] = {
    "shoulder":             {"vertical_press"},
    "rotator_cuff":         {"vertical_press"},
    "shoulder_impingement": {"vertical_press"},
    "ac_joint":             {"vertical_press"},
    "lower_back":           {"hinge"},
    "low_back":             {"hinge"},
    "lumbar":               {"hinge"},
    "herniated_disc":       {"hinge", "squat"},
    "sciatica":             {"hinge"},
    "knee":                 {"lunge"},
    "patellar":             {"lunge"},
    "patellar_tendonitis":  {"lunge"},
    "meniscus":             {"squat", "lunge"},
    "acl":                  {"squat", "lunge"},
    "mcl":                  {"lunge"},
    "hip":                  {"hinge"},
    "hip_flexor":           {"hinge"},
    "ankle":                {"lunge"},
    "achilles":             {"lunge"},
    # Elbow / wrist are tracked so future scorer penalties can read
    # them, but they don't block a whole movement pattern today.
    "elbow":                set(),
    "tennis_elbow":         set(),
    "golfer_elbow":         set(),
    "wrist":                set(),
}


def _injury_blocked_patterns(injuries: tuple[str, ...] | list[str] | None) -> set[str]:
    """Return the union of movement patterns blocked by the user's
    injury tags. Tags are normalized (lowercase, underscores) and
    matched against `_INJURY_BLOCKED_PATTERNS` with a substring
    fallback so `"left knee pain"` still resolves via `"knee"`."""
    if not injuries:
        return set()
    blocked: set[str] = set()
    for inj in injuries:
        if not inj:
            continue
        key = "".join(
            ch if ch.isalnum() or ch == "_" else "_"
            for ch in str(inj).lower().strip()
        )
        # Exact match first
        if key in _INJURY_BLOCKED_PATTERNS:
            blocked |= _INJURY_BLOCKED_PATTERNS[key]
            continue
        # Substring fallback — "left_knee_pain" → "knee"
        for known, patterns in _INJURY_BLOCKED_PATTERNS.items():
            if known and known in key:
                blocked |= patterns
    return blocked


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
      4. Set `target_weight_lbs` and adjust the rep range on the next
         plan's exercise dict.
    """
    return next_plan
