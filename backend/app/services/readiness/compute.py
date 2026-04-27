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
    DailyHealthSnapshot, DailyNutritionMetrics,
    SleepLog, WorkoutCompletion,
)


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

# Pillars that represent real "today" health signals. The yesterday-
# strain pillar is excluded — it's always available (rest day = full
# credit) and so can't be used to gate a meaningful score.
_HEALTH_PILLARS: frozenset[str] = frozenset({"sleep", "hrv", "rhr", "nutrition", "fatigue"})

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
        }


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


# ── Pillar scoring (each returns 0..MAX or None when input missing) ──

def _score_sleep(last_night_score: int | None) -> tuple[int | None, str | None]:
    if last_night_score is None:
        return None, None
    pts = round((last_night_score / 100.0) * W_SLEEP)
    return pts, f"score {last_night_score}"


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


def _score_fatigue(systemic_fatigue: float | None) -> tuple[int | None, str | None]:
    """systemic_fatigue is a 0..1+ ratio from MuscleFatigue.systemic.
    Higher = more fatigued. Map (1 - systemic) onto W_FATIGUE."""
    if systemic_fatigue is None:
        return None, None
    rel = max(0.0, min(1.0, 1.0 - systemic_fatigue))
    pts = int(round(rel * W_FATIGUE))
    return pts, f"systemic {int(systemic_fatigue * 100)}%"


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
    "follicular": (1.00, "follicular phase (high recovery)"),
    "ovulation":  (0.95, "ovulation phase"),
    "menses":     (0.85, "menstrual phase"),
    "luteal":     (0.70, "luteal phase (lower recovery is normal)"),
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
            cycle_phase, day_of_cycle,
        )
        now_s = time.time()
        cached = _readiness_cache.get(key)
        if cached is not None and (now_s - cached[0]) < _READINESS_CACHE_TTL_S:
            return cached[1]
    factors: list[ReadinessFactor] = []
    missing: list[str] = []
    pillar_scores: dict[str, tuple[int, int]] = {}  # name → (got, max)

    # ── Sleep (W_SLEEP) ────────────────────────────────────────────
    sleep_score = last_night_sleep_score
    if sleep_score is None:
        last_night = date.today() - timedelta(days=1)
        last = db.exec(
            select(SleepLog)
            .where(SleepLog.user_id == user_id)
            .where(SleepLog.night_date == last_night)
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
    pts, detail = _score_sleep(sleep_score)
    if pts is not None:
        pillar_scores["sleep"] = (pts, W_SLEEP)
        v100 = int(round((pts / W_SLEEP) * 100))
        factors.append(ReadinessFactor(
            label="Sleep", value=v100, status=_factor_status(v100), detail=detail,
        ))
    else:
        missing.append("sleep")

    # ── HRV (W_HRV) ────────────────────────────────────────────────
    # Pull last ~14 days of HRV from DailyHealthSnapshot for the
    # baseline median, plus the current value (client signal preferred).
    hrv_history: list[float] = []
    today = date.today()
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
    systemic = None
    try:
        from app.services.workout.activity_impact import compute_rolling_fatigue
        snap = compute_rolling_fatigue(db, user_id)
        if snap and snap.muscle_fatigue:
            mf = snap.muscle_fatigue
            systemic = float(getattr(mf, "systemic", 0.0) or 0.0)
    except Exception:
        # Fatigue compute can fail on cold start (no completions). Treat
        # as missing rather than crashing the readiness call.
        systemic = None
    pts, detail = _score_fatigue(systemic)
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
            total += 1
            # We don't have the user's calorie target loaded here; treat
            # any logged day as 80% adherence (logging is the hard part)
            # and let the actual target overlay land via UserCoachingState
            # in a future refinement. Conservative default.
            hits += 0.8
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

    if health_pillars_present < _MIN_HEALTH_PILLARS:
        result = ReadinessResult(
            score=0,
            label="—",
            summary=_no_data_summary(missing),
            factors=factors,
            missing=missing,
            signals_present=len(pillar_scores),
            signals_total=6,
            computed_at_ms=int(time.time() * 1000),
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

    result = ReadinessResult(
        score=score,
        label=_label_for(score),
        summary=_summary_for(score),
        factors=factors,
        missing=missing,
        signals_present=len(pillar_scores),
        signals_total=6,
        computed_at_ms=int(time.time() * 1000),
    )
    if use_cache:
        _readiness_cache[key] = (time.time(), result)
    return result


def _no_data_summary(missing: list[str]) -> str:
    """Friendly explanation when readiness can't be computed. Tailored
    to which pillars are missing so the user knows what to do."""
    wearable_missing = ("sleep" in missing) and ("hrv" in missing) and ("rhr" in missing)
    if wearable_missing:
        return "Not enough data — wear your Apple Watch overnight to get a readiness score."
    if "sleep" in missing:
        return "Last night's sleep didn't sync. Check the Health app, then refresh."
    return "Not enough signals yet — log meals and wear your watch overnight to see today's readiness."
