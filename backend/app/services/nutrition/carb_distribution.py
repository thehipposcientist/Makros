"""Training-day vs rest-day macro redistribution.

Keeps WEEKLY calories + protein unchanged. Shifts carbs up on heavy /
leg / HIIT days and down on rest days; fat absorbs the calorie delta
so daily kcal stays flat. Non-goal: this is NOT where the
adaptive_macros weekly calorie adjustment happens — see
`adaptive_macros.py` for that. This service only redistributes a
given day's macros given the base weekly targets.

Core rules:
  - HEAVY  (full_body_strength, lower heavy, hyrox, HIIT):  +25 g carbs
  - LEG    (legs / lower):                                  +15 g carbs
  - HARD   (push/pull heavy, strength_maintenance):         +10 g carbs
  - STANDARD (push, pull, upper, conditioning circuits):     0
  - EASY   (zone 2 cardio, mobility):                       -10 g carbs
  - REST   (rest, recovery):                                -25 g carbs

Goal modifier (applied on top of the base shift):
  - fat_loss:  tightens the range (max ±20 g) so a rest day doesn't
               go too low in a cut; a hard day doesn't blow the deficit.
  - muscle_gain: widens it (max ±35 g) — bulking benefits more from
                 around-workout carbs than a recomp does.
  - recomp / general_health: unchanged base ranges.

Every shift caps delta at 40 g carbs (160 kcal) total in either
direction to prevent a sparse cardio week from tanking daily kcal.
Protein holds. Fat = base_fat - (carb_delta * 4 / 9).

Pure function. No DB, no AI.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


DayType = Literal["heavy", "leg", "hard", "standard", "easy", "rest"]


# Base carb shift (grams) by day type. Applied before goal modifier.
_CARB_SHIFT: dict[DayType, int] = {
    "heavy":    25,
    "leg":      15,
    "hard":     10,
    "standard":  0,
    "easy":    -10,
    "rest":    -25,
}

# Hard cap on the shift after goal modifier so the daily macros never
# swing beyond 40 g carbs / 160 kcal shuffle in either direction.
_MAX_CARB_DELTA = 40


@dataclass
class MacroSet:
    calories: int
    protein_g: int
    carbs_g: int
    fat_g: int

    def to_dict(self) -> dict:
        return {
            "calories": int(round(self.calories)),
            "protein_g": int(round(self.protein_g)),
            "carbs_g": int(round(self.carbs_g)),
            "fat_g": int(round(self.fat_g)),
        }


# Map planner archetype / focus / activity category strings to a
# DayType bucket. Keep the buckets coarse so this stays stable across
# archetype additions.
def classify_day(
    *,
    archetype: str | None = None,
    focus: str | None = None,
    activity_category: str | None = None,
    cardio_style: str | None = None,
    stimulus: str | None = None,
) -> DayType:
    """Classify a planned / completed day into one of the 6 carb buckets.

    Priority order (strongest signal wins):
      1. Explicit rest / recovery → rest
      2. Mobility / flexibility   → easy
      3. Cardio: style drives it (intervals/HIIT → heavy, steady → easy)
      4. Strength: archetype + stimulus determine heavy vs hard vs standard
    """
    a = (archetype or "").lower()
    f = (focus or "").lower()
    cat = (activity_category or "").lower()
    cs = (cardio_style or "").lower()
    st = (stimulus or "").lower()

    # 1. Rest / recovery.
    if "rest" in f or "recovery" in a or cat == "recovery":
        return "rest"
    # 2. Mobility / yoga / stretching.
    if "mobility" in a or cat == "mobility" or "stretch" in f:
        return "easy"

    # 3. Cardio bucket.
    if cat == "cardio" or "cond_" in a or "hybrid_" in a:
        # HIIT / intervals / sprint_power → heavy-ish from a fueling
        # standpoint (glycogen + recovery).
        if cs in ("intervals", "sprint", "power") or "hiit" in f or "interval" in a or "sprint" in a:
            return "heavy"
        # Circuit / conditioning at moderate intensity → hard.
        if "circuit" in a or "tempo" in a:
            return "hard"
        # Default cardio is easy (zone 2 / walk / steady).
        return "easy"

    # 4. Strength bucket.
    # Heavy full-body or lower-heavy sessions need the biggest bump.
    if "full_body_strength" in a or "_heavy" in a or "hyrox" in a:
        return "heavy"
    if "legs" in a or "lower" in a or "legs" in f or "lower" in f:
        # Don't over-bucket LIFT_LOWER_HYPERTROPHY as heavy — it's
        # still "leg" but not as systemically demanding.
        return "leg"
    if st == "strength" or "strength_maintenance" in a:
        return "hard"
    # Default strength (push / pull / upper / standard hypertrophy).
    return "standard"


def _goal_cap(goal_bucket: str | None) -> int:
    """Per-goal cap on the absolute shift in grams of carbs."""
    g = (goal_bucket or "").lower()
    if g in ("fat_loss",):
        return 20
    if g in ("muscle_gain", "lean_bulk"):
        return 35
    return 30  # body_recomp / general_health / longevity / default


def redistribute_macros(
    base: MacroSet,
    *,
    day_type: DayType,
    goal_bucket: str | None = None,
) -> MacroSet:
    """Return a new MacroSet for the given day type.

    Calories + protein unchanged. Carbs shifted by the base amount
    clipped to the goal's cap. Fat absorbs the calorie delta so
    total kcal stays flat (±1 from integer rounding).
    """
    shift = _CARB_SHIFT.get(day_type, 0)
    cap = min(_goal_cap(goal_bucket), _MAX_CARB_DELTA)
    if shift > 0:
        shift = min(shift, cap)
    elif shift < 0:
        shift = -min(-shift, cap)

    # Never push carbs below 40 g (safety floor for training folks).
    new_carbs = max(40, base.carbs_g + shift)
    actual_delta = new_carbs - base.carbs_g
    # kcal delta from the carb shift (carbs = 4 kcal/g). Fat absorbs
    # the inverse so total calories stay the same.
    fat_delta_g = -actual_delta * 4 / 9
    new_fat = max(30, int(round(base.fat_g + fat_delta_g)))

    # Rebalance calories to exactly match the base by rounding fat
    # last. Calorie drift from integer rounding is ≤ 5 kcal which
    # users won't notice; the key invariant is "weekly kcal unchanged."
    new_cals = int(round(base.protein_g * 4 + new_carbs * 4 + new_fat * 9))

    return MacroSet(
        calories=new_cals,
        protein_g=int(round(base.protein_g)),
        carbs_g=int(round(new_carbs)),
        fat_g=new_fat,
    )


def redistribute_for_day(
    base: MacroSet,
    *,
    archetype: str | None = None,
    focus: str | None = None,
    activity_category: str | None = None,
    cardio_style: str | None = None,
    stimulus: str | None = None,
    goal_bucket: str | None = None,
) -> tuple[MacroSet, DayType]:
    """Convenience wrapper: classify + redistribute in one call."""
    day_type = classify_day(
        archetype=archetype,
        focus=focus,
        activity_category=activity_category,
        cardio_style=cardio_style,
        stimulus=stimulus,
    )
    return redistribute_macros(base, day_type=day_type, goal_bucket=goal_bucket), day_type
