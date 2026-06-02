/**
 * Cold-start warm cache for `/meals/history`.
 *
 * The initial GET that hydrates HomeScreen's meal history used to fire
 * inside HomeScreen's auth-restore `useEffect`, which means it could
 * only start after HomeScreen had mounted — one or two paint cycles
 * after the user actually opened the app. This module lets the boot
 * code (`app/index.tsx`) kick that GET the moment the auth token is
 * restored from storage, so the request races HomeScreen's mount
 * rather than waiting on it.
 *
 * Lifecycle:
 *   prime → fetches in the background, stores the response + the
 *           token it was fetched under + the timestamp
 *   consume → returns the rows ONCE if the entry is fresh AND scoped
 *             to the same token. Always single-use: a second read
 *             returns null so the existing "fresh fetch" path stays
 *             authoritative for reloads (no stale rows ever).
 *
 * Token-scoping is the safety net for the sign-out → sign-in-as-other
 * case: even if `prime` somehow ran for user A and the consumer is
 * user B, the token mismatch makes consume return null. There is no
 * way to read another user's rows out of this cache.
 *
 * Fetcher is injected so this module stays dependency-free and
 * unit-testable in node (avoids dragging the full api.ts → React
 * Native chain into the test runner).
 */

/** Minimal shape we need; matches the runtime row from /meals/history. */
export type MealHistoryRowLike = {
  id: number;
  meal_date?: string | null;
  meal_type?: string | null;
  [key: string]: any;
};

export type MealHistoryFetcher = (
  token: string,
  days: number,
  limit: number,
) => Promise<{ meals: MealHistoryRowLike[] }>;

type CacheEntry = {
  token: string;
  rows: MealHistoryRowLike[];
  atMs: number;
  /** Window the rows were fetched with — a consumer that needs a
   *  larger window must refetch rather than show truncated data. */
  days: number;
};

let cached: CacheEntry | null = null;
let inflight: Promise<void> | null = null;

/** Fire-and-forget prime. Safe to call repeatedly; concurrent primes
 *  for the same token coalesce to one in-flight request. A failed
 *  fetch leaves the cache empty so the consumer falls back to its
 *  own fetch path — never throws. */
export function primeMealHistoryCache(
  token: string,
  fetcher: MealHistoryFetcher,
  opts: { days?: number; limit?: number } = {},
): Promise<void> {
  if (!token) return Promise.resolve();
  const days = opts.days ?? 30;
  const limit = opts.limit ?? 100;
  // De-dup concurrent prime calls for the same token.
  if (inflight && cached?.token === token) return inflight;
  const run = (async () => {
    try {
      const result = await fetcher(token, days, limit);
      cached = {
        token,
        rows: result.meals ?? [],
        atMs: Date.now(),
        days,
      };
    } catch {
      // Swallow — consumer falls back to its own fetch.
    } finally {
      inflight = null;
    }
  })();
  inflight = run;
  return run;
}

/** Single-use read. Returns the cached rows iff:
 *    - cache is non-null
 *    - cached.token === token (same user)
 *    - cached.days >= requested days (window covers the consumer's need)
 *    - now − cached.atMs <= maxAgeMs
 *  Always nulls out the cache afterwards so reload paths can't read
 *  stale rows from it. */
export function consumeMealHistoryCache(
  token: string,
  opts: { days?: number; maxAgeMs?: number } = {},
): MealHistoryRowLike[] | null {
  if (!cached) return null;
  if (!token || cached.token !== token) return null;
  const needDays = opts.days ?? 30;
  if (cached.days < needDays) return null;
  const maxAge = opts.maxAgeMs ?? 30_000;
  if (Date.now() - cached.atMs > maxAge) {
    cached = null;
    return null;
  }
  const rows = cached.rows;
  cached = null;  // single-use; reload paths re-fetch
  return rows;
}

/** Drop the cache without consuming. Used on sign-out or user switch
 *  so the next user can never see leftover rows even by accident. */
export function resetMealHistoryCache(): void {
  cached = null;
  inflight = null;
}

/** Test-only helpers. */
export function _peekMealHistoryCacheForTests(): CacheEntry | null {
  return cached ? { ...cached } : null;
}
export function _seedMealHistoryCacheForTests(entry: CacheEntry | null): void {
  cached = entry;
}
