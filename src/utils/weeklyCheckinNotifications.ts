import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const SENT_KEY = 'weekly_checkin_notification_sent_ids';

async function loadSentIds(): Promise<Record<string, true>> {
  try {
    const raw = await AsyncStorage.getItem(SENT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveSentIds(ids: Record<string, true>): Promise<void> {
  await AsyncStorage.setItem(SENT_KEY, JSON.stringify(ids));
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start || !end) return 'last week';
  const fmt = (value: string) =>
    new Date(`${value}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${fmt(start)}-${fmt(end)}`;
}

export async function maybeNotifyWeeklyCheckinDue(params: {
  planWeekId: number;
  weekStart: string | null;
  weekEnd: string | null;
}): Promise<void> {
  const key = String(params.planWeekId);
  const sent = await loadSentIds();
  if (sent[key]) return;

  const permissions = await Notifications.getPermissionsAsync();
  const allowed = permissions.granted
    || permissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!allowed) return;

  const { hourIsQuietNow } = await import('./notificationPrefs');
  if (await hourIsQuietNow(new Date().getHours())) return;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Weekly review ready',
      body: `Review ${formatDateRange(params.weekStart, params.weekEnd)} and optionally adjust future plan setup.`,
      sound: true,
      data: { kind: 'weekly_checkin', planWeekId: params.planWeekId },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 2,
    },
  });

  sent[key] = true;
  await saveSentIds(sent);
}
