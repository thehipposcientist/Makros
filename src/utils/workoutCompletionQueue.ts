import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  logWorkoutDone,
  type LoggedExercisePayload,
  type WorkoutTrainingScorePayload,
  type WorkoutCompleteResponse,
} from '../services/api';
import type { ManualActivityDetails, WorkoutSession } from '../types';
import { STORAGE_KEYS } from './storageKeys.ts';

export const PENDING_WORKOUT_COMPLETIONS_KEY = STORAGE_KEYS.workouts.pendingCompletions;

export type WorkoutCompletionActivityPayload = {
  category?: string;
  subtype?: string;
  intensity?: string;
  source?: string;
  cardioStyle?: string;
  distanceMiles?: number;
  caloriesBurned?: number;
  avgHeartRate?: number;
  /** GPS route trail captured during the session — passes through to
   *  the WorkoutCompletion.route_coords backend column for the
   *  post-workout map and Apple Fitness route view. */
  routeCoords?: Array<{ lat: number; lon: number; t_ms: number; acc_m?: number | null; alt_m?: number | null; v_acc_m?: number | null }>;
  /** Per-subtype structured detail (sauna temp, cold plunge depth, swim
   *  stroke, climbing grade, etc). Persisted to
   *  WorkoutCompletion.activity_details JSONB. */
  details?: ManualActivityDetails;
};

export type WorkoutCompletionHealthPayload = {
  caloriesBurned?: number;
  hrSummary?: { avgBpm: number; maxBpm: number; zoneMinutes: number[] };
};

export type WorkoutCompletionFeedbackPayload = {
  feeling?: string;
  intensity?: number;
  sorenessAreas?: string[];
  notes?: string;
};

export type WorkoutCompletionSourcePayload = {
  sourceContext?: 'planned' | 'saved_template' | 'custom_strength' | 'custom_cardio' | 'manual_activity' | 'apple_health' | 'watch' | 'coach_log' | string;
  templateId?: string | null;
  planDayId?: number | null;
  stimulus?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  externalSourceId?: string | null;
  idempotencyKey?: string | null;
};

export type WorkoutCompletionRequest = {
  workout_date: string;
  focus_label: string;
  duration_seconds: number;
  exercises?: LoggedExercisePayload[];
  activity?: WorkoutCompletionActivityPayload;
  healthMetrics?: WorkoutCompletionHealthPayload;
  feedback?: WorkoutCompletionFeedbackPayload;
  training?: WorkoutTrainingScorePayload;
  gearIds?: number[];
  source?: WorkoutCompletionSourcePayload;
};

export type PendingWorkoutCompletion = {
  id: string;
  request: WorkoutCompletionRequest;
  session?: WorkoutSession;
  queuedAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
};

export type WorkoutCompletionFlushResult = {
  synced: number;
  failed: number;
  remaining: number;
};

let flushInFlight: Promise<WorkoutCompletionFlushResult> | null = null;

function completionQueueId(request: WorkoutCompletionRequest): string {
  const idempotency = request.source?.idempotencyKey?.trim();
  if (idempotency) return idempotency;
  const external = request.source?.externalSourceId?.trim();
  if (external) return external;
  const started = request.source?.startedAt ?? '';
  const ended = request.source?.endedAt ?? '';
  return [
    request.workout_date,
    request.focus_label.trim().toLowerCase(),
    started,
    ended,
    String(request.duration_seconds),
  ].join('|');
}

function requestWithIdempotency(request: WorkoutCompletionRequest): WorkoutCompletionRequest {
  const id = completionQueueId(request);
  return {
    ...request,
    source: {
      ...(request.source ?? {}),
      externalSourceId: request.source?.externalSourceId ?? id,
      idempotencyKey: request.source?.idempotencyKey ?? id,
    },
  };
}

async function clearActiveWorkoutDraftIfMatching(request: WorkoutCompletionRequest): Promise<void> {
  const startedAtMs = new Date(request.source?.startedAt ?? '').getTime();
  if (!Number.isFinite(startedAtMs)) return;
  try {
    const activeStartRaw = await AsyncStorage.getItem(STORAGE_KEYS.workouts.activeStartTime);
    const activeStartMs = Number(activeStartRaw);
    if (!Number.isFinite(activeStartMs) || Math.abs(activeStartMs - startedAtMs) > 10_000) return;
    await AsyncStorage.multiRemove([
      STORAGE_KEYS.workouts.activeSession,
      STORAGE_KEYS.workouts.activeSets,
      STORAGE_KEYS.workouts.activeStartTime,
      STORAGE_KEYS.workouts.activeRest,
      STORAGE_KEYS.workouts.activeTimers,
      STORAGE_KEYS.workouts.activeWatchSessionId,
      STORAGE_KEYS.workouts.activePausedAtMs,
      STORAGE_KEYS.workouts.activePausedAccumMs,
    ]);
  } catch {
    // Best-effort cache cleanup only. The DB completion already succeeded.
  }
}

function mergeRequest(
  existing: WorkoutCompletionRequest,
  incoming: WorkoutCompletionRequest,
): WorkoutCompletionRequest {
  return {
    workout_date: incoming.workout_date || existing.workout_date,
    focus_label: incoming.focus_label || existing.focus_label,
    duration_seconds: Number.isFinite(incoming.duration_seconds)
      ? incoming.duration_seconds
      : existing.duration_seconds,
    exercises: incoming.exercises && incoming.exercises.length > 0
      ? incoming.exercises
      : existing.exercises,
    activity: incoming.activity ?? existing.activity,
    healthMetrics: incoming.healthMetrics ?? existing.healthMetrics,
    feedback: incoming.feedback || existing.feedback
      ? { ...(existing.feedback ?? {}), ...(incoming.feedback ?? {}) }
      : undefined,
    training: incoming.training ?? existing.training,
    gearIds: Array.isArray(incoming.gearIds) ? incoming.gearIds : existing.gearIds,
    source: incoming.source || existing.source
      ? { ...(existing.source ?? {}), ...(incoming.source ?? {}) }
      : undefined,
  };
}

function normalizeQueue(raw: unknown): PendingWorkoutCompletion[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PendingWorkoutCompletion => {
    return Boolean(
      item
      && typeof item === 'object'
      && typeof (item as PendingWorkoutCompletion).id === 'string'
      && (item as PendingWorkoutCompletion).request
      && typeof (item as PendingWorkoutCompletion).request.workout_date === 'string'
      && typeof (item as PendingWorkoutCompletion).request.focus_label === 'string'
      && typeof (item as PendingWorkoutCompletion).request.duration_seconds === 'number',
    );
  });
}

async function writePendingWorkoutCompletions(items: PendingWorkoutCompletion[]): Promise<void> {
  const sorted = [...items]
    .sort((a, b) => (b.queuedAt ?? '').localeCompare(a.queuedAt ?? ''))
    .slice(0, 50);
  if (sorted.length === 0) {
    await AsyncStorage.removeItem(PENDING_WORKOUT_COMPLETIONS_KEY);
    return;
  }
  await AsyncStorage.setItem(PENDING_WORKOUT_COMPLETIONS_KEY, JSON.stringify(sorted));
}

export async function loadPendingWorkoutCompletions(): Promise<PendingWorkoutCompletion[]> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_WORKOUT_COMPLETIONS_KEY);
    return raw ? normalizeQueue(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export async function enqueueWorkoutCompletion(
  request: WorkoutCompletionRequest,
  session?: WorkoutSession,
  error?: unknown,
): Promise<PendingWorkoutCompletion> {
  const queuedRequest = requestWithIdempotency(request);
  const now = new Date().toISOString();
  const id = completionQueueId(queuedRequest);
  const queue = await loadPendingWorkoutCompletions();
  const idx = queue.findIndex(item => item.id === id);
  const lastError = error instanceof Error ? error.message : (error ? String(error) : undefined);
  const item: PendingWorkoutCompletion = idx >= 0
    ? {
        ...queue[idx],
        request: mergeRequest(queue[idx].request, queuedRequest),
        session: session ?? queue[idx].session,
        lastError: lastError ?? queue[idx].lastError,
      }
    : {
        id,
        request: queuedRequest,
        session,
        queuedAt: now,
        attempts: 0,
        lastError,
      };
  if (idx >= 0) queue[idx] = item;
  else queue.unshift(item);
  await writePendingWorkoutCompletions(queue);
  return item;
}

export async function removePendingWorkoutCompletion(requestOrId: WorkoutCompletionRequest | string): Promise<void> {
  const id = typeof requestOrId === 'string' ? requestOrId : completionQueueId(requestOrId);
  const queue = await loadPendingWorkoutCompletions();
  const next = queue.filter(item => item.id !== id);
  if (next.length !== queue.length) await writePendingWorkoutCompletions(next);
}

export async function updatePendingWorkoutCompletionFeedback(
  externalSourceId: string | null | undefined,
  feedback: WorkoutCompletionFeedbackPayload,
): Promise<boolean> {
  const id = externalSourceId?.trim();
  if (!id) return false;
  const queue = await loadPendingWorkoutCompletions();
  const idx = queue.findIndex(item => item.id === id || item.request.source?.externalSourceId === id);
  if (idx < 0) return false;
  queue[idx] = {
    ...queue[idx],
    request: mergeRequest(queue[idx].request, {
      ...queue[idx].request,
      feedback,
    }),
  };
  await writePendingWorkoutCompletions(queue);
  return true;
}

export async function completeWorkoutWithOfflineQueue(
  token: string,
  request: WorkoutCompletionRequest,
  session?: WorkoutSession,
): Promise<WorkoutCompleteResponse | null> {
  const safeRequest = requestWithIdempotency(request);
  try {
    const response = await logWorkoutDone(
      token,
      safeRequest.workout_date,
      safeRequest.focus_label,
      safeRequest.duration_seconds,
      safeRequest.exercises,
      safeRequest.activity,
      safeRequest.healthMetrics,
      safeRequest.feedback,
      safeRequest.training,
      safeRequest.gearIds,
      safeRequest.source,
      { timeoutMs: 8000, noRetry: true },
    );
    await removePendingWorkoutCompletion(safeRequest);
    await clearActiveWorkoutDraftIfMatching(safeRequest);
    return response;
  } catch (error) {
    await enqueueWorkoutCompletion(safeRequest, session, error);
    return null;
  }
}

async function flushPendingWorkoutCompletionsNow(token: string): Promise<WorkoutCompletionFlushResult> {
  const queue = await loadPendingWorkoutCompletions();
  if (queue.length === 0) return { synced: 0, failed: 0, remaining: 0 };

  const remaining: PendingWorkoutCompletion[] = [];
  let synced = 0;
  let failed = 0;

  const oldestFirst = [...queue].reverse();
  for (let idx = 0; idx < oldestFirst.length; idx += 1) {
    const item = oldestFirst[idx];
    try {
      await logWorkoutDone(
        token,
        item.request.workout_date,
        item.request.focus_label,
        item.request.duration_seconds,
        item.request.exercises,
        item.request.activity,
        item.request.healthMetrics,
        item.request.feedback,
        item.request.training,
        item.request.gearIds,
        item.request.source,
      );
      await clearActiveWorkoutDraftIfMatching(item.request);
      synced += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      remaining.push({
        ...item,
        attempts: (item.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: message,
      });
      const lower = message.toLowerCase();
      if (lower.includes("can't reach") || lower.includes('timed out') || lower.includes('network request failed')) {
        remaining.push(...oldestFirst.slice(idx + 1));
        break;
      }
    }
  }

  await writePendingWorkoutCompletions(remaining);
  return { synced, failed, remaining: remaining.length };
}

export async function flushPendingWorkoutCompletions(token: string): Promise<WorkoutCompletionFlushResult> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = flushPendingWorkoutCompletionsNow(token).finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}
