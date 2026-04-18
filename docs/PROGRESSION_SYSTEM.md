# Progressive Overload & Weight Recommendation System

## Overview

The progression system determines what weight and reps the user should use for each exercise based on their training history. It is fully deterministic — no AI involved. The system operates at three levels:

1. **Starting weight** — for exercises the user has never done (layered transfer pipeline)
2. **Session-to-session** — based on last session's performance (double progression)
3. **In-workout** — set-by-set adjustments during the active workout

## End-to-End Data Flow

```
User completes workout
  → ExerciseSet rows saved (actual_weight_lbs, actual_reps, completed=true)
  → build_performance_profile() calculates Epley 1RM per exercise
  → Next plan generation calls propagate_session_targets()
    → For each exercise: look up last session → apply double progression
    → Stamp targetWeightLbs + progressionAction + reason onto plan
  → UI shows "Last: 135x8 → Try 140 lbs"
```

## Load Increments

Determined by `load_increment_for()` based on exercise type:

| Equipment + Type | Increment |
|-----------------|-----------|
| Barbell compound, lower body (squat/deadlift) | 10 lbs |
| Barbell compound, upper body (bench/row/OHP) | 5 lbs |
| Dumbbell compound | 5 lbs (+2.5 per hand) |
| Dumbbell/cable isolation | 2.5 lbs |
| Machine compound | 5 lbs |
| Machine isolation | 2.5 lbs |
| Bodyweight | 0 (reps/tempo only) |

Modified by pace: conservative=0.5x, moderate=1.0x, aggressive=1.5x.

## Session-to-Session Progression (Double Progression)

`recommend_next_session_load()` — the core decision function.

**Inputs:**
- Last session's working sets: `[{reps, weight_lbs}]`
- Target rep range: e.g., (8, 12)
- Progression mode: `load_first` or `reps_first`

**Logic:**
1. Find the heaviest weight used last session (`top_weight`)
2. Collect all reps achieved at that weight
3. Classify performance:

| Condition | Action | Example |
|-----------|--------|---------|
| ALL sets hit top of rep range | Increase weight by 1 increment | All 3 sets hit 12+ reps at 135 → increase to 140 |
| MAJORITY (>50%) missed bottom of range | Decrease weight by 1 increment | 2 of 3 sets below 8 reps → drop to 130 |
| Otherwise | Hold weight, push for more reps | 2 sets at 10, 1 set at 8 → stay at 135 |

**Mode matters:**
- `load_first` (strength goals, primary compounds): when all sets hit top → add weight
- `reps_first` (hypertrophy, accessories): when all sets hit top → hold weight, chase one more rep next time

**Safety override:** If ANY set has `pain` or `form_breakdown` feedback → reduce weight 10% regardless of reps.

## Starting Weight Pipeline (5-Tier Transfer)

For exercises the user has never done, `recommend_starting_weight()` estimates from related exercises:

| Tier | Source | Transfer Factor | Confidence | Example |
|------|--------|----------------|------------|---------|
| 1 | Exact history | 1.00 | 0.53–0.95 | User has done barbell bench before |
| 2 | Substitution group | 0.95 | 0.40–0.70 | Dumbbell bench → barbell bench (same sub group) |
| 3 | Movement pattern | 0.85 | 0.40 flat | Incline press → flat bench (same horizontal_press) |
| 4 | Muscle bucket | 0.75 | 0.25 flat | Cable fly → bench press (same chest + gym bucket) |
| 5 | Category default | — | 0.10 flat | No related exercises at all |

**Transfer calculation:**
```
working_weight = estimated_1rm × %1RM_for_target_reps × transfer_factor
```

**%1RM table (Epley-derived):**

| Reps | %1RM |
|------|------|
| 1 | 95% |
| 3 | 90% |
| 5 | 85% |
| 8 | 78% |
| 10 | 73% |
| 12 | 68% |
| 15 | 62% |
| 20 | 53% |

**Category defaults** (when no history exists at all):

| Category | Beginner | Intermediate | Advanced |
|----------|----------|--------------|----------|
| Upper push (bench) | 65 lbs | 95 lbs | 135 lbs |
| Upper pull (row) | 55 lbs | 85 lbs | 115 lbs |
| Squat | 85 lbs | 135 lbs | 185 lbs |
| Hinge (deadlift) | 95 lbs | 155 lbs | 225 lbs |
| Isolation upper | 15 lbs | 25 lbs | 35 lbs |
| Isolation lower | 40 lbs | 70 lbs | 100 lbs |
| Machine | 50 lbs | 80 lbs | 120 lbs |

## Set Scheme Construction

`build_set_scheme()` builds per-set programs with different types:

### Set Types
- **heavy_top**: Highest load of the session. Gets a small bump above anchor.
- **backoff**: 90% of heavy_top. Working volume.
- **volume**: Standard load. Most accessories and hypertrophy work.
- **technique**: 75% of anchor. Skill/mobility exercises.

### Scheme by Goal + Role

| Goal | Role | Set 1 | Set 2-3 | Set 4+ |
|------|------|-------|---------|--------|
| Strength + primary compound | heavy_top (load_first) | backoff (load_first) | backoff (load_first) |
| Hypertrophy + primary compound | heavy_top (load_first) | backoff (reps_first) | volume (reps_first) |
| Beginner / maintenance | volume (reps_first) | volume (reps_first) | volume (reps_first) |
| Isolation / accessories | volume (reps_first) | volume (reps_first) | volume (reps_first) |

### Heavy Top Load Calculation
```
mid_reps = (lo + hi) / 2
delta = max(0, mid − lo)
bump = min(0.12, 0.03 × delta)     # capped at 12%
heavy_top = anchor × (1.0 + bump)   # rounded to increment
backoff = heavy_top × 0.90          # 10% reduction
```

## Performance Profiles

`build_performance_profile()` aggregates from the last 28 days:

**Per exercise:**
- `session_count`: number of unique training dates (capped at 6)
- `recent_top_weight_lbs`: heaviest weight used
- `recent_top_reps`: reps at top weight
- `estimated_1rm_lbs`: Epley formula = `weight × (1 + reps / 30)`
- `recent_volume_load`: sum of (weight × reps) across all sets
- `confidence`: session_count / 6 (scales from 0.17 to 1.0)

## Plateau Detection

`detect_plateau()` checks the last 56 days:

**Stall condition:** Most recent session's top-set score ≤ best of the prior 2+ sessions.

| Stalled Sessions | Action |
|-----------------|--------|
| 3 | Hold load, chase reps — patient accumulation |
| 4 | Swap exercise variation — break movement staleness |
| 5+ | Small deload — reduce ~10% for one week, rebuild |

## In-Workout Recommendations

During the active workout, `recommend_next_set()` provides per-set guidance:

- If the user logged fewer reps than target on the last set → suggest same weight, "focus on form"
- If the user hit top of range → suggest same weight or slight increase
- If the user reported pain → suggest 10% weight reduction
- Timed exercises (boxing, yoga, cardio) → no weight recommendation, contextual tips only

## UI Display

On each exercise card in the active workout:
```
Barbell Bench Press
3 × 8-12  ·  90s rest
Last: 135×8 → Try 140 lbs        ← progression recommendation
```

Shows when:
- User has at least 1 completed session for this exercise
- The planner stamped `targetWeightLbs` during plan generation
- Exercise is weight-based (not timed/bodyweight)

## Key Files

| File | Purpose |
|------|---------|
| `set_programming.py` | Load increments, set schemes, session-to-session progression |
| `recommendation.py` | 5-tier starting weight pipeline with transfer factors |
| `history.py` | DB queries for last session, propagation across plan |
| `performance.py` | Performance profiles, Epley 1RM, plateau detection |
| `planner.py` (propagate_session_targets) | Stamps progression onto generated plans |
