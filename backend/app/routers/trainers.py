"""Trainer/client relationships and trainer-facing client dashboards."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, field_validator
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import get_session
from app.models import (
    DailyRollup,
    PlanDay,
    TrainerClientNote,
    TrainerClientRelationship,
    TrainerProfile,
    User,
    UserDayState,
    UserSocialProfile,
    WeightEntry,
    WorkoutCompletion,
)

router = APIRouter(prefix="/trainers", tags=["trainers"])


class TrainerProfileRead(BaseModel):
    user_id: int
    display_name: str | None
    business_name: str | None
    bio: str | None
    website_url: str | None
    contact_email: str | None
    is_accepting_clients: bool
    created_at: datetime
    updated_at: datetime


class TrainerProfileUpdate(BaseModel):
    display_name: str | None = None
    business_name: str | None = None
    bio: str | None = None
    website_url: str | None = None
    contact_email: str | None = None
    is_accepting_clients: bool | None = None

    @field_validator("display_name", "business_name", "website_url", "contact_email")
    @classmethod
    def _trim_short(cls, v):
        if v is None:
            return None
        value = v.strip()
        return value[:160] or None

    @field_validator("bio")
    @classmethod
    def _trim_bio(cls, v):
        if v is None:
            return None
        value = v.strip()
        return value[:1000] or None


class TrainerPermissionFlags(BaseModel):
    share_workouts: bool = True
    share_nutrition: bool = False
    share_body_metrics: bool = False
    share_recovery: bool = True


class TrainerRelationshipRequest(TrainerPermissionFlags):
    username: str
    message: str | None = None

    @field_validator("username")
    @classmethod
    def _norm_username(cls, v):
        value = (v or "").strip().lower().lstrip("@")
        if not value:
            raise ValueError("username required")
        return value

    @field_validator("message")
    @classmethod
    def _trim_message(cls, v):
        if v is None:
            return None
        value = v.strip()
        return value[:500] or None


class AcceptTrainerRelationshipBody(BaseModel):
    share_workouts: bool | None = None
    share_nutrition: bool | None = None
    share_body_metrics: bool | None = None
    share_recovery: bool | None = None


class TrainerUserRead(BaseModel):
    user_id: int
    username: str
    display_name: str | None
    avatar_url: str | None
    trainer_business_name: str | None = None


class TrainerRelationshipRead(BaseModel):
    id: int
    status: str
    role: str
    direction: str
    trainer: TrainerUserRead
    client: TrainerUserRead
    share_workouts: bool
    share_nutrition: bool
    share_body_metrics: bool
    share_recovery: bool
    invite_message: str | None
    requested_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None


class TrainerRelationshipsRead(BaseModel):
    as_trainer: list[TrainerRelationshipRead]
    as_client: list[TrainerRelationshipRead]


class TrainerWorkoutSummary(BaseModel):
    planned: int
    completed: int
    missed: int
    adherence_pct: int
    last_workout_date: str | None
    focus_counts: dict[str, int]


class TrainerNutritionSummary(BaseModel):
    shared: bool
    days_logged: int | None = None
    avg_calories: float | None = None
    avg_protein_g: float | None = None
    protein_hit_days: int | None = None


class TrainerBodySummary(BaseModel):
    shared: bool
    latest_weight_lbs: float | None = None
    latest_weight_date: str | None = None


class TrainerRecoverySummary(BaseModel):
    shared: bool
    pain_present: bool | None = None
    pain_body_part: str | None = None
    soreness_body_part: str | None = None
    soreness_severity_0_10: int | None = None
    latest_sleep_hours: float | None = None


class TrainerClientSummary(BaseModel):
    relationship_id: int
    client: TrainerUserRead
    permissions: TrainerPermissionFlags
    workouts: TrainerWorkoutSummary
    nutrition: TrainerNutritionSummary
    body: TrainerBodySummary
    recovery: TrainerRecoverySummary
    flags: list[str]
    notes_count: int


class TrainerDashboardRead(BaseModel):
    window_start: str
    window_end: str
    clients: list[TrainerClientSummary]


class TrainerNoteCreate(BaseModel):
    body: str
    visible_to_client: bool = False

    @field_validator("body")
    @classmethod
    def _trim_body(cls, v):
        value = (v or "").strip()
        if not value:
            raise ValueError("note required")
        if len(value) > 2000:
            raise ValueError("note too long")
        return value


class TrainerNoteRead(BaseModel):
    id: int
    relationship_id: int
    trainer_user_id: int
    client_user_id: int
    author_user_id: int
    body: str
    visible_to_client: bool
    created_at: datetime
    updated_at: datetime


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _avatar_url(prof: UserSocialProfile | None) -> str | None:
    value = prof.avatar_url if prof else None
    return value.strip() if isinstance(value, str) and value.strip() else None


def _get_profile(db: Session, user_id: int) -> UserSocialProfile | None:
    return db.exec(select(UserSocialProfile).where(UserSocialProfile.user_id == user_id)).first()


def _get_trainer_profile(db: Session, user_id: int) -> TrainerProfile | None:
    return db.exec(select(TrainerProfile).where(TrainerProfile.user_id == user_id)).first()


def _get_or_create_trainer_profile(db: Session, user: User) -> TrainerProfile:
    prof = _get_trainer_profile(db, user.id)
    if prof:
        return prof
    social = _get_profile(db, user.id)
    display_name = social.display_name if social and social.display_name else user.username
    prof = TrainerProfile(user_id=user.id, display_name=display_name)
    db.add(prof)
    db.commit()
    db.refresh(prof)
    return prof


def _trainer_profile_read(row: TrainerProfile) -> TrainerProfileRead:
    return TrainerProfileRead(
        user_id=row.user_id,
        display_name=row.display_name,
        business_name=row.business_name,
        bio=row.bio,
        website_url=row.website_url,
        contact_email=row.contact_email,
        is_accepting_clients=row.is_accepting_clients,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _user_read(db: Session, user_id: int) -> TrainerUserRead:
    user = db.exec(select(User).where(User.id == user_id, User.is_active == True)).first()  # noqa: E712
    if not user:
        raise HTTPException(404, "user not found")
    social = _get_profile(db, user_id)
    trainer = _get_trainer_profile(db, user_id)
    display_name = (
        trainer.display_name
        or (social.display_name if social and social.display_name else None)
        or user.username
    ) if trainer else ((social.display_name if social and social.display_name else None) or user.username)
    return TrainerUserRead(
        user_id=user.id,
        username=user.username,
        display_name=display_name,
        avatar_url=_avatar_url(social),
        trainer_business_name=(trainer.business_name if trainer else None),
    )


def _relationship_read(db: Session, rel: TrainerClientRelationship, viewer_id: int) -> TrainerRelationshipRead:
    role = "trainer" if rel.trainer_user_id == viewer_id else "client"
    if rel.status == "active":
        direction = "active"
    elif rel.requested_by_id == viewer_id:
        direction = "outgoing"
    else:
        direction = "incoming"
    return TrainerRelationshipRead(
        id=rel.id,
        status=rel.status,
        role=role,
        direction=direction,
        trainer=_user_read(db, rel.trainer_user_id),
        client=_user_read(db, rel.client_user_id),
        share_workouts=rel.share_workouts,
        share_nutrition=rel.share_nutrition,
        share_body_metrics=rel.share_body_metrics,
        share_recovery=rel.share_recovery,
        invite_message=rel.invite_message,
        requested_at=rel.requested_at,
        accepted_at=rel.accepted_at,
        revoked_at=rel.revoked_at,
    )


def _relationship_for_viewer(db: Session, relationship_id: int, viewer_id: int) -> TrainerClientRelationship:
    rel = db.get(TrainerClientRelationship, relationship_id)
    if not rel or (rel.trainer_user_id != viewer_id and rel.client_user_id != viewer_id):
        raise HTTPException(404, "trainer relationship not found")
    return rel


def _active_relationship_for_trainer_client(
    db: Session,
    trainer_user_id: int,
    client_user_id: int,
) -> TrainerClientRelationship:
    rel = db.exec(
        select(TrainerClientRelationship).where(
            TrainerClientRelationship.trainer_user_id == trainer_user_id,
            TrainerClientRelationship.client_user_id == client_user_id,
            TrainerClientRelationship.status == "active",
        )
    ).first()
    if not rel:
        raise HTTPException(404, "active trainer relationship not found")
    return rel


def _find_active_user_by_username(db: Session, username: str) -> User:
    user = db.exec(
        select(User).where(
            User.username == username,
            User.is_active == True,  # noqa: E712
        )
    ).first()
    if not user:
        raise HTTPException(404, "user not found")
    return user


def _request_relationship(
    db: Session,
    *,
    trainer_user_id: int,
    client_user_id: int,
    requested_by_id: int,
    body: TrainerRelationshipRequest,
) -> TrainerClientRelationship:
    if trainer_user_id == client_user_id:
        raise HTTPException(400, "trainer and client must be different users")
    existing = db.exec(
        select(TrainerClientRelationship).where(
            TrainerClientRelationship.trainer_user_id == trainer_user_id,
            TrainerClientRelationship.client_user_id == client_user_id,
        )
    ).first()
    now = datetime.now(timezone.utc)
    if existing:
        if existing.status == "active":
            return existing
        if existing.status == "pending" and existing.requested_by_id != requested_by_id:
            existing.status = "active"
            existing.accepted_at = now
        else:
            existing.status = "pending"
            existing.accepted_at = None
            existing.revoked_at = None
        existing.requested_by_id = requested_by_id
        existing.requested_at = now
        existing.invite_message = body.message
        existing.share_workouts = body.share_workouts
        existing.share_nutrition = body.share_nutrition
        existing.share_body_metrics = body.share_body_metrics
        existing.share_recovery = body.share_recovery
        existing.updated_at = now
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return existing

    rel = TrainerClientRelationship(
        trainer_user_id=trainer_user_id,
        client_user_id=client_user_id,
        requested_by_id=requested_by_id,
        invite_message=body.message,
        share_workouts=body.share_workouts,
        share_nutrition=body.share_nutrition,
        share_body_metrics=body.share_body_metrics,
        share_recovery=body.share_recovery,
    )
    db.add(rel)
    db.commit()
    db.refresh(rel)
    return rel


def _workout_summary(db: Session, client_id: int, start: date, end: date) -> TrainerWorkoutSummary:
    plan_days = db.exec(
        select(PlanDay).where(
            PlanDay.user_id == client_id,
            PlanDay.day_date >= start,
            PlanDay.day_date <= end,
            PlanDay.is_rest == False,  # noqa: E712
        )
    ).all()
    completions = db.exec(
        select(WorkoutCompletion).where(
            WorkoutCompletion.user_id == client_id,
            WorkoutCompletion.workout_date >= start,
            WorkoutCompletion.workout_date <= end,
        )
    ).all()
    completed_dates = {c.workout_date for c in completions}
    today = _today()
    missed = 0
    for day in plan_days:
        if day.day_date >= today:
            continue
        if day.day_date in completed_dates or day.status == "completed":
            continue
        missed += 1
    focus_counts: dict[str, int] = {}
    for c in completions:
        label = c.focus_label or "Workout"
        focus_counts[label] = focus_counts.get(label, 0) + 1
    planned = len(plan_days)
    completed = len(completions)
    adherence = round((completed / planned) * 100) if planned else (100 if completed else 0)
    latest = max((c.workout_date for c in completions), default=None)
    return TrainerWorkoutSummary(
        planned=planned,
        completed=completed,
        missed=missed,
        adherence_pct=int(min(100, max(0, adherence))),
        last_workout_date=latest.isoformat() if latest else None,
        focus_counts=focus_counts,
    )


def _nutrition_summary(
    db: Session,
    client_id: int,
    start: date,
    end: date,
    shared: bool,
) -> TrainerNutritionSummary:
    if not shared:
        return TrainerNutritionSummary(shared=False)
    rows = db.exec(
        select(DailyRollup).where(
            DailyRollup.user_id == client_id,
            DailyRollup.day >= start,
            DailyRollup.day <= end,
        )
    ).all()
    logged = [
        r for r in rows
        if r.meals_logged > 0 or r.nutrition_log_status in {"partial", "rough_estimate", "complete"}
    ]
    calories = [r.kcal for r in logged if r.kcal > 0]
    proteins = [r.protein_g for r in logged if r.protein_g > 0]
    protein_hit_days = sum(
        1 for r in logged
        if r.protein_target_g and r.protein_g >= r.protein_target_g * 0.9
    )
    return TrainerNutritionSummary(
        shared=True,
        days_logged=len(logged),
        avg_calories=round(sum(calories) / len(calories), 1) if calories else None,
        avg_protein_g=round(sum(proteins) / len(proteins), 1) if proteins else None,
        protein_hit_days=protein_hit_days,
    )


def _body_summary(db: Session, client_id: int, shared: bool) -> TrainerBodySummary:
    if not shared:
        return TrainerBodySummary(shared=False)
    row = db.exec(
        select(WeightEntry)
        .where(WeightEntry.user_id == client_id)
        .order_by(WeightEntry.entry_date.desc())
        .limit(1)
    ).first()
    return TrainerBodySummary(
        shared=True,
        latest_weight_lbs=(row.weight_lbs if row else None),
        latest_weight_date=(row.entry_date.isoformat() if row else None),
    )


def _recovery_summary(
    db: Session,
    client_id: int,
    start: date,
    end: date,
    shared: bool,
) -> TrainerRecoverySummary:
    if not shared:
        return TrainerRecoverySummary(shared=False)
    state = db.exec(
        select(UserDayState)
        .where(
            UserDayState.user_id == client_id,
            UserDayState.day_key >= start,
            UserDayState.day_key <= end,
        )
        .order_by(UserDayState.day_key.desc())
        .limit(1)
    ).first()
    sleep_row = db.exec(
        select(DailyRollup)
        .where(
            DailyRollup.user_id == client_id,
            DailyRollup.day >= start,
            DailyRollup.day <= end,
            DailyRollup.sleep_h != None,  # noqa: E711
        )
        .order_by(DailyRollup.day.desc())
        .limit(1)
    ).first()
    return TrainerRecoverySummary(
        shared=True,
        pain_present=(state.pain_present if state else None),
        pain_body_part=(state.pain_body_part if state else None),
        soreness_body_part=(state.soreness_body_part if state else None),
        soreness_severity_0_10=(state.soreness_severity_0_10 if state else None),
        latest_sleep_hours=(sleep_row.sleep_h if sleep_row else None),
    )


def _flags(
    workouts: TrainerWorkoutSummary,
    nutrition: TrainerNutritionSummary,
    recovery: TrainerRecoverySummary,
) -> list[str]:
    flags: list[str] = []
    if workouts.planned > 0 and workouts.completed == 0:
        flags.append("no_training_logged")
    if workouts.missed >= 2:
        flags.append("missed_workouts")
    if nutrition.shared and (nutrition.days_logged or 0) <= 2:
        flags.append("low_nutrition_logging")
    if recovery.shared and (
        recovery.pain_present
        or (recovery.soreness_severity_0_10 is not None and recovery.soreness_severity_0_10 >= 7)
    ):
        flags.append("recovery_attention")
    return flags


@router.get("/profile", response_model=TrainerProfileRead | None)
def get_trainer_profile(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_trainer_profile(db, current_user.id)
    return _trainer_profile_read(row) if row else None


@router.patch("/profile", response_model=TrainerProfileRead)
def upsert_trainer_profile(
    body: TrainerProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    row = _get_or_create_trainer_profile(db, current_user)
    for field in ("display_name", "business_name", "bio", "website_url", "contact_email"):
        if field in body.model_fields_set:
            setattr(row, field, getattr(body, field))
    if body.is_accepting_clients is not None:
        row.is_accepting_clients = body.is_accepting_clients
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)
    return _trainer_profile_read(row)


@router.get("/relationships", response_model=TrainerRelationshipsRead)
def list_relationships(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(TrainerClientRelationship).where(
            (TrainerClientRelationship.trainer_user_id == current_user.id)
            | (TrainerClientRelationship.client_user_id == current_user.id)
        )
    ).all()
    visible = [r for r in rows if r.status in {"pending", "active"}]
    return TrainerRelationshipsRead(
        as_trainer=[
            _relationship_read(db, r, current_user.id)
            for r in visible
            if r.trainer_user_id == current_user.id
        ],
        as_client=[
            _relationship_read(db, r, current_user.id)
            for r in visible
            if r.client_user_id == current_user.id
        ],
    )


@router.post("/clients/request", response_model=TrainerRelationshipRead)
def request_client(
    body: TrainerRelationshipRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    _get_or_create_trainer_profile(db, current_user)
    target = _find_active_user_by_username(db, body.username)
    rel = _request_relationship(
        db,
        trainer_user_id=current_user.id,
        client_user_id=target.id,
        requested_by_id=current_user.id,
        body=body,
    )
    return _relationship_read(db, rel, current_user.id)


@router.post("/my-trainer/request", response_model=TrainerRelationshipRead)
def request_trainer(
    body: TrainerRelationshipRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    target = _find_active_user_by_username(db, body.username)
    _get_or_create_trainer_profile(db, target)
    rel = _request_relationship(
        db,
        trainer_user_id=target.id,
        client_user_id=current_user.id,
        requested_by_id=current_user.id,
        body=body,
    )
    return _relationship_read(db, rel, current_user.id)


@router.post("/relationships/{relationship_id}/accept", response_model=TrainerRelationshipRead)
def accept_relationship(
    relationship_id: int,
    body: AcceptTrainerRelationshipBody | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rel = _relationship_for_viewer(db, relationship_id, current_user.id)
    if rel.status != "pending":
        raise HTTPException(400, f"cannot accept (status={rel.status})")
    if rel.requested_by_id == current_user.id:
        raise HTTPException(400, "cannot accept own request")
    if body and current_user.id == rel.client_user_id:
        if body.share_workouts is not None:
            rel.share_workouts = body.share_workouts
        if body.share_nutrition is not None:
            rel.share_nutrition = body.share_nutrition
        if body.share_body_metrics is not None:
            rel.share_body_metrics = body.share_body_metrics
        if body.share_recovery is not None:
            rel.share_recovery = body.share_recovery
    rel.status = "active"
    rel.accepted_at = datetime.now(timezone.utc)
    rel.updated_at = rel.accepted_at
    db.add(rel)
    db.commit()
    db.refresh(rel)
    return _relationship_read(db, rel, current_user.id)


@router.post("/relationships/{relationship_id}/reject")
def reject_relationship(
    relationship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rel = _relationship_for_viewer(db, relationship_id, current_user.id)
    if rel.status != "pending":
        raise HTTPException(400, f"cannot reject (status={rel.status})")
    rel.status = "declined"
    rel.revoked_at = datetime.now(timezone.utc)
    rel.updated_at = rel.revoked_at
    db.add(rel)
    db.commit()
    return {"ok": True}


@router.post("/relationships/{relationship_id}/revoke")
def revoke_relationship(
    relationship_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rel = _relationship_for_viewer(db, relationship_id, current_user.id)
    rel.status = "revoked"
    rel.revoked_at = datetime.now(timezone.utc)
    rel.updated_at = rel.revoked_at
    db.add(rel)
    db.commit()
    return {"ok": True}


@router.get("/dashboard", response_model=TrainerDashboardRead)
def trainer_dashboard(
    days: int = Query(default=7, ge=1, le=30),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    end = _today()
    start = end - timedelta(days=days - 1)
    rows = db.exec(
        select(TrainerClientRelationship).where(
            TrainerClientRelationship.trainer_user_id == current_user.id,
            TrainerClientRelationship.status == "active",
        )
    ).all()
    summaries: list[TrainerClientSummary] = []
    for rel in rows:
        workouts = _workout_summary(db, rel.client_user_id, start, end)
        nutrition = _nutrition_summary(db, rel.client_user_id, start, end, rel.share_nutrition)
        body = _body_summary(db, rel.client_user_id, rel.share_body_metrics)
        recovery = _recovery_summary(db, rel.client_user_id, start, end, rel.share_recovery)
        notes = db.exec(
            select(TrainerClientNote.id).where(TrainerClientNote.relationship_id == rel.id)
        ).all()
        summaries.append(TrainerClientSummary(
            relationship_id=rel.id,
            client=_user_read(db, rel.client_user_id),
            permissions=TrainerPermissionFlags(
                share_workouts=rel.share_workouts,
                share_nutrition=rel.share_nutrition,
                share_body_metrics=rel.share_body_metrics,
                share_recovery=rel.share_recovery,
            ),
            workouts=workouts,
            nutrition=nutrition,
            body=body,
            recovery=recovery,
            flags=_flags(workouts, nutrition, recovery),
            notes_count=len(notes),
        ))
    summaries.sort(key=lambda s: (len(s.flags), s.workouts.missed), reverse=True)
    return TrainerDashboardRead(
        window_start=start.isoformat(),
        window_end=end.isoformat(),
        clients=summaries,
    )


@router.get("/clients/{client_user_id}/timeline")
def client_timeline(
    client_user_id: int,
    days: int = Query(default=14, ge=1, le=60),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rel = _active_relationship_for_trainer_client(db, current_user.id, client_user_id)
    end = _today()
    start = end - timedelta(days=days - 1)
    plan_days = db.exec(
        select(PlanDay).where(
            PlanDay.user_id == client_user_id,
            PlanDay.day_date >= start,
            PlanDay.day_date <= end,
        )
    ).all()
    completions = db.exec(
        select(WorkoutCompletion).where(
            WorkoutCompletion.user_id == client_user_id,
            WorkoutCompletion.workout_date >= start,
            WorkoutCompletion.workout_date <= end,
        )
    ).all()
    rollups = db.exec(
        select(DailyRollup).where(
            DailyRollup.user_id == client_user_id,
            DailyRollup.day >= start,
            DailyRollup.day <= end,
        )
    ).all() if rel.share_nutrition else []
    states = db.exec(
        select(UserDayState).where(
            UserDayState.user_id == client_user_id,
            UserDayState.day_key >= start,
            UserDayState.day_key <= end,
        )
    ).all() if rel.share_recovery else []
    weights = db.exec(
        select(WeightEntry).where(
            WeightEntry.user_id == client_user_id,
            WeightEntry.entry_date >= start,
            WeightEntry.entry_date <= end,
        )
    ).all() if rel.share_body_metrics else []

    plans_by_day = {p.day_date: p for p in plan_days}
    rollups_by_day = {r.day: r for r in rollups}
    states_by_day = {s.day_key: s for s in states}
    weights_by_day = {w.entry_date: w for w in weights}
    completions_by_day: dict[date, list[WorkoutCompletion]] = {}
    for c in completions:
        completions_by_day.setdefault(c.workout_date, []).append(c)

    days_out = []
    for offset in range(days):
        day = start + timedelta(days=offset)
        plan = plans_by_day.get(day)
        roll = rollups_by_day.get(day)
        state = states_by_day.get(day)
        weight = weights_by_day.get(day)
        days_out.append({
            "date": day.isoformat(),
            "plan": {
                "status": plan.status if plan else None,
                "is_rest": plan.is_rest if plan else None,
                "focus": (plan.workout_json or {}).get("focus") if plan and isinstance(plan.workout_json, dict) else None,
            },
            "workouts": [
                {
                    "id": c.id,
                    "focus": c.focus_label,
                    "duration_seconds": c.duration_seconds,
                    "feeling": c.feeling,
                    "intensity": c.intensity,
                    "soreness_areas": c.soreness_areas,
                }
                for c in completions_by_day.get(day, [])
            ],
            "nutrition": ({
                "meals_logged": roll.meals_logged,
                "nutrition_log_status": roll.nutrition_log_status,
                "kcal": roll.kcal,
                "protein_g": roll.protein_g,
                "protein_target_g": roll.protein_target_g,
            } if roll and rel.share_nutrition else None),
            "recovery": ({
                "pain_present": state.pain_present,
                "pain_body_part": state.pain_body_part,
                "soreness_body_part": state.soreness_body_part,
                "soreness_severity_0_10": state.soreness_severity_0_10,
            } if state and rel.share_recovery else None),
            "body": ({
                "weight_lbs": weight.weight_lbs,
            } if weight and rel.share_body_metrics else None),
        })
    return {
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "relationship": _relationship_read(db, rel, current_user.id),
        "days": days_out,
    }


@router.get("/clients/{client_user_id}/notes", response_model=list[TrainerNoteRead])
def list_client_notes(
    client_user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rel = _active_relationship_for_trainer_client(db, current_user.id, client_user_id)
    rows = db.exec(
        select(TrainerClientNote)
        .where(TrainerClientNote.relationship_id == rel.id)
        .order_by(TrainerClientNote.created_at.desc())
        .limit(100)
    ).all()
    return [TrainerNoteRead(**r.model_dump()) for r in rows]


@router.post("/clients/{client_user_id}/notes", response_model=TrainerNoteRead, status_code=201)
def create_client_note(
    client_user_id: int,
    body: TrainerNoteCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    rel = _active_relationship_for_trainer_client(db, current_user.id, client_user_id)
    note = TrainerClientNote(
        relationship_id=rel.id,
        trainer_user_id=current_user.id,
        client_user_id=client_user_id,
        author_user_id=current_user.id,
        body=body.body,
        visible_to_client=body.visible_to_client,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return TrainerNoteRead(**note.model_dump())
