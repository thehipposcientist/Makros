import AsyncStorage from '@react-native-async-storage/async-storage';

export type WatchDailyCommandName =
  | 'toggle_meal'
  | 'toggle_supplement'
  | 'take_supplement_group'
  | 'take_all_supplements';

export type QueuedDailyWatchCommand = {
  command: WatchDailyCommandName;
  payload: Record<string, any>;
};

const DAILY_BACKLOG_KEY = 'watch_daily_command_backlog_v1';
const DAILY_COMMAND_TTL_MS = 24 * 60 * 60_000;
const MAX_DAILY_BACKLOG = 100;

const DAILY_COMMANDS = new Set<WatchDailyCommandName>([
  'toggle_meal',
  'toggle_supplement',
  'take_supplement_group',
  'take_all_supplements',
]);

export function isDailyWatchCommand(command: string): command is WatchDailyCommandName {
  return DAILY_COMMANDS.has(command as WatchDailyCommandName);
}

export async function enqueueDailyWatchCommand(
  command: string,
  payload: Record<string, any>,
): Promise<void> {
  if (!isDailyWatchCommand(command)) return;
  const current = await loadDailyWatchCommands();
  current.push({ command, payload: payload ?? {} });
  await saveDailyWatchCommands(current);
}

export async function drainDailyWatchCommands(): Promise<QueuedDailyWatchCommand[]> {
  const current = await loadDailyWatchCommands();
  await AsyncStorage.removeItem(DAILY_BACKLOG_KEY).catch(() => undefined);
  return current;
}

export function normalizeDailyWatchCommands(events: any[], nowMs: number = Date.now()): QueuedDailyWatchCommand[] {
  const seen = new Set<string>();
  return events
    .map((event): QueuedDailyWatchCommand | null => {
      const command = typeof event?.command === 'string' ? event.command : '';
      if (!isDailyWatchCommand(command)) return null;
      const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
      const tsMs = Number(payload?.tsMs);
      if (Number.isFinite(tsMs) && tsMs > 0 && nowMs - tsMs > DAILY_COMMAND_TTL_MS) return null;
      return { command, payload };
    })
    .filter((event): event is QueuedDailyWatchCommand => !!event)
    .filter((event) => {
      const key = dailyCommandKey(event.command, event.payload);
      if (!key) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const at = Number(a.payload?.tsMs ?? 0);
      const bt = Number(b.payload?.tsMs ?? 0);
      return at - bt;
    })
    .slice(-MAX_DAILY_BACKLOG);
}

async function loadDailyWatchCommands(): Promise<QueuedDailyWatchCommand[]> {
  const raw = await AsyncStorage.getItem(DAILY_BACKLOG_KEY).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return normalizeDailyWatchCommands(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

async function saveDailyWatchCommands(events: QueuedDailyWatchCommand[]): Promise<void> {
  const compacted = normalizeDailyWatchCommands(events);
  if (compacted.length === 0) {
    await AsyncStorage.removeItem(DAILY_BACKLOG_KEY).catch(() => undefined);
    return;
  }
  await AsyncStorage.setItem(DAILY_BACKLOG_KEY, JSON.stringify(compacted)).catch(() => undefined);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function dailyCommandKey(command: WatchDailyCommandName, payload: Record<string, any>): string | null {
  const commandId = nullableString(payload?.commandId);
  if (commandId) return `${command}:${commandId}`;
  const tsMs = Number(payload?.tsMs);
  if (!Number.isFinite(tsMs) || tsMs <= 0) return null;
  return [
    command,
    Math.floor(tsMs),
    nullableString(payload?.userId) ?? '',
    nullableString(payload?.dateISO) ?? '',
    nullableString(payload?.mealType) ?? '',
    payload?.check ?? '',
    payload?.id ?? '',
    payload?.taken ?? '',
    nullableString(payload?.groupLabel) ?? '',
    nullableString(payload?.timing) ?? '',
  ].join(':');
}
