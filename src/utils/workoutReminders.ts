import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

const REMINDER_KEY = 'workout_reminder_settings';
// Per-weekday map of scheduled notification IDs so we can cancel + re-add
// just one weekday's reminder (e.g. when the user marks today complete).
// Shape: { '0': 'id', '1': 'id', ... } where keys are 0-6 (Sun-Sat).
const REMINDER_IDS_KEY = 'workout_reminder_ids';

export type ReminderScheduleType = 'training_days' | 'every_day' | 'weekdays' | 'weekends' | 'custom';

export interface ReminderSettings {
  enabled: boolean;
  hour: number;    // 0-23
  minute: number;  // 0-59
  /** Which days the reminder fires on. Defaults to 'training_days' (the
   *  user's profile.trainingDays). Migrating older settings without this
   *  field keep the legacy training_days behavior. */
  scheduleType?: ReminderScheduleType;
  /** Required when scheduleType === 'custom'. Subset of [0,1,2,3,4,5,6]
   *  where 0=Sun. */
  customDays?: number[];
  /** Auto-cancel today's reminder if the user already completed (or
   *  skipped) the workout. Defaults true — matches prior behavior. */
  skipIfCompleted?: boolean;
}

const DEFAULT_REMINDER: ReminderSettings = {
  enabled: false, hour: 8, minute: 0,
  scheduleType: 'training_days',
  skipIfCompleted: true,
};

export async function loadReminderSettings(): Promise<ReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_KEY);
    if (raw) return { ...DEFAULT_REMINDER, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_REMINDER };
}

export async function saveReminderSettings(settings: ReminderSettings): Promise<void> {
  await AsyncStorage.setItem(REMINDER_KEY, JSON.stringify(settings));
  if (settings.enabled) {
    await scheduleWorkoutReminder(settings);
  } else {
    await cancelWorkoutReminders();
  }
}

async function requestPermissions(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

async function loadReminderIds(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_IDS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveReminderIds(ids: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify(ids));
}

function workoutReminderContent(dow: number) {
  return {
    title: 'Time to train',
    body: 'Your workout is ready. Let\'s go.',
    sound: true,
    data: { kind: 'workout_reminder', dow },
  };
}

function todaysReminderDate(settings: ReminderSettings, now = new Date()): Date {
  const d = new Date(now);
  d.setHours(settings.hour, settings.minute, 0, 0);
  return d;
}

function nextOccurrenceDate(dow: number, settings: ReminderSettings, now = new Date()): Date {
  const d = new Date(now);
  const daysUntil = ((dow - now.getDay() + 7) % 7) || 7;
  d.setDate(now.getDate() + daysUntil);
  d.setHours(settings.hour, settings.minute, 0, 0);
  return d;
}

async function todayWorkoutAlreadyHandled(): Promise<boolean> {
  try {
    const { loadWorkoutHistory, todayKey } = await import('./workoutHistory');
    const today = todayKey();
    const history = await loadWorkoutHistory();
    return history.some(s =>
      typeof s.date === 'string' &&
      s.date.startsWith(today) &&
      (s.completed || s.skipped)
    );
  } catch {
    return false;
  }
}

async function shouldSkipTodaysSlot(settings: ReminderSettings, scheduledDays: number[]): Promise<boolean> {
  if (settings.skipIfCompleted === false) return false;
  const now = new Date();
  const todayDow = now.getDay();
  if (!scheduledDays.includes(todayDow)) return false;
  if (now >= todaysReminderDate(settings, now)) return false;
  return todayWorkoutAlreadyHandled();
}

async function scheduleOneShotWorkoutReminder(dow: number, settings: ReminderSettings): Promise<string> {
  const date = nextOccurrenceDate(dow, settings);
  return Notifications.scheduleNotificationAsync({
    content: workoutReminderContent(dow),
    trigger: { date, repeats: false } as any,
  });
}

async function readTrainingDays(): Promise<number[]> {
  try {
    const raw = await AsyncStorage.getItem('userProfile');
    if (raw) {
      const profile = JSON.parse(raw);
      if (profile.trainingDays?.length) return profile.trainingDays;
    }
  } catch {}
  return [1, 2, 3, 4, 5]; // default Mon-Fri
}

/** Resolve the scheduleType + custom selection into a concrete weekday
 *  list (0=Sun .. 6=Sat). Centralized so meal + workout reminders share
 *  the same rules. */
export async function resolveScheduleDays(
  scheduleType: ReminderScheduleType | undefined,
  customDays: number[] | undefined,
): Promise<number[]> {
  switch (scheduleType ?? 'training_days') {
    case 'every_day':
      return [0, 1, 2, 3, 4, 5, 6];
    case 'weekdays':
      return [1, 2, 3, 4, 5];
    case 'weekends':
      return [0, 6];
    case 'custom': {
      const days = (customDays ?? []).filter(d => d >= 0 && d <= 6);
      return days.length ? days : [1, 2, 3, 4, 5];
    }
    case 'training_days':
    default:
      return readTrainingDays();
  }
}

export async function scheduleWorkoutReminder(settings: ReminderSettings): Promise<void> {
  const granted = await requestPermissions();
  if (!granted) return;

  // Suppress when the configured fire-time falls inside the user's quiet
  // hours window. Better to skip than reschedule to "wake them up just
  // outside DND" — the user picked this time, the conflict is theirs to
  // resolve in Settings.
  const { hourIsQuietNow } = await import('./notificationPrefs');
  if (await hourIsQuietNow(settings.hour)) {
    await cancelWorkoutReminders();
    return;
  }

  await cancelWorkoutReminders();

  const trainingDays = await resolveScheduleDays(settings.scheduleType, settings.customDays);
  const skipToday = await shouldSkipTodaysSlot(settings, trainingDays);
  const todayDow = new Date().getDay();
  const ids: Record<string, string> = {};

  // Schedule one weekly notification per training day. Per-weekday IDs are
  // tracked so `cancelTodayWorkoutReminder` can suppress just today's slot
  // (when the user already trained or skipped) without nuking next week's.
  for (const dow of trainingDays) {
    if (dow === todayDow && skipToday) {
      // A WEEKLY trigger for today's weekday would still fire today when
      // scheduled before the reminder time. Use a one-shot for next week
      // instead; HomeScreen re-establishes the weekly schedule on app open.
      try {
        ids[String(dow)] = await scheduleOneShotWorkoutReminder(dow, settings);
      } catch {}
      continue;
    }

    // expo-notifications weekday: 1=Sunday, 2=Monday, ..., 7=Saturday
    // our format: 0=Sunday, 1=Monday, ..., 6=Saturday
    const expoWeekday = dow + 1;

    const id = await Notifications.scheduleNotificationAsync({
      content: workoutReminderContent(dow),
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: expoWeekday,
        hour: settings.hour,
        minute: settings.minute,
      },
    });
    ids[String(dow)] = id;
  }
  await saveReminderIds(ids);
}

export async function cancelWorkoutReminders(): Promise<void> {
  // Targeted cancel — only the workout-reminder slots we own. The previous
  // implementation called `cancelAllScheduledNotificationsAsync` which also
  // wiped meal reminders and any pending rest-timer notifications.
  const ids = await loadReminderIds();
  for (const id of Object.values(ids)) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  await saveReminderIds({});
}

/** Cancel today's workout reminder so the user isn't pinged after they've
 *  already trained or explicitly skipped. If today's reminder time has not
 *  passed yet, replace the weekly slot with a one-shot for next week; a newly
 *  created WEEKLY trigger for today's weekday can still fire today on iOS. */
export async function cancelTodayWorkoutReminder(): Promise<void> {
  // Respect the user's opt-out FIRST so we don't cancel the slot they
  // explicitly want to keep firing today.
  const settings = await loadReminderSettings();
  if (!settings.enabled) return;
  if (settings.skipIfCompleted === false) return;

  const now = new Date();
  if (now >= todaysReminderDate(settings, now)) return;

  const todayDow = new Date().getDay();
  const ids = await loadReminderIds();
  const oldId = ids[String(todayDow)];
  if (oldId) {
    await Notifications.cancelScheduledNotificationAsync(oldId).catch(() => undefined);
    delete ids[String(todayDow)];
    await saveReminderIds(ids);
  }

  // Re-arm next week's slot only if today falls under the user's schedule.
  const trainingDays = await resolveScheduleDays(settings.scheduleType, settings.customDays);
  if (!trainingDays.includes(todayDow)) return;

  const granted = await requestPermissions();
  if (!granted) return;

  ids[String(todayDow)] = await scheduleOneShotWorkoutReminder(todayDow, settings);
  await saveReminderIds(ids);
}
