"""Pure-function tests for equipment-aware exercise video search queries.

Run:
    docker exec -it thallo-backend python -m tests.test_exercise_video_search
"""
from __future__ import annotations

from app.services.workout.video_resolver import (
    build_exercise_video_query,
    equipment_family_tokens,
    equipment_search_phrase,
)


def test_generic_loaded_name_gets_equipment_prefix() -> None:
    query = build_exercise_video_query("Sumo Squat", "dumbbells")
    assert query == "dumbbell Sumo Squat proper form tutorial", query
    print("PASS test_generic_loaded_name_gets_equipment_prefix")


def test_equipment_already_in_name_is_not_duplicated() -> None:
    query = build_exercise_video_query("Dumbbell Bench Press", "dumbbells")
    assert query == "Dumbbell Bench Press proper form tutorial", query
    print("PASS test_equipment_already_in_name_is_not_duplicated")


def test_broad_bucket_is_ignored() -> None:
    query = build_exercise_video_query("Hip Thrust", "gym")
    assert query == "Hip Thrust proper form tutorial", query
    print("PASS test_broad_bucket_is_ignored")


def test_concrete_slug_is_humanized_for_search() -> None:
    assert equipment_search_phrase("cable_machine") == "cable"
    assert equipment_search_phrase("single_cable_station") == "cable"
    assert equipment_search_phrase("dual_cable_station") == "cable"
    assert equipment_search_phrase("lat_pulldown_machine") == "lat pulldown machine"
    print("PASS test_concrete_slug_is_humanized_for_search")


def test_equipment_family_comes_from_equipment_context() -> None:
    assert not equipment_family_tokens("Sumo Squat")
    assert equipment_family_tokens("dumbbells") == equipment_family_tokens("Dumbbell Sumo Squat")
    print("PASS test_equipment_family_comes_from_equipment_context")


cases = [
    test_generic_loaded_name_gets_equipment_prefix,
    test_equipment_already_in_name_is_not_duplicated,
    test_broad_bucket_is_ignored,
    test_concrete_slug_is_humanized_for_search,
    test_equipment_family_comes_from_equipment_context,
]


if __name__ == "__main__":
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as exc:
            failures += 1
            print(f"FAIL {case.__name__}: {exc}")
    raise SystemExit(0 if failures == 0 else 1)
