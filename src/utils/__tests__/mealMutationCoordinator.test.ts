import {
  clearMealMutationPending,
  clearPendingMealLog,
  isMealMutationPending,
  markMealDeleteTombstone,
  markMealMutationPending,
  mealHistoryEntryMutationKeys,
  mealMutationKeys,
  mealMutationQueueKey,
  registerPendingMealLog,
  resetMealMutationCoordinatorForTests,
  resolvePendingMealLog,
  runMealMutation,
  shouldSkipHistoryMealForLocalMutation,
} from '../mealMutationCoordinator.ts';

describe('mealMutationCoordinator', () => {
  it('serializes mutations for one meal but lets different meals overlap', async () => {
    resetMealMutationCoordinatorForTests();
    const events: string[] = [];
    let releaseA: (() => void) | null = null;
    const first = runMealMutation('client:2026-05-22:a', async () => {
      events.push('a:start');
      await new Promise<void>(resolve => { releaseA = resolve; });
      events.push('a:end');
      return 'a';
    });
    const second = runMealMutation('client:2026-05-22:a', async () => {
      events.push('a2:start');
      return 'a2';
    });
    const other = runMealMutation('client:2026-05-22:b', async () => {
      events.push('b:start');
      return 'b';
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['a:start', 'b:start']);
    releaseA?.();
    await Promise.all([first, second, other]);
    expect(events).toEqual(['a:start', 'b:start', 'a:end', 'a2:start']);
  });

  it('registers and clears pending meal log ids by any meal identity key', async () => {
    resetMealMutationCoordinatorForTests();
    const keys = mealMutationKeys('2026-05-22', 'meal_1', {
      _localId: 'local-1',
      _clientMealKey: 'lunch_key',
    });
    const promise = Promise.resolve(901);
    registerPendingMealLog(keys, promise);

    expect(await resolvePendingMealLog(['client:2026-05-22:lunch_key'])).toBe(901);
    clearPendingMealLog(keys, promise);
    expect(await resolvePendingMealLog(keys)).toBeNull();
  });

  it('prefers server, local, client, then slot queue identity', () => {
    expect(mealMutationQueueKey('2026-05-22', 'meal_0', { _loggedMealId: 7 })).toBe('server:7');
    expect(mealMutationQueueKey('2026-05-22', 'meal_0', { _localId: 'abc' })).toBe('local:abc');
    expect(mealMutationQueueKey('2026-05-22', 'meal_0', { _clientMealKey: 'breakfast' })).toBe('client:2026-05-22:breakfast');
    expect(mealMutationQueueKey('2026-05-22', 'meal_0', {})).toBe('slot:2026-05-22:meal_0');
  });

  it('blocks stale history rows while an unlog/delete is pending or tombstoned', () => {
    resetMealMutationCoordinatorForTests();
    const keys = mealHistoryEntryMutationKeys({
      id: 55,
      meal_date: '2026-05-22',
      meal_type: 'breakfast',
      client_meal_key: 'breakfast_key',
    }, 'breakfast_key');

    markMealMutationPending(keys, 'unchecked');
    expect(shouldSkipHistoryMealForLocalMutation(keys)).toBe(true);
    clearMealMutationPending(keys);
    expect(shouldSkipHistoryMealForLocalMutation(keys)).toBe(false);

    markMealDeleteTombstone(keys);
    expect(shouldSkipHistoryMealForLocalMutation(keys)).toBe(true);
  });

  it('does not treat unrelated pending checked mutations as delete tombstones', () => {
    resetMealMutationCoordinatorForTests();
    const keys = ['client:2026-05-22:dinner_key'];
    markMealMutationPending(keys, 'checked');
    expect(isMealMutationPending(keys, ['checked'])).toBe(true);
    expect(shouldSkipHistoryMealForLocalMutation(keys)).toBe(false);
  });
});
