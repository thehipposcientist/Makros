// Tests for the watch-command observability ring buffer.
//
// The processor is a passive recorder for the Apple Watch -> phone
// command lifecycle. These cases lock the invariants the rest of the
// app relies on: bounded memory, copy-on-read, accurate per-phase
// counts, and live subscriber delivery.

import {
  recordWatchCommandEvent,
  getWatchCommandLog,
  summarizeWatchCommandLog,
  subscribeWatchCommandLog,
  resetWatchCommandLogForTests,
  WATCH_COMMAND_LOG_CAPACITY,
  type WatchCommandLogEntry,
} from '../watchCommandProcessor.ts';

describe('watchCommandProcessor', () => {
  it('records an event with a timestamp and the supplied fields', () => {
    resetWatchCommandLogForTests();
    recordWatchCommandEvent({ phase: 'received', command: 'log_set', surface: 'active' }, 1000);
    const log = getWatchCommandLog();
    expect(log.length).toBe(1);
    expect(log[0].phase).toBe('received');
    expect(log[0].command).toBe('log_set');
    expect(log[0].surface).toBe('active');
    expect(log[0].atMs).toBe(1000);
  });

  it('falls back to <unknown> for an empty command name', () => {
    resetWatchCommandLogForTests();
    recordWatchCommandEvent({ phase: 'dropped', command: '', surface: 'home' });
    expect(getWatchCommandLog()[0].command).toBe('<unknown>');
  });

  it('keeps the ring buffer bounded at capacity, dropping the oldest', () => {
    resetWatchCommandLogForTests();
    const overflow = WATCH_COMMAND_LOG_CAPACITY + 50;
    for (let i = 0; i < overflow; i += 1) {
      recordWatchCommandEvent({ phase: 'received', command: `cmd_${i}`, surface: 'bridge' }, i);
    }
    const log = getWatchCommandLog();
    expect(log.length).toBe(WATCH_COMMAND_LOG_CAPACITY);
    // The oldest 50 entries were evicted — first surviving entry is cmd_50.
    expect(log[0].command).toBe('cmd_50');
    expect(log[log.length - 1].command).toBe(`cmd_${overflow - 1}`);
  });

  it('returns a defensive copy that cannot mutate internal state', () => {
    resetWatchCommandLogForTests();
    recordWatchCommandEvent({ phase: 'applied', command: 'start_workout', surface: 'home' });
    const log = getWatchCommandLog();
    log.push({ atMs: 0, phase: 'dropped', command: 'fake', surface: 'root' });
    expect(getWatchCommandLog().length).toBe(1);
  });

  it('summarizes per-phase counts across the buffer', () => {
    resetWatchCommandLogForTests();
    recordWatchCommandEvent({ phase: 'received', command: 'log_set', surface: 'active' });
    recordWatchCommandEvent({ phase: 'received', command: 'skip_rest', surface: 'active' });
    recordWatchCommandEvent({ phase: 'applied', command: 'log_set', surface: 'active' });
    recordWatchCommandEvent({ phase: 'deduped', command: 'log_set', surface: 'active' });
    const summary = summarizeWatchCommandLog();
    expect(summary.received).toBe(2);
    expect(summary.applied).toBe(1);
    expect(summary.deduped).toBe(1);
    expect(summary.dropped).toBe(0);
  });

  it('delivers live events to subscribers and stops after unsubscribe', () => {
    resetWatchCommandLogForTests();
    const seen: WatchCommandLogEntry[] = [];
    const unsub = subscribeWatchCommandLog((e) => seen.push(e));
    recordWatchCommandEvent({ phase: 'queued', command: 'log_set', surface: 'bridge' });
    expect(seen.length).toBe(1);
    expect(seen[0].command).toBe('log_set');
    unsub();
    recordWatchCommandEvent({ phase: 'drained', command: 'log_set', surface: 'bridge' });
    expect(seen.length).toBe(1);
  });

  it('isolates a throwing subscriber from the recording path', () => {
    resetWatchCommandLogForTests();
    subscribeWatchCommandLog(() => { throw new Error('observer blew up'); });
    recordWatchCommandEvent({ phase: 'received', command: 'pull_state', surface: 'root' });
    expect(getWatchCommandLog().length).toBe(1);
  });
});
