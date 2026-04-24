// Phone-side orchestrator for the Apple Watch companion.
//
// Responsibilities:
//   1. Push today's workout (with correct lifecycle status) + theme +
//      meals to the watch whenever they change.
//   2. Subscribe to commands from the watch (Start / Skip / End / rest
//      controls / toggle meal) and route them into phone actions.
//
// Everything no-ops when the bridge is unavailable (Android, devices
// without a paired watch), so callers can always invoke these.

import {
  WatchBridge,
  WatchWorkoutPayload,
  WatchWorkoutStatus,
  WatchPalette,
  WatchProgress,
  WatchMealsPayload,
} from '../../modules/thallo-watch-bridge';
import { WorkoutDay, AppThemeName, DailyNutritionPlan } from '../types';
import { getTheme } from '../constants/theme';

export type WatchExerciseClient = {
  name: string;
  sets: number;
  reps: string;
  restSeconds: number;
  equipment?: string | null;
  plannedTargetWeightLbs?: number | null;
  recommendation?: string | null;
};

/** Build the compact watch payload from the day AND its current
 *  status. Status drives which UI the watch shows (scheduled = Start
 *  button visible; active = "rejoin"; completed/skipped/rest = status
 *  card, no Start). Feed the actual `schedule[0]` output here — NOT
 *  the raw `workoutPlan.days[0]`, which ignores skips/switches and
 *  was the source of the "watch shows push even though I skipped" bug. */
export function buildWatchWorkoutPayload(
  day: WorkoutDay | null | undefined,
  opts: { dateISO?: string; status: WatchWorkoutStatus },
): WatchWorkoutPayload | null {
  if (!day) {
    // Rest day — still send so watch knows today's status, even
    // though there's no exercise list.
    if (opts.status === 'rest') {
      return {
        focus: 'Rest',
        durationMinutes: 0,
        dateISO: opts.dateISO || new Date().toISOString().slice(0, 10),
        status: 'rest',
        exercises: [],
        syncedAtMs: Date.now(),
      };
    }
    return null;
  }
  const exercises: WatchExerciseClient[] = (day.exercises ?? []).map((e: any) => ({
    name: String(e.name || 'Exercise'),
    sets: Number(e.sets || 3),
    reps: String(e.reps || ''),
    restSeconds: Number(e.restSeconds || e.rest_seconds || 60),
    equipment: e.equipment ?? null,
    plannedTargetWeightLbs: e.plannedTargetWeightLbs ?? e.weight ?? null,
    recommendation: e.recommendation ?? null,
  }));
  return {
    focus: String(day.focus || 'Workout'),
    durationMinutes: Number((day as any).durationMinutes ?? (day as any).duration ?? 60),
    dateISO: opts.dateISO || new Date().toISOString().slice(0, 10),
    status: opts.status,
    exercises,
    syncedAtMs: Date.now(),
  };
}

export function buildWatchPalette(themeName: AppThemeName | undefined): WatchPalette {
  const t = getTheme(themeName).colors;
  const fallback = { success: '#59D98E', warning: '#FFB454', error: '#FF5D73' };
  return {
    background:    String(t.background),
    surface:       String(t.surface),
    surfaceRaised: String((t as any).surfaceRaised ?? t.surface),
    primary:       String(t.primary),
    textPrimary:   String(t.textPrimary),
    textSecondary: String((t as any).textSecondary ?? t.textMuted ?? '#A8B3C7'),
    textMuted:     String((t as any).textMuted ?? '#687388'),
    success:       String((t as any).success ?? fallback.success),
    warning:       String((t as any).warning ?? fallback.warning),
    error:         String((t as any).error ?? fallback.error),
  };
}

/** Push today's workout with its current lifecycle status. */
export async function pushWorkoutToWatch(
  day: WorkoutDay | null,
  opts: { dateISO?: string; status: WatchWorkoutStatus },
): Promise<boolean> {
  const payload = buildWatchWorkoutPayload(day, opts);
  if (!payload) return false;
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;
  return WatchBridge.syncWorkout(payload);
}

export async function pushThemeToWatch(themeName: AppThemeName | undefined) {
  const palette = buildWatchPalette(themeName);
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;
  return WatchBridge.syncTheme(palette);
}

export async function pushProgressToWatch(progress: WatchProgress) {
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;
  return WatchBridge.updateProgress(progress);
}

/** Push today's meals (targets + actual + per-meal check state). */
export async function pushMealsToWatch(
  plan: DailyNutritionPlan | null | undefined,
  checkedMeals: Record<string, boolean> | null | undefined,
  dateISO?: string,
): Promise<boolean> {
  if (!plan) return false;
  if (!WatchBridge.isAvailable() || !WatchBridge.isPaired()) return false;

  const targets = plan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const mealArr = plan.meals ?? [];
  const checks = checkedMeals ?? {};

  // Actual = sum of checked meals' macros. Matches the phone's
  // NutritionCard calculation so numbers stay aligned.
  let actCal = 0, actPro = 0, actCarb = 0, actFat = 0;
  const items = mealArr.map((m: any, i: number) => {
    const mealType = `meal_${i}`;
    const checked = !!checks[mealType];
    if (checked) {
      actCal  += Number(m.calories ?? 0);
      actPro  += Number(m.protein  ?? 0);
      actCarb += Number(m.carbs    ?? 0);
      actFat  += Number(m.fat      ?? 0);
    }
    return {
      mealType,
      name: String(m.meal || m.name || `Meal ${i + 1}`),
      calories: Math.round(Number(m.calories ?? 0)),
      proteinG: Math.round(Number(m.protein  ?? 0)),
      carbsG:   Math.round(Number(m.carbs    ?? 0)),
      fatG:     Math.round(Number(m.fat      ?? 0)),
      checked,
    };
  });

  const payload: WatchMealsPayload = {
    dateISO: dateISO || new Date().toISOString().slice(0, 10),
    targets: {
      calories: Math.round(Number(targets.calories ?? 0)),
      proteinG: Math.round(Number(targets.protein  ?? 0)),
      carbsG:   Math.round(Number(targets.carbs    ?? 0)),
      fatG:     Math.round(Number(targets.fat      ?? 0)),
    },
    actual: {
      calories: Math.round(actCal),
      proteinG: Math.round(actPro),
      carbsG:   Math.round(actCarb),
      fatG:     Math.round(actFat),
    },
    meals: items,
    syncedAtMs: Date.now(),
  };
  return WatchBridge.syncMeals(payload);
}

/** Subscribe to commands the user taps on the watch. Returns an
 *  unsubscribe function. */
export function onWatchCommand(
  cb: (command: string, payload: Record<string, any>) => void,
): () => void {
  if (!WatchBridge.isAvailable()) return () => {};
  return WatchBridge.addCommandListener(cb);
}
