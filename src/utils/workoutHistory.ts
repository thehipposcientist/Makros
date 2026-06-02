import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, CompletedSet, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, MealRoutineEntry, DailyNutritionPlan, MealSuggestion, WorkoutDay, SavedWorkoutTemplate } from '../types';
import {
  deleteWorkoutTemplateFromStorage,
  loadWorkoutTemplatesFromStorage,
  saveWorkoutTemplatesToStorage,
  upsertWorkoutTemplateInStorage,
} from './workoutTemplates';
import { sanitizeWorkoutHistorySession, workoutSessionCountsForPlan } from './workoutCompletion';
import { isTrackableStrengthExercise, loadedStrengthSets } from './workoutProgressFilters';
import {
  exerciseHistoryEntriesMatch,
  type ExerciseHistoryMatchInput,
} from './exerciseHistoryMatch';
import { STORAGE_KEYS } from './storageKeys.ts';
export {
  exerciseHistoryEntriesMatch,
  exerciseHistoryNamesMatch,
  normalizeExerciseHistoryName,
  type ExerciseHistoryMatchInput,
} from './exerciseHistoryMatch';

// CachedFetchedEntity: workout sessions/summaries mirror backend
// WorkoutCompletion/WorkoutSession rows and can be rebuilt from API reads.
// LocalDraftEntity: manual overrides and active-session data are crash/UI
// recovery only and must become saved rows through explicit DB mutations.
const HISTORY_KEY        = STORAGE_KEYS.workouts.history;
const SKIPPED_KEY        = STORAGE_KEYS.workouts.skipped;
const SUMMARIES_KEY      = STORAGE_KEYS.workouts.summaries;
const GOAL_HIST_KEY      = STORAGE_KEYS.workouts.goalHistory;
const PLAN_CHANGES_KEY   = STORAGE_KEYS.workouts.planChangeHistory;
const PRESERVED_WORKOUTS_KEY = STORAGE_KEYS.workouts.preservedCompleted;
const MANUAL_WORKOUT_OVERRIDES_KEY = STORAGE_KEYS.workouts.manualOverrides;
const WORKOUT_TEMPLATE_DELETED_IDS_KEY = STORAGE_KEYS.workouts.templateDeletedIds;
let mealRoutineMemory: MealRoutineEntry[] = [];

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns a Date as YYYY-MM-DD in local time. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function todayKey(): string {
  return dateKey(new Date());
}

// ── Workout sessions ──────────────────────────────────────────────────────────

export async function saveWorkoutSession(
  session: WorkoutSession,
  options: { skipHealthMirror?: boolean } = {},
): Promise<void> {
  const cleanSession = sanitizeWorkoutHistorySession(session);
  const history = await loadWorkoutHistory();
  const idx = history.findIndex(s => s.id === cleanSession.id);
  if (idx >= 0) {
    history[idx] = cleanSession;
  } else {
    history.unshift(cleanSession);
  }
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
  if (options.skipHealthMirror) return;

  // Mirror to Apple Health for any session that wasn't already
  // sourced FROM Apple Health (no infinite-loop on import) and that
  // has real start/end timestamps. Best-effort + opt-in via the
  // user's existing isAppleHealthEnabled flag.
  try {
    const fromHK = cleanSession.id?.startsWith('hk_');
    if (fromHK) return;
    if (!cleanSession.startedAt || !cleanSession.endedAt) return;
    const enabled = await isAppleHealthEnabled().catch(() => false);
    if (!enabled) return;
    const { saveWorkoutToHealth, isHealthKitAvailable } = await import('../services/appleHealth');
    if (!isHealthKitAvailable()) return;
    const tag = cleanSession.manualActivity?.subtype
      || cleanSession.focus
      || 'Workout';
    await saveWorkoutToHealth({
      startedAt: new Date(cleanSession.startedAt),
      endedAt: new Date(cleanSession.endedAt),
      activityTag: tag,
      caloriesBurned: cleanSession.manualActivity?.caloriesBurned ?? null,
      distanceMiles: cleanSession.manualActivity?.distanceMiles ?? null,
      // Route plumbed through so HKWorkoutRouteBuilder can attach the
      // GPS trail to the Apple Fitness workout entry.
      routeCoords: cleanSession.manualActivity?.routeCoords ?? null,
    });
  } catch { /* non-fatal — session is already in local history */ }
}

/** Delete a single workout session by id and also drop any stored summary
 *  or preserved-completed-workout snapshot for the same date so the
 *  dashboard doesn't keep showing it as "done". */
export async function deleteWorkoutSession(sessionId: string): Promise<void> {
  const history = await loadWorkoutHistory();
  const target = history.find(s => s.id === sessionId);
  const remaining = history.filter(s => s.id !== sessionId);
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(remaining));

  // Drop the per-date derived artifacts if no other session exists for
  // that date. Keeps the progress screen, the dashboard "Done" badge,
  // and the preserved-workout overlay consistent after a delete.
  if (target) {
    const date = target.date.split('T')[0];
    const stillHasThatDate = remaining.some(s => s.date.startsWith(date));
    if (!stillHasThatDate) {
      // Workout summary (stats panel on today's card)
      try {
        const raw = await AsyncStorage.getItem(SUMMARIES_KEY);
        const summaries: StoredWorkoutSummary[] = raw ? JSON.parse(raw) : [];
        const kept = summaries.filter(s => !s.date.startsWith(date));
        if (kept.length !== summaries.length) {
          await AsyncStorage.setItem(SUMMARIES_KEY, JSON.stringify(kept));
        }
      } catch {}
      // Preserved completed-workout snapshot (HomeScreen schedule overlay)
      try {
        const raw = await AsyncStorage.getItem(PRESERVED_WORKOUTS_KEY);
        const all = raw ? JSON.parse(raw) : {};
        if (date in all) {
          delete all[date];
          await AsyncStorage.setItem(PRESERVED_WORKOUTS_KEY, JSON.stringify(all));
        }
      } catch {}
    }
  }
}

export async function loadWorkoutHistory(): Promise<WorkoutSession[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.map(sanitizeWorkoutHistorySession).filter(session => !session.skipped)
      : [];
  } catch {
    return [];
  }
}

export async function getLastSetsForExercise(exercise: ExerciseHistoryMatchInput): Promise<CompletedSet[] | null> {
  const history = await loadWorkoutHistory();
  for (const session of history) {
    const ex = session.exercises.find(e => exerciseHistoryEntriesMatch(e, exercise));
    if (ex && ex.sets.length > 0) {
      return ex.sets.map(set => ({ ...set, sessionDate: session.date }));
    }
  }
  return null;
}

/** Returns true if a completed session exists for today. */
export async function isTodayWorkoutDone(): Promise<boolean> {
  const today = todayKey();
  const history = await loadWorkoutHistory();
  return history.some(s => s.date.startsWith(today) && workoutSessionCountsForPlan(s));
}

// ── Preserved completed workouts ──────────────────────────────────────────────
// When the user finishes a workout, snapshot the exact WorkoutDay they
// completed. Next time the plan regenerates, HomeScreen overlays this on the
// schedule for that date so the completed day never gets replaced with a
// different workout from the new plan.

type PreservedWorkoutMap = Record<string, WorkoutDay>;

export async function savePreservedCompletedWorkout(date: string, workout: WorkoutDay): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PRESERVED_WORKOUTS_KEY);
    const all: PreservedWorkoutMap = raw ? JSON.parse(raw) : {};
    all[date] = workout;
    // Keep 30 days to bound storage.
    const keys = Object.keys(all).sort().reverse().slice(0, 30);
    const pruned: PreservedWorkoutMap = {};
    keys.forEach(k => { pruned[k] = all[k]; });
    await AsyncStorage.setItem(PRESERVED_WORKOUTS_KEY, JSON.stringify(pruned));
  } catch {}
}

export async function loadPreservedCompletedWorkouts(): Promise<PreservedWorkoutMap> {
  try {
    const raw = await AsyncStorage.getItem(PRESERVED_WORKOUTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ── Manual workout overrides ─────────────────────────────────────────────────
// Local/free schedules do not have PlanDay rows to patch. Store a dated
// workout shell so a user can turn a rendered rest day into a custom workout.

type ManualWorkoutOverrideMap = Record<string, WorkoutDay>;

export async function saveManualWorkoutOverride(date: string, workout: WorkoutDay): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(MANUAL_WORKOUT_OVERRIDES_KEY);
    const all: ManualWorkoutOverrideMap = raw ? JSON.parse(raw) : {};
    all[date] = workout;
    const keys = Object.keys(all).sort().reverse().slice(0, 30);
    const pruned: ManualWorkoutOverrideMap = {};
    keys.forEach(k => { pruned[k] = all[k]; });
    await AsyncStorage.setItem(MANUAL_WORKOUT_OVERRIDES_KEY, JSON.stringify(pruned));
  } catch {}
}

export async function loadManualWorkoutOverrides(): Promise<ManualWorkoutOverrideMap> {
  try {
    const raw = await AsyncStorage.getItem(MANUAL_WORKOUT_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ── Workout templates ────────────────────────────────────────────────────────
//
// The backend table `workout_templates` is now the source of truth (see
// backend/app/routers/workout_templates.py). AsyncStorage is a hot cache
// so the home screen renders instantly + works offline. Writes are
// server-first; the local cache is updated from the server response so
// the new shareCode/timesImported fields stay accurate. Reads return
// the cache; callers should call `syncWorkoutTemplatesFromBackend(token)`
// at sign-in / app foreground to refresh.

async function _readToken(): Promise<string | null> {
  try {
    const { loadAuthToken } = await import('./authTokenStorage');
    return await loadAuthToken();
  }
  catch { return null; }
}

function _toLocal(r: import('../services/api').WorkoutTemplateRecord): SavedWorkoutTemplate {
  return {
    id: r.id,
    name: r.name,
    workout: r.workout,
    notes: r.notes ?? null,
    shareCode: r.shareCode,
    timesImported: r.timesImported,
    sourceShareCode: r.sourceShareCode,
    sourceOwnerUsername: r.sourceOwnerUsername,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function _isNotFoundTemplateError(err: unknown): boolean {
  const message = String(err instanceof Error ? err.message : (err as any)?.message ?? err).toLowerCase();
  return message.includes('http 404') || message.includes('not found');
}

async function _loadPendingTemplateDeleteIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(WORKOUT_TEMPLATE_DELETED_IDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string' && id.trim()) : []);
  } catch {
    return new Set();
  }
}

async function _savePendingTemplateDeleteIds(ids: Set<string>): Promise<void> {
  try {
    const arr = Array.from(ids);
    if (arr.length === 0) await AsyncStorage.removeItem(WORKOUT_TEMPLATE_DELETED_IDS_KEY);
    else await AsyncStorage.setItem(WORKOUT_TEMPLATE_DELETED_IDS_KEY, JSON.stringify(arr));
  } catch {}
}

async function _markTemplateDeletePending(templateId: string): Promise<void> {
  if (!templateId) return;
  const ids = await _loadPendingTemplateDeleteIds();
  ids.add(templateId);
  await _savePendingTemplateDeleteIds(ids);
}

async function _clearTemplateDeletePending(templateId: string): Promise<void> {
  if (!templateId) return;
  const ids = await _loadPendingTemplateDeleteIds();
  if (!ids.delete(templateId)) return;
  await _savePendingTemplateDeleteIds(ids);
}

export async function loadWorkoutTemplates(): Promise<SavedWorkoutTemplate[]> {
  return loadWorkoutTemplatesFromStorage(AsyncStorage);
}

export async function saveWorkoutTemplates(templates: SavedWorkoutTemplate[]): Promise<void> {
  try {
    await saveWorkoutTemplatesToStorage(AsyncStorage, templates);
  } catch {}
}

/** Push the saved-templates list to the watch so the Strength picker
 *  on the wrist stays in sync with the phone. Best-effort — bridge
 *  unavailability or watch unreachable both no-op. Fires after every
 *  upsert / delete / sync so the watch sees changes immediately. */
async function _pushTemplatesToWatchBestEffort(templates: SavedWorkoutTemplate[]): Promise<void> {
  try {
    const { pushTemplatesToWatch } = await import('./watchSync');
    await pushTemplatesToWatch(templates, { force: false });
  } catch { /* watch sync optional */ }
}

/** Pull authoritative templates from the backend, replace local cache.
 *  Also performs a one-time migration: any local-only template (id not
 *  on the server) is pushed back up. Safe to call repeatedly — POSTs
 *  are idempotent on (user, client_id), so re-syncing is a no-op once
 *  caches agree. Best-effort; failure leaves the local cache untouched. */
export async function syncWorkoutTemplatesFromBackend(tokenArg?: string | null): Promise<SavedWorkoutTemplate[]> {
  const token = tokenArg ?? await _readToken();
  if (!token) return loadWorkoutTemplates();
  try {
    const api = await import('../services/api');
    const remote = await api.listWorkoutTemplates(token);
    const pendingDeletes = await _loadPendingTemplateDeleteIds();
    if (pendingDeletes.size > 0) {
      const remaining = new Set(pendingDeletes);
      const remoteIdsBeforeDelete = new Set(remote.map(r => r.id));
      for (const id of pendingDeletes) {
        if (!remoteIdsBeforeDelete.has(id)) {
          remaining.delete(id);
          continue;
        }
        try {
          await api.deleteWorkoutTemplate(token, id);
          remaining.delete(id);
        } catch (err) {
          if (_isNotFoundTemplateError(err)) remaining.delete(id);
          else console.warn('[workoutTemplates] pending delete sync failed', id, err);
        }
      }
      await _savePendingTemplateDeleteIds(remaining);
    }
    const remoteAfterDeletes = pendingDeletes.size > 0
      ? remote.filter(r => !pendingDeletes.has(r.id))
      : remote;
    const remoteIds = new Set(remoteAfterDeletes.map(r => r.id));
    const local = await loadWorkoutTemplatesFromStorage(AsyncStorage);
    const localOnly = local.filter(t => t.id && !remoteIds.has(t.id) && !pendingDeletes.has(t.id));
    if (localOnly.length > 0) {
      // Push local-only rows. Cap-rejected pushes are swallowed — that
      // user must already be over-cap by some other means (manual DB
      // edit, beta tier downgrade), and we'd rather sync the rest than
      // abort the migration entirely.
      for (const t of localOnly) {
        try {
          const created = await api.upsertWorkoutTemplate(token, {
            id: t.id, name: t.name, workout: t.workout, notes: t.notes ?? null,
          });
          remoteAfterDeletes.push(created);
        } catch {}
      }
    }
    const merged = remoteAfterDeletes.map(_toLocal);
    await saveWorkoutTemplatesToStorage(AsyncStorage, merged);
    void _pushTemplatesToWatchBestEffort(merged);
    return merged;
  } catch {
    return loadWorkoutTemplates();
  }
}

export async function deleteWorkoutTemplate(templateId: string): Promise<void> {
  await _markTemplateDeletePending(templateId);
  // Snapshot the pre-delete cache so we can roll back if the backend
  // rejects the delete. Without rollback the row reappears on the next
  // syncWorkoutTemplatesFromBackend (remote still has it, local doesn't,
  // sync merges remote back in) — which is the "ghost template" bug.
  const before = await loadWorkoutTemplatesFromStorage(AsyncStorage);
  const next = await deleteWorkoutTemplateFromStorage(AsyncStorage, templateId);
  void _pushTemplatesToWatchBestEffort(next);

  const token = await _readToken();
  if (!token) return;

  try {
    const { deleteWorkoutTemplate: apiDelete } = await import('../services/api');
    await apiDelete(token, templateId);
    // A background sync can briefly rehydrate the remote row while the
    // DELETE is in flight. Re-apply the local delete after the server
    // confirms so the cache and UI settle on the user's intent.
    const confirmedNext = await deleteWorkoutTemplateFromStorage(AsyncStorage, templateId);
    void _pushTemplatesToWatchBestEffort(confirmedNext);
    await _clearTemplateDeletePending(templateId);
  } catch (err) {
    // 404 means the row was never on the server (created offline, or
    // already deleted from another device). Delete is idempotent: local
    // is already cleared, end state matches the user's intent, return
    // success. Without this branch, the catch below rolls back the
    // local delete and the template visibly reappears.
    if (_isNotFoundTemplateError(err)) {
      const confirmedNext = await deleteWorkoutTemplateFromStorage(AsyncStorage, templateId);
      void _pushTemplatesToWatchBestEffort(confirmedNext);
      await _clearTemplateDeletePending(templateId);
      return;
    }
    console.warn('[workoutTemplates] backend delete failed, restoring local cache', err);
    await _clearTemplateDeletePending(templateId);
    await saveWorkoutTemplatesToStorage(AsyncStorage, before);
    void _pushTemplatesToWatchBestEffort(before);
    throw err;
  }
}

/**
 * Insert or update a saved template. Server-first: the backend is the
 * source of truth for cap enforcement and authoritative timestamps.
 * Local cache is updated from the server response so shareCode and
 * other server-managed fields stay accurate.
 *
 * On HTTP error (cap rejection, validation), re-throws so the caller
 * can surface a typed alert. On network error (offline / backend
 * unreachable), falls back to local-only persistence — the next sync
 * call will reconcile.
 */
export async function upsertWorkoutTemplate(template: SavedWorkoutTemplate): Promise<SavedWorkoutTemplate[]> {
  const token = await _readToken();
  if (token) {
    try {
      const api = await import('../services/api');
      const saved = await api.upsertWorkoutTemplate(token, {
        id: template.id,
        name: template.name,
        workout: template.workout,
        notes: template.notes ?? null,
      });
      // Merge into local cache, preserving order of unrelated rows.
      const existing = await loadWorkoutTemplatesFromStorage(AsyncStorage);
      const next = existing.some(t => t.id === saved.id)
        ? existing.map(t => t.id === saved.id ? _toLocal(saved) : t)
        : [_toLocal(saved), ...existing];
      await saveWorkoutTemplatesToStorage(AsyncStorage, next);
      void _pushTemplatesToWatchBestEffort(next);
      return next;
    } catch (e: any) {
      // Only fall through to local-only persistence on TRUE network
      // failures (offline, DNS, abort). Anything that reached the
      // backend and got a response must be surfaced — silently
      // degrading to local-only is what caused "Template not found"
      // when assigning a template the server never received.
      const msg = String(e?.message ?? '').toLowerCase();
      const isOffline = msg.includes('network request failed')
        || msg.includes('aborted')
        || msg.includes('timeout')
        || e?.name === 'AbortError';
      if (!isOffline) throw e;
    }
  }

  // Offline path — persist locally with the same client-side cap check
  // we had before the server became authoritative.
  try {
    const { canCreateWorkoutTemplate, FREE_WORKOUT_TEMPLATE_LIMIT } = await import('./subscription');
    return upsertWorkoutTemplateInStorage(template, {
      storage: AsyncStorage,
      loadProfile: async () => {
        const raw = await AsyncStorage.getItem('userProfile');
        return raw ? JSON.parse(raw) : null;
      },
      canCreateWorkoutTemplate,
      freeWorkoutTemplateLimit: FREE_WORKOUT_TEMPLATE_LIMIT,
    });
  } catch (e: any) {
    if (typeof e?.message === 'string' && e.message.includes('templates')) throw e;
    return upsertWorkoutTemplateInStorage(template, { storage: AsyncStorage });
  }
}

// ── Skipped days ──────────────────────────────────────────────────────────────

export interface SkippedDay {
  date: string;    // YYYY-MM-DD
  focus: string;   // workout focus that was skipped
  reason?: string; // user-selected or typed reason
}

export async function getSkippedDays(): Promise<SkippedDay[]> {
  try {
    const raw = await AsyncStorage.getItem(SKIPPED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const days: SkippedDay[] = Array.isArray(parsed) ? parsed : [];
    const legacyRaw = await AsyncStorage.getItem(HISTORY_KEY);
    const legacy = legacyRaw ? JSON.parse(legacyRaw) : [];
    let changed = false;
    let prunedLegacy: unknown[] | null = null;
    if (Array.isArray(legacy)) {
      prunedLegacy = [];
      for (const row of legacy) {
        const session = sanitizeWorkoutHistorySession(row);
        if (!session.skipped) {
          prunedLegacy.push(row);
          continue;
        }
        changed = true;
        if (!session.date) continue;
        const date = session.date.slice(0, 10);
        if (!date || days.some(d => d.date === date)) continue;
        days.push({
          date,
          focus: session.focus || 'Workout',
          ...(session.skipReason ? { reason: session.skipReason } : {}),
        });
      }
    }
    if (changed) {
      await AsyncStorage.setItem(SKIPPED_KEY, JSON.stringify(days.slice(0, 365)));
      if (prunedLegacy) {
        await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(prunedLegacy.slice(0, 100)));
      }
    }
    return days;
  } catch {
    return [];
  }
}

export async function addSkippedDay(date: string, focus: string, reason?: string): Promise<void> {
  const days = await getSkippedDays();
  const idx = days.findIndex(d => d.date === date);
  const entry: SkippedDay = { date, focus, ...(reason ? { reason } : {}) };
  if (idx >= 0) {
    days[idx] = entry;
  } else {
    days.unshift(entry);
  }
  await AsyncStorage.setItem(SKIPPED_KEY, JSON.stringify(days.slice(0, 365)));
}

/** @deprecated Use addSkippedDay. Skips are plan state, not activity history. */
export async function saveSkipToHistory(date: string, focus: string, reason?: string): Promise<void> {
  await addSkippedDay(date, focus, reason);
}

export async function removeSkippedDay(date: string): Promise<void> {
  const days = await getSkippedDays();
  const nextDays = days.filter(day => day.date !== date);
  await AsyncStorage.setItem(SKIPPED_KEY, JSON.stringify(nextDays));
}

// ── Workout summaries ─────────────────────────────────────────────────────────

export async function saveWorkoutSummary(summary: StoredWorkoutSummary): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(SUMMARIES_KEY);
    const existing: StoredWorkoutSummary[] = raw ? JSON.parse(raw) : [];
    // Upsert by id so writing the same summary twice (e.g. initial
    // save followed by feedback patch) doesn't create a duplicate row.
    const idx = summary.id ? existing.findIndex(s => s.id === summary.id) : -1;
    if (idx >= 0) {
      existing[idx] = { ...existing[idx], ...summary };
    } else {
      existing.unshift(summary);
    }
    await AsyncStorage.setItem(SUMMARIES_KEY, JSON.stringify(existing.slice(0, 100)));
  } catch {}
}

/** Patch fields onto an existing workout summary by id. No-op if the
 *  summary doesn't exist yet. Used by handleSubmitFeedback to stamp
 *  feedback onto a summary that was saved earlier in handleFinish. */
export async function updateWorkoutSummary(
  id: string,
  patch: Partial<StoredWorkoutSummary>,
): Promise<void> {
  if (!id) return;
  try {
    const raw = await AsyncStorage.getItem(SUMMARIES_KEY);
    const existing: StoredWorkoutSummary[] = raw ? JSON.parse(raw) : [];
    const idx = existing.findIndex(s => s.id === id);
    if (idx < 0) return;
    existing[idx] = { ...existing[idx], ...patch };
    await AsyncStorage.setItem(SUMMARIES_KEY, JSON.stringify(existing.slice(0, 100)));
  } catch {}
}

export async function loadWorkoutSummaries(): Promise<StoredWorkoutSummary[]> {
  try {
    const raw = await AsyncStorage.getItem(SUMMARIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Delete a workout summary by id. Used by the Progress screen so users
 *  can remove an AI-generated summary they don't want to keep. */
export async function deleteWorkoutSummary(summaryId: string): Promise<void> {
  if (!summaryId) return;
  try {
    const raw = await AsyncStorage.getItem(SUMMARIES_KEY);
    const existing: StoredWorkoutSummary[] = raw ? JSON.parse(raw) : [];
    const next = existing.filter(s => s.id !== summaryId);
    if (next.length !== existing.length) {
      await AsyncStorage.setItem(SUMMARIES_KEY, JSON.stringify(next));
    }
  } catch {}
}

// ── Goal history ──────────────────────────────────────────────────────────────

export async function loadGoalHistory(): Promise<GoalHistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(GOAL_HIST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Call when the user switches goals. Closes the current open entry and opens a new one.
 */
export async function recordGoalChange(
  newGoal: import('../types').Goal,
  newPace: import('../types').GoalPace,
  startWeightLbs?: number,
): Promise<void> {
  try {
    const history = await loadGoalHistory();
    const now = new Date().toISOString();
    const nowDate = now.slice(0, 10); // YYYY-MM-DD
    // Close the currently open entry (no endedAt), dropping any that started AND ended today
    const updated = history
      .map(e => (!e.endedAt ? { ...e, endedAt: now } : e))
      .filter(e => !e.endedAt || e.startedAt.slice(0, 10) !== e.endedAt.slice(0, 10));
    const newEntry: GoalHistoryEntry = {
      id: Date.now().toString(),
      goal: newGoal,
      pace: newPace,
      startedAt: now,
      startWeightLbs,
    };
    updated.unshift(newEntry);
    await AsyncStorage.setItem(GOAL_HIST_KEY, JSON.stringify(updated.slice(0, 50)));
  } catch {}
}

// ── Meal routines ─────────────────────────────────────────────────────────────

export async function loadMealRoutines(): Promise<MealRoutineEntry[]> {
  return mealRoutineMemory.map(r => ({ ...r }));
}

export async function saveMealRoutines(routines: MealRoutineEntry[]): Promise<void> {
  mealRoutineMemory = routines.map(r => ({ ...r }));
}

// ── Routine application (derive-don't-persist) ──────────────────────────────
// The pure routine→plan merge logic moved to ./mealRoutineApply (no
// AsyncStorage dep, unit-tested). Re-exported here so existing importers are
// unaffected, while the logic itself is now testable in isolation.
export {
  mealFromRoutine,
  applyRoutines,
  applyRoutinesToAll,
  applyRoutinesWithShift,
  applyRoutinesToAllWithChecks,
} from './mealRoutineApply';

// ── Plan change history ───────────────────────────────────────────────────────

export async function savePlanChange(entry: PlanChangeEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PLAN_CHANGES_KEY);
    const existing: PlanChangeEntry[] = raw ? JSON.parse(raw) : [];
    existing.unshift(entry);
    await AsyncStorage.setItem(PLAN_CHANGES_KEY, JSON.stringify(existing.slice(0, 200)));
  } catch {}
}

export async function loadPlanChanges(): Promise<PlanChangeEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(PLAN_CHANGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Delete a plan change history entry by id. Used by the Progress screen
 *  so users can remove a plan-change record they don't want to keep. */
export async function deletePlanChange(changeId: string): Promise<void> {
  if (!changeId) return;
  try {
    const raw = await AsyncStorage.getItem(PLAN_CHANGES_KEY);
    const existing: PlanChangeEntry[] = raw ? JSON.parse(raw) : [];
    const next = existing.filter(c => c.id !== changeId);
    if (next.length !== existing.length) {
      await AsyncStorage.setItem(PLAN_CHANGES_KEY, JSON.stringify(next));
    }
  } catch {}
}

// ── Personal Records ──────────────────────────────────────────────────────────

export interface PR {
  exerciseName: string;
  weightLbs: number;
  reps: number;
  date: string;
  sessionFocus: string;
}

export interface ExerciseSessionBest {
  weightLbs: number;
  reps: number;
  date: string;
}

export interface ExerciseBests {
  allTime: ExerciseSessionBest | null;
  lastSession: ExerciseSessionBest | null;
  sessions: ExerciseSessionBest[];
}

/** Best set per session (by weight × reps) for a given exercise, plus
 *  the all-time best and the most-recent session best. Derived from
 *  workout history — no separate storage needed. */
export async function getExerciseBests(exercise: ExerciseHistoryMatchInput): Promise<ExerciseBests> {
  const history = await loadWorkoutHistory();
  const sessions: ExerciseSessionBest[] = [];
  for (const session of history) {
    for (const ex of session.exercises) {
      if (!exerciseHistoryEntriesMatch(ex, exercise)) continue;
      let top: ExerciseSessionBest | null = null;
      for (const set of ex.sets) {
        if (!set || !set.weightLbs) continue;
        const score = set.weightLbs * (set.reps || 0);
        const topScore = top ? top.weightLbs * top.reps : -1;
        if (!top || score > topScore) {
          top = { weightLbs: set.weightLbs, reps: set.reps, date: session.date };
        }
      }
      if (top) sessions.push(top);
    }
  }
  sessions.sort((a, b) => +new Date(a.date) - +new Date(b.date));
  const allTime = sessions.reduce<ExerciseSessionBest | null>((best, s) => {
    if (!best) return s;
    return s.weightLbs * s.reps > best.weightLbs * best.reps ? s : best;
  }, null);
  const lastSession = sessions.length ? sessions[sessions.length - 1] : null;
  return { allTime, lastSession, sessions };
}

/** Returns the best set (heaviest weight, tie-break by reps) per exercise across all history. */
export function derivePersonalRecords(history: WorkoutSession[]): PR[] {
  const prMap = new Map<string, PR>();

  for (const session of history.filter(s => s.completed && !s.skipped)) {
    for (const ex of session.exercises) {
      if (!isTrackableStrengthExercise(ex)) continue;
      for (const set of loadedStrengthSets(ex)) {
        const key = ex.name.toLowerCase();
        const existing = prMap.get(key);
        if (
          !existing ||
          set.weightLbs > existing.weightLbs ||
          (set.weightLbs === existing.weightLbs && set.reps > existing.reps)
        ) {
          prMap.set(key, {
            exerciseName: ex.name,
            weightLbs: set.weightLbs,
            reps: set.reps,
            date: session.date,
            sessionFocus: session.focus,
          });
        }
      }
    }
  }

  return Array.from(prMap.values()).sort((a, b) =>
    a.exerciseName.localeCompare(b.exerciseName)
  );
}

/** Returns the best set (heaviest weight, tie-break by reps) per exercise across all history. */
export async function getPersonalRecords(): Promise<PR[]> {
  return derivePersonalRecords(await loadWorkoutHistory());
}

// ── Apple Health data persistence ────────────────────────────────────────────

const HEALTH_SUMMARY_KEY = STORAGE_KEYS.health.summary;
const HEALTH_SCORE_KEY = STORAGE_KEYS.health.score;
const APPLE_HEALTH_ENABLED_KEY = STORAGE_KEYS.health.appleHealthEnabled;

export async function saveHealthSummary(summary: import('../types').HealthSummary): Promise<void> {
  await AsyncStorage.setItem(HEALTH_SUMMARY_KEY, JSON.stringify(summary));
}

export async function loadHealthSummary(): Promise<import('../types').HealthSummary | null> {
  try {
    const raw = await AsyncStorage.getItem(HEALTH_SUMMARY_KEY);
    if (!raw) return null;
    const parsed: import('../types').HealthSummary = JSON.parse(raw);
    const fetchedAt = parsed?.fetchedAt ? new Date(parsed.fetchedAt) : null;
    if (!fetchedAt || Number.isNaN(fetchedAt.getTime()) || dateKey(fetchedAt) !== todayKey()) {
      return null;
    }
    return parsed;
  } catch { return null; }
}

export async function saveHealthScore(result: import('../types').HealthScoreResult): Promise<void> {
  await AsyncStorage.setItem(HEALTH_SCORE_KEY, JSON.stringify(result));
}

export async function loadHealthScore(): Promise<import('../types').HealthScoreResult | null> {
  try {
    const raw = await AsyncStorage.getItem(HEALTH_SCORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export async function isAppleHealthEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(APPLE_HEALTH_ENABLED_KEY);
    return raw === 'true';
  } catch { return false; }
}

export async function setAppleHealthEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(APPLE_HEALTH_ENABLED_KEY, enabled ? 'true' : 'false');
}
