"""Phase 3 — readiness pillar work.

Covers:
  - #31  Cycle-aware readiness pillar:
         • luteal phase soft-penalizes (~70% of W_CYCLE)
         • follicular phase = full credit
         • menses / ovulation are intermediate
         • absent / unknown phase doesn't add a "missing" entry
         • cycle pillar doesn't break the min-health-pillars gate
  - #39  Weight EMA exposed on weekly review:
         • compute_weekly_review reads UserRollup.weight_ema_lbs
         • value flows into to_dict() as weight_ema_lbs
         • absent rollup → field is None (graceful)

Phase 3 #38 (hourly readiness refresh) is mostly client-side —
backend behavior is already covered by the Phase 1 cache + invalidation
tests. Nothing new to assert here.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import (
    DailyHealthSnapshot, Meal, MealItem, SleepLog, User, UserGoal,
    UserProfile, UserRollup, WeeklyCheckIn, WorkoutSession,
)
from app.enums import GoalType


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _seed_user_with_pillars(s: Session, user_id: int = 1) -> None:
    """Seed enough data that compute_readiness has 2+ health pillars
    present (sleep + RHR via DailyHealthSnapshot). Without this the
    min-pillars gate fires and we can't observe the cycle pillar's
    effect on the score."""
    s.add(User(id=user_id, email=f"u{user_id}@t", username=f"u{user_id}", hashed_password="x"))
    s.add(UserProfile(
        user_id=user_id, age=30, height_feet=5, height_inches=8.0,
        weight_lbs=140.0, gender="female", days_per_week=4,
    ))
    s.add(UserGoal(
        user_id=user_id, goal_type=GoalType.MUSCLE_GAIN, pace="moderate",
        is_active=True,
    ))
    today = date.today()
    s.add(DailyHealthSnapshot(
        user_id=user_id, snapshot_date=today, resting_hr=58, hrv_ms=70,
    ))
    s.add(SleepLog(
        user_id=user_id, night_date=today - timedelta(days=1), score=80,
    ))
    s.commit()


# ─── #31  Cycle-aware readiness pillar ────────────────────────────────────────

def test_cycle_pillar_full_credit_on_follicular():
    """Follicular phase → full W_CYCLE points (mult=1.00)."""
    print("\n[test] readiness: follicular phase scores full cycle credit")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache, W_CYCLE

    eng = _make_engine()
    with Session(eng) as s:
        _seed_user_with_pillars(s)
        invalidate_readiness_cache(1)
        r = compute_readiness(s, 1, cycle_phase="follicular", day_of_cycle=8, use_cache=False)
    cycle_factor = next((f for f in r.factors if f.label == "Cycle"), None)
    assert cycle_factor is not None, "expected a Cycle factor"
    assert cycle_factor.value == 100, f"expected 100% on follicular, got {cycle_factor.value}"
    _ok(f"follicular: cycle factor at {cycle_factor.value}/100")


def test_cycle_pillar_soft_penalty_on_luteal():
    """Luteal phase → ~70% of W_CYCLE (multiplier 0.70). Validates the
    'feels harder this week' UX rather than punishing the user."""
    print("\n[test] readiness: luteal phase applies soft penalty")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_user_with_pillars(s)
        invalidate_readiness_cache(1)
        r = compute_readiness(s, 1, cycle_phase="luteal", day_of_cycle=23, use_cache=False)
    cycle_factor = next((f for f in r.factors if f.label == "Cycle"), None)
    assert cycle_factor is not None, "expected a Cycle factor"
    assert cycle_factor.value == 70, f"expected 70% on luteal, got {cycle_factor.value}"
    assert "luteal" in (cycle_factor.detail or "").lower()
    assert "day 23" in (cycle_factor.detail or "")
    _ok(f"luteal: cycle factor at {cycle_factor.value}/100 ({cycle_factor.detail})")


def test_cycle_pillar_skipped_when_phase_missing():
    """Male users / users without cycle data → Cycle pillar absent.
    `missing` should NOT include 'cycle' (no nag for non-applicable data)."""
    print("\n[test] readiness: missing cycle phase is silently skipped")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_user_with_pillars(s)
        invalidate_readiness_cache(1)
        r = compute_readiness(s, 1, cycle_phase=None, use_cache=False)
    has_cycle_factor = any(f.label == "Cycle" for f in r.factors)
    assert not has_cycle_factor, "expected no Cycle factor when phase is None"
    assert "cycle" not in [m.lower() for m in r.missing], (
        "cycle should not be reported as 'missing' — it's optional"
    )
    _ok("cycle pillar silently skipped when phase=None; not flagged as missing")


def test_cycle_pillar_unknown_phase_treated_as_absent():
    """Phase 'unknown' (insufficient HK data) is treated like None."""
    print("\n[test] readiness: 'unknown' cycle phase is silently skipped")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_user_with_pillars(s)
        invalidate_readiness_cache(1)
        r = compute_readiness(s, 1, cycle_phase="unknown", use_cache=False)
    assert not any(f.label == "Cycle" for f in r.factors)
    _ok("'unknown' phase is silently skipped")


def test_cycle_pillar_lowers_overall_score():
    """Same inputs except cycle_phase: luteal version should produce a
    lower overall readiness score than follicular. This proves the
    pillar is actually contributing to the reweighted total."""
    print("\n[test] readiness: luteal phase lowers overall score vs follicular")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_user_with_pillars(s)
        invalidate_readiness_cache(1)
        r_foll = compute_readiness(s, 1, cycle_phase="follicular", use_cache=False)
        invalidate_readiness_cache(1)
        r_lut  = compute_readiness(s, 1, cycle_phase="luteal", use_cache=False)
    assert r_lut.score < r_foll.score, (
        f"luteal score should be < follicular: lut={r_lut.score} vs foll={r_foll.score}"
    )
    _ok(f"follicular={r_foll.score} vs luteal={r_lut.score} (luteal is lower)")


def test_cycle_phase_in_cache_key():
    """Different cycle phases must produce different cache entries —
    the per-process TTL cache key includes `cycle_phase` and `day_of_cycle`."""
    print("\n[test] readiness: cycle params disambiguate cache entries")
    from app.services.readiness.compute import compute_readiness, invalidate_readiness_cache

    eng = _make_engine()
    with Session(eng) as s:
        _seed_user_with_pillars(s)
        invalidate_readiness_cache(1)
        a = compute_readiness(s, 1, cycle_phase="follicular")
        b = compute_readiness(s, 1, cycle_phase="luteal")
    assert a is not b, "different cycle phases should produce distinct cache entries"
    _ok("distinct cycle phases produce distinct cached results")


# ─── #39  Weight EMA on weekly review ─────────────────────────────────────────

def _seed_review_user(s: Session, user_id: int = 5) -> None:
    s.add(User(id=user_id, email=f"u{user_id}@t", username=f"u{user_id}", hashed_password="x"))
    s.add(UserProfile(
        user_id=user_id, age=30, height_feet=5, height_inches=10.0,
        weight_lbs=180.0, gender="male", days_per_week=4,
    ))
    s.add(UserGoal(
        user_id=user_id, goal_type=GoalType.MUSCLE_GAIN, pace="moderate",
        is_active=True,
    ))
    s.commit()


def test_weekly_review_includes_weight_ema_lbs():
    """When a 7-day UserRollup row carries weight_ema_lbs, the review's
    to_dict() must surface it under `weight_ema_lbs`."""
    print("\n[test] weekly review: weight_ema_lbs flows from UserRollup → review payload")
    from app.services.workout.plan_review_v2 import compute_weekly_review

    eng = _make_engine()
    with Session(eng) as s:
        _seed_review_user(s, user_id=5)
        s.add(UserRollup(
            user_id=5, window_days=7, as_of=date.today(),
            kcal_avg=2500, kcal_target_delta_pct=2.0, protein_adherence_pct=85,
            days_logged=7, adherence_pct=85.0,
            sessions_planned=4, sessions_completed=4, session_completion_pct=100,
            weight_ema_lbs=178.4, weight_slope_lbs_per_wk=-0.3,
            sleep_avg_h=7.2, steps_avg=8500,
        ))
        s.commit()

        review = compute_weekly_review(s, user_id=5)

    payload = review.to_dict()
    assert "weight_ema_lbs" in payload, "weight_ema_lbs missing from review payload"
    assert abs(payload["weight_ema_lbs"] - 178.4) < 0.01, (
        f"expected 178.4, got {payload['weight_ema_lbs']}"
    )
    _ok(f"weight_ema_lbs surfaces correctly: {payload['weight_ema_lbs']}")


def test_weekly_review_weight_ema_none_when_rollup_missing():
    """No 7-day rollup → weight_ema_lbs is None (graceful, no crash)."""
    print("\n[test] weekly review: missing rollup → weight_ema_lbs is None")
    from app.services.workout.plan_review_v2 import compute_weekly_review

    eng = _make_engine()
    with Session(eng) as s:
        _seed_review_user(s, user_id=6)
        review = compute_weekly_review(s, user_id=6)

    assert review.weight_ema_lbs is None
    assert review.to_dict()["weight_ema_lbs"] is None
    _ok("graceful None when no rollup is present")


cases = [
    test_cycle_pillar_full_credit_on_follicular,
    test_cycle_pillar_soft_penalty_on_luteal,
    test_cycle_pillar_skipped_when_phase_missing,
    test_cycle_pillar_unknown_phase_treated_as_absent,
    test_cycle_pillar_lowers_overall_score,
    test_cycle_phase_in_cache_key,
    test_weekly_review_includes_weight_ema_lbs,
    test_weekly_review_weight_ema_none_when_rollup_missing,
]


if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
