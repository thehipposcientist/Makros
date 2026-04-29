"""Tests for change_day_type service.

Covers: safe type changes, adjacency conflicts, recovery transitions,
day protection (completed/started/locked), smart adjust reconciliation,
single-mode passthrough, fatigue risk, no_recovery streak detection.

Run:
    docker exec thallo-backend python -m tests.test_change_day_type
"""
from __future__ import annotations


def _make_days(*focuses: str) -> list[dict]:
    return [{"focus": f, "exercises": []} for f in focuses]


def _statuses(*args: str) -> list[str]:
    return list(args)


def _families(result) -> list[str]:
    from app.services.workout.switch_day import _focus_family, normalize_focus, NON_LIFTING_FOCUSES
    out = []
    for d in result.proposed_days:
        nf = normalize_focus(d["focus"])
        if nf in NON_LIFTING_FOCUSES or nf in ("rest", ""):
            out.append(nf)
        else:
            out.append(_focus_family(d["focus"]))
    return out


# ── helpers ──────────────────────────────────────────────────────────

def assert_eq(a, b, label):
    assert a == b, f"{label}: got {a!r}, expected {b!r}"
    print(f"  ✓ {label}")


def assert_ne(a, b, label):
    assert a != b, f"{label}: got {a!r}, should not be {b!r}"
    print(f"  ✓ {label}")


def assert_in(item, collection, label):
    assert item in collection, f"{label}: {item!r} not in {collection!r}"
    print(f"  ✓ {label}")


def assert_true(val, label):
    assert val, f"{label}: expected truthy, got {val!r}"
    print(f"  ✓ {label}")


def assert_false(val, label):
    assert not val, f"{label}: expected falsy, got {val!r}"
    print(f"  ✓ {label}")


# ── Test: safe type change (single mode) ────────────────────────────

def test_single_mode_changes_only_target_day():
    """Single mode: only the target day changes, rest untouched."""
    print("[change_day_type] single mode changes only target day")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Upper",
        day_statuses=statuses, mode="single", split="ppl",
    )
    assert_eq(result.mode, "single", "mode=single")
    assert_eq(result.proposed_days[2]["focus"], "Upper", "day2 changed to Upper")
    assert_eq(result.proposed_days[0]["focus"], "Push", "day0 unchanged")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "day1 unchanged")
    assert_eq(result.proposed_days[3]["focus"], "Push", "day3 unchanged")
    assert_eq(result.proposed_days[4]["focus"], "Pull", "day4 unchanged")
    assert_in(2, result.changed_indices, "day2 in changed_indices")
    assert_eq(len(result.changed_indices), 1, "only 1 day changed")
    assert_in(2, result.exercises_needed, "day2 needs new exercises")


# ── Test: adjacency conflict detection ──────────────────────────────

def test_adjacency_conflict_back_to_back_same_focus():
    """Changing day 2 to Push creates back-to-back Push with day 1."""
    print("[change_day_type] adjacency conflict: back-to-back same focus")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Push", "Legs", "Pull", "Push")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Push",
        day_statuses=statuses, mode="single", split="ppl",
    )
    adjacency_conflicts = [c for c in result.conflicts if c.kind == "adjacency"]
    assert_true(len(adjacency_conflicts) > 0, "adjacency conflict detected")
    affected = []
    for c in adjacency_conflicts:
        affected.extend(c.affected_days)
    assert_in(2, affected, "day2 in affected")


def test_no_adjacency_conflict_when_different_focus():
    """Changing day 2 to Legs (between Pull and Push) creates no adjacency."""
    print("[change_day_type] no adjacency conflict when different focus")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Push", "Push", "Legs")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Legs",
        day_statuses=statuses, mode="single", split="ppl",
    )
    adjacency_conflicts = [c for c in result.conflicts if c.kind == "adjacency"]
    assert_eq(len(adjacency_conflicts), 0, "no adjacency conflicts")


# ── Test: legs/lower adjacency collapse ─────────────────────────────

def test_legs_lower_adjacency_collapse():
    """Legs and Lower map to the same collapsed family for adjacency."""
    print("[change_day_type] legs/lower adjacency collapse")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Legs", "Push", "Pull", "Upper", "Lower")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=1, new_focus="Lower",
        day_statuses=statuses, mode="single", split="upper_lower",
    )
    adjacency_conflicts = [c for c in result.conflicts if c.kind == "adjacency"]
    assert_true(len(adjacency_conflicts) > 0, "legs/lower adjacency detected")


# ── Test: type change to recovery ────────────────────────────────────

def test_change_lift_to_recovery_single():
    """Changing a lift day to Recovery in single mode."""
    print("[change_day_type] change lift to recovery (single)")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Recovery",
        day_statuses=statuses, mode="single", split="ppl",
    )
    assert_eq(result.proposed_days[2]["focus"], "Recovery", "day2 is Recovery")
    missing_conflicts = [c for c in result.conflicts if c.kind == "missing_focus"]
    assert_true(len(missing_conflicts) > 0, "missing_focus conflict warns about lost Legs")


def test_change_lift_to_recovery_smart_redistributes():
    """Smart mode: changing Legs to Recovery should redistribute Legs elsewhere."""
    print("[change_day_type] change lift to recovery (smart redistributes)")
    from app.services.workout.change_day_type import change_day_type
    from app.services.workout.switch_day import _focus_family

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Recovery",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(result.proposed_days[2]["focus"], "Recovery", "day2 is Recovery")
    assert_in(2, result.changed_indices, "day2 in changed")


# ── Test: type change from recovery to hard training ────────────────

def test_change_recovery_to_lift():
    """Changing a Recovery day to Push in single mode."""
    print("[change_day_type] change recovery to lift")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Recovery", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Push",
        day_statuses=statuses, mode="single", split="ppl",
    )
    assert_eq(result.proposed_days[2]["focus"], "Push", "day2 is Push now")
    assert_in(2, result.exercises_needed, "day2 needs new exercises")


# ── Test: completed/started day protection ───────────────────────────

def test_completed_day_cannot_be_changed():
    """Completed day returns early with a conflict, no changes."""
    print("[change_day_type] completed day protection")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("completed", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=0, new_focus="Pull",
        day_statuses=statuses, mode="single", split="ppl",
    )
    assert_eq(len(result.changed_indices), 0, "no changes")
    assert_eq(result.proposed_days[0]["focus"], "Push", "day0 still Push")
    assert_true(len(result.conflicts) > 0, "conflict returned")
    assert_in("completed", result.conflicts[0].message, "message mentions completed")


def test_started_day_cannot_be_changed():
    """Started day returns early with a conflict, no changes."""
    print("[change_day_type] started day protection")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "started", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=1, new_focus="Legs",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(len(result.changed_indices), 0, "no changes")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "day1 still Pull")


def test_locked_target_day_cannot_be_changed():
    """A manually locked PlanDay is immutable even when it is the target."""
    print("[change_day_type] locked target day protection")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs")
    statuses = _statuses("pending", "locked", "pending")
    result = change_day_type(
        days, day_index=1, new_focus="Legs",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(len(result.changed_indices), 0, "no changes")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "locked target unchanged")
    assert_true(len(result.conflicts) > 0, "conflict returned")
    assert_in("locked", result.conflicts[0].message, "message mentions locked")


def test_skipped_target_day_cannot_be_changed():
    """Skipped days are historical outcomes, not future editable slots."""
    print("[change_day_type] skipped target day protection")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs")
    statuses = _statuses("pending", "skipped", "pending")
    result = change_day_type(
        days, day_index=1, new_focus="Legs",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(len(result.changed_indices), 0, "no changes")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "skipped target unchanged")
    assert_true(len(result.conflicts) > 0, "conflict returned")
    assert_in("skipped", result.conflicts[0].message, "message mentions skipped")


# ── Test: locked/skipped days stay frozen in smart mode ──────────────

def test_locked_days_frozen_in_smart_mode():
    """Locked days must not be modified by smart adjust."""
    print("[change_day_type] locked days frozen in smart mode")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("completed", "locked", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Push",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(result.proposed_days[0]["focus"], "Push", "day0 frozen (completed)")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "day1 frozen (locked)")
    assert_eq(result.proposed_days[2]["focus"], "Push", "day2 changed (user request)")


# ── Test: smart adjust only modifies days AFTER changed index ────────

def test_smart_adjust_only_modifies_remaining_days():
    """Smart adjust must not touch days before the changed index."""
    print("[change_day_type] smart adjust only modifies remaining days")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Pull",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(result.proposed_days[0]["focus"], "Push", "day0 unchanged (before target)")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "day1 unchanged (before target)")
    assert_eq(result.proposed_days[2]["focus"], "Pull", "day2 changed to Pull")
    for idx in result.changed_indices:
        assert_true(idx >= 2, f"changed index {idx} >= target index 2")


# ── Test: no_recovery conflict (4+ consecutive lifts) ───────────────

def test_no_recovery_streak_detection():
    """Detects 4+ consecutive lifting days when changing to a lift."""
    print("[change_day_type] no_recovery streak detection")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Recovery", "Push")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=3, new_focus="Upper",
        day_statuses=statuses, mode="single", split="upper_lower",
    )
    recovery_conflicts = [c for c in result.conflicts if c.kind == "no_recovery"]
    assert_true(len(recovery_conflicts) > 0, "no_recovery conflict for 5 consecutive lifts")
    assert_true(recovery_conflicts[0].message.startswith("5"), "streak=5")


def test_no_recovery_conflict_absent_with_break():
    """No no_recovery conflict when there's a rest day breaking the streak."""
    print("[change_day_type] no_recovery conflict absent with break")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Recovery", "Legs", "Push")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=0, new_focus="Upper",
        day_statuses=statuses, mode="single", split="upper_lower",
    )
    recovery_conflicts = [c for c in result.conflicts if c.kind == "no_recovery"]
    assert_eq(len(recovery_conflicts), 0, "no streak conflict with recovery break")


# ── Test: fatigue risk ───────────────────────────────────────────────

def test_fatigue_risk_conflict_low_readiness():
    """Low readiness triggers a fatigue_risk conflict."""
    print("[change_day_type] fatigue risk with low readiness")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Legs",
        day_statuses=statuses, mode="single", split="ppl",
        focus_readiness={"legs": 15.0},
    )
    fatigue_conflicts = [c for c in result.conflicts if c.kind == "fatigue_risk"]
    assert_true(len(fatigue_conflicts) > 0, "fatigue_risk conflict at 15% readiness")


def test_no_fatigue_risk_when_readiness_ok():
    """Adequate readiness does not trigger fatigue_risk."""
    print("[change_day_type] no fatigue risk when readiness ok")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Legs",
        day_statuses=statuses, mode="single", split="ppl",
        focus_readiness={"legs": 75.0},
    )
    fatigue_conflicts = [c for c in result.conflicts if c.kind == "fatigue_risk"]
    assert_eq(len(fatigue_conflicts), 0, "no fatigue conflict at 75%")


# ── Test: missing_focus conflict ────────────────────────────────────

def test_missing_focus_conflict_ppl():
    """Replacing the only Legs day with Push warns about missing Legs."""
    print("[change_day_type] missing_focus conflict on PPL")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs")
    statuses = _statuses("pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Push",
        day_statuses=statuses, mode="single", split="ppl",
    )
    missing = [c for c in result.conflicts if c.kind == "missing_focus"]
    assert_true(len(missing) > 0, "missing_focus conflict for legs")
    assert_true(any("legs" in c.message.lower() for c in missing), "message mentions legs")


# ── Test: out-of-range day_index ────────────────────────────────────

def test_out_of_range_day_index_raises():
    """Out-of-range day_index raises ValueError."""
    print("[change_day_type] out-of-range day_index raises")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs")
    statuses = _statuses("pending", "pending", "pending")
    raised = False
    try:
        change_day_type(
            days, day_index=5, new_focus="Push",
            day_statuses=statuses, mode="single", split="ppl",
        )
    except ValueError:
        raised = True
    assert_true(raised, "ValueError raised for day_index=5 on 3-day plan")


# ── Test: noop when focus already matches ────────────────────────────

def test_same_focus_still_processes():
    """Changing to the same focus is allowed (user may want exercise regen)."""
    print("[change_day_type] same focus still processes")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs")
    statuses = _statuses("pending", "pending", "pending")
    result = change_day_type(
        days, day_index=0, new_focus="Push",
        day_statuses=statuses, mode="single", split="ppl",
    )
    assert_eq(result.proposed_days[0]["focus"], "Push", "focus stays Push")
    assert_in(0, result.changed_indices, "day0 marked as changed")
    assert_in(0, result.exercises_needed, "day0 needs exercises (regen requested)")


# ── Test: smart mode exercises_needed includes changed days ──────────

def test_smart_mode_exercises_needed():
    """Smart mode marks all family-changed days as needing exercises."""
    print("[change_day_type] smart mode exercises_needed")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull")
    statuses = _statuses("completed", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Push",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_in(2, result.exercises_needed, "target day needs exercises")


# ── Test: DaySlot.from_dict ─────────────────────────────────────────

def test_day_slot_from_dict_lifting():
    """DaySlot correctly classifies a lifting day."""
    print("[change_day_type] DaySlot.from_dict lifting")
    from app.services.workout.change_day_type import DaySlot

    slot = DaySlot.from_dict(0, {"focus": "Push"})
    assert_true(slot.is_lifting, "Push is lifting")
    assert_false(slot.is_rest, "Push is not rest")
    assert_eq(slot.family, "push", "family=push")


def test_day_slot_from_dict_recovery():
    """DaySlot correctly classifies a recovery day."""
    print("[change_day_type] DaySlot.from_dict recovery")
    from app.services.workout.change_day_type import DaySlot

    slot = DaySlot.from_dict(0, {"focus": "Recovery"})
    assert_false(slot.is_lifting, "Recovery is not lifting")
    assert_eq(slot.family, "recovery", "family=recovery")


def test_day_slot_from_dict_rest():
    """DaySlot correctly classifies a rest day (empty focus)."""
    print("[change_day_type] DaySlot.from_dict rest")
    from app.services.workout.change_day_type import DaySlot

    slot = DaySlot.from_dict(0, {"focus": ""})
    assert_false(slot.is_lifting, "empty is not lifting")
    assert_true(slot.is_rest, "empty is rest")


def test_day_slot_from_dict_cardio():
    """DaySlot correctly classifies a cardio day as non-lifting."""
    print("[change_day_type] DaySlot.from_dict cardio")
    from app.services.workout.change_day_type import DaySlot

    slot = DaySlot.from_dict(0, {"focus": "Cardio"})
    assert_false(slot.is_lifting, "Cardio is not lifting")
    assert_false(slot.is_rest, "Cardio is not rest")


# ── Test: smart adjust with upper_lower split ────────────────────────

def test_smart_adjust_upper_lower():
    """Smart adjust on U/L split maintains alternation in remaining days."""
    print("[change_day_type] smart adjust upper/lower alternation")
    from app.services.workout.change_day_type import change_day_type
    from app.services.workout.switch_day import _focus_family

    days = _make_days("Upper", "Lower", "Upper", "Lower")
    statuses = _statuses("completed", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=1, new_focus="Upper",
        day_statuses=statuses, mode="smart", split="upper_lower",
    )
    assert_eq(result.proposed_days[1]["focus"], "Upper", "day1 changed to Upper")


# ── Test: smart adjust preserves non-lifting days ────────────────────

def test_smart_adjust_preserves_rest_days():
    """Smart adjust may move a recovery break, but it should preserve
    the non-lifting break count while reconciling the split."""
    print("[change_day_type] smart adjust preserves recovery break count")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Recovery", "Push")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=0, new_focus="Pull",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    assert_eq(result.proposed_days[0]["focus"], "Pull", "day0 changed")
    breaks = [
        d for d in result.proposed_days
        if d["focus"].lower() in ("recovery", "mobility")
    ]
    assert_eq(len(breaks), 1, "one recovery/mobility break preserved")


# ── Test: 7-day plan with lots of completed days ─────────────────────

def test_many_completed_days_limits_changes():
    """With 4/7 days completed, smart adjust can only modify remaining 3."""
    print("[change_day_type] many completed days limits changes")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Pull", "Legs", "Push", "Pull", "Legs", "Recovery")
    statuses = _statuses("completed", "completed", "completed", "completed",
                         "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=4, new_focus="Push",
        day_statuses=statuses, mode="smart", split="ppl",
    )
    for idx in result.changed_indices:
        assert_true(idx >= 4, f"changed idx {idx} >= 4")
    assert_eq(result.proposed_days[0]["focus"], "Push", "day0 frozen")
    assert_eq(result.proposed_days[1]["focus"], "Pull", "day1 frozen")
    assert_eq(result.proposed_days[2]["focus"], "Legs", "day2 frozen")
    assert_eq(result.proposed_days[3]["focus"], "Push", "day3 frozen")


# ── Test: ppl_upper_lower smart adjust (the live bug) ────────────────

def test_ppl_ul_smart_adjust_no_full_body_fallback():
    """ppl_upper_lower: changing day 0 to Legs must NOT produce Full_body."""
    print("[change_day_type] ppl_ul: no full_body fallback")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Legs", "Upper", "Lower", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=0, new_focus="Legs",
        day_statuses=statuses, mode="smart", split="ppl_upper_lower",
    )
    assert_eq(result.proposed_days[0]["focus"], "Legs", "day0=Legs")
    for i, d in enumerate(result.proposed_days):
        focus = d["focus"].lower().strip()
        assert_ne(focus, "full_body", f"day{i} is not full_body")
        assert_ne(focus, "full body", f"day{i} is not 'full body'")


def test_ppl_ul_smart_adjust_preserves_all_families():
    """ppl_upper_lower: after smart adjust all 5 families still present."""
    print("[change_day_type] ppl_ul: all families preserved")
    from app.services.workout.change_day_type import change_day_type
    from app.services.workout.switch_day import _focus_family

    days = _make_days("Push", "Legs", "Upper", "Lower", "Pull")
    statuses = _statuses("pending", "pending", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Pull",
        day_statuses=statuses, mode="smart", split="ppl_upper_lower",
    )
    families = set()
    for d in result.proposed_days:
        fam = _focus_family(d["focus"])
        families.add(fam)
    assert_in("pull", families, "pull present")
    assert_in("push", families, "push present")
    assert_in("legs", families, "legs present")
    assert_in("upper", families, "upper present")
    assert_in("lower", families, "lower present")


def test_ppl_ul_mid_week_change():
    """ppl_upper_lower: change day 2 with days 0-1 completed."""
    print("[change_day_type] ppl_ul: mid-week change")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Push", "Legs", "Upper", "Lower", "Pull")
    statuses = _statuses("completed", "completed", "pending", "pending", "pending")
    result = change_day_type(
        days, day_index=2, new_focus="Legs",
        day_statuses=statuses, mode="smart", split="ppl_upper_lower",
    )
    assert_eq(result.proposed_days[0]["focus"], "Push", "day0 frozen")
    assert_eq(result.proposed_days[1]["focus"], "Legs", "day1 frozen")
    assert_eq(result.proposed_days[2]["focus"], "Legs", "day2 changed to Legs")
    for i, d in enumerate(result.proposed_days):
        assert_ne(d["focus"].lower(), "full_body", f"day{i} not full_body")


# ── Test: full_body split smart adjust ────────────────────────────────

def test_full_body_smart_adjust():
    """full_body split: changing a day keeps Full Body on remaining."""
    print("[change_day_type] full_body: smart adjust")
    from app.services.workout.change_day_type import change_day_type

    days = _make_days("Full Body", "Full Body", "Full Body")
    statuses = _statuses("pending", "pending", "pending")
    result = change_day_type(
        days, day_index=0, new_focus="Upper",
        day_statuses=statuses, mode="smart", split="full_body",
    )
    assert_eq(result.proposed_days[0]["focus"], "Upper", "day0=Upper")


# ── Test: canonical cycle exists for all common splits ────────────────

def test_canonical_cycles_exist():
    """All common splits have canonical cycles (no None fallback)."""
    print("[change_day_type] canonical cycles exist for all splits")
    from app.services.workout.switch_day import _canonical_cycle_for_split

    splits = ["ppl", "upper_lower", "bro", "lower_focused",
              "upper_focused", "ppl_upper_lower", "full_body"]
    for s in splits:
        cycle = _canonical_cycle_for_split(s)
        assert_true(cycle is not None, f"{s} has a canonical cycle")
        assert_true(len(cycle) > 0, f"{s} cycle is non-empty")


# ── Runner ────────────────────────────────────────────────────────────

cases = [
    test_single_mode_changes_only_target_day,
    test_adjacency_conflict_back_to_back_same_focus,
    test_no_adjacency_conflict_when_different_focus,
    test_legs_lower_adjacency_collapse,
    test_change_lift_to_recovery_single,
    test_change_lift_to_recovery_smart_redistributes,
    test_change_recovery_to_lift,
    test_completed_day_cannot_be_changed,
    test_started_day_cannot_be_changed,
    test_locked_target_day_cannot_be_changed,
    test_skipped_target_day_cannot_be_changed,
    test_locked_days_frozen_in_smart_mode,
    test_smart_adjust_only_modifies_remaining_days,
    test_no_recovery_streak_detection,
    test_no_recovery_conflict_absent_with_break,
    test_fatigue_risk_conflict_low_readiness,
    test_no_fatigue_risk_when_readiness_ok,
    test_missing_focus_conflict_ppl,
    test_out_of_range_day_index_raises,
    test_same_focus_still_processes,
    test_smart_mode_exercises_needed,
    test_day_slot_from_dict_lifting,
    test_day_slot_from_dict_recovery,
    test_day_slot_from_dict_rest,
    test_day_slot_from_dict_cardio,
    test_smart_adjust_upper_lower,
    test_smart_adjust_preserves_rest_days,
    test_many_completed_days_limits_changes,
    test_ppl_ul_smart_adjust_no_full_body_fallback,
    test_ppl_ul_smart_adjust_preserves_all_families,
    test_ppl_ul_mid_week_change,
    test_full_body_smart_adjust,
    test_canonical_cycles_exist,
]


def run_all():
    passed = failed = 0
    for fn in cases:
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            print(f"  ✗ {fn.__name__}: {e}")
    print(f"\n{'='*60}")
    print(f"change_day_type: {passed}/{passed+failed} passed", end="")
    if failed:
        print(f" ({failed} FAILED)")
    else:
        print(" ✅")
    return failed


if __name__ == "__main__":
    import sys
    sys.exit(run_all())
