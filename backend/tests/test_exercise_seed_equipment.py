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
import re
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


def _planned_cardio_minutes(day: dict) -> int:
    total = 0
    for ex in day["exercises"]:
        reps = str(ex.get("reps") or "")
        minute_match = re.search(r"(\d+)\s*min", reps)
        if minute_match:
            total += int(minute_match.group(1))
            continue
        seconds_match = re.search(r"(\d+)\s*s", reps)
        if seconds_match:
            sets = int(ex.get("sets") or 1)
            rest = int(ex.get("restSeconds") or ex.get("rest_seconds") or 0)
            total += round((sets * int(seconds_match.group(1)) + max(0, sets - 1) * rest) / 60)
    return total


def test_generate_cardio_day_60_min_uses_explicit_blocks() -> None:
    print("\n[test] generated 60-min cardio day uses explicit session blocks")
    from app.services.workout.planner import generate_cardio_day

    day = generate_cardio_day(
        60,
        "body_recomp",
        equipment_owned=["Stationary bike", "Treadmill"],
    )
    roles = [ex.get("slot_role") for ex in day["exercises"]]
    reps = [ex.get("reps") for ex in day["exercises"]]

    assert roles == ["warmup", "primary", "secondary", "cooldown"], roles
    assert reps == ["5 min warm-up", "25 min", "25 min", "5 min cooldown"], reps
    assert _planned_cardio_minutes(day) == 60, day["exercises"]
    assert all("rest_seconds" not in ex for ex in day["exercises"]), day["exercises"]
    assert all("restSeconds" in ex for ex in day["exercises"]), day["exercises"]
    _ok(f"60-min cardio blocks: {list(zip(roles, reps))}")


def test_generate_cardio_day_bike_only_stays_on_bike() -> None:
    print("\n[test] generated bike-only cardio day does not split onto outdoor fallback")
    from app.services.workout.planner import generate_cardio_day

    day = generate_cardio_day(
        60,
        "body_recomp",
        equipment_owned=["Stationary bike"],
    )
    names = [ex["name"] for ex in day["exercises"]]
    equipment = [ex["equipment"] for ex in day["exercises"]]
    reps = [ex["reps"] for ex in day["exercises"]]

    assert names == ["Stationary Bike", "Bike Zone 2", "Stationary Bike"], names
    assert all(eq == "stationary_bike" for eq in equipment), day["exercises"]
    assert reps == ["5 min warm-up", "50 min", "5 min cooldown"], reps
    _ok(f"bike-only blocks: {list(zip(names, reps))}")


def test_generate_cardio_day_steady_contract_across_time_slots() -> None:
    print("\n[test] generated steady cardio day matches every session time slot")
    from app.services.workout.planner import generate_cardio_day

    checked = []
    for minutes in (20, 30, 45, 60, 75, 90, 120):
        day = generate_cardio_day(
            minutes,
            "body_recomp",
            equipment_owned=["Stationary bike", "Treadmill"],
        )
        roles = [ex.get("slot_role") for ex in day["exercises"]]
        primary_rows = [ex for ex in day["exercises"] if ex.get("slot_role") == "primary"]
        secondary_rows = [ex for ex in day["exercises"] if ex.get("slot_role") == "secondary"]

        assert roles[0] == "warmup", (minutes, roles)
        assert roles[-1] == "cooldown", (minutes, roles)
        assert len(primary_rows) == 1, (minutes, day["exercises"])
        assert _planned_cardio_minutes(day) == minutes, (minutes, day["exercises"])
        assert all("rest_seconds" not in ex for ex in day["exercises"]), (minutes, day["exercises"])
        assert all("restSeconds" in ex for ex in day["exercises"]), (minutes, day["exercises"])
        if minutes < 60:
            assert not secondary_rows, (minutes, day["exercises"])
        else:
            assert len(secondary_rows) == 1, (minutes, day["exercises"])
            assert primary_rows[0]["equipment"] != secondary_rows[0]["equipment"], (minutes, day["exercises"])
        checked.append((minutes, roles))

    _ok(f"steady slots checked: {checked}")


def test_generate_cardio_day_single_modality_contract_across_time_slots() -> None:
    print("\n[test] generated single-modality cardio day fills time without fallback split")
    from app.services.workout.planner import generate_cardio_day

    checked = []
    for minutes in (20, 30, 45, 60, 75, 90, 120):
        day = generate_cardio_day(
            minutes,
            "body_recomp",
            equipment_owned=["Stationary bike"],
        )
        roles = [ex.get("slot_role") for ex in day["exercises"]]
        equipment = [ex.get("equipment") for ex in day["exercises"]]

        assert roles == ["warmup", "primary", "cooldown"], (minutes, roles, day["exercises"])
        assert all(eq == "stationary_bike" for eq in equipment), (minutes, equipment, day["exercises"])
        assert _planned_cardio_minutes(day) == minutes, (minutes, day["exercises"])
        checked.append((minutes, [ex["reps"] for ex in day["exercises"]]))

    _ok(f"single-modality slots checked: {checked}")


def test_generate_cardio_day_interval_contract_across_time_slots() -> None:
    print("\n[test] generated interval cardio day matches every session time slot")
    from app.services.workout.planner import generate_cardio_day

    checked = []
    for minutes in (20, 30, 45, 60, 75, 90, 120):
        day = generate_cardio_day(
            minutes,
            "fat_loss",
            equipment_owned=["Stationary bike", "Treadmill", "Jump rope"],
        )
        roles = [ex.get("slot_role") for ex in day["exercises"]]
        primary_rows = [ex for ex in day["exercises"] if ex.get("slot_role") == "primary"]
        secondary_rows = [ex for ex in day["exercises"] if ex.get("slot_role") == "secondary"]

        assert roles[0] == "warmup", (minutes, roles)
        assert roles[-1] == "cooldown", (minutes, roles)
        assert len(primary_rows) == 1, (minutes, day["exercises"])
        assert primary_rows[0].get("prescriptionType") == "cardio_intervals", (minutes, primary_rows)
        assert primary_rows[0].get("sets", 0) > 1, (minutes, primary_rows)
        assert len(secondary_rows) <= 1, (minutes, day["exercises"])
        assert abs(_planned_cardio_minutes(day) - minutes) <= 1, (minutes, day["exercises"])
        if minutes >= 30:
            assert secondary_rows and "min easy" in secondary_rows[0]["reps"], (minutes, day["exercises"])
        checked.append((minutes, [(ex["slot_role"], ex["sets"], ex["reps"]) for ex in day["exercises"]]))

    _ok(f"interval slots checked: {checked}")


def test_generate_cardio_day_interval_goal_adds_flush_not_three_primaries() -> None:
    print("\n[test] generated interval cardio day uses intervals + easy flush")
    from app.services.workout.planner import generate_cardio_day

    day = generate_cardio_day(
        60,
        "fat_loss",
        equipment_owned=["Stationary bike", "Jump rope"],
    )
    primary_rows = [ex for ex in day["exercises"] if ex.get("slot_role") == "primary"]
    secondary_rows = [ex for ex in day["exercises"] if ex.get("slot_role") == "secondary"]
    names = [ex["name"] for ex in day["exercises"]]

    assert len(primary_rows) == 1, day["exercises"]
    assert primary_rows[0]["sets"] > 1, primary_rows[0]
    assert primary_rows[0].get("prescriptionType") == "cardio_intervals", primary_rows[0]
    assert secondary_rows and "min easy" in secondary_rows[0]["reps"], day["exercises"]
    assert "Stationary Bike Intervals" in names, names
    assert not all(ex.get("sets") == 1 and "30 min" in str(ex.get("reps")) for ex in day["exercises"]), day["exercises"]
    _ok(f"interval day blocks: {[(ex['name'], ex['sets'], ex['reps']) for ex in day['exercises']]}")


def test_adjustable_dumbbells_unlock_dumbbell_library() -> None:
    print("\n[test] adjustable dumbbells unlock dumbbell exercises")
    from app.services.workout.equipment import resolve_owned_equipment_slugs

    owned = resolve_owned_equipment_slugs(["Adjustable dumbbells"])
    assert "adjustable_dumbbells" in owned
    assert "dumbbells" in owned

    _ok("adjustable_dumbbells is canonical and aliases to dumbbells in planner filtering")


def test_planner_reachable_movement_patterns_are_enforced() -> None:
    print("\n[test] seeded movement patterns are reachable by planner slots")
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES
    from app.seed_exercises_validation import validate_exercise_seed

    report = validate_exercise_seed(SEED_EXERCISES, {e["slug"] for e in SEED_EQUIPMENT})
    assert report.planner_unreachable_pattern == 0
    dead_patterns = {"complex", "leg_curl", "rotation"}
    offenders = [
        (e.get("slug"), e.get("movement_pattern"))
        for e in SEED_EXERCISES
        if e.get("movement_pattern") in dead_patterns
    ]
    assert not offenders, f"planner-dead movement patterns remain: {offenders}"
    _ok("no exercise uses complex / leg_curl / rotation planner-dead patterns")


def test_support_dependent_moves_require_support_equipment() -> None:
    print("\n[test] support-dependent bodyweight-style moves require support gear")
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import _equipment_satisfied

    by_slug = {e["slug"]: e for e in SEED_EXERCISES}
    bodyweight_only = {"bodyweight", "yoga_mat"}
    required_support = {
        "chair_step_up": {"sturdy_chair"},
        "nordic_curl": {"nordic_anchor"},
        "reverse_nordic_curl": {"nordic_anchor"},
        "slider_hamstring_curl": {"slider_discs"},
        "hanging_knee_raise": {"pull_up_bar"},
        "weighted_pushup": {"weighted_vest"},
        "weighted_plank": {"weight_plates"},
    }
    for slug, owned in required_support.items():
        assert not _equipment_satisfied(by_slug[slug], bodyweight_only), f"{slug} should not be no-equipment eligible"
        assert _equipment_satisfied(by_slug[slug], bodyweight_only | owned), f"{slug} should unlock with {owned}"
    _ok(f"{len(required_support)} support-dependent moves are gated")


def test_pull_rear_delt_slots_have_candidates() -> None:
    print("\n[test] pull rear-delt slots retain rear-delt candidates")
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES
    from app.services.workout.planner import Slot, filter_candidates

    owned = {e["slug"] for e in SEED_EQUIPMENT}
    slot = Slot("Rear Delt", "isolation", "shoulders", "isolation")
    candidates = filter_candidates(
        SEED_EXERCISES,
        slot,
        owned,
        set(),
        day_focus_family="pull",
    )
    slugs = {ex["slug"] for ex in candidates}
    assert candidates, "pull rear-delt slot had no candidates"
    assert {"rear_delt_fly", "cable_rear_delt_fly"} & slugs, sorted(slugs)[:20]
    _ok(f"pull rear-delt slot has {len(candidates)} candidate(s)")


def test_primary_slots_prefer_primary_muscle_intent() -> None:
    print("\n[test] compound primary slots prefer their intended primary muscle")
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES
    from app.services.workout.planner import PlannerInputs, Slot, pick_for_slot

    pick = pick_for_slot(
        SEED_EXERCISES,
        Slot("Primary Press", "horizontal_press", "chest", "primary"),
        PlannerInputs(
            goal="muscle_gain",
            days_per_week=5,
            experience="intermediate",
            equipment_slugs=tuple(sorted(e["slug"] for e in SEED_EQUIPMENT)),
            rng_seed=12,
        ),
        set(),
        set(),
        day_focus_family="push",
    )
    assert pick is not None, "expected a chest primary press pick"
    assert pick["primary_muscle"] == "chest", pick
    assert pick["slug"] != "jm_press", pick
    _ok(f"primary press picked {pick['name']} instead of a triceps-primary press")


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
    assert snap_load_lbs(27.8, "Dumbbells", None, fallback_increment=2.5) == 30
    assert load_increment_lbs("Dumbbells", None, fallback=0) == 5.0

    plate_settings = {"barbell": {"barWeightLbs": 45, "platePairsLbs": [10]}}
    assert load_increment_lbs("Barbell", plate_settings, fallback=5) == 20
    assert snap_load_lbs(146, "Barbell", plate_settings, fallback_increment=20) == 145
    assert snap_load_lbs(142.5, "Barbell", plate_settings, fallback_increment=20) == 125

    assert snap_load_lbs(82.5, "Cable machine", None, fallback_increment=5) == 85
    assert snap_load_lbs(57.5, "T-bar", None, fallback_increment=5) == 60
    assert snap_load_lbs(22.5, "Dumbbells", None, fallback_increment=2.5) == 25
    _ok("adjustable dumbbell, plate-loaded, and missing-setting paths snap to usable loads")


def test_scan_equipment_list_covers_new_equipment_names() -> None:
    print("\n[test] equipment scan allowlist covers new canonical equipment names")
    source = Path(__file__).parents[1] / "app" / "routers" / "ai" / "scanning.py"
    text = source.read_text()
    assert 'known_equipment = [entry["name"] for entry in SEED_EQUIPMENT]' in text

    from app.seed_exercises_data import SEED_EQUIPMENT
    known_equipment = [entry["name"] for entry in SEED_EQUIPMENT]
    required = {
        "Bodyweight / no equipment",
        "Adjustable dumbbells",
        "Mini band (loop)",
        "Swiss / stability ball",
        "Step platform (low)",
        "Outdoor bike",
        "SkiErg",
        "VersaClimber",
        "Heavy bag",
        "Ruck pack",
        "Sturdy chair / low surface",
        "Nordic strap / foot anchor",
        "Plyo box (24\"+)",
        "Sandbag",
    }
    missing = required - set(known_equipment)
    assert not missing, f"scan allowlist missing: {sorted(missing)}"
    _ok(f"{len(required)} new/exact equipment names present")


def test_bodyweight_conditioning_replaces_generic_hiit_placeholder() -> None:
    print("\n[test] bodyweight conditioning uses concrete exercises")
    from app.seed_exercises_data import SEED_EXERCISES
    from app.services.workout.planner import PlannerInputs, Slot, pick_for_slot

    by_slug = {e["slug"]: e for e in SEED_EXERCISES}
    required = {
        "burpees",
        "mountain_climbers",
        "jumping_jacks",
        "high_knees",
        "butt_kicks",
        "fast_feet",
        "shadow_boxing",
        "plank_jacks",
        "squat_thrusts",
        "skater_hops",
        "line_hops",
    }
    missing = required - set(by_slug)
    assert not missing, f"missing no-equipment conditioning drills: {sorted(missing)}"
    assert by_slug["hiit_circuit"].get("deprecated") is True

    pick = pick_for_slot(
        SEED_EXERCISES,
        Slot("Circuit Cardio Burst", "cardio", None, "isolation"),
        PlannerInputs(
            goal="fat_loss",
            days_per_week=3,
            experience="beginner",
            equipment_slugs=("bodyweight",),
            rng_seed=9,
        ),
        set(),
        set(),
        accepts_types=frozenset({"cardio"}),
    )
    assert pick is not None, "expected a bodyweight cardio pick"
    assert pick["slug"] != "hiit_circuit", f"retired HIIT placeholder was selected: {pick}"
    assert pick["name"] != "HIIT Circuit"
    _ok(f"circuit cardio pick is concrete: {pick['name']}")


def test_active_exercise_names_avoid_generic_circuit_placeholders() -> None:
    print("\n[test] active exercise names avoid generic circuit placeholders")
    from app.seed_exercises_data import RETIRED_EXERCISE_SLUGS, SEED_EXERCISES

    generic_tokens = ("circuit", "routine", "workout", "conditioning")
    offenders = []
    for exercise in SEED_EXERCISES:
        if exercise.get("deprecated") or exercise.get("slug") in RETIRED_EXERCISE_SLUGS:
            continue
        name = str(exercise.get("name") or "").strip().lower()
        if any(token in name for token in generic_tokens):
            offenders.append((exercise.get("slug"), exercise.get("name")))

    assert not offenders, f"active exercises need concrete movement names: {offenders[:20]}"
    _ok("no active seed exercise uses a generic circuit/routine/workout label")


cases = [
    test_seed_exercise_equipment_references_are_canonical,
    test_wger_import_equipment_map_uses_seed_slugs,
    test_required_equipment_preserves_multi_gear_requirements,
    test_cardio_backfill_equipment_is_concrete,
    test_generate_cardio_day_uses_seeded_names,
    test_generate_cardio_day_60_min_uses_explicit_blocks,
    test_generate_cardio_day_bike_only_stays_on_bike,
    test_generate_cardio_day_steady_contract_across_time_slots,
    test_generate_cardio_day_single_modality_contract_across_time_slots,
    test_generate_cardio_day_interval_contract_across_time_slots,
    test_generate_cardio_day_interval_goal_adds_flush_not_three_primaries,
    test_adjustable_dumbbells_unlock_dumbbell_library,
    test_planner_reachable_movement_patterns_are_enforced,
    test_support_dependent_moves_require_support_equipment,
    test_pull_rear_delt_slots_have_candidates,
    test_primary_slots_prefer_primary_muscle_intent,
    test_strength_load_settings_snap_to_available_weights,
    test_scan_equipment_list_covers_new_equipment_names,
    test_bodyweight_conditioning_replaces_generic_hiit_placeholder,
    test_active_exercise_names_avoid_generic_circuit_placeholders,
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
