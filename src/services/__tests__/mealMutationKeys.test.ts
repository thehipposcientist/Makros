/**
 * Pure-function tests for the meal-mutation idempotency / in-flight-key
 * helpers. These are the bedrock of double-tap safety across:
 *   - planLogIdempotencyKey: server-side dedupe of plan check-offs
 *   - addSavedMutationKey: client-side dedupe of "add favorite to day"
 *   - savedMealLogIdempotencyKey: server-side dedupe of saved-meal log
 *   - watchSpeechIdempotencyKey: server-side dedupe of watch dictation
 *
 * Any change to these keys' shape silently breaks idempotency; if a test
 * here fails, audit every caller before changing the expected output.
 */
import {
  addSavedMutationKey,
  newIdempotencyKey,
  planLogIdempotencyKey,
  savedMealLogIdempotencyKey,
  stableJsonHash,
  watchSpeechIdempotencyKey,
} from '../mealMutationKeys.ts';

describe('planLogIdempotencyKey', () => {
  it('produces the same key for the same logical meal across two refs', () => {
    // Different object identity, same logical meal (client_meal_key wins).
    const a = planLogIdempotencyKey('2026-05-22', 'meal_0', { _clientMealKey: 'breakfast', meal: 'Oats' });
    const b = planLogIdempotencyKey('2026-05-22', 'meal_0', { _clientMealKey: 'breakfast', meal: 'Oats', calories: 500 });
    expect(a).toBe(b);
  });

  it('changes when the date changes (different intent)', () => {
    const today = planLogIdempotencyKey('2026-05-22', 'meal_0', { _clientMealKey: 'breakfast' });
    const tomorrow = planLogIdempotencyKey('2026-05-23', 'meal_0', { _clientMealKey: 'breakfast' });
    expect(today === tomorrow).toBe(false);
  });

  it('falls back to _localId when client_meal_key missing', () => {
    const key = planLogIdempotencyKey('2026-05-22', 'snack', { _localId: 'manual_42' });
    expect(key).toBe('plan:2026-05-22:snack:manual_42');
  });

  it('uses name+rounded-calories as last-resort identity', () => {
    const k1 = planLogIdempotencyKey('2026-05-22', 'snack', { meal: 'Apple', calories: 95 });
    const k2 = planLogIdempotencyKey('2026-05-22', 'snack', { meal: 'Apple', calories: 95.4 });
    expect(k1).toBe(k2);
  });
});

describe('addSavedMutationKey', () => {
  it('prefers the saved meal id over name/calories', () => {
    const key = addSavedMutationKey('2026-05-22', { id: 17, name: 'Chicken', total_calories: 500 });
    expect(key).toBe('addSaved:2026-05-22:17');
  });

  it('collapses two taps of the same favorite on the same date', () => {
    const a = addSavedMutationKey('2026-05-22', { id: 17 });
    const b = addSavedMutationKey('2026-05-22', { id: 17 });
    expect(a).toBe(b);
  });

  it('does NOT collapse the same favorite on different dates', () => {
    const a = addSavedMutationKey('2026-05-22', { id: 17 });
    const b = addSavedMutationKey('2026-05-23', { id: 17 });
    expect(a === b).toBe(false);
  });

  it('falls back to optimistic id while real id is pending from backend', () => {
    const key = addSavedMutationKey('2026-05-22', { _optimisticId: -3, name: 'Pending' });
    expect(key).toBe('addSaved:2026-05-22:-3');
  });

  it('falls back to name+rounded-cals when no id at all', () => {
    const key = addSavedMutationKey('2026-05-22', { name: 'Chicken Bowl', total_calories: 549.4 });
    expect(key).toBe('addSaved:2026-05-22:sig:chicken bowl|549');
  });

  it('treats empty name as the empty signature (still locks the date)', () => {
    const a = addSavedMutationKey('2026-05-22', { total_calories: 0 });
    const b = addSavedMutationKey('2026-05-22', { name: '', total_calories: 0 });
    expect(a).toBe(b);
  });
});

describe('savedMealLogIdempotencyKey', () => {
  it('is stable across same (savedId, date, mealType, consumedAt)', () => {
    const a = savedMealLogIdempotencyKey(7, '2026-05-22', 'lunch', '2026-05-22T12:30:00Z');
    const b = savedMealLogIdempotencyKey(7, '2026-05-22', 'lunch', '2026-05-22T12:30:00Z');
    expect(a).toBe(b);
  });

  it('separates two logs of the same favorite at different times of day', () => {
    const morning = savedMealLogIdempotencyKey(7, '2026-05-22', 'snack', '2026-05-22T09:00:00Z');
    const evening = savedMealLogIdempotencyKey(7, '2026-05-22', 'snack', '2026-05-22T21:00:00Z');
    expect(morning === evening).toBe(false);
  });
});

describe('watchSpeechIdempotencyKey', () => {
  it('prefers explicit commandId when present', () => {
    const key = watchSpeechIdempotencyKey('2026-05-22', { commandId: 'cmd-abc' }, []);
    expect(key).toBe('watch_speech:2026-05-22:cmd:cmd-abc');
  });

  it('falls back to tsMs when commandId absent', () => {
    const key = watchSpeechIdempotencyKey('2026-05-22', { tsMs: 1730000000123 }, []);
    expect(key).toBe('watch_speech:2026-05-22:ts:1730000000123');
  });

  it('falls back to a stable content hash of (text, items)', () => {
    const items = [{ name: 'Apple', quantity: 1 }];
    const a = watchSpeechIdempotencyKey('2026-05-22', { text: 'I ate an apple' }, items);
    const b = watchSpeechIdempotencyKey('2026-05-22', { text: 'I ate an apple' }, items);
    expect(a).toBe(b);
  });

  it('hashes are sensitive to text change so distinct dictations are distinct', () => {
    const a = watchSpeechIdempotencyKey('2026-05-22', { text: 'apple' }, []);
    const b = watchSpeechIdempotencyKey('2026-05-22', { text: 'orange' }, []);
    expect(a === b).toBe(false);
  });
});

describe('stableJsonHash', () => {
  it('produces the same hash regardless of key order', () => {
    expect(stableJsonHash({ a: 1, b: 2 })).toBe(stableJsonHash({ b: 2, a: 1 }));
  });

  it('drops undefined values consistently', () => {
    expect(stableJsonHash({ a: 1, b: undefined })).toBe(stableJsonHash({ a: 1 }));
  });

  it('different content → different hash', () => {
    expect(stableJsonHash({ a: 1 }) === stableJsonHash({ a: 2 })).toBe(false);
  });
});

describe('newIdempotencyKey', () => {
  it('is unique across rapid calls', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i += 1) keys.add(newIdempotencyKey());
    expect(keys.size).toBe(200);
  });

  it('respects the prefix arg', () => {
    expect(newIdempotencyKey('fav').startsWith('fav_')).toBe(true);
    expect(newIdempotencyKey('routine').startsWith('routine_')).toBe(true);
  });
});
