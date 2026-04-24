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

import { requireOptionalNativeModule } from 'expo';

export type WatchExercise = {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment?: string | null;
  plannedTargetWeightLbs?: number | null;
  recommendation?: string | null;
};

export type WatchWorkoutStatus = 'scheduled' | 'active' | 'completed' | 'skipped' | 'rest';

export type WatchWorkoutPayload = {
  focus: string;
  durationMinutes: number;
  dateISO: string;
  status: WatchWorkoutStatus;
  readiness: number | null;
  readinessLabel: string | null;
  exercises: WatchExercise[];
  /** Plain-text warm-up bullets. Shown on the watch before the first
   *  exercise as a dismissable card so users can cue off them without
   *  pulling the phone out. Empty / undefined = no card. */
  warmupSteps?: string[];
  syncedAtMs: number;
};

export type WatchMealItem = {
  mealType: string;
  name: string;
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  checked: boolean;
};

export type WatchMealsPayload = {
  dateISO: string;
  targets: { calories: number; proteinG: number; carbsG: number; fatG: number };
  actual:  { calories: number; proteinG: number; carbsG: number; fatG: number };
  score: number | null;
  meals: WatchMealItem[];
  syncedAtMs: number;
};

export type WatchSupplementItem = {
  id: number;
  name: string;
  dose?: string | null;
  timing?: string | null;
  taken: boolean;
  skipped: boolean;
};

export type WatchSupplementsPayload = {
  dateISO: string;
  items: WatchSupplementItem[];
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

// Loose typing on the native module — Expo's NativeModule generic
// types + `as any` were fighting Metro's babel parser. Keeping this
// minimal means no parser gymnastics, and the public `WatchBridge`
// object below provides the type-safe surface callers actually use.
const native: any = requireOptionalNativeModule('ThalloWatchBridgeModule');

export const WatchBridge = {
  isAvailable: (): boolean => !!native?.isAvailable?.(),
  isPaired:    (): boolean => !!native?.isPaired?.(),
  isReachable: (): boolean => !!native?.isReachable?.(),

  async syncWorkout(payload: WatchWorkoutPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncWorkout(payload); } catch { return false; }
  },

  async syncTheme(palette: WatchPalette): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncTheme(palette); } catch { return false; }
  },

  async syncMeals(payload: WatchMealsPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncMeals(payload); } catch { return false; }
  },

  async syncSupplements(payload: WatchSupplementsPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncSupplements(payload); } catch { return false; }
  },

  async updateProgress(progress: WatchProgress): Promise<boolean> {
    if (!native) return false;
    try { return await native.updateProgress(progress); } catch { return false; }
  },

  /** Listen for commands the user taps on the watch (Start / Skip /
   *  End / rest controls). Returns an unsubscribe function. */
  addCommandListener(
    cb: (command: string, payload: Record<string, any>) => void,
  ): () => void {
    if (!native) return () => {};
    const handler = (evt: { command?: string; payload?: Record<string, any> }) => {
      if (evt && typeof evt.command === 'string') {
        cb(evt.command, evt.payload ?? {});
      }
    };
    const sub = native.addListener('command', handler);
    return () => {
      try { sub?.remove?.(); } catch { /* no-op */ }
    };
  },

  /** Fires whenever WCSession reachability flips (watch app opened /
   *  closed) or on initial session activation. Callers use this to
   *  re-push the current state snapshot so the watch wakes up with
   *  fresh data instead of whatever was queued last. */
  addReachabilityListener(
    cb: (info: { reachable: boolean; paired: boolean; installed: boolean }) => void,
  ): () => void {
    if (!native) return () => {};
    const handler = (evt: { reachable?: boolean; paired?: boolean; installed?: boolean }) => {
      cb({
        reachable: !!evt?.reachable,
        paired: !!evt?.paired,
        installed: !!evt?.installed,
      });
    };
    const sub = native.addListener('reachabilityChanged', handler);
    return () => {
      try { sub?.remove?.(); } catch { /* no-op */ }
    };
  },
};
