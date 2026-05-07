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

export type GoalForecastStat = {
  label: string;
  value: string;
  detail: string;
};

export type GoalForecastModel = {
  bucket: GoalForecastBucket;
  title: string;
  headline: string;
  subheadline: string;
  metricLabel: string;
  metricValue: string;
  metricDetail: string;
  executionPct: number;
  progressPct: number;
  confidence: GoalForecastConfidence;
  confidenceDetail: string;
  tone: GoalForecastTone;
  assumption: string;
  updateReason: string;
  drivers: string[];
  limiters: string[];
  stats: GoalForecastStat[];
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

function nutritionExecution(input: {
  meals: { days: number; windowDays: number; trackingPct: number };
  mealAverages: GoalForecastMealAverages | null;
  nutritionScoreWeekly: GoalForecastNutritionWeekly | null;
  currentWeightLbs: number | null;
}): { score: number; drivers: string[]; limiters: string[] } {
  const drivers: string[] = [];
  const limiters: string[] = [];
  const coverage = clamp(input.meals.trackingPct / 100, 0, 1);
  const weeklyScore = finite(input.nutritionScoreWeekly?.avg_score);
  const scoreComponent = weeklyScore != null && weeklyScore > 0 ? clamp(weeklyScore / 100, 0.35, 1.05) : null;
  const proteinHits = finite(input.nutritionScoreWeekly?.days_hit_protein);
  const calorieHits = finite(input.nutritionScoreWeekly?.days_hit_calories);
  const scoreDays = finite(input.nutritionScoreWeekly?.days_with_data);
  const proteinHitRate = proteinHits != null && scoreDays && scoreDays > 0 ? clamp(proteinHits / scoreDays, 0.25, 1.05) : null;
  const calorieHitRate = calorieHits != null && scoreDays && scoreDays > 0 ? clamp(calorieHits / scoreDays, 0.25, 1.05) : null;
  const avgProtein = finite(input.mealAverages?.avg_protein_g_when_logged) ?? finite(input.mealAverages?.avg_protein_g);
  const proteinFallback = avgProtein != null && input.currentWeightLbs
    ? clamp(avgProtein / Math.max(90, input.currentWeightLbs * 0.8), 0.25, 1.05)
    : null;

  let score = 0.45 * coverage;
  let remaining = 0.55;
  if (scoreComponent != null) {
    score += 0.25 * scoreComponent;
    remaining -= 0.25;
  }
  const proteinComponent = proteinHitRate ?? proteinFallback;
  if (proteinComponent != null) {
    score += 0.20 * proteinComponent;
    remaining -= 0.20;
  }
  if (calorieHitRate != null) {
    score += 0.10 * calorieHitRate;
    remaining -= 0.10;
  }
  score += Math.max(0, remaining) * Math.max(coverage, proteinComponent ?? 0.55);

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

  return { score: clamp(score, 0.35, 1.05), drivers, limiters };
}

function confidenceDetail(confidence: GoalForecastConfidence): string {
  if (confidence === 'high') return 'Training, nutrition, and body signals are populated.';
  if (confidence === 'medium') return 'Enough signal for a directional estimate.';
  return 'Add workouts, meals, and weigh-ins to sharpen this estimate.';
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
  const history = input.history ?? [];
  const summaries = input.summaries ?? [];
  const workoutDays14 = countRecentWorkoutDays(history, summaries, today);
  const planned14 = Math.max(1, Math.round(finite(profile.daysPerWeek) ?? 3) * 2);
  const trainingExecution = clamp(workoutDays14 / planned14, 0, 1.15);
  const weights = weightTrend(input.weightEntries ?? [], today);
  const currentWeight = weights.latestWeightLbs ?? finite(profile.physicalStats?.weightLbs);
  const targetWeight = finite(profile.goalDetails?.targetWeightLbs);
  const bodyScan = latestBodyScan(input.bodyScanHistory ?? []);
  const meals = countRecentMealDays(input.mealHistory ?? [], input.mealAverages ?? null, input.nutritionScoreWeekly ?? null, today);
  const nutrition = nutritionExecution({
    meals,
    mealAverages: input.mealAverages ?? null,
    nutritionScoreWeekly: input.nutritionScoreWeekly ?? null,
    currentWeightLbs: currentWeight,
  });
  const execution = clamp(trainingExecution * 0.40 + nutrition.score * 0.50 + 0.10, 0.35, 1.08);
  const executionPct = Math.round(execution * 100);
  const cardioMiles14 = (input.paceHistory ?? [])
    .filter(point => inRecentWindow(point.date, today, RECENT_DAYS))
    .reduce((sum, point) => sum + Math.max(0, finite(point.distance) ?? 0), 0);
  const cardioMinutes14 = summaries
    .filter(row => inRecentWindow(row.date, today, RECENT_DAYS))
    .reduce((sum, row) => sum + Math.round((finite(row.durationSeconds) ?? 0) / 60), 0);

  const drivers: string[] = [];
  const limiters: string[] = [];
  if (trainingExecution >= 0.85) drivers.push(`${workoutDays14}/${planned14} planned training days logged`);
  else limiters.push(`${workoutDays14}/${planned14} planned training days logged`);
  drivers.push(...nutrition.drivers);
  limiters.push(...nutrition.limiters);

  const bodySignal = bodyScan != null || weights.slopeLbsPerWeek != null || (currentWeight != null && targetWeight != null);
  const confidenceScore = (workoutDays14 >= 2 ? 1 : 0) + (meals.days >= 4 ? 2 : meals.days >= 2 ? 1 : 0) + (bodySignal ? 1 : 0);
  const confidence: GoalForecastConfidence = confidenceScore >= 4 ? 'high' : confidenceScore >= 2 ? 'medium' : 'low';
  const tone: GoalForecastTone = execution >= 0.78 ? 'success' : execution < 0.58 ? 'warning' : 'neutral';
  const assumption = 'Assumes the next 6 weeks look like your current plan execution.';
  const updateReason = limiters.length > 0
    ? `Estimate adjusted down because ${limiters[0]}.`
    : 'Estimate held because training and nutrition are supporting the goal.';

  let headline = `Estimated ${Math.round(workoutDays14 * 3 * execution)} training days in ${WINDOW_WEEKS} weeks`;
  let subheadline = 'General fitness estimate uses current training and nutrition consistency.';
  let metricLabel = 'Consistency';
  let metricValue = `${Math.round(workoutDays14 * 3 * execution)} days`;
  let metricDetail = `${executionPct}% current execution`;
  let progressPct = execution;

  if (bucket === 'fat_loss') {
    const base = FAT_LOSS_LBS_PER_WEEK[pace];
    const observed = weights.slopeLbsPerWeek != null && weights.slopeLbsPerWeek < 0
      ? Math.min(base, Math.abs(weights.slopeLbsPerWeek) * 0.55 + base * 0.45)
      : base;
    let loss = round1(observed * WINDOW_WEEKS * execution);
    if (targetWeight != null && currentWeight != null && currentWeight > targetWeight) {
      loss = Math.min(loss, currentWeight - targetWeight);
      progressPct = clamp(1 - ((currentWeight - targetWeight) / Math.max(1, Math.abs((profile.goalDetails?.startWeightLbs ?? currentWeight) - targetWeight))), 0, 1);
    }
    metricValue = signedWeight(-loss, weightUnit);
    metricLabel = 'Projected scale';
    metricDetail = `${executionPct}% current execution`;
    headline = `Estimated ${metricValue} in ${WINDOW_WEEKS} weeks`;
    subheadline = 'Fat-loss forecast blends goal pace, nutrition execution, training adherence, and weight trend.';
  } else if (bucket === 'muscle_gain') {
    const gain = round1(MUSCLE_GAIN_LBS_PER_WEEK[pace] * WINDOW_WEEKS * execution);
    metricValue = signedWeight(gain, weightUnit);
    metricLabel = 'Lean-mass pace';
    metricDetail = `${executionPct}% current execution`;
    headline = `Estimated ${metricValue} lean-gain pace in ${WINDOW_WEEKS} weeks`;
    subheadline = 'Lean gain is capped by training consistency, protein, and calorie execution.';
  } else if (bucket === 'body_recomp') {
    const [low, high] = RECOMP_FAT_LOSS_LBS_PER_WEEK[pace];
    const fatLow = round1(low * WINDOW_WEEKS * execution);
    const fatHigh = round1(high * WINDOW_WEEKS * execution);
    if (currentWeight && currentWeight > 0) {
      const bfLow = round1((fatLow / currentWeight) * 100);
      const bfHigh = round1((fatHigh / currentWeight) * 100);
      metricValue = `-${formatRange(bfLow, bfHigh)}%`;
      headline = `Estimated -${formatRange(bfLow, bfHigh)} body-fat points in ${WINDOW_WEEKS} weeks`;
    } else {
      metricValue = `${formatWeight(fatLow, weightUnit, { precision: 1 })}-${formatWeight(fatHigh, weightUnit, { precision: 1 })}`;
      headline = `Estimated ${metricValue} fat loss in ${WINDOW_WEEKS} weeks`;
    }
    metricLabel = 'Body-fat estimate';
    metricDetail = `${formatWeight(fatLow, weightUnit, { precision: 1 })}-${formatWeight(fatHigh, weightUnit, { precision: 1 })} fat-loss equivalent`;
    subheadline = bodyScan
      ? `Latest scan ${bodyScan.bodyFatPct}% body fat; forecast assumes scale stays mostly stable.`
      : 'Recomp assumes scale stays mostly stable while strength and protein stay consistent.';
  } else if (bucket === 'strength') {
    const pct = round1(STRENGTH_GAIN_PCT_6W[pace] * execution);
    const topLift = (input.oneRepMaxLifts ?? []).find(lift => finite(lift.oneRepMaxLbs) != null);
    metricValue = signedPct(pct);
    metricLabel = 'Strength marker';
    metricDetail = topLift ? `${topLift.name}: ${formatWeight(topLift.oneRepMaxLbs, weightUnit)} e1RM now` : `${executionPct}% current execution`;
    headline = `Estimated ${metricValue} strength marker change in ${WINDOW_WEEKS} weeks`;
    subheadline = 'Strength forecast uses lifting adherence, nutrition support, and recovery consistency.';
  } else if (bucket === 'endurance' || bucket === 'hyrox') {
    const projectedMiles = cardioMiles14 > 0 ? cardioMiles14 * 3 * Math.max(0.65, execution) : 0;
    const projectedMinutes = Math.round(cardioMinutes14 * 3 * Math.max(0.65, execution));
    metricValue = projectedMiles > 0 ? formatDistance(projectedMiles, distanceUnit) : `${projectedMinutes} min`;
    metricLabel = bucket === 'hyrox' ? 'Hybrid volume' : 'Aerobic volume';
    metricDetail = cardioMiles14 > 0 ? 'projected distance' : 'projected logged cardio';
    headline = projectedMiles > 0
      ? `Estimated ${metricValue} cardio volume in ${WINDOW_WEEKS} weeks`
      : `Estimated ${projectedMinutes} cardio minutes in ${WINDOW_WEEKS} weeks`;
    subheadline = 'Cardio estimate updates from logged endurance work and weekly nutrition support.';
  } else if (bucket === 'athletic') {
    const projectedDays = Math.round(workoutDays14 * 3 * Math.max(0.65, execution));
    metricValue = `${projectedDays} days`;
    metricLabel = 'Performance prep';
    metricDetail = `${executionPct}% current execution`;
    headline = `Estimated ${projectedDays} performance sessions in ${WINDOW_WEEKS} weeks`;
    subheadline = 'Performance estimate blends lifting, conditioning, and nutrition consistency.';
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

  return {
    bucket,
    title: titleForBucket(bucket),
    headline,
    subheadline,
    metricLabel,
    metricValue,
    metricDetail,
    executionPct,
    progressPct: clamp(progressPct, 0, 1),
    confidence,
    confidenceDetail: confidenceDetail(confidence),
    tone,
    assumption,
    updateReason,
    drivers: drivers.slice(0, 3),
    limiters: limiters.slice(0, 3),
    stats,
  };
}
