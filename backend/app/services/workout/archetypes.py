"""Day archetype vocabulary for the multi-goal workout planner.

A `DayArchetype` is the primitive the weekly planner reasons about.
Before this module, the planner only understood lifting day templates
(full body / upper / lower / push / pull / legs). That worked for
strength and hypertrophy goals but collapsed into generic lifting for
anything else (endurance, athletic performance, flexibility,
stress relief). This module adds a real non-lifting vocabulary so the
planner can honestly handle all 10 user-facing goals.

Architecture
------------
Each archetype has:

- a stable id (string value, safe to serialize into the plan output)
- a `category` — `lift | cond | mobility | recovery | hybrid`
- a `training_type` — drives prescription dispatch
- a `default_name` — human-facing label the day meta layer can format
- a `intensity_cost` — 1 (easy) to 5 (maximal). Used by the weekly
  planner to space hard days apart.

The `ARCHETYPE_META` dict is the single source of truth. Adding a new
archetype means adding one entry here plus a slot builder in
`planner.py` under `_archetype_to_slots`.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Literal


# String-valued enum so archetype ids are stable in serialized plans
# and in logs. `DayArchetype.LIFT_FULL_BODY.value == "lift_full_body"`.
class DayArchetype(str, Enum):
    # ── Lifting ────────────────────────────────────────────────────
    LIFT_FULL_BODY = "lift_full_body"
    LIFT_UPPER = "lift_upper"
    LIFT_LOWER = "lift_lower"
    LIFT_PUSH = "lift_push"
    LIFT_PULL = "lift_pull"
    LIFT_LEGS = "lift_legs"
    LIFT_BRO_CHEST = "lift_bro_chest"
    LIFT_BRO_BACK = "lift_bro_back"
    LIFT_BRO_SHOULDERS = "lift_bro_shoulders"
    LIFT_BRO_ARMS = "lift_bro_arms"
    LIFT_BRO_LEGS = "lift_bro_legs"
    # Compact 4-5 compound session for non-lifting goals (endurance,
    # flexibility, stress relief) that still want some strength
    # maintenance without eating into their primary goal's recovery.
    LIFT_STRENGTH_MAINTENANCE = "lift_strength_maintenance"

    # ── Stimulus-differentiated lifting ──────────────────────────────
    LIFT_UPPER_HEAVY = "lift_upper_heavy"
    LIFT_UPPER_HYPERTROPHY = "lift_upper_hypertrophy"
    LIFT_LOWER_HEAVY = "lift_lower_heavy"
    LIFT_LOWER_HYPERTROPHY = "lift_lower_hypertrophy"
    LIFT_PUSH_HEAVY = "lift_push_heavy"
    LIFT_PULL_HEAVY = "lift_pull_heavy"
    LIFT_LEGS_HEAVY = "lift_legs_heavy"
    LIFT_PUSH_VOLUME = "lift_push_volume"
    LIFT_PULL_VOLUME = "lift_pull_volume"
    LIFT_LEGS_VOLUME = "lift_legs_volume"
    LIFT_FULL_BODY_STRENGTH = "lift_full_body_strength"

    # ── Conditioning ──────────────────────────────────────────────
    COND_ZONE2 = "cond_zone2"                    # 25-45 min conversational pace
    COND_INTERVALS_SHORT = "cond_intervals_short"  # 6-10 × 30-60 s on
    COND_INTERVALS_LONG = "cond_intervals_long"    # 4-6 × 2-5 min on
    COND_TEMPO = "cond_tempo"                    # 15-25 min threshold
    COND_CIRCUIT = "cond_circuit"                # metabolic circuit
    COND_MIXED = "cond_mixed"                    # intervals + easy spin
    COND_SPRINT_POWER = "cond_sprint_power"      # short explosive sprints

    # ── Mobility / recovery ───────────────────────────────────────
    MOBILITY_FLOW = "mobility_flow"              # full-body mobility flow
    STRETCH_BLOCK = "stretch_block"              # focused static stretching
    RECOVERY_EASY = "recovery_easy"              # easy walk / easy spin
    STRESS_RELIEF_EASY = "stress_relief_easy"    # low-intensity mood session

    # ── Hybrid (strength + conditioning in one session) ───────────
    HYBRID_STRENGTH_INTERVALS = "hybrid_strength_intervals"
    HYBRID_UPPER_INTERVALS = "hybrid_upper_intervals"
    HYBRID_LOWER_POWER = "hybrid_lower_power"    # lower strength + plyo + sprint
    HYBRID_FULL_BODY_CIRCUIT = "hybrid_full_body_circuit"
    # Lift + short zone-2 cardio finisher. Same-day cardio attachments
    # used by muscle_gain / recomp / fat_loss / general_health plans so
    # a user with more days per week doesn't have to cannibalize their
    # rest day for cardio. Cardio amount is duration-aware (5-25 min)
    # and trimmed by density_adjust_slots on short sessions.
    LIFT_PUSH_PLUS_CARDIO = "lift_push_plus_cardio"
    LIFT_PULL_PLUS_CARDIO = "lift_pull_plus_cardio"
    LIFT_UPPER_PLUS_CARDIO = "lift_upper_plus_cardio"
    LIFT_FULL_BODY_PLUS_CARDIO = "lift_full_body_plus_cardio"


ArchetypeCategory = Literal["lift", "cond", "mobility", "recovery", "hybrid"]
TrainingType = Literal[
    "strength",       # low-rep heavy compounds
    "hypertrophy",    # moderate reps, volume focus
    "volume",         # high-rep lighter volume work
    "power",          # explosive / plyometric
    "conditioning",   # cardio + metabolic
    "mobility",       # range of motion
    "recovery",       # easy movement
    "mixed",          # hybrid days
]


@dataclass(frozen=True)
class ArchetypeMeta:
    category: ArchetypeCategory
    training_type: TrainingType
    # User-facing base label. The naming layer in `planner._day_meta`
    # can add an emphasis subtitle on top of this.
    default_name: str
    # Rough recovery cost on a 1-5 scale. Used by the weekly planner to
    # space hard days apart and by session_minutes trimming.
    intensity_cost: int
    # Which `exercise_type` values the slot builders for this archetype
    # accept. `strength` archetypes use `{"strength"}`, cardio uses
    # `{"cardio"}`, mobility uses `{"mobility"}`. A set so hybrid
    # archetypes can accept multiple (e.g. `{"strength", "cardio"}`).
    accepts_types: frozenset[str]


# ── Single source of truth ────────────────────────────────────────────
# Every archetype must have an entry here AND a slot builder in
# `planner._archetype_to_slots`. The tests check both.
ARCHETYPE_META: dict[DayArchetype, ArchetypeMeta] = {
    # ── Lifting ────────────────────────────────────────────────────
    DayArchetype.LIFT_FULL_BODY: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Full Body", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_UPPER: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Upper", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_LOWER: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Lower", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_PUSH: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Push", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_PULL: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Pull", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_LEGS: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Legs", intensity_cost=5,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_BRO_CHEST: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Chest", intensity_cost=3,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_BRO_BACK: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Back", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_BRO_SHOULDERS: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Shoulders", intensity_cost=3,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_BRO_ARMS: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Arms", intensity_cost=2,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_BRO_LEGS: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Legs", intensity_cost=5,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_STRENGTH_MAINTENANCE: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Strength Maintenance", intensity_cost=3,
        accepts_types=frozenset({"strength"}),
    ),

    # ── Stimulus-differentiated lifting ──────────────────────────────
    DayArchetype.LIFT_UPPER_HEAVY: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Upper", intensity_cost=5,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_UPPER_HYPERTROPHY: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Upper", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_LOWER_HEAVY: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Lower", intensity_cost=5,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_LOWER_HYPERTROPHY: ArchetypeMeta(
        category="lift", training_type="hypertrophy",
        default_name="Lower", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_PUSH_HEAVY: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Push", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_PULL_HEAVY: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Pull", intensity_cost=4,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_LEGS_HEAVY: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Legs", intensity_cost=5,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_PUSH_VOLUME: ArchetypeMeta(
        category="lift", training_type="volume",
        default_name="Push", intensity_cost=3,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_PULL_VOLUME: ArchetypeMeta(
        category="lift", training_type="volume",
        default_name="Pull", intensity_cost=3,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_LEGS_VOLUME: ArchetypeMeta(
        category="lift", training_type="volume",
        default_name="Legs", intensity_cost=3,
        accepts_types=frozenset({"strength"}),
    ),
    DayArchetype.LIFT_FULL_BODY_STRENGTH: ArchetypeMeta(
        category="lift", training_type="strength",
        default_name="Full Body — Strength", intensity_cost=5,
        accepts_types=frozenset({"strength"}),
    ),

    # ── Conditioning ──────────────────────────────────────────────
    DayArchetype.COND_ZONE2: ArchetypeMeta(
        category="cond", training_type="conditioning",
        default_name="Zone 2 Cardio", intensity_cost=2,
        accepts_types=frozenset({"cardio"}),
    ),
    DayArchetype.COND_INTERVALS_SHORT: ArchetypeMeta(
        category="cond", training_type="conditioning",
        default_name="Short Intervals", intensity_cost=4,
        accepts_types=frozenset({"cardio"}),
    ),
    DayArchetype.COND_INTERVALS_LONG: ArchetypeMeta(
        category="cond", training_type="conditioning",
        default_name="Long Intervals", intensity_cost=4,
        accepts_types=frozenset({"cardio"}),
    ),
    DayArchetype.COND_TEMPO: ArchetypeMeta(
        category="cond", training_type="conditioning",
        default_name="Tempo / Threshold", intensity_cost=3,
        accepts_types=frozenset({"cardio"}),
    ),
    DayArchetype.COND_CIRCUIT: ArchetypeMeta(
        category="cond", training_type="conditioning",
        default_name="Metabolic Circuit", intensity_cost=4,
        # Circuits pull from both strength and cardio libraries.
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.COND_MIXED: ArchetypeMeta(
        category="cond", training_type="conditioning",
        default_name="Mixed Conditioning", intensity_cost=3,
        accepts_types=frozenset({"cardio"}),
    ),
    DayArchetype.COND_SPRINT_POWER: ArchetypeMeta(
        category="cond", training_type="power",
        default_name="Sprint + Power", intensity_cost=4,
        accepts_types=frozenset({"cardio", "strength"}),
    ),

    # ── Mobility / recovery ───────────────────────────────────────
    DayArchetype.MOBILITY_FLOW: ArchetypeMeta(
        category="mobility", training_type="mobility",
        default_name="Mobility Flow", intensity_cost=1,
        accepts_types=frozenset({"mobility"}),
    ),
    DayArchetype.STRETCH_BLOCK: ArchetypeMeta(
        category="mobility", training_type="mobility",
        default_name="Stretch Block", intensity_cost=1,
        accepts_types=frozenset({"mobility"}),
    ),
    DayArchetype.RECOVERY_EASY: ArchetypeMeta(
        category="recovery", training_type="recovery",
        default_name="Easy Recovery", intensity_cost=1,
        accepts_types=frozenset({"cardio", "mobility"}),
    ),
    DayArchetype.STRESS_RELIEF_EASY: ArchetypeMeta(
        category="recovery", training_type="recovery",
        default_name="Easy Movement", intensity_cost=1,
        accepts_types=frozenset({"cardio", "mobility"}),
    ),

    # ── Hybrid ────────────────────────────────────────────────────
    DayArchetype.HYBRID_STRENGTH_INTERVALS: ArchetypeMeta(
        category="hybrid", training_type="mixed",
        default_name="Strength + Intervals", intensity_cost=5,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.HYBRID_UPPER_INTERVALS: ArchetypeMeta(
        category="hybrid", training_type="mixed",
        default_name="Upper + Intervals", intensity_cost=4,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.HYBRID_LOWER_POWER: ArchetypeMeta(
        category="hybrid", training_type="mixed",
        default_name="Lower Power + Sprints", intensity_cost=5,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.HYBRID_FULL_BODY_CIRCUIT: ArchetypeMeta(
        category="hybrid", training_type="mixed",
        default_name="Full Body Circuit", intensity_cost=4,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    # ── Lift + same-day cardio finisher (duration-aware) ──────────
    # Category is "lift" (not "hybrid") because these are structurally
    # lift days — the cardio is an optional finisher that density trim
    # drops first on short sessions. training_type stays "mixed" so the
    # prescription dispatcher routes cardio rows to cardio prescription
    # and lift rows to lift prescription.
    DayArchetype.LIFT_PUSH_PLUS_CARDIO: ArchetypeMeta(
        category="lift", training_type="mixed",
        default_name="Push + Cardio", intensity_cost=4,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.LIFT_PULL_PLUS_CARDIO: ArchetypeMeta(
        category="lift", training_type="mixed",
        default_name="Pull + Cardio", intensity_cost=4,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.LIFT_UPPER_PLUS_CARDIO: ArchetypeMeta(
        category="lift", training_type="mixed",
        default_name="Upper + Cardio", intensity_cost=4,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
    DayArchetype.LIFT_FULL_BODY_PLUS_CARDIO: ArchetypeMeta(
        category="lift", training_type="mixed",
        default_name="Full Body + Cardio", intensity_cost=4,
        accepts_types=frozenset({"strength", "cardio"}),
    ),
}


# Helpers used by both weekly_recipe and prescriptions.
def is_lifting(a: DayArchetype) -> bool:
    return ARCHETYPE_META[a].category == "lift"


def is_conditioning(a: DayArchetype) -> bool:
    return ARCHETYPE_META[a].category == "cond"


def is_mobility(a: DayArchetype) -> bool:
    return ARCHETYPE_META[a].category == "mobility"


def is_recovery(a: DayArchetype) -> bool:
    return ARCHETYPE_META[a].category == "recovery"


def is_hybrid(a: DayArchetype) -> bool:
    return ARCHETYPE_META[a].category == "hybrid"


# ── Archetype → focus bucket (single source of truth) ────────────────
# Maps every archetype to the coarse "stress bucket" the weekly planner
# uses for recent-focus continuity. This is an EXPLICIT table rather
# than deriving buckets from default_name strings, because hybrids
# like "Upper + Intervals" would otherwise normalize to 'cardio' via
# keyword matching and silently break continuity. Buckets:
#   upper_body, lower_body, full_body, cardio, mobility, recovery
ARCHETYPE_TO_FOCUS_BUCKET: dict[DayArchetype, str] = {
    # Lifting
    DayArchetype.LIFT_FULL_BODY: "full_body",
    DayArchetype.LIFT_UPPER: "upper_body",
    DayArchetype.LIFT_LOWER: "lower_body",
    DayArchetype.LIFT_PUSH: "upper_body",
    DayArchetype.LIFT_PULL: "upper_body",
    DayArchetype.LIFT_LEGS: "lower_body",
    DayArchetype.LIFT_BRO_CHEST: "upper_body",
    DayArchetype.LIFT_BRO_BACK: "upper_body",
    DayArchetype.LIFT_BRO_SHOULDERS: "upper_body",
    DayArchetype.LIFT_BRO_ARMS: "upper_body",
    DayArchetype.LIFT_BRO_LEGS: "lower_body",
    DayArchetype.LIFT_STRENGTH_MAINTENANCE: "full_body",
    # Stimulus-differentiated lifting
    DayArchetype.LIFT_UPPER_HEAVY: "upper_body",
    DayArchetype.LIFT_UPPER_HYPERTROPHY: "upper_body",
    DayArchetype.LIFT_LOWER_HEAVY: "lower_body",
    DayArchetype.LIFT_LOWER_HYPERTROPHY: "lower_body",
    DayArchetype.LIFT_PUSH_HEAVY: "upper_body",
    DayArchetype.LIFT_PULL_HEAVY: "upper_body",
    DayArchetype.LIFT_LEGS_HEAVY: "lower_body",
    DayArchetype.LIFT_PUSH_VOLUME: "upper_body",
    DayArchetype.LIFT_PULL_VOLUME: "upper_body",
    DayArchetype.LIFT_LEGS_VOLUME: "lower_body",
    DayArchetype.LIFT_FULL_BODY_STRENGTH: "full_body",
    # Conditioning
    DayArchetype.COND_ZONE2: "cardio",
    DayArchetype.COND_INTERVALS_SHORT: "cardio",
    DayArchetype.COND_INTERVALS_LONG: "cardio",
    DayArchetype.COND_TEMPO: "cardio",
    DayArchetype.COND_CIRCUIT: "cardio",
    DayArchetype.COND_MIXED: "cardio",
    DayArchetype.COND_SPRINT_POWER: "lower_body",
    # Mobility / recovery
    DayArchetype.MOBILITY_FLOW: "mobility",
    DayArchetype.STRETCH_BLOCK: "mobility",
    DayArchetype.RECOVERY_EASY: "recovery",
    DayArchetype.STRESS_RELIEF_EASY: "recovery",
    # Hybrids map to the body region they primarily stress
    DayArchetype.HYBRID_STRENGTH_INTERVALS: "full_body",
    DayArchetype.HYBRID_UPPER_INTERVALS: "upper_body",
    DayArchetype.HYBRID_LOWER_POWER: "lower_body",
    DayArchetype.HYBRID_FULL_BODY_CIRCUIT: "full_body",
    DayArchetype.LIFT_PUSH_PLUS_CARDIO: "upper_body",
    DayArchetype.LIFT_PULL_PLUS_CARDIO: "upper_body",
    DayArchetype.LIFT_UPPER_PLUS_CARDIO: "upper_body",
    DayArchetype.LIFT_FULL_BODY_PLUS_CARDIO: "full_body",
}


def archetype_to_focus_bucket(a: DayArchetype) -> str:
    """Return the coarse focus/stress bucket for an archetype. Every
    archetype in the enum has an entry in `ARCHETYPE_TO_FOCUS_BUCKET`;
    this helper exists so callers don't have to import the dict."""
    return ARCHETYPE_TO_FOCUS_BUCKET[a]


# ── Fine-grained focus family ──────────────────────────────────────
# Unlike the coarse `ARCHETYPE_TO_FOCUS_BUCKET` (which maps Push and
# Pull both to "upper_body"), this map preserves split identity:
# Push ≠ Pull even though both stress the upper body. Used by the
# recipe rotation and adjacency repair to prevent same-focus
# duplication within a chosen split.
ARCHETYPE_TO_FOCUS_FAMILY: dict[DayArchetype, str] = {
    # Lifting — each split identity gets its own family
    DayArchetype.LIFT_FULL_BODY: "full_body",
    DayArchetype.LIFT_UPPER: "upper",
    DayArchetype.LIFT_LOWER: "lower",
    DayArchetype.LIFT_PUSH: "push",
    DayArchetype.LIFT_PULL: "pull",
    DayArchetype.LIFT_LEGS: "legs",
    DayArchetype.LIFT_BRO_CHEST: "push",
    DayArchetype.LIFT_BRO_BACK: "pull",
    DayArchetype.LIFT_BRO_SHOULDERS: "push",
    DayArchetype.LIFT_BRO_ARMS: "upper",
    DayArchetype.LIFT_BRO_LEGS: "legs",
    DayArchetype.LIFT_STRENGTH_MAINTENANCE: "full_body",
    # Stimulus-differentiated — SAME family as their base
    DayArchetype.LIFT_UPPER_HEAVY: "upper",
    DayArchetype.LIFT_UPPER_HYPERTROPHY: "upper",
    DayArchetype.LIFT_LOWER_HEAVY: "lower",
    DayArchetype.LIFT_LOWER_HYPERTROPHY: "lower",
    DayArchetype.LIFT_PUSH_HEAVY: "push",
    DayArchetype.LIFT_PULL_HEAVY: "pull",
    DayArchetype.LIFT_LEGS_HEAVY: "legs",
    DayArchetype.LIFT_PUSH_VOLUME: "push",
    DayArchetype.LIFT_PULL_VOLUME: "pull",
    DayArchetype.LIFT_LEGS_VOLUME: "legs",
    DayArchetype.LIFT_FULL_BODY_STRENGTH: "full_body",
    # Non-lifting
    DayArchetype.COND_ZONE2: "cardio",
    DayArchetype.COND_INTERVALS_SHORT: "cardio",
    DayArchetype.COND_INTERVALS_LONG: "cardio",
    DayArchetype.COND_TEMPO: "cardio",
    DayArchetype.COND_CIRCUIT: "cardio",
    DayArchetype.COND_MIXED: "cardio",
    DayArchetype.COND_SPRINT_POWER: "cardio",
    DayArchetype.MOBILITY_FLOW: "mobility",
    DayArchetype.STRETCH_BLOCK: "mobility",
    DayArchetype.RECOVERY_EASY: "recovery",
    DayArchetype.STRESS_RELIEF_EASY: "recovery",
    DayArchetype.HYBRID_STRENGTH_INTERVALS: "full_body",
    DayArchetype.HYBRID_UPPER_INTERVALS: "upper",
    DayArchetype.HYBRID_LOWER_POWER: "lower",
    DayArchetype.HYBRID_FULL_BODY_CIRCUIT: "full_body",
    DayArchetype.LIFT_PUSH_PLUS_CARDIO: "push",
    DayArchetype.LIFT_PULL_PLUS_CARDIO: "pull",
    DayArchetype.LIFT_UPPER_PLUS_CARDIO: "upper",
    DayArchetype.LIFT_FULL_BODY_PLUS_CARDIO: "full_body",
}


def archetype_to_focus_family(a: DayArchetype) -> str:
    """Fine-grained split identity. Push ≠ Pull ≠ Legs."""
    return ARCHETYPE_TO_FOCUS_FAMILY.get(a, archetype_to_focus_bucket(a))


def archetype_conflicts_with_recent(
    a: DayArchetype,
    recent_focus_buckets: tuple[str, ...] | list[str],
) -> bool:
    """True when scheduling `a` today would repeat a stress bucket the
    user trained in the last ~36 hours. Centralized so weekly_recipe,
    planner, and any future continuity logic share one rule."""
    if not recent_focus_buckets:
        return False
    return archetype_to_focus_bucket(a) in set(recent_focus_buckets)
