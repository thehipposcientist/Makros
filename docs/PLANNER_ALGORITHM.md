# Workout Planner Algorithm

Last updated: 2026-04-29

## Overview

The workout planner is fully deterministic. Given the same inputs, it produces the same plan every time. No AI is involved in exercise selection, split logic, weekly recipe generation, or prescription.

AI is used separately for nutrition plans, the coach chat, text fallback search, and dedicated image-analysis endpoints — but never for the core workout programming. Legacy AI plan review is effectively disabled (`PLAN_REVIEW_ENABLED=0` is a no-op). In-workout set recommendations are deterministic first, with AI review only when the deterministic result is flagged as suspicious.

## Pipeline

```
UserProfile
  |
  v
GoalProfile (goal_profiles.py)
  - training mix fractions (strength/hypertrophy/power/conditioning/mobility/recovery)
  - allowed archetypes
  - planner mode (lifting, lifting_plus_cardio, endurance, athletic, hyrox, maintain, mobility, recovery)
  |
  v
WeeklyRecipe (weekly_recipe.py)
  - mode-specific recipe generator
  - recovery allocation (separate from conditioning)
  - recent-focus rotation (avoid repeating yesterday's focus)
  - adjacent duplicate repair
  - intensity-cost spacing (no 3+ consecutive heavy days)
  - recovery window insertion
  - rolling fatigue threshold check
  |
  v
DayArchetype + Slots (day_templates.py, slots.py)
  - archetype -> slot list (primary compound, secondary compound, isolation, accessories)
  - focus-aware slot variants (glute-biased, upper-focus, etc.)
  - density trimming based on session_minutes budget
  |
  v
ExerciseSelection (planner.py)
  - per-slot candidate filtering:
    - muscle match (primary muscle compatible with slot hint)
    - equipment match (user's owned equipment)
    - injury pattern blocking (3-layer system)
    - dislike exclusion (user's thumbs-down exercises)
    - focus family gating (no pull exercises on push days)
  - scoring: familiarity bonus, variation penalty, focus bonus, mobility penalty
  - pick top-scoring candidate per slot
  |
  v
Prescription (prescriptions.py)
  - archetype-specific: lifting (sets x reps x rest), cardio (duration), mobility (holds/flows), recovery (easy duration), hybrid (dispatches per exercise)
  - session_minutes budget scaling
  - conditioning: interval count, tempo duration, zone 2 duration
  |
  v
Recovery/Mobility Day Generation (planner.py)
  - generate_recovery_day(session_minutes) — scales exercises to time budget
    - 20min: core stretches only (foam rolling + stretching)
    - 30min: +pigeon pose, forward fold
    - 40min: +easy walk
    - 50min: +quad stretch, shoulder stretch, dead hang
    - 60min: all exercises included
  - generate_mobility_day(session_minutes) — scales drills to time budget
    - 20min: 7 base drills (foam rolling, flows, hip circles, etc.)
    - 35min: +couch stretch, pull-aparts
    - 45min: +straddle, wall slides, dead hang
    - 55min: +butterfly, spinal twist, savasana
  |
  v
SetProgramming (set_programming.py)
  - per-set intent: warmup / heavy_top / backoff / volume / technique
  - equipment-aware load increments
  - next-set recommendations (deterministic, AI-reviewed when suspicious)
  |
  v
Validation (planner.py validate_plan)
  - no empty days
  - no duplicate exercises within a day
  - no adjacent same-focus days
  - compound exercises on correct-family days
  - split identity preserved
  - consecutive heavy day audit
  - region priority audit
```

## Goal Profiles

| Goal | Mode | Strength | Hypertrophy | Power | Conditioning | Mobility | Recovery |
|------|------|----------|-------------|-------|--------------|----------|----------|
| muscle_gain | lifting | 0.20 | 0.70 | — | 0.05 | 0.05 | — |
| strength | lifting | 0.70 | 0.20 | — | 0.05 | 0.05 | — |
| body_recomp | lifting_plus_cardio | 0.25 | 0.50 | — | 0.15 | 0.10 | — |
| fat_loss | lifting_plus_cardio | 0.10 | 0.40 | — | 0.35 | 0.10 | — |
| endurance | endurance | 0.10 | 0.05 | — | 0.65 | 0.10 | — |
| athletic | athletic | 0.30 | 0.15 | yes | 0.25 | 0.10 | — |
| hyrox | hyrox | 0.15 | 0.10 | — | 0.45 | 0.10 | — |
| general_health | maintain | 0.15 | 0.25 | — | 0.25 | 0.20 | — |

## Recovery Allocation (Separate from Conditioning)

Recovery is distinct from conditioning. Zone 2 runs and intervals are training stress; recovery is active rest (mobility flow, easy walk, stretching).

### Rules
| Days/Week | Recovery Days | Notes |
|-----------|--------------|-------|
| 1-5 | 0 | User already has 2+ off days |
| 6 | 0 (default), 1 for recovery-friendly goals | general_health, maintain, longevity, healthy_aging |
| 7 | 1 always | User has no off days — must schedule recovery |

### Recovery Day Archetype
Recovery days use `MOBILITY_FLOW`, placed at end of week. This is NOT a conditioning day — it carries negative fatigue values that actively reduce accumulated muscle fatigue.

### Formula
```
total_days = lifting_days + conditioning_days + recovery_days
conditioning_days = total_days - lifting_days - recovery_days
```

This prevents the old bug where 7-day recomp users got 5 lifting + 2 conditioning with zero actual rest.

## Intensity Spacing

The `_space_high_intensity_days` function runs 5 passes after recipe generation:

1. **Heavy streak guard**: No 3+ consecutive heavy (cost >= 4) days. Swaps or downgrades.
2. **Rolling 3-day fatigue window**: Sum fatigue_cost over each 3-day window. Threshold: 1.8 for lifting goals, 1.5 for others.
3. **Heavy legs protection**: Heavy legs after 2+ accumulated hard days gets downgraded.
4. **Recovery windows**: After 3 consecutive resistance days, insert a low-cost day.
5. **Pairwise spacing**: Cost-5 never adjacent to cost-4/5.

Heavy-to-volume downgrade map:
- LIFT_PUSH_HEAVY -> LIFT_PUSH_VOLUME
- LIFT_PULL_HEAVY -> LIFT_PULL_VOLUME
- LIFT_LEGS_HEAVY -> LIFT_LEGS_VOLUME
- LIFT_UPPER_HEAVY -> LIFT_UPPER_HYPERTROPHY
- LIFT_LOWER_HEAVY -> LIFT_LOWER_HYPERTROPHY
- LIFT_FULL_BODY_STRENGTH -> LIFT_FULL_BODY

## 7-Day Recovery Rules

| Goal | Recipe Shape |
|------|-------------|
| body_recomp (7d) | 5 lift + 1 zone 2 + 1 mobility |
| fat_loss (7d) | 4 lift + 2 cardio + 1 hybrid |
| muscle_gain (7d) | 6 lift + 1 mobility |
| strength (7d) | 6 lift (heavy spacing handles recovery) |
| hyrox (7d) | 2 lift + 3 conditioning + 1 hybrid + 1 mobility |

## Injury System (Three Layers)

### Layer 1: Movement Pattern Blocking
Active injuries hard-block dangerous movement patterns. The planner's `filter_candidates()` excludes exercises matching blocked patterns.

### Layer 2: Recovering Mode
Injuries with `status=recovering` use a softer blocklist. Only the most dangerous patterns stay blocked; others move to "reduced volume" where exercises are allowed but with fewer sets.

### Layer 3: Muscle Group Mapping
Each injury maps to affected muscle groups for fatigue system awareness.

### Injury Coverage

| Injury | Blocked Patterns (Active) | Recovering Allows | Muscle Groups |
|--------|--------------------------|-------------------|---------------|
| lower_back | hinge, squat | horizontal_press, horizontal_pull | back, core, hamstrings |
| knee | squat, lunge | — | quads, hamstrings |
| shoulder | overhead_press, vertical_pull | horizontal_press | shoulders, chest |
| hip | squat, lunge, hinge | — | glutes, quads, hamstrings |
| hip_flexor | hinge, lunge | — | quads, core |
| ankle | lunge | squat | calves |
| achilles | lunge | — | calves |
| elbow | isolation | horizontal_press, horizontal_pull | biceps, triceps |
| tennis_elbow | isolation, horizontal_pull | horizontal_press | biceps, triceps |
| golfer_elbow | isolation | horizontal_pull | biceps |
| wrist | isolation | — | (forearm-related) |
| chest | horizontal_press | — | chest |
| neck | overhead_press | — | shoulders |

### InjuryEntry Schema (Frontend)
```typescript
interface InjuryEntry {
  id: string;
  description: string;
  bodyPart: string;              // body part picker, not free text
  muscleGroups?: string[];       // pre-mapped from bodyPart
  severity?: 'mild' | 'moderate' | 'severe';
  reportedAt: string;
  estimatedRecoveryDays?: number;  // AI-estimated
  estimatedRecoveryDate?: string;  // computed from reportedAt + estimatedRecoveryDays
  status: 'active' | 'recovering' | 'resolved';
  statusUpdatedAt?: string;
}
```

Injuries are managed in the **Workout Settings** sub-tab (moved from Goal tab).

## Exercise Dislike System

Users can thumbs-down exercises during active workouts. Disliked exercises:
- Are stored in `PlannerInputs.disliked_exercises`
- Are excluded by `filter_candidates()` before scoring
- Persist across plan regenerations
- The planner selects the next-best-scoring candidate for the same slot

## Cardio Classification

Exercises are classified by `cardio.py`:

| Category | Examples |
|----------|---------|
| Intervals | jump rope, HIIT, sprints, hills, battle ropes, burpees, assault bike, mountain climbers |
| Steady | treadmill run, stationary bike, elliptical, stair climber, rowing machine, cycling, swimming |
| Easy | walking, jogging, incline walk, zone 2 |

Zone 2 days only pick steady/easy exercises. Jump rope is classified as intervals and won't appear on a Zone 2 day.

## Set Programming

The `set_programming.py` module handles intra-workout structure:

### Set Roles
- **warmup** — not emitted in set scheme (shown as separate UI cues)
- **heavy_top** — highest load, lowest reps in the prescription range
- **backoff** — reduced load after heavy top sets
- **volume** — standard working sets
- **technique** — lighter load, focus on form

### Load Increments
Equipment and exercise-type aware:
- Barbell compounds: +5 lb (upper), +10 lb (lower)
- Dumbbell: +5 lb
- Cable/machine: +5 lb
- Bodyweight: +reps or add external load

### Next-Set Recommendations
1. Deterministic recommender runs first (always)
2. `is_suspicious()` checks for: feel-reps disagreement, first session of exercise, big overshoot/undershoot
3. If suspicious -> AI review via `in_workout_review.py`
4. AI receives deterministic result as context; can confirm, override, or soften
5. Response tagged with `source: "deterministic"` or `source: "ai_reviewed"`

## Focus Auto-Correction

On workout completion:
1. Backend resolves per-exercise muscle fatigue
2. Top worked muscles (excluding systemic, > 0.1 threshold) are extracted
3. `_infer_focus_from_muscles()` maps them to a focus label using rules:
   - Lower-body muscles without upper = "Legs"
   - Lower + upper = "Full Body"
   - Chest/triceps without back/biceps = "Push"
   - Back/biceps without chest/triceps = "Pull"
   - Mixed upper = "Upper Body"
4. If inferred focus differs from original label, it's corrected
5. This prevents labels like "Recovery" persisting on what was actually a leg day

## Multiple Completions Per Day

Workout completion upsert key: `(user_id, workout_date, focus_label)` — not `(user_id, workout_date)`.
- Legs morning + sauna evening = 2 separate WorkoutCompletion rows
- Both feed into fatigue system correctly
- WorkoutSession upsert also keyed by (user, date, focus) for consistency

## Where AI Is Used

| Feature | AI? | Model | Notes |
|---------|-----|-------|-------|
| Workout plan generation | No | — | Fully deterministic |
| Exercise selection | No | — | Score-based candidate picking |
| Weekly recipe | No | — | Goal profile + split rules |
| Split recommendation | No | — | Matrix lookup |
| Weight recommendations | No | — | Set programming rules |
| Fatigue scoring | No | — | 12-muscle rolling decay (two-pass) |
| Fitness score | No | — | 4-pillar composite |
| Recovery/mobility day generation | No | — | Time-scaled exercise lists |
| Focus auto-correction | No | — | Muscle-to-focus inference |
| Nutrition plan generation | Yes | gpt-4o-mini | Structured JSON prompts |
| AI coach chat | Yes | gpt-4o-mini | Unified workout + nutrition |
| Food photo scan | Yes | gpt-5.4-mini | HEIC-safe via _fix_image_mime |
| Food search (fallback) | Yes | gpt-4o-mini | USDA primary |
| Exercise search (fallback) | Yes | gpt-4o-mini | wger primary |
| Supplement / equipment / form / body photo scans | Yes | gpt-5.4-mini | Dedicated image-analysis routes |
| Plan review (legacy path) | No | — | Permanently disabled in current app path |
| In-workout set review | No | — | Deterministic suspicion reviewer only |
| Food enrichment | Yes | gpt-4o-mini | food_quality classification |
| Injury assessment | Yes | gpt-4o-mini | Severity, muscle groups, recovery estimate |

## External Data Sources

| Source | Used For | Cost |
|--------|----------|------|
| USDA FoodData Central | Food nutrition search (primary) | Free (1000 req/hr with API key) |
| wger.de | Exercise images + exercise search (primary) | Free |
| OpenAI | AI features (see above) | ~$0.15/1M input tokens |
