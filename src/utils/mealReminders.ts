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
import { Platform } from 'react-native';

const REMINDER_KEY = 'meal_reminder_settings';
const SCHEDULED_ID_KEY = 'meal_reminder_notification_id';

export interface MealReminderSettings {
  enabled: boolean;
  hour: number;    // 0-23; default 21 (9pm)
  minute: number;  // 0-59
}

const DEFAULT_SETTINGS: MealReminderSettings = {
  enabled: true,
  hour: 21,
  minute: 0,
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

/**
 * Schedule the daily repeating reminder at the given local hour:minute.
 * Cancels any previously-scheduled reminder first so we don't stack.
 */
export async function scheduleMealReminder(settings: MealReminderSettings): Promise<void> {
  const granted = await requestPermissions();
  if (!granted) return;
  await cancelMealReminder();

  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Any meals left to log?',
      body: 'Tap to check off today\'s meals before bed.',
      sound: 'default',
      data: { route: 'meals' },
    },
    trigger: Platform.OS === 'ios'
      ? { hour: settings.hour, minute: settings.minute, repeats: true } as any
      : { hour: settings.hour, minute: settings.minute, repeats: true, channelId: 'default' } as any,
  });
  await AsyncStorage.setItem(SCHEDULED_ID_KEY, id);
}

/** Cancel the scheduled meal reminder, if any. */
export async function cancelMealReminder(): Promise<void> {
  try {
    const id = await AsyncStorage.getItem(SCHEDULED_ID_KEY);
    if (id) {
      await Notifications.cancelScheduledNotificationAsync(id).catch(() => {});
      await AsyncStorage.removeItem(SCHEDULED_ID_KEY);
    }
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
      trigger: { date: tomorrow, repeats: false } as any,
    });
    await AsyncStorage.setItem(SCHEDULED_ID_KEY, id);
    // After tomorrow's one-shot fires, we need to re-establish the repeating
    // schedule — handled on next app-open via `scheduleMealReminder` being
    // called from the HomeScreen mount effect (defensive re-schedule).
  } catch {}
}
