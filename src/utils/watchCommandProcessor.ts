// Central observability layer for the Apple Watch -> phone command
// pipeline.
//
// This is intentionally a passive RECORDER, not a dispatcher. The
// per-command handlers still live in HomeScreen / ActiveWorkoutScreen;
// relocating them into one root-level dispatcher is a deliberate
// follow-up (it requires untangling those handlers from screen state
// and is too large to bundle safely here). What this module gives us
// today is a single ring buffer that captures the full command
// lifecycle so dev / TestFlight builds can answer "did the watch tap
// reach the phone, and what happened to it?" without a debugger.
//
// Pure module — no React Native, no AsyncStorage, no native bridge —
// so it is import-safe everywhere and runs under the project's
// `--experimental-strip-types` test runner.

export type WatchCommandPhase =
  | 'received'   // command surfaced to a JS handler
  | 'deduped'    // ignored because it was already applied
  | 'dropped'    // ignored for another reason (stale, wrong user, no surface)
  | 'queued'     // deferred to a durable backlog for later replay
  | 'drained'    // replayed from a durable backlog
  | 'applied'    // command actually mutated phone / app state
  | 'snapshot';  // a phone -> watch snapshot push was attempted

export type WatchCommandSurface = 'home' | 'active' | 'root' | 'bridge';

export type WatchCommandLogEntry = {
  atMs: number;
  phase: WatchCommandPhase;
  command: string;
  surface: WatchCommandSurface;
  detail?: string;
};

export type WatchCommandLogInput = {
  phase: WatchCommandPhase;
  command: string;
  surface: WatchCommandSurface;
  detail?: string;
};

const RING_CAPACITY = 200;
const ring: WatchCommandLogEntry[] = [];
const listeners = new Set<(entry: WatchCommandLogEntry) => void>();

const isDev: boolean = (() => {
  const g = globalThis as Record<string, unknown>;
  return typeof g.__DEV__ !== 'undefined' ? !!g.__DEV__ : false;
})();

/** Record one event in the watch-command lifecycle. Cheap and always
 *  safe to call — failures in subscribers never propagate to callers. */
export function recordWatchCommandEvent(
  input: WatchCommandLogInput,
  nowMs: number = Date.now(),
): WatchCommandLogEntry {
  const entry: WatchCommandLogEntry = {
    atMs: nowMs,
    phase: input.phase,
    command: input.command || '<unknown>',
    surface: input.surface,
    ...(input.detail ? { detail: input.detail } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_CAPACITY) {
    ring.splice(0, ring.length - RING_CAPACITY);
  }
  if (isDev && !(entry.phase === 'snapshot' && entry.detail === 'FAIL bridge_unavailable')) {
    const suffix = entry.detail ? ` ${entry.detail}` : '';
    console.log(`[watch-cmd] ${entry.phase} ${entry.command} (${entry.surface})${suffix}`);
  }
  for (const listener of listeners) {
    try { listener(entry); } catch { /* observer must not break recording */ }
  }
  return entry;
}

/** Snapshot of the ring buffer, oldest first. Returns a copy so callers
 *  cannot mutate internal state. */
export function getWatchCommandLog(): WatchCommandLogEntry[] {
  return ring.slice();
}

/** Per-phase counts over the current ring buffer — handy for a quick
 *  "are watch commands landing?" health read in a debug screen. */
export function summarizeWatchCommandLog(): Record<WatchCommandPhase, number> {
  const summary: Record<WatchCommandPhase, number> = {
    received: 0, deduped: 0, dropped: 0, queued: 0, drained: 0, applied: 0, snapshot: 0,
  };
  for (const entry of ring) summary[entry.phase] += 1;
  return summary;
}

/** Subscribe to live lifecycle events (e.g. a dev overlay). Returns an
 *  unsubscribe function. */
export function subscribeWatchCommandLog(
  cb: (entry: WatchCommandLogEntry) => void,
): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Test-only: reset the ring buffer between cases. */
export function resetWatchCommandLogForTests(): void {
  ring.length = 0;
  listeners.clear();
}

export const WATCH_COMMAND_LOG_CAPACITY = RING_CAPACITY;
