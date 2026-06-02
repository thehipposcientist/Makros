// Shared preparedness loader — single source of truth for the
// 6-pillar readiness score. Both the on-phone TrainingReadinessCard
// and the watch-sync push call this so the watch + phone show
// IDENTICAL numbers. Earlier they each had their own ad-hoc compute
// path with subtly different inputs (different protein source,
// different yesterdayWorkoutMinutes, different focusReadiness mapping)
// and the user got "phone says 94, watch says 79" mismatches.
//
// Pure orchestration — no UI, no state. Returns the input bundle the
// caller can hand directly to scorePreparedness().

import {
  getPlatformCycleStatus,
  isPlatformHealthAvailable,
  loadPlatformSleepHistory,
  readPlatformHealthSummary,
} from './platformHealth';
import { getFatigueScore, getMealAverages } from './api';
import { loadWorkoutHistory } from '../utils/workoutHistory';
import type { PreparednessInput } from './preparedness';
import {
  readinessHrvMsFromSummary,
} from '../utils/readinessHealthSignals';

export interface PreparednessLoaderArgs {
  authToken: string;
  age?: number | null;
  proteinTarget?: number | null;
  calorieTarget?: number | null;
  /** Optional planned focus — when present, backend's per-focus
   *  readiness is preferred over the global one. */
  todaysFocus?: string | null;
  /** Skip the loadHealthSummary network round-trip when caller has it. */
  cachedHealthSummary?: any | null;
}

/** Builds the exact input bundle scorePreparedness expects. Caller
 *  computes the score themselves to keep this function pure. */
export async function loadPreparednessInputs(opts: PreparednessLoaderArgs): Promise<PreparednessInput> {
  const summary = opts.cachedHealthSummary ?? (await readPlatformHealthSummary({ age: opts.age ?? null }).catch(() => null));
  const healthAvailable = isPlatformHealthAvailable() && summary != null;

  const [history, f, meals, cycle] = await Promise.all([
    loadPlatformSleepHistory().catch(() => []),
    getFatigueScore(opts.authToken).catch(() => null),
    getMealAverages(opts.authToken, 7).catch(() => null),
    healthAvailable ? getPlatformCycleStatus().catch(() => null) : Promise.resolve(null),
  ]);

  const workouts = await loadWorkoutHistory().catch(() => []);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yesterdayMin = workouts
    .filter((s: any) => s.date?.slice(0, 10) === yesterday && s.completed)
    .reduce((sum: number, s: any) => sum + ((s.durationSeconds ?? 0) / 60), 0);

  const focusKey = (opts.todaysFocus ?? '').toLowerCase().replace(/\s+/g, '_');
  const focusReadiness =
    focusKey && (f as any)?.focus_readiness?.[focusKey] != null
      ? Math.round((f as any).focus_readiness[focusKey] * 100)
      : (f as any)?.muscle_recovery_score ?? (f as any)?.readiness_score ?? null;

  return {
    sleepScore: healthAvailable ? summary?.sleepScore ?? null : null,
    hrvMs: healthAvailable ? readinessHrvMsFromSummary(summary) : null,
    hrvHistory: (history as any[]).map((n: any) => n.hrv).filter((v: any) => typeof v === 'number' && v > 0),
    restingHeartRate: healthAvailable ? summary?.restingHeartRate ?? null : null,
    rhrHistory: [],
    readinessFromBackend: focusReadiness,
    proteinGrams: (meals as any)?.avg_protein_g ?? null,
    proteinTargetGrams: opts.proteinTarget ?? null,
    calorieIntake: (meals as any)?.avg_calories ?? null,
    calorieTarget: opts.calorieTarget ?? null,
    yesterdayWorkoutMinutes: yesterdayMin > 0 ? yesterdayMin : null,
    age: opts.age ?? null,
    cyclePhase: cycle && (cycle as any).phase !== 'unknown' ? (cycle as any).phase : null,
  };
}
