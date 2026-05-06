"""Social notifications.

Covers the in-app notification stream for friend requests, accepted
requests, and feed likes. The payload assertions also guard the social
privacy boundary: no calories/body metrics in notification payloads.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import ActivityFeedItem, FeedLike, Friendship, SocialNotification, User, UserSocialProfile
from app.routers.social import (
    FriendRequestBody,
    accept_friend,
    get_feed,
    list_notifications,
    mark_all_notifications_read,
    mark_notification_read,
    request_friend,
    toggle_like,
    write_activity,
)


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


def _user(s: Session, uid: int, username: str) -> User:
    u = User(
        id=uid,
        email=f"{username}@test.thallo",
        username=username,
        hashed_password="x",
        is_active=True,
    )
    s.add(u)
    s.add(UserSocialProfile(
        user_id=uid,
        display_name=username.title(),
        share_activity_enabled=True,
    ))
    return u


def _accepted_friendship(s: Session, a: int, b: int) -> Friendship:
    lo, hi = sorted((a, b))
    fs = Friendship(
        user_a_id=lo,
        user_b_id=hi,
        status="accepted",
        requested_by=lo,
        requested_at=datetime.now(timezone.utc),
        accepted_at=datetime.now(timezone.utc),
    )
    s.add(fs)
    return fs


def test_friend_request_creates_unread_notification():
    print("\n[test] friend request creates unread notification")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        bob = _user(s, 2, "bob")
        s.commit()

        request_friend(FriendRequestBody(username="bob"), current_user=alice, db=s)

        result = list_notifications(current_user=bob, db=s)
        assert result.unread_count == 1
        assert len(result.items) == 1
        n = result.items[0]
        assert n.notification_type == "friend_request"
        assert n.subject_type == "friendship"
        assert n.actor_username == "alice"
        assert n.payload["friendship_id"] == n.subject_id
    _ok("incoming request appears as one unread social notification")


def test_accept_friend_creates_notification_for_requester_and_marks_read():
    print("\n[test] accepting friend request notifies requester and can be marked read")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        bob = _user(s, 2, "bob")
        s.commit()

        pending = request_friend(FriendRequestBody(username="bob"), current_user=alice, db=s)
        accept_friend(pending.friendship_id, current_user=bob, db=s)

        result = list_notifications(current_user=alice, db=s)
        assert result.unread_count == 1
        assert result.items[0].notification_type == "friend_accept"
        assert result.items[0].actor_username == "bob"

        mark_notification_read(result.items[0].id, current_user=alice, db=s)
        result = list_notifications(current_user=alice, db=s)
        assert result.unread_count == 0
        assert result.items[0].read_at is not None
    _ok("accept notification lands for requester and read state persists")


def test_like_notification_is_sanitized_and_deduped():
    print("\n[test] feed like notification is sanitized and deduped")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        bob = _user(s, 2, "bob")
        _accepted_friendship(s, 1, 2)
        item = ActivityFeedItem(
            user_id=2,
            event_type="workout_completed",
            payload={
                "focus": "Push",
                "duration_seconds": 2700,
                "date": "2026-05-05",
                "calories": 600,
                "body_weight_lbs": 185,
                "exercises": [
                    {"name": "Bench Press", "sets": [{"reps": 5, "weight_lbs": 225}]},
                ],
            },
        )
        s.add(item)
        s.commit()
        s.refresh(item)

        assert toggle_like(item.id, current_user=alice, db=s) == {"liked": True, "like_count": 1}
        assert toggle_like(item.id, current_user=alice, db=s) == {"liked": False, "like_count": 0}
        assert toggle_like(item.id, current_user=alice, db=s) == {"liked": True, "like_count": 1}

        rows = s.exec(select(SocialNotification)).all()
        assert len(rows) == 1

        result = list_notifications(current_user=bob, db=s)
        assert result.unread_count == 1
        n = result.items[0]
        assert n.notification_type == "feed_like"
        assert n.actor_username == "alice"
        dumped = json.dumps(n.payload).lower()
        assert "weight" not in dumped
        assert "calorie" not in dumped
        assert n.payload["focus"] == "Push"
    _ok("like notification avoids duplicate rows and sensitive payloads")


def test_feed_like_persists_and_hydrates_on_posts():
    print("\n[test] feed likes persist and hydrate back onto posts")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        _user(s, 2, "bob")
        _accepted_friendship(s, 1, 2)
        item = ActivityFeedItem(
            user_id=2,
            event_type="workout_post",
            payload={
                "caption": "Solid push day.",
                "workout_summary": {
                    "focus": "Push",
                    "duration_seconds": 2700,
                    "date": "2026-05-05",
                    "exercises": [],
                },
            },
        )
        s.add(item)
        s.commit()
        s.refresh(item)

        liked = toggle_like(item.id, current_user=alice, db=s)
        assert liked == {"liked": True, "like_count": 1}

        rows = s.exec(select(FeedLike).where(FeedLike.feed_item_id == item.id)).all()
        assert len(rows) == 1
        assert rows[0].user_id == alice.id

        feed = get_feed(current_user=alice, db=s)
        hydrated = next(i for i in feed["items"] if i["id"] == item.id)
        assert hydrated["like_count"] == 1
        assert hydrated["liked_by_me"] is True

        unliked = toggle_like(item.id, current_user=alice, db=s)
        assert unliked == {"liked": False, "like_count": 0}
        rows = s.exec(select(FeedLike).where(FeedLike.feed_item_id == item.id)).all()
        assert rows == []
    _ok("post like row is stored, read into feed state, and removed on unlike")


def test_feed_limit_counts_workout_days_not_pr_rows():
    print("\n[test] feed limit counts workout days, not same-day PR rows")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        _user(s, 2, "bob")
        _accepted_friendship(s, 1, 2)
        today = datetime(2026, 5, 6, 18, 0, tzinfo=timezone.utc)
        yesterday = datetime(2026, 5, 5, 18, 0, tzinfo=timezone.utc)
        s.add(ActivityFeedItem(
            user_id=2,
            event_type="workout_completed",
            payload={"focus": "Pull", "duration_seconds": 2400, "date": "2026-05-05", "exercises": []},
            created_at=yesterday,
        ))
        s.add(ActivityFeedItem(
            user_id=2,
            event_type="workout_completed",
            payload={"focus": "Push", "duration_seconds": 2700, "date": "2026-05-06", "exercises": []},
            created_at=today,
        ))
        for idx in range(30):
            s.add(ActivityFeedItem(
                user_id=2,
                event_type="pr_achieved",
                payload={"exercise": f"Lift {idx}", "pr_type": "heaviest_weight", "date": "2026-05-06"},
                created_at=today.replace(minute=min(59, idx + 1)),
            ))
        s.commit()

        feed = get_feed(limit=2, current_user=alice, db=s)
        workout_dates = [
            item["payload"]["date"]
            for item in feed["items"]
            if item["event_type"] == "workout_completed"
        ]
        assert workout_dates == ["2026-05-06", "2026-05-05"]
    _ok("older workout days survive noisy PR activity from today")


def test_mark_all_notifications_read():
    print("\n[test] mark all social notifications read")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        bob = _user(s, 2, "bob")
        _user(s, 3, "casey")
        s.commit()

        request_friend(FriendRequestBody(username="bob"), current_user=alice, db=s)
        request_friend(FriendRequestBody(username="bob"), current_user=s.get(User, 3), db=s)
        result = list_notifications(current_user=bob, db=s)
        assert result.unread_count == 2

        updated = mark_all_notifications_read(current_user=bob, db=s)
        assert updated["updated"] == 2
        result = list_notifications(current_user=bob, db=s)
        assert result.unread_count == 0
    _ok("bulk read endpoint clears all unread social notifications")


def test_pr_feed_event_is_written_without_lift_value():
    print("\n[test] PR feed event is accepted but omits lift value")
    eng = _make_engine()
    with Session(eng) as s:
        alice = _user(s, 1, "alice")
        s.commit()

        write_activity(s, alice.id, "pr_achieved", {
            "exercise": "Bench Press",
            "pr_type": "heaviest_weight",
            "value": 225,
            "unit": "lbs",
            "date": "2026-05-05",
        })
        s.commit()

        item = s.exec(select(ActivityFeedItem)).first()
        assert item is not None
        assert item.event_type == "pr_achieved"
        dumped = json.dumps(item.payload).lower()
        assert "bench press" in dumped
        assert "value" not in dumped
        assert "225" not in dumped
    _ok("PR activity can attach to feed cards without exposing lift weight")


cases = [
    test_friend_request_creates_unread_notification,
    test_accept_friend_creates_notification_for_requester_and_marks_read,
    test_like_notification_is_sanitized_and_deduped,
    test_feed_like_persists_and_hydrates_on_posts,
    test_feed_limit_counts_workout_days_not_pr_rows,
    test_mark_all_notifications_read,
    test_pr_feed_event_is_written_without_lift_value,
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
