"""Readiness focus/muscle surface + daily self-report integration.

The fatigue engine (activity_impact.py) already models delayed damage, PR/load
spikes, lower-body half-lives, and section-E soreness/joint-pain caps. These
tests cover the two integration points that surface that work to the client:

  1. compute_rolling_fatigue ingests a top-level daily self-report
     (recovery_context["readiness_feedback"]) so the check-in caps the right
     muscles' local readiness without touching unrelated muscles.
  2. compute_readiness (the readiness card) projects the snapshot onto the
     0-100 focus_readiness / muscle_readiness / top_fatigued / recommendations
     surface, so a user can be "generally ready" while "not ready for legs".

Key scenario: heavy lower-body PR session ~48h ago, still sore. Overall
readiness stays high (upper body + systemic recovered) while lower-body
readiness is materially lower and the app recommends avoiding heavy legs.

Run:
    docker exec thallo-backend python -m tests.test_readiness_focus_surface
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


_TODAY = date(2026, 5, 23)


def _heavy_pr_leg_completion(days_ago: int = 2) -> dict:
    """A brutal PR leg day: raw fatigue may exceed 1.0 (section A), multiple
    PRs in the session (section D)."""
    return {
        "workout_date": (_TODAY - timedelta(days=days_ago)).isoformat(),
        "focus_label": "legs",
        "duration_seconds": 4200,
        "activity_intensity": "hard",
        "activity_details": {"sessionRpe": 9.5, "pr_count": 3, "pr_kinds": ["e1rm", "weight", "volume"]},
        "resolved_muscle_fatigue": {"quads": 1.2, "glutes": 1.1, "hamstrings": 1.0, "systemic": 0.6},
    }


# ── Engine surface (pure function — no DB) ─────────────────────────

def test_heavy_pr_leg_day_overall_ready_legs_not():
    """The headline scenario: overall stays high, lower-body is much lower,
    soreness caps quads, and the app recommends avoiding heavy legs."""
    from app.services.workout.activity_impact import compute_rolling_fatigue
    completions = [_heavy_pr_leg_completion()]
    ctx = {"readiness_feedback": {"soreness": [{"body_part": "quads", "severity": 8}]}}
    snap = compute_rolling_fatigue(completions, today=_TODAY, recovery_context=ctx)

    overall = snap.readiness_score
    lower = round(snap.focus_readiness.get("lower", 1.0) * 100)
    push = round(snap.focus_readiness.get("push", 1.0) * 100)
    quads = round((1.0 - snap.muscle_fatigue.get_display("quads")) * 100)

    assert overall >= 65, f"overall should still read ready, got {overall}"
    assert push >= 85, f"upper body should be fresh, push={push}"
    assert lower < push, f"lower ({lower}) must be lower than push ({push})"
    assert lower < 60, f"heavy PR leg day should drop lower-body below 60, got {lower}"
    assert quads <= 50, f"reported quad soreness (8/10) should cap quads, got {quads}"
    rec_types = [r.get("type") for r in snap.recommendations]
    assert "avoid_heavy_lower" in rec_types, rec_types
    top = [m for m, _ in snap.top_fatigued]
    assert "quads" in top, top
    _ok("overall ready, lower-body limited, avoid-heavy-lower recommended")


def test_joint_pain_triggers_avoid_heavy_loading():
    """Joint pain is treated more cautiously than soreness: it triggers an
    avoid-heavy-loading recommendation even at moderate severity."""
    from app.services.workout.activity_impact import compute_rolling_fatigue
    completions = [{
        "workout_date": (_TODAY - timedelta(days=2)).isoformat(),
        "focus_label": "legs", "duration_seconds": 3600, "activity_intensity": "moderate",
        "resolved_muscle_fatigue": {"quads": 0.6, "glutes": 0.5, "hamstrings": 0.5},
    }]
    ctx = {"readiness_feedback": {"joint_pain": [{"body_part": "knees", "severity": 5}]}}
    snap = compute_rolling_fatigue(completions, today=_TODAY, recovery_context=ctx)
    rec_types = [r.get("type") for r in snap.recommendations]
    assert "avoid_heavy_loading" in rec_types, rec_types
    reason_types = [e.get("type") for e in snap.explanations]
    assert "joint_pain_reported" in reason_types, reason_types
    _ok("joint pain triggers avoid-heavy-loading recommendation")


def test_soreness_does_not_touch_unrelated_muscles():
    """A reported sore quad must not lower chest/biceps readiness."""
    from app.services.workout.activity_impact import compute_rolling_fatigue
    completions = [{
        "workout_date": (_TODAY - timedelta(days=2)).isoformat(),
        "focus_label": "legs", "duration_seconds": 3600, "activity_intensity": "moderate",
        "resolved_muscle_fatigue": {"quads": 0.6},
    }]
    ctx = {"readiness_feedback": {"soreness": [{"body_part": "quads", "severity": 8}]}}
    snap = compute_rolling_fatigue(completions, today=_TODAY, recovery_context=ctx)
    chest = round((1.0 - snap.muscle_fatigue.get_display("chest")) * 100)
    biceps = round((1.0 - snap.muscle_fatigue.get_display("biceps")) * 100)
    assert chest == 100 and biceps == 100, (chest, biceps)
    _ok("soreness only affects the reported area's muscles")


def test_missing_self_report_is_neutral():
    """No check-in → no soreness/joint reasons, no crash, same as before."""
    from app.services.workout.activity_impact import compute_rolling_fatigue
    completions = [_heavy_pr_leg_completion()]
    snap_none = compute_rolling_fatigue(completions, today=_TODAY, recovery_context=None)
    snap_empty = compute_rolling_fatigue(completions, today=_TODAY, recovery_context={})
    for snap in (snap_none, snap_empty):
        reason_types = [e.get("type") for e in snap.explanations]
        assert "soreness_reported" not in reason_types, reason_types
        assert "joint_pain_reported" not in reason_types, reason_types
    assert snap_none.readiness_score == snap_empty.readiness_score
    _ok("missing self-report defaults to neutral behavior")


def test_raw_fatigue_exceeds_one_but_display_is_bounded():
    """Section A: internal raw fatigue can exceed 1.0 to keep extreme sessions
    distinguishable, while displayed readiness stays within 0-100."""
    from app.services.workout.activity_impact import compute_rolling_fatigue, squash_fatigue
    assert squash_fatigue(3.0) < 1.0 and squash_fatigue(3.0) > squash_fatigue(1.0)
    completions = [{
        "workout_date": _TODAY.isoformat(), "focus_label": "legs",
        "duration_seconds": 5400, "activity_intensity": "hard",
        "activity_details": {"pr_count": 4},
        "resolved_muscle_fatigue": {"quads": 2.5, "glutes": 2.0},
    }]
    snap = compute_rolling_fatigue(completions, today=_TODAY)
    raw = snap.raw_muscle_fatigue.get("quads", 0.0)
    disp_readiness = round((1.0 - snap.muscle_fatigue.get_display("quads")) * 100)
    assert raw > 1.0, f"raw quad fatigue should exceed 1.0, got {raw}"
    assert 0 <= disp_readiness <= 100, disp_readiness
    _ok("raw fatigue >1.0 internally; display readiness stays bounded 0-100")


# ── compute.py integration (DB-backed) ─────────────────────────────

def test_compute_readiness_surfaces_focus_and_recommendation():
    """End-to-end: a heavy leg completion + a quad soreness check-in flows
    through compute_readiness so the card exposes per-focus / per-muscle
    readiness and the avoid-heavy-lower recommendation."""
    from sqlmodel import Session
    from tests._seed_helpers import make_seed_test_engine
    from app.models import User, WorkoutCompletion, UserDayState
    from app.services.readiness.compute import compute_readiness

    engine = make_seed_test_engine()
    today = date.today()
    with Session(engine) as db:
        u = User(email="readiness-surface@example.com", username="rsurface", hashed_password="x")
        db.add(u); db.commit(); db.refresh(u)

        db.add(WorkoutCompletion(
            user_id=u.id,
            workout_date=today - timedelta(days=2),
            focus_label="legs",
            duration_seconds=4200,
            activity_intensity="hard",
            activity_details={"sessionRpe": 9.5, "pr_count": 3, "pr_kinds": ["e1rm", "weight", "volume"]},
            resolved_muscle_fatigue={"quads": 1.2, "glutes": 1.1, "hamstrings": 1.0, "systemic": 0.6},
        ))
        # Daily check-in: quads sore 8/10.
        db.add(UserDayState(user_id=u.id, day_key=today, soreness_body_part="quads", soreness_severity_0_10=8))
        db.commit()

        # Plan a push day + pass a sleep score so the card publishes (sleep +
        # fatigue = 2 health pillars) and the headline reflects upper-body work.
        result = compute_readiness(
            db, u.id, planned_focus="push", last_night_sleep_score=88, use_cache=False,
        )
        d = result.to_dict()

        for key in ("focus_readiness", "muscle_readiness", "top_fatigued", "recommendations", "explanations"):
            assert key in d, f"missing surface key {key}"
        assert d["score"] >= 65, f"overall should publish ready, got {d['score']}"
        lower = d["focus_readiness"].get("lower", 100)
        push = d["focus_readiness"].get("push", 100)
        assert lower < push, (lower, push)
        assert lower < 60, lower
        assert d["muscle_readiness"]["quads"] <= 50, d["muscle_readiness"]["quads"]
        assert all(0 <= v <= 100 for v in d["muscle_readiness"].values())
        assert "avoid_heavy_lower" in [r.get("type") for r in d["recommendations"]]
        assert any(e.get("type") == "overall_ready_local_not_ready" for e in d["explanations"])
    _ok("compute_readiness surfaces focus/muscle readiness + recommendation end-to-end")


def test_compute_readiness_no_completions_is_safe():
    """No workout history → empty surface, no crash, score still computes from
    other pillars (or gates cleanly)."""
    from sqlmodel import Session
    from tests._seed_helpers import make_seed_test_engine
    from app.models import User
    from app.services.readiness.compute import compute_readiness

    engine = make_seed_test_engine()
    with Session(engine) as db:
        u = User(email="readiness-empty@example.com", username="rempty", hashed_password="x")
        db.add(u); db.commit(); db.refresh(u)
        result = compute_readiness(db, u.id, last_night_sleep_score=80, use_cache=False)
        d = result.to_dict()
        assert d["focus_readiness"] == {} and d["muscle_readiness"] == {}
        assert d["recommendations"] == []
    _ok("no completions → empty surface, no crash")


ALL_TESTS = [v for k, v in list(globals().items()) if k.startswith("test_")]


def run_all():
    passed = failed = 0
    for fn in ALL_TESTS:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL {fn.__name__}: {e}")
    total = passed + failed
    print(f"test_readiness_focus_surface: {passed}/{total} passed" + (f" ({failed} FAILED)" if failed else ""))
    return failed == 0


if __name__ == "__main__":
    import sys
    sys.exit(0 if run_all() else 1)
