/**
 * Self-contained JS tests for `clearAllPlanCache` + `isPlanStale`.
 *
 * Run: `node --experimental-strip-types src/utils/__tests__/planCacheReset.test.mjs`
 *
 * We run under `--experimental-strip-types` so this script can `import`
 * the TS source directly, no compile step. Keeps the repo's "Python is
 * the test harness" convention without pulling in Jest + RN Babel.
 *
 * Covered:
 *  - Storage wipe keeps exactly the preserved safelist, removes everything else
 *  - Dynamic per-date keys (freshDayGenerated_YYYY-MM-DD, etc.) are wiped
 *  - `isPlanStale` returns true on missing plans, version mismatch, old age
 *  - `isPlanStale` returns false on recent matching plans
 */
import {
  clearAllPlanCache,
  isPlanStale,
  PRESERVED_KEYS,
} from '../planCacheReset.ts';

function ok(label) { console.log(`  ✓ ${label}`); }
function fail(label, why) {
  console.error(`  ✗ ${label}: ${why}`);
  process.exitCode = 1;
}

function makeMockStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    _data: data,
    getAllKeys: async () => Array.from(data.keys()),
    multiRemove: async (keys) => { for (const k of keys) data.delete(k); },
  };
}

// ── Test 1: clearAllPlanCache wipes expected keys ────────────────────

async function test_wipe_preserves_safelist() {
  const initial = {
    // Preserved
    authToken: 'abc',
    userProfile: '{"goal":"muscle_gain"}',
    weightHistory: '[]',
    weightEntries: '[]',
    workoutTemplates: '[]',
    workoutHistoryList: '[]',
    user_username: 'alice',
    themePreference: 'dark',
    // Wipe targets
    aiWorkoutPlan: '{}',
    aiNutritionPlan: '{}',
    aiNutritionPlanA: '{}',
    aiNutritionPlanB: '{}',
    aiNutritionPlanC: '{}',
    aiNutritionPlans: '[]',
    trainerNote: 'hi',
    manualWorkoutOverrides: '{}',
    nutritionistNote: 'hi',
    supplementStack: '[]',
    mealEdits: '{}',
    mealChecks: '{}',
    preservedCheckedMeals: '{}',
    // Dynamic per-date keys — MUST be wiped by the getAllKeys snapshot
    'freshDayGenerated_2026-04-21': '1',
    'freshDayGenerated_2026-04-22': 'pending',
    'workoutDayState_2026-04-21': '{"foo":1}',
    'mealPlan_2026-04-21': '{}',
    'unloggedMealsPromptShown_2026-04-20': '1',
  };
  const storage = makeMockStorage(initial);
  const result = await clearAllPlanCache({ storage });
  const remainingKeys = new Set(storage._data.keys());

  const expectedKept = new Set([
    'authToken', 'userProfile', 'weightHistory', 'weightEntries',
    'workoutTemplates',
    'workoutHistoryList', 'user_username', 'themePreference',
  ]);
  for (const k of expectedKept) {
    if (!remainingKeys.has(k)) {
      fail('test_wipe_preserves_safelist', `expected to keep ${k}, but it was removed`);
      return;
    }
  }
  for (const k of Object.keys(initial)) {
    if (expectedKept.has(k)) continue;
    if (remainingKeys.has(k)) {
      fail('test_wipe_preserves_safelist', `expected to remove ${k}, still present`);
      return;
    }
  }
  // Result object has partition sizes.
  if (result.removed.length < 15) {
    fail('test_wipe_preserves_safelist', `removed.length too small: ${result.removed.length}`);
    return;
  }
  ok('wipe removes plan/meal/day-state keys and keeps auth/profile/history/theme');
}

// ── Test 2: dry run doesn't mutate ──────────────────────────────────

async function test_dry_run_no_mutation() {
  const storage = makeMockStorage({ aiWorkoutPlan: '{}', authToken: 'x' });
  const before = new Set(storage._data.keys());
  const result = await clearAllPlanCache({ storage, dryRun: true });
  const after = new Set(storage._data.keys());
  if (before.size !== after.size) {
    fail('test_dry_run_no_mutation', 'dryRun mutated storage');
    return;
  }
  if (result.removed.length !== 1) {
    fail('test_dry_run_no_mutation', `expected removed=1, got ${result.removed.length}`);
    return;
  }
  ok('dryRun returns partition without mutating storage');
}

// ── Test 3: idempotent on empty storage ─────────────────────────────

async function test_empty_storage_noop() {
  const storage = makeMockStorage({});
  const result = await clearAllPlanCache({ storage });
  if (result.removed.length !== 0 || result.kept.length !== 0) {
    fail('test_empty_storage_noop', `expected empty partition, got ${JSON.stringify(result)}`);
    return;
  }
  ok('empty storage → no-op, no errors');
}

// ── Test 4: PRESERVED_KEYS is frozen + contains required entries ────

function test_preserved_keys_shape() {
  const required = [
    'authToken', 'userProfile', 'weightEntries', 'workoutHistoryList',
    'weightHistory', 'workoutTemplates', 'user_username', 'themePreference', 'metaData_v1',
  ];
  for (const r of required) {
    if (!PRESERVED_KEYS.includes(r)) {
      fail('test_preserved_keys_shape', `missing required key ${r}`);
      return;
    }
  }
  ok('PRESERVED_KEYS contains all required entries');
}

// ── Test 5: isPlanStale ─────────────────────────────────────────────

function test_is_plan_stale() {
  // Null/undefined → stale.
  if (!isPlanStale(null)) { fail('isPlanStale', 'null should be stale'); return; }
  if (!isPlanStale(undefined)) { fail('isPlanStale', 'undefined should be stale'); return; }

  // Version mismatch → stale.
  if (!isPlanStale({ planner_version: '2025.01.01.01', created_at: new Date().toISOString() },
                   { expectedVersion: '2026.04.22.01' })) {
    fail('isPlanStale', 'version mismatch should be stale');
    return;
  }

  // Matching version, recent → fresh.
  if (isPlanStale({ planner_version: '2026.04.22.01', created_at: new Date().toISOString() },
                  { expectedVersion: '2026.04.22.01' })) {
    fail('isPlanStale', 'matching version + recent should NOT be stale');
    return;
  }

  // Matching version, old → stale by age.
  const old = new Date(Date.now() - 45 * 86400 * 1000).toISOString();
  if (!isPlanStale({ planner_version: '2026.04.22.01', created_at: old },
                   { expectedVersion: '2026.04.22.01', maxAgeDays: 30 })) {
    fail('isPlanStale', '45-day-old plan should be stale at maxAgeDays=30');
    return;
  }

  // No expectedVersion passed, recent → fresh (only age matters).
  if (isPlanStale({ planner_version: 'anything', created_at: new Date().toISOString() })) {
    fail('isPlanStale', 'no expectedVersion + recent should be fresh');
    return;
  }
  ok('isPlanStale correctly flags missing / mismatched / old plans');
}

// ── Run ──────────────────────────────────────────────────────────────

console.log('[planCacheReset] JS unit tests');
await test_wipe_preserves_safelist();
await test_dry_run_no_mutation();
await test_empty_storage_noop();
test_preserved_keys_shape();
test_is_plan_stale();
if (process.exitCode) {
  console.error('[planCacheReset] FAILED');
} else {
  console.log('[planCacheReset] all passed');
}
