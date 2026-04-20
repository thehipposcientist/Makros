/**
 * Live Activity (ActivityKit) wrapper for the rest timer.
 *
 * Gated behind Platform.OS === 'ios' + iOS 16.2+ (checked in native code).
 * Gracefully degrades to a no-op on Android, older iOS, or when the user
 * has Live Activities disabled in iPhone Settings.
 */

import { Platform } from 'react-native';

export interface RestActivityState {
  exerciseName: string;
  setNumber: number;       // 0-indexed current set
  totalSets: number;
  endDateMs: number;       // absolute epoch-ms when rest ends
  nextSetRecommendation: string;
  themeColorHex: string;   // e.g. "#15C7B8"
  workoutId?: string;
}

// Lazy-load the native module so non-iOS platforms never touch it.
// Also guards against the native module being missing from the JS bundle
// (e.g. running against an older TestFlight IPA that doesn't yet have the
// ThalloLiveActivityModule compiled in). Any failure in this chain is
// recoverable — callers degrade to a silent no-op.
let nativeModule: any = null;
let loadAttempted = false;
function getNative(): any {
  if (Platform.OS !== 'ios') return null;
  if (nativeModule) return nativeModule;
  if (loadAttempted) return null;
  loadAttempted = true;
  try {
    const mod = require('../../modules/thallo-live-activity');
    nativeModule = mod?.default ?? mod ?? null;
    return nativeModule;
  } catch (e) {
    console.warn('[liveActivity] native module not available:', e);
    return null;
  }
}

export function areActivitiesEnabled(): boolean {
  const n = getNative();
  if (!n?.areActivitiesEnabled) return false;
  try { return !!n.areActivitiesEnabled(); } catch { return false; }
}

export async function startRestActivity(state: RestActivityState): Promise<string | null> {
  const n = getNative();
  if (!n?.startActivity) return null;
  try {
    const id = await n.startActivity({
      workoutId: state.workoutId ?? `workout_${Date.now()}`,
      endDateMs: state.endDateMs,
      exerciseName: state.exerciseName,
      setNumber: state.setNumber,
      totalSets: state.totalSets,
      nextSetRecommendation: state.nextSetRecommendation,
      themeColorHex: state.themeColorHex,
    });
    return id ?? null;
  } catch (e) {
    console.warn('[liveActivity] startRestActivity failed:', e);
    return null;
  }
}

export async function updateRestActivity(
  activityId: string,
  state: Partial<RestActivityState>,
): Promise<boolean> {
  const n = getNative();
  if (!n?.updateActivity) return false;
  try {
    return !!(await n.updateActivity(activityId, state));
  } catch (e) {
    console.warn('[liveActivity] updateRestActivity failed:', e);
    return false;
  }
}

export async function endRestActivity(activityId: string | null): Promise<void> {
  if (!activityId) return;
  const n = getNative();
  if (!n?.endActivity) return;
  try {
    await n.endActivity(activityId);
  } catch (e) {
    console.warn('[liveActivity] endRestActivity failed:', e);
  }
}

export async function endAllActivities(): Promise<void> {
  const n = getNative();
  if (!n?.endAllActivities) return;
  try {
    await n.endAllActivities();
  } catch {}
}
