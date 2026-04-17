"""Set-scheme programming, load increments, and intra-workout next-set
recommendations.

This module is the deterministic "programming" layer that sits BETWEEN
exercise selection (which picks the movements) and session execution
(which logs actual performance). It answers three related questions:

    1. How should the N prescribed sets of this exercise be structured?
       (set roles: warmup / heavy_top / backoff / volume / technique)
    2. When the plan says "add load," HOW MUCH is the correct increment
       for THIS exercise? (equipment + compound/isolation aware)
    3. After the user finishes a set, what should the NEXT set look
       like? (load up, hold, reps-first, deload)

All logic is pure: no DB, no LLM, no randomness. Every decision carries
a `reason` so the UI can surface "You beat the top of 6-8 with 2 RIR —
adding 5 lb."

Design notes
------------
- A `PlannedSet` is an annotated slot in the set scheme. It is NOT a
  replacement for `Prescription` — the prescription still owns the
  top-line sets/reps/rest/RIR contract. The set scheme ADDS per-set
  intent and per-set target loads on top of that contract.
- Warmup sets are intentionally NOT emitted by `build_set_scheme`.
  Warmup guidance is shown as separate cues by the active-workout UI
  (`getExerciseWarmupNote`). Mixing warmups into the set scheme would
  make the exposure counts and volume audit misleading.
- Load increments are exposed via `load_increment_for(exercise)` so
  callers never scatter magic "+5 for upper, +10 for lower" checks.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional


# ── Types ───────────────────────────────────────────────────────────

SetType = Literal[
    "warmup",       # ramp-up, not tracked in volume audit
    "heavy_top",    # highest-load set of the exercise, strength-biased
    "backoff",      # moderate-load set(s) after a heavy top, same rep range
    "volume",       # hypertrophy-bias, moderate loads, higher reps
    "technique",    # skill/priming work — fixed reps, light load
]

ProgressionMode = Literal[
    "load_first",   # progress load before reps (heavy/top sets)
    "reps_first",   # progress reps before load (volume/backoff)
    "fixed_skill",  # hold load, grooving skill (technique sets)
]

RecommendationAction = Literal[
    "increase_load",
    "hold_load",
    "reduce_load",
    "keep_reps",
    "add_rep",
]


@dataclass
class PlannedSet:
    """One annotated set slot in the set scheme. Serializable to the
    frontend via `to_dict`; keys are camelCase to match the rest of the
    planner output contract."""
    set_number: int
    set_type: SetType
    target_reps: str
    target_rir: float
    target_weight_lbs: Optional[float]
    progression_mode: ProgressionMode

    def to_dict(self) -> dict:
        return {
            "setNumber": self.set_number,
            "setType": self.set_type,
            "targetReps": self.target_reps,
            "targetRir": self.target_rir,
            "targetWeightLbs": self.target_weight_lbs,
            "progressionMode": self.progression_mode,
        }


@dataclass
class NextSetRecommendation:
    """Deterministic intra-workout recommendation for the next set of
    the same exercise, given what the user just did."""
    next_set_weight_lbs: Optional[float]
    next_set_rep_target: str
    action: RecommendationAction
    explanation: str

    def to_dict(self) -> dict:
        return {
            "nextSetWeightLbs": self.next_set_weight_lbs,
            "nextSetRepTarget": self.next_set_rep_target,
            "action": self.action,
            "explanation": self.explanation,
        }


# ── Load-increment helper ──────────────────────────────────────────

def load_increment_for(exercise: dict) -> float:
    """Return the deterministic load increment for this exercise in
    pounds. Callers should always round to this increment when they
    add/subtract load — never hard-code "+5" or "+10".

    Rules:
      - Lower-body barbell compound (squat, hinge, leg press): 10 lb
      - Upper-body barbell compound (bench, row, OHP, pulldown): 5 lb
      - Dumbbell compound: 5 lb (pairs — per hand effectively +2.5)
      - Dumbbell/cable isolation: 2.5 lb
      - Machine / plate-loaded machine: 5 lb
      - Bodyweight: 0 (progression is reps or tempo, not load)
      - Unknown: 5 lb as a safe default
    """
    bucket = (exercise.get("equipment_bucket") or "").lower()
    if bucket == "bodyweight":
        return 0.0

    is_compound = bool(exercise.get("is_compound"))
    pattern = (exercise.get("movement_pattern") or "").lower()
    lower_body = pattern in ("squat", "hinge", "lunge") or (
        (exercise.get("primary_muscle") or "").lower()
        in ("quads", "hamstrings", "glutes", "adductors", "abductors")
        and is_compound
    )

    if "barbell" in bucket:
        return 10.0 if (is_compound and lower_body) else 5.0
    if "dumbbell" in bucket:
        return 5.0 if is_compound else 2.5
    if "machine" in bucket or "cable" in bucket or "plate" in bucket:
        return 5.0 if is_compound else 2.5
    return 5.0


def round_to_increment(weight_lbs: float, increment: float) -> float:
    """Round a weight down-or-near to the nearest `increment`. Zero
    increment (bodyweight) returns the weight unchanged so callers can
    still read it for display."""
    if increment <= 0 or weight_lbs <= 0:
        return max(0.0, round(weight_lbs, 1))
    return round(round(weight_lbs / increment) * increment, 1)


# ── Rep-range parsing ───────────────────────────────────────────────

def parse_rep_range(reps: str) -> Optional[tuple[int, int]]:
    """Parse strings like "6-8", "10-15", "5" into (lo, hi). Returns
    None for time/distance-based schemes ("30s", "25-40 min")."""
    if not reps:
        return None
    s = str(reps).strip()
    if s.endswith("s") or "min" in s or "yds" in s:
        return None
    if "-" in s:
        try:
            lo, hi = s.split("-", 1)
            return (int(lo.strip()), int(hi.strip()))
        except (ValueError, TypeError):
            return None
    try:
        n = int(s)
        return (n, n)
    except (ValueError, TypeError):
        return None


# ── Set-scheme builder ──────────────────────────────────────────────

# Experience buckets that should get the simplified scheme. Beginners
# don't benefit from the heavy/backoff distinction yet — they need
# consistent straight sets to groove technique and recovery.
_SIMPLE_SCHEME_EXPERIENCE = {"beginner"}


def _heavy_top_load(anchor_weight: float, rep_range: tuple[int, int], increment: float) -> float:
    """The heavy-top load sits at the TOP of the rep range at target
    RIR. The anchor weight from `recommend_starting_weight` is a
    mid-range number (typically the 8-rep working weight). To convert
    that to a "heavy top at the low end of the range" we apply a small
    linear bump proportional to how much wider the working range is
    than the target anchor."""
    if anchor_weight <= 0:
        return 0.0
    lo, hi = rep_range
    # Mid-range reference point used by recommend_starting_weight.
    mid = max(1, round((lo + hi) / 2))
    # For each rep LOWER than mid, add ~3% load. Capped at +12% so a
    # 5-rep target off an 8-rep anchor doesn't double-count compounded
    # RPE uncertainty.
    delta_reps = max(0, mid - lo)
    bump = min(0.12, 0.03 * delta_reps)
    return round_to_increment(anchor_weight * (1.0 + bump), increment)


def _backoff_load(heavy_top: float, increment: float) -> float:
    """Backoff is ~10% below the heavy top, rounded to the movement's
    increment. This is the classic "first set heavy, working sets
    slightly lighter with matching reps" pattern."""
    if heavy_top <= 0:
        return 0.0
    return round_to_increment(heavy_top * 0.90, increment)


def build_set_scheme(
    exercise: dict,
    *,
    total_sets: int,
    reps: str,
    rir_target: float,
    target_weight_lbs: Optional[float],
    goal_bucket: str,
    role: str,
    experience: str = "intermediate",
) -> list[PlannedSet]:
    """Produce the annotated set scheme for one exercise.

    `role` is the planner's slot role ("primary", "secondary",
    "accessory", "isolation", "finisher", etc.). Combined with the
    goal bucket and compound/isolation classification, it drives which
    set types get emitted.

    Rules (deliberately simple and deterministic):

      * Strength goal + primary compound
          → set 1 = heavy_top, rest = backoff (load-first)
      * Strength goal + anything else
          → all volume (reps-first)
      * Muscle gain / body recomp + primary compound
          → set 1 = heavy_top (top work, moderate reps)
          → rest = backoff for sets 2..total, then volume if > 4 sets
      * Muscle gain / recomp + isolation/accessory
          → all volume
      * Any goal + beginner experience
          → all volume (skip the heavy/backoff distinction)
      * Endurance / general_health / mobility / recovery
          → all volume with reps_first progression
      * Technique slot (role contains "technique" or "skill")
          → all technique, fixed_skill progression
    """
    sets = max(1, int(total_sets))
    rep_str = str(reps or "")
    anchor = target_weight_lbs or 0.0
    increment = load_increment_for(exercise)
    is_compound = bool(exercise.get("is_compound"))
    is_primary = role in ("primary", "compound")
    exp = (experience or "intermediate").lower()
    simple = exp in _SIMPLE_SCHEME_EXPERIENCE
    bucket = (goal_bucket or "").lower()
    rng = parse_rep_range(rep_str)

    # Non-numeric rep schemes (e.g. "30s" plank hold, "25-40 min" zone2)
    # always get a single progression mode: fixed_skill. No load logic.
    if rng is None:
        return [
            PlannedSet(
                set_number=i + 1,
                set_type="technique" if "mobility" in bucket or "recovery" in bucket else "volume",
                target_reps=rep_str,
                target_rir=rir_target,
                target_weight_lbs=None,
                progression_mode="fixed_skill",
            )
            for i in range(sets)
        ]

    # Technique-slot short-circuit (kept before the goal-bucket cascade
    # so a "technique" role always produces technique sets regardless
    # of goal).
    if role in ("technique", "skill"):
        return [
            PlannedSet(
                set_number=i + 1,
                set_type="technique",
                target_reps=rep_str,
                target_rir=max(2.0, rir_target),
                target_weight_lbs=round_to_increment(anchor * 0.75, increment) if anchor > 0 else None,
                progression_mode="fixed_skill",
            )
            for i in range(sets)
        ]

    # Beginner / maintenance-style goals: straight sets, reps-first.
    if simple or bucket in ("endurance", "general_health", "maintain"):
        return [
            PlannedSet(
                set_number=i + 1,
                set_type="volume",
                target_reps=rep_str,
                target_rir=rir_target,
                target_weight_lbs=anchor if anchor > 0 else None,
                progression_mode="reps_first",
            )
            for i in range(sets)
        ]

    # Pure strength goal on a primary compound: heavy top + backoff.
    if bucket == "strength" and is_primary and is_compound:
        top = _heavy_top_load(anchor, rng, increment) if anchor > 0 else None
        back = _backoff_load(top, increment) if top else None
        scheme: list[PlannedSet] = []
        for i in range(sets):
            if i == 0:
                scheme.append(PlannedSet(
                    set_number=1, set_type="heavy_top",
                    target_reps=rep_str, target_rir=max(1.0, rir_target - 1.0),
                    target_weight_lbs=top, progression_mode="load_first",
                ))
            else:
                scheme.append(PlannedSet(
                    set_number=i + 1, set_type="backoff",
                    target_reps=rep_str, target_rir=rir_target,
                    target_weight_lbs=back, progression_mode="load_first",
                ))
        return scheme

    # Hypertrophy-biased goals (muscle_gain, body_recomp, fat_loss,
    # athletic_performance) on a primary compound: one top set then
    # backoff, switching to pure volume on set 5+ when sets are high.
    if bucket in ("muscle_gain", "body_recomp", "fat_loss", "athletic_performance") and is_primary and is_compound:
        top = _heavy_top_load(anchor, rng, increment) if anchor > 0 else None
        back = _backoff_load(top, increment) if top else None
        scheme = []
        for i in range(sets):
            if i == 0:
                scheme.append(PlannedSet(
                    set_number=1, set_type="heavy_top",
                    target_reps=rep_str, target_rir=rir_target,
                    target_weight_lbs=top, progression_mode="load_first",
                ))
            elif i < 4:
                scheme.append(PlannedSet(
                    set_number=i + 1, set_type="backoff",
                    target_reps=rep_str, target_rir=rir_target,
                    target_weight_lbs=back, progression_mode="reps_first",
                ))
            else:
                scheme.append(PlannedSet(
                    set_number=i + 1, set_type="volume",
                    target_reps=rep_str, target_rir=rir_target,
                    target_weight_lbs=back, progression_mode="reps_first",
                ))
        return scheme

    # Everything else — isolation, accessories, non-primary compounds,
    # finishers: straight volume sets, reps-first.
    return [
        PlannedSet(
            set_number=i + 1,
            set_type="volume",
            target_reps=rep_str,
            target_rir=rir_target,
            target_weight_lbs=anchor if anchor > 0 else None,
            progression_mode="reps_first",
        )
        for i in range(sets)
    ]


# ── Intra-workout next-set logic ────────────────────────────────────


def recommend_next_set(
    *,
    exercise: dict,
    planned_set: PlannedSet,
    actual_reps: int,
    actual_weight_lbs: float,
    actual_rir: Optional[float] = None,
    rep_range: Optional[tuple[int, int]] = None,
) -> NextSetRecommendation:
    """Given what the user just completed, decide what the next set
    should look like.

    This is deterministic and uses only the per-exercise increment
    helper + set-type intent. Rules:

      * Rep scheme is non-numeric (hold/time): hold load, keep reps.
      * User beat top of range AND has ≥ target_rir left in the tank:
          - load_first set → add one increment to load, hold reps
          - reps_first set → hold load, keep pushing reps next session
                             (intra-workout: hold this set's target)
          - fixed_skill   → hold, reps & load unchanged
      * User hit within the range: hold load, keep reps.
      * User missed the bottom of the range:
          - If actual_rir is 0 or missing AND weight ≥ planned:
              reduce load by one increment
          - Otherwise hold load and encourage another attempt.
    """
    inc = load_increment_for(exercise)
    weight = actual_weight_lbs if actual_weight_lbs > 0 else (planned_set.target_weight_lbs or 0.0)
    rng = rep_range or parse_rep_range(planned_set.target_reps)

    # Non-numeric (timed / held) schemes — no load progression intra-session.
    if rng is None:
        return NextSetRecommendation(
            next_set_weight_lbs=weight if weight > 0 else None,
            next_set_rep_target=planned_set.target_reps,
            action="hold_load",
            explanation="Held-duration or timed set — maintain load and duration for the next set.",
        )

    lo, hi = rng
    rir = actual_rir if actual_rir is not None else planned_set.target_rir
    beat_top = actual_reps > hi
    hit_range = lo <= actual_reps <= hi
    missed = actual_reps < lo

    if beat_top and rir >= max(1.0, planned_set.target_rir - 1.0):
        # Over-performed with technique in the tank. For load-first
        # work, the load goes up right now. For reps-first, hold the
        # load so the user keeps banking reps at this weight — but the
        # next-session engine will bump load after a top-of-range hit.
        if planned_set.progression_mode == "load_first":
            new_w = round_to_increment((weight or 0) + inc, inc) if inc > 0 else weight
            return NextSetRecommendation(
                next_set_weight_lbs=new_w if new_w > 0 else None,
                next_set_rep_target=f"{lo}-{hi}",
                action="increase_load",
                explanation=(
                    f"You hit {actual_reps} reps (top of {lo}-{hi}) with "
                    f"{int(rir)} RIR — adding {int(inc)} lb for the next set."
                ),
            )
        if planned_set.progression_mode == "reps_first":
            return NextSetRecommendation(
                next_set_weight_lbs=weight if weight > 0 else None,
                next_set_rep_target=f"{lo}-{hi}",
                action="hold_load",
                explanation=(
                    f"You beat the {lo}-{hi} target — hold {int(weight)} lb this "
                    f"session; load will bump next session."
                ),
            )
        # fixed_skill
        return NextSetRecommendation(
            next_set_weight_lbs=weight if weight > 0 else None,
            next_set_rep_target=planned_set.target_reps,
            action="hold_load",
            explanation="Skill-priming set — holding load and reps by design.",
        )

    if hit_range:
        return NextSetRecommendation(
            next_set_weight_lbs=weight if weight > 0 else None,
            next_set_rep_target=f"{lo}-{hi}",
            action="hold_load",
            explanation=f"In the {lo}-{hi} target range — hold {int(weight) if weight else 'the same'} lb.",
        )

    if missed:
        # Scale the load drop proportionally to how badly the user
        # missed. Hitting 5 reps when the target is 12-15 is a ~60%
        # miss — dropping one increment (5 lbs) is inadequate. The
        # drop scales with the gap so the next set has a realistic
        # chance of landing in the target range.
        miss_ratio = actual_reps / lo if lo > 0 else 1.0
        if miss_ratio < 0.7 and weight > 0 and inc > 0:
            # Severe miss (hit <70% of target bottom). Drop proportionally.
            # E.g., target 12, hit 5 → miss_ratio=0.42 → scale=0.58 → drop ~42% of weight
            # But cap the percentage drop at 40% to avoid absurd swings.
            drop_pct = min(0.40, 1.0 - miss_ratio)
            drop_lbs = max(inc, round_to_increment(weight * drop_pct, inc))
            new_w = round_to_increment(max(inc, weight - drop_lbs), inc)
            return NextSetRecommendation(
                next_set_weight_lbs=new_w,
                next_set_rep_target=f"{lo}-{hi}",
                action="reduce_load",
                explanation=(
                    f"You hit {actual_reps} reps vs target {lo}-{hi} — "
                    f"dropping to {int(new_w)} lb (−{int(drop_lbs)}) "
                    f"so you can reach the rep range."
                ),
            )
        if miss_ratio < 1.0 and weight > 0 and inc > 0:
            # Moderate miss (hit 70-99% of target bottom). Drop one increment.
            new_w = round_to_increment(max(0.0, weight - inc), inc)
            return NextSetRecommendation(
                next_set_weight_lbs=new_w if new_w > 0 else None,
                next_set_rep_target=f"{lo}-{hi}",
                action="reduce_load",
                explanation=(
                    f"Short of {lo}-{hi} at {int(weight)} lb — "
                    f"dropping {int(inc)} lb so you can hit the range."
                ),
            )
        return NextSetRecommendation(
            next_set_weight_lbs=weight if weight > 0 else None,
            next_set_rep_target=f"{lo}-{hi}",
            action="hold_load",
            explanation=(
                f"Short of {lo}-{hi} — hold load and push for the range on the "
                f"next set."
            ),
        )

    # Fallback — shouldn't happen but keeps the function total.
    return NextSetRecommendation(
        next_set_weight_lbs=weight if weight > 0 else None,
        next_set_rep_target=f"{lo}-{hi}",
        action="hold_load",
        explanation="Hold the planned load.",
    )


# ── Next-session load progression (session-to-session) ─────────────


def recommend_next_session_load(
    *,
    exercise: dict,
    planned_set: PlannedSet,
    last_session_sets: list[dict],
    rep_range: Optional[tuple[int, int]] = None,
) -> tuple[Optional[float], RecommendationAction, str]:
    """Given the user's last-session logged working sets for this
    exercise, decide the target load for the next session.

    `last_session_sets` is a list of `{reps, weight_lbs, rir?}` dicts,
    typically from the `ExerciseSet` model filtered to the most recent
    completed session.

    Rules (double progression, session-level):

      * All working sets at or above the top of the rep range →
          add one increment (load-first) OR keep load and push reps
          (reps-first). Planned-set mode dictates which.
      * Majority of sets below the bottom of the rep range → subtract
          one increment.
      * Otherwise → hold.

    Returns (next_weight_lbs, action, reason). `next_weight_lbs` is
    `None` only when the exercise is bodyweight or the last-session
    data is unusable.
    """
    if not last_session_sets:
        return (planned_set.target_weight_lbs, "hold_load", "No recent data — holding planned load.")

    inc = load_increment_for(exercise)
    rng = rep_range or parse_rep_range(planned_set.target_reps)
    if rng is None:
        return (planned_set.target_weight_lbs, "hold_load", "Non-numeric rep scheme — holding.")
    lo, hi = rng

    top_weight = max((s.get("weight_lbs") or 0.0) for s in last_session_sets)
    reps_at_top = [s.get("reps") or 0 for s in last_session_sets if (s.get("weight_lbs") or 0.0) >= top_weight * 0.98]
    if not reps_at_top:
        return (top_weight or planned_set.target_weight_lbs, "hold_load", "Top-set reps unavailable — holding.")

    all_at_top = all(r >= hi for r in reps_at_top)
    majority_missed = sum(1 for r in reps_at_top if r < lo) > len(reps_at_top) / 2

    if all_at_top:
        if planned_set.progression_mode == "load_first" and inc > 0:
            new_w = round_to_increment(top_weight + inc, inc)
            return (
                new_w,
                "increase_load",
                f"All sets hit the top of {lo}-{hi} last session — adding {int(inc)} lb.",
            )
        # reps_first or fixed_skill: hold load, let reps keep growing.
        return (
            top_weight,
            "hold_load",
            f"You cleared the {lo}-{hi} range — holding load and chasing one more rep.",
        )

    if majority_missed and inc > 0:
        new_w = round_to_increment(max(0.0, top_weight - inc), inc)
        return (
            new_w,
            "reduce_load",
            f"Most sets fell below {lo}-{hi} last session — dropping {int(inc)} lb to reset.",
        )

    return (top_weight, "hold_load", f"Partial progress on {lo}-{hi} — hold and push for a full top-range session.")
