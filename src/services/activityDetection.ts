import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ActivityCategory, CardioStyle } from '../types';
import type { ActivityVenue } from '../utils/activityVenue';
import type { LiveActivityInitialActivity } from '../utils/liveActivityQuickStart';
import type { LogActivityPrefill } from '../components/LogActivityModal';

export type DetectedActivityKind = 'walking' | 'running' | 'cycling';

export interface DetectedActivityCandidate {
  id: string;
  kind: DetectedActivityKind;
  label: string;
  category: ActivityCategory;
  subtype: string;
  cardioStyle: CardioStyle;
  venue: ActivityVenue;
  startedAtISO: string;
  detectedAtISO: string;
  elapsedSeconds: number;
  confidence: 'medium' | 'high' | string;
  source: 'core_motion';
}

type NativeDetectionEvent = {
  event?: string;
  activity?: string;
  confidence?: string;
  startedAt?: string;
  detectedAt?: string;
  elapsedSeconds?: number;
  source?: string;
};

const DISMISSED_KEY = 'activityDetectionDismissed_v1';
const DISMISSED_TTL_MS = 12 * 60 * 60 * 1000;
const PREFERENCE_KEY = 'activityDetectionEnabled_v1';

let nativeModule: any = null;
let nativeChecked = false;
const preferenceListeners = new Set<(enabled: boolean) => void>();

function getNativeModule(): any {
  if (Platform.OS !== 'ios') return null;
  if (!nativeChecked) {
    nativeChecked = true;
    try {
      nativeModule = require('../../modules/thallo-healthkit').default;
    } catch {
      nativeModule = null;
    }
  }
  return nativeModule;
}

function activitySpec(kind: DetectedActivityKind): Pick<
  DetectedActivityCandidate,
  'label' | 'category' | 'subtype' | 'cardioStyle' | 'venue'
> {
  if (kind === 'running') {
    return { label: 'Outdoor Run', category: 'cardio', subtype: 'run', cardioStyle: 'steady', venue: 'outdoor' };
  }
  if (kind === 'cycling') {
    return { label: 'Outdoor Ride', category: 'cardio', subtype: 'ride', cardioStyle: 'steady', venue: 'outdoor' };
  }
  return { label: 'Outdoor Walk', category: 'cardio', subtype: 'walk', cardioStyle: 'easy', venue: 'outdoor' };
}

function normalizedKind(value: unknown): DetectedActivityKind | null {
  if (value === 'walking' || value === 'running' || value === 'cycling') return value;
  return null;
}

function candidateId(kind: DetectedActivityKind, startedAtISO: string): string {
  const ms = new Date(startedAtISO).getTime();
  const roundedMin = Number.isFinite(ms) ? Math.round(ms / 60000) * 60000 : Date.now();
  return `motion_${kind}_${roundedMin}`;
}

function normalizeEvent(event: NativeDetectionEvent): DetectedActivityCandidate | null {
  if (event?.event !== 'detected') return null;
  const kind = normalizedKind(event.activity);
  if (!kind) return null;
  const startedAtISO = typeof event.startedAt === 'string' ? event.startedAt : new Date().toISOString();
  const detectedAtISO = typeof event.detectedAt === 'string' ? event.detectedAt : new Date().toISOString();
  const elapsedSeconds = Number(event.elapsedSeconds);
  const spec = activitySpec(kind);
  return {
    id: candidateId(kind, startedAtISO),
    kind,
    ...spec,
    startedAtISO,
    detectedAtISO,
    elapsedSeconds: Number.isFinite(elapsedSeconds) && elapsedSeconds > 0
      ? Math.round(elapsedSeconds)
      : Math.max(0, Math.round((Date.now() - new Date(startedAtISO).getTime()) / 1000)),
    confidence: typeof event.confidence === 'string' ? event.confidence : 'medium',
    source: 'core_motion',
  };
}

async function loadDismissed(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const now = Date.now();
    const next: Record<string, number> = {};
    let changed = false;
    for (const [id, value] of Object.entries(parsed)) {
      const ts = Number(value);
      if (Number.isFinite(ts) && now - ts < DISMISSED_TTL_MS) next[id] = ts;
      else changed = true;
    }
    if (changed) AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(next)).catch(() => {});
    return next;
  } catch {
    return {};
  }
}

export function isActivityDetectionAvailable(): boolean {
  const mod = getNativeModule();
  if (!mod || typeof mod.isActivityDetectionAvailable !== 'function') return false;
  try { return !!mod.isActivityDetectionAvailable(); } catch { return false; }
}

export function getActivityDetectionAuthorizationStatus(): string {
  const mod = getNativeModule();
  if (!mod || typeof mod.getActivityDetectionAuthorizationStatus !== 'function') return 'unavailable';
  try { return String(mod.getActivityDetectionAuthorizationStatus()); } catch { return 'unknown'; }
}

export async function startActivityDetection(): Promise<boolean> {
  const mod = getNativeModule();
  if (!mod || typeof mod.startActivityDetection !== 'function') return false;
  try { return !!(await mod.startActivityDetection()); } catch { return false; }
}

export function stopActivityDetection(): void {
  const mod = getNativeModule();
  if (!mod || typeof mod.stopActivityDetection !== 'function') return;
  try { mod.stopActivityDetection(); } catch {}
}

export function addActivityDetectionListener(
  listener: (candidate: DetectedActivityCandidate) => void,
): () => void {
  const mod = getNativeModule();
  if (!mod || typeof mod.addListener !== 'function') return () => {};
  const sub = mod.addListener('activityDetection', async (event: NativeDetectionEvent) => {
    const candidate = normalizeEvent(event);
    if (!candidate) return;
    if (await isDetectedActivityDismissed(candidate.id)) return;
    listener(candidate);
  });
  return () => {
    try { sub?.remove?.(); } catch {}
  };
}

export async function isDetectedActivityDismissed(id: string): Promise<boolean> {
  const dismissed = await loadDismissed();
  return dismissed[id] != null;
}

export async function dismissDetectedActivity(id: string): Promise<void> {
  const dismissed = await loadDismissed();
  dismissed[id] = Date.now();
  try { await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed)); } catch {}
}

export async function loadActivityDetectionPreference(): Promise<boolean> {
  try {
    return await AsyncStorage.getItem(PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
}

export async function saveActivityDetectionPreference(enabled: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFERENCE_KEY, enabled ? 'true' : 'false');
  } catch {}
  if (!enabled) stopActivityDetection();
  preferenceListeners.forEach((listener) => {
    try { listener(enabled); } catch {}
  });
}

export function addActivityDetectionPreferenceListener(
  listener: (enabled: boolean) => void,
): () => void {
  preferenceListeners.add(listener);
  return () => {
    preferenceListeners.delete(listener);
  };
}

export function liveActivityFromDetection(candidate: DetectedActivityCandidate): LiveActivityInitialActivity {
  return {
    category: candidate.category,
    subtype: candidate.subtype,
    label: candidate.label,
    venue: candidate.venue,
  };
}

export function logPrefillFromDetection(candidate: DetectedActivityCandidate): LogActivityPrefill {
  const startedMs = new Date(candidate.startedAtISO).getTime();
  const endedMs = Date.now();
  return {
    externalId: `live_${Number.isFinite(startedMs) ? startedMs : endedMs}`,
    dateISO: candidate.startedAtISO,
    startedAtISO: candidate.startedAtISO,
    endedAtISO: new Date(endedMs).toISOString(),
    durationMin: Math.max(1, Math.round((endedMs - (Number.isFinite(startedMs) ? startedMs : endedMs)) / 60000)),
    category: candidate.category,
    subtype: candidate.subtype,
    cardioStyle: candidate.cardioStyle,
    indoorOutdoor: candidate.venue,
    source: 'live_tracker',
  };
}
