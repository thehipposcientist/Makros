import type { InjuryEntry } from '../types';

export const INJURY_CHECKIN_STORAGE_KEY = 'injury_checkins_v1';
export const DEFAULT_INJURY_CHECKIN_INTERVAL_DAYS = 7;
export const DEFAULT_INJURY_CHECKIN_DISMISS_DAYS = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type InjuryCheckinResponse = 'keep_protected' | 'improving' | 'resolved';

export type InjuryCheckinState = Record<string, {
  lastPromptedAt?: string;
  lastAnsweredAt?: string;
  snoozedUntil?: string;
}>;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed);
}

export function dateOnly(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function injuryCheckinKey(entry: InjuryEntry): string {
  const fallback = [
    entry.bodyPart,
    entry.description,
    entry.reportedAt,
  ].map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean).join('|');
  return entry.id || fallback;
}

export function parseInjuryCheckinState(raw: string | null | undefined): InjuryCheckinState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as InjuryCheckinState;
  } catch {
    return {};
  }
}

export function activeInjuryEntries(entries: InjuryEntry[] | null | undefined): InjuryEntry[] {
  return (entries ?? []).filter(entry => entry.status === 'active' || entry.status === 'recovering');
}

export function findDueInjuryCheckins(
  entries: InjuryEntry[] | null | undefined,
  state: InjuryCheckinState = {},
  now: Date = new Date(),
  intervalDays: number = DEFAULT_INJURY_CHECKIN_INTERVAL_DAYS,
): InjuryEntry[] {
  const today = startOfDay(now);
  return activeInjuryEntries(entries).filter(entry => {
    const key = injuryCheckinKey(entry);
    const entryState = state[key] ?? {};
    const snoozedUntil = parseDate(entryState.snoozedUntil);
    if (snoozedUntil && snoozedUntil >= today) return false;

    const lastAnswered = parseDate(entryState.lastAnsweredAt);
    if (lastAnswered && (today.getTime() - lastAnswered.getTime()) / MS_PER_DAY < intervalDays) return false;

    const recoveryDate = parseDate(entry.estimatedRecoveryDate);
    if (recoveryDate && recoveryDate <= today) return true;

    const lastStatusTouch = parseDate(entry.statusUpdatedAt) ?? parseDate(entry.reportedAt);
    if (!lastStatusTouch) return true;
    return (today.getTime() - lastStatusTouch.getTime()) / MS_PER_DAY >= intervalDays;
  });
}

export function markInjuryCheckinsAnswered(
  state: InjuryCheckinState,
  entries: InjuryEntry[],
  now: Date = new Date(),
  snoozeDays: number = DEFAULT_INJURY_CHECKIN_INTERVAL_DAYS,
): InjuryCheckinState {
  const next: InjuryCheckinState = { ...state };
  const answeredAt = now.toISOString();
  const snoozedUntil = dateOnly(addDays(now, snoozeDays));
  for (const entry of entries) {
    const key = injuryCheckinKey(entry);
    next[key] = {
      ...(next[key] ?? {}),
      lastAnsweredAt: answeredAt,
      snoozedUntil,
    };
  }
  return next;
}

export function markInjuryCheckinsPrompted(
  state: InjuryCheckinState,
  entries: InjuryEntry[],
  now: Date = new Date(),
  snoozeDays: number = DEFAULT_INJURY_CHECKIN_DISMISS_DAYS,
): InjuryCheckinState {
  const next: InjuryCheckinState = { ...state };
  const promptedAt = now.toISOString();
  const snoozedUntil = dateOnly(addDays(now, snoozeDays));
  for (const entry of entries) {
    const key = injuryCheckinKey(entry);
    next[key] = {
      ...(next[key] ?? {}),
      lastPromptedAt: promptedAt,
      snoozedUntil,
    };
  }
  return next;
}

export function applyInjuryCheckinResponse(
  entries: InjuryEntry[] | null | undefined,
  entryIds: string[],
  response: InjuryCheckinResponse,
  now: Date = new Date(),
): InjuryEntry[] {
  if (response === 'keep_protected') return [...(entries ?? [])];
  const selected = new Set(entryIds);
  const statusUpdatedAt = now.toISOString();
  return (entries ?? []).map(entry => {
    if (!selected.has(entry.id)) return entry;
    return {
      ...entry,
      status: response === 'resolved' ? 'resolved' : 'recovering',
      statusUpdatedAt,
    };
  });
}
