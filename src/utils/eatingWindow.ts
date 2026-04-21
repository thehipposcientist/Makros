/**
 * Eating window / time-restricted eating (TRE) derivation.
 *
 * Computed PASSIVELY from existing meal-check timestamps — no new user
 * logging required. Compression of the eating window (14/12/10h) has
 * evidence for metabolic + longevity benefits; chasing very short
 * windows (< 8h) gets speculative fast, so we cap target recommendations
 * at the well-supported range.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const CHECK_TIMESTAMPS_KEY = 'mealCheckTimestamps';

/** Record the wall-clock time a meal was checked off. Called from the
 *  existing check-toggle handler. Storage shape:
 *    { "2026-04-26": { "meal_0": "07:42", "meal_1": "12:15", ... } }
 */
export async function recordMealCheckTime(date: string, mealType: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CHECK_TIMESTAMPS_KEY);
    const map: Record<string, Record<string, string>> = raw ? JSON.parse(raw) : {};
    if (!map[date]) map[date] = {};
    const now = new Date();
    map[date][mealType] = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    // Prune anything older than 30 days so storage doesn't creep.
    const cutoff = new Date(Date.now() - 30 * 86400000);
    for (const k of Object.keys(map)) {
      const [y, m, d] = k.split('-').map(n => parseInt(n, 10));
      if (new Date(y, (m || 1) - 1, d || 1) < cutoff) delete map[k];
    }
    await AsyncStorage.setItem(CHECK_TIMESTAMPS_KEY, JSON.stringify(map));
  } catch {}
}

export async function getMealCheckTimestamps(): Promise<Record<string, Record<string, string>>> {
  try {
    const raw = await AsyncStorage.getItem(CHECK_TIMESTAMPS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export interface EatingWindowDay {
  date: string;
  firstMealTime: string | null;   // "HH:MM" or null
  lastMealTime: string | null;
  windowHours: number | null;     // null when we don't have both endpoints
  fastingHours: number | null;    // hours since last meal of PRIOR day
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

function addDays(dateKey: string, delta: number): string {
  const [y, m, d] = dateKey.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function computeEatingWindow(
  map: Record<string, Record<string, string>>,
  date: string,
): EatingWindowDay {
  const today = map[date] ?? {};
  const times = Object.values(today).filter(t => /^\d{2}:\d{2}$/.test(t));
  if (times.length === 0) {
    return { date, firstMealTime: null, lastMealTime: null, windowHours: null, fastingHours: null };
  }
  const mins = times.map(timeToMinutes).sort((a, b) => a - b);
  const firstMins = mins[0];
  const lastMins = mins[mins.length - 1];
  const firstMealTime = `${String(Math.floor(firstMins / 60)).padStart(2, '0')}:${String(firstMins % 60).padStart(2, '0')}`;
  const lastMealTime = `${String(Math.floor(lastMins / 60)).padStart(2, '0')}:${String(lastMins % 60).padStart(2, '0')}`;
  const windowHours = Math.round(((lastMins - firstMins) / 60) * 10) / 10;

  // Fasting hours = (midnight → today's first meal) + (prior day's last
  // meal → midnight). We also fold in the case where prior day has no
  // data (null fasting).
  let fastingHours: number | null = null;
  const prior = map[addDays(date, -1)];
  if (prior) {
    const priorMins = Object.values(prior)
      .filter(t => /^\d{2}:\d{2}$/.test(t))
      .map(timeToMinutes)
      .sort((a, b) => a - b);
    if (priorMins.length > 0) {
      const priorLast = priorMins[priorMins.length - 1];
      // (24*60 - priorLast) + firstMins
      const fastingMins = (24 * 60 - priorLast) + firstMins;
      fastingHours = Math.round((fastingMins / 60) * 10) / 10;
    }
  }

  return { date, firstMealTime, lastMealTime, windowHours, fastingHours };
}

/** 7-day rolling average of eating-window hours. Null when <3 days of data. */
export function weeklyAverageWindow(
  map: Record<string, Record<string, string>>,
  endDate: string,
  days: number = 7,
): { avgHours: number | null; daysWithData: number } {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < days; i++) {
    const { windowHours } = computeEatingWindow(map, addDays(endDate, -i));
    if (windowHours != null) {
      sum += windowHours;
      count++;
    }
  }
  if (count < 3) return { avgHours: null, daysWithData: count };
  return { avgHours: Math.round((sum / count) * 10) / 10, daysWithData: count };
}

// ── UI helpers ──

export interface EatingWindowInsight {
  windowHours: number | null;
  targetHours: number | null;  // e.g. 12h for longevity
  status: 'within' | 'over' | 'unknown';
  message: string;
}

/** Given a target eating window (e.g. 10h for TRE), describe today's
 *  window relative to it. */
export function windowInsightFor(
  todayWindow: EatingWindowDay,
  targetHours: number | null,
): EatingWindowInsight {
  if (todayWindow.windowHours == null || targetHours == null) {
    return { windowHours: todayWindow.windowHours, targetHours, status: 'unknown',
      message: todayWindow.windowHours == null
        ? 'Check meals off to track your eating window'
        : `${todayWindow.windowHours}h window today` };
  }
  if (todayWindow.windowHours <= targetHours + 0.5) {
    return {
      windowHours: todayWindow.windowHours,
      targetHours,
      status: 'within',
      message: `${todayWindow.windowHours}h eating window — within ${targetHours}h target`,
    };
  }
  return {
    windowHours: todayWindow.windowHours,
    targetHours,
    status: 'over',
    message: `${todayWindow.windowHours}h window — target ${targetHours}h`,
  };
}
