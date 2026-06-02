const CLAIM_TTL_MS = 4 * 60 * 60_000;
const MAX_CLAIMS = 500;

const claimedWatchCommands = new Map<string, number>();

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function commandKey(command: string, payload: Record<string, any>): string | null {
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
    payload?.deltaOz ?? payload?.delta_oz ?? '',
    payload?.ounces ?? '',
  ].join(':');
}

function compactClaims(nowMs: number): void {
  for (const [key, atMs] of claimedWatchCommands) {
    if (nowMs - atMs > CLAIM_TTL_MS) claimedWatchCommands.delete(key);
  }
  while (claimedWatchCommands.size > MAX_CLAIMS) {
    const oldest = claimedWatchCommands.keys().next().value;
    if (!oldest) break;
    claimedWatchCommands.delete(oldest);
  }
}

export function claimWatchCommand(
  command: string,
  payload: Record<string, any>,
  nowMs: number = Date.now(),
): boolean {
  compactClaims(nowMs);
  const key = commandKey(command, payload ?? {});
  if (!key) return true;
  if (claimedWatchCommands.has(key)) return false;
  claimedWatchCommands.set(key, nowMs);
  return true;
}

export function resetWatchCommandClaimsForTests(): void {
  claimedWatchCommands.clear();
}
