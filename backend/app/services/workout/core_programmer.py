"""Intentional core (trunk) programming.

Before this module, every lifting-day slot template appended a
`Slot("Core", "anti_extension", "core", "core")` at the end — same
pattern on every day, every user, every week. That produced random
ab work before heavy squats, blind repetition of the same category,
and "filler" direct-core on dense days where compounds already
taxed the trunk.

This module replaces that with a deliberate, goal-aware decision
pass that runs AFTER each day's slots are built:

  1. Target weekly core exposures based on goal + days/week.
  2. Per day: decide whether core fits cleanly. Skip heavy lower
     days, skip dense short sessions, skip days where recent trunk
     fatigue is already high.
  3. Rotate categories across the week (anti-extension, anti-rotation,
     lateral stability, flexion, posterior/carry) so the user isn't
     doing the same plank every session.
  4. Insert 1–3 core slots at the END of the chosen days.

Cardio logic is intentionally left untouched — this module only
concerns direct trunk work on lifting days + optional light
stability blocks on active-recovery days.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
import random

from .slots import Slot
from .archetypes import DayArchetype, ARCHETYPE_META, ARCHETYPE_TO_FOCUS_FAMILY

# ─── Categories ──────────────────────────────────────────────────────
# These map 1:1 to movement_patterns already seeded in
# `backend/app/seed_exercises_data.py`. The exercise-selection
# pipeline does movement_pattern matching per slot, so keeping these
# aligned with real seed values means no separate lookup table.

CAT_ANTI_EXTENSION      = "anti_extension"       # dead bug, plank, rollout
CAT_ANTI_ROTATION       = "anti_rotation"        # pallof, anti-rotation holds
CAT_LATERAL_STABILITY   = "lateral_stability"    # side plank, Copenhagen
CAT_FLEXION             = "flexion_lower_ab"     # reverse crunch, hanging leg/knee raise
CAT_POSTERIOR_BRACING   = "carry_bracing"        # loaded carries / bracing

ALL_CORE_CATEGORIES = [
    CAT_ANTI_EXTENSION,
    CAT_ANTI_ROTATION,
    CAT_LATERAL_STABILITY,
    CAT_FLEXION,
    CAT_POSTERIOR_BRACING,
]

# Default emphasis for most users — anti-extension / anti-rotation /
# lateral stability dominate. Flexion + posterior bracing are tools,
# not the whole strategy.
DEFAULT_ROTATION = [
    CAT_ANTI_EXTENSION,
    CAT_ANTI_ROTATION,
    CAT_LATERAL_STABILITY,
    CAT_POSTERIOR_BRACING,
    CAT_FLEXION,
]

_HIGH_CORE_CIRCUIT_GOALS = frozenset({
    "fat_loss",
    "endurance",
    "athletic_performance",
    "hyrox",
    "body_recomp",
})

# Movement_pattern each category maps to at slot-build time. The
# exercise picker already resolves these against seed data.
_CATEGORY_TO_MOVEMENT: dict[str, str] = {
    CAT_ANTI_EXTENSION:     "anti_extension",
    CAT_ANTI_ROTATION:      "anti_rotation",
    # The seed library currently tags side-plank-style drills under
    # anti_extension, so lateral slots route through that pattern and
    # are narrowed to true lateral-stability candidates later.
    CAT_LATERAL_STABILITY:  "anti_extension",
    CAT_FLEXION:            "flexion",
    CAT_POSTERIOR_BRACING:  "carry",
}

# Human-readable slot label per category.
_CATEGORY_TO_LABEL: dict[str, str] = {
    CAT_ANTI_EXTENSION:     "Core — Anti-Extension",
    CAT_ANTI_ROTATION:      "Core — Anti-Rotation",
    CAT_LATERAL_STABILITY:  "Core — Lateral Stability",
    CAT_FLEXION:            "Core — Lower Ab",
    CAT_POSTERIOR_BRACING:  "Core — Carry / Bracing",
}


# ─── Weekly frequency targets ────────────────────────────────────────
# goal_bucket × days_per_week → (min, default, max) direct-core
# exposures per week. Matches the "CORE FREQUENCY BY GOAL /
# TRAINING DAYS" matrix from the spec.

@dataclass(frozen=True)
class CoreFrequency:
    low: int
    default: int
    high: int


_GOAL_DAYS_FREQUENCY: dict[tuple[str, int], CoreFrequency] = {
    # muscle_gain
    ("muscle_gain", 3): CoreFrequency(1, 2, 2),
    ("muscle_gain", 4): CoreFrequency(2, 2, 2),
    ("muscle_gain", 5): CoreFrequency(2, 2, 2),
    ("muscle_gain", 6): CoreFrequency(2, 2, 2),
    ("muscle_gain", 7): CoreFrequency(2, 2, 3),
    # strength
    ("strength", 3):    CoreFrequency(1, 2, 2),
    ("strength", 4):    CoreFrequency(2, 2, 2),
    ("strength", 5):    CoreFrequency(2, 2, 2),
    ("strength", 6):    CoreFrequency(2, 2, 2),
    ("strength", 7):    CoreFrequency(2, 2, 3),
    # body_recomp
    ("body_recomp", 3): CoreFrequency(2, 2, 2),
    ("body_recomp", 4): CoreFrequency(2, 2, 3),
    ("body_recomp", 5): CoreFrequency(2, 3, 3),
    ("body_recomp", 6): CoreFrequency(2, 3, 3),
    ("body_recomp", 7): CoreFrequency(2, 3, 3),
    # fat_loss
    ("fat_loss", 3):    CoreFrequency(2, 2, 2),
    ("fat_loss", 4):    CoreFrequency(2, 3, 3),
    ("fat_loss", 5):    CoreFrequency(2, 3, 3),
    ("fat_loss", 6):    CoreFrequency(3, 3, 3),
    ("fat_loss", 7):    CoreFrequency(3, 3, 3),
    ("toning", 3):      CoreFrequency(2, 2, 2),
    ("toning", 4):      CoreFrequency(2, 3, 3),
    ("toning", 5):      CoreFrequency(2, 3, 3),
    ("toning", 6):      CoreFrequency(3, 3, 3),
    ("toning", 7):      CoreFrequency(3, 3, 3),
    # endurance / athletic / hyrox — trunk endurance + anti-rotation focus
    ("endurance", 3):             CoreFrequency(2, 2, 2),
    ("endurance", 4):             CoreFrequency(2, 2, 3),
    ("endurance", 5):             CoreFrequency(2, 3, 3),
    ("endurance", 6):             CoreFrequency(3, 3, 3),
    ("endurance", 7):             CoreFrequency(2, 3, 3),
    ("athletic_performance", 3):  CoreFrequency(2, 2, 2),
    ("athletic_performance", 4):  CoreFrequency(2, 2, 3),
    ("athletic_performance", 5):  CoreFrequency(2, 3, 3),
    ("athletic_performance", 6):  CoreFrequency(3, 3, 3),
    ("athletic_performance", 7):  CoreFrequency(2, 3, 3),
    ("hyrox", 3):                 CoreFrequency(2, 2, 2),
    ("hyrox", 4):                 CoreFrequency(2, 2, 3),
    ("hyrox", 5):                 CoreFrequency(2, 3, 3),
    ("hyrox", 6):                 CoreFrequency(3, 3, 3),
    ("hyrox", 7):                 CoreFrequency(2, 3, 3),
    # general_health / longevity — sustainable, joint-friendly
    ("general_health", 3):  CoreFrequency(1, 2, 2),
    ("general_health", 4):  CoreFrequency(2, 2, 2),
    ("general_health", 5):  CoreFrequency(2, 2, 3),
    ("general_health", 6):  CoreFrequency(2, 3, 3),
    ("general_health", 7):  CoreFrequency(2, 3, 3),
    ("longevity", 3):       CoreFrequency(1, 2, 2),
    ("longevity", 4):       CoreFrequency(2, 2, 2),
    ("longevity", 5):       CoreFrequency(2, 2, 3),
    ("longevity", 6):       CoreFrequency(2, 3, 3),
    ("longevity", 7):       CoreFrequency(2, 3, 3),
    ("maintain", 3):        CoreFrequency(1, 2, 2),
    ("maintain", 4):        CoreFrequency(2, 2, 2),
    ("maintain", 5):        CoreFrequency(2, 2, 2),
    ("maintain", 6):        CoreFrequency(2, 3, 3),
    ("maintain", 7):        CoreFrequency(2, 3, 3),
    # Special mobility/recovery planner modes currently flow through
    # `GoalProfile.bucket == "general_health"` in the full planner.
    # Keep direct helper calls explicit and aligned with that traced
    # behavior: these are targets only, with actual direct core often
    # lower because the recipes are mostly cardio/mobility/recovery.
    ("flexibility", 3):     CoreFrequency(1, 2, 2),
    ("flexibility", 4):     CoreFrequency(2, 2, 2),
    ("flexibility", 5):     CoreFrequency(2, 2, 3),
    ("flexibility", 6):     CoreFrequency(2, 3, 3),
    ("flexibility", 7):     CoreFrequency(2, 3, 3),
    ("stress_relief", 3):   CoreFrequency(1, 2, 2),
    ("stress_relief", 4):   CoreFrequency(2, 2, 2),
    ("stress_relief", 5):   CoreFrequency(2, 2, 3),
    ("stress_relief", 6):   CoreFrequency(2, 3, 3),
    ("stress_relief", 7):   CoreFrequency(2, 3, 3),
}


def weekly_core_target(goal: str, days_per_week: int) -> CoreFrequency:
    """Look up the goal×days target. Falls back to `muscle_gain`
    (the most common case) when the goal bucket isn't in the table."""
    days = max(3, min(7, int(days_per_week or 4)))
    if (goal, days) in _GOAL_DAYS_FREQUENCY:
        return _GOAL_DAYS_FREQUENCY[(goal, days)]
    return _GOAL_DAYS_FREQUENCY.get(("muscle_gain", days),
                                    CoreFrequency(1, 2, 2))


# ─── Day-type matching ───────────────────────────────────────────────

# Which categories fit which day type best. Multiple categories are
# offered so the weekly rotation has room to avoid repeats.
_DAY_CATEGORY_PREFERENCE: dict[str, list[str]] = {
    "push": [
        CAT_ANTI_EXTENSION,
        CAT_FLEXION,            # lower ab pairs well with horizontal press
        CAT_POSTERIOR_BRACING,  # brief carries
    ],
    "pull": [
        CAT_ANTI_ROTATION,
        CAT_LATERAL_STABILITY,
        CAT_POSTERIOR_BRACING,  # carries
    ],
    "upper": [
        CAT_ANTI_ROTATION,
        CAT_ANTI_EXTENSION,
        CAT_LATERAL_STABILITY,
    ],
    "full_body": [
        CAT_ANTI_EXTENSION,
        CAT_ANTI_ROTATION,
        CAT_POSTERIOR_BRACING,
    ],
    # "legs"/"lower" intentionally absent — we generally skip direct
    # core on heavy-lower days. When we DO include (on a lighter leg
    # variant), only bracing-minimal options qualify.
    "legs_light_only": [
        CAT_POSTERIOR_BRACING,  # carries are the safest add-on
    ],
    # Active recovery days get only the gentlest options.
    "recovery": [
        CAT_LATERAL_STABILITY,
        CAT_ANTI_EXTENSION,     # dead bug, bird dog — low intensity
    ],
}


# Archetypes where direct core is a hard NO. Heavy lower-body and
# anything explicitly "heavy" loads the trunk already; a pre-lift
# ab circuit degrades main-lift quality.
_NEVER_CORE_ARCHETYPES: set[DayArchetype] = {
    DayArchetype.LIFT_LEGS,
    DayArchetype.LIFT_LEGS_HEAVY,
    DayArchetype.LIFT_LEGS_VOLUME,
    DayArchetype.LIFT_LOWER,
    DayArchetype.LIFT_LOWER_HEAVY,
    DayArchetype.LIFT_LOWER_HYPERTROPHY,
    DayArchetype.LIFT_FULL_BODY_STRENGTH,  # heavy compounds — skip direct core
}


# Map focus_family → day-type key for _DAY_CATEGORY_PREFERENCE.
# Explicit mapping avoids fragile substring scanning of archetype names.
_FOCUS_FAMILY_TO_DAY_TYPE: dict[str, Optional[str]] = {
    "push": "push",
    "pull": "pull",
    "upper": "upper",
    "lower": "legs_light_only",
    "legs": "legs_light_only",
    "full_body": "full_body",
    "cardio": None,
    "mobility": None,
    "recovery": None,
}


def _day_type_for_archetype(archetype: DayArchetype) -> Optional[str]:
    """Map archetype → day-type key used by _DAY_CATEGORY_PREFERENCE.
    Returns None for archetypes where direct core shouldn't appear at
    all (cardio, mobility, heavy lower — caller should skip)."""
    if archetype in _NEVER_CORE_ARCHETYPES:
        return None
    meta = ARCHETYPE_META.get(archetype)
    if meta and meta.category in ("cond", "mobility", "recovery"):
        return None
    family = ARCHETYPE_TO_FOCUS_FAMILY.get(archetype)
    if family:
        return _FOCUS_FAMILY_TO_DAY_TYPE.get(family)
    # Fallback: shouldn't happen if ARCHETYPE_TO_FOCUS_FAMILY is complete
    return None


# ─── Duration buckets ────────────────────────────────────────────────

def _duration_bucket(session_minutes: Optional[int]) -> str:
    m = int(session_minutes or 60)
    if m <= 30: return "short"
    if m <= 60: return "medium"
    return "long"


def _core_exercise_count(bucket: str, goal: str) -> int:
    """How many direct core slots to emit on a qualifying day."""
    if bucket == "short":
        # SHORT sessions: usually skip. If we did enter this path the
        # caller already decided this day qualifies — still hold to
        # 1 exercise so main work isn't displaced.
        return 1
    if bucket == "medium":
        if goal in _HIGH_CORE_CIRCUIT_GOALS:
            return 2
        return 1
    # Long sessions: high core-endurance goals get a real 3-move
    # circuit. Other goals keep direct trunk work minimal.
    if goal in _HIGH_CORE_CIRCUIT_GOALS:
        return 3
    return 1


# ─── Public API ──────────────────────────────────────────────────────

def build_core_slot(category: str) -> Slot:
    """Turn a category name into a Slot row for the exercise picker.
    The picker resolves `movement_pattern` against the seeded catalog."""
    return Slot(
        label=_CATEGORY_TO_LABEL[category],
        movement_pattern=_CATEGORY_TO_MOVEMENT[category],
        primary_muscle_hint="core",
        role="core",
    )


def _category_from_slot_label(label: str | None) -> Optional[str]:
    text = (label or "").lower()
    if "anti-extension" in text:
        return CAT_ANTI_EXTENSION
    if "anti-rotation" in text:
        return CAT_ANTI_ROTATION
    if "lateral stability" in text:
        return CAT_LATERAL_STABILITY
    if "lower ab" in text or "flexion" in text:
        return CAT_FLEXION
    if "carry" in text or "bracing" in text:
        return CAT_POSTERIOR_BRACING
    return None


def core_slot_accepts_exercise(slot: Slot, exercise: dict) -> bool:
    """Reject broad movement-pattern matches that don't fit the core slot."""
    category = _category_from_slot_label(getattr(slot, "label", None))
    if category is None:
        return (exercise.get("primary_muscle") or "").lower() == "core"

    primary = (exercise.get("primary_muscle") or "").lower()
    movement = (exercise.get("movement_pattern") or "").lower()
    name = (exercise.get("name") or "").lower()
    slug = (exercise.get("slug") or "").lower()

    if category == CAT_POSTERIOR_BRACING:
        if movement != "carry":
            return False
        return primary in {"core", "full_body"} or "carry" in name

    if primary != "core":
        return False

    if category == CAT_ANTI_EXTENSION:
        if movement != "anti_extension":
            return False
        banned_terms = ("side plank", "copenhagen", "superman", "back extension")
        return not any(term in name for term in banned_terms)

    if category == CAT_ANTI_ROTATION:
        return movement == "anti_rotation"

    if category == CAT_LATERAL_STABILITY:
        return slug == "copenhagen_plank" or slug.startswith("side_plank")

    if category == CAT_FLEXION:
        return movement == "flexion"

    return False


def core_slot_score_bonus(slot: Slot, exercise: dict) -> float:
    """Nudge valid core candidates toward the most natural category fit."""
    category = _category_from_slot_label(getattr(slot, "label", None))
    if category is None:
        return 0.0

    name = (exercise.get("name") or "").lower()
    slug = (exercise.get("slug") or "").lower()
    tracking = (exercise.get("default_tracking_mode") or "").lower()

    if category == CAT_ANTI_EXTENSION:
        if any(term in name for term in ("dead bug", "plank", "rollout", "fallout", "hollow", "stir-the-pot", "body saw")):
            return 2.5
        if tracking == "time":
            return 1.0
        return 0.0

    if category == CAT_ANTI_ROTATION:
        if "pallof" in name:
            return 2.5
        if "shoulder tap" in name or "plank reach" in name:
            return 1.5
        if tracking == "time":
            return 1.0
        return 0.0

    if category == CAT_LATERAL_STABILITY:
        if slug == "side_plank":
            return 3.0
        if slug.startswith("side_plank"):
            return 2.75
        if slug == "copenhagen_plank":
            return 2.5
        return 0.0

    if category == CAT_FLEXION:
        if any(term in name for term in (
            "leg raise", "leg lower", "knee raise", "reverse crunch",
            "sit-up", "v-up", "toes-to-bar", "crunch", "curl-up",
            "flutter", "scissor", "heel tap", "toe touch",
        )):
            return 2.5
        return 1.0

    if category == CAT_POSTERIOR_BRACING:
        if "suitcase carry" in name:
            return 3.0
        if "farmer carry" in name or "sandbag carry" in name:
            return 2.0
        return 0.5

    return 0.0


@dataclass
class CoreDecision:
    """Output of the per-day decision pass."""
    add: bool
    category: Optional[str]   # None when add=False
    count: int                # number of exercises to append
    reason: str               # diagnostic string for logs
    categories: tuple[str, ...] = ()
    # Circuit structure hints passed to the prescriber so it can emit
    # round-based prescriptions instead of generic strength sets.
    rounds: int = 3           # target rounds per exercise
    work_seconds: int = 0     # 0 = reps-based; >0 = timed work bout
    rest_seconds: int = 45    # rest between exercises within the circuit


@dataclass(frozen=True)
class CoreProgrammingSummary:
    target_core_days: int
    actual_core_days_generated: int
    core_skip_reasons: tuple[str, ...]
    core_skip_reason_counts: tuple[tuple[str, int], ...] = ()


def _is_session_dense(slots_count: int, session_minutes: Optional[int]) -> bool:
    """Heuristic: a session is dense when it already has enough slots
    to fill its time budget. Adding core on top of a maxed-out
    template crowds out main work.

    Thresholds keep 45-60 minute lift days from stacking direct-core
    on top of already full templates; longer sessions still have room
    for the dedicated core pass."""
    m = int(session_minutes or 60)
    if m <= 30: return slots_count >= 6
    if m <= 45: return slots_count >= 8
    if m <= 60: return slots_count >= 7
    return slots_count >= 10


def _dedupe_categories(categories: list[str]) -> list[str]:
    out: list[str] = []
    for category in categories:
        if category not in out:
            out.append(category)
    return out


def _ordered_categories(
    *,
    prefs: list[str],
    recent_core_categories: list[str],
    hip_flexor_recent: bool,
) -> list[str]:
    """Return category candidates in best-to-worst order for this day.

    `recent_core_categories` represents the last couple of core
    sessions, not the entire week. Repeated categories are still usable
    as a fallback, but loaded carries are pushed behind every other
    option when they appeared recently so users don't see carry-heavy
    core blocks in close succession.
    """
    base = _dedupe_categories([*prefs, *DEFAULT_ROTATION])
    recent = set(recent_core_categories)
    fresh = [c for c in base if c not in recent]
    ordered = fresh + [c for c in base if c not in fresh]

    # Avoid stacking hip-flexor-heavy work when the recent window had
    # it. Flexion (hanging leg raise, reverse crunch) and strict
    # anti-extension rollouts both pull the hip flexors. When the user
    # had any of those recently, bias toward anti-rotation or lateral
    # stability instead.
    if hip_flexor_recent:
        hip_flexor_categories = (CAT_FLEXION, CAT_ANTI_EXTENSION)
        ordered = [c for c in ordered if c not in hip_flexor_categories] + \
                  [c for c in ordered if c in hip_flexor_categories]

    if CAT_POSTERIOR_BRACING in recent:
        ordered = [c for c in ordered if c != CAT_POSTERIOR_BRACING] + \
                  [CAT_POSTERIOR_BRACING]

    return _dedupe_categories(ordered)


def _pick_circuit_categories(ordered: list[str], count: int) -> tuple[str, ...]:
    """Pick distinct categories for one core circuit.

    The old implementation duplicated one slot category N times. That
    let a "Carry / Bracing" circuit become Suitcase Carry immediately
    followed by Farmer Carry. A circuit should mix demands instead.
    """
    picked: list[str] = []
    for category in ordered:
        if category in picked:
            continue
        picked.append(category)
        if len(picked) >= count:
            break
    return tuple(picked)


def decide_core_for_day(
    *,
    archetype: DayArchetype,
    slots_count: int,
    session_minutes: Optional[int],
    goal: str,
    recent_core_categories: list[str],
    hip_flexor_recent: bool,
    is_recovery_day: bool,
    remaining_weekly_budget: int,
) -> CoreDecision:
    """Core-placement decision for one day. Runs AFTER the main
    session slots are built.

    Rules (in order):
      1. If the archetype is in `_NEVER_CORE_ARCHETYPES`, skip
         (heavy lower, heavy full-body — trunk already taxed).
      2. If the session is SHORT (<=30 min) and goal isn't fat_loss
         / endurance, skip so main work isn't crowded out.
      3. If the weekly budget is exhausted, skip.
      4. If the session is dense, skip.
      5. Otherwise pick a category that (a) fits the day type and
         (b) hasn't been used in the last 2 sessions.
    """
    if archetype in _NEVER_CORE_ARCHETYPES:
        family = ARCHETYPE_TO_FOCUS_FAMILY.get(archetype)
        if family in ("lower", "legs"):
            reason = "heavy_lower" if "heavy" in archetype.value else "lower_day"
        else:
            reason = "incompatible_archetype"
        return CoreDecision(False, None, 0, reason)

    day_type = _day_type_for_archetype(archetype)
    if day_type is None and not is_recovery_day:
        return CoreDecision(False, None, 0, "incompatible_archetype")

    if remaining_weekly_budget <= 0:
        return CoreDecision(False, None, 0, "weekly_budget_met")

    bucket = _duration_bucket(session_minutes)
    if bucket == "short" and goal not in ("fat_loss", "endurance", "athletic_performance", "hyrox"):
        return CoreDecision(False, None, 0, "time_cap")

    if _is_session_dense(slots_count, session_minutes):
        return CoreDecision(False, None, 0, "session_density")

    # Pick categories. Preference list tailored to the day type, with
    # recently-used categories pushed to the back so we rotate.
    if is_recovery_day:
        prefs = _DAY_CATEGORY_PREFERENCE.get("recovery", DEFAULT_ROTATION)
    else:
        prefs = _DAY_CATEGORY_PREFERENCE.get(day_type or "upper", DEFAULT_ROTATION)

    ordered = _ordered_categories(
        prefs=prefs,
        recent_core_categories=recent_core_categories,
        hip_flexor_recent=hip_flexor_recent,
    )

    if not ordered:
        return CoreDecision(False, None, 0, "no_category_available")

    count = _core_exercise_count(bucket, goal)
    # Recovery days stay minimal regardless of bucket.
    if is_recovery_day:
        count = 1
    categories = _pick_circuit_categories(ordered, count)
    if not categories:
        return CoreDecision(False, None, 0, "no_category_available")

    return CoreDecision(
        True, categories[0], len(categories),
        f"ok:day={day_type},bucket={bucket},cats={','.join(categories)}",
        categories=categories,
    )


def program_core_across_week(
    *,
    templates: list[tuple[str, Optional[list[Slot]], DayArchetype, Optional[dict]]],
    goal: str,
    days_per_week: int,
    session_minutes: Optional[int],
    seed: int = 0,
    return_summary: bool = False,
) -> list[tuple[str, Optional[list[Slot]], DayArchetype, Optional[dict]]] | tuple[
    list[tuple[str, Optional[list[Slot]], DayArchetype, Optional[dict]]],
    CoreProgrammingSummary,
]:
    """Top-level: walk the week and append core slots to whichever
    days qualify. Returns a new templates list with the same shape so
    callers can swap it in without other changes.

    Strategy:
      - Compute weekly budget (default from goal×days table).
      - For each day, ask decide_core_for_day.
      - Track categories used so far + whether hip-flexor work
        happened recently (last 2 days).
      - Emit core slots at the END of each chosen day's slot list
        (placement rule: core is ALWAYS terminal, never mid-session).
      - When return_summary=True, also return target vs actual direct
        core days plus skip reasons explaining intentional shortfalls.
    """
    freq = weekly_core_target(goal, days_per_week)
    remaining_budget = freq.default
    used_category_sessions: list[tuple[str, ...]] = []
    rng = random.Random(seed)
    actual_core_days_generated = 0
    skip_reason_counts: dict[str, int] = {}

    def _record_skip(reason: str) -> None:
        if remaining_budget <= 0 or reason == "weekly_budget_met":
            return
        skip_reason_counts[reason] = skip_reason_counts.get(reason, 0) + 1

    out: list = []
    for (name, slots, archetype, gen_day) in templates:
        if slots is None:
            # Pre-generated day (recovery/mobility). Don't inject
            # slots — they bypass the slot pipeline entirely. Carry
            # through untouched.
            _record_skip("incompatible_archetype")
            out.append((name, slots, archetype, gen_day))
            continue

        recent_categories = [
            c
            for session_categories in used_category_sessions[-2:]
            for c in session_categories
        ]
        # Recent hip-flexor flag: look at the last 2 core sessions.
        recent_hf = any(c in (CAT_FLEXION, CAT_ANTI_EXTENSION)
                        for c in recent_categories)

        decision = decide_core_for_day(
            archetype=archetype,
            slots_count=len(slots),
            session_minutes=session_minutes,
            goal=goal,
            recent_core_categories=recent_categories,
            hip_flexor_recent=recent_hf,
            is_recovery_day=False,
            remaining_weekly_budget=remaining_budget,
        )

        if decision.add and decision.categories:
            core_slots = [build_core_slot(category) for category in decision.categories]
            new_slots = list(slots) + core_slots
            out.append((name, new_slots, archetype, gen_day))
            used_category_sessions.append(decision.categories)
            remaining_budget -= 1
            actual_core_days_generated += 1
        else:
            _record_skip(decision.reason)
            out.append((name, slots, archetype, gen_day))

    _ = rng  # reserved for future randomized tie-breaking
    if return_summary:
        ordered_counts = tuple(
            sorted(skip_reason_counts.items(), key=lambda item: item[0])
        )
        summary = CoreProgrammingSummary(
            target_core_days=freq.default,
            actual_core_days_generated=actual_core_days_generated,
            core_skip_reasons=tuple(reason for reason, _ in ordered_counts),
            core_skip_reason_counts=ordered_counts,
        )
        return out, summary
    return out
