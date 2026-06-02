"""Saved meal share/import API tests."""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine
    import app.models  # noqa: F401 — register SQLModel tables

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, username: str, tier: str = "pro") -> int:
    from app.models import User

    user = User(
        email=f"{username}@example.com",
        username=username,
        hashed_password="x",
        subscription_tier=tier,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return int(user.id)


def _make_test_app(engine, user_id_holder: dict):
    from fastapi import FastAPI
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.saved_meals import router as saved_meals_router

    app_db.engine = engine

    def _session_override():
        with Session(engine) as session:
            yield session

    def _user_override():
        with Session(engine) as session:
            user = session.get(User, user_id_holder["id"])
            if user is not None:
                _ = (user.id, user.email, user.username, user.hashed_password, user.subscription_tier)
                session.expunge(user)
            return user

    app = FastAPI()
    app.include_router(saved_meals_router)
    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_user] = _user_override
    return app


def _client(engine, user_id_holder):
    from fastapi.testclient import TestClient

    return TestClient(_make_test_app(engine, user_id_holder))


def _meal_body(name: str = "Chicken rice bowl") -> dict:
    return {
        "name": name,
        "notes": "post-lift staple",
        "items": [
            {
                "food_name": "chicken breast",
                "quantity": 6,
                "unit": "oz",
                "serving_grams": 170,
                "calories": 280,
                "protein_g": 52,
                "carbs_g": 0,
                "fat_g": 6,
            },
            {
                "food_name": "rice",
                "quantity": 1,
                "unit": "cup",
                "serving_grams": 185,
                "calories": 205,
                "protein_g": 4,
                "carbs_g": 45,
                "fat_g": 0,
            },
        ],
    }


def test_saved_meal_share_preview_import_round_trip() -> None:
    from sqlmodel import Session

    engine = _make_mem_engine()
    with Session(engine) as session:
        owner_id = _insert_user(session, username="chef")
        recipient_id = _insert_user(session, username="lifter")

    holder = {"id": owner_id}
    client = _client(engine, holder)

    created = client.post("/meals/saved", json=_meal_body())
    assert created.status_code == 201, created.text
    saved_id = created.json()["id"]

    shared = client.post(f"/meals/saved/{saved_id}/share")
    assert shared.status_code == 200, shared.text
    code = shared.json()["shareCode"]
    assert code and len(code) == 6
    assert all(c in "23456789ABCDEFGHJKMNPQRSTUVWXYZ" for c in code)

    holder["id"] = recipient_id
    preview = client.get(f"/meals/saved/shared/{code.lower()}")
    assert preview.status_code == 200, preview.text
    assert preview.json()["name"] == "Chicken rice bowl"
    assert preview.json()["owner_username"] == "chef"
    assert preview.json()["owned_by_viewer"] is False

    imported = client.post(f"/meals/saved/shared/{code}/import")
    assert imported.status_code == 201, imported.text
    imported_body = imported.json()
    assert imported_body["name"] == "Chicken rice bowl"
    assert imported_body["source_share_code"] == code
    assert imported_body["source_owner_username"] == "chef"
    assert imported_body["share_code"] is None
    assert imported_body["times_logged"] == 0
    assert imported_body["items"][0]["food_name"] == "chicken breast"

    again = client.post(f"/meals/saved/shared/{code}/import")
    assert again.status_code == 201, again.text
    assert again.json()["id"] == imported_body["id"]

    holder["id"] = owner_id
    owner_preview = client.get(f"/meals/saved/shared/{code}")
    assert owner_preview.status_code == 200, owner_preview.text
    assert owner_preview.json()["owned_by_viewer"] is True

    self_import = client.post(f"/meals/saved/shared/{code}/import")
    assert self_import.status_code == 400, self_import.text

    with Session(engine) as session:
        from app.models import SavedMeal

        source = session.get(SavedMeal, saved_id)
        assert source.times_imported == 1

    _ok("saved meal share/preview/import round-trip")


def test_saved_meal_share_revoke_hides_code() -> None:
    from sqlmodel import Session

    engine = _make_mem_engine()
    with Session(engine) as session:
        owner_id = _insert_user(session, username="owner")
        recipient_id = _insert_user(session, username="recipient")

    holder = {"id": owner_id}
    client = _client(engine, holder)
    created = client.post("/meals/saved", json=_meal_body("Yogurt bowl"))
    saved_id = created.json()["id"]
    code = client.post(f"/meals/saved/{saved_id}/share").json()["shareCode"]

    revoke = client.delete(f"/meals/saved/{saved_id}/share")
    assert revoke.status_code == 204, revoke.text

    holder["id"] = recipient_id
    preview = client.get(f"/meals/saved/shared/{code}")
    assert preview.status_code == 404, preview.text

    _ok("revoked saved meal code no longer previews")


def test_free_saved_meal_import_is_unlimited() -> None:
    from sqlmodel import Session

    engine = _make_mem_engine()
    with Session(engine) as session:
        owner_id = _insert_user(session, username="owner")
        free_id = _insert_user(session, username="freebie", tier="free")

    holder = {"id": owner_id}
    client = _client(engine, holder)
    created = client.post("/meals/saved", json=_meal_body("Shared meal"))
    code = client.post(f"/meals/saved/{created.json()['id']}/share").json()["shareCode"]

    holder["id"] = free_id
    for i in range(8):
        r = client.post("/meals/saved", json=_meal_body(f"Existing {i}"))
        assert r.status_code == 201, r.text

    imported = client.post(f"/meals/saved/shared/{code}/import")
    assert imported.status_code == 201, imported.text
    assert imported.json()["source_share_code"] == code

    _ok("free saved meals stay unlimited, including shared imports")


if __name__ == "__main__":
    test_saved_meal_share_preview_import_round_trip()
    test_saved_meal_share_revoke_hides_code()
    test_free_saved_meal_import_is_unlimited()
