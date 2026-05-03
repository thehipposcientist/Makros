/**
 * Plan-cache reset — nukes every AsyncStorage key that could hold stale
 * plan / meal / day-state remnants after a regeneration. Called once
 * from `applyPlanResult` BEFORE the new plan is written, and also by
 * manual regen flows in Edit screens if ever wired up.
 *
 * The safelist below is the contract: on a regen we wipe everything
 * EXCEPT these keys. Anything new added to AsyncStorage anywhere in the
 * app must either:
 *   (a) be appended to `PRESERVED_KEYS` below if it's history/auth/profile,
 *   (b) or be accepted as "wipe-safe on regen" (the default).
 *
 * Design notes:
 *  - We snapshot `AsyncStorage.getAllKeys()` then `multiRemove` the
 *    complement of the safelist. This catches dynamic keys with
 *    per-date suffixes (`freshDayGenerated_YYYY-MM-DD`,
 *    `workoutDayState_YYYY-MM-DD`, `unloggedMealsPromptShown_YYYY-MM-DD`,
 *    `mealPlan_YYYY-MM-DD`) without needing an enumeration.
 *  - `aiWorkoutPlan` IS wiped — `applyPlanResult` writes the fresh value
 *    immediately after this call, so there's no flicker.
 *  - Test injection: pass a mock storage in `opts.storage` so the unit
 *    test can run under Node without the real AsyncStorage native bridge.
 */
// Lazy-resolve AsyncStorage so this module can be imported from Node-
// side unit tests (where the native bridge doesn't exist). When running
// on React Native the require succeeds normally; in Node we fall back
// to a no-op storage stub that callers are expected to replace via the
// `opts.storage` parameter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let DefaultAsyncStorage: any;
try {
  DefaultAsyncStorage = require('@react-native-async-storage/async-storage').default;
} catch {
  DefaultAsyncStorage = {
    getAllKeys: async (): Promise<string[]> => [],
    multiRemove: async (): Promise<void> => undefined,
  };
}

/** Substring patterns that identify per-domain plan state keys. A regen
 *  clears only the keys matching its own domain — workout regen wipes
 *  workout cache, meal regen wipes meal cache, goal change wipes both.
 *
 *  These are SUBSTRING matches so per-date suffixes are caught:
 *    `freshDayGenerated_2026-04-22`      → workout
 *    `workoutDayState_2026-04-22`        → workout
 *    `mealPlan_2026-04-22`               → meal
 *    `preservedMeal_2026-04-22_3`        → meal
 *    `mealChecks_2026-04-22`             → meal
 */
const WORKOUT_KEY_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'aiWorkoutPlan',
  'freshDayGenerated_',
  'workoutDayState_',
  'trainerNote',
  'manualWorkoutOverrides',
  'readinessScore',
  'routineOverlayShown_',
  'activeWorkoutSession',     // in-progress workout state
  'workoutStartTime_',
]);
const MEAL_KEY_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'aiNutritionPlan',          // catches aiNutritionPlans + aiNutritionPlanA/B/C
  'nutritionistNote',
  'mealPlan_',
  'preservedMeal_',
  'preservedCheckedMeals',
  'mealChecks_',
  'mealChecks',
  'mealEdits',
  'unloggedMealsPromptShown_',
  'mealRoutine',
  'supplementStack',
]);

function matchesAny(key: string, patterns: ReadonlyArray<string>): boolean {
  for (const p of patterns) {
    // Exact match OR substring (for per-date suffixes).
    if (key === p) return true;
    if (p.endsWith('_') && key.startsWith(p)) return true;
    if (p === 'aiNutritionPlan' && key.startsWith('aiNutritionPlan')) return true;
  }
  return false;
}

/** Exact keys that survive a plan regen — auth, profile, long-term
 *  history, theme. Everything else gets wiped. Keep this list tight —
 *  leaking stale plan state is the whole bug class we're eliminating. */
export const PRESERVED_KEYS: ReadonlyArray<string> = Object.freeze([
  // Auth / user identity
  'authToken',
  'auth_token',        // legacy alias
  'user_username',
  'last_user_id',

  // Profile (just regenerated FROM this; must survive)
  'userProfile',

  // Long-term history — never wiped by regen
  'weightHistory',
  'weightEntries',
  'workoutHistory',
  'workoutTemplates',
  'workoutHistoryList',
  'workoutHistorySummaries',
  'workoutSummaries',
  'planChangeHistory',
  'goalHistory',
  'userLog',
  'skippedWorkouts',
  'bodyScanHistory',

  // Theme / UI prefs
  'themePreference',
  'lastActiveTab',

  // Install / cache versioning — shouldn't reset on regen
  'installMarker',
  'cacheVersion',

  // Reminders / device prefs — survive regen
  'workoutReminders',
  'feedbackSettings',

  // Metadata cache — kept to avoid re-hydrating a 500KB blob on next open
  'metaData_v1',
]);

const PRESERVED_SET = new Set(PRESERVED_KEYS);

/** Minimal AsyncStorage surface we actually use. Kept narrow so the
 *  Node-based unit test can stub this out without pulling in the RN
 *  native module. */
export interface StorageLike {
  getAllKeys: () => Promise<readonly string[]> | Promise<string[]>;
  multiRemove: (keys: string[]) => Promise<void>;
}

export interface ClearAllPlanCacheOptions {
  /** Injected for unit tests. Defaults to `@react-native-async-storage`. */
  storage?: StorageLike;
  /** Returned to the caller — useful for logs + tests. */
  dryRun?: boolean;
}

export interface ClearAllPlanCacheResult {
  kept: string[];
  removed: string[];
}

async function _clearScoped(
  scope: 'workout' | 'meal' | 'both',
  opts: ClearAllPlanCacheOptions,
): Promise<ClearAllPlanCacheResult> {
  const storage: StorageLike = opts.storage ?? (DefaultAsyncStorage as unknown as StorageLike);
  let allKeys: readonly string[] = [];
  try {
    allKeys = await storage.getAllKeys();
  } catch {
    return { kept: [], removed: [] };
  }
  const kept: string[] = [];
  const removed: string[] = [];
  for (const k of allKeys) {
    if (PRESERVED_SET.has(k)) { kept.push(k); continue; }
    const isWorkout = matchesAny(k, WORKOUT_KEY_PATTERNS);
    const isMeal = matchesAny(k, MEAL_KEY_PATTERNS);
    const shouldRemove =
      (scope === 'workout' && isWorkout) ||
      (scope === 'meal' && isMeal) ||
      (scope === 'both' && (isWorkout || isMeal));
    if (shouldRemove) removed.push(k); else kept.push(k);
  }
  if (!opts.dryRun && removed.length > 0) {
    try { await storage.multiRemove(removed); } catch {}
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`[plan-cache] scope=${scope} cleared ${removed.length} keys, kept ${kept.length}`, {
      removedSample: removed.slice(0, 12),
    });
  } catch {}
  return { kept, removed };
}

/** Clear only workout-related cache. Called on workout-only regen. */
export async function clearWorkoutCache(opts: ClearAllPlanCacheOptions = {}): Promise<ClearAllPlanCacheResult> {
  return _clearScoped('workout', opts);
}

/** Clear only meal-related cache. Called on nutrition-only regen. */
export async function clearMealCache(opts: ClearAllPlanCacheOptions = {}): Promise<ClearAllPlanCacheResult> {
  return _clearScoped('meal', opts);
}

/** Clear BOTH workout + meal cache. Called on goal changes / full regen. */
export async function clearAllPlanCache(opts: ClearAllPlanCacheOptions = {}): Promise<ClearAllPlanCacheResult> {
  return _clearScoped('both', opts);
}


/** Pure staleness check — kept separate from the IO so it's trivially
 *  unit-testable. Returns `true` when the plan should be auto-regenerated
 *  in the background. Staleness triggers:
 *   - `backendVersion` differs from the hardcoded client expectation,
 *   - `createdAt` is older than `maxAgeDays` (defaults to 30),
 *   - either value is missing entirely.
 *  The client doesn't know the "true" current server version a priori,
 *  so `expectedVersion` is optional: pass the version the client
 *  expected (e.g. from the last plan it saved) and any mismatch counts
 *  as stale. When omitted, only the age check applies. */
export function isPlanStale(
  plan: { planner_version?: string | null; created_at?: string | null } | null | undefined,
  opts: { expectedVersion?: string | null; maxAgeDays?: number; now?: Date } = {},
): boolean {
  if (!plan) return true;
  const { expectedVersion, maxAgeDays = 30, now = new Date() } = opts;
  if (expectedVersion && plan.planner_version && plan.planner_version !== expectedVersion) {
    return true;
  }
  if (plan.created_at) {
    const created = new Date(plan.created_at);
    if (!isNaN(created.getTime())) {
      const ageMs = now.getTime() - created.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > maxAgeDays) return true;
    }
  }
  return false;
}
