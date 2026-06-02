// Sleep score — runnable spec. No test runner is wired into this
// project (the backend uses Python tests via `backend/tests/run_all.py`;
// the frontend has no Jest/Vitest setup). This file is a standalone
// script that exercises the sleep-score scoring behavior:
//
//     npx tsx src/services/sleepScore.spec.ts
//
// Each `expect` line throws on failure with a clear message. If the
// project later adds a TS test runner, the cases below convert to Jest
// `test(...)` blocks with a regex find/replace.
//
// Cases covered:
//   1. Low deep + high REM should score lower than high deep + low REM
//      (deep is weighted ~2× REM, so the trade favors deep).
//   2. Missing stage data must NOT tank the score (neutral-conservative fallback).
//   3. Low deep on a 7+ hour night triggers the deep-sleep insight +
//      a sub-max deepSleep pillar (absolute-minutes floor).
//   4. >60 min awake reduces the awakeFragmentation pillar.
//   5. Duration uses soft penalties over hard caps, because caps feel
//      unintuitive and create score cliffs.
//   6. Missing HRV/stage/vitals data stays conservative.
//   7. Personalized mode activates only with 14+ HRV + bedtime nights.

import { scoreSleep, scoreSleepMVP, scoreSleepPersonalized } from './sleepScore';
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


// ─── Case 0: duration uses smooth recovery limiters, not blunt caps ──────────
console.log('\n[case] Very short sleep stays low even with great quality signals');
{
  const shortGreat = scoreSleepMVP(baseInput({
    totalSleepHours: 4.5,
    inBedMinutes: 285,
    deepSleepHours: 0.9,
    remSleepHours: 0.9,
    hrvMs: 80,
    spo2Percent: 98,
    respiratoryRate: 14,
    stages: { core: 2.7, deep: 0.9, rem: 0.9, awake: 0.1, total: 4.5 },
  }))!;
  expect(
    shortGreat.score < 70 && shortGreat.rating !== 'Excellent',
    `4.5h with great quality signals should stay Poor/Fair-ish, got score=${shortGreat.score}, rating=${shortGreat.rating}`,
  );
}

console.log('\n[case] 5.8h nights vary naturally instead of landing on one cap');
{
  const highQuality = scoreSleepMVP(baseInput({
    totalSleepHours: 5.8,
    inBedMinutes: 375,
    deepSleepHours: 1.05,
    remSleepHours: 1.1,
    hrvMs: 72,
    stages: { core: 3.65, deep: 1.05, rem: 1.1, awake: 0.15, total: 5.8 },
  }))!;
  const roughQuality = scoreSleepMVP(baseInput({
    totalSleepHours: 5.8,
    inBedMinutes: 420,
    deepSleepHours: 0.6,
    remSleepHours: 0.7,
    hrvMs: 45,
    stages: { core: 4.5, deep: 0.6, rem: 0.7, awake: 0.55, total: 5.8 },
  }))!;
  expect(
    highQuality.score !== roughQuality.score,
    `same-duration 5.8h nights should vary; high=${highQuality.score}, rough=${roughQuality.score}`,
  );
  expect(
    !(highQuality.score === 59 && roughQuality.score === 59),
    `5.8h nights should not both collapse to the old 59 cap`,
  );
}

console.log('\n[case] 6.4h and 6.6h do not have a sharp duration cliff');
{
  const sixFour = scoreSleepMVP(baseInput({
    totalSleepHours: 6.4,
    inBedMinutes: 410,
    deepSleepHours: 1.1,
    remSleepHours: 1.2,
    stages: { core: 4.1, deep: 1.1, rem: 1.2, awake: 0.2, total: 6.4 },
  }))!;
  const sixSix = scoreSleepMVP(baseInput({
    totalSleepHours: 6.6,
    inBedMinutes: 425,
    deepSleepHours: 1.2,
    remSleepHours: 1.25,
    stages: { core: 4.15, deep: 1.2, rem: 1.25, awake: 0.2, total: 6.6 },
  }))!;
  expect(
    Math.abs(sixSix.score - sixFour.score) <= 8,
    `6.4h score=${sixFour.score} and 6.6h score=${sixSix.score} should stay close`,
  );
}

console.log('\n[case] 7.5–8.5h with good efficiency and vitals can score high');
{
  const excellentWindow = scoreSleepMVP(baseInput({
    totalSleepHours: 8.2,
    inBedMinutes: 515,
    deepSleepHours: 1.6,
    remSleepHours: 1.8,
    hrvMs: 76,
    restingHeartRate: 54,
    spo2Percent: 98,
    respiratoryRate: 14,
    stages: { core: 4.8, deep: 1.6, rem: 1.8, awake: 0.15, total: 8.2 },
  }))!;
  expect(
    excellentWindow.score >= 85 && excellentWindow.rating === 'Excellent',
    `8.2h clean night should be able to score high; got score=${excellentWindow.score}, rating=${excellentWindow.rating}`,
  );
}

console.log('\n[case] Oversleeping is smoothly penalized');
{
  const ideal = scoreSleepMVP(baseInput({
    totalSleepHours: 8.2,
    inBedMinutes: 515,
    deepSleepHours: 1.6,
    remSleepHours: 1.8,
    hrvMs: 76,
    spo2Percent: 98,
    respiratoryRate: 14,
    stages: { core: 4.8, deep: 1.6, rem: 1.8, awake: 0.15, total: 8.2 },
  }))!;
  const long = scoreSleepMVP(baseInput({
    totalSleepHours: 10.75,
    inBedMinutes: 660,
    deepSleepHours: 1.7,
    remSleepHours: 2.2,
    hrvMs: 76,
    spo2Percent: 98,
    respiratoryRate: 14,
    stages: { core: 6.85, deep: 1.7, rem: 2.2, awake: 0.2, total: 10.75 },
  }))!;
  const veryLong = scoreSleepMVP(baseInput({
    totalSleepHours: 11.75,
    inBedMinutes: 720,
    deepSleepHours: 1.8,
    remSleepHours: 2.3,
    hrvMs: 76,
    spo2Percent: 98,
    respiratoryRate: 14,
    stages: { core: 7.65, deep: 1.8, rem: 2.3, awake: 0.2, total: 11.75 },
  }))!;
  expect(
    long.score < ideal.score && veryLong.score < long.score,
    `oversleep scores should taper smoothly: ideal=${ideal.score}, 10.75h=${long.score}, 11.75h=${veryLong.score}`,
  );
  expect(
    long.score > 80 && veryLong.score > 55,
    `long clean nights should be penalized without collapsing: 10.75h=${long.score}, 11.75h=${veryLong.score}`,
  );
}

console.log('\n[case] Missing HRV/stage/vitals data stays conservative');
{
  const missingSignals = scoreSleepMVP(baseInput({
    deepSleepHours: null,
    remSleepHours: null,
    hrvMs: null,
    spo2Percent: null,
    respiratoryRate: null,
    stages: null,
  }))!;
  expect(
    missingSignals.score < 85,
    `missing HRV/stage/vitals should not inflate to Excellent; got score=${missingSignals.score}`,
  );
  expect(
    missingSignals.insights.some(s => s.toLowerCase().includes('limited quality data') || s.toLowerCase().includes('unavailable')),
    `expected missing-data insight; got: ${JSON.stringify(missingSignals.insights)}`,
  );
}

console.log('\n[case] Personalized mode activates only after 14+ HRV and bedtime nights');
{
  const thirteenHrv = scoreSleep(baseInput({
    hrvHistory: Array.from({ length: 13 }, () => 55),
    bedtimeHistory: Array.from({ length: 14 }, () => 23 * 60),
  }))!;
  const thirteenBedtimes = scoreSleep(baseInput({
    hrvHistory: Array.from({ length: 14 }, () => 55),
    bedtimeHistory: Array.from({ length: 13 }, () => 23 * 60),
  }))!;
  const enoughHistory = scoreSleep(baseInput({
    hrvHistory: Array.from({ length: 14 }, () => 55),
    bedtimeHistory: Array.from({ length: 14 }, () => 23 * 60),
  }))!;
  expect(thirteenHrv.mode === 'mvp', `13 HRV nights should stay MVP, got ${thirteenHrv.mode}`);
  expect(thirteenBedtimes.mode === 'mvp', `13 bedtime nights should stay MVP, got ${thirteenBedtimes.mode}`);
  expect(enoughHistory.mode === 'personalized', `14+ HRV and bedtime nights should use personalized mode, got ${enoughHistory.mode}`);
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
  // deepSleep neutral-conservative fallback = round(10 * 0.5) = 5
  expect(noStages.pillars.deepSleep === 5, `no-stages deepSleep pillar = ${noStages.pillars.deepSleep}, expected 5`);
  // REM neutral-conservative fallback = round(5 * 0.5) = 3
  expect(noStages.pillars.remSleep === 3, `no-stages remSleep pillar = ${noStages.pillars.remSleep}, expected 3`);
  // awakeFragmentation neutral fallback (stages.awake also missing) = round(5 * 0.5) = 3
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
  expect(lowDeep.score < 85,
    `30-min deep on 7.5h should not rate Excellent; got score=${lowDeep.score}`);
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
  expect(shortNightGoodRatio.score <= 59,
    `5h should stay below Good even with a good deep ratio; got score=${shortNightGoodRatio.score}`);
}


// ─── Case 3b: smooth duration curve avoids hard band cliffs ─────────────────
console.log('\n[case] Smooth duration curve avoids hard duration-pillar cliffs');
{
  const justBelow = scoreSleepMVP(baseInput({
    totalSleepHours: 6.49,
    inBedMinutes: Math.round(6.9 * 60),
    deepSleepHours: 1.0,
    remSleepHours: 1.2,
    stages: { core: 4.29, deep: 1.0, rem: 1.2, awake: 0.25, total: 6.49 },
  }))!;
  const justAbove = scoreSleepMVP(baseInput({
    totalSleepHours: 6.51,
    inBedMinutes: Math.round(6.9 * 60),
    deepSleepHours: 1.0,
    remSleepHours: 1.2,
    stages: { core: 4.31, deep: 1.0, rem: 1.2, awake: 0.25, total: 6.51 },
  }))!;
  const clearlyShort = scoreSleepMVP(baseInput({
    totalSleepHours: 5.5,
    inBedMinutes: Math.round(5.9 * 60),
    deepSleepHours: 1.0,
    remSleepHours: 1.0,
    stages: { core: 3.5, deep: 1.0, rem: 1.0, awake: 0.25, total: 5.5 },
  }))!;

  expect(
    Math.abs(justBelow.pillars.duration - justAbove.pillars.duration) <= 1,
    `duration pillar should be smooth across 6.5h; below=${justBelow.pillars.duration}, above=${justAbove.pillars.duration}`,
  );
  expect(
    clearlyShort.pillars.duration < justBelow.pillars.duration,
    `5.5h duration=${clearlyShort.pillars.duration} should score below 6.49h duration=${justBelow.pillars.duration}`,
  );
}


// ─── Case 3c: long sleep is context-aware, not automatically harsh ───────────
console.log('\n[case] Long sleep is context-aware');
{
  const longClean = scoreSleepMVP(baseInput({
    totalSleepHours: 10.2,
    inBedMinutes: 630,
    deepSleepHours: 1.6,
    remSleepHours: 2.1,
    hrvMs: 75,
    restingHeartRate: 55,
    spo2Percent: 98,
    respiratoryRate: 15,
    stages: { core: 6.5, deep: 1.6, rem: 2.1, awake: 0.2, total: 10.2 },
  }))!;
  expect(
    longClean.score > 88,
    `10.2h with clean vitals should not be old hard-capped; got score=${longClean.score}`,
  );
  expect(
    longClean.insights.some(s => s.toLowerCase().includes('long sleep duration')),
    `expected long-sleep context insight; got: ${JSON.stringify(longClean.insights)}`,
  );

  const longStressed = scoreSleepMVP(baseInput({
    totalSleepHours: 10.2,
    inBedMinutes: 630,
    deepSleepHours: 1.6,
    remSleepHours: 2.1,
    hrvMs: 35,
    restingHeartRate: 98,
    spo2Percent: 93,
    respiratoryRate: 23,
    stages: { core: 6.5, deep: 1.6, rem: 2.1, awake: 0.2, total: 10.2 },
  }))!;
  expect(
    longStressed.score <= 69,
    `10.2h plus off recovery markers should stay capped; got score=${longStressed.score}`,
  );
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

  const sickNight = scoreSleepMVP(baseInput({
    inBedMinutes: 10 * 60,
    stages: { core: 4.6, deep: 1.4, rem: 1.5, awake: 2.5, total: 7.5 },
  }))!;
  expect(
    sickNight.score <= 45 && sickNight.rating === 'Poor',
    `150-min-awake sick night should be Poor and cap near 45; got score=${sickNight.score}, rating=${sickNight.rating}`,
  );
  expect(
    (sickNight.pillars.awakeFragmentation ?? 99) === 0,
    `150-min-awake awakeFrag=${sickNight.pillars.awakeFragmentation}, expected 0`,
  );

  const roundedDownSickNight = scoreSleepMVP(baseInput({
    inBedMinutes: Math.round((7.5 + 2.4) * 60),
    stages: { core: 4.6, deep: 1.4, rem: 1.5, awake: 2.4, total: 7.5 },
  }))!;
  expect(
    roundedDownSickNight.score <= 44 && roundedDownSickNight.rating === 'Poor',
    `~2.5h awake after HealthKit rounding should still cap below 45; got score=${roundedDownSickNight.score}`,
  );
}


// ─── Case 4b: fragmented + off vitals clamps harder ─────────────────────────
console.log('\n[case] Fragmented sick night uses corroborating vitals');
{
  const bedtimeHistory = Array.from({ length: 15 }, () => 23 * 60);
  const correlatedSickNight = scoreSleep(baseInput({
    hrvMs: 34,
    restingHeartRate: 68,
    respiratoryRate: 18.4,
    spo2Percent: 94,
    hrvHistory: Array.from({ length: 15 }, () => 58),
    rhrHistory: Array.from({ length: 15 }, () => 56),
    respiratoryRateHistory: Array.from({ length: 15 }, () => 15),
    spo2History: Array.from({ length: 15 }, () => 97),
    bedtimeHistory,
    inBedMinutes: Math.round((7.5 + 2.0) * 60),
    stages: { core: 4.6, deep: 1.4, rem: 1.5, awake: 2.0, total: 7.5 },
  }))!;
  expect(
    correlatedSickNight.score <= 39 && correlatedSickNight.rating === 'Poor',
    `fragmented sleep with HRV/RHR/resp/SpO2 stress should cap near 39; got score=${correlatedSickNight.score}`,
  );
}


// ─── Case 4c: duration-only data can't look excellent ───────────────────────
console.log('\n[case] Duration-only sleep data caps below Good/Excellent');
{
  const durationOnly = scoreSleepMVP(baseInput({
    inBedMinutes: null,
    deepSleepHours: null,
    remSleepHours: null,
    hrvMs: null,
    spo2Percent: null,
    respiratoryRate: null,
    stages: null,
  }))!;
  expect(durationOnly.score <= 69,
    `duration-only score should cap at Fair-ish, got ${durationOnly.score}`);
  expect(durationOnly.insights.some(s => s.toLowerCase().includes('only sleep duration')),
    `expected limited-data insight; got: ${JSON.stringify(durationOnly.insights)}`);
}


// ─── Case 5: clean MVP night still matches the visible pillar sum ────────────
console.log('\n[case] Clean MVP night matches visible pillar sum');
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

console.log('\n[case] Personalized bedtime regularity follows the current bedtime');
{
  const hrvHistory = Array.from({ length: 14 }, () => 55);
  const bedtimeHistory = Array.from({ length: 14 }, () => 23 * 60);
  const onTime = scoreSleepPersonalized({
    ...baseInput(),
    bedtimeMinutes: 23 * 60 + 15,
    hrvHistory,
    bedtimeHistory,
  })!;
  const late = scoreSleepPersonalized({
    ...baseInput(),
    bedtimeMinutes: 1 * 60,
    hrvHistory,
    bedtimeHistory,
  })!;
  expect(onTime.pillars.regularity === 15, `bedtime inside target should get full regularity, got ${onTime.pillars.regularity}`);
  expect((late.pillars.regularity ?? 99) <= 3, `bedtime far from target should dock regularity, got ${late.pillars.regularity}`);
  expect(onTime.score > late.score, `on-time bedtime score=${onTime.score} should beat late bedtime score=${late.score}`);
}


console.log('\n✓ All sleep-score patch cases passed.\n');
