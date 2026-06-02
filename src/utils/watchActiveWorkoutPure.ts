// Pure helpers for the watch active-workout sync. No AsyncStorage, no
// native bridge, no module-level state — these functions are the testable
// core of `watchWorkoutMirror.ts`. The mirror module wraps these with
// AsyncStorage I/O and active-session bookkeeping.

import type { LoggedExercisePayload } from '../services/api';
import type { WorkoutDay } from '../types';

export type MirroredWatchExercise = {
  exerciseIndex: number;
  name: string;
  sets: Array<Record<string, any>>;
  [key: string]: any;
};

export function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function positiveInt(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed == null || parsed <= 0) return null;
  return Math.max(1, Math.floor(parsed));
}

export function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Pure mirror-merge helper. Decides whether `payload` is a duplicate
 *  log_set (already present via `watchCommandId`) and, if not, returns a
 *  new mirrored array with the set inserted at the correct slot. */
export function applyWatchLogSetToMirrored(
  day: WorkoutDay,
  mirrored: MirroredWatchExercise[],
  payload: Record<string, any>,
): { changed: boolean; mirrored: MirroredWatchExercise[] } | null {
  const exerciseIndex = positiveInt(Number(payload?.exerciseIndex) + 1);
  if (exerciseIndex == null) return null;
  const zeroIndex = exerciseIndex - 1;
  if (!day.exercises?.[zeroIndex]) return null;
  const target = mirrored[zeroIndex];
  if (!target) return null;

  const commandId = nullableString(payload?.commandId);
  if (commandId && mirrored.some(ex => ex.sets.some(set => set.watchCommandId === commandId))) {
    return { changed: false, mirrored };
  }

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
  const next = mirrored.slice();
  next[zeroIndex] = { ...target, sets: nextSets.filter(Boolean) };
  return { changed: true, mirrored: next };
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
