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
      for (const row of pending) {
        try {
          const cacheBefore = await loadHydrationCache();
          const current = cacheBefore[row.date] ?? row;
          if (!current.pending) continue;
          const deltaOz = pendingHydrationDeltaOz(current);
          const saved = deltaOz != null
            ? await logHydrationDelta(token, deltaOz, current.date, { commandId: current.pendingCommandId ?? undefined })
            : await logHydration(token, current.ounces, current.date, { commandId: current.pendingCommandId ?? undefined });
          const cacheAfter = await loadHydrationCache();
          const latest = cacheAfter[current.date] ?? current;
          const latestDeltaOz = pendingHydrationDeltaOz(latest);
          const latestChangedDuringFlush = !!latest.pending && (
            latest.pendingCommandId !== current.pendingCommandId
            || latestDeltaOz !== deltaOz
            || latest.ounces !== current.ounces
            || (latest.updatedAtMs ?? 0) > (current.updatedAtMs ?? 0)
          );
          if (deltaOz != null && latestChangedDuringFlush && latestDeltaOz != null) {
            const remainingDeltaOz = Math.round((latestDeltaOz - deltaOz) * 10) / 10;
            if (remainingDeltaOz !== 0) {
              await saveCachedHydration(
                {
                  date: saved.date,
                  ounces: Math.max(0, Math.round((saved.ounces + remainingDeltaOz) * 10) / 10),
                  target_ounces: latest.target_ounces,
                  target_ounces_min: latest.target_ounces_min,
                  target_ounces_max: latest.target_ounces_max,
                },
                {
                  pending: true,
                  pendingCommandId: latest.pendingCommandId,
                  pendingDeltaOz: remainingDeltaOz,
                },
              );
              continue;
            }
          } else if (latestChangedDuringFlush) {
            continue;
          }
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
