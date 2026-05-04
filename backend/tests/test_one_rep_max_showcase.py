"""Tests for `_build_showcase_lifts` — the rolling-e1RM overlay used by
the `/ai/strength/one-rep-max` endpoint.

The Progress screen shows the same 1RM number in three places: chart,
showcase tile, and PR cards. They were drifting because the showcase
used single-set Epley while the chart + PR cards used rolling-e1RM.
The overlay function is what makes them agree — these tests pin its
behavior so the drift can't silently come back.

Coverage:
  - Profile with no logged sets → falls back to Epley.
  - Profile + 3 logged sets → uses rolling.
  - Profile + 1 set (below rolling threshold) → falls back to Epley.
  - Slug ordering preserved, matches `_ONE_RM_SHOWCASE_SLUGS` order.
  - Profiles without entries get dropped silently.
  - Profiles with 0 estimated_1rm_lbs get dropped (defends against
    upstream bugs putting noise in the showcase).
  - Missing slugs in showcase tuple are silently skipped.
  - last_performed_on serializes to ISO date string or None.

Run manually:
    docker exec -it thallo-backend python -m tests.test_one_rep_max_showcase
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


@dataclass
class _FakeProfile:
    """Standalone stand-in for ExercisePerformance — avoids the import
    cycle through `app.services.workout.performance` so this test stays
    a pure-function unit test."""
    slug: str
    name: str
    session_count: int
    recent_top_weight_lbs: float
    recent_top_reps: int
    estimated_1rm_lbs: float
    recent_volume_load: float
    last_performed_on: Optional[date]
    confidence: float


def _make_profile(*, slug: str, name: str, top_w: float, top_r: int,
                   sessions: int = 4, last_days_ago: int = 2) -> _FakeProfile:
    epley = round(top_w * (1 + top_r / 30.0), 1)
    return _FakeProfile(
        slug=slug,
        name=name,
        session_count=sessions,
        recent_top_weight_lbs=top_w,
        recent_top_reps=top_r,
        estimated_1rm_lbs=epley,
        recent_volume_load=top_w * top_r * sessions,
        last_performed_on=date.today() - timedelta(days=last_days_ago),
        confidence=round(min(sessions / 6, 1.0), 2),
    )


def _make_usable_sets(weight: float, reps: int, rir: float, *, count: int = 5):
    from app.services.workout.rolling_e1rm import UsableSet
    return [
        UsableSet(
            completed_at=date.today() - timedelta(days=i),
            actual_weight_lbs=weight,
            actual_reps=reps,
            actual_rir=rir,
            target_rir=2.0,
            set_type="working",
        ) for i in range(count)
    ]


# ── Tests ───────────────────────────────────────────────────────────


def test_no_sets_falls_back_to_epley() -> None:
    print("\n[test] empty sets_by_name → Epley value passes through unchanged")
    from app.routers.ai.progression import _build_showcase_lifts

    profiles = {
        "barbell_bench_press": _make_profile(
            slug="barbell_bench_press", name="Barbell Bench Press",
            top_w=205.0, top_r=5,
        ),
    }
    out = _build_showcase_lifts(profiles, sets_by_name={},
                                 showcase_slugs=("barbell_bench_press",))
    assert len(out) == 1
    # Epley(205, 5) = 205 * (1 + 5/30) = 239.17 → rounded to 239.2
    expected = profiles["barbell_bench_press"].estimated_1rm_lbs
    assert out[0]["oneRepMaxLbs"] == round(expected, 1), (
        f"expected Epley fallback {expected}, got {out[0]['oneRepMaxLbs']}"
    )
    _ok("Epley fallback works when no logged sets exist")


def test_with_logged_sets_uses_rolling() -> None:
    print("\n[test] sets_by_name match → rolling-e1RM overrides Epley")
    from app.routers.ai.progression import _build_showcase_lifts

    profiles = {
        "barbell_bench_press": _make_profile(
            slug="barbell_bench_press", name="Barbell Bench Press",
            top_w=205.0, top_r=5,  # Epley = 239.2
        ),
    }
    # 5 sets at 185 × 8 with RIR=2 → reps_to_failure=10 → e1rm ~246.7
    sets_by_name = {
        "barbell bench press": _make_usable_sets(185.0, 8, 2.0, count=5),
    }
    out = _build_showcase_lifts(profiles, sets_by_name=sets_by_name,
                                 showcase_slugs=("barbell_bench_press",))
    assert len(out) == 1
    # Should be ~246.7 from rolling, NOT 239.2 from Epley.
    val = out[0]["oneRepMaxLbs"]
    assert 245 < val < 248, f"expected rolling ~246.7, got {val}"
    epley = profiles["barbell_bench_press"].estimated_1rm_lbs
    assert val != epley, f"rolling should override Epley {epley}, got {val}"
    _ok(f"rolling overlay picked: {val} (Epley was {epley})")


def test_too_few_sets_falls_back_to_epley() -> None:
    print("\n[test] <3 logged sets → rolling returns None → Epley fallback")
    from app.routers.ai.progression import _build_showcase_lifts

    profiles = {
        "barbell_deadlift": _make_profile(
            slug="barbell_deadlift", name="Barbell Deadlift",
            top_w=315.0, top_r=5,
        ),
    }
    # Only 2 sets — below rolling-e1RM minimum.
    sets_by_name = {
        "barbell deadlift": _make_usable_sets(315.0, 5, 2.0, count=2),
    }
    out = _build_showcase_lifts(profiles, sets_by_name=sets_by_name,
                                 showcase_slugs=("barbell_deadlift",))
    epley = profiles["barbell_deadlift"].estimated_1rm_lbs
    assert out[0]["oneRepMaxLbs"] == round(epley, 1), (
        f"expected Epley fallback {epley}, got {out[0]['oneRepMaxLbs']}"
    )
    _ok("2 sets → rolling None → Epley used")


def test_slug_ordering_preserved() -> None:
    print("\n[test] showcase tuple ordering is preserved in output")
    from app.routers.ai.progression import _build_showcase_lifts

    profiles = {
        "barbell_back_squat":  _make_profile(slug="barbell_back_squat",  name="Back Squat",  top_w=275.0, top_r=5),
        "barbell_bench_press": _make_profile(slug="barbell_bench_press", name="Bench Press", top_w=205.0, top_r=5),
        "barbell_deadlift":    _make_profile(slug="barbell_deadlift",    name="Deadlift",    top_w=315.0, top_r=5),
    }
    showcase = ("barbell_deadlift", "barbell_back_squat", "barbell_bench_press")
    out = _build_showcase_lifts(profiles, sets_by_name={}, showcase_slugs=showcase)
    slugs = [r["slug"] for r in out]
    assert slugs == list(showcase), f"order broken: {slugs} vs {showcase}"
    _ok("output order matches input slug tuple, not profile dict order")


def test_missing_profile_slug_dropped_silently() -> None:
    print("\n[test] showcase slugs without a matching profile are dropped (no crash)")
    from app.routers.ai.progression import _build_showcase_lifts

    profiles = {
        "barbell_bench_press": _make_profile(
            slug="barbell_bench_press", name="Bench Press", top_w=205.0, top_r=5,
        ),
    }
    showcase = ("barbell_bench_press", "barbell_deadlift", "overhead_press")
    out = _build_showcase_lifts(profiles, sets_by_name={}, showcase_slugs=showcase)
    assert len(out) == 1, f"expected 1 lift, got {len(out)}"
    assert out[0]["slug"] == "barbell_bench_press"
    _ok("missing slugs dropped silently — no KeyError, no None entries")


def test_zero_estimated_1rm_dropped() -> None:
    print("\n[test] profile with estimated_1rm_lbs <= 0 is dropped (data hygiene)")
    from app.routers.ai.progression import _build_showcase_lifts

    p = _make_profile(slug="overhead_press", name="OHP", top_w=0.0, top_r=0)
    # _epley_1rm of (0,0) = 0 — make sure that doesn't render as a "0 lb 1RM" tile.
    profiles = {"overhead_press": p}
    out = _build_showcase_lifts(profiles, sets_by_name={},
                                 showcase_slugs=("overhead_press",))
    assert out == [], f"expected drop on 0 epley, got {out}"
    _ok("0-Epley profile silently dropped from showcase")


def test_last_performed_on_serialized() -> None:
    print("\n[test] last_performed_on serializes to ISO date string")
    from app.routers.ai.progression import _build_showcase_lifts

    p = _make_profile(slug="barbell_bench_press", name="Bench Press",
                      top_w=205.0, top_r=5, last_days_ago=7)
    out = _build_showcase_lifts({"barbell_bench_press": p}, sets_by_name={},
                                 showcase_slugs=("barbell_bench_press",))
    iso = out[0]["lastPerformedOn"]
    assert iso == (date.today() - timedelta(days=7)).isoformat(), iso
    _ok(f"lastPerformedOn = {iso}")


def test_last_performed_on_none() -> None:
    print("\n[test] last_performed_on=None passes through as null")
    from app.routers.ai.progression import _build_showcase_lifts

    p = _FakeProfile(
        slug="barbell_bench_press", name="Bench Press",
        session_count=1, recent_top_weight_lbs=205.0, recent_top_reps=5,
        estimated_1rm_lbs=239.2, recent_volume_load=205.0 * 5,
        last_performed_on=None, confidence=0.17,
    )
    out = _build_showcase_lifts({"barbell_bench_press": p}, sets_by_name={},
                                 showcase_slugs=("barbell_bench_press",))
    assert out[0]["lastPerformedOn"] is None, out[0]
    _ok("None pass-through preserved (caller might filter on it)")


def test_name_lookup_case_insensitive() -> None:
    print("\n[test] sets_by_name lookup matches profile.name case-insensitively")
    from app.routers.ai.progression import _build_showcase_lifts

    p = _make_profile(slug="barbell_bench_press", name="Barbell Bench Press",
                      top_w=205.0, top_r=5)
    # Key uses lowercase + trim to match what the route stores.
    sets_by_name = {
        "barbell bench press": _make_usable_sets(195.0, 8, 2.0, count=4),
    }
    out = _build_showcase_lifts({"barbell_bench_press": p},
                                 sets_by_name=sets_by_name,
                                 showcase_slugs=("barbell_bench_press",))
    val = out[0]["oneRepMaxLbs"]
    epley = p.estimated_1rm_lbs
    # Rolling kicked in → must differ from raw Epley.
    assert val != epley, f"rolling should override; val={val} epley={epley}"
    _ok("case-insensitive name lookup hit; rolling overlaid Epley")


def test_top_weight_and_reps_from_profile() -> None:
    print("\n[test] topWeightLbs + topReps come from profile, NOT from rolling sets")
    from app.routers.ai.progression import _build_showcase_lifts

    p = _make_profile(slug="barbell_bench_press", name="Bench Press",
                      top_w=205.0, top_r=5)
    # Rolling sets at 185 — but topWeightLbs should still be 205 (from profile).
    sets_by_name = {
        "bench press": _make_usable_sets(185.0, 8, 2.0, count=5),
    }
    out = _build_showcase_lifts({"barbell_bench_press": p},
                                 sets_by_name=sets_by_name,
                                 showcase_slugs=("barbell_bench_press",))
    assert out[0]["topWeightLbs"] == 205.0, out[0]
    assert out[0]["topReps"] == 5, out[0]
    _ok("topWeightLbs + topReps unaffected by rolling overlay")


cases = [
    test_no_sets_falls_back_to_epley,
    test_with_logged_sets_uses_rolling,
    test_too_few_sets_falls_back_to_epley,
    test_slug_ordering_preserved,
    test_missing_profile_slug_dropped_silently,
    test_zero_estimated_1rm_dropped,
    test_last_performed_on_serialized,
    test_last_performed_on_none,
    test_name_lookup_case_insensitive,
    test_top_weight_and_reps_from_profile,
]


if __name__ == "__main__":
    import traceback
    failures = 0
    for case in cases:
        try:
            case()
        except AssertionError as e:
            print(f"  ✗ FAIL [{case.__name__}]: {e}")
            failures += 1
        except Exception as e:
            traceback.print_exc()
            print(f"  ✗ ERROR [{case.__name__}] ({type(e).__name__}): {e}")
            failures += 1
    if failures:
        raise SystemExit(1)
    print(f"\n  All {len(cases)} tests passed.")
