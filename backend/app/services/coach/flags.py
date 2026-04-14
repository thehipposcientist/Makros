"""Flag evaluator for the AI coach check-in system.

Reads the precomputed `DailyRollup` and `UserRollup` rows and writes
`UserFlag` rows. Flag keys and semantics match section 12 of the AI check-in
design. Thresholds live in `FLAG_CONFIG` at the top of this file so they can be
tuned without code changes.

Anti-noise principle: every flag has a minimum data requirement (e.g. a 14-day
flag refuses to fire with <10 days logged). We'd rather go quiet than scream
about a bad long weekend.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Callable

from sqlmodel import Session, select

from app.models import (
    DailyRollup,
    UserFlag,
    UserGoal,
    UserRollup,
    WeeklyCheckIn,
)


# ─── Config ───────────────────────────────────────────────────────────────────

@dataclass
class FlagThresholds:
    # low_adherence_7d: days within ±15% of target kcal
    low_adherence_med_days: int = 5       # < 5/7 days is med
    low_adherence_high_days: int = 3      # < 3/7 days is high
    # low_protein_7d
    low_protein_min_days: int = 4         # number of days below 85% target
    # calorie_drift_7d
    calorie_drift_pct_med: float = 8.0    # |7d avg - target| > 8% is med
    calorie_drift_pct_high: float = 15.0  # |7d avg - target| > 15% is high
    # stalled_weight_14d (cut/bulk only)
    stall_slope_lbs_per_wk: float = 0.33  # ~0.15 kg/wk; abs-value threshold
    stall_min_days_logged: int = 10
    # excessive_soreness
    soreness_threshold: int = 4           # 1–5 self-report
    soreness_min_days: int = 3            # over last 7 checkins/days
    # sleep_deficit_5d
    sleep_deficit_hours: float = 6.5
    sleep_deficit_min_days: int = 5
    # missed_sessions_7d
    missed_sessions_ratio_med: float = 0.67
    missed_sessions_ratio_high: float = 0.50
    # missed_lower_body: 2+ consecutive weeks with any `lower`-tagged session missed
    missed_lower_min_weeks: int = 2
    # schedule_conflict_pattern
    schedule_conflict_misses: int = 3     # same weekday missed ≥ N times
    schedule_conflict_window_weeks: int = 4


FLAG_CONFIG = FlagThresholds()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _get_window(db: Session, user_id: int, window_days: int) -> UserRollup | None:
    return db.exec(
        select(UserRollup).where(
            UserRollup.user_id == user_id,
            UserRollup.window_days == window_days,
        )
    ).first()


def _get_daily_range(db: Session, user_id: int, as_of: date, days: int) -> list[DailyRollup]:
    start = as_of - timedelta(days=days - 1)
    return db.exec(
        select(DailyRollup)
        .where(
            DailyRollup.user_id == user_id,
            DailyRollup.day >= start,
            DailyRollup.day <= as_of,
        )
        .order_by(DailyRollup.day.asc())
    ).all()


def _active_goal(db: Session, user_id: int) -> UserGoal | None:
    return db.exec(
        select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)
    ).first()


# ─── Flag implementations ─────────────────────────────────────────────────────
# Each flag function returns either None (flag not active) or a dict with
#   {severity, value, details}
# that is merged into a UserFlag row.


FlagFn = Callable[[Session, int, date], dict | None]


def flag_low_adherence_7d(db: Session, user_id: int, as_of: date) -> dict | None:
    daily = _get_daily_range(db, user_id, as_of, 7)
    target_days = [r for r in daily if r.kcal_target]
    if len(target_days) < 5:
        return None
    ok_days = sum(
        1 for r in target_days if abs(r.kcal - r.kcal_target) <= 0.15 * r.kcal_target
    )
    if ok_days >= FLAG_CONFIG.low_adherence_med_days:
        return None
    severity = "high" if ok_days < FLAG_CONFIG.low_adherence_high_days else "med"
    return {
        "severity": severity,
        "value": f"{ok_days}/{len(target_days)} days within ±15% of target",
        "details": {"ok_days": ok_days, "logged_days": len(target_days)},
    }


def flag_low_protein_7d(db: Session, user_id: int, as_of: date) -> dict | None:
    daily = _get_daily_range(db, user_id, as_of, 7)
    target_days = [r for r in daily if r.protein_target_g]
    if len(target_days) < 5:
        return None
    misses = sum(1 for r in target_days if r.protein_g < 0.85 * r.protein_target_g)
    if misses < FLAG_CONFIG.low_protein_min_days:
        return None
    # Compute avg adherence for the human-readable value
    adherence = (len(target_days) - misses) / len(target_days)
    return {
        "severity": "low" if misses < 5 else "med",
        "value": f"{int(adherence * 100)}% of days hit protein target",
        "details": {"miss_days": misses, "logged_days": len(target_days)},
    }


def flag_calorie_drift_7d(db: Session, user_id: int, as_of: date) -> dict | None:
    window = _get_window(db, user_id, 7)
    if not window or window.kcal_target_delta_pct is None:
        return None
    if window.days_logged < 5:
        return None
    drift_abs = abs(window.kcal_target_delta_pct)
    if drift_abs < FLAG_CONFIG.calorie_drift_pct_med:
        return None
    severity = "high" if drift_abs >= FLAG_CONFIG.calorie_drift_pct_high else "med"
    direction = "over" if window.kcal_target_delta_pct > 0 else "under"
    return {
        "severity": severity,
        "value": f"7d avg {direction} target by {drift_abs:.1f}%",
        "details": {"delta_pct": window.kcal_target_delta_pct},
    }


def flag_stalled_weight_14d(db: Session, user_id: int, as_of: date) -> dict | None:
    goal = _active_goal(db, user_id)
    # Stall flag only applies when weight change is the goal (fat loss / muscle gain).
    # "maintain", recomp, strength, etc. don't have a clear weight slope target.
    weight_change_goals = {"fat_loss", "muscle_gain"}
    if not goal or goal.goal_type.value not in weight_change_goals:
        return None
    window = _get_window(db, user_id, 14)
    if not window or window.weight_slope_lbs_per_wk is None:
        return None
    if window.days_logged < FLAG_CONFIG.stall_min_days_logged:
        return None
    if abs(window.weight_slope_lbs_per_wk) >= FLAG_CONFIG.stall_slope_lbs_per_wk:
        return None
    return {
        "severity": "med",
        "value": f"weight slope {window.weight_slope_lbs_per_wk:+.2f} lbs/wk over 14d",
        "details": {
            "slope_lbs_per_wk": window.weight_slope_lbs_per_wk,
            "goal_type": goal.goal_type.value,
        },
    }


def flag_excessive_soreness(db: Session, user_id: int, as_of: date) -> dict | None:
    start = as_of - timedelta(days=6)
    checkins = db.exec(
        select(WeeklyCheckIn)
        .where(
            WeeklyCheckIn.user_id == user_id,
            WeeklyCheckIn.checkin_date >= start,
            WeeklyCheckIn.checkin_date <= as_of,
        )
    ).all()
    # `WeeklyCheckIn` does not yet have a soreness column — until it does we
    # approximate via the `energy` self-report: energy ≤2 combined with low
    # adherence usually reflects soreness/fatigue.  Replace with a real soreness
    # column in phase 4 when the check-in form is rebuilt.
    low_energy = [c for c in checkins if c.energy is not None and c.energy <= 2]
    if len(low_energy) < FLAG_CONFIG.soreness_min_days:
        return None
    return {
        "severity": "med",
        "value": f"low-energy reports on {len(low_energy)} of last 7 days",
        "details": {"low_energy_days": len(low_energy)},
    }


def flag_sleep_deficit_5d(db: Session, user_id: int, as_of: date) -> dict | None:
    daily = _get_daily_range(db, user_id, as_of, 7)
    sleeps = [r.sleep_h for r in daily if r.sleep_h is not None]
    if len(sleeps) < FLAG_CONFIG.sleep_deficit_min_days:
        return None
    avg = sum(sleeps) / len(sleeps)
    if avg >= FLAG_CONFIG.sleep_deficit_hours:
        return None
    return {
        "severity": "med" if avg < 6.0 else "low",
        "value": f"avg {avg:.1f}h sleep over {len(sleeps)} days",
        "details": {"sleep_avg_h": round(avg, 2), "days": len(sleeps)},
    }


def flag_missed_sessions_7d(db: Session, user_id: int, as_of: date) -> dict | None:
    window = _get_window(db, user_id, 7)
    if not window or window.sessions_planned == 0:
        return None
    ratio = window.sessions_completed / window.sessions_planned
    if ratio >= FLAG_CONFIG.missed_sessions_ratio_med:
        return None
    severity = "high" if ratio < FLAG_CONFIG.missed_sessions_ratio_high else "med"
    return {
        "severity": severity,
        "value": f"{window.sessions_completed}/{window.sessions_planned} sessions done",
        "details": {"ratio": round(ratio, 2)},
    }


def flag_missed_lower_body(db: Session, user_id: int, as_of: date) -> dict | None:
    daily = _get_daily_range(db, user_id, as_of, 21)
    # Group by ISO week, check if any lower-tagged planned session was completed.
    by_week: dict[int, dict[str, int]] = {}
    for r in daily:
        if not r.session_planned:
            continue
        if not r.session_focus or "lower" not in r.session_focus.lower():
            continue
        wk = r.day.isocalendar()[1]
        bucket = by_week.setdefault(wk, {"planned": 0, "done": 0})
        bucket["planned"] += 1
        if r.session_completed:
            bucket["done"] += 1
    weeks_missed_in_a_row = 0
    for wk in sorted(by_week.keys()):
        if by_week[wk]["done"] == 0 and by_week[wk]["planned"] > 0:
            weeks_missed_in_a_row += 1
        else:
            weeks_missed_in_a_row = 0
    if weeks_missed_in_a_row < FLAG_CONFIG.missed_lower_min_weeks:
        return None
    return {
        "severity": "med",
        "value": f"{weeks_missed_in_a_row} consecutive weeks with no lower-body session",
        "details": {"weeks_missed": weeks_missed_in_a_row},
    }


def flag_schedule_conflict_pattern(db: Session, user_id: int, as_of: date) -> dict | None:
    daily = _get_daily_range(db, user_id, as_of, FLAG_CONFIG.schedule_conflict_window_weeks * 7)
    missed_by_weekday: dict[int, int] = {}
    for r in daily:
        if r.session_planned and not r.session_completed:
            missed_by_weekday[r.day.weekday()] = missed_by_weekday.get(r.day.weekday(), 0) + 1
    if not missed_by_weekday:
        return None
    worst_day, worst_count = max(missed_by_weekday.items(), key=lambda kv: kv[1])
    if worst_count < FLAG_CONFIG.schedule_conflict_misses:
        return None
    weekday_name = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][worst_day]
    return {
        "severity": "low",
        "value": f"{worst_count} {weekday_name} sessions missed in last 4 weeks",
        "details": {"weekday": weekday_name, "miss_count": worst_count},
    }


FLAG_REGISTRY: dict[str, FlagFn] = {
    "low_adherence_7d":         flag_low_adherence_7d,
    "low_protein_7d":           flag_low_protein_7d,
    "calorie_drift_7d":         flag_calorie_drift_7d,
    "stalled_weight_14d":       flag_stalled_weight_14d,
    "excessive_soreness":       flag_excessive_soreness,
    "sleep_deficit_5d":         flag_sleep_deficit_5d,
    "missed_sessions_7d":       flag_missed_sessions_7d,
    "missed_lower_body":        flag_missed_lower_body,
    "schedule_conflict_pattern": flag_schedule_conflict_pattern,
}


# ─── Evaluation entry point ───────────────────────────────────────────────────

def evaluate_flags(db: Session, user_id: int, as_of: date | None = None) -> list[UserFlag]:
    """Re-evaluate every flag for a user. Upserts active flags, clears stale ones.

    Must be called after `rollups.recompute_user` so UserRollup/DailyRollup are current.
    """
    as_of = as_of or date.today()
    existing = {
        f.key: f for f in db.exec(
            select(UserFlag).where(UserFlag.user_id == user_id)
        ).all()
    }
    now = datetime.now(timezone.utc)
    active: list[UserFlag] = []

    for key, fn in FLAG_REGISTRY.items():
        result = fn(db, user_id, as_of)
        row = existing.get(key)
        if result is None:
            if row is not None:
                db.delete(row)
            continue
        if row is None:
            row = UserFlag(
                user_id=user_id,
                key=key,
                active_since=as_of,
                last_evaluated=as_of,
            )
        row.severity = result["severity"]
        row.value = result.get("value")
        row.details = result.get("details")
        row.last_evaluated = as_of
        row.updated_at = now
        db.add(row)
        active.append(row)

    db.commit()
    return active
