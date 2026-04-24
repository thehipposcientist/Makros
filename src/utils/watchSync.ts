// Phone-side orchestrator for the Apple Watch companion.
//
// Two responsibilities:
//   1. Push today's workout + theme to the watch whenever they change.
//   2. Subscribe to commands from the watch (Start / Skip / End / rest
//      controls) and route them into existing app actions.
//
// Everything no-ops when the bridge is unavailable (Android / missing
// module), so callers can always invoke these without a platform
// guard.

import { WatchBridge, WatchWorkoutPayload, WatchPalette, WatchProgress } from '../../modules/thallo-watch-bridge';
import { WorkoutDay, AppThemeName } from '../types';
import { getTheme } from '../constants/theme';

export type WatchExerciseClient = {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment?: string | null;
  plannedTargetWeightLbs?: number | null;
  recommendation?: string | null;
};

/** Build the compact watch payload from the full WorkoutDay. Drops
 *  all the fields (image_url, micronutrients, archetype) the watch
 *  doesn't need, so every Apple Watch transfer stays tiny. */
export function buildWatchWorkoutPayload(day: WorkoutDay | null | undefined, dateISO?: string): WatchWorkoutPayload | null {
  if (!day) return null;
  const exercises: WatchExerciseClient[] = (day.exercises ?? []).map((e: any) => ({
    name: String(e.name || 'Exercise'),
    sets: Number(e.sets || 3),
    reps: String(e.reps || ''),
    restSeconds: Number(e.restSeconds || e.rest_seconds || 60),
    equipment: e.equipment ?? null,
    plannedTargetWeightLbs: e.plannedTargetWeightLbs ?? e.weight ?? null,
    recommendation: e.recommendation ?? null,
  }));
  return {
    focus: String(day.focus || 'Workout'),
    durationMinutes: Number((day as any).durationMinutes ?? (day as any).duration ?? 60),
    dateISO: dateISO || new Date().toISOString().slice(0, 10),
    exercises,
    syncedAtMs: Date.now(),
  };
}

/** Extract the minimal watch-ready palette from the app's theme. Only
 *  the colors the SwiftUI views actually reference, so we don't blow
 *  WatchConnectivity's payload budget. */
export function buildWatchPalette(themeName: AppThemeName | undefined): WatchPalette {
  const t = getTheme(themeName).colors;
  // `success`/`warning`/`error` aren't in every color bundle at
  // compile time — fall back to midnight equivalents when absent so
  // the watch never shows a broken color.
  const fallback = { success: '#59D98E', warning: '#FFB454', error: '#FF5D73' };
  return {
    background:    String(t.background),
    surface:       String(t.surface),
    surfaceRaised: String((t as any).surfaceRaised ?? t.surface),
    primary:       String(t.primary),
    textPrimary:   String(t.textPrimary),
    textSecondary: String((t as any).textSecondary ?? t.textMuted ?? '#A8B3C7'),
    textMuted:     String((t as any).textMuted ?? '#687388'),
    success:       String((t as any).success ?? fallback.success),
    warning:       String((t as any).warning ?? fallback.warning),
    error:         String((t as any).error ?? fallback.error),
  };
}

/** Push today's workout to the watch. No-op when the bridge or a
 *  paired watch isn't available. */
export async function pushWorkoutToWatch(day: WorkoutDay | null, dateISO?: string) {
  const payload = buildWatchWorkoutPayload(day, dateISO);
  if (!payload) return false;
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;
  return WatchBridge.syncWorkout(payload);
}

/** Push the user's current theme palette to the watch. */
export async function pushThemeToWatch(themeName: AppThemeName | undefined) {
  const palette = buildWatchPalette(themeName);
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;
  return WatchBridge.syncTheme(palette);
}

/** Mid-workout progress tick. Call on set completion / rest changes /
 *  exercise transitions so the watch mirrors phone state. */
export async function pushProgressToWatch(progress: WatchProgress) {
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;
  return WatchBridge.updateProgress(progress);
}

/** Subscribe to commands the user taps on the watch. The caller wires
 *  each command into the app's existing actions (start the workout
 *  on the phone, skip today, log a set, etc.). Returns an
 *  unsubscribe function. */
export function onWatchCommand(cb: (command: string, payload: Record<string, any>) => void): () => void {
  if (!WatchBridge.isAvailable()) return () => {};
  return WatchBridge.addCommandListener(cb);
}
