import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, CompletedSet, StoredWorkoutSummary, GoalHistoryEntry, PlanChangeEntry, MealRoutineEntry } from '../types';

const HISTORY_KEY        = 'workoutHistory';
const SKIPPED_KEY        = 'skippedWorkouts';
const SUMMARIES_KEY      = 'workoutSummaries';
const GOAL_HIST_KEY      = 'goalHistory';
const PLAN_CHANGES_KEY   = 'planChangeHistory';
const MEAL_ROUTINES_KEY  = 'mealRoutines';

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

// ── Personal Records ──────────────────────────────────────────────────────────

export interface PR {
  exerciseName: string;
  weightLbs: number;
  reps: number;
  date: string;
  sessionFocus: string;
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
