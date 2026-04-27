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

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from statistics import fmean
from typing import Optional

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
from .plan import PlanSnapshot, get_plan_snapshot

WINDOWS: tuple[int, ...] = (7, 14, 28)
ROLLUP_LOOKBACK_DAYS = 35  # enough history to populate the 28d window


# ─── Window preloader (used by recompute_user) ────────────────────────────────
#
# The per-day helpers (`_sum_nutrition_for_day`, `_session_stats_for_day`,
# `_latest_checkin_on_or_before`) each issue 1–3 queries. Looping them
# day-by-day across a 35-day backfill = ~5–7 queries × 35 = up to 245
# round trips. The window preloader bulk-fetches everything in 5 queries
# and lets the per-day computation read from in-memory dicts.

@dataclass
class _WindowCache:
    """In-memory snapshot of the data needed by `compute_daily_rollup`
    across a full date window. Fields are intentionally narrow — only what
    the per-day helpers consume."""
    items_by_meal: dict[int, list] = field(default_factory=lambda: defaultdict(list))
    meals_by_day: dict[date, list] = field(default_factory=lambda: defaultdict(list))
    session_by_day: dict[date, "WorkoutSession"] = field(default_factory=dict)
    exercises_by_session: dict[int, list] = field(default_factory=lambda: defaultdict(list))
    sets_by_exercise: dict[int, list] = field(default_factory=lambda: defaultdict(list))
    checkin_by_day: dict[date, "WeeklyCheckIn"] = field(default_factory=dict)
    # Sorted ascending so we can find "latest ≤ day" via reverse linear scan.
    checkins_sorted: list = field(default_factory=list)
    rollup_by_day: dict[date, "DailyRollup"] = field(default_factory=dict)


def _preload_window(db: Session, user_id: int, start: date, end: date) -> _WindowCache:
    cache = _WindowCache()

    meals = db.exec(
        select(Meal).where(
            Meal.user_id == user_id,
            Meal.meal_date >= start,
            Meal.meal_date <= end,
        )
    ).all()
    for m in meals:
        cache.meals_by_day[m.meal_date].append(m)
    meal_ids = [m.id for m in meals]
    if meal_ids:
        for it in db.exec(select(MealItem).where(MealItem.meal_id.in_(meal_ids))).all():
            cache.items_by_meal[it.meal_id].append(it)

    sessions = db.exec(
        select(WorkoutSession).where(
            WorkoutSession.user_id == user_id,
            WorkoutSession.workout_date >= start,
            WorkoutSession.workout_date <= end,
        )
    ).all()
    for s in sessions:
        cache.session_by_day[s.workout_date] = s
    completed_session_ids = [s.id for s in sessions if s.completed_at is not None]
    exercises = []
    if completed_session_ids:
        exercises = db.exec(
            select(WorkoutExercise).where(WorkoutExercise.session_id.in_(completed_session_ids))
        ).all()
        for e in exercises:
            cache.exercises_by_session[e.session_id].append(e)
    ex_ids = [e.id for e in exercises]
    if ex_ids:
        for st in db.exec(
            select(ExerciseSet).where(ExerciseSet.workout_exercise_id.in_(ex_ids))
        ).all():
            cache.sets_by_exercise[st.workout_exercise_id].append(st)

    # Pull every checkin ≤ end so "latest on or before any day in window"
    # is a single in-memory walk.
    checkins = db.exec(
        select(WeeklyCheckIn)
        .where(WeeklyCheckIn.user_id == user_id, WeeklyCheckIn.checkin_date <= end)
        .order_by(WeeklyCheckIn.checkin_date.asc())
    ).all()
    cache.checkins_sorted = checkins
    for c in checkins:
        if start <= c.checkin_date <= end:
            cache.checkin_by_day[c.checkin_date] = c

    rollups = db.exec(
        select(DailyRollup)
        .where(
            DailyRollup.user_id == user_id,
            DailyRollup.day >= start,
            DailyRollup.day <= end,
        )
    ).all()
    for r in rollups:
        cache.rollup_by_day[r.day] = r

    return cache


def _sum_nutrition_for_day_cached(cache: _WindowCache, day: date) -> tuple[float, float, float, float, int]:
    meals = cache.meals_by_day.get(day, [])
    if not meals:
        return 0.0, 0.0, 0.0, 0.0, 0
    kcal = protein = carbs = fat = 0.0
    for m in meals:
        for it in cache.items_by_meal.get(m.id, []):
            kcal += it.calories
            protein += it.protein_g
            carbs += it.carbs_g
            fat += it.fat_g
    return kcal, protein, carbs, fat, len(meals)


def _session_stats_for_day_cached(cache: _WindowCache, day: date) -> dict:
    session = cache.session_by_day.get(day)
    if not session:
        return {
            "session_planned": False,
            "session_completed": False,
            "session_focus": None,
            "session_rpe_avg": None,
            "session_duration_min": None,
        }
    completed = session.completed_at is not None
    rpe_avg: Optional[float] = None
    if completed:
        rpes = [
            s.rpe
            for e in cache.exercises_by_session.get(session.id, [])
            for s in cache.sets_by_exercise.get(e.id, [])
            if s.rpe is not None
        ]
        if rpes:
            rpe_avg = round(fmean(rpes), 1)
    duration_min: Optional[int] = None
    if completed and session.completed_at and session.created_at:
        delta = session.completed_at - session.created_at
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


def _latest_checkin_on_or_before_cached(cache: _WindowCache, day: date) -> Optional["WeeklyCheckIn"]:
    """Return latest checkin with date ≤ day. List is sorted ascending."""
    latest = None
    for c in cache.checkins_sorted:
        if c.checkin_date > day:
            break
        latest = c
    return latest


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
    *,
    cache: _WindowCache | None = None,
) -> DailyRollup:
    """Compute (or recompute) a single DailyRollup. Upserts in place.

    `plan` is the current active plan snapshot; targets are copied into the row
    so flag evaluation can be done entirely off precomputed rows. If None, the
    row is written without targets (flags degrade gracefully).

    `cache` is an optional pre-loaded window. When provided (e.g. from
    `recompute_user`), per-day data comes from in-memory dicts rather than
    fresh DB queries — turns a 5–7-query-per-day loop into a single 5-query
    bulk load up front. Single-day callers omit it and pay the per-day price.

    NOTE: we snapshot the *current* plan target onto every recomputed day. This
    means historical "adherence" always measures against the plan the user is
    on *right now*, not the plan they were on at the time. For the check-in
    use case (recent 7–28 day window) this is fine and much simpler than
    versioned plan-target history. Revisit in phase 5 if plans start changing
    mid-week and we want true point-in-time adherence.
    """
    if cache is not None:
        kcal, protein, carbs, fat, meals_logged = _sum_nutrition_for_day_cached(cache, day)
        sess = _session_stats_for_day_cached(cache, day)
        exact_checkin = cache.checkin_by_day.get(day)
        latest_checkin = exact_checkin or _latest_checkin_on_or_before_cached(cache, day)
        existing = cache.rollup_by_day.get(day)
    else:
        kcal, protein, carbs, fat, meals_logged = _sum_nutrition_for_day(db, user_id, day)
        sess = _session_stats_for_day(db, user_id, day)
        exact_checkin = db.exec(
            select(WeeklyCheckIn).where(
                WeeklyCheckIn.user_id == user_id,
                WeeklyCheckIn.checkin_date == day,
            )
        ).first()
        latest_checkin = exact_checkin or _latest_checkin_on_or_before(db, user_id, day)
        existing = db.exec(
            select(DailyRollup).where(DailyRollup.user_id == user_id, DailyRollup.day == day)
        ).first()

    weight_lbs = exact_checkin.weight_lbs if exact_checkin else None
    # Map 1–5 sleep rating to approximate hours (rough, until HealthKit wiring lands).
    sleep_h: float | None = None
    energy: int | None = None
    if latest_checkin and latest_checkin.checkin_date == day:
        energy = latest_checkin.energy
        # Only trust sleep-as-hours from same-day checkin, not forward-carried.
        sleep_h = {1: 4.5, 2: 5.5, 3: 6.5, 4: 7.5, 5: 8.5}.get(latest_checkin.sleep)

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

    Bulk-loads every meal/session/checkin/rollup row in the window once, then
    feeds an in-memory cache to per-day rollup computation. Replaces the prior
    O(days × per-day-queries) pattern with O(window-queries + days × dict-reads).
    """
    as_of = as_of or date.today()
    start = as_of - timedelta(days=lookback_days - 1)

    plan = get_plan_snapshot(db, user_id)
    cache = _preload_window(db, user_id, start, as_of)

    day = start
    daily_count = 0
    while day <= as_of:
        compute_daily_rollup(db, user_id, day, plan=plan, cache=cache)
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
