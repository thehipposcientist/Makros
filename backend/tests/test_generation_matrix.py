"""Generation matrix sweep — every (split × goal × days/week) combo.

Each cell of the matrix runs `assert_full_recipe_valid` from
`_generation_contracts`, which checks:
  - Day count = days_per_week
  - Every lift day has exercises
  - No recovery at week start
  - 7-day plans include a rest day
  - Lift family distribution matches the split's contract
  - Cardio component meets the goal's minimum at this day count
  - Bro never contains PLUS_CARDIO (regression safety)

A single failed cell pinpoints (split, goal, days) — invaluable for
diagnosing which combination broke after an algorithm change.

The matrix dynamically generates one test function per cell so the
runner reports each one individually instead of bailing on first
failure. Each test name encodes the cell.
"""
from __future__ import annotations

from app.services.workout.planner import PlannerInputs, generate_workout_plan
from app.seed_exercises_data import SEED_EXERCISES
from tests._generation_contracts import (
    assert_full_recipe_valid,
    assert_split_distribution,
    assert_cardio_alignment,
    assert_no_plus_cardio_on_bro,
    assert_bro_canonical,
    assert_day_count,
    assert_no_rest_at_week_start,
    assert_seven_day_plan_has_rest,
    assert_every_lift_day_has_exercises,
    family_counts,
    cardio_dominant_count,
    plus_cardio_count,
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


def _gen(*, goal: str, days_per_week: int, preferred_split: str | None,
         experience: str = "intermediate", priority_region: str = "balanced",
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
        priority_region=priority_region,
        injuries=tuple(),
        disliked_exercises=tuple(),
        rng_seed=rng_seed,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=None,
    )
    return generate_workout_plan(inputs, SEED_EXERCISES)["workout_plan"]["days"]


# ── Matrix definition ──────────────────────────────────────────────

# Cells the planner is expected to handle. (split, goal, days_per_week,
# experience). Excludes invalid combinations:
#   - bro at <5 days (gated by _SPLIT_MIN_DAYS)
#   - PPL+UL at <5 days (gated)
#   - general_health on any preferred_split (it overrides to its own
#     Full Body + cardio program — not a bug, that's by design via
#     `_PROFILE_OVERRIDES`)
#   - endurance on a preferred_split (uses SPLIT_ENDURANCE program)
MATRIX: list[tuple[str, str, int, str]] = []

# Lifting goals that respect preferred_split.
LIFTING_GOALS = ("muscle_gain", "fat_loss", "body_recomp", "strength")

# PPL: 3-7 days
for days in (3, 4, 5, 6, 7):
    for goal in LIFTING_GOALS:
        MATRIX.append(("ppl", goal, days, "intermediate"))

# Upper/Lower: 2-7 days
for days in (2, 3, 4, 5, 6, 7):
    for goal in LIFTING_GOALS:
        MATRIX.append(("upper_lower", goal, days, "intermediate"))

# Full Body: 2-4 days (best frequency).
# Note: even with goal=muscle_gain etc., FB recipe may inject cardio
# days. The split contract only enforces full-body family on lift days.
for days in (2, 3, 4):
    for goal in ("muscle_gain", "fat_loss", "body_recomp"):
        MATRIX.append(("full_body", goal, days, "beginner"))

# PPL+UL: only 5+ days.
for days in (5, 6, 7):
    for goal in ("muscle_gain", "body_recomp"):
        MATRIX.append(("ppl_upper_lower", goal, days, "intermediate"))

# Bro: only muscle_gain at 5+ days, advanced (per `pick_split` rules).
for days in (5, 6, 7):
    MATRIX.append(("bro", "muscle_gain", days, "advanced"))

# Lower/Upper Focused: 3-7 days.
for days in (3, 4, 5, 6, 7):
    for goal in ("muscle_gain", "body_recomp"):
        MATRIX.append(("lower_focused", goal, days, "intermediate"))
        MATRIX.append(("upper_focused", goal, days, "intermediate"))


# ── Matrix sweep: one test per cell ────────────────────────────────

def _make_structural_test(split: str, goal: str, days: int, experience: str):
    """Structural matrix cell — day count, lift exercises, no rest at
    start, split distribution, bro canonical, no PLUS_CARDIO on bro.
    Cardio alignment is asserted in dedicated tests below."""
    def _cell_test():
        recipe = _gen(
            goal=goal, days_per_week=days,
            preferred_split=split, experience=experience,
        )
        assert_full_recipe_valid(
            recipe,
            split=split,
            goal=goal,
            days_per_week=days,
            ctx=f"split={split} goal={goal} days={days} exp={experience}",
            check_cardio=False,
        )
    _cell_test.__name__ = f"test_matrix_struct_{split}_{goal}_{days}d_{experience}"
    return _cell_test


def _make_cardio_test(split: str, goal: str, days: int, experience: str):
    """Cardio-alignment matrix cell. Separated from the structural
    sweep so a planner cardio-undershoot doesn't blanket the matrix
    with noise — the cardio cell name still pinpoints the (split,
    goal, days) combo where the planner under-delivered."""
    def _cardio_test():
        recipe = _gen(
            goal=goal, days_per_week=days,
            preferred_split=split, experience=experience,
        )
        from tests._generation_contracts import assert_cardio_alignment
        assert_cardio_alignment(
            recipe, goal, days, split,
            ctx=f"split={split} goal={goal} days={days} exp={experience}",
        )
    _cardio_test.__name__ = f"test_matrix_cardio_{split}_{goal}_{days}d_{experience}"
    return _cardio_test


# Inject one structural + one cardio test per matrix cell.
for split, goal, days, experience in MATRIX:
    s = _make_structural_test(split, goal, days, experience)
    c = _make_cardio_test(split, goal, days, experience)
    globals()[s.__name__] = s
    globals()[c.__name__] = c


# ── Targeted regression tests (always run) ─────────────────────────

def test_bro_5d_canonical_order_no_history():
    """Regression: bro split at 5d produces exact Chest→Back→Shoulders→
    Arms→Legs ordering with no PLUS_CARDIO downgrade."""
    recipe = _gen(goal="muscle_gain", days_per_week=5,
                   preferred_split="bro", experience="advanced")
    focuses = [d.get("focus") for d in recipe]
    assert focuses == ["Chest", "Back", "Shoulders", "Arms", "Legs"]


def test_bro_5d_canonical_order_with_recent_chest_history():
    """User just did Chest; bro must still come back canonical (the
    strict-split guard rebuilds if recent-focus rotation shuffled it)."""
    recipe = _gen(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
        recent_focus_families=("push",),
        recent_focus_buckets=("upper_body",),
    )
    focuses = [d.get("focus") for d in recipe if is_lift(_focus(d))]
    assert focuses == ["Chest", "Back", "Shoulders", "Arms", "Legs"]


def test_bro_6d_canonical_with_recent_history():
    """Bro is now CAPPED at 5 unique lifts (max-recovery contract).
    Extra days fill with rest/cardio, never a 6th lift duplicating
    a focus."""
    recipe = _gen(
        goal="muscle_gain", days_per_week=6, preferred_split="bro",
        experience="advanced",
        recent_focus_families=("push", "pull"),
    )
    focuses = [d.get("focus") for d in recipe if is_lift(_focus(d))]
    assert focuses == ["Chest", "Back", "Shoulders", "Arms", "Legs"]


def test_user_scenario_body_recomp_7d_bro_no_back_to_back_chest():
    """User's reported bug: body_recomp 7d bro produced
    [Chest, Back, Shoulders, Arms, Legs, Chest, Mobility] which the
    visual schedule rotation made look like
    [Chest, Mobility, Chest, Back, Shoulders, Arms, Legs] — chests
    only 1 rest day apart.

    Fix: cap bro at 5 unique lifts. body_recomp 7d bro now produces
    exactly 5 bro focuses + 1 cardio + 1 mobility (or similar). No
    duplicate focus → visual rotation can't create back-to-back."""
    recipe = _gen(
        goal="body_recomp", days_per_week=7, preferred_split="bro",
        experience="advanced",
    )
    focuses = [d.get("focus") for d in recipe]
    # All 5 bro muscles present.
    bro_muscles = {"Chest", "Back", "Shoulders", "Arms", "Legs"}
    present = bro_muscles & set(focuses)
    assert present == bro_muscles, \
        f"missing bro muscles: {bro_muscles - present}; got {focuses}"
    # No duplicate bro focus.
    bro_focuses_in_recipe = [f for f in focuses if f in bro_muscles]
    assert len(bro_focuses_in_recipe) == len(set(bro_focuses_in_recipe)), \
        f"duplicate bro focus: {focuses}"


def test_bro_7d_max_5_unique_lifts():
    """7-day bro: exactly 5 lift days (one per muscle), 2 non-lift days
    (recovery / cardio / mobility). No repeated focus."""
    recipe = _gen(
        goal="muscle_gain", days_per_week=7, preferred_split="bro",
        experience="advanced",
    )
    lift_focuses_in_order = [
        d.get("focus") for d in recipe if is_lift(_focus(d))
    ]
    assert lift_focuses_in_order == ["Chest", "Back", "Shoulders", "Arms", "Legs"]
    # No duplicate focus in lift days.
    assert len(set(lift_focuses_in_order)) == len(lift_focuses_in_order)


def test_muscle_gain_bro_5d_zero_plus_cardio():
    recipe = _gen(goal="muscle_gain", days_per_week=5,
                   preferred_split="bro", experience="advanced")
    assert plus_cardio_count(recipe) == 0


def test_muscle_gain_ppl_5d_has_at_least_one_plus_cardio():
    """Per `_DIRECT_PROMOTE_COUNT`."""
    recipe = _gen(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    assert plus_cardio_count(recipe) >= 1


def test_general_health_3d_has_at_least_one_cardio():
    recipe = _gen(goal="general_health", days_per_week=3, preferred_split="ppl")
    assert plus_cardio_count(recipe) + cardio_dominant_count(recipe) >= 1


def test_fat_loss_5d_has_two_cardio_components():
    """fat_loss conditioning_frac >= 0.30 → 2 cardio at 5+ days."""
    recipe = _gen(goal="fat_loss", days_per_week=5, preferred_split="ppl")
    assert plus_cardio_count(recipe) + cardio_dominant_count(recipe) >= 2


def test_body_recomp_5d_has_at_least_one_cardio_component():
    recipe = _gen(goal="body_recomp", days_per_week=5, preferred_split="ppl")
    assert plus_cardio_count(recipe) + cardio_dominant_count(recipe) >= 1


def test_endurance_4d_is_cardio_dominant():
    recipe = _gen(goal="endurance", days_per_week=4, preferred_split=None)
    cardio_total = cardio_dominant_count(recipe)
    assert cardio_total >= 2, \
        f"endurance plan should be cardio-heavy, got {cardio_total}: " \
        f"{[d.get('focus') for d in recipe]}"


def test_seven_day_muscle_gain_includes_recovery():
    recipe = _gen(goal="muscle_gain", days_per_week=7, preferred_split="ppl")
    has_recovery = any(
        "recovery" in _focus(d) or "mobility" in _focus(d) for d in recipe
    )
    assert has_recovery


def test_ppl_3d_is_one_each():
    recipe = _gen(goal="muscle_gain", days_per_week=3, preferred_split="ppl")
    counts = family_counts(recipe)
    assert counts == {"push": 1, "pull": 1, "legs": 1}


def test_ppl_6d_is_two_each():
    recipe = _gen(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    counts = family_counts(recipe)
    assert counts == {"push": 2, "pull": 2, "legs": 2}


def test_upper_lower_4d_is_balanced():
    recipe = _gen(goal="muscle_gain", days_per_week=4, preferred_split="upper_lower")
    counts = family_counts(recipe)
    assert counts.get("upper", 0) == 2
    assert counts.get("lower", 0) == 2


def test_upper_lower_6d_is_balanced():
    recipe = _gen(goal="muscle_gain", days_per_week=6, preferred_split="upper_lower")
    counts = family_counts(recipe)
    assert counts.get("upper", 0) == 3
    assert counts.get("lower", 0) == 3


def test_lower_focused_5d_has_more_lower_than_upper():
    recipe = _gen(goal="muscle_gain", days_per_week=5, preferred_split="lower_focused")
    counts = family_counts(recipe)
    assert counts.get("lower", 0) > counts.get("upper", 0)


def test_upper_focused_5d_has_more_upper_than_lower():
    recipe = _gen(goal="muscle_gain", days_per_week=5, preferred_split="upper_focused")
    counts = family_counts(recipe)
    assert counts.get("upper", 0) > counts.get("lower", 0)


def test_no_lift_day_is_empty_for_complex_splits():
    """Across all our complex splits at 5 days, every lift day has
    exercises. Catches equipment/library coverage issues."""
    for split in ("ppl", "upper_lower", "ppl_upper_lower", "bro"):
        exp = "advanced" if split == "bro" else "intermediate"
        recipe = _gen(goal="muscle_gain", days_per_week=5,
                       preferred_split=split, experience=exp)
        assert_every_lift_day_has_exercises(recipe, ctx=f"split={split}")


def test_planner_deterministic_with_seed():
    a = _gen(goal="muscle_gain", days_per_week=5, preferred_split="ppl", rng_seed=99)
    b = _gen(goal="muscle_gain", days_per_week=5, preferred_split="ppl", rng_seed=99)
    assert [d.get("focus") for d in a] == [d.get("focus") for d in b]


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
            print(f"  ✓ {name}")
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} generation_matrix tests passed")
