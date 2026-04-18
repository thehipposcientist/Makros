# Workout Planner Algorithm

## Overview

The workout planner is fully deterministic. Given the same inputs, it produces the same plan every time. No AI is involved in exercise selection, split logic, weekly recipe generation, or prescription.

AI is used separately for nutrition plans, the coach chat, and food/exercise search — but never for the core workout programming.

## Pipeline

```
UserProfile
  |
  v
GoalProfile (goal_profiles.py)
  - training mix fractions (strength/hypertrophy/conditioning/mobility/recovery)
  - allowed archetypes
  - planner mode (lifting, lifting_plus_cardio, endurance, athletic, hyrox, maintain, mobility, recovery)
  |
  v
WeeklyRecipe (weekly_recipe.py)
  - mode-specific recipe generator
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
  |
  v
ExerciseSelection (planner.py)
  - per-slot candidate filtering (muscle match, equipment match, injury filter)
  - scoring: familiarity bonus, variation penalty, focus bonus, mobility penalty
  - pick top-scoring candidate per slot
  |
  v
Prescription (prescriptions.py)
  - archetype-specific sets/reps/rest
  - session_minutes budget scaling
  - conditioning: interval count, tempo duration, zone 2 duration
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

| Goal | Mode | Strength | Hypertrophy | Conditioning | Mobility |
|------|------|----------|-------------|--------------|----------|
| muscle_gain | lifting | 0.20 | 0.70 | 0.05 | 0.05 |
| strength | lifting | 0.70 | 0.20 | 0.05 | 0.05 |
| body_recomp | lifting_plus_cardio | 0.25 | 0.50 | 0.15 | 0.10 |
| fat_loss | lifting_plus_cardio | 0.10 | 0.40 | 0.35 | 0.10 |
| endurance | endurance | 0.10 | 0.05 | 0.65 | 0.10 |
| athletic | athletic | 0.30 | 0.15 | 0.25 | 0.10 |
| hyrox | hyrox | 0.15 | 0.10 | 0.45 | 0.10 |
| general_health | maintain | 0.15 | 0.25 | 0.25 | 0.20 |

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

- body_recomp at 7 days: 5 lift + 1 zone 2 + 1 mobility
- fat_loss at 7 days: 4 lift + 2 cardio + 1 hybrid
- muscle_gain at 7 days: 6 lift + 1 mobility
- strength at 7 days: 6 lift (heavy spacing handles recovery)
- hyrox at 7 days: 2 lift + 3 conditioning + 1 hybrid + 1 mobility

## Fatigue System (v1.5)

### Source of Truth: 12 Muscle-Group Buckets

chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic

### How Fatigue Is Produced

When a workout completes:
1. If per-exercise data exists: each exercise's `primary_muscle` contributes 1.0x fatigue, `secondary_muscles` contribute 0.3x. Compounds add 0.4x systemic, isolation 0.15x.
2. If only focus label exists: static mapping (Push -> chest 0.6, shoulders 0.4, triceps 0.35, systemic 0.25).
3. Stored as `resolved_muscle_fatigue` JSON on the WorkoutCompletion row.

### Time Decay

| Days ago | Multiplier |
|----------|-----------|
| 0 (today) | 1.00 |
| 1 (yesterday) | 0.50 |
| 2 | 0.25 |
| 3 | 0.10 |

### Derived Focus Readiness

Each focus type derives readiness from its constituent muscles:

| Focus | Muscles (importance weight) |
|-------|---------------------------|
| Push | chest(1.0), shoulders(0.8), triceps(0.6) |
| Pull | back(1.0), biceps(0.7), shoulders(0.3) |
| Legs | quads(1.0), glutes(0.8), hamstrings(0.8), calves(0.3) |
| Upper | chest(0.8), back(0.8), shoulders(0.7), biceps(0.5), triceps(0.5) |
| Lower | quads(1.0), glutes(0.9), hamstrings(0.9), calves(0.4) |
| Glute focus | glutes(1.0), hamstrings(0.4), quads(0.3) |
| Full body | all major groups(0.4-0.5), systemic(0.8) |

### Planner Response (Graduated, Not Binary)

| Readiness | Action |
|-----------|--------|
| >= 60% | Proceed as planned |
| 40-60% | Downgrade: heavy -> hypertrophy, hypertrophy -> volume |
| 20-40% | Swap to most-ready alternative focus |
| < 20% | Force recovery/mobility |

## Cardio Classification

Exercises are classified by the `cardio.py` module:

- **Intervals**: jump rope, HIIT, sprints, hills, battle ropes, burpees, assault bike, mountain climbers
- **Steady**: treadmill run, stationary bike, elliptical, stair climber, rowing machine, cycling, swimming
- **Easy**: walking, jogging, incline walk, zone 2

Zone 2 days only pick steady/easy exercises. Jump rope is classified as intervals and won't appear on a Zone 2 day.

## Where AI Is Used

| Feature | AI? | Model | Cost |
|---------|-----|-------|------|
| Workout plan generation | No | — | $0 |
| Exercise selection | No | — | $0 |
| Weekly recipe | No | — | $0 |
| Split recommendation | No | — | $0 |
| Weight recommendations | No | — | $0 |
| Fatigue scoring | No | — | $0 |
| Nutrition plan generation | Yes | gpt-4o-mini | ~$0.01 |
| AI coach chat | Yes | gpt-4o-mini | ~$0.002/msg |
| Food photo scan | Yes | gpt-4o-mini | ~$0.001 |
| Food search (fallback) | Yes | gpt-4o-mini | ~$0.0002 |
| Exercise search (fallback) | Yes | gpt-4o-mini | ~$0.0002 |
| Plan review (optional) | Yes | gpt-4o-mini | ~$0.003 |
| Food enrichment | Yes | gpt-4o-mini | ~$0.001 |

## External Data Sources

| Source | Used For | Cost |
|--------|----------|------|
| USDA FoodData Central | Food nutrition search (primary) | Free (1000 req/hr with API key) |
| wger.de | Exercise images + exercise search (primary) | Free |
| OpenAI | AI features (see above) | ~$0.15/1M input tokens |
