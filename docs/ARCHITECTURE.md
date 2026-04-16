# Architecture — Key Files

## Workout Planner

| File | Purpose |
|---|---|
| `backend/app/services/workout/planner.py` | Exercise selection, scoring, filtering, volume tracking, plan validation |
| `backend/app/services/workout/weekly_recipe.py` | Weekly day sequencing, rotation, adjacency repair, intensity spacing |
| `backend/app/services/workout/archetypes.py` | Day type vocabulary (Upper Heavy, Push Volume, Zone 2, etc) |
| `backend/app/services/workout/goal_profiles.py` | Goal to training profile mapping (planner mode, allowed archetypes) |
| `backend/app/services/workout/split_options.py` | Split recommendation engine (scoring, rationale, pros/cons) |
| `backend/app/services/workout/prescriptions.py` | Stimulus-aware sets/reps/rest dispatch |
| `backend/app/services/workout/slots.py` | Per-archetype slot builders (exercise slot layout per day type) |
| `backend/app/services/workout/set_programming.py` | Per-set scheme (heavy_top, backoff, volume, technique roles) |
| `backend/app/services/workout/history.py` | Recent workout history (focus families, stress buckets) |
| `backend/app/services/workout/focus_normalize.py` | Normalize raw focus labels to coarse buckets + fine families |

## Nutrition

| File | Purpose |
|---|---|
| `backend/app/services/nutrition/meal_assembler.py` | Meal plan assembly (skeleton AI + deterministic solver) |
| `backend/app/services/nutrition/plan_review.py` | Nutrition plan QA (macro + micro auditing, patches) |
| `backend/app/services/nutrition/context.py` | Shared nutrition context for all AI surfaces |
| `backend/app/services/nutrition/calorie_calculator.py` | TDEE and macro target computation |

## API / Orchestration

| File | Purpose |
|---|---|
| `backend/app/routers/ai/plans.py` | Plan generation endpoints, AI review wiring, history queries |
| `backend/app/routers/ai/chat.py` | Trainer/nutritionist chat endpoints |
| `backend/app/routers/ai/progression.py` | In-workout recommendations, pre-set guidance, warmup |
| `backend/app/routers/ai/utils.py` | Food enrichment, OpenAI helpers, model selection |
| `backend/app/routers/ai/scanning.py` | Food photo scan, body scan, form analysis, exercise search |
| `backend/app/routers/workouts.py` | Workout completion, exercise history |
| `backend/app/routers/coach.py` | Weekly check-in, rollups, flags |

## Frontend

| File | Purpose |
|---|---|
| `src/screens/HomeScreen.tsx` | Main app screen (workout schedule, meal plan, tabs) |
| `src/screens/ActiveWorkoutScreen.tsx` | Active workout session (set logging, AI tips, timer) |
| `src/screens/EditProfileScreen.tsx` | Goal/equipment/food/macro settings + split picker |
| `src/screens/ProgressScreen.tsx` | Fitness score, diet consistency, records, charts |
| `src/screens/OnboardingScreen.tsx` | Goal/equipment/food onboarding flow |
| `src/components/NutritionCard.tsx` | Daily nutrition display + micronutrient modal |
| `src/components/WorkoutCard.tsx` | Workout day card with exercise list + time estimate |
| `src/components/CoachCheckinModal.tsx` | Weekly check-in modal |
| `app/index.tsx` | App entry, auth, plan generation orchestration |

## Data Flow

```
User profile (goal, days, equipment, foods, split preference)
  |
  v
PlanRequest → backend/app/routers/ai/plans.py
  |
  ├── Workout: planner.py → weekly_recipe → slots → pick_for_slot → prescriptions
  │     └── Output: days[] with exercises, sets, reps, stimulus, warmups
  │
  ├── Nutrition: meal_assembler.py → skeleton AI → solver → normalizer
  │     └── Output: templates[] with meals, macros, micronutrients
  │
  ├── AI Review (optional): plan_review.py → patches applied
  │
  └── Notes: trainer note + nutritionist note (grounded in final data)
  |
  v
Client: AsyncStorage → HomeScreen → WorkoutCard / NutritionCard
```
