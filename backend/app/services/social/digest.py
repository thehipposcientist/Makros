"""Weekly digest aggregation.

Pulls each friend's WorkoutCompletion rows over the last 7 days and
returns a small dict the client renders as the "This week" card.

No new write path on workout completion — this is computed on read.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from sqlmodel import Session, select

from app.models import (
    User, UserSocialProfile, UserGoal, WorkoutCompletion,
)


def week_start_for(today: date) -> date:
    """Monday of the week containing `today`. Local-naive — caller is
    responsible for picking a sensible "today" in the user's tz."""
    return today - timedelta(days=today.weekday())


def _streak_days(completion_dates: set[date], today: date) -> int:
    """Consecutive days ending at today (or yesterday) with >=1 completion."""
    if not completion_dates:
        return 0
    # Tolerate "missed today" — start from yesterday if today has nothing.
    cursor = today if today in completion_dates else today - timedelta(days=1)
    streak = 0
    while cursor in completion_dates:
        streak += 1
        cursor -= timedelta(days=1)
    return streak


def _last_active(completion_dates: set[date], today: date) -> date | None:
    return max((d for d in completion_dates if d <= today), default=None)


def compute_digest(
    db: Session,
    user_id: int,
    *,
    today: date | None = None,
) -> dict:
    """Build the digest payload for `user_id`.

    Shape:
      {
        week_start: ISO date,
        you: {sessions: int, streak: int},
        friends: [
          {user_id, username, display_name, goal, sessions, streak, last_active_within_48h},
          ...
        ],
        summary: {
          friend_count: int,
          friends_trained_this_week: int,
          total_friend_sessions: int,
          top_user_id: int | None,
          top_sessions: int,
          long_streak_count: int,  # friends with streak >= 14
        }
      }
    """
    today = today or datetime.now(timezone.utc).date()
    week_start = week_start_for(today)
    window_start = today - timedelta(days=6)  # inclusive 7-day window
    cutoff_48h = today - timedelta(days=2)

    friend_ids = _accepted_friend_ids(db, user_id)

    # Self stats
    you_dates = _completion_dates(db, user_id, window_start, today)
    you = {
        "sessions": len(you_dates),
        "streak": _streak_days(you_dates, today),
    }

    # Bulk-load every per-friend table in 4 queries instead of looping
    # 4 queries per friend. With 20 friends this drops 80+ round trips
    # to ~5 (profiles, users, goals, completions, friend-IDs already in
    # hand). Soft-deleted users are filtered out at the user join.
    if not friend_ids:
        friends_payload: list[dict] = []
    else:
        from sqlmodel import col
        profs_by_user: dict[int, UserSocialProfile] = {}
        for p in db.exec(
            select(UserSocialProfile).where(col(UserSocialProfile.user_id).in_(friend_ids))
        ).all():
            profs_by_user[p.user_id] = p
        users_by_id: dict[int, User] = {}
        for u in db.exec(
            select(User)
            .where(col(User.id).in_(friend_ids))
            .where(User.is_active == True)  # noqa: E712  hide deactivated accounts
        ).all():
            users_by_id[u.id] = u
        goals_by_user: dict[int, UserGoal] = {}
        for g in db.exec(
            select(UserGoal)
            .where(col(UserGoal.user_id).in_(friend_ids))
            .where(UserGoal.is_active == True)  # noqa: E712
        ).all():
            # Multiple active rows shouldn't exist but pick the first deterministically.
            goals_by_user.setdefault(g.user_id, g)

        # Single aggregated query for all friends' completion dates in window.
        rows = db.exec(
            select(WorkoutCompletion.user_id, WorkoutCompletion.workout_date).where(
                col(WorkoutCompletion.user_id).in_(friend_ids),
                WorkoutCompletion.workout_date >= window_start,
                WorkoutCompletion.workout_date <= today,
            )
        ).all()
        dates_by_user: dict[int, set[date]] = {}
        for uid, d in rows:
            dates_by_user.setdefault(uid, set()).add(d)

        friends_payload = []
        for fid in friend_ids:
            user_row = users_by_id.get(fid)
            if not user_row:
                # Soft-deleted or missing — drop silently from the list.
                continue
            prof = profs_by_user.get(fid)
            share = bool(prof and prof.share_activity_enabled)
            goal_row = goals_by_user.get(fid)

            if share:
                f_dates = dates_by_user.get(fid, set())
                sessions = len(f_dates)
                streak = _streak_days(f_dates, today)
                la = _last_active(f_dates, today)
                active_48h = bool(la and la >= cutoff_48h)
            else:
                sessions, streak, active_48h = 0, 0, False

            friends_payload.append({
                "user_id": fid,
                "username": user_row.username,
                "display_name": (prof.display_name if prof and prof.display_name else user_row.username),
                "goal": goal_row.goal_type.value if goal_row else None,
                "share_enabled": share,
                "sessions": sessions,
                "streak": streak,
                "last_active_within_48h": active_48h,
            })

    sharing = [f for f in friends_payload if f["share_enabled"]]
    trained = [f for f in sharing if f["sessions"] > 0]
    top = max(sharing, key=lambda f: f["sessions"], default=None) if sharing else None
    summary = {
        "friend_count": len(friends_payload),
        "friends_trained_this_week": len(trained),
        "total_friend_sessions": sum(f["sessions"] for f in sharing),
        "top_user_id": top["user_id"] if top and top["sessions"] > 0 else None,
        "top_sessions": top["sessions"] if top else 0,
        "long_streak_count": sum(1 for f in sharing if f["streak"] >= 14),
    }

    return {
        "week_start": week_start.isoformat(),
        "you": you,
        "friends": friends_payload,
        "summary": summary,
    }


def _accepted_friend_ids(db: Session, user_id: int) -> list[int]:
    from app.models import Friendship  # local import keeps module import-light
    rows = db.exec(
        select(Friendship).where(
            Friendship.status == "accepted",
            ((Friendship.user_a_id == user_id) | (Friendship.user_b_id == user_id)),
        )
    ).all()
    return [r.user_b_id if r.user_a_id == user_id else r.user_a_id for r in rows]


def _completion_dates(db: Session, user_id: int, start: date, end: date) -> set[date]:
    rows = db.exec(
        select(WorkoutCompletion.workout_date).where(
            WorkoutCompletion.user_id == user_id,
            WorkoutCompletion.workout_date >= start,
            WorkoutCompletion.workout_date <= end,
        )
    ).all()
    return set(rows)
