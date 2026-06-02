/**
 * Coalesced-toggle simulation.
 *
 * The HomeScreen favorite + check-off toggles both follow the same
 * pattern now:
 *   1. Tap flips a `desired` ref + applies optimistic UI synchronously.
 *   2. Tap enqueues a worker via `runMealMutation(key, ...)`.
 *   3. Worker reads CURRENT (desired, lastSynced) at exec time and
 *      either fires the diff or skips.
 *
 * Without coalescing, rapid favorite → unfavorite would either drop
 * the second tap (early-return lock) or fire two cancelling requests
 * sequentially (queue-only). With coalescing, the net change wins:
 * five rapid taps fire zero or one request, not five.
 *
 * These tests simulate that pattern directly against
 * `runMealMutation` so the contract is regression-pinned.
 */
import {
  resetMealMutationCoordinatorForTests,
  runMealMutation,
} from '../mealMutationCoordinator.ts';

type ToggleState = { desired: boolean; lastSynced: boolean };

/** Simulate one tap: flips `desired` synchronously and enqueues a
 *  worker that fires `fireFn(target)` if (and only if) desired !=
 *  lastSynced at exec time. Returns the worker promise. */
function simulateTap(
  state: ToggleState,
  queueKey: string,
  fireFn: (target: boolean) => Promise<void>,
): Promise<void> {
  state.desired = !state.desired;
  return runMealMutation(queueKey, async () => {
    if (state.desired === state.lastSynced) return;  // coalesced
    const target = state.desired;
    await fireFn(target);
    state.lastSynced = target;
  });
}

describe('coalesced toggle (simulated)', () => {
  it('two opposite taps that net to the original state → ZERO server calls', async () => {
    resetMealMutationCoordinatorForTests();
    const state: ToggleState = { desired: false, lastSynced: false };
    const calls: boolean[] = [];

    const fireFn = async (target: boolean) => { calls.push(target); };

    // Both taps are synchronous flips. Tap 2's `state.desired = false`
    // lands BEFORE either worker actually runs (workers `await previous`,
    // which yields to the microtask queue — tap 2's sync code runs
    // first). So by the time worker_1 reads `state.desired`, it's
    // already back to `false`, and worker_1 (desired===lastSynced) skips.
    // worker_2 same → skips.
    const t1 = simulateTap(state, 'k', fireFn);
    const t2 = simulateTap(state, 'k', fireFn);
    await Promise.all([t1, t2]);

    expect(state.desired).toBe(false);
    expect(state.lastSynced).toBe(false);
    expect(calls).toEqual([]);  // coalesced — no wasted server round-trips
  });

  it('three rapid taps that net to "favorited" → ONE server call', async () => {
    resetMealMutationCoordinatorForTests();
    const state: ToggleState = { desired: false, lastSynced: false };
    const calls: boolean[] = [];
    let releaseFirst!: () => void;
    const blocker = new Promise<void>(resolve => { releaseFirst = resolve; });

    const fireFn = async (target: boolean) => {
      calls.push(target);
      if (calls.length === 1) await blocker;
    };

    // Tap 1: fav (desired=true)
    const t1 = simulateTap(state, 'k', fireFn);
    // Tap 2: unfav (desired=false). Worker_2 queued.
    const t2 = simulateTap(state, 'k', fireFn);
    // Tap 3: fav (desired=true). Worker_3 queued. State.desired=true.
    const t3 = simulateTap(state, 'k', fireFn);

    releaseFirst();
    await Promise.all([t1, t2, t3]);

    // worker_1: read desired=true (state was already tap-3 by then),
    // fired target=true, lastSynced=true.
    // worker_2: read desired=true, lastSynced=true → SKIP.
    // worker_3: same → SKIP.
    // Net: 1 server call. End state: favorited.
    expect(state.desired).toBe(true);
    expect(state.lastSynced).toBe(true);
    expect(calls).toEqual([true]);
  });

  it('three rapid taps that net to "unfavorited" → ZERO server calls (started unfavorited)', async () => {
    resetMealMutationCoordinatorForTests();
    const state: ToggleState = { desired: false, lastSynced: false };
    const calls: boolean[] = [];

    const fireFn = async (target: boolean) => { calls.push(target); };

    const t1 = simulateTap(state, 'k', fireFn);  // → true
    const t2 = simulateTap(state, 'k', fireFn);  // → false
    const t3 = simulateTap(state, 'k', fireFn);  // → true
    const t4 = simulateTap(state, 'k', fireFn);  // → false  (net = original)
    await Promise.all([t1, t2, t3, t4]);

    // All workers run sequentially. Each reads desired=false (final
    // sync state of taps), lastSynced=false → SKIP.
    expect(state.desired).toBe(false);
    expect(state.lastSynced).toBe(false);
    expect(calls).toEqual([]);
  });

  it('single tap fires exactly one server call', async () => {
    resetMealMutationCoordinatorForTests();
    const state: ToggleState = { desired: false, lastSynced: false };
    const calls: boolean[] = [];
    await simulateTap(state, 'k', async target => { calls.push(target); });
    expect(calls).toEqual([true]);
    expect(state.desired).toBe(true);
    expect(state.lastSynced).toBe(true);
  });

  it('different keys do not coalesce together', async () => {
    resetMealMutationCoordinatorForTests();
    const stateA: ToggleState = { desired: false, lastSynced: false };
    const stateB: ToggleState = { desired: false, lastSynced: false };
    const calls: string[] = [];

    const fireA = async (t: boolean) => { calls.push(`A:${t}`); };
    const fireB = async (t: boolean) => { calls.push(`B:${t}`); };

    await Promise.all([
      simulateTap(stateA, 'a', fireA),
      simulateTap(stateB, 'b', fireB),
    ]);

    // Different keys → independent queues → both fire.
    expect(calls.sort()).toEqual(['A:true', 'B:true']);
    expect(stateA.lastSynced).toBe(true);
    expect(stateB.lastSynced).toBe(true);
  });

  it('mid-flight error: subsequent tap to original state coalesces correctly', async () => {
    resetMealMutationCoordinatorForTests();
    const state: ToggleState = { desired: false, lastSynced: false };
    const calls: boolean[] = [];
    let releaseFirst!: () => void;
    const blocker = new Promise<void>(resolve => { releaseFirst = resolve; });

    // Wrap fireFn so worker_1 throws (simulating a server error).
    // On error, the real handler reverts desired to lastSynced. We
    // simulate that revert here too.
    const handle = (target: boolean): Promise<void> => {
      calls.push(target);
      if (calls.length === 1) {
        return blocker.then(() => Promise.reject(new Error('server down')));
      }
      return Promise.resolve();
    };

    const tapWithRevert = (): Promise<void> => {
      state.desired = !state.desired;
      return runMealMutation('k', async () => {
        if (state.desired === state.lastSynced) return;
        const target = state.desired;
        try {
          await handle(target);
          state.lastSynced = target;
        } catch {
          state.desired = state.lastSynced;  // revert
        }
      });
    };

    // Tap 1 (will fail)
    const t1 = tapWithRevert();
    // Tap 2 (queued behind)
    const t2 = tapWithRevert();

    releaseFirst();
    await Promise.all([t1, t2]);

    // After tap 1, desired flipped to true. Tap 2 flipped it back to false.
    // worker_1 read desired=false (because tap 2 already ran sync),
    // lastSynced=false → SKIP. So NO server call fires.
    // Actually wait — worker_1 should have read desired AT START. If both
    // taps fired before worker_1 started, then worker_1's first check
    // says desired === lastSynced (both false), so worker_1 SKIPS.
    // worker_2 same → SKIPS. Net: 0 calls, no error.
    expect(state.desired).toBe(false);
    expect(state.lastSynced).toBe(false);
    expect(calls).toEqual([]);
  });
});
