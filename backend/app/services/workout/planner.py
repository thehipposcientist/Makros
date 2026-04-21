"""
Algorithmic workout planner — top-level orchestrator.

This file is intentionally small now. It owns:

    Layer 1 — Input normalization         (PlannerInputs)
    Layer 3 — Weekly volume targets       (weekly_set_targets)
    Layer 5 — Exercise selection engine   (filter_candidates,
                                           score_candidate, pick_for_slot)
    Layer 6 — Prescription assembler      (prescribe_sets_reps)
    Layer 7 — Top-level orchestrator      (generate_workout_plan)

The big structural pieces moved to dedicated modules in the
"responsibility separation" refactor so this file stops being a
secret god object:

    Slot + slot builders + density trimming  →  slots.py
    Split constants + pick_split +                day_templates.py
        archetype_to_slots + day naming
    Cardio intensity classification          →  cardio.py
    Goal profiles (training mix + allowed    →  goal_profiles.py
        archetypes + planner mode)
    Weekly archetype recipe                  →  weekly_recipe.py
    Archetype-specific prescriptions         →  prescriptions.py
    Day archetype enum + metadata            →  archetypes.py

`generate_workout_plan` is the thin orchestrator that pulls those
pieces together:

    goal_profile_for → generate_weekly_recipe → archetype_to_slots
    → filter_candidates → score_candidate → pick_for_slot
    → prescribe_for_slot → (volume audit, optional focused-muscle
    backfill if the planner mode supports it) → output

Split selection is now a LIFTING SUBSYSTEM used only when the weekly
recipe asks for a lifting-dominant schedule. Endurance, athletic,
mobility, recovery, and maintain modes skip split selection entirely
and go directly from archetype to slots.

What stays AI in the plan pipeline:
- Only the `trainerNote`, generated after the deterministic plan.
- Trainer chat / "make Wednesday harder" edits.
- Nothing inside this planner's structured output.
"""
from __future__ import annotations

import logging
import random

logger = logging.getLogger(__name__)
from dataclasses import dataclass, field
from typing import Iterable

# Slot dataclass + every slot builder lives in `slots.py`. We import
# what we need (plus the `Slot` type for `_find_best_accessory_host_day`
# signatures) so removed Layer 4 block can stay removed.
from .slots import Slot, density_adjust_slots  # noqa: F401
from .cardio import classify_cardio

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
    focused_muscle: str | None = None       # legacy; used by split selection & focus profiles
    priority_region: str = "balanced"      # "balanced" | "lower_body" | "upper_body"
    preferred_exercises: tuple[str, ...] = ()
    disliked_exercises: tuple[str, ...] = ()
    injuries: tuple[str, ...] = ()
    # Seed for deterministic tie-breaking on candidate selection. Pass a
    # stable per-user value (e.g. user_id) to keep plans consistent across
    # regenerations when nothing else has changed.
    rng_seed: int = 0
    # Normalized focus buckets from the user's last ~2 completed
    # sessions within the last ~36 hours, newest first. Each element
    # is one of: "lower_body", "upper_body", "full_body", "cardio",
    # "mobility", "recovery". Used by `generate_weekly_recipe` to
    # rotate the week so day 1 isn't the same kind of day as the
    # user's most recent sessions. Empty tuple when there's no
    # recent data. Populated by `plans.py` via
    # `history.most_recent_completed_focus`; tests can set it
    # directly.
    recent_focus_buckets: tuple[str, ...] = ()
    # Fine-grained focus families from the same recent sessions.
    # Values like "push", "pull", "legs", "upper", "lower" preserve
    # split identity (Push != Pull) unlike coarse buckets where both
    # map to "upper_body". Used by the weekly recipe rotation to
    # compare against archetype focus families. Populated alongside
    # recent_focus_buckets by history.most_recent_completed_focus.
    recent_focus_families: tuple[str, ...] = ()
    muscle_fatigue: dict | None = None  # MuscleFatigue.to_dict() for weekly rotation
    # User's age — threaded through so the recipe can inject extra rest days
    # for 50+ users (slower recovery) and the warmup can auto-scale.
    user_age: int | None = None


# ─── Goal bucket shim ────────────────────────────────────────────────────────
#
# Thin wrapper kept so legacy call sites inside this module don't have
# to change their import path. Split constants and `pick_split` moved
# to `day_templates.py` in the responsibility-separation refactor;
# import them from there if you need the lifting subsystem.


def _goal_bucket(goal: str) -> str:
    """Thin shim over `goals.goal_bucket`. Kept for the legacy
    `_WEEKLY_VOLUME` / `weekly_set_targets` path below. New code
    should import `goal_bucket` directly from
    `app.services.workout.goals`."""
    from .goals import goal_bucket as _registry_bucket
    return _registry_bucket(goal)


# Re-export split constants + pick_split from day_templates so legacy
# importers (`from app.services.workout.planner import SPLIT_FULL_BODY`)
# keep working. Nothing in the planner service itself uses the
# constants — they're imported via day_templates inside
# `generate_workout_plan` when the weekly recipe asks for a split.
from .day_templates import (  # noqa: E402,F401
    SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_BRO,
    SPLIT_PPL_UL, SPLIT_ENDURANCE, SPLIT_HYBRID, _SPLIT_MIN_DAYS,
    pick_split,
    build_day_templates,
    _day_meta,
    _slots_for_day,
)


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

    Applies region-based volume multipliers when priority_region is set:
    - lower_body: lower muscles get 1.2x, upper muscles get 0.9x
    - upper_body: upper muscles get 1.2x, lower muscles get 0.9x
    - balanced: no adjustment

    Applies a focused-muscle +30% boost (min +2 sets) on top of region
    priority. Keeps the volume-deficit scoring bias pulling extra work
    toward the focused muscle even after generic targets are met.
    """
    from .region_priority import normalize_region, region_volume_multipliers
    from .focus_profiles import get_focus_profile
    bucket = _goal_bucket(inputs.goal)
    base = _WEEKLY_VOLUME.get((bucket, inputs.experience), _DEFAULT_VOLUME).copy()

    # Region priority volume adjustment
    region = normalize_region(inputs.priority_region)
    mults = region_volume_multipliers(region)
    if mults:
        cap_source = _WEEKLY_VOLUME.get((bucket, "advanced"), _DEFAULT_VOLUME)
        for muscle, mult in mults.items():
            if muscle in base:
                adjusted = round(base[muscle] * mult)
                cap = cap_source.get(muscle, adjusted) + 3
                base[muscle] = min(adjusted, cap)

    # Focused-muscle volume boost (+30%, rounded up, min +2 sets)
    focus_profile = get_focus_profile(inputs.focused_muscle)
    if focus_profile is not None:
        muscle = focus_profile.muscle
        if muscle in base:
            current = base[muscle]
            boosted = max(current + 2, int(round(current * 1.3)))
            base[muscle] = boosted

    return base



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


_FOCUS_FAMILY_MUSCLES: dict[str, frozenset[str] | None] = {
    "push": frozenset({"chest", "shoulders", "triceps"}),
    "pull": frozenset({"back", "lats", "biceps", "rear_delt"}),
    "legs": frozenset({"quads", "hamstrings", "glutes", "calves", "adductors"}),
    "upper": frozenset({"chest", "back", "shoulders", "biceps", "triceps", "lats"}),
    "lower": frozenset({"quads", "hamstrings", "glutes", "calves", "adductors"}),
    "full_body": None,  # no filter
    "cardio": None,
    "mobility": None,
    "recovery": None,
}


def filter_candidates(
    all_exercises: list[dict],
    slot: Slot,
    owned_equipment: set[str],
    disliked_set: set[str],
    *,
    injury_blocked_patterns: set[str] | None = None,
    accepts_types: frozenset[str] | None = None,
    day_focus_family: str | None = None,
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
      7. For compound slots (primary/secondary) on days with a known
         focus family, candidate's primary_muscle must belong to the
         family's allowed muscle set. This prevents pull exercises
         (back, lats) from landing on push days, and vice versa.
    """
    blocked = injury_blocked_patterns or set()
    accepts = accepts_types or frozenset({"strength"})
    # Resolve the allowed muscle set for the day's focus family.
    # None means "no restriction" (full_body, cardio, etc.).
    family_muscles: frozenset[str] | None = None
    if day_focus_family:
        family_muscles = _FOCUS_FAMILY_MUSCLES.get(day_focus_family)
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
        # Compound muscle-family enforcement: on push/pull/legs/upper/
        # lower days, compound slots must use exercises whose primary
        # muscle belongs to the day's family. Without this, a
        # horizontal_pull slot on an upper day could admit a pull
        # exercise on what should be a push day (if the archetype
        # dispatch table ever produces such a slot). The slot builders
        # already separate push/pull patterns correctly, but this is
        # belt-and-suspenders defense against misrouted exercises.
        if (
            slot.role in ("primary", "secondary")
            and family_muscles is not None
            and mp not in ("cardio", "mobility", "plyometric")
        ):
            ex_muscle = ex.get("primary_muscle") or ""
            if ex_muscle and ex_muscle not in family_muscles:
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
    # wants intervals, steady-state, or easy recovery cardio. The
    # intensity classification lives in `cardio.classify_cardio` so
    # nothing outside that module depends on the seed's `is_compound`
    # field for cardio semantics.
    if classify_cardio(exercise) != "not_cardio":
        label_lower = (slot.label or "").lower()
        intensity = classify_cardio(exercise)
        is_interval_ex = intensity == "intervals"
        is_easy_ex = intensity == "easy"
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
        wants_easy = (
            "easy" in label_lower
            or "recovery" in label_lower
            or "gentle" in label_lower
        )
        if wants_easy:
            # Recovery / stress-relief labels hard-ban intervals. Easy
            # cardio gets the biggest bonus; steady still fine.
            if is_interval_ex:
                score -= 5.0
            elif is_easy_ex:
                score += 3.0
            else:
                score += 1.5
        elif wants_intervals and is_interval_ex:
            score += 2.5
        elif wants_intervals and not is_interval_ex:
            score -= 2.5
        elif wants_steady and not is_interval_ex:
            score += 2.5
        elif wants_steady and is_interval_ex:
            score -= 2.5

    # 7d. Yoga, mobility drills, and stretches should ONLY appear on
    # mobility, recovery, or general_health/flexibility days — never on
    # lifting, conditioning, or hybrid days in ANY role.
    slug = (exercise.get("slug") or "").lower()
    ex_name_lower = (exercise.get("name") or "").lower()
    ex_type = (exercise.get("exercise_type") or "").lower()
    is_mobility_stretch = (
        slug.startswith("yoga_")
        or slug.startswith("stretch_")
        or slug.startswith("mobility_")
        or ex_type == "mobility"
        or "stretch" in ex_name_lower
        or "mobility drill" in ex_name_lower
    )
    if is_mobility_stretch:
        if bucket not in ("general_health", "flexibility", "stress_relief"):
            score -= 20.0

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
    day_focus_family: str | None = None,
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
        day_focus_family=day_focus_family,
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
    # Cardio exercises live in a different units system (minutes /
    # distance / rounds), not sets × reps × load. Dispatch by intensity
    # via `classify_cardio` instead of reading `is_compound` here —
    # that inference now lives in `cardio.py` and the rest of the
    # planner stays ignorant of the seed's field encoding.
    intensity = classify_cardio(exercise)
    if intensity != "not_cardio":
        if intensity == "intervals":
            if role == "primary":
                sets, reps, rest = 6, "30-45s", 90
            elif role == "secondary":
                sets, reps, rest = 3, "5 min", 60
            else:  # cooldown
                sets, reps, rest = 1, "3-5 min", 0
            return Prescription(sets=sets, reps=reps, rest_seconds=rest, rir_target=1.0)
        # Steady-state or easy cardio — single duration block.
        if role == "primary":
            sets, reps, rest = 1, "25-40 min", 0
        elif role == "secondary":
            sets, reps, rest = 1, "5-10 min", 0
        else:  # cooldown / isolation slot
            sets, reps, rest = 1, "3-5 min", 0
        return Prescription(sets=sets, reps=reps, rest_seconds=rest, rir_target=1.0)

    # ── Sets ───────────────────────────────────────────────────────────
    if bucket == "strength" and role == "primary" and is_compound:
        # Compound Strength: 5 working sets on primary compounds
        sets = 5 if inputs.experience != "beginner" else 4
    elif role == "primary" and is_compound:
        sets = 4 if inputs.experience != "beginner" else 3
    elif role == "primary":
        sets = 3
    elif role == "secondary":
        sets = 3 if bucket != "strength" else 2  # fewer accessories for strength
    elif role == "core":
        sets = 3 if bucket != "strength" else 2
    else:  # isolation
        sets = 3 if bucket != "strength" else 2  # strength deemphasizes isolation

    # ── Reps ───────────────────────────────────────────────────────────
    if bucket == "strength":
        if is_compound and role == "primary":
            reps = "3-5"
            rest = 240  # 4 min — heavy compounds need full CNS recovery
            rir = 1.0   # closer to failure on main lifts
        elif is_compound:
            reps = "5-8"
            rest = 180  # 3 min
            rir = 2.0
        else:
            reps = "6-10"  # heavier than muscle gain isolation
            rest = 120
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
        # Endurance strength-maintenance days — muscular endurance rep
        # ranges with short rest to complement the cardio-heavy week.
        if is_compound and role == "primary":
            reps = "15-20"
            rest = 45
            rir = 2.5
        elif is_compound:
            reps = "12-15"
            rest = 45
            rir = 2.5
        else:
            reps = "15-20"
            rest = 30
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



# Canonical keys every "planned exercise" dict the planner emits should
# carry. Optional fields default to None rather than being missing so
# downstream consumers (plan_review, AI regenerate, progression,
# frontend) can rely on a stable shape.
_CANONICAL_PLANNED_EXERCISE_KEYS: tuple[str, ...] = (
    "name", "sets", "reps", "restSeconds", "equipment", "image_url",
    "targetWeightLbs",
    "weightRecommendationSource", "weightRecommendationConfidence", "weightRecommendationReason",
    "setScheme",
    "_slug", "_slot", "_role", "_rir_target",
    "_primary_muscle", "_secondary_muscles",
    "_archetype", "_training_type",
)


def build_planner_exercise(
    exercise: dict,
    *,
    prescription,
    slot_label: str | None,
    role: str,
    archetype_value: str | None,
    training_type: str | None,
    goal_bucket: str,
    experience: str,
    perf_profiles: dict | None = None,
    all_exercises_by_slug: dict | None = None,
) -> dict:
    """Build the canonical planner-output exercise dict from a seed
    exercise row + prescription. SINGLE source of truth for the shape
    of a planned exercise — every producer (main day-builder, weekly
    core injection, AI-regenerate rehydration, patch rehydration)
    should route through this helper.

    Guarantees:
      * Keys are camelCase at the external surface (`restSeconds`, not
        `rest_seconds`); `Prescription.rest_seconds` is mapped in.
      * `targetWeightLbs`, `weightRecommendationSource/Confidence/Reason`,
        and `setScheme` are always present (null when the exercise is
        cardio/mobility/timed-only or no perf profile was supplied).
      * Internal metadata (`_slug`, `_slot`, `_role`, `_rir_target`,
        `_primary_muscle`, `_secondary_muscles`, `_archetype`,
        `_training_type`) is always populated or None.
    """
    out_ex: dict = {
        "name": exercise.get("name"),
        "sets": prescription.sets,
        "reps": prescription.reps,
        "restSeconds": int(prescription.rest_seconds),
        "equipment": _equipment_label(exercise),
        "image_url": exercise.get("image_url") or None,
        # Internal metadata the canonicalizer + progression engine read.
        "_slug": exercise.get("slug"),
        "_slot": slot_label,
        "_role": role,
        "_rir_target": prescription.rir_target,
        "_primary_muscle": exercise.get("primary_muscle"),
        "_secondary_muscles": list(exercise.get("secondary_muscles") or []),
        "_archetype": archetype_value,
        "_training_type": training_type,
    }
    _stamp_load_metadata(
        out_ex,
        exercise=exercise,
        prescription=prescription,
        role=role,
        goal_bucket=goal_bucket,
        experience=experience,
        perf_profiles=perf_profiles,
        all_exercises_by_slug=all_exercises_by_slug,
    )
    return out_ex


def _normalize_rest_key(out_ex: dict) -> dict:
    """Ensure the planner-output dict uses camelCase `restSeconds`,
    never `rest_seconds`. Mutates AND returns the dict for convenience.
    Idempotent and safe on dicts that already only have `restSeconds`.
    """
    if "rest_seconds" in out_ex:
        if "restSeconds" not in out_ex:
            out_ex["restSeconds"] = out_ex.get("rest_seconds")
        out_ex.pop("rest_seconds", None)
    return out_ex


def _stamp_load_metadata(
    out_ex: dict,
    *,
    exercise: dict,
    prescription,
    role: str,
    goal_bucket: str,
    experience: str,
    perf_profiles: dict | None,
    all_exercises_by_slug: dict | None,
) -> None:
    """Attach deterministic load recommendation + set-scheme metadata
    to a planner output exercise dict IN PLACE.

    Pulled out of `generate_workout_plan` so the main pipeline stays
    readable. Silently no-ops when the caller didn't pass performance
    profiles — in that case the plan still carries a set scheme (with
    null target loads) so the UI can render set-role pills without
    needing history.

    Non-load exercises (cardio, mobility, recovery, bodyweight timed
    holds) explicitly skip weight recommendation — there's no
    sensible "target weight" for a zone-2 bike session or a 30s
    plank, and leaving `target_weight_lbs` stamped made the plan
    review prompt show nonsense like "Treadmill Intervals at 140 lb".
    """
    from .recommendation import recommend_starting_weight
    from .set_programming import build_set_scheme, parse_rep_range

    target_w: float | None = None
    rec_source: str | None = None
    rec_confidence: float | None = None
    rec_reason: str | None = None

    # Load recommendation only applies to lifting work. Skip outright
    # for cardio / mobility / recovery / timed holds / bodyweight.
    training_type = (exercise.get("training_type") or "").lower()
    primary_muscle = (exercise.get("primary_muscle") or "").lower()
    equipment_bucket = (exercise.get("equipment_bucket") or "").lower()
    rep_range = parse_rep_range(prescription.reps or "")
    is_cardio_or_mobility = (
        training_type in ("conditioning", "cardio", "mobility", "recovery")
        or primary_muscle == "cardio"
        or equipment_bucket in ("treadmill", "stationary_bike", "rowing_machine", "jump_rope", "elliptical")
    )
    is_timed_only = rep_range is None  # "30s", "3-5 min", "25-40 min", etc.
    skip_load = is_cardio_or_mobility or is_timed_only

    if not skip_load and perf_profiles is not None and all_exercises_by_slug is not None:
        try:
            rec = recommend_starting_weight(
                exercise,
                perf_profiles,
                all_exercises_by_slug,
                target_reps=prescription.reps,
                experience=experience,
            )
            if rec.weight_lbs > 0:
                target_w = rec.weight_lbs
            rec_source = rec.source
            rec_confidence = rec.confidence
            rec_reason = rec.reason
        except Exception as exc:  # defensive — never crash the planner
            logger.debug(f"[workout_planner] starting-weight recommendation failed for {exercise.get('slug')}: {exc}")

    scheme = build_set_scheme(
        exercise,
        total_sets=prescription.sets,
        reps=prescription.reps,
        rir_target=prescription.rir_target,
        target_weight_lbs=target_w,
        goal_bucket=goal_bucket,
        role=role,
        experience=experience,
    )

    out_ex["targetWeightLbs"] = target_w
    out_ex["weightRecommendationSource"] = rec_source
    out_ex["weightRecommendationConfidence"] = rec_confidence
    out_ex["weightRecommendationReason"] = rec_reason
    out_ex["setScheme"] = [s.to_dict() for s in scheme]


def generate_workout_plan(
    inputs: PlannerInputs,
    all_exercises: list[dict],
    history_familiarity: dict[str, int] | None = None,
    *,
    perf_profiles: dict | None = None,
    recent_muscle_exercises: dict[str, set[str]] | None = None,
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
    from .archetypes import ARCHETYPE_META, DayArchetype, archetype_to_focus_family
    from .day_templates import archetype_to_slots, archetype_display_name

    profile = goal_profile_for(
        inputs.goal,
        experience=inputs.experience,
        days_per_week=inputs.days_per_week,
        session_minutes=inputs.session_minutes,
    )
    # Split selection is a LIFTING SUBSYSTEM — only consulted when the
    # weekly recipe needs a traditional split for lifting-dominant
    # modes. Endurance / mobility / recovery / athletic modes build
    # their archetype sequence directly in `generate_weekly_recipe`.
    # focused_muscle feeds FocusProfile.split_bias into the auto-pick;
    # explicit user choice still wins inside pick_split.
    lifting_split = (
        pick_split(inputs, focused_muscle=inputs.focused_muscle)
        if profile.planner_mode in ("lifting", "fat_loss_mix", "lifting_plus_cardio")
        else None
    )
    _user_chose_split = bool(
        inputs.preferred_split
        and inputs.preferred_split != "auto"
        and inputs.preferred_split == lifting_split
    )
    recipe = generate_weekly_recipe(
        profile,
        inputs.days_per_week,
        lifting_split=lifting_split,
        user_chose_split=_user_chose_split,
        recent_focus_buckets=inputs.recent_focus_buckets,
        recent_focus_families=inputs.recent_focus_families,
        priority_region=inputs.priority_region,
        muscle_fatigue=inputs.muscle_fatigue,
        user_age=inputs.user_age,
    )
    logger.debug(
        f"[workout_planner] mode={profile.planner_mode} "
        f"days={inputs.days_per_week} "
        f"split={lifting_split} (user_chose={_user_chose_split}) "
        f"recipe=[" +
        ", ".join(a.value for a in recipe) + "]"
    )
    # Build a concrete (name, slots, archetype) sequence from the recipe.
    # Density trimming is now archetype-aware: the `category` argument
    # picks a role→minutes cost map per day type so a 30-min zone2
    # session doesn't trim like a 30-min lifting session.
    templates = []
    # Archetypes that bypass the slot system and use dedicated generators
    _GENERATED_ARCHETYPES = {
        DayArchetype.MOBILITY_FLOW, DayArchetype.RECOVERY_EASY,
        DayArchetype.STRESS_RELIEF_EASY,
    }
    for idx, archetype in enumerate(recipe):
        meta = ARCHETYPE_META[archetype]
        if archetype in _GENERATED_ARCHETYPES:
            # Use dedicated generator instead of slot→exercise pipeline.
            # These generators produce time-aware sessions that fill the
            # user's committed minutes properly.
            if archetype == DayArchetype.MOBILITY_FLOW:
                gen_day = generate_mobility_day(inputs.session_minutes)
            elif archetype == DayArchetype.RECOVERY_EASY:
                gen_day = generate_recovery_day(inputs.session_minutes)
            else:
                gen_day = generate_recovery_day(inputs.session_minutes)
            name = gen_day.get("focus", meta.default_name)
            templates.append((name, None, archetype, gen_day))
            continue
        slots = archetype_to_slots(
            archetype, idx, inputs.days_per_week,
            focused_muscle=inputs.focused_muscle,
        )
        name = archetype_display_name(archetype, idx, recipe)
        slots = density_adjust_slots(
            slots, inputs.session_minutes, category=meta.category,
        )
        templates.append((name, slots, archetype, None))
    targets = weekly_set_targets(inputs)
    # Injury-aware movement-pattern blocklist. Built once from the
    # user's injury tags and passed into every slot pick.
    blocked_patterns = _injury_blocked_patterns(inputs.injuries)
    if blocked_patterns:
        logger.debug(f"[workout_planner] injury-blocked patterns: {sorted(blocked_patterns)}")
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

    # Index once for load-recommendation lookups (transfer logic in
    # recommend_starting_weight iterates over this dict). Tolerates
    # missing slugs — rows without a slug simply can't be a source
    # for transfer anyway.
    all_exercises_by_slug: dict[str, dict] = {
        ex["slug"]: ex for ex in all_exercises if ex.get("slug")
    }
    goal_bucket = profile.bucket

    days_out: list[dict] = []
    # Track which focus families have already had a day in this plan.
    # When the same family comes up a second time (e.g., Legs day 2 in
    # PPL×2), seed used_exercise_slugs with what was on the LAST real
    # session of that family so exercise selection varies.
    _focus_day_count: dict[str, int] = {}

    for day_idx, (day_name, slots, archetype, gen_day) in enumerate(templates):
        # Pre-generated days (mobility/recovery) bypass the slot pipeline entirely.
        # Normalize `rest_seconds` → `restSeconds` on their exercises and stamp
        # archetype/category so downstream consumers can treat these days
        # identically to slot-built ones.
        if gen_day is not None:
            gen_exs = gen_day.get("exercises", []) or []
            for _gex in gen_exs:
                if isinstance(_gex, dict):
                    _normalize_rest_key(_gex)
            gen_meta = ARCHETYPE_META[archetype]
            days_out.append({
                "day": f"Day {day_idx + 1}",
                "focus": gen_day.get("focus", day_name),
                "archetype": archetype.value,
                "category": gen_meta.category,
                "stimulus": gen_day.get("stimulus", gen_meta.training_type),
                "exercises": gen_exs,
            })
            continue

        meta = ARCHETYPE_META[archetype]
        focus = meta.default_name
        accepts_types = meta.accepts_types
        _day_focus_family = archetype_to_focus_family(archetype)

        _focus_day_count[_day_focus_family] = _focus_day_count.get(_day_focus_family, 0) + 1
        _temp_history_slugs: set[str] = set()
        if recent_muscle_exercises:
            day_muscles = {s.primary_muscle_hint for s in slots if s.primary_muscle_hint}
            for muscle in day_muscles:
                for slug in (recent_muscle_exercises.get(muscle) or set()):
                    if slug not in used_exercise_slugs:
                        _temp_history_slugs.add(slug)
            if _temp_history_slugs:
                used_exercise_slugs.update(_temp_history_slugs)
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
                day_focus_family=_day_focus_family,
            )
            if ex is None:
                logger.debug(f"[workout_planner] slot '{slot.label}' had no eligible exercise")
                continue
            prescription = prescribe_for_slot(archetype, slot, ex, inputs)
            out_ex = build_planner_exercise(
                ex,
                prescription=prescription,
                slot_label=slot.label,
                role=slot.role,
                archetype_value=archetype.value,
                training_type=meta.training_type,
                goal_bucket=goal_bucket,
                experience=inputs.experience,
                perf_profiles=perf_profiles,
                all_exercises_by_slug=all_exercises_by_slug,
            )
            exercises_out.append(out_ex)
            # Warmup-role exercises don't count toward lifting volume.
            if slot.role != "warmup":
                _credit(ex, prescription.sets)
            sub = ex.get("substitution_group")
            if sub:
                used_substitution_groups.add(sub)
            if ex.get("slug"):
                used_exercise_slugs.add(ex["slug"])
        # Remove temporary history-based slugs so they don't bleed
        # into unrelated days. The real picks from THIS day are already
        # in used_exercise_slugs via the loop above (line 1273).
        if _temp_history_slugs:
            used_exercise_slugs -= _temp_history_slugs

        days_out.append({
            "day": day_name,
            "focus": focus,
            "archetype": archetype.value,
            "category": meta.category,
            "stimulus": meta.training_type,
            "exercises": exercises_out,
        })

    # Volume audit attached to the plan for transparency. Clients that
    # don't read it ignore it; the test suite uses it to assert the
    # volume balancer actually shifted something.
    volume_audit = {
        "targets": targets,
        "assigned": {k: round(v, 1) for k, v in assigned.items()},
        "focused_muscle": inputs.focused_muscle,
    }

    plan_name_suffix = (
        lifting_split.replace("_", " ").title()
        if lifting_split
        else profile.planner_mode.replace("_", " ").title()
    )
    # ── Weekly core injection ────────────────────────────────────────
    # Instead of hardcoding core into every template (which steals
    # accessories), inject core into the best days based on weekly
    # targets. Days that already have core from their template are
    # counted toward the target.
    from .core_planning import select_core_days, make_core_slot
    try:
        recipe_values = [a.value for a in recipe] if recipe else [d.get("_archetype", "") for d in days_out]
        core_day_indices = select_core_days(recipe_values, inputs.goal, inputs.days_per_week)

        for day_idx in core_day_indices:
            if day_idx >= len(days_out):
                continue
            day = days_out[day_idx]
            exercises = day.get("exercises", [])
            # Skip if this day already has core from its template
            already_has_core = any(
                ex.get("_primary_muscle") == "core" or ex.get("_slot") == "Core"
                or "core" in (ex.get("name", "") or "").lower()
                for ex in exercises
            )
            if already_has_core:
                continue

            # Create and fill a core slot using the same Slot dataclass
            # + pick_for_slot selection path the main loop uses. Any
            # deviation here (e.g. stale kwargs on pick_for_slot) would
            # silently break core injection.
            core_slot_def = make_core_slot(day_idx)
            core_slot = Slot(
                label=core_slot_def.label,
                movement_pattern=core_slot_def.movement_pattern,
                primary_muscle_hint="core",
                role="core",
            )
            # Per-day "used slugs" seed so we don't pick the exact
            # exercise already on this day. We pass a temporarily merged
            # set to the scorer rather than mutating the weekly set.
            day_used_slugs = {
                ex.get("_slug", "") for ex in exercises if ex.get("_slug")
            }
            _core_used_slugs = used_exercise_slugs | day_used_slugs
            core_ex = pick_for_slot(
                all_exercises, core_slot, inputs,
                used_substitution_groups, _core_used_slugs,
                history_familiarity,
                volume_targets=targets,
                volume_assigned=assigned,
                injury_blocked_patterns=blocked_patterns,
                accepts_types=frozenset({"strength"}),
                day_focus_family=None,
            )
            if core_ex:
                archetype_for_day = recipe[day_idx] if recipe and day_idx < len(recipe) else None
                archetype_val = archetype_for_day.value if archetype_for_day is not None else None
                meta_for_day = ARCHETYPE_META.get(archetype_for_day) if archetype_for_day is not None else None
                training_type_for_day = meta_for_day.training_type if meta_for_day is not None else None
                if archetype_for_day is not None:
                    core_prescription = prescribe_for_slot(archetype_for_day, core_slot, core_ex, inputs)
                else:
                    # Fallback prescription so the injected exercise is
                    # still fully-formed even without an archetype.
                    core_prescription = Prescription(sets=3, reps="10-15", rest_seconds=45, rir_target=2.0)
                core_out = build_planner_exercise(
                    core_ex,
                    prescription=core_prescription,
                    slot_label=core_slot.label,
                    role="core",
                    archetype_value=archetype_val,
                    training_type=training_type_for_day,
                    goal_bucket=goal_bucket,
                    experience=inputs.experience,
                    perf_profiles=perf_profiles,
                    all_exercises_by_slug=all_exercises_by_slug,
                )
                exercises.append(core_out)
                day["exercises"] = exercises
                if core_ex.get("slug"):
                    used_exercise_slugs.add(core_ex["slug"])

        core_count = sum(1 for d in days_out
            for ex in d.get("exercises", [])
            if ex.get("_primary_muscle") == "core" or ex.get("_role") == "core")
        logger.debug(f"[planner] weekly core: target={len(core_day_indices)} injected, total={core_count} across {len(days_out)} days")
    except Exception:
        # Never fatal — log the full trace so the failure is diagnosable
        # next regeneration instead of silently swallowed.
        logger.exception("[planner] weekly core injection failed (non-fatal)")

    # Age-adjusted warm-up: for 50+ users, prepend an extra joint-prep
    # warmup to every lift day. Older joints benefit from more prep work,
    # and the cost (~3-5 min) is a worthwhile trade for injury reduction.
    # Uses the canonical `restSeconds` / `targetWeightLbs` keys so the
    # output dict shape matches every other planned exercise.
    if inputs.user_age is not None and inputs.user_age >= 50:
        def _extra_warmup_dict() -> dict:
            # Fresh dict per day so mutations can't bleed across days.
            return {
                "name": "Extended Joint Prep",
                "sets": 1,
                "reps": "90s flow — mobility + activation",
                "restSeconds": 0,
                "equipment": "bodyweight",
                "image_url": None,
                "targetWeightLbs": None,
                "weightRecommendationSource": None,
                "weightRecommendationConfidence": None,
                "weightRecommendationReason": None,
                "setScheme": [],
                "_slug": None,
                "_slot": "Extended Warmup",
                "_role": "warmup",
                "_rir_target": None,
                "_primary_muscle": "full_body",
                "_secondary_muscles": [],
                "_archetype": None,
                "_training_type": "warmup",
                "notes": "Age-adjusted: extra prep for joint readiness",
            }
        for day in days_out:
            category = day.get("category", "")
            if category == "lift" and day.get("exercises"):
                # Prepend so it sits before the regular warmup slot.
                day["exercises"] = [_extra_warmup_dict()] + day["exercises"]

    # ── Focused-muscle exposure backfill + audit ───────────────────
    # FocusProfile tells us the minimum number of training days that
    # should hit the focused muscle AND the minimum number of DIRECT
    # isolation accessories for it across the week. If the deterministic
    # build missed either target, run a small backfill that injects
    # isolation exercises on the best-fit days.
    focus_audit: dict | None = None
    from .focus_profiles import get_focus_profile, focus_min_exposure_days
    _focus_profile_end = get_focus_profile(inputs.focused_muscle)
    if _focus_profile_end is not None:
        lift_day_indices = [
            i for i, d in enumerate(days_out)
            if (d.get("category") or "") == "lift"
        ]
        lifting_days = len(lift_day_indices) or max(1, inputs.days_per_week)
        min_exposure = focus_min_exposure_days(_focus_profile_end, lifting_days)
        min_accessories = _focus_profile_end.min_direct_accessories

        def _hits_focus(ex: dict, muscle: str) -> bool:
            pm = ex.get("_primary_muscle") or ""
            sm = ex.get("_secondary_muscles") or []
            return pm == muscle or muscle in sm

        def _days_with_focus() -> int:
            cnt = 0
            for d in days_out:
                for ex in d.get("exercises", []) or []:
                    if _hits_focus(ex, _focus_profile_end.muscle):
                        cnt += 1
                        break
            return cnt

        def _count_direct_accessories() -> int:
            return sum(
                1 for d in days_out
                for ex in (d.get("exercises", []) or [])
                if ex.get("_primary_muscle") == _focus_profile_end.muscle
                and ex.get("_role") == "isolation"
            )

        # Backfill direct accessories first — they also boost exposure.
        # Bloat guard: derive a per-day exercise cap from session_minutes
        # so the focus backfill can't push a density-trimmed 20-minute
        # session up to 7+ exercises. ~7 min per exercise is the rule of
        # thumb the slot density_adjust_slots pass uses — we mirror it
        # here, with a floor of 5 so full-length sessions aren't capped.
        _session_m = inputs.session_minutes or 45
        _max_exs_per_day = max(5, min(10, _session_m // 7))
        try:
            attempts = 0
            while _count_direct_accessories() < min_accessories and attempts < len(days_out) * 2:
                attempts += 1
                # Find the best lift day to host an extra accessory.
                # Exclude days that already carry a direct accessory so
                # we spread the extras across multiple days. ALSO exclude
                # days that are already at the per-day exercise cap so
                # the backfill can't bloat a short session past its
                # minute budget.
                already_hosting = {
                    i for i, d in enumerate(days_out)
                    if any(
                        ex.get("_primary_muscle") == _focus_profile_end.muscle
                        and ex.get("_role") == "isolation"
                        for ex in (d.get("exercises", []) or [])
                    )
                }
                at_cap = {
                    i for i, d in enumerate(days_out)
                    if len(d.get("exercises", []) or []) >= _max_exs_per_day
                }
                host = _find_best_accessory_host_day(
                    days_out, _focus_profile_end.muscle,
                    exclude=already_hosting | at_cap,
                )
                if host is None:
                    break
                iso_slot = Slot(
                    label=f"{_focus_profile_end.muscle.title()} Isolation (focus)",
                    movement_pattern="isolation",
                    primary_muscle_hint=_focus_profile_end.muscle,
                    role="isolation",
                )
                host_exs = days_out[host].get("exercises", []) or []
                day_used = {e.get("_slug") for e in host_exs if e.get("_slug")}
                focus_ex = pick_for_slot(
                    all_exercises, iso_slot, inputs,
                    used_substitution_groups,
                    used_exercise_slugs | day_used,
                    history_familiarity,
                    volume_targets=targets,
                    volume_assigned=assigned,
                    injury_blocked_patterns=blocked_patterns,
                    accepts_types=frozenset({"strength"}),
                    day_focus_family=None,
                )
                if focus_ex is None:
                    break
                host_archetype = recipe[host] if recipe and host < len(recipe) else None
                host_meta = ARCHETYPE_META.get(host_archetype) if host_archetype is not None else None
                if host_archetype is not None:
                    focus_pres = prescribe_for_slot(host_archetype, iso_slot, focus_ex, inputs)
                else:
                    focus_pres = Prescription(sets=3, reps="10-15", rest_seconds=60, rir_target=2.0)
                focus_out = build_planner_exercise(
                    focus_ex,
                    prescription=focus_pres,
                    slot_label=iso_slot.label,
                    role="isolation",
                    archetype_value=host_archetype.value if host_archetype is not None else None,
                    training_type=host_meta.training_type if host_meta is not None else None,
                    goal_bucket=goal_bucket,
                    experience=inputs.experience,
                    perf_profiles=perf_profiles,
                    all_exercises_by_slug=all_exercises_by_slug,
                )
                days_out[host].setdefault("exercises", []).append(focus_out)
                if focus_ex.get("slug"):
                    used_exercise_slugs.add(focus_ex["slug"])
        except Exception:
            logger.exception("[planner] focused-muscle backfill failed (non-fatal)")

        days_with_exposure = _days_with_focus()
        direct_accessories = _count_direct_accessories()
        focus_audit = {
            "muscle": _focus_profile_end.muscle,
            "days_with_exposure": days_with_exposure,
            "min_exposure_days": min_exposure,
            "direct_accessories": direct_accessories,
            "min_direct_accessories": min_accessories,
            "slot_variant": _focus_profile_end.slot_variant,
        }
        logger.info(
            f"[planner] focus={_focus_profile_end.muscle} "
            f"exposure={days_with_exposure}/{min_exposure} "
            f"accessories={direct_accessories}/{min_accessories}"
        )

    workout_plan_block = {
        "name": f"{profile.label} — {plan_name_suffix}",
        "totalDays": inputs.days_per_week,
        "days": days_out,
        "volume_audit": volume_audit,
        "planner_mode": profile.planner_mode,
        "goal_bucket": profile.bucket,
    }
    if focus_audit is not None:
        workout_plan_block["focus_audit"] = focus_audit

    plan = {
        "trainerNote": "",
        "workout_plan": workout_plan_block,
    }
    plan = validate_plan(plan, inputs, recipe)
    return plan


def validate_plan(
    plan: dict,
    inputs: PlannerInputs,
    recipe: list | None = None,
) -> dict:
    """Post-generation validation pass.

    Checks:
      1. No empty days (no exercises at all).
      2. No duplicate exercises within a single day.
      3. No adjacent same-focus-family days (unless cardio/mobility/recovery).
      4. No compound exercises on wrong-family days (belt-and-suspenders
         for the filter_candidates enforcement).
      5. If the user chose PPL, verify push/pull/legs are all present.

    Violations are logged loudly. Lightweight repairs are attempted
    where possible (drop duplicates, swap adjacent same-family days).
    The plan is returned (possibly mutated) regardless — we never fail
    the generation entirely.
    """
    from .archetypes import DayArchetype, archetype_to_focus_family
    days = plan.get("workout_plan", {}).get("days", [])
    if not days:
        return plan

    # ── Check 1: empty days ─────────────────────────────────────────
    for i, day in enumerate(days):
        exs = day.get("exercises", [])
        if not exs:
            logger.debug(
                f"[validate_plan] WARNING: Day {i} ({day.get('day')}) "
                f"has no exercises — archetype={day.get('archetype')}"
            )

    # ── Check 2: duplicate exercises within a day ───────────────────
    for i, day in enumerate(days):
        exs = day.get("exercises", [])
        seen_slugs: set[str] = set()
        deduped: list[dict] = []
        for ex in exs:
            slug = ex.get("_slug")
            if slug and slug in seen_slugs:
                logger.debug(
                    f"[validate_plan] REPAIR: dropping duplicate exercise "
                    f"'{ex.get('name')}' (slug={slug}) on Day {i}"
                )
                continue
            if slug:
                seen_slugs.add(slug)
            deduped.append(ex)
        day["exercises"] = deduped

    # ── Check 3: adjacent same-focus-family days ────────────────────
    _SKIP_FAMILIES = {"cardio", "mobility", "recovery"}
    for i in range(1, len(days)):
        fam_a = None
        fam_b = None
        arch_a = days[i - 1].get("archetype")
        arch_b = days[i].get("archetype")
        try:
            if arch_a:
                fam_a = archetype_to_focus_family(DayArchetype(arch_a))
        except (KeyError, ValueError):
            pass
        try:
            if arch_b:
                fam_b = archetype_to_focus_family(DayArchetype(arch_b))
        except (KeyError, ValueError):
            pass
        if (
            fam_a and fam_b
            and fam_a == fam_b
            and fam_a not in _SKIP_FAMILIES
        ):
            # Try to swap day[i] with a later non-adjacent day.
            swapped = False
            for j in range(i + 1, len(days)):
                fam_j = None
                arch_j = days[j].get("archetype")
                try:
                    if arch_j:
                        fam_j = archetype_to_focus_family(DayArchetype(arch_j))
                except (KeyError, ValueError):
                    pass
                # Check that swapping doesn't create a new adjacency problem.
                prev_ok = (i - 1 < 0) or True  # already checked above
                if fam_j and fam_j != fam_a:
                    # Also check that day[j] won't conflict with day[i-1]
                    if i > 0 and fam_j == fam_a:
                        continue
                    # And day[i+1] won't conflict with original day[j] if j==i+1
                    days[i], days[j] = days[j], days[i]
                    logger.debug(
                        f"[validate_plan] REPAIR: swapped Day {i} ↔ Day {j} "
                        f"to break adjacent {fam_a!r} streak"
                    )
                    swapped = True
                    break
            if not swapped:
                logger.debug(
                    f"[validate_plan] WARNING: adjacent same-family days "
                    f"{i - 1}↔{i} (both {fam_a!r}) — no swap available"
                )

    # ── Check 4: compound exercises on wrong-family days ────────────
    for i, day in enumerate(days):
        arch_str = day.get("archetype")
        if not arch_str:
            continue
        try:
            fam = archetype_to_focus_family(DayArchetype(arch_str))
        except (KeyError, ValueError):
            continue
        allowed = _FOCUS_FAMILY_MUSCLES.get(fam)
        if allowed is None:
            continue  # full_body / cardio / mobility / recovery — no restriction
        cleaned: list[dict] = []
        for ex in day.get("exercises", []):
            role = ex.get("_role", "isolation")
            if role in ("primary", "secondary"):
                pm = ex.get("_primary_muscle", "")
                if pm and pm not in allowed:
                    logger.debug(
                        f"[validate_plan] REPAIR: dropping '{ex.get('name')}' "
                        f"(primary_muscle={pm}) from Day {i} "
                        f"(focus_family={fam}, allowed={sorted(allowed)})"
                    )
                    continue
            cleaned.append(ex)
        day["exercises"] = cleaned

    # ── Check 5: split identity preserved ───────────────────────────
    if recipe:
        from .day_templates import SPLIT_PPL
        # Detect if user explicitly chose PPL
        if inputs.preferred_split == "ppl":
            recipe_families = set()
            for day in days:
                arch_str = day.get("archetype")
                if arch_str:
                    try:
                        recipe_families.add(
                            archetype_to_focus_family(DayArchetype(arch_str))
                        )
                    except (KeyError, ValueError):
                        pass
            expected = {"push", "pull", "legs"}
            missing = expected - recipe_families
            if missing:
                logger.debug(
                    f"[validate_plan] WARNING: user chose PPL but recipe "
                    f"is missing families: {sorted(missing)} "
                    f"(present: {sorted(recipe_families)})"
                )

    # ── Check 6: consecutive heavy/resistance day audit ─────────────
    stimuli = [d.get("stimulus", "") for d in days]
    heavy_types = {"strength", "power", "mixed"}
    heavy_streak = 0
    max_heavy_streak = 0
    resistance_streak = 0
    max_resistance_streak = 0
    for stim in stimuli:
        if stim in heavy_types:
            heavy_streak += 1
            max_heavy_streak = max(max_heavy_streak, heavy_streak)
        else:
            heavy_streak = 0
        if stim not in ("conditioning", "mobility", "recovery", ""):
            resistance_streak += 1
            max_resistance_streak = max(max_resistance_streak, resistance_streak)
        else:
            resistance_streak = 0
    if max_heavy_streak >= 3:
        logger.debug(
            f"[validate_plan] WARNING: {max_heavy_streak} consecutive heavy days "
            f"detected — stimuli={stimuli}. Consider rebalancing."
        )
    if max_resistance_streak >= 4:
        logger.debug(
            f"[validate_plan] WARNING: {max_resistance_streak} consecutive resistance "
            f"days without recovery — stimuli={stimuli}"
        )

    # ── Check 7: region priority audit ──��───────────────────────��───
    from .region_priority import normalize_region, validate_region_exposure
    region = normalize_region(inputs.priority_region)
    if region != "balanced" and days:
        audit = validate_region_exposure(region, days)
        plan.get("workout_plan", {})["region_audit"] = audit
        if audit["ok"]:
            logger.debug(f"[validate_plan] region OK: {region} — lower={audit['lower_days']} upper={audit['upper_days']}")
        else:
            logger.debug(f"[validate_plan] REGION WARNING: {audit['message']}")

    return plan


def _find_best_accessory_host_day(days_out: list[dict], muscle: str, exclude: set[int] | None = None) -> int | None:
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
    _exclude = exclude or set()
    scored: list[tuple[int, int, int]] = []  # (priority, ex_count, idx)
    for idx, day in enumerate(days_out):
        if idx in _exclude:
            continue
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
    if not scored:
        return None
    scored.sort()
    return scored[0][2]




# ─── Injury system ───────────────────────────────────────────────────────────
#
# Three layers of injury handling:
#   1. Movement pattern blocking — hard-excludes exercises for active injuries
#   2. Muscle group mapping — boosts fatigue on affected muscles so readiness
#      scores reflect injuries (e.g. "lower back" → back/core/hamstrings fatigued)
#   3. Recovering mode — allows exercises at reduced volume instead of full block
#
# Each injury keyword maps to blocked patterns, recovering patterns, and
# affected muscle groups. The 'status: recovering' string in the injury tag
# triggers the gentler recovering path.

from dataclasses import dataclass as _injury_dc

@_injury_dc
class _InjuryMapping:
    blocked_patterns: set[str]       # hard-block when active
    recovering_patterns: set[str]    # allow at reduced volume when recovering
    muscle_groups: list[str]         # for fatigue system integration

_INJURY_MAP: dict[str, _InjuryMapping] = {
    # Shoulder
    "shoulder":             _InjuryMapping({"vertical_press", "horizontal_press"}, {"horizontal_press"}, ["shoulders", "chest"]),
    "rotator_cuff":         _InjuryMapping({"vertical_press", "horizontal_press"}, {"horizontal_press"}, ["shoulders"]),
    "shoulder_impingement": _InjuryMapping({"vertical_press"}, {"horizontal_press"}, ["shoulders"]),
    "ac_joint":             _InjuryMapping({"vertical_press", "horizontal_press"}, set(), ["shoulders"]),
    # Back
    "lower_back":           _InjuryMapping({"hinge"}, {"squat"}, ["back", "core", "hamstrings"]),
    "low_back":             _InjuryMapping({"hinge"}, {"squat"}, ["back", "core", "hamstrings"]),
    "lumbar":               _InjuryMapping({"hinge"}, {"squat"}, ["back", "core"]),
    "herniated_disc":       _InjuryMapping({"hinge", "squat"}, set(), ["back", "core", "hamstrings"]),
    "sciatica":             _InjuryMapping({"hinge"}, {"squat", "lunge"}, ["back", "hamstrings", "glutes"]),
    # Knee
    "knee":                 _InjuryMapping({"lunge", "squat"}, {"squat"}, ["quads", "hamstrings"]),
    "patellar":             _InjuryMapping({"lunge", "squat"}, {"squat"}, ["quads"]),
    "patellar_tendonitis":  _InjuryMapping({"lunge", "squat"}, set(), ["quads"]),
    "meniscus":             _InjuryMapping({"squat", "lunge"}, set(), ["quads", "hamstrings"]),
    "acl":                  _InjuryMapping({"squat", "lunge"}, set(), ["quads", "hamstrings", "glutes"]),
    "mcl":                  _InjuryMapping({"lunge"}, {"squat"}, ["quads"]),
    # Hip / ankle
    "hip":                  _InjuryMapping({"hinge", "lunge"}, {"squat"}, ["glutes", "hamstrings"]),
    "hip_flexor":           _InjuryMapping({"hinge", "lunge"}, set(), ["quads", "core"]),
    "ankle":                _InjuryMapping({"lunge"}, {"squat"}, ["calves"]),
    "achilles":             _InjuryMapping({"lunge"}, set(), ["calves"]),
    # Elbow / wrist — now blocks appropriate patterns
    "elbow":                _InjuryMapping({"isolation"}, {"horizontal_press", "horizontal_pull"}, ["biceps", "triceps"]),
    "tennis_elbow":         _InjuryMapping({"isolation", "horizontal_pull"}, {"horizontal_press"}, ["biceps", "triceps"]),
    "golfer_elbow":         _InjuryMapping({"isolation"}, {"horizontal_pull"}, ["biceps"]),
    "wrist":                _InjuryMapping({"vertical_press"}, {"horizontal_press"}, ["shoulders"]),
    # Chest
    "chest":                _InjuryMapping({"horizontal_press"}, set(), ["chest", "triceps"]),
    "pec":                  _InjuryMapping({"horizontal_press"}, set(), ["chest"]),
    # Neck
    "neck":                 _InjuryMapping({"vertical_press"}, {"horizontal_press"}, ["shoulders", "core"]),
}


def _normalize_injury_key(raw: str) -> str:
    return "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in str(raw).lower().strip())


def _lookup_injury(raw: str) -> _InjuryMapping | None:
    key = _normalize_injury_key(raw)
    if key in _INJURY_MAP:
        return _INJURY_MAP[key]
    for known, mapping in _INJURY_MAP.items():
        if known and known in key:
            return mapping
    return None


def _injury_blocked_patterns(injuries: tuple[str, ...] | list[str] | None) -> set[str]:
    """Movement patterns to hard-exclude. Active injuries block fully;
    recovering injuries block a smaller subset."""
    if not injuries:
        return set()
    blocked: set[str] = set()
    for inj in injuries:
        if not inj:
            continue
        is_recovering = "recovering" in str(inj).lower()
        mapping = _lookup_injury(inj)
        if mapping:
            if is_recovering:
                blocked |= (mapping.blocked_patterns - mapping.recovering_patterns)
            else:
                blocked |= mapping.blocked_patterns
    return blocked


def _injury_recovering_patterns(injuries: tuple[str, ...] | list[str] | None) -> set[str]:
    """Movement patterns that should have reduced volume (not fully blocked).
    Only applies to injuries with status=recovering."""
    if not injuries:
        return set()
    recovering: set[str] = set()
    for inj in injuries:
        if not inj or "recovering" not in str(inj).lower():
            continue
        mapping = _lookup_injury(inj)
        if mapping:
            recovering |= mapping.recovering_patterns
    return recovering


def injury_muscle_fatigue_boost(injuries: tuple[str, ...] | list[str] | None) -> dict[str, float]:
    """Extra fatigue to apply to muscle groups affected by injuries.

    Active injuries: +0.5 fatigue (heavily suppresses readiness for that focus).
    Recovering injuries: +0.25 (moderately suppresses).
    Feeds into the fatigue system so readiness scores reflect injuries.
    """
    if not injuries:
        return {}
    boosts: dict[str, float] = {}
    for inj in injuries:
        if not inj:
            continue
        is_recovering = "recovering" in str(inj).lower()
        mapping = _lookup_injury(inj)
        if not mapping:
            continue
        boost = 0.25 if is_recovering else 0.5
        for muscle in mapping.muscle_groups:
            boosts[muscle] = max(boosts.get(muscle, 0), boost)
    return boosts


# ─── Phase 2 placeholder — session-to-session progression ───────────────────


def propose_session_targets_from_history(
    next_plan: dict,
    history: list[dict],
    *,
    goal_bucket: str = "muscle_gain",
    experience: str = "intermediate",
) -> dict:
    """Stamp next-session target loads + set schemes onto `next_plan`
    based on the user's recent completed sets.

    `history` is a list of exercise-result dicts in this shape:

        {
          "slug": str,
          "sets": [{"reps": int, "weight_lbs": float, "rir": float?}, ...],
          "performed_on": date (optional, most-recent wins),
        }

    For every exercise in every day of `next_plan["workout_plan"]`, we
    look up the most recent matching history entry by slug, run it
    through `recommend_next_session_load`, and re-build the set scheme
    with the new target load. Exercises without history are left
    untouched (the `generate_workout_plan` starting-weight pass may
    have already stamped a target; if not, the set scheme will carry
    null loads and the frontend falls back to the live
    `/recommend-weight` endpoint at session start).

    This function MUTATES `next_plan` for convenience (matching the
    pattern in `propagate_session_targets` in history.py) and also
    returns it so callers can chain.
    """
    from .set_programming import (
        build_set_scheme,
        parse_rep_range,
        recommend_next_session_load,
    )

    if not isinstance(next_plan, dict) or "workout_plan" not in next_plan:
        return next_plan

    # Index history by slug → most-recent entry.
    latest_by_slug: dict[str, dict] = {}
    for entry in history or []:
        slug = entry.get("slug")
        if not slug:
            continue
        prev = latest_by_slug.get(slug)
        if prev is None:
            latest_by_slug[slug] = entry
            continue
        a = entry.get("performed_on") or 0
        b = prev.get("performed_on") or 0
        if a and b:
            if a > b:
                latest_by_slug[slug] = entry
        elif a and not b:
            latest_by_slug[slug] = entry

    days = next_plan.get("workout_plan", {}).get("days", [])
    for day in days:
        for ex_out in day.get("exercises", []):
            slug = ex_out.get("_slug")
            if not slug or slug not in latest_by_slug:
                continue
            last_sets = latest_by_slug[slug].get("sets") or []
            if not last_sets:
                continue

            # Reconstruct a minimal "exercise dict" for the load
            # helpers. The planner output already stores the fields
            # they need (equipment_bucket lives on the seed row, but
            # we recover is_compound via role + primary_muscle).
            exercise_stub = {
                "slug": slug,
                "name": ex_out.get("name"),
                "equipment_bucket": ex_out.get("_equipment_bucket") or _infer_bucket(ex_out.get("equipment", "")),
                "primary_muscle": ex_out.get("_primary_muscle"),
                "movement_pattern": ex_out.get("_movement_pattern"),
                "is_compound": ex_out.get("_role") in ("primary", "compound"),
            }

            rng = parse_rep_range(ex_out.get("reps") or "")
            # Build a synthetic "planned set 1" from the current exercise
            # output so the next-session helper can read its progression
            # mode off the FIRST set of the scheme.
            scheme_dicts = ex_out.get("setScheme") or []
            if scheme_dicts:
                first = scheme_dicts[0]
                from .set_programming import PlannedSet  # local import — avoid cycles
                planned_first = PlannedSet(
                    set_number=1,
                    set_type=first.get("setType", "volume"),
                    target_reps=first.get("targetReps", ex_out.get("reps", "")),
                    target_rir=first.get("targetRir", ex_out.get("_rir_target", 2.0)),
                    target_weight_lbs=first.get("targetWeightLbs"),
                    progression_mode=first.get("progressionMode", "reps_first"),
                )
            else:
                from .set_programming import PlannedSet
                planned_first = PlannedSet(
                    set_number=1,
                    set_type="volume",
                    target_reps=ex_out.get("reps", ""),
                    target_rir=float(ex_out.get("_rir_target") or 2.0),
                    target_weight_lbs=ex_out.get("targetWeightLbs"),
                    progression_mode="reps_first",
                )

            new_w, action, reason = recommend_next_session_load(
                exercise=exercise_stub,
                planned_set=planned_first,
                last_session_sets=last_sets,
                rep_range=rng,
            )

            # Re-build the set scheme with the new anchor weight so the
            # heavy-top / backoff loads reflect the update.
            scheme = build_set_scheme(
                exercise_stub,
                total_sets=int(ex_out.get("sets") or 1),
                reps=ex_out.get("reps", ""),
                rir_target=float(ex_out.get("_rir_target") or 2.0),
                target_weight_lbs=new_w,
                goal_bucket=goal_bucket,
                role=ex_out.get("_role", "accessory"),
                experience=experience,
            )

            ex_out["targetWeightLbs"] = new_w
            ex_out["weightRecommendationSource"] = "exact_history"
            ex_out["weightRecommendationConfidence"] = 0.85
            ex_out["weightRecommendationReason"] = reason
            ex_out["progressionAction"] = action
            ex_out["setScheme"] = [s.to_dict() for s in scheme]

    return next_plan


def _infer_bucket(equipment_label: str) -> str:
    """Best-effort equipment bucket inference from a comma-joined
    equipment label. Used only by `propose_session_targets_from_history`
    when the planner's internal `_equipment_bucket` wasn't preserved.
    """
    s = (equipment_label or "").lower()
    if "barbell" in s:
        return "barbell"
    if "dumbbell" in s:
        return "dumbbell"
    if "cable" in s:
        return "cable"
    if "machine" in s or "plate loaded" in s:
        return "machine"
    if "bodyweight" in s or not s:
        return "bodyweight"
    return "other"


# ─── On-demand day generators for focus overrides ────────────────────────────

def _est_exercise_time(ex: dict) -> float:
    """Rough estimate of minutes for one exercise based on sets, reps, rest.
    Accepts either `rest_seconds` (internal pool dicts) or `restSeconds`
    (normalized planner-output dicts)."""
    sets = ex.get("sets", 1)
    rest = ex.get("rest_seconds", ex.get("restSeconds", 0)) or 0
    reps_str = str(ex.get("reps", ""))
    # Time-based reps like "60s each side", "5 min", "30s hold"
    if "min" in reps_str:
        try:
            mins = float(reps_str.split("min")[0].strip().split("-")[-1])
            return mins * sets + (rest * max(0, sets - 1)) / 60
        except ValueError:
            pass
    if "s" in reps_str and "set" not in reps_str:
        try:
            secs = float(reps_str.replace("s", "").split("-")[-1].split(" ")[0].strip())
            per_set = secs * (2 if "each" in reps_str else 1)
            return (per_set * sets + rest * max(0, sets - 1)) / 60
        except ValueError:
            pass
    # Rep-based: ~3s per rep + rest
    try:
        rep_count = int(reps_str.split("-")[-1].split(" ")[0].strip())
        per_set = rep_count * 3 * (2 if "each" in reps_str else 1)
        return (per_set * sets + rest * max(0, sets - 1)) / 60
    except ValueError:
        return 2.0  # fallback


def _pick_exercises_for_time(pool: list[dict], target_minutes: int) -> list[dict]:
    """Pick exercises from pool until we fill the target time."""
    result = []
    total = 0.0
    for ex in pool:
        t = _est_exercise_time(ex)
        if total + t > target_minutes + 2:
            break
        result.append(ex)
        total += t
    return result


def generate_recovery_day(session_minutes: int = 45) -> dict:
    """Generate an active recovery day that fits within session_minutes."""
    sm = max(20, session_minutes)
    pool = [
        {"name": "Foam Rolling — Full Body", "sets": 1, "reps": f"{min(8, max(4, sm // 8))} min", "rest_seconds": 0, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["core"]},
        # Cat-Cow removed from recovery pool — it's a lift-day warmup drill.
        # Recovery day should be passive holds + walk, not activation flows.
        {"name": "Hip 90/90 Stretch", "sets": 2, "reps": "30s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["glutes", "hamstrings"]},
        {"name": "Reclined Pigeon (Figure-4)", "sets": 2, "reps": "45s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["glutes"]},
        {"name": "World's Greatest Stretch", "sets": 2, "reps": "30s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["core", "shoulders", "hamstrings"]},
        {"name": "Supine Spinal Twist", "sets": 2, "reps": "30s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["core", "back"]},
        {"name": "Child's Pose", "sets": 1, "reps": "45s hold", "rest_seconds": 0, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["back", "shoulders"]},
        {"name": "Pigeon Pose", "sets": 2, "reps": "45s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["glutes", "hamstrings"]},
        {"name": "Seated Forward Fold", "sets": 2, "reps": "30s hold", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["hamstrings", "back"]},
        {"name": "Lying Quad Stretch", "sets": 2, "reps": "30s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["quads"]},
        {"name": "Shoulder Cross-Body Stretch", "sets": 2, "reps": "20s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["shoulders"]},
    ]
    # Reserve time for a walk if session is long enough
    walk_time = max(0, sm - 25) if sm >= 35 else 0
    stretch_budget = sm - walk_time
    exercises = _pick_exercises_for_time(pool, stretch_budget)
    if walk_time >= 5:
        exercises.append({"name": "Easy Walk", "sets": 1, "reps": f"{walk_time} min", "rest_seconds": 0, "equipment": "bodyweight", "slot_role": "recovery", "muscles_targeted": ["cardio"]})
    return {"day": "Recovery Day", "focus": "Recovery", "stimulus": "recovery", "exercises": exercises}


def generate_mobility_day(session_minutes: int = 45) -> dict:
    """Generate a mobility day that fits within session_minutes.

    Content philosophy: mobility day is a dedicated yoga/long-hold
    session — NOT a lift warmup. Entries are long passive holds, deep
    hip/shoulder openers, and flow sequences that would be awkward or
    time-consuming to squeeze into a lifting day's 5-min warmup.
    Short activation drills (Wall Slides, Shoulder Dislocates, Thoracic
    Rotation, Cat-Cow) live in lift-day warmup slots instead — putting
    them here would make the mobility day feel like a random assortment
    of warmups with no distinct identity.
    """
    sm = max(20, session_minutes)
    pool = [
        {"name": "Foam Rolling — Full Body", "sets": 1, "reps": f"{min(10, max(5, sm // 6))} min flow", "rest_seconds": 0, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["core"]},
        {"name": "Downward Dog to Cobra Flow", "sets": 3, "reps": "60s flow", "rest_seconds": 15, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["shoulders", "hamstrings", "core"]},
        {"name": "Low Lunge (Deep)", "sets": 3, "reps": "60s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["quads", "hip_flexors"]},
        {"name": "Hip 90/90 Stretch", "sets": 3, "reps": "60s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["glutes", "hamstrings"]},
        {"name": "World's Greatest Stretch", "sets": 3, "reps": "45s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["core", "shoulders", "hamstrings"]},
        {"name": "Pigeon Pose", "sets": 3, "reps": "90s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["glutes", "hamstrings"]},
        {"name": "Couch Stretch", "sets": 3, "reps": "60s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["quads", "core"]},
        {"name": "Dead Hang", "sets": 3, "reps": "30s hold", "rest_seconds": 15, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["back", "shoulders"]},
        {"name": "Cobbler's Pose (Baddha Konasana)", "sets": 2, "reps": "90s hold", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["glutes", "core"]},
        {"name": "Seated Straddle Stretch", "sets": 3, "reps": "60s hold", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["hamstrings", "glutes"]},
        {"name": "Supine Spinal Twist", "sets": 2, "reps": "45s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["core", "back"]},
        {"name": "Sphinx Pose", "sets": 2, "reps": "60s hold", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["core", "back"]},
        {"name": "Happy Baby", "sets": 2, "reps": "45s hold", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["glutes", "core"]},
        {"name": "Legs-Up-The-Wall", "sets": 1, "reps": "3 min hold", "rest_seconds": 0, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["core"]},
        {"name": "Reclined Pigeon (Figure-4)", "sets": 2, "reps": "60s each side", "rest_seconds": 10, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["glutes"]},
        {"name": "Child's Pose", "sets": 2, "reps": "60s hold", "rest_seconds": 0, "equipment": "bodyweight", "slot_role": "mobility", "muscles_targeted": ["back", "shoulders"]},
    ]
    exercises = _pick_exercises_for_time(pool, sm)
    return {"day": "Mobility Day", "focus": "Mobility", "stimulus": "mobility", "exercises": exercises}


def generate_cardio_day(session_minutes: int = 45, goal: str = "body_recomp") -> dict:
    """Generate a cardio day appropriate for the user's goal."""
    if goal in ("fat_loss", "endurance", "hyrox", "athletic_performance"):
        exercises = [
            {"name": "Jump Rope", "sets": 1, "reps": "5 min warm-up", "rest_seconds": 60, "equipment": "bodyweight", "slot_role": "warmup", "muscles_targeted": ["cardio", "calves"]},
            {"name": "Rowing Machine", "sets": 1, "reps": f"{min(25, session_minutes - 15)} min steady", "rest_seconds": 0, "equipment": "machine", "slot_role": "primary", "muscles_targeted": ["cardio", "back", "core"]},
            {"name": "Assault Bike Intervals", "sets": 6, "reps": "30s on / 60s off", "rest_seconds": 60, "equipment": "machine", "slot_role": "primary", "muscles_targeted": ["cardio", "quads"]},
        ]
    else:
        exercises = [
            {"name": "Incline Treadmill Walk", "sets": 1, "reps": f"{min(30, session_minutes - 10)} min", "rest_seconds": 0, "equipment": "machine", "slot_role": "primary", "muscles_targeted": ["cardio", "glutes", "calves"]},
            {"name": "Stair Climber", "sets": 1, "reps": "10 min", "rest_seconds": 0, "equipment": "machine", "slot_role": "primary", "muscles_targeted": ["cardio", "quads", "glutes"]},
        ]
    return {
        "day": "Cardio Day",
        "focus": "Cardio",
        "stimulus": "conditioning",
        "exercises": exercises,
    }
