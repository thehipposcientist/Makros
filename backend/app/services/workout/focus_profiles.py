"""Focus profile layer — maps focused_muscle → planner behavior.

This is the SINGLE source of truth for how a muscle focus biases the
deterministic planner.  Every other module (split selection, slot
dispatch, scoring, quota fulfillment, validation) reads from here
instead of scattering focus logic across if-statements.

Concepts:
  - focus_region: "lower" | "upper" | "arm" | "lift" | None
    Coarse classification that drives split preference and exposure rules.
  - min_exposure_days: minimum number of training days per week that must
    include at least one exercise hitting the focused muscle.
  - min_direct_accessories: minimum number of isolation-role exercises
    across the week that list the focused muscle as primary.
  - slot_variant: which slot-builder variant to use for days that train
    the focused muscle (e.g. "glute" → glute-biased lower templates).
  - split_bias: dict of split_id → score adjustment for auto-pick.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class FocusProfile:
    muscle: str
    region: str                                   # "lower" | "upper" | "arm" | "core"
    slot_variant: str                             # key for focus-aware slot builders
    split_bias: dict[str, int] = field(default_factory=dict)
    min_exposure_days_frac: float = 0.0           # fraction of lifting days
    min_direct_accessories: int = 0               # across the whole week
    preferred_compound_patterns: tuple[str, ...] = ()  # movement patterns where this muscle is primary
    preferred_isolation_hints: tuple[str, ...] = ()    # primary_muscle_hint values for focus isolation slots
    secondary_muscles: tuple[str, ...] = ()       # muscles that "count" as partial focus exposure


# ── Lower-body focuses ─────────────────────────────────────────────

_GLUTE_PROFILE = FocusProfile(
    muscle="glutes",
    region="lower",
    slot_variant="glute",
    split_bias={
        "full_body": 10,
        "upper_lower": 15,
        "ppl": -5,
        "ppl_upper_lower": 8,
        "bro": -10,
    },
    min_exposure_days_frac=0.4,
    min_direct_accessories=2,
    preferred_compound_patterns=("hinge", "lunge", "squat"),
    preferred_isolation_hints=("glutes",),
    secondary_muscles=("hamstrings",),
)

_QUAD_PROFILE = FocusProfile(
    muscle="quads",
    region="lower",
    slot_variant="quad",
    split_bias={
        "full_body": 5,
        "upper_lower": 12,
        "ppl": 0,
        "ppl_upper_lower": 5,
        "bro": -8,
    },
    min_exposure_days_frac=0.35,
    min_direct_accessories=1,
    preferred_compound_patterns=("squat", "lunge"),
    preferred_isolation_hints=("quads",),
    secondary_muscles=("glutes",),
)

_HAMSTRING_PROFILE = FocusProfile(
    muscle="hamstrings",
    region="lower",
    slot_variant="hamstring",
    split_bias={
        "full_body": 5,
        "upper_lower": 12,
        "ppl": 0,
        "ppl_upper_lower": 5,
        "bro": -8,
    },
    min_exposure_days_frac=0.35,
    min_direct_accessories=1,
    preferred_compound_patterns=("hinge", "lunge"),
    preferred_isolation_hints=("hamstrings",),
    secondary_muscles=("glutes",),
)

_CALVES_PROFILE = FocusProfile(
    muscle="calves",
    region="lower",
    slot_variant="default",
    split_bias={"upper_lower": 5, "full_body": 3},
    min_exposure_days_frac=0.3,
    min_direct_accessories=2,
    preferred_compound_patterns=(),
    preferred_isolation_hints=("calves",),
)

# ── Upper-body focuses ─────────────────────────────────────────────

_CHEST_PROFILE = FocusProfile(
    muscle="chest",
    region="upper",
    slot_variant="chest",
    split_bias={
        "ppl": 8,
        "upper_lower": 8,
        "ppl_upper_lower": 5,
        "bro": 3,
    },
    min_exposure_days_frac=0.35,
    min_direct_accessories=1,
    preferred_compound_patterns=("horizontal_press",),
    preferred_isolation_hints=("chest",),
    secondary_muscles=("triceps",),
)

_BACK_PROFILE = FocusProfile(
    muscle="back",
    region="upper",
    slot_variant="back",
    split_bias={
        "ppl": 8,
        "upper_lower": 8,
        "ppl_upper_lower": 5,
        "bro": 3,
    },
    min_exposure_days_frac=0.35,
    min_direct_accessories=1,
    preferred_compound_patterns=("horizontal_pull", "vertical_pull"),
    preferred_isolation_hints=("back", "lats"),
    secondary_muscles=("biceps",),
)

_SHOULDERS_PROFILE = FocusProfile(
    muscle="shoulders",
    region="upper",
    slot_variant="shoulders",
    split_bias={
        "ppl": 5,
        "upper_lower": 5,
        "bro": 5,
    },
    min_exposure_days_frac=0.3,
    min_direct_accessories=1,
    preferred_compound_patterns=("vertical_press",),
    preferred_isolation_hints=("shoulders",),
    secondary_muscles=("triceps",),
)

# ── Arm focuses ────────────────────────────────────────────────────

_BICEPS_PROFILE = FocusProfile(
    muscle="biceps",
    region="arm",
    slot_variant="default",
    split_bias={"ppl": 3, "bro": 5},
    min_exposure_days_frac=0.25,
    min_direct_accessories=2,
    preferred_compound_patterns=("horizontal_pull", "vertical_pull"),
    preferred_isolation_hints=("biceps",),
)

_TRICEPS_PROFILE = FocusProfile(
    muscle="triceps",
    region="arm",
    slot_variant="default",
    split_bias={"ppl": 3, "bro": 5},
    min_exposure_days_frac=0.25,
    min_direct_accessories=2,
    preferred_compound_patterns=("horizontal_press", "vertical_press"),
    preferred_isolation_hints=("triceps",),
)

# ── Registry ───────────────────────────────────────────────────────

_FOCUS_REGISTRY: dict[str, FocusProfile] = {
    "glutes": _GLUTE_PROFILE,
    "quads": _QUAD_PROFILE,
    "hamstrings": _HAMSTRING_PROFILE,
    "calves": _CALVES_PROFILE,
    "chest": _CHEST_PROFILE,
    "back": _BACK_PROFILE,
    "shoulders": _SHOULDERS_PROFILE,
    "biceps": _BICEPS_PROFILE,
    "triceps": _TRICEPS_PROFILE,
    # Aliases
    "lats": _BACK_PROFILE,
    "arms": _BICEPS_PROFILE,
    "legs": _QUAD_PROFILE,
    "hips": _GLUTE_PROFILE,
}


def get_focus_profile(focused_muscle: Optional[str]) -> Optional[FocusProfile]:
    """Look up the FocusProfile for a muscle name. Returns None when
    no focus is set or the muscle isn't in the registry."""
    if not focused_muscle:
        return None
    return _FOCUS_REGISTRY.get(focused_muscle.lower().strip())


def focus_min_exposure_days(profile: FocusProfile, lifting_days: int) -> int:
    """Minimum number of lifting days that must include at least one
    exercise hitting the focused muscle."""
    return max(1, round(profile.min_exposure_days_frac * lifting_days))


def focus_split_bias(profile: FocusProfile, split_id: str) -> int:
    """Score adjustment for a split when this focus is active."""
    return profile.split_bias.get(split_id, 0)
