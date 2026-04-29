"""Audit tests for workout goal handling.

Every user-facing goal in `GOAL_OPTIONS_DATA` must resolve through the
`goals` registry to a canonical planner bucket with genuinely distinct
behavior (split choice, prescription, or both). These tests exist so
the registry can't silently drift from the seeded goal list.

Run directly:  python3 -m tests.test_workout_goals
"""
from __future__ import annotations

import sys


def _ok(label: str) -> None:
    print(f"  ✓ {label}")


# ─── Registry sanity ─────────────────────────────────────────────────────────


def test_seeded_goals_are_all_in_registry() -> None:
    """The UI goal rows produced by `ui_goal_rows()` (which is what
    `seed.py` hands to the database) must match `supported_goal_ids()`
    exactly. This is the audit gate that keeps the two lists in sync."""
    print("\n[test] UI goal rows match supported registry ids")
    from app.services.workout.goals import (
        resolve_goal, supported_goal_ids, ui_goal_rows,
    )
    ui_ids = {row[0] for row in ui_goal_rows()}
    supported = set(supported_goal_ids())
    assert ui_ids == supported, f"drift: ui={ui_ids}  supported={supported}"
    for gid in ui_ids:
        d = resolve_goal(gid)
        assert d.user_id == gid, f"{gid} resolved to {d.user_id}"
    _ok(f"{len(ui_ids)} goals exposed to the UI, all registered")


def test_unsupported_goals_resolve_but_are_hidden() -> None:
    """Hidden goals (flexibility, stress_relief) still resolve to a
    sensible bucket so older user profiles don't crash — they just
    shouldn't appear in `supported_goal_ids()`."""
    print("\n[test] hidden goals still resolve for stale profiles")
    from app.services.workout.goals import (
        is_goal_supported, resolve_goal, supported_goal_ids,
    )
    for gid in ("flexibility", "stress_relief"):
        assert not is_goal_supported(gid), f"{gid} should be hidden"
        assert gid not in supported_goal_ids()
        d = resolve_goal(gid)
        assert d.bucket == "general_health", f"{gid} → {d.bucket}"
    _ok("flexibility + stress_relief resolve to general_health, hidden from UI")


def test_aliases_share_canonical_bucket() -> None:
    """Toning aliases fat_loss. Maintain aliases general_health (as
    of the archetype refactor — previously body_recomp, but the new
    maintain recipe is a balanced three-category plan that fits the
    general_health profile, not a pure lifting plan)."""
    print("\n[test] aliases share canonical buckets")
    from app.services.workout.goals import resolve_goal
    assert resolve_goal("toning").bucket == "fat_loss"
    assert resolve_goal("toning").alias_of == "fat_loss"
    assert resolve_goal("maintain").bucket == "general_health"
    assert resolve_goal("maintain").alias_of == "general_health"
    _ok("toning → fat_loss, maintain → general_health")


def test_legacy_ids_resolve_to_correct_bucket() -> None:
    """Goal ids from `goalConfig.ts` that aren't first-class registry
    entries must still land in the right planner bucket."""
    print("\n[test] legacy goalConfig.ts ids resolve correctly")
    from app.services.workout.goals import goal_bucket

    cases = [
        ("improve_cardio",     "endurance"),
        ("cardio_endurance",   "endurance"),
        ("train_5k",           "endurance"),
        ("train_marathon",     "endurance"),
        ("aerobic_base",       "endurance"),
        ("improve_1rm",        "strength"),
        ("powerlifting",       "strength"),
        ("improve_bench",      "strength"),
        ("lean_bulk",          "muscle_gain"),
        ("bulk",               "muscle_gain"),
        ("get_lean",           "fat_loss"),
        ("cut",                "fat_loss"),
        ("recomp",             "body_recomp"),
        ("sport_performance",  "athletic_performance"),
    ]
    for legacy_id, want in cases:
        got = goal_bucket(legacy_id)
        assert got == want, f"{legacy_id} → {got} (want {want})"
        _ok(f"{legacy_id:22s} → {got}")


def test_unknown_goal_falls_back_gracefully() -> None:
    """An unknown goal id must never crash — it falls back to
    body_recomp (our 'no strong opinion' default)."""
    print("\n[test] unknown goal → body_recomp fallback")
    from app.services.workout.goals import resolve_goal
    assert resolve_goal("nonsense_goal").bucket == "body_recomp"
    assert resolve_goal(None).bucket == "body_recomp"
    assert resolve_goal("").bucket == "body_recomp"
    _ok("None / '' / unknown all → body_recomp")


# ─── Planner behavior distinctness ───────────────────────────────────────────


def test_supported_goals_produce_distinct_splits() -> None:
    """Changing from muscle_gain to fat_loss at the same day count must
    produce a visibly different plan, not just a relabeled copy."""
    print("\n[test] different goals → different plans at 4 days")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    full_eq = (
        "barbell", "dumbbells", "flat_bench", "squat_rack",
        "cable_machine", "pull_up_bar", "treadmill", "stationary_bike",
    )

    plans = {}
    for goal in ("fat_loss", "muscle_gain", "body_recomp", "strength",
                 "endurance", "athletic_performance"):
        inputs = PlannerInputs(
            goal=goal, days_per_week=4, experience="intermediate",
            equipment_slugs=full_eq, rng_seed=1,
        )
        plans[goal] = generate_workout_plan(inputs, SEED_EXERCISES)

    # Every goal's split name must be unique-per-goal OR produce a
    # different set of exercises than another goal sharing the split.
    # We compare exercise name sets across goals.
    sigs = {}
    for goal, plan in plans.items():
        wp = plan["workout_plan"]
        ex_names = tuple(
            sorted(
                ex["name"]
                for d in wp["days"]
                for ex in d["exercises"]
            )
        )
        sigs[goal] = (wp["name"], ex_names)

    # Endurance should NOT match any lifting-goal signature
    endurance_sig = sigs["endurance"]
    for other in ("fat_loss", "muscle_gain", "body_recomp", "strength"):
        assert sigs[other] != endurance_sig, (
            f"endurance and {other} produced identical plans"
        )

    # Athletic should NOT match generic lifting
    athletic_sig = sigs["athletic_performance"]
    for other in ("muscle_gain", "body_recomp"):
        assert sigs[other] != athletic_sig, (
            f"athletic_performance and {other} produced identical plans"
        )

    # Muscle gain and fat loss must differ (they use different day
    # templates AND different rep prescriptions)
    assert sigs["muscle_gain"] != sigs["fat_loss"], (
        "muscle_gain and fat_loss produced identical plans"
    )
    _ok(f"{len(sigs)} goals, {len(set(sigs.values()))} distinct plan signatures")


def test_endurance_plan_is_mostly_cardio() -> None:
    """An endurance plan must produce cardio-focused days. Most
    exercises should have movement_pattern=cardio from the seed."""
    print("\n[test] endurance plan is mostly cardio")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    by_slug = {e["slug"]: e for e in SEED_EXERCISES}
    inputs = PlannerInputs(
        goal="improve_cardio", days_per_week=4, experience="intermediate",
        equipment_slugs=(
            "barbell", "dumbbells", "flat_bench", "squat_rack",
            "treadmill", "stationary_bike",
        ),
        rng_seed=1,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    all_exs = [
        ex
        for d in plan["workout_plan"]["days"]
        for ex in d["exercises"]
    ]
    cardio_count = sum(
        1 for ex in all_exs
        if by_slug.get(ex.get("_slug"), {}).get("movement_pattern") == "cardio"
    )
    strength_count = len(all_exs) - cardio_count
    assert cardio_count > strength_count, (
        f"endurance plan not cardio-dominant: "
        f"cardio={cardio_count} strength={strength_count}"
    )
    _ok(f"cardio={cardio_count}  strength={strength_count}")


def test_endurance_plan_includes_one_strength_day_at_3plus() -> None:
    """Endurance plans at 3+ days/week must include exactly one
    strength maintenance day. Below 3 days, all days are cardio."""
    print("\n[test] endurance at 3+ days has strength maintenance day")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    eq = ("barbell", "dumbbells", "flat_bench", "squat_rack", "treadmill")

    # 4-day endurance: 3 cardio + 1 strength. Counted by archetype
    # category (the focus label itself is now the specific archetype
    # name like "Short Intervals" / "Strength Maintenance").
    plan = generate_workout_plan(
        PlannerInputs(
            goal="endurance", days_per_week=4, experience="intermediate",
            equipment_slugs=eq, rng_seed=1,
        ),
        SEED_EXERCISES,
    )
    cats = [d["category"] for d in plan["workout_plan"]["days"]]
    assert cats.count("lift") == 1, f"got categories={cats}"
    assert cats.count("cond") == 3, f"got categories={cats}"

    # 2-day endurance: pure cardio, no strength day
    plan2 = generate_workout_plan(
        PlannerInputs(
            goal="endurance", days_per_week=2, experience="intermediate",
            equipment_slugs=eq, rng_seed=1,
        ),
        SEED_EXERCISES,
    )
    cats2 = [d["category"] for d in plan2["workout_plan"]["days"]]
    assert cats2.count("lift") == 0, f"got categories={cats2}"
    assert cats2.count("cond") == 2, f"got categories={cats2}"
    _ok(f"4d={cats} | 2d={cats2}")


def test_athletic_plan_mixes_strength_and_conditioning() -> None:
    """Athletic performance must produce BOTH strength days and
    conditioning days at 4 days/week."""
    print("\n[test] athletic_performance mixes strength + cardio")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    inputs = PlannerInputs(
        goal="athletic_performance", days_per_week=4, experience="intermediate",
        equipment_slugs=(
            "barbell", "dumbbells", "flat_bench", "squat_rack", "treadmill",
        ),
        rng_seed=1,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    cats = {d["category"] for d in plan["workout_plan"]["days"]}
    # Athletic plans land in lift + hybrid + cond categories. Hybrid
    # days contain both strength and conditioning work by definition.
    assert "cond" in cats or "hybrid" in cats, f"no conditioning element: {cats}"
    assert "lift" in cats or "hybrid" in cats, f"no strength element: {cats}"
    _ok(f"categories={sorted(cats)}")


def test_toning_alias_plan_matches_fat_loss_plan() -> None:
    """Toning is an alias of fat_loss. Same request with the two ids
    must produce the same plan shape (split + exercise set)."""
    print("\n[test] toning and fat_loss produce matching plans")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    eq = ("barbell", "dumbbells", "flat_bench", "squat_rack", "cable_machine")
    t = generate_workout_plan(
        PlannerInputs(goal="toning", days_per_week=4, experience="intermediate", equipment_slugs=eq, rng_seed=1),
        SEED_EXERCISES,
    )
    f = generate_workout_plan(
        PlannerInputs(goal="fat_loss", days_per_week=4, experience="intermediate", equipment_slugs=eq, rng_seed=1),
        SEED_EXERCISES,
    )
    t_names = [
        (ex["name"], ex["reps"], ex["sets"])
        for d in t["workout_plan"]["days"]
        for ex in d["exercises"]
    ]
    f_names = [
        (ex["name"], ex["reps"], ex["sets"])
        for d in f["workout_plan"]["days"]
        for ex in d["exercises"]
    ]
    assert t_names == f_names, f"toning and fat_loss diverged:\n  toning={t_names}\n  fat_loss={f_names}"
    _ok(f"{len(t_names)} exercises identical across toning/fat_loss")


def test_fat_loss_and_muscle_gain_have_different_rep_schemes() -> None:
    """Rep prescriptions must differ between fat_loss and muscle_gain
    even at the same split — proving prescribe_sets_reps is bucket-
    aware."""
    print("\n[test] fat_loss vs muscle_gain rep prescriptions differ")
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EXERCISES

    eq = ("barbell", "dumbbells", "flat_bench", "squat_rack", "cable_machine")
    fl = generate_workout_plan(
        PlannerInputs(goal="fat_loss", days_per_week=4, experience="intermediate", equipment_slugs=eq, rng_seed=1),
        SEED_EXERCISES,
    )
    mg = generate_workout_plan(
        PlannerInputs(goal="muscle_gain", days_per_week=4, experience="intermediate", equipment_slugs=eq, rng_seed=1),
        SEED_EXERCISES,
    )

    def _rep_set(plan):
        return {
            (ex.get("_slot") or ex["name"], ex["reps"])
            for d in plan["workout_plan"]["days"]
            for ex in d["exercises"]
        }

    fl_reps = _rep_set(fl)
    mg_reps = _rep_set(mg)
    assert fl_reps != mg_reps, (
        f"rep prescriptions identical between fat_loss and muscle_gain"
    )
    _ok(f"{len(fl_reps ^ mg_reps)} rep-prescription differences")


def test_all_supported_goals_generate_deterministically_across_day_counts() -> None:
    """Every supported goal (plus hidden legacy goals) must generate a
    stable 1-7 day week, with every emitted archetype allowed by that
    goal's declarative profile."""
    print("\n[test] all goal profiles generate deterministic 1-7 day weeks")
    from app.services.workout.archetypes import DayArchetype
    from app.services.workout.goal_profiles import goal_profile_for
    from app.services.workout.goals import supported_goal_ids
    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES

    goals = list(supported_goal_ids()) + ["general_health", "flexibility", "stress_relief"]
    full_eq = tuple(e["slug"] for e in SEED_EQUIPMENT) + ("bodyweight",)

    def _signature(plan: dict) -> tuple:
        return tuple(
            (
                day.get("focus"),
                day.get("category"),
                day.get("archetype"),
                tuple((ex.get("name"), ex.get("sets"), ex.get("reps")) for ex in day.get("exercises", [])),
            )
            for day in plan["workout_plan"]["days"]
        )

    checked = 0
    for goal in goals:
        profile = goal_profile_for(goal, experience="intermediate", days_per_week=5)
        for days_per_week in range(1, 8):
            inputs = PlannerInputs(
                goal=goal,
                days_per_week=days_per_week,
                experience="intermediate",
                equipment_slugs=full_eq,
                rng_seed=37,
            )
            a = generate_workout_plan(inputs, SEED_EXERCISES)
            b = generate_workout_plan(inputs, SEED_EXERCISES)
            day_rows = a["workout_plan"]["days"]
            assert len(day_rows) == days_per_week, f"{goal} {days_per_week}d length={len(day_rows)}"
            assert _signature(a) == _signature(b), f"{goal} {days_per_week}d generated non-deterministically"
            for day in day_rows:
                assert day.get("exercises"), f"{goal} {days_per_week}d empty day: {day}"
                archetype = DayArchetype(day["archetype"])
                assert archetype in profile.allowed_archetypes, (
                    f"{goal} emitted disallowed archetype {archetype.value}; "
                    f"allowed={[a.value for a in profile.allowed_archetypes]}"
                )
            checked += 1
    _ok(f"{checked} goal/day-count combinations deterministic and profile-bounded")


def test_five_day_goal_recipe_contracts() -> None:
    """Five days/week is the most revealing shape for goal intent:
    there is enough room for strength, cardio, mobility, or hybrid
    work to show up if the profile claims it."""
    print("\n[test] five-day goal recipe contracts match intent")
    from collections import Counter

    from app.services.workout.planner import PlannerInputs, generate_workout_plan
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES

    full_eq = tuple(e["slug"] for e in SEED_EQUIPMENT) + ("bodyweight",)

    def _plan(goal: str) -> dict:
        return generate_workout_plan(
            PlannerInputs(
                goal=goal,
                days_per_week=5,
                experience="intermediate",
                equipment_slugs=full_eq,
                rng_seed=17,
            ),
            SEED_EXERCISES,
        )["workout_plan"]

    def _counts(plan: dict) -> Counter:
        return Counter(day.get("category") for day in plan["days"])

    def _has_cardio_component(plan: dict) -> bool:
        for day in plan["days"]:
            if day.get("category") in {"cond", "hybrid"}:
                return True
            if "plus_cardio" in str(day.get("archetype") or ""):
                return True
            for ex in day.get("exercises", []):
                if str(ex.get("prescriptionType") or "").startswith("cardio_"):
                    return True
        return False

    endurance = _counts(_plan("endurance"))
    assert endurance["cond"] == 4 and endurance["lift"] == 1, endurance

    hyrox = _counts(_plan("hyrox"))
    assert hyrox["cond"] >= 3 and hyrox["hybrid"] >= 1 and hyrox["lift"] >= 1, hyrox

    athletic = _counts(_plan("athletic_performance"))
    assert athletic["cond"] >= 1 and athletic["hybrid"] >= 1 and athletic["lift"] >= 1, athletic

    for goal in ("maintain", "general_health"):
        counts = _counts(_plan(goal))
        assert counts["lift"] >= 1 and counts["cond"] >= 1 and counts["mobility"] >= 1, (goal, counts)

    strength = _plan("strength")
    strength_counts = _counts(strength)
    assert strength_counts["lift"] == 5, strength_counts
    assert any(
        "heavy" in str(day.get("archetype") or "") or "strength" in str(day.get("archetype") or "")
        for day in strength["days"]
    ), [day.get("archetype") for day in strength["days"]]

    muscle_gain = _counts(_plan("muscle_gain"))
    assert muscle_gain["lift"] == 5, muscle_gain

    for goal in ("fat_loss", "toning", "body_recomp"):
        assert _has_cardio_component(_plan(goal)), f"{goal} has no cardio component"

    flexibility = _counts(_plan("flexibility"))
    assert flexibility["mobility"] >= 2, flexibility

    stress = _counts(_plan("stress_relief"))
    assert stress["recovery"] >= 2 and stress["cond"] >= 1, stress

    _ok("endurance, hyrox, athletic, maintain, strength, hypertrophy, fat-loss, mobility, recovery contracts hold")


# ─── Runner ──────────────────────────────────────────────────────────────────


def _run_all() -> int:
    tests = [
        test_seeded_goals_are_all_in_registry,
        test_unsupported_goals_resolve_but_are_hidden,
        test_aliases_share_canonical_bucket,
        test_legacy_ids_resolve_to_correct_bucket,
        test_unknown_goal_falls_back_gracefully,
        test_supported_goals_produce_distinct_splits,
        test_endurance_plan_is_mostly_cardio,
        test_endurance_plan_includes_one_strength_day_at_3plus,
        test_athletic_plan_mixes_strength_and_conditioning,
        test_toning_alias_plan_matches_fat_loss_plan,
        test_fat_loss_and_muscle_gain_have_different_rep_schemes,
        test_all_supported_goals_generate_deterministically_across_day_counts,
        test_five_day_goal_recipe_contracts,
    ]
    failed = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            failed += 1
            print(f"  ✗ {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ✗ {t.__name__} ({type(e).__name__}): {e}")
    print()
    print(f"{len(tests) - failed}/{len(tests)} passed" if failed == 0 else f"{failed} FAILED")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_all())
