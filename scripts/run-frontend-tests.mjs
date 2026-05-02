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
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/bodyMeasurements.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/profileCache.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/screens/__tests__/progressData.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/planEffectiveDate.test.ts'],
  ['scripts/run-jestlike-test.mjs', 'src/utils/__tests__/planChangeBehavior.test.ts'],
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
