import type { WorkoutCompletionRecord } from '../services/api';
import type { ActivitySource, WorkoutSession } from '../types';

const MANUAL_COMPLETION_CONTEXTS = new Set([
  'manual_activity',
  'apple_health',
  'watch',
  'coach_log',
]);

function normalizedContext(completion: WorkoutCompletionRecord): string {
  return String(completion.source_context ?? '').trim().toLowerCase();
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
    ?? (context === 'apple_health' ? 'apple_health' : undefined);
  return {
    category: completion.activity_category as any,
    subtype: completion.activity_subtype ?? '',
    intensity: (completion.activity_intensity ?? 'moderate') as any,
    cardioStyle: completion.cardio_style as any,
    ...(source ? { source: source as ActivitySource } : {}),
    distanceMiles: completion.distance_miles ?? undefined,
    caloriesBurned: completion.calories_burned ?? undefined,
    avgHeartRate: completion.hr_summary?.avgBpm != null ? Math.round(Number(completion.hr_summary.avgBpm)) : undefined,
  };
}

export function mergeCompletionIntoWorkoutSession(
  session: WorkoutSession,
  completion: WorkoutCompletionRecord,
): WorkoutSession {
  const manualActivity = manualActivityFromCompletion(completion);
  return {
    ...session,
    date: session.date || completion.started_at || completion.completed_at || `${completion.workout_date}T12:00:00.000Z`,
    durationSeconds: session.durationSeconds || completion.duration_seconds || 0,
    startedAt: session.startedAt ?? completion.started_at ?? undefined,
    endedAt: session.endedAt ?? completion.ended_at ?? completion.completed_at ?? undefined,
    completed: true,
    manualActivity,
  };
}

export function sanitizeWorkoutHistorySession(session: WorkoutSession): WorkoutSession {
  if (!session.manualActivity) return session;
  if (!Array.isArray(session.exercises) || session.exercises.length === 0) return session;
  const { manualActivity: _manualActivity, ...rest } = session;
  return rest;
}

export function isExtraWorkoutActivitySession(session: WorkoutSession): boolean {
  const clean = sanitizeWorkoutHistorySession(session);
  return Boolean(
    clean.manualActivity
    && !clean.skipped
    && ((clean.exercises ?? []).length === 0),
  );
}
