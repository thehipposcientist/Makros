"""Tests for the completed-today overlay fix.

When a user has already completed today's workout and triggers a full
regen, day 0 of the plan maps to today. The client overlays day 0 with
the completed session. Without the fix, the anchor advanced day 0 to
the NEXT family, which got wasted under the overlay — shifting the
entire split cycle by one.

The fix: pass `completed_today_family` to the recipe generator. The
anchor places today's family at day 0 so the overlay is harmless and
day 1+ follows the correct cycle.

These tests simulate the client overlay (replace day 0) and verify
the resulting split cycle is correct.

Run:
    docker exec thallo-backend python -m tests.test_completed_today_overlay
"""
from __future__ import annotations


def _gen(goal, days, split, families, buckets, completed_today):
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.archetypes import archetype_to_focus_family
    profile = goal_profile_for(goal)
    recipe = generate_weekly_recipe(
        profile, days,
        lifting_split=split,
        recent_focus_families=families,
        recent_focus_buckets=buckets,
        completed_today_family=completed_today,
    )
    return [archetype_to_focus_family(a) for a in recipe]


def _overlay(fams, today_family):
    """Simulate client overlay: replace day 0 with today's completed family."""
    return [today_family] + fams[1:]


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_ne(actual, forbidden, label):
    assert actual != forbidden, f"{label}: got {actual!r}, should not be {forbidden!r}"
    print(f"  ✓ {label}")


# ===================================================================
# PPL — completed today → overlay preserves cycle
# ===================================================================

def test_ppl_5d_push_today():
    """Push+Cardio done today. After overlay, cycle: Push→Pull→Legs→..."""
    print("[overlay] PPL 5d: Push completed today")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    assert_eq(fams[0], "push", "day0=push (matches today)")
    after = _overlay(fams, "push")
    assert_eq(after[1], "pull", "day1=pull after overlay")


def test_ppl_6d_push_today():
    """6-day PPL after Push today."""
    print("[overlay] PPL 6d: Push completed today")
    fams = _gen("muscle_gain", 6, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    assert_eq(fams[0], "push", "day0=push")
    after = _overlay(fams, "push")
    assert_eq(after[1], "pull", "day1=pull")
    assert_eq(after[2], "legs", "day2=legs")


def test_ppl_7d_push_today():
    """7-day PPL after Push today."""
    print("[overlay] PPL 7d: Push completed today")
    fams = _gen("muscle_gain", 7, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    assert_eq(fams[0], "push", "day0=push")
    after = _overlay(fams, "push")
    assert_eq(after[1], "pull", "day1=pull")
    assert_eq(after[2], "legs", "day2=legs")


def test_ppl_5d_pull_today():
    """Pull done today → overlay: Pull, Legs, Push, ..."""
    print("[overlay] PPL 5d: Pull completed today")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("pull", "push", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="pull")
    assert_eq(fams[0], "pull", "day0=pull")
    after = _overlay(fams, "pull")
    assert_eq(after[1], "legs", "day1=legs after pull")


def test_ppl_5d_legs_today():
    """Legs done today → overlay: Legs, Push, Pull, ..."""
    print("[overlay] PPL 5d: Legs completed today")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("legs", "pull", "push"),
                buckets=("lower_body", "upper_body", "upper_body"),
                completed_today="legs")
    assert_eq(fams[0], "legs", "day0=legs")
    after = _overlay(fams, "legs")
    assert_eq(after[1], "push", "day1=push after legs")


# ===================================================================
# U/L — completed today → overlay preserves alternation
# ===================================================================

def test_ul_4d_upper_today():
    """Upper done today → overlay: Upper, Lower, Upper, Lower."""
    print("[overlay] U/L 4d: Upper completed today")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("upper", "lower", "upper"),
                buckets=("upper_body", "lower_body", "upper_body"),
                completed_today="upper")
    assert_eq(fams[0], "upper", "day0=upper")
    after = _overlay(fams, "upper")
    assert_eq(after[1], "lower", "day1=lower after upper")
    for i in range(len(after) - 1):
        if after[i] in ("upper", "lower") and after[i+1] in ("upper", "lower"):
            assert_ne(after[i], after[i+1], f"alternation at {i},{i+1}")


def test_ul_4d_lower_today():
    """Lower done today → overlay: Lower, Upper, Lower, Upper."""
    print("[overlay] U/L 4d: Lower completed today")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("lower", "upper"),
                buckets=("lower_body", "upper_body"),
                completed_today="lower")
    assert_eq(fams[0], "lower", "day0=lower")
    after = _overlay(fams, "lower")
    assert_eq(after[1], "upper", "day1=upper after lower")


def test_ul_6d_upper_today():
    """U/L 6-day: Upper done today."""
    print("[overlay] U/L 6d: Upper completed today")
    fams = _gen("muscle_gain", 6, "upper_lower",
                families=("upper", "lower"),
                buckets=("upper_body", "lower_body"),
                completed_today="upper")
    assert_eq(fams[0], "upper", "day0=upper")
    after = _overlay(fams, "upper")
    assert_eq(after[1], "lower", "day1=lower")


# ===================================================================
# +Cardio normalization in history
# ===================================================================

def test_plus_cardio_normalization():
    """All +Cardio variants resolve to lift family."""
    print("[overlay] +Cardio normalization")
    from app.services.workout.focus_normalize import normalize_focus_to_family
    cases = {
        "Push + Cardio": "push",
        "Push+Cardio": "push",
        "push_plus_cardio": "push",
        "lift_push_plus_cardio": "push",
        "Pull + Cardio": "pull",
        "Pull+Cardio": "pull",
        "lift_pull_plus_cardio": "pull",
        "Upper + Cardio": "upper",
        "lift_upper_plus_cardio": "upper",
        "Full Body + Cardio": "full_body",
        "lift_full_body_plus_cardio": "full_body",
    }
    for label, expected in cases.items():
        actual = normalize_focus_to_family(label)
        assert actual == expected, f"normalize({label!r}): got {actual!r}, expected {expected!r}"
        print(f"  ✓ {label!r} → {actual!r}")


def test_plus_cardio_bucket_normalization():
    """All +Cardio variants resolve to correct bucket too."""
    print("[overlay] +Cardio bucket normalization")
    from app.services.workout.focus_normalize import normalize_focus_to_bucket
    cases = {
        "Push+Cardio": "upper_body",
        "push_plus_cardio": "upper_body",
        "lift_push_plus_cardio": "upper_body",
        "Pull+Cardio": "upper_body",
        "Upper+Cardio": "upper_body",
        "Full Body+Cardio": "full_body",
        "Cardio": "cardio",
    }
    for label, expected in cases.items():
        actual = normalize_focus_to_bucket(label)
        assert actual == expected, f"bucket({label!r}): got {actual!r}, expected {expected!r}"
        print(f"  ✓ {label!r} → {actual!r}")


# ===================================================================
# +Cardio focus labels in history → correct cycle continuation
# ===================================================================

def test_ppl_push_cardio_label_in_history():
    """History has 'Push + Cardio' as focus_label (not just 'push').
    The cycle should still advance correctly."""
    print("[overlay] PPL: 'Push + Cardio' in history")
    from app.services.workout.focus_normalize import normalize_focus_to_family
    today_fam = normalize_focus_to_family("Push + Cardio")
    assert_eq(today_fam, "push", "Push+Cardio normalizes to push")
    fams = _gen("muscle_gain", 5, "ppl",
                families=(today_fam, "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today=today_fam)
    after = _overlay(fams, today_fam)
    assert_eq(after[1], "pull", "day1=pull after Push+Cardio")


def test_ul_upper_cardio_label_in_history():
    """History has 'Upper + Cardio'. Cycle continues: Upper → Lower."""
    print("[overlay] U/L: 'Upper + Cardio' in history")
    from app.services.workout.focus_normalize import normalize_focus_to_family
    today_fam = normalize_focus_to_family("Upper + Cardio")
    assert_eq(today_fam, "upper", "Upper+Cardio normalizes to upper")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=(today_fam, "lower"),
                buckets=("upper_body", "lower_body"),
                completed_today=today_fam)
    after = _overlay(fams, today_fam)
    assert_eq(after[1], "lower", "day1=lower after Upper+Cardio")


# ===================================================================
# Different goals with +Cardio
# ===================================================================

def test_fat_loss_ppl_push_today():
    """Fat loss uses lifting_plus_cardio mode. Day 0 anchored to push,
    subsequent lifts should NOT repeat push immediately."""
    print("[overlay] Fat loss PPL: Push completed today")
    fams = _gen("fat_loss", 5, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    assert_eq(fams[0], "push", "day0=push")
    lift_fams = [f for f in fams if f in ("push", "pull", "legs")]
    if len(lift_fams) >= 2:
        assert_ne(lift_fams[1], "push", "second lift is not push again")


def test_strength_ul_upper_today():
    """Strength mode U/L: Upper done today."""
    print("[overlay] Strength U/L: Upper completed today")
    fams = _gen("strength", 4, "upper_lower",
                families=("upper", "lower"),
                buckets=("upper_body", "lower_body"),
                completed_today="upper")
    assert_eq(fams[0], "upper", "day0=upper")
    after = _overlay(fams, "upper")
    lift_fams = [f for f in after if f in ("upper", "lower")]
    if len(lift_fams) >= 2:
        assert_eq(lift_fams[1], "lower", "second lift=lower")


def test_body_recomp_ul_upper_today():
    """Body recomp U/L: Upper done today. Uses lifting_plus_cardio mode.
    Day 0 should be upper, day 1+ alternates."""
    print("[overlay] Body recomp U/L: Upper completed today")
    fams = _gen("body_recomp", 4, "upper_lower",
                families=("upper", "lower"),
                buckets=("upper_body", "lower_body"),
                completed_today="upper")
    assert_eq(fams[0], "upper", "day0=upper")
    after = _overlay(fams, "upper")
    lift_fams = [f for f in after if f in ("upper", "lower")]
    if len(lift_fams) >= 2:
        assert_eq(lift_fams[1], "lower", "second lift=lower")


# ===================================================================
# No completed_today (single-day path) still advances
# ===================================================================

def test_no_completed_today_still_advances():
    """Without completed_today_family, anchor advances as before."""
    print("[overlay] No completed_today: single-day path still advances")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today=None)
    assert_eq(fams[0], "pull", "day0=pull (advanced past push)")


# ===================================================================
# User-reported scenario: exact reproduction
# ===================================================================

def test_user_scenario_push_cardio_today_pull_yesterday_rest_legs():
    """Exact scenario: Push+Cardio today, Pull yesterday, Rest, Legs.
    Regen should give today=Push (preserved), tomorrow=Pull, then Legs."""
    print("[overlay] User scenario: Push+Cardio today → regen")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    after = _overlay(fams, "push")
    assert_eq(after[0], "push", "today=Push (preserved)")
    assert_eq(after[1], "pull", "tomorrow=Pull (next in PPL)")
    assert_eq(after[2], "legs", "day after=Legs")
    print(f"  full plan after overlay: {after}")


def test_user_scenario_7d_no_duplicate_push_cardio():
    """7-day plan after Push+Cardio today should NOT have duplicate
    Push+Cardio on day 0 and day 3 (the original bug report)."""
    print("[overlay] User scenario 7d: no Push-skip-Push")
    fams = _gen("muscle_gain", 7, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    after = _overlay(fams, "push")
    # Check that the cycle is Push→Pull→Legs repeating
    for i in range(len(after)):
        if after[i] in ("push", "pull", "legs"):
            for j in range(i+1, len(after)):
                if after[j] in ("push", "pull", "legs"):
                    assert_ne(after[i], after[j],
                              f"no adjacent same-family at {i},{j} (intervening non-lift ok)")
                    break


# ===================================================================
# Bro split with completed today
# ===================================================================

def test_bro_5d_push_today():
    """Bro split: Push (chest) done today. Day 0 should match."""
    print("[overlay] Bro 5d: Push (chest) completed today")
    fams = _gen("muscle_gain", 5, "bro",
                families=("push",),
                buckets=("upper_body",),
                completed_today="push")
    after = _overlay(fams, "push")
    assert_ne(after[1], "push", "day1 not push again")


# ===================================================================
# Edge cases
# ===================================================================

def test_cold_start_with_completed_today():
    """First ever workout completed today. No prior history."""
    print("[overlay] Cold start: first workout completed today")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push",),
                buckets=("upper_body",),
                completed_today="push")
    assert_eq(fams[0], "push", "day0=push")
    after = _overlay(fams, "push")
    assert_eq(after[1], "pull", "day1=pull")


def test_cardio_only_history_with_lift_today():
    """History was all cardio, but today user did Push. Anchor to push."""
    print("[overlay] Cardio history + Push today")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push", "cardio", "cardio"),
                buckets=("upper_body", "cardio", "cardio"),
                completed_today="push")
    assert_eq(fams[0], "push", "day0=push")
    after = _overlay(fams, "push")
    assert_eq(after[1], "pull", "day1=pull")


cases = [
    # PPL completed today
    test_ppl_5d_push_today,
    test_ppl_6d_push_today,
    test_ppl_7d_push_today,
    test_ppl_5d_pull_today,
    test_ppl_5d_legs_today,
    # U/L completed today
    test_ul_4d_upper_today,
    test_ul_4d_lower_today,
    test_ul_6d_upper_today,
    # +Cardio normalization
    test_plus_cardio_normalization,
    test_plus_cardio_bucket_normalization,
    # +Cardio in history
    test_ppl_push_cardio_label_in_history,
    test_ul_upper_cardio_label_in_history,
    # Different goals
    test_fat_loss_ppl_push_today,
    test_strength_ul_upper_today,
    test_body_recomp_ul_upper_today,
    # Single-day path unchanged
    test_no_completed_today_still_advances,
    # User-reported scenarios
    test_user_scenario_push_cardio_today_pull_yesterday_rest_legs,
    test_user_scenario_7d_no_duplicate_push_cardio,
    # Bro
    test_bro_5d_push_today,
    # Edge cases
    test_cold_start_with_completed_today,
    test_cardio_only_history_with_lift_today,
]


def run_all():
    passed = failed = 0
    for fn in cases:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  ✗ {fn.__name__}: {e}")
    total = passed + failed
    print(f"\n{'='*60}")
    print(f"completed-today overlay: {passed}/{total} passed", end="")
    if failed:
        print(f" ({failed} FAILED)")
    else:
        print(" ✅")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(run_all())
