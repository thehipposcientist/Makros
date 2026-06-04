/**
 * Hydration retry worker.
 *
 * `hydrationCache.ts` writes optimistic rows with `pending: true` when a
 * +oz tap fires while the backend can't be reached. Until now nothing
 * replayed those rows — the data sat in AsyncStorage forever, never
 * actually reaching `/meals/hydration`.
 *
 * `flushPendingHydration` walks every pending day, replays quick-adds
 * as atomic deltas when that intent is available, and clears the
 * pending flag on success. Designed to be called from app-foreground
 * hooks and after watch commands deliver, not on a timer — it's cheap
 * when the queue is empty and bounded by how many days have unsynced data.
 */
import {
  type CachedHydrationStatus,
  loadHydrationCache,
  pendingCachedHydrationRows,
  saveCachedHydration,
} from './hydrationCache';
import { logHydration, logHydrationDelta } from '../services/api';

let inFlight: Promise<void> | null = null;

export function pendingHydrationDeltaOz(row: Pick<CachedHydrationStatus, 'pendingDeltaOz'>): number | null {
  const delta = Number(row.pendingDeltaOz);
  return Number.isFinite(delta) && delta !== 0 ? delta : null;
}

export async function flushPendingHydration(token: string | null | undefined): Promise<void> {
  if (!token) return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const pending = await pendingCachedHydrationRows();
      if (pending.length === 0) return;
      // Read the latest cache once so we can preserve target_ounces +
      // any newer optimistic writes that landed mid-flush.
      const cache = await loadHydrationCache();
      for (const row of pending) {
        try {
          const deltaOz = pendingHydrationDeltaOz(row);
          const saved = deltaOz != null
            ? await logHydrationDelta(token, deltaOz, row.date, { commandId: row.pendingCommandId ?? undefined })
            : await logHydration(token, row.ounces, row.date, { commandId: row.pendingCommandId ?? undefined });
          const current = cache[row.date] ?? row;
          // Backend wins on `ounces` (it reconciles with any other
          // device's writes), but we keep the target from the cache
          // because that's per-user not per-day.
          await saveCachedHydration(
            {
              date: saved.date,
              ounces: saved.ounces,
              target_ounces: current.target_ounces,
              target_ounces_min: current.target_ounces_min,
              target_ounces_max: current.target_ounces_max,
            },
            { pending: false },
          );
        } catch {
          // Leave row pending for the next foreground / reconnect.
          // No retries inline — the caller decides cadence.
        }
      }
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
