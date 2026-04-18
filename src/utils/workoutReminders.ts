import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const REMINDER_KEY = 'workout_reminder_settings';

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

export async function scheduleWorkoutReminder(settings: ReminderSettings): Promise<void> {
  const granted = await requestPermissions();
  if (!granted) return;

  await cancelWorkoutReminders();

  // Get user's training days from profile
  let trainingDays: number[] = [1, 2, 3, 4, 5]; // default Mon-Fri
  try {
    const raw = await AsyncStorage.getItem('userProfile');
    if (raw) {
      const profile = JSON.parse(raw);
      if (profile.trainingDays?.length) {
        trainingDays = profile.trainingDays;
      }
    }
  } catch {}

  // Schedule a notification for each training day
  for (const dow of trainingDays) {
    // expo-notifications weekday: 1=Sunday, 2=Monday, ..., 7=Saturday
    // our format: 0=Sunday, 1=Monday, ..., 6=Saturday
    const expoWeekday = dow + 1;

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Time to train',
        body: 'Your workout is ready. Let\'s go.',
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: expoWeekday,
        hour: settings.hour,
        minute: settings.minute,
      },
    });
  }
}

export async function cancelWorkoutReminders(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}
