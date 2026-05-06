import { spawnSync } from 'node:child_process';

const node = process.execPath;
const tests = [
  ['src/services/__tests__/trainingScore.test.mjs'],
  ['src/utils/__tests__/planCacheReset.test.mjs'],
  ['src/utils/__tests__/units.test.mjs'],
  ['src/utils/__tests__/notificationPrefs.test.mjs'],
  ['scripts/run-jestlike-test.mjs', 'src/constants/__tests__/legal.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/subscription.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/hydration.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/mealGapSuggestion.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/mealPlanState.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/bodyMeasurements.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/profileCache.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/workoutTemplates.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/workoutCompletion.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/socialWorkoutDetails.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/workoutBestSets.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/workoutProgressFilters.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/screens/__tests__/progressData.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/planEffectiveDate.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/planChangeBehavior.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/injuryCheckins.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/coachApplyState.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/apiBaseUrl.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/birthday.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/cycleSupport.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/readinessWorkoutAdjustment.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/exerciseGuide.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/oneRepMax.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/goalTrajectory.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/liveActivityQuickStart.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/gearSessionMatching.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/swapScoring.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/customFoodSearch.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/mealItems.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/workoutLogPayload.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/eatingWindow.test.ts'],
];

for (const args of tests) {
  const label = args[args.length - 1];
  console.log(`\n[frontend-tests] ${label}`);
  const result = spawnSync(node, ['--experimental-strip-types', ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\n[frontend-tests] all passed');
