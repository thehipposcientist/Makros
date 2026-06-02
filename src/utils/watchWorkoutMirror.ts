import AsyncStorage from '@react-native-async-storage/async-storage';
import type { LoggedExercisePayload } from '../services/api';
import type { WorkoutDay } from '../types';
import { setActiveWatchSessionId } from './activeWatchSession';
import {
  applyWatchLogSetToMirrored as applyWatchLogSetToMirroredPure,
  buildLoggedPayloadFromMirroredWorkout as buildLoggedPayloadFromMirroredWorkoutPure,
  finiteNumber,
  nullableString,
  type MirroredWatchExercise,
} from './watchActiveWorkoutPure';
import { STORAGE_KEYS } from './storageKeys.ts';

export {
  applyWatchLogSetToMirroredPure as applyWatchLogSetToMirrored,
  type MirroredWatchExercise,
};

export type WatchLogMirrorResult = {
  changed: boolean;
  exercises: MirroredWatchExercise[];
  totalSets: number;
  startedAt: number;
  loggedPayload: LoggedExercisePayload[];
};

const ACTIVE_WORKOUT_SETS_KEY = STORAGE_KEYS.workouts.activeSets;
const ACTIVE_WORKOUT_START_KEY = STORAGE_KEYS.workouts.activeStartTime;
const ACTIVE_WATCH_SESSION_KEY = STORAGE_KEYS.workouts.activeWatchSessionId;

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

export const buildLoggedPayloadFromMirroredWorkout = buildLoggedPayloadFromMirroredWorkoutPure;

export async function applyWatchLogSetToActiveWorkoutStorage(
  day: WorkoutDay | null | undefined,
  payload: Record<string, any>,
): Promise<WatchLogMirrorResult | null> {
  if (!day?.exercises?.length) return null;
  const initial = await loadMirroredExercises(day);
  const result = applyWatchLogSetToMirroredPure(day, initial, payload);
  if (!result) return null;
  if (result.changed) {
    await AsyncStorage.setItem(ACTIVE_WORKOUT_SETS_KEY, JSON.stringify(result.mirrored)).catch(() => undefined);
  }
  const startedAt = await ensureActiveWorkoutStart(payload);
  const totalSets = result.mirrored.reduce((sum, ex) => sum + ex.sets.length, 0);
  return {
    changed: result.changed,
    exercises: result.mirrored,
    totalSets,
    startedAt,
    loggedPayload: buildLoggedPayloadFromMirroredWorkoutPure(day, result.mirrored),
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
