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

import logging
from typing import Optional


# ── Planner version ─────────────────────────────────────────────────
#
# Stamped on every `WorkoutPlan` row and returned to the client alongside
# the plan itself. Bumped when planner logic changes meaningfully — the
# client treats anything older than `PLANNER_VERSION` as stale and auto-
# regenerates in the background. Date format is `YYYY.MM.DD.nn` so two
# bumps on the same day sort correctly (`.01`, `.02`, ...).
#
# When to bump:
#   - New archetype introduced / existing archetype reshaped
#   - Slot density, rep ranges, or rest prescriptions change
#   - Adjacency / rotation rules change
#   - Injury-pattern block list or dislike filter changes
# Cosmetic copy / logging tweaks don't need a bump.
PLANNER_VERSION = "2026.04.22.05"

logger = logging.getLogger(__name__)

from .archetypes import DayArchetype, ARCHETYPE_META, archetype_to_focus_bucket, archetype_to_focus_family
from .goal_profiles import GoalProfile


# ── Recovery allocation ─────────────────────────────────────────────
#
# Recovery is a distinct concept from conditioning. Zone 2 and intervals
# are training stress; recovery is active rest (mobility flow, easy walk,
# stretching). The allocation is frequency-driven, not mix-driven:
#
#   ≤5 days/week → 0 recovery days (user already has 2+ off days)
#   6 days/week  → 0 by default; 1 for recovery-friendly goals
#   7 days/week  → 1 always (user has no off days)
#
# Conditioning allocation then fills from remaining non-lifting,
# non-recovery days. This prevents the old bug where 7-day recomp
# users got 5 lifting + 2 conditioning with zero actual rest.

_RECOVERY_FRIENDLY_GOALS = frozenset({
    "general_health", "maintain", "longevity", "healthy_aging",
})


def _derive_recovery_days(
    total_days: int,
    goal_bucket: str,
    recovery_mix_frac: float = 0.0,
    mobility_mix_frac: float = 0.0,
) -> int:
    """Determine how many days should be true active recovery / mobility.

    Returns 0 or 1. The planner fills this with MOBILITY_FLOW or
    RECOVERY_EASY — never with conditioning archetypes.
    """
    if total_days <= 5:
        return 0
    if total_days == 6:
        # Only place a recovery day at 6 if the goal emphasizes it
        # or the mix explicitly allocates meaningful recovery+mobility
        if goal_bucket in _RECOVERY_FRIENDLY_GOALS:
            return 1
        if (recovery_mix_frac + mobility_mix_frac) >= 0.15:
            return 1
        return 0
    # 7 days: always 1 recovery day — the user has no off days
    return 1


def _pick_recovery_archetype(profile: GoalProfile) -> DayArchetype:
    """Choose the best recovery archetype from the profile's allowed set."""
    # Prefer MOBILITY_FLOW (most useful active recovery) over RECOVERY_EASY
    prefs = [
        DayArchetype.MOBILITY_FLOW,
        DayArchetype.RECOVERY_EASY,
        DayArchetype.STRESS_RELIEF_EASY,
    ]
    for pref in prefs:
        if pref in profile.allowed_archetypes:
            return pref
    # If the profile doesn't allow any recovery archetype, use MOBILITY_FLOW
    # anyway — it's always safe and low-stress
    return DayArchetype.MOBILITY_FLOW


# ── Lifting mode ────────────────────────────────────────────────────


def _ppl_stimulus_mix(goal: str, days: int) -> list[DayArchetype]:
    """Goal-specific stimulus mix for a PPL split.

    The base rotation is always Push → Pull → Legs (preserves the split's
    identity and rotation). What varies per goal is which *stimulus* each
    day carries — heavy (3–5 reps), moderate/hypertrophy (6–10), or
    volume (10–15). For 6 days we run two rotations; for 4–5 we take the
    first N entries of the 6-day sequence; for 3 we use one rotation at
    the goal's middle stimulus.

    Goal dial (6-day totals — same ratios at lower day-counts):
      strength                 → 4 heavy + 2 hypertrophy
      muscle_gain              → 3 heavy + 3 volume
      body_recomp              → 2 heavy + 2 hypertrophy + 2 volume
      athletic_performance     → 3 heavy + 3 hypertrophy (no 15-rep sets)
      hyrox                    → 2 heavy + 4 hypertrophy (muscle endurance)
      toning                   → 3 hypertrophy + 3 volume (no heavy)
      fat_loss                 → 2 hypertrophy + 4 volume
      default (unknown / other)→ 3 hypertrophy + 3 volume

    Ordering rule: sequences INTERLEAVE heavy and volume/hypertrophy
    days rather than stacking all heavies at the start. This avoids
    3+ adjacent heavy days (a CNS overload pattern the intensity-
    spacing pass would otherwise have to repair at the cost of
    family balance — see split-identity revert).
    """
    # Sequences in Push/Pull/Legs order for each stimulus type.
    H = (DayArchetype.LIFT_PUSH_HEAVY,  DayArchetype.LIFT_PULL_HEAVY,  DayArchetype.LIFT_LEGS_HEAVY)
    M = (DayArchetype.LIFT_PUSH,        DayArchetype.LIFT_PULL,        DayArchetype.LIFT_LEGS)
    V = (DayArchetype.LIFT_PUSH_VOLUME, DayArchetype.LIFT_PULL_VOLUME, DayArchetype.LIFT_LEGS_VOLUME)

    # Explicit sequences per day-count AND goal. Keeping the Push → Pull
    # → Legs rotation inside each three-day block so the rotation-avoidance
    # pass has a clean base. 5-day sequences deliberately DROP the duplicate
    # Pull (not Legs) — legs is easier to under-train naturally and the
    # plan reviewer repeatedly flagged single-Legs weeks as imbalanced.
    goal_lower = (goal or "").lower()

    # 6-day sequences (each goal gets 2 Push + 2 Pull + 2 Legs, varying
    # the stimulus intensity). 5-day sequences give 2P + 1Pu + 2L.
    # 4-day sequences give 1P + 1Pu + 2L (still prioritizing legs).
    if goal_lower == "strength":
        # 4H + 2M, interleaved so at most 2 adjacent heavies.
        # Strength goal permits adjacent heavy on different muscles (P/Pu)
        # but never 3 in a row. Day-4 M[1] (Pull hypertrophy) gives the
        # CNS a break before the second heavy-Push cycle.
        six_day = [H[0], H[1], H[2], H[0], M[1], M[2]]        # 4H + 2M (P/Pu adj OK for strength)
        five_day = [H[0], H[1], H[2], M[0], M[2]]             # 3H + 2M, 2/1/2
        four_day = [H[0], H[1], M[0], M[2]]                   # 2H + 2M (was 3H+1M — too CNS-heavy at 4d)
    elif goal_lower == "muscle_gain":
        # 3H + 3V — alternated so no two heavies are adjacent.
        # Previous [H,H,H,V,V,V] yielded 3 consecutive heavies,
        # which the intensity-spacing pass tried to break but was
        # reverted by split-identity preservation (Push→Pull→Legs
        # block). Interleaving satisfies both invariants.
        six_day = [H[0], V[1], H[2], V[0], H[1], V[2]]        # 3H + 3V (HVHVHV)
        five_day = [H[0], V[1], H[2], V[0], V[2]]             # 2H + 3V, 2/1/2 (was 3H+2V)
        four_day = [H[0], V[1], H[2], V[2]]                   # 2H + 2V (was 3H+1V)
    elif goal_lower == "body_recomp":
        six_day = [H[0], M[1], H[2], V[0], M[1], V[2]]        # balanced 2+2+2
        five_day = [H[0], M[1], H[2], V[0], V[2]]             # 2/1/2
        four_day = [H[0], M[1], H[2], V[2]]                   # 1/1/2
    elif goal_lower == "athletic_performance":
        # 3H + 3M, interleaved (no 3 adjacent heavies).
        six_day = [H[0], M[1], H[2], M[0], H[1], M[2]]        # 3H + 3M (HMHMHM)
        five_day = [H[0], M[1], H[2], M[0], M[2]]             # 2H + 3M, 2/1/2
        four_day = [H[0], M[1], H[2], M[2]]                   # 2H + 2M
    elif goal_lower == "hyrox":
        six_day = [H[0], M[1], H[2], M[0], M[1], M[2]]        # 2H + 4M
        five_day = [H[0], M[1], H[2], M[0], M[2]]             # 2H + 3M, 2/1/2
        four_day = [H[0], M[1], H[2], M[2]]                   # 2H + 2M, 1/1/2
    elif goal_lower == "toning":
        six_day = [M[0], M[1], M[2], V[0], V[1], V[2]]        # 3M + 3V, no heavy
        five_day = [M[0], M[1], M[2], V[0], V[2]]             # 3M + 2V, 2/1/2
        four_day = [M[0], M[1], M[2], V[2]]                   # 3M + 1V, 1/1/2
    elif goal_lower == "fat_loss":
        six_day = [M[0], V[1], M[2], V[0], V[1], V[2]]        # 2M + 4V
        five_day = [M[0], V[1], M[2], V[0], V[2]]             # 2M + 3V, 2/1/2
        four_day = [M[0], V[1], M[2], V[2]]                   # 2M + 2V, 1/1/2
    else:
        # Unknown / general_health / maintain / endurance lifting day:
        # default to 3H + 3V, interleaved to avoid 3 adjacent heavies.
        six_day = [H[0], V[1], H[2], V[0], H[1], V[2]]
        five_day = [H[0], V[1], H[2], V[0], V[2]]
        four_day = [H[0], V[1], H[2], V[2]]

    if days >= 6:
        return six_day[:days]
    if days == 5:
        return five_day
    if days == 4:
        return four_day
    # 3 days or fewer: one clean hypertrophy rotation (P/Pu/L).
    return [M[i % 3] for i in range(days)]


def _lifting_recipe(profile: GoalProfile, split: str, days: int, *, priority_region: str = "balanced") -> list[DayArchetype]:
    """Translate a traditional split id (from `pick_split`) into a
    list of `LIFT_*` archetypes. Mirrors the old `build_day_templates`
    dispatch but emits archetypes instead of slot lists.

    When enough lift days are available, stimulus variation is applied:
    heavy/hypertrophy alternation for upper_lower (4+ days), volume
    variants for PPL (6 days), and a strength session for full_body
    (3+ days). Plans with fewer days keep the standard archetypes to
    avoid overcrowding the week."""
    # Split constants now live in day_templates (responsibility
    # separation refactor). The lazy import stays so weekly_recipe
    # can be imported by tests without pulling in the full planner.
    from .day_templates import (
        SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL,
        SPLIT_PPL_UL, SPLIT_BRO,
    )

    # Check whether the profile allows stimulus-differentiated
    # archetypes. Only inject them when the profile explicitly lists
    # them (goal_profiles.py controls this).
    _has_stimulus = DayArchetype.LIFT_UPPER_HEAVY in profile.allowed_archetypes

    if split == SPLIT_FULL_BODY:
        if _has_stimulus and days >= 3:
            # Day 1: strength, Day 2+: standard hypertrophy rotation
            out = [DayArchetype.LIFT_FULL_BODY_STRENGTH]
            for i in range(1, days):
                out.append(DayArchetype.LIFT_FULL_BODY)
            return out
        return [DayArchetype.LIFT_FULL_BODY] * days

    if split == SPLIT_UPPER_LOWER:
        if _has_stimulus and days >= 3:
            # Goal shapes the heavy/hypertrophy mix. Strength goals bias
            # heavy; toning/fat_loss avoid pure-heavy; body_recomp balances.
            goal_lower = (profile.bucket or "").lower()
            if goal_lower in ("strength", "athletic_performance"):
                # Heavy-biased alternation. 4d wraps to 2H+2Hy;
                # 6d wraps to 4H+2Hy (upper/lower heavy back-to-back
                # is acceptable for strength — different muscle groups).
                # Changed from 3-heavy-in-4 (too CNS-dense at 4d) to
                # clean 2H+2Hy at 4d while keeping 4H+2Hy at 6d via
                # the odd-day override below.
                if priority_region == "lower_body":
                    stimulus_cycle = [
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                    ]
                else:
                    stimulus_cycle = [
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                    ]
            elif goal_lower in ("toning", "fat_loss"):
                # No pure heavy days. Hypertrophy dominant, with one
                # lighter heavy to maintain strength floor.
                if priority_region == "lower_body":
                    stimulus_cycle = [
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HEAVY,
                    ]
                else:
                    stimulus_cycle = [
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HEAVY,
                    ]
            elif goal_lower == "body_recomp":
                # Body recomp is primarily hypertrophy with a dash of
                # strength maintenance — NOT 4 heavy days. UL has no
                # dedicated VOLUME archetype, so we give 2 heavy per
                # region and fill the rest with hypertrophy. At 6 lifts
                # this yields 2H + 4Hy (was 4H + 2Hy).
                if priority_region == "lower_body":
                    stimulus_cycle = [
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                    ]
                else:
                    stimulus_cycle = [
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                    ]
            else:
                # muscle_gain / hyrox / unknown → hypertrophy-biased.
                # Previous 4-day [H,H,Hy,Hy] cycle wrapped to 4H+2Hy at
                # 6 days — too CNS-dense for muscle_gain (which prefers
                # 2H+4Hy or 3H+3Hy). Use a 6-slot cycle with one heavy
                # per region and 4 hypertrophy days. At 4d wraps to
                # 1H+3Hy + heavy-lower via odd-day override; at 6d
                # yields the intended 2H+4Hy.
                if priority_region == "lower_body":
                    stimulus_cycle = [
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                    ]
                else:
                    stimulus_cycle = [
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                        DayArchetype.LIFT_LOWER_HYPERTROPHY,
                    ]
            result = [stimulus_cycle[i % len(stimulus_cycle)] for i in range(days)]
            # Odd day: repeat an extra session of the PRIORITY region
            # (an extra lower day for lower_body priority, an extra upper
            # day for upper_body priority). Balanced keeps the default
            # last-entry emphasis (upper hypertrophy) rather than flipping
            # it — this is intentional so balanced users still see mixed
            # stimulus coverage and we don't bias toward either region.
            if days % 2 == 1:
                if priority_region == "lower_body":
                    result[-1] = DayArchetype.LIFT_LOWER_HYPERTROPHY
                elif priority_region == "upper_body":
                    result[-1] = DayArchetype.LIFT_UPPER_HYPERTROPHY
                else:
                    result[-1] = DayArchetype.LIFT_UPPER_HYPERTROPHY
            return result
        if priority_region == "lower_body":
            cycle = [DayArchetype.LIFT_LOWER, DayArchetype.LIFT_UPPER]
        else:
            cycle = [DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER]
        result = [cycle[i % 2] for i in range(days)]
        # Odd day: extra session of the priority region, not full body
        if days % 2 == 1:
            result[-1] = cycle[0]
        return result

    if split == SPLIT_PPL:
        if _has_stimulus and days >= 4:
            return _ppl_stimulus_mix(profile.bucket, days)
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


def _lifting_plus_cardio_recipe(
    profile: GoalProfile,
    days: int,
    lifting_split: str,
    *,
    user_chose_split: bool = False,
    priority_region: str = "balanced",
) -> list[DayArchetype]:
    """Lifting-backbone plan with conditioning days interleaved.

    Used by any goal profile whose `mix.conditioning` is high enough
    to warrant dedicated cardio days alongside the lifting backbone.
    The number of reserved conditioning days is derived from
    `profile.mix.conditioning` so different goals get different
    amounts of cardio without needing separate recipe functions:

        conditioning fraction ≥ 0.30  (fat_loss territory)
            → 1 cardio day at 3-4 days/week, 2 at 5+ (cap at 2)
        conditioning fraction 0.10–0.29  (body_recomp, recomp-lite)
            → 0 cardio days at 1-3 days, 1 at 4+ (cap at 1)
            (stays strictly below fat_loss's cardio count at every
            day-count so the goal mix stays differentiated, and
            preserves 6d PPL split balance — 2 cardio at 6d would
            force lift_days=4 and trigger the PPL→UL auto-convert)
        conditioning fraction < 0.10
            → falls back to pure lifting (no conditioning days)

    The first cardio day is always short intervals (cheap, meaningful);
    the second is a full-body circuit; additional ones cycle back
    through the sequence. Cardio and lifting days are interleaved so
    the user isn't stacking two hard sessions back to back.
    """
    conditioning_frac = getattr(profile.mix, "conditioning", 0.0) or 0.0
    recovery_frac = getattr(profile.mix, "recovery", 0.0) or 0.0
    mobility_frac = getattr(profile.mix, "mobility", 0.0) or 0.0

    # ── Step 1: Recovery allocation (frequency-driven, not mix-driven) ──
    # Recovery is not conditioning. Zone 2 and intervals are training stress.
    # 7-day users get 1 true rest day; ≤5-day users already have off days.
    recovery_days = _derive_recovery_days(
        days, profile.bucket, recovery_frac, mobility_frac,
    )

    # ── Step 2: Conditioning allocation (from remaining non-recovery days) ──
    available_for_training = days - recovery_days
    if conditioning_frac < 0.10:
        cond_days = 0
    elif conditioning_frac < 0.30:
        # Body-recomp band — capped at 1 true cardio day so fat_loss's
        # stronger conditioning emphasis (cap 2) stays strictly above
        # body_recomp at every day-count. Bumping body_recomp to 2 at
        # 6d would also force lift_days=4, which triggers the PPL→UL
        # auto-convert and breaks 6d PPL split balance.
        if available_for_training <= 3:
            cond_days = 0
        elif available_for_training <= 5:
            cond_days = 1
        else:
            cond_days = 1  # cap at 1 (see comment)
    else:
        # Fat-loss / endurance band
        if available_for_training <= 2:
            cond_days = 0
        elif available_for_training <= 4:
            cond_days = 1
        elif available_for_training <= 5:
            cond_days = 2
        else:
            cond_days = 2  # cap at 2

    # ── Step 3: Lifting fills the rest ──
    lift_days = days - recovery_days - cond_days

    # Forced-even-lift-days rule for Upper/Lower. Odd lift_days on U/L
    # guarantees a region imbalance (e.g. 3 lifts = 2 Upper + 1 Lower).
    # Bump lift_days up by 1 so Upper/Lower balance is preserved. Steal
    # the day from recovery first (user still has 2 cardio days on a
    # 6-day fat-loss week), then from conditioning as a last resort.
    # Only applies to U/L — PPL has its own multiple-of-3 rule below.
    from .day_templates import (
        SPLIT_UPPER_LOWER as _SPLIT_UL,
        SPLIT_PPL as _SPLIT_PPL,
        SPLIT_PPL_UL as _SPLIT_PPL_UL,
    )
    if (
        lifting_split == _SPLIT_UL
        and lift_days >= 2
        and lift_days % 2 == 1
    ):
        # At 7 days we preserve BOTH recovery AND at least one cardio
        # day. If lift_days is odd (typical: 5 lifts + 1 cond + 1 rec),
        # instead of stealing cardio or recovery, we DROP one lift and
        # ADD a cardio day. Result: 4 lifts + 2 cardio + 1 recovery —
        # even lifts, cardio preserved, CNS decompression preserved.
        # At ≤6 days the user already has natural off-days so the old
        # "steal recovery" rule still applies (matches existing tests).
        #
        # Gated by `conditioning_frac >= 0.30` — fat_loss / endurance band
        # genuinely wants 2 cardio at 7d. body_recomp (0.10–0.29 band)
        # caps at 1 cardio per the docstring contract, so we fall through
        # to the legacy "steal recovery" branch instead of breaking the
        # cardio cap.
        if days >= 7 and conditioning_frac >= 0.30:
            lift_days -= 1
            cond_days += 1
            logger.debug(
                "[weekly_recipe] U/L force-even-lifts (7d): "
                "traded 1 lift for 1 cardio → %d lifts, %d cond, %d rec",
                lift_days, cond_days, recovery_days,
            )
        elif recovery_days > 0:
            recovery_days -= 1
            lift_days += 1
            logger.debug(
                "[weekly_recipe] U/L force-even-lifts: "
                "moved 1 recovery day → lift_days=%d", lift_days,
            )
        elif cond_days > 1:
            cond_days -= 1
            lift_days += 1
            logger.debug(
                "[weekly_recipe] U/L force-even-lifts: "
                "moved 1 conditioning day → lift_days=%d", lift_days,
            )

    # Forced-multiple-of-3-lift-days rule for PPL (and PPL_UL hybrid,
    # which is PPL-first). A non-mult-of-3 lift_days on PPL guarantees
    # family imbalance — e.g. 5 lifts emits [Push, Pull, Legs, Push,
    # Pull] = 2P/2Pu/1L, under-prescribing Legs (or Pull after
    # rotation). Bump lift_days up to the next multiple of 3 so each
    # family gets equal reps. Steal recovery first, then conditioning
    # (PPL balance is a bigger win than 1 cardio day on a ≥6-day week).
    # Loop up to 2 iterations since the gap is at most 2.
    #
    # Skip lift_days == 4 — that case is already handled by the
    # PPL→UL auto-convert below (which emits 2 Upper / 2 Lower +
    # cardio, a better shape than 6 PPL lifts with no conditioning).
    needs_mult_of_3_lifts = lifting_split in (_SPLIT_PPL, _SPLIT_PPL_UL)
    while (
        needs_mult_of_3_lifts
        and lift_days >= 5
        and lift_days % 3 != 0
        and days >= 6
    ):
        # At 7 days preserve BOTH recovery AND ≥1 cardio. Drop a lift
        # and ADD a cardio instead of stealing (same rule as U/L above).
        # For PPL mult-of-3 at 7d: 5 lifts + 1 cond + 1 rec → 3 lifts +
        # 3 cond + 1 rec. That's lots of cardio — but PPL needs mult of
        # 3 lifts, and at 7 days we keep rest + cardio. Alternative would
        # be 6 lifts stealing from cond/rec, which is what we're avoiding.
        # Step lift_days down to the nearest mult of 3 and convert the
        # freed slots to cardio.
        #
        # Gated by `conditioning_frac >= 0.30` (same as U/L branch) —
        # body_recomp (0.10–0.29 band) caps at 1 cardio per the
        # docstring contract, so for body_recomp 7d PPL we fall through
        # to the steal-recovery branch instead of manufacturing 2 extra
        # cardio days.
        if days >= 7 and conditioning_frac >= 0.30:
            target_lifts = (lift_days // 3) * 3   # nearest multiple of 3 below
            delta = lift_days - target_lifts
            lift_days = target_lifts
            cond_days += delta
            logger.debug(
                "[weekly_recipe] PPL force-mult-of-3-lifts (7d): "
                "traded %d lifts for %d cardio → %d lifts, %d cond, %d rec",
                delta, delta, lift_days, cond_days, recovery_days,
            )
            break
        elif recovery_days > 0:
            recovery_days -= 1
            lift_days += 1
            logger.debug(
                "[weekly_recipe] PPL force-mult-of-3-lifts: "
                "moved 1 recovery day → lift_days=%d", lift_days,
            )
        elif cond_days > 0:
            cond_days -= 1
            lift_days += 1
            logger.debug(
                "[weekly_recipe] PPL force-mult-of-3-lifts: "
                "moved 1 conditioning day → lift_days=%d", lift_days,
            )
        else:
            # Can't satisfy (e.g. no recovery/cond left to donate —
            # 3d PPL with no slack, or full-lift weeks). Fall through;
            # downstream rotation/repair will cope with the imbalance.
            break

    if cond_days == 0 and recovery_days == 0:
        return _lifting_recipe(profile, lifting_split, days, priority_region=priority_region)
    # ── Intentional PPL→UL compatibility fix (mixed-mode only) ──
    # A 3-move PPL cycle on exactly 4 lift days emits
    # [Push, Pull, Legs, Push] — which creates two Pushes that can
    # never be fully spaced once you add cardio + run rotation for
    # recent-focus avoidance. For those cases, transparently use an
    # Upper/Lower split so the 4 lift days divide evenly into
    # [Upper, Lower, Upper, Lower].
    #
    # IMPORTANT: this only fires when the user did NOT explicitly pick
    # PPL (user_chose_split is False). A user-chosen PPL split is always
    # honored; duplicate-repair + intensity spacing handle overlap for
    # that case. Do NOT generalize this auto-convert to other lift_day
    # counts without revisiting split_identity tests and the UL priority
    # scoring path.
    from .day_templates import SPLIT_PPL, SPLIT_UPPER_LOWER
    effective_split = lifting_split
    if lift_days == 4 and lifting_split == SPLIT_PPL and not user_chose_split:
        logger.info(
            "[weekly_recipe] PPL→UL auto-convert (intentional compatibility fix): "
            "lift_days=4 on PPL without user_chose_split → switching to upper_lower "
            "to avoid duplicate Push/Pull/Legs day"
        )
        effective_split = SPLIT_UPPER_LOWER
    lifting = _lifting_recipe(profile, effective_split, lift_days, priority_region=priority_region)

    # ── Build conditioning archetype sequence ──
    # Zone 2 first (high-value, low-cost), then intervals, then circuit.
    cond_sequence = [
        DayArchetype.COND_ZONE2,
        DayArchetype.COND_INTERVALS_SHORT,
        DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
    ]
    cond: list[DayArchetype] = []
    ci = 0
    while len(cond) < cond_days and ci < len(cond_sequence) * 3:
        candidate = cond_sequence[ci % len(cond_sequence)]
        if candidate in profile.allowed_archetypes:
            cond.append(candidate)
        ci += 1
    while len(cond) < cond_days:
        cond.append(DayArchetype.COND_ZONE2)

    # ── Build recovery archetype(s) ──
    recovery: list[DayArchetype] = []
    for _ in range(recovery_days):
        recovery.append(_pick_recovery_archetype(profile))

    # Interleave cardio into the lifting sequence at positions that
    # DON'T break the split's natural rotation. For PPL, cardio goes
    # after each full Push→Pull→Legs cycle. For UL, after each U→L
    # pair. For Full Body, evenly spaced.
    from .day_templates import SPLIT_PPL, SPLIT_PPL_UL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY
    if effective_split in (SPLIT_PPL, SPLIT_PPL_UL):
        cycle_len = 3  # PPL cycle
    elif effective_split == SPLIT_UPPER_LOWER:
        cycle_len = 2  # UL pair
    elif effective_split == SPLIT_FULL_BODY:
        cycle_len = 2  # every other day
    else:
        cycle_len = 3  # default

    # Even-distribution interleave. Previous approach ran a paired
    # counter (insert a cardio after every `cycle_len` lifts, drain
    # any leftover cardios at the tail) — on short recipes with few
    # lifts, the "tail drain" step emitted consecutive cardio days
    # (e.g. 3 lifts + 2 cardio at cycle=3 produced
    # [Push, Pull, Legs, Zone2, IntervalsShort]). A downstream
    # adjacency-repair pass caught most of it, but the structural
    # emission of cardio→cardio in the interleave is a latent bug
    # whenever len(cond) + leftover > available non-cardio positions
    # at the tail. Fix: compute the cardio insertion positions
    # up-front across the WHOLE `total` span so each cardio lands
    # between lifts, not after the last lift. Positions are chosen
    # so at least one lift (or recovery, below) sits between cardios
    # whenever mathematically possible.
    total = len(lifting) + len(cond)
    out: list[DayArchetype] = [None] * total  # type: ignore[list-item]
    if len(cond) == 0:
        cond_positions: list[int] = []
    elif total <= 1:
        cond_positions = [0] if len(cond) else []
    else:
        # Evenly-spaced indices in [0, total-1]. For 5 days with 2
        # cardios: positions 1 and 3 → lift/cond/lift/cond/lift.
        # For 3 days with 1 cardio: position 1 → lift/cond/lift.
        # For 6 days with 2 cardios: positions 1, 4 → L/C/L/L/C/L.
        # Prefer the first cardio at position 1 so day 0 stays a
        # lift (users expect Monday to be lifting, not cardio).
        if len(cond) == 1:
            cond_positions = [total // 2]
        else:
            # Spread across [1, total-1] to keep day 0 as a lift.
            span = total - 1
            step = span / len(cond)
            cond_positions = [
                min(total - 1, int(round(1 + step * i)))
                for i in range(len(cond))
            ]
            # Deduplicate / guarantee strictly increasing, non-adjacent.
            used: set[int] = set()
            fixed: list[int] = []
            for p in cond_positions:
                q = p
                while q in used or (fixed and q - fixed[-1] < 2):
                    q += 1
                    if q >= total:
                        # Walk backward if we've run off the end.
                        q = p
                        while q in used or (fixed and abs(q - fixed[-1]) < 2):
                            q -= 1
                            if q < 0:
                                q = p
                                break
                        break
                if 0 <= q < total:
                    used.add(q)
                    fixed.append(q)
            cond_positions = sorted(fixed) if fixed else cond_positions
    cond_pos_set = set(cond_positions)
    ci = 0
    li = 0
    for i in range(total):
        if i in cond_pos_set and ci < len(cond):
            out[i] = cond[ci]
            ci += 1
        elif li < len(lifting):
            out[i] = lifting[li]
            li += 1
    # Backfill any Nones (shouldn't happen, but be defensive).
    for i in range(total):
        if out[i] is None:
            if li < len(lifting):
                out[i] = lifting[li]; li += 1
            elif ci < len(cond):
                out[i] = cond[ci]; ci += 1

    # Recovery day(s) go at the END of the week. Placing them last
    # means the user's final training day before the weekend (or the
    # cycle restart) is low-stress, giving the CNS a full reset.
    out.extend(recovery)

    assert len(out) == days, f"Recipe length {len(out)} != requested {days} days (lift={lift_days} cond={cond_days} recovery={recovery_days})"
    return _repair_adjacent_duplicates(
        out,
        allowed_archetypes=profile.allowed_archetypes,
        lifting_split=lifting_split,
        user_chose_split=user_chose_split,
    )


# ── Family-sibling substitution map ─────────────────────────────────
# When adjacency repair via pure swaps is mathematically impossible
# (e.g. a 5-day UL recipe rotated to start with the minority family
# [Lower, Upper, Lower, Upper, Upper] — any swap leaves 1 dup because
# counts are 3:2), we substitute one of the offending days with its
# cross-family sibling of equivalent stimulus. That rebalances the
# count to 2:3 and eliminates the structural adjacency. Used only as
# a last resort AFTER tier A/B/C can't reduce dups further. Keyed by
# the archetype to substitute AWAY from; value is the cross-family
# sibling that preserves stimulus intent.
_FAMILY_SIBLING_SWAPS: dict["DayArchetype", "DayArchetype"] = {
    # U/L siblings (upper ↔ lower)
    DayArchetype.LIFT_UPPER: DayArchetype.LIFT_LOWER,
    DayArchetype.LIFT_LOWER: DayArchetype.LIFT_UPPER,
    DayArchetype.LIFT_UPPER_HEAVY: DayArchetype.LIFT_LOWER_HEAVY,
    DayArchetype.LIFT_LOWER_HEAVY: DayArchetype.LIFT_UPPER_HEAVY,
    DayArchetype.LIFT_UPPER_HYPERTROPHY: DayArchetype.LIFT_LOWER_HYPERTROPHY,
    DayArchetype.LIFT_LOWER_HYPERTROPHY: DayArchetype.LIFT_UPPER_HYPERTROPHY,
    # PPL siblings (push ↔ pull; legs is deliberately not paired —
    # swapping to legs would break split rotation and over-fatigue
    # the lower body).
    DayArchetype.LIFT_PUSH: DayArchetype.LIFT_PULL,
    DayArchetype.LIFT_PULL: DayArchetype.LIFT_PUSH,
    DayArchetype.LIFT_PUSH_HEAVY: DayArchetype.LIFT_PULL_HEAVY,
    DayArchetype.LIFT_PULL_HEAVY: DayArchetype.LIFT_PUSH_HEAVY,
    DayArchetype.LIFT_PUSH_VOLUME: DayArchetype.LIFT_PULL_VOLUME,
    DayArchetype.LIFT_PULL_VOLUME: DayArchetype.LIFT_PUSH_VOLUME,
}


def _repair_adjacent_duplicates(
    recipe: list[DayArchetype],
    *,
    allowed_archetypes: frozenset["DayArchetype"] | None = None,
    lifting_split: str | None = None,
    user_chose_split: bool = False,
) -> list[DayArchetype]:
    """Deterministic sweep that swaps adjacent same-bucket days so
    the user never gets Push → Push or Legs → Legs back to back.

    Called twice in the pipeline:
      1. After interleaving lift+cardio (inside _lifting_plus_cardio_recipe)
         to fix the PPL-at-4-lift-days case that duplicates Push.
      2. After the recent-focus rotation pass in generate_weekly_recipe,
         because rotating [Push, Z2, Pull, Short, Legs, Push] by 1
         produces [Z2, Pull, Short, Legs, Push, Push] — reintroducing
         the adjacency that call #1 already cleaned up.

    Repair strategy (four tiers, increasing aggressiveness):
      Tier A — strict swap: swap a conflicting day with a later / earlier
               day whose family differs AND the swap introduces no new
               adjacency conflicts at either position.
      Tier B — net-reducing swap: accept any swap that strictly reduces
               the total adjacent-duplicate count, even if it creates a
               transient conflict elsewhere (the next pass will clean
               it up).
      Tier C — force swap to break 3+ same-family streaks: when a streak
               of >=3 same-family days survives tier A/B (e.g. a rotation
               leaves [upper, lower, lower, lower] and every swap target
               creates a new conflict under tier A), pick the swap that
               minimises adjacency count; if none, pick the swap that
               at least breaks the 3-in-a-row.
      Tier D — family-sibling substitution: when counts are imbalanced
               (e.g. 5-day UL with rotation forcing minority-family
               first → 3:2 split → structurally forces 1 adjacency),
               substitute one offending day's archetype with its
               cross-family sibling (Upper↔Lower, Push↔Pull) to
               rebalance counts. Only fires when the sibling is in
               `allowed_archetypes` (or allowed_archetypes is None).
               Never introduced new adjacencies.

    The whole thing runs in a fixed-iteration loop (bounded, deterministic)
    until no improvement is possible. Stable plans stay stable — the
    tiers only fire when conflicts exist.
    """
    from .archetypes import archetype_to_focus_family

    def _b(a):
        try:
            return archetype_to_focus_family(a)
        except KeyError:
            return None

    def _total_dups(lst) -> int:
        return sum(1 for i in range(1, len(lst)) if _b(lst[i]) == _b(lst[i - 1]))

    def _has_triple(lst) -> bool:
        return any(
            _b(lst[i]) is not None
            and _b(lst[i]) == _b(lst[i + 1]) == _b(lst[i + 2])
            for i in range(len(lst) - 2)
        )

    def _safe_swap(lst, a, b):
        """Return True if swapping positions a and b doesn't create
        new adjacency conflicts at either position."""
        test = list(lst)
        test[a], test[b] = test[b], test[a]
        for pos in (a, b):
            fam = _b(test[pos])
            if pos > 0 and _b(test[pos - 1]) == fam:
                return False
            if pos < len(test) - 1 and _b(test[pos + 1]) == fam:
                return False
        return True

    def _try_swap_at(lst, i):
        """Tier A: find a swap that clears the conflict at i without
        creating any new adjacency. Returns swap index or None."""
        for j in range(i + 1, len(lst)):
            if _b(lst[j]) != _b(lst[i]) and _safe_swap(lst, i, j):
                return j
        for j in range(i - 2, 0, -1):
            if _b(lst[j]) != _b(lst[i]) and _safe_swap(lst, i, j):
                return j
        return None

    def _best_net_reducing_swap_for_pair(lst, i):
        """Tier B: for a conflict at (i-1, i), consider swapping EITHER
        endpoint with any other index whose family differs. Pick the
        swap that most reduces total duplicate count. Returns
        (endpoint, j, new_dups) or (None, None, current) when no swap
        strictly reduces the count. Unlike tier A, this does NOT
        require the resulting state to be conflict-free — only that
        the TOTAL adjacency count strictly decreases."""
        current = _total_dups(lst)
        best = (None, None, current)
        for endpoint in (i - 1, i):
            for j in range(len(lst)):
                if j == endpoint:
                    continue
                if _b(lst[j]) == _b(lst[endpoint]):
                    continue
                test = list(lst)
                test[endpoint], test[j] = test[j], test[endpoint]
                nd = _total_dups(test)
                if nd < best[2]:
                    best = (endpoint, j, nd)
        return best

    def _force_triple_break(lst):
        """Tier C: final guarantee no 3-in-a-row survives. For each
        3-in-a-row we pick the single swap (any indices) that gives the
        lowest adjacency count; tie-break on smallest (i, j). Even if
        the chosen swap leaves some 2-adjacency behind (hardest cases),
        it MUST eliminate the 3-in-a-row."""
        changed = False
        for start in range(len(lst) - 2):
            fam = _b(lst[start])
            if fam is None:
                continue
            if not (fam == _b(lst[start + 1]) == _b(lst[start + 2])):
                continue
            # Try every swap and pick the one that (a) breaks this
            # triple and (b) has the lowest resulting total dup count.
            best = None  # (total_dups, has_triple, i, j)
            for i in range(start, start + 3):
                for j in range(len(lst)):
                    if j == i:
                        continue
                    if _b(lst[j]) == fam:
                        continue
                    test = list(lst)
                    test[i], test[j] = test[j], test[i]
                    # Require triple at THIS start to be broken.
                    still_triple_here = (
                        _b(test[start]) == _b(test[start + 1]) == _b(test[start + 2])
                        and _b(test[start]) is not None
                    )
                    if still_triple_here:
                        continue
                    key = (_total_dups(test), _has_triple(test), i, j)
                    if best is None or key < best:
                        best = key
            if best is not None:
                _, _, i, j = best
                logger.debug(
                    f"[weekly_recipe] adjacency-repair tier-C: forced swap "
                    f"{i}↔{j} to break {fam!r} triple at pos {start}"
                )
                lst[i], lst[j] = lst[j], lst[i]
                changed = True
        return changed

    out = list(recipe)

    # ── Tier A/B: iterative dup-clearing ────────────────────────────
    # Bounded loop: each iteration must strictly reduce total dup count
    # or we exit. Upper bound is len(out) — more than enough in practice.
    max_iters = len(out) + 2
    for _ in range(max_iters):
        start_dups = _total_dups(out)
        if start_dups == 0:
            break

        # Tier A: walk left-to-right, apply strict safe swaps.
        for i in range(1, len(out)):
            if _b(out[i]) != _b(out[i - 1]):
                continue
            swap_idx = _try_swap_at(out, i)
            if swap_idx is not None:
                out[i], out[swap_idx] = out[swap_idx], out[i]
                logger.debug(
                    f"[weekly_recipe] adjacency-repair tier-A: swapped idx "
                    f"{i}↔{swap_idx} to break {_b(out[swap_idx])!r} streak"
                )

        mid_dups = _total_dups(out)
        if mid_dups == 0:
            break

        # Tier B: for each remaining conflict (i-1, i), try the best
        # net-reducing swap on EITHER endpoint. May temporarily create
        # a new adjacency elsewhere — the outer loop will clean it up.
        progress = False
        for i in range(1, len(out)):
            if _b(out[i]) != _b(out[i - 1]):
                continue
            endpoint, j, new_dups = _best_net_reducing_swap_for_pair(out, i)
            if j is not None and new_dups < _total_dups(out):
                logger.debug(
                    f"[weekly_recipe] adjacency-repair tier-B: net-reducing "
                    f"swap {endpoint}↔{j} (dups {_total_dups(out)}→{new_dups})"
                )
                out[endpoint], out[j] = out[j], out[endpoint]
                progress = True

        if not progress and _total_dups(out) >= start_dups:
            # No forward progress with tier A or B — break out and let
            # tier C handle any triples that remain.
            break

    # ── Tier C: guarantee no 3-in-a-row ─────────────────────────────
    # Runs at most len(out) times (one pass per possible triple).
    for _ in range(len(out)):
        if not _has_triple(out):
            break
        if not _force_triple_break(out):
            break

    # ── Tier D: family-sibling substitution ─────────────────────────
    # For each remaining 2-adjacency that tier A/B couldn't resolve
    # (structurally imbalanced counts), substitute one offending day
    # with its cross-family sibling. The sibling preserves stimulus
    # intent (heavy/volume/hypertrophy), just flips upper↔lower or
    # push↔pull. Only applied when the sibling is permitted by the
    # profile (or no profile is supplied). Runs at most len(out)
    # times to keep total bounded.
    #
    # Skip tier D for user-chosen PPL / PPL_UL — substituting Push→Pull
    # would break the Push→Pull→Legs cycle the user explicitly selected,
    # and `_preserves_split_identity` would revert the substitution
    # anyway. Skipping here avoids wasted work + log spam. UL is NOT
    # skipped because sibling substitution (Upper↔Lower) RESTORES the
    # strict alternation that defines UL's split identity, so the guard
    # happily accepts it. Auto / None split also runs tier D normally.
    from .day_templates import (
        SPLIT_PPL as _SPLIT_PPL_TD,
        SPLIT_PPL_UL as _SPLIT_PPL_UL_TD,
    )
    _skip_tier_d = bool(user_chose_split) and lifting_split in (
        _SPLIT_PPL_TD, _SPLIT_PPL_UL_TD,
    )
    for _ in range(0 if _skip_tier_d else len(out)):
        if _total_dups(out) == 0:
            break
        substituted = False
        for i in range(1, len(out)):
            if _b(out[i]) != _b(out[i - 1]):
                continue
            # Try substituting either endpoint with its sibling.
            for endpoint in (i, i - 1):
                sibling = _FAMILY_SIBLING_SWAPS.get(out[endpoint])
                if sibling is None:
                    continue
                if allowed_archetypes is not None and sibling not in allowed_archetypes:
                    continue
                test = list(out)
                test[endpoint] = sibling
                # Require the substitution to strictly reduce dups and
                # not create a new adjacency at the substituted index.
                new_dups = _total_dups(test)
                if new_dups < _total_dups(out):
                    logger.debug(
                        f"[weekly_recipe] adjacency-repair tier-D: substituted "
                        f"idx {endpoint} {out[endpoint].value} → {sibling.value} "
                        f"(dups {_total_dups(out)}→{new_dups})"
                    )
                    out[endpoint] = sibling
                    substituted = True
                    break
            if substituted:
                break
        if not substituted:
            break

    return out


# Back-compat alias so any older import of the fat-loss-specific name
# still resolves. Internal callers should use the new name.
_fat_loss_recipe = _lifting_plus_cardio_recipe


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


# ── HYROX / hybrid race mode ────────────────────────────────────────


def _hyrox_recipe(profile: GoalProfile, days: int) -> list[DayArchetype]:
    """HYROX-style hybrid race prep. Conditioning-heavy with functional
    strength support. Key principles:
      - Running / intervals are the backbone (aerobic engine)
      - Hybrid circuit days simulate race stations
      - Strength is functional (sled push/pull, carries, lunges, wall balls)
      - Lower-body fatigue management is critical
      - Recovery days prevent overtraining the running base
    """
    A = DayArchetype
    if days == 1:
        return [A.HYBRID_FULL_BODY_CIRCUIT]
    if days == 2:
        return [A.COND_INTERVALS_SHORT, A.HYBRID_FULL_BODY_CIRCUIT]
    if days == 3:
        # 1 strength, 1 intervals, 1 hybrid circuit
        return [A.LIFT_FULL_BODY, A.COND_INTERVALS_SHORT, A.HYBRID_FULL_BODY_CIRCUIT]
    if days == 4:
        # 1 lower strength, 1 intervals, 1 zone 2, 1 hybrid circuit
        return [A.LIFT_LOWER, A.COND_INTERVALS_SHORT, A.COND_ZONE2, A.HYBRID_FULL_BODY_CIRCUIT]
        # Zone 2 between intervals and circuit as recovery spacer
    if days == 5:
        # 2 conditioning, 1 hybrid, 1 strength, 1 zone 2
        return [
            A.COND_INTERVALS_SHORT,
            A.LIFT_FULL_BODY,
            A.COND_ZONE2,
            A.HYBRID_FULL_BODY_CIRCUIT,
            A.COND_TEMPO,
        ]
    # 6-7 days: full HYROX build
    base = [
        A.COND_INTERVALS_SHORT,     # speed / threshold
        A.LIFT_LOWER,               # sled/carry/lunge strength
        A.COND_ZONE2,               # aerobic base (easy)
        A.HYBRID_FULL_BODY_CIRCUIT, # station simulation
        A.LIFT_UPPER,               # upper support + core
        A.COND_TEMPO,               # sustained effort
    ]
    if days >= 7:
        base.append(A.MOBILITY_FLOW)  # recovery day
    return base[:days]


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


# ── Intensity-cost spacing ─────────────────────────────────────────


_HEAVY_TO_VOLUME: dict[DayArchetype, DayArchetype] = {
    DayArchetype.LIFT_PUSH_HEAVY: DayArchetype.LIFT_PUSH_VOLUME,
    DayArchetype.LIFT_PULL_HEAVY: DayArchetype.LIFT_PULL_VOLUME,
    DayArchetype.LIFT_LEGS_HEAVY: DayArchetype.LIFT_LEGS_VOLUME,
    DayArchetype.LIFT_UPPER_HEAVY: DayArchetype.LIFT_UPPER_HYPERTROPHY,
    DayArchetype.LIFT_LOWER_HEAVY: DayArchetype.LIFT_LOWER_HYPERTROPHY,
    DayArchetype.LIFT_FULL_BODY_STRENGTH: DayArchetype.LIFT_FULL_BODY,
}

# Fatigue weights: legs are extra fatiguing because they tax the whole
# central nervous system, not just the target muscles.
_LEGS_ARCHETYPES = frozenset({
    DayArchetype.LIFT_LEGS, DayArchetype.LIFT_LEGS_HEAVY,
    DayArchetype.LIFT_LEGS_VOLUME, DayArchetype.LIFT_LOWER,
    DayArchetype.LIFT_LOWER_HEAVY, DayArchetype.LIFT_LOWER_HYPERTROPHY,
    DayArchetype.LIFT_BRO_LEGS, DayArchetype.HYBRID_LOWER_POWER,
})


def _fatigue_cost(a: DayArchetype) -> float:
    """Systemic fatigue score (0.0-1.0) for rolling-window calculation.

    Separate from intensity_cost (which is an integer for swap logic).
    This models cumulative nervous-system drain: heavy compounds are
    expensive, legs are extra expensive, cardio/mobility are cheap.
    """
    meta = ARCHETYPE_META[a]
    base = {
        1: 0.05,   # mobility/recovery
        2: 0.15,   # zone 2 cardio
        3: 0.35,   # volume lifting, tempo cardio
        4: 0.55,   # heavy push/pull, hypertrophy compounds, intervals
        5: 0.75,   # heavy legs, full-body strength, hybrid power
    }[meta.intensity_cost]
    if a in _LEGS_ARCHETYPES:
        base = min(1.0, base + 0.10)
    return base


def _is_heavy(a: DayArchetype) -> bool:
    """True for archetypes classified as heavy / strength stimulus."""
    meta = ARCHETYPE_META[a]
    return meta.training_type in ("strength", "power", "mixed") and meta.intensity_cost >= 4


def _is_resistance(a: DayArchetype) -> bool:
    """True for any lifting or hybrid archetype (not pure cardio/mobility/recovery)."""
    return ARCHETYPE_META[a].category in ("lift", "hybrid")


def _space_high_intensity_days(
    recipe: list[DayArchetype],
    *,
    goal_allows_heavy_streaks: bool = False,
) -> list[DayArchetype]:
    """Post-recipe repair pass that prevents unrealistic intensity stacking.

    Rules enforced (in priority order):

    1. HEAVY DAY STACKING GUARD
       - Never allow 3+ consecutive heavy (strength/power, cost >= 4) days.
       - Prefer max 2 consecutive heavy days. For non-strength goals,
         prefer max 1 consecutive heavy day.
       - When a streak is found, try to swap with a nearby low-cost day.
         If no swap target exists, downgrade the middle day from heavy
         to its volume/hypertrophy counterpart.

    2. ROLLING FATIGUE THRESHOLD
       - Sum the fatigue_cost of each 3-day window. If the rolling sum
         exceeds the threshold (default 1.6, ~53% of max), downgrade
         the highest-cost day in that window.

    3. HEAVY LEGS PLACEMENT
       - Heavy legs should not appear after 2+ accumulated hard days
         unless the user is strength-focused. If it does, swap or
         downgrade the preceding day.

    4. RECOVERY WINDOW AFTER RESISTANCE STREAKS
       - After 3 consecutive resistance-training days, prefer the 4th
         day to be cardio, mobility, or recovery (cost <= 2). If not,
         try to swap with a nearby low-cost day.
    """
    if len(recipe) < 2:
        return recipe

    out = list(recipe)
    max_heavy_streak = 3 if goal_allows_heavy_streaks else 2
    # Threshold for the rolling 3-day fatigue window. 2.10 allows one
    # heavy (0.75 upper / 0.85 legs) plus two adjacent lift-hypertrophy
    # days (0.55 upper / 0.65 legs, max 1.30) without triggering a
    # downgrade — otherwise UL hypertrophy-biased weeks for
    # muscle_gain / body_recomp lose every heavy day to this pass.
    # Strength goals get 2.20 so UH + LH + Hy (2.15) survives but UH +
    # LH + LH (2.45) doesn't (Pass 1 handles 3-heavy streaks anyway).
    fatigue_threshold = 2.20 if goal_allows_heavy_streaks else 2.10

    def _cost(a: DayArchetype) -> int:
        return ARCHETYPE_META[a].intensity_cost

    def _find_swap(exclude: set[int], max_cost: int = 3) -> int | None:
        """Find nearest day index with cost <= max_cost, not in exclude."""
        best_idx, best_dist = None, len(out) + 1
        center = sum(exclude) / max(1, len(exclude))
        for j in range(len(out)):
            if j in exclude:
                continue
            if _cost(out[j]) > max_cost:
                continue
            dist = abs(j - center)
            if dist < best_dist:
                best_dist = dist
                best_idx = j
        return best_idx

    def _downgrade(idx: int) -> bool:
        """Try to downgrade a heavy archetype to its volume counterpart."""
        vol = _HEAVY_TO_VOLUME.get(out[idx])
        if vol:
            logger.debug(f"[intensity] downgrading day {idx} from {out[idx].value} to {vol.value}")
            out[idx] = vol
            return True
        return False

    # ── Pass 1: Break consecutive heavy streaks ──────────────────────
    changed = True
    iterations = 0
    while changed and iterations < 5:
        changed = False
        iterations += 1
        streak_start = -1
        streak_len = 0
        for i in range(len(out)):
            if _is_heavy(out[i]):
                if streak_start < 0:
                    streak_start = i
                streak_len = i - streak_start + 1
            else:
                streak_start = -1
                streak_len = 0

            if streak_len > max_heavy_streak:
                mid = streak_start + streak_len // 2
                swap_idx = _find_swap(set(range(streak_start, i + 1)))
                if swap_idx is not None:
                    logger.debug(
                        f"[intensity] heavy streak days {streak_start}-{i}: "
                        f"swapping day {mid} ({out[mid].value}) with "
                        f"day {swap_idx} ({out[swap_idx].value})"
                    )
                    out[mid], out[swap_idx] = out[swap_idx], out[mid]
                    changed = True
                    break
                elif _downgrade(mid):
                    changed = True
                    break

    # ── Pass 2: Rolling 3-day fatigue window ─────────────────────────
    for i in range(len(out) - 2):
        window = [out[i], out[i + 1], out[i + 2]]
        total = sum(_fatigue_cost(a) for a in window)
        if total <= fatigue_threshold:
            continue
        costs = [(j, _fatigue_cost(out[i + j])) for j in range(3)]
        costs.sort(key=lambda x: -x[1])
        worst_offset = costs[0][0]
        worst_idx = i + worst_offset
        if _downgrade(worst_idx):
            logger.debug(
                f"[intensity] 3-day fatigue {total:.2f} > {fatigue_threshold} "
                f"at days {i}-{i+2}, downgraded day {worst_idx}"
            )
        else:
            swap_idx = _find_swap({i, i + 1, i + 2})
            if swap_idx is not None:
                logger.debug(
                    f"[intensity] 3-day fatigue {total:.2f}: swapping "
                    f"day {worst_idx} ({out[worst_idx].value}) with "
                    f"day {swap_idx} ({out[swap_idx].value})"
                )
                out[worst_idx], out[swap_idx] = out[swap_idx], out[worst_idx]

    # ── Pass 3: Heavy legs after accumulated fatigue ─────────────────
    # Threshold (prev 2 days' cumulative fatigue) above which heavy
    # legs on day i gets downgraded. Previously 0.9 — too aggressive:
    # a single upper-heavy (0.75) + any lift triggered the downgrade,
    # which stripped the week's second heavy day from hypertrophy-
    # biased plans (muscle_gain, body_recomp at 5-6 lifts on UL).
    # 1.4 allows UH + Hy (1.30) before a heavy-legs session but still
    # blocks UH + UH (1.50) or LH + Hy (1.40 → still blocked as
    # consecutive heavies). Strength goals get 1.7 so their
    # heavy-upper + heavy-lower pairs don't strip the follow-on heavy.
    heavy_legs_prev_fatigue_threshold = 1.7 if goal_allows_heavy_streaks else 1.4
    for i in range(2, len(out)):
        if out[i] not in _LEGS_ARCHETYPES:
            continue
        if not _is_heavy(out[i]):
            continue
        prev_fatigue = sum(_fatigue_cost(out[j]) for j in range(max(0, i - 2), i))
        if prev_fatigue < heavy_legs_prev_fatigue_threshold:
            continue
        if _downgrade(i):
            logger.debug(f"[intensity] heavy legs at day {i} after fatigue {prev_fatigue:.2f}, downgraded")

    # ── Pass 4: Resistance streaks need recovery windows ─────────────
    for i in range(3, len(out)):
        if not all(_is_resistance(out[j]) for j in range(i - 3, i)):
            continue
        if _cost(out[i]) <= 2:
            continue
        swap_idx = _find_swap({i - 3, i - 2, i - 1, i}, max_cost=2)
        if swap_idx is not None:
            logger.debug(
                f"[intensity] 3 resistance days before day {i}: "
                f"swapping day {i} ({out[i].value}) with "
                f"day {swap_idx} ({out[swap_idx].value})"
            )
            out[i], out[swap_idx] = out[swap_idx], out[i]

    # ── Pass 5: Original pairwise spacing (cost-5 adjacent to cost-4/5) ──
    for i in range(1, len(out)):
        ca, cb = _cost(out[i - 1]), _cost(out[i])
        if not (ca >= 5 and cb >= 4) and not (ca >= 4 and cb >= 5):
            continue
        swap_idx = _find_swap({i - 1, i})
        if swap_idx is not None:
            logger.debug(
                f"[intensity] pairwise spacing: swapped day {i} "
                f"({out[i].value}, cost={cb}) with day {swap_idx} "
                f"({out[swap_idx].value}, cost={_cost(out[swap_idx])})"
            )
            out[i], out[swap_idx] = out[swap_idx], out[i]

    # ── Pass 6: Heavy-pair cooldown ─────────────────────────────────
    # After two consecutive heavy sessions (e.g. Upper_Heavy →
    # Lower_Heavy for strength goals), day N+2 should NOT also be
    # heavy — the CNS needs one decompression day of cardio /
    # mobility / hypertrophy / volume. If we find a `heavy → heavy
    # → heavy` triple that Pass 1 left intact (e.g. because the
    # streak limit was 3 for strength), demote OR swap the third
    # heavy day. Deterministic: prefer swapping with the nearest
    # non-heavy day later in the recipe, fall back to downgrade.
    # Only triggers on the third consecutive heavy; two-in-a-row is
    # already handled by Pass 1 for non-strength goals.
    for i in range(2, len(out)):
        if not (_is_heavy(out[i - 2]) and _is_heavy(out[i - 1]) and _is_heavy(out[i])):
            continue
        # Try to swap with the nearest non-heavy day AFTER the pair
        # (keep the pair intact — demoting day i preserves the CNS
        # rhythm; swapping shifts the 3rd heavy to a different part
        # of the week). Search forward first, then backward.
        swap_idx = None
        for j in list(range(i + 1, len(out))) + list(range(0, i - 2)):
            if _is_heavy(out[j]):
                continue
            swap_idx = j
            break
        if swap_idx is not None:
            logger.debug(
                f"[intensity] heavy-pair cooldown: day {i} "
                f"({out[i].value}) follows heavy pair {i-2}-{i-1}; "
                f"swapping with day {swap_idx} ({out[swap_idx].value})"
            )
            out[i], out[swap_idx] = out[swap_idx], out[i]
        else:
            _downgrade(i)

    return out


# ── Public entry point ─────────────────────────────────────────────


# ── Recent-focus rotation ────────────────────────────────────────────
#
# When the user just completed sessions in the last ~36 hours, day 1
# of the regenerated recipe must NOT be the same kind of day as what
# they already trained. A user who hit Back yesterday and Legs today
# should see something OTHER than lower/legs tomorrow — and ideally
# not repeat back either.
#
# This rotation pass runs AFTER the mode-specific recipe generator.
# It's conservative for anchored modes: endurance / athletic /
# mobility / recovery recipes are intentionally placed (strength
# maintenance goes at the end of the week, sprint power days sit
# next to strength days, etc.) and rotating them would break that.
# Only `lifting` / `fat_loss_mix` / `maintain` modes get rotated.


def _archetype_bucket(archetype: DayArchetype) -> str | None:
    """Classify an archetype by FOCUS FAMILY (fine-grained: push ≠ pull).
    Used by rotation and adjacency logic so PPL split identity is
    preserved. Falls back to coarse stress bucket if not found."""
    try:
        return archetype_to_focus_family(archetype)
    except KeyError:
        try:
            return archetype_to_focus_bucket(archetype)
        except KeyError:
            return None


def _count_adjacent_duplicates(recipe: list[DayArchetype]) -> int:
    """Count pairs of neighboring days that share a focus FAMILY.
    Used as the secondary score in rotation selection so we prefer
    rotations that keep Push/Pull/Legs spaced out."""
    from .archetypes import archetype_to_focus_family
    dups = 0
    for i in range(1, len(recipe)):
        try:
            if archetype_to_focus_family(recipe[i]) == archetype_to_focus_family(recipe[i - 1]):
                dups += 1
        except KeyError:
            pass
    return dups


_COARSE_BUCKETS = {"upper_body", "lower_body", "full_body", "cardio", "mobility", "recovery"}
_FINE_FAMILIES = {"push", "pull", "legs", "upper", "lower", "full_body", "cardio", "mobility", "recovery"}

# Fine focus family → coarse bucket. Used by rotation + lift-priority
# rescue when the caller passes fine families but we also want to fall
# back to coarse-bucket awareness. Mirrors
# `focus_normalize.BUCKET_TO_FAMILIES` inverted so everything stays
# consistent with the rest of the codebase.
_FINE_TO_COARSE: dict[str, str] = {
    "push": "upper_body",
    "pull": "upper_body",
    "upper": "upper_body",
    "legs": "lower_body",
    "lower": "lower_body",
    "full_body": "full_body",
    "cardio": "cardio",
    "mobility": "mobility",
    "recovery": "recovery",
}


def _has_lifted_recently(
    recent_focus_families: tuple[str, ...] | list[str] | None,
    recent_focus_buckets: tuple[str, ...] | list[str] | None,
) -> bool:
    """Return True iff the user's recent focus history shows at least
    one lifting session (any push/pull/legs/upper/lower/full_body
    family OR any upper_body/lower_body/full_body coarse bucket).
    Centralized so rotation and lift-priority rescue agree on the
    definition of "has the user lifted recently?"."""
    _LIFT_FAMILIES = {"push", "pull", "legs", "upper", "lower", "full_body"}
    _LIFT_COARSE = {"upper_body", "lower_body", "full_body"}
    fams = list(recent_focus_families or ())
    if any(fam in _LIFT_FAMILIES for fam in fams):
        return True
    # Fine→coarse expansion: if fine families were passed (e.g. ("pull",))
    # their coarse equivalents ("upper_body",) count too. Redundant for
    # pure lift families (already covered above), but explicit for
    # clarity + future coarse-only lifting tokens.
    expanded_coarse = {_FINE_TO_COARSE.get(fam) for fam in fams if fam}
    if any(b in _LIFT_COARSE for b in expanded_coarse if b):
        return True
    # Fall back to explicit recent_focus_buckets when families is empty.
    if not fams:
        for b in (recent_focus_buckets or ()):
            if b in _LIFT_COARSE:
                return True
    return False


def _lift_tokens_of(recipe: list[DayArchetype]) -> list[str]:
    """Ordered list of lift-family tokens in `recipe`, skipping cardio /
    mobility / recovery insertions."""
    out: list[str] = []
    for a in recipe:
        try:
            fam = archetype_to_focus_family(a)
        except KeyError:
            continue
        if fam in ("push", "pull", "legs", "upper", "lower", "full_body"):
            out.append(fam)
    return out


def _ppl_cycle_breaks(lift_tokens: list[str], hybrid: bool) -> int:
    """Count transitions in `lift_tokens` that violate the PPL cycle
    (push→pull→legs→push…). Compared CIRCULARLY — the last token's
    successor must match the first — so a rotation of a valid cycle
    also scores 0. For PPL_UL (`hybrid=True`), also accept legs→upper,
    upper→lower, lower→push."""
    strict = {"push": "pull", "pull": "legs", "legs": "push"}
    hybrid_map = {
        "push": {"pull"},
        "pull": {"legs"},
        "legs": {"push", "upper"},
        "upper": {"lower"},
        "lower": {"push"},
    }
    if not lift_tokens:
        return 0
    breaks = 0
    n = len(lift_tokens)
    # Circular: i pairs with (i+1) mod n. Means a simple rotation of a
    # well-formed cycle scores the same as the original — rotation
    # passes don't trip the guard by construction.
    for i in range(n):
        cur = lift_tokens[i]
        nxt = lift_tokens[(i + 1) % n]
        if hybrid:
            expected = hybrid_map.get(cur)
            if expected is None or nxt not in expected:
                breaks += 1
        else:
            expected = strict.get(cur)
            if expected is None or nxt != expected:
                breaks += 1
    return breaks


def _ul_alt_breaks(lift_tokens: list[str]) -> int:
    """Count adjacent same-family transitions among the strict-UL
    lift tokens (upper/lower only — other families are ignored).
    Circular: a rotation of a strictly-alternating sequence with
    EVEN length scores 0; odd length inherently has at least one
    wraparound repeat."""
    ul_only = [t for t in lift_tokens if t in ("upper", "lower")]
    if len(ul_only) < 2:
        return 0
    breaks = 0
    n = len(ul_only)
    for i in range(n):
        cur = ul_only[i]
        nxt = ul_only[(i + 1) % n]
        if cur == nxt:
            breaks += 1
    return breaks


def _preserves_split_identity(
    recipe: list[DayArchetype],
    lifting_split: Optional[str],
    user_chose_split: bool,
    *,
    baseline: list[DayArchetype] | None = None,
) -> bool:
    """Guard used after every post-processing pass that may reorder
    archetypes. Returns True when split identity hasn't gotten WORSE
    than `baseline` (if supplied) or is fully intact (if baseline is
    None).

    Split checks:
      - PPL / PPL_UL: lift-family cycle follows P→Pu→L (PPL_UL also
        accepts …→L→U→L→P). Non-lift days (cardio/mobility/recovery)
        are stripped before comparison.
      - Strict Upper/Lower (user_chose_split=True): no two consecutive
        upper or lower lift days. Stripped of non-lift days.
      - Full Body / unknown / user_chose_split=False on UL: always True.

    Passing `baseline` lets callers compare identity-breakage before
    vs after a pass — a pass that doesn't introduce NEW breakage is
    considered identity-preserving even when the recipe was already
    imperfect (e.g. odd-day UL strict has one unavoidable repeat)."""
    from .day_templates import (
        SPLIT_PPL as _SPLIT_PPL_GUARD,
        SPLIT_PPL_UL as _SPLIT_PPL_UL_GUARD,
        SPLIT_UPPER_LOWER as _SPLIT_UL_GUARD,
    )

    if not recipe:
        return True

    tokens_now = _lift_tokens_of(recipe)

    if lifting_split in (_SPLIT_PPL_GUARD, _SPLIT_PPL_UL_GUARD):
        hybrid = (
            lifting_split == _SPLIT_PPL_UL_GUARD
            and any(t in ("upper", "lower") for t in tokens_now)
        )
        now_breaks = _ppl_cycle_breaks(tokens_now, hybrid=hybrid)
        if baseline is not None:
            base_tokens = _lift_tokens_of(baseline)
            base_hybrid = (
                lifting_split == _SPLIT_PPL_UL_GUARD
                and any(t in ("upper", "lower") for t in base_tokens)
            )
            base_breaks = _ppl_cycle_breaks(base_tokens, hybrid=base_hybrid)
            return now_breaks <= base_breaks
        return now_breaks == 0

    if lifting_split == _SPLIT_UL_GUARD and user_chose_split:
        now_breaks = _ul_alt_breaks(tokens_now)
        if baseline is not None:
            base_breaks = _ul_alt_breaks(_lift_tokens_of(baseline))
            return now_breaks <= base_breaks
        return now_breaks == 0

    # Full body / unknown / non-user-chosen UL: no identity to preserve.
    return True


def _next_in_split_rotation(
    last_family: str | None,
    lifting_split: str | None,
) -> str | None:
    """Return the family that SHOULD be day 0 given the user's last
    completed lift family and the active split.

    - PPL / PPL_UL: Push → Pull → Legs → Push. Upper/Lower (hybrid
      residuals) fall through to None so the caller defers to the
      broader rotation pass.
    - Upper/Lower: strict alternation.
    - Full Body / Bro / None / unknown: no anchor.
    - Non-lift last families (cardio / mobility / recovery / None) also
      return None so cardio/mobility days don't force a rotation."""
    from .day_templates import (
        SPLIT_PPL as _SPLIT_PPL_NXT,
        SPLIT_PPL_UL as _SPLIT_PPL_UL_NXT,
        SPLIT_UPPER_LOWER as _SPLIT_UL_NXT,
    )
    if not last_family:
        return None
    if lifting_split in (_SPLIT_PPL_NXT, _SPLIT_PPL_UL_NXT):
        ppl_next = {"push": "pull", "pull": "legs", "legs": "push"}
        return ppl_next.get(last_family)
    if lifting_split == _SPLIT_UL_NXT:
        ul_next = {"upper": "lower", "lower": "upper"}
        return ul_next.get(last_family)
    return None


def _anchor_recipe_to_split_next(
    recipe: list[DayArchetype],
    recent_focus_families: tuple[str, ...] | list[str],
    lifting_split: str | None,
) -> list[DayArchetype]:
    """Rotate `recipe` so day 0 is the EXPECTED next family in the
    split rotation from the user's last completed lift. If no anchor
    can be determined (non-PPL/UL split, no recent lift family, or the
    recipe offers no matching day 0), return the recipe unchanged so
    downstream rotation passes still run."""
    if not recent_focus_families or len(recipe) < 2:
        return recipe
    lift_families = ("push", "pull", "legs", "upper", "lower", "full_body")
    last_lift_family = next(
        (f for f in recent_focus_families if f in lift_families),
        None,
    )
    if last_lift_family is None or last_lift_family == "full_body":
        return recipe
    expected = _next_in_split_rotation(last_lift_family, lifting_split)
    if expected is None:
        return recipe
    # Find the first rotation whose day 0 family matches `expected`.
    for shift in range(len(recipe)):
        cand = recipe[shift:] + recipe[:shift]
        try:
            fam = archetype_to_focus_family(cand[0])
        except KeyError:
            continue
        if fam == expected:
            if shift != 0:
                logger.info(
                    f"[weekly_recipe] split-anchor: last_lift={last_lift_family} "
                    f"split={lifting_split} expected_day0={expected} "
                    f"shift={shift}"
                )
            return cand
    return recipe


def _rotate_recipe_to_avoid_recent(
    recipe: list[DayArchetype],
    recent_buckets: tuple[str, ...] | list[str],
    *,
    mode: str,
) -> list[DayArchetype]:
    """Shift the recipe so day 0 isn't the same focus as any of the
    user's most recent sessions. Deterministic and anchor-aware.

    `recent_buckets` can contain EITHER coarse bucket ids
    (`"lower_body"`, `"upper_body"`) OR fine family ids (`"push"`,
    `"pull"`, `"legs"`). The function auto-detects which level by
    checking if the values are in the coarse set or the fine set,
    and uses the matching archetype classifier. This makes it work
    correctly regardless of whether the caller passed coarse buckets
    from `normalize_focus_to_bucket` or fine families from
    `normalize_focus_to_family`.

    Modes with anchored day placement (`endurance`, `athletic`,
    `mobility`, `recovery`) return unchanged so we don't disturb
    their intentional ordering. Recipes shorter than 2 days return
    unchanged."""
    recent = [b for b in (recent_buckets or ()) if b]
    if not recent or len(recipe) < 2:
        return recipe
    if mode not in ("lifting", "fat_loss_mix", "lifting_plus_cardio", "maintain"):
        return recipe

    # Auto-detect granularity: if ANY recent value is a coarse bucket
    # (like "upper_body", "lower_body"), use coarse comparison. If all
    # values are fine families ("push", "pull", "legs"), use fine.
    use_coarse = any(b in _COARSE_BUCKETS and b not in _FINE_FAMILIES for b in recent)
    # Shared values like "full_body", "cardio", "mobility", "recovery"
    # exist in both sets. If we only have those, fine is correct.
    if use_coarse:
        def _day_bucket(archetype: DayArchetype) -> str | None:
            try:
                return archetype_to_focus_bucket(archetype)
            except KeyError:
                return None
    else:
        def _day_bucket(archetype: DayArchetype) -> str | None:
            return _archetype_bucket(archetype)

    day0 = _day_bucket(recipe[0])

    # Build every rotation candidate and score it. A valid rotation
    # has day 0 not in `recent`; ties break on fewer adjacent
    # duplicates (Push → Push, Legs → Legs pairs). The old code
    # returned the FIRST rotation that avoided `recent` at day 0 and
    # didn't look at adjacency — which is how we ended up shipping
    # [Z2, Pull, Short, Legs, Push, Push] last regeneration.
    current_dups = _count_adjacent_duplicates(recipe)

    def _candidate(shift: int) -> list[DayArchetype]:
        return recipe[shift:] + recipe[:shift]

    # Tier 1: day 0 avoids ALL recent buckets. Pick the candidate
    # with the fewest adjacent duplicates. Include shift=0 in the
    # scan so the original layout wins when it's already clean.
    tier1_candidates: list[tuple[int, int, list[DayArchetype]]] = []
    for shift in range(len(recipe)):
        cand = _candidate(shift)
        if _day_bucket(cand[0]) not in recent:
            tier1_candidates.append((_count_adjacent_duplicates(cand), shift, cand))
    if tier1_candidates:
        tier1_candidates.sort(key=lambda x: (x[0], x[1]))
        dups, shift, chosen = tier1_candidates[0]
        logger.debug(
            f"[weekly_recipe] rotation tier-1: shift={shift} "
            f"avoiding {recent} → day0={_day_bucket(chosen[0])} "
            f"adj_dups={dups}"
        )
        return chosen

    # Tier 2: fall back to avoiding only the MOST recent bucket.
    # Same adjacency-scoring logic.
    most_recent = recent[0]
    tier2_candidates: list[tuple[int, int, list[DayArchetype]]] = []
    for shift in range(len(recipe)):
        cand = _candidate(shift)
        if _day_bucket(cand[0]) != most_recent:
            tier2_candidates.append((_count_adjacent_duplicates(cand), shift, cand))
    if tier2_candidates:
        tier2_candidates.sort(key=lambda x: (x[0], x[1]))
        dups, shift, chosen = tier2_candidates[0]
        logger.debug(
            f"[weekly_recipe] rotation tier-2: shift={shift} "
            f"avoiding most-recent {most_recent!r} → "
            f"day0={_day_bucket(chosen[0])} adj_dups={dups}"
        )
        return chosen

    # Nothing helped — every day in the recipe is the same bucket as
    # the most recent session. Return the original and let downstream
    # logs + scoring figure it out.
    logger.debug(
        f"[weekly_recipe] rotation no-op: every day is {most_recent!r} — "
        f"recipe has no alternative day type (adj_dups={current_dups})"
    )
    return recipe


def _rotate_recipe_for_fatigue(
    recipe: list[DayArchetype],
    muscle_fatigue: dict[str, float],
) -> list[DayArchetype]:
    """Prefer rotations where day 0 targets the freshest muscles."""
    if not muscle_fatigue or len(recipe) < 2:
        return recipe

    from .activity_impact import derive_focus_readiness, MuscleFatigue
    mf = MuscleFatigue()
    for m, v in muscle_fatigue.items():
        if hasattr(mf, m):
            mf.add(m, v)

    best_rotation = recipe
    best_score = -1.0

    for shift in range(len(recipe)):
        candidate = recipe[shift:] + recipe[:shift]
        fam = archetype_to_focus_family(candidate[0])
        if not fam:
            continue
        readiness = derive_focus_readiness(mf, fam)
        # Slight preference for keeping original order (shift=0 gets +0.01 bonus)
        bonus = 0.01 if shift == 0 else 0.0
        if readiness + bonus > best_score:
            best_score = readiness + bonus
            best_rotation = candidate

    if best_rotation != recipe:
        old_fam = archetype_to_focus_family(recipe[0])
        new_fam = archetype_to_focus_family(best_rotation[0])
        logger.debug(f"[weekly_recipe] fatigue rotation: {old_fam} → {new_fam} (readiness {best_score:.0%})")

    return best_rotation


def generate_weekly_recipe(
    profile: GoalProfile,
    days_per_week: int,
    *,
    lifting_split: Optional[str] = None,
    user_chose_split: bool = False,
    recent_focus_buckets: tuple[str, ...] | list[str] = (),
    recent_focus_families: tuple[str, ...] | list[str] = (),
    priority_region: str = "balanced",
    muscle_fatigue: dict[str, float] | None = None,
    user_age: int | None = None,
) -> list[DayArchetype]:
    """Produce the week's archetype sequence for one user.

    `lifting_split` is only used when `profile.planner_mode == "lifting"`.
    The planner passes the output of `pick_split(inputs)` here so the
    lifting-mode branch maps PPL/UL/etc. into LIFT_* archetypes
    without having to re-implement split selection.

    `recent_focus_buckets` is a small list of already-normalized
    bucket ids (`"lower_body"`, `"upper_body"`, etc.) from the user's
    most recent completed sessions, newest first. When non-empty, the
    recipe is rotated so day 0 isn't the same kind of day as any of
    the recent buckets — a user who just hit Back yesterday and Legs
    today won't get either bucket as their next session unless the
    recipe genuinely offers no alternative. Rotation only fires for
    modes with flexible day order (lifting / fat_loss_mix / maintain);
    endurance / athletic / mobility / recovery keep their anchored
    placement.

    Every returned archetype is guaranteed to be in
    `profile.allowed_archetypes`. If a recipe branch produces something
    the profile doesn't allow (shouldn't happen in practice), the
    offending entry is replaced with the profile's first anchor."""
    days = max(1, min(7, int(days_per_week or 3)))
    mode = profile.planner_mode

    # ── Recovery injection for pure-lifting modes ──
    # _lifting_plus_cardio_recipe handles recovery internally.
    # All other modes need a post-hoc injection if recovery days are warranted.
    # Modes that are inherently low-stress (mobility, recovery, maintain)
    # skip this — they don't need a recovery day carved out.
    _modes_with_internal_recovery = {"fat_loss_mix", "lifting_plus_cardio"}
    _modes_skip_recovery = {"mobility", "recovery", "maintain"}

    if mode == "strength":
        # Compound Strength: heavy compound variants dominate. The cycle
        # honors the caller-supplied `lifting_split` so a user whose
        # split auto-picked PPL (strength + 6 days) or who explicitly
        # chose PPL/UL/Full Body gets a recipe with strict split
        # identity — PPL → exactly balanced Push/Pull/Legs, UL →
        # alternating upper/lower, Full Body → every day full-body.
        # Prior behavior silently emitted an Upper/Lower-dominated
        # cycle regardless of split choice, producing mis-balanced
        # weeks (e.g. 3 Legs + 2 Push + 1 Pull for a 6-day PPL user).
        recovery_days = _derive_recovery_days(
            days, profile.bucket,
            getattr(profile.mix, "recovery", 0.0),
            getattr(profile.mix, "mobility", 0.0),
        )
        lift_days = days - recovery_days
        _A = DayArchetype
        from .day_templates import (
            SPLIT_UPPER_LOWER as _SPLIT_UL_STR,
            SPLIT_PPL_UL as _SPLIT_PPL_UL_STR,
            SPLIT_PPL as _SPLIT_PPL_STR,
            SPLIT_FULL_BODY as _SPLIT_FB_STR,
        )
        # Classify the effective split family: PPL, UL, or Full Body.
        # A missing split argument falls through to UL (historical default).
        _is_ppl = lifting_split in (_SPLIT_PPL_STR, _SPLIT_PPL_UL_STR)
        _is_fb = lifting_split == _SPLIT_FB_STR
        _is_ul = lifting_split == _SPLIT_UL_STR

        # ── PPL strength cycle ────────────────────────────────────
        # Strict Push → Pull → Legs rotation so the week is always
        # split-balanced. Heavy variants first, then volume variants
        # so each family gets one heavy + one volume day at 6 lift
        # days (PPL's sweet spot). Lower lift_days trim from the end.
        if _is_ppl:
            _ppl_cycle_full = [
                _A.LIFT_PUSH_HEAVY, _A.LIFT_PULL_HEAVY, _A.LIFT_LEGS_HEAVY,
                _A.LIFT_PUSH_VOLUME, _A.LIFT_PULL_VOLUME, _A.LIFT_LEGS_VOLUME,
            ]
            if lift_days <= 6:
                _str_cycle = _ppl_cycle_full[:lift_days]
            else:
                # 7 lift days on PPL: wrap with an extra Push heavy so
                # week is 3 Push / 2 Pull / 2 Legs — no same-family
                # adjacency across the wrap (Legs_volume → Push_heavy).
                _str_cycle = _ppl_cycle_full + [_A.LIFT_PUSH_HEAVY]
        # ── Full Body strength cycle ───────────────────────────────
        # Alternate Full Body Strength (heavy compound) with Full Body
        # (volume) so every day is full-body but intensity varies.
        elif _is_fb:
            _fb_pattern = [_A.LIFT_FULL_BODY_STRENGTH, _A.LIFT_FULL_BODY]
            _str_cycle = [_fb_pattern[i % 2] for i in range(lift_days)]
        # ── Upper/Lower strength cycle (default) ──────────────────
        # Keeps historical behavior for UL and the no-split-argument
        # case. `_ul_strict` mirrors the previous `_ul_only` — when
        # the user explicitly picked UL we drop Full Body fillers so
        # the week is strictly U/L.
        else:
            _ul_strict = user_chose_split and _is_ul
            if lift_days <= 3:
                if _ul_strict:
                    _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_UPPER_HYPERTROPHY]
                else:
                    _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_FULL_BODY_STRENGTH]
            elif lift_days == 4:
                _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY]
            elif lift_days == 5:
                if _ul_strict:
                    _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY, _A.LIFT_UPPER_HYPERTROPHY]
                else:
                    _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_FULL_BODY_STRENGTH, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY]
            else:
                if _ul_strict:
                    _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY, _A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HYPERTROPHY]
                else:
                    _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_FULL_BODY_STRENGTH, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY, _A.LIFT_FULL_BODY]
        recipe = _str_cycle[:lift_days]
        for _ in range(recovery_days):
            recipe.append(_pick_recovery_archetype(profile))
    elif mode == "lifting":
        recovery_days = _derive_recovery_days(
            days, profile.bucket,
            getattr(profile.mix, "recovery", 0.0),
            getattr(profile.mix, "mobility", 0.0),
        )
        lift_days = days - recovery_days
        recipe = _lifting_recipe(profile, lifting_split or "full_body", lift_days, priority_region=priority_region)
        for _ in range(recovery_days):
            recipe.append(_pick_recovery_archetype(profile))
    elif mode in _modes_with_internal_recovery:
        recipe = _lifting_plus_cardio_recipe(profile, days, lifting_split or "upper_lower", user_chose_split=user_chose_split, priority_region=priority_region)
    elif mode == "endurance":
        recipe = _endurance_recipe(profile, days)
    elif mode == "athletic":
        recipe = _athletic_recipe(profile, days)
    elif mode == "hyrox":
        recipe = _hyrox_recipe(profile, days)
    elif mode == "maintain":
        recipe = _maintain_recipe(profile, days)
    elif mode == "mobility":
        recipe = _mobility_recipe(profile, days)
    elif mode == "recovery":
        recipe = _recovery_recipe(profile, days)
    else:
        # Unknown mode — fall back to maintain for safety.
        recipe = _maintain_recipe(profile, days)

    pre_rotation = [a.value for a in recipe]
    # Promote from debug to info so we can diagnose rotation issues in
    # prod without flipping log levels. Low volume (1/regen) so it won't
    # flood CloudWatch.
    logger.info(
        f"[weekly_recipe] DIAG goal={profile.bucket} split={lifting_split} "
        f"mode={mode} days={days} recipe_before_rotation={pre_rotation} "
        f"recent_families={list(recent_focus_families) if recent_focus_families else []}"
    )
    # Use fine-grained focus families for rotation when available.
    # Families preserve split identity (push != pull) while coarse
    # buckets collapse both to "upper_body" -- which means the rotation
    # pass can't distinguish "user just did push" from "user just did
    # pull" and may fail to rotate away from the same split identity.
    rotation_recent = list(recent_focus_families) if recent_focus_families else list(recent_focus_buckets)
    logger.debug(
        f"[weekly_recipe] mode={mode} days={days} split={lifting_split} "
        f"recent_buckets={list(recent_focus_buckets)} "
        f"recent_families={list(recent_focus_families)} "
        f"rotation_using={'families' if recent_focus_families else 'buckets'} "
        f"recipe_before={pre_rotation}"
    )
    # Split-aware anchor: for PPL / UL users, force day 0 to be the
    # EXPLICIT next family in the split rotation from the user's last
    # completed lift (Push→Pull→Legs→Push / Upper↔Lower). Runs before
    # the generic rotation pass so the subsequent `_rotate_recipe_to_
    # avoid_recent` + repair + rescue are no-ops on an already-anchored
    # recipe. Non-PPL/UL splits, missing recent data, or cardio/mobility
    # last families fall through and let the existing rotation decide.
    _pre_anchor = list(recipe)
    recipe = _anchor_recipe_to_split_next(
        recipe, recent_focus_families, lifting_split,
    )
    if not _preserves_split_identity(
        recipe, lifting_split, user_chose_split, baseline=_pre_anchor
    ):
        logger.info(
            f"[weekly_recipe] split-anchor broke split identity — reverting"
        )
        recipe = _pre_anchor

    # Avoid scheduling the same focus the user just completed on day 1
    # of the new week. Runs before the allowed-archetype filter so a
    # rotated day still passes through the safety check.
    # Split-identity guard: for PPL / strict-UL users, revert the
    # rotation if it scrambled the Push→Pull→Legs (or U↔L) cycle. The
    # rotation pass is cycle-preserving in the common case (it just
    # picks a shift), but active-recovery inserts or odd day-counts
    # can make a shift break the cycle — in that case we keep the
    # original layout rather than ship a scrambled split.
    _pre_rotate_recent = list(recipe)
    recipe = _rotate_recipe_to_avoid_recent(
        recipe, rotation_recent, mode=mode,
    )
    if not _preserves_split_identity(
        recipe, lifting_split, user_chose_split, baseline=_pre_rotate_recent
    ):
        logger.info(
            f"[weekly_recipe] rotation broke split identity "
            f"(split={lifting_split} user_chose_split={user_chose_split}) "
            f"— reverting {[a.value for a in recipe]} → "
            f"{[a.value for a in _pre_rotate_recent]}"
        )
        recipe = _pre_rotate_recent
    # Fatigue-aware rotation: if user has real muscle fatigue data,
    # prefer starting the week with the freshest focus.
    #
    # BUT — skip for PPL splits. PPL has a built-in rotation where each
    # day pattern targets different muscles, so the recent-focus rotation
    # above already handles freshness correctly. Running fatigue rotation
    # on top of a PPL recipe can shift day 0 to a fresh muscle but
    # scramble the Push→Pull→Legs rotation integrity (e.g. producing
    # Push→Pull→Push→Pull→Legs instead of the clean P→Pu→L→P→Pu).
    from .day_templates import SPLIT_PPL, SPLIT_PPL_UL
    skip_fatigue_rotation = lifting_split in (SPLIT_PPL, SPLIT_PPL_UL)
    if muscle_fatigue and mode in ("lifting", "strength", "fat_loss_mix", "lifting_plus_cardio", "maintain") and not skip_fatigue_rotation:
        _pre_fatigue = list(recipe)
        recipe = _rotate_recipe_for_fatigue(recipe, muscle_fatigue)
        if not _preserves_split_identity(
            recipe, lifting_split, user_chose_split, baseline=_pre_fatigue
        ):
            logger.info(
                f"[weekly_recipe] fatigue rotation broke split identity "
                f"— reverting"
            )
            recipe = _pre_fatigue
    # Rotation can reintroduce adjacent same-bucket duplicates.
    _pre_repair1 = list(recipe)
    recipe = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=profile.allowed_archetypes,
        lifting_split=lifting_split, user_chose_split=user_chose_split,
    )
    if not _preserves_split_identity(
        recipe, lifting_split, user_chose_split, baseline=_pre_repair1
    ):
        logger.info(
            f"[weekly_recipe] adjacency repair broke split identity "
            f"— reverting"
        )
        recipe = _pre_repair1
    logger.info(
        f"[weekly_recipe] DIAG recipe_after_all_rotation={[a.value for a in recipe]}"
    )

    # Active recovery: 7-day pure-lifting weeks need at least one easy
    # day. If every day in the recipe is a lift day and the profile
    # allows MOBILITY_FLOW, replace the last day with it. For modes
    # that already have cardio days (lifting_plus_cardio), the Zone 2
    # day already serves this role so no injection is needed.
    # If the recipe is shorter than days_per_week (e.g., PPL heavy+volume
    # = 6 archetypes but user wants 7 days), fill remaining slots with
    # active recovery. Also: if ALL days are pure lifting and the user
    # trains 7 days, replace the last lifting day with recovery.
    all_lift = all(ARCHETYPE_META[a].category == "lift" for a in recipe)
    has_mobility = DayArchetype.MOBILITY_FLOW in profile.allowed_archetypes
    while len(recipe) < days and has_mobility:
        recipe.append(DayArchetype.MOBILITY_FLOW)
        logger.debug(f"[weekly_recipe] appended active recovery day at position {len(recipe) - 1}")
    if days >= 7 and all_lift and has_mobility and len(recipe) == days:
        recipe[-1] = DayArchetype.MOBILITY_FLOW
        logger.debug(f"[weekly_recipe] replaced day {days} with active recovery")
    # Re-run adjacency repair after active-recovery injection. Appending
    # MOBILITY_FLOW next to an existing mobility/recovery last day would
    # otherwise create a persistent mobility→mobility pair that no
    # downstream step catches.
    _pre_repair2 = list(recipe)
    recipe = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=profile.allowed_archetypes,
        lifting_split=lifting_split, user_chose_split=user_chose_split,
    )
    if not _preserves_split_identity(
        recipe, lifting_split, user_chose_split, baseline=_pre_repair2
    ):
        logger.info(
            f"[weekly_recipe] adjacency repair (post-injection) broke split "
            f"identity — reverting"
        )
        recipe = _pre_repair2

    # Defensive: every archetype must be in the profile's allowed set.
    fallback = profile.anchor_archetypes[0] if profile.anchor_archetypes else DayArchetype.LIFT_FULL_BODY
    final = [a if a in profile.allowed_archetypes else fallback for a in recipe]

    # Intensity-cost spacing: prevent back-to-back high-intensity days.
    # ONLY strength-dominant goals (mix.strength >= 0.5) and pure
    # `strength` planner mode get the heavy-streak allowance. Every
    # other goal — muscle_gain, body_recomp, athletic_performance,
    # hyrox, toning, fat_loss — falls under the stricter rule where
    # 3+ consecutive heavies get downgraded and heavy pairs require
    # a cooldown day. Dropped the previous `lifting + strength >= 0.35`
    # clause: it allowed heavy clustering for goals whose design
    # intent actually forbids it (hypertrophy blocks were interpreted
    # too literally).
    # Age override: 50+ users always get alternating-heavy rules
    # regardless of goal — slower recovery makes consecutive heavy
    # days a disproportionate injury/overtraining risk.
    goal_allows_heavy = (
        profile.mix.strength >= 0.5
        or profile.planner_mode == "strength"
    )
    if user_age is not None and user_age >= 50:
        goal_allows_heavy = False
        logger.info(
            f"[weekly_recipe] age={user_age}: forcing non-streak heavy-day spacing"
        )
    _pre_intensity = list(final)
    final = _space_high_intensity_days(final, goal_allows_heavy_streaks=goal_allows_heavy)
    if not _preserves_split_identity(
        final, lifting_split, user_chose_split, baseline=_pre_intensity
    ):
        logger.info(
            f"[weekly_recipe] intensity spacing broke split identity "
            f"— reverting"
        )
        final = _pre_intensity

    # Extra-recovery injection for older lifters. Masters athletes (50+)
    # benefit from an additional mobility/recovery day per week when the
    # plan is lift-dense. Triggers when: age >= 55, recipe has >=4 lift
    # days, and there's room to swap in a MOBILITY_FLOW for the last lift.
    if user_age is not None and user_age >= 55:
        lift_count = sum(1 for a in final if ARCHETYPE_META[a].category == "lift")
        mobility_count = sum(1 for a in final if a == DayArchetype.MOBILITY_FLOW)
        if lift_count >= 4 and mobility_count == 0 and DayArchetype.MOBILITY_FLOW in profile.allowed_archetypes:
            # Replace the last lift day with mobility.
            for i in range(len(final) - 1, -1, -1):
                if ARCHETYPE_META[final[i]].category == "lift":
                    final[i] = DayArchetype.MOBILITY_FLOW
                    logger.info(
                        f"[weekly_recipe] age={user_age}: replaced lift day {i} with MOBILITY_FLOW for age-adjusted recovery"
                    )
                    break
    # Intensity spacing can reintroduce focus-family adjacency (e.g.
    # swapping Legs with PushVolume to space intensity puts Push next
    # to PushVolume). One more adjacency sweep to catch this.
    _pre_repair3 = list(final)
    final = _repair_adjacent_duplicates(
        final, allowed_archetypes=profile.allowed_archetypes,
        lifting_split=lifting_split, user_chose_split=user_chose_split,
    )
    if not _preserves_split_identity(
        final, lifting_split, user_chose_split, baseline=_pre_repair3
    ):
        logger.info(
            f"[weekly_recipe] adjacency repair (post-intensity) broke split "
            f"identity — reverting"
        )
        final = _pre_repair3

    # Lift-priority rescue (runs LAST so intensity spacing can't
    # shuffle a cardio back to day 0). If the user hasn't lifted in
    # the last 36h (recent_focus_families + recent_focus_buckets
    # contain no lift entries — mobility, cardio, recovery) but today's
    # day 0 is cardio/mobility/recovery, swap it with the nearest lift
    # day in the recipe. Rationale: a user whose last training stimulus
    # was Mobility yesterday and no lifting for 3+ days should be
    # getting under the bar today, not more conditioning. Only fires
    # for recipes that actually contain a lift day later in the week —
    # otherwise it's a no-op. Mode gate matches the rotation pass so
    # anchored-order modes (endurance / athletic / mobility / recovery)
    # keep their intentional layout.
    #
    # "Has the user lifted recently?" is centralised in
    # `_has_lifted_recently` — same fine→coarse expansion the rotation
    # pass relies on, with recent_focus_buckets as a fallback when
    # families is empty.
    _NON_LIFT_DAY0_CATEGORIES = frozenset({"cond", "mobility", "recovery"})
    _any_recent = bool(recent_focus_families) or bool(recent_focus_buckets)
    if (
        len(final) >= 2
        and mode in ("lifting", "strength", "fat_loss_mix", "lifting_plus_cardio", "maintain")
        and _any_recent
        and not _has_lifted_recently(recent_focus_families, recent_focus_buckets)
        and ARCHETYPE_META[final[0]].category in _NON_LIFT_DAY0_CATEGORIES
    ):
        # Find the nearest lift day in the recipe (prefer earliest so
        # today's session is a lift, not cardio).
        swap_idx = next(
            (j for j in range(1, len(final))
             if ARCHETYPE_META[final[j]].category == "lift"),
            None,
        )
        if swap_idx is not None:
            logger.info(
                f"[weekly_recipe] lift-priority rescue: recent_families="
                f"{list(recent_focus_families)} recent_buckets="
                f"{list(recent_focus_buckets)} has no lift; day0="
                f"{final[0].value} ({ARCHETYPE_META[final[0]].category}), "
                f"swapping with day {swap_idx} ({final[swap_idx].value})"
            )
            _pre_rescue = list(final)
            final[0], final[swap_idx] = final[swap_idx], final[0]
            # The swap may have introduced adjacency at the new position
            # of the former day 0 — re-run repair.
            final = _repair_adjacent_duplicates(
                final, allowed_archetypes=profile.allowed_archetypes,
                lifting_split=lifting_split, user_chose_split=user_chose_split,
            )
            if not _preserves_split_identity(
                final, lifting_split, user_chose_split, baseline=_pre_rescue
            ):
                logger.info(
                    f"[weekly_recipe] lift-priority rescue broke split "
                    f"identity — reverting"
                )
                final = _pre_rescue

    # Final safety net: one last 4-tier repair pass after every pipeline
    # step has had its chance to mutate the recipe (rotation, intensity
    # spacing, age swap, lift-priority rescue, active-recovery injection).
    # Previous repair calls are retained at each step so the logs point
    # at the offending pipeline stage — this final pass is a belt-and-
    # suspenders guarantee. If any family adjacency survives ALL tiers
    # we emit a WARNING with the full recipe + inputs for triage.
    # Full-body adjacency is the one allowed repeat (every day is
    # full_body on some goal profiles) so it's excluded from the check.
    _pre_final_repair = list(final)
    final = _repair_adjacent_duplicates(
        final, allowed_archetypes=profile.allowed_archetypes,
        lifting_split=lifting_split, user_chose_split=user_chose_split,
    )
    if not _preserves_split_identity(
        final, lifting_split, user_chose_split, baseline=_pre_final_repair
    ):
        logger.info(
            f"[weekly_recipe] final safety-net repair broke split identity "
            f"— reverting"
        )
        final = _pre_final_repair
    # Modes whose recipes are intentionally same-family-dominant
    # (endurance = every day cardio, maintain/recovery = mostly low-stress).
    # Suppress the residual-adjacency warning for these — their design
    # calls for consecutive same-family days.
    _INTENTIONAL_SAME_FAMILY_MODES = {"endurance", "maintain", "recovery"}
    # Modes where full_body adjacency IS a violation (unless the user
    # actually picked a Full Body split — then every day is full_body
    # by design). For PPL/UL/PPL_UL on lifting/strength/etc., two
    # LIFT_FULL_BODY days in a row means a filler leaked into a
    # structured split — warn so we see it.
    from .day_templates import SPLIT_FULL_BODY as _SPLIT_FB_WARN
    _fb_violates = (
        mode in ("lifting", "strength", "lifting_plus_cardio", "athletic", "hyrox")
        and lifting_split != _SPLIT_FB_WARN
    )
    if mode not in _INTENTIONAL_SAME_FAMILY_MODES:
        _residual_dups: list[tuple[int, str]] = []
        for _i in range(1, len(final)):
            try:
                _a = archetype_to_focus_family(final[_i - 1])
                _b = archetype_to_focus_family(final[_i])
            except KeyError:
                continue
            if _a != _b or _a is None:
                continue
            if _a == "full_body" and not _fb_violates:
                continue
            _residual_dups.append((_i, _a))
        if _residual_dups:
            logger.warning(
                "[weekly_recipe] PERSISTENT ADJACENCY after all repair tiers: "
                "goal=%s mode=%s days=%d split=%s user_chose_split=%s "
                "recent_families=%s recent_buckets=%s muscle_fatigue=%s "
                "user_age=%s recipe=%s residual_dups=%s",
                profile.bucket, mode, days, lifting_split, user_chose_split,
                list(recent_focus_families) if recent_focus_families else [],
                list(recent_focus_buckets) if recent_focus_buckets else [],
                muscle_fatigue, user_age,
                [a.value for a in final], _residual_dups,
            )

    # ── Pin mobility / recovery to end of week ────────────────────
    # Rotation passes are cyclic and can shift MOBILITY_FLOW /
    # RECOVERY_EASY to mid-week (e.g. "Pull, Legs, Push, Pull, Legs,
    # Mobility, Push" — user reported this). Mobility belongs at the
    # END so it's the natural decompression slot before the next week
    # resets, not a mid-week interruption between hard lifts. Guarded
    # by split-identity check to avoid scrambling PPL rotation.
    _EASY_ARCHETYPES = {DayArchetype.MOBILITY_FLOW, DayArchetype.RECOVERY_EASY, DayArchetype.STRESS_RELIEF_EASY}
    _pre_pin = list(final)
    # Extract easy days (preserve order among themselves), append to end
    easy = [a for a in final if a in _EASY_ARCHETYPES]
    non_easy = [a for a in final if a not in _EASY_ARCHETYPES]
    if easy and non_easy:
        candidate = non_easy + easy
        if _preserves_split_identity(
            candidate, lifting_split, user_chose_split, baseline=_pre_pin,
        ):
            if candidate != final:
                logger.debug(
                    "[weekly_recipe] pinned mobility/recovery to end of week"
                )
            final = candidate
        # If pinning would break split identity, leave as-is — the
        # adjacency repair already ran, so the recipe is at least legal.

    # ── Length guarantee ───────────────────────────────────────────
    # Every upstream pass SHOULD preserve length, but rotation
    # reverts, active-recovery injection, and safety filters can all
    # drift len(final) away from `days`. Explicit pad/truncate here
    # is cheap insurance. Padding prefers MOBILITY_FLOW, falls back to
    # RECOVERY_EASY, then the profile's first anchor, then
    # LIFT_FULL_BODY as a universal last resort.
    if len(final) < days:
        pad_prefs: list[DayArchetype] = []
        if DayArchetype.MOBILITY_FLOW in profile.allowed_archetypes:
            pad_prefs.append(DayArchetype.MOBILITY_FLOW)
        if DayArchetype.RECOVERY_EASY in profile.allowed_archetypes:
            pad_prefs.append(DayArchetype.RECOVERY_EASY)
        if profile.anchor_archetypes:
            pad_prefs.append(profile.anchor_archetypes[0])
        # Last-resort: any allowed archetype (sort by .value for
        # deterministic pick), then LIFT_FULL_BODY as a universal floor
        # (kept last so profiles that DON'T allow it — e.g. pure
        # endurance — still land on something sensible above).
        if profile.allowed_archetypes:
            pad_prefs.append(sorted(profile.allowed_archetypes, key=lambda a: a.value)[0])
        pad_prefs.append(DayArchetype.LIFT_FULL_BODY)
        pad = pad_prefs[0]
        while len(final) < days:
            logger.info(
                f"[weekly_recipe] length pad: len(final)={len(final)} < "
                f"days={days}; appending {pad.value}"
            )
            final.append(pad)
    elif len(final) > days:
        logger.info(
            f"[weekly_recipe] length truncate: len(final)={len(final)} > "
            f"days={days}; trimming"
        )
        final = final[:days]
    assert len(final) == days, (
        f"Recipe length {len(final)} != {days} after all passes "
        f"(mode={mode} split={lifting_split})"
    )

    exposures = {"lift": 0, "cardio": 0, "mobility": 0, "recovery": 0, "hybrid": 0}
    for a in final:
        cat = ARCHETYPE_META[a].category
        exposures[{"lift": "lift", "cond": "cardio", "mobility": "mobility",
                   "recovery": "recovery", "hybrid": "hybrid"}[cat]] += 1
    logger.debug(
        f"[weekly_recipe] recipe={[a.value for a in final]} "
        f"exposures={exposures}"
    )
    return final
