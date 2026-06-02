"""Tests for the per-muscle Hypertrophy / Improvement score.

Pure-function tests against `build_progress_for_muscle` plus the
helpers — no DB.

Run directly:  python3 -m tests.test_muscle_progress
"""
from __future__ import annotations

import sys
from datetime import date, timedelta

from app.services.workout.muscle_progress import (
    DEFAULT_WINDOW_DAYS,
    HARD_SET_RIR_CEILING,
    MuscleSet,
    _canonical_muscle,
    _hard_set_subscore,
    _recovery_adjustment,
    _trend_subscore,
    build_progress_for_muscle,
    is_hard_set,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_set(
    *, slug: str = "barbell_back_squat", days_ago: int,
    weight_lbs: float = 225, reps: int = 8, rir: float | None = 2,
    credit: float = 1.0, today: date | None = None,
    is_hard: bool | None = None, muscle: str = "quads",
) -> MuscleSet:
    today = today or date(2026, 5, 1)
    rir_value = rir if rir is not None else None
    return MuscleSet(
        slug=slug,
        completed_at=today - timedelta(days=days_ago),
        weight_lbs=weight_lbs,
        reps=reps,
        rir=rir_value,
        muscle=muscle,
        credit=credit,
        is_hard_set=is_hard if is_hard is not None else is_hard_set(reps, weight_lbs, rir_value),
    )


# ── Helpers ─────────────────────────────────────────────────────────


def test_canonical_muscle_aliases():
    print("\n[test] canonical muscle alias map")
    assert _canonical_muscle("quads") == "quads"
    assert _canonical_muscle("Quads") == "quads"
    assert _canonical_muscle("traps") == "back"
    assert _canonical_muscle("forearms") == "biceps"
    assert _canonical_muscle("obliques") == "core"
    assert _canonical_muscle("abductors") == "glutes"
    assert _canonical_muscle("") is None
    assert _canonical_muscle(None) is None
    assert _canonical_muscle("not_a_muscle") is None
    _ok("aliases + unknowns")


def test_is_hard_set_rir_logged():
    print("\n[test] hard set: RIR ≤ 4 counts, > 4 does not")
    assert is_hard_set(reps=8, weight_lbs=225, rir=0)
    assert is_hard_set(reps=8, weight_lbs=225, rir=3)
    assert is_hard_set(reps=8, weight_lbs=225, rir=HARD_SET_RIR_CEILING)
    assert not is_hard_set(reps=8, weight_lbs=225, rir=HARD_SET_RIR_CEILING + 0.5)
    assert not is_hard_set(reps=8, weight_lbs=225, rir=8)
    _ok("logged RIR boundaries")


def test_is_hard_set_null_rir_permissive():
    print("\n[test] null RIR: counts when reps suggest a working set")
    # ≥5 reps with positive load → counts.
    assert is_hard_set(reps=8, weight_lbs=225, rir=None)
    assert is_hard_set(reps=5, weight_lbs=135, rir=None)
    # <5 reps with null RIR → does NOT count (could be a heavy single
    # warm-up that the user logged but didn't tag).
    assert not is_hard_set(reps=3, weight_lbs=225, rir=None)
    # Empty load → never counts.
    assert not is_hard_set(reps=8, weight_lbs=0, rir=None)
    _ok("null RIR permissive but bounded")


def test_hard_set_subscore_caps_at_target():
    print("\n[test] hard-set subscore caps at full credit at target")
    # Target 14, achieved 14 → full points.
    full = _hard_set_subscore(weekly_hard_sets=14, target=14)
    over = _hard_set_subscore(weekly_hard_sets=28, target=14)
    half = _hard_set_subscore(weekly_hard_sets=7, target=14)
    none = _hard_set_subscore(weekly_hard_sets=0, target=14)
    assert full == over, "going over target shouldn't bonus"
    assert abs(half - full / 2) < 0.01
    assert none == 0
    _ok("hard-set subscore caps + scales")


def test_trend_subscore_scaling():
    print("\n[test] trend subscore: -10 → 0, 0 → half, +10 → full")
    # Map is 0.5 + trend/20 clamped to [0,1].
    weight = 25  # _WEIGHT_VOLUME_TREND
    assert abs(_trend_subscore(0.0) - weight * 0.5) < 0.01
    assert abs(_trend_subscore(10.0) - weight) < 0.01
    assert _trend_subscore(-10.0) == 0
    # None (no prior window) → neutral half credit.
    assert abs(_trend_subscore(None) - weight * 0.5) < 0.01
    _ok("trend subscore boundaries")


def test_recovery_adjustment_softens_bad_recovery():
    print("\n[test] recovery adjustment: poor recovery softens but doesn't tank")
    score = 80
    # Perfect recovery → unchanged.
    assert abs(_recovery_adjustment(score, 100) - score) < 0.01
    # Zero recovery → floored at 70% of original.
    assert abs(_recovery_adjustment(score, 0) - score * 0.7) < 0.01
    # No recovery input → None (caller hides the field).
    assert _recovery_adjustment(score, None) is None
    _ok("recovery factor floor + ceiling")


# ── Aggregator behavior ────────────────────────────────────────────


def test_no_sets_returns_missing():
    print("\n[test] no sets → missing")
    p = build_progress_for_muscle(
        muscle="quads", sets=[], today=date(2026, 5, 1),
    )
    assert p.data_quality == "missing"
    assert p.score == 0
    assert p.weekly_hard_sets == 0
    _ok("empty input → missing")


def test_consistent_high_volume_gives_full_signal():
    print("\n[test] 3 sessions/wk for 4 wks of working sets → high score")
    today = date(2026, 5, 1)
    sets = []
    # 4 weeks × 3 sessions × 4 sets = 48 sets total. Spread across days.
    for week in range(4):
        for day_of_week in (0, 2, 4):
            day = week * 7 + day_of_week
            for slot in range(4):
                sets.append(_make_set(
                    slug="barbell_back_squat",
                    days_ago=day, weight_lbs=225, reps=8, rir=2,
                    credit=1.0, today=today,
                ))
    p = build_progress_for_muscle(
        muscle="quads", sets=sets, today=today,
    )
    # ~12 hard sets/wk against target 16 → 75% of 35 ≈ 26 from hard sets.
    # Plus consistency 4/4 weeks = full 20. Plus neutral trend ≈ 12.5.
    # Plus neutral strength support ≈ 10.  Total in the high range.
    assert p.weekly_hard_sets >= 10, p.weekly_hard_sets
    assert p.consistency_score == 100
    assert p.data_quality == "full"
    assert p.score >= 60
    _ok(f"consistent volume → score {p.score:.0f}")


def test_muscle_progress_can_improve_when_strength_is_flat():
    """Spec requirement: a user can be growing muscle (rising volume,
    consistent hard sets) even when fresh e1RM is flat. The two
    surfaces report independently and we test that explicitly."""
    print("\n[test] flat strength but rising volume → muscle score still improves")
    today = date(2026, 5, 1)
    # Prior 28d window: 8 sets at 200×8.
    prior = [
        _make_set(days_ago=DEFAULT_WINDOW_DAYS + d, weight_lbs=200, reps=8,
                  rir=2, today=today)
        for d in (1, 4, 7, 10, 13, 16, 19, 22)
    ]
    # Current 28d window: 12 sets at 205×8 (3 more sets, slightly more
    # weight) — clear hypertrophy progression.
    current = [
        _make_set(days_ago=d, weight_lbs=205, reps=8,
                  rir=2, today=today)
        for d in (1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23)
    ]
    sets = prior + current
    # No strength_support_trend supplied — represents flat fresh e1RM.
    p = build_progress_for_muscle(
        muscle="quads", sets=sets, today=today,
        strength_support_trend_pct=None,
    )
    assert p.volume_trend_28d_pct is not None
    assert p.volume_trend_28d_pct > 5, p.volume_trend_28d_pct
    assert p.score > 50  # respectable score from volume + consistency alone
    _ok(f"flat strength, +{p.volume_trend_28d_pct:.1f}% volume → score {p.score:.0f}")


def test_secondary_muscle_credit_is_half():
    print("\n[test] secondary-muscle credit (0.5) appears in subscores")
    today = date(2026, 5, 1)
    # 12 secondary-muscle hard sets in the window (e.g. triceps from
    # bench). Half credit each = 6 effective. /4 weeks = 1.5/wk.
    sets = [
        _make_set(slug="barbell_bench_press", days_ago=d * 2,
                  weight_lbs=185, reps=8, rir=2, credit=0.5,
                  muscle="triceps", today=today)
        for d in range(12)
    ]
    p = build_progress_for_muscle(muscle="triceps", sets=sets, today=today)
    # 12 sets * 0.5 credit = 6, divided by 4 weeks = 1.5/wk.
    assert abs(p.weekly_hard_sets - 1.5) < 0.01
    _ok(f"secondary credit aggregates correctly → {p.weekly_hard_sets}/wk")


def test_strength_support_trend_lifts_score():
    print("\n[test] strength_support_trend_pct positive → score boost")
    today = date(2026, 5, 1)
    sets = [
        _make_set(days_ago=d, weight_lbs=225, reps=8, rir=2, today=today)
        for d in (1, 4, 7, 10)
    ]
    no_support = build_progress_for_muscle(
        muscle="quads", sets=sets, today=today,
        strength_support_trend_pct=None,
    )
    with_support = build_progress_for_muscle(
        muscle="quads", sets=sets, today=today,
        strength_support_trend_pct=10.0,  # squat e1RM up 10% → full credit
    )
    assert with_support.score > no_support.score
    _ok(
        f"score lifts {no_support.score:.0f} → {with_support.score:.0f} "
        "with rising compound trend"
    )


def test_recovery_adjustment_field_present_only_with_input():
    print("\n[test] recoveryAdjustedScore is None unless caller supplies recovery")
    today = date(2026, 5, 1)
    sets = [
        _make_set(days_ago=d, weight_lbs=225, reps=8, rir=2, today=today)
        for d in (1, 4, 7)
    ]
    p_none = build_progress_for_muscle(muscle="quads", sets=sets, today=today)
    p_50 = build_progress_for_muscle(
        muscle="quads", sets=sets, today=today, recovery_score=50,
    )
    assert p_none.recovery_adjusted_score is None
    assert p_50.recovery_adjusted_score is not None
    assert p_50.recovery_adjusted_score < p_50.score
    _ok("recovery field gated on caller input")


# ── Test runner ────────────────────────────────────────────────────


def _run_all() -> int:
    failures = 0
    for name, fn in list(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except AssertionError as exc:
            print(f"  ✗ {name}: {exc}")
            failures += 1
        except Exception as exc:
            print(f"  ✗ {name} CRASHED: {exc}")
            failures += 1
    print(f"\n{'PASS' if failures == 0 else f'FAIL ({failures})'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
