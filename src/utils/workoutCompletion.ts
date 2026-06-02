import type { WorkoutCompletionRecord } from '../services/api';
import type { ActivitySource, ManualActivityDetails, StoredWorkoutSummary, WorkoutSession } from '../types';

const MANUAL_COMPLETION_CONTEXTS = new Set([
  'manual_activity',
  'custom_strength',
  'custom_cardio',
  'apple_health',
  'import_strava',
  'watch',
  'coach_log',
]);

const EXTRA_WORKOUT_CONTEXTS = new Set([
  ...MANUAL_COMPLETION_CONTEXTS,
  'saved_template',
]);

function normalizedContext(completion: WorkoutCompletionRecord): string {
  return String(completion.source_context ?? '').trim().toLowerCase();
}

function normalizedSessionContext(session: WorkoutSession): string {
  return String(session.sourceContext ?? (session as any).source_context ?? '').trim().toLowerCase();
}

function sessionPlanDayId(session: WorkoutSession): number | null {
  const planDayId = session.planDayId ?? (session as any).plan_day_id;
  return typeof planDayId === 'number' && Number.isFinite(planDayId) ? planDayId : null;
}

export function isManualActivityCompletion(completion: WorkoutCompletionRecord): boolean {
  const context = normalizedContext(completion);
  if (context) return MANUAL_COMPLETION_CONTEXTS.has(context);
  return false;
}

export function manualActivityFromCompletion(completion: WorkoutCompletionRecord): WorkoutSession['manualActivity'] | undefined {
  if (!completion.activity_category || !isManualActivityCompletion(completion)) return undefined;
  const context = normalizedContext(completion);
  const source = completion.activity_source
    ?? (context === 'apple_health' ? 'apple_health'
      : context === 'custom_strength' || context === 'custom_cardio' ? 'live_tracker'
      : undefined);
  const details = completion.activity_details && typeof completion.activity_details === 'object'
    ? (completion.activity_details as ManualActivityDetails)
    : undefined;
  return {
    category: completion.activity_category as any,
    subtype: completion.activity_subtype ?? '',
    intensity: (completion.activity_intensity ?? 'moderate') as any,
    cardioStyle: completion.cardio_style as any,
    ...(source ? { source: source as ActivitySource } : {}),
    distanceMiles: completion.distance_miles ?? undefined,
    caloriesBurned: completion.calories_burned ?? undefined,
    avgHeartRate: completion.hr_summary?.avgBpm != null ? Math.round(Number(completion.hr_summary.avgBpm)) : undefined,
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

export type WorkoutSessionHealthMetrics = {
  caloriesBurned?: number;
  hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] };
};

export function isAppleHealthWorkoutSession(session?: WorkoutSession | null): boolean {
  if (!session) return false;
  const sourceText = [
    session.sourceContext,
    session.importSource,
    session.manualActivity?.source,
  ].map(v => String(v ?? '').trim().toLowerCase()).join(' ');
  return /\b(apple_health|healthkit|apple health)\b/.test(sourceText);
}

export function appleHealthMetricsFromWorkoutSession(session?: WorkoutSession | null): WorkoutSessionHealthMetrics | undefined {
  if (!isAppleHealthWorkoutSession(session)) return undefined;
  const calories = positiveMetric(session?.manualActivity?.caloriesBurned);
  const avgHr = roundedPositiveMetric(session?.manualActivity?.avgHeartRate);
  if (!calories && !avgHr) return undefined;
  return {
    ...(calories ? { caloriesBurned: Math.round(calories) } : {}),
    ...(avgHr ? { hrSummary: { avgBpm: avgHr, maxBpm: avgHr, zoneMinutes: [] } } : {}),
  };
}

export function mergeCompletionIntoWorkoutSession(
  session: WorkoutSession,
  completion: WorkoutCompletionRecord,
): WorkoutSession {
  const manualActivity = manualActivityFromCompletion(completion);
  const routeCoords = Array.isArray(completion.route_coords) && completion.route_coords.length > 0
    ? completion.route_coords.map(c => ({ lat: c.lat, lon: c.lon }))
    : session.routeCoords;
  const importSource = session.importSource ?? completion.import_source ?? undefined;
  return {
    ...session,
    date: session.date || completion.started_at || completion.completed_at || `${completion.workout_date}T12:00:00.000Z`,
    durationSeconds: session.durationSeconds || completion.duration_seconds || 0,
    startedAt: session.startedAt ?? completion.started_at ?? undefined,
    endedAt: session.endedAt ?? completion.ended_at ?? completion.completed_at ?? undefined,
    completed: true,
    sourceContext: completion.source_context ?? session.sourceContext ?? null,
    templateId: completion.template_id ?? session.templateId ?? null,
    planDayId: completion.plan_day_id ?? session.planDayId ?? null,
    manualActivity,
    ...(routeCoords ? { routeCoords } : {}),
    ...(importSource ? { importSource } : {}),
  };
}

function normalizeHrZoneMinutes(raw?: number[] | null): [number, number, number, number, number] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const zones = raw.slice(0, 5).map(v => Number.isFinite(Number(v)) ? Number(v) : 0);
  while (zones.length < 5) zones.push(0);
  return zones as [number, number, number, number, number];
}

function positiveMetric(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function roundedPositiveMetric(value: unknown): number | undefined {
  const n = positiveMetric(value);
  return n != null ? Math.round(n) : undefined;
}

function roundedTrainingScore(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function meaningfulHrZoneMinutes(raw?: number[] | null): [number, number, number, number, number] | undefined {
  const zones = normalizeHrZoneMinutes(raw);
  return zones?.some(v => v > 0) ? zones : undefined;
}

function completionShouldOverrideLocalMetrics(completion?: WorkoutCompletionRecord | null): boolean {
  if (!completion) return false;
  const sourceText = [
    completion.source_context,
    completion.activity_source,
    completion.import_source,
  ].map(v => String(v ?? '').trim().toLowerCase()).join(' ');
  return /\b(apple_health|healthkit|apple health)\b/.test(sourceText);
}

export function mergeCompletionIntoWorkoutSummary(
  summary: StoredWorkoutSummary,
  completion: WorkoutCompletionRecord,
): StoredWorkoutSummary {
  const hr = completion.hr_summary;
  const zones = meaningfulHrZoneMinutes(hr?.zoneMinutes);
  const preferCompletionMetrics = completionShouldOverrideLocalMetrics(completion);
  const summaryCalories = positiveMetric(summary.caloriesBurned);
  const completionCalories = positiveMetric(completion.calories_burned);
  const completionHrAvg = roundedPositiveMetric(hr?.avgBpm);
  const completionHrMax = roundedPositiveMetric(hr?.maxBpm);
  const trainingScore = roundedTrainingScore(completion.training_score);
  const trainingRating = typeof completion.training_rating === 'string'
    ? completion.training_rating as StoredWorkoutSummary['trainingRating']
    : undefined;
  return {
    ...summary,
    caloriesBurned: preferCompletionMetrics
      ? (completionCalories ?? summaryCalories ?? 0)
      : (summaryCalories ?? completionCalories ?? 0),
    hrAvg: preferCompletionMetrics
      ? (completionHrAvg ?? summary.hrAvg)
      : (summary.hrAvg ?? completionHrAvg),
    hrMax: preferCompletionMetrics
      ? (completionHrMax ?? summary.hrMax)
      : (summary.hrMax ?? completionHrMax),
    hrZoneMinutes: preferCompletionMetrics
      ? (zones ?? summary.hrZoneMinutes)
      : (summary.hrZoneMinutes ?? zones),
    trainingScore: summary.trainingScore ?? trainingScore,
    trainingRating: summary.trainingRating ?? trainingRating,
    trainingPillars: summary.trainingPillars ?? (completion.training_pillars as any) ?? undefined,
    trainingPillarBreakdown: summary.trainingPillarBreakdown ?? (completion.training_pillar_breakdown as any) ?? undefined,
  };
}

export function workoutSummaryFromCompletion(completion: WorkoutCompletionRecord): StoredWorkoutSummary | null {
  const hasMetrics = Boolean(
    completion.calories_burned
    || completion.hr_summary?.avgBpm
    || completion.hr_summary?.maxBpm
    || completion.hr_summary?.zoneMinutes?.some(m => Number(m) > 0)
    || completion.training_score != null
  );
  if (!hasMetrics) return null;
  return mergeCompletionIntoWorkoutSummary({
    id: `server-summary-${completion.id}`,
    date: completion.started_at ?? completion.ended_at ?? completion.completed_at ?? `${completion.workout_date}T12:00:00.000Z`,
    focus: completion.focus_label,
    durationSeconds: completion.duration_seconds,
    startedAt: completion.started_at ?? undefined,
    endedAt: completion.ended_at ?? completion.completed_at ?? undefined,
    totalSets: 0,
    totalReps: 0,
    caloriesBurned: completion.calories_burned ?? 0,
    motivationMessage: 'Workout logged.',
    achievements: [],
    recommendations: [],
    headline: 'Workout logged',
    coachingPoint: '',
    motivation: '',
    sourceContext: completion.source_context ?? null,
    activityCategory: completion.activity_category ?? null,
    activitySubtype: completion.activity_subtype ?? null,
    activitySource: completion.activity_source ?? null,
    cardioStyle: completion.cardio_style ?? null,
    distanceMiles: completion.distance_miles ?? null,
    importSource: completion.import_source ?? null,
  }, completion);
}

function workoutSessionTotals(session: WorkoutSession): { totalSets: number; totalReps: number } {
  let totalSets = 0;
  let totalReps = 0;
  for (const exercise of session.exercises ?? []) {
    const sets = exercise.sets ?? [];
    totalSets += sets.length;
    totalReps += sets.reduce((sum, set) => sum + (Number(set.reps) || 0), 0);
  }
  return { totalSets, totalReps };
}

export function workoutSummaryFromSession(
  session: WorkoutSession,
  completion?: WorkoutCompletionRecord | null,
): StoredWorkoutSummary | null {
  const totals = workoutSessionTotals(session);
  const manual = session.manualActivity;
  const manualCalories = positiveMetric(manual?.caloriesBurned);
  const completionCalories = positiveMetric(completion?.calories_burned);
  const preferCompletionMetrics = completionShouldOverrideLocalMetrics(completion);
  const caloriesBurned = preferCompletionMetrics
    ? (completionCalories ?? manualCalories ?? 0)
    : (manualCalories ?? completionCalories ?? 0);
  const manualHrAvg = roundedPositiveMetric(manual?.avgHeartRate);
  const completionHrAvg = roundedPositiveMetric(completion?.hr_summary?.avgBpm);
  const hrAvg = preferCompletionMetrics
    ? (completionHrAvg ?? manualHrAvg)
    : (manualHrAvg ?? completionHrAvg);
  const hrMax = roundedPositiveMetric(completion?.hr_summary?.maxBpm);
  const hrZoneMinutes = meaningfulHrZoneMinutes(completion?.hr_summary?.zoneMinutes);
  const hasMetrics = Boolean(totals.totalSets > 0 || totals.totalReps > 0 || caloriesBurned || hrAvg || hrMax);
  if (!hasMetrics) return null;

  const startedAt = session.startedAt ?? completion?.started_at ?? undefined;
  const endedAt = session.endedAt ?? completion?.ended_at ?? completion?.completed_at ?? undefined;
  const routeCoords = session.routeCoords && session.routeCoords.length > 0
    ? session.routeCoords
    : (manual?.routeCoords && manual.routeCoords.length > 0
      ? manual.routeCoords.map(c => ({ lat: c.lat, lon: c.lon }))
      : null);
  const summary: StoredWorkoutSummary = {
    id: session.id || (completion ? `server-summary-${completion.id}` : `session-summary-${session.date}`),
    date: startedAt ?? session.date ?? completion?.completed_at ?? `${completion?.workout_date ?? ''}T12:00:00.000Z`,
    focus: session.focus || completion?.focus_label || 'Workout',
    durationSeconds: session.durationSeconds || completion?.duration_seconds || 0,
    startedAt,
    endedAt,
    totalSets: totals.totalSets,
    totalReps: totals.totalReps,
    caloriesBurned,
    motivationMessage: 'Workout logged.',
    achievements: [],
    recommendations: [],
    headline: 'Workout logged',
    coachingPoint: '',
    motivation: '',
    sourceContext: session.sourceContext ?? completion?.source_context ?? null,
    activityCategory: manual?.category ?? completion?.activity_category ?? null,
    activitySubtype: manual?.subtype ?? completion?.activity_subtype ?? null,
    activitySource: manual?.source ?? completion?.activity_source ?? null,
    cardioStyle: manual?.cardioStyle ?? completion?.cardio_style ?? null,
    distanceMiles: manual?.distanceMiles ?? completion?.distance_miles ?? null,
    importSource: session.importSource ?? completion?.import_source ?? null,
    ...(hrAvg ? { hrAvg } : {}),
    ...(hrMax ? { hrMax } : {}),
    ...(hrZoneMinutes ? { hrZoneMinutes } : {}),
    ...(routeCoords ? { routeCoords } : {}),
    exercises: (session.exercises ?? []).map(ex => ({
      name: ex.name,
      equipment: typeof ex.equipment === 'string' ? ex.equipment : null,
      targetSets: typeof ex.targetSets === 'number' ? ex.targetSets : undefined,
      targetReps: typeof ex.targetReps === 'string' ? ex.targetReps : undefined,
      sets: ex.sets ?? [],
      warmupSets: ex.warmupSets ?? [],
    })),
  };
  return completion ? mergeCompletionIntoWorkoutSummary(summary, completion) : summary;
}

export function mergeSessionIntoWorkoutSummary(
  summary: StoredWorkoutSummary,
  sessionSummary: StoredWorkoutSummary,
): StoredWorkoutSummary {
  return {
    ...sessionSummary,
    ...summary,
    durationSeconds: summary.durationSeconds || sessionSummary.durationSeconds,
    totalSets: summary.totalSets > 0 ? summary.totalSets : sessionSummary.totalSets,
    totalReps: summary.totalReps > 0 ? summary.totalReps : sessionSummary.totalReps,
    caloriesBurned: summary.caloriesBurned || sessionSummary.caloriesBurned,
    hrAvg: summary.hrAvg ?? sessionSummary.hrAvg,
    hrMax: summary.hrMax ?? sessionSummary.hrMax,
    hrZoneMinutes: summary.hrZoneMinutes ?? sessionSummary.hrZoneMinutes,
    startedAt: summary.startedAt ?? sessionSummary.startedAt,
    endedAt: summary.endedAt ?? sessionSummary.endedAt,
    sourceContext: summary.sourceContext ?? sessionSummary.sourceContext,
    activityCategory: summary.activityCategory ?? sessionSummary.activityCategory,
    activitySubtype: summary.activitySubtype ?? sessionSummary.activitySubtype,
    activitySource: summary.activitySource ?? sessionSummary.activitySource,
    cardioStyle: summary.cardioStyle ?? sessionSummary.cardioStyle,
    distanceMiles: summary.distanceMiles ?? sessionSummary.distanceMiles,
    importSource: summary.importSource ?? sessionSummary.importSource,
    routeCoords: summary.routeCoords ?? sessionSummary.routeCoords,
    exercises: summary.exercises && summary.exercises.length > 0 ? summary.exercises : sessionSummary.exercises,
  };
}

export function sanitizeWorkoutHistorySession(session: WorkoutSession): WorkoutSession {
  if (!session.manualActivity) return session;
  if (!Array.isArray(session.exercises) || session.exercises.length === 0) return session;
  const { manualActivity: _manualActivity, ...rest } = session;
  return rest;
}

export function isExtraWorkoutActivitySession(session: WorkoutSession): boolean {
  if (!session.completed || session.skipped) return false;
  if (sessionPlanDayId(session) != null) return false;

  const context = normalizedSessionContext(session);
  if (context) return isExtraWorkoutSourceContext(context);

  const clean = sanitizeWorkoutHistorySession(session);
  return Boolean(
    clean.manualActivity
    && ((clean.exercises ?? []).length === 0),
  );
}

export function isExtraWorkoutSourceContext(context: string | null | undefined): boolean {
  const normalized = String(context ?? '').trim().toLowerCase();
  return EXTRA_WORKOUT_CONTEXTS.has(normalized) || normalized.startsWith('custom_');
}

export function workoutSessionCountsForPlan(session: WorkoutSession): boolean {
  if (!session.completed || session.skipped) return false;
  if (sessionPlanDayId(session) != null) return true;

  const context = normalizedSessionContext(session);
  if (context) {
    if (context === 'planned' || context === 'plan' || context === 'generated') return true;
    if (context.includes('readiness_lighter_day') || context.includes('period_lighter_day')) return true;
    if (isExtraWorkoutSourceContext(context)) return false;
    return false;
  }

  if (isExtraWorkoutActivitySession(session)) return false;
  return (session.exercises ?? []).length > 0;
}
