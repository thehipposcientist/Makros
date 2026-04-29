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

export type RestTimerSound = 'chime' | 'beep' | 'ping' | 'double';

export interface AppSettings {
  hapticsEnabled: boolean;
  soundsEnabled: boolean;
  vibrationEnabled: boolean;
  /** Whether the local notification scheduled for the rest timer's
   *  end plays a sound when the app is backgrounded. iOS notification
   *  sounds DUCK other audio (music / podcasts) for ~1-2s, which the
   *  user feels as "Spotify pauses for too long". Default OFF — the
   *  in-app chime mixes with music; the background notification still
   *  vibrates + shows a banner, just silently. */
  restNotificationSoundEnabled: boolean;
  /** Which sound plays when the rest timer ends. Defaults to 'chime'
   *  (the original bell tone). Options: chime, beep, ping, double. */
  restTimerSound: RestTimerSound;
}

const DEFAULTS: AppSettings = {
  hapticsEnabled: true,
  soundsEnabled: true,
  vibrationEnabled: true,
  restNotificationSoundEnabled: false,
  restTimerSound: 'chime',
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
// Keyed by sound name so switching sounds forces a fresh load.
const _soundCache: Partial<Record<RestTimerSound, import('expo-av').Audio.Sound>> = {};
let _audioSessionConfigured = false;

function getSoundAsset(name: RestTimerSound) {
  // require() must be static — bundler resolves at build time.
  switch (name) {
    case 'beep':   return require('../../assets/sounds/rest-timer-beep.wav');
    case 'ping':   return require('../../assets/sounds/rest-timer-ping.wav');
    case 'double': return require('../../assets/sounds/rest-timer-double.wav');
    default:       return require('../../assets/sounds/rest-timer-end.wav');
  }
}

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
 *    • Plays through headphones / Bluetooth
 *    • Plays even with the silent switch flipped (playsInSilentModeIOS)
 *    • MIXES with other audio (Spotify keeps playing at full volume) —
 *      we do NOT duck. Was the source of "sound takes over too long":
 *      ducking holds Spotify down for ~1s after our 0.45s chime ends.
 *    • staysActiveInBackground: true so the chime can fire if the
 *      screen turns off between rest start and rest end. The bigger
 *      background-sound path is the scheduled local notification in
 *      restNotifications.ts (which also works without UIBackgroundModes). */
async function ensureAudioSession(Audio: typeof import('expo-av').Audio): Promise<void> {
  if (_audioSessionConfigured) return;
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
      shouldDuckAndroid: false,
      playThroughEarpieceAndroid: false,
      // 1 = MixWithOthers, 2 = DuckOthers. We mix so podcasts / music
      // keep playing at full volume; our chime layers on top briefly.
      interruptionModeIOS: 1,
      interruptionModeAndroid: 1,
      allowsRecordingIOS: false,
    } as any);
    _audioSessionConfigured = true;
  } catch {
    // Session config can fail on devices without audio hardware (rare)
    // — playback then either works at default settings or fails too.
  }
}

/** Pre-load the currently configured rest timer sound. Called by
 *  ActiveWorkoutScreen on mount so the first rest end doesn't pay the
 *  load cost. If the user changes the sound mid-session the new file
 *  is loaded lazily on the next play. */
export async function preloadRestTimerSound(): Promise<void> {
  try {
    const Audio = await getAudio();
    if (!Audio) return;
    await ensureAudioSession(Audio);
    const s = await loadSettings();
    const name = s.restTimerSound ?? 'chime';
    if (_soundCache[name]) return;
    const { sound } = await Audio.Sound.createAsync(
      getSoundAsset(name),
      { shouldPlay: false, volume: 1.0 },
    );
    _soundCache[name] = sound;
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
    const name = s.restTimerSound ?? 'chime';
    if (!_soundCache[name]) {
      const { sound } = await Audio.Sound.createAsync(
        getSoundAsset(name),
        { shouldPlay: false, volume: 1.0 },
      );
      _soundCache[name] = sound;
    }
    await _soundCache[name]!.replayAsync();
  } catch {
    // Any failure — silent. Vibration above already ran.
  }
}

// ── Background audio keepalive ──────────────────────────────────
// iOS suspends the JS runtime when no audio session is active, so a
// setInterval-based rest countdown stops firing when the user switches
// away. Playing a 0-volume silent loop during the rest period keeps
// UIBackgroundModes:audio alive — the interval then fires at t=0 and
// calls playRestTimerDone() mixed with music (no ducking).

let _keepaliveSound: import('expo-av').Audio.Sound | null = null;

export async function startRestTimerKeepalive(): Promise<void> {
  try {
    const Audio = await getAudio();
    if (!Audio) return;
    await ensureAudioSession(Audio);
    if (_keepaliveSound) {
      await _keepaliveSound.stopAsync().catch(() => {});
      await _keepaliveSound.unloadAsync().catch(() => {});
      _keepaliveSound = null;
    }
    const { sound } = await Audio.Sound.createAsync(
      require('../../assets/sounds/rest-timer-silence.wav'),
      { shouldPlay: true, isLooping: true, volume: 0 },
    );
    _keepaliveSound = sound;
  } catch { /* keepalive is best-effort — notification is the hard fallback */ }
}

export async function stopRestTimerKeepalive(): Promise<void> {
  if (!_keepaliveSound) return;
  try {
    await _keepaliveSound.stopAsync();
    await _keepaliveSound.unloadAsync();
  } catch {}
  _keepaliveSound = null;
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
