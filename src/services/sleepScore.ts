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
//   - SpO2 + respiratory rate are guardrails, not primary drivers.
//   - Missing quality data = neutral-to-conservative. Duration alone
//     should not produce an "Excellent" recovery read.
//   - Prefer soft penalties over hard caps, because caps feel
//     unintuitive and create score cliffs. Keep caps for rare,
//     explainable guardrails only.

import type { SleepScore, SleepScorePillars, SleepStages } from '../types';

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface SleepScoreInput {
  totalSleepHours: number | null;
  inBedMinutes: number | null;
  deepSleepHours: number | null;
  remSleepHours: number | null;
  hrvMs: number | null;
  restingHeartRate?: number | null;
  spo2Percent: number | null;
  respiratoryRate: number | null;
  age: number | null;
  stages?: SleepStages | null;
  bedtimeMinutes?: number | null;
  // History (personalized mode only):
  hrvHistory?: number[] | null;           // last 14-30 nightly HRV values
  rhrHistory?: number[] | null;           // last 14-30 resting-heart-rate values
  respiratoryRateHistory?: number[] | null;
  spo2History?: number[] | null;
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
  // captures the gross signal. Severe wake time is handled by rare
  // guardrails below so a fragmented night cannot look deceptively
  // "fair".
  const duration = scoreDuration(hours);                                          // 32
  const efficiency = scoreEfficiency(hours, input.inBedMinutes, 18);              // 18
  const hrvFallback = scoreHrvFallback(input.hrvMs, input.age);                   // 20
  const deepSleep = scoreDeepSleep(input.deepSleepHours, hours, 10);              // 10
  const remSleep = scoreRemSleep(input.remSleepHours, hours, 5);                  //  5
  const healthFlags = scoreHealthFlags(input, 10);                              // 10
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

  const rawTotal = clamp(
    duration.points + efficiency.points + hrvFallback.points
      + deepSleep.points + remSleep.points
      + healthFlags.points + awakeFrag.points,
    0,
    100,
  );
  const recoveryRisk = calculateRecoveryRiskFactor(input, {
    efficiency,
    hrv: hrvFallback,
  });
  const guardrails = applyExtremeGuardrails(rawTotal * recoveryRisk.factor, input, {
    efficiency,
    hrv: hrvFallback,
    maxQualitySignalsForExcellent: 2,
  });
  const total = guardrails.score;

  // Insight order: rare guardrails / soft recovery limiters explain why
  // a score is lower than the pillar sum, then prioritize deep over REM
  // over fragmentation.
  const insights = buildInsights([guardrails, recoveryRisk, duration, efficiency, hrvFallback, deepSleep, remSleep, healthFlags, awakeFrag]);

  return {
    score: Math.round(total),
    rating: ratingFor(total),
    mode: 'mvp',
    duration: hours,
    stages: input.stages ?? emptyStages(hours, input.deepSleepHours, input.remSleepHours),
    hrvAvg: input.hrvMs,
    restingHeartRate: input.restingHeartRate ?? null,
    respiratoryRate: input.respiratoryRate,
    oxygenSaturation: input.spo2Percent,
    efficiency: efficiency.ratio ?? null,
    bedtimeMinutes: input.bedtimeMinutes ?? null,
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
  const regularity = scoreRegularity(input.bedtimeHistory ?? null, input.bedtimeMinutes ?? null); // 15
  const deepSleep = scoreDeepSleep(input.deepSleepHours, hours, 9);               //  9
  const remSleep = scoreRemSleep(input.remSleepHours, hours, 4);                  //  4
  const healthFlags = scoreHealthFlagsPersonalized(input);                     // 5
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

  const rawTotal = clamp(
    duration.points + efficiency.points + hrvBaseline.points + regularity.points
      + deepSleep.points + remSleep.points
      + healthFlags.points + awakeFrag.points,
    0,
    100,
  );
  const recoveryRisk = calculateRecoveryRiskFactor(input, {
    efficiency,
    hrv: hrvBaseline,
  });
  const guardrails = applyExtremeGuardrails(rawTotal * recoveryRisk.factor, input, {
    efficiency,
    hrv: hrvBaseline,
    maxQualitySignalsForExcellent: 1,
  });
  const total = guardrails.score;

  const insights = buildInsights([guardrails, recoveryRisk, duration, efficiency, hrvBaseline, regularity, deepSleep, remSleep, healthFlags, awakeFrag]);

  return {
    score: Math.round(total),
    rating: ratingFor(total),
    mode: 'personalized',
    duration: hours,
    stages: input.stages ?? emptyStages(hours, input.deepSleepHours, input.remSleepHours),
    hrvAvg: input.hrvMs,
    restingHeartRate: input.restingHeartRate ?? null,
    respiratoryRate: input.respiratoryRate,
    oxygenSaturation: input.spo2Percent,
    efficiency: efficiency.ratio ?? null,
    bedtimeMinutes: input.bedtimeMinutes ?? null,
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

interface RecoveryRiskResult extends PillarResult {
  factor: number;
}

interface GuardrailResult extends PillarResult {
  score: number;
  cap: number;
}

// Duration — the single biggest factor. Full credit requires a full
// recovery window; short nights are limited again by a soft final
// multiplier so good stage ratios can't make a 5h night look excellent.
//
// Use a smooth log-normal curve outside the 7-9h target instead of
// hard bands. This keeps nearby nights nearby in score: 6.49h and
// 6.51h should not feel like different categories. The lower side is
// a little steeper than the upper side because short sleep is usually
// a clearer recovery limiter than sleeping long after accumulated
// fatigue, travel, or illness.
function scoreDurationSmooth(hours: number, max: number): PillarResult {
  const targetMin = 7;
  const targetMax = 9;
  if (hours >= targetMin && hours <= targetMax) {
    return { points: max };
  }

  const isShort = hours < targetMin;
  const boundary = isShort ? targetMin : targetMax;
  const sigma = isShort ? 0.22 : 0.24;
  const distance = Math.abs(Math.log(hours / boundary));
  const curve = Math.exp(-(distance * distance) / (2 * sigma * sigma));
  const floor = isShort ? 0.05 : 0.20;
  const frac = clamp(curve, floor, 1);

  let insight: string | undefined;
  if (isShort) {
    insight = hours < 5
      ? 'Very short sleep — prioritise rest'
      : hours < 6.5
        ? 'Sleep duration below target'
        : 'Sleep duration slightly below target';
  } else if (hours > 10.5) {
    insight = 'Very long sleep duration — often tied to accumulated fatigue, illness, or schedule drift';
  } else if (hours > 9.5) {
    insight = 'Long sleep duration — often tied to accumulated fatigue or schedule drift';
  }

  return { points: Math.round(max * frac), insight };
}

function scoreDuration(hours: number): PillarResult {
  return scoreDurationSmooth(hours, 32);
}

function scoreDurationPersonalized(hours: number): PillarResult {
  return scoreDurationSmooth(hours, 28);
}

// Efficiency — time asleep / time in bed. Low = fragmented sleep.
function scoreEfficiency(hours: number, inBedMinutes: number | null, max: number): PillarResult {
  if (inBedMinutes == null || inBedMinutes <= 0) {
    return { points: Math.round(max * 0.5), insight: 'Sleep efficiency unavailable', ratio: null };
  }
  const asleepMin = hours * 60;
  // HealthKit occasionally reports more asleep minutes than in-bed samples
  // (different source coverage). Clamp to 100% so the UI never shows >100%.
  const ratio = Math.min(1.0, asleepMin / inBedMinutes);
  let points: number;
  let insight: string | undefined;
  if (ratio >= 0.92) points = max;
  else if (ratio >= 0.88) points = Math.round(max * 0.85);
  else if (ratio >= 0.83) points = Math.round(max * 0.65);
  else if (ratio >= 0.78) { points = Math.round(max * 0.42); insight = 'Low sleep efficiency'; }
  else { points = Math.round(max * 0.15); insight = 'Very low sleep efficiency — fragmented rest'; }
  return { points, insight, ratio };
}

// HRV fallback (MVP) — age-adjusted absolute reference.
function scoreHrvFallback(hrv: number | null, age: number | null): PillarResult {
  if (hrv == null) return { points: 8, insight: 'HRV unavailable' };
  const ref = ageHrvReference(age);
  const ratio = hrv / ref;
  let points: number;
  let insight: string | undefined;
  if (ratio >= 1.15) points = 20;
  else if (ratio >= 1.00) points = 16;
  else if (ratio >= 0.88) points = 11;
  else if (ratio >= 0.75) { points = 6; insight = `HRV (${Math.round(hrv)}ms) was below the age reference`; }
  else { points = 2; insight = `Low HRV (${Math.round(hrv)}ms) for age`; }
  return { points, insight, ratio };
}

// (Legacy fixed-20pt HRV-vs-baseline removed — replaced by
// `scoreHrvBaselinePersonalized` below which is max-aware so the
// personalized weight (18) flows through the band table without
// hardcoding numbers.)

// Sleep regularity — last night's bedtime against the recent circular-mean
// bedtime. Falls back to historical scatter when the current onset is missing.
function scoreRegularity(bedtimes: number[] | null, currentBedtime: number | null = null): PillarResult {
  const valid = (bedtimes ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440);
  if (valid.length < 7) return { points: 7, insight: 'Bedtime regularity still calibrating' };
  const current = normalizeClockMinute(currentBedtime);
  const center = current != null ? circularBedtimeMean(valid) : null;
  const variance = current != null && center != null
    ? circularMinuteDistance(current, center)
    : circularBedtimeDeviation(valid);
  let points: number;
  let insight: string | undefined;
  if (variance <= 30) points = 15;
  else if (variance <= 45) points = 11;
  else if (variance <= 60) { points = 7; insight = current != null ? 'Bedtime drifted outside your usual rhythm' : 'Irregular sleep timing'; }
  else if (variance <= 90) { points = 3; insight = current != null ? 'Bedtime was far from your usual rhythm' : 'Very irregular sleep timing'; }
  else { points = 0; insight = current != null ? 'Bedtime was far from your usual rhythm' : 'Very irregular sleep timing'; }
  return { points, insight, ratio: variance };
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
  // Stage data missing → neutral-conservative fallback. Don't tank
  // users on watches that don't track stages reliably (older Apple
  // Watch SE, Garmin without Body Battery, manual entry).
  if (deepHrs == null || totalHrs <= 0) {
    return { points: Math.round(max * 0.5), insight: 'Deep sleep unavailable' };
  }
  const deepMin = deepHrs * 60;
  let frac: number;
  let insight: string | undefined;

  if (totalHrs >= 6.5) {
    // Full-length night → absolute-minutes floor.
    if (deepMin >= 90) {
      frac = 1.0;
    } else if (deepMin >= 70) {
      frac = 0.75;
      insight = 'Deep sleep was a touch low — protect a consistent bedtime tonight.';
    } else if (deepMin >= 50) {
      frac = 0.50;
      insight = 'Deep sleep was below ideal — avoid late alcohol, caffeine, and heavy meals.';
    } else {
      frac = 0.15;
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
    return { points: Math.round(max * 0.5), insight: 'REM sleep unavailable' };
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
// Small-weight by design (5 in MVP, 4 in Personalized); rare guardrails
// handle severe wake time so we don't overstate recovery on sick nights.
function scoreAwakeFragmentation(
  awakeMin: number | null,
  max: number,
): PillarResult {
  if (awakeMin == null) {
    return { points: Math.round(max * 0.5), insight: 'Wake fragmentation unavailable' };
  }
  let frac: number;
  let insight: string | undefined;
  if (awakeMin <= 20) frac = 1.0;
  else if (awakeMin <= 45) frac = 0.65;
  else if (awakeMin <= 75) {
    frac = 0.35;
    insight = `Mid-sleep wake totaled ${Math.round(awakeMin)} min — check room temp, light, or late hydration.`;
  } else if (awakeMin <= 120) {
    frac = 0.10;
    insight = `Highly fragmented night (${Math.round(awakeMin)} min awake). If this keeps repeating, look at bedtime routine, light, temperature, or caffeine timing.`;
  } else {
    frac = 0.0;
    insight = `Severely fragmented night (${Math.round(awakeMin)} min awake). Prioritise recovery today, especially if illness or stress was involved.`;
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
  if (hrv == null) return { points: Math.round(max * 0.4), insight: 'HRV unavailable' };
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
  else if (ratio >= 0.92) frac = 0.60;
  else if (ratio >= 0.85) { frac = 0.35; insight = 'HRV below your recent baseline'; }
  else { frac = 0.10; insight = 'HRV well below your recent baseline'; }
  return { points: Math.round(max * frac), insight, ratio };
}

// Health flags — deduction-style corroborating signals. SpO2 and
// respiratory rate catch breathing disruption; resting HR vs personal
// baseline catches illness/stress load that a pure sleep-duration score
// misses. Missing vitals get conservative-neutral credit instead of free
// perfect points.
function scoreHealthFlags(input: SleepScoreInput, max: number): PillarResult {
  const spo2 = input.spo2Percent;
  const respRate = input.respiratoryRate;
  const rhr = input.restingHeartRate ?? null;
  const hasAnySignal = spo2 != null || respRate != null || rhr != null;
  if (!hasAnySignal) {
    return { points: Math.round(max * 0.7), insight: 'Recovery vitals unavailable' };
  }
  let points = max;
  const insights: string[] = [];
  if (spo2 != null) {
    if (spo2 < 94) { points -= max * 0.6; insights.push('oxygen signal was low'); }
    else if (spo2 < 95) { points -= max * 0.3; insights.push('oxygen signal dipped'); }

    const spo2Base = medianIfEnough(input.spo2History, 7);
    if (spo2Base != null) {
      const drop = spo2Base - spo2;
      if (drop >= 3) { points -= max * 0.3; insights.push('oxygen was below baseline'); }
      else if (drop >= 2) { points -= max * 0.15; insights.push('oxygen was below baseline'); }
    }
  }
  if (respRate != null) {
    if (respRate < 10 || respRate > 22) { points -= max * 0.4; insights.push('breathing rate was out of range'); }
    else if (respRate < 12 || respRate > 20) { points -= max * 0.2; insights.push('breathing rate was elevated'); }

    const respBase = medianIfEnough(input.respiratoryRateHistory, 7);
    if (respBase != null) {
      const delta = respRate - respBase;
      if (delta >= 3) { points -= max * 0.35; insights.push(`breathing rate +${round1(delta)} above baseline`); }
      else if (delta >= 1.5) { points -= max * 0.18; insights.push(`breathing rate +${round1(delta)} above baseline`); }
    }
  }
  if (rhr != null) {
    const rhrBase = medianIfEnough(input.rhrHistory, 7);
    if (rhrBase != null) {
      const delta = rhr - rhrBase;
      if (delta >= 8) { points -= max * 0.45; insights.push(`resting HR +${Math.round(delta)} above baseline`); }
      else if (delta >= 5) { points -= max * 0.25; insights.push(`resting HR +${Math.round(delta)} above baseline`); }
    } else if (rhr >= 95) {
      points -= max * 0.35;
      insights.push('resting HR was high');
    } else if (rhr >= 85) {
      points -= max * 0.18;
      insights.push('resting HR was elevated');
    }
  }
  points = Math.round(clamp(points, 0, max));
  return {
    points,
    insight: points < max ? `Recovery vitals: ${dedupe(insights).slice(0, 2).join('; ')}` : undefined,
  };
}

function scoreHealthFlagsPersonalized(input: SleepScoreInput): PillarResult {
  return scoreHealthFlags(input, 5);
}

export function calculateDurationAdequacyFactor(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0.35;
  if (hours >= 7) return 1;
  if (hours < 4) return lerp(0.35, 0.52, smoothstep(0.5, 4, hours));
  if (hours < 5) return lerp(0.52, 0.68, smoothstep(4, 5, hours));
  if (hours < 6) return lerp(0.68, 0.82, smoothstep(5, 6, hours));
  return lerp(0.82, 1, smoothstep(6, 7, hours));
}

export function calculateOversleepPenalty(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 9.5) return 1;
  if (hours < 10.5) return lerp(1, 0.96, smoothstep(9.5, 10.5, hours));
  if (hours < 11.5) return lerp(0.96, 0.86, smoothstep(10.5, 11.5, hours));
  if (hours < 13) return lerp(0.86, 0.68, smoothstep(11.5, 13, hours));
  return clamp(0.68 - (hours - 13) * 0.04, 0.60, 0.68);
}

function calculateRecoveryRiskFactor(
  input: SleepScoreInput,
  signals: {
    efficiency: PillarResult;
    hrv: PillarResult;
  },
): RecoveryRiskResult {
  const hours = input.totalSleepHours ?? 0;
  const durationFactor = calculateDurationAdequacyFactor(hours);
  const oversleepFactor = calculateOversleepPenalty(hours);
  let factor = durationFactor * oversleepFactor;

  const eff = signals.efficiency.ratio;
  if (eff != null && eff < 0.88) {
    const effFactor = eff <= 0.70 ? 0.86 : lerp(0.86, 1, smoothstep(0.70, 0.88, eff));
    factor *= effFactor;
  }

  const awakeMin = awakeMinutesFromInput(input);
  if (awakeMin != null && awakeMin > 60) {
    const awakeFactor = awakeMin >= 135 ? 0.86 : lerp(1, 0.92, smoothstep(60, 120, awakeMin));
    factor *= awakeFactor;
  }

  const hrvRatio = signals.hrv.ratio;
  if (hrvRatio != null && hrvRatio < 0.80) {
    const hrvFactor = hrvRatio <= 0.55 ? 0.90 : lerp(0.90, 1, smoothstep(0.55, 0.80, hrvRatio));
    factor *= hrvFactor;
  }

  const stress = recoveryStressSignals(input, hrvRatio);
  if (stress.count >= 2) factor *= stress.severeCount >= 1 ? 0.94 : 0.97;

  factor = clamp(factor, 0.35, 1);

  let insight: string | undefined;
  if (hours < 5) {
    insight = 'Very short sleep strongly limited recovery today';
  } else if (hours < 6.5) {
    insight = 'Short sleep softly limited recovery today';
  } else if (hours < 7) {
    insight = 'Slightly short sleep limited top-end recovery';
  } else if (hours > 11.5) {
    insight = 'Very long sleep softly limited recovery today';
  } else if (hours > 10.5) {
    insight = 'Long sleep softly limited top-end recovery';
  } else if (eff != null && eff < 0.80) {
    insight = 'Low sleep efficiency softly limited recovery today';
  } else if (awakeMin != null && awakeMin > 75) {
    insight = 'Wake fragmentation softly limited recovery today';
  } else if (stress.count >= 2) {
    insight = "Recovery markers softly limited today's score";
  }

  return { points: 0, factor, insight };
}

function applyExtremeGuardrails(
  score: number,
  input: SleepScoreInput,
  signals: {
    efficiency: PillarResult;
    hrv: PillarResult;
    maxQualitySignalsForExcellent: number;
  },
): GuardrailResult {
  const hours = input.totalSleepHours ?? 0;
  let cap = 100;
  let insight: string | undefined;

  const applyCap = (nextCap: number, nextInsight?: string) => {
    if (nextCap < cap) {
      cap = nextCap;
      insight = nextInsight;
    }
  };

  // Extreme guardrails stay rare and explainable. Normal short/long
  // sleep uses soft penalties over hard caps, because caps feel
  // unintuitive and create score cliffs.
  if (hours < 2) applyCap(25, 'Extremely low sleep duration');
  else if (hours < 3) applyCap(35, 'Extremely low sleep duration');
  else if (hours < 4) applyCap(49, 'Extremely low sleep duration limits recovery today');
  else if (hours > 14) applyCap(69, 'Sleep duration looks unusually long — sensor overlap may be inflating it');

  const eff = signals.efficiency.ratio;
  if (eff != null) {
    if (eff < 0.65) applyCap(49, 'Extremely low sleep efficiency');
    else if (eff < 0.70) applyCap(59, 'Very low sleep efficiency');
  }

  const awakeMin = awakeMinutesFromInput(input);
  if (awakeMin != null) {
    if (awakeMin >= 180) applyCap(35, 'Extreme wake time caps recovery today');
    else if (awakeMin >= 135) applyCap(44, 'Very high wake time caps recovery today');
    else if (awakeMin >= 120) applyCap(49, 'Severe wake time caps recovery today');
  }

  if (input.spo2Percent != null) {
    if (input.spo2Percent < 90) applyCap(49, 'Very low oxygen signal caps recovery today');
    else if (input.spo2Percent < 92) applyCap(59, 'Low oxygen signal caps recovery today');
    else if (input.spo2Percent < 94) applyCap(69, 'Low oxygen signal caps recovery today');
  }
  if (input.respiratoryRate != null) {
    if (input.respiratoryRate < 8 || input.respiratoryRate > 28) {
      applyCap(59, 'Breathing signal caps recovery today');
    } else if (input.respiratoryRate < 10 || input.respiratoryRate > 22) {
      applyCap(79, 'Breathing signal limits top-end recovery');
    }
  }

  const stress = recoveryStressSignals(input, signals.hrv.ratio);
  if (stress.severeCount >= 2) applyCap(49, 'Multiple recovery markers were off overnight');
  else if (stress.severeCount >= 1 && stress.count >= 3) applyCap(59, 'Recovery markers limit training readiness today');

  if (awakeMin != null && awakeMin >= 120 && stress.count >= 2) {
    applyCap(39, 'Fragmented sleep plus stress markers caps recovery today');
  } else if (awakeMin != null && awakeMin >= 120 && stress.count >= 1) {
    applyCap(42, 'Fragmented sleep plus an off recovery marker caps recovery today');
  }

  const hasEfficiency = input.inBedMinutes != null && input.inBedMinutes > 0;
  const hasHrv = input.hrvMs != null;
  const hasStages = input.deepSleepHours != null || input.remSleepHours != null || input.stages?.awake != null;
  const hasVitals = input.spo2Percent != null || input.respiratoryRate != null || input.restingHeartRate != null;
  const qualitySignals = [hasEfficiency, hasHrv, hasStages, hasVitals].filter(Boolean).length;
  if (qualitySignals === 0) {
    applyCap(69, 'Only sleep duration was available');
  } else if (qualitySignals <= signals.maxQualitySignalsForExcellent) {
    applyCap(84, 'Sleep score still has limited quality data');
  }

  return { points: 0, cap, score: Math.min(score, cap), insight };
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

function recoveryStressSignals(input: SleepScoreInput, hrvRatio: number | null | undefined): { count: number; severeCount: number } {
  let count = 0;
  let severeCount = 0;
  const add = (severe: boolean) => {
    count++;
    if (severe) severeCount++;
  };

  if (hrvRatio != null) {
    if (hrvRatio < 0.65) add(true);
    else if (hrvRatio < 0.80) add(false);
  }

  const rhr = input.restingHeartRate ?? null;
  const rhrBase = medianIfEnough(input.rhrHistory, 7);
  if (rhr != null && rhrBase != null) {
    const delta = rhr - rhrBase;
    if (delta >= 8) add(true);
    else if (delta >= 5) add(false);
  }

  const resp = input.respiratoryRate;
  const respBase = medianIfEnough(input.respiratoryRateHistory, 7);
  if (resp != null && respBase != null) {
    const delta = resp - respBase;
    if (delta >= 3) add(true);
    else if (delta >= 1.5) add(false);
  } else if (resp != null && (resp < 10 || resp > 22)) {
    add(true);
  }

  const spo2 = input.spo2Percent;
  const spo2Base = medianIfEnough(input.spo2History, 7);
  if (spo2 != null) {
    if (spo2 < 94) add(true);
    else if (spo2 < 95) add(false);
    else if (spo2Base != null) {
      const drop = spo2Base - spo2;
      if (drop >= 3) add(true);
      else if (drop >= 2) add(false);
    }
  }
  return { count, severeCount };
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

function medianIfEnough(values: number[] | null | undefined, minCount: number): number | null {
  if (!values || values.length < minCount) return null;
  return rollingMedian(values);
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

function normalizeClockMinute(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded >= 1440) return null;
  return rounded;
}

function circularBedtimeMean(bedtimes: number[]): number | null {
  const valid = bedtimes.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440);
  if (!valid.length) return null;
  const TWO_PI = Math.PI * 2;
  const radians = valid.map((m) => (m / 1440) * TWO_PI);
  const sinSum = radians.reduce((s, r) => s + Math.sin(r), 0);
  const cosSum = radians.reduce((s, r) => s + Math.cos(r), 0);
  const meanRad = Math.atan2(sinSum / valid.length, cosSum / valid.length);
  return ((((meanRad / TWO_PI) * 1440) % 1440) + 1440) % 1440;
}

export function circularMinuteDistance(a: number, b: number): number {
  const from = normalizeClockMinute(a);
  const to = normalizeClockMinute(b);
  if (from == null || to == null) return Number.POSITIVE_INFINITY;
  const direct = Math.abs(from - to);
  return Math.min(direct, 1440 - direct);
}

export interface BedtimeWindow {
  centerMinutes: number;   // circular-mean bedtime (minutes from midnight, 0-1439)
  sdMinutes: number;       // circular SD across the sampled nights
  startMinutes: number;    // suggested window start (0-1439)
  endMinutes: number;      // suggested window end (0-1439)
  nights: number;          // sample size the window was built from
}

// Full-credit bedtime target from recent nightly onset times. The center is
// the circular MEAN of the samples; the half-width matches the regularity
// pillar's full-support band so the UI window aligns with scoring.
// Returns null until 7 nights exist — the same floor `scoreRegularity`
// uses before it leaves "still calibrating".
export function bedtimeWindowFromHistory(bedtimes: number[]): BedtimeWindow | null {
  const valid = bedtimes.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440);
  if (valid.length < 7) return null;
  const centerMinutes = circularBedtimeMean(valid);
  if (centerMinutes == null) return null;
  const sdMinutes = circularBedtimeDeviation(valid);
  const halfWidth = 30;
  const wrap = (m: number) => ((Math.round(m) % 1440) + 1440) % 1440;
  return {
    centerMinutes,
    sdMinutes,
    startMinutes: wrap(centerMinutes - halfWidth),
    endMinutes: wrap(centerMinutes + halfWidth),
    nights: valid.length,
  };
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

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function round1(n: number): number { return Math.round(n * 10) / 10; }
