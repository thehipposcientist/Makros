"""Switch Day pin/swap tests — single-day swap model.

Switch Day's contract (per user, Apr 2026):
  - Pin day X to focus Y.
  - If day X already matches Y (or close enough): noop.
  - Otherwise: swap day X with the closest lift day matching Y.
    EVERY OTHER DAY IS BYTE-IDENTICAL TO THE ORIGINAL.
  - If Y isn't in the recipe at all: regen with the split that
    natively contains Y, then graft the matching day in.
  - If Y is Recovery / Mobility / Cardio: replace day X with a fresh
    generated day of that kind.

This is INTENTIONALLY a single-day operation, not a whole-week
rotation. Successive pins can break split balance — that's the user's
explicit choice; the next full regen restores balance.

This file tests the pure helper. Integration tests against real
recipes live in `test_switch_day_integration.py`.
"""
from __future__ import annotations

from app.services.workout.switch_day import (
    decide_pin, apply_swap,
    SPLIT_FOR_FOCUS, NON_LIFTING_FOCUSES,
)


def _days(*focuses: str) -> list[dict]:
    return [{"focus": f, "_orig_idx": i} for i, f in enumerate(focuses)]


def _focuses(days: list[dict]) -> list[str]:
    return [d.get("focus") for d in days]


def _orig_idxs(days: list[dict]) -> list[int]:
    return [d.get("_orig_idx") for d in days]


# ── Replace-day actions (Recovery / Mobility / Cardio) ──────────────

def test_pin_recovery_returns_replace_day_recovery():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=1, pin_focus="Recovery")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"
    assert d.target_idx == 1


def test_pin_active_recovery_normalizes_to_recovery():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Active Recovery")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"


def test_pin_mobility_returns_replace_day_mobility():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=2, pin_focus="Mobility")
    assert d.action == "replace_day"
    assert d.day_kind == "mobility"


def test_pin_cardio_returns_replace_day_cardio():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=1, pin_focus="Cardio")
    assert d.action == "replace_day"
    assert d.day_kind == "cardio"


# ── Noop when target already matches ────────────────────────────────

def test_pin_to_current_focus_is_noop_day_zero():
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push")
    assert d.action == "noop"


def test_pin_to_current_focus_with_duplicate_picks_self_not_other():
    """Pinning day 3 → Push when day 3 is already Push must be no-op,
    not 'rotate the whole week to bring src=0 to dst=3'."""
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=3, pin_focus="Push")
    assert d.action == "noop"


# ── Single-day swap: target gets focus, only ONE other day moves ────

def test_pin_swaps_only_target_and_one_other_day():
    """Pinning day 2 → Push on a PPL recipe should produce a swap
    decision, not a rotate. Only days[2] and the swap partner change."""
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=2, pin_focus="Push")
    assert d.action == "swap"
    # Closest Push to dst=2 is at lift_idx 3 (distance 1) over lift_idx 0 (distance 2)
    assert d.src_lift_idx == 3
    assert d.swap_with_idx == 3  # original day index of that Push


def test_apply_swap_changes_only_target_and_partner():
    """The most important contract: swap leaves all OTHER days
    byte-identical to the original."""
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    original_orig_idxs = _orig_idxs(days)
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs")
    apply_swap(days, d)
    new_orig_idxs = _orig_idxs(days)
    # Find positions that changed.
    changed = [i for i in range(len(days)) if new_orig_idxs[i] != original_orig_idxs[i]]
    # Exactly two positions should have changed (the swap pair).
    assert len(changed) == 2, \
        f"swap should change exactly 2 positions, changed: {changed}"
    # Target is one of them.
    assert d.target_idx in changed
    # Swap partner is the other.
    assert d.swap_with_idx in changed
    # Day 0 is now the original Legs day's content.
    assert _focuses(days)[0] == "Legs"


def test_swap_picks_closest_for_lifting_target():
    """Multiple matching days → pick the closest one in lift sequence
    (minimizes day-of-week movement of the user's other days)."""
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=2, pin_focus="Push")
    # Push at lift_idx 0 (day 0) and 3 (day 3); dst_lift=2; closer is 3.
    assert d.swap_with_idx == 3


# ── Non-lifting target (rest day) ───────────────────────────────────

def test_pin_non_lifting_target_returns_swap():
    """User's reported bug — pin a Recovery day to a lifting focus."""
    days = _days("Recovery", "Recovery", "Push", "Pull", "Legs", "Push", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs")
    assert d.action == "swap"
    assert d.target_idx == 0
    assert d.swap_with_idx in (4, 6)


def test_swap_picks_closest_legs_for_non_lifting_target():
    days = _days("Recovery", "Recovery", "Push", "Pull", "Legs", "Push", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs")
    # Legs at day 4 (distance 4) vs day 6 (distance 6); closer is 4.
    assert d.swap_with_idx == 4


def test_apply_swap_puts_focus_at_target_and_rest_moves():
    days = _days("Recovery", "Recovery", "Push", "Pull", "Legs", "Push", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs")
    apply_swap(days, d)
    assert _focuses(days)[0] == "Legs"
    assert _focuses(days)[4] == "Recovery"


# ── Cardio finisher pin (symmetric base-focus fallback) ─────────────

def test_pin_plus_cardio_when_recipe_has_plain_focus_falls_back():
    """User picks 'Push + Cardio'. Recipe has plain 'Push'.
    Base-focus fallback finds it; wants_cardio_finisher is set so
    caller can append the finisher."""
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=2, pin_focus="Push + Cardio")
    assert d.wants_cardio_finisher is True
    assert d.action == "swap"
    # Closest plain "Push" to dst=2 is lift_idx 3 (day 3).
    assert d.swap_with_idx == 3


def test_pin_plain_focus_matches_plus_cardio_via_base_fallback():
    """User picks plain 'Push'. Recipe only has 'Push + Cardio'.
    Symmetric base-focus fallback should still match."""
    days = _days("Push + Cardio", "Pull", "Legs", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=2, pin_focus="Push")
    assert d.action == "swap", \
        f"plain Push should match 'Push + Cardio' via base fallback, got {d.action}"
    assert d.swap_with_idx == 0


def test_pin_exact_plus_cardio_matches_when_present():
    days = _days("Push + Cardio", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=4, pin_focus="Push + Cardio")
    assert d.action == "swap"
    assert d.swap_with_idx == 0  # the Push + Cardio at day 0


# ── Out-of-split forced regen ───────────────────────────────────────

def test_pin_push_on_upper_lower_plan_returns_regen():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Push", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_pin_chest_on_ppl_plan_returns_regen_to_bro():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="ppl")
    assert d.action == "regen"
    assert d.regen_split == "bro"


def test_pin_focus_already_in_split_does_not_regen():
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=2, pin_focus="Pull", preferred_split="ppl")
    assert d.action != "regen"


# ── Bro split single-day swap behavior ─────────────────────────────

def test_pin_bro_chest_to_day_2_swaps_only_two_days():
    """Bro: [Chest, Back, Shoulders, Arms, Legs]. Pin day 2 → Chest.
    Swap day 2 (Shoulders) with day 0 (Chest). Only days 0 and 2
    change; days 1, 3, 4 stay."""
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    original_orig_idxs = _orig_idxs(days)
    d = decide_pin(days, pin_day_index=2, pin_focus="Chest", preferred_split="bro")
    assert d.action == "swap"
    apply_swap(days, d)
    new_orig_idxs = _orig_idxs(days)
    changed = [i for i in range(len(days)) if new_orig_idxs[i] != original_orig_idxs[i]]
    assert len(changed) == 2
    assert _focuses(days)[2] == "Chest"
    # Days 1, 3, 4 unchanged.
    assert _focuses(days)[1] == "Back"
    assert _focuses(days)[3] == "Arms"
    assert _focuses(days)[4] == "Legs"


def test_pin_bro_chest_already_at_day_zero_is_noop():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="bro")
    assert d.action == "noop"


# ── Out-of-bounds clamp ────────────────────────────────────────────

def test_pin_day_index_clamped_above():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=99, pin_focus="Push")
    assert d.target_idx == 2


def test_pin_day_index_clamped_below():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=-5, pin_focus="Push")
    assert d.target_idx == 0


# ── SPLIT_FOR_FOCUS table ──────────────────────────────────────────

def test_split_for_focus_covers_all_canonical_focuses():
    expected = {"push", "pull", "legs", "upper", "lower",
                "full body", "full_body",
                "chest", "back", "shoulders", "arms"}
    assert expected.issubset(set(SPLIT_FOR_FOCUS))


# ── Determinism ────────────────────────────────────────────────────

def test_decide_pin_is_deterministic():
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d1 = decide_pin(days, pin_day_index=2, pin_focus="Push")
    d2 = decide_pin(days, pin_day_index=2, pin_focus="Push")
    assert d1.action == d2.action
    assert d1.swap_with_idx == d2.swap_with_idx


# ── User-reported regression: muscle_gain 6d PPL pin scenarios ─────

def test_user_scenario_pin_pull_cardio_to_push_cardio_only_two_days_change():
    """User's reported bug. Recipe like the planner produces for
    muscle_gain 6d PPL (1 promoted PUSH+Cardio, 1 PULL_HEAVY first):
    [Push (heavy), Rest, Pull + Cardio, Legs, Push, Pull, Legs].
    Pin day 2 (Pull + Cardio) to Push + Cardio.
    Expected: day 2 = Push + Cardio (or Push, with finisher attached
    by router); only one OTHER day changes (the swap partner)."""
    days = _days(
        "Push (Heavy)", "Recovery", "Pull + Cardio",
        "Legs", "Push", "Pull", "Legs",
    )
    original_orig_idxs = _orig_idxs(days)
    d = decide_pin(days, pin_day_index=2, pin_focus="Push + Cardio",
                    preferred_split="ppl")
    assert d.action in ("swap", "noop"), \
        f"expected swap, got {d.action} — user's bug returning"
    if d.action == "swap":
        apply_swap(days, d)
        new_orig_idxs = _orig_idxs(days)
        changed = [i for i in range(len(days)) if new_orig_idxs[i] != original_orig_idxs[i]]
        # Exactly 2 days change — target + swap partner.
        assert len(changed) == 2, \
            f"expected exactly 2 days to change, got {len(changed)}: positions {changed}"
        assert d.target_idx in changed
        # Day 0 (Push (Heavy)) must NOT have changed — user-reported
        # bug was that day 0 became Legs after this pin.
        assert new_orig_idxs[0] == 0, \
            "day 0 changed — this is the user-reported bug returning"


def test_user_scenario_pin_pull_cardio_to_legs_only_two_days_change():
    """Same scenario, different pin: day 2 (Pull + Cardio) → Legs."""
    days = _days(
        "Push (Heavy)", "Recovery", "Pull + Cardio",
        "Legs", "Push", "Pull", "Legs",
    )
    original_orig_idxs = _orig_idxs(days)
    d = decide_pin(days, pin_day_index=2, pin_focus="Legs", preferred_split="ppl")
    assert d.action == "swap"
    apply_swap(days, d)
    new_orig_idxs = _orig_idxs(days)
    changed = [i for i in range(len(days)) if new_orig_idxs[i] != original_orig_idxs[i]]
    assert len(changed) == 2
    # Day 2 should now be a Legs day.
    assert "legs" in (_focuses(days)[2] or "").lower()
    # Day 0 unchanged.
    assert new_orig_idxs[0] == 0, "day 0 changed — Switch Day must not touch it"


def test_user_scenario_pin_day_5_pull_to_push_only_two_days_change():
    """Same recipe, pin day 5 (Pull) → Push. Day 0 and other untouched
    days must stay byte-identical."""
    days = _days(
        "Push (Heavy)", "Recovery", "Pull + Cardio",
        "Legs", "Push", "Pull", "Legs",
    )
    original_orig_idxs = _orig_idxs(days)
    d = decide_pin(days, pin_day_index=5, pin_focus="Push", preferred_split="ppl")
    assert d.action == "swap"
    apply_swap(days, d)
    new_orig_idxs = _orig_idxs(days)
    changed = [i for i in range(len(days)) if new_orig_idxs[i] != original_orig_idxs[i]]
    assert len(changed) == 2
    assert d.target_idx == 5 and 5 in changed
    # All non-changed positions are byte-identical to original.
    for i in range(len(days)):
        if i not in changed:
            assert new_orig_idxs[i] == original_orig_idxs[i], \
                f"day {i} should not have moved, but did"


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} switch_day tests passed")
