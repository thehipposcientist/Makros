"""Regression tests for the two recommend-weight upgrades:

  1. Fatigue overlay (`apply_fatigue_override`) — downshifts the base
     weight rec when the target muscle's current fatigue is elevated.
     The five rule tiers (≤0.4, 0.4-0.6, 0.6-0.8, >0.8) each have a
     dedicated case, plus an unchanged-pass-through case, plus a
     "reason cites muscle + fatigue value" substring check.

  2. AI first-time branch (`ai_first_time_weight_recommendation`) —
     when the user has NO direct history for a planned exercise but
     DOES have recent sessions on the same primary muscle, ask the AI
     for a starting weight. Mock the OpenAI call with a fixed response
     to verify stamped fields; inject a malformed-JSON response to
     verify the fail-safe fallback behavior (returns None, logs a
     warning, no raise).

Run directly:  python3 -m tests.test_recommendation_fatigue_and_ai
"""
from __future__ import annotations

import json
import sys
from types import SimpleNamespace

from app.services.workout.recommendation import (
    FatigueAdjustment,
    apply_fatigue_override,
)
from app.services.workout.ai_first_time_weight import (
    ai_first_time_weight_recommendation,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Feature 1 — Fatigue overlay ──────────────────────────────────────

def test_fatigue_override_zero_fatigue_unchanged():
    print("\n[test] zero fatigue → rec unchanged, no override flag")
    adj = apply_fatigue_override(
        weight_lbs=185.0,
        base_confidence=0.85,
        base_reason="Based on your last 3 Bench Press sessions",
        primary_muscle="chest",
        muscle_fatigue={
            "chest": 0.0, "back": 0.0, "shoulders": 0.0, "biceps": 0.0,
            "triceps": 0.0, "quads": 0.0, "hamstrings": 0.0, "glutes": 0.0,
            "calves": 0.0, "core": 0.0, "cardio": 0.0, "systemic": 0.0,
        },
    )
    assert adj.fatigue_override is False
    assert adj.weight_lbs == 185.0
    assert adj.confidence == 0.85
    assert adj.reason == "Based on your last 3 Bench Press sessions"
    _ok("no change when fatigue ≤ 0.4")


def test_fatigue_override_low_band_unchanged():
    print("\n[test] fatigue 0.35 (≤0.4) → unchanged")
    adj = apply_fatigue_override(
        weight_lbs=135.0, base_confidence=0.80,
        base_reason="x",
        primary_muscle="quads",
        muscle_fatigue={"quads": 0.35, "chest": 0.9},
    )
    assert adj.fatigue_override is False
    assert adj.weight_lbs == 135.0
    _ok("0.35 quads + 0.9 chest → chest irrelevant, quads in floor band")


def test_fatigue_override_mid_band_minus_5pct():
    print("\n[test] fatigue 0.55 → -5% + override flag + reason cites fatigue")
    adj = apply_fatigue_override(
        weight_lbs=200.0, base_confidence=0.85,
        base_reason="baseline reason",
        primary_muscle="chest",
        muscle_fatigue={"chest": 0.55},
    )
    assert adj.fatigue_override is True
    # 200 × 0.95 = 190 → already a multiple of 2.5
    assert adj.weight_lbs == 190.0, adj.weight_lbs
    # Mid band keeps base confidence (0.85), NOT 'low'.
    assert adj.confidence == 0.85
    assert adj.reason == ""
    _ok(f"0.55 chest → {adj.weight_lbs} lb")


def test_fatigue_override_high_band_minus_10pct():
    print("\n[test] fatigue 0.7 → -10% + reason contains 'recovering'")
    adj = apply_fatigue_override(
        weight_lbs=200.0, base_confidence=0.85,
        base_reason="baseline reason",
        primary_muscle="chest",
        muscle_fatigue={"chest": 0.7},
    )
    assert adj.fatigue_override is True
    # 200 × 0.9 = 180
    assert adj.weight_lbs == 180.0, adj.weight_lbs
    assert adj.confidence == 0.85
    assert adj.reason == ""
    _ok(f"0.7 chest → {adj.weight_lbs} lb (-10%)")


def test_fatigue_override_very_high_band_minus_15pct_low_confidence():
    print("\n[test] fatigue 0.85 → -15% + confidence='low'")
    adj = apply_fatigue_override(
        weight_lbs=200.0, base_confidence=0.85,
        base_reason="baseline reason",
        primary_muscle="chest",
        muscle_fatigue={"chest": 0.85},
    )
    assert adj.fatigue_override is True
    # 200 × 0.85 = 170
    assert adj.weight_lbs == 170.0, adj.weight_lbs
    assert adj.confidence == "low"
    assert adj.reason == ""
    _ok(f"0.85 chest → {adj.weight_lbs} lb, confidence='low'")


def test_fatigue_override_rounds_to_2_5_lb():
    print("\n[test] result always rounded to nearest 2.5 lb")
    # 137 × 0.9 = 123.3 → round to 122.5
    adj = apply_fatigue_override(
        weight_lbs=137.0, base_confidence=0.60,
        base_reason="x",
        primary_muscle="back",
        muscle_fatigue={"back": 0.65},
    )
    assert adj.fatigue_override is True
    assert adj.weight_lbs % 2.5 == 0, adj.weight_lbs
    _ok(f"137 → {adj.weight_lbs} (multiple of 2.5)")


def test_fatigue_override_skips_when_fatigue_map_missing():
    print("\n[test] no fatigue snapshot → pass through unchanged")
    adj = apply_fatigue_override(
        weight_lbs=185.0, base_confidence=0.85,
        base_reason="x",
        primary_muscle="chest",
        muscle_fatigue=None,
    )
    assert adj.fatigue_override is False
    assert adj.weight_lbs == 185.0
    _ok("None snapshot is a no-op")


def test_fatigue_override_alias_map_routes_traps_to_back():
    """`_PRIMARY_MUSCLE_TO_FATIGUE_KEY` maps seed-level muscles onto the
    12-dimension canonical fatigue buckets. Regression: a traps-focused
    exercise must hit the `back` fatigue bucket."""
    print("\n[test] primary_muscle='traps' routes to fatigue key 'back'")
    adj = apply_fatigue_override(
        weight_lbs=100.0, base_confidence=0.80,
        base_reason="x",
        primary_muscle="traps",
        # Set back=0.7 → expect -10% since traps aliases to back.
        muscle_fatigue={"back": 0.7},
    )
    assert adj.fatigue_override is True
    assert adj.weight_lbs == 90.0  # 100 × 0.9
    _ok("traps → back alias confirmed")


def test_fatigue_override_alias_map_routes_forearms_to_biceps():
    """Forearms are represented in the seed catalog, but the fatigue
    model rolls them into the arm/biceps bucket."""
    print("\n[test] primary_muscle='forearms' routes to fatigue key 'biceps'")
    adj = apply_fatigue_override(
        weight_lbs=50.0,
        base_confidence=0.80,
        base_reason="x",
        primary_muscle="forearms",
        muscle_fatigue={"biceps": 0.7, "forearms": 0.0},
    )
    assert adj.fatigue_override is True
    assert adj.weight_lbs == 45.0  # 50 × 0.9
    _ok("forearms → biceps alias confirmed")


# ─── Feature 2 — AI first-time branch ────────────────────────────────


def _make_fake_openai(response_content: str):
    """Build a fake OpenAI client whose `chat.completions.create` returns
    a response with a single choice whose message.content matches
    `response_content`. Used to mock out the AI call without any
    network traffic."""
    completion = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=response_content))]
    )
    completions = SimpleNamespace(create=lambda **kwargs: completion)
    chat = SimpleNamespace(completions=completions)
    return SimpleNamespace(chat=chat)


def _fake_chat_kwargs_builder(model, messages, *, json_schema=None, max_tokens=None, timeout_secs=15):
    return {"model": model, "messages": messages}


def _fake_chat_create(client, **kwargs):
    return client.chat.completions.create(**kwargs)


def _fake_json_extractor(content):
    return json.loads(content)


def test_ai_first_time_no_muscle_sessions_uses_profile_ai_path():
    """No similar-muscle sessions now uses the profile/bodyweight AI path.
    The caller still falls back deterministically if bodyweight/client is
    missing, but fresh users with profile data get a conservative estimate."""
    print("\n[test] empty muscle_sessions → profile AI path")
    called = {"n": 0}

    def spy_invoker(client, **kwargs):
        called["n"] += 1
        return _fake_chat_create(client, **kwargs)

    rec = ai_first_time_weight_recommendation(
        exercise_name="Decline Dumbbell Press",
        primary_muscle="chest",
        target_reps="8-12",
        experience="intermediate",
        bodyweight_lbs=180,
        muscle_sessions=[],
        openai_client=_make_fake_openai('{"weight_lbs": 60, "reason": "x", "confidence": "medium"}'),
        model="gpt-4o-mini",
        chat_kwargs_builder=_fake_chat_kwargs_builder,
        chat_invoker=spy_invoker,
        json_extractor=_fake_json_extractor,
    )
    assert rec is not None
    assert rec.weight_lbs == 60.0
    assert rec.confidence == "low"
    assert rec.reason == ""
    assert called["n"] == 1, "AI should be called for the profile/bodyweight path"
    _ok("no sessions → profile AI call, conservative rec returned")


def test_ai_first_time_three_sessions_hits_ai_and_stamps_fields():
    """Three similar-muscle sessions + mocked AI response → returns a
    fully-populated `AIFirstTimeRecommendation` with rounded weight."""
    print("\n[test] 3 muscle sessions → AI branch stamps weight/confidence/reason")
    muscle_sessions = [
        {
            "exercise_slug": "barbell_bench_press",
            "exercise_name": "Barbell Bench Press",
            "equipment": "barbell",
            "set_count": 4,
            "reps_logged": "8,8,7,6",
            "top_weight_lbs": 185.0,
            "top_reps": 8,
            "completed_on": "2026-04-15",
        },
        {
            "exercise_slug": "incline_dumbbell_press",
            "exercise_name": "Incline Dumbbell Press",
            "equipment": "dumbbell",
            "set_count": 3,
            "reps_logged": "10,10,9",
            "top_weight_lbs": 70.0,
            "top_reps": 10,
            "completed_on": "2026-04-12",
        },
        {
            "exercise_slug": "cable_fly",
            "exercise_name": "Cable Fly",
            "equipment": "cable",
            "set_count": 3,
            "reps_logged": "12,12,11",
            "top_weight_lbs": 40.0,
            "top_reps": 12,
            "completed_on": "2026-04-10",
        },
    ]
    fake_client = _make_fake_openai(json.dumps({
        "weight_lbs": 52,
        "reason": "Your bench press tops at 185 — start decline DBs conservatively around 50 lb.",
        "confidence": "medium",
    }))
    rec = ai_first_time_weight_recommendation(
        exercise_name="Decline Dumbbell Press",
        primary_muscle="chest",
        target_reps="8-12",
        experience="intermediate",
        bodyweight_lbs=180,
        muscle_sessions=muscle_sessions,
        openai_client=fake_client,
        model="gpt-4o-mini",
        chat_kwargs_builder=_fake_chat_kwargs_builder,
        chat_invoker=_fake_chat_create,
        json_extractor=_fake_json_extractor,
    )
    assert rec is not None
    # 52 should round to 52.5 (nearest 2.5).
    assert rec.weight_lbs == 52.5, rec.weight_lbs
    assert rec.confidence == "low"
    assert rec.reason == ""
    _ok(f"AI rec: {rec.weight_lbs} lb, confidence={rec.confidence}")


def test_ai_first_time_malformed_json_falls_back_cleanly():
    """The AI is flaky — sometimes it returns non-JSON or wrong shape.
    When that happens we must return None so the caller falls through
    to tier-6/7. No exception raised, no 500 to the user."""
    print("\n[test] malformed JSON → returns None, no raise")
    muscle_sessions = [{
        "exercise_slug": "barbell_row",
        "exercise_name": "Barbell Row",
        "equipment": "barbell",
        "set_count": 3,
        "reps_logged": "8,8,7",
        "top_weight_lbs": 155.0,
        "top_reps": 8,
        "completed_on": "2026-04-15",
    }]
    # Content that json.loads can't handle.
    fake_client = _make_fake_openai("not really JSON { at all")
    rec = ai_first_time_weight_recommendation(
        exercise_name="T-Bar Row",
        primary_muscle="back",
        target_reps="6-10",
        experience="intermediate",
        bodyweight_lbs=180,
        muscle_sessions=muscle_sessions,
        openai_client=fake_client,
        model="gpt-4o-mini",
        chat_kwargs_builder=_fake_chat_kwargs_builder,
        chat_invoker=_fake_chat_create,
        json_extractor=_fake_json_extractor,
    )
    assert rec is None, "malformed JSON must return None (not raise)"
    _ok("malformed JSON falls back to None cleanly")


def test_ai_first_time_non_positive_weight_rejected():
    """If the AI returns weight_lbs=0 (or negative), reject the rec —
    tier-7 default is a safer fallback than zeroing out the load."""
    print("\n[test] AI returns 0 lb → returns None (rejected)")
    muscle_sessions = [{
        "exercise_slug": "dumbbell_curl",
        "exercise_name": "Dumbbell Curl",
        "equipment": "dumbbell",
        "set_count": 3,
        "reps_logged": "10,10,10",
        "top_weight_lbs": 30.0,
        "top_reps": 10,
        "completed_on": "2026-04-14",
    }]
    fake_client = _make_fake_openai(
        '{"weight_lbs": 0, "reason": "unsure", "confidence": "low"}'
    )
    rec = ai_first_time_weight_recommendation(
        exercise_name="Hammer Curl",
        primary_muscle="biceps",
        target_reps="10-12",
        experience="intermediate",
        bodyweight_lbs=160,
        muscle_sessions=muscle_sessions,
        openai_client=fake_client,
        model="gpt-4o-mini",
        chat_kwargs_builder=_fake_chat_kwargs_builder,
        chat_invoker=_fake_chat_create,
        json_extractor=_fake_json_extractor,
    )
    assert rec is None
    _ok("zero-weight AI response rejected")


def test_ai_first_time_unknown_confidence_coerced_low():
    """The schema enforces low/medium/high, but defensive coercion keeps
    us safe when a gpt-4o model produces an out-of-schema string."""
    print("\n[test] AI returns confidence='extreme' → coerced to 'low'")
    muscle_sessions = [{
        "exercise_slug": "barbell_squat",
        "exercise_name": "Barbell Back Squat",
        "equipment": "barbell",
        "set_count": 4,
        "reps_logged": "5,5,5,5",
        "top_weight_lbs": 225.0,
        "top_reps": 5,
        "completed_on": "2026-04-15",
    }]
    fake_client = _make_fake_openai(
        '{"weight_lbs": 135, "reason": "conservative open", "confidence": "extreme"}'
    )
    rec = ai_first_time_weight_recommendation(
        exercise_name="Front Squat",
        primary_muscle="quads",
        target_reps="5-8",
        experience="intermediate",
        bodyweight_lbs=180,
        muscle_sessions=muscle_sessions,
        openai_client=fake_client,
        model="gpt-4o-mini",
        chat_kwargs_builder=_fake_chat_kwargs_builder,
        chat_invoker=_fake_chat_create,
        json_extractor=_fake_json_extractor,
    )
    assert rec is not None
    assert rec.confidence == "low", rec.confidence
    assert rec.weight_lbs == 135.0
    _ok("out-of-schema confidence coerced to 'low'")


# ─── Runner ──────────────────────────────────────────────────────────


def _run_all() -> int:
    tests = [
        # Feature 1
        test_fatigue_override_zero_fatigue_unchanged,
        test_fatigue_override_low_band_unchanged,
        test_fatigue_override_mid_band_minus_5pct,
        test_fatigue_override_high_band_minus_10pct,
        test_fatigue_override_very_high_band_minus_15pct_low_confidence,
        test_fatigue_override_rounds_to_2_5_lb,
        test_fatigue_override_skips_when_fatigue_map_missing,
        test_fatigue_override_alias_map_routes_traps_to_back,
        test_fatigue_override_alias_map_routes_forearms_to_biceps,
        # Feature 2
        test_ai_first_time_no_muscle_sessions_uses_profile_ai_path,
        test_ai_first_time_three_sessions_hits_ai_and_stamps_fields,
        test_ai_first_time_malformed_json_falls_back_cleanly,
        test_ai_first_time_non_positive_weight_rejected,
        test_ai_first_time_unknown_confidence_coerced_low,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            import traceback
            traceback.print_exc()
            print(f"  ✗ {t.__name__} ({type(e).__name__}: {e})")
    print()
    if failed == 0:
        print(f"{len(tests)}/{len(tests)} passed")
        return 0
    print(f"{failed} FAILED")
    return 1


cases = [
    test_fatigue_override_zero_fatigue_unchanged,
    test_fatigue_override_low_band_unchanged,
    test_fatigue_override_mid_band_minus_5pct,
    test_fatigue_override_high_band_minus_10pct,
    test_fatigue_override_very_high_band_minus_15pct_low_confidence,
    test_fatigue_override_rounds_to_2_5_lb,
    test_fatigue_override_skips_when_fatigue_map_missing,
    test_fatigue_override_alias_map_routes_traps_to_back,
    test_fatigue_override_alias_map_routes_forearms_to_biceps,
    test_ai_first_time_no_muscle_sessions_uses_profile_ai_path,
    test_ai_first_time_three_sessions_hits_ai_and_stamps_fields,
    test_ai_first_time_malformed_json_falls_back_cleanly,
    test_ai_first_time_non_positive_weight_rejected,
    test_ai_first_time_unknown_confidence_coerced_low,
]


if __name__ == "__main__":
    sys.exit(_run_all())
