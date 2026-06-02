from __future__ import annotations

import base64
import json

from fastapi.testclient import TestClient


def _minimal_jpeg_b64() -> str:
    return base64.b64encode(
        b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'
        b'\xff\xdb\x00C\x00' + b'\x10' * 64 +
        b'\xff\xc0\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00'
        b'\xff\xc4\x00\x14\x00\x01' + b'\x00' * 15 + b'\x00'
        b'\xff\xc4\x00\x14\x10\x01' + b'\x00' * 15 + b'\x00'
        b'\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xfd\xfa\xff\xd9'
    ).decode()


def _setup_client(captured: list[dict], *, subscription_tier: str = "pro") -> TestClient:
    from app.main import app
    from app.models import User
    from app.routers.auth import get_current_user
    from app.routers import gear as gear_mod

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
            "name": "Bowflex 552",
            "gear_type": "other",
            "estimated_miles": None,
            "retirement_threshold_miles": None,
            "confidence": "high",
            "notes": "Looks like adjustable dumbbells.",
        }))

    fake_user = User(
        id=1,
        email="t@t",
        username="t",
        hashed_password="x",
        subscription_tier=subscription_tier,
    )
    app.dependency_overrides[get_current_user] = lambda: fake_user
    gear_mod.get_openai_api_key = lambda: "test-key-not-real"  # type: ignore
    # Gear ID is coarse recognition, so it runs on the light vision model.
    gear_mod.model_image_light = lambda: "gpt-4o-mini"  # type: ignore
    gear_mod._chat_create = fake_chat_create  # type: ignore
    return TestClient(app)


def test_gear_photo_identification_requires_pro():
    print("\n[test] gear photo identification blocks free users")
    captured: list[dict] = []
    client = _setup_client(captured, subscription_tier="free")

    response = client.post("/gear/identify", json={"images": [_minimal_jpeg_b64()]})
    assert response.status_code == 403, response.text
    assert "Thallo Pro" in response.json().get("detail", "")
    assert captured == []
    print("  ✓ free users are blocked before gear vision call")


def test_gear_photo_identification_uses_configured_vision_model():
    print("\n[test] gear photo identification uses configured vision model")
    captured: list[dict] = []
    client = _setup_client(captured)

    response = client.post("/gear/identify", json={"images": [_minimal_jpeg_b64()]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Bowflex 552"
    assert body["confidence"] == "high"

    kwargs = captured[-1]
    assert kwargs["model"] == "gpt-4o-mini"
    assert "max_tokens" in kwargs, kwargs
    assert "max_completion_tokens" not in kwargs, kwargs
    assert kwargs["messages"][1]["role"] == "user"
    content = kwargs["messages"][1]["content"]
    assert any(part.get("type") == "image_url" for part in content), content
    assert any(part.get("type") == "text" for part in content), content
    print("  ✓ gear photo path uses model_image_light() and multipart vision input")


cases = [
    test_gear_photo_identification_requires_pro,
    test_gear_photo_identification_uses_configured_vision_model,
]
