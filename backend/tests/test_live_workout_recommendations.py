"""Comprehensive tests for the live-workout recommendation system.

Covers gaps in test_set_programming, test_in_workout_review, and
test_rolling_e1rm by exercising:
  - Multi-set realistic sequences (warmup → working → fatigue tail)
  - Boundary conditions (rounding, miss-ratio cutoff, rep-band edges)
  - Goal-bucket × role × experience combinations not in the existing tests
  - Realistic week-over-week e1RM trends (linear progression, plateau,
    deload, "good day" outlier)
  - Suspicion gate every branch + clean-history happy paths
  - reviewed_next_set_recommendation deterministic suspicion handling
  - Realistic call-site shapes from /routers/ai/progression.py

Run: docker exec thallo-backend python -m tests.test_live_workout_recommendations
"""
from __future__ import annotations

import sys
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from app.services.workout.set_programming import (
    PlannedSet,
    build_set_scheme,
    load_increment_for,
    parse_rep_range,
    recommend_next_session_load,
    recommend_next_set,
    round_to_increment,
)
from app.services.workout.in_workout_review import (
    ReviewedRecommendation,
    _feel_bucket,
    is_suspicious,
    reviewed_next_set_recommendation,
)
from app.services.workout.rolling_e1rm import (
    E1RMEstimate,
    UsableSet,
    compute_rolling_e1rm,
)


# ── Test fixtures ────────────────────────────────────────────────────

def _bench():
    return {
        "slug": "barbell_bench_press",
        "name": "Barbell Bench Press",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "horizontal_press",
        "primary_muscle": "chest",
    }


def _squat():
    return {
        "slug": "barbell_back_squat",
        "name": "Barbell Back Squat",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "squat",
        "primary_muscle": "quads",
    }


def _deadlift():
    return {
        "slug": "barbell_deadlift",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "hinge",
        "primary_muscle": "hamstrings",
    }


def _ohp():
    return {
        "slug": "barbell_ohp",
        "equipment_bucket": "barbell",
        "is_compound": True,
        "movement_pattern": "vertical_press",
        "primary_muscle": "shoulders",
    }


def _db_row():
    return {
        "slug": "dumbbell_row",
        "equipment_bucket": "dumbbell",
        "is_compound": True,
        "movement_pattern": "horizontal_pull",
        "primary_muscle": "back",
    }


def _decline_db_press():
    return {
        "slug": "decline_dumbbell_press",
        "name": "Decline Dumbbell Press",
        "equipment_bucket": "dumbbell",
        "is_compound": True,
        "movement_pattern": "horizontal_press",
        "primary_muscle": "chest",
    }


def _curl():
    return {
        "slug": "dumbbell_curl",
        "equipment_bucket": "dumbbell",
        "is_compound": False,
        "movement_pattern": "elbow_flexion",
        "primary_muscle": "biceps",
    }


def _cable_pushdown():
    return {
        "slug": "cable_pushdown",
        "equipment_bucket": "cable",
        "is_compound": False,
        "movement_pattern": "elbow_extension",
        "primary_muscle": "triceps",
    }


def _machine_press():
    return {
        "slug": "machine_chest_press",
        "equipment_bucket": "machine",
        "is_compound": True,
        "movement_pattern": "horizontal_press",
        "primary_muscle": "chest",
    }


def _leg_press():
    return {
        "slug": "machine_leg_press",
        "equipment_bucket": "machine",
        "is_compound": True,
        "movement_pattern": "squat",
        "primary_muscle": "quads",
    }


def _pullup():
    return {
        "slug": "pullup",
        "equipment_bucket": "bodyweight",
        "is_compound": True,
        "movement_pattern": "vertical_pull",
        "primary_muscle": "back",
    }


def _plank():
    return {
        "slug": "plank",
        "equipment_bucket": "bodyweight",
        "is_compound": False,
        "movement_pattern": "anti_extension",
        "primary_muscle": "core",
    }


def _planned(
    set_number=1, set_type="backoff", target_reps="6-8", target_rir=2.0,
    target_weight_lbs=185.0, progression_mode="reps_first",
):
    return PlannedSet(
        set_number=set_number, set_type=set_type, target_reps=target_reps,
        target_rir=target_rir, target_weight_lbs=target_weight_lbs,
        progression_mode=progression_mode,
    )


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Group 1: load_increment_for — gaps + cross-equipment (6 tests) ──

def test_inc_dumbbell_compound_5lb():
    print("\n[test] dumbbell compound row → 5 lb increment")
    assert load_increment_for(_db_row()) == 5.0
    _ok("DB row uses 5 lb increment")


def test_inc_machine_compound_5lb():
    print("\n[test] machine compound press → 5 lb increment")
    assert load_increment_for(_machine_press()) == 5.0
    _ok("machine press uses 5 lb")


def test_inc_machine_isolation_2_5lb():
    print("\n[test] machine isolation (single-joint) → 2.5 lb")
    ex = {"equipment_bucket": "machine", "is_compound": False, "primary_muscle": "biceps"}
    assert load_increment_for(ex) == 2.5
    _ok("machine isolation 2.5 lb")


def test_inc_cable_isolation_2_5lb():
    print("\n[test] cable pushdown (isolation) → 2.5 lb")
    assert load_increment_for(_cable_pushdown()) == 2.5
    _ok("cable iso 2.5 lb")


def test_inc_lower_body_isolation_via_muscle_inference():
    print("\n[test] lower-body isolation (leg curl) → falls back to compound rules off muscle")
    # Hamstring isolation, not compound — should NOT trip the lower-body 10 lb
    # rule because is_compound=False.
    ex = {"equipment_bucket": "machine", "is_compound": False, "primary_muscle": "hamstrings"}
    assert load_increment_for(ex) == 2.5
    _ok("hamstring iso 2.5 lb (compound flag respected)")


def test_inc_unknown_equipment_falls_back_to_5lb():
    print("\n[test] unknown equipment → safe default 5 lb")
    ex = {"equipment_bucket": "rogue_attachment_only_evan_owns", "is_compound": True}
    assert load_increment_for(ex) == 5.0
    _ok("unknown equipment 5 lb default")


# ── Group 2: round_to_increment — boundary behavior (4 tests) ──────

def test_round_5lb_rounds_to_nearest_not_floor():
    print("\n[test] 157 lb at 5-lb increment → 155 (nearest, not floor)")
    assert round_to_increment(157.0, 5.0) == 155.0
    _ok("157 → 155")


def test_round_5lb_at_midpoint_rounds_to_even():
    print("\n[test] 152.5 lb at 5-lb increment → 150 or 155 (Python round-half-to-even)")
    # Python's round() uses banker's rounding. Either outcome is acceptable
    # as long as the result is on the increment grid.
    result = round_to_increment(152.5, 5.0)
    assert result in (150.0, 155.0)
    _ok(f"152.5 → {result} (on grid)")


def test_round_2_5lb_increment_dumbbell_iso():
    print("\n[test] 13.7 lb at 2.5-lb increment → 12.5 or 15.0")
    result = round_to_increment(13.7, 2.5)
    assert result in (12.5, 15.0)
    _ok(f"13.7 → {result}")


def test_round_zero_increment_bodyweight_returns_unchanged():
    print("\n[test] zero increment (bodyweight) preserves weight")
    assert round_to_increment(167.5, 0.0) == 167.5
    assert round_to_increment(0.0, 0.0) == 0.0
    _ok("bodyweight unchanged")


# ── Group 3: parse_rep_range — edge cases (5 tests) ─────────────────

def test_parse_single_rep_count():
    print("\n[test] parse '5' as (5, 5)")
    assert parse_rep_range("5") == (5, 5)
    _ok("'5' → (5, 5)")


def test_parse_handles_leading_trailing_whitespace():
    print("\n[test] parse ' 8 - 12 ' → (8, 12)")
    assert parse_rep_range(" 8 - 12 ") == (8, 12)
    _ok("whitespace tolerated")


def test_parse_returns_none_for_seconds():
    print("\n[test] parse '30s' → None (timed hold)")
    assert parse_rep_range("30s") is None
    _ok("'30s' → None")


def test_parse_returns_none_for_minutes():
    print("\n[test] parse '25-40 min' → None (zone2 cardio)")
    assert parse_rep_range("25-40 min") is None
    _ok("'25-40 min' → None")


def test_parse_returns_none_for_garbage():
    print("\n[test] parse garbage → None, no raise")
    assert parse_rep_range("") is None
    assert parse_rep_range("AMRAP") is None
    assert parse_rep_range("8-?") is None
    _ok("garbage handled")


# ── Group 4: build_set_scheme — uncovered branches (8 tests) ───────

def test_scheme_strength_primary_compound_heavy_top_rir_lower_than_backoff():
    print("\n[test] strength heavy_top RIR is 1 below target_rir, backoff matches target")
    scheme = build_set_scheme(
        _bench(), total_sets=4, reps="3-5", rir_target=2.0,
        target_weight_lbs=200.0, goal_bucket="strength", role="primary",
    )
    assert scheme[0].set_type == "heavy_top"
    assert scheme[0].target_rir == 1.0  # max(1.0, 2.0 - 1.0)
    assert scheme[0].progression_mode == "load_first"
    assert all(s.set_type == "backoff" and s.target_rir == 2.0 and s.progression_mode == "load_first" for s in scheme[1:])
    _ok("heavy_top rir=1, backoffs rir=2 load_first")


def test_scheme_muscle_gain_5_sets_emits_volume_tail():
    print("\n[test] muscle_gain 5 sets primary compound → 1 heavy + 3 backoff + 1 volume")
    scheme = build_set_scheme(
        _bench(), total_sets=5, reps="6-8", rir_target=2.0,
        target_weight_lbs=185.0, goal_bucket="muscle_gain", role="primary",
    )
    assert [s.set_type for s in scheme] == ["heavy_top", "backoff", "backoff", "backoff", "volume"]
    assert scheme[0].progression_mode == "load_first"
    # Backoff and volume tail are reps_first under hypertrophy bias.
    assert all(s.progression_mode == "reps_first" for s in scheme[1:])
    _ok("muscle_gain 5-set scheme heavy + backoff×3 + volume")


def test_scheme_body_recomp_routes_through_hypertrophy_branch():
    print("\n[test] body_recomp primary compound → heavy_top + backoffs (not strength branch)")
    scheme = build_set_scheme(
        _squat(), total_sets=3, reps="6-8", rir_target=2.0,
        target_weight_lbs=275.0, goal_bucket="body_recomp", role="primary",
    )
    assert scheme[0].set_type == "heavy_top"
    # body_recomp uses target_rir for the heavy_top (not target_rir-1 like strength).
    assert scheme[0].target_rir == 2.0
    assert scheme[1].progression_mode == "reps_first"
    _ok("body_recomp uses hypertrophy branch (rir not lowered)")


def test_scheme_athletic_performance_routes_through_hypertrophy_branch():
    print("\n[test] athletic_performance primary compound → heavy_top + backoffs")
    scheme = build_set_scheme(
        _deadlift(), total_sets=3, reps="5-7", rir_target=2.0,
        target_weight_lbs=315.0, goal_bucket="athletic_performance", role="primary",
    )
    assert scheme[0].set_type == "heavy_top"
    assert scheme[1].set_type == "backoff"
    _ok("athletic_performance heavy + backoff")


def test_scheme_endurance_emits_straight_volume_reps_first():
    print("\n[test] endurance goal even on compound → all volume reps_first")
    scheme = build_set_scheme(
        _bench(), total_sets=3, reps="12-15", rir_target=2.0,
        target_weight_lbs=120.0, goal_bucket="endurance", role="primary",
    )
    assert all(s.set_type == "volume" and s.progression_mode == "reps_first" for s in scheme)
    _ok("endurance straight sets reps_first")


def test_scheme_technique_role_overrides_goal_with_75pct_load():
    print("\n[test] technique role → all technique, ~75% of anchor, fixed_skill")
    scheme = build_set_scheme(
        _bench(), total_sets=3, reps="3-5", rir_target=1.0,
        target_weight_lbs=200.0, goal_bucket="strength", role="technique",
    )
    assert all(s.set_type == "technique" for s in scheme)
    assert all(s.progression_mode == "fixed_skill" for s in scheme)
    # 200 × 0.75 = 150, rounded to 5-lb increment.
    assert all(s.target_weight_lbs == 150.0 for s in scheme)
    # Technique always at least 2.0 RIR (clamps low rir_target up).
    assert all(s.target_rir >= 2.0 for s in scheme)
    _ok("technique role 75% load, rir≥2, fixed_skill")


def test_scheme_timed_hold_emits_null_loads_no_progression_logic():
    print("\n[test] '30s' plank reps → null loads, fixed_skill, no anchor required")
    scheme = build_set_scheme(
        _plank(), total_sets=3, reps="30s", rir_target=2.0,
        target_weight_lbs=None, goal_bucket="muscle_gain", role="accessory",
    )
    assert all(s.target_weight_lbs is None for s in scheme)
    assert all(s.progression_mode == "fixed_skill" for s in scheme)
    assert all(s.target_reps == "30s" for s in scheme)
    _ok("timed plank null loads fixed_skill")


def test_scheme_isolation_under_muscle_gain_stays_volume():
    print("\n[test] biceps curl under muscle_gain → all volume reps_first")
    scheme = build_set_scheme(
        _curl(), total_sets=4, reps="10-12", rir_target=2.0,
        target_weight_lbs=30.0, goal_bucket="muscle_gain", role="isolation",
    )
    assert all(s.set_type == "volume" and s.progression_mode == "reps_first" for s in scheme)
    _ok("isolation never gets heavy_top")


# ── Group 5: recommend_next_set — boundary + uncovered (10 tests) ──

def test_next_exact_top_of_range_with_rir_load_first_increases():
    print("\n[test] hit exactly top with RIR ≥ target → +1 increment on load_first")
    # Plan 6-8 reps, hit 8 with rir=2 (target_rir=2 → max(1, target-1) = 1). So 2 ≥ 1.
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=185.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=8, actual_weight_lbs=185.0, actual_rir=2.0)
    # On load_first beat-top requires actual_reps > hi (strict). 8 == hi so this hits the in-range branch.
    assert rec.action == "hold_load"
    _ok("exactly top reps holds (strict beat-top check)")


def test_next_one_rep_above_top_load_first_increases_by_increment():
    print("\n[test] reps above top + RIR → +5 lb on bench (load_first)")
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=185.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=9, actual_weight_lbs=185.0, actual_rir=2.0)
    assert rec.action == "increase_load"
    assert rec.next_set_weight_lbs == 190.0
    _ok("9 reps + RIR 2 → 190 lb")


def test_next_big_db_press_overshoot_with_4rir_adds_two_increments():
    print("\n[test] DB press +6 reps over top and 4 RIR → +10 lb")
    plan = _planned(target_reps="8-12", target_rir=2.0, target_weight_lbs=60.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_decline_db_press(), planned_set=plan,
                             actual_reps=18, actual_weight_lbs=60.0, actual_rir=4.0)
    assert rec.action == "increase_load"
    assert rec.next_set_weight_lbs == 70.0, rec.next_set_weight_lbs
    _ok("60 lb → 70 lb for clear underload")


def test_next_big_reps_first_overshoot_bumps_instead_of_waiting():
    print("\n[test] reps-first huge overshoot → bump now instead of waiting")
    plan = _planned(target_reps="8-12", target_rir=2.0, target_weight_lbs=60.0,
                    progression_mode="reps_first")
    rec = recommend_next_set(exercise=_decline_db_press(), planned_set=plan,
                             actual_reps=18, actual_weight_lbs=60.0, actual_rir=4.0)
    assert rec.action == "increase_load"
    assert rec.next_set_weight_lbs == 70.0, rec.next_set_weight_lbs
    _ok("reps-first calibration miss still progresses live")


def test_next_beat_top_low_rir_does_not_increase():
    print("\n[test] beat top but only RIR 0 → does NOT auto-increase (insufficient tank)")
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=185.0,
                    progression_mode="load_first")
    # rir=0 < max(1, target_rir-1)=1, so the "beat top with reserves" gate fails.
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=10, actual_weight_lbs=185.0, actual_rir=0.0)
    assert rec.action != "increase_load"
    _ok("beat top at failure → no increase (insufficient RIR)")


def test_next_beat_top_squat_adds_real_10_lb_even_off_grid():
    print("\n[test] off-grid 275 lb squat beat top → must REALLY get +10 (not +5)")
    # Regression — previously banker's rounding ate half the increment:
    # 275 + 10 = 285 → round-to-10 = 280 (only +5 effective), while the
    # explanation said "adding 10 lb." Fixed via _bump_load forward-
    # progress guard. The user must get a real +10 lb, AND the
    # explanation must not lie about the delta.
    plan = _planned(target_reps="5-7", target_rir=2.0, target_weight_lbs=275.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_squat(), planned_set=plan,
                             actual_reps=8, actual_weight_lbs=275.0, actual_rir=2.0)
    assert rec.action == "increase_load"
    assert rec.next_set_weight_lbs is not None
    assert rec.next_set_weight_lbs - 275.0 >= 10.0, (
        f"Expected ≥+10 lb forward progress, got {rec.next_set_weight_lbs - 275.0}"
    )
    # Explanation must reflect actual delta (anti-regression for the
    # "lying explanation" half of the bug).
    actual_delta = int(rec.next_set_weight_lbs - 275.0)
    assert f"adding {actual_delta} lb" in rec.explanation, rec.explanation
    _ok(f"275 → {rec.next_set_weight_lbs} (+{actual_delta}), explanation honest")


def test_next_reps_first_beat_top_holds_load_explanation_mentions_session_bump():
    print("\n[test] reps_first beat top → hold load, explanation hints next-session bump")
    plan = _planned(target_reps="8-10", target_rir=2.0, target_weight_lbs=170.0,
                    progression_mode="reps_first")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=12, actual_weight_lbs=170.0, actual_rir=2.0)
    assert rec.action == "hold_load"
    assert rec.next_set_weight_lbs == 170.0
    assert "next session" in rec.explanation.lower()
    _ok("reps_first beat top holds, mentions next session")


def test_next_fixed_skill_beat_top_explicitly_holds():
    print("\n[test] fixed_skill beat top → hold load AND original target reps")
    plan = _planned(target_reps="5", target_rir=3.0, target_weight_lbs=135.0,
                    progression_mode="fixed_skill")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=8, actual_weight_lbs=135.0, actual_rir=3.0)
    assert rec.action == "hold_load"
    assert rec.next_set_weight_lbs == 135.0
    assert rec.next_set_rep_target == "5"
    _ok("fixed_skill keeps original target")


def test_next_severe_miss_at_failure_drops_proportionally():
    print("\n[test] target 12 → hit 5 at failure → big proportional drop, lands inside range")
    plan = _planned(target_reps="10-12", target_rir=1.0, target_weight_lbs=100.0,
                    progression_mode="reps_first")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=5, actual_weight_lbs=100.0, actual_rir=0.0)
    assert rec.action == "reduce_load"
    assert rec.next_set_weight_lbs is not None
    assert rec.next_set_weight_lbs < 80.0  # at least −20 lb on a 100 lb bench
    _ok(f"100 → {rec.next_set_weight_lbs} (severe miss → big drop)")


def test_next_minor_miss_at_failure_drops_one_increment():
    print("\n[test] target 6-8 → hit 5 at failure → -1 increment (minor miss)")
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=200.0,
                    progression_mode="load_first")
    # miss_ratio = 5/6 = 0.83 — above the 0.6 severe-miss cutoff.
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=5, actual_weight_lbs=200.0, actual_rir=0.0)
    assert rec.action == "reduce_load"
    assert rec.next_set_weight_lbs == 195.0  # one increment down
    _ok("minor miss → one increment down")


def test_next_miss_without_rir_drops_one_increment():
    print("\n[test] target 6-8 → hit 5 with no RIR captured → conservative -1 increment")
    # The mobile UI only asks for RIR after meaningful overshoots. A
    # below-range set often reaches the backend with actual_rir=None,
    # and the recommender should still react instead of treating missing
    # RIR as the planned reserve.
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=200.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=5, actual_weight_lbs=200.0, actual_rir=None)
    assert rec.action == "reduce_load"
    assert rec.next_set_weight_lbs == 195.0
    _ok("missing RIR on a miss → one increment down")


def test_next_miss_with_rir_in_reserve_holds_load():
    print("\n[test] target 8-10 → hit 6 with RIR 2 (didn't push) → HOLD load, push next set")
    plan = _planned(target_reps="8-10", target_rir=2.0, target_weight_lbs=155.0,
                    progression_mode="reps_first")
    rec = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=6, actual_weight_lbs=155.0, actual_rir=2.0)
    assert rec.action == "hold_load"
    assert rec.next_set_weight_lbs == 155.0
    _ok("missed with reserves → hold, push again")


def test_next_timed_hold_always_returns_hold_with_unchanged_target():
    print("\n[test] timed plank '30s' → hold load (None), keep target reps")
    plan = PlannedSet(set_number=1, set_type="volume", target_reps="30s",
                      target_rir=2.0, target_weight_lbs=None, progression_mode="fixed_skill")
    rec = recommend_next_set(exercise=_plank(), planned_set=plan,
                             actual_reps=30, actual_weight_lbs=0.0, actual_rir=2.0)
    assert rec.action == "hold_load"
    assert rec.next_set_rep_target == "30s"
    assert rec.next_set_weight_lbs is None
    _ok("timed hold preserved")


# ── Group 5b: off-grid anchor regression (4 tests) ──────────────────

def test_off_grid_anchor_minor_miss_at_failure_drops_real_increment():
    print("\n[test] off-grid 275 squat fails by 1 → must REALLY drop ≥10 lb (not 0 or +5)")
    # Mirror of the increase bug on the deload path. Without _drop_load,
    # banker's rounding could leave the user at the same weight that
    # already failed — worst-possible outcome.
    plan = _planned(target_reps="5-7", target_rir=2.0, target_weight_lbs=275.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_squat(), planned_set=plan,
                             actual_reps=4, actual_weight_lbs=275.0, actual_rir=0.0)
    assert rec.action == "reduce_load"
    assert rec.next_set_weight_lbs is not None
    assert 275.0 - rec.next_set_weight_lbs >= 10.0, (
        f"Expected ≥-10 lb deload, got {rec.next_set_weight_lbs - 275.0}"
    )
    actual_drop = int(275.0 - rec.next_set_weight_lbs)
    assert f"dropping {actual_drop} lb" in rec.explanation, rec.explanation
    _ok(f"275 → {rec.next_set_weight_lbs} (−{actual_drop}), explanation honest")


def test_off_grid_anchor_session_increase_real_progress():
    print("\n[test] off-grid 275 lb session-level increase → +10 enforced")
    plan = _planned(target_reps="5-7", target_rir=2.0, target_weight_lbs=275.0,
                    progression_mode="load_first")
    last = [
        {"reps": 7, "weight_lbs": 275.0, "rir": 2.0},
        {"reps": 7, "weight_lbs": 275.0, "rir": 1.0},
        {"reps": 7, "weight_lbs": 275.0, "rir": 1.0},
    ]
    new_w, action, reason = recommend_next_session_load(
        exercise=_squat(), planned_set=plan, last_session_sets=last,
    )
    assert action == "increase_load"
    assert new_w is not None
    assert new_w - 275.0 >= 10.0, f"Expected ≥+10 lb, got {new_w - 275.0}"
    actual_delta = int(new_w - 275.0)
    assert f"adding {actual_delta} lb" in reason, reason
    _ok(f"session 275 → {new_w} (+{actual_delta})")


def test_off_grid_anchor_session_decrease_real_progress():
    print("\n[test] off-grid 275 lb session-level decrease → −10 enforced")
    plan = _planned(target_reps="5-7", target_rir=2.0, target_weight_lbs=275.0,
                    progression_mode="load_first")
    last = [
        {"reps": 3, "weight_lbs": 275.0, "rir": 0.0},
        {"reps": 3, "weight_lbs": 275.0, "rir": 0.0},
        {"reps": 4, "weight_lbs": 275.0, "rir": 0.0},
    ]
    new_w, action, reason = recommend_next_session_load(
        exercise=_squat(), planned_set=plan, last_session_sets=last,
    )
    assert action == "reduce_load"
    assert new_w is not None
    assert 275.0 - new_w >= 10.0, f"Expected ≥-10 lb, got {new_w - 275.0}"
    actual_drop = int(275.0 - new_w)
    assert f"dropping {actual_drop} lb" in reason, reason
    _ok(f"session 275 → {new_w} (−{actual_drop})")


def test_on_grid_anchor_unchanged_after_fix():
    print("\n[test] on-grid 270 lb squat still gets exact +10 (no over-progression)")
    # Make sure the forward-progress guard doesn't accidentally double-bump
    # on already-on-grid anchors.
    plan = _planned(target_reps="5-7", target_rir=2.0, target_weight_lbs=270.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=_squat(), planned_set=plan,
                             actual_reps=8, actual_weight_lbs=270.0, actual_rir=2.0)
    assert rec.action == "increase_load"
    assert rec.next_set_weight_lbs == 280.0  # exact +10, not +20
    _ok("270 → 280 (exact +10, guard didn't double-bump)")


# ── Group 6: realistic multi-set sequences (5 tests) ────────────────

def test_sequence_strength_top_set_then_two_backoffs_progresses_correctly():
    print("\n[test] full strength session: top set hits range, backoffs hold")
    # 4-set strength scheme for bench at 200 lb anchor, 4-6 reps target, RIR 2.
    scheme = build_set_scheme(
        _bench(), total_sets=4, reps="4-6", rir_target=2.0,
        target_weight_lbs=200.0, goal_bucket="strength", role="primary",
    )
    # Set 1 — heavy top hit 5 reps with RIR 2.
    rec1 = recommend_next_set(exercise=_bench(), planned_set=scheme[0],
                              actual_reps=5, actual_weight_lbs=scheme[0].target_weight_lbs,
                              actual_rir=2.0)
    assert rec1.action == "hold_load"
    # Set 2 — backoff, hit 5 with RIR 1.
    rec2 = recommend_next_set(exercise=_bench(), planned_set=scheme[1],
                              actual_reps=5, actual_weight_lbs=scheme[1].target_weight_lbs,
                              actual_rir=1.0)
    assert rec2.action == "hold_load"
    _ok(f"top@{scheme[0].target_weight_lbs} → backoff@{scheme[1].target_weight_lbs} → all hold")


def test_sequence_fatigue_cascade_drops_load_late_in_session():
    print("\n[test] fatigue across 4 sets — last set falls below range at failure")
    plan_top = _planned(set_number=1, set_type="heavy_top", target_reps="6-8",
                        target_rir=1.0, target_weight_lbs=185.0,
                        progression_mode="load_first")
    rec1 = recommend_next_set(exercise=_bench(), planned_set=plan_top,
                              actual_reps=7, actual_weight_lbs=185.0, actual_rir=1.0)
    assert rec1.action == "hold_load"

    plan_back = _planned(set_number=2, set_type="backoff", target_reps="6-8",
                         target_rir=2.0, target_weight_lbs=170.0,
                         progression_mode="reps_first")
    rec2 = recommend_next_set(exercise=_bench(), planned_set=plan_back,
                              actual_reps=8, actual_weight_lbs=170.0, actual_rir=1.0)
    # Beat top with RIR 1 vs target 2 → max(1, 1) = 1, so RIR≥1 satisfies "tank" gate.
    assert rec2.action == "hold_load"  # reps_first → hold

    plan_back3 = _planned(set_number=3, set_type="backoff", target_reps="6-8",
                          target_rir=2.0, target_weight_lbs=170.0,
                          progression_mode="reps_first")
    rec3 = recommend_next_set(exercise=_bench(), planned_set=plan_back3,
                              actual_reps=5, actual_weight_lbs=170.0, actual_rir=0.0)
    assert rec3.action == "reduce_load"
    _ok(f"set 3 fatigue drop: {rec3.next_set_weight_lbs} (was 170)")


def test_sequence_strong_day_session_recommendation_pushes_load_next_session():
    print("\n[test] all sets at top of range last session → next-session +1 increment")
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=185.0,
                    progression_mode="load_first")
    last = [
        {"reps": 8, "weight_lbs": 185.0, "rir": 2.0},
        {"reps": 8, "weight_lbs": 185.0, "rir": 2.0},
        {"reps": 8, "weight_lbs": 185.0, "rir": 1.0},
    ]
    new_w, action, _ = recommend_next_session_load(
        exercise=_bench(), planned_set=plan, last_session_sets=last,
    )
    assert action == "increase_load"
    assert new_w == 190.0
    _ok("strong session → 190 lb next time")


def test_sequence_grindy_day_session_drops_load_next_session():
    print("\n[test] majority of sets below range last session → next-session -1 increment")
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=205.0,
                    progression_mode="load_first")
    last = [
        {"reps": 5, "weight_lbs": 205.0, "rir": 0.0},
        {"reps": 4, "weight_lbs": 205.0, "rir": 0.0},
        {"reps": 5, "weight_lbs": 205.0, "rir": 0.0},
    ]
    new_w, action, _ = recommend_next_session_load(
        exercise=_bench(), planned_set=plan, last_session_sets=last,
    )
    assert action == "reduce_load"
    assert new_w == 200.0
    _ok("grindy session → 200 lb next time")


def test_sequence_partial_progress_holds_next_session():
    print("\n[test] mixed sets (some in range, some below) → hold")
    plan = _planned(target_reps="6-8", target_rir=2.0, target_weight_lbs=185.0,
                    progression_mode="load_first")
    last = [
        {"reps": 7, "weight_lbs": 185.0, "rir": 1.0},
        {"reps": 6, "weight_lbs": 185.0, "rir": 0.0},
        {"reps": 5, "weight_lbs": 185.0, "rir": 0.0},
    ]
    new_w, action, _ = recommend_next_session_load(
        exercise=_bench(), planned_set=plan, last_session_sets=last,
    )
    assert action == "hold_load"
    assert new_w == 185.0
    _ok("partial → hold at 185")


# ── Group 7: recommend_next_session_load — uncovered (3 tests) ──────

def test_next_session_no_history_returns_planned_load():
    print("\n[test] empty last_session_sets → returns planned load + hold")
    plan = _planned(target_reps="8-10", target_weight_lbs=145.0)
    new_w, action, reason = recommend_next_session_load(
        exercise=_bench(), planned_set=plan, last_session_sets=[],
    )
    assert action == "hold_load"
    assert new_w == 145.0
    assert "no recent" in reason.lower()
    _ok("no history → planned load, no surprise")


def test_next_session_non_numeric_reps_holds():
    print("\n[test] non-numeric rep scheme last session → hold, no progression math")
    plan = PlannedSet(set_number=1, set_type="volume", target_reps="30s",
                      target_rir=2.0, target_weight_lbs=None, progression_mode="fixed_skill")
    last = [{"reps": 30, "weight_lbs": 0.0, "rir": 2.0}]
    new_w, action, _ = recommend_next_session_load(
        exercise=_plank(), planned_set=plan, last_session_sets=last,
    )
    assert action == "hold_load"
    _ok("timed scheme holds across sessions")


def test_next_session_reps_first_at_top_holds_load_and_chases_reps():
    print("\n[test] reps_first all at top → hold load (chase one more rep), do NOT add weight")
    plan = _planned(target_reps="8-10", target_rir=2.0, target_weight_lbs=170.0,
                    progression_mode="reps_first")
    last = [
        {"reps": 10, "weight_lbs": 170.0, "rir": 2.0},
        {"reps": 10, "weight_lbs": 170.0, "rir": 2.0},
        {"reps": 10, "weight_lbs": 170.0, "rir": 1.0},
    ]
    new_w, action, _ = recommend_next_session_load(
        exercise=_bench(), planned_set=plan, last_session_sets=last,
    )
    assert action == "hold_load"
    assert new_w == 170.0
    _ok("reps_first holds even when all at top")


# ── Group 8: is_suspicious — branch coverage gaps (8 tests) ────────

def test_suspicion_feel_failure_in_range_flagged():
    print("\n[test] feel=failure inside rep range → flagged (load may be at edge)")
    plan = _planned(target_reps="6-8")
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=7, actual_weight_lbs=185.0, actual_rir=0.0)
    reasons = is_suspicious(
        planned_set=plan, actual_reps=7, actual_weight_lbs=185.0,
        feel="failure",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 1.0}],
        last_session_sets=[],
        deterministic=det,
    )
    assert any("failure" in r for r in reasons)
    _ok("feel=failure in range → flagged")


def test_suspicion_feel_easy_at_top_warrants_bigger_jump_flag():
    print("\n[test] feel=easy + hit top of range → suspicious (det +1 may be too conservative)")
    plan = _planned(target_reps="6-8")
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=8, actual_weight_lbs=185.0, actual_rir=3.0)
    reasons = is_suspicious(
        planned_set=plan, actual_reps=8, actual_weight_lbs=185.0,
        feel="easy",
        previous_sets_this_session=[{"reps": 7, "weight_lbs": 185.0, "rir": 2.0}],
        last_session_sets=[],
        deterministic=det,
    )
    assert any("easy" in r and "top" in r for r in reasons)
    _ok("feel=easy + top → 'larger jump' reason")


def test_suspicion_increase_with_hard_feel_is_form_risk():
    print("\n[test] det says increase_load but feel=hard → form-risk flag")
    plan = _planned(target_reps="6-8", progression_mode="load_first", target_weight_lbs=185.0)
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=9, actual_weight_lbs=185.0, actual_rir=2.0)
    assert det.action == "increase_load"
    reasons = is_suspicious(
        planned_set=plan, actual_reps=9, actual_weight_lbs=185.0,
        feel="hard",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 1.0}],
        last_session_sets=[],
        deterministic=det,
    )
    assert any("increase_load" in r and "hard" in r for r in reasons)
    _ok("increase + feel=hard → form-risk reason")


def test_suspicion_clean_in_range_with_history_is_not_flagged():
    print("\n[test] hit range cleanly + good feel + previous-session data → empty list")
    plan = _planned(target_reps="6-8")
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=7, actual_weight_lbs=185.0, actual_rir=1.0)
    reasons = is_suspicious(
        planned_set=plan, actual_reps=7, actual_weight_lbs=185.0,
        feel="good",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 2.0}],
        last_session_sets=[{"reps": 7, "weight_lbs": 180.0, "rir": 2.0}],
        deterministic=det,
    )
    assert reasons == []
    _ok("clean session → no suspicion")


def test_suspicion_no_history_clean_feel_is_not_auto_flagged():
    print("\n[test] FIRST set ever (no history) + clean signal → NOT auto-flagged")
    # Per the docstring update — old rule of "no history = always escalate" was removed.
    plan = _planned(target_reps="6-8")
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=7, actual_weight_lbs=135.0, actual_rir=2.0)
    reasons = is_suspicious(
        planned_set=plan, actual_reps=7, actual_weight_lbs=135.0,
        feel="good", previous_sets_this_session=[], last_session_sets=[],
        deterministic=det,
    )
    assert reasons == []
    _ok("no-history + clean feel = silent")


def test_suspicion_overshoot_with_hard_feel_NOT_flagged():
    print("\n[test] big overshoot but feel=hard → NOT flagged (det +1 is right)")
    plan = _planned(target_reps="6-8")
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=11, actual_weight_lbs=185.0, actual_rir=1.0)
    reasons = is_suspicious(
        planned_set=plan, actual_reps=11, actual_weight_lbs=185.0,
        feel="hard",  # if it felt hard despite overshoot, det's call is fine
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 2.0}],
        last_session_sets=[],
        deterministic=det,
    )
    # Should NOT see "big overshoot" reason because feel was hard.
    assert not any("big overshoot" in r for r in reasons)
    _ok("hard feel suppresses overshoot suspicion")


def test_suspicion_pain_overrides_everything_even_clean_signal():
    print("\n[test] pain feel always escalates regardless of other signals")
    plan = _planned(target_reps="6-8")
    det = recommend_next_set(exercise=_bench(), planned_set=plan,
                             actual_reps=7, actual_weight_lbs=185.0, actual_rir=2.0)
    reasons = is_suspicious(
        planned_set=plan, actual_reps=7, actual_weight_lbs=185.0,
        feel="pain",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 2.0}],
        last_session_sets=[{"reps": 8, "weight_lbs": 180.0, "rir": 2.0}],
        deterministic=det,
    )
    assert any("pain" in r for r in reasons)
    _ok("pain → safety review")


def test_suspicion_form_breakdown_normalizes_to_failure_bucket():
    print("\n[test] feel='form_breakdown' treated as failure bucket")
    assert _feel_bucket("form_breakdown") == "failure"
    assert _feel_bucket("grind") == "hard"
    assert _feel_bucket(None) is None
    assert _feel_bucket("Made-up-feel") is None
    _ok("feel-bucket normalization handles aliases + unknowns")


# ── Group 9: reviewed_next_set_recommendation — full path (6 tests) ─

def test_reviewed_blocks_when_feel_missing_and_required():
    print("\n[test] require_feel=True + no feel → returns None (UI suppresses card)")
    plan = _planned()
    out = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=plan, actual_reps=7,
        actual_weight_lbs=185.0, actual_rir=2.0, feel=None, require_feel=True,
    )
    assert out is None
    _ok("missing feel + required → None")


def test_reviewed_clean_path_returns_deterministic_source():
    print("\n[test] non-suspicious clean run → source='deterministic', reasons=[]")
    plan = _planned(target_reps="6-8")
    out = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=plan, actual_reps=7,
        actual_weight_lbs=185.0, actual_rir=2.0, feel="good",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 1.0}],
        last_session_sets=[{"reps": 7, "weight_lbs": 185.0, "rir": 2.0}],
        require_feel=True,
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.suspicion_reasons == []
    _ok("clean → deterministic source")


def test_reviewed_suspicious_path_stays_deterministic():
    print("\n[test] suspicious → deterministic result with suspicion reasons")
    plan = _planned(target_reps="6-8", target_weight_lbs=185.0,
                    progression_mode="load_first")
    out = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=plan, actual_reps=10,
        actual_weight_lbs=185.0, actual_rir=3.0, feel="easy",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 2.0}],
        last_session_sets=[],
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.next_set_weight_lbs == 195.0
    assert out.suspicion_reasons  # at least one reason
    _ok("suspicious set remains deterministic")


def test_reviewed_suspicious_deterministic_reasons_attached():
    print("\n[test] suspicious set preserves suspicion_reasons")
    plan = _planned(target_reps="6-8", target_weight_lbs=185.0)
    out = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=plan, actual_reps=11,
        actual_weight_lbs=185.0, actual_rir=2.0, feel="easy",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 1.0}],
        last_session_sets=[],
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.suspicion_reasons  # reasons surface even on fallback
    _ok("deterministic fallback, reasons preserved")


def test_reviewed_big_rir_overshoot_uses_deterministic_large_jump():
    print("\n[test] big RIR overshoot uses deterministic +10")
    plan = _planned(target_reps="8-12", target_weight_lbs=60.0,
                    progression_mode="load_first")
    out = reviewed_next_set_recommendation(
        exercise=_decline_db_press(), planned_set=plan, actual_reps=18,
        actual_weight_lbs=60.0, actual_rir=4.0, feel="good",
        previous_sets_this_session=[{"reps": 12, "weight_lbs": 60.0, "rir": 2.0}],
        last_session_sets=[],
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.next_set_weight_lbs == 70.0
    assert any("big overshoot" in r for r in out.suspicion_reasons)
    _ok("big overshoot has deterministic +10")


def test_reviewed_suspicious_agreement_is_still_deterministic_source():
    print("\n[test] suspicious agreement path → source='deterministic'")
    plan = _planned(target_reps="6-8", target_weight_lbs=185.0,
                    progression_mode="load_first")
    out = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=plan, actual_reps=11,
        actual_weight_lbs=185.0, actual_rir=2.0, feel="good",
        previous_sets_this_session=[{"reps": 8, "weight_lbs": 185.0, "rir": 1.0}],
        last_session_sets=[],
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.next_set_weight_lbs == 195.0
    _ok("suspicious agreement remains deterministic")


def test_reviewed_suspicious_action_is_valid_deterministic_action():
    print("\n[test] suspicious path returns a valid deterministic action")
    plan = _planned(target_reps="6-8", target_weight_lbs=185.0,
                    progression_mode="load_first")
    out = reviewed_next_set_recommendation(
        exercise=_bench(), planned_set=plan, actual_reps=11,
        actual_weight_lbs=185.0, actual_rir=2.0, feel="easy",
        previous_sets_this_session=[],
        last_session_sets=[],
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.action in ("increase_load", "hold_load", "reduce_load", "keep_reps", "add_rep")
    _ok("deterministic action valid")


# ── Group 10: rolling_e1rm — gaps + realistic week sequences (8) ────

def _u(weight, reps, rir, days_ago, set_type="working", target_rir=None, today=None):
    today = today or date(2026, 4, 26)
    return UsableSet(
        completed_at=today - timedelta(days=days_ago),
        actual_weight_lbs=weight,
        actual_reps=reps,
        actual_rir=rir,
        target_rir=target_rir,
        set_type=set_type,
    )


def test_e1rm_rep_band_compound_lower_bound_3_excludes_2():
    print("\n[test] compound rep band [3, 10] — 2 reps excluded as outlier (single-rep PR)")
    today = date(2026, 4, 26)
    sets = [_u(225, 2, 0, d, today=today) for d in range(3)]  # all 2-rep singles
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is None
    _ok("2-rep PR set excluded → not enough usable")


def test_e1rm_rep_band_compound_upper_bound_10_excludes_15_rep_finisher():
    print("\n[test] compound 15-rep finisher excluded for primary role")
    today = date(2026, 4, 26)
    sets = [_u(135, 15, 1, d, today=today) for d in range(3)]
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is None
    _ok("15-rep finisher excluded for compound primary")


def test_e1rm_isolation_band_includes_15_rep_curls():
    print("\n[test] isolation rep band [6, 15] — 15-rep curls usable")
    today = date(2026, 4, 26)
    sets = [_u(30, 15, 1, d, today=today) for d in range(4)]
    out = compute_rolling_e1rm(sets, role="isolation", today=today)
    assert out is not None
    _ok(f"iso 15-rep curls usable: e1rm={out.e1rm_lbs:.1f}")


def test_e1rm_excludes_zero_weight_bodyweight_sets():
    print("\n[test] zero weight (bodyweight) → excluded")
    today = date(2026, 4, 26)
    sets = [_u(0, 8, 1, d, today=today) for d in range(5)]
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is None
    _ok("bodyweight 0 lb → unusable")


def test_e1rm_excludes_rir_above_4():
    print("\n[test] RIR > 4 (clearly not working set) → excluded")
    today = date(2026, 4, 26)
    sets = [_u(185, 8, 5.0, d, today=today) for d in range(5)]  # rir 5 is too easy
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is None
    _ok("rir 5.0 → unusable")


def test_e1rm_caps_to_max_samples_10_drops_oldest():
    print("\n[test] 12 usable sets → drops oldest 2, keeps 10")
    today = date(2026, 4, 26)
    sets = [_u(185, 8, 1, d, today=today) for d in range(12)]
    out = compute_rolling_e1rm(sets, role="primary", today=today, max_samples=10)
    assert out is not None
    assert out.sample_count == 10
    _ok("max_samples=10 enforced")


def test_e1rm_realistic_progression_recent_increase_dominates():
    print("\n[test] linear week-over-week progression — recent sets dominate")
    today = date(2026, 4, 26)
    # 3 weeks ago: 185 lb. 1 week ago: 195 lb. Today: 205 lb.
    sets = [
        _u(185, 8, 2, 21, today=today),
        _u(185, 8, 1, 21, today=today),
        _u(195, 8, 2, 7, today=today),
        _u(195, 8, 1, 7, today=today),
        _u(205, 8, 2, 0, today=today),
        _u(205, 8, 1, 0, today=today),
    ]
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is not None
    # Recent sets carry exponentially more weight than 21-day-old sets:
    # weight(21d) ≈ exp(-21·ln2/14) ≈ 0.354, weight(0d) = 1.0.
    # The weighted-median estimate should land closer to the 205 lb sets.
    # 205 × (1+9/30) ≈ 266.5 (today), 195 × (1+9/30) ≈ 253.5 (1w), 185 × (1+9/30) ≈ 240.5 (3w).
    assert out.e1rm_lbs >= 248.0  # at least the 195-lb estimate
    _ok(f"3-week progression → e1rm={out.e1rm_lbs:.1f} (recent dominates)")


def test_e1rm_outlier_hot_session_does_not_break_estimate():
    print("\n[test] one hot single session — median resists outlier pull")
    today = date(2026, 4, 26)
    # 5 normal-looking sets at 185 + 1 hot session at 225 (recent).
    sets = [
        _u(185, 8, 2, 14, today=today),
        _u(185, 8, 1, 14, today=today),
        _u(185, 8, 2, 7, today=today),
        _u(185, 8, 1, 7, today=today),
        _u(225, 8, 0, 0, today=today),  # hot day, much higher
        _u(225, 8, 0, 0, today=today),
    ]
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is not None
    # 185 sets give e1rm ≈ 185 × 1.3 = 240.5; hot 225 gives 225 × 1.27 ≈ 285.
    # Median resists the outlier — should land between the two.
    assert 240.0 <= out.e1rm_lbs <= 290.0
    _ok(f"outlier session bounded: e1rm={out.e1rm_lbs:.1f}")


# ── Group 11: realistic call-site shapes (3 tests) ─────────────────

def test_callsite_progression_router_minimal_planned_set_proxy():
    print("\n[test] /pre-set-recommendation builds minimal PlannedSet — exercises ALL fields")
    # The router builds: PlannedSet(set_number=N+1, set_type='volume',
    # target_reps='6-8', target_rir=2, target_weight_lbs=last_w, progression_mode='reps_first')
    proxy = PlannedSet(
        set_number=2, set_type="volume", target_reps="6-8",
        target_rir=2.0, target_weight_lbs=170.0, progression_mode="reps_first",
    )
    rec = recommend_next_set(
        exercise=_bench(), planned_set=proxy,
        actual_reps=7, actual_weight_lbs=170.0, actual_rir=1.5,
    )
    assert rec.action == "hold_load"
    assert rec.next_set_weight_lbs == 170.0
    _ok("router proxy planned-set produces valid rec")


def test_callsite_realistic_warmup_filtered_in_e1rm():
    print("\n[test] real session: 3 warmup + 4 working sets logged → e1RM uses only working")
    today = date(2026, 4, 26)
    sets = [
        _u(95, 8, 4, 0, set_type="warmup", today=today),
        _u(135, 5, 3, 0, set_type="warmup", today=today),
        _u(165, 3, 3, 0, set_type="warmup", today=today),
        _u(185, 8, 2, 0, set_type="working", today=today),
        _u(185, 8, 1, 0, set_type="working", today=today),
        _u(185, 7, 0, 0, set_type="working", today=today),
        _u(185, 6, 0, 0, set_type="working", today=today),
    ]
    out = compute_rolling_e1rm(sets, role="primary", today=today)
    assert out is not None
    assert out.sample_count == 4  # only working sets, not warmups
    _ok(f"warmups filtered: 4 working sets → e1rm={out.e1rm_lbs:.1f}")


def test_callsite_full_review_pipeline_with_realistic_inputs():
    print("\n[test] reviewed_next_set with realistic mid-session inputs")
    plan = _planned(set_number=3, set_type="backoff", target_reps="6-8",
                    target_rir=2.0, target_weight_lbs=170.0,
                    progression_mode="reps_first")
    out = reviewed_next_set_recommendation(
        exercise=_bench(),
        planned_set=plan,
        actual_reps=8,
        actual_weight_lbs=170.0,
        actual_rir=1.0,
        feel="good",
        previous_sets_this_session=[
            {"reps": 6, "weight_lbs": 185.0, "rir": 2.0, "feel": "good"},  # heavy_top
            {"reps": 8, "weight_lbs": 170.0, "rir": 1.5, "feel": "good"},  # backoff 1
        ],
        last_session_sets=[
            {"reps": 7, "weight_lbs": 165.0, "rir": 2.0},
            {"reps": 7, "weight_lbs": 165.0, "rir": 1.0},
        ],
        require_feel=True,
    )
    assert out is not None
    assert out.source == "deterministic"
    assert out.next_set_weight_lbs == 170.0  # reps_first → hold
    assert out.action == "hold_load"
    _ok(f"full pipeline: source={out.source}, action={out.action}")


def test_callsite_http_metadata_preserves_barbell_squat_10lb_increment():
    print("\n[test] HTTP metadata helper: Barbell Squat keeps 10 lb lower-body increment")
    from app.services.workout.exercise_metadata import set_programming_exercise_metadata

    exercise = set_programming_exercise_metadata(
        None,
        "Barbell Squat",
        "barbell_squat",
        "barbell",
        "quads",
    )
    assert exercise["is_compound"] is True
    assert exercise["movement_pattern"] == "squat"
    assert exercise["primary_muscle"] == "quads"
    assert load_increment_for(exercise) == 10.0

    plan = _planned(target_reps="5-7", target_rir=2.0, target_weight_lbs=275.0,
                    progression_mode="load_first")
    rec = recommend_next_set(exercise=exercise, planned_set=plan,
                             actual_reps=8, actual_weight_lbs=275.0, actual_rir=2.0)
    assert rec.action == "increase_load"
    assert rec.next_set_weight_lbs is not None
    assert rec.next_set_weight_lbs - 275.0 >= 10.0
    _ok(f"Barbell Squat metadata → increment 10, rec {rec.next_set_weight_lbs}")


def test_callsite_http_metadata_preserves_cable_isolation_2_5lb_increment():
    print("\n[test] HTTP metadata helper: Cable Pushdown keeps 2.5 lb isolation increment")
    from app.services.workout.exercise_metadata import set_programming_exercise_metadata

    exercise = set_programming_exercise_metadata(
        None,
        "Cable Pushdown",
        "cable_pushdown",
        "cable",
        "triceps",
    )
    assert exercise["is_compound"] is False
    assert exercise["primary_muscle"] == "triceps"
    assert load_increment_for(exercise) == 2.5
    _ok("Cable Pushdown metadata → increment 2.5")


def test_callsite_live_scheme_preserves_top_set_to_backoff_transition():
    print("\n[test] live setScheme maps heavy_top/backoff intent for progression router")
    from app.routers.ai.progression import (
        _planned_backoff_transition_weight,
        _planned_sets_from_live_scheme,
    )
    from app.workout_progression import SetType as ProgressionSetType

    scheme = [
        {
            "setNumber": 1,
            "setType": "heavy_top",
            "targetReps": "6-8",
            "targetRir": 2,
            "targetWeightLbs": 185,
            "progressionMode": "load_first",
        },
        {
            "setNumber": 2,
            "setType": "backoff",
            "targetReps": "6-8",
            "targetRir": 2,
            "targetWeightLbs": 170,
            "progressionMode": "reps_first",
        },
    ]
    planned = _planned_sets_from_live_scheme(
        raw_scheme=scheme,
        planned_set_count=2,
        plan_rep_target="6-8",
        fallback_set_type=ProgressionSetType.STRAIGHT,
    )
    assert planned[0].set_type == ProgressionSetType.TOP_SET
    assert planned[1].set_type == ProgressionSetType.BACKOFF
    assert planned[1].target_reps_override == "6-8"
    assert _planned_backoff_transition_weight(
        scheme,
        completed_set_number=1,
        next_set_number=2,
        completed_actual_weight_lbs=185,
    ) == 170.0
    _ok("heavy_top set 1 → backoff set 2 keeps planned 170 lb target")


def test_callsite_live_scheme_ignores_stale_swap_backoff_target():
    print("\n[test] live setScheme ignores stale backoff target after swapped lift")
    from app.routers.ai.progression import _planned_backoff_transition_weight

    stale_scheme = [
        {
            "setNumber": 1,
            "setType": "heavy_top",
            "targetReps": "5",
            "targetRir": 2,
            "targetWeightLbs": 80,
            "progressionMode": "load_first",
        },
        {
            "setNumber": 2,
            "setType": "backoff",
            "targetReps": "6-8",
            "targetRir": 2,
            "targetWeightLbs": 80,
            "progressionMode": "reps_first",
        },
    ]
    assert _planned_backoff_transition_weight(
        stale_scheme,
        completed_set_number=1,
        next_set_number=2,
        completed_actual_weight_lbs=115,
    ) is None
    _ok("actual 115 lb top set is not overridden by stale 80 lb backoff")


def test_callsite_pre_set_endpoint_prefers_planned_target_over_last_session():
    print("\n[test] /pre-set-recommendation uses PlanWeek target before stale last-session best")
    from app.routers.ai.models import PreSetRecommendRequest
    from app.routers.ai.progression import pre_set_recommendation

    body = PreSetRecommendRequest(
        exerciseName="Barbell Bench Press",
        exerciseSlug="barbell_bench_press",
        plannedSetNumber=1,
        plannedSets=[
            {
                "setNumber": 1,
                "setType": "heavy_top",
                "targetReps": "6-8",
                "targetRir": 2,
                "targetWeightLbs": 185,
                "progressionMode": "load_first",
            }
        ],
        priorSetsThisSession=[],
        lastSessionSets=[{"reps": 8, "weightLbs": 165}],
        goal="muscle_gain",
        equipment="barbell",
        primaryMuscle="chest",
    )
    out = pre_set_recommendation(
        body,
        current_user=SimpleNamespace(id=1),
        db=None,
    )
    assert out["recommendedWeightLbs"] == 185.0
    assert "plan set" in out["rationaleShort"]
    _ok("planned 185 lb target wins over last-session 165 lb")


def test_callsite_recommend_weight_big_rir_overshoot_skips_backoff_override():
    print("\n[test] /recommend-weight big RIR overshoot is not crushed by planned backoff")
    from app.routers.ai.models import WeightRecommendRequest
    from app.routers.ai.progression import recommend_weight

    body = WeightRecommendRequest(
        exerciseName="Decline Dumbbell Press",
        exerciseSlug="decline_dumbbell_press",
        goal="muscle_gain",
        lastSets=[{"setNumber": 1, "reps": 18, "weightLbs": 60, "rir": 4}],
        nextSetNumber=2,
        targetSets=3,
        targetReps="8-12",
        progressionPace="moderate",
        experienceLevel="intermediate",
        recoveryLevel="normal",
        phase="accumulation",
        workoutFocus="push",
        weekNumber=1,
        incrementLbs=5,
        equipment="dumbbell",
        primaryMuscle="chest",
        setScheme=[
            {
                "setNumber": 1,
                "setType": "heavy_top",
                "targetReps": "8-12",
                "targetRir": 2,
                "targetWeightLbs": 60,
                "progressionMode": "load_first",
            },
            {
                "setNumber": 2,
                "setType": "backoff",
                "targetReps": "8-12",
                "targetRir": 2,
                "targetWeightLbs": 55,
                "progressionMode": "reps_first",
            },
            {
                "setNumber": 3,
                "setType": "backoff",
                "targetReps": "8-12",
                "targetRir": 2,
                "targetWeightLbs": 55,
                "progressionMode": "reps_first",
            },
        ],
    )
    with patch("app.services.workout.history.get_recent_completions_for_fatigue", return_value=[]):
        out = recommend_weight(body, current_user=SimpleNamespace(id=1), db=None)

    assert out["action"] == "increase", out
    assert out["weightLbs"] == 70.0, out
    assert any("big overshoot" in r for r in out["suspicionReasons"]), out
    _ok("60 lb + huge overshoot → 70 lb, not stale 55 lb backoff")


# ── Runner ──────────────────────────────────────────────────────────


def _run_all():
    tests = [
        # Group 1: load_increment_for
        test_inc_dumbbell_compound_5lb,
        test_inc_machine_compound_5lb,
        test_inc_machine_isolation_2_5lb,
        test_inc_cable_isolation_2_5lb,
        test_inc_lower_body_isolation_via_muscle_inference,
        test_inc_unknown_equipment_falls_back_to_5lb,
        # Group 2: round_to_increment
        test_round_5lb_rounds_to_nearest_not_floor,
        test_round_5lb_at_midpoint_rounds_to_even,
        test_round_2_5lb_increment_dumbbell_iso,
        test_round_zero_increment_bodyweight_returns_unchanged,
        # Group 3: parse_rep_range
        test_parse_single_rep_count,
        test_parse_handles_leading_trailing_whitespace,
        test_parse_returns_none_for_seconds,
        test_parse_returns_none_for_minutes,
        test_parse_returns_none_for_garbage,
        # Group 4: build_set_scheme
        test_scheme_strength_primary_compound_heavy_top_rir_lower_than_backoff,
        test_scheme_muscle_gain_5_sets_emits_volume_tail,
        test_scheme_body_recomp_routes_through_hypertrophy_branch,
        test_scheme_athletic_performance_routes_through_hypertrophy_branch,
        test_scheme_endurance_emits_straight_volume_reps_first,
        test_scheme_technique_role_overrides_goal_with_75pct_load,
        test_scheme_timed_hold_emits_null_loads_no_progression_logic,
        test_scheme_isolation_under_muscle_gain_stays_volume,
        # Group 5: recommend_next_set
        test_next_exact_top_of_range_with_rir_load_first_increases,
        test_next_one_rep_above_top_load_first_increases_by_increment,
        test_next_big_db_press_overshoot_with_4rir_adds_two_increments,
        test_next_big_reps_first_overshoot_bumps_instead_of_waiting,
        test_next_beat_top_low_rir_does_not_increase,
        test_next_beat_top_squat_adds_real_10_lb_even_off_grid,
        test_next_reps_first_beat_top_holds_load_explanation_mentions_session_bump,
        test_next_fixed_skill_beat_top_explicitly_holds,
        test_next_severe_miss_at_failure_drops_proportionally,
        test_next_minor_miss_at_failure_drops_one_increment,
        test_next_miss_without_rir_drops_one_increment,
        test_next_miss_with_rir_in_reserve_holds_load,
        test_next_timed_hold_always_returns_hold_with_unchanged_target,
        # Group 5b: off-grid anchor regression
        test_off_grid_anchor_minor_miss_at_failure_drops_real_increment,
        test_off_grid_anchor_session_increase_real_progress,
        test_off_grid_anchor_session_decrease_real_progress,
        test_on_grid_anchor_unchanged_after_fix,
        # Group 6: realistic multi-set sequences
        test_sequence_strength_top_set_then_two_backoffs_progresses_correctly,
        test_sequence_fatigue_cascade_drops_load_late_in_session,
        test_sequence_strong_day_session_recommendation_pushes_load_next_session,
        test_sequence_grindy_day_session_drops_load_next_session,
        test_sequence_partial_progress_holds_next_session,
        # Group 7: recommend_next_session_load gaps
        test_next_session_no_history_returns_planned_load,
        test_next_session_non_numeric_reps_holds,
        test_next_session_reps_first_at_top_holds_load_and_chases_reps,
        # Group 8: is_suspicious branches
        test_suspicion_feel_failure_in_range_flagged,
        test_suspicion_feel_easy_at_top_warrants_bigger_jump_flag,
        test_suspicion_increase_with_hard_feel_is_form_risk,
        test_suspicion_clean_in_range_with_history_is_not_flagged,
        test_suspicion_no_history_clean_feel_is_not_auto_flagged,
        test_suspicion_overshoot_with_hard_feel_NOT_flagged,
        test_suspicion_pain_overrides_everything_even_clean_signal,
        test_suspicion_form_breakdown_normalizes_to_failure_bucket,
        # Group 9: reviewed_next_set_recommendation full path
        test_reviewed_blocks_when_feel_missing_and_required,
        test_reviewed_clean_path_returns_deterministic_source,
        test_reviewed_suspicious_path_stays_deterministic,
        test_reviewed_suspicious_deterministic_reasons_attached,
        test_reviewed_big_rir_overshoot_uses_deterministic_large_jump,
        test_reviewed_suspicious_agreement_is_still_deterministic_source,
        test_reviewed_suspicious_action_is_valid_deterministic_action,
        # Group 10: rolling_e1rm gaps
        test_e1rm_rep_band_compound_lower_bound_3_excludes_2,
        test_e1rm_rep_band_compound_upper_bound_10_excludes_15_rep_finisher,
        test_e1rm_isolation_band_includes_15_rep_curls,
        test_e1rm_excludes_zero_weight_bodyweight_sets,
        test_e1rm_excludes_rir_above_4,
        test_e1rm_caps_to_max_samples_10_drops_oldest,
        test_e1rm_realistic_progression_recent_increase_dominates,
        test_e1rm_outlier_hot_session_does_not_break_estimate,
        # Group 11: realistic call-site shapes
        test_callsite_progression_router_minimal_planned_set_proxy,
        test_callsite_realistic_warmup_filtered_in_e1rm,
        test_callsite_full_review_pipeline_with_realistic_inputs,
        test_callsite_http_metadata_preserves_barbell_squat_10lb_increment,
        test_callsite_http_metadata_preserves_cable_isolation_2_5lb_increment,
        test_callsite_live_scheme_preserves_top_set_to_backoff_transition,
        test_callsite_live_scheme_ignores_stale_swap_backoff_target,
        test_callsite_pre_set_endpoint_prefers_planned_target_over_last_session,
        test_callsite_recommend_weight_big_rir_overshoot_skips_backoff_override,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            import traceback
            traceback.print_exc()
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            import traceback
            traceback.print_exc()
            print(f"  ✗ {t.__name__}: {type(e).__name__}: {e}")
    print()
    print(f"\n{len(tests) - failed}/{len(tests)} passed" if failed == 0 else f"{failed}/{len(tests)} FAILED")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
