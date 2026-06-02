import AsyncStorage from '@react-native-async-storage/async-storage';
import { upsertLifestyleLog } from '../services/api';
import type {
  DailyLifestyleLog,
  DailyLifestyleLogPayload,
} from '../services/api';
import { STORAGE_KEYS } from './storageKeys.ts';

type PendingLifestyleLog = {
  localDate: string;
  payload: DailyLifestyleLogPayload;
  queuedAtMs: number;
};

type PendingMap = Record<string, PendingLifestyleLog>;

function dateKey(value: string): string {
  return value.slice(0, 10);
}

function cleanPayload(payload: DailyLifestyleLogPayload): DailyLifestyleLogPayload {
  const out: DailyLifestyleLogPayload = {};
  Object.entries(payload).forEach(([key, value]) => {
    if (value === undefined) return;
    if (key === 'notes' && typeof value === 'string') {
      out.notes = value.trim().slice(0, 500);
      return;
    }
    (out as Record<string, unknown>)[key] = value;
  });
  return out;
}

async function readPendingMap(): Promise<PendingMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.health.pendingLifestyleLogs);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as PendingMap : {};
  } catch {
    return {};
  }
}

async function writePendingMap(map: PendingMap): Promise<void> {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    await AsyncStorage.removeItem(STORAGE_KEYS.health.pendingLifestyleLogs);
    return;
  }
  await AsyncStorage.setItem(STORAGE_KEYS.health.pendingLifestyleLogs, JSON.stringify(map));
}

export async function pendingLifestyleLogs(): Promise<PendingLifestyleLog[]> {
  const map = await readPendingMap();
  return Object.values(map).sort((a, b) => a.localDate.localeCompare(b.localDate));
}

export async function findPendingLifestyleLog(localDate: string): Promise<PendingLifestyleLog | null> {
  const map = await readPendingMap();
  return map[dateKey(localDate)] ?? null;
}

export async function savePendingLifestyleLog(
  localDate: string,
  payload: DailyLifestyleLogPayload,
): Promise<PendingLifestyleLog> {
  const key = dateKey(localDate);
  const map = await readPendingMap();
  const pending = {
    localDate: key,
    payload: cleanPayload({ ...(map[key]?.payload ?? {}), ...payload, source: 'manual' }),
    queuedAtMs: Date.now(),
  };
  map[key] = pending;
  await writePendingMap(map);
  return pending;
}

export async function removePendingLifestyleLog(localDate: string): Promise<void> {
  const key = dateKey(localDate);
  const map = await readPendingMap();
  delete map[key];
  await writePendingMap(map);
}

export async function flushPendingLifestyleLogs(token: string): Promise<number> {
  const map = await readPendingMap();
  let flushed = 0;
  for (const pending of Object.values(map).sort((a, b) => a.localDate.localeCompare(b.localDate))) {
    try {
      await upsertLifestyleLog(token, pending.localDate, pending.payload);
      delete map[pending.localDate];
      flushed += 1;
    } catch {
      break;
    }
  }
  await writePendingMap(map);
  return flushed;
}

export async function upsertLifestyleLogOfflineSafe(
  token: string,
  localDate: string,
  payload: DailyLifestyleLogPayload,
): Promise<DailyLifestyleLog> {
  try {
    const row = await upsertLifestyleLog(token, localDate, cleanPayload({ ...payload, source: 'manual' }));
    await removePendingLifestyleLog(localDate);
    return row;
  } catch (error) {
    const pending = await savePendingLifestyleLog(localDate, payload);
    return {
      localDate: pending.localDate,
      hasLog: true,
      pending: true,
      ...pending.payload,
    };
  }
}
