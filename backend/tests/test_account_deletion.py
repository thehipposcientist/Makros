"""Account deletion removes sensitive per-user rows and anonymizes identifiers."""
from __future__ import annotations

import os
import sys
from datetime import date, datetime, timezone

os.environ.setdefault("SECRET_KEY", "test-secret-key-for-account-deletion-123456")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlmodel import SQLModel, Session, create_engine, select

from app.models import (
    ActivityFeedItem,
    BillingEvent,
    CycleLog,
    DailyStressSummary,
    FeedComment,
    FitnessScoreSnapshot,
    FoodSubmission,
    HealthLabResult,
    ImportBatch,
    IntegrationCredential,
    TrainerClientNote,
    TrainerClientRelationship,
    TrainerProfile,
    User,
    UserReport,
    WorkoutTemplate,
    WorkoutTemplateBundle,
    WorkoutTemplateBundleItem,
)
from app.routers.profile import delete_account


def _engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return engine


def _count(session: Session, model) -> int:
    return len(session.exec(select(model)).all())


def test_delete_account_cleans_sensitive_owned_tables_and_identifiers():
    engine = _engine()
    try:
        with Session(engine) as session:
            user = User(
                email="delete-me@example.com",
                username="deleteme",
                hashed_password="x",
                first_name="Delete",
                last_name="Me",
                apple_sub="apple-delete",
                google_sub="google-delete",
                email_verified_at=datetime.now(timezone.utc),
                subscription_tier="pro",
                subscription_status="active",
                subscription_source="revenuecat",
                subscription_product_id="thallo_pro_monthly",
                revenuecat_original_app_user_id="rc-user",
                revenuecat_original_transaction_id="txn-123",
            )
            other = User(email="other@example.com", username="otheruser", hashed_password="x")
            session.add(user)
            session.add(other)
            session.commit()
            session.refresh(user)
            session.refresh(other)

            session.add(BillingEvent(provider="revenuecat", event_id="evt-delete", event_type="INITIAL_PURCHASE", user_id=user.id, payload={}))
            session.add(HealthLabResult(user_id=user.id, lab_type="a1c", value=5.1, unit="%", collected_at=datetime.now(timezone.utc)))
            session.add(DailyStressSummary(user_id=user.id, summary_date=date.today(), avg_stress=54, max_stress=72, latest_stress=58))
            session.add(CycleLog(user_id=user.id, period_start_date=date.today()))
            session.add(FitnessScoreSnapshot(user_id=user.id, snapshot_date=date.today(), total=80, strength=80, cardio=80, consistency=80, recovery=80))
            session.add(IntegrationCredential(user_id=user.id, provider="strava", access_token="secret"))
            session.add(ImportBatch(user_id=user.id, source="csv", data_type="workouts"))
            session.add(WorkoutTemplate(user_id=user.id, client_id="tmpl-1", name="Template", workout_json={}))
            bundle = WorkoutTemplateBundle(user_id=user.id, name="Bundle", share_code="BUNDLE01")
            session.add(bundle)
            session.flush()
            session.add(WorkoutTemplateBundleItem(bundle_id=bundle.id, share_code="TMPL01"))
            user_feed = ActivityFeedItem(user_id=user.id, payload={"caption": "private"})
            other_feed = ActivityFeedItem(user_id=other.id, payload={})
            session.add(user_feed)
            session.add(other_feed)
            session.flush()
            session.add(FeedComment(user_id=other.id, feed_item_id=user_feed.id, body="comment on deleted user post"))
            session.add(FeedComment(user_id=user.id, feed_item_id=other_feed.id, body="deleted user comment"))
            session.add(UserReport(reporter_id=user.id, reported_user_id=other.id, reason="other"))
            session.add(UserReport(reporter_id=other.id, reported_user_id=user.id, reason="other"))
            session.add(TrainerProfile(user_id=user.id, display_name="Deleted Coach"))
            rel = TrainerClientRelationship(
                trainer_user_id=user.id,
                client_user_id=other.id,
                requested_by_id=user.id,
                status="active",
            )
            session.add(rel)
            session.flush()
            session.add(TrainerClientNote(
                relationship_id=rel.id,
                trainer_user_id=user.id,
                client_user_id=other.id,
                author_user_id=user.id,
                body="delete me",
            ))
            session.add(FoodSubmission(user_id=other.id, name="Reviewed food", reviewed_by_user_id=user.id))
            session.commit()

            response = delete_account(current_user=user, session=session)
            session.refresh(user)

            assert response["status"] == "deleted"
            for model in (
                BillingEvent,
                HealthLabResult,
                DailyStressSummary,
                CycleLog,
                FitnessScoreSnapshot,
                IntegrationCredential,
                ImportBatch,
                WorkoutTemplate,
                WorkoutTemplateBundle,
                WorkoutTemplateBundleItem,
                FeedComment,
                UserReport,
                TrainerProfile,
                TrainerClientRelationship,
                TrainerClientNote,
            ):
                assert _count(session, model) == 0, model.__name__

            remaining_feed = session.exec(select(ActivityFeedItem)).all()
            assert len(remaining_feed) == 1
            assert remaining_feed[0].user_id == other.id
            submission = session.exec(select(FoodSubmission)).first()
            assert submission is not None
            assert submission.reviewed_by_user_id is None
            assert user.is_active is False
            assert user.email.startswith("deleted+")
            assert user.username.startswith("deleted_user_")
            assert user.first_name is None
            assert user.last_name is None
            assert user.apple_sub is None
            assert user.google_sub is None
            assert user.email_verified_at is None
            assert user.subscription_tier == "free"
            # NULL — "deleted" is rejected by the ck_user_subscription_status_values
            # CHECK constraint; a deleted account simply has no subscription status.
            assert user.subscription_status is None
            assert user.revenuecat_original_app_user_id is None
            assert user.revenuecat_original_transaction_id is None
    finally:
        engine.dispose()
    print("PASS test_delete_account_cleans_sensitive_owned_tables_and_identifiers")


cases = [
    test_delete_account_cleans_sensitive_owned_tables_and_identifiers,
]
