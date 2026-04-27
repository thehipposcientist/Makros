"""Pure-function tests for switch-day pin/rotation and split-anchor logic.

Uses history-based rotation: the next PPL family is whichever of
{push, pull, legs} the user did LEAST recently. Given recent history
(most recent first), extract PPL families, take the first two, and the
NEXT is whichever of {push, pull, legs} is NOT in those two. When only
1 entry exists, the missing set has 2 items — pick alphabetically first.

Covers the user-reported scenario: Legs Wed → Pull Thu → Rest Fri →
Push Sat → Legs Sun.  Monday regen should show Pull (history last_two
= {legs, push}, missing = {pull}).  Switching Monday to Pull should NOT
make Tuesday Legs when Legs was just done Sunday — the existing plan
should be minimally swapped, not canonically rebuilt.

Run manually:
    docker exec -it thallo-backend python -m tests.test_switch_day_rotation
"""
from __future__ import annotations


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


# ---------------------------------------------------------------------------
# 1. _next_in_split_rotation
# ---------------------------------------------------------------------------

def test_ppl_rotation():
    """PPL rotation without history: canonical fallback applies.
    push→pull, pull→legs, legs→push."""
    print("[test] PPL rotation cycle (no history, canonical fallback)")
    from app.services.workout.weekly_recipe import _next_in_split_rotation
    from app.services.workout.day_templates import SPLIT_PPL

    # 0 unique PPL entries in history → canonical fallback
    assert_eq(_next_in_split_rotation("push", SPLIT_PPL), "pull", "push → pull (canonical)")
    assert_eq(_next_in_split_rotation("pull", SPLIT_PPL), "legs", "pull → legs (canonical)")
    assert_eq(_next_in_split_rotation("legs", SPLIT_PPL), "push", "legs → push (canonical)")


def test_ul_rotation():
    """U/L strict alternation."""
    print("[test] U/L rotation cycle")
    from app.services.workout.weekly_recipe import _next_in_split_rotation
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER

    assert_eq(_next_in_split_rotation("upper", SPLIT_UPPER_LOWER), "lower", "upper → lower")
    assert_eq(_next_in_split_rotation("lower", SPLIT_UPPER_LOWER), "upper", "lower → upper")


def test_rotation_none_for_non_lift():
    """Non-lift families (cardio/mobility/recovery) return None."""
    print("[test] Non-lift families return None for rotation")
    from app.services.workout.weekly_recipe import _next_in_split_rotation
    from app.services.workout.day_templates import SPLIT_PPL

    assert_eq(_next_in_split_rotation("cardio", SPLIT_PPL), None, "cardio → None")
    assert_eq(_next_in_split_rotation("mobility", SPLIT_PPL), None, "mobility → None")
    assert_eq(_next_in_split_rotation(None, SPLIT_PPL), None, "None → None")


# ---------------------------------------------------------------------------
# 2. _anchor_recipe_to_split_next
# ---------------------------------------------------------------------------

def test_anchor_legs_history_gives_pull_day0():
    """After history (legs, push, pull, legs), the last two PPL families
    are {legs, push}, so the missing family is pull → day 0 = pull."""
    print("[test] Anchor: history=(legs,push,pull,legs) → day0=pull")
    from app.services.workout.weekly_recipe import _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_PPL
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    recipe = [DayArchetype.LIFT_LEGS, DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL]
    families = ("legs", "push", "pull", "legs")
    result = _anchor_recipe_to_split_next(recipe, families, SPLIT_PPL)
    day0_fam = archetype_to_focus_family(result[0])
    assert_eq(day0_fam, "pull", "day 0 family after (legs,push,pull,legs) history")


def test_anchor_push_history_gives_pull_day0():
    """After history (push,), single entry → canonical fallback:
    push→pull. Day 0 = pull."""
    print("[test] Anchor: history=(push,) → day0=pull (canonical)")
    from app.services.workout.weekly_recipe import _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_PPL
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    recipe = [DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS]
    families = ("push",)
    result = _anchor_recipe_to_split_next(recipe, families, SPLIT_PPL)
    day0_fam = archetype_to_focus_family(result[0])
    assert_eq(day0_fam, "pull", "day 0 family after (push,) history")


def test_anchor_no_pin_injection_corruption():
    """Pin injection previously prepended pin_focus into families,
    corrupting the anchor. Verify that with correct families (no pin),
    the anchor picks the right start using history-based rotation."""
    print("[test] Anchor: no pin injection corruption")
    from app.services.workout.weekly_recipe import _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_PPL
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    recipe = [DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS]

    # Correct families from history (no pin prepended): (legs, push, pull, legs)
    # last_two PPL = {legs, push}, missing = {pull} → day0 = pull
    correct_families = ("legs", "push", "pull", "legs")
    result = _anchor_recipe_to_split_next(recipe, correct_families, SPLIT_PPL)
    day0_fam = archetype_to_focus_family(result[0])
    assert_eq(day0_fam, "pull", "correct families → day0=pull")

    # OLD BUG: pin injection prepended "pull" — corrupted to (pull, legs, push, pull, legs)
    # last_two PPL = {pull, legs}, missing = {push} → day0 = push
    corrupted_families = ("pull",) + correct_families
    result_bad = _anchor_recipe_to_split_next(recipe, corrupted_families, SPLIT_PPL)
    bad_day0_fam = archetype_to_focus_family(result_bad[0])
    assert_eq(bad_day0_fam, "push", "corrupted families → day0=push (demonstrating the old bug)")


# ---------------------------------------------------------------------------
# 3. decide_pin — prefer_swap=True (existing plan, minimal change)
# ---------------------------------------------------------------------------

def _make_days(focuses: list[str]) -> list[dict]:
    """Build minimal day dicts for testing."""
    return [{"focus": f, "exercises": []} for f in focuses]


def test_prefer_swap_pull_on_push_slot():
    """Plan [Push, Pull, Legs]. Pin Pull at index 0 with prefer_swap.
    Should swap days 0 and 1 → [Pull, Push, Legs]."""
    print("[test] prefer_swap: pin Pull at Push slot → simple swap")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Pull",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "action is swap, not rotate")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Pull", "Push", "Legs"], "result after swap")


def test_prefer_swap_legs_on_push_slot():
    """Plan [Push, Pull, Legs]. Pin Legs at index 0 with prefer_swap.
    Should swap days 0 and 2 → [Legs, Pull, Push]."""
    print("[test] prefer_swap: pin Legs at Push slot → swap with day 2")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Legs",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "action is swap")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Legs", "Pull", "Push"], "result after swap")


def test_prefer_swap_noop_when_already_matching():
    """Plan [Push, Pull, Legs]. Pin Push at index 0 → noop."""
    print("[test] prefer_swap: pin Push at Push slot → noop")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Push",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "noop", "no-op when already matching")


def test_prefer_swap_with_non_lifting_days():
    """Plan [Push, Recovery, Pull, Legs, Recovery]. Pin Pull at 0.
    Should find Pull at position 2 and swap."""
    print("[test] prefer_swap: pin Pull on plan with recovery days")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Recovery", "Pull", "Legs", "Recovery"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Pull",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "action is swap")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Pull", "Recovery", "Push", "Legs", "Recovery"], "swap with correct day")


def test_prefer_swap_ul_plan():
    """U/L plan [Upper, Lower, Upper, Lower]. Pin Lower at 0.
    Should swap days 0 and 1 → [Lower, Upper, Upper, Lower]."""
    print("[test] prefer_swap: U/L plan pin Lower at day 0")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Upper", "Lower", "Upper", "Lower"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Lower",
        preferred_split="upper_lower",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "action is swap")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Lower", "Upper", "Upper", "Lower"], "swap positions 0 and 1")


# ---------------------------------------------------------------------------
# 4. decide_pin — prefer_swap=False (fresh regen, canonical rebuild)
# ---------------------------------------------------------------------------

def test_canonical_rebuild_ppl():
    """Without prefer_swap, pinning Pull at index 0 on a PPL plan
    should trigger a canonical-cycle rebuild: [Pull, Legs, Push]."""
    print("[test] canonical rebuild: pin Pull at 0 → [Pull, Legs, Push]")
    from app.services.workout.switch_day import decide_pin, apply_rotate

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Pull",
        preferred_split="ppl",
        prefer_swap=False,
    )
    assert_eq(decision.action, "rotate", "action is rotate (canonical rebuild)")
    apply_rotate(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Pull", "Legs", "Push"], "canonical PPL cycle from Pull")


def test_canonical_rebuild_legs_at_0():
    """Pin Legs at index 0 → canonical [Legs, Push, Pull]."""
    print("[test] canonical rebuild: pin Legs at 0 → [Legs, Push, Pull]")
    from app.services.workout.switch_day import decide_pin, apply_rotate

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Legs",
        preferred_split="ppl",
        prefer_swap=False,
    )
    assert_eq(decision.action, "rotate", "action is rotate")
    apply_rotate(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Legs", "Push", "Pull"], "canonical PPL cycle from Legs")


# ---------------------------------------------------------------------------
# 5. User-reported scenario: Legs Sun → regen Mon = Push, switch to Pull
#    → Tuesday should be Push (not Legs)
# ---------------------------------------------------------------------------

def test_user_scenario_legs_sun_switch_to_pull():
    """Wife did Legs Wed, Pull Thu, Rest Fri, Push Sat, Legs Sun.
    Monday regen produces [Push, Pull, Legs, ...].
    Switching Monday to Pull with prefer_swap should give
    [Pull, Push, Legs, ...] — NOT [Pull, Legs, Push, ...]."""
    print("[test] user scenario: Legs Sunday → switch Mon to Pull → Tue stays Push")
    from app.services.workout.switch_day import decide_pin, apply_swap

    # Simulated regen result for a PPL 5-day plan
    days = _make_days(["Push", "Pull", "Legs", "Push", "Pull"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Pull",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "switch-day uses swap")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses[0], "Pull", "Monday = Pull (pinned)")
    assert_eq(focuses[1], "Push", "Tuesday = Push (not Legs!)")
    assert_eq(focuses[2], "Legs", "Wednesday = Legs (preserved)")


def test_user_scenario_regen_after_legs():
    """After history (legs, push, pull, legs), last_two PPL = {legs, push},
    missing = {pull} → day 0 = pull."""
    print("[test] user scenario: regen after Legs → day0 = Pull")
    from app.services.workout.weekly_recipe import (
        _anchor_recipe_to_split_next,
    )
    from app.services.workout.day_templates import SPLIT_PPL
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    recipe = [DayArchetype.LIFT_LEGS, DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL]
    # History: Legs Sun, Push Sat, Pull Thu, Legs Wed (newest first)
    # last_two PPL = {legs, push}, missing = {pull}
    families = ("legs", "push", "pull", "legs")
    result = _anchor_recipe_to_split_next(recipe, families, SPLIT_PPL)
    day0_fam = archetype_to_focus_family(result[0])
    assert_eq(day0_fam, "pull", "regen after (legs,push,pull,legs) → Pull on Monday")


def test_user_scenario_without_prefer_swap_shows_old_bug():
    """Without prefer_swap (old behavior), pinning Pull at 0 on
    [Push, Pull, Legs] produces canonical [Pull, Legs, Push] —
    Tuesday becomes Legs. This test documents the old behavior."""
    print("[test] old behavior (no prefer_swap): canonical rebuild makes Tue=Legs")
    from app.services.workout.switch_day import decide_pin, apply_rotate

    days = _make_days(["Push", "Pull", "Legs", "Push", "Pull"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Pull",
        preferred_split="ppl",
        prefer_swap=False,
    )
    assert_eq(decision.action, "rotate", "old behavior uses canonical rotate")
    apply_rotate(days, decision)
    assert_eq(days[0]["focus"], "Pull", "Monday = Pull")
    assert_eq(days[1]["focus"], "Legs", "Tuesday = Legs (old bug: too close to Sunday)")


# ---------------------------------------------------------------------------
# 6. Edge cases for switch-day
# ---------------------------------------------------------------------------

def test_switch_to_recovery():
    """Pin Recovery on a Push slot → should be replace_day."""
    print("[test] switch lift slot to recovery → replace_day")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Recovery",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "replace_day", "replace with recovery day")
    assert_eq(decision.day_kind, "recovery", "day kind is recovery")


def test_switch_to_mobility():
    """Pin Mobility on a Push slot → should be replace_day."""
    print("[test] switch lift slot to mobility → replace_day")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Mobility",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "replace_day", "replace with mobility day")
    assert_eq(decision.day_kind, "mobility", "day kind is mobility")


def test_switch_with_plus_cardio():
    """Pin 'Pull + Cardio' on Push slot with prefer_swap.
    Should swap (minimal) and flag wants_cardio_finisher."""
    print("[test] prefer_swap with + Cardio suffix")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Pull + Cardio",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "swap even with cardio suffix")
    assert_eq(decision.wants_cardio_finisher, True, "cardio finisher flagged")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses[0], "Pull", "Pull swapped to position 0")


def test_prefer_swap_mid_week_pin():
    """Pin Legs at position 1 (middle) of [Push, Pull, Legs].
    Should swap positions 1 and 2 → [Push, Legs, Pull]."""
    print("[test] prefer_swap: pin at mid-week position")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=1,
        pin_focus="Legs",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "action is swap")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Push", "Legs", "Pull"], "Legs moved to position 1")


def test_prefer_swap_last_position():
    """Pin Push at last position of [Push, Pull, Legs].
    Should swap positions 0 and 2 → [Legs, Pull, Push]."""
    print("[test] prefer_swap: pin at last position")
    from app.services.workout.switch_day import decide_pin, apply_swap

    days = _make_days(["Push", "Pull", "Legs"])
    decision = decide_pin(
        days,
        pin_day_index=2,
        pin_focus="Push",
        preferred_split="ppl",
        prefer_swap=True,
    )
    assert_eq(decision.action, "swap", "action is swap")
    apply_swap(days, decision)
    focuses = [d["focus"] for d in days]
    assert_eq(focuses, ["Legs", "Pull", "Push"], "Push moved to position 2")


# ---------------------------------------------------------------------------
# 7. Full cycle preservation across multiple completions
# ---------------------------------------------------------------------------

def test_ppl_cycle_across_week():
    """Verify that consecutive days follow canonical rotation
    when anchored from a single-entry history.
    Canonical: push→pull, pull→legs, legs→push."""
    print("[test] PPL cycle across a full week from history")
    from app.services.workout.weekly_recipe import _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_PPL
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    recipe = [DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL, DayArchetype.LIFT_LEGS]

    # After Pull: history=(pull,), canonical pull→legs.
    # Day0=legs. augmented=(legs,pull), last_two={legs,pull}, missing={push}.
    # Day1=push. Day2=pull (remaining).
    families_after_pull = ("pull",)
    result = _anchor_recipe_to_split_next(recipe, families_after_pull, SPLIT_PPL)
    fams = [archetype_to_focus_family(a) for a in result]
    assert_eq(fams[0], "legs", "after pull → day0=legs")
    assert_eq(fams[1], "push", "after pull → day1=push")
    assert_eq(fams[2], "pull", "after pull → day2=pull")

    # After Push: history=(push,), canonical push→pull.
    # Day0=pull. augmented=(pull,push), last_two={pull,push}, missing={legs}.
    # Day1=legs. Day2=push (remaining).
    families_after_push = ("push",)
    result = _anchor_recipe_to_split_next(recipe, families_after_push, SPLIT_PPL)
    fams = [archetype_to_focus_family(a) for a in result]
    assert_eq(fams[0], "pull", "after push → day0=pull")
    assert_eq(fams[1], "legs", "after push → day1=legs")
    assert_eq(fams[2], "push", "after push → day2=push")


def test_ul_cycle_across_week():
    """U/L cycle preserves alternation from history."""
    print("[test] U/L cycle across a full week from history")
    from app.services.workout.weekly_recipe import _anchor_recipe_to_split_next
    from app.services.workout.day_templates import SPLIT_UPPER_LOWER
    from app.services.workout.archetypes import DayArchetype, archetype_to_focus_family

    recipe = [DayArchetype.LIFT_UPPER, DayArchetype.LIFT_LOWER]

    # After Upper → next should be Lower
    families_after_upper = ("upper",)
    result = _anchor_recipe_to_split_next(recipe, families_after_upper, SPLIT_UPPER_LOWER)
    fams = [archetype_to_focus_family(a) for a in result]
    assert_eq(fams[0], "lower", "after upper → day0=lower")
    assert_eq(fams[1], "upper", "after upper → day1=upper")


# ---------------------------------------------------------------------------
# 8. prefer_swap with focus not in current plan
# ---------------------------------------------------------------------------

def test_prefer_swap_focus_not_in_plan():
    """Pin a focus that doesn't exist in the current plan. Should
    fall through to regen since swap is impossible."""
    print("[test] prefer_swap: focus not in plan → regen/label_only")
    from app.services.workout.switch_day import decide_pin

    days = _make_days(["Upper", "Lower", "Upper", "Lower"])
    decision = decide_pin(
        days,
        pin_day_index=0,
        pin_focus="Push",
        preferred_split="upper_lower",
        prefer_swap=True,
    )
    # Push doesn't exist in a U/L plan → should regen with PPL split
    assert decision.action in ("regen", "label_only"), \
        f"expected regen or label_only, got {decision.action!r}"
    print(f"  ✓ action is {decision.action} (focus not in plan)")


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------

ALL_TESTS = [
    test_ppl_rotation,
    test_ul_rotation,
    test_rotation_none_for_non_lift,
    test_anchor_legs_history_gives_pull_day0,
    test_anchor_push_history_gives_pull_day0,
    test_anchor_no_pin_injection_corruption,
    test_prefer_swap_pull_on_push_slot,
    test_prefer_swap_legs_on_push_slot,
    test_prefer_swap_noop_when_already_matching,
    test_prefer_swap_with_non_lifting_days,
    test_prefer_swap_ul_plan,
    test_canonical_rebuild_ppl,
    test_canonical_rebuild_legs_at_0,
    test_user_scenario_legs_sun_switch_to_pull,
    test_user_scenario_regen_after_legs,
    test_user_scenario_without_prefer_swap_shows_old_bug,
    test_switch_to_recovery,
    test_switch_to_mobility,
    test_switch_with_plus_cardio,
    test_prefer_swap_mid_week_pin,
    test_prefer_swap_last_position,
    test_ppl_cycle_across_week,
    test_ul_cycle_across_week,
    test_prefer_swap_focus_not_in_plan,
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
    print(f"\n{'='*50}")
    print(f"switch-day rotation: {passed}/{total} passed", end="")
    if failed:
        print(f" ({failed} FAILED)")
    else:
        print(" ✅")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(run_all())
