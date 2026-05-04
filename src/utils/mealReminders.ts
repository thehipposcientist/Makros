/**
 * Same-day late-night meal log reminder.
 *
 * Fires a local notification in the evening if today still has unchecked
 * meals on the user's plan — a gentle nudge to log before bed rather than
 * the morning-after backfill modal.
 *
 * The reminder is scheduled daily (repeating) at `HOUR_LOCAL:MINUTE_LOCAL`.
 * On tap, the OS routes the user into the Meals tab. If the user logs
 * everything earlier in the day, the next day's reminder will find the
 * plan fully-checked and effectively be a no-op (we can't cancel a
 * daily-repeating notification PER-DAY without re-scheduling; the content
 * handler checks the plan state at fire time to decide whether to show).
 *
 * Settings are persisted so onboarding + the Reminders screen can toggle.
 */
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

const REMINDER_KEY = 'meal_reminder_settings';
const SCHEDULED_ID_KEY = 'meal_reminder_notification_id';
// Per-weekday IDs (for scheduleType !== 'every_day' or migrated state).
// Legacy single-ID rows (`SCHEDULED_ID_KEY`) are still cancelled on
// re-schedule for forward compat.
const REMINDER_IDS_KEY = 'meal_reminder_ids';

export type MealReminderScheduleType = 'every_day' | 'weekdays' | 'weekends' | 'custom';

export interface MealReminderSettings {
  enabled: boolean;
  hour: number;    // 0-23; default 21 (9pm)
  minute: number;  // 0-59
  /** Days the reminder should fire. Defaults to 'every_day' (legacy
   *  behavior). For 'custom', see `customDays`. */
  scheduleType?: MealReminderScheduleType;
  customDays?: number[];  // 0=Sun..6=Sat, only when scheduleType === 'custom'
  /** When true (default), today's reminder is auto-cancelled the moment
   *  every plan meal is checked off. */
  skipIfAllLogged?: boolean;
}

const DEFAULT_SETTINGS: MealReminderSettings = {
  enabled: true,
  hour: 21,
  minute: 0,
  scheduleType: 'every_day',
  skipIfAllLogged: true,
};

export async function loadMealReminderSettings(): Promise<MealReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_SETTINGS;
}

export async function saveMealReminderSettings(settings: MealReminderSettings): Promise<void> {
  await AsyncStorage.setItem(REMINDER_KEY, JSON.stringify(settings));
  if (settings.enabled) {
    await scheduleMealReminder(settings);
  } else {
    await cancelMealReminder();
  }
}

async function requestPermissions(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === 'granted') return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

function resolveMealDays(scheduleType: MealReminderScheduleType | undefined, customDays: number[] | undefined): number[] {
  switch (scheduleType ?? 'every_day') {
    case 'weekdays':  return [1, 2, 3, 4, 5];
    case 'weekends':  return [0, 6];
    case 'custom': {
      const days = (customDays ?? []).filter(d => d >= 0 && d <= 6);
      return days.length ? days : [0, 1, 2, 3, 4, 5, 6];
    }
    case 'every_day':
    default:           return [0, 1, 2, 3, 4, 5, 6];
  }
}

async function loadMealReminderIds(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_IDS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveMealReminderIds(ids: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(REMINDER_IDS_KEY, JSON.stringify(ids));
}

/**
 * Schedule the meal reminder. When scheduleType is 'every_day' (default)
 * we use a single daily-repeating trigger to keep iOS's notification budget
 * low. For any other type we fall back to per-weekday WEEKLY triggers so
 * the reminder honors the user's schedule.
 *
 * Cancels any previously-scheduled reminder first so we don't stack.
 */
export async function scheduleMealReminder(settings: MealReminderSettings): Promise<void> {
  const granted = await requestPermissions();
  if (!granted) return;
  // Suppress when the configured fire-time falls inside the user's quiet
  // hours window. The reminder is silently skipped — better than waking
  // users up just outside DND. They can resolve in Settings.
  const { hourIsQuietNow } = await import('./notificationPrefs');
  if (await hourIsQuietNow(settings.hour)) {
    await cancelMealReminder();
    return;
  }
  await cancelMealReminder();

  const scheduleType = settings.scheduleType ?? 'every_day';
  if (scheduleType === 'every_day') {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Any meals left to log?',
        body: 'Tap to check off today\'s meals before bed.',
        sound: 'default',
        data: { route: 'meals' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: settings.hour,
        minute: settings.minute,
        channelId: 'default',
      },
    });
    await AsyncStorage.setItem(SCHEDULED_ID_KEY, id);
    return;
  }

  // Per-weekday WEEKLY triggers — same shape workoutReminders uses.
  const days = resolveMealDays(scheduleType, settings.customDays);
  const ids: Record<string, string> = {};
  for (const dow of days) {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Any meals left to log?',
        body: 'Tap to check off today\'s meals before bed.',
        sound: 'default',
        data: { route: 'meals', dow },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: dow + 1,  // expo: 1=Sun..7=Sat
        hour: settings.hour,
        minute: settings.minute,
      },
    });
    ids[String(dow)] = id;
  }
  await saveMealReminderIds(ids);
}

/** Cancel the scheduled meal reminder, if any. Cancels both the legacy
 *  single-ID slot and any per-weekday slots from the new scheduleType paths. */
export async function cancelMealReminder(): Promise<void> {
  try {
    const id = await AsyncStorage.getItem(SCHEDULED_ID_KEY);
    if (id) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
      await AsyncStorage.removeItem(SCHEDULED_ID_KEY);
    }
  } catch {}
  try {
    const ids = await loadMealReminderIds();
    for (const id of Object.values(ids)) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
    }
    await saveMealReminderIds({});
  } catch {}
}

/**
 * Fast-path check — if today's nutrition plan is fully checked off we
 * skip the reminder entirely for today. Called from the
 * HomeScreen's meal-check handler so the user doesn't get nudged at 9pm
 * when they already logged everything by 6pm.
 *
 * NOTE: iOS doesn't support cancelling a single occurrence of a repeating
 * notification, so we "cancel today only" by cancelling the repeating
 * schedule + re-scheduling for tomorrow. Good enough for the happy path.
 */
export async function maybeCancelTodayReminder(allTodayChecked: boolean): Promise<void> {
  if (!allTodayChecked) return;
  const settings = await loadMealReminderSettings();
  if (!settings.enabled) return;
  if (settings.skipIfAllLogged === false) return;  // user opted out of auto-skip
  const now = new Date();
  const scheduledToday = new Date();
  scheduledToday.setHours(settings.hour, settings.minute, 0, 0);
  // Only act if we haven't passed 9pm yet — otherwise today's notification
  // has already fired (or is about to) and reshuffling does nothing useful.
  if (now >= scheduledToday) return;
  // Cancel + reschedule so the "next fire" lands tomorrow at the same time.
  await cancelMealReminder();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(settings.hour, settings.minute, 0, 0);
  try {
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Any meals left to log?',
        body: 'Tap to check off today\'s meals before bed.',
        sound: 'default',
        data: { route: 'meals' },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: tomorrow,
        channelId: 'default',
      },
    });
    await AsyncStorage.setItem(SCHEDULED_ID_KEY, id);
    // After tomorrow's one-shot fires, we need to re-establish the repeating
    // schedule — handled on next app-open via `scheduleMealReminder` being
    // called from the HomeScreen mount effect (defensive re-schedule).
  } catch {}
}
