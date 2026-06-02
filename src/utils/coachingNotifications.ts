import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import type { PlanWeekResponse } from '../services/api';
import { STORAGE_KEYS } from './storageKeys';
import { isHourInQuietWindow, loadQuietHours } from './notificationPrefs';
import { loadReminderSettings } from './workoutReminders';

const SETTINGS_KEY = STORAGE_KEYS.reminders.coachingSettings;
const PLAN_IDS_KEY = STORAGE_KEYS.reminders.coachingPlanIds;
const POST_WORKOUT_ID_KEY = STORAGE_KEYS.reminders.postWorkoutMealId;
const NEW_WEEK_SENT_KEY = STORAGE_KEYS.reminders.newPlanWeekSentIds;

export interface CoachingNotificationSettings {
  missedWorkoutEnabled: boolean;
  postWorkoutMealEnabled: boolean;
  weeklyPlanEnabled: boolean;
}

const DEFAULT_SETTINGS: CoachingNotificationSettings = {
  missedWorkoutEnabled: false,
  postWorkoutMealEnabled: false,
  weeklyPlanEnabled: false,
};

function normalizeSettings(raw: Partial<CoachingNotificationSettings> | null | undefined): CoachingNotificationSettings {
  return {
    missedWorkoutEnabled: raw?.missedWorkoutEnabled === true,
    postWorkoutMealEnabled: raw?.postWorkoutMealEnabled === true,
    weeklyPlanEnabled: raw?.weeklyPlanEnabled === true,
  };
}

function localDateKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function localDateFromISO(dateISO: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateISO);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function dateAt(dateISO: string, hour: number, minute = 0): Date | null {
  const date = localDateFromISO(dateISO);
  if (!date) return null;
  date.setHours(hour, minute, 0, 0);
  return date;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function focusLabel(workout: any | null | undefined): string {
  const focus = String(workout?.focus ?? '').trim();
  return focus || 'your workout';
}

function planIsPaused(planWeek: PlanWeekResponse, todayISO: string): boolean {
  const pausedUntil = String(planWeek.paused_until ?? '').slice(0, 10);
  return !!pausedUntil && pausedUntil >= todayISO;
}

async function notificationsAlreadyAllowed(): Promise<boolean> {
  try {
    const permissions = await Notifications.getPermissionsAsync();
    return permissions.granted
      || permissions.status === 'granted'
      || permissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch {
    return false;
  }
}

export async function requestCoachingNotificationPermission(): Promise<boolean> {
  if (await notificationsAlreadyAllowed()) return true;
  try {
    const permissions = await Notifications.requestPermissionsAsync();
    return permissions.granted
      || permissions.status === 'granted'
      || permissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch {
    return false;
  }
}

async function loadJsonRecord(key: string): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveJsonRecord(key: string, ids: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(ids));
}

async function loadSentWeeks(): Promise<Record<string, true>> {
  try {
    const raw = await AsyncStorage.getItem(NEW_WEEK_SENT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveSentWeeks(sent: Record<string, true>): Promise<void> {
  const trimmed = Object.keys(sent)
    .sort()
    .slice(-12)
    .reduce<Record<string, true>>((acc, key) => {
      acc[key] = true;
      return acc;
    }, {});
  await AsyncStorage.setItem(NEW_WEEK_SENT_KEY, JSON.stringify(trimmed));
}

export async function loadCoachingNotificationSettings(): Promise<CoachingNotificationSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveCoachingNotificationSettings(settings: CoachingNotificationSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  if (!normalized.missedWorkoutEnabled && !normalized.weeklyPlanEnabled) {
    await cancelPlanCoachingNotifications();
  }
  if (!normalized.postWorkoutMealEnabled) {
    await cancelPostWorkoutMealReminder();
  }
}

export async function cancelPlanCoachingNotifications(): Promise<void> {
  const ids = await loadJsonRecord(PLAN_IDS_KEY);
  for (const id of Object.values(ids)) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  await saveJsonRecord(PLAN_IDS_KEY, {});
}

export async function cancelPostWorkoutMealReminder(): Promise<void> {
  try {
    const id = await AsyncStorage.getItem(POST_WORKOUT_ID_KEY);
    if (id) await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  } catch {}
  await AsyncStorage.removeItem(POST_WORKOUT_ID_KEY).catch(() => undefined);
}

export async function cancelAllCoachingNotifications(): Promise<void> {
  await Promise.all([
    cancelPlanCoachingNotifications(),
    cancelPostWorkoutMealReminder(),
  ]);
}

async function maybeNotifyNewPlanWeekReady(planWeek: PlanWeekResponse, now: Date): Promise<void> {
  const todayISO = localDateKey(now);
  if (planWeek.start_date !== todayISO) return;
  if (isHourInQuietWindow(now.getHours(), await loadQuietHours())) return;

  const key = String(planWeek.id);
  const sent = await loadSentWeeks();
  if (sent[key]) return;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Your training week is ready',
      body: 'This week is queued. Open Thallo when you want to see the plan.',
      sound: 'default',
      data: { kind: 'new_plan_week_ready', route: 'workout', planWeekId: planWeek.id },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 2,
    },
  });

  sent[key] = true;
  await saveSentWeeks(sent);
}

export async function schedulePlanCoachingNotifications(params: {
  planWeek: PlanWeekResponse | null | undefined;
  completedDates?: Iterable<string>;
  skippedDates?: Iterable<string>;
  workoutsVisible?: boolean;
  now?: Date;
}): Promise<void> {
  await cancelPlanCoachingNotifications();

  const planWeek = params.planWeek;
  if (!planWeek?.days?.length || params.workoutsVisible === false) return;

  const settings = await loadCoachingNotificationSettings();
  if (!settings.missedWorkoutEnabled && !settings.weeklyPlanEnabled) return;
  if (!await notificationsAlreadyAllowed()) return;

  const now = params.now ?? new Date();
  const todayISO = localDateKey(now);
  if (planIsPaused(planWeek, todayISO)) return;

  const quietHours = await loadQuietHours();
  const ids: Record<string, string> = {};

  if (settings.missedWorkoutEnabled) {
    const completed = new Set(params.completedDates ?? []);
    const skipped = new Set(params.skippedDates ?? []);
    const today = planWeek.days.find(day => day.day_date === todayISO);
    const status = String(today?.status ?? '').toLowerCase();
    const alreadyHandled = completed.has(todayISO)
      || skipped.has(todayISO)
      || status === 'completed'
      || status === 'skipped';
    if (today && !today.is_rest && today.workout && !alreadyHandled) {
      const baseReminder = await loadReminderSettings().catch(() => ({ hour: 17, minute: 0 }));
      const base = dateAt(todayISO, baseReminder.hour ?? 17, baseReminder.minute ?? 0);
      const missedAt = base ? addMinutes(base, 180) : null;
      if (
        missedAt
        && missedAt > now
        && missedAt.getHours() < 22
        && !isHourInQuietWindow(missedAt.getHours(), quietHours)
      ) {
        ids.missedWorkout = await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Still training today?',
            body: `${focusLabel(today.workout)} is still queued. Start it or mark the day skipped.`,
            sound: 'default',
            data: { kind: 'missed_workout_nudge', route: 'workout', dateISO: todayISO, planWeekId: planWeek.id },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: missedAt,
            channelId: 'default',
          },
        });
      }
    }
  }

  if (settings.weeklyPlanEnabled) {
    const previewAt = dateAt(planWeek.end_date, 18, 0);
    if (previewAt && previewAt > now && !isHourInQuietWindow(previewAt.getHours(), quietHours)) {
      ids.weeklyPreview = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Next week is almost here',
          body: 'Your current plan wraps tonight. A fresh week will be ready after rollover.',
          sound: 'default',
          data: { kind: 'plan_week_rollover_preview', route: 'workout', planWeekId: planWeek.id },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: previewAt,
          channelId: 'default',
        },
      });
    }
    await maybeNotifyNewPlanWeekReady(planWeek, now).catch(() => undefined);
  }

  await saveJsonRecord(PLAN_IDS_KEY, ids);
}

export async function maybeSchedulePostWorkoutMealReminder(params: {
  dateISO?: string | null;
  delayMinutes?: number;
  now?: Date;
} = {}): Promise<boolean> {
  const settings = await loadCoachingNotificationSettings();
  if (!settings.postWorkoutMealEnabled) return false;
  if (!await notificationsAlreadyAllowed()) return false;

  const now = params.now ?? new Date();
  const delayMinutes = Math.max(15, Math.min(180, Math.round(params.delayMinutes ?? 45)));
  const fireAt = addMinutes(now, delayMinutes);
  const quietHours = await loadQuietHours();
  if (isHourInQuietWindow(fireAt.getHours(), quietHours)) return false;

  await cancelPostWorkoutMealReminder();

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Refuel when you can',
      body: 'Log your post-workout meal so protein and recovery stay on track.',
      sound: 'default',
      data: { kind: 'post_workout_meal_nudge', route: 'meals', dateISO: params.dateISO ?? localDateKey(now) },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireAt,
      channelId: 'default',
    },
  });
  await AsyncStorage.setItem(POST_WORKOUT_ID_KEY, id);
  return true;
}
