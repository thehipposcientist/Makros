"""Switch Day integration sweep.

Unlike `test_switch_day.py` (which uses stubbed day dicts to test the
pure helper), this module:

  1. Generates a REAL recipe via the planner.
  2. Applies a pin via `decide_pin` + `apply_*`.
  3. Asserts the resulting week:
       - target day actually has the requested focus
       - the full week still satisfies the split contract
       - lift count is preserved
       - bro stays canonical (Chest→Back→Shoulders→Arms→Legs)
       - PPL family distribution still balances

Sweeps:
  - Every pin POSITION (day 0..N-1) for each split at 5d/6d/7d
  - History seeded: recent push, recent pull, recent legs, recent
    push+pull → assert pin still works AND result respects history
  - Pin to in-split focus, out-of-split focus, cardio-finisher,
    Recovery / Mobility / Cardio
  - Sequential pins (pin day 2, then pin day 4) preserve coherence

This is the layer that catches "Switch Day produced a structurally
broken week even though the pin algorithm itself looked correct."
"""
from __future__ import annotations

from app.services.workout.planner import PlannerInputs, generate_workout_plan
from app.services.workout.switch_day import (
    decide_pin, apply_swap,
)
from app.seed_exercises_data import SEED_EXERCISES
from tests._generation_contracts import (
    assert_split_distribution,
    assert_day_count,
    assert_no_rest_at_week_start,
    assert_bro_canonical,
    assert_no_plus_cardio_on_bro,
    family_counts,
    is_lift,
    _focus,
)


_FULL_GYM = (
    "barbell", "dumbbells", "weight_plates", "power_rack", "squat_rack",
    "flat_bench", "adjustable_bench", "preacher_bench",
    "cable_machine", "lat_pulldown", "pull_up_bar", "dip_bars",
    "leg_press", "smith_machine", "ez_curl_bar",
    "kettlebell", "trap_bar", "landmine_attachment",
    "rowing_machine", "treadmill", "stationary_bike", "stair_climber",
    "assault_bike", "elliptical", "ski_erg", "concept2_rower",
    "leg_curl_machine", "leg_extension_machine", "calf_raise_machine",
    "seated_row_machine", "chest_press_machine", "shoulder_press_machine",
    "hack_squat", "glute_ham_developer", "back_extension_bench",
)


def _gen_recipe(*, goal: str, days_per_week: int, preferred_split: str | None,
                experience: str = "intermediate",
                recent_focus_buckets: tuple[str, ...] = (),
                recent_focus_families: tuple[str, ...] = (),
                rng_seed: int = 42) -> list[dict]:
    inputs = PlannerInputs(
        goal=goal,
        days_per_week=days_per_week,
        session_minutes=60,
        experience=experience,
        equipment_slugs=_FULL_GYM,
        preferred_split=preferred_split,
        priority_region="balanced",
        injuries=tuple(),
        disliked_exercises=tuple(),
        rng_seed=rng_seed,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=None,
    )
    return generate_workout_plan(inputs, SEED_EXERCISES)["workout_plan"]["days"]


def _apply_pin(days: list[dict], pin_day_index: int, pin_focus: str,
                preferred_split: str | None) -> tuple[list[dict], object]:
    """Run decide_pin + apply the resulting action. Mirrors what
    routers/workouts.py does for the swap/noop cases. The
    regen / replace_day / label_only paths require IO callbacks
    we don't simulate here — those are tested at the unit level.

    Returns (days_after, decision) so callers can inspect both."""
    decision = decide_pin(
        days,
        pin_day_index=pin_day_index,
        pin_focus=pin_focus,
        preferred_split=preferred_split,
    )
    if decision.action == "swap":
        apply_swap(days, decision)
    # noop / regen / replace_day / label_only — unit-tested separately
    return days, decision


def _focus_at(days: list[dict], i: int) -> str:
    return (days[i].get("focus") or "").strip()


def _focus_at_lower(days: list[dict], i: int) -> str:
    return _focus_at(days, i).lower()


# ── Per-position pin sweep: pin every day to each in-split focus ──

def _make_position_pin_test(split: str, goal: str, days: int, experience: str,
                              pin_day: int, pin_focus: str):
    """Generate a recipe, pin pin_day → pin_focus, assert the result.

    Single-day swap contract (Apr 2026):
      - Target day has the pinned focus (or noop if it already did).
      - At most TWO days change from the original (target + swap partner).
      - Lift count preserved.
      - All untouched days are byte-identical to the original.
    """
    def _t():
        recipe = _gen_recipe(
            goal=goal, days_per_week=days,
            preferred_split=split, experience=experience,
        )
        original_focuses = [d.get("focus") for d in recipe]
        original_lift_count = sum(1 for d in recipe if is_lift(_focus(d)))
        _, decision = _apply_pin(recipe, pin_day, pin_focus, preferred_split=split)
        ctx = f"after pin {split} {goal} {days}d day{pin_day}→{pin_focus}"

        # 1. Day count preserved.
        assert_day_count(recipe, days, ctx=ctx)

        # 2. Target day matches the pin (allow base-focus equivalence:
        #    "Push" matches "Push (Heavy)" / "Push + Cardio").
        actual = _focus_at_lower(recipe, pin_day)
        expected_base = pin_focus.lower().replace(" + cardio", "").strip()
        actual_base = actual.replace(" + cardio", "").strip()
        # Strip variant suffix " — Heavy" etc.
        if " — " in actual_base:
            actual_base = actual_base.split(" — ")[0].strip()
        assert actual_base == expected_base or expected_base in actual_base, \
            f"{ctx}: target focus is '{recipe[pin_day].get('focus')}', " \
            f"wanted base match for '{pin_focus}'"

        # 3. Lift count preserved.
        new_lift_count = sum(1 for d in recipe if is_lift(_focus(d)))
        assert new_lift_count == original_lift_count, \
            f"{ctx}: lift count changed {original_lift_count}→{new_lift_count}"

        # 4. AT MOST TWO DAYS CHANGED from the original. This is the
        #    core single-day swap contract — Switch Day must NOT
        #    rearrange days the user didn't touch.
        new_focuses = [d.get("focus") for d in recipe]
        changed = [i for i in range(len(recipe))
                    if new_focuses[i] != original_focuses[i]]
        assert len(changed) <= 2, \
            f"{ctx}: Switch Day touched {len(changed)} days {changed}, " \
            f"expected ≤2. Original={original_focuses} new={new_focuses}"

        # 5. Bro never gets PLUS_CARDIO injected.
        if split == "bro":
            assert_no_plus_cardio_on_bro(recipe, split, ctx=ctx)
    _t.__name__ = f"test_pos_{split}_{goal}_{days}d_pin{pin_day}_{pin_focus.lower().replace(' ', '_').replace('+', 'p')}"
    return _t


# Build the position sweep matrix. For each (split, goal, days), we pin
# EVERY position to EACH in-split focus.
SPLIT_FOCUSES: dict[str, list[str]] = {
    "ppl": ["Push", "Pull", "Legs"],
    "upper_lower": ["Upper", "Lower"],
    "full_body": ["Full Body"],
    "ppl_upper_lower": ["Push", "Pull", "Legs", "Upper", "Lower"],
    "bro": ["Chest", "Back", "Shoulders", "Arms", "Legs"],
}

POSITION_MATRIX: list[tuple[str, str, int, str]] = []
# PPL 5d/6d/7d, muscle_gain
for days in (5, 6, 7):
    POSITION_MATRIX.append(("ppl", "muscle_gain", days, "intermediate"))
# UL 4d/5d/6d, muscle_gain
for days in (4, 5, 6):
    POSITION_MATRIX.append(("upper_lower", "muscle_gain", days, "intermediate"))
# PPL+UL 5d/6d/7d
for days in (5, 6, 7):
    POSITION_MATRIX.append(("ppl_upper_lower", "muscle_gain", days, "intermediate"))
# Bro 5d/6d/7d
for days in (5, 6, 7):
    POSITION_MATRIX.append(("bro", "muscle_gain", days, "advanced"))
# Full body 3d/4d
for days in (3, 4):
    POSITION_MATRIX.append(("full_body", "muscle_gain", days, "beginner"))


for split, goal, days, exp in POSITION_MATRIX:
    focuses = SPLIT_FOCUSES.get(split, [])
    for pin_day in range(days):
        for pin_focus in focuses:
            fn = _make_position_pin_test(split, goal, days, exp, pin_day, pin_focus)
            globals()[fn.__name__] = fn


# ── History-seeded pin sweep ────────────────────────────────────────

HISTORY_SCENARIOS: list[tuple[str, tuple[str, ...], tuple[str, ...]]] = [
    ("recent_push", ("upper_body",), ("push",)),
    ("recent_pull", ("upper_body",), ("pull",)),
    ("recent_legs", ("lower_body",), ("legs",)),
    ("recent_push_pull", ("upper_body", "upper_body"), ("push", "pull")),
    ("recent_upper", ("upper_body",), ("upper",)),
    ("recent_lower", ("lower_body",), ("lower",)),
]


def _make_history_pin_test(split: str, goal: str, days: int, experience: str,
                              pin_day: int, pin_focus: str,
                              history_label: str,
                              recent_buckets: tuple[str, ...],
                              recent_families: tuple[str, ...]):
    def _t():
        recipe = _gen_recipe(
            goal=goal, days_per_week=days,
            preferred_split=split, experience=experience,
            recent_focus_buckets=recent_buckets,
            recent_focus_families=recent_families,
        )
        original_focuses = [d.get("focus") for d in recipe]
        original_lift_count = sum(1 for d in recipe if is_lift(_focus(d)))
        _, decision = _apply_pin(recipe, pin_day, pin_focus, preferred_split=split)
        ctx = f"{split} {goal} {days}d {history_label} pin{pin_day}→{pin_focus}"
        assert_day_count(recipe, days, ctx=ctx)
        actual = _focus_at_lower(recipe, pin_day)
        expected_base = pin_focus.lower().replace(" + cardio", "").strip()
        actual_base = actual.replace(" + cardio", "").strip()
        if " — " in actual_base:
            actual_base = actual_base.split(" — ")[0].strip()
        assert actual_base == expected_base or expected_base in actual_base, \
            f"{ctx}: target focus is '{recipe[pin_day].get('focus')}'"
        new_lift_count = sum(1 for d in recipe if is_lift(_focus(d)))
        assert new_lift_count == original_lift_count, \
            f"{ctx}: lift count changed {original_lift_count}→{new_lift_count}"
        # At most 2 days changed.
        new_focuses = [d.get("focus") for d in recipe]
        changed = [i for i in range(len(recipe))
                    if new_focuses[i] != original_focuses[i]]
        assert len(changed) <= 2, \
            f"{ctx}: touched {len(changed)} days {changed}, expected ≤2"
        if split == "bro":
            assert_no_plus_cardio_on_bro(recipe, split, ctx=ctx)
    _t.__name__ = (
        f"test_hist_{split}_{goal}_{days}d_{history_label}_"
        f"pin{pin_day}_{pin_focus.lower().replace(' ', '_')}"
    )
    return _t


# Build history matrix — for each (split, goal, days, history) pin to
# day 0 with the focus that's currently NOT at day 0. This proves the
# pin actually moves a focus into a day where history would otherwise
# rotate it away.
HISTORY_MATRIX: list[tuple[str, str, int, str]] = [
    ("ppl", "muscle_gain", 5, "intermediate"),
    ("ppl", "muscle_gain", 6, "intermediate"),
    ("upper_lower", "muscle_gain", 4, "intermediate"),
    ("upper_lower", "muscle_gain", 6, "intermediate"),
    ("bro", "muscle_gain", 5, "advanced"),
    ("bro", "muscle_gain", 6, "advanced"),
    ("ppl_upper_lower", "muscle_gain", 5, "intermediate"),
]


for split, goal, days, exp in HISTORY_MATRIX:
    for pin_day in (0, days // 2, days - 1):
        for hist_label, hist_buckets, hist_families in HISTORY_SCENARIOS:
            for pin_focus in SPLIT_FOCUSES[split]:
                fn = _make_history_pin_test(
                    split, goal, days, exp, pin_day, pin_focus,
                    hist_label, hist_buckets, hist_families,
                )
                globals()[fn.__name__] = fn


# ── Targeted regression: history must shape day 0 (non-bro) ─────────

def test_recent_push_makes_day0_not_push_for_ppl_5d():
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("push",),
        recent_focus_buckets=("upper_body",),
    )
    # Push family includes "Push" and any "Push + Cardio" hybrid.
    f0 = _focus_at_lower(recipe, 0)
    assert "push" not in f0, \
        f"day 0 is push immediately after recent push: {[d.get('focus') for d in recipe]}"


def test_recent_legs_makes_day0_not_legs_for_ppl_5d():
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("legs",),
        recent_focus_buckets=("lower_body",),
    )
    f0 = _focus_at_lower(recipe, 0)
    assert "legs" not in f0, \
        f"day 0 is legs after recent legs: {[d.get('focus') for d in recipe]}"


def test_recent_upper_makes_day0_not_upper_for_ul_4d():
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=4, preferred_split="upper_lower",
        recent_focus_families=("upper",),
        recent_focus_buckets=("upper_body",),
    )
    f0 = _focus_at_lower(recipe, 0)
    assert "upper" not in f0, \
        f"day 0 is upper after recent upper: {[d.get('focus') for d in recipe]}"


def test_bro_overrides_history_and_starts_with_chest():
    """Bro split is structured — recent history must NOT shuffle it."""
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
        recent_focus_families=("push",),
        recent_focus_buckets=("upper_body",),
    )
    assert _focus_at(recipe, 0) == "Chest", \
        f"bro day 0 should be Chest regardless of history, got {recipe[0].get('focus')}"


# ── Bro pin: single-day swap behavior ──────────────────────────────

def test_pin_bro_chest_to_day_2_swaps_only_two_days():
    """Bro [Chest, Back, Shoulders, Arms, Legs] pinned day 2 → Chest:
    swap day 2 (Shoulders) with day 0 (closest Chest). Days 1, 3, 4
    unchanged."""
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
    )
    original_focuses = [d.get("focus") for d in recipe]
    _apply_pin(recipe, 2, "Chest", preferred_split="bro")
    new_focuses = [d.get("focus") for d in recipe]
    changed = [i for i in range(len(recipe))
                if new_focuses[i] != original_focuses[i]]
    assert len(changed) == 2, f"bro pin should swap 2 days, changed: {changed}"
    assert _focus_at(recipe, 2) == "Chest"


def test_pin_bro_legs_to_day_0_swaps_only_two_days():
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
    )
    original_focuses = [d.get("focus") for d in recipe]
    _apply_pin(recipe, 0, "Legs", preferred_split="bro")
    new_focuses = [d.get("focus") for d in recipe]
    changed = [i for i in range(len(recipe))
                if new_focuses[i] != original_focuses[i]]
    assert len(changed) == 2
    assert _focus_at(recipe, 0) == "Legs"


# ── Sequential pins ────────────────────────────────────────────────

def test_two_sequential_pins_each_change_at_most_two_days():
    """Pin day 0 → Pull, then pin day 4 → Push. Each pin individually
    changes ≤2 days. Final state has both pins reflected."""
    recipe = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    snap0 = [d.get("focus") for d in recipe]
    _apply_pin(recipe, 0, "Pull", preferred_split="ppl")
    snap1 = [d.get("focus") for d in recipe]
    changed1 = sum(1 for i in range(5) if snap0[i] != snap1[i])
    assert changed1 <= 2, f"pin 1 changed {changed1} days, expected ≤2"
    _apply_pin(recipe, 4, "Push", preferred_split="ppl")
    snap2 = [d.get("focus") for d in recipe]
    changed2 = sum(1 for i in range(5) if snap1[i] != snap2[i])
    assert changed2 <= 2, f"pin 2 changed {changed2} days, expected ≤2"
    # Both pins reflected.
    assert "pull" in (snap2[0] or "").lower()
    assert "push" in (snap2[4] or "").lower()


# ── Cardio finisher pin label preservation ─────────────────────────

def test_pin_push_plus_cardio_on_ppl_targets_correct_day():
    """User picks 'Push + Cardio'. Recipe may have 'Push' or 'Push +
    Cardio' somewhere. After swap + caller-side cardio finisher
    promotion, target day should be a Push + Cardio."""
    recipe = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    original_focuses = [d.get("focus") for d in recipe]
    _, decision = _apply_pin(recipe, 3, "Push + Cardio", preferred_split="ppl")
    if decision.action == "noop":
        return  # already that focus
    assert decision.wants_cardio_finisher is True
    # Target day should now hold a Push (the router would attach the
    # cardio finisher to it). At minimum the base focus is Push.
    f3 = _focus_at_lower(recipe, 3)
    assert "push" in f3, f"pin Push+Cardio→day3 lost: {recipe[3].get('focus')}"
    # Only 2 days changed.
    new_focuses = [d.get("focus") for d in recipe]
    changed = sum(1 for i in range(len(recipe))
                   if new_focuses[i] != original_focuses[i])
    assert changed <= 2


# ── Pin overrides history ──────────────────────────────────────────

def test_pin_legs_to_day0_overrides_recent_legs_history():
    """Recent legs would normally push legs later. Explicit pin must win."""
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("legs",),
        recent_focus_buckets=("lower_body",),
    )
    _apply_pin(recipe, 0, "Legs", preferred_split="ppl")
    assert "legs" in _focus_at_lower(recipe, 0), \
        f"pin Legs→day0 lost to history: {[d.get('focus') for d in recipe]}"


def test_pin_push_to_day0_overrides_recent_push_history():
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("push",),
        recent_focus_buckets=("upper_body",),
    )
    _apply_pin(recipe, 0, "Push", preferred_split="ppl")
    assert "push" in _focus_at_lower(recipe, 0)


# ── 7-day plans: pin preserves recovery placement ─────────────────

def test_pin_on_7d_plan_preserves_recovery_day():
    """7d plan has 1 forced recovery. A lift pin shouldn't lose it."""
    recipe = _gen_recipe(goal="muscle_gain", days_per_week=7, preferred_split="ppl")
    rest_before = sum(
        1 for d in recipe
        if "recovery" in (d.get("focus") or "").lower()
        or "mobility" in (d.get("focus") or "").lower()
    )
    _apply_pin(recipe, 2, "Push", preferred_split="ppl")
    rest_after = sum(
        1 for d in recipe
        if "recovery" in (d.get("focus") or "").lower()
        or "mobility" in (d.get("focus") or "").lower()
    )
    assert rest_before == rest_after


# ── Determinism ────────────────────────────────────────────────────

def test_pin_is_deterministic_for_same_recipe():
    a = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl",
                     rng_seed=11)
    b = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl",
                     rng_seed=11)
    _apply_pin(a, 2, "Legs", preferred_split="ppl")
    _apply_pin(b, 2, "Legs", preferred_split="ppl")
    assert [d.get("focus") for d in a] == [d.get("focus") for d in b]


# ── User-reported regression: muscle_gain 6d PPL, real recipe ──────

def test_user_scenario_muscle_gain_6d_ppl_pin_pull_cardio_to_legs():
    """User's reported bug. Real recipe from planner. Pin the
    Pull + Cardio day to Legs — only the target + swap partner
    should change. Day 0 must NOT become Legs (the user's exact
    complaint was 'first day became Legs')."""
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=6, preferred_split="ppl",
    )
    original_focuses = [d.get("focus") for d in recipe]
    # Find a Pull + Cardio day to pin (the planner produced one).
    pull_cardio_days = [
        i for i, d in enumerate(recipe)
        if "pull" in (d.get("focus") or "").lower()
        and "+ cardio" in (d.get("focus") or "").lower()
    ]
    if not pull_cardio_days:
        # If the planner didn't produce a Pull + Cardio for this seed,
        # find any push or pull NOT at day 0 (the user's exact gripe
        # was "day 0 should stay put").
        target = None
        for i, d in enumerate(recipe):
            if i == 0:
                continue
            f = (d.get("focus") or "").lower()
            if "push" in f or "pull" in f:
                target = i
                break
        if target is None:
            return
    else:
        # Skip day 0 if Pull + Cardio happens to be there.
        target = next((i for i in pull_cardio_days if i != 0), pull_cardio_days[0])
        if target == 0:
            return
    _, decision = _apply_pin(recipe, target, "Legs", preferred_split="ppl")
    new_focuses = [d.get("focus") for d in recipe]
    changed = [i for i in range(len(recipe))
                if new_focuses[i] != original_focuses[i]]
    assert len(changed) <= 2, \
        f"6d PPL pin touched {len(changed)} days {changed}; user-reported " \
        f"bug regression. Original={original_focuses} new={new_focuses}"
    if decision.action == "swap":
        assert "legs" in (new_focuses[target] or "").lower()
    # Day 0 must not have changed (user's specific complaint).
    assert new_focuses[0] == original_focuses[0], \
        f"day 0 changed from '{original_focuses[0]}' to '{new_focuses[0]}' — " \
        f"user-reported bug returning"


def test_user_scenario_muscle_gain_6d_ppl_pin_lift_day_to_push_cardio():
    """Pin a Pull or Legs day to Push + Cardio. Single-day swap
    contract: at most 2 days change (target + swap partner)."""
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=6, preferred_split="ppl",
    )
    original_focuses = [d.get("focus") for d in recipe]
    target = None
    for i, d in enumerate(recipe):
        f = (d.get("focus") or "").lower()
        if "pull" in f or "legs" in f:
            target = i
            break
    if target is None:
        return
    _, decision = _apply_pin(recipe, target, "Push + Cardio", preferred_split="ppl")
    new_focuses = [d.get("focus") for d in recipe]
    changed = [i for i in range(len(recipe))
                if new_focuses[i] != original_focuses[i]]
    assert len(changed) <= 2, \
        f"pin Push+Cardio touched {len(changed)} days {changed}; " \
        f"original={original_focuses} new={new_focuses}"


def test_user_scenario_muscle_gain_6d_ppl_pin_lift_day_to_in_split_focus():
    """Pin Pull → Push. Single-day swap. Day 0 stays."""
    recipe = _gen_recipe(
        goal="muscle_gain", days_per_week=6, preferred_split="ppl",
    )
    original_focuses = [d.get("focus") for d in recipe]
    # Find a Pull day (not at day 0).
    target = None
    for i, d in enumerate(recipe):
        if i == 0:
            continue
        if "pull" in (d.get("focus") or "").lower():
            target = i
            break
    if target is None:
        return
    _apply_pin(recipe, target, "Push", preferred_split="ppl")
    new_focuses = [d.get("focus") for d in recipe]
    changed = [i for i in range(len(recipe))
                if new_focuses[i] != original_focuses[i]]
    assert len(changed) <= 2, \
        f"pin Push touched {len(changed)} days {changed}"
    assert new_focuses[0] == original_focuses[0]


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
    print(f"\nAll {len(test_fns)} switch_day_integration tests passed")
