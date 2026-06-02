import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import type { HealthDataSummary } from '../services/healthDataSummary';
import { getCachedReadinessToday } from '../services/readinessCache';
import { STORAGE_KEYS } from './storageKeys';
import { loadAuthToken } from './authTokenStorage';
import { isHourInQuietWindow, loadQuietHours, type QuietHoursSettings } from './notificationPrefs';
import {
  readinessHrvMsFromSummary,
  readinessSleepHoursFromSummary,
  readinessSleepScoreFromSummary,
} from './readinessHealthSignals';
import { buildSleepScoreNotificationContent, type SleepScoreNotificationReadiness } from './sleepScoreNotificationText';
import { buildTodayReadinessDecision } from './todayReadinessDecision';

export interface SleepScoreNotificationSettings {
  enabled: boolean;
}

const DEFAULT_SETTINGS: SleepScoreNotificationSettings = { enabled: false };
const MORNING_START_HOUR = 5;
const MORNING_END_HOUR = 11;
const MAX_SENT_KEYS = 21;
const READINESS_ENRICH_TIMEOUT_MS = 2500;

function normalizeSettings(raw: Partial<SleepScoreNotificationSettings> | null | undefined): SleepScoreNotificationSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(raw ?? {}),
    enabled: raw?.enabled === true,
  };
}

function localDateISO(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isMorningWindow(now = new Date()): boolean {
  const hour = now.getHours();
  return hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
}

export function shouldAttemptSleepScoreNotification(
  settings: SleepScoreNotificationSettings,
  quietHours: QuietHoursSettings,
  now = new Date(),
): boolean {
  return settings.enabled
    && isMorningWindow(now)
    && !isHourInQuietWindow(now.getHours(), quietHours);
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

export async function requestSleepScoreNotificationPermission(): Promise<boolean> {
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

export async function loadSleepScoreNotificationSettings(): Promise<SleepScoreNotificationSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.reminders.sleepScoreSettings);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSleepScoreNotificationSettings(settings: SleepScoreNotificationSettings): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEYS.reminders.sleepScoreSettings,
    JSON.stringify(normalizeSettings(settings)),
  );
}

async function loadSentNights(): Promise<Record<string, true>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEYS.reminders.sleepScoreSentNights);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

async function saveSentNights(ids: Record<string, true>): Promise<void> {
  const trimmed = Object.keys(ids)
    .sort()
    .slice(-MAX_SENT_KEYS)
    .reduce<Record<string, true>>((acc, key) => {
      acc[key] = true;
      return acc;
    }, {});
  await AsyncStorage.setItem(STORAGE_KEYS.reminders.sleepScoreSentNights, JSON.stringify(trimmed));
}

function timeoutNull(ms: number): Promise<null> {
  return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

async function loadReadinessForNotification(
  summary: HealthDataSummary,
): Promise<SleepScoreNotificationReadiness | null> {
  const token = await loadAuthToken().catch(() => null);
  if (!token) return null;

  const readinessPromise = getCachedReadinessToday(token, {
    avgSleepHours: readinessSleepHoursFromSummary(summary),
    avgRestingHr: summary.restingHeartRate ?? null,
    avgHrvMs: readinessHrvMsFromSummary(summary),
    lastNightSleepScore: readinessSleepScoreFromSummary(summary),
    plannedFocus: null,
  }, 0).catch(() => null);
  const readiness = await Promise.race([readinessPromise, timeoutNull(READINESS_ENRICH_TIMEOUT_MS)]);
  if (!readiness || readiness.signals_present <= 0 || readiness.label === '—') return null;

  const decision = buildTodayReadinessDecision({
    score: readiness.score,
    label: readiness.label,
    missing: readiness.missing,
    signalsPresent: readiness.signals_present,
    signalsTotal: readiness.signals_total,
    hasAppleHealth: true,
  });

  return {
    score: readiness.score,
    label: readiness.label,
    action: decision.title,
  };
}

export async function maybeNotifySleepScoreReady(
  summary: HealthDataSummary | null | undefined,
  now = new Date(),
): Promise<boolean> {
  const sleepScore = summary?.raw?.sleepScore ?? null;
  if (!summary?.hkAvailable || !sleepScore) return false;

  const [settings, quietHours] = await Promise.all([
    loadSleepScoreNotificationSettings(),
    loadQuietHours(),
  ]);
  if (!shouldAttemptSleepScoreNotification(settings, quietHours, now)) return false;
  if (!await notificationsAlreadyAllowed()) return false;

  const nightKey = summary.dateISO || localDateISO(now);
  const sent = await loadSentNights();
  if (sent[nightKey]) return false;

  const readiness = await loadReadinessForNotification(summary).catch(() => null);
  const content = buildSleepScoreNotificationContent(sleepScore, readiness);
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        ...content,
        sound: 'default',
        data: {
          kind: 'sleep_score_ready',
          route: 'progress',
          dateISO: nightKey,
          score: sleepScore.score,
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

  sent[nightKey] = true;
  await saveSentNights(sent);
  return true;
}
