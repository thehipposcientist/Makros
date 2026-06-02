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
  isPlatformHealthAvailable,
  platformHealthSource,
  readPlatformDailySnapshot,
  readPlatformHealthSummary,
  summarizePlatformWorkoutZone2,
  type DailySnapshot,
} from './platformHealth';
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

// Tracks the widest backfill window we've successfully pushed for this
// device. When we extend the default window (30 → 180 → 365 …), the
// next `refreshHealthDataSummary` notices the gap and runs the missing
// span. Keyed by *target* days so future bumps just compare a number.
const BACKFILL_STATUS_KEY = 'healthBackfillStatus_v1';
const BACKFILL_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day
interface BackfillStatus {
  completedDays: number;
  lastAttemptMs: number;
}

async function readBackfillStatus(): Promise<BackfillStatus> {
  try {
    const raw = await AsyncStorage.getItem(BACKFILL_STATUS_KEY);
    if (!raw) return { completedDays: 0, lastAttemptMs: 0 };
    const parsed = JSON.parse(raw);
    return {
      completedDays: Number(parsed?.completedDays) || 0,
      lastAttemptMs: Number(parsed?.lastAttemptMs) || 0,
    };
  } catch {
    return { completedDays: 0, lastAttemptMs: 0 };
  }
}

async function writeBackfillStatus(s: BackfillStatus): Promise<void> {
  try { await AsyncStorage.setItem(BACKFILL_STATUS_KEY, JSON.stringify(s)); } catch {}
}

let _inflight: Promise<HealthDataSummary | null> | null = null;
let _snapshotPushInflight: Promise<void> | null = null;
let _lastSnapshotPushMs = 0;

function cacheableSummary(summary: HealthDataSummary): HealthDataSummary {
  const sleepScore = summary.raw?.sleepScore ?? (summary.raw as any)?.sleepScore ?? null;
  return {
    ...summary,
    raw: sleepScore ? ({ sleepScore } as any) : null,
  };
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

type HealthSnapshotSourceDetails = {
  providers: string[];
  fields: Record<string, string>;
};

const SNAPSHOT_SOURCE_FIELD_MAP = [
  ['steps', 'steps'],
  ['active_energy_kcal', 'activeEnergyKcal'],
  ['basal_energy_kcal', 'basalEnergyKcal'],
  ['workout_minutes', 'workoutMinutes'],
  ['cardio_minutes', 'cardioMinutes'],
  ['zone2_minutes', 'zone2Minutes'],
  ['resting_hr', 'restingHr'],
  ['hrv_ms', 'hrv'],
  ['vo2_max', 'vo2Max'],
  ['respiratory_rate', 'respiratoryRate'],
  ['oxygen_saturation', 'oxygenSaturation'],
  ['wrist_temperature_c', 'wristTemperatureC'],
  ['sleep_breathing_disturbances', 'sleepBreathingDisturbances'],
  ['sleep_breathing_disturbances_elevated', 'sleepBreathingDisturbancesElevated'],
  ['weight_lbs', 'weightLbs'],
] as const satisfies ReadonlyArray<readonly [string, keyof DailySnapshot]>;

function sourceDetailsForDailySnapshot(
  snapshot: DailySnapshot,
  provider: string,
): HealthSnapshotSourceDetails {
  const fields: Record<string, string> = {};
  for (const [apiField, snapshotField] of SNAPSHOT_SOURCE_FIELD_MAP) {
    if (snapshot[snapshotField] != null) fields[apiField] = provider;
  }
  return { providers: [provider], fields };
}

/** Pull the cached summary instantly (for first paint), then a caller
 *  typically calls `refreshHealthDataSummary` to update. */
export async function getCachedHealthDataSummary(): Promise<HealthDataSummary | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: HealthDataSummary = JSON.parse(raw);
    const parsedRaw = parsed?.raw as any;
    if (parsedRaw && Object.keys(parsedRaw).some(k => k !== 'sleepScore')) {
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
        if (summary.hkAvailable) {
          import('../utils/sleepScoreNotifications')
            .then(({ maybeNotifySleepScoreReady }) => maybeNotifySleepScoreReady(summary))
            .catch(() => {});
          refreshDailyHealthSnapshotsForBackend({ includeYesterday: true }).catch(() => {});
          // Catch-up backfill for existing users who connected before
          // the window grew (originally 30 days; now 180). Idempotent
          // and cooldown-gated, so this is a cheap no-op once it runs.
          ensureBackfillWindow(180).catch(() => {});
        }
      }
      return summary;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

export async function refreshDailyHealthSnapshotsForBackend(
  opts: { includeYesterday?: boolean; throttleMs?: number; force?: boolean; token?: string | null } = {},
): Promise<void> {
  if (!isPlatformHealthAvailable()) return;
  const throttleMs = opts.throttleMs ?? 60 * 1000;
  const now = Date.now();
  if (!opts.force && _snapshotPushInflight) return _snapshotPushInflight;
  if (!opts.force && now - _lastSnapshotPushMs < throttleMs) return;
  _snapshotPushInflight = pushDailyHealthSnapshotsToBackend({
    includeYesterday: opts.includeYesterday ?? true,
    token: opts.token,
  }).then((didAttempt) => {
    if (didAttempt) _lastSnapshotPushMs = Date.now();
  }).finally(() => {
    _snapshotPushInflight = null;
  });
  return _snapshotPushInflight;
}

async function pushDailyHealthSnapshotsToBackend(opts: { includeYesterday: boolean; token?: string | null }): Promise<boolean> {
  try {
    const token = opts.token ?? await loadAuthToken();
    if (!token) return false;
    // The aggregator's flat fields are 7-day averages, not today's
    // totals — pulling per-day numbers requires a separate HK read.
    // Push today AND yesterday: today catches partial-day numbers,
    // yesterday locks in the final-day numbers (steps, active energy
    // continue accruing till midnight; an evening or next-morning
    // refresh fills the gap).
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;
    const tomorrowStart = todayStart + 86400000;

    const source = platformHealthSource();
    const reads = [readPlatformDailySnapshot(todayStart, tomorrowStart)];
    if (opts.includeYesterday) reads.push(readPlatformDailySnapshot(yesterdayStart, todayStart));
    const [today, yesterday = null] = await Promise.all(reads);

    const { upsertDailyHealthSnapshotBatch } = await import('./api');
    const payloads = [today, yesterday]
      .filter((d): d is NonNullable<typeof d> => !!d && _hasAnyValue(d))
      .map((d) => ({
        snapshot_date: d.dateISO,
        steps: d.steps,
        active_energy_kcal: d.activeEnergyKcal,
        basal_energy_kcal: d.basalEnergyKcal,
        workout_minutes: d.workoutMinutes,
        cardio_minutes: d.cardioMinutes,
        zone2_minutes: d.zone2Minutes,
        resting_hr: d.restingHr,
        hrv_ms: d.hrv,
        vo2_max: d.vo2Max,
        respiratory_rate: d.respiratoryRate,
        oxygen_saturation: d.oxygenSaturation,
        wrist_temperature_c: d.wristTemperatureC,
        sleep_breathing_disturbances: d.sleepBreathingDisturbances,
        sleep_breathing_disturbances_elevated: d.sleepBreathingDisturbancesElevated,
        weight_lbs: d.weightLbs,
        source,
        source_details: sourceDetailsForDailySnapshot(d, source),
      }));
    if (payloads.length === 0) return true;
    await upsertDailyHealthSnapshotBatch(token, payloads);
    return true;
  } catch {
    // Network / not-signed-in — silent. Local cache still has the data
    // and the next refresh will retry the push.
    return false;
  }
}

function _hasAnyValue(d: {
  steps: number | null;
  activeEnergyKcal: number | null;
  basalEnergyKcal?: number | null;
  workoutMinutes: number | null;
  cardioMinutes?: number | null;
  zone2Minutes?: number | null;
  restingHr: number | null;
  hrv: number | null;
  weightLbs: number | null;
  vo2Max: number | null;
  respiratoryRate?: number | null;
  oxygenSaturation?: number | null;
  wristTemperatureC?: number | null;
  sleepBreathingDisturbances?: number | null;
  sleepBreathingDisturbancesElevated?: boolean | null;
}): boolean {
  return d.steps != null || d.activeEnergyKcal != null || d.basalEnergyKcal != null || d.workoutMinutes != null
    || d.cardioMinutes != null || d.zone2Minutes != null
    || d.restingHr != null || d.hrv != null || d.weightLbs != null || d.vo2Max != null
    || d.respiratoryRate != null || d.oxygenSaturation != null || d.wristTemperatureC != null
    || d.sleepBreathingDisturbances != null || d.sleepBreathingDisturbancesElevated != null;
}

/** Batch-push the last `days` daily snapshots. Called once after the
 *  user grants HealthKit permission so we don't lose history that's
 *  already in the user's HK store. Safe to call repeatedly — the
 *  backend upsert is idempotent.
 *
 *  Chunked in 90-day windows because:
 *   - The backend /health/snapshot/batch endpoint caps at 90 rows.
 *   - The most recent window matters most for first paint (body check /
 *     readiness UIs read the last 35 days). Pushing it first gets the
 *     user a populated UI faster.
 *   - 90 sequential HK reads is heavy; we let each chunk finish before
 *     starting the next so failures in older windows don't poison the
 *     recent push. */
const BACKFILL_CHUNK_DAYS = 90;
const BACKFILL_MAX_DAYS = 365;

export async function backfillSnapshotsToBackend(
  days: number = 180,
  opts: { onChunk?: (chunkIndex: number, pushed: number) => void } = {},
): Promise<{ pushed: number; chunks: number }> {
  try {
    const token = await loadAuthToken();
    if (!token) return { pushed: 0, chunks: 0 };
    const totalDays = Math.max(1, Math.min(days, BACKFILL_MAX_DAYS));
    const { upsertDailyHealthSnapshotBatch } = await import('./api');
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const source = platformHealthSource();

    let totalPushed = 0;
    let chunkIndex = 0;
    for (let offset = 0; offset < totalDays; offset += BACKFILL_CHUNK_DAYS) {
      const chunkSize = Math.min(BACKFILL_CHUNK_DAYS, totalDays - offset);
      const reads: Promise<any>[] = [];
      for (let i = 0; i < chunkSize; i++) {
        const start = todayStart - (offset + i) * 86400000;
        reads.push(readPlatformDailySnapshot(start, start + 86400000));
      }
      const snapshots = await Promise.all(reads);
      const payloads = snapshots
        .filter((d): d is NonNullable<typeof d> => !!d && _hasAnyValue(d))
        .map((d) => ({
          snapshot_date: d.dateISO,
          steps: d.steps,
          active_energy_kcal: d.activeEnergyKcal,
          basal_energy_kcal: d.basalEnergyKcal,
          workout_minutes: d.workoutMinutes,
          cardio_minutes: d.cardioMinutes,
          zone2_minutes: d.zone2Minutes,
          resting_hr: d.restingHr,
          hrv_ms: d.hrv,
          vo2_max: d.vo2Max,
          respiratory_rate: d.respiratoryRate,
          oxygen_saturation: d.oxygenSaturation,
          wrist_temperature_c: d.wristTemperatureC,
          sleep_breathing_disturbances: d.sleepBreathingDisturbances,
          sleep_breathing_disturbances_elevated: d.sleepBreathingDisturbancesElevated,
          weight_lbs: d.weightLbs,
          source,
          source_details: sourceDetailsForDailySnapshot(d, source),
        }));
      if (payloads.length > 0) {
        try {
          await upsertDailyHealthSnapshotBatch(token, payloads);
          totalPushed += payloads.length;
        } catch {
          // A single chunk failure shouldn't abort the rest — the recent
          // chunk has already populated the UI-critical window.
        }
      }
      opts.onChunk?.(chunkIndex, payloads.length);
      chunkIndex += 1;
    }
    // Record the widest window we've completed. Only treat as
    // "completed" when we actually pushed at least one row — that way a
    // total network failure stays retry-eligible on next session
    // (subject to the cooldown in ensureBackfillWindow).
    if (totalPushed > 0) {
      const prev = await readBackfillStatus();
      await writeBackfillStatus({
        completedDays: Math.max(prev.completedDays, totalDays),
        lastAttemptMs: Date.now(),
      });
    } else {
      // Empty result — could be "user has no HK data" or transient
      // failure. Stamp the attempt timestamp so we don't busy-loop, but
      // leave completedDays as-is so the next attempt still considers
      // itself the migration run.
      const prev = await readBackfillStatus();
      await writeBackfillStatus({
        completedDays: prev.completedDays,
        lastAttemptMs: Date.now(),
      });
    }
    return { pushed: totalPushed, chunks: chunkIndex };
  } catch {
    return { pushed: 0, chunks: 0 };
  }
}

/** Gated catch-up backfill for existing users. When the default window
 *  expands (30 → 180 → …) this runs once to fill the missing span on
 *  devices that connected under the old window. Safe to call on every
 *  Home open — internally cooldown-gated, status-flagged. */
export async function ensureBackfillWindow(targetDays: number): Promise<void> {
  try {
    const status = await readBackfillStatus();
    if (status.completedDays >= targetDays) return;
    if (Date.now() - status.lastAttemptMs < BACKFILL_RETRY_COOLDOWN_MS) return;
    if (!isPlatformHealthAvailable()) return;
    await backfillSnapshotsToBackend(targetDays);
  } catch {
    // Silent — fires on next opportunity.
  }
}

async function compute(opts: { age?: number | null }): Promise<HealthDataSummary | null> {
  if (!isPlatformHealthAvailable()) {
    return { ...emptySummary(), hkAvailable: false };
  }
  const raw = await readPlatformHealthSummary({ age: opts.age ?? null }).catch(() => null);
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
    workouts.map((w) => summarizePlatformWorkoutZone2(w, opts.age ?? null).catch(() => null)),
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
    steps: raw.stepsToday ?? null,
    sleepMinutes: raw.lastNightSleepHours != null ? Math.round(raw.lastNightSleepHours * 60) : null,
    restingHeartRate: raw.restingHeartRate ?? null,
    hrv: (raw as any).hrvAvg ?? null,
    workoutMinutes: totalWorkoutMinutes > 0 ? Math.round(totalWorkoutMinutes) : null,
    cardioMinutes: totalCardioMinutes > 0 ? totalCardioMinutes : null,
    zone2Minutes: totalZone2Minutes > 0 ? totalZone2Minutes : null,
    activeEnergyKcal: raw.activeEnergyToday ?? null,
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
  opts: { age?: number | null; onCached?: (s: HealthDataSummary) => void; force?: boolean } = {},
): Promise<HealthDataSummary | null> {
  const cached = await getCachedHealthDataSummary();
  const cachedIsForToday = cached?.dateISO === localDateISO();
  if (cached && cachedIsForToday && opts.onCached) opts.onCached(cached);
  // Refresh if stale, from another local day, OR no cache at all.
  if (opts.force || !cached || !cachedIsForToday || (Date.now() - cached.computedAtMs) > STALE_AFTER_MS) {
    return refreshHealthDataSummary({ age: opts.age ?? null });
  }
  return cached;
}
