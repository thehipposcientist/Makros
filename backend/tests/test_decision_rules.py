"""Tests for `services.coach.decision_rules.gate`.

The gate is the safety layer between AI suggestions and durable plan
mutations. If broken: hallucinated AI deltas could cut a user's
calories by 1000+ kcal in one shot, or push deep program changes
without enough data.

Coverage:
  - response_type passthrough for coach_only / leave_alone / ask_more
  - data sufficiency: <4 days logged → coach_only downgrade
  - cooldown: small_adjust within 14d → leave_alone (unless high flag)
  - cooldown: deep_review within 21d → small_adjust (unless high flag)
  - deep_review requires 2+ med/high flags
  - small_adjust requires at least one med/high flag
  - kcal clamping: small caps at ±100, deep at ±250
  - high-severity flag bypasses cooldown
  - unknown response_type → coach_only
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import User, AIDecision  # noqa: F401
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _setup():
    from sqlmodel import Session
    from app.models import User
    engine = _make_engine()
    s = Session(engine)
    u = User(email="gate@example.com", username="gate", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    return s, u


def _payload_with_logged(days_logged: int, *, flags: list[dict] | None = None) -> dict:
    return {
        "metrics_trends": {"w7": {"days_logged": days_logged}},
        "flags": flags or [],
    }


def _payload_with_workout_review(
    recommendation: str = "small_adjust",
    *,
    adherence_pct: float = 50.0,
    missed: int = 1,
) -> dict:
    return {
        "metrics_trends": {"w7": {"days_logged": 0}},
        "flags": [],
        "recommendation": recommendation,
        "evaluation": {
            "adherencePct": adherence_pct,
            "sessionsLogged": 1,
            "sessionsPlanned": 3,
            "counts": {"hit": 0, "partial": 1, "missed": missed},
            "commitments": [
                {
                    "kind": "cardio_count",
                    "bucket": "missed" if missed else "partial",
                    "promised": "2x cardio",
                    "actual": "0x cardio",
                    "deltaPct": 0.0,
                }
            ],
        },
        "weekly_review": {
            "sessions_planned": 3,
            "sessions_completed": 1,
            "adherence_pct": adherence_pct,
            "days_logged": 0,
            "recommendations": [
                {
                    "area": "workout",
                    "priority": "warn" if recommendation == "deep_review" else "suggest",
                    "title": "Adjust next week",
                    "action": {"type": "change_days_per_week", "value": 2},
                }
            ],
        },
    }


# ── Passthrough cases (no delta, no gating) ─────────────────────

def test_coach_only_passes_through():
    print("\n[test] gate: coach_only passes through unchanged")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "coach_only", "message": "Stay the course."},
        _payload_with_logged(7),
        s, u.id,
    )
    assert res.response_type == "coach_only"
    assert res.delta is None
    assert res.overrides == []


def test_leave_alone_passes_through():
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "leave_alone", "message": "Hold."},
        _payload_with_logged(7),
        s, u.id,
    )
    assert res.response_type == "leave_alone"
    assert res.delta is None


def test_ask_more_passes_through():
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "ask_more", "message": "How are you sleeping?"},
        _payload_with_logged(7),
        s, u.id,
    )
    assert res.response_type == "ask_more"


def test_unknown_response_type_downgrades_to_coach_only():
    print("\n[test] gate: unknown response_type → coach_only")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "rewrite_everything", "message": "boom"},
        _payload_with_logged(7),
        s, u.id,
    )
    assert res.response_type == "coach_only"
    assert any("unknown response_type" in o for o in res.overrides)


def test_deterministic_recommendation_overrides_ai_response_type():
    """The rules engine already picked the weekly recommendation; the LLM
    can phrase it, but cannot silently downgrade it."""
    print("\n[test] gate: deterministic recommendation overrides AI response_type")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "coach_only", "message": "looks okay"},
        _payload_with_workout_review("small_adjust"),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert any("deterministic recommendation" in o for o in res.overrides)


def test_workout_review_evidence_allows_adjustment_without_meal_logs():
    """Workout recommendations should not be flattened just because the
    user did not log enough meals this week."""
    print("\n[test] gate: workout evidence allows small_adjust without nutrition logs")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": None, "message": "trim the week"},
        _payload_with_workout_review("small_adjust"),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert any("deterministic weekly evaluation" in o for o in res.overrides)


def test_workout_only_adjustment_strips_nutrition_delta():
    """If the evidence is workout-only, keep the program recommendation
    but remove macro deltas that lack nutrition support."""
    print("\n[test] gate: workout-only evidence strips kcal/protein delta")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {
            "response_type": "small_adjust",
            "delta": {"kcal": -100, "protein_g": 30},
            "message": "trim the week",
        },
        _payload_with_workout_review("small_adjust"),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert res.delta is None
    assert any("nutrition delta removed" in o for o in res.overrides)


def test_deep_review_can_be_supported_by_deterministic_evaluation():
    print("\n[test] gate: deterministic deep_review can pass without flag rows")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "deep_review", "delta": None, "message": "review the week"},
        _payload_with_workout_review("deep_review", adherence_pct=25.0, missed=2),
        s, u.id,
    )
    assert res.response_type == "deep_review"
    assert any("deep_review allowed" in o for o in res.overrides)


# ── Data sufficiency ───────────────────────────────────────────

def test_small_adjust_downgrades_when_under_4_days_logged():
    """The user has only 2 days of logged data — adjustments require
    at least 4 days so the AI isn't reacting to one bad day."""
    print("\n[test] gate: <4 days logged → small_adjust downgrades to coach_only")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -100},
         "message": "cut a bit"},
        _payload_with_logged(2, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "coach_only"
    assert res.delta is None
    assert any("insufficient data" in o for o in res.overrides)


def test_deep_review_downgrades_when_under_4_days_logged():
    print("\n[test] gate: <4 days logged → deep_review downgrades")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "deep_review", "delta": {"kcal": -200},
         "message": "rework"},
        _payload_with_logged(3, flags=[{"severity": "high"}, {"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "coach_only"
    assert res.delta is None


# ── Flag-severity gating ──────────────────────────────────────

def test_small_adjust_requires_at_least_one_med_or_high_flag():
    """Without any meaningful flag, small_adjust is downgraded so the
    AI can't randomly nudge calories on a clean week."""
    print("\n[test] gate: small_adjust with no flags → coach_only")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -100},
         "message": "trim"},
        _payload_with_logged(7, flags=[{"severity": "low"}]),
        s, u.id,
    )
    assert res.response_type == "coach_only"
    assert res.delta is None


def test_small_adjust_with_med_flag_passes():
    print("\n[test] gate: small_adjust with med flag passes through")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -50},
         "message": "trim"},
        _payload_with_logged(7, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert res.delta == {"kcal": -50}


def test_deep_review_requires_2_med_or_high_flags():
    """Single med flag is enough for small_adjust but not for deep_review."""
    print("\n[test] gate: deep_review with 1 med flag → small_adjust")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "deep_review", "delta": {"kcal": -200},
         "message": "rework"},
        _payload_with_logged(7, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "small_adjust"


def test_deep_review_with_one_high_flag_passes():
    """A single high-severity flag bypasses the 2-flag rule."""
    print("\n[test] gate: deep_review with 1 high flag passes")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "deep_review", "delta": {"kcal": -200},
         "message": "rework"},
        _payload_with_logged(7, flags=[{"severity": "high"}]),
        s, u.id,
    )
    assert res.response_type == "deep_review"


def test_deep_review_with_2_med_flags_passes():
    print("\n[test] gate: deep_review with 2 med flags passes")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "deep_review", "delta": {"kcal": -200},
         "message": "rework"},
        _payload_with_logged(7, flags=[{"severity": "med"}, {"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "deep_review"


# ── Kcal clamping ────────────────────────────────────────────

def test_small_adjust_kcal_capped_at_100():
    """small_adjust hard cap is ±100 kcal."""
    print("\n[test] gate: small_adjust kcal=-300 clamped to -100")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -300},
         "message": "trim"},
        _payload_with_logged(7, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert res.delta["kcal"] == -100, \
        f"expected clamp to -100, got {res.delta['kcal']}"


def test_deep_review_kcal_capped_at_250():
    """deep_review hard cap is ±250 kcal."""
    print("\n[test] gate: deep_review kcal=-500 clamped to -250")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "deep_review", "delta": {"kcal": -500},
         "message": "rework"},
        _payload_with_logged(7, flags=[{"severity": "high"}]),
        s, u.id,
    )
    assert res.response_type == "deep_review"
    assert res.delta["kcal"] == -250


def test_small_adjust_kcal_within_cap_unclamped():
    print("\n[test] gate: small_adjust kcal=-50 not clamped")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -50},
         "message": "trim"},
        _payload_with_logged(7, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.delta["kcal"] == -50


def test_small_adjust_protein_delta_capped_at_20g():
    """small_adjust also caps protein, not only calories."""
    print("\n[test] gate: small_adjust protein_g=80 clamped to +20g")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "small_adjust", "delta": {"protein_g": 80},
         "message": "raise protein"},
        _payload_with_logged(7, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert res.delta["protein_g"] == 20
    assert any("protein delta clamped" in o for o in res.overrides)


def test_no_prior_commitments_with_logged_sessions_is_coach_only():
    """No commitments means there is nothing to grade; logged sessions
    should not become a fake 0% adherence deep review."""
    print("\n[test] evaluator: no commitments + sessions logged → coach_only")
    from datetime import date
    from app.services.coach.checkin_evaluator import WeeklyEvaluation, recommend_from_evaluation
    today = date.today()
    ev = WeeklyEvaluation(week_start=today, week_end=today, sessions_logged=2)
    assert recommend_from_evaluation(ev) == "coach_only"


# ── Cooldown ────────────────────────────────────────────────

def _seed_recent_decision(s, user_id, *, days_ago: int, response_type: str):
    """Insert an AIDecision row N days ago to drive the cooldown check."""
    from app.models import AIDecision
    when = datetime.now(timezone.utc) - timedelta(days=days_ago)
    # AIDecision has many required fields; populate with safe defaults.
    decision = AIDecision(
        user_id=user_id,
        response_type=response_type,
        checkin_type="weekly",
        message="prior decision",
        delta={"kcal": -50},
        rationale_key=None,
        created_at=when,
    )
    s.add(decision); s.commit()


def test_small_adjust_in_cooldown_falls_to_leave_alone():
    """Adjusted 5 days ago, no high flag → cooldown blocks small_adjust."""
    print("\n[test] gate: small_adjust within 14d cooldown → leave_alone")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    _seed_recent_decision(s, u.id, days_ago=5, response_type="small_adjust")
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -50},
         "message": "trim"},
        _payload_with_logged(7, flags=[{"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "leave_alone"
    assert any("cooldown" in o for o in res.overrides)


def test_high_flag_bypasses_cooldown():
    """A high-severity flag overrides the cooldown — user has a real
    problem, can't wait 14 days."""
    print("\n[test] gate: high flag bypasses cooldown")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    _seed_recent_decision(s, u.id, days_ago=3, response_type="small_adjust")
    res = gate(
        {"response_type": "small_adjust", "delta": {"kcal": -100},
         "message": "trim"},
        _payload_with_logged(7, flags=[{"severity": "high"}]),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    assert res.delta == {"kcal": -100}


def test_deep_review_in_cooldown_falls_to_small_adjust():
    print("\n[test] gate: deep_review within 21d → small_adjust")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    _seed_recent_decision(s, u.id, days_ago=10, response_type="deep_review")
    res = gate(
        {"response_type": "deep_review", "delta": {"kcal": -200},
         "message": "rework"},
        _payload_with_logged(7, flags=[{"severity": "med"}, {"severity": "med"}]),
        s, u.id,
    )
    assert res.response_type == "small_adjust"
    # Now small_adjust caps kcal at 100.
    assert res.delta["kcal"] == -100


# ── Default message handling ──────────────────────────────────

def test_empty_message_gets_default():
    print("\n[test] gate: missing message gets default 'Keep going.'")
    from app.services.coach.decision_rules import gate
    s, u = _setup()
    res = gate(
        {"response_type": "coach_only"},
        _payload_with_logged(7),
        s, u.id,
    )
    assert res.message == "Keep going."


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
    print(f"\nAll {len(test_fns)} decision_rules tests passed")
