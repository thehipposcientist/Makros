// Single-source-of-truth Apple Health / Watch aggregator.
//
// Previously every card queried the HealthKit bridge directly for the
// slice it needed: ReadinessCard pulled sleep + RHR, ProgressScreen
// pulled workouts, the weekly review took signals passed in from who-
// knows-where. That scattered 5 different queries per home open and
// made consistency hard (Screen A's "avg sleep" differed from Screen
// B's depending on when each cached).
//
// This service owns a single canonical daily record + 7-day rollup.
// Every downstream card reads from here. AsyncStorage caches the last
// computed summary so cold opens have data before the fresh fetch
// completes (~1-2s latency for a full HK read).
//
// Shape (deliberately flat — callers shouldn't have to destructure):
//   {
//     dateISO: string,                     // today
//     steps: number | null,
//     sleepMinutes: number | null,
//     restingHeartRate: number | null,
//     hrv: number | null,
//     workoutMinutes: number | null,       // total today
//     cardioMinutes: number | null,
//     zone2Minutes: number | null,
//     activeEnergyKcal: number | null,
//     weightLbs: number | null,
//     vo2Max: number | null,
//     weekly: {
//       avgSteps, avgSleepHours, avgRestingHr, totalCardioMinutes,
//       totalZone2Minutes, sessions, weightSlopeLbsPerWeek,
//     }
//   }
//
// Null semantics: null means "HK didn't return a value" (either not
// authorised, never recorded, or platform doesn't support). Zero
// means "we know it's zero." Downstream code must distinguish.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  readHealthSummary, isHealthKitAvailable, summarizeWorkoutZone2,
} from './appleHealth';
import type { HealthSummary } from '../types';
import { loadAuthToken } from '../utils/authTokenStorage';

export interface HealthWeeklyRollup {
  avgSteps: number | null;
  avgSleepHours: number | null;
  avgRestingHr: number | null;
  totalCardioMinutes: number;
  totalZone2Minutes: number;
  sessions: number;
  weightSlopeLbsPerWeek: number | null;
}

export interface HealthDataSummary {
  dateISO: string;
  computedAtMs: number;
  hkAvailable: boolean;
  // Today snapshot
  steps: number | null;
  sleepMinutes: number | null;
  restingHeartRate: number | null;
  hrv: number | null;
  workoutMinutes: number | null;
  cardioMinutes: number | null;
  zone2Minutes: number | null;
  activeEnergyKcal: number | null;
  weightLbs: number | null;
  vo2Max: number | null;
  // 7-day rollup for the weekly review + readiness logic.
  weekly: HealthWeeklyRollup;
  // Raw AH blob for legacy callers that still need it. New callers
  // should use the flat fields above.
  raw: HealthSummary | null;
}

const CACHE_KEY = 'healthDataSummary_v2';
const STALE_AFTER_MS = 30 * 60 * 1000;   // 30 min

let _inflight: Promise<HealthDataSummary | null> | null = null;

function cacheableSummary(summary: HealthDataSummary): HealthDataSummary {
  return { ...summary, raw: null };
}

function localDateISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function emptySummary(): HealthDataSummary {
  return {
    dateISO: localDateISO(),
    computedAtMs: Date.now(),
    hkAvailable: false,
    steps: null, sleepMinutes: null, restingHeartRate: null, hrv: null,
    workoutMinutes: null, cardioMinutes: null, zone2Minutes: null,
    activeEnergyKcal: null, weightLbs: null, vo2Max: null,
    weekly: {
      avgSteps: null, avgSleepHours: null, avgRestingHr: null,
      totalCardioMinutes: 0, totalZone2Minutes: 0,
      sessions: 0, weightSlopeLbsPerWeek: null,
    },
    raw: null,
  };
}

/** Pull the cached summary instantly (for first paint), then a caller
 *  typically calls `refreshHealthDataSummary` to update. */
export async function getCachedHealthDataSummary(): Promise<HealthDataSummary | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: HealthDataSummary = JSON.parse(raw);
    if (parsed?.raw) {
      const minimized = cacheableSummary(parsed);
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(minimized)).catch(() => {});
      return minimized;
    }
    return parsed;
  } catch { return null; }
}

/** Force a fresh compute from HealthKit. Coalesces concurrent calls so
 *  multiple cards firing at once share one HK read. */
export async function refreshHealthDataSummary(
  opts: { age?: number | null } = {},
): Promise<HealthDataSummary | null> {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const summary = await compute(opts);
      if (summary) {
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(cacheableSummary(summary))).catch(() => {});
        // Fire-and-forget per-day persistence to backend. Keeps the
        // server's daily_health_snapshots row current so weekly_review
        // + recovery_flags can read history without re-querying HK.
        if (summary.hkAvailable) pushSnapshotToBackend(summary).catch(() => {});
      }
      return summary;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

async function pushSnapshotToBackend(_s: HealthDataSummary): Promise<void> {
  try {
    const token = await loadAuthToken();
    if (!token) return;
    // The aggregator's flat fields are 7-day averages, not today's
    // totals — pulling per-day numbers requires a separate HK read.
    // Push today AND yesterday: today catches partial-day numbers,
    // yesterday locks in the final-day numbers (steps, active energy
    // continue accruing till midnight; an evening or next-morning
    // refresh fills the gap).
    const { readDailySnapshot } = await import('./appleHealth');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const tomorrowStart = todayStart + 86400000;

    const [today, yesterday] = await Promise.all([
      readDailySnapshot(todayStart, tomorrowStart),
      readDailySnapshot(yesterdayStart, todayStart),
    ]);

    const { upsertDailyHealthSnapshotBatch } = await import('./api');
    const payloads = [today, yesterday]
      .filter((d): d is NonNullable<typeof d> => !!d && _hasAnyValue(d))
      .map((d) => ({
        snapshot_date: d.dateISO,
        steps: d.steps,
        active_energy_kcal: d.activeEnergyKcal,
        workout_minutes: d.workoutMinutes,
        cardio_minutes: d.cardioMinutes,
        zone2_minutes: d.zone2Minutes,
        resting_hr: d.restingHr,
        hrv_ms: d.hrv,
        vo2_max: d.vo2Max,
        weight_lbs: d.weightLbs,
        source: 'apple_health',
      }));
    if (payloads.length === 0) return;
    await upsertDailyHealthSnapshotBatch(token, payloads);
  } catch {
    // Network / not-signed-in — silent. Local cache still has the data
    // and the next refresh will retry the push.
  }
}

function _hasAnyValue(d: { steps: number | null; activeEnergyKcal: number | null; workoutMinutes: number | null; cardioMinutes?: number | null; zone2Minutes?: number | null; restingHr: number | null; hrv: number | null; weightLbs: number | null; vo2Max: number | null }): boolean {
  return d.steps != null || d.activeEnergyKcal != null || d.workoutMinutes != null
    || d.cardioMinutes != null || d.zone2Minutes != null
    || d.restingHr != null || d.hrv != null || d.weightLbs != null || d.vo2Max != null;
}

/** Batch-push the last `days` daily snapshots. Called once after the
 *  user grants HealthKit permission so we don't lose history that's
 *  already in the user's HK store. Safe to call repeatedly — the
 *  backend upsert is idempotent. */
export async function backfillSnapshotsToBackend(days: number = 30): Promise<{ pushed: number }> {
  try {
    const token = await loadAuthToken();
    if (!token) return { pushed: 0 };
    const { readDailySnapshot } = await import('./appleHealth');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const reads: Promise<any>[] = [];
    for (let i = 0; i < Math.min(days, 90); i++) {
      const start = todayStart - i * 86400000;
      reads.push(readDailySnapshot(start, start + 86400000));
    }
    const snapshots = await Promise.all(reads);
    const payloads = snapshots
      .filter((d): d is NonNullable<typeof d> => !!d && _hasAnyValue(d))
      .map((d) => ({
        snapshot_date: d.dateISO,
        steps: d.steps,
        active_energy_kcal: d.activeEnergyKcal,
        workout_minutes: d.workoutMinutes,
        cardio_minutes: d.cardioMinutes,
        zone2_minutes: d.zone2Minutes,
        resting_hr: d.restingHr,
        hrv_ms: d.hrv,
        vo2_max: d.vo2Max,
        weight_lbs: d.weightLbs,
        source: 'apple_health',
      }));
    if (payloads.length === 0) return { pushed: 0 };
    const { upsertDailyHealthSnapshotBatch } = await import('./api');
    await upsertDailyHealthSnapshotBatch(token, payloads);
    return { pushed: payloads.length };
  } catch {
    return { pushed: 0 };
  }
}

async function compute(opts: { age?: number | null }): Promise<HealthDataSummary | null> {
  if (!isHealthKitAvailable()) {
    return { ...emptySummary(), hkAvailable: false };
  }
  const raw = await readHealthSummary({ age: opts.age ?? null }).catch(() => null);
  if (!raw) {
    return { ...emptySummary(), hkAvailable: true };
  }

  // Derive Zone 2 from workout HR summaries when available. Fallback:
  // if no HR data, count steady cardio of 20+ min as Z2 so the signal
  // still works for users without Watch HR samples.
  const workouts: any[] = Array.isArray(raw.workoutDetails) ? raw.workoutDetails : [];
  let totalCardioMinutes = 0;
  let totalZone2Minutes = 0;
  const z2Summaries = await Promise.all(
    workouts.map((w) => summarizeWorkoutZone2(w, opts.age ?? null).catch(() => null)),
  );
  for (const z2 of z2Summaries) {
    if (!z2) continue;
    totalCardioMinutes += z2.cardioMinutes;
    totalZone2Minutes += z2.zone2Minutes;
  }
  const totalWorkoutMinutes = workouts.reduce((sum, w) => sum + (Number(w.duration ?? 0) || 0), 0);

  // Weight slope: need historical weightEntries to compute a proper
  // EMA slope. For the aggregator we expose null and let the review
  // route compute its own slope from weight history (the server path
  // already does this for adaptive_macros). Keeping this aggregator
  // focused on Apple Health-native fields.
  return {
    dateISO: localDateISO(),
    computedAtMs: Date.now(),
    hkAvailable: true,
    steps: (raw as any).stepsToday ?? null,
    sleepMinutes: raw.lastNightSleepHours != null ? Math.round(raw.lastNightSleepHours * 60) : null,
    restingHeartRate: raw.restingHeartRate ?? null,
    hrv: (raw as any).hrvAvg ?? null,
    workoutMinutes: totalWorkoutMinutes > 0 ? Math.round(totalWorkoutMinutes) : null,
    cardioMinutes: totalCardioMinutes > 0 ? totalCardioMinutes : null,
    zone2Minutes: totalZone2Minutes > 0 ? totalZone2Minutes : null,
    activeEnergyKcal: (raw as any).activeEnergyToday ?? null,
    weightLbs: (raw as any).weightLbs ?? null,
    vo2Max: raw.vo2Max ?? null,
    weekly: {
      avgSteps: raw.avgSteps7d ?? null,
      avgSleepHours: raw.avgSleepHours7d ?? null,
      avgRestingHr: raw.restingHeartRate ?? null,
      totalCardioMinutes,
      totalZone2Minutes,
      sessions: raw.workouts7d ?? workouts.length,
      weightSlopeLbsPerWeek: null,
    },
    raw,
  };
}

/** Convenience wrapper for callers that want "cached immediately,
 *  fresh in the background". The returned promise resolves with the
 *  fresh value; the passed `onCached` callback fires synchronously
 *  with whatever was cached (if anything). */
export async function getHealthDataSummary(
  opts: { age?: number | null; onCached?: (s: HealthDataSummary) => void } = {},
): Promise<HealthDataSummary | null> {
  const cached = await getCachedHealthDataSummary();
  const cachedIsForToday = cached?.dateISO === localDateISO();
  if (cached && cachedIsForToday && opts.onCached) opts.onCached(cached);
  // Refresh if stale, from another local day, OR no cache at all.
  if (!cached || !cachedIsForToday || (Date.now() - cached.computedAtMs) > STALE_AFTER_MS) {
    return refreshHealthDataSummary({ age: opts.age ?? null });
  }
  return cached;
}
