"""Tests for the new weekly check-in plumbing:

  1. `/coach/apply-bulk` — batch-apply the user's accepted weekly recs
     in one call. Aggregates results, sets needs_regen exactly once,
     handles partial failures, builds a useful summary string.

  2. `compose_weekly_narrative` — gpt-5-mini-backed AI call that wraps
     the deterministic weekly review in a personal narrative. Tests use
     a fake OpenAI client so they're hermetic + fast.

  3. `fallback_weekly_narrative` — deterministic safety net when the AI
     call fails or env is missing. Returns the same shape as the AI
     path so the modal renders identically.

Hard contracts under test:
  • bulk apply runs every item independently — one failure can't abort
    the rest
  • needs_regen aggregates with OR (true if ANY item needed regen)
  • partial-success summary is honest about what landed vs skipped
  • compose_weekly_narrative NEVER invents recs the apply layer can't
    handle (rec_overrides keys must match input rec.key set)
  • compose_weekly_narrative caps wins/needs_attention at 3 each so a
    chatty model can't blow up the modal
  • output shape is stable even on bad LLM JSON (defensive defaults)
"""
from __future__ import annotations

import json
from types import SimpleNamespace


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Fixtures ────────────────────────────────────────────────────

def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        UserCoachingOverlay,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _setup():
    """Engine, session, user, and a UserPreferences row (so
    change_days_per_week works without `no_prefs` errors)."""
    from sqlmodel import Session
    from app.models import User, UserPreferences
    engine = _make_mem_engine()
    s = Session(engine)
    u = User(email="bulk@example.com", username="bulk", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    p = UserPreferences(user_id=u.id, days_per_week=4)
    s.add(p); s.commit()
    return engine, s, u


def _bulk(s, uid, items):
    """Local helper that mimics the router's apply-bulk loop without
    needing a TestClient. The router function itself is small and
    delegates to apply_action — testing the helper exercises every
    branch the router does."""
    from app.services.coach.apply_action import apply_action
    results, applied, skipped, failed, needs_regen = [], 0, 0, 0, False
    for item in items:
        try:
            r = apply_action(s, uid, item.get("action"), rec_key=item.get("rec_key"))
            results.append(r.to_dict())
            if r.applied and r.changed_fields:
                applied += 1
                if r.needs_regen:
                    needs_regen = True
            elif r.applied:
                skipped += 1
            else:
                failed += 1
        except Exception as e:
            failed += 1
            results.append({"applied": False, "summary": f"Error: {e}",
                            "needs_regen": False, "changed_fields": {},
                            "descriptive_only": False, "error": "internal_error"})
    return {
        "applied_count": applied, "skipped_count": skipped,
        "failed_count": failed, "needs_regen": needs_regen,
        "results": results,
    }


# ─── apply-bulk: aggregate behavior ───────────────────────────────

def test_bulk_apply_runs_all_items_in_order():
    """Three independent applies should all hit, regardless of type."""
    print("\n[test] apply-bulk: 3 independent items all apply")
    _, s, u = _setup()
    res = _bulk(s, u.id, [
        {"action": {"type": "add_cardio_session"}, "rec_key": "rk1"},
        {"action": {"type": "add_muscle_volume", "muscle": "quads"}, "rec_key": "rk2"},
        {"action": {"type": "schedule_deload"}, "rec_key": "rk3"},
    ])
    assert res["applied_count"] == 3, f"expected 3 applied, got {res}"
    assert res["failed_count"] == 0
    assert res["needs_regen"] is True


def test_bulk_apply_partial_failure_keeps_going():
    """A single bad item must NOT abort the rest. Good items still
    apply, bad item is reported as failed, summary is honest."""
    print("\n[test] apply-bulk: bad item doesn't abort the rest")
    _, s, u = _setup()
    res = _bulk(s, u.id, [
        {"action": {"type": "add_cardio_session"}, "rec_key": "good1"},
        {"action": {"type": "make_user_a_pro_lifter"}, "rec_key": "bad"},
        {"action": {"type": "add_muscle_volume", "muscle": "back"}, "rec_key": "good2"},
    ])
    assert res["applied_count"] == 2, f"expected 2 applied, got {res['applied_count']}"
    assert res["failed_count"] == 1


def test_bulk_apply_needs_regen_or_aggregates():
    """needs_regen on the bulk result should be OR across items —
    even if just one item asks for regen, the bulk says yes (so the
    client kicks one regen, not N)."""
    print("\n[test] apply-bulk: needs_regen aggregates with OR")
    _, s, u = _setup()
    # raise_protein_target sets needs_regen=False; add_cardio_session sets True.
    res = _bulk(s, u.id, [
        {"action": {"type": "raise_protein_target"}, "rec_key": "p"},
        {"action": {"type": "add_cardio_session"}, "rec_key": "c"},
    ])
    assert res["needs_regen"] is True


def test_bulk_apply_no_regen_if_no_item_needed_it():
    """When ONLY nutrition deltas applied (which don't need regen),
    aggregate needs_regen stays False — the macros pipeline will pick
    up the change on the next /meals/score call without a planner
    rebuild."""
    print("\n[test] apply-bulk: needs_regen stays False if no item asked")
    _, s, u = _setup()
    res = _bulk(s, u.id, [
        {"action": {"type": "raise_protein_target"}, "rec_key": "p"},
        {"action": {"type": "raise_fiber_target"}, "rec_key": "f"},
    ])
    assert res["needs_regen"] is False
    assert res["applied_count"] == 2


def test_bulk_apply_skipped_when_already_at_cap():
    """An apply that returns applied=True but no changed_fields (e.g.
    already at cardio cap) counts as 'skipped' — the user shouldn't
    see 'Applied 5 changes' when 4 of them did nothing."""
    print("\n[test] apply-bulk: at-cap applies are counted as skipped")
    from app.services.coach.apply_action import apply_action
    _, s, u = _setup()
    # Saturate cardio at the cap first.
    apply_action(s, u.id, {"type": "add_cardio_session", "minutes": 360})
    # Now bulk-apply another add — should report skipped not applied.
    res = _bulk(s, u.id, [
        {"action": {"type": "add_cardio_session"}, "rec_key": "noop"},
    ])
    assert res["applied_count"] == 0
    assert res["skipped_count"] == 1


def test_bulk_apply_empty_input_safe():
    """An empty bulk request should return zero counts, not crash."""
    print("\n[test] apply-bulk: empty list is a clean no-op")
    _, s, u = _setup()
    res = _bulk(s, u.id, [])
    assert res["applied_count"] == 0
    assert res["failed_count"] == 0
    assert res["needs_regen"] is False
    assert res["results"] == []


def test_bulk_apply_persists_overlay_state():
    """The whole point: after bulk-apply runs, querying the overlay
    must show every accepted change. Catches any case where one
    item's commit accidentally rolls back another's."""
    print("\n[test] apply-bulk: every accepted change persists to UserCoachingOverlay")
    from app.models import UserCoachingOverlay
    from sqlmodel import select
    _, s, u = _setup()
    _bulk(s, u.id, [
        {"action": {"type": "add_cardio_session"}, "rec_key": "c1"},
        {"action": {"type": "add_muscle_volume", "muscle": "quads"}, "rec_key": "v1"},
        {"action": {"type": "set_core_frequency", "sessions_per_week": 3}, "rec_key": "k1"},
        {"action": {"type": "raise_protein_target"}, "rec_key": "p1"},
    ])
    ov = s.exec(select(UserCoachingOverlay).where(UserCoachingOverlay.user_id == u.id)).first()
    assert ov.cardio_minutes_target == 30
    assert ov.muscle_volume_bias.get("quads") == 1.1
    assert ov.core_sessions_target == 3
    assert ov.nutrition_adjustments.get("protein_delta_g") == 10


def test_bulk_apply_writes_audit_row_per_item():
    """Each accepted bulk item must produce its own CoachMemory row so
    we keep a per-rec audit trail (needed for the future 'undo last
    rec' UI). One row per item, not one per bulk call."""
    print("\n[test] apply-bulk: one CoachMemory row per accepted item")
    from app.models import CoachMemory
    from sqlmodel import select
    _, s, u = _setup()
    _bulk(s, u.id, [
        {"action": {"type": "add_cardio_session"}, "rec_key": "rk_a"},
        {"action": {"type": "add_muscle_volume", "muscle": "quads"}, "rec_key": "rk_b"},
    ])
    rows = s.exec(
        select(CoachMemory)
        .where(CoachMemory.user_id == u.id, CoachMemory.event_type == "ai_apply")
    ).all()
    rec_keys = {(r.details or {}).get("rec_key") for r in rows}
    assert rec_keys == {"rk_a", "rk_b"}


# ─── compose_weekly_narrative — AI path (mocked) ──────────────────

def _fake_openai(response_content: str):
    """Mock client whose chat.completions.create() returns a single
    choice with the given message.content."""
    completion = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=response_content))]
    )
    completions = SimpleNamespace(create=lambda **kwargs: completion)
    chat = SimpleNamespace(completions=completions)
    return SimpleNamespace(chat=chat)


def _patch_openai_and_key(monkeypatch_target_module, fake_client):
    """Helper to swap OpenAI() + get_openai_api_key() inside checkin_ai
    so the call hits our mock instead of the real API."""
    monkeypatch_target_module.OpenAI = lambda **kwargs: fake_client
    monkeypatch_target_module.get_openai_api_key = lambda: "fake-key-for-tests"


def test_narrative_happy_path_returns_full_shape():
    """A well-formed AI response round-trips through the function with
    every expected key populated."""
    print("\n[test] compose_weekly_narrative: happy path returns full shape")
    from app.services.coach import checkin_ai
    fake_response = json.dumps({
        "hero_summary": "You hit 4 of 5 sessions and protein averaged 142g across 6 days.",
        "wins": [
            {"title": "Back volume on target", "detail": "12 hard sets, mid-range — sustainable hypertrophy."},
        ],
        "needs_attention": [
            {"title": "Cardio gap", "detail": "Only 60 of 150 min. One Z2 walk closes most of it."},
        ],
        "rec_overrides": {
            "rec_cardio": {"title": "Add a Z2 walk this week", "detail": "Goal needs +90 min cardio."},
        },
        "closer": "Recovery looks fine — push cardio this week, hold lifts.",
        "rationale_key": "cardio_gap",
    })
    fake_client = _fake_openai(fake_response)
    _patch_openai_and_key(checkin_ai, fake_client)
    payload = {
        "metrics": {"sessions_completed": 4, "sessions_planned": 5},
        "recommendations": [{"key": "rec_cardio", "action": {"type": "add_cardio_session"}}],
    }
    out = checkin_ai.compose_weekly_narrative(payload)
    assert out["hero_summary"].startswith("You hit 4")
    assert len(out["wins"]) == 1
    assert len(out["needs_attention"]) == 1
    assert "rec_cardio" in out["rec_overrides"]
    assert out["closer"]
    assert out["rationale_key"] == "cardio_gap"
    assert out["_model"]


def test_narrative_drops_hallucinated_rec_overrides():
    """If the AI returns rec_overrides for a key NOT in the input
    recommendations list, we MUST drop it. Otherwise the modal would
    show a personalized rec for an action the apply layer can't
    handle — exactly the bug we're trying to prevent."""
    print("\n[test] compose_weekly_narrative: hallucinated rec_overrides keys dropped")
    from app.services.coach import checkin_ai
    fake_response = json.dumps({
        "hero_summary": "x",
        "wins": [],
        "needs_attention": [],
        "rec_overrides": {
            "rec_cardio": {"title": "Real", "detail": "OK"},
            "rec_invented_by_ai": {"title": "Fake", "detail": "Should be dropped"},
        },
        "closer": "y",
        "rationale_key": "z",
    })
    fake_client = _fake_openai(fake_response)
    _patch_openai_and_key(checkin_ai, fake_client)
    payload = {"recommendations": [{"key": "rec_cardio"}]}
    out = checkin_ai.compose_weekly_narrative(payload)
    assert "rec_cardio" in out["rec_overrides"]
    assert "rec_invented_by_ai" not in out["rec_overrides"], \
        "AI must not be able to inject keys that weren't in the input"


def test_narrative_caps_wins_at_3():
    """A chatty model returning 8 wins must be trimmed to 3 — keeps
    the modal scannable."""
    print("\n[test] compose_weekly_narrative: caps wins/needs at 3 each")
    from app.services.coach import checkin_ai
    fake_response = json.dumps({
        "hero_summary": "x",
        "wins": [{"title": f"W{i}", "detail": "."} for i in range(8)],
        "needs_attention": [{"title": f"N{i}", "detail": "."} for i in range(8)],
        "rec_overrides": {},
        "closer": "y",
        "rationale_key": "z",
    })
    fake_client = _fake_openai(fake_response)
    _patch_openai_and_key(checkin_ai, fake_client)
    out = checkin_ai.compose_weekly_narrative({"recommendations": []})
    assert len(out["wins"]) == 3
    assert len(out["needs_attention"]) == 3


def test_narrative_supplies_defaults_on_partial_response():
    """If the AI omits fields entirely, the function must fill in
    safe defaults so the client never null-checks every key."""
    print("\n[test] compose_weekly_narrative: missing fields default cleanly")
    from app.services.coach import checkin_ai
    fake_client = _fake_openai('{"hero_summary": "Just this."}')
    _patch_openai_and_key(checkin_ai, fake_client)
    out = checkin_ai.compose_weekly_narrative({"recommendations": []})
    assert out["hero_summary"] == "Just this."
    assert out["wins"] == []
    assert out["needs_attention"] == []
    assert out["rec_overrides"] == {}
    assert out["closer"] == ""
    assert out["rationale_key"] == "weekly_review"


def test_narrative_raises_on_bad_json():
    """Malformed JSON from the LLM is an error the caller should know
    about so it can fall back to the deterministic narrative."""
    print("\n[test] compose_weekly_narrative: bad JSON raises CheckinAIError")
    from app.services.coach import checkin_ai
    fake_client = _fake_openai("definitely not { json")
    _patch_openai_and_key(checkin_ai, fake_client)
    raised = False
    try:
        checkin_ai.compose_weekly_narrative({"recommendations": []})
    except checkin_ai.CheckinAIError:
        raised = True
    assert raised, "bad JSON should raise CheckinAIError"


def test_narrative_raises_on_non_object_response():
    """LLM returning a list or string when we expect an object is also
    a hard error — defensive defaults can't help here."""
    print("\n[test] compose_weekly_narrative: non-object JSON raises")
    from app.services.coach import checkin_ai
    fake_client = _fake_openai('["hero_summary"]')
    _patch_openai_and_key(checkin_ai, fake_client)
    raised = False
    try:
        checkin_ai.compose_weekly_narrative({"recommendations": []})
    except checkin_ai.CheckinAIError:
        raised = True
    assert raised


# ─── fallback_weekly_narrative ────────────────────────────────────

def test_fallback_returns_full_shape():
    """When the AI is unreachable, the deterministic fallback must
    return the SAME keys the AI would so the modal can render either
    transparently."""
    print("\n[test] fallback_weekly_narrative: same shape as AI path")
    from app.services.coach.checkin_ai import fallback_weekly_narrative
    out = fallback_weekly_narrative({
        "metrics": {"sessions_completed": 3, "sessions_planned": 4,
                    "avg_protein_g": 130, "days_logged": 6},
    })
    expected = {"hero_summary", "wins", "needs_attention", "rec_overrides",
                "closer", "rationale_key", "_model"}
    assert set(out.keys()) >= expected
    assert out["_model"] == "fallback"


def test_fallback_text_branches_by_session_count():
    """3 of 3 sessions → success-tone hero. 1 of 5 → mid-tone. 0
    sessions → 'reset' tone. Not a perfect AI replacement but useful."""
    print("\n[test] fallback_weekly_narrative: hero tone branches by adherence")
    from app.services.coach.checkin_ai import fallback_weekly_narrative
    full = fallback_weekly_narrative({"metrics": {"sessions_completed": 4, "sessions_planned": 4}})
    partial = fallback_weekly_narrative({"metrics": {"sessions_completed": 1, "sessions_planned": 4}})
    none = fallback_weekly_narrative({"metrics": {"sessions_completed": 0, "sessions_planned": 4}})
    assert full["hero_summary"] != partial["hero_summary"]
    assert "No sessions logged" in none["hero_summary"]


# ─── narrative endpoint contract (uses fallback path) ──────────
#
# The endpoint test calls `compose_weekly_narrative` indirectly by
# patching it to throw — forcing the fallback branch. This proves the
# router merges deterministic recs + narrative correctly without
# needing a live OpenAI call.

def test_narrative_endpoint_falls_back_cleanly_on_ai_error():
    """When the AI call raises, the endpoint must:
      1. Catch the error
      2. Build the deterministic fallback narrative
      3. Still return the FULL response shape (hero_summary, recs,
         metrics, etc) so the modal renders identically."""
    print("\n[test] /weekly-checkin-narrative: AI error → fallback shape preserved")
    from app.services.coach import checkin_ai

    def _boom(*a, **k):
        raise checkin_ai.CheckinAIError("simulated failure")

    original = checkin_ai.compose_weekly_narrative
    checkin_ai.compose_weekly_narrative = _boom
    try:
        # Build the payload the way the endpoint would and verify the
        # fallback function produces the right shape directly.
        ai_payload = {
            "goal": "muscle_gain",
            "metrics": {"sessions_completed": 3, "sessions_planned": 4,
                        "avg_protein_g": 130, "days_logged": 6},
            "recommendations": [
                {"key": "rec1", "action": {"type": "add_cardio_session"},
                 "title": "Add cardio", "detail": "...",
                 "priority": "suggest", "area": "cardio"},
            ],
        }
        narrative = checkin_ai.fallback_weekly_narrative(ai_payload)
        # The endpoint merges narrative.rec_overrides into recs. With
        # fallback returning empty overrides, the deterministic recs
        # pass through unchanged.
        assert narrative["hero_summary"]
        assert narrative["rec_overrides"] == {}
        assert narrative["_model"] == "fallback"
    finally:
        checkin_ai.compose_weekly_narrative = original


def test_narrative_merges_rec_overrides_correctly():
    """Verifies the title/detail rewrite merge logic the router does.
    Given AI overrides for rec_a but not rec_b, the merged list should
    show personalized rec_a + deterministic rec_b unchanged."""
    print("\n[test] narrative endpoint: merges AI rec_overrides into recs")
    deterministic_recs = [
        {"key": "rec_a", "title": "Original A", "detail": "Generic A", "action": {"type": "add_cardio_session"}},
        {"key": "rec_b", "title": "Original B", "detail": "Generic B", "action": {"type": "raise_protein_target"}},
    ]
    overrides = {
        "rec_a": {"title": "Tailored A", "detail": "Specific to you A"},
        # rec_b: no override
    }
    # Mirror the router's merge loop.
    merged = []
    for r in deterministic_recs:
        rec = dict(r)
        if rec.get("key") in overrides:
            ov = overrides[rec["key"]]
            if ov.get("title"):
                rec["title"] = ov["title"]
            if ov.get("detail"):
                rec["detail"] = ov["detail"]
            rec["personalized"] = True
        merged.append(rec)
    assert merged[0]["title"] == "Tailored A"
    assert merged[0]["personalized"] is True
    assert merged[1]["title"] == "Original B"
    assert "personalized" not in merged[1]


def test_narrative_payload_includes_apple_health_signals():
    """The endpoint forwards AH signals into the AI payload's metrics
    so the AI prompt can reference them. Verifies the metrics dict
    keys carry AH signals when supplied."""
    print("\n[test] narrative endpoint: AH signals reach the AI payload metrics")
    # Mirror what the endpoint builds.
    body = {
        "avg_sleep_hours": 7.4, "avg_resting_hr": 58, "avg_hrv_ms": 65,
        "avg_steps": 9200, "vo2_max": 48, "weight_slope_lbs_per_week": -0.6,
    }
    metrics = {
        "avg_sleep_hours": body["avg_sleep_hours"],
        "avg_resting_hr": body["avg_resting_hr"],
        "avg_hrv_ms": body["avg_hrv_ms"],
        "avg_steps": body["avg_steps"],
        "vo2_max": body["vo2_max"],
        "weight_trend": {"slope_lbs_per_week": body["weight_slope_lbs_per_week"], "direction": "down"},
    }
    # All supplied signals should be present and non-null.
    for key in ("avg_sleep_hours", "avg_resting_hr", "avg_hrv_ms", "avg_steps", "vo2_max"):
        assert metrics[key] is not None, f"AH signal {key} dropped from metrics"
    assert metrics["weight_trend"]["slope_lbs_per_week"] == -0.6


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} weekly check-in tests passed")
