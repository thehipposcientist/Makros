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

W_SLEEP = 30
W_HRV = 20
W_FATIGUE = 20
W_NUTRITION = 15
W_RHR = 10
W_YESTERDAY = 5

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
) -> ReadinessResult:
    """Compute the canonical readiness for this user. Pure function-ish:
    reads from DB but never writes. Caller decides whether to cache or
    push to the watch.

    Server is the only computer of readiness — phone + watch are
    consumers. The output `computed_at_ms` is the version stamp
    WCSession uses to reject stale pushes."""
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

    # ── Minimum-signals gate ──────────────────────────────────────
    # Without enough real "today" health pillars, any number we
    # publish is misleading. The yesterday-strain pillar is excluded
    # from this count: it always credits (rest day = full marks) so
    # it can't be the basis for "she had a great recovery night."
    # This gate is what fixes the missed-watch-but-shows-100 bug.
    health_pillars_present = sum(1 for p in pillar_scores if p in _HEALTH_PILLARS)

    if health_pillars_present < _MIN_HEALTH_PILLARS:
        return ReadinessResult(
            score=0,
            label="—",
            summary=_no_data_summary(missing),
            factors=factors,
            missing=missing,
            signals_present=len(pillar_scores),
            signals_total=6,
            computed_at_ms=int(time.time() * 1000),
        )

    # ── Reweight against pillars actually present ──────────────────
    # If the user has 2+ health pillars, score normalizes against
    # what's there so missing-but-not-empty inputs don't collapse to
    # a misleading "Moderate" baseline.
    raw = sum(got for got, _max in pillar_scores.values())
    max_possible = sum(_max for _got, _max in pillar_scores.values())
    score = int(round((raw / max_possible) * 100))
    score = max(0, min(100, score))

    return ReadinessResult(
        score=score,
        label=_label_for(score),
        summary=_summary_for(score),
        factors=factors,
        missing=missing,
        signals_present=len(pillar_scores),
        signals_total=6,
        computed_at_ms=int(time.time() * 1000),
    )


def _no_data_summary(missing: list[str]) -> str:
    """Friendly explanation when readiness can't be computed. Tailored
    to which pillars are missing so the user knows what to do."""
    wearable_missing = ("sleep" in missing) and ("hrv" in missing) and ("rhr" in missing)
    if wearable_missing:
        return "Not enough data — wear your Apple Watch overnight to get a readiness score."
    if "sleep" in missing:
        return "Last night's sleep didn't sync. Check the Health app, then refresh."
    return "Not enough signals yet — log meals and wear your watch overnight to see today's readiness."
