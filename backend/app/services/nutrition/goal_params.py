"""
Goal-specific nutrition parameters.

This file is the single source of truth for the calorie adjustments, protein
targets, fat strategies, and carb floors that vary by fitness goal. Every
goal id the client can send maps to one of the buckets defined here.

Design notes
------------
We separate *goal ids* (the user-facing taxonomy in goalConfig.ts — "build
muscle", "improve 1rm", "train for a 5k", etc.) from *nutrition buckets*
(the 7 underlying profiles that drive macro math). Many goal ids share the
same macro profile — "lose_fat", "get_lean", "cut" all use FAT_LOSS — so we
map them here rather than scattering `if goal in {...}` checks through the
calculator.

How to review this file
-----------------------
Top to bottom. Each bucket is a `GoalBucketParams` instance with:
  - `calorie_adjustment_by_pace` — how many cal/day we add or subtract from
    TDEE at each pace level. Negative = deficit, positive = surplus.
  - `protein_per_lb` — g/lb of bodyweight.
  - `fat_percent_of_calories` — % of total daily calories from fat.
  - `min_carbs_g` — hard floor on carbs; calculator backs down fat if needed.

The numbers below are sourced from:
  - Mifflin-St Jeor (1990) for BMR math (lives in the calculator, not here)
  - ISSN Position Stand on Protein and Exercise (Jäger 2017)
  - ACSM nutrition guidelines for endurance athletes
  - Standard deficit/surplus rates: ~0.5% bodyweight/week is sustainable

If any of these numbers look wrong to you, change them in ONE place here
and every code path that hits the calculator picks up the update.
"""
from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping


# ─── Safety constants ─────────────────────────────────────────────────────────

# Lower bound on daily calories. Falling below this for extended periods
# drives muscle loss, metabolic adaptation, hormonal disruption, and
# micronutrient deficiency. 1200 is the widely-cited floor for adults.
MIN_SAFE_CALORIES = 1200

# Weekly rate clamps — converted to daily calorie adjustments elsewhere.
# Above these rates you're losing muscle on a cut, or adding pure fat on a
# bulk. Sources: ~1% of bodyweight/week is the rule of thumb; 1.5 lb/wk is
# already aggressive for most lifters.
#
# IMPORTANT — scope of these clamps: they are enforced ONLY in the
# target-weight + timeline path (calorie_calculator step_4, path a). The
# default pace path (path b: calorie_adjustment_pct_by_pace + the per-bucket
# calorie_adjustment_clamp) is NOT rate-clamped. So an "aggressive" surplus
# from the pace path can imply a weekly rate above MAX_GAIN_RATE_LBS_PER_WEEK
# at high TDEE — e.g. muscle_gain aggressive at 375 cal/day (legacy fixed
# table) ≈ 0.75 lb/wk, above the 0.5 ceiling. If you want the pace path to
# honor these clamps too, that's a behavior change, not a doc fix.
MAX_LOSS_RATE_LBS_PER_WEEK = 1.5
MAX_GAIN_RATE_LBS_PER_WEEK = 0.5

# Bodyweight-aware refinement applied to the pace path: it caps at the SMALLER
# of the absolute lb/wk ceilings above and these %-of-bodyweight/week rates, so
# a lighter user gets a proportionally tighter cap while no one ever exceeds the
# absolute ceiling. ~0.4%/wk gain and ~1%/wk loss are common rules of thumb.
MAX_GAIN_RATE_PCT_BW_PER_WEEK = 0.004
MAX_LOSS_RATE_PCT_BW_PER_WEEK = 0.01

# Calories per pound of body fat. Used when translating a target weight +
# timeline into a daily calorie delta. Conventional value — assumes the
# tissue changing is mostly fat; slightly off for muscle gain math but
# close enough at the deficit/surplus rates we allow.
CALORIES_PER_LB = 3500


# ─── Bucket dataclass ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GoalBucketParams:
    """All the nutrition parameters for one goal bucket.

    Immutable: `frozen=True` blocks attribute reassignment, and
    `__post_init__` wraps every mapping field in `MappingProxyType` so the
    nested per-pace dicts are read-only too. Together these mean a caller
    cannot mutate a shared bucket constant by accident.
    """

    # Human-readable name — shown in `CalorieTargets.bucket_name` so you
    # can trace back from a returned result to the bucket used.
    name: str

    # Daily calorie delta from TDEE by pace. Populated with three keys:
    # "conservative", "moderate", "aggressive".
    #
    # NOTE: this fixed table is the LEGACY fallback (calorie_calculator
    # step_4, path c). The live path is `calorie_adjustment_pct_by_pace` +
    # `calorie_adjustment_clamp` (path b). Neither pace path is rate-clamped
    # against MAX_GAIN/MAX_LOSS — see the note on those constants above.
    #
    # Negative values = deficit (cut), positive = surplus (bulk), zero =
    # maintenance.
    calorie_adjustment_by_pace: Mapping[str, int]

    # Protein target in g per pound of bodyweight. The ISSN 2017 protein
    # position stand puts the general range at 1.4-2.0 g/kg/day
    # (~0.64-0.9 g/lb) for most exercising adults, with higher intakes
    # (up to ~2.2-3.1 g/kg) supported during energy restriction. We pin
    # toward the high end for muscle/strength goals, the low end for
    # endurance where carbs take precedence, and elevate fat-loss protein
    # to preserve lean mass during a deficit. [needs-verification: exact
    # g/kg figures cited against the published stand]
    protein_per_lb: float

    # Fat as a fraction of total daily calories. The calculator also
    # applies a floor at 0.3 g/lb of bodyweight (essential fatty acid
    # safety) and will always honor the higher of the two. Keto-style
    # buckets don't exist here yet — add one if/when the app supports it.
    fat_percent_of_calories: float = 0.30

    # Minimum grams of carbs per day. If the remainder after protein +
    # fat would put carbs below this floor, the calculator steals calories
    # from fat (down to its own floor) to keep carbs above it. Strength
    # and endurance goals need more glycogen, so their floors are higher.
    min_carbs_g: int = 75

    # Preferred formula-driven model. When present, the calculator uses a
    # percentage of maintenance and clamps the result into the configured
    # range. The fixed table above remains a legacy fallback/reference.
    calorie_adjustment_pct_by_pace: Mapping[str, float] | None = None
    calorie_adjustment_clamp: tuple[int, int] | None = None
    pace_labels: Mapping[str, str] | None = None

    # Optional pace-specific protein/fat targets. Protein is multiplied by
    # the calculator's selected protein weight basis, not blindly by current
    # bodyweight.
    protein_per_lb_by_pace: Mapping[str, float] | None = None
    fat_percent_by_pace: Mapping[str, float] | None = None

    def __post_init__(self) -> None:
        # Deep-freeze the mapping fields so the shared bucket constants are
        # genuinely immutable, not just shielded from attribute reassignment.
        for field_name in (
            "calorie_adjustment_by_pace",
            "calorie_adjustment_pct_by_pace",
            "pace_labels",
            "protein_per_lb_by_pace",
            "fat_percent_by_pace",
        ):
            value = getattr(self, field_name)
            if isinstance(value, dict):
                object.__setattr__(self, field_name, MappingProxyType(dict(value)))


# ─── Bucket instances ─────────────────────────────────────────────────────────
#
# Edit these numbers if you want to tune a specific goal type. Each constant
# below is a single reference — e.g. every fat-loss-style goal reads from
# FAT_LOSS, so changing one number here moves all of them.

FAT_LOSS = GoalBucketParams(
    name="fat_loss",
    # Classic deficit table. 250/500/750 cal/day maps to roughly
    # 0.5/1.0/1.5 lb/week loss assuming the 3500-cal/lb model.
    calorie_adjustment_by_pace={
        "conservative": -250,
        "moderate":     -500,
        "aggressive":   -750,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": -0.10,
        "moderate":     -0.15,
        "aggressive":   -0.20,
    },
    calorie_adjustment_clamp=(-750, -250),
    # Elevated protein during a deficit to preserve lean mass. Evidence
    # consistently shows 0.8-1.0 g/lb during a cut outperforms 0.6-0.7.
    protein_per_lb=0.9,
    protein_per_lb_by_pace={
        "conservative": 0.9,
        "moderate":     1.0,
        "aggressive":   1.1,
    },
    # Slightly below the default 30% so more of the remaining calories go
    # to carbs — fuller on a deficit, sustains training better.
    fat_percent_of_calories=0.28,
    # Standard 75g floor; low-carb cuts would override this via a custom
    # bucket if we ever add one.
    min_carbs_g=75,
)

MUSCLE_GAIN = GoalBucketParams(
    name="muscle_gain",
    # Lean-bulk surplus (legacy fixed table — live path is the pct table
    # + clamp below). At the 3500 cal/lb model: 300 cal/day ≈ 0.6 lb/wk
    # and 375 ≈ 0.75 lb/wk — both ABOVE MAX_GAIN_RATE_LBS_PER_WEEK (0.5),
    # which the pace path does not enforce. ~0.5 lb/wk (≈250 cal/day) is
    # the usual upper bound for minimizing fat accrual in trained lifters.
    # 2026-04-13: aggressive dropped 500 → 375 to reduce fat accrual.
    calorie_adjustment_by_pace={
        "conservative": 150,
        "moderate":     300,
        "aggressive":   375,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": 0.05,
        "moderate":     0.08,
        "aggressive":   0.11,
    },
    calorie_adjustment_clamp=(150, 500),
    # Top of the ISSN range — plenty of substrate for muscle protein
    # synthesis. Research doesn't show benefit above ~1.0 g/lb.
    protein_per_lb=0.9,
    protein_per_lb_by_pace={
        "conservative": 0.85,
        "moderate":     0.9,
        "aggressive":   1.0,
    },
    fat_percent_of_calories=0.25,  # more carbs = better training fuel
    min_carbs_g=100,
)

BODY_RECOMP = GoalBucketParams(
    name="body_recomp",
    # Near-maintenance band. Recomp is slow by nature; big swings in
    # either direction defeat the purpose. Conservative = slight deficit
    # for fat loss emphasis, aggressive = slight surplus for muscle
    # emphasis.
    calorie_adjustment_by_pace={
        "conservative": -100,
        "moderate":        0,
        "aggressive":    100,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": -0.04,
        "moderate":      0.00,
        "aggressive":    0.04,
    },
    calorie_adjustment_clamp=(-150, 150),
    pace_labels={
        "conservative": "fat_priority",
        "moderate": "balanced",
        "aggressive": "muscle_priority",
    },
    protein_per_lb=1.0,  # high protein is the whole point of recomp
    protein_per_lb_by_pace={
        "conservative": 0.95,
        "moderate":     1.0,
        "aggressive":   1.0,
    },
    fat_percent_of_calories=0.28,
    min_carbs_g=100,
)

STRENGTH = GoalBucketParams(
    name="strength",
    # Strength progress generally benefits from a mild surplus —
    # recovery between heavy sessions improves with adequate calories.
    # Less than muscle-gain because we don't prioritize hypertrophy mass.
    # 2026-04-13: aggressive dropped from 500 → 350. Strength goals
    # don't need a real bulk — the old 500 was borrowed from muscle
    # gain and produced unnecessary fat gain for lifters who just
    # want their 1RM up.
    calorie_adjustment_by_pace={
        "conservative": 150,
        "moderate":     300,
        "aggressive":   350,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": 0.00,
        "moderate":     0.03,
        "aggressive":   0.05,
    },
    calorie_adjustment_clamp=(0, 350),
    protein_per_lb=0.9,
    protein_per_lb_by_pace={
        "conservative": 0.85,
        "moderate":     0.9,
        "aggressive":   1.0,
    },
    fat_percent_of_calories=0.28,
    # High carbs for CNS recovery and heavy-session performance.
    min_carbs_g=120,
)

ENDURANCE = GoalBucketParams(
    name="endurance",
    # Endurance athletes need extra calories to cover training expenditure,
    # but we don't push large surpluses — the body adapts to sustained
    # training volume at near-maintenance.
    calorie_adjustment_by_pace={
        "conservative": 100,
        "moderate":     200,
        "aggressive":   300,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": 0.00,
        "moderate":     0.03,
        "aggressive":   0.05,
    },
    calorie_adjustment_clamp=(0, 400),
    # Lower than strength/muscle — endurance prioritizes carbs for glycogen
    # replenishment. 0.8 g/lb ≈ 1.76 g/kg — above the ACSM minimum of
    # 1.2 g/kg, reflecting that our users also do resistance training.
    protein_per_lb=0.8,
    # Lowest fat % — endurance athletes run on carbs.
    fat_percent_of_calories=0.22,
    # Highest carb floor — glycogen is king here.
    min_carbs_g=200,
)

ATHLETIC = GoalBucketParams(
    name="athletic_performance",
    # Sport/power/athleticism goals — similar to strength but with
    # slightly less surplus emphasis. We assume the athlete is already
    # trained and just needs to maintain.
    calorie_adjustment_by_pace={
        "conservative": 100,
        "moderate":     250,
        "aggressive":   400,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": 0.00,
        "moderate":     0.03,
        "aggressive":   0.05,
    },
    calorie_adjustment_clamp=(0, 500),
    # 2026-05-23: 1.0 g/lb across all paces. Power/speed/agility work has
    # fiber-recruitment demands similar to strength training, and the ISSN
    # 2017 stand supports intakes at this level for trained athletes with
    # explosive demands. No pace map — every pace resolves to this base, so
    # conservative/moderate athletes get 1.0 too (previously 0.8/0.9).
    protein_per_lb=1.0,
    fat_percent_of_calories=0.28,
    min_carbs_g=120,
)

GENERAL_HEALTH = GoalBucketParams(
    name="general_health",
    # Default bucket for unknown goals and lifestyle/health / stress-relief
    # / flexibility categories. Near-maintenance calories, moderate protein,
    # sensible macro split. (Note: "toning" maps to FAT_LOSS, not here.)
    calorie_adjustment_by_pace={
        "conservative": -100,
        "moderate":        0,
        "aggressive":    100,
    },
    calorie_adjustment_pct_by_pace={
        "conservative": -0.03,
        "moderate":      0.00,
        "aggressive":    0.03,
    },
    calorie_adjustment_clamp=(-150, 150),
    # 2026-04-13: bumped 0.75 → 0.8 g/lb. 0.75 sat below the ISSN 2017
    # floor for physically active adults (0.8 g/lb ≈ 1.8 g/kg). Even
    # sedentary older adults benefit from ≥0.8 g/lb for lean-mass
    # preservation, so this is the right default for "unknown goal".
    protein_per_lb=0.8,
    fat_percent_of_calories=0.30,
    min_carbs_g=90,
)


# ─── Goal id → bucket mapping ─────────────────────────────────────────────────
#
# Add new goal ids to this dict as they show up in the client taxonomy.
# Unknown ids fall through to GENERAL_HEALTH via `get_bucket_for_goal()`.

GOAL_BUCKET_MAP: dict[str, GoalBucketParams] = {
    # ── Fat loss family ──────────────────────────────────────────────────────
    "fat_loss":                FAT_LOSS,
    "toning":                  FAT_LOSS,
    "lose_fat":                FAT_LOSS,
    "get_lean":                FAT_LOSS,
    "cut":                     FAT_LOSS,
    "preserve_muscle_cutting": FAT_LOSS,

    # ── Muscle gain family ───────────────────────────────────────────────────
    "muscle_gain":          MUSCLE_GAIN,
    "build_muscle":         MUSCLE_GAIN,
    "lean_bulk":            MUSCLE_GAIN,
    "gain_weight":          MUSCLE_GAIN,
    "improve_aesthetics":   MUSCLE_GAIN,
    "build_glutes":         MUSCLE_GAIN,
    "build_upper_body":     MUSCLE_GAIN,
    "build_lower_body":     MUSCLE_GAIN,
    "build_arms":           MUSCLE_GAIN,
    "build_shoulders":      MUSCLE_GAIN,

    # ── Recomposition / maintenance ──────────────────────────────────────────
    "body_recomp":       BODY_RECOMP,
    "maintain":          BODY_RECOMP,
    "maintain_physique": BODY_RECOMP,
    "general_health":    GENERAL_HEALTH,

    # ── Strength / powerlifting ──────────────────────────────────────────────
    "strength":            STRENGTH,
    "build_strength":      STRENGTH,
    "increase_overall":    STRENGTH,
    "improve_1rm":         STRENGTH,
    "powerlifting":        STRENGTH,
    "improve_squat":       STRENGTH,
    "improve_bench":       STRENGTH,
    "improve_deadlift":    STRENGTH,
    "improve_ohp":         STRENGTH,
    "improve_pullups":     STRENGTH,
    "improve_grip":        STRENGTH,
    "functional_strength": STRENGTH,
    "explosive_strength":  STRENGTH,
    "relative_strength":   STRENGTH,

    # ── Endurance ────────────────────────────────────────────────────────────
    "endurance":           ENDURANCE,
    "improve_cardio":      ENDURANCE,
    "improve_conditioning": ENDURANCE,
    "aerobic_base":        ENDURANCE,
    "improve_vo2":         ENDURANCE,
    "increase_stamina":    ENDURANCE,
    "running_fitness":     ENDURANCE,
    "train_5k":            ENDURANCE,
    "train_10k":           ENDURANCE,
    "train_half":          ENDURANCE,
    "train_marathon":      ENDURANCE,
    # interval_perf is ambiguous (VO2 intervals vs HIIT / repeated-sprint).
    # Defaulting to ENDURANCE; reassign or split per-id if the client
    # taxonomy ever distinguishes the two.
    "interval_perf":       ENDURANCE,
    "hiking_endurance":    ENDURANCE,
    "cycling_endurance":   ENDURANCE,
    "rowing_endurance":    ENDURANCE,
    "swimming_endurance":  ENDURANCE,
    "work_capacity":       ENDURANCE,

    # ── Athletic performance ─────────────────────────────────────────────────
    "hyrox":                ATHLETIC,
    "athletic_performance": ATHLETIC,
    "improve_athleticism":  ATHLETIC,
    "improve_speed":        ATHLETIC,
    "improve_agility":      ATHLETIC,
    "improve_power":        ATHLETIC,
    "improve_vertical":     ATHLETIC,
    "improve_acceleration": ATHLETIC,
    "sprint_speed":         ATHLETIC,  # was ENDURANCE — aligns with improve_speed/acceleration
    "improve_cod":          ATHLETIC,
    "improve_coordination": ATHLETIC,
    "improve_balance":      ATHLETIC,
    "sport_performance":    ATHLETIC,
    "offseason_training":   ATHLETIC,
    "inseason_maintenance": ATHLETIC,
    "return_to_sport":      ATHLETIC,
}


def get_bucket_for_goal(goal_id: str | None) -> GoalBucketParams:
    """Look up the nutrition bucket for a goal id.

    Any id not in GOAL_BUCKET_MAP (including None and unknown / new goals)
    returns GENERAL_HEALTH. This is the safe default: near-maintenance
    calories and moderate protein, applicable to anyone.
    """
    if not goal_id:
        return GENERAL_HEALTH
    return GOAL_BUCKET_MAP.get(goal_id, GENERAL_HEALTH)
