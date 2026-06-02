"""Pure-function tests for the adaptive hydration target.

Covers:
  - bodyweight-only baseline (180 lb → 90 oz, no addons)
  - missing bodyweight → fallback floor
  - very high bodyweight → ceil clamp engages
  - very low bodyweight → floor clamp engages
  - 60 min moderate workout adds ~16 oz
  - 90 min heavy workout adds ~36 oz (capped at 40)
  - intensity inferred from duration ≥90 min when bucket not passed
  - intensity inferred from active_energy_kcal ≥700 when bucket not passed
  - active-energy add-on layered on top of training
  - activity metadata differentiates mobility from intervals at same duration
  - protein/alcohol add-ons remain layered onto the adaptive target
  - ambient temp >85°F adds heat layer; missing temp is a no-op
  - reason string only fires when an add-on is non-zero
  - structured response shape contains all expected keys

Run manually:
    docker exec thallo-backend python -m tests.test_hydration_target
"""
from __future__ import annotations

from app.services.nutrition.hydration import compute_hydration_target_oz


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ── Baseline ────────────────────────────────────────────────────────


def test_baseline_180_lb_no_workout() -> None:
    print("\n[test] 180 lb, no workout → 90 oz baseline only")
    out = compute_hydration_target_oz(bodyweight_lb=180.0)
    assert out["baseline_oz"] == 90, out
    assert out["training_addon_oz"] == 0, out
    assert out["active_energy_addon_oz"] == 0, out
    assert out["heat_addon_oz"] == 0, out
    assert out["target_oz"] == 90, out
    assert out["reason"] is None, out
    _ok("180 × 0.5 = 90 oz, no add-ons, reason None")


def test_missing_bodyweight_uses_fallback() -> None:
    print("\n[test] missing bodyweight → fallback baseline 80 oz")
    out = compute_hydration_target_oz(bodyweight_lb=None)
    assert out["baseline_oz"] == 80, out
    assert out["target_oz"] == 80, out
    _ok("fallback 80 oz when no profile weight")


def test_zero_bodyweight_uses_fallback() -> None:
    print("\n[test] bodyweight=0 → fallback baseline (defensive)")
    out = compute_hydration_target_oz(bodyweight_lb=0.0)
    assert out["baseline_oz"] == 80, out
    _ok("0 lb treated as missing, fallback engaged")


def test_very_high_bodyweight_clamps_to_ceiling() -> None:
    print("\n[test] 400 lb baseline clamps at 140 oz ceiling")
    out = compute_hydration_target_oz(bodyweight_lb=400.0)
    # 400 × 0.5 = 200 → clamped to 140
    assert out["baseline_oz"] == 140, out
    assert out["target_oz"] == 140, out
    _ok("ceiling clamp prevents linear scaling beyond 140 oz")


def test_very_low_bodyweight_clamps_to_floor() -> None:
    print("\n[test] 90 lb baseline clamps at 55 oz floor")
    out = compute_hydration_target_oz(bodyweight_lb=90.0)
    # 90 × 0.5 = 45 → clamped to 55
    assert out["baseline_oz"] == 55, out
    _ok("floor clamp keeps small users at viable hydration target")


# ── Training add-on ─────────────────────────────────────────────────


def test_60min_moderate_workout_adds_about_16oz() -> None:
    print("\n[test] 180 lb + 60 min moderate workout → ~106 oz (90 + 16)")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=60,
        workout_intensity="moderate",
    )
    assert out["baseline_oz"] == 90, out
    assert out["training_addon_oz"] == 16, out
    assert out["target_oz"] == 106, out
    assert 105 <= out["target_oz"] <= 110, out
    assert out["reason"] is not None and "moderate" in out["reason"].lower(), out
    _ok("16 oz added for a moderate hour, reason includes 'moderate'")


def test_90min_heavy_workout_adds_within_window() -> None:
    print("\n[test] 180 lb + 90 min heavy workout → ~126 oz (90 + 36)")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=90,
        workout_intensity="heavy",
    )
    assert out["baseline_oz"] == 90, out
    # 90/60 × 24 = 36 oz training addon
    assert out["training_addon_oz"] == 36, out
    assert 115 <= out["target_oz"] <= 130, out
    _ok("90 min × heavy = 36 oz add-on, total 126 oz, in expected window")


def test_light_workout_adds_less_than_moderate() -> None:
    print("\n[test] 60 min light/recovery → smaller add-on than moderate")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=60,
        workout_intensity="light",
    )
    assert out["training_addon_oz"] == 10, out
    assert out["target_oz"] == 100, out
    _ok("light 60 min = 10 oz add-on")


def test_training_addon_is_capped() -> None:
    print("\n[test] 240 min heavy workout → training add-on caps at 40 oz")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=240,
        workout_intensity="heavy",
    )
    # 240/60 × 24 = 96 → capped at 40
    assert out["training_addon_oz"] == 40, out
    _ok("training cap holds at 40 oz no matter the duration")


def test_zero_duration_no_training_addon() -> None:
    print("\n[test] duration=0 with intensity given → no training add-on")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=0,
        workout_intensity="heavy",
    )
    assert out["training_addon_oz"] == 0, out
    _ok("intensity alone with no duration does not add hydration")


# ── Intensity inference (when bucket not provided) ──────────────────


def test_intensity_inferred_heavy_from_duration() -> None:
    print("\n[test] no intensity passed, duration=90 → inferred heavy")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=90,
    )
    # 90 × 24/60 = 36 if heavy, 24 if moderate. Should be 36.
    assert out["training_addon_oz"] == 36, out
    _ok("≥90 min duration triggers heavy bucket inference")


def test_intensity_inferred_heavy_from_active_kcal() -> None:
    print("\n[test] no intensity, 60 min, active_energy=750 → inferred heavy")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=60,
        active_energy_kcal=750,
    )
    # 60 × 24/60 = 24 (heavy), training-wise. Plus 14 oz active addon.
    assert out["training_addon_oz"] == 24, out
    assert out["active_energy_addon_oz"] == 14, out
    _ok("≥700 active kcal triggers heavy bucket; active-energy addon also fires")


# ── Active energy add-on ────────────────────────────────────────────


def test_high_active_calories_adds_extra() -> None:
    print("\n[test] active_energy=750 kcal → +14 oz active-energy addon")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        active_energy_kcal=750,
    )
    assert out["active_energy_addon_oz"] == 14, out
    assert out["target_oz"] == 90 + 14, out
    _ok("750 kcal active → +14 oz")


def test_very_high_active_calories_adds_more() -> None:
    print("\n[test] active_energy=1100 kcal → +20 oz active-energy addon")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        active_energy_kcal=1100,
    )
    assert out["active_energy_addon_oz"] == 20, out
    _ok("≥1000 kcal active → +20 oz")


def test_low_active_calories_no_addon() -> None:
    print("\n[test] active_energy=400 kcal → no addon")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        active_energy_kcal=400,
    )
    assert out["active_energy_addon_oz"] == 0, out
    _ok("under 700 kcal does not trigger sweat-proxy add-on")


# ── Heat add-on ─────────────────────────────────────────────────────


def test_hot_day_adds_heat_layer() -> None:
    print("\n[test] ambient=88°F → +14 oz heat addon")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        ambient_temp_f=88.0,
    )
    assert out["heat_addon_oz"] == 14, out
    assert out["target_oz"] == 90 + 14, out
    assert out["reason"] is not None and "warm" in out["reason"].lower(), out
    _ok("amber heat band fires +14 oz with warm-conditions reason")


def test_extreme_heat_adds_more() -> None:
    print("\n[test] ambient=98°F → +20 oz heat addon")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        ambient_temp_f=98.0,
    )
    assert out["heat_addon_oz"] == 20, out
    _ok("red heat band (>95°F) → +20 oz")


def test_cool_day_no_heat_addon() -> None:
    print("\n[test] ambient=70°F → no heat addon")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        ambient_temp_f=70.0,
    )
    assert out["heat_addon_oz"] == 0, out
    _ok("temperate ambient does not bump hydration")


def test_missing_ambient_is_skipped_not_failed() -> None:
    print("\n[test] ambient=None → heat addon=0, calc proceeds")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        ambient_temp_f=None,
    )
    assert out["heat_addon_oz"] == 0, out
    assert out["target_oz"] == 90, out
    _ok("missing temp does not block computation")


# ── Combined / response shape ───────────────────────────────────────


def test_all_addons_stack_into_target() -> None:
    print("\n[test] heavy 75 min + 800 active kcal + 90°F → all three layers stack")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=75,
        workout_intensity="heavy",
        active_energy_kcal=800,
        ambient_temp_f=90.0,
    )
    # 75/60 × 24 = 30 oz training; 800 kcal → 14 oz active; 90°F → 14 oz heat
    assert out["training_addon_oz"] == 30, out
    assert out["active_energy_addon_oz"] == 14, out
    assert out["heat_addon_oz"] == 14, out
    assert out["target_oz"] == 90 + 30 + 14 + 14, out
    assert out["reason"] is not None, out
    _ok("training + active + heat all layered into a single target")


def test_response_shape_contains_required_keys() -> None:
    print("\n[test] return dict has every documented key")
    out = compute_hydration_target_oz(bodyweight_lb=180.0)
    expected = {
        "target_oz", "target_min_oz", "target_max_oz", "baseline_oz", "training_addon_oz",
        "active_energy_addon_oz", "heat_addon_oz", "reason",
    }
    assert expected.issubset(out.keys()), (expected - out.keys())
    # Numeric keys must be ints so the response JSON is stable.
    for k in expected - {"reason"}:
        assert isinstance(out[k], int), (k, out[k])
    _ok("response shape stable; numeric fields are ints")


def test_target_range_wraps_adapted_midpoint() -> None:
    print("\n[test] hydration range wraps the adapted midpoint")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=60,
        workout_intensity="moderate",
    )
    assert out["target_oz"] == 106, out
    assert out["target_min_oz"] <= out["target_oz"] <= out["target_max_oz"], out
    assert out["target_min_oz"] == 92, out
    assert out["target_max_oz"] == 120, out
    _ok("range is derived after bodyweight + workout adaptation")


def test_aliased_intensity_strings_are_accepted() -> None:
    print("\n[test] 'hard'/'easy' aliases map to heavy/light")
    hard = compute_hydration_target_oz(
        bodyweight_lb=180.0, workout_duration_min=60, workout_intensity="hard"
    )
    easy = compute_hydration_target_oz(
        bodyweight_lb=180.0, workout_duration_min=60, workout_intensity="easy"
    )
    assert hard["training_addon_oz"] == 24, hard  # mapped to heavy
    assert easy["training_addon_oz"] == 10, easy  # mapped to light
    _ok("string aliases route to the right intensity bucket")


def test_activity_metadata_prevents_flat_duration_targets() -> None:
    print("\n[test] same duration can hydrate differently by activity type")
    mobility = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=60,
        activity_category="mobility",
        stimulus="mobility",
    )
    intervals = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        workout_duration_min=60,
        activity_category="cardio",
        cardio_style="intervals",
        stimulus="conditioning",
    )
    assert mobility["training_addon_oz"] == 10, mobility
    assert intervals["training_addon_oz"] == 24, intervals
    assert intervals["target_oz"] > mobility["target_oz"], (mobility, intervals)
    _ok("mobility stays light while intervals get the heavy training add-on")


def test_protein_and_alcohol_addons_layer_on_target() -> None:
    print("\n[test] protein and alcohol add-ons are explicit target layers")
    out = compute_hydration_target_oz(
        bodyweight_lb=180.0,
        protein_g_today=200,
        alcohol_servings_today=2,
    )
    assert out["baseline_oz"] == 90, out
    assert out["protein_addon_oz"] == 8, out
    assert out["alcohol_addon_oz"] == 24, out
    assert out["target_oz"] == 90 + 8 + 24, out
    _ok("diet add-ons remain separate from activity hydration")


cases = [
    test_baseline_180_lb_no_workout,
    test_missing_bodyweight_uses_fallback,
    test_zero_bodyweight_uses_fallback,
    test_very_high_bodyweight_clamps_to_ceiling,
    test_very_low_bodyweight_clamps_to_floor,
    test_60min_moderate_workout_adds_about_16oz,
    test_90min_heavy_workout_adds_within_window,
    test_light_workout_adds_less_than_moderate,
    test_training_addon_is_capped,
    test_zero_duration_no_training_addon,
    test_intensity_inferred_heavy_from_duration,
    test_intensity_inferred_heavy_from_active_kcal,
    test_high_active_calories_adds_extra,
    test_very_high_active_calories_adds_more,
    test_low_active_calories_no_addon,
    test_hot_day_adds_heat_layer,
    test_extreme_heat_adds_more,
    test_cool_day_no_heat_addon,
    test_missing_ambient_is_skipped_not_failed,
    test_all_addons_stack_into_target,
    test_response_shape_contains_required_keys,
    test_target_range_wraps_adapted_midpoint,
    test_aliased_intensity_strings_are_accepted,
    test_activity_metadata_prevents_flat_duration_targets,
    test_protein_and_alcohol_addons_layer_on_target,
]


if __name__ == "__main__":
    import traceback
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            traceback.print_exc()
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    if failures:
        raise SystemExit(1)
    print(f"\n  All {len(cases)} tests passed.")
