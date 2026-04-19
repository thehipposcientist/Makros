"""Goal → planner profile translation.

This module is the bridge between user-facing goals and the weekly
archetype planner. For each normalized goal bucket it exposes a
`GoalProfile` that tells the weekly planner:

- how to split training time across strength / hypertrophy /
  conditioning / mobility / recovery / power
- which `DayArchetype` values are allowed in the recipe
- which archetypes should dominate the week
- progression style
- whether strength days should stay stable across regenerations

This replaces the old "pick a lifting split and stuff everything into
it" approach. The goal profile says what KIND of training the user
needs, and the weekly planner composes that into a day sequence.

The profiles are intentionally declarative. No AI. No randomness.
Changing one line here changes the plan shape for every user of that
goal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .archetypes import DayArchetype
from .goals import goal_bucket


# ── Training mix fractions ──────────────────────────────────────────
# These are INTENT fractions used by the weekly planner to allocate
# days. They don't need to sum to exactly 1.0 — the planner renormalizes
# at use time — but they should reflect the goal's real emphasis.
@dataclass(frozen=True)
class TrainingMix:
    strength: float = 0.0      # low-rep heavy compound work
    hypertrophy: float = 0.0   # moderate-rep volume work
    power: float = 0.0         # explosive / plyometric
    conditioning: float = 0.0  # cardio + metabolic
    mobility: float = 0.0      # range of motion
    recovery: float = 0.0      # easy movement / active rest

    def total(self) -> float:
        return (
            self.strength + self.hypertrophy + self.power
            + self.conditioning + self.mobility + self.recovery
        )


@dataclass(frozen=True)
class GoalProfile:
    """Concrete instructions for the weekly planner."""
    # Canonical bucket id — stable across user-facing aliases.
    bucket: str
    # Human-facing short name (used in logs + trainer notes).
    label: str
    # Emphasis fractions (see TrainingMix above).
    mix: TrainingMix
    # Archetypes the weekly planner may use for this profile. Anything
    # outside this set is strictly off-limits.
    allowed_archetypes: frozenset[DayArchetype]
    # Archetypes that should form the backbone of every recipe, even at
    # low day counts. Recipe generation guarantees at least one of each
    # anchor (up to days_per_week) before filling out from `allowed`.
    anchor_archetypes: tuple[DayArchetype, ...]
    # "lifting" / "endurance" / "athletic" / "maintain" / "mobility" /
    # "recovery" — controls which weekly-recipe generator is used and
    # shapes progression logic downstream.
    planner_mode: str
    # When true, primary lifts stay bolted down across regenerations
    # (existing continuity layer reads this). When false, modalities
    # rotate more freely — appropriate for endurance / mobility plans.
    stable_lifts: bool = True
    # Short explanation surfaced in logs + audit tables.
    notes: str = ""


# ── Profile table ───────────────────────────────────────────────────
# One entry per canonical planner bucket. User-facing aliases
# (toning → fat_loss, maintain → body_recomp) are handled by `goals.py`
# BEFORE we arrive here, so this table only needs the canonical keys.
_PROFILE_TABLE: dict[str, GoalProfile] = {
    "muscle_gain": GoalProfile(
        bucket="muscle_gain",
        label="Muscle Gain",
        mix=TrainingMix(
            strength=0.20, hypertrophy=0.70,
            conditioning=0.05, mobility=0.05,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_FULL_BODY, DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_LOWER, DayArchetype.LIFT_PUSH,
            DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS,
            DayArchetype.LIFT_BRO_CHEST, DayArchetype.LIFT_BRO_BACK,
            DayArchetype.LIFT_BRO_SHOULDERS, DayArchetype.LIFT_BRO_ARMS,
            DayArchetype.LIFT_BRO_LEGS,
            # Stimulus-differentiated
            DayArchetype.LIFT_UPPER_HEAVY, DayArchetype.LIFT_UPPER_HYPERTROPHY,
            DayArchetype.LIFT_LOWER_HEAVY, DayArchetype.LIFT_LOWER_HYPERTROPHY,
            DayArchetype.LIFT_PUSH_HEAVY, DayArchetype.LIFT_PULL_HEAVY,
            DayArchetype.LIFT_LEGS_HEAVY,
            DayArchetype.LIFT_PUSH_VOLUME, DayArchetype.LIFT_PULL_VOLUME,
            DayArchetype.LIFT_LEGS_VOLUME, DayArchetype.LIFT_FULL_BODY_STRENGTH,
            # Active recovery option for 6+ day weeks
            DayArchetype.MOBILITY_FLOW,
        }),
        anchor_archetypes=(
            DayArchetype.LIFT_PUSH,
            DayArchetype.LIFT_PULL,
            DayArchetype.LIFT_LEGS,
        ),
        planner_mode="lifting",
        stable_lifts=True,
        notes="Hypertrophy-dominant, strength secondary. Classic PPL/UL/PPL-UL rotations.",
    ),

    "strength": GoalProfile(
        bucket="strength",
        label="Compound Strength",
        mix=TrainingMix(
            strength=0.80, hypertrophy=0.10,
            conditioning=0.0, mobility=0.10,
        ),
        # Strength training is compound-dominant. Heavy variants are
        # anchored so every week has heavy squat, heavy bench/press,
        # and heavy deadlift/row days. Volume/hypertrophy variants are
        # allowed but never anchored — they appear as secondary days.
        # No bro split, no push/pull split — upper/lower only so the
        # big lifts get full attention with long rest periods.
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER,
            DayArchetype.LIFT_UPPER_HEAVY, DayArchetype.LIFT_LOWER_HEAVY,
            DayArchetype.LIFT_UPPER_HYPERTROPHY, DayArchetype.LIFT_LOWER_HYPERTROPHY,
            DayArchetype.LIFT_FULL_BODY, DayArchetype.LIFT_FULL_BODY_STRENGTH,
            DayArchetype.LIFT_LEGS_HEAVY,
            DayArchetype.MOBILITY_FLOW,
        }),
        anchor_archetypes=(
            DayArchetype.LIFT_UPPER_HEAVY,
            DayArchetype.LIFT_LOWER_HEAVY,
        ),
        planner_mode="strength",
        stable_lifts=True,
        notes=(
            "Compound Strength: heavy compounds dominate (squat/bench/deadlift/OHP). "
            "Upper/Lower split only. 3-5 reps on primaries, 4 min rest. "
            "5 working sets on main lifts. Fewer accessories than muscle gain."
        ),
    ),

    "body_recomp": GoalProfile(
        bucket="body_recomp",
        label="Body Recomposition",
        mix=TrainingMix(
            strength=0.25, hypertrophy=0.50,
            conditioning=0.15, mobility=0.10,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_FULL_BODY, DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_LOWER, DayArchetype.LIFT_PUSH,
            DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS,
            DayArchetype.COND_ZONE2,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
            DayArchetype.MOBILITY_FLOW,
            # Stimulus-differentiated
            DayArchetype.LIFT_UPPER_HEAVY, DayArchetype.LIFT_UPPER_HYPERTROPHY,
            DayArchetype.LIFT_LOWER_HEAVY, DayArchetype.LIFT_LOWER_HYPERTROPHY,
            DayArchetype.LIFT_PUSH_HEAVY, DayArchetype.LIFT_PULL_HEAVY,
            DayArchetype.LIFT_LEGS_HEAVY,
            DayArchetype.LIFT_PUSH_VOLUME, DayArchetype.LIFT_PULL_VOLUME,
            DayArchetype.LIFT_LEGS_VOLUME, DayArchetype.LIFT_FULL_BODY_STRENGTH,
        }),
        anchor_archetypes=(
            DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_LOWER,
        ),
        # Route through lifting_plus_cardio instead of pure lifting so
        # the 15% conditioning fraction in `mix` actually materializes
        # as real cardio days. Previously body_recomp's profile
        # *claimed* conditioning + mobility archetypes in
        # `allowed_archetypes` but the lifting-only recipe generator
        # ignored them — the plan never had a single cardio day
        # regardless of day count. The `_lifting_plus_cardio_recipe`
        # reads `mix.conditioning` and reserves cardio days
        # accordingly (1 at 4-5 days, 2 at 6+).
        planner_mode="lifting_plus_cardio",
        stable_lifts=True,
        notes=(
            "Balanced hypertrophy + conditioning. Lifting backbone "
            "with 1-2 dedicated cardio days per week at 4+ days/week."
        ),
    ),

    "fat_loss": GoalProfile(
        bucket="fat_loss",
        label="Fat Loss",
        mix=TrainingMix(
            strength=0.10, hypertrophy=0.40,
            conditioning=0.35, mobility=0.10, recovery=0.05,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_FULL_BODY, DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_LOWER,
            # PPL archetypes — needed when user explicitly chooses PPL
            DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL,
            DayArchetype.LIFT_LEGS,
            DayArchetype.COND_ZONE2,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.COND_CIRCUIT,
            DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
            DayArchetype.HYBRID_STRENGTH_INTERVALS,
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.RECOVERY_EASY,
            # Stimulus-differentiated
            DayArchetype.LIFT_UPPER_HEAVY, DayArchetype.LIFT_UPPER_HYPERTROPHY,
            DayArchetype.LIFT_LOWER_HEAVY, DayArchetype.LIFT_LOWER_HYPERTROPHY,
            DayArchetype.LIFT_PUSH_HEAVY, DayArchetype.LIFT_PULL_HEAVY,
            DayArchetype.LIFT_LEGS_HEAVY,
            DayArchetype.LIFT_PUSH_VOLUME, DayArchetype.LIFT_PULL_VOLUME,
            DayArchetype.LIFT_LEGS_VOLUME, DayArchetype.LIFT_FULL_BODY_STRENGTH,
        }),
        anchor_archetypes=(
            DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_LOWER,
            DayArchetype.COND_INTERVALS_SHORT,
        ),
        # `lifting_plus_cardio` routes through the generalized
        # recipe generator that reads `mix.conditioning` to decide
        # how many days to reserve for cardio. Fat loss gets more
        # cardio days than body_recomp because its mix.conditioning
        # is 0.35 vs body_recomp's 0.15.
        planner_mode="lifting_plus_cardio",
        stable_lifts=True,
        notes=(
            "Lifting-supported fat loss with meaningful conditioning. "
            "Recipe generator injects at least one conditioning day "
            "per week at 3+ days."
        ),
    ),

    "endurance": GoalProfile(
        bucket="endurance",
        label="Endurance",
        mix=TrainingMix(
            strength=0.10, hypertrophy=0.05,
            conditioning=0.65, mobility=0.10, recovery=0.10,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.COND_ZONE2,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.COND_INTERVALS_LONG,
            DayArchetype.COND_TEMPO,
            DayArchetype.COND_MIXED,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.RECOVERY_EASY,
        }),
        anchor_archetypes=(
            DayArchetype.COND_ZONE2,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.COND_TEMPO,
        ),
        planner_mode="endurance",
        stable_lifts=False,
        notes="Cardio-first. Strength maintenance one day/week at 3+ days.",
    ),

    "athletic_performance": GoalProfile(
        bucket="athletic_performance",
        label="Athletic Performance",
        mix=TrainingMix(
            strength=0.30, hypertrophy=0.15, power=0.20,
            conditioning=0.25, mobility=0.10,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER,
            DayArchetype.LIFT_FULL_BODY,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.COND_INTERVALS_LONG,
            DayArchetype.COND_SPRINT_POWER,
            DayArchetype.COND_CIRCUIT,
            DayArchetype.HYBRID_LOWER_POWER,
            DayArchetype.HYBRID_UPPER_INTERVALS,
            DayArchetype.HYBRID_STRENGTH_INTERVALS,
            DayArchetype.MOBILITY_FLOW,
            # Stimulus-differentiated
            DayArchetype.LIFT_UPPER_HEAVY, DayArchetype.LIFT_UPPER_HYPERTROPHY,
            DayArchetype.LIFT_LOWER_HEAVY, DayArchetype.LIFT_LOWER_HYPERTROPHY,
            DayArchetype.LIFT_PUSH_HEAVY, DayArchetype.LIFT_PULL_HEAVY,
            DayArchetype.LIFT_LEGS_HEAVY,
            DayArchetype.LIFT_PUSH_VOLUME, DayArchetype.LIFT_PULL_VOLUME,
            DayArchetype.LIFT_LEGS_VOLUME, DayArchetype.LIFT_FULL_BODY_STRENGTH,
        }),
        anchor_archetypes=(
            DayArchetype.HYBRID_LOWER_POWER,
            DayArchetype.HYBRID_UPPER_INTERVALS,
            DayArchetype.COND_SPRINT_POWER,
        ),
        planner_mode="athletic",
        stable_lifts=True,
        notes="Blends strength, power, conditioning. Distinct from hypertrophy.",
    ),

    "hyrox": GoalProfile(
        bucket="hyrox",
        label="HYROX / Hybrid Race",
        mix=TrainingMix(
            strength=0.15, hypertrophy=0.10, power=0.10,
            conditioning=0.45, mobility=0.10, recovery=0.10,
        ),
        allowed_archetypes=frozenset({
            # Conditioning — the backbone
            DayArchetype.COND_ZONE2,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.COND_INTERVALS_LONG,
            DayArchetype.COND_TEMPO,
            DayArchetype.COND_CIRCUIT,
            # Hybrid — station-style work
            DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
            DayArchetype.HYBRID_STRENGTH_INTERVALS,
            DayArchetype.HYBRID_LOWER_POWER,
            # Strength support — not bodybuilding, functional
            DayArchetype.LIFT_FULL_BODY,
            DayArchetype.LIFT_FULL_BODY_STRENGTH,
            DayArchetype.LIFT_LOWER,
            DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
            # Recovery
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.RECOVERY_EASY,
        }),
        anchor_archetypes=(
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
            DayArchetype.COND_ZONE2,
        ),
        planner_mode="hyrox",
        stable_lifts=False,
        notes=(
            "HYROX race prep: running, intervals, functional stations. "
            "Conditioning-heavy with strength support for sled/carry/lunges."
        ),
    ),

    "general_health": GoalProfile(
        bucket="general_health",
        label="General Health",
        mix=TrainingMix(
            strength=0.15, hypertrophy=0.25,
            conditioning=0.25, mobility=0.20, recovery=0.15,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.LIFT_FULL_BODY,
            DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER,
            DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
            DayArchetype.COND_ZONE2,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.STRETCH_BLOCK,
            DayArchetype.RECOVERY_EASY,
            DayArchetype.STRESS_RELIEF_EASY,
        }),
        anchor_archetypes=(
            DayArchetype.LIFT_FULL_BODY,
            DayArchetype.COND_ZONE2,
            DayArchetype.MOBILITY_FLOW,
        ),
        planner_mode="maintain",
        stable_lifts=False,
        notes="Balanced moderate everything. Lower fatigue, simpler progression.",
    ),
}


# Special planner-mode profiles: goals that don't map to one of the
# primary buckets but still need a distinct plan shape. Resolved by
# id in `goal_profile_for`.
_SPECIAL_PROFILES: dict[str, GoalProfile] = {
    "flexibility": GoalProfile(
        bucket="general_health",  # for volume/nutrition fallbacks
        label="Flexibility & Mobility",
        mix=TrainingMix(
            mobility=0.60, recovery=0.15,
            strength=0.10, conditioning=0.15,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.STRETCH_BLOCK,
            DayArchetype.RECOVERY_EASY,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
            DayArchetype.COND_ZONE2,
        }),
        anchor_archetypes=(
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.STRETCH_BLOCK,
        ),
        planner_mode="mobility",
        stable_lifts=False,
        notes=(
            "Mobility-first planner. Limited support — seed library has "
            "~16 mobility exercises so real rotation is possible but "
            "shallow. Expanding the mobility library is a future pass."
        ),
    ),
    "stress_relief": GoalProfile(
        bucket="general_health",
        label="Mental Wellness",
        mix=TrainingMix(
            recovery=0.50, mobility=0.25, conditioning=0.20, strength=0.05,
        ),
        allowed_archetypes=frozenset({
            DayArchetype.STRESS_RELIEF_EASY,
            DayArchetype.RECOVERY_EASY,
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.COND_ZONE2,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
        }),
        anchor_archetypes=(
            DayArchetype.STRESS_RELIEF_EASY,
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.COND_ZONE2,
        ),
        planner_mode="recovery",
        stable_lifts=False,
        notes=(
            "Recovery + easy movement + consistency. Lower fatigue, no "
            "progression pressure. Partial support — builds on recovery "
            "/ mobility / zone2 archetypes."
        ),
    ),
}


def goal_profile_for(
    goal: Optional[str],
    experience: str = "intermediate",
    days_per_week: int = 3,
    session_minutes: Optional[int] = None,
) -> GoalProfile:
    """Return the `GoalProfile` that should drive weekly planning for
    this user. Runs through `goals.goal_bucket` first so UI aliases
    (toning, maintain, improve_cardio, etc.) all arrive at the right
    canonical profile.

    `experience`, `days_per_week`, and `session_minutes` are accepted
    for future tuning (beginners might get a lower-volume mix, short
    sessions might drop mobility), but the current implementation
    returns the same profile regardless. The callers still pass them
    so the signature is stable when we start tuning."""
    gid = (goal or "").strip().lower()

    # Special planner modes (flexibility, stress_relief) short-circuit
    # the normal bucket lookup because they don't map to a lifting
    # bucket — their profile IS a different planner mode. Also catch
    # aliases like "improve_flexibility" → "flexibility".
    _SPECIAL_ALIASES = {
        "improve_flexibility": "flexibility",
        "improve_mobility": "flexibility",
        "maintain_mobility": "flexibility",
        "stress_exercise": "stress_relief",
    }
    # Goals that should route to a specific PROFILE TABLE entry
    # (not a special profile). These are goal ids that the bucket
    # resolver maps incorrectly (e.g. longevity → body_recomp when
    # it should use the general_health maintain-mode profile).
    _PROFILE_OVERRIDES = {
        "longevity": "general_health",
        "healthy_aging": "general_health",
        "heart_health": "general_health",
        "general_health": "general_health",
    }
    resolved_gid = _SPECIAL_ALIASES.get(gid, gid)
    if resolved_gid in _SPECIAL_PROFILES:
        return _SPECIAL_PROFILES[resolved_gid]
    if gid in _PROFILE_OVERRIDES:
        return _PROFILE_TABLE.get(_PROFILE_OVERRIDES[gid]) or _PROFILE_TABLE["general_health"]

    bucket = goal_bucket(goal)
    # flexibility / stress_relief resolve to general_health via the
    # registry's `supported=False` fallback. Intercept those so they
    # get the mobility/recovery profile, not the generic one.
    if bucket == "general_health" and resolved_gid in ("flexibility", "stress_relief"):
        return _SPECIAL_PROFILES[resolved_gid]

    return _PROFILE_TABLE.get(bucket) or _PROFILE_TABLE["general_health"]


def profile_table_for_audit() -> dict[str, GoalProfile]:
    """Read-only view for audit tests."""
    merged = dict(_PROFILE_TABLE)
    merged.update(_SPECIAL_PROFILES)
    return merged
