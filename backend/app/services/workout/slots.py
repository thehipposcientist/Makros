"""Slot dataclass + every slot builder + archetype-aware density trimming.

Before this module, every slot builder lived inside `planner.py` alongside
scoring, selection, filter logic, prescription dispatch, the weekly-recipe
orchestrator, and volume targets. That made the service file ~1800 lines
and a "secret god object." This module pulls the slot / template
responsibility out so the planner service can focus on orchestration.

Nothing in here imports from `planner.py`. Everything planner.py needs
(the `Slot` dataclass, every slot builder, the density-trim function)
is exposed from here. Circular-import-free by construction.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ─── Slot dataclass ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Slot:
    """One slot in a day template — a movement pattern + role + muscle hint.

    The selection engine in `planner.py` fills each slot from the user's
    eligible exercise pool by matching `movement_pattern` and using
    `primary_muscle_hint` to break ties when the slot is an isolation
    slot. Compound-role slots ignore the muscle hint on purpose — a
    horizontal-press slot should accept any valid horizontal press
    regardless of whether the seed labels it as chest or shoulders.
    """
    label: str                           # human-readable, e.g. "Primary Press"
    movement_pattern: str                # matches Exercise.movement_pattern
    primary_muscle_hint: Optional[str]   # preferred primary_muscle for tie-break
    role: str                            # "primary" | "secondary" | "isolation" | "core"


# ─── Lifting slot builders ──────────────────────────────────────────


def _full_body_slots(day_index: int) -> list[Slot]:
    """Full-body day. Rotates across three themes so consecutive
    sessions don't repeat the exact same exercises."""
    _warmup = Slot("Warmup Mobility", "mobility", "full_body", "warmup")
    if day_index % 3 == 0:
        return [
            _warmup,
            Slot("Squat Pattern",     "squat",            "quads",       "primary"),
            Slot("Horizontal Press",  "horizontal_press", "chest",       "primary"),
            Slot("Horizontal Pull",   "horizontal_pull",  "back",        "primary"),
            Slot("Hinge Accessory",   "hinge",            "hamstrings",  "secondary"),
            Slot("Core",              "anti_extension",   "core",        "core"),
        ]
    if day_index % 3 == 1:
        return [
            _warmup,
            Slot("Hinge Pattern",     "hinge",            "hamstrings",  "primary"),
            Slot("Vertical Press",    "vertical_press",   "shoulders",   "primary"),
            Slot("Vertical Pull",     "vertical_pull",    "back",        "primary"),
            Slot("Lunge / Single-leg","lunge",            "quads",       "secondary"),
            Slot("Core",              "anti_extension",   "core",        "core"),
        ]
    return [
        _warmup,
        Slot("Squat Pattern",     "squat",            "quads",       "primary"),
        Slot("Horizontal Press",  "horizontal_press", "chest",       "secondary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",        "primary"),
        Slot("Hinge",             "hinge",            "glutes",      "secondary"),
        Slot("Core",              "anti_extension",   "core",        "core"),
    ]


def _upper_slots(cycle_index: int) -> list[Slot]:
    """Upper-body day with rotating emphasis (horizontal → vertical →
    balanced) so Upper 1 / Upper 2 / Upper 3 feel materially different."""
    _warmup = Slot("Warmup Mobility", "mobility", "shoulders", "warmup")
    if cycle_index % 3 == 0:
        return [
            _warmup,
            Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
            Slot("Primary Pull",      "horizontal_pull",  "back",      "primary"),
            Slot("Secondary Press",   "horizontal_press", "chest",     "secondary"),
            Slot("Secondary Pull",    "horizontal_pull",  "back",      "secondary"),
            Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
            Slot("Biceps",            "isolation",        "biceps",    "isolation"),
            Slot("Triceps",           "isolation",        "triceps",   "isolation"),
        ]
    if cycle_index % 3 == 1:
        return [
            _warmup,
            Slot("Vertical Press",    "vertical_press",   "shoulders", "primary"),
            Slot("Vertical Pull",     "vertical_pull",    "back",      "primary"),
            Slot("Horizontal Press",  "horizontal_press", "chest",     "secondary"),
            Slot("Horizontal Pull",   "horizontal_pull",  "back",      "secondary"),
            Slot("Rear Delt",         "isolation",        "shoulders", "isolation"),
            Slot("Biceps",            "isolation",        "biceps",    "isolation"),
            Slot("Triceps",           "isolation",        "triceps",   "isolation"),
        ]
    return [
        _warmup,
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Primary Pull",      "horizontal_pull",  "back",      "primary"),
        Slot("Vertical Press",    "vertical_press",   "shoulders", "secondary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",      "secondary"),
        Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
        Slot("Biceps",            "isolation",        "biceps",    "isolation"),
        Slot("Triceps",           "isolation",        "triceps",   "isolation"),
    ]


def _lower_slots(cycle_index: int) -> list[Slot]:
    """Lower-body day with squat / hinge / balanced rotation."""
    _warmup = Slot("Warmup Mobility", "mobility", "hips", "warmup")
    if cycle_index % 3 == 0:
        return [
            _warmup,
            Slot("Squat Pattern",     "squat",            "quads",      "primary"),
            Slot("Single-leg",        "lunge",            "quads",      "secondary"),
            Slot("Hinge Pattern",     "hinge",            "hamstrings", "secondary"),
            Slot("Quad Isolation",    "isolation",        "quads",      "isolation"),
            Slot("Calves",            "isolation",        "calves",     "isolation"),
            Slot("Core",              "anti_extension",   "core",       "core"),
        ]
    if cycle_index % 3 == 1:
        return [
            _warmup,
            Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
            Slot("Squat Pattern",     "squat",            "quads",      "secondary"),
            Slot("Single-leg",        "lunge",            "glutes",     "secondary"),
            Slot("Hamstring Isolation","isolation",       "hamstrings", "isolation"),
            Slot("Calves",            "isolation",        "calves",     "isolation"),
            Slot("Core",              "anti_extension",   "core",       "core"),
        ]
    return [
        _warmup,
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Single-leg",        "lunge",            "quads",      "secondary"),
        Slot("Hamstring Accessory","isolation",       "hamstrings", "isolation"),
        Slot("Calves",            "isolation",        "calves",     "isolation"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


def _push_slots() -> list[Slot]:
    return [
        Slot("Warmup Mobility",   "mobility",         "shoulders", "warmup"),
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Vertical Press",    "vertical_press",   "shoulders", "primary"),
        Slot("Secondary Press",   "horizontal_press", "chest",     "secondary"),
        Slot("Lateral Delt",      "isolation",        "shoulders", "isolation"),
        Slot("Triceps Compound",  "isolation",        "triceps",   "isolation"),
        Slot("Triceps Isolation", "isolation",        "triceps",   "isolation"),
    ]


def _pull_slots() -> list[Slot]:
    return [
        Slot("Warmup Mobility",   "mobility",         "back",   "warmup"),
        Slot("Vertical Pull",     "vertical_pull",    "back",   "primary"),
        Slot("Horizontal Pull",   "horizontal_pull",  "back",   "primary"),
        Slot("Secondary Pull",    "horizontal_pull",  "back",   "secondary"),
        Slot("Rear Delt",         "isolation",        "shoulders", "isolation"),
        Slot("Bicep Curl",        "isolation",        "biceps", "isolation"),
        Slot("Bicep Variation",   "isolation",        "biceps", "isolation"),
    ]


def _legs_slots() -> list[Slot]:
    return [
        Slot("Warmup Mobility",   "mobility",         "hips",       "warmup"),
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Single-leg",        "lunge",            "quads",      "secondary"),
        Slot("Hamstring Accessory","isolation",       "hamstrings", "isolation"),
        Slot("Calves",            "isolation",        "calves",     "isolation"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


def _strength_maintenance_slots() -> list[Slot]:
    """Compact full-body strength day used inside non-lifting plans
    (endurance, flexibility, stress relief, maintain). Keeps muscle
    mass without fighting recovery from the user's primary goal."""
    return [
        Slot("Warmup Mobility",   "mobility",         "full_body",  "warmup"),
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Horizontal Press",  "horizontal_press", "chest",      "primary"),
        Slot("Horizontal Pull",   "horizontal_pull",  "back",       "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "secondary"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


# Bro-split day slot lists keyed by position in the weekly rotation.
_BRO_SLOT_SEQUENCE: list[list[Slot]] = [
    # Chest
    [
        Slot("Warmup Mobility",  "mobility",         "shoulders", "warmup"),
        Slot("Primary Press",    "horizontal_press", "chest", "primary"),
        Slot("Incline Press",    "horizontal_press", "chest", "secondary"),
        Slot("Chest Fly",        "isolation",        "chest", "isolation"),
        Slot("Tricep Compound",  "isolation",        "triceps", "isolation"),
        Slot("Tricep Isolation", "isolation",        "triceps", "isolation"),
    ],
    # Back
    [
        Slot("Warmup Mobility",  "mobility",        "back",  "warmup"),
        Slot("Vertical Pull",    "vertical_pull",   "back",  "primary"),
        Slot("Horizontal Pull",  "horizontal_pull", "back",  "primary"),
        Slot("Secondary Row",    "horizontal_pull", "back",  "secondary"),
        Slot("Rear Delt",        "isolation",       "shoulders", "isolation"),
        Slot("Bicep Curl",       "isolation",       "biceps", "isolation"),
    ],
    # Shoulders
    [
        Slot("Warmup Mobility",  "mobility",        "shoulders", "warmup"),
        Slot("Vertical Press",   "vertical_press",  "shoulders", "primary"),
        Slot("Lateral Raise",    "isolation",       "shoulders", "isolation"),
        Slot("Rear Delt Fly",    "isolation",       "shoulders", "isolation"),
        Slot("Upright Row",      "vertical_pull",   "shoulders", "secondary"),
        Slot("Shrug",            "isolation",       "traps",     "isolation"),
    ],
    # Arms
    [
        Slot("Warmup Mobility",  "mobility",  "shoulders", "warmup"),
        Slot("Bicep Curl",       "isolation", "biceps", "primary"),
        Slot("Tricep Press",     "isolation", "triceps", "primary"),
        Slot("Hammer Curl",      "isolation", "biceps", "secondary"),
        Slot("Overhead Tri",     "isolation", "triceps", "secondary"),
    ],
    # Legs
    _legs_slots(),
]


# ─── Stimulus-differentiated lifting slot builders ─────────────────


def _upper_heavy_slots() -> list[Slot]:
    """Upper heavy day: fewer slots, heavier per exercise."""
    return [
        Slot("Warmup Mobility",          "mobility",         "shoulders", "warmup"),
        Slot("Primary Horizontal Press", "horizontal_press", "chest",     "primary"),
        Slot("Primary Vertical Press",   "vertical_press",   "shoulders", "primary"),
        Slot("Horizontal Pull",          "horizontal_pull",  "back",      "secondary"),
        Slot("Isolation",                "isolation",         "biceps",    "isolation"),
        Slot("Core",                     "anti_extension",   "core",      "core"),
    ]


def _upper_hypertrophy_slots() -> list[Slot]:
    """Upper hypertrophy day: more slots for variety + volume."""
    return [
        Slot("Warmup Mobility",   "mobility",         "shoulders", "warmup"),
        Slot("Primary Press",     "horizontal_press", "chest",     "primary"),
        Slot("Secondary Pull",    "horizontal_pull",  "back",      "secondary"),
        Slot("Secondary Press",   "vertical_press",   "shoulders", "secondary"),
        Slot("Chest Isolation",   "isolation",         "chest",     "isolation"),
        Slot("Back Isolation",    "isolation",         "back",      "isolation"),
        Slot("Arm Isolation",     "isolation",         "biceps",    "isolation"),
        Slot("Core",              "anti_extension",    "core",      "core"),
    ]


def _lower_heavy_slots() -> list[Slot]:
    """Lower heavy day: fewer slots, heavier per exercise."""
    return [
        Slot("Warmup Mobility",  "mobility",       "hips",       "warmup"),
        Slot("Primary Squat",    "squat",          "quads",      "primary"),
        Slot("Primary Hinge",    "hinge",          "hamstrings", "primary"),
        Slot("Secondary Lunge",  "lunge",          "quads",      "secondary"),
        Slot("Glute Isolation",  "isolation",       "glutes",    "isolation"),
        Slot("Core",             "anti_extension",  "core",      "core"),
    ]


def _lower_hypertrophy_slots() -> list[Slot]:
    """Lower hypertrophy day: more slots for variety + volume."""
    return [
        Slot("Warmup Mobility",      "mobility",      "hips",       "warmup"),
        Slot("Primary Squat",        "squat",         "quads",      "primary"),
        Slot("Primary Hinge",        "hinge",         "hamstrings", "primary"),
        Slot("Secondary Lunge",      "lunge",         "quads",      "secondary"),
        Slot("Quad Isolation",       "isolation",      "quads",     "isolation"),
        Slot("Hamstring Isolation",  "isolation",      "hamstrings","isolation"),
        Slot("Core",                 "anti_extension", "core",      "core"),
        Slot("Calves",               "isolation",      "calves",    "isolation"),
    ]


def _push_volume_slots() -> list[Slot]:
    """Push volume day: moderate weight, higher reps."""
    return [
        Slot("Warmup Mobility",     "mobility",         "shoulders", "warmup"),
        Slot("Primary Press",       "horizontal_press", "chest",     "primary"),
        Slot("Secondary Press A",   "vertical_press",   "shoulders", "secondary"),
        Slot("Secondary Press B",   "horizontal_press", "chest",     "secondary"),
        Slot("Chest Isolation",     "isolation",         "chest",     "isolation"),
        Slot("Triceps Isolation",   "isolation",         "triceps",   "isolation"),
        Slot("Core",                "anti_extension",    "core",      "core"),
    ]


def _pull_volume_slots() -> list[Slot]:
    """Pull volume day: moderate weight, higher reps."""
    return [
        Slot("Warmup Mobility",    "mobility",         "back",      "warmup"),
        Slot("Primary Pull",       "vertical_pull",    "back",      "primary"),
        Slot("Secondary Pull A",   "horizontal_pull",  "back",      "secondary"),
        Slot("Secondary Pull B",   "horizontal_pull",  "back",      "secondary"),
        Slot("Biceps Isolation",   "isolation",         "biceps",    "isolation"),
        Slot("Rear Delt Isolation","isolation",         "shoulders", "isolation"),
        Slot("Core",               "anti_extension",    "core",      "core"),
    ]


def _legs_volume_slots() -> list[Slot]:
    """Legs volume day: moderate weight, higher reps."""
    return [
        Slot("Warmup Mobility",    "mobility",       "hips",       "warmup"),
        Slot("Primary Squat",      "squat",          "quads",      "primary"),
        Slot("Primary Hinge",      "hinge",          "hamstrings", "primary"),
        Slot("Secondary Lunge",    "lunge",          "quads",      "secondary"),
        Slot("Leg Press",          "squat",          "quads",      "secondary"),
        Slot("Quad Isolation",     "isolation",       "quads",     "isolation"),
        Slot("Hamstring Isolation","isolation",       "hamstrings","isolation"),
        Slot("Calves",             "isolation",       "calves",    "isolation"),
    ]


def _full_body_strength_slots() -> list[Slot]:
    """Full body strength day: 5 heavy compound slots."""
    return [
        Slot("Warmup Mobility",   "mobility",         "full_body",  "warmup"),
        Slot("Squat Pattern",     "squat",            "quads",      "primary"),
        Slot("Hinge Pattern",     "hinge",            "hamstrings", "primary"),
        Slot("Horizontal Press",  "horizontal_press", "chest",      "primary"),
        Slot("Vertical Pull",     "vertical_pull",    "back",       "primary"),
        Slot("Core",              "anti_extension",   "core",       "core"),
    ]


# ─── Conditioning slot builders ─────────────────────────────────────
#
# Cardio slots all share `movement_pattern="cardio"` and leave
# `primary_muscle_hint=None` so the filter doesn't constrain to a
# specific muscle — cardio picks are categorized by `primary_muscle`
# values of "cardio" or "full_body" in the seed.


def _cardio_intervals_slots() -> list[Slot]:
    """Interval day: warmup, main intervals, cooldown."""
    return [
        Slot("Cardio Warmup",   "cardio", None, "secondary"),
        Slot("Main Intervals",  "cardio", None, "primary"),
        Slot("Cardio Cooldown", "cardio", None, "isolation"),
    ]


def _cardio_steady_slots() -> list[Slot]:
    """Steady-state cardio day — one main block, one short cooldown."""
    return [
        Slot("Steady-State Cardio", "cardio", None, "primary"),
        Slot("Cardio Cooldown",     "cardio", None, "isolation"),
    ]


def _cardio_mixed_slots() -> list[Slot]:
    """Mixed day — intervals then easy spin."""
    return [
        Slot("Cardio Warmup",   "cardio", None, "secondary"),
        Slot("Main Intervals",  "cardio", None, "primary"),
        Slot("Easy Spin",       "cardio", None, "secondary"),
        Slot("Cardio Cooldown", "cardio", None, "isolation"),
    ]


def _cardio_tempo_slots() -> list[Slot]:
    """Tempo / threshold block with short warmup + cooldown."""
    return [
        Slot("Cardio Warmup",   "cardio", None, "secondary"),
        Slot("Tempo Block",     "cardio", None, "primary"),
        Slot("Cardio Cooldown", "cardio", None, "isolation"),
    ]


def _cardio_sprint_power_slots() -> list[Slot]:
    """Sprint + plyometric power day."""
    return [
        Slot("Cardio Warmup",  "cardio",     None,    "secondary"),
        Slot("Main Sprints",   "cardio",     None,    "primary"),
        Slot("Plyometric",     "plyometric", "quads", "secondary"),
        Slot("Cardio Cooldown","cardio",     None,    "isolation"),
    ]


# ─── Mobility / recovery slot builders ─────────────────────────────


def _mobility_flow_slots() -> list[Slot]:
    """Full-body mobility flow. Every slot uses
    `movement_pattern="mobility"` which matches the mobility-bucket
    exercises in the seed (cat_cow, world's greatest stretch, etc.)."""
    return [
        Slot("Spine Mobility",    "mobility", None, "primary"),
        Slot("Hip Mobility",      "mobility", None, "primary"),
        Slot("Shoulder Mobility", "mobility", None, "secondary"),
        Slot("Ankle Mobility",    "mobility", None, "secondary"),
        Slot("Flow Finisher",     "mobility", None, "isolation"),
    ]


def _stretch_block_slots() -> list[Slot]:
    """Focused static stretch session — longer holds, fewer slots."""
    return [
        Slot("Lower Body Stretch", "mobility", None, "primary"),
        Slot("Upper Body Stretch", "mobility", None, "primary"),
        Slot("Spine Stretch",      "mobility", None, "secondary"),
        Slot("Final Stretch",      "mobility", None, "isolation"),
    ]


def _recovery_easy_slots() -> list[Slot]:
    """Easy recovery cardio — single block, low intensity."""
    return [
        Slot("Easy Cardio", "cardio", None, "primary"),
    ]


def _stress_relief_slots() -> list[Slot]:
    """Stress-relief session — easy cardio block plus gentle mobility."""
    return [
        Slot("Easy Movement", "cardio",   None, "primary"),
        Slot("Gentle Mobility","mobility", None, "isolation"),
    ]


# ─── Circuit / hybrid slot builders ────────────────────────────────


def _circuit_slots() -> list[Slot]:
    """Metabolic circuit — compounds at circuit tempo + cardio finisher.
    Prescription dispatch rewrites these to round-based formatting."""
    return [
        Slot("Circuit Press",   "horizontal_press", "chest",      "secondary"),
        Slot("Circuit Row",     "horizontal_pull",  "back",       "secondary"),
        Slot("Circuit Squat",   "squat",            "quads",      "secondary"),
        Slot("Circuit Core",    "anti_extension",   "core",       "core"),
        Slot("Circuit Finisher","cardio",           None,         "isolation"),
    ]


def _hybrid_lower_power_slots() -> list[Slot]:
    """Athletic lower-body power day: heavy compound + plyo + sprint."""
    return [
        Slot("Main Lower Lift", "squat",      "quads",      "primary"),
        Slot("Hinge Pattern",   "hinge",      "hamstrings", "secondary"),
        Slot("Plyometric",      "plyometric", "quads",      "secondary"),
        Slot("Sprint Finisher", "cardio",     None,         "isolation"),
    ]


def _hybrid_upper_intervals_slots() -> list[Slot]:
    """Upper body strength + interval finisher."""
    return [
        Slot("Horizontal Press", "horizontal_press", "chest", "primary"),
        Slot("Horizontal Pull",  "horizontal_pull",  "back",  "primary"),
        Slot("Vertical Press",   "vertical_press",   "shoulders", "secondary"),
        Slot("Interval Finisher","cardio",           None,     "isolation"),
    ]


def _hybrid_strength_intervals_slots() -> list[Slot]:
    """Combined strength + intervals session."""
    return [
        Slot("Main Lift",        "squat",      "quads",   "primary"),
        Slot("Press",            "horizontal_press", "chest", "primary"),
        Slot("Pull",             "horizontal_pull",  "back",  "secondary"),
        Slot("Interval Finisher","cardio",     None,     "isolation"),
    ]


def _hybrid_full_body_circuit_slots() -> list[Slot]:
    """Full-body circuit — compounds + cardio burst."""
    return [
        Slot("Squat",         "squat",            "quads", "primary"),
        Slot("Press",         "horizontal_press", "chest", "primary"),
        Slot("Pull",          "horizontal_pull",  "back",  "primary"),
        Slot("Hinge",         "hinge",            "hamstrings", "secondary"),
        Slot("Cardio Burst",  "cardio",           None,    "isolation"),
    ]


# ─── Archetype-aware density trimming ──────────────────────────────
#
# The role→minutes cost of a slot depends on what KIND of day it's
# part of. A "primary" lifting slot is ~12 minutes (warmup + 4 heavy
# compound sets + rest). A "primary" zone-2 cardio slot is the entire
# steady-state block — 25-30 minutes. A "primary" mobility slot is a
# short 3-5 minute drill. Using a single shared cost table forced
# short-session cardio to behave like short-session lifting, which
# was the bug this per-category table fixes.
_ROLE_MINUTES_BY_CATEGORY: dict[str, dict[str, int]] = {
    "lift": {"primary": 12, "secondary": 8, "isolation": 6, "core": 4, "warmup": 3},
    # Cardio primary = the main work block. Warmup/cooldown are short.
    "cond": {"primary": 25, "secondary": 6, "isolation": 4, "core": 4, "warmup": 3},
    # Mobility slots are quick drills; every slot is cheap.
    "mobility": {"primary": 5, "secondary": 4, "isolation": 3, "core": 3, "warmup": 3},
    # Recovery primary = an easy 15-25 min block.
    "recovery": {"primary": 18, "secondary": 5, "isolation": 3, "core": 3, "warmup": 3},
    # Hybrid days have both lift and cardio slots — we use
    # mid-weight numbers so neither side dominates trimming.
    "hybrid": {"primary": 10, "secondary": 8, "isolation": 6, "core": 4, "warmup": 3},
}
# Fallback when the caller doesn't know the category (backward-compat
# for any legacy code still calling `_density_adjust_slots` without
# a category — matches the old lifting-only costs).
_DEFAULT_ROLE_MINUTES = _ROLE_MINUTES_BY_CATEGORY["lift"]


def density_adjust_slots(
    slots: list[Slot],
    session_minutes: Optional[int],
    *,
    category: str = "lift",
) -> list[Slot]:
    """Trim low-priority slots until the remaining set fits the user's
    `session_minutes` budget, using a role-cost map keyed on the
    archetype's category so different day types trim realistically.

    Rules:
      - Missing / zero `session_minutes` → no trim.
      - If the template's estimated minutes fit, return as-is.
      - Otherwise drop the highest-indexed `core`, then `isolation`,
        then `secondary` until we fit. Primary slots are NEVER dropped.
      - Minimum output is the set of primaries; if those alone don't
        fit the budget we still return them (the user gave us a
        budget that's too short — a trainer would still prioritize
        compounds over skipping them).

    The old implementation used a single cost table keyed by role
    (lifting: primary=12, secondary=8, ...). That worked for lifting
    but treated a 25-minute zone-2 primary slot as if it were 12
    minutes, so short cardio sessions over-trimmed. The
    `category` argument picks the right cost map per archetype."""
    if not session_minutes or session_minutes <= 0:
        return list(slots)
    budget = max(20, min(180, int(session_minutes)))
    cost = _ROLE_MINUTES_BY_CATEGORY.get(category, _DEFAULT_ROLE_MINUTES)
    total = sum(cost.get(s.role, 6) for s in slots)
    if total <= budget:
        return list(slots)

    kept = list(slots)
    drop_order = ("warmup", "core", "isolation", "secondary")
    for role in drop_order:
        while total > budget:
            drop_idx: Optional[int] = None
            for i in range(len(kept) - 1, -1, -1):
                if kept[i].role == role:
                    drop_idx = i
                    break
            if drop_idx is None:
                break
            total -= cost.get(role, 6)
            kept.pop(drop_idx)
        if total <= budget:
            break
    return kept
