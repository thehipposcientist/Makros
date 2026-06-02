"""Meal image provider tests."""
from __future__ import annotations

import os


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def test_pexels_disabled_without_key() -> None:
    from app.services.nutrition import food_image_provider as provider

    old_key = os.environ.pop("PEXELS_API_KEY", None)
    provider._CACHE.clear()
    try:
        assert provider.resolve_food_image("Chicken rice bowl") == (None, None, None)
    finally:
        if old_key is not None:
            os.environ["PEXELS_API_KEY"] = old_key
    _ok("Pexels image lookup is disabled without a key")


def test_pexels_search_maps_photo_url() -> None:
    from app.services.nutrition import food_image_provider as provider

    old_key = os.environ.get("PEXELS_API_KEY")
    old_urlopen = provider._urlreq.urlopen
    provider._CACHE.clear()

    class _Resp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            import json
            return json.dumps({
                "photos": [
                    {"src": {"landscape": "https://images.pexels.com/photos/1/meal.jpeg?auto=compress"}},
                ]
            }).encode("utf-8")

    def _fake_urlopen(req, *, timeout):
        assert req.full_url.startswith("https://api.pexels.com/v1/search?")
        assert req.get_header("Authorization") == "test-key"
        assert "healthy+meal" in req.full_url
        assert timeout <= 3.0
        return _Resp()

    os.environ["PEXELS_API_KEY"] = "test-key"
    provider._urlreq.urlopen = _fake_urlopen
    try:
        url, source, confidence = provider.resolve_food_image(
            "Chicken rice bowl",
            items=[{"food_name": "Chicken breast"}, {"food_name": "Brown rice"}],
        )
    finally:
        provider._urlreq.urlopen = old_urlopen
        provider._CACHE.clear()
        if old_key is None:
            os.environ.pop("PEXELS_API_KEY", None)
        else:
            os.environ["PEXELS_API_KEY"] = old_key

    assert url == "https://images.pexels.com/photos/1/meal.jpeg?auto=compress"
    assert source == "pexels"
    assert confidence and confidence > 0.7
    _ok("Pexels response maps to pexels image source")


if __name__ == "__main__":
    test_pexels_disabled_without_key()
    test_pexels_search_maps_photo_url()
    print("\n✅ test_food_image_provider.py PASSED")
