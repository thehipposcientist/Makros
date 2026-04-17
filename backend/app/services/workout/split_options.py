"""Split recommendation engine.

Given a user's goal, days_per_week, and experience, returns an ordered
list of compatible training splits with a recommendation score, a
one-line rationale, and a "best pick" flag. Purely deterministic —
no LLM calls. The client renders this as a picker so the user can
choose their split before plan generation.

The recommended split matches what `pick_split()` in day_templates.py
would auto-select, but now the user sees WHY and can override.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional

from .day_templates import (
    SPLIT_FULL_BODY, SPLIT_UPPER_LOWER, SPLIT_PPL,
    SPLIT_PPL_UL, SPLIT_BRO, _SPLIT_MIN_DAYS, pick_split,
)
from ..workout.goal_profiles import goal_bucket


@dataclass
class SplitOption:
    id: str
    name: str
    short_name: str
    description: str
    days_per_week_range: str
    day_labels: list[str]
    rationale: str
    fit_score: int           # 0-100, higher = better fit
    is_recommended: bool
    stimulus_note: str       # what the user can expect (heavy/hypertrophy alternation, etc.)
    pros: list[str]
    cons: list[str]
    region_warning: str | None = None  # shown when split clashes with priority_region

    def to_dict(self) -> dict:
        return asdict(self)


# ── Split definitions ────────────────────────────────────────────────

_SPLIT_DEFS: dict[str, dict] = {
    SPLIT_FULL_BODY: {
        "name": "Full Body",
        "short_name": "Full Body",
        "description": "Train every muscle group each session. Best for 2-3 days/week or beginners who benefit from high frequency.",
        "days_per_week_range": "2-4",
        "day_labels_by_days": {
            2: ["Full Body A", "Full Body B"],
            3: ["Full Body — Strength", "Full Body A", "Full Body B"],
            4: ["Full Body — Strength", "Full Body A", "Full Body B", "Full Body C"],
        },
        "stimulus_note": "Day 1 is a strength session (heavier, fewer reps). Remaining days rotate hypertrophy focus.",
        "pros": ["High frequency per muscle", "Simple to schedule", "Good for beginners"],
        "cons": ["Sessions can be long", "Less specialization per muscle", "Fatigue accumulates fast at 4+ days"],
    },
    SPLIT_UPPER_LOWER: {
        "name": "Upper / Lower",
        "short_name": "Upper / Lower",
        "description": "Alternate upper-body and lower-body days. The workhorse split for 4-day programs.",
        "days_per_week_range": "3-5",
        "day_labels_by_days": {
            3: ["Upper — Heavy", "Lower — Heavy", "Upper — Hypertrophy"],
            4: ["Upper — Heavy", "Lower — Heavy", "Upper — Hypertrophy", "Lower — Hypertrophy"],
            5: ["Upper — Heavy", "Lower — Heavy", "Upper — Hypertrophy", "Lower — Hypertrophy", "Upper — Heavy"],
        },
        "stimulus_note": "Heavy days focus on compound strength (3-5 reps). Hypertrophy days add more accessories and volume (6-12 reps).",
        "pros": ["Balanced stimulus", "Heavy/hypertrophy alternation", "Great recovery balance"],
        "cons": ["4 days minimum for full cycle", "Less muscle-specific than PPL"],
    },
    SPLIT_PPL: {
        "name": "Push / Pull / Legs",
        "short_name": "PPL",
        "description": "Group muscles by function — push (chest/shoulders/triceps), pull (back/biceps), legs. Best at 3 or 6 days.",
        "days_per_week_range": "3-6",
        "day_labels_by_days": {
            3: ["Push", "Pull", "Legs"],
            4: ["Push", "Pull", "Legs", "Push"],
            5: ["Push", "Pull", "Legs", "Push", "Pull"],
            6: ["Push", "Pull", "Legs", "Push — Volume", "Pull — Volume", "Legs — Volume"],
        },
        "stimulus_note": "At 6 days: first 3 are standard intensity, second 3 are higher-rep volume variants.",
        "pros": ["Muscle-group focused", "Good volume distribution", "Scales well from 3 to 6 days"],
        "cons": ["3-day version = each muscle only 1x/week", "Requires consistent scheduling"],
    },
    SPLIT_PPL_UL: {
        "name": "PPL + Upper/Lower",
        "short_name": "PPL/UL",
        "description": "5-day hybrid: Push/Pull/Legs for the first 3 days, then Upper/Lower for extra frequency.",
        "days_per_week_range": "5",
        "day_labels_by_days": {
            5: ["Push", "Pull", "Legs", "Upper", "Lower"],
        },
        "stimulus_note": "Combines PPL's muscle focus with U/L's frequency. Each muscle hit ~2x/week.",
        "pros": ["Best of both worlds", "High frequency + focus", "Great for hypertrophy goals"],
        "cons": ["5 days required", "More complex to program", "Higher recovery demand"],
    },
    SPLIT_BRO: {
        "name": "Body Part Split",
        "short_name": "Bro Split",
        "description": "Dedicate each day to one muscle group. Maximum volume per muscle, minimum frequency.",
        "days_per_week_range": "5-6",
        "day_labels_by_days": {
            5: ["Chest", "Back", "Shoulders", "Arms", "Legs"],
            6: ["Chest", "Back", "Shoulders", "Arms", "Legs", "Chest"],
        },
        "stimulus_note": "Each muscle gets maximum weekly volume in one session. Best for advanced lifters who can recover from high single-session volume.",
        "pros": ["Maximum per-session volume", "Deep focus per muscle", "Simple day planning"],
        "cons": ["Each muscle only 1x/week", "Requires 5+ days", "Intermediate+ only"],
    },
}


# ── Goal-specific rationale templates ────────────────────────────────

def _rationale(split_id: str, goal: str, days: int, experience: str, target_focus: str | None = None) -> str:
    """One-sentence reason why this split fits (or doesn't fit) this user."""
    bucket = goal_bucket(goal)
    exp = (experience or "intermediate").lower()
    tf = (target_focus or "").lower()
    _LOWER = {"glutes", "quads", "hamstrings", "calves", "hips", "legs"}
    focus_is_lower = tf in _LOWER

    if split_id == SPLIT_FULL_BODY:
        if focus_is_lower and days <= 3:
            return f"Full body hits {target_focus} every session — highest frequency for your focus at {days} days."
        if days <= 3:
            return f"Full body is ideal at {days} days — every session trains everything, maximizing your limited training days."
        if exp == "beginner":
            return "Full body builds motor patterns fast. High frequency per muscle accelerates beginner gains."
        return f"Full body at {days} days works but each session is dense. Consider Upper/Lower for better recovery."

    if split_id == SPLIT_UPPER_LOWER:
        if focus_is_lower:
            return f"Upper/Lower gives you 2 dedicated lower days per cycle — good frequency for {target_focus} focus."
        if days == 4:
            return "Upper/Lower at 4 days is the gold standard — heavy + hypertrophy alternation with built-in recovery."
        if bucket == "strength":
            return "Upper/Lower lets you hit heavy compounds twice per week with adequate recovery between sessions."
        return f"Upper/Lower at {days} days gives clean heavy/hypertrophy cycling with balanced recovery."

    if split_id == SPLIT_PPL:
        if focus_is_lower and days <= 3:
            return f"PPL at 3 days only trains {target_focus} once per week on Legs day — low frequency for a focus muscle."
        if days == 6:
            return "PPL at 6 days doubles your frequency — standard intensity first half, volume variants second half."
        if days == 3:
            return "PPL at 3 days = each muscle 1x/week. Works for maintenance but limits growth stimulus."
        return f"PPL at {days} days distributes volume well across push/pull/legs movement patterns."

    if split_id == SPLIT_PPL_UL:
        if focus_is_lower:
            return f"PPL + Upper/Lower gives 2 lower days (Legs + Lower) — solid {target_focus} frequency at 5 days."
        return "PPL + Upper/Lower is the best 5-day split for hypertrophy — combines muscle focus with 2x/week frequency."

    if split_id == SPLIT_BRO:
        if exp != "advanced":
            return "Body part split is best suited for advanced lifters. Consider PPL or Upper/Lower for better frequency."
        return "Bro split maximizes per-session volume. Advanced lifters can recover from the high single-session load."

    return "A solid general option for your training days."


# ── Scoring ──────────────────────────────────────────────────────────

def _fit_score(split_id: str, goal: str, days: int, experience: str, target_focus: str | None = None) -> int:
    """0-100 score for how well this split fits the user's context."""
    bucket = goal_bucket(goal)
    exp = (experience or "intermediate").lower()
    score = 50  # baseline

    min_days = _SPLIT_MIN_DAYS.get(split_id, 99)
    if days < min_days:
        return 0  # can't run this split

    # Days-fit bonus
    ideal_ranges = {
        SPLIT_FULL_BODY: (2, 3),
        SPLIT_UPPER_LOWER: (4, 5),
        SPLIT_PPL: (3, 6),
        SPLIT_PPL_UL: (5, 5),
        SPLIT_BRO: (5, 6),
    }
    lo, hi = ideal_ranges.get(split_id, (1, 7))
    if lo <= days <= hi:
        score += 20
    elif abs(days - lo) <= 1 or abs(days - hi) <= 1:
        score += 10

    # Goal-fit bonus
    if split_id == SPLIT_FULL_BODY:
        if bucket in ("general_health", "fat_loss") and days <= 3:
            score += 15
        if exp == "beginner":
            score += 15
    elif split_id == SPLIT_UPPER_LOWER:
        if bucket in ("body_recomp", "strength", "muscle_gain"):
            score += 15
        if days == 4:
            score += 10
    elif split_id == SPLIT_PPL:
        if bucket in ("muscle_gain", "body_recomp"):
            score += 10
        if days == 6:
            score += 15
    elif split_id == SPLIT_PPL_UL:
        if bucket in ("muscle_gain", "body_recomp") and days == 5:
            score += 20
    elif split_id == SPLIT_BRO:
        if bucket == "muscle_gain" and exp == "advanced":
            score += 15
        if exp != "advanced":
            score -= 15

    # Experience penalty for complex splits
    if exp == "beginner" and split_id in (SPLIT_BRO, SPLIT_PPL_UL):
        score -= 20

    # Target focus: bias toward splits with higher frequency for
    # the focused muscle group. A glute focus benefits from more
    # lower-body days; a chest focus benefits from more upper days.
    if target_focus:
        tf = target_focus.lower()
        _LOWER_MUSCLES = {"glutes", "quads", "hamstrings", "calves", "hips", "legs"}
        _UPPER_MUSCLES = {"chest", "back", "shoulders", "arms", "biceps", "triceps", "lats"}

        if tf in _LOWER_MUSCLES:
            # Lower-body focus → prefer splits with 2+ lower days
            if split_id == SPLIT_UPPER_LOWER:
                score += 10  # 2 lower days/cycle
            elif split_id == SPLIT_FULL_BODY:
                score += 15  # every session hits lower
            elif split_id == SPLIT_PPL and days >= 6:
                score += 5   # 2 leg days at 6d
            elif split_id == SPLIT_PPL and days <= 3:
                score -= 10  # only 1 leg day = bad for lower focus
            elif split_id == SPLIT_BRO:
                score -= 10  # only 1 leg day

        elif tf in _UPPER_MUSCLES:
            if split_id == SPLIT_UPPER_LOWER:
                score += 10  # 2 upper days
            elif split_id == SPLIT_PPL:
                score += 5   # push+pull both hit upper
            elif split_id == SPLIT_BRO:
                score += 5   # dedicated chest/back/shoulders days

        # Lift-specific focuses (bench, squat, deadlift) → prefer
        # stable compound-heavy splits
        _LIFT_FOCUSES = {"bench", "squat", "deadlift", "bench_press", "overhead_press", "pull_ups"}
        if tf in _LIFT_FOCUSES:
            if split_id == SPLIT_UPPER_LOWER:
                score += 10  # compounds hit 2x/week
            elif split_id == SPLIT_PPL and days >= 6:
                score += 5

    return max(0, min(100, score))


# ── Public API ───────────────────────────────────────────────────────

_NON_LIFTING_PROGRAMS: dict[str, dict] = {
    "endurance": {
        "name": "Endurance Program",
        "short_name": "Endurance",
        "description": "Cardio-dominant with intervals, steady-state, and tempo sessions. One strength maintenance day at 3+ days.",
        "days_per_week_range": "2-7",
        "stimulus_note": "Alternates easy aerobic days with interval sessions for cardiovascular adaptation.",
        "pros": ["Builds VO2max and stamina", "Low joint stress", "Scales to any day count"],
        "cons": ["Minimal muscle building", "One strength day max"],
        "day_labels_by_days": {
            2: ["Short Intervals", "Zone 2 Cardio"],
            3: ["Short Intervals", "Zone 2 Cardio", "Strength Maintenance"],
            4: ["Intervals", "Zone 2", "Tempo", "Strength Maintenance"],
            5: ["Intervals", "Zone 2", "Long Intervals", "Zone 2", "Strength"],
            6: ["Intervals", "Zone 2", "Long Intervals", "Zone 2", "Tempo", "Strength"],
        },
    },
    "athletic_performance": {
        "name": "Athletic Program",
        "short_name": "Athletic",
        "description": "Hybrid strength + conditioning + power. Builds sport-ready fitness with explosive and endurance work.",
        "days_per_week_range": "2-6",
        "stimulus_note": "Alternates power/strength days with conditioning. Sprint and plyometric work included.",
        "pros": ["Well-rounded athletic fitness", "Power + endurance", "Sport-transferable"],
        "cons": ["High recovery demand", "Complex programming"],
        "day_labels_by_days": {
            2: ["Lower Power", "Upper + Intervals"],
            3: ["Lower Power", "Sprint Power", "Upper + Intervals"],
            4: ["Lower", "Upper + Intervals", "Sprint", "Lower Power"],
            5: ["Lower", "Intervals", "Upper", "Sprint", "Full Body Strength"],
        },
    },
    "flexibility": {
        "name": "Flexibility & Mobility",
        "short_name": "Flex/Mobility",
        "description": "Yoga, stretching, and mobility flows. Optional light cardio for active recovery. One strength maintenance day at 3+.",
        "days_per_week_range": "1-7",
        "stimulus_note": "Low-intensity sessions focused on range of motion, joint health, and restoration.",
        "pros": ["Improves range of motion", "Low fatigue", "Restorative"],
        "cons": ["No muscle or strength building", "Minimal calorie burn"],
        "day_labels_by_days": {
            2: ["Mobility Flow", "Stretch Block"],
            3: ["Mobility Flow", "Stretch Block", "Strength Maintenance"],
            4: ["Mobility Flow", "Zone 2 Cardio", "Stretch Block", "Strength"],
            5: ["Mobility", "Zone 2", "Stretch", "Recovery Easy", "Strength"],
        },
    },
    "stress_relief": {
        "name": "Mental Wellness",
        "short_name": "Wellness",
        "description": "Easy movement for stress relief and restoration. Gentle cardio, yoga, mobility, and breathing.",
        "days_per_week_range": "1-7",
        "stimulus_note": "All sessions are low-intensity. No heavy lifting or high-intensity intervals.",
        "pros": ["Calming and restorative", "Zero high-intensity stress", "Flexible schedule"],
        "cons": ["No performance gains", "No muscle building"],
        "day_labels_by_days": {
            2: ["Stress Relief", "Mobility Flow"],
            3: ["Stress Relief", "Mobility", "Zone 2 Walk"],
            4: ["Stress Relief", "Mobility", "Zone 2", "Recovery Easy"],
        },
    },
    "general_health": {
        "name": "General Health",
        "short_name": "General",
        "description": "Balanced rotation of full-body lifting, easy cardio, and mobility. A little of everything.",
        "days_per_week_range": "2-7",
        "stimulus_note": "Alternates full-body lifting with Zone 2 cardio and mobility flows.",
        "pros": ["Covers all fitness bases", "Sustainable long-term", "Simple schedule"],
        "cons": ["Not optimized for any single outcome"],
        "day_labels_by_days": {
            3: ["Full Body", "Zone 2 Cardio", "Mobility Flow"],
            4: ["Full Body", "Zone 2", "Full Body", "Mobility"],
            5: ["Full Body", "Zone 2", "Full Body", "Mobility", "Zone 2"],
        },
    },
}

# Goals that use traditional lifting splits. Checked by PLANNER MODE
# (not just bucket) because flexibility/stress_relief map to
# general_health bucket in the goal registry but use mobility/recovery
# planner modes that don't need a split picker.
_LIFTING_GOALS = {"muscle_gain", "strength", "body_recomp", "fat_loss"}

def _is_lifting_goal(goal: str) -> bool:
    """Check if this goal uses a traditional split (vs. a fixed program).

    Checks planner mode FIRST because some goals (improve_flexibility)
    have a bucket that looks lifting-adjacent (body_recomp) in the goal
    registry but a planner mode (mobility) that doesn't use splits."""
    try:
        from .goal_profiles import goal_profile_for
        profile = goal_profile_for(goal)
        return profile.planner_mode in ("lifting", "fat_loss_mix", "lifting_plus_cardio")
    except Exception:
        bucket = goal_bucket(goal)
        return bucket in _LIFTING_GOALS


def get_split_options(
    *,
    goal: str,
    days_per_week: int,
    experience: str = "intermediate",
    target_focus: str | None = None,
) -> list[SplitOption]:
    """Return all compatible splits for this user, scored and sorted.

    For lifting-focused goals (muscle_gain, strength, body_recomp,
    fat_loss), returns traditional splits (PPL, Upper/Lower, etc.).

    For non-lifting goals (endurance, athletic, flexibility, stress_relief,
    general_health), returns a single program description that explains
    how the planner structures those days — no split picker needed.
    """
    days = max(1, min(7, days_per_week))
    exp = (experience or "intermediate").lower()
    bucket = goal_bucket(goal)

    # Non-lifting goals: return their fixed program structure,
    # not a traditional split picker.
    if not _is_lifting_goal(goal):
        # Check by both bucket and raw goal id, since flexibility/
        # stress_relief map to general_health bucket in the goal registry
        # but have dedicated program structures.
        gid = (goal or "").lower().replace(" ", "_")
        prog = _NON_LIFTING_PROGRAMS.get(bucket)
        # Direct goal-id match takes precedence (e.g. 'improve_flexibility'
        # → flexibility program, not general_health).
        # Try: raw goal id, without "improve_" prefix, bucket, and
        # known aliases so longevity/healthy_aging find general_health.
        _PROGRAM_ALIASES = {
            "longevity": "general_health",
            "healthy_aging": "general_health",
            "heart_health": "general_health",
        }
        for key in (gid, gid.replace("improve_", ""), _PROGRAM_ALIASES.get(gid, ""), bucket):
            if key and key in _NON_LIFTING_PROGRAMS:
                prog = _NON_LIFTING_PROGRAMS[key]
                break
        if prog:
            day_labels = prog["day_labels_by_days"].get(
                days,
                prog["day_labels_by_days"].get(
                    min(prog["day_labels_by_days"].keys(), key=lambda k: abs(k - days)),
                    [f"Day {i+1}" for i in range(days)],
                ),
            )
            return [SplitOption(
                id="auto",
                name=prog["name"],
                short_name=prog["short_name"],
                description=prog["description"],
                days_per_week_range=prog["days_per_week_range"],
                day_labels=day_labels[:days],
                rationale=f"Your {prog['short_name'].lower()} program is structured automatically based on your {days} training days.",
                fit_score=100,
                is_recommended=True,
                stimulus_note=prog["stimulus_note"],
                pros=prog["pros"],
                cons=prog["cons"],
            )]
        # Unknown non-lifting bucket — return empty
        return []

    # Lifting goals: return traditional splits
    from .region_priority import normalize_region, split_region_warning
    region = normalize_region(target_focus)

    class _FakeInputs:
        def __init__(self):
            self.preferred_split = None
            self.days_per_week = days
            self.goal = goal
            self.experience = exp
            self.focused_muscle = None
            self.priority_region = region
    auto_pick = pick_split(_FakeInputs())

    options: list[SplitOption] = []
    for split_id, defn in _SPLIT_DEFS.items():
        score = _fit_score(split_id, goal, days, exp, target_focus=target_focus)
        if score == 0:
            continue  # can't run this split with these days

        day_labels = defn["day_labels_by_days"].get(
            days,
            defn["day_labels_by_days"].get(
                min(defn["day_labels_by_days"].keys(), key=lambda k: abs(k - days)),
                [f"Day {i+1}" for i in range(days)],
            ),
        )

        warning = split_region_warning(region, split_id, days)
        options.append(SplitOption(
            id=split_id,
            name=defn["name"],
            short_name=defn["short_name"],
            description=defn["description"],
            days_per_week_range=defn["days_per_week_range"],
            day_labels=day_labels[:days],
            rationale=_rationale(split_id, goal, days, exp, target_focus=target_focus),
            fit_score=score,
            is_recommended=(split_id == auto_pick),
            stimulus_note=defn["stimulus_note"],
            pros=defn["pros"],
            cons=defn["cons"],
            region_warning=warning,
        ))

    options.sort(key=lambda o: (-o.is_recommended, -o.fit_score))
    return options
