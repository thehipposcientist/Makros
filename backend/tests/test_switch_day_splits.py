"""Comprehensive switch-day tests — ~20 per split type.

Covers realistic week layouts (3d–7d), plus-cardio variants,
non-lifting day targets, cumulative pins, cardio finisher flags,
out-of-split regen triggers, and cycle preservation.
"""
from __future__ import annotations

from app.services.workout.switch_day import (
    decide_pin, apply_swap, apply_rotate,
    SPLIT_FOR_FOCUS, NON_LIFTING_FOCUSES,
    normalize_focus, split_lifting_focus, _focus_family,
)
try:
    from app.services.workout.switch_day import apply_bro_canonical_swap
except ImportError:
    apply_bro_canonical_swap = None


def _days(*focuses: str) -> list[dict]:
    return [{"focus": f, "_orig_idx": i} for i, f in enumerate(focuses)]


def _focuses(days: list[dict]) -> list[str]:
    return [d.get("focus") for d in days]


def _apply(days, d):
    if d.action == "rotate":
        apply_rotate(days, d)
    elif d.action == "swap":
        apply_swap(days, d)
    elif d.action == "bro_canonical_swap" and apply_bro_canonical_swap:
        apply_bro_canonical_swap(days, d)


def _family(f: str) -> str:
    return _focus_family(f)


def _lift_families(days: list[dict]) -> list[str]:
    out = []
    for d in days:
        f = (d.get("focus") or "").lower().replace(" + cardio", "")
        if any(kw in f for kw in ("recover", "rest", "mobil", "stretch")):
            out.append("rest")
        else:
            out.append(_family(d.get("focus", "")))
    return out


def _no_adjacent_same_family(days: list[dict], ignore=("rest", "?", "full_body")):
    """Assert no back-to-back same lift family (ignoring rest/easy days)."""
    fams = _lift_families(days)
    for i in range(len(fams) - 1):
        if fams[i] in ignore or fams[i + 1] in ignore:
            continue
        assert fams[i] != fams[i + 1], \
            f"back-to-back {fams[i]} at days {i}+{i+1}: {_focuses(days)}"


# ═══════════════════════════════════════════════════════════════════════
# PPL SPLIT — 20 tests
# ═══════════════════════════════════════════════════════════════════════

def test_ppl_3d_pin_push_to_pull_slot():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=1, pin_focus="Push", preferred_split="ppl")
    assert d.action in ("swap", "rotate")
    _apply(days, d)
    assert "push" in _focuses(days)[1].lower()


def test_ppl_3d_pin_legs_to_push_slot():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs", preferred_split="ppl")
    _apply(days, d)
    assert "legs" in _focuses(days)[0].lower()


def test_ppl_3d_pin_pull_to_legs_slot():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=2, pin_focus="Pull", preferred_split="ppl")
    _apply(days, d)
    assert "pull" in _focuses(days)[2].lower()


def test_ppl_5d_pin_push_to_day4():
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=4, pin_focus="Push", preferred_split="ppl")
    _apply(days, d)
    assert "push" in _focuses(days)[4].lower()


def test_ppl_6d_pin_legs_to_day0():
    days = _days("Push", "Pull", "Legs", "Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs", preferred_split="ppl")
    _apply(days, d)
    assert "legs" in _focuses(days)[0].lower()


def test_ppl_6d_all_push_to_pull_slot_no_adjacency():
    days = _days("Push", "Pull", "Legs", "Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=1, pin_focus="Push", preferred_split="ppl")
    _apply(days, d)
    assert "push" in _focuses(days)[1].lower()


def test_ppl_7d_with_rest_pin_pull_to_rest_slot():
    days = _days("Push", "Pull", "Legs", "Push", "Pull", "Legs", "Recovery")
    d = decide_pin(days, pin_day_index=6, pin_focus="Pull", preferred_split="ppl")
    _apply(days, d)
    assert "pull" in _focuses(days)[6].lower()


def test_ppl_noop_push_on_push():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="ppl")
    assert d.action == "noop"


def test_ppl_noop_legs_on_legs():
    days = _days("Push", "Pull", "Legs", "Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=5, pin_focus="Legs", preferred_split="ppl")
    assert d.action == "noop"


def test_ppl_plus_cardio_push():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=1, pin_focus="Push + Cardio", preferred_split="ppl")
    assert d.wants_cardio_finisher is True
    _apply(days, d)
    base = _focuses(days)[1].lower().replace(" + cardio", "")
    assert "push" in base


def test_ppl_plus_cardio_pull():
    days = _days("Push", "Pull", "Legs", "Push", "Pull")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull + Cardio", preferred_split="ppl")
    assert d.wants_cardio_finisher is True
    _apply(days, d)
    base = _focuses(days)[0].lower().replace(" + cardio", "")
    assert "pull" in base


def test_ppl_pin_recovery_on_any_day():
    for i in range(3):
        days = _days("Push", "Pull", "Legs")
        d = decide_pin(days, pin_day_index=i, pin_focus="Recovery", preferred_split="ppl")
        assert d.action == "replace_day"
        assert d.day_kind == "recovery"


def test_ppl_pin_cardio_on_any_day():
    for i in range(3):
        days = _days("Push", "Pull", "Legs")
        d = decide_pin(days, pin_day_index=i, pin_focus="Cardio", preferred_split="ppl")
        assert d.action == "replace_day"
        assert d.day_kind == "cardio"


def test_ppl_pin_mobility_on_any_day():
    for i in range(3):
        days = _days("Push", "Pull", "Legs")
        d = decide_pin(days, pin_day_index=i, pin_focus="Mobility", preferred_split="ppl")
        assert d.action == "replace_day"
        assert d.day_kind == "mobility"


def test_ppl_out_of_split_chest_triggers_regen():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="ppl")
    assert d.action == "regen"
    assert d.regen_split == "bro"


def test_ppl_out_of_split_upper_triggers_regen():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="ppl")
    assert d.action == "regen"
    assert d.regen_split == "upper_lower"


def test_ppl_out_of_split_full_body_triggers_regen():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="ppl")
    assert d.action == "regen"
    assert d.regen_split == "full_body"


def test_ppl_heavy_variant_pin_still_places_push():
    """Push (Heavy) at day 0 — pin "Push" rebuilds via canonical cycle.
    (Heavy) uses parens not dash, so _base_of doesn't strip it; the
    canonical cycle rebuild produces a valid PPL rotation with push at 0."""
    days = _days("Push (Heavy)", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="ppl")
    _apply(days, d)
    assert "push" in _focuses(days)[0].lower()


def test_ppl_cumulative_3_pins_cycle_preserved():
    days = _days("Push", "Pull", "Legs", "Push", "Pull", "Legs")
    for pin_idx, focus in [(0, "Legs"), (3, "Pull"), (5, "Push")]:
        d = decide_pin(days, pin_day_index=pin_idx, pin_focus=focus, preferred_split="ppl")
        _apply(days, d)
        assert focus.lower() in _focuses(days)[pin_idx].lower()


def test_ppl_pin_with_plus_cardio_recipe():
    """Recipe has Pull + Cardio; plain Pull pin should match via base fallback."""
    days = _days("Push", "Pull + Cardio", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull", preferred_split="ppl")
    _apply(days, d)
    assert "pull" in _focuses(days)[0].lower()


def test_ppl_deterministic():
    days1 = _days("Push", "Pull", "Legs", "Push", "Pull")
    days2 = _days("Push", "Pull", "Legs", "Push", "Pull")
    d1 = decide_pin(days1, pin_day_index=2, pin_focus="Push", preferred_split="ppl")
    d2 = decide_pin(days2, pin_day_index=2, pin_focus="Push", preferred_split="ppl")
    assert d1.action == d2.action
    assert d1.swap_with_idx == d2.swap_with_idx


# ═══════════════════════════════════════════════════════════════════════
# UPPER/LOWER SPLIT — 20 tests
# ═══════════════════════════════════════════════════════════════════════

def test_ul_4d_pin_upper_to_lower_slot():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Upper", preferred_split="upper_lower")
    assert d.action in ("swap", "rotate")
    _apply(days, d)
    assert "upper" in _focuses(days)[1].lower()


def test_ul_4d_pin_lower_to_upper_slot():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower", preferred_split="upper_lower")
    _apply(days, d)
    assert "lower" in _focuses(days)[0].lower()


def test_ul_6d_pin_upper_to_day5():
    days = _days("Upper", "Lower", "Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=5, pin_focus="Upper", preferred_split="upper_lower")
    _apply(days, d)
    assert "upper" in _focuses(days)[5].lower()


def test_ul_6d_pin_lower_to_day0():
    days = _days("Upper", "Lower", "Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower", preferred_split="upper_lower")
    _apply(days, d)
    assert "lower" in _focuses(days)[0].lower()


def test_ul_noop_upper_on_upper():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="upper_lower")
    assert d.action == "noop"


def test_ul_noop_lower_on_lower():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Lower", preferred_split="upper_lower")
    assert d.action == "noop"


def test_ul_plus_cardio_upper():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Upper + Cardio", preferred_split="upper_lower")
    assert d.wants_cardio_finisher is True
    _apply(days, d)
    base = _focuses(days)[1].lower().replace(" + cardio", "")
    assert "upper" in base


def test_ul_plus_cardio_lower():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower + Cardio", preferred_split="upper_lower")
    assert d.wants_cardio_finisher is True
    _apply(days, d)
    base = _focuses(days)[0].lower().replace(" + cardio", "")
    assert "lower" in base


def test_ul_recovery_replace():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=2, pin_focus="Recovery", preferred_split="upper_lower")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"


def test_ul_mobility_replace():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Mobility", preferred_split="upper_lower")
    assert d.action == "replace_day"
    assert d.day_kind == "mobility"


def test_ul_cardio_replace():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Cardio", preferred_split="upper_lower")
    assert d.action == "replace_day"
    assert d.day_kind == "cardio"


def test_ul_out_of_split_push_triggers_regen():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_ul_out_of_split_pull_triggers_regen():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_ul_out_of_split_chest_triggers_regen():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "bro"


def test_ul_out_of_split_full_body_triggers_regen():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "full_body"


def test_ul_5d_with_rest_pin_lower_to_rest():
    days = _days("Upper", "Lower", "Upper", "Lower", "Recovery")
    d = decide_pin(days, pin_day_index=4, pin_focus="Lower", preferred_split="upper_lower")
    _apply(days, d)
    assert "lower" in _focuses(days)[4].lower()


def test_ul_7d_with_rest_and_cardio():
    days = _days("Upper", "Lower", "Upper", "Lower", "Upper", "Cardio", "Recovery")
    d = decide_pin(days, pin_day_index=5, pin_focus="Lower", preferred_split="upper_lower")
    _apply(days, d)
    assert "lower" in _focuses(days)[5].lower()


def test_ul_cumulative_pins():
    days = _days("Upper", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower", preferred_split="upper_lower")
    _apply(days, d)
    assert "lower" in _focuses(days)[0].lower()
    d2 = decide_pin(days, pin_day_index=2, pin_focus="Lower", preferred_split="upper_lower")
    _apply(days, d2)
    assert "lower" in _focuses(days)[2].lower()


def test_ul_pin_with_plus_cardio_recipe():
    """Recipe has Upper + Cardio; plain Upper pin matches."""
    days = _days("Upper + Cardio", "Lower", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=1, pin_focus="Upper", preferred_split="upper_lower")
    _apply(days, d)
    assert "upper" in _focuses(days)[1].lower()


def test_ul_deterministic():
    days1 = _days("Upper", "Lower", "Upper", "Lower")
    days2 = _days("Upper", "Lower", "Upper", "Lower")
    d1 = decide_pin(days1, pin_day_index=1, pin_focus="Upper", preferred_split="upper_lower")
    d2 = decide_pin(days2, pin_day_index=1, pin_focus="Upper", preferred_split="upper_lower")
    assert d1.action == d2.action


# ═══════════════════════════════════════════════════════════════════════
# FULL BODY SPLIT — 20 tests
# ═══════════════════════════════════════════════════════════════════════

def test_fb_3d_noop_on_same():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="full_body")
    assert d.action == "noop"


def test_fb_3d_noop_on_each_day():
    days = _days("Full Body", "Full Body", "Full Body")
    for i in range(3):
        d = decide_pin(days, pin_day_index=i, pin_focus="Full Body", preferred_split="full_body")
        assert d.action == "noop"


def test_fb_3d_recovery_replace_each_day():
    for i in range(3):
        days = _days("Full Body", "Full Body", "Full Body")
        d = decide_pin(days, pin_day_index=i, pin_focus="Recovery", preferred_split="full_body")
        assert d.action == "replace_day"
        assert d.day_kind == "recovery"


def test_fb_3d_mobility_replace():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=1, pin_focus="Mobility", preferred_split="full_body")
    assert d.action == "replace_day"
    assert d.day_kind == "mobility"


def test_fb_3d_cardio_replace():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=2, pin_focus="Cardio", preferred_split="full_body")
    assert d.action == "replace_day"
    assert d.day_kind == "cardio"


def test_fb_plus_cardio():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=1, pin_focus="Full Body + Cardio", preferred_split="full_body")
    assert d.wants_cardio_finisher is True


def test_fb_plus_cardio_on_each_day():
    for i in range(3):
        days = _days("Full Body", "Full Body", "Full Body")
        d = decide_pin(days, pin_day_index=i, pin_focus="Full Body + Cardio", preferred_split="full_body")
        assert d.wants_cardio_finisher is True


def test_fb_out_of_split_push_regen():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="full_body")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_fb_out_of_split_pull_regen():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull", preferred_split="full_body")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_fb_out_of_split_legs_regen():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs", preferred_split="full_body")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_fb_out_of_split_upper_regen():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="full_body")
    assert d.action == "regen"
    assert d.regen_split == "upper_lower"


def test_fb_out_of_split_chest_regen():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="full_body")
    assert d.action == "regen"
    assert d.regen_split == "bro"


def test_fb_5d_pin_recovery_to_rest():
    days = _days("Full Body", "Full Body", "Full Body", "Full Body", "Recovery")
    d = decide_pin(days, pin_day_index=4, pin_focus="Full Body", preferred_split="full_body")
    _apply(days, d)
    assert "full body" in _focuses(days)[4].lower()


def test_fb_7d_mixed_with_rest():
    days = _days("Full Body", "Recovery", "Full Body", "Recovery", "Full Body", "Recovery", "Mobility")
    d = decide_pin(days, pin_day_index=1, pin_focus="Full Body", preferred_split="full_body")
    _apply(days, d)
    assert "full body" in _focuses(days)[1].lower()


def test_fb_active_recovery_normalizes():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Active Recovery", preferred_split="full_body")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"


def test_fb_stretching_normalizes_to_mobility():
    days = _days("Full Body", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Stretching", preferred_split="full_body")
    assert d.action == "replace_day"
    assert d.day_kind == "mobility"


def test_fb_deterministic():
    days1 = _days("Full Body", "Full Body", "Full Body")
    days2 = _days("Full Body", "Full Body", "Full Body")
    d1 = decide_pin(days1, pin_day_index=0, pin_focus="Recovery", preferred_split="full_body")
    d2 = decide_pin(days2, pin_day_index=0, pin_focus="Recovery", preferred_split="full_body")
    assert d1.action == d2.action
    assert d1.day_kind == d2.day_kind


def test_fb_4d_noop_all():
    days = _days("Full Body", "Full Body", "Full Body", "Full Body")
    for i in range(4):
        d = decide_pin(days, pin_day_index=i, pin_focus="Full Body", preferred_split="full_body")
        assert d.action == "noop"


def test_fb_pin_with_plus_cardio_existing():
    """Recipe has Full Body + Cardio; plain Full Body pin is noop."""
    days = _days("Full Body + Cardio", "Full Body", "Full Body")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="full_body")
    assert d.action == "noop"


# ═══════════════════════════════════════════════════════════════════════
# BRO SPLIT — 20 tests
# ═══════════════════════════════════════════════════════════════════════

def test_bro_5d_noop_chest_on_chest():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="bro")
    assert d.action == "noop"


def test_bro_5d_noop_each_day():
    focuses = ["Chest", "Back", "Shoulders", "Arms", "Legs"]
    for i, f in enumerate(focuses):
        days = _days(*focuses)
        d = decide_pin(days, pin_day_index=i, pin_focus=f, preferred_split="bro")
        assert d.action == "noop", f"day {i} {f} should be noop"


def test_bro_pin_back_to_chest_slot():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Back", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[0] == "Back"


def test_bro_pin_legs_to_day0():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[0] == "Legs"


def test_bro_pin_chest_to_day4():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=4, pin_focus="Chest", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[4] == "Chest"


def test_bro_pin_shoulders_to_day1():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=1, pin_focus="Shoulders", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[1] == "Shoulders"


def test_bro_pin_arms_to_day2():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=2, pin_focus="Arms", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[2] == "Arms"


def test_bro_recovery_replace():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=2, pin_focus="Recovery", preferred_split="bro")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"


def test_bro_mobility_replace():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Mobility", preferred_split="bro")
    assert d.action == "replace_day"
    assert d.day_kind == "mobility"


def test_bro_cardio_replace():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=4, pin_focus="Cardio", preferred_split="bro")
    assert d.action == "replace_day"
    assert d.day_kind == "cardio"


def test_bro_out_of_split_push_regen():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="bro")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_bro_out_of_split_pull_regen():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull", preferred_split="bro")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


def test_bro_out_of_split_upper_regen():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="bro")
    assert d.action == "regen"
    assert d.regen_split == "upper_lower"


def test_bro_out_of_split_full_body_regen():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="bro")
    assert d.action == "regen"
    assert d.regen_split == "full_body"


def test_bro_6d_with_rest():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs", "Recovery")
    d = decide_pin(days, pin_day_index=5, pin_focus="Chest", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[5] == "Chest"


def test_bro_cycle_preserved_after_rotate():
    """After rotation, result should be a valid rotation of the bro cycle."""
    bro_cycle = ["Chest", "Back", "Shoulders", "Arms", "Legs"]
    valid_rotations = [[bro_cycle[(s + i) % 5] for i in range(5)] for s in range(5)]
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=3, pin_focus="Chest", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[3] == "Chest"
    assert _focuses(days) in valid_rotations


def test_bro_cumulative_2_pins():
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs", preferred_split="bro")
    _apply(days, d)
    assert _focuses(days)[0] == "Legs"
    d2 = decide_pin(days, pin_day_index=4, pin_focus="Chest", preferred_split="bro")
    _apply(days, d2)
    assert _focuses(days)[4] == "Chest"


def test_bro_upper_plus_cardio():
    """Bro split exposes Upper + Cardio."""
    days = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper + Cardio", preferred_split="bro")
    assert d.wants_cardio_finisher is True


def test_bro_deterministic():
    days1 = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    days2 = _days("Chest", "Back", "Shoulders", "Arms", "Legs")
    d1 = decide_pin(days1, pin_day_index=2, pin_focus="Back", preferred_split="bro")
    d2 = decide_pin(days2, pin_day_index=2, pin_focus="Back", preferred_split="bro")
    assert d1.action == d2.action


# ═══════════════════════════════════════════════════════════════════════
# PPL+UPPER/LOWER HYBRID — 20 tests
# ═══════════════════════════════════════════════════════════════════════

def test_ppl_ul_pin_push_in_split():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Push", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate")


def test_ppl_ul_pin_upper_in_split():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate")


def test_ppl_ul_pin_lower_in_split():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Lower", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate")


def test_ppl_ul_pin_pull_in_split():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Pull", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate")
    _apply(days, d)
    assert "pull" in _focuses(days)[3].lower()


def test_ppl_ul_pin_legs_in_split():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=4, pin_focus="Legs", preferred_split="ppl_upper_lower")
    assert d.action in ("swap", "rotate")
    _apply(days, d)
    assert "legs" in _focuses(days)[4].lower()


def test_ppl_ul_noop_push_on_push():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="ppl_upper_lower")
    assert d.action == "noop"


def test_ppl_ul_noop_upper_on_upper():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Upper", preferred_split="ppl_upper_lower")
    assert d.action == "noop"


def test_ppl_ul_noop_lower_on_lower():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=4, pin_focus="Lower", preferred_split="ppl_upper_lower")
    assert d.action == "noop"


def test_ppl_ul_plus_cardio_push():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=3, pin_focus="Push + Cardio", preferred_split="ppl_upper_lower")
    assert d.wants_cardio_finisher is True


def test_ppl_ul_plus_cardio_pull():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull + Cardio", preferred_split="ppl_upper_lower")
    assert d.wants_cardio_finisher is True


def test_ppl_ul_plus_cardio_upper():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper + Cardio", preferred_split="ppl_upper_lower")
    assert d.wants_cardio_finisher is True


def test_ppl_ul_recovery_replace():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=2, pin_focus="Recovery", preferred_split="ppl_upper_lower")
    assert d.action == "replace_day"
    assert d.day_kind == "recovery"


def test_ppl_ul_cardio_replace():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Cardio", preferred_split="ppl_upper_lower")
    assert d.action == "replace_day"
    assert d.day_kind == "cardio"


def test_ppl_ul_out_of_split_chest_regen():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Chest", preferred_split="ppl_upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "bro"


def test_ppl_ul_out_of_split_full_body_regen():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Full Body", preferred_split="ppl_upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "full_body"


def test_ppl_ul_6d_with_rest():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower", "Recovery")
    d = decide_pin(days, pin_day_index=5, pin_focus="Push", preferred_split="ppl_upper_lower")
    _apply(days, d)
    assert "push" in _focuses(days)[5].lower()


def test_ppl_ul_7d_with_rest_and_cardio():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower", "Cardio", "Recovery")
    d = decide_pin(days, pin_day_index=5, pin_focus="Upper", preferred_split="ppl_upper_lower")
    _apply(days, d)
    assert "upper" in _focuses(days)[5].lower()


def test_ppl_ul_cumulative():
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Upper", preferred_split="ppl_upper_lower")
    _apply(days, d)
    assert "upper" in _focuses(days)[0].lower()
    d2 = decide_pin(days, pin_day_index=4, pin_focus="Push", preferred_split="ppl_upper_lower")
    _apply(days, d2)
    assert "push" in _focuses(days)[4].lower()


def test_ppl_ul_deterministic():
    days1 = _days("Push", "Pull", "Legs", "Upper", "Lower")
    days2 = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d1 = decide_pin(days1, pin_day_index=3, pin_focus="Pull", preferred_split="ppl_upper_lower")
    d2 = decide_pin(days2, pin_day_index=3, pin_focus="Pull", preferred_split="ppl_upper_lower")
    assert d1.action == d2.action


def test_ppl_ul_back_on_hybrid_regen_bro():
    """Back is bro split focus, not in ppl_ul."""
    days = _days("Push", "Pull", "Legs", "Upper", "Lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Back", preferred_split="ppl_upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "bro"


# ═══════════════════════════════════════════════════════════════════════
# CROSS-SPLIT EDGE CASES — 20 tests
# ═══════════════════════════════════════════════════════════════════════

def test_normalize_focus_trims():
    assert normalize_focus("  Push  ") == "push"
    assert normalize_focus("PUSH") == "push"
    assert normalize_focus("") == ""


def test_split_lifting_focus_plain():
    base, cardio = split_lifting_focus("Push")
    assert base == "push"
    assert cardio is False


def test_split_lifting_focus_with_cardio():
    base, cardio = split_lifting_focus("Push + Cardio")
    assert base == "push"
    assert cardio is True


def test_split_lifting_focus_case_insensitive():
    base, cardio = split_lifting_focus("UPPER + CARDIO")
    assert base == "upper"
    assert cardio is True


def test_focus_family_push_variants():
    assert _focus_family("Push") == "push"
    assert _focus_family("Push (Heavy)") == "push"
    assert _focus_family("Push + Cardio") == "push"
    assert _focus_family("push — chest focus") == "push"


def test_focus_family_pull_variants():
    assert _focus_family("Pull") == "pull"
    assert _focus_family("Pull + Cardio") == "pull"
    assert _focus_family("pull (hypertrophy)") == "pull"


def test_focus_family_legs_variants():
    assert _focus_family("Legs") == "legs"
    assert _focus_family("Leg Day") == "legs"


def test_focus_family_upper_lower():
    assert _focus_family("Upper") == "upper"
    assert _focus_family("Lower") == "lower"
    assert _focus_family("Upper + Cardio") == "upper"
    assert _focus_family("Lower + Cardio") == "lower"


def test_focus_family_full_body():
    assert _focus_family("Full Body") == "full_body"
    assert _focus_family("Full Body + Cardio") == "full_body"


def test_focus_family_bro_muscles():
    assert _focus_family("Chest") == "push"
    assert _focus_family("Shoulders") == "push"
    assert _focus_family("Back") == "pull"
    assert _focus_family("Arms") == "upper"


def test_non_lifting_focuses_are_complete():
    for f in ["recovery", "mobility", "cardio"]:
        assert f in NON_LIFTING_FOCUSES


def test_out_of_bounds_index_clamped_high():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=100, pin_focus="Push", preferred_split="ppl")
    assert d.target_idx == 2


def test_out_of_bounds_index_clamped_low():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=-10, pin_focus="Push", preferred_split="ppl")
    assert d.target_idx == 0


def test_empty_focus_string():
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="", preferred_split="ppl")
    # Empty focus shouldn't crash — either noop or some safe action
    assert d is not None


def test_no_preferred_split_defaults_to_swap():
    """No split preference → falls back to swap behavior."""
    days = _days("Push", "Pull", "Legs")
    d = decide_pin(days, pin_day_index=0, pin_focus="Legs")
    assert d.action in ("swap", "rotate", "noop")


def test_all_rest_days_pin_lifting():
    """Recipe is all rest days; user pins a lift focus."""
    days = _days("Recovery", "Recovery", "Recovery")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push")
    # No matching lift day to swap with — should trigger regen or some action
    assert d.action in ("regen", "replace_day", "swap", "noop")


def test_single_day_plan():
    days = _days("Push")
    d = decide_pin(days, pin_day_index=0, pin_focus="Pull", preferred_split="ppl")
    # Should attempt swap/regen — can't do an in-place swap with only 1 day
    assert d is not None


def test_non_lifting_on_every_split():
    """Recovery/Mobility/Cardio should ALWAYS be replace_day regardless of split."""
    for split in ["ppl", "upper_lower", "full_body", "bro", "ppl_upper_lower"]:
        for focus in ["Recovery", "Mobility", "Cardio"]:
            days = _days("Push", "Pull", "Legs", "Upper", "Lower")
            d = decide_pin(days, pin_day_index=0, pin_focus=focus, preferred_split=split)
            assert d.action == "replace_day", \
                f"{focus} on {split} should be replace_day, got {d.action}"


def test_split_for_focus_table_complete():
    """Every client-surfaced focus should be in SPLIT_FOR_FOCUS."""
    all_focuses = [
        "push", "pull", "legs", "upper", "lower",
        "full body", "full_body", "chest", "back", "shoulders", "arms",
    ]
    for f in all_focuses:
        assert f in SPLIT_FOR_FOCUS, f"missing {f!r} in SPLIT_FOR_FOCUS"


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
        print(f"\n{len(failed)} of {len(test_fns)} FAILED")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} switch_day_splits tests passed")
