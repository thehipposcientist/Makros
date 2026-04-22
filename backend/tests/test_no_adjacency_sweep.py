"""Exhaustive sweep: every (goal, days, split, recent, fatigue, priority)
combination must not produce same-family adjacent days in the generated
weekly recipe.

Run standalone:
    docker exec thallo-backend python -m tests.test_no_adjacency_sweep

This is a diagnostic sweep — run it OUTSIDE of `run_all.py` so it doesn't
gate the main test suite (the main suite's 3-in-a-row test
`test_generate_weekly_recipe_never_emits_three_adjacent_split_days` covers
the weaker-but-always-enforced invariant).

Failures are printed with the exact input combination so they can be fed
into targeted regression tests.
"""
from __future__ import annotations

import sys
from typing import Optional

from app.services.workout.weekly_recipe import generate_weekly_recipe
from app.services.workout.goal_profiles import goal_profile_for
from app.services.workout.archetypes import archetype_to_focus_family
from app.services.workout.day_templates import (
    SPLIT_FULL_BODY, SPLIT_PPL, SPLIT_PPL_UL, SPLIT_UPPER_LOWER, SPLIT_BRO,
)


# Every goal id in the goal_profiles table, including special aliases.
_GOALS = [
    "muscle_gain", "strength", "body_recomp", "fat_loss", "maintain",
    "toning", "longevity", "flexibility", "stress_relief",
    "athletic_performance", "endurance", "hyrox", "general_health",
]

_DAYS = [3, 4, 5, 6, 7]

_SPLITS: list[Optional[str]] = [
    SPLIT_PPL, SPLIT_UPPER_LOWER, SPLIT_FULL_BODY, SPLIT_BRO, SPLIT_PPL_UL, None,
]

_RECENT_FAMILIES = [
    (),
    ("push",), ("pull",), ("legs",),
    ("upper",), ("lower",),
    ("push", "pull"),
    ("upper", "upper"),
    ("cardio",), ("mobility",), ("recovery",),
]

_USER_CHOSE_SPLIT = [True, False]

_MUSCLE_FATIGUE_CASES = [
    None,
    {"chest": 0.7},
    {"quads": 0.9, "hamstrings": 0.9, "glutes": 0.9},
    {"chest": 0.8, "back": 0.3},
]

_USER_AGES = [None, 35, 55, 65]


# Goal profiles whose recipes are INTENTIONALLY same-family-dominant
# (adjacency is by design — every day is cardio for endurance, every day
# is full_body for maintain/general_health, etc.). Whitelist them.
_ALL_FULL_BODY_GOALS = {
    "maintain",         # maintain profile alternates LIFT_FULL_BODY / Z2 / MOBILITY
    "general_health",   # same as maintain
    "longevity",        # routes to general_health profile
    "endurance",        # endurance recipe is cardio-dominated by design
}


# U/L collapse map — for U/L users, push/pull/chest/back/shoulders/arms
# all collapse to 'upper' when inspecting recent history via the coarse
# bucket path. The family-level adjacency check is already the fine path,
# so this test checks BOTH granularities.
_UL_COLLAPSE = {
    "push": "upper", "pull": "upper", "upper": "upper",
    "chest": "upper", "back": "upper", "shoulders": "upper", "arms": "upper",
    "legs": "lower", "lower": "lower",
    "cardio": "cardio", "mobility": "mobility",
    "recovery": "recovery", "full_body": "full_body",
}


def _check_adjacency(
    recipe_fams: list[str],
    *,
    collapse_ul: bool = False,
) -> Optional[tuple[int, str, str]]:
    """Return (index, left_fam, right_fam) of the first violation, or None.
    Ignores full_body→full_body pairs (goal families that only produce
    full_body are allowed to repeat — see `_ALL_FULL_BODY_GOALS`)."""
    fams = recipe_fams
    if collapse_ul:
        fams = [_UL_COLLAPSE.get(f, f) for f in fams]
    for i in range(1, len(fams)):
        a, b = fams[i - 1], fams[i]
        if a is None or b is None:
            continue
        if a != b:
            continue
        # full_body repeats are allowed (by design — every day is full_body)
        if a == "full_body":
            continue
        return (i, a, b)
    return None


def test_sweep_no_adjacent_same_family() -> None:
    """Exhaustive sweep. Captures every (goal, days, split, recent, fatigue,
    priority, user_chose_split) combination that yields adjacent same-family
    days and surfaces them so the planner maintainers can diagnose root cause.
    """
    print("\n[sweep] generate_weekly_recipe no-adjacency (all goals × days × splits)")
    checked = 0
    violations: list[dict] = []

    for goal in _GOALS:
        profile = goal_profile_for(goal)
        # For all-full-body goal profiles, adjacency is expected (every day
        # is full_body). Whitelist them.
        skip_adjacency = goal in _ALL_FULL_BODY_GOALS

        for days in _DAYS:
            for split in _SPLITS:
                for rfam in _RECENT_FAMILIES:
                    for uchose in _USER_CHOSE_SPLIT:
                        for mf in _MUSCLE_FATIGUE_CASES:
                            for age in _USER_AGES:
                                try:
                                    recipe = generate_weekly_recipe(
                                        profile, days,
                                        lifting_split=split,
                                        user_chose_split=uchose,
                                        recent_focus_families=rfam,
                                        muscle_fatigue=mf,
                                        user_age=age,
                                    )
                                except Exception as exc:
                                    violations.append({
                                        "kind": "EXCEPTION",
                                        "goal": goal, "days": days, "split": split,
                                        "recent": rfam, "uchose": uchose, "mf": mf,
                                        "age": age,
                                        "error": f"{type(exc).__name__}: {exc}",
                                    })
                                    continue

                                checked += 1
                                fams = [archetype_to_focus_family(a) for a in recipe]

                                if skip_adjacency:
                                    continue

                                # Fine-family adjacency (push ≠ pull ≠ legs)
                                v = _check_adjacency(fams, collapse_ul=False)
                                if v is not None:
                                    i, left, right = v
                                    violations.append({
                                        "kind": "FINE",
                                        "goal": goal, "days": days, "split": split,
                                        "recent": rfam, "uchose": uchose, "mf": mf,
                                        "age": age,
                                        "fams": fams,
                                        "at": i, "left": left, "right": right,
                                    })
                                    continue

                                # U/L-collapse adjacency (only relevant when the
                                # user is on an upper/lower split — but the
                                # family mapping already emits 'upper'/'lower'
                                # for LIFT_UPPER/LOWER archetypes, so the fine
                                # check usually catches this. Run anyway as a
                                # belt-and-suspenders pass.)
                                if split == SPLIT_UPPER_LOWER:
                                    v2 = _check_adjacency(fams, collapse_ul=True)
                                    if v2 is not None:
                                        i, left, right = v2
                                        violations.append({
                                            "kind": "UL_COLLAPSED",
                                            "goal": goal, "days": days, "split": split,
                                            "recent": rfam, "uchose": uchose, "mf": mf,
                                            "age": age,
                                            "fams": fams,
                                            "at": i, "left": left, "right": right,
                                        })

    print(f"  checked {checked} configurations")
    print(f"  violations: {len(violations)}")
    if violations:
        # Group by kind for easier reading.
        by_kind: dict[str, list[dict]] = {}
        for v in violations:
            by_kind.setdefault(v["kind"], []).append(v)
        for kind, items in by_kind.items():
            print(f"\n  ── kind={kind} ({len(items)}) ──")
            for v in items[:20]:
                if kind == "EXCEPTION":
                    print(
                        f"    goal={v['goal']} days={v['days']} split={v['split']} "
                        f"recent={v['recent']} uchose={v['uchose']} mf={v['mf']} "
                        f"age={v.get('age')}"
                        f"\n      err: {v['error']}"
                    )
                else:
                    print(
                        f"    goal={v['goal']} days={v['days']} split={v['split']} "
                        f"recent={v['recent']} uchose={v['uchose']} mf={v['mf']} "
                        f"age={v.get('age')} "
                        f"| at {v['at']}: {v['left']}→{v['right']}"
                        f"\n      fams: {v['fams']}"
                    )
            if len(items) > 20:
                print(f"    ... and {len(items) - 20} more")
    # This test is diagnostic — always finish with the counts.
    # If there are violations, exit non-zero so CI picks it up when
    # invoked standalone.
    assert not violations, f"{len(violations)} adjacency violations"


cases = [test_sweep_no_adjacent_same_family]


if __name__ == "__main__":
    failures = 0
    for case in cases:
        try:
            case()
            print(f"  PASS: {case.__name__}")
        except AssertionError as exc:
            print(f"  FAIL: {case.__name__}: {exc}")
            failures += 1
        except Exception as exc:
            print(f"  ERROR: {case.__name__}: {exc}")
            failures += 1
    sys.exit(1 if failures else 0)
