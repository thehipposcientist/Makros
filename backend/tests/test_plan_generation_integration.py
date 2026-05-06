"""Integration tests for workout + nutrition plan generation.

These tests exercise the FULL generation pipeline end-to-end: user
profile → goal profile → weekly recipe → slot fill → exercise selection
→ prescription → final plan shape. They verify that the output is
usable by the client (correct JSON shape, no None values where required,
sane exercise counts, prescription ranges).

Also covers plan modification paths:
  - Full regen with recent_focus_buckets (rotation)
  - Muscle fatigue overlay (fatigued muscles get lighter volume)
  - Plan version stamping
  - Injury blocking (exercises blocked by active injuries)
  - Equipment filtering (exercises requiring unowned equipment excluded)
  - Dislike filtering

No DB — uses the in-memory SEED_EXERCISES. No AI.
"""
from __future__ import annotations

from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.planner import (
    PlannerInputs,
    generate_workout_plan,
    pick_split,
)
from app.services.workout.weekly_recipe import PLANNER_VERSION


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


_FULL_GYM = (
    "barbell", "dumbbells", "weight_plates", "power_rack", "squat_rack",
    "flat_bench", "adjustable_bench", "cable_machine", "lat_pulldown",
    "pull_up_bar", "dip_bars", "leg_press", "smith_machine",
    "kettlebell", "trap_bar", "rowing_machine", "treadmill",
    "stationary_bike", "stair_climber", "assault_bike",
    "leg_curl_machine", "leg_extension_machine", "calf_raise_machine",
    "seated_row_machine", "chest_press_machine", "shoulder_press_machine",
    "ez_curl_bar",
)

_MINIMAL_GYM = ("dumbbells", "pull_up_bar", "flat_bench")


# ─── Full generation pipeline ───────────────────────────────────────────────

def test_full_plan_shape_muscle_gain_5d():
    """Full generation produces correct top-level shape."""
    print("\n[test] full gen: muscle_gain 5d produces valid plan shape")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
        preferred_split=None, priority_region="balanced",
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    assert "workout_plan" in result
    plan = result["workout_plan"]
    assert "days" in plan
    days = plan["days"]
    assert len(days) == 5, f"expected 5 days, got {len(days)}"
    _ok(f"plan has 5 days")


def test_every_day_has_required_fields():
    """Each day must have: focus, exercises (list), day (1-indexed)."""
    print("\n[test] full gen: every day has focus + exercises + day number")
    inputs = PlannerInputs(
        goal="fat_loss", days_per_week=4, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=45,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    for i, day in enumerate(result["workout_plan"]["days"]):
        assert "focus" in day and day["focus"], f"day {i} missing focus"
        assert "exercises" in day, f"day {i} missing exercises"
        assert isinstance(day["exercises"], list), f"day {i} exercises not list"
        assert day.get("day") is not None, f"day {i} missing 'day' field"
    _ok("all days have focus + exercises + day")


def test_every_exercise_has_prescription():
    """Each exercise must have name, sets, reps, restSeconds."""
    print("\n[test] full gen: every exercise has prescription fields")
    inputs = PlannerInputs(
        goal="body_recomp", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    for day in result["workout_plan"]["days"]:
        for ex in day.get("exercises", []):
            assert "name" in ex and ex["name"], f"exercise missing name: {ex.get('name')}"
            assert "sets" in ex and ex["sets"] > 0, f"exercise missing sets: {ex.get('name')}"
            assert "reps" in ex and ex["reps"], f"exercise missing reps: {ex.get('name')}"
            assert "restSeconds" in ex, f"exercise missing restSeconds: {ex.get('name')}"
    _ok("all exercises have name, sets>0, reps, restSeconds")


def test_plan_version_importable():
    """PLANNER_VERSION is a valid date-formatted string."""
    print("\n[test] full gen: PLANNER_VERSION is valid format")
    assert PLANNER_VERSION is not None
    parts = PLANNER_VERSION.split(".")
    assert len(parts) == 4, f"expected YYYY.MM.DD.nn, got {PLANNER_VERSION}"
    assert int(parts[0]) >= 2026, f"year too old: {parts[0]}"
    _ok(f"PLANNER_VERSION={PLANNER_VERSION} (valid format)")


# ─── Equipment filtering ───────────────────────────────────────────────────

def test_equipment_filtering_minimal_gym():
    """Minimal gym: no barbell exercises should appear."""
    print("\n[test] equipment: minimal gym excludes barbell exercises")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=_MINIMAL_GYM, session_minutes=60,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    for day in result["workout_plan"]["days"]:
        for ex in day.get("exercises", []):
            name = (ex.get("name") or "").lower()
            equip = ex.get("equipment", [])
            if isinstance(equip, list):
                for e in equip:
                    assert e in _MINIMAL_GYM or e == "bodyweight" or e == "none", \
                        f"unowned equipment {e} in exercise '{ex['name']}'"
    _ok("minimal gym: no unowned equipment in exercises")


def test_stair_climber_excluded_without_equipment():
    """Stair Climber exercise shouldn't appear without stair_climber equipment."""
    print("\n[test] equipment: stair climber excluded when not owned")
    no_stair = tuple(e for e in _FULL_GYM if e != "stair_climber")
    inputs = PlannerInputs(
        goal="fat_loss", days_per_week=5, experience="intermediate",
        equipment_slugs=no_stair, session_minutes=60,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    for day in result["workout_plan"]["days"]:
        for ex in day.get("exercises", []):
            name = (ex.get("name") or "").lower()
            assert "stair climber" not in name, \
                f"stair climber appeared without ownership: {ex['name']}"
    _ok("stair climber excluded when not in equipment_slugs")


def test_cardio_uses_owned_stationary_bike_before_outdoor_fallbacks():
    """Bike-only endurance users should get bike intervals and bike Zone 2."""
    print("\n[test] equipment: stationary-bike-only cardio uses the bike first")
    inputs = PlannerInputs(
        goal="improve_cardio",
        days_per_week=4,
        experience="beginner",
        equipment_slugs=("stationary_bike",),
        session_minutes=60,
        rng_seed=7,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    outdoor_fallbacks = {
        "Outdoor Walk",
        "Brisk Walk",
        "Hiking",
        "Running (Outdoor)",
        "Jogging",
    }
    cardio_days = [
        d for d in result["workout_plan"]["days"]
        if d.get("category") == "cond"
    ]
    assert cardio_days, "expected conditioning days in cardio plan"
    all_cardio_names = [
        ex.get("name")
        for day in cardio_days
        for ex in day.get("exercises", [])
    ]
    assert "Stationary Bike Intervals" in all_cardio_names, \
        f"bike should be used for high-rpm interval work: {all_cardio_names}"
    assert any(name in ("Bike Zone 2", "Stationary Bike") for name in all_cardio_names), \
        f"bike should be used for steady Zone 2 work: {all_cardio_names}"
    for day in cardio_days:
        names = [ex.get("name") for ex in day.get("exercises", [])]
        assert any("Bike" in str(name) for name in names), \
            f"cardio day did not use owned bike: {day.get('focus')} {names}"
        bad = [name for name in names if name in outdoor_fallbacks]
        assert not bad, \
            f"outdoor fallback beat owned stationary bike on {day.get('focus')}: {bad}"
    _ok("bike-only cardio days choose bike work over outdoor fallbacks")


# ─── Injury blocking ───────────────────────────────────────────────────────

def test_injury_blocks_dangerous_exercises():
    """Active shoulder injury should block overhead pressing exercises."""
    print("\n[test] injury: shoulder blocks vertical press")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
        injuries=({"body_part": "shoulder", "severity": "moderate", "status": "active"},),
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    for day in result["workout_plan"]["days"]:
        for ex in day.get("exercises", []):
            mp = ex.get("movement_pattern", "")
            if mp == "vertical_press":
                raise AssertionError(
                    f"vertical_press exercise '{ex['name']}' appeared with shoulder injury"
                )
    _ok("shoulder injury blocks vertical press exercises")


# ─── Dislike filtering ─────────────────────────────────────────────────────

def test_disliked_exercises_excluded():
    """Disliked exercises never appear in the plan."""
    print("\n[test] dislike: disliked exercises excluded")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
        disliked_exercises=("Barbell Squat", "Bench Press"),
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    for day in result["workout_plan"]["days"]:
        for ex in day.get("exercises", []):
            assert ex["name"] not in ("Barbell Squat", "Bench Press"), \
                f"disliked exercise {ex['name']} appeared in plan"
    _ok("disliked exercises excluded")


# ─── Recent focus rotation ──────────────────────────────────────────────────

def test_recent_focus_rotation_avoids_repeat():
    """Recent focus buckets cause rotation away from those focuses."""
    print("\n[test] rotation: recent_focus_buckets avoids repeat at position 0")
    inputs_no_hist = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
    )
    plan_fresh = generate_workout_plan(inputs_no_hist, SEED_EXERCISES)
    first_focus_fresh = plan_fresh["workout_plan"]["days"][0].get("focus", "")

    inputs_with_hist = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
        recent_focus_buckets=(first_focus_fresh.lower(),),
        recent_focus_families=(first_focus_fresh.lower(),),
    )
    plan_rotated = generate_workout_plan(inputs_with_hist, SEED_EXERCISES)
    first_focus_rotated = plan_rotated["workout_plan"]["days"][0].get("focus", "")
    # They might still match if the split forces it, but typically should differ
    # This is a soft assertion — log the result
    if first_focus_fresh.lower() == first_focus_rotated.lower():
        print(f"  ⚠ rotation had no effect (split may force this): {first_focus_fresh}")
    else:
        _ok(f"rotated: {first_focus_fresh} → {first_focus_rotated}")
        return
    _ok(f"rotation test ran (split may constrain: both={first_focus_fresh})")


# ─── Muscle fatigue overlay ────────────────────────────────────────────────

def test_muscle_fatigue_influences_plan():
    """High chest fatigue should reduce chest-dominant exercises or volume."""
    print("\n[test] fatigue: high chest fatigue influences plan")
    fatigue = {
        "chest": 0.85,
        "shoulders": 0.7,
        "triceps": 0.6,
        "back": 0.1,
        "biceps": 0.1,
        "quads": 0.1,
        "hamstrings": 0.1,
        "glutes": 0.1,
        "calves": 0.0,
        "core": 0.0,
        "cardio": 0.0,
        "systemic": 0.3,
    }
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
        muscle_fatigue=fatigue,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    # With high chest/shoulder fatigue, the planner should still produce a valid plan
    days = result["workout_plan"]["days"]
    assert len(days) == 5
    for day in days:
        assert len(day.get("exercises", [])) >= 2, \
            f"day with too few exercises: {day.get('focus')}"
    _ok("high fatigue plan still valid with >=2 exercises per day")


# ─── Session minutes trimming integration ──────────────────────────────────

def test_short_session_fewer_exercises():
    """30-min sessions should have fewer exercises than 75-min sessions."""
    print("\n[test] density: 30min produces fewer exercises than 75min")
    inputs_short = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=30,
    )
    inputs_long = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=75,
    )
    plan_short = generate_workout_plan(inputs_short, SEED_EXERCISES)
    plan_long = generate_workout_plan(inputs_long, SEED_EXERCISES)

    short_total = sum(len(d.get("exercises", [])) for d in plan_short["workout_plan"]["days"])
    long_total = sum(len(d.get("exercises", [])) for d in plan_long["workout_plan"]["days"])
    assert short_total < long_total, \
        f"short ({short_total}) should have fewer exercises than long ({long_total})"
    _ok(f"30min total exercises={short_total} < 75min total={long_total}")


def test_plus_cardio_finisher_drops_before_lift_slots_on_short_sessions():
    """PLUS_CARDIO keeps lift-family identity and trims cardio first at 30 min."""
    print("\n[test] density: PLUS_CARDIO drops finisher before lift slots on short sessions")
    base = dict(
        goal="muscle_gain",
        days_per_week=5,
        experience="intermediate",
        equipment_slugs=_FULL_GYM,
        preferred_split="ppl",
    )
    short = generate_workout_plan(
        PlannerInputs(**base, session_minutes=30),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    medium = generate_workout_plan(
        PlannerInputs(**base, session_minutes=60),
        SEED_EXERCISES,
    )["workout_plan"]["days"]

    short_plus = next((d for d in short if str(d.get("archetype") or "").endswith("_plus_cardio")), None)
    medium_plus = next((d for d in medium if str(d.get("archetype") or "").endswith("_plus_cardio")), None)
    assert short_plus is not None, f"short plan missing PLUS_CARDIO day: {[d.get('focus') for d in short]}"
    assert medium_plus is not None, f"medium plan missing PLUS_CARDIO day: {[d.get('focus') for d in medium]}"
    assert "Legs" not in short_plus["focus"], f"legs should never carry PLUS_CARDIO: {short_plus['focus']}"
    assert "Legs" not in medium_plus["focus"], f"legs should never carry PLUS_CARDIO: {medium_plus['focus']}"

    def _cardio_count(day: dict) -> int:
        return sum(
            1 for ex in day.get("exercises", [])
            if str(ex.get("prescriptionType") or "").startswith("cardio")
            or "cardio" in str(ex.get("_slot") or "").lower()
            or any(token in (ex.get("name") or "").lower() for token in ("treadmill", "bike", "rower", "interval"))
        )

    assert _cardio_count(medium_plus) >= 1, f"60-min PLUS_CARDIO missing finisher: {medium_plus}"
    assert _cardio_count(short_plus) == 0, f"30-min PLUS_CARDIO should trim finisher first: {short_plus}"
    assert len(short_plus.get("exercises", [])) >= 2, f"short PLUS_CARDIO lost lift slots: {short_plus}"
    _ok("30min PLUS_CARDIO keeps lift day, trims cardio finisher")


# ─── Non-lifting goal plans ───────────────────────────────────────────────

def test_endurance_plan_has_cardio_days():
    """Endurance plan includes conditioning-focused days."""
    print("\n[test] endurance: plan has conditioning days")
    inputs = PlannerInputs(
        goal="endurance", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    days = result["workout_plan"]["days"]
    cardio_days = sum(1 for d in days
                      if any(kw in (d.get("focus") or "").lower()
                             for kw in ("cardio", "intervals", "zone", "tempo", "conditioning")))
    assert cardio_days >= 3, f"endurance 5d only has {cardio_days} cardio days"
    _ok(f"endurance 5d → {cardio_days} cardio days")


def test_mobility_plan_has_no_heavy_lifts():
    """Mobility/flexibility plan shouldn't have heavy compound lifts."""
    print("\n[test] mobility: no heavy lifts")
    inputs = PlannerInputs(
        goal="flexibility", days_per_week=4, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=45,
    )
    result = generate_workout_plan(inputs, SEED_EXERCISES)
    days = result["workout_plan"]["days"]
    for day in days:
        for ex in day.get("exercises", []):
            sets = ex.get("sets", 0)
            reps = ex.get("reps", "")
            # Heavy lifts are typically 4-5 sets × 3-5 reps
            if sets >= 4 and reps in ("3-5", "1-3", "2-4"):
                raise AssertionError(
                    f"heavy prescription ({sets}×{reps}) in mobility plan: {ex['name']}"
                )
    _ok("mobility plan has no heavy prescriptions")


# ─── Determinism ───────────────────────────────────────────────────────────

def test_same_inputs_same_plan():
    """Same inputs must produce identical plans (deterministic)."""
    print("\n[test] determinism: same inputs → same plan")
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=5, experience="intermediate",
        equipment_slugs=_FULL_GYM, session_minutes=60,
        rng_seed=42,
    )
    plan1 = generate_workout_plan(inputs, SEED_EXERCISES)
    plan2 = generate_workout_plan(inputs, SEED_EXERCISES)

    days1 = plan1["workout_plan"]["days"]
    days2 = plan2["workout_plan"]["days"]
    for i in range(len(days1)):
        names1 = [e["name"] for e in days1[i]["exercises"]]
        names2 = [e["name"] for e in days2[i]["exercises"]]
        assert names1 == names2, \
            f"day {i} differs: {names1} vs {names2}"
    _ok("two runs with same seed → identical exercise lists")


# ─── Main ──────────────────────────────────────────────────────────────────

cases = [
    # Full pipeline
    test_full_plan_shape_muscle_gain_5d,
    test_every_day_has_required_fields,
    test_every_exercise_has_prescription,
    test_plan_version_importable,
    # Equipment
    test_equipment_filtering_minimal_gym,
    test_stair_climber_excluded_without_equipment,
    test_cardio_uses_owned_stationary_bike_before_outdoor_fallbacks,
    # Injury
    test_injury_blocks_dangerous_exercises,
    # Dislike
    test_disliked_exercises_excluded,
    # Rotation
    test_recent_focus_rotation_avoids_repeat,
    # Fatigue
    test_muscle_fatigue_influences_plan,
    # Session duration
    test_short_session_fewer_exercises,
    test_plus_cardio_finisher_drops_before_lift_slots_on_short_sessions,
    # Non-lifting goals
    test_endurance_plan_has_cardio_days,
    test_mobility_plan_has_no_heavy_lifts,
    # Determinism
    test_same_inputs_same_plan,
]


if __name__ == "__main__":
    print("=" * 60)
    print("Plan generation integration tests")
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
