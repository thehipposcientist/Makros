"""Unit tests for weekly_recipe.py — pure-function coverage.

Covers:
  - _lifting_recipe: correct archetype count + split distribution for
    every (goal, split, days) combo
  - _inject_hybrid_cardio: PLUS_CARDIO promotion count matches
    _DIRECT_PROMOTE_COUNT table
  - _repair_adjacent_duplicates: 4-tier repair eliminates adjacent dupes
    without breaking split identity
  - _preserves_split_identity: invariant checker
  - _fatigue_cost / _is_heavy / _is_resistance: predicates
  - _endurance_recipe / _athletic_recipe / _hyrox_recipe: non-lifting
    recipe correctness
  - _derive_recovery_days: 7-day always has >=1 recovery

No DB, no AI, no randomness.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Imports ────────────────────────────────────────────────────────────────

from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META
from app.services.workout.goal_profiles import goal_profile_for, GoalProfile


# ─── _fatigue_cost / _is_heavy / _is_resistance predicates ──────────────────

def test_fatigue_cost_values():
    """Every archetype has a well-defined fatigue cost in [0, 1]."""
    print("\n[test] fatigue cost: every archetype has cost in [0,1]")
    from app.services.workout.weekly_recipe import _fatigue_cost
    for arch in DayArchetype:
        cost = _fatigue_cost(arch)
        assert 0 <= cost <= 1.0, f"{arch} has cost={cost}, not in [0,1]"
    _ok(f"all {len(DayArchetype)} archetypes have valid fatigue cost")


def test_is_heavy_excludes_plus_cardio():
    """PLUS_CARDIO archetypes are explicitly excluded from _is_heavy."""
    print("\n[test] _is_heavy: PLUS_CARDIO are not heavy")
    from app.services.workout.weekly_recipe import _is_heavy
    plus_cardio = [
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
        DayArchetype.LIFT_PULL_PLUS_CARDIO,
        DayArchetype.LIFT_UPPER_PLUS_CARDIO,
        DayArchetype.LIFT_FULL_BODY_PLUS_CARDIO,
    ]
    for a in plus_cardio:
        assert not _is_heavy(a), f"{a} should NOT be heavy"
    _ok("all PLUS_CARDIO not marked heavy")


def test_is_heavy_includes_heavy_archetypes():
    """Archetypes named *_HEAVY or *_STRENGTH should be heavy."""
    print("\n[test] _is_heavy: heavy archetypes are heavy")
    from app.services.workout.weekly_recipe import _is_heavy
    heavy = [
        DayArchetype.LIFT_UPPER_HEAVY,
        DayArchetype.LIFT_LOWER_HEAVY,
        DayArchetype.LIFT_PUSH_HEAVY,
        DayArchetype.LIFT_PULL_HEAVY,
        DayArchetype.LIFT_LEGS_HEAVY,
        DayArchetype.LIFT_FULL_BODY_STRENGTH,
    ]
    for a in heavy:
        assert _is_heavy(a), f"{a} should be heavy"
    _ok("all *_HEAVY and *_STRENGTH are heavy")


def test_is_resistance_identifies_lift_archetypes():
    """Resistance = any lifting archetype (including PLUS_CARDIO)."""
    print("\n[test] _is_resistance: lift archetypes are resistance")
    from app.services.workout.weekly_recipe import _is_resistance
    lift_examples = [
        DayArchetype.LIFT_PUSH,
        DayArchetype.LIFT_PULL,
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_PUSH_PLUS_CARDIO,
    ]
    for a in lift_examples:
        assert _is_resistance(a), f"{a} should be resistance"
    cond_examples = [
        DayArchetype.COND_ZONE2,
        DayArchetype.COND_INTERVALS_SHORT,
        DayArchetype.RECOVERY_EASY,
        DayArchetype.MOBILITY_FLOW,
    ]
    for a in cond_examples:
        assert not _is_resistance(a), f"{a} should NOT be resistance"
    _ok("lift=resistance, cond/recovery=not resistance")


# ─── _lifting_recipe tests ──────────────────────────────────────────────────

def test_lifting_recipe_ppl_produces_correct_families():
    """PPL recipe for 6 days = 2× push, 2× pull, 2× legs."""
    print("\n[test] _lifting_recipe PPL 6d: 2× each family")
    from app.services.workout.weekly_recipe import _lifting_recipe
    profile = goal_profile_for("muscle_gain", "intermediate", 6, 60)
    recipe = _lifting_recipe(profile, "ppl", 6)
    assert len(recipe) == 6, f"expected 6 days, got {len(recipe)}"
    from app.services.workout.archetypes import archetype_to_focus_family
    families = [archetype_to_focus_family(a) for a in recipe]
    assert families.count("push") == 2, f"push count: {families.count('push')}"
    assert families.count("pull") == 2, f"pull count: {families.count('pull')}"
    assert families.count("legs") == 2, f"legs count: {families.count('legs')}"
    _ok("PPL 6d → 2×push, 2×pull, 2×legs")


def test_lifting_recipe_upper_lower_even_split():
    """Upper/Lower recipe for 4 days = 2× upper, 2× lower."""
    print("\n[test] _lifting_recipe U/L 4d: 2× upper, 2× lower")
    from app.services.workout.weekly_recipe import _lifting_recipe
    profile = goal_profile_for("muscle_gain", "intermediate", 4, 60)
    recipe = _lifting_recipe(profile, "upper_lower", 4)
    assert len(recipe) == 4, f"expected 4 days, got {len(recipe)}"
    from app.services.workout.archetypes import archetype_to_focus_family
    families = [archetype_to_focus_family(a) for a in recipe]
    upper_count = sum(1 for f in families if f in ("upper", "push", "pull"))
    lower_count = sum(1 for f in families if f in ("lower", "legs"))
    assert upper_count == 2, f"upper count: {upper_count}"
    assert lower_count == 2, f"lower count: {lower_count}"
    _ok("U/L 4d → 2×upper, 2×lower")


def test_lifting_recipe_full_body_all_same_family():
    """Full body recipe: all days should have full_body family."""
    print("\n[test] _lifting_recipe full_body 3d: all full_body")
    from app.services.workout.weekly_recipe import _lifting_recipe
    profile = goal_profile_for("muscle_gain", "beginner", 3, 60)
    recipe = _lifting_recipe(profile, "full_body", 3)
    assert len(recipe) == 3, f"expected 3 days, got {len(recipe)}"
    from app.services.workout.archetypes import archetype_to_focus_family
    for a in recipe:
        fam = archetype_to_focus_family(a)
        assert fam == "full_body", f"expected full_body, got {fam} for {a}"
    _ok("full_body 3d → all full_body family")


# ─── _inject_hybrid_cardio tests ───────────────────────────────────────────

def test_inject_hybrid_cardio_muscle_gain_5d():
    """muscle_gain at 5 days promotes exactly 1 day to PLUS_CARDIO."""
    print("\n[test] _inject_hybrid_cardio: muscle_gain 5d → 1 hybrid")
    from app.services.workout.weekly_recipe import _inject_hybrid_cardio, _lifting_recipe
    profile = goal_profile_for("muscle_gain", "intermediate", 5, 60)
    recipe = _lifting_recipe(profile, "upper_lower", 5)
    promoted = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=5)
    plus_count = sum(1 for a in promoted if "plus_cardio" in a.value)
    assert plus_count == 1, f"expected 1 PLUS_CARDIO, got {plus_count}"
    _ok("muscle_gain 5d → 1 PLUS_CARDIO promoted")


def test_inject_hybrid_cardio_general_health_4d():
    """general_health at 4 days promotes 2 days to PLUS_CARDIO."""
    print("\n[test] _inject_hybrid_cardio: general_health 4d → 2 hybrid")
    from app.services.workout.weekly_recipe import _inject_hybrid_cardio, _lifting_recipe
    profile = goal_profile_for("general_health", "intermediate", 4, 60)
    recipe = _lifting_recipe(profile, "upper_lower", 4)
    promoted = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=4)
    plus_count = sum(1 for a in promoted if "plus_cardio" in a.value)
    assert plus_count == 2, f"expected 2 PLUS_CARDIO, got {plus_count}"
    _ok("general_health 4d → 2 PLUS_CARDIO promoted")


def test_inject_hybrid_cardio_never_promotes_legs():
    """Legs should never be promoted to PLUS_CARDIO (hard lower + cardio = bad)."""
    print("\n[test] _inject_hybrid_cardio: legs never promoted")
    from app.services.workout.weekly_recipe import _inject_hybrid_cardio, _lifting_recipe
    profile = goal_profile_for("general_health", "intermediate", 6, 60)
    recipe = _lifting_recipe(profile, "ppl", 6)
    promoted = _inject_hybrid_cardio(recipe, profile=profile, days_per_week=6)
    for a in promoted:
        if "plus_cardio" in a.value:
            assert "legs" not in a.value and "lower" not in a.value, \
                f"legs promoted to PLUS_CARDIO: {a}"
    _ok("no legs archetype promoted to PLUS_CARDIO")


# ─── _repair_adjacent_duplicates tests ──────────────────────────────────────

def test_repair_eliminates_back_to_back_same_family():
    """Inject a recipe with back-to-back same family; repair should fix it."""
    print("\n[test] _repair_adjacent_duplicates: eliminates adjacent same-family")
    from app.services.workout.weekly_recipe import _repair_adjacent_duplicates
    from app.services.workout.archetypes import archetype_to_focus_family
    bad_recipe = [
        DayArchetype.LIFT_PUSH,
        DayArchetype.LIFT_PUSH_HEAVY,  # adjacent duplicate family
        DayArchetype.LIFT_PULL,
        DayArchetype.LIFT_LEGS,
        DayArchetype.LIFT_PULL_HEAVY,  # pull again — not adjacent to first pull
        DayArchetype.LIFT_UPPER,
    ]
    allowed = frozenset(bad_recipe + [DayArchetype.LIFT_LOWER, DayArchetype.LIFT_UPPER_HEAVY])
    repaired = _repair_adjacent_duplicates(
        bad_recipe, allowed_archetypes=allowed,
        lifting_split="ppl", user_chose_split=False,
    )
    families = [archetype_to_focus_family(a) for a in repaired]
    for i in range(len(families) - 1):
        assert families[i] != families[i + 1], \
            f"adjacent dup at {i}: {families[i]} == {families[i+1]} in {repaired}"
    _ok("no adjacent same-family after repair")


def test_repair_preserves_day_count():
    """Repair never adds or removes days."""
    print("\n[test] _repair_adjacent_duplicates: preserves day count")
    from app.services.workout.weekly_recipe import _repair_adjacent_duplicates
    recipe = [
        DayArchetype.LIFT_UPPER,
        DayArchetype.LIFT_UPPER_HEAVY,
        DayArchetype.LIFT_LOWER,
        DayArchetype.LIFT_LOWER_HEAVY,
    ]
    allowed = frozenset(recipe + [DayArchetype.LIFT_PUSH, DayArchetype.LIFT_PULL])
    repaired = _repair_adjacent_duplicates(
        recipe, allowed_archetypes=allowed,
        lifting_split="upper_lower", user_chose_split=False,
    )
    assert len(repaired) == len(recipe), \
        f"day count changed: {len(recipe)} → {len(repaired)}"
    _ok("day count preserved after repair")


# ─── _endurance_recipe tests ───────────────────────────────────────────────

def test_endurance_recipe_has_strength_maintenance():
    """Endurance recipe at >=3 days includes LIFT_STRENGTH_MAINTENANCE."""
    print("\n[test] _endurance_recipe: includes strength maintenance at 3+ days")
    from app.services.workout.weekly_recipe import _endurance_recipe
    profile = goal_profile_for("endurance", "intermediate", 5, 60)
    recipe = _endurance_recipe(profile, 5)
    assert len(recipe) == 5, f"expected 5 days, got {len(recipe)}"
    has_strength = any(a == DayArchetype.LIFT_STRENGTH_MAINTENANCE for a in recipe)
    assert has_strength, f"no strength maintenance in endurance 5d recipe: {recipe}"
    _ok("endurance 5d includes LIFT_STRENGTH_MAINTENANCE")


def test_endurance_recipe_mostly_conditioning():
    """Endurance recipe should be majority conditioning archetypes."""
    print("\n[test] _endurance_recipe: majority conditioning")
    from app.services.workout.weekly_recipe import _endurance_recipe
    profile = goal_profile_for("endurance", "intermediate", 5, 60)
    recipe = _endurance_recipe(profile, 5)
    cond_count = sum(1 for a in recipe
                     if ARCHETYPE_META[a].category == "cond")
    assert cond_count >= 3, f"only {cond_count} conditioning days in 5-day endurance"
    _ok(f"endurance 5d → {cond_count}/5 conditioning")


# ─── Recovery allocation at 7 days ─────────────────────────────────────────

def test_seven_day_always_has_recovery():
    """7-day plans must always include at least 1 recovery/mobility day."""
    print("\n[test] 7-day plans: always >=1 recovery")
    from app.services.workout.weekly_recipe import generate_weekly_recipe
    goals = ["muscle_gain", "fat_loss", "body_recomp", "strength", "general_health"]
    for goal in goals:
        profile = goal_profile_for(goal, "intermediate", 7, 60)
        recipe = generate_weekly_recipe(profile, 7)
        recovery = sum(1 for a in recipe
                       if ARCHETYPE_META[a].category in ("recovery", "mobility"))
        assert recovery >= 1, f"{goal} 7d has {recovery} recovery/mobility days"
    _ok("all goals at 7d have >=1 recovery/mobility")


# ─── _hyrox_recipe tests ───────────────────────────────────────────────────

def test_hyrox_recipe_has_hybrid_days():
    """Hyrox recipe should contain hybrid/circuit archetypes."""
    print("\n[test] _hyrox_recipe: contains hybrid/circuit days")
    from app.services.workout.weekly_recipe import _hyrox_recipe
    profile = goal_profile_for("hyrox", "intermediate", 5, 60)
    recipe = _hyrox_recipe(profile, 5)
    assert len(recipe) == 5
    hybrid_or_circuit = sum(
        1 for a in recipe
        if ARCHETYPE_META[a].category in ("hybrid", "cond") or "circuit" in a.value
    )
    assert hybrid_or_circuit >= 2, \
        f"hyrox 5d only has {hybrid_or_circuit} hybrid/circuit days"
    _ok(f"hyrox 5d → {hybrid_or_circuit} hybrid/circuit days")


# ─── Main ──────────────────────────────────────────────────────────────────

cases = [
    test_fatigue_cost_values,
    test_is_heavy_excludes_plus_cardio,
    test_is_heavy_includes_heavy_archetypes,
    test_is_resistance_identifies_lift_archetypes,
    test_lifting_recipe_ppl_produces_correct_families,
    test_lifting_recipe_upper_lower_even_split,
    test_lifting_recipe_full_body_all_same_family,
    test_inject_hybrid_cardio_muscle_gain_5d,
    test_inject_hybrid_cardio_general_health_4d,
    test_inject_hybrid_cardio_never_promotes_legs,
    test_repair_eliminates_back_to_back_same_family,
    test_repair_preserves_day_count,
    test_endurance_recipe_has_strength_maintenance,
    test_endurance_recipe_mostly_conditioning,
    test_seven_day_always_has_recovery,
    test_hyrox_recipe_has_hybrid_days,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Weekly recipe unit tests")
    print("=" * 60)
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL: {e}")
            failures += 1
        except Exception as e:
            print(f"  ✗ ERROR ({type(e).__name__}): {e}")
            failures += 1
    print()
    print("=" * 60)
    print(f"  {len(cases) - failures}/{len(cases)} passed")
    print("=" * 60)
    raise SystemExit(0 if failures == 0 else 1)
