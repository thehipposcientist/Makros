"""Layered starting-weight recommendation for planned exercises.

Given a target canonical exercise and a user's recent performance
profiles, pick the best-available anchor weight using a deterministic
priority ladder:

    1. exact_history       — user has profile for this exact exercise
    2. substitution_group  — user has profile for a direct swap
    3. movement_pattern    — user has profile for a same-pattern lift
    4. muscle_bucket       — user has profile for same primary muscle
                             with a similar equipment bucket
    5. default             — category + experience baseline

Each recommendation carries a weight, a 0–1 confidence, a source tag,
and a human-readable reason string so the UI can explain the choice.

No LLM, no randomness. Every step is auditable.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Literal, Optional

from .performance import ExercisePerformance


RecommendationSource = Literal[
    "exact_history",
    "substitution_group",
    "movement_pattern",
    "muscle_bucket",
    "default",
]


@dataclass
class WeightRecommendation:
    weight_lbs: float
    confidence: float
    source: RecommendationSource
    reason: str


# ── %1RM table ───────────────────────────────────────────────────────────────
# Standard training-max percentages for rep counts. Used to convert an
# estimated 1RM back into a realistic working weight for the prescribed
# rep range. Numbers are rounded and conservative — we prefer to
# under-prescribe for a first session than over-prescribe.
_RPE_PCT = {
    1: 0.95, 2: 0.93, 3: 0.90, 4: 0.88, 5: 0.85, 6: 0.83, 7: 0.80,
    8: 0.78, 9: 0.76, 10: 0.73, 11: 0.71, 12: 0.68, 13: 0.66, 14: 0.64,
    15: 0.62, 16: 0.60, 17: 0.58, 18: 0.57, 19: 0.55, 20: 0.53,
}


def _mid_reps(target_reps: Optional[str], fallback: int = 8) -> int:
    """Mid-point of a rep range string like `"6-8"` or `"10-15"`."""
    if not target_reps:
        return fallback
    s = str(target_reps).strip()
    if s.endswith("s") or "yds" in s:
        return fallback  # time/distance-based — use the default for %1RM lookup
    if "-" in s:
        try:
            lo, hi = s.split("-", 1)
            return max(1, round((int(lo.strip()) + int(hi.strip())) / 2))
        except (ValueError, TypeError):
            return fallback
    try:
        return max(1, int(s))
    except (ValueError, TypeError):
        return fallback


def _round_to_plate(weight_lbs: float, increment: float = 2.5) -> float:
    if weight_lbs <= 0:
        return 0.0
    return round(round(weight_lbs / increment) * increment, 1)


def _estimate_working_weight(
    profile: ExercisePerformance,
    target_reps: Optional[str],
    *,
    transfer_factor: float = 1.0,
    increment: float = 2.5,
) -> float:
    """Convert a performance profile into a working weight for the
    target rep range, with an optional discount when the profile comes
    from a similar (not exact) lift.

    `transfer_factor` is applied to the final working weight: 1.0 for
    an exact match, ~0.95 for substitution-group transfer, 0.85 for
    movement-pattern transfer, 0.75 for muscle-bucket transfer. These
    numbers are intentionally conservative so a first session never
    dumps the user onto an unrealistic load.
    """
    if profile.estimated_1rm_lbs <= 0:
        return 0.0
    reps = max(1, min(20, _mid_reps(target_reps)))
    pct = _RPE_PCT.get(reps, 0.75)
    working = profile.estimated_1rm_lbs * pct * transfer_factor
    return _round_to_plate(working, increment=increment)


def _category(target_ex: dict) -> str:
    """Refined category derivation used by `_CATEGORY_DEFAULTS`.

    The old code lumped every barbell/dumbbell compound into a single
    `"compound"` bucket, which produced a 75 lb intermediate default
    that was way too light for squat/deadlift and too heavy for
    overhead press. Now we split compounds by movement pattern family:

        upper_push   — bench, overhead press, dips, horizontal/vertical press
        upper_pull   — rows, pulldowns, pullups (same family, lighter than push)
        squat        — back squat, front squat, leg press, hack squat
        hinge        — deadlift, RDL, good morning (heaviest family)

    Bodyweight and machine buckets are preserved. Isolation splits
    upper vs. lower so a leg-curl default doesn't share a baseline with
    a lateral raise.
    """
    bucket = (target_ex.get("equipment_bucket") or "").lower()
    if bucket == "bodyweight":
        return "bodyweight"
    if target_ex.get("is_machine"):
        return "machine"
    pattern = (target_ex.get("movement_pattern") or "").lower()
    is_compound = bool(target_ex.get("is_compound"))
    if is_compound:
        if "press" in pattern:
            return "upper_push"
        if "pull" in pattern or "row" in pattern:
            return "upper_pull"
        if pattern == "squat":
            return "squat"
        if pattern == "hinge":
            return "hinge"
        if pattern == "lunge":
            # Loaded lunges sit closer to a squat anchor than a press.
            return "squat"
        return "upper_push"  # unclassified compound — safe mid-range
    # Isolation: split upper vs. lower body so the 20 lb lateral raise
    # default doesn't collide with the 45 lb leg curl default.
    muscle = (target_ex.get("primary_muscle") or "").lower()
    lower_muscles = {"quads", "hamstrings", "glutes", "calves", "adductors", "abductors"}
    return "isolation_lower" if muscle in lower_muscles else "isolation_upper"


# ── Category defaults for first-time lifters with no transferable history.
# Conservative on purpose — better to under-recommend and let the user
# progress up than crush them with a made-up starting weight. Numbers
# are calibrated against typical strength-level tables: a beginner
# intermediate squat defaults to 135 (plates on the bar) vs an OHP at
# 95 — these are reasonable "warm-up-and-feel-it-out" starting loads,
# not working weights for the whole session.
_CATEGORY_DEFAULTS = {
    ("upper_push", "beginner"):      45.0,   # empty barbell
    ("upper_push", "intermediate"):  95.0,
    ("upper_push", "advanced"):     145.0,
    ("upper_pull", "beginner"):      45.0,
    ("upper_pull", "intermediate"):  85.0,
    ("upper_pull", "advanced"):     135.0,
    ("squat", "beginner"):           65.0,
    ("squat", "intermediate"):      135.0,
    ("squat", "advanced"):          205.0,
    ("hinge", "beginner"):           95.0,
    ("hinge", "intermediate"):      155.0,
    ("hinge", "advanced"):          245.0,
    ("isolation_upper", "beginner"):      10.0,
    ("isolation_upper", "intermediate"):  20.0,
    ("isolation_upper", "advanced"):      35.0,
    ("isolation_lower", "beginner"):      25.0,
    ("isolation_lower", "intermediate"):  45.0,
    ("isolation_lower", "advanced"):      85.0,
    ("machine", "beginner"):         50.0,
    ("machine", "intermediate"):     90.0,
    ("machine", "advanced"):        140.0,
    ("bodyweight", "beginner"):       0.0,
    ("bodyweight", "intermediate"):   0.0,
    ("bodyweight", "advanced"):       0.0,
}


def recommend_starting_weight(
    target_exercise: dict,
    profiles: dict[str, ExercisePerformance],
    all_exercises_by_slug: dict[str, dict],
    *,
    target_reps: Optional[str] = None,
    experience: str = "intermediate",
) -> WeightRecommendation:
    """Layered lookup for a planned exercise. See module docstring."""
    target_slug = target_exercise.get("slug") or ""
    target_name = target_exercise.get("name") or target_slug
    target_inc = 5.0 if target_exercise.get("is_compound") else 2.5

    # Tier 1: exact history. Confidence calibration:
    #   1 session  → 0.53  (some data, but one point is weak)
    #   2 sessions → 0.61
    #   3 sessions → 0.69
    #   4 sessions → 0.77
    #   6 sessions → 0.93  (cap slightly below 1.0 — nothing is perfect)
    # The old curve started at 0.75 for one session, which implied the
    # recommendation was "strong" on a single data point. It isn't.
    if target_slug and target_slug in profiles:
        p = profiles[target_slug]
        weight = _estimate_working_weight(p, target_reps, increment=target_inc)
        if weight > 0:
            return WeightRecommendation(
                weight_lbs=weight,
                confidence=min(0.95, 0.45 + 0.08 * p.session_count),
                source="exact_history",
                reason=(
                    f"Based on your last {p.session_count} "
                    f"{target_name} session" + ("s" if p.session_count != 1 else "")
                ),
            )

    # Tier 2: substitution group — exercises the seed marks as direct swaps
    sub_group = target_exercise.get("substitution_group")
    if sub_group:
        candidates: list[tuple[str, ExercisePerformance]] = []
        for slug, ex in all_exercises_by_slug.items():
            if slug == target_slug:
                continue
            if ex.get("substitution_group") != sub_group:
                continue
            p = profiles.get(slug)
            if p is not None:
                candidates.append((slug, p))
        best = _pick_most_recent(candidates)
        if best is not None:
            slug, p = best
            weight = _estimate_working_weight(
                p, target_reps, transfer_factor=0.95, increment=target_inc,
            )
            if weight > 0:
                name = all_exercises_by_slug[slug].get("name", slug)
                # Substitution-group ceiling sits clearly below exact-
                # history confidence so a single-session direct swap
                # never outranks a 1-session exact match.
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=min(0.70, 0.40 + 0.04 * p.session_count),
                    source="substitution_group",
                    reason=f"Transferred from your recent {name} work (direct swap)",
                )

    # Tier 3: movement pattern (e.g. horizontal_press). Only transfer
    # between exercises of the same compound/isolation family so a bench
    # press estimate doesn't end up anchoring dumbbell flies.
    pattern = target_exercise.get("movement_pattern")
    if pattern:
        want_compound = bool(target_exercise.get("is_compound"))
        candidates = []
        for slug, ex in all_exercises_by_slug.items():
            if slug == target_slug:
                continue
            if ex.get("movement_pattern") != pattern:
                continue
            if bool(ex.get("is_compound")) != want_compound:
                continue
            p = profiles.get(slug)
            if p is not None:
                candidates.append((slug, p))
        best = _pick_best_1rm(candidates)
        if best is not None:
            slug, p = best
            weight = _estimate_working_weight(
                p, target_reps, transfer_factor=0.85, increment=target_inc,
            )
            if weight > 0:
                name = all_exercises_by_slug[slug].get("name", slug)
                pretty = pattern.replace("_", " ")
                # Movement-pattern transfer is a coarser signal than a
                # direct substitution-group swap, so its flat confidence
                # sits below the substitution-group ceiling.
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=0.40,
                    source="movement_pattern",
                    reason=f"Estimated from similar {pretty} work ({name})",
                )

    # Tier 4: same primary muscle + same equipment bucket. Last
    # numerical anchor before we give up and use a category default.
    muscle = target_exercise.get("primary_muscle")
    bucket = (target_exercise.get("equipment_bucket") or "").lower()
    if muscle and bucket:
        candidates = []
        for slug, ex in all_exercises_by_slug.items():
            if slug == target_slug:
                continue
            if ex.get("primary_muscle") != muscle:
                continue
            if (ex.get("equipment_bucket") or "").lower() != bucket:
                continue
            p = profiles.get(slug)
            if p is not None:
                candidates.append((slug, p))
        best = _pick_best_1rm(candidates)
        if best is not None:
            slug, p = best
            weight = _estimate_working_weight(
                p, target_reps, transfer_factor=0.75, increment=target_inc,
            )
            if weight > 0:
                # Muscle-bucket transfer: the data is about the right
                # muscle family and the right gear, but the movement
                # itself isn't matched. Lower confidence than
                # movement-pattern transfer by design.
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=0.25,
                    source="muscle_bucket",
                    reason=(
                        f"New exercise estimate based on recent {muscle} "
                        f"{bucket} work"
                    ),
                )

    # Tier 5: category default — zero real data; best-effort baseline.
    cat = _category(target_exercise)
    exp_key = (experience or "intermediate").lower()
    if exp_key not in ("beginner", "intermediate", "advanced"):
        exp_key = "intermediate"
    weight = _CATEGORY_DEFAULTS.get((cat, exp_key), 45.0)
    pretty_cat = cat.replace("_", " ")
    return WeightRecommendation(
        weight_lbs=weight,
        confidence=0.10,
        source="default",
        reason=f"Starting weight for {exp_key} {pretty_cat} movements — adjust after your first set",
    )


def _pick_most_recent(
    candidates: list[tuple[str, ExercisePerformance]],
) -> Optional[tuple[str, ExercisePerformance]]:
    """Prefer the profile whose `last_performed_on` is newest. Ties
    broken by higher estimated 1RM so more-progressed lifts win.

    Used for substitution-group transfers where recency dominates —
    the user's most recent direct swap is almost certainly the most
    representative anchor."""
    if not candidates:
        return None
    def sort_key(item):
        _, p = item
        return (
            p.last_performed_on or date.min,
            p.estimated_1rm_lbs,
        )
    return sorted(candidates, key=sort_key, reverse=True)[0]


def _pick_best_1rm(
    candidates: list[tuple[str, ExercisePerformance]],
) -> Optional[tuple[str, ExercisePerformance]]:
    """Prefer the profile with the highest Epley 1RM. Used for
    movement-pattern and muscle-bucket transfers where the goal is a
    strong anchor, not recency."""
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: item[1].estimated_1rm_lbs, reverse=True)[0]
