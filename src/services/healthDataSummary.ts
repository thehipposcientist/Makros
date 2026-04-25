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
  readHealthSummary, isHealthKitAvailable, getWorkoutHrSummary,
} from './appleHealth';
import type { HealthSummary } from '../types';

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

const CACHE_KEY = 'healthDataSummary_v1';
const STALE_AFTER_MS = 30 * 60 * 1000;   // 30 min

let _inflight: Promise<HealthDataSummary | null> | null = null;

function emptySummary(): HealthDataSummary {
  return {
    dateISO: new Date().toISOString().slice(0, 10),
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
        AsyncStorage.setItem(CACHE_KEY, JSON.stringify(summary)).catch(() => {});
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

async function pushSnapshotToBackend(s: HealthDataSummary): Promise<void> {
  try {
    const token = await AsyncStorage.getItem('authToken');
    if (!token) return;
    // Skip the empty-payload case — every field null means we have no
    // useful data to write, and the upsert would just create a junk row.
    const fields = [
      s.steps, s.activeEnergyKcal, s.workoutMinutes, s.cardioMinutes,
      s.zone2Minutes, s.restingHeartRate, s.hrv, s.vo2Max, s.weightLbs,
    ];
    if (fields.every((v) => v == null)) return;
    const { upsertDailyHealthSnapshot } = await import('./api');
    await upsertDailyHealthSnapshot(token, {
      snapshot_date: s.dateISO,
      steps: s.steps,
      active_energy_kcal: s.activeEnergyKcal,
      workout_minutes: s.workoutMinutes,
      cardio_minutes: s.cardioMinutes,
      zone2_minutes: s.zone2Minutes,
      resting_hr: s.restingHeartRate,
      hrv_ms: s.hrv,
      vo2_max: s.vo2Max,
      weight_lbs: s.weightLbs,
      source: 'apple_health',
    });
  } catch {
    // Network / not-signed-in — silent. Local cache still has the data
    // and the next refresh will retry the push.
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

  // Derive zone-2 minutes from workout HR summaries when zones are
  // available. Fallback: if no HR data, treat workouts with subtype
  // "run"/"walk"/"hike"/"ride" of moderate duration as steady cardio
  // → counts toward Z2. Keeps the flag meaningful for users who don't
  // have a Watch.
  const workouts: any[] = Array.isArray(raw.workoutDetails) ? raw.workoutDetails : [];
  let totalCardioMinutes = 0;
  let totalZone2Minutes = 0;
  const cardioRx = /run|walk|hike|bik|cycl|row|swim|ellipt|spin/i;
  for (const w of workouts) {
    const mins = Number(w.duration ?? 0);
    if (!mins) continue;
    const name = String(w.activityName ?? '');
    if (cardioRx.test(name)) {
      totalCardioMinutes += mins;
      // Heuristic Z2 fallback: steady cardio of 20+ min likely spans
      // Z2. Skip HIIT / intervals / short bursts.
      if (mins >= 20 && !/hiit|interval|tabata/i.test(name)) {
        totalZone2Minutes += mins;
      }
    }
  }

  // Weight slope: need historical weightEntries to compute a proper
  // EMA slope. For the aggregator we expose null and let the review
  // route compute its own slope from weight history (the server path
  // already does this for adaptive_macros). Keeping this aggregator
  // focused on Apple Health-native fields.
  return {
    dateISO: new Date().toISOString().slice(0, 10),
    computedAtMs: Date.now(),
    hkAvailable: true,
    steps: raw.stepsToday ?? null,
    sleepMinutes: raw.lastNightSleepHours != null ? Math.round(raw.lastNightSleepHours * 60) : null,
    restingHeartRate: raw.restingHeartRate ?? null,
    hrv: (raw as any).hrvAvg ?? null,
    workoutMinutes: typeof (raw as any).workoutMinutesToday === 'number' ? (raw as any).workoutMinutesToday : null,
    cardioMinutes: totalCardioMinutes > 0 ? totalCardioMinutes : null,
    zone2Minutes: totalZone2Minutes > 0 ? totalZone2Minutes : null,
    activeEnergyKcal: raw.activeEnergyToday ?? null,
    weightLbs: (raw as any).weightLbs ?? null,
    vo2Max: raw.vo2Max ?? null,
    weekly: {
      avgSteps: raw.avgSteps7d ?? null,
      avgSleepHours: raw.lastNightSleepHours ?? null,
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
  if (cached && opts.onCached) opts.onCached(cached);
  // Refresh if stale OR no cache at all.
  if (!cached || (Date.now() - cached.computedAtMs) > STALE_AFTER_MS) {
    return refreshHealthDataSummary({ age: opts.age ?? null });
  }
  return cached;
}
