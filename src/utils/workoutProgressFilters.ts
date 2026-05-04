import type { WorkoutSession, SessionExercise, CompletedSet } from '../types';

export type ExerciseTrendPoint = {
  label: string;
  bestWeight: number;
  volume: number;
  totalDuration: number;
};

export type E1RMTrendPoint = {
  date: string;
  e1rm_lbs: number;
  confidence: string;
  sample_count: number;
};

const NON_STRENGTH_PRIMARY_MUSCLES = new Set([
  'cardio',
  'mobility',
  'recovery',
  'stretch',
  'systemic',
]);

const NON_STRENGTH_ACTIVITY_TAGS = new Set([
  'cardio',
  'conditioning',
  'mobility',
  'recovery',
  'stretch',
  'warmup',
]);

const NON_STRENGTH_NAME_RE = /treadmill|stationary bike|elliptical|rowing machine|stair climber|assault bike|battle rope|jump rope|sprint|jogging|running|cycling|swimming|hiit|intervals|mountain climber|hill sprint|cardio|zone.?2|tempo (run|ride|bike|row|swim)|boxing|kickboxing|bag.?work|shadow.?box|yoga|vinyasa|pilates|mobility|stretch|foam.?roll|recovery flow|sun.?salutation|downward.?dog|cobra flow|child.?s pose|seated forward fold|spinal twist|couch stretch|deep squat hold|90\/90|cat.?cow|thread.?the.?needle|dead hang|wall sit|hollow.?hold|plank|burpee/i;

export function normalizedExerciseName(name: unknown): string {
  return String(name ?? '').trim().toLowerCase();
}

export function getExercisePrimaryMuscle(exercise: Partial<SessionExercise> | any): string {
  return String(exercise?.primaryMuscle ?? exercise?.primary_muscle ?? '').trim().toLowerCase();
}

export function isLoadedStrengthSet(set: Partial<CompletedSet> | any): boolean {
  const weight = Number(set?.weightLbs ?? set?.weight_lbs ?? 0);
  const reps = Number(set?.reps ?? 0);
  return Number.isFinite(weight) && weight > 0 && Number.isFinite(reps) && reps > 0;
}

export function isNonStrengthExercise(exercise: Partial<SessionExercise> | any): boolean {
  const primary = getExercisePrimaryMuscle(exercise);
  if (NON_STRENGTH_PRIMARY_MUSCLES.has(primary)) return true;
  const tags = [
    exercise?.slotRole,
    exercise?.slot_role,
    exercise?.prescriptionType,
    exercise?.prescription_type,
    exercise?.exerciseType,
    exercise?.exercise_type,
    exercise?.movementPattern,
    exercise?.movement_pattern,
  ];
  if (tags.some(tag => NON_STRENGTH_ACTIVITY_TAGS.has(String(tag ?? '').trim().toLowerCase()))) return true;
  const name = String(exercise?.name ?? '');
  return NON_STRENGTH_NAME_RE.test(name);
}

export function isTrackableStrengthExercise(exercise: Partial<SessionExercise> | any): boolean {
  const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
  if (!sets.some(isLoadedStrengthSet)) return false;
  return !isNonStrengthExercise(exercise);
}

export function loadedStrengthSets(exercise: Partial<SessionExercise> | any): CompletedSet[] {
  const sets = Array.isArray(exercise?.sets) ? exercise.sets : [];
  if (isNonStrengthExercise(exercise)) return [];
  return sets.filter(isLoadedStrengthSet);
}

export function inferChartMuscleFromName(name: string): string {
  const n = name.toLowerCase();
  if (NON_STRENGTH_NAME_RE.test(n)) return 'cardio';
  if (/bench|push.?up|chest|pec|fly/.test(n)) return 'chest';
  if (/row|pulldown|pull.?up|chin.?up|lat|deadlift|trap/.test(n)) return 'back';
  if (/shoulder|overhead|ohp|lateral raise|rear delt|face pull/.test(n)) return 'shoulders';
  if (/curl|bicep/.test(n)) return 'biceps';
  if (/tricep|dip|skull/.test(n)) return 'triceps';
  if (/squat|leg press|lunge|split squat|step.?up|extension/.test(n)) return 'quads';
  if (/romanian|rdl|hamstring|leg curl|good morning/.test(n)) return 'hamstrings';
  if (/hip thrust|glute|kickback|bridge/.test(n)) return 'glutes';
  if (/calf/.test(n)) return 'calves';
  if (/\babs?\b|crunch|plank|\bcore\b|russian twist|leg raise|sit.?up|hollow|knee raise|woodchopper/.test(n)) return 'core';
  return '';
}

export function buildExerciseTrendMap(history: WorkoutSession[]): Record<string, ExerciseTrendPoint[]> {
  const trendMap: Record<string, ExerciseTrendPoint[]> = {};
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));

  for (const session of sorted) {
    if (!session.completed || session.skipped) continue;
    for (const exercise of session.exercises ?? []) {
      const key = normalizedExerciseName(exercise.name);
      if (!key || !isTrackableStrengthExercise(exercise)) continue;

      const strengthSets = loadedStrengthSets(exercise);
      if (strengthSets.length === 0) continue;

      const bestWeight = Math.max(...strengthSets.map(set => Number(set.weightLbs ?? 0)));
      const volume = strengthSets.reduce((sum, set) => sum + Number(set.weightLbs ?? 0) * Number(set.reps ?? 0), 0);
      const totalDuration = strengthSets.reduce((sum, set) => sum + Number((set as any).durationSeconds ?? 0), 0);
      const d = new Date(session.date);
      const rows = trendMap[key] ?? [];
      rows.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, bestWeight, volume, totalDuration });
      trendMap[key] = rows.length > 10 ? rows.slice(-10) : rows;
    }
  }

  return trendMap;
}

export function buildLocalE1RMHistory(
  history: WorkoutSession[],
  exerciseName: string | null | undefined,
  estimateSet: (
    weightLbs: number | null | undefined,
    reps: number | null | undefined,
    options?: { rir?: number | null },
  ) => number | null,
): E1RMTrendPoint[] {
  const target = normalizedExerciseName(exerciseName);
  if (!target) return [];

  const points: E1RMTrendPoint[] = [];
  const sorted = [...history].sort((a, b) => +new Date(a.date) - +new Date(b.date));
  for (const session of sorted) {
    if (!session.completed || session.skipped) continue;
    let best: number | null = null;
    let sampleCount = 0;
    for (const exercise of session.exercises ?? []) {
      if (normalizedExerciseName(exercise.name) !== target || !isTrackableStrengthExercise(exercise)) continue;
      for (const set of loadedStrengthSets(exercise)) {
        const estimate = estimateSet(set.weightLbs, set.reps, { rir: set.rir });
        if (estimate == null) continue;
        sampleCount += 1;
        if (best == null || estimate > best) best = estimate;
      }
    }
    if (best != null) {
      points.push({
        date: session.date,
        e1rm_lbs: Math.round(best * 10) / 10,
        confidence: sampleCount >= 3 ? 'med' : 'low',
        sample_count: sampleCount,
      });
    }
  }
  return points.slice(-10);
}
