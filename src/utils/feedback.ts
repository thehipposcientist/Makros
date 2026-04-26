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
let _restTimerSound: import('expo-av').Audio.Sound | null = null;
let _audioSessionConfigured = false;

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

/** Configure the iOS audio session ONCE per app launch so the rest-
 *  timer chime:
 *    • Plays through headphones / Bluetooth (default category does)
 *    • Plays even with the silent switch flipped (playsInSilentModeIOS)
 *    • Ducks (lowers, doesn't pause) other audio like Spotify
 *    • Doesn't take over background music — release on completion
 *  Without this the chime can be silenced by the iOS silent switch
 *  even when the user has headphones on. */
async function ensureAudioSession(Audio: typeof import('expo-av').Audio): Promise<void> {
  if (_audioSessionConfigured) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      // InterruptionMode constants: 1 = MixWithOthers (iOS / Android),
      // 2 = DuckOthers. Numeric to avoid importing the enum.
      interruptionModeIOS: 2,
      interruptionModeAndroid: 2,
      allowsRecordingIOS: false,
    } as any);
    _audioSessionConfigured = true;
  } catch {
    // Session config can fail on devices without audio hardware (rare)
    // — playback then either works at default settings or fails too.
  }
}

/** Pre-load the rest timer chime once. Called by ActiveWorkoutScreen
 *  on mount so the first set's rest end doesn't pay the load cost
 *  (a few hundred ms on a cold start). Idempotent. */
export async function preloadRestTimerSound(): Promise<void> {
  if (_restTimerSound) return;
  try {
    const Audio = await getAudio();
    if (!Audio) return;
    await ensureAudioSession(Audio);
    const { sound } = await Audio.Sound.createAsync(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../assets/sounds/rest-timer-end.wav'),
      { shouldPlay: false, volume: 1.0 },
    );
    _restTimerSound = sound;
  } catch { /* preload best-effort — playRestTimerDone re-tries the load */ }
}

export async function playRestTimerDone() {
  const s = await loadSettings();
  // Vibration runs unconditionally when enabled — it's the user's
  // backup if their phone is on silent + headphones disconnected.
  if (s.vibrationEnabled) {
    Vibration.vibrate([0, 200, 100, 200, 100, 400]);
  }
  if (!s.soundsEnabled) return;
  try {
    const Audio = await getAudio();
    if (!Audio) return;
    await ensureAudioSession(Audio);
    if (!_restTimerSound) {
      const { sound } = await Audio.Sound.createAsync(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../assets/sounds/rest-timer-end.wav'),
        { shouldPlay: false, volume: 1.0 },
      );
      _restTimerSound = sound;
    }
    // Rewind + play. replayAsync handles both (faster than stop+play).
    await _restTimerSound.replayAsync();
  } catch {
    // Any failure — silent. Vibration above already ran.
  }
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
