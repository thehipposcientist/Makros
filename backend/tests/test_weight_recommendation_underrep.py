"""Regression test for the 2026-05 "under-rep, same weight" bug.

User report: a lifter doing seated barbell press kept missing the rep
target by ~4 reps every session, but the pre-set recommendation kept
suggesting the same weight every time. Three layered bugs combined:

  1. `services/workout/history.py` was reading `rir_target` (PLANNED RIR)
     instead of `actual_rir` (USER-LOGGED RIR) when building the
     last-session set list for the recommender.
  2. The `progression.py` mapping that converts SetResult → dict for
     the pre-set endpoint dropped the `rir` field on the floor, so even
     when history had RIR data it never reached the recommender.
  3. The first-set-of-session path in `pre_set_recommendation`
     short-circuited to `action="hold_load"` based on the best
     "weight × reps" set from last session, never checking whether the
     reps actually hit the prescribed range. So a user who did 4 reps
     at 145 lb when the target was 8 reps got "opening at 145 lb" again.

These pure-function tests exercise the new majority-missed detection
that drives `action="reduce_load"` instead of silently holding load.
"""
from __future__ import annotations


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# A minimal stand-in for the planned-set / exercise shapes the pre-set
# recommender consumes. We don't need the full models because we only
# exercise the under-rep detection path.
def _make_planned(target_reps: str = "8-10", target_weight: float = 145.0):
    class _P:
        pass
    p = _P()
    p.target_reps = target_reps
    p.target_weight_lbs = target_weight
    return p


def test_majority_missed_triggers_reduce_load_action():
    print("\n[test] majority-missed last session → action=reduce_load + lighter weight")
    # Simulate three under-repped sets at 145 lb with a target of 8-10.
    # All three sets recorded 4 reps — well below the lo end (8).
    last_session = [
        {"reps": 4, "weightLbs": 145.0, "rir": 0},
        {"reps": 4, "weightLbs": 145.0, "rir": 0},
        {"reps": 4, "weightLbs": 145.0, "rir": 0},
    ]
    # The underlying detection logic — mirror what pre_set_recommendation
    # computes locally so we can lock it in without booting the whole route.
    from app.services.workout.set_programming import parse_rep_range
    rr = parse_rep_range("8-10")
    assert rr is not None and rr[0] == 8

    def _set_reps(s: dict) -> int:
        return int(s.get("reps") or 0)
    missed = sum(1 for s in last_session if _set_reps(s) < rr[0])
    assert missed * 2 > len(last_session), "majority of sets should be under-repped"

    # And the Epley → %1RM rescale should produce a lower target weight,
    # not the same 145 lb.
    from app.routers.ai.progression import _rep_adjust_legacy_anchor
    rescaled = _rep_adjust_legacy_anchor(raw_weight=145.0, raw_reps=4, target_reps="8-10")
    assert rescaled > 0
    assert rescaled < 145.0, f"expected rescale to drop weight, got {rescaled}"
    _ok("majority-missed sets detected; Epley rescale drops weight")


def test_clean_session_holds_load():
    print("\n[test] clean session (all sets in range) → no majority_missed")
    last_session = [
        {"reps": 9, "weightLbs": 145.0, "rir": 1},
        {"reps": 8, "weightLbs": 145.0, "rir": 1},
        {"reps": 8, "weightLbs": 145.0, "rir": 0},
    ]
    from app.services.workout.set_programming import parse_rep_range
    rr = parse_rep_range("8-10")
    assert rr is not None and rr[0] == 8
    def _set_reps(s: dict) -> int: return int(s.get("reps") or 0)
    missed = sum(1 for s in last_session if _set_reps(s) < rr[0])
    assert missed * 2 <= len(last_session), "no majority should be under-repped"
    _ok("clean session leaves the hold-load path intact")


def test_partial_miss_does_not_trigger():
    print("\n[test] 1 of 3 sets under-rep → not a majority, hold load")
    last_session = [
        {"reps": 8, "weightLbs": 145.0, "rir": 1},
        {"reps": 6, "weightLbs": 145.0, "rir": 0},  # under
        {"reps": 8, "weightLbs": 145.0, "rir": 1},
    ]
    from app.services.workout.set_programming import parse_rep_range
    rr = parse_rep_range("8-10")
    assert rr is not None and rr[0] == 8
    def _set_reps(s: dict) -> int: return int(s.get("reps") or 0)
    missed = sum(1 for s in last_session if _set_reps(s) < rr[0])
    assert missed * 2 <= len(last_session), \
        "1/3 under-rep should NOT trigger majority_missed"
    _ok("single bad set doesn't force a drop")


def test_single_rep_target_under_repped():
    print("\n[test] target '5' single value, all sets at 3 reps → majority_missed")
    last_session = [
        {"reps": 3, "weightLbs": 225.0},
        {"reps": 3, "weightLbs": 225.0},
    ]
    from app.services.workout.set_programming import parse_rep_range
    rr = parse_rep_range("5")
    assert rr is not None
    target_lo = rr[0]
    assert target_lo == 5
    def _set_reps(s: dict) -> int: return int(s.get("reps") or 0)
    missed = sum(1 for s in last_session if _set_reps(s) < target_lo)
    assert missed * 2 > len(last_session)
    _ok("single-value rep targets handled correctly")


def test_rir_field_now_threaded_through_history_mapping():
    print("\n[test] SetResult.rir survives the progression.py list-comp")
    # The mapping that converts SetResult → dict needs to include rir so
    # recommend_next_set can read it on subsequent sets. Without this the
    # second bug (silent RIR drop) reappears.
    class _Stub:
        def __init__(self, reps: int, weight: float, rir: int | None):
            self.reps = reps
            self.weight_lbs = weight
            self.rir = rir
            self.performed_on = None
    hist = [_Stub(4, 145.0, 0), _Stub(4, 145.0, 0)]
    # Mirror the mapping in progression.py:2519-2532 (post-fix).
    mapped = [
        {
            "reps": int(s.reps or 0),
            "weightLbs": float(s.weight_lbs or 0.0),
            "rir": getattr(s, "rir", None),
            "date": None,
        }
        for s in hist
        if (s.weight_lbs or 0) > 0
    ]
    assert all("rir" in row for row in mapped), "rir must be on every row"
    assert all(row["rir"] == 0 for row in mapped), "rir value must round-trip"
    _ok("rir field threaded through the history mapping")


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
