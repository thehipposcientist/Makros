"""Deterministic governance tests for AI routes and prompt outputs."""
from __future__ import annotations

import json
import sys

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import AIDecision, User
from app.routers.ai.chat import (
    _persist_trainer_setting_decision,
    _sanitize_trainer_setting_proposals,
)
from app.routers.ai.utils import (
    _PUBLIC_RATE_WINDOWS,
    _build_chat_kwargs,
    check_public_ai_rate_limit,
    model_image,
)
from app.services.coach.checkin_ai import _redacted_payload_for_openai


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_image_model_default_matches_policy() -> None:
    assert model_image() == "gpt-5.4-mini"
    _ok("image model fallback is the policy default")


def test_checkin_payload_redacts_direct_identity_fields() -> None:
    payload = {
        "profile": {
            "user_id": "42",
            "first_name": "Sawyer",
            "username": "sawyer",
            "display_name": "Sawyer H.",
            "email": "sawyer@example.com",
            "goal": "body_recomp",
        },
        "weekly_review": {"sessions_completed": 4},
    }

    redacted, user_id = _redacted_payload_for_openai(payload)
    encoded = json.dumps(redacted)

    assert user_id == 42
    assert "Sawyer" not in encoded
    assert "sawyer@example.com" not in encoded
    assert "username" not in encoded
    assert redacted["profile"]["goal"] == "body_recomp"
    _ok("check-in OpenAI payload strips direct account identifiers")


def test_public_ai_rate_limit_falls_back_after_limit() -> None:
    _PUBLIC_RATE_WINDOWS.clear()

    assert check_public_ai_rate_limit("127.0.0.1", bucket="match_goal", limit=2, window_secs=3600)
    assert check_public_ai_rate_limit("127.0.0.1", bucket="match_goal", limit=2, window_secs=3600)
    assert not check_public_ai_rate_limit("127.0.0.1", bucket="match_goal", limit=2, window_secs=3600)
    assert check_public_ai_rate_limit("127.0.0.1", bucket="other_bucket", limit=2, window_secs=3600)
    _ok("public onboarding AI throttle falls back after the configured window limit")


def test_chat_kwargs_carry_internal_accounting_metadata() -> None:
    kwargs = _build_chat_kwargs(
        "gpt-5.4-mini",
        [{"role": "user", "content": "Return JSON."}],
        max_tokens=200,
        timeout_secs=12,
        ai_route="/ai/test",
        ai_user_id=7,
        ai_budget_bucket="coach_chat",
        ai_image_count=1,
    )

    assert kwargs["max_completion_tokens"] == 200
    assert kwargs["ai_route"] == "/ai/test"
    assert kwargs["ai_user_id"] == 7
    assert kwargs["ai_budget_bucket"] == "coach_chat"
    assert kwargs["ai_image_count"] == 1
    _ok("shared chat kwargs preserve accounting metadata")


def test_home_trainer_prompt_output_eval_cases() -> None:
    cases = [
        {
            "label": "bucket goal alias maps to applyable frontend id",
            "profile": {"customMacros": {}},
            "result": {"updated_goal": "fat_loss", "updated_macros": None},
            "expected_goal": "lose_fat",
            "expected_macros": None,
        },
        {
            "label": "invalid goal is stripped",
            "profile": {"customMacros": {}},
            "result": {"updated_goal": "ultra_bulk", "updated_macros": None},
            "expected_goal": None,
            "expected_macros": None,
        },
        {
            "label": "macro proposal is bounded and capped against current target",
            "profile": {"customMacros": {"calories": 2400, "protein": 180, "carbs": 250}},
            "result": {
                "updated_goal": "muscle_gain",
                "updated_macros": {"calories": 5000, "protein": 1000, "carbs": 50, "unknown": 1},
                "action_items": [],
            },
            "expected_goal": "build_muscle",
            "expected_macros": {"calories": 2650, "protein": 220, "carbs": 150},
        },
    ]

    for case in cases:
        result = _sanitize_trainer_setting_proposals(dict(case["result"]), case["profile"])
        assert result["updated_goal"] == case["expected_goal"], case["label"]
        assert result["updated_macros"] == case["expected_macros"], case["label"]
    _ok(f"{len(cases)} Home Trainer prompt-output governance cases passed")


def test_home_trainer_setting_proposals_persist_as_unaccepted_decisions() -> None:
    engine = create_engine("sqlite:///:memory:")
    SQLModel.metadata.create_all(engine)

    with Session(engine) as session:
        user = User(
            email="ai-governance@example.com",
            username="ai_governance",
            hashed_password="x",
        )
        session.add(user)
        session.commit()
        session.refresh(user)

        result = {
            "answer": "I recommend switching to fat loss and lowering calories.",
            "updated_goal": "lose_fat",
            "updated_macros": {"calories": 2150},
        }
        _persist_trainer_setting_decision(session, user.id, result, model="gpt-4o-mini")

        row = session.exec(select(AIDecision)).one()
        assert row.user_id == user.id
        assert row.checkin_type == "trainer_chat"
        assert row.response_type == "coach_only"
        assert row.accepted is False
        assert row.delta == {"updated_goal": "lose_fat", "updated_macros": {"calories": 2150}}
        _ok("Home Trainer setting proposals persist for audit before user acceptance")


cases = [
    test_image_model_default_matches_policy,
    test_checkin_payload_redacts_direct_identity_fields,
    test_public_ai_rate_limit_falls_back_after_limit,
    test_chat_kwargs_carry_internal_accounting_metadata,
    test_home_trainer_prompt_output_eval_cases,
    test_home_trainer_setting_proposals_persist_as_unaccepted_decisions,
]


if __name__ == "__main__":
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
        print(f"\n{len(failed)} of {len(cases)} failed", file=sys.stderr)
        sys.exit(1)
    print(f"\nAll {len(cases)} ai_governance tests passed")
