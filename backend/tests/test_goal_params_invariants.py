"""
Structural invariants for goal_params.py — NO external deps, no pytest.

These guard the *contract* of the goal-bucket config rather than specific
macro numbers (those live in test_calorie_calculator.py). They catch:
  - a pace map missing a pace key (silent KeyError → wrong default at runtime)
  - an inverted calorie clamp (low > high)
  - a goal-id lookup that stops falling back safely
  - a bucket constant becoming accidentally mutable
  - the target-weight path leaking past the weekly-rate safety clamps

Run from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_goal_params_invariants
"""
from __future__ import annotations

from app.services.nutrition.goal_params import (
    ATHLETIC,
    BODY_RECOMP,
    CALORIES_PER_LB,
    ENDURANCE,
    FAT_LOSS,
    GENERAL_HEALTH,
    GOAL_BUCKET_MAP,
    MAX_GAIN_RATE_LBS_PER_WEEK,
    MAX_GAIN_RATE_PCT_BW_PER_WEEK,
    MAX_LOSS_RATE_LBS_PER_WEEK,
    MUSCLE_GAIN,
    STRENGTH,
    get_bucket_for_goal,
)
from app.services.nutrition.calorie_calculator import CalorieInputs, compute_targets


ALL_BUCKETS = (
    FAT_LOSS, MUSCLE_GAIN, BODY_RECOMP, STRENGTH, ENDURANCE, ATHLETIC, GENERAL_HEALTH,
)
EXPECTED_PACES = {"conservative", "moderate", "aggressive"}

# Every per-pace mapping field a bucket may carry. None values are skipped.
_PACE_MAP_FIELDS = (
    "calorie_adjustment_by_pace",
    "calorie_adjustment_pct_by_pace",
    "pace_labels",
    "protein_per_lb_by_pace",
    "fat_percent_by_pace",
)


def test_every_pace_map_has_exactly_the_three_paces() -> None:
    for bucket in ALL_BUCKETS:
        for field_name in _PACE_MAP_FIELDS:
            mapping = getattr(bucket, field_name)
            if mapping is None:
                continue
            keys = set(mapping)
            if keys != EXPECTED_PACES:
                raise AssertionError(
                    f"{bucket.name}.{field_name} keys {sorted(keys)} "
                    f"!= {sorted(EXPECTED_PACES)}"
                )
    print(f"  ✓ all pace maps complete across {len(ALL_BUCKETS)} buckets")


def test_calorie_clamps_are_ordered() -> None:
    for bucket in ALL_BUCKETS:
        clamp = bucket.calorie_adjustment_clamp
        if clamp is None:
            continue
        low, high = clamp
        if low > high:
            raise AssertionError(f"{bucket.name} clamp inverted: {clamp}")
    print("  ✓ every calorie clamp is (low <= high)")


def test_unknown_and_empty_goals_fall_back_to_general_health() -> None:
    for goal in (None, "", "   ", "brand_new_client_goal_2027"):
        bucket = get_bucket_for_goal(goal)
        if bucket is not GENERAL_HEALTH:
            raise AssertionError(f"goal {goal!r} resolved to {bucket.name}, expected general_health")
    print("  ✓ unknown / empty / None goals fall back to general_health")


def test_representative_goal_ids_map_to_expected_buckets() -> None:
    expected = {
        "build_muscle": "muscle_gain",
        "lose_fat":     "fat_loss",
        "improve_squat": "strength",
        "train_5k":     "endurance",
        "improve_power": "athletic_performance",
        "sprint_speed": "athletic_performance",
        "body_recomp":  "body_recomp",
    }
    for goal_id, bucket_name in expected.items():
        got = get_bucket_for_goal(goal_id).name
        if got != bucket_name:
            raise AssertionError(f"{goal_id} → {got}, expected {bucket_name}")
    print(f"  ✓ {len(expected)} representative goal ids map correctly")


def test_every_mapped_value_is_a_known_bucket() -> None:
    # Identity membership, not a set: GoalBucketParams carries mapping fields
    # so instances are unhashable and can't go in a set.
    for goal_id, bucket in GOAL_BUCKET_MAP.items():
        if not any(bucket is known for known in ALL_BUCKETS):
            raise AssertionError(f"{goal_id} maps to an unknown bucket instance")
    print(f"  ✓ all {len(GOAL_BUCKET_MAP)} mapped goal ids point at known buckets")


def test_bucket_pace_maps_are_read_only() -> None:
    # __post_init__ wraps mapping fields in MappingProxyType, which raises
    # TypeError on item assignment. This guards against a shared constant
    # being mutated in place by a downstream caller.
    try:
        FAT_LOSS.calorie_adjustment_by_pace["moderate"] = 0  # type: ignore[index]
    except TypeError:
        print("  ✓ bucket pace maps reject in-place mutation")
        return
    raise AssertionError("expected FAT_LOSS.calorie_adjustment_by_pace to be read-only")


def test_target_weight_path_honors_gain_rate_clamp() -> None:
    # A muscle-gain user asking for an impossible +50 lb in 4 weeks must be
    # clamped to MAX_GAIN_RATE_LBS_PER_WEEK in the target-weight path.
    inputs = CalorieInputs(
        weight_lbs=150, height_feet=5, height_inches=10, age=30, gender="male",
        training_days_per_week=4, goal_id="build_muscle", pace="aggressive",
        target_weight_lbs=200, timeline_weeks=4,
    )
    expected_delta = round(MAX_GAIN_RATE_LBS_PER_WEEK * CALORIES_PER_LB / 7)
    got = compute_targets(inputs).goal_adjustment_kcal
    if got > expected_delta:
        raise AssertionError(
            f"gain delta {got} exceeds rate-clamped ceiling {expected_delta}"
        )
    print(f"  ✓ target-weight gain clamped to {got} cal/day (<= {expected_delta})")


def test_target_weight_path_honors_loss_rate_clamp() -> None:
    inputs = CalorieInputs(
        weight_lbs=220, height_feet=5, height_inches=10, age=30, gender="male",
        training_days_per_week=4, goal_id="lose_fat", pace="aggressive",
        target_weight_lbs=150, timeline_weeks=4,
    )
    floor_delta = -round(MAX_LOSS_RATE_LBS_PER_WEEK * CALORIES_PER_LB / 7)
    got = compute_targets(inputs).goal_adjustment_kcal
    if got < floor_delta:
        raise AssertionError(
            f"loss delta {got} below rate-clamped floor {floor_delta}"
        )
    print(f"  ✓ target-weight loss clamped to {got} cal/day (>= {floor_delta})")


def test_pace_path_caps_aggressive_surplus() -> None:
    # Big, very-active user on aggressive muscle gain: the raw pct surplus
    # (~0.11 * TDEE) exceeds the gain ceiling and must be rate-capped down to
    # it — this is the contradiction the pace-path clamp resolves.
    inputs = CalorieInputs(
        weight_lbs=240, height_feet=6, height_inches=2, age=30, gender="male",
        training_days_per_week=7, goal_id="build_muscle", pace="aggressive",
    )
    gain_lbs = min(MAX_GAIN_RATE_LBS_PER_WEEK, MAX_GAIN_RATE_PCT_BW_PER_WEEK * 240)
    cap = round(gain_lbs * CALORIES_PER_LB / 7)
    got = compute_targets(inputs).goal_adjustment_kcal
    if got != cap:
        raise AssertionError(f"pace-path surplus {got} not capped to {cap}")
    print(f"  ✓ pace-path aggressive bulk capped at {got} cal/day (== {cap})")


if __name__ == "__main__":
    print("=" * 60)
    print("Goal-params structural invariants")
    print("=" * 60)
    cases = [
        test_every_pace_map_has_exactly_the_three_paces,
        test_calorie_clamps_are_ordered,
        test_unknown_and_empty_goals_fall_back_to_general_health,
        test_representative_goal_ids_map_to_expected_buckets,
        test_every_mapped_value_is_a_known_bucket,
        test_bucket_pace_maps_are_read_only,
        test_target_weight_path_honors_gain_rate_clamp,
        test_target_weight_path_honors_loss_rate_clamp,
        test_pace_path_caps_aggressive_surplus,
    ]
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    print("=" * 60)
    if failures:
        print(f"  {failures} test(s) FAILED")
        raise SystemExit(1)
    print(f"  All {len(cases)} tests passed.")
    print("=" * 60)
