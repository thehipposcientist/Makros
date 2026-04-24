// Thin JS wrapper around ThalloWatchBridgeModule (native Swift).
//
// Phone → Watch:
//   • syncWorkout({focus, durationMinutes, exercises}) — ships today's
//     workout to the paired watch. Re-called whenever the plan changes.
//   • syncTheme({...palette}) — pushes the user's current theme colors.
//   • updateProgress({exerciseIndex, setNumber, restRemainingSec,
//                     recommendation}) — live mid-workout updates.
//
// Watch → Phone commands arrive via `addCommandListener`:
//   "start_workout", "skip_workout", "end_workout", "start_rest",
//   "skip_rest", "log_set".

import { NativeModule, requireOptionalNativeModule } from 'expo';

export type WatchExercise = {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment?: string | null;
  plannedTargetWeightLbs?: number | null;
  recommendation?: string | null;
};

export type WatchWorkoutPayload = {
  focus: string;
  durationMinutes: number;
  dateISO: string;
  exercises: WatchExercise[];
  syncedAtMs: number;
};

export type WatchPalette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  primary: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  success: string;
  warning: string;
  error: string;
};

export type WatchProgress = {
  exerciseIndex?: number;
  setNumber?: number;
  restRemainingSec?: number | null;
  heartRate?: number | null;
  recommendation?: string | null;
};

type WatchBridgeNative = {
  isAvailable(): boolean;
  isPaired(): boolean;
  isReachable(): boolean;
  syncWorkout(payload: WatchWorkoutPayload): Promise<boolean>;
  syncTheme(palette: WatchPalette): Promise<boolean>;
  updateProgress(progress: WatchProgress): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

// Optional so the module missing (e.g. on Android) doesn't crash the app.
const native = requireOptionalNativeModule<NativeModule<{
  command: (evt: { command: string; payload: Record<string, any> }) => void;
}> & WatchBridgeNative>('ThalloWatchBridgeModule');

export const WatchBridge = {
  isAvailable: () => native?.isAvailable?.() ?? false,
  isPaired:    () => native?.isPaired?.() ?? false,
  isReachable: () => native?.isReachable?.() ?? false,

  async syncWorkout(payload: WatchWorkoutPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncWorkout(payload); } catch { return false; }
  },

  async syncTheme(palette: WatchPalette): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncTheme(palette); } catch { return false; }
  },

  async updateProgress(progress: WatchProgress): Promise<boolean> {
    if (!native) return false;
    try { return await native.updateProgress(progress); } catch { return false; }
  },

  /** Listen for commands the user taps on the watch (Start / Skip /
   *  End / rest controls). Returns an unsubscribe function. */
  addCommandListener(cb: (command: string, payload: Record<string, any>) => void): () => void {
    if (!native) return () => {};
    const sub = native.addListener('command', (evt: any) => {
      if (evt && typeof evt.command === 'string') {
        cb(evt.command, evt.payload ?? {});
      }
    } as any);
    return () => { try { sub?.remove?.(); } catch {} };
  },
};
