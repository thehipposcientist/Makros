"""Comprehensive split-preservation tests across all splits.

Tests the full rotation pipeline (anchor + avoid-recent + decide_pin)
with realistic completion histories for PPL, U/L, Bro, Full Body,
and PPL+UL splits. Covers regen, switch-day, and single-day generation
scenarios.

Run manually:
    docker exec -it thallo-backend python -m tests.test_split_preservation
"""
from __future__ import annotations


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def assert_in(actual, expected_set, label):
    assert actual in expected_set, f"{label}: got {actual!r}, expected one of {expected_set!r}"
    print(f"  ✓ {label}")


def assert_ne(actual, forbidden, label):
    assert actual != forbidden, f"{label}: got {actual!r}, expected anything but {forbidden!r}"
    print(f"  ✓ {label}")


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _make_days(focuses: list[str]) -> list[dict]:
    return [{"focus": f, "exercises": []} for f in focuses]


def _anchor(recipe, families, split):
    from app.services.workout.weekly_recipe import _anchor_recipe_to_split_next
    return _anchor_recipe_to_split_next(recipe, families, split)


def _avoid_recent(recipe, recent, mode="lifting"):
    from app.services.workout.weekly_recipe import _rotate_recipe_to_avoid_recent
    return _rotate_recipe_to_avoid_recent(recipe, recent, mode=mode)


def _family(archetype):
    from app.services.workout.archetypes import archetype_to_focus_family
    return archetype_to_focus_family(archetype)


def _families(archetypes):
    return [_family(a) for a in archetypes]


# ===================================================================
# PPL SPLIT — history-based rotation (least recently done family)
# ===================================================================

def test_ppl_regen_after_legs_wed_pull_thu_push_sat_legs_sun():
    """Real scenario: Legs Wed, Pull Thu, Rest Fri, Push Sat, Legs Sun.
    Regen on Monday. History-based rotation: recent_ppl=
    [legs,push,pull,legs], last_two={legs,push} → next=pull."""
    print("[test] PPL regen: Legs-Pull-Push-Legs history → day0=Pull (history-based)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    families = ("legs", "push", "pull", "legs")  # newest first
    result = _anchor(recipe, families, "ppl")
    assert_eq(_family(result[0]), "pull", "day0")
    assert_eq(_family(result[1]), "push", "day1")
    assert_eq(_family(result[2]), "legs", "day2")


def test_ppl_regen_after_push_only():
    """Just did Push. Single-entry canonical fallback: push→pull."""
    print("[test] PPL regen: Push history → day0=Pull (canonical)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _anchor(recipe, ("push",), "ppl")
    assert_eq(_family(result[0]), "pull", "day0=pull after push")


def test_ppl_regen_after_pull_only():
    """Just did Pull. Next should be Legs."""
    print("[test] PPL regen: Pull history → day0=Legs")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _anchor(recipe, ("pull",), "ppl")
    assert_eq(_family(result[0]), "legs", "day0=legs after pull")


def test_ppl_regen_no_history():
    """No completion history. Anchor returns recipe unchanged."""
    print("[test] PPL regen: no history → recipe unchanged")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _anchor(recipe, (), "ppl")
    assert_eq(_families(result), ["push", "pull", "legs"], "unchanged order")


def test_ppl_regen_after_cardio_only():
    """Only recent completion was cardio. No lift family → no anchor."""
    print("[test] PPL regen: cardio-only history → no anchor shift")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _anchor(recipe, ("cardio",), "ppl")
    # cardio is not a lift family, so anchor returns unchanged
    assert_eq(_families(result), ["push", "pull", "legs"], "no shift for cardio")


def test_ppl_switch_day_prefer_swap():
    """PPL plan [Push, Pull, Legs, Push, Pull]. Switch day 0 to Legs.
    With prefer_swap, should just swap days 0 and 2."""
    print("[test] PPL switch: prefer_swap swaps only pinned day")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs", "Push", "Pull"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "swap", "action")
    apply_swap(days, d)
    focuses = [x["focus"] for x in days]
    assert_eq(focuses[0], "Legs", "day0 pinned")
    assert_eq(focuses[1], "Pull", "day1 untouched")
    assert_eq(focuses[2], "Push", "day2 swapped")
    assert_eq(focuses[3], "Push", "day3 untouched")
    assert_eq(focuses[4], "Pull", "day4 untouched")


def test_ppl_switch_day_canonical_rebuild():
    """Without prefer_swap (fresh regen path), canonical rebuild
    reorders the entire lift sequence."""
    print("[test] PPL switch: canonical rebuild reorders full cycle")
    from app.services.workout.switch_day import decide_pin, apply_rotate

    days = _make_days(["Push", "Pull", "Legs"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs",
                   preferred_split="ppl", prefer_swap=False)
    assert_eq(d.action, "rotate", "action")
    apply_rotate(days, d)
    focuses = [x["focus"] for x in days]
    assert_eq(focuses, ["Legs", "Push", "Pull"], "canonical cycle from Legs")


def test_ppl_5day_switch_middle():
    """5-day PPL [Push, Pull, Legs, Push, Pull]. Pin Legs at day 3.
    With prefer_swap, swaps day 3 (Push) with day 2 (Legs)."""
    print("[test] PPL 5-day: pin Legs at middle position")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs", "Push", "Pull"])
    d = decide_pin(days, pin_day_index=3, pin_focus="Legs",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "swap", "action")
    apply_swap(days, d)
    focuses = [x["focus"] for x in days]
    assert_eq(focuses[3], "Legs", "day3 pinned")
    assert_eq(focuses[2], "Push", "day2 received Push from day3")


def test_ppl_heavy_variant_history():
    """History has heavy variants. Anchor should still recognize the
    lift family from the variant name. Single entry ('legs') →
    canonical fallback: legs→push."""
    print("[test] PPL regen: heavy variant history → still anchors correctly (canonical)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH_HEAVY, A.LIFT_PULL_HEAVY, A.LIFT_LEGS_HEAVY]
    result = _anchor(recipe, ("legs",), "ppl")
    assert_eq(_family(result[0]), "push", "after legs heavy → day0=push")


# ===================================================================
# U/L SPLIT — Upper ↔ Lower strict alternation
# ===================================================================

def test_ul_regen_after_upper():
    """Just did Upper. Next should be Lower."""
    print("[test] U/L regen: Upper history → day0=Lower")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER, A.LIFT_UPPER, A.LIFT_LOWER]
    result = _anchor(recipe, ("upper",), "upper_lower")
    assert_eq(_family(result[0]), "lower", "day0=lower after upper")
    assert_eq(_family(result[1]), "upper", "day1=upper")


def test_ul_regen_after_lower():
    """Just did Lower. Next should be Upper."""
    print("[test] U/L regen: Lower history → day0=Upper")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER, A.LIFT_UPPER, A.LIFT_LOWER]
    result = _anchor(recipe, ("lower",), "upper_lower")
    assert_eq(_family(result[0]), "upper", "day0=upper after lower")


def test_ul_regen_after_upper_lower_upper():
    """History: Upper, Lower, Upper (newest first). Last lift=Upper → next=Lower."""
    print("[test] U/L regen: U-L-U history → day0=Lower")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER, A.LIFT_UPPER, A.LIFT_LOWER]
    result = _anchor(recipe, ("upper", "lower", "upper"), "upper_lower")
    assert_eq(_family(result[0]), "lower", "day0=lower")


def test_ul_switch_day_prefer_swap():
    """U/L plan [Upper, Lower, Upper, Lower]. Pin Lower at 0.
    Prefer swap: just swap days 0 and 1."""
    print("[test] U/L switch: prefer_swap → minimal swap")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Upper", "Lower", "Upper", "Lower"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower",
                   preferred_split="upper_lower", prefer_swap=True)
    assert_eq(d.action, "swap", "action")
    apply_swap(days, d)
    focuses = [x["focus"] for x in days]
    assert_eq(focuses, ["Lower", "Upper", "Upper", "Lower"], "only days 0,1 swapped")


def test_ul_switch_day_canonical():
    """Without prefer_swap, canonical rebuild for U/L."""
    print("[test] U/L switch: canonical rebuild")
    from app.services.workout.switch_day import decide_pin, apply_rotate

    days = _make_days(["Upper", "Lower", "Upper", "Lower"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower",
                   preferred_split="upper_lower", prefer_swap=False)
    assert_eq(d.action, "rotate", "action")
    apply_rotate(days, d)
    focuses = [x["focus"] for x in days]
    assert_eq(focuses[0], "Lower", "day0 pinned to Lower")
    assert_eq(focuses[1], "Upper", "day1 alternates")


def test_ul_heavy_variant_anchor():
    """Heavy U/L variants should still anchor correctly."""
    print("[test] U/L regen: heavy variant history")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER_HEAVY, A.LIFT_LOWER_HEAVY,
              A.LIFT_UPPER_HYPERTROPHY, A.LIFT_LOWER_HYPERTROPHY]
    result = _anchor(recipe, ("lower",), "upper_lower")
    assert_eq(_family(result[0]), "upper", "after lower → day0=upper")


def test_ul_regen_after_lower_with_cardio_between():
    """History: Lower, Cardio, Upper (newest first). Cardio is skipped
    for anchor — last LIFT family is Lower → next=Upper."""
    print("[test] U/L regen: Lower-Cardio-Upper history → day0=Upper (skip cardio)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER]
    # newest first: the function finds the first in lift_families
    result = _anchor(recipe, ("lower", "cardio", "upper"), "upper_lower")
    assert_eq(_family(result[0]), "upper", "day0=upper (skip cardio in history)")


# ===================================================================
# BRO SPLIT — no split-aware anchor, uses avoid-recent rotation
# ===================================================================

def test_bro_no_anchor():
    """Bro split has no canonical rotation in _next_in_split_rotation.
    Anchor should return recipe unchanged."""
    print("[test] Bro: no split-aware anchor")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_BRO_CHEST, A.LIFT_BRO_BACK, A.LIFT_BRO_SHOULDERS,
              A.LIFT_BRO_ARMS, A.LIFT_BRO_LEGS]
    result = _anchor(recipe, ("push",), "bro")
    # bro is not in PPL/UL rotation, so returns unchanged
    assert_eq(_families(result), _families(recipe), "recipe unchanged")


def test_bro_avoid_recent_chest():
    """Just did Chest (family=push). Avoid-recent should rotate so
    day 0 is NOT push-family."""
    print("[test] Bro: avoid-recent after Chest")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_BRO_CHEST, A.LIFT_BRO_BACK, A.LIFT_BRO_SHOULDERS,
              A.LIFT_BRO_ARMS, A.LIFT_BRO_LEGS]
    result = _avoid_recent(recipe, ["push"])
    day0_fam = _family(result[0])
    assert_ne(day0_fam, "push", "day0 should NOT be push-family after chest")


def test_bro_avoid_recent_back_and_legs():
    """Just did Back (pull) then Legs. Avoid both on day 0."""
    print("[test] Bro: avoid-recent after Back+Legs")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_BRO_CHEST, A.LIFT_BRO_BACK, A.LIFT_BRO_SHOULDERS,
              A.LIFT_BRO_ARMS, A.LIFT_BRO_LEGS]
    result = _avoid_recent(recipe, ["legs", "pull"])
    day0_fam = _family(result[0])
    assert_ne(day0_fam, "legs", "day0 not legs")
    assert_ne(day0_fam, "pull", "day0 not pull")


def test_bro_switch_day_prefer_swap():
    """Bro plan. Pin Arms at day 0 with prefer_swap."""
    print("[test] Bro switch: prefer_swap")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Chest", "Back", "Shoulders", "Arms", "Legs"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Arms",
                   preferred_split="bro", prefer_swap=True)
    assert_eq(d.action, "swap", "action is swap")
    apply_swap(days, d)
    assert_eq(days[0]["focus"], "Arms", "day0 pinned to Arms")
    assert_eq(days[3]["focus"], "Chest", "original Chest moved to day3")


def test_bro_switch_day_canonical():
    """Bro without prefer_swap uses canonical cycle rebuild."""
    print("[test] Bro switch: canonical rebuild")
    from app.services.workout.switch_day import decide_pin, apply_rotate

    days = _make_days(["Chest", "Back", "Shoulders", "Arms", "Legs"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Arms",
                   preferred_split="bro", prefer_swap=False)
    assert_eq(d.action, "rotate", "action is rotate")
    apply_rotate(days, d)
    assert_eq(days[0]["focus"], "Arms", "day0 = Arms")
    # Canonical bro: Arms → Legs → Chest → Back → Shoulders
    assert_eq(days[1]["focus"], "Legs", "day1 follows canonical cycle")


# ===================================================================
# FULL BODY — no rotation needed, all days same family
# ===================================================================

def test_full_body_no_anchor():
    """Full body has no split rotation — anchor returns unchanged."""
    print("[test] Full Body: no anchor shift")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_FULL_BODY, A.LIFT_FULL_BODY, A.LIFT_FULL_BODY]
    result = _anchor(recipe, ("full_body",), "full_body")
    assert_eq(_families(result), ["full_body"] * 3, "unchanged")


def test_full_body_switch_day_noop():
    """Pin Full Body on Full Body plan → noop (already matches)."""
    print("[test] Full Body switch: noop")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Full Body", "Full Body", "Full Body"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body",
                   preferred_split="full_body", prefer_swap=True)
    assert_eq(d.action, "noop", "full body on full body = noop")


def test_full_body_switch_to_recovery():
    """Pin Recovery on Full Body plan → replace_day."""
    print("[test] Full Body switch: pin Recovery → replace")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Full Body", "Full Body", "Full Body"])
    d = decide_pin(days, pin_day_index=1, pin_focus="Recovery",
                   preferred_split="full_body", prefer_swap=True)
    assert_eq(d.action, "replace_day", "recovery replaces day")


# ===================================================================
# PPL + UL HYBRID — uses PPL rotation cycle
# ===================================================================

def test_ppl_ul_regen_after_legs():
    """PPL+UL hybrid: single entry ('legs') → canonical fallback:
    legs→push."""
    print("[test] PPL+UL regen: after Legs → day0=Push (canonical)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS, A.LIFT_UPPER, A.LIFT_LOWER]
    result = _anchor(recipe, ("legs",), "ppl_upper_lower")
    assert_eq(_family(result[0]), "push", "day0=push after legs")


def test_ppl_ul_regen_after_push():
    """PPL+UL hybrid: single entry ('push') → canonical fallback:
    push→pull."""
    print("[test] PPL+UL regen: after Push → day0=Pull (canonical)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS, A.LIFT_UPPER, A.LIFT_LOWER]
    result = _anchor(recipe, ("push",), "ppl_upper_lower")
    assert_eq(_family(result[0]), "pull", "day0=pull after push")


# ===================================================================
# MIXED HISTORY — completions + skipped days + recovery
# ===================================================================

def test_ppl_skipped_day_in_history():
    """History includes a skipped day. Skipped Pull should still count
    for rotation — next after Pull = Legs."""
    print("[test] PPL: skipped day counts for rotation")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    # Simulates: completed Push, then Pull was skipped (still in families)
    families = ("pull", "push")
    result = _anchor(recipe, families, "ppl")
    assert_eq(_family(result[0]), "legs", "day0=legs (pull was skipped but counts)")


def test_ppl_recovery_day_in_history():
    """History includes recovery/mobility. These are skipped by anchor
    since they're not lift families. History-based rotation:
    recent_ppl=[push,pull], last_two={push,pull} → next=legs."""
    print("[test] PPL: recovery in history skipped by anchor (history-based)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    # Recovery, then Push, then Pull (newest first)
    families = ("recovery", "push", "pull")
    result = _anchor(recipe, families, "ppl")
    # recovery is skipped, recent_ppl=[push,pull], last_two={push,pull}
    # remaining={legs} → next=legs
    assert_eq(_family(result[0]), "legs", "day0=legs (recovery skipped, history-based)")


def test_ul_mobility_in_history():
    """Mobility day between lifts. Anchor should skip it."""
    print("[test] U/L: mobility in history skipped by anchor")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER]
    # mobility, lower, upper (newest first)
    families = ("mobility", "lower", "upper")
    result = _anchor(recipe, families, "upper_lower")
    # mobility skipped, first lift = lower → next = upper
    assert_eq(_family(result[0]), "upper", "day0=upper (mobility skipped)")


# ===================================================================
# SWITCH DAY WITH RECOVERY/NON-LIFT DAYS IN PLAN
# ===================================================================

def test_ppl_switch_with_recovery_days():
    """PPL 5-day: [Push, Pull, Legs, Recovery, Push]. Pin Legs at 4.
    Prefer swap: swap with day 2 (Legs)."""
    print("[test] PPL switch with recovery days in plan")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs", "Recovery", "Push"])
    d = decide_pin(days, pin_day_index=4, pin_focus="Legs",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "swap", "action")
    apply_swap(days, d)
    assert_eq(days[4]["focus"], "Legs", "day4 pinned")
    assert_eq(days[2]["focus"], "Push", "day2 got Push from day4")
    assert_eq(days[3]["focus"], "Recovery", "recovery untouched")


def test_ul_switch_with_cardio_days():
    """U/L 5-day: [Upper, Lower, Cardio, Upper, Lower]. Pin Lower at 0.
    Swap with day 1."""
    print("[test] U/L switch with cardio day in plan")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Upper", "Lower", "Cardio", "Upper", "Lower"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower",
                   preferred_split="upper_lower", prefer_swap=True)
    assert_eq(d.action, "swap", "action")
    apply_swap(days, d)
    assert_eq(days[0]["focus"], "Lower", "day0 pinned")
    assert_eq(days[1]["focus"], "Upper", "day1 swapped")
    assert_eq(days[2]["focus"], "Cardio", "cardio untouched")


# ===================================================================
# SINGLE-DAY GENERATION — prev_focuses merging
# ===================================================================

def test_prev_focuses_prepend_does_not_corrupt_anchor():
    """prev_focuses prepend is INTENTIONAL (different from pin injection).
    It represents planned days earlier in the week. The anchor should
    use the first LIFT family in the merged list."""
    print("[test] prev_focuses: merged history anchors correctly")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    # Simulates: day 0-2 are Push, Pull, Legs (client sent prev_focuses).
    # Now generating day 3. Merged families (newest first from reversed prev):
    # ["legs", "pull", "push"] + actual_history
    # Last lift family = legs → next = push
    merged = ("legs", "pull", "push")
    result = _anchor(recipe, merged, "ppl")
    assert_eq(_family(result[0]), "push", "after prev_focuses [P,Pu,L] → day3=push")


def test_prev_focuses_with_completion_history():
    """prev_focuses + real history. Newest prev_focus should take priority
    for anchor if it's more recent than the completion."""
    print("[test] prev_focuses: takes priority over older completions")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    # prev_focuses (newest first): pull, push
    # completion history (newest first): legs
    # merged: ("pull", "push", "legs")
    merged = ("pull", "push", "legs")
    result = _anchor(recipe, merged, "ppl")
    assert_eq(_family(result[0]), "legs", "after prev Pull → day=Legs")


# ===================================================================
# 7TH DAY GENERATION — day_index=6 edge case
# ===================================================================

def test_ppl_7day_plan_all_days_covered():
    """A 7-day PPL plan should cycle Push→Pull→Legs twice + recovery.
    The 7th day (index 6) should be reachable."""
    print("[test] PPL 7-day: all indices valid for switch")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Push", "Pull", "Legs", "Push", "Pull", "Legs", "Recovery"])
    valid_actions = ("noop", "swap", "replace_day", "bro_canonical_swap", "rotate")
    # Pin at every position should not crash
    for i in range(7):
        d = decide_pin(days, pin_day_index=i, pin_focus="Push",
                       preferred_split="ppl", prefer_swap=True)
        assert d.action in valid_actions, \
            f"day {i} gave unexpected action {d.action}"
    print("  ✓ all 7 positions handled")


def test_ul_6day_plan_switch_last_day():
    """6-day U/L plan. Switch the last day (index 5)."""
    print("[test] U/L 6-day: switch last day")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Upper", "Lower", "Upper", "Lower", "Upper", "Lower"])
    d = decide_pin(days, pin_day_index=5, pin_focus="Upper",
                   preferred_split="upper_lower", prefer_swap=True)
    assert_eq(d.action, "swap", "action")
    apply_swap(days, d)
    assert_eq(days[5]["focus"], "Upper", "day5 pinned to Upper")


def test_bro_7day_plan_switch_recovery():
    """7-day bro: 5 lifts + 1 cardio + 1 recovery. Pin Push at recovery."""
    print("[test] Bro 7-day: pin lift on recovery day")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Chest", "Back", "Shoulders", "Arms", "Legs", "Cardio", "Recovery"])
    d = decide_pin(days, pin_day_index=6, pin_focus="Chest",
                   preferred_split="bro", prefer_swap=True)
    # Target is non-lifting, matching lift exists → swap
    assert_in(d.action, ("swap", "bro_canonical_swap"), "swap or bro swap")


# ===================================================================
# AVOID-RECENT ROTATION — all splits
# ===================================================================

def test_avoid_recent_ppl_respects_families():
    """PPL with fine families. Day 0 should avoid the most recent."""
    print("[test] avoid-recent PPL: fine families")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _avoid_recent(recipe, ["push"])
    assert_ne(_family(result[0]), "push", "day0 avoids push")


def test_avoid_recent_ul_coarse_buckets():
    """U/L with coarse buckets (upper_body/lower_body)."""
    print("[test] avoid-recent U/L: coarse buckets")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER, A.LIFT_UPPER, A.LIFT_LOWER]
    result = _avoid_recent(recipe, ["upper_body"])
    # Upper maps to upper_body bucket, so day 0 should avoid it
    day0_fam = _family(result[0])
    assert_eq(day0_fam, "lower", "day0=lower (avoids upper_body)")


def test_avoid_recent_multiple_recent():
    """Multiple recent completions. Tier 1 tries to avoid ALL."""
    print("[test] avoid-recent: tier 1 avoids all recent")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _avoid_recent(recipe, ["push", "pull"])
    assert_eq(_family(result[0]), "legs", "day0=legs (avoids push AND pull)")


def test_avoid_recent_all_recent_falls_to_tier2():
    """All families are recent. Tier 2 avoids only most recent."""
    print("[test] avoid-recent: tier 2 fallback")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH, A.LIFT_PULL, A.LIFT_LEGS]
    result = _avoid_recent(recipe, ["push", "pull", "legs"])
    # Most recent is push (index 0). Day 0 should not be push.
    assert_ne(_family(result[0]), "push", "day0 avoids most-recent push")


def test_avoid_recent_skips_endurance_mode():
    """Endurance mode has anchored placement — rotation skipped."""
    print("[test] avoid-recent: endurance mode → no rotation")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.COND_ZONE2, A.COND_INTERVALS_SHORT, A.LIFT_PUSH]
    result = _avoid_recent(recipe, ["cardio"], mode="endurance")
    assert_eq(result, recipe, "endurance mode unchanged")


# ===================================================================
# CROSS-SPLIT SWITCH — pin focus from wrong split
# ===================================================================

def test_ul_switch_to_push_triggers_regen():
    """Pin Push on a U/L plan. Push isn't in U/L → regen with PPL split."""
    print("[test] U/L switch: pin Push → regen with ppl")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Upper", "Lower", "Upper", "Lower"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Push",
                   preferred_split="upper_lower", prefer_swap=True)
    assert_eq(d.action, "regen", "triggers regen")
    assert_eq(d.regen_split, "ppl", "regen with ppl split")


def test_ppl_switch_to_upper_triggers_regen():
    """Pin Upper on a PPL plan. Upper isn't in PPL → regen with U/L split."""
    print("[test] PPL switch: pin Upper → regen with upper_lower")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Push", "Pull", "Legs"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "regen", "triggers regen")
    assert_eq(d.regen_split, "upper_lower", "regen with upper_lower split")


# ===================================================================
# REALISTIC MULTI-DAY SCENARIOS
# ===================================================================

def test_ul_wife_scenario_upper_mon_lower_tue_skip_wed_upper_thu():
    """U/L scenario: Upper Mon, Lower Tue, Skip Wed, Upper Thu.
    Friday regen should show Lower (alternation continues)."""
    print("[test] U/L: U-L-skip-U → regen Fri=Lower")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER, A.LIFT_LOWER]
    # newest first: Upper Thu, Lower Tue, Upper Mon
    families = ("upper", "lower", "upper")
    result = _anchor(recipe, families, "upper_lower")
    assert_eq(_family(result[0]), "lower", "Friday=Lower after Upper Thu")


def test_ul_switch_fri_to_upper():
    """Plan shows [Lower, Upper, ...] for Fri/Sat. User switches Fri to Upper.
    With prefer_swap, Sat becomes Lower."""
    print("[test] U/L switch: Fri Lower→Upper, Sat stays Lower")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Lower", "Upper", "Lower", "Upper"])
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper",
                   preferred_split="upper_lower", prefer_swap=True)
    assert_eq(d.action, "swap", "swap")
    apply_swap(days, d)
    assert_eq(days[0]["focus"], "Upper", "day0=Upper pinned")
    assert_eq(days[1]["focus"], "Lower", "day1=Lower swapped")


def test_ppl_legs_mon_push_tue_switch_tue_to_pull():
    """PPL plan: [Legs, Push, Pull, Legs, Push]. User completed Legs on
    Sunday. Monday = Legs (from plan). Switch Tuesday from Push to Pull.
    Wednesday should stay Pull (not shift to Legs)."""
    print("[test] PPL: switch Tue Push→Pull, Wed stays Pull")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Legs", "Push", "Pull", "Legs", "Push"])
    d = decide_pin(days, pin_day_index=1, pin_focus="Pull",
                   preferred_split="ppl", prefer_swap=True)
    assert_eq(d.action, "swap", "swap")
    apply_swap(days, d)
    assert_eq(days[1]["focus"], "Pull", "Tue=Pull pinned")
    assert_eq(days[2]["focus"], "Push", "Wed=Push swapped from Tue")
    assert_eq(days[3]["focus"], "Legs", "Thu unchanged")


def test_bro_chest_mon_back_tue_switch_tue_to_legs():
    """Bro plan: [Chest, Back, Shoulders, Arms, Legs]. Switch Tue (Back)
    to Legs. With prefer_swap, just swap days 1 and 4."""
    print("[test] Bro: switch Tue Back→Legs")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Chest", "Back", "Shoulders", "Arms", "Legs"])
    d = decide_pin(days, pin_day_index=1, pin_focus="Legs",
                   preferred_split="bro", prefer_swap=True)
    assert_eq(d.action, "swap", "swap")
    apply_swap(days, d)
    assert_eq(days[1]["focus"], "Legs", "Tue=Legs pinned")
    assert_eq(days[4]["focus"], "Back", "original Legs slot gets Back")
    assert_eq(days[0]["focus"], "Chest", "Mon unchanged")
    assert_eq(days[2]["focus"], "Shoulders", "Wed unchanged")


# ===================================================================
# PLUS-CARDIO VARIANT HANDLING
# ===================================================================

def test_ppl_plus_cardio_anchor():
    """Plus-cardio variants should anchor the same as base variants.
    Single entry ('legs') → canonical fallback: legs→push."""
    print("[test] PPL: plus-cardio variants anchor correctly (canonical)")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_PUSH_PLUS_CARDIO, A.LIFT_PULL_PLUS_CARDIO, A.LIFT_LEGS]
    result = _anchor(recipe, ("legs",), "ppl")
    assert_eq(_family(result[0]), "push", "push+cardio follows legs in PPL (canonical)")


def test_ul_plus_cardio_anchor():
    """U/L plus-cardio variant anchors correctly."""
    print("[test] U/L: plus-cardio variant anchor")
    from app.services.workout.archetypes import DayArchetype as A

    recipe = [A.LIFT_UPPER_PLUS_CARDIO, A.LIFT_LOWER]
    result = _anchor(recipe, ("lower",), "upper_lower")
    assert_eq(_family(result[0]), "upper", "upper+cardio follows lower")


# ===================================================================
# runner
# ===================================================================

ALL_TESTS = [
    # PPL
    test_ppl_regen_after_legs_wed_pull_thu_push_sat_legs_sun,
    test_ppl_regen_after_push_only,
    test_ppl_regen_after_pull_only,
    test_ppl_regen_no_history,
    test_ppl_regen_after_cardio_only,
    test_ppl_switch_day_prefer_swap,
    test_ppl_switch_day_canonical_rebuild,
    test_ppl_5day_switch_middle,
    test_ppl_heavy_variant_history,
    # U/L
    test_ul_regen_after_upper,
    test_ul_regen_after_lower,
    test_ul_regen_after_upper_lower_upper,
    test_ul_switch_day_prefer_swap,
    test_ul_switch_day_canonical,
    test_ul_heavy_variant_anchor,
    test_ul_regen_after_lower_with_cardio_between,
    # Bro
    test_bro_no_anchor,
    test_bro_avoid_recent_chest,
    test_bro_avoid_recent_back_and_legs,
    test_bro_switch_day_prefer_swap,
    test_bro_switch_day_canonical,
    # Full Body
    test_full_body_no_anchor,
    test_full_body_switch_day_noop,
    test_full_body_switch_to_recovery,
    # PPL + UL
    test_ppl_ul_regen_after_legs,
    test_ppl_ul_regen_after_push,
    # Mixed history
    test_ppl_skipped_day_in_history,
    test_ppl_recovery_day_in_history,
    test_ul_mobility_in_history,
    # Switch with non-lift days
    test_ppl_switch_with_recovery_days,
    test_ul_switch_with_cardio_days,
    # prev_focuses (single-day gen)
    test_prev_focuses_prepend_does_not_corrupt_anchor,
    test_prev_focuses_with_completion_history,
    # 7th day / edge positions
    test_ppl_7day_plan_all_days_covered,
    test_ul_6day_plan_switch_last_day,
    test_bro_7day_plan_switch_recovery,
    # Avoid-recent rotation
    test_avoid_recent_ppl_respects_families,
    test_avoid_recent_ul_coarse_buckets,
    test_avoid_recent_multiple_recent,
    test_avoid_recent_all_recent_falls_to_tier2,
    test_avoid_recent_skips_endurance_mode,
    # Cross-split
    test_ul_switch_to_push_triggers_regen,
    test_ppl_switch_to_upper_triggers_regen,
    # Realistic multi-day
    test_ul_wife_scenario_upper_mon_lower_tue_skip_wed_upper_thu,
    test_ul_switch_fri_to_upper,
    test_ppl_legs_mon_push_tue_switch_tue_to_pull,
    test_bro_chest_mon_back_tue_switch_tue_to_legs,
    # Plus-cardio variants
    test_ppl_plus_cardio_anchor,
    test_ul_plus_cardio_anchor,
]


def run_all():
    passed = 0
    failed = 0
    for fn in ALL_TESTS:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  ✗ {fn.__name__}: {e}")
    total = passed + failed
    print(f"\n{'='*60}")
    print(f"split preservation: {passed}/{total} passed", end="")
    if failed:
        print(f" ({failed} FAILED)")
    else:
        print(" ✅")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(run_all())
