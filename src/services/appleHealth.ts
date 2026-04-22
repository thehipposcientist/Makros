import { Platform } from 'react-native';
import type { HealthSummary, SleepScore, SleepStages, WorkoutDetail } from '../types';

let _module: any = null;
let _moduleChecked = false;
let _lastHealthKitError: string | null = null;

function getModule(): any {
  if (Platform.OS !== 'ios') return null;
  if (!_moduleChecked) {
    _moduleChecked = true;
    try {
      _module = require('../../modules/thallo-healthkit').default;
    } catch {
      console.warn('[appleHealth] thallo-healthkit module not available');
    }
  }
  return _module;
}

const READ_TYPES = [
  'HeartRate',
  'RestingHeartRate',
  'StepCount',
  'SleepAnalysis',
  'ActiveEnergyBurned',
  'Workout',
  'Weight',
  'HeartRateVariabilitySDNN',
  'VO2Max',
  'RespiratoryRate',
  'OxygenSaturation',
  'StandHour',
  'MindfulSession',
  'BasalEnergyBurned',
];

export function isHealthKitAvailable(): boolean {
  if (Platform.OS !== 'ios') return false;
  const mod = getModule();
  if (!mod) return false;
  try {
    return mod.isAvailable();
  } catch {
    return false;
  }
}

export function isHealthKitNativeBindingsMissing(): boolean {
  if (Platform.OS !== 'ios') return false;
  return !getModule();
}

export function getLastHealthKitError(): string | null {
  return _lastHealthKitError;
}

export async function diagnoseHealthKit(): Promise<string> {
  const lines: string[] = [];
  lines.push(`platform=${Platform.OS}`);
  if (Platform.OS !== 'ios') {
    lines.push('result=SKIP (iOS only)');
    return lines.join('\n');
  }
  const mod = getModule();
  if (!mod) {
    lines.push('native_module=NOT_LOADED');
    lines.push('fix=Run: eas build --profile development --platform ios --clear-cache, then install the new build on device.');
    return lines.join('\n');
  }
  lines.push('native_module=LOADED');
  const ok = await requestHealthPermissions();
  lines.push(`auth_ok=${ok}`);
  if (!ok && _lastHealthKitError) lines.push(`auth_error=${_lastHealthKitError}`);
  return lines.join('\n');
}

export async function requestHealthPermissions(): Promise<boolean> {
  const mod = getModule();
  if (!mod) {
    _lastHealthKitError = 'Native module not loaded — needs a fresh EAS build.';
    return false;
  }
  try {
    const ok = await mod.requestAuthorization(READ_TYPES);
    _lastHealthKitError = ok ? null : 'Authorization returned false';
    return ok;
  } catch (e: any) {
    _lastHealthKitError = e?.message ?? String(e);
    console.warn('[appleHealth] requestAuthorization error:', _lastHealthKitError);
    return false;
  }
}

export async function readHealthSummary(): Promise<HealthSummary | null> {
  const mod = getModule();
  if (!mod) return null;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const oneDayAgo = new Date(now.getTime() - 86400000);
  const startMs = sevenDaysAgo.getTime();
  const endMs = now.getTime();
  const lastNightStart = oneDayAgo.getTime();

  const [
    restingHR, steps, workoutCount, sleepSamples, energySamples,
    hrvSamples, vo2Samples, respSamples, spo2Samples,
    standSamples, mindfulSamples, basalSamples, workoutDetails,
    lastNightSleep, lastNightHRV, lastNightResp, lastNightSpo2,
  ] = await Promise.all([
    mod.getRestingHeartRate(startMs, endMs, 7).catch(() => []),
    mod.getDailySteps(startMs, endMs).catch(() => []),
    mod.getWorkoutCount(startMs, endMs).catch(() => 0),
    mod.getSleepSamples(startMs, endMs).catch(() => []),
    mod.getActiveEnergyBurned(startMs, endMs).catch(() => []),
    mod.getHRV(startMs, endMs, 14).catch(() => []),
    mod.getVO2Max(startMs, endMs, 1).catch(() => []),
    mod.getRespiratoryRate(startMs, endMs, 7).catch(() => []),
    mod.getOxygenSaturation(startMs, endMs, 7).catch(() => []),
    mod.getStandingHours(startMs, endMs).catch(() => []),
    mod.getMindfulMinutes(startMs, endMs).catch(() => []),
    mod.getBasalEnergyBurned(startMs, endMs).catch(() => []),
    mod.getWorkouts(startMs, endMs).catch(() => []),
    mod.getSleepSamples(lastNightStart, endMs).catch(() => []),
    mod.getHRV(lastNightStart, endMs, 7).catch(() => []),
    mod.getRespiratoryRate(lastNightStart, endMs, 3).catch(() => []),
    mod.getOxygenSaturation(lastNightStart, endMs, 3).catch(() => []),
  ]);

  const sleepScore = buildSleepScore(lastNightSleep, lastNightHRV, lastNightResp, lastNightSpo2);

  return {
    restingHeartRate: avgValue(restingHR),
    avgSteps7d: avgValue(steps),
    workouts7d: workoutCount,
    avgSleepHours7d: calcAvgSleep(sleepSamples),
    lastNightSleepHours: calcLastNightSleep(sleepSamples),
    activeEnergy7d: totalValue(energySamples),
    hrvAvg: avgValue(hrvSamples),
    vo2Max: vo2Samples?.[0]?.value ?? null,
    respiratoryRate: avgValue(respSamples),
    oxygenSaturation: avgValue(spo2Samples),
    standingHours7d: standSamples?.filter((s: any) => s.value === 1).length ?? null,
    mindfulMinutes7d: totalMinutes(mindfulSamples),
    basalEnergy7d: totalValue(basalSamples),
    sleepScore,
    workoutDetails: (workoutDetails ?? []) as WorkoutDetail[],
    fetchedAt: now.toISOString(),
  };
}

// ── Sleep Score ──────────────────────────────────────────────────────────────

function buildSleepScore(
  sleepSamples: any[],
  hrvSamples: any[],
  respSamples: any[],
  spo2Samples: any[],
): SleepScore | null {
  const stages = calcSleepStages(sleepSamples);
  if (!stages || stages.total < 1) return null;

  const hrvAvg = avgValue(hrvSamples);
  const respRate = avgValue(respSamples);
  const spo2 = avgValue(spo2Samples);
  const insights: string[] = [];

  // Duration score (0-35): 7-9h optimal
  let durationScore = 0;
  if (stages.total >= 7 && stages.total <= 9) {
    durationScore = 35;
  } else if (stages.total >= 6 && stages.total < 7) {
    durationScore = 25;
  } else if (stages.total > 9 && stages.total <= 10) {
    durationScore = 28;
  } else if (stages.total >= 5) {
    durationScore = 15;
  } else {
    durationScore = 5;
  }

  if (stages.total < 6) insights.push('Sleep under 6 hours — aim for 7-9h');
  else if (stages.total >= 7 && stages.total <= 9) insights.push('Great sleep duration');
  else if (stages.total > 9.5) insights.push('Oversleeping may indicate recovery need');

  // Deep sleep score (0-25): 13-23% is optimal
  let deepScore = 0;
  const deepPct = stages.total > 0 ? (stages.deep / stages.total) * 100 : 0;
  if (deepPct >= 13 && deepPct <= 23) {
    deepScore = 25;
    insights.push(`Deep sleep ${deepPct.toFixed(0)}% — optimal range`);
  } else if (deepPct >= 8 && deepPct < 13) {
    deepScore = 15;
    insights.push(`Deep sleep ${deepPct.toFixed(0)}% — slightly below ideal`);
  } else if (deepPct > 23) {
    deepScore = 20;
  } else if (deepPct > 0) {
    deepScore = 8;
    insights.push(`Deep sleep only ${deepPct.toFixed(0)}% — aim for 13-23%`);
  }

  // REM score (0-20): 20-25% optimal
  let remScore = 0;
  const remPct = stages.total > 0 ? (stages.rem / stages.total) * 100 : 0;
  if (remPct >= 20 && remPct <= 25) {
    remScore = 20;
    insights.push(`REM sleep ${remPct.toFixed(0)}% — excellent`);
  } else if (remPct >= 15 && remPct < 20) {
    remScore = 14;
  } else if (remPct > 25) {
    remScore = 16;
  } else if (remPct > 0) {
    remScore = 6;
    insights.push(`REM sleep ${remPct.toFixed(0)}% — below 15% target`);
  }

  // HRV score (0-10)
  let hrvScore = 0;
  if (hrvAvg != null) {
    if (hrvAvg >= 50) hrvScore = 10;
    else if (hrvAvg >= 30) hrvScore = 6;
    else hrvScore = 3;
    if (hrvAvg < 30) insights.push('Low HRV — may indicate stress or fatigue');
    else if (hrvAvg >= 60) insights.push('Strong HRV — good autonomic recovery');
  }

  // SpO2 score (0-5)
  let spo2Score = 0;
  if (spo2 != null) {
    if (spo2 >= 96) spo2Score = 5;
    else if (spo2 >= 94) spo2Score = 3;
    else spo2Score = 1;
    if (spo2 < 94) insights.push(`Blood oxygen ${spo2.toFixed(0)}% — below normal range`);
  }

  // Respiratory rate score (0-5)
  let respScore = 0;
  if (respRate != null) {
    if (respRate >= 12 && respRate <= 18) respScore = 5;
    else if (respRate > 18 && respRate <= 22) respScore = 3;
    else respScore = 1;
    if (respRate > 20) insights.push(`Elevated respiratory rate (${respRate.toFixed(0)} brpm)`);
  }

  const score = Math.min(100, durationScore + deepScore + remScore + hrvScore + spo2Score + respScore);

  let rating: SleepScore['rating'];
  if (score >= 80) rating = 'Excellent';
  else if (score >= 60) rating = 'Good';
  else if (score >= 40) rating = 'Fair';
  else rating = 'Poor';

  return {
    score,
    rating,
    duration: Math.round(stages.total * 10) / 10,
    stages,
    hrvAvg,
    respiratoryRate: respRate,
    oxygenSaturation: spo2,
    insights: insights.slice(0, 4),
  };
}

function calcSleepStages(samples: any[]): SleepStages | null {
  if (!samples?.length) return null;

  // Find last night's sleep: group by end-date, pick latest night
  const nightMap = new Map<string, any[]>();
  for (const s of samples) {
    if (s.value === 'INBED') continue;
    const nightKey = s.endDate?.slice(0, 10);
    if (!nightKey) continue;
    if (!nightMap.has(nightKey)) nightMap.set(nightKey, []);
    nightMap.get(nightKey)!.push(s);
  }

  if (!nightMap.size) return null;
  const lastNight = [...nightMap.keys()].sort().pop()!;
  const nightSamples = nightMap.get(lastNight)!;

  let core = 0, deep = 0, rem = 0, awake = 0;
  for (const s of nightSamples) {
    const dur = (new Date(s.endDate).getTime() - new Date(s.startDate).getTime()) / 3600000;
    if (dur <= 0 || dur > 24) continue;
    switch (s.value) {
      case 'CORE': core += dur; break;
      case 'DEEP': deep += dur; break;
      case 'REM': rem += dur; break;
      case 'AWAKE': awake += dur; break;
      case 'ASLEEP': core += dur; break;
    }
  }

  const total = core + deep + rem;
  return { core: round1(core), deep: round1(deep), rem: round1(rem), awake: round1(awake), total: round1(total) };
}

// ── Generic helpers ──────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function avgValue(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  const vals = samples.map((s) => s.value).filter((v) => v > 0);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function totalValue(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  return Math.round(samples.reduce((sum, s) => sum + (s.value ?? 0), 0));
}

function totalMinutes(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  return Math.round(samples.reduce((sum, s) => sum + (s.value ?? 0), 0));
}

function calcAvgSleep(samples: Array<{ value: string; startDate: string; endDate: string }> | null): number | null {
  const nights = groupSleepByNight(samples);
  if (!nights.size) return null;
  const total = [...nights.values()].reduce((a, b) => a + b, 0);
  return Math.round((total / nights.size) * 10) / 10;
}

function calcLastNightSleep(samples: Array<{ value: string; startDate: string; endDate: string }> | null): number | null {
  const nights = groupSleepByNight(samples);
  if (!nights.size) return null;
  const sorted = [...nights.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  return Math.round(sorted[0][1] * 10) / 10;
}

function groupSleepByNight(samples: Array<{ value: string; startDate: string; endDate: string }> | null): Map<string, number> {
  const nightMap = new Map<string, number>();
  if (!samples?.length) return nightMap;

  const asleep = samples.filter(
    (s) => s.value === 'ASLEEP' || s.value === 'CORE' || s.value === 'DEEP' || s.value === 'REM',
  );

  for (const s of asleep) {
    const dur = (new Date(s.endDate).getTime() - new Date(s.startDate).getTime()) / 3600000;
    if (dur <= 0 || dur > 24) continue;
    const nightKey = s.endDate.slice(0, 10);
    nightMap.set(nightKey, (nightMap.get(nightKey) ?? 0) + dur);
  }
  return nightMap;
}
