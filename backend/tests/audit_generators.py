"""One-off sweep over (goal × days × split × session × focus × experience)
combinations to surface critical failures in the plan + meal generators.

Not registered in run_all.py. Invoke directly:

    docker exec thallo-backend python -m tests.audit_generators

Failures are collected and printed in groups. The top-level exit code is
non-zero iff a CRITICAL assertion fired.
"""
from __future__ import annotations

import itertools
import sys
import traceback
from typing import Any

from app.seed_exercises_data import SEED_EXERCISES
from app.services.workout.planner import PlannerInputs, generate_workout_plan
from app.services.workout.weekly_recipe import generate_weekly_recipe
from app.services.workout.goal_profiles import goal_profile_for
from app.services.workout.archetypes import (
    DayArchetype, ARCHETYPE_META, archetype_to_focus_family,
)
from app.services.workout.day_templates import (
    SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL, SPLIT_BRO, SPLIT_PPL_UL,
)

from app.services.nutrition.calorie_calculator import (
    CalorieInputs, compute_targets,
)


# ── Equipment bundles ──────────────────────────────────────────────
_FULL_GYM = (
    "barbell", "dumbbells", "flat_bench", "squat_rack",
    "cable_machine", "pull_up_bar", "lat_pulldown",
    "leg_press", "smith_machine", "adjustable_bench",
    "dip_bars", "leg_curl_machine", "leg_extension_machine",
    "hack_squat", "hip_thrust_bench",
)
_DB_ONLY = ("dumbbells", "adjustable_bench")
_BODYWEIGHT = ()  # pure bodyweight


# ── Parameter grid ─────────────────────────────────────────────────
_GOALS = [
    "fat_loss", "muscle_gain", "body_recomp", "strength",
    "endurance", "athletic_performance", "hyrox",
    "toning", "maintain", "general_health", "longevity",
]
_DAYS = [1, 2, 3, 4, 5, 6, 7]
_SPLITS = ["auto", "full_body", "upper_lower", "ppl", "bro"]
_EXPERIENCE = ["beginner", "intermediate", "advanced"]
_SESSIONS = [20, 30, 45, 60, 90]
_FOCUSED = [None, "glutes", "chest", "arms"]
_AGES = [20, 35, 55, 70]

_LIFTING_GOALS = {"fat_loss", "muscle_gain", "body_recomp", "strength", "toning"}
_MUSCLE_BUILD_GOALS = {"muscle_gain", "strength", "body_recomp"}


# ── Failure collection ─────────────────────────────────────────────

class FailureLog:
    def __init__(self) -> None:
        self.critical: list[tuple[str, dict, str]] = []
        self.important: list[tuple[str, dict, str]] = []

    def crit(self, name: str, inputs: dict, detail: str) -> None:
        self.critical.append((name, inputs, detail))

    def imp(self, name: str, inputs: dict, detail: str) -> None:
        self.important.append((name, inputs, detail))

    def report(self) -> int:
        print()
        print("=" * 72)
        print(f"  AUDIT RESULTS: {len(self.critical)} critical, "
              f"{len(self.important)} important")
        print("=" * 72)
        by_name: dict[str, int] = {}
        for name, inp, _ in self.critical:
            by_name[name] = by_name.get(name, 0) + 1
        for name, count in sorted(by_name.items()):
            print(f"  CRIT  {name}: {count}")
            # Print a single example
            for n, inp, det in self.critical:
                if n == name:
                    print(f"         ex: {inp} → {det[:120]}")
                    break
        by_name = {}
        for name, inp, _ in self.important:
            by_name[name] = by_name.get(name, 0) + 1
        for name, count in sorted(by_name.items()):
            print(f"  IMP   {name}: {count}")
            for n, inp, det in self.important:
                if n == name:
                    print(f"         ex: {inp} → {det[:120]}")
                    break
        return 1 if self.critical else 0


# ── Workout sweep ──────────────────────────────────────────────────

def audit_workouts(fl: FailureLog) -> None:
    print("Sweeping workout generator…")
    count = 0
    for goal, days, split, exp, sess, focus, age in itertools.product(
        _GOALS, _DAYS, _SPLITS, _EXPERIENCE, _SESSIONS, _FOCUSED, _AGES,
    ):
        count += 1
        key = dict(g=goal, d=days, sp=split, e=exp, s=sess, f=focus, a=age)
        try:
            inputs = PlannerInputs(
                goal=goal,
                days_per_week=days,
                session_minutes=sess,
                experience=exp,
                equipment_slugs=_FULL_GYM,
                preferred_split=split,
                focused_muscle=focus,
                user_age=age,
                rng_seed=1,
            )
            plan = generate_workout_plan(inputs, SEED_EXERCISES)
        except Exception as e:
            fl.crit("planner_exception", key,
                    f"{type(e).__name__}: {e}")
            continue

        dlist = plan.get("workout_plan", {}).get("days", []) or []
        if len(dlist) != days:
            fl.crit("day_count_mismatch", key,
                    f"wanted {days} days, got {len(dlist)}")
            continue

        # Lift count
        lift_count = 0
        for d in dlist:
            focus_name = (d.get("focus") or "").lower()
            exs = d.get("exercises", []) or []
            # Use recipe archetypes: classify by exercise count + focus
            # Heuristic: a day is a "lift day" if focus doesn't say
            # mobility/recovery/cardio/zone/rest/stretch.
            mobility_words = ("mobility", "recovery", "stretch", "rest")
            cardio_words = ("zone", "cardio", "interval", "tempo", "sprint",
                            "conditioning", "run", "circuit")
            is_mob = any(w in focus_name for w in mobility_words)
            is_car = any(w in focus_name for w in cardio_words)
            # Lift day: any focus that isn't mobility/cardio and has
            # at least one exercise. Low session_minutes can legitimately
            # produce 2-ex lift days so don't gate on a min count.
            if not is_mob and not is_car and len(exs) >= 1:
                lift_count += 1

        # 1. Lifting-goal under-prescribed on 5+ days
        if goal in _LIFTING_GOALS and days >= 5 and lift_count < 2:
            fl.crit("underprescribed_lifts", key,
                    f"lift_count={lift_count} on {days}d lifting goal")

        # 6. session_minutes respected (approx exercise count)
        for di, d in enumerate(dlist):
            exs = d.get("exercises", []) or []
            n = len(exs)
            # very rough: 20 min = 2-5 ex, 90 min = 5-12 ex
            focus_name = (d.get("focus") or "").lower()
            if "mobility" in focus_name or "recovery" in focus_name:
                continue
            if sess <= 20 and n > 7:
                fl.crit("session_too_full", key,
                        f"day {di} has {n} exs at {sess}min session")
            # session_too_empty only makes sense for lift days — cardio
            # days are 1-2 entries by design (single zone 2 block etc.).
            is_cardio = any(w in focus_name for w in cardio_words)
            if sess >= 90 and n < 3 and not is_cardio:
                fl.imp("session_too_empty", key,
                       f"day {di} has {n} exs at {sess}min session")

        # 8. Injury pattern leak is tested separately with injuries set.

        # 2/3: adjacency + split-rotation — only reliable to check on
        # lifting-mode recipes. Use recipe directly from
        # generate_weekly_recipe to get archetype families.
        try:
            profile = goal_profile_for(goal, exp, days, sess)
            lsplit = split if split != "auto" else "upper_lower"
            recipe = generate_weekly_recipe(
                profile, days,
                lifting_split=lsplit,
                user_chose_split=(split != "auto"),
            )
        except Exception:
            continue
        # 2. no triple in a row (same focus family)
        fams = []
        for a in recipe:
            try:
                fams.append(archetype_to_focus_family(a))
            except Exception:
                fams.append(None)
        # Allow Bro split (single-muscle days) AND full-body split (always
        # full_body family by design). Only check triple-family when the
        # split is supposed to vary (U/L, PPL, PPL+UL), and only for
        # lifting-dominant goals (endurance/athletic/hyrox/maintain have
        # anchored cardio-heavy recipes that the weekly_recipe repairer
        # deliberately does NOT reshuffle).
        if (split in ("upper_lower", "ppl", "ppl_ul")
                and goal in _LIFTING_GOALS):
            for i in range(len(fams) - 2):
                if fams[i] is not None and fams[i] == fams[i+1] == fams[i+2]:
                    fl.crit("triple_same_family", key,
                            f"recipe={[a.value for a in recipe]} "
                            f"triple at i={i} fam={fams[i]}")
                    break

        # 3. PPL split — at 6 days should cycle P/Pu/L/P/Pu/L
        # (allowing heavy/volume variants). Count exposures.
        if split == "ppl" and goal in _LIFTING_GOALS and days >= 4:
            counts = {"push": 0, "pull": 0, "legs": 0}
            for f in fams:
                if f in counts:
                    counts[f] += 1
            total = sum(counts.values())
            if total >= 3:
                # Every family present when total >= 3
                missing = [k for k, v in counts.items() if v == 0]
                if missing:
                    fl.crit("ppl_missing_family", key,
                            f"recipe={[a.value for a in recipe]} "
                            f"missing={missing}")

        # 3. U/L alternation — 4+ lift days should have roughly equal
        # upper vs lower representation.
        if split == "upper_lower" and goal in _LIFTING_GOALS and days >= 4:
            upper = sum(1 for f in fams if f == "upper")
            lower = sum(1 for f in fams if f == "lower")
            total = upper + lower
            if total >= 4 and abs(upper - lower) >= 3:
                fl.imp("ul_unbalanced", key,
                       f"upper={upper} lower={lower} recipe="
                       f"{[a.value for a in recipe]}")

        # 4. fat_loss 6d U/L: should have 4 lifts (even lift-day rule)
        if goal == "fat_loss" and days == 6 and split == "upper_lower":
            lift_in_recipe = sum(
                1 for a in recipe
                if ARCHETYPE_META[a].category == "lift"
            )
            if lift_in_recipe % 2 == 1:
                fl.imp("fat_loss_ul_odd_lifts", key,
                       f"lift_count={lift_in_recipe} on 6d U/L fat_loss")
    print(f"  swept {count} workout configs")


def audit_focused_muscle(fl: FailureLog) -> None:
    print("Checking focused_muscle exposure…")
    # Build name→(pm, sm) lookup from seed since the plan output
    # doesn't embed primary_muscle.
    seed_lookup: dict[str, tuple[str, list[str]]] = {}
    for ex in SEED_EXERCISES:
        seed_lookup[(ex.get("name") or "").lower()] = (
            (ex.get("primary_muscle") or "").lower(),
            [m.lower() for m in (ex.get("secondary_muscles") or [])],
        )
    for focus, goal in [("glutes", "muscle_gain"),
                        ("chest", "muscle_gain"),
                        ("arms", "muscle_gain")]:
        inputs = PlannerInputs(
            goal=goal, days_per_week=5, experience="intermediate",
            equipment_slugs=_FULL_GYM,
            focused_muscle=focus,
            rng_seed=1,
        )
        plan = generate_workout_plan(inputs, SEED_EXERCISES)
        exposures = 0
        # Expand "arms" to biceps + triceps targets
        targets = {focus} if focus != "arms" else {"biceps", "triceps"}
        for d in plan.get("workout_plan", {}).get("days", []):
            for ex in d.get("exercises", []) or []:
                nm = (ex.get("name") or "").lower()
                pm, sm = seed_lookup.get(nm, ("", []))
                if pm in targets or any(m in targets for m in sm):
                    exposures += 1
        if exposures < 3:
            fl.crit("focused_muscle_low_exposure",
                    {"focus": focus, "goal": goal},
                    f"{focus} exposures={exposures} over 5 days")
        else:
            print(f"  {focus} focus → {exposures} exposures")


def audit_injury_leak(fl: FailureLog) -> None:
    print("Checking injury pattern leaks…")
    # Active knee injury: no squats/lunges.
    inputs = PlannerInputs(
        goal="muscle_gain", days_per_week=4, experience="intermediate",
        equipment_slugs=_FULL_GYM,
        injuries=("knee",),
        rng_seed=1,
    )
    plan = generate_workout_plan(inputs, SEED_EXERCISES)
    leak = []
    for d in plan.get("workout_plan", {}).get("days", []):
        for ex in d.get("exercises", []) or []:
            nm = (ex.get("name") or "").lower()
            # Coarse keyword scan — these are known knee-risk patterns
            if any(k in nm for k in ("back squat", "front squat",
                                     "barbell squat", "lunge", "step-up",
                                     "jump squat")):
                leak.append(nm)
    if leak:
        fl.crit("injury_pattern_leak",
                {"injury": "knee"},
                f"knee leaks: {leak}")
    else:
        print("  no knee-pattern leaks")


# ── Nutrition sweep ────────────────────────────────────────────────

def audit_nutrition(fl: FailureLog) -> None:
    print("Sweeping nutrition targets…")
    # Two body profiles: 180lb male, 140lb female; 4 day training.
    profiles = [
        dict(weight_lbs=180, height_feet=5, height_inches=10,
             age=30, gender="male", training_days_per_week=4),
        dict(weight_lbs=140, height_feet=5, height_inches=5,
             age=35, gender="female", training_days_per_week=4),
        # Elderly scenario
        dict(weight_lbs=160, height_feet=5, height_inches=8,
             age=70, gender="male", training_days_per_week=3),
    ]
    for p in profiles:
        for goal in _GOALS:
            try:
                t = compute_targets(CalorieInputs(
                    goal_id=goal, pace="moderate", **p,
                ))
            except Exception as e:
                fl.crit("nutrition_exception",
                        {"goal": goal, **p},
                        f"{type(e).__name__}: {e}")
                continue
            # 4. Muscle-building goals must have >= 0.7 g/lb protein.
            if goal in _MUSCLE_BUILD_GOALS:
                ppl = t.protein_g / p["weight_lbs"]
                if ppl < 0.7:
                    fl.crit("protein_too_low",
                            {"goal": goal, **p},
                            f"protein={t.protein_g}g, "
                            f"{ppl:.2f} g/lb")
            # 5. Calorie target vs TDEE direction
            if goal in ("fat_loss", "toning"):
                if t.calories >= t.tdee and not t.min_calories_enforced:
                    fl.crit("fat_loss_not_deficit",
                            {"goal": goal, **p},
                            f"cal={t.calories} tdee={t.tdee}")
            if goal == "muscle_gain":
                if t.calories <= t.tdee:
                    fl.crit("bulk_not_surplus",
                            {"goal": goal, **p},
                            f"cal={t.calories} tdee={t.tdee}")
            # 5a. MIN_SAFE_CALORIES should clamp small females.
            if t.calories < 1200:
                fl.crit("below_min_safe_cal",
                        {"goal": goal, **p},
                        f"cal={t.calories}")


# ── Main ───────────────────────────────────────────────────────────

def main() -> int:
    fl = FailureLog()
    try:
        audit_workouts(fl)
    except Exception:
        traceback.print_exc()
        fl.crit("audit_workouts_crashed", {}, "see traceback")
    try:
        audit_focused_muscle(fl)
    except Exception:
        traceback.print_exc()
        fl.crit("audit_focused_muscle_crashed", {}, "see traceback")
    try:
        audit_injury_leak(fl)
    except Exception:
        traceback.print_exc()
        fl.crit("audit_injury_leak_crashed", {}, "see traceback")
    try:
        audit_nutrition(fl)
    except Exception:
        traceback.print_exc()
        fl.crit("audit_nutrition_crashed", {}, "see traceback")
    return fl.report()


if __name__ == "__main__":
    sys.exit(main())
