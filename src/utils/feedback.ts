/**
 * Haptic feedback, sounds, and vibration — centralized so every
 * interaction point uses the same settings and intensity.
 *
 * Settings are persisted in AsyncStorage under 'appSettings'.
 * Defaults: haptics ON, sounds ON, vibration ON.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Vibration } from 'react-native';

const SETTINGS_KEY = 'appSettings';

export interface AppSettings {
  hapticsEnabled: boolean;
  soundsEnabled: boolean;
  vibrationEnabled: boolean;
}

const DEFAULTS: AppSettings = {
  hapticsEnabled: true,
  soundsEnabled: true,
  vibrationEnabled: true,
};

let _cached: AppSettings = { ...DEFAULTS };

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_KEY);
    _cached = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    _cached = { ...DEFAULTS };
  }
  return _cached;
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const current = await loadSettings();
  const merged = { ...current, ...settings };
  _cached = merged;
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

// ── Haptic feedback ───────────────────────────────────────────���─

let _Haptics: typeof import('expo-haptics') | null = null;

async function getHaptics() {
  if (_Haptics) return _Haptics;
  try {
    _Haptics = await import('expo-haptics');
    return _Haptics;
  } catch {
    return null;
  }
}

export async function hapticLight() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Light).catch(() => {});
}

export async function hapticMedium() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Medium).catch(() => {});
}

export async function hapticHeavy() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.impactAsync(h.ImpactFeedbackStyle.Heavy).catch(() => {});
}

export async function hapticSuccess() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.notificationAsync(h.NotificationFeedbackType.Success).catch(() => {});
}

export async function hapticWarning() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.notificationAsync(h.NotificationFeedbackType.Warning).catch(() => {});
}

export async function hapticError() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.notificationAsync(h.NotificationFeedbackType.Error).catch(() => {});
}

export async function hapticSelection() {
  const s = await loadSettings();
  if (!s.hapticsEnabled) return;
  const h = await getHaptics();
  h?.selectionAsync().catch(() => {});
}

// ── Sound playback ──────────────────────────────────────────────

let _Audio: typeof import('expo-av').Audio | null = null;

async function getAudio() {
  if (_Audio) return _Audio;
  try {
    const av = await import('expo-av');
    _Audio = av.Audio;
    return _Audio;
  } catch {
    return null;
  }
}

export async function playRestTimerDone() {
  const s = await loadSettings();
  if (!s.soundsEnabled) return;
  try {
    const Audio = await getAudio();
    if (!Audio) return;
    // Use a system-style ding. expo-av can play from a URI or require().
    // We'll use a short built-in tone approach: create a very short beep
    // by playing a data URI or use the notification sound.
    // For now, trigger a vibration pattern as the "sound" since we don't
    // have a bundled audio file. The notification already plays a sound
    // via expo-notifications — this is the in-app fallback.
    if (s.vibrationEnabled) {
      Vibration.vibrate([0, 200, 100, 200, 100, 400]);
    }
  } catch {}
}

// ── Vibration ───────────────────────────────────────────────────

export async function vibrateShort() {
  const s = await loadSettings();
  if (!s.vibrationEnabled) return;
  if (Platform.OS === 'ios') {
    const h = await getHaptics();
    h?.impactAsync(h.ImpactFeedbackStyle.Medium).catch(() => {});
  } else {
    Vibration.vibrate(100);
  }
}

export async function vibrateLong() {
  const s = await loadSettings();
  if (!s.vibrationEnabled) return;
  Vibration.vibrate([0, 300, 100, 300]);
}

export async function vibrateRestDone() {
  const s = await loadSettings();
  if (!s.vibrationEnabled) return;
  // Strong pattern: buzz-pause-buzz-pause-long buzz
  Vibration.vibrate([0, 200, 100, 200, 100, 500]);
}
