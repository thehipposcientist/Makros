"""Integration tests for split-cycle preservation through generate_weekly_recipe.

Unlike the unit tests in test_split_preservation.py (which test anchor /
rotation / decide_pin individually), these call the FULL recipe pipeline:
    anchor → avoid-recent → fatigue rotation → repair → identity guards

Tests cover:
  - Same split, continue cycle from history (PPL, UL, Bro)
  - Same split, interleaved cardio/rest/mobility days
  - Different split in history → fallback to avoid-recent / fatigue
  - Fatigue rotation fires for non-PPL splits
  - Switch-day on a real generated recipe (end-to-end)
  - 7-day plans with recovery days

Run manually:
    docker exec -it thallo-backend python -m tests.test_split_cycle_integration
"""
from __future__ import annotations


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_ne(actual, forbidden, label):
    assert actual != forbidden, f"{label}: got {actual!r}, expected anything but {forbidden!r}"
    print(f"  ✓ {label}")


def assert_in(actual, expected_set, label):
    assert actual in expected_set, f"{label}: got {actual!r}, expected one of {expected_set!r}"
    print(f"  ✓ {label}")


def _gen(goal, days, split, families=(), buckets=(), fatigue=None,
         user_chose_split=False, user_age=None):
    """Call generate_weekly_recipe and return list of focus families."""
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.archetypes import archetype_to_focus_family
    profile = goal_profile_for(goal)
    recipe = generate_weekly_recipe(
        profile, days,
        lifting_split=split,
        recent_focus_families=families,
        recent_focus_buckets=buckets,
        muscle_fatigue=fatigue,
        user_chose_split=user_chose_split,
        user_age=user_age,
    )
    return [archetype_to_focus_family(a) for a in recipe]


# ===================================================================
# PPL — same split, continue cycle from history
# ===================================================================

def test_ppl_continue_cycle_after_legs():
    """History (legs, push, pull, legs) has 3 unique PPL entries.
    last_two={legs, push}, missing={pull} → day0 = Pull."""
    print("[integration] PPL: continue cycle after Legs")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("legs", "push", "pull", "legs"),
                buckets=("lower_body", "upper_body", "upper_body", "lower_body"))
    assert_eq(fams[0], "pull", "day0=pull after (legs,push,pull,legs) history-based")


def test_ppl_continue_cycle_after_push():
    """Only Push is known recently → tie-break to Pull."""
    print("[integration] PPL: continue cycle after Push")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push",), buckets=("upper_body",))
    assert_eq(fams[0], "pull", "day0=pull after push")


def test_ppl_continue_cycle_after_pull():
    """History ends with Pull → single-entry canonical fallback:
    pull→legs. Day0 = Legs."""
    print("[integration] PPL: continue cycle after Pull")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("pull",), buckets=("upper_body",))
    assert_eq(fams[0], "legs", "day0=legs after pull (canonical fallback)")


def test_ppl_3day_cycle_integrity():
    """3-day PPL plan should have exactly one of each family."""
    print("[integration] PPL 3-day: one push, one pull, one legs")
    fams = _gen("muscle_gain", 3, "ppl",
                families=("legs",), buckets=("lower_body",))
    assert_eq(sorted(fams), ["legs", "pull", "push"], "all three families present")


def test_ppl_5day_cycle_wraps():
    """5-day PPL: cycle wraps. Should have ~2 of one family, ~2 of another, 1."""
    print("[integration] PPL 5-day: families wrap correctly")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("legs",), buckets=("lower_body",))
    lift_fams = [f for f in fams if f in ("push", "pull", "legs")]
    assert len(lift_fams) >= 3, f"at least 3 lift days in 5-day plan, got {len(lift_fams)}"
    print(f"  ✓ {len(lift_fams)} lift days in 5-day plan")


# ===================================================================
# PPL — interleaved cardio/rest/mobility in history
# ===================================================================

def test_ppl_cardio_between_lifts():
    """History: Pull, Cardio (newest first). Anchor skips cardio,
    sees Pull → day0 = Legs."""
    print("[integration] PPL: cardio between lifts in history")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("cardio", "pull", "push"),
                buckets=("cardio", "upper_body", "upper_body"))
    assert_eq(fams[0], "legs", "day0=legs (cardio skipped, pull→legs)")


def test_ppl_recovery_between_lifts():
    """History: Recovery, Push (newest first). Anchor skips recovery,
    sees Push → day0 = Pull."""
    print("[integration] PPL: recovery between lifts in history")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("recovery", "push"),
                buckets=("recovery", "upper_body"))
    assert_eq(fams[0], "pull", "day0=pull (recovery skipped, push→pull)")


def test_ppl_mobility_between_lifts():
    """History: Mobility, Legs (newest first). Anchor skips mobility,
    sees Legs → day0 = Push."""
    print("[integration] PPL: mobility between lifts in history")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("mobility", "legs"),
                buckets=("mobility", "lower_body"))
    assert_eq(fams[0], "push", "day0=push (mobility skipped, legs→push)")


def test_ppl_multiple_cardio_rest_days():
    """History: Cardio, Rest-skip, Cardio, Pull (newest first).
    Anchor digs through all the non-lift days to find Pull.
    Single PPL entry → tie-break after Pull starts Legs."""
    print("[integration] PPL: multiple non-lift days in history")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("cardio", "cardio", "pull"),
                buckets=("cardio", "cardio", "upper_body"))
    assert_eq(fams[0], "legs", "day0=legs (tie-break after pull)")


def test_ppl_starts_with_absent_or_oldest_family():
    """Strict PPL should start with the most-open family, not fixed Push.
    If recent history is Push/Pull-heavy and Legs is absent, day0 should
    be Legs, then the other PPL families follow."""
    print("[integration] PPL: absent Legs starts the next block")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push", "pull", "push", "pull"),
                buckets=("upper_body", "upper_body", "upper_body", "upper_body"))
    lift_fams = [f for f in fams if f in ("push", "pull", "legs")]
    assert_eq(lift_fams[:3], ["legs", "pull", "push"], "open-order block starts Legs")


def test_ppl_masters_recovery_does_not_stack_legs():
    """Age-adjusted recovery may reduce a 5-day PPL week to 4 lifts.
    The strict split rebuild must preserve PPL counts without placing
    Legs next to Legs."""
    print("[integration] PPL: masters recovery does not stack Legs")
    fams = _gen("muscle_gain", 5, "ppl", user_chose_split=True, user_age=55)
    for i in range(1, len(fams)):
        if fams[i] not in ("push", "pull", "legs"):
            continue
        if fams[i - 1] not in ("push", "pull", "legs"):
            continue
        assert_ne(fams[i], fams[i - 1], f"no adjacent PPL duplicate at {i-1},{i}")


# ===================================================================
# U/L — same split, continue alternation from history
# ===================================================================

def test_ul_continue_after_upper():
    """After Upper → day0 = Lower."""
    print("[integration] U/L: continue after Upper")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("upper",), buckets=("upper_body",))
    assert_eq(fams[0], "lower", "day0=lower after upper")


def test_ul_continue_after_lower():
    """After Lower → day0 = Upper."""
    print("[integration] U/L: continue after Lower")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("lower",), buckets=("lower_body",))
    assert_eq(fams[0], "upper", "day0=upper after lower")


def test_ul_strict_alternation():
    """4-day U/L should strictly alternate U/L/U/L or L/U/L/U."""
    print("[integration] U/L 4-day: strict alternation")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("upper",), buckets=("upper_body",))
    lift_fams = [f for f in fams if f in ("upper", "lower")]
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i + 1],
                  f"no adjacent same-family at positions {i},{i+1}")


def test_ul_cardio_interleaved():
    """History: Cardio, Lower (newest first). Anchor skips cardio → day0=Upper."""
    print("[integration] U/L: cardio between lifts in history")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("cardio", "lower"),
                buckets=("cardio", "lower_body"))
    assert_eq(fams[0], "upper", "day0=upper (cardio skipped, lower→upper)")


# ===================================================================
# U/L — fatigue rotation (fires for non-PPL splits)
# ===================================================================

def test_ul_fatigue_rotation_prefers_fresh():
    """U/L with destroyed quads but fresh chest/back. After Lower,
    anchor says Upper. Fatigue agrees (upper is fresh). No conflict."""
    print("[integration] U/L: fatigue rotation agrees with anchor")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("lower",), buckets=("lower_body",),
                fatigue={"quads": 0.9, "hamstrings": 0.8, "glutes": 0.7,
                         "chest": 0.1, "back": 0.1, "shoulders": 0.1,
                         "biceps": 0.1, "triceps": 0.1})
    assert_eq(fams[0], "upper", "fatigue agrees: upper is freshest")


def test_ul_fatigue_contradicts_anchor():
    """U/L: After Lower, anchor says Upper. But upper muscles are destroyed
    and lower is fresh. Fatigue rotation would want Lower again. But anchor
    already set Upper. Since fatigue rotation skips PPL, and for U/L it runs
    AFTER anchor with identity guard — verify the guard catches any scramble."""
    print("[integration] U/L: fatigue contradicts anchor")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("lower",), buckets=("lower_body",),
                fatigue={"chest": 0.9, "back": 0.9, "shoulders": 0.9,
                         "biceps": 0.9, "triceps": 0.9,
                         "quads": 0.1, "hamstrings": 0.1, "glutes": 0.1})
    # Even with upper muscles destroyed, the plan should still alternate U/L
    lift_fams = [f for f in fams if f in ("upper", "lower")]
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i + 1],
                  f"alternation preserved at {i},{i+1} despite fatigue")


# ===================================================================
# BRO — avoid-recent + fatigue rotation
# ===================================================================

def test_bro_avoids_recent_chest():
    """Bro after Chest (push family). Day0 should not be push-family."""
    print("[integration] Bro: avoids recent chest")
    fams = _gen("muscle_gain", 5, "bro",
                families=("push",), buckets=("upper_body",))
    assert_ne(fams[0], "push", "day0 not push after chest")


def test_bro_avoids_recent_back_and_legs():
    """Bro after Back+Legs. Day0 should not be pull or legs."""
    print("[integration] Bro: avoids recent back+legs")
    fams = _gen("muscle_gain", 5, "bro",
                families=("legs", "pull"),
                buckets=("lower_body", "upper_body"))
    assert_ne(fams[0], "legs", "day0 not legs")
    assert_ne(fams[0], "pull", "day0 not pull")


def test_bro_fatigue_rotation_fires():
    """Bro with destroyed chest. Fatigue rotation should avoid push on day0."""
    print("[integration] Bro: fatigue rotation avoids destroyed muscles")
    fams = _gen("muscle_gain", 5, "bro",
                families=(), buckets=(),
                fatigue={"chest": 0.9, "triceps": 0.8, "shoulders": 0.7,
                         "quads": 0.1, "back": 0.1})
    assert_ne(fams[0], "push", "day0 not push (chest destroyed)")


# ===================================================================
# SPLIT SWITCH — different split in history vs current
# ===================================================================

def test_ul_history_to_ppl_regen():
    """Was on U/L (upper, lower, upper). Switch to PPL.
    Anchor can't map → avoid-recent fires. Day0 should not be upper_body."""
    print("[integration] Split switch: U/L history → PPL regen")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("upper", "lower", "upper"),
                buckets=("upper_body", "lower_body", "upper_body"))
    # anchor returns None for upper→PPL, avoid-recent avoids upper_body
    # PPL families: push and pull are both upper_body bucket
    # With fine families, "upper" and "lower" are not PPL families,
    # so day0 should just be the default recipe start
    assert_in(fams[0], ("push", "pull", "legs"), "day0 is a valid PPL family")


def test_ppl_history_to_ul_regen():
    """Was on PPL (push, pull, legs). Switch to U/L.
    Anchor can't map → avoid-recent fires. Should produce valid U/L."""
    print("[integration] Split switch: PPL history → U/L regen")
    fams = _gen("muscle_gain", 4, "upper_lower",
                families=("push", "pull", "legs"),
                buckets=("upper_body", "upper_body", "lower_body"))
    lift_fams = [f for f in fams if f in ("upper", "lower")]
    # Should be valid U/L alternation
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i + 1],
                  f"U/L alternation preserved at {i},{i+1}")


def test_bro_history_to_ppl_regen():
    """Was on Bro (push/chest). Switch to PPL.
    Anchor can see push → PPL next = pull. Works!"""
    print("[integration] Split switch: Bro history → PPL regen")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("push",), buckets=("upper_body",))
    assert_eq(fams[0], "pull", "day0=pull (bro push maps to PPL pull)")


def test_full_body_to_ppl_regen():
    """Was on Full Body. Switch to PPL.
    Anchor sees full_body but _next_in_split_rotation returns None for it.
    Falls through to avoid-recent."""
    print("[integration] Split switch: Full Body → PPL regen")
    fams = _gen("muscle_gain", 5, "ppl",
                families=("full_body",), buckets=("full_body",))
    # full_body returns None from anchor → recipe unchanged or rotated
    assert_in(fams[0], ("push", "pull", "legs"), "day0 is valid PPL")


# ===================================================================
# 7-DAY PLANS — recovery day placement
# ===================================================================

def test_ppl_7day_has_recovery():
    """7-day PPL should include at least one non-lift day."""
    print("[integration] PPL 7-day: includes recovery/non-lift")
    fams = _gen("muscle_gain", 7, "ppl",
                families=("legs",), buckets=("lower_body",))
    non_lift = [f for f in fams if f not in ("push", "pull", "legs")]
    assert len(non_lift) >= 1, f"expected ≥1 non-lift day, got {non_lift}"
    print(f"  ✓ {len(non_lift)} non-lift day(s): {non_lift}")


def test_ul_7day_has_recovery():
    """7-day U/L should include non-lift days."""
    print("[integration] U/L 7-day: includes recovery/non-lift")
    fams = _gen("muscle_gain", 7, "upper_lower",
                families=("upper",), buckets=("upper_body",))
    non_lift = [f for f in fams if f not in ("upper", "lower")]
    assert len(non_lift) >= 1, f"expected ≥1 non-lift day, got {non_lift}"
    print(f"  ✓ {len(non_lift)} non-lift day(s): {non_lift}")


# ===================================================================
# SWITCH-DAY ON REAL GENERATED RECIPE (end-to-end)
# ===================================================================

def test_e2e_ppl_generate_then_switch():
    """Generate a PPL recipe, then switch day 0 via decide_pin.
    With prefer_swap, only the pinned day changes."""
    print("[integration] E2E: generate PPL → switch day 0")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.archetypes import archetype_to_focus_family
    from app.services.workout.switch_day import decide_pin, apply_swap

    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 5, lifting_split="ppl",
        recent_focus_families=("legs",), recent_focus_buckets=("lower_body",),
    )
    fams_before = [archetype_to_focus_family(a) for a in recipe]
    assert_eq(fams_before[0], "push", "generated day0=push")

    # Build days dicts from real recipe
    days = [{"focus": archetype_to_focus_family(a).title(), "exercises": []}
            for a in recipe]

    # Switch day 0 to Pull
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "swap", "prefer_swap gives swap")
    apply_swap(days, d)
    assert_eq(days[0]["focus"], "Pull", "day0 switched to Pull")
    # All other non-swapped days should remain the same
    unchanged_count = sum(1 for i in range(1, len(days))
                         if i != d.swap_with_idx and days[i]["focus"] == fams_before[i].title())
    assert_eq(unchanged_count, len(days) - 2, "all other days unchanged")


def test_e2e_ul_generate_then_switch():
    """Generate a U/L recipe, then switch day 0 from Lower to Upper."""
    print("[integration] E2E: generate U/L → switch day 0")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.archetypes import archetype_to_focus_family
    from app.services.workout.switch_day import decide_pin, apply_swap

    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 4, lifting_split="upper_lower",
        recent_focus_families=("upper",), recent_focus_buckets=("upper_body",),
    )
    fams_before = [archetype_to_focus_family(a) for a in recipe]
    assert_eq(fams_before[0], "lower", "generated day0=lower")

    days = [{"focus": archetype_to_focus_family(a).title(), "exercises": []}
            for a in recipe]

    # Switch day 0 to Upper
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper",
                   preferred_split="upper_lower", prefer_swap=True)
    assert_eq(d.action, "swap", "prefer_swap gives swap")
    apply_swap(days, d)
    assert_eq(days[0]["focus"], "Upper", "day0 switched to Upper")


def test_e2e_ppl_generate_then_switch_to_recovery():
    """Generate PPL, switch day 2 to Recovery."""
    print("[integration] E2E: generate PPL → switch to Recovery")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.archetypes import archetype_to_focus_family
    from app.services.workout.switch_day import decide_pin

    profile = goal_profile_for("muscle_gain")
    recipe = generate_weekly_recipe(
        profile, 5, lifting_split="ppl",
        recent_focus_families=("legs",), recent_focus_buckets=("lower_body",),
    )
    days = [{"focus": archetype_to_focus_family(a).title(), "exercises": []}
            for a in recipe]

    d = decide_pin(days, pin_day_index=2, pin_focus="Recovery",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "replace_day", "Recovery → replace_day")
    assert_eq(d.day_kind, "recovery", "day kind is recovery")


# ===================================================================
# NO HISTORY — cold start
# ===================================================================

def test_ppl_cold_start():
    """No completion history. Recipe should be valid PPL with no crashes."""
    print("[integration] PPL cold start: no history")
    fams = _gen("muscle_gain", 5, "ppl", families=(), buckets=())
    lift_fams = [f for f in fams if f in ("push", "pull", "legs")]
    assert len(lift_fams) >= 3, f"at least 3 lift days: {lift_fams}"
    print(f"  ✓ {len(lift_fams)} lift days, valid PPL")


def test_ul_cold_start():
    """No history. Recipe should alternate U/L."""
    print("[integration] U/L cold start: no history")
    fams = _gen("muscle_gain", 4, "upper_lower", families=(), buckets=())
    lift_fams = [f for f in fams if f in ("upper", "lower")]
    for i in range(len(lift_fams) - 1):
        assert_ne(lift_fams[i], lift_fams[i + 1],
                  f"alternation at {i},{i+1}")


def test_bro_cold_start():
    """No history. 5-day bro should have all 5 bro families."""
    print("[integration] Bro cold start: no history")
    fams = _gen("muscle_gain", 5, "bro", families=(), buckets=())
    # Bro families map to: push, pull, push, upper, legs
    assert len(fams) == 5, f"5 days: {fams}"
    print(f"  ✓ 5 days generated: {fams}")


# ===================================================================
# DIFFERENT GOALS
# ===================================================================

def test_fat_loss_ppl_continues_cycle():
    """Fat loss uses lifting_plus_cardio mode. PPL anchor should still work."""
    print("[integration] Fat loss PPL: continues cycle")
    fams = _gen("fat_loss", 5, "ppl",
                families=("legs",), buckets=("lower_body",))
    # fat_loss mode may include cardio days, but the first lift should be push
    lift_fams = [f for f in fams if f in ("push", "pull", "legs")]
    if lift_fams:
        assert_eq(lift_fams[0], "push", "first lift=push after legs")


def test_strength_ppl_continues_cycle():
    """Strength mode PPL. With only ('legs',) in history,
    canonical fallback: legs→push."""
    print("[integration] Strength PPL: continues cycle")
    fams = _gen("strength", 5, "ppl",
                families=("legs",), buckets=("lower_body",))
    lift_fams = [f for f in fams if f in ("push", "pull", "legs")]
    if lift_fams:
        assert_eq(lift_fams[0], "push", "first lift=push after legs (canonical fallback)")


def test_general_health_ul_continues():
    """General health with U/L split. Maintain mode."""
    print("[integration] General health U/L: continues alternation")
    fams = _gen("general_health", 4, "upper_lower",
                families=("upper",), buckets=("upper_body",))
    lift_fams = [f for f in fams if f in ("upper", "lower")]
    if len(lift_fams) >= 2:
        assert_eq(lift_fams[0], "lower", "first lift=lower after upper")


# ===================================================================
# runner
# ===================================================================

cases = [
    # PPL same-split cycle
    test_ppl_continue_cycle_after_legs,
    test_ppl_continue_cycle_after_push,
    test_ppl_continue_cycle_after_pull,
    test_ppl_3day_cycle_integrity,
    test_ppl_5day_cycle_wraps,
    # PPL interleaved non-lift
    test_ppl_cardio_between_lifts,
    test_ppl_recovery_between_lifts,
    test_ppl_mobility_between_lifts,
    test_ppl_multiple_cardio_rest_days,
    test_ppl_starts_with_absent_or_oldest_family,
    test_ppl_masters_recovery_does_not_stack_legs,
    # U/L same-split
    test_ul_continue_after_upper,
    test_ul_continue_after_lower,
    test_ul_strict_alternation,
    test_ul_cardio_interleaved,
    # U/L fatigue
    test_ul_fatigue_rotation_prefers_fresh,
    test_ul_fatigue_contradicts_anchor,
    # Bro
    test_bro_avoids_recent_chest,
    test_bro_avoids_recent_back_and_legs,
    test_bro_fatigue_rotation_fires,
    # Split switch
    test_ul_history_to_ppl_regen,
    test_ppl_history_to_ul_regen,
    test_bro_history_to_ppl_regen,
    test_full_body_to_ppl_regen,
    # 7-day
    test_ppl_7day_has_recovery,
    test_ul_7day_has_recovery,
    # E2E: generate → switch
    test_e2e_ppl_generate_then_switch,
    test_e2e_ul_generate_then_switch,
    test_e2e_ppl_generate_then_switch_to_recovery,
    # Cold start
    test_ppl_cold_start,
    test_ul_cold_start,
    test_bro_cold_start,
    # Different goals
    test_fat_loss_ppl_continues_cycle,
    test_strength_ppl_continues_cycle,
    test_general_health_ul_continues,
]


def run_all():
    passed = 0
    failed = 0
    for fn in cases:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  ✗ {fn.__name__}: {e}")
    total = passed + failed
    print(f"\n{'='*60}")
    print(f"split cycle integration: {passed}/{total} passed", end="")
    if failed:
        print(f" ({failed} FAILED)")
    else:
        print(" ✅")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(run_all())
