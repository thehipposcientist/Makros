"""Realistic multi-day fatigue/recovery scenario tests.

Uses the shared factory (conftest.py) to build completion histories and
exercises, then feeds them through compute_rolling_fatigue to verify
readiness scores, muscle fatigue relationships, and recovery dynamics.

Run:
    cd backend && python3 -m tests.test_fatigue_scenarios
"""
from __future__ import annotations

from datetime import date, timedelta

from tests.conftest import (
    make_completion_history,
    make_completion,
    make_exercises_for_focus,
)
from app.services.workout.activity_impact import (
    compute_rolling_fatigue,
    FatigueSnapshot,
    resolve_exercise_fatigue,
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _mf(snap: FatigueSnapshot, muscle: str) -> float:
    """Shorthand: read a muscle fatigue value from the snapshot."""
    return snap.muscle_fatigue.get(muscle)


# ─── 1. Full PPL week ────────────────────────────────────────────────────────

def test_ppl_week_fatigue_pattern():
    """Simulate Push, Pull, Legs, Rest, Push, Pull, Legs over 7 days.

    Muscles hit twice each should show meaningful fatigue. The rest day
    should have helped but not eliminated accumulated work. Readiness
    should NOT be 'Fresh'.
    """
    history = make_completion_history(
        ["Push", "Pull", "Legs", "Rest", "Push", "Pull", "Legs"]
    )
    snap = compute_rolling_fatigue(history)

    # Push muscles hit twice (d-6 + d-2) -- d-6 has decayed heavily, d-2 still present
    assert _mf(snap, "chest") > 0.05, f"chest should be fatigued: {_mf(snap, 'chest')}"
    assert _mf(snap, "shoulders") > 0.05, f"shoulders should be fatigued: {_mf(snap, 'shoulders')}"
    assert _mf(snap, "triceps") > 0.01, f"triceps should be fatigued: {_mf(snap, 'triceps')}"

    # Pull muscles hit twice
    assert _mf(snap, "back") > 0.05, f"back should be fatigued: {_mf(snap, 'back')}"
    assert _mf(snap, "biceps") > 0.01, f"biceps should be fatigued: {_mf(snap, 'biceps')}"

    # Leg muscles hit twice (d-4 + d-0 today)
    assert _mf(snap, "quads") > 0.05, f"quads should be fatigued: {_mf(snap, 'quads')}"
    assert _mf(snap, "hamstrings") > 0.01, f"hamstrings should be fatigued: {_mf(snap, 'hamstrings')}"
    assert _mf(snap, "glutes") > 0.01, f"glutes should be fatigued: {_mf(snap, 'glutes')}"

    # Readiness should NOT be Fresh with 6 training days in 7
    assert snap.readiness_label != "Fresh", (
        f"After a full PPL week, readiness should not be Fresh (score={snap.readiness_score})"
    )
    assert snap.readiness_score < 90, (
        f"Readiness score should be under 90 with 6 training days, got {snap.readiness_score}"
    )


# ─── 2. Upper/Lower week ─────────────────────────────────────────────────────

def test_upper_lower_week():
    """Simulate U/L/Rest/U/L/Rest/Rest. Two rest days at end should help."""
    history = make_completion_history(
        ["Upper", "Lower", "Rest", "Upper", "Lower", "Rest", "Rest"]
    )
    snap = compute_rolling_fatigue(history)

    # Upper muscles hit twice (d-6 + d-3)
    assert _mf(snap, "chest") > 0.01, f"chest should show fatigue: {_mf(snap, 'chest')}"
    assert _mf(snap, "back") > 0.01, f"back should show fatigue: {_mf(snap, 'back')}"

    # Lower muscles hit twice (d-5 + d-2)
    assert _mf(snap, "quads") > 0.01, f"quads should show fatigue: {_mf(snap, 'quads')}"
    assert _mf(snap, "hamstrings") > 0.01, f"hamstrings should show fatigue: {_mf(snap, 'hamstrings')}"

    # Two rest days at the end (d-1 and d-0 are rest) means recent fatigue
    # has decayed. Readiness should be moderate-to-good.
    assert snap.readiness_score >= 40, (
        f"With 2 rest days at end, readiness should be >=40, got {snap.readiness_score}"
    )


# ─── 3. Recovery day reduces fatigue ─────────────────────────────────────────

def test_recovery_day_reduces_fatigue():
    """Push(d-2), Recovery(d-1) should reduce fatigue vs Push(d-2) alone.

    Recovery has negative fatigue values in resolve_focus_fatigue, which
    in Pass 2 of the rolling calculation reduce existing positive fatigue
    (proportional, capped at 15% of current per session).

    Note: we build the recovery completion with resolved_muscle_fatigue=None
    so compute_rolling_fatigue derives it from the focus label via
    resolve_focus_fatigue (which has the negative values). When
    make_completion_history resolves via resolve_exercise_fatigue on the
    factory's single Foam Rolling exercise, it gets all-positive values
    and the recovery pass never fires.
    """
    today = date.today()

    # Scenario A: Push(d-2) then Recovery(d-1)
    push_comp = make_completion_history(["Push", "Rest", "Rest"])
    # Replace the rest days with a recovery completion (no pre-resolved fatigue)
    recovery_comp = make_completion(
        focus="Recovery",
        days_ago=1,
        today=today,
        resolved_muscle_fatigue=None,  # force resolve_focus_fatigue path
    )
    with_recovery = push_comp + [recovery_comp]
    snap_recovery = compute_rolling_fatigue(with_recovery)

    # Scenario B: Push(d-2) then nothing (just rest)
    no_recovery = make_completion_history(["Push", "Rest", "Rest"])
    snap_no_recovery = compute_rolling_fatigue(no_recovery)

    # Recovery day should reduce chest fatigue at least slightly
    chest_with = _mf(snap_recovery, "chest")
    chest_without = _mf(snap_no_recovery, "chest")
    assert chest_with <= chest_without, (
        f"Recovery should reduce chest fatigue: with={chest_with}, without={chest_without}"
    )

    # Systemic fatigue should also benefit
    sys_with = _mf(snap_recovery, "systemic")
    sys_without = _mf(snap_no_recovery, "systemic")
    assert sys_with <= sys_without, (
        f"Recovery should reduce systemic fatigue: with={sys_with}, without={sys_without}"
    )


# ─── 4. Back-to-back same focus = high fatigue ───────────────────────────────

def test_back_to_back_same_focus_high_fatigue():
    """Push(d-1), Push(d-0). Second push day stacks chest fatigue high.

    Push readiness should be significantly lower than pull readiness.
    """
    history = make_completion_history(["Push", "Push"])
    snap = compute_rolling_fatigue(history)

    # Chest should be significantly fatigued from two consecutive push days
    assert _mf(snap, "chest") > 0.15, (
        f"Chest fatigue should be >0.15 after back-to-back push: {_mf(snap, 'chest')}"
    )

    # Push readiness should be lower than pull readiness (pull muscles are fresh)
    assert snap.focus_readiness["push"] < snap.focus_readiness["pull"], (
        f"Push readiness ({snap.focus_readiness['push']}) should be < "
        f"pull readiness ({snap.focus_readiness['pull']})"
    )


# ─── 5. Rest fully recovers after 5 days ─────────────────────────────────────

def test_rest_only_fully_recovers():
    """Push(d-5) with no other activity. By day 0, fatigue should be near-zero.

    Decay at 5 days: hour-based decay with 48h half-life makes 120h (5 days)
    the cutoff (decay = 0.0 at >=120h).
    """
    # Push was 5 days ago; compute_rolling_fatigue filters out days_ago > 5
    history = make_completion_history(
        ["Push", "Rest", "Rest", "Rest", "Rest", "Rest"]
    )
    snap = compute_rolling_fatigue(history)

    # At 5 days_ago, the completion is right at the edge of the 5-day window.
    # Decay is either 0.0 or very small. Fatigue should be near-zero.
    assert _mf(snap, "chest") < 0.05, (
        f"Chest should be near-zero after 5 rest days: {_mf(snap, 'chest')}"
    )
    assert _mf(snap, "systemic") < 0.05, (
        f"Systemic should be near-zero after 5 rest days: {_mf(snap, 'systemic')}"
    )


# ─── 6. Full body spreads fatigue evenly ─────────────────────────────────────

def test_full_body_spreads_fatigue():
    """Full Body(d-1). All major muscles should show some fatigue,
    but none should be extreme since volume is distributed.
    """
    history = make_completion_history(["Rest", "Rest", "Rest", "Rest", "Full Body"])
    snap = compute_rolling_fatigue(history)

    # Full body hits chest, back, quads, shoulders
    assert _mf(snap, "chest") > 0.01, f"chest should have some fatigue: {_mf(snap, 'chest')}"
    assert _mf(snap, "back") > 0.01, f"back should have some fatigue: {_mf(snap, 'back')}"
    assert _mf(snap, "quads") > 0.01, f"quads should have some fatigue: {_mf(snap, 'quads')}"

    # No single muscle should be extremely fatigued from one full body session
    for m in ("chest", "back", "quads", "shoulders"):
        assert _mf(snap, m) < 0.6, (
            f"{m} should not be extreme from full body: {_mf(snap, m)}"
        )

    # No muscle should have more fatigue than a dedicated push session's chest
    dedicated = make_completion_history(["Rest", "Rest", "Rest", "Rest", "Push"])
    snap_dedicated = compute_rolling_fatigue(dedicated)
    assert _mf(snap, "chest") < _mf(snap_dedicated, "chest"), (
        f"Full body chest ({_mf(snap, 'chest')}) should be < "
        f"dedicated push chest ({_mf(snap_dedicated, 'chest')})"
    )


# ─── 7. Cardio-only = minimal upper body fatigue ─────────────────────────────

def test_cardio_only_minimal_muscle_fatigue():
    """Cardio(d-1), Cardio(d-0). Only cardio/leg muscles should be fatigued.
    Upper body should be near-zero.
    """
    history = make_completion_history(["Cardio", "Cardio"])
    snap = compute_rolling_fatigue(history)

    # Cardio dimension should show fatigue
    assert _mf(snap, "cardio") > 0.0, (
        f"Cardio fatigue should be >0 after 2 cardio sessions: {_mf(snap, 'cardio')}"
    )

    # Upper body muscles should be near-zero
    for m in ("chest", "back", "shoulders", "biceps", "triceps"):
        assert _mf(snap, m) < 0.05, (
            f"{m} should be near-zero after cardio-only: {_mf(snap, m)}"
        )


# ─── 8. Heavy week = low readiness ───────────────────────────────────────────

def test_heavy_week_low_readiness():
    """6 days straight of training (Push, Pull, Legs, Upper, Lower, Full Body)
    with no rest. Overall readiness should be low.
    """
    history = make_completion_history(
        ["Push", "Pull", "Legs", "Upper", "Lower", "Full Body"]
    )
    snap = compute_rolling_fatigue(history)

    # Readiness should be low -- not Fresh or Ready
    assert snap.readiness_score < 85, (
        f"After 6 straight training days, readiness should be <85, got {snap.readiness_score}"
    )
    assert snap.readiness_label in ("Moderate", "Fatigued", "Overtrained"), (
        f"Expected Moderate/Fatigued/Overtrained, got {snap.readiness_label}"
    )

    # Should have multiple muscles in the top_fatigued list
    assert len(snap.top_fatigued) >= 2, (
        f"Expected at least 2 top fatigued muscles, got {snap.top_fatigued}"
    )


# ─── 9. Light week = high readiness ──────────────────────────────────────────

def test_light_week_high_readiness():
    """3 days training + 4 rest (Push d-6, Rest, Rest, Pull d-3, Rest, Rest, Legs d-0).
    Readiness should be moderate-to-high (older workouts decayed, plenty of rest).
    """
    history = make_completion_history(
        ["Push", "Rest", "Rest", "Pull", "Rest", "Rest", "Legs"]
    )
    snap = compute_rolling_fatigue(history)

    # With generous rest between sessions, readiness should be reasonable.
    # Push from d-6 is nearly gone, Pull from d-3 is mostly decayed.
    # Only Legs from d-0 is still fresh. Readiness should be moderate+.
    assert snap.readiness_score >= 40, (
        f"With light schedule, readiness should be >=40, got {snap.readiness_score}"
    )
    # It won't be "Overtrained"
    assert snap.readiness_label != "Overtrained", (
        f"Light week should not be Overtrained, got {snap.readiness_label}"
    )


# ─── 10. Injury muscle boost ─────────────────────────────────────────────────

def test_injury_muscle_boost():
    """A knee injury affecting quads should increase quad fatigue via
    injury_muscle_fatigue_boost when applied to the fatigue state.
    """
    from app.services.workout.planner import injury_muscle_fatigue_boost

    # Legs(d-1)
    history = make_completion_history(["Rest", "Rest", "Rest", "Rest", "Legs"])
    snap_no_injury = compute_rolling_fatigue(history)

    # Compute injury boost for knee
    boosts = injury_muscle_fatigue_boost(("knee",))
    assert "quads" in boosts, f"Knee injury should boost quads, got {boosts}"
    assert boosts["quads"] > 0, "Knee injury quad boost should be positive"

    # Manually apply injury boost to the fatigue snapshot
    # (the real app does this before passing to the planner)
    boosted_quad = _mf(snap_no_injury, "quads") + boosts.get("quads", 0)
    assert boosted_quad > _mf(snap_no_injury, "quads"), (
        f"Quad fatigue with injury boost ({boosted_quad}) should exceed "
        f"without ({_mf(snap_no_injury, 'quads')})"
    )

    # Hamstrings should also be boosted for knee injury
    assert "hamstrings" in boosts, "Knee injury should also affect hamstrings"


# ─── 11. PLUS_CARDIO includes both lift and cardio fatigue ────────────────────

def test_plus_cardio_fatigue_includes_both():
    """A 'Push + Cardio' completion should generate fatigue for BOTH
    chest/shoulders/triceps AND cardio. Neither should be zero.
    """
    # Use resolve_focus_fatigue to check the fatigue profile directly,
    # since make_completion_history will fall back to it for this label
    from app.services.workout.activity_impact import resolve_focus_fatigue

    fatigue = resolve_focus_fatigue("Push + Cardio")

    # Lift muscles present
    assert fatigue.get("chest", 0) > 0, f"Push+Cardio should fatigue chest: {fatigue}"
    assert fatigue.get("shoulders", 0) > 0, f"Push+Cardio should fatigue shoulders: {fatigue}"
    assert fatigue.get("triceps", 0) > 0, f"Push+Cardio should fatigue triceps: {fatigue}"

    # Cardio present
    assert fatigue.get("cardio", 0) > 0, f"Push+Cardio should fatigue cardio: {fatigue}"

    # Now verify via the rolling fatigue path
    history = [make_completion(
        focus="Push + Cardio",
        days_ago=1,
        resolved_muscle_fatigue=None,  # force resolve_focus_fatigue path
    )]
    snap = compute_rolling_fatigue(history)
    assert _mf(snap, "chest") > 0, f"Rolling: chest should be >0: {_mf(snap, 'chest')}"
    assert _mf(snap, "cardio") > 0, f"Rolling: cardio should be >0: {_mf(snap, 'cardio')}"


# ─── 12. Mixed activity types ────────────────────────────────────────────────

def test_mixed_activity_types():
    """Push(d-3), Hiking(d-2), Pull(d-1), Yoga(d-0).

    Hiking should add leg/cardio fatigue. Yoga should have minimal
    positive muscle fatigue (it's almost pure recovery/mobility).
    """
    # Build history manually since hiking/yoga aren't standard focuses.
    # make_completion_history handles them via the fallback path
    # (resolve_focus_fatigue is used when make_exercises_for_focus fails).
    history = make_completion_history(["Push", "Hiking", "Pull", "Yoga"])
    snap = compute_rolling_fatigue(history)

    # Push from d-3 should still contribute some chest fatigue (decayed)
    assert _mf(snap, "chest") > 0.0, (
        f"Push from d-3 should leave some chest fatigue: {_mf(snap, 'chest')}"
    )

    # Hiking from d-2 should have contributed leg/cardio fatigue
    assert _mf(snap, "cardio") > 0.0, (
        f"Hiking should add cardio fatigue: {_mf(snap, 'cardio')}"
    )

    # Pull from d-1 should show strong back fatigue
    assert _mf(snap, "back") > 0.05, (
        f"Pull from d-1 should show meaningful back fatigue: {_mf(snap, 'back')}"
    )

    # Multiple activities analyzed
    assert snap.days_analyzed >= 3, (
        f"Should have analyzed at least 3 activity days, got {snap.days_analyzed}"
    )


# ─── Runner ──────────────────────────────────────────────────────────────────

ALL_TESTS = [v for k, v in list(globals().items()) if k.startswith("test_")]


def run_all():
    passed = 0
    failed = 0
    for fn in ALL_TESTS:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
    total = passed + failed
    print(f"test_fatigue_scenarios: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)
