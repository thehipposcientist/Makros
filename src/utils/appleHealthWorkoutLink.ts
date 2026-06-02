import type { HRZone } from '../services/api';
import {
  getAppleHealthWorkoutRoute,
  getAppleHealthWorkouts,
  getAppleWorkoutCaloriesForWindow,
  getWorkoutHrSummary,
  type WorkoutHrSummary,
} from '../services/appleHealth';
import type { ActivityIntensity, StoredWorkoutSummary, WorkoutDetail, WorkoutSession } from '../types';
import { classifyActivity, externalIdFor } from './workoutAutoImport';
import { completeWorkoutWithOfflineQueue } from './workoutCompletionQueue';
import { workoutSessionToLoggedPayload } from './workoutLogPayload';
import { dateKey, loadWorkoutSummaries, saveWorkoutSession, saveWorkoutSummary } from './workoutHistory';

export type AppleHealthWorkoutLinkCandidate = {
  externalId: string;
  activityName: string;
  startDate: string;
  endDate: string;
  durationMin: number;
  calories?: number | null;
  distanceMiles?: number | null;
  elevationGainFt?: number | null;
  routeCoords?: Array<{ lat: number; lon: number; t_ms: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }> | null;
  overlapMs: number;
  startDeltaMs: number;
};

export type AppleHealthWorkoutLinkOptions = {
  authToken?: string | null;
  age?: number | null;
  restingHeartRate?: number | null;
  hrZones?: HRZone[] | null;
  profile?: { maxHeartRate?: number | null; max_heart_rate?: number | null } | null;
};

function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function startOfLocalDayMs(value: string): number {
  const key = value ? value.slice(0, 10) : dateKey(new Date());
  const ms = new Date(`${key}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function sessionWindow(session: WorkoutSession): { startMs: number; endMs: number; hasExactTime: boolean } {
  const dateStart = startOfLocalDayMs(session.startedAt ?? session.date);
  const startMs = parseTime(session.startedAt) ?? parseTime(session.date) ?? dateStart;
  const durationMs = Math.max(0, Number(session.durationSeconds) || 0) * 1000;
  const endMs = parseTime(session.endedAt) ?? (durationMs > 0 ? startMs + durationMs : startMs + 60 * 60_000);
  return {
    startMs,
    endMs: endMs > startMs ? endMs : startMs + Math.max(durationMs, 60 * 60_000),
    hasExactTime: Boolean(session.startedAt || session.endedAt || durationMs > 0),
  };
}

function searchWindow(session: WorkoutSession): { startMs: number; endMs: number } {
  const dayStart = startOfLocalDayMs(session.startedAt ?? session.date);
  const dayEnd = dayStart + 24 * 60 * 60_000;
  const exact = sessionWindow(session);
  const startMs = exact.hasExactTime ? Math.min(dayStart, exact.startMs - 4 * 60 * 60_000) : dayStart;
  const endMs = exact.hasExactTime ? Math.max(dayEnd, exact.endMs + 4 * 60 * 60_000) : dayEnd;
  return { startMs, endMs };
}

function normalizeWorkout(raw: any): WorkoutDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const startMs = parseTime(raw.startDate);
  const endMs = parseTime(raw.endDate);
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  const duration = Number(raw.duration);
  const durationMin = Number.isFinite(duration) && duration > 0
    ? duration
    : (endMs - startMs) / 60_000;
  return {
    activityType: Number(raw.activityType) || 0,
    activityName: String(raw.activityName || 'Workout'),
    duration: durationMin,
    startDate: raw.startDate,
    endDate: raw.endDate,
    calories: Number.isFinite(Number(raw.calories)) ? Number(raw.calories) : undefined,
    distanceMiles: Number.isFinite(Number(raw.distanceMiles)) ? Number(raw.distanceMiles) : undefined,
    elevationGainFt: Number.isFinite(Number(raw.elevationGainFt)) ? Number(raw.elevationGainFt) : undefined,
    routeCoords: Array.isArray(raw.routeCoords) ? raw.routeCoords : undefined,
  };
}

function candidateFromWorkout(
  workout: WorkoutDetail,
  session: WorkoutSession,
): AppleHealthWorkoutLinkCandidate | null {
  const startMs = parseTime(workout.startDate);
  const endMs = parseTime(workout.endDate);
  if (startMs == null || endMs == null || endMs <= startMs) return null;
  const local = sessionWindow(session);
  const overlapMs = Math.max(0, Math.min(local.endMs, endMs) - Math.max(local.startMs, startMs));
  return {
    externalId: externalIdFor(workout),
    activityName: workout.activityName || 'Workout',
    startDate: workout.startDate,
    endDate: workout.endDate,
    durationMin: Math.max(1, Math.round(workout.duration || ((endMs - startMs) / 60_000))),
    calories: workout.calories ?? null,
    distanceMiles: workout.distanceMiles ?? null,
    elevationGainFt: workout.elevationGainFt ?? null,
    routeCoords: workout.routeCoords ?? null,
    overlapMs,
    startDeltaMs: Math.abs(startMs - local.startMs),
  };
}

export async function findAppleHealthWorkoutLinkCandidates(
  session: WorkoutSession,
  limit = 20,
): Promise<AppleHealthWorkoutLinkCandidate[]> {
  const window = searchWindow(session);
  const raw = await getAppleHealthWorkouts(window.startMs, window.endMs);
  const candidates = raw
    .map(normalizeWorkout)
    .filter((w): w is WorkoutDetail => Boolean(w))
    .map(w => candidateFromWorkout(w, session))
    .filter((c): c is AppleHealthWorkoutLinkCandidate => Boolean(c));

  candidates.sort((a, b) => {
    if (b.overlapMs !== a.overlapMs) return b.overlapMs - a.overlapMs;
    if (a.startDeltaMs !== b.startDeltaMs) return a.startDeltaMs - b.startDeltaMs;
    return b.startDate.localeCompare(a.startDate);
  });
  return candidates.slice(0, limit);
}

function sessionTotals(session: WorkoutSession): { totalSets: number; totalReps: number } {
  let totalSets = 0;
  let totalReps = 0;
  for (const ex of session.exercises ?? []) {
    const sets = Array.isArray(ex.sets) ? ex.sets : [];
    totalSets += sets.length;
    totalReps += sets.reduce((sum, set) => sum + (Number(set.reps) || 0), 0);
  }
  return { totalSets, totalReps };
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function summaryForLinkedWorkout(
  session: WorkoutSession,
  candidate: AppleHealthWorkoutLinkCandidate,
  hr: WorkoutHrSummary | null,
  calories: number | null,
): StoredWorkoutSummary {
  const totals = sessionTotals(session);
  return {
    id: session.id,
    date: candidate.startDate,
    focus: session.focus,
    durationSeconds: session.durationSeconds,
    totalSets: totals.totalSets,
    totalReps: totals.totalReps,
    startedAt: candidate.startDate,
    endedAt: candidate.endDate,
    caloriesBurned: calories ?? 0,
    motivationMessage: 'Apple Health workout attached.',
    achievements: [],
    recommendations: [],
    headline: 'Apple Health linked',
    comparison: '',
    coachingPoint: '',
    motivation: '',
    hrAvg: hr?.avgBpm != null ? Math.round(hr.avgBpm) : undefined,
    hrMax: hr?.maxBpm != null ? Math.round(hr.maxBpm) : undefined,
    hrZoneMinutes: hr?.zoneMinutes,
  };
}

export async function linkAppleHealthWorkoutToSession(
  session: WorkoutSession,
  candidate: AppleHealthWorkoutLinkCandidate,
  options: AppleHealthWorkoutLinkOptions = {},
): Promise<WorkoutSession> {
  const startMs = parseTime(candidate.startDate);
  const endMs = parseTime(candidate.endDate);
  if (startMs == null || endMs == null || endMs <= startMs) {
    throw new Error('Apple Health workout is missing a valid time range.');
  }

  const durationSeconds = Math.max(60, Math.round((endMs - startMs) / 1000));
  const candidateCalories = finiteNumber(candidate.calories);
  const fallbackCalories = candidateCalories == null
    ? await getAppleWorkoutCaloriesForWindow(startMs, endMs).catch(() => null)
    : null;
  const calories = candidateCalories ?? fallbackCalories;
  const hr = await getWorkoutHrSummary(
    startMs,
    endMs,
    options.age ?? null,
    options.restingHeartRate ?? null,
    options.hrZones ?? null,
    options.profile ?? null,
  ).catch(() => null);
  const route = candidate.routeCoords && candidate.routeCoords.length > 0
    ? null
    : await getAppleHealthWorkoutRoute(startMs, endMs).catch(() => null);
  const avgHr = hr?.avgBpm != null ? Math.round(hr.avgBpm) : null;
  const distanceMiles = finiteNumber(candidate.distanceMiles);
  const routeCoords = candidate.routeCoords && candidate.routeCoords.length > 0
    ? candidate.routeCoords
    : route?.routeCoords ?? null;
  const elevationGainFt = candidate.elevationGainFt ?? route?.elevationGainFt ?? null;
  const mergedDetails = {
    ...(session.manualActivity?.details ?? {}),
    ...(elevationGainFt != null ? { elevationGainFt } : {}),
  };
  const activityInfo = classifyActivity(candidate.activityName);
  const exercises = Array.isArray(session.exercises) ? session.exercises : [];
  const existingActivity = session.manualActivity;
  const linkedAppleHealthWorkout: WorkoutSession['linkedAppleHealthWorkout'] = {
    externalId: candidate.externalId,
    activityName: candidate.activityName,
    startDate: candidate.startDate,
    endDate: candidate.endDate,
    durationSeconds,
    caloriesBurned: calories,
    distanceMiles,
    avgHeartRate: avgHr,
    maxHeartRate: hr?.maxBpm != null ? Math.round(hr.maxBpm) : null,
  };

  const updatedSession: WorkoutSession = {
    ...session,
    date: candidate.startDate,
    startedAt: candidate.startDate,
    endedAt: candidate.endDate,
    durationSeconds,
    completed: true,
    linkedAppleHealthWorkout,
  };

  if (exercises.length === 0) {
    updatedSession.manualActivity = {
      category: activityInfo.category ?? existingActivity?.category,
      subtype: activityInfo.subtype ?? existingActivity?.subtype,
      intensity: existingActivity?.intensity ?? ('moderate' as ActivityIntensity),
      cardioStyle: activityInfo.cardioStyle ?? existingActivity?.cardioStyle,
      notes: existingActivity?.notes,
      source: 'apple_health',
      distanceMiles: distanceMiles ?? existingActivity?.distanceMiles,
      caloriesBurned: calories ?? existingActivity?.caloriesBurned,
      avgHeartRate: avgHr ?? existingActivity?.avgHeartRate,
      ...(Object.keys(mergedDetails).length > 0 ? { details: mergedDetails } : {}),
      routeCoords: routeCoords ?? existingActivity?.routeCoords,
    };
  }
  if (routeCoords && routeCoords.length > 0) {
    updatedSession.routeCoords = routeCoords.map(p => ({ lat: p.lat, lon: p.lon }));
  }

  const summaries = await loadWorkoutSummaries().catch(() => []);
  const existingSummary = summaries.find(s => s.id === session.id)
    ?? summaries.find(s => s.date && session.date && s.date.slice(0, 10) === session.date.slice(0, 10) && s.focus === session.focus);
  const linkedSummary = {
    ...summaryForLinkedWorkout(updatedSession, candidate, hr, calories),
    ...(existingSummary ?? {}),
    id: session.id,
    date: candidate.startDate,
    focus: session.focus,
    durationSeconds,
    startedAt: candidate.startDate,
    endedAt: candidate.endDate,
    caloriesBurned: calories ?? existingSummary?.caloriesBurned ?? 0,
    hrAvg: avgHr ?? existingSummary?.hrAvg,
    hrMax: hr?.maxBpm != null ? Math.round(hr.maxBpm) : existingSummary?.hrMax,
    hrZoneMinutes: hr?.zoneMinutes ?? existingSummary?.hrZoneMinutes,
    ...(routeCoords && routeCoords.length > 0
      ? { routeCoords: routeCoords.map(p => ({ lat: p.lat, lon: p.lon })) }
      : {}),
  };

  await saveWorkoutSession(updatedSession, { skipHealthMirror: true });
  await saveWorkoutSummary(linkedSummary);

  if (options.authToken) {
    await completeWorkoutWithOfflineQueue(
      options.authToken,
      {
        workout_date: dateKey(new Date(candidate.startDate)),
        focus_label: updatedSession.focus,
        duration_seconds: durationSeconds,
        exercises: workoutSessionToLoggedPayload(updatedSession),
        activity: updatedSession.manualActivity ? {
          category: updatedSession.manualActivity.category,
          subtype: updatedSession.manualActivity.subtype,
          intensity: updatedSession.manualActivity.intensity,
          source: updatedSession.manualActivity.source,
          cardioStyle: updatedSession.manualActivity.cardioStyle,
          distanceMiles: updatedSession.manualActivity.distanceMiles,
          caloriesBurned: updatedSession.manualActivity.caloriesBurned,
          avgHeartRate: updatedSession.manualActivity.avgHeartRate,
          details: updatedSession.manualActivity.details,
          routeCoords: updatedSession.manualActivity.routeCoords,
        } : undefined,
        healthMetrics: (calories != null || hr) ? {
          caloriesBurned: calories ?? undefined,
          hrSummary: hr ? {
            avgBpm: Math.round(hr.avgBpm),
            maxBpm: Math.round(hr.maxBpm),
            zoneMinutes: hr.zoneMinutes,
          } : undefined,
        } : undefined,
        source: {
          sourceContext: 'apple_health',
          templateId: updatedSession.templateId ?? null,
          planDayId: updatedSession.planDayId ?? null,
          startedAt: candidate.startDate,
          endedAt: candidate.endDate,
          externalSourceId: updatedSession.id,
        },
      },
      updatedSession,
    );
  }

  return updatedSession;
}
