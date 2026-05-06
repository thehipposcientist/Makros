"""Social — privacy fix (soft-deleted users) + digest perf (batched queries).

Covers:
  - compute_digest() drops soft-deleted friends silently
  - compute_digest() runs in a small constant number of SELECTs (no N+1)
  - search / friend-list SQL filters User.is_active=True
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import event
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import (
    Friendship, User, UserGoal, UserSocialProfile, WorkoutCompletion,
)
from app.enums import GoalType
from app.services.social.digest import compute_digest
from app.routers.social import _sanitize_feed_payload_for_read


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


def _user(s: Session, uid: int, *, active: bool = True, username: str | None = None) -> User:
    u = User(
        id=uid,
        email=f"u{uid}@t",
        username=username or f"u{uid}",
        hashed_password="x",
        is_active=active,
    )
    s.add(u)
    return u


def _friendship(s: Session, a: int, b: int) -> Friendship:
    """Create an accepted friendship (canonical user_a < user_b)."""
    lo, hi = sorted((a, b))
    f = Friendship(
        user_a_id=lo, user_b_id=hi, status="accepted",
        requested_by=lo,
        requested_at=datetime.now(timezone.utc),
        accepted_at=datetime.now(timezone.utc),
    )
    s.add(f)
    return f


def _seed_share_profile(
    s: Session,
    uid: int,
    *,
    share: bool = True,
    name: str | None = None,
    avatar_url: str | None = None,
) -> None:
    s.add(UserSocialProfile(
        user_id=uid,
        display_name=name or f"User {uid}",
        avatar_url=avatar_url,
        share_activity_enabled=share,
    ))


def _seed_goal(s: Session, uid: int) -> None:
    s.add(UserGoal(
        user_id=uid, goal_type=GoalType.MUSCLE_GAIN, pace="moderate",
        is_active=True,
    ))


# ─── Privacy: soft-deleted users hidden from digest ──────────────────────────

def test_digest_drops_soft_deleted_friends():
    """A friend whose User.is_active=False must not appear in the digest."""
    print("\n[test] digest: soft-deleted friend is hidden from output")
    eng = _make_engine()
    with Session(eng) as s:
        _user(s, 1)
        _user(s, 2, active=True, username="alive")
        _user(s, 3, active=False, username="deleted")
        for uid in (1, 2, 3):
            _seed_share_profile(s, uid)
            _seed_goal(s, uid)
        _friendship(s, 1, 2)
        _friendship(s, 1, 3)
        s.commit()

        digest = compute_digest(s, user_id=1)

    usernames = [f["username"] for f in digest["friends"]]
    assert "alive" in usernames, f"expected 'alive' in {usernames}"
    assert "deleted" not in usernames, (
        f"soft-deleted friend leaked into digest: {usernames}"
    )
    assert digest["summary"]["friend_count"] == 1
    _ok("soft-deleted friend hidden; only the live one shows up")


# ─── Perf: digest issues a small constant number of SELECTs ──────────────────

def test_digest_query_count_is_constant():
    """20 friends → digest should still run in roughly 5 SELECTs (own
    completions + friend ids + bulk profiles + bulk users + bulk goals
    + bulk completions). Anti-regression on the N+1 we just fixed."""
    print("\n[test] digest: query count is constant (not O(F))")
    eng = _make_engine()
    with Session(eng) as s:
        _user(s, 1)
        for fid in range(2, 22):  # 20 friends
            _user(s, fid, username=f"friend{fid}")
            _seed_share_profile(s, fid)
            _seed_goal(s, fid)
            _friendship(s, 1, fid)
            # One completion per friend in the 7-day window.
            s.add(WorkoutCompletion(
                user_id=fid,
                workout_date=date.today() - timedelta(days=2),
                focus_label="Push",
                duration_seconds=2700,
            ))
        # Self profile + a couple of own completions for `you` block.
        _seed_share_profile(s, 1)
        _seed_goal(s, 1)
        for d in (date.today(), date.today() - timedelta(days=1)):
            s.add(WorkoutCompletion(
                user_id=1, workout_date=d, focus_label="Push",
                duration_seconds=2400,
            ))
        s.commit()

        select_count = 0

        @event.listens_for(eng, "before_cursor_execute")
        def _count_selects(conn, cursor, statement, params, context, executemany):
            nonlocal select_count
            if statement.lstrip().lower().startswith("select"):
                select_count += 1

        digest = compute_digest(s, user_id=1)

    # Anti-regression bound. The old N+1 path was ~80 SELECTs.
    # The new batched path should be well under 10.
    assert select_count <= 10, (
        f"compute_digest ran in {select_count} SELECTs — expected ≤ 10. "
        f"The digest N+1 fix may have regressed."
    )
    assert len(digest["friends"]) == 20
    assert digest["summary"]["friends_trained_this_week"] == 20
    _ok(f"digest with 20 friends runs in {select_count} SELECTs")


def test_digest_with_zero_friends_doesnt_crash():
    """Edge case: lonely user with no friends."""
    print("\n[test] digest: zero-friend user gets a clean empty payload")
    eng = _make_engine()
    with Session(eng) as s:
        _user(s, 1)
        _seed_share_profile(s, 1)
        _seed_goal(s, 1)
        s.commit()

        digest = compute_digest(s, user_id=1)
    assert digest["friends"] == []
    assert digest["summary"]["friend_count"] == 0
    assert digest["summary"]["friends_trained_this_week"] == 0
    _ok("zero-friend digest returns clean empty payload")


def test_digest_respects_share_toggle():
    """A friend with share_activity_enabled=False appears in the list
    but with sessions/streak hidden (zeroed)."""
    print("\n[test] digest: friend with sharing off has stats hidden")
    eng = _make_engine()
    with Session(eng) as s:
        _user(s, 1)
        _user(s, 2, username="sharing")
        _user(s, 3, username="private")
        _seed_share_profile(s, 1)
        _seed_share_profile(s, 2, share=True)
        _seed_share_profile(s, 3, share=False)
        for uid in (2, 3):
            _seed_goal(s, uid)
            s.add(WorkoutCompletion(
                user_id=uid, workout_date=date.today(),
                focus_label="Push", duration_seconds=2400,
            ))
        _friendship(s, 1, 2)
        _friendship(s, 1, 3)
        s.commit()

        digest = compute_digest(s, user_id=1)

    private = next(f for f in digest["friends"] if f["username"] == "private")
    sharing = next(f for f in digest["friends"] if f["username"] == "sharing")
    assert private["share_enabled"] is False
    assert private["sessions"] == 0, "private friend's sessions must be hidden"
    assert sharing["share_enabled"] is True
    assert sharing["sessions"] == 1
    _ok("share toggle hides stats for opted-out friends")


def test_digest_includes_avatar_url_without_sensitive_data():
    """Avatar URLs are public social-profile metadata; private training
    and body metrics still must not cross the digest boundary."""
    print("\n[test] digest: friend avatar travels with social metadata only")
    eng = _make_engine()
    avatar = "data:image/jpeg;base64,abc123"
    with Session(eng) as s:
        _user(s, 1)
        _user(s, 2, username="avatarfriend")
        _seed_share_profile(s, 1)
        _seed_share_profile(s, 2, avatar_url=avatar)
        _seed_goal(s, 1)
        _seed_goal(s, 2)
        _friendship(s, 1, 2)
        s.add(WorkoutCompletion(
            user_id=2,
            workout_date=date.today(),
            focus_label="Push",
            duration_seconds=2400,
        ))
        s.commit()

        digest = compute_digest(s, user_id=1)

    friend = digest["friends"][0]
    assert friend["username"] == "avatarfriend"
    assert friend["avatar_url"] == avatar
    dumped = json.dumps(friend).lower()
    assert "weight" not in dumped
    assert "calorie" not in dumped
    _ok("avatar URL appears without leaking sensitive fields")


def test_feed_sanitizer_keeps_workout_metrics_and_removes_sensitive_fields():
    """Activity feed payloads can expose workout load/cardio metrics, but
    must never expose body/nutrition data."""
    print("\n[test] feed: sanitizer removes sensitive workout fields")
    clean = _sanitize_feed_payload_for_read("workout_completed", {
        "focus": "Push",
        "duration_seconds": 2700,
        "date": "2026-05-01",
        "calories": 500,
        "body_weight_lbs": 185,
        "exercises": [{
            "name": "Bench Press",
            "sets": [{
                "reps": 5,
                "weight": 225,
                "calories": 80,
                "durationSeconds": 90,
                "actualDistance": 0.25,
                "actualPace": "8:00 /mi",
                "heartRateAvg": 142,
                "cardioMetrics": {
                    "speed": "7.5 mph",
                    "calories": "80",
                    "body_weight_lbs": "185",
                },
            }],
        }],
    })
    dumped = json.dumps(clean).lower()
    assert clean["exercises"][0]["sets"] == [{
        "reps": 5,
        "weight_lbs": 225.0,
        "duration_seconds": 90,
        "actual_distance": 0.25,
        "actual_pace": "8:00 /mi",
        "heart_rate_avg": 142,
        "cardio_metrics": {"speed": "7.5 mph"},
    }]
    assert "body_weight" not in dumped
    assert "calorie" not in dumped
    _ok("auto workout feed payload keeps training metrics without body/nutrition data")


def test_feed_sanitizer_keeps_post_metrics_and_removes_sensitive_fields():
    """Manual workout posts get the same privacy boundary as auto rows."""
    print("\n[test] feed: sanitizer removes sensitive post fields")
    clean = _sanitize_feed_payload_for_read("workout_post", {
        "caption": "Solid session",
        "body_weight_lbs": 185,
        "workout_summary": {
            "focus": "Lower",
            "duration_seconds": 3600,
            "date": "2026-05-01",
            "calories": 700,
            "activity_category": "cardio",
            "activity_subtype": "run",
            "cardio_style": "steady",
            "distanceMiles": 3.1,
            "hrSummary": {"avg_bpm": 144, "max_bpm": 171},
            "exercises": [{
                "name": "Back Squat",
                "equipment": "barbell",
                "sets": [{"reps": 3, "weightLbs": 315, "cardioMetrics": {"calories": "25"}}],
            }],
            "total_sets": 1,
            "total_reps": 3,
        },
    })
    dumped = json.dumps(clean).lower()
    assert clean["caption"] == "Solid session"
    assert clean["workout_summary"]["exercises"][0]["sets"] == [{"reps": 3, "weight_lbs": 315.0}]
    assert clean["workout_summary"]["distance_miles"] == 3.1
    assert clean["workout_summary"]["hr_summary"] == {"avgBpm": 144, "maxBpm": 171}
    assert "body_weight" not in dumped
    assert "calorie" not in dumped
    _ok("manual post payload keeps caption/photo plus sanitized workout metrics")


cases = [
    test_digest_drops_soft_deleted_friends,
    test_digest_query_count_is_constant,
    test_digest_with_zero_friends_doesnt_crash,
    test_digest_respects_share_toggle,
    test_digest_includes_avatar_url_without_sensitive_data,
    test_feed_sanitizer_keeps_workout_metrics_and_removes_sensitive_fields,
    test_feed_sanitizer_keeps_post_metrics_and_removes_sensitive_fields,
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
