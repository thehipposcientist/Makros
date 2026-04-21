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

    Goal dial:
      strength                 → 4 heavy + 2 hypertrophy
      muscle_gain              → 3 heavy + 3 volume (legacy default)
      body_recomp              → 2 heavy + 2 hypertrophy + 2 volume
      athletic_performance     → 3 heavy + 3 hypertrophy (no 15-rep sets)
      hyrox                    → 2 heavy + 4 hypertrophy (muscle endurance)
      toning                   → 3 hypertrophy + 3 volume (no heavy)
      fat_loss                 → 2 hypertrophy + 4 volume
      default (unknown / other)→ 3 hypertrophy + 3 volume
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
        six_day = [H[0], H[1], H[2], H[0], M[1], M[2]]        # 4H + 2M
        five_day = [H[0], H[1], H[2], H[0], M[2]]             # 4H + 1M, 2/1/2
        four_day = [H[0], H[1], H[2], M[2]]                   # 3H + 1M, 1/1/2
    elif goal_lower == "muscle_gain":
        six_day = [H[0], H[1], H[2], V[0], V[1], V[2]]        # 3H + 3V
        five_day = [H[0], H[1], H[2], V[0], V[2]]             # 3H + 2V, 2/1/2
        four_day = [H[0], H[1], H[2], V[2]]                   # 3H + 1V, 1/1/2
    elif goal_lower == "body_recomp":
        six_day = [H[0], M[1], H[2], V[0], M[1], V[2]]        # balanced 2+2+2
        five_day = [H[0], M[1], H[2], V[0], V[2]]             # 2/1/2
        four_day = [H[0], M[1], H[2], V[2]]                   # 1/1/2
    elif goal_lower == "athletic_performance":
        six_day = [H[0], H[1], H[2], M[0], M[1], M[2]]        # 3H + 3M
        five_day = [H[0], H[1], H[2], M[0], M[2]]             # 3H + 2M, 2/1/2
        four_day = [H[0], H[1], H[2], M[2]]                   # 3H + 1M, 1/1/2
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
        # default to the legacy 3H + 3V mix.
        six_day = [H[0], H[1], H[2], V[0], V[1], V[2]]
        five_day = [H[0], H[1], H[2], V[0], V[2]]
        four_day = [H[0], H[1], H[2], V[2]]

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
                # Lead with two heavy days per region, then hypertrophy.
                # 4-day plan = pure heavy; 5-6 day plan adds hypertrophy.
                if priority_region == "lower_body":
                    stimulus_cycle = [
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HYPERTROPHY,
                    ]
                else:
                    stimulus_cycle = [
                        DayArchetype.LIFT_UPPER_HEAVY,
                        DayArchetype.LIFT_LOWER_HEAVY,
                        DayArchetype.LIFT_UPPER_HEAVY,
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
            else:
                # muscle_gain / body_recomp / hyrox / unknown → balanced
                # (legacy default: alternating heavy / hypertrophy)
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
            result = [stimulus_cycle[i % len(stimulus_cycle)] for i in range(days)]
            # Odd day: repeat an extra upper or lower hypertrophy day
            # instead of breaking the split with full body
            if days % 2 == 1:
                result[-1] = DayArchetype.LIFT_UPPER_HYPERTROPHY if priority_region != "upper_body" else DayArchetype.LIFT_LOWER_HYPERTROPHY
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
            → 1 cardio day at 3 days/week, 2 at 5+, 3 at 6+
        conditioning fraction 0.10–0.29  (body_recomp, recomp-lite)
            → 0 cardio days at 1-3 days, 1 at 4-5, 2 at 6+
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
        # Body-recomp band
        if available_for_training <= 3:
            cond_days = 0
        elif available_for_training <= 5:
            cond_days = 1
        else:
            cond_days = 1  # cap at 1 true conditioning day
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

    if cond_days == 0 and recovery_days == 0:
        return _lifting_recipe(profile, lifting_split, days, priority_region=priority_region)
    # Split-compatibility fix: a 3-move PPL cycle on 4 lift days emits
    # [Push, Pull, Legs, Push] — which creates two Pushes that can
    # never be fully spaced once you add cardio + run rotation for
    # recent-focus avoidance. For those cases, transparently use an
    # Upper/Lower split so the 4 lift days divide evenly into
    # [Upper, Lower, Upper, Lower]. Only kicks in for ppl-ish splits
    # where this specific pathology exists.
    from .day_templates import SPLIT_PPL, SPLIT_UPPER_LOWER
    effective_split = lifting_split
    # Only auto-convert PPL→UL at 4 lift days when the user did NOT
    # explicitly choose PPL. If they picked it, respect the choice and
    # let the duplicate-repair + intensity spacing handle any overlap.
    if lift_days == 4 and lifting_split == SPLIT_PPL and not user_chose_split:
        logger.debug(
            "[weekly_recipe] lift_days=4 on PPL (auto) → switching to upper_lower "
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

    out: list[DayArchetype] = []
    li = ci = 0
    since_last_cond = 0
    while li < len(lifting) or ci < len(cond):
        if li < len(lifting):
            out.append(lifting[li]); li += 1; since_last_cond += 1
            if ci < len(cond) and since_last_cond >= cycle_len:
                out.append(cond[ci]); ci += 1; since_last_cond = 0
        elif ci < len(cond):
            out.append(cond[ci]); ci += 1

    # Recovery day(s) go at the END of the week. Placing them last
    # means the user's final training day before the weekend (or the
    # cycle restart) is low-stress, giving the CNS a full reset.
    out.extend(recovery)

    assert len(out) == days, f"Recipe length {len(out)} != requested {days} days (lift={lift_days} cond={cond_days} recovery={recovery_days})"
    return _repair_adjacent_duplicates(out)


def _repair_adjacent_duplicates(recipe: list[DayArchetype]) -> list[DayArchetype]:
    """Deterministic sweep that swaps adjacent same-bucket days so
    the user never gets Push → Push or Legs → Legs back to back.

    Called twice in the pipeline:
      1. After interleaving lift+cardio (inside _lifting_plus_cardio_recipe)
         to fix the PPL-at-4-lift-days case that duplicates Push.
      2. After the recent-focus rotation pass in generate_weekly_recipe,
         because rotating [Push, Z2, Pull, Short, Legs, Push] by 1
         produces [Z2, Pull, Short, Legs, Push, Push] — reintroducing
         the adjacency that call #1 already cleaned up.

    Only swaps when a true conflict exists; stable plans stay stable.
    The swap target is the earliest later day that differs from both
    neighbors; if none, we look backward (excluding day 0 which is
    pinned by the rotation pass).
    """
    from .archetypes import archetype_to_focus_family
    def _b(a):
        try:
            return archetype_to_focus_family(a)
        except KeyError:
            return None

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

    out = list(recipe)
    for i in range(1, len(out)):
        if _b(out[i]) != _b(out[i - 1]):
            continue
        # Find a swap target that resolves THIS conflict without
        # creating new ones at the target position.
        swap_idx = None
        for j in range(i + 1, len(out)):
            if _b(out[j]) != _b(out[i]) and _safe_swap(out, i, j):
                swap_idx = j
                break
        if swap_idx is None:
            for j in range(i - 2, 0, -1):
                if _b(out[j]) != _b(out[i]) and _safe_swap(out, i, j):
                    swap_idx = j
                    break
        if swap_idx is not None:
            out[i], out[swap_idx] = out[swap_idx], out[i]
            logger.debug(
                f"[weekly_recipe] adjacency-repair: swapped idx {i}↔{swap_idx} "
                f"to break {_b(out[swap_idx])!r} streak"
            )
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
    fatigue_threshold = 1.8 if goal_allows_heavy_streaks else 1.5

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
    for i in range(2, len(out)):
        if out[i] not in _LEGS_ARCHETYPES:
            continue
        if not _is_heavy(out[i]):
            continue
        prev_fatigue = sum(_fatigue_cost(out[j]) for j in range(max(0, i - 2), i))
        if prev_fatigue < 0.9:
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
        # Compound Strength: always upper/lower, heavy variants dominate.
        # Alternates heavy and lighter (hypertrophy) days for the same
        # split so the user hits each major lift pattern heavy once per
        # week with a lighter volume day as backup.
        recovery_days = _derive_recovery_days(
            days, profile.bucket,
            getattr(profile.mix, "recovery", 0.0),
            getattr(profile.mix, "mobility", 0.0),
        )
        lift_days = days - recovery_days
        _A = DayArchetype
        if lift_days <= 3:
            # 3d: Heavy Upper, Heavy Lower, Full Body Strength
            _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_FULL_BODY_STRENGTH]
        elif lift_days == 4:
            # 4d: Heavy Upper, Heavy Lower, Volume Upper, Volume Lower
            _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY]
        elif lift_days == 5:
            # 5d: Heavy Upper, Heavy Lower, Full Body Strength, Volume Upper, Volume Lower
            _str_cycle = [_A.LIFT_UPPER_HEAVY, _A.LIFT_LOWER_HEAVY, _A.LIFT_FULL_BODY_STRENGTH, _A.LIFT_UPPER_HYPERTROPHY, _A.LIFT_LOWER_HYPERTROPHY]
        else:
            # 6d: Heavy Upper, Heavy Lower, Full Body Strength, Volume Upper, Volume Lower, Full Body
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
    # Avoid scheduling the same focus the user just completed on day 1
    # of the new week. Runs before the allowed-archetype filter so a
    # rotated day still passes through the safety check.
    recipe = _rotate_recipe_to_avoid_recent(
        recipe, rotation_recent, mode=mode,
    )
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
        recipe = _rotate_recipe_for_fatigue(recipe, muscle_fatigue)
    # Rotation can reintroduce adjacent same-bucket duplicates.
    recipe = _repair_adjacent_duplicates(recipe)
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

    # Defensive: every archetype must be in the profile's allowed set.
    fallback = profile.anchor_archetypes[0] if profile.anchor_archetypes else DayArchetype.LIFT_FULL_BODY
    final = [a if a in profile.allowed_archetypes else fallback for a in recipe]

    # Intensity-cost spacing: prevent back-to-back high-intensity days.
    # Strength-dominant goals (mix.strength >= 0.5) get slightly more
    # allowance for consecutive heavy days; all others bias toward
    # alternating heavy/volume for better recovery.
    goal_allows_heavy = profile.mix.strength >= 0.5 or profile.planner_mode == "lifting"
    final = _space_high_intensity_days(final, goal_allows_heavy_streaks=goal_allows_heavy)
    # Intensity spacing can reintroduce focus-family adjacency (e.g.
    # swapping Legs with PushVolume to space intensity puts Push next
    # to PushVolume). One more adjacency sweep to catch this.
    final = _repair_adjacent_duplicates(final)

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
