/**
 * Warm-cache contract:
 *   - prime fetches + stores under (token, days, atMs)
 *   - consume returns rows IFF token matches, window covers, age fresh
 *   - consume is single-use; second read returns null
 *   - reset drops everything; sign-out path
 *   - concurrent primes for the same token coalesce
 *   - prime failures leave the cache empty (consumer falls back)
 *
 * Pure-function tests; no React, no network. We use the test seed
 * helpers to bypass `getMealHistory` since these tests pin the cache
 * contract, not the API call.
 */
import {
  consumeMealHistoryCache,
  resetMealHistoryCache,
  _peekMealHistoryCacheForTests,
  _seedMealHistoryCacheForTests,
} from '../mealHistoryWarmCache.ts';

const row = (id: number) => ({ id, meal_date: '2026-05-22', meal_type: 'lunch', name: `m${id}` }) as any;

function seed(token: string, rows: any[], opts: { ageMs?: number; days?: number } = {}) {
  _seedMealHistoryCacheForTests({
    token,
    rows,
    atMs: Date.now() - (opts.ageMs ?? 0),
    days: opts.days ?? 30,
  });
}

// The minimal jestlike runner has no beforeEach; reset inline at the
// top of every case so order-independence is preserved.
describe('mealHistoryWarmCache', () => {
  it('consume returns null when nothing is cached', () => {
    resetMealHistoryCache();
    expect(consumeMealHistoryCache('t1')).toBe(null);
  });

  it('consume returns rows when token + window + freshness all match', () => {
    resetMealHistoryCache();
    seed('t1', [row(1), row(2)]);
    const out = consumeMealHistoryCache('t1', { days: 30 });
    expect(out).toEqual([row(1), row(2)]);
  });

  it('consume returns null when token mismatches (user switch defense)', () => {
    resetMealHistoryCache();
    seed('t1', [row(1)]);
    expect(consumeMealHistoryCache('t2')).toBe(null);
    // Cache remained intact for the original token.
    expect(_peekMealHistoryCacheForTests()?.token).toBe('t1');
  });

  it('consume returns null when the cached window is smaller than requested', () => {
    resetMealHistoryCache();
    seed('t1', [row(1)], { days: 7 });
    expect(consumeMealHistoryCache('t1', { days: 30 })).toBe(null);
  });

  it('consume returns rows when the cached window is LARGER than requested', () => {
    resetMealHistoryCache();
    seed('t1', [row(1)], { days: 90 });
    expect(consumeMealHistoryCache('t1', { days: 30 })).toEqual([row(1)]);
  });

  it('consume returns null when the cache is stale (older than maxAgeMs)', () => {
    resetMealHistoryCache();
    seed('t1', [row(1)], { ageMs: 60_000 });  // 60s old
    expect(consumeMealHistoryCache('t1', { maxAgeMs: 30_000 })).toBe(null);
    // Stale entry is dropped so subsequent reads stay null.
    expect(_peekMealHistoryCacheForTests()).toBe(null);
  });

  it('consume is single-use: a second read returns null even if the first hit', () => {
    resetMealHistoryCache();
    seed('t1', [row(1)]);
    expect(consumeMealHistoryCache('t1')).toEqual([row(1)]);
    expect(consumeMealHistoryCache('t1')).toBe(null);
  });

  it('reset drops the cache without consuming', () => {
    resetMealHistoryCache();
    seed('t1', [row(1)]);
    resetMealHistoryCache();
    expect(_peekMealHistoryCacheForTests()).toBe(null);
    expect(consumeMealHistoryCache('t1')).toBe(null);
  });

  it('empty/blank token never consumes (would otherwise match any blank cache)', () => {
    resetMealHistoryCache();
    seed('', [row(1)]);
    expect(consumeMealHistoryCache('')).toBe(null);
    expect(consumeMealHistoryCache('any')).toBe(null);
  });
});
