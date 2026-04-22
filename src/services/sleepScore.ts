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

  const duration = scoreDuration(hours);
  const efficiency = scoreEfficiency(hours, input.inBedMinutes, 20);
  const hrvFallback = scoreHrvFallback(input.hrvMs, input.age);
  const stageComposite = scoreStageComposite(input.deepSleepHours, input.remSleepHours, hours);
  const healthFlags = scoreHealthFlags(input.spo2Percent, input.respiratoryRate, 10);

  const pillars: SleepScorePillars = {
    duration: duration.points,
    efficiency: efficiency.points,
    hrv: hrvFallback.points,
    stageComposite: stageComposite.points,
    healthFlags: healthFlags.points,
  };

  const total = clamp(
    duration.points + efficiency.points + hrvFallback.points + stageComposite.points + healthFlags.points,
    0,
    100,
  );

  const insights = buildInsights([duration, efficiency, hrvFallback, stageComposite, healthFlags]);

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

  const duration = scoreDurationPersonalized(hours);
  const efficiency = scoreEfficiency(hours, input.inBedMinutes, 20);
  const hrvBaseline = scoreHrvBaseline(input.hrvMs, input.hrvHistory ?? null, input.age);
  const regularity = scoreRegularity(input.bedtimeHistory ?? null);
  const stageComposite = scoreStageCompositePersonalized(input.deepSleepHours, input.remSleepHours, hours);
  const healthFlags = scoreHealthFlagsPersonalized(input.spo2Percent, input.respiratoryRate);

  const pillars: SleepScorePillars = {
    duration: duration.points,
    efficiency: efficiency.points,
    hrv: hrvBaseline.points,
    regularity: regularity.points,
    stageComposite: stageComposite.points,
    healthFlags: healthFlags.points,
  };

  const total = clamp(
    duration.points + efficiency.points + hrvBaseline.points + regularity.points + stageComposite.points + healthFlags.points,
    0,
    100,
  );

  const insights = buildInsights([duration, efficiency, hrvBaseline, regularity, stageComposite, healthFlags]);

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
function scoreDuration(hours: number): PillarResult {
  let points: number;
  let insight: string | undefined;
  if (hours >= 7 && hours <= 9) points = 35;
  else if ((hours >= 6.5 && hours < 7) || (hours > 9 && hours <= 9.5)) points = 30;
  else if ((hours >= 6 && hours < 6.5) || (hours > 9.5 && hours <= 10)) points = 22;
  else if (hours >= 5 && hours < 6) { points = 12; insight = 'Sleep duration below target'; }
  else { points = 4; insight = hours < 5 ? 'Very short sleep — prioritise rest' : 'Oversleeping — check for illness or debt'; }
  return { points, insight };
}

function scoreDurationPersonalized(hours: number): PillarResult {
  let points: number;
  let insight: string | undefined;
  if (hours >= 7 && hours <= 9) points = 30;
  else if ((hours >= 6.5 && hours < 7) || (hours > 9 && hours <= 9.5)) points = 25;
  else if ((hours >= 6 && hours < 6.5) || (hours > 9.5 && hours <= 10)) points = 18;
  else if (hours >= 5 && hours < 6) { points = 9; insight = 'Sleep duration below target'; }
  else { points = 3; insight = hours < 5 ? 'Very short sleep — prioritise rest' : 'Unusually long sleep'; }
  return { points, insight };
}

// Efficiency — time asleep / time in bed. Low = fragmented sleep.
function scoreEfficiency(hours: number, inBedMinutes: number | null, max: number): PillarResult {
  if (inBedMinutes == null || inBedMinutes <= 0) {
    // Neutral: 60% of max, rounded
    return { points: Math.round(max * 0.6), ratio: null };
  }
  const asleepMin = hours * 60;
  const ratio = asleepMin / inBedMinutes;
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

// HRV vs personal baseline (personalized) — rolling median of last 14-30 nights.
function scoreHrvBaseline(
  hrv: number | null,
  history: number[] | null,
  age: number | null,
): PillarResult {
  if (hrv == null) return { points: 10 };
  if (!history || history.length < 14) {
    // Fall back to age-adjusted MVP method, mapped onto 20-pt scale (same scale).
    return scoreHrvFallback(hrv, age);
  }
  const baseline = rollingMedian(history);
  if (!baseline || baseline <= 0) return scoreHrvFallback(hrv, age);
  const ratio = hrv / baseline;
  let points: number;
  let insight: string | undefined;
  if (ratio >= 1.10) points = 20;
  else if (ratio >= 0.98) points = 16;
  else if (ratio >= 0.90) points = 12;
  else if (ratio >= 0.80) { points = 7; insight = 'HRV below your recent baseline'; }
  else { points = 2; insight = 'HRV well below your recent baseline'; }
  return { points, insight, ratio };
}

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

// Stage composite — combined (deep + REM) / total. Kept light.
function scoreStageComposite(
  deepHrs: number | null,
  remHrs: number | null,
  totalHrs: number,
): PillarResult {
  if (deepHrs == null || remHrs == null || totalHrs <= 0) return { points: 8 };
  const ratio = (deepHrs + remHrs) / totalHrs;
  let points: number;
  if (ratio >= 0.30 && ratio <= 0.50) points = 15;
  else if ((ratio >= 0.25 && ratio < 0.30) || (ratio > 0.50 && ratio <= 0.55)) points = 12;
  else if ((ratio >= 0.20 && ratio < 0.25) || (ratio > 0.55 && ratio <= 0.60)) points = 8;
  else if (ratio >= 0.15 && ratio < 0.20) points = 4;
  else points = 1;
  return { points, ratio };
}

function scoreStageCompositePersonalized(
  deepHrs: number | null,
  remHrs: number | null,
  totalHrs: number,
): PillarResult {
  if (deepHrs == null || remHrs == null || totalHrs <= 0) return { points: 5 };
  const ratio = (deepHrs + remHrs) / totalHrs;
  let points: number;
  if (ratio >= 0.30 && ratio <= 0.50) points = 10;
  else if ((ratio >= 0.25 && ratio < 0.30) || (ratio > 0.50 && ratio <= 0.55)) points = 8;
  else if ((ratio >= 0.20 && ratio < 0.25) || (ratio > 0.55 && ratio <= 0.60)) points = 5;
  else if (ratio >= 0.15 && ratio < 0.20) points = 2;
  else points = 0;
  return { points, ratio };
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
