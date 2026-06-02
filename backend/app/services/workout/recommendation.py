"""Layered starting-weight recommendation for planned exercises.

Given a target canonical exercise and a user's recent performance
profiles, pick the best-available anchor weight using a deterministic
priority ladder:

    1. exact_history       — user has profile for this exact exercise
       strength_anchor     — user-entered signup baseline for exact lift
    2. substitution_group  — user has profile for a direct swap
    3. movement_pattern    — user has profile for a same-pattern lift
    4. muscle_bucket       — user has profile for same primary muscle
                             with a similar equipment bucket
    5. default             — category + experience baseline

Each recommendation carries a weight, a 0–1 confidence, a source tag,
and a human-readable reason string so the UI can explain the choice.

No LLM, no randomness. Every step is auditable.

Fatigue-aware overlay (layered on top of any tier's base rec):
    `apply_fatigue_override` downshifts the chosen weight by 0%/5%/10%/15%
    based on the current per-muscle fatigue for the target exercise's
    `primary_muscle`. When a downshift fires, the reason string is
    rewritten to cite the fatigue value, and the caller also receives a
    `fatigue_override` flag so the UI can flag the rec visually.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import re
from typing import Literal, Optional

from .exercise_metadata import uses_numeric_load
from .performance import ExercisePerformance
from .recency import adjust_confidence_for_recency, recency_adjustment


RecommendationSource = Literal[
    "exact_history",
    "substitution_group",
    "movement_pattern",
    "muscle_bucket",
    "strength_anchor",
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


def _equipment_text(exercise: dict | None) -> str:
    if not isinstance(exercise, dict):
        return ""
    parts: list[str] = []
    for key in ("equipment_bucket", "equipment", "name", "slug", "laterality"):
        value = exercise.get(key)
        if isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    parts.append(str(item.get("slug") or item.get("name") or ""))
                else:
                    parts.append(str(item))
        elif value is not None:
            parts.append(str(value))
    return " ".join(parts).lower().replace("-", "_").replace(" ", "_")


_UNILATERAL_NAME_RE = re.compile(
    r"\b(single|one|uni(?:lateral)?|alt(?:ernating)?)\s*[-_ ]?(arm|leg|side|hand|sided)\b"
    r"|\b(iso[-_ ]?lateral|suitcase)\b"
)


def _laterality(exercise: dict | None) -> str:
    if not isinstance(exercise, dict):
        return "bilateral"
    explicit = str(exercise.get("laterality") or "").strip().lower()
    if explicit in {"unilateral", "single", "single_side", "single-sided"}:
        return "unilateral"
    if explicit in {"alternating", "alternate"}:
        return "alternating"
    if explicit in {"bilateral", "both", "both_sides", "two_arm", "two_leg"}:
        return "bilateral"
    if explicit == "either":
        return "either"
    if exercise.get("is_unilateral"):
        return "unilateral"
    nameish = f"{exercise.get('name') or ''} {exercise.get('slug') or ''}".lower().replace("_", " ")
    if _UNILATERAL_NAME_RE.search(nameish):
        return "unilateral"
    return "bilateral"


def _is_unilateral_only(exercise: dict | None) -> bool:
    return _laterality(exercise) in {"unilateral", "alternating"}


def _uses_per_dumbbell_load(exercise: dict | None) -> bool:
    """Whether logged/recommended load is one dumbbell, not the pair total."""
    text = _equipment_text(exercise)
    return "dumbbell" in text or "_db_" in f"_{text}_"


def _uses_per_side_load(exercise: dict | None) -> bool:
    """Whether displayed load is one side/handle rather than bilateral total."""
    if _uses_per_dumbbell_load(exercise):
        return True
    if not _is_unilateral_only(exercise):
        return False
    text = _equipment_text(exercise)
    if "bodyweight" in text or "body_weight" in text:
        return False
    return any(
        token in text
        for token in (
            "cable",
            "machine",
            "plate_loaded",
            "landmine",
            "kettlebell",
            "barbell",
            "smith",
        )
    )


def _display_to_total_factor(exercise: dict | None) -> float:
    return 2.0 if _uses_per_side_load(exercise) else 1.0


def _load_unit_transfer_factor(source_exercise: dict | None, target_exercise: dict | None) -> float:
    """Convert a source profile's displayed load into target display units.

    Dumbbell and explicitly unilateral cable/machine movements are logged as
    one side/handle. Barbell, T-bar, bilateral cable, and bilateral machine
    movements are logged as total implement/stack load. Normalize through a
    rough total-load equivalent so a 110 lb seated cable row does not become a
    110 lb single-arm cable row, and a 50 lb single-arm row does not become a
    50 lb bilateral row.
    """
    return _display_to_total_factor(source_exercise) / _display_to_total_factor(target_exercise)


def _load_semantics(exercise: dict | None) -> str:
    if not isinstance(exercise, dict):
        return "resistance"
    explicit = str(exercise.get("load_semantics") or "").strip().lower()
    if explicit in {"assistance", "counterweight"}:
        return "assistance"
    text = _equipment_text(exercise)
    nameish = f"{exercise.get('name') or ''} {exercise.get('slug') or ''}".lower()
    if not uses_numeric_load(exercise):
        return "non_numeric"
    if "assisted_pullup_machine" in text or "counterweight" in nameish:
        return "assistance"
    if "assisted" in nameish and ("pull" in nameish or "dip" in nameish):
        return "assistance"
    return "resistance"


def _load_semantics_compatible(source_exercise: dict | None, target_exercise: dict | None) -> bool:
    """Prevent inverse-load assistance numbers from becoming resistance loads."""
    return _load_semantics(source_exercise) == _load_semantics(target_exercise)


def _recommendation_increment(target_exercise: dict) -> float:
    if not uses_numeric_load(target_exercise):
        return 0.0
    if _uses_per_side_load(target_exercise):
        return 5.0 if target_exercise.get("is_compound") else 2.5
    return 5.0 if target_exercise.get("is_compound") else 2.5


def _laterality_compatible_for_direct_swap(source_exercise: dict | None, target_exercise: dict | None) -> bool:
    source = _laterality(source_exercise)
    target = _laterality(target_exercise)
    if source == target:
        return True
    return "either" in {source, target}


def _estimate_working_weight(
    profile: ExercisePerformance,
    target_reps: Optional[str],
    *,
    transfer_factor: float = 1.0,
    increment: float = 2.5,
    load_unit_factor: float = 1.0,
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
    working = profile.estimated_1rm_lbs * load_unit_factor * pct * transfer_factor
    return _round_to_plate(working, increment=increment)


def _apply_profile_recency(
    *,
    weight_lbs: float,
    confidence: float,
    reason: str,
    profile: ExercisePerformance,
    increment: float,
    today: date | None,
) -> tuple[float, float, str]:
    adj = recency_adjustment(profile.last_performed_on, today=today)
    if not adj.is_stale:
        return weight_lbs, confidence, reason
    adjusted = _round_to_plate(weight_lbs * adj.load_multiplier, increment=increment)
    adjusted_confidence = adjust_confidence_for_recency(confidence, adj)
    return adjusted, adjusted_confidence, f"{reason}; {adj.reason}"


def _category(target_ex: dict) -> str:
    """Refined category derivation used by `_CATEGORY_DEFAULTS`.

    The old code lumped every barbell/dumbbell compound into a single
    `"compound"` bucket, which produced a 75 lb intermediate default
    that was way too light for squat/deadlift and too heavy for
    overhead press. Now we split compounds by movement pattern family:

        horizontal_push — bench, dips, horizontal / incline press
        vertical_push   — overhead press, shoulder press, push press
        upper_pull   — rows, pulldowns, pullups (same family, lighter than push)
        squat        — back squat, front squat, leg press, hack squat
        hinge        — deadlift, RDL, good morning (heaviest family)

    Bodyweight and machine buckets are preserved. Isolation splits
    upper vs. lower so a leg-curl default doesn't share a baseline with
    a lateral raise.
    """
    bucket = (target_ex.get("equipment_bucket") or "").lower()
    if bucket == "bodyweight" or not uses_numeric_load(target_ex):
        return "bodyweight"
    if target_ex.get("is_machine"):
        return "machine"
    pattern = (target_ex.get("movement_pattern") or "").lower()
    is_compound = bool(target_ex.get("is_compound"))
    if is_compound:
        if pattern in {"vertical_press", "overhead_press"}:
            return "vertical_push"
        if pattern in {"horizontal_press", "chest_press"}:
            return "horizontal_push"
        if "press" in pattern:
            return "horizontal_push"
        if "pull" in pattern or "row" in pattern:
            return "upper_pull"
        if pattern == "squat":
            return "squat"
        if pattern == "hinge":
            return "hinge"
        if pattern == "lunge":
            # Loaded lunges sit closer to a squat anchor than a press.
            return "squat"
        return "horizontal_push"  # unclassified compound — safe mid-range
    # Isolation: split upper vs. lower body so the 20 lb lateral raise
    # default doesn't collide with the 45 lb leg curl default.
    muscle = (target_ex.get("primary_muscle") or "").lower()
    lower_muscles = {"quads", "hamstrings", "glutes", "calves", "adductors", "abductors"}
    return "isolation_lower" if muscle in lower_muscles else "isolation_upper"


# ── Category defaults for first-time lifters with no transferable history.
# Conservative on purpose — better to under-recommend and let the user
# progress up than crush them with a made-up starting weight. Numbers
# are calibrated against typical strength-level tables: a beginner
# intermediate squat defaults to 135 (plates on the bar), while vertical
# pressing starts around an empty bar before per-dumbbell conversion.
# These are reasonable "warm-up-and-feel-it-out" starting loads, not
# working weights for the whole session.
_CATEGORY_DEFAULTS = {
    ("horizontal_push", "beginner"):      45.0,   # empty barbell
    ("horizontal_push", "intermediate"):  95.0,
    ("horizontal_push", "advanced"):     145.0,
    ("vertical_push", "beginner"):        25.0,
    ("vertical_push", "intermediate"):    45.0,
    ("vertical_push", "advanced"):        75.0,
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
    today: date | None = None,
) -> WeightRecommendation:
    """Layered lookup for a planned exercise. See module docstring."""
    target_slug = target_exercise.get("slug") or ""
    target_name = target_exercise.get("name") or target_slug
    if not uses_numeric_load(target_exercise):
        return WeightRecommendation(
            weight_lbs=0.0,
            confidence=0.10,
            source="default",
            reason=f"{target_name} is not tracked with a numeric load",
        )
    target_inc = _recommendation_increment(target_exercise)

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
            if getattr(p, "source", "history") == "strength_anchor":
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=0.45,
                    source="strength_anchor",
                    reason=f"Based on your signup {p.name} baseline",
                )
            confidence = min(0.95, 0.45 + 0.08 * p.session_count)
            reason = (
                f"Based on your last {p.session_count} "
                f"{target_name} session" + ("s" if p.session_count != 1 else "")
            )
            weight, confidence, reason = _apply_profile_recency(
                weight_lbs=weight,
                confidence=confidence,
                reason=reason,
                profile=p,
                increment=target_inc,
                today=today,
            )
            return WeightRecommendation(
                weight_lbs=weight,
                confidence=confidence,
                source="exact_history",
                reason=reason,
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
            if not _laterality_compatible_for_direct_swap(ex, target_exercise):
                continue
            if not _load_semantics_compatible(ex, target_exercise):
                continue
            p = profiles.get(slug)
            if p is not None:
                candidates.append((slug, p))
        best = _pick_most_recent(candidates)
        if best is not None:
            slug, p = best
            source_ex = all_exercises_by_slug.get(slug)
            weight = _estimate_working_weight(
                p,
                target_reps,
                transfer_factor=0.95,
                increment=target_inc,
                load_unit_factor=_load_unit_transfer_factor(source_ex, target_exercise),
            )
            if weight > 0:
                name = all_exercises_by_slug[slug].get("name", slug)
                anchor_label = (
                    f"your signup {p.name} baseline"
                    if getattr(p, "source", "history") == "strength_anchor"
                    else f"your recent {name} work"
                )
                # Substitution-group ceiling sits clearly below exact-
                # history confidence so a single-session direct swap
                # never outranks a 1-session exact match.
                confidence = min(0.70, 0.40 + 0.04 * p.session_count)
                reason = f"Transferred from {anchor_label} (direct swap)"
                weight, confidence, reason = _apply_profile_recency(
                    weight_lbs=weight,
                    confidence=confidence,
                    reason=reason,
                    profile=p,
                    increment=target_inc,
                    today=today,
                )
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=confidence,
                    source="substitution_group",
                    reason=reason,
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
            if not _load_semantics_compatible(ex, target_exercise):
                continue
            p = profiles.get(slug)
            if p is not None:
                candidates.append((slug, p))
        best = _pick_best_1rm(candidates, today=today)
        if best is not None:
            slug, p = best
            source_ex = all_exercises_by_slug.get(slug)
            weight = _estimate_working_weight(
                p,
                target_reps,
                transfer_factor=0.85,
                increment=target_inc,
                load_unit_factor=_load_unit_transfer_factor(source_ex, target_exercise),
            )
            if weight > 0:
                name = all_exercises_by_slug[slug].get("name", slug)
                pretty = pattern.replace("_", " ")
                anchor_label = (
                    f"your signup {p.name} baseline"
                    if getattr(p, "source", "history") == "strength_anchor"
                    else f"similar {pretty} work ({name})"
                )
                # Movement-pattern transfer is a coarser signal than a
                # direct substitution-group swap, so its flat confidence
                # sits below the substitution-group ceiling.
                confidence = 0.40
                reason = f"Estimated from {anchor_label}"
                weight, confidence, reason = _apply_profile_recency(
                    weight_lbs=weight,
                    confidence=confidence,
                    reason=reason,
                    profile=p,
                    increment=target_inc,
                    today=today,
                )
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=confidence,
                    source="movement_pattern",
                    reason=reason,
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
            if not _load_semantics_compatible(ex, target_exercise):
                continue
            p = profiles.get(slug)
            if p is not None:
                candidates.append((slug, p))
        best = _pick_best_1rm(candidates, today=today)
        if best is not None:
            slug, p = best
            source_ex = all_exercises_by_slug.get(slug)
            weight = _estimate_working_weight(
                p,
                target_reps,
                transfer_factor=0.75,
                increment=target_inc,
                load_unit_factor=_load_unit_transfer_factor(source_ex, target_exercise),
            )
            if weight > 0:
                # Muscle-bucket transfer: the data is about the right
                # muscle family and the right gear, but the movement
                # itself isn't matched. Lower confidence than
                # movement-pattern transfer by design.
                confidence = 0.25
                reason = (
                    f"New exercise estimate based on "
                    f"{'your signup ' + p.name + ' baseline' if getattr(p, 'source', 'history') == 'strength_anchor' else 'recent ' + muscle + ' ' + bucket + ' work'}"
                )
                weight, confidence, reason = _apply_profile_recency(
                    weight_lbs=weight,
                    confidence=confidence,
                    reason=reason,
                    profile=p,
                    increment=target_inc,
                    today=today,
                )
                return WeightRecommendation(
                    weight_lbs=weight,
                    confidence=confidence,
                    source="muscle_bucket",
                    reason=reason,
                )

    # Tier 5: category default — zero real data; best-effort baseline.
    cat = _category(target_exercise)
    exp_key = (experience or "intermediate").lower()
    if exp_key not in ("beginner", "intermediate", "advanced"):
        exp_key = "intermediate"
    weight = _CATEGORY_DEFAULTS.get((cat, exp_key), 45.0)
    if _uses_per_side_load(target_exercise) and cat in (
        "horizontal_push",
        "vertical_push",
        "upper_push",
        "upper_pull",
        "squat",
        "hinge",
        "machine",
    ):
        weight = _round_to_plate(weight / 2.0, increment=target_inc)
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
    *,
    today: date | None = None,
) -> Optional[tuple[str, ExercisePerformance]]:
    """Prefer the profile with the highest Epley 1RM. Used for
    movement-pattern and muscle-bucket transfers where the goal is a
    strong anchor, not recency."""
    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda item: (
            item[1].estimated_1rm_lbs
            * recency_adjustment(item[1].last_performed_on, today=today).load_multiplier
        ),
        reverse=True,
    )[0]


# ── Fatigue-aware overlay ────────────────────────────────────────────

# Muscle-group aliases used by the fatigue snapshot. The fatigue model
# has 12 canonical buckets (see activity_impact.FATIGUE_MUSCLES). The
# seed catalog uses slightly finer names (e.g. "traps", "forearms",
# "adductors"). Map the outliers onto the canonical buckets so a
# `primary_muscle` lookup always hits the right fatigue dimension.
_PRIMARY_MUSCLE_TO_FATIGUE_KEY = {
    "traps": "back",
    "lats": "back",
    "forearms": "biceps",
    "adductors": "quads",
    "abductors": "glutes",
    "obliques": "core",
}


@dataclass
class FatigueAdjustment:
    """Result of `apply_fatigue_override`. All fields are already
    adjusted — callers just stamp them onto the outgoing response.

    `fatigue_override` is True iff the fatigue tier triggered a load
    change. `reason` is rewritten to cite the fatigue value; callers
    can pass the original reason through as-is when the override
    doesn't fire (the helper does this internally).
    """
    weight_lbs: float
    confidence: float | str
    reason: str
    fatigue_override: bool


def _fatigue_key_for_muscle(primary_muscle: str | None) -> str | None:
    """Map a seed `primary_muscle` string onto the canonical fatigue
    bucket key. Returns None when the muscle can't be mapped so callers
    can silently skip the override (better than guessing)."""
    if not primary_muscle:
        return None
    key = str(primary_muscle).strip().lower()
    if not key:
        return None
    return _PRIMARY_MUSCLE_TO_FATIGUE_KEY.get(key, key)


def apply_fatigue_override(
    *,
    weight_lbs: float,
    base_confidence: float | str,
    base_reason: str,
    primary_muscle: str | None,
    muscle_fatigue: dict[str, float] | None,
    muscle_label: str | None = None,
) -> FatigueAdjustment:
    """Downshift a base weight recommendation based on the current
    fatigue level of the target exercise's `primary_muscle`.

    Rules (specified in the feature brief):
        fatigue ≤ 0.4 → no change
        0.4 < fatigue ≤ 0.6 → -5% of base weight
        0.6 < fatigue ≤ 0.8 → -10% of base weight
        fatigue > 0.8 → -15% + confidence downgraded to "low"

    Weight is always rounded to the nearest 2.5 lb. `muscle_fatigue`
    can be None or empty (no snapshot yet) — we return the base rec
    unchanged in that case. `muscle_label` is the human-facing name
    used in the reason string (e.g. "Chest" rather than "chest").
    """
    if weight_lbs <= 0 or not muscle_fatigue:
        return FatigueAdjustment(
            weight_lbs=weight_lbs,
            confidence=base_confidence,
            reason=base_reason,
            fatigue_override=False,
        )
    key = _fatigue_key_for_muscle(primary_muscle)
    if key is None:
        return FatigueAdjustment(
            weight_lbs=weight_lbs,
            confidence=base_confidence,
            reason=base_reason,
            fatigue_override=False,
        )
    try:
        fatigue = float(muscle_fatigue.get(key, 0.0) or 0.0)
    except (TypeError, ValueError):
        fatigue = 0.0

    if fatigue <= 0.4:
        return FatigueAdjustment(
            weight_lbs=weight_lbs,
            confidence=base_confidence,
            reason=base_reason,
            fatigue_override=False,
        )

    if fatigue <= 0.6:
        pct = 0.05
        confidence = base_confidence
    elif fatigue <= 0.8:
        pct = 0.10
        confidence = base_confidence
    else:
        pct = 0.15
        confidence = "low"

    new_weight = _round_to_plate(weight_lbs * (1.0 - pct), increment=2.5)
    # No reason text surfaced to the UI — users want just the weight.
    # The `fatigue_override` flag is still emitted so the client can
    # style the number if needed.
    return FatigueAdjustment(
        weight_lbs=new_weight,
        confidence=confidence,
        reason="",
        fatigue_override=True,
    )
