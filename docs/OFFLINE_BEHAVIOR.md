# Offline Behavior

## What Works Without Internet

| Feature | Offline? | How |
|---------|----------|-----|
| View workout plan | Yes | Cached in AsyncStorage (`aiWorkoutPlan`) |
| Start and complete a workout | Yes | All tracking is local (AsyncStorage) |
| Log sets, reps, weight | Yes | Saved locally, synced to backend when online |
| View exercise library | Yes | Cached for 24h in AsyncStorage |
| View exercise images | Partial | Cached by React Native's image cache after first load |
| View meal plan | Yes | All nutrition plans cached per-day in AsyncStorage |
| Check off meals | Yes | Meal checks saved locally |
| Edit meals (add/remove items) | Yes | Saved locally |
| Log weight | Yes | Weight history stored in AsyncStorage |
| View weight history | Yes | All local |
| View workout history | Yes | All local |
| View progress/PRs | Yes | Computed from local history |
| Switch workout day focus | Partial | Label change works offline; exercise regeneration needs backend |
| Timer (rest timer, timed exercises) | Yes | Fully client-side |
| Theme selection | Yes | Instant, local preference |
| Profile settings (view) | Yes | Cached in AsyncStorage |

## What Requires Internet

| Feature | Why |
|---------|-----|
| Initial plan generation | AI generates nutrition plan; planner needs backend for fresh-day generation |
| AI coach chat | Calls OpenAI via backend |
| Food photo scanning | Sends image to OpenAI |
| Food search (USDA/AI) | Backend API call |
| Barcode scanning | Calls OpenFoodFacts via backend |
| Exercise search (beyond library) | wger.de or AI via backend |
| Body scan (photo analysis) | AI call |
| Weight recommendation fetch | Backend calculates from DB history |
| Fatigue score | Backend computes from WorkoutCompletion table |
| Workout completion sync | Writes to backend DB |
| Push notifications scheduling | Needs to register with notification service |
| Plan regeneration | Backend planner + AI |

## How Offline Degradation Works

### Workout Plan
The full workout plan is cached in `aiWorkoutPlan` (AsyncStorage). When the app loads:
1. Plan loads from cache immediately — no network needed
2. `generateWorkoutDay` is called to refresh today's exercises — if this fails (no network), the cached plan is used
3. The user sees their plan instantly; the fresh-day call is best-effort

### Exercise Library
Fetched from `/meta/exercises` and cached for 24h in `exercise_library_cache_v1` (AsyncStorage). After first load, the library works offline for a full day.

### Exercise Images
Cached in `exercise_image_map_v1` (AsyncStorage). Image URLs are stored locally; the actual images are cached by React Native's built-in HTTP image cache. After first render, images show offline.

### Meal Plans
Each day's nutrition plan is saved per-date in AsyncStorage. The 7-day rotation is loaded from `aiNutritionPlans`. Edits (add food, remove food, rename meal) save locally and sync to backend when available.

### Workout Tracking
The entire ActiveWorkoutScreen runs locally:
- Set logging → AsyncStorage (`activeWorkoutSets`)
- Rest timer → client-side
- Exercise progression tips → pre-stamped on plan data (no live API needed)
- Completion → saves to local history, queues backend sync

### Fatigue Score
The readiness badge and muscle fatigue bars require a backend call (`/workouts/fatigue`). If the call fails, the UI shows "Fresh (100%)" as a safe default. The fatigue system only provides value after the user has logged workouts via the backend, so offline users without recent synced completions would see "Fresh" anyway.

## Sync Behavior

When the app comes back online:
- `logWorkoutDone` sends any completed workouts to the backend
- `syncOnboarding` pushes profile changes
- `upsertDayState` syncs meal plan state per-day
- Fresh-day generation runs on next `loadPlans`

There is no explicit offline queue — each feature handles its own retry. Failed backend calls are caught silently and the app continues with local data.

## What Could Be Improved

1. **Explicit offline queue** — buffer failed API calls and replay when connectivity returns
2. **Offline food search** — cache the full USDA food database locally (large but possible)
3. **Offline fatigue** — compute from local workout history instead of requiring backend
4. **Sync status indicator** — show the user when data hasn't been synced yet
5. **Conflict resolution** — if the user edits a meal offline and the backend has a different version, decide which wins
