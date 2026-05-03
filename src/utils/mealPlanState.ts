import type { DailyNutritionPlan, MealSuggestion } from '../types';

type PlanMap = Record<string, DailyNutritionPlan>;
type ChecksMap = Record<string, Record<string, boolean>>;

export interface MealPlanSaveResult {
  plansByDate: PlanMap;
  plan: DailyNutritionPlan | null;
  meal: MealSuggestion;
  mealType: string;
  mealIndex: number;
}

export function upsertMealInPlansByDate(
  plansByDate: PlanMap,
  date: string,
  mealType: string,
  meal: MealSuggestion,
  opts: {
    fallbackPlan?: DailyNutritionPlan | null;
    makeLocalId?: () => string;
  } = {},
): MealPlanSaveResult {
  const current = plansByDate[date] ?? opts.fallbackPlan ?? null;
  if (!current) {
    return { plansByDate, plan: null, meal, mealType, mealIndex: -1 };
  }

  const isNewMeal = mealType === 'new_meal' || mealType === 'new_extra';
  const savedMeal = isNewMeal && !(meal as any)._localId && opts.makeLocalId
    ? { ...meal, _localId: opts.makeLocalId() } as MealSuggestion
    : meal;
  const meals = [...(current.meals ?? [])];
  let mealIndex = -1;
  let savedMealType = mealType;

  if (isNewMeal) {
    meals.push(savedMeal);
    mealIndex = meals.length - 1;
    savedMealType = `meal_${mealIndex}`;
  } else if (mealType.startsWith('meal_')) {
    const idx = parseInt(mealType.slice(5), 10);
    if (idx >= 0 && idx < meals.length) {
      meals[idx] = savedMeal;
      mealIndex = idx;
    } else {
      meals.push(savedMeal);
      mealIndex = meals.length - 1;
      savedMealType = `meal_${mealIndex}`;
    }
  }

  const plan = { ...current, meals };
  return {
    plansByDate: { ...plansByDate, [date]: plan },
    plan,
    meal: savedMeal,
    mealType: savedMealType,
    mealIndex,
  };
}

export function setMealCheckedInChecksByDate(
  checksByDate: ChecksMap,
  date: string,
  mealType: string,
  checked = true,
): { checksByDate: ChecksMap; dateChecks: Record<string, boolean> } {
  const dateChecks = { ...(checksByDate[date] ?? {}), [mealType]: checked };
  return {
    checksByDate: { ...checksByDate, [date]: dateChecks },
    dateChecks,
  };
}
