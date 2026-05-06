"""Social router — friends, weekly digest, and bounded activity feed."""
from __future__ import annotations

import os
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from sqlalchemy import func as sa_func
from app.models import (
    User, UserSocialProfile, Friendship, UserReport, WeeklyDigestCache, UserGoal,
    ActivityFeedItem, FeedLike, SocialNotification,
)
from app.services.social.digest import compute_digest, week_start_for, _accepted_friend_ids

router = APIRouter(prefix="/social", tags=["social"])
_SOCIAL_FEED_FLAG = os.getenv("SOCIAL_FEED_ENABLED", "1").strip().lower()
SOCIAL_FEED_ENABLED = _SOCIAL_FEED_FLAG not in {"0", "false", "no", "off"}
FEED_EVENT_TYPES = ("workout_completed", "workout_post", "pr_achieved")


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SocialMeRead(BaseModel):
    user_id: int
    username: str
    display_name: str | None
    avatar_url: str | None
    share_activity_enabled: bool


class SocialMeUpdate(BaseModel):
    display_name: str | None = None
    avatar_url: str | None = None
    share_activity_enabled: bool | None = None

    @field_validator("display_name")
    @classmethod
    def _trim_display(cls, v):
        if v is None:
            return v
        v = v.strip()
        if not v:
            return None
        if len(v) > 40:
            raise ValueError("display_name too long (max 40)")
        return v

    @field_validator("avatar_url")
    @classmethod
    def _trim_avatar(cls, v):
        if v is None:
            return v
        v = v.strip()
        if not v:
            return None
        if len(v) > 400_000:
            raise ValueError("profile photo is too large")
        lowered = v.lower()
        if not (
            lowered.startswith("data:image/")
            or lowered.startswith("https://")
            or lowered.startswith("http://")
        ):
            raise ValueError("avatar_url must be an image data URI or URL")
        return v


class FriendRead(BaseModel):
    friendship_id: int
    user_id: int
    username: str
    display_name: str | None
    avatar_url: str | None
    goal: str | None
    last_active_within_48h: bool
    streak: int


class PendingRequestRead(BaseModel):
    friendship_id: int
    user_id: int
    username: str
    display_name: str | None
    avatar_url: str | None
    requested_at: datetime
    direction: str  # "incoming" | "outgoing"


class FriendsListRead(BaseModel):
    friends: list[FriendRead]
    pending: list[PendingRequestRead]


class FriendRequestBody(BaseModel):
    username: str

    @field_validator("username")
    @classmethod
    def _norm(cls, v):
        v = (v or "").strip().lower()
        if not v:
            raise ValueError("username required")
        return v


class SearchHit(BaseModel):
    user_id: int
    username: str
    display_name: str | None
    avatar_url: str | None


class SocialNotificationRead(BaseModel):
    id: int
    notification_type: str
    subject_type: str
    subject_id: int
    actor_user_id: int
    actor_username: str
    actor_display_name: str | None
    actor_avatar_url: str | None
    payload: dict
    read_at: datetime | None
    created_at: datetime


class SocialNotificationsRead(BaseModel):
    items: list[SocialNotificationRead]
    unread_count: int


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _canonical_pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def _avatar_url(prof: UserSocialProfile | None) -> str | None:
    value = prof.avatar_url if prof else None
    return value.strip() if isinstance(value, str) and value.strip() else None


def _get_or_create_profile(db: Session, user: User) -> UserSocialProfile:
    prof = db.exec(
        select(UserSocialProfile).where(UserSocialProfile.user_id == user.id)
    ).first()
    if prof:
        return prof
    prof = UserSocialProfile(user_id=user.id, display_name=None, share_activity_enabled=False)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


def _friendship_between(db: Session, a: int, b: int) -> Friendship | None:
    lo, hi = _canonical_pair(a, b)
    return db.exec(
        select(Friendship).where(
            Friendship.user_a_id == lo,
            Friendship.user_b_id == hi,
        )
    ).first()


def _hydrate_friend(db: Session, viewer_id: int, other_id: int, friendship_id: int, *, include_streak: bool = True) -> FriendRead:
    # Filter `is_active=True` to hide soft-deleted users from any social
    # surface (lists, search, feed). Deactivated rows still exist in DB
    # so referential integrity holds, but they must not leak.
    other = db.exec(
        select(User).where(User.id == other_id, User.is_active == True)  # noqa: E712
    ).first()
    if not other:
        raise HTTPException(404, "user not found")
    prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == other_id)).first()
    goal_row = db.exec(
        select(UserGoal).where(UserGoal.user_id == other_id, UserGoal.is_active == True)  # noqa: E712
    ).first()

    streak = 0
    active_48h = False
    if include_streak and prof and prof.share_activity_enabled:
        # Cheap streak read uses the same digest helpers; the digest itself
        # is cached weekly so this is the only per-call computation.
        from app.services.social.digest import _completion_dates, _streak_days, _last_active
        from datetime import timedelta
        today = datetime.now(timezone.utc).date()
        dates = _completion_dates(db, other_id, today - timedelta(days=13), today)
        streak = _streak_days(dates, today)
        last = _last_active(dates, today)
        active_48h = bool(last and last >= today - timedelta(days=2))

    return FriendRead(
        friendship_id=friendship_id,
        user_id=other_id,
        username=other.username,
        display_name=(prof.display_name if prof and prof.display_name else other.username),
        avatar_url=_avatar_url(prof),
        goal=(goal_row.goal_type.value if goal_row else None),
        last_active_within_48h=active_48h,
        streak=streak,
    )


def _create_social_notification(
    db: Session,
    *,
    user_id: int,
    actor_user_id: int,
    notification_type: str,
    subject_type: str,
    subject_id: int,
    payload: dict | None = None,
) -> SocialNotification | None:
    if user_id == actor_user_id:
        return None
    existing = db.exec(
        select(SocialNotification).where(
            SocialNotification.user_id == user_id,
            SocialNotification.actor_user_id == actor_user_id,
            SocialNotification.notification_type == notification_type,
            SocialNotification.subject_type == subject_type,
            SocialNotification.subject_id == subject_id,
        )
    ).first()
    if existing:
        return existing
    n = SocialNotification(
        user_id=user_id,
        actor_user_id=actor_user_id,
        notification_type=notification_type,
        subject_type=subject_type,
        subject_id=subject_id,
        payload=payload or {},
    )
    db.add(n)
    return n


def _feed_notification_payload(item: ActivityFeedItem) -> dict:
    clean = _sanitize_feed_payload_for_read(item.event_type, item.payload)
    payload: dict = {
        "feed_item_id": item.id,
        "event_type": item.event_type,
    }
    if item.event_type == "workout_post":
        summary = clean.get("workout_summary") if isinstance(clean.get("workout_summary"), dict) else {}
        if clean.get("caption"):
            payload["caption"] = str(clean["caption"])[:80]
    else:
        summary = clean
    if isinstance(summary, dict):
        for key in ("focus", "date"):
            value = summary.get(key)
            if isinstance(value, str) and value:
                payload[key] = value
    return payload


def _notification_unread_count(db: Session, user_id: int) -> int:
    value = db.exec(
        select(sa_func.count(SocialNotification.id)).where(
            SocialNotification.user_id == user_id,
            SocialNotification.read_at.is_(None),  # type: ignore[union-attr]
        )
    ).first()
    return int(value or 0)


def _feed_like_count(db: Session, item_id: int) -> int:
    value = db.exec(
        select(sa_func.count(FeedLike.id)).where(FeedLike.feed_item_id == item_id)
    ).first()
    return int(value or 0)


def _hydrate_notifications(db: Session, rows: list[SocialNotification]) -> list[SocialNotificationRead]:
    if not rows:
        return []
    from sqlmodel import col

    actor_ids = list({r.actor_user_id for r in rows})
    users_by_id = {
        u.id: u for u in db.exec(
            select(User)
            .where(col(User.id).in_(actor_ids))
            .where(User.is_active == True)  # noqa: E712
        ).all()
    }
    profs_by_id = {
        p.user_id: p for p in db.exec(
            select(UserSocialProfile).where(col(UserSocialProfile.user_id).in_(actor_ids))
        ).all()
    }
    out: list[SocialNotificationRead] = []
    for row in rows:
        actor = users_by_id.get(row.actor_user_id)
        prof = profs_by_id.get(row.actor_user_id)
        username = actor.username if actor else "unknown"
        out.append(SocialNotificationRead(
            id=row.id,
            notification_type=row.notification_type,
            subject_type=row.subject_type,
            subject_id=row.subject_id,
            actor_user_id=row.actor_user_id,
            actor_username=username,
            actor_display_name=(prof.display_name if prof and prof.display_name else username),
            actor_avatar_url=_avatar_url(prof),
            payload=row.payload if isinstance(row.payload, dict) else {},
            read_at=row.read_at,
            created_at=row.created_at,
        ))
    return out


# ─── /social/me ──────────────────────────────────────────────────────────────

@router.get("/me", response_model=SocialMeRead)
def get_me(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    prof = _get_or_create_profile(db, current_user)
    return SocialMeRead(
        user_id=current_user.id,
        username=current_user.username,
        display_name=prof.display_name,
        avatar_url=_avatar_url(prof),
        share_activity_enabled=prof.share_activity_enabled,
    )


@router.patch("/me", response_model=SocialMeRead)
def patch_me(
    body: SocialMeUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    prof = _get_or_create_profile(db, current_user)
    if body.display_name is not None:
        prof.display_name = body.display_name
    if body.avatar_url is not None or "avatar_url" in body.model_fields_set:
        prof.avatar_url = body.avatar_url
    if body.share_activity_enabled is not None:
        prof.share_activity_enabled = body.share_activity_enabled
    prof.updated_at = datetime.now(timezone.utc)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return SocialMeRead(
        user_id=current_user.id,
        username=current_user.username,
        display_name=prof.display_name,
        avatar_url=_avatar_url(prof),
        share_activity_enabled=prof.share_activity_enabled,
    )


# ─── /social/friends ─────────────────────────────────────────────────────────

@router.get("/friends", response_model=FriendsListRead)
def list_friends(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(Friendship).where(
            (Friendship.user_a_id == current_user.id) | (Friendship.user_b_id == current_user.id)
        )
    ).all()

    # Was N+1: `_hydrate_friend` did 3-4 queries per accepted friend (user,
    # profile, goal, completion-dates), and the pending branch did its own
    # 2 per row. With 20 friends + 5 pending that's ~80 queries on every
    # call. Now: collect all the other_ids, do 4 IN-set queries up front,
    # and hydrate from the in-memory maps.
    from sqlmodel import col
    accepted_rows = [r for r in rows if r.status == "accepted"]
    pending_rows = [r for r in rows if r.status == "pending"]
    accepted_other_ids = [
        (r.user_b_id if r.user_a_id == current_user.id else r.user_a_id)
        for r in accepted_rows
    ]
    pending_other_ids = [
        (r.user_b_id if r.user_a_id == current_user.id else r.user_a_id)
        for r in pending_rows
    ]
    all_other_ids = list({*accepted_other_ids, *pending_other_ids})

    users_by_id: dict[int, User] = {}
    profs_by_user: dict[int, UserSocialProfile] = {}
    goals_by_user: dict[int, UserGoal] = {}
    if all_other_ids:
        for u in db.exec(
            select(User).where(col(User.id).in_(all_other_ids), User.is_active == True)  # noqa: E712
        ).all():
            users_by_id[u.id] = u
        for p in db.exec(
            select(UserSocialProfile).where(col(UserSocialProfile.user_id).in_(all_other_ids))
        ).all():
            profs_by_user[p.user_id] = p
        for g in db.exec(
            select(UserGoal).where(
                col(UserGoal.user_id).in_(all_other_ids),
                UserGoal.is_active == True,  # noqa: E712
            )
        ).all():
            goals_by_user.setdefault(g.user_id, g)

    # Streak data: one batched completion-date pull for every accepted
    # friend whose share-activity flag is on. `_hydrate_friend` did this
    # one user at a time inside the loop.
    from app.services.social.digest import _streak_days, _last_active
    from datetime import timedelta as _td
    today_d = datetime.now(timezone.utc).date()
    window_start = today_d - _td(days=13)
    cutoff_48h = today_d - _td(days=2)
    sharing_ids = [
        oid for oid in accepted_other_ids
        if (profs_by_user.get(oid) and profs_by_user[oid].share_activity_enabled)
    ]
    dates_by_user: dict[int, set] = {}
    if sharing_ids:
        from app.models import WorkoutCompletion
        for uid, d in db.exec(
            select(WorkoutCompletion.user_id, WorkoutCompletion.workout_date).where(
                col(WorkoutCompletion.user_id).in_(sharing_ids),
                WorkoutCompletion.workout_date >= window_start,
                WorkoutCompletion.workout_date <= today_d,
            )
        ).all():
            dates_by_user.setdefault(uid, set()).add(d)

    friends: list[FriendRead] = []
    for r in accepted_rows:
        other_id = r.user_b_id if r.user_a_id == current_user.id else r.user_a_id
        user_row = users_by_id.get(other_id)
        if not user_row:
            # Soft-deleted account — drop silently.
            continue
        prof = profs_by_user.get(other_id)
        goal_row = goals_by_user.get(other_id)
        share = bool(prof and prof.share_activity_enabled)
        if share:
            f_dates = dates_by_user.get(other_id, set())
            streak = _streak_days(f_dates, today_d)
            la = _last_active(f_dates, today_d)
            active_48h = bool(la and la >= cutoff_48h)
        else:
            streak, active_48h = 0, False
        friends.append(FriendRead(
            friendship_id=r.id,
            user_id=other_id,
            username=user_row.username,
            display_name=(prof.display_name if prof and prof.display_name else user_row.username),
            avatar_url=_avatar_url(prof),
            goal=(goal_row.goal_type.value if goal_row else None),
            last_active_within_48h=active_48h,
            streak=streak,
        ))

    pending: list[PendingRequestRead] = []
    for r in pending_rows:
        other_id = r.user_b_id if r.user_a_id == current_user.id else r.user_a_id
        other = users_by_id.get(other_id)
        if not other:
            continue
        prof = profs_by_user.get(other_id)
        pending.append(PendingRequestRead(
            friendship_id=r.id,
            user_id=other_id,
            username=other.username,
            display_name=(prof.display_name if prof and prof.display_name else other.username),
            avatar_url=_avatar_url(prof),
            requested_at=r.requested_at,
            direction=("outgoing" if r.requested_by == current_user.id else "incoming"),
        ))
    # blocked rows are intentionally hidden from the list

    return FriendsListRead(friends=friends, pending=pending)


@router.post("/friends/request", response_model=PendingRequestRead)
def request_friend(
    body: FriendRequestBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    target = db.exec(
        select(User).where(User.username == body.username, User.is_active == True)  # noqa: E712
    ).first()
    if not target:
        raise HTTPException(404, "user not found")
    if target.id == current_user.id:
        raise HTTPException(400, "cannot friend yourself")

    existing = _friendship_between(db, current_user.id, target.id)
    if existing:
        if existing.status == "accepted":
            raise HTTPException(409, "already friends")
        if existing.status == "blocked":
            # Don't leak which side blocked.
            raise HTTPException(404, "user not found")
        if existing.status == "pending":
            # If the OTHER side already requested, treat this as accept.
            if existing.requested_by != current_user.id:
                existing.status = "accepted"
                existing.accepted_at = datetime.now(timezone.utc)
                db.add(existing)
                _create_social_notification(
                    db,
                    user_id=target.id,
                    actor_user_id=current_user.id,
                    notification_type="friend_accept",
                    subject_type="friendship",
                    subject_id=existing.id,
                    payload={"friendship_id": existing.id},
                )
                _invalidate_digest(db, existing.user_a_id, existing.user_b_id)
                db.commit()
            prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == target.id)).first()
            return PendingRequestRead(
                friendship_id=existing.id,
                user_id=target.id,
                username=target.username,
                display_name=(prof.display_name if prof and prof.display_name else target.username),
                avatar_url=_avatar_url(prof),
                requested_at=existing.requested_at,
                direction=("outgoing" if existing.requested_by == current_user.id else "incoming"),
            )

    lo, hi = _canonical_pair(current_user.id, target.id)
    fs = Friendship(
        user_a_id=lo,
        user_b_id=hi,
        status="pending",
        requested_by=current_user.id,
    )
    db.add(fs)
    db.flush()
    _create_social_notification(
        db,
        user_id=target.id,
        actor_user_id=current_user.id,
        notification_type="friend_request",
        subject_type="friendship",
        subject_id=fs.id,
        payload={"friendship_id": fs.id},
    )
    _invalidate_digest(db, current_user.id, target.id)
    db.commit()
    db.refresh(fs)
    prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == target.id)).first()
    return PendingRequestRead(
        friendship_id=fs.id,
        user_id=target.id,
        username=target.username,
        display_name=(prof.display_name if prof and prof.display_name else target.username),
        avatar_url=_avatar_url(prof),
        requested_at=fs.requested_at,
        direction="outgoing",
    )


def _load_owned_friendship(db: Session, fs_id: int, user_id: int) -> Friendship:
    fs = db.exec(select(Friendship).where(Friendship.id == fs_id)).first()
    if not fs or (fs.user_a_id != user_id and fs.user_b_id != user_id):
        raise HTTPException(404, "friendship not found")
    return fs


def _invalidate_digest(db: Session, *user_ids: int) -> None:
    """Drop cached digest rows for the given users so the next /digest
    call re-aggregates with the fresh friendship state. Without this,
    accepting a friend would leave them invisible in the digest until
    the 1-hour staleness window expires."""
    for uid in user_ids:
        rows = db.exec(
            select(WeeklyDigestCache).where(WeeklyDigestCache.user_id == uid)
        ).all()
        for r in rows:
            db.delete(r)


@router.post("/friends/{friendship_id}/accept")
def accept_friend(
    friendship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    fs = _load_owned_friendship(db, friendship_id, current_user.id)
    if fs.status != "pending":
        raise HTTPException(400, f"cannot accept (status={fs.status})")
    if fs.requested_by == current_user.id:
        raise HTTPException(400, "cannot accept own request")
    fs.status = "accepted"
    fs.accepted_at = datetime.now(timezone.utc)
    db.add(fs)
    _create_social_notification(
        db,
        user_id=fs.requested_by,
        actor_user_id=current_user.id,
        notification_type="friend_accept",
        subject_type="friendship",
        subject_id=fs.id,
        payload={"friendship_id": fs.id},
    )
    _invalidate_digest(db, fs.user_a_id, fs.user_b_id)
    db.commit()
    return {"ok": True}


@router.post("/friends/{friendship_id}/reject")
def reject_friend(
    friendship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    fs = _load_owned_friendship(db, friendship_id, current_user.id)
    if fs.status != "pending":
        raise HTTPException(400, f"cannot reject (status={fs.status})")
    db.delete(fs)
    db.commit()
    return {"ok": True}


@router.post("/friends/{friendship_id}/remove")
def remove_friend(
    friendship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    fs = _load_owned_friendship(db, friendship_id, current_user.id)
    a, b = fs.user_a_id, fs.user_b_id
    db.delete(fs)
    _invalidate_digest(db, a, b)
    db.commit()
    return {"ok": True}


@router.post("/friends/{friendship_id}/block")
def block_friend(
    friendship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    fs = _load_owned_friendship(db, friendship_id, current_user.id)
    fs.status = "blocked"
    fs.blocked_by = current_user.id
    db.add(fs)
    _invalidate_digest(db, fs.user_a_id, fs.user_b_id)
    db.commit()
    return {"ok": True}


# ─── Reporting ───────────────────────────────────────────────────────────────
# Required by App Review for any social surface. Stores the report in
# `user_reports` with status='open' so operators can review through the
# admin queue. We do not auto-action — moderation is human-reviewed.

class ReportUserBody(BaseModel):
    user_id: int
    reason: str = "other"  # spam | harassment | impersonation | inappropriate_content | other
    note: str | None = None


_VALID_REPORT_REASONS = {"spam", "harassment", "impersonation", "inappropriate_content", "other"}


@router.post("/report-user")
def report_user(
    body: ReportUserBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if body.user_id == current_user.id:
        raise HTTPException(400, "cannot report yourself")
    target = db.exec(select(User).where(User.id == body.user_id)).first()
    if not target:
        raise HTTPException(404, "user not found")
    reason = body.reason if body.reason in _VALID_REPORT_REASONS else "other"
    note = (body.note or "").strip()[:500] or None
    rep = UserReport(
        reporter_id=current_user.id,
        reported_user_id=body.user_id,
        reason=reason,
        note=note,
    )
    db.add(rep)
    db.commit()
    db.refresh(rep)
    return {"ok": True, "report_id": rep.id}


# ─── Search ──────────────────────────────────────────────────────────────────

@router.get("/search", response_model=list[SearchHit])
def search_users(
    q: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    needle = (q or "").strip().lower()
    if len(needle) < 2:
        return []
    rows = db.exec(
        select(User)
        .where(User.username.ilike(f"{needle}%"))
        .where(User.id != current_user.id)
        .where(User.is_active == True)  # noqa: E712  hide soft-deleted accounts
        .limit(10)
    ).all()
    out: list[SearchHit] = []
    for u in rows:
        prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == u.id)).first()
        out.append(SearchHit(
            user_id=u.id,
            username=u.username,
            display_name=(prof.display_name if prof and prof.display_name else None),
            avatar_url=_avatar_url(prof),
        ))
    return out


# ─── Digest ──────────────────────────────────────────────────────────────────

@router.get("/digest")
def get_digest(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    today = datetime.now(timezone.utc).date()
    ws = week_start_for(today)
    cached = db.exec(
        select(WeeklyDigestCache).where(
            WeeklyDigestCache.user_id == current_user.id,
            WeeklyDigestCache.week_start == ws,
        )
    ).first()
    # Cache is valid for the week, but refresh if older than 1 hour so
    # mid-week activity feels live without re-aggregating on every poll.
    fresh = False
    if cached:
        gen = cached.generated_at.replace(tzinfo=timezone.utc) if cached.generated_at.tzinfo is None else cached.generated_at
        age = (datetime.now(timezone.utc) - gen).total_seconds()
        fresh = age < 3600
    if cached and fresh:
        return cached.payload

    payload = compute_digest(db, current_user.id, today=today)
    if cached:
        cached.payload = payload
        cached.generated_at = datetime.now(timezone.utc)
        db.add(cached)
    else:
        db.add(WeeklyDigestCache(
            user_id=current_user.id,
            week_start=ws,
            payload=payload,
        ))
    db.commit()
    return payload


# ─── Notifications ──────────────────────────────────────────────────────────

@router.get("/notifications", response_model=SocialNotificationsRead)
def list_notifications(
    limit: int = 30,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(SocialNotification)
        .where(SocialNotification.user_id == current_user.id)
        .order_by(SocialNotification.created_at.desc())  # type: ignore[union-attr]
        .limit(max(1, min(limit, 50)))
    ).all()
    return SocialNotificationsRead(
        items=_hydrate_notifications(db, rows),
        unread_count=_notification_unread_count(db, current_user.id),
    )


@router.post("/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    n = db.exec(
        select(SocialNotification).where(
            SocialNotification.id == notification_id,
            SocialNotification.user_id == current_user.id,
        )
    ).first()
    if not n:
        raise HTTPException(404, "notification not found")
    if n.read_at is None:
        n.read_at = datetime.now(timezone.utc)
        db.add(n)
        db.commit()
    return {"ok": True}


@router.post("/notifications/read-all")
def mark_all_notifications_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(SocialNotification).where(
            SocialNotification.user_id == current_user.id,
            SocialNotification.read_at.is_(None),  # type: ignore[union-attr]
        )
    ).all()
    now = datetime.now(timezone.utc)
    for n in rows:
        n.read_at = now
        db.add(n)
    if rows:
        db.commit()
    return {"ok": True, "updated": len(rows)}


# ─── Activity Feed ──────────────────────────────────────────────────────────

class FeedItemRead(BaseModel):
    id: int
    user_id: int
    username: str
    display_name: str | None
    avatar_url: str | None = None
    event_type: str
    payload: dict
    created_at: str


def _coerce_positive_number(value) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return round(n, 2)


def _coerce_positive_int(value) -> int | None:
    n = _coerce_positive_number(value)
    return int(round(n)) if n is not None else None


def _first_present(raw: dict, *keys: str):
    for key in keys:
        if key in raw and raw.get(key) is not None:
            return raw.get(key)
    return None


_SENSITIVE_SOCIAL_METRIC_KEYS = {
    "calorie", "calories", "kcal", "calories_burned", "body_weight",
    "body_weight_lbs", "weight_entry", "body_fat", "bodyfat", "macros",
    "protein", "carbs", "fat",
}
_ALLOWED_CARDIO_METRIC_KEYS = {
    "speed", "incline", "pace", "split", "spm", "stroke_rate", "distance",
    "watts", "cadence", "output", "laps", "floors", "level", "elevation",
    "resistance", "weight", "load",
}


def _sanitize_cardio_metrics(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    clean: dict = {}
    for key, value in raw.items():
        normalized = str(key or "").strip().lower()
        if not normalized:
            continue
        if normalized in _SENSITIVE_SOCIAL_METRIC_KEYS or "calorie" in normalized or "body_" in normalized:
            continue
        if normalized not in _ALLOWED_CARDIO_METRIC_KEYS:
            continue
        text = str(value).strip()
        if not text or text.lower() in {"none", "null", "undefined", "nan"}:
            continue
        clean[normalized[:32]] = text[:60]
    return clean or None


def _sanitize_workout_set(raw: dict) -> dict:
    clean: dict = {}
    reps = _coerce_positive_int(_first_present(raw, "reps", "actual_reps", "actualReps"))
    if reps is not None:
        clean["reps"] = reps
    weight = _coerce_positive_number(_first_present(
        raw,
        "weight_lbs",
        "actual_weight_lbs",
        "weightLbs",
        "actualWeightLbs",
        "weight",
        "load",
    ))
    if weight is not None:
        clean["weight_lbs"] = weight
    duration = _coerce_positive_int(_first_present(raw, "duration_seconds", "durationSeconds"))
    if duration is not None:
        clean["duration_seconds"] = duration
    distance = _coerce_positive_number(_first_present(raw, "actual_distance", "actualDistance"))
    if distance is not None:
        clean["actual_distance"] = distance
    pace = _first_present(raw, "actual_pace", "actualPace")
    if isinstance(pace, str) and pace.strip():
        clean["actual_pace"] = pace.strip()[:40]
    heart_rate = _coerce_positive_int(_first_present(raw, "heart_rate_avg", "heartRateAvg"))
    if heart_rate is not None:
        clean["heart_rate_avg"] = heart_rate
    cardio_metrics = _sanitize_cardio_metrics(_first_present(raw, "cardio_metrics", "cardioMetrics"))
    if cardio_metrics:
        clean["cardio_metrics"] = cardio_metrics
    return clean


def _sanitize_hr_summary(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    clean: dict = {}
    avg = _coerce_positive_int(_first_present(raw, "avgBpm", "avg_bpm"))
    max_bpm = _coerce_positive_int(_first_present(raw, "maxBpm", "max_bpm"))
    if avg is not None:
        clean["avgBpm"] = avg
    if max_bpm is not None:
        clean["maxBpm"] = max_bpm
    return clean or None


def _sanitize_feed_payload_for_read(event_type: str, payload: dict | None) -> dict:
    raw = payload if isinstance(payload, dict) else {}
    if event_type == "workout_post":
        clean: dict = {}
        caption = raw.get("caption")
        if isinstance(caption, str) and caption:
            clean["caption"] = caption[:500]
        photo = raw.get("photo_base64")
        if isinstance(photo, str) and photo:
            clean["photo_base64"] = photo
        summary = raw.get("workout_summary")
        if isinstance(summary, dict):
            clean["workout_summary"] = _sanitize_workout_summary(summary)
        return clean

    if event_type == "workout_completed":
        exercises = []
        for ex in list(raw.get("exercises") or [])[:20]:
            if not isinstance(ex, dict):
                continue
            sets = []
            for s in list(ex.get("sets") or [])[:20]:
                if not isinstance(s, dict):
                    continue
                sets.append(_sanitize_workout_set(s))
            exercises.append({
                "name": str(ex.get("name") or "Exercise")[:80],
                "equipment": str(ex.get("equipment"))[:60] if ex.get("equipment") else None,
                "sets": sets,
            })
        clean = {
            "focus": str(raw.get("focus") or "Workout")[:80],
            "duration_seconds": int(raw.get("duration_seconds") or 0),
            "date": str(raw.get("date") or "")[:10],
            "exercise_count": int(raw.get("exercise_count") or len(exercises)),
            "exercises": exercises,
        }
        for key in ("activity_category", "activity_subtype", "cardio_style"):
            value = raw.get(key)
            if isinstance(value, str) and value.strip():
                clean[key] = value.strip()[:40]
        distance_miles = _coerce_positive_number(_first_present(raw, "distance_miles", "distanceMiles"))
        if distance_miles is not None:
            clean["distance_miles"] = distance_miles
        hr_summary = _sanitize_hr_summary(_first_present(raw, "hr_summary", "hrSummary"))
        if hr_summary:
            clean["hr_summary"] = hr_summary
        return clean

    if event_type == "pr_achieved":
        return {
            "exercise": str(raw.get("exercise") or "Exercise")[:80],
            "pr_type": str(raw.get("pr_type") or "")[:40],
            "unit": str(raw.get("unit") or "lbs")[:20],
            "date": str(raw.get("date") or "")[:10],
        }

    return {}


def _can_view_feed_author(db: Session, viewer_id: int, author_id: int) -> bool:
    if author_id == viewer_id:
        return True
    if author_id not in _accepted_friend_ids(db, viewer_id):
        return False
    prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == author_id)).first()
    return bool(prof and prof.share_activity_enabled)


@router.get("/feed")
def get_feed(
    limit: int = 30,
    before_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not SOCIAL_FEED_ENABLED:
        raise HTTPException(404, "social feed disabled")
    friend_ids = _accepted_friend_ids(db, current_user.id)
    visible_ids = [current_user.id]
    for fid in friend_ids:
        prof = db.exec(
            select(UserSocialProfile).where(UserSocialProfile.user_id == fid)
        ).first()
        if prof and prof.share_activity_enabled:
            visible_ids.append(fid)

    q = (
        select(ActivityFeedItem)
        .where(ActivityFeedItem.user_id.in_(visible_ids))  # type: ignore[union-attr]
        .where(ActivityFeedItem.event_type.in_(FEED_EVENT_TYPES))  # type: ignore[union-attr]
        .order_by(ActivityFeedItem.created_at.desc())  # type: ignore[union-attr]
        .limit(min(limit, 50))
    )
    if before_id is not None:
        q = q.where(ActivityFeedItem.id < before_id)

    rows = db.exec(q).all()

    item_ids = [r.id for r in rows]
    like_counts: dict[int, int] = {}
    liked_by_me: set[int] = set()
    if item_ids:
        count_rows = db.exec(
            select(FeedLike.feed_item_id, sa_func.count())
            .where(FeedLike.feed_item_id.in_(item_ids))  # type: ignore[union-attr]
            .group_by(FeedLike.feed_item_id)
        ).all()
        for fid, cnt in count_rows:
            like_counts[fid] = cnt
        my_likes = db.exec(
            select(FeedLike.feed_item_id).where(
                FeedLike.user_id == current_user.id,
                FeedLike.feed_item_id.in_(item_ids),  # type: ignore[union-attr]
            )
        ).all()
        liked_by_me = set(my_likes)

    # Bulk-load user + profile rows for every author in `rows` so the
    # feed render is one query each instead of N+1. Soft-deleted users
    # don't make the cache → their items render as "unknown" and the
    # client can decide whether to filter them.
    user_cache: dict[int, tuple[str, str | None, str | None]] = {}
    if rows:
        from sqlmodel import col
        author_ids = list({r.user_id for r in rows})
        users_by_id = {
            u.id: u for u in db.exec(
                select(User)
                .where(col(User.id).in_(author_ids))
                .where(User.is_active == True)  # noqa: E712
            ).all()
        }
        profs_by_id = {
            p.user_id: p for p in db.exec(
                select(UserSocialProfile).where(col(UserSocialProfile.user_id).in_(author_ids))
            ).all()
        }
        for uid in author_ids:
            u = users_by_id.get(uid)
            p = profs_by_id.get(uid)
            user_cache[uid] = (
                u.username if u else "unknown",
                p.display_name if p and p.display_name else None,
                _avatar_url(p),
            )
    items: list[dict] = []
    for r in rows:
        uname, dname, avatar_url = user_cache.get(r.user_id, ("unknown", None, None))
        items.append({
            "id": r.id,
            "user_id": r.user_id,
            "username": uname,
            "display_name": dname or uname,
            "avatar_url": avatar_url,
            "event_type": r.event_type,
            "payload": _sanitize_feed_payload_for_read(r.event_type, r.payload),
            "created_at": r.created_at.isoformat() if r.created_at else "",
            "like_count": like_counts.get(r.id, 0),
            "liked_by_me": r.id in liked_by_me,
        })
    return {"items": items}


@router.get("/feed/{user_id}")
def get_user_feed(
    user_id: int,
    limit: int = 30,
    before_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not SOCIAL_FEED_ENABLED:
        raise HTTPException(404, "social feed disabled")
    """Get a specific user's feed items. Only visible if they're a friend with sharing enabled, or it's yourself."""
    if user_id != current_user.id:
        friend_ids = _accepted_friend_ids(db, current_user.id)
        if user_id not in friend_ids:
            raise HTTPException(403, "not friends")
        prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == user_id)).first()
        if not prof or not prof.share_activity_enabled:
            raise HTTPException(403, "user has sharing disabled")

    q = (
        select(ActivityFeedItem)
        .where(ActivityFeedItem.user_id == user_id)
        .where(ActivityFeedItem.event_type.in_(FEED_EVENT_TYPES))
        .order_by(ActivityFeedItem.created_at.desc())
        .limit(min(limit, 50))
    )
    if before_id is not None:
        q = q.where(ActivityFeedItem.id < before_id)

    rows = db.exec(q).all()

    item_ids = [r.id for r in rows]
    like_counts: dict[int, int] = {}
    liked_by_me: set[int] = set()
    if item_ids:
        count_rows = db.exec(
            select(FeedLike.feed_item_id, sa_func.count())
            .where(FeedLike.feed_item_id.in_(item_ids))
            .group_by(FeedLike.feed_item_id)
        ).all()
        for fid, cnt in count_rows:
            like_counts[fid] = cnt
        my_likes = db.exec(
            select(FeedLike.feed_item_id).where(
                FeedLike.user_id == current_user.id,
                FeedLike.feed_item_id.in_(item_ids),
            )
        ).all()
        liked_by_me = set(my_likes)

    u = db.exec(
        select(User).where(User.id == user_id, User.is_active == True)  # noqa: E712
    ).first()
    p = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == user_id)).first()
    uname = u.username if u else "unknown"
    dname = p.display_name if p and p.display_name else None
    avatar_url = _avatar_url(p)

    items: list[dict] = []
    for r in rows:
        items.append({
            "id": r.id,
            "user_id": r.user_id,
            "username": uname,
            "display_name": dname or uname,
            "avatar_url": avatar_url,
            "event_type": r.event_type,
            "payload": _sanitize_feed_payload_for_read(r.event_type, r.payload),
            "created_at": r.created_at.isoformat() if r.created_at else "",
            "like_count": like_counts.get(r.id, 0),
            "liked_by_me": r.id in liked_by_me,
        })
    return {"items": items}


def write_activity(db: Session, user_id: int, event_type: str, payload: dict) -> None:
    if not SOCIAL_FEED_ENABLED:
        return
    if event_type not in FEED_EVENT_TYPES:
        return
    db.add(ActivityFeedItem(
        user_id=user_id,
        event_type=event_type,
        payload=_sanitize_feed_payload_for_read(event_type, payload),
    ))


# ─── Posts (user-created feed items) ────────────────────────────────────────

class CreatePostBody(BaseModel):
    caption: str | None = None
    photo_base64: str | None = None
    workout_summary: dict | None = None

    @field_validator("caption")
    @classmethod
    def _trim(cls, v):
        if v is None:
            return v
        v = v.strip()
        return v[:500] if v else None


def _sanitize_workout_summary(raw: dict) -> dict:
    """Whitelist the social workout payload.

    Social may show activity, streaks, and workout structure. It must
    never echo nutrition, body weight, body composition, or recovery
    internals if a buggy client includes them.
    """
    exercises = []
    for ex in list(raw.get("exercises") or [])[:20]:
        if not isinstance(ex, dict):
            continue
        sets = []
        for s in list(ex.get("sets") or [])[:20]:
            if not isinstance(s, dict):
                continue
            sets.append(_sanitize_workout_set(s))
        exercises.append({
            "name": str(ex.get("name") or "Exercise")[:80],
            "equipment": str(ex.get("equipment"))[:60] if ex.get("equipment") else None,
            "sets": sets,
        })

    training_score = _first_present(raw, "training_score", "trainingScore")
    training_rating = _first_present(raw, "training_rating", "trainingRating")
    clean = {
        "focus": str(raw.get("focus") or "Workout")[:80],
        "duration_seconds": int(_first_present(raw, "duration_seconds", "durationSeconds") or 0),
        "date": str(raw.get("date") or "")[:10],
        "exercises": exercises,
        "total_sets": int(_first_present(raw, "total_sets", "totalSets") or 0),
        "total_reps": int(_first_present(raw, "total_reps", "totalReps") or 0),
        "training_score": training_score if isinstance(training_score, (int, float)) else None,
        "training_rating": str(training_rating)[:40] if training_rating else None,
    }
    for key in ("activity_category", "activity_subtype", "cardio_style"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            clean[key] = value.strip()[:40]
    distance_miles = _coerce_positive_number(_first_present(raw, "distance_miles", "distanceMiles"))
    if distance_miles is not None:
        clean["distance_miles"] = distance_miles
    hr_summary = _sanitize_hr_summary(_first_present(raw, "hr_summary", "hrSummary"))
    if hr_summary:
        clean["hr_summary"] = hr_summary
    return clean


@router.post("/posts")
def create_post(
    body: CreatePostBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not SOCIAL_FEED_ENABLED:
        raise HTTPException(404, "social feed disabled")
    payload: dict = {}
    if body.caption:
        payload["caption"] = body.caption
    if body.photo_base64:
        payload["photo_base64"] = body.photo_base64
    if body.workout_summary:
        payload["workout_summary"] = _sanitize_workout_summary(body.workout_summary)

    item = ActivityFeedItem(
        user_id=current_user.id,
        event_type="workout_post",
        payload=_sanitize_feed_payload_for_read("workout_post", payload),
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"ok": True, "id": item.id}


@router.delete("/posts/{post_id}")
def delete_post(
    post_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not SOCIAL_FEED_ENABLED:
        raise HTTPException(404, "social feed disabled")
    item = db.exec(
        select(ActivityFeedItem).where(ActivityFeedItem.id == post_id)
    ).first()
    if not item or item.user_id != current_user.id:
        raise HTTPException(404, "post not found")
    likes = db.exec(select(FeedLike).where(FeedLike.feed_item_id == post_id)).all()
    for lk in likes:
        db.delete(lk)
    db.delete(item)
    db.commit()
    return {"ok": True}


@router.post("/feed/{item_id}/like")
def toggle_like(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    if not SOCIAL_FEED_ENABLED:
        raise HTTPException(404, "social feed disabled")
    item = db.exec(select(ActivityFeedItem).where(ActivityFeedItem.id == item_id)).first()
    if not item or item.event_type not in FEED_EVENT_TYPES:
        raise HTTPException(404, "item not found")
    if not _can_view_feed_author(db, current_user.id, item.user_id):
        raise HTTPException(404, "item not found")
    existing = db.exec(
        select(FeedLike).where(
            FeedLike.user_id == current_user.id,
            FeedLike.feed_item_id == item_id,
        )
    ).first()
    if existing:
        db.delete(existing)
        db.commit()
        return {"liked": False, "like_count": _feed_like_count(db, item_id)}
    db.add(FeedLike(user_id=current_user.id, feed_item_id=item_id))
    _create_social_notification(
        db,
        user_id=item.user_id,
        actor_user_id=current_user.id,
        notification_type="feed_like",
        subject_type="feed_item",
        subject_id=item.id,
        payload=_feed_notification_payload(item),
    )
    db.commit()
    return {"liked": True, "like_count": _feed_like_count(db, item_id)}
