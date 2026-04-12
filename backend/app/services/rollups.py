"""Rollup computation for the AI coach check-in system.

Pure functions over the existing meal / workout / checkin tables. Idempotent:
rerunning `recompute_user(user_id, as_of)` is always safe and overwrites rows.

Two layers:
  - `DailyRollup` — one row per user per day, derived from raw logs
  - `UserRollup`  — rolling 7/14/28-day aggregates over DailyRollup

Phase-1 scope: no plan-target lookup yet; kcal_target / protein_target_g are
left null and filled by the payload assembler in phase 2. Adherence metrics
that depend on targets degrade gracefully to None when targets are missing.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from statistics import fmean

from sqlmodel import Session, select

from app.models import (
    DailyRollup,
    ExerciseSet,
    Meal,
    MealItem,
    UserRollup,
    UserProfile,
    WeeklyCheckIn,
    WorkoutExercise,
    WorkoutSession,
)
from app.services.plan import PlanSnapshot, get_plan_snapshot

WINDOWS: tuple[int, ...] = (7, 14, 28)
ROLLUP_LOOKBACK_DAYS = 35  # enough history to populate the 28d window


# ─── Daily rollup ─────────────────────────────────────────────────────────────

def _sum_nutrition_for_day(db: Session, user_id: int, day: date) -> tuple[float, float, float, float, int]:
    meals = db.exec(
        select(Meal).where(Meal.user_id == user_id, Meal.meal_date == day)
    ).all()
    if not meals:
        return 0.0, 0.0, 0.0, 0.0, 0
    meal_ids = [m.id for m in meals]
    items = db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all()
    kcal = sum(i.calories for i in items)
    protein = sum(i.protein_g for i in items)
    carbs = sum(i.carbs_g for i in items)
    fat = sum(i.fat_g for i in items)
    return kcal, protein, carbs, fat, len(meals)


def _session_stats_for_day(db: Session, user_id: int, day: date) -> dict:
    """Returns session_planned / completed / focus / rpe_avg / duration_min."""
    session = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id, WorkoutSession.workout_date == day)
    ).first()
    if not session:
        return {
            "session_planned": False,
            "session_completed": False,
            "session_focus": None,
            "session_rpe_avg": None,
            "session_duration_min": None,
        }
    completed = session.completed_at is not None
    rpe_avg: float | None = None
    if completed:
        exercises = db.exec(
            select(WorkoutExercise).where(WorkoutExercise.session_id == session.id)
        ).all()
        ex_ids = [e.id for e in exercises]
        if ex_ids:
            rpes = [
                s.rpe for s in db.exec(
                    select(ExerciseSet).where(ExerciseSet.workout_exercise_id.in_(ex_ids))
                ).all() if s.rpe is not None
            ]
            if rpes:
                rpe_avg = round(fmean(rpes), 1)
    duration_min: int | None = None
    if completed and session.completed_at and session.created_at:
        delta = session.completed_at - session.created_at
        # Only trust the duration if it looks like a realistic workout (5–240 min)
        mins = int(delta.total_seconds() // 60)
        if 5 <= mins <= 240:
            duration_min = mins
    return {
        "session_planned": True,
        "session_completed": completed,
        "session_focus": session.focus,
        "session_rpe_avg": rpe_avg,
        "session_duration_min": duration_min,
    }


def _latest_checkin_on_or_before(db: Session, user_id: int, day: date) -> WeeklyCheckIn | None:
    return db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id, WeeklyCheckIn.checkin_date <= day)
        .order_by(WeeklyCheckIn.checkin_date.desc())
    ).first()


def compute_daily_rollup(
    db: Session,
    user_id: int,
    day: date,
    plan: PlanSnapshot | None = None,
) -> DailyRollup:
    """Compute (or recompute) a single DailyRollup. Upserts in place.

    `plan` is the current active plan snapshot; targets are copied into the row
    so flag evaluation can be done entirely off precomputed rows. If None, the
    row is written without targets (flags degrade gracefully).

    NOTE: we snapshot the *current* plan target onto every recomputed day. This
    means historical "adherence" always measures against the plan the user is
    on *right now*, not the plan they were on at the time. For the check-in
    use case (recent 7–28 day window) this is fine and much simpler than
    versioned plan-target history. Revisit in phase 5 if plans start changing
    mid-week and we want true point-in-time adherence.
    """
    kcal, protein, carbs, fat, meals_logged = _sum_nutrition_for_day(db, user_id, day)
    sess = _session_stats_for_day(db, user_id, day)

    # Body + recovery: weight from any checkin on this exact day, else null.
    # Self-report carries forward from the latest checkin ≤ day.
    exact_checkin = db.exec(
        select(WeeklyCheckIn).where(
            WeeklyCheckIn.user_id == user_id,
            WeeklyCheckIn.checkin_date == day,
        )
    ).first()
    latest_checkin = exact_checkin or _latest_checkin_on_or_before(db, user_id, day)
    weight_lbs = exact_checkin.weight_lbs if exact_checkin else None
    # Map 1–5 sleep rating to approximate hours (rough, until HealthKit wiring lands).
    sleep_h: float | None = None
    energy: int | None = None
    if latest_checkin and latest_checkin.checkin_date == day:
        energy = latest_checkin.energy
        # Only trust sleep-as-hours from same-day checkin, not forward-carried.
        sleep_h = {1: 4.5, 2: 5.5, 3: 6.5, 4: 7.5, 5: 8.5}.get(latest_checkin.sleep)

    existing = db.exec(
        select(DailyRollup).where(DailyRollup.user_id == user_id, DailyRollup.day == day)
    ).first()
    if existing:
        row = existing
    else:
        row = DailyRollup(user_id=user_id, day=day)
    row.kcal = kcal
    row.protein_g = protein
    row.carbs_g = carbs
    row.fat_g = fat
    row.meals_logged = meals_logged
    row.kcal_target = float(plan.kcal) if plan else None
    row.protein_target_g = float(plan.protein_g) if plan else None
    row.session_planned = sess["session_planned"]
    row.session_completed = sess["session_completed"]
    row.session_focus = sess["session_focus"]
    row.session_rpe_avg = sess["session_rpe_avg"]
    row.session_duration_min = sess["session_duration_min"]
    row.weight_lbs = weight_lbs
    row.sleep_h = sleep_h
    row.energy = energy
    row.computed_at = datetime.now(timezone.utc)
    db.add(row)
    return row


# ─── Rolling user rollup ──────────────────────────────────────────────────────

@dataclass
class _WindowAgg:
    kcal_avg: float | None
    kcal_target_delta_pct: float | None
    protein_adherence_pct: float | None
    days_logged: int
    adherence_pct: float | None
    sessions_planned: int
    sessions_completed: int
    session_completion_pct: float | None
    weight_ema_lbs: float | None
    weight_slope_lbs_per_wk: float | None
    sleep_avg_h: float | None
    steps_avg: int | None


def _weight_ema_and_slope(weights_by_day: list[tuple[date, float]]) -> tuple[float | None, float | None]:
    """EMA of available weight points + slope in lbs/week via simple least-squares.

    Skips None values (sparse weigh-ins are normal).
    """
    if not weights_by_day:
        return None, None
    # EMA with alpha 0.3 — smooths noise but still responds.
    alpha = 0.3
    ema = weights_by_day[0][1]
    for _, w in weights_by_day[1:]:
        ema = alpha * w + (1 - alpha) * ema
    if len(weights_by_day) < 2:
        return round(ema, 2), None
    # Least-squares slope of weight vs. day index, converted to per-week.
    xs = [(d - weights_by_day[0][0]).days for d, _ in weights_by_day]
    ys = [w for _, w in weights_by_day]
    n = len(xs)
    mx = fmean(xs)
    my = fmean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = sum((x - mx) ** 2 for x in xs)
    if den == 0:
        return round(ema, 2), None
    slope_per_day = num / den
    return round(ema, 2), round(slope_per_day * 7, 3)


def _aggregate_window(rows: list[DailyRollup]) -> _WindowAgg:
    if not rows:
        return _WindowAgg(None, None, None, 0, None, 0, 0, None, None, None, None, None)

    logged_days = [r for r in rows if r.meals_logged > 0]
    kcal_avg = round(fmean(r.kcal for r in logged_days), 0) if logged_days else None

    # kcal_target_delta_pct: mean over days that have both logged kcal and a target
    target_days = [r for r in logged_days if r.kcal_target]
    kcal_target_delta_pct: float | None = None
    if target_days:
        deltas = [(r.kcal - r.kcal_target) / r.kcal_target for r in target_days]
        kcal_target_delta_pct = round(fmean(deltas) * 100, 1)

    # Protein adherence: % of logged days hitting ≥85% of protein target
    protein_target_days = [r for r in logged_days if r.protein_target_g]
    protein_adherence_pct: float | None = None
    if protein_target_days:
        hits = sum(
            1 for r in protein_target_days if r.protein_g >= 0.85 * r.protein_target_g
        )
        protein_adherence_pct = round(hits / len(protein_target_days) * 100, 1)

    # Calorie adherence: % of logged days within ±15% of kcal target
    adherence_pct: float | None = None
    if target_days:
        ok = sum(
            1 for r in target_days if abs(r.kcal - r.kcal_target) <= 0.15 * r.kcal_target
        )
        adherence_pct = round(ok / len(target_days) * 100, 1)

    sessions_planned = sum(1 for r in rows if r.session_planned)
    sessions_completed = sum(1 for r in rows if r.session_completed)
    session_completion_pct: float | None = None
    if sessions_planned:
        session_completion_pct = round(sessions_completed / sessions_planned * 100, 1)

    weight_series = [(r.day, r.weight_lbs) for r in rows if r.weight_lbs is not None]
    weight_series.sort(key=lambda t: t[0])
    weight_ema, weight_slope = _weight_ema_and_slope(weight_series)

    sleep_vals = [r.sleep_h for r in rows if r.sleep_h is not None]
    sleep_avg_h = round(fmean(sleep_vals), 2) if sleep_vals else None

    step_vals = [r.steps for r in rows if r.steps is not None]
    steps_avg = int(fmean(step_vals)) if step_vals else None

    return _WindowAgg(
        kcal_avg=kcal_avg,
        kcal_target_delta_pct=kcal_target_delta_pct,
        protein_adherence_pct=protein_adherence_pct,
        days_logged=len(logged_days),
        adherence_pct=adherence_pct,
        sessions_planned=sessions_planned,
        sessions_completed=sessions_completed,
        session_completion_pct=session_completion_pct,
        weight_ema_lbs=weight_ema,
        weight_slope_lbs_per_wk=weight_slope,
        sleep_avg_h=sleep_avg_h,
        steps_avg=steps_avg,
    )


def compute_user_rollups(db: Session, user_id: int, as_of: date) -> list[UserRollup]:
    """Recompute 7 / 14 / 28-day user rollups ending on `as_of` (inclusive)."""
    # Pull the daily rows we need once.
    earliest = as_of - timedelta(days=max(WINDOWS) - 1)
    all_rows = db.exec(
        select(DailyRollup)
        .where(
            DailyRollup.user_id == user_id,
            DailyRollup.day >= earliest,
            DailyRollup.day <= as_of,
        )
        .order_by(DailyRollup.day.asc())
    ).all()

    out: list[UserRollup] = []
    for window in WINDOWS:
        window_start = as_of - timedelta(days=window - 1)
        window_rows = [r for r in all_rows if r.day >= window_start]
        agg = _aggregate_window(window_rows)

        existing = db.exec(
            select(UserRollup).where(
                UserRollup.user_id == user_id,
                UserRollup.window_days == window,
            )
        ).first()
        row = existing or UserRollup(user_id=user_id, window_days=window, as_of=as_of)
        row.as_of = as_of
        row.kcal_avg = agg.kcal_avg
        row.kcal_target_delta_pct = agg.kcal_target_delta_pct
        row.protein_adherence_pct = agg.protein_adherence_pct
        row.days_logged = agg.days_logged
        row.adherence_pct = agg.adherence_pct
        row.sessions_planned = agg.sessions_planned
        row.sessions_completed = agg.sessions_completed
        row.session_completion_pct = agg.session_completion_pct
        row.weight_ema_lbs = agg.weight_ema_lbs
        row.weight_slope_lbs_per_wk = agg.weight_slope_lbs_per_wk
        row.sleep_avg_h = agg.sleep_avg_h
        row.steps_avg = agg.steps_avg
        row.computed_at = datetime.now(timezone.utc)
        db.add(row)
        out.append(row)
    return out


# ─── Public orchestration ─────────────────────────────────────────────────────

def recompute_user(db: Session, user_id: int, as_of: date | None = None, lookback_days: int = ROLLUP_LOOKBACK_DAYS) -> dict:
    """Recompute daily rollups for the last `lookback_days` and all window rollups.

    Returns a small summary dict for the caller (endpoint, cron job, tests).
    """
    as_of = as_of or date.today()
    start = as_of - timedelta(days=lookback_days - 1)

    plan = get_plan_snapshot(db, user_id)
    day = start
    daily_count = 0
    while day <= as_of:
        compute_daily_rollup(db, user_id, day, plan=plan)
        daily_count += 1
        day += timedelta(days=1)

    user_rollups = compute_user_rollups(db, user_id, as_of)
    db.commit()
    return {
        "user_id": user_id,
        "as_of": as_of.isoformat(),
        "daily_rollups_written": daily_count,
        "window_rollups_written": len(user_rollups),
    }
