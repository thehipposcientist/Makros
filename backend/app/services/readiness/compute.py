"""Server-side readiness compute — the canonical source.

Why server-side: phone + watch were drifting because both were
computing readiness independently. Two compute paths = race conditions
inevitable, no matter how careful the coordination. Moving compute
here means:

  • One number per user per (re)compute cycle.
  • Phone fetches from this endpoint, displays it, AND pushes the
    EXACT SAME response payload to the watch via WCSession.
  • Watch is a pure consumer — never computes.
  • `computed_at_ms` lets the watch reject stale pushes that arrive
    out-of-order via WC.

Inputs (all optional — degrade gracefully):

  • SleepLog.score for last night
  • DailyHealthSnapshot OR client-passed AH signals (HRV, RHR, steps)
  • MuscleFatigue from compute_rolling_fatigue (recent completions)
  • DailyNutritionMetrics for nutrition adherence
  • Last completed WorkoutCompletion (yesterday's strain)
  • Recent skip reasons for wellness context (illness, pain, low energy)

Output is the same shape today's `services/preparedness.ts` produces
on the client, plus `computed_at_ms` for the WC ordering protocol.
The phone's TrainingReadinessCard renders this verbatim — no client
recomputation. The watch reads it through the existing
WatchReadinessSnapshot bridge.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlmodel import select

from app.models import (
    DailyHealthSnapshot, DailyLifestyleLog, DailyNutritionMetrics,
    PlanDay, SleepLog, UserDayState, WorkoutCompletion,
)
from app.services.health.sleep_pressure import compute_sleep_pressure
from app.services.nutrition.day_completeness import classify_nutrition_day


# ── Pillar weights (must match the legacy client total) ─────────────
# 30 + 20 + 20 + 15 + 10 + 5 = 100. Keeping the same numerator so
# users don't see scores jump when we move compute server-side.
#
# Cycle phase is OPTIONAL (only present when cycle data is available)
# and lives outside the 100-point base. Score is reweighted against
# pillars actually present, so the cycle pillar's weight only affects
# users who have cycle data — male users and unsynced female users see
# no change. This validates "luteal week feels harder" without punishing
# anyone who lacks the data.

W_SLEEP = 30
W_HRV = 20
W_FATIGUE = 20
W_NUTRITION = 15
W_RHR = 10
W_YESTERDAY = 5
W_CYCLE = 10
W_WELLNESS = 10

# Pillars that represent real "today" health signals. The yesterday-
# strain pillar is excluded — it's always available (rest day = full
# credit) and so can't be used to gate a meaningful score.
_HEALTH_PILLARS: frozenset[str] = frozenset({"sleep", "hrv", "rhr", "nutrition", "fatigue", "wellness"})

# Minimum health pillars required before we'll publish a numeric
# readiness score. Below this we return score=0, label="—" and a
# summary asking the user to connect data sources. Was the bug that
# triggered this gate: missed-watch nights produced score=100 from the
# yesterday-strain pillar alone.
_MIN_HEALTH_PILLARS = 2


@dataclass
class ReadinessFactor:
    label: str               # "Sleep" / "RHR" / "HRV" / etc.
    value: int               # 0-100 sub-score for this factor
    status: str              # "good" | "ok" | "low"
    detail: str | None       # human-readable, e.g. "7.4h last night"


@dataclass
class ReadinessResult:
    score: int                # 0-100, the headline readiness
    label: str                # "Primed" | "Ready" | "Moderate" | "Fatigued"
    summary: str              # one-line trainer's read
    factors: list[ReadinessFactor] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    signals_present: int = 0
    signals_total: int = 6
    computed_at_ms: int = 0   # ms-since-epoch — drives WC ordering
    # Per-focus / per-muscle readiness surfaced from the fatigue engine so the
    # client can show "generally ready, but not ready for heavy legs". These
    # are additive — existing clients ignore unknown keys. All are 0-100
    # readiness (100 = fresh), the inverse of the engine's internal fatigue.
    focus_readiness: dict = field(default_factory=dict)   # {"lower": 48, "push": 82, ...}
    muscle_readiness: dict = field(default_factory=dict)  # {"quads": 45, "chest": 90, ...}
    top_fatigued: list = field(default_factory=list)      # [{"muscle": "quads", "readiness": 45}, ...]
    recommendations: list = field(default_factory=list)   # [{"type": "avoid_heavy_lower", ...}]
    explanations: list = field(default_factory=list)      # plain-language reason items

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "label": self.label,
            "summary": self.summary,
            "factors": [
                {"label": f.label, "value": f.value, "status": f.status, "detail": f.detail}
                for f in self.factors
            ],
            "missing": self.missing,
            "signals_present": self.signals_present,
            "signals_total": self.signals_total,
            "computed_at_ms": self.computed_at_ms,
            "focus_readiness": self.focus_readiness,
            "muscle_readiness": self.muscle_readiness,
            "top_fatigued": self.top_fatigued,
            "recommendations": self.recommendations,
            "explanations": self.explanations,
        }


@dataclass(frozen=True)
class SkipWellnessImpact:
    value: int
    cap: int | None
    detail: str
    summary: str
    counts_as_gate: bool


# ── Per-process TTL cache for compute_readiness ────────────────────
#
# Readiness is hit on every app foreground + every watch refresh. Each
# call does ~5–6 small queries (SleepLog, DailyHealthSnapshot×2,
# DailyNutritionMetrics, WorkoutCompletion). For a watch that polls every
# 60s we'd issue >5k queries/day per active user — most returning the
# same value because today's data hasn't changed.
#
# The cache keys on (user_id, signal_signature) so a client passing
# fresh HK numbers gets fresh compute. TTL is short enough that a new
# meal log shows up within a minute.

_READINESS_CACHE_TTL_S = 60.0
_readiness_cache: dict[tuple, tuple[float, "ReadinessResult"]] = {}


def _readiness_cache_key(
    user_id: int,
    avg_sleep_hours: float | None,
    avg_resting_hr: float | None,
    avg_hrv_ms: float | None,
    last_night_sleep_score: int | None,
    nutrition_adherence_pct: float | None,
    planned_focus: str | None = None,
    cycle_phase: str | None = None,
    day_of_cycle: int | None = None,
) -> tuple:
    # Round float signals so trivial decimal noise doesn't break cache hits.
    def _r(v):
        return round(v, 1) if isinstance(v, float) else v
    return (
        user_id,
        _r(avg_sleep_hours), _r(avg_resting_hr), _r(avg_hrv_ms),
        last_night_sleep_score, _r(nutrition_adherence_pct),
        planned_focus,
        cycle_phase, day_of_cycle,
    )


def invalidate_readiness_cache(user_id: int | None = None) -> None:
    """Drop cached readiness results.

    Pass a `user_id` to invalidate just that user (call after meal save,
    workout completion, or HealthKit push). With no argument, drops the
    entire cache (e.g. on schema changes that affect compute output)."""
    if user_id is None:
        _readiness_cache.clear()
        return
    for k in [k for k in _readiness_cache if k[0] == user_id]:
        del _readiness_cache[k]


def _label_for(score: int) -> str:
    if score >= 80:
        return "Primed"
    if score >= 65:
        return "Ready"
    if score >= 45:
        return "Moderate"
    return "Fatigued"


def _summary_for(score: int) -> str:
    if score >= 80:
        return "Solid recovery — train as planned."
    if score >= 65:
        return "Ready for a normal session."
    if score >= 45:
        return "Moderate. Standard intensity is fine; back off if it spikes."
    return "Low. Consider lighter loads or a recovery day."


def _factor_status(value: int) -> str:
    if value >= 75:
        return "good"
    if value >= 50:
        return "ok"
    return "low"


def _self_report_feedback(db: Any, user_id: int, today: date) -> dict | None:
    """Build a fatigue-engine `readiness_feedback` item from today's daily
    check-in (UserDayState soreness / joint pain). Returns None when nothing
    was reported, so missing self-report stays neutral. The engine maps these
    onto the relevant muscles and caps their local readiness — overall
    readiness (the pillar blend) is unaffected unless the planned focus
    overlaps the sore area."""
    try:
        from app.models import UserDayState
        uds = db.exec(
            select(UserDayState)
            .where(UserDayState.user_id == user_id)
            .where(UserDayState.day_key == today)
        ).first()
    except Exception:
        return None
    if uds is None:
        return None
    feedback: dict = {}
    if getattr(uds, "soreness_body_part", None) and getattr(uds, "soreness_severity_0_10", None):
        feedback["soreness"] = [{
            "body_part": uds.soreness_body_part,
            "severity": int(uds.soreness_severity_0_10),
        }]
    if getattr(uds, "pain_present", None) and getattr(uds, "pain_body_part", None):
        feedback["joint_pain"] = [{
            "body_part": uds.pain_body_part,
            # Default a reported-but-unrated pain to the "act with caution"
            # threshold so it still triggers the avoid-heavy recommendation.
            "severity": int(uds.pain_severity_0_10) if uds.pain_severity_0_10 is not None else 5,
        }]
    return feedback or None


def _empty_fatigue_surface() -> dict:
    return {
        "focus_readiness": {},
        "muscle_readiness": {},
        "top_fatigued": [],
        "recommendations": [],
        "explanations": [],
    }


def _fatigue_surface_from_snap(snap: Any) -> dict:
    """Project the rich FatigueSnapshot onto bounded 0-100 readiness surfaces
    for the client. Readiness = 100 - display_fatigue. The engine's own
    overall-vs-local explanation is dropped here and re-added against the
    card's headline score so the numbers the user sees stay consistent."""
    if snap is None:
        return _empty_fatigue_surface()
    try:
        from app.services.workout.activity_impact import LOCAL_MUSCLES

        def _pct(fatigue_0_1: float) -> int:
            return max(0, min(100, round((1.0 - float(fatigue_0_1)) * 100)))

        muscle_readiness = {
            m: _pct(snap.muscle_fatigue.get_display(m)) for m in LOCAL_MUSCLES
        }
        focus_readiness = {
            f: max(0, min(100, round(float(v) * 100))) for f, v in snap.focus_readiness.items()
        }
        top_fatigued = [
            {"muscle": m, "readiness": _pct(v)} for m, v in snap.top_fatigued
        ]
        explanations = [
            e for e in snap.explanations
            if e.get("type") != "overall_ready_local_not_ready"
        ]
        return {
            "focus_readiness": focus_readiness,
            "muscle_readiness": muscle_readiness,
            "top_fatigued": top_fatigued,
            "recommendations": list(snap.recommendations),
            "explanations": explanations,
        }
    except Exception:
        return _empty_fatigue_surface()


# ── Pillar scoring (each returns 0..MAX or None when input missing) ──

def _score_sleep(last_night_score: int | None) -> tuple[int | None, str | None]:
    if last_night_score is None:
        return None, None
    pts = round((last_night_score / 100.0) * W_SLEEP)
    return pts, f"score {last_night_score}"


def _format_sleep_pressure_hours(hours: float, is_capped: bool) -> str:
    total_minutes = int(round(max(0.0, hours) * 60))
    h, m = divmod(total_minutes, 60)
    suffix = "+" if is_capped else ""
    if h <= 0:
        return f"{m}m{suffix}"
    if m == 0:
        return f"{h}h{suffix}"
    return f"{h}h {m}m{suffix}"


def _score_hrv(hrv_ms: float | None, hrv_history: list[float] | None) -> tuple[int | None, str | None]:
    if hrv_ms is None:
        return None, None
    if hrv_history and len(hrv_history) >= 7:
        # Median baseline so a single tank doesn't reset everything.
        baseline = sorted(hrv_history)[len(hrv_history) // 2]
        if baseline > 0:
            ratio = hrv_ms / baseline
            if ratio >= 1.10:
                return W_HRV, f"{int(hrv_ms)}ms (above baseline)"
            if ratio >= 0.98:
                return int(round(W_HRV * 0.85)), f"{int(hrv_ms)}ms (near baseline)"
            if ratio >= 0.90:
                return int(round(W_HRV * 0.65)), f"{int(hrv_ms)}ms (below baseline)"
            return int(round(W_HRV * 0.40)), f"{int(hrv_ms)}ms (well below baseline)"
    # No baseline — absolute thresholds (rough population norms).
    if hrv_ms >= 60:
        return W_HRV, f"{int(hrv_ms)}ms"
    if hrv_ms >= 40:
        return int(round(W_HRV * 0.70)), f"{int(hrv_ms)}ms"
    if hrv_ms >= 25:
        return int(round(W_HRV * 0.45)), f"{int(hrv_ms)}ms"
    return int(round(W_HRV * 0.25)), f"{int(hrv_ms)}ms"


def _score_fatigue(readiness_pct: float | None, detail: str | None = None) -> tuple[int | None, str | None]:
    """Map fatigue readiness (0..100, higher=fresher) onto W_FATIGUE."""
    if readiness_pct is None:
        return None, None
    readiness = max(0.0, min(100.0, readiness_pct))
    pts = int(round((readiness / 100.0) * W_FATIGUE))
    return pts, detail or f"{int(round(readiness))}% recovered"


def _score_nutrition(adherence_pct: float | None) -> tuple[int | None, str | None]:
    if adherence_pct is None:
        return None, None
    pts = int(round((adherence_pct / 100.0) * W_NUTRITION))
    return pts, f"{int(adherence_pct)}% adherence"


def _score_rhr(rhr_bpm: float | None) -> tuple[int | None, str | None]:
    if rhr_bpm is None:
        return None, None
    if rhr_bpm <= 55:
        return W_RHR, f"{int(rhr_bpm)} bpm"
    if rhr_bpm <= 65:
        return int(round(W_RHR * 0.85)), f"{int(rhr_bpm)} bpm"
    if rhr_bpm <= 75:
        return int(round(W_RHR * 0.55)), f"{int(rhr_bpm)} bpm"
    return int(round(W_RHR * 0.30)), f"{int(rhr_bpm)} bpm"


def _score_yesterday(yesterday_minutes: int | None) -> tuple[int | None, str | None]:
    """Light-touch yesterday-strain pillar. Long sessions yesterday
    knock readiness down a bit; rest day = full marks."""
    if yesterday_minutes is None:
        return None, None
    if yesterday_minutes <= 5:
        return W_YESTERDAY, "rest day yesterday"
    if yesterday_minutes <= 45:
        return int(round(W_YESTERDAY * 0.85)), f"{yesterday_minutes}min yesterday"
    if yesterday_minutes <= 75:
        return int(round(W_YESTERDAY * 0.65)), f"{yesterday_minutes}min yesterday"
    return int(round(W_YESTERDAY * 0.40)), f"{yesterday_minutes}min yesterday"


def _pillar_value_100(pillar_scores: dict[str, tuple[int, int]], name: str) -> int | None:
    score = pillar_scores.get(name)
    if not score:
        return None
    got, max_points = score
    if max_points <= 0:
        return None
    return int(round((got / max_points) * 100))


def _overnight_recovery_cap(pillar_scores: dict[str, tuple[int, int]]) -> tuple[int | None, dict | None]:
    sleep = _pillar_value_100(pillar_scores, "sleep")
    hrv = _pillar_value_100(pillar_scores, "hrv")
    rhr = _pillar_value_100(pillar_scores, "rhr")
    if sleep is not None and hrv is not None and sleep < 55 and hrv < 50:
        return 55, {
            "type": "overnight_recovery_cap",
            "severity": "high",
            "message": "Sleep and HRV are both suppressed, so readiness is capped even if other signals look fine.",
        }
    if sleep is not None and sleep < 45:
        return 60, {
            "type": "overnight_recovery_cap",
            "severity": "moderate",
            "message": "Sleep was low enough to cap today's readiness. Keep intensity flexible.",
        }
    if hrv is not None and hrv < 45 and rhr is not None and rhr < 50:
        return 60, {
            "type": "overnight_recovery_cap",
            "severity": "moderate",
            "message": "HRV is low and resting heart rate is elevated, so readiness is capped today.",
        }
    return None, None


def _has_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(n in text for n in needles)


def _classify_skip_wellness(reason: str | None, when: str) -> SkipWellnessImpact | None:
    if not reason:
        return None
    text = reason.strip().lower()
    if not text:
        return None

    logistics = (
        "no time", "busy", "schedule", "appointment", "work conflict",
        "meeting", "commute", "did something else",
    )
    if _has_any(text, logistics):
        return None

    if _has_any(text, ("sick", "ill", "flu", "cold", "fever", "covid", "virus", "infection", "stomach", "nausea", "vomit", "migraine")):
        value = 12 if when == "today" else 20
        cap = 35 if when == "today" else 40
        return SkipWellnessImpact(
            value=value,
            cap=cap,
            detail=f"sick skip {when}",
            summary=f"You skipped {when} because you were sick. Treat today as recovery-first and keep intensity easy until symptoms settle.",
            counts_as_gate=True,
        )

    if _has_any(text, ("injury", "injured", "pain", "hurt", "strain", "sprain", "tweak", "tweaked", "joint", "ache")):
        value = 18 if when == "today" else 25
        cap = 38 if when == "today" else 45
        return SkipWellnessImpact(
            value=value,
            cap=cap,
            detail=f"pain/injury skip {when}",
            summary=f"You skipped {when} for pain or injury. Keep today conservative and avoid loading the irritated area.",
            counts_as_gate=True,
        )

    if _has_any(text, ("too tired", "exhaust", "fatigue", "worn out", "burnt", "burned", "need more rest", "rough night", "poor sleep", "sleep")):
        value = 38 if when == "today" else 45
        cap = 55 if when == "today" else 60
        return SkipWellnessImpact(
            value=value,
            cap=cap,
            detail=f"low-energy skip {when}",
            summary=f"You skipped {when} because recovery felt low. A lighter session or rest day fits better than forcing intensity.",
            counts_as_gate=True,
        )

    if _has_any(text, ("stress", "anxiety", "mental", "overwhelmed")):
        return SkipWellnessImpact(
            value=60,
            cap=75,
            detail=f"stress skip {when}",
            summary=f"You skipped {when} because stress was high. Keep today's plan flexible and stop short of grindy sets.",
            counts_as_gate=False,
        )

    if _has_any(text, ("travel", "travelling", "traveling", "jet lag", "flight")):
        return SkipWellnessImpact(
            value=72,
            cap=85,
            detail=f"travel disruption {when}",
            summary=f"Travel disrupted training {when}. Use readiness as a governor and warm up gradually today.",
            counts_as_gate=False,
        )

    return None


def _skip_reason_for_day(db, user_id: int, day: date) -> str | None:
    state = db.exec(
        select(UserDayState)
        .where(UserDayState.user_id == user_id)
        .where(UserDayState.day_key == day)
    ).first()
    if state and state.skip_reason:
        return state.skip_reason

    plan_day = db.exec(
        select(PlanDay)
        .where(PlanDay.user_id == user_id)
        .where(PlanDay.day_date == day)
        .where(PlanDay.status == "skipped")
        .order_by(PlanDay.updated_at.desc())
    ).first()
    if plan_day and plan_day.skip_reason:
        return plan_day.skip_reason
    return None


def _recent_skip_wellness(db, user_id: int, today: date) -> SkipWellnessImpact | None:
    impacts: list[SkipWellnessImpact] = []
    for day, when in ((today, "today"), (today - timedelta(days=1), "yesterday")):
        impact = _classify_skip_wellness(_skip_reason_for_day(db, user_id, day), when)
        if impact:
            impacts.append(impact)
    if not impacts:
        return None
    return sorted(impacts, key=lambda i: (i.cap if i.cap is not None else 100, i.value))[0]


# Cycle phases sourced from `src/services/appleHealth.ts:getCycleStatus`.
# Multipliers reflect typical recovery / training-tolerance research:
#   • follicular    — peak: highest tolerance, fastest recovery
#   • ovulation     — strong, slight tendon-laxity caveat (not gated here)
#   • menses        — highly variable; we treat as "near-baseline" (recovery
#                      often improves on day 2–3 as hormones rebound)
#   • luteal        — late luteal especially: lower energy, lower HRV
#                      systemic baseline. Soft penalty validates the feeling
#                      instead of letting the user blame themselves.
_CYCLE_PHASE_MULTIPLIERS: dict[str, tuple[float, str]] = {
    "follicular": (1.00, "follicular phase"),
    "ovulation":  (0.95, "ovulation phase"),
    "menses":     (0.85, "menstrual phase"),
    "luteal":     (0.70, "luteal phase"),
}


def _score_cycle_phase(
    cycle_phase: str | None,
    day_of_cycle: int | None = None,
) -> tuple[int | None, str | None]:
    """Score the cycle phase pillar. Returns (None, None) when there's no
    cycle data (e.g. male users, missing HealthKit grant) so the pillar
    is skipped entirely and the readiness score is normalized against
    the pillars actually present.

    `day_of_cycle` is currently informational only — included in the
    factor detail string when present. Future extension: late-luteal
    (day 22+ of a 28d cycle) could pick up an extra ~5% penalty since
    the dip is sharpest in the days before menses."""
    if not cycle_phase:
        return None, None
    phase = cycle_phase.lower()
    if phase == "unknown":
        return None, None
    mult, label = _CYCLE_PHASE_MULTIPLIERS.get(phase, (None, None))
    if mult is None:
        return None, None
    pts = int(round(W_CYCLE * mult))
    detail = label
    if day_of_cycle and day_of_cycle > 0:
        detail = f"{label} · day {day_of_cycle}"
    return pts, detail


def _lifestyle_level_logged(level: str | None) -> bool:
    return str(level or "").strip().lower() not in {"", "none"}


def _timing_is_late(timing: str | None) -> bool:
    return str(timing or "").strip().lower() in {"evening", "late"}


def _recent_lifestyle_rows(db: Any, user_id: int, today: date) -> "tuple[Any, Any]":
    """Fetch today + yesterday DailyLifestyleLog rows ONCE so the three
    readiness consumers (explanations, wellness cap, alcohol modifier) share a
    single query instead of issuing three identical SELECTs per compute. Returns
    (today_row, yesterday_row), either of which may be None."""
    try:
        rows = db.exec(
            select(DailyLifestyleLog)
            .where(DailyLifestyleLog.user_id == user_id)
            .where(DailyLifestyleLog.local_date >= today - timedelta(days=1))
            .where(DailyLifestyleLog.local_date <= today)
            .order_by(DailyLifestyleLog.local_date.desc())
        ).all()
    except Exception:
        return None, None
    by_date = {row.local_date: row for row in rows}
    return by_date.get(today), by_date.get(today - timedelta(days=1))


def _readiness_lifestyle_explanations(today_row: Any, yesterday_row: Any) -> list[dict]:
    explanations: list[dict] = []

    alcohol_row = yesterday_row or today_row
    if alcohol_row and (_lifestyle_level_logged(alcohol_row.alcohol_level) or (alcohol_row.alcohol_drinks or 0) > 0):
        drinks = alcohol_row.alcohol_drinks
        dose = f" ({drinks:g} drink{'s' if drinks != 1 else ''})" if drinks else ""
        explanations.append({
            "type": "lifestyle_context",
            "severity": "moderate",
            "message": (
                f"Alcohol logged{dose} may be contributing to sleep quality, HRV/RHR changes, "
                "or short-term scale weight from hydration and food choices."
            ),
        })

    cannabis_row = yesterday_row or today_row
    if cannabis_row and _lifestyle_level_logged(cannabis_row.cannabis_level):
        timing = " later in the day" if _timing_is_late(cannabis_row.cannabis_timing) else ""
        severity = "high" if cannabis_row.cannabis_level in {"heavy", "moderate"} else "low"
        explanations.append({
            "type": "lifestyle_context",
            "severity": severity,
            "message": (
                f"Cannabis logged{timing} may be contributing to sleep timing, REM/HRV/RHR interpretation, "
                "or appetite changes."
            ),
        })

    caffeine_row = yesterday_row or today_row
    if caffeine_row and (caffeine_row.late_caffeine or _timing_is_late(caffeine_row.caffeine_timing)):
        amount = f" ({caffeine_row.caffeine_mg:g} mg)" if caffeine_row.caffeine_mg else ""
        explanations.append({
            "type": "lifestyle_context",
            "severity": "moderate",
            "message": f"Late caffeine{amount} may be contributing to longer sleep latency or lighter sleep.",
        })

    if today_row and today_row.stress_level == "high":
        explanations.append({
            "type": "lifestyle_context",
            "severity": "moderate",
            "message": "High stress logged today may be contributing to HRV/RHR changes and lower training readiness.",
        })
    if today_row and today_row.illness_state in {"rundown", "sick"}:
        label = "Feeling sick" if today_row.illness_state == "sick" else "Feeling rundown"
        explanations.append({
            "type": "lifestyle_context",
            "severity": "high" if today_row.illness_state == "sick" else "moderate",
            "message": f"{label} may be contributing to lower readiness; keep training flexible today.",
        })
    if today_row and today_row.appetite == "high":
        explanations.append({
            "type": "lifestyle_context",
            "severity": "low",
            "message": "High appetite logged today may be contributing to adherence pressure or extra snack urges.",
        })
    if today_row and (
        today_row.bowel_movement_count == 0
        or today_row.bowel_consistency in {"loose", "hard", "mixed"}
    ):
        explanations.append({
            "type": "lifestyle_context",
            "severity": "low",
            "message": "Bowel pattern logged today may be useful context for digestion and comfort.",
        })
    return explanations[:4]


def _lifestyle_wellness_cap(today_row: Any, yesterday_row: Any) -> "SkipWellnessImpact | None":
    """Turn a logged illness / high-stress / heavy-alcohol day into a readiness
    cap so the headline number matches its caption. Mirrors the skipped-workout
    ladder in `_classify_skip_wellness`, but sources from DailyLifestyleLog —
    which the user can fill in without skipping a session, and which previously
    only produced explanation text while leaving the score untouched."""
    impacts: list[SkipWellnessImpact] = []
    if today_row and today_row.illness_state == "sick":
        impacts.append(SkipWellnessImpact(
            value=12, cap=40, detail="sick (logged today)",
            summary="You logged feeling sick today. Treat it as recovery-first and keep intensity easy until symptoms settle.",
            counts_as_gate=True,
        ))
    elif today_row and today_row.illness_state == "rundown":
        impacts.append(SkipWellnessImpact(
            value=35, cap=60, detail="rundown (logged today)",
            summary="You logged feeling rundown today. Favor a lighter session and prioritize sleep and food.",
            counts_as_gate=True,
        ))
    if today_row and today_row.stress_level == "high":
        impacts.append(SkipWellnessImpact(
            value=60, cap=75, detail="high stress (logged today)",
            summary="High stress logged today. Keep the plan flexible and stop short of grindy sets.",
            counts_as_gate=False,
        ))
    alcohol_row = yesterday_row or today_row
    if alcohol_row and (
        str(alcohol_row.alcohol_level or "").strip().lower() in {"moderate", "heavy"}
        or (alcohol_row.alcohol_drinks or 0) >= 4
    ):
        impacts.append(SkipWellnessImpact(
            value=70, cap=80, detail="alcohol (recent)",
            summary="Alcohol logged can blunt overnight HRV and sleep quality, so readiness is held back today.",
            counts_as_gate=False,
        ))
    if not impacts:
        return None
    return sorted(impacts, key=lambda i: (i.cap if i.cap is not None else 100, i.value))[0]


def _more_severe_wellness(
    a: "SkipWellnessImpact | None", b: "SkipWellnessImpact | None"
) -> "SkipWellnessImpact | None":
    """Pick the more severe of two wellness impacts (lowest cap wins). The
    survivor keeps its own `counts_as_gate`, so a gating illness signal still
    lets the score publish even when watch pillars are absent."""
    candidates = [c for c in (a, b) if c is not None]
    if not candidates:
        return None
    return sorted(candidates, key=lambda i: (i.cap if i.cap is not None else 100, i.value))[0]


def _alcohol_high_recent(today_row: Any, yesterday_row: Any) -> bool:
    """True when yesterday/today logged moderate+ alcohol — feeds the fatigue
    engine's `nutrition.alcohol_high` modifier so the recovery pillar dips too."""
    for row in (today_row, yesterday_row):
        if row and (
            str(row.alcohol_level or "").strip().lower() in {"moderate", "heavy"}
            or (row.alcohol_drinks or 0) >= 4
        ):
            return True
    return False


# ── Top-level compute ─────────────────────────────────────────────

def compute_readiness(
    db: Any,
    user_id: int,
    *,
    # Optional client-passed signals — preferred over server lookups
    # when present so the response uses today's freshest HK data
    # without waiting for the snapshot push.
    avg_sleep_hours: float | None = None,
    avg_resting_hr: float | None = None,
    avg_hrv_ms: float | None = None,
    last_night_sleep_score: int | None = None,
    nutrition_adherence_pct: float | None = None,
    planned_focus: str | None = None,
    # Cycle context — phone reads this from HealthKit via getCycleStatus()
    # and forwards as-is. Both fields are optional; if cycle_phase is None
    # or "unknown" the pillar is skipped (male users, no HK grant).
    cycle_phase: str | None = None,
    day_of_cycle: int | None = None,
    use_cache: bool = True,
) -> ReadinessResult:
    """Compute the canonical readiness for this user. Pure function-ish:
    reads from DB but never writes. Caller decides whether to cache or
    push to the watch.

    Server is the only computer of readiness — phone + watch are
    consumers. The output `computed_at_ms` is the version stamp
    WCSession uses to reject stale pushes.

    Per-process TTL cache (60s) is consulted by default; pass
    `use_cache=False` to force a recompute (e.g. tests or after a meal
    write that should immediately reflect in adherence). Cache is
    invalidated explicitly via `invalidate_readiness_cache(user_id)`
    on writes the caller knows about."""
    if use_cache:
        key = _readiness_cache_key(
            user_id, avg_sleep_hours, avg_resting_hr, avg_hrv_ms,
            last_night_sleep_score, nutrition_adherence_pct,
            planned_focus, cycle_phase, day_of_cycle,
        )
        now_s = time.time()
        cached = _readiness_cache.get(key)
        if cached is not None and (now_s - cached[0]) < _READINESS_CACHE_TTL_S:
            return cached[1]
    factors: list[ReadinessFactor] = []
    missing: list[str] = []
    pillar_scores: dict[str, tuple[int, int]] = {}  # name → (got, max)
    sleep_pressure_explanations: list[dict] = []
    today = date.today()
    today_lifestyle, yesterday_lifestyle = _recent_lifestyle_rows(db, user_id, today)
    lifestyle_explanations = _readiness_lifestyle_explanations(today_lifestyle, yesterday_lifestyle)

    # ── Sleep (W_SLEEP) ────────────────────────────────────────────
    sleep_score = last_night_sleep_score
    if sleep_score is None:
        last = db.exec(
            select(SleepLog)
            .where(SleepLog.user_id == user_id)
            .where(SleepLog.night_date == today)
        ).first()
        if last and last.score is not None:
            sleep_score = int(last.score)
    if sleep_score is None and avg_sleep_hours is not None and avg_sleep_hours > 0:
        # Derive a rough score from hours when no SleepLog exists.
        # 7-9h = good, <6h = poor, >9h = diminishing returns.
        h = avg_sleep_hours
        if h >= 8.0:
            sleep_score = 90
        elif h >= 7.0:
            sleep_score = 80
        elif h >= 6.5:
            sleep_score = 65
        elif h >= 6.0:
            sleep_score = 50
        elif h >= 5.0:
            sleep_score = 30
        else:
            sleep_score = 15
    pressure_rows = db.exec(
        select(SleepLog)
        .where(SleepLog.user_id == user_id)
        .where(SleepLog.night_date >= today - timedelta(days=30))
        .where(SleepLog.night_date <= today)
        .order_by(SleepLog.night_date.asc())
    ).all()
    sleep_pressure = compute_sleep_pressure(pressure_rows, as_of=today)
    if (
        sleep_score is not None
        and sleep_pressure is not None
        and sleep_pressure.sleep_score_penalty > 0
    ):
        sleep_score = max(0, int(round(sleep_score - sleep_pressure.sleep_score_penalty)))
        if sleep_pressure.status in {"moderate", "high"}:
            sleep_pressure_explanations.append({
                "type": "sleep_pressure",
                "severity": "high" if sleep_pressure.status == "high" else "moderate",
                "message": (
                    f"{sleep_pressure.headline}: "
                    f"{_format_sleep_pressure_hours(sleep_pressure.display_hours, sleep_pressure.is_capped)} "
                    f"over {sleep_pressure.window_days} days."
                ),
            })
    pts, detail = _score_sleep(sleep_score)
    if pts is not None:
        pillar_scores["sleep"] = (pts, W_SLEEP)
        v100 = int(round((pts / W_SLEEP) * 100))
        if sleep_pressure is not None and sleep_pressure.status not in {"not_enough_data", "clear"}:
            detail = (
                f"{detail}, "
                f"{_format_sleep_pressure_hours(sleep_pressure.display_hours, sleep_pressure.is_capped)} sleep gap"
            )
        factors.append(ReadinessFactor(
            label="Sleep", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("sleep")

    # ── HRV (W_HRV) ────────────────────────────────────────────────
    # Pull last ~14 days of HRV from DailyHealthSnapshot for the
    # baseline median, plus the current value (client signal preferred).
    hrv_history: list[float] = []
    snaps = db.exec(
        select(DailyHealthSnapshot)
        .where(
            DailyHealthSnapshot.user_id == user_id,
            DailyHealthSnapshot.snapshot_date >= today - timedelta(days=14),
            DailyHealthSnapshot.snapshot_date < today,
        )
        .order_by(DailyHealthSnapshot.snapshot_date.desc())
    ).all()
    for snap in snaps:
        if snap.hrv_ms is not None:
            hrv_history.append(float(snap.hrv_ms))
    hrv_value = avg_hrv_ms
    if hrv_value is None:
        # Fall back to most recent snapshot.
        latest_today = db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == user_id,
                   DailyHealthSnapshot.snapshot_date == today)
        ).first()
        if latest_today and latest_today.hrv_ms is not None:
            hrv_value = float(latest_today.hrv_ms)
    pts, detail = _score_hrv(hrv_value, hrv_history)
    if pts is not None:
        pillar_scores["hrv"] = (pts, W_HRV)
        v100 = int(round((pts / W_HRV) * 100))
        factors.append(ReadinessFactor(
            label="HRV", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("hrv")

    # ── Fatigue (W_FATIGUE) ────────────────────────────────────────
    fatigue_readiness = None
    fatigue_detail = None
    snap = None  # FatigueSnapshot — hoisted so the surface can be returned
    try:
        from app.services.workout.activity_impact import compute_rolling_fatigue
        from app.services.workout.focus_normalize import normalize_focus_to_family
        from app.services.workout.history import get_recent_completions_for_fatigue

        completions = get_recent_completions_for_fatigue(user_id, db)
        if completions:
            # Feed today's self-reported soreness / joint pain so it caps the
            # relevant muscles' local readiness (section-E feedback layer).
            self_report = _self_report_feedback(db, user_id, today)
            recovery_context: dict[str, Any] = {}
            if self_report:
                recovery_context["readiness_feedback"] = self_report
            if _alcohol_high_recent(today_lifestyle, yesterday_lifestyle):
                recovery_context["nutrition"] = {"alcohol_high": True}
            snap = compute_rolling_fatigue(completions, recovery_context=recovery_context or None)
            focus_key = normalize_focus_to_family(planned_focus) if planned_focus else None
            focus_value = snap.focus_readiness.get(focus_key) if focus_key else None
            if focus_value is not None:
                fatigue_readiness = round(float(focus_value) * 100)
                fatigue_detail = f"{focus_key.replace('_', ' ')} {int(fatigue_readiness)}%"
            else:
                fatigue_readiness = snap.readiness_score
                fatigue_detail = f"overall {snap.readiness_score}%"
    except Exception:
        # Fatigue compute can fail on cold start (no completions). Treat
        # as missing rather than crashing the readiness call.
        fatigue_readiness = None
        fatigue_detail = None
        snap = None
    fatigue_surface = _fatigue_surface_from_snap(snap)
    pts, detail = _score_fatigue(fatigue_readiness, fatigue_detail)
    if pts is not None:
        pillar_scores["fatigue"] = (pts, W_FATIGUE)
        v100 = int(round((pts / W_FATIGUE) * 100))
        factors.append(ReadinessFactor(
            label="Recovery", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("fatigue")

    # ── Nutrition (W_NUTRITION) ────────────────────────────────────
    nutrition_pct = nutrition_adherence_pct
    if nutrition_pct is None:
        # Last 3 days adherence from DailyNutritionMetrics. Anything
        # >= 80% of calorie target counts as a "hit" day; we average.
        rows = db.exec(
            select(DailyNutritionMetrics)
            .where(
                DailyNutritionMetrics.user_id == user_id,
                DailyNutritionMetrics.metric_date >= today - timedelta(days=3),
            )
        ).all()
        hits = 0
        total = 0
        for r in rows:
            cals = (r.calories_total or 0)
            if cals <= 0:
                continue
            completeness = classify_nutrition_day(
                db,
                user_id,
                r.metric_date,
                logged_calories=float(cals),
            )
            total += 1
            if completeness.status == "complete":
                hits += 0.8
            elif completeness.status == "rough_estimate":
                hits += 0.65
            elif completeness.status == "partial":
                hits += 0.45
        if total > 0:
            nutrition_pct = (hits / total) * 100
    pts, detail = _score_nutrition(nutrition_pct)
    if pts is not None:
        pillar_scores["nutrition"] = (pts, W_NUTRITION)
        v100 = int(round((pts / W_NUTRITION) * 100))
        factors.append(ReadinessFactor(
            label="Nutrition", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("nutrition")

    # ── RHR (W_RHR) ────────────────────────────────────────────────
    rhr_value = avg_resting_hr
    if rhr_value is None:
        latest_today = db.exec(
            select(DailyHealthSnapshot)
            .where(DailyHealthSnapshot.user_id == user_id,
                   DailyHealthSnapshot.snapshot_date == today)
        ).first()
        if latest_today and latest_today.resting_hr is not None:
            rhr_value = float(latest_today.resting_hr)
    pts, detail = _score_rhr(rhr_value)
    if pts is not None:
        pillar_scores["rhr"] = (pts, W_RHR)
        v100 = int(round((pts / W_RHR) * 100))
        factors.append(ReadinessFactor(
            label="RHR", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("rhr")

    # ── Yesterday strain (W_YESTERDAY) ─────────────────────────────
    yesterday = today - timedelta(days=1)
    y_minutes = None
    y_completion = db.exec(
        select(WorkoutCompletion)
        .where(
            WorkoutCompletion.user_id == user_id,
            WorkoutCompletion.workout_date == yesterday,
        )
    ).first()
    if y_completion:
        y_minutes = int(round((y_completion.duration_seconds or 0) / 60))
    else:
        # No completion yesterday = rest day.
        y_minutes = 0
    pts, detail = _score_yesterday(y_minutes)
    if pts is not None:
        pillar_scores["yesterday"] = (pts, W_YESTERDAY)
        v100 = int(round((pts / W_YESTERDAY) * 100))
        factors.append(ReadinessFactor(
            label="Yesterday", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("yesterday")

    # ── Wellness from skip reasons (W_WELLNESS) ─────────────────────
    # A sick/injured/low-energy skip is not training load, so
    # yesterday's load can still be 5/5. It is still real readiness
    # context, though, and should cap the headline score.
    skip_wellness = _more_severe_wellness(
        _recent_skip_wellness(db, user_id, today),
        _lifestyle_wellness_cap(today_lifestyle, yesterday_lifestyle),
    )
    if skip_wellness:
        pts = int(round((skip_wellness.value / 100.0) * W_WELLNESS))
        pillar_scores["wellness"] = (pts, W_WELLNESS)
        factors.append(ReadinessFactor(
            label="Wellness",
            value=skip_wellness.value,
            status=_factor_status(skip_wellness.value),
            detail=skip_wellness.detail,
        ))

    # ── Cycle phase (W_CYCLE) — optional ───────────────────────────
    # Only contributes when the phone passes meaningful cycle data.
    # Skipped silently for male users / users without HK cycle reads —
    # the reweighting step normalizes against pillars actually present
    # so absence isn't penalized. When present, validates "luteal week
    # feels harder" with a soft 30% pillar penalty rather than hiding
    # the dip and letting the user blame themselves.
    pts, detail = _score_cycle_phase(cycle_phase, day_of_cycle)
    if pts is not None:
        pillar_scores["cycle"] = (pts, W_CYCLE)
        v100 = int(round((pts / W_CYCLE) * 100))
        factors.append(ReadinessFactor(
            label="Cycle", value=v100, status=_factor_status(v100), detail=detail,
        ))
    # No `missing.append("cycle")` — its absence is the default state,
    # not a missing signal worth nagging the user about.

    # ── Minimum-signals gate ──────────────────────────────────────
    # Without enough real "today" health pillars, any number we
    # publish is misleading. The yesterday-strain pillar is excluded
    # from this count: it always credits (rest day = full marks) so
    # it can't be the basis for "she had a great recovery night."
    # This gate is what fixes the missed-watch-but-shows-100 bug.
    health_pillars_present = sum(1 for p in pillar_scores if p in _HEALTH_PILLARS)

    wellness_can_publish = bool(skip_wellness and skip_wellness.counts_as_gate)
    if health_pillars_present < _MIN_HEALTH_PILLARS and not wellness_can_publish:
        result = ReadinessResult(
            score=0,
            label="—",
            summary=_no_data_summary(missing),
            factors=factors,
            missing=missing,
            signals_present=len(pillar_scores),
            signals_total=7 if skip_wellness else 6,
            computed_at_ms=int(time.time() * 1000),
            focus_readiness=fatigue_surface["focus_readiness"],
            muscle_readiness=fatigue_surface["muscle_readiness"],
            top_fatigued=fatigue_surface["top_fatigued"],
            recommendations=fatigue_surface["recommendations"],
            explanations=list(fatigue_surface["explanations"]) + sleep_pressure_explanations + lifestyle_explanations,
        )
        if use_cache:
            _readiness_cache[key] = (time.time(), result)
        return result

    # ── Reweight against pillars actually present ──────────────────
    # If the user has 2+ health pillars, score normalizes against
    # what's there so missing-but-not-empty inputs don't collapse to
    # a misleading "Moderate" baseline.
    raw = sum(got for got, _max in pillar_scores.values())
    max_possible = sum(_max for _got, _max in pillar_scores.values())
    score = int(round((raw / max_possible) * 100))
    score = max(0, min(100, score))
    overnight_cap, overnight_cap_explanation = _overnight_recovery_cap(pillar_scores)
    if overnight_cap is not None:
        score = min(score, overnight_cap)
    if skip_wellness and skip_wellness.cap is not None:
        score = min(score, skip_wellness.cap)

    # Re-add the overall-vs-local explanation against the card's HEADLINE
    # score (not the engine's muscle-only score) so the two numbers the user
    # sees are consistent: "generally ready, but legs aren't".
    explanations = list(fatigue_surface["explanations"]) + sleep_pressure_explanations + lifestyle_explanations
    if overnight_cap_explanation:
        explanations.append(overnight_cap_explanation)
    lower_pct = fatigue_surface["focus_readiness"].get(
        "lower", fatigue_surface["focus_readiness"].get("legs", 100)
    )
    if score >= 65 and lower_pct < 60:
        explanations.append({
            "type": "overall_ready_local_not_ready",
            "severity": "high",
            "message": f"Overall readiness is {score}%, but lower-body readiness is {lower_pct}%.",
        })

    result = ReadinessResult(
        score=score,
        label=_label_for(score),
        summary=skip_wellness.summary if skip_wellness else _summary_for(score),
        factors=factors,
        missing=missing,
        signals_present=len(pillar_scores),
        signals_total=7 if skip_wellness else 6,
        computed_at_ms=int(time.time() * 1000),
        focus_readiness=fatigue_surface["focus_readiness"],
        muscle_readiness=fatigue_surface["muscle_readiness"],
        top_fatigued=fatigue_surface["top_fatigued"],
        recommendations=fatigue_surface["recommendations"],
        explanations=explanations,
    )
    if use_cache:
        _readiness_cache[key] = (time.time(), result)
    return result


def _no_data_summary(missing: list[str]) -> str:
    """Friendly explanation when readiness can't be computed. Tailored
    to which pillars are missing so the user knows what to do."""
    wearable_missing = ("sleep" in missing) and ("hrv" in missing) and ("rhr" in missing)
    if wearable_missing:
        return "Not enough Apple Health data yet. Wear your Apple Watch overnight or connect sleep and heart-rate signals to fill readiness in."
    if "sleep" in missing:
        return "Last night's sleep didn't sync yet. Check Apple Health when convenient, then refresh."
    return "Not enough signals yet — log meals or connect Apple Health for a fuller readiness read."
