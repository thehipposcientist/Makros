// Phone-side orchestrator for the Apple Watch companion.
//
// Responsibilities:
//   1. Push today's workout (with correct lifecycle status) + theme +
//      meals to the watch whenever they change.
//   2. Subscribe to commands from the watch (Start / Skip / End / rest
//      controls / toggle meal) and route them into phone actions.
//
// Everything no-ops when the bridge is unavailable (Android, devices
// without a paired watch), so callers can always invoke these.

import {
  WatchBridge,
  WatchWorkoutPayload,
  WatchWorkoutStatus,
  WatchPalette,
  WatchProgress,
  WatchMealsPayload,
  WatchSupplementsPayload,
  WatchSupplementItem,
  WatchSleepPayload,
  WatchReadinessPayload,
  WatchReadinessFactor,
  WatchWeightPayload,
} from '../../modules/thallo-watch-bridge';
import { WorkoutDay, AppThemeName, DailyNutritionPlan } from '../types';
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

/** Build the compact watch payload from the day AND its current
 *  status. Status drives which UI the watch shows (scheduled = Start
 *  button visible; active = "rejoin"; completed/skipped/rest = status
 *  card, no Start). Feed the actual `schedule[0]` output here — NOT
 *  the raw `workoutPlan.days[0]`, which ignores skips/switches and
 *  was the source of the "watch shows push even though I skipped" bug. */
export function buildWatchWorkoutPayload(
  day: WorkoutDay | null | undefined,
  opts: {
    dateISO?: string;
    status: WatchWorkoutStatus;
    readiness?: number | null;
    readinessLabel?: string | null;
    /** Plain-text warm-up steps to mirror on the watch. Usually the
     *  output of `buildWarmupPlan(day)` on the phone. */
    warmupSteps?: string[];
  },
): WatchWorkoutPayload | null {
  if (!day) {
    if (opts.status === 'rest') {
      return {
        focus: 'Rest',
        durationMinutes: 0,
        dateISO: opts.dateISO || new Date().toISOString().slice(0, 10),
        status: 'rest',
        readiness: opts.readiness ?? null,
        readinessLabel: opts.readinessLabel ?? null,
        exercises: [],
        syncedAtMs: Date.now(),
      };
    }
    return null;
  }
  // Every exercise is shipped (including warmup slots — the watch's
  // active-workout view treats warmup as its own sequence step and
  // badges it so users know to dial intensity down).
  const exercises: WatchExerciseClient[] = (day.exercises ?? []).map((e: any) => ({
    name: String(e.name || 'Exercise'),
    sets: Number(e.sets || 3),
    reps: String(e.reps || ''),
    restSeconds: Number(e.restSeconds || e.rest_seconds || 60),
    equipment: e.equipment ?? null,
    plannedTargetWeightLbs: e.plannedTargetWeightLbs ?? e.weight ?? null,
    recommendation: e.recommendation ?? null,
    slotRole: e.slot_role ?? e.slotRole ?? null,
  }));
  return {
    focus: String(day.focus || 'Workout'),
    durationMinutes: Number((day as any).durationMinutes ?? (day as any).duration ?? 60),
    dateISO: opts.dateISO || new Date().toISOString().slice(0, 10),
    status: opts.status,
    readiness: opts.readiness ?? null,
    readinessLabel: opts.readinessLabel ?? null,
    exercises,
    // Only include warmupSteps on live / scheduled statuses — watch
    // shouldn't show a warmup card on a completed or skipped day.
    ...(opts.warmupSteps && opts.warmupSteps.length > 0 && (opts.status === 'active' || opts.status === 'scheduled')
      ? { warmupSteps: opts.warmupSteps }
      : {}),
    syncedAtMs: Date.now(),
  };
}

export function buildWatchPalette(themeName: AppThemeName | undefined): WatchPalette {
  const t = getTheme(themeName).colors;
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

// The `isPaired` gate used to silently drop every push if the WC
// session reported unpaired — which happens transiently during
// activation, after a reboot, etc. We now only gate on platform
// availability (iOS + bridge compiled in) and let WCSession itself
// decide whether to enqueue via updateApplicationContext /
// transferUserInfo. That gives the payload a real chance to queue
// even if `isPaired` is briefly false.
function canPush(): boolean {
  return WatchBridge.isAvailable();
}

function wsLog(fn: string, extra?: Record<string, any>): void {
  // Wraps console.log so we can grep Metro logs for every watch
  // push. Kept deliberately chatty during sync debugging — trim
  // once the flow is stable. `installed` matters because pushes can
  // succeed when the watch app isn't currently reachable (queued
  // applicationContext) but only if the app is actually installed
  // on a paired watch — paired+installed+!reachable means "watch app
  // backgrounded, will absorb on next launch."
  // eslint-disable-next-line no-console
  console.log(
    `[watchSync] ${fn} reachable=${WatchBridge.isReachable()} paired=${WatchBridge.isPaired()}`,
    extra ?? '',
  );
}

/** Push today's workout with its current lifecycle status. */
export async function pushWorkoutToWatch(
  day: WorkoutDay | null,
  opts: {
    dateISO?: string;
    status: WatchWorkoutStatus;
    readiness?: number | null;
    readinessLabel?: string | null;
    warmupSteps?: string[];
  },
): Promise<boolean> {
  const payload = buildWatchWorkoutPayload(day, opts);
  if (!payload) return false;
  if (!canPush()) { wsLog('pushWorkoutToWatch skipped — bridge unavailable'); return false; }
  wsLog('pushWorkoutToWatch', { status: opts.status, focus: payload.focus });
  return WatchBridge.syncWorkout(payload);
}

export async function pushThemeToWatch(themeName: AppThemeName | undefined) {
  const palette = buildWatchPalette(themeName);
  if (!canPush()) return false;
  return WatchBridge.syncTheme(palette);
}

export async function pushProgressToWatch(progress: WatchProgress) {
  if (!canPush()) return false;
  wsLog('pushProgressToWatch', progress);
  return WatchBridge.updateProgress(progress);
}

/** Push today's meals (targets + actual + per-meal check state +
 *  optional nutrition score). */
export async function pushMealsToWatch(
  plan: DailyNutritionPlan | null | undefined,
  checkedMeals: Record<string, boolean> | null | undefined,
  dateISO?: string,
  score?: number | null,
): Promise<boolean> {
  if (!plan) return false;
  if (!canPush()) return false;

  const targets = plan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const mealArr = plan.meals ?? [];
  const checks = checkedMeals ?? {};

  // Actual = sum of checked meals' macros. Matches the phone's
  // NutritionCard calculation so numbers stay aligned.
  let actCal = 0, actPro = 0, actCarb = 0, actFat = 0;
  const items = mealArr.map((m: any, i: number) => {
    const mealType = `meal_${i}`;
    const checked = !!checks[mealType];
    if (checked) {
      actCal  += Number(m.calories ?? 0);
      actPro  += Number(m.protein  ?? 0);
      actCarb += Number(m.carbs    ?? 0);
      actFat  += Number(m.fat      ?? 0);
    }
    return {
      mealType,
      name: String(m.meal || m.name || `Meal ${i + 1}`),
      calories: Math.round(Number(m.calories ?? 0)),
      proteinG: Math.round(Number(m.protein  ?? 0)),
      carbsG:   Math.round(Number(m.carbs    ?? 0)),
      fatG:     Math.round(Number(m.fat      ?? 0)),
      checked,
    };
  });

  const payload: WatchMealsPayload = {
    dateISO: dateISO || new Date().toISOString().slice(0, 10),
    targets: {
      calories: Math.round(Number(targets.calories ?? 0)),
      proteinG: Math.round(Number(targets.protein  ?? 0)),
      carbsG:   Math.round(Number(targets.carbs    ?? 0)),
      fatG:     Math.round(Number(targets.fat      ?? 0)),
    },
    actual: {
      calories: Math.round(actCal),
      proteinG: Math.round(actPro),
      carbsG:   Math.round(actCarb),
      fatG:     Math.round(actFat),
    },
    score: score ?? null,
    meals: items,
    syncedAtMs: Date.now(),
  };
  return WatchBridge.syncMeals(payload);
}

/** Push sleep score + last-night summary to the watch. Drives the
 *  Sleep tab on the watch — score + hours + RHR + HRV + a short
 *  coach-style summary line. Built from the phone's sleepScore
 *  service so the watch + phone stay consistent. */
export async function pushSleepToWatch(opts: {
  score?: number | null;
  hoursLastNight?: number | null;
  asleepMin?: number | null;
  remMin?: number | null;
  deepMin?: number | null;
  restingHr?: number | null;
  hrvMs?: number | null;
  label?: string | null;
  summary?: string | null;
}): Promise<boolean> {
  if (!canPush()) return false;
  const payload: WatchSleepPayload = {
    score: opts.score ?? null,
    hoursLastNight: opts.hoursLastNight ?? null,
    asleepMin: opts.asleepMin ?? null,
    remMin: opts.remMin ?? null,
    deepMin: opts.deepMin ?? null,
    restingHr: opts.restingHr ?? null,
    hrvMs: opts.hrvMs ?? null,
    label: opts.label ?? null,
    summary: opts.summary ?? null,
    syncedAtMs: Date.now(),
  };
  wsLog('pushSleepToWatch', { score: payload.score, hours: payload.hoursLastNight });
  return WatchBridge.syncSleep(payload);
}

/** Push readiness drill-down data — score + label + per-factor
 *  breakdown so the watch's Readiness tab can render the same story
 *  the phone's TrainingReadinessCard tells.
 *
 *  When `syncedAtMs` is supplied (e.g. the server's `computed_at_ms`
 *  stamp from /readiness/today), pass that through so the watch's
 *  ConnectivityStore ordering check uses the SERVER timestamp instead
 *  of `Date.now()`. This is what makes phone+watch readiness drift-
 *  free: both sides agree on the version because they read the same
 *  number from the same authoritative source. */
export async function pushReadinessToWatch(opts: {
  score?: number | null;
  label?: string | null;
  summary?: string | null;
  factors?: WatchReadinessFactor[];
  syncedAtMs?: number;
}): Promise<boolean> {
  if (!canPush()) return false;
  const payload: WatchReadinessPayload = {
    score: opts.score ?? null,
    label: opts.label ?? null,
    summary: opts.summary ?? null,
    factors: opts.factors ?? [],
    syncedAtMs: opts.syncedAtMs ?? Date.now(),
  };
  wsLog('pushReadinessToWatch', { score: payload.score });
  return WatchBridge.syncReadiness(payload);
}

/** Push body-weight summary so the watch's Weight tab can render
 *  the EMA + slope + last-log freshness, and seed the quick-log
 *  Digital Crown wheel near the latest known value. */
export async function pushWeightToWatch(opts: {
  latestLbs?: number | null;
  daysSinceLastLog?: number | null;
  emaLbs?: number | null;
  slopeLbsPerWeek?: number | null;
}): Promise<boolean> {
  if (!canPush()) return false;
  const payload: WatchWeightPayload = {
    latestLbs: opts.latestLbs ?? null,
    daysSinceLastLog: opts.daysSinceLastLog ?? null,
    emaLbs: opts.emaLbs ?? null,
    slopeLbsPerWeek: opts.slopeLbsPerWeek ?? null,
    syncedAtMs: Date.now(),
  };
  wsLog('pushWeightToWatch', { latest: payload.latestLbs });
  return WatchBridge.syncWeight(payload);
}

/** Wipe the watch's local store on sign-out / user-switch. Pushes
 *  empty payloads for workout / meals / supplements so the watch
 *  doesn't retain the previous user's plan + meals + macros after a
 *  swap. Theme stays — it's user-preference, not user-data, and
 *  defaults will arrive on the next sign-in.
 *
 *  iOS WCSession's applicationContext persists across app re-launches
 *  on the watch side — without this wipe, the watch would happily
 *  show your wife's meal plan when YOU sign in. (This is the bug
 *  the user originally flagged.) */
export async function clearWatchData(): Promise<void> {
  if (!canPush()) return;
  const now = Date.now();
  // Empty workout = "rest" status with no exercises. Watch's
  // ContentView treats `.rest` as "nothing to do today" and bails
  // out of any active state.
  await WatchBridge.syncWorkout({
    focus: 'Rest',
    durationMinutes: 0,
    dateISO: new Date().toISOString().slice(0, 10),
    status: 'rest',
    readiness: null,
    readinessLabel: null,
    exercises: [],
    syncedAtMs: now,
  } as any).catch(() => {});
  // Empty meals — null score, no items. Watch's MealsView shows
  // the "Open Thallo on iPhone" empty state.
  await WatchBridge.syncMeals({
    dateISO: new Date().toISOString().slice(0, 10),
    targets: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    actual:  { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    score: null,
    meals: [],
    syncedAtMs: now,
  }).catch(() => {});
  // Empty supplement stack.
  await WatchBridge.syncSupplements({
    dateISO: new Date().toISOString().slice(0, 10),
    items: [],
    syncedAtMs: now,
  }).catch(() => {});
  wsLog('clearWatchData');
}

/** Push today's supplement stack to the watch so the Supps tab can
 *  render it. Phone keeps authoritative state; watch taps round-trip
 *  via `toggle_supplement` / `take_all_supplements` commands. */
export async function pushSupplementsToWatch(
  items: Array<{
    id: number;
    name: string;
    dose?: string | null;
    timing?: string | null;
    taken?: boolean;
    skipped?: boolean;
  }>,
  dateISO?: string,
): Promise<boolean> {
  if (!canPush()) return false;
  const payload: WatchSupplementsPayload = {
    dateISO: dateISO || new Date().toISOString().slice(0, 10),
    items: items.map((s): WatchSupplementItem => ({
      id: Number(s.id),
      name: String(s.name ?? 'Supplement'),
      dose: s.dose ?? null,
      timing: s.timing ?? null,
      taken: !!s.taken,
      skipped: !!s.skipped,
    })),
    syncedAtMs: Date.now(),
  };
  wsLog('pushSupplementsToWatch', { count: items.length });
  return WatchBridge.syncSupplements(payload);
}

/** Subscribe to commands the user taps on the watch. Returns an
 *  unsubscribe function. */
export function onWatchCommand(
  cb: (command: string, payload: Record<string, any>) => void,
): () => void {
  if (!WatchBridge.isAvailable()) return () => {};
  return WatchBridge.addCommandListener(cb);
}

/** Subscribe to WCSession reachability changes. Fires whenever the
 *  watch app opens / closes (or right after session activation, so
 *  listeners that mount mid-session still see the current state).
 *  Callers re-push their current snapshot on `reachable=true` so the
 *  watch gets fresh data the moment the user opens Thallo. */
export function onWatchReachabilityChange(
  cb: (info: { reachable: boolean; paired: boolean; installed: boolean }) => void,
): () => void {
  if (!WatchBridge.isAvailable()) return () => {};
  return WatchBridge.addReachabilityListener(cb);
}

/** Convenience: returns a plain boolean the UI can read to decide
 *  whether to show an "Open Thallo on your watch" nudge. */
export function isWatchReachable(): boolean {
  return WatchBridge.isAvailable() && WatchBridge.isReachable();
}

/** Subscribe to verbose WCSession diagnostic events from the phone
 *  bridge. Fires for every delegate callback (activation, reachability,
 *  every receive path) with a snapshot of session state. Used by the
 *  HomeScreen logger to dump `[wc-diag] …` lines into the in-app
 *  DevLogsViewer so we can debug "watch taps never arrive" without
 *  tethering to Mac + Console.app. */
export function onWatchSessionDiag(
  cb: (entry: Record<string, any>) => void,
): () => void {
  if (!WatchBridge.isAvailable()) return () => {};
  return WatchBridge.addSessionDiagListener(cb);
}
