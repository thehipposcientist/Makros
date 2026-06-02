// Local "staleness" reminders — nudge the user when an activity they
// care about hasn't been logged in a while ("you haven't done deadlifts
// in 12 days"). Entirely device-local: no backend, no push tokens.
//
// expo-notifications can only *schedule* notifications, not run code in
// the background, so the mechanic is: each evaluation cancels the old
// staleness notifications and re-schedules a one-shot per watched term
// for the date it will go stale (last-logged + threshold). Even if the
// user never reopens the app the notification still fires; reopening
// re-evaluates against fresh workout history and reschedules.
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WorkoutSession } from '../types';
import { loadWorkoutHistory } from './workoutHistory';
import { lastLoggedDateForQuery } from './workoutHistorySearch';

const WATCH_KEY = 'staleness_watches';
const WATCH_IDS_KEY = 'staleness_watch_ids';

/** Reminder fires at this local hour on the day a watch goes stale. */
const REMINDER_HOUR = 18;
/** Default days-of-inactivity before a nudge, when the caller doesn't
 *  specify one. */
export const DEFAULT_STALENESS_DAYS = 10;
/** Hard cap so the watch list can't exhaust the iOS pending-notification
 *  budget alongside the other reminder types. */
const MAX_WATCHES = 20;

export interface StalenessWatch {
  /** Free-text term matched against exercise names / focus / activity,
   *  e.g. "deadlift", "leg day", "zone 2". */
  term: string;
  /** Notify when the term hasn't been logged in this many days. */
  thresholdDays: number;
  /** ISO timestamp the watch was created — used as the staleness anchor
   *  when the term has never been logged yet. */
  addedAt: string;
}

export async function loadStalenessWatches(): Promise<StalenessWatch[]> {
  try {
    const raw = await AsyncStorage.getItem(WATCH_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(w => w && typeof w.term === 'string' && w.term.trim())
      .map(w => ({
        term: String(w.term).trim(),
        thresholdDays: Number(w.thresholdDays) > 0 ? Number(w.thresholdDays) : DEFAULT_STALENESS_DAYS,
        addedAt: typeof w.addedAt === 'string' ? w.addedAt : new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

async function saveStalenessWatches(watches: StalenessWatch[]): Promise<void> {
  await AsyncStorage.setItem(WATCH_KEY, JSON.stringify(watches.slice(0, MAX_WATCHES)));
}

/** Add (or refresh) a watched term. Terms are case-insensitively unique;
 *  re-adding moves the term to the front. Returns the updated list. */
export async function addStalenessWatch(
  term: string,
  thresholdDays: number = DEFAULT_STALENESS_DAYS,
): Promise<StalenessWatch[]> {
  const clean = term.trim();
  if (!clean) return loadStalenessWatches();
  const key = clean.toLowerCase();
  const existing = await loadStalenessWatches();
  const next: StalenessWatch[] = [
    { term: clean, thresholdDays, addedAt: new Date().toISOString() },
    ...existing.filter(w => w.term.toLowerCase() !== key),
  ].slice(0, MAX_WATCHES);
  await saveStalenessWatches(next);
  await evaluateStalenessReminders();
  return next;
}

/** Remove a watched term (case-insensitive). Returns the updated list. */
export async function removeStalenessWatch(term: string): Promise<StalenessWatch[]> {
  const key = term.trim().toLowerCase();
  const existing = await loadStalenessWatches();
  const next = existing.filter(w => w.term.toLowerCase() !== key);
  await saveStalenessWatches(next);
  await evaluateStalenessReminders();
  return next;
}

async function requestPermissions(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted || existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return true;
  const next = await Notifications.requestPermissionsAsync();
  return next.granted
    || next.status === 'granted'
    || next.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

async function loadWatchIds(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(WATCH_IDS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveWatchIds(ids: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(WATCH_IDS_KEY, JSON.stringify(ids));
}

async function cancelScheduledWatches(): Promise<void> {
  const ids = await loadWatchIds();
  for (const id of Object.values(ids)) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  await saveWatchIds({});
}

/** Next occurrence of REMINDER_HOUR:00 local time, strictly in the future. */
function nextReminderHourDate(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(REMINDER_HOUR, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

/** The date a watch goes stale: anchor (last-logged date, or the date
 *  the watch was created if never logged) + thresholdDays, at REMINDER_HOUR. */
function staleDate(watch: StalenessWatch, lastLogged: string | null): Date {
  const anchor = new Date(lastLogged ?? watch.addedAt);
  const due = new Date(Number.isNaN(anchor.getTime()) ? Date.now() : anchor.getTime());
  due.setDate(due.getDate() + Math.max(1, Math.round(watch.thresholdDays)));
  due.setHours(REMINDER_HOUR, 0, 0, 0);
  return due;
}

/** Re-schedule the staleness notifications from the current watch list +
 *  workout history. Safe to call often — it cancels and rebuilds every
 *  time. `history` may be passed in by a caller that already has it
 *  loaded; otherwise it's read from local storage. */
export async function evaluateStalenessReminders(history?: WorkoutSession[]): Promise<void> {
  await cancelScheduledWatches();

  const watches = await loadStalenessWatches();
  if (watches.length === 0) return;

  const granted = await requestPermissions();
  if (!granted) return;

  const sessions = history ?? await loadWorkoutHistory();
  const now = new Date();
  const ids: Record<string, string> = {};

  for (const watch of watches) {
    const lastLogged = lastLoggedDateForQuery(sessions, watch.term);
    const due = staleDate(watch, lastLogged);
    // If the term is already stale, nudge at the next 6pm rather than
    // in the past; otherwise fire exactly on the day it goes stale.
    const fireDate = due > now ? due : nextReminderHourDate(now);
    try {
      ids[watch.term.toLowerCase()] = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Time to get back to it',
          body: `You haven't logged ${watch.term} in a while — worth fitting in soon?`,
          sound: 'default',
          data: { kind: 'staleness_reminder', term: watch.term },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireDate,
          channelId: 'default',
        },
      });
    } catch {
      // Non-fatal — one bad schedule shouldn't drop the rest.
    }
  }

  await saveWatchIds(ids);
}
