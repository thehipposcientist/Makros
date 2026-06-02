"""Pure-function tests for rolling_e1rm.

Lock down: weighted-median behaviour, recency decay, role-aware rep
filtering, and the <3 sample fallback.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_rolling_e1rm
"""
from __future__ import annotations

from datetime import date, timedelta

from app.services.workout.rolling_e1rm import (
    UsableSet, compute_rolling_e1rm, set_e1rm,
)


def make_set(*, days_ago: int, w: float, reps: int, rir: float | None,
             role_compat: str = "primary", workout_id: int | None = None,
             target_rir: float = 2.0):
    """Build a UsableSet at `days_ago` days back."""
    completed = date.today() - timedelta(days=days_ago)
    return UsableSet(
        completed_at=completed,
        actual_weight_lbs=w,
        actual_reps=reps,
        actual_rir=rir,
        target_rir=target_rir,
        set_type="working",
        workout_id=workout_id,
    )


def assert_close(actual, expected, tol, label):
    assert abs(actual - expected) <= tol, f"{label}: got {actual}, expected {expected}±{tol}"
    print(f"  ✓ {label}")


def test_returns_none_under_3():
    print("[test] returns None with <3 usable sets")
    out = compute_rolling_e1rm([
        make_set(days_ago=1, w=185, reps=8, rir=2.0),
        make_set(days_ago=3, w=185, reps=7, rir=2.0),
    ])
    assert out is None, f"expected None, got {out}"
    print("  ✓ 2 sets → None")


def test_basic_estimate():
    print("[test] basic e1RM estimate (Epley with RIR)")
    # 185 × 8 reps with 2 RIR → reps_to_failure = 10 → e1rm = 185 * (1 + 10/30) = ~246.7
    sets = [
        make_set(days_ago=1, w=185, reps=8, rir=2.0),
        make_set(days_ago=3, w=185, reps=8, rir=2.0),
        make_set(days_ago=5, w=185, reps=8, rir=2.0),
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    expected = 185 * (1 + 10 / 30.0)
    assert_close(out.e1rm_lbs, expected, 1.0, f"3 identical sets → {expected:.1f}")


def test_recency_weighting():
    print("[test] recency: 3 recent heavy sets dominate 1 stale light set")
    # 3 recent 225-lb sets vs 1 stale 30-day-old 185-lb set. Weighted
    # median should land on the recent value: stale set's weight at
    # 30 days with 14-day half-life is exp(-30*ln(2)/14) ≈ 0.23, while
    # 3 recent sets carry weight ~1.0 each → recent dominates.
    sets = [
        make_set(days_ago=0,  w=225, reps=8, rir=2.0),
        make_set(days_ago=2,  w=225, reps=8, rir=2.0),
        make_set(days_ago=4,  w=225, reps=8, rir=2.0),
        make_set(days_ago=30, w=185, reps=8, rir=2.0),  # stale
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    expected = 225 * (1 + 10 / 30.0)
    assert_close(out.e1rm_lbs, expected, 1.0, "recent dominates stale")


def test_filters_warmups():
    print("[test] warmup sets are excluded")
    sets = [
        make_set(days_ago=1, w=185, reps=8, rir=2.0),
        make_set(days_ago=2, w=185, reps=8, rir=2.0),
        make_set(days_ago=3, w=185, reps=8, rir=2.0),
        UsableSet(completed_at=date.today(), actual_weight_lbs=95, actual_reps=10,
                  actual_rir=4.0, target_rir=4.0, set_type="warmup"),
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    expected = 185 * (1 + 10 / 30.0)
    assert_close(out.e1rm_lbs, expected, 1.0, "warmup ignored")


def test_role_aware_rep_band():
    print("[test] role-aware rep windows: main / machine / isolation")
    # Main compound: 1–10 reps. 1-rep singles are now valid.
    single = make_set(days_ago=1, w=315, reps=1, rir=0.0)
    out_single = compute_rolling_e1rm([single, single, single], role="primary")
    assert out_single is not None, "main_compound should accept 1-rep singles"
    print("  ✓ main_compound accepts 1-rep singles")

    # Main compound rejects 11+ reps.
    eleven = make_set(days_ago=1, w=185, reps=11, rir=1.0)
    out_eleven = compute_rolling_e1rm([eleven, eleven, eleven], role="primary")
    assert out_eleven is None, "main_compound should reject 11-rep sets"
    print("  ✓ main_compound rejects 11+ reps")

    # Machine compound: 3–12. Accepts 12, rejects 1.
    twelve = make_set(days_ago=1, w=225, reps=12, rir=1.0)
    out_machine_12 = compute_rolling_e1rm([twelve, twelve, twelve], role="machine_compound")
    assert out_machine_12 is not None, "machine_compound should accept 12-rep sets"
    print("  ✓ machine_compound accepts 12-rep")

    machine_single = make_set(days_ago=1, w=225, reps=1, rir=0.0)
    out_machine_1 = compute_rolling_e1rm([machine_single] * 3, role="machine_compound")
    assert out_machine_1 is None, "machine_compound should reject 1-rep singles"
    print("  ✓ machine_compound rejects 1-rep singles")

    # Isolation: refuses entirely. Epley overshoots tendon-bound lifts;
    # the recommender / Strength Score must not see these.
    iso_set = make_set(days_ago=1, w=30, reps=10, rir=1.0)
    out_iso = compute_rolling_e1rm([iso_set, iso_set, iso_set], role="isolation")
    assert out_iso is None, "isolation role should refuse rolling e1RM entirely"
    out_finisher = compute_rolling_e1rm([iso_set, iso_set, iso_set], role="finisher")
    assert out_finisher is None, "finisher role (alias) should refuse"
    print("  ✓ isolation / finisher roles refuse e1RM entirely")


def test_rir_fallback_to_target():
    print("[test] missing actual_rir falls back to target_rir")
    sets = [
        UsableSet(completed_at=date.today(), actual_weight_lbs=185, actual_reps=8,
                  actual_rir=None, target_rir=2.0, set_type="working"),
        UsableSet(completed_at=date.today(), actual_weight_lbs=185, actual_reps=8,
                  actual_rir=None, target_rir=2.0, set_type="working"),
        UsableSet(completed_at=date.today(), actual_weight_lbs=185, actual_reps=8,
                  actual_rir=None, target_rir=2.0, set_type="working"),
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None, "fallback should produce an estimate"
    print("  ✓ target_rir fallback produces estimate")


def test_confidence_tiers():
    print("[test] confidence tier from sample count + spread + sessions")
    # Many samples spread across 7 distinct dates, all actual_rir, tight
    # → high confidence.
    tight = [make_set(days_ago=i, w=185, reps=8, rir=2.0) for i in range(7)]
    out = compute_rolling_e1rm(tight)
    assert out is not None
    assert out.confidence == "high", f"expected high, got {out.confidence}"
    print(f"  ✓ tight (7 dates): confidence={out.confidence}")
    # Few samples → low confidence regardless of spread.
    few = [make_set(days_ago=i, w=185, reps=8, rir=2.0) for i in range(3)]
    out = compute_rolling_e1rm(few)
    assert out is not None
    assert out.confidence in ("low", "med"), f"expected low/med, got {out.confidence}"
    print(f"  ✓ few samples: confidence={out.confidence}")


# ── New behaviour: effective rep cap ─────────────────────────────────


def test_set_e1rm_caps_effective_reps_for_main_compound():
    print("[test] set_e1rm caps main-compound reps at 10")
    # 225 × 10 @ 4 RIR — raw eff_reps would be 14 → 330 lb.
    # With cap, eff_reps = 10 → 225 * (1 + 10/30) = 300 lb.
    out = set_e1rm(225, 10, 4, role="primary")
    assert_close(out, 300.0, 0.5, "225×10@4RIR capped at 10 reps")
    # Without role (default), same cap applies.
    out_default = set_e1rm(225, 10, 4)
    assert_close(out_default, 300.0, 0.5, "default role uses main-compound cap")


def test_set_e1rm_caps_effective_reps_for_machine_compound():
    print("[test] set_e1rm caps machine-compound reps at 12")
    # 100 × 12 @ 4 RIR — raw eff_reps would be 16 → ~153.3 lb.
    # With cap, eff_reps = 12 → 100 * (1 + 12/30) = 140 lb.
    out = set_e1rm(100, 12, 4, role="machine_compound")
    assert_close(out, 140.0, 0.5, "100×12@4RIR capped at 12 reps for machine")


def test_set_e1rm_isolation_returns_none():
    print("[test] set_e1rm refuses isolation lifts")
    out = set_e1rm(30, 12, 1, role="isolation")
    assert out is None, f"isolation must return None, got {out}"
    print("  ✓ isolation returns None")


def test_rolling_uses_cap_in_estimate():
    print("[test] compute_rolling_e1rm honors the rep cap")
    # 3 sets of 225 × 10 @ 4 RIR — each capped at eff_reps=10 → 300 lb.
    sets = [make_set(days_ago=i, w=225, reps=10, rir=4.0) for i in range(3)]
    out = compute_rolling_e1rm(sets, role="primary")
    assert out is not None
    assert_close(out.e1rm_lbs, 300.0, 1.0, "rolling cap → 300 lb not 330")


# ── New behaviour: RIR-source confidence downgrade ───────────────────


def test_target_rir_only_caps_confidence_at_low():
    print("[test] target_rir-only samples cap confidence at 'low'")
    # 7 samples across 7 dates with tight spread BUT all actual_rir=None
    # so target_rir is the fallback for every set → actual_ratio = 0%.
    sets = [
        UsableSet(
            completed_at=date.today() - timedelta(days=i),
            actual_weight_lbs=185, actual_reps=8,
            actual_rir=None, target_rir=2.0,
            set_type="working", workout_id=i + 1,
        )
        for i in range(7)
    ]
    out = compute_rolling_e1rm(sets)
    assert out is not None, "fallback still produces estimate"
    assert out.confidence == "low", (
        f"target-only must cap at low, got {out.confidence}"
    )
    print(f"  ✓ 0% actual_rir → confidence={out.confidence}")


def test_mostly_target_rir_caps_confidence_at_med():
    print("[test] 50–70% actual_rir caps confidence at 'med' (no high)")
    # 7 samples — 4 actual + 3 target → ratio 4/7 ≈ 0.57 (between 0.5
    # and 0.7) → high becomes med, lower tiers untouched.
    sets = []
    for i in range(4):
        sets.append(make_set(days_ago=i, w=185, reps=8, rir=2.0,
                             workout_id=i + 1))
    for i in range(4, 7):
        sets.append(UsableSet(
            completed_at=date.today() - timedelta(days=i),
            actual_weight_lbs=185, actual_reps=8,
            actual_rir=None, target_rir=2.0,
            set_type="working", workout_id=i + 1,
        ))
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence != "high", (
        f"57% actual must block high, got {out.confidence}"
    )
    print(f"  ✓ 57% actual_rir → confidence={out.confidence}")


def test_all_actual_rir_allows_high():
    print("[test] 100% actual_rir + 3+ sessions + tight spread → high")
    sets = [make_set(days_ago=i, w=185, reps=8, rir=2.0,
                     workout_id=i + 1) for i in range(7)]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence == "high", (
        f"100% actual_rir should allow high, got {out.confidence}"
    )
    print(f"  ✓ confidence={out.confidence}")


# ── New behaviour: distinct sessions in confidence ───────────────────


def test_single_session_cannot_be_high():
    print("[test] 7 sets from one workout — no high confidence")
    # All seven sets share workout_id=1 → distinct_sessions=1.
    sets = [make_set(days_ago=0, w=185, reps=8, rir=2.0, workout_id=1)
            for _ in range(7)]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence != "high", (
        f"single-session 7 sets must NOT be high, got {out.confidence}"
    )
    print(f"  ✓ 1 session: confidence={out.confidence}")


def test_two_sessions_can_be_med_not_high():
    print("[test] 7 sets across 2 sessions — med max")
    sets = []
    for i in range(4):
        sets.append(make_set(days_ago=0, w=185, reps=8, rir=2.0, workout_id=1))
    for i in range(3):
        sets.append(make_set(days_ago=3, w=185, reps=8, rir=2.0, workout_id=2))
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence in ("low", "med"), (
        f"2-session sample must NOT be high, got {out.confidence}"
    )
    print(f"  ✓ 2 sessions: confidence={out.confidence}")


def test_three_sessions_can_be_high():
    print("[test] 7 sets across 3 distinct sessions → high possible")
    sets = []
    for wid in (1, 2, 3):
        for k in range(3 if wid == 1 else 2):
            sets.append(make_set(days_ago=wid, w=185, reps=8, rir=2.0,
                                 workout_id=wid))
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence == "high", (
        f"3-session tight sample should be high, got {out.confidence}"
    )
    print(f"  ✓ 3 sessions: confidence={out.confidence}")


def test_distinct_falls_back_to_date_when_workout_id_missing():
    print("[test] missing workout_id → distinct sessions from dates")
    # No workout_id set, but 7 different dates → 7 distinct sessions → high.
    sets = [make_set(days_ago=i, w=185, reps=8, rir=2.0) for i in range(7)]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence == "high", (
        f"7 distinct dates should reach high without workout_id, got {out.confidence}"
    )
    print(f"  ✓ date fallback: confidence={out.confidence}")


def test_distinct_same_date_cannot_be_high_without_workout_id():
    print("[test] same-date sets without workout_id can't be high")
    # All sets on the same day, no workout_id → distinct=1.
    sets = [make_set(days_ago=0, w=185, reps=8, rir=2.0) for _ in range(7)]
    out = compute_rolling_e1rm(sets)
    assert out is not None
    assert out.confidence != "high", (
        f"single-date no-id sample must NOT be high, got {out.confidence}"
    )
    print(f"  ✓ same date, no id: confidence={out.confidence}")


if __name__ == "__main__":
    test_returns_none_under_3()
    test_basic_estimate()
    test_recency_weighting()
    test_filters_warmups()
    test_role_aware_rep_band()
    test_rir_fallback_to_target()
    test_confidence_tiers()
    test_set_e1rm_caps_effective_reps_for_main_compound()
    test_set_e1rm_caps_effective_reps_for_machine_compound()
    test_set_e1rm_isolation_returns_none()
    test_rolling_uses_cap_in_estimate()
    test_target_rir_only_caps_confidence_at_low()
    test_mostly_target_rir_caps_confidence_at_med()
    test_all_actual_rir_allows_high()
    test_single_session_cannot_be_high()
    test_two_sessions_can_be_med_not_high()
    test_three_sessions_can_be_high()
    test_distinct_falls_back_to_date_when_workout_id_missing()
    test_distinct_same_date_cannot_be_high_without_workout_id()
    print("\n✅ test_rolling_e1rm.py PASSED")
