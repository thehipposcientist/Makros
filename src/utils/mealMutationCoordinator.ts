type PendingMealLog = Promise<number | null>;

type MealIdentityLike = {
  id?: number | null;
  meal_date?: string | null;
  meal_type?: string | null;
  client_meal_key?: string | null;
  _loggedMealId?: number | null;
  logged_meal_id?: number | null;
  _localId?: string | null;
  _clientMealKey?: string | null;
};

type MutationPendingState = 'checked' | 'unchecked' | 'deleted' | 'updating';

const QUEUE_FALLBACK_KEY = 'unknown-meal';
const TOMBSTONE_TTL_MS = 10 * 60_000;

const mutationQueues = new Map<string, Promise<void>>();
const pendingMealLogs = new Map<string, PendingMealLog>();
const pendingMutations = new Map<string, { finalState: MutationPendingState; atMs: number }>();
const deleteTombstones = new Map<string, { atMs: number }>();

function nonEmpty(value: unknown): string {
  return String(value ?? '').trim();
}

function serverIdFromMeal(meal: MealIdentityLike | null | undefined): number {
  return Number(meal?._loggedMealId ?? meal?.logged_meal_id ?? meal?.id ?? 0) || 0;
}

function compactOldEntries(nowMs = Date.now()): void {
  for (const [key, row] of deleteTombstones) {
    if (nowMs - row.atMs > TOMBSTONE_TTL_MS) deleteTombstones.delete(key);
  }
}

export function mealMutationKeys(
  date: string,
  mealType: string,
  meal: MealIdentityLike | null | undefined,
): string[] {
  const keys: string[] = [];
  const serverId = serverIdFromMeal(meal);
  if (serverId > 0) keys.push(`server:${serverId}`);

  const localId = nonEmpty(meal?._localId);
  if (localId) keys.push(`local:${localId}`);

  const clientMealKey = nonEmpty(meal?._clientMealKey ?? meal?.client_meal_key);
  if (clientMealKey) keys.push(`client:${date}:${clientMealKey}`);

  keys.push(`slot:${date}:${mealType}`);
  return Array.from(new Set(keys.filter(Boolean)));
}

export function mealMutationQueueKey(
  date: string,
  mealType: string,
  meal: MealIdentityLike | null | undefined,
): string {
  return mealMutationKeys(date, mealType, meal)[0] ?? `${QUEUE_FALLBACK_KEY}:${date}:${mealType}`;
}

export function mealHistoryEntryMutationKeys(
  entry: MealIdentityLike,
  inferredCheckKey?: string | null,
): string[] {
  const date = nonEmpty(entry.meal_date);
  const keys: string[] = [];
  const serverId = serverIdFromMeal(entry);
  if (serverId > 0) keys.push(`server:${serverId}`);
  const clientMealKey = nonEmpty(entry.client_meal_key);
  if (date && clientMealKey) keys.push(`client:${date}:${clientMealKey}`);
  const inferred = nonEmpty(inferredCheckKey);
  if (date && inferred) {
    keys.push(`client:${date}:${inferred}`);
    keys.push(`slot:${date}:${inferred}`);
  }
  const mealType = nonEmpty(entry.meal_type);
  if (date && mealType) keys.push(`slot:${date}:${mealType}`);
  return Array.from(new Set(keys.filter(Boolean)));
}

export async function runMealMutation<T>(queueKey: string, fn: () => Promise<T>): Promise<T> {
  const key = nonEmpty(queueKey) || QUEUE_FALLBACK_KEY;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const next = previous.catch(() => undefined).then(() => blocker);
  mutationQueues.set(key, next);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (mutationQueues.get(key) === next) mutationQueues.delete(key);
  }
}

export function registerPendingMealLog(keys: string[], promise: PendingMealLog): void {
  for (const key of keys) {
    if (key) pendingMealLogs.set(key, promise);
  }
}

export async function resolvePendingMealLog(keys: string[]): Promise<number | null> {
  for (const key of keys) {
    const pending = pendingMealLogs.get(key);
    if (!pending) continue;
    const resolved = await pending.catch(() => null);
    if (resolved) return resolved;
  }
  return null;
}

export function clearPendingMealLog(keys: string[], promise?: PendingMealLog): void {
  for (const key of keys) {
    if (!key) continue;
    if (promise && pendingMealLogs.get(key) !== promise) continue;
    pendingMealLogs.delete(key);
  }
}

export function markMealMutationPending(keys: string[], finalState: MutationPendingState): void {
  const atMs = Date.now();
  for (const key of keys) {
    if (key) pendingMutations.set(key, { finalState, atMs });
  }
}

export function clearMealMutationPending(keys: string[]): void {
  for (const key of keys) {
    if (key) pendingMutations.delete(key);
  }
}

export function isMealMutationPending(keys: string[], finalStates?: MutationPendingState[]): boolean {
  const allowed = finalStates ? new Set(finalStates) : null;
  return keys.some(key => {
    const pending = pendingMutations.get(key);
    return !!pending && (!allowed || allowed.has(pending.finalState));
  });
}

export function markMealDeleteTombstone(keys: string[]): void {
  const atMs = Date.now();
  for (const key of keys) {
    if (key) deleteTombstones.set(key, { atMs });
  }
}

export function clearMealDeleteTombstone(keys: string[]): void {
  for (const key of keys) {
    if (key) deleteTombstones.delete(key);
  }
}

export function isMealDeleteTombstoned(keys: string[]): boolean {
  compactOldEntries();
  return keys.some(key => deleteTombstones.has(key));
}

export function shouldSkipHistoryMealForLocalMutation(keys: string[]): boolean {
  compactOldEntries();
  return isMealDeleteTombstoned(keys)
    || isMealMutationPending(keys, ['unchecked', 'deleted']);
}

export function resetMealMutationCoordinatorForTests(): void {
  mutationQueues.clear();
  pendingMealLogs.clear();
  pendingMutations.clear();
  deleteTombstones.clear();
}
