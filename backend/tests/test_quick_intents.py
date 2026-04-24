"""Pure-function tests for quick_intents.

Each of the 12 intents needs at least one match pattern and one
non-match (false-positive guard). Cheap regression coverage.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_quick_intents
"""
from __future__ import annotations

from app.routers.ai.quick_intents import match_intent, handle_intent


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def test_positive_matches():
    print("[test] each intent matches at least one phrase")
    cases = [
        ("only have 30 minutes today", "time_limited"),
        ("slept badly last night", "slept_badly"),
        ("i'm too sore to lift", "too_sore"),
        ("missed my workout yesterday", "missed_workout"),
        ("can we add more cardio", "more_cardio"),
        ("less cardio please", "less_cardio"),
        ("need a deload week", "deload"),
        ("more core please", "more_core"),
        ("hard workout tomorrow", "hard_tomorrow"),
        ("losing weight too fast", "losing_too_fast"),
        ("strength dropping in my bench", "strength_dropping"),
        ("i'm so hungry all the time", "hungrier"),
    ]
    for q, expected in cases:
        got = match_intent(q)
        assert_eq(got, expected, f"\"{q}\" → {expected}")


def test_no_false_positives():
    print("[test] generic questions don't match")
    no_matches = [
        "how much protein should i eat",
        "what is creatine",
        "swap bench for dumbbell press",
        "how do i set up my plan",
    ]
    for q in no_matches:
        got = match_intent(q)
        assert got is None, f"false positive on \"{q}\" → {got}"
        print(f"  ✓ \"{q}\" → no match")


def test_handlers_return_actions():
    print("[test] handlers return structured actions")
    for intent in (
        "time_limited", "slept_badly", "too_sore", "missed_workout",
        "more_cardio", "less_cardio", "deload", "more_core",
        "hard_tomorrow", "losing_too_fast", "strength_dropping",
    ):
        resp = handle_intent(intent, "test prompt")
        assert resp is not None, f"{intent} returned None"
        assert resp.intent == intent, f"{intent}: intent mismatch"
        assert resp.answer, f"{intent}: empty answer"
        assert isinstance(resp.action_items, list), f"{intent}: action_items not list"
        # All but `hungrier` carry an action.
        if intent != "hungrier":
            assert resp.action is not None, f"{intent}: missing action dict"
        print(f"  ✓ {intent}")


def test_time_limited_extracts_minutes():
    print("[test] time_limited pulls minutes out of the prompt")
    resp = handle_intent("time_limited", "i only have 25 minutes today")
    assert resp is not None
    assert resp.action is not None
    assert resp.action.get("minutes") == 25, f"expected 25, got {resp.action.get('minutes')}"
    print("  ✓ extracted 25 min")


if __name__ == "__main__":
    test_positive_matches()
    test_no_false_positives()
    test_handlers_return_actions()
    test_time_limited_extracts_minutes()
    print("\n✅ test_quick_intents.py PASSED")
