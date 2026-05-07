import { getReadinessToday, type ReadinessTodayResponse } from './api';

type ReadinessSignals = Parameters<typeof getReadinessToday>[1];

const DEFAULT_TTL_MS = 60_000;
const readinessInflight = new Map<string, Promise<ReadinessTodayResponse>>();
const readinessCache = new Map<string, { expiresAt: number; value: ReadinessTodayResponse }>();

function readinessKey(token: string, signals: ReadinessSignals): string {
  const normalized = {
    avgSleepHours: signals?.avgSleepHours ?? null,
    avgRestingHr: signals?.avgRestingHr ?? null,
    avgHrvMs: signals?.avgHrvMs ?? null,
    lastNightSleepScore: signals?.lastNightSleepScore ?? null,
    nutritionAdherencePct: signals?.nutritionAdherencePct ?? null,
    plannedFocus: signals?.plannedFocus ?? null,
    cyclePhase: signals?.cyclePhase ?? null,
    dayOfCycle: signals?.dayOfCycle ?? null,
  };
  return `${token}::${JSON.stringify(normalized)}`;
}

export function clearReadinessCache(): void {
  readinessCache.clear();
  readinessInflight.clear();
}

export async function getCachedReadinessToday(
  token: string,
  signals?: ReadinessSignals,
  ttlMs = DEFAULT_TTL_MS,
): Promise<ReadinessTodayResponse> {
  const key = readinessKey(token, signals);
  const now = Date.now();
  const useCache = ttlMs > 0;
  const cached = readinessCache.get(key);
  if (useCache && cached && cached.expiresAt > now) return cached.value;
  const existing = readinessInflight.get(key);
  if (existing) return existing;
  const promise = getReadinessToday(token, signals)
    .then(value => {
      if (useCache) readinessCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      readinessInflight.delete(key);
    });
  readinessInflight.set(key, promise);
  return promise;
}
