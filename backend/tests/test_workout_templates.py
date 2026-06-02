"""End-to-end HTTP tests for /workouts/templates and /workouts/templates/shared.

Covers CRUD, free-tier cap enforcement, share-code generation/uniqueness,
preview, idempotent import, self-import block, revoke. In-memory SQLite +
FastAPI TestClient + dependency overrides (same pattern as
test_generate_week_endpoint.py).
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401  — register tables
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, WorkoutTemplate,
        WorkoutTemplateBundle, WorkoutTemplateBundleItem,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _insert_user(session, *, username: str, tier: str = "free") -> int:
    """Insert a user and return the int PK (not the ORM instance — the
    caller usually uses the id outside the session, where ORM access
    would raise DetachedInstanceError)."""
    from app.models import User
    u = User(
        email=f"{username}@example.com",
        username=username,
        hashed_password="x",
        subscription_tier=tier,
    )
    session.add(u)
    session.commit()
    session.refresh(u)
    return int(u.id)


def _make_test_app(engine, user_id_holder: dict):
    """FastAPI app wired to use `engine` and impersonate the user whose
    id sits in user_id_holder['id']. Tests can flip the impersonated user
    by mutating the dict — useful for share/import flows that need two
    different users hitting the same app."""
    from fastapi import FastAPI
    from sqlmodel import Session

    from app import database as app_db
    from app.auth import get_current_user
    from app.database import get_session
    from app.models import User
    from app.routers.workout_templates import router as templates_router

    app_db.engine = engine

    def _session_override():
        with Session(engine) as s:
            yield s

    def _user_override():
        with Session(engine) as s:
            u = s.get(User, user_id_holder["id"])
            if u is not None:
                _ = (u.id, u.email, u.username, u.hashed_password,
                     u.subscription_tier, u.is_active, u.created_at)
                s.expunge(u)
            return u

    app = FastAPI()
    app.include_router(templates_router)
    app.dependency_overrides[get_session] = _session_override
    app.dependency_overrides[get_current_user] = _user_override
    return app


def _sample_workout(focus: str = "Push") -> dict:
    return {
        "focus": focus,
        "exercises": [
            {"name": "Bench Press", "sets": [{"reps": 5, "weight_lbs": 185}]},
            {"name": "Overhead Press", "sets": [{"reps": 8, "weight_lbs": 95}]},
        ],
    }


def _client(engine, user_id_holder):
    from fastapi.testclient import TestClient
    return TestClient(_make_test_app(engine, user_id_holder))


# ─── Tests ───────────────────────────────────────────────────────────────────

def test_create_list_update_delete_round_trip():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="alice", tier="pro")
    holder = {"id": user_id}
    client = _client(engine, holder)

    # Empty list
    r = client.get("/workouts/templates")
    assert r.status_code == 200, r.text
    assert r.json() == [], "fresh user has no templates"

    # Create
    body = {"id": "tpl-1", "name": " Push Day ", "workout": _sample_workout()}
    r = client.post("/workouts/templates", json=body)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["id"] == "tpl-1"
    assert created["name"] == "Push Day", "name is trimmed"
    assert created["shareCode"] is None
    assert created["timesImported"] == 0

    # Repeat POST is idempotent (treated as update — flaky-network safe)
    r = client.post("/workouts/templates", json={**body, "name": "Renamed"})
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Renamed"

    # List shows one
    r = client.get("/workouts/templates")
    assert len(r.json()) == 1

    # Update via PUT
    r = client.put(
        "/workouts/templates/tpl-1",
        json={"id": "tpl-1", "name": "Push Day v2",
              "workout": _sample_workout("Push v2"), "notes": "tweaked"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Push Day v2"
    assert r.json()["workout"]["focus"] == "Push v2"
    assert r.json()["notes"] == "tweaked"

    # Delete
    r = client.delete("/workouts/templates/tpl-1")
    assert r.status_code == 204, r.text
    r = client.get("/workouts/templates")
    assert r.json() == []

    _ok("create/list/update/delete round-trip")


def test_free_tier_cap_enforced_on_create():
    from sqlmodel import Session
    from app.entitlements import FREE_WORKOUT_TEMPLATE_LIMIT
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="freebie", tier="free")
    client = _client(engine, {"id": user_id})

    for i in range(FREE_WORKOUT_TEMPLATE_LIMIT):
        r = client.post(
            "/workouts/templates",
            json={"id": f"t-{i}", "name": f"T {i}", "workout": _sample_workout()},
        )
        assert r.status_code == 201, f"#{i}: {r.text}"

    r = client.post(
        "/workouts/templates",
        json={"id": "t-overflow", "name": "Overflow", "workout": _sample_workout()},
    )
    assert r.status_code == 403, r.text
    assert "Pro" in r.json()["detail"]
    _ok(f"free-tier {FREE_WORKOUT_TEMPLATE_LIMIT}-template cap rejects overflow create")


def test_pro_tier_no_cap():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="pro", tier="pro")
    client = _client(engine, {"id": user_id})

    for i in range(7):
        r = client.post(
            "/workouts/templates",
            json={"id": f"p-{i}", "name": f"P{i}", "workout": _sample_workout()},
        )
        assert r.status_code == 201, f"#{i}: {r.text}"

    r = client.get("/workouts/templates")
    assert len(r.json()) == 7
    _ok("pro tier accepts more than the free template cap")


def test_share_code_generated_and_unique():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="sharer", tier="pro")
    client = _client(engine, {"id": user_id})

    codes: set[str] = set()
    for i in range(5):
        client.post(
            "/workouts/templates",
            json={"id": f"s-{i}", "name": f"S{i}", "workout": _sample_workout()},
        )
        r = client.post(f"/workouts/templates/s-{i}/share")
        assert r.status_code == 200, r.text
        code = r.json()["shareCode"]
        assert code and len(code) == 6, f"unexpected code: {code!r}"
        # Ambiguity-stripped alphabet — no 0/O, 1/I/L
        assert all(c in "23456789ABCDEFGHJKMNPQRSTUVWXYZ" for c in code), code
        codes.add(code)

    assert len(codes) == 5, "all 5 share codes must be unique"

    # Re-sharing the same template returns the SAME code (idempotent)
    r1 = client.post("/workouts/templates/s-0/share")
    r2 = client.post("/workouts/templates/s-0/share")
    assert r1.json()["shareCode"] == r2.json()["shareCode"]

    _ok("share codes are 6-char, unique, ambiguity-stripped, idempotent")


def test_imported_copy_records_owner_username():
    """Owner attribution survives revoke + owner rename via snapshot."""
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="alice42", tier="pro")
        recipient_id = _insert_user(s, username="bob", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)

    client.post("/workouts/templates", json={
        "id": "tpl-attr", "name": "Attr",
        "workout": _sample_workout(),
    })
    code = client.post("/workouts/templates/tpl-attr/share").json()["shareCode"]

    holder["id"] = recipient_id
    r = client.post(
        f"/workouts/templates/shared/{code}/import",
        json={"clientId": "imported-attr"},
    )
    assert r.status_code == 201, r.text
    assert r.json()["sourceOwnerUsername"] == "alice42"

    # Owner revokes — recipient still sees attribution.
    holder["id"] = owner_id
    client.delete("/workouts/templates/tpl-attr/share")
    holder["id"] = recipient_id
    listing = client.get("/workouts/templates").json()
    assert listing[0]["sourceOwnerUsername"] == "alice42", "attribution survives revoke"
    _ok("imported copy records sourceOwnerUsername; survives revoke")


def test_preview_and_import_by_code():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="owner", tier="pro")
        recipient_id = _insert_user(s, username="recipient", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)

    client.post(
        "/workouts/templates",
        json={"id": "pull-1", "name": "Pull Day",
              "workout": _sample_workout("Pull")},
    )
    code = client.post("/workouts/templates/pull-1/share").json()["shareCode"]

    # Switch to recipient
    holder["id"] = recipient_id

    # Preview before import
    r = client.get(f"/workouts/templates/shared/{code}")
    assert r.status_code == 200, r.text
    preview = r.json()
    assert preview["name"] == "Pull Day"
    assert preview["ownerUsername"] == "owner"
    assert preview["workout"]["focus"] == "Pull"

    # Import
    r = client.post(
        f"/workouts/templates/shared/{code}/import",
        json={"clientId": "imported-pull"},
    )
    assert r.status_code == 201, r.text
    imported = r.json()
    assert imported["id"] == "imported-pull"
    assert imported["name"] == "Pull Day"
    assert imported["sourceShareCode"] == code
    assert imported["shareCode"] is None, "imported copies start private"

    # Recipient now has it in their list
    r = client.get("/workouts/templates")
    assert len(r.json()) == 1
    assert r.json()[0]["id"] == "imported-pull"

    # Owner sees times_imported = 1
    holder["id"] = owner_id
    r = client.get("/workouts/templates")
    assert r.json()[0]["timesImported"] == 1

    _ok("preview by code + import copies template to recipient")


def test_import_is_idempotent_on_double_tap():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="o2", tier="pro")
        recipient_id = _insert_user(s, username="r2", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)

    client.post(
        "/workouts/templates",
        json={"id": "x", "name": "X", "workout": _sample_workout()},
    )
    code = client.post("/workouts/templates/x/share").json()["shareCode"]

    holder["id"] = recipient_id
    r1 = client.post(
        f"/workouts/templates/shared/{code}/import",
        json={"clientId": "first"},
    )
    r2 = client.post(
        f"/workouts/templates/shared/{code}/import",
        json={"clientId": "second-attempt"},
    )
    assert r1.status_code == 201
    assert r2.status_code == 201
    # Same recipient + same source code → returns the original copy, NOT
    # a new row with the second clientId.
    assert r2.json()["id"] == "first", "double-import should return first copy"

    r = client.get("/workouts/templates")
    assert len(r.json()) == 1, "no duplicate row created"

    holder["id"] = owner_id
    assert client.get("/workouts/templates").json()[0]["timesImported"] == 1

    _ok("double-tap import returns existing row, no duplicates")


def test_cannot_import_own_template():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="solo", tier="pro")
    client = _client(engine, {"id": user_id})

    client.post(
        "/workouts/templates",
        json={"id": "own", "name": "Own", "workout": _sample_workout()},
    )
    code = client.post("/workouts/templates/own/share").json()["shareCode"]

    r = client.post(
        f"/workouts/templates/shared/{code}/import",
        json={"clientId": "self-clone"},
    )
    assert r.status_code == 400, r.text
    assert "already own" in r.json()["detail"]
    _ok("self-import is blocked")


def test_import_blocked_when_recipient_at_cap():
    from sqlmodel import Session
    from app.entitlements import FREE_WORKOUT_TEMPLATE_LIMIT
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="ow", tier="pro")
        recipient_id = _insert_user(s, username="rc", tier="free")
    holder = {"id": owner_id}
    client = _client(engine, holder)

    client.post(
        "/workouts/templates",
        json={"id": "shared", "name": "Shared",
              "workout": _sample_workout()},
    )
    code = client.post("/workouts/templates/shared/share").json()["shareCode"]

    holder["id"] = recipient_id
    for i in range(FREE_WORKOUT_TEMPLATE_LIMIT):
        client.post(
            "/workouts/templates",
            json={"id": f"local-{i}", "name": f"Local {i}",
                  "workout": _sample_workout()},
        )

    r = client.post(
        f"/workouts/templates/shared/{code}/import",
        json={"clientId": "wont-fit"},
    )
    assert r.status_code == 403, r.text
    assert "limit" in r.json()["detail"].lower()
    _ok("import respects recipient's free-tier cap")


def test_revoke_share_code():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="revoker", tier="pro")
    client = _client(engine, {"id": user_id})

    client.post(
        "/workouts/templates",
        json={"id": "r-1", "name": "R1", "workout": _sample_workout()},
    )
    code = client.post("/workouts/templates/r-1/share").json()["shareCode"]

    # Lookup works
    assert client.get(f"/workouts/templates/shared/{code}").status_code == 200

    # Revoke
    r = client.delete("/workouts/templates/r-1/share")
    assert r.status_code == 204

    # Lookup fails
    assert client.get(f"/workouts/templates/shared/{code}").status_code == 404

    # Template itself is intact, just private again
    r = client.get("/workouts/templates")
    assert len(r.json()) == 1
    assert r.json()[0]["shareCode"] is None
    _ok("revoke clears share_code; template survives")


def test_unknown_code_returns_404():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        user_id = _insert_user(s, username="seeker", tier="pro")
    client = _client(engine, {"id": user_id})

    r = client.get("/workouts/templates/shared/NOPE99")
    assert r.status_code == 404, r.text
    _ok("unknown share code returns 404")


def test_delete_other_users_template_returns_404():
    """Templates are scoped by user_id — a different user's template should
    appear to not exist (404), not 403, to avoid leaking existence."""
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        a_id = _insert_user(s, username="aa", tier="pro")
        b_id = _insert_user(s, username="bb", tier="pro")
    holder = {"id": a_id}
    client = _client(engine, holder)
    client.post(
        "/workouts/templates",
        json={"id": "a-tpl", "name": "A", "workout": _sample_workout()},
    )
    holder["id"] = b_id
    r = client.delete("/workouts/templates/a-tpl")
    assert r.status_code == 404, r.text
    _ok("cross-user delete is 404 (no existence leak)")


# ─── Bundle (multi-template share) tests ─────────────────────────────────────


def _make_owner_with_two_templates(client) -> tuple[str, str]:
    """Helper — create two templates owned by the current user. Returns
    their client_ids in creation order."""
    client.post("/workouts/templates", json={
        "id": "tpl-a", "name": "Day A", "workout": _sample_workout("A"),
    })
    client.post("/workouts/templates", json={
        "id": "tpl-b", "name": "Day B", "workout": _sample_workout("B"),
    })
    return "tpl-a", "tpl-b"


def test_bundle_create_mints_8char_code_and_auto_shares_items():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="bundler", tier="pro")
    client = _client(engine, {"id": owner_id})
    a, b = _make_owner_with_two_templates(client)

    r = client.post("/workouts/templates/bundles", json={
        "name": " Push/Pull split ",
        "templateIds": [a, b],
    })
    assert r.status_code == 201, r.text
    body = r.json()
    code = body["bundleCode"]
    assert len(code) == 8, f"bundle code must be 8 chars, got {code!r}"
    assert all(c in "23456789ABCDEFGHJKMNPQRSTUVWXYZ" for c in code)
    assert body["name"] == "Push/Pull split"
    assert body["ownedByViewer"] is True
    assert len(body["items"]) == 2
    for item in body["items"]:
        assert item["available"] is True
        assert item["shareCode"] and len(item["shareCode"]) == 6, \
            "bundle creation auto-mints per-template share codes"
    _ok("bundle create mints 8-char code + auto-mints per-template codes")


def test_bundle_create_rejects_unowned_templates():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        a_id = _insert_user(s, username="aaa", tier="pro")
        _insert_user(s, username="bbb", tier="pro")
    client = _client(engine, {"id": a_id})
    a, _b = _make_owner_with_two_templates(client)

    r = client.post("/workouts/templates/bundles", json={
        "name": "mixed", "templateIds": [a, "not-mine"],
    })
    assert r.status_code == 400, r.text
    assert "not-mine" in r.json()["detail"]
    _ok("bundle create rejects unowned template ids")


def test_bundle_preview_and_full_import_round_trip():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="alpha", tier="pro")
        recipient_id = _insert_user(s, username="beta", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)
    a, b = _make_owner_with_two_templates(client)
    bundle = client.post("/workouts/templates/bundles", json={
        "name": "Two day split", "templateIds": [a, b],
    }).json()
    code = bundle["bundleCode"]

    holder["id"] = recipient_id
    preview = client.get(f"/workouts/templates/bundles/shared/{code}").json()
    assert preview["ownerUsername"] == "alpha"
    assert preview["ownedByViewer"] is False
    assert len(preview["items"]) == 2
    item_codes = [i["shareCode"] for i in preview["items"]]

    r = client.post(
        f"/workouts/templates/bundles/shared/{code}/import",
        json={"items": [
            {"shareCode": item_codes[0], "clientId": "imp-a"},
            {"shareCode": item_codes[1], "clientId": "imp-b"},
        ]},
    )
    assert r.status_code == 201, r.text
    result = r.json()
    assert len(result["imported"]) == 2
    assert result["skipped"] == []
    listing = client.get("/workouts/templates").json()
    assert {t["id"] for t in listing} == {"imp-a", "imp-b"}
    for t in listing:
        # Each imported row points back to the per-template share code
        # from the bundle, not the bundle code itself — keeps the single
        # and bundle import paths producing the same row shape.
        assert t["sourceShareCode"] in item_codes
        assert t["sourceOwnerUsername"] == "alpha"
    _ok("bundle preview + full import round trip")


def test_bundle_partial_import_only_takes_selected_items():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="ownerp", tier="pro")
        recipient_id = _insert_user(s, username="recvp", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)
    a, b = _make_owner_with_two_templates(client)
    bundle = client.post("/workouts/templates/bundles", json={
        "name": "split", "templateIds": [a, b],
    }).json()
    code = bundle["bundleCode"]
    selected_code = bundle["items"][0]["shareCode"]

    holder["id"] = recipient_id
    r = client.post(
        f"/workouts/templates/bundles/shared/{code}/import",
        json={"items": [{"shareCode": selected_code, "clientId": "imp-only"}]},
    )
    assert r.status_code == 201, r.text
    listing = client.get("/workouts/templates").json()
    assert len(listing) == 1, "only the selected item should be imported"
    assert listing[0]["id"] == "imp-only"
    _ok("bundle partial import respects user selection")


def test_bundle_import_rejects_codes_not_in_bundle():
    """Recipient can't repurpose the endpoint to import arbitrary share
    codes by smuggling them into the items list — codes must belong to
    the bundle being imported."""
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="strict", tier="pro")
        recipient_id = _insert_user(s, username="recv", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)
    a, _b = _make_owner_with_two_templates(client)
    bundle = client.post("/workouts/templates/bundles", json={
        "name": "x", "templateIds": [a],
    }).json()

    # Mint another share code that's NOT part of the bundle.
    client.post("/workouts/templates", json={
        "id": "tpl-out", "name": "Outside", "workout": _sample_workout(),
    })
    out_code = client.post("/workouts/templates/tpl-out/share").json()["shareCode"]

    holder["id"] = recipient_id
    r = client.post(
        f"/workouts/templates/bundles/shared/{bundle['bundleCode']}/import",
        json={"items": [{"shareCode": out_code, "clientId": "smuggled"}]},
    )
    assert r.status_code == 400, r.text
    assert out_code in r.json()["detail"]
    _ok("bundle import rejects codes not in the bundle")


def test_bundle_import_blocked_when_recipient_would_exceed_cap():
    """Pre-flight cap check: a free recipient near cap importing a 2-item
    bundle should be rejected up-front, not partway through. Makes the
    error recoverable without leaving the user in a half-imported state."""
    from sqlmodel import Session
    from app.entitlements import FREE_WORKOUT_TEMPLATE_LIMIT
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="o", tier="pro")
        recipient_id = _insert_user(s, username="r", tier="free")
    holder = {"id": owner_id}
    client = _client(engine, holder)
    a, b = _make_owner_with_two_templates(client)
    bundle = client.post("/workouts/templates/bundles", json={
        "name": "x", "templateIds": [a, b],
    }).json()
    code = bundle["bundleCode"]
    item_codes = [i["shareCode"] for i in bundle["items"]]

    # Recipient is one slot below the free-tier template cap.
    holder["id"] = recipient_id
    for i in range(FREE_WORKOUT_TEMPLATE_LIMIT - 1):
        client.post("/workouts/templates", json={
            "id": f"r-{i}", "name": f"R{i}", "workout": _sample_workout(),
        })

    r = client.post(
        f"/workouts/templates/bundles/shared/{code}/import",
        json={"items": [
            {"shareCode": item_codes[0], "clientId": "imp-x"},
            {"shareCode": item_codes[1], "clientId": "imp-y"},
        ]},
    )
    assert r.status_code == 403, r.text
    assert "limit" in r.json()["detail"].lower()
    # And nothing was imported — the listing still shows just the originals.
    listing = client.get("/workouts/templates").json()
    assert {t["id"] for t in listing} == {f"r-{i}" for i in range(FREE_WORKOUT_TEMPLATE_LIMIT - 1)}, \
        "cap rejection must be all-or-nothing"
    _ok("bundle import is rejected up-front when cap would be exceeded")


def test_bundle_owner_cannot_import_own_bundle():
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="self", tier="pro")
    client = _client(engine, {"id": owner_id})
    a, b = _make_owner_with_two_templates(client)
    bundle = client.post("/workouts/templates/bundles", json={
        "name": "self", "templateIds": [a, b],
    }).json()
    item_codes = [i["shareCode"] for i in bundle["items"]]

    r = client.post(
        f"/workouts/templates/bundles/shared/{bundle['bundleCode']}/import",
        json={"items": [{"shareCode": item_codes[0], "clientId": "self-imp"}]},
    )
    assert r.status_code == 400, r.text
    _ok("bundle owner cannot import their own bundle")


def test_bundle_preview_marks_revoked_items_as_unavailable():
    """If the owner revokes a per-template share code after creating the
    bundle, that item should appear as a tombstone (available:false) in
    the recipient's preview rather than vanishing or 500ing."""
    from sqlmodel import Session
    engine = _make_mem_engine()
    with Session(engine) as s:
        owner_id = _insert_user(s, username="rev", tier="pro")
        recipient_id = _insert_user(s, username="rcv", tier="pro")
    holder = {"id": owner_id}
    client = _client(engine, holder)
    a, b = _make_owner_with_two_templates(client)
    bundle = client.post("/workouts/templates/bundles", json={
        "name": "x", "templateIds": [a, b],
    }).json()
    code = bundle["bundleCode"]

    # Owner revokes one of the underlying template share codes.
    client.delete(f"/workouts/templates/{a}/share")

    holder["id"] = recipient_id
    preview = client.get(f"/workouts/templates/bundles/shared/{code}").json()
    available = [i for i in preview["items"] if i["available"]]
    unavailable = [i for i in preview["items"] if not i["available"]]
    assert len(available) == 1, "only the un-revoked item is available"
    assert len(unavailable) == 1
    assert unavailable[0]["name"] is None
    _ok("revoked bundle items surface as tombstones, not 500s")


cases = [
    test_create_list_update_delete_round_trip,
    test_free_tier_cap_enforced_on_create,
    test_pro_tier_no_cap,
    test_share_code_generated_and_unique,
    test_imported_copy_records_owner_username,
    test_preview_and_import_by_code,
    test_import_is_idempotent_on_double_tap,
    test_cannot_import_own_template,
    test_import_blocked_when_recipient_at_cap,
    test_revoke_share_code,
    test_unknown_code_returns_404,
    test_delete_other_users_template_returns_404,
    test_bundle_create_mints_8char_code_and_auto_shares_items,
    test_bundle_create_rejects_unowned_templates,
    test_bundle_preview_and_full_import_round_trip,
    test_bundle_partial_import_only_takes_selected_items,
    test_bundle_import_rejects_codes_not_in_bundle,
    test_bundle_import_blocked_when_recipient_would_exceed_cap,
    test_bundle_owner_cannot_import_own_bundle,
    test_bundle_preview_marks_revoked_items_as_unavailable,
]
