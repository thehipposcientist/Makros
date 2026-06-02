"""AI Coach injury-confirmation guard.

The chat prompt instructs the model to ask the user before saving an
injury. The guard is the safety net: even if a model emits
`updated_injuries` early, the backend strips it unless the user's most
recent message reads as an explicit affirmative confirmation.
"""
from __future__ import annotations

from app.routers.ai.chat import (
    _enforce_injury_confirmation_guard,
    _user_confirmed_injury,
)


def _ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def _ai_result_with_injury() -> dict:
    return {
        "answer": "Saved your shoulder limitation.",
        "updated_injuries": [
            {"id": "x", "bodyPart": "Shoulder", "status": "active",
             "severity": "moderate", "muscleGroups": ["shoulders"]},
        ],
        "injury_clarification_needed": False,
    }


def test_strips_unconfirmed_injury_proposal() -> None:
    """First-mention turn — no user confirmation in convo → strip."""
    print("\n[test] guard strips unconfirmed updated_injuries")
    convo = [
        {"role": "user", "content": "my shoulder hurts when I bench"},
        {"role": "assistant", "content": "Sounds like you might..."},
    ]
    result = _enforce_injury_confirmation_guard(_ai_result_with_injury(), conversation=convo)
    assert result["updated_injuries"] is None, result
    assert result["injury_clarification_needed"] is True, result
    _ok("unconfirmed injury proposal blocked")


def test_keeps_confirmed_injury_proposal() -> None:
    """Affirmative reply on the user's most recent turn → leave intact."""
    print("\n[test] guard preserves confirmed updated_injuries")
    convo = [
        {"role": "user", "content": "my shoulder hurts when I bench"},
        {"role": "assistant", "content": "Want me to save this as a shoulder limitation?"},
        {"role": "user", "content": "yes please save it"},
    ]
    result = _enforce_injury_confirmation_guard(_ai_result_with_injury(), conversation=convo)
    assert result["updated_injuries"] is not None, result
    assert len(result["updated_injuries"]) == 1, result
    _ok("confirmed injury proposal kept")


def test_soft_replies_dont_count_as_confirmation() -> None:
    """`maybe`, `idk`, hedges should not trigger the save."""
    print("\n[test] hedges do not pass as confirmation")
    for hedge in ("maybe", "idk", "i guess", "I'm not sure"):
        convo = [
            {"role": "assistant", "content": "Want me to save this as an injury?"},
            {"role": "user", "content": hedge},
        ]
        assert _user_confirmed_injury(convo) is False, hedge
    _ok("hedges correctly rejected")


def test_affirmative_phrases_match() -> None:
    """A representative set of confirmations all pass."""
    print("\n[test] affirmatives recognized")
    confirmations = [
        "yes",
        "yeah save it",
        "yep",
        "sure",
        "ok",
        "okay",
        "go ahead",
        "sounds good",
        "sounds right",
        "do it",
        "please save it",
        "add the injury",
        "confirmed",
    ]
    for phrase in confirmations:
        convo = [
            {"role": "assistant", "content": "Save this as an injury?"},
            {"role": "user", "content": phrase},
        ]
        assert _user_confirmed_injury(convo) is True, phrase
    _ok(f"{len(confirmations)} affirmative phrases recognized")


def test_empty_conversation_blocks_save() -> None:
    """No history → can't be confirmed → must strip."""
    print("\n[test] empty/None conversation blocks save")
    for convo in (None, [], [{"role": "assistant", "content": "..."}]):
        result = _enforce_injury_confirmation_guard(_ai_result_with_injury(), conversation=convo)
        assert result["updated_injuries"] is None, result
    _ok("missing/AI-only convo correctly blocks save")


def test_guard_passthrough_when_no_injury() -> None:
    """Result without updated_injuries is left untouched."""
    print("\n[test] guard ignores results without updated_injuries")
    base = {"answer": "ok", "updated_injuries": None, "injury_clarification_needed": False}
    out = _enforce_injury_confirmation_guard(base, conversation=[
        {"role": "user", "content": "no thanks"},
    ])
    assert out == base, out
    _ok("non-injury responses unchanged")


if __name__ == "__main__":
    import sys

    cases = [
        test_strips_unconfirmed_injury_proposal,
        test_keeps_confirmed_injury_proposal,
        test_soft_replies_dont_count_as_confirmation,
        test_affirmative_phrases_match,
        test_empty_conversation_blocks_save,
        test_guard_passthrough_when_no_injury,
    ]
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
    print(f"\nAll {len(cases)} test_injury_confirmation_guard tests passed")
