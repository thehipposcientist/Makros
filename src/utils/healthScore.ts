/**
 * Health-enhanced fitness score and recovery marker.
 *
 * Scoring breakdown (0–100):
 *   Workout completed (in-app)    0–40  ← biggest factor
 *   Avg daily steps (7d)          0–15
 *   Recent workout count (7d)     0–15  (HealthKit + in-app)
 *   Sleep (7d average)            0–15
 *   Resting heart rate            0–10
 *   Active energy (7d)            0–5   (optional bonus)
 *
 * Recovery marker (Green / Yellow / Red):
 *   Based on last night sleep vs 7d average, resting HR, and recent load.
 *
 * All inputs are optional — missing data gets neutral/zero points.
 * This module has NO Apple/HealthKit dependency — pure scoring logic.
 */

import type { HealthSummary, HealthScoreResult, RecoveryMarker } from '../types';

interface ScoreContext {
  /** Number of in-app completed workouts in the last 14 days */
  appWorkouts14d: number;
  /** User's target days per week */
  targetDaysPerWeek: number;
  /** Health data from Apple Health (null if not connected) */
  health: HealthSummary | null;
}

/**
 * Calculate the health-enhanced fitness score and recovery marker.
 * Deterministic — same inputs always produce the same output.
 */
export function calculateHealthScore(ctx: ScoreContext): HealthScoreResult {
  const h = ctx.health;

  // ── 1. Workout points (0–40) ───────────────────────────────────────────────
  // In-app completed workouts vs target over 14 days
  const target14 = Math.max(1, ctx.targetDaysPerWeek * 2);
  const workoutRatio = Math.min(1, ctx.appWorkouts14d / target14);
  const workoutPoints = Math.round(workoutRatio * 40);

  // ── 2. Steps points (0–15) ─────────────────────────────────────────────────
  // 10k steps/day = full points, linear scale
  let stepsPoints = 0;
  if (h?.avgSteps7d != null) {
    stepsPoints = Math.min(15, Math.round((h.avgSteps7d / 10000) * 15));
  }

  // ── 3. Consistency / recent workout count (0–15) ───────────────────────────
  // HealthKit workout count over 7 days — target = daysPerWeek
  let consistencyPoints = 0;
  if (h?.workouts7d != null) {
    const ratio = Math.min(1, h.workouts7d / Math.max(1, ctx.targetDaysPerWeek));
    consistencyPoints = Math.round(ratio * 15);
  } else {
    // Fallback: use in-app data scaled down (14d data → estimate 7d)
    const est7d = Math.round(ctx.appWorkouts14d / 2);
    const ratio = Math.min(1, est7d / Math.max(1, ctx.targetDaysPerWeek));
    consistencyPoints = Math.round(ratio * 15);
  }

  // ── 4. Heart rate points (0–10) ────────────────────────────────────────────
  // Lower resting HR = better fitness. 50bpm = 10pts, 80bpm = 0pts
  let heartRatePoints = 5; // neutral default
  if (h?.restingHeartRate != null) {
    const rhr = h.restingHeartRate;
    // Linear scale: 50bpm → 10, 65bpm → 5, 80bpm → 0
    heartRatePoints = Math.min(10, Math.max(0, Math.round(10 - ((rhr - 50) / 3))));
  }

  // ── 5. Sleep points (0–15) ─────────────────────────────────────────────────
  // 7-9 hours average = full points
  let sleepPoints = 0;
  if (h?.avgSleepHours7d != null) {
    const hrs = h.avgSleepHours7d;
    if (hrs >= 7 && hrs <= 9) {
      sleepPoints = 15;
    } else if (hrs >= 6) {
      sleepPoints = Math.round(((hrs - 5) / 2) * 15); // 5h→0, 7h→15
    } else if (hrs > 9) {
      sleepPoints = Math.max(8, 15 - Math.round((hrs - 9) * 3)); // slight penalty for oversleeping
    } else {
      sleepPoints = Math.max(0, Math.round((hrs / 6) * 10)); // <6h, poor
    }
  }

  // ── 6. Active energy bonus (0–5) ──────────────────────────────────────────
  // 2000 kcal/week burned = full bonus
  let activeEnergyPoints = 0;
  if (h?.activeEnergy7d != null) {
    activeEnergyPoints = Math.min(5, Math.round((h.activeEnergy7d / 2000) * 5));
  }

  const fitnessScore = Math.min(100,
    workoutPoints + stepsPoints + consistencyPoints +
    heartRatePoints + sleepPoints + activeEnergyPoints
  );

  // ── Recovery marker ────────────────────────────────────────────────────────
  const recoveryInputs = buildRecoveryInputs(ctx);
  const recoveryMarker = determineRecoveryMarker(recoveryInputs);

  return {
    fitnessScore,
    recoveryMarker,
    scoreInputs: {
      workoutPoints,
      stepsPoints,
      consistencyPoints,
      heartRatePoints,
      sleepPoints,
      activeEnergyPoints,
    },
    recoveryInputs,
  };
}

// ── Recovery marker logic ────────────────────────────────────────────────────

function buildRecoveryInputs(ctx: ScoreContext): HealthScoreResult['recoveryInputs'] {
  const h = ctx.health;

  // Sleep vs average
  let sleepVsAverage: number | null = null;
  if (h?.lastNightSleepHours != null && h?.avgSleepHours7d != null) {
    sleepVsAverage = Math.round((h.lastNightSleepHours - h.avgSleepHours7d) * 10) / 10;
  }

  // RHR status
  let rhrStatus: 'normal' | 'elevated' | 'unknown' = 'unknown';
  if (h?.restingHeartRate != null) {
    rhrStatus = h.restingHeartRate > 75 ? 'elevated' : 'normal';
  }

  // Recent load based on workout count in 7 days
  const workouts = h?.workouts7d ?? Math.round(ctx.appWorkouts14d / 2);
  let recentLoad: 'light' | 'moderate' | 'heavy' = 'moderate';
  if (workouts >= ctx.targetDaysPerWeek + 1) {
    recentLoad = 'heavy';
  } else if (workouts <= Math.max(1, ctx.targetDaysPerWeek - 2)) {
    recentLoad = 'light';
  }

  return { sleepVsAverage, rhrStatus, recentLoad };
}

function determineRecoveryMarker(
  inputs: HealthScoreResult['recoveryInputs']
): RecoveryMarker {
  let redFlags = 0;
  let yellowFlags = 0;

  // Sleep check: last night significantly below average
  if (inputs.sleepVsAverage != null) {
    if (inputs.sleepVsAverage < -1.5) redFlags++;
    else if (inputs.sleepVsAverage < -0.5) yellowFlags++;
  }

  // RHR check
  if (inputs.rhrStatus === 'elevated') yellowFlags++;

  // Load check: heavy load + any other flag = concern
  if (inputs.recentLoad === 'heavy') yellowFlags++;

  if (redFlags >= 1 || (yellowFlags >= 2 && inputs.recentLoad === 'heavy')) {
    return 'red';
  }
  if (yellowFlags >= 1) {
    return 'yellow';
  }
  return 'green';
}

/**
 * Human-readable labels for the recovery marker.
 */
export const RECOVERY_LABELS: Record<RecoveryMarker, { emoji: string; label: string; advice: string }> = {
  green:  { emoji: '🟢', label: 'Good to go',    advice: 'Recovery looks solid — train as planned.' },
  yellow: { emoji: '🟡', label: 'Moderate',       advice: 'Consider lighter intensity or extra rest between sets.' },
  red:    { emoji: '🔴', label: 'Recovery needed', advice: 'Your body could use a break — try active recovery or a rest day.' },
};
