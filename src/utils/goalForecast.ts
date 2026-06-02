export type GoalForecastConfidence = 'low' | 'medium' | 'high';
export type GoalForecastTone = 'success' | 'warning' | 'neutral';
export type GoalForecastBucket = 'fat_loss' | 'muscle_gain' | 'body_recomp' | 'strength' | 'endurance' | 'athletic' | 'hyrox' | 'general';
export type WeightUnit = 'lbs' | 'kg';
export type DistanceUnit = 'mi' | 'km';

export type GoalForecastProfile = {
  goal?: string | null;
  goalSelection?: { category?: string | null } | null;
  goalDetails?: {
    pace?: string | null;
    targetWeightLbs?: number | null;
    startWeightLbs?: number | null;
    startBodyFatPct?: number | null;
    goalStartedAt?: string | null;
  } | null;
  physicalStats?: { weightLbs?: number | null } | null;
  daysPerWeek?: number | null;
};

export type GoalForecastWeightEntry = {
  date: string;
  weightLbs: number;
};

export type GoalForecastWorkoutSession = {
  date: string;
  completed?: boolean;
  skipped?: boolean;
  exercises?: Array<{ sets?: unknown[] | null }> | null;
  durationSeconds?: number | null;
};

export type GoalForecastWorkoutSummary = {
  date: string;
  totalSets?: number | null;
  durationSeconds?: number | null;
  hrZoneMinutes?: [number, number, number, number, number] | null;
};

export type GoalForecastMealAverages = {
  window_days: number;
  days_with_data: number;
  tracking_rate_pct?: number | null;
  avg_protein_g?: number | null;
  avg_protein_g_when_logged?: number | null;
};

export type GoalForecastMealEntry = {
  meal_date: string;
};

export type GoalForecastNutritionWeekly = {
  window_days: number;
  days_with_data: number;
  avg_score: number;
  days_hit_protein?: number | null;
  days_hit_calories?: number | null;
};

export type GoalForecastPacePoint = {
  date: string;
  distance?: number | null;
};

export type GoalForecastLift = {
  name: string;
  oneRepMaxLbs: number;
};

export type GoalForecastBodyScan = {
  date?: string | null;
  bodyFatPct?: number | null;
  weightLbs?: number | null;
};

/** Maintenance + goal-adjusted calorie targets from the backend
 *  `/profile/calorie-ranges` endpoint. Used to personalize the weekly
 *  weight-change rate from the user's actual TDEE rather than a flat
 *  pace constant. Optional — when null, the forecast falls back to the
 *  static pace table. */
export type GoalForecastCalorieRanges = {
  maintenanceCalories: number;
  cutAdjustmentKcal?: number | null;
  bulkAdjustmentKcal?: number | null;
};

export type GoalForecastStat = {
  label: string;
  value: string;
  detail: string;
};

export type GoalForecastExecutionWeights = {
  training: number;
  nutrition: number;
  recovery: number;
};

export type GoalForecastExecutionBreakdown = {
  training: number;
  nutrition: number;
  recovery: number;
  recoveryAssumedNeutral: boolean;
  weights: GoalForecastExecutionWeights;
};

/** "By date X you will be at Y" projection — independent of ETA. Always
 *  projects N weeks out (defaults to WINDOW_WEEKS) at current execution.
 *  `label` is goal-aware: fat-loss/muscle gives projected scale weight,
 *  recomp gives fat-loss range (no absolute BF% unless start scan exists). */
export type GoalForecastHorizon = {
  weeks: number;
  /** ISO date (YYYY-MM-DD) for the projection target. */
  date: string;
  /** Pre-formatted display string. */
  label: string;
  /** Projected scale weight in lbs at the horizon, when applicable. */
  scaleWeightLbs?: number | null;
  /** Projected total fat-mass change over the horizon (positive = fat lost). */
  fatLossLbs?: number | null;
  /** Projected body-fat % at the horizon. Only set when start scan exists. */
  bodyFatPct?: number | null;
};

export type GoalForecastModel = {
  bucket: GoalForecastBucket;
  title: string;
  headline: string;
  subheadline: string;
  metricLabel: string;
  metricValue: string;
  metricDetail: string;
  rawExecution: number;
  executionScore: number;
  executionPct: number;
  forecastMultiplier: number;
  executionBreakdown: GoalForecastExecutionBreakdown;
  progressPct: number;
  confidence: GoalForecastConfidence;
  confidenceDetail: string;
  tone: GoalForecastTone;
  assumption: string;
  updateReason: string;
  drivers: string[];
  limiters: string[];
  stats: GoalForecastStat[];
  /** "In 6 weeks: X" projection. Null when the bucket has no useful
   *  weight-based forecast (strength / endurance / athletic). */
  horizonProjection: GoalForecastHorizon | null;
};

export type BuildGoalForecastInput = {
  profile: GoalForecastProfile;
  weightEntries?: GoalForecastWeightEntry[] | null;
  history?: GoalForecastWorkoutSession[] | null;
  summaries?: GoalForecastWorkoutSummary[] | null;
  mealAverages?: GoalForecastMealAverages | null;
  mealHistory?: GoalForecastMealEntry[] | null;
  nutritionScoreWeekly?: GoalForecastNutritionWeekly | null;
  paceHistory?: GoalForecastPacePoint[] | null;
  oneRepMaxLifts?: GoalForecastLift[] | null;
  bodyScanHistory?: GoalForecastBodyScan[] | null;
  calorieRanges?: GoalForecastCalorieRanges | null;
  vo2Max?: number | null;
  avgSleepHours?: number | null;
  weightUnit?: WeightUnit;
  distanceUnit?: DistanceUnit;
  today?: Date;
};

const DAY_MS = 86400000;
const LBS_PER_KG = 2.2046226218;
const MI_PER_KM = 0.6213711922;
const RECENT_DAYS = 14;
const WEIGHT_TREND_DAYS = 42;
const WINDOW_WEEKS = 6;
const MAX_TARGET_ETA_WEEKS = 104;
const EXECUTION_CAP = 1.08;
const FORECAST_MULTIPLIER_FLOOR = 0.35;

const FAT_LOSS_GOALS = new Set(['lose_fat', 'fat_loss', 'get_lean', 'cut', 'preserve_muscle_cutting', 'tone', 'get_toned', 'toning']);
const MUSCLE_GOALS = new Set([
  'build_muscle', 'muscle_gain', 'lean_bulk', 'gain_weight', 'improve_aesthetics',
  'build_glutes', 'build_upper_body', 'build_lower_body', 'build_arms', 'build_shoulders',
]);
const STRENGTH_GOALS = new Set([
  'strength', 'build_strength', 'increase_overall', 'improve_1rm', 'powerlifting', 'improve_squat',
  'improve_bench', 'improve_deadlift', 'improve_ohp', 'improve_pullups', 'improve_grip',
  'functional_strength', 'explosive_strength', 'relative_strength',
]);
const ENDURANCE_GOALS = new Set([
  'endurance', 'improve_cardio', 'improve_conditioning', 'aerobic_base', 'improve_vo2',
  'increase_stamina', 'running_fitness', 'train_5k', 'train_10k', 'train_half',
  'train_marathon', 'sprint_speed', 'interval_perf', 'hiking_endurance', 'cycling_endurance',
  'rowing_endurance', 'swimming_endurance', 'work_capacity',
]);
const ATHLETIC_GOALS = new Set([
  'athletic_performance', 'improve_athleticism', 'improve_speed', 'improve_agility',
  'improve_power', 'improve_vertical', 'improve_acceleration', 'improve_cod',
  'improve_coordination', 'improve_balance', 'sport_performance', 'offseason_training',
  'inseason_maintenance', 'return_to_sport',
]);

const FAT_LOSS_LBS_PER_WEEK: Record<string, number> = { conservative: 0.5, moderate: 1.0, aggressive: 1.5 };
const MUSCLE_GAIN_LBS_PER_WEEK: Record<string, number> = { conservative: 0.25, moderate: 0.45, aggressive: 0.65 };
const RECOMP_FAT_LOSS_LBS_PER_WEEK: Record<string, [number, number]> = {
  conservative: [0.15, 0.35],
  moderate: [0.2, 0.5],
  aggressive: [0.1, 0.3],
};
const STRENGTH_GAIN_PCT_6W: Record<string, number> = { conservative: 2.0, moderate: 3.5, aggressive: 5.0 };
const VO2_GAIN_6W: Record<string, number> = { conservative: 0.35, moderate: 0.65, aggressive: 0.95 };

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
  const precision = opts?.precision ?? (unit === 'kg' ? 1 : Math.abs(value - Math.round(value)) > 0.001 ? 1 : 0);
  return `${precision > 0 ? value.toFixed(precision) : Math.round(value)} ${unit}`;
}

function formatDistance(mi: number | null | undefined, unit: DistanceUnit = 'mi', opts?: { precision?: number }): string {
  if (mi == null || !Number.isFinite(mi)) return '-';
  const value = unit === 'km' ? mi / MI_PER_KM : mi;
  return `${value.toFixed(opts?.precision ?? 1)} ${unit}`;
}

function paceKey(raw: string | null | undefined): 'conservative' | 'moderate' | 'aggressive' {
  return raw === 'conservative' || raw === 'aggressive' ? raw : 'moderate';
}

function dayKey(raw: string | null | undefined): string {
  const key = String(raw ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : '';
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayMs(raw: string | null | undefined): number {
  const key = dayKey(raw);
  if (!key) return 0;
  const ms = new Date(`${key}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function inRecentWindow(raw: string | null | undefined, today: Date, days: number): boolean {
  const ms = dayMs(raw);
  if (!ms) return false;
  const end = dayMs(dateKey(today));
  const start = end - (days - 1) * DAY_MS;
  return ms >= start && ms <= end;
}

function signedWeight(lbs: number, unit: WeightUnit): string {
  const prefix = lbs > 0 ? '+' : lbs < 0 ? '-' : '';
  return `${prefix}${formatWeight(Math.abs(lbs), unit, { precision: unit === 'kg' ? 1 : 1 })}`;
}

function signedPct(value: number): string {
  const prefix = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${prefix}${abs.toFixed(abs < 10 ? 1 : 0).replace(/\.0$/, '')}%`;
}

function formatRange(low: number, high: number, precision = 1): string {
  return `${low.toFixed(precision).replace(/\.0$/, '')}-${high.toFixed(precision).replace(/\.0$/, '')}`;
}

function formatWeeks(weeks: number): string {
  const rounded = Math.max(1, Math.round(weeks));
  return rounded === 1 ? '1 week' : `${rounded} weeks`;
}

function goalTiming(profile: GoalForecastProfile, today: Date): {
  projectionWeeks: number;
  startedLabel: string;
} {
  const todayMs = dayMs(dateKey(today));
  const startedMs = dayMs(profile.goalDetails?.goalStartedAt);
  if (!startedMs || !todayMs || startedMs > todayMs) {
    return { projectionWeeks: WINDOW_WEEKS, startedLabel: 'New goal' };
  }

  const elapsedDays = Math.max(0, Math.round((todayMs - startedMs) / DAY_MS));
  const elapsedWeeks = elapsedDays / 7;
  const weeksIntoBlock = elapsedWeeks % WINDOW_WEEKS;
  const projectionWeeks = Math.max(1, Math.ceil(WINDOW_WEEKS - weeksIntoBlock));
  const startedLabel = elapsedDays === 0
    ? 'Started today'
    : elapsedDays < 14
      ? `Started ${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`
      : `Started ${Math.round(elapsedWeeks)} week${Math.round(elapsedWeeks) === 1 ? '' : 's'} ago`;
  return { projectionWeeks, startedLabel };
}

function etaWeeks(remaining: number, weeklyRate: number): number | null {
  if (!Number.isFinite(remaining) || !Number.isFinite(weeklyRate) || remaining <= 0 || weeklyRate <= 0) {
    return null;
  }
  return clamp(Math.ceil(remaining / weeklyRate), 1, MAX_TARGET_ETA_WEEKS);
}

function signedVo2(value: number): string {
  const rounded = round1(value);
  const prefix = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${prefix}${Math.abs(rounded).toFixed(1).replace(/\.0$/, '')}`;
}

function resolveBucket(profile: GoalForecastProfile): GoalForecastBucket {
  const goal = String(profile.goal ?? '');
  if (goal === 'body_recomp' || goal === 'recomp' || goal === 'body_recomposition') return 'body_recomp';
  if (goal === 'hyrox') return 'hyrox';
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
  history: GoalForecastWorkoutSession[],
  summaries: GoalForecastWorkoutSummary[],
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
    const hasDuration = (finite(session.durationSeconds) ?? 0) > 30;
    if (hasSets || hasDuration) days.add(dayKey(session.date));
  }
  return days.size;
}

function countRecentMealDays(
  mealHistory: GoalForecastMealEntry[],
  mealAverages: GoalForecastMealAverages | null,
  nutritionScoreWeekly: GoalForecastNutritionWeekly | null,
  today: Date,
): { days: number; windowDays: number; trackingPct: number } {
  const windowDays = Math.max(1, Math.round(
    finite(nutritionScoreWeekly?.window_days) ??
    finite(mealAverages?.window_days) ??
    7,
  ));
  const recent = new Set(
    mealHistory
      .filter(row => inRecentWindow(row.meal_date, today, Math.min(RECENT_DAYS, windowDays)))
      .map(row => dayKey(row.meal_date))
      .filter(Boolean),
  );
  const scoreDays = Math.round(finite(nutritionScoreWeekly?.days_with_data) ?? 0);
  const avgDays = Math.round(finite(mealAverages?.days_with_data) ?? 0);
  const days = Math.max(recent.size, scoreDays, avgDays);
  const rawTracking = finite(mealAverages?.tracking_rate_pct);
  const trackingPct = rawTracking != null
    ? clamp(Math.round(rawTracking), 0, 100)
    : clamp(Math.round((days / windowDays) * 100), 0, 100);
  return { days, windowDays, trackingPct };
}

function weightTrend(
  entries: GoalForecastWeightEntry[],
  today: Date,
): { slopeLbsPerWeek: number | null; latestWeightLbs: number | null; sampleCount: number; spanDays: number } {
  const todayMs = dayMs(dateKey(today));
  const sorted = entries
    .filter(e => finite(e.weightLbs) != null && dayMs(e.date) > 0 && dayMs(e.date) <= todayMs)
    .sort((a, b) => dayMs(a.date) - dayMs(b.date));
  if (sorted.length === 0) return { slopeLbsPerWeek: null, latestWeightLbs: null, sampleCount: 0, spanDays: 0 };
  const recent = sorted.filter(e => dayMs(e.date) >= todayMs - (WEIGHT_TREND_DAYS - 1) * DAY_MS);
  const sample = recent.length >= 2 ? recent : sorted;
  const first = sample[0];
  const latest = sample[sample.length - 1];
  const firstWeight = finite(first.weightLbs);
  const latestWeight = finite(latest.weightLbs);
  const spanDays = Math.max(0, Math.round((dayMs(latest.date) - dayMs(first.date)) / DAY_MS));
  if (sample.length < 2 || spanDays < 7 || firstWeight == null || latestWeight == null) {
    return { slopeLbsPerWeek: null, latestWeightLbs: latestWeight, sampleCount: sample.length, spanDays };
  }
  return {
    slopeLbsPerWeek: round1(clamp(((latestWeight - firstWeight) / Math.max(1, spanDays)) * 7, -3, 3)),
    latestWeightLbs: latestWeight,
    sampleCount: sample.length,
    spanDays,
  };
}

function latestBodyScan(scans: GoalForecastBodyScan[]): GoalForecastBodyScan | null {
  return [...scans]
    .filter(scan => finite(scan.bodyFatPct) != null)
    .sort((a, b) => dayMs(String(b.date ?? '')) - dayMs(String(a.date ?? '')))[0] ?? null;
}

export function getExecutionWeights(bucket: GoalForecastBucket): GoalForecastExecutionWeights {
  if (bucket === 'fat_loss') return { training: 0.25, nutrition: 0.60, recovery: 0.15 };
  if (bucket === 'muscle_gain') return { training: 0.45, nutrition: 0.40, recovery: 0.15 };
  if (bucket === 'strength') return { training: 0.55, nutrition: 0.25, recovery: 0.20 };
  return { training: 0.40, nutrition: 0.45, recovery: 0.15 };
}

export function computeTrainingExecution(input: {
  workoutDays: number;
  plannedDays: number;
  totalTrainingMinutes?: number | null;
  activityMinutes?: number | null;
  expectedMinutes?: number | null;
}): { score: number; attendanceExecution: number; activityVolume: number } {
  const plannedDays = Math.max(1, Math.round(finite(input.plannedDays) ?? 1));
  const workoutDays = Math.max(0, finite(input.workoutDays) ?? 0);
  const attendanceExecution = clamp(workoutDays / plannedDays, 0, EXECUTION_CAP);
  const minutes = Math.max(0, finite(input.totalTrainingMinutes) ?? finite(input.activityMinutes) ?? 0);
  const expectedMinutes = Math.max(1, finite(input.expectedMinutes) ?? Math.max(60, plannedDays * 45));
  const activityVolume = clamp(minutes / expectedMinutes, 0, EXECUTION_CAP);

  // Attendance is the main training signal. Extra logged activity can lift
  // the score, but lifting-only users are not penalized for missing cardio.
  const score = clamp(
    Math.max(attendanceExecution, attendanceExecution * 0.6 + activityVolume * 0.4),
    0,
    EXECUTION_CAP,
  );
  return { score, attendanceExecution, activityVolume };
}

export function computeNutritionExecution(input: {
  meals: { days: number; windowDays: number; trackingPct: number };
  mealAverages: GoalForecastMealAverages | null;
  nutritionScoreWeekly: GoalForecastNutritionWeekly | null;
  currentWeightLbs: number | null;
}): { score: number; drivers: string[]; limiters: string[] } {
  const drivers: string[] = [];
  const limiters: string[] = [];
  const coverage = clamp(input.meals.trackingPct / 100, 0, 1);
  const weeklyScore = finite(input.nutritionScoreWeekly?.avg_score);
  const scoreComponent = weeklyScore != null && weeklyScore > 0 ? clamp(weeklyScore / 100, 0, EXECUTION_CAP) : null;
  const proteinHits = finite(input.nutritionScoreWeekly?.days_hit_protein);
  const calorieHits = finite(input.nutritionScoreWeekly?.days_hit_calories);
  const scoreDays = finite(input.nutritionScoreWeekly?.days_with_data) ?? input.meals.days;
  const proteinHitRate = proteinHits != null && scoreDays && scoreDays > 0 ? clamp(proteinHits / scoreDays, 0, EXECUTION_CAP) : null;
  const calorieHitRate = calorieHits != null && scoreDays && scoreDays > 0 ? clamp(calorieHits / scoreDays, 0, EXECUTION_CAP) : null;
  const avgProtein = finite(input.mealAverages?.avg_protein_g_when_logged) ?? finite(input.mealAverages?.avg_protein_g);
  const proteinFallback = avgProtein != null && input.currentWeightLbs
    ? clamp(avgProtein / Math.max(90, input.currentWeightLbs * 0.8), 0, EXECUTION_CAP)
    : null;
  const proteinComponent = proteinHitRate ?? proteinFallback;

  const targetComponents: Array<{ value: number; weight: number }> = [];
  if (scoreComponent != null) targetComponents.push({ value: scoreComponent, weight: 0.50 });
  if (proteinComponent != null) targetComponents.push({ value: proteinComponent, weight: 0.30 });
  if (calorieHitRate != null) targetComponents.push({ value: calorieHitRate, weight: 0.20 });

  let score: number;
  if (targetComponents.length > 0) {
    const totalWeight = targetComponents.reduce((sum, item) => sum + item.weight, 0);
    const targetAdherence = targetComponents.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
    score = 0.30 * coverage + 0.70 * targetAdherence;
  } else {
    // Logging matters, but coverage alone should not look like perfect
    // nutrition execution when calories/protein targets are unknown.
    score = Math.min(0.70, 0.30 * coverage + 0.40);
  }

  if (input.meals.days >= Math.ceil(input.meals.windowDays * 0.7)) drivers.push(`${input.meals.days}/${input.meals.windowDays} nutrition days logged`);
  else if (input.meals.days > 0) limiters.push(`only ${input.meals.days}/${input.meals.windowDays} nutrition days logged`);
  else limiters.push('no nutrition logs yet');

  if (proteinComponent != null) {
    if (proteinComponent >= 0.85) drivers.push('protein is supporting the goal');
    else if (input.meals.days >= 3) limiters.push('protein is below target');
  }
  if (calorieHitRate != null) {
    if (calorieHitRate >= 0.7) drivers.push('calories are near target');
    else limiters.push('calories missed target often');
  }

  return { score: clamp(score, 0, EXECUTION_CAP), drivers, limiters };
}

export function computeRecoveryExecution(avgSleepHours?: number | null): { score: number; assumedNeutral: boolean } {
  if (avgSleepHours == null) {
    // Recovery is assumed neutral when unavailable so forecasts do not
    // punish users who have not connected sleep data.
    return { score: 1.0, assumedNeutral: true };
  }
  const sleep = finite(avgSleepHours);
  if (sleep == null) {
    return { score: 1.0, assumedNeutral: true };
  }
  if (sleep >= 7.0) return { score: 1.0, assumedNeutral: false };
  if (sleep >= 6.5) return { score: 0.92, assumedNeutral: false };
  if (sleep >= 6.0) return { score: 0.82, assumedNeutral: false };
  return { score: 0.70, assumedNeutral: false };
}

export function computeExecutionScore(input: {
  bucket: GoalForecastBucket;
  trainingExecution: number;
  nutritionExecution: number;
  recoveryExecution: number;
}): {
  rawExecution: number;
  executionScore: number;
  executionPct: number;
  forecastMultiplier: number;
  weights: GoalForecastExecutionWeights;
} {
  const weights = getExecutionWeights(input.bucket);
  const rawExecution =
    clamp(input.trainingExecution, 0, EXECUTION_CAP) * weights.training +
    clamp(input.nutritionExecution, 0, EXECUTION_CAP) * weights.nutrition +
    clamp(input.recoveryExecution, 0, EXECUTION_CAP) * weights.recovery;

  // User-facing execution is an honest adherence score. The protective
  // 35% floor belongs only to goal projections, not to display.
  const executionScore = clamp(rawExecution, 0, EXECUTION_CAP);
  const forecastMultiplier = clamp(rawExecution, FORECAST_MULTIPLIER_FLOOR, EXECUTION_CAP);
  return {
    rawExecution,
    executionScore,
    executionPct: Math.round(executionScore * 100),
    forecastMultiplier,
    weights,
  };
}

function confidenceDetail(confidence: GoalForecastConfidence): string {
  if (confidence === 'high') return 'Training, nutrition, and body signals are populated.';
  if (confidence === 'medium') return 'Enough signal for a directional estimate.';
  return 'Add workouts, meals, and weigh-ins to sharpen this estimate.';
}

function horizonDate(today: Date, weeks: number): string {
  const d = new Date(today.getTime() + weeks * 7 * DAY_MS);
  return dateKey(d);
}

function weightTrendConfidence(input: { slopeLbsPerWeek: number | null; sampleCount: number; spanDays: number }): number {
  if (input.slopeLbsPerWeek == null) return 0;
  if (input.sampleCount >= 6 && input.spanDays >= 21) return 0.70;
  if (input.sampleCount >= 4 && input.spanDays >= 14) return 0.55;
  if (input.sampleCount >= 2 && input.spanDays >= 7) return 0.35;
  return 0;
}

function projectedFatLossWeeklyRate(input: {
  plannedWeeklyLoss: number;
  forecastMultiplier: number;
  weightSlopeLbsPerWeek: number | null;
  observedConfidence: number;
}): number {
  const planned = input.plannedWeeklyLoss * input.forecastMultiplier;
  const slope = input.weightSlopeLbsPerWeek;
  const confidence = clamp(input.observedConfidence, 0, 1);
  if (slope != null && slope < 0 && confidence > 0) {
    const observedWeeklyLoss = clamp(Math.abs(slope), 0.1, input.plannedWeeklyLoss * 1.2);
    // A reliable observed trend already contains real-world adherence, so
    // blend it with the plan-scaled pace instead of multiplying it again.
    return Math.max(0.1, observedWeeklyLoss * confidence + planned * (1 - confidence));
  }
  return Math.max(0.1, planned);
}

function buildHorizonProjection(input: {
  bucket: GoalForecastBucket;
  weeks: number;
  today: Date;
  pace: 'conservative' | 'moderate' | 'aggressive';
  forecastMultiplier: number;
  currentWeightLbs: number | null;
  weightSlopeLbsPerWeek: number | null;
  weightTrendConfidence: number;
  startBodyFatPct: number | null;
  weightUnit: WeightUnit;
  calorieRanges: GoalForecastCalorieRanges | null;
}): GoalForecastHorizon | null {
  const { bucket, weeks, today, pace, forecastMultiplier, currentWeightLbs, weightUnit } = input;
  const date = horizonDate(today, weeks);

  if (bucket === 'fat_loss') {
    const fatLossRate = personalizedWeeklyRateLbs({
      bucket,
      ranges: input.calorieRanges,
      fallback: FAT_LOSS_LBS_PER_WEEK[pace],
      ceiling: FAT_LOSS_LBS_PER_WEEK.aggressive,
    });
    const base = fatLossRate.rate;
    const weeklyLoss = projectedFatLossWeeklyRate({
      plannedWeeklyLoss: base,
      forecastMultiplier,
      weightSlopeLbsPerWeek: input.weightSlopeLbsPerWeek,
      observedConfidence: input.weightTrendConfidence,
    });
    const projectedLoss = round1(weeklyLoss * weeks);
    const projectedWeight = currentWeightLbs != null
      ? round1(currentWeightLbs - projectedLoss)
      : null;
    const projectedBfPct = input.startBodyFatPct != null && currentWeightLbs != null
      ? round1(projectBodyFatPct(currentWeightLbs, input.startBodyFatPct, projectedLoss))
      : null;
    const weightStr = projectedWeight != null ? formatWeight(projectedWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }) : null;
    const lossStr = signedWeight(-projectedLoss, weightUnit);
    const label = weightStr
      ? `In ${formatWeeks(weeks)}: ${weightStr} (${lossStr} fat est.)`
      : `In ${formatWeeks(weeks)}: ${lossStr} fat est.`;
    return { weeks, date, label, scaleWeightLbs: projectedWeight, fatLossLbs: projectedLoss, bodyFatPct: projectedBfPct };
  }

  if (bucket === 'muscle_gain') {
    const muscleGainRate = personalizedWeeklyRateLbs({
      bucket,
      ranges: input.calorieRanges,
      fallback: MUSCLE_GAIN_LBS_PER_WEEK[pace],
      ceiling: MUSCLE_GAIN_LBS_PER_WEEK.aggressive,
    });
    const weeklyGain = Math.max(0.05, muscleGainRate.rate * forecastMultiplier);
    const projectedGain = round1(weeklyGain * weeks);
    const projectedWeight = currentWeightLbs != null
      ? round1(currentWeightLbs + projectedGain)
      : null;
    const weightStr = projectedWeight != null ? formatWeight(projectedWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 }) : null;
    const label = weightStr
      ? `In ${formatWeeks(weeks)}: ${weightStr} (${signedWeight(projectedGain, weightUnit)})`
      : `In ${formatWeeks(weeks)}: ${signedWeight(projectedGain, weightUnit)}`;
    return { weeks, date, label, scaleWeightLbs: projectedWeight, fatLossLbs: null, bodyFatPct: null };
  }

  if (bucket === 'body_recomp') {
    const [low, high] = RECOMP_FAT_LOSS_LBS_PER_WEEK[pace];
    const fatLow = round1(low * weeks * forecastMultiplier);
    const fatHigh = round1(high * weeks * forecastMultiplier);
    const fatMid = round1((fatLow + fatHigh) / 2);
    // Only project absolute BF% when we have a real starting scan. Without
    // one, show directional fat-loss only — per product call: never display
    // an estimated body-fat % the user hasn't measured or entered.
    const projectedBfPct = input.startBodyFatPct != null && currentWeightLbs != null
      ? round1(projectBodyFatPct(currentWeightLbs, input.startBodyFatPct, fatMid))
      : null;
    const range = `${fatLow.toFixed(1)}–${fatHigh.toFixed(1)} lb`;
    const label = projectedBfPct != null
      ? `In ${formatWeeks(weeks)}: ~${projectedBfPct}% BF (-${range} fat est.)`
      : `In ${formatWeeks(weeks)}: -${range} fat est., scale ±1 lb`;
    return { weeks, date, label, scaleWeightLbs: null, fatLossLbs: fatMid, bodyFatPct: projectedBfPct };
  }

  return null;
}

/** Estimate BF% N weeks out assuming the projected fat loss is real
 *  fat (LBM preserved). Anchors LBM on the start scan + current weight.
 *  Used for fat-loss + recomp horizon projections. */
function projectBodyFatPct(
  currentWeightLbs: number,
  startBfPct: number,
  fatLossLbs: number,
): number {
  const currentFat = currentWeightLbs * (startBfPct / 100);
  const currentLean = currentWeightLbs - currentFat;
  const newFat = Math.max(0, currentFat - fatLossLbs);
  const newWeight = currentLean + newFat;
  return newWeight > 0 ? (newFat / newWeight) * 100 : 0;
}

const KCAL_PER_LB_FAT = 3500;
// Hypertrophy efficiency — only ~50% of a muscle-gain surplus shows up as
// scale weight at moderate paces (the rest is metabolic/water/glycogen
// noise that doesn't persist). Without this derate, +300 kcal/day surplus
// would project +0.6 lb/wk, which overstates actual lean accrual by ~2×.
const MUSCLE_GAIN_KCAL_EFFICIENCY = 0.5;

/** Convert the user's actual daily kcal adjustment to a projected weekly
 *  scale-weight change. Returns `fallback` when calorieRanges or the
 *  required adjustment field is absent. Capped at 120% of the aggressive
 *  pace constant so a misconfigured target can't produce absurd numbers
 *  (e.g. a 1500-kcal deficit on a 130-lb user). */
function personalizedWeeklyRateLbs(input: {
  bucket: GoalForecastBucket;
  ranges: GoalForecastCalorieRanges | null | undefined;
  fallback: number;
  ceiling: number;
}): { rate: number; personalized: boolean } {
  const { bucket, ranges, fallback, ceiling } = input;
  if (!ranges || !Number.isFinite(ranges.maintenanceCalories)) {
    return { rate: fallback, personalized: false };
  }
  const adj = bucket === 'fat_loss'
    ? finite(ranges.cutAdjustmentKcal)
    : bucket === 'muscle_gain'
      ? finite(ranges.bulkAdjustmentKcal)
      : null;
  if (adj == null || adj === 0) {
    return { rate: fallback, personalized: false };
  }
  const efficiency = bucket === 'muscle_gain' ? MUSCLE_GAIN_KCAL_EFFICIENCY : 1;
  const rawRate = (Math.abs(adj) * 7 / KCAL_PER_LB_FAT) * efficiency;
  // Floor at half the fallback so a near-maintenance setup still projects
  // *some* progress, ceiling at 120% of aggressive so demographic outliers
  // don't render impossible numbers.
  const rate = clamp(rawRate, fallback * 0.5, ceiling * 1.2);
  return { rate, personalized: true };
}

function titleForBucket(bucket: GoalForecastBucket): string {
  if (bucket === 'fat_loss') return 'fat-loss estimate';
  if (bucket === 'muscle_gain') return 'muscle-gain estimate';
  if (bucket === 'body_recomp') return 'recomp estimate';
  if (bucket === 'strength') return 'strength estimate';
  if (bucket === 'endurance') return 'cardio estimate';
  if (bucket === 'athletic' || bucket === 'hyrox') return 'performance estimate';
  return 'fitness estimate';
}

export function buildGoalForecast(input: BuildGoalForecastInput): GoalForecastModel {
  const today = input.today ?? new Date();
  const weightUnit = input.weightUnit ?? 'lbs';
  const distanceUnit = input.distanceUnit ?? 'mi';
  const profile = input.profile;
  const bucket = resolveBucket(profile);
  const pace = paceKey(profile.goalDetails?.pace);
  const timing = goalTiming(profile, today);
  const projectionWeeks = timing.projectionWeeks;
  const history = input.history ?? [];
  const summaries = input.summaries ?? [];
  const workoutDays14 = countRecentWorkoutDays(history, summaries, today);
  const planned14 = Math.max(1, Math.round(finite(profile.daysPerWeek) ?? 3) * 2);
  const cardioMiles14 = (input.paceHistory ?? [])
    .filter(point => inRecentWindow(point.date, today, RECENT_DAYS))
    .reduce((sum, point) => sum + Math.max(0, finite(point.distance) ?? 0), 0);
  const recentSummaries = summaries.filter(row => inRecentWindow(row.date, today, RECENT_DAYS));
  const totalTrainingMinutes14 = recentSummaries
    .reduce((sum, row) => sum + Math.round((finite(row.durationSeconds) ?? 0) / 60), 0);
  const cardioMinutes14 = recentSummaries
    .filter(row => (finite(row.totalSets) ?? 0) <= 0)
    .reduce((sum, row) => sum + Math.round((finite(row.durationSeconds) ?? 0) / 60), 0);
  const legacyActivityMinutes14 = summaries
    .filter(row => inRecentWindow(row.date, today, RECENT_DAYS))
    .reduce((sum, row) => sum + Math.round((finite(row.durationSeconds) ?? 0) / 60), 0);
  const expectedMinutes14 = Math.max(60, planned14 * 45);
  const training = computeTrainingExecution({
    workoutDays: workoutDays14,
    plannedDays: planned14,
    totalTrainingMinutes: totalTrainingMinutes14,
    activityMinutes: legacyActivityMinutes14,
    expectedMinutes: expectedMinutes14,
  });
  const trainingExecution = training.score;
  const weights = weightTrend(input.weightEntries ?? [], today);
  const trendConfidence = weightTrendConfidence(weights);
  const currentWeight = weights.latestWeightLbs ?? finite(profile.physicalStats?.weightLbs);
  const targetWeight = finite(profile.goalDetails?.targetWeightLbs);
  const bodyScan = latestBodyScan(input.bodyScanHistory ?? []);
  const meals = countRecentMealDays(input.mealHistory ?? [], input.mealAverages ?? null, input.nutritionScoreWeekly ?? null, today);
  const nutrition = computeNutritionExecution({
    meals,
    mealAverages: input.mealAverages ?? null,
    nutritionScoreWeekly: input.nutritionScoreWeekly ?? null,
    currentWeightLbs: currentWeight,
  });
  const recovery = computeRecoveryExecution(input.avgSleepHours);
  const execution = computeExecutionScore({
    bucket,
    trainingExecution,
    nutritionExecution: nutrition.score,
    recoveryExecution: recovery.score,
  });
  const { rawExecution, executionScore, executionPct, forecastMultiplier } = execution;

  const drivers: string[] = [];
  const limiters: string[] = [];
  if (trainingExecution >= 0.85) drivers.push(`${workoutDays14}/${planned14} planned training days logged`);
  else limiters.push(`${workoutDays14}/${planned14} planned training days logged`);
  drivers.push(...nutrition.drivers);
  limiters.push(...nutrition.limiters);

  const bodySignal = bodyScan != null || weights.slopeLbsPerWeek != null || (currentWeight != null && targetWeight != null);
  const confidenceScore = (workoutDays14 >= 2 ? 1 : 0) + (meals.days >= 4 ? 2 : meals.days >= 2 ? 1 : 0) + (bodySignal ? 1 : 0);
  const confidence: GoalForecastConfidence = confidenceScore >= 4 ? 'high' : confidenceScore >= 2 ? 'medium' : 'low';
  const tone: GoalForecastTone = executionScore >= 0.78 ? 'success' : executionScore < 0.58 ? 'warning' : 'neutral';
  const assumption = `Assumes the next ${formatWeeks(projectionWeeks)} look like your current plan execution.`;
  const updateReason = limiters.length > 0
    ? `Estimate adjusted down because ${limiters[0]}.`
    : 'Estimate held because training and nutrition are supporting the goal.';

  let headline = `At current pace: ${Math.round((workoutDays14 / 2) * projectionWeeks * forecastMultiplier)} training days in ${formatWeeks(projectionWeeks)}`;
  let subheadline = `${timing.startedLabel}; current training and nutrition set this estimate.`;
  let metricLabel = 'Consistency';
  let metricValue = `${Math.round((workoutDays14 / 2) * projectionWeeks * forecastMultiplier)} days`;
  let metricDetail = `${executionPct}% current execution`;
  let progressPct = executionScore;

  if (bucket === 'fat_loss') {
    const fatLossRate = personalizedWeeklyRateLbs({
      bucket,
      ranges: input.calorieRanges ?? null,
      fallback: FAT_LOSS_LBS_PER_WEEK[pace],
      ceiling: FAT_LOSS_LBS_PER_WEEK.aggressive,
    });
    const base = fatLossRate.rate;
    const weeklyLoss = projectedFatLossWeeklyRate({
      plannedWeeklyLoss: base,
      forecastMultiplier,
      weightSlopeLbsPerWeek: weights.slopeLbsPerWeek,
      observedConfidence: trendConfidence,
    });
    let loss = round1(weeklyLoss * projectionWeeks);
    if (targetWeight != null && currentWeight != null && currentWeight > targetWeight) {
      const remaining = currentWeight - targetWeight;
      const weeksToTarget = etaWeeks(remaining, weeklyLoss);
      loss = Math.min(loss, remaining);
      progressPct = clamp(1 - ((currentWeight - targetWeight) / Math.max(1, Math.abs((profile.goalDetails?.startWeightLbs ?? currentWeight) - targetWeight))), 0, 1);
      if (weeksToTarget != null) {
        metricValue = formatWeeks(weeksToTarget);
        metricLabel = 'ETA';
        metricDetail = `${signedWeight(-round1(weeklyLoss), weightUnit)}/wk estimated`;
        headline = `At current pace: ${formatWeight(targetWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} in ${formatWeeks(weeksToTarget)}`;
        subheadline = `${timing.startedLabel}; ${formatWeight(remaining, weightUnit, { precision: weightUnit === 'kg' ? 1 : 1 })} to goal weight.`;
      }
    } else if (targetWeight != null && currentWeight != null && currentWeight <= targetWeight) {
      metricValue = 'Reached';
      metricLabel = 'ETA';
      metricDetail = `${formatWeight(currentWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} now`;
      headline = 'At current pace: goal weight is reached';
      subheadline = `${timing.startedLabel}; hold the habits that got you here.`;
    }
    if (metricLabel !== 'ETA') {
      metricValue = signedWeight(-loss, weightUnit);
      metricLabel = 'Projected scale';
      metricDetail = `${executionPct}% current execution`;
      headline = `At current pace: ${metricValue} in ${formatWeeks(projectionWeeks)}`;
      subheadline = `${timing.startedLabel}; estimate blends goal pace, nutrition, training, and weight trend.`;
    }
  } else if (bucket === 'muscle_gain') {
    const muscleGainRate = personalizedWeeklyRateLbs({
      bucket,
      ranges: input.calorieRanges ?? null,
      fallback: MUSCLE_GAIN_LBS_PER_WEEK[pace],
      ceiling: MUSCLE_GAIN_LBS_PER_WEEK.aggressive,
    });
    const weeklyGain = Math.max(0.05, muscleGainRate.rate * forecastMultiplier);
    const gain = round1(weeklyGain * projectionWeeks);
    if (targetWeight != null && currentWeight != null && currentWeight < targetWeight) {
      const remaining = targetWeight - currentWeight;
      const weeksToTarget = etaWeeks(remaining, weeklyGain);
      if (weeksToTarget != null) {
        metricValue = formatWeeks(weeksToTarget);
        metricLabel = 'ETA';
        metricDetail = `${signedWeight(round1(weeklyGain), weightUnit)}/wk estimated`;
        headline = `At current pace: ${formatWeight(targetWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} in ${formatWeeks(weeksToTarget)}`;
        subheadline = `${timing.startedLabel}; ${formatWeight(remaining, weightUnit, { precision: weightUnit === 'kg' ? 1 : 1 })} to goal weight.`;
      }
    } else if (targetWeight != null && currentWeight != null && currentWeight >= targetWeight) {
      metricValue = 'Reached';
      metricLabel = 'ETA';
      metricDetail = `${formatWeight(currentWeight, weightUnit, { precision: weightUnit === 'kg' ? 1 : 0 })} now`;
      headline = 'At current pace: goal weight is reached';
      subheadline = `${timing.startedLabel}; hold training quality while weight stabilizes.`;
    }
    if (metricLabel !== 'ETA') {
      metricValue = signedWeight(gain, weightUnit);
      metricLabel = 'Lean-mass pace';
      metricDetail = `${executionPct}% current execution`;
      headline = `At current pace: ${metricValue} lean mass in ${formatWeeks(projectionWeeks)}`;
      subheadline = `${timing.startedLabel}; lean gain depends on training, protein, and calorie execution.`;
    }
  } else if (bucket === 'body_recomp') {
    const [low, high] = RECOMP_FAT_LOSS_LBS_PER_WEEK[pace];
    const fatLow = round1(low * projectionWeeks * forecastMultiplier);
    const fatHigh = round1(high * projectionWeeks * forecastMultiplier);
    const fatMid = round1(((fatLow + fatHigh) / 2));
    metricValue = signedWeight(-fatMid, weightUnit);
    if (currentWeight && currentWeight > 0) {
      const bfLow = round1((fatLow / currentWeight) * 100);
      const bfHigh = round1((fatHigh / currentWeight) * 100);
      metricDetail = `About -${formatRange(bfLow, bfHigh)} body-fat points if scale stays stable`;
    } else {
      metricDetail = `${formatWeight(fatLow, weightUnit, { precision: 1 })} to ${formatWeight(fatHigh, weightUnit, { precision: 1 })} likely range`;
    }
    metricLabel = 'Fat estimate';
    headline = `At current pace: ${metricValue} fat in ${formatWeeks(projectionWeeks)}`;
    subheadline = bodyScan
      ? `${timing.startedLabel}; latest scan ${bodyScan.bodyFatPct}% body fat.`
      : `${timing.startedLabel}; assumes scale stays mostly stable while strength and protein stay consistent.`;
  } else if (bucket === 'strength') {
    const pct = round1(STRENGTH_GAIN_PCT_6W[pace] * (projectionWeeks / WINDOW_WEEKS) * forecastMultiplier);
    const topLift = (input.oneRepMaxLifts ?? []).find(lift => finite(lift.oneRepMaxLbs) != null);
    metricValue = signedPct(pct);
    metricLabel = 'Strength marker';
    metricDetail = topLift ? `${topLift.name}: ${formatWeight(topLift.oneRepMaxLbs, weightUnit)} e1RM now` : `${executionPct}% current execution`;
    headline = `At current pace: ${metricValue} strength marker in ${formatWeeks(projectionWeeks)}`;
    subheadline = `${timing.startedLabel}; estimate uses lifting adherence, nutrition, and recovery consistency.`;
  } else if (bucket === 'endurance' || bucket === 'hyrox') {
    const cardioExecution = clamp(trainingExecution * 0.65 + nutrition.score * 0.20 + recovery.score * 0.15, FORECAST_MULTIPLIER_FLOOR, EXECUTION_CAP);
    const vo2Gain = Math.max(0.1, round1(VO2_GAIN_6W[pace] * (projectionWeeks / WINDOW_WEEKS) * cardioExecution));
    const projectedMiles = cardioMiles14 > 0 ? (cardioMiles14 / 2) * projectionWeeks * Math.max(0.65, forecastMultiplier) : 0;
    const projectedMinutes = Math.round((cardioMinutes14 / 2) * projectionWeeks * Math.max(0.65, forecastMultiplier));
    metricValue = signedVo2(vo2Gain);
    metricLabel = bucket === 'hyrox' ? 'Hybrid VO2 estimate' : 'VO2 estimate';
    metricDetail = input.vo2Max != null
      ? `${round1(input.vo2Max)} ml/kg/min now`
      : projectedMiles > 0
        ? `${formatDistance(projectedMiles, distanceUnit)} projected cardio volume`
        : `${projectedMinutes} projected cardio minutes`;
    headline = `At current pace: ${metricValue} VO2 Max in ${formatWeeks(projectionWeeks)}`;
    subheadline = `${timing.startedLabel}; estimate updates from logged cardio and training consistency.`;
  } else if (bucket === 'athletic') {
    const projectedDays = Math.round((workoutDays14 / 2) * projectionWeeks * Math.max(0.65, forecastMultiplier));
    metricValue = `${projectedDays} days`;
    metricLabel = 'Performance prep';
    metricDetail = `${executionPct}% current execution`;
    headline = `At current pace: ${projectedDays} performance sessions in ${formatWeeks(projectionWeeks)}`;
    subheadline = `${timing.startedLabel}; estimate blends lifting, conditioning, and nutrition consistency.`;
  }

  const stats: GoalForecastStat[] = [
    { label: 'Training', value: `${workoutDays14}/${planned14}`, detail: 'last 14 days' },
    { label: 'Nutrition', value: meals.days > 0 ? `${meals.days}/${meals.windowDays}` : 'Need logs', detail: meals.days > 0 ? 'logged days' : 'data needed' },
    weights.slopeLbsPerWeek != null
      ? { label: 'Body trend', value: `${signedWeight(weights.slopeLbsPerWeek, weightUnit)}/wk`, detail: 'scale trend' }
      : bodyScan
        ? { label: 'Body scan', value: `${bodyScan.bodyFatPct}%`, detail: 'latest estimate' }
        : { label: 'Execution', value: `${executionPct}%`, detail: 'current plan' },
  ];

  // Fixed-horizon projection ("In 6 weeks: X"). Independent of ETA so
  // the card always shows a forward-looking number even when the user
  // has no target weight set.
  const horizonProjection = buildHorizonProjection({
    bucket,
    weeks: WINDOW_WEEKS,
    today,
    pace,
    forecastMultiplier,
    currentWeightLbs: currentWeight ?? null,
    weightSlopeLbsPerWeek: weights.slopeLbsPerWeek,
    weightTrendConfidence: trendConfidence,
    startBodyFatPct: finite(profile.goalDetails?.startBodyFatPct),
    weightUnit,
    calorieRanges: input.calorieRanges ?? null,
  });

  return {
    bucket,
    title: titleForBucket(bucket),
    headline,
    subheadline,
    metricLabel,
    metricValue,
    metricDetail,
    rawExecution,
    executionScore,
    executionPct,
    forecastMultiplier,
    executionBreakdown: {
      training: trainingExecution,
      nutrition: nutrition.score,
      recovery: recovery.score,
      recoveryAssumedNeutral: recovery.assumedNeutral,
      weights: execution.weights,
    },
    progressPct: clamp(progressPct, 0, 1),
    confidence,
    confidenceDetail: confidenceDetail(confidence),
    tone,
    assumption,
    updateReason,
    drivers: drivers.slice(0, 3),
    limiters: limiters.slice(0, 3),
    stats,
    horizonProjection,
  };
}
