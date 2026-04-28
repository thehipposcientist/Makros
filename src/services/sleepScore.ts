// Sleep score v2 — consumer wellness score (not medical).
//
// Two modes:
//   - MVP:          no history needed, age-adjusted HRV reference.
//   - Personalized: 14+ nights of history, HRV vs user's rolling baseline,
//                   plus sleep regularity pillar.
//
// Design rules:
//   - Duration + efficiency drive the score (reliable signals).
//   - Stage data is noisy → light weight, broad bands.
//   - HRV becomes relative as soon as baseline exists.
//   - SpO2 + respiratory rate are deduction-only guardrails.
//   - Missing data = neutral score, never harshly punished.

import type { SleepScore, SleepScorePillars, SleepStages } from '../types';

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface SleepScoreInput {
  totalSleepHours: number | null;
  inBedMinutes: number | null;
  deepSleepHours: number | null;
  remSleepHours: number | null;
  hrvMs: number | null;
  spo2Percent: number | null;
  respiratoryRate: number | null;
  age: number | null;
  stages?: SleepStages | null;
  // History (personalized mode only):
  hrvHistory?: number[] | null;           // last 14-30 nightly HRV values
  bedtimeHistory?: number[] | null;       // last 14 nightly onset times (minutes from midnight, 0-1439)
}

// ── Public API ───────────────────────────────────────────────────────────────

export function scoreSleep(input: SleepScoreInput): SleepScore | null {
  const hasHrvBaseline = Array.isArray(input.hrvHistory) && input.hrvHistory.length >= 14;
  const hasBedtimes = Array.isArray(input.bedtimeHistory) && input.bedtimeHistory.length >= 14;
  if (hasHrvBaseline && hasBedtimes) return scoreSleepPersonalized(input);
  return scoreSleepMVP(input);
}

export function scoreSleepMVP(input: SleepScoreInput): SleepScore | null {
  const hours = input.totalSleepHours;
  if (hours == null || hours < 0.5) return null;

  // MVP weights — recovery-app calibrated. Deep is weighted 2× REM
  // because deep sleep drives physical recovery (HGH release, slow-
  // wave consolidation) and REM is more cognitive-recovery skewed.
  // Awake/fragmentation is small (5) because efficiency already
  // captures the gross signal — this is just a top-up penalty for
  // mid-sleep wake patterns.
  const duration = scoreDuration(hours);                                          // 32
  const efficiency = scoreEfficiency(hours, input.inBedMinutes, 18);              // 18
  const hrvFallback = scoreHrvFallback(input.hrvMs, input.age);                   // 20
  const deepSleep = scoreDeepSleep(input.deepSleepHours, hours, 10);              // 10
  const remSleep = scoreRemSleep(input.remSleepHours, hours, 5);                  //  5
  const healthFlags = scoreHealthFlags(input.spo2Percent, input.respiratoryRate, 10); // 10
  const awakeFrag = scoreAwakeFragmentation(awakeMinutesFromInput(input), 5);     //  5

  const pillars: SleepScorePillars = {
    duration: duration.points,
    efficiency: efficiency.points,
    hrv: hrvFallback.points,
    // Legacy aggregate — keeps the older `stageComposite` slot useful
    // for any consumer reading by name without a code change.
    stageComposite: deepSleep.points + remSleep.points,
    deepSleep: deepSleep.points,
    remSleep: remSleep.points,
    healthFlags: healthFlags.points,
    awakeFragmentation: awakeFrag.points,
  };

  const total = clamp(
    duration.points + efficiency.points + hrvFallback.points
      + deepSleep.points + remSleep.points
      + healthFlags.points + awakeFrag.points,
    0,
    100,
  );

  // Insight order: prioritize deep over REM over fragmentation when
  // multiple are flagged. Deep sleep is the highest-leverage coaching
  // surface for a recovery app.
  const insights = buildInsights([duration, efficiency, hrvFallback, deepSleep, remSleep, healthFlags, awakeFrag]);

  return {
    score: Math.round(total),
    rating: ratingFor(total),
    mode: 'mvp',
    duration: hours,
    stages: input.stages ?? emptyStages(hours, input.deepSleepHours, input.remSleepHours),
    hrvAvg: input.hrvMs,
    respiratoryRate: input.respiratoryRate,
    oxygenSaturation: input.spo2Percent,
    efficiency: efficiency.ratio ?? null,
    pillars,
    insights,
  };
}

export function scoreSleepPersonalized(input: SleepScoreInput): SleepScore | null {
  const hours = input.totalSleepHours;
  if (hours == null || hours < 0.5) return null;

  // Personalized weights — same deep/REM/awake split as MVP, but trim
  // duration / efficiency / HRV / health-flags to make room for the
  // 15-pt regularity pillar that's only meaningful with history.
  const duration = scoreDurationPersonalized(hours);                              // 28
  const efficiency = scoreEfficiency(hours, input.inBedMinutes, 17);              // 17
  const hrvBaseline = scoreHrvBaselinePersonalized(input.hrvMs, input.hrvHistory ?? null, input.age, 18); // 18
  const regularity = scoreRegularity(input.bedtimeHistory ?? null);               // 15
  const deepSleep = scoreDeepSleep(input.deepSleepHours, hours, 9);               //  9
  const remSleep = scoreRemSleep(input.remSleepHours, hours, 4);                  //  4
  const healthFlags = scoreHealthFlagsPersonalized(input.spo2Percent, input.respiratoryRate); // 5
  const awakeFrag = scoreAwakeFragmentation(awakeMinutesFromInput(input), 4);     //  4

  const pillars: SleepScorePillars = {
    duration: duration.points,
    efficiency: efficiency.points,
    hrv: hrvBaseline.points,
    regularity: regularity.points,
    stageComposite: deepSleep.points + remSleep.points,
    deepSleep: deepSleep.points,
    remSleep: remSleep.points,
    healthFlags: healthFlags.points,
    awakeFragmentation: awakeFrag.points,
  };

  const total = clamp(
    duration.points + efficiency.points + hrvBaseline.points + regularity.points
      + deepSleep.points + remSleep.points
      + healthFlags.points + awakeFrag.points,
    0,
    100,
  );

  const insights = buildInsights([duration, efficiency, hrvBaseline, regularity, deepSleep, remSleep, healthFlags, awakeFrag]);

  return {
    score: Math.round(total),
    rating: ratingFor(total),
    mode: 'personalized',
    duration: hours,
    stages: input.stages ?? emptyStages(hours, input.deepSleepHours, input.remSleepHours),
    hrvAvg: input.hrvMs,
    respiratoryRate: input.respiratoryRate,
    oxygenSaturation: input.spo2Percent,
    efficiency: efficiency.ratio ?? null,
    pillars,
    insights,
  };
}

// ── Pillars ──────────────────────────────────────────────────────────────────

interface PillarResult {
  points: number;
  insight?: string;
  ratio?: number | null;
}

// Duration — the single biggest factor. Broad bands; mild penalty for oversleeping.
// Both modes share the same band shape and just scale to a different max
// (32 in MVP, 28 in Personalized) — factored through `scoreDurationBanded`
// so we only edit one place if the curve needs tuning.
function scoreDurationBanded(hours: number, max: number): PillarResult {
  let frac: number;
  let insight: string | undefined;
  if (hours >= 7 && hours <= 9) frac = 1.0;
  else if ((hours >= 6.5 && hours < 7) || (hours > 9 && hours <= 9.5)) frac = 0.85;
  else if ((hours >= 6 && hours < 6.5) || (hours > 9.5 && hours <= 10)) frac = 0.62;
  else if (hours >= 5 && hours < 6) { frac = 0.34; insight = 'Sleep duration below target'; }
  else { frac = 0.10; insight = hours < 5 ? 'Very short sleep — prioritise rest' : 'Oversleeping — check for illness or debt'; }
  return { points: Math.round(max * frac), insight };
}

function scoreDuration(hours: number): PillarResult {
  return scoreDurationBanded(hours, 32);
}

function scoreDurationPersonalized(hours: number): PillarResult {
  return scoreDurationBanded(hours, 28);
}

// Efficiency — time asleep / time in bed. Low = fragmented sleep.
function scoreEfficiency(hours: number, inBedMinutes: number | null, max: number): PillarResult {
  if (inBedMinutes == null || inBedMinutes <= 0) {
    // Neutral: 60% of max, rounded
    return { points: Math.round(max * 0.6), ratio: null };
  }
  const asleepMin = hours * 60;
  // HealthKit occasionally reports more asleep minutes than in-bed samples
  // (different source coverage). Clamp to 100% so the UI never shows >100%.
  const ratio = Math.min(1.0, asleepMin / inBedMinutes);
  let points: number;
  let insight: string | undefined;
  if (ratio >= 0.90) points = max;
  else if (ratio >= 0.85) points = Math.round(max * 0.8);
  else if (ratio >= 0.80) points = Math.round(max * 0.6);
  else if (ratio >= 0.75) { points = Math.round(max * 0.4); insight = 'Low sleep efficiency'; }
  else { points = Math.round(max * 0.15); insight = 'Very low sleep efficiency — fragmented rest'; }
  return { points, insight, ratio };
}

// HRV fallback (MVP) — age-adjusted absolute reference.
function scoreHrvFallback(hrv: number | null, age: number | null): PillarResult {
  if (hrv == null) return { points: 10 }; // neutral
  const ref = ageHrvReference(age);
  const ratio = hrv / ref;
  let points: number;
  let insight: string | undefined;
  if (ratio >= 1.10) points = 20;
  else if (ratio >= 0.95) points = 16;
  else if (ratio >= 0.80) points = 11;
  else if (ratio >= 0.65) points = 6;
  else { points = 2; insight = `Low HRV (${Math.round(hrv)}ms) for age`; }
  return { points, insight, ratio };
}

// (Legacy fixed-20pt HRV-vs-baseline removed — replaced by
// `scoreHrvBaselinePersonalized` below which is max-aware so the
// personalized weight (18) flows through the band table without
// hardcoding numbers.)

// Sleep regularity — circular SD of bedtime minutes-from-midnight.
function scoreRegularity(bedtimes: number[] | null): PillarResult {
  if (!bedtimes || bedtimes.length < 7) return { points: 8 }; // neutral
  const sd = circularBedtimeDeviation(bedtimes);
  let points: number;
  let insight: string | undefined;
  if (sd <= 30) points = 15;
  else if (sd <= 45) points = 11;
  else if (sd <= 60) { points = 7; insight = 'Irregular sleep timing'; }
  else if (sd <= 90) { points = 3; insight = 'Very irregular sleep timing'; }
  else { points = 0; insight = 'Very irregular sleep timing'; }
  return { points, insight, ratio: sd };
}

// Deep sleep pillar — the higher-weight half of the old stage
// composite. Recovery-app calibrated: deep sleep is when slow-wave
// consolidation, HGH release, and most physical recovery happens.
//
// Two scoring paths:
//   1. Full-length nights (≥6.5h asleep) use ABSOLUTE deep minutes.
//      A "good" night needs ~80+ min of deep regardless of how much
//      total sleep you got. Below 40 min on a long night is a real
//      problem; below 60 min is mediocre.
//   2. Short nights (<6.5h) skip the absolute floor — you can't get
//      80 min of deep on 5h of sleep, and the duration pillar
//      already penalizes the short night. Score on ratio instead so
//      a "good for a short night" reading still rewards the user.
//
// Apple Watch stage estimates are noisy, so the bands are deliberately
// generous — we don't want a ±15 min stage error to swing the pillar
// across two bands.
function scoreDeepSleep(
  deepHrs: number | null,
  totalHrs: number,
  max: number,
): PillarResult {
  // Stage data missing → neutral fallback (60% of max). Don't punish
  // users on watches that don't track stages reliably (older Apple
  // Watch SE, Garmin without Body Battery, manual entry).
  if (deepHrs == null || totalHrs <= 0) {
    return { points: Math.round(max * 0.6) };
  }
  const deepMin = deepHrs * 60;
  let frac: number;
  let insight: string | undefined;

  if (totalHrs >= 6.5) {
    // Full-length night → absolute-minutes floor.
    if (deepMin >= 80) {
      frac = 1.0;
    } else if (deepMin >= 60) {
      frac = 0.75;
      insight = 'Deep sleep was a touch low — protect a consistent bedtime tonight.';
    } else if (deepMin >= 40) {
      frac = 0.50;
      insight = 'Deep sleep was below ideal — avoid late alcohol, caffeine, and heavy meals.';
    } else {
      frac = 0.20;
      insight = 'Deep sleep was very low for a full-length night — prioritise consistent bedtime, cool room, no late alcohol or screens.';
    }
  } else {
    // Short night → ratio-based, no absolute floor.
    const ratio = deepHrs / totalHrs;
    if (ratio >= 0.18) frac = 1.0;
    else if (ratio >= 0.13) frac = 0.75;
    else if (ratio >= 0.08) { frac = 0.50; insight = 'Deep-sleep ratio was below ideal.'; }
    else { frac = 0.25; insight = 'Very low deep-sleep ratio — common after late caffeine, alcohol, or stress.'; }
  }
  return { points: Math.round(max * frac), insight, ratio: deepMin };
}

// REM sleep pillar — half-weight of deep. Soft band on the ratio
// (REM / total). Out-of-band on either side reduces, but neither
// extreme is heavily penalized because REM ratio varies meaningfully
// with caffeine, alcohol, sleep debt, and stress.
function scoreRemSleep(
  remHrs: number | null,
  totalHrs: number,
  max: number,
): PillarResult {
  if (remHrs == null || totalHrs <= 0) {
    return { points: Math.round(max * 0.6) };
  }
  const ratio = remHrs / totalHrs;
  let frac: number;
  let insight: string | undefined;
  if (ratio >= 0.18 && ratio <= 0.25) frac = 1.0;
  else if ((ratio >= 0.13 && ratio < 0.18) || (ratio > 0.25 && ratio <= 0.30)) frac = 0.80;
  else if ((ratio >= 0.08 && ratio < 0.13) || (ratio > 0.30 && ratio <= 0.35)) {
    frac = 0.50;
    insight = 'REM sleep was low — late caffeine, alcohol, or short duration may be limiting cognitive recovery.';
  } else {
    frac = 0.20;
    insight = ratio < 0.08
      ? 'Very low REM — stress, late caffeine, or fragmented sleep likely.'
      : 'Unusually high REM ratio — common after sleep debt or recovery rebound.';
  }
  return { points: Math.round(max * frac), insight, ratio };
}

// Awake / fragmentation pillar — penalizes mid-sleep wake on top of
// what `efficiency` already captures. Efficiency = asleep/in-bed
// catches gross fragmentation; this pillar catches the case where
// total awake minutes are notable even on a high-efficiency night.
// Small-weight by design (5 in MVP, 4 in Personalized) so we don't
// double-punish.
function scoreAwakeFragmentation(
  awakeMin: number | null,
  max: number,
): PillarResult {
  if (awakeMin == null) {
    return { points: Math.round(max * 0.6) };
  }
  let frac: number;
  let insight: string | undefined;
  if (awakeMin <= 30) frac = 1.0;
  else if (awakeMin <= 60) frac = 0.80;
  else if (awakeMin <= 90) {
    frac = 0.50;
    insight = `Mid-sleep wake totaled ${Math.round(awakeMin)} min — check room temp, light, or late hydration.`;
  } else {
    frac = 0.20;
    insight = `Highly fragmented night (${Math.round(awakeMin)} min awake). If this is recurring, consider a sleep professional.`;
  }
  return { points: Math.round(max * frac), insight, ratio: awakeMin };
}

// HRV vs personal baseline — like `scoreHrvBaseline` but max-aware so
// the personalized weight (18) flows through the bands cleanly without
// hardcoding numbers per band.
function scoreHrvBaselinePersonalized(
  hrv: number | null,
  history: number[] | null,
  age: number | null,
  max: number,
): PillarResult {
  if (hrv == null) return { points: Math.round(max * 0.5) };
  if (!history || history.length < 14) {
    // Fall back to the absolute reference, scaled to this max.
    const base = scoreHrvFallback(hrv, age);
    // scoreHrvFallback assumes a 20-pt scale; rescale.
    return { ...base, points: Math.round((base.points / 20) * max) };
  }
  const baseline = rollingMedian(history);
  if (!baseline || baseline <= 0) {
    const base = scoreHrvFallback(hrv, age);
    return { ...base, points: Math.round((base.points / 20) * max) };
  }
  const ratio = hrv / baseline;
  let frac: number;
  let insight: string | undefined;
  if (ratio >= 1.10) frac = 1.0;
  else if (ratio >= 0.98) frac = 0.80;
  else if (ratio >= 0.90) frac = 0.60;
  else if (ratio >= 0.80) { frac = 0.35; insight = 'HRV below your recent baseline'; }
  else { frac = 0.10; insight = 'HRV well below your recent baseline'; }
  return { points: Math.round(max * frac), insight, ratio };
}

// Health flags — start at max, deduct for abnormal signals. Deduction-only.
function scoreHealthFlags(spo2: number | null, respRate: number | null, max: number): PillarResult {
  let points = max;
  let insight: string | undefined;
  if (spo2 != null) {
    if (spo2 < 94) points -= 6;
    else if (spo2 < 95) points -= 3;
  }
  if (respRate != null) {
    if (respRate < 10 || respRate > 22) points -= 4;
    else if (respRate < 12 || respRate > 20) points -= 2;
  }
  points = clamp(points, 0, max);
  if (points < max) insight = 'Breathing signals outside normal range';
  return { points, insight };
}

function scoreHealthFlagsPersonalized(spo2: number | null, respRate: number | null): PillarResult {
  const MAX = 5;
  let points = MAX;
  let insight: string | undefined;
  if (spo2 != null) {
    if (spo2 < 94) points -= 3;
    else if (spo2 < 95) points -= 1;
  }
  if (respRate != null) {
    if (respRate < 10 || respRate > 22) points -= 2;
    else if (respRate < 12 || respRate > 20) points -= 1;
  }
  points = clamp(points, 0, MAX);
  if (points < MAX) insight = 'Breathing signals outside normal range';
  return { points, insight };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Pull awake minutes from the most reliable available source on the
 *  input. Prefers `stages.awake` (in hours from HealthKit) → minutes;
 *  returns null when no signal is present so the awake-fragmentation
 *  pillar can apply its neutral fallback. */
function awakeMinutesFromInput(input: SleepScoreInput): number | null {
  const awakeHrs = input.stages?.awake;
  if (typeof awakeHrs === 'number' && Number.isFinite(awakeHrs) && awakeHrs >= 0) {
    return awakeHrs * 60;
  }
  return null;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function ageHrvReference(age: number | null): number {
  if (age == null) return 50;
  if (age < 30) return 70;
  if (age < 40) return 60;
  if (age < 50) return 50;
  if (age < 60) return 40;
  return 32;
}

// Rolling median of a numeric array; returns null if empty.
export function rollingMedian(values: number[]): number | null {
  const vals = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0).slice();
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

export function rollingAverage(values: number[]): number | null {
  const vals = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Circular deviation for clock-time data in minutes from midnight (0-1439).
// Handles midnight wraparound: bedtimes at 23:50 and 00:10 should be 20 min apart, not 23h40m.
// Uses mean-of-unit-vectors approach, then returns the circular SD in minutes.
export function circularBedtimeDeviation(bedtimes: number[]): number {
  const valid = bedtimes.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440);
  if (valid.length < 2) return 0;
  const TWO_PI = Math.PI * 2;
  const radians = valid.map((m) => (m / 1440) * TWO_PI);
  const sinSum = radians.reduce((s, r) => s + Math.sin(r), 0);
  const cosSum = radians.reduce((s, r) => s + Math.cos(r), 0);
  const R = Math.sqrt(sinSum * sinSum + cosSum * cosSum) / valid.length;
  if (R >= 1) return 0;
  // Circular SD in radians → convert to minutes (1440 min = 2π rad).
  const circSdRad = Math.sqrt(-2 * Math.log(R));
  return (circSdRad / TWO_PI) * 1440;
}

// Convert a Date to minutes-from-midnight in the device's local timezone.
export function minutesFromMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function ratingFor(score: number): SleepScore['rating'] {
  if (score >= 85) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Poor';
}

function buildInsights(pillars: PillarResult[]): string[] {
  const out: string[] = [];
  for (const p of pillars) if (p.insight) out.push(p.insight);
  return out.slice(0, 4);
}

function emptyStages(totalHrs: number, deep: number | null, rem: number | null): SleepStages {
  return {
    core: Math.max(0, round1(totalHrs - (deep ?? 0) - (rem ?? 0))),
    deep: deep ?? 0,
    rem: rem ?? 0,
    awake: 0,
    total: round1(totalHrs),
  };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
