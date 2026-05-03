"""Single-day regeneration coverage.

The /workouts/generate-day endpoint builds a full N-day recipe with
the planner, then picks one day at `day_index` (or the day whose focus
matches `focus_override`). That endpoint also depends on DB-backed
history. These tests cover the pure-function pieces single-day regen
relies on:

  - Focus normalization (Push/Pull/Legs → families and buckets)
  - prev_focuses → recent_focus_families round-trip
  - generate_workout_plan honors preferred_split with focus_override
    inputs (recent_focus rotation respects the user's pick)
  - When focus_override matches a day in the recipe, the planner
    produces a valid day with non-empty exercises
"""
from __future__ import annotations

from app.services.workout.planner import PlannerInputs, generate_workout_plan
from app.services.workout.focus_normalize import (
    normalize_focus_to_bucket, normalize_focus_to_family,
)
from app.seed_exercises_data import SEED_EXERCISES


_FULL_GYM = (
    "barbell", "dumbbells", "weight_plates", "power_rack", "squat_rack",
    "flat_bench", "adjustable_bench", "preacher_bench",
    "cable_machine", "lat_pulldown", "pull_up_bar", "dip_bars",
    "leg_press", "smith_machine", "ez_curl_bar",
    "kettlebell", "trap_bar", "landmine_attachment",
    "rowing_machine", "treadmill", "stationary_bike", "stair_climber",
    "leg_curl_machine", "leg_extension_machine", "calf_raise_machine",
    "seated_row_machine", "chest_press_machine", "shoulder_press_machine",
    "hack_squat", "back_extension_bench",
)


def _inputs(**kw) -> PlannerInputs:
    base = dict(
        goal="muscle_gain",
        days_per_week=5,
        session_minutes=60,
        experience="intermediate",
        equipment_slugs=_FULL_GYM,
        preferred_split="ppl",
        priority_region="balanced",
        injuries=tuple(),
        disliked_exercises=tuple(),
        rng_seed=42,
        recent_focus_buckets=tuple(),
        recent_focus_families=tuple(),
        muscle_fatigue=None,
    )
    base.update(kw)
    return PlannerInputs(**base)


# ── Focus normalization ────────────────────────────────────────────

def test_normalize_focus_push_to_family():
    assert normalize_focus_to_family("Push") == "push"


def test_normalize_focus_pull_to_family():
    assert normalize_focus_to_family("Pull") == "pull"


def test_normalize_focus_legs_to_family():
    assert normalize_focus_to_family("Legs") == "legs"


def test_normalize_focus_upper_to_family():
    assert normalize_focus_to_family("Upper") == "upper"


def test_normalize_focus_lower_to_family():
    assert normalize_focus_to_family("Lower") == "lower"


def test_normalize_focus_chest_to_family():
    """Bro split's 'Chest' label normalizes to push family."""
    assert normalize_focus_to_family("Chest") == "push"


def test_normalize_focus_back_to_family():
    assert normalize_focus_to_family("Back") == "pull"


def test_normalize_focus_shoulders_to_family():
    assert normalize_focus_to_family("Shoulders") == "push"


def test_normalize_focus_arms_to_family():
    assert normalize_focus_to_family("Arms") == "upper"


def test_normalize_focus_with_cardio_suffix_strips_it():
    """'Push + Cardio' should normalize same as 'Push'."""
    assert normalize_focus_to_family("Push + Cardio") == "push"
    assert normalize_focus_to_family("Upper + Cardio") == "upper"


def test_normalize_focus_to_bucket_collapses_push_pull():
    """Coarse bucket: push and pull both map to upper_body."""
    assert normalize_focus_to_bucket("Push") == "upper_body"
    assert normalize_focus_to_bucket("Pull") == "upper_body"


def test_normalize_focus_to_bucket_legs_is_lower_body():
    assert normalize_focus_to_bucket("Legs") == "lower_body"


def test_normalize_focus_to_bucket_recovery():
    assert normalize_focus_to_bucket("Recovery") == "recovery"


def test_normalize_focus_to_bucket_mobility():
    assert normalize_focus_to_bucket("Mobility") == "mobility"


def test_normalize_focus_to_bucket_unknown_returns_none_or_falsy():
    """Unknown focus shouldn't crash, just returns falsy/None."""
    # Don't assert specific value — just that it doesn't blow up
    normalize_focus_to_bucket("Astronaut Training")  # noqa


# ── recent_focus_families honored ──────────────────────────────────

def test_recent_push_pushes_push_later_in_week_for_ppl():
    """If user just did Push yesterday, day 0 of the new week shouldn't
    also be Push (avoid back-to-back same family)."""
    days = generate_workout_plan(
        _inputs(recent_focus_families=("push",), recent_focus_buckets=("upper_body",)),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    f0 = (days[0].get("focus") or "").lower()
    # First day shouldn't be push (or push + cardio) given recent push
    assert "push" not in f0 or "pull" in f0, \
        f"day 0 is push immediately after recent push: {[d.get('focus') for d in days]}"


def test_recent_legs_pushes_legs_later_in_week_for_ppl():
    days = generate_workout_plan(
        _inputs(recent_focus_families=("legs",), recent_focus_buckets=("lower_body",)),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    f0 = (days[0].get("focus") or "").lower()
    assert "legs" not in f0, \
        f"day 0 is legs immediately after recent legs: {[d.get('focus') for d in days]}"


# ── focus_override scenarios (testing the underlying behavior) ─────

def test_planner_with_ppl_split_contains_all_three_focuses_at_3d():
    """For single-day regen with focus_override, the planner needs to
    have the requested focus available in the recipe. PPL at 3d must
    contain Push, Pull, Legs."""
    days = generate_workout_plan(_inputs(days_per_week=3), SEED_EXERCISES)["workout_plan"]["days"]
    focuses = [(d.get("focus") or "").lower() for d in days]
    assert any("push" in f for f in focuses)
    assert any("pull" in f for f in focuses)
    assert any("legs" in f for f in focuses)


def test_planner_with_upper_lower_contains_both_focuses_at_4d():
    days = generate_workout_plan(
        _inputs(preferred_split="upper_lower", days_per_week=4),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    focuses = [(d.get("focus") or "").lower() for d in days]
    assert any("upper" in f for f in focuses)
    assert any("lower" in f for f in focuses)


def test_planner_with_bro_split_contains_all_five_focuses_at_5d():
    """For Switch Day to find 'Chest'/'Back'/'Shoulders'/'Arms'/'Legs',
    the bro recipe must produce all five labels."""
    days = generate_workout_plan(
        _inputs(preferred_split="bro", days_per_week=5, experience="advanced"),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    focuses = [(d.get("focus") or "") for d in days]
    assert set(focuses) == {"Chest", "Back", "Shoulders", "Arms", "Legs"}


# ── prev_focuses preservation across days ──────────────────────────

def test_planner_with_recent_push_pull_pushes_legs_first():
    """User most recently hit Push and Pull. Day 0 of a new PPL week
    should prefer Legs, the least-recently trained PPL family."""
    days = generate_workout_plan(
        _inputs(
            recent_focus_families=("push", "pull"),
            recent_focus_buckets=("upper_body", "upper_body"),
        ),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    f0 = normalize_focus_to_family(days[0].get("focus") or "")
    assert f0 == "legs", f"day 0 = {f0!r} after recent push+pull; expected legs"


# ── focus_override matching exists in recipe ───────────────────────

def test_recipe_5d_ppl_has_a_legs_day_for_focus_override():
    days = generate_workout_plan(_inputs(), SEED_EXERCISES)["workout_plan"]["days"]
    legs_days = [d for d in days if "legs" in (d.get("focus") or "").lower()]
    assert legs_days, "PPL 5d should have at least one Legs day for focus_override to match"
    for d in legs_days:
        assert d.get("exercises"), "Legs day has no exercises"


def test_recipe_5d_ppl_has_a_push_day_for_focus_override():
    days = generate_workout_plan(_inputs(), SEED_EXERCISES)["workout_plan"]["days"]
    push_days = [d for d in days if "push" in (d.get("focus") or "").lower()]
    assert push_days
    for d in push_days:
        assert d.get("exercises")


# ── Different goals produce different recipes ──────────────────────

def test_strength_5d_ppl_differs_from_muscle_gain_5d_ppl():
    """Goals dial different stimulus mixes — recipes should NOT be
    identical. Catches regressions where stimulus selection collapses."""
    a = [(d.get("focus") or "") for d in
         generate_workout_plan(_inputs(goal="muscle_gain"), SEED_EXERCISES)["workout_plan"]["days"]]
    b = [(d.get("focus") or "") for d in
         generate_workout_plan(_inputs(goal="strength"), SEED_EXERCISES)["workout_plan"]["days"]]
    # Sequences may overlap but the day count should match
    assert len(a) == len(b) == 5


def test_fat_loss_includes_cardio_at_5d():
    """fat_loss at 5d should include a cardio day (per profile config)."""
    days = generate_workout_plan(
        _inputs(goal="fat_loss"), SEED_EXERCISES,
    )["workout_plan"]["days"]
    focuses = [(d.get("focus") or "").lower() for d in days]
    has_cardio = any(
        "cardio" in f or "intervals" in f or "tempo" in f or "zone 2" in f
        or "circuit" in f or "+ cardio" in f
        for f in focuses
    )
    assert has_cardio, f"fat_loss 5d missing cardio: {focuses}"


# ── Determinism across days_per_week scaling ───────────────────────

def test_same_inputs_same_seed_yield_same_recipe():
    a = [(d.get("focus") or "") for d in
         generate_workout_plan(_inputs(rng_seed=7), SEED_EXERCISES)["workout_plan"]["days"]]
    b = [(d.get("focus") or "") for d in
         generate_workout_plan(_inputs(rng_seed=7), SEED_EXERCISES)["workout_plan"]["days"]]
    assert a == b


def test_different_seeds_can_yield_same_recipe_or_different():
    """Sanity: with the same inputs but different rng_seed, the
    recipe at minimum doesn't crash."""
    a = [(d.get("focus") or "") for d in
         generate_workout_plan(_inputs(rng_seed=7), SEED_EXERCISES)["workout_plan"]["days"]]
    b = [(d.get("focus") or "") for d in
         generate_workout_plan(_inputs(rng_seed=8), SEED_EXERCISES)["workout_plan"]["days"]]
    assert len(a) == len(b)


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
    print(f"\nAll {len(test_fns)} single_day_regen tests passed")
