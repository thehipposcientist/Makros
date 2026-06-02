/**
 * Cross-cutting notification preferences shared between workout reminders,
 * meal reminders, and the rest-timer keepalive.
 *
 * Today this carries quiet hours — a do-not-disturb window during which
 * Thallo's local notifications are suppressed (workout reminder, meal log
 * reminder, hydration reminder, coaching nudges, readiness nudge, and
 * morning sleep readiness notification). Rest-timer notifications during
 * an active workout are NOT suppressed by quiet hours since they're
 * explicitly user-initiated.
 *
 * Stored in AsyncStorage so any module can read settings without having to
 * round-trip through the backend or a profile prop.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const QUIET_HOURS_KEY = 'notification_quiet_hours';

export interface QuietHoursSettings {
  enabled: boolean;
  /** Start hour (0-23, local time). Defaults to 22 (10pm). */
  startHour: number;
  /** End hour (0-23, local time). Defaults to 7 (7am). */
  endHour: number;
}

const DEFAULTS: QuietHoursSettings = { enabled: false, startHour: 22, endHour: 7 };

export async function loadQuietHours(): Promise<QuietHoursSettings> {
  try {
    const raw = await AsyncStorage.getItem(QUIET_HOURS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return DEFAULTS;
}

export async function saveQuietHours(settings: QuietHoursSettings): Promise<void> {
  await AsyncStorage.setItem(QUIET_HOURS_KEY, JSON.stringify(settings));
}

/** True when the given local hour falls inside the quiet window. Handles the
 *  overnight wrap (22 → 7 means quiet covers 22–23 AND 0–6). */
export function isHourInQuietWindow(hour: number, settings: QuietHoursSettings): boolean {
  if (!settings.enabled) return false;
  const { startHour: s, endHour: e } = settings;
  if (s === e) return false;
  // Overnight window: 22 → 7 covers 22, 23, 0, 1, ..., 6.
  if (s > e) return hour >= s || hour < e;
  // Same-day window: 14 → 16 covers 14, 15.
  return hour >= s && hour < e;
}

/** Convenience: synchronous check using the cached settings. Modules that
 *  schedule on every app open (workoutReminders, mealReminders) call
 *  `loadQuietHours` once then pass the resolved settings here. */
export async function hourIsQuietNow(hour: number): Promise<boolean> {
  return isHourInQuietWindow(hour, await loadQuietHours());
}
