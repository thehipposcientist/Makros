"""User-scenario regression tests.

Each test encodes a REAL user-reported bug as an end-to-end scenario:
  1. Set up history (completions, skipped days, rest days)
  2. Call the generation endpoint (regen, switch-day, or single-day)
  3. Simulate client behavior (overlay completed day, map to calendar)
  4. Assert the user sees the correct plan

When a user reports "I did X and saw Y", add a test here.
The test name should reference the date or ticket so we can trace it.

Run:
    docker exec thallo-backend python -m tests.test_user_scenario_regression
"""
from __future__ import annotations


def _gen(goal, days, split, families, buckets, completed_today=None, fatigue=None):
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.archetypes import archetype_to_focus_family
    profile = goal_profile_for(goal)
    recipe = generate_weekly_recipe(
        profile, days, lifting_split=split,
        recent_focus_families=families,
        recent_focus_buckets=buckets,
        completed_today_family=completed_today,
        muscle_fatigue=fatigue,
    )
    return [archetype_to_focus_family(a) for a in recipe]


def _overlay(fams, today_family):
    """Simulate client: replace day 0 with completed workout."""
    return [today_family] + fams[1:]


def _switch(days_dicts, pin_idx, pin_focus, split, prefer_swap=True):
    """Simulate switch-day on a plan."""
    from app.services.workout.switch_day import decide_pin, apply_swap
    d = decide_pin(days_dicts, pin_day_index=pin_idx, pin_focus=pin_focus,
                   preferred_split=split, prefer_swap=prefer_swap)
    if d.action == "swap":
        apply_swap(days_dicts, d)
    return d, days_dicts


def assert_eq(a, b, label):
    assert a == b, f"{label}: got {a!r}, expected {b!r}"
    print(f"  ✓ {label}")


def assert_ne(a, b, label):
    assert a != b, f"{label}: got {a!r}, should not be {b!r}"
    print(f"  ✓ {label}")


def assert_in(a, s, label):
    assert a in s, f"{label}: got {a!r}, expected one of {s!r}"
    print(f"  ✓ {label}")


# ===================================================================
# 2026-04-26: Wife did Legs Sun, Rest Mon, Pull Tue, Push+Cardio Wed.
# Regen on Wed showed: Push+Cardio(done), Legs, Push+Cardio, ...
# Expected: Push+Cardio(done), Pull, Legs, Push, Pull, ...
# Root cause: anchor advanced day 0 to Pull, client overlaid with Push,
# wasting the Pull slot and shifting the entire cycle.
# ===================================================================

def test_20260426_push_cardio_today_regen_cycle_shift():
    """Push+Cardio done today. Regen must keep PPL cycle after overlay."""
    print("[scenario] 2026-04-26: Push+Cardio today regen cycle shift")
    # History newest-first: push (today), pull (yesterday), legs (3 days ago)
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    after = _overlay(fams, "push")
    assert_eq(after[0], "push", "today=Push (preserved)")
    assert_eq(after[1], "pull", "tomorrow=Pull (PPL cycle)")
    assert_eq(after[2], "legs", "day2=Legs")
    # No back-to-back same family
    for i in range(len(after) - 1):
        if after[i] in ("push", "pull", "legs") and after[i+1] in ("push", "pull", "legs"):
            assert_ne(after[i], after[i+1], f"no adjacent duplicate at {i},{i+1}")


def test_20260426_push_cardio_today_7d_no_missing_pull():
    """7-day PPL after Push+Cardio today. Pull must not disappear."""
    print("[scenario] 2026-04-26: 7-day PPL no missing Pull")
    fams = _gen("muscle_gain", 7, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    after = _overlay(fams, "push")
    pull_count = sum(1 for f in after if f == "pull")
    assert pull_count >= 2, f"7-day PPL should have >=2 Pull days, got {pull_count}: {after}"
    print(f"  ✓ {pull_count} Pull days in 7-day plan")


# ===================================================================
# 2026-04-26 (same session): Switch-day on existing plan. User switched
# Monday Push to Pull. Expected: Tue stays Push. Got: Tue=Legs
# (canonical rebuild reshuffled the whole week instead of minimal swap).
# ===================================================================

def test_20260426_switch_day_prefer_swap():
    """Switch Mon Push→Pull on existing PPL plan. Only 2 days should change."""
    print("[scenario] 2026-04-26: switch-day minimal swap")
    days = [
        {"focus": "Push", "exercises": []},
        {"focus": "Pull", "exercises": []},
        {"focus": "Legs", "exercises": []},
        {"focus": "Push", "exercises": []},
        {"focus": "Pull", "exercises": []},
    ]
    d, result = _switch(days, pin_idx=0, pin_focus="Pull", split="ppl", prefer_swap=True)
    assert_eq(d.action, "swap", "prefer_swap gives swap")
    assert_eq(result[0]["focus"], "Pull", "day0=Pull (pinned)")
    assert_eq(result[1]["focus"], "Push", "day1=Push (swapped)")
    assert_eq(result[2]["focus"], "Legs", "day2=Legs (unchanged)")


def test_20260426_switch_legs_sun_then_pin_pull_mon():
    """Legs Sunday, switch Monday to Pull. Tuesday should NOT be Legs."""
    print("[scenario] 2026-04-26: Legs Sun → switch Mon→Pull → Tue stays Push")
    days = [
        {"focus": "Push", "exercises": []},
        {"focus": "Pull", "exercises": []},
        {"focus": "Legs", "exercises": []},
        {"focus": "Push", "exercises": []},
        {"focus": "Pull", "exercises": []},
    ]
    d, result = _switch(days, pin_idx=0, pin_focus="Pull", split="ppl", prefer_swap=True)
    assert_eq(result[0]["focus"], "Pull", "Monday=Pull (pinned)")
    assert_ne(result[1]["focus"], "Legs", "Tuesday not Legs (she did Legs Sunday)")


# ===================================================================
# 2026-04-26: +Cardio normalization. "Push+Cardio" (no spaces) was
# resolving to family='cardio', breaking history tracking.
# ===================================================================

def test_20260426_plus_cardio_normalization_all_formats():
    """+Cardio labels must resolve to lift family, not 'cardio'."""
    print("[scenario] 2026-04-26: +Cardio normalization")
    from app.services.workout.focus_normalize import normalize_focus_to_family
    broken_formats = [
        ("Push+Cardio", "push"),
        ("push_plus_cardio", "push"),
        ("lift_push_plus_cardio", "push"),
        ("Pull+Cardio", "pull"),
        ("Upper+Cardio", "upper"),
        ("Full Body+Cardio", "full_body"),
    ]
    for label, expected in broken_formats:
        actual = normalize_focus_to_family(label)
        assert_eq(actual, expected, f"{label!r} → {expected!r}")


# ===================================================================
# Scenario: U/L user completes Upper today, regens. Overlay must
# preserve U/L alternation. (Same bug class as PPL cycle shift.)
# ===================================================================

def test_ul_upper_today_regen_alternation():
    """U/L: Upper done today. After overlay, strict alternation must hold."""
    print("[scenario] U/L: Upper today regen alternation")
    fams = _gen("muscle_gain", 6, "upper_lower",
                families=("upper", "lower", "upper"),
                buckets=("upper_body", "lower_body", "upper_body"),
                completed_today="upper")
    after = _overlay(fams, "upper")
    lift_fams = [f for f in after if f in ("upper", "lower")]
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i+1], f"alternation at {i},{i+1}")


def test_ul_lower_today_regen_alternation():
    """U/L: Lower done today. Same test."""
    print("[scenario] U/L: Lower today regen alternation")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("lower", "upper"),
                buckets=("lower_body", "upper_body"),
                completed_today="lower")
    after = _overlay(fams, "lower")
    lift_fams = [f for f in after if f in ("upper", "lower")]
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i+1], f"alternation at {i},{i+1}")


# ===================================================================
# Scenario: PPL user with interleaved cardio/rest in history. The
# anchor must skip non-lift days when determining cycle position.
# ===================================================================

def test_ppl_cardio_rest_interleaved_history():
    """History: Push (today), Cardio, Rest-skip, Pull, Legs.
    Anchor must skip cardio/rest. PPL rotation is history-based:
    PPL-only history = (push, pull, legs), so after push the
    least-recently-done focus is legs."""
    print("[scenario] PPL: cardio+rest interleaved in history")
    fams = _gen("muscle_gain", 6, "ppl",
                families=("push", "cardio", "pull", "legs"),
                buckets=("upper_body", "cardio", "upper_body", "lower_body"),
                completed_today="push")
    after = _overlay(fams, "push")
    assert_eq(after[1], "legs", "day1=Legs (least recently done PPL focus)")


# ===================================================================
# Scenario: User switches to a different split but has old-split
# history. The recipe should still produce valid output.
# ===================================================================

def test_cross_split_ppl_to_ul_with_today():
    """Was on PPL (push today), switch to U/L. Should produce valid U/L."""
    print("[scenario] Cross-split: PPL history → U/L regen with today done")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    # push maps to upper in U/L
    lift_fams = [f for f in fams if f in ("upper", "lower")]
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i+1], f"U/L alternation at {i},{i+1}")


# ===================================================================
# Cold start: first ever workout done today. No prior history.
# Must not crash and must produce valid cycle.
# ===================================================================

def test_cold_start_first_workout_today():
    """First workout ever completed today. Plan should start correctly."""
    print("[scenario] Cold start: first workout today")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push",),
                buckets=("upper_body",),
                completed_today="push")
    after = _overlay(fams, "push")
    assert_eq(after[0], "push", "day0=push")
    assert_eq(after[1], "pull", "day1=pull")
    assert_eq(after[2], "legs", "day2=legs")


# ===================================================================
# Fat loss + PPL: lifting_plus_cardio mode may interleave cardio
# differently. The overlay must still not duplicate today's focus
# immediately.
# ===================================================================

def test_fat_loss_push_today_no_immediate_repeat():
    """Fat loss PPL: Push today → day 1 should NOT be Push again."""
    print("[scenario] Fat loss: Push today no immediate repeat")
    fams = _gen("fat_loss", 5, "ppl",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"),
                completed_today="push")
    after = _overlay(fams, "push")
    assert_ne(after[1], "push", "day1 not Push again")


# ===================================================================
# Strength mode with today completed
# ===================================================================

def test_strength_upper_today():
    """Strength U/L: Upper today. Day 1 must be Lower."""
    print("[scenario] Strength U/L: Upper today")
    fams = _gen("strength", 4, "upper_lower",
                families=("upper", "lower"),
                buckets=("upper_body", "lower_body"),
                completed_today="upper")
    after = _overlay(fams, "upper")
    lift_fams = [f for f in after if f in ("upper", "lower")]
    assert_eq(lift_fams[0], "upper", "today=upper")
    assert_eq(lift_fams[1], "lower", "tomorrow=lower")


cases = [
    # 2026-04-26 bug reports
    test_20260426_push_cardio_today_regen_cycle_shift,
    test_20260426_push_cardio_today_7d_no_missing_pull,
    test_20260426_switch_day_prefer_swap,
    test_20260426_switch_legs_sun_then_pin_pull_mon,
    test_20260426_plus_cardio_normalization_all_formats,
    # Same bug class — other splits
    test_ul_upper_today_regen_alternation,
    test_ul_lower_today_regen_alternation,
    # Interleaved non-lift history
    test_ppl_cardio_rest_interleaved_history,
    # Cross-split
    test_cross_split_ppl_to_ul_with_today,
    # Edge cases
    test_cold_start_first_workout_today,
    test_fat_loss_push_today_no_immediate_repeat,
    test_strength_upper_today,
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
    print(f"\n{'='*60}")
    print(f"user scenario regression: {passed}/{passed+failed} passed", end="")
    if failed:
        print(f" ({failed} FAILED)")
    else:
        print(" ✅")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(run_all())
