# Offline Behavior

## What Works Without Internet

| Feature | Offline? | How |
|---------|----------|-----|
| View workout plan | Yes | Active `PlanWeek` projected into `aiWorkoutPlan` cache |
| Start and complete a workout | Yes | Active session is a local crash-recovery draft; completion syncs to backend with idempotency |
| Log sets, reps, weight | Yes | Drafted locally during the session, written to backend on completion/retry |
| View exercise library | Yes | Cached for 24h in AsyncStorage |
| View exercise images | Partial | Cached by React Native's image cache after first load |
| View meal plan | Yes | DB PlanDay nutrition is cached in AsyncStorage for offline rendering |
| Check off meals | Yes | Meal checks update local cache, then DB-backed meal/day state when online |
| Edit meals (add/remove items) | Yes | Drafted locally and synced to backend day state when online |
| Log hydration | Yes | Optimistic local cache with pending rows; replayed to `/meals/hydration` when online |
| Log weight | Yes | Cached locally and written to backend weight entries when authenticated |
| View weight history | Yes | Backend weight entries cached locally |
| View workout history | Yes | Backend workout sessions/completions cached locally |
| View progress/PRs | Yes | Computed from backend history with local cache fallback |
| Change workout day focus | Partial | UI can keep local edits, but authoritative exercise patch needs backend |
| Timer (rest timer, timed exercises) | Yes | Fully client-side |
| Outdoor cardio GPS tracking | Yes | Phone/Watch location can capture distance/pace/route during the session; backend sync waits until online |
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
Fetched from `/meta/exercises` and cached for 24h in `exercise_library_cache_v4` (AsyncStorage). After first load, the library works offline for a full day.

### Exercise Images
Cached in `exercise_image_map_v1` (AsyncStorage). Image URLs are stored locally; the actual images are cached by React Native's built-in HTTP image cache. After first render, images show offline.

### Meal Plans
Each day's nutrition plan is database-backed through the active `PlanWeek` and its 7 `PlanDay.nutrition_json` rows. AsyncStorage meal-plan keys are hot/offline caches or unsaved drafts only; they must not be treated as canonical saved meals. Edits (add food, remove food, rename meal) can stage locally while offline and sync to backend day state when available.

### Workout Tracking
The entire ActiveWorkoutScreen runs locally:
- Set logging → AsyncStorage (`activeWorkoutSets`)
- Rest timer → client-side
- Outdoor cardio GPS route/distance/pace → local live state, included in the pending completion payload when present
- Exercise progression tips → pre-stamped on plan data (no live API needed)
- Completion → updates the local cache, persists a pending `/workouts/complete` payload in `pendingWorkoutCompletions_v1`, then retries backend sync with the same idempotency key when the app signs in / foregrounds

### Hydration
Hydration quick-add and manual set write optimistically to the per-date hydration cache. If the backend call fails, the cache marks the row pending and `hydrationRetry` replays it later. The server remains authoritative once `/meals/hydration` succeeds.

### Readiness / Fatigue
Canonical training readiness requires the backend (`POST /readiness/today`), and detailed muscle fatigue requires `/workouts/fatigue`. If those calls fail, the UI falls back to cached/local context or a conservative empty/default state rather than treating the offline result as authoritative. The fatigue model becomes useful after recent completions have synced to the backend.

## Sync Behavior

When the app comes back online:
- `flushPendingWorkoutCompletions` replays any queued workout completions to the backend using the original `external_source_id` / `idempotency_key`
- `syncOnboarding` pushes profile changes
- `upsertDayState` syncs meal plan state per-day
- `loadPlans` refetches the active PlanWeek and auto-renews only if the week expired

Workout completions now have an explicit offline queue because they are user-critical. Other feature retries remain local/best-effort unless noted above.

## What Could Be Improved

1. **Broader offline queue** — extend the durable queue pattern beyond workout completions to other critical writes
2. **Offline food search** — cache the full USDA food database locally (large but possible)
3. **Offline fatigue** — compute from local workout history instead of requiring backend
4. **Sync status indicator** — show the user when data hasn't been synced yet
5. **Conflict resolution** — if the user edits a meal offline and the backend has a different version, decide which wins
