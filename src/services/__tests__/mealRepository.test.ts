// Tests for the meal mutation layer's pure identity + idempotency helpers
// (mealMutationKeys, re-exported by mealRepository). These keys are what make
// double-tap / retry / edit-before-log-returns collapse to a single backend
// row instead of duplicating — the core of the meal-logging refactor — so they
// are worth pinning precisely.

import {
  newIdempotencyKey,
  routineOccurrenceKey,
  planLogIdempotencyKey,
  savedMealLogIdempotencyKey,
  watchSpeechIdempotencyKey,
  asFavoriteId,
  asRoutineId,
  asLogId,
} from '../mealMutationKeys.ts';

describe('newIdempotencyKey', () => {
  it('embeds the prefix', () => {
    expect(newIdempotencyKey('fav').startsWith('fav_')).toBe(true);
  });
  it('produces distinct keys across calls (each create gets its own)', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a === b).toBe(false);
  });
});

describe('routineOccurrenceKey', () => {
  it('is deterministic for the same routine + date + time', () => {
    expect(routineOccurrenceKey(7, '2026-05-22', '08:00'))
      .toBe(routineOccurrenceKey(7, '2026-05-22', '08:00'));
  });
  it('differs by date so each day is its own occurrence', () => {
    const a = routineOccurrenceKey(7, '2026-05-22', '08:00');
    const b = routineOccurrenceKey(7, '2026-05-23', '08:00');
    expect(a === b).toBe(false);
  });
  it('differs by routine id', () => {
    const a = routineOccurrenceKey(7, '2026-05-22');
    const b = routineOccurrenceKey(8, '2026-05-22');
    expect(a === b).toBe(false);
  });
});

describe('planLogIdempotencyKey', () => {
  it('prefers the stable _localId when present', () => {
    const key = planLogIdempotencyKey('2026-05-22', 'meal_2', { _localId: 'abc123', meal: 'Oats', calories: 300 });
    expect(key).toBe('plan:2026-05-22:meal_2:abc123');
  });
  it('is identical across two taps of the same meal (collapses to one row)', () => {
    const meal = { _localId: 'abc123' };
    expect(planLogIdempotencyKey('2026-05-22', 'meal_2', meal))
      .toBe(planLogIdempotencyKey('2026-05-22', 'meal_2', meal));
  });
  it('falls back to name + rounded calories when there is no _localId', () => {
    const key = planLogIdempotencyKey('2026-05-22', 'meal_0', { meal: 'Eggs', calories: 211.6 });
    expect(key).toBe('plan:2026-05-22:meal_0:Eggs:212');
  });
  it('distinguishes different meals in the same slot (no false dedupe)', () => {
    const a = planLogIdempotencyKey('2026-05-22', 'meal_0', { meal: 'Eggs', calories: 200 });
    const b = planLogIdempotencyKey('2026-05-22', 'meal_0', { meal: 'Toast', calories: 150 });
    expect(a === b).toBe(false);
  });
  it('distinguishes the same meal across different days', () => {
    const a = planLogIdempotencyKey('2026-05-22', 'meal_0', { meal: 'Eggs', calories: 200 });
    const b = planLogIdempotencyKey('2026-05-23', 'meal_0', { meal: 'Eggs', calories: 200 });
    expect(a === b).toBe(false);
  });
});

describe('watch and saved-meal idempotency keys', () => {
  it('dedupes duplicate watch speech delivery without a command id by hashing items', () => {
    const items = [{ name: 'Greek yogurt', calories: 150, protein: 20 }];
    const a = watchSpeechIdempotencyKey('2026-05-22', { text: 'yogurt' }, items);
    const b = watchSpeechIdempotencyKey('2026-05-22', { text: 'yogurt' }, items);
    expect(a).toBe(b);
  });

  it('prefers the watch command id when present', () => {
    expect(watchSpeechIdempotencyKey('2026-05-22', { commandId: 'abc', text: 'ignored' }, []))
      .toBe('watch_speech:2026-05-22:cmd:abc');
  });

  it('keeps distinct saved meal log actions separate by consumed time', () => {
    const a = savedMealLogIdempotencyKey(5, '2026-05-22', 'lunch', '2026-05-22T12:00:00.000Z');
    const b = savedMealLogIdempotencyKey(5, '2026-05-22', 'lunch', '2026-05-22T12:05:00.000Z');
    expect(a === b).toBe(false);
  });
});

describe('branded ids', () => {
  it('are runtime-identical to their numeric value', () => {
    expect(asFavoriteId(5)).toBe(5);
    expect(asRoutineId(9)).toBe(9);
    expect(asLogId(42)).toBe(42);
  });
});
