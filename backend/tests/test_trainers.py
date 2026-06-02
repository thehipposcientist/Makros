"""Trainer/client relationship MVP.

Covers:
  - trainer invite -> client accept with explicit data permissions
  - client invite -> trainer accept
  - dashboard nutrition/body data stays hidden unless the client shares it
  - client timeline and trainer notes are scoped to the active trainer
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import (
    DailyRollup,
    PlanDay,
    PlanWeek,
    TrainerClientNote,
    TrainerClientRelationship,
    User,
    UserDayState,
    UserSocialProfile,
    WeightEntry,
    WorkoutCompletion,
)
from app.routers.trainers import (
    AcceptTrainerRelationshipBody,
    TrainerNoteCreate,
    TrainerRelationshipRequest,
    accept_relationship,
    client_timeline,
    create_client_note,
    list_client_notes,
    request_client,
    request_trainer,
    trainer_dashboard,
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
    s.add(UserSocialProfile(user_id=uid, display_name=username.title()))
    return u


def _seed_client_activity(s: Session, client_id: int) -> None:
    today = date.today()
    week = PlanWeek(
        user_id=client_id,
        start_date=today - timedelta(days=3),
        end_date=today + timedelta(days=3),
        planner_version="test",
        goal="muscle_gain",
        days_per_week=4,
    )
    s.add(week)
    s.flush()
    for idx in range(4):
        s.add(PlanDay(
            plan_week_id=week.id,
            user_id=client_id,
            day_date=today - timedelta(days=idx + 1),
            day_index=idx,
            is_rest=False,
            status="planned",
            workout_json={"focus": "Push" if idx == 0 else "Pull"},
        ))
    s.add(WorkoutCompletion(
        user_id=client_id,
        workout_date=today - timedelta(days=1),
        focus_label="Push",
        duration_seconds=2700,
        feeling="good",
        intensity=3,
        completed_at=datetime.now(timezone.utc),
    ))
    s.add(DailyRollup(
        user_id=client_id,
        day=today - timedelta(days=1),
        kcal=2600,
        protein_g=186,
        meals_logged=4,
        nutrition_log_status="complete",
        protein_target_g=180,
        sleep_h=6.4,
    ))
    s.add(WeightEntry(
        user_id=client_id,
        entry_date=today - timedelta(days=1),
        weight_lbs=181.5,
    ))
    s.add(UserDayState(
        user_id=client_id,
        day_key=today - timedelta(days=1),
        pain_present=True,
        pain_body_part="knee",
        soreness_body_part="quads",
        soreness_severity_0_10=8,
    ))
    s.commit()


def test_trainer_invite_accept_dashboard_respects_client_permissions() -> None:
    print("\n[test] trainer invite dashboard respects client permissions")
    eng = _make_engine()
    with Session(eng) as s:
        trainer = _user(s, 1, "coach")
        client = _user(s, 2, "client")
        s.commit()

        pending = request_client(
            TrainerRelationshipRequest(
                username="client",
                share_nutrition=True,
                share_body_metrics=True,
                share_recovery=True,
                message="Let's connect.",
            ),
            current_user=trainer,
            db=s,
        )
        assert pending.status == "pending"
        assert pending.direction == "outgoing"

        active = accept_relationship(
            pending.id,
            AcceptTrainerRelationshipBody(
                share_nutrition=False,
                share_body_metrics=False,
                share_recovery=True,
            ),
            current_user=client,
            db=s,
        )
        assert active.status == "active"
        assert active.share_nutrition is False
        assert active.share_body_metrics is False

        _seed_client_activity(s, client.id)
        dash = trainer_dashboard(days=7, current_user=trainer, db=s)
        assert len(dash.clients) == 1
        summary = dash.clients[0]
        assert summary.workouts.planned == 4
        assert summary.workouts.completed == 1
        assert summary.nutrition.shared is False
        assert summary.nutrition.avg_calories is None
        assert summary.body.shared is False
        assert summary.body.latest_weight_lbs is None
        assert summary.recovery.shared is True
        assert summary.recovery.pain_present is True
        assert "recovery_attention" in summary.flags
    _ok("permission flags hide nutrition/body metrics while preserving recovery context")


def test_client_invite_trainer_can_share_nutrition_after_accept() -> None:
    print("\n[test] client invite trainer grants nutrition visibility")
    eng = _make_engine()
    with Session(eng) as s:
        trainer = _user(s, 1, "coach")
        client = _user(s, 2, "client")
        s.commit()

        pending = request_trainer(
            TrainerRelationshipRequest(
                username="coach",
                share_nutrition=True,
                share_body_metrics=False,
                share_recovery=True,
            ),
            current_user=client,
            db=s,
        )
        assert pending.role == "client"
        assert pending.direction == "outgoing"

        active = accept_relationship(
            pending.id,
            AcceptTrainerRelationshipBody(),
            current_user=trainer,
            db=s,
        )
        assert active.status == "active"
        assert active.share_nutrition is True

        _seed_client_activity(s, client.id)
        dash = trainer_dashboard(days=7, current_user=trainer, db=s)
        summary = dash.clients[0]
        assert summary.nutrition.shared is True
        assert summary.nutrition.days_logged == 1
        assert summary.nutrition.avg_calories == 2600
        assert summary.nutrition.avg_protein_g == 186
        assert summary.nutrition.protein_hit_days == 1
    _ok("client-initiated relationship exposes nutrition only after consent")


def test_unrelated_trainer_cannot_open_timeline_or_notes() -> None:
    print("\n[test] unrelated trainer cannot read client timeline or notes")
    eng = _make_engine()
    with Session(eng) as s:
        trainer = _user(s, 1, "coach")
        other_trainer = _user(s, 3, "othercoach")
        client = _user(s, 2, "client")
        s.add(TrainerClientRelationship(
            trainer_user_id=trainer.id,
            client_user_id=client.id,
            requested_by_id=client.id,
            status="active",
            accepted_at=datetime.now(timezone.utc),
            share_nutrition=True,
        ))
        s.commit()

        try:
            client_timeline(client.id, days=14, current_user=other_trainer, db=s)
            raise AssertionError("timeline should be forbidden")
        except HTTPException as exc:
            assert exc.status_code == 404

        try:
            create_client_note(
                client.id,
                TrainerNoteCreate(body="Private note"),
                current_user=other_trainer,
                db=s,
            )
            raise AssertionError("note creation should be forbidden")
        except HTTPException as exc:
            assert exc.status_code == 404
    _ok("timeline and notes require the active trainer/client pair")


def test_trainer_notes_are_scoped_to_the_active_trainer() -> None:
    print("\n[test] trainer notes are scoped to trainer relationship")
    eng = _make_engine()
    with Session(eng) as s:
        trainer = _user(s, 1, "coach")
        client = _user(s, 2, "client")
        rel = TrainerClientRelationship(
            trainer_user_id=trainer.id,
            client_user_id=client.id,
            requested_by_id=client.id,
            status="active",
            accepted_at=datetime.now(timezone.utc),
        )
        s.add(rel)
        s.commit()

        note = create_client_note(
            client.id,
            TrainerNoteCreate(body="Watch knee soreness next lower day."),
            current_user=trainer,
            db=s,
        )
        assert note.body.startswith("Watch knee")
        notes = list_client_notes(client.id, current_user=trainer, db=s)
        assert len(notes) == 1

        rows = s.exec(select(TrainerClientNote)).all()
        assert len(rows) == 1
        assert rows[0].relationship_id == rel.id
        try:
            list_client_notes(client.id, current_user=client, db=s)
            raise AssertionError("client should not read trainer-private notes")
        except HTTPException as exc:
            assert exc.status_code == 404
    _ok("trainer private notes persist and stay out of the client path")


cases = [
    test_trainer_invite_accept_dashboard_respects_client_permissions,
    test_client_invite_trainer_can_share_nutrition_after_accept,
    test_unrelated_trainer_cannot_open_timeline_or_notes,
    test_trainer_notes_are_scoped_to_the_active_trainer,
]


if __name__ == "__main__":
    for case in cases:
        case()
    print("\nPASS test_trainers")
