"""Billing entitlement sync and RevenueCat webhook handling."""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from sqlmodel import SQLModel, Session, create_engine, select

from app.entitlements import revenuecat_app_user_id
from app.models import BillingEvent, User
from app.routers.billing import mock_checkout, mock_downgrade
from app.services.billing import apply_revenuecat_event, cancel_signup_trial


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine, tables=[User.__table__, BillingEvent.__table__])
    return engine


def _user(session: Session, *, tier: str = "free", status: str = "free") -> User:
    user = User(
        email=f"billing-{tier}-{status}@example.com",
        username=f"billing_{tier}_{status}",
        hashed_password="x",
        subscription_tier=tier,
        subscription_status=status,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def _event(user: User, event_type: str, **overrides):
    expires = datetime.now(timezone.utc) + timedelta(days=30)
    payload = {
        "api_version": "1.0",
        "event": {
            "id": f"evt_{event_type.lower()}_{user.id}",
            "type": event_type,
            "app_user_id": revenuecat_app_user_id(user),
            "original_app_user_id": revenuecat_app_user_id(user),
            "entitlement_ids": ["pro"],
            "product_id": "thallo_pro_monthly",
            "store": "APP_STORE",
            "environment": "SANDBOX",
            "transaction_id": f"tx_{event_type.lower()}_{user.id}",
            "original_transaction_id": f"otx_{user.id}",
            "expiration_at_ms": int(expires.timestamp() * 1000),
            "event_timestamp_ms": int(datetime.now(timezone.utc).timestamp() * 1000),
        },
    }
    payload["event"].update(overrides)
    return payload


def _set_dummy_billing(value: str | None):
    previous = os.environ.get("DUMMY_BILLING_ENABLED")
    if value is None:
        os.environ.pop("DUMMY_BILLING_ENABLED", None)
    else:
        os.environ["DUMMY_BILLING_ENABLED"] = value
    return previous


def _restore_dummy_billing(previous: str | None) -> None:
    if previous is None:
        os.environ.pop("DUMMY_BILLING_ENABLED", None)
    else:
        os.environ["DUMMY_BILLING_ENABLED"] = previous


def test_revenuecat_purchase_grants_pro():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session)
            result = apply_revenuecat_event(session, _event(user, "INITIAL_PURCHASE"))
            refreshed = session.get(User, user.id)
            assert result["status"] == "processed"
            assert refreshed is not None
            assert refreshed.subscription_tier == "pro"
            assert refreshed.subscription_status == "active"
            assert refreshed.subscription_source == "revenuecat"
            assert refreshed.subscription_product_id == "thallo_pro_monthly"
    finally:
        engine.dispose()
    print("PASS test_revenuecat_purchase_grants_pro")


def test_revenuecat_trial_purchase_preserves_trial_dates():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session)
            purchased_at = datetime.now(timezone.utc)
            expires_at = purchased_at + timedelta(days=7)
            apply_revenuecat_event(session, _event(
                user,
                "INITIAL_PURCHASE",
                period_type="TRIAL",
                purchased_at_ms=int(purchased_at.timestamp() * 1000),
                expiration_at_ms=int(expires_at.timestamp() * 1000),
            ))
            refreshed = session.get(User, user.id)
            assert refreshed is not None
            assert refreshed.subscription_tier == "pro"
            assert refreshed.subscription_status == "trialing"
            assert refreshed.trial_ends_at is not None
    finally:
        engine.dispose()
    print("PASS test_revenuecat_trial_purchase_preserves_trial_dates")


def test_mock_billing_switches_signup_trial_immediately():
    previous_dummy = _set_dummy_billing("1")
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session, tier="pro", status="trialing")
            trial_end = datetime.now(timezone.utc) + timedelta(days=6)
            user.subscription_source = "signup_trial"
            user.subscription_product_id = "signup_trial"
            user.subscription_entitlement_id = "pro"
            user.trial_started_at = datetime.now(timezone.utc) - timedelta(days=1)
            user.trial_ends_at = trial_end
            user.subscription_expires_at = trial_end
            session.add(user)
            session.commit()
            session.refresh(user)

            downgraded = mock_downgrade(user, session)
            refreshed = session.get(User, user.id)
            assert downgraded["subscription_tier"] == "free"
            assert downgraded["subscription_status"] == "free"
            assert downgraded["trial_ends_at"] is None
            assert refreshed is not None
            assert refreshed.subscription_tier == "free"
            assert refreshed.subscription_status == "free"
            assert refreshed.subscription_source == "mock"
            assert refreshed.subscription_product_id is None
            assert refreshed.subscription_entitlement_id is None
            assert refreshed.subscription_expires_at is None
            assert refreshed.trial_started_at is None
            assert refreshed.trial_ends_at is None

            upgraded = mock_checkout(refreshed, session)
            refreshed = session.get(User, user.id)
            assert upgraded["subscription_tier"] == "pro"
            assert upgraded["subscription_status"] == "active"
            assert upgraded["trial_ends_at"] is None
            assert refreshed is not None
            assert refreshed.subscription_tier == "pro"
            assert refreshed.subscription_status == "active"
            assert refreshed.subscription_source == "mock"
            assert refreshed.trial_started_at is None
            assert refreshed.trial_ends_at is None
    finally:
        engine.dispose()
        _restore_dummy_billing(previous_dummy)
    print("PASS test_mock_billing_switches_signup_trial_immediately")


def test_revenuecat_expiration_revokes_pro():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session, tier="pro", status="active")
            expired = datetime.now(timezone.utc) - timedelta(minutes=5)
            apply_revenuecat_event(session, _event(
                user,
                "EXPIRATION",
                expiration_at_ms=int(expired.timestamp() * 1000),
            ))
            refreshed = session.get(User, user.id)
            assert refreshed is not None
            assert refreshed.subscription_tier == "free"
            assert refreshed.subscription_status == "expired"
    finally:
        engine.dispose()
    print("PASS test_revenuecat_expiration_revokes_pro")


def test_revenuecat_duplicate_event_is_idempotent():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session)
            payload = _event(user, "INITIAL_PURCHASE", id="evt_duplicate")
            first = apply_revenuecat_event(session, payload)
            second = apply_revenuecat_event(session, payload)
            rows = session.exec(select(BillingEvent).where(BillingEvent.event_id == "evt_duplicate")).all()
            assert first["status"] == "processed"
            assert second["status"] == "duplicate"
            assert len(rows) == 1
    finally:
        engine.dispose()
    print("PASS test_revenuecat_duplicate_event_is_idempotent")


def test_cancel_signup_trial_switches_to_free_immediately():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session, tier="pro", status="trialing")
            user.subscription_source = "signup_trial"
            user.trial_started_at = datetime.now(timezone.utc) - timedelta(days=1)
            user.trial_ends_at = datetime.now(timezone.utc) + timedelta(days=6)
            user.subscription_expires_at = user.trial_ends_at
            session.add(user)
            session.commit()
            session.refresh(user)

            result = cancel_signup_trial(session, user)
            refreshed = session.get(User, user.id)
            assert result.subscription_tier == "free"
            assert result.subscription_status == "free"
            assert refreshed is not None
            assert refreshed.subscription_tier == "free"
            assert refreshed.subscription_status == "free"
            assert refreshed.subscription_expires_at is None
            assert refreshed.trial_started_at is None
            assert refreshed.trial_ends_at is None
    finally:
        engine.dispose()
    print("PASS test_cancel_signup_trial_switches_to_free_immediately")


def test_cancel_signup_trial_rejects_revenuecat_trial():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = _user(session, tier="pro", status="trialing")
            user.subscription_source = "revenuecat"
            user.trial_ends_at = datetime.now(timezone.utc) + timedelta(days=6)
            session.add(user)
            session.commit()
            session.refresh(user)

            try:
                cancel_signup_trial(session, user)
                raise AssertionError("expected revenuecat trial cancellation to fail")
            except Exception as exc:
                assert getattr(exc, "status_code", None) == 400
    finally:
        engine.dispose()
    print("PASS test_cancel_signup_trial_rejects_revenuecat_trial")


cases = [
    test_revenuecat_purchase_grants_pro,
    test_revenuecat_trial_purchase_preserves_trial_dates,
    test_mock_billing_switches_signup_trial_immediately,
    test_revenuecat_expiration_revokes_pro,
    test_revenuecat_duplicate_event_is_idempotent,
    test_cancel_signup_trial_switches_to_free_immediately,
    test_cancel_signup_trial_rejects_revenuecat_trial,
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
