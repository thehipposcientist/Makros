import type { DailyNutritionPlan, MealSuggestion } from '../types';

type PlanMap = Record<string, DailyNutritionPlan>;
type ChecksMap = Record<string, Record<string, boolean>>;

type HistoryItemLike = {
  food_name?: string | null;
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  calories?: number | null;
  protein_g?: number | null;
  protein?: number | null;
  carbs_g?: number | null;
  carbs?: number | null;
  fat_g?: number | null;
  fat?: number | null;
};

export type MealHistoryEntryLike = {
  id?: number | null;
  meal_date?: string | null;
  meal_type?: string | null;
  name?: string | null;
  source?: string | null;
  items?: HistoryItemLike[] | null;
  totals?: {
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
  } | null;
};

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

function normalizeMealText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundedNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function itemSignature(items: Array<Record<string, any>> | null | undefined): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .map((item) => {
      const name = normalizeMealText(item.food_name ?? item.name);
      if (!name) return '';
      return [
        name,
        roundedNumber(item.quantity),
        normalizeMealText(item.unit),
        roundedNumber(item.calories),
        roundedNumber(item.protein_g ?? item.protein),
        roundedNumber(item.carbs_g ?? item.carbs),
        roundedNumber(item.fat_g ?? item.fat),
      ].join(':');
    })
    .filter(Boolean)
    .sort()
    .join('|');
}

function mealItems(meal: MealSuggestion): Array<Record<string, any>> {
  if (Array.isArray((meal as any).items) && (meal as any).items.length > 0) {
    return (meal as any).items;
  }
  return (meal.foods ?? []).map((food, i) => ({
    name: food,
    quantity: 1,
    unit: meal.amounts?.[i] ?? 'serving',
  }));
}

function mealCalories(meal: MealSuggestion): number {
  return roundedNumber(meal.calories);
}

function historyCalories(entry: MealHistoryEntryLike): number {
  const total = entry.totals?.calories;
  if (total != null) return roundedNumber(total);
  return roundedNumber((entry.items ?? []).reduce((sum, item) => sum + Number(item.calories ?? 0), 0));
}

function mealTypeIndex(mealType: string | null | undefined): number | null {
  switch ((mealType ?? '').toLowerCase()) {
    case 'breakfast': return 0;
    case 'lunch': return 1;
    case 'dinner': return 2;
    case 'snack': return 3;
    default: return null;
  }
}

export function inferMealCheckKeyFromHistoryEntry(
  entry: MealHistoryEntryLike,
  plan: DailyNutritionPlan | null | undefined,
  usedKeys: Set<string> = new Set(),
): string | null {
  const meals = plan?.meals ?? [];
  if (meals.length === 0) return null;

  const removed = new Set(plan?.removedMealIds ?? []);
  const available = meals
    .map((meal, index) => ({ meal, index, key: `meal_${index}` }))
    .filter(candidate => !removed.has(candidate.key) && !usedKeys.has(candidate.key));
  if (available.length === 0) return null;

  const historyId = Number(entry.id ?? 0);
  if (historyId > 0) {
    const byId = available.find(({ meal }) => Number((meal as any)._loggedMealId ?? 0) === historyId);
    if (byId) return byId.key;
  }

  const entryItemSig = itemSignature(entry.items as Array<Record<string, any>> | null | undefined);
  if (entryItemSig) {
    const byItems = available.find(({ meal }) => itemSignature(mealItems(meal)) === entryItemSig);
    if (byItems) return byItems.key;
  }

  const entryName = normalizeMealText(entry.name);
  const entryCal = historyCalories(entry);
  if (entryName) {
    const byNameAndCalories = available.find(({ meal }) => (
      normalizeMealText((meal as any).meal ?? (meal as any).name) === entryName
      && Math.abs(mealCalories(meal) - entryCal) <= 10
    ));
    if (byNameAndCalories) return byNameAndCalories.key;
  }

  if ((entry.source ?? '').toLowerCase() === 'generated') {
    const idx = mealTypeIndex(entry.meal_type);
    if (idx != null) {
      const byType = available.find(candidate => candidate.index === idx);
      if (byType) return byType.key;
    }
  }

  return null;
}

export function inferMealChecksFromHistory(
  history: MealHistoryEntryLike[],
  plansByDate: PlanMap,
  opts: { maxDate?: string } = {},
): ChecksMap {
  const checksByDate: ChecksMap = {};
  const usedByDate = new Map<string, Set<string>>();

  for (const entry of history) {
    const date = entry.meal_date ?? '';
    if (!date || (opts.maxDate && date > opts.maxDate)) continue;
    const plan = plansByDate[date];
    if (!plan) continue;

    const usedKeys = usedByDate.get(date) ?? new Set<string>();
    const key = inferMealCheckKeyFromHistoryEntry(entry, plan, usedKeys);
    if (!key) continue;

    usedKeys.add(key);
    usedByDate.set(date, usedKeys);
    checksByDate[date] = { ...(checksByDate[date] ?? {}), [key]: true };
  }

  return checksByDate;
}

export function mergeMealHistoryIntoChecksByDate(
  checksByDate: ChecksMap,
  plansByDate: PlanMap,
  history: MealHistoryEntryLike[],
  opts: { maxDate?: string } = {},
): { checksByDate: ChecksMap; changedDates: string[] } {
  const inferred = inferMealChecksFromHistory(history, plansByDate, opts);
  let next = checksByDate;
  const changedDates: string[] = [];

  for (const [date, checks] of Object.entries(inferred)) {
    const current = next[date] ?? {};
    let dateChecks = current;
    let changed = false;
    for (const [key, checked] of Object.entries(checks)) {
      if (checked && current[key] !== true) {
        if (!changed) dateChecks = { ...current };
        dateChecks[key] = true;
        changed = true;
      }
    }
    if (changed) {
      if (next === checksByDate) next = { ...checksByDate };
      next[date] = dateChecks;
      changedDates.push(date);
    }
  }

  return { checksByDate: next, changedDates };
}
