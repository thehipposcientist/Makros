import { Platform } from 'react-native';
import type { HealthSummary } from '../types';

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
  try {
    lines.push(`isAvailable=${mod.isAvailable()}`);
  } catch (e: any) {
    lines.push(`isAvailable=error: ${e?.message}`);
  }

  const ok = await requestHealthPermissions();
  lines.push(`auth_ok=${ok}`);
  if (!ok && _lastHealthKitError) {
    lines.push(`auth_error=${_lastHealthKitError}`);
  }
  if (ok) {
    lines.push('tip=If you still see no data, iOS Settings -> Privacy & Security -> Health -> Thallo -> enable each category.');
  }
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
  const startMs = sevenDaysAgo.getTime();
  const endMs = now.getTime();

  const [restingHR, steps, workoutCount, sleepSamples, energySamples] = await Promise.all([
    mod.getRestingHeartRate(startMs, endMs, 7).catch(() => []),
    mod.getDailySteps(startMs, endMs).catch(() => []),
    mod.getWorkoutCount(startMs, endMs).catch(() => 0),
    mod.getSleepSamples(startMs, endMs).catch(() => []),
    mod.getActiveEnergyBurned(startMs, endMs).catch(() => []),
  ]);

  return {
    restingHeartRate: avgValue(restingHR),
    avgSteps7d: avgValue(steps),
    workouts7d: workoutCount,
    avgSleepHours7d: calcAvgSleep(sleepSamples),
    lastNightSleepHours: calcLastNightSleep(sleepSamples),
    activeEnergy7d: totalValue(energySamples),
    fetchedAt: now.toISOString(),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
