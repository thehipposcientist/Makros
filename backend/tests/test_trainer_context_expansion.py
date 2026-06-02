"""Unit tests for the 2026-05 trainer-context expansion.

Pure-function tests where possible. Covers the new helpers:
  * _time_bucket_for_meal (timing tags)
  * intent classifiers in chat.py (energy/sleep, fueling, nutrient)
  * `enrich()` signature accepts the new flag kwargs without breaking
    legacy callers.

The DB-touching helpers (_heart_rate_recovery, _sleep_last_night,
_caffeine_alcohol_recent, _fiber_micros_7d, _cardio_load_recent) are
defensive — they return None on missing data — and their happy paths
are exercised by the chat-route API smoke tests via real DB rows.
This module focuses on the pure-function bits that are easy to lock in.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Time bucket tagging ───────────────────────────────────────────────────

def test_time_bucket_pre_workout_morning():
    print("\n[test] _time_bucket_for_meal: 8 AM → early_morning")
    from app.services.coach.trainer_context import _time_bucket_for_meal
    assert _time_bucket_for_meal("2026-05-29T08:30:00+00:00", "breakfast") == "early_morning"
    _ok("8:30 AM tagged early_morning")


def test_time_bucket_late_night():
    print("\n[test] _time_bucket_for_meal: 23:00 → late_night")
    from app.services.coach.trainer_context import _time_bucket_for_meal
    assert _time_bucket_for_meal("2026-05-29T23:00:00+00:00", "snack") == "late_night"
    assert _time_bucket_for_meal("2026-05-29T02:30:00+00:00", "snack") == "late_night"
    _ok("late-night window covers 21:00–03:59")


def test_time_bucket_falls_back_to_meal_type():
    print("\n[test] _time_bucket_for_meal: null timestamp → meal_type fallback")
    from app.services.coach.trainer_context import _time_bucket_for_meal
    assert _time_bucket_for_meal(None, "breakfast") == "mid_morning"
    assert _time_bucket_for_meal(None, "dinner") == "evening"
    # Too ambiguous to bucket — returns None instead of guessing.
    assert _time_bucket_for_meal(None, "snack") is None
    _ok("meal_type fallback handles ambiguity honestly")


def test_time_bucket_handles_garbage_input():
    print("\n[test] _time_bucket_for_meal: invalid input → None, never crashes")
    from app.services.coach.trainer_context import _time_bucket_for_meal
    assert _time_bucket_for_meal("not a date", None) is None
    assert _time_bucket_for_meal("", None) is None
    assert _time_bucket_for_meal(None, None) is None
    _ok("garbage input handled defensively")


# ─── Intent classifiers (chat router) ──────────────────────────────────────

def test_energy_or_sleep_question_detection():
    print("\n[test] _is_energy_or_sleep_question: catches tired / fatigue / sleep / caffeine")
    from app.routers.ai.chat import _is_energy_or_sleep_question
    assert _is_energy_or_sleep_question("Why am I so tired today?") is True
    assert _is_energy_or_sleep_question("My sleep was rough last night") is True
    assert _is_energy_or_sleep_question("Am I drinking too much coffee?") is True
    assert _is_energy_or_sleep_question("I felt really exhausted after my workout") is True
    # Negative — questions that aren't about energy / sleep.
    assert _is_energy_or_sleep_question("What's a good chest exercise?") is False
    assert _is_energy_or_sleep_question("Can you swap squats for lunges?") is False
    _ok("energy/sleep classifier hits the right surface")


def test_recovery_question_detection_via_energy_path():
    print("\n[test] _is_energy_or_sleep_question: covers recovery + HRV / sore")
    from app.routers.ai.chat import _is_energy_or_sleep_question
    # The recovery patterns are folded into the energy/sleep classifier
    # so a single flag attaches the caffeine/alcohol block for both.
    assert _is_energy_or_sleep_question("Am I recovering well?") is True
    assert _is_energy_or_sleep_question("My HRV dropped this week") is True
    assert _is_energy_or_sleep_question("I'm sore everywhere") is True
    _ok("recovery / HRV / soreness fold into energy intent")


def test_fueling_question_detection():
    print("\n[test] _is_fueling_question: catches pre/post workout questions")
    from app.routers.ai.chat import _is_fueling_question
    assert _is_fueling_question("Is my pre-workout meal sufficient?") is True
    assert _is_fueling_question("What should I eat before the gym?") is True
    assert _is_fueling_question("How long after my workout should I eat?") is True
    assert _is_fueling_question("Should I fuel before training?") is True
    # Negative.
    assert _is_fueling_question("What's a good cardio routine?") is False
    _ok("fueling classifier hits pre/post-workout phrasing")


def test_nutrient_question_detection():
    print("\n[test] _is_nutrient_question: catches fiber / vitamin / micro questions")
    from app.routers.ai.chat import _is_nutrient_question
    assert _is_nutrient_question("Is my fiber too high?") is True
    assert _is_nutrient_question("Am I getting enough vitamin D?") is True
    assert _is_nutrient_question("What's a good source of omega-3?") is True
    assert _is_nutrient_question("My sodium feels high") is True
    # Negative.
    assert _is_nutrient_question("How should I structure my push day?") is False
    _ok("nutrient classifier hits micro-specific phrasing")


# ─── enrich() signature back-compat ────────────────────────────────────────

def test_enrich_accepts_new_flags_without_breaking_legacy_callers():
    print("\n[test] enrich(): new kwargs default to False; legacy call shape unchanged")
    import inspect
    from app.services.coach.trainer_context import enrich
    sig = inspect.signature(enrich)
    params = sig.parameters
    # Legacy `include_recent_meals` still defaults to False.
    assert params["include_recent_meals"].default is False
    # New flags exist with sane defaults.
    assert "include_caffeine_alcohol" in params
    assert params["include_caffeine_alcohol"].default is False
    assert "include_fiber_micros" in params
    assert params["include_fiber_micros"].default is False
    _ok("enrich() exposes the new flags without breaking legacy callers")


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
