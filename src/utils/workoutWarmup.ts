import type { WorkoutDay } from '../types';

// Focus keyword -> warmup step pool mapping for buildWarmupPlan.
// Avoids a regex chain; keys are checked with simple string inclusion.
const WARMUP_POOLS: Record<string, string[]> = {
  lower: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats x 10'],
  leg: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats x 10'],
  glute: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats x 10'],
  hinge: ['3 min easy bike or walk', 'Hip circles + ankle rocks (10 each)', 'Bodyweight squats x 10'],
  pull: ['3 min light cardio', 'Band pull-aparts x 15', 'Scap push-ups x 10'],
  back: ['3 min light cardio', 'Band pull-aparts x 15', 'Scap push-ups x 10'],
  push: ['3 min light cardio', 'Arm circles + band dislocates x 10', 'Push-ups x 10'],
  chest: ['3 min light cardio', 'Arm circles + band dislocates x 10', 'Push-ups x 10'],
  shoulder: ['3 min light cardio', 'Arm circles + band dislocates x 10', 'Push-ups x 10'],
  upper: ['3 min light cardio', 'Arm circles + band dislocates x 10', 'Push-ups x 10'],
};
const WARMUP_DEFAULT_POOL = ['2 min light cardio', 'Dynamic stretches for major joints'];

export function buildWarmupPlan(workout: WorkoutDay): string[] {
  const sourceContext = String((workout as any)._source_context ?? (workout as any).sourceContext ?? '').trim();
  if (sourceContext === 'custom_cardio') return [];

  const focus = (workout.focus || '').toLowerCase();
  const stimulus = (workout.stimulus || '').toLowerCase();
  const exercises = Array.isArray(workout.exercises) ? workout.exercises : [];
  const exCount = exercises.length;
  const firstEx = exercises[0];
  const firstExName = firstEx?.name || '';
  const firstLo = firstExName.toLowerCase();
  const firstIsCompound = (firstEx as any)?.is_compound ?? (firstEx as any)?.isCompound;
  const isHeavyCompound = firstIsCompound === true ||
    (firstIsCompound == null && /squat|deadlift|bench|overhead press|ohp|barbell press|clean|snatch|hip thrust/.test(firstLo));

  if (stimulus === 'recovery' || stimulus === 'mobility' || /recovery|mobility|stretch/.test(focus)) {
    return ['Move slowly through the first round to warm up.'];
  }

  let pool: string[] | undefined;
  for (const key of Object.keys(WARMUP_POOLS)) {
    if (focus.includes(key)) {
      pool = WARMUP_POOLS[key];
      break;
    }
  }
  if (!pool) pool = WARMUP_DEFAULT_POOL;

  let prepCount: number;
  if (exCount <= 3) prepCount = 1;
  else if (exCount <= 5) prepCount = 2;
  else prepCount = pool.length;

  const steps = pool.slice(0, prepCount);
  if (firstExName) {
    steps.push(isHeavyCompound ? `2-3 ramp-up sets of ${firstExName}` : `1 light set of ${firstExName}`);
  }
  return steps;
}
