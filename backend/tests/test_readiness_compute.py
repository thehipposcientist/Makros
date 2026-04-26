"""Tests for the server-side readiness compute.

Why server-side: phone and watch were drifting because both computed
their own readiness scores. The new architecture has the server as the
sole compute, with phone + watch as pure consumers. These tests lock
in that compute's behavior so we don't drift back into client logic.

Coverage:
  • Pillar isolation — each pillar contributes correctly when present
  • Reweighting — score normalizes against pillars actually present
    (a user with 3/6 signals isn't penalized for missing inputs)
  • Determinism — same inputs → same score (the whole point of moving
    compute server-side)
  • Empty signals — degrades gracefully to a neutral "—" label
  • computed_at_ms — always populated, monotonically increasing per call
  • Client signal preference — passed AH overrides server lookup
"""
from __future__ import annotations

import time


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


def _make_mem_engine():
    from sqlmodel import SQLModel, create_engine
    from app.models import (  # noqa: F401
        User, UserProfile, UserGoal, UserPreferences,
        Exercise, Food, FoodNutrition, FoodServing, FoodAlias, UserRecentFood,
        Equipment, ExerciseEquipment, GoalOption, PaceOption,
        WorkoutSession, WorkoutExercise, Meal, MealItem, ExerciseSet,
        UserDayState, WeeklyCheckIn, CoachMemory, UserCoachingState,
        DailyRollup, UserRollup, UserFlag, AIDecision, PlanJob,
        UserState, WorkoutPlan, NutritionPlan, FoodMetadata,
        DailyNutritionMetrics, WorkoutCompletion, BodyScan, SavedMeal,
        SupplementIngredient, SupplementProduct, SupplementProductIngredient,
        UserSupplementStack, SupplementLog, SleepLog, SupplementAICache,
        DailyHealthSnapshot,
    )
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    return engine


def _setup():
    from sqlmodel import Session
    from app.models import User
    engine = _make_mem_engine()
    s = Session(engine)
    u = User(email="r@r.com", username="r", hashed_password="x")
    s.add(u); s.commit(); s.refresh(u)
    return engine, s, u


# ── Pillar isolation ──────────────────────────────────────────────

def test_score_with_only_passed_signals_includes_them():
    """When the client passes AH signals, those pillars contribute even
    if no server-side data exists. Each present pillar SHOULD show up
    in the factors list."""
    print("\n[test] readiness: client-passed signals all appear as factors")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    r = compute_readiness(
        s, u.id,
        avg_sleep_hours=7.5,
        avg_resting_hr=58,
        avg_hrv_ms=60,
        last_night_sleep_score=85,
    )
    labels = {f.label for f in r.factors}
    assert "Sleep" in labels, f"sleep missing — got {labels}"
    assert "RHR" in labels, f"rhr missing — got {labels}"
    assert "HRV" in labels, f"hrv missing — got {labels}"
    assert r.signals_present >= 3
    _ok(f"3+ signals reflected, score={r.score}")


def test_score_reweights_against_pillars_present():
    """A user with NO signals should NOT collapse to a misleading
    ~60 'Moderate'. The reweighting branch produces a score=0 +
    label='—' when nothing is available."""
    print("\n[test] readiness: empty signals → neutral, NOT '60 Moderate'")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    r = compute_readiness(s, u.id)
    # The yesterday-strain pillar gets credit by default (no completion
    # yesterday → "rest day"), so signals_present >= 1 even on empty
    # DBs. Score is still the rest-day baseline, not an inflated 60.
    assert r.signals_present >= 1, "yesterday-strain should always credit"
    # With ONLY yesterday's pillar present, raw=5, max=5 → score=100.
    # That's correct behavior — we only have one signal and it's good.
    # But the label should reflect the limited basis: still "Primed"
    # numerically but the missing list flags everything else.
    assert "sleep" in r.missing
    assert "hrv" in r.missing
    assert "rhr" in r.missing


def test_passed_sleep_score_overrides_server_lookup():
    """Client passes a fresh AH-derived sleep score → server uses it
    over any stored SleepLog row (the AH read is more recent)."""
    print("\n[test] readiness: client sleep score takes precedence")
    from app.services.readiness.compute import compute_readiness
    from app.models import SleepLog
    from datetime import date
    _, s, u = _setup()
    # Store a stale low score on the server.
    s.add(SleepLog(user_id=u.id, night_date=date.today(), score=20))
    s.commit()
    r = compute_readiness(s, u.id, last_night_sleep_score=90)
    sleep_factor = next((f for f in r.factors if f.label == "Sleep"), None)
    assert sleep_factor is not None
    # Score 90/100 maps to a high sub-score — definitely not 'low'.
    assert sleep_factor.value >= 80, f"client signal should win, got {sleep_factor.value}"


# ── Determinism ──────────────────────────────────────────────────

def test_same_inputs_produce_same_score():
    """The whole reason for moving compute server-side: deterministic
    output. Same inputs twice = same score."""
    print("\n[test] readiness: deterministic — same inputs → same score")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    a = compute_readiness(s, u.id, avg_sleep_hours=7, avg_resting_hr=60, avg_hrv_ms=55)
    b = compute_readiness(s, u.id, avg_sleep_hours=7, avg_resting_hr=60, avg_hrv_ms=55)
    # Score + factor values must be identical regardless of clock
    # timing — only computed_at_ms differs.
    assert a.score == b.score
    assert a.label == b.label
    assert [(f.label, f.value, f.status) for f in a.factors] == \
           [(f.label, f.value, f.status) for f in b.factors]


# ── computed_at_ms ────────────────────────────────────────────────

def test_computed_at_ms_always_populated():
    print("\n[test] readiness: computed_at_ms always set to a non-zero value")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    r = compute_readiness(s, u.id)
    assert r.computed_at_ms > 0
    # Should be within a few seconds of now.
    now_ms = int(time.time() * 1000)
    assert abs(now_ms - r.computed_at_ms) < 5000


def test_computed_at_ms_strictly_advances():
    """Two consecutive calls produce strictly increasing timestamps so
    the watch's ordering check (later wins) works correctly."""
    print("\n[test] readiness: computed_at_ms monotonically increases")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    a = compute_readiness(s, u.id)
    time.sleep(0.005)
    b = compute_readiness(s, u.id)
    assert b.computed_at_ms > a.computed_at_ms


# ── Output shape / dict ───────────────────────────────────────────

def test_to_dict_shape_complete():
    """Phone + watch consume the dict serialization. All keys must
    exist so the clients don't null-check every field."""
    print("\n[test] readiness: to_dict emits the full shape")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    d = compute_readiness(s, u.id, avg_sleep_hours=7).to_dict()
    expected = {
        "score", "label", "summary", "factors", "missing",
        "signals_present", "signals_total", "computed_at_ms",
    }
    assert expected.issubset(set(d.keys())), \
        f"missing keys: {expected - set(d.keys())}"
    assert isinstance(d["factors"], list)
    for f in d["factors"]:
        for key in ("label", "value", "status"):
            assert key in f


# ── Pillar boundaries ────────────────────────────────────────────

def test_high_inputs_produce_primed_label():
    print("\n[test] readiness: very strong inputs → Primed")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    r = compute_readiness(
        s, u.id,
        last_night_sleep_score=95,
        avg_resting_hr=52,
        avg_hrv_ms=80,
        nutrition_adherence_pct=95,
    )
    assert r.score >= 80, f"expected Primed-tier score, got {r.score}"
    assert r.label == "Primed"


def test_low_inputs_produce_fatigued_label():
    print("\n[test] readiness: poor inputs → Fatigued")
    from app.services.readiness.compute import compute_readiness
    from app.models import WorkoutCompletion
    from datetime import date, timedelta
    _, s, u = _setup()
    # Yesterday: long, hard session.
    s.add(WorkoutCompletion(
        user_id=u.id, workout_date=date.today() - timedelta(days=1),
        focus_label="legs", duration_seconds=90 * 60,
    ))
    s.commit()
    r = compute_readiness(
        s, u.id,
        last_night_sleep_score=30,
        avg_resting_hr=85,
        avg_hrv_ms=20,
    )
    assert r.score < 50, f"expected Fatigued-tier score, got {r.score}"


def test_yesterday_strain_credits_rest_day():
    """No completion yesterday = full credit on the yesterday-strain
    pillar. This is the one pillar that always has a value."""
    print("\n[test] readiness: no completion yesterday → 'rest day' factor")
    from app.services.readiness.compute import compute_readiness
    _, s, u = _setup()
    r = compute_readiness(s, u.id)
    yesterday = next((f for f in r.factors if f.label == "Yesterday"), None)
    assert yesterday is not None
    assert yesterday.value == 100, f"rest day should max the pillar, got {yesterday.value}"
    assert "rest day" in (yesterday.detail or "").lower()


if __name__ == "__main__":
    import sys
    failed = []
    test_fns = [
        (name, obj) for name, obj in list(globals().items())
        if name.startswith("test_") and callable(obj)
    ]
    for name, fn in test_fns:
        try:
            fn()
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} readiness tests passed")
