"""Coach chat — photo attachments + multi-turn history.

Tests focus on payload shape: when a question carries an image_base64,
the user-message content must be multipart with text + image_url. When
the request includes a `conversation` history, prior turns must end up
in the messages list ahead of the latest user turn, capped to 6.

These don't hit OpenAI — we monkey-patch `_chat_create` so the test
captures the request kwargs and asserts on them.
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _captured_messages_handler(captured: list[dict]):
    """Return a fake `_chat_create` that records the messages it was
    called with and produces a minimal valid SCHEMA_WORKOUT_QUESTION
    response so the endpoint returns 200."""
    class _Msg:
        def __init__(self, content: str):
            self.content = content
    class _Choice:
        def __init__(self, content: str):
            self.message = _Msg(content)
    class _Resp:
        def __init__(self, content: str):
            self.choices = [_Choice(content)]

    def fake_chat_create(client, **kwargs):
        captured.append(kwargs)
        return _Resp(json.dumps({
            "answer": "ok",
            "quick_cues": ["cue"],
            "adjustment": "",
            "safety_note": "",
        }))
    return fake_chat_create


def _setup_client(captured: list[dict], *, subscription_tier: str = "pro"):
    """Spin up FastAPI test client with auth + chat_create mocked.
    Returns (client, auth_dependency_override)."""
    from app.main import app
    from app.auth import get_current_user
    from app.models import User
    from app.routers.ai import chat as chat_mod

    fake_user = User(
        id=1,
        email="t@t",
        username="t",
        hashed_password="x",
        subscription_tier=subscription_tier,
    )
    app.dependency_overrides[get_current_user] = lambda: fake_user

    # Force the API-key gate to pass.
    chat_mod.get_openai_api_key = lambda: "test-key-not-real"  # type: ignore
    chat_mod._chat_create = _captured_messages_handler(captured)  # type: ignore

    return TestClient(app)


# ─── Photo attachment ─────────────────────────────────────────────────────────

def test_workout_question_requires_pro():
    print("\n[test] coach: workout question blocks free users")
    captured: list[dict] = []
    client = _setup_client(captured, subscription_tier="free")

    r = client.post("/ai/workout-question", json={
        "question": "How should I cue this lift?",
        "workout": {"name": "Push"},
        "activeExerciseName": "Bench Press",
    })
    assert r.status_code == 403, r.text
    assert "Thallo Pro" in r.json().get("detail", "")
    assert captured == []
    _ok("free users are blocked before coach LLM call")

def test_text_only_question_uses_string_content():
    """A plain question without a photo: latest user message has plain
    string content (no multipart). Sanity check we didn't accidentally
    multipart-wrap text-only calls."""
    print("\n[test] coach: text-only payload uses string content")
    captured: list[dict] = []
    client = _setup_client(captured)

    r = client.post("/ai/workout-question", json={
        "question": "How should I cue this lift?",
        "workout": {"name": "Push"},
        "activeExerciseName": "Bench Press",
    })
    assert r.status_code == 200, r.text
    msgs = captured[-1]["messages"]
    last_user = msgs[-1]
    assert last_user["role"] == "user"
    assert isinstance(last_user["content"], str), (
        f"expected str content for text-only, got {type(last_user['content']).__name__}"
    )
    _ok("text-only question → string user content")


def test_photo_question_uses_multipart_content():
    """When image_base64 is present, latest user content is a list of
    [{type:'text', text:...}, {type:'image_url', image_url:...}]."""
    print("\n[test] coach: photo payload uses multipart content")
    captured: list[dict] = []
    client = _setup_client(captured)

    # Tiny valid JPEG (single white pixel) so _fix_image_mime is happy.
    import base64
    minimal_jpeg = base64.b64encode(
        b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'
        b'\xff\xdb\x00C\x00' + b'\x10' * 64 +
        b'\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00'
        b'\xff\xc4\x00\x14\x00\x01' + b'\x00' * 15 + b'\x00'
        b'\xff\xc4\x00\x14\x10\x01' + b'\x00' * 15 + b'\x00'
        b'\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xfd\xfa\xff\xd9'
    ).decode()

    r = client.post("/ai/workout-question", json={
        "question": "Is my knee tracking right?",
        "workout": {"name": "Squat day"},
        "activeExerciseName": "Back Squat",
        "image_base64": minimal_jpeg,
        "mime_type": "image/jpeg",
    })
    assert r.status_code == 200, r.text
    last_user = captured[-1]["messages"][-1]
    assert isinstance(last_user["content"], list), (
        f"expected list content for image, got {type(last_user['content']).__name__}"
    )
    types = [p.get("type") for p in last_user["content"]]
    assert "text" in types and "image_url" in types, types
    img_part = next(p for p in last_user["content"] if p["type"] == "image_url")
    assert img_part["image_url"]["url"].startswith("data:image/")
    _ok("photo question → multipart user content with image_url")


# ─── Multi-turn ───────────────────────────────────────────────────────────────

def test_conversation_history_passed_through():
    """Prior turns (capped at 6) appear before the latest user message
    in the OpenAI messages list."""
    print("\n[test] coach: conversation history reaches OpenAI messages")
    captured: list[dict] = []
    client = _setup_client(captured)

    convo = [
        {"role": "user", "content": "Knees caving on rep 3"},
        {"role": "assistant", "content": "Push them out actively"},
    ]
    r = client.post("/ai/workout-question", json={
        "question": "Now what about my back?",
        "workout": {"name": "Lower"},
        "activeExerciseName": "Squat",
        "conversation": convo,
    })
    assert r.status_code == 200, r.text
    msgs = captured[-1]["messages"]
    # Expect: system, user, assistant, user(latest) = 4 messages
    assert len(msgs) == 4, f"expected 4 messages, got {len(msgs)}"
    assert msgs[0]["role"] == "system"
    assert msgs[1] == {"role": "user", "content": "Knees caving on rep 3"}
    assert msgs[2] == {"role": "assistant", "content": "Push them out actively"}
    assert msgs[3]["role"] == "user"
    assert "back" in str(msgs[3]["content"]).lower()
    _ok("history threaded into OpenAI messages list")


def test_conversation_history_capped_at_six():
    """Sending 10 prior turns: only the last 6 land in the prompt."""
    print("\n[test] coach: history capped at 6 turns")
    captured: list[dict] = []
    client = _setup_client(captured)

    convo = []
    for i in range(10):
        convo.append({"role": "user", "content": f"q{i}"})
        convo.append({"role": "assistant", "content": f"a{i}"})

    r = client.post("/ai/workout-question", json={
        "question": "follow-up",
        "workout": {},
        "activeExerciseName": "X",
        "conversation": convo,
    })
    assert r.status_code == 200, r.text
    msgs = captured[-1]["messages"]
    # system + at most 6 history + 1 latest = 8 max
    history_len = len(msgs) - 2  # subtract system + latest user
    assert history_len <= 6, f"expected ≤6 history turns, got {history_len}"
    _ok(f"history truncated to {history_len} turns (cap=6)")


def test_invalid_history_entries_filtered():
    """Backend-side filter drops dicts with bad role / empty content
    even when Pydantic accepts them (since `conversation: list[dict]`
    is intentionally loose). We only assert on shapes Pydantic admits."""
    print("\n[test] coach: malformed history entries filtered out")
    captured: list[dict] = []
    client = _setup_client(captured)

    convo = [
        {"role": "system", "content": "should be filtered"},   # wrong role
        {"role": "user", "content": ""},                        # empty content
        {"role": "user", "content": "valid"},                   # ✅ kept
        {"role": "assistant", "content": "also valid"},         # ✅ kept
        {"role": "made_up", "content": "rejected"},             # unknown role
        {"content": "no role at all"},                          # missing role
    ]
    r = client.post("/ai/workout-question", json={
        "question": "follow-up",
        "workout": {},
        "activeExerciseName": "X",
        "conversation": convo,
    })
    assert r.status_code == 200, r.text
    msgs = captured[-1]["messages"]
    # Only the two valid history turns should appear
    history_msgs = [m for m in msgs if m["role"] in ("user", "assistant") and m is not msgs[-1]]
    assert len(history_msgs) == 2, f"expected 2 valid history turns, got {len(history_msgs)} ({history_msgs})"
    assert history_msgs[0]["content"] == "valid"
    assert history_msgs[1]["content"] == "also valid"
    _ok("malformed history entries filtered before LLM call")


cases = [
    test_workout_question_requires_pro,
    test_text_only_question_uses_string_content,
    test_photo_question_uses_multipart_content,
    test_conversation_history_passed_through,
    test_conversation_history_capped_at_six,
    test_invalid_history_entries_filtered,
]


if __name__ == "__main__":
    import sys
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
    sys.exit(1 if failures else 0)
