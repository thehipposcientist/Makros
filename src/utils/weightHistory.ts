import AsyncStorage from '@react-native-async-storage/async-storage';
import { getWeightEntries, saveWeightEntryAPI, deleteWeightEntryAPI, clearWeightEntriesAPI, type WeightEntryAPI } from '../services/api';
import { WeightEntry } from '../types';
import { loadAuthToken } from './authTokenStorage.ts';
import { STORAGE_KEYS } from './storageKeys.ts';

const CACHE_KEY = STORAGE_KEYS.health.weightHistory;
const QUARANTINE_KEY = STORAGE_KEYS.health.weightHistoryQuarantine;

function normalizeWeightEntry(raw: any): WeightEntry | null {
  const date = String(raw?.date ?? raw?.entry_date ?? '').slice(0, 10);
  const weightLbs = Math.round(Number(raw?.weightLbs ?? raw?.weight_lbs) * 10) / 10;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(weightLbs) || weightLbs <= 0) return null;
  return {
    date,
    weightLbs,
    source: raw?.source,
    loggedAt: raw?.loggedAt ?? raw?.logged_at,
  };
}

function fromApi(row: WeightEntryAPI): WeightEntry | null {
  return normalizeWeightEntry(row);
}

function toApiRow(entry: WeightEntry): WeightEntryAPI {
  return {
    date: entry.date,
    weight_lbs: entry.weightLbs,
    source: entry.source ?? 'manual',
    logged_at: entry.loggedAt,
  };
}

function sortHistory(entries: WeightEntry[]): WeightEntry[] {
  return [...entries].sort((a, b) =>
    a.date === b.date
      ? String(a.loggedAt ?? '').localeCompare(String(b.loggedAt ?? ''))
      : a.date.localeCompare(b.date),
  );
}

async function readCache(): Promise<WeightEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? sortHistory(parsed.map(normalizeWeightEntry).filter((entry): entry is WeightEntry => entry != null))
      : [];
  } catch {
    return [];
  }
}

async function writeCache(entries: WeightEntry[]): Promise<void> {
  await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(sortHistory(entries).slice(-730)));
}

async function quarantineLegacyRows(rows: WeightEntry[], reason: string): Promise<void> {
  if (rows.length === 0) return;
  try {
    const raw = await AsyncStorage.getItem(QUARANTINE_KEY);
    const existing = raw ? JSON.parse(raw) : [];
    const next = [
      ...(Array.isArray(existing) ? existing : []),
      {
        reason,
        quarantinedAt: new Date().toISOString(),
        rows: rows.map(toApiRow),
      },
    ].slice(-20);
    await AsyncStorage.setItem(QUARANTINE_KEY, JSON.stringify(next));
  } catch {
    // Quarantine is best-effort. Never upload legacy local rows on read.
  }
}

async function authTokenOrThrow(): Promise<string> {
  const token = await loadAuthToken();
  if (!token) throw new Error('Sign in required to change weight history.');
  return token;
}

async function refreshFromDb(token: string): Promise<WeightEntry[]> {
  const remote = (await getWeightEntries(token))
    .map(fromApi)
    .filter((entry): entry is WeightEntry => entry != null);
  const sorted = sortHistory(remote);
  const cached = await readCache();
  const remoteDates = new Set(sorted.map(entry => entry.date));
  const localOnly = cached.filter(entry => !remoteDates.has(entry.date));
  await quarantineLegacyRows(localOnly, 'weightHistory cache row missing from DB; not auto-uploaded');
  await writeCache(sorted);
  return sorted;
}

export async function loadWeightHistory(): Promise<WeightEntry[]> {
  const token = await loadAuthToken().catch(() => null);
  if (token) {
    try {
      return await refreshFromDb(token);
    } catch {
      return readCache();
    }
  }
  return readCache();
}

export async function loadWeightEntries(): Promise<Array<{ date: string; weight_lbs: number; source?: string; logged_at?: string }>> {
  const history = await loadWeightHistory();
  return history.map(entry => ({
    date: entry.date,
    weight_lbs: entry.weightLbs,
    source: entry.source,
    logged_at: entry.loggedAt,
  }));
}

export async function saveWeightEntry(
  weightLbs: number,
  source: WeightEntry['source'] = 'manual',
): Promise<WeightEntry[]> {
  const token = await authTokenOrThrow();
  const rounded = Math.round(Number(weightLbs) * 10) / 10;
  if (!Number.isFinite(rounded) || rounded <= 0) throw new Error('weight_lbs must be positive');
  const today = new Date().toISOString().slice(0, 10);
  const loggedAt = new Date().toISOString();
  await saveWeightEntryAPI(token, today, rounded, source, loggedAt);
  try {
    return await refreshFromDb(token);
  } catch {
    const cached = await readCache();
    const next = sortHistory([
      ...cached.filter(entry => entry.date !== today),
      { date: today, weightLbs: rounded, source, loggedAt },
    ]);
    await writeCache(next);
    return next;
  }
}

/** Delete a single weight entry by its ISO date. Returns the DB-backed cache. */
export async function deleteWeightEntry(date: string): Promise<WeightEntry[]> {
  const token = await authTokenOrThrow();
  await deleteWeightEntryAPI(token, date);
  try {
    return await refreshFromDb(token);
  } catch {
    const next = (await readCache()).filter(entry => entry.date !== date);
    await writeCache(next);
    return next;
  }
}

/** Replace an entry's weight at a given date. Inserts one only through the DB upsert endpoint. */
export async function updateWeightEntry(date: string, weightLbs: number): Promise<WeightEntry[]> {
  const token = await authTokenOrThrow();
  const rounded = Math.round(Number(weightLbs) * 10) / 10;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(rounded) || rounded <= 0) {
    throw new Error('Valid date and positive weight_lbs are required');
  }
  const loggedAt = new Date().toISOString();
  await saveWeightEntryAPI(token, date, rounded, 'manual', loggedAt);
  try {
    return await refreshFromDb(token);
  } catch {
    const cached = await readCache();
    const next = sortHistory([
      ...cached.filter(entry => entry.date !== date),
      { date, weightLbs: rounded, source: 'manual', loggedAt },
    ]);
    await writeCache(next);
    return next;
  }
}

/** Wipe all persisted weight entries through the authenticated DB API. */
export async function clearWeightHistory(): Promise<void> {
  const token = await authTokenOrThrow();
  await clearWeightEntriesAPI(token);
  await AsyncStorage.removeItem(CACHE_KEY);
}

export function weightChange(history: WeightEntry[], days: number): { change: number; startWeight: number; endWeight: number } | null {
  if (history.length < 2) return null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const recent = history.filter(e => e.date >= cutoffStr);
  if (recent.length < 2) {
    const start = history[0];
    const end = history[history.length - 1];
    return { change: end.weightLbs - start.weightLbs, startWeight: start.weightLbs, endWeight: end.weightLbs };
  }
  return { change: recent[recent.length - 1].weightLbs - recent[0].weightLbs, startWeight: recent[0].weightLbs, endWeight: recent[recent.length - 1].weightLbs };
}
