import AsyncStorage from '@react-native-async-storage/async-storage';

export type QueuedWatchCommand = {
  command: string;
  payload: Record<string, any>;
};

const ACTIVE_BACKLOG_KEY = 'watch_active_command_backlog_v1';
const MAX_BACKLOG = 80;
const ACTIVE_COMMAND_TTL_MS = 4 * 60 * 60_000;

const ACTIVE_COMMANDS = new Set([
  'log_set',
  'skip_rest',
  'swap_exercise',
  'add_exercise',
  'add_circuit',
  'end_workout',
  'cancel_workout',
]);

let activeConsumerCount = 0;

export function isActiveWorkoutWatchCommand(command: string): boolean {
  return ACTIVE_COMMANDS.has(command);
}

export function setActiveWatchCommandConsumerMounted(mounted: boolean): void {
  activeConsumerCount = Math.max(0, activeConsumerCount + (mounted ? 1 : -1));
}

export function hasActiveWatchCommandConsumer(): boolean {
  return activeConsumerCount > 0;
}

export async function enqueueActiveWatchCommand(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  if (!isActiveWorkoutWatchCommand(command)) return;
  const current = await loadActiveWatchCommands();
  current.push({ command, payload: payload ?? {} });
  await saveActiveWatchCommands(current);
}

export async function drainActiveWatchCommands(): Promise<QueuedWatchCommand[]> {
  const current = await loadActiveWatchCommands();
  await AsyncStorage.removeItem(ACTIVE_BACKLOG_KEY).catch(() => undefined);
  return current;
}

async function loadActiveWatchCommands(): Promise<QueuedWatchCommand[]> {
  const raw = await AsyncStorage.getItem(ACTIVE_BACKLOG_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return normalizeCommands(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

async function saveActiveWatchCommands(events: QueuedWatchCommand[]): Promise<void> {
  const compacted = normalizeCommands(events).slice(-MAX_BACKLOG);
  if (compacted.length === 0) {
    await AsyncStorage.removeItem(ACTIVE_BACKLOG_KEY).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(ACTIVE_BACKLOG_KEY, JSON.stringify(compacted)).catch(() => undefined);
}

/** Pure normalizer used by both load + save: drops events older than the
 *  4h TTL, dedupes by `commandId`, and orders by ascending `tsMs`. Exported
 *  so the dedupe / TTL invariants can be exercised directly from tests
 *  without an AsyncStorage shim. */
export function normalizeWatchCommands(events: any[], nowMs: number = Date.now()): QueuedWatchCommand[] {
  return normalizeCommandsAt(events, nowMs);
}

function normalizeCommands(events: any[]): QueuedWatchCommand[] {
  return normalizeCommandsAt(events, Date.now());
}

function normalizeCommandsAt(events: any[], nowMs: number): QueuedWatchCommand[] {
  const seen = new Set<string>();
  return events
    .map((event): QueuedWatchCommand | null => {
      const command = typeof event?.command === 'string' ? event.command : '';
      if (!isActiveWorkoutWatchCommand(command)) return null;
      const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
      const tsMs = Number(payload?.tsMs);
      if (Number.isFinite(tsMs) && tsMs > 0 && nowMs - tsMs > ACTIVE_COMMAND_TTL_MS) return null;
      return { command, payload };
    })
    .filter((event): event is QueuedWatchCommand => !!event)
    .filter((event) => {
      const id = typeof event.payload?.commandId === 'string' ? event.payload.commandId : '';
      if (!id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => {
      const at = Number(a.payload?.tsMs ?? 0);
      const bt = Number(b.payload?.tsMs ?? 0);
      return at - bt;
    });
}
