export type GoalTrajectoryConfidence = 'low' | 'medium' | 'high';
export type GoalTrajectoryTone = 'success' | 'warning' | 'neutral';
export type WeightUnit = 'lbs' | 'kg';
export type DistanceUnit = 'mi' | 'km';

export type GoalTrajectoryProfile = {
  goal?: string | null;
  goalSelection?: { category?: string | null } | null;
  goalDetails?: {
    targetWeightLbs?: number | null;
    startWeightLbs?: number | null;
  } | null;
  physicalStats?: { weightLbs?: number | null } | null;
  daysPerWeek?: number | null;
};

export type GoalTrajectoryWeightEntry = {
  date: string;
  weightLbs: number;
};

export type GoalTrajectoryWorkoutSession = {
  date: string;
  completed?: boolean;
  skipped?: boolean;
  exercises?: Array<{ sets?: unknown[] | null }> | null;
};

export type GoalTrajectoryWorkoutSummary = {
  date: string;
  totalSets?: number | null;
  durationSeconds?: number | null;
};

export type GoalTrajectoryMealAverages = {
  window_days: number;
  days_with_data: number;
  tracking_rate_pct?: number | null;
  avg_protein_g?: number | null;
  avg_protein_g_when_logged?: number | null;
};

export type GoalTrajectoryMealEntry = {
  meal_date: string;
};

export type GoalTrajectoryPacePoint = {
  date: string;
  distance?: number | null;
};

export type GoalTrajectoryLift = {
  name: string;
  oneRepMaxLbs: number;
  confidence?: number | null;
  sessionCount?: number | null;
};

export type GoalTrajectoryStat = {
  label: string;
  value: string;
  detail: string;
};

export type GoalTrajectoryModel = {
  headline: string;
  subheadline: string;
  progressPct: number;
  progressLabel: string;
  confidence: GoalTrajectoryConfidence;
  confidenceDetail: string;
  tone: GoalTrajectoryTone;
  lever: string;
  stats: GoalTrajectoryStat[];
};

export type BuildGoalTrajectoryInput = {
  profile: GoalTrajectoryProfile;
  weightEntries?: GoalTrajectoryWeightEntry[] | null;
  history?: GoalTrajectoryWorkoutSession[] | null;
  summaries?: GoalTrajectoryWorkoutSummary[] | null;
  mealAverages?: GoalTrajectoryMealAverages | null;
  mealHistory?: GoalTrajectoryMealEntry[] | null;
  paceHistory?: GoalTrajectoryPacePoint[] | null;
  oneRepMaxLifts?: GoalTrajectoryLift[] | null;
  weightUnit?: WeightUnit;
  distanceUnit?: DistanceUnit;
  today?: Date;
};

const DAY_MS = 86400000;
const LBS_PER_KG = 2.2046226218;
const MI_PER_KM = 0.6213711922;
const PROJECTION_WEEKS = 6;
const RECENT_DAYS = 14;
const WEIGHT_TREND_DAYS = 42;

const FAT_LOSS_GOALS = new Set(['lose_fat', 'get_lean', 'cut', 'preserve_muscle_cutting', 'tone', 'get_toned']);
const MUSCLE_GOALS = new Set([
  'build_muscle', 'lean_bulk', 'gain_weight', 'improve_aesthetics',
  'build_glutes', 'build_upper_body', 'build_lower_body', 'build_arms', 'build_shoulders',
]);
const STRENGTH_GOALS = new Set([
  'build_strength', 'increase_overall', 'improve_1rm', 'powerlifting', 'improve_squat',
  'improve_bench', 'improve_deadlift', 'improve_ohp', 'improve_pullups', 'improve_grip',
  'functional_strength', 'explosive_strength', 'relative_strength',
]);
const ENDURANCE_GOALS = new Set([
  'improve_cardio', 'improve_conditioning', 'aerobic_base', 'improve_vo2', 'increase_stamina',
  'running_fitness', 'train_5k', 'train_10k', 'train_half', 'train_marathon', 'sprint_speed',
  'interval_perf', 'hiking_endurance', 'cycling_endurance', 'rowing_endurance', 'swimming_endurance',
  'work_capacity',
]);
const ATHLETIC_GOALS = new Set([
  'improve_athleticism', 'improve_speed', 'improve_agility', 'improve_power', 'improve_vertical',
  'improve_acceleration', 'improve_cod', 'improve_coordination', 'improve_balance',
  'sport_performance', 'offseason_training', 'inseason_maintenance', 'return_to_sport', 'hyrox',
]);

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatWeight(lbs: number | null | undefined, unit: WeightUnit = 'lbs', opts?: { precision?: number }): string {
  if (lbs == null || !Number.isFinite(lbs)) return '-';
  const value = unit === 'kg' ? lbs / LBS_PER_KG : lbs;
  const precision = opts?.precision ?? (unit === 'kg' ? 1 : 0);
  const formatted = precision > 0 ? value.toFixed(precision) : Math.round(value).toString();
  return `${formatted} ${unit}`;
}

function formatDistance(mi: number | null | undefined, unit: DistanceUnit = 'mi'): string {
  if (mi == null || !Number.isFinite(mi)) return '-';
  const value = unit === 'km' ? mi / MI_PER_KM : mi;
  return `${value.toFixed(1)} ${unit}`;
}

function dayKey(raw: string | null | undefined): string {
  const key = String(raw ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : '';
}

function dayMs(raw: string | null | undefined): number {
  const key = dayKey(raw);
  if (!key) return 0;
  const ms = new Date(`${key}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inRecentWindow(raw: string | null | undefined, today: Date, days: number): boolean {
  const ms = dayMs(raw);
  if (!ms) return false;
  const end = dayMs(dateKey(today));
  const start = end - (days - 1) * DAY_MS;
  return ms >= start && ms <= end;
}

function resolveGoalBucket(profile: GoalTrajectoryProfile): 'fat_loss' | 'muscle_gain' | 'body_recomp' | 'strength' | 'endurance' | 'athletic' | 'general' {
  const goal = String(profile.goal ?? '');
  if (goal === 'body_recomp') return 'body_recomp';
  if (FAT_LOSS_GOALS.has(goal)) return 'fat_loss';
  if (MUSCLE_GOALS.has(goal)) return 'muscle_gain';
  if (STRENGTH_GOALS.has(goal)) return 'strength';
  if (ENDURANCE_GOALS.has(goal)) return 'endurance';
  if (ATHLETIC_GOALS.has(goal)) return 'athletic';

  const category = String(profile.goalSelection?.category ?? '');
  if (category === 'fat_loss') return 'fat_loss';
  if (category === 'muscle_physique') return 'muscle_gain';
  if (category === 'strength') return 'strength';
  if (category === 'cardio_endurance') return 'endurance';
  if (category === 'athletic_performance') return 'athletic';
  return 'general';
}

function countRecentWorkoutDays(
  history: GoalTrajectoryWorkoutSession[],
  summaries: GoalTrajectoryWorkoutSummary[],
  today: Date,
): number {
  const days = new Set<string>();
  for (const summary of summaries) {
    const totalSets = finite(summary.totalSets) ?? 0;
    const minutes = Math.round((finite(summary.durationSeconds) ?? 0) / 60);
    if ((totalSets > 0 || minutes > 0) && inRecentWindow(summary.date, today, RECENT_DAYS)) {
      days.add(dayKey(summary.date));
    }
  }
  for (const session of history) {
    if (!session.completed || session.skipped || !inRecentWindow(session.date, today, RECENT_DAYS)) continue;
    const hasSets = (session.exercises ?? []).some(ex => (ex.sets?.length ?? 0) > 0);
    if (hasSets) days.add(dayKey(session.date));
  }
  return days.size;
}

function countRecentMealDays(
  mealHistory: GoalTrajectoryMealEntry[],
  mealAverages: GoalTrajectoryMealAverages | null,
  today: Date,
): { days: number; windowDays: number; trackingPct: number } {
  const windowDays = Math.max(1, Math.round(finite(mealAverages?.window_days) ?? 7));
  const recent = new Set(
    mealHistory
      .filter(row => inRecentWindow(row.meal_date, today, Math.min(RECENT_DAYS, windowDays)))
      .map(row => dayKey(row.meal_date))
      .filter(Boolean),
  );
  const days = Math.max(recent.size, Math.round(finite(mealAverages?.days_with_data) ?? 0));
  const rawTracking = finite(mealAverages?.tracking_rate_pct);
  const trackingPct = rawTracking != null
    ? clamp(Math.round(rawTracking), 0, 100)
    : clamp(Math.round((days / windowDays) * 100), 0, 100);
  return { days, windowDays, trackingPct };
}

function weightTrend(
  entries: GoalTrajectoryWeightEntry[],
  today: Date,
): {
  slopeLbsPerWeek: number | null;
  sampleCount: number;
  spanDays: number;
  latestWeightLbs: number | null;
} {
  const todayMs = dayMs(dateKey(today));
  const sorted = entries
    .filter(e => finite(e.weightLbs) != null && dayMs(e.date) > 0 && dayMs(e.date) <= todayMs)
    .sort((a, b) => dayMs(a.date) - dayMs(b.date));
  if (sorted.length === 0) {
    return { slopeLbsPerWeek: null, sampleCount: 0, spanDays: 0, latestWeightLbs: null };
  }

  const recent = sorted.filter(e => dayMs(e.date) >= todayMs - (WEIGHT_TREND_DAYS - 1) * DAY_MS);
  const sample = recent.length >= 2 ? recent : sorted;
  const first = sample[0];
  const latest = sample[sample.length - 1];
  const spanDays = Math.max(0, Math.round((dayMs(latest.date) - dayMs(first.date)) / DAY_MS));
  const firstWeight = finite(first.weightLbs);
  const latestWeight = finite(latest.weightLbs);
  if (sample.length < 2 || spanDays < 7 || firstWeight == null || latestWeight == null) {
    return { slopeLbsPerWeek: null, sampleCount: sample.length, spanDays, latestWeightLbs: latestWeight };
  }
  const slope = ((latestWeight - firstWeight) / Math.max(1, spanDays)) * 7;
  return {
    slopeLbsPerWeek: round1(clamp(slope, -3, 3)),
    sampleCount: sample.length,
    spanDays,
    latestWeightLbs: latestWeight,
  };
}

function confidenceFromSignals(weight: ReturnType<typeof weightTrend>, workoutDays: number, mealDays: number): GoalTrajectoryConfidence {
  let score = 0;
  if (weight.sampleCount >= 3 && weight.spanDays >= 14) score += 2;
  else if (weight.sampleCount >= 2 && weight.spanDays >= 7) score += 1;
  if (workoutDays >= 4) score += 2;
  else if (workoutDays >= 2) score += 1;
  if (mealDays >= 4) score += 2;
  else if (mealDays >= 2) score += 1;
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function confidenceDetail(confidence: GoalTrajectoryConfidence): string {
  if (confidence === 'high') return 'Weight, training, and nutrition signals are populated.';
  if (confidence === 'medium') return 'Enough recent signal for a directional estimate.';
  return 'Add more logs to sharpen the projection.';
}

function formatChange(deltaLbs: number, unit: WeightUnit): string {
  return formatWeight(Math.abs(deltaLbs), unit, { precision: unit === 'kg' ? 1 : 1 });
}

function activeTone(desiredDirection: -1 | 0 | 1, slope: number | null): GoalTrajectoryTone {
  if (slope == null) return 'neutral';
  if (desiredDirection === 0) return Math.abs(slope) <= 0.35 ? 'success' : 'neutral';
  if (Math.abs(slope) < 0.05) return 'neutral';
  return Math.sign(slope) === desiredDirection ? 'success' : 'warning';
}

function progressForWeightGoal(currentWeight: number | null, startWeight: number | null, targetWeight: number | null): number | null {
  if (currentWeight == null || startWeight == null || targetWeight == null) return null;
  const total = Math.abs(targetWeight - startWeight);
  if (total <= 0.1) return null;
  return clamp(Math.abs(currentWeight - startWeight) / total, 0, 1);
}

function projectedTrainingDays(workoutDays14: number): number {
  return Math.round((workoutDays14 / RECENT_DAYS) * PROJECTION_WEEKS * 7);
}

function topLiftLabel(lift: GoalTrajectoryLift | null, weightUnit: WeightUnit): string | null {
  if (!lift) return null;
  return `${lift.name}: ${formatWeight(lift.oneRepMaxLbs, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} e1RM`;
}

export function buildGoalTrajectory(input: BuildGoalTrajectoryInput): GoalTrajectoryModel {
  const today = input.today ?? new Date();
  const weightUnit = input.weightUnit ?? 'lbs';
  const distanceUnit = input.distanceUnit ?? 'mi';
  const profile = input.profile;
  const bucket = resolveGoalBucket(profile);
  const weights = input.weightEntries ?? [];
  const history = input.history ?? [];
  const summaries = input.summaries ?? [];
  const mealHistory = input.mealHistory ?? [];
  const mealAverages = input.mealAverages ?? null;
  const weight = weightTrend(weights, today);
  const workoutDays = countRecentWorkoutDays(history, summaries, today);
  const planned14 = Math.max(1, Math.round(finite(profile.daysPerWeek) ?? 3) * 2);
  const workoutPct = clamp(Math.round((workoutDays / planned14) * 100), 0, 120);
  const meals = countRecentMealDays(mealHistory, mealAverages, today);
  const confidence = confidenceFromSignals(weight, workoutDays, meals.days);
  const confidenceText = confidenceDetail(confidence);
  const currentWeight = weight.latestWeightLbs ?? finite(profile.physicalStats?.weightLbs);
  const targetWeight = finite(profile.goalDetails?.targetWeightLbs);
  const startWeight = finite(profile.goalDetails?.startWeightLbs)
    ?? weights.find(e => finite(e.weightLbs) != null)?.weightLbs
    ?? currentWeight;
  const projectedDelta = weight.slopeLbsPerWeek == null ? null : round1(weight.slopeLbsPerWeek * PROJECTION_WEEKS);
  const cardioMiles14 = (input.paceHistory ?? [])
    .filter(point => inRecentWindow(point.date, today, RECENT_DAYS))
    .reduce((sum, point) => sum + Math.max(0, finite(point.distance) ?? 0), 0);
  const topLift = (input.oneRepMaxLifts ?? []).find(lift => finite(lift.oneRepMaxLbs) != null) ?? null;
  const projectedWorkouts = projectedTrainingDays(workoutDays);
  const consistencyPct = clamp(Math.round((Math.min(100, workoutPct) * 0.65) + (meals.trackingPct * 0.35)), 0, 100);

  let headline = `On pace for ${projectedWorkouts} training days in 6 weeks`;
  let subheadline = `${workoutDays}/${planned14} planned training days logged over the last 14 days.`;
  let progressPct = consistencyPct / 100;
  let progressLabel = `Consistency pace ${consistencyPct}%`;
  let desiredDirection: -1 | 0 | 1 = 0;

  if (bucket === 'fat_loss' || bucket === 'muscle_gain') {
    desiredDirection = bucket === 'fat_loss' ? -1 : 1;
    const weightProgress = progressForWeightGoal(currentWeight, startWeight, targetWeight);
    if (weightProgress != null) {
      progressPct = weightProgress;
      progressLabel = `${Math.round(weightProgress * 100)}% to target`;
    }

    if (projectedDelta != null && Math.abs(projectedDelta) >= 0.3) {
      const verb = projectedDelta < 0 ? 'lose' : 'gain';
      headline = `On pace to ${verb} ${formatChange(projectedDelta, weightUnit)} in 6 weeks`;
      if (targetWeight != null && currentWeight != null) {
        const remaining = Math.abs(targetWeight - currentWeight);
        subheadline = `${formatWeight(remaining, weightUnit, { precision: weightUnit === 'kg' ? 1 : 1 })} from target if this trend holds.`;
      } else {
        subheadline = `${weight.sampleCount} weigh-ins across ${weight.spanDays} days.`;
      }
    } else if (targetWeight != null) {
      headline = `Target: ${formatWeight(targetWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 1 })}`;
      subheadline = weight.sampleCount >= 2
        ? 'Scale trend is mostly flat over the current sample.'
        : 'Need more weigh-ins for a 6-week pace estimate.';
    }
  } else if (bucket === 'body_recomp') {
    desiredDirection = 0;
    headline = topLift
      ? `Top marker: ${topLiftLabel(topLift, weightUnit)}`
      : '6-week target: hold scale while consistency climbs';
    subheadline = weight.slopeLbsPerWeek == null
      ? `${projectedWorkouts} projected training days if this pace holds.`
      : `Scale trend: ${formatChange(weight.slopeLbsPerWeek, weightUnit)}/week ${weight.slopeLbsPerWeek > 0 ? 'up' : weight.slopeLbsPerWeek < 0 ? 'down' : 'flat'}.`;
  } else if (bucket === 'strength') {
    headline = topLift
      ? `Top marker: ${topLiftLabel(topLift, weightUnit)}`
      : `On pace for ${projectedWorkouts} lifting days in 6 weeks`;
    subheadline = topLift
      ? `${projectedWorkouts} projected training days at current consistency.`
      : 'Log loaded sets to unlock strength-specific markers.';
  } else if (bucket === 'endurance') {
    if (cardioMiles14 > 0) {
      headline = `On pace for ${formatDistance(cardioMiles14 * 3, distanceUnit)} in 6 weeks`;
      subheadline = `${formatDistance(cardioMiles14, distanceUnit)} logged over the last 14 days.`;
    } else {
      headline = `On pace for ${projectedWorkouts} training days in 6 weeks`;
      subheadline = 'Log cardio distance to turn this into an endurance estimate.';
    }
  } else if (bucket === 'athletic') {
    headline = `On pace for ${projectedWorkouts} training days in 6 weeks`;
    subheadline = cardioMiles14 > 0
      ? `${formatDistance(cardioMiles14, distanceUnit)} cardio plus ${workoutDays} training days in the last 14 days.`
      : `${workoutDays} training days logged over the last 14 days.`;
  }

  const tone = activeTone(desiredDirection, weight.slopeLbsPerWeek);
  let lever = 'Keep this pace through the next scheduled workout.';
  if (weight.sampleCount < 2 || weight.spanDays < 7) {
    lever = 'Log two weigh-ins this week to sharpen the estimate.';
  } else if (workoutPct < 70) {
    lever = 'Complete the next scheduled workout to pull the trajectory up.';
  } else if (meals.trackingPct < 50) {
    lever = 'Log meals on three more days to make nutrition trendable.';
  } else if ((finite(mealAverages?.avg_protein_g_when_logged) ?? finite(mealAverages?.avg_protein_g) ?? 0) > 0) {
    lever = 'Keep protein consistent while holding the current training pace.';
  }

  const projectionStat: GoalTrajectoryStat = (bucket === 'fat_loss' || bucket === 'muscle_gain') && projectedDelta != null && Math.abs(projectedDelta) >= 0.3
    ? {
        label: '6 wk',
        value: `${projectedDelta > 0 ? '+' : '-'}${formatChange(projectedDelta, weightUnit)}`,
        detail: 'projected scale',
      }
    : bucket === 'endurance' && cardioMiles14 > 0
      ? {
          label: '6 wk',
          value: formatDistance(cardioMiles14 * 3, distanceUnit),
          detail: 'projected distance',
        }
      : {
          label: '6 wk',
          value: `${projectedWorkouts} days`,
          detail: 'projected training',
        };

  return {
    headline,
    subheadline,
    progressPct: clamp(progressPct, 0, 1),
    progressLabel,
    confidence,
    confidenceDetail: confidenceText,
    tone,
    lever,
    stats: [
      projectionStat,
      {
        label: 'Training',
        value: `${workoutDays}/${planned14}`,
        detail: 'last 14 days',
      },
      {
        label: 'Meals',
        value: meals.days > 0 ? `${meals.days}/${meals.windowDays}` : 'Need logs',
        detail: meals.days > 0 ? 'logged days' : 'nutrition signal',
      },
    ],
  };
}
