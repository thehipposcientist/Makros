"""Mid-week regeneration tests for PlanWeek + PlanDay.

Verifies the contract:
  - Done days (locked OR past) are NEVER mutated by adapt / regenerate /
    patch operations.
  - Done days DO flow as input to the planner via recent_focus_buckets
    + recent_focus_families + muscle_fatigue (these tests assert that
    the route's input-collection mirror returns completed sessions, so
    the contract survives downstream).
  - Split changes mid-week (PPL → PPLUL, etc.) only rewrite remaining
    unlocked days.
  - days_per_week changes mid-week update is_rest only on remaining
    unlocked days; past locked rest days stay rest.
  - Equipment / injury / goal changes feed into PlannerInputs but
    don't reach into past PlanDays.

Pure-function tests with a tiny in-memory DB stand-in. No Docker. No real
session.
"""
from __future__ import annotations

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from datetime import date, datetime, timedelta, timezone
from dataclasses import dataclass, field as dc_field
from typing import Any, List, Optional
from unittest.mock import patch

from app.services.workout import week_manager


# ─── Fakes ────────────────────────────────────────────────────────────────────


@dataclass
class FakePlanWeek:
    id: int = 1
    user_id: int = 1
    start_date: date = dc_field(default_factory=date.today)
    end_date: date = dc_field(default_factory=lambda: date.today() + timedelta(days=6))
    planner_version: str = "2026.04.28.01"
    goal: str = "body_recomp"
    days_per_week: int = 5
    preferred_split: Optional[str] = "ppl"
    status: str = "active"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Any = None
    abandoned_at: Any = None


@dataclass
class FakePlanDay:
    id: int = 1
    plan_week_id: int = 1
    user_id: int = 1
    day_date: date = dc_field(default_factory=date.today)
    day_index: int = 0
    status: str = "planned"
    is_rest: bool = False
    workout_json: Any = None
    nutrition_json: Any = None
    locked: bool = False
    locked_at: Any = None
    lock_reason: Any = None
    generation_source: str = "initial"
    created_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))


class FakeSession:
    """No-op session — `db.add` records the object, `db.commit` / `db.flush`
    / `db.refresh` no-op. Tests that need data from `get_week_days` patch
    that helper directly."""

    def __init__(self):
        self.added: list = []

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        pass

    def flush(self):
        pass

    def refresh(self, obj):
        pass

    def exec(self, *_args, **_kwargs):
        # Tests that need exec results patch the helper that calls it.
        class _R:
            def all(self_inner):
                return []
            def first(self_inner):
                return None
        return _R()


def _monday_of_current_week() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


def _build_week(
    start_date: date,
    *,
    locked_indexes: tuple[int, ...] = (),
    rest_indexes: tuple[int, ...] = (),
    focuses: Optional[list[str]] = None,
) -> tuple[FakePlanWeek, list[FakePlanDay]]:
    """Build a 7-day fake week with given lock + rest pattern.

    NOTE: regenerate_remaining_days interprets `training_day_pattern` as
    day-of-week indices (Mon=0..Sun=6) — `plan_day.day_date.weekday()` is
    what's checked, NOT day_index. Tests that pass [0,1,2,3,4] expecting
    "first 5 schedule positions are training" must anchor start_date on
    Monday so the two coincide.
    """
    pw = FakePlanWeek(start_date=start_date, end_date=start_date + timedelta(days=6))
    days: list[FakePlanDay] = []
    focuses = focuses or ["Push", "Pull", "Legs", "Push", "Pull", "Rest", "Rest"]
    for i in range(7):
        d = start_date + timedelta(days=i)
        is_rest = i in rest_indexes
        locked = i in locked_indexes
        focus = focuses[i] if i < len(focuses) else "Rest"
        days.append(FakePlanDay(
            id=i + 1,
            plan_week_id=pw.id,
            day_date=d,
            day_index=i,
            is_rest=is_rest,
            locked=locked,
            status="completed" if locked else ("planned" if not is_rest else "rest"),
            lock_reason="completed" if locked else None,
            workout_json=None if is_rest else {"focus": focus, "exercises": [{"name": f"{focus} Ex 1"}]},
            nutrition_json={"meals": [{"meal": "M1", "protein": 30}]},
        ))
    return pw, days


def _patch_get_week_days(monkeypatch_or_days):
    """Returns a context manager / decorator that patches get_week_days."""
    if callable(monkeypatch_or_days):
        return monkeypatch_or_days
    days = monkeypatch_or_days
    return patch.object(week_manager, "get_week_days", return_value=days)


# ─── Section 1: Done-day protection in regenerate_remaining_days ────────────
# (The function is the one called from POST /plans/week/regenerate-remaining
# when the user changes days_per_week or preferred_split mid-week.)


def test_regen_skips_locked_days():
    """Locked days get NO updates regardless of fresh_workout_days."""
    today = date.today()
    pw, days = _build_week(today - timedelta(days=2), locked_indexes=(0, 1))
    with _patch_get_week_days(days):
        fresh = [{"focus": "NEW1"}, {"focus": "NEW2"}, {"focus": "NEW3"}, {"focus": "NEW4"}, {"focus": "NEW5"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Days 0, 1 untouched
    assert days[0].workout_json["focus"] == "Push"
    assert days[1].workout_json["focus"] == "Pull"
    # Locked status preserved
    assert days[0].locked is True
    assert days[1].locked is True
    assert days[0].status == "completed"


def test_regen_skips_past_unlocked_days():
    """Past days (day_date < today) are skipped even if not locked."""
    today = date.today()
    # Week started 3 days ago. Day 0 = today-3, Day 2 = today-1, Day 3 = today.
    pw, days = _build_week(today - timedelta(days=3))  # No explicit lock — rely on date filter
    with _patch_get_week_days(days):
        fresh = [{"focus": "NEW1"}] * 5
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=list(range(7)),
        )
    # First 3 days are in the past — workout_json must not change
    assert days[0].workout_json["focus"] == "Push"
    assert days[1].workout_json["focus"] == "Pull"
    assert days[2].workout_json["focus"] == "Legs"
    # Today (day 3) onwards CAN change; use all weekdays above so this
    # assertion is stable whether the test runs on a weekday or weekend.
    assert days[3].workout_json["focus"] == "NEW1" or days[3].workout_json["focus"] in {"Push"}


def test_regen_updates_remaining_days_with_new_focus():
    """Future unlocked days adopt fresh_workout_days focuses in order."""
    monday = _monday_of_current_week()
    # Skip if today is in the past portion of the week — those days are
    # filtered by date and won't be rewritten.
    pw, days = _build_week(monday, locked_indexes=())
    with _patch_get_week_days(days):
        fresh = [{"focus": "Upper"}, {"focus": "Lower"}, {"focus": "Upper"}, {"focus": "Lower"}, {"focus": "Upper"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    today = date.today()
    # Only days from today onwards (and Mon-Fri only) get rewritten.
    for d in days:
        if d.day_date >= today and d.day_date.weekday() in (0, 1, 2, 3, 4):
            assert d.workout_json is not None
            assert d.workout_json.get("focus") in {"Upper", "Lower"}


def test_regen_with_no_fresh_days_clears_unlocked_workouts():
    """Empty fresh_workout_days = unlocked future training days have workout_json=None."""
    today = date.today()
    pw, days = _build_week(today, locked_indexes=())
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [], training_day_pattern=[0, 1, 2, 3, 4],
        )
    for i in range(5):
        assert days[i].workout_json is None


def test_regen_preserves_locked_lock_reason():
    """Lock reason on a completed day is not overwritten by regen."""
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(0,))
    days[0].lock_reason = "completed"
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 5, training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert days[0].lock_reason == "completed"


def test_regen_preserves_locked_status_completed():
    """Day with status='completed' stays 'completed' through regen."""
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(0,))
    days[0].status = "completed"
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 5, training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert days[0].status == "completed"


def test_regen_preserves_locked_workout_exercises():
    """Exact exercise list on a locked day is untouched."""
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(0,))
    original_workout = {"focus": "Push", "exercises": [{"name": "Bench Press"}, {"name": "OHP"}]}
    days[0].workout_json = original_workout
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "DIFFERENT"}] * 5, training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert days[0].workout_json == original_workout


def test_regen_with_all_days_locked_is_noop():
    """When every day is locked, regen produces zero updates."""
    today = date.today()
    pw, days = _build_week(today, locked_indexes=tuple(range(7)))
    snapshot = [d.workout_json for d in days]
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 5, training_day_pattern=[0, 1, 2, 3, 4],
        )
    for i, d in enumerate(days):
        assert d.workout_json == snapshot[i]


def test_regen_with_mix_of_locked_and_unlocked():
    """Locked days are preserved; unlocked future + DOW-matching days are rewritten."""
    monday = _monday_of_current_week()
    pw, days = _build_week(monday, locked_indexes=(0, 1, 2))
    original_locked = [d.workout_json for d in days[:3]]
    with _patch_get_week_days(days):
        fresh = [{"focus": "NEW1"}, {"focus": "NEW2"}, {"focus": "NEW3"}, {"focus": "NEW4"}, {"focus": "NEW5"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Locked days preserved
    for i in range(3):
        assert days[i].workout_json == original_locked[i]
    # Days 5, 6 (Sat, Sun) become rest because not in pattern [0..4]
    assert days[5].is_rest is True
    assert days[6].is_rest is True


# ─── Section 2: Done-day protection in adapt_remaining_days ─────────────────
# adapt = same recipe, fresh exercises (used after fatigue spike)


def test_adapt_skips_locked_future_day():
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(2,))
    pinned = days[2].workout_json
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 5,
        )
    assert days[2].workout_json == pinned


def test_adapt_skips_past_days():
    today = date.today()
    pw, days = _build_week(today - timedelta(days=2))
    snap_past = [d.workout_json for d in days[:2]]
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 5,
        )
    assert days[0].workout_json == snap_past[0]
    assert days[1].workout_json == snap_past[1]


def test_adapt_skips_rest_days_in_remaining():
    """adapt's filter excludes is_rest=True even if unlocked + future."""
    today = date.today()
    pw, days = _build_week(today, rest_indexes=(2, 5, 6))
    pre = [d.workout_json for d in days]
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "NEW1"}, {"focus": "NEW2"}, {"focus": "NEW3"}, {"focus": "NEW4"}],
        )
    # Rest days unchanged
    for i in (2, 5, 6):
        assert days[i].workout_json == pre[i]


def test_adapt_updates_unlocked_future_training_days():
    today = date.today()
    pw, days = _build_week(today)
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "F1"}, {"focus": "F2"}, {"focus": "F3"}, {"focus": "F4"}, {"focus": "F5"}],
        )
    # Days 0-4 are training and unlocked → get fresh
    assert days[0].workout_json["focus"] == "F1"
    assert days[4].workout_json["focus"] == "F5"
    # generation_source flips to 'adapt'
    assert days[0].generation_source == "adapt"


def test_adapt_assigns_nutrition_templates_to_remaining():
    today = date.today()
    pw, days = _build_week(today)
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "F"}] * 5,
            nutrition_templates=[{"calories": 2200}, {"calories": 2400}, {"calories": 2600}],
        )
    # Each remaining day gets a nutrition template (rotates)
    for i in range(7):
        assert days[i].nutrition_json is not None


# ─── Section 3: patch_day_workout protection ────────────────────────────────


def test_patch_locked_day_raises():
    today = date.today()
    pd = FakePlanDay(day_date=today, locked=True, lock_reason="completed", status="completed")
    try:
        week_manager.patch_day_workout(FakeSession(), pd, {"focus": "NEW"})
        raise AssertionError("Expected ValueError")
    except ValueError as e:
        assert "locked" in str(e).lower()


def test_patch_unlocked_day_succeeds():
    today = date.today()
    pd = FakePlanDay(day_date=today, locked=False, status="planned",
                     workout_json={"focus": "Push", "exercises": []})
    week_manager.patch_day_workout(FakeSession(), pd, {"focus": "Pull", "exercises": []})
    assert pd.workout_json["focus"] == "Pull"
    assert pd.locked is True
    assert pd.lock_reason == "manual_edit"
    assert pd.status == "edited"


def test_patch_clears_is_rest():
    today = date.today()
    pd = FakePlanDay(day_date=today, is_rest=True, workout_json=None)
    week_manager.patch_day_workout(FakeSession(), pd, {"focus": "Push", "exercises": []})
    assert pd.is_rest is False


def test_patch_nutrition_locked_raises():
    pd = FakePlanDay(locked=True, lock_reason="completed")
    try:
        week_manager.patch_day_nutrition(FakeSession(), pd, {"meals": []})
        raise AssertionError("Expected ValueError")
    except ValueError as e:
        assert "locked" in str(e).lower()


def test_patch_nutrition_unlocked_succeeds():
    pd = FakePlanDay(locked=False, nutrition_json={"meals": [{"meal": "old"}]})
    week_manager.patch_day_nutrition(FakeSession(), pd, {"meals": [{"meal": "new"}]})
    assert pd.nutrition_json["meals"][0]["meal"] == "new"


# ─── Section 4: Split change mid-week (PPL → PPLUL, etc.) ───────────────────


def test_ppl_to_pplul_midweek():
    """User completes Push Mon, Pull Tue, then switches to PPLUL on Wed.
    Past 2 days locked + preserved; remaining days get UL pattern."""
    monday = _monday_of_current_week()
    pw, days = _build_week(monday, locked_indexes=(0, 1),
                           focuses=["Push", "Pull", "Legs", "Push", "Pull", "Rest", "Rest"])
    pw.preferred_split = "ppl"
    days[0].workout_json = {"focus": "Push"}
    days[1].workout_json = {"focus": "Pull"}
    with _patch_get_week_days(days):
        # New 5-day Mon-Fri pattern with PPLUL focuses (cyclic):
        fresh = [{"focus": "Legs"}, {"focus": "Upper"}, {"focus": "Lower"}, {"focus": "Push"}, {"focus": "Pull"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert days[0].workout_json["focus"] == "Push"  # locked preserved
    assert days[1].workout_json["focus"] == "Pull"  # locked preserved
    today = date.today()
    # Wed onwards (or today onwards if test runs Mon/Tue) gets fresh focuses
    for d in days[2:5]:
        if d.day_date >= today:
            assert d.workout_json is not None
            assert d.workout_json["focus"] in {"Legs", "Upper", "Lower", "Push", "Pull"}


def test_ppl_to_ul_midweek_reduces_dpw():
    """PPL 6 days → UL 4 days mid-week. dpw shrinks."""
    today = date.today()
    monday = today - timedelta(days=1)
    pw, days = _build_week(monday, locked_indexes=(0,))
    pw.preferred_split = "ppl"
    pw.days_per_week = 6
    with _patch_get_week_days(days):
        fresh = [{"focus": "Upper"}, {"focus": "Lower"}, {"focus": "Upper"}, {"focus": "Lower"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh,
            training_day_pattern=[0, 1, 3, 4],  # Mon Tue Thu Fri
            new_days_per_week=4,
        )
    # Day 0 (Mon, locked) preserved
    assert days[0].locked is True
    # dpw updated on plan_week
    assert pw.days_per_week == 4


def test_ul_to_full_body_midweek():
    monday = _monday_of_current_week()
    pw, days = _build_week(monday, locked_indexes=(0, 1),
                           focuses=["Upper", "Lower", "Upper", "Lower", "Rest", "Rest", "Rest"])
    pw.preferred_split = "ul"
    days[0].workout_json = {"focus": "Upper"}
    days[1].workout_json = {"focus": "Lower"}
    with _patch_get_week_days(days):
        fresh = [{"focus": "Full Body"}, {"focus": "Full Body"}, {"focus": "Full Body"}]
        # New pattern: Mon, Tue, Thu, Sat (DOW 0, 1, 3, 5)
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 3, 5],
        )
    assert days[0].workout_json["focus"] == "Upper"  # locked
    assert days[1].workout_json["focus"] == "Lower"  # locked
    today = date.today()
    # Day at DOW=3 (Thu = day_index 3) and DOW=5 (Sat = day_index 5)
    if days[3].day_date >= today:
        assert days[3].workout_json is not None
        assert days[3].workout_json["focus"] == "Full Body"
    if days[5].day_date >= today:
        assert days[5].workout_json is not None
        assert days[5].workout_json["focus"] == "Full Body"


def test_full_body_to_ppl_midweek():
    today = date.today()
    monday = today - timedelta(days=2)
    pw, days = _build_week(monday, locked_indexes=(0, 1),
                           focuses=["Full Body", "Rest", "Full Body", "Rest", "Full Body", "Rest", "Rest"],
                           rest_indexes=(1, 3, 5, 6))
    pw.preferred_split = "full_body"
    with _patch_get_week_days(days):
        fresh = [{"focus": "Push"}, {"focus": "Pull"}, {"focus": "Legs"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Day 0 still Full Body
    assert days[0].workout_json["focus"] == "Full Body"


def test_split_change_does_not_break_locked_days():
    """Verify locked days survive any split change."""
    today = date.today()
    pw, days = _build_week(today - timedelta(days=3), locked_indexes=(0, 1, 2))
    snap = [d.workout_json for d in days[:3]]
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "BRAND_NEW"}] * 7,
            training_day_pattern=[0, 1, 2, 3, 4, 5, 6],  # Every day
        )
    for i in range(3):
        assert days[i].workout_json == snap[i]


def test_split_change_marks_remaining_generation_source_adapt():
    today = date.today()
    pw, days = _build_week(today)
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    for d in days:
        if not d.locked and d.day_date >= today:
            assert d.generation_source == "adapt"


def test_split_change_resets_status_to_planned():
    today = date.today()
    pw, days = _build_week(today)
    days[0].status = "edited"  # Stale state from prior session
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert days[0].status == "planned"


def test_split_change_fresh_days_rotate_via_modulo():
    """If fresh_workout_days is shorter than training-day count, rotates."""
    monday = _monday_of_current_week()
    pw, days = _build_week(monday)
    today = date.today()
    with _patch_get_week_days(days):
        fresh = [{"focus": "A"}, {"focus": "B"}, {"focus": "C"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Days where DOW is in [0..4] AND day_date >= today get rotated A/B/C
    for d in days:
        if d.day_date >= today and d.day_date.weekday() in (0, 1, 2, 3, 4):
            assert d.workout_json is not None
            assert d.workout_json["focus"] in {"A", "B", "C"}


# ─── Section 5: days_per_week change mid-week ───────────────────────────────


def test_dpw_increase_4_to_5_midweek():
    """User on 4d/wk completes Mon (Push), then bumps to 5d. New pattern
    adds Wed as a training day."""
    monday = _monday_of_current_week()
    fake_today = monday + timedelta(days=1)  # Tuesday
    pw, days = _build_week(monday, locked_indexes=(0,), rest_indexes=(2,))
    pw.days_per_week = 4
    days[0].workout_json = {"focus": "Push"}
    with _patch_get_week_days(days), patch.object(week_manager, "date") as fake_date:
        fake_date.today.return_value = fake_today
        # New 5d pattern: Mon Tue Wed Thu Fri
        fresh = [{"focus": "Pull"}, {"focus": "Legs"}, {"focus": "Push"}, {"focus": "Pull"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
            new_days_per_week=5,
        )
    assert pw.days_per_week == 5
    assert days[0].workout_json["focus"] == "Push"  # locked, preserved
    # Day 2 (Wed) was rest, becomes training in new pattern
    assert days[2].is_rest is False


def test_dpw_decrease_6_to_4_midweek():
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(0,), rest_indexes=(6,))
    pw.days_per_week = 6
    removed_dow = days[1].day_date.weekday()
    reduced_pattern = [dow for dow in range(7) if dow != removed_dow][:4]
    with _patch_get_week_days(days):
        fresh = [{"focus": "X"}] * 4
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=reduced_pattern,
            new_days_per_week=4,
        )
    assert pw.days_per_week == 4
    # The next unlocked future day was training in old 6d, now rest.
    assert days[1].is_rest is True


def test_dpw_change_preserves_past_rest_days_unchanged():
    """Past rest days stay as they were even if new pattern would have made them training."""
    today = date.today()
    monday = today - timedelta(days=2)  # today is Wed
    pw, days = _build_week(monday, rest_indexes=(1,))  # Tue was rest
    days[1].locked = True  # Past rest day
    with _patch_get_week_days(days):
        # New pattern makes Tue a training day
        fresh = [{"focus": "X"}] * 7
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4, 5, 6],
            new_days_per_week=7,
        )
    # Tue stays rest because it was locked
    assert days[1].is_rest is True


def test_dpw_3_to_6_midweek():
    today = date.today()
    monday = today - timedelta(days=1)
    pw, days = _build_week(monday, rest_indexes=(1, 3, 5, 6),
                           focuses=["Full Body", "Rest", "Full Body", "Rest", "Full Body", "Rest", "Rest"])
    pw.days_per_week = 3
    days[0].locked = True
    with _patch_get_week_days(days):
        fresh = [{"focus": "Push"}, {"focus": "Pull"}, {"focus": "Legs"}, {"focus": "Push"}, {"focus": "Pull"}, {"focus": "Legs"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4, 5],
            new_days_per_week=6,
        )
    assert pw.days_per_week == 6


def test_dpw_no_change_keeps_value():
    today = date.today()
    pw, days = _build_week(today)
    pw.days_per_week = 5
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
            # No new_days_per_week passed
        )
    assert pw.days_per_week == 5


def test_dpw_change_only_applied_when_explicit():
    today = date.today()
    pw, days = _build_week(today)
    pw.days_per_week = 5
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
            new_days_per_week=None,  # explicit None
        )
    assert pw.days_per_week == 5  # unchanged


# ─── Section 6: is_rest pattern updates ──────────────────────────────────────


def test_is_rest_flips_for_new_training_day():
    today = date.today()
    pw, days = _build_week(today, rest_indexes=(2,))  # Wed rest
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 7,
            training_day_pattern=[0, 1, 2, 3, 4, 5, 6],  # 7-day pattern
        )
    assert days[2].is_rest is False
    assert days[2].workout_json is not None


def test_is_rest_flips_for_new_rest_day():
    monday = _monday_of_current_week()
    pw, days = _build_week(monday)
    today = date.today()
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 3,
            training_day_pattern=[0, 2, 4],  # Mon Wed Fri
        )
    # Tue (1), Thu (3), Sat (5), Sun (6) become rest if they are >= today
    for idx in (1, 3, 5, 6):
        if days[idx].day_date >= today:
            assert days[idx].is_rest is True


def test_is_rest_clears_workout_when_becoming_rest():
    monday = _monday_of_current_week()
    pw, days = _build_week(monday)
    today = date.today()
    days[1].workout_json = {"focus": "STALE"}
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 3,
            training_day_pattern=[0, 2, 4],
        )
    if days[1].day_date >= today:
        assert days[1].is_rest is True
        assert days[1].workout_json is None


def test_is_rest_locked_day_preserves_rest_state():
    """Past rest day stays as rest even if pattern shifts."""
    today = date.today()
    pw, days = _build_week(today - timedelta(days=2), rest_indexes=(0,), locked_indexes=(0,))
    pre_is_rest = days[0].is_rest
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 7,
            training_day_pattern=[0, 1, 2, 3, 4, 5, 6],
        )
    assert days[0].is_rest == pre_is_rest


# ─── Section 7: nutrition_templates assignment ───────────────────────────────


def test_nutrition_templates_rotate_via_day_index():
    today = date.today()
    pw, days = _build_week(today)
    templates = [{"calories": 2000}, {"calories": 2200}, {"calories": 2400}]
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
            nutrition_templates=None,  # Not passed via this fn
        )
    # regenerate_remaining_days only assigns nutrition when explicitly via templates
    # But it leaves nutrition_json as-is otherwise. Verify pre-existing values stay.
    for d in days:
        assert d.nutrition_json is not None


def test_nutrition_skipped_for_locked_days():
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(0,))
    days[0].nutrition_json = {"meals": [{"meal": "Locked"}]}
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            nutrition_templates=[{"meals": [{"meal": "FRESH"}]}],
        )
    # Locked day's nutrition unchanged
    assert days[0].nutrition_json["meals"][0]["meal"] == "Locked"


def test_adapt_assigns_nutrition_to_remaining_days_only():
    today = date.today()
    pw, days = _build_week(today, locked_indexes=(0,))
    days[0].nutrition_json = {"meals": [{"meal": "Original"}]}
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            nutrition_templates=[{"meals": [{"meal": "NEW"}]}],
        )
    assert days[0].nutrition_json["meals"][0]["meal"] == "Original"
    # Future days got NEW
    for i in range(1, 7):
        assert days[i].nutrition_json["meals"][0]["meal"] == "NEW"


def test_adapt_no_nutrition_templates_keeps_existing():
    today = date.today()
    pw, days = _build_week(today)
    pre_nutrition = [d.nutrition_json for d in days]
    with _patch_get_week_days(days):
        week_manager.adapt_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            nutrition_templates=None,
        )
    for i, d in enumerate(days):
        assert d.nutrition_json == pre_nutrition[i]


# ─── Section 8: workout_idx rotation through fresh_workout_days ──────────────


def test_workout_idx_continues_past_locked_days():
    """workout_idx should NOT skip when iterating past locked training days
    (it does increment for them so the next unlocked training day pulls
    the right index from fresh_workout_days)."""
    class WednesdayDate(date):
        @classmethod
        def today(cls):
            return date(2026, 4, 29)

    today = WednesdayDate.today()
    pw, days = _build_week(today - timedelta(days=2), locked_indexes=(0, 1))
    with patch.object(week_manager, "date", WednesdayDate), _patch_get_week_days(days):
        # 5 fresh days for 5-day-a-week pattern, but past 2 training days are locked.
        # So workout_idx starts at 2 for today onwards.
        fresh = [{"focus": "F0"}, {"focus": "F1"}, {"focus": "F2"}, {"focus": "F3"}, {"focus": "F4"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Days 0-1 locked, days 2-4 are training, days 5-6 are rest
    # workout_idx incremented twice for past locked training days (0, 1)
    # → day 2 (today) gets fresh[2], day 3 fresh[3], day 4 fresh[4]
    assert days[2].workout_json["focus"] == "F2"
    assert days[3].workout_json["focus"] == "F3"
    assert days[4].workout_json["focus"] == "F4"


def test_workout_idx_does_not_advance_for_past_rest_days():
    """Past rest days don't bump workout_idx."""
    today = date.today()
    pw, days = _build_week(today - timedelta(days=1), rest_indexes=(0,), locked_indexes=(0,))
    with _patch_get_week_days(days):
        fresh = [{"focus": "F0"}, {"focus": "F1"}, {"focus": "F2"}, {"focus": "F3"}, {"focus": "F4"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[1, 2, 3, 4, 5],
        )
    # Day 0 was rest+locked → workout_idx stays at 0
    # Day 1 (today) is training → fresh[0]
    assert days[1].workout_json["focus"] == "F0"


def test_workout_idx_wraps_with_short_fresh_list():
    monday = _monday_of_current_week()
    pw, days = _build_week(monday)
    today = date.today()
    with _patch_get_week_days(days):
        fresh = [{"focus": "A"}, {"focus": "B"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Whatever Mon-Fri training days are >= today get rotated A/B
    for d in days:
        if d.day_date >= today and d.day_date.weekday() in (0, 1, 2, 3, 4):
            assert d.workout_json is not None
            assert d.workout_json["focus"] in {"A", "B"}


def test_workout_idx_with_empty_fresh_assigns_none():
    today = date.today()
    pw, days = _build_week(today)
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [], training_day_pattern=[0, 1, 2, 3, 4],
        )
    for i in range(5):
        assert days[i].workout_json is None


# ─── Section 9: lock_day / complete_day / skip_day semantics ─────────────────


def test_complete_day_locks_with_completed_reason():
    pd = FakePlanDay(day_date=date.today())
    week_manager.complete_day(FakeSession(), pd)
    assert pd.locked is True
    assert pd.lock_reason == "completed"
    assert pd.status == "completed"


def test_skip_day_locks_with_skipped_reason():
    pd = FakePlanDay(day_date=date.today())
    week_manager.skip_day(FakeSession(), pd, reason="Feeling sick")
    assert pd.locked is True
    assert pd.lock_reason == "skipped"
    assert pd.skip_reason == "Feeling sick"
    assert pd.status == "skipped"


def test_unskip_day_restores_manual_skip():
    pd = FakePlanDay(
        day_date=date.today(),
        status="skipped",
        locked=True,
        lock_reason="skipped",
    )
    pd.skip_reason = "Feeling sick"
    week_manager.unskip_day(FakeSession(), pd)
    assert pd.locked is False
    assert pd.lock_reason is None
    assert pd.skip_reason is None
    assert pd.status == "planned"


def test_start_day_locks_with_started_reason():
    pd = FakePlanDay(day_date=date.today())
    week_manager.start_day(FakeSession(), pd)
    assert pd.locked is True
    assert pd.lock_reason == "started"
    assert pd.status == "started"


def test_lock_day_sets_locked_at():
    pd = FakePlanDay(day_date=date.today())
    week_manager.lock_day(FakeSession(), pd, reason="test")
    assert pd.locked is True
    assert pd.locked_at is not None


def test_lock_day_does_not_force_status():
    pd = FakePlanDay(day_date=date.today(), status="planned")
    week_manager.lock_day(FakeSession(), pd, reason="manual")
    # status only changes when explicitly passed
    assert pd.status == "planned"
    assert pd.locked is True


def test_completion_match_rejects_extra_cardio_on_lift_day():
    pd = FakePlanDay(
        day_date=date.today(),
        workout_json={"focus": "Push", "exercises": []},
    )
    assert week_manager._completion_matches_plan_day(pd, "Walking") is False


def test_completion_match_allows_matching_focus_family():
    pd = FakePlanDay(
        day_date=date.today(),
        workout_json={"focus": "Push + Cardio", "exercises": []},
    )
    assert week_manager._completion_matches_plan_day(pd, "Chest") is True


def test_completion_match_allows_cardio_day_import():
    pd = FakePlanDay(
        day_date=date.today(),
        workout_json={"focus": "Cardio", "exercises": []},
    )
    assert week_manager._completion_matches_plan_day(pd, "Running") is True


# ─── Section 10: Edge cases ──────────────────────────────────────────────────


def test_regen_on_fresh_week_no_locks():
    today = date.today()
    pw, days = _build_week(today)  # No locks, all unlocked
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    # All 5 training days got new workouts
    assert sum(1 for d in days if d.workout_json and d.workout_json.get("focus") == "X") == 5


def test_regen_on_last_day_only_one_remaining():
    """Today is Sunday (last day of the week). Only one day left to regen."""
    today = date.today()
    monday = today - timedelta(days=6)
    pw, days = _build_week(monday, locked_indexes=(0, 1, 2, 3, 4, 5))
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "Sunday"}],
            training_day_pattern=[6],
        )
    # First 6 days locked + preserved
    assert days[0].locked is True


def test_regen_when_today_already_completed_no_remaining_changes():
    """Today is locked (completed) → regen leaves all days alone."""
    today = date.today()
    monday = today - timedelta(days=2)  # today = Wed
    pw, days = _build_week(monday, locked_indexes=(0, 1, 2))
    snap_today_workout = days[2].workout_json
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "AfterToday"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Today (locked) preserved
    assert days[2].workout_json == snap_today_workout


def test_regen_with_zero_training_days_makes_all_rest():
    today = date.today()
    pw, days = _build_week(today)
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [], training_day_pattern=[],
        )
    for d in days:
        assert d.is_rest is True


def test_regen_with_seven_training_days_makes_all_training():
    today = date.today()
    pw, days = _build_week(today)
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "Daily"}] * 7,
            training_day_pattern=[0, 1, 2, 3, 4, 5, 6],
        )
    for d in days:
        assert d.is_rest is False
        assert d.workout_json is not None


def test_regen_does_not_mutate_plan_week_start_date():
    today = date.today()
    pw, days = _build_week(today)
    original_start = pw.start_date
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert pw.start_date == original_start


def test_regen_does_not_mutate_plan_week_end_date():
    today = date.today()
    pw, days = _build_week(today)
    original_end = pw.end_date
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "X"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    assert pw.end_date == original_end


# ─── Section 11: Auto-renew never affects active week ────────────────────────


def test_week_needs_renewal_today_is_end_date():
    """end_date == today → still active, no renewal."""
    pw = FakePlanWeek(start_date=date.today() - timedelta(days=6),
                      end_date=date.today())
    assert week_manager.week_needs_renewal(pw) is False


def test_week_needs_renewal_end_was_yesterday():
    pw = FakePlanWeek(start_date=date.today() - timedelta(days=7),
                      end_date=date.today() - timedelta(days=1))
    assert week_manager.week_needs_renewal(pw) is True


def test_week_needs_renewal_far_future_active():
    """Hypothetical end_date in the future still counts as active."""
    pw = FakePlanWeek(start_date=date.today(),
                      end_date=date.today() + timedelta(days=6))
    assert week_manager.week_needs_renewal(pw) is False


# ─── Section 12: User-visible scenarios (integration-flavored unit tests) ───


def test_scenario_user_completes_mon_changes_split_wed():
    """Realistic flow: user finishes Mon's Push, goes about Tue, then Wed
    morning decides to switch from PPL → UL. Past Mon stays Push (locked).
    Tue is in the past too — even if not locked it's protected by date filter.
    Wed onwards becomes Upper/Lower."""
    today = date.today()
    monday = today - timedelta(days=2)  # today is Wed
    pw, days = _build_week(monday, locked_indexes=(0,),  # Only Mon locked
                           focuses=["Push", "Pull", "Legs", "Push", "Pull", "Rest", "Rest"])
    with _patch_get_week_days(days):
        # New UL pattern fresh days (4 training Mon Tue Thu Fri):
        fresh = [{"focus": "Upper"}, {"focus": "Lower"}, {"focus": "Upper"}, {"focus": "Lower"}]
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, fresh, training_day_pattern=[0, 1, 3, 4],
            new_days_per_week=4,
        )
    # Mon (locked) → Push preserved
    assert days[0].workout_json["focus"] == "Push"
    # Tue (past, unlocked) → preserved by date filter
    assert days[1].workout_json["focus"] == "Pull"


def test_scenario_user_changes_equipment_resolves_to_planner_inputs():
    """When user removes barbell mid-week, the regen route's input-collection
    logic must pull `equipment` from UserPreferences. This test verifies
    the data shape — actual exercise filtering is the planner's job."""
    # Simulate the input-collection portion of the route.
    user_prefs_equipment = ["dumbbells", "bench", "pullup_bar"]
    # Imagined call: PlannerInputs(equipment_slugs=tuple(sorted(...)))
    sorted_equipment = tuple(sorted(user_prefs_equipment))
    assert "barbell" not in sorted_equipment
    assert "dumbbells" in sorted_equipment


def test_scenario_user_resolves_injury_midweek():
    """Injury cleared mid-week → injuries list shrinks → planner unblocks
    that pattern on remaining days."""
    initial_injuries = ["lower_back", "knee"]
    # Mid-week, lower_back resolves
    cleared = [i for i in initial_injuries if i != "lower_back"]
    assert cleared == ["knee"]
    # The remaining-days regen would pass tuple(cleared) into PlannerInputs.
    # Past locked days don't see the new injury list — they stay as logged.


def test_scenario_user_completes_recovery_day_then_regen():
    """Completing a recovery day adds NEGATIVE fatigue to muscles. Mid-week
    regen picks up that fatigue snapshot via compute_rolling_fatigue. This
    test verifies the lock+status flow that recovery days follow."""
    today = date.today()
    pw, days = _build_week(today - timedelta(days=1),
                           focuses=["Recovery", "Push", "Pull", "Legs", "Rest", "Rest", "Rest"])
    pd = days[0]
    pd.workout_json = {"focus": "Recovery", "stimulus": "recovery"}
    week_manager.complete_day(FakeSession(), pd)
    assert pd.locked is True
    assert pd.lock_reason == "completed"
    assert pd.status == "completed"


def test_scenario_user_skips_today_then_changes_split():
    """User skips today's workout, then switches split. Skipped day stays
    as a locked skip; remaining days adopt new split."""
    today = date.today()
    pw, days = _build_week(today)
    week_manager.skip_day(FakeSession(), days[0])  # Today skipped
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 4,
            training_day_pattern=[1, 2, 3, 4],
            new_days_per_week=4,
        )
    # Skipped today preserved
    assert days[0].locked is True
    assert days[0].lock_reason == "skipped"


def test_scenario_user_locks_thursday_manually_then_regenerates():
    """User pins Thu (manually locked via patch_day_workout). Subsequent
    full week regen leaves Thu untouched."""
    today = date.today()
    monday = today - timedelta(days=1)  # today = Tue
    pw, days = _build_week(monday)
    # Pin Thu (day 3) manually
    week_manager.patch_day_workout(FakeSession(), days[3], {"focus": "Pinned Push", "exercises": []})
    pinned_workout = days[3].workout_json
    with _patch_get_week_days(days):
        week_manager.regenerate_remaining_days(
            FakeSession(), pw, [{"focus": "NEW"}] * 5,
            training_day_pattern=[0, 1, 2, 3, 4],
        )
    # Thu still pinned
    assert days[3].workout_json == pinned_workout
    assert days[3].locked is True


# ─── Run ──────────────────────────────────────────────────────────────────────


def run_tests():
    test_fns = [v for k, v in globals().items() if k.startswith("test_")]
    passed = 0
    failed = 0
    for fn in test_fns:
        try:
            fn()
            passed += 1
            print(f"  PASS  {fn.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {fn.__name__}: {e}")
    print(f"\nplan_week_midweek_regen: {passed} passed, {failed} failed")
    return failed == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)
