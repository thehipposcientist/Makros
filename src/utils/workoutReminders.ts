import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

const REMINDER_KEY = 'workout_reminder_settings';
// Per-weekday map of scheduled notification IDs so we can cancel + re-add
// just one weekday's reminder (e.g. when the user marks today complete).
// Shape: { '0': 'id', '1': 'id', ... } where keys are 0-6 (Sun-Sat).
const REMINDER_IDS_KEY = 'workout_reminder_ids';

export interface ReminderSettings {
  enabled: boolean;
  hour: number;    // 0-23
  minute: number;  // 0-59
}

export async function loadReminderSettings(): Promise<ReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { enabled: false, hour: 8, minute: 0 };
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

export async function scheduleWorkoutReminder(settings: ReminderSettings): Promise<void> {
  const granted = await requestPermissions();
  if (!granted) return;

  await cancelWorkoutReminders();

  const trainingDays = await readTrainingDays();
  const ids: Record<string, string> = {};

  // Schedule one weekly notification per training day. Per-weekday IDs are
  // tracked so `cancelTodayWorkoutReminder` can suppress just today's slot
  // (when the user already trained or skipped) without nuking next week's.
  for (const dow of trainingDays) {
    // expo-notifications weekday: 1=Sunday, 2=Monday, ..., 7=Saturday
    // our format: 0=Sunday, 1=Monday, ..., 6=Saturday
    const expoWeekday = dow + 1;

    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Time to train',
        body: 'Your workout is ready. Let\'s go.',
        sound: true,
        data: { kind: 'workout_reminder', dow },
      },
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
 *  already trained or explicitly skipped. The WEEKLY repeat for that weekday
 *  is then re-scheduled, which iOS aims at the next occurrence — typically
 *  next week (the common case where the user marks done AFTER the reminder
 *  has already fired). Edge case: if the user marks done before today's
 *  reminder time, the rescheduled WEEKLY may still fire today — acceptable
 *  vs. the complexity of skipping a single first-fire occurrence. */
export async function cancelTodayWorkoutReminder(): Promise<void> {
  const todayDow = new Date().getDay();
  const ids = await loadReminderIds();
  const oldId = ids[String(todayDow)];
  if (oldId) {
    await Notifications.cancelScheduledNotificationAsync(oldId).catch(() => undefined);
    delete ids[String(todayDow)];
    await saveReminderIds(ids);
  }

  // Only re-schedule if the user still wants reminders AND today is a
  // training day. Otherwise leave the slot empty.
  const settings = await loadReminderSettings();
  if (!settings.enabled) return;
  const trainingDays = await readTrainingDays();
  if (!trainingDays.includes(todayDow)) return;

  const granted = await requestPermissions();
  if (!granted) return;

  const expoWeekday = todayDow + 1;
  const newId = await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Time to train',
      body: 'Your workout is ready. Let\'s go.',
      sound: true,
      data: { kind: 'workout_reminder', dow: todayDow },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
      weekday: expoWeekday,
      hour: settings.hour,
      minute: settings.minute,
    },
  });
  ids[String(todayDow)] = newId;
  await saveReminderIds(ids);
}
