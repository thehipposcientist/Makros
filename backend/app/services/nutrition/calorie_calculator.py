"""
Calorie and macro target calculator.

Single source of truth for how we compute a user's daily calorie and macro
targets from their profile. Used by the meal-plan AI prompts: the AI is
told to hit these numbers exactly as a HARD CONSTRAINT, not as guidance.

Deliberately pure and dependency-free so it can be unit-tested without
spinning up FastAPI. Every step is its own named function (`step_1_...`,
`step_2_...`) so you can read it linearly top-to-bottom and audit the
math at every stage.

Read this file in order:
    1. Unit-conversion constants at the top
    2. `CalorieInputs` — what the calculator consumes
    3. `CalorieTargets` — what it produces (with debug fields)
    4. Each `step_N_*` function in order
    5. `compute_targets()` at the bottom wires them together in ~15 lines

If a number seems wrong, it lives in `goal_nutrition_params.py`, not here.
This file contains only the math that combines body stats + bucket params
into final numbers.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .goal_params import (
    CALORIES_PER_LB,
    GoalBucketParams,
    MAX_GAIN_RATE_LBS_PER_WEEK,
    MAX_LOSS_RATE_LBS_PER_WEEK,
    get_bucket_for_goal,
)


# ─── Unit conversions ────────────────────────────────────────────────────────
#
# Kept as named constants so formulas read in plain English instead of
# having magic numbers scattered through the math.

LBS_PER_KG = 2.205      # 1 kg ≈ 2.205 lbs
INCHES_PER_FOOT = 12
CM_PER_INCH = 2.54

CALORIES_PER_GRAM_PROTEIN = 4
CALORIES_PER_GRAM_CARB    = 4
CALORIES_PER_GRAM_FAT     = 9

# Minimum fat floor in g per lb of bodyweight. Below this and the user
# risks essential fatty acid deficiency and hormonal disruption. Takes
# precedence over the bucket's fat % target if the % target would produce
# a lower value.
FAT_FLOOR_G_PER_LB = 0.3


# ─── Inputs ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class CustomMacroOverrides:
    """Optional user-set manual macro targets.

    Each field is independent — the user can override just calories and
    let protein/carbs/fat recalculate, or pin all four. Applied in
    `step_8_apply_custom_overrides` after the full calculation runs, so
    even if the user only pins protein we still show them the calculated
    calories / fat / carbs that went into the decision.
    """
    calories: int | None = None
    protein: int | None = None
    carbs: int | None = None
    fat: int | None = None


@dataclass(frozen=True)
class CalorieInputs:
    """Everything the calculator needs to produce a target.

    Kept as a frozen dataclass so callers can't accidentally mutate it
    mid-calculation, and so debug prints / logs are trivial.
    """

    # Body stats
    weight_lbs: float
    height_feet: int
    height_inches: int
    age: int
    gender: str                       # "male" | "female" | anything else

    # Training volume (used by TDEE activity multiplier)
    training_days_per_week: int       # 0-7
    session_minutes: int = 60         # avg minutes per session; nudges multiplier

    # Goal context
    goal_id: str | None = None        # looked up in GOAL_BUCKET_MAP
    pace: str = "moderate"            # "conservative" | "moderate" | "aggressive"

    # Optional target-based overrides — if both present, we ignore the
    # pace-based bucket adjustment and derive a daily delta from the
    # user's desired weight change over their desired timeline.
    target_weight_lbs: float | None = None
    timeline_weeks: int | None = None

    # Optional manual overrides — see `CustomMacroOverrides`.
    custom_overrides: CustomMacroOverrides | None = None


# ─── Outputs ─────────────────────────────────────────────────────────────────

@dataclass
class CalorieTargets:
    """Final macro target + debug trail.

    The top four fields (calories, protein_g, carbs_g, fat_g) are what the
    rest of the app consumes. Everything below them is debug / provenance
    so when you inspect a returned value you can trace exactly how the
    numbers were produced.
    """

    # Final numbers (always integers after rounding)
    calories: int
    protein_g: int
    carbs_g: int
    fat_g: int

    # Provenance / debug fields ----------------------------------------------
    bmr: int                          # Basal Metabolic Rate (step 1)
    activity_multiplier: float        # Step 2
    tdee: int                         # Step 3
    goal_adjustment_kcal: int         # Step 4 — signed daily delta from TDEE
    bucket_name: str                  # Which bucket drove the math
    rate_summary: str                 # Human-readable "what pace are we on"
    override_applied: bool            # True if user custom macros were used
    min_calories_enforced: bool       # True if we clamped up to MIN_SAFE_CALORIES

    # Extra diagnostics populated after step 8 (partial-override recalc).
    # Default values preserve backward compat for any construction site
    # that doesn't pass them explicitly.
    consistency_kcal_delta: int = 0   # |calories − (P*4 + C*4 + F*9)|; 0 when consistent
    override_inconsistent: bool = False   # True if user pinned values whose sum != stated calories
    override_fat_below_floor: bool = False  # True if user override drove fat below physiological floor

    # Pre-override snapshot. Populated whenever step 8 actually mutates
    # something so callers / UIs can show "you pinned calories; original
    # calculated values were X/Y/Z". Left None when no override was applied.
    calculated_calories: int | None = None
    calculated_protein_g: int | None = None
    calculated_carbs_g: int | None = None
    calculated_fat_g: int | None = None


# ─── Consistency check helper ────────────────────────────────────────────────
#
# Exposed so the meal assembler and tests can call it too. Returns the
# signed delta in kcal between the stated `calories` field and the actual
# sum implied by protein/carbs/fat totals. Zero means the macro breakdown
# is internally consistent; a positive value means stated calories exceed
# the sum (user said "2000 cal" but macros only add to 1900).

def macro_consistency_delta(calories: int, protein_g: int, carbs_g: int, fat_g: int) -> int:
    """Signed drift between stated calories and macro-sum calories, in kcal.

    Useful for catching override inconsistencies or assembler drift. The
    calculator guarantees |delta| ≤ 1-2 kcal for calculated targets (pure
    rounding error); anything larger came from manual overrides or a
    buggy downstream step.
    """
    macro_kcal = (
        protein_g * CALORIES_PER_GRAM_PROTEIN
        + carbs_g * CALORIES_PER_GRAM_CARB
        + fat_g * CALORIES_PER_GRAM_FAT
    )
    return int(calories) - int(macro_kcal)


# ─── Step 1 — BMR (Mifflin-St Jeor) ──────────────────────────────────────────

def step_1_calculate_bmr(inputs: CalorieInputs) -> int:
    """Basal Metabolic Rate via the Mifflin-St Jeor equation (1990).

    Why Mifflin-St Jeor?
        - More accurate than the older Harris-Benedict equation (average
          error ~10% vs ~14% in validation studies).
        - Standard in modern nutrition software (MyFitnessPal, Cronometer).
        - Doesn't require body-fat % as an input (which we don't have).

    Formula (metric inputs):
        base = 10 * weight_kg + 6.25 * height_cm - 5 * age
        BMR  = base + sex_adjustment
            where sex_adjustment = +5 for male, -161 for female.

    We convert lbs → kg and feet/inches → cm inside this function so
    callers can keep working in US units. No other function touches
    unit conversions.
    """
    weight_kg = inputs.weight_lbs / LBS_PER_KG
    total_inches = inputs.height_feet * INCHES_PER_FOOT + inputs.height_inches
    height_cm = total_inches * CM_PER_INCH

    base = 10 * weight_kg + 6.25 * height_cm - 5 * inputs.age

    # Sex adjustment. "Nonbinary" / unspecified gets the average of the
    # male and female adjustments (-78) which is our best guess absent
    # better data. This matches how MyFitnessPal handles the same case.
    gender = (inputs.gender or "").lower()
    if gender == "male":
        sex_adjustment = 5
    elif gender == "female":
        sex_adjustment = -161
    else:
        sex_adjustment = -78

    return round(base + sex_adjustment)


# ─── Step 2 — Activity multiplier ────────────────────────────────────────────

def step_2_calculate_activity_multiplier(training_days_per_week: int, session_minutes: int) -> float:
    """Pick the TDEE activity multiplier based on training volume.

    These multipliers are the traditional Harris-Benedict / Mifflin-St Jeor
    activity levels:
        1.2    — sedentary (little/no exercise)
        1.375  — light (1-3 days/wk)
        1.55   — moderate (3-5 days/wk)
        1.725  — very active (6-7 days/wk)
        1.9    — extremely active (2x/day + physical job)

    We don't expose 1.9 because the app can't tell whether the user has a
    physical job, and picking it by mistake creates a big overestimate.

    We do apply a small nudge for unusually short (<40 min) or unusually
    long (>75 min) sessions, because a 30-min walker and a 90-min lifter
    on the same day count shouldn't get the same multiplier. The nudge
    is capped at ±0.05 so the multiplier stays in a sensible range.
    """
    # Base bucket from training day count.
    if training_days_per_week <= 1:
        base = 1.2
    elif training_days_per_week <= 3:
        base = 1.375
    elif training_days_per_week <= 5:
        base = 1.55
    else:
        base = 1.725

    # Session-length nudge. 60 min is our "normal" — anything significantly
    # shorter or longer shifts the multiplier slightly.
    if session_minutes < 40:
        base -= 0.05
    elif session_minutes > 75:
        base += 0.05

    # Clamp: never go below sedentary or above very-active.
    return max(1.2, min(1.725, round(base, 3)))


# ─── Step 3 — TDEE (maintenance calories) ────────────────────────────────────

def step_3_calculate_tdee(bmr: int, activity_multiplier: float) -> int:
    """Total Daily Energy Expenditure — the calories burned in a day of
    normal life at the user's training volume.

    Literally just `bmr * multiplier`. Exists as a named step so the
    calculation flow reads as "calculate BMR, calculate multiplier,
    calculate TDEE" instead of having the multiplication happen somewhere
    implicit. Audit friendly.
    """
    return round(bmr * activity_multiplier)


# ─── Step 4 — Goal adjustment (deficit / surplus from TDEE) ──────────────────

def step_4_calculate_goal_adjustment(inputs: CalorieInputs, bucket: GoalBucketParams, tdee: int) -> tuple[int, str]:
    """Compute the daily calorie delta from TDEE based on the user's goal.

    Two paths, in priority order:

      (a) Target-weight + timeline path. If the user has entered both a
          target weight and a timeline, we derive the required weekly
          rate, clamp it to safe ranges (per bucket), and convert to a
          daily calorie delta. This is the most personalized option.

      (b) Pace-based path. Otherwise, look up the bucket's
          `calorie_adjustment_by_pace` dict and pick the value matching
          the user's pace setting.

    Returns (daily_kcal_delta, human_readable_summary). The summary is
    included in CalorieTargets.rate_summary so debug logs and the AI
    prompt can explain to the user WHY the target is what it is.
    """
    pace = (inputs.pace or "moderate").lower()

    # ── Path (a): target weight + timeline ──────────────────────────────────
    target = inputs.target_weight_lbs
    timeline = inputs.timeline_weeks
    if target is not None and timeline is not None and timeline > 0:
        raw_delta_lbs = target - inputs.weight_lbs    # negative = lose, positive = gain
        raw_rate = raw_delta_lbs / timeline            # lbs per week

        # Clamp to the bucket's safe direction. A fat-loss bucket never
        # produces a surplus even if the user's timeline is weird;
        # similarly muscle-gain won't dip into a deficit.
        if bucket.name == "fat_loss":
            clamped = max(-MAX_LOSS_RATE_LBS_PER_WEEK, min(raw_rate, 0.0))
        elif bucket.name == "muscle_gain":
            clamped = max(0.0, min(raw_rate, MAX_GAIN_RATE_LBS_PER_WEEK))
        elif bucket.name == "body_recomp":
            # Near-maintenance band — recomp is slow by design.
            clamped = max(-0.25, min(raw_rate, 0.25))
        elif bucket.name == "strength":
            # Mild surplus only — strength benefits from enough food but
            # doesn't require big gain rates.
            clamped = max(0.0, min(raw_rate, MAX_GAIN_RATE_LBS_PER_WEEK * 0.6))
        else:
            # Endurance / athletic / general health — allow a modest
            # deficit OR surplus, capped at 0.5 lb/wk either way.
            clamped = max(-0.5, min(raw_rate, 0.5))

        daily_delta = round((clamped * CALORIES_PER_LB) / 7)

        if abs(clamped) < 0.05:
            summary = (
                f"Near maintenance — target weight is close to current weight "
                f"({inputs.weight_lbs:.0f} → {target:.0f} lb in {timeline} weeks)."
            )
        elif clamped < 0:
            summary = (
                f"Targeting {abs(clamped):.2f} lb/week loss "
                f"({timeline} weeks to reach {target:.0f} lb)."
            )
        else:
            summary = (
                f"Targeting {clamped:.2f} lb/week gain "
                f"({timeline} weeks to reach {target:.0f} lb)."
            )
        return daily_delta, summary

    # ── Path (b): pace-based table ──────────────────────────────────────────
    daily_delta = bucket.calorie_adjustment_by_pace.get(pace, 0)
    pace_label = {"conservative": "slow", "moderate": "moderate", "aggressive": "fast"}.get(pace, pace)
    summary = f"{pace_label.capitalize()} pace ({daily_delta:+d} cal/day vs maintenance)."
    return daily_delta, summary


# ─── Step 5 — Protein ────────────────────────────────────────────────────────

def step_5_calculate_protein_g(weight_lbs: float, bucket: GoalBucketParams) -> int:
    """Protein target in grams — bucket.protein_per_lb × bodyweight.

    That's it. Exists as its own function for consistency with the other
    steps and so future changes (e.g. scale protein with training volume
    or lean mass) have a single obvious place to land.
    """
    return round(weight_lbs * bucket.protein_per_lb)


# ─── Step 6 — Fat ────────────────────────────────────────────────────────────

def step_6_calculate_fat_g(calories: int, weight_lbs: float, bucket: GoalBucketParams) -> int:
    """Fat target in grams.

    Two candidates, take the higher:

        - Percent target: `bucket.fat_percent_of_calories` * calories / 9
          (fat has 9 kcal/g)
        - Safety floor: `FAT_FLOOR_G_PER_LB` * bodyweight

    The floor exists because falling below ~0.3 g/lb over time leads to
    essential fatty acid deficiency and hormonal disruption. If the
    percent target would produce a lower fat number, we override it to
    the floor and let carbs absorb the difference.
    """
    # Percent-of-calories target.
    fat_from_percent = round(bucket.fat_percent_of_calories * calories / CALORIES_PER_GRAM_FAT)

    # Safety floor. `math.ceil` so we err on the side of sufficient fat
    # rather than sufficient carbs — you'd rather have one extra gram of
    # fat than dip below the floor.
    fat_floor = math.ceil(weight_lbs * FAT_FLOOR_G_PER_LB)

    return max(fat_from_percent, fat_floor)


# ─── Step 7 — Carbs ──────────────────────────────────────────────────────────

def step_7_calculate_carbs_g(
    calories: int,
    protein_g: int,
    fat_g: int,
    weight_lbs: float,
    bucket: GoalBucketParams,
) -> tuple[int, int]:
    """Carbs = whatever calories are left after protein + fat.

    Returns `(carbs_g, adjusted_fat_g)` — if the remainder would push
    carbs below the bucket's `min_carbs_g`, we steal calories from fat
    (down to its own floor) to keep carbs above the minimum. This is
    why we need the bucket *and* `fat_g` here: the function can shift
    the balance between fat and carbs without re-running step 6.

    The fat floor enforcement is re-checked here so we never leave fat
    below `FAT_FLOOR_G_PER_LB * weight_lbs`.
    """
    protein_cals = protein_g * CALORIES_PER_GRAM_PROTEIN
    fat_cals = fat_g * CALORIES_PER_GRAM_FAT
    remaining_cals = calories - protein_cals - fat_cals

    carbs_g = max(0, round(remaining_cals / CALORIES_PER_GRAM_CARB))

    # If we're short on carbs vs bucket minimum, take from fat.
    if carbs_g < bucket.min_carbs_g:
        fat_floor = math.ceil(weight_lbs * FAT_FLOOR_G_PER_LB)
        deficit_cals = (bucket.min_carbs_g - carbs_g) * CALORIES_PER_GRAM_CARB
        transferable_cals = max(0, (fat_g - fat_floor) * CALORIES_PER_GRAM_FAT)
        transfer = min(deficit_cals, transferable_cals)

        fat_g = round((fat_g * CALORIES_PER_GRAM_FAT - transfer) / CALORIES_PER_GRAM_FAT)
        carbs_g = max(0, round((remaining_cals + transfer) / CALORIES_PER_GRAM_CARB))

    return carbs_g, fat_g


# ─── Step 8 — Manual overrides ───────────────────────────────────────────────

def step_8_apply_custom_overrides(
    targets: CalorieTargets,
    overrides: CustomMacroOverrides | None,
    *,
    bucket: GoalBucketParams | None = None,
    weight_lbs: float | None = None,
) -> CalorieTargets:
    """Apply any fields the user manually pinned and recompute the rest.

    Rules (run top-to-bottom, each independent):

      * Pinned fields are always kept as-is.
      * Calories pinned but macros left blank → recompute fat and carbs
        from the new calorie count (protein already comes from bodyweight
        so it doesn't move unless pinned).
      * Protein pinned → keep protein, recompute carbs/fat from remaining
        calories.
      * Fat pinned → keep fat, recompute carbs.
      * Carbs pinned → keep carbs, recompute fat.
      * Any combination: only fields that weren't pinned get recomputed.
      * All four pinned → use as-is, no recomputation.

    Requires `bucket` and `weight_lbs` for recomputation. If either is
    missing we fall back to the old swap-only behavior (kept so legacy
    callers that don't pass bucket don't crash) and flag the result
    `override_inconsistent` if the sum drifts.

    Does NOT re-clamp calories against MIN_SAFE_CALORIES — when the user
    manually pins calories we trust them and let the debug flags surface
    any inconsistency.
    """
    if not overrides:
        return targets

    any_override = any(v is not None for v in (
        overrides.calories, overrides.protein, overrides.carbs, overrides.fat,
    ))
    if not any_override:
        return targets

    # Snapshot calculated values so the UI can show "original → override".
    calc_cal  = targets.calories
    calc_prot = targets.protein_g
    calc_carb = targets.carbs_g
    calc_fat  = targets.fat_g

    pinned_cal  = overrides.calories  # int | None
    pinned_prot = overrides.protein
    pinned_carb = overrides.carbs
    pinned_fat  = overrides.fat

    # ── Recompute path ─────────────────────────────────────────────────────
    # We recompute whenever we have enough context (bucket + weight) AND at
    # least one of protein/carbs/fat is NOT pinned. If all three macros are
    # pinned, there's nothing to recompute and we just swap values in.
    can_recompute = bucket is not None and weight_lbs is not None
    all_three_pinned = (
        pinned_prot is not None and pinned_carb is not None and pinned_fat is not None
    )

    if can_recompute and not all_three_pinned:
        final_cal = pinned_cal if pinned_cal is not None else calc_cal

        # Protein: pinned wins, else keep calculated (bodyweight-driven,
        # independent of calorie changes).
        final_prot = pinned_prot if pinned_prot is not None else calc_prot

        # Fat: pinned wins, else recompute from final calories using bucket %.
        if pinned_fat is not None:
            final_fat = pinned_fat
        else:
            final_fat = step_6_calculate_fat_g(final_cal, weight_lbs, bucket)  # type: ignore[arg-type]

        # Carbs: pinned wins, else whatever calories are left after P + F,
        # with the bucket's carb floor / fat floor honored (step 7 handles
        # both). When carbs are NOT pinned but fat IS, we still run step 7
        # but the fat input is the user's pinned value; the floor-transfer
        # logic inside step 7 will respect that fat is fixed IF carbs end
        # up in-range, otherwise it may adjust fat. We only preserve the
        # pinned fat if step 7 didn't move it.
        if pinned_carb is not None:
            final_carb = pinned_carb
            # Macros may now disagree with stated calories — that's the
            # user's call. Debug flag below will surface it.
        else:
            recomputed_carb, recomputed_fat = step_7_calculate_carbs_g(
                final_cal, final_prot, final_fat, weight_lbs, bucket,  # type: ignore[arg-type]
            )
            final_carb = recomputed_carb
            # Only let step 7 move fat if the user didn't pin it.
            if pinned_fat is None:
                final_fat = recomputed_fat
    else:
        # Legacy fall-through: swap pinned, keep calculated for the rest.
        final_cal  = pinned_cal  if pinned_cal  is not None else calc_cal
        final_prot = pinned_prot if pinned_prot is not None else calc_prot
        final_carb = pinned_carb if pinned_carb is not None else calc_carb
        final_fat  = pinned_fat  if pinned_fat  is not None else calc_fat

    # ── Diagnostics ────────────────────────────────────────────────────────
    drift = macro_consistency_delta(final_cal, final_prot, final_carb, final_fat)
    # 3 kcal tolerance absorbs rounding jitter (each macro is rounded to
    # int, so the sum can legitimately differ from stated calories by a
    # couple kcal even when everything was recomputed cleanly).
    inconsistent = abs(drift) > 3

    below_floor = False
    if weight_lbs is not None:
        fat_floor = math.ceil(weight_lbs * FAT_FLOOR_G_PER_LB)
        if final_fat < fat_floor:
            below_floor = True

    return CalorieTargets(
        calories=final_cal,
        protein_g=final_prot,
        carbs_g=final_carb,
        fat_g=final_fat,
        bmr=targets.bmr,
        activity_multiplier=targets.activity_multiplier,
        tdee=targets.tdee,
        goal_adjustment_kcal=targets.goal_adjustment_kcal,
        bucket_name=targets.bucket_name,
        rate_summary=(
            f"{targets.rate_summary} (manual override applied by user)"
        ),
        override_applied=True,
        min_calories_enforced=targets.min_calories_enforced,
        consistency_kcal_delta=drift,
        override_inconsistent=inconsistent,
        override_fat_below_floor=below_floor,
        calculated_calories=calc_cal,
        calculated_protein_g=calc_prot,
        calculated_carbs_g=calc_carb,
        calculated_fat_g=calc_fat,
    )


# ─── Main entry point ────────────────────────────────────────────────────────

def compute_targets(inputs: CalorieInputs) -> CalorieTargets:
    """Run the full pipeline. This is the only function external callers
    should touch.

    Reads like pseudocode — each line is one step from above. If you want
    to understand the math, read this function top-to-bottom then dive
    into whichever step you have questions about.
    """
    bucket = get_bucket_for_goal(inputs.goal_id)

    # Step 1-3: BMR → activity multiplier → TDEE (maintenance calories)
    bmr = step_1_calculate_bmr(inputs)
    multiplier = step_2_calculate_activity_multiplier(
        inputs.training_days_per_week, inputs.session_minutes,
    )
    tdee = step_3_calculate_tdee(bmr, multiplier)

    # Step 4: apply goal-specific calorie adjustment
    goal_adjustment, rate_summary = step_4_calculate_goal_adjustment(inputs, bucket, tdee)
    calories_raw = tdee + goal_adjustment

    # Per-day calorie safety floor: prevent dangerously low targets.
    gender = (inputs.gender or "").lower()
    min_floor = 1500 if gender == "male" else 1200
    if calories_raw < min_floor:
        calories = min_floor
        min_enforced = True
    else:
        calories = calories_raw
        min_enforced = False

    # Step 5-7: protein → fat → carbs
    protein_g = step_5_calculate_protein_g(inputs.weight_lbs, bucket)
    fat_g = step_6_calculate_fat_g(calories, inputs.weight_lbs, bucket)
    carbs_g, fat_g = step_7_calculate_carbs_g(calories, protein_g, fat_g, inputs.weight_lbs, bucket)

    calculated = CalorieTargets(
        calories=calories,
        protein_g=protein_g,
        carbs_g=carbs_g,
        fat_g=fat_g,
        bmr=bmr,
        activity_multiplier=multiplier,
        tdee=tdee,
        goal_adjustment_kcal=goal_adjustment,
        bucket_name=bucket.name,
        rate_summary=rate_summary,
        override_applied=False,
        min_calories_enforced=min_enforced,
        consistency_kcal_delta=macro_consistency_delta(calories, protein_g, carbs_g, fat_g),
    )

    # Step 8: apply manual overrides (if any). Last step so the user
    # always sees what WOULD have been calculated in the debug fields
    # even when they pin a manual value. Passes bucket + weight so
    # partial overrides can recompute the non-pinned macros instead of
    # producing an internally inconsistent target.
    return step_8_apply_custom_overrides(
        calculated,
        inputs.custom_overrides,
        bucket=bucket,
        weight_lbs=inputs.weight_lbs,
    )


# ─── Cut / bulk / maintain reference card ────────────────────────────────────
#
# A convenience that runs the full calculator three times — once each for
# fat loss, body recomp (maintenance), and muscle gain — so the user can
# see all three targets side by side in the UI. Uses the user's own body
# stats + training volume, so the numbers reflect THEIR TDEE.
#
# This is read-only — it doesn't override the user's chosen goal. It's
# purely informational ("if you switched goals, here's what your targets
# would become").


@dataclass(frozen=True)
class CalorieRangeCard:
    """Three parallel targets at moderate pace for fat loss, maintain,
    and muscle gain. Shown to the user in the profile so they can see
    their cut / maintenance / bulk calories at a glance.

    Calories, protein, and the user-visible calculation basis are included.
    The full macro split is still available via `compute_targets()` if needed.
    """
    maintenance_calories: int        # TDEE/maintenance target at moderate pace
    cut_calories: int                # fat-loss bucket, moderate pace
    bulk_calories: int               # muscle-gain bucket, moderate pace
    cut_protein_g: int
    maintain_protein_g: int
    bulk_protein_g: int
    bmr: int
    activity_multiplier: float
    weight_lbs: float
    height_feet: int
    height_inches: int
    age: int
    gender: str
    training_days_per_week: int
    session_minutes: int
    session_duration_label: str
    formula: str
    activity_level: str
    cut_adjustment_kcal: int
    maintenance_adjustment_kcal: int
    bulk_adjustment_kcal: int


def calculate_reference_ranges(inputs: CalorieInputs) -> CalorieRangeCard:
    """Run the calculator three times with the user's body stats + training
    volume to produce a cut / maintain / bulk reference card.

    Uses moderate pace for all three so the numbers are comparable. Pace
    is locked here — callers don't get to influence it, because the
    whole point of the card is "here's what a sensible default looks like
    in each direction".
    """
    def _inputs_for(goal_id: str) -> CalorieInputs:
        return CalorieInputs(
            weight_lbs=inputs.weight_lbs,
            height_feet=inputs.height_feet,
            height_inches=inputs.height_inches,
            age=inputs.age,
            gender=inputs.gender,
            training_days_per_week=inputs.training_days_per_week,
            session_minutes=inputs.session_minutes,
            goal_id=goal_id,
            pace="moderate",
        )

    cut = compute_targets(_inputs_for("fat_loss"))
    maintain = compute_targets(_inputs_for("body_recomp"))
    bulk = compute_targets(_inputs_for("muscle_gain"))

    def _duration_label(minutes: int) -> str:
        if minutes <= 30:
            return "20-30 min"
        if minutes <= 45:
            return "30-45 min"
        if minutes <= 60:
            return "45-60 min"
        if minutes <= 75:
            return "60-75 min"
        return "75-90 min"

    def _activity_level(multiplier: float) -> str:
        if multiplier <= 1.2:
            return "sedentary"
        if multiplier <= 1.375:
            return "light"
        if multiplier <= 1.55:
            return "moderate"
        return "very_active"

    return CalorieRangeCard(
        maintenance_calories=maintain.calories,
        cut_calories=cut.calories,
        bulk_calories=bulk.calories,
        cut_protein_g=cut.protein_g,
        maintain_protein_g=maintain.protein_g,
        bulk_protein_g=bulk.protein_g,
        bmr=maintain.bmr,
        activity_multiplier=maintain.activity_multiplier,
        weight_lbs=inputs.weight_lbs,
        height_feet=inputs.height_feet,
        height_inches=inputs.height_inches,
        age=inputs.age,
        gender=(inputs.gender or "").lower(),
        training_days_per_week=inputs.training_days_per_week,
        session_minutes=inputs.session_minutes,
        session_duration_label=_duration_label(inputs.session_minutes),
        formula="Mifflin-St Jeor",
        activity_level=_activity_level(maintain.activity_multiplier),
        cut_adjustment_kcal=cut.goal_adjustment_kcal,
        maintenance_adjustment_kcal=maintain.goal_adjustment_kcal,
        bulk_adjustment_kcal=bulk.goal_adjustment_kcal,
    )
