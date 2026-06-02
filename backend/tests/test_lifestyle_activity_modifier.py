"""Unit tests for the 2026-05 lifestyle-activity TDEE nudge.

`step_2b_apply_lifestyle_modifier` adds a small bump on top of the
training-schedule multiplier when the user has reported what they do
outside the gym. Five canonical levels map to fixed deltas; anything
else (None, empty, unknown) is a no-op so legacy accounts keep their
old TDEE estimate.

These tests lock in the boundary behavior — no-op on None, correct
deltas per level, clamping at the [1.2, 2.05] envelope.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_no_op_when_lifestyle_is_none():
    print("\n[test] None lifestyle → multiplier unchanged")
    from app.services.nutrition.calorie_calculator import step_2b_apply_lifestyle_modifier
    assert step_2b_apply_lifestyle_modifier(1.55, None) == 1.55
    assert step_2b_apply_lifestyle_modifier(1.20, None) == 1.20
    _ok("legacy accounts keep their TDEE when the question wasn't asked")


def test_no_op_for_unknown_values():
    print("\n[test] unknown / empty value → multiplier unchanged")
    from app.services.nutrition.calorie_calculator import step_2b_apply_lifestyle_modifier
    assert step_2b_apply_lifestyle_modifier(1.55, "") == 1.55
    assert step_2b_apply_lifestyle_modifier(1.55, "extremely_active") == 1.55
    assert step_2b_apply_lifestyle_modifier(1.55, "random_garbage") == 1.55
    _ok("defensive: unknown labels never break the calculation")


def test_sedentary_no_change():
    print("\n[test] 'sedentary' is a confirmed no-bump")
    from app.services.nutrition.calorie_calculator import step_2b_apply_lifestyle_modifier
    # Sedentary is a deliberate signal — the user is at a desk all day.
    # The training-schedule multiplier already assumes some baseline
    # activity, so we don't subtract; we just don't add.
    assert step_2b_apply_lifestyle_modifier(1.55, "sedentary") == 1.55
    _ok("explicit sedentary doesn't double-debit the multiplier")


def test_each_level_adds_correct_delta():
    print("\n[test] each level bumps by its documented amount")
    from app.services.nutrition.calorie_calculator import step_2b_apply_lifestyle_modifier
    # Pre-bump baseline matches the moderate (4-5 day) training bucket.
    base = 1.55
    cases = {
        "light":       1.65,  # +0.10
        "moderate":    1.75,  # +0.20
        "active":      1.80,  # +0.25
        "very_active": 1.85,  # +0.30
    }
    for level, expected in cases.items():
        got = step_2b_apply_lifestyle_modifier(base, level)
        assert abs(got - expected) < 1e-6, f"{level}: expected {expected}, got {got}"
    _ok("light / moderate / active / very_active all hit their target multipliers")


def test_clamps_at_top_envelope():
    print("\n[test] caps at 2.05 even for the heaviest combination")
    from app.services.nutrition.calorie_calculator import step_2b_apply_lifestyle_modifier
    # A 6+ day/week heavy lifter on top of construction work hits the
    # bound. Past 2.0 the BMR + activity model breaks down (you need
    # TEF + per-meal estimates) so clamping is the right call.
    assert step_2b_apply_lifestyle_modifier(1.80, "very_active") == 2.05
    assert step_2b_apply_lifestyle_modifier(2.00, "very_active") == 2.05
    _ok("very-active + heavy training caps at 2.05, no runaway TDEE")


def test_case_insensitive_and_whitespace_tolerant():
    print("\n[test] level matching tolerates whitespace + casing")
    from app.services.nutrition.calorie_calculator import step_2b_apply_lifestyle_modifier
    assert step_2b_apply_lifestyle_modifier(1.55, "Moderate") == 1.75
    assert step_2b_apply_lifestyle_modifier(1.55, "  VERY_ACTIVE  ") == 1.85
    _ok("incoming labels survive minor formatting drift")


def test_full_pipeline_with_calorie_inputs():
    print("\n[test] compute_targets threads lifestyle through CalorieInputs")
    from app.services.nutrition.calorie_calculator import CalorieInputs, compute_targets
    base_kwargs = dict(
        weight_lbs=180.0,
        height_feet=5,
        height_inches=10,
        age=30,
        gender="male",
        training_days_per_week=4,
        session_minutes=60,
        goal_id="body_recomp",
        pace="moderate",
    )
    sedentary_target = compute_targets(CalorieInputs(**base_kwargs, lifestyle_activity="sedentary"))
    no_answer_target = compute_targets(CalorieInputs(**base_kwargs, lifestyle_activity=None))
    active_target = compute_targets(CalorieInputs(**base_kwargs, lifestyle_activity="active"))
    # sedentary == not asked (both no-op).
    assert sedentary_target.calories == no_answer_target.calories
    # active bumps TDEE meaningfully (a few hundred calories at this body weight).
    assert active_target.calories > no_answer_target.calories + 100
    _ok("calorie pipeline reads lifestyle field end-to-end")


if __name__ == "__main__":
    cases = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print()
    if failures == 0:
        print(f"✓ All {len(cases)} tests passed.")
    else:
        print(f"✗ {failures}/{len(cases)} test(s) failed.")
    import sys
    sys.exit(1 if failures else 0)
