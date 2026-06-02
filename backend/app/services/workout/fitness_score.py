"""4-pillar composite fitness score.

Replaces the older ad-hoc "fitness score" that was computed from a grab
bag of counts (variety, duration, volume, etc.) with a transparent
composite of four pillars:

    Strength    — relative-to-bodyweight 1RM ratios vs standard targets
    Cardio      — VO2 max + aerobic/interval work vs ACSM baseline
    Consistency — sessions-completed vs planned over rolling 14 days
    Recovery    — sleep + RPE trend; placeholder when data is missing

Every pillar is deterministic and pure — inputs in, number out. No LLM,
no randomness, no implicit time-of-day behavior. The endpoint in
`routers/ai/progression.py` hands the raw data (performance profiles,
recent completions, user profile, sleep/RPE) to `compute_fitness_score`
and the result is JSON-serialized for the Progress screen.

Design notes
------------
- Each pillar returns a 0-100 subscore AND a short one-line reason
  string ("cleared ACSM cardio baseline", "3 of 5 lifts above
  intermediate threshold"), so the UI can render a "what's pulling
  the score" breakdown without needing the caller to reverse-engineer
  the math.
- Missing data degrades gracefully: Strength returns 0 if the user has
  no 1RM history; Recovery returns a sentinel subscore and a
  "connect Apple Health" reason when sleep/RPE are unavailable.
- Sparse-history users get adaptive windows: when `history_days`
  (days since the first logged workout) is shorter than a pillar's
  14- or 28-day window, that pillar's target scales down so a strong
  first week isn't scored against a full-window bar. `history_days`
  is optional — omit it and every pillar uses its full fixed window.
- The headline number is a simple weighted average (strength 30,
  cardio 30, consistency 25, recovery 15) — not a geometric mean, to
  keep the math explainable. Recovery is weighted lowest because its
  input quality is the worst today.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Iterable, Optional


# ── Pillar weights (must sum to 100) ───────────────────────────────
_WEIGHT_STRENGTH = 30
_WEIGHT_CARDIO = 30
_WEIGHT_CONSISTENCY = 25
_WEIGHT_RECOVERY = 15

# ── Strength thresholds ────────────────────────────────────────────
# Relative-to-bodyweight 1RM targets for an "intermediate" lifter.
# Source: Strength Level / Lon Kilgore standards, male intermediate
# column. Women typically score ~0.7x these for the same classification;
# we don't currently have reliable user-gender plumbed through, so we
# use the same numbers for everyone and document that the score is
# gender-blind. A gender-aware pass is a future refinement.
_STRENGTH_THRESHOLDS: dict[str, float] = {
    "barbell_back_squat": 1.5,
    "barbell_front_squat": 1.2,
    "barbell_bench_press": 1.0,
    "dumbbell_bench_press": 0.75,   # DB press scales ~0.75x of barbell
    "overhead_press": 0.66,
    "barbell_deadlift": 2.0,
    "romanian_deadlift": 1.5,
    "barbell_row": 1.0,
    "pendlay_row": 1.0,
}

# ── Cardio thresholds (VO2 + ACSM baseline) ────────────────────────
# ACSM recommends 150 min/week of moderate aerobic work ("Zone 2")
# OR 75 min/week of vigorous work. These targets are combined with
# direct VO2 max when HealthKit provides it.
_CARDIO_Z2_TARGET_MIN_PER_WEEK = 150
_CARDIO_INTERVAL_TARGET_PER_WEEK = 2

# ── Recovery thresholds ────────────────────────────────────────────
_RECOVERY_SLEEP_IDEAL_MIN = 7.0
_RECOVERY_SLEEP_IDEAL_MAX = 9.0
_RECOVERY_RPE_OK_CEILING = 8.0  # avg RPE ≤ 8 = not overreaching


# ── Types ───────────────────────────────────────────────────────────


@dataclass
class PillarScore:
    """One of the four component scores. 0-100 subscore plus a short
    human-readable reason string for UI display. `data_quality` lets
    the UI de-emphasize pillars that are running on thin inputs (e.g.
    Recovery with no sleep data)."""
    name: str
    score: float              # 0..100
    reason: str               # one short sentence
    data_quality: str         # "full" | "partial" | "missing"


@dataclass
class CompositeFitnessScore:
    total: float              # 0..100 headline number
    rating: str               # "Elite" / "Strong" / "Solid" / "Building" / "Starting"
    pillars: list[PillarScore] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "total": round(self.total, 1),
            "rating": self.rating,
            "pillars": [
                {
                    "name": p.name,
                    "score": round(p.score, 1),
                    "reason": p.reason,
                    "dataQuality": p.data_quality,
                }
                for p in self.pillars
            ],
        }


# ── Strength pillar — deep 5-component composite ──────────────────
#
# Strength used to be a flat average of relative-to-bodyweight ratios
# across 9 showcase lifts. That was easy to compute but meant a user
# who trained EVERY DAY but never touched the showcase lifts scored
# 0. The new composite rewards everything the user actually does:
#
#   1. Compound base (35) — relative-to-BW on showcase lifts (the
#      old computation, kept as the anchor since it's the one signal
#      that compares users meaningfully)
#   2. Movement pattern coverage (20) — 1 point per fundamental
#      pattern hit (squat, hinge, h-push, v-push, h-pull, v-pull),
#      scaled to 20
#   3. Volume load (15) — total weight × reps logged across all
#      exercises in the last 28 days, scaled by bodyweight to compare
#      across users (~50,000 lb·reps/lb-bw = full credit)
#   4. Progression trend (15) — fraction of distinct lifts whose top
#      set increased over the last 4 weeks vs the prior 4 weeks
#   5. Variety (15) — distinct exercises trained in the last 28 days
#      (12+ = full credit; encourages well-rounded work)
#
# Total still 0-100. Each sub-component degrades gracefully when the
# data isn't there; a brand-new user with one logged session gets
# partial credit instead of 0.
_PATTERNS_TO_COVER = (
    "squat",            # squat
    "hinge",            # deadlift / RDL / good morning
    "horizontal_press", # bench / pushup
    "vertical_press",   # OHP / handstand
    "horizontal_pull",  # row
    "vertical_pull",    # pulldown / pullup
)
_VOLUME_LOAD_FULL_CREDIT = 50000.0  # lb·reps per lb of bodyweight, 28-day window
_VARIETY_FULL_CREDIT_EXERCISES = 12


@dataclass
class _StrengthBreakdown:
    compound_base: float
    pattern_coverage: float
    volume_load: float
    progression: float
    variety: float

    def total(self) -> float:
        return min(100.0, sum([
            self.compound_base, self.pattern_coverage,
            self.volume_load, self.progression, self.variety,
        ]))


def _score_strength_compound_base(
    profiles: dict,
    bodyweight_lbs: float,
    *,
    strength_signals: dict | None = None,
) -> tuple[float, int, int]:
    """Returns (subscore_0_to_35, lifts_with_data, lifts_at_intermediate).

    When `strength_signals` is provided (output of
    `build_strength_signal_profile`), each lift's eRM comes from the
    fatigue-aware Fresh Strength Signal — late-session squats no longer
    inflate the relative-to-bodyweight ratio. Falls back per-slug to
    the raw `profiles[slug].estimated_1rm_lbs` whenever the signal is
    missing or `data_quality == 'missing'`, so users with no RIR data
    still score normally.

    Load-recommendation paths (recommendation.py / set_programming.py)
    deliberately keep using the raw profile — see the architecture
    note in `strength_signal.py`. Mixing the two surfaces would
    under-prescribe weight for a user with sparse fresh-set data.
    """
    lift_scores: list[float] = []
    lifts_at_intermediate = 0
    for slug, threshold in _STRENGTH_THRESHOLDS.items():
        # Prefer fresh signal; fall back to raw Epley.
        sig = (strength_signals or {}).get(slug)
        signal_lbs: float = 0.0
        if sig is not None and getattr(sig, "estimated_one_rep_max", 0) > 0 and getattr(sig, "data_quality", "missing") != "missing":
            signal_lbs = float(sig.estimated_one_rep_max)
        if signal_lbs <= 0:
            p = profiles.get(slug)
            if p is None or getattr(p, "estimated_1rm_lbs", 0) <= 0:
                continue
            signal_lbs = float(p.estimated_1rm_lbs)
        ratio = signal_lbs / bodyweight_lbs
        lift_scores.append(min(100.0, (ratio / threshold) * 100.0))
        if ratio >= threshold:
            lifts_at_intermediate += 1
    if not lift_scores:
        return (0.0, 0, 0)
    avg = sum(lift_scores) / len(lift_scores)
    # Scale 0-100 → 0-35
    return (avg * 0.35, len(lift_scores), lifts_at_intermediate)


def _score_strength_pattern_coverage(patterns_hit: set) -> float:
    """20 points for hitting all 6 fundamental movement patterns."""
    if not patterns_hit:
        return 0.0
    hit = sum(1 for p in _PATTERNS_TO_COVER if p in patterns_hit)
    return (hit / len(_PATTERNS_TO_COVER)) * 20.0


def _score_strength_volume_load(
    volume_load_lbs: float,
    bodyweight_lbs: float,
    *,
    window_days: int = 28,
) -> float:
    """15 points for hitting the full-credit volume threshold (~50k lb·reps
    per lb of bodyweight over 28 days). Scales linearly below. For a
    sparse-history user the full-credit threshold shrinks pro-rata with
    `window_days` so they're judged on volume-per-day, not a 28-day total."""
    if bodyweight_lbs <= 0 or volume_load_lbs <= 0:
        return 0.0
    per_bw = volume_load_lbs / bodyweight_lbs
    full_credit = _VOLUME_LOAD_FULL_CREDIT * (max(1, window_days) / 28.0)
    if full_credit <= 0:
        return 0.0
    return min(15.0, (per_bw / full_credit) * 15.0)


def _score_strength_progression(progression_ratio: float) -> float:
    """15 points when 100% of tracked lifts are progressing. `progression_ratio`
    is the fraction of distinct lifts whose recent-window top set is
    above the prior-window top set. Computed by the caller from the
    raw performance profile, since this module doesn't read history."""
    if progression_ratio <= 0:
        return 0.0
    return min(15.0, progression_ratio * 15.0)


def _score_strength_variety(distinct_exercises: int, *, window_days: int = 28) -> float:
    """15 points for 12+ distinct exercises in the 28-day window. The
    full-credit count shrinks pro-rata for a sparse-history user so a
    first week of varied work isn't held to a 4-week bar."""
    if distinct_exercises <= 0:
        return 0.0
    full_credit = max(1.0, _VARIETY_FULL_CREDIT_EXERCISES * (max(1, window_days) / 28.0))
    return min(15.0, (distinct_exercises / full_credit) * 15.0)


def _effective_window_days(history_days: Optional[int], full_window: int) -> int:
    """How many days of trainable history the user actually has inside a
    pillar's window. `history_days` is days since the first logged
    workout; None — or a value at/above the full window — means use the
    full window. Clamped to >= 1 so a brand-new user's target never
    collapses to zero: they're scored against what they *could* have
    done so far, not a fixed 2- or 4-week target."""
    if history_days is None or history_days >= full_window:
        return full_window
    return max(1, history_days)


def _score_strength(
    profiles: dict,                       # {slug: ExercisePerformance}
    bodyweight_lbs: Optional[float],
    *,
    patterns_hit: Optional[set] = None,
    volume_load_lbs: float = 0.0,
    distinct_exercises: int = 0,
    progression_ratio: float = 0.0,
    strength_signals: Optional[dict] = None,
    history_days: Optional[int] = None,
) -> PillarScore:
    """5-component strength pillar. See the comment block above for
    the rationale and weights. The caller in `progression.py` gathers
    `patterns_hit`, `volume_load_lbs`, `distinct_exercises`, and
    `progression_ratio` from the WorkoutSession/ExerciseSet tables
    and hands them in alongside the performance profiles.

    `history_days` shrinks the 28-day volume + variety full-credit
    thresholds for users whose first workout was more recent than that."""
    if not bodyweight_lbs or bodyweight_lbs <= 0:
        return PillarScore(
            name="Strength",
            score=0.0,
            reason="Set your bodyweight in profile to enable strength scoring.",
            data_quality="missing",
        )

    has_any_data = bool(profiles) or bool(patterns_hit) or volume_load_lbs > 0 or distinct_exercises > 0
    if not has_any_data:
        return PillarScore(
            name="Strength",
            score=0.0,
            reason="No logged training yet — complete a workout to start scoring.",
            data_quality="missing",
        )

    str_window = _effective_window_days(history_days, 28)
    compound_base, n_lifts, lifts_at_int = _score_strength_compound_base(
        profiles, bodyweight_lbs, strength_signals=strength_signals,
    )
    pattern_coverage = _score_strength_pattern_coverage(patterns_hit or set())
    volume = _score_strength_volume_load(
        volume_load_lbs, bodyweight_lbs, window_days=str_window,
    )
    progression = _score_strength_progression(progression_ratio)
    variety = _score_strength_variety(distinct_exercises, window_days=str_window)

    breakdown = _StrengthBreakdown(
        compound_base=compound_base,
        pattern_coverage=pattern_coverage,
        volume_load=volume,
        progression=progression,
        variety=variety,
    )
    total = breakdown.total()

    # Pick the most informative reason string based on which sub-
    # components are doing the lifting.
    if n_lifts >= 4 and lifts_at_int >= 2:
        reason = (
            f"{lifts_at_int}/{n_lifts} showcase lifts at intermediate, "
            f"{distinct_exercises} exercises across {sum(1 for p in _PATTERNS_TO_COVER if p in (patterns_hit or set()))}/6 patterns."
        )
    elif distinct_exercises > 0:
        patterns_count = sum(1 for p in _PATTERNS_TO_COVER if p in (patterns_hit or set()))
        reason = (
            f"{distinct_exercises} exercises in {str_window}d, {patterns_count}/6 movement patterns hit, "
            f"{int(volume_load_lbs):,} lb total volume."
        )
    else:
        reason = "Log a few sessions to populate the strength composite."

    quality = "full" if (n_lifts >= 3 and distinct_exercises >= 6) else (
        "partial" if (n_lifts >= 1 or distinct_exercises >= 3) else "partial"
    )
    return PillarScore(name="Strength", score=total, reason=reason, data_quality=quality)


# ── Cardio pillar ──────────────────────────────────────────────────


def _safe_float(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out else None


def _vo2_score(vo2_max: float) -> float:
    if vo2_max >= 50:
        return 95.0
    if vo2_max >= 42:
        return 80.0
    if vo2_max >= 35:
        return 65.0
    if vo2_max >= 28:
        return 45.0
    return 25.0


def _zone_minutes_from_completion(c: dict) -> list[float] | None:
    raw = c.get("hr_summary")
    if not isinstance(raw, dict):
        return None
    zones = raw.get("zoneMinutes") or raw.get("zone_minutes")
    if not isinstance(zones, list) or len(zones) < 5:
        return None
    parsed: list[float] = []
    for z in zones[:5]:
        value = _safe_float(z)
        parsed.append(max(0.0, value or 0.0))
    return parsed if any(v > 0 for v in parsed) else None


def _score_cardio_progression(
    recent_completions: list[dict],
    prior_completions: list[dict] | None,
) -> float | None:
    """Compare recent-window cardio_load to the prior window of equal length.

    Returns a 0–100 subscore, OR None when there isn't enough data on
    either side to make a comparison (which the caller treats as "skip,
    no penalty"). Honest behavior is important here: we shouldn't drag
    a user's pillar down just because they haven't been wearing their
    watch long enough to have a baseline.

    Scoring shape:
      - ratio >= 1.20  → 100  (clear positive trend)
      - ratio  = 1.00  → 65   (maintaining — solid)
      - ratio  = 0.75  → 40   (declining)
      - ratio <= 0.50  → 20
    Linear interpolation in between.
    """
    def _sum_load(rows: list[dict]) -> tuple[float, int]:
        total = 0.0
        sessions = 0
        for c in rows:
            load = _safe_float(c.get("cardio_load"))
            if load is None or load <= 0:
                continue
            total += load
            sessions += 1
        return total, sessions

    recent_load, recent_count = _sum_load(recent_completions or [])
    if not prior_completions:
        return None
    prior_load, prior_count = _sum_load(prior_completions)
    # Need real signal on BOTH sides to make a fair comparison. Without
    # a baseline we have no opinion (return None — no penalty).
    if recent_count < 2 or prior_count < 2:
        return None
    if prior_load <= 0:
        return None

    ratio = recent_load / prior_load
    if ratio >= 1.20:
        return 100.0
    if ratio >= 1.00:
        # 1.00 → 65, 1.20 → 100
        return 65.0 + (ratio - 1.00) * (35.0 / 0.20)
    if ratio >= 0.75:
        # 0.75 → 40, 1.00 → 65
        return 40.0 + (ratio - 0.75) * (25.0 / 0.25)
    if ratio >= 0.50:
        # 0.50 → 20, 0.75 → 40
        return 20.0 + (ratio - 0.50) * (20.0 / 0.25)
    return 20.0


def _score_cardio(
    recent_completions: list[dict],
    *,
    history_days: Optional[int] = None,
    vo2_max: Optional[float] = None,
    prior_window_completions: list[dict] | None = None,
) -> PillarScore:
    """Score cardio fitness from VO2, HR zones, and workout metadata.

    `recent_completions` comes from the last 14 days. HR-zone minutes
    win when available; otherwise explicit cardio labels count more
    than weak proxies such as distance-only walks. ACSM targets scale to
    the observable window: a full 2-week target for an established user,
    or the days since their first workout for a newer one (`history_days`).
    """
    window = _effective_window_days(history_days, 14)
    vo2_value = _safe_float(vo2_max)
    if not recent_completions and vo2_value is None:
        return PillarScore(
            name="Cardio",
            score=0.0,
            reason=f"No cardio logged in the last {window} days and no VO2 max available.",
            data_quality="missing",
        )

    z2_minutes = 0.0
    weak_equiv_minutes = 0.0
    interval_sessions = 0
    has_hr_zone_signal = False
    for c in recent_completions:
        focus = str(c.get("focus") or "").lower()
        category = str(c.get("activity_category") or "").lower()
        subtype = str(c.get("activity_subtype") or "").lower()
        style = str(c.get("cardio_style") or "").lower()
        text = " ".join(x for x in (focus, subtype, style) if x)
        dur_min = (_safe_float(c.get("duration_seconds")) or 0.0) / 60.0
        if dur_min <= 0:
            continue
        is_explicit_non_cardio = category in {"strength", "mobility", "recovery"}
        is_z2 = any(k in text for k in ("zone 2", "zone2", "steady", "z2", "base"))
        is_intervals = any(k in text for k in ("interval", "sprint", "hiit", "tempo"))
        is_any_cardio = any(
            k in text for k in (
                "cardio", "zone", "interval", "sprint", "tempo",
                "hiit", "bike", "run", "treadmill", "row", "swim",
                "cycle", "ride", "walk", "hike", "elliptical", "stair",
            )
        ) or category == "cardio" or (_safe_float(c.get("distance_miles")) or 0.0) > 0
        if is_explicit_non_cardio:
            continue

        zones = _zone_minutes_from_completion(c)
        if zones is not None:
            has_hr_zone_signal = True
            z2_minutes += min(dur_min, zones[1])
            hard_minutes = zones[2] + zones[3] + zones[4]
            hard_share = hard_minutes / max(1.0, sum(zones))
            if is_intervals or (hard_minutes >= 8.0 and hard_share >= 0.20):
                interval_sessions += 1
            continue

        if is_z2:
            z2_minutes += dur_min
        elif is_intervals:
            interval_sessions += 1
        elif is_any_cardio:
            if dur_min < 20:
                continue
            # Unlabeled cardio is an aerobic-volume hint, not proof of
            # Zone 2 quality. Give partial base credit so casual walks
            # help a little without carrying the pillar.
            factor = 0.25 if ("walk" in text or style in {"recovery", "easy"}) else 0.35
            equiv = dur_min * factor
            z2_minutes += equiv
            weak_equiv_minutes += equiv

    # Targets scale to the observable window: 150 Z2 min/week and 2
    # interval sessions/week, multiplied by the number of window weeks.
    weeks = window / 7.0
    z2_target = _CARDIO_Z2_TARGET_MIN_PER_WEEK * weeks
    int_target = _CARDIO_INTERVAL_TARGET_PER_WEEK * weeks
    parts: list[tuple[float, float]] = []
    if z2_minutes > 0 and z2_target > 0:
        parts.append((min(100.0, (z2_minutes / z2_target) * 100.0), 0.45))
    if interval_sessions > 0 and int_target > 0:
        parts.append((min(100.0, (interval_sessions / int_target) * 100.0), 0.25))
    if vo2_value is not None and vo2_value > 0:
        parts.append((_vo2_score(vo2_value), 0.50))

    # Progression sub-pillar — recent cardio load vs prior-window cardio
    # load. Skipped (None) when the prior window has no usable signal so a
    # new-to-cardio user isn't penalized for lacking a baseline. Weight
    # is intentionally light (0.20) — progression is a tiebreaker on top
    # of "are you doing the work," not a dominant signal.
    progression_score = _score_cardio_progression(
        recent_completions, prior_window_completions,
    )
    if progression_score is not None:
        parts.append((progression_score, 0.20))

    if not parts:
        return PillarScore(
            name="Cardio",
            score=0.0,
            reason=f"No scored cardio stimulus in the last {window} days.",
            data_quality="missing",
        )

    total_weight = sum(weight for _, weight in parts)
    total = sum(value * weight for value, weight in parts) / total_weight if total_weight > 0 else 0.0
    weak_only = (
        vo2_value is None
        and interval_sessions == 0
        and z2_minutes > 0
        and weak_equiv_minutes >= z2_minutes * 0.95
    )
    if weak_only:
        total = min(total, 55.0)

    reason_parts = [
        f"{round(z2_minutes)} min aerobic base",
        f"{interval_sessions} interval session{'s' if interval_sessions != 1 else ''}",
    ]
    if vo2_value is not None and vo2_value > 0:
        reason_parts.append(f"VO2 max {vo2_value:.1f}")
    if progression_score is not None:
        if progression_score >= 80:
            reason_parts.append("load trending up")
        elif progression_score <= 40:
            reason_parts.append("load trending down")
        else:
            reason_parts.append("load steady")
    reason = f"{' + '.join(reason_parts)} in the last {window} days."
    has_vo2_signal = vo2_value is not None and vo2_value > 0
    quality = "full" if (has_vo2_signal or has_hr_zone_signal) else "partial"
    return PillarScore(name="Cardio", score=total, reason=reason, data_quality=quality)


# ── Consistency pillar ─────────────────────────────────────────────


def _score_consistency(
    session_count_14d: int,
    days_per_week: int,
    *,
    history_days: Optional[int] = None,
) -> PillarScore:
    """Simple planned-vs-done ratio over a rolling 14-day window.
    Going over target doesn't earn extra credit (cap at 100) — the
    user is only penalized for missing sessions, not rewarded for
    accidentally overtraining. For a sparse-history user the target
    scales to the days since their first workout (`history_days`) so
    they aren't charged for sessions they couldn't have done yet."""
    window = _effective_window_days(history_days, 14)
    per_week = max(1, int(days_per_week or 3))
    target = max(1, round(per_week * window / 7.0))
    ratio = session_count_14d / target if target > 0 else 0.0
    score = min(100.0, ratio * 100.0)
    reason = (
        f"{session_count_14d} of {target} planned sessions completed in the last {window} days."
    )
    quality = "full"
    return PillarScore(name="Consistency", score=score, reason=reason, data_quality=quality)


# ── Recovery pillar ────────────────────────────────────────────────


def _score_recovery(
    recent_sleep_hours: Optional[float],
    avg_session_rpe: Optional[float],
) -> PillarScore:
    """Recovery is the fuzziest pillar because input quality varies.
    Gracefully handles missing data by returning a partial score with
    a "connect Apple Health" hint. Both signals contribute equally."""
    if recent_sleep_hours is None and avg_session_rpe is None:
        return PillarScore(
            name="Recovery",
            score=50.0,  # neutral default so the total isn't crushed
            reason="Connect Apple Health or log RPE to enable recovery scoring.",
            data_quality="missing",
        )

    sleep_pts = 0.0
    if recent_sleep_hours is not None:
        if _RECOVERY_SLEEP_IDEAL_MIN <= recent_sleep_hours <= _RECOVERY_SLEEP_IDEAL_MAX:
            sleep_pts = 50.0
        elif recent_sleep_hours >= 6.0:
            # Partial credit 6-7h or 9-10h
            sleep_pts = 30.0
        elif recent_sleep_hours >= 5.0:
            sleep_pts = 15.0
        else:
            sleep_pts = 5.0

    rpe_pts = 0.0
    if avg_session_rpe is not None:
        if avg_session_rpe <= _RECOVERY_RPE_OK_CEILING:
            rpe_pts = 50.0
        elif avg_session_rpe <= 9.0:
            rpe_pts = 25.0
        else:
            rpe_pts = 10.0

    # If only one signal is present, scale up to 100 so the user
    # isn't punished for not connecting both.
    if recent_sleep_hours is None:
        score = rpe_pts * 2.0
    elif avg_session_rpe is None:
        score = sleep_pts * 2.0
    else:
        score = sleep_pts + rpe_pts

    score = min(100.0, score)
    parts: list[str] = []
    if recent_sleep_hours is not None:
        parts.append(f"{recent_sleep_hours:.1f}h sleep")
    if avg_session_rpe is not None:
        parts.append(f"RPE {avg_session_rpe:.1f}")
    reason = ", ".join(parts) if parts else "No recovery signal available."
    quality = "full" if (recent_sleep_hours is not None and avg_session_rpe is not None) else "partial"
    return PillarScore(name="Recovery", score=score, reason=reason, data_quality=quality)


# ── Public entry point ─────────────────────────────────────────────


def _rating_for(total: float) -> str:
    if total >= 85:
        return "Elite"
    if total >= 70:
        return "Strong"
    if total >= 55:
        return "Solid"
    if total >= 40:
        return "Building"
    return "Starting"


def _age_strength_threshold_multiplier(age: int | None) -> float:
    """Scale the strength thresholds down for older users so the same
    absolute 1RM scores higher. Masters-athlete tables show ~8-12% per
    decade drop after 40 is normal, so a 60yo squatting 1.3x BW is as
    impressive as a 30yo squatting 1.5x BW. Multipliers applied to the
    `_STRENGTH_THRESHOLDS` values (lower multiplier = easier to clear)."""
    if age is None or age < 35:
        return 1.00
    if age < 50:
        return 0.95
    if age < 60:
        return 0.88
    if age < 70:
        return 0.78
    return 0.68


def _age_cardio_target_multiplier(age: int | None) -> float:
    """Relax the 150-min/week cardio target at older ages — maintaining
    any moderate aerobic volume after 65 is clinically meaningful and
    the score should reflect that. <50 unchanged."""
    if age is None or age < 50:
        return 1.00
    if age < 65:
        return 0.87
    return 0.73


def compute_fitness_score(
    *,
    profiles: dict,  # {slug: ExercisePerformance}
    bodyweight_lbs: Optional[float],
    recent_completions: list[dict],
    session_count_14d: int,
    days_per_week: int,
    recent_sleep_hours: Optional[float] = None,
    avg_session_rpe: Optional[float] = None,
    # Strength sub-component inputs — pulled from WorkoutSession +
    # ExerciseSet tables by the caller. All optional; the strength
    # pillar degrades gracefully when they're missing.
    patterns_hit: Optional[set] = None,
    volume_load_lbs: float = 0.0,
    distinct_exercises: int = 0,
    progression_ratio: float = 0.0,
    user_age: Optional[int] = None,
    vo2_max: Optional[float] = None,
    # Days since the user's first logged workout. When shorter than a
    # pillar's 14- or 28-day window, that pillar's target scales down
    # pro-rata (see `_effective_window_days`). None = full fixed windows.
    history_days: Optional[int] = None,
    # Optional fatigue-aware Fresh Strength Signal map (slug → StrengthSignal).
    # When present, the Strength pillar's compound-base sub-score uses
    # the per-lift signal eRM instead of the raw top-set eRM. Caller
    # builds this from `build_strength_signal_profile` and passes it
    # through; load-rec callers do NOT use it.
    strength_signals: Optional[dict] = None,
    # Cardio prior-window completions (days 15–28 ago) for the progression
    # sub-pillar. When None, the progression signal is skipped — no
    # penalty for users without a baseline yet.
    prior_window_completions: Optional[list[dict]] = None,
) -> CompositeFitnessScore:
    """Compose the four pillar subscores into a single 0-100 number
    using the fixed pillar weights at the top of the module.
    Caller-side is in `routers/ai/progression.py::fitness_composite_score`.

    Age adjustment: strength thresholds and cardio-volume target are
    scaled down at older ages so a well-conditioned 65yo can still
    score in the top band without comparing against 25yo benchmarks.
    """
    # Age-adjust the STRENGTH thresholds in place (mutable global copy).
    # Dropping into a local snapshot avoids stepping on the shared dict
    # and keeps the function re-entrant for concurrent users.
    age_mult = _age_strength_threshold_multiplier(user_age)
    if age_mult != 1.0:
        # Temporarily patch the threshold lookup by building a scaled
        # dict and swapping via globals for the nested call. Simpler
        # than threading another parameter through every strength helper.
        global _STRENGTH_THRESHOLDS
        original = _STRENGTH_THRESHOLDS
        _STRENGTH_THRESHOLDS = {k: v * age_mult for k, v in original.items()}
    try:
        strength = _score_strength(
            profiles,
            bodyweight_lbs,
            patterns_hit=patterns_hit,
            volume_load_lbs=volume_load_lbs,
            distinct_exercises=distinct_exercises,
            progression_ratio=progression_ratio,
            strength_signals=strength_signals,
            history_days=history_days,
        )
    finally:
        if age_mult != 1.0:
            _STRENGTH_THRESHOLDS = original  # noqa: F811

    # Age-adjust cardio target the same way.
    cardio_mult = _age_cardio_target_multiplier(user_age)
    if cardio_mult != 1.0:
        global _CARDIO_Z2_TARGET_MIN_PER_WEEK, _CARDIO_INTERVAL_TARGET_PER_WEEK
        orig_z2 = _CARDIO_Z2_TARGET_MIN_PER_WEEK
        orig_int = _CARDIO_INTERVAL_TARGET_PER_WEEK
        _CARDIO_Z2_TARGET_MIN_PER_WEEK = int(orig_z2 * cardio_mult)
        _CARDIO_INTERVAL_TARGET_PER_WEEK = max(1, int(orig_int * cardio_mult))
    try:
        cardio = _score_cardio(
            recent_completions,
            history_days=history_days,
            vo2_max=vo2_max,
            prior_window_completions=prior_window_completions,
        )
    finally:
        if cardio_mult != 1.0:
            _CARDIO_Z2_TARGET_MIN_PER_WEEK = orig_z2  # noqa: F811
            _CARDIO_INTERVAL_TARGET_PER_WEEK = orig_int  # noqa: F811

    consistency = _score_consistency(session_count_14d, days_per_week, history_days=history_days)
    recovery = _score_recovery(recent_sleep_hours, avg_session_rpe)

    total = (
        strength.score * _WEIGHT_STRENGTH
        + cardio.score * _WEIGHT_CARDIO
        + consistency.score * _WEIGHT_CONSISTENCY
        + recovery.score * _WEIGHT_RECOVERY
    ) / 100.0

    return CompositeFitnessScore(
        total=total,
        rating=_rating_for(total),
        pillars=[strength, cardio, consistency, recovery],
    )
