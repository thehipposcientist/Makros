import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, CompletedSet, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, MealRoutineEntry, DailyNutritionPlan, MealSuggestion, WorkoutDay } from '../types';
import { migrateNutritionPlanShape } from './mealItems';

const HISTORY_KEY        = 'workoutHistory';
const SKIPPED_KEY        = 'skippedWorkouts';
const SUMMARIES_KEY      = 'workoutSummaries';
const GOAL_HIST_KEY      = 'goalHistory';
const PLAN_CHANGES_KEY   = 'planChangeHistory';
const MEAL_ROUTINES_KEY  = 'mealRoutines';
const PRESERVED_WORKOUTS_KEY = 'preservedCompletedWorkouts';

// ── Date helpers ──────────────────────────────────────────────────────────────

/** Returns a Date as YYYY-MM-DD in local time. */
export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function todayKey(): string {
  return dateKey(new Date());
}

// ── Workout sessions ──────────────────────────────────────────────────────────

export async function saveWorkoutSession(session: WorkoutSession): Promise<void> {
  const history = await loadWorkoutHistory();
  const idx = history.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    history[idx] = session;
  } else {
    history.unshift(session);
  }
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100)));

  // Mirror to Apple Health for any session that wasn't already
  // sourced FROM Apple Health (no infinite-loop on import) and that
  // has real start/end timestamps. Best-effort + opt-in via the
  // user's existing isAppleHealthEnabled flag.
  try {
    const fromHK = session.id?.startsWith('hk_');
    if (fromHK) return;
    if (!session.startedAt || !session.endedAt) return;
    const enabled = await isAppleHealthEnabled().catch(() => false);
    if (!enabled) return;
    const { saveWorkoutToHealth, isHealthKitAvailable } = await import('../services/appleHealth');
    if (!isHealthKitAvailable()) return;
    const tag = session.manualActivity?.subtype
      || session.focus
      || 'Workout';
    await saveWorkoutToHealth({
      startedAt: new Date(session.startedAt),
      endedAt: new Date(session.endedAt),
      activityTag: tag,
      caloriesBurned: session.manualActivity?.caloriesBurned ?? null,
      distanceMiles: session.manualActivity?.distanceMiles ?? null,
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
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function getLastSetsForExercise(exerciseName: string): Promise<CompletedSet[] | null> {
  const history = await loadWorkoutHistory();
  for (const session of history) {
    const ex = session.exercises.find(
      e => e.name.toLowerCase() === exerciseName.toLowerCase()
    );
    if (ex && ex.sets.length > 0) {
      return ex.sets;
    }
  }
  return null;
}

/** Returns true if a completed session exists for today. */
export async function isTodayWorkoutDone(): Promise<boolean> {
  const today = todayKey();
  const history = await loadWorkoutHistory();
  return history.some(s => s.date.startsWith(today) && s.completed);
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

// ── Skipped days ──────────────────────────────────────────────────────────────

export interface SkippedDay {
  date: string;    // YYYY-MM-DD
  focus: string;   // workout focus that was skipped
  reason?: string; // user-selected or typed reason
}

export async function getSkippedDays(): Promise<SkippedDay[]> {
  try {
    const raw = await AsyncStorage.getItem(SKIPPED_KEY);
    return raw ? JSON.parse(raw) : [];
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

/**
 * Saves a skipped day as a WorkoutSession entry in the main history so it
 * appears in the unified timeline visible to the AI trainer.
 */
export async function saveSkipToHistory(date: string, focus: string, reason?: string): Promise<void> {
  const history = await loadWorkoutHistory();
  // Don't duplicate — upsert by id
  const id = `skip_${date}`;
  const entry: import('../types').WorkoutSession = {
    id,
    date,
    focus,
    durationSeconds: 0,
    exercises: [],
    completed: false,
    skipped: true,
    ...(reason ? { skipReason: reason } : {}),
  };
  const idx = history.findIndex(s => s.id === id);
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.unshift(entry);
  }
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
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
  try {
    const raw = await AsyncStorage.getItem(MEAL_ROUTINES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveMealRoutines(routines: MealRoutineEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(MEAL_ROUTINES_KEY, JSON.stringify(routines));
  } catch {}
}

// ── Routine application (derive-don't-persist) ──────────────────────────────
//
// Routines are the source of truth for "this meal repeats every day". We
// never stamp `isRoutine: true` into the per-day nutrition plans — instead,
// every code path that writes a DailyNutritionPlan into state should pass it
// through `applyRoutines()` first. That way:
//   - AI plan regeneration can't wipe out routines
//   - Toggling a routine is O(days) of in-memory work, no storage races
//   - Future days generated on-the-fly get routines for free

/** Build a MealSuggestion from a MealRoutineEntry. Prefers the structured
 *  `items[]` snapshot when available (new routines) and falls back to the
 *  legacy foods[]/amounts[] shape for routines saved before items existed. */
function mealFromRoutine(routine: MealRoutineEntry, fallback?: MealSuggestion): MealSuggestion {
  const hasItems = routine.items && routine.items.length > 0;
  const foods = hasItems ? routine.items!.map(i => i.name) : routine.foods.map(f => f.name);
  const amounts = hasItems
    ? routine.items!.map(i => (i.unit === 'piece' ? String(i.quantity) : `${i.quantity} ${i.unit}`))
    : routine.foods.map(f => f.quantity ?? '');
  // If we have structured items, recompute totals from them so routine and
  // plan stay in sync. Otherwise trust the snapshot or fall through.
  const totals = hasItems
    ? routine.items!.reduce(
        (acc, it) => ({
          calories: acc.calories + (it.calories ?? 0),
          protein:  acc.protein  + (it.protein  ?? 0),
          carbs:    acc.carbs    + (it.carbs    ?? 0),
          fat:      acc.fat      + (it.fat      ?? 0),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
      )
    : {
        calories: routine.calories ?? fallback?.calories ?? 0,
        protein:  routine.protein  ?? fallback?.protein  ?? 0,
        carbs:    routine.carbs    ?? fallback?.carbs    ?? 0,
        fat:      routine.fat      ?? fallback?.fat      ?? 0,
      };
  const micros: Record<string, number> = {};
  if (hasItems) {
    for (const it of routine.items!) {
      for (const [k, v] of Object.entries(it.micronutrients ?? {})) {
        if (typeof v === 'number') micros[k] = (micros[k] ?? 0) + v;
      }
    }
  }
  return {
    meal:     routine.name,
    items:    hasItems ? routine.items : undefined,
    foods,
    amounts,
    calories: totals.calories,
    protein:  totals.protein,
    carbs:    totals.carbs,
    fat:      totals.fat,
    isRoutine: true,
    estimated_alignment: fallback?.estimated_alignment ?? '',
    ...(Object.keys(micros).length > 0 ? { micronutrients: micros } : {}),
  } as MealSuggestion;
}

/** Apply routines to a plan.
 *
 *  All routines are now equal — there are no breakfast/lunch/dinner slots
 *  anymore. Every routine becomes one entry in `plan.meals[]`, tagged with
 *  `_routineId`. Existing routine-backed entries are replaced (so content
 *  edits to the routine propagate); stale routine ids get demoted to
 *  one-off entries so unpinning a routine doesn't make the meal vanish.
 *
 *  Pure function — returns a new plan object, doesn't mutate input. */
export function applyRoutines(
  plan: DailyNutritionPlan,
  routines: MealRoutineEntry[],
): DailyNutritionPlan {
  const incoming = migrateNutritionPlanShape(plan) as DailyNutritionPlan;
  const existingMeals = (incoming.meals ?? []).slice();

  const activeRoutines = routines.filter(r => r && r.id);
  const routinesById = new Map(activeRoutines.map(r => [r.id, r]));
  const activeRoutineSignatures = new Map(
    activeRoutines.map(r => [`${r.name}__${Math.round(r.calories ?? 0)}`, r]),
  );

  // Walk current meals and UPDATE IN PLACE so array index positions are
  // preserved. Drop-and-reappend (the old behavior) shifted indices,
  // which broke check-state keyed by `meal_<idx>` — a user who checked
  // Meal 3 on Thursday saw Meal 5 appear pre-checked after a routine
  // edit.
  //
  // Rules (now in-place):
  //   (1) routine-backed meal whose routine is still active → refresh
  //       macros/foods from the latest routine snapshot, keep position.
  //   (2) routine-backed meal whose routine was removed → demote to
  //       one-off (strip _routineId), keep position.
  //   (3) untagged meal matching an active routine by name+cals →
  //       upgrade in-place (add _routineId), keep position. Marks the
  //       routine as "placed" so we don't re-append it later.
  //   (4) any other meal → keep as-is.
  const placedRoutineIds = new Set<string>();
  const inplace: MealSuggestion[] = [];
  for (const m of existingMeals) {
    if (!m || typeof m !== 'object') continue;
    const rid = (m as any)._routineId as string | undefined;
    const sig = `${m.meal}__${Math.round(m.calories ?? 0)}`;

    if (rid && routinesById.has(rid)) {
      // case (1): refresh macros + foods from the live routine snapshot.
      const routine = routinesById.get(rid)!;
      const refreshed = mealFromRoutine(routine);
      inplace.push({ ...refreshed, _routineId: rid } as MealSuggestion);
      placedRoutineIds.add(rid);
      continue;
    }
    if (rid) {
      // case (2): routine was removed; demote.
      const { _routineId: _drop, ...rest } = m as any;
      inplace.push({ ...rest, isRoutine: false } as MealSuggestion);
      continue;
    }

    const matchingRoutine = activeRoutineSignatures.get(sig);
    if (matchingRoutine && !placedRoutineIds.has(matchingRoutine.id)) {
      // case (3): upgrade the untagged meal to a routine-backed one
      // without moving its position.
      const refreshed = mealFromRoutine(matchingRoutine);
      inplace.push({ ...refreshed, _routineId: matchingRoutine.id } as MealSuggestion);
      placedRoutineIds.add(matchingRoutine.id);
      continue;
    }

    inplace.push({ ...m, isRoutine: false });
  }

  // Append any routines that weren't already in the plan (newly pinned).
  const appended: MealSuggestion[] = activeRoutines
    .filter(r => !placedRoutineIds.has(r.id))
    .map(r => ({ ...mealFromRoutine(r), _routineId: r.id }) as MealSuggestion);

  return {
    ...incoming,
    meals: [...inplace, ...appended],
  };
}

/** Apply routines to a whole map of plans. Returns a new map. */
export function applyRoutinesToAll(
  plansByDate: Record<string, DailyNutritionPlan>,
  routines: MealRoutineEntry[],
): Record<string, DailyNutritionPlan> {
  const out: Record<string, DailyNutritionPlan> = {};
  for (const [k, p] of Object.entries(plansByDate)) {
    out[k] = applyRoutines(p, routines);
  }
  return out;
}

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
export async function getExerciseBests(exerciseName: string): Promise<ExerciseBests> {
  const history = await loadWorkoutHistory();
  const key = exerciseName.trim().toLowerCase();
  const sessions: ExerciseSessionBest[] = [];
  for (const session of history) {
    for (const ex of session.exercises) {
      if (ex.name.trim().toLowerCase() !== key) continue;
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
export async function getPersonalRecords(): Promise<PR[]> {
  const history = await loadWorkoutHistory();
  const prMap = new Map<string, PR>();

  for (const session of history) {
    for (const ex of session.exercises) {
      for (const set of ex.sets) {
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

// ── Apple Health data persistence ────────────────────────────────────────────

const HEALTH_SUMMARY_KEY = 'healthSummary';
const HEALTH_SCORE_KEY = 'healthScoreResult';
const APPLE_HEALTH_ENABLED_KEY = 'appleHealthEnabled';

export async function saveHealthSummary(summary: import('../types').HealthSummary): Promise<void> {
  await AsyncStorage.setItem(HEALTH_SUMMARY_KEY, JSON.stringify(summary));
}

export async function loadHealthSummary(): Promise<import('../types').HealthSummary | null> {
  try {
    const raw = await AsyncStorage.getItem(HEALTH_SUMMARY_KEY);
    return raw ? JSON.parse(raw) : null;
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
