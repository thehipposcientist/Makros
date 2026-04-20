/**
 * Apple Health (HealthKit) integration — iOS only.
 *
 * This module handles all HealthKit interaction:
 *   - Permission requests
 *   - Reading resting heart rate, steps, workouts, sleep, active energy
 *   - Returning a compact HealthSummary
 *
 * Scoring logic lives in utils/healthScore.ts — this module is ingestion only.
 *
 * Requires a custom Expo dev build (won't work in Expo Go).
 * Gated behind Platform.OS === 'ios' — Android/web callers get null safely.
 */

import { Platform } from 'react-native';
import type { HealthSummary } from '../types';

// ── Lazy-load react-native-health (iOS only) ────────────────────────────────
// We use dynamic require so the module is never imported on Android/web,
// which would crash since HealthKit native bindings don't exist there.

let AppleHealthKit: any = null;

function getHealthKit(): any {
  if (Platform.OS !== 'ios') return null;
  if (!AppleHealthKit) {
    try {
      // react-native-health uses `module.exports = HealthKit`, so the module
      // IS the kit — there's no `.default`. Fall through in case a future
      // version adds a default export.
      const mod = require('react-native-health');
      AppleHealthKit = mod?.default ?? mod;
    } catch {
      console.warn('[appleHealth] react-native-health not available — custom dev build required');
      return null;
    }
  }
  return AppleHealthKit;
}

// ── Permission constants ─────────────────────────────────────────────────────

const HEALTH_PERMISSIONS = {
  permissions: {
    read: [
      'HeartRate',
      'RestingHeartRate',
      'StepCount',
      'SleepAnalysis',
      'ActiveEnergyBurned',
      'Workout',
    ],
    write: [] as string[],  // v1: read-only — no writes yet
  },
};

// ── Public API ───────────────────────────────────────────────────────────────

/** Returns true if this device can use Apple Health. */
export function isHealthKitAvailable(): boolean {
  if (Platform.OS !== 'ios') return false;
  const hk = getHealthKit();
  return !!hk;
}

/**
 * Request HealthKit permissions. Returns true if the user saw the dialog
 * (iOS doesn't tell us whether they actually granted — only denies show up
 * when we try to read).
 */
export function requestHealthPermissions(): Promise<boolean> {
  return new Promise((resolve) => {
    const hk = getHealthKit();
    if (!hk) {
      console.warn('[appleHealth] getHealthKit() returned null — native module missing');
      resolve(false);
      return;
    }
    if (typeof hk.initHealthKit !== 'function') {
      console.warn('[appleHealth] initHealthKit is not a function — module keys:', Object.keys(hk).slice(0, 10));
      resolve(false);
      return;
    }

    try {
      hk.initHealthKit(HEALTH_PERMISSIONS, (err: any) => {
        if (err) {
          // Surface the raw error so we can tell entitlement issues from
          // user-denied from anything else. Common messages:
          //   "Not available on this device"          → simulator or HK not supported
          //   "Missing usage description"             → Info.plist problem
          //   "Authorization could not be determined" → entitlement/profile mismatch
          console.warn('[appleHealth] initHealthKit error:', JSON.stringify(err));
          resolve(false);
          return;
        }
        console.log('[appleHealth] initHealthKit ok');
        resolve(true);
      });
    } catch (e) {
      console.warn('[appleHealth] initHealthKit threw:', e);
      resolve(false);
    }
  });
}

/**
 * Read all health metrics and return a compact HealthSummary.
 * Call this after workout completion. Returns null if HealthKit unavailable.
 */
export async function readHealthSummary(): Promise<HealthSummary | null> {
  const hk = getHealthKit();
  if (!hk) return null;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    restingHR,
    avgSteps,
    workoutCount,
    sleepData,
    activeEnergy,
  ] = await Promise.all([
    readRestingHeartRate(hk, sevenDaysAgo, now),
    readAvgSteps7d(hk, sevenDaysAgo, now),
    readWorkoutCount7d(hk, sevenDaysAgo, now),
    readSleepData(hk, sevenDaysAgo, now),
    readActiveEnergy7d(hk, sevenDaysAgo, now),
  ]);

  return {
    restingHeartRate: restingHR,
    avgSteps7d: avgSteps,
    workouts7d: workoutCount,
    avgSleepHours7d: sleepData.avgHours,
    lastNightSleepHours: sleepData.lastNightHours,
    activeEnergy7d: activeEnergy,
    fetchedAt: now.toISOString(),
  };
}

// ── Internal read helpers ────────────────────────────────────────────────────

function readRestingHeartRate(hk: any, start: Date, end: Date): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      hk.getRestingHeartRateSamples(
        { startDate: start.toISOString(), endDate: end.toISOString(), ascending: false, limit: 7 },
        (err: any, results: any[]) => {
          if (err || !results?.length) { resolve(null); return; }
          // Average the most recent samples
          const values = results.map((r: any) => r.value).filter((v: number) => v > 0);
          if (values.length === 0) { resolve(null); return; }
          resolve(Math.round(values.reduce((a, b) => a + b, 0) / values.length));
        },
      );
    } catch { resolve(null); }
  });
}

function readAvgSteps7d(hk: any, start: Date, end: Date): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      hk.getDailyStepCountSamples(
        { startDate: start.toISOString(), endDate: end.toISOString() },
        (err: any, results: any[]) => {
          if (err || !results?.length) { resolve(null); return; }
          const total = results.reduce((sum: number, r: any) => sum + (r.value ?? 0), 0);
          resolve(Math.round(total / Math.max(1, results.length)));
        },
      );
    } catch { resolve(null); }
  });
}

function readWorkoutCount7d(hk: any, start: Date, end: Date): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      hk.getSamples(
        {
          typeIdentifier: 'HKWorkoutTypeIdentifier',
          startDate: start.toISOString(),
          endDate: end.toISOString(),
        },
        (err: any, results: any[]) => {
          if (err) { resolve(null); return; }
          resolve(results?.length ?? 0);
        },
      );
    } catch { resolve(null); }
  });
}

interface SleepResult {
  avgHours: number | null;
  lastNightHours: number | null;
}

function readSleepData(hk: any, start: Date, end: Date): Promise<SleepResult> {
  return new Promise((resolve) => {
    try {
      hk.getSleepSamples(
        { startDate: start.toISOString(), endDate: end.toISOString() },
        (err: any, results: any[]) => {
          if (err || !results?.length) {
            resolve({ avgHours: null, lastNightHours: null });
            return;
          }

          // Filter to only "asleep" samples (exclude InBed, Awake)
          const asleepSamples = results.filter((r: any) =>
            r.value === 'ASLEEP' || r.value === 'CORE' || r.value === 'DEEP' || r.value === 'REM'
          );

          if (asleepSamples.length === 0) {
            resolve({ avgHours: null, lastNightHours: null });
            return;
          }

          // Group by night — a "night" is the calendar date of the END time
          // (sleeping from 11pm to 7am = the 7am date's night)
          const nightMap = new Map<string, number>();

          for (const s of asleepSamples) {
            const sStart = new Date(s.startDate).getTime();
            const sEnd = new Date(s.endDate).getTime();
            const durationHours = (sEnd - sStart) / 3600000;
            if (durationHours <= 0 || durationHours > 24) continue; // skip bad data

            const nightKey = new Date(s.endDate).toISOString().slice(0, 10);
            nightMap.set(nightKey, (nightMap.get(nightKey) ?? 0) + durationHours);
          }

          if (nightMap.size === 0) {
            resolve({ avgHours: null, lastNightHours: null });
            return;
          }

          // Sort nights descending
          const nights = [...nightMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));
          const totalHours = nights.reduce((sum, [, h]) => sum + h, 0);
          const avgHours = Math.round((totalHours / nights.length) * 10) / 10;
          const lastNightHours = Math.round(nights[0][1] * 10) / 10;

          resolve({ avgHours, lastNightHours });
        },
      );
    } catch { resolve({ avgHours: null, lastNightHours: null }); }
  });
}

function readActiveEnergy7d(hk: any, start: Date, end: Date): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      hk.getActiveEnergyBurned(
        { startDate: start.toISOString(), endDate: end.toISOString() },
        (err: any, results: any[]) => {
          if (err || !results?.length) { resolve(null); return; }
          const total = results.reduce((sum: number, r: any) => sum + (r.value ?? 0), 0);
          resolve(Math.round(total));
        },
      );
    } catch { resolve(null); }
  });
}
