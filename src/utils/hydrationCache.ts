import AsyncStorage from '@react-native-async-storage/async-storage';
import type { HydrationStatus } from '../services/api';
import { hydrationTargetRangeOz } from './hydration';

export const HYDRATION_CACHE_KEY = 'hydrationByDate_v1';

export type CachedHydrationStatus = HydrationStatus & {
  pending?: boolean;
  updatedAtMs?: number;
};

let cacheQueue: Promise<void> = Promise.resolve();

function normalizeRow(row: any): CachedHydrationStatus | null {
  if (!row || typeof row !== 'object') return null;
  const date = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
  const ounces = Number(row.ounces);
  const target = Number(row.target_ounces);
  const normalizedTarget = Number.isFinite(target) && target > 0 ? target : 64;
  const range = hydrationTargetRangeOz(normalizedTarget);
  const explicitMin = Number(row.target_ounces_min);
  const explicitMax = Number(row.target_ounces_max);
  if (!date || !Number.isFinite(ounces)) return null;
  return {
    ...row,
    date,
    ounces: Math.max(0, Math.round(ounces * 10) / 10),
    target_ounces: normalizedTarget,
    target_ounces_min: Number.isFinite(explicitMin) && explicitMin > 0 ? explicitMin : range?.min,
    target_ounces_max: Number.isFinite(explicitMax) && explicitMax > 0 ? explicitMax : range?.max,
    pending: !!row.pending,
    updatedAtMs: Number.isFinite(Number(row.updatedAtMs)) ? Number(row.updatedAtMs) : Date.now(),
  };
}

async function readCache(): Promise<Record<string, CachedHydrationStatus>> {
  try {
    const raw = await AsyncStorage.getItem(HYDRATION_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const rows: Record<string, CachedHydrationStatus> = {};
    for (const [date, value] of Object.entries(parsed)) {
      const row = normalizeRow({ ...(value as any), date });
      if (row) rows[row.date] = row;
    }
    return rows;
  } catch {
    return {};
  }
}

async function writeCache(rows: Record<string, CachedHydrationStatus>): Promise<void> {
  await AsyncStorage.setItem(HYDRATION_CACHE_KEY, JSON.stringify(rows));
}

async function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = cacheQueue.then(fn, fn);
  cacheQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function loadHydrationCache(): Promise<Record<string, CachedHydrationStatus>> {
  return readCache();
}

export async function loadCachedHydration(dateISO: string): Promise<CachedHydrationStatus | null> {
  const rows = await readCache();
  return rows[dateISO.slice(0, 10)] ?? null;
}

export async function saveCachedHydration(
  row: HydrationStatus,
  opts: { pending?: boolean } = {},
): Promise<CachedHydrationStatus | null> {
  return queued(async () => {
    const normalized = normalizeRow({
      ...row,
      pending: !!opts.pending,
      updatedAtMs: Date.now(),
    });
    if (!normalized) return null;
    const rows = await readCache();
    rows[normalized.date] = normalized;
    await writeCache(rows);
    return normalized;
  });
}

export async function applyCachedHydrationDelta(
  dateISO: string,
  deltaOz: number,
  fallbackTarget: number,
  opts: { pending?: boolean } = {},
): Promise<CachedHydrationStatus | null> {
  return queued(async () => {
    const date = dateISO.slice(0, 10);
    const rows = await readCache();
    const prev = rows[date];
    const nextOunces = Math.max(0, Math.round(((prev?.ounces ?? 0) + deltaOz) * 10) / 10);
    const next = normalizeRow({
      ...(prev ?? { date, target_ounces: fallbackTarget }),
      date,
      ounces: nextOunces,
      target_ounces: prev?.target_ounces ?? fallbackTarget,
      pending: opts.pending ?? true,
      updatedAtMs: Date.now(),
    });
    if (!next) return null;
    rows[date] = next;
    await writeCache(rows);
    return next;
  });
}

export async function removeCachedHydration(dateISO: string): Promise<void> {
  await queued(async () => {
    const rows = await readCache();
    delete rows[dateISO.slice(0, 10)];
    await writeCache(rows);
  });
}

export async function pendingCachedHydrationRows(): Promise<CachedHydrationStatus[]> {
  const rows = await readCache();
  return Object.values(rows).filter(row => row.pending);
}
