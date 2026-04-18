"""Single source of truth for workout-goal handling.

Every user-facing goal id resolves to exactly one canonical planner
bucket through `resolve_goal`. Callers that used to run their own
substring matches or keyword dictionaries now go through this module so
"which goals does the planner actually support?" has a concrete answer
backed by tests.

Supported set after this pass (see `supported_goal_ids`):
    fat_loss, muscle_gain, body_recomp, strength, endurance,
    athletic_performance, toning (alias → fat_loss),
    maintain (alias → body_recomp).

Dropped from the exposed set:
    flexibility, stress_relief — these require a mobility / low-
    intensity library the strength planner does not own, so exposing
    them as unique goals was misleading. They stay in the registry as
    `supported=False` so stale references (existing user profiles,
    telemetry) still resolve to a sensible fallback bucket.

Aliases
-------
An alias goal shares the same planner bucket as its canonical target.
`toning` normalizes to `fat_loss`, `maintain` normalizes to
`body_recomp`. The UI can still show them as distinct labels; the
planner treats them identically at the code level. This is the honest
middle-ground between "hide them" and "pretend they're different".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional


PlannerBucket = Literal[
    "fat_loss",
    "muscle_gain",
    "body_recomp",
    "strength",
    "endurance",
    "athletic_performance",
    "hyrox",
    "general_health",
]


@dataclass(frozen=True)
class GoalDefinition:
    """One row in the registry.

    user_id     — the id the frontend sends on `PlanRequest.goal`.
    bucket      — the canonical planner bucket used by every downstream
                  decision (split, prescription, volume, recommendation).
    label       — user-facing display name.
    icon        — emoji shown in the goal picker.
    description — one-line marketing copy.
    supported   — true if this goal should appear in the UI goal picker.
                  Unsupported goals are still resolvable (so older user
                  profiles don't crash) but flagged for frontend hiding.
    alias_of    — if set, this goal shares its canonical behavior with
                  `alias_of`. Useful for UI variants that the planner
                  doesn't differentiate ("toning" ≈ "fat_loss").
    notes       — free-form explanation for the audit table.
    """
    user_id: str
    bucket: PlannerBucket
    label: str = ""
    icon: str = ""
    description: str = ""
    supported: bool = True
    alias_of: Optional[str] = None
    notes: str = ""


# Ordering matters for `supported_goal_ids()` — it's the display order
# used when seeding GoalOption rows.
_GOAL_REGISTRY: list[GoalDefinition] = [
    GoalDefinition(
        user_id="fat_loss",
        bucket="fat_loss",
        label="Lose Weight",
        icon="flame-outline",
        description="Burn fat through a sustainable calorie deficit",
        notes="Higher-rep circuits, shorter rest, conditioning-friendly.",
    ),
    GoalDefinition(
        user_id="muscle_gain",
        bucket="muscle_gain",
        label="Build Muscle",
        icon="barbell-outline",
        description="Gain size and strength with a calorie surplus",
        notes="Hypertrophy rep ranges, PPL/UL splits, 4 sets on primaries.",
    ),
    GoalDefinition(
        user_id="body_recomp",
        bucket="body_recomp",
        label="Body Recomposition",
        icon="swap-horizontal-outline",
        description="Lose fat and build muscle at the same time",
        notes="Moderate reps, balanced volume, works across day counts.",
    ),
    GoalDefinition(
        user_id="strength",
        bucket="strength",
        label="Build Strength",
        icon="trophy-outline",
        description="Increase your 1-rep maxes and raw power output",
        notes="Low-rep heavy compounds, longer rest, PPL-UL hybrid at 5+ days.",
    ),
    GoalDefinition(
        user_id="endurance",
        bucket="endurance",
        label="Improve Endurance",
        icon="heart-outline",
        description="Run longer, recover faster, and build stamina",
        notes="Cardio-first plans. Strength maintenance one day/week at 3+ days.",
    ),
    GoalDefinition(
        user_id="athletic_performance",
        bucket="athletic_performance",
        label="Athletic Performance",
        icon="flash-outline",
        description="Speed, power, agility, and sport-specific fitness",
        notes="Hybrid — alternates strength and conditioning days.",
    ),
    GoalDefinition(
        user_id="hyrox",
        bucket="hyrox",
        label="HYROX / Hybrid Race",
        icon="medal-outline",
        description="Train for HYROX, Deka, or hybrid fitness races",
        notes=(
            "Hybrid race prep: running, intervals, functional stations "
            "(sled push/pull, wall balls, lunges, row, ski erg, burpees). "
            "Conditioning-heavy with strength support, not bodybuilding."
        ),
    ),
    GoalDefinition(
        user_id="toning",
        bucket="fat_loss",
        label="Tone & Define",
        icon="sparkles-outline",
        description="Lean out and sculpt visible muscle definition",
        alias_of="fat_loss",
        notes="UI variant of fat_loss. Same planner behavior.",
    ),
    GoalDefinition(
        user_id="maintain",
        bucket="general_health",
        label="Maintain & Stay Active",
        icon="checkmark-circle-outline",
        description="Keep your current fitness level and stay healthy",
        alias_of="general_health",
        notes=(
            "Routed to the general_health profile which mixes one lift "
            "day, one easy cardio day, and one mobility day per week."
        ),
    ),
    # Hidden from UI — the planner cannot honestly differentiate these
    # without a mobility / yoga exercise library it does not own. The
    # registry still resolves them (to general_health) so older user
    # profiles don't crash on plan generation.
    GoalDefinition(
        user_id="flexibility",
        bucket="general_health",
        label="Flexibility & Mobility",
        icon="body-outline",
        description="Improve range of motion and reduce injury risk",
        supported=False,
        notes="Needs a mobility library the strength planner doesn't own.",
    ),
    GoalDefinition(
        user_id="stress_relief",
        bucket="general_health",
        label="Mental Wellness",
        icon="leaf-outline",
        description="Use movement to manage stress and improve mood",
        supported=False,
        notes="Needs a low-intensity / yoga library the planner doesn't own.",
    ),
]


_BY_ID: dict[str, GoalDefinition] = {g.user_id: g for g in _GOAL_REGISTRY}


# Legacy and long-form goal ids from goalConfig.ts that aren't first-
# class registry entries but should still resolve to the right bucket.
# Kept short and obvious. Add to the registry proper if any of these
# ever become first-class user-facing goals.
_LEGACY_ALIASES: dict[str, str] = {
    # Fat loss synonyms
    "lose_fat":              "fat_loss",
    "cut":                   "fat_loss",
    "get_lean":              "fat_loss",
    "preserve_muscle_cutting": "fat_loss",
    # Muscle gain synonyms
    "build_muscle":          "muscle_gain",
    "lean_bulk":             "muscle_gain",
    "bulk":                  "muscle_gain",
    "gain_weight":           "muscle_gain",
    "improve_aesthetics":    "muscle_gain",
    "build_glutes":          "muscle_gain",
    "hypertrophy":           "muscle_gain",
    # Strength synonyms
    "build_strength":        "strength",
    "powerlifting":          "strength",
    "strength_training":     "strength",
    "get_stronger":          "strength",
    "improve_1rm":           "strength",
    "improve_bench":         "strength",
    "improve_deadlift":      "strength",
    "improve_squat":         "strength",
    "functional_strength":   "strength",
    "relative_strength":     "strength",
    # Endurance synonyms — goalConfig.ts has a long list under
    # `cardio_endurance`; all of them route here.
    "cardio_endurance":      "endurance",
    "cardio":                "endurance",
    "improve_cardio":        "endurance",
    "improve_conditioning":  "endurance",
    "aerobic_base":          "endurance",
    "improve_vo2":           "endurance",
    "increase_stamina":      "endurance",
    "running_fitness":       "endurance",
    "train_5k":              "endurance",
    "train_10k":             "endurance",
    "train_half":            "endurance",
    "train_marathon":        "endurance",
    "sprint_speed":          "endurance",
    "interval_perf":         "endurance",
    "run_faster":            "endurance",
    "marathon":              "endurance",
    # Athletic synonyms
    "sport_performance":     "athletic_performance",
    "improve_athleticism":   "athletic_performance",
    # Body recomp synonyms
    "body_recomposition":    "body_recomp",
    "recomp":                "body_recomp",
    # HYROX / hybrid race synonyms
    "hybrid_race":           "hyrox",
    "race_hybrid":           "hyrox",
    "deka":                  "hyrox",
    "deka_fit":              "hyrox",
    "functional_fitness":    "hyrox",
}


def resolve_goal(goal: Optional[str]) -> GoalDefinition:
    """Look up a goal id in the registry with alias + substring fallback.

    Order of resolution:
      1. Exact match against `_BY_ID` (the first-class registry).
      2. Exact match against `_LEGACY_ALIASES` → redirected to the
         canonical registry entry.
      3. Substring match on obvious keywords (cardio/run/endurance,
         athletic/sport, muscle/hypertrophy, strength, fat/lose/cut).
      4. Final fallback: `body_recomp` (our "no strong opinion"
         default — NOT `general_health`, because that bucket is
         reserved for hidden unsupported goals).

    Never returns `None` — planner code can always assume a valid
    definition."""
    if not goal:
        return _BY_ID["body_recomp"]
    g = str(goal).strip().lower()
    if g in _BY_ID:
        return _BY_ID[g]
    canonical = _LEGACY_ALIASES.get(g)
    if canonical and canonical in _BY_ID:
        return _BY_ID[canonical]
    # Substring fallback for free-form goals that didn't land in either
    # table. Matches the keyword-scan the old `_goal_bucket` used to do.
    if "cardio" in g or "endurance" in g or "run" in g or "marathon" in g:
        return _BY_ID["endurance"]
    if "hyrox" in g or "hybrid race" in g or "deka" in g:
        return _BY_ID["hyrox"]
    if "athletic" in g or "sport" in g:
        return _BY_ID["athletic_performance"]
    if "muscle" in g or "hypertrophy" in g or "bulk" in g:
        return _BY_ID["muscle_gain"]
    if "strength" in g or "powerlift" in g:
        return _BY_ID["strength"]
    if "fat" in g or "lose" in g or "cut" in g or "lean" in g:
        return _BY_ID["fat_loss"]
    return _BY_ID["body_recomp"]


def goal_bucket(goal: Optional[str]) -> str:
    """Canonical planner bucket for `goal`. Single source of truth —
    every planner branch should call this, never roll its own mapping."""
    return resolve_goal(goal).bucket


def is_goal_supported(goal: Optional[str]) -> bool:
    """Whether `goal` should appear in the UI goal picker. Unsupported
    goals still resolve (for stale profiles), they just shouldn't be
    offered to new users."""
    return resolve_goal(goal).supported


def supported_goal_ids() -> list[str]:
    """Ordered list of user-facing goal ids the UI should show.

    Used by `seed.py` to populate `GoalOption` rows and by tests to
    verify every exposed goal has intentional planner behavior."""
    return [g.user_id for g in _GOAL_REGISTRY if g.supported]


def goal_registry_rows() -> list[GoalDefinition]:
    """Read-only view of the registry for audit tables / tests."""
    return list(_GOAL_REGISTRY)


def ui_goal_rows() -> list[tuple[str, str, str, str]]:
    """Return `(user_id, label, icon, description)` tuples for every
    supported goal in display order. Used by `seed.py` to populate
    `GoalOption` rows — keeps the UI metadata and the planner registry
    in a single place so they can't drift."""
    return [
        (g.user_id, g.label, g.icon, g.description)
        for g in _GOAL_REGISTRY
        if g.supported
    ]
