"""CORS configuration guardrails."""
from __future__ import annotations

from app.cors import resolve_cors_config


def test_dev_defaults_to_wildcard_without_credentials_bug():
    cfg = resolve_cors_config({})
    assert cfg.allow_origins == ["*"]
    assert cfg.allow_credentials is False
    print("PASS test_dev_defaults_to_wildcard_without_credentials_bug")


def test_prod_empty_cors_disables_browser_origins():
    cfg = resolve_cors_config({"APP_ENV": "production"})
    assert cfg.allow_origins == []
    assert cfg.allow_credentials is False
    print("PASS test_prod_empty_cors_disables_browser_origins")


def test_prod_rejects_wildcard_origins():
    try:
        resolve_cors_config({"APP_ENV": "production", "CORS_ORIGINS": "*"})
    except RuntimeError as exc:
        assert "cannot include '*'" in str(exc)
    else:
        raise AssertionError("production wildcard CORS should fail closed")
    print("PASS test_prod_rejects_wildcard_origins")


def test_specific_origins_keep_credentials_enabled():
    cfg = resolve_cors_config({
        "APP_ENV": "production",
        "CORS_ORIGINS": "https://thallo.app, https://www.thallo.app",
    })
    assert cfg.allow_origins == ["https://thallo.app", "https://www.thallo.app"]
    assert cfg.allow_credentials is True
    print("PASS test_specific_origins_keep_credentials_enabled")


cases = [
    test_dev_defaults_to_wildcard_without_credentials_bug,
    test_prod_empty_cors_disables_browser_origins,
    test_prod_rejects_wildcard_origins,
    test_specific_origins_keep_credentials_enabled,
]


if __name__ == "__main__":
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as exc:
            failures += 1
            print(f"FAIL {case.__name__}: {exc}")
    raise SystemExit(0 if failures == 0 else 1)
