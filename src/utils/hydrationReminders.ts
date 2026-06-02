import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildHydrationReminderSlots,
  hydrationTargetRangeOz,
  normalizeHydrationReminderHour,
  normalizeHydrationReminderInterval,
  type HydrationReminderIntervalHours,
} from './hydration';
import { loadCachedHydration } from './hydrationCache';
import { isHourInQuietWindow, loadQuietHours } from './notificationPrefs';

const REMINDER_KEY = 'hydration_reminder_settings';
const REMINDER_IDS_KEY = 'hydration_reminder_ids';

export interface HydrationReminderSettings {
  enabled: boolean;
  startHour: number;
  endHour: number;
  intervalHours: HydrationReminderIntervalHours;
  skipIfTargetMet?: boolean;
}

const DEFAULT_SETTINGS: HydrationReminderSettings = {
  enabled: false,
  startHour: 10,
  endHour: 20,
  intervalHours: 2,
  skipIfTargetMet: true,
};

function normalizeSettings(raw: Partial<HydrationReminderSettings> | null | undefined): HydrationReminderSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(raw ?? {}),
    startHour: normalizeHydrationReminderHour(Number(raw?.startHour), DEFAULT_SETTINGS.startHour),
    endHour: normalizeHydrationReminderHour(Number(raw?.endHour), DEFAULT_SETTINGS.endHour),
    intervalHours: normalizeHydrationReminderInterval(Number(raw?.intervalHours)),
    skipIfTargetMet: raw?.skipIfTargetMet === false ? false : true,
  };
}

function localDateKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function targetMet(row: { ounces?: number | null; target_ounces?: number | null; target_ounces_min?: number | null } | null | undefined): boolean {
  const ounces = Number(row?.ounces);
  const explicitMin = Number(row?.target_ounces_min);
  const target = Number.isFinite(explicitMin) && explicitMin > 0
    ? explicitMin
    : hydrationTargetRangeOz(row?.target_ounces)?.min;
  return Number.isFinite(ounces) && typeof target === 'number' && target > 0 && ounces >= target;
}

async function todayTargetMetFromCache(): Promise<boolean> {
  const row = await loadCachedHydration(localDateKey()).catch(() => null);
  return targetMet(row);
}

async function requestPermissions(): Promise<boolean> {
  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted || existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return true;
  const next = await Notifications.requestPermissionsAsync();
  return next.granted
    || next.status === 'granted'
    || next.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
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

function nextSlotDate(slotMinute: number, forceTomorrow: boolean, now = new Date()): Date {
  const date = new Date(now);
  date.setHours(Math.floor(slotMinute / 60), slotMinute % 60, 0, 0);
  if (forceTomorrow || date <= now) date.setDate(date.getDate() + 1);
  return date;
}

function reminderContent(slotMinute: number) {
  return {
    title: 'Hydration check',
    body: 'Add a quick glass if you are behind today.',
    sound: 'default',
    data: { kind: 'hydration_reminder', route: 'meals', slotMinute },
  };
}

export async function loadHydrationReminderSettings(): Promise<HydrationReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(REMINDER_KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export async function saveHydrationReminderSettings(settings: HydrationReminderSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  await AsyncStorage.setItem(REMINDER_KEY, JSON.stringify(normalized));
  if (normalized.enabled) {
    await scheduleHydrationReminders(normalized);
  } else {
    await cancelHydrationReminders();
  }
}

export async function scheduleHydrationReminders(
  settings: HydrationReminderSettings,
  opts: { targetMetToday?: boolean } = {},
): Promise<void> {
  const normalized = normalizeSettings(settings);
  await cancelHydrationReminders();

  const granted = await requestPermissions();
  if (!granted) return;

  const quietHours = await loadQuietHours();
  // Slots are minutes-since-midnight; quiet hours are hour-granular, so
  // compare on the slot's hour component.
  const slots = buildHydrationReminderSlots(normalized)
    .filter(slotMin => !isHourInQuietWindow(Math.floor(slotMin / 60), quietHours));
  if (slots.length === 0) return;

  const targetMetToday = normalized.skipIfTargetMet === false
    ? false
    : opts.targetMetToday ?? await todayTargetMetFromCache();
  const ids: Record<string, string> = {};

  for (const slotMin of slots) {
    if (targetMetToday) {
      ids[String(slotMin)] = await Notifications.scheduleNotificationAsync({
        content: reminderContent(slotMin),
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: nextSlotDate(slotMin, true),
          channelId: 'default',
        },
      });
      continue;
    }

    ids[String(slotMin)] = await Notifications.scheduleNotificationAsync({
      content: reminderContent(slotMin),
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: Math.floor(slotMin / 60),
        minute: slotMin % 60,
        channelId: 'default',
      },
    });
  }

  await saveReminderIds(ids);
}

export async function cancelHydrationReminders(): Promise<void> {
  const ids = await loadReminderIds();
  for (const id of Object.values(ids)) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  await saveReminderIds({});
}

export async function maybeCancelTodayHydrationReminders(
  row?: { ounces?: number | null; target_ounces?: number | null; target_ounces_min?: number | null } | null,
): Promise<void> {
  const settings = await loadHydrationReminderSettings();
  if (!settings.enabled || settings.skipIfTargetMet === false) return;
  const met = row === undefined ? await todayTargetMetFromCache() : targetMet(row);
  if (!met) return;
  await scheduleHydrationReminders(settings, { targetMetToday: true });
}
