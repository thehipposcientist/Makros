import type { LoggedExercisePayload } from '../services/api';
import type { SessionExercise, WorkoutSession } from '../types';

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function sessionExercisesToLoggedPayload(
  exercises: SessionExercise[] | any[] | null | undefined,
): LoggedExercisePayload[] {
  if (!Array.isArray(exercises)) return [];
  return exercises
    .filter(ex => ex?.name)
    .map((ex, idx) => {
      const sets = Array.isArray(ex.sets) ? ex.sets : [];
      return {
        name: String(ex.name),
        slug: ex.slug ?? ex.exerciseSlug ?? ex._slug ?? null,
        target_sets: numberOrUndefined(ex.targetSets) ?? sets.length,
        target_reps: typeof ex.targetReps === 'string' ? ex.targetReps : null,
        equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
        primary_muscle: ex.primaryMuscle ?? ex.primary_muscle ?? ex._primary_muscle ?? null,
        secondary_muscles: ex.secondaryMuscles ?? ex.secondary_muscles ?? ex._secondary_muscles ?? null,
        is_compound: ex.isCompound ?? ex.is_compound ?? null,
        order_index: idx,
        sets: sets.map((set: any, si: number) => ({
          set_number: numberOrUndefined(set.setNumber ?? set.set_number) ?? si + 1,
          reps: numberOrUndefined(set.reps),
          weight_lbs: numberOrUndefined(set.weightLbs ?? set.weight_lbs),
          duration_seconds: numberOrUndefined(set.durationSeconds ?? set.duration_seconds) ?? null,
          comfort_rating: numberOrUndefined(set.comfortRating ?? set.comfort_rating) ?? null,
          feedback: typeof set.feedback === 'string' ? set.feedback : null,
          rir: numberOrUndefined(set.rir),
          actual_distance: numberOrUndefined(set.actualDistance ?? set.actual_distance) ?? null,
          actual_pace: typeof (set.actualPace ?? set.actual_pace) === 'string'
            ? (set.actualPace ?? set.actual_pace)
            : null,
          heart_rate_avg: numberOrUndefined(set.heartRateAvg ?? set.heart_rate_avg) ?? null,
          cardio_metrics: set.cardioMetrics ?? set.cardio_metrics ?? null,
        })),
      };
    });
}

export function workoutSessionToLoggedPayload(
  session: WorkoutSession,
): LoggedExercisePayload[] {
  return sessionExercisesToLoggedPayload(session.exercises);
}
