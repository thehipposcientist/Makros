# Offline Behavior

## What Works Without Internet

| Feature | Offline? | How |
|---------|----------|-----|
| View workout plan | Yes | Active `PlanWeek` projected into `aiWorkoutPlan` cache |
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
| Change workout day focus | Partial | UI can keep local edits, but authoritative exercise patch needs backend |
| Timer (rest timer, timed exercises) | Yes | Fully client-side |
| Theme selection | Yes | Instant, local preference |
| Profile settings (view) | Yes | Cached in AsyncStorage |

## What Requires Internet

| Feature | Why |
|---------|-----|
| Initial plan generation | Backend creates the deterministic workout week and AI-assisted nutrition templates |
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
| Plan generation / auto-renew | Backend planner + nutrition assembler |

## How Offline Degradation Works

### Workout Plan
The active week is server-authoritative (`PlanWeek` + 7 dated `PlanDay` rows), and the projected workout shape is cached in `aiWorkoutPlan` for hot/offline rendering. When the app loads:
1. `HomeScreen.loadPlans` asks `GET /plans/week/active` for the DB week.
2. If the backend is unreachable, the cached `aiWorkoutPlan` / nutrition-plan keys render as a fallback.
3. If the returned week has expired (`end_date < today`), the client calls `POST /plans/week/auto-renew` when online.

The old fresh-day-on-open call is gone. A PlanWeek is stable for its full 7-day window unless the user explicitly edits a current/future day through Change Focus, Swap, Skip/Unskip, or a template/manual patch.

### Exercise Library
Fetched from `/meta/exercises` and cached for 24h in `exercise_library_cache_v1` (AsyncStorage). After first load, the library works offline for a full day.

### Exercise Images
Cached in `exercise_image_map_v1` (AsyncStorage). Image URLs are stored locally; the actual images are cached by React Native's built-in HTTP image cache. After first render, images show offline.

### Meal Plans
Each day's nutrition plan is saved per-date in AsyncStorage. The 7-day PlanWeek carries `nutrition_json` on each `PlanDay`; the `aiNutritionPlans` template array remains a cache / legacy fallback. Edits (add food, remove food, rename meal) save locally and sync to backend day state when available.

### Workout Tracking
The entire ActiveWorkoutScreen runs locally:
- Set logging → AsyncStorage (`activeWorkoutSets`)
- Rest timer → client-side
- Exercise progression tips → pre-stamped on plan data (no live API needed)
- Completion → saves to local history, queues backend sync

### Readiness / Fatigue
Canonical training readiness requires the backend (`POST /readiness/today`), and detailed muscle fatigue requires `/workouts/fatigue`. If those calls fail, the UI falls back to cached/local context or a conservative empty/default state rather than treating the offline result as authoritative. The fatigue model becomes useful after recent completions have synced to the backend.

## Sync Behavior

When the app comes back online:
- `logWorkoutDone` sends any completed workouts to the backend
- `syncOnboarding` pushes profile changes
- `upsertDayState` syncs meal plan state per-day
- `loadPlans` refetches the active PlanWeek and auto-renews only if the week expired

There is no explicit offline queue — each feature handles its own retry. Failed backend calls are caught silently and the app continues with local data.

## What Could Be Improved

1. **Explicit offline queue** — buffer failed API calls and replay when connectivity returns
2. **Offline food search** — cache the full USDA food database locally (large but possible)
3. **Offline fatigue** — compute from local workout history instead of requiring backend
4. **Sync status indicator** — show the user when data hasn't been synced yet
5. **Conflict resolution** — if the user edits a meal offline and the backend has a different version, decide which wins
