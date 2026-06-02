import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import { STORAGE_KEYS } from './storageKeys';
import { isHourInQuietWindow, loadQuietHours, type QuietHoursSettings } from './notificationPrefs';
import type { TodayReadinessDecision } from './todayReadinessDecision';

export interface ReadinessNotificationSettings {
  enabled: boolean;
}

const DEFAULT_SETTINGS: ReadinessNotificationSettings = { enabled: false };
const MAX_SENT_DATES = 21;

function normalizeSettings(raw: Partial<ReadinessNotificationSettings> | null | undefined): ReadinessNotificationSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(raw ?? {}),
    enabled: raw?.enabled === true,
  };
}

function localDateISO(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
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

export async function requestReadinessNotificationPermission(): Promise<boolean> {
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

export async function loadReadinessNotificationSettings(): Promise<ReadinessNotificationSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.reminders.readinessSettings);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveReadinessNotificationSettings(settings: ReadinessNotificationSettings): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEYS.reminders.readinessSettings,
    JSON.stringify(normalizeSettings(settings)),
  );
}

function notificationContent(decision: TodayReadinessDecision, score: number): { title: string; body: string } | null {
  if (decision.kind === 'cap_intensity') {
    return { title: 'Readiness: cap intensity', body: `Score ${score}. ${decision.action}` };
  }
  if (decision.kind === 'lighten') {
    return { title: 'Readiness: lighten today', body: `Score ${score}. ${decision.action}` };
  }
  if (decision.kind === 'recovery') {
    return { title: 'Readiness: recovery fits better', body: `Score ${score}. ${decision.action}` };
  }
  if (decision.kind === 'fuel_first') {
    return { title: 'Readiness: fuel first', body: decision.action };
  }
  return null;
}

async function loadSentDates(): Promise<Record<string, true>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.reminders.readinessSentDates);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveSentDates(ids: Record<string, true>): Promise<void> {
  const trimmed = Object.keys(ids)
    .sort()
    .slice(-MAX_SENT_DATES)
    .reduce<Record<string, true>>((acc, key) => {
      acc[key] = true;
      return acc;
    }, {});
  await AsyncStorage.setItem(STORAGE_KEYS.reminders.readinessSentDates, JSON.stringify(trimmed));
}

export function shouldAttemptReadinessNotification(
  settings: ReadinessNotificationSettings,
  quietHours: QuietHoursSettings,
  decision: TodayReadinessDecision,
  now = new Date(),
): boolean {
  return settings.enabled
    && !!notificationContent(decision, 0)
    && !isHourInQuietWindow(now.getHours(), quietHours);
}

export async function maybeNotifyReadinessNudge(
  input: {
    decision: TodayReadinessDecision;
    score: number;
    label?: string | null;
    dateISO?: string | null;
  },
  now = new Date(),
): Promise<boolean> {
  const score = Math.max(0, Math.min(100, Math.round(Number(input.score) || 0)));
  const content = notificationContent(input.decision, score);
  if (!content) return false;

  const [settings, quietHours] = await Promise.all([
    loadReadinessNotificationSettings(),
    loadQuietHours(),
  ]);
  if (!shouldAttemptReadinessNotification(settings, quietHours, input.decision, now)) return false;
  if (!await notificationsAlreadyAllowed()) return false;

  const dateISO = input.dateISO || localDateISO(now);
  const sentKey = dateISO;
  const sent = await loadSentDates();
  if (sent[sentKey]) return false;

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        ...content,
        sound: 'default',
        data: {
          kind: 'readiness_nudge',
          route: 'today',
          dateISO,
          score,
          label: input.label ?? null,
          decision: input.decision.kind,
        },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: 2,
      },
    });
  } catch {
    return false;
  }

  sent[sentKey] = true;
  await saveSentDates(sent);
  return true;
}
