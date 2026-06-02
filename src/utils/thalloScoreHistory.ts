// Trailing history for the Thallo Score so the headline number is a
// rolling average, not a single point-in-time reading. The score is
// computed client-side (see `healthScore.ts`), so this stores one
// value per day in AsyncStorage and averages the trailing window.
//
// Sampled on app use — a day only gets an entry when the score is
// computed that day (i.e. the user opened the Progress screen). A new
// user is averaged over however many days they have, same as the
// backend snapshot approach.
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HealthScoreResult } from '../types';

const KEY = 'thalloScoreHistory';
const SNAPSHOT_KEY = 'thalloScoreDailySnapshot';

/** Length of the trailing window the average is taken over. */
export const THALLO_SCORE_WINDOW_DAYS = 28;

/** Map of local date (YYYY-MM-DD) → that day's Thallo Score (0–100). */
type ThalloScoreHistory = Record<string, number>;

export interface ThalloScoreAverage {
  /** Trailing average of the daily Thallo Score across the window. */
  average: number;
  /** Distinct days with a recorded score inside the window (1+ ). */
  sampleCount: number;
  /** Window length in days (28). */
  windowDays: number;
}

export interface ThalloScoreDailySnapshot {
  date: string;
  result: HealthScoreResult;
  average: ThalloScoreAverage | null;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** First date key still inside the trailing window (inclusive). */
function windowCutoffKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - (THALLO_SCORE_WINDOW_DAYS - 1));
  return dayKey(d);
}

async function loadHistory(): Promise<ThalloScoreHistory> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: ThalloScoreHistory = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function averageWithin(history: ThalloScoreHistory): ThalloScoreAverage | null {
  const cutoff = windowCutoffKey();
  const values: number[] = [];
  for (const [k, v] of Object.entries(history)) {
    if (k >= cutoff) values.push(v);
  }
  if (values.length === 0) return null;
  const average = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  return { average, sampleCount: values.length, windowDays: THALLO_SCORE_WINDOW_DAYS };
}

/** Record today's Thallo Score and return the trailing-window average.
 *  Idempotent within a day — the first valid score of the day wins, so
 *  wearable / meal / workout syncs later in the day do not move the
 *  displayed 28-day average until tomorrow.
 *  Entries older than the window are pruned to bound storage. */
export async function recordThalloScore(score: number): Promise<ThalloScoreAverage> {
  const history = await loadHistory();
  const today = dayKey(new Date());
  if (history[today] == null) {
    history[today] = Math.round(score);
  }
  const cutoff = windowCutoffKey();
  const pruned: ThalloScoreHistory = {};
  for (const [k, v] of Object.entries(history)) {
    if (k >= cutoff) pruned[k] = v;
  }
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(pruned));
  } catch {}
  // pruned is already within-window, so its average is the window average.
  return averageWithin(pruned) ?? { average: Math.round(score), sampleCount: 1, windowDays: THALLO_SCORE_WINDOW_DAYS };
}

/** Trailing-window average without recording a new sample. Null when no
 *  score has ever been recorded inside the window. */
export async function loadThalloScoreAverage(): Promise<ThalloScoreAverage | null> {
  return averageWithin(await loadHistory());
}

async function loadDailySnapshot(today: string): Promise<HealthScoreResult | null> {
  try {
    const raw = await AsyncStorage.getItem(SNAPSHOT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.date !== today || !parsed.result || typeof parsed.result !== 'object') return null;
    return parsed.result as HealthScoreResult;
  } catch {
    return null;
  }
}

async function saveDailySnapshot(today: string, result: HealthScoreResult): Promise<void> {
  try {
    await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ date: today, result }));
  } catch {}
}

export async function getStableDailyThalloScore(result: HealthScoreResult): Promise<ThalloScoreDailySnapshot> {
  const today = dayKey(new Date());
  const existing = await loadDailySnapshot(today);
  const stableResult = existing ?? result;
  const score = stableResult.overallScore;
  const average = score != null
    ? await recordThalloScore(score)
    : await loadThalloScoreAverage();
  if (!existing && score != null) {
    await saveDailySnapshot(today, stableResult);
  }
  return { date: today, result: stableResult, average };
}
