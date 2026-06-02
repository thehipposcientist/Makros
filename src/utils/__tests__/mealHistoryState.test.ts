/**
 * Tests for the centralized mealHistoryState reducers. Pins the
 * contracts the old ad-hoc setBackendMealHistory(prev => …) lambdas
 * had to silently agree on:
 *   - upsert: id-keyed, not array-index; result sorted newest-first
 *   - remove: same-array return when nothing matched (React bail-out)
 *   - favorite-flip: idempotent, distinguishes "absent" from "null",
 *     does not mutate the original entry
 */
import {
  removeHistoryEntry,
  setHistoryEntryFavoriteMarker,
  setHistoryEntrySavedMealId,
  sortHistoryEntries,
  upsertHistoryEntry,
  type MealHistoryLikeEntry,
} from '../mealHistoryState.ts';

const entry = (over: Partial<MealHistoryLikeEntry> & { id: number }): MealHistoryLikeEntry => ({
  meal_date: '2026-05-22',
  meal_type: 'lunch',
  consumed_at: '2026-05-22T12:00:00Z',
  created_at: '2026-05-22T12:00:00Z',
  ...over,
});

describe('sortHistoryEntries', () => {
  it('sorts newest day first', () => {
    const a = entry({ id: 1, meal_date: '2026-05-20' });
    const b = entry({ id: 2, meal_date: '2026-05-22' });
    const c = entry({ id: 3, meal_date: '2026-05-21' });
    expect(sortHistoryEntries([a, b, c]).map(e => e.id)).toEqual([2, 3, 1]);
  });

  it('within the same day, sorts newest consumed_at first', () => {
    const a = entry({ id: 1, consumed_at: '2026-05-22T08:00:00Z' });
    const b = entry({ id: 2, consumed_at: '2026-05-22T20:00:00Z' });
    expect(sortHistoryEntries([a, b]).map(e => e.id)).toEqual([2, 1]);
  });

  it('falls back to created_at when consumed_at is null', () => {
    const a = entry({ id: 1, consumed_at: null, created_at: '2026-05-22T08:00:00Z' });
    const b = entry({ id: 2, consumed_at: null, created_at: '2026-05-22T20:00:00Z' });
    expect(sortHistoryEntries([a, b]).map(e => e.id)).toEqual([2, 1]);
  });

  it('does not mutate the input array', () => {
    const list = [entry({ id: 1, meal_date: '2026-05-20' }), entry({ id: 2, meal_date: '2026-05-22' })];
    const snapshot = list.map(e => e.id);
    sortHistoryEntries(list);
    expect(list.map(e => e.id)).toEqual(snapshot);
  });
});

describe('upsertHistoryEntry', () => {
  it('inserts when the id is new', () => {
    const out = upsertHistoryEntry([entry({ id: 1 })], entry({ id: 2 }));
    expect(out.length).toBe(2);
    expect(out.some(e => e.id === 2)).toBe(true);
  });

  it('replaces the existing row by id (no duplicate)', () => {
    const out = upsertHistoryEntry(
      [entry({ id: 1, meal_date: '2026-05-22', consumed_at: '2026-05-22T08:00:00Z' })],
      entry({ id: 1, meal_date: '2026-05-22', consumed_at: '2026-05-22T20:00:00Z' }),
    );
    expect(out.length).toBe(1);
    expect(out[0].consumed_at).toBe('2026-05-22T20:00:00Z');
  });

  it('treats null history as empty', () => {
    const out = upsertHistoryEntry(null, entry({ id: 7 }));
    expect(out.map(e => e.id)).toEqual([7]);
  });

  it('result is sorted newest-first', () => {
    const out = upsertHistoryEntry(
      [entry({ id: 1, meal_date: '2026-05-20' })],
      entry({ id: 2, meal_date: '2026-05-22' }),
    );
    expect(out.map(e => e.id)).toEqual([2, 1]);
  });

  it('two upserts of the same id stay one row', () => {
    let h: MealHistoryLikeEntry[] | null = null;
    h = upsertHistoryEntry(h, entry({ id: 1 }));
    h = upsertHistoryEntry(h, entry({ id: 1, meal_type: 'dinner' }));
    expect(h.length).toBe(1);
    expect(h[0].meal_type).toBe('dinner');
  });
});

describe('removeHistoryEntry', () => {
  it('removes by id', () => {
    const out = removeHistoryEntry([entry({ id: 1 }), entry({ id: 2 })], 1);
    expect(out!.map(e => e.id)).toEqual([2]);
  });

  it('returns the same array reference when nothing matched (React bail-out)', () => {
    const list = [entry({ id: 1 })];
    const out = removeHistoryEntry(list, 999);
    expect(out === list).toBe(true);
  });

  it('returns null when input is null', () => {
    expect(removeHistoryEntry(null, 1)).toBe(null);
  });
});

describe('setHistoryEntryFavoriteMarker', () => {
  it('stamps saved_meal_id on the matching row when present=true', () => {
    const out = setHistoryEntryFavoriteMarker([entry({ id: 1 })], 1, { present: true, value: 42 });
    expect(out![0].saved_meal_id).toBe(42);
  });

  it('removes the saved_meal_id field when present=false', () => {
    const out = setHistoryEntryFavoriteMarker(
      [entry({ id: 1, saved_meal_id: 42 })], 1, { present: false, value: null },
    );
    expect(Object.prototype.hasOwnProperty.call(out![0], 'saved_meal_id')).toBe(false);
  });

  it('explicit null is distinct from absent', () => {
    const after = setHistoryEntryFavoriteMarker([entry({ id: 1 })], 1, { present: true, value: null });
    expect(Object.prototype.hasOwnProperty.call(after![0], 'saved_meal_id')).toBe(true);
    expect(after![0].saved_meal_id).toBe(null);
  });

  it('returns the same array reference when nothing changed', () => {
    const list = [entry({ id: 1, saved_meal_id: 42 })];
    const out = setHistoryEntryFavoriteMarker(list, 1, { present: true, value: 42 });
    expect(out === list).toBe(true);
  });

  it('does not mutate the matched entry — produces a new object', () => {
    const list = [entry({ id: 1 })];
    setHistoryEntryFavoriteMarker(list, 1, { present: true, value: 42 });
    expect(list[0].saved_meal_id).toBe(undefined);
  });

  it('leaves unrelated rows untouched (reference-equal)', () => {
    const a = entry({ id: 1 });
    const b = entry({ id: 2 });
    const out = setHistoryEntryFavoriteMarker([a, b], 1, { present: true, value: 7 });
    expect(out![1] === b).toBe(true);
  });
});

describe('setHistoryEntrySavedMealId', () => {
  it('non-null id → present marker', () => {
    const out = setHistoryEntrySavedMealId([entry({ id: 1 })], 1, 99);
    expect(out![0].saved_meal_id).toBe(99);
  });

  it('null id → removes the field (rollback path)', () => {
    const out = setHistoryEntrySavedMealId([entry({ id: 1, saved_meal_id: 99 })], 1, null);
    expect(Object.prototype.hasOwnProperty.call(out![0], 'saved_meal_id')).toBe(false);
  });
});
