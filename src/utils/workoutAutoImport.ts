// Detect workouts the user recorded on their Apple Watch (or logged elsewhere
// in Apple Health) that aren't in Thallo's local history. Offer one-tap
// import as a manual-activity WorkoutSession so they count toward streaks,
// adherence, and calorie totals.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WorkoutSession, WorkoutDetail, ActivityCategory, ActivityIntensity, CardioStyle } from '../types';
import { loadWorkoutHistory, saveWorkoutSession } from './workoutHistory';

// Persisted ids of HK imports the user has dismissed via Skip / Clear All.
// Without this, "skipped" only filtered the in-memory candidate list and
// the SAME workout re-appeared on every refresh because the underlying
// HKWorkout was still there. Storing a Set of {externalId → dismissedAtMs}
// so we can age them out (auto-forget after 60 days so the storage doesn't
// grow forever, and the user CAN re-surface old workouts by waiting that
// long if they want).
const DISMISSED_KEY = 'hkImportDismissed_v1';
const DISMISSAL_TTL_MS = 60 * 86400000; // 60 days

interface DismissalEntry {
  ts: number;     // dismissedAtMs
}
type DismissalMap = Record<string, DismissalEntry>;

async function loadDismissed(): Promise<DismissalMap> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Prune expired entries on every read so we self-clean.
    const now = Date.now();
    let dirty = false;
    const cleaned: DismissalMap = {};
    for (const [id, entry] of Object.entries(parsed)) {
      const e = entry as DismissalEntry;
      if (e?.ts && (now - e.ts) < DISMISSAL_TTL_MS) {
        cleaned[id] = e;
      } else {
        dirty = true;
      }
    }
    if (dirty) {
      AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(cleaned)).catch(() => {});
    }
    return cleaned;
  } catch {
    return {};
  }
}

async function saveDismissed(map: DismissalMap): Promise<void> {
  try { await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(map)); }
  catch { /* non-fatal */ }
}

/** Mark one or more HK external ids as dismissed. They will not re-surface
 *  in `detectUnloggedWorkouts` until either the TTL expires or the user
 *  explicitly un-dismisses (currently no UI for that, by design). */
export async function dismissHkImports(externalIds: string[]): Promise<void> {
  if (!externalIds.length) return;
  const map = await loadDismissed();
  const now = Date.now();
  for (const id of externalIds) map[id] = { ts: now };
  await saveDismissed(map);
}

/** Clear all dismissals — re-surfaces every previously-skipped HK import.
 *  Exposed for a hypothetical "show dismissed again" debug action. */
export async function resetHkDismissals(): Promise<void> {
  await saveDismissed({});
}

export interface ImportCandidate {
  externalId: string;               // unique per HKWorkout startDate
  activityName: string;
  startDate: string;
  endDate: string;
  durationMin: number;
  calories?: number | null;
  distanceMiles?: number | null;
}

// Build a stable id from the HKWorkout start time, rounded to the nearest
// minute. AH can return slightly different millisecond offsets between
// fetches for the same workout, so rounding prevents dismissed workouts
// from reappearing with a new ID.
function externalIdFor(w: WorkoutDetail): string {
  const ms = new Date(w.startDate).getTime();
  const roundedMin = Math.round(ms / 60000) * 60000;
  return `hk_${roundedMin}`;
}

// ±5 min buffer on each end of a local session's window. Anything Apple
// Health recorded that overlaps (with the buffer) a Thallo session is
// treated as already-covered. Buffer exists because a user may start
// their watch workout a minute or two before/after starting in Thallo;
// those should still dedupe.
const OVERLAP_BUFFER_MS = 5 * 60 * 1000;

interface LocalInterval {
  start: number;
  end: number;
}

function intervalsOverlap(a: LocalInterval, b: LocalInterval): boolean {
  return a.start < b.end && b.start < a.end;
}

export async function detectUnloggedWorkouts(
  appleWorkouts: WorkoutDetail[],
  lookbackDays: number = 7,
): Promise<ImportCandidate[]> {
  if (!Array.isArray(appleWorkouts) || appleWorkouts.length === 0) return [];

  const history = await loadWorkoutHistory().catch(() => []);
  const cutoff = Date.now() - lookbackDays * 86400000;

  // Build time INTERVALS (start + end) for each local session so we can
  // do proper overlap checks instead of a crude start-time window. The
  // old ±15-min start-match dropped obvious dupes like "Thallo started
  // 8:00, Apple Health logged 8:20 for the same session" because the
  // watch started recording late. Interval overlap catches those.
  const localIntervals: LocalInterval[] = [];
  for (const s of history) {
    if (s.skipped) continue;
    const startMs = s.startedAt
      ? new Date(s.startedAt).getTime()
      : new Date(s.date).getTime();
    if (!(startMs > cutoff)) continue;
    const endMs = s.endedAt
      ? new Date(s.endedAt).getTime()
      : startMs + (Number(s.durationSeconds) || 0) * 1000;
    // Fallback for sessions that have no end/duration: treat as a 30-min
    // nominal window so we still dedupe simple taps.
    const safeEnd = endMs > startMs ? endMs : startMs + 30 * 60_000;
    localIntervals.push({
      start: startMs - OVERLAP_BUFFER_MS,
      end: safeEnd + OVERLAP_BUFFER_MS,
    });
  }
  const alreadyImportedIds = new Set(
    history.map(s => s.id).filter(id => id.startsWith('hk_')),
  );
  // Persisted dismissals — same workouts won't re-surface after Skip /
  // Clear All until the TTL expires.
  const dismissedMap = await loadDismissed();
  const dismissedIds = new Set(Object.keys(dismissedMap));

  const candidates: ImportCandidate[] = [];
  for (const w of appleWorkouts) {
    const startMs = new Date(w.startDate).getTime();
    const endMs = new Date(w.endDate).getTime();
    if (!(startMs > cutoff)) continue;
    const extId = externalIdFor(w);
    if (alreadyImportedIds.has(extId)) continue;
    if (dismissedIds.has(extId)) continue;
    const hkInterval: LocalInterval = {
      start: startMs,
      end: endMs > startMs ? endMs : startMs + (w.duration || 0) * 60_000,
    };
    const overlapsExisting = localIntervals.some(iv => intervalsOverlap(iv, hkInterval));
    if (overlapsExisting) continue;
    candidates.push({
      externalId: extId,
      activityName: w.activityName ?? 'Workout',
      startDate: w.startDate,
      endDate: w.endDate,
      durationMin: Math.round(w.duration),
      calories: w.calories ?? null,
      distanceMiles: w.distanceMiles ?? null,
    });
  }
  // Most recent first
  candidates.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return candidates;
}

// Map an Apple workout name → Thallo's ActivityCategory/subtype.
function classifyActivity(name: string): { category: ActivityCategory; subtype: string; cardioStyle?: CardioStyle } {
  const n = (name || '').toLowerCase();
  if (/run/.test(n))                               return { category: 'cardio', subtype: 'Running', cardioStyle: 'steady' };
  if (/walk|hike/.test(n))                         return { category: 'cardio', subtype: n.includes('hike') ? 'Hiking' : 'Walking', cardioStyle: 'steady' };
  if (/cycl|bike/.test(n))                         return { category: 'cardio', subtype: 'Cycling', cardioStyle: 'steady' };
  if (/row/.test(n))                               return { category: 'cardio', subtype: 'Rowing', cardioStyle: 'steady' };
  if (/swim/.test(n))                              return { category: 'cardio', subtype: 'Swimming', cardioStyle: 'steady' };
  if (/yoga|pilates|stretch|mobility/.test(n))     return { category: 'mobility', subtype: name };
  if (/strength|lift|weight/.test(n))              return { category: 'strength', subtype: 'Strength training' };
  if (/hiit|crossfit|functional/.test(n))          return { category: 'cardio', subtype: 'HIIT', cardioStyle: 'intervals' };
  // Stair climber = cardio machine (already mapped via "stair" to its own
  // path); rock climbing / bouldering = sport so it routes to the climbing
  // gear keywords. Order matters: check "stair" first so "stair climbing"
  // doesn't fall into the rock-climbing branch.
  if (/stair/.test(n))                             return { category: 'cardio', subtype: 'Stair', cardioStyle: 'steady' };
  if (/climb|boulder/.test(n))                     return { category: 'sport', subtype: 'climbing' };
  if (/box|kickbox|martial/.test(n))               return { category: 'sport', subtype: /kickbox/.test(n) ? 'kickboxing' : (/martial/.test(n) ? 'martial_arts' : 'boxing') };
  if (/sport|basketball|soccer|tennis|pickleball|golf|surf|ski/.test(n))
                                                   return { category: 'sport', subtype: name };
  return { category: 'cardio', subtype: name || 'Workout', cardioStyle: 'steady' };
}

export async function importCandidate(c: ImportCandidate): Promise<void> {
  const info = classifyActivity(c.activityName);
  const durationSeconds = c.durationMin * 60;
  const session: WorkoutSession = {
    id: c.externalId,
    date: c.startDate,
    focus: info.subtype.toLowerCase(),
    durationSeconds,
    startedAt: c.startDate,
    endedAt: c.endDate,
    exercises: [],
    completed: true,
    manualActivity: {
      category: info.category,
      subtype: info.subtype,
      intensity: 'moderate' as ActivityIntensity,
      cardioStyle: info.cardioStyle,
      source: 'apple_health' as any,
      distanceMiles: c.distanceMiles ?? undefined,
      caloriesBurned: c.calories ?? undefined,
    },
  };
  await saveWorkoutSession(session);
}
