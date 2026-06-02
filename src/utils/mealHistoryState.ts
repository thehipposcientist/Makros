/**
 * Pure reducers for the `backendMealHistory` array.
 *
 * Every per-entry mutation in HomeScreen used to be an ad-hoc
 * `setBackendMealHistory(prev => ...)` lambda. That meant the same
 * "insert-or-replace by id", "remove by id", and "flip favorite"
 * patterns existed in ~12 places, each with subtly different filter +
 * sort logic. Two notable footguns those copies hid:
 *
 *   - Order drift: some upsert paths sorted descending by day+time,
 *     others didn't, so an edited row could jump to the wrong slot.
 *   - Identity drift: a few "favorite flip" paths used array-index
 *     mutation instead of id matching; an interleaved insert pushed
 *     the flip onto the wrong row.
 *
 * These helpers centralize the contract. All keyed by `id`. All return
 * a new array (or the input untouched when no change). The
 * `setBackendMealHistory` call sites are now one-liners that read like
 * the intent, not the mechanics. Keep this module dependency-free so
 * it stays trivially unit-testable in node.
 */

export type MealHistoryLikeEntry = {
  id: number;
  meal_date?: string | null;
  meal_type?: string | null;
  client_meal_key?: string | null;
  consumed_at?: string | null;
  created_at?: string | null;
  saved_meal_id?: number | null;
  [key: string]: any;
};

/** Sort: newest day first, then newest within the day by consumed_at or
 *  created_at. Stable for ties. Returns a new array; never mutates. */
export function sortHistoryEntries<T extends MealHistoryLikeEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const dayCmp = String(b.meal_date ?? '').localeCompare(String(a.meal_date ?? ''));
    if (dayCmp !== 0) return dayCmp;
    return String(b.consumed_at ?? b.created_at ?? '').localeCompare(String(a.consumed_at ?? a.created_at ?? ''));
  });
}

/** Insert-or-replace by id. New entry takes the front, existing copy
 *  removed, then sorted newest-first. Returns a fresh array. */
export function upsertHistoryEntry<T extends MealHistoryLikeEntry>(
  history: T[] | null | undefined,
  entry: T,
): T[] {
  const current = history ?? [];
  const without = current.filter(e => e.id !== entry.id);
  return sortHistoryEntries([entry, ...without]);
}

/** Remove by id. Returns `null` for a null input, the same array if
 *  nothing matched (so React's setState bails on the no-op), or a new
 *  filtered array. */
export function removeHistoryEntry<T extends MealHistoryLikeEntry>(
  history: T[] | null | undefined,
  mealId: number,
): T[] | null | undefined {
  if (history == null) return history;
  const filtered = history.filter(e => e.id !== mealId);
  return filtered.length === history.length ? history : filtered;
}

/** Match HomeScreen's MealSavedMarkerSnapshot shape so the favorite
 *  optimistic flow can pass it straight through. `present=false`
 *  removes the `saved_meal_id` field entirely (used by the favorite
 *  rollback path); `present=true` sets it to `value ?? null`. */
export type FavoriteMarker = { present: boolean; value?: number | null };

export function setHistoryEntryFavoriteMarker<T extends MealHistoryLikeEntry>(
  history: T[] | null | undefined,
  mealId: number,
  marker: FavoriteMarker,
): T[] | null | undefined {
  if (!history) return history;
  let changed = false;
  const next = history.map(entry => {
    if (entry.id !== mealId) return entry;
    const currentPresent = Object.prototype.hasOwnProperty.call(entry as any, 'saved_meal_id');
    const currentValue = entry.saved_meal_id;
    const nextEntry: any = { ...entry };
    if (marker.present) nextEntry.saved_meal_id = marker.value ?? null;
    else delete nextEntry.saved_meal_id;
    const nextValue = nextEntry.saved_meal_id;
    if (currentPresent === marker.present && currentValue === nextValue) return entry;
    changed = true;
    return nextEntry as T;
  });
  return changed ? next : history;
}

/** Convenience for the common "favorite POST returned an id, stamp it
 *  on the source row" case. `null` clears the field. */
export function setHistoryEntrySavedMealId<T extends MealHistoryLikeEntry>(
  history: T[] | null | undefined,
  mealId: number,
  savedMealId: number | null,
): T[] | null | undefined {
  return setHistoryEntryFavoriteMarker(history, mealId, {
    present: savedMealId !== null,
    value: savedMealId,
  });
}
