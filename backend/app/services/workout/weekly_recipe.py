"""Weekly archetype recipe generator.

Given a `GoalProfile` and a `days_per_week`, produce an ordered list
of `DayArchetype` values. This is what the old `pick_split +
build_day_templates` pair used to do for lifting only — it's now
goal-agnostic and produces cardio, mobility, or hybrid sequences where
appropriate.

Architecture
------------
Per planner mode:

    lifting    — reuse the existing `pick_split` matrix to pick a
                 traditional split, then translate split days into
                 lift archetypes (Push → LIFT_PUSH, etc.).

    endurance  — cycle interval / steady / tempo / mixed days, place
                 exactly one LIFT_STRENGTH_MAINTENANCE day at the end
                 of the week if days ≥ 3.

    athletic   — alternate HYBRID_LOWER_POWER, HYBRID_UPPER_INTERVALS,
                 COND_INTERVALS_SHORT, and COND_SPRINT_POWER days. One
                 full-body strength day at the end of the week at 5+.

    maintain   — rotate LIFT_FULL_BODY, COND_ZONE2, MOBILITY_FLOW with
                 gentle frequency.

    mobility   — MOBILITY_FLOW / STRETCH_BLOCK dominant, one easy
                 cardio day per week at 3+.

    recovery   — STRESS_RELIEF_EASY / RECOVERY_EASY / MOBILITY_FLOW.
                 Zero high-intensity archetypes. Lower fatigue.

All output is deterministic: same (profile, days) → same recipe.
"""
from __future__ import annotations

from typing import Optional

from .archetypes import DayArchetype
from .goal_profiles import GoalProfile


# ── Lifting mode ────────────────────────────────────────────────────


def _lifting_recipe(profile: GoalProfile, split: str, days: int) -> list[DayArchetype]:
    """Translate a traditional split id (from `pick_split`) into a
    list of `LIFT_*` archetypes. Mirrors the old `build_day_templates`
    dispatch but emits archetypes instead of slot lists."""
    # Lazy import to avoid circular dependency with planner.
    from .planner import (
        SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL,
        SPLIT_PPL_UL, SPLIT_BRO,
    )

    if split == SPLIT_FULL_BODY:
        return [DayArchetype.LIFT_FULL_BODY] * days

    if split == SPLIT_UPPER_LOWER:
        cycle = [DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER]
        return [cycle[i % 2] for i in range(days)]

    if split == SPLIT_PPL:
        cycle = [DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS]
        return [cycle[i % 3] for i in range(days)]

    if split == SPLIT_PPL_UL:
        seq = [
            DayArchetype.LIFT_PUSH,
            DayArchetype.LIFT_PULL,
            DayArchetype.LIFT_LEGS,
            DayArchetype.LIFT_UPPER,
            DayArchetype.LIFT_LOWER,
        ]
        return seq[:days] + [seq[i % len(seq)] for i in range(len(seq), days)]

    if split == SPLIT_BRO:
        seq = [
            DayArchetype.LIFT_BRO_CHEST,
            DayArchetype.LIFT_BRO_BACK,
            DayArchetype.LIFT_BRO_SHOULDERS,
            DayArchetype.LIFT_BRO_ARMS,
            DayArchetype.LIFT_BRO_LEGS,
        ]
        return seq[:days] + [seq[i % len(seq)] for i in range(len(seq), days)]

    # Unknown split — conservative full-body fallback.
    return [DayArchetype.LIFT_FULL_BODY] * days


# ── Endurance mode ──────────────────────────────────────────────────


# Rotation used for pure-cardio days on an endurance plan. The order
# is deliberate: easy-hard-easy so the user always has a lighter day
# between interval sessions.
_ENDURANCE_CARDIO_CYCLE = [
    DayArchetype.COND_INTERVALS_SHORT,
    DayArchetype.COND_ZONE2,
    DayArchetype.COND_INTERVALS_LONG,
    DayArchetype.COND_ZONE2,
    DayArchetype.COND_TEMPO,
    DayArchetype.COND_MIXED,
    DayArchetype.COND_ZONE2,
]


def _endurance_recipe(profile: GoalProfile, days: int) -> list[DayArchetype]:
    """Build an endurance recipe. At 3+ days the last day of the week
    is `LIFT_STRENGTH_MAINTENANCE` — placed at the end so cardio days
    stay consecutive and the strength day lands before a rest day."""
    out: list[DayArchetype] = []
    cardio_days = days
    if days >= 3:
        cardio_days = days - 1  # reserve one day for strength maintenance
    for i in range(cardio_days):
        out.append(_ENDURANCE_CARDIO_CYCLE[i % len(_ENDURANCE_CARDIO_CYCLE)])
    if days >= 3:
        out.append(DayArchetype.LIFT_STRENGTH_MAINTENANCE)
    return out


# ── Athletic mode ───────────────────────────────────────────────────


# Athletic template: alternate hybrid power/strength with conditioning.
# 5-day version adds a dedicated full-body strength day at the end.
def _athletic_recipe(profile: GoalProfile, days: int) -> list[DayArchetype]:
    if days == 1:
        return [DayArchetype.HYBRID_LOWER_POWER]
    if days == 2:
        return [
            DayArchetype.HYBRID_LOWER_POWER,
            DayArchetype.HYBRID_UPPER_INTERVALS,
        ]
    if days == 3:
        return [
            DayArchetype.HYBRID_LOWER_POWER,
            DayArchetype.COND_SPRINT_POWER,
            DayArchetype.HYBRID_UPPER_INTERVALS,
        ]
    if days == 4:
        return [
            DayArchetype.LIFT_LOWER,
            DayArchetype.HYBRID_UPPER_INTERVALS,
            DayArchetype.COND_SPRINT_POWER,
            DayArchetype.HYBRID_LOWER_POWER,
        ]
    if days == 5:
        return [
            DayArchetype.LIFT_LOWER,
            DayArchetype.COND_INTERVALS_SHORT,
            DayArchetype.LIFT_UPPER,
            DayArchetype.COND_SPRINT_POWER,
            DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
        ]
    # 6+ days — cycle the 5-day pattern and append another hybrid
    base = _athletic_recipe(profile, 5)
    extra = [
        DayArchetype.COND_INTERVALS_LONG,
        DayArchetype.MOBILITY_FLOW,
    ]
    return base + extra[: (days - 5)]


# ── Fat loss mixed mode ─────────────────────────────────────────────


def _fat_loss_recipe(profile: GoalProfile, days: int, lifting_split: str) -> list[DayArchetype]:
    """Fat loss uses a LIFTING backbone but guarantees at least one
    conditioning day per week at 3+ days. The old behavior was
    straight upper/lower repetition which the user called out as
    missing 'meaningful conditioning presence'."""
    if days <= 2:
        # Compound-heavy at low frequency — save conditioning for days 3+.
        return _lifting_recipe(profile, lifting_split, days)

    # 3+ days: reserve 1 day for conditioning and build the rest with
    # the lifting recipe. At 5 days reserve 2 conditioning days.
    cond_days = 2 if days >= 5 else 1
    lift_days = days - cond_days
    lifting = _lifting_recipe(profile, lifting_split, lift_days)
    # Conditioning mix: first cond day = short intervals, second =
    # a circuit so the two cond days are distinct.
    cond: list[DayArchetype] = []
    cond_sequence = [
        DayArchetype.COND_INTERVALS_SHORT,
        DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
    ]
    for i in range(cond_days):
        cond.append(cond_sequence[i % len(cond_sequence)])
    # Interleave: lift, cond, lift, cond, ...
    out: list[DayArchetype] = []
    li = ci = 0
    place_cond = False
    while li < len(lifting) or ci < len(cond):
        if not place_cond and li < len(lifting):
            out.append(lifting[li]); li += 1
        elif ci < len(cond):
            out.append(cond[ci]); ci += 1
        elif li < len(lifting):
            out.append(lifting[li]); li += 1
        place_cond = not place_cond
    return out


# ── Maintain mode ───────────────────────────────────────────────────


# General-health / maintain: gentle rotation of full-body lift, zone2,
# and mobility. Keeps recovery high and complexity low.
def _maintain_recipe(profile: GoalProfile, days: int) -> list[DayArchetype]:
    cycle = [
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.COND_ZONE2,
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.MOBILITY_FLOW,
        DayArchetype.LIFT_FULL_BODY,
        DayArchetype.COND_ZONE2,
        DayArchetype.RECOVERY_EASY,
    ]
    return cycle[:days]


# ── Mobility mode ───────────────────────────────────────────────────


def _mobility_recipe(profile: GoalProfile, days: int) -> list[DayArchetype]:
    """Mobility-first planner. Full-body mobility flows dominate. At
    3+ days one easy strength maintenance + one zone2 easy cardio day
    are mixed in so the user is still moving against light load."""
    if days == 1:
        return [DayArchetype.MOBILITY_FLOW]
    if days == 2:
        return [DayArchetype.MOBILITY_FLOW, DayArchetype.STRETCH_BLOCK]
    if days == 3:
        return [
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.COND_ZONE2,
            DayArchetype.STRETCH_BLOCK,
        ]
    if days == 4:
        return [
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
            DayArchetype.STRETCH_BLOCK,
            DayArchetype.COND_ZONE2,
        ]
    if days == 5:
        return [
            DayArchetype.MOBILITY_FLOW,
            DayArchetype.LIFT_STRENGTH_MAINTENANCE,
            DayArchetype.STRETCH_BLOCK,
            DayArchetype.COND_ZONE2,
            DayArchetype.MOBILITY_FLOW,
        ]
    # 6+: add recovery day
    base = _mobility_recipe(profile, 5)
    return base + [DayArchetype.RECOVERY_EASY] * (days - 5)


# ── Recovery / stress relief mode ───────────────────────────────────


def _recovery_recipe(profile: GoalProfile, days: int) -> list[DayArchetype]:
    """Mental-wellness / stress-relief planner. Lowest-intensity
    archetypes only. Consistency over intensity."""
    cycle = [
        DayArchetype.STRESS_RELIEF_EASY,
        DayArchetype.MOBILITY_FLOW,
        DayArchetype.COND_ZONE2,
        DayArchetype.STRESS_RELIEF_EASY,
        DayArchetype.RECOVERY_EASY,
        DayArchetype.MOBILITY_FLOW,
        DayArchetype.STRESS_RELIEF_EASY,
    ]
    return cycle[:days]


# ── Public entry point ─────────────────────────────────────────────


def generate_weekly_recipe(
    profile: GoalProfile,
    days_per_week: int,
    *,
    lifting_split: Optional[str] = None,
) -> list[DayArchetype]:
    """Produce the week's archetype sequence for one user.

    `lifting_split` is only used when `profile.planner_mode == "lifting"`.
    The planner passes the output of `pick_split(inputs)` here so the
    lifting-mode branch maps PPL/UL/etc. into LIFT_* archetypes
    without having to re-implement split selection.

    Every returned archetype is guaranteed to be in
    `profile.allowed_archetypes`. If a recipe branch produces something
    the profile doesn't allow (shouldn't happen in practice), the
    offending entry is replaced with the profile's first anchor."""
    days = max(1, min(7, int(days_per_week or 3)))
    mode = profile.planner_mode

    if mode == "lifting":
        recipe = _lifting_recipe(profile, lifting_split or "full_body", days)
    elif mode == "fat_loss_mix":
        recipe = _fat_loss_recipe(profile, days, lifting_split or "upper_lower")
    elif mode == "endurance":
        recipe = _endurance_recipe(profile, days)
    elif mode == "athletic":
        recipe = _athletic_recipe(profile, days)
    elif mode == "maintain":
        recipe = _maintain_recipe(profile, days)
    elif mode == "mobility":
        recipe = _mobility_recipe(profile, days)
    elif mode == "recovery":
        recipe = _recovery_recipe(profile, days)
    else:
        # Unknown mode — fall back to maintain for safety.
        recipe = _maintain_recipe(profile, days)

    # Defensive: every archetype must be in the profile's allowed set.
    fallback = profile.anchor_archetypes[0] if profile.anchor_archetypes else DayArchetype.LIFT_FULL_BODY
    return [a if a in profile.allowed_archetypes else fallback for a in recipe]
