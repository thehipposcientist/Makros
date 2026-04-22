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
  try { return mod.isAvailable(); } catch { return false; }
}

export function isHealthKitNativeBindingsMissing(): boolean {
  if (Platform.OS !== 'ios') return false;
  return !getModule();
}

export function getLastHealthKitError(): string | null { return _lastHealthKitError; }

export async function diagnoseHealthKit(): Promise<string> {
  const lines: string[] = [];
  lines.push(`platform=${Platform.OS}`);
  if (Platform.OS !== 'ios') { lines.push('result=SKIP (iOS only)'); return lines.join('\n'); }
  const mod = getModule();
  if (!mod) {
    lines.push('native_module=NOT_LOADED');
    lines.push('fix=Run: eas build --profile development --platform ios --clear-cache');
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
  if (!mod) { _lastHealthKitError = 'Native module not loaded — needs a fresh EAS build.'; return false; }
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
  // Use 36h lookback for last-night data so we catch sleep that ended this morning
  const lastNightStart = new Date(now.getTime() - 36 * 3600000);
  const startMs = sevenDaysAgo.getTime();
  const endMs = now.getTime();
  const lastNightMs = lastNightStart.getTime();

  const [
    restingHR, steps, sleepSamples, energySamples,
    hrvSamples, vo2Samples, respSamples, spo2Samples,
    standSamples, mindfulSamples, basalSamples,
    lastNightSleep, lastNightHRV, lastNightResp, lastNightSpo2,
  ] = await Promise.all([
    mod.getRestingHeartRate(startMs, endMs, 7).catch(() => []),
    mod.getDailySteps(startMs, endMs).catch(() => []),
    mod.getSleepSamples(startMs, endMs).catch(() => []),
    mod.getActiveEnergyBurned(startMs, endMs).catch(() => []),
    mod.getHRV(startMs, endMs, 30).catch(() => []),
    mod.getVO2Max(startMs, endMs, 1).catch(() => []),
    mod.getRespiratoryRate(startMs, endMs, 14).catch(() => []),
    mod.getOxygenSaturation(startMs, endMs, 14).catch(() => []),
    mod.getStandingHours(startMs, endMs).catch(() => null),
    mod.getMindfulMinutes(startMs, endMs).catch(() => []),
    mod.getBasalEnergyBurned(startMs, endMs).catch(() => []),
    mod.getSleepSamples(lastNightMs, endMs).catch(() => []),
    mod.getHRV(lastNightMs, endMs, 20).catch(() => []),
    mod.getRespiratoryRate(lastNightMs, endMs, 5).catch(() => []),
    mod.getOxygenSaturation(lastNightMs, endMs, 5).catch(() => []),
  ]);

  const sleepScore = buildSleepScore(lastNightSleep, lastNightHRV, lastNightResp, lastNightSpo2);

  // Standing hours: only count samples where user actually stood (value=1 in our mapping)
  // Return null if no samples at all so the UI hides the row
  const stoodCount = Array.isArray(standSamples) && standSamples.length > 0
    ? standSamples.filter((s: any) => s.value === 1).length
    : null;

  // Active energy: show 7d average per day, not total
  const energyDays = (energySamples ?? []).filter((s: any) => s.value > 0);
  const avgActiveEnergy = energyDays.length > 0
    ? Math.round(energyDays.reduce((sum: number, s: any) => sum + s.value, 0) / energyDays.length)
    : null;

  return {
    restingHeartRate: avgValue(restingHR),
    avgSteps7d: avgValue(steps),
    workouts7d: null, // no longer used in vitals display
    avgSleepHours7d: calcAvgSleep(sleepSamples),
    lastNightSleepHours: calcLastNightSleep(sleepSamples),
    activeEnergy7d: avgActiveEnergy,
    hrvAvg: avgValue(hrvSamples),
    vo2Max: vo2Samples?.[0]?.value ?? null,
    respiratoryRate: avgValue(respSamples),
    oxygenSaturation: avgValue(spo2Samples),
    standingHours7d: stoodCount,
    mindfulMinutes7d: totalMinutes(mindfulSamples),
    basalEnergy7d: totalValue(basalSamples),
    sleepScore,
    workoutDetails: [],
    fetchedAt: now.toISOString(),
  };
}

// ── Sleep deduplication ──────────────────────────────────────────────────────
//
// Apple Health writes sleep from multiple simultaneous sources: iPhone
// (whole-night CORE), Apple Watch (CORE/DEEP/REM stages), third-party apps.
// Naively summing creates e.g. 11h core when actual sleep was 6h.
//
// Fix: for each minute in the sleep window, keep only the highest-priority
// stage. Priority: DEEP > REM > CORE > ASLEEP > AWAKE > INBED.
// This eliminates double-counting while preserving the richest stage data.

const STAGE_PRIORITY: Record<string, number> = {
  DEEP: 5, REM: 4, CORE: 3, ASLEEP: 2, AWAKE: 1, INBED: 0,
};

type SleepSample = { value: string; startDate: string; endDate: string };

function deduplicateSleepMinutes(samples: SleepSample[]): Map<number, string> {
  const minuteMap = new Map<number, string>();
  for (const s of samples) {
    const startMin = Math.floor(new Date(s.startDate).getTime() / 60000);
    const endMin = Math.ceil(new Date(s.endDate).getTime() / 60000);
    const priority = STAGE_PRIORITY[s.value] ?? -1;
    if (priority < 0) continue;
    for (let m = startMin; m < endMin; m++) {
      const existing = minuteMap.get(m);
      if (existing === undefined || (STAGE_PRIORITY[existing] ?? -1) < priority) {
        minuteMap.set(m, s.value);
      }
    }
  }
  return minuteMap;
}

function calcSleepStages(samples: SleepSample[]): SleepStages | null {
  if (!samples?.length) return null;

  // Group by night (key = end-date date string, e.g. "2024-04-22")
  // A "night" groups all samples whose end falls on the same calendar day
  const nightMap = new Map<string, SleepSample[]>();
  for (const s of samples) {
    if (s.value === 'INBED') continue;
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!nightMap.has(key)) nightMap.set(key, []);
    nightMap.get(key)!.push(s);
  }
  if (!nightMap.size) return null;

  // Pick the latest night
  const lastNight = [...nightMap.keys()].sort().pop()!;
  const deduped = deduplicateSleepMinutes(nightMap.get(lastNight)!);

  // Count minutes per stage
  let coreMin = 0, deepMin = 0, remMin = 0, awakeMin = 0;
  for (const stage of deduped.values()) {
    switch (stage) {
      case 'DEEP': deepMin++; break;
      case 'REM': remMin++; break;
      case 'CORE': case 'ASLEEP': coreMin++; break;
      case 'AWAKE': awakeMin++; break;
    }
  }

  const toHours = (m: number) => round1(m / 60);
  const core = toHours(coreMin);
  const deep = toHours(deepMin);
  const rem = toHours(remMin);
  const awake = toHours(awakeMin);
  const total = round1(core + deep + rem);

  if (total < 0.5) return null;
  return { core, deep, rem, awake, total };
}

// ── Sleep Score ──────────────────────────────────────────────────────────────

function buildSleepScore(
  sleepSamples: SleepSample[],
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

  // Duration (0-35)
  let durationScore = 35;
  if (stages.total >= 7 && stages.total <= 9) {
    durationScore = 35;
    insights.push('Great sleep duration');
  } else if (stages.total >= 6) {
    durationScore = 25;
  } else if (stages.total >= 5) {
    durationScore = 15;
    insights.push('Sleep under 6 hours — aim for 7-9h');
  } else {
    durationScore = 5;
    insights.push('Sleep under 5 hours — prioritise rest');
  }

  // Deep sleep (0-25): 1-2h is good for most adults
  let deepScore = 0;
  const deepPct = stages.total > 0 ? (stages.deep / stages.total) * 100 : 0;
  const deepHrs = stages.deep;
  if (deepHrs >= 1 && deepHrs <= 2.5) {
    deepScore = 25;
    if (deepHrs >= 1.5) insights.push(`Deep sleep ${deepHrs}h — excellent`);
    else insights.push(`Deep sleep ${deepHrs}h — good`);
  } else if (deepHrs >= 0.5 && deepHrs < 1) {
    deepScore = 15;
    insights.push(`Deep sleep ${deepHrs}h — aim for 1-2h`);
  } else if (deepHrs > 2.5) {
    deepScore = 20; // slightly too much, unusual
  } else {
    deepScore = 5;
    insights.push('Very little deep sleep detected');
  }
  void deepPct; // suppress unused warning; we now use absolute hours

  // REM sleep (0-20): 1.5-2h typical target
  let remScore = 0;
  const remHrs = stages.rem;
  if (remHrs >= 1.5 && remHrs <= 2.5) {
    remScore = 20;
  } else if (remHrs >= 1 && remHrs < 1.5) {
    remScore = 14;
  } else if (remHrs > 2.5) {
    remScore = 16;
  } else if (remHrs > 0) {
    remScore = 6;
    if (insights.length < 3) insights.push(`REM sleep ${remHrs}h — aim for 1.5-2h`);
  }

  // HRV (0-10)
  let hrvScore = 0;
  if (hrvAvg != null) {
    if (hrvAvg >= 60) { hrvScore = 10; insights.push(`HRV ${hrvAvg}ms — strong recovery`); }
    else if (hrvAvg >= 40) { hrvScore = 7; }
    else if (hrvAvg >= 20) { hrvScore = 4; }
    else { hrvScore = 2; insights.push(`Low HRV ${hrvAvg}ms — may indicate fatigue`); }
  }

  // SpO2 (0-5)
  let spo2Score = 0;
  if (spo2 != null) {
    if (spo2 >= 96) spo2Score = 5;
    else if (spo2 >= 94) spo2Score = 3;
    else { spo2Score = 1; insights.push(`Blood oxygen ${spo2.toFixed(0)}% — below normal`); }
  }

  // Respiratory rate (0-5)
  let respScore = 0;
  if (respRate != null) {
    if (respRate >= 12 && respRate <= 18) respScore = 5;
    else if (respRate <= 22) respScore = 3;
    else { respScore = 1; insights.push(`Elevated resp rate ${respRate.toFixed(0)} brpm`); }
  }

  const score = Math.min(100, durationScore + deepScore + remScore + hrvScore + spo2Score + respScore);
  let rating: SleepScore['rating'];
  if (score >= 80) rating = 'Excellent';
  else if (score >= 65) rating = 'Good';
  else if (score >= 45) rating = 'Fair';
  else rating = 'Poor';

  return { score, rating, duration: stages.total, stages, hrvAvg, respiratoryRate: respRate, oxygenSaturation: spo2, insights: insights.slice(0, 4) };
}

// ── Sleep avg helpers ────────────────────────────────────────────────────────

function groupSleepByNight(samples: SleepSample[] | null): Map<string, number> {
  const nightMap = new Map<string, number>();
  if (!samples?.length) return nightMap;

  // Group by night key
  const byNight = new Map<string, SleepSample[]>();
  for (const s of samples) {
    if (s.value === 'INBED') continue;
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!byNight.has(key)) byNight.set(key, []);
    byNight.get(key)!.push(s);
  }

  // For each night, deduplicate then sum asleep minutes
  for (const [night, nightSamples] of byNight) {
    const deduped = deduplicateSleepMinutes(nightSamples);
    let asleepMin = 0;
    for (const stage of deduped.values()) {
      if (stage === 'DEEP' || stage === 'REM' || stage === 'CORE' || stage === 'ASLEEP') {
        asleepMin++;
      }
    }
    const hours = asleepMin / 60;
    if (hours > 0.5 && hours < 14) nightMap.set(night, hours);
  }
  return nightMap;
}

function calcAvgSleep(samples: SleepSample[] | null): number | null {
  const nights = groupSleepByNight(samples);
  if (!nights.size) return null;
  const total = [...nights.values()].reduce((a, b) => a + b, 0);
  return round1(total / nights.size);
}

function calcLastNightSleep(samples: SleepSample[] | null): number | null {
  const nights = groupSleepByNight(samples);
  if (!nights.size) return null;
  const sorted = [...nights.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  return round1(sorted[0][1]);
}

// ── Generic helpers ──────────────────────────────────────────────────────────

function round1(n: number): number { return Math.round(n * 10) / 10; }

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
