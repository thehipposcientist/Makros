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


def test_cardio_backfill_equipment_is_concrete() -> None:
    print("\n[test] cardio backfill exercises use concrete equipment slugs")
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES

    equipment = {e["slug"] for e in SEED_EQUIPMENT}
    required = {
        "outdoor_bike",
        "skierg",
        "versaclimber",
        "heavy_bag",
        "ruck_pack",
    }
    assert required <= equipment, f"missing cardio equipment slugs: {sorted(required - equipment)}"

    by_slug = {e["slug"]: e for e in SEED_EXERCISES}
    cases = {
        "cycling_outdoor": "outdoor_bike",
        "rucking": "ruck_pack",
        "skierg": "skierg",
        "skierg_intervals": "skierg",
        "versaclimber": "versaclimber",
        "boxing_heavy_bag": "heavy_bag",
    }
    for exercise_slug, equipment_slug in cases.items():
        ex = by_slug[exercise_slug]
        slugs = {gear["slug"] for gear in ex.get("equipment", []) if gear.get("required", True)}
        assert equipment_slug in slugs, f"{exercise_slug} required {slugs}, want {equipment_slug}"
    _ok(f"{len(cases)} cardio exercises require concrete equipment")


def test_generate_cardio_day_uses_seeded_names() -> None:
    print("\n[test] generated cardio override days use seeded exercise names")
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import generate_cardio_day

    seeded_names = {e["name"] for e in SEED_EXERCISES}
    day = generate_cardio_day(
        45,
        "fat_loss",
        equipment_owned=["Stationary bike", "Jump rope"],
    )
    names = [ex["name"] for ex in day["exercises"]]
    missing = [name for name in names if name not in seeded_names]
    assert not missing, f"generated non-seeded cardio names: {missing}"
    assert "Stationary Bike Intervals" in names, names
    _ok(f"generated names are canonical: {names}")


def test_adjustable_dumbbells_unlock_dumbbell_library() -> None:
    print("\n[test] adjustable dumbbells unlock dumbbell exercises")
    from app.seed_exercises_data import SEED_EQUIPMENT

    by_name = {e["name"].lower(): e["slug"] for e in SEED_EQUIPMENT}
    assert by_name.get("adjustable dumbbells") == "adjustable_dumbbells"

    source = Path(__file__).parents[1] / "app" / "routers" / "ai" / "plans.py"
    text = source.read_text()
    assert '"adjustable_dumbbells" in owned' in text
    assert 'owned.add("dumbbells")' in text
    _ok("adjustable_dumbbells is canonical and aliases to dumbbells in planner filtering")


def test_strength_load_settings_snap_to_available_weights() -> None:
    print("\n[test] strength load settings snap to loadable weights")
    from app.services.workout.load_equipment import load_increment_lbs, snap_load_lbs

    dumbbell_settings = {
        "dumbbells": {
            "type": "adjustable",
            "minLbs": 5,
            "maxLbs": 50,
            "incrementLbs": 5,
        }
    }
    assert load_increment_lbs("Dumbbells", dumbbell_settings, fallback=2.5) == 5
    assert snap_load_lbs(52.5, "Dumbbells", dumbbell_settings, fallback_increment=5) == 50
    assert snap_load_lbs(17, "Dumbbells", dumbbell_settings, fallback_increment=5) == 15

    plate_settings = {"barbell": {"barWeightLbs": 45, "platePairsLbs": [10]}}
    assert load_increment_lbs("Barbell", plate_settings, fallback=5) == 20
    assert snap_load_lbs(146, "Barbell", plate_settings, fallback_increment=20) == 145
    assert snap_load_lbs(142.5, "Barbell", plate_settings, fallback_increment=20) == 125

    assert snap_load_lbs(82.5, "Cable machine", None, fallback_increment=5) == 82.5
    _ok("adjustable dumbbell, plate-loaded, and missing-setting paths behave")


def test_scan_equipment_list_covers_new_equipment_names() -> None:
    print("\n[test] equipment scan allowlist covers new canonical equipment names")
    source = Path(__file__).parents[1] / "app" / "routers" / "ai" / "scanning.py"
    tree = ast.parse(source.read_text())
    known_equipment = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if getattr(target, "id", None) == "known_equipment":
                    known_equipment = ast.literal_eval(node.value)
                    break
        if known_equipment is not None:
            break
    assert isinstance(known_equipment, list), "known_equipment not found"
    required = {
        "Adjustable dumbbells",
        "Outdoor bike",
        "SkiErg",
        "VersaClimber",
        "Heavy bag",
        "Ruck pack",
        "Plyo box (24\"+)",
    }
    missing = required - set(known_equipment)
    assert not missing, f"scan allowlist missing: {sorted(missing)}"
    _ok(f"{len(required)} new/exact equipment names present")


cases = [
    test_seed_exercise_equipment_references_are_canonical,
    test_wger_import_equipment_map_uses_seed_slugs,
    test_required_equipment_preserves_multi_gear_requirements,
    test_cardio_backfill_equipment_is_concrete,
    test_generate_cardio_day_uses_seeded_names,
    test_adjustable_dumbbells_unlock_dumbbell_library,
    test_strength_load_settings_snap_to_available_weights,
    test_scan_equipment_list_covers_new_equipment_names,
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
