// Ring-buffered dev log capture. Wraps console.{log,warn,error,info}
// so every call ALSO lands in an in-memory buffer the app can render
// on-device — necessary because TestFlight builds have no Metro /
// Expo log console and tethering to Mac Console.app is awkward.
//
// Keeps the last 400 lines. Each entry carries a timestamp + level so
// the viewer can render them color-coded and filtered.
//
// Init is idempotent — `installDevLogs()` is safe to call from the
// app root on every mount.

type LogLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export interface DevLogEntry {
  ts: number;
  level: LogLevel;
  message: string;
}

const MAX_ENTRIES = 400;
const buffer: DevLogEntry[] = [];
let installed = false;
const listeners: Array<(entries: DevLogEntry[]) => void> = [];

function stringify(args: unknown[]): string {
  return args.map((a) => {
    if (a == null) return String(a);
    if (typeof a === 'string') return a;
    if (typeof a === 'number' || typeof a === 'boolean') return String(a);
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(' ');
}

function push(level: LogLevel, args: unknown[]): void {
  const entry: DevLogEntry = {
    ts: Date.now(),
    level,
    message: stringify(args),
  };
  buffer.push(entry);
  while (buffer.length > MAX_ENTRIES) buffer.shift();
  // Fan-out to any active viewers. Snapshot to avoid concurrent
  // mutation if a listener re-invokes into the buffer.
  const snapshot = buffer.slice();
  for (const l of listeners) {
    try { l(snapshot); } catch { /* listener errors shouldn't silence logs */ }
  }
}

/** Wrap the global console once. Safe to call repeatedly. */
export function installDevLogs(): void {
  if (installed) return;
  installed = true;
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  const origInfo = (console.info ?? console.log).bind(console);
  const origDebug = (console.debug ?? console.log).bind(console);
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => { push('log', args); origLog(...args); };
  // eslint-disable-next-line no-console
  console.warn = (...args: unknown[]) => { push('warn', args); origWarn(...args); };
  // eslint-disable-next-line no-console
  console.error = (...args: unknown[]) => { push('error', args); origError(...args); };
  // eslint-disable-next-line no-console
  console.info = (...args: unknown[]) => { push('info', args); origInfo(...args); };
  // eslint-disable-next-line no-console
  console.debug = (...args: unknown[]) => { push('debug', args); origDebug(...args); };
  push('info', ['[devLogs] capture installed']);
}

export function getDevLogs(): DevLogEntry[] {
  return buffer.slice();
}

export function clearDevLogs(): void {
  buffer.length = 0;
  for (const l of listeners) {
    try { l([]); } catch { /* ignore */ }
  }
}

export function subscribeDevLogs(cb: (entries: DevLogEntry[]) => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** Copy the whole buffer as a newline-joined string for sharing. */
export function formatDevLogs(entries: DevLogEntry[] = buffer): string {
  return entries.map(e => {
    const t = new Date(e.ts).toISOString().slice(11, 23); // HH:mm:ss.SSS
    return `${t} [${e.level}] ${e.message}`;
  }).join('\n');
}
