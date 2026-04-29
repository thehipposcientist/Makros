"""Exercise/equipment import contract tests.

The deterministic planner and swap picker both depend on the same
equipment language being used everywhere: seeded exercises, imported
wger exercises, and user-owned equipment. These tests catch drift in
that boundary before it becomes "why did this exercise disappear from
swaps?"

Run directly:  python3 -m tests.test_exercise_seed_equipment
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_seed_exercise_equipment_references_are_canonical() -> None:
    print("\n[test] seed exercise equipment references are canonical")
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES

    valid = {e["slug"] for e in SEED_EQUIPMENT}
    invalid: list[tuple[str, str]] = []
    for exercise in SEED_EXERCISES:
        for gear in exercise.get("equipment", []) or []:
            slug = gear.get("slug")
            if slug and slug not in valid:
                invalid.append((exercise.get("slug") or exercise.get("name") or "?", slug))

    assert not invalid, f"unknown equipment slugs: {invalid[:20]}"
    _ok(f"{sum(len(e.get('equipment', []) or []) for e in SEED_EXERCISES)} exercise-equipment refs valid")


def test_wger_import_equipment_map_uses_seed_slugs() -> None:
    print("\n[test] wger import equipment map emits planner-owned slugs")
    from app.seed_exercises_data import SEED_EQUIPMENT

    source = Path(__file__).parents[1] / "app" / "routers" / "ai" / "scanning.py"
    tree = ast.parse(source.read_text())
    mapping = None
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "_WGER_EQUIPMENT_MAP":
            mapping = ast.literal_eval(node.value)
            break
    assert isinstance(mapping, dict), "_WGER_EQUIPMENT_MAP not found"

    valid = {e["slug"] for e in SEED_EQUIPMENT} | {"bodyweight"}
    invalid = sorted({slug for slug in mapping.values() if slug not in valid})
    assert not invalid, f"wger map emits unknown slugs: {invalid}"

    cases = {
        "dumbbell": "dumbbells",
        "resistance band": "resistance_bands",
        "pull-up bar": "pull_up_bar",
        "swiss ball": "swiss_ball",
        "bench": "flat_bench",
        "": "bodyweight",
    }
    for raw, expected in cases.items():
        got = mapping[raw]
        assert got == expected, f"{raw} -> {got}, want {expected}"
    _ok(f"{len(mapping)} wger equipment mappings are canonical")


def test_required_equipment_preserves_multi_gear_requirements() -> None:
    print("\n[test] multi-gear exercises keep every required equipment slug")
    from app.seed_exercises_data import SEED_EXERCISES

    by_slug = {e["slug"]: e for e in SEED_EXERCISES}
    stability_press = by_slug["stability_ball_chest_press"]
    required = {
        gear["slug"]
        for gear in stability_press.get("equipment", [])
        if gear.get("required", True)
    }
    assert required == {"dumbbells", "swiss_ball"}, required
    _ok("stability_ball_chest_press requires both dumbbells + swiss_ball")


cases = [
    test_seed_exercise_equipment_references_are_canonical,
    test_wger_import_equipment_map_uses_seed_slugs,
    test_required_equipment_preserves_multi_gear_requirements,
]


def _run_all() -> int:
    failed = 0
    for t in cases:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {t.__name__} ({type(e).__name__}): {e}")
    print()
    print(f"{len(cases) - failed}/{len(cases)} passed" if failed == 0 else f"{failed} FAILED")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
