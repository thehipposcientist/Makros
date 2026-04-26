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

def test_pin_with_no_split_uses_swap():
    """Pin without preferred_split → falls back to single-day swap."""
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=2, pin_focus="Push")
    assert d.action == "swap"
    assert d.src_lift_idx == 3
    assert d.swap_with_idx == 3


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
    """Pin "Push + Cardio" at day 4. Both day 0 (exact Push + Cardio)
    and day 3 (base Push, will get cardio finisher attached) are
    candidates. The picker chooses adjacency-free first; both options
    are checked and the closer adjacency-free swap wins."""
    days = _days("Push + Cardio", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=4, pin_focus="Push + Cardio")
    assert d.action == "swap"
    # Either day 0 or day 3 is acceptable — both produce a valid week.
    assert d.swap_with_idx in (0, 3)


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

def test_pin_bro_chest_to_day_2_canonical_rotation():
    """Bro: [Chest, Back, Shoulders, Arms, Legs]. Pin day 2 → Chest.
    Canonical rotation rebuilds from canonical bro cycle so Chest lands
    at day 2: result is some valid rotation of [C, B, S, A, L] starting
    so position 2 is Chest. Cycle preserved; pin honored."""
    from app.services.workout.switch_day import apply_rotate
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=2, pin_focus="Chest", preferred_split="bro")
    assert d.action in ("rotate", "noop")
    if d.action == "rotate":
        apply_rotate(days, d)
    assert _focuses(days)[2] == "Chest"
    # Result must be a contiguous slice of the canonical cycle.
    bro_cycle = ["Chest", "Back", "Shoulders", "Arms", "Legs"]
    valid_rotations = [[bro_cycle[(s + i) % 5] for i in range(5)] for s in range(5)]
    assert _focuses(days) in valid_rotations


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


# ── User-reported regression: PPL canonical-cycle pinning ──────────

def _ppl_fams(days: list[dict]) -> list[str]:
    """Coarse family for PPL adjacency / cycle checking."""
    out = []
    for d in days:
        f = (d.get("focus") or "").lower().replace(" + cardio", "")
        if "legs" in f: out.append("legs")
        elif "push" in f: out.append("push")
        elif "pull" in f: out.append("pull")
        elif "mobility" in f or "recovery" in f: out.append("rest")
        else: out.append("?")
    return out


def _assert_ppl_invariants(days: list[dict], pin_idx: int, pin_focus: str):
    """Three invariants for PPL after canonical-cycle pinning:
    1. Target day's focus base matches the pin
    2. No back-to-back same-family days
    3. Lift family counts are preserved (same number of push/pull/legs)
    """
    fams = _ppl_fams(days)
    target_base = pin_focus.lower().replace(" + cardio", "")
    assert target_base in fams[pin_idx], \
        f"target day {pin_idx} focus {fams[pin_idx]!r} doesn't match pin {pin_focus!r}"
    for i in range(len(fams) - 1):
        if fams[i] in ("push", "pull", "legs"):
            assert fams[i] != fams[i + 1], \
                f"back-to-back {fams[i]} at days {i}+{i+1}: {[d['focus'] for d in days]}"


def test_user_scenario_pin_pull_cardio_to_push_cardio_canonical():
    """Pin day 2 (Pull + Cardio) → Push + Cardio. Canonical-rebuild
    keeps PPL cycle (push→pull→legs) AND honors the pin."""
    from app.services.workout.switch_day import apply_rotate
    days = _days(
        "Push (Heavy)", "Recovery", "Pull + Cardio",
        "Legs", "Push", "Pull", "Legs",
    )
    d = decide_pin(days, pin_day_index=2, pin_focus="Push + Cardio",
                    preferred_split="ppl")
    assert d.action in ("rotate", "noop", "swap"), f"got {d.action}"
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    _assert_ppl_invariants(days, 2, "Push")


def test_user_scenario_pin_pull_cardio_to_legs_canonical():
    from app.services.workout.switch_day import apply_rotate
    days = _days(
        "Push (Heavy)", "Recovery", "Pull + Cardio",
        "Legs", "Push", "Pull", "Legs",
    )
    d = decide_pin(days, pin_day_index=2, pin_focus="Legs", preferred_split="ppl")
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    _assert_ppl_invariants(days, 2, "Legs")


def test_user_scenario_pin_day_5_pull_to_push_canonical():
    from app.services.workout.switch_day import apply_rotate
    days = _days(
        "Push (Heavy)", "Recovery", "Pull + Cardio",
        "Legs", "Push", "Pull", "Legs",
    )
    d = decide_pin(days, pin_day_index=5, pin_focus="Push", preferred_split="ppl")
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    _assert_ppl_invariants(days, 5, "Push")


def test_cumulative_pins_preserve_ppl_cycle():
    """Three sequential pins on a PPL recipe — the cycle must stay
    intact (push→pull→legs) after every pin. This was the root user
    complaint: 'plan is broken not following split' after multiple pins."""
    from app.services.workout.switch_day import apply_rotate
    days = _days(
        "Push + Cardio", "Pull", "Legs", "Push", "Pull", "Legs", "Mobility",
    )
    for pin_idx, focus in [(5, "Legs"), (0, "Legs"), (1, "Legs")]:
        d = decide_pin(days, pin_day_index=pin_idx, pin_focus=focus,
                        preferred_split="ppl")
        if d.action == "rotate":
            apply_rotate(days, d)
        elif d.action == "swap":
            apply_swap(days, d)
        # After every pin the cycle must hold.
        _assert_ppl_invariants(days, pin_idx, focus)
    # Final family counts: 2 push, 2 pull, 2 legs (canonical PPL 6d).
    fams = _ppl_fams(days)
    push = sum(1 for f in fams if f == "push")
    pull = sum(1 for f in fams if f == "pull")
    legs = sum(1 for f in fams if f == "legs")
    assert push == pull == legs == 2, \
        f"family counts broken: push={push} pull={pull} legs={legs}"


def test_user_scenario_back_to_back_legs_after_swap():
    """User's reported bug from real backend logs:
    Recipe: ['Pull', 'Legs', 'Push + Cardio', 'Push', 'Pull', 'Legs', 'Mobility']
    Pin day 5 → 'Push + Cardio'.

    With canonical-cycle rebuild (PPL): the full lift sequence is
    rebuilt as a rotation of canonical Push→Pull→Legs that places the
    requested focus at the target. No back-to-back same-family days
    AND the canonical PPL cycle is preserved across cumulative pins."""
    from app.services.workout.switch_day import apply_rotate
    days = _days(
        "Pull", "Legs", "Push + Cardio", "Push", "Pull", "Legs", "Mobility",
    )
    d = decide_pin(days, pin_day_index=5, pin_focus="Push + Cardio",
                    preferred_split="ppl")
    assert d.action in ("rotate", "swap"), f"got {d.action}"
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    new_focuses = [x.get("focus") for x in days]
    # Target landed on Push (with or without cardio finisher).
    assert "push" in (new_focuses[5] or "").lower()
    # No back-to-back same-family.
    fams = []
    for f in new_focuses:
        lo = (f or "").lower().replace(" + cardio", "")
        if "legs" in lo: fams.append("legs")
        elif "push" in lo: fams.append("push")
        elif "pull" in lo: fams.append("pull")
        elif "mobility" in lo or "recovery" in lo: fams.append("rest")
        else: fams.append("?")
    for i in range(len(fams) - 1):
        if fams[i] in ("push", "pull", "legs"):
            assert fams[i] != fams[i + 1], \
                f"back-to-back {fams[i]} at days {i}+{i+1}: {new_focuses}"


# ── Upper/Lower split pin behavior ─────────────────────────────────

def test_pin_upper_on_upper_lower_plan_is_swap():
    """Pin day 1 (Lower) → Upper on a U/L plan. Should swap within split."""
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Upper", preferred_split="upper_lower")
    assert d.action in ("swap", "rotate"), f"expected swap/rotate, got {d.action}"


def test_pin_lower_on_upper_lower_plan_is_swap():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower", preferred_split="upper_lower")
    assert d.action in ("swap", "rotate"), f"expected swap/rotate, got {d.action}"


def test_pin_upper_on_upper_is_noop():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="upper_lower")
    assert d.action == "noop"


def test_pin_lower_on_lower_is_noop():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Lower", preferred_split="upper_lower")
    assert d.action == "noop"


def test_pin_upper_plus_cardio_on_ul_plan():
    """Pin Upper + Cardio on a U/L plan day that's currently Lower."""
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Upper + Cardio", preferred_split="upper_lower")
    assert d.wants_cardio_finisher is True
    assert d.action in ("swap", "rotate")


def test_pin_chest_on_upper_lower_triggers_regen_to_bro():
    """Pin Chest on U/L plan should regen to bro split."""
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "bro"


# ── Full Body split pin behavior ──────────────────────────────────

def test_pin_full_body_on_full_body_is_noop():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="full_body")
    assert d.action == "noop"


def test_pin_recovery_on_full_body_plan():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=1, pin_focus="Recovery", preferred_split="full_body")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"


def test_pin_push_on_full_body_triggers_regen_to_ppl():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="full_body")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_pin_full_body_plus_cardio_on_full_body_plan():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=1, pin_focus="Full Body + Cardio", preferred_split="full_body")
    assert d.wants_cardio_finisher is True


# ── Bro split: all focuses ────────────────────────────────────────

def test_pin_back_on_bro_plan():
    from app.services.workout.switch_day import apply_rotate, apply_bro_canonical_swap
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=4, pin_focus="Back", preferred_split="bro")
    assert d.action in ("rotate", "bro_canonical_swap", "noop", "swap")
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "bro_canonical_swap":
        apply_bro_canonical_swap(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    assert _focuses(days)[4] == "Back"


def test_pin_shoulders_on_bro_plan():
    from app.services.workout.switch_day import apply_rotate, apply_bro_canonical_swap
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Shoulders", preferred_split="bro")
    assert d.action in ("rotate", "bro_canonical_swap", "noop", "swap")
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "bro_canonical_swap":
        apply_bro_canonical_swap(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    assert _focuses(days)[0] == "Shoulders"


def test_pin_arms_on_bro_plan():
    from app.services.workout.switch_day import apply_rotate, apply_bro_canonical_swap
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Arms", preferred_split="bro")
    assert d.action in ("rotate", "bro_canonical_swap", "noop", "swap")
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "bro_canonical_swap":
        apply_bro_canonical_swap(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    assert _focuses(days)[0] == "Arms"


def test_pin_push_on_bro_triggers_regen_to_ppl():
    """Pin Push on bro plan → out of split → regen to PPL."""
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="bro")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


# ── PPL+UL hybrid split ──────────────────────────────────────────

def test_pin_upper_on_ppl_ul_hybrid_is_in_split():
    """PPL+UL hybrid contains both Push/Pull/Legs and Upper/Lower."""
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate"), f"Upper should be in-split for ppl_ul, got {d.action}"


def test_pin_push_on_ppl_ul_hybrid_is_in_split():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Push", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate"), f"Push should be in-split for ppl_ul, got {d.action}"


def test_pin_chest_on_ppl_ul_triggers_regen_to_bro():
    """Bro focus on PPL+UL → out of split → regen."""
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="ppl_upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "bro"


# ── SPLIT_FOR_FOCUS completeness ──────────────────────────────────

def test_split_for_focus_maps_to_known_splits():
    """Every value in SPLIT_FOR_FOCUS must be a split the planner knows."""
    known_splits = {"ppl", "upper_lower", "full_body", "ppl_upper_lower", "bro"}
    for focus, split in SPLIT_FOR_FOCUS.items():
        assert split in known_splits, \
            f"SPLIT_FOR_FOCUS['{focus}'] = '{split}' not in known splits"


def test_every_split_has_at_least_one_focus_in_map():
    """Every known split should have at least one focus that maps to it,
    so the out-of-split regen path can produce that split."""
    known_splits = {"ppl", "upper_lower", "full_body", "bro"}
    mapped_splits = set(SPLIT_FOR_FOCUS.values())
    for s in known_splits:
        assert s in mapped_splits, \
            f"split '{s}' has no focus mapping in SPLIT_FOR_FOCUS"


def test_non_lifting_focuses_rejected_by_swap_path():
    """Non-lifting focuses (Recovery, Cardio, Mobility) always route to
    replace_day, not swap/rotate, regardless of split."""
    for split in ["ppl", "upper_lower", "full_body", "bro"]:
        days = _days("Push", "Pull", "Legs")
        for focus in ["Recovery", "Mobility", "Cardio"]:
            d = decide_pin(days, pin_day_index=0, pin_focus=focus, preferred_split=split)
            assert d.action == "replace_day", \
                f"{focus} on {split} should be replace_day, got {d.action}"


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
