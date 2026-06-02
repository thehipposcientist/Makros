import type { DailyNutritionPlan } from '../types';
import { ensureMealClientKeys, mealCheckKey, normalizeMealChecksForPlan } from './mealPlanState.ts';
import { macroTotalsFromMeal } from './mealItems.ts';

export type WatchMealDisplayTargets = Partial<{
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}>;

export type WatchMealsPayloadShape = {
  dateISO: string;
  targets: { calories: number; proteinG: number; carbsG: number; fatG: number };
  actual: { calories: number; proteinG: number; carbsG: number; fatG: number };
  score: number | null;
  meals: Array<{
    mealType: string;
    name: string;
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    checked: boolean;
  }>;
  syncedAtMs: number;
};

function finiteNumberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickMacroTarget(preferred: unknown, fallback: unknown): number {
  return finiteNumberOrNull(preferred) ?? finiteNumberOrNull(fallback) ?? 0;
}

export function buildWatchMealsPayload(
  plan: DailyNutritionPlan,
  checkedMeals: Record<string, boolean> | null | undefined,
  dateISO: string,
  score: number | null | undefined,
  opts: { displayTargets?: WatchMealDisplayTargets | null; syncedAtMs?: number } = {},
): WatchMealsPayloadShape {
  const keyedPlan = ensureMealClientKeys(plan);
  const planTargets = keyedPlan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const displayTargets = opts.displayTargets ?? {};
  const mealArr = keyedPlan.meals ?? [];
  const checks = normalizeMealChecksForPlan(keyedPlan, checkedMeals ?? {});

  let actCal = 0;
  let actPro = 0;
  let actCarb = 0;
  let actFat = 0;
  const items = mealArr.map((m: any, i: number) => {
    const checkKey = mealCheckKey(keyedPlan, m, i);
    const checked = !!checks[checkKey];
    const macros = macroTotalsFromMeal(m);
    if (checked) {
      actCal += macros.calories;
      actPro += macros.protein;
      actCarb += macros.carbs;
      actFat += macros.fat;
    }
    return {
      mealType: checkKey,
      name: String(m.meal || m.name || `Meal ${i + 1}`),
      calories: macros.calories,
      proteinG: macros.protein,
      carbsG: macros.carbs,
      fatG: macros.fat,
      checked,
    };
  });

  return {
    dateISO,
    targets: {
      calories: Math.round(pickMacroTarget(displayTargets.calories, planTargets.calories)),
      proteinG: Math.round(pickMacroTarget(displayTargets.protein, planTargets.protein)),
      carbsG: Math.round(pickMacroTarget(displayTargets.carbs, planTargets.carbs)),
      fatG: Math.round(pickMacroTarget(displayTargets.fat, planTargets.fat)),
    },
    actual: {
      calories: Math.round(actCal),
      proteinG: Math.round(actPro),
      carbsG: Math.round(actCarb),
      fatG: Math.round(actFat),
    },
    score: score ?? null,
    meals: items,
    syncedAtMs: opts.syncedAtMs ?? Date.now(),
  };
}
