import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HealthSummary, SleepScore, SleepStages } from '../types';
import { scoreSleep, minutesFromMidnight } from './sleepScore';

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
  'MenstrualFlow',
];

const SLEEP_HISTORY_KEY = 'sleepHistory_v1';
const MAX_HISTORY_NIGHTS = 30;

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

export interface ReadHealthOptions {
  age?: number | null;
}

export async function readHealthSummary(opts: ReadHealthOptions = {}): Promise<HealthSummary | null> {
  const mod = getModule();
  if (!mod) return null;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  // Use 36h lookback for last-night data so we catch sleep that ended this morning
  const lastNightStart = new Date(now.getTime() - 36 * 3600000);
  const startMs = sevenDaysAgo.getTime();
  const historyStartMs = thirtyDaysAgo.getTime();
  const endMs = now.getTime();
  const lastNightMs = lastNightStart.getTime();

  const [
    restingHR, steps, sleepSamples, energySamples,
    hrvSamples, vo2Samples, respSamples, spo2Samples,
    standSamples, mindfulSamples, basalSamples,
    lastNightSleep, lastNightHRV, lastNightResp, lastNightSpo2,
    historySleep, historyHRV,
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
    mod.getSleepSamples(historyStartMs, endMs).catch(() => []),
    mod.getHRV(historyStartMs, endMs, 200).catch(() => []),
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
  const history = buildNightlyHistory(historySleep as SleepSample[], historyHRV as any[]);
  persistSleepHistory(history).catch(() => null);

  // Compute last-night inBedMinutes for efficiency.
  const lastNightStages = calcSleepStages(lastNightSleep as SleepSample[]);
  const lastNightInBedMinutes = calcLastNightInBedMinutes(lastNightSleep as SleepSample[]);

  const sleepScore = buildSleepScore({
    stages: lastNightStages,
    inBedMinutes: lastNightInBedMinutes,
    hrvAvg: avgValue(lastNightHRV),
    respRate: avgValue(lastNightResp),
    spo2: avgValue(lastNightSpo2),
    age: opts.age ?? null,
    history,
  });

  // Standing hours: only count samples where user actually stood (value=1 in our mapping)
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
    workouts7d: null,
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
    workoutDetails: Array.isArray(recentWorkouts) ? recentWorkouts : [],
    fetchedAt: now.toISOString(),
  };
}

// ── Workout HR annotation ───────────────────────────────────────────────────
//
// Pulls raw HR samples for a workout window and summarizes them into avg, max,
// and minutes-in-zone. Zones are %MHR bands (220 - age formula).

export interface WorkoutHrSummary {
  avgBpm: number;
  maxBpm: number;
  samples: number;
  zoneMinutes: [number, number, number, number, number]; // Z1..Z5
}

export async function getWorkoutHrSummary(
  startMs: number,
  endMs: number,
  age: number | null,
): Promise<WorkoutHrSummary | null> {
  const mod = getModule();
  if (!mod || typeof mod.getHeartRate !== 'function') return null;
  try {
    const samples = await mod.getHeartRate(startMs, endMs, 500);
    if (!Array.isArray(samples) || samples.length === 0) return null;
    const maxHR = age && age > 0 ? 220 - age : 190;

    let sum = 0;
    let max = 0;
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
      // Assign the gap until next sample (or end) to this zone.
      const nextT = i + 1 < sorted.length ? sorted[i + 1].t : endMs;
      const minutes = Math.max(0, (nextT - t) / 60000);
      const pct = (v / maxHR) * 100;
      const zIdx = pct >= 90 ? 4 : pct >= 80 ? 3 : pct >= 70 ? 2 : pct >= 60 ? 1 : 0;
      zones[zIdx] += minutes;
    }
    return {
      avgBpm: Math.round(sum / sorted.length),
      maxBpm: Math.round(max),
      samples: sorted.length,
      zoneMinutes: zones.map(m => Math.round(m * 10) / 10) as [number, number, number, number, number],
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

export interface CycleStatus {
  phase: CyclePhase;
  dayOfCycle: number | null;   // 1-indexed; null if unknown
  cycleLengthDays: number;     // estimated from history; defaults to 28
  nextExpectedMenses: string | null; // ISO date
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
      .map((s: any) => ({ startMs: new Date(s.startDate).getTime(), endMs: new Date(s.endDate).getTime() }))
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

    return { phase, dayOfCycle, cycleLengthDays, nextExpectedMenses };
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
    // Find the workout with the largest overlap with our window.
    let best: any = null;
    let bestOverlap = 0;
    for (const w of workouts) {
      const ws = new Date(w.startDate).getTime();
      const we = new Date(w.endDate).getTime();
      const overlap = Math.max(0, Math.min(endMs, we) - Math.max(startMs, ws));
      if (overlap > bestOverlap) { best = w; bestOverlap = overlap; }
    }
    if (!best || bestOverlap < 60_000) return null; // <1 min overlap = not the same session
    const cal = Number(best.calories);
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

// ── Sleep Score entry point ──────────────────────────────────────────────────

interface BuildScoreArgs {
  stages: SleepStages | null;
  inBedMinutes: number | null;
  hrvAvg: number | null;
  respRate: number | null;
  spo2: number | null;
  age: number | null;
  history: NightRecord[];
}

function buildSleepScore(a: BuildScoreArgs): SleepScore | null {
  if (!a.stages || a.stages.total < 0.5) return null;
  const hrvHistory = a.history.map((n) => n.hrv).filter((v): v is number => typeof v === 'number' && v > 0);
  const bedtimeHistory = a.history
    .map((n) => n.bedtimeMinutes)
    .filter((v): v is number => typeof v === 'number' && v >= 0 && v < 1440);

  return scoreSleep({
    totalSleepHours: a.stages.total,
    inBedMinutes: a.inBedMinutes,
    deepSleepHours: a.stages.deep,
    remSleepHours: a.stages.rem,
    hrvMs: a.hrvAvg,
    spo2Percent: a.spo2,
    respiratoryRate: a.respRate,
    age: a.age,
    stages: a.stages,
    hrvHistory,
    bedtimeHistory,
  });
}

// ── Nightly history (for personalized score) ────────────────────────────────

export interface NightRecord {
  night: string;                 // YYYY-MM-DD (end-of-sleep date)
  hrv: number | null;
  sleepHours: number | null;
  bedtimeMinutes: number | null; // minutes from midnight, local time
}

function buildNightlyHistory(
  sleepSamples: SleepSample[],
  hrvSamples: Array<{ value: number; startDate: string; endDate?: string }>,
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
    let firstAsleepMs: number | null = null;
    // Find earliest asleep minute to use as bedtime / onset.
    for (const s of samples) {
      if (s.value === 'INBED' || s.value === 'AWAKE') continue;
      const t = new Date(s.startDate).getTime();
      if (firstAsleepMs == null || t < firstAsleepMs) firstAsleepMs = t;
    }
    for (const stage of deduped.values()) {
      if (stage === 'DEEP' || stage === 'REM' || stage === 'CORE' || stage === 'ASLEEP') asleepMin++;
    }
    const sleepHours = asleepMin > 0 ? round1(asleepMin / 60) : null;
    const bedtimeMinutes = firstAsleepMs != null ? minutesFromMidnight(new Date(firstAsleepMs)) : null;

    // Nightly HRV: average of samples whose start falls within this night's window.
    let nightHrv: number | null = null;
    if (firstAsleepMs != null) {
      const windowStart = firstAsleepMs;
      const windowEnd = windowStart + 14 * 3600_000; // cap at +14h from onset
      const vals: number[] = [];
      for (const h of hrvSamples ?? []) {
        const t = new Date(h.startDate).getTime();
        if (t >= windowStart && t <= windowEnd && h.value > 0) vals.push(h.value);
      }
      if (vals.length) nightHrv = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }

    if (sleepHours != null && sleepHours >= 1 && sleepHours < 14) {
      out.push({ night, hrv: nightHrv, sleepHours, bedtimeMinutes });
    }
  }
  out.sort((a, b) => a.night.localeCompare(b.night));
  return out.slice(-MAX_HISTORY_NIGHTS);
}

export async function loadSleepHistory(): Promise<NightRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(SLEEP_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

async function persistSleepHistory(nights: NightRecord[]): Promise<void> {
  try {
    // Merge with existing so we don't lose nights outside the current window.
    const existing = await loadSleepHistory();
    const byNight = new Map<string, NightRecord>();
    for (const n of existing) byNight.set(n.night, n);
    for (const n of nights) byNight.set(n.night, n); // fresh data wins
    const merged = [...byNight.values()].sort((a, b) => a.night.localeCompare(b.night)).slice(-MAX_HISTORY_NIGHTS);
    await AsyncStorage.setItem(SLEEP_HISTORY_KEY, JSON.stringify(merged));
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

function totalValue(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  return Math.round(samples.reduce((sum, s) => sum + (s.value ?? 0), 0));
}

function totalMinutes(samples: Array<{ value: number }> | null): number | null {
  if (!samples?.length) return null;
  return Math.round(samples.reduce((sum, s) => sum + (s.value ?? 0), 0));
}
