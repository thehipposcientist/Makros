// Thin JS wrapper around ThalloWatchBridgeModule (native Swift).
//
// Phone → Watch:
//   • syncWorkout(<WatchWorkoutEnvelope>) — ships today's workout snapshot
//     to the paired watch. Native writes persistent applicationContext and
//     mirrors over sendMessage when reachable so start/rejoin transitions
//     are immediate.
//   • syncTheme({...palette}) — pushes the user's current theme colors.
//   • syncHydration({...}) — pushes today's water total + target.
//   • syncActivity({...}) — pushes daily activity basics such as steps.
//   • syncLifestyle({...}) — pushes today's lifestyle-factor context.
//   • startWatchWorkout() — asks watchOS to launch the companion app
//     for the active phone-started workout via HealthKit.
//   • updateProgress({exerciseIndex, setNumber, restRemainingSec,
//                     restEndsAtMs, progressRevision, sessionId,
//                     progressKind, allowExerciseBacktrack,
//                     recommendation, completedExerciseIndexes,
//                     exerciseCompletion}) — live mid-workout updates.
//     Absolute rest timestamps let the watch recover after sleep.
//
// Watch → Phone commands arrive via `addCommandListener`:
//   "start_workout", "skip_workout", "end_workout", "start_rest",
//   "skip_rest", "log_set" ({weightLbs, reps, durationSeconds?, rir?}),
//   "swap_exercise", "add_exercise", "add_circuit", "log_hydration",
//   "toggle_meal", "parse_meal_speech", "confirm_meal_speech",
//   "toggle_supplement", "take_supplement_group", "take_all_supplements",
//   "log_lifestyle", "log_weight".

import { requireOptionalNativeModule } from 'expo';

export type WatchExercise = {
  clientExerciseId?: string | null;
  name: string;
  slug?: string | null;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment?: string | null;
  primaryMuscle?: string | null;
  secondaryMuscles?: string[] | null;
  isCompound?: boolean | null;
  movementPattern?: string | null;
  plannedTargetWeightLbs?: number | null;
  tracksWeight?: boolean;
  isTimed?: boolean;
  plannedDurationSeconds?: number | null;
  recommendation?: string | null;
  recommendedReps?: string | null;
  completedSets?: number | null;
  isDone?: boolean;
  slotLabel?: string | null;
  slotRole?: string | null;
  prescriptionType?: string | null;
  isGuide?: boolean;
  swapOptions?: WatchSwapOption[];
};

export type WatchHRZone = {
  zone: number;
  label: string;
  low: number;
  high: number;
};

export type WatchSwapOption = {
  name: string;
  equipment?: string | null;
  primaryMuscle?: string | null;
  overlap?: number | null;
};

export type WatchWorkoutStatus = 'scheduled' | 'active' | 'completed' | 'skipped' | 'rest';

export type WatchWorkoutPayload = {
  focus: string;
  stimulus?: string | null;
  sourceContext?: string | null;
  templateId?: string | null;
  planDayId?: number | null;
  durationMinutes: number;
  dateISO: string;
  status: WatchWorkoutStatus;
  /** Unique per-session id. Generated when the phone starts a workout.
   *  The watch uses this to distinguish a fresh start from a stale
   *  `.active` lingering in applicationContext after cancel/end. */
  sessionId?: string | null;
  readiness: number | null;
  readinessLabel: string | null;
  exercises: WatchExercise[];
  /** Plain-text warm-up bullets. Shown on the watch before the first
   *  exercise as a dismissable card so users can cue off them without
   *  pulling the phone out. Empty / undefined = no card. */
  warmupSteps?: string[];
  hrZones?: WatchHRZone[];
  /** The phone-side user id. Embedded in the workout dict (not just the
   *  top-level context) so the watch can reject cross-account payloads
   *  that arrive after a user switch before the context is re-keyed. */
  userId?: string | null;
  syncedAtMs: number;
};

export type WatchWorkoutSyncReason =
  | 'home_snapshot'
  | 'active_snapshot'
  | 'pull_state'
  | 'reachability'
  | 'start_echo'
  | 'complete'
  | 'skip'
  | 'clear'
  | 'unknown';

export type WatchWorkoutEnvelope = {
  schemaVersion: 2;
  channel: 'workout';
  eventId: string;
  revision: number;
  reason: WatchWorkoutSyncReason;
  sentAtMs: number;
  userId?: string | null;
  workout: WatchWorkoutPayload;
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

/** A single food item returned by the AI meal-text parser and shown on the
 *  watch review screen before the user confirms logging. */
export type WatchMealParseItem = {
  name: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
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
  groupLabel?: string | null;
  taken: boolean;
  skipped: boolean;
};

export type WatchSupplementsPayload = {
  dateISO: string;
  items: WatchSupplementItem[];
  syncedAtMs: number;
};

export type WatchHydrationPayload = {
  dateISO: string;
  ounces: number;
  targetOunces: number;
  targetOuncesMin?: number;
  targetOuncesMax?: number;
  syncedAtMs: number;
};

export type WatchActivityPayload = {
  dateISO: string;
  stepsToday: number | null;
  stepGoal?: number | null;
  syncedAtMs: number;
};

export type WatchLifestylePayload = {
  dateISO: string;
  hasLog?: boolean;
  alcoholLevel?: 'none' | 'light' | 'moderate' | 'heavy' | null;
  alcoholDrinks?: number | null;
  alcoholTiming?: 'morning' | 'afternoon' | 'evening' | 'late' | 'unknown' | null;
  cannabisLevel?: 'none' | 'light' | 'moderate' | 'heavy' | null;
  cannabisTiming?: 'morning' | 'afternoon' | 'evening' | 'late' | 'unknown' | null;
  bowelMovementCount?: number | null;
  bowelConsistency?: 'normal' | 'loose' | 'hard' | 'mixed' | 'not_sure' | null;
  stressLevel?: 'low' | 'moderate' | 'high' | null;
  illnessState?: 'healthy' | 'rundown' | 'sick' | null;
  caffeineMg?: number | null;
  caffeineTiming?: 'morning' | 'afternoon' | 'evening' | 'late' | 'unknown' | null;
  lateCaffeine?: boolean | null;
  appetite?: 'low' | 'normal' | 'high' | null;
  syncedAtMs: number;
};

/** Saved-templates list shipped to the watch so the user can start a
 *  strength workout from their wrist without picking up the phone.
 *  Mirrors src/types.SavedWorkoutTemplate; we drop the heavyweight
 *  fields (notes, share metadata) since the watch only needs name +
 *  focus + exercise summary to render the picker. */
export type WatchTemplateSummary = {
  id: string;
  name: string;
  focus: string;
  /** Per-exercise sketch for the watch's quick-add list. Keep this
   *  compact, but preserve the prescription + core metadata so a
   *  mid-workout watch add becomes a first-class session exercise. */
  exercises: Array<{
    name: string;
    sets: number;
    reps: string;
    restSeconds?: number | null;
    equipment?: string | null;
    primaryMuscle?: string | null;
    secondaryMuscles?: string[] | null;
    isCompound?: boolean | null;
    movementPattern?: string | null;
    imageUrl?: string | null;
    videoId?: string | null;
    demoExerciseDbId?: string | null;
    slug?: string | null;
  }>;
};

export type WatchTemplatesPayload = {
  templates: WatchTemplateSummary[];
  syncedAtMs: number;
};

export type WatchReadinessFactor = {
  label: string;
  value: number;
  status: 'good' | 'ok' | 'low';
  detail: string | null;
};

export type WatchReadinessPayload = {
  score: number | null;
  label: string | null;
  summary: string | null;
  factors: WatchReadinessFactor[];
  syncedAtMs: number;
};

export type WatchWeightPayload = {
  latestLbs: number | null;
  daysSinceLastLog: number | null;
  emaLbs: number | null;
  slopeLbsPerWeek: number | null;
  syncedAtMs: number;
};

export type WatchSleepPayload = {
  score: number | null;
  hoursLastNight: number | null;
  asleepMin: number | null;
  remMin: number | null;
  deepMin: number | null;
  restingHr: number | null;
  hrvMs: number | null;
  label: string | null;
  summary: string | null;
  syncedAtMs: number;
};

export type WatchPalette = {
  themeName?: string;
  interfaceStyle?: 'light' | 'dark';
  syncedAtMs?: number;
  distanceUnit?: 'mi' | 'km' | null;
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

export type WatchCellularAuthPayload = {
  apiBaseUrl?: string;
  accessToken?: string;
  expiresAt?: string;
  userId?: string | number | null;
  issuedAtMs?: number;
  clear?: boolean;
};

export type WatchProgress = {
  sessionId?: string | null;
  progressRevision?: number;
  sentAtMs?: number;
  exerciseIndex?: number;
  setNumber?: number;
  /** True for phone-driven exercise navigation. Lets the watch follow
   *  the phone even when the selected exercise moves backward. */
  allowExerciseBacktrack?: boolean;
  progressKind?: 'active_exercise' | string;
  completedExerciseIndexes?: number[];
  exerciseCompletion?: Array<{
    exerciseIndex: number;
    completedSets: number;
    targetSets: number;
    isDone: boolean;
  }>;
  restRemainingSec?: number | null;
  restStartedAtMs?: number;
  restDurationSec?: number;
  restEndsAtMs?: number;
  heartRate?: number | null;
  recommendation?: string | null;
  recommendedWeightLbs?: number | null;
  recommendedReps?: string | number | null;
  // ── Cardio metrics (only present for cardio sessions) ──────────────
  /** Resolved HKWorkoutActivityType.rawValue from the watch session.
   *  Drives whether the phone surfaces cardio metrics or hides them.
   *  Lift sessions omit this field. */
  activityTypeRaw?: number;
  /** Total elapsed seconds — pause-aware (HKLiveWorkoutBuilder.elapsedTime). */
  elapsedSeconds?: number;
  /** Distance in meters from whichever source is feeding it: native HK
   *  (outdoor GPS, walk/run pedometer, swim laps) or the manual override
   *  the user typed for indoor bike/rower/elliptical. */
  distanceMeters?: number;
  /** Active calories from HKLiveWorkoutBuilder. Lift sessions don't
   *  collect this so the field is omitted for them. */
  activeCalories?: number;
  /** Average pace seconds per kilometer. Computed on the watch from
   *  distance + elapsed; sent as-is so phone + watch never drift. */
  paceSecPerKm?: number | null;
};

// Loose typing on the native module — Expo's NativeModule generic
// types + `as any` were fighting Metro's babel parser. Keeping this
// minimal means no parser gymnastics, and the public `WatchBridge`
// object below provides the type-safe surface callers actually use.
const native: any = requireOptionalNativeModule('ThalloWatchBridgeModule');
let commandListenerCount = 0;

export const WatchBridge = {
  isAvailable: (): boolean => !!native?.isAvailable?.(),
  isPaired:    (): boolean => !!native?.isPaired?.(),
  isReachable: (): boolean => !!native?.isReachable?.(),
  isWatchAppInstalled: (): boolean => !!native?.isWatchAppInstalled?.(),

  setUserId(id: string | null): void {
    if (!native) return;
    try { native.setUserId(id); } catch {}
  },

  async syncWorkout(payload: WatchWorkoutEnvelope | WatchWorkoutPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncWorkout(payload); } catch { return false; }
  },

  async syncTheme(palette: WatchPalette): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncTheme(palette); } catch { return false; }
  },

  async syncCellularAuth(payload: WatchCellularAuthPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncCellularAuth(payload); } catch { return false; }
  },

  async syncMeals(payload: WatchMealsPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncMeals(payload); } catch { return false; }
  },

  async syncSupplements(payload: WatchSupplementsPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncSupplements(payload); } catch { return false; }
  },

  async syncHydration(payload: WatchHydrationPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncHydration(payload); } catch { return false; }
  },

  async syncActivity(payload: WatchActivityPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncActivity(payload); } catch { return false; }
  },

  async syncLifestyle(payload: WatchLifestylePayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncLifestyle(payload); } catch { return false; }
  },

  async syncSleep(payload: WatchSleepPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncSleep(payload); } catch { return false; }
  },

  async syncReadiness(payload: WatchReadinessPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncReadiness(payload); } catch { return false; }
  },

  async syncWeight(payload: WatchWeightPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncWeight(payload); } catch { return false; }
  },

  /** Push the user's saved workout templates so the watch can render
   *  the Strength picker without a phone roundtrip. Best-effort —
   *  failures fall back to the watch starting strength via the
   *  start_template_session command path (phone picks for them). */
  async syncTemplates(payload: WatchTemplatesPayload): Promise<boolean> {
    if (!native) return false;
    try { return await native.syncTemplates(payload); } catch { return false; }
  },

  /** Push AI-parsed meal items to the watch so the user can review before
   *  confirming. Uses sendMessage (real-time) so the watch review screen
   *  receives the result immediately while the user is waiting. */
  async syncMealParsePreview(items: WatchMealParseItem[], error?: string | null): Promise<boolean> {
    if (!native) return false;
    try {
      return await native.syncMealParsePreview({
        payload: items,
        ...(error ? { error } : {}),
      });
    } catch { return false; }
  },

  async updateProgress(progress: WatchProgress): Promise<boolean> {
    if (!native) return false;
    try { return await native.updateProgress(progress); } catch { return false; }
  },

  async startWatchWorkout(): Promise<boolean> {
    if (!native) return false;
    try { return await native.startWatchWorkout(); } catch { return false; }
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
    try {
      commandListenerCount += 1;
      if (commandListenerCount === 1) native.beginCommandListener?.();
      const queued = native.drainQueuedCommands?.() ?? [];
      if (Array.isArray(queued)) {
        queued.forEach((evt) => handler(evt));
      }
    } catch {}
    return () => {
      try {
        commandListenerCount = Math.max(0, commandListenerCount - 1);
        if (commandListenerCount === 0) native.endCommandListener?.();
      } catch {}
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
    let removed = false;
    const handler = (evt: { reachable?: boolean; paired?: boolean; installed?: boolean }) => {
      if (removed) return;
      cb({
        reachable: !!evt?.reachable,
        paired: !!evt?.paired,
        installed: !!evt?.installed,
      });
    };
    const sub = native.addListener('reachabilityChanged', handler);
    const emitCurrent = () => {
      try {
        handler({
          reachable: !!native?.isReachable?.(),
          paired: !!native?.isPaired?.(),
          installed: !!native?.isWatchAppInstalled?.(),
        });
      } catch {}
    };
    setTimeout(emitCurrent, 0);
    return () => {
      removed = true;
      try { sub?.remove?.(); } catch { /* no-op */ }
    };
  },

};
