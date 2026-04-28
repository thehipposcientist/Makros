// Sleep score — runnable spec. No test runner is wired into this
// project (the backend uses Python tests via `backend/tests/run_all.py`;
// the frontend has no Jest/Vitest setup). This file is a standalone
// script that exercises the deep/REM/awake patch:
//
//     npx tsx src/services/sleepScore.spec.ts
//
// Each `expect` line throws on failure with a clear message. If the
// project later adds a TS test runner, the cases below convert to Jest
// `test(...)` blocks with a regex find/replace.
//
// Cases covered (per the patch spec):
//   1. Low deep + high REM should score lower than high deep + low REM
//      (deep is weighted ~2× REM, so the trade favors deep).
//   2. Missing stage data must NOT tank the score (neutral fallback).
//   3. Low deep on a 7+ hour night triggers the deep-sleep insight +
//      a sub-max deepSleep pillar (absolute-minutes floor).
//   4. >60 min awake reduces the awakeFragmentation pillar.
//   5. Bonus — verifies pillar weights sum to 100 in MVP mode.

import { scoreSleepMVP, scoreSleepPersonalized } from './sleepScore';
import type { SleepScoreInput } from './sleepScore';

function expect(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

function baseInput(overrides: Partial<SleepScoreInput> = {}): SleepScoreInput {
  return {
    totalSleepHours: 7.5,
    inBedMinutes: 7.5 * 60 + 30,        // 90% efficiency baseline
    deepSleepHours: 1.4,                 // 84 min — solid deep
    remSleepHours: 1.5,                  // 20% ratio — sweet spot
    hrvMs: 55,
    spo2Percent: 97,
    respiratoryRate: 15,
    age: 30,
    stages: {
      core: 4.6,
      deep: 1.4,
      rem: 1.5,
      awake: 0.25,                       // 15 min — clean
      total: 7.5,
    },
    ...overrides,
  };
}


// ─── Case 1: deep weighted ~2× REM ──────────────────────────────────────────
console.log('\n[case] Low deep + high REM scores lower than high deep + low REM');
{
  const lowDeepHighRem = scoreSleepMVP(baseInput({
    deepSleepHours: 0.5,                 // 30 min — well below the 40-min floor
    remSleepHours: 2.0,                  // 27% — slightly above sweet spot
    stages: { core: 5.0, deep: 0.5, rem: 2.0, awake: 0.25, total: 7.5 },
  }))!;
  const highDeepLowRem = scoreSleepMVP(baseInput({
    deepSleepHours: 1.5,                 // 90 min — full credit
    remSleepHours: 0.6,                  // 8% — low REM penalty
    stages: { core: 5.4, deep: 1.5, rem: 0.6, awake: 0.25, total: 7.5 },
  }))!;
  expect(
    highDeepLowRem.score > lowDeepHighRem.score,
    `high-deep/low-REM=${highDeepLowRem.score} > low-deep/high-REM=${lowDeepHighRem.score}`,
  );
  expect(
    (lowDeepHighRem.pillars.deepSleep ?? 99) < (highDeepLowRem.pillars.deepSleep ?? 0),
    `lowDeep deepSleep=${lowDeepHighRem.pillars.deepSleep} < highDeep deepSleep=${highDeepLowRem.pillars.deepSleep}`,
  );
}


// ─── Case 2: missing stage data must not tank the score ─────────────────────
console.log('\n[case] Missing stage data → neutral fallback, score stays sane');
{
  const withStages = scoreSleepMVP(baseInput())!;
  const noStages = scoreSleepMVP(baseInput({
    deepSleepHours: null,
    remSleepHours: null,
    stages: null,
  }))!;
  expect(noStages.score >= 60, `no-stages score=${noStages.score} should remain >= 60 (was ${withStages.score} with full stages)`);
  // deepSleep neutral fallback = round(10 * 0.6) = 6
  expect(noStages.pillars.deepSleep === 6, `no-stages deepSleep pillar = ${noStages.pillars.deepSleep}, expected 6`);
  // REM neutral fallback = round(5 * 0.6) = 3
  expect(noStages.pillars.remSleep === 3, `no-stages remSleep pillar = ${noStages.pillars.remSleep}, expected 3`);
  // awakeFragmentation neutral fallback (stages.awake also missing) = round(5 * 0.6) = 3
  expect(noStages.pillars.awakeFragmentation === 3, `no-stages awakeFrag pillar = ${noStages.pillars.awakeFragmentation}, expected 3`);
}


// ─── Case 3: low deep on a 7+ hour night triggers the absolute-minutes floor ─
console.log('\n[case] Low deep on a long night triggers the deep-sleep insight + penalty');
{
  const lowDeep = scoreSleepMVP(baseInput({
    totalSleepHours: 7.5,
    deepSleepHours: 0.5,                 // 30 min
    stages: { core: 5.5, deep: 0.5, rem: 1.5, awake: 0.25, total: 7.5 },
  }))!;
  expect((lowDeep.pillars.deepSleep ?? 99) <= 4,
    `30-min deep on 7.5h → deepSleep pillar ${lowDeep.pillars.deepSleep} should be ≤ 4 (strong penalty band)`);
  expect(lowDeep.insights.some(s => s.toLowerCase().includes('deep sleep was very low')),
    `expected a "deep sleep was very low" insight; got: ${JSON.stringify(lowDeep.insights)}`);
}

console.log('\n[case] Short night → no absolute floor; deep ratio drives scoring');
{
  // 5h sleep with 60 min deep = 20% ratio → full credit on the pillar
  // even though absolute deep is below the 80-min "good" floor that
  // applies to long nights.
  const shortNightGoodRatio = scoreSleepMVP(baseInput({
    totalSleepHours: 5.0,
    inBedMinutes: 5.5 * 60,
    deepSleepHours: 1.0,                 // 60 min, 20% ratio
    remSleepHours: 1.0,
    stages: { core: 3.0, deep: 1.0, rem: 1.0, awake: 0.25, total: 5.0 },
  }))!;
  expect(shortNightGoodRatio.pillars.deepSleep === 10,
    `5h with 20% deep ratio → deepSleep pillar should be max=10, got ${shortNightGoodRatio.pillars.deepSleep}`);
}


// ─── Case 4: awake_minutes > 60 reduces the fragmentation pillar ────────────
console.log('\n[case] >60 min awake → fragmentation pillar drops + insight surfaces');
{
  const cleanNight = scoreSleepMVP(baseInput({
    stages: { core: 4.6, deep: 1.4, rem: 1.5, awake: 0.25, total: 7.5 }, // 15 min awake
  }))!;
  const fragmentedNight = scoreSleepMVP(baseInput({
    stages: { core: 4.6, deep: 1.4, rem: 1.5, awake: 1.25, total: 7.5 }, // 75 min awake
  }))!;
  expect(
    (fragmentedNight.pillars.awakeFragmentation ?? 99) < (cleanNight.pillars.awakeFragmentation ?? 0),
    `75-min-awake awakeFrag=${fragmentedNight.pillars.awakeFragmentation} < clean awakeFrag=${cleanNight.pillars.awakeFragmentation}`,
  );
  expect(
    fragmentedNight.insights.some(s => s.toLowerCase().includes('mid-sleep wake') || s.toLowerCase().includes('awake')),
    `expected a fragmentation insight; got: ${JSON.stringify(fragmentedNight.insights)}`,
  );
}


// ─── Case 5: pillar weights sum to 100 in both modes ─────────────────────────
console.log('\n[case] All pillars sum to score (≤100) — no hidden double-count');
{
  const mvp = scoreSleepMVP(baseInput())!;
  const mvpSum =
    mvp.pillars.duration + mvp.pillars.efficiency + mvp.pillars.hrv +
    (mvp.pillars.deepSleep ?? 0) + (mvp.pillars.remSleep ?? 0) +
    mvp.pillars.healthFlags + (mvp.pillars.awakeFragmentation ?? 0);
  // Score may have been clamped to 100; pillar sum should match score
  // exactly (we use Math.round on the total and on each pillar, so a
  // ±1 rounding gap is acceptable).
  expect(Math.abs(mvpSum - mvp.score) <= 1,
    `MVP pillar sum=${mvpSum} matches score=${mvp.score} within ±1`);
  // legacy stageComposite slot should equal deep + REM
  expect(mvp.pillars.stageComposite === (mvp.pillars.deepSleep ?? 0) + (mvp.pillars.remSleep ?? 0),
    `legacy stageComposite=${mvp.pillars.stageComposite} == deepSleep+remSleep`);
}


// ─── Case 6: personalized mode preserves all the above ──────────────────────
console.log('\n[case] Personalized mode includes regularity AND the new deep/REM/awake split');
{
  const hrvHistory = Array.from({ length: 14 }, (_, i) => 50 + (i % 4));
  const bedtimeHistory = Array.from({ length: 14 }, (_, i) => 23 * 60 + (i % 30));
  const personalized = scoreSleepPersonalized({
    ...baseInput(),
    hrvHistory,
    bedtimeHistory,
  })!;
  expect(personalized.mode === 'personalized', `mode should be "personalized"`);
  expect(personalized.pillars.regularity != null, `regularity pillar present`);
  expect(personalized.pillars.deepSleep != null, `deepSleep pillar present`);
  expect(personalized.pillars.remSleep != null, `remSleep pillar present`);
  expect(personalized.pillars.awakeFragmentation != null, `awakeFragmentation pillar present`);
}


console.log('\n✓ All sleep-score patch cases passed.\n');
