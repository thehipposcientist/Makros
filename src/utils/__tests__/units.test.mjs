import {
  formatDistance,
  formatWeight,
  lbsToUnit,
  miToUnit,
  resolveDistanceUnit,
  resolveWeightUnit,
  unitToLbs,
  unitToMi,
} from '../units.ts';

function assert(condition, label, detail = '') {
  if (!condition) {
    console.error(`  ✗ ${label}${detail ? `: ${detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

function closeEnough(a, b, label) {
  assert(Math.abs(a - b) < 0.01, label, `${a} !== ${b}`);
}

console.log('[units] display conversion tests');

closeEnough(lbsToUnit(220.46226218, 'kg'), 100, 'lbs to kg converts display value');
closeEnough(unitToLbs(100, 'kg'), 220.46226218, 'kg input converts back to canonical lbs');
closeEnough(miToUnit(6.213711922, 'km'), 10, 'miles to km converts display value');
closeEnough(unitToMi(10, 'km'), 6.213711922, 'km input converts back to canonical miles');

assert(formatWeight(180, 'lbs') === '180 lbs', 'weight defaults to integer lbs');
assert(formatWeight(180, 'kg') === '81.6 kg', 'weight defaults to one-decimal kg');
assert(formatDistance(3.1, 'mi') === '3.1 mi', 'distance formats miles');
assert(formatDistance(3.1, 'km') === '5.0 km', 'distance formats kilometers');
assert(resolveWeightUnit(null) === 'lbs', 'missing profile resolves weight to lbs');
assert(resolveDistanceUnit({ distanceUnit: 'km' }) === 'km', 'profile resolves distance unit');

if (process.exitCode) {
  console.error('[units] FAILED');
} else {
  console.log('[units] all passed');
}
