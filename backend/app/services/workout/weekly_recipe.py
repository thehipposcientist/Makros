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

from .archetypes import DayArchetype, archetype_to_focus_bucket
from .goal_profiles import GoalProfile


# ── Lifting mode ────────────────────────────────────────────────────


def _lifting_recipe(profile: GoalProfile, split: str, days: int) -> list[DayArchetype]:
    """Translate a traditional split id (from `pick_split`) into a
    list of `LIFT_*` archetypes. Mirrors the old `build_day_templates`
    dispatch but emits archetypes instead of slot lists."""
    # Split constants now live in day_templates (responsibility
    # separation refactor). The lazy import stays so weekly_recipe
    # can be imported by tests without pulling in the full planner.
    from .day_templates import (
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


def _lifting_plus_cardio_recipe(
    profile: GoalProfile,
    days: int,
    lifting_split: str,
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

    # Decide how many days to reserve for cardio based on the mix.
    if conditioning_frac < 0.10:
        cond_days = 0
    elif conditioning_frac < 0.30:
        # Body-recomp band: 1 cardio day at 4-5 days, 2 at 6+. Below
        # 4 days the user needs every session for lifting stimulus.
        if days <= 3:
            cond_days = 0
        elif days <= 5:
            cond_days = 1
        else:
            cond_days = 2
    else:
        # Fat-loss band: meaningful conditioning starting at 3 days.
        if days <= 2:
            cond_days = 0
        elif days <= 4:
            cond_days = 1
        elif days == 5:
            cond_days = 2
        else:
            cond_days = 3

    if cond_days == 0:
        return _lifting_recipe(profile, lifting_split, days)

    lift_days = days - cond_days
    # Split-compatibility fix: a 3-move PPL cycle on 4 lift days emits
    # [Push, Pull, Legs, Push] — which creates two Pushes that can
    # never be fully spaced once you add cardio + run rotation for
    # recent-focus avoidance. For those cases, transparently use an
    # Upper/Lower split so the 4 lift days divide evenly into
    # [Upper, Lower, Upper, Lower]. Only kicks in for ppl-ish splits
    # where this specific pathology exists.
    from .day_templates import SPLIT_PPL, SPLIT_UPPER_LOWER
    effective_split = lifting_split
    if lift_days == 4 and lifting_split == SPLIT_PPL:
        print(
            "[weekly_recipe] lift_days=4 on PPL → switching to upper_lower "
            "to avoid duplicate Push/Pull/Legs day"
        )
        effective_split = SPLIT_UPPER_LOWER
    lifting = _lifting_recipe(profile, effective_split, lift_days)

    # Cardio sequence: zone-2 first so any plan with ≥1 cardio day
    # gets an easy/steady aerobic session (the high-value, low-cost
    # pick for recomp). Short intervals come second for a meaningful
    # hard day; circuit third for variety at 3+ cardio days. This
    # ordering means recomp at 6 days (2 cardio) lands Z2 + intervals
    # — at least one easy/steady day guaranteed — instead of two hard
    # sessions back to back.
    cond_sequence = [
        DayArchetype.COND_ZONE2,
        DayArchetype.COND_INTERVALS_SHORT,
        DayArchetype.HYBRID_FULL_BODY_CIRCUIT,
    ]
    # Only append cardio archetypes the profile actually allows. A
    # profile that opts out of circuits (e.g. strength) won't see
    # HYBRID_FULL_BODY_CIRCUIT slipped in.
    cond: list[DayArchetype] = []
    ci = 0
    while len(cond) < cond_days and ci < len(cond_sequence) * 3:
        candidate = cond_sequence[ci % len(cond_sequence)]
        if candidate in profile.allowed_archetypes:
            cond.append(candidate)
        ci += 1
    # Last-resort: if the profile didn't allow any of the above,
    # fall back to zone-2 only (every cardio-allowing profile has it).
    while len(cond) < cond_days:
        cond.append(DayArchetype.COND_ZONE2)

    # Interleave: lift, cond, lift, cond, ... ending on lift if possible.
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
    from .archetypes import archetype_to_focus_bucket
    def _b(a):
        try:
            return archetype_to_focus_bucket(a)
        except KeyError:
            return None

    out = list(recipe)
    for i in range(1, len(out)):
        if _b(out[i]) != _b(out[i - 1]):
            continue
        swap_idx = None
        for j in range(i + 1, len(out)):
            if _b(out[j]) != _b(out[i - 1]) and _b(out[j]) != _b(out[i]):
                swap_idx = j
                break
        if swap_idx is None:
            for j in range(i - 2, 0, -1):
                if _b(out[j]) != _b(out[i - 1]) and _b(out[j]) != _b(out[i]):
                    swap_idx = j
                    break
        if swap_idx is not None:
            out[i], out[swap_idx] = out[swap_idx], out[i]
            print(
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
    """Classify an archetype into one of the coarse focus buckets.
    Delegates to the explicit `ARCHETYPE_TO_FOCUS_BUCKET` table in
    archetypes.py — the single source of truth. Name-based
    normalization is only used for USER INPUT (raw DB focus strings),
    never for archetypes, because hybrid default_names like
    "Upper + Intervals" misnormalize to 'cardio'."""
    try:
        return archetype_to_focus_bucket(archetype)
    except KeyError:
        return None


def _count_adjacent_duplicates(recipe: list[DayArchetype]) -> int:
    """Count pairs of neighboring days that share a focus bucket.
    Used as the secondary score in rotation selection so we prefer
    rotations that keep Push/Pull/Legs spaced out."""
    from .archetypes import archetype_to_focus_bucket
    dups = 0
    for i in range(1, len(recipe)):
        try:
            if archetype_to_focus_bucket(recipe[i]) == archetype_to_focus_bucket(recipe[i - 1]):
                dups += 1
        except KeyError:
            pass
    return dups


def _rotate_recipe_to_avoid_recent(
    recipe: list[DayArchetype],
    recent_buckets: tuple[str, ...] | list[str],
    *,
    mode: str,
) -> list[DayArchetype]:
    """Shift the recipe so day 0 isn't the same coarse bucket as any
    of the user's last `recent_buckets`. Deterministic and
    anchor-aware.

    `recent_buckets` is a small sequence of already-normalized bucket
    ids (e.g. `("lower_body", "upper_body")`), newest first. The
    rotation tries to avoid ALL of them on day 0, then falls back to
    just avoiding the most recent one if no rotation satisfies the
    full set, then returns the original recipe unchanged when nothing
    helps. This two-tier approach means:

        - Best case: "Back yesterday + Legs today" → day 0 is neither
          upper nor lower (e.g. full body or cardio day)
        - Middle case: no such day exists in the recipe → day 0 is at
          least not lower (most recent wins)
        - Worst case: every day is the same bucket → return original

    Modes with anchored day placement (`endurance`, `athletic`,
    `mobility`, `recovery`) return unchanged so we don't disturb
    their intentional ordering. Recipes shorter than 2 days return
    unchanged."""
    recent = [b for b in (recent_buckets or ()) if b]
    if not recent or len(recipe) < 2:
        return recipe
    if mode not in ("lifting", "fat_loss_mix", "lifting_plus_cardio", "maintain"):
        return recipe

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
        print(
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
        print(
            f"[weekly_recipe] rotation tier-2: shift={shift} "
            f"avoiding most-recent {most_recent!r} → "
            f"day0={_day_bucket(chosen[0])} adj_dups={dups}"
        )
        return chosen

    # Nothing helped — every day in the recipe is the same bucket as
    # the most recent session. Return the original and let downstream
    # logs + scoring figure it out.
    print(
        f"[weekly_recipe] rotation no-op: every day is {most_recent!r} — "
        f"recipe has no alternative day type (adj_dups={current_dups})"
    )
    return recipe


def generate_weekly_recipe(
    profile: GoalProfile,
    days_per_week: int,
    *,
    lifting_split: Optional[str] = None,
    recent_focus_buckets: tuple[str, ...] | list[str] = (),
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

    if mode == "lifting":
        recipe = _lifting_recipe(profile, lifting_split or "full_body", days)
    elif mode in ("fat_loss_mix", "lifting_plus_cardio"):
        recipe = _lifting_plus_cardio_recipe(profile, days, lifting_split or "upper_lower")
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

    pre_rotation = [a.value for a in recipe]
    print(
        f"[weekly_recipe] mode={mode} days={days} split={lifting_split} "
        f"recent_buckets={list(recent_focus_buckets)} "
        f"recipe_before={pre_rotation}"
    )
    # Avoid scheduling the same focus the user just completed on day 1
    # of the new week. Runs before the allowed-archetype filter so a
    # rotated day still passes through the safety check.
    recipe = _rotate_recipe_to_avoid_recent(
        recipe, recent_focus_buckets, mode=mode,
    )
    # Rotation can reintroduce adjacent same-bucket duplicates that
    # the recipe generator already cleaned up (e.g. rotating
    # [P,Z2,Pu,S,L,P] by 1 → [Z2,Pu,S,L,P,P]). Sweep again.
    recipe = _repair_adjacent_duplicates(recipe)
    print(
        f"[weekly_recipe] recipe_after_rotation={[a.value for a in recipe]}"
    )

    # Defensive: every archetype must be in the profile's allowed set.
    fallback = profile.anchor_archetypes[0] if profile.anchor_archetypes else DayArchetype.LIFT_FULL_BODY
    final = [a if a in profile.allowed_archetypes else fallback for a in recipe]

    from .archetypes import ARCHETYPE_META
    exposures = {"lift": 0, "cardio": 0, "mobility": 0, "recovery": 0, "hybrid": 0}
    for a in final:
        cat = ARCHETYPE_META[a].category
        exposures[{"lift": "lift", "cond": "cardio", "mobility": "mobility",
                   "recovery": "recovery", "hybrid": "hybrid"}[cat]] += 1
    print(
        f"[weekly_recipe] recipe={[a.value for a in final]} "
        f"exposures={exposures}"
    )
    return final
