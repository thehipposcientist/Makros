import type { WorkoutDay } from '../types';
import { clampDisplayedSessionMinutes } from './sessionDuration';

function parseWorkSecondsPerSet(reps: unknown, exerciseName?: string, primaryMuscle?: string): number | null {
  if (reps == null) return null;
  const s = String(reps).trim().toLowerCase();
  if (!s) return null;

  const secMatch = s.match(/^(\d+)(?:\s*-\s*(\d+))?\s*(s|sec|secs|second|seconds)\b/);
  if (secMatch) {
    const lo = parseInt(secMatch[1], 10);
    const hi = secMatch[2] ? parseInt(secMatch[2], 10) : lo;
    const base = Math.round((lo + hi) / 2);
    return s.includes('each') ? base * 2 : base;
  }

  const minMatch = s.match(/^(\d+)(?:\s*-\s*(\d+))?\s*(min|mins|minute|minutes)\b/);
  if (minMatch) {
    const lo = parseInt(minMatch[1], 10);
    const hi = minMatch[2] ? parseInt(minMatch[2], 10) : lo;
    return Math.round(((lo + hi) / 2) * 60);
  }

  if (s.includes('each')) {
    const repMatch = s.match(/^(\d+)/);
    if (repMatch) return parseInt(repMatch[1], 10) * 10 * 2;
  }

  if (s.includes('slow')) {
    const repMatch = s.match(/^(\d+)/);
    if (repMatch) return parseInt(repMatch[1], 10) * 5;
  }

  const bareNum = s.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (bareNum) {
    const lo = parseInt(bareNum[1], 10);
    const hi = bareNum[2] ? parseInt(bareNum[2], 10) : lo;
    const mid = Math.round((lo + hi) / 2);
    if (mid >= 20) {
      const pm = (primaryMuscle ?? '').toLowerCase();
      if (pm === 'cardio') return mid * 60;
      const name = (exerciseName ?? '').toLowerCase();
      const isCardio = ['elliptical', 'treadmill', 'bike', 'cycling', 'running', 'jogging', 'walk', 'rowing', 'stair', 'swim', 'cardio', 'zone'].some(k => name.includes(k));
      if (isCardio) return mid * 60;
    }
  }

  return null;
}

export function estimateWorkoutMinutes(workout: Pick<WorkoutDay, 'exercises'>, sessionMinutes?: number | null): number {
  const REST_FUDGE = 1.10;
  const TRANSITION_STRENGTH_SEC = 45;
  const TRANSITION_MOBILITY_SEC = 15;
  const WORK_STRENGTH_SEC = 55;

  const secs = workout.exercises.reduce((total, ex, idx) => {
    const sets = Number(ex.sets) || 3;
    const rest = Number((ex as any).restSeconds ?? (ex as any).rest_seconds) || 60;
    const timedWorkSec = parseWorkSecondsPerSet((ex as any).reps, ex.name, (ex as any).primary_muscle ?? (ex as any)._primary_muscle);
    const restTotal = Math.max(0, sets - 1) * rest * REST_FUDGE;
    const isLast = idx === workout.exercises.length - 1;
    const exPrimaryMuscle = ((ex as any).primary_muscle ?? (ex as any)._primary_muscle ?? '').toLowerCase();
    const exTrainingType = ((ex as any)._training_type ?? (ex as any).training_type ?? '').toLowerCase();
    const exRole = ((ex as any)._role ?? '').toLowerCase();
    const isMobility = exPrimaryMuscle === 'mobility'
      || exTrainingType === 'mobility' || exTrainingType === 'recovery' || exTrainingType === 'stretch'
      || exRole === 'warmup'
      || /mobility|stretch|warm.?up|flow|pose|dog|cat|hip|shoulder.dis|dead hang/i.test(ex.name);
    const transition = isLast ? 0 : (isMobility ? TRANSITION_MOBILITY_SEC : TRANSITION_STRENGTH_SEC);

    if (timedWorkSec != null) {
      return total + sets * timedWorkSec + restTotal + transition;
    }
    return total + sets * WORK_STRENGTH_SEC + restTotal + transition;
  }, 0);

  const rawMinutes = Math.max(1, Math.round(secs / 60));
  return clampDisplayedSessionMinutes(rawMinutes, sessionMinutes);
}
