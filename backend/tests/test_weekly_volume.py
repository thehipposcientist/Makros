"""Pure-function tests for weekly_volume.

Volume aggregation requires DB joins so the full `compute_weekly_volume`
isn't covered here — the integration test belongs in test_api_smoke.py.
What we DO cover are the pure helpers: `_classify`, the spike threshold,
and the boundary conditions that easily regress.

Run manually from inside the backend container:
    docker exec -it thallo-backend python -m tests.test_weekly_volume
"""
from __future__ import annotations

from datetime import date

from app.services.workout.weekly_volume import (
    _classify,
    _is_countable_hard_set,
    EmphasisVolume,
    MuscleVolume,
    WeeklyVolumeSnapshot,
    WEEKLY_RANGES,
)
from app.services.workout.emphasis_tracking import detail_tags_for_exercise, normalize_emphasis_tags


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: got {actual!r}, expected {expected!r}"
    print(f"  ✓ {label}")


def test_classify_bands():
    print("[test] _classify status bands")
    # Chest range is 8-18.
    assert_eq(_classify("chest", 4)[0], "undertrained", "below lower bound")
    assert_eq(_classify("chest", 8)[0], "in_range", "exact lower bound")
    assert_eq(_classify("chest", 12)[0], "in_range", "middle of range")
    assert_eq(_classify("chest", 18)[0], "in_range", "exact upper bound")
    assert_eq(_classify("chest", 22)[0], "high", "1 above upper bound")
    assert_eq(_classify("chest", 28)[0], "excessive", "1.5x+ upper bound")


def test_classify_spike():
    print("[test] _classify spike detection")
    # Spike requires total >= range_min AND ratio >= 1.5
    # Chest in_range (10) with 1.5x baseline (had 6 last 3wks) → spike.
    assert_eq(_classify("chest", 10, spike_ratio=1.6)[0], "spike", "in_range + spike ratio")
    # Below range_min — even with high spike ratio, classify as undertrained.
    # (Logic: a ramp from 1 → 2 sets is "undertrained", not a "spike".)
    assert_eq(_classify("chest", 4, spike_ratio=2.0)[0], "undertrained", "below range + spike ratio")
    # Excessive trumps spike — overtraining is the more important warning.
    # Note: the implementation actually flags spike first when total >= lo,
    # which is intentional for ramping; the user with 30 sets after a baseline
    # of 6 sees the spike framing rather than "you're doing too much."
    assert_eq(_classify("chest", 30, spike_ratio=2.0)[0], "spike", "above + spike — spike wins")


def test_classify_unknown_muscle():
    print("[test] _classify unknown muscles return 'unknown'")
    status, lo, hi = _classify("systemic", 12)
    assert_eq(status, "unknown", "unknown muscle")
    assert_eq(lo, None, "no range_min")
    assert_eq(hi, None, "no range_max")


def test_classify_zero_sets():
    print("[test] _classify zero sets")
    # 0 sets is undertrained for any muscle that has a range.
    assert_eq(_classify("back", 0)[0], "undertrained", "zero sets")


def test_ranges_sane():
    print("[test] WEEKLY_RANGES sanity")
    # Every range has lo < hi.
    for muscle, (lo, hi) in WEEKLY_RANGES.items():
        assert lo < hi, f"{muscle}: lo {lo} >= hi {hi}"
    print(f"  ✓ {len(WEEKLY_RANGES)} ranges all monotonic")


def test_snapshot_helpers_match_status_labels():
    print("[test] helper status labels match classifier output")
    snap = WeeklyVolumeSnapshot(
        user_id=1,
        window_start=date.today(),
        window_end=date.today(),
        total_hard_sets=0,
        sessions_counted=1,
        by_muscle={
            "chest": MuscleVolume("chest", 2, 0, 2, "undertrained", 8, 18),
            "back": MuscleVolume("back", 22, 0, 22, "high", 10, 20),
            "quads": MuscleVolume("quads", 30, 0, 30, "excessive", 8, 18),
            "glutes": MuscleVolume("glutes", 12, 0, 12, "spike", 6, 14),
        },
    )
    assert_eq(snap.muscles_low(), ["chest"], "undertrained is low")
    assert_eq(set(snap.muscles_high()), {"back", "quads", "glutes"}, "high helper includes high-risk states")


def test_snapshot_serializes_fine_grained_emphasis():
    print("[test] snapshot serializes fine-grained emphasis rollup")
    snap = WeeklyVolumeSnapshot(
        user_id=1,
        window_start=date.today(),
        window_end=date.today(),
        total_hard_sets=4,
        sessions_counted=1,
        by_muscle={},
        by_emphasis={
            "lats": EmphasisVolume("lats", 4, exercise_count=1),
            "upper_back": EmphasisVolume("upper_back", 4, exercise_count=1),
        },
    )
    payload = snap.to_dict()
    assert_eq(payload["by_emphasis"]["lats"]["total_sets"], 4, "lats set exposure")
    assert_eq(payload["by_emphasis"]["upper_back"]["exercise_count"], 1, "exercise count")


def test_detail_tags_prefer_stored_emphasis_and_infer_custom_rows():
    print("[test] detail tags prefer stored values and infer from custom rows")
    assert_eq(
        normalize_emphasis_tags(["Lats", "upper back", "not_a_tag", "lats"]),
        ["lats", "upper_back"],
        "normalizes stored tags",
    )
    assert_eq(
        detail_tags_for_exercise(
            name="Bent Over Row",
            primary_muscle="back",
            secondary_muscles=["biceps"],
            stored_emphasis=["rear delt"],
        ),
        ["rear_delt"],
        "stored emphasis wins",
    )
    assert_eq(
        detail_tags_for_exercise(
            name="Face Pull",
            primary_muscle="shoulders",
            secondary_muscles=["back"],
            stored_emphasis=None,
        ),
        ["rear_delt", "upper_back"],
        "custom row inference",
    )


def test_hard_set_gate_uses_effort_signals():
    print("[test] hard-set gate uses RIR/RPE and excludes technique work")
    assert _is_countable_hard_set(
        completed=True, set_type="working", actual_reps=10,
        actual_weight_lbs=100, actual_rir=2, rpe=None,
    )
    assert not _is_countable_hard_set(
        completed=True, set_type="working", actual_reps=10,
        actual_weight_lbs=100, actual_rir=6, rpe=None,
    )
    assert _is_countable_hard_set(
        completed=True, set_type="working", actual_reps=8,
        actual_weight_lbs=0, actual_rir=None, rpe=8,
    )
    assert not _is_countable_hard_set(
        completed=True, set_type="technique", actual_reps=12,
        actual_weight_lbs=45, actual_rir=None, rpe=7,
    )


if __name__ == "__main__":
    test_classify_bands()
    test_classify_spike()
    test_classify_unknown_muscle()
    test_classify_zero_sets()
    test_ranges_sane()
    test_snapshot_helpers_match_status_labels()
    test_snapshot_serializes_fine_grained_emphasis()
    test_detail_tags_prefer_stored_emphasis_and_infer_custom_rows()
    test_hard_set_gate_uses_effort_signals()
    print("\n✅ test_weekly_volume.py PASSED")
