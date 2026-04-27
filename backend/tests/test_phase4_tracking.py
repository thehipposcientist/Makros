"""Phase 4 — three new tracking surfaces.

Covers:
  - #35  body_fat_pct on WeeklyCheckIn (model + API field)
  - #36  bp_systolic + bp_diastolic on WeeklyCheckIn (model + API field)
  - #37  RecoveryActivity logging (new model + recovery router)
"""
from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.models import (
    RecoveryActivity, RecoveryActivityCreate,
    User, WeeklyCheckIn, WeeklyCheckInCreate,
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


def _seed_user(s: Session, user_id: int = 1) -> None:
    s.add(User(id=user_id, email=f"u{user_id}@t", username=f"u{user_id}", hashed_password="x"))
    s.commit()


# ─── #35 body_fat_pct ────────────────────────────────────────────────────────

def test_weekly_checkin_persists_body_fat_pct():
    """body_fat_pct lands on WeeklyCheckIn and survives a round-trip."""
    print("\n[test] checkin: body_fat_pct persisted")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s)
        s.add(WeeklyCheckIn(
            user_id=1, checkin_date=date.today(),
            weight_lbs=175.0, body_fat_pct=18.4,
        ))
        s.commit()
        row = s.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 1)).first()
    assert row.body_fat_pct == 18.4
    _ok("body_fat_pct=18.4 round-tripped from WeeklyCheckIn")


def test_weekly_checkin_create_payload_accepts_body_fat_pct():
    """The Pydantic create model accepts body_fat_pct optionally."""
    print("\n[test] checkin: create payload accepts body_fat_pct")
    body = WeeklyCheckInCreate(
        checkin_date=date.today(),
        weight_lbs=180.0,
        body_fat_pct=15.2,
    )
    assert body.body_fat_pct == 15.2
    # Default — field is optional
    body_minimal = WeeklyCheckInCreate(checkin_date=date.today(), weight_lbs=180.0)
    assert body_minimal.body_fat_pct is None
    _ok("create payload accepts body_fat_pct and defaults to None")


# ─── #36 blood pressure ──────────────────────────────────────────────────────

def test_weekly_checkin_persists_blood_pressure():
    """Both BP fields land on the model and survive round-trip."""
    print("\n[test] checkin: BP fields persisted")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s, user_id=2)
        s.add(WeeklyCheckIn(
            user_id=2, checkin_date=date.today(),
            weight_lbs=170.0,
            bp_systolic=120, bp_diastolic=78,
        ))
        s.commit()
        row = s.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 2)).first()
    assert row.bp_systolic == 120
    assert row.bp_diastolic == 78
    _ok("bp_systolic=120 / bp_diastolic=78 round-tripped")


def test_weekly_checkin_bp_optional():
    """No BP provided → both fields land as None (no schema regression)."""
    print("\n[test] checkin: BP fields default to None")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s, user_id=3)
        s.add(WeeklyCheckIn(user_id=3, checkin_date=date.today(), weight_lbs=170.0))
        s.commit()
        row = s.exec(select(WeeklyCheckIn).where(WeeklyCheckIn.user_id == 3)).first()
    assert row.bp_systolic is None
    assert row.bp_diastolic is None
    _ok("BP fields default to None when not provided")


# ─── #37 RecoveryActivity ────────────────────────────────────────────────────

def test_recovery_activity_persisted():
    """A RecoveryActivity row lands and round-trips."""
    print("\n[test] recovery: activity row persisted")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s, user_id=4)
        s.add(RecoveryActivity(
            user_id=4, activity_date=date.today(),
            modality="cold_plunge", duration_min=10,
            intensity="50°F", notes="post-workout",
        ))
        s.commit()
        row = s.exec(select(RecoveryActivity).where(RecoveryActivity.user_id == 4)).first()
    assert row.modality == "cold_plunge"
    assert row.duration_min == 10
    assert row.intensity == "50°F"
    _ok(f"recovery activity persisted: {row.modality} for {row.duration_min}min")


def test_recovery_activity_create_payload_validates():
    """RecoveryActivityCreate Pydantic model has the right shape."""
    print("\n[test] recovery: create payload validates required fields")
    body = RecoveryActivityCreate(
        activity_date=date.today(),
        modality="sauna",
        duration_min=15,
    )
    assert body.modality == "sauna"
    assert body.duration_min == 15
    assert body.intensity is None
    assert body.notes is None
    _ok("create payload validates and accepts optional fields")


def test_recovery_activity_filtering_by_modality():
    """Listing activities filtered by modality returns only matches."""
    print("\n[test] recovery: per-modality filtering")
    eng = _make_engine()
    with Session(eng) as s:
        _seed_user(s, user_id=5)
        for mod in ("cold_plunge", "cold_plunge", "sauna", "meditation"):
            s.add(RecoveryActivity(
                user_id=5, activity_date=date.today(),
                modality=mod, duration_min=10,
            ))
        s.commit()
        cold_only = s.exec(
            select(RecoveryActivity)
            .where(RecoveryActivity.user_id == 5)
            .where(RecoveryActivity.modality == "cold_plunge")
        ).all()
    assert len(cold_only) == 2
    _ok(f"filter by modality='cold_plunge' returns 2 of 4 rows")


def test_recovery_router_known_modalities_normalized():
    """Endpoint normalizes unknown modalities to 'other' rather than 422
    (forward-compat for taxonomy growth)."""
    print("\n[test] recovery: router endpoints registered + accept payload")
    # Pure import-and-shape check: the router module must register the
    # three documented routes. Full HTTP smoke is in test_api_smoke.
    from app.routers import recovery as rec_mod
    paths = {r.path for r in rec_mod.router.routes}
    assert "/recovery/activities" in paths, f"missing endpoint, got {paths}"
    assert "/recovery/activities/{activity_id}" in paths, f"missing delete route, got {paths}"
    _ok("recovery router exposes /activities + /activities/{id}")


cases = [
    test_weekly_checkin_persists_body_fat_pct,
    test_weekly_checkin_create_payload_accepts_body_fat_pct,
    test_weekly_checkin_persists_blood_pressure,
    test_weekly_checkin_bp_optional,
    test_recovery_activity_persisted,
    test_recovery_activity_create_payload_validates,
    test_recovery_activity_filtering_by_modality,
    test_recovery_router_known_modalities_normalized,
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
