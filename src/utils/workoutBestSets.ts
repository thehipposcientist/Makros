import type { PRAchievement } from '../services/api';
import type { SessionExercise } from '../types';

export interface WorkoutBestSetHighlight {
  key: string;
  exerciseName: string;
  label: string;
  detail?: string;
  source: 'pr' | 'set' | 'fallback';
}

interface SetCandidate {
  weight: number;
  reps: number;
  volume: number;
  oneRm: number;
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
}

function formatWeight(value: number): string {
  return `${formatNumber(value)} lb`;
}

function formatSet(weight: number, reps: number): string {
  if (weight > 0 && reps > 0) return `${formatWeight(weight)} x ${formatNumber(reps)}`;
  if (reps > 0) return `${formatNumber(reps)} reps`;
  if (weight > 0) return formatWeight(weight);
  return 'Logged set';
}

function estimatedOneRm(weight: number, reps: number): number {
  return weight > 0 && reps > 0 ? weight * (1 + reps / 30) : 0;
}

function prRank(kind: PRAchievement['kind']): number {
  if (kind === 'heaviest_weight') return 3;
  if (kind === 'estimated_1rm') return 2;
  return 1;
}

function labelForPr(pr: PRAchievement): string {
  const weight = numeric(pr.weight_lbs);
  const reps = numeric(pr.reps);
  if (pr.kind === 'heaviest_weight') {
    return `PR - ${pr.exercise_name}: ${formatSet(weight || numeric(pr.new_value), reps)}`;
  }
  if (pr.kind === 'estimated_1rm') {
    const setText = weight > 0 && reps > 0 ? ` (${formatSet(weight, reps)})` : '';
    return `PR - ${pr.exercise_name}: est. 1RM ${formatWeight(numeric(pr.new_value))}${setText}`;
  }
  const setText = weight > 0 && reps > 0 ? ` (${formatSet(weight, reps)})` : '';
  return `PR - ${pr.exercise_name}: ${formatNumber(numeric(pr.new_value))} lb volume${setText}`;
}

export function buildWorkoutBestSetHighlights(
  exercises: SessionExercise[],
  prs: PRAchievement[] = [],
  limit: number = 4,
  fallbackAchievements: string[] = [],
): WorkoutBestSetHighlight[] {
  const highlights = [];
  const usedExercises = new Set();

  const prByExercise = new Map();
  for (const pr of prs) {
    const key = pr.exercise_name.trim().toLowerCase();
    if (!key) continue;
    const current = prByExercise.get(key);
    if (!current || prRank(pr.kind) > prRank(current.kind)) {
      prByExercise.set(key, pr);
    }
  }

  const orderedPrs = Array.from(prByExercise.values()).sort((a, b) => {
    const rankDelta = prRank(b.kind) - prRank(a.kind);
    if (rankDelta !== 0) return rankDelta;
    return numeric(b.new_value) - numeric(a.new_value);
  });

  for (const pr of orderedPrs) {
    const key = pr.exercise_name.trim().toLowerCase();
    highlights.push({
      key: `pr-${key}-${pr.kind}`,
      exerciseName: pr.exercise_name,
      label: labelForPr(pr),
      source: 'pr' as const,
    });
    usedExercises.add(key);
    if (highlights.length >= limit) return highlights;
  }

  const setHighlights = [];
  for (let exerciseIndex = 0; exerciseIndex < exercises.length; exerciseIndex += 1) {
    const exercise = exercises[exerciseIndex];
    const exerciseName = exercise.name || `Exercise ${exerciseIndex + 1}`;
    const exerciseKey = exerciseName.trim().toLowerCase();
    if (!exerciseKey || usedExercises.has(exerciseKey)) continue;

    let bestSet = null;
    for (const loggedSet of exercise.sets ?? []) {
      const weight = numeric((loggedSet as any).weightLbs ?? (loggedSet as any).weight_lbs);
      const reps = numeric(loggedSet.reps);
      if (weight <= 0 && reps <= 0) continue;
      const candidate = {
        weight,
        reps,
        volume: weight * reps,
        oneRm: estimatedOneRm(weight, reps),
      };
      if (!bestSet) {
        bestSet = candidate;
      } else if (
        candidate.weight > bestSet.weight
        || (candidate.weight === bestSet.weight && candidate.oneRm > bestSet.oneRm)
        || (candidate.weight === bestSet.weight && candidate.oneRm === bestSet.oneRm && candidate.volume > bestSet.volume)
        || (candidate.weight === bestSet.weight && candidate.oneRm === bestSet.oneRm && candidate.volume === bestSet.volume && candidate.reps > bestSet.reps)
      ) {
        bestSet = candidate;
      }
    }

    if (!bestSet) continue;
    setHighlights.push({
      key: `set-${exerciseKey}`,
      exerciseName,
      label: `${exerciseName}: ${formatSet(bestSet.weight, bestSet.reps)}`,
      detail: bestSet.weight > 0 ? 'Heaviest set' : 'Best logged set',
      source: 'set' as const,
      weight: bestSet.weight,
      oneRm: bestSet.oneRm,
      volume: bestSet.volume,
      reps: bestSet.reps,
    });
  }

  setHighlights.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    if (b.oneRm !== a.oneRm) return b.oneRm - a.oneRm;
    if (b.volume !== a.volume) return b.volume - a.volume;
    return b.reps - a.reps;
  });

  for (const item of setHighlights) {
    highlights.push({
      key: item.key,
      exerciseName: item.exerciseName,
      label: item.label,
      detail: item.detail,
      source: item.source,
    });
    if (highlights.length >= limit) return highlights;
  }

  if (highlights.length > 0) return highlights;

  return fallbackAchievements.slice(0, limit).map((label, index) => ({
    key: `fallback-${index}`,
    exerciseName: '',
    label,
    source: 'fallback' as const,
  }));
}
