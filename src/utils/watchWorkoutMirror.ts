import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LoggedExercisePayload } from '../services/api';
import type { WorkoutDay } from '../types';
import { setActiveWatchSessionId } from './activeWatchSession';

export type MirroredWatchExercise = {
  exerciseIndex: number;
  name: string;
  sets: Array<Record<string, any>>;
  [key: string]: any;
};

export type WatchLogMirrorResult = {
  changed: boolean;
  exercises: MirroredWatchExercise[];
  totalSets: number;
  startedAt: number;
  loggedPayload: LoggedExercisePayload[];
};

const ACTIVE_WORKOUT_SETS_KEY = 'activeWorkoutSets';
const ACTIVE_WORKOUT_START_KEY = 'activeWorkoutStartTime';
const ACTIVE_WATCH_SESSION_KEY = 'activeWatchSessionId';

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function plannedExerciseName(ex: any): string {
  return String(ex?.name || 'Exercise');
}

async function loadMirroredExercises(day: WorkoutDay): Promise<MirroredWatchExercise[]> {
  const raw = await AsyncStorage.getItem(ACTIVE_WORKOUT_SETS_KEY).catch(() => null);
  let parsed: any[] = [];
  try {
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  const saved = Array.isArray(parsed) ? parsed : [];
  const usedSaved = new Set<number>();
  return (day.exercises ?? []).map((ex: any, exerciseIndex: number) => {
    const savedByIndex = saved.findIndex((row: any) => Number(row?.exerciseIndex) === exerciseIndex);
    const savedIdx = savedByIndex >= 0
      ? savedByIndex
      : saved.findIndex((row: any, idx: number) =>
          !usedSaved.has(idx) && row?.name === plannedExerciseName(ex)
        );
    if (savedIdx >= 0) usedSaved.add(savedIdx);
    const row = savedIdx >= 0 ? saved[savedIdx] : null;
    return {
      exerciseIndex,
      name: nullableString(row?.name) ?? plannedExerciseName(ex),
      targetSets: finiteNumber(row?.targetSets ?? ex?.sets),
      targetReps: nullableString(row?.targetReps ?? ex?.reps),
      targetRestSeconds: finiteNumber(row?.targetRestSeconds ?? ex?.restSeconds ?? ex?.rest_seconds),
      equipment: nullableString(row?.equipment ?? ex?.equipment),
      slug: nullableString(row?.slug ?? ex?.slug ?? ex?.exerciseSlug),
      primaryMuscle: nullableString(row?.primaryMuscle ?? row?.primary_muscle ?? ex?.primaryMuscle ?? ex?.primary_muscle ?? ex?._primary_muscle),
      secondaryMuscles: Array.isArray(row?.secondaryMuscles)
        ? row.secondaryMuscles
        : Array.isArray(ex?.secondaryMuscles)
          ? ex.secondaryMuscles
          : Array.isArray(ex?.secondary_muscles)
            ? ex.secondary_muscles
            : null,
      isCompound: typeof row?.isCompound === 'boolean'
        ? row.isCompound
        : typeof ex?.isCompound === 'boolean'
          ? ex.isCompound
          : typeof ex?.is_compound === 'boolean'
            ? ex.is_compound
            : null,
      sets: Array.isArray(row?.sets) ? row.sets.filter(Boolean) : [],
    };
  });
}

export function buildLoggedPayloadFromMirroredWorkout(
  day: WorkoutDay,
  mirrored: MirroredWatchExercise[],
): LoggedExercisePayload[] {
  return mirrored
    .filter(row => row.sets.length > 0)
    .map((row): LoggedExercisePayload => {
      const ex: any = day.exercises?.[row.exerciseIndex] ?? {};
      return {
        name: row.name,
        slug: nullableString(row.slug ?? ex.slug ?? ex.exerciseSlug),
        target_sets: finiteNumber(row.targetSets ?? ex.sets),
        target_reps: nullableString(row.targetReps ?? ex.reps),
        equipment: nullableString(row.equipment ?? ex.equipment),
        primary_muscle: nullableString(row.primaryMuscle ?? ex.primaryMuscle ?? ex.primary_muscle ?? ex._primary_muscle),
        secondary_muscles: Array.isArray(row.secondaryMuscles)
          ? row.secondaryMuscles
          : Array.isArray(ex.secondaryMuscles)
            ? ex.secondaryMuscles
            : Array.isArray(ex.secondary_muscles)
              ? ex.secondary_muscles
              : null,
        is_compound: typeof row.isCompound === 'boolean'
          ? row.isCompound
          : typeof ex.isCompound === 'boolean'
            ? ex.isCompound
            : typeof ex.is_compound === 'boolean'
              ? ex.is_compound
              : null,
        order_index: row.exerciseIndex,
        sets: row.sets.map((set, idx) => ({
          set_number: positiveInt(set.setNumber) ?? idx + 1,
          reps: finiteNumber(set.reps) ?? 0,
          weight_lbs: finiteNumber(set.weightLbs) ?? 0,
          duration_seconds: finiteNumber(set.durationSeconds),
          comfort_rating: finiteNumber(set.comfortRating),
          feedback: nullableString(set.feedback),
          rir: finiteNumber(set.rir),
          actual_distance: finiteNumber(set.actualDistance),
          actual_pace: nullableString(set.actualPace),
          heart_rate_avg: finiteNumber(set.heartRateAvg),
          cardio_metrics: set.cardioMetrics && typeof set.cardioMetrics === 'object'
            ? set.cardioMetrics
            : null,
        })),
      };
    });
}

export async function applyWatchLogSetToActiveWorkoutStorage(
  day: WorkoutDay | null | undefined,
  payload: Record<string, any>,
): Promise<WatchLogMirrorResult | null> {
  if (!day?.exercises?.length) return null;
  const exerciseIndex = positiveInt(Number(payload?.exerciseIndex) + 1);
  if (exerciseIndex == null) return null;
  const zeroIndex = exerciseIndex - 1;
  const planned = day.exercises[zeroIndex];
  if (!planned) return null;

  const commandId = nullableString(payload?.commandId);
  const mirrored = await loadMirroredExercises(day);
  if (commandId && mirrored.some(ex => ex.sets.some(set => set.watchCommandId === commandId))) {
    const totalSets = mirrored.reduce((sum, ex) => sum + ex.sets.length, 0);
    const startedAt = await ensureActiveWorkoutStart(payload);
    return {
      changed: false,
      exercises: mirrored,
      totalSets,
      startedAt,
      loggedPayload: buildLoggedPayloadFromMirroredWorkout(day, mirrored),
    };
  }

  const target = mirrored[zeroIndex];
  const setNumber = positiveInt(payload?.setNumber) ?? target.sets.length + 1;
  const durationSeconds = finiteNumber(payload?.durationSeconds);
  const rir = finiteNumber(payload?.rir);
  const nextSet: Record<string, any> = {
    setNumber,
    reps: durationSeconds && durationSeconds > 0 ? 0 : Math.max(0, Math.round(finiteNumber(payload?.reps) ?? 0)),
    weightLbs: durationSeconds && durationSeconds > 0 ? 0 : Math.max(0, finiteNumber(payload?.weightLbs) ?? 0),
  };
  if (durationSeconds && durationSeconds > 0) nextSet.durationSeconds = durationSeconds;
  if (rir != null) nextSet.rir = Math.max(0, Math.min(4, Math.round(rir)));
  if (commandId) nextSet.watchCommandId = commandId;

  const slotIdx = Math.max(0, setNumber - 1);
  const nextSets = target.sets.slice();
  nextSets[slotIdx] = nextSet;
  mirrored[zeroIndex] = { ...target, sets: nextSets.filter(Boolean) };
  await AsyncStorage.setItem(ACTIVE_WORKOUT_SETS_KEY, JSON.stringify(mirrored)).catch(() => undefined);
  const startedAt = await ensureActiveWorkoutStart(payload);
  const totalSets = mirrored.reduce((sum, ex) => sum + ex.sets.length, 0);
  return {
    changed: true,
    exercises: mirrored,
    totalSets,
    startedAt,
    loggedPayload: buildLoggedPayloadFromMirroredWorkout(day, mirrored),
  };
}

async function ensureActiveWorkoutStart(payload: Record<string, any>): Promise<number> {
  const existing = await AsyncStorage.getItem(ACTIVE_WORKOUT_START_KEY).catch(() => null);
  const existingMs = existing ? Number(existing) : NaN;
  if (Number.isFinite(existingMs) && existingMs > 0) {
    await persistWatchSessionId(payload);
    return existingMs;
  }
  const commandMs = finiteNumber(payload?.tsMs);
  const startedAt = commandMs && commandMs > 0 ? commandMs : Date.now();
  await AsyncStorage.setItem(ACTIVE_WORKOUT_START_KEY, String(startedAt)).catch(() => undefined);
  await persistWatchSessionId(payload);
  return startedAt;
}

async function persistWatchSessionId(payload: Record<string, any>): Promise<void> {
  const sessionId = nullableString(payload?.sessionId);
  if (!sessionId) return;
  setActiveWatchSessionId(sessionId);
  await AsyncStorage.setItem(ACTIVE_WATCH_SESSION_KEY, sessionId).catch(() => undefined);
}
