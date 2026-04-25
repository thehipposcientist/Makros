"""Shared assertions for workout-recipe contracts.

Every generation test (matrix sweep, history-seeded, single-day regen,
Switch Day integration) calls these so a single source of truth defines
"what does a valid plan look like for this (split, goal, days)".

Three contract layers:
  1. Structural   — day count, every lift day has exercises, no
                    recovery/mobility at week start.
  2. Split        — lift family distribution matches the split's
                    canonical pattern.
  3. Goal/cardio  — cardio + recovery counts match the goal's profile
                    at this day count.

Loose where the planner intentionally has freedom (e.g. cardio kind
on fat_loss can vary), strict where regressions would harm the user
(bro stays canonical, every lift day has exercises).
"""
from __future__ import annotations

from typing import Iterable


# ── Vocabulary ──────────────────────────────────────────────────────

NON_LIFTING_FOCUSES = frozenset({
    "mobility", "recovery", "active recovery", "stretching",
    "cardio", "conditioning", "mobility_flow", "recovery_easy",
    "easy recovery", "easy movement",
})

CARDIO_KEYWORDS = (
    "cardio", "intervals", "tempo", "zone 2", "circuit",
    "steady", "mixed", "+ cardio",
)

REST_KEYWORDS = ("recovery", "mobility", "stretch", "rest")


def _focus(d: dict) -> str:
    return (d.get("focus") or "").lower().strip()


def is_lift(focus: str) -> bool:
    """A lift focus is anything that isn't a recovery, mobility, or
    cardio-dominant day. PLUS_CARDIO hybrids count as lift (the spine
    is lifting; the cardio is just a finisher)."""
    f = focus.lower().strip()
    if f in NON_LIFTING_FOCUSES:
        return False
    # Cardio-dominant labels: contain cardio/intervals/tempo/zone/etc.
    # but NOT "+ cardio" (which is a lift+finisher hybrid).
    if "+ cardio" in f:
        return True
    if any(kw in f for kw in CARDIO_KEYWORDS):
        return False
    if any(kw in f for kw in REST_KEYWORDS):
        return False
    return True


def is_cardio_dominant(focus: str) -> bool:
    """A cardio-DOMINANT day — pure cardio, intervals, tempo, etc.
    A LIFT_*_PLUS_CARDIO is NOT cardio-dominant; it's a lift day with
    a finisher attached."""
    f = focus.lower().strip()
    if "+ cardio" in f:
        return False  # hybrid lift, not pure cardio
    return any(kw in f for kw in CARDIO_KEYWORDS)


def is_rest(focus: str) -> bool:
    f = focus.lower().strip()
    return any(kw in f for kw in REST_KEYWORDS) and "easy recovery" not in f or f in ("easy recovery", "easy movement", "recovery", "mobility")


def is_plus_cardio_lift(focus: str) -> bool:
    f = focus.lower().strip()
    return "+ cardio" in f


def lift_focuses(days: list[dict]) -> list[str]:
    return [_focus(d) for d in days if is_lift(_focus(d))]


def cardio_dominant_count(days: list[dict]) -> int:
    return sum(1 for d in days if is_cardio_dominant(_focus(d)))


def plus_cardio_count(days: list[dict]) -> int:
    return sum(1 for d in days if is_plus_cardio_lift(_focus(d)))


def rest_count(days: list[dict]) -> int:
    return sum(1 for d in days if is_rest(_focus(d)))


def family_of(focus: str) -> str:
    """Map a focus label to a coarse lift family. Mirrors what the
    planner's archetype_to_focus_family does, but reads off labels so
    tests stay independent of internal enums."""
    f = focus.lower().strip()
    f = f.replace(" + cardio", "").strip()
    # Strip trailing variant suffixes like " — Heavy" / " — Hypertrophy"
    if " — " in f:
        f = f.split(" — ")[0].strip()
    if "chest" in f:
        return "chest"
    if "back" in f:
        return "back"
    if "shoulders" in f or "shoulder" in f:
        return "shoulders"
    if "arms" in f or "arm" in f:
        return "arms"
    if "full body" in f or "full_body" in f:
        return "full_body"
    if "push" in f:
        return "push"
    if "pull" in f:
        return "pull"
    if "legs" in f or "leg " in f:
        return "legs"
    if "upper" in f:
        return "upper"
    if "lower" in f:
        return "lower"
    return "?"


def family_counts(days: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for d in days:
        if not is_lift(_focus(d)):
            continue
        fam = family_of(_focus(d))
        out[fam] = out.get(fam, 0) + 1
    return out


# ── Layer 1: Structural ─────────────────────────────────────────────

def assert_day_count(recipe: list[dict], days_per_week: int, ctx: str = "") -> None:
    assert len(recipe) == days_per_week, \
        f"{ctx}: expected {days_per_week} days, got {len(recipe)}: " \
        f"{[_focus(d) for d in recipe]}"


def assert_every_lift_day_has_exercises(recipe: list[dict], ctx: str = "") -> None:
    for i, d in enumerate(recipe):
        if not is_lift(_focus(d)):
            continue
        exs = d.get("exercises") or []
        assert exs, \
            f"{ctx}: lift day {i} ('{d.get('focus')}') has no exercises: {recipe}"


def assert_no_rest_at_week_start(recipe: list[dict], ctx: str = "") -> None:
    """Recovery/mobility days belong at end-of-week per the placement
    rules. Day 0 should never be rest if the user has any lift days."""
    has_lift = any(is_lift(_focus(d)) for d in recipe)
    if not has_lift:
        return
    f0 = _focus(recipe[0])
    assert not (("recovery" in f0 or "mobility" in f0) and "easy" not in f0), \
        f"{ctx}: day 0 should not be rest, got '{recipe[0].get('focus')}'"


def assert_seven_day_plan_has_rest(recipe: list[dict], days_per_week: int, ctx: str = "") -> None:
    """7-day plans force at least 1 recovery/mobility day per CLAUDE.md."""
    if days_per_week < 7:
        return
    has_rest = any(
        ("recovery" in _focus(d) or "mobility" in _focus(d))
        for d in recipe
    )
    assert has_rest, \
        f"{ctx}: 7-day plan missing recovery: {[_focus(d) for d in recipe]}"


# ── Layer 2: Split distribution ─────────────────────────────────────

def assert_ppl_distribution(recipe: list[dict], days_per_week: int, *,
                             goal: str = "", ctx: str = "") -> None:
    """PPL distribution is keyed on LIFT count, not days_per_week. The
    planner reserves cardio/recovery slots, so a 6-day plan may have
    only 5 or 4 lift days. The PPL contract:

      - Each of {push, pull, legs} appears at least once when there
        are ≥3 lift days.
      - 3 lifts → 1/1/1 exactly.
      - 6 lifts → 2/2/2 exactly.
      - Other lift counts: no family more than ⌈n/3⌉+1, and the
        difference between max and min families is ≤2 (catches
        2/0/2-style imbalances).
    """
    counts = family_counts(recipe)
    push, pull, legs = counts.get("push", 0), counts.get("pull", 0), counts.get("legs", 0)
    total_lifts = push + pull + legs
    if total_lifts < 3:
        return  # too few lifts to assess split balance (e.g. 2-day plan)
    if total_lifts == 3:
        assert push == 1 and pull == 1 and legs == 1, \
            f"{ctx}: PPL 3 lifts should be 1/1/1, got {push}/{pull}/{legs}"
        return
    if total_lifts == 6:
        assert push == 2 and pull == 2 and legs == 2, \
            f"{ctx}: PPL 6 lifts should be 2/2/2, got {push}/{pull}/{legs}"
        return
    # 4-5 lifts, 7+ lifts: balance bounds.
    assert push >= 1 and pull >= 1 and legs >= 1, \
        f"{ctx}: PPL {total_lifts} lifts missing a family: {push}/{pull}/{legs}"
    cap = (total_lifts + 2) // 3 + 1  # ceil(n/3) + 1
    for fam, n in (("push", push), ("pull", pull), ("legs", legs)):
        assert n <= cap, \
            f"{ctx}: PPL {total_lifts} lifts has too many {fam}: {n} > cap {cap} " \
            f"({push}/{pull}/{legs})"


def assert_upper_lower_distribution(recipe: list[dict], days_per_week: int, *,
                                      ctx: str = "") -> None:
    """U/L distribution keyed on LIFT count (not days). 2-day plans
    that include 1 cardio + 1 lift legitimately have 1 lift only and
    are skipped. The forced-even-lifts rule (`weekly_recipe.py`) ensures
    even lift counts when possible; odd lifts ±1 is acceptable."""
    counts = family_counts(recipe)
    upper, lower = counts.get("upper", 0), counts.get("lower", 0)
    total = upper + lower
    if total < 2:
        return  # too few lift days to assess balance
    if total % 2 == 0:
        assert upper == lower, \
            f"{ctx}: U/L even ({total} lifts) should be balanced, got upper={upper} lower={lower}"
    else:
        assert abs(upper - lower) == 1, \
            f"{ctx}: U/L odd ({total} lifts) should be ±1, got upper={upper} lower={lower}"


def assert_full_body_distribution(recipe: list[dict], *, ctx: str = "") -> None:
    """Every LIFT day under SPLIT_FULL_BODY must be Full Body (or a
    Full Body — Strength / Full Body + Cardio variant). Cardio-dominant
    days (Zone 2 etc.) inserted by the goal profile are legitimate
    non-lift days and are allowed."""
    for d in recipe:
        if not is_lift(_focus(d)):
            continue
        if is_cardio_dominant(_focus(d)):
            # A pure cardio day inserted by the recipe (e.g. Zone 2)
            # isn't a lift day — skip the family check.
            continue
        f = family_of(_focus(d))
        assert f == "full_body", \
            f"{ctx}: full_body split has non-full-body lift: '{d.get('focus')}'"


def assert_bro_canonical(recipe: list[dict], days_per_week: int, *,
                          ctx: str = "", allow_rotation: bool = False) -> None:
    """Bro: lift days must follow the canonical Chest→Back→Shoulders→
    Arms→Legs cycle. No PLUS_CARDIO downgrade.

    `allow_rotation=False` (default) requires the cycle to START at
    Chest — used for fresh generation contracts.
    `allow_rotation=True` accepts any cyclic rotation of the canonical
    sequence — used for post-Switch-Day assertions where pinning
    legitimately rotates the cycle to start from a different focus.
    """
    bro_seq = ["Chest", "Back", "Shoulders", "Arms", "Legs"]
    lift_focuses_in_order = [
        d.get("focus") for d in recipe if is_lift(_focus(d))
    ]
    n = len(lift_focuses_in_order)
    if allow_rotation:
        # The full cycle is [Chest, Back, Shoulders, Arms, Legs]
        # repeated. After a pin, the recipe is a contiguous slice of
        # this cycle of length n starting at SOME position. Generate
        # all 5 valid starting positions and check the recipe matches
        # one of them.
        full_cycle = (bro_seq * ((n // 5) + 2))  # at least 2 full cycles
        valid_rotations = [full_cycle[start:start + n] for start in range(5)]
        assert lift_focuses_in_order in valid_rotations, \
            f"{ctx}: bro lift sequence not a canonical rotation: " \
            f"got {lift_focuses_in_order}, valid={valid_rotations}"
    else:
        expected = [bro_seq[i % 5] for i in range(n)]
        assert lift_focuses_in_order == expected, \
            f"{ctx}: bro lift sequence broken: got {lift_focuses_in_order}, " \
            f"expected {expected}"
    # No PLUS_CARDIO downgrade — applies regardless of rotation.
    for d in recipe:
        f = _focus(d)
        assert "+ cardio" not in f, \
            f"{ctx}: bro split must not contain PLUS_CARDIO: '{d.get('focus')}'"


def assert_ppl_ul_distribution(recipe: list[dict], days_per_week: int, *,
                                ctx: str = "") -> None:
    """PPL+UL: at 5 days each of {push, pull, legs, upper, lower}
    appears at least once. Extras follow the planner's pool rules
    (legs/pull/push) so accept ±1."""
    counts = family_counts(recipe)
    base_keys = ("push", "pull", "legs", "upper", "lower")
    if days_per_week >= 5:
        for k in base_keys:
            assert counts.get(k, 0) >= 1, \
                f"{ctx}: PPL+UL {days_per_week}d missing {k}: {counts}"


def assert_split_distribution(recipe: list[dict], split: str, days_per_week: int,
                                *, goal: str = "", ctx: str = "",
                                allow_bro_rotation: bool = False) -> None:
    """Dispatch on split id. `allow_bro_rotation=True` lets bro tests
    accept any cyclic rotation of the canonical sequence — set this
    after a Switch Day pin which legitimately rotates the cycle."""
    if split == "ppl":
        assert_ppl_distribution(recipe, days_per_week, goal=goal, ctx=ctx)
    elif split == "upper_lower":
        assert_upper_lower_distribution(recipe, days_per_week, ctx=ctx)
    elif split == "full_body":
        assert_full_body_distribution(recipe, ctx=ctx)
    elif split == "bro":
        assert_bro_canonical(recipe, days_per_week, ctx=ctx,
                              allow_rotation=allow_bro_rotation)
    elif split == "ppl_upper_lower":
        assert_ppl_ul_distribution(recipe, days_per_week, ctx=ctx)
    # lower_focused / upper_focused: ratio asserted in the test directly


# ── Layer 3: Goal / cardio alignment ───────────────────────────────

def expected_min_cardio(goal: str, days_per_week: int, split: str) -> int:
    """Minimum cardio component (PLUS_CARDIO + dedicated cardio days).

    Bands derived from the planner's own contracts:
      - `_DIRECT_PROMOTE_COUNT` (weekly_recipe.py:969)
      - `_lifting_plus_cardio_recipe` band thresholds (weekly_recipe.py:594)

    Failures here are REAL issues — the planner is under-delivering
    on cardio relative to the goal's documented spec. Don't relax to
    fit current behavior; fix the planner instead.

    Bro is exempt (hybrid promotion explicitly disabled for bro to
    preserve per-muscle labels).
    """
    if split == "bro":
        return 0
    g = goal.lower()
    d = days_per_week
    if g == "muscle_gain":
        # _DIRECT_PROMOTE_COUNT["muscle_gain"]: 3:0 4:1 5:1 6:1 7:2.
        return {3: 0, 4: 1, 5: 1, 6: 1, 7: 2}.get(d, 0)
    if g == "strength":
        # _DIRECT_PROMOTE_COUNT["strength"]: 3:0 4:0 5:1 6:1 7:1.
        return {3: 0, 4: 0, 5: 1, 6: 1, 7: 1}.get(d, 0)
    if g == "general_health":
        # _DIRECT_PROMOTE_COUNT["general_health"]: 3:1 4:2 5:2 6:2 7:2.
        return {3: 1, 4: 2, 5: 2, 6: 2, 7: 2}.get(d, 1)
    if g == "fat_loss":
        # fat_loss conditioning_frac >= 0.30: 1 cardio at 3-4d, 2 at
        # 5+d (cap 2). Plus PLUS_CARDIO from same-day promotion.
        if d <= 2: return 0
        if d <= 4: return 1
        return 2
    if g == "body_recomp":
        # body_recomp band 0.10-0.29: 0 at ≤3d, 1 at 4+d (cap 1).
        if d <= 3: return 0
        return 1
    if g == "endurance":
        return max(1, d - 1)
    if g == "athletic_performance":
        return 1 if d >= 3 else 0
    return 0


def total_cardio_component(days: list[dict]) -> int:
    """Cardio + PLUS_CARDIO. PLUS_CARDIO counts because the user gets
    a cardio finisher attached to a lift day, satisfying the goal's
    cardio target."""
    return cardio_dominant_count(days) + plus_cardio_count(days)


def assert_cardio_alignment(recipe: list[dict], goal: str, days_per_week: int,
                              split: str, *, ctx: str = "") -> None:
    expected_min = expected_min_cardio(goal, days_per_week, split)
    actual = total_cardio_component(recipe)
    assert actual >= expected_min, \
        f"{ctx}: {goal} {days_per_week}d split={split}: expected ≥{expected_min} " \
        f"cardio (incl PLUS_CARDIO), got {actual}: " \
        f"{[_focus(d) for d in recipe]}"


def assert_no_plus_cardio_on_bro(recipe: list[dict], split: str, *,
                                  ctx: str = "") -> None:
    """Bro split must not contain PLUS_CARDIO downgrade. This is the
    user-reported regression safety net."""
    if split != "bro":
        return
    for d in recipe:
        assert "+ cardio" not in _focus(d), \
            f"{ctx}: bro split has PLUS_CARDIO: '{d.get('focus')}'"


# ── Aggregate: assert everything ───────────────────────────────────

def assert_full_recipe_valid(
    recipe: list[dict],
    *,
    split: str,
    goal: str,
    days_per_week: int,
    ctx: str = "",
    check_cardio: bool = True,
) -> None:
    """Run every applicable contract. Use this in matrix sweeps so a
    single failed cell pinpoints exactly which contract broke.

    `check_cardio=False` skips the cardio-alignment check — useful for
    structural sweeps where you want a clean pass and want to flag
    cardio separately as a known-debt list.
    """
    assert_day_count(recipe, days_per_week, ctx=ctx)
    assert_every_lift_day_has_exercises(recipe, ctx=ctx)
    assert_no_rest_at_week_start(recipe, ctx=ctx)
    assert_seven_day_plan_has_rest(recipe, days_per_week, ctx=ctx)
    assert_split_distribution(recipe, split, days_per_week, goal=goal, ctx=ctx)
    if check_cardio:
        assert_cardio_alignment(recipe, goal, days_per_week, split, ctx=ctx)
    assert_no_plus_cardio_on_bro(recipe, split, ctx=ctx)
