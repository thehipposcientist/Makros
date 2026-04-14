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
    existing.unshift(summary);
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
  const activeRoutineIds = new Set(activeRoutines.map(r => r.id));
  const activeRoutineSignatures = new Set(
    activeRoutines.map(r => `${r.name}__${Math.round(r.calories ?? 0)}`),
  );

  // Walk current meals and decide what to keep:
  //   (1) routine-backed (has _routineId) and routine still active → drop;
  //       we'll rebuild fresh below so edits propagate.
  //   (2) routine-backed but routine removed → demote to one-off (strip id).
  //   (3) untagged meal whose name+cals matches an active routine → drop;
  //       the rebuild below will replace it (avoids duplicating the same
  //       meal once a routine is freshly pinned).
  //   (4) any other meal → keep.
  const kept: MealSuggestion[] = [];
  const carriedSignatures = new Set<string>();
  for (const m of existingMeals) {
    if (!m || typeof m !== 'object') continue;
    const rid = (m as any)._routineId as string | undefined;
    const sig = `${m.meal}__${Math.round(m.calories ?? 0)}`;
    if (rid) {
      if (activeRoutineIds.has(rid)) continue; // case (1)
      if (carriedSignatures.has(sig)) continue;
      const { _routineId: _drop, ...rest } = m as any;
      kept.push({ ...rest, isRoutine: false } as MealSuggestion); // case (2)
      carriedSignatures.add(sig);
      continue;
    }
    if (activeRoutineSignatures.has(sig)) continue; // case (3)
    if (carriedSignatures.has(sig)) continue;
    kept.push({ ...m, isRoutine: false });
    carriedSignatures.add(sig);
  }

  const fromRoutines: MealSuggestion[] = activeRoutines.map(r => ({
    ...mealFromRoutine(r),
    _routineId: r.id,
  }) as MealSuggestion);

  return {
    ...incoming,
    meals: [...kept, ...fromRoutines],
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
