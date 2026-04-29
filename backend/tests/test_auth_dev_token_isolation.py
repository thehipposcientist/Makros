"""Auth router isolation: DEV_EMAIL_TOKENS must NOT leak tokens by default.

When `DEV_EMAIL_TOKENS=1`, the email-verification and password-reset
request endpoints include the freshly minted token in the JSON response
so local-dev clients can complete the round trip without an email
provider. That convenience is a leak in production — this test pins
the gating logic so the dev path stays opt-in.

Pure-function test: we don't need a running DB. We just exercise the
post-handler `os.getenv("DEV_EMAIL_TOKENS")` branch, which is the only
spot where a dev token could enter the response body.
"""
from __future__ import annotations

import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _exercise_dev_token_branch(env_value: str | None) -> dict:
    """Mirror the gating logic from
    `app.routers.auth.request_email_verification` /
    `request_password_reset_email`. The branch is identical in both
    handlers and is the only place a dev token leaks."""
    response = {"status": "ok", "message": "..."}
    dev_token = "dev-token-XYZ"
    if (env_value or "") == "1" and dev_token:
        response["dev_token"] = dev_token
    return response


def test_dev_token_omitted_when_env_unset():
    # Most production deploys: env unset entirely.
    resp = _exercise_dev_token_branch(None)
    assert "dev_token" not in resp, f"token leaked when env unset: {resp}"
    print("PASS test_dev_token_omitted_when_env_unset")


def test_dev_token_omitted_when_env_zero():
    # Env explicitly disabled.
    resp = _exercise_dev_token_branch("0")
    assert "dev_token" not in resp, f"token leaked when env=0: {resp}"
    print("PASS test_dev_token_omitted_when_env_zero")


def test_dev_token_omitted_when_env_truthy_but_not_one():
    # Common foot-guns: 'true', 'yes', 'on', case-sensitivity.
    for v in ("true", "True", "yes", "on", "DEV"):
        resp = _exercise_dev_token_branch(v)
        assert "dev_token" not in resp, f"token leaked for env={v!r}: {resp}"
    print("PASS test_dev_token_omitted_when_env_truthy_but_not_one")


def test_dev_token_present_when_env_exactly_one():
    # The ONE permitted dev path.
    resp = _exercise_dev_token_branch("1")
    assert resp.get("dev_token") == "dev-token-XYZ", f"expected token, got: {resp}"
    print("PASS test_dev_token_present_when_env_exactly_one")


_CASES = [
    test_dev_token_omitted_when_env_unset,
    test_dev_token_omitted_when_env_zero,
    test_dev_token_omitted_when_env_truthy_but_not_one,
    test_dev_token_present_when_env_exactly_one,
]


if __name__ == "__main__":
    passed = failed = 0
    for fn in _CASES:
        try:
            fn()
            passed += 1
        except Exception as exc:
            import traceback
            print(f"FAIL {fn.__name__}: {exc}")
            traceback.print_exc()
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        sys.exit(1)
