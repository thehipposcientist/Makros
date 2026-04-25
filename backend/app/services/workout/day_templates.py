"""Day templates, split selection, archetype → slot dispatch.

Owns everything about "given an archetype, what slot list represents
it?" and "given a set of lifting inputs, what classic split should the
lifting subsystem use?". Pulled out of `planner.py` so the planner
service can focus on orchestration.

Relationship to `slots.py`:

    slots.py       — the Slot dataclass, every slot builder helper,
                      archetype-aware density trimming (pure data, zero
                      knowledge of archetypes or splits).

    day_templates.py — knows about `DayArchetype` and classic splits;
                      calls into slots.py to get concrete slot lists.

    planner.py     — orchestrates everything, imports from both.

The split selector (`pick_split`) still lives here as a LIFTING
SUBSYSTEM — it's only consulted when the weekly recipe asks for a
lifting-mode schedule. Endurance / mobility / recovery / athletic
plans never go through `pick_split`; they're built directly from
archetype recipes.
"""
from __future__ import annotations

from typing import Optional

from .goals import goal_bucket
from .slots import (
    Slot,
    _BRO_SLOT_SEQUENCE,
    _cardio_intervals_slots,
    _cardio_mixed_slots,
    _cardio_sprint_power_slots,
    _cardio_steady_slots,
    _cardio_tempo_slots,
    _circuit_slots,
    _full_body_slots,
    _hybrid_full_body_circuit_slots,
    _hybrid_lower_power_slots,
    _hybrid_strength_intervals_slots,
    _hybrid_upper_intervals_slots,
    _push_plus_cardio_slots,
    _pull_plus_cardio_slots,
    _upper_plus_cardio_slots,
    _full_body_plus_cardio_slots,
    _legs_slots,
    _lower_slots,
    _mobility_flow_slots,
    _pull_slots,
    _push_slots,
    _recovery_easy_slots,
    _stress_relief_slots,
    _stretch_block_slots,
    _strength_maintenance_slots,
    _upper_slots,
    _upper_heavy_slots,
    _upper_hypertrophy_slots,
    _lower_heavy_slots,
    _lower_hypertrophy_slots,
    _push_volume_slots,
    _pull_volume_slots,
    _legs_volume_slots,
    _full_body_strength_slots,
    # PPL heavy variants
    _push_heavy_slots,
    _pull_heavy_slots,
    _legs_heavy_slots,
    _legs_heavy_glute_slots,
    # Focus-aware variants
    _lower_heavy_glute_slots,
    _lower_hypertrophy_glute_slots,
    _legs_glute_slots,
    _legs_volume_glute_slots,
    _full_body_glute_slots,
    _upper_chest_focus_slots,
    _upper_back_focus_slots,
    _upper_shoulders_focus_slots,
)


# ─── Split constants ────────────────────────────────────────────────
#
# Splits are a LIFTING SUBSYSTEM. They describe how a traditional
# bodybuilding/powerlifting week is structured. The multi-goal
# planner uses these only when `profile.planner_mode` indicates a
# lifting-dominant plan; endurance / mobility / recovery modes skip
# split selection entirely and go straight from archetype to slots.
SPLIT_FULL_BODY = "full_body"
SPLIT_UPPER_LOWER = "upper_lower"
SPLIT_PPL = "ppl"                  # push / pull / legs
SPLIT_BRO = "bro"                  # chest / back / shoulders / arms / legs
SPLIT_PPL_UL = "ppl_upper_lower"   # 5-day hybrid
# Region-emphasis splits (Apr 2026). Replaces the priority_region tilt
# for users who explicitly want a lower- or upper-body focus. Cleaner
# mental model than orthogonal-region: the split IS the choice; no
# cross-product of (split × region) to test or maintain.
#   LOWER_FOCUSED — 2× Lower per week, 1× Upper, balanced upper exposure
#   UPPER_FOCUSED — 2× Upper per week, 1× Lower, balanced lower exposure
SPLIT_LOWER_FOCUSED = "lower_focused"
SPLIT_UPPER_FOCUSED = "upper_focused"
SPLIT_ENDURANCE = "endurance"      # legacy endurance split id (kept for _day_meta lookup)
SPLIT_HYBRID = "hybrid"            # legacy athletic split id


_SPLIT_MIN_DAYS = {
    SPLIT_FULL_BODY:    1,
    SPLIT_UPPER_LOWER:  2,
    SPLIT_PPL:          3,
    SPLIT_BRO:          5,
    SPLIT_PPL_UL:       5,
    SPLIT_LOWER_FOCUSED: 3,
    SPLIT_UPPER_FOCUSED: 3,
    SPLIT_ENDURANCE:    1,
    SPLIT_HYBRID:       3,
}


# ─── Split selector (lifting subsystem) ─────────────────────────────


def pick_split(inputs, *, focused_muscle: Optional[str] = None) -> str:
    """Choose a training split from (days_per_week, goal_bucket,
    experience, priority_region, focused_muscle).

    Region-aware: when priority_region is lower_body or upper_body,
    the split selection biases toward structures with higher frequency
    for that region. Used by both the planner's auto-pick AND the
    split-options UI's is_recommended flag.

    Focus-aware: when `focused_muscle` resolves to a FocusProfile, the
    profile's `split_bias` nudges auto-selection. Explicit user
    split choice still wins.

    Deterministic — same inputs always return the same split."""
    if inputs.preferred_split and inputs.preferred_split != "auto":
        if _SPLIT_MIN_DAYS.get(inputs.preferred_split, 99) <= inputs.days_per_week:
            return inputs.preferred_split

    days = max(1, min(7, inputs.days_per_week or 3))
    bucket = goal_bucket(inputs.goal)
    experience = (inputs.experience or "intermediate").lower()

    # Resolve region priority for split biasing
    from .region_priority import normalize_region, split_region_bias
    region = normalize_region(
        getattr(inputs, "priority_region", None)
    )

    # Resolve focus profile. Explicit kwarg takes precedence over the
    # focused_muscle stored on the inputs dataclass.
    from .focus_profiles import get_focus_profile
    focus_id = focused_muscle if focused_muscle is not None else getattr(inputs, "focused_muscle", None)
    focus_profile = get_focus_profile(focus_id)

    if bucket == "endurance":
        return SPLIT_ENDURANCE
    if bucket == "athletic_performance" and days >= 3:
        return SPLIT_HYBRID

    if days <= 2:
        return SPLIT_FULL_BODY

    if experience == "beginner":
        if days <= 3:
            return SPLIT_FULL_BODY
        return SPLIT_UPPER_LOWER

    candidates = []
    for split_id, min_d in _SPLIT_MIN_DAYS.items():
        if split_id in (SPLIT_ENDURANCE, SPLIT_HYBRID):
            continue
        if days < min_d:
            continue
        score = _base_split_score(split_id, bucket, days, experience)
        score += split_region_bias(region, split_id)
        if focus_profile is not None:
            score += focus_profile.split_bias.get(split_id, 0)
        candidates.append((score, split_id))

    if not candidates:
        return SPLIT_FULL_BODY

    candidates.sort(key=lambda x: (-x[0], x[1]))
    return candidates[0][1]


def _base_split_score(split_id: str, bucket: str, days: int, experience: str) -> int:
    """Base split fitness score WITHOUT focus bias. Encodes the same
    preferences the old if/elif chain had, but as additive scores so
    focus bias can tip the result."""
    s = 0

    # Days-in-range bonuses
    if split_id == SPLIT_FULL_BODY:
        if days <= 3: s += 15
        elif days == 4: s += 5
        else: s -= 10
        if bucket in ("fat_loss", "general_health"): s += 10
        # At ≤3 days, full body gives 3x/week muscle frequency — far
        # better than PPL's 1x/week for hypertrophy goals.
        if days <= 3 and bucket == "muscle_gain": s += 12
    elif split_id == SPLIT_UPPER_LOWER:
        if days == 4: s += 20
        elif days == 5: s += 12
        elif days == 3: s += 8
        else: s += 3
        if bucket in ("body_recomp", "strength", "muscle_gain"): s += 8
    elif split_id == SPLIT_PPL:
        # PPL at 3 days = 1x/week per muscle — too low for muscle_gain.
        # Only boost PPL at 3 days for strength/body_recomp (not muscle_gain).
        if days == 3 and bucket in ("strength", "body_recomp"): s += 18
        elif days == 6: s += 20
        elif days == 4: s += 10
        elif days == 5: s += 8
        else: s += 3
        if bucket == "muscle_gain": s += 5
    elif split_id == SPLIT_PPL_UL:
        if days == 5 and bucket in ("muscle_gain", "body_recomp"): s += 22
        elif days == 5: s += 10
        else: s -= 5
    elif split_id == SPLIT_BRO:
        if days >= 5 and bucket == "muscle_gain" and experience == "advanced": s += 18
        elif experience != "advanced": s -= 15
        else: s += 3

    return s


# ─── Legacy split-driven naming (used by _day_meta when a split
#     id arrives from `pick_split` / `generate_weekly_recipe`) ───────


_ENDURANCE_DAY_KINDS = [
    "intervals", "steady", "intervals", "steady", "mixed", "steady", "steady",
]


_HYBRID_DAY_KINDS = [
    "upper_strength", "intervals", "lower_strength", "steady", "full_body",
    "intervals", "steady",
]


def _endurance_day_kind(day_index: int, total_days: int) -> str:
    """Endurance plans always include exactly ONE strength maintenance
    day per week (at 3+ days/week), placed at the END of the week so
    cardio days stay spaced out."""
    if total_days >= 3 and day_index == total_days - 1:
        return "strength"
    return _ENDURANCE_DAY_KINDS[day_index % len(_ENDURANCE_DAY_KINDS)]


def _day_meta(split: str, day_index: int, days_per_week: int = 0) -> tuple[str, str]:
    """Return `(display_name, focus_label)` for legacy split-driven
    callers (kept for `build_day_templates` + tests). New code built
    on archetypes uses `archetype_display_name()` instead."""
    if split == SPLIT_FULL_BODY:
        letters = ["A", "B", "C"]
        emphases = ["Squat & Press", "Hinge & Vertical", "Mixed Power"]
        i = day_index % 3
        return f"Full Body {letters[i]} — {emphases[i]}", "Full Body"

    if split == SPLIT_UPPER_LOWER:
        is_upper = (day_index % 2) == 0
        cycle_n = (day_index // 2) + 1
        if is_upper:
            upper_emph = ["Horizontal Push/Pull", "Vertical Push/Pull", "Balanced Push/Pull"]
            return f"Upper {cycle_n} — {upper_emph[(cycle_n - 1) % 3]}", "Upper"
        lower_emph = ["Squat Bias", "Hinge Bias", "Balanced Squat/Hinge"]
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


def _slots_for_day(split: str, day_index: int, days_per_week: int = 0) -> list[Slot]:
    """Legacy helper — returns the slot list for one day of a classic
    split. Kept for `build_day_templates` + existing tests. The
    multi-goal planner uses `archetype_to_slots` instead."""
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
            return _upper_slots(0)
        return _lower_slots(1)
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
    """Legacy helper: produce `[(display_name, slots), ...]` for a
    traditional split. Still used by existing unit tests. New code
    should build plans via `generate_weekly_recipe` + `archetype_to_slots`.
    """
    out: list[tuple[str, list[Slot]]] = []
    for i in range(days_per_week):
        name, _focus = _day_meta(split, i, days_per_week)
        slots = _slots_for_day(split, i, days_per_week)
        out.append((name, slots))
    return out


# ─── Archetype dispatch (primary planner path) ──────────────────────


def _strip_warmup_slots(slots: list[Slot], archetype) -> list[Slot]:
    """Remove the legacy warmup slot from lift/hybrid archetypes.

    Every `_*_slots()` builder emits a `Slot("Warmup Mobility", ...)` as
    the first entry. That slot accepted any mobility-pattern exercise,
    which users experienced as "I have a mobility drill on my heavy
    legs day" even though it was technically the warmup block.

    The set programming layer already generates warm-up sets on the
    primary compound (ramp-ups), so a dedicated warmup exercise is
    redundant for lift/hybrid days. We keep the warmup slot on
    MOBILITY_FLOW / STRETCH_BLOCK / RECOVERY_EASY — those days are
    supposed to be mobility-focused.
    """
    from .archetypes import ARCHETYPE_META as _META
    meta = _META.get(archetype)
    if not meta:
        return slots
    if meta.category in ("mobility", "recovery"):
        return slots
    return [s for s in slots if getattr(s, "role", None) != "warmup"]


def archetype_to_slots(
    archetype,
    day_index: int,
    days_per_week: int,
    *,
    focused_muscle: Optional[str] = None,
) -> list[Slot]:
    """Turn a `DayArchetype` into a concrete slot list.

    When `focused_muscle` resolves to a FocusProfile with a slot variant,
    lower-body archetypes route to the glute-biased variants (and upper
    archetypes route to chest/back/shoulder-biased variants). Focus
    arguments that don't have a matching variant fall back to the
    generic slot builder — callers never need to feature-flag.
    """
    from .archetypes import DayArchetype as _DA
    from .focus_profiles import get_focus_profile

    fp = get_focus_profile(focused_muscle)
    variant = fp.slot_variant if fp is not None else "default"

    if archetype == _DA.LIFT_FULL_BODY:
        if variant == "glute":
            return _full_body_glute_slots(day_index)
        return _full_body_slots(day_index)
    if archetype == _DA.LIFT_UPPER:
        ci = day_index // 2
        if variant == "chest":
            return _upper_chest_focus_slots(ci)
        if variant == "back":
            return _upper_back_focus_slots(ci)
        if variant == "shoulders":
            return _upper_shoulders_focus_slots(ci)
        return _upper_slots(ci)
    if archetype == _DA.LIFT_LOWER:
        if variant == "glute":
            return _lower_hypertrophy_glute_slots()
        return _lower_slots(day_index // 2)
    if archetype == _DA.LIFT_PUSH:
        return _push_slots()
    if archetype == _DA.LIFT_PULL:
        return _pull_slots()
    if archetype == _DA.LIFT_LEGS:
        if variant == "glute":
            return _legs_glute_slots()
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
        if variant == "glute":
            return _legs_heavy_glute_slots()
        return _BRO_SLOT_SEQUENCE[4]
    if archetype == _DA.LIFT_STRENGTH_MAINTENANCE:
        return _strength_maintenance_slots()

    # Stimulus-differentiated lifting
    if archetype == _DA.LIFT_UPPER_HEAVY:
        return _upper_heavy_slots()
    if archetype == _DA.LIFT_UPPER_HYPERTROPHY:
        if variant == "chest":
            return _upper_chest_focus_slots(0)
        if variant == "back":
            return _upper_back_focus_slots(0)
        if variant == "shoulders":
            return _upper_shoulders_focus_slots(0)
        return _upper_hypertrophy_slots()
    if archetype == _DA.LIFT_LOWER_HEAVY:
        if variant == "glute":
            return _lower_heavy_glute_slots()
        return _lower_heavy_slots()
    if archetype == _DA.LIFT_LOWER_HYPERTROPHY:
        if variant == "glute":
            return _lower_hypertrophy_glute_slots()
        return _lower_hypertrophy_slots()
    if archetype == _DA.LIFT_PUSH_HEAVY:
        return _push_heavy_slots()
    if archetype == _DA.LIFT_PULL_HEAVY:
        return _pull_heavy_slots()
    if archetype == _DA.LIFT_LEGS_HEAVY:
        if variant == "glute":
            return _legs_heavy_glute_slots()
        return _legs_heavy_slots()
    if archetype == _DA.LIFT_PUSH_VOLUME:
        return _push_volume_slots()
    if archetype == _DA.LIFT_PULL_VOLUME:
        return _pull_volume_slots()
    if archetype == _DA.LIFT_LEGS_VOLUME:
        if variant == "glute":
            return _legs_volume_glute_slots()
        return _legs_volume_slots()
    if archetype == _DA.LIFT_FULL_BODY_STRENGTH:
        return _full_body_strength_slots()

    # Conditioning
    if archetype == _DA.COND_ZONE2:
        return _cardio_steady_slots()
    if archetype == _DA.COND_INTERVALS_SHORT:
        return _cardio_intervals_slots()
    if archetype == _DA.COND_INTERVALS_LONG:
        return _cardio_intervals_slots()  # shares layout; prescription differs
    if archetype == _DA.COND_TEMPO:
        return _cardio_tempo_slots()
    if archetype == _DA.COND_MIXED:
        return _cardio_mixed_slots()
    if archetype == _DA.COND_SPRINT_POWER:
        return _cardio_sprint_power_slots()
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

    # Lift + same-day cardio
    if archetype == _DA.LIFT_PUSH_PLUS_CARDIO:
        return _push_plus_cardio_slots()
    if archetype == _DA.LIFT_PULL_PLUS_CARDIO:
        return _pull_plus_cardio_slots()
    if archetype == _DA.LIFT_UPPER_PLUS_CARDIO:
        ci = day_index // 2
        return _upper_plus_cardio_slots(ci)
    if archetype == _DA.LIFT_FULL_BODY_PLUS_CARDIO:
        return _full_body_plus_cardio_slots(day_index)

    # Unknown archetype — safe fallback to full body.
    return _full_body_slots(day_index)


# Wrap the dispatcher so every call goes through warmup-stripping.
_inner_archetype_to_slots = archetype_to_slots


def archetype_to_slots(  # noqa: F811 — intentional wrap
    archetype,
    day_index: int,
    days_per_week: int,
    *,
    focused_muscle: Optional[str] = None,
) -> list[Slot]:
    raw = _inner_archetype_to_slots(archetype, day_index, days_per_week, focused_muscle=focused_muscle)
    return _strip_warmup_slots(raw, archetype)


def archetype_display_name(archetype, day_index: int, recipe: list) -> str:
    """Build the user-facing day name for one archetype in the recipe.

    When the same archetype appears multiple times in the recipe
    (e.g. PPL over 4 days has two Push days), number them as
    "Push 1", "Push 2", etc. One-off archetypes stay unnumbered."""
    from .archetypes import ARCHETYPE_META
    base = ARCHETYPE_META[archetype].default_name
    seen_before = sum(1 for a in recipe[:day_index] if a == archetype)
    total = sum(1 for a in recipe if a == archetype)
    if total > 1:
        return f"{base} {seen_before + 1}"
    return base
