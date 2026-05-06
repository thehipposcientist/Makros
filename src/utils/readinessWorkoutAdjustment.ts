import type { WorkoutDay } from '../types';

export type ReadinessAdjustmentKind = 'lighten' | 'recovery';
export type ReadinessAdjustmentSeverity = 'moderate' | 'high' | 'very_high';

export interface ReadinessWorkoutRecommendation {
  kind: ReadinessAdjustmentKind;
  severity: ReadinessAdjustmentSeverity;
  readiness: number;
  title: string;
  detail: string;
  affectedMuscles: string[];
}

interface RecommendInput {
  workout: WorkoutDay | null | undefined;
  muscleFatigue?: Record<string, number> | null;
  focusReadiness?: Record<string, number> | null;
}

interface ApplyInput {
  workout: WorkoutDay;
  recommendation: ReadinessWorkoutRecommendation;
}

const FOCUS_MUSCLES: Record<string, string[]> = {
  push: ['chest', 'shoulders', 'triceps'],
  chest: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps'],
  back: ['back', 'biceps'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves'],
  lower: ['quads', 'hamstrings', 'glutes', 'calves'],
  upper: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  full_body: ['chest', 'back', 'shoulders', 'quads', 'glutes', 'hamstrings'],
  shoulders: ['shoulders'],
  arms: ['biceps', 'triceps'],
  cardio: ['cardio'],
};

const FOCUS_PATTERNS: Array<[string, string]> = [
  ['push', 'push'], ['chest', 'chest'], ['press', 'push'],
  ['pull', 'pull'], ['back', 'back'], ['bicep', 'pull'], ['lat', 'pull'],
  ['leg', 'legs'], ['quad', 'legs'], ['hamstring', 'legs'], ['glute', 'legs'], ['lower', 'lower'],
  ['upper', 'upper'],
  ['full body', 'full_body'], ['full_body', 'full_body'], ['total', 'full_body'],
  ['shoulder', 'shoulders'],
  ['arms', 'arms'], ['arm', 'arms'],
  ['cardio', 'cardio'], ['zone', 'cardio'], ['interval', 'cardio'],
];

const RECOVERY_STIMULI = new Set(['recovery', 'mobility']);

function focusKeyFor(workout: WorkoutDay): string | null {
  const blob = `${workout.focus ?? ''} ${workout.stimulus ?? ''}`.toLowerCase();
  for (const [needle, key] of FOCUS_PATTERNS) {
    if (blob.includes(needle)) return key;
  }
  return null;
}

function normalizedReadiness(value: unknown): number | null {
  if (value == null) return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const pct = raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function primaryMuscle(exercise: unknown): string {
  const ex = exercise as Record<string, unknown>;
  return String(ex.primary_muscle ?? ex.primaryMuscle ?? ex._primary_muscle ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function roleOf(exercise: unknown): string {
  const ex = exercise as Record<string, unknown>;
  return String(ex._role ?? ex.slot_role ?? ex.role ?? ex._slot ?? '')
    .trim()
    .toLowerCase();
}

function isWarmupOrCore(exercise: unknown): boolean {
  const role = roleOf(exercise);
  return role.includes('warm') || role === 'core';
}

function affectedMusclesFor(workout: WorkoutDay, focusKey: string | null): string[] {
  const focusMuscles = focusKey ? FOCUS_MUSCLES[focusKey] : null;
  if (focusMuscles?.length) return focusMuscles;
  const muscles = new Set<string>();
  for (const ex of workout.exercises ?? []) {
    const muscle = primaryMuscle(ex);
    if (muscle) muscles.add(muscle);
  }
  return Array.from(muscles);
}

function averageFatigue(muscles: string[], muscleFatigue?: Record<string, number> | null): number | null {
  if (!muscleFatigue || muscles.length === 0) return null;
  const values = muscles
    .map(m => Number(muscleFatigue[m] ?? 0))
    .filter(v => Number.isFinite(v));
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function focusReadinessFor(
  focusKey: string | null,
  muscles: string[],
  muscleFatigue?: Record<string, number> | null,
  focusReadiness?: Record<string, number> | null,
): number | null {
  if (focusKey && focusReadiness) {
    const direct = normalizedReadiness(focusReadiness[focusKey]);
    if (direct != null) return direct;
    if (focusKey === 'legs') {
      const lower = normalizedReadiness(focusReadiness.lower);
      if (lower != null) return lower;
    }
    if (focusKey === 'lower') {
      const legs = normalizedReadiness(focusReadiness.legs);
      if (legs != null) return legs;
    }
  }
  const avg = averageFatigue(muscles, muscleFatigue);
  return avg == null ? null : Math.max(0, Math.min(100, Math.round((1 - avg) * 100)));
}

function humanMuscle(muscle: string): string {
  return muscle.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function topFatiguedMuscles(
  muscles: string[],
  muscleFatigue?: Record<string, number> | null,
  threshold = 0.45,
): string[] {
  if (!muscleFatigue) return [];
  return muscles
    .map(muscle => ({ muscle, fatigue: Number(muscleFatigue[muscle] ?? 0) }))
    .filter(row => Number.isFinite(row.fatigue) && row.fatigue >= threshold)
    .sort((a, b) => b.fatigue - a.fatigue)
    .map(row => humanMuscle(row.muscle))
    .slice(0, 3);
}

function isHardStimulus(workout: WorkoutDay): boolean {
  const stimulus = String(workout.stimulus ?? '').toLowerCase();
  return stimulus === 'strength' || stimulus === 'power';
}

export function recommendReadinessWorkoutAdjustment(input: RecommendInput): ReadinessWorkoutRecommendation | null {
  const workout = input.workout;
  if (!workout || !Array.isArray(workout.exercises) || workout.exercises.length === 0) return null;
  const stimulus = String(workout.stimulus ?? '').toLowerCase();
  if (RECOVERY_STIMULI.has(stimulus)) return null;
  if (String(workout._source_context ?? '').includes('readiness_lighter_day')) return null;
  if (String(workout._source_context ?? '').includes('period_lighter_day')) return null;

  const focusKey = focusKeyFor(workout);
  const muscles = affectedMusclesFor(workout, focusKey);
  const readiness = focusReadinessFor(focusKey, muscles, input.muscleFatigue, input.focusReadiness);
  if (readiness == null || readiness >= 60) return null;

  const peakFatigue = input.muscleFatigue
    ? Math.max(0, ...muscles.map(m => Number(input.muscleFatigue?.[m] ?? 0)).filter(Number.isFinite))
    : 0;
  if (readiness >= 45 && !isHardStimulus(workout) && peakFatigue < 0.55) return null;

  const affected = topFatiguedMuscles(muscles, input.muscleFatigue);
  const muscleLabel = affected.length ? affected.join(', ') : (focusKey ?? 'target muscles').replace(/_/g, ' ');

  if (readiness < 30) {
    return {
      kind: 'recovery',
      severity: 'very_high',
      readiness,
      title: 'Recovery fits better today',
      detail: `${muscleLabel} readiness is ${readiness}%. A recovery day is the better default unless this session is intentionally easy.`,
      affectedMuscles: affected,
    };
  }

  if (readiness < 45) {
    return {
      kind: 'lighten',
      severity: 'high',
      readiness,
      title: 'Lighten today',
      detail: `${muscleLabel} readiness is ${readiness}%. Cut volume and leave extra reps in reserve for this session.`,
      affectedMuscles: affected,
    };
  }

  return {
    kind: 'lighten',
    severity: 'moderate',
    readiness,
    title: 'Consider a lighter version',
    detail: `${muscleLabel} readiness is ${readiness}%. Keep the pattern, but avoid max-effort loading today.`,
    affectedMuscles: affected,
  };
}

function roundToNearest2_5(value: number): number {
  return Math.max(0, Math.round(value / 2.5) * 2.5);
}

function lighterTargetWeight(value: unknown, pct: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return roundToNearest2_5(value * (1 - pct));
}

function shouldAdjustExercise(
  exercise: unknown,
  affectedKeys: Set<string>,
  severity: ReadinessAdjustmentSeverity,
): boolean {
  if (isWarmupOrCore(exercise)) return false;
  if (severity !== 'moderate') return true;
  const muscle = primaryMuscle(exercise);
  return !muscle || affectedKeys.has(muscle);
}

function nextSetCount(currentSets: number, severity: ReadinessAdjustmentSeverity): number {
  if (severity === 'moderate') return Math.max(1, currentSets - 1);
  if (currentSets >= 4) return Math.max(1, currentSets - 2);
  return Math.max(1, currentSets - 1);
}

export function reduceWorkoutForReadiness(input: ApplyInput): WorkoutDay {
  const { workout, recommendation } = input;
  const severity = recommendation.severity;
  const pct = severity === 'moderate' ? 0.05 : 0.10;
  const rirBump = severity === 'moderate' ? 1 : 2;
  const minRest = severity === 'moderate' ? 90 : 120;
  const focusKey = focusKeyFor(workout);
  const affectedKeys = new Set(affectedMusclesFor(workout, focusKey));

  return {
    ...workout,
    _source_context: 'readiness_lighter_day',
    stimulus: ['strength', 'power'].includes(String(workout.stimulus ?? '').toLowerCase())
      ? 'hypertrophy'
      : workout.stimulus,
    exercises: (workout.exercises ?? []).map(ex => {
      if (!shouldAdjustExercise(ex, affectedKeys, severity)) return ex;
      const currentSets = Math.max(1, Number(ex.sets) || 3);
      const sets = nextSetCount(currentSets, severity);
      const next = {
        ...ex,
        sets,
        restSeconds: Math.max(Number(ex.restSeconds) || 60, minRest),
      };

      const lighterWeight = lighterTargetWeight(ex.targetWeightLbs, pct);
      if (lighterWeight != null) next.targetWeightLbs = lighterWeight;

      if (Array.isArray(ex.setScheme)) {
        next.setScheme = ex.setScheme.slice(0, sets).map(set => ({
          ...set,
          targetRir: Math.min(5, Math.max(0, Number(set.targetRir ?? 0) + rirBump)),
          targetWeightLbs: lighterTargetWeight(set.targetWeightLbs, pct),
        }));
      }

      return next;
    }),
  };
}
