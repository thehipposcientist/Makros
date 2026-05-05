"""Signup goal matcher guardrails."""
from __future__ import annotations

import sys


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_default_signup_goal_match_ids_are_limited_to_signup_options() -> None:
    print("\n[test] default signup goal matcher ids are signup-visible only")
    from app.routers.ai.scanning import _goal_match_allowed_ids

    allowed = _goal_match_allowed_ids()

    assert "build_muscle" in allowed
    assert "body_recomp" in allowed
    assert "train_5k" in allowed
    assert "train_marathon" in allowed
    assert "build_glutes" not in allowed
    assert "cycling_endurance" not in allowed
    assert "powerlifting" not in allowed
    assert "stress_exercise" not in allowed
    _ok(f"{len(allowed)} signup goal ids exposed to matcher")


def test_deterministic_match_maps_specific_requests_to_available_parents() -> None:
    print("\n[test] deterministic signup matcher maps unavailable specifics to parents")
    from app.routers.ai.scanning import _deterministic_goal_match

    assert _deterministic_goal_match("I want bigger glutes")["goal_id"] == "build_muscle"
    assert _deterministic_goal_match("I want to get better at cycling")["goal_id"] == "improve_cardio"
    assert _deterministic_goal_match("I want to train powerlifting")["goal_id"] == "build_strength"
    _ok("specific unavailable goal requests map to visible signup goals")


def test_custom_available_goal_ids_hard_constrain_results() -> None:
    print("\n[test] custom available goal ids hard-constrain matcher output")
    from app.routers.ai.scanning import _deterministic_goal_match

    result = _deterministic_goal_match("I want to train for a marathon", ["improve_cardio"])

    assert result["goal_id"] == "improve_cardio"
    _ok("marathon request collapses to available cardio parent when race chip is unavailable")


cases = [
    test_default_signup_goal_match_ids_are_limited_to_signup_options,
    test_deterministic_match_maps_specific_requests_to_available_parents,
    test_custom_available_goal_ids_hard_constrain_results,
]


if __name__ == "__main__":
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as exc:
            failures += 1
            print(f"FAIL {case.__name__}: {exc}", file=sys.stderr)
    if failures:
        sys.exit(1)
    print("\nPASS test_goal_matcher")
