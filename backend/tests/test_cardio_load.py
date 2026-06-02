"""Unit tests for cardio load (Edwards' TRIMP) + cardio progression sub-pillar.

Pure functions only — no DB, no AI, no network. Covers:

  * `compute_cardio_load` Edwards' TRIMP math + edge cases (null, NaN,
    short list, negative input)
  * `cardio_load_from_hr_summary` accepts both `zoneMinutes` and
    `zone_minutes` keys; rejects non-dict inputs
  * `estimate_cardio_zone_minutes` → `compute_cardio_load` end-to-end:
    manual cardio with no wearable still produces a usable load number
  * `_score_cardio_progression` returns None when either window lacks
    signal (no penalty for new users) and scales smoothly from declining
    to trending up
  * Cardio pillar (`_score_cardio`) folds the progression sub-pillar
    into its weighted blend without breaking existing behavior
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Edwards' TRIMP basics ──────────────────────────────────────────────────

def test_compute_cardio_load_edwards_weights():
    print("\n[test] compute_cardio_load: Z1×1 + Z2×2 + Z3×3 + Z4×4 + Z5×5")
    from app.services.workout.activity_energy import compute_cardio_load
    # 10 minutes in every zone → 10 + 20 + 30 + 40 + 50 = 150.
    assert compute_cardio_load([10, 10, 10, 10, 10]) == 150.0
    # All Z2 → only zone-2 weight contributes.
    assert compute_cardio_load([0, 30, 0, 0, 0]) == 60.0
    # All Z5 → load dominated by high intensity.
    assert compute_cardio_load([0, 0, 0, 0, 12]) == 60.0
    _ok("Edwards' TRIMP weights apply correctly per zone")


def test_compute_cardio_load_zero_vs_unknown():
    print("\n[test] compute_cardio_load: explicit 0 ≠ unknown None")
    from app.services.workout.activity_energy import compute_cardio_load
    # All zeros means session existed with no aerobic stimulus — score 0.
    assert compute_cardio_load([0, 0, 0, 0, 0]) == 0.0
    # None input means no signal — score None (no fabrication).
    assert compute_cardio_load(None) is None
    _ok("explicit zero stays 0; unknown stays None")


def test_compute_cardio_load_bad_input():
    print("\n[test] compute_cardio_load: bad input returns None, not crashes")
    from app.services.workout.activity_energy import compute_cardio_load
    assert compute_cardio_load([1, 2, 3]) is None       # too short
    assert compute_cardio_load([1, 2, 3, 4, "x"]) is None  # non-numeric
    assert compute_cardio_load([1, 2, 3, 4, -1]) is None   # negative
    nan = float("nan")
    assert compute_cardio_load([1, 2, 3, 4, nan]) is None
    _ok("bad input rejected cleanly without exceptions")


def test_cardio_load_from_hr_summary_aliases():
    print("\n[test] cardio_load_from_hr_summary: accepts zoneMinutes + zone_minutes")
    from app.services.workout.activity_energy import cardio_load_from_hr_summary
    # 5×1 + 20×2 + 10×3 + 5×4 + 0×5 = 5 + 40 + 30 + 20 + 0 = 95
    # Wearable shape — camelCase.
    assert cardio_load_from_hr_summary({"zoneMinutes": [5, 20, 10, 5, 0]}) == 95.0
    # Backend/import shape — snake_case alias.
    assert cardio_load_from_hr_summary({"zone_minutes": [5, 20, 10, 5, 0]}) == 95.0
    # Missing keys → None.
    assert cardio_load_from_hr_summary({"avgBpm": 140}) is None
    assert cardio_load_from_hr_summary(None) is None
    assert cardio_load_from_hr_summary("not a dict") is None
    _ok("hr_summary helper handles both key spellings + bad input")


def test_estimate_zones_round_trip_to_load():
    print("\n[test] estimate_cardio_zone_minutes → compute_cardio_load: manual cardio scores")
    from app.services.workout.activity_energy import (
        estimate_cardio_zone_minutes, compute_cardio_load,
    )
    # Manually logged 45-min steady ride with no wearable → still gets a load number.
    zones = estimate_cardio_zone_minutes(duration_seconds=45 * 60, cardio_style="steady")
    assert zones is not None
    load = compute_cardio_load(zones)
    assert load is not None and load > 50  # any real session should produce > 50 TRIMP
    # A 30-min HIIT should be HIGHER load than a 30-min recovery walk.
    hiit = compute_cardio_load(
        estimate_cardio_zone_minutes(duration_seconds=30 * 60, cardio_style="intervals")
    )
    recovery = compute_cardio_load(
        estimate_cardio_zone_minutes(duration_seconds=30 * 60, cardio_style="recovery")
    )
    assert hiit is not None and recovery is not None
    assert hiit > recovery, f"intervals ({hiit}) should outweigh recovery ({recovery})"
    _ok("manual cardio synthesizes a real, intensity-aware TRIMP")


# ─── Cardio progression sub-pillar ─────────────────────────────────────────

def test_progression_none_when_no_baseline():
    print("\n[test] _score_cardio_progression: None when prior window has no signal")
    from app.services.workout.fitness_score import _score_cardio_progression
    recent = [{"cardio_load": 100}, {"cardio_load": 80}, {"cardio_load": 60}]
    # No prior at all → None (skip, no penalty).
    assert _score_cardio_progression(recent, None) is None
    # Prior present but no usable load → None.
    assert _score_cardio_progression(recent, [{"cardio_load": None}, {"cardio_load": 0}]) is None
    _ok("no penalty when baseline missing")


def test_progression_none_when_recent_too_thin():
    print("\n[test] _score_cardio_progression: requires ≥2 sessions on each side")
    from app.services.workout.fitness_score import _score_cardio_progression
    # Recent only 1 session — not enough to compare honestly.
    assert _score_cardio_progression(
        [{"cardio_load": 200}], [{"cardio_load": 80}, {"cardio_load": 100}],
    ) is None
    _ok("single-session windows return None")


def test_progression_steady_baseline_scores_middle():
    print("\n[test] _score_cardio_progression: flat load → 'maintaining' band")
    from app.services.workout.fitness_score import _score_cardio_progression
    recent = [{"cardio_load": 90}, {"cardio_load": 95}, {"cardio_load": 100}]
    prior = [{"cardio_load": 90}, {"cardio_load": 95}, {"cardio_load": 100}]
    score = _score_cardio_progression(recent, prior)
    assert score is not None
    # Exactly ratio = 1.00 should hit the 65 anchor.
    assert 60.0 <= score <= 70.0, f"expected ~65, got {score}"
    _ok("ratio≈1.00 anchors near 65 (maintaining)")


def test_progression_trending_up_caps_at_100():
    print("\n[test] _score_cardio_progression: ratio ≥1.20 → 100")
    from app.services.workout.fitness_score import _score_cardio_progression
    recent = [{"cardio_load": 200}, {"cardio_load": 220}, {"cardio_load": 240}]
    prior = [{"cardio_load": 80}, {"cardio_load": 90}, {"cardio_load": 100}]
    score = _score_cardio_progression(recent, prior)
    assert score == 100.0
    _ok("strong upward trend pegs to 100")


def test_progression_trending_down_floor_at_20():
    print("\n[test] _score_cardio_progression: ratio ≤0.50 → 20")
    from app.services.workout.fitness_score import _score_cardio_progression
    recent = [{"cardio_load": 30}, {"cardio_load": 25}, {"cardio_load": 20}]
    prior = [{"cardio_load": 200}, {"cardio_load": 220}, {"cardio_load": 240}]
    score = _score_cardio_progression(recent, prior)
    assert score == 20.0
    _ok("steep drop floors at 20 (not 0 — still credit for showing up)")


# ─── Cardio pillar integration ─────────────────────────────────────────────

def test_cardio_pillar_uses_progression_signal():
    print("\n[test] _score_cardio: progression sub-pillar folds into blend")
    from app.services.workout.fitness_score import _score_cardio
    # Same recent activity, but DIFFERENT prior-window baselines.
    recent = [
        {"focus": "Zone 2 ride", "duration_seconds": 60 * 60, "activity_category": "cardio",
         "cardio_style": "steady",
         "hr_summary": {"zoneMinutes": [5, 35, 15, 5, 0]}, "cardio_load": 145.0},
        {"focus": "Easy run", "duration_seconds": 45 * 60, "activity_category": "cardio",
         "cardio_style": "easy",
         "hr_summary": {"zoneMinutes": [10, 30, 5, 0, 0]}, "cardio_load": 85.0},
    ]
    # Trending up: recent load >> prior load.
    prior_low = [{"cardio_load": 50}, {"cardio_load": 40}]
    # Trending down: recent load << prior load.
    prior_high = [{"cardio_load": 300}, {"cardio_load": 320}]
    # No-baseline: progression skipped.
    no_prior = None

    up = _score_cardio(recent, prior_window_completions=prior_low)
    down = _score_cardio(recent, prior_window_completions=prior_high)
    none_p = _score_cardio(recent, prior_window_completions=no_prior)

    # Up should beat the no-baseline case; down should be worse than no-baseline.
    assert up.score > none_p.score, f"trending-up ({up.score}) should beat baseline ({none_p.score})"
    assert down.score < none_p.score, f"trending-down ({down.score}) should be worse than baseline ({none_p.score})"
    # Reasons should mention the trend when present.
    assert "load trending up" in up.reason
    assert "load trending down" in down.reason
    _ok("progression nudges cardio pillar up/down; baseline-less = neutral")


def test_cardio_pillar_no_regression_without_progression_input():
    print("\n[test] _score_cardio: defaults unchanged when prior_window_completions is None")
    from app.services.workout.fitness_score import _score_cardio
    # Pre-2026-06 callers don't pass prior_window_completions — the
    # signature default (None) must keep producing the same shape.
    recent = [
        {"focus": "Zone 2 ride", "duration_seconds": 50 * 60, "activity_category": "cardio",
         "cardio_style": "steady",
         "hr_summary": {"zoneMinutes": [5, 30, 10, 5, 0]}, "cardio_load": 120.0},
    ]
    result = _score_cardio(recent)
    assert result.name == "Cardio"
    assert 0.0 <= result.score <= 100.0
    assert result.data_quality in {"full", "partial", "missing"}
    _ok("default-arg path unchanged for legacy callers")


if __name__ == "__main__":
    cases = [v for k, v in list(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for case in cases:
        try:
            case()
        except Exception as e:
            failures += 1
            print(f"  ✗ {case.__name__}: {e}")
            import traceback
            traceback.print_exc()
    print()
    if failures == 0:
        print(f"✓ All {len(cases)} tests passed.")
    else:
        print(f"✗ {failures}/{len(cases)} test(s) failed.")
    import sys
    sys.exit(1 if failures else 0)
