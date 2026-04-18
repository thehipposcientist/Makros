"""Weekly core planning — determines where and how direct core work appears.

Core is NOT hardcoded into every template. Instead, the planner runs a
post-recipe pass that injects core into the optimal days based on:
  1. Weekly exposure target (goal-dependent)
  2. Day-type priority (some days are better hosts than others)
  3. Movement pattern rotation (anti_extension / anti_rotation / anti_lateral_flexion)
  4. Slot preservation (don't delete high-value accessories)

This module is the single source of truth for all core scheduling decisions.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# ─── Core movement patterns ──────────────────────────────────────────────────

CORE_PATTERNS = ("anti_extension", "anti_rotation", "anti_lateral_flexion")

# Examples per pattern:
# anti_extension:       plank, ab wheel, dead bug, body saw, hollow hold
# anti_rotation:        Pallof press, cable woodchop, cable lift
# anti_lateral_flexion: side plank, suitcase carry, offset carry, Copenhagen plank

# ─── Weekly targets by goal ──────────────────────────────────────────────────

_WEEKLY_CORE_TARGETS: dict[str, int] = {
    "muscle_gain":          3,
    "strength":             2,
    "body_recomp":          3,
    "fat_loss":             4,
    "endurance":            3,
    "athletic_performance": 4,
    "hyrox":                4,
    "general_health":       3,
    "maintain":             2,
    "mobility":             2,
    "recovery":             0,
}

def weekly_core_target(goal: str, days_per_week: int) -> int:
    """How many direct core sessions this user should get per week."""
    base = _WEEKLY_CORE_TARGETS.get(goal, 3)
    # Scale down for low day counts — 2-day user shouldn't get 4 core days
    if days_per_week <= 2:
        return min(base, days_per_week)
    if days_per_week <= 3:
        return min(base, 2)
    return min(base, days_per_week - 1)  # always leave at least 1 day without core


# ─── Day-type priority for core insertion ─────────────────────────────────────

# Higher number = better candidate for core.
# The planner picks the top-N days from the recipe to receive core.
_DAY_CORE_PRIORITY: dict[str, int] = {
    # Best hosts — compound days with room for a finisher
    "lift_full_body":             10,
    "lift_full_body_strength":    10,
    "lift_lower":                  9,
    "lift_lower_heavy":            9,
    "lift_lower_hypertrophy":      9,
    "lift_legs":                   8,
    "lift_legs_heavy":             8,
    "lift_legs_volume":            7,
    "lift_upper":                  7,
    "lift_upper_heavy":            7,
    "lift_upper_hypertrophy":      7,
    # Acceptable — push/pull can host core as a finisher
    "lift_push":                   5,
    "lift_push_heavy":             5,
    "lift_push_volume":            5,
    "lift_pull":                   5,
    "lift_pull_heavy":             5,
    "lift_pull_volume":            5,
    "lift_strength_maintenance":   6,
    # Low priority — bro days should keep their bodypart focus
    "lift_bro_chest":              2,
    "lift_bro_back":               2,
    "lift_bro_shoulders":          2,
    "lift_bro_legs":               4,  # legs naturally pairs with core
    "lift_bro_arms":               0,  # never inject core into arms day
    # Skip — these have their own structure
    "cond_zone2":                  0,
    "cond_intervals_short":        0,
    "cond_intervals_long":         0,
    "cond_tempo":                  0,
    "cond_circuit":                1,  # circuits can optionally include core
    "cond_sprint_power":           0,
    "cond_mixed":                  0,
    "hybrid_strength_intervals":   0,
    "hybrid_upper_intervals":      0,
    "hybrid_lower_power":          0,
    "hybrid_full_body_circuit":    1,
    "mobility_flow":               0,
    "stretch_block":               0,
    "recovery_easy":               0,
    "stress_relief_easy":          0,
}


def core_priority_for_archetype(archetype_value: str) -> int:
    """Return core insertion priority (0=never, 10=ideal) for an archetype."""
    return _DAY_CORE_PRIORITY.get(archetype_value, 0)


# ─── Slot definition ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CoreSlot:
    """A core slot to be appended to a day's exercise list."""
    label: str
    movement_pattern: str
    primary_muscle_hint: str = "core"
    role: str = "core"


def pick_core_pattern(day_index: int) -> str:
    """Rotate across the 3 core movement patterns based on day index."""
    return CORE_PATTERNS[day_index % len(CORE_PATTERNS)]


def make_core_slot(day_index: int) -> CoreSlot:
    """Create a core slot with the appropriate movement pattern for this day."""
    pattern = pick_core_pattern(day_index)
    labels = {
        "anti_extension": "Core (Anti-Extension)",
        "anti_rotation": "Core (Anti-Rotation)",
        "anti_lateral_flexion": "Core (Lateral Stability)",
    }
    return CoreSlot(
        label=labels.get(pattern, "Core"),
        movement_pattern=pattern,
    )


# ─── Weekly core injection ────────────────────────────────────────────────────

_TEMPLATES_WITH_CORE = frozenset({
    "lift_full_body", "lift_full_body_strength",
    "lift_lower", "lift_lower_heavy", "lift_lower_hypertrophy",
    "lift_legs", "lift_legs_heavy",
    "lift_bro_legs",
    "lift_strength_maintenance",
    "lift_push_heavy", "lift_pull_heavy",
    "lift_push_volume", "lift_pull_volume",
    "lift_upper_heavy", "lift_upper_hypertrophy",
})


def select_core_days(
    recipe_values: list[str],
    goal: str,
    days_per_week: int,
) -> list[int]:
    """Given a weekly recipe (list of archetype value strings), return the
    indices of the days that should receive an INJECTED core slot.

    Days whose templates already include core are counted toward the
    weekly target but NOT returned (they don't need injection).
    """
    target = weekly_core_target(goal, days_per_week)
    if target == 0:
        return []

    # Count days that already have core from their template
    template_core_count = sum(1 for v in recipe_values if v in _TEMPLATES_WITH_CORE)
    remaining = max(0, target - template_core_count)
    if remaining == 0:
        return []

    # Score eligible days (those WITHOUT template core)
    scored = []
    for i, arch_val in enumerate(recipe_values):
        if arch_val in _TEMPLATES_WITH_CORE:
            continue  # already has core
        pri = core_priority_for_archetype(arch_val)
        if pri > 0:
            scored.append((pri, i))

    scored.sort(key=lambda x: (-x[0], x[1]))
    selected = [idx for _, idx in scored[:remaining]]
    selected.sort()
    return selected
