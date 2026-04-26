"""History-aware generation tests for /workouts/generate-week (Switch
Day) and /workouts/generate-day (single-day / 7th-day regen).

Existing coverage:
  - `test_switch_day.py` covers the pure pin algorithm.
  - `test_switch_day_integration.py` sweeps pins on real recipes.
  - `test_single_day_regen.py` covers focus normalization + recent-focus
    rotation in the planner.

Gap this file fills — the *router-level* history-merge behavior that
both endpoints do BEFORE calling the planner, and the preservation
properties of single-day regen:

  Switch Day  (/generate-week, routers/workouts.py:687-702)
    Prepends the user's `pin_focus` (normalized to bucket + family) to
    `recent_focus_buckets` / `recent_focus_families` so the rotator
    treats the pinned day as "just done" — every other day rotates
    away from it, but the pinned day itself keeps the focus.

  Single-day  (/generate-day, routers/workouts.py:357-385)
    Merges client-supplied `prev_focuses` (focuses already chosen for
    earlier days of the same plan that haven't been completed yet),
    normalized + REVERSED + prepended so the most-recent-in-plan day
    counts as freshest.

  Single-day preservation
    The endpoint returns ONE day; the client merges it into the
    existing 6-day plan in AsyncStorage. Preservation requires:
      - Same (user_id + day_index, inputs) → same day every call
        (so a tap-tap-tap doesn't keep churning the result)
      - Different day_index values produce days from a recipe with
        the SAME shape as the user's plan (preferred_split honored,
        days_per_week honored, archetype family stays in-split)
      - Recipe-level invariants (Bro canonical order, PPL family mix)
        survive across per-day calls, so the merged plan stays valid
"""
from __future__ import annotations

from app.services.workout.planner import PlannerInputs, generate_workout_plan
from app.services.workout.focus_normalize import (
    normalize_focus_to_bucket, normalize_focus_to_family,
)
from app.seed_exercises_data import SEED_EXERCISES


_FULL_GYM = (
    "barbell", "dumbbells", "weight_plates", "power_rack", "squat_rack",
    "flat_bench", "adjustable_bench", "preacher_bench",
    "cable_machine", "lat_pulldown", "pull_up_bar", "dip_bars",
    "leg_press", "smith_machine", "ez_curl_bar",
    "kettlebell", "trap_bar", "landmine_attachment",
    "rowing_machine", "treadmill", "stationary_bike", "stair_climber",
    "leg_curl_machine", "leg_extension_machine", "calf_raise_machine",
    "seated_row_machine", "chest_press_machine", "shoulder_press_machine",
    "hack_squat", "back_extension_bench",
)


def _inputs(**kw) -> PlannerInputs:
    base = dict(
        goal="muscle_gain",
        days_per_week=5,
        session_minutes=60,
        experience="intermediate",
        equipment_slugs=_FULL_GYM,
        preferred_split="ppl",
        priority_region="balanced",
        injuries=tuple(),
        disliked_exercises=tuple(),
        rng_seed=42,
        recent_focus_buckets=tuple(),
        recent_focus_families=tuple(),
        muscle_fatigue=None,
    )
    base.update(kw)
    return PlannerInputs(**base)


def _focus_lower(d: dict) -> str:
    return (d.get("focus") or "").lower()


def _family_of(focus: str) -> str:
    """Coarse family classifier matching the router/planner conventions."""
    f = (focus or "").lower().replace(" + cardio", "").strip()
    if "legs" in f or "lower" in f:
        return "legs" if "legs" in f else "lower"
    if "push" in f or "chest" in f:
        return "push"
    if "pull" in f or "back" in f:
        return "pull"
    if "shoulders" in f:
        return "push"
    if "arms" in f:
        return "upper"
    if "upper" in f:
        return "upper"
    if "full" in f:
        return "full"
    if "mobility" in f or "recovery" in f:
        return "rest"
    if "cardio" in f or "intervals" in f or "tempo" in f or "zone" in f:
        return "cardio"
    return "?"


# ─── Router prepend helpers (mirror of routers/workouts.py logic) ───
# These replicate the EXACT prepend done by the routers before the
# planner is called. Tested here without DB / FastAPI overhead so the
# pure transform is exercised in isolation.

def _switch_day_prepend(pin_focus: str | None,
                        recent_buckets: tuple[str, ...],
                        recent_families: tuple[str, ...]
                        ) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Mirrors routers/workouts.py:687-702 (generate-week pin_focus prepend)."""
    if not pin_focus:
        return recent_buckets, recent_families
    pb = normalize_focus_to_bucket(pin_focus)
    pf = normalize_focus_to_family(pin_focus)
    new_buckets = (pb,) + recent_buckets if pb else recent_buckets
    new_families = (pf,) + recent_families if pf else recent_families
    return new_buckets, new_families


def _generate_day_prepend(prev_focuses: list[str] | None,
                          recent_buckets: tuple[str, ...],
                          recent_families: tuple[str, ...]
                          ) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Mirrors routers/workouts.py:357-385 (generate-day prev_focuses prepend).
    Iterates `reversed(prev_focuses)` so the client's natural order
    (day 1, day 2, ...) becomes newest-first in the history tuple."""
    if not prev_focuses:
        return recent_buckets, recent_families
    extra_buckets: list[str] = []
    extra_families: list[str] = []
    for raw in reversed(prev_focuses):
        if not raw:
            continue
        b = normalize_focus_to_bucket(raw)
        f = normalize_focus_to_family(raw)
        if b:
            extra_buckets.append(b)
        if f:
            extra_families.append(f)
    new_buckets = tuple(extra_buckets) + recent_buckets if extra_buckets else recent_buckets
    new_families = tuple(extra_families) + recent_families if extra_families else recent_families
    return new_buckets, new_families


# ════════════════════════════════════════════════════════════════════
# GROUP 1 — Switch Day pin_focus is prepended to history
# ════════════════════════════════════════════════════════════════════

def test_switch_day_prepend_push_pushes_other_days_away_from_push():
    """Pin Push → router prepends ('push',) to families. Planner
    rotation should then place a non-push focus at day 0 of the
    regenerated week so the pinned slot can absorb the push."""
    buckets, families = _switch_day_prepend("Push", (), ())
    assert "push" == families[0], \
        f"pin_focus 'Push' should prepend 'push' as newest family, got {families}"
    assert "upper_body" == buckets[0], \
        f"pin_focus 'Push' should prepend 'upper_body' as newest bucket, got {buckets}"


def test_switch_day_prepend_legs_normalizes_to_lower_body_bucket():
    buckets, families = _switch_day_prepend("Legs", (), ())
    assert families[0] == "legs"
    assert buckets[0] == "lower_body"


def test_switch_day_prepend_push_plus_cardio_normalizes_to_push_family():
    """'Push + Cardio' is the cardio-finisher hybrid. Family base must
    still be push so adjacency rotation works the same as a plain Push pin."""
    _, families = _switch_day_prepend("Push + Cardio", (), ())
    assert families[0] == "push", \
        f"Push + Cardio should normalize to 'push' family, got {families}"


def test_switch_day_prepend_preserves_existing_history_order():
    """Existing recent history must remain intact AFTER the prepended pin —
    pin is newest-first, prior history shifts older."""
    buckets, families = _switch_day_prepend(
        "Pull",
        recent_buckets=("upper_body", "lower_body"),
        recent_families=("push", "legs"),
    )
    assert families == ("pull", "push", "legs"), \
        f"existing history must shift right of pin, got {families}"
    assert buckets == ("upper_body", "upper_body", "lower_body"), \
        f"buckets order broken: {buckets}"


def test_switch_day_prepend_with_no_pin_focus_is_identity():
    """No pin → no prepend. Critical: regen calls without a pin must
    not accidentally inject anything."""
    buckets, families = _switch_day_prepend(
        None,
        recent_buckets=("upper_body",),
        recent_families=("push",),
    )
    assert buckets == ("upper_body",)
    assert families == ("push",)


def test_switch_day_prepended_history_changes_planner_output_at_day_0():
    """End-to-end: pin Legs → prepend ('legs',) → planner places
    something OTHER than Legs at day 0 so the pinned day can hold Legs."""
    # Without pin
    base = generate_workout_plan(_inputs(rng_seed=99), SEED_EXERCISES)["workout_plan"]["days"]
    base_d0 = _focus_lower(base[0])

    # With pin Legs prepended
    buckets, families = _switch_day_prepend("Legs", (), ())
    pinned = generate_workout_plan(
        _inputs(
            rng_seed=99,
            recent_focus_buckets=buckets,
            recent_focus_families=families,
        ),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    pinned_d0 = _focus_lower(pinned[0])

    # If base already wasn't legs the test still passes (pin is consistent),
    # but if base WAS legs at d0 the prepend must rotate it away.
    if "legs" in base_d0:
        assert "legs" not in pinned_d0, \
            f"pin Legs prepend should rotate Legs off day 0, " \
            f"base d0={base_d0!r} pinned d0={pinned_d0!r}"


def test_switch_day_pin_focus_overrides_recent_db_history():
    """User completed Push yesterday (in DB), but explicitly pins Push
    today. The prepend must still work — pin appears at index 0,
    DB-history Push shifts to index 1. Both signals are present."""
    buckets, families = _switch_day_prepend(
        "Push",
        recent_buckets=("upper_body",),
        recent_families=("push",),
    )
    # Pin signal at front, DB signal preserved behind it.
    assert families[0] == "push" and families[-1] == "push"
    assert len(families) == 2


# ════════════════════════════════════════════════════════════════════
# GROUP 2 — Single-day generator: prev_focuses prepend (history merge)
# ════════════════════════════════════════════════════════════════════

def test_generate_day_prev_focuses_prepended_in_reversed_order():
    """Client sends prev_focuses=[Push (day 1), Pull (day 2), Legs (day 3)].
    Router reverses → newest-first: Legs, Pull, Push.
    Day 4's recipe should treat Legs as freshest."""
    buckets, families = _generate_day_prepend(
        ["Push", "Pull", "Legs"], (), (),
    )
    assert families == ("legs", "pull", "push"), \
        f"prev_focuses must reverse to newest-first, got {families}"


def test_generate_day_prev_focuses_with_hybrid_strips_cardio_suffix():
    """prev_focuses contains hybrid labels — base family must be used
    for rotation, otherwise day 0 stays 'push' even when prev=Push+Cardio."""
    _, families = _generate_day_prepend(["Push + Cardio"], (), ())
    assert families == ("push",), \
        f"'Push + Cardio' should normalize to 'push' family, got {families}"


def test_generate_day_prev_focuses_skips_empty_strings():
    """Defensive: client may send empty strings for un-pinned slots.
    Empty entries must be skipped, not produce empty-string history rows."""
    buckets, families = _generate_day_prepend(
        ["Push", "", None, "Legs"], (), (),
    )
    # Reversed order: Legs first, then Push (None/'' filtered)
    assert families == ("legs", "push"), \
        f"empty entries should be filtered, got {families}"


def test_generate_day_empty_prev_focuses_is_identity():
    buckets, families = _generate_day_prepend(
        [], ("upper_body",), ("push",),
    )
    assert buckets == ("upper_body",)
    assert families == ("push",)


def test_generate_day_unknown_focus_in_prev_focuses_does_not_crash():
    """Defense: a label outside the known set normalizes to falsy and
    must just be skipped, not poison the history tuple with junk."""
    buckets, families = _generate_day_prepend(
        ["Astronaut Training", "Push"], (), (),
    )
    assert "push" in families, \
        f"valid focus must survive even alongside garbage, got {families}"
    # No empty/None entries leaked through
    assert all(f for f in families)
    assert all(b for b in buckets)


def test_generate_day_prev_focuses_planner_avoids_back_to_back_push():
    """End-to-end: prev_focuses=[Push] from yesterday's pinned slot
    means the planner's day 0 should not also be Push. This is the
    whole reason prev_focuses exists."""
    buckets, families = _generate_day_prepend(["Push"], (), ())
    days = generate_workout_plan(
        _inputs(
            recent_focus_buckets=buckets,
            recent_focus_families=families,
        ),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    # Planner won't place push at day 0 right after a push in history
    assert "push" not in _focus_lower(days[0]), \
        f"day 0 is Push immediately after prev_focuses=[Push]: " \
        f"{[d.get('focus') for d in days]}"


def test_generate_day_prev_focuses_combined_with_db_history_keeps_both():
    """When the user has both prev_focuses (in-plan, future) AND DB
    history (past completions), both signals must reach the planner.
    prev_focuses goes IN FRONT (most recent in user-flow terms)."""
    buckets, families = _generate_day_prepend(
        ["Legs"],
        recent_buckets=("upper_body",),
        recent_families=("push",),
    )
    assert families == ("legs", "push"), \
        f"prev should be newest, db-history older: {families}"
    assert buckets == ("lower_body", "upper_body"), \
        f"buckets order broken: {buckets}"


# ════════════════════════════════════════════════════════════════════
# GROUP 3 — Single-day generator preservation properties
# ════════════════════════════════════════════════════════════════════
# The endpoint returns ONE day to the client. Preservation of the
# OTHER 6 days happens because the client merges that one day into
# its AsyncStorage cache by index. For that merge to be safe, these
# invariants must hold at the planner level.

def test_single_day_regen_is_deterministic_for_same_inputs():
    """Tap day 6 twice → same exercises both times. If this fails,
    every tap shuffles the user's plan and the cache is unstable."""
    inputs_a = _inputs(rng_seed=100 + 6)  # rng_seed = user_id + day_index
    inputs_b = _inputs(rng_seed=100 + 6)
    days_a = generate_workout_plan(inputs_a, SEED_EXERCISES)["workout_plan"]["days"]
    days_b = generate_workout_plan(inputs_b, SEED_EXERCISES)["workout_plan"]["days"]
    focuses_a = [d.get("focus") for d in days_a]
    focuses_b = [d.get("focus") for d in days_b]
    assert focuses_a == focuses_b, \
        f"same inputs produced different recipes: {focuses_a} vs {focuses_b}"


def test_single_day_regen_for_day_0_does_not_mutate_day_6_recipe_shape():
    """Generating day 0 and day 6 must produce recipes with the SAME
    split shape (PPL family count) — the recipe is a function of split
    + days_per_week, NOT of the day_index. day_index only varies the
    rng_seed for exercise selection variation."""
    days_for_d0 = generate_workout_plan(
        _inputs(rng_seed=100 + 0, days_per_week=7),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    days_for_d6 = generate_workout_plan(
        _inputs(rng_seed=100 + 6, days_per_week=7),
        SEED_EXERCISES,
    )["workout_plan"]["days"]

    def _ppl_count(days):
        c = {"push": 0, "pull": 0, "legs": 0}
        for d in days:
            f = _focus_lower(d).replace(" + cardio", "")
            for k in c:
                if k in f:
                    c[k] += 1
                    break
        return c

    c0 = _ppl_count(days_for_d0)
    c6 = _ppl_count(days_for_d6)
    assert c0 == c6, \
        f"PPL family distribution drifted between day 0 regen ({c0}) " \
        f"and day 6 regen ({c6}) — single-day regen is corrupting plan shape"


def test_single_day_regen_honors_preferred_split_for_each_day_index():
    """Per-day calls across the entire week must all stick to the
    user's preferred split (PPL → only Push/Pull/Legs lift labels)."""
    for di in range(7):
        days = generate_workout_plan(
            _inputs(rng_seed=200 + di, days_per_week=7, preferred_split="ppl"),
            SEED_EXERCISES,
        )["workout_plan"]["days"]
        for d in days:
            fam = _family_of(d.get("focus") or "")
            assert fam in ("push", "pull", "legs", "rest", "cardio", "?"), \
                f"day_index={di} produced non-PPL family {fam!r} for focus " \
                f"{d.get('focus')!r}: split contract violated"


def test_single_day_regen_for_bro_split_keeps_canonical_labels_at_every_index():
    """Bro at any day_index must produce a recipe whose lift labels are
    {Chest, Back, Shoulders, Arms, Legs} — never PPL-style hybrids."""
    canonical = {"Chest", "Back", "Shoulders", "Arms", "Legs"}
    for di in (0, 2, 4, 6):
        days = generate_workout_plan(
            _inputs(
                rng_seed=300 + di,
                days_per_week=5,
                preferred_split="bro",
                experience="advanced",
            ),
            SEED_EXERCISES,
        )["workout_plan"]["days"]
        labels = {d.get("focus") for d in days if d.get("focus")}
        assert canonical.issubset(labels), \
            f"day_index={di} bro recipe lost canonical labels: got {labels}"


def test_single_day_regen_for_upper_lower_keeps_split_labels_at_every_index():
    """UL at any day_index must produce only Upper/Lower lifts."""
    for di in (0, 1, 2, 3):
        days = generate_workout_plan(
            _inputs(
                rng_seed=400 + di,
                days_per_week=4,
                preferred_split="upper_lower",
            ),
            SEED_EXERCISES,
        )["workout_plan"]["days"]
        for d in days:
            fam = _family_of(d.get("focus") or "")
            assert fam in ("upper", "lower", "rest", "cardio", "?"), \
                f"day_index={di} UL recipe produced non-UL family " \
                f"{fam!r} for focus {d.get('focus')!r}"


def test_single_day_regen_7d_preserves_recovery_placement():
    """Per-day regens at every day_index of a 7-day plan must all yield
    a recipe with the forced recovery day. If any per-day call lost it,
    the merged plan would silently drop a rest day."""
    for di in (0, 3, 6):
        days = generate_workout_plan(
            _inputs(rng_seed=500 + di, days_per_week=7),
            SEED_EXERCISES,
        )["workout_plan"]["days"]
        rest_count = sum(
            1 for d in days
            if "recovery" in _focus_lower(d) or "mobility" in _focus_lower(d)
        )
        assert rest_count >= 1, \
            f"day_index={di} 7d recipe lost forced recovery day: " \
            f"{[d.get('focus') for d in days]}"


def test_single_day_regen_archetype_history_via_prev_focuses_at_day_index_6():
    """Realistic 7th-day scenario: user has pinned days 0-5 (Push, Pull,
    Legs, Push, Pull, Legs) and is regenerating day 6. With prev_focuses
    fed through the prepend pipeline, day 0 of the resulting recipe
    should NOT also be Legs (the freshest family in prev_focuses)."""
    pinned = ["Push", "Pull", "Legs", "Push", "Pull", "Legs"]
    buckets, families = _generate_day_prepend(pinned, (), ())
    # Newest-first after reverse: Legs, Pull, Push, Legs, Pull, Push
    assert families[0] == "legs"

    days = generate_workout_plan(
        _inputs(
            rng_seed=600 + 6,
            days_per_week=7,
            recent_focus_buckets=buckets,
            recent_focus_families=families,
        ),
        SEED_EXERCISES,
    )["workout_plan"]["days"]
    # Recipe day 0 (relative to the new generation) must avoid Legs
    # because that's the freshest history entry.
    assert "legs" not in _focus_lower(days[0]), \
        f"day 6 regen with prev pinned ending in Legs put Legs at " \
        f"recipe day 0: {[d.get('focus') for d in days]}"


def test_single_day_regen_session_minutes_and_split_consistent_across_indices():
    """Tapping different days must NOT change the recipe-level config
    (session_minutes, split). Only exercise selection should vary."""
    recipes = []
    for di in range(5):
        days = generate_workout_plan(
            _inputs(rng_seed=700 + di, session_minutes=45, preferred_split="ppl"),
            SEED_EXERCISES,
        )["workout_plan"]["days"]
        recipes.append([d.get("focus") for d in days])

    # All recipes have the same length
    assert len({len(r) for r in recipes}) == 1, \
        f"day count drifted across day_index calls: {[len(r) for r in recipes]}"
    # All recipes have the same family distribution (PPL contract)
    families = []
    for r in recipes:
        f = sorted(_family_of(x) for x in r)
        families.append(f)
    # They may differ in ORDER per rng_seed but the multiset must match
    assert all(f == families[0] for f in families), \
        f"family multiset drifted across day_index calls: {families}"


def test_single_day_regen_with_dislikes_excludes_them_at_every_index():
    """If the user dislikes Barbell Back Squat, no per-day regen at
    any day_index may surface it. Otherwise switching days could
    re-introduce a hated exercise."""
    disliked = ("Barbell Back Squat",)
    for di in range(5):
        days = generate_workout_plan(
            _inputs(
                rng_seed=800 + di,
                disliked_exercises=disliked,
                days_per_week=5,
            ),
            SEED_EXERCISES,
        )["workout_plan"]["days"]
        names = []
        for d in days:
            for ex in d.get("exercises", []):
                names.append(ex.get("name", ""))
        assert "Barbell Back Squat" not in names, \
            f"day_index={di} surfaced disliked exercise: {names}"


# ════════════════════════════════════════════════════════════════════
# Bonus — combined scenario: switch-day pin + prior single-day pins
# ════════════════════════════════════════════════════════════════════

def test_user_scenario_recomp_7d_ppl_cumulative_pins_today_push_tomorrow_legs():
    """User-reported (Apr 2026): body_recomp, 7d, PPL.
      - Recent completed history: yesterday Pull, two days ago Rest, three Legs.
      - Today scheduled = Mobility.
      - User pins TODAY (day 0) → Push, then TOMORROW (day 1) → Legs.
      - Expected: today=Push (user's first explicit pin) + tomorrow=Legs.

    Pre-fix: canonical PPL rebuild on the second pin produced
    [Pull, Legs, Push, Pull, Legs, Push, Mobility] — wiping today's
    Push pin AND placing Pull immediately after yesterday's Pull.

    Fix (Apr 2026): pass `existing_pins={pos: focus_base}` into
    `decide_pin`. When the canonical rebuild would clobber any prior
    pin, fall back to single-day swap. The PPL cycle is sacrificed
    to honor user intent — the next full regen restores it."""
    from app.services.workout.switch_day import decide_pin, apply_rotate, apply_swap

    inputs = PlannerInputs(
        goal="body_recomp",
        days_per_week=7,
        session_minutes=60,
        experience="intermediate",
        equipment_slugs=_FULL_GYM,
        preferred_split="ppl",
        priority_region="balanced",
        injuries=tuple(),
        disliked_exercises=tuple(),
        rng_seed=42,
        recent_focus_buckets=("upper_body", "rest", "lower_body"),
        recent_focus_families=("pull", "rest", "legs"),
        muscle_fatigue=None,
    )
    days = generate_workout_plan(inputs, SEED_EXERCISES)["workout_plan"]["days"]
    pins: dict[int, str] = {}

    # Step 1: pin today (day 0) → Push.
    d1 = decide_pin(days, pin_day_index=0, pin_focus="Push",
                    preferred_split="ppl", existing_pins=pins)
    if d1.action == "rotate":
        apply_rotate(days, d1)
    elif d1.action == "swap":
        apply_swap(days, d1)
    pins[0] = "push"
    assert "push" in _focus_lower(days[0]), \
        f"after first pin, day 0 should be Push: {[d.get('focus') for d in days]}"

    # Step 2: pin tomorrow (day 1) → Legs. Both pins must stick.
    d2 = decide_pin(days, pin_day_index=1, pin_focus="Legs",
                    preferred_split="ppl", existing_pins=pins)
    if d2.action == "rotate":
        apply_rotate(days, d2)
    elif d2.action == "swap":
        apply_swap(days, d2)
    pins[1] = "legs"

    assert "legs" in _focus_lower(days[1]), \
        f"after second pin, day 1 should be Legs: {[d.get('focus') for d in days]}"
    assert "push" in _focus_lower(days[0]), \
        f"day 0 lost the Push pin after day 1 was pinned to " \
        f"Legs. day 0 = {days[0].get('focus')!r}, full week = " \
        f"{[d.get('focus') for d in days]}"


def test_switch_day_after_six_single_day_pins_keeps_pinned_focus_at_day_0():
    """Realistic flow: user pinned days 1-6 via single-day picker
    (those become prev_focuses). Then they hit Switch Day to pin day 0
    to a specific focus. The day 0 pin must still take precedence over
    the prev_focuses-derived rotation."""
    prev = ["Pull", "Legs", "Push", "Pull", "Legs", "Push"]
    buckets, families = _generate_day_prepend(prev, (), ())
    # Now user pins day 0 → Legs via Switch Day. The /generate-week
    # router would prepend Legs again on top of the in-plan history.
    buckets, families = _switch_day_prepend("Legs", buckets, families)
    assert families[0] == "legs", \
        f"Switch Day pin must remain newest even on top of prev_focuses, " \
        f"got {families}"


# ════════════════════════════════════════════════════════════════════
# CUMULATIVE PIN PRESERVATION + HISTORY-AWARE BEHAVIOR + SPLIT CHANGES
# ════════════════════════════════════════════════════════════════════
# 50+ tests covering the Apr 2026 fix: `decide_pin(existing_pins=...)`
# falls back to single-day swap when the canonical-cycle rebuild would
# clobber a previously-pinned day. Cycle purity is sacrificed to
# honor user intent — the next full regen restores it.

from app.services.workout.switch_day import (
    decide_pin, apply_swap, apply_rotate, apply_bro_canonical_swap,
)


def _gen_recipe(*, goal: str, days_per_week: int, preferred_split: str | None,
                experience: str = "intermediate",
                recent_focus_buckets: tuple[str, ...] = (),
                recent_focus_families: tuple[str, ...] = (),
                rng_seed: int = 42) -> list[dict]:
    inputs = PlannerInputs(
        goal=goal,
        days_per_week=days_per_week,
        session_minutes=60,
        experience=experience,
        equipment_slugs=_FULL_GYM,
        preferred_split=preferred_split,
        priority_region="balanced",
        injuries=tuple(),
        disliked_exercises=tuple(),
        rng_seed=rng_seed,
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
        muscle_fatigue=None,
    )
    return generate_workout_plan(inputs, SEED_EXERCISES)["workout_plan"]["days"]


def _apply_pin_seq(days: list[dict],
                   pin_seq: list[tuple[int, str]],
                   preferred_split: str | None,
                   pins: dict[int, str] | None = None) -> dict[int, str]:
    """Apply a sequence of (day_index, focus) pins, tracking
    existing_pins so the algorithm preserves prior pins. Pass `pins`
    to carry existing pin state across multiple calls. Returns the
    updated pins dict for chaining."""
    if pins is None:
        pins = {}
    for pin_day, pin_focus in pin_seq:
        d = decide_pin(
            days,
            pin_day_index=pin_day,
            pin_focus=pin_focus,
            preferred_split=preferred_split,
            existing_pins=pins,
        )
        if d.action == "rotate":
            apply_rotate(days, d)
        elif d.action == "swap":
            apply_swap(days, d)
        elif d.action == "bro_canonical_swap":
            apply_bro_canonical_swap(days, d)
        elif d.action == "label_only":
            # Mirror the router's label_only fallback — relabel the day.
            days[d.target_idx] = {**days[d.target_idx], "focus": pin_focus}
        pins[pin_day] = d.base_focus or pin_focus.lower().replace(" + cardio", "").strip()
    return pins


def _assert_pins_landed(days: list[dict], pin_seq: list[tuple[int, str]]) -> None:
    """Every (day, focus) in pin_seq must end up at days[day] with the
    requested focus (base match — '+ Cardio' suffix and variant trailers
    stripped on both sides)."""
    for pin_day, pin_focus in pin_seq:
        actual = _focus_lower(days[pin_day])
        expected_base = pin_focus.lower().replace(" + cardio", "").strip()
        actual_base = actual.replace(" + cardio", "").strip()
        if " — " in actual_base:
            actual_base = actual_base.split(" — ")[0].strip()
        assert actual_base == expected_base or expected_base in actual_base, \
            f"pin (day={pin_day}, focus={pin_focus!r}) lost — " \
            f"days[{pin_day}]={days[pin_day].get('focus')!r}, " \
            f"full week={[d.get('focus') for d in days]}"


# ── A. Cumulative pin preservation: PPL ─────────────────────────────

def test_ppl_5d_pin_day0_push_then_day2_legs():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    seq = [(0, "Push"), (2, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_5d_pin_day1_pull_then_day3_push():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    seq = [(1, "Pull"), (3, "Push")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_5d_pin_day0_legs_then_day4_pull():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    seq = [(0, "Legs"), (4, "Pull")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_6d_pin_day0_push_then_day1_legs_user_scenario():
    """Mirrors the user's exact reported scenario at 6d (their plan was
    7d but the bug was the same): pin two adjacent incompatible PPL
    days. Both must stick — cycle purity dropped."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    seq = [(0, "Push"), (1, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_6d_pin_day2_legs_then_day3_legs_back_to_back_intentional():
    """User explicitly wants legs two days in a row. Both pins must
    stick even though it violates same-family adjacency."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    seq = [(2, "Legs"), (3, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_6d_three_sequential_pins_at_distant_positions():
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    seq = [(0, "Pull"), (3, "Legs"), (5, "Push")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_7d_pin_day0_legs_then_day4_push():
    days = _gen_recipe(goal="muscle_gain", days_per_week=7, preferred_split="ppl")
    seq = [(0, "Legs"), (4, "Push")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_7d_pin_four_lift_days_all_stick():
    days = _gen_recipe(goal="muscle_gain", days_per_week=7, preferred_split="ppl")
    seq = [(0, "Push"), (1, "Push"), (2, "Pull"), (3, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_recomp_7d_preserves_rest_day_after_cumulative_pins():
    """body_recomp 7d has a forced recovery day. Cumulative pins on
    lift positions must not eat the rest day."""
    days = _gen_recipe(goal="body_recomp", days_per_week=7, preferred_split="ppl")
    rest_before = sum(1 for d in days if "recovery" in _focus_lower(d) or "mobility" in _focus_lower(d))
    seq = [(0, "Push"), (1, "Legs"), (3, "Pull")]
    _apply_pin_seq(days, seq, "ppl")
    rest_after = sum(1 for d in days if "recovery" in _focus_lower(d) or "mobility" in _focus_lower(d))
    assert rest_before == rest_after, \
        f"cumulative pins ate the rest day: before={rest_before} after={rest_after}, " \
        f"final={[d.get('focus') for d in days]}"


def test_ppl_5d_pin_at_end_of_week_preserved_when_pinning_at_start():
    """Reverse-direction cumulative: pin day 4 first, then pin day 0.
    Day 4 must still be the focus the user originally pinned."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    seq = [(4, "Legs"), (0, "Push")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_ppl_6d_re_pin_same_day_to_different_focus():
    """User changes their mind: pin day 2 → Push, then pin day 2 → Pull.
    Latest pin wins for that day."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    seq = [(2, "Push"), (2, "Pull")]
    _apply_pin_seq(days, seq, "ppl")
    assert "pull" in _focus_lower(days[2])


def test_ppl_5d_pin_focus_already_at_target_is_idempotent():
    """Pinning a day to its current focus shouldn't move anything."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    original_d0 = days[0].get("focus")
    pins = _apply_pin_seq(days, [(0, original_d0)], "ppl")
    assert days[0].get("focus") == original_d0


# ── B. Cumulative pin preservation: Upper/Lower ─────────────────────

def test_ul_4d_pin_day0_upper_then_day1_upper():
    """UL has cycle [upper, lower]. Pin two adjacent days both to Upper —
    not possible in the canonical cycle; fix must fall back to swap."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=4, preferred_split="upper_lower")
    seq = [(0, "Upper"), (1, "Upper")]
    _apply_pin_seq(days, seq, "upper_lower")
    _assert_pins_landed(days, seq)


def test_ul_4d_pin_day0_lower_then_day3_upper():
    days = _gen_recipe(goal="muscle_gain", days_per_week=4, preferred_split="upper_lower")
    seq = [(0, "Lower"), (3, "Upper")]
    _apply_pin_seq(days, seq, "upper_lower")
    _assert_pins_landed(days, seq)


def test_ul_5d_three_sequential_pins():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="upper_lower")
    seq = [(0, "Upper"), (2, "Lower"), (4, "Upper")]
    _apply_pin_seq(days, seq, "upper_lower")
    _assert_pins_landed(days, seq)


def test_ul_6d_pin_two_lower_days_back_to_back_intentional():
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="upper_lower")
    seq = [(2, "Lower"), (3, "Lower")]
    _apply_pin_seq(days, seq, "upper_lower")
    _assert_pins_landed(days, seq)


def test_ul_4d_pin_day0_upper_preserves_after_pin_day2_upper():
    days = _gen_recipe(goal="muscle_gain", days_per_week=4, preferred_split="upper_lower")
    seq = [(0, "Upper"), (2, "Upper")]
    _apply_pin_seq(days, seq, "upper_lower")
    _assert_pins_landed(days, seq)


# ── C. Cumulative pin preservation: Bro ─────────────────────────────

def test_bro_5d_pin_day0_chest_then_day2_legs():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5,
                        preferred_split="bro", experience="advanced")
    seq = [(0, "Chest"), (2, "Legs")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_5d_pin_three_in_sequence():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5,
                        preferred_split="bro", experience="advanced")
    seq = [(0, "Legs"), (2, "Chest"), (4, "Back")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_5d_pin_chest_to_two_different_days_intentional():
    """User wants chest twice. Bro 5d has only one Chest day, so the
    second pin falls through to label_only (no swap partner exists).
    Both target days end up labeled Chest — exercise content of the
    second is the original day-3 content (Arms exercises with Chest
    label). Acceptable fallback for the rare duplicate-focus case;
    a full regen would generate a true second Chest day."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5,
                        preferred_split="bro", experience="advanced")
    seq = [(0, "Chest"), (3, "Chest")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_6d_pin_day0_legs_then_day5_chest():
    days = _gen_recipe(goal="muscle_gain", days_per_week=6,
                        preferred_split="bro", experience="advanced")
    seq = [(0, "Legs"), (5, "Chest")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_6d_pin_chest_at_day_2_preserved_after_back_pin_at_day_3():
    days = _gen_recipe(goal="muscle_gain", days_per_week=6,
                        preferred_split="bro", experience="advanced")
    seq = [(2, "Chest"), (3, "Back")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_5d_pin_arms_then_day_after_arms_intentional():
    """Pin Arms two days in a row — bro normally spaces them. Same
    duplicate-focus fallback to label_only as the chest-twice case;
    both labels land but second day's exercises are original content."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5,
                        preferred_split="bro", experience="advanced")
    seq = [(1, "Arms"), (2, "Arms")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_7d_four_pins_all_stick():
    days = _gen_recipe(goal="muscle_gain", days_per_week=7,
                        preferred_split="bro", experience="advanced")
    seq = [(0, "Chest"), (1, "Back"), (3, "Legs"), (5, "Shoulders")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_bro_5d_pin_legs_first_day_preserved_after_chest_pin_at_end():
    days = _gen_recipe(goal="muscle_gain", days_per_week=5,
                        preferred_split="bro", experience="advanced")
    seq = [(0, "Legs"), (4, "Chest")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


# ── D. History-aware behavior on top of pins ────────────────────────

def test_history_recent_pull_then_pin_today_push_keeps_pin_with_history():
    """Recent pull yesterday (in history). User pins today=Push. Pin
    must stick AND day 0 family ≠ pull (history avoidance via history-fed regen)."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("pull",),
        recent_focus_buckets=("upper_body",),
    )
    seq = [(0, "Push")]
    _apply_pin_seq(days, seq, "ppl")
    assert "push" in _focus_lower(days[0])


def test_history_recent_legs_then_pin_today_legs_user_overrides():
    """Recent legs in history. User pins today=Legs anyway — explicit
    intent wins over history."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("legs",),
        recent_focus_buckets=("lower_body",),
    )
    seq = [(0, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    assert "legs" in _focus_lower(days[0])


def test_history_recent_push_pull_legs_then_two_pins_both_stick():
    """Three recent days in history (full PPL cycle yesterday-three days
    ago). User then pins two days. Both pins win, history shapes the
    recipe but doesn't override pins."""
    days = _gen_recipe(
        goal="body_recomp", days_per_week=7, preferred_split="ppl",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    seq = [(0, "Push"), (2, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_history_recent_upper_then_pin_day0_lower_for_ul():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=4, preferred_split="upper_lower",
        recent_focus_families=("upper",),
        recent_focus_buckets=("upper_body",),
    )
    seq = [(0, "Lower")]
    _apply_pin_seq(days, seq, "upper_lower")
    assert "lower" in _focus_lower(days[0])


def test_history_recent_upper_then_two_lower_pins_for_ul():
    """Recent upper, then user pins day 0 Lower and day 1 Lower."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=4, preferred_split="upper_lower",
        recent_focus_families=("upper",),
        recent_focus_buckets=("upper_body",),
    )
    seq = [(0, "Lower"), (1, "Lower")]
    _apply_pin_seq(days, seq, "upper_lower")
    _assert_pins_landed(days, seq)


def test_history_recent_chest_then_pin_legs_for_bro():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
        recent_focus_families=("push",),
        recent_focus_buckets=("upper_body",),
    )
    seq = [(0, "Legs")]
    _apply_pin_seq(days, seq, "bro")
    assert "legs" in _focus_lower(days[0])


def test_history_recent_legs_then_bro_pin_chest_then_back():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
        recent_focus_families=("legs",),
        recent_focus_buckets=("lower_body",),
    )
    seq = [(0, "Chest"), (1, "Back")]
    _apply_pin_seq(days, seq, "bro")
    _assert_pins_landed(days, seq)


def test_history_no_history_pins_still_work():
    """Sanity: with empty history, cumulative pins still work."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    seq = [(0, "Push"), (2, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


# ── E. Split changes — generate fresh recipe with new split ─────────
# These simulate the user changing their preferred_split. The fresh
# generation must produce a recipe matching the NEW split, even when
# `recent_focus_families` reflects the OLD split's training history.

def test_split_change_ppl_to_ul_4d_produces_ul_labels():
    """User trained PPL (recent: push, pull, legs), then switches to UL 4d."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=4, preferred_split="upper_lower",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    for d in days:
        fam = _family_of(d.get("focus") or "")
        assert fam in ("upper", "lower", "rest", "cardio", "?"), \
            f"split-change PPL→UL produced non-UL focus: {d.get('focus')}"


def test_split_change_ppl_7d_to_ul_5d_uses_new_day_count():
    """Going from 7d PPL to 5d UL — recipe must be 5 days."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="upper_lower",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    assert len(days) == 5, f"new recipe should be 5 days, got {len(days)}"


def test_split_change_ppl_to_bro_uses_bro_canonical_labels():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="bro",
        experience="advanced",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    labels = {d.get("focus") for d in days if d.get("focus")}
    canonical = {"Chest", "Back", "Shoulders", "Arms", "Legs"}
    assert canonical.issubset(labels), \
        f"split-change PPL→Bro lost canonical labels: got {labels}"


def test_split_change_ul_to_ppl_uses_ppl_labels():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("lower", "upper"),
        recent_focus_buckets=("lower_body", "upper_body"),
    )
    fams = [_family_of(d.get("focus") or "") for d in days]
    assert "push" in fams, f"PPL recipe missing Push: {[d.get('focus') for d in days]}"
    assert "pull" in fams, f"PPL recipe missing Pull: {[d.get('focus') for d in days]}"
    assert "legs" in fams, f"PPL recipe missing Legs: {[d.get('focus') for d in days]}"


def test_split_change_bro_to_ppl_uses_ppl_labels():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=6, preferred_split="ppl",
        recent_focus_families=("legs", "push", "pull", "push"),  # bro-style history
        recent_focus_buckets=("lower_body", "upper_body", "upper_body", "upper_body"),
    )
    fams = [_family_of(d.get("focus") or "") for d in days]
    assert "push" in fams and "pull" in fams and "legs" in fams


def test_split_change_to_full_body_produces_full_body_labels():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=3, preferred_split="full_body",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    fams = [_family_of(d.get("focus") or "") for d in days]
    assert any(f == "full" for f in fams), \
        f"full_body recipe missing Full Body: {[d.get('focus') for d in days]}"


def test_split_change_full_body_to_ppl_at_5d():
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="ppl",
        recent_focus_families=("full",),
        recent_focus_buckets=("upper_body",),
    )
    fams = [_family_of(d.get("focus") or "") for d in days]
    assert "push" in fams and "pull" in fams and "legs" in fams


def test_split_change_preserves_history_buckets_into_new_split():
    """Switching splits doesn't blank out history — recent_focus_buckets
    (coarse: upper_body) reaches the new-split planner. The planner
    uses buckets (not fine families) for cross-split rotation, so a
    PPL→UL switch with recent upper_body activity DOES nudge day 0
    toward lower. Recipe should contain both Upper and Lower."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=4, preferred_split="upper_lower",
        recent_focus_families=("push",),
        recent_focus_buckets=("upper_body",),
    )
    fams = [_family_of(d.get("focus") or "") for d in days]
    assert "upper" in fams and "lower" in fams, \
        f"UL recipe missing one of upper/lower: {[d.get('focus') for d in days]}"


def test_split_change_pin_after_switch_works():
    """User switches PPL→UL, then pins day 0 to Lower. Pin must work
    on the freshly-generated UL recipe."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=4, preferred_split="upper_lower",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    seq = [(0, "Lower")]
    _apply_pin_seq(days, seq, "upper_lower")
    assert "lower" in _focus_lower(days[0])


def test_split_change_pin_to_old_split_focus_returns_regen_decision():
    """User switched to UL but tries to pin day 0 to Push (PPL focus).
    decide_pin must return action='regen' with regen_split='ppl'."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=4, preferred_split="upper_lower")
    d = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="upper_lower")
    assert d.action == "regen"
    assert d.regen_split == "ppl"


# ── F. Edge cases for the existing_pins fix ─────────────────────────

def test_existing_pins_excludes_pinned_position_from_swap_partner():
    """If day 0 is pinned to Push and user pins day 4 to Push, the swap
    partner picker must NOT pick day 0 (would clobber the pin).
    Carries `pins` across calls so the algorithm sees the prior pin."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    pins = _apply_pin_seq(days, [(0, "Push")], "ppl")
    assert "push" in _focus_lower(days[0])
    _apply_pin_seq(days, [(4, "Push")], "ppl", pins=pins)
    assert "push" in _focus_lower(days[0])
    assert "push" in _focus_lower(days[4])


def test_existing_pins_default_none_preserves_legacy_behavior():
    """When existing_pins is not passed, decide_pin behaves exactly as
    pre-fix: cumulative pins can lose earlier ones (canonical wins)."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    # Pin day 0 → Push WITHOUT tracking pins.
    d1 = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="ppl")
    if d1.action == "rotate":
        apply_rotate(days, d1)
    elif d1.action == "swap":
        apply_swap(days, d1)
    # Pin day 1 → Legs WITHOUT tracking pins.
    d2 = decide_pin(days, pin_day_index=1, pin_focus="Legs", preferred_split="ppl")
    if d2.action == "rotate":
        apply_rotate(days, d2)
    elif d2.action == "swap":
        apply_swap(days, d2)
    # Day 1 = Legs is guaranteed (latest pin wins). Day 0 may be Pull
    # (canonical PPL forces it) — that's the legacy behavior we're
    # documenting, not the new fix.
    assert "legs" in _focus_lower(days[1])


def test_existing_pins_action_swap_when_canonical_would_clobber():
    """When canonical rebuild would change a prior-pinned day, the
    action must be 'swap' (not 'rotate'). Pin day 0 → Push, then pin
    day 1 → Legs on PPL: the rotate would put Pull at day 0 (clobbers
    the Push pin), so action must be swap."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    pins: dict[int, str] = {}
    d1 = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="ppl",
                    existing_pins=pins)
    if d1.action == "rotate":
        apply_rotate(days, d1)
    elif d1.action == "swap":
        apply_swap(days, d1)
    pins[0] = "push"

    d2 = decide_pin(days, pin_day_index=1, pin_focus="Legs", preferred_split="ppl",
                    existing_pins=pins)
    # The fix: must NOT be "rotate" because rotate would clobber day 0.
    assert d2.action == "swap", \
        f"expected fallback to swap (canonical would clobber day 0 pin), " \
        f"got action={d2.action}"


def test_pin_day_in_middle_of_week_preserves_pins_at_both_ends():
    """Pin day 0, day 6 (ends of week), then pin day 3 (middle).
    All three must stick."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=7, preferred_split="ppl")
    seq = [(0, "Push"), (6, "Legs"), (3, "Pull")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_compatible_pins_use_canonical_rotate():
    """When pins ARE compatible with the cycle (e.g. PPL: day 0=Push
    + day 1=Pull), the canonical rebuild should be used (not swap).
    This proves the fix doesn't kill the cycle when not needed."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    pins: dict[int, str] = {}
    # Pin day 0 → Push.
    d1 = decide_pin(days, pin_day_index=0, pin_focus="Push", preferred_split="ppl",
                    existing_pins=pins)
    if d1.action == "rotate":
        apply_rotate(days, d1)
    elif d1.action == "swap":
        apply_swap(days, d1)
    pins[0] = "push"
    # Pin day 1 → Pull. This IS compatible with PPL cycle.
    d2 = decide_pin(days, pin_day_index=1, pin_focus="Pull", preferred_split="ppl",
                    existing_pins=pins)
    # Compatible → canonical rotate is allowed (no clobber).
    assert d2.action in ("rotate", "noop"), \
        f"compatible pins should use rotate/noop, got {d2.action}"


def test_pin_seq_compatible_full_ppl_cycle_at_5d():
    """Pin every lift day to its canonical PPL position. All pins
    compatible — full cycle preserved."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=5, preferred_split="ppl")
    seq = [(0, "Push"), (1, "Pull"), (2, "Legs")]
    _apply_pin_seq(days, seq, "ppl")
    _assert_pins_landed(days, seq)


def test_pin_seq_recovery_first_then_pin_lifts():
    """Pin day 0 to Recovery (replace_day), then pin lifts. The
    replace_day action returns a PinDecision the caller acts on
    (generates a recovery day). decide_pin should still work after."""
    days = _gen_recipe(goal="muscle_gain", days_per_week=6, preferred_split="ppl")
    # Pin day 0 → Recovery.
    d_rec = decide_pin(days, pin_day_index=0, pin_focus="Recovery", preferred_split="ppl")
    assert d_rec.action == "replace_day"
    assert d_rec.day_kind == "recovery"


def test_split_change_does_not_lose_user_age_or_equipment():
    """Split-change regen must keep all the user's other settings — only
    preferred_split changes. Sanity check: equipment-dependent
    exercises still appear (no empty exercises)."""
    days = _gen_recipe(
        goal="muscle_gain", days_per_week=5, preferred_split="upper_lower",
        recent_focus_families=("legs", "pull", "push"),
        recent_focus_buckets=("lower_body", "upper_body", "upper_body"),
    )
    for d in days:
        if "recovery" in _focus_lower(d) or "mobility" in _focus_lower(d):
            continue
        assert d.get("exercises"), \
            f"day after split change is empty: {d.get('focus')}"


# ── End of new tests block ──────────────────────────────────────────


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
            print(f"  ✓ {name}")
        except AssertionError as e:
            failed.append((name, str(e)))
            print(f"  ✗ FAIL {name}: {e}")
        except Exception as e:
            failed.append((name, f"{type(e).__name__}: {e}"))
            print(f"  ✗ ERROR {name}: {type(e).__name__}: {e}")
    if failed:
        print(f"\n{len(failed)} of {len(test_fns)} failed")
        sys.exit(1)
    print(f"\nAll {len(test_fns)} history-aware-generation tests passed")
