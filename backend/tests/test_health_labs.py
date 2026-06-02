from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.models import User
from app.routers import health as health_router
from app.routers.ai import scanning as scanning_router


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _session_with_user() -> tuple[Session, User]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    session = Session(engine)
    user = User(
        email="labs@example.com",
        username="labsuser",
        hashed_password="x",
        subscription_tier="pro",
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return session, user


def test_lab_result_persistence_normalizes_and_deletes() -> None:
    print("\n[test] health labs: save/list/delete normalized rows")
    session, user = _session_with_user()
    original_refresh = health_router._refresh_health_dependents
    health_router._refresh_health_dependents = lambda *_args, **_kwargs: None
    try:
        row = health_router.create_lab_result(
            health_router.HealthLabResultPayload(
                lab_type="LDL-C",
                value=3.2,
                unit="mmol/L",
                collected_at="2026-05-01",
                source="scan",
            ),
            current_user=user,
            session=session,
        )
        assert row["lab_type"] == "ldl", row
        assert row["lab_label"] == "LDL", row
        assert row["value"] == 123.74, row
        assert row["unit"] == "mg/dL", row

        rows = health_router.list_lab_results(days=3650, current_user=user, session=session)
        assert len(rows) == 1
        assert rows[0]["id"] == row["id"]

        deleted = health_router.delete_lab_result(row["id"], current_user=user, session=session)
        assert deleted == {"status": "ok", "deleted": row["id"]}
        assert health_router.list_lab_results(days=3650, current_user=user, session=session) == []
        _ok("lab rows normalize LDL mmol/L, list, and delete cleanly")
    finally:
        health_router._refresh_health_dependents = original_refresh
        session.close()


def test_lab_scan_cleaning_normalizes_dates_units_and_dedupes() -> None:
    print("\n[test] health labs: scan cleanup normalizes candidate rows")
    result = scanning_router._clean_lab_scan_result({
        "report_collected_at": "05/01/2026",
        "labs": [
            {"lab_type": "glucose", "value": 5.0, "unit": "mmol/L", "confidence": "HIGH"},
            {"lab_type": "glucose", "value": 5.0, "unit": "mmol/L", "confidence": "medium"},
            {"label": "Vitamin D", "value": 50, "unit": "nmol/L", "confidence": "low"},
            {"label": "Patient age", "value": 34, "unit": "years"},
            {"lab_type": "Patient", "value": None, "unit": ""},
        ],
        "warnings": ["partial page"],
    })
    assert result["report_collected_at"] == "2026-05-01"
    assert result["count"] == 2, result
    glucose = result["labs"][0]
    vitamin_d = result["labs"][1]
    assert glucose["lab_type"] == "fasting_glucose"
    assert glucose["value"] == 90.09
    assert glucose["unit"] == "mg/dL"
    assert vitamin_d["lab_type"] == "vitamin_d"
    assert vitamin_d["value"] == 20.03
    assert vitamin_d["unit"] == "ng/mL"
    assert result["warnings"] == ["partial page"]
    _ok("scan candidates normalize dates/units and drop duplicates")


def test_lab_markers_expose_common_bloodwork_keys() -> None:
    print("\n[test] health labs: marker metadata")
    markers = health_router.get_lab_markers()["markers"]
    keys = {marker["key"] for marker in markers}
    assert {"a1c", "fasting_glucose", "ldl", "hdl", "triglycerides", "vitamin_d"} <= keys
    assert {"bone_mineral_density", "bone_density_t_score", "bone_density_z_score"} <= keys
    _ok("common lab marker metadata is exposed")


def test_bone_density_lab_aliases_and_units_normalize() -> None:
    print("\n[test] health labs: bone density aliases and units")
    result = scanning_router._clean_lab_scan_result({
        "report_collected_at": "2026-05-01",
        "labs": [
            {"label": "DEXA BMD", "value": 1120, "unit": "mg/cm2", "confidence": "high"},
            {"label": "T-score", "value": -1.2, "unit": "", "confidence": "high"},
            {"label": "Z-score", "value": -0.4, "unit": "", "confidence": "medium"},
        ],
    })
    rows = result["labs"]
    assert [row["lab_type"] for row in rows] == ["bone_mineral_density", "bone_density_t_score", "bone_density_z_score"], rows
    assert rows[0]["value"] == 1.12 and rows[0]["unit"] == "g/cm2", rows[0]
    assert rows[1]["unit"] == "T-score", rows[1]
    assert rows[2]["unit"] == "Z-score", rows[2]
    _ok("DXA/BMD rows normalize to canonical marker keys")


cases = [
    test_lab_result_persistence_normalizes_and_deletes,
    test_lab_scan_cleaning_normalizes_dates_units_and_dedupes,
    test_lab_markers_expose_common_bloodwork_keys,
    test_bone_density_lab_aliases_and_units_normalize,
]
