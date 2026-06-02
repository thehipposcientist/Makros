"""Weekly review digest — Sunday summary of the prior 7 days.

Sources:
  - `WorkoutCompletion` for sessions + focus distribution + stimulus
  - `WorkoutSession`/`WorkoutExercise`/`ExerciseSet` for set counts +
    volume load (weight * reps summed across every logged set)
  - `meal_history.get_rolling_averages` for protein / calorie averages
  - ``detect_prs``-style logic reusing `pr_detection.epley_1rm` to
    identify established PRs hit within the window. First-ever baseline
    sets are intentionally omitted from the digest's PR list.
  - The user's active `WorkoutPlan.days_per_week` for adherence %

Design is intentionally pure-Python + deterministic (no AI). Returns a
serializable dict so the router handler is a thin wrapper.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from collections import Counter, defaultdict

from sqlalchemy import func
from sqlmodel import Session, select


def _count_sessions_and_focus(user_id: int, start: date, end: date, db: Session) -> dict:
    """Return counts + focus distribution for completions in [start, end]."""
    from app.models import WorkoutCompletion

    rows = db.exec(
        select(WorkoutCompletion)
        .where(WorkoutCompletion.user_id == user_id)
        .where(WorkoutCompletion.workout_date >= start)
        .where(WorkoutCompletion.workout_date <= end)
    ).all()

    focus_counter: Counter = Counter()
    stimulus_counter: Counter = Counter()
    distinct_days: set[date] = set()
    duration_total = 0
    cal_values: list[int] = []
    hr_avg_values: list[float] = []
    for r in rows:
        focus_counter[(r.focus_label or "Other").strip().title()] += 1
        stimulus_counter[(r.stimulus or "unspecified").strip().lower()] += 1
        distinct_days.add(r.workout_date)
        duration_total += r.duration_seconds or 0
        if r.calories_burned is not None:
            cal_values.append(r.calories_burned)
        if r.hr_summary and isinstance(r.hr_summary, dict) and r.hr_summary.get("avgBpm"):
            hr_avg_values.append(float(r.hr_summary["avgBpm"]))
    avg_calories_burned = round(sum(cal_values) / len(cal_values), 1) if cal_values else None
    avg_hr = round(sum(hr_avg_values) / len(hr_avg_values), 1) if hr_avg_values else None
    return {
        "completion_count": len(rows),
        "distinct_days": len(distinct_days),
        "focus_distribution": dict(focus_counter),
        "stimulus_distribution": dict(stimulus_counter),
        "duration_seconds": duration_total,
        "avg_calories_burned": avg_calories_burned,
        "avg_hr": avg_hr,
    }


def _set_and_volume_stats(user_id: int, start: date, end: date, db: Session) -> dict:
    """Aggregate total sets + volume load across WorkoutSessions in window.

    ``volume_load`` = sum(weight_lbs * reps) over every completed set.
    """
    from app.models import WorkoutSession, WorkoutExercise, ExerciseSet

    rows = db.exec(
        select(ExerciseSet.actual_weight_lbs, ExerciseSet.actual_reps)
        .join(WorkoutExercise, WorkoutExercise.id == ExerciseSet.workout_exercise_id)
        .join(WorkoutSession, WorkoutSession.id == WorkoutExercise.session_id)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= start)
        .where(WorkoutSession.workout_date <= end)
        .where(ExerciseSet.completed == True)  # noqa: E712
        .where(func.lower(func.coalesce(ExerciseSet.set_type, "working")).notin_(["warmup", "warm_up"]))
    ).all()

    total_sets = 0
    volume_load = 0.0
    for weight, reps in rows:
        w = float(weight or 0)
        r = int(reps or 0)
        if r <= 0:
            continue
        total_sets += 1
        volume_load += w * r
    return {"total_sets": total_sets, "volume_load_lbs": round(volume_load, 1)}


def _prs_in_window(user_id: int, start: date, end: date, db: Session) -> list[dict]:
    """Walk ``WorkoutSession`` rows whose workout_date falls in the window
    and run ``detect_prs`` against each. Returns a flat list of PR dicts
    tagged with ``session_date``.

    NB: ``detect_prs`` excludes the given session from historical comparison,
    so PRs are computed as of the moment each session was committed — the
    digest faithfully mirrors what the user saw on the Finish screen.
    """
    from app.models import WorkoutSession
    from .pr_detection import detect_prs

    sessions = db.exec(
        select(WorkoutSession)
        .where(WorkoutSession.user_id == user_id)
        .where(WorkoutSession.workout_date >= start)
        .where(WorkoutSession.workout_date <= end)
    ).all()
    out: list[dict] = []
    for s in sessions:
        try:
            for pr in detect_prs(user_id, s.id, db):
                try:
                    old_value = float(pr.get("old_value") or 0)
                except (TypeError, ValueError):
                    old_value = 0
                if old_value <= 0:
                    continue
                out.append({**pr, "session_date": s.workout_date.isoformat()})
        except Exception:
            # PR is best-effort — a failure on one session shouldn't blow up the digest.
            continue
    return out


def _active_days_per_week(user_id: int, db: Session) -> int:
    """Return the user's currently-active planned training days/week, or
    a sane default of 4 when no active WorkoutPlan row exists yet."""
    from app.models import WorkoutPlan

    row = db.exec(
        select(WorkoutPlan)
        .where(WorkoutPlan.user_id == user_id)
        .where(WorkoutPlan.is_active == True)  # noqa: E712
        .order_by(WorkoutPlan.created_at.desc())
    ).first()
    if row and row.days_per_week:
        return int(row.days_per_week)
    return 4


def build_weekly_digest(user_id: int, *, today: date | None = None, db: Session) -> dict:
    """Assemble the weekly digest dict.

    ``today`` defaults to ``date.today()``. The "this week" window is the
    7 days ending on ``today`` (inclusive). The "prior week" is the 7 days
    before that. Adherence is sessions-completed / planned-days-in-window.

    Returns a dict shaped for the client:
      - week_start, week_end (ISO strings)
      - sessions: {completed, planned, adherence_pct, focus_distribution, stimulus_distribution}
      - volume: {total_sets, volume_load_lbs}
      - prs: [ {exercise_name, kind, new_value, old_value, session_date, ...} ]
      - nutrition: {avg_calories, avg_protein_g, avg_*_when_logged, days_logged, target_protein_g, protein_hit_pct}
      - deltas: {sessions, sets, volume_load_lbs, avg_calories, avg_protein_g}
    """
    today = today or date.today()
    week_end = today
    week_start = today - timedelta(days=6)  # inclusive 7-day window
    prior_end = week_start - timedelta(days=1)
    prior_start = prior_end - timedelta(days=6)

    # ── Sessions + focus ─────────────────────────────────────────
    this_week = _count_sessions_and_focus(user_id, week_start, week_end, db)
    prior_week = _count_sessions_and_focus(user_id, prior_start, prior_end, db)

    days_per_week = _active_days_per_week(user_id, db)
    # Adherence: distinct training days completed vs planned for a 7-day window.
    planned = max(days_per_week, 1)
    adherence_pct = round(min(this_week["distinct_days"] / planned, 1.0) * 100, 1)

    # ── Volume ───────────────────────────────────────────────────
    vol_this = _set_and_volume_stats(user_id, week_start, week_end, db)
    vol_prior = _set_and_volume_stats(user_id, prior_start, prior_end, db)

    # ── PRs ──────────────────────────────────────────────────────
    prs = _prs_in_window(user_id, week_start, week_end, db)

    # ── Nutrition ────────────────────────────────────────────────
    from app.services.nutrition.meal_history import get_rolling_averages
    nutrition_this: dict = {}
    nutrition_prior: dict = {}
    try:
        nutrition_this = get_rolling_averages(user_id, window=7, db=db, end_date=week_end)
    except Exception:
        nutrition_this = {}
    # For the prior 7-day window, get_rolling_averages always uses
    # "today - window" as its anchor, so we can't directly ask for "7 to
    # 14 days ago". We approximate the delta by asking for window=14 and
    # subtracting — good enough for a digest tile.
    try:
        two_week = get_rolling_averages(user_id, window=14, db=db, end_date=week_end)
        # Back out the prior 7 by subtracting totals-for-7 from totals-for-14.
        # nutrition_this["avg_calories"] is averaged over 7 days (sum/7).
        if nutrition_this and two_week:
            this_sum_cal = nutrition_this.get("avg_calories", 0) * 7
            this_sum_pro = nutrition_this.get("avg_protein_g", 0) * 7
            two_sum_cal = two_week.get("avg_calories", 0) * 14
            two_sum_pro = two_week.get("avg_protein_g", 0) * 14
            prior_sum_cal = max(two_sum_cal - this_sum_cal, 0)
            prior_sum_pro = max(two_sum_pro - this_sum_pro, 0)
            nutrition_prior = {
                "avg_calories": round(prior_sum_cal / 7, 1),
                "avg_protein_g": round(prior_sum_pro / 7, 1),
                "days_with_data": max(two_week.get("days_with_data", 0) - nutrition_this.get("days_with_data", 0), 0),
            }
    except Exception:
        nutrition_prior = {}

    target_protein_g = None
    protein_hit_pct = None
    try:
        from app.models import UserGoal, UserProfile
        profile = db.exec(select(UserProfile).where(UserProfile.user_id == user_id)).first()
        goal = db.exec(
            select(UserGoal).where(UserGoal.user_id == user_id, UserGoal.is_active == True)  # noqa: E712
        ).first()
        if profile and goal:
            bw = float(profile.weight_lbs or 0)
            if goal.goal_type.value in ("muscle_gain", "strength", "body_recomp"):
                target_protein_g = round(bw * 1.0, 0)
            else:
                target_protein_g = round(bw * 0.8, 0)
            logged_day_protein = (
                nutrition_this.get("avg_protein_g_when_logged")
                or nutrition_this.get("avg_protein_g")
            )
            if target_protein_g and logged_day_protein:
                protein_hit_pct = round(
                    logged_day_protein / target_protein_g * 100, 1
                )
    except Exception:
        target_protein_g = None
        protein_hit_pct = None

    # ── Deltas ───────────────────────────────────────────────────
    def _delta(new, old) -> float:
        return round((new or 0) - (old or 0), 1)

    deltas = {
        "sessions": this_week["completion_count"] - prior_week["completion_count"],
        "distinct_days": this_week["distinct_days"] - prior_week["distinct_days"],
        "total_sets": vol_this["total_sets"] - vol_prior["total_sets"],
        "volume_load_lbs": _delta(vol_this["volume_load_lbs"], vol_prior["volume_load_lbs"]),
        "avg_calories": _delta(nutrition_this.get("avg_calories"), nutrition_prior.get("avg_calories")),
        "avg_protein_g": _delta(nutrition_this.get("avg_protein_g"), nutrition_prior.get("avg_protein_g")),
    }

    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "sessions": {
            "completed": this_week["completion_count"],
            "distinct_days": this_week["distinct_days"],
            "planned": planned,
            "adherence_pct": adherence_pct,
            "focus_distribution": this_week["focus_distribution"],
            "stimulus_distribution": this_week["stimulus_distribution"],
            "duration_seconds": this_week["duration_seconds"],
            "avg_calories_burned": this_week["avg_calories_burned"],
            "avg_hr": this_week["avg_hr"],
        },
        "volume": {
            "total_sets": vol_this["total_sets"],
            "volume_load_lbs": vol_this["volume_load_lbs"],
        },
        "prs": prs,
        "pr_count": len(prs),
        "nutrition": {
            "avg_calories": nutrition_this.get("avg_calories", 0),
            "avg_protein_g": nutrition_this.get("avg_protein_g", 0),
            "avg_calories_when_logged": nutrition_this.get(
                "avg_calories_when_logged",
                nutrition_this.get("avg_calories", 0),
            ),
            "avg_protein_g_when_logged": nutrition_this.get(
                "avg_protein_g_when_logged",
                nutrition_this.get("avg_protein_g", 0),
            ),
            "days_logged": nutrition_this.get("days_with_data", 0),
            "target_protein_g": target_protein_g,
            "protein_hit_pct": protein_hit_pct,
        },
        "prior_week": {
            "completed": prior_week["completion_count"],
            "distinct_days": prior_week["distinct_days"],
            "total_sets": vol_prior["total_sets"],
            "volume_load_lbs": vol_prior["volume_load_lbs"],
            "avg_calories": nutrition_prior.get("avg_calories", 0),
            "avg_protein_g": nutrition_prior.get("avg_protein_g", 0),
        },
        "deltas": deltas,
    }
