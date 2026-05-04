"""Subscription entitlement helpers fail closed."""
from __future__ import annotations

import os

from app.entitlements import default_subscription_tier, tier_of


class _User:
    def __init__(self, subscription_tier=None):
        self.subscription_tier = subscription_tier


def _set_beta(value: str | None):
    previous = os.environ.get("BETA_FULL_ACCESS_ENABLED")
    if value is None:
        os.environ.pop("BETA_FULL_ACCESS_ENABLED", None)
    else:
        os.environ["BETA_FULL_ACCESS_ENABLED"] = value
    return previous


def _restore_beta(previous: str | None) -> None:
    if previous is None:
        os.environ.pop("BETA_FULL_ACCESS_ENABLED", None)
    else:
        os.environ["BETA_FULL_ACCESS_ENABLED"] = previous


def test_default_subscription_tier_fails_closed():
    previous = _set_beta(None)
    try:
        assert default_subscription_tier() == "free"
    finally:
        _restore_beta(previous)
    print("PASS test_default_subscription_tier_fails_closed")


def test_beta_flag_is_explicit_server_side():
    previous = _set_beta("1")
    try:
        assert default_subscription_tier() == "pro"
    finally:
        _restore_beta(previous)
    print("PASS test_beta_flag_is_explicit_server_side")


def test_unknown_tier_normalizes_to_free():
    assert tier_of(_User(None)) == "free"
    assert tier_of(_User("paid")) == "free"
    assert tier_of(_User("pro")) == "pro"
    print("PASS test_unknown_tier_normalizes_to_free")


cases = [
    test_default_subscription_tier_fails_closed,
    test_beta_flag_is_explicit_server_side,
    test_unknown_tier_normalizes_to_free,
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
