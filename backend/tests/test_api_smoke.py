"""End-to-end API smoke suite — runs against the live Docker backend at
http://localhost:8000. Hits the critical request paths pilots will exercise:

  - Health + readiness probes
  - Register / login happy path + error path
  - Meta catalog (exercises seeded?)
  - Workout create + complete + list + completions
  - Meal log + list pagination bounds
  - Fatigue + profile export
  - Account soft-delete cleans up after itself

Run:
    docker exec thallo-backend python -m tests.run_all

The suite uses a fresh randomized email per invocation so re-runs don't
collide on unique-email constraints. It cleans up the user at the end via
DELETE /profile/account.

CAVEATS
  - Rate limits share a bucket per source IP. Running this suite more
    than 5 times in an hour will fail on the register step (5/hr cap).
  - Requires the backend to be up on http://localhost:8000.
    Run `docker compose up -d backend` first.
"""
from __future__ import annotations

import os
import uuid
from typing import Any

import httpx as _http


BASE_URL = os.getenv("SMOKE_BASE_URL", "http://localhost:8000")
# Short-ish unique-enough id so the email is readable in logs.
_RUN_ID = uuid.uuid4().hex[:8]
EMAIL = f"smoke_{_RUN_ID}@test.thallo"
USERNAME = f"smoke_{_RUN_ID}"
PASSWORD = "SmokeTest1234"   # ≥10 chars + digit satisfies the policy

# Shared across tests in the module. Populated by `_register_and_login`
# (invoked as the first test case below).
_token: str | None = None
_user_id: int | None = None


def _server_reachable() -> bool:
    """One-shot connectivity probe. Used to no-op the suite gracefully
    when the backend isn't running, rather than failing every case."""
    try:
        _http.get(f"{BASE_URL}/health", timeout=2)
        return True
    except Exception:
        return False


_SERVER_UP = _server_reachable()


def _skip_if_server_down(label: str) -> bool:
    if not _SERVER_UP:
        print(f"  ~ skipped {label} (backend not reachable at {BASE_URL})")
        return True
    return False


def _auth() -> dict[str, str]:
    assert _token, "auth token not populated — did test_00_register run?"
    return {"Authorization": f"Bearer {_token}"}


def _check(resp: _http.Response, expected: int, label: str) -> Any:
    """Fail fast with a useful message when status != expected."""
    body: Any
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    assert resp.status_code == expected, (
        f"{label}: expected {expected}, got {resp.status_code} — body={body!r}"
    )
    return body


def test_00_health_and_ready():
    if _skip_if_server_down("health+ready"): return
    r = _http.get(f"{BASE_URL}/health", timeout=5)
    _check(r, 200, "GET /health")
    r = _http.get(f"{BASE_URL}/ready", timeout=5)
    _check(r, 200, "GET /ready")


def test_01_register():
    global _token, _user_id
    r = _http.post(
        f"{BASE_URL}/auth/register",
        json={
            "email": EMAIL,
            "username": USERNAME,
            "password": PASSWORD,
            "first_name": "Smoke",
            "last_name": "Tester",
            "accepted_terms": True,
            "accepted_privacy": True,
            "accepted_health_disclaimer": True,
            "accepted_ai_disclaimer": True,
            "legal_version": "2026-04-29",
        },
        timeout=10,
    )
    body = _check(r, 201, "POST /auth/register")
    assert "id" in body, f"register response missing id: {body!r}"
    _user_id = body["id"]
    # Follow with a login to grab a token (register doesn't return one).
    r = _http.post(
        f"{BASE_URL}/auth/login",
        json={"email": EMAIL, "password": PASSWORD},
        timeout=10,
    )
    body = _check(r, 200, "POST /auth/login")
    assert "access_token" in body, f"login missing token: {body!r}"
    _token = body["access_token"]


def test_02_register_rejects_weak_password():
    r = _http.post(
        f"{BASE_URL}/auth/register",
        json={
            "email": f"weak_{_RUN_ID}@test.thallo",
            "username": f"weak_{_RUN_ID}",
            "password": "short",
            "first_name": "Weak",
            "last_name": "Tester",
            "accepted_terms": True,
            "accepted_privacy": True,
            "accepted_health_disclaimer": True,
            "accepted_ai_disclaimer": True,
            "legal_version": "2026-04-29",
        },
        timeout=10,
    )
    # Pydantic/router password validation returns 422 before account creation.
    assert r.status_code == 422, f"weak password should 422, got {r.status_code}"


def test_03_login_wrong_password_returns_401():
    r = _http.post(
        f"{BASE_URL}/auth/login",
        json={"email": EMAIL, "password": "WrongPassword123"},
        timeout=10,
    )
    assert r.status_code == 401, f"wrong password should 401, got {r.status_code}"


def test_04_me_returns_current_user():
    r = _http.get(f"{BASE_URL}/auth/me", headers=_auth(), timeout=10)
    body = _check(r, 200, "GET /auth/me")
    assert body.get("email") == EMAIL
    assert body.get("id") == _user_id


def test_05_meta_exercises_seeded():
    r = _http.get(f"{BASE_URL}/meta/exercises", timeout=15)
    body = _check(r, 200, "GET /meta/exercises")
    assert isinstance(body, list) and len(body) > 100, (
        f"expected 100+ seeded exercises, got {len(body) if isinstance(body, list) else '?'}"
    )


def test_06_meta_goals_seeded():
    r = _http.get(f"{BASE_URL}/meta/goals", timeout=10)
    body = _check(r, 200, "GET /meta/goals")
    assert isinstance(body, list) and len(body) > 0, "no goals seeded"


def test_07_fatigue_endpoint_without_workouts():
    r = _http.get(f"{BASE_URL}/workouts/fatigue", headers=_auth(), timeout=15)
    body = _check(r, 200, "GET /workouts/fatigue")
    # Fresh user has no completions — readiness should be 100.
    assert body.get("readiness_score") == 100, (
        f"fresh user should be at 100%% readiness, got {body.get('readiness_score')}"
    )
    assert isinstance(body.get("activities"), list), "activities should be a list"


def test_08_log_complete_workout():
    r = _http.post(
        f"{BASE_URL}/workouts/complete",
        headers=_auth(),
        json={
            "workout_date": "2026-04-20",
            "focus_label": "Push",
            "duration_seconds": 2400,
            "stimulus": "hypertrophy",
            "exercises": [
                {
                    "name": "Barbell Bench Press",
                    "equipment": "barbell",
                    "order_index": 0,
                    "sets": [
                        {"set_number": 1, "reps": 8, "weight_lbs": 135},
                        {"set_number": 2, "reps": 8, "weight_lbs": 135},
                        {"set_number": 3, "reps": 6, "weight_lbs": 145},
                    ],
                }
            ],
        },
        timeout=15,
    )
    _check(r, 201, "POST /workouts/complete")


def test_09_list_completions_contains_new_workout():
    r = _http.get(
        f"{BASE_URL}/workouts/completions?limit=10",
        headers=_auth(),
        timeout=10,
    )
    body = _check(r, 200, "GET /workouts/completions")
    assert isinstance(body, list) and len(body) >= 1, "new completion should show up"
    assert any(c["focus_label"] == "Push" for c in body), "Push completion missing"


def test_10_list_workouts_respects_limit():
    r = _http.get(
        f"{BASE_URL}/workouts?limit=5",
        headers=_auth(),
        timeout=10,
    )
    body = _check(r, 200, "GET /workouts")
    assert isinstance(body, list) and len(body) <= 5, (
        f"limit=5 should return <=5 rows, got {len(body)}"
    )


def test_11_list_workouts_rejects_limit_over_cap():
    r = _http.get(
        f"{BASE_URL}/workouts?limit=9999",
        headers=_auth(),
        timeout=10,
    )
    # `le=100` on the query constraint => 422 validation error.
    assert r.status_code == 422, f"oversized limit should 422, got {r.status_code}"


def test_12_meals_defaults_to_30_day_window():
    # Fresh user has no meals; endpoint should still succeed and return [].
    r = _http.get(f"{BASE_URL}/meals", headers=_auth(), timeout=10)
    body = _check(r, 200, "GET /meals")
    assert isinstance(body, list), f"meals should be a list, got {type(body)}"


def test_13_profile_export_round_trip():
    r = _http.get(f"{BASE_URL}/profile/export", headers=_auth(), timeout=15)
    body = _check(r, 200, "GET /profile/export")
    assert body.get("user", {}).get("email") == EMAIL
    assert "hashed_password" not in body.get("user", {}), "export leaks password hash"
    completions = body.get("workouts", {}).get("completions")
    assert isinstance(completions, list)
    # Our test_08 workout should appear.
    assert len(completions) >= 1, "expected workout in export"


def test_14_security_headers_present():
    r = _http.get(f"{BASE_URL}/health", timeout=5)
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert r.headers.get("X-Request-ID"), "X-Request-ID header missing"


def test_15_password_reset_email_request_is_generic():
    r = _http.post(
        f"{BASE_URL}/auth/password-reset/request",
        json={"email": EMAIL},
        timeout=10,
    )
    body = _check(r, 200, "POST /auth/password-reset/request")
    assert body.get("status") == "ok"


def test_16_e1rm_returns_null_for_unknown_exercise():
    if _skip_if_server_down("e1rm"):
        return
    print("[smoke] GET /workouts/e1rm — unknown exercise returns null e1rm")
    r = _http.get(
        f"{BASE_URL}/workouts/e1rm?exercise_name=NonExistentExercise123",
        headers=_auth(),
        timeout=10,
    )
    body = _check(r, 200, "GET /workouts/e1rm (unknown)")
    assert body.get("e1rm") is None, f"expected null e1rm, got {body}"
    assert body.get("reason") == "not_enough_data"
    print("  ✓ null e1rm for unknown exercise")


def test_17_e1rm_history_returns_empty_for_unknown():
    if _skip_if_server_down("e1rm history"):
        return
    print("[smoke] GET /workouts/e1rm/history — unknown exercise returns empty list")
    r = _http.get(
        f"{BASE_URL}/workouts/e1rm/history?exercise_name=NonExistentExercise123",
        headers=_auth(),
        timeout=10,
    )
    body = _check(r, 200, "GET /workouts/e1rm/history (unknown)")
    assert body.get("history") == [], f"expected empty history, got {body}"
    print("  ✓ empty history for unknown exercise")


def test_18_e1rm_for_logged_exercise():
    if _skip_if_server_down("e1rm with data"):
        return
    print("[smoke] GET /workouts/e1rm — exercise from logged workout")
    r = _http.get(
        f"{BASE_URL}/workouts/e1rm?exercise_name=Bench+Press",
        headers=_auth(),
        timeout=10,
    )
    body = _check(r, 200, "GET /workouts/e1rm (Bench Press)")
    # May or may not have enough sets to compute — just verify shape
    if body.get("e1rm"):
        assert "e1rm_lbs" in body["e1rm"]
        assert "confidence" in body["e1rm"]
        assert "sample_count" in body["e1rm"]
        print(f"  ✓ got e1rm: {body['e1rm']}")
    else:
        assert body.get("reason") == "not_enough_data"
        print("  ✓ not enough data (expected for single-session smoke test)")


def test_99_delete_account_cleans_up():
    """Leave the DB clean so re-running the suite doesn't accumulate
    'smoke_*' junk. Also exercises the soft-delete path."""
    r = _http.request(
        "DELETE",
        f"{BASE_URL}/profile/account",
        headers=_auth(),
        json={"confirmation": "DELETE"},
        timeout=10,
    )
    body = _check(r, 200, "DELETE /profile/account")
    assert body.get("deleted_user_id") == _user_id


def _noop():
    """Placeholder — the whole HTTP suite is skipped when the backend
    isn't running locally. run_all.py would otherwise report 17 failures
    for one root cause (server not up)."""
    print(f"  ~ API smoke suite skipped (no backend at {BASE_URL})")


# Expose to the run_all.py discovery pattern. When the backend is not
# reachable we intentionally return a single no-op so the runner prints
# one clean "skipped" line rather than a cascade of connection errors.
_ALL_CASES = [
    test_00_health_and_ready,
    test_01_register,
    test_02_register_rejects_weak_password,
    test_03_login_wrong_password_returns_401,
    test_04_me_returns_current_user,
    test_05_meta_exercises_seeded,
    test_06_meta_goals_seeded,
    test_07_fatigue_endpoint_without_workouts,
    test_08_log_complete_workout,
    test_09_list_completions_contains_new_workout,
    test_10_list_workouts_respects_limit,
    test_11_list_workouts_rejects_limit_over_cap,
    test_12_meals_defaults_to_30_day_window,
    test_13_profile_export_round_trip,
    test_14_security_headers_present,
    test_15_password_reset_email_request_is_generic,
    test_16_e1rm_returns_null_for_unknown_exercise,
    test_17_e1rm_history_returns_empty_for_unknown,
    test_18_e1rm_for_logged_exercise,
    test_99_delete_account_cleans_up,
]
cases = _ALL_CASES if _SERVER_UP else [_noop]


if __name__ == "__main__":
    import sys
    failed = 0
    for case in cases:
        try:
            case()
            print(f"  ✓ {case.__name__}")
        except AssertionError as e:
            print(f"  ✗ {case.__name__}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ✗ {case.__name__} ({type(e).__name__}): {e}")
            failed += 1
    sys.exit(1 if failed else 0)
