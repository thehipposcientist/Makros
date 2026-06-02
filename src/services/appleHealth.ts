import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HealthSummary, SleepScore, SleepStages, SleepStageTimeline, SleepStageType } from '../types';
import { scoreSleep, minutesFromMidnight } from './sleepScore';
import { recordTelemetryEvent, type HRZone } from './api';
import { loadAuthToken } from '../utils/authTokenStorage';
import { summarizeCardioWorkoutZones } from '../utils/cardioWorkoutClassification';
import { zoneForHeartRate } from '../utils/hrZones';

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
  'WorkoutRoute',
  'Weight',
  'HeartRateVariabilitySDNN',
  'VO2Max',
  'RespiratoryRate',
  'OxygenSaturation',
  'AppleSleepingWristTemperature',
  'AppleSleepingBreathingDisturbances',
  'StandHour',
  'MindfulSession',
  'TimeInDaylight',
  'BasalEnergyBurned',
  'MenstrualFlow',
  'DietaryEnergyConsumed',
  'DietaryProtein',
  'DietaryCarbohydrates',
  'DietaryFatTotal',
];

export const APPLE_HEALTH_PERMISSION_ITEMS = [
  { label: 'Heart rate', why: 'Shows live workout heart rate and builds heart-rate zone summaries.' },
  { label: 'Resting heart rate', why: 'Adds recovery context to readiness and weekly check-ins.' },
  { label: 'Heart rate variability', why: 'Helps estimate recovery and compare today with your recent baseline.' },
  { label: 'Sleep', why: 'Powers sleep scores, readiness, recovery insights, optional morning notifications, and check-ins.' },
  { label: 'Steps', why: 'Helps estimate daily activity and training-day energy needs.' },
  { label: 'Active energy', why: 'Improves calorie and recovery estimates when Apple Health has it.' },
  { label: 'Basal energy', why: 'Displays Apple Health energy context alongside activity trends.' },
  { label: 'Nutrition summaries', why: 'Reads calories, protein, carbs, and fat from apps that write meal summaries to Apple Health.' },
  { label: 'Workouts', why: 'Imports runs, rides, classes, and other sessions you tracked elsewhere.' },
  { label: 'Body weight', why: 'Keeps weight trends current without manual entry.' },
  { label: 'VO2 max', why: 'Supports cardio fitness trends and heart-rate zone estimates.' },
  { label: 'Respiratory rate', why: 'Adds overnight recovery context when your device records it.' },
  { label: 'Blood oxygen', why: 'Adds optional sleep and recovery context when available.' },
  { label: 'Sleeping wrist temperature', why: 'Adds optional overnight recovery and hormone-support context when available.' },
  { label: 'Sleeping breathing disturbances', why: 'Adds optional sleep-breathing context for recovery and hormone-support estimates when available.' },
  { label: 'Standing hours', why: 'Displays movement consistency from Apple Health.' },
  { label: 'Mindful minutes', why: 'Displays recovery habits logged in Apple Health.' },
  { label: 'Time in daylight', why: 'Powers optional sun exposure estimates when Apple Health records daylight time.' },
  { label: 'Menstrual flow', why: 'Enables optional cycle-aware training and recovery guidance.' },
] as const;

export const APPLE_HEALTH_WRITE_ITEMS = [
  { label: 'Completed workouts', why: 'Finished Thallo sessions can appear in Apple Health and Fitness.' },
  { label: 'Workout energy and distance', why: 'When a saved workout has calories or distance, those values are written with that workout.' },
] as const;

const SLEEP_HISTORY_KEY = 'sleepHistory_v1';
const MAX_HISTORY_NIGHTS = 30;

export const APPLE_HEALTH_PERMISSION_COPY = {
  title: 'Connect Apple Health?',
  body:
    'Apple Health is optional.\n\n' +
    'If you connect it, Thallo asks only for Apple Health categories used in the app: sleep, heart rate, HRV, steps, workouts, body weight, energy, VO2 max, respiratory rate, blood oxygen, sleeping wrist temperature, sleeping breathing disturbances, standing hours, mindful minutes, time in daylight, and menstrual-flow data.\n\n' +
    'Thallo can also read nutrition summaries, like calories, protein, carbs, and fat, when apps such as MyFitnessPal write them to Apple Health.\n\n' +
    'Some categories only appear when your iPhone, Apple Watch, or another source app records them; Thallo hides missing categories instead of showing empty metrics.\n\n' +
    'This helps personalize readiness, recovery insights, optional morning sleep readiness notifications, weekly check-ins, and training or nutrition recommendations. Daily summaries may sync to your account so trends work across devices; raw HealthKit samples stay on your phone.\n\n' +
    'Thallo can also write completed workouts, workout energy, and workout distance back to Apple Health.',
  denied:
    'Apple Health stays optional. You can keep using Thallo normally and enable or disable categories later in iPhone Settings -> Privacy & Security -> Health -> Thallo.',
};

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

function finitePositiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

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

/** Fetch raw Apple Health workouts in a time window. Public wrapper
 *  around the native `getWorkouts` so callers (bulk import, etc.) don't
 *  have to reach into the private module ref. Returns [] when HK is
 *  unavailable or the call fails — callers should treat empty as "nothing
 *  to do" rather than an error. */
export async function getAppleHealthWorkouts(
  startMs: number,
  endMs: number,
): Promise<any[]> {
  const mod = getModule();
  if (!mod || typeof mod.getWorkouts !== 'function') return [];
  try {
    const list = await mod.getWorkouts(startMs, endMs);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export interface AppleHealthWorkoutRoute {
  routeCoords: Array<{
    lat: number;
    lon: number;
    t_ms: number;
    acc_m?: number | null;
    alt_m?: number | null;
    v_acc_m?: number | null;
  }>;
  elevationGainFt?: number | null;
}

export async function getAppleHealthWorkoutRoute(
  startMs: number,
  endMs: number,
): Promise<AppleHealthWorkoutRoute | null> {
  const mod = getModule();
  if (!mod || typeof mod.getWorkoutRoute !== 'function') return null;
  try {
    const result = await mod.getWorkoutRoute(startMs, endMs);
    if (!result || typeof result !== 'object') return null;
    const routeCoords = Array.isArray(result.routeCoords) ? result.routeCoords : [];
    if (routeCoords.length === 0) return null;
    const elevationGainFt = Number(result.elevationGainFt);
    return {
      routeCoords,
      elevationGainFt: Number.isFinite(elevationGainFt) && elevationGainFt >= 0 ? elevationGainFt : null,
    };
  } catch {
    return null;
  }
}

export async function requestHealthPermissions(): Promise<boolean> {
  const mod = getModule();
  if (!mod) {
    _lastHealthKitError = 'Native module not loaded — needs a fresh EAS build.';
    recordTelemetryEvent('healthkit_permission_result', { granted: false, error: _lastHealthKitError });
    return false;
  }
  try {
    const ok = await mod.requestAuthorization(READ_TYPES);
    _lastHealthKitError = ok ? null : 'Authorization returned false';
    recordTelemetryEvent('healthkit_permission_result', { granted: ok, error: _lastHealthKitError });
    // Once iOS auth succeeds, flip the in-app toggle on automatically.
    // Without this, callers that gate on isAppleHealthEnabled() (workout
    // HR summary, calorie capture, readiness reads) silently skip the HK
    // fetch even though native authorization was granted.
    if (ok) {
      try {
        const { setAppleHealthEnabled } = await import('../utils/workoutHistory');
        await setAppleHealthEnabled(true);
      } catch (e) {
        console.warn('[appleHealth] could not persist appleHealthEnabled flag:', e);
      }
    }
    return ok;
  } catch (e: any) {
    _lastHealthKitError = e?.message ?? String(e);
    console.warn('[appleHealth] requestAuthorization error:', _lastHealthKitError);
    recordTelemetryEvent('healthkit_permission_result', { granted: false, error: _lastHealthKitError });
    return false;
  }
}

export interface ReadHealthOptions {
  age?: number | null;
}

export interface AppleHealthDaylightSample {
  value: number;
  startDate: string;
  endDate: string;
  maximumLightIntensityLux?: number | null;
}

export async function getAppleHealthTimeInDaylight(
  startMs: number,
  endMs: number,
  limit = 200,
): Promise<AppleHealthDaylightSample[]> {
  const mod = getModule();
  if (!mod || typeof mod.getTimeInDaylight !== 'function') return [];
  try {
    const samples = await mod.getTimeInDaylight(startMs, endMs, limit);
    if (!Array.isArray(samples)) return [];
    return samples
      .map((sample: any) => ({
        value: Number(sample?.value ?? 0),
        startDate: String(sample?.startDate ?? ''),
        endDate: String(sample?.endDate ?? ''),
        maximumLightIntensityLux: finitePositiveNumber(sample?.maximumLightIntensityLux),
      }))
      .filter((sample) => sample.value > 0 && sample.startDate && sample.endDate);
  } catch {
    return [];
  }
}

export async function readHealthSummary(opts: ReadHealthOptions = {}): Promise<HealthSummary | null> {
  const mod = getModule();
  if (!mod) return null;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const lastNightStart = new Date(now);
  lastNightStart.setDate(lastNightStart.getDate() - 1);
  lastNightStart.setHours(18, 0, 0, 0);
  const lastNightEnd = new Date(now);
  lastNightEnd.setHours(12, 0, 0, 0);
  const startMs = sevenDaysAgo.getTime();
  const historyStartMs = thirtyDaysAgo.getTime();
  const endMs = now.getTime();
  const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const lastNightMs = lastNightStart.getTime();
  const lastNightEndMs = Math.min(endMs, lastNightEnd.getTime());

  const [
    restingHR, steps, sleepSamples, energySamples,
    todayStepsSamples, todayEnergySamples,
    hrvSamples, vo2Samples, respSamples, spo2Samples,
    standSamples, mindfulSamples, basalSamples,
    lastNightSleep, lastNightHRV, lastNightRHR, lastNightResp, lastNightSpo2,
    historySleep, historyHRV, historyRHR, historyResp, historySpo2,
  ] = await Promise.all([
    // Log HK failures so they show up in Console.app — silent .catch()
    // made "no HR data on readiness" near-impossible to diagnose without
    // tethering to Mac.
    mod.getRestingHeartRate(startMs, endMs, 7).catch((e: any) => { console.warn('[hk] getRestingHeartRate failed:', e?.message ?? e); return []; }),
    mod.getDailySteps(startMs, endMs).catch(() => []),
    mod.getSleepSamples(startMs, endMs).catch(() => []),
    mod.getActiveEnergyBurned(startMs, endMs).catch(() => []),
    mod.getDailySteps(todayStartMs, endMs).catch(() => []),
    mod.getActiveEnergyBurned(todayStartMs, endMs).catch(() => []),
    mod.getHRV(startMs, endMs, 30).catch((e: any) => { console.warn('[hk] getHRV failed:', e?.message ?? e); return []; }),
    mod.getVO2Max(startMs, endMs, 1).catch(() => []),
    mod.getRespiratoryRate(startMs, endMs, 14).catch(() => []),
    mod.getOxygenSaturation(startMs, endMs, 14).catch(() => []),
    mod.getStandingHours(startMs, endMs).catch(() => null),
    mod.getMindfulMinutes(startMs, endMs).catch(() => []),
    mod.getBasalEnergyBurned(startMs, endMs).catch(() => []),
    mod.getSleepSamples(lastNightMs, lastNightEndMs).catch(() => []),
    mod.getHRV(lastNightMs, lastNightEndMs, 30).catch(() => []),
    mod.getRestingHeartRate(lastNightMs, lastNightEndMs, 10).catch(() => []),
    mod.getRespiratoryRate(lastNightMs, lastNightEndMs, 20).catch(() => []),
    mod.getOxygenSaturation(lastNightMs, lastNightEndMs, 20).catch(() => []),
    mod.getSleepSamples(historyStartMs, endMs).catch(() => []),
    mod.getHRV(historyStartMs, endMs, 300).catch(() => []),
    mod.getRestingHeartRate(historyStartMs, endMs, 100).catch(() => []),
    mod.getRespiratoryRate(historyStartMs, endMs, 300).catch(() => []),
    mod.getOxygenSaturation(historyStartMs, endMs, 300).catch(() => []),
  ]);

  // Fetch recent Apple workouts separately (not part of the parallel set because
  // it's optional and catches its own errors). Used by auto-import flow.
  let recentWorkouts: any[] = [];
  try {
    if (typeof mod.getWorkouts === 'function') {
      recentWorkouts = await mod.getWorkouts(startMs, endMs);
    }
  } catch { recentWorkouts = []; }

  // Build and persist nightly history (for personalized score).
  const history = buildNightlyHistory(
    historySleep as SleepSample[],
    historyHRV as any[],
    historyRHR as any[],
    historyResp as any[],
    historySpo2 as any[],
  );

  // Compute last-night inBedMinutes for efficiency.
  const lastNightStages = calcSleepStages(lastNightSleep as SleepSample[]);
  const lastNightInBedMinutes = calcLastNightInBedMinutes(lastNightSleep as SleepSample[]);
  const lastNightBedtimeMinutes = calcBedtimeMinutes(lastNightSleep as SleepSample[]);
  const lastNightSleepTimeline = buildSleepStageTimeline(lastNightSleep as SleepSample[]);
  const lastNightRhrAvg = avgValue(lastNightRHR);
  const lastNightRespAvg = avgValue1(lastNightResp);
  const lastNightSpo2Avg = avgValue1(lastNightSpo2);

  const sleepScore = buildSleepScore({
    stages: lastNightStages,
    inBedMinutes: lastNightInBedMinutes,
    hrvAvg: avgValue(lastNightHRV),
    rhrAvg: lastNightRhrAvg,
    respRate: lastNightRespAvg,
    spo2: lastNightSpo2Avg,
    age: opts.age ?? null,
    bedtimeMinutes: lastNightBedtimeMinutes,
    history,
  });
  const historyWithLatestScore = sleepScore && history.length > 0
    ? history.map((night, idx) => idx === history.length - 1 ? {
        ...night,
        score: sleepScore.score,
        rating: sleepScore.rating,
        mode: sleepScore.mode,
      } : night)
    : history;
  persistSleepHistory(historyWithLatestScore).catch(() => null);

  // Mirror last night to the backend so history survives device wipes
  // and feeds personalized score on a new device. Fire-and-forget —
  // the push is best-effort and never blocks the summary.
  pushNightlySleepToBackend({
    stages: lastNightStages,
    inBedMinutes: lastNightInBedMinutes,
    hrvMs: avgValue(lastNightHRV),
    rhr: lastNightRhrAvg,
    respRate: lastNightRespAvg,
    spo2: lastNightSpo2Avg,
    sleepScore,
    lastNightSleep: lastNightSleep as SleepSample[],
  }).catch(() => null);

  // Standing hours: only count samples where user actually stood (value=1 in our mapping)
  const stoodCount = Array.isArray(standSamples) && standSamples.length > 0
    ? standSamples.filter((s: any) => s.value === 1).length
    : null;

  // Active energy: show 7d average per day, not total
  const energyDays = (energySamples ?? []).filter((s: any) => s.value > 0);
  const avgActiveEnergy = energyDays.length > 0
    ? Math.round(energyDays.reduce((sum: number, s: any) => sum + s.value, 0) / energyDays.length)
    : null;

  // Basal energy: same shape as active — `getBasalEnergyBurned` returns
  // one sample per day via the iOS `statisticsPerDay` aggregation, so we
  // average the daily totals. The previous version summed every sample
  // and reported a 7-day total (~13.5k kcal at a ~1.9k BMR), which read
  // as a clearly wrong-looking number on the vitals card.
  const basalDays = (basalSamples ?? []).filter((s: any) => s.value > 0);
  const avgBasalEnergy = basalDays.length > 0
    ? Math.round(basalDays.reduce((sum: number, s: any) => sum + s.value, 0) / basalDays.length)
    : null;

  return {
    restingHeartRate: avgValue(restingHR),
    stepsToday: totalValueInWindow(todayStepsSamples, todayStartMs, endMs),
    avgSteps7d: avgValue(steps),
    workouts7d: null,
    avgSleepHours7d: calcAvgSleep(sleepSamples),
    lastNightSleepHours: calcLastNightSleep(lastNightSleep as SleepSample[]),
    activeEnergyToday: totalValueInWindow(todayEnergySamples, todayStartMs, endMs),
    activeEnergy7d: avgActiveEnergy,
    hrvAvg: avgValue(hrvSamples),
    vo2Max: vo2Samples?.[0]?.value ?? null,
    respiratoryRate: avgValue(respSamples),
    oxygenSaturation: avgValue(spo2Samples),
    standingHours7d: stoodCount,
    mindfulMinutes7d: totalMinutes(mindfulSamples),
    basalEnergy7d: avgBasalEnergy,
    sleepScore,
    sleepTimeline: lastNightSleepTimeline,
    workoutDetails: Array.isArray(recentWorkouts) ? recentWorkouts : [],
    fetchedAt: now.toISOString(),
  };
}

// ── Per-day snapshot reader ─────────────────────────────────────────────────
//
// `readHealthSummary` returns 7-day averages — useless for daily
// persistence. This helper pulls a SPECIFIC day's totals so we can
// store one row per day in `daily_health_snapshots`. Used for today,
// yesterday backfill, and permission-grant 30-day backfill.

export interface DailySnapshot {
  dateISO: string;
  steps: number | null;
  activeEnergyKcal: number | null;
  basalEnergyKcal: number | null;
  workoutMinutes: number | null;
  cardioMinutes: number | null;
  zone2Minutes: number | null;
  restingHr: number | null;
  hrv: number | null;
  vo2Max: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  wristTemperatureC: number | null;
  sleepBreathingDisturbances: number | null;
  sleepBreathingDisturbancesElevated: boolean | null;
  weightLbs: number | null;
}

export interface DailyNutritionSnapshot {
  dateISO: string;
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

export interface WorkoutZone2Summary {
  name: string;
  durationMin: number;
  cardioMinutes: number;
  zone2Minutes: number;
  counted: boolean;
  reason?: string;
  source: 'heart_rate' | 'heuristic' | 'none';
}

function _workoutName(w: any): string {
  return String(w?.activityName ?? w?.name ?? 'Workout');
}

function _workoutDuration(w: any): number {
  return Math.max(0, Number(w?.duration ?? w?.durationMin ?? 0) || 0);
}

function _workoutWindow(w: any): { startMs: number; endMs: number } | null {
  const startMs = new Date(w?.startDate ?? w?.startedAtISO ?? 0).getTime();
  const endMs = new Date(w?.endDate ?? w?.endedAtISO ?? 0).getTime();
  return startMs > 0 && endMs > startMs ? { startMs, endMs } : null;
}

/** Summarize an Apple Health workout for cardio + Zone 2 rollups.
 *  Prefer real HR samples when present. Fallback uses activity name +
 *  duration, so users without Watch HR still get sensible Z2 credit
 *  for steady cardio. HR zones from strength, mobility, and other
 *  non-cardio workouts are intentionally excluded from cardio totals. */
export async function summarizeWorkoutZone2(
  workout: any,
  age: number | null = null,
): Promise<WorkoutZone2Summary | null> {
  const durationMin = _workoutDuration(workout);
  if (durationMin <= 0) return null;

  const name = _workoutName(workout);
  const window = _workoutWindow(workout);

  if (window) {
    const hr = await getWorkoutHrSummary(window.startMs, window.endMs, age).catch(() => null);
    const withHr = summarizeCardioWorkoutZones({
      name,
      durationMin,
      zoneMinutes: hr?.zoneMinutes,
    });
    if (withHr?.source === 'heart_rate') return withHr;
  }

  return summarizeCardioWorkoutZones({ name, durationMin });
}

function _sumSamplesInWindow(samples: any[], startMs: number, endMs: number): number {
  if (!Array.isArray(samples)) return 0;
  let total = 0;
  for (const s of samples) {
    const t = new Date(s.startDate ?? s.date ?? 0).getTime();
    if (t >= startMs && t < endMs) total += Number(s.value) || 0;
  }
  return total;
}

function totalValueInWindow(samples: any[], startMs: number, endMs: number): number | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  return Math.round(_sumSamplesInWindow(samples, startMs, endMs));
}

function _avgSamplesInWindow(samples: any[], startMs: number, endMs: number): number | null {
  if (!Array.isArray(samples)) return null;
  let sum = 0; let n = 0;
  for (const s of samples) {
    const t = new Date(s.startDate ?? s.date ?? 0).getTime();
    if (t >= startMs && t < endMs) {
      const v = Number(s.value);
      if (v > 0) { sum += v; n++; }
    }
  }
  return n > 0 ? sum / n : null;
}

/** Read one day's HealthKit numbers. Day window is [dayStartMs, dayEndMs).
 *  All fields nullable — null means HK had no data in that window. */
export async function readDailySnapshot(dayStartMs: number, dayEndMs: number): Promise<DailySnapshot | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    const nightStartMs = dayStartMs - 6 * 60 * 60 * 1000;
    const nightEndMs = Math.min(dayEndMs, dayStartMs + 12 * 60 * 60 * 1000);
    const [
      stepsSamples, energySamples, basalSamples, workouts,
      hrvSamples, rhrSamples, vo2Samples, weightSamples,
      respSamples, spo2Samples, wristTempSamples, breathingSamples,
    ] = await Promise.all([
      typeof mod.getDailySteps === 'function' ? mod.getDailySteps(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getActiveEnergyBurned === 'function' ? mod.getActiveEnergyBurned(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getBasalEnergyBurned === 'function' ? mod.getBasalEnergyBurned(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getWorkouts === 'function' ? mod.getWorkouts(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getHRV === 'function' ? mod.getHRV(dayStartMs, dayEndMs, 50).catch(() => []) : [],
      typeof mod.getRestingHeartRate === 'function' ? mod.getRestingHeartRate(dayStartMs, dayEndMs, 5).catch(() => []) : [],
      typeof mod.getVO2Max === 'function' ? mod.getVO2Max(dayStartMs, dayEndMs, 1).catch(() => []) : [],
      typeof mod.getWeight === 'function' ? mod.getWeight(dayStartMs, dayEndMs, 5).catch(() => []) : [],
      typeof mod.getRespiratoryRate === 'function' ? mod.getRespiratoryRate(nightStartMs, nightEndMs, 30).catch(() => []) : [],
      typeof mod.getOxygenSaturation === 'function' ? mod.getOxygenSaturation(nightStartMs, nightEndMs, 30).catch(() => []) : [],
      typeof mod.getSleepingWristTemperature === 'function' ? mod.getSleepingWristTemperature(nightStartMs, nightEndMs, 10).catch(() => []) : [],
      typeof mod.getSleepingBreathingDisturbances === 'function' ? mod.getSleepingBreathingDisturbances(nightStartMs, nightEndMs, 10).catch(() => []) : [],
    ]);

    const steps = _sumSamplesInWindow(stepsSamples, dayStartMs, dayEndMs);
    const activeEnergy = _sumSamplesInWindow(energySamples, dayStartMs, dayEndMs);
    const basalEnergy = _sumSamplesInWindow(basalSamples, dayStartMs, dayEndMs);

    let workoutMinutes = 0;
    let cardioMinutes = 0;
    let zone2Minutes = 0;
    if (Array.isArray(workouts)) {
      for (const w of workouts) {
        const start = new Date(w.startDate ?? 0).getTime();
        if (start < dayStartMs || start >= dayEndMs) continue;
        const mins = Number(w.duration ?? 0);
        if (!mins) continue;
        workoutMinutes += mins;
        const z2 = await summarizeWorkoutZone2(w, null);
        if (z2) {
          cardioMinutes += z2.cardioMinutes;
          zone2Minutes += z2.zone2Minutes;
        }
      }
    }

    const dateISO = new Date(dayStartMs).toISOString().slice(0, 10);
    const breathingValues = Array.isArray(breathingSamples)
      ? breathingSamples.map((s: any) => Number(s?.value)).filter((v: number) => Number.isFinite(v) && v >= 0)
      : [];
    const breathingElevated = Array.isArray(breathingSamples) && breathingSamples.length > 0
      ? breathingSamples.some((s: any) => String(s?.classification ?? '').toLowerCase() === 'elevated')
      : null;
    return {
      dateISO,
      steps: steps > 0 ? Math.round(steps) : null,
      activeEnergyKcal: activeEnergy > 0 ? Math.round(activeEnergy) : null,
      basalEnergyKcal: basalEnergy > 0 ? Math.round(basalEnergy) : null,
      workoutMinutes: workoutMinutes > 0 ? Math.round(workoutMinutes) : null,
      cardioMinutes: cardioMinutes > 0 ? Math.round(cardioMinutes) : null,
      zone2Minutes: zone2Minutes > 0 ? Math.round(zone2Minutes) : null,
      restingHr: _avgSamplesInWindow(rhrSamples, dayStartMs, dayEndMs),
      hrv: _avgSamplesInWindow(hrvSamples, dayStartMs, dayEndMs),
      vo2Max: Array.isArray(vo2Samples) && vo2Samples.length > 0 ? Number(vo2Samples[0]?.value) || null : null,
      respiratoryRate: _avgSamplesInWindow(respSamples, nightStartMs, nightEndMs),
      oxygenSaturation: _avgSamplesInWindow(spo2Samples, nightStartMs, nightEndMs),
      wristTemperatureC: _avgSamplesInWindow(wristTempSamples, nightStartMs, nightEndMs),
      sleepBreathingDisturbances: breathingValues.length > 0
        ? breathingValues.reduce((sum: number, value: number) => sum + value, 0) / breathingValues.length
        : null,
      sleepBreathingDisturbancesElevated: breathingElevated,
      weightLbs: _avgSamplesInWindow(weightSamples, dayStartMs, dayEndMs),
    };
  } catch {
    return null;
  }
}

export async function readDailyNutritionSnapshot(dayStartMs: number, dayEndMs: number): Promise<DailyNutritionSnapshot | null> {
  const mod = getModule();
  if (!mod) return null;
  try {
    const [
      calorieSamples, proteinSamples, carbSamples, fatSamples,
    ] = await Promise.all([
      typeof mod.getDietaryEnergyConsumed === 'function' ? mod.getDietaryEnergyConsumed(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getDietaryProtein === 'function' ? mod.getDietaryProtein(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getDietaryCarbohydrates === 'function' ? mod.getDietaryCarbohydrates(dayStartMs, dayEndMs).catch(() => []) : [],
      typeof mod.getDietaryFatTotal === 'function' ? mod.getDietaryFatTotal(dayStartMs, dayEndMs).catch(() => []) : [],
    ]);

    const calories = _sumSamplesInWindow(calorieSamples, dayStartMs, dayEndMs);
    const protein = _sumSamplesInWindow(proteinSamples, dayStartMs, dayEndMs);
    const carbs = _sumSamplesInWindow(carbSamples, dayStartMs, dayEndMs);
    const fat = _sumSamplesInWindow(fatSamples, dayStartMs, dayEndMs);
    const hasAny = calories > 0 || protein > 0 || carbs > 0 || fat > 0;
    const dateISO = new Date(dayStartMs).toISOString().slice(0, 10);
    return hasAny
      ? {
          dateISO,
          calories: calories > 0 ? Math.round(calories) : null,
          proteinG: protein > 0 ? Math.round(protein) : null,
          carbsG: carbs > 0 ? Math.round(carbs) : null,
          fatG: fat > 0 ? Math.round(fat) : null,
        }
      : { dateISO, calories: null, proteinG: null, carbsG: null, fatG: null };
  } catch {
    return null;
  }
}

// ── Workout HR annotation ───────────────────────────────────────────────────
//
/** Write a finished workout to Apple Health.
 *
 *  Phone-started sessions (lift workouts via ActiveWorkoutScreen,
 *  open-ended runs via LiveActivityTracker) didn't land in Apple
 *  Health before — only Watch-started sessions did via
 *  HKLiveWorkoutBuilder. This closes the gap so completed Thallo
 *  workouts appear in the iPhone Fitness app + count toward Activity
 *  rings + are visible to other apps.
 *
 *  Best-effort: returns false if HK is unavailable, the user hasn't
 *  granted write permission, or the call fails. The caller should
 *  not retry — workouts are saved to Thallo's own history regardless.
 */
export async function saveWorkoutToHealth(opts: {
  startedAt: Date;
  endedAt: Date;
  /** Free-form activity tag that matches an `HKWorkoutActivityType`.
   *  Strings like "run" / "push" / "legs" / "yoga" all work — see
   *  the native bridge's `activityTypeFromString` for the full list. */
  activityTag: string;
  caloriesBurned?: number | null;
  distanceMiles?: number | null;
  /** Optional GPS route. When present, the native bridge writes the
   *  trail via HKWorkoutRouteBuilder so the saved workout shows the
   *  route on the Apple Fitness map. Indoor + lifting omit. */
  routeCoords?: Array<{ lat: number; lon: number; t_ms?: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }> | null;
}): Promise<boolean> {
  if (!isHealthKitAvailable()) return false;
  const mod = getModule();
  if (!mod || typeof mod.saveWorkout !== 'function') return false;
  try {
    return await mod.saveWorkout(
      opts.startedAt.getTime(),
      opts.endedAt.getTime(),
      opts.activityTag,
      opts.caloriesBurned ?? null,
      opts.distanceMiles ?? null,
      opts.routeCoords && opts.routeCoords.length > 0 ? opts.routeCoords : null,
    );
  } catch (e) {
    console.warn('[appleHealth] saveWorkoutToHealth failed:', e);
    return false;
  }
}

/** Returns the most recent heart rate sample from the last 2 minutes.
 *  Designed for near-live HR display during an active workout. */
export async function getLatestHeartRate(): Promise<number | null> {
  const mod = getModule();
  if (!mod || typeof mod.getHeartRate !== 'function') return null;
  try {
    const now = Date.now();
    const lookbackMs = 120_000;
    const samples = await mod.getHeartRate(now - lookbackMs, now, 10);
    if (!Array.isArray(samples) || samples.length === 0) return null;
    const sorted = samples
      .map((s: any) => ({ v: Number(s.value), t: new Date(s.startDate).getTime() }))
      .filter((x: any) => x.v > 0 && x.t > 0 && now - x.t <= lookbackMs)
      .sort((a: any, b: any) => b.t - a.t);
    return sorted.length > 0 ? Math.round(sorted[0].v) : null;
  } catch {
    return null;
  }
}

export type HeartRateSample = {
  value: number;
  startDate: string;
  endDate?: string;
};

export async function readHeartRateSamples(
  startMs: number,
  endMs: number,
  limit = 240,
): Promise<HeartRateSample[]> {
  const mod = getModule();
  if (!mod || typeof mod.getHeartRate !== 'function') return [];
  try {
    const samples = await mod.getHeartRate(startMs, endMs, limit);
    if (!Array.isArray(samples)) return [];
    return samples
      .map((sample: any) => ({
        value: Number(sample?.value),
        startDate: String(sample?.startDate ?? ''),
        endDate: sample?.endDate ? String(sample.endDate) : undefined,
      }))
      .filter((sample) => sample.value > 0 && Number.isFinite(new Date(sample.startDate).getTime()))
      .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
  } catch {
    return [];
  }
}

// Pulls raw HR samples for a workout window and summarizes them into avg, max,
// and minutes-in-zone. Prefer the exact server-computed zone boundaries already
// used for live phone/watch display; fallback mirrors the backend's HRR default.

/** Cap on how much real time a single HR sample can claim in zoneMinutes.
 *  Without this, sparse HealthKit sampling (e.g. a 4-minute gap during a
 *  rest period) lets one outlier dominate the zone breakdown. 2 minutes
 *  matches passive HK's typical sampling cadence during exercise. */
const MAX_HR_SAMPLE_GAP_MINUTES = 2;

// Local fallback delegates to the canonical hrZones module so the
// phone, the watch, and the backend all share one definition. The
// only reason this fallback exists is to handle the rare race where
// the workout finishes before `/workouts/hr-zones` has responded —
// when that happens we still want a reasonable zone breakdown
// instead of dropping the whole HR summary.

function fallbackHrZones(
  age: number | null,
  restingHeartRate: number | null,
  userMaxHR: number | null,
): HRZone[] {
  const { computeHrZones } = require('../utils/hrZones') as typeof import('../utils/hrZones');
  return computeHrZones({
    age,
    userMaxHR: userMaxHR ?? null,
    rhr7d: restingHeartRate ?? null,
  }).zones;
}

function workoutHrZones(
  explicitZones: HRZone[] | null | undefined,
  age: number | null,
  restingHeartRate: number | null,
  userMaxHR: number | null,
): HRZone[] {
  const zones = Array.isArray(explicitZones)
    ? explicitZones.filter(z =>
      Number.isFinite(Number(z.zone)) &&
      Number.isFinite(Number(z.low)) &&
      Number.isFinite(Number(z.high)))
    : [];
  return zones.length > 0 ? zones : fallbackHrZones(age, restingHeartRate, userMaxHR);
}

export type HrConfidence = 'high' | 'medium' | 'low';

export interface WorkoutHrSummary {
  avgBpm: number;
  maxBpm: number;
  samples: number;
  zoneMinutes: [number, number, number, number, number]; // Z1..Z5
  /** Max HR used to derive zone boundaries — either the user override
   *  (when set in profile/settings) or the Tanaka age estimate. */
  maxHrUsed: number;
  /** Fraction of the workout window covered by HR samples (after the
   *  per-sample gap cap). 1.0 = every minute had a sample within
   *  MAX_HR_SAMPLE_GAP_MINUTES; lower values mean sparse data. */
  hrCoverageRatio: number;
  /** "high" >= 0.75 coverage, "medium" >= 0.4, "low" otherwise. */
  hrConfidence: HrConfidence;
}

export async function getWorkoutHrSummary(
  startMs: number,
  endMs: number,
  age: number | null = null,
  restingHeartRate: number | null = null,
  explicitZones: HRZone[] | null = null,
  /** Optional profile/settings object that may carry a user-provided
   *  max HR override. Read defensively so this stays a no-op until the
   *  override field is actually wired up in the profile model. */
  profile?: { maxHeartRate?: number | null; max_heart_rate?: number | null } | null,
): Promise<WorkoutHrSummary | null> {
  const mod = getModule();
  if (!mod || typeof mod.getHeartRate !== 'function') return null;
  try {
    const samples = await mod.getHeartRate(startMs, endMs, 500);
    if (!Array.isArray(samples) || samples.length === 0) return null;
    const maxHrOverride = profile?.maxHeartRate ?? profile?.max_heart_rate ?? null;
    const zoneDefinitions = workoutHrZones(explicitZones, age, restingHeartRate, maxHrOverride);
    // Pull the actual MHR used out of the resolved zone band so the
    // returned summary reports the same number that drove the zones.
    const { computeHrZones } = require('../utils/hrZones') as typeof import('../utils/hrZones');
    const maxHrUsed = computeHrZones({ age, userMaxHR: maxHrOverride, rhr7d: restingHeartRate }).maxHR;

    let sum = 0;
    let max = 0;
    let coveredMinutes = 0;
    // Five-tuple kept for storage backwards compat: index 0 = Z1
    // through index 4 = Z5. Z0 minutes (rare — only fires below the
    // user's resting HR or for very-low-effort warmups) fold into the
    // Z1 slot. New consumers reading the live zone array see all six
    // bands; only the persisted `hr_summary.zoneMinutes` payload
    // collapses Z0 → Z1 to avoid breaking historical schemas.
    const zones: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    const sorted = samples
      .map((s: any) => ({ v: Number(s.value), t: new Date(s.startDate).getTime() }))
      .filter((x) => x.v > 0 && x.t > 0)
      .sort((a, b) => a.t - b.t);
    if (sorted.length === 0) return null;

    for (let i = 0; i < sorted.length; i++) {
      const { v, t } = sorted[i];
      sum += v;
      if (v > max) max = v;
      // Assign the gap until next sample (or end) to this zone — but
      // cap at MAX_HR_SAMPLE_GAP_MINUTES so a single sparse sample
      // can't claim a multi-minute gap.
      const nextT = i + 1 < sorted.length ? sorted[i + 1].t : endMs;
      const rawGapMinutes = Math.max(0, (nextT - t) / 60000);
      const minutes = Math.min(rawGapMinutes, MAX_HR_SAMPLE_GAP_MINUTES);
      const zone = zoneForHeartRate(v, zoneDefinitions);
      // Map zone numbers 0..5 → indices 0..4. Z0 collapses into the
      // Z1 slot so the persisted 5-tuple stays compatible with prior
      // workout records.
      const zNum = Math.max(0, Math.min(5, Math.round(Number(zone?.zone ?? 1))));
      const zIdx = Math.max(0, zNum - 1);
      zones[zIdx] += minutes;
      coveredMinutes += minutes;
    }

    const workoutMinutes = Math.max(0, (endMs - startMs) / 60000);
    const hrCoverageRatio = workoutMinutes > 0
      ? Math.max(0, Math.min(1, coveredMinutes / workoutMinutes))
      : 0;
    const hrConfidence: HrConfidence =
      hrCoverageRatio >= 0.75 ? 'high'
      : hrCoverageRatio >= 0.4 ? 'medium'
      : 'low';

    return {
      avgBpm: Math.round(sum / sorted.length),
      maxBpm: Math.round(max),
      samples: sorted.length,
      zoneMinutes: zones.map(m => Math.round(m * 10) / 10) as [number, number, number, number, number],
      maxHrUsed,
      hrCoverageRatio: Math.round(hrCoverageRatio * 1000) / 1000,
      hrConfidence,
    };
  } catch {
    return null;
  }
}

// ── Cycle tracking ──────────────────────────────────────────────────────────
//
// Returns current menstrual-cycle phase from Apple Health data. Phases:
//   menses       (day 1-5 of flow)
//   follicular   (day 6 to ovulation)
//   ovulation    (mid-cycle, days 13-15)
//   luteal       (post-ovulation to next menses)
//   unknown      (no data)

export type CyclePhase = 'menses' | 'follicular' | 'ovulation' | 'luteal' | 'unknown';
export type CycleFlowIntensity = 'unspecified' | 'light' | 'moderate' | 'heavy';

export interface CycleStatus {
  phase: CyclePhase;
  dayOfCycle: number | null;   // 1-indexed; null if unknown
  cycleLengthDays: number;     // estimated from history; defaults to 28
  nextExpectedMenses: string | null; // ISO date
  currentFlow: CycleFlowIntensity | null;
}

function menstrualFlowIntensity(value: unknown): CycleFlowIntensity | null {
  switch (Number(value)) {
    case 1: return 'unspecified';
    case 2: return 'light';
    case 3: return 'moderate';
    case 4: return 'heavy';
    default: return null;
  }
}

export async function getCycleStatus(): Promise<CycleStatus | null> {
  const mod = getModule();
  if (!mod || typeof mod.getMenstrualFlow !== 'function') return null;
  try {
    const now = Date.now();
    const lookbackMs = now - 90 * 86400000; // 90 days to estimate cycle length
    const samples = await mod.getMenstrualFlow(lookbackMs, now);
    if (!Array.isArray(samples) || samples.length === 0) return null;

    // Group consecutive flow days (value 1-4 = flow; 5 = none/notation).
    type Period = { start: number; end: number };
    const flowDays = samples
      .filter((s: any) => s.value >= 1 && s.value <= 4)
      .map((s: any) => ({
        startMs: new Date(s.startDate).getTime(),
        endMs: new Date(s.endDate).getTime(),
        value: Number(s.value),
      }))
      .sort((a: any, b: any) => a.startMs - b.startMs);
    if (flowDays.length === 0) return null;

    const periods: Period[] = [];
    let current: Period = { start: flowDays[0].startMs, end: flowDays[0].endMs };
    for (let i = 1; i < flowDays.length; i++) {
      const gapDays = (flowDays[i].startMs - current.end) / 86400000;
      if (gapDays <= 3) {
        current.end = Math.max(current.end, flowDays[i].endMs);
      } else {
        periods.push(current);
        current = { start: flowDays[i].startMs, end: flowDays[i].endMs };
      }
    }
    periods.push(current);

    // Cycle length = median of gaps between consecutive period starts.
    const starts = periods.map(p => p.start).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < starts.length; i++) gaps.push((starts[i] - starts[i - 1]) / 86400000);
    gaps.sort((a, b) => a - b);
    const cycleLengthDays = gaps.length > 0 ? Math.round(gaps[Math.floor(gaps.length / 2)]) : 28;

    const lastPeriodStart = starts[starts.length - 1];
    const dayOfCycle = Math.floor((now - lastPeriodStart) / 86400000) + 1;
    const nextExpectedMs = lastPeriodStart + cycleLengthDays * 86400000;
    const nextExpectedMenses = new Date(nextExpectedMs).toISOString().slice(0, 10);

    const lastPeriodLengthDays = Math.round((periods[periods.length - 1].end - lastPeriodStart) / 86400000) + 1;
    const ovulationDay = Math.round(cycleLengthDays - 14);

    let phase: CyclePhase;
    if (dayOfCycle <= Math.max(3, Math.min(7, lastPeriodLengthDays))) phase = 'menses';
    else if (dayOfCycle < ovulationDay - 1) phase = 'follicular';
    else if (dayOfCycle <= ovulationDay + 1) phase = 'ovulation';
    else if (dayOfCycle <= cycleLengthDays + 2) phase = 'luteal';
    else phase = 'unknown';

    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayStartMs = todayStart.getTime();
    const currentFlowSample = [...flowDays].reverse().find(day =>
      day.endMs > todayStartMs && day.startMs <= now + 86400000,
    );
    const currentFlow = phase === 'menses'
      ? menstrualFlowIntensity(currentFlowSample?.value)
      : null;

    return { phase, dayOfCycle, cycleLengthDays, nextExpectedMenses, currentFlow };
  } catch {
    return null;
  }
}

// ── Workout calorie lookup (Apple Watch override) ───────────────────────────
//
// Returns the Apple Health workout whose window overlaps the given range.
// If the user wore their watch, use the watch's calorie total (more accurate
// than our METs-based estimate). If not, caller falls back to the default.

export async function getAppleWorkoutCaloriesForWindow(
  startMs: number,
  endMs: number,
): Promise<number | null> {
  const mod = getModule();
  if (!mod || typeof mod.getWorkouts !== 'function') return null;
  try {
    // Widen the query by 30 min each side to catch misaligned timestamps.
    const workouts = await mod.getWorkouts(startMs - 30 * 60_000, endMs + 30 * 60_000);
    if (!Array.isArray(workouts) || !workouts.length) return null;
    const candidates: Array<{ workout: any; overlap: number; calories: number }> = [];
    for (const w of workouts) {
      const ws = new Date(w.startDate).getTime();
      const we = new Date(w.endDate).getTime();
      const overlap = Math.max(0, Math.min(endMs, we) - Math.max(startMs, ws));
      if (overlap >= 60_000) {
        candidates.push({ workout: w, overlap, calories: Number(w.calories) });
      }
    }
    if (candidates.length === 0) return null;
    const pool = candidates.some(c => c.calories > 0)
      ? candidates.filter(c => c.calories > 0)
      : candidates;
    const best = pool.reduce((a, b) => (b.overlap > a.overlap ? b : a));
    const cal = Number(best.workout.calories);
    return cal > 0 ? Math.round(cal) : null;
  } catch {
    return null;
  }
}

// ── Sleep deduplication ──────────────────────────────────────────────────────
//
// Apple Health writes sleep from multiple simultaneous sources: iPhone,
// Apple Watch, third-party apps. Naively summing creates e.g. 11h core when
// actual sleep was 6h. Fix: for each minute in the sleep window, keep only
// the highest-priority stage. DEEP > REM > CORE > ASLEEP > AWAKE > INBED.

const STAGE_PRIORITY: Record<string, number> = {
  DEEP: 5, REM: 4, CORE: 3, ASLEEP: 2, AWAKE: 1, INBED: 0,
};

type SleepSample = { value: string; startDate: string; endDate: string };

function sleepStageType(value: string): SleepStageType | null {
  switch (value) {
    case 'AWAKE': return 'awake';
    case 'REM': return 'rem';
    case 'DEEP': return 'deep';
    case 'CORE':
    case 'ASLEEP':
      return 'core';
    default:
      return null;
  }
}

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

  const nightMap = new Map<string, SleepSample[]>();
  for (const s of samples) {
    if (s.value === 'INBED') continue;
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!nightMap.has(key)) nightMap.set(key, []);
    nightMap.get(key)!.push(s);
  }
  if (!nightMap.size) return null;

  const lastNight = [...nightMap.keys()].sort().pop()!;
  const deduped = deduplicateSleepMinutes(nightMap.get(lastNight)!);

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

function buildSleepStageTimeline(samples: SleepSample[]): SleepStageTimeline | null {
  if (!samples?.length) return null;

  const nightMap = new Map<string, SleepSample[]>();
  for (const s of samples) {
    if (!sleepStageType(s.value)) continue;
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!nightMap.has(key)) nightMap.set(key, []);
    nightMap.get(key)!.push(s);
  }
  if (!nightMap.size) return null;

  const lastNight = [...nightMap.keys()].sort().pop()!;
  const deduped = [...deduplicateSleepMinutes(nightMap.get(lastNight)!).entries()]
    .map(([minute, value]) => ({ minute, stage: sleepStageType(value) }))
    .filter((entry): entry is { minute: number; stage: SleepStageType } => entry.stage != null)
    .sort((a, b) => a.minute - b.minute);
  if (!deduped.length) return null;

  const firstMinute = deduped[0].minute;
  const lastMinuteExclusive = deduped[deduped.length - 1].minute + 1;
  const durationMinutes = lastMinuteExclusive - firstMinute;
  if (durationMinutes < 30 || durationMinutes > 18 * 60) return null;

  const segments: SleepStageTimeline['segments'] = [];
  let segmentStart = deduped[0].minute;
  let previousMinute = deduped[0].minute;
  let currentStage = deduped[0].stage;

  const pushSegment = (endMinuteExclusive: number) => {
    segments.push({
      stage: currentStage,
      startDate: new Date(segmentStart * 60000).toISOString(),
      endDate: new Date(endMinuteExclusive * 60000).toISOString(),
      startOffsetMinutes: segmentStart - firstMinute,
      durationMinutes: endMinuteExclusive - segmentStart,
    });
  };

  for (let i = 1; i < deduped.length; i++) {
    const entry = deduped[i];
    if (entry.stage !== currentStage || entry.minute !== previousMinute + 1) {
      pushSegment(previousMinute + 1);
      segmentStart = entry.minute;
      currentStage = entry.stage;
    }
    previousMinute = entry.minute;
  }
  pushSegment(previousMinute + 1);

  return {
    startDate: new Date(firstMinute * 60000).toISOString(),
    endDate: new Date(lastMinuteExclusive * 60000).toISOString(),
    durationMinutes,
    segments,
  };
}

// Total in-bed minutes for the last night (includes all stages + INBED).
function calcLastNightInBedMinutes(samples: SleepSample[]): number | null {
  if (!samples?.length) return null;
  const nightMap = new Map<string, SleepSample[]>();
  for (const s of samples) {
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!nightMap.has(key)) nightMap.set(key, []);
    nightMap.get(key)!.push(s);
  }
  if (!nightMap.size) return null;
  const lastNight = [...nightMap.keys()].sort().pop()!;
  // For in-bed, include INBED; priority still dedupes overlaps.
  const deduped = deduplicateSleepMinutes(nightMap.get(lastNight)!);
  return deduped.size > 0 ? deduped.size : null;
}

function calcBedtimeMinutes(samples: SleepSample[]): number | null {
  let firstAsleepMs: number | null = null;
  for (const s of samples ?? []) {
    if (s.value === 'INBED' || s.value === 'AWAKE' || !s.startDate) continue;
    const t = new Date(s.startDate).getTime();
    if (!Number.isFinite(t)) continue;
    if (firstAsleepMs == null || t < firstAsleepMs) firstAsleepMs = t;
  }
  return firstAsleepMs != null ? minutesFromMidnight(new Date(firstAsleepMs)) : null;
}

// ── Sleep Score entry point ──────────────────────────────────────────────────

interface BuildScoreArgs {
  stages: SleepStages | null;
  inBedMinutes: number | null;
  hrvAvg: number | null;
  rhrAvg: number | null;
  respRate: number | null;
  spo2: number | null;
  age: number | null;
  bedtimeMinutes: number | null;
  history: NightRecord[];
}

function buildSleepScore(a: BuildScoreArgs): SleepScore | null {
  if (!a.stages || a.stages.total < 0.5) return null;
  const baselineHistory = a.history.length > 14 ? a.history.slice(0, -1) : a.history;
  const hrvHistory = baselineHistory.map((n) => n.hrv).filter((v): v is number => typeof v === 'number' && v > 0);
  const rhrHistory = baselineHistory.map((n) => n.restingHr).filter((v): v is number => typeof v === 'number' && v > 0);
  const respiratoryRateHistory = baselineHistory.map((n) => n.respiratoryRate).filter((v): v is number => typeof v === 'number' && v > 0);
  const spo2History = baselineHistory.map((n) => n.spo2Percent).filter((v): v is number => typeof v === 'number' && v > 0);
  const bedtimeHistory = baselineHistory
    .map((n) => n.bedtimeMinutes)
    .filter((v): v is number => typeof v === 'number' && v >= 0 && v < 1440);

  return scoreSleep({
    totalSleepHours: a.stages.total,
    inBedMinutes: a.inBedMinutes,
    deepSleepHours: a.stages.deep,
    remSleepHours: a.stages.rem,
    hrvMs: a.hrvAvg,
    restingHeartRate: a.rhrAvg,
    spo2Percent: a.spo2,
    respiratoryRate: a.respRate,
    age: a.age,
    stages: a.stages,
    bedtimeMinutes: a.bedtimeMinutes,
    hrvHistory,
    rhrHistory,
    respiratoryRateHistory,
    spo2History,
    bedtimeHistory,
  });
}

// ── Nightly history (for personalized score) ────────────────────────────────

export interface NightRecord {
  night: string;                 // YYYY-MM-DD (end-of-sleep date)
  hrv: number | null;
  restingHr?: number | null;
  respiratoryRate?: number | null;
  spo2Percent?: number | null;
  sleepHours: number | null;
  inBedMinutes?: number | null;
  deepHours?: number | null;
  remHours?: number | null;
  coreHours?: number | null;
  awakeMinutes?: number | null;
  bedtimeMinutes: number | null; // minutes from midnight, local time
  score?: number | null;
  rating?: SleepScore['rating'] | null;
  mode?: SleepScore['mode'] | null;
}

function buildNightlyHistory(
  sleepSamples: SleepSample[],
  hrvSamples: Array<{ value: number; startDate: string; endDate?: string }>,
  rhrSamples: Array<{ value: number; startDate: string; endDate?: string }> = [],
  respiratorySamples: Array<{ value: number; startDate: string; endDate?: string }> = [],
  spo2Samples: Array<{ value: number; startDate: string; endDate?: string }> = [],
): NightRecord[] {
  // Group sleep samples by night (end date YYYY-MM-DD).
  const nights = new Map<string, SleepSample[]>();
  for (const s of sleepSamples ?? []) {
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!nights.has(key)) nights.set(key, []);
    nights.get(key)!.push(s);
  }

  const out: NightRecord[] = [];
  for (const [night, samples] of nights) {
    const deduped = deduplicateSleepMinutes(samples);
    let asleepMin = 0;
    let coreMin = 0;
    let deepMin = 0;
    let remMin = 0;
    let awakeMin = 0;
    let firstAsleepMs: number | null = null;
    // Find earliest asleep minute to use as bedtime / onset.
    for (const s of samples) {
      if (s.value === 'INBED' || s.value === 'AWAKE') continue;
      const t = new Date(s.startDate).getTime();
      if (firstAsleepMs == null || t < firstAsleepMs) firstAsleepMs = t;
    }
    for (const stage of deduped.values()) {
      switch (stage) {
        case 'DEEP':
          deepMin++;
          asleepMin++;
          break;
        case 'REM':
          remMin++;
          asleepMin++;
          break;
        case 'CORE':
        case 'ASLEEP':
          coreMin++;
          asleepMin++;
          break;
        case 'AWAKE':
          awakeMin++;
          break;
      }
    }
    const sleepHours = asleepMin > 0 ? round1(asleepMin / 60) : null;
    const bedtimeMinutes = firstAsleepMs != null ? minutesFromMidnight(new Date(firstAsleepMs)) : null;
    const inBedMinutes = deduped.size > 0 ? deduped.size : null;

    // Nightly recovery markers: average samples in the sleep window.
    // Resting HR can be a daily HealthKit summary, so the helper falls
    // back to matching the waking date when no sample lands inside the
    // actual sleep window.
    let nightHrv: number | null = null;
    let nightRhr: number | null = null;
    let nightResp: number | null = null;
    let nightSpo2: number | null = null;
    if (firstAsleepMs != null) {
      const windowStart = firstAsleepMs;
      const windowEnd = windowStart + 14 * 3600_000; // cap at +14h from onset
      nightHrv = avgSamplesForNight(hrvSamples, night, windowStart, windowEnd, 'round');
      nightRhr = avgSamplesForNight(rhrSamples, night, windowStart, windowEnd, 'round');
      nightResp = avgSamplesForNight(respiratorySamples, night, windowStart, windowEnd, 'round1');
      nightSpo2 = avgSamplesForNight(spo2Samples, night, windowStart, windowEnd, 'round1');
    }

    if (sleepHours != null && sleepHours >= 1 && sleepHours < 14) {
      out.push({
        night,
        hrv: nightHrv,
        restingHr: nightRhr,
        respiratoryRate: nightResp,
        spo2Percent: nightSpo2,
        sleepHours,
        inBedMinutes,
        deepHours: round1(deepMin / 60),
        remHours: round1(remMin / 60),
        coreHours: round1(coreMin / 60),
        awakeMinutes: awakeMin,
        bedtimeMinutes,
      });
    }
  }
  out.sort((a, b) => a.night.localeCompare(b.night));
  return out.slice(-MAX_HISTORY_NIGHTS);
}

function avgSamplesForNight(
  samples: Array<{ value: number; startDate: string; endDate?: string }> | null | undefined,
  night: string,
  windowStart: number,
  windowEnd: number,
  rounding: 'round' | 'round1',
): number | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const inWindow: number[] = [];
  const sameWakingDate: number[] = [];
  for (const s of samples) {
    const value = Number(s.value);
    if (!(value > 0)) continue;
    const t = new Date(s.startDate).getTime();
    if (t >= windowStart && t <= windowEnd) inWindow.push(value);
    if (s.startDate?.slice(0, 10) === night || s.endDate?.slice(0, 10) === night) {
      sameWakingDate.push(value);
    }
  }
  const vals = inWindow.length ? inWindow : sameWakingDate;
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return rounding === 'round' ? Math.round(avg) : round1(avg);
}

export async function loadSleepHistory(): Promise<NightRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(SLEEP_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function sleepHistoryPayloadFromNight(night: NightRecord): import('./api').SleepNightlyPayload | null {
  if (!night?.night) return null;
  const totalHours = typeof night.sleepHours === 'number' && night.sleepHours > 0 ? night.sleepHours : null;
  const hasAnyValue = totalHours != null
    || night.inBedMinutes != null
    || night.deepHours != null
    || night.remHours != null
    || night.coreHours != null
    || night.awakeMinutes != null
    || night.hrv != null
    || night.restingHr != null
    || night.respiratoryRate != null
    || night.spo2Percent != null
    || night.bedtimeMinutes != null
    || night.score != null
    || night.rating != null
    || night.mode != null;
  if (!hasAnyValue) return null;
  return {
    night_date: night.night,
    total_hours: totalHours,
    in_bed_minutes: night.inBedMinutes ?? null,
    deep_hours: night.deepHours ?? null,
    rem_hours: night.remHours ?? null,
    core_hours: night.coreHours ?? null,
    awake_minutes: night.awakeMinutes ?? null,
    hrv_ms: night.hrv ?? null,
    resting_hr: night.restingHr ?? null,
    respiratory_rate: night.respiratoryRate ?? null,
    spo2_percent: night.spo2Percent ?? null,
    bedtime_minutes_from_midnight: night.bedtimeMinutes ?? null,
    score: night.score ?? null,
    rating: night.rating ?? null,
    mode: night.mode ?? null,
    source: 'apple_health',
  };
}

async function pushSleepHistoryToBackend(nights: NightRecord[]): Promise<void> {
  try {
    const token = await loadAuthToken();
    if (!token) return;
    const payloads = nights
      .slice(-90)
      .map(sleepHistoryPayloadFromNight)
      .filter((row): row is import('./api').SleepNightlyPayload => row != null);
    if (payloads.length === 0) return;
    const { upsertNightlySleepBatch } = await import('./api');
    await upsertNightlySleepBatch(token, payloads);
  } catch {
    // Network / not-signed-in — silent. Local cache still has the data.
  }
}

/** Mirror last night's sleep snapshot to the backend (fire-and-forget).
 *  Keyed on the waking date so today's score uses today's row. Auth
 *  token is read fresh from SecureStore so callers don't need to pass it. */
async function pushNightlySleepToBackend(input: {
  stages: SleepStages | null;
  inBedMinutes: number | null;
  hrvMs: number | null;
  rhr: number | null;
  respRate: number | null;
  spo2: number | null;
  sleepScore: any | null;
  lastNightSleep: SleepSample[];
}): Promise<void> {
  try {
    const token = await loadAuthToken();
    if (!token) return;
    // Waking date — use today's local date if we have any sleep total.
    if (!input.stages || (input.stages.total ?? 0) <= 0) return;
    const nightDate = new Date().toISOString().slice(0, 10);
    const bedtimeMin = calcBedtimeMinutes(input.lastNightSleep);
    const { upsertNightlySleep } = await import('./api');
    await upsertNightlySleep(token, {
      night_date: nightDate,
      total_hours: input.stages.total ?? null,
      in_bed_minutes: input.inBedMinutes,
      deep_hours: input.stages.deep ?? null,
      rem_hours: input.stages.rem ?? null,
      core_hours: input.stages.core ?? null,
      awake_minutes: Math.round((input.stages.awake ?? 0) * 60),
      hrv_ms: input.hrvMs,
      resting_hr: input.rhr,
      respiratory_rate: input.respRate,
      spo2_percent: input.spo2,
      bedtime_minutes_from_midnight: bedtimeMin,
      score: input.sleepScore?.score ?? null,
      rating: input.sleepScore?.rating ?? null,
      mode: input.sleepScore?.mode ?? null,
      source: 'apple_health',
    });
  } catch {
    // Network / not-signed-in — silent. Local cache still has the data.
  }
}

async function persistSleepHistory(nights: NightRecord[]): Promise<void> {
  try {
    // Merge with existing so we don't lose nights outside the current window.
    const existing = await loadSleepHistory();
    const byNight = new Map<string, NightRecord>();
    for (const n of existing) byNight.set(n.night, n);
    for (const n of nights) {
      const prev = byNight.get(n.night);
      byNight.set(n.night, prev ? {
        ...prev,
        ...n,
        hrv: n.hrv ?? prev.hrv ?? null,
        restingHr: n.restingHr ?? prev.restingHr ?? null,
        respiratoryRate: n.respiratoryRate ?? prev.respiratoryRate ?? null,
        spo2Percent: n.spo2Percent ?? prev.spo2Percent ?? null,
        sleepHours: n.sleepHours ?? prev.sleepHours ?? null,
        inBedMinutes: n.inBedMinutes ?? prev.inBedMinutes ?? null,
        deepHours: n.deepHours ?? prev.deepHours ?? null,
        remHours: n.remHours ?? prev.remHours ?? null,
        coreHours: n.coreHours ?? prev.coreHours ?? null,
        awakeMinutes: n.awakeMinutes ?? prev.awakeMinutes ?? null,
        bedtimeMinutes: n.bedtimeMinutes ?? prev.bedtimeMinutes ?? null,
        score: n.score ?? prev.score ?? null,
        rating: n.rating ?? prev.rating ?? null,
        mode: n.mode ?? prev.mode ?? null,
      } : n);
    }
    const merged = [...byNight.values()].sort((a, b) => a.night.localeCompare(b.night)).slice(-MAX_HISTORY_NIGHTS);
    await AsyncStorage.setItem(SLEEP_HISTORY_KEY, JSON.stringify(merged));
    pushSleepHistoryToBackend(merged).catch(() => {});
  } catch {}
}

// ── Sleep avg helpers ────────────────────────────────────────────────────────

function groupSleepByNight(samples: SleepSample[] | null): Map<string, number> {
  const nightMap = new Map<string, number>();
  if (!samples?.length) return nightMap;

  const byNight = new Map<string, SleepSample[]>();
  for (const s of samples) {
    if (s.value === 'INBED') continue;
    const key = s.endDate?.slice(0, 10);
    if (!key) continue;
    if (!byNight.has(key)) byNight.set(key, []);
    byNight.get(key)!.push(s);
  }

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

function avgValue1(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  const vals = samples.map((s) => s.value).filter((v) => v > 0);
  if (!vals.length) return null;
  return round1(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function totalValue(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  return Math.round(samples.reduce((sum, s) => sum + (s.value ?? 0), 0));
}

function totalMinutes(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  return Math.round(samples.reduce((sum, s) => sum + (s.value ?? 0), 0));
}
