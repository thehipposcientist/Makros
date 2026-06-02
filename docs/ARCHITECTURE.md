# Architecture — Key Files

## Workout Planner

| File | Purpose |
|---|---|
| `backend/app/services/workout/planner.py` | Exercise selection, scoring, filtering, volume tracking, plan validation |
| `backend/app/services/workout/week_manager.py` | Persists generated plans into fixed dated `PlanWeek` / `PlanDay` rows |
| `backend/app/services/workout/planner_context.py` | Builds consistent planner inputs for first week, auto-renew, day patch, and injury-repair paths |
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
| `backend/app/services/nutrition/meal_assembler.py` | Meal plan assembly (AI skeletons + deterministic solver/normalizer) |
| `backend/app/services/nutrition/score_builder.py` | Server-authoritative projected-day nutrition score context from `UserDayState` / `PlanDay` |
| `backend/app/services/nutrition/nutrition_score.py` | Nutrition Score formula and overall health-score helper |
| `backend/app/services/nutrition/recovery_flags.py` | Fueling and recovery flags; never scored |
| `backend/app/services/nutrition/context.py` | Shared nutrition context for all AI surfaces |
| `backend/app/services/nutrition/calorie_calculator.py` | TDEE and macro target computation |
| `backend/app/services/nutrition/hydration.py` | Adaptive hydration target formula; supports heat add-on when callers provide ambient temperature |

## API / Orchestration

| File | Purpose |
|---|---|
| `backend/app/routers/plan_weeks.py` | Active PlanWeek source-of-truth endpoints, auto-renew, per-day patches, check-ins |
| `backend/app/routers/ai/plans.py` | Legacy/background plan artifact endpoints and nutrition/workout generation jobs |
| `backend/app/routers/ai/chat.py` | Home trainer and in-workout chat endpoints |
| `backend/app/routers/ai/progression.py` | In-workout recommendations, pre-set guidance, warmup |
| `backend/app/routers/ai/utils.py` | OpenAI helpers, model selection, tagged usage telemetry |
| `backend/app/routers/ai/scanning.py` | Food photo scan, body scan, form analysis, exercise search |
| `backend/app/routers/workouts.py` | Workout completion, fatigue, history, weekly review, weekly volume |
| `backend/app/routers/meals.py` | Logged meals, hydration, nutrition score, gut facts, recovery flags |
| `backend/app/routers/coach.py` | Check-ins, rollups, flags, user-confirmed apply-action path |
| `backend/app/routers/readiness.py` | Canonical server readiness score consumed by phone and Watch |

## Frontend

| File | Purpose |
|---|---|
| `src/screens/HomeScreen.tsx` | Main app shell: Friends, Workouts, Meals, Progress, You tabs |
| `src/screens/ActiveWorkoutScreen.tsx` | Active workout session (set logging, AI tips, timer) |
| `src/screens/EditProfileScreen.tsx` | Goal/equipment/food/macro settings + split picker |
| `src/screens/ProgressScreen.tsx` | Today, Trends, Body, and Health progress tabs |
| `src/screens/GearScreen.tsx` | Gear inventory, mileage tracking, AI gear identification |
| `src/screens/SettingsScreen.tsx` | Notifications, units, HealthKit, app settings, account actions |
| `src/screens/OnboardingScreen.tsx` | Goal/equipment/food onboarding flow |
| `src/components/LiveActivityTracker.tsx` | Custom/live activity timer, HR zones, outdoor-cardio GPS distance/pace/route |
| `src/utils/cardioGpsTracker.ts` | Phone-side GPS tracker for outdoor run/walk/ride/hike sessions |
| `src/components/NutritionCard.tsx` | Daily nutrition display + micronutrient modal |
| `src/components/WorkoutCard.tsx` | Workout day card with exercise list + time estimate |
| `src/components/CoachCheckinModal.tsx` | Weekly check-in modal |
| `app/index.tsx` | App entry, auth, plan generation orchestration |

## Data Flow

```
User profile (goal, days, equipment, foods, split preference)
  |
  v
Plan request / auto-renew → backend/app/routers/plan_weeks.py
  |
  ├── Workout: planner.py → weekly_recipe → slots → pick_for_slot → prescriptions
  │     └── Output: days[] with exercises, sets, reps, stimulus, warmups
  │
  ├── Nutrition: meal_assembler.py → skeleton AI → solver → normalizer
  │     └── Output: templates[] with meals, macros, micronutrients
  │
  ├── Persistence: week_manager.py → PlanWeek + 7 dated PlanDay rows
  │
  └── Notes: trainer note + nutritionist note (grounded in final data)
  |
  v
Client: /plans/week/active → HomeScreen → WorkoutCard / NutritionCard
         |
         └── AsyncStorage hot/offline cache only; DB wins on conflict
```

The legacy `WorkoutPlan` / `NutritionPlan` tables still carry AI artifacts and templates, but the front-page schedule comes from the active `PlanWeek`. The legacy workout/nutrition AI review flags are disabled no-ops; weekly review recommendations apply through explicit user confirmation and mutate durable settings or day state, never the active PlanWeek directly.
