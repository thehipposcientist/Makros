# Claude Rules — Mobile (React Native / Expo)

When editing `src/` or `app/`:

1. **API types**: `src/services/api.ts` is the single source of truth for backend call signatures. Update it whenever an endpoint shape changes.

2. **Cache clear is scoped**: Use `clearWorkoutCache()`, `clearMealCache()`, or `clearAllPlanCache()` from `planCacheReset.ts`. Never call `AsyncStorage.clear()`. Respected safelist keys: auth tokens, userProfile, weightEntries, workoutHistory, themePreference, metaData_v1.

3. **Exercise swap scoring**: Use `rankSwapCandidates` from `src/utils/swapScoring.ts` for both in-workout and plan-view swaps. Do not duplicate scoring logic.

4. **Nutrition score**: Client `nutritionScore.ts` is for plan-preview only. For logged meals, always read from `/meals/score` (server-authoritative).

5. **HealthKit reads**: Use `getHealthDataSummary` from `src/services/healthDataSummary.ts`. Do not call `readHealthSummary` directly in new code — the aggregator wraps it.

6. **Animation**: Use `configureExpandAnimation(300)` from `layoutAnim.ts` for card expand/collapse. Stock `LayoutAnimation.Presets.easeInEaseOut` renders imperceptibly fast in iOS release builds.

7. **Coach actions**: All AI/trainer apply-actions must route through `POST /coach/apply-action`. Never directly mutate the active `WorkoutPlan` from client state.

8. **Dev logs**: `devLogs.ts` ring-buffer is always active. Don't add/remove the dev-logs hook when debugging — it's low-overhead and critical for TestFlight.
