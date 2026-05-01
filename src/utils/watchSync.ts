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
  WatchWorkoutEnvelope,
  WatchWorkoutPayload,
  WatchWorkoutSyncReason,
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutDay, AppThemeName, DailyNutritionPlan } from '../types';
import { getTheme } from '../constants/theme';
import { recordTelemetryEvent } from '../services/api';

export { WatchBridge };

const WATCH_SYNC_STATUS_KEY = 'watch_sync_status_v1';
const WATCH_WORKOUT_SCHEMA_VERSION = 2 as const;
let workoutRevisionSequence = 0;

export type WatchSyncSnapshot = {
  surface: string;
  ok: boolean;
  atMs: number;
  reachable: boolean;
  paired: boolean;
  detail?: string;
};

async function recordWatchSync(surface: string, ok: boolean, detail?: string): Promise<void> {
  const snapshot: WatchSyncSnapshot = {
    surface,
    ok,
    detail,
    atMs: Date.now(),
    reachable: WatchBridge.isAvailable() ? WatchBridge.isReachable() : false,
    paired: WatchBridge.isAvailable() ? WatchBridge.isPaired() : false,
  };
  try { await AsyncStorage.setItem(WATCH_SYNC_STATUS_KEY, JSON.stringify(snapshot)); } catch {}
  recordTelemetryEvent('watch_sync_result', {
    surface,
    ok,
    reachable: snapshot.reachable,
    paired: snapshot.paired,
    detail,
  });
}

export async function getWatchSyncSnapshot(): Promise<WatchSyncSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(WATCH_SYNC_STATUS_KEY);
    return raw ? JSON.parse(raw) as WatchSyncSnapshot : null;
  } catch {
    return null;
  }
}

function localDateISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[^\d.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed <= 0) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function nextWorkoutRevision(nowMs: number = Date.now()): number {
  workoutRevisionSequence = (workoutRevisionSequence + 1) % 1000;
  return nowMs * 1000 + workoutRevisionSequence;
}

function workoutEventId(revision: number): string {
  return `workout-${Math.floor(revision)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultWorkoutReason(status: WatchWorkoutStatus): WatchWorkoutSyncReason {
  switch (status) {
    case 'active': return 'active_snapshot';
    case 'completed': return 'complete';
    case 'skipped': return 'skip';
    case 'rest': return 'home_snapshot';
    case 'scheduled':
    default: return 'home_snapshot';
  }
}

async function getStoredUserId(): Promise<string | null> {
  return AsyncStorage.getItem('last_user_id').catch(() => null);
}

async function stampBridgeUserId(userId?: string | null): Promise<string | null> {
  const resolved = userId !== undefined ? userId : await getStoredUserId();
  try { WatchBridge.setUserId(resolved ?? null); } catch {}
  return resolved ?? null;
}

export type WatchExerciseClient = {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment?: string | null;
  plannedTargetWeightLbs?: number | null;
  recommendation?: string | null;
  slotRole?: string | null;
  swapOptions?: Array<{
    name: string;
    equipment?: string | null;
    primaryMuscle?: string | null;
    overlap?: number | null;
  }>;
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
    sessionId?: string | null;
    readiness?: number | null;
    readinessLabel?: string | null;
    /** Plain-text warm-up steps to mirror on the watch. Usually the
     *  output of `buildWarmupPlan(day)` on the phone. */
    warmupSteps?: string[];
    userId?: string | null;
  },
): WatchWorkoutPayload | null {
  if (!day) {
    // ALWAYS return a payload, even when day is null. Previously this
    // returned null for non-rest statuses, which silently skipped the
    // push and left the watch on "Open Thallo" forever. Now the watch
    // gets a placeholder so it knows the phone is connected; if the
    // schedule resolves a real workout later, the next push overwrites.
    return {
      focus: opts.status === 'rest' ? 'Rest' : 'Loading…',
      durationMinutes: 0,
      dateISO: opts.dateISO || localDateISO(),
      status: opts.status,
      sessionId: opts.sessionId ?? null,
      readiness: opts.readiness ?? null,
      readinessLabel: opts.readinessLabel ?? null,
      exercises: [],
      userId: opts.userId ?? null,
      syncedAtMs: Date.now(),
    };
  }
  // Every exercise is shipped (including warmup slots — the watch's
  // active-workout view treats warmup as its own sequence step and
  // badges it so users know to dial intensity down).
  const exercises: WatchExerciseClient[] = (day.exercises ?? []).map((e: any) => {
    const swapOptions = Array.isArray(e.swapOptions)
      ? e.swapOptions
        .map((option: any) => ({
          name: String(option?.name ?? '').trim(),
          equipment: nullableString(option?.equipment),
          primaryMuscle: nullableString(option?.primaryMuscle ?? option?.primary_muscle),
          overlap: finiteNumber(option?.overlap),
        }))
        .filter((option: any) => option.name.length > 0)
        .slice(0, 5)
      : [];
    return {
      name: String(e.name || 'Exercise'),
      sets: positiveInt(e.sets, 3),
      reps: String(e.reps ?? ''),
      restSeconds: positiveInt(e.restSeconds ?? e.rest_seconds, 60),
      equipment: nullableString(e.equipment),
      plannedTargetWeightLbs: finiteNumber(
        e.plannedTargetWeightLbs
          ?? e.targetWeightLbs
          ?? e.recommendedWeightLbs
          ?? e.weight,
      ),
      recommendation: nullableString(e.recommendation),
      slotRole: nullableString(e.slot_role ?? e.slotRole),
      ...(swapOptions.length > 0 ? { swapOptions } : {}),
    };
  });
  const durationMinutes = positiveInt((day as any).durationMinutes ?? (day as any).duration, 60);
  return {
    focus: String(day.focus || 'Workout'),
    durationMinutes,
    dateISO: opts.dateISO || localDateISO(),
    status: opts.status,
    sessionId: opts.sessionId ?? null,
    readiness: opts.readiness ?? null,
    readinessLabel: opts.readinessLabel ?? null,
    exercises,
    // Only include warmupSteps on live / scheduled statuses — watch
    // shouldn't show a warmup card on a completed or skipped day.
    ...(opts.warmupSteps && opts.warmupSteps.length > 0 && (opts.status === 'active' || opts.status === 'scheduled')
      ? { warmupSteps: opts.warmupSteps }
      : {}),
    userId: opts.userId ?? null,
    syncedAtMs: Date.now(),
  };
}

export function buildWatchWorkoutEnvelope(
  workout: WatchWorkoutPayload,
  opts: {
    reason?: WatchWorkoutSyncReason;
    userId?: string | null;
    revision?: number;
    sentAtMs?: number;
  } = {},
): WatchWorkoutEnvelope {
  const sentAtMs = opts.sentAtMs ?? Date.now();
  const revision = opts.revision ?? nextWorkoutRevision(sentAtMs);
  const userId = opts.userId !== undefined ? opts.userId : workout.userId ?? null;
  const normalizedWorkout: WatchWorkoutPayload = {
    ...workout,
    userId,
    syncedAtMs: workout.syncedAtMs ?? sentAtMs,
  };
  return {
    schemaVersion: WATCH_WORKOUT_SCHEMA_VERSION,
    channel: 'workout',
    eventId: workoutEventId(revision),
    revision,
    reason: opts.reason ?? defaultWorkoutReason(workout.status),
    sentAtMs,
    userId,
    workout: normalizedWorkout,
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
    sessionId?: string | null;
    readiness?: number | null;
    readinessLabel?: string | null;
    warmupSteps?: string[];
    userId?: string | null;
    reason?: WatchWorkoutSyncReason;
  },
): Promise<boolean> {
  // Resolve userId: caller can pass it explicitly; otherwise fall back to
  // the stored last_user_id so every push carries the correct identity
  // without requiring every call site to look it up.
  const userId = await stampBridgeUserId(opts.userId);
  const payload = buildWatchWorkoutPayload(day, { ...opts, userId });
  if (!payload) return false;
  if (!canPush()) {
    wsLog('pushWorkoutToWatch skipped — bridge unavailable');
    await recordWatchSync('workout', false, 'bridge_unavailable');
    return false;
  }
  const envelope = buildWatchWorkoutEnvelope(payload, { reason: opts.reason, userId });
  // Surface payload shape + size so we can spot the case where the
  // merged WCSession applicationContext gets too large to enqueue
  // (256KB hard cap). When updateApplicationContext throws on iOS, the
  // bridge falls back to sendMessage which only delivers when the
  // watch is reachable — explaining "everything else syncs but workout
  // doesn't" if a single oversized exercise list pushes the merged
  // dict past the limit.
  let payloadBytes = 0;
  try { payloadBytes = JSON.stringify(envelope).length; } catch {}
  wsLog('pushWorkoutToWatch', {
    status: opts.status,
    reason: envelope.reason,
    revision: envelope.revision,
    focus: payload.focus,
    exercises: payload.exercises?.length ?? 0,
    bytes: payloadBytes,
    userId: userId?.slice(0, 4),
  });
  const ok = await WatchBridge.syncWorkout(envelope);
  await recordWatchSync('workout', !!ok, `${envelope.reason}/${opts.status} ex=${payload.exercises?.length ?? 0} b=${payloadBytes}`);
  return ok;
}

export async function pushThemeToWatch(themeName: AppThemeName | undefined) {
  const palette = buildWatchPalette(themeName);
  if (!canPush()) { await recordWatchSync('theme', false, 'bridge_unavailable'); return false; }
  await stampBridgeUserId();
  const ok = await WatchBridge.syncTheme(palette);
  await recordWatchSync('theme', !!ok);
  return ok;
}

export async function pushProgressToWatch(progress: WatchProgress) {
  if (!canPush()) { await recordWatchSync('progress', false, 'bridge_unavailable'); return false; }
  wsLog('pushProgressToWatch', progress);
  const ok = await WatchBridge.updateProgress(progress);
  await recordWatchSync('progress', !!ok);
  return ok;
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
  if (!canPush()) { await recordWatchSync('meals', false, 'bridge_unavailable'); return false; }
  await stampBridgeUserId();

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
    dateISO: dateISO || localDateISO(),
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
  const ok = await WatchBridge.syncMeals(payload);
  await recordWatchSync('meals', !!ok, `${items.length} meals`);
  return ok;
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
  if (!canPush()) { await recordWatchSync('sleep', false, 'bridge_unavailable'); return false; }
  await stampBridgeUserId();
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
  const ok = await WatchBridge.syncSleep(payload);
  await recordWatchSync('sleep', !!ok);
  return ok;
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
  if (!canPush()) { await recordWatchSync('readiness', false, 'bridge_unavailable'); return false; }
  await stampBridgeUserId();
  const payload: WatchReadinessPayload = {
    score: opts.score ?? null,
    label: opts.label ?? null,
    summary: opts.summary ?? null,
    factors: opts.factors ?? [],
    syncedAtMs: opts.syncedAtMs ?? Date.now(),
  };
  wsLog('pushReadinessToWatch', { score: payload.score });
  const ok = await WatchBridge.syncReadiness(payload);
  await recordWatchSync('readiness', !!ok);
  return ok;
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
  if (!canPush()) { await recordWatchSync('weight', false, 'bridge_unavailable'); return false; }
  await stampBridgeUserId();
  const payload: WatchWeightPayload = {
    latestLbs: opts.latestLbs ?? null,
    daysSinceLastLog: opts.daysSinceLastLog ?? null,
    emaLbs: opts.emaLbs ?? null,
    slopeLbsPerWeek: opts.slopeLbsPerWeek ?? null,
    syncedAtMs: Date.now(),
  };
  wsLog('pushWeightToWatch', { latest: payload.latestLbs });
  const ok = await WatchBridge.syncWeight(payload);
  await recordWatchSync('weight', !!ok);
  return ok;
}

/** Wipe the watch's local store on sign-out / user-switch. Pushes
 *  empty payloads for workout / meals / supplements / theme and
 *  clears userId so the watch doesn't retain the previous user's
 *  data after a swap. Theme is also cleared because it carries the
 *  previous user's palette and the watch would briefly flash it
 *  before the new user's theme arrives.
 *
 *  iOS WCSession's applicationContext persists across app re-launches
 *  on the watch side — without this wipe, the watch would happily
 *  show your wife's meal plan when YOU sign in. */
export async function clearWatchData(): Promise<void> {
  if (!canPush()) return;
  const now = Date.now();
  // clearWorkoutMs tells the watch to discard its stored workout before absorbing
  // this payload, bypassing the syncedAtMs ordering guard. Safe to leave in
  // applicationContext — the watch tracks the last processed timestamp and
  // ignores repeated delivers of the same value.
  const clearWorkout = {
    focus: 'Rest',
    durationMinutes: 0,
    dateISO: localDateISO(),
    status: 'rest',
    sessionId: null,
    readiness: null,
    readinessLabel: null,
    exercises: [],
    userId: '',
    syncedAtMs: now,
    clearWorkoutMs: now,
  } as WatchWorkoutPayload & { clearWorkoutMs: number };
  await WatchBridge.syncWorkout(buildWatchWorkoutEnvelope(clearWorkout, {
    reason: 'clear',
    sentAtMs: now,
    userId: '',
  })).catch(() => {});
  await WatchBridge.syncMeals({
    dateISO: localDateISO(),
    targets: { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    actual:  { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
    score: null,
    meals: [],
    syncedAtMs: now,
  }).catch(() => {});
  await WatchBridge.syncSupplements({
    dateISO: localDateISO(),
    items: [],
    syncedAtMs: now,
  }).catch(() => {});
  await WatchBridge.syncTheme(buildWatchPalette(undefined)).catch(() => {});
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
  if (!canPush()) { await recordWatchSync('supplements', false, 'bridge_unavailable'); return false; }
  await stampBridgeUserId();
  const payload: WatchSupplementsPayload = {
    dateISO: dateISO || localDateISO(),
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
  const ok = await WatchBridge.syncSupplements(payload);
  await recordWatchSync('supplements', !!ok, `${items.length} items`);
  return ok;
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
 *  every receive path) with a snapshot of session state. The HomeScreen
 *  logger turns these into `[wc-diag] …` console lines visible in
 *  Console.app on Mac (filter by ThalloWatch / connectivityd). */
export function onWatchSessionDiag(
  cb: (entry: Record<string, any>) => void,
): () => void {
  if (!WatchBridge.isAvailable()) return () => {};
  return WatchBridge.addSessionDiagListener(cb);
}
