import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { PendingImportEntry } from '../types';

const PENDING_IMPORT_REMINDER_IDS_KEY = 'pending_import_reminder_ids';
const REMINDER_DAYS = [3, 7] as const;
const REMINDER_HOUR = 10;

const SOURCE_LABELS: Record<string, string> = {
  myfitnesspal: 'MyFitnessPal',
  strong: 'Strong',
  strava: 'Strava',
  apple_health: 'Apple Health',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isActivePendingImport(entry: PendingImportEntry): boolean {
  return Boolean(entry.source && !entry.completed_at && !entry.dismissed_at);
}

async function loadReminderIds(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_IMPORT_REMINDER_IDS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveReminderIds(ids: Record<string, string>): Promise<void> {
  await AsyncStorage.setItem(PENDING_IMPORT_REMINDER_IDS_KEY, JSON.stringify(ids));
}

async function canScheduleNotifications(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    return existing.granted
      || existing.status === 'granted'
      || existing.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch {
    return false;
  }
}

export async function cancelPendingImportReminders(): Promise<void> {
  const ids = await loadReminderIds();
  for (const id of Object.values(ids)) {
    await Notifications.cancelScheduledNotificationAsync(id).catch(() => undefined);
  }
  await saveReminderIds({});
}

function reminderDate(requestedAt: string | undefined, days: number, now = new Date()): Date | null {
  const requested = requestedAt ? new Date(requestedAt) : now;
  const base = Number.isNaN(requested.getTime()) ? now : requested;
  const due = new Date(base);
  due.setDate(due.getDate() + days);
  due.setHours(REMINDER_HOUR, 0, 0, 0);
  return due > now ? due : null;
}

export async function schedulePendingImportReminders(entries: PendingImportEntry[] | undefined): Promise<void> {
  await cancelPendingImportReminders();

  const active = (entries ?? []).filter(isActivePendingImport).slice(0, 6);
  if (active.length === 0) return;
  if (!await canScheduleNotifications()) return;

  const ids: Record<string, string> = {};
  for (const entry of active) {
    for (const days of REMINDER_DAYS) {
      const date = reminderDate(entry.requested_at, days);
      if (!date) continue;
      const key = `${entry.source}:${days}`;
      try {
        ids[key] = await Notifications.scheduleNotificationAsync({
          content: {
            title: `Finish your ${sourceLabel(entry.source)} import`,
            body: 'Open Thallo to bring that history into your plan.',
            sound: 'default',
            data: { kind: 'pending_import_reminder', source: entry.source },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date,
            channelId: 'default',
          },
        });
      } catch {}
    }
  }
  await saveReminderIds(ids);
}
