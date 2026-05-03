"""Pure-function guardrail tests for Home Trainer chat responses."""
from __future__ import annotations

from app.routers.ai.chat import _enforce_trainer_plan_guardrails


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_injury_response_never_rewrites_plan() -> None:
    result = _enforce_trainer_plan_guardrails({
        "answer": "I logged this knee issue and updated tomorrow to upper body.",
        "action_items": ["Avoid squats"],
        "needs_plan_update": True,
        "updated_workout_plan": {"days": [{"day": "Day 1", "exercises": []}]},
        "updated_nutrition_plan": {"targets": {"calories": 2000}},
        "updated_injuries": [{
            "description": "Left knee pain while squatting",
            "bodyPart": "knee",
            "severity": "moderate",
            "muscleGroups": ["quads", "hamstrings"],
            "estimatedRecoveryDays": 21,
        }],
    }, is_nutritionist=False)

    assert result["needs_plan_update"] is False
    assert result["updated_workout_plan"] is None
    assert result["updated_nutrition_plan"] is None
    assert result["updated_injuries"][0]["bodyPart"] == "knee"
    _ok("injury responses keep structured injury data but strip plan updates")


def test_workout_plan_promise_redirects_to_deterministic_controls() -> None:
    result = _enforce_trainer_plan_guardrails({
        "answer": "Done, I've swapped tomorrow to push and updated your week.",
        "action_items": [],
        "needs_plan_update": True,
        "updated_workout_plan": {"days": [{"day": "Day 1", "exercises": [{"name": "Bench Press"}]}]},
        "updated_nutrition_plan": None,
        "updated_injuries": None,
    }, is_nutritionist=False)

    assert result["needs_plan_update"] is False
    assert result["updated_workout_plan"] is None
    assert "can't directly rewrite your active 7-day workout plan" in result["answer"]
    assert any("Workout > Plan" in item and "Change Focus" in item for item in result["action_items"])
    _ok("workout rewrite promises are redirected")


def test_nutrition_plan_promise_redirects_to_meal_controls() -> None:
    result = _enforce_trainer_plan_guardrails({
        "answer": "I've updated your generated meal plan with lower-sugar breakfasts.",
        "action_items": [],
        "needs_plan_update": True,
        "updated_workout_plan": None,
        "updated_nutrition_plan": {"targets": {"calories": 2100}},
        "updated_injuries": None,
    }, is_nutritionist=True)

    assert result["needs_plan_update"] is False
    assert result["updated_nutrition_plan"] is None
    assert "can't directly rewrite your generated meal plan" in result["answer"]
    assert any("Meals > Plan" in item for item in result["action_items"])
    _ok("nutrition rewrite promises are redirected")


def test_goal_setting_update_survives_but_plan_payload_is_stripped() -> None:
    result = _enforce_trainer_plan_guardrails({
        "answer": "I recommend switching your goal to fat loss.",
        "action_items": ["Confirm the goal change"],
        "needs_plan_update": True,
        "updated_goal": "fat_loss",
        "updated_workout_plan": {"days": [{"day": "Day 1", "exercises": [{"name": "Squat"}]}]},
        "updated_nutrition_plan": None,
        "updated_injuries": None,
    }, is_nutritionist=False)

    assert result["needs_plan_update"] is False
    assert result["updated_goal"] == "fat_loss"
    assert result["updated_workout_plan"] is None
    assert "can't directly rewrite" not in result["answer"]
    _ok("supported goal proposals survive while legacy plan payloads are stripped")


cases = [
    test_injury_response_never_rewrites_plan,
    test_workout_plan_promise_redirects_to_deterministic_controls,
    test_nutrition_plan_promise_redirects_to_meal_controls,
    test_goal_setting_update_survives_but_plan_payload_is_stripped,
]


if __name__ == "__main__":
    import sys

    failed = []
    for fn in cases:
        try:
            fn()
        except AssertionError as e:
            failed.append((fn.__name__, str(e)))
            print(f"  ✗ FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed.append((fn.__name__, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {fn.__name__}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(cases)} failed")
        sys.exit(1)
    print(f"\nAll {len(cases)} coach_chat_guardrails tests passed")
