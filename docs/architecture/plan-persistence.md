# Plan Persistence + Cache — Architecture

Last synced from CLAUDE.md: 2026-04-27

## DB as Source of Truth

- `WorkoutPlan` + `NutritionPlan` tables — one `is_active=True` row per user, stamped with `planner_version` + `created_at`.
- Every plan generation writes DB first, then mirrors to AsyncStorage.
- On conflict between DB and AsyncStorage, **DB wins**.
- Cross-device sync: both devices pull latest `WorkoutPlan` row on app-open.

## AsyncStorage Hot Cache

- Client loads from DB via `GET /ai/plan` + `GET /ai/nutrition-plan`, then caches as `aiWorkoutPlan` / `aiNutritionPlans`.
- `PLANNER_VERSION` mismatch or plan older than 30 days → `isPlanStale` flag → silent background regen.

## Scoped Cache Clear (`src/utils/planCacheReset.ts`)

Three functions, each matching a domain by substring pattern:
- `clearWorkoutCache()` — clears `workoutDayState_*` and related keys.
- `clearMealCache()` — clears `mealPlan_*`, `preservedMeal_*`, and related keys.
- `clearAllPlanCache()` — both domains.

`PRESERVED_KEYS` safelist: auth tokens, userProfile, weightEntries, workoutHistory, themePreference, metaData_v1.

`applyPlanResult` calls the appropriate clear **before** writing the new plan, so a workout-only regen doesn't wipe meal state.

## Plan Generation Entry Points

All three must pass the same shape of inputs to the planner:
1. **Single-day** (`GET /workouts/generate-day`) — `focus_override` param.
2. **Full regen** (`routers/ai/plans.py::_build_deterministic_workout`) — triggered by `isPlanStale` or explicit user regen.
3. **Change Focus** (`POST /workouts/generate-week` with `change_mode=smart`) — `day_statuses` + `change_mode` params.

## History Plumbing

- `prev_focuses` — raw focus labels from recent completions. Normalized to `recent_focus_buckets` (coarse) + `recent_focus_families` (fine: push/pull/legs).
- Both feed `generate_weekly_recipe` rotation to avoid back-to-back same focus.
- History brief includes `user_preferred_split` + `skipped_days_7d` for reviewer context.
