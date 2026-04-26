"""Social router — friends + weekly digest only.

No live feed, no posts, no reactions. The whole point is the stripped
shape: friend list + once-a-week digest.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import (
    User, UserSocialProfile, Friendship, WeeklyDigestCache, UserGoal,
    ActivityFeedItem,
)
from app.services.social.digest import compute_digest, week_start_for, _accepted_friend_ids

router = APIRouter(prefix="/social", tags=["social"])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SocialMeRead(BaseModel):
    user_id: int
    username: str
    display_name: str | None
    share_activity_enabled: bool


class SocialMeUpdate(BaseModel):
    display_name: str | None = None
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


class FriendRead(BaseModel):
    friendship_id: int
    user_id: int
    username: str
    display_name: str | None
    goal: str | None
    last_active_within_48h: bool
    streak: int


class PendingRequestRead(BaseModel):
    friendship_id: int
    user_id: int
    username: str
    display_name: str | None
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


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _canonical_pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


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
    other = db.exec(select(User).where(User.id == other_id)).first()
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
        goal=(goal_row.goal_type.value if goal_row else None),
        last_active_within_48h=active_48h,
        streak=streak,
    )


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

    friends: list[FriendRead] = []
    pending: list[PendingRequestRead] = []
    for r in rows:
        other_id = r.user_b_id if r.user_a_id == current_user.id else r.user_a_id
        if r.status == "accepted":
            friends.append(_hydrate_friend(db, current_user.id, other_id, r.id))
        elif r.status == "pending":
            other = db.exec(select(User).where(User.id == other_id)).first()
            if not other:
                continue
            prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == other_id)).first()
            pending.append(PendingRequestRead(
                friendship_id=r.id,
                user_id=other_id,
                username=other.username,
                display_name=(prof.display_name if prof and prof.display_name else other.username),
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
    target = db.exec(select(User).where(User.username == body.username)).first()
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
                db.commit()
            return PendingRequestRead(
                friendship_id=existing.id,
                user_id=target.id,
                username=target.username,
                display_name=None,
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
    db.commit()
    db.refresh(fs)
    prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == target.id)).first()
    return PendingRequestRead(
        friendship_id=fs.id,
        user_id=target.id,
        username=target.username,
        display_name=(prof.display_name if prof and prof.display_name else target.username),
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
        .limit(10)
    ).all()
    out: list[SearchHit] = []
    for u in rows:
        prof = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == u.id)).first()
        out.append(SearchHit(
            user_id=u.id,
            username=u.username,
            display_name=(prof.display_name if prof and prof.display_name else None),
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
        age = (datetime.now(timezone.utc) - cached.generated_at).total_seconds()
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


# ─── Activity Feed ──────────────────────────────────────────────────────────

class FeedItemRead(BaseModel):
    id: int
    user_id: int
    username: str
    display_name: str | None
    event_type: str
    payload: dict
    created_at: str


@router.get("/feed")
def get_feed(
    limit: int = 30,
    before_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
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
        .order_by(ActivityFeedItem.created_at.desc())  # type: ignore[union-attr]
        .limit(min(limit, 50))
    )
    if before_id is not None:
        q = q.where(ActivityFeedItem.id < before_id)

    rows = db.exec(q).all()

    user_cache: dict[int, tuple[str, str | None]] = {}
    items: list[dict] = []
    for r in rows:
        if r.user_id not in user_cache:
            u = db.exec(select(User).where(User.id == r.user_id)).first()
            p = db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == r.user_id)).first()
            user_cache[r.user_id] = (
                u.username if u else "unknown",
                p.display_name if p and p.display_name else None,
            )
        uname, dname = user_cache[r.user_id]
        items.append({
            "id": r.id,
            "user_id": r.user_id,
            "username": uname,
            "display_name": dname or uname,
            "event_type": r.event_type,
            "payload": r.payload,
            "created_at": r.created_at.isoformat() if r.created_at else "",
        })
    return {"items": items}


def write_activity(db: Session, user_id: int, event_type: str, payload: dict) -> None:
    db.add(ActivityFeedItem(
        user_id=user_id,
        event_type=event_type,
        payload=payload,
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


@router.post("/posts")
def create_post(
    body: CreatePostBody,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    payload: dict = {}
    if body.caption:
        payload["caption"] = body.caption
    if body.photo_base64:
        payload["photo_base64"] = body.photo_base64
    if body.workout_summary:
        payload["workout_summary"] = body.workout_summary

    item = ActivityFeedItem(
        user_id=current_user.id,
        event_type="workout_post",
        payload=payload,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return {"ok": True, "id": item.id}
